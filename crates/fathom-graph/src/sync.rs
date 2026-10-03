//! Append-only sync: grow a held store by the batches it has not seen.
//!
//! The op log records presence and provenance ids, not values, so a batch alone cannot be
//! replayed. A delta is therefore a [`Snapshot`] fragment (see [`Snapshot::since`]): the new
//! batches, the provenance they cite, and the state of every element and field they touched.
//!
//! **The ops are the instructions and the fragment is only the evidence.** Each op goes
//! through the write path's own checks (ULID reuse, `check_edge_l0` for an edge and for a
//! revive, tombstone-twice, declared field, provenance supersession). The fragment supplies
//! the values the ops lack, and after the replay every touched element must read exactly as
//! the fragment says, or the delta is refused.
//!
//! **Nothing unexplained.** Every field and tombstone of every touched element must read as the
//! fragment says, and the fragment may hold no element, history or provenance record that no op
//! names: evidence the ops do not explain is refused, not dropped.
//!
//! **Loadable.** A store this accepts must reload through `Graph::from_snapshot`, whose edge
//! ladder (in `EdgeId` order, against the final tombstones) is stricter than the write path's
//! (in time order). A delta that revives a node, or adds or revives an edge ordered before an
//! ineffective one, is therefore re-run through that ladder (`Graph::check_loadable`) and refused
//! if the loader would refuse. Any other delta cannot make the loader refuse, and is not.
//!
//! **All or nothing.** Every mutation leaves an undo entry; a refusal runs them back, so a
//! failed delta leaves the store as it was, including its log and its adjacency maps.

use std::collections::{BTreeMap, BTreeSet};

use fathom_canon::Json;
use fathom_ir::bag::FieldKey;
use fathom_ir::canon::CanonError;
use fathom_ir::generated::accessors::{slot_from_canon, slot_to_canon, slot_type};
use fathom_ir::generated::ir_types::{EdgeClass, EdgeKind};

use crate::field::{FieldHistory, HistoryEntry, StoredPresence};
use crate::graph::{declares, Edge, Graph, Node, Slot, WriteError};
use crate::id::{EdgeId, ElementId, NodeId};
use crate::op::{Batch, BatchId, Op};
use crate::prov::{ProvenanceId, ProvenanceRecord, Timestamp};
use crate::snap::{EdgeSnap, FieldSnap, HistorySnap, NodeSnap, Snapshot};

/// Why a delta was refused. The store is unchanged whenever one of these is returned.
#[derive(Debug)]
pub enum SyncError {
    /// A batch is open: the store is mid-intention.
    OpenBatch,
    /// The store's own refusal of one op, as the write path words it.
    Refused { batch: BatchId, error: WriteError },
    /// An op names an element the fragment holds no state for.
    Missing { element: ElementId },
    /// The fragment's state disagrees with what the ops produce.
    Mismatch {
        element: ElementId,
        key: Option<FieldKey>,
    },
    /// A provenance id no record in the fragment (or store) answers.
    DanglingProvenance { id: ProvenanceId },
    /// A record's `supersedes` is not the slot it replaced.
    SupersedesMismatch { id: ProvenanceId },
    /// The same record, element or history key listed twice in the fragment.
    Duplicate,
    /// The fragment holds an element, history or provenance record that no op names.
    Unexplained,
    /// The result is a design `Graph::from_snapshot` would refuse.
    NotLoadable(WriteError),
    /// A value that does not read back into its declared type.
    Canon(CanonError),
}

impl From<CanonError> for SyncError {
    fn from(e: CanonError) -> Self {
        SyncError::Canon(e)
    }
}

enum Undo {
    Prov(ProvenanceId),
    Node(NodeId),
    Edge(EdgeId),
    Absent {
        element: ElementId,
        was: Option<Timestamp>,
    },
    Slot {
        element: ElementId,
        key: FieldKey,
        was: Option<Slot>,
    },
    History {
        key: (ElementId, FieldKey),
        was: Option<FieldHistory>,
    },
}

