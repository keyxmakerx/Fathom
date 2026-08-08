//! The op log and the batch.
//!
//! The vocabulary is `33` §5.1's, cut to the four ops a local store issues;
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
//! Deliberately absent: `Purge`, `Op::Untombstone`, undo application, redo,
//! and `33` §5.1's `OpId`/HLC/actor-pseudonym envelope. Each is a decision
//! this crate does not get to make (WO-02 §10 items 1 and 5); the shapes here
//! take all of them additively.

use crate::field::StoredPresence;
use crate::id::{ElementId, NodeId};
use crate::prov::{ProvenanceId, Timestamp};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;

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
    Tombstone {
        element: ElementId,
        at: Timestamp,
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
}

/// `53` §7.2's `BoundedText<60>`.
pub(crate) const LABEL_MAX_BYTES: usize = 60;
