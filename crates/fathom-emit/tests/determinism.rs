//! Invariant 9 at the emitter: same graph, same build, byte-identical output,
//! and an ordering that is a function of content rather than of insertion.

use fathom_emit::{emit, EmitScope, StatementPath};
use fathom_graph::op::BatchId;
use fathom_graph::prov::{
    Actor, Confidence, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
};
use fathom_graph::{EdgeId, ElementId, Graph, NodeId};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{
    DeviceField, EdgeKind, EstablishTunnels, IkeGatewayField, IkePolicyField, IkeProposalField,
    IpsecPolicyField, IpsecProposalField, IpsecProposalProtocol, IpsecVpnField, LogicalUnitField,
    NodeKind, RethInterfaceField, TrafficSelectorField, TunnelInterfaceField,
    TunnelInterfaceTechnology, UsesProposalField, VpnMode,
};
use fathom_ir::scalar::{self, Scalar};
use fathom_ir::value::{Dpd, PeerSpec};
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
        g.begin_batch(BatchId(ulid(1)), "determinism")
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
    fn edge(&mut self, kind: EdgeKind, from: NodeId, to: NodeId) -> EdgeId {
        let u = self.next();
        let p = self.prov();
        self.g
            .insert_edge(kind, u, from, to, p)
            .expect("edge inserts")
    }
    fn set<T: Any>(&mut self, e: impl Into<ElementId>, key: FieldKey, v: T) {
        let p = self.prov();
        self.g.set_field(e.into(), key, v, p).expect("field sets");
    }
}

fn ident(s: &str) -> scalar::Identifier {
    scalar::Identifier::parse(s).expect("ascii-graphic identifier")
}

fn enc(token: &str) -> scalar::EncryptionAlgorithm {
    scalar::EncryptionAlgorithm::parse(token).expect("canonical token")
}

