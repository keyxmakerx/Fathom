//! **Device reading: who may read, and which addresses a read may reach** (ADR-0082 §4.3 and
//! §4.4). The read itself happens in the reader helper (`helpers/reader/`), never in this server.
//!
//! # Off twice by default
//!
//! 1. The server operator allows reading with `FATHOM_DEVICE_READ=on` and names the reader's Unix
//!    socket with `FATHOM_DEVICE_READER` ([`reader_from`]). Without that no organisation can turn
//!    reading on, and nothing is ever sent to a reader. That keeps invariant 1: no connection the
//!    operator did not configure.
//! 2. A Steward turns reading on for their organisation and lists the management ranges a read may
//!    go to ([`set`], migration `0067`). Every change is sealed on the organisation chain as
//!    `device_read_set`.
//!
//! # Which addresses
//!
//! A read goes only to a device's management address, and only when that address is inside a
//! range a Steward listed ([`Settings::range_for`]). Loopback, link-local, multicast, unspecified
//! and reserved addresses are refused whatever is listed ([`refused`]), and a range that overlaps
//! them cannot be listed at all. A range is at most a /8 (IPv4) or a /32 (IPv6), so "everything"
//! cannot be typed as one entry. The reader checks the same rules again before it connects
//! (ADR-0089's remote readers will carry their own list), so this server is not the only lock.
//!
//! The server's own addresses are refused by where the reader runs: in its own container on a
//! network of its own, with no route to the server's (`compose.yaml`, the `reader` profile).
//!
//! # The reader's socket
//!
//! [`Transport`] is the one seam to the reader: a JSON object in, a JSON object out. Today it is
//! [`SocketTransport`], four bytes of length then the JSON over a Unix socket, the framing the
//! Passbolt helper uses. A remote reader that calls home later is another `Transport`, and the
//! job and answer shapes do not change.

use std::collections::BTreeMap;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::pin::Pin;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::chain::EntryType;
use crate::chains;
use crate::grants::{self, Authority, AuthorityError, StewardCheck};
use crate::invitations::InviteError;

/// `FATHOM_DEVICE_READER`'s default: the socket the compose `reader` profile shares.
pub const DEFAULT_READER_SOCKET: &str = "/run/fathom-reader/reader.sock";

/// The most ranges one organisation may list.
pub const MAX_RANGES: usize = 64;

/// The version of the job and answer shapes sent to a reader.
pub const PROTOCOL: i64 = 1;

/// `FATHOM_DEVICE_READ` and `FATHOM_DEVICE_READER` read together: `Some(socket)` only when
/// reading is `on`. Unset, empty or `off` reads as off; any other value is refused, so a typo
/// never reads as on.
pub fn reader_from(
    read: Option<&str>,
    socket: Option<&str>,
) -> Result<Option<PathBuf>, &'static str> {
    match read.map(str::trim).unwrap_or("") {
        "" | "off" => Ok(None),
        "on" => {
            let socket = socket.map(str::trim).filter(|s| !s.is_empty());
            match socket {
                None => Ok(Some(PathBuf::from(DEFAULT_READER_SOCKET))),
                Some(s) if s.starts_with('/') && !s.contains('\0') => Ok(Some(PathBuf::from(s))),
                Some(_) => Err("FATHOM_DEVICE_READER"),
            }
        }
        _ => Err("FATHOM_DEVICE_READ"),
    }
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/// Why an address may never be read, whatever a Steward listed, or `None`.
///
/// The blocks are from IANA's special-purpose address registries (IPv4 and IPv6, both last
/// updated 2025-10-09, read 2026-11-02): "this network" 0.0.0.0/8 (RFC 791), loopback 127.0.0.0/8
/// (RFC 1122), link-local 169.254.0.0/16 (RFC 3927), reserved 240.0.0.0/4 (RFC 1112, which takes
/// in limited broadcast); multicast 224.0.0.0/4 (RFC 5771); and for IPv6 the unspecified ::/128,
/// loopback ::1/128, link-local fe80::/10, multicast ff00::/8 (all RFC 4291), with IPv4-mapped
/// ::ffff:0:0/96 judged as the IPv4 address it carries. Private-use space is allowed: it is where
/// management networks live.
pub fn refused(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => refused_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return refused_v4(v4);
            }
            let first = v6.segments()[0];
            if v6.is_unspecified() {
                Some("the unspecified address")
            } else if v6.is_loopback() {
                Some("a loopback address, this machine itself")
            } else if first & 0xffc0 == 0xfe80 {
                Some("a link-local address")
            } else if first & 0xff00 == 0xff00 {
                Some("a multicast address")
            } else {
                None
            }
        }
    }
}

