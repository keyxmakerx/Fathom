//! `Graph::apply_batches`: a held store grows by the batches it has not seen, through the
//! write path's own checks, or does not change at all.

use fathom_graph::{
    Actor, Batch, BatchId, Confidence, EdgeId, ElementId, Graph, NodeId, Op, Origin, ProvenanceId,
    ProvenanceRecord, Snapshot, StoredPresence, SyncError, Timestamp, UserId, WriteError,
};
use fathom_graph::{FieldSnap, HistorySnap, SnapshotError};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{DeviceField, EdgeKind, NodeKind, SiteField};
use fathom_ir::scalar::{Identifier, Text};

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

fn prov(n: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(1_000_000 + n)),
        origin: Origin::Hand,
        asserted_at: Timestamp(AT + n as u64),
        asserted_by: Actor::User(UserId(ulid(u128::MAX))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

fn by() -> Actor {
    Actor::User(UserId::LOCAL)
}

fn hostname(g: &mut Graph, d: NodeId, name: &str, n: u128) {
    g.set_field(
        ElementId::Node(d),
        DeviceField::Hostname.key(),
        Identifier(name.to_owned()),
        prov(n),
    )
    .expect("hostname");
}

/// The held side and the document side of one estate: `doc` is written to, `held` is the
/// module's copy at `seen` batches.
struct Pair {
    doc: Graph,
    held: Graph,
    seen: usize,
}

fn base() -> (Pair, NodeId, NodeId) {
    let mut doc = Graph::new();
    doc.begin_batch(BatchId(ulid(0)), "start").unwrap();
    let site = doc.insert_node(NodeKind::Site, ulid(1), prov(1)).unwrap();
    let dev = doc.insert_node(NodeKind::Device, ulid(2), prov(2)).unwrap();
    doc.insert_edge(EdgeKind::HasDevice, ulid(3), site, dev, prov(3))
        .unwrap();
    hostname(&mut doc, dev, "a", 4);
    doc.end_batch().unwrap();
    let held = Graph::from_snapshot(&doc.to_snapshot().unwrap()).unwrap();
    let seen = doc.log().len();
    (Pair { doc, held, seen }, site, dev)
}

impl Pair {
    fn fragment(&self) -> Snapshot {
        self.doc.to_snapshot().unwrap().since(self.seen)
    }

    fn sync(&mut self) -> Result<(), SyncError> {
        let f = self.fragment();
        self.held.apply_batches(&f)?;
        self.seen = self.doc.log().len();
        Ok(())
    }

    fn same(&self) {
        assert_eq!(
            self.held.to_snapshot().unwrap(),
            self.doc.to_snapshot().unwrap(),
            "the held store reads as the document"
        );
    }
}

#[test]
fn a_pure_append_reads_as_the_full_load() {
    let (mut p, site, dev) = base();
    let instance = p.held.instance();

    p.doc
        .begin_batch(BatchId(ulid(10)), "add a device")
        .unwrap();
    let dev2 = p
        .doc
        .insert_node(NodeKind::Device, ulid(11), prov(11))
        .unwrap();
    let has = p
        .doc
        .insert_edge(EdgeKind::HasDevice, ulid(12), site, dev2, prov(12))
        .unwrap();
    hostname(&mut p.doc, dev2, "b", 13);
    p.doc.end_batch().unwrap();
    p.sync().unwrap();
    p.same();

    // A correction (history), an absence, a clear, and a reversal batch.
    p.doc.begin_batch(BatchId(ulid(20)), "edit").unwrap();
    hostname(&mut p.doc, dev, "a2", 21);
    hostname(&mut p.doc, dev, "a3", 22);
    p.doc
        .assert_absent(ElementId::Node(site), SiteField::Name.key(), prov(23))
        .unwrap();
    p.doc
        .set_field(
            ElementId::Node(site),
            SiteField::Name.key(),
            Text("hq".to_owned()),
            prov(24),
        )
        .unwrap();
    p.doc
        .clear_field(ElementId::Node(site), SiteField::Name.key(), prov(25))
        .unwrap();
    p.doc.end_batch().unwrap();
    p.sync().unwrap();
    p.same();

    p.doc.begin_batch(BatchId(ulid(30)), "remove").unwrap();
    p.doc
        .tombstone(ElementId::Node(dev2), Timestamp(AT + 30), by())
        .unwrap();
    p.doc
        .tombstone(ElementId::Edge(has), Timestamp(AT + 30), by())
        .unwrap();
    p.doc.end_batch().unwrap();
    p.sync().unwrap();
    p.same();

    p.doc.begin_batch(BatchId(ulid(40)), "undo remove").unwrap();
    p.doc.set_batch_reverses(BatchId(ulid(30))).unwrap();
    p.doc.set_batch_comment(Text("c".to_owned())).unwrap();
    p.doc
        .revive(ElementId::Node(dev2), Timestamp(AT + 40), by())
        .unwrap();
    p.doc
        .revive(ElementId::Edge(has), Timestamp(AT + 40), by())
        .unwrap();
    p.doc.end_batch().unwrap();
    p.sync().unwrap();
    p.same();

    assert_eq!(p.held.instance(), instance, "the store grew in place");
    assert_eq!(p.held.log().len(), p.doc.log().len());
}

#[test]
fn several_batches_in_one_delta_apply_in_order() {
    let (mut p, site, _) = base();
    for i in 0..3u128 {
        p.doc.begin_batch(BatchId(ulid(50 + i)), "d").unwrap();
        let d = p
            .doc
            .insert_node(NodeKind::Device, ulid(60 + i), prov(60 + i))
            .unwrap();
        p.doc
            .insert_edge(EdgeKind::HasDevice, ulid(70 + i), site, d, prov(70 + i))
            .unwrap();
        hostname(&mut p.doc, d, "x", 80 + i);
        hostname(&mut p.doc, d, "y", 90 + i);
        p.doc.end_batch().unwrap();
    }
    p.sync().unwrap();
    p.same();
}

/// Applying must change nothing when it refuses: the store, its log and its history.
fn refuses(p: &mut Pair, frag: &Snapshot) -> SyncError {
    let before = p.held.to_snapshot().unwrap();
    let instance = p.held.instance();
    let err = p.held.apply_batches(frag).expect_err("must refuse");
    assert_eq!(
        p.held.to_snapshot().unwrap(),
        before,
        "refused, so unchanged"
    );
    assert_eq!(p.held.instance(), instance);
    err
}

#[test]
fn a_batch_already_held_is_refused_not_merged() {
    let (mut p, site, _) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "add").unwrap();
    let d = p
        .doc
        .insert_node(NodeKind::Device, ulid(11), prov(11))
        .unwrap();
    p.doc
        .insert_edge(EdgeKind::HasDevice, ulid(12), site, d, prov(12))
        .unwrap();
    p.doc.end_batch().unwrap();
    let frag = p.fragment();
    p.held.apply_batches(&frag).unwrap();
    // The very same delta again.
    match refuses(&mut p, &frag) {
        SyncError::Refused {
            error: WriteError::BatchIdReused { .. },
            ..
        } => {}
        other => panic!("{other:?}"),
    }
    // Twice inside one delta.
    let mut twice = p.doc.to_snapshot().unwrap().since(p.doc.log().len());
    let b = Batch {
        id: BatchId(ulid(30)),
        label: "empty".into(),
        ops: vec![],
        comment: None,
        reverses: None,
    };
    twice.batches = vec![b.clone(), b];
    assert!(matches!(
        refuses(&mut p, &twice),
        SyncError::Refused {
            error: WriteError::BatchIdReused { .. },
            ..
        }
    ));
}