struct Index<'a> {
    prov: BTreeMap<ProvenanceId, &'a ProvenanceRecord>,
    nodes: BTreeMap<NodeId, &'a NodeSnap>,
    edges: BTreeMap<EdgeId, &'a EdgeSnap>,
    history: BTreeMap<(ElementId, FieldKey), &'a HistorySnap>,
}

fn once<K: Ord, V>(m: &mut BTreeMap<K, V>, k: K, v: V) -> Result<(), SyncError> {
    match m.insert(k, v) {
        None => Ok(()),
        Some(_) => Err(SyncError::Duplicate),
    }
}

impl<'a> Index<'a> {
    fn new(d: &'a Snapshot) -> Result<Index<'a>, SyncError> {
        let mut ix = Index {
            prov: BTreeMap::new(),
            nodes: BTreeMap::new(),
            edges: BTreeMap::new(),
            history: BTreeMap::new(),
        };
        for r in &d.provenance {
            once(&mut ix.prov, r.id, r)?;
        }
        for n in &d.nodes {
            once(&mut ix.nodes, n.id, n)?;
        }
        for e in &d.edges {
            once(&mut ix.edges, e.id, e)?;
        }
        for h in &d.history {
            once(&mut ix.history, (h.element, h.key), h)?;
        }
        Ok(ix)
    }

    fn state(&self, el: ElementId) -> Result<(Option<Timestamp>, &'a [FieldSnap]), SyncError> {
        match el {
            ElementId::Node(n) => self.nodes.get(&n).map(|s| (s.absent_since, &s.fields[..])),
            ElementId::Edge(e) => self.edges.get(&e).map(|s| (s.absent_since, &s.fields[..])),
        }
        .ok_or(SyncError::Missing { element: el })
    }
}

#[derive(Default)]
struct Run {
    undo: Vec<Undo>,
    touched: BTreeSet<ElementId>,
    added: BTreeSet<ElementId>,
    /// Every op per field, in order: its presence and provenance. Values come from the fragment.
    ops: BTreeMap<(ElementId, FieldKey), Vec<(StoredPresence, ProvenanceId)>>,
    /// Provenance ids the ops cite; the fragment may carry no other record.
    cited: BTreeSet<ProvenanceId>,
    /// Edges the delta added or revived, and whether it revived a node: what the loader's
    /// ladder may need re-running for (module docs).
    newly: Vec<EdgeId>,
    node_revived: bool,
}

impl Graph {
    /// Append `d`'s batches to this store, or change nothing. `d` is a fragment as
    /// [`Snapshot::since`] cuts it; batches are applied in order, after the ones already held.
    pub fn apply_batches(&mut self, d: &Snapshot) -> Result<(), SyncError> {
        if self.open.is_some() {
            return Err(SyncError::OpenBatch);
        }
        let ix = Index::new(d)?;
        let mark = self.log.len();
        let mut run = Run::default();
        let r = self
            .replay(d, &ix, &mut run)
            .and_then(|()| self.settle(&ix, &mut run))
            .and_then(|()| match self.loader_may_differ(&run) {
                true => self.check_loadable().map_err(SyncError::NotLoadable),
                false => Ok(()),
            });
        if r.is_err() {
            self.rollback(run.undo, mark);
        }
        r
    }