fn refused_v4(ip: Ipv4Addr) -> Option<&'static str> {
    let o = ip.octets();
    if o[0] == 0 {
        Some("an address in 0.0.0.0/8, which names no device")
    } else if o[0] == 127 {
        Some("a loopback address, this machine itself")
    } else if o[0] == 169 && o[1] == 254 {
        Some("a link-local address")
    } else if (224..=239).contains(&o[0]) {
        Some("a multicast address")
    } else if o[0] >= 240 {
        Some("a reserved or broadcast address")
    } else {
        None
    }
}

/// The blocks [`refused`] covers, so a range that overlaps one is refused when it is listed.
const REFUSED_V4: [(Ipv4Addr, u8); 5] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(224, 0, 0, 0), 4),
    (Ipv4Addr::new(240, 0, 0, 0), 4),
];
const REFUSED_V6: [(Ipv6Addr, u8); 5] = [
    (Ipv6Addr::UNSPECIFIED, 128),
    (Ipv6Addr::LOCALHOST, 128),
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),
    // IPv4-mapped: the same addresses as IPv4, written another way.
    (Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0, 0), 96),
];

fn bits(ip: IpAddr) -> u128 {
    match ip {
        IpAddr::V4(v4) => u32::from(v4) as u128,
        IpAddr::V6(v6) => u128::from(v6),
    }
}

fn width(ip: IpAddr) -> u8 {
    if ip.is_ipv4() {
        32
    } else {
        128
    }
}

fn mask(prefix: u8, width: u8) -> u128 {
    if prefix == 0 {
        0
    } else {
        let all = if width == 32 {
            u32::MAX as u128
        } else {
            u128::MAX
        };
        all & !((1u128 << (width - prefix)) - 1)
    }
}

/// One management range a Steward listed, and the ports a read uses inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Range {
    pub network: IpAddr,
    pub prefix: u8,
    pub snmp_port: u16,
    pub ssh_port: u16,
    /// The vault login a Steward set for reading inside this range (r90, logins by range): its
    /// entry id, never the login itself. A device in the range is read with it without each
    /// device being marked on the login. `None` leaves each device to its own logins.
    pub login: Option<String>,
}