#[test]
fn the_same_op_under_a_new_batch_id_is_refused() {
    let (mut p, site, _) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "add").unwrap();
    let d = p
        .doc
        .insert_node(NodeKind::Device, ulid(11), prov(11))
        .unwrap();
    p.doc
        .insert_edge(EdgeKind::HasDevice, ulid(12), site, d, prov(12))
        .unwrap();
    p.doc.end_batch().unwrap();
    let mut frag = p.fragment();
    p.held.apply_batches(&frag).unwrap();
    frag.batches[0].id = BatchId(ulid(99));
    match refuses(&mut p, &frag) {
        SyncError::Refused {
            error: WriteError::UlidReused { .. },
            ..
        } => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_failure_in_a_later_batch_undoes_the_earlier_ones() {
    let (mut p, site, dev) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "good").unwrap();
    let d = p
        .doc
        .insert_node(NodeKind::Device, ulid(11), prov(11))
        .unwrap();
    let e = p
        .doc
        .insert_edge(EdgeKind::HasDevice, ulid(12), site, d, prov(12))
        .unwrap();
    hostname(&mut p.doc, d, "n", 13);
    hostname(&mut p.doc, dev, "changed", 14);
    p.doc
        .tombstone(ElementId::Edge(e), Timestamp(AT + 15), by())
        .unwrap();
    p.doc.end_batch().unwrap();
    p.doc.begin_batch(BatchId(ulid(20)), "bad").unwrap();
    p.doc
        .revive(ElementId::Edge(e), Timestamp(AT + 21), by())
        .unwrap();
    p.doc.end_batch().unwrap();
    let mut frag = p.fragment();
    // Make the second batch impossible: revive something that is not tombstoned.
    frag.batches[1].ops = vec![Op::Revive {
        element: ElementId::Node(dev),
        at: Timestamp(AT + 21),
        by: by(),
    }];
    match refuses(&mut p, &frag) {
        SyncError::Refused {
            error: WriteError::NotTombstoned { .. },
            ..
        } => {}
        other => panic!("{other:?}"),
    }
    // And the honest delta still lands afterwards.
    p.sync().unwrap();
    p.same();
}