/// The §4.9 chain, built device-first / proposal-first.
fn build_forward(b: &mut B) -> NodeId {
    let device = b.node(NodeKind::Device);
    b.set(device, DeviceField::Hostname.key(), ident("srx-a"));

    let ike_proposal = b.node(NodeKind::IkeProposal);
    b.edge(EdgeKind::HasIkeProposal, device, ike_proposal);
    b.set(ike_proposal, IkeProposalField::Name.key(), ident("IKE-P1"));
    b.set(
        ike_proposal,
        IkeProposalField::AuthenticationMethod.key(),
        scalar::AuthMethod::PreSharedKeys,
    );
    b.set(
        ike_proposal,
        IkeProposalField::DhGroup.key(),
        scalar::DhGroup::MODP2048,
    );
    b.set(
        ike_proposal,
        IkeProposalField::EncryptionAlgorithm.key(),
        enc("aes-256-cbc"),
    );
    b.set(
        ike_proposal,
        IkeProposalField::AuthenticationAlgorithm.key(),
        scalar::IntegrityAlgorithm::HmacSha256_128,
    );
    b.set(
        ike_proposal,
        IkeProposalField::LifetimeSeconds.key(),
        scalar::Seconds(28_800),
    );

    let ike_policy = b.node(NodeKind::IkePolicy);
    b.edge(EdgeKind::HasIkePolicy, device, ike_policy);
    b.set(ike_policy, IkePolicyField::Name.key(), ident("IKE-POL"));
    b.set(
        ike_policy,
        IkePolicyField::PreSharedKey.key(),
        scalar::SecretPlaceholder::with_hint(
            scalar::SecretLabel::Psk,
            scalar::SecretHint::new("vault: net/ipsec/site-b").expect("under the cap"),
        ),
    );
    let e = b.edge(EdgeKind::UsesProposal, ike_policy, ike_proposal);
    b.set(e, UsesProposalField::Ordinal.key(), 0u8);

    let reth = b.node(NodeKind::RethInterface);
    b.edge(EdgeKind::HasInterface, device, reth);
    b.set(
        reth,
        RethInterfaceField::Name.key(),
        scalar::InterfaceName::parse("reth0").expect("ascii-graphic"),
    );
    let reth_unit = b.node(NodeKind::LogicalUnit);
    b.edge(EdgeKind::HasUnit, reth, reth_unit);
    b.set(reth_unit, LogicalUnitField::Index.key(), 0u32);

    let gateway = b.node(NodeKind::IkeGateway);
    b.edge(EdgeKind::HasIkeGateway, device, gateway);
    b.set(gateway, IkeGatewayField::Name.key(), ident("GW-B"));
    b.set(
        gateway,
        IkeGatewayField::Peer.key(),
        PeerSpec::Address(scalar::IpAddr::parse("203.0.113.10").expect("dotted quad")),
    );
    b.set(
        gateway,
        IkeGatewayField::Version.key(),
        scalar::IkeVersion::V2Only,
    );
    b.set(gateway, IkeGatewayField::Dpd.key(), Dpd);
    b.edge(EdgeKind::UsesIkePolicy, gateway, ike_policy);
    b.edge(EdgeKind::ExternalInterface, gateway, reth_unit);

    let ipsec_proposal = b.node(NodeKind::IpsecProposal);
    b.edge(EdgeKind::HasIpsecProposal, device, ipsec_proposal);
    b.set(
        ipsec_proposal,
        IpsecProposalField::Name.key(),
        ident("IPSEC-P2"),
    );
    b.set(
        ipsec_proposal,
        IpsecProposalField::Protocol.key(),
        IpsecProposalProtocol::Esp,
    );
    b.set(
        ipsec_proposal,
        IpsecProposalField::EncryptionAlgorithm.key(),
        enc("aes-256-gcm"),
    );
    b.set(
        ipsec_proposal,
        IpsecProposalField::LifetimeSeconds.key(),
        scalar::Seconds(3_600),
    );

    let ipsec_policy = b.node(NodeKind::IpsecPolicy);
    b.edge(EdgeKind::HasIpsecPolicy, device, ipsec_policy);
    b.set(
        ipsec_policy,
        IpsecPolicyField::Name.key(),
        ident("IPSEC-POL"),
    );
    b.set(
        ipsec_policy,
        IpsecPolicyField::PerfectForwardSecrecy.key(),
        scalar::DhGroup::MODP2048,
    );
    let e = b.edge(EdgeKind::UsesProposal, ipsec_policy, ipsec_proposal);
    b.set(e, UsesProposalField::Ordinal.key(), 0u8);

    let st0 = b.node(NodeKind::TunnelInterface);
    b.edge(EdgeKind::HasInterface, device, st0);
    b.set(
        st0,
        TunnelInterfaceField::Name.key(),
        scalar::InterfaceName::parse("st0").expect("ascii-graphic"),
    );
    b.set(
        st0,
        TunnelInterfaceField::Technology.key(),
        TunnelInterfaceTechnology::IpsecVti,
    );
    let st0_unit = b.node(NodeKind::LogicalUnit);
    b.edge(EdgeKind::HasUnit, st0, st0_unit);
    b.set(st0_unit, LogicalUnitField::Index.key(), 0u32);

    let vpn = b.node(NodeKind::IpsecVpn);
    b.edge(EdgeKind::HasIpsecVpn, device, vpn);
    b.set(vpn, IpsecVpnField::Name.key(), ident("VPN-B"));
    b.set(vpn, IpsecVpnField::Mode.key(), VpnMode::RouteBased);
    b.set(
        vpn,
        IpsecVpnField::EstablishTunnels.key(),
        EstablishTunnels::Immediately,
    );
    b.edge(EdgeKind::UsesIkeGateway, vpn, gateway);
    b.edge(EdgeKind::UsesIpsecPolicy, vpn, ipsec_policy);
    b.edge(EdgeKind::BindsInterface, vpn, st0_unit);

    let ts = b.node(NodeKind::TrafficSelector);
    b.edge(EdgeKind::HasTrafficSelector, vpn, ts);
    b.set(ts, TrafficSelectorField::Name.key(), ident("TS1"));
    b.set(
        ts,
        TrafficSelectorField::LocalIp.key(),
        scalar::IpPrefix::parse("10.1.0.0/16").expect("prefix"),
    );
    b.set(
        ts,
        TrafficSelectorField::RemoteIp.key(),
        scalar::IpPrefix::parse("10.2.0.0/16").expect("prefix"),
    );
    vpn
}

