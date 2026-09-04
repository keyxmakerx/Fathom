//! `set security policies from-zone X to-zone Y policy NAME …` — WO's
//! Family 1 widening, 2026-08-28.
//!
//! Four things are under test and each is a way the composite-key /
//! ordinal-on-create mechanism could get quietly wrong: that a `PolicySet`
//! is keyed on the zone PAIR and stays fieldless; that each `SecurityPolicy`
//! carries the right flags; that `ordinal` reflects creation order across
//! separate statement lines rather than line number or entry order; and that
//! `match application …`, which the schema has nowhere to hold, stays
//! residue rather than being silently dropped.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::BoundValue;
use fathom_ingest::dict::Dictionary;
use fathom_ingest::frame::LineOutcome;
use fathom_ingest::{ingest, IngestOutput};
use fathom_ir::generated::ir_types::{NodeKind, PolicyAction};
use fathom_ir::scalar;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("the crate lives two levels under the repo root")
        .to_path_buf()
}

fn dict() -> Dictionary {
    Dictionary::load(&repo_root()).expect("the shipped dictionary loads")
}

fn run(text: &str) -> IngestOutput {
    ingest(text.as_bytes(), &dict()).expect("within the caps")
}

fn fixture() -> IngestOutput {
    let text = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/junos-srx-branch-documented.txt"),
    )
    .expect("the branch fixture is checked in");
    ingest(&text, &dict()).expect("within the caps")
}

/// One field's value on a specific fragment node, addressed by the
/// `Kind.field` wire name — a schema field that moves breaks the compile
/// here rather than making this test silently assert nothing.
fn field<'a>(out: &'a IngestOutput, node: usize, name: &str) -> Option<&'a BoundValue> {
    let key = fathom_ir::generated::ir_types::FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, k)| fathom_ir::bag::FieldKey(*k))?;
    out.fragment
        .nodes
        .get(node)?
        .fields
        .iter()
        .find(|f| f.key == key)
        .map(|f| &f.value)
}

fn policy_node(out: &IngestOutput, name: &str) -> usize {
    let want = BoundValue::Identifier(scalar::Identifier(name.to_owned()));
    out.fragment
        .nodes
        .iter()
        .position(|n| {
            n.kind == NodeKind::SecurityPolicy && n.fields.iter().any(|f| f.value == want)
        })
        .unwrap_or_else(|| panic!("no SecurityPolicy named {name}"))
}

/// (a) One `PolicySet` per zone PAIR, not per zone. The fixture's four
/// policies span four pairs that share zones — three source `trust`, two
/// destination `untrust` — so a single-zone key would have collapsed two or
/// three of these into one.
#[test]
fn one_fieldless_policy_set_per_zone_pair() {
    let out = fixture();
    let sets: Vec<_> = out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::PolicySet)
        .collect();
    assert_eq!(
        sets.len(),
        4,
        "trust->untrust, guests->untrust, trust->contractors, trust->vpn"
    );
    for set in &sets {
        assert!(
            set.fields.is_empty(),
            "PolicyScope is an empty struct and evaluation is not sourced this pass — \
             a PolicySet asserts nothing, same as the OPNsense precedent"
        );
    }
}

/// (b) Every policy in the fixture: correct name, both `any` flags, and
/// `permit`. The fixture carries no `deny`/`reject` and no real (non-`any`)
/// address, so this is what the four required entries can prove on their
/// own.
#[test]
fn four_policies_bind_their_matches_and_action() {
    let out = fixture();
    let policies: Vec<_> = out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::SecurityPolicy)
        .collect();
    assert_eq!(policies.len(), 4);

    for name in [
        "trust-to-untrust",
        "guests-to-untrust",
        "trust-to-contractors",
        "trust-to-vpn",
    ] {
        let n = policy_node(&out, name);
        assert_eq!(
            field(&out, n, "SecurityPolicy.match_any_source"),
            Some(&BoundValue::Bool(true)),
            "{name}: match_any_source"
        );
        assert_eq!(
            field(&out, n, "SecurityPolicy.match_any_destination"),
            Some(&BoundValue::Bool(true)),
            "{name}: match_any_destination"
        );
        assert_eq!(
            field(&out, n, "SecurityPolicy.action"),
            Some(&BoundValue::PolicyAction(PolicyAction::Permit)),
            "{name}: action"
        );
    }
}

