//! The field card's side-1 chain, emitted (WO-04 §4.9). The golden bytes in
//! `GOLDEN` are the specification: regenerating them from a failing run is
//! gate laundering (`78` §5.5), so they are transcribed from the work order.

use fathom_emit::{emit, EmitScope, FieldRole, Idempotency, PathToken, Risk};
use fathom_graph::op::BatchId;
use fathom_graph::prov::{
    Actor, Confidence, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
};
use fathom_graph::{EdgeId, ElementId, Graph, NodeId};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{
    EdgeKind, EstablishTunnels, IkeGatewayField, IkePolicyField, IkeProposalField,
    IpsecPolicyField, IpsecProposalField, IpsecProposalProtocol, IpsecVpnField, LogicalUnitField,
    NodeKind, RethInterfaceField, TrafficSelectorField, TunnelInterfaceField,
    TunnelInterfaceTechnology, UsesProposalField, VpnMode,
};
use fathom_ir::scalar::{self, Scalar};
use fathom_ir::value::{Dpd, PeerSpec};
use std::any::Any;

const GOLDEN: &str = "\
set security ike proposal IKE-P1 authentication-method pre-shared-keys
set security ike proposal IKE-P1 dh-group group14
set security ike proposal IKE-P1 authentication-algorithm sha-256
set security ike proposal IKE-P1 encryption-algorithm aes-256-cbc
set security ike proposal IKE-P1 lifetime-seconds 28800
set security ike policy IKE-POL proposals IKE-P1
set security ike policy IKE-POL pre-shared-key ascii-text \"<PSK>\"
set security ike gateway GW-B ike-policy IKE-POL
set security ike gateway GW-B address 203.0.113.10
set security ike gateway GW-B external-interface reth0.0
set security ike gateway GW-B version v2-only
set security ipsec proposal IPSEC-P2 protocol esp
set security ipsec proposal IPSEC-P2 encryption-algorithm aes-256-gcm
set security ipsec proposal IPSEC-P2 lifetime-seconds 3600
set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14
set security ipsec policy IPSEC-POL proposals IPSEC-P2
set security ipsec vpn VPN-B ike gateway GW-B
set security ipsec vpn VPN-B ike ipsec-policy IPSEC-POL
set security ipsec vpn VPN-B bind-interface st0.0
set security ipsec vpn VPN-B establish-tunnels immediately
set security ipsec vpn VPN-B traffic-selector TS1 local-ip 10.1.0.0/16 remote-ip 10.2.0.0/16
";

// ---- the fixture builder --------------------------------------------------

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
        g.begin_batch(BatchId(ulid(1)), "worked example")
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

struct Chain {
    vpn: NodeId,
    gateway: NodeId,
}

fn ident(s: &str) -> scalar::Identifier {
    scalar::Identifier::parse(s).expect("ascii-graphic identifier")
}

/// The card's side-1 chain (WO-04 §4.9).
fn golden_chain(b: &mut B) -> Chain {
    let device = b.node(NodeKind::Device);
    b.set(
        device,
        fathom_ir::generated::ir_types::DeviceField::Hostname.key(),
        ident("srx-a"),
    );

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
        scalar::EncryptionAlgorithm::parse("aes-256-cbc").expect("canonical token"),
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
            scalar::SecretHint::new("vault: net/ipsec/site-b").expect("under the 120-byte cap"),
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
    // The card's dead-peer-detection line has no emitter: `Dpd` is an empty
    // stub, so this Set value is the gap ledger's one entry (WO-04 §4.9).
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
        scalar::EncryptionAlgorithm::parse("aes-256-gcm").expect("canonical token"),
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

    Chain { vpn, gateway }
}

// ---- the tests ------------------------------------------------------------

