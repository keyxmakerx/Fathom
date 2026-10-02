//! Evaluating one rule over a world: anchors, bindings, the condition, the finding.
//!
//! Bounded at every level (12 §4.2, §7): the VM has its step budget, a binding may visit
//! at most `MAX_VISITS` nodes, and a rule that fails stops for this pass with a diagnostic
//! instead of a finding. A broken rule is loud and cannot take the panel down.

use std::rc::Rc;

use crate::rule::{BindPlan, Card, OnUnset, Rule};
use crate::schema::World;
use crate::value::{Field, Scalar, Val};
use crate::vm::{run, STEP_BUDGET};

pub const MAX_VISITS: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding<N> {
    pub rule: usize,
    pub anchor: N,
    /// The anchor's neighbours the rule names (sorted, no duplicates, anchor excluded).
    pub involves: Vec<N>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diag {
    pub rule: usize,
    pub message: String,
}

enum Bound<N> {
    Val(Val<N>, Vec<N>),
}

fn bind<W: World>(b: &BindPlan, a: W::Node, w: &W) -> Result<Bound<W::Node>, String> {
    let mut cur = vec![a];
    let mut visits = 0usize;
    let mut tmp = Vec::new();
    for h in &b.hops {
        let mut next: Vec<W::Node> = Vec::new();
        for n in &cur {
            tmp.clear();
            w.hop(*n, h.edge, h.rev, &mut tmp);
            for (m, e) in &tmp {
                visits += 1;
                if visits > MAX_VISITS {
                    return Err(format!(
                        "binding `{}` visited more than {MAX_VISITS} nodes",
                        b.name
                    ));
                }
                let keep = h.filter.iter().all(|(f, tok)| {
                    matches!(w.edge_field(*e, *f), Field::Set(Scalar::Str(s)) if s == *tok)
                }) && h.without.iter().all(|f| !matches!(w.edge_field(*e, *f), Field::Set(_)))
                    && h.kind.is_none_or(|k| w.kind_of(*m) == k);
                if keep {
                    next.push(*m);
                }
            }
        }
        next.sort();
        next.dedup();
        cur = next;
    }
    Ok(match (b.card, cur.len()) {
        (Card::Many, _) => Bound::Val(
            Val::List(Rc::new(cur.iter().map(|n| Val::Node(*n)).collect())),
            cur,
        ),
        (Card::One, 1) | (Card::Optional, 1) => Bound::Val(Val::Node(cur[0]), cur),
        (Card::Optional, 0) => Bound::Val(Val::Null, cur),
        (Card::One, n) => {
            return Err(format!(
                "binding `{}` is card one and found {n}; the graph is malformed here",
                b.name
            ))
        }
        (Card::Optional, n) => {
            return Err(format!("binding `{}` is optional and found {n}", b.name))
        }
    })
}

/// Evaluate `rule` (index `idx` in its pack) over `w`. Findings arrive in anchor order.
pub fn eval_rule<W: World>(
    rule: &Rule,
    idx: usize,
    w: &W,
    out: &mut Vec<Finding<W::Node>>,
    diags: &mut Vec<Diag>,
) {
    let mut anchors = Vec::new();
    w.nodes(rule.anchor, &mut anchors);
    let diag = |d: &mut Vec<Diag>, m: String| {
        d.push(Diag {
            rule: idx,
            message: m,
        })
    };
    'anchors: for a in anchors {
        if let Some(f) = &rule.filter {
            match run(f, w, vec![Val::Node(a)], STEP_BUDGET) {
                Ok(o)
                    if o.value == Val::Bool(true)
                        && !(o.saw_unset && rule.on_unset == OnUnset::Skip) => {}
                Ok(_) => continue,
                Err(e) => {
                    diag(diags, format!("where {}", e.text()));
                    continue;
                }
            }
        }
        let mut slots: Vec<Val<W::Node>> = vec![Val::Node(a)];
        let mut named: Vec<(usize, Vec<W::Node>)> = Vec::new();
        for (i, b) in rule.binds.iter().enumerate() {
            match bind(b, a, w) {
                Ok(Bound::Val(v, nodes)) => {
                    slots.push(v);
                    named.push((i, nodes));
                }
                Err(m) => {
                    diag(diags, m);
                    continue 'anchors;
                }
            }
        }
        if let Some(c) = rule.canonical {
            if let Some(Val::Node(b)) = slots.get(c + 1) {
                if a >= *b {
                    continue;
                }
            }
        }
        match run(&rule.cond, w, slots, STEP_BUDGET) {
            Ok(o) => {
                if o.value == Val::Bool(true) && !(o.saw_unset && rule.on_unset == OnUnset::Skip) {
                    let mut involves: Vec<W::Node> = named
                        .iter()
                        .filter(|(i, _)| rule.involves.contains(i))
                        .flat_map(|(_, ns)| ns.iter().copied())
                        .filter(|n| *n != a)
                        .collect();
                    involves.sort();
                    involves.dedup();
                    out.push(Finding {
                        rule: idx,
                        anchor: a,
                        involves,
                    });
                }
            }
            Err(e) => {
                diag(diags, format!("condition {}", e.text()));
            }
        }
    }
}