    fn replay(&mut self, d: &Snapshot, ix: &Index<'_>, run: &mut Run) -> Result<(), SyncError> {
        // One pass over the log for the whole delta, not one per batch.
        let mut incoming: BTreeSet<BatchId> = BTreeSet::new();
        for b in &d.batches {
            if !incoming.insert(b.id) {
                let error = WriteError::BatchIdReused { id: b.id };
                return Err(SyncError::Refused { batch: b.id, error });
            }
        }
        if let Some(x) = self.log.iter().find(|x| incoming.contains(&x.id)) {
            let error = WriteError::BatchIdReused { id: x.id };
            return Err(SyncError::Refused { batch: x.id, error });
        }
        for b in &d.batches {
            let refuse = |error| SyncError::Refused { batch: b.id, error };
            for op in &b.ops {
                self.replay_op(op, ix, run).map_err(|e| match e {
                    SyncError::Refused { error, .. } => refuse(error),
                    other => other,
                })?;
            }
            self.log.push(Batch {
                id: b.id,
                label: b.label.clone(),
                ops: b.ops.clone(),
                comment: b.comment.clone(),
                reverses: b.reverses,
            });
        }
        Ok(())
    }

    fn replay_op(&mut self, op: &Op, ix: &Index<'_>, run: &mut Run) -> Result<(), SyncError> {
        let refused = |error| SyncError::Refused {
            batch: BatchId(fathom_id::Ulid(0)),
            error,
        };
        match op {
            Op::AddNode { node, prov } => {
                if self.by_ulid.contains_key(&node.ulid) {
                    return Err(refused(WriteError::UlidReused { ulid: node.ulid }));
                }
                let el = ElementId::Node(*node);
                match ix.nodes.get(node) {
                    None => return Err(SyncError::Missing { element: el }),
                    Some(s) if s.existence != *prov => {
                        return Err(SyncError::Mismatch {
                            element: el,
                            key: None,
                        })
                    }
                    Some(_) => {}
                }
                self.sync_prov(*prov, None, ix, run)?;
                self.nodes.insert(
                    *node,
                    Node {
                        id: *node,
                        existence: *prov,
                        absent_since: None,
                        fields: BTreeMap::new(),
                    },
                );
                self.by_ulid.insert(node.ulid, el);
                run.undo.push(Undo::Node(*node));
                run.added.insert(el);
                run.touched.insert(el);
            }
            Op::AddEdge {
                edge,
                from,
                to,
                prov,
                ..
            } => {
                if self.by_ulid.contains_key(&edge.ulid) {
                    return Err(refused(WriteError::UlidReused { ulid: edge.ulid }));
                }
                let el = ElementId::Edge(*edge);
                let Some(s) = ix.edges.get(edge) else {
                    return Err(SyncError::Missing { element: el });
                };
                let (f, t) = self.check_edge_l0(edge.kind, *from, *to).map_err(refused)?;
                if (f, t, s.prov) != (s.from, s.to, *prov) {
                    return Err(SyncError::Mismatch {
                        element: el,
                        key: None,
                    });
                }
                self.sync_prov(*prov, None, ix, run)?;
                self.place_edge(Edge {
                    id: *edge,
                    from: f,
                    to: t,
                    prov: *prov,
                    absent_since: None,
                    fields: BTreeMap::new(),
                });
                run.undo.push(Undo::Edge(*edge));
                run.newly.push(*edge);
                run.added.insert(el);
                run.touched.insert(el);
            }
            Op::SetField {
                element,
                key,
                presence,
                prov,
            } => {
                if !self.exists(*element) {
                    return Err(refused(WriteError::UnknownElement { element: *element }));
                }
                if !declares(*element, *key) || slot_type(*key).is_none() {
                    return Err(refused(WriteError::UndeclaredField {
                        element: *element,
                        key: *key,
                    }));
                }
                let current = match run.ops.get(&(*element, *key)).and_then(|v| v.last()) {
                    Some((StoredPresence::Unknown, _)) => None,
                    Some((_, p)) => Some(*p),
                    None => self.slot_prov(*element, *key),
                };
                self.sync_prov(*prov, current, ix, run)?;
                let chain = run.ops.entry((*element, *key)).or_default();
                chain.push((*presence, *prov));
                run.touched.insert(*element);
            }
            Op::Tombstone { element, at, .. } => {
                let was = self
                    .absent_since(*element)
                    .ok_or_else(|| refused(WriteError::UnknownElement { element: *element }))?;
                if was.is_some() {
                    return Err(refused(WriteError::AlreadyTombstoned { element: *element }));
                }
                self.set_absent(*element, Some(*at));
                run.undo.push(Undo::Absent {
                    element: *element,
                    was,
                });
                run.touched.insert(*element);
            }
            Op::Revive { element, .. } => {
                let was = self
                    .absent_since(*element)
                    .ok_or_else(|| refused(WriteError::UnknownElement { element: *element }))?;
                if was.is_none() {
                    return Err(refused(WriteError::NotTombstoned { element: *element }));
                }
                if let ElementId::Edge(id) = element {
                    let e = &self.edges[id];
                    self.check_edge_l0(id.kind, e.from, e.to).map_err(refused)?;
                }
                self.set_absent(*element, None);
                match element {
                    ElementId::Edge(id) => run.newly.push(*id),
                    ElementId::Node(_) => run.node_revived = true,
                }
                run.undo.push(Undo::Absent {
                    element: *element,
                    was,
                });
                run.touched.insert(*element);
            }
        }
        Ok(())
    }

