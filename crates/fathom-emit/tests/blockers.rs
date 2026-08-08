//! `11` §9.1 L2: *"Returns the exact blocker list, never a partial config with
//! a hole in it"*. One blocker per refused statement, in the position the line
//! would have occupied, and `render_config` refuses while any of them stands.

use fathom_emit::{emit, BlockId, BlockReason, EmitScope, RenderRefused};
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
use fathom_ir::value::{Dpd, IkeId, PeerSpec};
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
        g.begin_batch(BatchId(ulid(1)), "blockers")
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
    fn absent(&mut self, e: impl Into<ElementId>, key: FieldKey) {
        let p = self.prov();
        self.g
            .assert_absent(e.into(), key, p)
            .expect("absence asserts");
    }
}

/// Knobs on the §4.9 chain. `Opts::default()` is the golden graph.
#[derive(Default)]
struct Opts {
    skip_dh_group: bool,
    absent_dh_group: bool,
    skip_p1_auth_algorithm: bool,
    p1_aead_with_auth: bool,
    rsa_auth_method: bool,
    dynamic_peer: bool,
    policy_based: bool,
    unknown_establish: bool,
    skip_uses_ike_policy: bool,
    skip_binds_interface: bool,
    selector_ports: bool,
    duplicate_proposal: bool,
}

struct Chain {
    vpn: NodeId,
    ike_proposal: NodeId,
    gateway: NodeId,
    selector: NodeId,
}

fn ident(s: &str) -> scalar::Identifier {
    scalar::Identifier::parse(s).expect("ascii-graphic identifier")
}

fn enc(token: &str) -> scalar::EncryptionAlgorithm {
    scalar::EncryptionAlgorithm::parse(token).expect("canonical token")
}

