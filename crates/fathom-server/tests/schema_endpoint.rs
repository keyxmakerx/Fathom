//! The engine seam, proved against the real shipped tree.
//!
//! `engine.rs`'s own `#[cfg(test)]` module covers `kind_names`'s sorting and
//! the handler's wiring against hand-built fixtures. This file is the other
//! half: the schema this server will actually start with loads, the
//! endpoint's count is the engine's count — never a number copied alongside
//! it that could drift — and the server actually refuses to start on the
//! broken-tree and empty-tree inputs it claims to.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;

use fathom_schema::model::LoadError;
use fathom_server::engine::{kinds_handler, EngineError, EngineState};

/// The workspace's `schema/`, found the same way every other crate's tests
/// find it (`fathom-schema/tests/shipped_tree.rs`,
/// `fathom-emit/tests/coverage.rs`): relative to this crate's manifest, not
/// relative to the process's working directory, which `cargo test` sets to
/// the crate root rather than the workspace root.
fn schema_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schema")
}

static N: AtomicU32 = AtomicU32::new(0);

/// A fresh scratch directory for one fixture. No file in it unless a test
/// writes one — every field the loader treats as optional (`enums/`,
/// `platforms.yaml`, `field-keys.yaml`, `service-types/builtin.yaml`) is
/// simply absent, which `SchemaTree::load` already tolerates.
fn scratch_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("fathom-server-schema-fixture")
        .join(format!(
            "{label}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

#[test]
fn the_shipped_schema_loads_at_startup() {
    EngineState::load(&schema_root()).expect("schema/ must load the way main.rs needs it to");
}

#[test]
fn a_missing_schema_root_fails_loudly_rather_than_starting_empty() {
    let missing = schema_root().join("this-directory-does-not-exist");
    let err = EngineState::load(&missing).expect_err("a missing schema.yaml must not load");
    // What the name promises, not merely "some non-empty message": a root
    // that is not there at all must fail via the missing-`schema.yaml` path
    // specifically, distinct from `EngineError::Failed` — the path for a root
    // that IS there but fails its own gates (Finding 2).
    assert!(
        matches!(err, EngineError::Load(LoadError::MissingSchemaYaml(_))),
        "expected EngineError::Load(LoadError::MissingSchemaYaml(_)), got: {err}"
    );
}

#[test]
fn kind_names_is_never_a_hard_coded_list() {
    let engine = EngineState::load(&schema_root()).expect("schema/ loads");
    let names = engine.kind_names();

    // The real tree has real kinds — STATE.md's count (~51, at the time of
    // writing) is not asserted here, because this test would then be the
    // next thing to go stale. What is asserted is the one thing this order's
    // deliverable actually promises: the names come off the tree that was
    // loaded, one-for-one.
    assert!(!names.is_empty(), "the shipped tree declares no kinds?");
    assert_eq!(
        names.len(),
        engine.schema().kinds.len(),
        "kind_names() must report exactly the kinds the loaded tree knows"
    );

    // A hard-coded list of 51 unique sorted strings would pass every
    // assertion above. This is the one that cannot: it is a real kind name
    // read off `engine.schema()`, not typed into this test, so the assertion
    // is bound to `schema/schema.yaml` rather than to itself. If the shipped
    // tree ever stops declaring `Device`, this line — not the hard-coded
    // list this test is named against — is what must change.
    let device = engine
        .schema()
        .kinds
        .iter()
        .find(|k| k.name == "Device")
        .expect("the shipped tree declares a Device kind")
        .name
        .clone();
    assert!(
        names.contains(&device),
        "kind_names() dropped a kind the loaded tree actually declares: {device}"
    );

    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "kind_names() must already be sorted");

    let mut deduped = names.clone();
    deduped.dedup();
    assert_eq!(
        deduped.len(),
        names.len(),
        "the schema declares a kind more than once: {names:?}"
    );
}

#[tokio::test]
async fn the_endpoints_count_matches_what_the_engine_reports() {
    let engine = Arc::new(EngineState::load(&schema_root()).expect("schema/ loads"));
    let expected = engine.kind_names();

    let response = kinds_handler(State(engine)).await.into_response();
    assert_eq!(response.status(), axum::http::StatusCode::OK);

    let content_type = response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(
        content_type.starts_with("text/plain"),
        "GET /schema/kinds must answer text/plain, not {content_type}"
    );

    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("a bounded body");
    let body = String::from_utf8(bytes.to_vec()).expect("utf-8");

    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(
        lines.len(),
        expected.len(),
        "the endpoint printed a different count of kinds than the engine reports"
    );
    assert_eq!(
        lines, expected,
        "the endpoint's kind names must match the engine's, in order"
    );

    // "one kind name per line" — not a trailing blank line, not names run
    // together.
    assert!(body.ends_with('\n'), "expected a trailing newline");
    assert!(!body.contains("\n\n"), "no blank line between kind names");
}

// ---- Findings 2, 3, 6: the broken-tree and empty-tree cases these tests'
// names already claimed to cover, exercised explicitly ------------------
//
// Before this order: `SchemaTree::load` swallowed a subset parse error into
// `tree.subset_errors` and returned `Ok`; `EngineState::load` called it
// directly and never inspected that field. The confirmed result was a server
// that starts, logs nothing, answers `/health` 200, and serves
// `/schema/kinds` 200 with an empty body (or all 51 kinds and no enums, for a
// corrupt `enums/*.yaml`) against a broken schema. `EngineState::load` must
// now refuse to start in every one of these cases.

#[test]
fn a_corrupt_schema_yaml_refuses_to_start_rather_than_starting_silently() {
    let dir = scratch_dir("corrupt-schema-yaml");
    // A tab in indentation is refused by the subset parser unconditionally
    // (`subset.rs`'s `leading_spaces`) — a reliable, minimal subset
    // violation.
    std::fs::write(dir.join("schema.yaml"), "kinds:\n\t- kind: Widget\n").unwrap();

    let err =
        EngineState::load(&dir).expect_err("a schema.yaml that fails to parse must not start");
    assert!(
        matches!(err, EngineError::Failed(_)),
        "a subset violation must surface as a failed gate, not load cleanly: {err}"
    );
}

#[test]
fn a_corrupt_enum_file_refuses_to_start_rather_than_reporting_no_enums() {
    let dir = scratch_dir("corrupt-enum-file");
    std::fs::write(
        dir.join("schema.yaml"),
        "kinds:\n  - kind: Widget\n    layer: physical\n",
    )
    .unwrap();
    std::fs::create_dir_all(dir.join("enums")).unwrap();
    std::fs::write(dir.join("enums/mode.yaml"), "\tvariants: [a]\n").unwrap();

    let err = EngineState::load(&dir)
        .expect_err("a corrupt enums/*.yaml must not start the server with kinds but no enums");
    assert!(matches!(err, EngineError::Failed(_)), "{err}");
}

#[test]
fn an_empty_schema_yaml_refuses_to_start_rather_than_serving_nothing() {
    // Finding 3: a zero-byte, whitespace-only, or comments-only `schema.yaml`
    // panicked the subset parser (index out of bounds). It must now surface
    // as a refused start, never a panic and never a silently empty tree.
    for (label, content) in [
        ("empty", ""),
        ("whitespace-only", "   \n  \n\n"),
        ("comments-only", "# just a comment\n# another\n"),
    ] {
        let dir = scratch_dir(&format!("empty-schema-{label}"));
        std::fs::write(dir.join("schema.yaml"), content).unwrap();

        let err = EngineState::load(&dir)
            .expect_err(&format!("a {label} schema.yaml must not start the server"));
        assert!(matches!(err, EngineError::Failed(_)), "{label}: {err}");
    }
}

#[test]
fn a_kind_name_with_a_control_character_refuses_to_start() {
    // Finding 6: `render_kinds` is `names.join("\n")` with no validation, and
    // the subset parser's double-quoted scalars accept `\n` escapes, so a
    // kind named `"Site\nZZInjected"` could smuggle an extra, non-existent
    // kind onto the wire. The gate must catch this at load.
    let dir = scratch_dir("control-char-kind-name");
    std::fs::write(
        dir.join("schema.yaml"),
        "kinds:\n  - kind: \"Site\\nZZInjected\"\n    layer: config\n",
    )
    .unwrap();

    let err = EngineState::load(&dir)
        .expect_err("a kind name carrying a control character must not start the server");
    assert!(matches!(err, EngineError::Failed(_)), "{err}");
}

// ---- Finding 5: the route path, the HTTP method, and the `FromRef` wiring
// are reachable only through `router()` — drive a real one ---------------

#[tokio::test]
async fn get_schema_kinds_is_reachable_through_the_real_router() {
    let engine = Arc::new(EngineState::load(&schema_root()).expect("schema/ loads"));
    let expected = engine.kind_names();

    let config = fathom_server::config::Config::from_lookup(|k| {
        (k == "DATABASE_URL").then(|| "postgres://fathom:hunter2@127.0.0.1:5432/fathom".to_string())
    })
    .expect("a minimal config");
    // deadpool is lazy: building a pool opens no connection
    // (`db.rs`'s own `a_pool_is_built_without_touching_the_database`), so this
    // test needs no database.
    let pool = fathom_server::db::pool(&config).expect("pool builds without touching the database");
    let health = Arc::new(fathom_server::health::HealthState {
        pool,
        timeout: config.health_timeout,
    });

    let app = fathom_server::router(fathom_server::AppState { health, engine });

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind an ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let (head, body) = raw_http_request(addr, "GET", "/schema/kinds").await;
    let status_line = head.lines().next().unwrap_or_default();
    assert!(
        status_line.starts_with("HTTP/1.1 200"),
        "GET /schema/kinds through the real Router must answer 200: {status_line}"
    );
    assert!(
        head.to_ascii_lowercase()
            .contains("content-type: text/plain"),
        "{head}"
    );
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(
        lines, expected,
        "the route driven through the real Router must answer the same body as the handler \
         (this is also `FromRef<AppState> for Arc<EngineState>` exercised end to end)"
    );

    // The wrong method on the right path must not be routed to the handler.
    let (post_head, _) = raw_http_request(addr, "POST", "/schema/kinds").await;
    assert!(
        post_head
            .lines()
            .next()
            .unwrap_or_default()
            .starts_with("HTTP/1.1 405"),
        "POST /schema/kinds must be refused (405), not silently handled: {post_head}"
    );

    // A path this order did not register must not match by accident.
    let (miss_head, _) = raw_http_request(addr, "GET", "/schema/kind").await;
    assert!(
        miss_head
            .lines()
            .next()
            .unwrap_or_default()
            .starts_with("HTTP/1.1 404"),
        "GET /schema/kind (singular, unregistered) must 404: {miss_head}"
    );
}

/// Speak HTTP/1.1 by hand over a real socket, exactly the way
/// `src/healthcheck.rs` does for the same reason: no HTTP client crate is in
/// this workspace's closure, and this needs eleven bytes out and a status
/// line back, not a general client. `Connection: close` means everything
/// after the blank line, to EOF, is the whole body.
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