#[test]
fn a_tombstone_twice_is_refused() {
    let (mut p, _, dev) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "rm").unwrap();
    p.doc
        .tombstone(ElementId::Node(dev), Timestamp(AT + 10), by())
        .unwrap();
    p.doc.end_batch().unwrap();
    p.sync().unwrap();
    let mut frag = p.doc.to_snapshot().unwrap().since(p.doc.log().len());
    frag.batches = vec![Batch {
        id: BatchId(ulid(11)),
        label: "rm again".into(),
        ops: vec![Op::Tombstone {
            element: ElementId::Node(dev),
            at: Timestamp(AT + 10),
            by: by(),
        }],
        comment: None,
        reverses: None,
    }];
    frag.nodes = p.doc.to_snapshot().unwrap().nodes;
    match refuses(&mut p, &frag) {
        SyncError::Refused {
            error: WriteError::AlreadyTombstoned { .. },
            ..
        } => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_revive_into_a_taken_slot_is_refused_by_the_ladder() {
    // A device has one owner. Cut the edge, give it another owner, then try to revive the first.
    let (mut p, site, dev) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "cut + move").unwrap();
    let first = EdgeId {
        kind: EdgeKind::HasDevice,
        ulid: ulid(3),
    };
    p.doc
        .tombstone(ElementId::Edge(first), Timestamp(AT + 10), by())
        .unwrap();
    let site2 = p
        .doc
        .insert_node(NodeKind::Site, ulid(14), prov(14))
        .unwrap();
    p.doc
        .insert_edge(EdgeKind::HasDevice, ulid(15), site2, dev, prov(15))
        .unwrap();
    p.doc.end_batch().unwrap();
    p.sync().unwrap();
    p.same();
    let mut frag = p.fragment();
    frag.batches = vec![Batch {
        id: BatchId(ulid(20)),
        label: "revive".into(),
        ops: vec![Op::Revive {
            element: ElementId::Edge(first),
            at: Timestamp(AT + 20),
            by: by(),
        }],
        comment: None,
        reverses: None,
    }];
    frag.edges = p.doc.to_snapshot().unwrap().edges;
    let _ = site;
    match refuses(&mut p, &frag) {
        SyncError::Refused {
            error: WriteError::SecondContainment { .. },
            ..
        } => {}
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_fragment_that_disagrees_with_its_ops_is_refused() {
    // The value for a set field is the fragment's; the prov, presence and absence are the ops'.
    let (mut p, _, dev) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "edit").unwrap();
    hostname(&mut p.doc, dev, "b", 11);
    p.doc
        .tombstone(ElementId::Node(dev), Timestamp(AT + 12), by())
        .unwrap();
    p.doc.end_batch().unwrap();
    let good = p.fragment();

    // The node's state says it is still live.
    let mut f = good.clone();
    f.nodes[0].absent_since = None;
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));

    // The field's state names another provenance.
    let mut f = good.clone();
    f.nodes[0].fields[0].prov = ProvenanceId(ulid(5));
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));

    // Set in the ops, absent in the state.
    let mut f = good.clone();
    f.nodes[0].fields[0].presence = StoredPresence::Absent;
    f.nodes[0].fields[0].value = None;
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));

    // No state for a named element, or no record for a cited provenance.
    let mut f = good.clone();
    f.nodes.clear();
    assert!(matches!(refuses(&mut p, &f), SyncError::Missing { .. }));
    let mut f = good.clone();
    f.provenance.clear();
    assert!(matches!(
        refuses(&mut p, &f),
        SyncError::DanglingProvenance { .. }
    ));

    // A record that does not supersede the slot it replaced.
    let mut f = good.clone();
    f.provenance[0].supersedes = None;
    assert!(matches!(
        refuses(&mut p, &f),
        SyncError::SupersedesMismatch { .. }
    ));

    // A replaced value with no history.
    let mut f = good.clone();
    f.history.clear();
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));

    // A history that is not the replaced value appended to the held one: an extra entry, a
    // changed one, a forged truncation count.
    let h = &good.history[0];
    let mut f = good.clone();
    f.history[0].entries.push(h.entries[0].clone());
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));
    let mut f = good.clone();
    f.history[0].entries[0].value = Some(fathom_canon::Json::Str("forged".into()));
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));
    let mut f = good.clone();
    f.history[0].truncated = 3;
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));

    // Two states for one element.
    let mut f = good.clone();
    f.nodes.push(f.nodes[0].clone());
    assert!(matches!(refuses(&mut p, &f), SyncError::Duplicate));

    // And the untampered one lands.
    p.held.apply_batches(&good).unwrap();
    p.seen = p.doc.log().len();
    p.same();
}

