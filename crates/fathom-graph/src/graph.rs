//! The store.
//!
//! **Internals are `std::collections::BTreeMap` and `Vec`, nothing else.**
//! `11` §13's `SlotMap`/`HashMap`/`EnumMap`/`SmallVec`/`CompactString` are
//! external crates and its own status line calls that section *"Illustrative
//! of the shape"*, so the zero-dependency position wins. `BTreeMap` keyed by
//! the composite ids gives sorted-by-id iteration and by-kind range scans
//! directly, which satisfies `11`'s own rule that order is *"never derived
//! from HashMap order"*. There is no `HashMap` here (its `RandomState` seeds
//! per process) and no sorting at read: order is a property of the
//! structures.
//!
//! Adjacency is maintained incrementally in both directions —
//! `reverse_index: true` on every declared edge obliges the reverse map
//! (`62` §6.2).
//!
//! **Identity tuples are not checked on insert, at all.** `11` §10.3:
//! *"Identity tuples are only used by re-identification. They are never used
//! for lookup, never used by rules, never persisted as a key."*
//! Re-identification runs on re-parse (ADR-0010) and no parser exists. Two
//! nodes with identical would-be tier-1 tuples are two nodes; nothing in this
//! crate reads `schema.yaml`'s `identity:` blocks.

use core::any::{Any, TypeId};
use core::fmt;
use std::collections::BTreeMap;

use fathom_id::Ulid;
use fathom_ir::bag::{FieldBag, FieldKey};
use fathom_ir::generated::accessors::slot_type;
use fathom_ir::generated::ir_types::{EdgeClass, EdgeKind, NodeKind};

use crate::field::{FieldHistory, FieldInfo, HistoryEntry, StoredPresence};
use crate::id::{EdgeId, ElementId, NodeId};
use crate::op::{Batch, BatchId, Op, LABEL_MAX_BYTES};
use crate::prov::{Actor, Origin, ProvenanceId, ProvenanceRecord, Timestamp};

/// One stored field. `Unknown` is not representable here: it *is* the absence
/// of a slot (`11` §5.2).
pub(crate) struct Slot {
    pub(crate) presence: StoredPresence,
    pub(crate) value: Option<Box<dyn Any>>,
    pub(crate) prov: ProvenanceId,
}

/// A node. Field slots are private: presence and provenance are read through
/// `Graph::presence`, and typed values through the generated accessors over
/// the `FieldBag` impl below.
pub struct Node {
    pub id: NodeId,
    pub existence: ProvenanceId,
    /// `11` §10.5's tombstone. A tombstoned node is not deleted.
    pub absent_since: Option<Timestamp>,
    pub(crate) fields: BTreeMap<FieldKey, Slot>,
}

/// An edge. First-class: stable id, kind, typed fields (ADR-0007).
pub struct Edge {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub prov: ProvenanceId,
    pub absent_since: Option<Timestamp>,
    pub(crate) fields: BTreeMap<FieldKey, Slot>,
}

fn bag_slot(fields: &BTreeMap<FieldKey, Slot>, key: FieldKey) -> Option<&dyn Any> {
    let slot = fields.get(&key)?;
    match slot.presence {
        // Only `Set` yields a value. The accessors see `Missing` for `Absent`
        // and `Unknown` alike; the three-way distinction is `Graph::presence`.
        StoredPresence::Set => slot.value.as_deref(),
        StoredPresence::Absent | StoredPresence::Unknown => None,
    }
}

impl FieldBag for Node {
    fn field(&self, key: FieldKey) -> Option<&dyn Any> {
        bag_slot(&self.fields, key)
    }
}

impl FieldBag for Edge {
    fn field(&self, key: FieldKey) -> Option<&dyn Any> {
        bag_slot(&self.fields, key)
    }
}

/// Which end of an edge a refusal is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    From,
    To,
}

impl End {
    fn name(self) -> &'static str {
        match self {
            End::From => "from",
            End::To => "to",
        }
    }
}

