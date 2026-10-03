//! The two traits the rule engine reads the world through. Neither names the real store,
//! so the VM, the compiler and the fuzzers run over a test double with no estate.

use crate::value::{EdgeId, EnumId, Field, FieldId, KindId, Ty};

#[derive(Debug, Clone, Copy)]
pub struct FieldInfo {
    pub id: FieldId,
    pub ty: Ty,
}

#[derive(Debug, Clone)]
pub struct EdgeInfo {
    pub id: EdgeId,
    pub from: Vec<KindId>,
    pub to: Vec<KindId>,
}

/// What `schema/` declares, as far as rules may touch it. A rule can name only what is
/// here: a field that is not in the schema does not exist (CLAUDE.md rule 3).
pub trait Schema {
    fn kind(&self, name: &str) -> Option<KindId>;
    fn kind_name(&self, k: KindId) -> String;
    fn node_field(&self, k: KindId, name: &str) -> Option<FieldInfo>;
    fn edge(&self, name: &str) -> Option<EdgeInfo>;
    fn edge_field(&self, e: EdgeId, name: &str) -> Option<FieldInfo>;
    /// The declared tokens of an enum; `None` when this schema cannot enumerate them, in
    /// which case a token is accepted unchecked (a fixture then has to prove it fires).
    fn enum_tokens(&self, e: EnumId) -> Option<Vec<String>>;
}

/// The graph a rule is evaluated over. Reads only: a rule cannot write, and cannot reach
/// a node its selector did not bind.
pub trait World {
    type Node: Copy + Eq + Ord;
    type Edge: Copy;

    /// Live nodes of one kind, in a total order that does not depend on insertion
    /// history (invariant 9).
    fn nodes(&self, kind: KindId, out: &mut Vec<Self::Node>);
    /// Live neighbours over one edge role, in a total order. `rev` follows the edge
    /// from its `to` end.
    fn hop(&self, n: Self::Node, edge: EdgeId, rev: bool, out: &mut Vec<(Self::Node, Self::Edge)>);
    fn field(&self, n: Self::Node, f: FieldId) -> Field;
    fn edge_field(&self, e: Self::Edge, f: FieldId) -> Field;
    /// The kind of a node, for the `kind:` narrowing on a hop.
    fn kind_of(&self, n: Self::Node) -> KindId;
}
