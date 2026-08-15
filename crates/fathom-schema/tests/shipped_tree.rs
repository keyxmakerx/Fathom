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
    assert_eq!(tree.kinds.len(), 49, "kind count");
    assert_eq!(tree.edges.len(), 90, "edge count (82 + 8 derived)");
    assert_eq!(tree.scalars.len(), 61, "scalar count");
    assert_eq!(tree.enums.len(), 10, "enum file count");
    assert_eq!(tree.classes.len(), 4, "class count");
    assert_eq!(tree.import_scopes.len(), 4, "import scope count");
    let fk = tree.field_keys.as_ref().expect("registry loads");
    assert_eq!(fk.entries.len(), 301, "field-key registry entries");
    assert_eq!(tree.version.as_deref(), Some("0.1"));
}

/// The `Placeable` class means *"every kind the diagram can draw as a box"*, and
/// today that is every declared kind but `LayoutPin` itself (ADR-0035). A class
/// is a list of names, so the sentence and the list can drift the moment a kind
/// is added — and the drift is silent and invisible in the worst direction: the
/// new kind simply cannot be placed, with nothing anywhere to say so.
///
/// This is the noticer. It is a test rather than a gate because the rule is
/// ADR-0035's, not `62`'s: a later record could decide that some kinds are
/// deliberately unplaceable, and then this test changes to say which, in one
/// place, with the reasoning beside it.
#[test]
fn every_kind_but_the_pin_itself_is_placeable() {
    let (tree, _) = check(&schema_root()).expect("tree loads");
    let class = tree
        .classes
        .iter()
        .find(|c| c.name == "Placeable")
        .expect("the Placeable class is declared");
    let mut want: Vec<&str> = tree
        .kinds
        .iter()
        .map(|k| k.name.as_str())
        .filter(|n| *n != "LayoutPin")
        .collect();
    let mut have: Vec<&str> = class.members.iter().map(String::as_str).collect();
    want.sort_unstable();
    have.sort_unstable();
    assert_eq!(
        have, want,
        "Placeable and kinds: have drifted — a kind added to schema.yaml is not placeable, \
         or LayoutPin has been admitted to the class it is the target of"
    );
}
