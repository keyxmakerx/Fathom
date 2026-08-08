//! Invariant 3 at the emitter: the placeholder is the value, the hint is a
//! pointer to where a human keeps the secret, and the hint never reaches any
//! emitted text — the crate-side twin of `62` §19.4's `dict.secret.interpolated`.

use fathom_emit::{emit, EmitScope, FieldRole};
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
use fathom_ir::scalar::{self, Scalar, SecretLabel};
use fathom_ir::value::PeerSpec;
use std::any::Any;

const HINT: &str = "vault: net/ipsec/site-b";

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
        g.begin_batch(BatchId(ulid(1)), "secret")
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

struct Chain {
    vpn: NodeId,
    ike_policy: NodeId,
}

fn build(b: &mut B) -> Chain {
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
            SecretLabel::Psk,
            scalar::SecretHint::new(HINT).expect("under the 120-byte cap"),
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

    Chain { vpn, ike_policy }
}

#[test]
fn psk_renders_the_placeholder_never_the_hint() {
    let mut b = B::new();
    let chain = build(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (lines, _, report) = out.parts();
    for line in lines {
        assert!(!line.text.contains(HINT), "the hint is in `{}`", line.text);
        assert!(!line.text.contains("vault"), "{}", line.text);
    }
    assert!(lines
        .iter()
        .any(|l| l.text == "set security ike policy IKE-POL pre-shared-key ascii-text \"<PSK>\""));
    assert_eq!(report.substitutions.len(), 1);
    assert_eq!(report.substitutions[0].hint.as_deref(), Some(HINT));
}

#[test]
fn substitution_manifest_names_line_and_site() {
    let mut b = B::new();
    let chain = build(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (lines, _, report) = out.parts();
    let sub = &report.substitutions[0];
    assert_eq!(sub.line, 6);
    assert_eq!(sub.site.node, chain.ike_policy);
    assert_eq!(sub.site.field, IkePolicyField::PreSharedKey.key());
    assert_eq!(sub.site.role, FieldRole::Value);
    assert_eq!(sub.token, "<PSK>");
    let line = &lines[sub.line as usize];
    assert_eq!(line.placeholders.len(), 1);
    assert_eq!(line.placeholders[0].label, SecretLabel::Psk);
}

#[test]
fn placeholder_span_covers_the_token() {
    let mut b = B::new();
    let chain = build(&mut b);
    let out = emit(&b.g, EmitScope::IpsecVpn(chain.vpn)).expect("scope");
    let (lines, _, _) = out.parts();
    let line = lines
        .iter()
        .find(|l| !l.placeholders.is_empty())
        .expect("the pre-shared-key line");
    let span = &line.placeholders[0];
    assert_eq!(
        &line.text[span.start as usize..span.end as usize],
        "<PSK>",
        "the byte range slices `text` to exactly the placeholder"
    );
}
