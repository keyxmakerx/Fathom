//! The store's plain-data snapshot, both directions (WO-05 §4.3).
//!
//! A [`Snapshot`] is everything the store holds — nodes, edges, field slots,
//! provenance, history, tombstones, the op log — as ordered, clonable,
//! comparable data with no `dyn Any` in it. Values cross the boundary through
//! the generated `slot_to_canon` / `slot_from_canon` dispatch, so the declared
//! type is enforced by construction in both directions.
//!
//! **Loading is not trusting.** `from_snapshot` re-runs the same L0 ladder the
//! write path runs (`Graph::check_edge_l0`, extracted for exactly this
//! reason), and adds the checks a file can fail that memory cannot: dangling
//! provenance, a denormalised symmetric pair, an element an op names and the
//! snapshot does not hold, a section out of its stated order. Nothing is
//! silently repaired — a snapshot the writer could not have produced is
//! tampering or a bug, and either way the honest answer is a refusal.
//!
//! History and the batch log are installed exactly as given. They are the
//! record, not replayable instructions: `Op::SetField` deliberately carries no
//! value payload, and re-applying the retention rule on load would drop
//! entries and miscount `truncated`.

use std::collections::BTreeMap;

use fathom_canon::Json;
use fathom_ir::bag::FieldKey;
use fathom_ir::canon::CanonError;
use fathom_ir::generated::accessors::{slot_from_canon, slot_to_canon};
use fathom_ir::generated::ir_types::EdgeClass;

use crate::field::{FieldHistory, HistoryEntry, StoredPresence};
use crate::graph::{declares, insert_sorted, Edge, Graph, Node, Slot, WriteError};
use crate::id::{EdgeId, ElementId, NodeId};
use crate::op::{Batch, BatchId, Op};
use crate::prov::{ProvenanceId, ProvenanceRecord, Timestamp};