/// Why a mutation did not happen. `62` §12.1's L0 vocabulary: *"A type error.
/// The write does not happen; the error names the violated declaration."*
///
/// The derive matches `ReadError`'s below: both describe one direction of the
/// same store, and every payload here is an id, a kind or a field key, all of
/// them already `Clone + Eq`. WO-09 §4.5.1 authorises this line so a caller
/// can carry a refusal whole instead of collapsing it to a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteError {
    NoOpenBatch,
    BatchAlreadyOpen {
        open: BatchId,
    },
    BatchIdReused {
        id: BatchId,
    },
    LabelTooLong {
        len: usize,
    },
    UlidReused {
        ulid: Ulid,
    },
    UnknownElement {
        element: ElementId,
    },
    MissingEndpoint {
        edge: EdgeKind,
        end: End,
        id: NodeId,
    },
    EndpointKind {
        edge: EdgeKind,
        from: NodeKind,
        to: NodeKind,
        end: End,
        allowed: &'static [NodeKind],
    },
    RootContainment {
        edge: EdgeKind,
    },
    SymmetricDuplicate {
        edge: EdgeKind,
        existing: EdgeId,
    },
    SecondContainment {
        node: NodeId,
        existing: EdgeId,
    },
    ContainmentCycle {
        edge: EdgeKind,
        from: NodeId,
        to: NodeId,
    },
    SetCycle {
        edge: EdgeKind,
        from: NodeId,
        to: NodeId,
    },
    OutBoundExceeded {
        edge: EdgeKind,
        from: NodeId,
        max: u32,
    },
    InBoundExceeded {
        edge: EdgeKind,
        to: NodeId,
        max: u32,
    },
    UndeclaredField {
        element: ElementId,
        key: FieldKey,
    },
    WrongType {
        key: FieldKey,
        declared: &'static str,
    },
    ProvenanceIdReused {
        id: ProvenanceId,
    },
    SupersedesIsStoreOwned {
        id: ProvenanceId,
    },
    AlreadyTombstoned {
        element: ElementId,
    },
}

fn kind_list(kinds: &[NodeKind]) -> String {
    let mut out = String::new();
    for (i, k) in kinds.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(k.name());
    }
    out
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteError::NoOpenBatch => f.write_str(
                "no open batch: every mutation is recorded in the batch the caller opened",
            ),
            WriteError::BatchAlreadyOpen { open } => {
                write!(f, "batch {} is already open", open.0)
            }
            WriteError::BatchIdReused { id } => write!(f, "batch id {} is already used", id.0),
            WriteError::LabelTooLong { len } => write!(
                f,
                "batch label is {len} bytes; the bound is {LABEL_MAX_BYTES} (53 §7.2)"
            ),
            WriteError::UlidReused { ulid } => {
                write!(f, "ULID {ulid} is already used by an element in this store")
            }
            WriteError::UnknownElement { element } => write!(f, "no element {element}"),
            WriteError::MissingEndpoint { edge, end, id } => write!(
                f,
                "{}'s {} endpoint {id} does not exist",
                edge.name(),
                end.name()
            ),
            WriteError::EndpointKind {
                edge,
                from,
                to,
                end,
                allowed,
            } => write!(
                f,
                "{} declares {}: [{}]; {} -> {} puts {} at the {} end",
                edge.name(),
                end.name(),
                kind_list(allowed),
                from.name(),
                to.name(),
                match end {
                    End::From => from.name(),
                    End::To => to.name(),
                },
                end.name()
            ),
            WriteError::RootContainment { edge } => write!(
                f,
                "{} is contained by the workspace root, which is not a node (11 §7.2)",
                edge.name()
            ),
            WriteError::SymmetricDuplicate { edge, existing } => write!(
                f,
                "{} is symmetric: {existing} already stores this pair (62 §6.2)",
                edge.name()
            ),
            WriteError::SecondContainment { node, existing } => write!(
                f,
                "{node} already has the containment in-edge {existing}; exactly one per node \
                 (11 §7.2)"
            ),
            WriteError::ContainmentCycle { edge, from, to } => write!(
                f,
                "{} {from} -> {to} closes a containment cycle; containment is a forest (11 §9.1)",
                edge.name()
            ),
            WriteError::SetCycle { edge, from, to } => write!(
                f,
                "{} {from} -> {to} closes a set-nesting cycle (11 §6.6)",
                edge.name()
            ),
            WriteError::OutBoundExceeded { edge, from, max } => write!(
                f,
                "{} declares out: max {max}; {from} already has that many (11 §7.1)",
                edge.name()
            ),
            WriteError::InBoundExceeded { edge, to, max } => write!(
                f,
                "{} declares in: max {max}; {to} already has that many (11 §7.1)",
                edge.name()
            ),
            WriteError::UndeclaredField { element, key } => write!(
                f,
                "field key {} is not declared on {element}'s kind (ADR-0008)",
                key.0
            ),
            WriteError::WrongType { key, declared } => write!(
                f,
                "field key {} declares slot type {declared} (62 §12.1)",
                key.0
            ),
            WriteError::ProvenanceIdReused { id } => write!(
                f,
                "provenance record {} is already interned with different content; records are \
                 immutable (11 §8.2)",
                id.0
            ),
            WriteError::SupersedesIsStoreOwned { id } => write!(
                f,
                "provenance record {}: supersedes is filled by the store on re-writes, never by \
                 the caller (11 §8.6)",
                id.0
            ),
            WriteError::AlreadyTombstoned { element } => {
                write!(f, "{element} is already tombstoned")
            }
        }
    }
}

