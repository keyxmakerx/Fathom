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
//! aggregation stacks (§1.3), pins and `LayoutHint` (§3.5), and the reth's
//! two-layer treatment (§4.2). Each is real work and each sits on top of this
//! rather than replacing it.
//!
//! **Three of Sugiyama's phases are here.** Phases 4 and 5 — dummy nodes and
//! crossing reduction — are in [`order`], because ordering a rank by `NodeId`
//! is deterministic and arbitrary, and arbitrary means lines cross for no
//! reason. Phase 8 — orthogonal routing with a channel set per band — is in
//! [`route`], because without it every line between two ranks ran through one
//! midpoint and a dense estate drew as a single thick stroke.
//!
//! # Determinism
//!
//! No clock, no RNG, no hash-ordered collection. Ranks come from the containment
//! tree; order within a rank is `order`'s fixed-length sweep, whose every tie
//! breaks on `NodeId` — a ULID, and therefore a total order that is a pure
//! function of content. The same graph lays out to the same coordinates on
//! every machine, which is what makes a diagram shareable in a change ticket
//! (`16` §1.1's argument, applied to pictures).
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

pub mod order;
mod route;

use fathom_graph::{Graph, NodeId};
use fathom_ir::generated::ir_types::NodeKind;

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

    // Order within a rank: `56` §3.2 phases 4 and 5, not `NodeId` order, which
    // is deterministic and arbitrary and made lines cross for no reason.
    let ordered = order::rows_for_graph(g, &live, &ranked);

    let mut nodes: Vec<Node> = Vec::with_capacity(ranked.len());
    let mut widest_rank: i32 = 0;
    for ((rank, id), row) in ranked.iter().zip(ordered.rows.iter()) {
        let x = MARGIN + (*rank as i32) * (BOX_W + RANK_GAP);
        let y = MARGIN + (*row as i32) * (BOX_H + SIB_GAP);
        nodes.push(Node {
            id: id.to_string(),
            kind: id.kind.name(),
            label: label_of(g, *id),
            x,
            y,
            w: BOX_W,
            h: BOX_H,
        });
        widest_rank = widest_rank.max(*row as i32 + 1);
    }

    let links = route::route(g, &nodes, &live);

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

// Routing lives in `route.rs` — `56` §3.2 phase 8 is an algorithm with a
// specification of its own, and it is long enough that leaving it here would
// bury the placement this file is about.
