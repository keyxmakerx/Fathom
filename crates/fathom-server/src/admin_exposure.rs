//! Where the operator console answers.
//!
//! `/admin/*` and `/enrolment/operator` are the operator console: the routes
//! that create organisations and accounts, appoint and second operators, and
//! change settings. Everything else the server serves is the site. Since
//! 2026-09-20 a deployment can confine the console to a host name of its own
//! (`FATHOM_ADMIN_HOSTS`: a subdomain, or a domain that has nothing to do
//! with the site's) and to the addresses it may be used from
//! (`FATHOM_ADMIN_SOURCES`: addresses and CIDR ranges), with the site itself
//! unaffected on every host. A console request that fails either check is
//! answered **404**, the same answer as a route that does not exist, because
//! on that host and from that address it does not: a route that answers is
//! a route an attacker can probe, and "403" would say the console is here.
//!
//! Enforced HERE, in the binary, not left to the reverse proxy in front: the
//! proxy is the operator's and can be misconfigured; this is the part of the
//! fence Fathom can vouch for. It reads the same two facts the rate limiter
//! reads -- the `Host` header the proxy forwards, and the client address as
//! `api::source_of_with` derives it (the trusted forwarding header's last
//! entry when one is configured, else the peer) -- so what the proxy has to
//! get right is the same short list `compose.yaml` already states.
//!
//! No crate arrives with this. CIDR matching over `std::net::IpAddr` is a
//! mask and a compare; an `ipnet` would be one more package in the closure
//! gate-zero measures for thirty lines.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::api;

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
        mask(ip, self.prefix) == self.network
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

/// The policy: empty lists mean "no restriction of that kind". Both empty
/// is the open console every deployment had before this module, and
/// `main.rs` says so at startup.
#[derive(Clone, Debug, Default)]
pub struct AdminExposure {
    hosts: Vec<String>,
    sources: Vec<Cidr>,
    trusted_client_ip_header: Option<String>,
}

impl AdminExposure {
    pub fn new(
        hosts: impl IntoIterator<Item = String>,
        sources: impl IntoIterator<Item = Cidr>,
        trusted_client_ip_header: Option<String>,
    ) -> Self {
        Self {
            hosts: hosts.into_iter().map(|h| normalise_host(&h)).collect(),
            sources: sources.into_iter().collect(),
            trusted_client_ip_header,
        }
    }

    /// True when neither list is set: nothing to enforce, no layer to mount.
    pub fn is_open(&self) -> bool {
        self.hosts.is_empty() && self.sources.is_empty()
    }

    pub fn hosts(&self) -> &[String] {
        &self.hosts
    }

    pub fn sources(&self) -> &[Cidr] {
        &self.sources
    }

    /// The paths this policy covers. `/enrolment/account` is NOT one: an
    /// invited account redeems its token on the site, from wherever it is.
    pub fn covers(path: &str) -> bool {
        path == "/admin" || path.starts_with("/admin/") || path == "/enrolment/operator"
    }

    /// Both checks that are configured must pass.
    pub fn allows(&self, headers: &HeaderMap, extensions: &axum::http::Extensions) -> bool {
        if !self.hosts.is_empty() {
            let host = headers
                .get(header::HOST)
                .and_then(|v| v.to_str().ok())
                .map(normalise_host)
                .unwrap_or_default();
            if !self.hosts.contains(&host) {
                return false;
            }
        }
        if !self.sources.is_empty() {
            let source = api::source_of_with(
                self.trusted_client_ip_header.as_deref(),
                headers,
                extensions,
            );
            let Ok(ip) = source.parse::<IpAddr>() else {
                return false;
            };
            if !self.sources.iter().any(|c| c.contains(ip)) {
                return false;
            }
        }
        true
    }
}

/// `Host` as configured and as received: lower-case, no port. An IPv6
/// literal keeps its brackets (`[::1]`), so `[::1]:8080` becomes `[::1]`.
fn normalise_host(raw: &str) -> String {
    let raw = raw.trim();
    let without_port = if raw.starts_with('[') {
        match raw.find(']') {
            Some(i) => &raw[..=i],
            None => raw,
        }
    } else {
        raw.rsplit_once(':')
            .filter(|(_, port)| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
            .map(|(host, _)| host)
            .unwrap_or(raw)
    };
    without_port.to_ascii_lowercase()
}

/// The middleware `main.rs` mounts on the admin router when the policy is
/// not open. A covered path that fails is 404; everything else passes.
pub async fn gate(
    State(policy): State<AdminExposure>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if AdminExposure::covers(request.uri().path())
        && !policy.allows(request.headers(), request.extensions())
    {
        tracing::warn!(
            path = %request.uri().path(),
            host = request
                .headers()
                .get(header::HOST)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("-"),
            source = %api::source_of_with(
                policy.trusted_client_ip_header.as_deref(),
                request.headers(),
                request.extensions()
            ),
            "operator console request outside FATHOM_ADMIN_HOSTS / FATHOM_ADMIN_SOURCES; answered 404"
        );
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("ip")
    }

    #[test]
    fn a_bare_address_is_a_range_of_one() {
        let c = Cidr::parse("10.0.0.5").expect("parses");
        assert!(c.contains(ip("10.0.0.5")));
        assert!(!c.contains(ip("10.0.0.6")));
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
    }

    #[test]
    fn hosts_compare_without_port_or_case() {
        assert_eq!(
            normalise_host("Admin.Example.COM:8080"),
            "admin.example.com"
        );
        assert_eq!(normalise_host("admin.example.com"), "admin.example.com");
        assert_eq!(normalise_host("[::1]:8080"), "[::1]");
        assert_eq!(normalise_host(" localhost "), "localhost");
    }

    #[test]
    fn the_console_paths_and_only_those_are_covered() {
        assert!(AdminExposure::covers("/admin/settings"));
        assert!(AdminExposure::covers("/admin"));
        assert!(AdminExposure::covers("/enrolment/operator"));
        assert!(!AdminExposure::covers("/enrolment/account"));
        assert!(!AdminExposure::covers("/administrator"));
        assert!(!AdminExposure::covers("/session"));
        assert!(!AdminExposure::covers("/"));
    }

    #[test]
    fn an_open_policy_mounts_nothing() {
        assert!(AdminExposure::default().is_open());
        assert!(!AdminExposure::new(["a.example".to_string()], [], None).is_open());
    }
}
