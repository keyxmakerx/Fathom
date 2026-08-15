//! Diagram layout: a typed graph in, boxes and routed lines out.
//!
//! **Runs in the core, never the UI** — `41` §750, whose three reasons are all
//! load-bearing: it must be deterministic (invariant 9), it is shared with the
//! CLI's SVG export, and `23` §6.5 already requires diagram layout to be a
//! deterministic non-model task. Doing it in JavaScript would be cheaper in
//! bytes and would put the one thing that must be reproducible on the one side
//! of the boundary where nothing is checked.
//!
//! # What this is, and what it is not
//!
//! This is **slice one**: every node is a box, every edge is a line, positions
//! come from a layered walk of the containment tree. It is the picture, drawn
//! honestly, and it is the foundation the rest attaches to.
//!
//! It is **not** `56`'s finished design, and nothing here should be mistaken for
//! it. Absent, in that document's terms: the five toggled layers (§4), the
//! aggregation stacks (§1.3), Sugiyama's crossing-reduction pass (§3.2 phase 5),
//! orthogonal channel allocation (§3.2 phase 8), pins and `LayoutHint` (§3.5),
//! and the reth's two-layer treatment (§4.2). Each is real work and each sits on
//! top of this rather than replacing it.
//!
//! # Determinism
//!
//! No clock, no RNG, no hash-ordered collection. Ranks come from the containment
//! tree; order within a rank is by `NodeId`, which is a ULID and therefore a
//! total order that is a pure function of content. The same graph lays out to
//! the same coordinates on every machine, which is what makes a diagram
//! shareable in a change ticket (`16` §1.1's argument, applied to pictures).
//!
//! # Coordinates
//!
//! Integers, in abstract units the page scales. Integers rather than floats
//! because invariant 9 forbids anything whose bit pattern could differ across
//! targets, and because a diagram that renders one pixel differently on two
//! machines is a diff nobody can explain.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

use fathom_graph::{Graph, NodeId};
use fathom_ir::generated::ir_types::{EdgeClass, EdgeKind, NodeKind};

/// Box geometry, in abstract units. The page multiplies by whatever it needs;
/// these are chosen so a label of ~24 characters fits at the page's mono size.
pub const BOX_W: i32 = 200;
pub const BOX_H: i32 = 44;
/// Gap between ranks (horizontal) and between siblings (vertical).
pub const RANK_GAP: i32 = 90;
pub const SIB_GAP: i32 = 18;
/// Margin around the whole drawing.
pub const MARGIN: i32 = 24;

/// One drawn node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    /// The element's display id — what the page sends back to select it, so a
    /// click on the diagram reaches the same inspector a click on a table row
    /// does. Rows reference ids, never names (invariant 7).
    pub id: String,
    pub kind: &'static str,
    /// The name a person would use. Falls back to the id when the kind has no
    /// display-name rule yet, which is visible rather than blank on purpose.
    pub label: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

/// One drawn edge, already routed. The page draws the points and does not
/// compute geometry — `44` §391 and `41` §4.5 both put routing in the core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub from: String,
    pub to: String,
    pub kind: &'static str,
    /// True when the edge is containment — the page draws these quieter, because
    /// "this port is on that device" is structure and "this tunnel binds that
    /// interface" is a fact about the network.
    pub containment: bool,
    /// An orthogonal polyline, `(x, y)` in order. Always at least two points.
    pub points: Vec<(i32, i32)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Diagram {
    pub nodes: Vec<Node>,
    pub links: Vec<Link>,
    pub width: i32,
    pub height: i32,
}

