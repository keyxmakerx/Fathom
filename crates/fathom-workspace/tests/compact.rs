//! Slimmer saves (r53): a save keeps the newest changes and the provenance still named, reads
//! back, composes with later changes, and refuses an undo of a change it no longer holds.

use fathom_graph::{
    Actor, BatchId, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord, Timestamp,
    UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{NodeKind, RackField};
use fathom_ir::scalar::Text;
use fathom_workspace::{
    apply_change, compact, read_plain, write_change, write_plain, Change, ChangeError,
};

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

fn me() -> Actor {
    Actor::User(UserId(ulid(7)))
}

fn prov(n: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(1_000_000 + n)),
        origin: Origin::Hand,
        asserted_at: Timestamp(AT + n as u64),
        asserted_by: me(),
        confidence: fathom_graph::Confidence::Asserted,
        supersedes: None,
    }
}

fn batch_id(n: u128) -> BatchId {
    BatchId(ulid(2_000_000 + n))
}

fn rack() -> ElementId {
    NodeId {
        kind: NodeKind::Rack,
        ulid: ulid(3),
    }
    .into()
}

fn with_rack() -> Graph {
    let mut g = Graph::new();
    g.begin_batch(batch_id(0), "add a rack").unwrap();
    g.insert_node(NodeKind::Rack, ulid(3), prov(0)).unwrap();
    g.end_batch().unwrap();
    g
}

/// Batch `n`: the rack is renamed `R<n>`.
fn rename(g: &mut Graph, n: u128) {
    g.begin_batch(batch_id(n), "rename the rack").unwrap();
    g.set_field(
        rack(),
        RackField::Label.key(),
        Text(format!("R{n}")),
        prov(n),
    )
    .unwrap();
    g.end_batch().unwrap();
}

fn renamed(n: u128) -> Graph {
    let mut g = with_rack();
    for i in 1..=n {
        rename(&mut g, i);
    }
    g
}

fn plain(g: &Graph) -> Vec<u8> {
    write_plain(g).unwrap()
}

#[test]
fn a_save_keeps_the_newest_changes_and_reads_back() {
    let g = renamed(30);
    let slim = compact(&g, 10)
        .unwrap()
        .expect("there is something to drop");
    assert_eq!(slim.log().len(), 10);
    assert_eq!(slim.log()[0].id, batch_id(21));
    assert_eq!(slim.log().last().unwrap().id, batch_id(30));
    // What the design says is untouched: the same rack, named the same.
    let (before, after) = (g.to_snapshot().unwrap(), slim.to_snapshot().unwrap());
    assert_eq!(before.nodes, after.nodes);
    assert_eq!(before.history, after.history);
    // Only records something still names are kept: the rack's existence, its label's slot, the
    // field history's entries, and the kept batches' own.
    assert!(after.provenance.len() < before.provenance.len());
    assert!(after.provenance.iter().any(|r| r.id == prov(0).id));
    assert!(after.provenance.iter().any(|r| r.id == prov(21).id));
    // A field's history keeps its earliest entry by hand, so the first name's record stays; the
    // second name is in neither the history nor a kept batch.
    assert!(after.provenance.iter().any(|r| r.id == prov(1).id));
    assert!(!after.provenance.iter().any(|r| r.id == prov(2).id));
    // And it reads back, byte for byte.
    let bytes = plain(&slim);
    assert_eq!(plain(&read_plain(&bytes).unwrap()), bytes);
    assert!(bytes.len() < plain(&g).len());
}

#[test]
fn a_design_with_nothing_to_drop_is_left_alone() {
    assert!(compact(&renamed(5), 10).unwrap().is_none());
    assert!(compact(&Graph::new(), 10).unwrap().is_none());
}

#[test]
fn compacting_twice_is_compacting_once() {
    let once = compact(&renamed(40), 10).unwrap().unwrap();
    assert!(compact(&once, 10).unwrap().is_none());
}

/// The server compacts at each checkpoint and checks each checkpoint against one compaction of
/// a replay of the whole chain: the two must agree.
#[test]
fn compacting_along_the_way_is_compacting_at_the_end() {
    let whole = compact(&renamed(60), 10).unwrap().unwrap();
    let mut along = with_rack();
    for i in 1..=60 {
        rename(&mut along, i);
        if i % 13 == 0 {
            along = compact(&along, 10).unwrap().unwrap_or(along);
        }
    }
    let along = compact(&along, 10).unwrap().unwrap_or(along);
    assert_eq!(plain(&along), plain(&whole));
}

fn undo_of(target: u128, n: u128) -> Change {
    let mut p = prov(n);
    p.supersedes = None;
    let mut g = renamed(30);
    g.begin_batch(batch_id(n), "undo").unwrap();
    g.set_batch_reverses(batch_id(target)).unwrap();
    g.set_field(rack(), RackField::Label.key(), Text("R0".into()), p.clone())
        .unwrap();
    g.end_batch().unwrap();
    Change {
        batch: g.log().last().unwrap().clone(),
        provenance: vec![p],
        values: vec![fathom_canon::Json::Str("R0".into())],
    }
}

#[test]
fn undo_reaches_the_kept_changes_and_no_further() {
    let slim = compact(&renamed(30), 10).unwrap().unwrap();
    // The change round-trips as a client would send it.
    let kept = fathom_workspace::read_change(&write_change(&undo_of(25, 100))).unwrap();
    assert!(apply_change(&mut slim.clone(), &kept, me()).is_ok());
    let dropped = undo_of(5, 101);
    assert!(matches!(
        apply_change(&mut slim.clone(), &dropped, me()),
        Err(ChangeError::ReversesUnknown { .. })
    ));
}