/// (c) The fixture has exactly one policy per zone pair, so it cannot
/// exercise ordering. This synthetic snippet puts two policies under the
/// SAME pair and proves: both share the one `PolicySet` the composite key
/// produces (not two), and `ordinal` reflects creation order (0, then 1) —
/// not line-number arithmetic and not entry-iteration order, since here each
/// policy's first-seen line is its own `then permit` statement.
///
/// (`then deny` is deliberately not used for `p2`: this pass's required
/// entries cover only `then permit`, per the dictionary file's own residue
/// list, so a `then deny` line would still create the node — via the
/// bare-stanza partial match, same as any unmodelled tail — but leave
/// `action` unset. Using `permit` for both keeps this test about ordering,
/// not about a form nobody claimed to bind.)
#[test]
fn ordinal_reflects_creation_order_within_one_policy_set() {
    let out = run(
        "set security policies from-zone trust to-zone untrust policy p1 then permit\n\
         set security policies from-zone trust to-zone untrust policy p2 then permit\n",
    );
    let sets: Vec<_> = out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::PolicySet)
        .collect();
    assert_eq!(sets.len(), 1, "one zone pair, one PolicySet");

    let p1 = policy_node(&out, "p1");
    let p2 = policy_node(&out, "p2");
    assert_eq!(
        out.fragment.nodes[p1].owner, out.fragment.nodes[p2].owner,
        "both policies are children of the same PolicySet"
    );
    assert_eq!(
        field(&out, p1, "SecurityPolicy.ordinal"),
        Some(&BoundValue::U32(0))
    );
    assert_eq!(
        field(&out, p2, "SecurityPolicy.ordinal"),
        Some(&BoundValue::U32(1))
    );
    assert_eq!(
        field(&out, p1, "SecurityPolicy.action"),
        Some(&BoundValue::PolicyAction(PolicyAction::Permit))
    );
    assert_eq!(
        field(&out, p2, "SecurityPolicy.action"),
        Some(&BoundValue::PolicyAction(PolicyAction::Permit))
    );
}

/// The bare-stanza partial match still creates the node (and assigns its
/// ordinal) even when a later segment of the SAME line names a verb this
/// pass does not bind — `deny` here — because binding happens before the
/// "said more than the entry modelled" check that demotes the LINE to
/// residue. The node is real; only the unmodelled tail is residue. This is
/// the one place `ordinal_on_create` has to be exercised through a partial
/// match rather than a full one, since every required entry that reaches
/// `then` is literal on `permit`.
#[test]
fn a_partially_matched_line_still_creates_its_node_and_ordinal() {
    let out = run("set security policies from-zone trust to-zone untrust policy p1 then deny\n");
    let p1 = policy_node(&out, "p1");
    assert_eq!(
        field(&out, p1, "SecurityPolicy.ordinal"),
        Some(&BoundValue::U32(0))
    );
    assert_eq!(
        field(&out, p1, "SecurityPolicy.action"),
        None,
        "`then deny` is not a modelled form this pass — action stays unset"
    );
    assert!(
        out.residue
            .iter()
            .any(|r| matches!(r.outcome, LineOutcome::Unmapped { .. })),
        "the unmodelled `then deny` tail must still be visible on the residue list"
    );
}

/// (d) `match application …` has nowhere to bind — `SecurityPolicy` has no
/// `match_any_application` flag mirroring the source/destination pair, and a
/// real application name would need a `MatchApplication` edge this pass does
/// not build. All 9 such lines in the fixture must be named residue
/// individually, never silently dropped.
#[test]
fn match_application_lines_stay_residue() {
    let out = fixture();
    let text = out.capture.text();

    let residue_lines: Vec<String> = out
        .residue
        .iter()
        .filter(|r| matches!(r.outcome, LineOutcome::Unmapped { .. }))
        .map(|r| {
            text.get(r.span.start as usize..r.span.end as usize)
                .unwrap_or_default()
                .to_owned()
        })
        .collect();

    let expected = [
        "set security policies from-zone trust to-zone untrust policy trust-to-untrust match application any",
        "set security policies from-zone guests to-zone untrust policy guests-to-untrust match application junos-http",
        "set security policies from-zone guests to-zone untrust policy guests-to-untrust match application junos-https",
        "set security policies from-zone guests to-zone untrust policy guests-to-untrust match application junos-dns-udp",
        "set security policies from-zone guests to-zone untrust policy guests-to-untrust match application junos-ping",
        "set security policies from-zone trust to-zone contractors policy trust-to-contractors match application junos-http",
        "set security policies from-zone trust to-zone contractors policy trust-to-contractors match application junos-https",
        "set security policies from-zone trust to-zone contractors policy trust-to-contractors match application junos-ping",
        "set security policies from-zone trust to-zone vpn policy trust-to-vpn match application any",
    ];
    for line in expected {
        assert!(
            residue_lines.iter().any(|r| r == line),
            "expected on the residue list, byte-for-byte: {line}"
        );
    }
}