#[test]
fn a_new_element_carrying_a_field_no_op_set_is_refused() {
    let (mut p, site, _) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "add").unwrap();
    let d = p
        .doc
        .insert_node(NodeKind::Device, ulid(11), prov(11))
        .unwrap();
    p.doc
        .insert_edge(EdgeKind::HasDevice, ulid(12), site, d, prov(12))
        .unwrap();
    hostname(&mut p.doc, d, "n", 13);
    p.doc.end_batch().unwrap();
    let mut f = p.fragment();
    for b in &mut f.batches {
        b.ops.retain(|o| !matches!(o, Op::SetField { .. }));
    }
    // Keep the field's record so that only the field itself is unexplained.
    f.history.clear();
    assert!(matches!(refuses(&mut p, &f), SyncError::Unexplained));
    f.provenance.retain(|r| r.id != prov(13).id);
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));
}

#[test]
fn an_open_batch_refuses() {
    let (mut p, _, _) = base();
    p.held.begin_batch(BatchId(ulid(500)), "mid").unwrap();
    let f = Snapshot {
        nodes: vec![],
        edges: vec![],
        provenance: vec![],
        history: vec![],
        batches: vec![],
    };
    assert!(matches!(
        p.held.apply_batches(&f),
        Err(SyncError::OpenBatch)
    ));
}

#[test]
fn an_empty_delta_is_a_no_op() {
    let (mut p, _, _) = base();
    p.sync().unwrap();
    p.same();
}

const HAS_DEVICE: EdgeKind = EdgeKind::HasDevice;

fn edge_id(n: u128) -> EdgeId {
    EdgeId {
        kind: HAS_DEVICE,
        ulid: ulid(n),
    }
}

fn tombstone(g: &mut Graph, el: ElementId, n: u128) {
    g.tombstone(el, Timestamp(AT + n as u64), by()).unwrap();
}

fn revive(g: &mut Graph, el: ElementId, n: u128) {
    g.revive(el, Timestamp(AT + n as u64), by()).unwrap();
}

/// The device's owner cut, a new owner given and cut again: nothing yet the loader refuses.
fn cut_twice() -> Pair {
    let (mut p, _, dev) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "move").unwrap();
    tombstone(&mut p.doc, ElementId::Edge(edge_id(3)), 10);
    let site2 = p
        .doc
        .insert_node(NodeKind::Site, ulid(14), prov(14))
        .unwrap();
    p.doc
        .insert_edge(HAS_DEVICE, ulid(15), site2, dev, prov(15))
        .unwrap();
    p.doc.end_batch().unwrap();
    p.doc.begin_batch(BatchId(ulid(11)), "cut").unwrap();
    tombstone(&mut p.doc, ElementId::Edge(edge_id(15)), 11);
    p.doc.end_batch().unwrap();
    p
}

