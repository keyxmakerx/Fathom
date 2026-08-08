//! The gap ledger (`13` §9.1): the emit-side residue, one entry per
//! covered-kind node whose gap field is `Set` or explicitly `Absent`. An
//! `Unknown` gap field reports nothing — nobody has said anything about it, so
//! there is nothing we failed to express.

use fathom_emit::{emit, EmitScope};
use fathom_graph::op::BatchId;
use fathom_graph::prov::{
    Actor, Confidence, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
};
use fathom_graph::{ElementId, Graph, NodeId};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{EdgeKind, IkeGatewayField, NodeKind};
use fathom_ir::value::Dpd;
use std::any::Any;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(1_700_000_000_000, n).expect("48-bit timestamp")
}

struct B {
    g: Graph,
    n: u128,
}

impl B {
    fn new() -> B {
        let mut g = Graph::new();
        g.begin_batch(BatchId(ulid(1)), "report")
            .expect("batch opens");
        B { g, n: 100 }
    }
    fn next(&mut self) -> Ulid {
        self.n += 1;
        ulid(self.n)
    }
    fn prov(&mut self) -> ProvenanceRecord {
        let id = self.next();
        ProvenanceRecord {
            id: ProvenanceId(id),
            origin: Origin::Hand,
            asserted_at: Timestamp(1_700_000_000_000),
            asserted_by: Actor::User(UserId(ulid(1))),
            confidence: Confidence::Asserted,
            supersedes: None,
        }
    }
    fn node(&mut self, kind: NodeKind) -> NodeId {
        let u = self.next();
        let p = self.prov();
        self.g.insert_node(kind, u, p).expect("node inserts")
    }
    fn edge(&mut self, kind: EdgeKind, from: NodeId, to: NodeId) {
        let u = self.next();
        let p = self.prov();
        self.g
            .insert_edge(kind, u, from, to, p)
            .expect("edge inserts");
    }
    fn set<T: Any>(&mut self, e: impl Into<ElementId>, key: FieldKey, v: T) {
        let p = self.prov();
        self.g.set_field(e.into(), key, v, p).expect("field sets");
    }
}

/// The two-node closure the gap ledger needs: a VPN and the gateway it names.
/// Every other field is left `Unknown`, so the only ledger entry a test sees
/// is the one it asserts.
fn vpn_and_gateway(b: &mut B) -> (NodeId, NodeId) {
    let vpn = b.node(NodeKind::IpsecVpn);
    let gateway = b.node(NodeKind::IkeGateway);
    b.edge(EdgeKind::UsesIkeGateway, vpn, gateway);
    (vpn, gateway)
}

#[test]
fn set_value_on_gap_field_is_reported() {
    let mut b = B::new();
    let (vpn, gateway) = vpn_and_gateway(&mut b);
    b.set(gateway, IkeGatewayField::Dpd.key(), Dpd);

    let out = emit(&b.g, EmitScope::IpsecVpn(vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.gaps.len(), 1, "{:?}", report.gaps);
    assert_eq!(report.gaps[0].node, gateway);
    assert_eq!(report.gaps[0].field, IkeGatewayField::Dpd.key());
    assert_eq!(
        report.gaps[0].tracking,
        "Dpd is an empty stub — value shape undecided; card line dead-peer-detection always-send interval 10 threshold 3 waits on it"
    );
}

#[test]
fn unknown_gap_field_reports_nothing() {
    let mut b = B::new();
    let (vpn, _) = vpn_and_gateway(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert!(report.gaps.is_empty(), "{:?}", report.gaps);
}
