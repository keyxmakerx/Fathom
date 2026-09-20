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
    assert!(lower.contains("cache-control: no-cache"), "{head}");
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