/// The same chain, built vpn-first and selector-early: every node and edge
/// gets a different ULID, every adjacency list is filled in a different order,
/// and the fields land last.
fn build_reversed(b: &mut B) -> NodeId {
    let vpn = b.node(NodeKind::IpsecVpn);
    let ts = b.node(NodeKind::TrafficSelector);
    b.edge(EdgeKind::HasTrafficSelector, vpn, ts);
    let st0 = b.node(NodeKind::TunnelInterface);
    let st0_unit = b.node(NodeKind::LogicalUnit);
    b.edge(EdgeKind::HasUnit, st0, st0_unit);
    b.edge(EdgeKind::BindsInterface, vpn, st0_unit);
    let ipsec_policy = b.node(NodeKind::IpsecPolicy);
    let ipsec_proposal = b.node(NodeKind::IpsecProposal);
    let e = b.edge(EdgeKind::UsesProposal, ipsec_policy, ipsec_proposal);
    b.set(e, UsesProposalField::Ordinal.key(), 0u8);
    b.edge(EdgeKind::UsesIpsecPolicy, vpn, ipsec_policy);
    let gateway = b.node(NodeKind::IkeGateway);
    let reth = b.node(NodeKind::RethInterface);
    let reth_unit = b.node(NodeKind::LogicalUnit);
    b.edge(EdgeKind::HasUnit, reth, reth_unit);
    b.edge(EdgeKind::ExternalInterface, gateway, reth_unit);
    b.edge(EdgeKind::UsesIkeGateway, vpn, gateway);
    let ike_policy = b.node(NodeKind::IkePolicy);
    let ike_proposal = b.node(NodeKind::IkeProposal);
    let e = b.edge(EdgeKind::UsesProposal, ike_policy, ike_proposal);
    b.set(e, UsesProposalField::Ordinal.key(), 0u8);
    b.edge(EdgeKind::UsesIkePolicy, gateway, ike_policy);
    let device = b.node(NodeKind::Device);
    b.edge(EdgeKind::HasInterface, device, st0);
    b.edge(EdgeKind::HasInterface, device, reth);
    b.edge(EdgeKind::HasIpsecVpn, device, vpn);
    b.edge(EdgeKind::HasIpsecPolicy, device, ipsec_policy);
    b.edge(EdgeKind::HasIpsecProposal, device, ipsec_proposal);
    b.edge(EdgeKind::HasIkeGateway, device, gateway);
    b.edge(EdgeKind::HasIkePolicy, device, ike_policy);
    b.edge(EdgeKind::HasIkeProposal, device, ike_proposal);

    b.set(
        ts,
        TrafficSelectorField::RemoteIp.key(),
        scalar::IpPrefix::parse("10.2.0.0/16").expect("prefix"),
    );
    b.set(
        ts,
        TrafficSelectorField::LocalIp.key(),
        scalar::IpPrefix::parse("10.1.0.0/16").expect("prefix"),
    );
    b.set(ts, TrafficSelectorField::Name.key(), ident("TS1"));
    b.set(
        vpn,
        IpsecVpnField::EstablishTunnels.key(),
        EstablishTunnels::Immediately,
    );
    b.set(vpn, IpsecVpnField::Mode.key(), VpnMode::RouteBased);
    b.set(vpn, IpsecVpnField::Name.key(), ident("VPN-B"));
    b.set(st0_unit, LogicalUnitField::Index.key(), 0u32);
    b.set(
        st0,
        TunnelInterfaceField::Technology.key(),
        TunnelInterfaceTechnology::IpsecVti,
    );
    b.set(
        st0,
        TunnelInterfaceField::Name.key(),
        scalar::InterfaceName::parse("st0").expect("ascii-graphic"),
    );
    b.set(
        ipsec_policy,
        IpsecPolicyField::PerfectForwardSecrecy.key(),
        scalar::DhGroup::MODP2048,
    );
    b.set(
        ipsec_policy,
        IpsecPolicyField::Name.key(),
        ident("IPSEC-POL"),
    );
    b.set(
        ipsec_proposal,
        IpsecProposalField::LifetimeSeconds.key(),
        scalar::Seconds(3_600),
    );
    b.set(
        ipsec_proposal,
        IpsecProposalField::EncryptionAlgorithm.key(),
        enc("aes-256-gcm"),
    );
    b.set(
        ipsec_proposal,
        IpsecProposalField::Protocol.key(),
        IpsecProposalProtocol::Esp,
    );
    b.set(
        ipsec_proposal,
        IpsecProposalField::Name.key(),
        ident("IPSEC-P2"),
    );
    b.set(reth_unit, LogicalUnitField::Index.key(), 0u32);
    b.set(
        reth,
        RethInterfaceField::Name.key(),
        scalar::InterfaceName::parse("reth0").expect("ascii-graphic"),
    );
    b.set(gateway, IkeGatewayField::Dpd.key(), Dpd);
    b.set(
        gateway,
        IkeGatewayField::Version.key(),
        scalar::IkeVersion::V2Only,
    );
    b.set(
        gateway,
        IkeGatewayField::Peer.key(),
        PeerSpec::Address(scalar::IpAddr::parse("203.0.113.10").expect("dotted quad")),
    );
    b.set(gateway, IkeGatewayField::Name.key(), ident("GW-B"));
    b.set(
        ike_policy,
        IkePolicyField::PreSharedKey.key(),
        scalar::SecretPlaceholder::with_hint(
            scalar::SecretLabel::Psk,
            scalar::SecretHint::new("vault: net/ipsec/site-b").expect("under the cap"),
        ),
    );
    b.set(ike_policy, IkePolicyField::Name.key(), ident("IKE-POL"));
    b.set(
        ike_proposal,
        IkeProposalField::LifetimeSeconds.key(),
        scalar::Seconds(28_800),
    );
    b.set(
        ike_proposal,
        IkeProposalField::AuthenticationAlgorithm.key(),
        scalar::IntegrityAlgorithm::HmacSha256_128,
    );
    b.set(
        ike_proposal,
        IkeProposalField::EncryptionAlgorithm.key(),
        enc("aes-256-cbc"),
    );
    b.set(
        ike_proposal,
        IkeProposalField::DhGroup.key(),
        scalar::DhGroup::MODP2048,
    );
    b.set(
        ike_proposal,
        IkeProposalField::AuthenticationMethod.key(),
        scalar::AuthMethod::PreSharedKeys,
    );
    b.set(ike_proposal, IkeProposalField::Name.key(), ident("IKE-P1"));
    b.set(device, DeviceField::Hostname.key(), ident("srx-a"));
    vpn
}

