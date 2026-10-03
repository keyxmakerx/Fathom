//! Fixtures: a small estate, written in the real schema's own field names and values, and
//! what the rule must say about it. They build a real `Graph` through the real write path,
//! so a fixture that the store would refuse is a failing fixture, and a value no device
//! would accept cannot pass for one (CLAUDE.md rule 2).

use std::collections::BTreeMap;

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind, FIELD_KEYS};
use fathom_schema::subset::{parse_profile, Profile};
use fathom_schema::value::{Node, Value};

use crate::engine::Pack;
use crate::eval::eval_rule;
use crate::graph::{box_from_text, GraphWorld};
use crate::pack::Fixture;

/// 2026-10-02T00:00:00Z. Stored, never evaluated against a clock.
const TS0: u64 = 1_790_899_200_000;

fn ulid(k: u128) -> Ulid {
    Ulid::from_parts(TS0, k).expect("TS0 fits 48 bits")
}

fn prov() -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(9001)),
        origin: Origin::Hand,
        asserted_at: Timestamp(TS0),
        asserted_by: Actor::User(UserId(ulid(9000))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

fn key(owner: &str, field: &str) -> Result<FieldKey, String> {
    let full = format!("{owner}.{field}");
    FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == full)
        .map(|(_, k)| FieldKey(*k))
        .ok_or_else(|| format!("`{full}` is not a declared field"))
}

fn s(n: &Node, k: &str) -> Result<String, String> {
    n.get(k)
        .map(Node::scalar_display)
        .ok_or_else(|| format!("line {}: `{k}` is required", n.line))
}

fn apply(g: &mut Graph, el: ElementId, owner: &str, spec: &Node) -> Result<(), String> {
    if let Some(set) = spec.get("set").and_then(Node::as_map) {
        for (f, v) in set {
            let k = key(owner, f)?;
            let boxed =
                box_from_text(k, &v.scalar_display()).map_err(|e| format!("{owner}.{f}: {e}"))?;
            g.set_field_boxed(el, k, boxed, prov())
                .map_err(|e| format!("{owner}.{f}: {e}"))?;
        }
    }
    for (list, absent) in [("absent", true), ("present", false)] {
        for f in spec.get(list).and_then(Node::as_seq).unwrap_or_default() {
            let name = f.scalar_display();
            let k = key(owner, &name)?;
            if absent {
                g.assert_absent(el, k, prov())
                    .map_err(|e| format!("{owner}.{name}: {e}"))?;
            } else {
                let boxed =
                    box_from_text(k, "present").map_err(|e| format!("{owner}.{name}: {e}"))?;
                g.set_field_boxed(el, k, boxed, prov())
                    .map_err(|e| format!("{owner}.{name}: {e}"))?;
            }
        }
    }
    Ok(())
}

/// Build the fixture's estate. Returns the graph and the fixture's own ids.
pub fn build(root: &Node) -> Result<(Graph, BTreeMap<String, NodeId>), String> {
    let mut g = Graph::new();
    g.begin_batch(BatchId(ulid(9002)), "fixture")
        .map_err(|e| e.to_string())?;
    let mut ids: BTreeMap<String, NodeId> = BTreeMap::new();
    let mut k = 1u128;
    for n in root.get("nodes").and_then(Node::as_seq).unwrap_or_default() {
        let (id, kind) = (s(n, "id")?, s(n, "kind")?);
        let kind = NodeKind::from_name(&kind).ok_or(format!("`{kind}` is not a kind"))?;
        let nid = g
            .insert_node(kind, ulid(k), prov())
            .map_err(|e| e.to_string())?;
        k += 1;
        apply(&mut g, ElementId::Node(nid), kind.name(), n)?;
        if ids.insert(id.clone(), nid).is_some() {
            return Err(format!("fixture id `{id}` is used twice"));
        }
    }
    for e in root.get("edges").and_then(Node::as_seq).unwrap_or_default() {
        let kind = s(e, "kind")?;
        let kind = EdgeKind::from_name(&kind).ok_or(format!("`{kind}` is not an edge"))?;
        let at = |name: &str| -> Result<NodeId, String> {
            let id = s(e, name)?;
            ids.get(&id)
                .copied()
                .ok_or(format!("edge {name}: no node `{id}`"))
        };
        let eid = g
            .insert_edge(kind, ulid(k), at("from")?, at("to")?, prov())
            .map_err(|x| format!("{} edge: {x}", kind.name()))?;
        k += 1;
        apply(&mut g, ElementId::Edge(eid), kind.name(), e)?;
    }
    g.end_batch().map_err(|e| e.to_string())?;
    Ok((g, ids))
}

/// Run one fixture against its rule. `Ok` when it behaves as its name says.
pub fn check(pack: &Pack, f: &Fixture) -> Result<(), String> {
    let root = parse_profile(&f.text, Profile::Corpus)
        .map_err(|e| format!("line {}: {}", e.line, e.message))?;
    let (g, ids) = build(&root)?;
    let idx = pack.index(&f.rule).ok_or("no such rule")?;
    let (mut out, mut diags) = (Vec::new(), Vec::new());
    eval_rule(
        &pack.rules[idx],
        idx,
        &GraphWorld { g: &g },
        &mut out,
        &mut diags,
    );
    if let Some(d) = diags.first() {
        return Err(format!("the rule failed: {}", d.message));
    }
    if !f.fire {
        return match out.first() {
            None => Ok(()),
            Some(x) => Err(format!(
                "must pass, but fired on {}",
                name_of(&ids, x.anchor)
            )),
        };
    }
    let want = root
        .get("anchor")
        .map(Node::scalar_display)
        .ok_or("a fire fixture names the `anchor` it expects")?;
    let anchors: Vec<String> = out.iter().map(|x| name_of(&ids, x.anchor)).collect();
    if !anchors.contains(&want) {
        return Err(format!("must fire on `{want}`; it fired on {anchors:?}"));
    }
    if let Some(list) = root.get("involves").and_then(Node::as_seq) {
        let want: Vec<String> = list.iter().map(Node::scalar_display).collect();
        let fnd = out.iter().find(|x| {
            name_of(&ids, x.anchor)
                == name_of(
                    &ids,
                    ids[&root
                        .get("anchor")
                        .map(Node::scalar_display)
                        .unwrap_or_default()],
                )
        });
        let got: Vec<String> = fnd
            .map(|x| x.involves.iter().map(|n| name_of(&ids, *n)).collect())
            .unwrap_or_default();
        let mut w = want.clone();
        w.sort();
        let mut gt = got.clone();
        gt.sort();
        if w != gt {
            return Err(format!("involves {got:?}, expected {want:?}"));
        }
    }
    Ok(())
}

fn name_of(ids: &BTreeMap<String, NodeId>, n: NodeId) -> String {
    ids.iter()
        .find(|(_, v)| **v == n)
        .map_or_else(|| n.to_string(), |(k, _)| k.clone())
}

#[allow(dead_code)]
fn _value_is_used(_: &Value) {}
