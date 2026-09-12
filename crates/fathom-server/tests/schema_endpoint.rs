//! The engine seam, proved against the real shipped tree.
//!
//! `engine.rs`'s own `#[cfg(test)]` module covers `kind_names`'s sorting and
//! the handler's wiring against hand-built fixtures. This file is the other
//! half: the schema this server will actually start with loads, and the
//! endpoint's count is the engine's count — never a number copied alongside
//! it that could drift.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;

use fathom_server::engine::{kinds_handler, EngineState};

/// The workspace's `schema/`, found the same way every other crate's tests
/// find it (`fathom-schema/tests/shipped_tree.rs`,
/// `fathom-emit/tests/coverage.rs`): relative to this crate's manifest, not
/// relative to the process's working directory, which `cargo test` sets to
/// the crate root rather than the workspace root.
fn schema_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schema")
}

#[test]
fn the_shipped_schema_loads_at_startup() {
    EngineState::load(&schema_root()).expect("schema/ must load the way main.rs needs it to");
}

#[test]
fn a_missing_schema_root_fails_loudly_rather_than_starting_empty() {
    let missing = schema_root().join("this-directory-does-not-exist");
    let err = EngineState::load(&missing).expect_err("a missing schema.yaml must not load");
    let rendered = err.to_string();
    assert!(!rendered.is_empty());
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