/// Everything the store holds, as plain data.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// Ascending `NodeId`.
    pub nodes: Vec<NodeSnap>,
    /// Ascending `EdgeId`.
    pub edges: Vec<EdgeSnap>,
    /// Ascending `ProvenanceId`.
    pub provenance: Vec<ProvenanceRecord>,
    /// Ascending `(element, key)`.
    pub history: Vec<HistorySnap>,
    /// Log order — append order is data.
    pub batches: Vec<Batch>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodeSnap {
    pub id: NodeId,
    pub existence: ProvenanceId,
    pub absent_since: Option<Timestamp>,
    /// Ascending `FieldKey`.
    pub fields: Vec<FieldSnap>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EdgeSnap {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub prov: ProvenanceId,
    pub absent_since: Option<Timestamp>,
    /// Ascending `FieldKey`.
    pub fields: Vec<FieldSnap>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FieldSnap {
    pub key: FieldKey,
    /// `Set` or `Absent` only — `Unknown` is a missing slot.
    pub presence: StoredPresence,
    /// `Some` iff `presence == Set`.
    pub value: Option<Json>,
    pub prov: ProvenanceId,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistorySnap {
    pub element: ElementId,
    pub key: FieldKey,
    /// Oldest first, as `FieldHistory::entries` returns.
    pub entries: Vec<HistoryEntrySnap>,
    pub truncated: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryEntrySnap {
    /// All three states are legal here.
    pub presence: StoredPresence,
    pub value: Option<Json>,
    pub prov: ProvenanceId,
}

/// Why a snapshot did not come out, or did not go back in.
#[derive(Debug)]
pub enum SnapshotError {
    /// Serialising mid-intention is refused.
    OpenBatch {
        open: BatchId,
    },
    Canon(CanonError),
    /// Every WO-02 §4.2 rule-4 refusal, re-run on load.
    L0(WriteError),
    DanglingProvenance {
        id: ProvenanceId,
    },
    DuplicateElement {
        element: ElementId,
    },
    /// A snapshot vector violates its stated order.
    OutOfOrder {
        section: &'static str,
    },
    SymmetricNotNormalised {
        edge: EdgeId,
    },
    /// `Unknown` appeared in `fields`, where it is the absence of a slot.
    UnknownFieldPresence {
        element: ElementId,
        key: FieldKey,
    },
    /// The `value` present iff `Set` rule was broken.
    ValuePresenceMismatch {
        element: ElementId,
        key: FieldKey,
    },
    /// History or an op names something the snapshot does not hold.
    UnknownElement {
        element: ElementId,
    },
}

impl From<CanonError> for SnapshotError {
    fn from(e: CanonError) -> Self {
        SnapshotError::Canon(e)
    }
}

impl From<WriteError> for SnapshotError {
    fn from(e: WriteError) -> Self {
        SnapshotError::L0(e)
    }
}

// ---------------------------------------------------------------------------
// Out

fn slots_to_snap(
    element: ElementId,
    slots: &BTreeMap<FieldKey, Slot>,
) -> Result<Vec<FieldSnap>, SnapshotError> {
    let mut out = Vec::with_capacity(slots.len());
    for (key, slot) in slots {
        let value = match (slot.presence, slot.value.as_deref()) {
            (StoredPresence::Set, Some(v)) => Some(slot_to_canon(*key, v)?),
            (StoredPresence::Absent, None) => None,
            (StoredPresence::Unknown, _) => {
                return Err(SnapshotError::UnknownFieldPresence { element, key: *key })
            }
            _ => return Err(SnapshotError::ValuePresenceMismatch { element, key: *key }),
        };
        out.push(FieldSnap {
            key: *key,
            presence: slot.presence,
            value,
            prov: slot.prov,
        });
    }
    Ok(out)
}

impl Graph {
    /// Everything the store holds, converted at the boundary.
    pub fn to_snapshot(&self) -> Result<Snapshot, SnapshotError> {
        if let Some(open) = &self.open {
            return Err(SnapshotError::OpenBatch { open: open.id });
        }

        let mut nodes = Vec::with_capacity(self.nodes.len());
        for n in self.nodes.values() {
            nodes.push(NodeSnap {
                id: n.id,
                existence: n.existence,
                absent_since: n.absent_since,
                fields: slots_to_snap(ElementId::Node(n.id), &n.fields)?,
            });
        }

        let mut edges = Vec::with_capacity(self.edges.len());
        for e in self.edges.values() {
            edges.push(EdgeSnap {
                id: e.id,
                from: e.from,
                to: e.to,
                prov: e.prov,
                absent_since: e.absent_since,
                fields: slots_to_snap(ElementId::Edge(e.id), &e.fields)?,
            });
        }

        let mut history = Vec::with_capacity(self.history.len());
        for ((element, key), h) in &self.history {
            let mut entries = Vec::with_capacity(h.entries().len());
            for entry in h.entries() {
                let value = match (entry.presence, entry.value.as_deref()) {
                    (StoredPresence::Set, Some(v)) => Some(slot_to_canon(*key, v)?),
                    (_, None) => None,
                    _ => {
                        return Err(SnapshotError::ValuePresenceMismatch {
                            element: *element,
                            key: *key,
                        })
                    }
                };
                entries.push(HistoryEntrySnap {
                    presence: entry.presence,
                    value,
                    prov: entry.prov,
                });
            }
            history.push(HistorySnap {
                element: *element,
                key: *key,
                entries,
                truncated: h.truncated(),
            });
        }

        Ok(Snapshot {
            nodes,
            edges,
            provenance: self.prov.values().cloned().collect(),
            history,
            batches: self.log.clone(),
        })
    }
}

// ---------------------------------------------------------------------------
// Back in

/// Strictly ascending, with duplicates named separately from disorder.
fn ordered<T: Ord + Copy>(
    previous: &mut Option<T>,
    next: T,
    section: &'static str,
    duplicate: impl FnOnce() -> SnapshotError,
) -> Result<(), SnapshotError> {
    if let Some(prev) = previous {
        if next == *prev {
            return Err(duplicate());
        }
        if next < *prev {
            return Err(SnapshotError::OutOfOrder { section });
        }
    }
    *previous = Some(next);
    Ok(())
}

struct Loader<'a> {
    graph: Graph,
    prov: &'a BTreeMap<ProvenanceId, ProvenanceRecord>,
}

impl Loader<'_> {
    fn require_prov(&self, id: ProvenanceId) -> Result<(), SnapshotError> {
        if self.prov.contains_key(&id) {
            Ok(())
        } else {
            Err(SnapshotError::DanglingProvenance { id })
        }
    }

    fn require_element(&self, element: ElementId) -> Result<(), SnapshotError> {
        let exists = match element {
            ElementId::Node(id) => self.graph.nodes.contains_key(&id),
            ElementId::Edge(id) => self.graph.edges.contains_key(&id),
        };
        if exists {
            Ok(())
        } else {
            Err(SnapshotError::UnknownElement { element })
        }
    }

    /// One element's field slots, type-checked back into the declared type.
    fn slots(
        &self,
        element: ElementId,
        fields: &[FieldSnap],
        section: &'static str,
    ) -> Result<BTreeMap<FieldKey, Slot>, SnapshotError> {
        let mut out = BTreeMap::new();
        let mut previous: Option<FieldKey> = None;
        for f in fields {
            ordered(&mut previous, f.key, section, || {
                SnapshotError::DuplicateElement { element }
            })?;
            if !declares(element, f.key) {
                return Err(SnapshotError::L0(WriteError::UndeclaredField {
                    element,
                    key: f.key,
                }));
            }
            self.require_prov(f.prov)?;
            let value = match (f.presence, &f.value) {
                (StoredPresence::Unknown, _) => {
                    return Err(SnapshotError::UnknownFieldPresence {
                        element,
                        key: f.key,
                    })
                }
                (StoredPresence::Set, Some(j)) => Some(slot_from_canon(f.key, j)?),
                (StoredPresence::Absent, None) => None,
                _ => {
                    return Err(SnapshotError::ValuePresenceMismatch {
                        element,
                        key: f.key,
                    })
                }
            };
            out.insert(
                f.key,
                Slot {
                    presence: f.presence,
                    value,
                    prov: f.prov,
                },
            );
        }
        Ok(out)
    }
}

impl Graph {
    /// Rebuild a store from a snapshot, refusing everything the write path
    /// would have refused and everything only a file can get wrong.
    pub fn from_snapshot(s: &Snapshot) -> Result<Graph, SnapshotError> {
        // Provenance first: everything else references it.
        let mut prov: BTreeMap<ProvenanceId, ProvenanceRecord> = BTreeMap::new();
        let mut previous: Option<ProvenanceId> = None;
        for record in &s.provenance {
            ordered(&mut previous, record.id, "provenance", || {
                SnapshotError::DanglingProvenance { id: record.id }
            })?;
            prov.insert(record.id, record.clone());
        }

        let mut loader = Loader {
            graph: Graph::new(),
            prov: &prov,
        };

        // Nodes, with their tombstones, before any edge: the L0 bound counts
        // are over *effective* edges, which reads each endpoint's tombstone.
        let mut previous: Option<NodeId> = None;
        for n in &s.nodes {
            ordered(&mut previous, n.id, "nodes", || {
                SnapshotError::DuplicateElement {
                    element: ElementId::Node(n.id),
                }
            })?;
            if loader.graph.by_ulid.contains_key(&n.id.ulid) {
                return Err(SnapshotError::L0(WriteError::UlidReused {
                    ulid: n.id.ulid,
                }));
            }
            loader.require_prov(n.existence)?;
            let fields = loader.slots(ElementId::Node(n.id), &n.fields, "node fields")?;
            loader.graph.nodes.insert(
                n.id,
                Node {
                    id: n.id,
                    existence: n.existence,
                    absent_since: n.absent_since,
                    fields,
                },
            );
            loader
                .graph
                .by_ulid
                .insert(n.id.ulid, ElementId::Node(n.id));
        }

        // Edges, through the write path's own ladder.
        let mut previous: Option<EdgeId> = None;
        for e in &s.edges {
            ordered(&mut previous, e.id, "edges", || {
                SnapshotError::DuplicateElement {
                    element: ElementId::Edge(e.id),
                }
            })?;
            if loader.graph.by_ulid.contains_key(&e.id.ulid) {
                return Err(SnapshotError::L0(WriteError::UlidReused {
                    ulid: e.id.ulid,
                }));
            }
            // The writer normalised symmetric pairs, so a denormalised one is
            // tampering or a bug. `from_snapshot` never silently fixes it.
            if e.id.kind.symmetric() && e.to < e.from {
                return Err(SnapshotError::SymmetricNotNormalised { edge: e.id });
            }
            let (from, to) = loader.graph.check_edge_l0(e.id.kind, e.from, e.to)?;
            if (from, to) != (e.from, e.to) {
                return Err(SnapshotError::SymmetricNotNormalised { edge: e.id });
            }
            loader.require_prov(e.prov)?;
            let fields = loader.slots(ElementId::Edge(e.id), &e.fields, "edge fields")?;
            loader.graph.edges.insert(
                e.id,
                Edge {
                    id: e.id,
                    from,
                    to,
                    prov: e.prov,
                    absent_since: e.absent_since,
                    fields,
                },
            );
            loader
                .graph
                .by_ulid
                .insert(e.id.ulid, ElementId::Edge(e.id));
            insert_sorted(loader.graph.out.entry((from, e.id.kind)).or_default(), e.id);
            insert_sorted(loader.graph.inn.entry((to, e.id.kind)).or_default(), e.id);
            if e.id.kind.class() == EdgeClass::Containment {
                loader.graph.owner_edge.insert(to, e.id);
            }
        }

        // History, verbatim. Its per-entry origin is the origin of the entry's
        // own provenance record — the same value the store recorded.
        let mut previous: Option<(ElementId, FieldKey)> = None;
        for h in &s.history {
            ordered(&mut previous, (h.element, h.key), "history", || {
                SnapshotError::DuplicateElement { element: h.element }
            })?;
            loader.require_element(h.element)?;
            let mut entries = Vec::with_capacity(h.entries.len());
            let mut origins = Vec::with_capacity(h.entries.len());
            for entry in &h.entries {
                loader.require_prov(entry.prov)?;
                let value = match (entry.presence, &entry.value) {
                    (StoredPresence::Set, Some(j)) => Some(slot_from_canon(h.key, j)?),
                    (StoredPresence::Set, None) | (_, Some(_)) => {
                        return Err(SnapshotError::ValuePresenceMismatch {
                            element: h.element,
                            key: h.key,
                        })
                    }
                    (_, None) => None,
                };
                origins.push(prov[&entry.prov].origin.discriminant());
                entries.push(HistoryEntry {
                    presence: entry.presence,
                    value,
                    prov: entry.prov,
                });
            }
            loader.graph.history.insert(
                (h.element, h.key),
                FieldHistory::install(entries, origins, h.truncated),
            );
        }

        // The op log, verbatim. No ops are appended by loading.
        for batch in &s.batches {
            for op in &batch.ops {
                match op {
                    Op::AddNode { node, prov } => {
                        loader.require_element(ElementId::Node(*node))?;
                        loader.require_prov(*prov)?;
                    }
                    Op::AddEdge {
                        edge,
                        from,
                        to,
                        prov,
                    } => {
                        loader.require_element(ElementId::Edge(*edge))?;
                        loader.require_element(ElementId::Node(*from))?;
                        loader.require_element(ElementId::Node(*to))?;
                        loader.require_prov(*prov)?;
                    }
                    Op::SetField { element, prov, .. } => {
                        loader.require_element(*element)?;
                        loader.require_prov(*prov)?;
                    }
                    Op::Tombstone { element, .. } => loader.require_element(*element)?,
                }
            }
        }

        let mut graph = loader.graph;
        graph.prov = prov;
        graph.log = s.batches.clone();
        Ok(graph)
    }
}
