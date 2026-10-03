//! A gesture dry run: the store plus a proposed change, without touching the store.
//!
//! The overlay is a [`World`] over another `World`. It adds virtual nodes and edges and
//! overrides field values, so a rule can be asked "would this be a problem?" before the
//! write. The base is never mutated; a refused gesture leaves nothing behind.

use std::collections::BTreeMap;

use crate::compile::Owner;
use crate::engine::{gesture_rules, Delta, Pack};
use crate::eval::{eval_rule, Diag, Finding};
use crate::schema::World;
use crate::value::{EdgeId, Field, FieldId, KindId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Ov<N> {
    Real(N),
    /// A node the proposal would mint.
    Virt(u32),
}

#[derive(Debug, Clone, Copy)]
pub enum OvEdge<E> {
    Real(E),
    Virt(u32),
}

pub struct VirtEdge<N> {
    pub edge: EdgeId,
    pub from: Ov<N>,
    pub to: Ov<N>,
    pub fields: Vec<(FieldId, Field)>,
}

pub struct Proposal<N> {
    pub nodes: Vec<(KindId, Vec<(FieldId, Field)>)>,
    pub edges: Vec<VirtEdge<N>>,
    pub fields: Vec<(Ov<N>, FieldId, Field)>,
}

impl<N> Default for Proposal<N> {
    fn default() -> Self {
        Proposal {
            nodes: Vec::new(),
            edges: Vec::new(),
            fields: Vec::new(),
        }
    }
}

pub struct Overlay<'a, W: World> {
    pub base: &'a W,
    pub p: &'a Proposal<W::Node>,
}

impl<W: World> World for Overlay<'_, W> {
    type Node = Ov<W::Node>;
    type Edge = OvEdge<W::Edge>;

    fn nodes(&self, kind: KindId, out: &mut Vec<Self::Node>) {
        let mut real = Vec::new();
        self.base.nodes(kind, &mut real);
        out.extend(real.into_iter().map(Ov::Real));
        for (i, (k, _)) in self.p.nodes.iter().enumerate() {
            if *k == kind {
                out.push(Ov::Virt(i as u32));
            }
        }
    }

    fn hop(&self, n: Self::Node, edge: EdgeId, rev: bool, out: &mut Vec<(Self::Node, Self::Edge)>) {
        if let Ov::Real(r) = n {
            let mut real = Vec::new();
            self.base.hop(r, edge, rev, &mut real);
            out.extend(
                real.into_iter()
                    .map(|(m, e)| (Ov::Real(m), OvEdge::Real(e))),
            );
        }
        for (i, e) in self.p.edges.iter().enumerate() {
            if e.edge != edge {
                continue;
            }
            let (here, there) = if rev { (e.to, e.from) } else { (e.from, e.to) };
            if here == n {
                out.push((there, OvEdge::Virt(i as u32)));
            }
        }
        out.sort_by_key(|(m, _)| *m);
    }

    fn field(&self, n: Self::Node, f: FieldId) -> Field {
        if let Some((_, _, v)) = self
            .p
            .fields
            .iter()
            .rev()
            .find(|(m, g, _)| *m == n && *g == f)
        {
            return v.clone();
        }
        match n {
            Ov::Real(r) => self.base.field(r, f),
            Ov::Virt(i) => self
                .p
                .nodes
                .get(i as usize)
                .and_then(|(_, fs)| fs.iter().find(|(g, _)| *g == f))
                .map_or(Field::Unset, |(_, v)| v.clone()),
        }
    }

    fn edge_field(&self, e: Self::Edge, f: FieldId) -> Field {
        match e {
            OvEdge::Real(r) => self.base.edge_field(r, f),
            OvEdge::Virt(i) => self
                .p
                .edges
                .get(i as usize)
                .and_then(|x| x.fields.iter().find(|(g, _)| *g == f))
                .map_or(Field::Unset, |(_, v)| v.clone()),
        }
    }

    fn kind_of(&self, n: Self::Node) -> KindId {
        match n {
            Ov::Real(r) => self.base.kind_of(r),
            Ov::Virt(i) => self
                .p
                .nodes
                .get(i as usize)
                .map_or(KindId(u16::MAX), |(k, _)| *k),
        }
    }
}

pub type Refused<N> = Vec<Finding<Ov<N>>>;

/// The refuse-severity findings the proposal would create: present with it, absent without.
pub fn refusals<W: World>(
    pack: &Pack,
    base: &W,
    p: &Proposal<W::Node>,
) -> (Refused<W::Node>, Vec<Diag>) {
    let empty = Proposal::default();
    let (before, after) = (Overlay { base, p: &empty }, Overlay { base, p });
    // Only a rule that reads something the proposal touches can be changed by it.
    let mut touched = Delta::default();
    touched.kinds.extend(p.nodes.iter().map(|(k, _)| *k));
    touched.edges.extend(p.edges.iter().map(|e| e.edge));
    for (n, f, _) in &p.fields {
        touched.fields.insert((Owner::Node(after.kind_of(*n)), *f));
    }
    let mut diags = Vec::new();
    let mut found = Vec::new();
    for i in gesture_rules(pack) {
        let rule = &pack.rules[i];
        if !touched.touches(&rule.reads) {
            continue;
        }
        let mut b = Vec::new();
        eval_rule(rule, i, &before, &mut b, &mut diags);
        let had: BTreeMap<_, ()> = b
            .into_iter()
            .map(|f| ((f.anchor, f.involves), ()))
            .collect();
        let mut a = Vec::new();
        eval_rule(rule, i, &after, &mut a, &mut diags);
        found.extend(
            a.into_iter()
                .filter(|f| !had.contains_key(&(f.anchor, f.involves.clone()))),
        );
    }
    (found, diags)
}
