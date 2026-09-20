//! Which address a request is from.
//!
//! On the wire a server behind a reverse proxy sees the proxy, every time;
//! the client's own address can only arrive in a header the proxy writes.
//! Three routes counted a client's address (sign-in limits, the redemption
//! routes, firmware fetches) with three copies of the same logic, and two
//! of the copies read the FIRST entry of that header, which is the entry a
//! client can write. This is the one copy now, and the rule it applies
//! (2026-09-20) is the standard one:
//!
//! - **`FATHOM_TRUSTED_PROXIES` set** (addresses or ranges, or the word
//!   `private` for every private, loopback and link-local range): the
//!   header is believed only when the connection itself comes from one of
//!   those addresses. Its entries are then read from the right, skipping
//!   every trusted proxy, and the first address that is not one is the
//!   client. A proxy that overwrites the header and a proxy that appends
//!   to it both come out right, and so does a chain of two trusted hops.
//!   From any other peer the header is ignored and the peer is the address,
//!   so a client that can reach the port directly gains nothing by forging
//!   it.
//! - **Header configured, no trusted proxies**: the header's last entry is
//!   believed from every peer. This is what every deployment had before
//!   this module, kept for the one that cannot name its proxy, and `main.rs`
//!   warns at startup that it is in force.
//! - **Neither**: the peer address.
//!
//! What this cannot do is read an address the proxy did not send. The
//! PROXY protocol, which carries the client's address inside the TCP
//! stream where an HTTP client cannot write it, would remove even the
//! header from the trust argument; it needs the listener to parse it and
//! the proxy to speak it, and is not built.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use axum::extract::ConnectInfo;
use axum::http::HeaderMap;

/// An address or a range: `10.0.0.5`, `10.0.0.0/8`, `::1`, `fd00::/8`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cidr {
    network: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// Parses one entry. A bare address is a range of one. Refuses a prefix
    /// longer than the family allows and anything that is not an address.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let (addr, prefix) = match text.split_once('/') {
            None => (text, None),
            Some((a, p)) => (a, Some(p)),
        };
        let addr: IpAddr = addr.parse().ok()?;
        let max = match addr {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        let prefix = match prefix {
            None => max,
            Some(p) => p.parse::<u8>().ok().filter(|p| *p <= max)?,
        };
        Some(Self {
            network: mask(addr, prefix),
            prefix,
        })
    }

    /// Is `ip` inside? An IPv4-mapped IPv6 address (`::ffff:10.0.0.5`, which
    /// a dual-stack listener reports for a v4 peer) is matched as the v4
    /// address it carries.
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = match ip {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) if matches!(self.network, IpAddr::V4(_)) => IpAddr::V4(v4),
                _ => IpAddr::V6(v6),
            },
            v4 => v4,
        };
        // A v4 address is never inside a v6 range or the other way round,
        // and masking across families would shift by more than the width.
        let same_family = matches!(
            (ip, self.network),
            (IpAddr::V4(_), IpAddr::V4(_)) | (IpAddr::V6(_), IpAddr::V6(_))
        );
        same_family && mask(ip, self.prefix) == self.network
    }
}

fn mask(addr: IpAddr, prefix: u8) -> IpAddr {
    match addr {
        IpAddr::V4(a) => {
            let bits = u32::from(a);
            let m = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - u32::from(prefix))
            };
            IpAddr::V4(Ipv4Addr::from(bits & m))
        }
        IpAddr::V6(a) => {
            let bits = u128::from(a);
            let m = if prefix == 0 {
                0
            } else {
                u128::MAX << (128 - u32::from(prefix))
            };
            IpAddr::V6(Ipv6Addr::from(bits & m))
        }
    }
}

/// What `FATHOM_TRUSTED_PROXIES=private` means: RFC 1918, loopback,
/// link-local, and their IPv6 counterparts. Right for a proxy on the same
/// machine or the same private network, which is where one usually is, and
/// too wide the day something else on that network can reach the port --
/// `docs/RUNNING-IT.md` says to name the proxy's own address instead.
pub const PRIVATE_RANGES: &[&str] = &[
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "fc00::/7",
    "fe80::/10",
    "::1/128",
];

