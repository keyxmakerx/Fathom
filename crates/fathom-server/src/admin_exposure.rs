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
//! fence Fathom can vouch for.
//!
//! # ADR-0055 stream (c): the placement, and one gap this does NOT close
//!
//! Since 2026-09-21 the same two lists can be set from the console itself
//! (ADR-0055 decision 11, `crate::placement`), read here from a snapshot
//! rather than from a query per request. The environment wins outright when
//! either variable is set.
//!
//! **What is still not covered, reported rather than quietly left:**
//! [`AdminExposure::covers`] matches `/admin*` and `/enrolment/operator`, so
//! `POST /session` and `POST /session/challenge` for `kind='operator'` are
//! still reachable on every host, whatever the placement says. That is the
//! ADR-0055 build contracts' open issue 8. It is orthogonal to placement --
//! placement confines the CONSOLE, not the sign-in surface, and widening
//! `covers` would mean this module parsing sign-in bodies to find out which
//! kind of principal is signing in, which the lead has ruled against
//! (resolution 8, 2026-09-21). The client's own answer is decision 9's flag:
//! on a host that is not the console host it shows nothing operator-side. It reads the same two facts the rate limiter
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
    // ADR-0055 stream (c): the placement an operator set from the console
    // itself, read from a snapshot this process keeps current
    // (`placement.rs`), never from a query per request. The two environment
    // variables WIN OUTRIGHT when either is set (decision 11), and the
    // console's own form is read-only then and says why.
    placement: Option<crate::placement::PlacementView>,
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
            // ADR-0055 stream (c): set by `with_placement`, so a caller that
            // wants the environment-only policy (every existing test) gets
            // exactly what it had.
            placement: None,
        }
    }

    /// True when neither list is set: nothing to enforce, no layer to mount.
    ///
    /// **A policy carrying a placement view is never open**, even while the
    /// placement itself is empty: a placement can be written at any moment
    /// from the console, and a layer that was not mounted at startup cannot
    /// start enforcing one. [`AdminExposure::confines`] is the question
    /// `main.rs` logs about.
    pub fn is_open(&self) -> bool {
        self.hosts.is_empty() && self.sources.is_empty() && self.placement.is_none()
    }

    // ADR-0055 stream (c) --------------------------------------------------

    /// The same policy, reading the console's own placement when neither
    /// environment variable is set.
    pub fn with_placement(mut self, view: crate::placement::PlacementView) -> Self {
        self.placement = Some(view);
        self
    }

    /// Whether anything is confined RIGHT NOW: either environment variable,
    /// or a placement in force. What the startup line and the console's
    /// read-only notice are about.
    pub fn confines(&self) -> bool {
        if !self.hosts.is_empty() || !self.sources.is_empty() {
            return true;
        }
        self.placed().is_some()
    }

    /// Whether the environment decides, in which case the console's placement
    /// form is read-only (decision 11).
    pub fn environment_wins(&self) -> bool {
        !self.hosts.is_empty() || !self.sources.is_empty()
    }

    /// When the placement in force stops being in force unless an operator
    /// confirms it on its new host, or `None` when nothing is pending. What
    /// the flag route's second field carries and what the console counts
    /// down.
    pub fn confirm_by(&self, now_unix: i64) -> Option<i64> {
        if self.environment_wins() {
            return None;
        }
        let view = self.placement.as_ref()?;
        let guard = view.read().ok()?;
        guard.confirm_by(now_unix)
    }

    /// **Which of the three things decided where the console is** — the
    /// flag's third field (ADR-0055 decision 11).
    ///
    /// `"environment"` when `FATHOM_ADMIN_HOSTS`/`FATHOM_ADMIN_SOURCES` are
    /// set, which is the case decision 11 says the console's own form is
    /// read-only in; `"console"` when a placement an operator set is in
    /// force; `"open"` when neither confines anything. The console form was
    /// left to INFER the first of those from a 404 it could not see, which is
    /// not a thing a form can do — so it is told.
    ///
    /// It names no host and no source: the same disclosure line
    /// [`AdminExposure::allows`] already draws for the first field.
    pub fn decided_by(&self) -> &'static str {
        if self.environment_wins() {
            return "environment";
        }
        match self.placed() {
            Some(_) => "console",
            None => "open",
        }
    }

    /// The placement in force, or `None` for "open". Cloned out of the
    /// snapshot: the lock is held for the length of a `clone` and never
    /// across an `await`.
    fn placed(&self) -> Option<crate::placement::Placed> {
        let view = self.placement.as_ref()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let guard = view.read().ok()?;
        guard.effective(now).cloned()
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
    ///
    /// **The environment wins outright when either variable is set** (ADR-0055
    /// decision 11); otherwise the console's own placement decides, and an
    /// empty placement is the open console every deployment had before it.
    pub fn allows(&self, headers: &HeaderMap, extensions: &axum::http::Extensions) -> bool {
        if !self.environment_wins() {
            let Some(placed) = self.placed() else {
                return true;
            };
            return Self::matches(
                &placed.hosts,
                &placed.sources,
                &self.client_address,
                headers,
                extensions,
            );
        }
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

    // ADR-0055 stream (c): the same two checks, over a placement's lists
    // rather than the environment's. One function so that a placement and an
    // environment variable cannot come to mean different things.
    fn matches(
        hosts: &[String],
        sources: &[Cidr],
        client_address: &ClientAddress,
        headers: &HeaderMap,
        extensions: &axum::http::Extensions,
    ) -> bool {
        if !hosts.is_empty() {
            let host = headers
                .get(header::HOST)
                .and_then(|v| v.to_str().ok())
                .map(normalise_host)
                .unwrap_or_default();
            if !hosts.contains(&host) {
                return false;
            }
        }
        if !sources.is_empty() {
            let source = client_address.of(headers, extensions);
            let Ok(ip) = source.parse::<IpAddr>() else {
                return false;
            };
            if !sources.iter().any(|c| c.contains(ip)) {
                return false;
            }
        }
        true
    }
}

/// `Host` as configured and as received: lower-case, no port. An IPv6
/// literal keeps its brackets (`[::1]`), so `[::1]:8080` becomes `[::1]`.
pub fn normalise_host(raw: &str) -> String {
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
            "operator console request outside the console's placement (FATHOM_ADMIN_HOSTS / \
             FATHOM_ADMIN_SOURCES, or the placement set from the console itself); answered 404"
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
