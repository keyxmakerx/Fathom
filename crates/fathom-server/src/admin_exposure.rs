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
//! `client_address::ClientAddress` derives it (the forwarding header, believed
//! only from a trusted proxy) -- so what the proxy has to get right is the
//! same short list `compose.yaml` already states.

use std::net::IpAddr;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

pub use crate::client_address::Cidr;
use crate::client_address::ClientAddress;

/// The policy: empty lists mean "no restriction of that kind". Both empty
/// is the open console every deployment had before this module, and
/// `main.rs` says so at startup.
#[derive(Clone, Debug, Default)]
pub struct AdminExposure {
    hosts: Vec<String>,
    sources: Vec<Cidr>,
    client_address: ClientAddress,
}

impl AdminExposure {
    pub fn new(
        hosts: impl IntoIterator<Item = String>,
        sources: impl IntoIterator<Item = Cidr>,
        client_address: ClientAddress,
    ) -> Self {
        Self {
            hosts: hosts.into_iter().map(|h| normalise_host(&h)).collect(),
            sources: sources.into_iter().collect(),
            client_address,
        }
    }

    /// True when neither list is set: nothing to enforce, no layer to mount.
    pub fn is_open(&self) -> bool {
        self.hosts.is_empty() && self.sources.is_empty()
    }

    pub fn hosts(&self) -> &[String] {
        &self.hosts
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
            let source = self.client_address.of(headers, extensions);
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
            source = %policy.client_address.of(request.headers(), request.extensions()),
            "operator console request outside FATHOM_ADMIN_HOSTS / FATHOM_ADMIN_SOURCES; answered 404"
        );
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(
            !AdminExposure::new(["a.example".to_string()], [], ClientAddress::peer()).is_open()
        );
    }
}
