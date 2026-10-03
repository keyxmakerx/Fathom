//! `set security policies from-zone X to-zone Y policy NAME …` — WO's
//! Family 1 widening, 2026-08-28.
//!
//! Each is a way the composite-key / ordinal-on-create mechanism could get
//! quietly wrong: that a `PolicySet` is keyed on the zone PAIR and carries it
//! (schema 0.17, `PolicyScope::ZonePair`); that each `SecurityPolicy` carries
//! the right flags; that `ordinal` reflects creation order across separate
//! statement lines rather than line number or entry order; and that matches
//! bind to the address book and applications of the same paste.

use std::path::{Path, PathBuf};

use fathom_ingest::bind::{BoundScope, BoundValue, FragNodeId};
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

/// (a) One `PolicySet` per zone PAIR, not per zone, and each carries its pair
/// as zone nodes of the fragment. The fixture's four policies span four pairs
/// that share zones — three source `trust`, two destination `untrust` — so a
/// single-zone key would have collapsed two or three of these into one.
#[test]
fn one_policy_set_per_zone_pair_and_it_names_the_pair() {
    let out = fixture();
    let zone_name = |at: FragNodeId| -> String {
        let n = &out.fragment.nodes[at.0 as usize];
        assert_eq!(n.kind, NodeKind::Zone);
        let key = fathom_ir::generated::ir_types::FIELD_KEYS
            .iter()
            .find(|(n, _)| *n == "Zone.name")
            .map(|(_, k)| fathom_ir::bag::FieldKey(*k))
            .unwrap();
        match n.fields.iter().find(|f| f.key == key).map(|f| &f.value) {
            Some(BoundValue::Identifier(i)) => i.0.clone(),
            other => panic!("a zone without its name: {other:?}"),
        }
    };
    let mut pairs: Vec<(String, String)> = Vec::new();
    for set in out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::PolicySet)
    {
        assert_eq!(set.fields.len(), 1, "the scope and nothing else");
        match &set.fields[0].value {
            BoundValue::Scope(BoundScope::ZonePair { from, to }) => {
                pairs.push((zone_name(*from), zone_name(*to)))
            }
            other => panic!("a policy set without a zone pair: {other:?}"),
        }
    }
    pairs.sort();
    let want: Vec<(String, String)> = [
        ("guests", "untrust"),
        ("trust", "contractors"),
        ("trust", "untrust"),
        ("trust", "vpn"),
    ]
    .iter()
    .map(|(a, b)| (a.to_string(), b.to_string()))
    .collect();
    assert_eq!(pairs, want);
}

/// (b) Every policy in the fixture: correct name, both `any` flags, and
/// `permit`. The fixture carries no `deny`/`reject` and no real (non-`any`)
/// address.
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
/// ordinal) even when a later segment of the SAME line names a statement the
/// dictionary does not bind — `then log` here — because binding happens before
/// the "said more than the entry modelled" check that demotes the LINE to
/// residue. The node is real; only the unmodelled tail is residue.
#[test]
fn a_partially_matched_line_still_creates_its_node_and_ordinal() {
    let out = run(
        "set security policies from-zone trust to-zone untrust policy p1 then log session-init\n",
    );
    let p1 = policy_node(&out, "p1");
    assert_eq!(
        field(&out, p1, "SecurityPolicy.ordinal"),
        Some(&BoundValue::U32(0))
    );
    assert_eq!(
        field(&out, p1, "SecurityPolicy.action"),
        None,
        "`then log` is not bound, so the action stays unset"
    );
    assert!(
        out.residue
            .iter()
            .any(|r| matches!(r.outcome, LineOutcome::Unmapped { .. })),
        "the unmodelled tail must still be visible on the residue list"
    );
}

/// `then deny` and `then reject` bind the same field `then permit` does.
#[test]
fn deny_and_reject_bind_the_action() {
    let out = run(
        "set security policies from-zone trust to-zone untrust policy d then deny\n\
         set security policies from-zone trust to-zone untrust policy r then reject\n",
    );
    assert_eq!(
        field(&out, policy_node(&out, "d"), "SecurityPolicy.action"),
        Some(&BoundValue::PolicyAction(PolicyAction::Deny))
    );
    assert_eq!(
        field(&out, policy_node(&out, "r"), "SecurityPolicy.action"),
        Some(&BoundValue::PolicyAction(PolicyAction::Reject))
    );
}

/// (d) `match application …`: `any` sets the flag, a name makes a MatchApplication
/// edge to an `Application` of that name (one node per name, however many
/// policies list it). The fixture has nine such lines; none is residue.
#[test]
fn match_application_lines_bind() {
    let out = fixture();
    let residue_apps = out
        .residue
        .iter()
        .filter(|r| {
            let t = out.capture.text();
            t.get(r.span.start as usize..r.span.end as usize)
                .unwrap_or_default()
                .contains("match application")
        })
        .count();
    assert_eq!(residue_apps, 0);

    for any in ["trust-to-untrust", "trust-to-vpn"] {
        assert_eq!(
            field(
                &out,
                policy_node(&out, any),
                "SecurityPolicy.match_any_application"
            ),
            Some(&BoundValue::Bool(true)),
            "{any}"
        );
    }
    let apps = out
        .fragment
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Application)
        .count();
    assert_eq!(apps, 4, "junos-http, -https, -dns-udp and -ping");
    let edges = out
        .fragment
        .edges
        .iter()
        .filter(|e| e.kind == fathom_ir::generated::ir_types::EdgeKind::MatchApplication)
        .count();
    assert_eq!(
        edges, 7,
        "four on guests-to-untrust, three on trust-to-contractors"
    );
}

/// A name in `match source-address` finds the address object or the address set
/// of that name; one the paste never defines is a pending edge, not a guess.
#[test]
fn match_address_names_resolve_in_the_paste() {
    use fathom_ir::generated::ir_types::EdgeKind;
    let out = run(
        "set security address-book global address branch-lan 192.168.2.0/24\n\
         set security address-book global address-set site-nets address branch-lan\n\
         set security policies from-zone trust to-zone untrust policy a match source-address branch-lan\n\
         set security policies from-zone trust to-zone untrust policy a match destination-address site-nets\n\
         set security policies from-zone trust to-zone untrust policy a match destination-address elsewhere\n",
    );
    let kinds_of = |k: EdgeKind| -> Vec<NodeKind> {
        out.fragment
            .edges
            .iter()
            .filter(|e| e.kind == k)
            .map(|e| out.fragment.nodes[e.to.0 as usize].kind)
            .collect()
    };
    assert_eq!(
        kinds_of(EdgeKind::MatchSource),
        vec![NodeKind::AddressObject]
    );
    assert_eq!(
        kinds_of(EdgeKind::MatchDestination),
        vec![NodeKind::AddressSet]
    );
    assert_eq!(kinds_of(EdgeKind::Contains), vec![NodeKind::AddressObject]);
    assert_eq!(
        out.fragment.pending.len(),
        1,
        "`elsewhere` is defined nowhere"
    );
    let object = out
        .fragment
        .nodes
        .iter()
        .find(|n| n.kind == NodeKind::AddressObject)
        .expect("the address object");
    assert!(object.fields.iter().any(|f| matches!(
        &f.value,
        BoundValue::Address(fathom_ir::value::AddressValue::Prefix(_))
    )));
}
