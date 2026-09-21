//! `src/admin_exposure.rs` driven through a real `Router` on a real socket,
//! with the peer address populated the way `main.rs` populates it.

use axum::routing::{get, post};
use axum::Router;
use fathom_server::admin_exposure::{gate, AdminExposure, Cidr};
use fathom_server::client_address::ClientAddress;

async fn serve(policy: AdminExposure) -> std::net::SocketAddr {
    let admin = Router::new()
        .route("/admin/ping", get(|| async { "console\n" }))
        .route("/enrolment/operator", post(|| async { "operator\n" }))
        .route("/enrolment/account", post(|| async { "account\n" }))
        .layer(axum::middleware::from_fn_with_state(policy, gate));
    let app = Router::new()
        .route("/health", get(|| async { "ok\n" }))
        .merge(admin);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    addr
}

fn status(head: &str) -> &str {
    head.lines().next().unwrap_or_default()
}

#[tokio::test]
async fn the_console_answers_only_on_its_host_and_from_its_addresses() {
    let policy = AdminExposure::new(
        ["Admin.Example.test".to_string()],
        [Cidr::parse("10.0.0.0/8").expect("cidr")],
        // The test's peer is loopback; it is the trusted proxy here.
        ClientAddress::new(
            Some("X-Forwarded-For".to_string()),
            [Cidr::parse("127.0.0.1").expect("cidr")],
        ),
    );
    let addr = serve(policy).await;

    // The right host from the right place.
    let (head, body) = request(
        addr,
        "GET",
        "/admin/ping",
        &[
            ("Host", "admin.example.test:8080"),
            ("X-Forwarded-For", "10.20.30.40"),
        ],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(body, "console\n");
    let (head, _) = request(
        addr,
        "POST",
        "/enrolment/operator",
        &[
            ("Host", "admin.example.test"),
            ("X-Forwarded-For", "203.0.113.9, 10.1.1.1"),
        ],
    )
    .await;
    assert!(
        status(&head).starts_with("HTTP/1.1 200"),
        "the trusted header's LAST entry is the address: {head}"
    );

    // The site's host: the console is not here.
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[
            ("Host", "fathom.example.test"),
            ("X-Forwarded-For", "10.20.30.40"),
        ],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");
    // The right host from the wrong place.
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[
            ("Host", "admin.example.test"),
            ("X-Forwarded-For", "203.0.113.9"),
        ],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");
    // The right host, no forwarding header: the peer (127.0.0.1) is not in 10/8.
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[("Host", "admin.example.test")],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");
    // A forwarded address that is not an address.
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[
            ("Host", "admin.example.test"),
            ("X-Forwarded-For", "not-an-ip"),
        ],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");
    // A proxy that adds its own header line below the client's (as F5's
    // "Insert X-Forwarded-For" and an nginx `add_header` do) rather than
    // appending to it: the proxy's line is the last one, and it is what
    // counts, whichever way round the two are.
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[
            ("Host", "admin.example.test"),
            ("X-Forwarded-For", "10.20.30.40"),
            ("X-Forwarded-For", "203.0.113.9"),
        ],
    )
    .await;
    assert!(
        status(&head).starts_with("HTTP/1.1 404"),
        "the client's own line must not open the console: {head}"
    );
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[
            ("Host", "admin.example.test"),
            ("X-Forwarded-For", "203.0.113.9"),
            ("X-Forwarded-For", "10.20.30.40"),
        ],
    )
    .await;
    assert!(
        status(&head).starts_with("HTTP/1.1 200"),
        "the proxy's line is the last one and it counts: {head}"
    );

    // The rest of the site is untouched everywhere.
    let (head, body) = request(
        addr,
        "POST",
        "/enrolment/account",
        &[
            ("Host", "fathom.example.test"),
            ("X-Forwarded-For", "203.0.113.9"),
        ],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(body, "account\n");
    let (head, _) = request(addr, "GET", "/health", &[("Host", "fathom.example.test")]).await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
}

