//! Which address a request is from.
//!
//! On the wire a server behind a reverse proxy sees the proxy, every time;
//! the client's own address can only arrive in a header the proxy writes.
//! Three routes counted a client's address (sign-in limits, the redemption
//! routes, firmware fetches) with three copies of the same logic, and two
//! of the copies read the FIRST entry of that header, which is the entry a
//! client can write. This is the one copy now. The rule (2026-09-21):
//!
//! - **`FATHOM_TRUSTED_PROXIES` set** (addresses or ranges, or the word
//!   `private`): the header is believed only when the connection itself
//!   comes from one of them. The entries are then counted from the right,
//!   across every line of the header (RFC 9110 §5.3 makes the lines one
//!   list), and the client is the `FATHOM_FORWARDED_HOPS`-th one -- the
//!   last entry by default, which is the one the proxy itself appended; `2`
//!   when the proxy sits behind one more hop that appends (an edge, a CDN),
//!   and so on. Whatever a client wrote in front of that is never reached.
//!   From any other peer the header is ignored and the peer is the address,
//!   so a client that can reach the port directly gains nothing by forging
//!   it -- and a client that can reach the port directly FROM a trusted
//!   range is trusted, which is why the port is published only where the
//!   proxy reaches it (`docs/RUNNING-IT.md`).
//! - **Not set**: the peer address, which behind a proxy is the proxy: one
//!   rate-limit bucket for everyone, nothing forgeable. `main.rs` warns.
//!
//! Counting hops rather than skipping every entry that falls in a trusted
//! range is deliberate. The skipping rule (nginx's `real_ip_recursive`,
//! this module until 2026-09-21) cannot tell a proxy from a client that
//! sits in the same range, so with `private` and clients on the LAN or the
//! overlay every client collapsed onto the proxy's address, and a proxy that
//! appends left a forged public entry standing. A hop count has no such
//! ambiguity: the topology is stated once, in one number. Express's
//! `trust proxy` takes the same number for the same reason.
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

/// What `FATHOM_TRUSTED_PROXIES=private` means: RFC 1918, the RFC 6598
/// shared address space (`100.64.0.0/10`, which the NetBird and Tailscale
/// overlays number their peers from; NetBird's reverse-proxy documentation,
/// read 2026-09-20, says to trust that whole range because the proxy's own
/// address in it changes on restart), loopback, link-local, and their IPv6
/// counterparts. Right for a proxy on the same machine, the same private
/// network or the same overlay, which is where one usually is, and too wide
/// the day something else on that network can reach the port --
/// `docs/RUNNING-IT.md` says to name the proxy's own address instead.
pub const PRIVATE_RANGES: &[&str] = &[
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
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
#[derive(Clone, Debug)]
pub struct ClientAddress {
    header: Option<String>,
    trusted_proxies: Vec<Cidr>,
    /// Which entry from the right is the client: `1` is the last one.
    hops: usize,
}

impl Default for ClientAddress {
    fn default() -> Self {
        Self {
            header: None,
            trusted_proxies: Vec::new(),
            hops: 1,
        }
    }
}

impl ClientAddress {
    /// The header, believed from `trusted_proxies`, the last entry the
    /// client. A header with no proxies is the peer rule: `config.rs`
    /// refuses that combination, and here it is simply never believed.
    pub fn new(header: Option<String>, trusted_proxies: impl IntoIterator<Item = Cidr>) -> Self {
        Self {
            header: header
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty()),
            trusted_proxies: trusted_proxies.into_iter().collect(),
            hops: 1,
        }
    }

    /// The same, with the client `hops` entries from the right (`1` is the
    /// last). `0` is read as `1`.
    pub fn with_hops(mut self, hops: usize) -> Self {
        self.hops = hops.max(1);
        self
    }

    /// The peer address, always.
    pub fn peer() -> Self {
        Self::default()
    }

    /// The header, believed from loopback only: what a test harness that
    /// drives a router over `127.0.0.1` needs to choose the address it is
    /// counted under. Not a production shape.
    pub fn header(name: &str) -> Self {
        Self::new(
            Some(name.to_string()),
            [
                Cidr::parse("127.0.0.1").expect("a constant"),
                Cidr::parse("::1").expect("a constant"),
            ],
        )
    }

    pub fn header_name(&self) -> Option<&str> {
        self.header.as_deref()
    }

    pub fn trusted_proxies(&self) -> &[Cidr] {
        &self.trusted_proxies
    }

    pub fn hops(&self) -> usize {
        self.hops
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
        // The header is believed from a trusted proxy and from nobody else;
        // with no proxies trusted there is nobody to believe.
        let Some(peer_ip) = peer else {
            return peer_text();
        };
        if !self.trusted(peer_ip) {
            return peer_text();
        }
        // Every line of the header, in arrival order, is one list (RFC 9110
        // §5.3): a proxy that adds its own line instead of appending to the
        // client's has still written last. Counted from the right, the
        // `hops`-th entry is the client; fewer entries than that is a proxy
        // that did not write what the configuration says it does, and the
        // peer is the nearest honest fact.
        headers
            .get_all(name)
            .iter()
            .rev()
            .filter_map(|line| line.to_str().ok())
            .flat_map(|line| line.rsplit(',').map(str::trim))
            .filter(|entry| !entry.is_empty())
            .nth(self.hops - 1)
            .map(|entry| entry.chars().take(255).collect())
            .unwrap_or_else(peer_text)
    }
}