impl Range {
    /// `10.20.0.0/24` or `2001:db8:10::/48`, with ports (161 and 22 unless given). The host part
    /// must be zero, so what is shown is exactly what is matched.
    pub fn parse(
        cidr: &str,
        snmp_port: Option<u16>,
        ssh_port: Option<u16>,
    ) -> Result<Self, &'static str> {
        let (addr, prefix) = cidr
            .trim()
            .split_once('/')
            .ok_or("a range is an address and a prefix length, such as 10.20.0.0/24")?;
        let network: IpAddr = addr
            .parse()
            .map_err(|_| "a range starts with an IPv4 or IPv6 address")?;
        if prefix.is_empty() || prefix.len() > 3 || !prefix.bytes().all(|b| b.is_ascii_digit()) {
            return Err("a range's prefix length is a number, such as /24");
        }
        let prefix: u8 = prefix
            .parse()
            .map_err(|_| "a range's prefix length is a number, such as /24")?;
        let w = width(network);
        if prefix > w {
            return Err("that prefix length is longer than the address");
        }
        let smallest = if w == 32 { 8 } else { 32 };
        if prefix < smallest {
            return Err("a range is at most a /8 for IPv4 or a /32 for IPv6");
        }
        if bits(network) & !mask(prefix, w) != 0 {
            return Err(
                "the address of a range must have its host part zero, such as 10.20.0.0/24",
            );
        }
        if let IpAddr::V6(v6) = network {
            if v6.to_ipv4_mapped().is_some() && prefix >= 96 {
                return Err("write an IPv4 range as IPv4, such as 10.20.0.0/24");
            }
        }
        let range = Self {
            network,
            prefix,
            snmp_port: snmp_port.unwrap_or(161),
            ssh_port: ssh_port.unwrap_or(22),
            login: None,
        };
        if range.snmp_port == 0 || range.ssh_port == 0 {
            return Err("a port is 1 to 65535");
        }
        if range.overlaps_refused() {
            return Err("that range covers loopback, link-local, multicast or reserved addresses, which are never read");
        }
        Ok(range)
    }

    fn overlaps(&self, net: IpAddr, prefix: u8) -> bool {
        if net.is_ipv4() != self.network.is_ipv4() {
            return false;
        }
        let w = width(net);
        let shorter = prefix.min(self.prefix);
        let m = mask(shorter, w);
        bits(net) & m == bits(self.network) & m
    }

    fn overlaps_refused(&self) -> bool {
        REFUSED_V4
            .iter()
            .any(|(n, p)| self.overlaps(IpAddr::V4(*n), *p))
            || REFUSED_V6
                .iter()
                .any(|(n, p)| self.overlaps(IpAddr::V6(*n), *p))
    }

    /// Whether `ip` is inside this range.
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = match ip {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
            v4 => v4,
        };
        ip.is_ipv4() == self.network.is_ipv4()
            && bits(ip) & mask(self.prefix, width(ip)) == bits(self.network)
    }

    /// `10.20.0.0/24`.
    pub fn cidr(&self) -> String {
        format!("{}/{}", self.network, self.prefix)
    }

    /// `login` is written only when set, so a list saved before it existed keeps its bytes.
    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::from([
            ("cidr".to_string(), Json::Str(self.cidr())),
            ("snmpPort".to_string(), Json::Int(self.snmp_port as i64)),
            ("sshPort".to_string(), Json::Int(self.ssh_port as i64)),
        ]);
        if let Some(l) = &self.login {
            m.insert("login".to_string(), Json::Str(l.clone()));
        }
        Json::Obj(m)
    }

    /// `{cidr, snmpPort?, sshPort?, login?}`; unknown fields are refused.
    pub fn from_json(j: &Json) -> Result<Self, &'static str> {
        let Json::Obj(m) = j else {
            return Err("each range is {cidr, snmpPort, sshPort, login}");
        };
        if m.keys()
            .any(|k| !matches!(k.as_str(), "cidr" | "snmpPort" | "sshPort" | "login"))
        {
            return Err("each range is {cidr, snmpPort, sshPort, login}");
        }
        let Some(Json::Str(cidr)) = m.get("cidr") else {
            return Err("each range has a cidr, such as 10.20.0.0/24");
        };
        let port = |k: &str| -> Result<Option<u16>, &'static str> {
            match m.get(k) {
                None | Some(Json::Null) => Ok(None),
                Some(Json::Int(n)) => u16::try_from(*n)
                    .ok()
                    .filter(|p| *p > 0)
                    .map(Some)
                    .ok_or("a port is 1 to 65535"),
                Some(_) => Err("a port is 1 to 65535"),
            }
        };
        let login = match m.get("login") {
            None | Some(Json::Null) => None,
            Some(Json::Str(l))
                if fathom_id::Ulid::decode(l).map(|u| u.to_string()).as_deref() == Ok(l) =>
            {
                Some(l.clone())
            }
            Some(_) => return Err("a range's login is a vault login's id"),
        };
        let mut range = Self::parse(cidr, port("snmpPort")?, port("sshPort")?)?;
        range.login = login;
        Ok(range)
    }
}

/// A Steward's list, checked: at most [`MAX_RANGES`], no range listed twice.
pub fn ranges_from_json(j: &Json) -> Result<Vec<Range>, &'static str> {
    let Json::Arr(items) = j else {
        return Err("ranges is a list");
    };
    if items.len() > MAX_RANGES {
        return Err("at most 64 ranges");
    }
    let mut out: Vec<Range> = Vec::with_capacity(items.len());
    for item in items {
        let r = Range::from_json(item)?;
        if out
            .iter()
            .any(|o| o.network == r.network && o.prefix == r.prefix)
        {
            return Err("a range is listed twice");
        }
        out.push(r);
    }
    Ok(out)
}

fn ranges_to_json(ranges: &[Range]) -> Json {
    Json::Arr(ranges.iter().map(Range::to_json).collect())
}

// ---------------------------------------------------------------------------
// An organisation's settings
// ---------------------------------------------------------------------------

/// What a Steward set for one organisation. No row reads as off with no ranges.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Settings {
    pub on: bool,
    pub ranges: Vec<Range>,
    pub set_by: Option<String>,
    pub set_at_ms: Option<i64>,
}

impl Settings {
    /// The range a read of `address` would use, or why it may not be read.
    pub fn range_for(&self, address: IpAddr) -> Result<&Range, &'static str> {
        if let Some(why) = refused(address) {
            return Err(why);
        }
        self.ranges
            .iter()
            .filter(|r| r.contains(address))
            .max_by_key(|r| r.prefix)
            .ok_or("that address is outside every management range a Steward listed")
    }
}

