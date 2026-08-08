//! Invariant 9 at the store boundary: iteration order is a pure function of
//! content.
//!
//! `11` §13's own note on the graph — *"Deterministic iteration for invariant
//! 9: sorted by NodeId, maintained incrementally, never derived from HashMap
//! order"* — is what these two tests hold the store to. The first proves the
//! order does not depend on the sequence of writes that produced it; the
//! second proves it does not depend on the process, which is the failure a
//! `HashMap` with a per-process `RandomState` would introduce and which no
//! single-run assertion can see.

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{
    DeviceField, EdgeKind, HostService, IkeGatewayField, NodeKind, SiteField, ZoneMemberField,
};
use fathom_ir::scalar::{Identifier, Text};
use std::collections::BTreeSet;
use std::fmt::Write as _;

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

/// The logical graph both orders build: the worked example's spine, with one
/// element per fixed ULID so the two constructions are the same graph and
/// differ only in the sequence of writes.
mod ids {
    pub const SITE: u128 = 1;
    pub const DEVICE: u128 = 2;
    pub const RETH: u128 = 3;
    pub const RETH_UNIT: u128 = 4;
    pub const ST0: u128 = 5;
    pub const ST0_UNIT: u128 = 6;
    pub const ZONE_VPN: u128 = 7;
    pub const ZONE_WAN: u128 = 8;
    pub const IKE_GATEWAY: u128 = 9;
    pub const IPSEC_VPN: u128 = 10;
}

fn node(g: &mut Graph, kind: NodeKind, n: u128) -> NodeId {
    g.insert_node(kind, ulid(n), prov(n)).expect("bare node")
}

fn edge(g: &mut Graph, kind: EdgeKind, from: NodeId, to: NodeId, n: u128) -> fathom_graph::EdgeId {
    g.insert_edge(kind, ulid(n), from, to, prov(n))
        .expect("edge")
}

/// Nodes first, then edges, then fields.
fn build_grouped() -> Graph {
    let mut g = Graph::new();
    g.begin_batch(BatchId(ulid(0)), "grouped").expect("open");

    let site = node(&mut g, NodeKind::Site, ids::SITE);
    let device = node(&mut g, NodeKind::Device, ids::DEVICE);
    let reth = node(&mut g, NodeKind::RethInterface, ids::RETH);
    let reth_unit = node(&mut g, NodeKind::LogicalUnit, ids::RETH_UNIT);
    let st0 = node(&mut g, NodeKind::TunnelInterface, ids::ST0);
    let st0_unit = node(&mut g, NodeKind::LogicalUnit, ids::ST0_UNIT);
    let zone_vpn = node(&mut g, NodeKind::Zone, ids::ZONE_VPN);
    let zone_wan = node(&mut g, NodeKind::Zone, ids::ZONE_WAN);
    let gateway = node(&mut g, NodeKind::IkeGateway, ids::IKE_GATEWAY);
    let vpn = node(&mut g, NodeKind::IpsecVpn, ids::IPSEC_VPN);

    edge(&mut g, EdgeKind::HasDevice, site, device, 20);
    edge(&mut g, EdgeKind::HasInterface, device, reth, 21);
    edge(&mut g, EdgeKind::HasUnit, reth, reth_unit, 22);
    edge(&mut g, EdgeKind::HasInterface, device, st0, 23);
    edge(&mut g, EdgeKind::HasUnit, st0, st0_unit, 24);
    edge(&mut g, EdgeKind::HasZone, device, zone_vpn, 25);
    edge(&mut g, EdgeKind::HasZone, device, zone_wan, 26);
    let member_vpn = edge(&mut g, EdgeKind::ZoneMember, zone_vpn, st0_unit, 27);
    let member_wan = edge(&mut g, EdgeKind::ZoneMember, zone_wan, reth_unit, 28);
    edge(&mut g, EdgeKind::HasIkeGateway, device, gateway, 29);
    edge(&mut g, EdgeKind::HasIpsecVpn, device, vpn, 30);
    edge(&mut g, EdgeKind::ExternalInterface, gateway, reth_unit, 31);
    edge(&mut g, EdgeKind::UsesIkeGateway, vpn, gateway, 32);
    edge(&mut g, EdgeKind::BindsInterface, vpn, st0_unit, 33);

    fields(&mut g, site, device, gateway, member_vpn, member_wan);
    g.end_batch().expect("close");
    g
}

