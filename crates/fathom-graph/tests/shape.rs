//! The estate's shape digest (`49` §19 phase 0, item 3): what it sees, what it
//! deliberately does not, and that it is a pure function of content.
//!
//! The digest exists so a replayed `paste` can say *"this is not what you
//! saved"* out loud. Every test below is one clause of that claim:
//!
//! * it does not change when nothing about the estate changed — including when
//!   the same estate was written in a different order, which is the property
//!   `determinism.rs` proves for the walk and this proves for the digest;
//! * it moves when an identity moves, which is the failure `49` §10a names;
//! * it moves when an edge is re-pointed at equal node and edge counts, which is
//!   the case the four summary numbers in the paste reply cannot see;
//! * it does **not** move when only a field value changes, which is the schema
//!   tolerance the op log exists for and the reason this is a shape digest and
//!   not a whole-graph one.

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{DeviceField, EdgeKind, NodeKind};
use fathom_ir::scalar::Identifier;

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

fn prov(n: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(1_000_000 + n)),
        origin: Origin::Hand,
        asserted_at: Timestamp(AT),
        asserted_by: Actor::User(UserId(ulid(u128::MAX))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

fn node(g: &mut Graph, kind: NodeKind, n: u128) -> NodeId {
    g.insert_node(kind, ulid(n), prov(n)).expect("bare node")
}

fn edge(g: &mut Graph, kind: EdgeKind, from: NodeId, to: NodeId, n: u128) {
    g.insert_edge(kind, ulid(n), from, to, prov(n))
        .expect("edge");
}

/// A device with two zones and one interface — the smallest thing that has both
/// an identity set and a choice of endpoint.
///
/// `zone_of_the_interface` decides which zone the `ZoneMember` edge points at,
/// so two estates can be built with identical counts and one different endpoint.
fn estate(iface_ulid: u128, zone_of_the_interface: u128) -> Graph {
    let mut g = Graph::new();
    g.begin_batch(BatchId(ulid(0)), "shape").expect("open");

    let device = node(&mut g, NodeKind::Device, 2);
    let reth = node(&mut g, NodeKind::RethInterface, iface_ulid);
    let unit = node(&mut g, NodeKind::LogicalUnit, 4);
    let zone_a = node(&mut g, NodeKind::Zone, 7);
    let zone_b = node(&mut g, NodeKind::Zone, 8);

    edge(&mut g, EdgeKind::HasInterface, device, reth, 21);
    edge(&mut g, EdgeKind::HasUnit, reth, unit, 22);
    edge(&mut g, EdgeKind::HasZone, device, zone_a, 25);
    edge(&mut g, EdgeKind::HasZone, device, zone_b, 26);
    let zone = if zone_of_the_interface == 7 {
        zone_a
    } else {
        zone_b
    };
    edge(&mut g, EdgeKind::ZoneMember, zone, unit, 27);

    g.end_batch().expect("close");
    g
}

#[test]
fn an_empty_estate_digests_to_zero() {
    // The combiner starts at zero and nothing is added. Pinned because the page
    // treats the value as opaque and must never special-case "nothing held":
    // an empty estate has a shape, and its shape is the empty one.
    assert_eq!(fathom_graph::shape_hex(&Graph::new()), "0000000000000000");
}

#[test]
fn the_hex_is_sixteen_lowercase_characters() {
    let hex = fathom_graph::shape_hex(&estate(3, 7));
    assert_eq!(hex.len(), 16);
    assert!(hex
        .chars()
        .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
}

#[test]
fn the_same_estate_digests_the_same() {
    assert_eq!(
        fathom_graph::shape_hex(&estate(3, 7)),
        fathom_graph::shape_hex(&estate(3, 7))
    );
}

#[test]
fn the_write_order_does_not_change_it() {
    // `determinism.rs` proves the store's WALK is a pure function of content.
    // This proves the digest is too — which is a separate claim, because the
    // combiner is commutative precisely so that it does not inherit the walk's
    // dependence on kind declaration order (see `shape.rs`'s own doc).
    let mut a = Graph::new();
    a.begin_batch(BatchId(ulid(0)), "nodes then edges")
        .expect("open");
    let device = node(&mut a, NodeKind::Device, 2);
    let zone = node(&mut a, NodeKind::Zone, 7);
    edge(&mut a, EdgeKind::HasZone, device, zone, 25);
    a.end_batch().expect("close");

    let mut b = Graph::new();
    b.begin_batch(BatchId(ulid(0)), "zone first").expect("open");
    let zone = node(&mut b, NodeKind::Zone, 7);
    let device = node(&mut b, NodeKind::Device, 2);
    edge(&mut b, EdgeKind::HasZone, device, zone, 25);
    b.end_batch().expect("close");

    assert_eq!(fathom_graph::shape_hex(&a), fathom_graph::shape_hex(&b));
}

#[test]
fn one_moved_identity_moves_the_digest() {
    // The defect, in miniature. A parser that mints one extra node shifts every
    // ULID after it, so a hand-drawn link recorded against the old id names
    // nothing. The digest is what lets the page say so.
    assert_ne!(
        fathom_graph::shape_hex(&estate(3, 7)),
        fathom_graph::shape_hex(&estate(99, 7))
    );
}

#[test]
fn a_re_pointed_edge_moves_the_digest_at_equal_counts() {
    // Same nodes, same edges, one edge pointing at the other zone. Node and edge
    // COUNTS are identical, so the paste reply's four summary numbers cannot
    // tell these two estates apart and the digest is why the check is a digest.
    let a = estate(3, 7);
    let b = estate(3, 8);
    assert_eq!(a.nodes().count(), b.nodes().count());
    assert_eq!(a.edges().count(), b.edges().count());
    assert_ne!(fathom_graph::shape_hex(&a), fathom_graph::shape_hex(&b));
}

#[test]
fn a_tombstone_moves_the_digest() {
    // A removed element is still in the store (`11` §10.5). "Present" and
    // "tombstoned" are different estates and the operator can see the
    // difference, so the digest has to.
    let base = estate(3, 7);
    let mut gone = estate(3, 7);
    gone.begin_batch(BatchId(ulid(1)), "remove").expect("open");
    gone.tombstone(
        ElementId::Node(NodeId {
            kind: NodeKind::Zone,
            ulid: ulid(8),
        }),
        Timestamp(AT + 1_000),
    )
    .expect("tombstone");
    gone.end_batch().expect("close");
    assert_ne!(
        fathom_graph::shape_hex(&base),
        fathom_graph::shape_hex(&gone)
    );
}

#[test]
fn a_field_value_does_not_move_the_digest() {
    // THE DELIBERATE BLIND SPOT, pinned so nobody closes it by accident.
    //
    // A digest that covered field values would fire on every schema change the
    // op log is designed to survive — a new field on an unrelated kind, a
    // changed default, a scalar that gains a spelling — and a warning that fires
    // monthly is a warning nobody reads. The cost is stated in `shape.rs`'s doc:
    // a dictionary improvement that only fills in a field on a node that already
    // existed is invisible here. The page compares the paste's residue count
    // alongside the digest, and a newly-bound line always leaves the residue
    // list, so that case is caught one level up rather than here.
    let base = estate(3, 7);
    let mut named = estate(3, 7);
    named
        .begin_batch(BatchId(ulid(2)), "hostname")
        .expect("open");
    named
        .set_field(
            ElementId::Node(NodeId {
                kind: NodeKind::Device,
                ulid: ulid(2),
            }),
            DeviceField::Hostname.key(),
            Identifier("branch-srx".to_owned()),
            prov(500),
        )
        .expect("hostname");
    named.end_batch().expect("close");

    assert_eq!(
        fathom_graph::shape_hex(&base),
        fathom_graph::shape_hex(&named)
    );
}
