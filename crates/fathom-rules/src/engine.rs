//! The incremental model (12 §6), at the grain this product needs.
//!
//! A rule's cached findings stay valid until a change touches its static read set
//! (`ReadSet`): a node of a kind it walks over appears or goes, an edge role it traverses
//! changes, or a field it reads is written. Only those rules run again, and each runs over
//! its whole anchor set. Anything finer (instance-level dependency keys) is 12 §6.3's
//! design and waits for a workload that needs it.

use std::collections::BTreeSet;

use crate::compile::{Owner, ReadSet};
use crate::eval::{eval_rule, Diag, Finding};
use crate::rule::{Rule, Severity};
use crate::schema::World;
use crate::value::{EdgeId, FieldId, KindId};

pub struct Pack {
    pub rules: Vec<Rule>,
}

impl Pack {
    pub fn index(&self, id: &str) -> Option<usize> {
        self.rules.iter().position(|r| r.meta.id == id)
    }
}

/// What changed in the store since the last evaluation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Delta {
    pub kinds: BTreeSet<KindId>,
    pub edges: BTreeSet<EdgeId>,
    pub fields: BTreeSet<(Owner, FieldId)>,
}

impl Delta {
    pub fn touches(&self, r: &ReadSet) -> bool {
        r.kinds.iter().any(|k| self.kinds.contains(k))
            || r.adjacency.iter().any(|(e, _)| self.edges.contains(e))
            || r.fields.iter().any(|f| self.fields.contains(f))
    }
}

pub enum Dirty {
    All,
    Delta(Delta),
}

pub struct Engine<N> {
    cache: Vec<Option<Vec<Finding<N>>>>,
    diags: Vec<Vec<Diag>>,
    /// Rules evaluated by the last `refresh`, for tests and the work-counter gate.
    pub last_run: Vec<usize>,
}

impl<N: Copy + Eq + Ord> Engine<N> {
    pub fn new(rules: usize) -> Engine<N> {
        Engine {
            cache: vec![None; rules],
            diags: vec![Vec::new(); rules],
            last_run: Vec::new(),
        }
    }

    pub fn refresh<W: World<Node = N>>(&mut self, pack: &Pack, w: &W, dirty: &Dirty) {
        self.last_run.clear();
        for (i, rule) in pack.rules.iter().enumerate() {
            let stale = match dirty {
                Dirty::All => true,
                Dirty::Delta(d) => {
                    self.cache.get(i).is_none_or(Option::is_none) || d.touches(&rule.reads)
                }
            };
            if !stale {
                continue;
            }
            let mut out = Vec::new();
            let mut diags = Vec::new();
            eval_rule(rule, i, w, &mut out, &mut diags);
            self.cache[i] = Some(out);
            self.diags[i] = diags;
            self.last_run.push(i);
        }
    }

    /// Every standing finding: most severe first, then rule id, then anchor.
    pub fn findings(&self, pack: &Pack) -> Vec<Finding<N>> {
        let mut all: Vec<Finding<N>> = self.cache.iter().flatten().flatten().cloned().collect();
        all.sort_by(|a, b| {
            let (ra, rb) = (&pack.rules[a.rule], &pack.rules[b.rule]);
            (ra.meta.severity, &ra.meta.id, a.anchor, &a.involves).cmp(&(
                rb.meta.severity,
                &rb.meta.id,
                b.anchor,
                &b.involves,
            ))
        });
        all
    }

    pub fn diagnostics(&self) -> Vec<Diag> {
        self.diags.iter().flatten().cloned().collect()
    }
}

/// Only refuse-severity rules gate a gesture.
pub fn gesture_rules(pack: &Pack) -> impl Iterator<Item = usize> + '_ {
    pack.rules
        .iter()
        .enumerate()
        .filter(|(_, r)| r.meta.severity == Severity::Refuse)
        .map(|(i, _)| i)
}
