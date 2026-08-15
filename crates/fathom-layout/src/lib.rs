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
//! it. Absent, in that document's terms: the aggregation stacks (§1.3), pins
//! and `LayoutHint` (§3.5), and the reth's two-layer treatment (§4.2). Each is
//! real work and each sits on top of this rather than replacing it.
//!
//! **Three of Sugiyama's phases are here.** Phases 4 and 5 — dummy nodes and
//! crossing reduction — are in [`order`], because ordering a rank by `NodeId`
//! is deterministic and arbitrary, and arbitrary means lines cross for no
//! reason. Phase 8 — orthogonal routing with a channel set per band — is in
//! [`route`], because without it every line between two ranks ran through one
//! midpoint and a dense estate drew as a single thick stroke.
//!
//! **The five layers of §4 are here too**, in [`layers`] — and they filter
//! AFTER layout, never before. `56` decides that layout is computed once over
//! the union of all layers so that toggling one never moves a box; laying out
//! per mask would make the picture jump under the reader, which is the most
//! likely way to get this feature wrong.
//!
//! §4's five layers ARE here, in [`layers`], and they are a filter over this
//! module's output rather than an input to it — `56` §3.6's DECISION, which is
//! that one layout is computed over the union of all layers so that a toggle
//! never moves anything. `lay_out` therefore takes no mask and must not grow
//! one.
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

pub mod agg;
pub mod layers;
pub mod order;
mod route;

use fathom_graph::{Graph, NodeId};

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
    /// How many graph nodes this box stands for. `1` is a plain box; anything
    /// higher is [`agg`]'s collapsed group and **the count must be drawn**
    /// (`59` §3.6, the silent count: *"a collapse that does not name what it
    /// hid and how many there were is a lie with fewer elements"*).
    ///
    /// `count == 1` is also what makes [`Node::id`] postable: a box standing
    /// for one node carries that node's own display id and a box standing for
    /// many carries a group key, and the two are never confused.
    pub count: usize,
    /// The aggregation group this box belongs to, or empty. See
    /// [`agg::Cell::group`] for the two forms and what each is for.
    pub group: String,
    /// True when [`Node::x`] and [`Node::y`] came from a person rather than from
    /// this crate — a live `LayoutPin` on the one node this box stands for
    /// (ADR-0035).
    ///
    /// **The page must draw the difference.** `56` §3.5 keeps layout computed and
    /// makes a hand position an *override*; a picture that mixed asserted and
    /// computed positions without saying which is which would be lying about the
    /// most load-bearing thing a diagram claims. This flag is how the page can
    /// tell, and it is on the box rather than inferred from the graph because the
    /// page never sees the graph.
    pub placed: bool,
    /// Edges with **both** ends inside this box, which are therefore drawn
    /// nowhere.
    ///
    /// Zero on a plain box, and normally zero on a collapsed one — two nodes
    /// joined by an edge usually get different signatures and split into
    /// different runs (see [`agg::Cell`]). A chain or a ring among like
    /// siblings does not, and then a collapse hides a *relationship* rather
    /// than a node. The box's own [`Node::count`] cannot say that, because it
    /// counts nodes, so this counts the lines and the page prints it. `59`'s
    /// governing rule is about what a collapse hid, not only about how many
    /// boxes it replaced.
    pub interior: u32,
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
    /// How many graph edges this one line stands for. `1` is a plain line.
    ///
    /// Higher only when an end was folded into a collapsed group, at which
    /// point forty edges become forty *coincident* strokes — the same defect
    /// `route` exists to remove, arriving from the other direction. `59`
    /// failure mode 16 is the picture that does not merge them: *"ten lines
    /// land on a stack that draws one stub."*
    pub members: usize,
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
    // Every node drawn as itself, which is what this function has always meant
    // and what `59` §3.7 keeps in the product as the `every one drawn` control
    // rather than only in the study: *"an engineer who does not believe the
    // count is entitled to see the forty."*
    lay_out_with(g, &agg::View::whole())
}