#[test]
fn same_graph_two_emits_byte_identical() {
    let mut b = B::new();
    let vpn = build_forward(&mut b);
    let first = emit(&b.g, EmitScope::IpsecVpn(vpn))
        .expect("scope")
        .render_config()
        .expect("green");
    let second = emit(&b.g, EmitScope::IpsecVpn(vpn))
        .expect("scope")
        .render_config()
        .expect("green");
    assert_eq!(first, second);
}

#[test]
fn insertion_order_does_not_change_emission() {
    let mut forward = B::new();
    let a = build_forward(&mut forward);
    let mut reversed = B::new();
    let z = build_reversed(&mut reversed);
    let left = emit(&forward.g, EmitScope::IpsecVpn(a))
        .expect("scope")
        .render_config()
        .expect("green");
    let right = emit(&reversed.g, EmitScope::IpsecVpn(z))
        .expect("scope")
        .render_config()
        .expect("green");
    assert_eq!(left, right);
}

#[test]
fn value_edit_changes_no_ordering() {
    let mut b = B::new();
    let vpn = build_forward(&mut b);
    let before = emit(&b.g, EmitScope::IpsecVpn(vpn)).expect("scope");
    let (lines, _, _) = before.parts();
    let paths: Vec<StatementPath> = lines.iter().map(|l| l.path.clone()).collect();
    let texts: Vec<String> = lines.iter().map(|l| l.text.clone()).collect();
    drop(before);

    // One scalar leaf, one new Set value.
    let proposal =
        b.g.nodes_of_kind(NodeKind::IkeProposal)
            .map(|n| n.id)
            .next()
            .expect("one proposal");
    b.set(
        proposal,
        IkeProposalField::LifetimeSeconds.key(),
        scalar::Seconds(3_600),
    );

    let after = emit(&b.g, EmitScope::IpsecVpn(vpn)).expect("scope");
    let (lines, _, _) = after.parts();
    let new_paths: Vec<StatementPath> = lines.iter().map(|l| l.path.clone()).collect();
    let new_texts: Vec<String> = lines.iter().map(|l| l.text.clone()).collect();

    assert_eq!(paths, new_paths, "the path sequence is unchanged");
    let differing: Vec<usize> = (0..texts.len())
        .filter(|&i| texts[i] != new_texts[i])
        .collect();
    assert_eq!(differing, vec![4], "only line 4's text differs");
    assert_eq!(
        new_texts[4],
        "set security ike proposal IKE-P1 lifetime-seconds 3600"
    );
}
