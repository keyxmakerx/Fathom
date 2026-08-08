//! L0 at write time (`11` §9.1: *"The store refuses a mutation that breaks
//! L0. There is no such thing as an L0-invalid graph in memory"*).
//!
//! Every test asserts the **specific** refusal variant, not `is_err()`: the
//! ladder in `insert_edge` runs in a fixed order precisely so that error codes
//! are a function of the write and not of insertion order, and a test that
//! only checks for failure cannot see that ordering break.

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, End, Graph, NodeId, Origin, ProvenanceId,
    ProvenanceRecord, Timestamp, UserId, WriteError,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{
    DeviceField, EdgeKind, NodeKind, SiteField, TunnelInterfaceTechnology,
};
use fathom_ir::scalar::{Identifier, Text};

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

/// A graph with one batch open and a monotonic ULID supply, so tests read as
/// the graph they build rather than as id bookkeeping.
struct Fx {
    g: Graph,
    next: u128,
}

impl Fx {
    fn new() -> Fx {
        let mut g = Graph::new();
        g.begin_batch(BatchId(ulid(0)), "l0 fixture").expect("open");
        Fx { g, next: 1 }
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

    fn edge(
        &mut self,
        kind: EdgeKind,
        from: NodeId,
        to: NodeId,
    ) -> Result<fathom_graph::EdgeId, WriteError> {
        let u = self.u();
        let p = self.p();
        self.g.insert_edge(kind, u, from, to, p)
    }
}

#[test]
fn endpoint_kind_refused_names_edge_and_both_kinds() {
    let mut fx = Fx::new();
    let zone = fx.node(NodeKind::Zone);
    let device = fx.node(NodeKind::Device);
    // ZoneMember declares to: [LogicalUnit].
    let err = fx
        .edge(EdgeKind::ZoneMember, zone, device)
        .expect_err("a Device is not a LogicalUnit");
    match &err {
        WriteError::EndpointKind {
            edge,
            from,
            to,
            end,
            allowed,
        } => {
            assert_eq!(*edge, EdgeKind::ZoneMember);
            assert_eq!(*from, NodeKind::Zone);
            assert_eq!(*to, NodeKind::Device);
            assert_eq!(*end, End::To);
            assert_eq!(*allowed, [NodeKind::LogicalUnit]);
        }
        other => panic!("expected EndpointKind, got {other:?}"),
    }
    let rendered = err.to_string();
    for expected in ["ZoneMember", "Zone", "Device", "LogicalUnit"] {
        assert!(
            rendered.contains(expected),
            "the error must name `{expected}`: {rendered}"
        );
    }
}

#[test]
fn missing_endpoint_refused() {
    let mut fx = Fx::new();
    let site = fx.node(NodeKind::Site);
    let ghost = NodeId {
        kind: NodeKind::Device,
        ulid: ulid(9_999),
    };
    match fx.edge(EdgeKind::HasDevice, site, ghost) {
        Err(WriteError::MissingEndpoint { edge, end, id }) => {
            assert_eq!(edge, EdgeKind::HasDevice);
            assert_eq!(end, End::To);
            assert_eq!(id, ghost);
        }
        other => panic!("expected MissingEndpoint, got {other:?}"),
    }
    // And the from end, symmetrically.
    let unit = fx.node(NodeKind::LogicalUnit);
    match fx.edge(EdgeKind::HasDevice, ghost, unit) {
        Err(WriteError::MissingEndpoint { end: End::From, .. }) => {}
        other => panic!("expected MissingEndpoint at the from end, got {other:?}"),
    }
}

#[test]
fn out_upper_bound_refused() {
    let mut fx = Fx::new();
    // UsesIkePolicy declares out: "1".
    let gw = fx.node(NodeKind::IkeGateway);
    let pol_a = fx.node(NodeKind::IkePolicy);
    let pol_b = fx.node(NodeKind::IkePolicy);
    fx.edge(EdgeKind::UsesIkePolicy, gw, pol_a).expect("first");
    match fx.edge(EdgeKind::UsesIkePolicy, gw, pol_b) {
        Err(WriteError::OutBoundExceeded { edge, from, max }) => {
            assert_eq!(edge, EdgeKind::UsesIkePolicy);
            assert_eq!(from, gw);
            assert_eq!(max, 1);
        }
        other => panic!("expected OutBoundExceeded, got {other:?}"),
    }
}

#[test]
fn in_upper_bound_refused() {
    let mut fx = Fx::new();
    // BindsInterface declares in: "0..1" — two VPNs on one st0 unit is the
    // validity error 11 §7.3 names.
    let vpn_a = fx.node(NodeKind::IpsecVpn);
    let vpn_b = fx.node(NodeKind::IpsecVpn);
    let unit = fx.node(NodeKind::LogicalUnit);
    fx.edge(EdgeKind::BindsInterface, vpn_a, unit)
        .expect("first");
    match fx.edge(EdgeKind::BindsInterface, vpn_b, unit) {
        Err(WriteError::InBoundExceeded { edge, to, max }) => {
            assert_eq!(edge, EdgeKind::BindsInterface);
            assert_eq!(to, unit);
            assert_eq!(max, 1);
        }
        other => panic!("expected InBoundExceeded, got {other:?}"),
    }
}

#[test]
fn terminates_third_end_refused() {
    let mut fx = Fx::new();
    // Terminates declares out: "0..2" — a cable has two ends.
    let cable = fx.node(NodeKind::Cable);
    let a = fx.node(NodeKind::PhysicalPort);
    let b = fx.node(NodeKind::PhysicalPort);
    let c = fx.node(NodeKind::PhysicalPort);
    fx.edge(EdgeKind::Terminates, cable, a).expect("end A");
    fx.edge(EdgeKind::Terminates, cable, b).expect("end B");
    match fx.edge(EdgeKind::Terminates, cable, c) {
        Err(WriteError::OutBoundExceeded { edge, from, max }) => {
            assert_eq!(edge, EdgeKind::Terminates);
            assert_eq!(from, cable);
            assert_eq!(max, 2);
        }
        other => panic!("expected OutBoundExceeded, got {other:?}"),
    }
}

#[test]
fn second_containment_refused() {
    let mut fx = Fx::new();
    let site_a = fx.node(NodeKind::Site);
    let site_b = fx.node(NodeKind::Site);
    let device = fx.node(NodeKind::Device);
    let first = fx.edge(EdgeKind::HasDevice, site_a, device).expect("first");
    match fx.edge(EdgeKind::HasDevice, site_b, device) {
        Err(WriteError::SecondContainment { node, existing }) => {
            assert_eq!(node, device);
            assert_eq!(existing, first);
        }
        other => panic!("expected SecondContainment, got {other:?}"),
    }
    assert_eq!(fx.g.owner(device), Some(site_a));
}

#[test]
fn set_nesting_cycle_refused() {
    let mut fx = Fx::new();
    let a = fx.node(NodeKind::AddressSet);
    let b = fx.node(NodeKind::AddressSet);
    let c = fx.node(NodeKind::AddressSet);
    let obj = fx.node(NodeKind::AddressObject);
    fx.edge(EdgeKind::Contains, a, b).expect("a contains b");
    fx.edge(EdgeKind::Contains, b, c).expect("b contains c");
    // The legal diamond: one object in two sets. Undirected connectivity
    // would refuse this; a directed walk does not (WO-02 §12 item 1).
    fx.edge(EdgeKind::Contains, a, obj).expect("a contains obj");
    fx.edge(EdgeKind::Contains, c, obj).expect("c contains obj");
    match fx.edge(EdgeKind::Contains, c, a) {
        Err(WriteError::SetCycle { edge, from, to }) => {
            assert_eq!(edge, EdgeKind::Contains);
            assert_eq!(from, c);
            assert_eq!(to, a);
        }
        other => panic!("expected SetCycle, got {other:?}"),
    }
    // A self-loop is a one-edge cycle.
    match fx.edge(EdgeKind::Contains, a, a) {
        Err(WriteError::SetCycle { .. }) => {}
        other => panic!("expected SetCycle on the self-loop, got {other:?}"),
    }
}

#[test]
fn symmetric_normalised_then_duplicate_refused() {
    let mut fx = Fx::new();
    let x = fx.node(NodeKind::Interface);
    let y = fx.node(NodeKind::Interface);
    assert!(x < y, "the fixture mints ULIDs in order");
    // Declared the other way round; 11 §7.4 normalises on write.
    let link = fx.edge(EdgeKind::Link, y, x).expect("link");
    let stored = fx.g.edge(link).expect("stored");
    assert_eq!(stored.from, x, "the smaller NodeId becomes `from`");
    assert_eq!(stored.to, y);
    match fx.edge(EdgeKind::Link, x, y) {
        Err(WriteError::SymmetricDuplicate { edge, existing }) => {
            assert_eq!(edge, EdgeKind::Link);
            assert_eq!(existing, link);
        }
        other => panic!("expected SymmetricDuplicate, got {other:?}"),
    }
}

#[test]
fn root_containment_edge_refused() {
    let mut fx = Fx::new();
    let site = fx.node(NodeKind::Site);
    let tunnel = fx.node(NodeKind::Tunnel);
    match fx.edge(EdgeKind::HasTunnel, site, tunnel) {
        Err(WriteError::RootContainment { edge }) => assert_eq!(edge, EdgeKind::HasTunnel),
        other => panic!("expected RootContainment, got {other:?}"),
    }
    // A root-contained kind is a forest root here.
    assert_eq!(fx.g.owner(tunnel), None);
}

#[test]
fn undeclared_field_refused() {
    let mut fx = Fx::new();
    let device = fx.node(NodeKind::Device);
    let element = ElementId::Node(device);
    let key = SiteField::Name.key(); // a Site field, not a Device one
    let p = fx.p();
    match fx.g.set_field(element, key, Text("nope".to_owned()), p) {
        Err(WriteError::UndeclaredField { element: e, key: k }) => {
            assert_eq!(e, element);
            assert_eq!(k, key);
        }
        other => panic!("expected UndeclaredField, got {other:?}"),
    }
}

#[test]
fn wrong_typed_field_refused() {
    let mut fx = Fx::new();
    let device = fx.node(NodeKind::Device);
    let element = ElementId::Node(device);
    let key = DeviceField::Hostname.key(); // declared type: Identifier
    let p = fx.p();
    match fx.g.set_field(element, key, Text("srx-a-01".to_owned()), p) {
        Err(WriteError::WrongType { key: k, declared }) => {
            assert_eq!(k, key);
            assert_eq!(declared, "crate::scalar::Identifier");
        }
        other => panic!("expected WrongType, got {other:?}"),
    }
    // The declared type is accepted.
    let p = fx.p();
    fx.g.set_field(element, key, Identifier("srx-a-01".to_owned()), p)
        .expect("the declared slot type");
    // A non-scalar slot type is checked the same way.
    let st0 = fx.node(NodeKind::TunnelInterface);
    let tech = fathom_ir::generated::ir_types::TunnelInterfaceField::Technology.key();
    let p = fx.p();
    fx.g.set_field(
        ElementId::Node(st0),
        tech,
        TunnelInterfaceTechnology::IpsecVti,
        p,
    )
    .expect("generated enum slot");
}

#[test]
fn ulid_reuse_refused() {
    let mut fx = Fx::new();
    let u = fx.u();
    let p = fx.p();
    let site =
        fx.g.insert_node(NodeKind::Site, u, p)
            .expect("first use of the ULID");
    let p = fx.p();
    match fx.g.insert_node(NodeKind::Device, u, p) {
        Err(WriteError::UlidReused { ulid: reused }) => assert_eq!(reused, u),
        other => panic!("expected UlidReused, got {other:?}"),
    }
    // Edges share the ULID space: a bare `fathom_id::NodeId` reference
    // resolves by ULID alone, so it has to be unique store-wide.
    let device = fx.node(NodeKind::Device);
    let p = fx.p();
    match fx.g.insert_edge(EdgeKind::HasDevice, u, site, device, p) {
        Err(WriteError::UlidReused { ulid: reused }) => assert_eq!(reused, u),
        other => panic!("expected UlidReused on the edge, got {other:?}"),
    }
    assert_eq!(
        fx.g.resolve_ref(fathom_id::NodeId(u)),
        Some(ElementId::Node(site))
    );
}

#[test]
fn cross_pairing_uses_proposal_is_accepted_as_declared() {
    let mut fx = Fx::new();
    // 11 §7.3 has two UsesProposal rows; schema.yaml merged them, and the
    // merged from/to sets do not forbid IkePolicy -> IpsecProposal. The
    // generated tables carry the sets as declared; narrowing them is the
    // filed defect's business, not this store's (WO-02 §7 trigger 5).
    let ike_policy = fx.node(NodeKind::IkePolicy);
    let ipsec_proposal = fx.node(NodeKind::IpsecProposal);
    fx.edge(EdgeKind::UsesProposal, ike_policy, ipsec_proposal)
        .expect("accepted exactly as declared");
    assert!(EdgeKind::UsesProposal
        .to_kinds()
        .contains(&NodeKind::IpsecProposal));
    assert!(EdgeKind::UsesProposal
        .from_kinds()
        .contains(&NodeKind::IkePolicy));
}