fn build(b: &mut B, opts: &Opts) -> Chain {
    let device = b.node(NodeKind::Device);
    b.set(device, DeviceField::Hostname.key(), ident("srx-a"));

    let ike_proposal = b.node(NodeKind::IkeProposal);
    b.edge(EdgeKind::HasIkeProposal, device, ike_proposal);
    b.set(ike_proposal, IkeProposalField::Name.key(), ident("IKE-P1"));
    b.set(
        ike_proposal,
        IkeProposalField::AuthenticationMethod.key(),
        if opts.rsa_auth_method {
            scalar::AuthMethod::RsaSignatures
        } else {
            scalar::AuthMethod::PreSharedKeys
        },
    );
    if opts.absent_dh_group {
        b.absent(ike_proposal, IkeProposalField::DhGroup.key());
    } else if !opts.skip_dh_group {
        b.set(
            ike_proposal,
            IkeProposalField::DhGroup.key(),
            scalar::DhGroup::MODP2048,
        );
    }
    b.set(
        ike_proposal,
        IkeProposalField::EncryptionAlgorithm.key(),
        if opts.p1_aead_with_auth {
            enc("aes-256-gcm")
        } else {
            enc("aes-256-cbc")
        },
    );
    if !opts.skip_p1_auth_algorithm {
        b.set(
            ike_proposal,
            IkeProposalField::AuthenticationAlgorithm.key(),
            scalar::IntegrityAlgorithm::HmacSha256_128,
        );
    }
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

    if opts.duplicate_proposal {
        // A second proposal with the same name and a different renderable
        // lifetime: two lines, one path, different text (13 §3.2).
        let twin = b.node(NodeKind::IkeProposal);
        b.edge(EdgeKind::HasIkeProposal, device, twin);
        b.set(twin, IkeProposalField::Name.key(), ident("IKE-P1"));
        b.set(
            twin,
            IkeProposalField::AuthenticationMethod.key(),
            scalar::AuthMethod::PreSharedKeys,
        );
        b.set(
            twin,
            IkeProposalField::DhGroup.key(),
            scalar::DhGroup::MODP2048,
        );
        b.set(
            twin,
            IkeProposalField::EncryptionAlgorithm.key(),
            enc("aes-256-cbc"),
        );
        b.set(
            twin,
            IkeProposalField::AuthenticationAlgorithm.key(),
            scalar::IntegrityAlgorithm::HmacSha256_128,
        );
        b.set(
            twin,
            IkeProposalField::LifetimeSeconds.key(),
            scalar::Seconds(3_600),
        );
        let e = b.edge(EdgeKind::UsesProposal, ike_policy, twin);
        b.set(e, UsesProposalField::Ordinal.key(), 1u8);
    }

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
        if opts.dynamic_peer {
            PeerSpec::Dynamic(IkeId)
        } else {
            PeerSpec::Address(scalar::IpAddr::parse("203.0.113.10").expect("dotted quad"))
        },
    );
    b.set(
        gateway,
        IkeGatewayField::Version.key(),
        scalar::IkeVersion::V2Only,
    );
    b.set(gateway, IkeGatewayField::Dpd.key(), Dpd);
    if !opts.skip_uses_ike_policy {
        b.edge(EdgeKind::UsesIkePolicy, gateway, ike_policy);
    }
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
    b.set(
        vpn,
        IpsecVpnField::Mode.key(),
        if opts.policy_based {
            VpnMode::PolicyBased
        } else {
            VpnMode::RouteBased
        },
    );
    if opts.unknown_establish {
        b.set(
            vpn,
            IpsecVpnField::EstablishTunnels.key(),
            EstablishTunnels::from_token("whenever"),
        );
    } else {
        b.set(
            vpn,
            IpsecVpnField::EstablishTunnels.key(),
            EstablishTunnels::Immediately,
        );
    }
    b.edge(EdgeKind::UsesIkeGateway, vpn, gateway);
    b.edge(EdgeKind::UsesIpsecPolicy, vpn, ipsec_policy);
    if !opts.skip_binds_interface && !opts.policy_based {
        b.edge(EdgeKind::BindsInterface, vpn, st0_unit);
    }

    let selector = b.node(NodeKind::TrafficSelector);
    b.edge(EdgeKind::HasTrafficSelector, vpn, selector);
    b.set(selector, TrafficSelectorField::Name.key(), ident("TS1"));
    b.set(
        selector,
        TrafficSelectorField::LocalIp.key(),
        scalar::IpPrefix::parse("10.1.0.0/16").expect("prefix"),
    );
    b.set(
        selector,
        TrafficSelectorField::RemoteIp.key(),
        scalar::IpPrefix::parse("10.2.0.0/16").expect("prefix"),
    );
    if opts.selector_ports {
        b.set(
            selector,
            TrafficSelectorField::LocalPorts.key(),
            vec![scalar::PortRange { lo: 443, hi: 443 }],
        );
    }

    Chain {
        vpn,
        ike_proposal,
        gateway,
        selector,
    }
}

/// Build, emit, and hand back the graph-owning builder so ids stay valid.
fn run(opts: Opts) -> (B, Chain) {
    let mut b = B::new();
    let chain = build(&mut b, &opts);
    (b, chain)
}