/// Why a read returned nothing it could name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError {
    UnknownElement { element: ElementId },
    UndeclaredField { key: FieldKey },
}

impl fmt::Display for ReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadError::UnknownElement { element } => write!(f, "no element {element}"),
            ReadError::UndeclaredField { key } => {
                write!(f, "field key {} is not declared on this kind", key.0)
            }
        }
    }
}

/// The in-memory typed graph.
pub struct Graph {
    pub(crate) nodes: BTreeMap<NodeId, Node>,
    pub(crate) edges: BTreeMap<EdgeId, Edge>,
    /// ULID uniqueness across the whole store, and `resolve_ref`'s index: a
    /// bare `fathom_id::NodeId` reference carries a ULID and nothing else.
    pub(crate) by_ulid: BTreeMap<Ulid, ElementId>,
    pub(crate) out: BTreeMap<(NodeId, EdgeKind), Vec<EdgeId>>,
    pub(crate) inn: BTreeMap<(NodeId, EdgeKind), Vec<EdgeId>>,
    pub(crate) owner_edge: BTreeMap<NodeId, EdgeId>,
    pub(crate) prov: BTreeMap<ProvenanceId, ProvenanceRecord>,
    pub(crate) history: BTreeMap<(ElementId, FieldKey), FieldHistory>,
    pub(crate) log: Vec<Batch>,
    pub(crate) open: Option<Batch>,
}

impl Default for Graph {
    fn default() -> Self {
        Graph::new()
    }
}

const EMPTY_ADJACENCY: &[EdgeId] = &[];

impl Graph {
    pub fn new() -> Graph {
        Graph {
            nodes: BTreeMap::new(),
            edges: BTreeMap::new(),
            by_ulid: BTreeMap::new(),
            out: BTreeMap::new(),
            inn: BTreeMap::new(),
            owner_edge: BTreeMap::new(),
            prov: BTreeMap::new(),
            history: BTreeMap::new(),
            log: Vec::new(),
            open: None,
        }
    }

    // ---- batches ----------------------------------------------------------

    /// Open the batch every following mutation is recorded in.
    pub fn begin_batch(&mut self, id: BatchId, label: &str) -> Result<(), WriteError> {
        if let Some(open) = &self.open {
            return Err(WriteError::BatchAlreadyOpen { open: open.id });
        }
        if self.log.iter().any(|b| b.id == id) {
            return Err(WriteError::BatchIdReused { id });
        }
        if label.len() > LABEL_MAX_BYTES {
            return Err(WriteError::LabelTooLong { len: label.len() });
        }
        self.open = Some(Batch {
            id,
            label: label.to_owned(),
            ops: Vec::new(),
        });
        Ok(())
    }

    /// Close the open batch and commit it to the log.
    pub fn end_batch(&mut self) -> Result<BatchId, WriteError> {
        let batch = self.open.take().ok_or(WriteError::NoOpenBatch)?;
        let id = batch.id;
        self.log.push(batch);
        Ok(id)
    }

    /// Committed batches, in the order they were closed.
    pub fn log(&self) -> &[Batch] {
        &self.log
    }

    fn require_batch(&self) -> Result<(), WriteError> {
        if self.open.is_none() {
            return Err(WriteError::NoOpenBatch);
        }
        Ok(())
    }

    fn record(&mut self, op: Op) {
        self.open
            .as_mut()
            .expect("checked by require_batch")
            .ops
            .push(op);
    }

    // ---- provenance -------------------------------------------------------

    /// The `supersedes: None` and id-reuse checks, and the filled record they
    /// admit. `supersedes` is the store's to write (`11` §8.6).
    fn check_prov(
        &self,
        rec: &ProvenanceRecord,
        current: Option<ProvenanceId>,
    ) -> Result<ProvenanceRecord, WriteError> {
        if rec.supersedes.is_some() {
            return Err(WriteError::SupersedesIsStoreOwned { id: rec.id });
        }
        let filled = ProvenanceRecord {
            supersedes: current,
            ..rec.clone()
        };
        if let Some(existing) = self.prov.get(&filled.id) {
            if *existing != filled {
                return Err(WriteError::ProvenanceIdReused { id: filled.id });
            }
        }
        Ok(filled)
    }

    fn intern(&mut self, filled: ProvenanceRecord) -> ProvenanceId {
        let id = filled.id;
        self.prov.entry(id).or_insert(filled);
        id
    }