/// ADR-0057 decision 7: the class a session is bound to at sign-in — an
/// IPv4 address exactly, an IPv6 address by its `/64`. RFC 8981 temporary
/// addresses rotate within the same `/64`, so a fresh privacy address is
/// not a network change; a different `/64` still is.
///
/// `None` for anything that is not a parseable address, chiefly
/// `ClientAddress::of`'s `"unknown"` fallback. A session that could not be
/// classed at sign-in is never compared and never wrongly ended.
pub fn address_class(source: &str) -> Option<String> {
    let ip: IpAddr = source.parse().ok()?;
    // An IPv4-mapped IPv6 address (`::ffff:10.0.0.5`) is unmapped first, as
    // `Cidr::contains` already does — masked as v6 it becomes `::`, the
    // same class for every mapped address, which would turn this check off
    // for any dual-stack client.
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    };
    Some(match ip {
        IpAddr::V4(v4) => IpAddr::V4(v4).to_string(),
        IpAddr::V6(v6) => mask(IpAddr::V6(v6), 64).to_string(),
    })
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
    fn with_no_trusted_proxies_the_header_is_never_believed() {
        let p = ClientAddress::new(Some("x-forwarded-for".to_string()), []);
        assert_eq!(p.of(&xff("6.6.6.6"), &from("203.0.113.1")), "203.0.113.1");
        assert_eq!(p.of(&xff("6.6.6.6"), &from("127.0.0.1")), "127.0.0.1");
        assert_eq!(p.of(&xff("6.6.6.6"), &Extensions::new()), "unknown");
    }

    #[test]
    fn with_trusted_proxies_the_last_entry_is_the_client_and_only_from_them() {
        let p = policy(&["10.0.0.0/8"]);
        // The proxy overwrote the header: one entry, the client.
        assert_eq!(
            p.of(&xff("198.51.100.4"), &from("10.0.0.2")),
            "198.51.100.4"
        );
        // The proxy appended to a forged header: the entry it wrote wins.
        assert_eq!(
            p.of(&xff("6.6.6.6, 198.51.100.4"), &from("10.0.0.2")),
            "198.51.100.4"
        );
        // A client whose own address is inside the trusted range keeps it:
        // the proxy wrote it last, and a hop count does not mistake a
        // client for a proxy the way a range would.
        assert_eq!(p.of(&xff("10.0.0.77"), &from("10.0.0.2")), "10.0.0.77");
        assert_eq!(
            p.of(&xff("6.6.6.6, 10.0.0.77"), &from("10.0.0.2")),
            "10.0.0.77"
        );
        // Not from a proxy: the header is ignored, forged or not.
        assert_eq!(p.of(&xff("6.6.6.6"), &from("203.0.113.1")), "203.0.113.1");
        // No peer known at all: nothing can be vouched for.
        assert_eq!(p.of(&xff("6.6.6.6"), &Extensions::new()), "unknown");
    }

    #[test]
    fn private_keeps_a_private_client_s_own_address() {
        let p = ClientAddress::new(
            Some("x-forwarded-for".to_string()),
            parse_trusted_proxies("private").expect("private"),
        );
        // A LAN proxy at 192.168.1.2 forwarding a LAN client at 192.168.1.50:
        // the client, not the proxy, and not a forged entry in front of it.
        assert_eq!(
            p.of(&xff("192.168.1.50"), &from("192.168.1.2")),
            "192.168.1.50"
        );
        assert_eq!(
            p.of(&xff("203.0.113.9, 192.168.1.50"), &from("192.168.1.2")),
            "192.168.1.50"
        );
        // NetBird's proxy at 100.64.0.2 forwarding a client at its public
        // address, and one on the overlay: each is what the proxy wrote.
        assert_eq!(
            p.of(&xff("198.51.100.4"), &from("100.64.0.2")),
            "198.51.100.4"
        );
        assert_eq!(p.of(&xff("100.64.0.7"), &from("100.64.0.2")), "100.64.0.7");
    }

    #[test]
    fn a_hop_count_names_the_entry_an_outer_proxy_wrote() {
        // Edge (203.0.113.200) -> proxy (10.0.0.2) -> here. The proxy appends
        // the edge's address; the edge appended the client's. Two hops.
        let p = policy(&["10.0.0.0/8"]).with_hops(2);
        assert_eq!(
            p.of(&xff("198.51.100.4, 203.0.113.200"), &from("10.0.0.2")),
            "198.51.100.4"
        );
        assert_eq!(
            p.of(
                &xff("6.6.6.6, 198.51.100.4, 203.0.113.200"),
                &from("10.0.0.2")
            ),
            "198.51.100.4"
        );
        // Fewer entries than hops: the proxy did not write what the
        // configuration says, and the peer is the nearest honest fact.
        assert_eq!(p.of(&xff("203.0.113.200"), &from("10.0.0.2")), "10.0.0.2");
        // Zero is one.
        assert_eq!(policy(&["10.0.0.0/8"]).with_hops(0).hops(), 1);
    }

    /// A proxy that adds its own `X-Forwarded-For` line instead of
    /// appending to the client's (RFC 9110 §5.3 makes the lines one list).
    /// The first line is the client's to write; the last is the proxy's.
    #[test]
    fn every_header_line_is_read_and_the_last_one_is_the_proxys() {
        let mut h = HeaderMap::new();
        h.append("x-forwarded-for", HeaderValue::from_static("6.6.6.6"));
        h.append(
            "x-forwarded-for",
            HeaderValue::from_static("6.6.6.7, 198.51.100.4"),
        );
        let p = policy(&["10.0.0.0/8"]);
        assert_eq!(p.of(&h, &from("10.0.0.2")), "198.51.100.4");
        // Blank lines and stray commas do not stand in for an entry.
        let mut h = HeaderMap::new();
        h.append("x-forwarded-for", HeaderValue::from_static("198.51.100.4,"));
        h.append("x-forwarded-for", HeaderValue::from_static(" , "));
        assert_eq!(p.of(&h, &from("10.0.0.2")), "198.51.100.4");
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

    #[test]
    fn address_class_is_exact_for_ipv4() {
        assert_eq!(address_class("203.0.113.9").as_deref(), Some("203.0.113.9"));
        assert_ne!(address_class("203.0.113.9"), address_class("203.0.113.10"));
    }

    #[test]
    fn address_class_is_a_slash_64_for_ipv6() {
        // RFC 8981 temporary addresses rotate the interface identifier
        // inside the same /64 a network assigns: two addresses that differ
        // only there are one class.
        let a = address_class("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
        let b = address_class("2001:db8:1234:5678:1111:2222:3333:4444");
        assert!(a.is_some());
        assert_eq!(a, b);
        // A different /64 is a different class.
        assert_ne!(a, address_class("2001:db8:1234:5679::1"));
    }

    #[test]
    fn address_class_is_none_for_anything_unparseable() {
        assert_eq!(address_class("unknown"), None);
        assert_eq!(address_class(""), None);
        assert_eq!(address_class("203.0.113.9-42-7"), None);
    }
}