    /// `check_prov` and `intern`, for a record the fragment carries whole.
    fn sync_prov(
        &mut self,
        id: ProvenanceId,
        current: Option<ProvenanceId>,
        ix: &Index<'_>,
        run: &mut Run,
    ) -> Result<(), SyncError> {
        let rec = ix
            .prov
            .get(&id)
            .ok_or(SyncError::DanglingProvenance { id })?;
        if rec.supersedes != current {
            return Err(SyncError::SupersedesMismatch { id });
        }
        run.cited.insert(id);
        match self.prov.get(&id) {
            Some(held) if held == *rec => Ok(()),
            Some(_) => Err(SyncError::Refused {
                batch: BatchId(fathom_id::Ulid(0)),
                error: WriteError::ProvenanceIdReused { id },
            }),
            None => {
                self.prov.insert(id, (*rec).clone());
                run.undo.push(Undo::Prov(id));
                Ok(())
            }
        }
    }

    /// Can the loader refuse what this delta left? Not when it only added or revived edges
    /// through the write ladder, which counted every effective edge, and no edge the loader
    /// places after one of them is ineffective in the end (an ineffective edge is checked as if
    /// fresh, against the effective ones before it). A revived node needs no such argument:
    /// it makes edges effective unchecked.
    fn loader_may_differ(&self, run: &Run) -> bool {
        if run.node_revived {
            return true;
        }
        let mut newest: BTreeMap<EdgeKind, Option<EdgeId>> = BTreeMap::new();
        for x in &run.newly {
            // Containment edges of every kind share the owner slot and the ancestor walk.
            let kinds: Vec<EdgeKind> = match x.kind.class() {
                EdgeClass::Containment => EdgeKind::ALL
                    .into_iter()
                    .filter(|k| k.class() == EdgeClass::Containment)
                    .collect(),
                _ => vec![x.kind],
            };
            for k in kinds {
                let m = *newest
                    .entry(k)
                    .or_insert_with(|| self.newest_ineffective_edge(k));
                if m.is_some_and(|m| m > *x) {
                    return true;
                }
            }
        }
        false
    }

    fn absent_since(&self, el: ElementId) -> Option<Option<Timestamp>> {
        match el {
            ElementId::Node(n) => self.nodes.get(&n).map(|n| n.absent_since),
            ElementId::Edge(e) => self.edges.get(&e).map(|e| e.absent_since),
        }
    }

    fn set_absent(&mut self, el: ElementId, to: Option<Timestamp>) {
        match el {
            ElementId::Node(n) => self.nodes.get_mut(&n).expect("checked").absent_since = to,
            ElementId::Edge(e) => self.edges.get_mut(&e).expect("checked").absent_since = to,
        }
    }

