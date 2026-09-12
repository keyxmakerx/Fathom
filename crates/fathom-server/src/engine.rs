//! The engine seam — `fathom-server`'s first typed connection to the engine
//! crates.
//!
//! `docs/REBUILD-PLAN.md` Phase 2's opening line is the reason this module
//! exists: *"the stocktake found the two halves of this codebase share
//! nothing — `crates/fathom-server/Cargo.toml` depends on no Fathom crate at
//! all."* This module is that seam, and deliberately a small one:
//!
//! - It loads the `schema/` tree once, at startup, through `fathom_schema`
//!   exactly as `fathom-schema-check` and every other caller in this
//!   workspace does (`SchemaTree::load`) — never a hand-copied reading of the
//!   YAML.
//! - It holds the result read-only in shared state next to
//!   `health::HealthState` for the life of the process.
//! - It exposes a typed accessor to the tree, and one derived view
//!   (`kind_names`) that the one endpoint this order adds is built on.
//!
//! **What is not here.** No table, no write path, no persistence of anything
//! this module touches — see `crate::lib` and `tests/stores_nothing.rs` for
//! why. `fathom-graph` and `fathom-id` are workspace dependencies as of this
//! order (Phase 2 needs all three engine crates wired), but nothing in this
//! module calls into either yet: the schema is the one piece this order's
//! endpoint reads, and a caller for the other two arrives with the step that
//! actually needs one.

use std::fmt;
use std::path::Path;
use std::sync::Arc;

use axum::extract::State;
use axum::response::IntoResponse;

use fathom_schema::model::LoadError;
use fathom_schema::SchemaTree;

/// Where the schema tree lives relative to the process's working directory,
/// absent a caller-supplied root. `fathom-schema-check` (`src/bin/
/// fathom-schema-check.rs`) defaults to the same literal for the same reason:
/// this binary, like that one, is normally run from the workspace root.
pub const DEFAULT_ROOT: &str = "schema";

/// The loaded schema tree, held for the life of the process.
///
/// Read-only by construction — every method here takes `&self`, so there is
/// no path from a handler back into the tree. Reloading (a corpus update, a
/// schema edit picked up without a restart) is deliberately not this type's
/// job until something names it as a requirement.
#[derive(Debug)]
pub struct EngineState {
    schema: SchemaTree,
}

/// Why the schema failed to load. A thin wrapper over
/// `fathom_schema::model::LoadError` rather than a re-derived copy of it, so
/// the two error sets cannot drift apart.
#[derive(Debug)]
pub struct EngineError(LoadError);

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "the schema tree did not load: {}. Its value is not shown here beyond the path fathom-schema reports.",
            self.0
        )
    }
}

impl std::error::Error for EngineError {}

impl EngineState {
    /// Parse the schema tree rooted at `root`.
    ///
    /// Called once, at startup. `main.rs` treats a failure here exactly like
    /// a bad `Config`: print a clear message to stderr and refuse to start,
    /// before anything could serve a request against a schema that never
    /// loaded (`Config::from_env`'s failure path is the precedent this
    /// mirrors).
    pub fn load(root: &Path) -> Result<Self, EngineError> {
        let schema = SchemaTree::load(root).map_err(EngineError)?;
        Ok(Self { schema })
    }

    /// The typed accessor. Every future reader of the schema — the next
    /// Phase 2 steps, and anything after them — reads it through here rather
    /// than through a re-derived copy of the tree.
    pub fn schema(&self) -> &SchemaTree {
        &self.schema
    }

    /// The kind names the loaded tree actually declared, sorted. Read off
    /// `self.schema.kinds` on every call rather than cached at load time, so
    /// there is exactly one place that could disagree with the tree: nowhere.
    pub fn kind_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.schema.kinds.iter().map(|k| k.name.clone()).collect();
        names.sort();
        names
    }
}

/// One kind name per line, sorted, with a trailing newline when there is at
/// least one — the exact `GET /schema/kinds` response body. Separated from
/// the handler so the format can be asserted without going through an HTTP
/// response.
fn render_kinds(names: &[String]) -> String {
    let mut body = names.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    body
}

/// `GET /schema/kinds`.
///
/// `text/plain`, not JSON — the `Cargo.toml` comment on the `axum` dependency
/// is explicit that its `json` feature is deliberately absent because it
/// drags `serde` in, and that is a dependency-budget decision this endpoint
/// does not get to reopen. `String`'s `IntoResponse` already answers
/// `text/plain; charset=utf-8`, so nothing here sets the header by hand.
pub async fn kinds_handler(State(state): State<Arc<EngineState>>) -> impl IntoResponse {
    render_kinds(&state.kind_names())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fathom_schema::model::KindDecl;
    use std::path::PathBuf;

    /// Build a `SchemaTree` by hand, with everything but `kinds` left empty,
    /// so `kind_names`'s sorting and formatting can be tested without
    /// touching disk or depending on the shipped tree's current shape.
    fn tree_with_kinds(names: &[&str]) -> SchemaTree {
        SchemaTree {
            root: PathBuf::new(),
            schema_path: PathBuf::new(),
            toplevel_keys: Vec::new(),
            version: None,
            scalars: Vec::new(),
            classes: Vec::new(),
            kinds: names
                .iter()
                .map(|n| KindDecl {
                    name: (*n).to_string(),
                    layer: None,
                    emits: None,
                    fields: Vec::new(),
                    identity: Vec::new(),
                    line: 0,
                })
                .collect(),
            edges: Vec::new(),
            import_scopes: Vec::new(),
            enums: Vec::new(),
            platforms: None,
            field_keys: None,
            parsed_files: Vec::new(),
            subset_errors: Vec::new(),
        }
    }

    #[test]
    fn kind_names_are_sorted_regardless_of_declaration_order() {
        let engine = EngineState {
            schema: tree_with_kinds(&["Zone", "Device", "Cable"]),
        };
        assert_eq!(engine.kind_names(), vec!["Cable", "Device", "Zone"]);
    }

    #[test]
    fn kind_names_reflects_zero_kinds_honestly() {
        let engine = EngineState {
            schema: tree_with_kinds(&[]),
        };
        assert!(engine.kind_names().is_empty());
    }

    #[test]
    fn render_kinds_is_one_name_per_line_with_a_trailing_newline() {
        assert_eq!(render_kinds(&[]), "");
        assert_eq!(render_kinds(&["Cable".to_string()]), "Cable\n");
        assert_eq!(
            render_kinds(&["Cable".to_string(), "Device".to_string()]),
            "Cable\nDevice\n"
        );
    }

    #[tokio::test]
    async fn the_handler_reports_exactly_what_kind_names_reports() {
        let engine = Arc::new(EngineState {
            schema: tree_with_kinds(&["Zone", "Device", "Cable"]),
        });
        let expected = engine.kind_names();

        let response = kinds_handler(State(engine)).await.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let content_type = response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert!(content_type.starts_with("text/plain"), "{content_type}");

        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("a bounded body");
        let body = String::from_utf8(bytes.to_vec()).expect("utf-8");

        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines, expected, "endpoint body did not match kind_names()");
        assert_eq!(
            lines.len(),
            expected.len(),
            "the endpoint's count must match what the engine reports"
        );
    }
}