#[test]
fn required_unknown_blocks_in_position() {
    let (b, chain) = run(Opts {
        skip_dh_group: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    let blocker = &report.blockers[0];
    assert_eq!(blocker.node, chain.ike_proposal);
    assert_eq!(blocker.field, Some(IkeProposalField::DhGroup.key()));
    assert_eq!(blocker.block, BlockId(20));
    assert_eq!(blocker.order_hint, 20);
    assert_eq!(blocker.reason, BlockReason::RequiredUnknown);
}

#[test]
fn required_absent_blocks() {
    let (b, chain) = run(Opts {
        absent_dh_group: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    assert_eq!(report.blockers[0].reason, BlockReason::RequiredAbsent);
    assert_eq!(
        report.blockers[0].field,
        Some(IkeProposalField::DhGroup.key())
    );
}

#[test]
fn cbc_with_auth_unknown_blocks() {
    let (b, chain) = run(Opts {
        skip_p1_auth_algorithm: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    assert_eq!(report.blockers[0].reason, BlockReason::RequiredUnknown);
    assert_eq!(
        report.blockers[0].field,
        Some(IkeProposalField::AuthenticationAlgorithm.key())
    );
    assert_eq!(report.blockers[0].order_hint, 30);
}

#[test]
fn aead_with_auth_set_blocks() {
    let (b, chain) = run(Opts {
        p1_aead_with_auth: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    assert_eq!(report.blockers[0].reason, BlockReason::AeadExcludesAuth);
    assert_eq!(
        report.blockers[0].field,
        Some(IkeProposalField::AuthenticationAlgorithm.key())
    );
}

#[test]
fn dynamic_peer_blocks() {
    let (b, chain) = run(Opts {
        dynamic_peer: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    assert_eq!(report.blockers[0].node, chain.gateway);
    assert_eq!(
        report.blockers[0].reason,
        BlockReason::DynamicPeerNotCovered
    );
}

#[test]
fn policy_based_mode_blocks() {
    let (b, chain) = run(Opts {
        policy_based: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    assert_eq!(
        report.blockers[0].reason,
        BlockReason::PolicyBasedNotCovered
    );
    assert_eq!(report.blockers[0].field, Some(IpsecVpnField::Mode.key()));
}

#[test]
fn enum_unknown_arm_blocks() {
    let (b, chain) = run(Opts {
        unknown_establish: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    assert_eq!(report.blockers[0].reason, BlockReason::EnumUnknownArm);
    assert_eq!(
        report.blockers[0].field,
        Some(IpsecVpnField::EstablishTunnels.key())
    );
}

#[test]
fn token_unmapped_blocks_with_value() {
    let (b, chain) = run(Opts {
        rsa_auth_method: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    assert_eq!(
        report.blockers[0].reason,
        BlockReason::TokenUnmapped {
            value: String::from("rsa-signatures")
        }
    );
}

#[test]
fn missing_uses_ike_policy_edge_blocks() {
    let (b, chain) = run(Opts {
        skip_uses_ike_policy: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert!(report.blockers.iter().any(|blocker| {
        blocker.reason
            == BlockReason::MissingRequiredEdge {
                edge: EdgeKind::UsesIkePolicy,
            }
            && blocker.node == chain.gateway
            && blocker.field.is_none()
    }));
}

#[test]
fn route_based_without_binds_interface_blocks() {
    let (b, chain) = run(Opts {
        skip_binds_interface: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    assert_eq!(
        report.blockers[0].reason,
        BlockReason::MissingRequiredEdge {
            edge: EdgeKind::BindsInterface,
        }
    );
    assert_eq!(report.blockers[0].node, chain.vpn);
}

#[test]
fn selector_port_term_blocks() {
    let (b, chain) = run(Opts {
        selector_ports: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (lines, _, report) = out.parts();
    assert_eq!(report.blockers.len(), 1, "{:?}", report.blockers);
    assert_eq!(
        report.blockers[0].reason,
        BlockReason::SelectorTermUnsupported
    );
    assert_eq!(report.blockers[0].node, chain.selector);
    assert_eq!(
        report.blockers[0].field,
        Some(TrafficSelectorField::LocalPorts.key())
    );
    assert!(
        !lines.iter().any(|l| l.text.contains("traffic-selector")),
        "the selector statement is refused, not partially emitted"
    );
}

#[test]
fn render_config_refuses_with_blockers() {
    let (b, chain) = run(Opts {
        skip_dh_group: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    assert_eq!(
        out.render_config(),
        Err(RenderRefused::Blockers { count: 1 })
    );
    // `parts()` still serves everything: the lines that did emit, the block
    // table, and the report.
    let (lines, blocks, report) = out.parts();
    assert_eq!(lines.len(), 20);
    assert_eq!(blocks.len(), 2);
    assert_eq!(report.blockers.len(), 1);
}

#[test]
fn duplicate_path_conflict_blocks_render() {
    let (b, chain) = run(Opts {
        duplicate_proposal: true,
        ..Opts::default()
    });
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, _, report) = out.parts();
    assert_eq!(report.conflicts.len(), 1, "{:?}", report.conflicts);
    assert_eq!(
        out.render_config(),
        Err(RenderRefused::Conflicts { count: 1 })
    );
}