/// Parses `FATHOM_TRUSTED_PROXIES`: comma-separated entries, each an address,
/// a range, or the word `private`. `Err` names the entry that did not parse.
pub fn parse_trusted_proxies(text: &str) -> Result<Vec<Cidr>, String> {
    let mut out = Vec::new();
    for entry in text.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        if entry.eq_ignore_ascii_case("private") {
            out.extend(
                PRIVATE_RANGES
                    .iter()
                    .map(|r| Cidr::parse(r).expect("a constant")),
            );
            continue;
        }
        match Cidr::parse(entry) {
            Some(c) => out.push(c),
            None => return Err(entry.to_string()),
        }
    }
    Ok(out)
}

/// The policy, built once in `main.rs` from the configuration and handed to
/// every state that counts an address.
#[derive(Clone, Debug, Default)]
pub struct ClientAddress {
    header: Option<String>,
    trusted_proxies: Vec<Cidr>,
}

impl ClientAddress {
    pub fn new(header: Option<String>, trusted_proxies: impl IntoIterator<Item = Cidr>) -> Self {
        Self {
            header: header
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty()),
            trusted_proxies: trusted_proxies.into_iter().collect(),
        }
    }

    /// The peer address, always.
    pub fn peer() -> Self {
        Self::default()
    }

    /// The header, believed from every peer (the pre-2026-09-20 rule).
    pub fn header(name: &str) -> Self {
        Self::new(Some(name.to_string()), [])
    }

    pub fn header_name(&self) -> Option<&str> {
        self.header.as_deref()
    }

    pub fn trusted_proxies(&self) -> &[Cidr] {
        &self.trusted_proxies
    }

    fn trusted(&self, ip: IpAddr) -> bool {
        self.trusted_proxies.iter().any(|c| c.contains(ip))
    }

    /// The address a request is from, as text: an address, or `unknown`
    /// when the listener gave no peer (a router driven in a test without
    /// connect info). Capped at 255 characters, because a header is a
    /// string a caller can write and this string is stored.
    pub fn of(&self, headers: &HeaderMap, extensions: &axum::http::Extensions) -> String {
        let peer = extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| addr.ip());
        let peer_text = || {
            peer.map(|ip| ip.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        };
        let Some(name) = &self.header else {
            return peer_text();
        };
        let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) else {
            return peer_text();
        };
        if self.trusted_proxies.is_empty() {
            let last = value.rsplit(',').next().unwrap_or("").trim();
            return if last.is_empty() {
                peer_text()
            } else {
                last.chars().take(255).collect()
            };
        }
        let Some(peer_ip) = peer else {
            return peer_text();
        };
        if !self.trusted(peer_ip) {
            return peer_text();
        }
        for entry in value.rsplit(',').map(str::trim).filter(|e| !e.is_empty()) {
            match entry.parse::<IpAddr>() {
                Ok(ip) if self.trusted(ip) => continue,
                _ => return entry.chars().take(255).collect(),
            }
        }
        peer_text()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{Extensions, HeaderValue};

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("ip")
    }

    fn from(peer: &str) -> Extensions {
        let mut e = Extensions::new();
        e.insert(ConnectInfo(SocketAddr::new(ip(peer), 4242)));
        e
    }

    fn xff(value: &'static str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", HeaderValue::from_static(value));
        h
    }

    fn policy(proxies: &[&str]) -> ClientAddress {
        ClientAddress::new(
            Some("x-forwarded-for".to_string()),
            proxies.iter().map(|p| Cidr::parse(p).expect("cidr")),
        )
    }

    #[test]
    fn a_bare_address_is_a_range_of_one() {
        let c = Cidr::parse("10.0.0.5").expect("parses");
        assert!(c.contains(ip("10.0.0.5")));
        assert!(!c.contains(ip("10.0.0.6")));
    }

    #[test]
    fn families_never_match_each_other() {
        assert!(!Cidr::parse("::1/128")
            .expect("parses")
            .contains(ip("127.0.0.1")));
        assert!(!Cidr::parse("10.0.0.0/8")
            .expect("parses")
            .contains(ip("::1")));
        assert!(!Cidr::parse("fc00::/7")
            .expect("parses")
            .contains(ip("::ffff:10.0.0.1")));
    }

    #[test]
    fn a_v4_range_contains_its_members_and_nothing_else() {
        let c = Cidr::parse("192.168.1.0/24").expect("parses");
        assert!(c.contains(ip("192.168.1.1")));
        assert!(c.contains(ip("192.168.1.254")));
        assert!(!c.contains(ip("192.168.2.1")));
        assert!(!c.contains(ip("::1")));
        assert!(
            c.contains(ip("::ffff:192.168.1.7")),
            "a mapped v4 peer is the v4 address"
        );
    }

    #[test]
    fn a_v6_range_and_a_zero_prefix() {
        let c = Cidr::parse("fd00::/8").expect("parses");
        assert!(c.contains(ip("fd12:3456::1")));
        assert!(!c.contains(ip("2001:db8::1")));
        assert!(Cidr::parse("0.0.0.0/0")
            .expect("parses")
            .contains(ip("203.0.113.9")));
    }

    #[test]
    fn nonsense_is_refused() {
        for bad in [
            "",
            "10.0.0.0/33",
            "::1/129",
            "example.com",
            "10.0.0/8",
            "10.0.0.0/x",
        ] {
            assert!(Cidr::parse(bad).is_none(), "{bad}");
        }
        assert_eq!(
            parse_trusted_proxies("10.0.0.0/8, nope").unwrap_err(),
            "nope"
        );
    }

    #[test]
    fn private_expands_to_the_private_ranges() {
        let list = parse_trusted_proxies("private, 203.0.113.7").expect("parses");
        assert_eq!(list.len(), PRIVATE_RANGES.len() + 1);
        let p = ClientAddress::new(Some("x-forwarded-for".to_string()), list);
        assert!(p.trusted(ip("172.31.0.1")));
        assert!(p.trusted(ip("::ffff:192.168.0.2")));
        assert!(p.trusted(ip("203.0.113.7")));
        assert!(!p.trusted(ip("203.0.113.8")));
    }

    #[test]
    fn no_header_configured_is_the_peer() {
        let p = ClientAddress::peer();
        assert_eq!(p.of(&xff("6.6.6.6"), &from("198.51.100.4")), "198.51.100.4");
        assert_eq!(p.of(&HeaderMap::new(), &Extensions::new()), "unknown");
    }

    #[test]
    fn the_legacy_rule_believes_the_last_entry_from_any_peer() {
        let p = ClientAddress::header("x-forwarded-for");
        assert_eq!(
            p.of(&xff("6.6.6.6, 10.0.0.9"), &Extensions::new()),
            "10.0.0.9"
        );
        assert_eq!(p.of(&xff("10.0.0.9"), &from("203.0.113.1")), "10.0.0.9");
        assert_eq!(p.of(&HeaderMap::new(), &from("203.0.113.1")), "203.0.113.1");
    }

    #[test]
    fn with_trusted_proxies_the_header_is_believed_only_from_them() {
        let p = policy(&["10.0.0.0/8"]);
        // The proxy overwrote the header: one entry, the client.
        assert_eq!(
            p.of(&xff("198.51.100.4"), &from("10.0.0.2")),
            "198.51.100.4"
        );
        // The proxy appended to a forged header: the rightmost untrusted wins.
        assert_eq!(
            p.of(&xff("6.6.6.6, 198.51.100.4"), &from("10.0.0.2")),
            "198.51.100.4"
        );
        // Two trusted hops: skip the inner proxy's own entry.
        assert_eq!(
            p.of(&xff("198.51.100.4, 10.0.0.3"), &from("10.0.0.2")),
            "198.51.100.4"
        );
        // Every entry is a proxy: the peer is the nearest honest fact.
        assert_eq!(p.of(&xff("10.0.0.3"), &from("10.0.0.2")), "10.0.0.2");
        // Not from a proxy: the header is ignored, forged or not.
        assert_eq!(p.of(&xff("6.6.6.6"), &from("203.0.113.1")), "203.0.113.1");
        // No peer known at all: nothing can be vouched for.
        assert_eq!(p.of(&xff("6.6.6.6"), &Extensions::new()), "unknown");
    }

    #[test]
    fn a_header_that_is_not_an_address_is_still_bounded() {
        let p = policy(&["127.0.0.1"]);
        let mut h = HeaderMap::new();
        let long = "x".repeat(600);
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_str(&long).expect("ascii"),
        );
        assert_eq!(p.of(&h, &from("127.0.0.1")).len(), 255);
    }
}