#[tokio::test]
async fn hosts_alone_and_sources_alone_each_confine_on_their_own() {
    let addr = serve(AdminExposure::new(
        ["console.other-domain.test".to_string()],
        [],
        ClientAddress::peer(),
    ))
    .await;
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[("Host", "console.other-domain.test")],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[("Host", "fathom.example.test")],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");

    // Sources only, judged by the peer when no forwarding header is trusted:
    // the peer is loopback, and a forged X-Forwarded-For does not count.
    let addr = serve(AdminExposure::new(
        [],
        [Cidr::parse("127.0.0.1").expect("cidr")],
        ClientAddress::peer(),
    ))
    .await;
    let (head, _) = request(addr, "GET", "/admin/ping", &[("Host", "anything.test")]).await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    let addr = serve(AdminExposure::new(
        [],
        [Cidr::parse("10.0.0.0/8").expect("cidr")],
        ClientAddress::peer(),
    ))
    .await;
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[("Host", "anything.test"), ("X-Forwarded-For", "10.0.0.1")],
    )
    .await;
    assert!(
        status(&head).starts_with("HTTP/1.1 404"),
        "an untrusted forwarding header must not open the console: {head}"
    );

    // The header IS configured, but only a proxy in 10/8 may vouch for it,
    // and the peer is loopback: the forged entry is ignored, the peer is
    // judged, and the peer is not in the range.
    let addr = serve(AdminExposure::new(
        [],
        [Cidr::parse("10.0.0.0/8").expect("cidr")],
        ClientAddress::new(
            Some("X-Forwarded-For".to_string()),
            [Cidr::parse("10.0.0.0/8").expect("cidr")],
        ),
    ))
    .await;
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[("Host", "anything.test"), ("X-Forwarded-For", "10.0.0.1")],
    )
    .await;
    assert!(
        status(&head).starts_with("HTTP/1.1 404"),
        "a header from an untrusted peer must not open the console: {head}"
    );
}

// ---------------------------------------------------------------------------
// ADR-0055 stream (c) — the placement an operator set from the console itself
// ---------------------------------------------------------------------------

use std::sync::{Arc, RwLock};

use fathom_server::placement::{Placed, Placement, PlacementView};

/// A snapshot with no database behind it: the gate reads a `Placement`, and
/// what put it there — a `console_placements` row or this function — is not
/// something `AdminExposure` can tell apart. `tests/placement.rs` drives the
/// same gate from real rows.
fn snapshot(placement: Placement) -> PlacementView {
    Arc::new(RwLock::new(placement))
}

