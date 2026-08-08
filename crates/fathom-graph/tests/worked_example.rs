//! `11` §15's side-1 slice, reduced to what this store can hold.
//!
//! One `Site`, one `Device` (`srx-a-01`, `junos-srx`), the WAN reth and its
//! unit, the tunnel interface and its unit, the two zones of `11` §15.6 with
//! their `ZoneMember` bindings, and the six-object crypto chain the field
//! card calls *"six named objects, each referencing the one before it by
//! name"*. Every reference in that chain is a traversal here, which is the
//! whole reason the schema is shaped this way.
//!
//! Piece #2 and piece #3 are the point of the two `ZoneMember` edges: `ike`
//! belongs on the WAN-facing binding (`11` §15.6), and the VPN-side binding's
//! host-inbound set is asserted `Absent` — the state that makes
//! `zone.host-inbound.ike-missing` trustworthy rather than noisy.

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    StoredPresence, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{
    DeviceField, EdgeKind, HostService, IkeGatewayField, IkePolicyField, IkeProposalField,
    IpsecPolicyField, IpsecProposalField, IpsecVpnField, LogicalUnitField, NodeKind,
    RethInterfaceField, SiteField, TunnelInterfaceField, TunnelInterfaceTechnology,
    UsesProposalField, ZoneField, ZoneMemberField,
};
use fathom_ir::scalar::{Identifier, InterfaceName, PlatformId, Text};
use std::collections::BTreeSet;

const AT: u64 = 1_700_000_000_000;

/// Field writes the builder makes. Kept as a constant so the op-count
/// assertion states the mutation count rather than restating the log.
const FIELD_WRITES: usize = 20;

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

struct Side1 {
    g: Graph,
    site: NodeId,
    device: NodeId,
    reth: NodeId,
    reth_unit: NodeId,
    st0: NodeId,
    st0_unit: NodeId,
    zone_vpn: NodeId,
    zone_wan: NodeId,
    ike_proposal: NodeId,
    ike_policy: NodeId,
    ike_gateway: NodeId,
    ipsec_proposal: NodeId,
    ipsec_policy: NodeId,
    ipsec_vpn: NodeId,
    member_vpn: fathom_graph::EdgeId,
    member_wan: fathom_graph::EdgeId,
}

