//! The one rack state no door can produce, and the guard that answers it.
//!
//! `Rack.unit_numbering` is `card: "1"` with no default because ADR-0036 could
//! not establish a universal convention for which end of a frame is U1: three
//! sources, all primary, all dated, and they disagree. An elevation drawn the
//! wrong way up is wrong in every position while looking entirely plausible, so
//! a direction is never assumed.
//!
//! `62` §7 rule 2 then requires a generated `Unknown(token)` arm on every enum,
//! which is what makes a new spelling a MINOR bump an older build survives. So a
//! rack whose numbering this build cannot read is a state the type system says
//! is reachable and no input today produces: `parse_into_slot` refuses the
//! unknown token, `OP_RACK_PLACE` demands the field before touching the store,
//! and importing a journal replays through the same door.
//!
//! **That is exactly why it needs a test rather than a comment.** The first
//! version of `elevation()` matched `_ => true` on that arm — an unreadable
//! token came out as "ascending" — and carried a comment asserting that the
//! page refused such a picture. The page did not; it printed
//! *"U1 at the bottom (<token>)"* and drew the frame ascending, which is the
//! precise guess the whole no-default design exists to prevent. The claim was
//! written in two places and implemented in none.
//!
//! This builds that rack directly through the store, which is the only way to
//! build it, and asserts that the direction comes back as **no direction**.

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{NodeKind, RackUnitNumbering};
use fathom_ir::scalar;

const TS0: u64 = 1_785_456_000_000;

fn ulid(k: u128) -> Ulid {
    Ulid::from_parts(TS0, k).expect("TS0 fits 48 bits")
}

fn prov() -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(1)),
        origin: Origin::Hand,
        asserted_at: Timestamp(TS0),
        asserted_by: Actor::User(UserId(ulid(0))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

/// One rack, with whatever numbering the caller hands in.
fn rack_with(numbering: RackUnitNumbering) -> (Graph, NodeId) {
    let mut g = Graph::new();
    g.begin_batch(BatchId(ulid(2)), "a rack for one test")
        .expect("a fresh graph takes a batch");
    let r = g
        .insert_node(NodeKind::Rack, ulid(3), prov())
        .expect("a Rack is a declared kind");
    // The registry, by declared name — the same lookup `render::key` does, which
    // is `pub(crate)`. No integer is hand-copied: a renamed field panics here
    // rather than silently writing a different slot (ADR-0008).
    let key = |n: &str| {
        let (_, k) = fathom_ir::generated::ir_types::FIELD_KEYS
            .iter()
            .find(|(name, _)| *name == n)
            .unwrap_or_else(|| panic!("`{n}` is not a declared field"));
        fathom_ir::bag::FieldKey(*k)
    };
    g.set_field(
        ElementId::Node(r),
        key("Rack.label"),
        scalar::Text("R1".to_owned()),
        prov(),
    )
    .expect("label is Text");
    g.set_field(ElementId::Node(r), key("Rack.height_u"), 10u8, prov())
        .expect("height_u is u8");
    g.set_field(
        ElementId::Node(r),
        key("Rack.unit_numbering"),
        numbering,
        prov(),
    )
    .expect("unit_numbering takes its own enum");
    g.end_batch().expect("the batch closes");
    (g, r)
}

/// The two declared spellings answer with a direction, so the test below is
/// about the third case and not about the field being wired up at all.
#[test]
fn the_two_declared_spellings_answer_with_a_direction() {
    for (token, want) in [
        (RackUnitNumbering::Ascending, Some(true)),
        (RackUnitNumbering::Descending, Some(false)),
    ] {
        let (g, r) = rack_with(token);
        let e = fathom_inventory::elevation(&g, r).expect("a rack has an elevation");
        assert_eq!(e.ascending, want);
    }
}

/// THE GUARD. A token from a newer schema is carried, printed, and answered
/// with NO DIRECTION — not with the more common one, not with the first one
/// declared, not with `true`.
#[test]
fn a_numbering_token_this_build_cannot_read_yields_no_direction() {
    let (g, r) = rack_with(RackUnitNumbering::Unknown("from-the-hinge-side".to_owned()));
    let e = fathom_inventory::elevation(&g, r).expect("a rack still has an elevation");

    assert_eq!(
        e.ascending, None,
        "an unreadable token must not resolve to a direction; `_ => true` here is \
         what drew a frame upside down and called it ascending"
    );
    // The token is CARRIED, not swallowed: the page prints what it could not
    // read, so a reader can tell "Fathom does not know this word" from "Fathom
    // has no rack".
    assert_eq!(e.numbering, "from-the-hinge-side");
    // And the rest of the frame is intact. Refusing the direction is not
    // refusing the rack: everything else about it is still true and still said.
    assert_eq!(e.height_u, 10);
    assert_eq!(e.label, "R1");
}
