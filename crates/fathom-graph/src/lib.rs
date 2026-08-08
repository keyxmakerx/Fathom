//! fathom-graph: the in-memory typed graph store (`76` §7.2's S3 slice).
//!
//! One property graph over the generated IR types (ADR-0007): nodes and edges
//! keyed by kind-embedded ULID ids, every L0-invalid mutation refused at write
//! time with a typed error that names the violated declaration (`11` §9.1),
//! three-state presence with provenance on every write (`11` §5.2, §8), an
//! op log grouped into caller-drawn batches (`53` §7.2), and iteration that is
//! a pure function of content (invariant 9).
//!
//! Every schema fact the store checks against comes from `fathom-ir`'s
//! generated tables — endpoint sets, cardinality bounds, the symmetric and
//! root-containment flags, the declared field keys and their slot types.
//! Nothing here hand-copies a line of `schema/` (ADR-0008).
//!
//! Deliberately outside this crate: rendering, rules, undo application,
//! re-identification, inference, defaults, and any parser. The `snap` module
//! is the store as plain data (WO-05 §4.3) — it converts values at the
//! boundary and re-enforces L0 on the way back in; it writes no bytes.

#![forbid(unsafe_code)]

pub mod field;
pub mod graph;
pub mod id;
pub mod op;
pub mod prov;
pub mod snap;

pub use field::{FieldHistory, FieldInfo, HistoryEntry, StoredPresence};
pub use graph::{Edge, End, Graph, Node, ReadError, WriteError};
pub use id::{EdgeId, ElementId, IdParseError, NodeId};
pub use op::{Batch, BatchId, Op};
pub use prov::{Actor, Confidence, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId};
pub use snap::{
    EdgeSnap, FieldSnap, HistoryEntrySnap, HistorySnap, NodeSnap, Snapshot, SnapshotError,
};
