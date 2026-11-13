//! The web client served by the server itself (`src/client.rs`), driven
//! through a real `Router` on a real socket, the way `schema_endpoint.rs`
//! does: no HTTP client crate is in this workspace's closure.

use axum::routing::get;
use axum::Router;
use fathom_server::client::ClientRoot;

fn a_built_client() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "fathom-client-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    std::fs::create_dir_all(dir.join("assets")).expect("assets dir");
    std::fs::create_dir_all(dir.join("engine")).expect("engine dir");
    std::fs::write(
        dir.join("index.html"),
        "<!doctype html><title>Fathom</title>",
    )
    .expect("index");
    std::fs::write(dir.join("assets/main-abc123.js"), "console.log('fathom')").expect("js");
    std::fs::write(dir.join("engine/fathom_wasm.wasm"), b"\0asm\x01\0\0\0").expect("wasm");
    std::fs::write(dir.join(".secret"), "not served").expect("dotfile");
    dir
}

async fn serve(root: ClientRoot) -> std::net::SocketAddr {
    let app = root.attach(Router::new().route("/health", get(|| async { "api\n" })));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

fn status(head: &str) -> &str {
    head.lines().next().unwrap_or_default()
}

#[test]
fn a_root_without_index_html_is_refused() {
    let dir = std::env::temp_dir().join(format!("fathom-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    assert!(ClientRoot::open(&dir).is_err());
    assert!(ClientRoot::open(dir.join("does-not-exist")).is_err());
}

#[tokio::test]
async fn the_client_is_served_and_the_api_wins() {
    let dir = a_built_client();
    let addr = serve(ClientRoot::open(&dir).expect("a built client")).await;

    let (head, body) = raw_http_request(addr, "GET", "/").await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    let lower = head.to_ascii_lowercase();
    assert!(
        lower.contains("content-type: text/html; charset=utf-8"),
        "{head}"
    );
    assert!(lower.contains("x-content-type-options: nosniff"), "{head}");
    assert!(lower.contains("cache-control: no-store"), "{head}");
    assert_eq!(body, "<!doctype html><title>Fathom</title>");

    let (head, body) = raw_http_request(addr, "GET", "/assets/main-abc123.js").await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    let lower = head.to_ascii_lowercase();
    assert!(
        lower.contains("content-type: text/javascript; charset=utf-8"),
        "{head}"
    );
    assert!(
        lower.contains("cache-control: public, max-age=31536000, immutable"),
        "{head}"
    );
    assert_eq!(body, "console.log('fathom')");

    let (head, _) = raw_http_request(addr, "GET", "/engine/fathom_wasm.wasm").await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    assert!(
        head.to_ascii_lowercase()
            .contains("content-type: application/wasm"),
        "{head}"
    );

    // An API route of the same origin still answers as itself.
    let (head, body) = raw_http_request(addr, "GET", "/health").await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(body, "api\n");

    // HEAD answers the headers with no body.
    let (head, body) = raw_http_request(addr, "HEAD", "/").await;
    assert!(status(&head).starts_with("HTTP/1.1 200"), "{head}");
    assert_eq!(body, "");
}

#[tokio::test]
async fn nothing_outside_the_built_client_is_reachable() {
    let dir = a_built_client();
    let addr = serve(ClientRoot::open(&dir).expect("a built client")).await;

    for path in [
        "/missing.html",
        "/assets/",
        "/assets",
        "/.secret",
        "/../Cargo.toml",
        "/assets/../../Cargo.toml",
        "/assets/%2e%2e/%2e%2e/Cargo.toml",
        "/index.html/",
    ] {
        let (head, _) = raw_http_request(addr, "GET", path).await;
        assert!(
            status(&head).starts_with("HTTP/1.1 404"),
            "{path} must be 404, got {}",
            status(&head)
        );
    }

    // A method the file server does not take is not a method it advertises.
    let (head, _) = raw_http_request(addr, "POST", "/index.html").await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");
    let (head, _) = raw_http_request(addr, "DELETE", "/").await;
    assert!(status(&head).starts_with("HTTP/1.1 404"), "{head}");
}

/// **No answer is cacheable unless it is a content-hashed asset** (owner,
/// 2026-10-12: "make sure the admin console can't have cache
/// vulnerabilities"). The routes here deliberately forget to set any cache
/// header, standing for the admin and sign-in routes of the real server and
/// for the day somebody adds one that forgets: the layer `main.rs` mounts
/// (`client::with_security_headers`) must supply `no-store`. `/admin/...` and
/// `/session/challenge` are the real route paths.
#[tokio::test]
async fn every_answer_is_no_store_except_the_hashed_assets() {
    use axum::routing::post;
    use fathom_server::client::{with_security_headers, SecurityHeaders, CONTENT_SECURITY_POLICY};

    let dir = a_built_client();
    let root = ClientRoot::open(&dir).expect("a built client");
    let api = Router::new()
        .route("/admin/operators", get(|| async { "operators\n" }))
        .route("/session/challenge", post(|| async { "challenge\n" }));
    let app = with_security_headers(
        root.attach(api),
        SecurityHeaders::new(fathom_server::client_address::ClientAddress::default()),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    for (method, path) in [
        ("GET", "/admin/operators"),
        ("POST", "/session/challenge"),
        // The page itself: never kept, so a signed-out browser cannot be
        // shown yesterday's shell from disk.
        ("GET", "/"),
        ("GET", "/engine/fathom_wasm.wasm"),
        // An answer no handler wrote: a miss, a wrong method.
        ("GET", "/no-such-file.html"),
        ("POST", "/admin/operators"),
    ] {
        let (head, _) = raw_http_request(addr, method, path).await;
        let lower = head.to_ascii_lowercase();
        assert!(
            lower.contains("cache-control: no-store"),
            "{method} {path} must say no-store:\n{head}"
        );
        assert!(
            lower.contains("pragma: no-cache"),
            "{method} {path} must say Pragma: no-cache:\n{head}"
        );
        // The content security policy is on the same answers and is the
        // constant `client.rs` carries, untouched by the cache work.
        assert!(
            lower.contains(&format!(
                "content-security-policy: {}",
                CONTENT_SECURITY_POLICY.to_ascii_lowercase()
            )),
            "{method} {path} must carry the unchanged CSP:\n{head}"
        );
    }

    // The one thing that may be kept: a file whose name is its content hash.
    let (head, _) = raw_http_request(addr, "GET", "/assets/main-abc123.js").await;
    let lower = head.to_ascii_lowercase();
    assert!(
        lower.contains("cache-control: public, max-age=31536000, immutable"),
        "{head}"
    );
    assert!(!lower.contains("no-store"), "{head}");
}

/// Precompressed files (`name.br`, `name.gz`, written by `client/scripts/precompress.mjs`) are
/// sent to a browser that accepts them, the plain file to one that does not, and neither the
/// variants nor anything else is reachable by its own name.
#[tokio::test]
async fn precompressed_files_go_to_browsers_that_accept_them() {
    let dir = a_built_client();
    std::fs::write(dir.join("assets/main-abc123.js.br"), b"BROTLI").expect("br");
    std::fs::write(dir.join("assets/main-abc123.js.gz"), b"GZIP").expect("gz");
    let addr = serve(ClientRoot::open(&dir).expect("a built client")).await;

    let get = |accept: Option<&'static str>| async move {
        raw_http_bytes(addr, "/assets/main-abc123.js", accept).await
    };

    let (head, body) = get(Some("gzip, deflate, br")).await;
    let lower = head.to_ascii_lowercase();
    assert!(lower.contains("content-encoding: br"), "{head}");
    assert!(lower.contains("vary: accept-encoding"), "{head}");
    assert!(lower.contains("content-type: text/javascript"), "{head}");
    assert_eq!(body, b"BROTLI");

    let (head, body) = get(Some("gzip")).await;
    assert!(
        head.to_ascii_lowercase().contains("content-encoding: gzip"),
        "{head}"
    );
    assert_eq!(body, b"GZIP");

    // Refused with q=0, absent, or only `*`: the plain file, still marked as varying.
    for accept in [Some("br;q=0, gzip;q=0"), None, Some("*"), Some("identity")] {
        let (head, body) = get(accept).await;
        let lower = head.to_ascii_lowercase();
        assert!(!lower.contains("content-encoding"), "{accept:?}: {head}");
        assert!(
            lower.contains("vary: accept-encoding"),
            "{accept:?}: {head}"
        );
        assert_eq!(body, b"console.log('fathom')", "{accept:?}");
    }

    // The variants are not files of their own, and a file with none has no Vary.
    for path in ["/assets/main-abc123.js.br", "/assets/main-abc123.js.gz"] {
        let (head, _) = raw_http_request(addr, "GET", path).await;
        assert!(status(&head).starts_with("HTTP/1.1 404"), "{path}: {head}");
    }
    let (head, _) = raw_http_bytes(addr, "/", Some("br, gzip")).await;
    let lower = head.to_ascii_lowercase();
    assert!(
        !lower.contains("vary:") && !lower.contains("content-encoding"),
        "{head}"
    );
}

async fn raw_http_bytes(
    addr: std::net::SocketAddr,
    path: &str,
    accept_encoding: Option<&str>,
) -> (String, Vec<u8>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("connect");
    let accept = accept_encoding
        .map(|a| format!("Accept-Encoding: {a}\r\n"))
        .unwrap_or_default();
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n{accept}Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.expect("read");
    let split = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a header block");
    (
        String::from_utf8_lossy(&buf[..split]).into_owned(),
        buf[split + 4..].to_vec(),
    )
}

/// HTTP/1.1 by hand over a real socket, as `schema_endpoint.rs` does.
async fn raw_http_request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
) -> (String, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::TcpStream::connect(addr)
        .await
        .expect("connect to the test router");
    let request =
        format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
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
