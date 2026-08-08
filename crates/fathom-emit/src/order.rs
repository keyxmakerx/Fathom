//! Finalise and order (WO-04 §4.8; `13` §3.2, §5.6, §5.7).
//!
//! No hash-keyed container anywhere in this crate — iteration order is a
//! property of `BTreeMap`, `Vec` and the sort, never of a hasher seed
//! (invariant 9). Gate G9's grep is what keeps that true.

use crate::block;
use crate::line::{EmittedLine, FieldRole};
use crate::output::EmitError;
use crate::report::{EmitConflict, EmitReport};
use fathom_graph::NodeId;
use fathom_ir::generated::ir_types::NodeKind;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BinaryHeap};

/// Dedupe/conflict, then dependencies, then Kahn's algorithm over the key
/// `(block rank, order_hint, path)`.
pub(crate) fn finalise(
    lines: Vec<EmittedLine>,
    report: &mut EmitReport,
) -> Result<Vec<EmittedLine>, EmitError> {
    let lines = dedupe(lines, report);
    let deps = dependencies(&lines);
    order(lines, &deps)
}

/// P2 (`13` §3.1): no two lines in one `EmitOutput` share a path. Equal-path
/// runs with byte-equal `text` merge; equal-path runs with differing `text`
/// raise an `EmitConflict` and drop neither line — rendering is what refuses.
fn dedupe(mut lines: Vec<EmittedLine>, report: &mut EmitReport) -> Vec<EmittedLine> {
    lines.sort_by(|a, b| a.path.cmp(&b.path));
    let mut out: Vec<EmittedLine> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let mut j = i + 1;
        while j < lines.len() && lines[j].path == lines[i].path {
            j += 1;
        }
        if j - i == 1 {
            out.push(lines[i].clone());
        } else if lines[i + 1..j].iter().all(|l| l.text == lines[i].text) {
            let mut merged = lines[i].clone();
            for l in &lines[i + 1..j] {
                for f in &l.source_fields {
                    if !merged.source_fields.contains(f) {
                        merged.source_fields.push(*f);
                    }
                }
                merged.order_hint = merged.order_hint.min(l.order_hint);
            }
            out.push(merged);
        } else {
            report.conflicts.push(EmitConflict {
                path: lines[i].path.clone(),
            });
            out.extend_from_slice(&lines[i..j]);
        }
        i = j;
    }
    out
}

/// `13` §5.7's producers, cut to the two this closure has: a reference edge's
/// creating line before the line that names it, and the containing `IpsecVpn`
/// line before each `TrafficSelector` line. Nothing else may add an edge, so
/// `E ≤ 2V`.
fn dependencies(lines: &[EmittedLine]) -> Vec<(usize, usize)> {
    let mut first: BTreeMap<NodeId, usize> = BTreeMap::new();
    for (i, l) in lines.iter().enumerate() {
        first
            .entry(l.source_node)
            .and_modify(|cur| {
                if (l.order_hint, i) < (lines[*cur].order_hint, *cur) {
                    *cur = i;
                }
            })
            .or_insert(i);
    }
    let vpn_line = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.source_node.kind == NodeKind::IpsecVpn)
        .min_by_key(|(i, l)| (l.order_hint, *i))
        .map(|(i, _)| i);

    let mut deps: Vec<(usize, usize)> = Vec::new();
    for (to, l) in lines.iter().enumerate() {
        for f in &l.source_fields {
            if f.role != FieldRole::Referenced {
                continue;
            }
            if let Some(&from) = first.get(&f.node) {
                if from != to {
                    deps.push((from, to));
                }
            }
        }
        if l.source_node.kind == NodeKind::TrafficSelector {
            if let Some(from) = vpn_line {
                if from != to {
                    deps.push((from, to));
                }
            }
        }
    }
    deps.sort_unstable();
    deps.dedup();
    deps
}

/// `13` §5.6: Kahn's algorithm, ready set in a binary min-heap over the key
/// `(block rank, order_hint, path)`. The key is a strict total order after
/// `dedupe`, so the output sequence is unique on every machine, in every
/// build.
fn order(lines: Vec<EmittedLine>, deps: &[(usize, usize)]) -> Result<Vec<EmittedLine>, EmitError> {
    let n = lines.len();
    let mut by_key: Vec<usize> = (0..n).collect();
    by_key.sort_by(|&a, &b| {
        (
            block::rank(lines[a].block),
            lines[a].order_hint,
            &lines[a].path,
        )
            .cmp(&(
                block::rank(lines[b].block),
                lines[b].order_hint,
                &lines[b].path,
            ))
    });
    // `rank[i]` is `i`'s position in the key order — a dense stand-in for the
    // key itself, so the heap never clones a path.
    let mut rank = vec![0usize; n];
    for (position, &i) in by_key.iter().enumerate() {
        rank[i] = position;
    }

    let mut indeg = vec![0usize; n];
    let mut succ: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(from, to) in deps {
        indeg[to] += 1;
        succ[from].push(to);
    }

    let mut ready: BinaryHeap<Reverse<(usize, usize)>> = BinaryHeap::new();
    for i in 0..n {
        if indeg[i] == 0 {
            ready.push(Reverse((rank[i], i)));
        }
    }
    let mut sequence = Vec::with_capacity(n);
    while let Some(Reverse((_, i))) = ready.pop() {
        sequence.push(i);
        for &m in &succ[i] {
            indeg[m] -= 1;
            if indeg[m] == 0 {
                ready.push(Reverse((rank[m], m)));
            }
        }
    }
    if sequence.len() < n {
        return Err(EmitError::OrderingCycle);
    }

    let mut slots: Vec<Option<EmittedLine>> = lines.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(n);
    for i in sequence {
        out.push(slots[i].take().expect("each index popped exactly once"));
    }
    Ok(out)
}
