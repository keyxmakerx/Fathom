//! The fifth op (ADR-0053 §1): `Graph::revive` clears a tombstone, and for an
//! edge re-runs the containment ladder verbatim so a revive lands only when
//! nothing has taken the slot since.

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Op, Origin, ProvenanceId,
    ProvenanceRecord, Timestamp, UserId, WriteError,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

struct Fx {
    g: Graph,
    next: u128,
}

impl Fx {
    fn bare() -> Fx {
        Fx {
            g: Graph::new(),
            next: 1,
        }
    }

    fn open(&mut self, n: u128, label: &str) {
        self.g.begin_batch(BatchId(ulid(n)), label).expect("open");
    }

    fn u(&mut self) -> Ulid {
        let u = ulid(self.next);
        self.next += 1;
        u
    }

    fn p(&mut self) -> ProvenanceRecord {
        let n = self.next;
        self.next += 1;
        ProvenanceRecord {
            id: ProvenanceId(ulid(1_000_000 + n)),
            origin: Origin::Hand,
            asserted_at: Timestamp(AT),
            asserted_by: Actor::User(UserId(ulid(u128::MAX))),
            confidence: Confidence::Asserted,
            supersedes: None,
        }
    }

    fn node(&mut self, kind: NodeKind) -> NodeId {
        let u = self.u();
        let p = self.p();
        self.g.insert_node(kind, u, p).expect("bare node")
    }

    fn edge(&mut self, kind: EdgeKind, from: NodeId, to: NodeId) -> fathom_graph::EdgeId {
        let u = self.u();
        let p = self.p();
        self.g.insert_edge(kind, u, from, to, p).expect("edge")
    }

    fn actor() -> Actor {
        Actor::User(UserId::LOCAL)
    }
}

#[test]
fn revive_a_node() {
    let mut fx = Fx::bare();
    fx.open(0, "build");
    let site = fx.node(NodeKind::Site);
    let device = fx.node(NodeKind::Device);
    fx.edge(EdgeKind::HasDevice, site, device);
    fx.g.end_batch().expect("close");

    fx.open(1, "remove device");
    fx.g.tombstone(ElementId::Node(device), Timestamp(AT + 1), Fx::actor())
        .expect("tombstone");
    fx.g.end_batch().expect("close");

    fx.open(2, "undo of remove device");
    fx.g.revive(ElementId::Node(device), Timestamp(AT + 2), Fx::actor())
        .expect("revive");
    let id = fx.g.end_batch().expect("close");

    assert_eq!(fx.g.node(device).expect("still stored").absent_since, None);
    let batch = fx.g.log().iter().find(|b| b.id == id).expect("logged");
    match batch.ops.as_slice() {
        [Op::Revive { element, at, .. }] => {
            assert_eq!(*element, ElementId::Node(device));
            assert_eq!(*at, Timestamp(AT + 2));
        }
        other => panic!("expected one Revive op, got {other:?}"),
    }
}

#[test]
fn revive_an_edge_whose_owner_still_stands() {
    let mut fx = Fx::bare();
    fx.open(0, "build");
    let site = fx.node(NodeKind::Site);
    let device = fx.node(NodeKind::Device);
    let has = fx.edge(EdgeKind::HasDevice, site, device);
    fx.g.end_batch().expect("close");

    fx.open(1, "cut the edge");
    fx.g.tombstone(ElementId::Edge(has), Timestamp(AT + 1), Fx::actor())
        .expect("tombstone");
    fx.g.end_batch().expect("close");

    // Nothing replaced it: both endpoints still stand and nothing else
    // claimed the device's one containment slot, so the same edge, freshly
    // checked, is legal again.
    fx.open(2, "undo of cut the edge");
    fx.g.revive(ElementId::Edge(has), Timestamp(AT + 2), Fx::actor())
        .expect("revive");
    fx.g.end_batch().expect("close");

    assert_eq!(fx.g.edge(has).expect("still stored").absent_since, None);
    assert_eq!(
        fx.g.owner(device),
        Some(site),
        "the containment reads live again"
    );
}

#[test]
fn refuse_reviving_a_live_element() {
    let mut fx = Fx::bare();
    fx.open(0, "build");
    let site = fx.node(NodeKind::Site);
    let device = fx.node(NodeKind::Device);
    let has = fx.edge(EdgeKind::HasDevice, site, device);
    fx.g.end_batch().expect("close");

    fx.open(1, "revive attempt");
    match fx
        .g
        .revive(ElementId::Node(device), Timestamp(AT + 1), Fx::actor())
    {
        Err(WriteError::NotTombstoned { element }) => {
            assert_eq!(element, ElementId::Node(device));
        }
        other => panic!("expected NotTombstoned, got {other:?}"),
    }
    match fx
        .g
        .revive(ElementId::Edge(has), Timestamp(AT + 1), Fx::actor())
    {
        Err(WriteError::NotTombstoned { element }) => {
            assert_eq!(element, ElementId::Edge(has));
        }
        other => panic!("expected NotTombstoned, got {other:?}"),
    }
}

#[test]
fn refuse_reviving_an_edge_whose_slot_was_refilled() {
    let mut fx = Fx::bare();
    fx.open(0, "build");
    // `BindsInterface` declares `in: "0..1"` (see `tests/batches.rs`'s own
    // use of this shape): a tunnel unit takes at most one binding, which is
    // exactly the cardinality a revive can be refused by.
    let vpn_a = fx.node(NodeKind::IpsecVpn);
    let vpn_b = fx.node(NodeKind::IpsecVpn);
    let unit = fx.node(NodeKind::LogicalUnit);
    let first = fx.edge(EdgeKind::BindsInterface, vpn_a, unit);
    fx.g.end_batch().expect("close");

    fx.open(1, "rebind");
    fx.g.tombstone(ElementId::Edge(first), Timestamp(AT + 1), Fx::actor())
        .expect("tombstone the first binding");
    fx.g.end_batch().expect("close");

    fx.open(2, "bind the replacement");
    fx.edge(EdgeKind::BindsInterface, vpn_b, unit);
    fx.g.end_batch().expect("close");

    // The slot is taken: reviving the first binding would put the unit at
    // two live `BindsInterface` edges, over the declared bound of one.
    fx.open(3, "undo of rebind");
    match fx
        .g
        .revive(ElementId::Edge(first), Timestamp(AT + 3), Fx::actor())
    {
        Err(WriteError::InBoundExceeded { to, max, .. }) => {
            assert_eq!(to, unit);
            assert_eq!(max, 1);
        }
        other => panic!("expected InBoundExceeded, got {other:?}"),
    }
}