/// Lay the estate out under a view preference — which like-kind groups are
/// folded, and which of those the reader has opened.
///
/// One code path below [`agg::fold`], because the un-aggregated picture is the
/// aggregated one with every group of one: `fold` returns boxes, and ordering,
/// placement and routing all work on boxes without caring whether a box is one
/// node or forty. `59` failure mode 4 prices the second path.
pub fn lay_out_with(g: &Graph, view: &agg::View) -> Diagram {
    // Rank = depth in the containment forest. Derived from the schema's edge
    // classes rather than a hand-written table of kinds, so a schema change
    // moves the picture with no edit here.
    // `at` maps every live node to the box it is drawn in, in `NodeId` order. A
    // member of a collapsed group maps to the group's box, and that mapping is
    // the whole of what aggregation does to ordering and routing. A sorted
    // `Vec` rather than a `BTreeMap`: `order.rs` measured that map at 11,197
    // bytes of wasm.
    let (cells, at) = agg::fold(g, view);
    if cells.is_empty() {
        return Diagram::default();
    }

    // Order within a rank: `56` §3.2 phases 4 and 5, not the input order, which
    // is deterministic and arbitrary and made lines cross for no reason.
    let ordered = order::rows_for_cells(g, &cells, &at);

    let mut nodes: Vec<Node> = Vec::with_capacity(cells.len());
    let mut widest_rank: i32 = 0;
    for (cell, row) in cells.iter().zip(ordered.rows.iter()) {
        let x = MARGIN + (cell.rank as i32) * (BOX_W + RANK_GAP);
        let y = MARGIN + (*row as i32) * (BOX_H + SIB_GAP);
        // THE OVERRIDE, and it is the only place one is applied (ADR-0035).
        // Everything above ran exactly as it did before pins existed — the rank
        // walk, the crossing reduction, the row assignment — so an estate with no
        // pins lays out byte-identically to one from a build that had never heard
        // of them. A pin moves one box and changes nothing else, which is `56`
        // §3.5's second property ("I moved one box and the whole picture
        // rearranged") obtained by construction rather than by care.
        //
        // Only a box standing for ONE node can carry a position: `pin_of` is
        // asked for `cell.members` of length 1. A collapsed group stands for
        // forty nodes and there is no single element whose position it could be
        // — the same rule that makes `Cell::key` postable only at count 1.
        let pinned = match cell.members.as_slice() {
            [only] if cell.count() == 1 => pin_of(g, *only),
            _ => None,
        };
        let (x, y) = pinned.unwrap_or((x, y));
        nodes.push(Node {
            id: cell.key.clone(),
            kind: cell.kind,
            label: cell.label.clone(),
            x,
            y,
            w: BOX_W,
            h: BOX_H,
            count: cell.count(),
            group: cell.group.clone(),
            placed: pinned.is_some(),
            interior: 0,
        });
        widest_rank = widest_rank.max(*row as i32 + 1);
    }

    let (links, interior) = route::route(g, &nodes, &at);
    for (n, hidden) in nodes.iter_mut().zip(interior.iter()) {
        n.interior = *hidden;
    }

    // The canvas is the extent of what is drawn, and a placed box can be dragged
    // outside the grid the rank walk would have produced. Taking the max over
    // every box's far corner rather than computing the grid's own extent is what
    // stops a dragged box from being clipped by a viewBox that does not know it
    // moved. With no pins the two agree exactly, because the grid IS the extent
    // of the grid — `tests/layout.rs` pins that.
    let ranks = cells.last().map(|c| c.rank + 1).unwrap_or(0) as i32;
    let mut width = MARGIN * 2 + ranks * BOX_W + (ranks.saturating_sub(1)) * RANK_GAP;
    let mut height = MARGIN * 2 + widest_rank * BOX_H + (widest_rank.saturating_sub(1)) * SIB_GAP;
    for n in &nodes {
        width = width.max(n.x + n.w + MARGIN);
        height = height.max(n.y + n.h + MARGIN);
    }
    Diagram {
        width,
        height,
        nodes,
        links,
    }
}

/// Where a person put this node, if anybody did (ADR-0035).
///
/// A live `LayoutPin` contained by `id`, read through `HasLayoutPin`. `out` is
/// `0..1` in the schema, so at most one edge exists; the first live one is taken
/// and the loop stops, which is a total function even if a future writer
/// violated the bound.
///
/// Both coordinates are required — the schema declares each `card: "1"` — and a
/// pin missing one is treated as no pin at all rather than as a half-position.
/// Falling back to the computed coordinate for the missing axis would draw the
/// box somewhere nobody chose and mark it as chosen.
pub fn pin_of(g: &Graph, id: NodeId) -> Option<(i32, i32)> {
    use fathom_ir::bag::typed;
    use fathom_ir::generated::ir_types::LayoutPinField;

    let pin = g.node(pin_node(g, id)?)?;
    let (Ok(x), Ok(y)) = (
        typed::<i32, _>(pin, LayoutPinField::X.key()),
        typed::<i32, _>(pin, LayoutPinField::Y.key()),
    ) else {
        return None;
    };
    Some((*x, *y))
}

/// The live `LayoutPin` contained by `id`, if there is one.
///
/// The one place in the workspace that knows how a pin is attached. The writer
/// (`fathom_wasm`'s `OP_PLACE`) asks this before deciding whether to create a pin
/// or move the one that is there, so "a pin is a `LayoutPin` on the far end of a
/// live `HasLayoutPin`" is stated once and cannot drift between reader and
/// writer.
///
/// `HasLayoutPin` is `out: "0..1"`, so at most one such edge exists. The loop
/// takes the first live one and stops rather than asserting the bound: a total
/// function here is worth more than a panic that proves the store enforced its
/// own cardinality.
pub fn pin_node(g: &Graph, id: NodeId) -> Option<NodeId> {
    use fathom_ir::generated::ir_types::EdgeKind;

    g.out(id, EdgeKind::HasLayoutPin)
        .find(|e| e.absent_since.is_none())
        .map(|e| e.to)
        .filter(|to| g.node(*to).is_some_and(|n| n.absent_since.is_none()))
}

/// `56` §3.5's 4 px grid, applied in the core so every build agrees.
///
/// Rounds to the nearest multiple of 4, halves away from zero being irrelevant
/// because `div_euclid` is exact on integers and the same on every target
/// (invariant 9). Snapping in the page instead would put a rounding rule on the
/// one side of the boundary where nothing is checked, and two hosts that rounded
/// differently would store two different positions for the same gesture.
pub fn snap(v: i32) -> i32 {
    (v.saturating_add(2)).div_euclid(4).saturating_mul(4)
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
pub(crate) fn depth(g: &Graph, id: NodeId) -> u32 {
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

pub(crate) fn label_of(g: &Graph, id: NodeId) -> String {
    match fathom_inventory::element_page(g, id) {
        Some(p) if !p.name.is_empty() => p.name,
        _ => id.to_string(),
    }
}

// Routing lives in `route.rs` — `56` §3.2 phase 8 is an algorithm with a
// specification of its own, and it is long enough that leaving it here would
// bury the placement this file is about.
