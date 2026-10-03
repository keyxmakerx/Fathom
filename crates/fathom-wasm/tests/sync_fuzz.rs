//! Structure-aware fuzz of `OP_SYNC`: an honest delta, mutated in ways a byte flip never reaches
//! (reordered or duplicated batches, ops pointed at other elements, evidence the ops do not
//! explain, forged tombstones, history and provenance rewritten). Whatever the mutation, a
//! refusal leaves the module exactly as it was, and a delta that is taken leaves the design the
//! honest delta would have: nothing a mutation added is kept.

#![allow(dead_code)]

use std::collections::BTreeMap;

use fathom_graph::{BatchId, ElementId, FieldSnap, Graph, Op, Snapshot, StoredPresence, Timestamp};
use fathom_id::Ulid;
use fathom_wasm::protocol::{decode_reply, ReplyView};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_EXPORT_PLAIN, OP_LOAD_PLAIN, OP_SYNC};

mod sim;
use sim::{checks, Rng, Sim};

const T0: u64 = 1_790_899_200_000;

fn code(reply: &[u8]) -> Option<u16> {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => Some(e.code),
        _ => None,
    }
}

fn mutate(f: &mut Snapshot, held: &Graph, held_snap: &Snapshot, r: &mut Rng) -> &'static str {
    let held_nodes: Vec<_> = held.nodes().map(|n| n.id).collect();
    let held_edges: Vec<_> = held.edges().map(|e| e.id).collect();
    let pick_el = |r: &mut Rng| -> ElementId {
        if (r.chance(60) || held_edges.is_empty()) && !held_nodes.is_empty() {
            ElementId::Node(held_nodes[r.below(held_nodes.len())])
        } else {
            ElementId::Edge(held_edges[r.below(held_edges.len())])
        }
    };
    let nb = f.batches.len();
    match r.below(22) {
        0 if nb > 1 => {
            f.batches.swap(0, nb - 1);
            "swap_batches"
        }
        1 if nb > 0 => {
            let mut b = f.batches[r.below(nb)].clone();
            b.id = BatchId(Ulid::from_parts(T0, 77_000_000 + r.below(1000) as u128).unwrap());
            f.batches.push(b);
            "dup_batch_new_id"
        }
        2 if !f.nodes.is_empty() => {
            f.nodes.remove(r.below(f.nodes.len()));
            "drop_node"
        }
        3 if !f.edges.is_empty() => {
            f.edges.remove(r.below(f.edges.len()));
            "drop_edge"
        }
        4 if !f.nodes.is_empty() => {
            let i = r.below(f.nodes.len());
            f.nodes[i].absent_since = match f.nodes[i].absent_since {
                Some(_) => None,
                None => Some(Timestamp(T0 + 5)),
            };
            "flip_node_absent"
        }
        5 if !f.nodes.is_empty() => {
            // Steal a field from another held node of the same kind (hidden extra field).
            let i = r.below(f.nodes.len());
            let kind = f.nodes[i].id.kind;
            let snap = held_snap;
            let donors: Vec<FieldSnap> = snap
                .nodes
                .iter()
                .filter(|n| n.id.kind == kind && n.id != f.nodes[i].id)
                .flat_map(|n| n.fields.clone())
                .collect();
            if let Some(d) = r.pick(&donors).cloned() {
                f.nodes[i].fields.retain(|x| x.key != d.key);
                f.nodes[i].fields.push(d);
                f.nodes[i].fields.sort_by_key(|x| x.key);
            }
            "extra_field"
        }
        6 => {
            let el = pick_el(r);
            if nb > 0 {
                let b = r.below(nb);
                let no = f.batches[b].ops.len();
                if no > 0 {
                    let o = r.below(no);
                    match &mut f.batches[b].ops[o] {
                        Op::SetField { element, .. }
                        | Op::Tombstone { element, .. }
                        | Op::Revive { element, .. } => *element = el,
                        _ => {}
                    }
                }
            }
            "retarget_op"
        }
        7 if nb > 0 => {
            for b in &mut f.batches {
                for op in &mut b.ops {
                    if let Op::SetField { presence, .. } = op {
                        *presence = match r.below(3) {
                            0 => StoredPresence::Set,
                            1 => StoredPresence::Absent,
                            _ => StoredPresence::Unknown,
                        };
                        return "presence_flip";
                    }
                }
            }
            "presence_flip_none"
        }
        8 if !f.provenance.is_empty() => {
            let i = r.below(f.provenance.len());
            let other = f.provenance[r.below(f.provenance.len())].id;
            f.provenance[i].supersedes = if r.chance(50) { None } else { Some(other) };
            "supersedes"
        }
        9 if !f.provenance.is_empty() => {
            f.provenance.remove(r.below(f.provenance.len()));
            "drop_prov"
        }
        10 if !f.history.is_empty() => {
            let i = r.below(f.history.len());
            let h = &mut f.history[i];
            match r.below(3) {
                0 => {
                    h.entries.clear();
                }
                1 => {
                    let e = h.entries.first().cloned();
                    if let Some(e) = e {
                        for _ in 0..50 {
                            h.entries.insert(0, e.clone());
                        }
                    }
                }
                _ => h.truncated = u32::MAX,
            }
            "history_rewrite"
        }
        11 => {
            let el = pick_el(r);
            if nb > 0 {
                let b = r.below(nb);
                let by = Sim::actor();
                let op = if r.chance(50) {
                    Op::Tombstone {
                        element: el,
                        at: Timestamp(T0 + 9),
                        by,
                    }
                } else {
                    Op::Revive {
                        element: el,
                        at: Timestamp(T0 + 9),
                        by,
                    }
                };
                f.batches[b].ops.push(op);
                // Sometimes also lie consistently in the evidence.
                if r.chance(60) {
                    let snap = held_snap;
                    match el {
                        ElementId::Node(n) => {
                            if let Some(s) = snap.nodes.iter().find(|x| x.id == n) {
                                let mut s = s.clone();
                                s.absent_since = s.absent_since.xor(Some(Timestamp(T0 + 9)));
                                f.nodes.retain(|x| x.id != n);
                                f.nodes.push(s);
                                f.nodes.sort_by_key(|x| x.id);
                            }
                        }
                        ElementId::Edge(e) => {
                            if let Some(s) = snap.edges.iter().find(|x| x.id == e) {
                                let mut s = s.clone();
                                s.absent_since = s.absent_since.xor(Some(Timestamp(T0 + 9)));
                                f.edges.retain(|x| x.id != e);
                                f.edges.push(s);
                                f.edges.sort_by_key(|x| x.id);
                            }
                        }
                    }
                }
            }
            "inject_tomb_revive"
        }
        12 if !f.provenance.is_empty() && nb > 0 => {
            let p = f.provenance[r.below(f.provenance.len())].id;
            for b in &mut f.batches {
                for op in &mut b.ops {
                    match op {
                        Op::AddNode { prov, .. }
                        | Op::AddEdge { prov, .. }
                        | Op::SetField { prov, .. } => {
                            if r.chance(30) {
                                *prov = p;
                                return "swap_prov";
                            }
                        }
                        _ => {}
                    }
                }
            }
            "swap_prov_none"
        }
        13 if !f.edges.is_empty() => {
            let i = r.below(f.edges.len());
            let n = held_nodes[r.below(held_nodes.len())];
            if r.chance(50) {
                f.edges[i].from = n
            } else {
                f.edges[i].to = n
            }
            "edge_endpoint"
        }
        14 if nb > 0 => {
            let b = r.below(nb);
            let no = f.batches[b].ops.len();
            if no > 0 {
                f.batches[b].ops.remove(r.below(no));
            }
            "drop_op"
        }
        16 if !f.nodes.is_empty() => {
            let i = r.below(f.nodes.len());
            if !f.nodes[i].fields.is_empty() {
                let j = r.below(f.nodes[i].fields.len());
                f.nodes[i].fields.remove(j);
            }
            "drop_field"
        }
        17 if !f.nodes.is_empty() => {
            let i = r.below(f.nodes.len());
            if !f.nodes[i].fields.is_empty() {
                let j = r.below(f.nodes[i].fields.len());
                let fs = &mut f.nodes[i].fields[j];
                if fs.presence == StoredPresence::Set {
                    fs.presence = StoredPresence::Absent;
                    fs.value = None;
                } else {
                    fs.presence = StoredPresence::Unknown;
                }
            }
            "field_presence_lie"
        }
        18 if nb > 0 => {
            // Replay the whole held log too (base mismatch is checked; here the ops repeat).
            let mut extra = held.log().to_vec();
            for (k, b) in extra.iter_mut().enumerate() {
                b.id = BatchId(Ulid::from_parts(T0, 88_000_000 + k as u128).unwrap());
            }
            f.batches.splice(0..0, extra);
            "replay_old_ops"
        }
        19 if !f.nodes.is_empty() => {
            let i = r.below(f.nodes.len());
            let p = &held_snap.provenance;
            if let Some(x) = r.pick(p) {
                f.nodes[i].existence = x.id;
            }
            "existence_prov"
        }
        _ => {
            // A history record for a field no op set, smuggled in.
            let snap = held_snap;
            if let Some(h) = r.pick(&snap.history).cloned() {
                let mut h = h;
                if let Some(e) = h.entries.first().cloned() {
                    h.entries.push(e);
                }
                f.history
                    .retain(|x| (x.element, x.key) != (h.element, h.key));
                f.history.push(h);
                f.history.sort_by_key(|x| (x.element, x.key));
            }
            "smuggled_history"
        }
    }
}

