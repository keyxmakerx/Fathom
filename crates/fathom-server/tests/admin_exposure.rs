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
