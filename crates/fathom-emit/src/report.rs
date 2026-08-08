//! The ledgers. Nothing here is suppressible and nothing has an `Omit`
//! (`13` §9.4).

use crate::block::BlockId;
use crate::line::FieldRef;
use crate::path::StatementPath;

/// Why a statement could not be emitted, in the position it would have
/// occupied (11 §9.1 L2: "Returns the exact blocker list, never a partial
/// config with a hole in it"). Closed; a case outside this list is a WO-04
/// §7 trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockReason {
    /// An emit-R (or satisfied-R*) field is `Unknown` (13 §1.1).
    RequiredUnknown,
    /// An emit-R (or satisfied-R*) field is asserted `Absent` — the emit
    /// unit is incomplete (62 §10.1; 11 §9.1 L2's "Set or Default").
    RequiredAbsent,
    /// The value is Set but the closed junos token table (WO-04 §4.7) has no
    /// row for it. The value's canonical text is carried; a guess is never.
    TokenUnmapped { value: String },
    /// A generated enum's `Unknown(String)` arm — unvalidated foreign text
    /// is never rendered into a statement.
    EnumUnknownArm,
    /// AEAD encryption with `authentication_algorithm` Set — the schema's
    /// own doc: "Must be Absent when the encryption algorithm is AEAD".
    /// Refused loudly rather than dropped silently (13 §9).
    AeadExcludesAuth,
    /// `PeerSpec::Dynamic` — `IkeId` is an empty stub; not emittable.
    DynamicPeerNotCovered,
    /// `VpnMode::PolicyBased` — policy-based emission is not built
    /// (card: "then permit tunnel ipsec-vpn NAME", a SecurityPolicy form).
    PolicyBasedNotCovered,
    /// A reference edge the statement needs is missing: UsesIkePolicy,
    /// ExternalInterface, UsesIkeGateway, UsesIpsecPolicy (all out "1"),
    /// UsesProposal (out "1..n"), or BindsInterface under RouteBased
    /// (11 §9.1 L2: "every required edge is present").
    MissingRequiredEdge {
        edge: fathom_ir::generated::ir_types::EdgeKind,
    },
    /// TrafficSelector.protocol / local_ports / remote_ports Set — the
    /// schema field doc: "Not expressible on every platform; blocks emit
    /// where not."
    SelectorTermUnsupported,
}

#[derive(Debug, Clone)]
pub struct Blocker {
    pub node: fathom_graph::NodeId,
    pub field: Option<fathom_ir::bag::FieldKey>,
    pub block: BlockId,
    /// The order_hint the line would have carried — position, kept.
    pub order_hint: u32,
    pub reason: BlockReason,
}

/// The emit-side residue ledger (13 §9.1, `GapKind::NotYetBuilt` only in this
/// slice — every entry is our backlog, not a vendor fact). One entry per
/// covered-kind node whose gap field is Set or explicitly Absent.
#[derive(Debug, Clone)]
pub struct GapEntry {
    pub node: fathom_graph::NodeId,
    pub field: fathom_ir::bag::FieldKey,
    /// The static reason string from the kind's GAPS table (WO-04 §4.6).
    pub tracking: &'static str,
}

/// One row of the substitution manifest (13 §10.4).
#[derive(Debug, Clone)]
pub struct Substitution {
    /// Index into the emitted line sequence.
    pub line: u32,
    /// The rendered token, e.g. "<PSK>".
    pub token: String,
    pub site: FieldRef,
    /// SecretHint text — manifest only, never in any `text` (13 §10.1).
    pub hint: Option<String>,
}

/// Two lines, one path (13 §3.2). Always fatal to rendering.
#[derive(Debug, Clone)]
pub struct EmitConflict {
    pub path: StatementPath,
}

#[derive(Debug, Clone, Default)]
pub struct EmitReport {
    pub blockers: Vec<Blocker>,
    pub gaps: Vec<GapEntry>,
    pub substitutions: Vec<Substitution>,
    pub conflicts: Vec<EmitConflict>,
}