    /// After the ops: install values and history from the fragment, and check that the
    /// fragment holds nothing the ops do not name and that every touched element reads, in
    /// every field and in its tombstone, exactly as the fragment says.
    fn settle(&mut self, ix: &Index<'_>, run: &mut Run) -> Result<(), SyncError> {
        let named = |el| run.touched.contains(&el);
        let stray = ix.nodes.keys().any(|n| !named(ElementId::Node(*n)))
            || ix.edges.keys().any(|e| !named(ElementId::Edge(*e)))
            || ix.history.keys().any(|k| !run.ops.contains_key(k))
            || ix.prov.keys().any(|p| !run.cited.contains(p));
        if stray {
            return Err(SyncError::Unexplained);
        }
        for el in run.touched.clone() {
            let (absent, fields) = ix.state(el)?;
            let bad = || SyncError::Mismatch {
                element: el,
                key: None,
            };
            if self.absent_since(el) != Some(absent) {
                return Err(bad());
            }
            // What an op cannot change must be what the store holds.
            let same_identity = match el {
                ElementId::Node(n) => self.nodes[&n].existence == ix.nodes[&n].existence,
                ElementId::Edge(e) => {
                    let (held, s) = (&self.edges[&e], ix.edges[&e]);
                    (held.from, held.to, held.prov) == (s.from, s.to, s.prov)
                }
            };
            if !same_identity {
                return Err(bad());
            }
            // A new element holds no field its ops did not set.
            if run.added.contains(&el) {
                if let Some(f) = fields.iter().find(|f| !run.ops.contains_key(&(el, f.key))) {
                    return Err(SyncError::Mismatch {
                        element: el,
                        key: Some(f.key),
                    });
                }
            }
        }
        for ((el, key), chain) in std::mem::take(&mut run.ops) {
            let (presence, prov) = *chain.last().expect("an op made the entry");
            let (_, fields) = ix.state(el)?;
            let snap = fields.iter().find(|f| f.key == key);
            let bad = SyncError::Mismatch {
                element: el,
                key: Some(key),
            };
            let slot = match (presence, snap) {
                (StoredPresence::Set, Some(f))
                    if f.presence == StoredPresence::Set && f.prov == prov =>
                {
                    let Some(j) = &f.value else { return Err(bad) };
                    Some(Slot {
                        presence,
                        value: Some(slot_from_canon(key, j)?),
                        prov,
                    })
                }
                (StoredPresence::Absent, Some(f))
                    if f.presence == StoredPresence::Absent
                        && f.value.is_none()
                        && f.prov == prov =>
                {
                    Some(Slot {
                        presence,
                        value: None,
                        prov,
                    })
                }
                (StoredPresence::Unknown, None) => None,
                _ => return Err(bad),
            };
            let was = self.slot_map_mut(el).remove(&key);
            let before = was.as_ref().map(|s| (s.presence, s.prov));
            let before_value = match was.as_ref().map(|s| (s.presence, s.value.as_deref())) {
                Some((StoredPresence::Set, Some(v))) => Some(slot_to_canon(key, v)?),
                _ => None,
            };
            run.undo.push(Undo::Slot {
                element: el,
                key,
                was,
            });
            if let Some(s) = slot {
                self.slot_map_mut(el).insert(key, s);
            }
            let frag = ix.history.get(&(el, key)).copied();
            self.check_history(el, key, (before, before_value), &chain, frag)?;
            if let Some(h) = frag {
                let installed = self.history_from(h)?;
                let was = self.history.insert((el, key), installed);
                run.undo.push(Undo::History {
                    key: (el, key),
                    was,
                });
            }
        }
        for el in &run.touched {
            self.fields_match(*el, ix.state(*el)?.1)?;
        }
        Ok(())
    }