fn build() -> Side1 {
    let mut g = Graph::new();
    g.begin_batch(BatchId(ulid(0)), "paste srx-a-01")
        .expect("open");

    let node = |g: &mut Graph, kind: NodeKind, n: u128| {
        g.insert_node(kind, ulid(n), prov(n)).expect("bare node")
    };
    let site = node(&mut g, NodeKind::Site, 1);
    let device = node(&mut g, NodeKind::Device, 2);
    let reth = node(&mut g, NodeKind::RethInterface, 3);
    let reth_unit = node(&mut g, NodeKind::LogicalUnit, 4);
    let st0 = node(&mut g, NodeKind::TunnelInterface, 5);
    let st0_unit = node(&mut g, NodeKind::LogicalUnit, 6);
    let zone_vpn = node(&mut g, NodeKind::Zone, 7);
    let zone_wan = node(&mut g, NodeKind::Zone, 8);
    let ike_proposal = node(&mut g, NodeKind::IkeProposal, 9);
    let ike_policy = node(&mut g, NodeKind::IkePolicy, 10);
    let ike_gateway = node(&mut g, NodeKind::IkeGateway, 11);
    let ipsec_proposal = node(&mut g, NodeKind::IpsecProposal, 12);
    let ipsec_policy = node(&mut g, NodeKind::IpsecPolicy, 13);
    let ipsec_vpn = node(&mut g, NodeKind::IpsecVpn, 14);

    let edge = |g: &mut Graph, kind: EdgeKind, from: NodeId, to: NodeId, n: u128| {
        g.insert_edge(kind, ulid(n), from, to, prov(n))
            .expect("edge")
    };
    edge(&mut g, EdgeKind::HasDevice, site, device, 20);
    edge(&mut g, EdgeKind::HasInterface, device, reth, 21);
    edge(&mut g, EdgeKind::HasUnit, reth, reth_unit, 22);
    edge(&mut g, EdgeKind::HasInterface, device, st0, 23);
    edge(&mut g, EdgeKind::HasUnit, st0, st0_unit, 24);
    edge(&mut g, EdgeKind::HasZone, device, zone_vpn, 25);
    edge(&mut g, EdgeKind::HasZone, device, zone_wan, 26);
    let member_vpn = edge(&mut g, EdgeKind::ZoneMember, zone_vpn, st0_unit, 27);
    let member_wan = edge(&mut g, EdgeKind::ZoneMember, zone_wan, reth_unit, 28);
    edge(&mut g, EdgeKind::HasIkeProposal, device, ike_proposal, 29);
    edge(&mut g, EdgeKind::HasIkePolicy, device, ike_policy, 30);
    edge(&mut g, EdgeKind::HasIkeGateway, device, ike_gateway, 31);
    edge(
        &mut g,
        EdgeKind::HasIpsecProposal,
        device,
        ipsec_proposal,
        32,
    );
    edge(&mut g, EdgeKind::HasIpsecPolicy, device, ipsec_policy, 33);
    edge(&mut g, EdgeKind::HasIpsecVpn, device, ipsec_vpn, 34);
    let uses_ike_proposal = edge(&mut g, EdgeKind::UsesProposal, ike_policy, ike_proposal, 35);
    edge(&mut g, EdgeKind::UsesIkePolicy, ike_gateway, ike_policy, 36);
    edge(
        &mut g,
        EdgeKind::ExternalInterface,
        ike_gateway,
        reth_unit,
        37,
    );
    edge(&mut g, EdgeKind::UsesIkeGateway, ipsec_vpn, ike_gateway, 38);
    let uses_ipsec_proposal = edge(
        &mut g,
        EdgeKind::UsesProposal,
        ipsec_policy,
        ipsec_proposal,
        39,
    );
    edge(
        &mut g,
        EdgeKind::UsesIpsecPolicy,
        ipsec_vpn,
        ipsec_policy,
        40,
    );
    edge(&mut g, EdgeKind::BindsInterface, ipsec_vpn, st0_unit, 41);

    // 11 §15.2, §15.3, §15.4, §15.5 — the fields this slice carries.
    g.set_field(
        ElementId::Node(site),
        SiteField::Name.key(),
        Text("Site A".to_owned()),
        prov(100),
    )
    .expect("Site.name");
    g.set_field(
        ElementId::Node(device),
        DeviceField::Hostname.key(),
        Identifier("srx-a-01".to_owned()),
        prov(101),
    )
    .expect("Device.hostname");
    g.set_field(
        ElementId::Node(device),
        DeviceField::Platform.key(),
        PlatformId("junos-srx".to_owned()),
        prov(102),
    )
    .expect("Device.platform");
    g.set_field(
        ElementId::Node(reth),
        RethInterfaceField::Name.key(),
        InterfaceName("reth0".to_owned()),
        prov(103),
    )
    .expect("reth0");
    g.set_field(
        ElementId::Node(reth_unit),
        LogicalUnitField::Index.key(),
        0u32,
        prov(104),
    )
    .expect("reth0.0");
    g.set_field(
        ElementId::Node(st0),
        TunnelInterfaceField::Name.key(),
        InterfaceName("st0".to_owned()),
        prov(105),
    )
    .expect("st0");
    g.set_field(
        ElementId::Node(st0),
        TunnelInterfaceField::Technology.key(),
        TunnelInterfaceTechnology::IpsecVti,
        prov(106),
    )
    .expect("st0 technology");
    g.set_field(
        ElementId::Node(st0_unit),
        LogicalUnitField::Index.key(),
        0u32,
        prov(107),
    )
    .expect("st0.0");
    g.set_field(
        ElementId::Node(zone_vpn),
        ZoneField::Name.key(),
        Identifier("VPN".to_owned()),
        prov(108),
    )
    .expect("zone VPN");
    g.set_field(
        ElementId::Node(zone_wan),
        ZoneField::Name.key(),
        Identifier("WAN".to_owned()),
        prov(109),
    )
    .expect("zone WAN");
    // Piece #2: the VPN-side binding is asserted to carry no host-inbound
    // system services. Absent, not Unknown — somebody looked.
    g.assert_absent(
        ElementId::Edge(member_vpn),
        ZoneMemberField::HostInboundSystemServices.key(),
        prov(110),
    )
    .expect("piece #2");
    // Piece #3: ike on the WAN-facing binding.
    g.set_field(
        ElementId::Edge(member_wan),
        ZoneMemberField::HostInboundSystemServices.key(),
        BTreeSet::from([HostService::Ike]),
        prov(111),
    )
    .expect("piece #3");
    g.set_field(
        ElementId::Node(ike_proposal),
        IkeProposalField::Name.key(),
        Identifier("IKE-P1".to_owned()),
        prov(112),
    )
    .expect("IKE-P1");
    g.set_field(
        ElementId::Node(ike_policy),
        IkePolicyField::Name.key(),
        Identifier("IKE-POL".to_owned()),
        prov(113),
    )
    .expect("IKE-POL");
    g.set_field(
        ElementId::Node(ike_gateway),
        IkeGatewayField::Name.key(),
        Identifier("GW-B".to_owned()),
        prov(114),
    )
    .expect("GW-B");
    g.set_field(
        ElementId::Node(ipsec_proposal),
        IpsecProposalField::Name.key(),
        Identifier("IPSEC-P2".to_owned()),
        prov(115),
    )
    .expect("IPSEC-P2");
    g.set_field(
        ElementId::Node(ipsec_policy),
        IpsecPolicyField::Name.key(),
        Identifier("IPSEC-POL".to_owned()),
        prov(116),
    )
    .expect("IPSEC-POL");
    g.set_field(
        ElementId::Node(ipsec_vpn),
        IpsecVpnField::Name.key(),
        Identifier("VPN-B".to_owned()),
        prov(117),
    )
    .expect("VPN-B");
    g.set_field(
        ElementId::Edge(uses_ike_proposal),
        UsesProposalField::Ordinal.key(),
        1u8,
        prov(118),
    )
    .expect("proposal ordinal");
    g.set_field(
        ElementId::Edge(uses_ipsec_proposal),
        UsesProposalField::Ordinal.key(),
        1u8,
        prov(119),
    )
    .expect("proposal ordinal");

    g.end_batch().expect("close");
    Side1 {
        g,
        site,
        device,
        reth,
        reth_unit,
        st0,
        st0_unit,
        zone_vpn,
        zone_wan,
        ike_proposal,
        ike_policy,
        ike_gateway,
        ipsec_proposal,
        ipsec_policy,
        ipsec_vpn,
        member_vpn,
        member_wan,
    }
}

