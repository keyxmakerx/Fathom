//! The shipped tree is the first conformance fixture: it must load, parse,
//! and pass every implemented failure gate. The warning set is pinned exactly —
//! a new warning is a change somebody must look at, not noise.

use fathom_schema::{check, Severity};
use std::path::PathBuf;

fn schema_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schema")
}

#[test]
fn shipped_tree_has_zero_failures() {
    let (_, findings) = check(&schema_root()).expect("tree loads");
    let failures: Vec<String> = findings
        .iter()
        .filter(|f| f.severity == Severity::Failure)
        .map(|f| format!("{} {}:{} {}", f.code, f.file.display(), f.line, f.message))
        .collect();
    assert!(
        failures.is_empty(),
        "shipped tree fails its own gates:\n{}",
        failures.join("\n")
    );
}

#[test]
fn shipped_tree_known_warnings_are_pinned() {
    let (_, findings) = check(&schema_root()).expect("tree loads");
    let warnings: Vec<&str> = findings
        .iter()
        .filter(|f| f.severity == Severity::Warning)
        .map(|f| f.code.as_str())
        .collect();
    // Empty since 2026-08-09. It was two `schema.identity.unexercised` for the
    // whole of this tree's life: the `SiteList` scope claimed tiers 1 and 2 of
    // `Site`, which declared no identity tuple because no source had stated one.
    // `Site` and `Device` now declare theirs, so the mismatch is gone rather
    // than suppressed — the gate is unchanged and it simply has nothing to say.
    //
    // An empty vector is a real assertion here and not a vacuous one: the next
    // warning of any code fails this test, which is the point.
    assert_eq!(
        warnings,
        Vec::<&str>::new(),
        "warning set changed — look before re-pinning"
    );
}

#[test]
fn shipped_tree_declaration_counts_hold() {
    let (tree, _) = check(&schema_root()).expect("tree loads");
    // The writer's counts, verified by the workflow's checker and again here.
    // A drift is not necessarily wrong — but it is a diff someone must mean.
    // ADR-0035 (2026-08-15) moved four of these: +1 kind (`Rack`), +2 edges
    // (`HasRack`, `MountedIn`), +7 field keys, version 0.1 -> 0.2. Scalars,
    // enum FILES, classes and import scopes are all deliberately unmoved —
    // `Rack.unit_numbering` and `MountedIn.face` are INLINE enums (62 §7
    // rule 4: single-use and platform-invariant, so no file and no spellings
    // map), and `height_u` / `position_u` are plain `u8` with a `range`
    // constraint rather than a new scalar. Both choices are byte decisions as
    // much as modelling ones: a scalar is a type plus parse plus format plus
    // codegen in a module with a hard ceiling, bought for a bound that 62
    // §3.2's per-field `constraints` already expresses.
    assert_eq!(tree.kinds.len(), 49, "kind count");
    assert_eq!(tree.edges.len(), 91, "edge count (83 + 8 derived)");
    assert_eq!(tree.scalars.len(), 61, "scalar count");
    assert_eq!(tree.enums.len(), 10, "enum file count");
    assert_eq!(tree.classes.len(), 3, "class count");
    assert_eq!(tree.import_scopes.len(), 4, "import scope count");
    let fk = tree.field_keys.as_ref().expect("registry loads");
    assert_eq!(fk.entries.len(), 306, "field-key registry entries");
    assert_eq!(tree.version.as_deref(), Some("0.2"));
}
