//! `fathom-schema-check [path-to-schema-dir]`
//!
//! Exit codes: 0 clean (warnings allowed), 1 failures, 2 could not run.
//! The unimplemented gates are listed on every run so that a clean exit is
//! never mistaken for full 62 §18 coverage.

use fathom_schema::{check, Severity};
use std::path::PathBuf;
use std::process::ExitCode;

const NOT_YET_CHECKABLE: &[(&str, &str)] = &[
    ("schema.derive.unknown-fn", "needs the derive fn registry"),
    ("schema.emit.unread", "needs emitter read sets"),
    ("schema.emit.attr-read", "needs emitter read sets"),
    (
        "schema.similarity.unknown-term",
        "needs the similarity model",
    ),
    (
        "schema.edge.l1-unpatrolled",
        "needs 62 §6.2's patrol wiring",
    ),
    ("schema.edge.reverse-unindexed", "needs the index build"),
    (
        "schema.version.bump-too-small",
        "schema/released/ holds no snapshot yet",
    ),
    (
        "schema.migration.chain-broken",
        "schema/migrations/manifest.toml declares an (honestly) empty chain; \
         completeness from 1.0 becomes checkable at the first release",
    ),
    ("ext.budget.exceeded", "needs workspace data"),
    ("schema.order.inserted", "needs git history"),
    (
        "schema.enum.default-unsourced",
        "needs the corpus defaults source",
    ),
];

/// Gates that ARE checked, but elsewhere in the workspace — listed on every
/// run so this binary's report stays the one honest inventory of 62 §18
/// coverage.
const CHECKED_ELSEWHERE: &[(&str, &str)] = &[
    (
        "schema.scalar.unbound",
        "compile-time: generated ir_types.rs references every bound impl \
         path, so `cargo build -p fathom-ir` is the check (trait conformance \
         waits on the Scalar trait; fathom-schemagen additionally refuses \
         paths outside fathom_ir::scalar::/value::)",
    ),
    (
        "schema.attrtype.drift",
        "cargo test -p fathom-schemagen (tests/attrtype_drift.rs): 62 §13.3's \
         fenced enum vs fathom_ir::value::AttrType, order included",
    ),
    (
        "schema.codegen.stale",
        "cargo test -p fathom-schemagen (tests/determinism.rs): regenerate \
         and byte-compare the checked-in artifacts; CLI face: \
         fathom-schemagen --check",
    ),
    (
        "schema.codegen.nondeterministic",
        "cargo test -p fathom-schemagen (tests/determinism.rs): run twice, \
         byte-compare",
    ),
];

fn main() -> ExitCode {
    let root = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("schema"));

    let (tree, findings) = match check(&root) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("fathom-schema-check: {e}");
            return ExitCode::from(2);
        }
    };

    let mut failures = 0usize;
    let mut warnings = 0usize;
    for f in &findings {
        let tag = match f.severity {
            Severity::Failure => {
                failures += 1;
                "FAIL"
            }
            Severity::Warning => {
                warnings += 1;
                "warn"
            }
        };
        println!(
            "{tag}  {}  {}:{}  {}",
            f.code,
            f.file.display(),
            f.line,
            f.message
        );
    }

    println!(
        "\n{} kinds · {} edges · {} scalars · {} enums · {} files parsed",
        tree.kinds.len(),
        tree.edges.len(),
        tree.scalars.len(),
        tree.enums.len(),
        tree.parsed_files.len(),
    );
    println!("{failures} failure(s), {warnings} warning(s)");
    println!(
        "not yet checkable ({} gates): {}",
        NOT_YET_CHECKABLE.len(),
        NOT_YET_CHECKABLE
            .iter()
            .map(|(c, _)| *c)
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!(
        "checked elsewhere ({} gates): {}",
        CHECKED_ELSEWHERE.len(),
        CHECKED_ELSEWHERE
            .iter()
            .map(|(c, _)| *c)
            .collect::<Vec<_>>()
            .join(", ")
    );

    if failures > 0 {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    }
}