    /// One interned record, by id.
    pub fn provenance(&self, id: ProvenanceId) -> Option<&ProvenanceRecord> {
        self.prov.get(&id)
    }

    // ---- nodes ------------------------------------------------------------

    /// Insert a bare node. Any kind is insertable with no fields — a graph
    /// holding one `Device` with only a hostname is a **correct** graph
    /// (`11` §9.1).
    pub fn insert_node(
        &mut self,
        kind: NodeKind,
        ulid: Ulid,
        existence: ProvenanceRecord,
    ) -> Result<NodeId, WriteError> {
        self.require_batch()?;
        let filled = self.check_prov(&existence, None)?;
        if self.by_ulid.contains_key(&ulid) {
            return Err(WriteError::UlidReused { ulid });
        }
        let id = NodeId { kind, ulid };
        let prov = self.intern(filled);
        self.nodes.insert(
            id,
            Node {
                id,
                existence: prov,
                absent_since: None,
                fields: BTreeMap::new(),
            },
        );
        self.by_ulid.insert(ulid, ElementId::Node(id));
        self.record(Op::AddNode { node: id, prov });
        Ok(id)
    }

    // ---- edges ------------------------------------------------------------

    /// Insert an edge, running the L0 ladder in a fixed order so refusals are
    /// deterministic: the first failing check is the returned error.
    pub fn insert_edge(
        &mut self,
        kind: EdgeKind,
        ulid: Ulid,
        from: NodeId,
        to: NodeId,
        prov: ProvenanceRecord,
    ) -> Result<EdgeId, WriteError> {
        self.require_batch()?;
        let filled = self.check_prov(&prov, None)?;

        if self.by_ulid.contains_key(&ulid) {
            return Err(WriteError::UlidReused { ulid });
        }
        let (from, to) = self.check_edge_l0(kind, from, to)?;

        let id = EdgeId { kind, ulid };
        let prov = self.intern(filled);
        self.edges.insert(
            id,
            Edge {
                id,
                from,
                to,
                prov,
                absent_since: None,
                fields: BTreeMap::new(),
            },
        );
        self.by_ulid.insert(ulid, ElementId::Edge(id));
        insert_sorted(self.out.entry((from, kind)).or_default(), id);
        insert_sorted(self.inn.entry((to, kind)).or_default(), id);
        if kind.class() == EdgeClass::Containment {
            self.owner_edge.insert(to, id);
        }
        self.record(Op::AddEdge {
            edge: id,
            from,
            to,
            prov,
        });
        Ok(id)
    }

    /// The L0 ladder for an edge that is about to exist, in the fixed order
    /// that makes a refusal a function of the edge and not of what else is in
    /// the store. Returns the pair in stored order — normalised for a
    /// symmetric kind.
    ///
    /// Extracted from `insert_edge` unchanged so that `Graph::from_snapshot`
    /// runs *this* ladder rather than a second copy of it: loading is not
    /// trusting, and the refusal set on load must be the refusal set on write.
    pub(crate) fn check_edge_l0(
        &self,
        kind: EdgeKind,
        from: NodeId,
        to: NodeId,
    ) -> Result<(NodeId, NodeId), WriteError> {
        if kind.root_containment() {
            return Err(WriteError::RootContainment { edge: kind });
        }
        if !self.nodes.contains_key(&from) {
            return Err(WriteError::MissingEndpoint {
                edge: kind,
                end: End::From,
                id: from,
            });
        }
        if !self.nodes.contains_key(&to) {
            return Err(WriteError::MissingEndpoint {
                edge: kind,
                end: End::To,
                id: to,
            });
        }
        if !kind.from_kinds().contains(&from.kind) {
            return Err(WriteError::EndpointKind {
                edge: kind,
                from: from.kind,
                to: to.kind,
                end: End::From,
                allowed: kind.from_kinds(),
            });
        }
        if !kind.to_kinds().contains(&to.kind) {
            return Err(WriteError::EndpointKind {
                edge: kind,
                from: from.kind,
                to: to.kind,
                end: End::To,
                allowed: kind.to_kinds(),
            });
        }

        // `11` §7.4: on write, the endpoint with the lexicographically smaller
        // `NodeId` becomes `from`. Direction on a symmetric edge is meaningless
        // and consumers must never read meaning into it.
        let (from, to) = if kind.symmetric() && to < from {
            (to, from)
        } else {
            (from, to)
        };
        if kind.symmetric() {
            if let Some(existing) = self.live_edge_between(kind, from, to) {
                return Err(WriteError::SymmetricDuplicate {
                    edge: kind,
                    existing,
                });
            }
        }

        if kind.class() == EdgeClass::Containment {
            if let Some(existing) = self.live_owner_edge(to) {
                return Err(WriteError::SecondContainment { node: to, existing });
            }
            // Walking owner() up from `from` must never reach `to`.
            let mut cur = Some(from);
            let mut guard = self.nodes.len() + 1;
            while let Some(n) = cur {
                if n == to {
                    return Err(WriteError::ContainmentCycle {
                        edge: kind,
                        from,
                        to,
                    });
                }
                if guard == 0 {
                    break;
                }
                guard -= 1;
                cur = self.owner(n);
            }
        }

        if matches!(kind, EdgeKind::Contains | EdgeKind::ContainsApp) {
            // A self-loop is a one-edge cycle; otherwise refuse a directed
            // path of same-kind live edges from `to` back to `from`.
            if from == to || self.reaches(kind, to, from) {
                return Err(WriteError::SetCycle {
                    edge: kind,
                    from,
                    to,
                });
            }
        }

        // Upper bounds only: the lower bound is L1's, not this store's to
        // refuse (`11` §7.1). Counted per stored direction, over effective
        // edges — not tombstoned, neither endpoint tombstoned — so that
        // tombstone-then-replace works without `Purge`.
        if let Some(max) = kind.out_bound_l0().max {
            if self.effective_degree(&self.out, from, kind) >= max as usize {
                return Err(WriteError::OutBoundExceeded {
                    edge: kind,
                    from,
                    max,
                });
            }
        }
        if let Some(max) = kind.in_bound_l0().max {
            if self.effective_degree(&self.inn, to, kind) >= max as usize {
                return Err(WriteError::InBoundExceeded {
                    edge: kind,
                    to,
                    max,
                });
            }
        }

        Ok((from, to))
    }

