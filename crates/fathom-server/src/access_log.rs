//! One log line for every operator console request and every sign-in, naming
//! the client's own address.
//!
//! Behind a reverse proxy the socket's peer is the proxy, every time. The line
//! carries both: `client`, read by [`ClientAddress`] (the forwarding header,
//! believed only from `FATHOM_TRUSTED_PROXIES`), and `via`, the peer the
//! connection actually came from. A deployment that has not named its proxy
//! sees the two agree on the proxy's address, which is the cue to set it.
//!
//! The path is logged without its query, and nothing from the body: a sign-in
//! body holds a signature and a challenge, and a query is a string a caller
//! writes. This is the server's own log (stdout, or wherever the operator's
//! collector takes it), kept as long as the operator keeps it; the sealed
//! history is separate (`chains.rs`).

use std::net::SocketAddr;

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, Request};
use axum::middleware::Next;
use axum::response::Response;

use crate::admin_exposure::AdminExposure;
use crate::client_address::ClientAddress;

/// Which log a request belongs in, if any.
pub fn plane_of(path: &str) -> Option<&'static str> {
    if AdminExposure::covers(path) || path.starts_with("/enrolment/operator/") {
        Some("operator console")
    } else if path == "/session" || path == "/session/challenge" {
        Some("sign-in")
    } else {
        None
    }
}

/// The middleware `main.rs` mounts over every route.
pub async fn log(
    State(client_address): State<ClientAddress>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let Some(plane) = plane_of(request.uri().path()) else {
        return next.run(request).await;
    };
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| h.chars().take(255).collect::<String>())
        .unwrap_or_else(|| "-".to_owned());
    let client = client_address.of(request.headers(), request.extensions());
    let via = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map_or_else(|| "unknown".to_owned(), |ConnectInfo(a)| a.ip().to_string());
    let response = next.run(request).await;
    tracing::info!(
        plane,
        %method,
        path = %path,
        status = response.status().as_u16(),
        client = %client,
        via = %via,
        host = %host,
        "access"
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_console_and_sign_in_are_logged_and_nothing_else() {
        for path in [
            "/admin",
            "/admin/operators",
            "/enrolment/operator",
            "/enrolment/operator/setup",
        ] {
            assert_eq!(plane_of(path), Some("operator console"), "{path}");
        }
        for path in ["/session", "/session/challenge"] {
            assert_eq!(plane_of(path), Some("sign-in"), "{path}");
        }
        for path in [
            "/",
            "/administer",
            "/sessions",
            "/session/nonce",
            "/organisations/x/designs/y/live",
        ] {
            assert_eq!(plane_of(path), None, "{path}");
        }
    }
}