    /// The history the fragment gives for a field its ops wrote must be the held history with
    /// what those ops replaced or cleared appended, pruned as the write path prunes: presence,
    /// provenance and truncation count all derived here, and the held entries' values kept.
    fn check_history(
        &self,
        el: ElementId,
        key: FieldKey,
        (mut current, current_value): (Option<(StoredPresence, ProvenanceId)>, Option<Json>),
        chain: &[(StoredPresence, ProvenanceId)],
        frag: Option<&HistorySnap>,
    ) -> Result<(), SyncError> {
        let bad = || SyncError::Mismatch {
            element: el,
            key: Some(key),
        };
        // Where each wanted entry's value can be witnessed, tracked by position through the pruning.
        #[derive(Clone, Copy)]
        enum Src {
            Held(usize),
            Slot,
            Derived,
        }
        let held = self.history.get(&(el, key));
        let mut want = match held {
            Some(h) => h.meta_copy(),
            None => FieldHistory::new(),
        };
        let mut src: Vec<Src> = (0..held.map_or(0, |h| h.entries().len()))
            .map(Src::Held)
            .collect();
        let origin = |p: ProvenanceId| self.prov.get(&p).map(|r| r.origin.discriminant());
        let entry = |(presence, prov)| HistoryEntry {
            presence,
            value: None,
            prov,
        };
        let mut push = |want: &mut FieldHistory, e, disc, s| {
            src.push(s);
            if let Some(keep) = want.push_discriminant(e, disc) {
                let mut it = keep.iter();
                src.retain(|_| *it.next().expect("index-aligned"));
            }
        };
        let mut current_src = Src::Slot;
        for &(presence, prov) in chain {
            if let Some(old) = current {
                push(
                    &mut want,
                    entry(old),
                    origin(old.1).ok_or_else(bad)?,
                    current_src,
                );
            }
            current = match presence {
                StoredPresence::Unknown => {
                    push(
                        &mut want,
                        entry((presence, prov)),
                        origin(prov).ok_or_else(bad)?,
                        Src::Derived,
                    );
                    None
                }
                _ => Some((presence, prov)),
            };
            current_src = Src::Derived;
        }
        let (got, truncated) = frag.map_or((&[][..], 0), |h| (&h.entries[..], h.truncated));
        if want.entries().len() != got.len()
            || want.truncated() != truncated
            || want
                .entries()
                .iter()
                .zip(got)
                .any(|(w, g)| (w.presence, w.prov) != (g.presence, g.prov))
        {
            return Err(bad());
        }
        // The values of entries the store already held (in its history, or as the slot just
        // replaced) are kept, matched by position. Entries made inside the delta have no witness.
        for (g, s) in got.iter().zip(&src) {
            let value = match *s {
                Src::Held(k) => match held.map(|h| &h.entries()[k]) {
                    Some(e) => match (e.presence, e.value.as_deref()) {
                        (StoredPresence::Set, Some(v)) => Some(slot_to_canon(key, v)?),
                        _ => None,
                    },
                    None => None,
                },
                Src::Slot => current_value.clone(),
                Src::Derived => continue,
            };
            if value != g.value {
                return Err(bad());
            }
        }
        Ok(())
    }

    /// The element's slots are the fragment's fields, key for key, in the same order.
    fn fields_match(&self, el: ElementId, fields: &[FieldSnap]) -> Result<(), SyncError> {
        let held = match el {
            ElementId::Node(n) => &self.nodes[&n].fields,
            ElementId::Edge(e) => &self.edges[&e].fields,
        };
        let mismatch = |key| SyncError::Mismatch {
            element: el,
            key: Some(key),
        };
        let mut have = held.iter();
        for f in fields {
            let Some((key, slot)) = have.next().filter(|(k, _)| **k == f.key) else {
                return Err(mismatch(f.key));
            };
            let value = match (slot.presence, slot.value.as_deref()) {
                (StoredPresence::Set, Some(v)) => Some(slot_to_canon(*key, v)?),
                _ => None,
            };
            if (slot.presence, &value, slot.prov) != (f.presence, &f.value, f.prov) {
                return Err(mismatch(f.key));
            }
        }
        match have.next() {
            Some((key, _)) => Err(mismatch(*key)),
            None => Ok(()),
        }
    }