    /// Not tombstoned, and neither endpoint tombstoned.
    fn is_effective(&self, e: &Edge) -> bool {
        e.absent_since.is_none()
            && self
                .nodes
                .get(&e.from)
                .is_some_and(|n| n.absent_since.is_none())
            && self
                .nodes
                .get(&e.to)
                .is_some_and(|n| n.absent_since.is_none())
    }

    fn effective_degree(
        &self,
        index: &BTreeMap<(NodeId, EdgeKind), Vec<EdgeId>>,
        n: NodeId,
        k: EdgeKind,
    ) -> usize {
        index
            .get(&(n, k))
            .map_or(EMPTY_ADJACENCY, Vec::as_slice)
            .iter()
            .filter(|id| self.edges.get(id).is_some_and(|e| self.is_effective(e)))
            .count()
    }

    fn live_edge_between(&self, k: EdgeKind, from: NodeId, to: NodeId) -> Option<EdgeId> {
        self.out
            .get(&(from, k))
            .map_or(EMPTY_ADJACENCY, Vec::as_slice)
            .iter()
            .find(|id| {
                self.edges
                    .get(id)
                    .is_some_and(|e| e.to == to && self.is_effective(e))
            })
            .copied()
    }

    fn live_owner_edge(&self, n: NodeId) -> Option<EdgeId> {
        let id = *self.owner_edge.get(&n)?;
        let e = self.edges.get(&id)?;
        if self.is_effective(e) {
            Some(id)
        } else {
            None
        }
    }

    /// Is `target` reachable from `start` over live edges of one kind?
    ///
    /// `11` §6.6 names a union-find for this; undirected connectivity would
    /// refuse the legal diamond (one `AddressObject` in two sets joins their
    /// components with no directed cycle), so this is a directed walk. The L0
    /// outcome `11` requires — cycles refused at write — is unchanged.
    fn reaches(&self, k: EdgeKind, start: NodeId, target: NodeId) -> bool {
        let mut seen: Vec<NodeId> = vec![start];
        let mut stack = vec![start];
        while let Some(n) = stack.pop() {
            if n == target {
                return true;
            }
            for e in self.out(n, k) {
                if self.is_effective(e) && !seen.contains(&e.to) {
                    seen.push(e.to);
                    stack.push(e.to);
                }
            }
        }
        false
    }

    // ---- fields -----------------------------------------------------------