/// The caller has opened a tenant context for `organisation`.
pub async fn load(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<Settings, tokio_postgres::Error> {
    let Some(row) = tx
        .query_opt(
            "SELECT reading_on, ranges, set_by, (extract(epoch from set_at) * 1000)::bigint \
               FROM organisation_device_read WHERE organisation_id = $1",
            &[&organisation],
        )
        .await?
    else {
        return Ok(Settings::default());
    };
    let text: String = row.get(1);
    // Written only by `set`, and checked again here: a list edited in PostgreSQL that no longer
    // passes reads as no ranges, so nothing can be reached through it.
    let ranges = Json::parse_canonical(text.as_bytes())
        .ok()
        .and_then(|j| ranges_from_json(&j).ok())
        .unwrap_or_else(|| {
            tracing::error!(
                organisation,
                "device-reading ranges did not pass their checks; none used"
            );
            Vec::new()
        });
    Ok(Settings {
        on: row.get(0),
        ranges,
        set_by: Some(row.get(2)),
        set_at_ms: Some(row.get(3)),
    })
}

/// What the Steward page and the device panel show. `server` is whether this server allows
/// reading at all; `reader` whether its reader answered just now.
pub fn view(settings: &Settings, server: bool, reader: bool) -> Json {
    let opt = |v: &Option<String>| v.as_ref().map_or(Json::Null, |s| Json::Str(s.clone()));
    Json::Obj(BTreeMap::from([
        ("server".to_string(), Json::Bool(server)),
        ("reader".to_string(), Json::Bool(reader)),
        ("on".to_string(), Json::Bool(settings.on)),
        (
            "usable".to_string(),
            Json::Bool(server && reader && settings.on && !settings.ranges.is_empty()),
        ),
        ("ranges".to_string(), ranges_to_json(&settings.ranges)),
        ("setBy".to_string(), opt(&settings.set_by)),
        (
            "setAt".to_string(),
            settings.set_at_ms.map_or(Json::Null, Json::Int),
        ),
    ]))
}

/// A Steward turns reading on or off for the organisation and sets its ranges, together
/// (`ranges` `None` keeps the list as it is).
/// Turning it on needs `server_allows` (the operator's `FATHOM_DEVICE_READ=on`); turning it off
/// never does. Answers `{"changed", "changed_seq"}`; setting what is already set seals nothing.
pub async fn set(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    on: bool,
    ranges: Option<Vec<Range>>,
    server_allows: bool,
) -> Result<Json, InviteError> {
    let organisation = auth.ctx.tenant().to_string();
    let actor = auth.ctx.actor().to_string();
    // A Steward, asked before any row is read.
    let verified = grants::verify_authority_state(tx, auth).await?;
    let mut check = StewardCheck::new();
    if grants::steward_anchors(tx, auth, &verified, &mut check)
        .await?
        .is_empty()
    {
        return Err(InviteError::Authority(AuthorityError::NotAuthorised));
    }
    if on && !server_allows {
        return Err(InviteError::NotOpen(
            "this server does not allow device reading; its operator turns it on with FATHOM_DEVICE_READ=on",
        ));
    }
    let current = tx
        .query_opt(
            "SELECT reading_on, ranges FROM organisation_device_read \
              WHERE organisation_id = $1 FOR UPDATE",
            &[&organisation],
        )
        .await?;
    let ranges = match ranges {
        Some(r) => r,
        None => load(tx, &organisation).await?.ranges,
    };
    let text = String::from_utf8(ranges_to_json(&ranges).to_canonical_bytes())
        .expect("canonical JSON is UTF-8");
    let mut answer = BTreeMap::new();
    let unchanged = match &current {
        Some(r) => r.get::<_, bool>(0) == on && r.get::<_, String>(1) == text,
        None => !on && ranges.is_empty(),
    };
    if unchanged {
        answer.insert("changed".to_string(), Json::Bool(false));
        answer.insert("changed_seq".to_string(), Json::Null);
        return Ok(Json::Obj(answer));
    }
    let meta = Json::Obj(BTreeMap::from([
        ("actor".to_string(), Json::Str(actor.clone())),
        (
            "entry_type".to_string(),
            Json::Str(EntryType::DeviceReadSet.as_str().to_string()),
        ),
        ("on".to_string(), Json::Bool(on)),
        ("organisation".to_string(), Json::Str(organisation.clone())),
        ("ranges".to_string(), ranges_to_json(&ranges)),
    ]));
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::DeviceReadSet,
        &meta.to_canonical_bytes(),
    )
    .await?;
    tx.execute(
        "INSERT INTO organisation_device_read (organisation_id, reading_on, ranges, set_by) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (organisation_id) DO UPDATE \
         SET reading_on = EXCLUDED.reading_on, ranges = EXCLUDED.ranges, \
             set_by = EXCLUDED.set_by, set_at = now()",
        &[&organisation, &on, &text, &actor],
    )
    .await?;
    answer.insert("changed".to_string(), Json::Bool(true));
    answer.insert("changed_seq".to_string(), Json::Int(appended.seq));
    Ok(Json::Obj(answer))
}