/// Lay the whole estate out.
///
/// Tombstoned nodes are excluded: the diagram draws what is true now, exactly as
/// the inventory does. History is reached through provenance, not by drawing
/// things that are gone.
pub fn lay_out(g: &Graph) -> Diagram {
    let live: Vec<NodeId> = NodeKind::ALL
        .into_iter()
        .flat_map(|k| g.nodes_of_kind(k))
        .filter(|n| n.absent_since.is_none())
        .map(|n| n.id)
        .collect();
    if live.is_empty() {
        return Diagram::default();
    }

    // Rank = depth in the containment forest. Derived from the schema's edge
    // classes rather than a hand-written table of kinds, so a schema change
    // moves the picture with no edit here.
    let mut ranked: Vec<(u32, NodeId)> = live.iter().map(|id| (depth(g, *id), *id)).collect();
    // ULID order within a rank. `sort` is stable and the key is total, so this
    // is a pure function of content.
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));

    let mut nodes: Vec<Node> = Vec::with_capacity(ranked.len());
    let mut rank_now = u32::MAX;
    let mut row: i32 = 0;
    let mut widest_rank: i32 = 0;
    for (rank, id) in &ranked {
        if *rank != rank_now {
            rank_now = *rank;
            row = 0;
        }
        let x = MARGIN + (*rank as i32) * (BOX_W + RANK_GAP);
        let y = MARGIN + row * (BOX_H + SIB_GAP);
        nodes.push(Node {
            id: id.to_string(),
            kind: id.kind.name(),
            label: label_of(g, *id),
            x,
            y,
            w: BOX_W,
            h: BOX_H,
        });
        row += 1;
        widest_rank = widest_rank.max(row);
    }

    let links = route(g, &nodes, &live);

    let ranks = ranked.last().map(|(r, _)| *r + 1).unwrap_or(0) as i32;
    Diagram {
        width: MARGIN * 2 + ranks * BOX_W + (ranks.saturating_sub(1)) * RANK_GAP,
        height: MARGIN * 2 + widest_rank * BOX_H + (widest_rank.saturating_sub(1)) * SIB_GAP,
        nodes,
        links,
    }
}

/// How many containment edges lie between this node and a root.
///
/// `Graph::owner` is the store's own answer and already knows what a root is:
/// the five root-containment edge kinds are refused, so `Site`, `Tunnel`,
/// `Premises`, `Cable`, `Tenant` and `ServiceType` are roots. Walking it by hand
/// here would be a second implementation of a rule that already exists.
///
/// Bounded so a containment cycle — which the store's rules should make
/// impossible, and which this must not hang on if they ever do not — terminates
/// instead of looping.
fn depth(g: &Graph, id: NodeId) -> u32 {
    let mut d = 0;
    let mut at = id;
    while d < 64 {
        match g.owner(at) {
            Some(p) => {
                d += 1;
                at = p;
            }
            None => break,
        }
    }
    d
}

fn label_of(g: &Graph, id: NodeId) -> String {
    match fathom_inventory::element_page(g, id) {
        Some(p) if !p.name.is_empty() => p.name,
        _ => id.to_string(),
    }
}

/// Route every effective edge between two drawn nodes.
///
/// Three-segment orthogonal: out of the right face, across a channel halfway
/// between the ranks, into the left face. Where the two nodes share a rank the
/// path is a straight line, which is honest about the fact that this slice has
/// no channel allocation — `56` §3.2 phase 8's interval-graph colouring is not
/// here, so a dense estate will show overlapping lines rather than pretending.
fn route(g: &Graph, nodes: &[Node], live: &[NodeId]) -> Vec<Link> {
    let mut links = Vec::new();
    for from in live {
        for kind in EdgeKind::ALL {
            if kind.root_containment() {
                continue;
            }
            for e in g.out(*from, kind) {
                if e.absent_since.is_some() {
                    continue;
                }
                let (Some(a), Some(b)) = (find(nodes, *from), find(nodes, e.to)) else {
                    continue;
                };
                links.push(Link {
                    from: a.id.clone(),
                    to: b.id.clone(),
                    kind: kind.name(),
                    containment: kind.class() == EdgeClass::Containment,
                    points: path(a, b),
                });
            }
        }
    }
    // A total order that does not depend on iteration: the picture is the same
    // every time it is drawn, including the order lines are painted in.
    links.sort_by(|x, y| {
        (x.from.as_str(), x.to.as_str(), x.kind).cmp(&(y.from.as_str(), y.to.as_str(), y.kind))
    });
    links
}

fn find(nodes: &[Node], id: NodeId) -> Option<&Node> {
    let want = id.to_string();
    nodes.iter().find(|n| n.id == want)
}

fn path(a: &Node, b: &Node) -> Vec<(i32, i32)> {
    let (ay, by) = (a.y + a.h / 2, b.y + b.h / 2);
    if a.x == b.x {
        // Same rank: the two boxes are stacked, so there is no facing pair to
        // join. Detour out the right face, down the channel beside the rank, and
        // back in — a straight line between them would be DIAGONAL, which this
        // routing does not do and which the orthogonality test catches.
        let ch = a.x + a.w + RANK_GAP / 2;
        return vec![(a.x + a.w, ay), (ch, ay), (ch, by), (b.x + b.w, by)];
    }
    let (start, end) = if a.x < b.x {
        ((a.x + a.w, ay), (b.x, by))
    } else {
        ((a.x, ay), (b.x + b.w, by))
    };
    let mid = (start.0 + end.0) / 2;
    vec![start, (mid, start.1), (mid, end.1), end]
}