    /// Assert a value. `T` must be the slot type the schema declares for the
    /// key — the same `TypeId` the generated accessors read back.
    pub fn set_field<T: Any>(
        &mut self,
        element: ElementId,
        key: FieldKey,
        value: T,
        prov: ProvenanceRecord,
    ) -> Result<(), WriteError> {
        let (filled, declared) = self.check_field_write(element, key, &prov)?;
        match slot_type(key) {
            Some((want, _)) if want == TypeId::of::<T>() => {}
            _ => {
                return Err(WriteError::WrongType { key, declared });
            }
        }
        let id = self.intern(filled);
        self.archive_replaced(element, key);
        self.slot_map_mut(element).insert(
            key,
            Slot {
                presence: StoredPresence::Set,
                value: Some(Box::new(value)),
                prov: id,
            },
        );
        self.record(Op::SetField {
            element,
            key,
            presence: StoredPresence::Set,
            prov: id,
        });
        Ok(())
    }

    /// The same assertion, from a value whose type is only known at runtime.
    ///
    /// `set_field` is generic over `T`, so its type check is
    /// `TypeId::of::<T>()` — a compile-time question. **A byte protocol has no
    /// compile-time type**, so nothing arriving over the wasm boundary could
    /// ever call it; hand-authored values from the page had no way into the
    /// store at all. That is the one primitive hand authoring was missing.
    ///
    /// The check is not weakened, only moved: `(*value).type_id()` asks the
    /// boxed value what it actually is, and it is compared against the same
    /// `slot_type(key)` the schema declares. A wrong box is `WrongType`, exactly
    /// as a wrong `T` is. The body below is `set_field`'s, and the two must stay
    /// that way — a divergence would mean hand-entered values were recorded
    /// differently from parsed ones, which `Origin` is supposed to be the only
    /// difference between.
    ///
    /// `Graph::from_snapshot` already installs erased values this way
    /// (`snap.rs`), but it builds the crate-private `Slot` directly and so is
    /// unreachable from outside. This is that capability, made public and
    /// type-checked.
    pub fn set_field_boxed(
        &mut self,
        element: ElementId,
        key: FieldKey,
        value: Box<dyn Any>,
        prov: ProvenanceRecord,
    ) -> Result<(), WriteError> {
        let (filled, declared) = self.check_field_write(element, key, &prov)?;
        match slot_type(key) {
            Some((want, _)) if want == (*value).type_id() => {}
            _ => {
                return Err(WriteError::WrongType { key, declared });
            }
        }
        let id = self.intern(filled);
        self.archive_replaced(element, key);
        self.slot_map_mut(element).insert(
            key,
            Slot {
                presence: StoredPresence::Set,
                value: Some(value),
                prov: id,
            },
        );
        self.record(Op::SetField {
            element,
            key,
            presence: StoredPresence::Set,
            prov: id,
        });
        Ok(())
    }

    /// Assert that the field has no value. Only a closed-world observation or
    /// an explicit human assertion may say this (`11` §8.5); the parser never
    /// asserts absence, because `14` §7.4 pins its capture scope to
    /// `Fragment` and `11` §10.5 gives `Fragment` scope no licence to assert
    /// absence (WO-03 §12 item 6; WO-09 §4.2, §4.5).
    pub fn assert_absent(
        &mut self,
        element: ElementId,
        key: FieldKey,
        prov: ProvenanceRecord,
    ) -> Result<(), WriteError> {
        let (filled, _) = self.check_field_write(element, key, &prov)?;
        let id = self.intern(filled);
        self.archive_replaced(element, key);
        self.slot_map_mut(element).insert(
            key,
            Slot {
                presence: StoredPresence::Absent,
                value: None,
                prov: id,
            },
        );
        self.record(Op::SetField {
            element,
            key,
            presence: StoredPresence::Absent,
            prov: id,
        });
        Ok(())
    }

    /// Clear the field. `11` §8.5: *"clearing a field must produce `Unknown`,
    /// not `Absent`"* — so the slot is removed, and the clear's own
    /// provenance is recorded in the history and in the op log, because no
    /// slot remains to carry it.
    pub fn clear_field(
        &mut self,
        element: ElementId,
        key: FieldKey,
        prov: ProvenanceRecord,
    ) -> Result<(), WriteError> {
        let (filled, _) = self.check_field_write(element, key, &prov)?;
        let origin = filled.origin;
        let id = self.intern(filled);
        self.archive_replaced(element, key);
        self.slot_map_mut(element).remove(&key);
        self.history
            .entry((element, key))
            .or_insert_with(FieldHistory::new)
            .push(
                HistoryEntry {
                    presence: StoredPresence::Unknown,
                    value: None,
                    prov: id,
                },
                origin,
            );
        self.record(Op::SetField {
            element,
            key,
            presence: StoredPresence::Unknown,
            prov: id,
        });
        Ok(())
    }