// ---------------------------------------------------------------------------
// The seam to the reader
// ---------------------------------------------------------------------------

pub type ReaderFuture<'a> = Pin<Box<dyn Future<Output = Result<Json, String>> + Send + 'a>>;

/// One request to a reader: a JSON object in, a JSON object out (`helpers/reader/README.md`).
pub trait Transport: Send + Sync {
    fn call(&self, request: Json) -> ReaderFuture<'_>;
}

/// The local reader over its Unix socket: four bytes of length, big-endian, then the JSON; one
/// request per connection.
pub struct SocketTransport {
    pub path: PathBuf,
}

/// The longest message either way.
const MAX_FRAME: usize = 1024 * 1024;

impl Transport for SocketTransport {
    fn call(&self, request: Json) -> ReaderFuture<'_> {
        Box::pin(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let lost = |_| "the device reader did not answer".to_string();
            let body = request.to_canonical_bytes();
            let len = u32::try_from(body.len())
                .ok()
                .filter(|l| (*l as usize) <= MAX_FRAME)
                .ok_or_else(|| "a request to the device reader is too long".to_string())?;
            let round = async {
                let mut s = tokio::net::UnixStream::connect(&self.path)
                    .await
                    .map_err(lost)?;
                s.write_all(&len.to_be_bytes()).await.map_err(lost)?;
                s.write_all(&body).await.map_err(lost)?;
                let mut n = [0u8; 4];
                s.read_exact(&mut n).await.map_err(lost)?;
                let n = u32::from_be_bytes(n) as usize;
                if n > MAX_FRAME {
                    return Err("the device reader answered too much".to_string());
                }
                let mut buf = vec![0u8; n];
                s.read_exact(&mut buf).await.map_err(lost)?;
                Ok(buf)
            };
            let buf = tokio::time::timeout(std::time::Duration::from_secs(60), round)
                .await
                .map_err(|_| "the device reader took too long".to_string())??;
            crate::foreign_json::parse(&buf)
                .map_err(|_| "the device reader's answer was not JSON".to_string())
        })
    }
}

