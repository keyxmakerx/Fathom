//! The junos-srx statement tables, the closed token tables, and the read
//! discipline (WO-04 §4.4, §4.6, §4.7).
//!
//! Every value renders through a **closed** table. A `Set` value outside a
//! table is `BlockReason::TokenUnmapped` — a refusal, never a guess; extending
//! a table is a planning change with sources. Branching lives in Rust, never
//! in data (`13` §6.1), so the two declarable `R*` conditions are hard-coded
//! in the kind emitter that owns them.

use crate::block::BlockId;
use crate::line::{EmittedLine, FieldRef, FieldRole, Idempotency, PlaceholderSpan};
use crate::output::block_of;
use crate::path::{PathToken, StatementPath};
use crate::plan::{self, Member};
use crate::report::{BlockReason, Blocker, EmitReport, GapEntry};
use fathom_graph::{Graph, Node, NodeId, StoredPresence};
use fathom_ir::bag::{FieldError, FieldKey};
use fathom_ir::generated::accessors::{
    aggregate_interface, ike_gateway, ike_policy, ike_proposal, interface, ipsec_policy,
    ipsec_proposal, ipsec_vpn, logical_unit, reth_interface, traffic_selector, tunnel_interface,
};
use fathom_ir::generated::ir_types::{
    AggregateInterfaceField, EdgeKind, EstablishTunnels, IkeGatewayField, IkePolicyField,
    IkeProposalField, InterfaceField, IpsecPolicyField, IpsecProposalField, IpsecProposalProtocol,
    IpsecVpnField, LogicalUnitField, NodeKind, RethInterfaceField, TrafficSelectorField,
    TunnelInterfaceField, VpnMode,
};
use fathom_ir::scalar::{
    AuthMethod, DhGroup, EncryptionAlgorithm, IkeVersion, IntegrityAlgorithm, Scalar,
};
use fathom_ir::value::PeerSpec;

// ---------------------------------------------------------------------------
// The read sets and the gap ledgers (WO-04 §4.6). Together they must partition
// each covered kind's declared field set — `tests/coverage.rs` is the
// crate-side half of `schema.emit.unread` (62 §10.3).
// ---------------------------------------------------------------------------

pub const READS_IKE_PROPOSAL: &[FieldKey] = &[
    IkeProposalField::Name.key(),
    IkeProposalField::AuthenticationMethod.key(),
    IkeProposalField::DhGroup.key(),
    IkeProposalField::EncryptionAlgorithm.key(),
    IkeProposalField::AuthenticationAlgorithm.key(),
    IkeProposalField::LifetimeSeconds.key(),
];
pub const GAPS_IKE_PROPOSAL: &[(FieldKey, &str)] = &[];

pub const READS_IKE_POLICY: &[FieldKey] = &[
    IkePolicyField::Name.key(),
    IkePolicyField::PreSharedKey.key(),
];
pub const GAPS_IKE_POLICY: &[(FieldKey, &str)] = &[
    (
        IkePolicyField::Mode.key(),
        "R* predicate undeclarable; no card set-line; junos statement not yet built",
    ),
    (
        IkePolicyField::CertificateId.key(),
        "rsa-signatures flow not yet built",
    ),
    (
        IkePolicyField::Description.key(),
        "Text quoting rules not yet decided",
    ),
];

pub const READS_IKE_GATEWAY: &[FieldKey] = &[
    IkeGatewayField::Name.key(),
    IkeGatewayField::Peer.key(),
    IkeGatewayField::Version.key(),
];
pub const GAPS_IKE_GATEWAY: &[(FieldKey, &str)] = &[
    (
        IkeGatewayField::LocalIdentity.key(),
        "IkeId is an empty stub — value shape undecided",
    ),
    (
        IkeGatewayField::RemoteIdentity.key(),
        "IkeId is an empty stub — value shape undecided",
    ),
    (
        IkeGatewayField::Dpd.key(),
        "Dpd is an empty stub — value shape undecided; card line dead-peer-detection always-send interval 10 threshold 3 waits on it",
    ),
    (
        IkeGatewayField::NatKeepalive.key(),
        "no corpus-grounded junos statement recorded yet",
    ),
    (
        IkeGatewayField::NoNatTraversal.key(),
        "no corpus-grounded junos statement recorded yet",
    ),
    (
        IkeGatewayField::Description.key(),
        "Text quoting rules not yet decided",
    ),
];

pub const READS_IPSEC_PROPOSAL: &[FieldKey] = &[
    IpsecProposalField::Name.key(),
    IpsecProposalField::Protocol.key(),
    IpsecProposalField::EncryptionAlgorithm.key(),
    IpsecProposalField::AuthenticationAlgorithm.key(),
    IpsecProposalField::LifetimeSeconds.key(),
];
pub const GAPS_IPSEC_PROPOSAL: &[(FieldKey, &str)] = &[(
    IpsecProposalField::LifetimeKilobytes.key(),
    "statement path not corpus-grounded yet; the card names the knob, not the line",
)];

pub const READS_IPSEC_POLICY: &[FieldKey] = &[
    IpsecPolicyField::Name.key(),
    IpsecPolicyField::PerfectForwardSecrecy.key(),
];
pub const GAPS_IPSEC_POLICY: &[(FieldKey, &str)] = &[(
    IpsecPolicyField::Description.key(),
    "Text quoting rules not yet decided",
)];

pub const READS_IPSEC_VPN: &[FieldKey] = &[
    IpsecVpnField::Name.key(),
    IpsecVpnField::EstablishTunnels.key(),
    IpsecVpnField::Mode.key(),
];
pub const GAPS_IPSEC_VPN: &[(FieldKey, &str)] = &[
    (
        IpsecVpnField::DfBit.key(),
        "no corpus-grounded junos statement recorded yet",
    ),
    (
        IpsecVpnField::VpnMonitor.key(),
        "VpnMonitor stub has no shape",
    ),
    (
        IpsecVpnField::IdleTime.key(),
        "no corpus-grounded junos statement recorded yet",
    ),
    (
        IpsecVpnField::Description.key(),
        "no corpus-grounded junos statement recorded yet",
    ),
];

