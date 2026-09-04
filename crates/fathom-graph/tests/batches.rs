//! Batches, the op log, and tombstones.
//!
//! `76` §7.2's S3 row asks for *"ops and undo batches"*: every mutation lands
//! in the batch the caller has open, and no mutation escapes the log. The
//! batch boundary is the caller's to draw — the store cannot know what "one
//! user intention" is (`53` §7.2).

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Op, Origin, ProvenanceId,
    ProvenanceRecord, StoredPresence, Timestamp, UserId, WriteError,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{DeviceField, EdgeKind, NodeKind};
use fathom_ir::scalar::Identifier;

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

struct Fx {
    g: Graph,
    next: u128,
}

impl Fx {
    /// No batch open: tests that need one open it themselves, because half of
    /// these tests are about the batch discipline itself.
    fn bare() -> Fx {
        Fx {
            g: Graph::new(),
            next: 1,
        }
    }

    fn open() -> Fx {
        let mut fx = Fx::bare();
        fx.g.begin_batch(BatchId(ulid(0)), "dh-group on IKE-P1")
            .expect("open");
        fx
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
}

#[test]
fn write_outside_batch_refused() {
    let mut fx = Fx::bare();
    let u = fx.u();
    let p = fx.p();
    match fx.g.insert_node(NodeKind::Site, u, p) {
        Err(WriteError::NoOpenBatch) => {}
        other => panic!("expected NoOpenBatch, got {other:?}"),
    }
    // And after the batch closes again.
    fx.g.begin_batch(BatchId(ulid(0)), "first").expect("open");
    let site = fx.node(NodeKind::Site);
    fx.g.end_batch().expect("close");
    let p = fx.p();
    match fx.g.set_field(
        ElementId::Node(site),
        fathom_ir::generated::ir_types::SiteField::Name.key(),
        fathom_ir::scalar::Text("Site A".to_owned()),
        p,
    ) {
        Err(WriteError::NoOpenBatch) => {}
        other => panic!("expected NoOpenBatch, got {other:?}"),
    }
    match fx.g.tombstone(
        ElementId::Node(site),
        Timestamp(AT),
        fathom_graph::Actor::User(fathom_graph::UserId::LOCAL),
    ) {
        Err(WriteError::NoOpenBatch) => {}
        other => panic!("expected NoOpenBatch, got {other:?}"),
    }
    match fx.g.end_batch() {
        Err(WriteError::NoOpenBatch) => {}
        other => panic!("expected NoOpenBatch, got {other:?}"),
    }
}

#[test]
fn nested_begin_refused() {
    let mut fx = Fx::open();
    match fx.g.begin_batch(BatchId(ulid(77)), "second") {
        Err(WriteError::BatchAlreadyOpen { open }) => assert_eq!(open, BatchId(ulid(0))),
        other => panic!("expected BatchAlreadyOpen, got {other:?}"),
    }
}

#[test]
fn label_over_sixty_bytes_refused() {
    let mut fx = Fx::bare();
    let sixty = "x".repeat(60);
    fx.g.begin_batch(BatchId(ulid(1)), &sixty)
        .expect("60 bytes is the bound, not one past it");
    fx.g.end_batch().expect("close");
    let sixty_one = "x".repeat(61);
    match fx.g.begin_batch(BatchId(ulid(2)), &sixty_one) {
        Err(WriteError::LabelTooLong { len }) => assert_eq!(len, 61),
        other => panic!("expected LabelTooLong, got {other:?}"),
    }
    // Bytes, not characters: 53 §7.2's bound is BoundedText<60>.
    let twenty_one_stars = "★".repeat(21); // 63 bytes
    match fx.g.begin_batch(BatchId(ulid(3)), &twenty_one_stars) {
        Err(WriteError::LabelTooLong { len }) => assert_eq!(len, 63),
        other => panic!("expected LabelTooLong, got {other:?}"),
    }
}

#[test]
fn batch_id_reuse_refused() {
    let mut fx = Fx::bare();
    fx.g.begin_batch(BatchId(ulid(1)), "first").expect("open");
    fx.g.end_batch().expect("close");
    match fx.g.begin_batch(BatchId(ulid(1)), "again") {
        Err(WriteError::BatchIdReused { id }) => assert_eq!(id, BatchId(ulid(1))),
        other => panic!("expected BatchIdReused, got {other:?}"),
    }
}

#[test]
fn ops_land_in_open_batch_in_order() {
    let mut fx = Fx::open();
    let site = fx.node(NodeKind::Site);
    let device = fx.node(NodeKind::Device);
    let has = fx.edge(EdgeKind::HasDevice, site, device);
    let p = fx.p();
    fx.g.set_field(
        ElementId::Node(device),
        DeviceField::Hostname.key(),
        Identifier("srx-a-01".to_owned()),
        p,
    )
    .expect("set");
    let id = fx.g.end_batch().expect("close");

    assert_eq!(fx.g.log().len(), 1);
    let batch = &fx.g.log()[0];
    assert_eq!(batch.id, id);
    assert_eq!(batch.label, "dh-group on IKE-P1");
    assert_eq!(batch.ops.len(), 4, "one op per mutation, nothing else");
    match &batch.ops[0] {
        Op::AddNode { node, .. } => assert_eq!(*node, site),
        other => panic!("expected AddNode, got {other:?}"),
    }
    match &batch.ops[1] {
        Op::AddNode { node, .. } => assert_eq!(*node, device),
        other => panic!("expected AddNode, got {other:?}"),
    }
    match &batch.ops[2] {
        Op::AddEdge { edge, from, to, .. } => {
            assert_eq!(*edge, has);
            assert_eq!(*from, site);
            assert_eq!(*to, device);
        }
        other => panic!("expected AddEdge, got {other:?}"),
    }
    match &batch.ops[3] {
        Op::SetField {
            element, presence, ..
        } => {
            assert_eq!(*element, ElementId::Node(device));
            assert_eq!(*presence, StoredPresence::Set);
        }
        other => panic!("expected SetField, got {other:?}"),
    }
}

#[test]
fn tombstone_cascades_containment_subtree() {
    let mut fx = Fx::open();
    let site = fx.node(NodeKind::Site);
    let device = fx.node(NodeKind::Device);
    let reth = fx.node(NodeKind::RethInterface);
    let unit = fx.node(NodeKind::LogicalUnit);
    let address = fx.node(NodeKind::Address);
    let other_site_device = fx.node(NodeKind::Device);
    fx.edge(EdgeKind::HasDevice, site, device);
    fx.edge(EdgeKind::HasDevice, site, other_site_device);
    fx.edge(EdgeKind::HasInterface, device, reth);
    fx.edge(EdgeKind::HasUnit, reth, unit);
    fx.edge(EdgeKind::HasAddress, unit, address);
    assert_eq!(fx.g.device_of(unit), Some(device));
    assert_eq!(fx.g.owner(unit), Some(reth));
    fx.g.end_batch().expect("close the build batch");

    fx.g.begin_batch(BatchId(ulid(500)), "delete srx-a-01")
        .expect("open");
    fx.g.tombstone(
        ElementId::Node(device),
        Timestamp(AT + 1),
        fathom_graph::Actor::User(fathom_graph::UserId::LOCAL),
    )
    .expect("tombstone");
    fx.g.end_batch().expect("close");

    // 11 §3.4: deleting the owner deletes the target — applied to the
    // absence-marking removal that exists at this stage.
    for n in [device, reth, unit, address] {
        assert_eq!(
            fx.g.node(n).expect("still stored").absent_since,
            Some(Timestamp(AT + 1)),
            "{n} is in the subtree"
        );
    }
    assert_eq!(fx.g.node(site).expect("stored").absent_since, None);
    assert_eq!(
        fx.g.node(other_site_device).expect("stored").absent_since,
        None,
        "a sibling is not in the subtree"
    );

    let ops = &fx.g.log()[1].ops;
    assert_eq!(ops.len(), 4, "one op per tombstoned element");
    let mut tombstoned: Vec<NodeId> = Vec::new();
    for op in ops {
        match op {
            Op::Tombstone {
                element: ElementId::Node(n),
                by: _,
                at,
            } => {
                assert_eq!(*at, Timestamp(AT + 1));
                tombstoned.push(*n);
            }
            other => panic!("expected a node Tombstone, got {other:?}"),
        }
    }
    let mut sorted = tombstoned.clone();
    sorted.sort_unstable();
    assert_eq!(tombstoned, sorted, "emitted in NodeId order");

    // Idempotence is not silent.
    fx.g.begin_batch(BatchId(ulid(501)), "again").expect("open");
    match fx.g.tombstone(
        ElementId::Node(device),
        Timestamp(AT + 2),
        fathom_graph::Actor::User(fathom_graph::UserId::LOCAL),
    ) {
        Err(WriteError::AlreadyTombstoned { element }) => {
            assert_eq!(element, ElementId::Node(device));
        }
        other => panic!("expected AlreadyTombstoned, got {other:?}"),
    }
}

#[test]
fn tombstoned_edges_leave_cardinality_counts() {
    let mut fx = Fx::open();
    // BindsInterface declares in: "0..1". Rebinding a tunnel unit to another
    // VPN has to be possible without `Purge`, which does not exist here.
    let vpn_a = fx.node(NodeKind::IpsecVpn);
    let vpn_b = fx.node(NodeKind::IpsecVpn);
    let unit = fx.node(NodeKind::LogicalUnit);
    let first = fx.edge(EdgeKind::BindsInterface, vpn_a, unit);

    let u = fx.u();
    let p = fx.p();
    match fx
        .g
        .insert_edge(EdgeKind::BindsInterface, u, vpn_b, unit, p)
    {
        Err(WriteError::InBoundExceeded { .. }) => {}
        other => panic!("expected InBoundExceeded while the first is live, got {other:?}"),
    }

    fx.g.tombstone(
        ElementId::Edge(first),
        Timestamp(AT + 1),
        fathom_graph::Actor::User(fathom_graph::UserId::LOCAL),
    )
    .expect("tombstone the binding");
    let replacement = fx.edge(EdgeKind::BindsInterface, vpn_b, unit);
    assert_eq!(
        fx.g.edge(replacement).expect("stored").from,
        vpn_b,
        "tombstone-then-replace works"
    );
    assert_eq!(
        fx.g.edge(first).expect("still stored").absent_since,
        Some(Timestamp(AT + 1)),
        "the tombstoned edge is kept, not deleted"
    );
    // Both are still in the adjacency; effectiveness is what counting reads.
    assert_eq!(fx.g.inn(unit, EdgeKind::BindsInterface).count(), 2);

    // A tombstoned endpoint has the same effect as a tombstoned edge.
    let vpn_c = fx.node(NodeKind::IpsecVpn);
    fx.g.tombstone(
        ElementId::Node(vpn_b),
        Timestamp(AT + 2),
        fathom_graph::Actor::User(fathom_graph::UserId::LOCAL),
    )
    .expect("tombstone the VPN");
    fx.edge(EdgeKind::BindsInterface, vpn_c, unit);
}