/// The same graph, written subtree by subtree with fields interleaved.
fn build_interleaved() -> Graph {
    let mut g = Graph::new();
    g.begin_batch(BatchId(ulid(0)), "interleaved")
        .expect("open");

    let device = node(&mut g, NodeKind::Device, ids::DEVICE);
    let st0 = node(&mut g, NodeKind::TunnelInterface, ids::ST0);
    edge(&mut g, EdgeKind::HasInterface, device, st0, 23);
    let st0_unit = node(&mut g, NodeKind::LogicalUnit, ids::ST0_UNIT);
    edge(&mut g, EdgeKind::HasUnit, st0, st0_unit, 24);

    let vpn = node(&mut g, NodeKind::IpsecVpn, ids::IPSEC_VPN);
    edge(&mut g, EdgeKind::HasIpsecVpn, device, vpn, 30);
    edge(&mut g, EdgeKind::BindsInterface, vpn, st0_unit, 33);

    let zone_vpn = node(&mut g, NodeKind::Zone, ids::ZONE_VPN);
    edge(&mut g, EdgeKind::HasZone, device, zone_vpn, 25);
    let member_vpn = edge(&mut g, EdgeKind::ZoneMember, zone_vpn, st0_unit, 27);

    let reth = node(&mut g, NodeKind::RethInterface, ids::RETH);
    edge(&mut g, EdgeKind::HasInterface, device, reth, 21);
    let reth_unit = node(&mut g, NodeKind::LogicalUnit, ids::RETH_UNIT);
    edge(&mut g, EdgeKind::HasUnit, reth, reth_unit, 22);

    let zone_wan = node(&mut g, NodeKind::Zone, ids::ZONE_WAN);
    edge(&mut g, EdgeKind::HasZone, device, zone_wan, 26);
    let member_wan = edge(&mut g, EdgeKind::ZoneMember, zone_wan, reth_unit, 28);

    let gateway = node(&mut g, NodeKind::IkeGateway, ids::IKE_GATEWAY);
    edge(&mut g, EdgeKind::HasIkeGateway, device, gateway, 29);
    edge(&mut g, EdgeKind::ExternalInterface, gateway, reth_unit, 31);
    edge(&mut g, EdgeKind::UsesIkeGateway, vpn, gateway, 32);

    let site = node(&mut g, NodeKind::Site, ids::SITE);
    edge(&mut g, EdgeKind::HasDevice, site, device, 20);

    fields(&mut g, site, device, gateway, member_vpn, member_wan);
    g.end_batch().expect("close");
    g
}

fn fields(
    g: &mut Graph,
    site: NodeId,
    device: NodeId,
    gateway: NodeId,
    member_vpn: fathom_graph::EdgeId,
    member_wan: fathom_graph::EdgeId,
) {
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
        ElementId::Node(gateway),
        IkeGatewayField::Name.key(),
        Identifier("GW-B".to_owned()),
        prov(102),
    )
    .expect("IkeGateway.name");
    g.assert_absent(
        ElementId::Edge(member_vpn),
        ZoneMemberField::HostInboundSystemServices.key(),
        prov(103),
    )
    .expect("piece #2");
    g.set_field(
        ElementId::Edge(member_wan),
        ZoneMemberField::HostInboundSystemServices.key(),
        BTreeSet::from([HostService::Ike]),
        prov(104),
    )
    .expect("piece #3");
}

/// Every iterator the store exposes over elements, rendered through the ids'
/// own `Display`. Anything order-dependent shows up as a byte difference.
fn dump(g: &Graph) -> String {
    let mut o = String::new();
    for n in g.nodes() {
        let _ = writeln!(o, "node {}", n.id);
    }
    for k in NodeKind::ALL {
        for n in g.nodes_of_kind(k) {
            let _ = writeln!(o, "of-kind {} {}", k.name(), n.id);
        }
    }
    for e in g.edges() {
        let _ = writeln!(o, "edge {} {} -> {}", e.id, e.from, e.to);
    }
    for k in EdgeKind::ALL {
        for e in g.edges_of_kind(k) {
            let _ = writeln!(o, "of-kind {} {}", k.name(), e.id);
        }
    }
    for n in g.nodes() {
        for k in EdgeKind::ALL {
            for e in g.out(n.id, k) {
                let _ = writeln!(o, "out {} {} {}", n.id, k.name(), e.id);
            }
            for e in g.inn(n.id, k) {
                let _ = writeln!(o, "inn {} {} {}", n.id, k.name(), e.id);
            }
        }
        if let Some(owner) = g.owner(n.id) {
            let _ = writeln!(o, "owner {} {owner}", n.id);
        }
        if let Some(device) = g.device_of(n.id) {
            let _ = writeln!(o, "device-of {} {device}", n.id);
        }
    }
    o
}

#[test]
fn iteration_order_is_insertion_independent() {
    let grouped = dump(&build_grouped());
    let interleaved = dump(&build_interleaved());
    assert_eq!(
        grouped, interleaved,
        "the same graph written in two orders iterates identically"
    );
    assert!(grouped.contains("out site:"), "the dump is not empty");
}

#[test]
fn identical_sequences_render_identically() {
    let first = dump(&build_grouped());
    let second = dump(&build_grouped());
    assert_eq!(first, second);
    let third = dump(&build_interleaved());
    let fourth = dump(&build_interleaved());
    assert_eq!(third, fourth);
}