fn placed(host: &str, source: &str) -> Placed {
    Placed {
        hosts: vec![host.to_string()],
        sources: vec![Cidr::parse(source).expect("cidr")],
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs() as i64
}

/// The same router as [`serve`], plus the unauthenticated flag — which is
/// **not** under `/admin`, so it answers on every host, which is the whole
/// point of it (ADR-0055 decision 9: the answer a client needs on a host that
/// is not the console host is "no", and a route under `/admin` is 404 exactly
/// there).
async fn serve_with_flag(policy: AdminExposure) -> std::net::SocketAddr {
    let admin = Router::new()
        .route("/admin/ping", get(|| async { "console\n" }))
        .route("/enrolment/operator", post(|| async { "operator\n" }))
        .layer(axum::middleware::from_fn_with_state(policy.clone(), gate));
    let app = Router::new()
        .route("/health", get(|| async { "ok\n" }))
        .merge(admin)
        .merge(fathom_server::placement::flag_router(policy));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    addr
}

/// The flag's body: `LP("yes"|"no")`, then `LP(confirm_by)` when yes.
fn read_flag(body: &str) -> (String, Option<String>) {
    let bytes = body.as_bytes();
    let (first, rest) = fathom_server::crypto::read_lp(bytes).expect("a length-prefixed answer");
    let flag = String::from_utf8_lossy(first).into_owned();
    let deadline = fathom_server::crypto::read_lp(rest)
        .map(|(field, _)| String::from_utf8_lossy(field).into_owned());
    (flag, deadline)
}

#[tokio::test]
async fn a_placement_set_in_the_console_confines_the_console_like_the_environment_does() {
    let policy = AdminExposure::new([], [], ClientAddress::peer()).with_placement(snapshot(
        Placement::from_parts(Some(placed("console.example.test", "127.0.0.1")), None),
    ));
    let addr = serve_with_flag(policy).await;

    let (head, body) = request(
        addr,
        "GET",
        "/admin/ping",
        &[("Host", "Console.Example.test:8443")],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(body, "console\n");

    // The site's own host: the console is not here, and nothing says it is.
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[("Host", "fathom.example.test")],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");
    let (head, _) = request(
        addr,
        "POST",
        "/enrolment/operator",
        &[("Host", "fathom.example.test")],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");
    // ...and the site itself is untouched.
    let (head, _) = request(addr, "GET", "/health", &[("Host", "fathom.example.test")]).await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
}

#[tokio::test]
async fn the_flag_answers_on_every_host_and_says_which_one_is_the_console() {
    let policy = AdminExposure::new([], [], ClientAddress::peer()).with_placement(snapshot(
        Placement::from_parts(Some(placed("console.example.test", "127.0.0.1")), None),
    ));
    let addr = serve_with_flag(policy).await;

    let (head, body) = request(
        addr,
        "GET",
        "/placement/flag",
        &[("Host", "console.example.test")],
    )
    .await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(read_flag(&body).0, "yes");

    // **The answer a client needs where `/admin` is 404**: 200 and "no".
    let (head, body) = request(
        addr,
        "GET",
        "/placement/flag",
        &[("Host", "fathom.example.test")],
    )
    .await;
    assert!(
        status(&head).starts_with("HTTP/1.1 200"),
        "the flag is not confined and must answer everywhere: {head}"
    );
    assert_eq!(read_flag(&body).0, "no");
}

#[tokio::test]
async fn a_pending_placement_answers_with_the_deadline_and_stops_at_it() {
    let confirm_by = now() + 120;
    let policy = AdminExposure::new([], [], ClientAddress::peer()).with_placement(snapshot(
        Placement::from_parts(
            Some(placed("old.example.test", "127.0.0.1")),
            Some((placed("new.example.test", "127.0.0.1"), confirm_by)),
        ),
    ));
    let addr = serve_with_flag(policy).await;

    let (_, body) = request(
        addr,
        "GET",
        "/placement/flag",
        &[("Host", "new.example.test")],
    )
    .await;
    let (flag, deadline) = read_flag(&body);
    assert_eq!(flag, "yes");
    assert_eq!(deadline.as_deref(), Some(confirm_by.to_string().as_str()));
    // The old host is not the console while the new one's window runs.
    let (head, _) = request(addr, "GET", "/admin/ping", &[("Host", "old.example.test")]).await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");

    // A window that has already run out: **the gate falls back to the last
    // confirmed placement by the clock**, before any sweep has written
    // anything, so a failed move cannot leave the console stranded on a host
    // nobody reached.
    let policy = AdminExposure::new([], [], ClientAddress::peer()).with_placement(snapshot(
        Placement::from_parts(
            Some(placed("old.example.test", "127.0.0.1")),
            Some((placed("new.example.test", "127.0.0.1"), now() - 1)),
        ),
    ));
    let addr = serve_with_flag(policy).await;
    let (head, _) = request(addr, "GET", "/admin/ping", &[("Host", "old.example.test")]).await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    let (head, _) = request(addr, "GET", "/admin/ping", &[("Host", "new.example.test")]).await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");
    let (_, body) = request(
        addr,
        "GET",
        "/placement/flag",
        &[("Host", "old.example.test")],
    )
    .await;
    assert_eq!(read_flag(&body), ("yes".to_string(), Some(String::new())));
}

#[tokio::test]
async fn the_environment_wins_over_a_placement_and_the_flag_says_so() {
    // ADR-0055 decision 11: *"`FATHOM_ADMIN_HOSTS` and `FATHOM_ADMIN_SOURCES`
    // win when set, and the form says so and is read-only then."* A console
    // that could be moved out from under the environment would be a console
    // whose operator-set value silently overrode the deployment's own.
    let policy = AdminExposure::new(["env.example.test".to_string()], [], ClientAddress::peer())
        .with_placement(snapshot(Placement::from_parts(
            Some(placed("console.example.test", "127.0.0.1")),
            None,
        )));
    assert!(policy.environment_wins());
    let addr = serve_with_flag(policy).await;

    let (head, _) = request(addr, "GET", "/admin/ping", &[("Host", "env.example.test")]).await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    let (head, _) = request(
        addr,
        "GET",
        "/admin/ping",
        &[("Host", "console.example.test")],
    )
    .await;
    assert!(
        status(&head).starts_with("HTTP/1.1 404"),
        "a placement must not open a host the environment did not name: {head}"
    );

    let (_, body) = request(
        addr,
        "GET",
        "/placement/flag",
        &[("Host", "env.example.test")],
    )
    .await;
    assert_eq!(read_flag(&body), ("yes".to_string(), Some(String::new())));
    let (_, body) = request(
        addr,
        "GET",
        "/placement/flag",
        &[("Host", "console.example.test")],
    )
    .await;
    assert_eq!(read_flag(&body).0, "no");
}

#[tokio::test]
async fn with_no_placement_and_no_environment_the_console_is_open_and_the_flag_says_yes() {
    let policy = AdminExposure::new([], [], ClientAddress::peer())
        .with_placement(snapshot(Placement::default()));
    let addr = serve_with_flag(policy).await;
    for host in ["anything.test", "fathom.example.test"] {
        let (head, _) = request(addr, "GET", "/admin/ping", &[("Host", host)]).await;
        assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
        let (_, body) = request(addr, "GET", "/placement/flag", &[("Host", host)]).await;
        assert_eq!(read_flag(&body).0, "yes", "on {host}");
    }
}

/// HTTP/1.1 by hand over a real socket, as `schema_endpoint.rs` does, with
/// the headers this test is about.
async fn request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> (String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("connect to the test router");
    let mut request = format!("{method} {path} HTTP/1.1\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        request.push_str("Host: localhost\r\n");
    }
    for (k, v) in headers {
        request.push_str(&format!("{k}: {v}\r\n"));
    }
    request.push_str("Connection: close\r\nContent-Length: 0\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write the request");
    let mut buf = Vec::new();
    stream
        .read_to_end(&mut buf)
        .await
        .expect("read the response");
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut halves = text.splitn(2, "\r\n\r\n");
    let head = halves.next().unwrap_or_default().to_string();
    let body = halves.next().unwrap_or_default().to_string();
    (head, body)
}
