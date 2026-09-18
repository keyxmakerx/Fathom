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
    // ADR-0036 (2026-08-15) moved four of these on top of ADR-0035's row: +1
    // kind (`Rack`, 49 -> 50), +2 edges (`HasRack`, `MountedIn`, 90 -> 92),
    // +6 field keys (301 -> 307), version 0.1 -> 0.2. Scalars, enum FILES and
    // import scopes are deliberately unmoved — `Rack.unit_numbering` and
    // `MountedIn.face` are INLINE enums (62 §7 rule 4: single-use and
    // platform-invariant, so no file and no spellings map), and `height_u` /
    // `position_u` are plain `u8` with a `range` constraint rather than a new
    // scalar. Both choices are byte decisions as much as modelling ones: a
    // scalar is a type plus parse plus format plus codegen in a module with a
    // hard ceiling, bought for a bound that 62 §3.2's per-field `constraints`
    // already expresses. The `Placeable` CLASS did move — it gained `Rack` —
    // and `every_kind_but_the_pin_itself_is_placeable` below is the noticer.
    assert_eq!(tree.kinds.len(), 53, "kind count");
    assert_eq!(tree.edges.len(), 99, "edge count (91 + 8 derived)");
    assert_eq!(tree.scalars.len(), 61, "scalar count");
    assert_eq!(tree.enums.len(), 10, "enum file count");
    assert_eq!(tree.classes.len(), 4, "class count");
    assert_eq!(tree.import_scopes.len(), 4, "import scope count");
    let fk = tree.field_keys.as_ref().expect("registry loads");
    assert_eq!(fk.entries.len(), 325, "field-key registry entries");
    // ADR-0037 (2026-08-16) moved exactly ONE of these: version 0.2 -> 0.3. Two
    // `Device.role` variants is not a kind, not an edge, not a field and not a
    // key — the registry is untouched at 307 — and `role` is an INLINE enum, so
    // `enums` (the FILE count) does not move either. That the only line to change
    // here is the version is itself the evidence that the change is as small as
    // ADR-0037 claims.
    //
    // 0.3 -> 0.4 (2026-08-28) is the same shape of evidence again: relaxing
    // `PhysicalPort.label` to `0..1` (the owner's answer to 57 §13.5's open
    // decision 8, 70 §18) moves no count in this function — same kinds, same
    // edges, same 307 keys, same files. A cardinality is not a declaration.
    //
    // 0.4 -> 0.5 (2026-08-29) is WO-10 and moves three of the counts above:
    // +1 kind (`DhcpRelay`, 50 -> 51), +3 edges (`HasDhcpRelay`, `RelaysFor`,
    // `RelayServerIn`, 92 -> 95 -- THREE, not the order's original two, because
    // the owner chose a real `RoutingInstance` edge over a string field,
    // 70 §18.5), +4 field keys (308-311, 307 -> 311). Scalars, enum files,
    // classes and scopes are unmoved: `server` is the existing `IpAddr`,
    // `group_name` the existing `Identifier`, the two limits plain `u32`. The
    // `Placeable` CLASS gained `DhcpRelay` and the noticer below still holds.
    //
    // 0.5 -> 0.6 (2026-09-16) is the cables session's schema half and moves
    // exactly one count: +1 field key (`Cable.sheath`, 311 -> 312). No kind,
    // no edge, no scalar, no enum FILE, no class, no import scope --
    // `Cable.sheath` and `PhysicalPort.connector`/`.service`'s new variants
    // are all INLINE enums, and the two variant additions land on already-
    // keyed fields, so only the registry and the version move.
    //
    // 0.6 -> 0.7 (2026-09-16) is ADR-0050 (the rear elevation) and moves four of the
    // counts above: +1 kind (`PowerSupply`, 51 -> 52), +1 edge (`FittedIn`, 95 -> 96),
    // +5 field keys (313-317, 312 -> 317, two on Rack and three on PowerSupply). Scalars,
    // enum FILE count and import scopes are unmoved: `row` is `Text`, `bay` and `slot`'s
    // siblings are `u16`/`Text`/`Identifier`, all pre-existing types. The `class` count
    // stays 4 -- no class added -- but two of the four existing classes widen their
    // membership (`Placeable` gains `PowerSupply`, `PortHost` gains `PowerSupply`), which
    // is why `every_kind_but_the_pin_itself_is_placeable` below is still the noticer for
    // the first and there is no equivalent noticer for the second, per PortHost's own doc.
    //
    // 0.7 -> 0.8 (2026-09-18) is ADR-0051 §1 (the shapes) and moves five of the counts
    // above: +1 kind (`Surface`, 52 -> 53), +3 edges (`SitsOn`, `HasSurface`, `FixedTo`,
    // 96 -> 99), +8 field keys (318-325, 317 -> 325). Scalars, enum FILE count, class
    // count and import scopes are unmoved: `PassiveNode.form`'s three new variants
    // (`shelf`, `outlet`, `board`) and `PhysicalPort.connector`'s two (`nema515r`,
    // `nema515p`) land on already-keyed, already-inline enums -- no new file, no new
    // key. The `Placeable` CLASS gained `Surface` and the noticer below still holds;
    // `PortHost` is untouched -- `Surface` hosts no ports.
    assert_eq!(tree.version.as_deref(), Some("0.8"));
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
