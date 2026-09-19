//! The op log and the batch.
//!
//! The vocabulary is `33` §5.1's, cut to the five ops a local store issues;
//! the batch is `53` §7.2's transaction unit — *"Groups the ops one user
//! intention produced"* — with its 60-byte label bound.
//!
//! The store cannot know what "one user intention" is, so the batch boundary
//! is drawn by the caller (`Graph::begin_batch` / `Graph::end_batch`) and
//! every mutation appends one op to the batch that is open. An op records the
//! presence transition and the provenance id, not the value payload: prior
//! values are recoverable from the history side table, and `33` §5.1's
//! state-carrying serialised form (`PresenceRepr`) belongs to the
//! workspace-format work.
//!
//! **`Revive` (ADR-0053 §1) is the fifth op, added 2026-09-19.** Adding is
//! reversed by a tombstone; a tombstone by this: the store refuses a reused
//! id (`Graph::insert_node`/`Graph::insert_edge`), so undoing a removal by
//! re-adding under a fresh id would lose the element's identity, its history
//! and its capture links. Reviving keeps all three.
//!
//! Deliberately absent: `Purge`, undo application, redo, and `33` §5.1's
//! `OpId`/HLC/actor-pseudonym envelope. Each is a decision this crate does
//! not get to make (WO-02 §10 items 1 and 5); the shapes here take all of
//! them additively.

use crate::field::StoredPresence;
use crate::id::{ElementId, NodeId};
use crate::prov::{Actor, ProvenanceId, Timestamp};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;
use fathom_ir::scalar::Text;

/// A batch's id. ULID, caller-supplied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BatchId(pub Ulid);

/// One recorded mutation (`33` §5.1).
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    AddNode {
        node: NodeId,
        prov: ProvenanceId,
    },
    AddEdge {
        edge: crate::id::EdgeId,
        from: NodeId,
        to: NodeId,
        prov: ProvenanceId,
    },
    SetField {
        element: ElementId,
        key: FieldKey,
        presence: StoredPresence,
        prov: ProvenanceId,
    },
    /// `11` §10.5: absence is not deletion. This is the normal removal.
    ///
    /// **`by` was added 2026-08-21 and it closes the one hole an audit log can
    /// never backfill.** Every other op reaches a `ProvenanceRecord`, which
    /// carries `asserted_by`; a tombstone writes no provenance record, so a
    /// removal was the single operation in the product with no author at all.
    /// A field that was changed can be traced; a fact that was *removed* could
    /// not be, and that is the one people ask about.
    Tombstone {
        element: ElementId,
        at: Timestamp,
        by: Actor,
    },
    /// The fifth op (ADR-0053 §1): clears a tombstone. `Graph::revive` is the
    /// only writer, and for an edge it re-runs `Graph::check_edge_l0` on the
    /// edge's own kind/from/to before clearing anything, so a revive lands
    /// only when nothing has taken the slot since the tombstone.
    Revive {
        element: ElementId,
        at: Timestamp,
        by: Actor,
    },
}

/// The undo unit (`53` §7.2). The label is what a footer and an undo
/// affordance say; it is capped at 60 bytes (`BoundedText<60>`) and is
/// authored per source, never generated from the op list.
#[derive(Debug, Clone, PartialEq)]
pub struct Batch {
    pub id: BatchId,
    pub label: String,
    pub ops: Vec<Op>,
    /// A comment on a pending change (ADR-0053 §4). Optional on the wire,
    /// omitted when absent; set through `Graph::set_batch_comment` on the
    /// batch that is open, never guessed from the ops it holds.
    pub comment: Option<Text>,
    /// The batch an undo reverses, when this batch is one (ADR-0053 §4). Set
    /// through `Graph::set_batch_reverses`; `None` for an ordinary batch.
    pub reverses: Option<BatchId>,
}

/// `53` §7.2's `BoundedText<60>`.
pub(crate) const LABEL_MAX_BYTES: usize = 60;
