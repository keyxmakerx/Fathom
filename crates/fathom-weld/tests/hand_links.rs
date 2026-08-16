//! Which edges a person may draw between two boxes, proved from the generated
//! tables rather than from the paragraph that describes them.
//!
//! `hand_link_candidates` is the one place `OP_LINK` decides what a gesture is
//! allowed to assert, and a wrong answer here writes a false fact into an
//! estate of record — the worst failure this feature has, worse than refusing.
//! ADR-0008 forbids a hand-written table, so the function scans `fathom-ir`'s
//! generated consts; these tests re-derive the same answer independently and
//! then pin the three judgements the scan cannot make for itself.

use fathom_ir::generated::ir_types::{EdgeClass, EdgeKind, NodeKind};
use fathom_weld::{containment_edge, edge_kind_named, hand_link_candidates, HAND_LINK_EXCLUDED};

/// Every REFERENCE edge kind that admits this exact pair, computed here rather
/// than read from the crate under test. Deliberately without the exclusion
/// list, so the two tests below can measure the difference the list makes.
fn admitting(from: NodeKind, to: NodeKind) -> Vec<EdgeKind> {
    EdgeKind::ALL
        .into_iter()
        .filter(|k| {
            k.class() == EdgeClass::Reference
                && k.from_kinds().contains(&from)
                && k.to_kinds().contains(&to)
        })
        .collect()
}

/// Over all 50 x 50 = 2,500 pairs: the shipped answer is the independent scan
/// minus exactly the excluded kinds, and nothing else differs.
///
/// This is the test that would catch the derivation quietly acquiring an
/// opinion — a special case for a kind somebody wanted, a filter that also
/// dropped something legal.
#[test]
fn the_candidates_are_the_reference_edges_minus_the_named_exclusions() {
    let mut pairs_with_any = 0usize;
    let mut excluded_seen = 0usize;
    for from in NodeKind::ALL {
        for to in NodeKind::ALL {
            let mut want = admitting(from, to);
            let before = want.len();
            want.retain(|k| !HAND_LINK_EXCLUDED.contains(k));
            excluded_seen += before - want.len();
            assert_eq!(
                hand_link_candidates(from, to),
                want,
                "hand_link_candidates disagrees with an independent scan on ({}, {})",
                from.name(),
                to.name()
            );
            if !want.is_empty() {
                pairs_with_any += 1;
            }
        }
    }
    // The exclusion list must be REACHED, not merely declared. A list that
    // names a kind no pair admits would pass every other assertion here while
    // protecting nothing.
    assert_eq!(
        excluded_seen,
        HAND_LINK_EXCLUDED.len(),
        "every excluded kind should be admitted by exactly one pair and removed there"
    );
    assert!(
        pairs_with_any > 0,
        "if no pair has a candidate, nothing can ever be drawn by hand"
    );
}

/// **No containment edge is ever offerable.**
///
/// Not a safety rail — a statement about what the two classes mean. A
/// containment edge declares `in: "1"`, so a node has exactly one parent, the
/// weld computes it from the kind pair alone (`containment_edge`), and a second
/// assertion of it is refused by the store's own cardinality check. A person
/// pointing at two boxes is saying "these two are related", which is what
/// `class: reference` means.
#[test]
fn containment_is_never_offered() {
    for from in NodeKind::ALL {
        for to in NodeKind::ALL {
            for k in hand_link_candidates(from, to) {
                assert_eq!(
                    k.class(),
                    EdgeClass::Reference,
                    "{} was offered between {} and {} and it is containment",
                    k.name(),
                    from.name(),
                    to.name()
                );
            }
            // And the converse, which is the interesting half: where the schema
            // DOES declare a containment edge for a pair, the hand gesture
            // still offers only references — the two lookups never overlap.
            if let Some(c) = containment_edge(from, to) {
                assert!(
                    !hand_link_candidates(from, to).contains(&c),
                    "the containment edge {} leaked into the hand candidates",
                    c.name()
                );
            }
        }
    }
}

/// **The owner's own case: two hand-added devices, and exactly one answer.**
///
/// `OP_EQUIP_ADD` builds a `Device` and a `Chassis` and nothing else, so a lab
/// drawn from an empty page is `Device`s. The schema declares exactly one
/// reference edge between two of them, which is what lets `OP_LINK` write it
/// without asking. If a second ever arrives, this test fails and somebody has
/// to decide what the two-box gesture means — which is the right time to decide
/// it, rather than after a picture has been drawn.
///
/// It is `PeersWith`, and the name is not dressed up. `11` §7.3 gives it a
/// `redundancy` field (`vpc | mlag | vrrp | other`) and the schema's own doc
/// calls it out of day-one scope, *"the edge exists so there is a home"*. It is
/// the only home the schema offers for "these two boxes are related", and the
/// page offers it under its own name. The schema's CABLE is a `Cable` node with
/// two `Terminates` edges onto `PhysicalPort`s (`19` §5.1), no opcode creates a
/// `Cable`, and that gap is named rather than papered over by calling
/// `PeersWith` a patch lead.
#[test]
fn two_devices_have_exactly_one_hand_drawn_link() {
    assert_eq!(
        hand_link_candidates(NodeKind::Device, NodeKind::Device),
        vec![EdgeKind::PeersWith],
    );
}

/// `MountedIn` is `OP_RACK_PLACE`'s, and this is the pair that would otherwise
/// reach it.
///
/// A hand-built lab has `Chassis` (every `OP_EQUIP_ADD` makes one) and `Rack`
/// (every `OP_RACK_PLACE` makes one), so `Chassis -> Rack` is reachable from
/// the gesture. Drawing it here would write a `MountedIn` with no
/// `position_u` — a `card: "1"` field this gesture carries no value for — and
/// `fathom_inventory::rack` already names that defect: an edge without one "was
/// written by something that bypassed the opcode", rendered as an overflow row,
/// visible and obviously wrong. So the pair has no hand-drawn answer at all,
/// and the page says so and points at the rack sheet.
#[test]
fn a_chassis_is_racked_by_the_rack_opcode_and_not_by_a_drawn_line() {
    assert!(
        admitting(NodeKind::Chassis, NodeKind::Rack).contains(&EdgeKind::MountedIn),
        "the schema still declares MountedIn between these two; if it does not, \
         this test is measuring nothing"
    );
    assert!(
        hand_link_candidates(NodeKind::Chassis, NodeKind::Rack).is_empty(),
        "a chassis was rackable by drawing a line, which writes a mount with no unit"
    );
}

/// The wire carries the kind's NAME and this is the round trip that makes that
/// safe. An exported journal outlives the build that wrote it, so an index into
/// `EdgeKind::ALL` would be a number whose meaning moves the next time
/// `schema/` declares an edge.
#[test]
fn every_edge_kind_reads_back_from_its_own_name() {
    for k in EdgeKind::ALL {
        assert_eq!(edge_kind_named(k.name()), Some(k));
    }
    assert_eq!(edge_kind_named("NotAnEdge"), None);
    assert_eq!(edge_kind_named(""), None);
}
