//! Stage 5 and 6 — bind and resolve: statements become a typed graph
//! fragment (`14` §7).
//!
//! Only terminals bind; `upsert` is within the fragment, never onto a graph;
//! a scalar parse failure does not fail the line. The fragment mints no
//! ULIDs — `fathom-id` deliberately has no constructor that reads a clock or
//! an RNG, so nodes are dense indices and identity is the store weld's work
//! (§4.8).

use std::collections::{BTreeMap, BTreeSet};

use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{
    AddressFamily, EdgeKind, EstablishTunnels, Family, HostProtocol, HostService, IkePolicyMode,
    IpsecProposalProtocol, IpsecVpnDfBit, NodeKind,
};
use fathom_ir::scalar::{self, Scalar};
use fathom_ir::value::PeerSpec;

use crate::dict::{Dictionary, EdgeTarget, Entry, KindSpec, Match, SetEnumTy, ValueSpec, ValueTy};
use crate::frame::{ByteSpan, Diag, LineOrdinal, LineOutcome, Outcome, ShapeError};
use crate::redact;
use crate::shape::{self, Stmt, StmtTree};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct FragNodeId(pub u32); // dense index, creation order

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fragment {
    /// nodes[0] is always the implicit Device node (kind Device, no owner) —
    /// the unit a configuration file is a configuration file of (schema
    /// Device doc). Its platform field is NOT set here; that is the store
    /// weld's decision (§10 item 1).
    pub nodes: Vec<FragNode>,
    pub edges: Vec<FragEdge>,
    pub pending: Vec<PendingEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FragNode {
    pub kind: NodeKind,
    /// Containment parent within the fragment. The store weld materialises
    /// the Has* containment edges from this; the fragment does not carry
    /// them as FragEdges.
    pub owner: Option<FragNodeId>,
    pub fields: Vec<FieldAssertion>, // first-assertion order
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldAssertion {
    pub key: FieldKey,
    pub value: BoundValue,
    pub prov: BindProv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FragEdge {
    pub kind: EdgeKind,
    pub from: FragNodeId,
    pub to: FragNodeId,
    pub fields: Vec<FieldAssertion>,
    pub prov: BindProv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingEdge {
    pub kind: EdgeKind,
    pub from: FragNodeId,
    pub target: PendingTarget,
    pub fields: Vec<FieldAssertion>,
    pub prov: BindProv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingTarget {
    ByName {
        kind: NodeKind,
        name: scalar::Identifier,
    },
    InterfaceUnit {
        kind: NodeKind,
        name: scalar::Identifier,
        unit: u32,
    },
}

/// The slice's provenance: enough for the store weld to construct
/// Origin::Parsed later; nothing invented beyond what ingest knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BindProv {
    pub line: LineOrdinal,
    pub span: ByteSpan, // post-redaction (14 §9.5)
    /// Index into the dictionary's entry list; the id string is reachable
    /// through the Dictionary.
    pub entry: u16,
}

/// Exactly the value types §4.7's tables bind — closed; a new variant is a
/// §7 trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundValue {
    Identifier(scalar::Identifier),
    /// The four `@interface_like` kinds declare `name: InterfaceName`, not
    /// `Identifier` (WO-09 §10 item 9's answer: where the dictionary and the
    /// schema disagree, the dictionary is wrong — ADR-0008).
    InterfaceName(scalar::InterfaceName),
    AuthMethod(scalar::AuthMethod),
    DhGroup(scalar::DhGroup),
    IntegrityAlgorithm(scalar::IntegrityAlgorithm),
    EncryptionAlgorithm(scalar::EncryptionAlgorithm),
    Seconds(scalar::Seconds),
    Kilobytes(scalar::Kilobytes),
    IkeVersion(scalar::IkeVersion),
    IpPrefix(scalar::IpPrefix),
    InterfaceAddress(scalar::InterfaceAddress),
    Secret(scalar::SecretPlaceholder),
    Peer(PeerSpec),
    U8(u8),
    U32(u32),
    IkePolicyMode(IkePolicyMode),
    IpsecProposalProtocol(IpsecProposalProtocol),
    EstablishTunnels(EstablishTunnels),
    DfBit(IpsecVpnDfBit),
    AddressFamily(AddressFamily),
    FamilySet(BTreeSet<Family>),
    HostServiceSet(BTreeSet<HostService>),
    /// Free text — an interface or unit `description`. The lexer has already
    /// stripped the quotes and resolved the escapes, so what lands here is the
    /// operator's sentence and not its Junos spelling.
    Text(scalar::Text),
    Fqdn(scalar::Fqdn),
    // ---- added 2026-08-15 by the branch-coverage widening.
    /// A flag statement's truth value (`ValueSpec::ConstBool`).
    Bool(bool),
    VlanId(scalar::VlanId),
    TzName(scalar::TzName),
    IpAddr(scalar::IpAddr),
    U16(u16),
    HostProtocolSet(BTreeSet<HostProtocol>),
}

// ---------------------------------------------------------------------------
// The binder
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Deferred {
    kind: EdgeKind,
    from: FragNodeId,
    target: PendingTarget,
    fields: Vec<FieldAssertion>,
    prov: BindProv,
}

struct Builder {
    nodes: Vec<FragNode>,
    /// (kind index, owner, key text) -> node. A BTreeMap, never a HashMap:
    /// iteration order is part of the output (invariant 9).
    index: BTreeMap<(usize, Option<u32>, String), FragNodeId>,
    deferred: Vec<Deferred>,
}

pub(crate) fn bind(
    tree: &StmtTree,
    stmts: &[Stmt],
    matches: &[Match],
    dict: &Dictionary,
    outcomes: &mut [Outcome],
) -> Fragment {
    let mut b = Builder {
        nodes: vec![FragNode {
            kind: NodeKind::Device,
            owner: None,
            fields: Vec::new(),
        }],
        index: BTreeMap::new(),
        deferred: Vec::new(),
    };
    b.index.insert(
        (NodeKind::Device.index(), None, String::new()),
        FragNodeId(0),
    );

    for (idx, stmt) in stmts.iter().enumerate() {
        let m = match matches.get(idx) {
            Some(m) => *m,
            None => continue,
        };
        bind_statement(&mut b, tree, dict, stmt, m, outcomes);
    }

    // 14 §7.3's deferred resolution, restricted to the fragment: scope is
    // pinned `Fragment`, so unresolved is always Pending, never Broken.
    let mut edges: Vec<FragEdge> = Vec::new();
    let mut pending: Vec<PendingEdge> = Vec::new();
    for deferred in &b.deferred {
        match resolve(&b, &deferred.target) {
            Some(to) => {
                let edge = FragEdge {
                    kind: deferred.kind,
                    from: deferred.from,
                    to,
                    fields: deferred.fields.clone(),
                    prov: deferred.prov,
                };
                if !edges.iter().any(|e| same_edge(e, &edge)) {
                    edges.push(edge);
                }
            }
            None => {
                let edge = PendingEdge {
                    kind: deferred.kind,
                    from: deferred.from,
                    target: deferred.target.clone(),
                    fields: deferred.fields.clone(),
                    prov: deferred.prov,
                };
                if !pending.iter().any(|e| same_pending(e, &edge)) {
                    pending.push(edge);
                }
            }
        }
    }

    Fragment {
        nodes: b.nodes,
        edges,
        pending,
    }
}

fn same_edge(a: &FragEdge, b: &FragEdge) -> bool {
    a.kind == b.kind && a.from == b.from && a.to == b.to && a.fields == b.fields
}

fn same_pending(a: &PendingEdge, b: &PendingEdge) -> bool {
    a.kind == b.kind && a.from == b.from && a.target == b.target && a.fields == b.fields
}

fn bind_statement(
    b: &mut Builder,
    tree: &StmtTree,
    dict: &Dictionary,
    stmt: &Stmt,
    m: Match,
    outcomes: &mut [Outcome],
) {
    let slot = stmt.line.0 as usize;
    if matches!(
        outcomes.get(slot).map(|o| &o.outcome),
        Some(LineOutcome::Unshaped { .. })
    ) {
        return;
    }
    let entry_idx = match m.entry {
        Some(e) => e,
        None => {
            merge(
                outcomes,
                slot,
                LineOutcome::Unmapped {
                    known_prefix: cap_u8(m.known_prefix),
                },
                Vec::new(),
            );
            return;
        }
    };
    let entry = match dict.entry(entry_idx) {
        Some(e) => e,
        None => return,
    };
    if entry.nodes.is_empty() && entry.edges.is_empty() {
        // A secret-only entry catalogues a credential without modelling the
        // stanza: the line is residue, preserved and counted (§4.7).
        merge(
            outcomes,
            slot,
            LineOutcome::Unmapped {
                known_prefix: cap_u8(m.consumed),
            },
            Vec::new(),
        );
        return;
    }

    let prov = BindProv {
        line: stmt.line,
        span: stmt.span,
        entry: entry_idx.min(u16::MAX as usize) as u16,
    };
    let seg = |name: &str| -> Option<(String, Option<redact::RedactLabel>)> {
        let at = entry.capture_pos(name)?;
        let idx = stmt.path.get(at)?;
        Some((
            shape::seg_text(tree, *idx).to_owned(),
            redact::is_redacted(tree, *idx),
        ))
    };

    // Keys first: a node whose key capture was redacted, or does not parse as
    // an Identifier, cannot be identified — so nothing on the line may bind
    // (§4.6 rule 3).
    let mut keys: Vec<Option<String>> = Vec::new();
    for node in &entry.nodes {
        match &node.key {
            None => keys.push(None),
            Some(name) => match seg(name) {
                Some((text, None)) if scalar::Identifier::parse(&text).is_ok() => {
                    keys.push(Some(text))
                }
                _ => {
                    merge(
                        outcomes,
                        slot,
                        LineOutcome::Unshaped {
                            reason: ShapeError::KeyUnparsable,
                        },
                        Vec::new(),
                    );
                    return;
                }
            },
        }
    }

    let mut diags: Vec<Diag> = Vec::new();
    let mut local: Vec<FragNodeId> = Vec::new();
    let mut fields_written = 0u16;
    let mut edges_made = 0u16;

    for (at, spec) in entry.nodes.iter().enumerate() {
        let key = keys.get(at).cloned().flatten().unwrap_or_default();
        let kind = match spec.kind {
            KindSpec::Fixed(k) => k,
            KindSpec::InterfaceLike => interface_like(&key),
        };
        let owner = spec.owner.and_then(|o| local.get(o).copied());
        let id = b.upsert(kind, owner, &key);
        local.push(id);
        for field in &spec.fields {
            let key_id = match dict.field_key(kind.name(), &field.field) {
                Some(k) => FieldKey(k),
                None => continue,
            };
            match bound_value(dict, entry, stmt, tree, &field.value) {
                Ok(value) => {
                    if b.assert_node(id, key_id, value, prov, &mut diags) {
                        fields_written = fields_written.saturating_add(1);
                    }
                }
                Err(()) => diags.push(Diag::ValueUnparsed { key: key_id }),
            }
        }
    }

    for spec in &entry.edges {
        let from = match local.get(spec.from).copied() {
            Some(f) => f,
            None => continue,
        };
        let target = match edge_target(entry, stmt, tree, &spec.to) {
            Some(t) => t,
            None => {
                if let Some(k) = dict.field_key(spec.kind.name(), "ordinal") {
                    diags.push(Diag::ValueUnparsed { key: FieldKey(k) });
                }
                continue;
            }
        };
        let mut fields: Vec<FieldAssertion> = Vec::new();
        if spec.ordinal_from_position {
            if let Some(k) = dict.field_key(spec.kind.name(), "ordinal") {
                fields.push(FieldAssertion {
                    key: FieldKey(k),
                    value: BoundValue::U8(stmt.list_pos.min(u32::from(u8::MAX)) as u8),
                    prov,
                });
            }
        }
        for field in &spec.fields {
            let key_id = match dict.field_key(spec.kind.name(), &field.field) {
                Some(k) => FieldKey(k),
                None => continue,
            };
            match bound_value(dict, entry, stmt, tree, &field.value) {
                Ok(value) => {
                    merge_assertion(&mut fields, key_id, value, prov, &mut diags);
                }
                Err(()) => diags.push(Diag::ValueUnparsed { key: key_id }),
            }
        }
        b.deferred.push(Deferred {
            kind: spec.kind,
            from,
            target,
            fields,
            prov,
        });
        edges_made = edges_made.saturating_add(1);
    }

    let node = local.first().copied().unwrap_or(FragNodeId(0));

    // A statement that said MORE than the entry modelled is residue, even
    // though the entry's own nodes and edges bound.
    //
    // `set security ike gateway GW-B dead-peer-detection always-send interval
    // 10 threshold 3` matches the four-segment bare-stanza entry: the gateway
    // genuinely exists and binding its name loses nothing, but `always-send
    // interval 10 threshold 3` went nowhere. Reporting that line `Bound` would
    // break `14`'s one governing rule — NOTHING PARSED IS SILENTLY LOST — by
    // taking it off the residue list the operator reads.
    //
    // The rule is stated over `consumed` vs the statement's own depth rather
    // than over `partial`, because the same loss is reachable through a
    // non-partial entry whenever a real config carries a sub-statement the
    // entry's path stops short of. Adding the bare stanzas (2026-08-15) made
    // it common; it was always possible.
    //
    // The gate is unaffected either way: `redact::gate_statement` already
    // scans `m.consumed..segs.len()` as argument tokens, so a credential in
    // the unmodelled tail is caught whichever outcome the line carries.
    if m.consumed < stmt.path.len() {
        merge(
            outcomes,
            slot,
            LineOutcome::Unmapped {
                known_prefix: cap_u8(m.known_prefix.max(m.consumed)),
            },
            diags,
        );
        return;
    }

    merge(
        outcomes,
        slot,
        LineOutcome::Bound {
            node,
            fields: fields_written,
            edges: edges_made,
        },
        diags,
    );
}

fn cap_u8(n: usize) -> u8 {
    n.min(u8::MAX as usize) as u8
}

/// `@interface_like`: the kind is the prefix before the first ASCII digit —
/// `st` -> TunnelInterface, `reth` -> RethInterface, `ae` ->
/// AggregateInterface, anything else -> Interface (§4.7).
fn interface_like(name: &str) -> NodeKind {
    let prefix: String = name.chars().take_while(|c| !c.is_ascii_digit()).collect();
    match prefix.as_str() {
        "st" => NodeKind::TunnelInterface,
        "reth" => NodeKind::RethInterface,
        "ae" => NodeKind::AggregateInterface,
        _ => NodeKind::Interface,
    }
}

impl Builder {
    fn upsert(&mut self, kind: NodeKind, owner: Option<FragNodeId>, key: &str) -> FragNodeId {
        let index_key = (kind.index(), owner.map(|FragNodeId(o)| o), key.to_owned());
        if let Some(id) = self.index.get(&index_key) {
            return *id;
        }
        let id = FragNodeId(self.nodes.len() as u32);
        self.nodes.push(FragNode {
            kind,
            owner,
            fields: Vec::new(),
        });
        self.index.insert(index_key, id);
        id
    }

    /// True when the assertion added a field the node did not have. A
    /// conflicting second assertion never overwrites; it diagnoses.
    fn assert_node(
        &mut self,
        id: FragNodeId,
        key: FieldKey,
        value: BoundValue,
        prov: BindProv,
        diags: &mut Vec<Diag>,
    ) -> bool {
        match self.nodes.get_mut(id.0 as usize) {
            Some(node) => merge_assertion(&mut node.fields, key, value, prov, diags),
            None => false,
        }
    }

    fn find(&self, kind: NodeKind, key: &str) -> Option<FragNodeId> {
        self.index
            .iter()
            .find(|((k, _, text), _)| *k == kind.index() && text == key)
            .map(|(_, id)| *id)
    }
}

/// The upsert law (§4.8): a second assertion with an equal value is
/// idempotent; a second assertion with a different value does not overwrite —
/// the first value stands and the conflict is visible in the ledger. Set
/// fields accumulate instead, coalescing duplicates.
fn merge_assertion(
    fields: &mut Vec<FieldAssertion>,
    key: FieldKey,
    value: BoundValue,
    prov: BindProv,
    diags: &mut Vec<Diag>,
) -> bool {
    if let Some(existing) = fields.iter_mut().find(|f| f.key == key) {
        match (&mut existing.value, &value) {
            (BoundValue::FamilySet(have), BoundValue::FamilySet(add)) => {
                have.extend(add.iter().cloned());
            }
            (BoundValue::HostServiceSet(have), BoundValue::HostServiceSet(add)) => {
                have.extend(add.iter().cloned());
            }
            (BoundValue::HostProtocolSet(have), BoundValue::HostProtocolSet(add)) => {
                have.extend(add.iter().cloned());
            }
            (have, add) if have == add => {}
            _ => diags.push(Diag::ValueUnparsed { key }),
        }
        return false;
    }
    fields.push(FieldAssertion { key, value, prov });
    true
}

fn merge(outcomes: &mut [Outcome], slot: usize, outcome: LineOutcome, diags: Vec<Diag>) {
    let entry = match outcomes.get_mut(slot) {
        Some(e) => e,
        None => return,
    };
    entry.diags.extend(diags);
    match (&mut entry.outcome, &outcome) {
        (
            LineOutcome::Bound {
                fields: have,
                edges: have_edges,
                ..
            },
            LineOutcome::Bound {
                fields: add,
                edges: add_edges,
                ..
            },
        ) => {
            *have = have.saturating_add(*add);
            *have_edges = have_edges.saturating_add(*add_edges);
        }
        (LineOutcome::Bound { .. }, LineOutcome::Unmapped { .. }) => {}
        _ => entry.outcome = outcome,
    }
}

/// The captured, post-gate segment behind a capture name, plus whether the
/// gate redacted it.
fn capture(
    entry: &Entry,
    stmt: &Stmt,
    tree: &StmtTree,
    name: &str,
) -> Option<(String, Option<redact::RedactLabel>)> {
    let at = entry.capture_pos(name)?;
    let idx = stmt.path.get(at)?;
    Some((
        shape::seg_text(tree, *idx).to_owned(),
        redact::is_redacted(tree, *idx),
    ))
}

fn bound_value(
    dict: &Dictionary,
    entry: &Entry,
    stmt: &Stmt,
    tree: &StmtTree,
    spec: &ValueSpec,
) -> Result<BoundValue, ()> {
    match spec {
        ValueSpec::Secret { .. } => redact::placeholder_of(spec)
            .map(BoundValue::Secret)
            .ok_or(()),
        ValueSpec::ConstBool { value } => Ok(BoundValue::Bool(*value)),
        ValueSpec::ConstEnum { ty, token } => scalar_value(dict, *ty, token),
        ValueSpec::AppendConst { ty, token } => set_value(*ty, token),
        ValueSpec::AppendFrom { ty, from } => {
            let (text, redacted) = capture(entry, stmt, tree, from).ok_or(())?;
            if redacted.is_some() {
                return Err(());
            }
            set_value(*ty, &text)
        }
        ValueSpec::From { from, ty } => {
            let (text, redacted) = capture(entry, stmt, tree, from).ok_or(())?;
            // A safety-net-redacted value capture never binds from marker
            // text: the flag is the authority, not the text (§4.6 rule 2).
            if redacted.is_some() {
                return Err(());
            }
            scalar_value(dict, *ty, &text)
        }
    }
}

fn scalar_value(dict: &Dictionary, ty: ValueTy, raw: &str) -> Result<BoundValue, ()> {
    let mapped = match ty.token_map() {
        Some(map) => dict.token_map(map, raw).unwrap_or(raw),
        None => raw,
    };
    let neutral = mapped.replace('-', "_");
    Ok(match ty {
        ValueTy::Identifier => BoundValue::Identifier(parse(mapped)?),
        ValueTy::InterfaceName => BoundValue::InterfaceName(parse(mapped)?),
        ValueTy::Text => BoundValue::Text(parse(mapped)?),
        ValueTy::Fqdn => BoundValue::Fqdn(parse(mapped)?),
        ValueTy::AuthMethod => BoundValue::AuthMethod(parse(mapped)?),
        ValueTy::DhGroup => BoundValue::DhGroup(parse(mapped)?),
        ValueTy::IntegrityAlgorithm => BoundValue::IntegrityAlgorithm(parse(mapped)?),
        ValueTy::EncryptionAlgorithm => BoundValue::EncryptionAlgorithm(parse(mapped)?),
        ValueTy::Seconds => BoundValue::Seconds(parse(mapped)?),
        ValueTy::Kilobytes => BoundValue::Kilobytes(parse(mapped)?),
        ValueTy::IkeVersion => BoundValue::IkeVersion(parse(mapped)?),
        ValueTy::IpPrefix => BoundValue::IpPrefix(parse(mapped)?),
        ValueTy::InterfaceAddress => BoundValue::InterfaceAddress(parse(mapped)?),
        ValueTy::PeerAddress => BoundValue::Peer(PeerSpec::Address(parse(mapped)?)),
        ValueTy::U32 => BoundValue::U32(mapped.parse::<u32>().map_err(|_| ())?),
        // A generated `Unknown` arm is never stored: ingest refuses a vendor
        // token it does not know rather than persist a typo with Asserted
        // confidence (§12 item 8).
        ValueTy::IkePolicyMode => {
            BoundValue::IkePolicyMode(known(IkePolicyMode::from_token(&neutral), |v| {
                matches!(v, IkePolicyMode::Unknown(_))
            })?)
        }
        ValueTy::IpsecProposalProtocol => BoundValue::IpsecProposalProtocol(known(
            IpsecProposalProtocol::from_token(&neutral),
            |v| matches!(v, IpsecProposalProtocol::Unknown(_)),
        )?),
        ValueTy::EstablishTunnels => {
            BoundValue::EstablishTunnels(known(EstablishTunnels::from_token(&neutral), |v| {
                matches!(v, EstablishTunnels::Unknown(_))
            })?)
        }
        ValueTy::IpsecVpnDfBit => {
            BoundValue::DfBit(known(IpsecVpnDfBit::from_token(&neutral), |v| {
                matches!(v, IpsecVpnDfBit::Unknown(_))
            })?)
        }
        ValueTy::AddressFamily => {
            BoundValue::AddressFamily(known(AddressFamily::from_token(&neutral), |v| {
                matches!(v, AddressFamily::Unknown(_))
            })?)
        }
        ValueTy::VlanId => BoundValue::VlanId(parse(mapped)?),
        ValueTy::TzName => BoundValue::TzName(parse(mapped)?),
        ValueTy::IpAddress => BoundValue::IpAddr(parse(mapped)?),
        ValueTy::U16 => BoundValue::U16(mapped.parse::<u16>().map_err(|_| ())?),
    })
}

fn set_value(ty: SetEnumTy, raw: &str) -> Result<BoundValue, ()> {
    let neutral = raw.replace('-', "_");
    Ok(match ty {
        SetEnumTy::Family => {
            let v = known(Family::from_token(&neutral), |v| {
                matches!(v, Family::Unknown(_))
            })?;
            BoundValue::FamilySet(BTreeSet::from([v]))
        }
        SetEnumTy::HostService => {
            let v = known(HostService::from_token(&neutral), |v| {
                matches!(v, HostService::Unknown(_))
            })?;
            BoundValue::HostServiceSet(BTreeSet::from([v]))
        }
        SetEnumTy::HostProtocol => {
            let v = known(HostProtocol::from_token(&neutral), |v| {
                matches!(v, HostProtocol::Unknown(_))
            })?;
            BoundValue::HostProtocolSet(BTreeSet::from([v]))
        }
    })
}

fn known<T>(value: T, is_unknown: impl Fn(&T) -> bool) -> Result<T, ()> {
    if is_unknown(&value) {
        Err(())
    } else {
        Ok(value)
    }
}

fn parse<T: Scalar>(text: &str) -> Result<T, ()> {
    T::parse(text).map_err(|_| ())
}

fn edge_target(
    entry: &Entry,
    stmt: &Stmt,
    tree: &StmtTree,
    spec: &EdgeTarget,
) -> Option<PendingTarget> {
    match spec {
        EdgeTarget::ByName { kind, from } => {
            let (text, redacted) = capture(entry, stmt, tree, from)?;
            if redacted.is_some() {
                return None;
            }
            Some(PendingTarget::ByName {
                kind: *kind,
                name: scalar::Identifier::parse(&text).ok()?,
            })
        }
        EdgeTarget::InterfaceUnit { from } => {
            let (text, redacted) = capture(entry, stmt, tree, from)?;
            if redacted.is_some() {
                return None;
            }
            // `st0.0` -> the LogicalUnit `0` of the InterfaceLike named `st0`
            // (`14` §7.3). The split is at the LAST `.`.
            let (name, unit) = text.rsplit_once('.')?;
            Some(PendingTarget::InterfaceUnit {
                kind: interface_like(name),
                name: scalar::Identifier::parse(name).ok()?,
                unit: unit.parse::<u32>().ok()?,
            })
        }
    }
}

fn resolve(b: &Builder, target: &PendingTarget) -> Option<FragNodeId> {
    match target {
        PendingTarget::ByName { kind, name } => b.find(*kind, &name.0),
        PendingTarget::InterfaceUnit { kind, name, unit } => {
            let iface = b.find(*kind, &name.0)?;
            b.index
                .iter()
                .filter(|((k, owner, _), _)| {
                    *k == NodeKind::LogicalUnit.index() && *owner == Some(iface.0)
                })
                .find(|(_, id)| unit_index_is(b, **id, *unit))
                .map(|(_, id)| *id)
        }
    }
}

fn unit_index_is(b: &Builder, id: FragNodeId, unit: u32) -> bool {
    b.nodes
        .get(id.0 as usize)
        .map(|n| {
            n.fields
                .iter()
                .any(|f| matches!(&f.value, BoundValue::U32(v) if *v == unit))
        })
        .unwrap_or(false)
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
mod tests {
    use super::*;
    use crate::{ingest, IngestOutput};

    fn dict() -> Dictionary {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .expect("the crate lives two levels under the repo root")
            .to_path_buf();
        Dictionary::load(&root).expect("the shipped dictionary loads")
    }

    fn run(paste: &str) -> IngestOutput {
        ingest(paste.as_bytes(), &dict()).expect("within the caps")
    }

    fn node_of(out: &IngestOutput, kind: NodeKind) -> Option<&FragNode> {
        out.fragment.nodes.iter().find(|n| n.kind == kind)
    }

    #[test]
    fn two_statements_about_one_gateway_make_one_node() {
        let out = run("set security ike gateway GW-B address 203.0.113.10\nset security ike gateway GW-B version v2-only\n");
        let gateways: Vec<&FragNode> = out
            .fragment
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::IkeGateway)
            .collect();
        assert_eq!(gateways.len(), 1);
        assert_eq!(gateways[0].fields.len(), 3, "name, peer, version");
    }

    #[test]
    fn a_differing_duplicate_leaves_the_first_value_and_diagnoses() {
        let out = run("set security ike proposal P1 dh-group group14\nset security ike proposal P1 dh-group group19\n");
        let node = node_of(&out, NodeKind::IkeProposal).unwrap();
        let dh = node
            .fields
            .iter()
            .find(|f| matches!(f.value, BoundValue::DhGroup(_)))
            .unwrap();
        assert_eq!(dh.value, BoundValue::DhGroup(scalar::DhGroup(14)));
        assert!(out.ledger.lines[1]
            .diags
            .iter()
            .any(|d| matches!(d, Diag::ValueUnparsed { .. })));
    }

    #[test]
    fn interface_unit_resolves_in_fragment_and_goes_pending_otherwise() {
        let out = run("set interfaces st0 unit 0 family inet address 10.255.0.1/30\nset security ipsec vpn V bind-interface st0.0\nset security ike gateway GW external-interface reth0.0\n");
        assert_eq!(out.fragment.edges.len(), 1);
        assert_eq!(out.fragment.edges[0].kind, EdgeKind::BindsInterface);
        assert_eq!(out.fragment.pending.len(), 1);
        assert_eq!(
            out.fragment.pending[0].target,
            PendingTarget::InterfaceUnit {
                kind: NodeKind::RethInterface,
                name: scalar::Identifier("reth0".to_owned()),
                unit: 0
            }
        );
    }

    #[test]
    fn enum_tokens_map_hyphen_to_underscore() {
        let out = run("set security ipsec vpn V establish-tunnels responder-only\n");
        let node = node_of(&out, NodeKind::IpsecVpn).unwrap();
        assert!(node
            .fields
            .iter()
            .any(|f| f.value == BoundValue::EstablishTunnels(EstablishTunnels::ResponderOnly)));
    }

    #[test]
    fn an_unknown_enum_token_is_diagnosed_never_stored() {
        let out = run("set security ipsec vpn V establish-tunnels whenever\n");
        let node = node_of(&out, NodeKind::IpsecVpn).unwrap();
        assert!(!node
            .fields
            .iter()
            .any(|f| matches!(f.value, BoundValue::EstablishTunnels(_))));
        assert!(out.ledger.lines[0]
            .diags
            .iter()
            .any(|d| matches!(d, Diag::ValueUnparsed { .. })));
    }

    #[test]
    fn an_unknown_scalar_token_is_diagnosed_never_stored() {
        let out = run("set security ike proposal P1 dh-group group1444\n");
        let node = node_of(&out, NodeKind::IkeProposal).unwrap();
        assert!(!node
            .fields
            .iter()
            .any(|f| matches!(f.value, BoundValue::DhGroup(_))));
        assert!(out.ledger.lines[0]
            .diags
            .iter()
            .any(|d| matches!(d, Diag::ValueUnparsed { .. })));
    }

    #[test]
    fn a_redacted_key_capture_binds_nothing() {
        let out = run("set security ike gateway $9$EXAMPLEnotARealKey01234 ike-policy IKE-POL\n");
        assert_eq!(
            out.ledger.lines[0].outcome,
            LineOutcome::Unshaped {
                reason: ShapeError::KeyUnparsable
            }
        );
        assert!(node_of(&out, NodeKind::IkeGateway).is_none());
    }

    #[test]
    fn a_redacted_value_capture_never_binds_marker_text() {
        let out = run("set system tacplus-server 192.0.2.7 secret $9$ABCDEF\nset system host-name $9$ABCDEF\n");
        let device = &out.fragment.nodes[0];
        assert!(device.fields.is_empty(), "no hostname from marker text");
        assert!(out.ledger.lines[1]
            .diags
            .iter()
            .any(|d| matches!(d, Diag::ValueUnparsed { .. })));
    }

    #[test]
    fn the_root_device_is_node_zero() {
        let out = run("set system host-name srx-a-01\n");
        assert_eq!(out.fragment.nodes[0].kind, NodeKind::Device);
        assert_eq!(out.fragment.nodes[0].owner, None);
        assert_eq!(out.fragment.nodes[0].fields.len(), 1);
    }
}