#[test]
fn side1_chain_emits_the_golden_bytes() {
    let mut b = B::new();
    let chain = golden_chain(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("the scope is an IpsecVpn");
    let rendered = out.render_config().expect("no blockers, no conflicts");
    assert_eq!(rendered, GOLDEN);
    assert_eq!(rendered.lines().count(), 21);
    assert!(rendered.ends_with('\n'));
}

#[test]
fn report_matches_the_golden_contract() {
    let mut b = B::new();
    let chain = golden_chain(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (lines, _, report) = out.parts();

    assert!(report.blockers.is_empty(), "{:?}", report.blockers);
    assert!(report.conflicts.is_empty());

    assert_eq!(report.substitutions.len(), 1);
    let sub = &report.substitutions[0];
    assert_eq!(sub.token, "<PSK>");
    assert_eq!(sub.line, 6);
    assert_eq!(sub.hint.as_deref(), Some("vault: net/ipsec/site-b"));

    // The one gap the golden text cannot carry: GW-B.dpd. Every other gap
    // field is Unknown in this fixture, and an Unknown gap field reports
    // nothing.
    assert_eq!(report.gaps.len(), 1, "{:?}", report.gaps);
    assert_eq!(report.gaps[0].node, chain.gateway);
    assert_eq!(report.gaps[0].field, IkeGatewayField::Dpd.key());
    assert!(report.gaps[0].tracking.contains("Dpd is an empty stub"));

    assert_eq!(lines.len(), 21);
}

#[test]
fn blocks_are_phase1_then_phase2() {
    let mut b = B::new();
    let chain = golden_chain(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (_, blocks, _) = out.parts();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].rank, 20);
    assert_eq!(blocks[0].title, "PHASE 1 — PROPOSAL, POLICY, GATEWAY");
    assert_eq!(blocks[1].rank, 30);
    assert_eq!(blocks[1].title, "PHASE 2 — PROPOSAL, POLICY, VPN");
}

#[test]
fn every_line_carries_provenance() {
    let mut b = B::new();
    let chain = golden_chain(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (lines, _, _) = out.parts();
    for line in lines {
        assert!(!line.source_fields.is_empty(), "invariant 6: {}", line.text);
    }
    // Line 9 is `external-interface`: the unit's index and the interface's
    // name, both Referenced.
    let external = &lines[9];
    assert_eq!(
        external.text,
        "set security ike gateway GW-B external-interface reth0.0"
    );
    let referenced: Vec<_> = external
        .source_fields
        .iter()
        .filter(|f| f.role == FieldRole::Referenced)
        .collect();
    assert_eq!(referenced.len(), 2);
    assert_eq!(referenced[0].field, LogicalUnitField::Index.key());
    assert_eq!(referenced[1].field, RethInterfaceField::Name.key());
}

#[test]
fn line_text_is_one_logical_line() {
    let mut b = B::new();
    let chain = golden_chain(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (lines, _, _) = out.parts();
    for line in lines {
        assert!(!line.text.contains('\n'), "{}", line.text);
        assert!(!line.text.contains('\\'), "{}", line.text);
        assert!(!line.text.starts_with(' '), "{}", line.text);
    }
}

#[test]
fn risk_is_changes_config_on_every_line() {
    let mut b = B::new();
    let chain = golden_chain(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (lines, _, _) = out.parts();
    assert!(lines.iter().all(|l| l.risk == Risk::ChangesConfig));
}

#[test]
fn proposals_line_is_accumulating_with_member_path() {
    let mut b = B::new();
    let chain = golden_chain(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (lines, _, _) = out.parts();
    let proposals = lines
        .iter()
        .find(|l| l.text == "set security ike policy IKE-POL proposals IKE-P1")
        .expect("the proposals line");
    assert_eq!(proposals.idempotency, Idempotency::Accumulating);
    assert_eq!(
        proposals.path.tokens.last(),
        Some(&PathToken::Member(String::from("IKE-P1")))
    );
    // Scalar leaves stay Idempotent.
    let leaf = lines
        .iter()
        .find(|l| l.text == "set security ike proposal IKE-P1 dh-group group14")
        .expect("the dh-group line");
    assert_eq!(leaf.idempotency, Idempotency::Idempotent);
}
