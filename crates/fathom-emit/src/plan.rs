//! The plan stage: the emit unit, its ordinals, and the edge readers every
//! kind emitter shares (WO-04 §4.5).
//!
//! The closure is `11` §9.2's `IpsecVpn` tree, walked over exactly the edges
//! below in exactly the child order below. Ordinals are the depth-first
//! **post-order** of that walk — referenced object before the object that
//! names it, which is the object-chain order the card teaches (WO-04 §12
//! item 2 files that against `11` §9.2's word "pre-order").

use fathom_graph::{Edge, Graph, NodeId};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind, UsesProposalField};

/// One node of the emit unit and the ordinal its statement rows are numbered
/// from: `order_hint = ordinal × 1000 + statement row`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Member {
    pub node: NodeId,
    pub ordinal: u32,
}

/// The emit unit, in post-order.
pub(crate) fn walk(graph: &Graph, root: NodeId) -> Vec<Member> {
    let mut out = Vec::new();
    let mut seen = Vec::new();
    visit(graph, root, &mut seen, &mut out);
    out
}

fn visit(graph: &Graph, node: NodeId, seen: &mut Vec<NodeId>, out: &mut Vec<Member>) {
    if seen.contains(&node) {
        return;
    }
    seen.push(node);
    for child in children(graph, node) {
        visit(graph, child, seen, out);
    }
    let ordinal = u32::try_from(out.len()).unwrap_or(u32::MAX);
    out.push(Member { node, ordinal });
}

/// The declared "I will follow this" edges, in the tree's own child order.
fn children(graph: &Graph, node: NodeId) -> Vec<NodeId> {
    match node.kind {
        NodeKind::IpsecVpn => {
            let mut kids = Vec::new();
            kids.extend(targets(graph, node, EdgeKind::UsesIkeGateway));
            kids.extend(targets(graph, node, EdgeKind::UsesIpsecPolicy));
            kids.extend(selectors(graph, node));
            kids.extend(targets(graph, node, EdgeKind::BindsInterface));
            kids
        }
        NodeKind::IkeGateway => {
            let mut kids = Vec::new();
            kids.extend(targets(graph, node, EdgeKind::UsesIkePolicy));
            kids.extend(targets(graph, node, EdgeKind::ExternalInterface));
            kids
        }
        NodeKind::IkePolicy | NodeKind::IpsecPolicy => {
            proposals(graph, node).into_iter().map(|e| e.to).collect()
        }
        _ => Vec::new(),
    }
}

/// The ordinal of a member node, if it is in the unit.
pub(crate) fn ordinal_of(unit: &[Member], node: NodeId) -> Option<u32> {
    unit.iter().find(|m| m.node == node).map(|m| m.ordinal)
}

/// Targets of an edge kind, in `EdgeId` order — the store's own adjacency
/// order, which is a pure function of content (invariant 9).
pub(crate) fn targets(graph: &Graph, node: NodeId, kind: EdgeKind) -> Vec<NodeId> {
    graph.out(node, kind).map(|e| e.to).collect()
}

/// The first edge of a `1` / `0..1` reference, in `EdgeId` order.
pub(crate) fn first_target(graph: &Graph, node: NodeId, kind: EdgeKind) -> Option<NodeId> {
    graph.out(node, kind).map(|e| e.to).next()
}

/// `HasTrafficSelector` targets, in `NodeId` order (WO-04 §4.5: targets of a
/// `0..n` edge in `NodeId` order).
pub(crate) fn selectors(graph: &Graph, vpn: NodeId) -> Vec<NodeId> {
    let mut out: Vec<NodeId> = graph
        .out(vpn, EdgeKind::HasTrafficSelector)
        .map(|e| e.to)
        .collect();
    out.sort();
    out
}

/// `UsesProposal` edges, in `(ordinal, EdgeId)` order; an `Unknown` or
/// `Absent` ordinal sorts after every `Set` one.
pub(crate) fn proposals(graph: &Graph, policy: NodeId) -> Vec<&Edge> {
    let mut edges: Vec<&Edge> = graph.out(policy, EdgeKind::UsesProposal).collect();
    edges.sort_by_key(|e| {
        // The second type parameter is the bag, inferred (`bag.rs`:
        // `typed<T: Any, B: FieldBag + ?Sized>`).
        let ord = fathom_ir::bag::typed::<u8, _>(*e, UsesProposalField::Ordinal.key()).ok();
        (ord.is_none(), ord.copied().unwrap_or(0), e.id)
    });
    edges
}