    /// The checks every field write shares, in the fixed order that makes a
    /// refusal a function of the write and not of what else is in the store:
    /// open batch, then provenance, then existence, then declaration.
    /// Returns the record the store will intern and the declared slot-type
    /// path the typed write needs for its error.
    fn check_field_write(
        &self,
        element: ElementId,
        key: FieldKey,
        prov: &ProvenanceRecord,
    ) -> Result<(ProvenanceRecord, &'static str), WriteError> {
        self.require_batch()?;
        let filled = self.check_prov(prov, self.slot_prov(element, key))?;
        if !self.exists(element) {
            return Err(WriteError::UnknownElement { element });
        }
        if !declares(element, key) {
            return Err(WriteError::UndeclaredField { element, key });
        }
        match slot_type(key) {
            Some((_, path)) => Ok((filled, path)),
            // A declared field always has a registry slot type; both come from
            // the same generator run. Refusing is the honest fallback.
            None => Err(WriteError::UndeclaredField { element, key }),
        }
    }

    /// Move the replaced slot (value moved, never cloned) into the history.
    fn archive_replaced(&mut self, element: ElementId, key: FieldKey) {
        let Some(old) = self.slot_map_mut(element).remove(&key) else {
            return;
        };
        let origin = self.prov.get(&old.prov).map_or(Origin::Hand, |r| r.origin);
        self.history
            .entry((element, key))
            .or_insert_with(FieldHistory::new)
            .push(
                HistoryEntry {
                    presence: old.presence,
                    value: old.value,
                    prov: old.prov,
                },
                origin,
            );
    }

    fn slot_map_mut(&mut self, element: ElementId) -> &mut BTreeMap<FieldKey, Slot> {
        match element {
            ElementId::Node(id) => &mut self.nodes.get_mut(&id).expect("checked").fields,
            ElementId::Edge(id) => &mut self.edges.get_mut(&id).expect("checked").fields,
        }
    }

    fn slot(&self, element: ElementId, key: FieldKey) -> Option<&Slot> {
        match element {
            ElementId::Node(id) => self.nodes.get(&id)?.fields.get(&key),
            ElementId::Edge(id) => self.edges.get(&id)?.fields.get(&key),
        }
    }

    fn slot_prov(&self, element: ElementId, key: FieldKey) -> Option<ProvenanceId> {
        self.slot(element, key).map(|s| s.prov)
    }

    fn exists(&self, element: ElementId) -> bool {
        match element {
            ElementId::Node(id) => self.nodes.contains_key(&id),
            ElementId::Edge(id) => self.edges.contains_key(&id),
        }
    }

    // ---- tombstones -------------------------------------------------------

    /// Mark absence (`11` §10.5: *"A tombstoned node is not deleted"*).
    /// Tombstoning a node also tombstones every live node in its containment
    /// subtree (`11` §3.4: *"Deleting the owner deletes the target"*), one op
    /// per element, in `NodeId` order. Incident edges are not marked: an edge
    /// with a tombstoned endpoint is effectively absent, and views own its
    /// rendering.
    /// `by` is required rather than defaulted: a removal with no author is the
    /// one gap an audit log can never fill in afterwards, so the type system
    /// asks for it at every call site instead of trusting each one to remember.
    pub fn tombstone(
        &mut self,
        element: ElementId,
        at: Timestamp,
        by: Actor,
    ) -> Result<(), WriteError> {
        self.require_batch()?;
        if !self.exists(element) {
            return Err(WriteError::UnknownElement { element });
        }
        let already = match element {
            ElementId::Node(id) => self.nodes[&id].absent_since.is_some(),
            ElementId::Edge(id) => self.edges[&id].absent_since.is_some(),
        };
        if already {
            return Err(WriteError::AlreadyTombstoned { element });
        }
        match element {
            ElementId::Edge(id) => {
                self.edges.get_mut(&id).expect("checked").absent_since = Some(at);
                self.record(Op::Tombstone { element, at, by });
            }
            ElementId::Node(id) => {
                let mut subtree = vec![id];
                let mut frontier = vec![id];
                while let Some(n) = frontier.pop() {
                    for child in self.containment_children(n) {
                        if !subtree.contains(&child) {
                            subtree.push(child);
                            frontier.push(child);
                        }
                    }
                }
                subtree.sort_unstable();
                for n in subtree {
                    self.nodes.get_mut(&n).expect("collected live").absent_since = Some(at);
                    self.record(Op::Tombstone {
                        element: ElementId::Node(n),
                        at,
                        by,
                    });
                }
            }
        }
        Ok(())
    }

    fn containment_children(&self, n: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        for k in EdgeKind::ALL {
            if k.class() != EdgeClass::Containment {
                continue;
            }
            for e in self.out(n, k) {
                if self.is_effective(e) && !out.contains(&e.to) {
                    out.push(e.to);
                }
            }
        }
        out
    }

