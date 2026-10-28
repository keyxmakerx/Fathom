//! Slimmer saves (ADR-0079 decision 6, sign-off r53): a design's full face keeps the newest
//! [`KEEP_BATCHES`] changes, and only the provenance records something still names.
//!
//! The server stores every change on the design's chain, so nothing here is lost: older
//! changes are read from History, one page at a time. What goes is the copy of them inside each
//! save, which grew with every edit for as long as the design lived. Undo reaches the kept
//! changes; a change older than them is refused by `apply_change` (`ReversesUnknown`), as one
//! another person made is.
//!
//! Compaction is deterministic and composes: compacting, applying more changes and compacting
//! again gives what applying them to the uncompacted design and compacting once gives. That is
//! what lets the server compact at each checkpoint and still check every checkpoint against a
//! replay of its whole chain.

use std::collections::BTreeSet;

use fathom_graph::{Graph, Op, ProvenanceId, Snapshot};

use crate::{read_plain, write_plain, PlainError};

/// How many of the newest changes a save keeps (r53, option A).
pub const KEEP_BATCHES: usize = 500;

/// `s` with only its newest `keep` batches, and only the provenance records its nodes, edges,
/// field slots, field history and kept batches name. A record's `supersedes` may then name one
/// that is gone: it is a pointer back in time, never a reference the loader checks.
pub fn compact_snapshot(s: &Snapshot, keep: usize) -> Snapshot {
    let drop = s.batches.len().saturating_sub(keep);
    let batches = s.batches[drop..].to_vec();
    let mut used: BTreeSet<ProvenanceId> = BTreeSet::new();
    for n in &s.nodes {
        used.insert(n.existence);
        used.extend(n.fields.iter().map(|f| f.prov));
    }
    for e in &s.edges {
        used.insert(e.prov);
        used.extend(e.fields.iter().map(|f| f.prov));
    }
    for h in &s.history {
        used.extend(h.entries.iter().map(|e| e.prov));
    }
    for b in &batches {
        for op in &b.ops {
            match op {
                Op::AddNode { prov, .. } | Op::AddEdge { prov, .. } | Op::SetField { prov, .. } => {
                    used.insert(*prov);
                }
                Op::Tombstone { .. } | Op::Revive { .. } => {}
            }
        }
    }
    Snapshot {
        nodes: s.nodes.clone(),
        edges: s.edges.clone(),
        provenance: s
            .provenance
            .iter()
            .filter(|r| used.contains(&r.id))
            .cloned()
            .collect(),
        history: s.history.clone(),
        batches,
    }
}

/// `graph`, compacted: `None` when it already holds nothing compaction would drop.
pub fn compact(graph: &Graph, keep: usize) -> Result<Option<Graph>, PlainError> {
    let snapshot = graph.to_snapshot()?;
    let slim = compact_snapshot(&snapshot, keep);
    if slim.batches.len() == snapshot.batches.len()
        && slim.provenance.len() == snapshot.provenance.len()
    {
        return Ok(None);
    }
    Ok(Some(Graph::from_snapshot(&slim)?))
}

/// A full face, compacted: the same bytes back when there is nothing to drop.
pub fn compact_plain(bytes: &[u8], keep: usize) -> Result<Vec<u8>, PlainError> {
    match compact(&read_plain(bytes)?, keep)? {
        Some(slim) => write_plain(&slim),
        None => Ok(bytes.to_vec()),
    }
}