pub const READS_TRAFFIC_SELECTOR: &[FieldKey] = &[
    TrafficSelectorField::Name.key(),
    TrafficSelectorField::LocalIp.key(),
    TrafficSelectorField::RemoteIp.key(),
    TrafficSelectorField::Protocol.key(),
    TrafficSelectorField::LocalPorts.key(),
    TrafficSelectorField::RemotePorts.key(),
];
pub const GAPS_TRAFFIC_SELECTOR: &[(FieldKey, &str)] = &[];

/// The gap ledger of a covered kind; `None` for anything else, which cannot
/// enter the walk.
fn gaps_for(kind: NodeKind) -> Option<&'static [(FieldKey, &'static str)]> {
    match kind {
        NodeKind::IkeProposal => Some(GAPS_IKE_PROPOSAL),
        NodeKind::IkePolicy => Some(GAPS_IKE_POLICY),
        NodeKind::IkeGateway => Some(GAPS_IKE_GATEWAY),
        NodeKind::IpsecProposal => Some(GAPS_IPSEC_PROPOSAL),
        NodeKind::IpsecPolicy => Some(GAPS_IPSEC_POLICY),
        NodeKind::IpsecVpn => Some(GAPS_IPSEC_VPN),
        NodeKind::TrafficSelector => Some(GAPS_TRAFFIC_SELECTOR),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// The closed junos-srx token tables (WO-04 §4.7). Sources: field card side 1
// unless noted. A value outside a table is TokenUnmapped, never a guess.
// ---------------------------------------------------------------------------

fn token_auth_method(v: &AuthMethod) -> Result<String, BlockReason> {
    match v {
        AuthMethod::PreSharedKeys => Ok(String::from("pre-shared-keys")),
        other => Err(BlockReason::TokenUnmapped {
            value: other.canonical(),
        }),
    }
}

fn token_encryption(v: &EncryptionAlgorithm) -> Result<String, BlockReason> {
    let canonical = v.canonical();
    match canonical.as_str() {
        "aes-256-cbc" | "aes-256-gcm" => Ok(canonical),
        _ => Err(BlockReason::TokenUnmapped { value: canonical }),
    }
}

/// P1 position — `set security ike proposal … authentication-algorithm`.
fn token_integrity_p1(v: &IntegrityAlgorithm) -> Result<String, BlockReason> {
    match v {
        IntegrityAlgorithm::HmacSha256_128 => Ok(String::from("sha-256")),
        other => Err(BlockReason::TokenUnmapped {
            value: other.canonical(),
        }),
    }
}

/// P2 position — `set security ipsec proposal … authentication-algorithm`.
/// The table has no rows: the junos-srx P2 spelling is not recorded anywhere
/// this crate may cite, so a required occurrence refuses honestly.
// VERIFY: the junos-srx P2 spelling is believed to be the hmac-sha-256-128
// style; ship no row until a source is recorded.
fn token_integrity_p2(v: &IntegrityAlgorithm) -> Result<String, BlockReason> {
    Err(BlockReason::TokenUnmapped {
        value: v.canonical(),
    })
}

// VERIFY: the group<N> pattern is uniform on Junos; only 14 is card-attested,
// so only 14 ships.
fn token_dh_group(v: &DhGroup) -> Result<String, BlockReason> {
    match v.0 {
        14 => Ok(String::from("group14")),
        _ => Err(BlockReason::TokenUnmapped {
            value: v.canonical(),
        }),
    }
}

fn token_ike_version(v: &IkeVersion) -> Result<String, BlockReason> {
    match v {
        IkeVersion::V2Only => Ok(String::from("v2-only")),
        other => Err(BlockReason::TokenUnmapped {
            value: other.canonical(),
        }),
    }
}

fn token_ipsec_protocol(v: &IpsecProposalProtocol) -> Result<String, BlockReason> {
    match v {
        IpsecProposalProtocol::Esp => Ok(String::from("esp")),
        IpsecProposalProtocol::Unknown(_) => Err(BlockReason::EnumUnknownArm),
        other => Err(BlockReason::TokenUnmapped {
            value: other.token().to_owned(),
        }),
    }
}

fn token_establish_tunnels(v: &EstablishTunnels) -> Result<String, BlockReason> {
    match v {
        EstablishTunnels::Immediately => Ok(String::from("immediately")),
        // Card side 3, quoted in the generated enum's doc comment.
        EstablishTunnels::OnTraffic => Ok(String::from("on-traffic")),
        EstablishTunnels::Unknown(_) => Err(BlockReason::EnumUnknownArm),
        other => Err(BlockReason::TokenUnmapped {
            value: other.token().to_owned(),
        }),
    }
}

// ---------------------------------------------------------------------------
// The read discipline (WO-04 §4.4). The store holds three presence states, so
// `13` §6.5's four-state table reduces to `need` and `opt`. There is no
// `unwrap_or_default` in this crate: a default supplied by the emitter is a
// value the user never chose.
// ---------------------------------------------------------------------------

/// What a failing row records: the field it failed on (where there is one)
/// and why.
type RowErr = (Option<FieldKey>, BlockReason);

/// A row's outcome: a line, nothing (the only silent case — `13` §1.1's
/// Skip), or a blocker in the position the line would have occupied.
type Row = Result<Option<EmittedLine>, RowErr>;

fn node_of(graph: &Graph, id: NodeId) -> &Node {
    graph
        .node(id)
        .expect("every emit-unit member was read out of this graph")
}

fn presence(graph: &Graph, node: NodeId, key: FieldKey) -> StoredPresence {
    graph
        .presence(node.into(), key)
        .expect("a declared field of an existing node")
        .presence
}

/// Rows marked `R`, and `R*` rows whose condition holds.
fn need<'g, T, F>(graph: &'g Graph, node: NodeId, key: FieldKey, read: F) -> Result<&'g T, RowErr>
where
    F: FnOnce(&'g Node) -> Result<&'g T, FieldError>,
{
    match presence(graph, node, key) {
        StoredPresence::Absent => Err((Some(key), BlockReason::RequiredAbsent)),
        StoredPresence::Unknown => Err((Some(key), BlockReason::RequiredUnknown)),
        StoredPresence::Set => Ok(read(node_of(graph, node))
            .expect("a Set slot holds the schema-declared type; the store refuses anything else")),
    }
}

/// Rows marked `O`. `Absent` and `Unknown` alike skip, silently.
fn opt<'g, T, F>(graph: &'g Graph, node: NodeId, key: FieldKey, read: F) -> Option<&'g T>
where
    F: FnOnce(&'g Node) -> Result<&'g T, FieldError>,
{
    match presence(graph, node, key) {
        StoredPresence::Set => {
            Some(read(node_of(graph, node)).expect("a Set slot holds the schema-declared type"))
        }
        StoredPresence::Absent | StoredPresence::Unknown => None,
    }
}

fn at(key: FieldKey) -> impl Fn(BlockReason) -> RowErr {
    move |reason| (Some(key), reason)
}

fn subject(node: NodeId, key: FieldKey) -> FieldRef {
    FieldRef {
        node,
        field: key,
        role: FieldRole::Subject,
    }
}

fn value_of(node: NodeId, key: FieldKey) -> FieldRef {
    FieldRef {
        node,
        field: key,
        role: FieldRole::Value,
    }
}

fn referenced(node: NodeId, key: FieldKey) -> FieldRef {
    FieldRef {
        node,
        field: key,
        role: FieldRole::Referenced,
    }
}

fn conditioning(node: NodeId, key: FieldKey) -> FieldRef {
    FieldRef {
        node,
        field: key,
        role: FieldRole::Conditioning,
    }
}

fn kws(words: &[&'static str]) -> Vec<PathToken> {
    words.iter().map(|w| PathToken::Kw(w)).collect()
}

/// `[security, <area>, <object>, Name(name), …tail]` — the shape every
/// statement in this slice has.
fn path(head: &[&'static str], name: &str, tail: &[&'static str]) -> StatementPath {
    let mut tokens = kws(head);
    tokens.push(PathToken::Name(name.to_owned()));
    tokens.extend(kws(tail));
    StatementPath { tokens }
}

fn record(
    lines: &mut Vec<EmittedLine>,
    report: &mut EmitReport,
    node: NodeId,
    block: BlockId,
    order_hint: u32,
    row: Row,
) {
    match row {
        Ok(Some(line)) => lines.push(line),
        Ok(None) => {}
        Err((field, reason)) => report.blockers.push(Blocker {
            node,
            field,
            block,
            order_hint,
            reason,
        }),
    }
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

pub(crate) fn emit_node(
    graph: &Graph,
    member: &Member,
    unit: &[Member],
    lines: &mut Vec<EmittedLine>,
    report: &mut EmitReport,
) {
    match member.node.kind {
        NodeKind::IkeProposal => emit_ike_proposal(graph, member, lines, report),
        NodeKind::IkePolicy => emit_ike_policy(graph, member, lines, report),
        NodeKind::IkeGateway => emit_ike_gateway(graph, member, lines, report),
        NodeKind::IpsecProposal => emit_ipsec_proposal(graph, member, lines, report),
        NodeKind::IpsecPolicy => emit_ipsec_policy(graph, member, lines, report),
        NodeKind::IpsecVpn => emit_ipsec_vpn(graph, member, unit, lines, report),
        // LogicalUnit is read for naming only; nothing else can enter the walk.
        _ => {}
    }
}

/// The gap ledger: one entry per covered-kind node whose gap field is `Set`
/// or explicitly `Absent`. An `Unknown` gap field reports nothing — nobody
/// has said anything about it, so there is nothing we failed to express.
pub(crate) fn collect_gaps(graph: &Graph, unit: &[Member], report: &mut EmitReport) {
    for member in unit {
        let Some(gaps) = gaps_for(member.node.kind) else {
            continue;
        };
        for (key, tracking) in gaps {
            match presence(graph, member.node, *key) {
                StoredPresence::Set | StoredPresence::Absent => report.gaps.push(GapEntry {
                    node: member.node,
                    field: *key,
                    tracking,
                }),
                StoredPresence::Unknown => {}
            }
        }
    }
    report.gaps.sort_by_key(|g| (g.node, g.field));
}

// ---------------------------------------------------------------------------
// IkeProposal
// ---------------------------------------------------------------------------

const P1_HEAD: &[&str] = &["security", "ike", "proposal"];

fn emit_ike_proposal(
    graph: &Graph,
    member: &Member,
    lines: &mut Vec<EmittedLine>,
    report: &mut EmitReport,
) {
    let node = member.node;
    let block = block_of(node.kind);
    let base = member.ordinal.saturating_mul(1000);
    let name_key = IkeProposalField::Name.key();
    let enc_key = IkeProposalField::EncryptionAlgorithm.key();
    let auth_key = IkeProposalField::AuthenticationAlgorithm.key();

    // The R* condition, evaluated once: with AEAD encryption the
    // authentication-algorithm line does not exist, and the encryption field
    // is what determined that (13 §2.2's Conditioning role).
    let aead_suppressed = matches!(
        opt(graph, node, enc_key, ike_proposal::encryption_algorithm),
        Some(e) if e.aead
    ) && presence(graph, node, auth_key) != StoredPresence::Set;

    // Row 10 — authentication-method
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_proposal::name)?;
        let key = IkeProposalField::AuthenticationMethod.key();
        let v = need(graph, node, key, ike_proposal::authentication_method)?;
        let token = token_auth_method(v).map_err(at(key))?;
        Ok(Some(EmittedLine::new(
            format!(
                "set security ike proposal {} authentication-method {token}",
                name.0
            ),
            path(P1_HEAD, &name.0, &["authentication-method"]),
            node,
            vec![subject(node, name_key), value_of(node, key)],
            Idempotency::Idempotent,
            block,
            base + 10,
            "explain:field:IkeProposal.authentication_method",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 10, row);

    // Row 20 — dh-group
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_proposal::name)?;
        let key = IkeProposalField::DhGroup.key();
        let v = need(graph, node, key, ike_proposal::dh_group)?;
        let token = token_dh_group(v).map_err(at(key))?;
        Ok(Some(EmittedLine::new(
            format!("set security ike proposal {} dh-group {token}", name.0),
            path(P1_HEAD, &name.0, &["dh-group"]),
            node,
            vec![subject(node, name_key), value_of(node, key)],
            Idempotency::Idempotent,
            block,
            base + 20,
            "explain:field:IkeProposal.dh_group",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 20, row);

    // Row 30 — authentication-algorithm, R* on encryption_algorithm.aead
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_proposal::name)?;
        let enc = need(graph, node, enc_key, ike_proposal::encryption_algorithm)?;
        if enc.aead {
            return if presence(graph, node, auth_key) == StoredPresence::Set {
                Err((Some(auth_key), BlockReason::AeadExcludesAuth))
            } else {
                Ok(None)
            };
        }
        let v = need(
            graph,
            node,
            auth_key,
            ike_proposal::authentication_algorithm,
        )?;
        let token = token_integrity_p1(v).map_err(at(auth_key))?;
        Ok(Some(EmittedLine::new(
            format!(
                "set security ike proposal {} authentication-algorithm {token}",
                name.0
            ),
            path(P1_HEAD, &name.0, &["authentication-algorithm"]),
            node,
            vec![
                subject(node, name_key),
                value_of(node, auth_key),
                conditioning(node, enc_key),
            ],
            Idempotency::Idempotent,
            block,
            base + 30,
            "explain:field:IkeProposal.authentication_algorithm",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 30, row);

    // Row 40 — encryption-algorithm
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_proposal::name)?;
        let v = need(graph, node, enc_key, ike_proposal::encryption_algorithm)?;
        let token = token_encryption(v).map_err(at(enc_key))?;
        let mut fields = vec![subject(node, name_key), value_of(node, enc_key)];
        if aead_suppressed {
            fields.push(conditioning(node, enc_key));
        }
        Ok(Some(EmittedLine::new(
            format!(
                "set security ike proposal {} encryption-algorithm {token}",
                name.0
            ),
            path(P1_HEAD, &name.0, &["encryption-algorithm"]),
            node,
            fields,
            Idempotency::Idempotent,
            block,
            base + 40,
            "explain:field:IkeProposal.encryption_algorithm",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 40, row);

    // Row 50 — lifetime-seconds
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_proposal::name)?;
        let key = IkeProposalField::LifetimeSeconds.key();
        let Some(v) = opt(graph, node, key, ike_proposal::lifetime_seconds) else {
            return Ok(None);
        };
        Ok(Some(EmittedLine::new(
            format!(
                "set security ike proposal {} lifetime-seconds {}",
                name.0,
                v.canonical()
            ),
            path(P1_HEAD, &name.0, &["lifetime-seconds"]),
            node,
            vec![subject(node, name_key), value_of(node, key)],
            Idempotency::Idempotent,
            block,
            base + 50,
            "explain:field:IkeProposal.lifetime_seconds",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 50, row);
}

// ---------------------------------------------------------------------------
// IkePolicy
// ---------------------------------------------------------------------------

const IKE_POLICY_HEAD: &[&str] = &["security", "ike", "policy"];

fn emit_ike_policy(
    graph: &Graph,
    member: &Member,
    lines: &mut Vec<EmittedLine>,
    report: &mut EmitReport,
) {
    let node = member.node;
    let block = block_of(node.kind);
    let base = member.ordinal.saturating_mul(1000);
    let name_key = IkePolicyField::Name.key();

    // Row 10 — proposals, one line per UsesProposal edge
    let hint = base + 10;
    match (|| -> Result<Vec<EmittedLine>, RowErr> {
        let name = need(graph, node, name_key, ike_policy::name)?;
        let edges = plan::proposals(graph, node);
        if edges.is_empty() {
            return Err((
                None,
                BlockReason::MissingRequiredEdge {
                    edge: EdgeKind::UsesProposal,
                },
            ));
        }
        let mut out = Vec::new();
        for target in edges.iter().map(|e| e.to) {
            let target_key = IkeProposalField::Name.key();
            let proposal = need(graph, target, target_key, ike_proposal::name)?;
            let mut tokens = kws(IKE_POLICY_HEAD);
            tokens.push(PathToken::Name(name.0.clone()));
            tokens.push(PathToken::Kw("proposals"));
            tokens.push(PathToken::Member(proposal.0.clone()));
            out.push(EmittedLine::new(
                format!(
                    "set security ike policy {} proposals {}",
                    name.0, proposal.0
                ),
                StatementPath { tokens },
                node,
                vec![subject(node, name_key), referenced(target, target_key)],
                Idempotency::Accumulating,
                block,
                hint,
                "explain:field:IkePolicy.uses_proposal",
                Vec::new(),
            ));
        }
        Ok(out)
    })() {
        Ok(rows) => lines.extend(rows),
        Err((field, reason)) => report.blockers.push(Blocker {
            node,
            field,
            block,
            order_hint: hint,
            reason,
        }),
    }

    // Row 20 — pre-shared-key. A correct emit, not a blocked one: the
    // placeholder is the value, and the hint never touches `text`.
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_policy::name)?;
        let key = IkePolicyField::PreSharedKey.key();
        let Some(secret) = opt(graph, node, key, ike_policy::pre_shared_key) else {
            return Ok(None);
        };
        let token = secret.placeholder();
        let prefix = format!(
            "set security ike policy {} pre-shared-key ascii-text \"",
            name.0
        );
        let start = u32::try_from(prefix.len()).unwrap_or(u32::MAX);
        let end = start.saturating_add(u32::try_from(token.len()).unwrap_or(0));
        let text = format!("{prefix}{token}\"");
        Ok(Some(EmittedLine::new(
            text,
            path(IKE_POLICY_HEAD, &name.0, &["pre-shared-key", "ascii-text"]),
            node,
            vec![subject(node, name_key), value_of(node, key)],
            Idempotency::Idempotent,
            block,
            base + 20,
            "explain:field:IkePolicy.pre_shared_key",
            vec![PlaceholderSpan {
                start,
                end,
                label: secret.label(),
                site: value_of(node, key),
            }],
        )))
    })();
    record(lines, report, node, block, base + 20, row);
}

// ---------------------------------------------------------------------------
// IkeGateway
// ---------------------------------------------------------------------------

const GATEWAY_HEAD: &[&str] = &["security", "ike", "gateway"];

fn emit_ike_gateway(
    graph: &Graph,
    member: &Member,
    lines: &mut Vec<EmittedLine>,
    report: &mut EmitReport,
) {
    let node = member.node;
    let block = block_of(node.kind);
    let base = member.ordinal.saturating_mul(1000);
    let name_key = IkeGatewayField::Name.key();

    // Row 10 — ike-policy
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_gateway::name)?;
        let target = plan::first_target(graph, node, EdgeKind::UsesIkePolicy).ok_or((
            None,
            BlockReason::MissingRequiredEdge {
                edge: EdgeKind::UsesIkePolicy,
            },
        ))?;
        let policy_key = IkePolicyField::Name.key();
        let policy = need(graph, target, policy_key, ike_policy::name)?;
        Ok(Some(EmittedLine::new(
            format!(
                "set security ike gateway {} ike-policy {}",
                name.0, policy.0
            ),
            path(GATEWAY_HEAD, &name.0, &["ike-policy"]),
            node,
            vec![subject(node, name_key), referenced(target, policy_key)],
            Idempotency::Idempotent,
            block,
            base + 10,
            "explain:field:IkeGateway.uses_ike_policy",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 10, row);

    // Row 20 — address
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_gateway::name)?;
        let key = IkeGatewayField::Peer.key();
        let peer = need(graph, node, key, ike_gateway::peer)?;
        let address = match peer {
            PeerSpec::Address(ip) => ip.canonical(),
            PeerSpec::Dynamic(_) => {
                return Err((Some(key), BlockReason::DynamicPeerNotCovered));
            }
        };
        Ok(Some(EmittedLine::new(
            format!("set security ike gateway {} address {address}", name.0),
            path(GATEWAY_HEAD, &name.0, &["address"]),
            node,
            vec![subject(node, name_key), value_of(node, key)],
            Idempotency::Idempotent,
            block,
            base + 20,
            "explain:field:IkeGateway.peer",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 20, row);

    // Row 30 — external-interface
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_gateway::name)?;
        let unit = plan::first_target(graph, node, EdgeKind::ExternalInterface).ok_or((
            None,
            BlockReason::MissingRequiredEdge {
                edge: EdgeKind::ExternalInterface,
            },
        ))?;
        let (rendered, refs) = unit_name(graph, unit)?;
        let mut fields = vec![subject(node, name_key)];
        fields.extend(refs);
        Ok(Some(EmittedLine::new(
            format!(
                "set security ike gateway {} external-interface {rendered}",
                name.0
            ),
            path(GATEWAY_HEAD, &name.0, &["external-interface"]),
            node,
            fields,
            Idempotency::Idempotent,
            block,
            base + 30,
            "explain:field:IkeGateway.external_interface",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 30, row);

    // Row 40 — version
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ike_gateway::name)?;
        let key = IkeGatewayField::Version.key();
        let Some(v) = opt(graph, node, key, ike_gateway::version) else {
            return Ok(None);
        };
        let token = token_ike_version(v).map_err(at(key))?;
        Ok(Some(EmittedLine::new(
            format!("set security ike gateway {} version {token}", name.0),
            path(GATEWAY_HEAD, &name.0, &["version"]),
            node,
            vec![subject(node, name_key), value_of(node, key)],
            Idempotency::Idempotent,
            block,
            base + 40,
            "explain:field:IkeGateway.version",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 40, row);
}

/// `st0.0` is rendered from (TunnelInterface st0, index 0), never stored
/// joined (`11` §4.6 via the schema doc). The raw interface name wins
/// byte-for-byte.
fn unit_name(graph: &Graph, unit: NodeId) -> Result<(String, Vec<FieldRef>), RowErr> {
    let index_key = LogicalUnitField::Index.key();
    let index = need(graph, unit, index_key, logical_unit::index)?;
    // `HasUnit` declares `in: "1"`, so an uncontained unit is a store the
    // emitter cannot name; the containment edge is what is missing.
    let owner = graph.owner(unit).ok_or((
        None,
        BlockReason::MissingRequiredEdge {
            edge: EdgeKind::HasUnit,
        },
    ))?;
    let (name, name_key) = match owner.kind {
        NodeKind::Interface => {
            let k = InterfaceField::Name.key();
            (need(graph, owner, k, interface::name)?, k)
        }
        NodeKind::AggregateInterface => {
            let k = AggregateInterfaceField::Name.key();
            (need(graph, owner, k, aggregate_interface::name)?, k)
        }
        NodeKind::RethInterface => {
            let k = RethInterfaceField::Name.key();
            (need(graph, owner, k, reth_interface::name)?, k)
        }
        NodeKind::TunnelInterface => {
            let k = TunnelInterfaceField::Name.key();
            (need(graph, owner, k, tunnel_interface::name)?, k)
        }
        _ => {
            return Err((
                None,
                BlockReason::MissingRequiredEdge {
                    edge: EdgeKind::HasUnit,
                },
            ))
        }
    };
    Ok((
        format!("{}.{index}", name.0),
        vec![referenced(unit, index_key), referenced(owner, name_key)],
    ))
}

// ---------------------------------------------------------------------------
// IpsecProposal
// ---------------------------------------------------------------------------

const P2_HEAD: &[&str] = &["security", "ipsec", "proposal"];

fn emit_ipsec_proposal(
    graph: &Graph,
    member: &Member,
    lines: &mut Vec<EmittedLine>,
    report: &mut EmitReport,
) {
    let node = member.node;
    let block = block_of(node.kind);
    let base = member.ordinal.saturating_mul(1000);
    let name_key = IpsecProposalField::Name.key();
    let protocol_key = IpsecProposalField::Protocol.key();
    let enc_key = IpsecProposalField::EncryptionAlgorithm.key();
    let auth_key = IpsecProposalField::AuthenticationAlgorithm.key();

    let aead_suppressed = matches!(
        opt(graph, node, enc_key, ipsec_proposal::encryption_algorithm),
        Some(e) if e.aead
    ) && presence(graph, node, auth_key) != StoredPresence::Set;

    // Row 10 — protocol
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ipsec_proposal::name)?;
        let v = need(graph, node, protocol_key, ipsec_proposal::protocol)?;
        let token = token_ipsec_protocol(v).map_err(at(protocol_key))?;
        Ok(Some(EmittedLine::new(
            format!("set security ipsec proposal {} protocol {token}", name.0),
            path(P2_HEAD, &name.0, &["protocol"]),
            node,
            vec![subject(node, name_key), value_of(node, protocol_key)],
            Idempotency::Idempotent,
            block,
            base + 10,
            "explain:field:IpsecProposal.protocol",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 10, row);

    // Row 20 — encryption-algorithm, R* on protocol == Esp
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ipsec_proposal::name)?;
        let protocol = need(graph, node, protocol_key, ipsec_proposal::protocol)?;
        let esp = matches!(protocol, IpsecProposalProtocol::Esp);
        // ESP: the field is required. Otherwise the protocol row has already
        // refused, so this row only carries a value the user did set.
        let v = if esp {
            need(graph, node, enc_key, ipsec_proposal::encryption_algorithm)?
        } else {
            match opt(graph, node, enc_key, ipsec_proposal::encryption_algorithm) {
                Some(v) => v,
                None => return Ok(None),
            }
        };
        let token = token_encryption(v).map_err(at(enc_key))?;
        let mut fields = vec![subject(node, name_key), value_of(node, enc_key)];
        if aead_suppressed {
            fields.push(conditioning(node, enc_key));
        }
        Ok(Some(EmittedLine::new(
            format!(
                "set security ipsec proposal {} encryption-algorithm {token}",
                name.0
            ),
            path(P2_HEAD, &name.0, &["encryption-algorithm"]),
            node,
            fields,
            Idempotency::Idempotent,
            block,
            base + 20,
            "explain:field:IpsecProposal.encryption_algorithm",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 20, row);

    // Row 30 — authentication-algorithm, R* on encryption_algorithm.aead.
    // The P2 token table is empty, so a required occurrence blocks — an
    // honest refusal, never a guessed token.
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ipsec_proposal::name)?;
        let enc = need(graph, node, enc_key, ipsec_proposal::encryption_algorithm)?;
        if enc.aead {
            return if presence(graph, node, auth_key) == StoredPresence::Set {
                Err((Some(auth_key), BlockReason::AeadExcludesAuth))
            } else {
                Ok(None)
            };
        }
        let v = need(
            graph,
            node,
            auth_key,
            ipsec_proposal::authentication_algorithm,
        )?;
        let token = token_integrity_p2(v).map_err(at(auth_key))?;
        Ok(Some(EmittedLine::new(
            format!(
                "set security ipsec proposal {} authentication-algorithm {token}",
                name.0
            ),
            path(P2_HEAD, &name.0, &["authentication-algorithm"]),
            node,
            vec![
                subject(node, name_key),
                value_of(node, auth_key),
                conditioning(node, enc_key),
            ],
            Idempotency::Idempotent,
            block,
            base + 30,
            "explain:field:IpsecProposal.authentication_algorithm",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 30, row);

    // Row 40 — lifetime-seconds
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ipsec_proposal::name)?;
        let key = IpsecProposalField::LifetimeSeconds.key();
        let Some(v) = opt(graph, node, key, ipsec_proposal::lifetime_seconds) else {
            return Ok(None);
        };
        Ok(Some(EmittedLine::new(
            format!(
                "set security ipsec proposal {} lifetime-seconds {}",
                name.0,
                v.canonical()
            ),
            path(P2_HEAD, &name.0, &["lifetime-seconds"]),
            node,
            vec![subject(node, name_key), value_of(node, key)],
            Idempotency::Idempotent,
            block,
            base + 40,
            "explain:field:IpsecProposal.lifetime_seconds",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 40, row);
}

// ---------------------------------------------------------------------------
// IpsecPolicy
// ---------------------------------------------------------------------------

const IPSEC_POLICY_HEAD: &[&str] = &["security", "ipsec", "policy"];

fn emit_ipsec_policy(
    graph: &Graph,
    member: &Member,
    lines: &mut Vec<EmittedLine>,
    report: &mut EmitReport,
) {
    let node = member.node;
    let block = block_of(node.kind);
    let base = member.ordinal.saturating_mul(1000);
    let name_key = IpsecPolicyField::Name.key();

    // Row 10 — perfect-forward-secrecy. `Absent` emits nothing: on Junos
    // "no PFS" is the absence of the statement (13 §8.5).
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ipsec_policy::name)?;
        let key = IpsecPolicyField::PerfectForwardSecrecy.key();
        let Some(v) = opt(graph, node, key, ipsec_policy::perfect_forward_secrecy) else {
            return Ok(None);
        };
        let token = token_dh_group(v).map_err(at(key))?;
        Ok(Some(EmittedLine::new(
            format!(
                "set security ipsec policy {} perfect-forward-secrecy keys {token}",
                name.0
            ),
            path(
                IPSEC_POLICY_HEAD,
                &name.0,
                &["perfect-forward-secrecy", "keys"],
            ),
            node,
            vec![subject(node, name_key), value_of(node, key)],
            Idempotency::Idempotent,
            block,
            base + 10,
            "explain:field:IpsecPolicy.perfect_forward_secrecy",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 10, row);

    // Row 20 — proposals
    let hint = base + 20;
    match (|| -> Result<Vec<EmittedLine>, RowErr> {
        let name = need(graph, node, name_key, ipsec_policy::name)?;
        let edges = plan::proposals(graph, node);
        if edges.is_empty() {
            return Err((
                None,
                BlockReason::MissingRequiredEdge {
                    edge: EdgeKind::UsesProposal,
                },
            ));
        }
        let mut out = Vec::new();
        for target in edges.iter().map(|e| e.to) {
            let target_key = IpsecProposalField::Name.key();
            let proposal = need(graph, target, target_key, ipsec_proposal::name)?;
            let mut tokens = kws(IPSEC_POLICY_HEAD);
            tokens.push(PathToken::Name(name.0.clone()));
            tokens.push(PathToken::Kw("proposals"));
            tokens.push(PathToken::Member(proposal.0.clone()));
            out.push(EmittedLine::new(
                format!(
                    "set security ipsec policy {} proposals {}",
                    name.0, proposal.0
                ),
                StatementPath { tokens },
                node,
                vec![subject(node, name_key), referenced(target, target_key)],
                Idempotency::Accumulating,
                block,
                hint,
                "explain:field:IpsecPolicy.uses_proposal",
                Vec::new(),
            ));
        }
        Ok(out)
    })() {
        Ok(rows) => lines.extend(rows),
        Err((field, reason)) => report.blockers.push(Blocker {
            node,
            field,
            block,
            order_hint: hint,
            reason,
        }),
    }
}

// ---------------------------------------------------------------------------
// IpsecVpn + TrafficSelector
// ---------------------------------------------------------------------------

const VPN_HEAD: &[&str] = &["security", "ipsec", "vpn"];

fn emit_ipsec_vpn(
    graph: &Graph,
    member: &Member,
    unit: &[Member],
    lines: &mut Vec<EmittedLine>,
    report: &mut EmitReport,
) {
    let node = member.node;
    let block = block_of(node.kind);
    let base = member.ordinal.saturating_mul(1000);
    let name_key = IpsecVpnField::Name.key();
    let mode_key = IpsecVpnField::Mode.key();

    // Row 10 — ike gateway
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ipsec_vpn::name)?;
        let target = plan::first_target(graph, node, EdgeKind::UsesIkeGateway).ok_or((
            None,
            BlockReason::MissingRequiredEdge {
                edge: EdgeKind::UsesIkeGateway,
            },
        ))?;
        let gw_key = IkeGatewayField::Name.key();
        let gw = need(graph, target, gw_key, ike_gateway::name)?;
        Ok(Some(EmittedLine::new(
            format!("set security ipsec vpn {} ike gateway {}", name.0, gw.0),
            path(VPN_HEAD, &name.0, &["ike", "gateway"]),
            node,
            vec![subject(node, name_key), referenced(target, gw_key)],
            Idempotency::Idempotent,
            block,
            base + 10,
            "explain:field:IpsecVpn.uses_ike_gateway",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 10, row);

    // Row 20 — ike ipsec-policy
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ipsec_vpn::name)?;
        let target = plan::first_target(graph, node, EdgeKind::UsesIpsecPolicy).ok_or((
            None,
            BlockReason::MissingRequiredEdge {
                edge: EdgeKind::UsesIpsecPolicy,
            },
        ))?;
        let policy_key = IpsecPolicyField::Name.key();
        let policy = need(graph, target, policy_key, ipsec_policy::name)?;
        Ok(Some(EmittedLine::new(
            format!(
                "set security ipsec vpn {} ike ipsec-policy {}",
                name.0, policy.0
            ),
            path(VPN_HEAD, &name.0, &["ike", "ipsec-policy"]),
            node,
            vec![subject(node, name_key), referenced(target, policy_key)],
            Idempotency::Idempotent,
            block,
            base + 20,
            "explain:field:IpsecVpn.uses_ipsec_policy",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 20, row);

    // Row 30 — bind-interface. `mode` produces no statement of its own: on
    // Junos the mode is structural, and Conditioning is exactly 13 §2.2's
    // "did not appear in the text but determined that the line exists at all".
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ipsec_vpn::name)?;
        let mode = need(graph, node, mode_key, ipsec_vpn::mode)?;
        match mode {
            VpnMode::PolicyBased => {
                return Err((Some(mode_key), BlockReason::PolicyBasedNotCovered))
            }
            VpnMode::Unknown(_) => return Err((Some(mode_key), BlockReason::EnumUnknownArm)),
            VpnMode::RouteBased => {}
        }
        let target = plan::first_target(graph, node, EdgeKind::BindsInterface).ok_or((
            None,
            BlockReason::MissingRequiredEdge {
                edge: EdgeKind::BindsInterface,
            },
        ))?;
        let (rendered, refs) = unit_name(graph, target)?;
        let mut fields = vec![subject(node, name_key)];
        fields.extend(refs);
        fields.push(conditioning(node, mode_key));
        Ok(Some(EmittedLine::new(
            format!(
                "set security ipsec vpn {} bind-interface {rendered}",
                name.0
            ),
            path(VPN_HEAD, &name.0, &["bind-interface"]),
            node,
            fields,
            Idempotency::Idempotent,
            block,
            base + 30,
            "explain:field:IpsecVpn.binds_interface",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 30, row);

    // Row 40 — establish-tunnels
    let row = (|| -> Row {
        let name = need(graph, node, name_key, ipsec_vpn::name)?;
        let key = IpsecVpnField::EstablishTunnels.key();
        let Some(v) = opt(graph, node, key, ipsec_vpn::establish_tunnels) else {
            return Ok(None);
        };
        let token = token_establish_tunnels(v).map_err(at(key))?;
        Ok(Some(EmittedLine::new(
            format!(
                "set security ipsec vpn {} establish-tunnels {token}",
                name.0
            ),
            path(VPN_HEAD, &name.0, &["establish-tunnels"]),
            node,
            vec![subject(node, name_key), value_of(node, key)],
            Idempotency::Idempotent,
            block,
            base + 40,
            "explain:field:IpsecVpn.establish_tunnels",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, base + 40, row);

    // Rows 500+i — traffic selectors, riding the IpsecVpn ordinal.
    for (i, selector) in plan::selectors(graph, node).into_iter().enumerate() {
        if plan::ordinal_of(unit, selector).is_none() {
            continue;
        }
        let hint = base + 500 + u32::try_from(i).unwrap_or(0);
        let selector_block = block_of(selector.kind);
        emit_traffic_selector(graph, node, selector, hint, selector_block, lines, report);
    }
}

fn emit_traffic_selector(
    graph: &Graph,
    vpn: NodeId,
    node: NodeId,
    hint: u32,
    block: BlockId,
    lines: &mut Vec<EmittedLine>,
    report: &mut EmitReport,
) {
    // The unsupported terms first: a Set value this platform cannot express
    // is refused loudly, never dropped (13 §9).
    let mut refused = false;
    for key in [
        TrafficSelectorField::Protocol.key(),
        TrafficSelectorField::LocalPorts.key(),
        TrafficSelectorField::RemotePorts.key(),
    ] {
        if presence(graph, node, key) == StoredPresence::Set {
            refused = true;
            report.blockers.push(Blocker {
                node,
                field: Some(key),
                block,
                order_hint: hint,
                reason: BlockReason::SelectorTermUnsupported,
            });
        }
    }
    if refused {
        return;
    }

    let vpn_name_key = IpsecVpnField::Name.key();
    let name_key = TrafficSelectorField::Name.key();
    let local_key = TrafficSelectorField::LocalIp.key();
    let remote_key = TrafficSelectorField::RemoteIp.key();

    let row = (|| -> Row {
        let vpn_name = need(graph, vpn, vpn_name_key, ipsec_vpn::name)?;
        let name = need(graph, node, name_key, traffic_selector::name)?;
        let local = need(graph, node, local_key, traffic_selector::local_ip)?;
        let remote = need(graph, node, remote_key, traffic_selector::remote_ip)?;
        let mut tokens = kws(VPN_HEAD);
        tokens.push(PathToken::Name(vpn_name.0.clone()));
        tokens.push(PathToken::Kw("traffic-selector"));
        tokens.push(PathToken::Name(name.0.clone()));
        tokens.push(PathToken::Kw("local-ip"));
        tokens.push(PathToken::Kw("remote-ip"));
        Ok(Some(EmittedLine::new(
            format!(
                "set security ipsec vpn {} traffic-selector {} local-ip {} remote-ip {}",
                vpn_name.0,
                name.0,
                local.canonical(),
                remote.canonical()
            ),
            StatementPath { tokens },
            node,
            vec![
                referenced(vpn, vpn_name_key),
                subject(node, name_key),
                value_of(node, local_key),
                value_of(node, remote_key),
            ],
            Idempotency::Replacing,
            block,
            hint,
            "explain:kind:TrafficSelector",
            Vec::new(),
        )))
    })();
    record(lines, report, node, block, hint, row);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_tables_map_the_attested_rows_and_refuse_the_rest() {
        assert_eq!(
            token_auth_method(&AuthMethod::PreSharedKeys).expect("row"),
            "pre-shared-keys"
        );
        assert_eq!(
            token_auth_method(&AuthMethod::RsaSignatures),
            Err(BlockReason::TokenUnmapped {
                value: String::from("rsa-signatures")
            })
        );

        let cbc = EncryptionAlgorithm::parse("aes-256-cbc").expect("canonical");
        let gcm = EncryptionAlgorithm::parse("aes-256-gcm").expect("canonical");
        let weak = EncryptionAlgorithm::parse("3des-cbc").expect("canonical");
        assert_eq!(token_encryption(&cbc).expect("row"), "aes-256-cbc");
        assert_eq!(token_encryption(&gcm).expect("row"), "aes-256-gcm");
        assert_eq!(
            token_encryption(&weak),
            Err(BlockReason::TokenUnmapped {
                value: String::from("3des-cbc")
            })
        );

        assert_eq!(
            token_integrity_p1(&IntegrityAlgorithm::HmacSha256_128).expect("row"),
            "sha-256"
        );
        assert_eq!(
            token_integrity_p1(&IntegrityAlgorithm::HmacSha1_96),
            Err(BlockReason::TokenUnmapped {
                value: String::from("hmac-sha1-96")
            })
        );
        // The P2 table has no rows at all.
        assert_eq!(
            token_integrity_p2(&IntegrityAlgorithm::HmacSha256_128),
            Err(BlockReason::TokenUnmapped {
                value: String::from("hmac-sha-256-128")
            })
        );

        assert_eq!(token_dh_group(&DhGroup(14)).expect("row"), "group14");
        assert_eq!(
            token_dh_group(&DhGroup(5)),
            Err(BlockReason::TokenUnmapped {
                value: String::from("5")
            })
        );

        assert_eq!(
            token_ike_version(&IkeVersion::V2Only).expect("row"),
            "v2-only"
        );
        assert_eq!(
            token_ike_version(&IkeVersion::V1Only),
            Err(BlockReason::TokenUnmapped {
                value: String::from("v1-only")
            })
        );

        assert_eq!(
            token_ipsec_protocol(&IpsecProposalProtocol::Esp).expect("row"),
            "esp"
        );
        assert_eq!(
            token_ipsec_protocol(&IpsecProposalProtocol::Ah),
            Err(BlockReason::TokenUnmapped {
                value: String::from("ah")
            })
        );
        assert_eq!(
            token_ipsec_protocol(&IpsecProposalProtocol::Unknown(String::from("xyz"))),
            Err(BlockReason::EnumUnknownArm)
        );

        assert_eq!(
            token_establish_tunnels(&EstablishTunnels::Immediately).expect("row"),
            "immediately"
        );
        assert_eq!(
            token_establish_tunnels(&EstablishTunnels::OnTraffic).expect("row"),
            "on-traffic"
        );
        assert_eq!(
            token_establish_tunnels(&EstablishTunnels::ResponderOnly),
            Err(BlockReason::TokenUnmapped {
                value: String::from("responder_only")
            })
        );
        assert_eq!(
            token_establish_tunnels(&EstablishTunnels::Unknown(String::from("zzz"))),
            Err(BlockReason::EnumUnknownArm)
        );
    }
}