    // ---- reads ------------------------------------------------------------

    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn edge(&self, id: EdgeId) -> Option<&Edge> {
        self.edges.get(&id)
    }

    /// The bridge from `11` §6.5's field-embedded reference type — a bare
    /// ULID with no kind — to this store's composite ids.
    pub fn resolve_ref(&self, r: fathom_id::NodeId) -> Option<ElementId> {
        self.by_ulid.get(&r.0).copied()
    }

    /// Every node, in `NodeId` order.
    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    /// One kind's nodes, in `NodeId` order — a range scan, not a filter.
    pub fn nodes_of_kind(&self, kind: NodeKind) -> impl Iterator<Item = &Node> {
        let lo = NodeId {
            kind,
            ulid: Ulid(0),
        };
        let hi = NodeId {
            kind,
            ulid: Ulid(u128::MAX),
        };
        self.nodes.range(lo..=hi).map(|(_, n)| n)
    }

    /// Every edge, in `EdgeId` order.
    pub fn edges(&self) -> impl Iterator<Item = &Edge> {
        self.edges.values()
    }

    pub fn edges_of_kind(&self, kind: EdgeKind) -> impl Iterator<Item = &Edge> {
        let lo = EdgeId {
            kind,
            ulid: Ulid(0),
        };
        let hi = EdgeId {
            kind,
            ulid: Ulid(u128::MAX),
        };
        self.edges.range(lo..=hi).map(|(_, e)| e)
    }

    /// Edges of one kind leaving `n`, in `EdgeId` order.
    pub fn out(&self, n: NodeId, k: EdgeKind) -> impl Iterator<Item = &Edge> {
        self.out
            .get(&(n, k))
            .map_or(EMPTY_ADJACENCY, Vec::as_slice)
            .iter()
            .filter_map(|id| self.edges.get(id))
    }

    /// Edges of one kind arriving at `n`, in `EdgeId` order. Maintained
    /// incrementally: `reverse_index: true` is declared on every edge.
    pub fn inn(&self, n: NodeId, k: EdgeKind) -> impl Iterator<Item = &Edge> {
        self.inn
            .get(&(n, k))
            .map_or(EMPTY_ADJACENCY, Vec::as_slice)
            .iter()
            .filter_map(|id| self.edges.get(id))
    }

    /// The containment parent. `None` for a forest root — and the five
    /// root-containment edge kinds are refused, so `Site`, `Tunnel`,
    /// `Premises`, `Cable`, `Tenant` and `ServiceType` are roots here.
    pub fn owner(&self, n: NodeId) -> Option<NodeId> {
        let id = self.live_owner_edge(n)?;
        self.edges.get(&id).map(|e| e.from)
    }

    /// Walk containment up to the owning `Device`, if there is one.
    pub fn device_of(&self, n: NodeId) -> Option<NodeId> {
        let mut cur = n;
        for _ in 0..=self.nodes.len() {
            if cur.kind == NodeKind::Device {
                return Some(cur);
            }
            cur = self.owner(cur)?;
        }
        None
    }

    /// The three-way presence a rule reads. A missing slot is `Unknown` with
    /// no provenance; `Absent` is stored explicitly and carries its own.
    pub fn presence(&self, element: ElementId, key: FieldKey) -> Result<FieldInfo, ReadError> {
        if !self.exists(element) {
            return Err(ReadError::UnknownElement { element });
        }
        if !declares(element, key) {
            return Err(ReadError::UndeclaredField { key });
        }
        Ok(match self.slot(element, key) {
            Some(s) => FieldInfo {
                presence: s.presence,
                prov: Some(s.prov),
            },
            None => FieldInfo {
                presence: StoredPresence::Unknown,
                prov: None,
            },
        })
    }

    /// The bounded history of one field (`11` §8.6). `None` where the field
    /// has never been written.
    pub fn history(&self, element: ElementId, key: FieldKey) -> Option<&FieldHistory> {
        self.history.get(&(element, key))
    }
}

/// Is the key one of the element's kind's declared fields? The kind travels
/// inside the id, so this needs no store lookup — ADR-0008 at the write
/// boundary, node and edge fields alike.
pub(crate) fn declares(element: ElementId, key: FieldKey) -> bool {
    match element {
        ElementId::Node(id) => id.kind.fields().contains(&key),
        ElementId::Edge(id) => id.kind.fields().contains(&key),
    }
}

pub(crate) fn insert_sorted(v: &mut Vec<EdgeId>, id: EdgeId) {
    if let Err(i) = v.binary_search(&id) {
        v.insert(i, id);
    }
}