#[test]
fn mutated_deltas_are_refused_or_equal_the_honest_one() {
    let mut st: BTreeMap<&str, usize> = BTreeMap::new();
    for seed in 1..=8u64 {
        let mut sim = Sim::new(seed);
        for _ in 0..30 {
            sim.step();
        }
        let base_bytes = fathom_workspace::write_plain(&sim.g).unwrap();
        let held_graph = fathom_workspace::read_plain(&base_bytes).unwrap();
        let seen = sim.g.log().len();
        for _ in 0..4 {
            sim.step();
        }
        let held_snap = held_graph.to_snapshot().unwrap();
        let honest = sim.g.to_snapshot().unwrap().since(seen);
        let base = held_graph.log().last().map(|b| b.id);
        let mut honest_sh = Shell::new();
        honest_sh.handle(OP_LOAD_PLAIN, &base_bytes);
        let reply = honest_sh.handle(OP_SYNC, &fathom_workspace::write_delta(base, &honest));
        assert_eq!(reply.len(), 8, "the honest delta must land");
        let honest_export = honest_sh.handle(OP_EXPORT_PLAIN, &[]);

        let mut r = Rng(seed * 31 + 7);
        let mut sh = Shell::new();
        sh.handle(OP_LOAD_PLAIN, &base_bytes);
        let before = sh.handle(OP_EXPORT_PLAIN, &[]);
        let base_checks = checks(&mut sh);
        for i in 0..150 {
            let mut f = honest.clone();
            let names: Vec<_> = (0..1 + r.below(3))
                .map(|_| mutate(&mut f, &held_graph, &held_snap, &mut r))
                .collect();
            let reply = sh.handle(OP_SYNC, &fathom_workspace::write_delta(base, &f));
            if code(&reply).is_none() {
                // Taken: the honest design, unless the mutation is a delta in its own right (batches
                // swapped, repeated, or an op injected with matching evidence), which must still
                // reload and check as a full load of what the module holds.
                let export = sh.handle(OP_EXPORT_PLAIN, &[]);
                if export != honest_export {
                    let own_right = ["swap_batches", "dup_batch_new_id", "inject_tomb_revive"];
                    assert!(
                        names.iter().any(|n| own_right.contains(n)),
                        "{names:?} was taken and changed the design"
                    );
                    let mut fresh = Shell::new();
                    assert_eq!(
                        code(&fresh.handle(OP_LOAD_PLAIN, &export)),
                        None,
                        "{names:?}"
                    );
                    assert_eq!(checks(&mut sh), checks(&mut fresh), "{names:?}");
                }
                *st.entry("taken").or_default() += 1;
                sh = Shell::new();
                sh.handle(OP_LOAD_PLAIN, &base_bytes);
            } else {
                assert_eq!(
                    code(&reply),
                    Some(fathom_wasm::protocol::ERR_RESYNC),
                    "{names:?}"
                );
                // The design and the checks are dear to read back: a sample of the refusals.
                if i % 5 == 0 {
                    assert_eq!(
                        sh.handle(OP_EXPORT_PLAIN, &[]),
                        before,
                        "{names:?} changed the design"
                    );
                    assert_eq!(checks(&mut sh), base_checks, "{names:?} changed the checks");
                }
                *st.entry("refused").or_default() += 1;
            }
        }
    }
    assert!(
        st["refused"] > 10 * st.get("taken").copied().unwrap_or(0),
        "{st:?}"
    );
}