#[test]
fn a_revive_after_a_reparent_is_refused_because_the_loader_refuses_it() {
    // Revive the first owner's edge: the write path takes it, but the loader checks the replaced
    // edge against the revived one and refuses the design. So must a delta.
    let loader_refuses = |p: &Pair| {
        matches!(
            Graph::from_snapshot(&p.doc.to_snapshot().unwrap()),
            Err(SnapshotError::L0(WriteError::SecondContainment { .. }))
        )
    };
    let revive_first = |p: &mut Pair| {
        p.doc.begin_batch(BatchId(ulid(12)), "back").unwrap();
        revive(&mut p.doc, ElementId::Edge(edge_id(3)), 12);
        p.doc.end_batch().unwrap();
    };
    // All three batches in one delta.
    let mut p = cut_twice();
    revive_first(&mut p);
    assert!(loader_refuses(&p));
    let whole = p.fragment();
    assert!(matches!(
        refuses(&mut p, &whole),
        SyncError::NotLoadable(WriteError::SecondContainment { .. })
    ));
    // The first two held, then the revive alone.
    let mut p = cut_twice();
    p.sync().unwrap();
    revive_first(&mut p);
    assert!(loader_refuses(&p));
    let revive_only = p.fragment();
    assert!(matches!(
        refuses(&mut p, &revive_only),
        SyncError::NotLoadable(WriteError::SecondContainment { .. })
    ));
}

#[test]
fn the_owner_is_the_same_whichever_way_the_store_was_built() {
    // The replacement edge is ordered before the original (another client's clock), the new
    // site goes, and the device and the original edge come back: the original owns it again.
    let (mut p, site, dev) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "move").unwrap();
    tombstone(&mut p.doc, ElementId::Edge(edge_id(3)), 10);
    let site2 = p
        .doc
        .insert_node(NodeKind::Site, ulid(14), prov(14))
        .unwrap();
    let early = Ulid::from_parts(AT - 1_000, 1).unwrap();
    p.doc
        .insert_edge(HAS_DEVICE, early, site2, dev, prov(15))
        .unwrap();
    p.doc.end_batch().unwrap();
    p.doc.begin_batch(BatchId(ulid(11)), "remove").unwrap();
    tombstone(&mut p.doc, ElementId::Node(site2), 11);
    p.doc.end_batch().unwrap();
    p.doc.begin_batch(BatchId(ulid(12)), "back").unwrap();
    revive(&mut p.doc, ElementId::Node(dev), 12);
    revive(&mut p.doc, ElementId::Edge(edge_id(3)), 12);
    p.doc.end_batch().unwrap();

    p.sync().unwrap();
    p.same();
    let full = Graph::from_snapshot(&p.doc.to_snapshot().unwrap()).unwrap();
    for g in [&p.held, &p.doc, &full] {
        assert_eq!(g.owner(dev), Some(site));
    }
    p.held.check_loadable().unwrap();
}

#[test]
fn evidence_no_op_explains_is_refused_not_dropped() {
    let (mut p, site, dev) = base();
    p.doc.begin_batch(BatchId(ulid(10)), "rename").unwrap();
    hostname(&mut p.doc, dev, "b", 11);
    p.doc.end_batch().unwrap();
    let good = p.fragment();

    // A tombstone on an element no op names.
    let mut f = good.clone();
    let mut stray = p.doc.to_snapshot().unwrap().nodes;
    stray.retain(|n| n.id == site);
    stray[0].absent_since = Some(Timestamp(AT + 99));
    f.nodes.extend(stray);
    f.nodes.sort_by_key(|n| n.id);
    assert!(matches!(refuses(&mut p, &f), SyncError::Unexplained));

    // A field on a touched, already-held element that no op set.
    let mut f = good.clone();
    f.nodes[0].fields.push(FieldSnap {
        key: DeviceField::Role.key(),
        presence: StoredPresence::Absent,
        value: None,
        prov: prov(11).id,
    });
    f.nodes[0].fields.sort_by_key(|x| x.key);
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));

    // A held element's identity, a record no op cites, a history no op writes.
    let mut f = good.clone();
    f.nodes[0].existence = prov(99).id;
    assert!(matches!(refuses(&mut p, &f), SyncError::Mismatch { .. }));
    let mut f = good.clone();
    f.provenance.push(prov(98));
    f.provenance.sort_by_key(|r| r.id);
    assert!(matches!(refuses(&mut p, &f), SyncError::Unexplained));
    let mut f = good.clone();
    f.history.push(HistorySnap {
        element: ElementId::Node(site),
        key: SiteField::Name.key(),
        entries: vec![],
        truncated: 0,
    });
    assert!(matches!(refuses(&mut p, &f), SyncError::Unexplained));

    p.held.apply_batches(&good).unwrap();
    p.seen = p.doc.log().len();
    p.same();
}
