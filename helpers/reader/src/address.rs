//! The reader checks the address again before it sends anything (ADR-0082 §4.4): it must sit
//! inside one of the ranges the job carries, and it must not be an address no range may reach.
//! The server checks the same; this is the second lock, so a job built wrongly still stops here.
//!
//! The refused blocks are IANA's special-purpose registries (IPv4 and IPv6, both last updated
//! 2025-10-09, read 2026-11-02), the same list as `crates/fathom-server/src/device_read.rs`.

use std::net::IpAddr;

/// Why this address may never be read, or `None`.
pub fn refused(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            match o[0] {
                0 => Some("an address in 0.0.0.0/8, \"this network\""),
                127 => Some("a loopback address, the reader's own machine"),
                169 if o[1] == 254 => Some("a link-local address"),
                224..=239 => Some("a multicast address"),
                240..=255 => Some("a reserved address"),
                _ => None,
            }
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return refused(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            if v6.is_unspecified() {
                Some("the unspecified address")
            } else if v6.is_loopback() {
                Some("a loopback address, the reader's own machine")
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

/// Whether `ip` is inside `cidr` (`10.20.0.0/24`, `2001:db8::/48`). A malformed range holds
/// nothing.
pub fn inside(ip: IpAddr, cidr: &str) -> bool {
    let Some((net, len)) = cidr.split_once('/') else {
        return false;
    };
    let (Ok(net), Ok(len)) = (net.parse::<IpAddr>(), len.parse::<u32>()) else {
        return false;
    };
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(n)) if len <= 32 => {
            let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
            u32::from(a) & mask == u32::from(n) & mask
        }
        (IpAddr::V6(a), IpAddr::V6(n)) if len <= 128 => {
            let mask = if len == 0 {
                0
            } else {
                u128::MAX << (128 - len)
            };
            u128::from(a) & mask == u128::from(n) & mask
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
    fn only_a_listed_range_lets_an_address_through() {
        assert!(inside(ip("10.20.0.5"), "10.20.0.0/24"));
        assert!(!inside(ip("10.20.1.5"), "10.20.0.0/24"));
        assert!(inside(ip("2001:db8::9"), "2001:db8::/48"));
        assert!(!inside(ip("2001:db8::9"), "10.0.0.0/8"));
        assert!(!inside(ip("10.0.0.1"), "10.0.0.0"));
        assert!(!inside(ip("10.0.0.1"), "10.0.0.0/33"));
    }

    #[test]
    fn the_machine_itself_link_local_and_multicast_are_never_read() {
        for a in [
            "127.0.0.1",
            "0.1.2.3",
            "169.254.1.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(refused(ip(a)).is_some(), "{a}");
        }
        for a in ["10.0.0.1", "192.168.1.1", "172.16.0.1", "2001:db8::1"] {
            assert!(refused(ip(a)).is_none(), "{a}");
        }
    }
}