/// Whether the reader answers `ping` with this protocol version.
pub async fn ping(transport: &dyn Transport) -> bool {
    let request = Json::Obj(BTreeMap::from([
        ("op".to_string(), Json::Str("ping".to_string())),
        ("protocol".to_string(), Json::Int(PROTOCOL)),
    ]));
    match tokio::time::timeout(std::time::Duration::from_secs(3), transport.call(request)).await {
        Ok(Ok(Json::Obj(m))) => {
            matches!(m.get("ok"), Some(Json::Bool(true)))
                && matches!(m.get("protocol"), Some(Json::Int(PROTOCOL)))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn the_operator_switch_reads_on_or_off_and_nothing_else() {
        assert_eq!(reader_from(None, None), Ok(None));
        assert_eq!(reader_from(Some(" "), Some("/x.sock")), Ok(None));
        assert_eq!(reader_from(Some("off"), None), Ok(None));
        assert_eq!(
            reader_from(Some("on"), None),
            Ok(Some(PathBuf::from(DEFAULT_READER_SOCKET)))
        );
        assert_eq!(
            reader_from(Some("on"), Some("/run/r/r.sock")),
            Ok(Some(PathBuf::from("/run/r/r.sock")))
        );
        for typo in ["yes", "true", "1", "On", "o n"] {
            assert_eq!(
                reader_from(Some(typo), None),
                Err("FATHOM_DEVICE_READ"),
                "{typo}"
            );
        }
        assert_eq!(
            reader_from(Some("on"), Some("relative.sock")),
            Err("FATHOM_DEVICE_READER")
        );
    }

    #[test]
    fn a_range_is_what_it_says() {
        let r = Range::parse("10.20.0.0/24", None, None).unwrap();
        assert_eq!((r.snmp_port, r.ssh_port), (161, 22));
        assert_eq!(r.cidr(), "10.20.0.0/24");
        assert!(r.contains(ip("10.20.0.1")));
        assert!(r.contains(ip("10.20.0.255")));
        assert!(r.contains(ip("::ffff:10.20.0.9")));
        assert!(!r.contains(ip("10.20.1.1")));
        assert!(!r.contains(ip("2001:db8::1")));
        let v6 = Range::parse("2001:db8:10::/48", Some(1161), Some(2222)).unwrap();
        assert!(v6.contains(ip("2001:db8:10:ffff::1")));
        assert!(!v6.contains(ip("2001:db8:11::1")));
        assert_eq!((v6.snmp_port, v6.ssh_port), (1161, 2222));
        let host = Range::parse("10.20.0.7/32", None, None).unwrap();
        assert!(host.contains(ip("10.20.0.7")));
        assert!(!host.contains(ip("10.20.0.8")));
    }

    #[test]
    fn ranges_that_could_reach_too_much_are_refused() {
        for bad in [
            "10.20.0.1/24",  // host part set
            "10.0.0.0/7",    // wider than /8
            "0.0.0.0/0",     // everything
            "::/0",          // everything, IPv6
            "2001:db8::/31", // wider than /32
            "127.0.0.0/8",   // loopback
            "127.0.0.1/32",
            "100.0.0.0/7",    // too wide anyway
            "169.254.0.0/16", // link-local
            "169.254.10.0/24",
            "224.0.0.0/8",         // multicast
            "240.0.0.0/8",         // reserved
            "fe80::/64",           // link-local
            "ff02::/16",           // multicast
            "::1/128",             // loopback
            "::ffff:10.0.0.0/104", // IPv4 written as IPv6
            "10.20.0.0",           // no prefix
            "10.20.0.0/",          // empty prefix
            "10.20.0.0/+24",
            "10.20.0.0/33",
            "host.example/24",
        ] {
            assert!(Range::parse(bad, None, None).is_err(), "{bad}");
        }
        assert!(Range::parse("10.0.0.0/8", None, None).is_ok());
        assert!(Range::parse("10.20.0.0/24", Some(0), None).is_err());
    }

    #[test]
    fn a_read_needs_a_listed_range_and_a_readable_address() {
        let settings = Settings {
            on: true,
            ranges: vec![
                Range::parse("10.0.0.0/8", None, None).unwrap(),
                Range::parse("10.20.0.0/24", Some(1161), None).unwrap(),
            ],
            ..Settings::default()
        };
        // The narrowest range wins, so its ports are the ones used.
        assert_eq!(settings.range_for(ip("10.20.0.5")).unwrap().snmp_port, 1161);
        assert_eq!(settings.range_for(ip("10.30.0.5")).unwrap().snmp_port, 161);
        assert!(settings.range_for(ip("192.168.1.1")).is_err());
        for never in [
            "127.0.0.1",
            "::1",
            "169.254.169.254",
            "0.0.0.0",
            "224.0.0.1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "255.255.255.255",
        ] {
            assert!(refused(ip(never)).is_some(), "{never}");
            assert!(settings.range_for(ip(never)).is_err(), "{never}");
        }
    }

    #[test]
    fn a_list_round_trips_and_refuses_duplicates_and_strays() {
        let j = crate::foreign_json::parse(
            br#"[{"cidr":"10.20.0.0/24","snmpPort":161,"sshPort":22},{"cidr":"2001:db8::/48"}]"#,
        )
        .unwrap();
        let list = ranges_from_json(&j).unwrap();
        assert_eq!(list.len(), 2);
        let again = ranges_from_json(&ranges_to_json(&list)).unwrap();
        assert_eq!(again, list);
        let dup = crate::foreign_json::parse(
            br#"[{"cidr":"10.20.0.0/24"},{"cidr":"10.20.0.0/24","sshPort":2222}]"#,
        )
        .unwrap();
        assert!(ranges_from_json(&dup).is_err());
        let stray = crate::foreign_json::parse(br#"[{"cidr":"10.20.0.0/24","note":"x"}]"#).unwrap();
        assert!(ranges_from_json(&stray).is_err());
        let port =
            crate::foreign_json::parse(br#"[{"cidr":"10.20.0.0/24","sshPort":70000}]"#).unwrap();
        assert!(ranges_from_json(&port).is_err());
    }
}