    fn history_from(&self, h: &HistorySnap) -> Result<FieldHistory, SyncError> {
        let mut entries = Vec::with_capacity(h.entries.len());
        let mut origins = Vec::with_capacity(h.entries.len());
        for e in &h.entries {
            let rec = self
                .prov
                .get(&e.prov)
                .ok_or(SyncError::DanglingProvenance { id: e.prov })?;
            let value = match (e.presence, &e.value) {
                (StoredPresence::Set, Some(j)) => Some(slot_from_canon(h.key, j)?),
                (StoredPresence::Set, None) | (_, Some(_)) => {
                    return Err(SyncError::Mismatch {
                        element: h.element,
                        key: Some(h.key),
                    })
                }
                (_, None) => None,
            };
            origins.push(rec.origin.discriminant());
            entries.push(HistoryEntry {
                presence: e.presence,
                value,
                prov: e.prov,
            });
        }
        Ok(FieldHistory::install(entries, origins, h.truncated))
    }

    fn rollback(&mut self, undo: Vec<Undo>, mark: usize) {
        for u in undo.into_iter().rev() {
            match u {
                Undo::Prov(id) => {
                    self.prov.remove(&id);
                }
                Undo::Node(id) => {
                    self.nodes.remove(&id);
                    self.by_ulid.remove(&id.ulid);
                }
                Undo::Edge(id) => self.unplace_edge(id),
                Undo::Absent { element, was } => self.set_absent(element, was),
                Undo::Slot { element, key, was } => {
                    let m = self.slot_map_mut(element);
                    m.remove(&key);
                    if let Some(s) = was {
                        m.insert(key, s);
                    }
                }
                Undo::History { key, was } => match was {
                    Some(h) => {
                        self.history.insert(key, h);
                    }
                    None => {
                        self.history.remove(&key);
                    }
                },
            }
        }
        self.log.truncate(mark);
    }
}

impl Snapshot {
    /// The fragment [`Graph::apply_batches`] takes for `batches[from..]`: those batches, the
    /// provenance their ops cite, the full state of every element they name and the history of
    /// every field they set. A pure function of `self`; the reference cut the browser repeats.
    pub fn since(&self, from: usize) -> Snapshot {
        let batches: Vec<Batch> = self.batches.iter().skip(from).cloned().collect();
        let mut touched: BTreeSet<ElementId> = BTreeSet::new();
        let mut provs: BTreeSet<ProvenanceId> = BTreeSet::new();
        let mut sets: BTreeSet<(ElementId, FieldKey)> = BTreeSet::new();
        for op in batches.iter().flat_map(|b| &b.ops) {
            match op {
                Op::AddNode { node, prov } => {
                    touched.insert(ElementId::Node(*node));
                    provs.insert(*prov);
                }
                Op::AddEdge { edge, prov, .. } => {
                    touched.insert(ElementId::Edge(*edge));
                    provs.insert(*prov);
                }
                Op::SetField {
                    element, key, prov, ..
                } => {
                    touched.insert(*element);
                    provs.insert(*prov);
                    sets.insert((*element, *key));
                }
                Op::Tombstone { element, .. } | Op::Revive { element, .. } => {
                    touched.insert(*element);
                }
            }
        }
        Snapshot {
            nodes: self
                .nodes
                .iter()
                .filter(|n| touched.contains(&ElementId::Node(n.id)))
                .cloned()
                .collect(),
            edges: self
                .edges
                .iter()
                .filter(|e| touched.contains(&ElementId::Edge(e.id)))
                .cloned()
                .collect(),
            provenance: self
                .provenance
                .iter()
                .filter(|p| provs.contains(&p.id))
                .cloned()
                .collect(),
            history: self
                .history
                .iter()
                .filter(|h| sets.contains(&(h.element, h.key)))
                .cloned()
                .collect(),
            batches,
        }
    }
}