/// The single `to` endpoint of the one edge of this kind leaving `from`.
fn one_out(g: &Graph, from: NodeId, kind: EdgeKind) -> NodeId {
    let mut it = g.out(from, kind);
    let e = it
        .next()
        .unwrap_or_else(|| panic!("no {} out of {from}", kind.name()));
    assert!(it.next().is_none(), "more than one {}", kind.name());
    e.to
}

#[test]
fn side1_subgraph_builds_and_traverses() {
    let s = build();
    let g = &s.g;

    // Containment, downward.
    assert_eq!(one_out(g, s.site, EdgeKind::HasDevice), s.device);
    assert_eq!(one_out(g, s.reth, EdgeKind::HasUnit), s.reth_unit);
    assert_eq!(one_out(g, s.st0, EdgeKind::HasUnit), s.st0_unit);
    let interfaces: Vec<NodeId> = g
        .out(s.device, EdgeKind::HasInterface)
        .map(|e| e.to)
        .collect();
    assert_eq!(interfaces.len(), 2);
    assert!(interfaces.contains(&s.reth) && interfaces.contains(&s.st0));

    // Containment, upward — the reverse index, maintained incrementally.
    assert_eq!(g.owner(s.st0_unit), Some(s.st0));
    assert_eq!(g.owner(s.st0), Some(s.device));
    assert_eq!(g.owner(s.device), Some(s.site));
    assert_eq!(g.owner(s.site), None, "Site is a forest root");
    assert_eq!(g.device_of(s.st0_unit), Some(s.device));
    assert_eq!(g.device_of(s.reth_unit), Some(s.device));
    assert_eq!(g.device_of(s.ipsec_vpn), Some(s.device));
    assert_eq!(g.device_of(s.site), None);
    assert_eq!(
        g.inn(s.device, EdgeKind::HasDevice).next().map(|e| e.from),
        Some(s.site)
    );

    // The six-object chain, 11 §9.2's emit closure read as traversals.
    assert_eq!(
        one_out(g, s.ipsec_vpn, EdgeKind::UsesIkeGateway),
        s.ike_gateway
    );
    assert_eq!(
        one_out(g, s.ike_gateway, EdgeKind::UsesIkePolicy),
        s.ike_policy
    );
    assert_eq!(
        one_out(g, s.ike_policy, EdgeKind::UsesProposal),
        s.ike_proposal
    );
    assert_eq!(
        one_out(g, s.ike_gateway, EdgeKind::ExternalInterface),
        s.reth_unit
    );
    assert_eq!(
        one_out(g, s.ipsec_vpn, EdgeKind::UsesIpsecPolicy),
        s.ipsec_policy
    );
    assert_eq!(
        one_out(g, s.ipsec_policy, EdgeKind::UsesProposal),
        s.ipsec_proposal
    );
    assert_eq!(
        one_out(g, s.ipsec_vpn, EdgeKind::BindsInterface),
        s.st0_unit
    );

    // The zones, and the two bindings 11 §15.6 distinguishes.
    assert_eq!(one_out(g, s.zone_vpn, EdgeKind::ZoneMember), s.st0_unit);
    assert_eq!(one_out(g, s.zone_wan, EdgeKind::ZoneMember), s.reth_unit);
    assert_eq!(
        g.inn(s.st0_unit, EdgeKind::ZoneMember).next().map(|e| e.id),
        Some(s.member_vpn)
    );

    // Presence: Set where set, Absent on the VPN-side binding, Unknown where
    // nobody has said.
    let host_inbound = ZoneMemberField::HostInboundSystemServices.key();
    assert_eq!(
        g.presence(ElementId::Edge(s.member_vpn), host_inbound)
            .expect("declared on the edge")
            .presence,
        StoredPresence::Absent
    );
    assert_eq!(
        g.presence(ElementId::Edge(s.member_wan), host_inbound)
            .expect("declared on the edge")
            .presence,
        StoredPresence::Set
    );
    assert_eq!(
        fathom_ir::generated::accessors::device::hostname(g.node(s.device).expect("stored"))
            .expect("Set"),
        &Identifier("srx-a-01".to_owned())
    );
    assert_eq!(
        g.presence(ElementId::Node(s.device), DeviceField::Hostname.key())
            .expect("declared")
            .presence,
        StoredPresence::Set
    );
    // 11 §15.3: family_mtu on st0.0 is where side 4 lives, and nobody set it.
    assert_eq!(
        g.presence(
            ElementId::Node(s.st0_unit),
            LogicalUnitField::FamilyMtu.key()
        )
        .expect("declared")
        .presence,
        StoredPresence::Unknown
    );
    assert_eq!(
        g.presence(ElementId::Node(s.site), SiteField::Criticality.key())
            .expect("declared")
            .presence,
        StoredPresence::Unknown
    );

    // One batch, one op per mutation.
    assert_eq!(g.log().len(), 1);
    let nodes = g.nodes().count();
    let edges = g.edges().count();
    assert_eq!(nodes, 14);
    assert_eq!(edges, 22);
    assert_eq!(g.log()[0].ops.len(), nodes + edges + FIELD_WRITES);
    assert_eq!(g.nodes_of_kind(NodeKind::Zone).count(), 2);
    assert_eq!(g.nodes_of_kind(NodeKind::LogicalUnit).count(), 2);
    assert_eq!(g.edges_of_kind(EdgeKind::UsesProposal).count(), 2);
}
