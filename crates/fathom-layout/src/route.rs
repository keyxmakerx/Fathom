//! Orthogonal edge routing, with a channel per line.
//!
//! `56` §3.2 phase 8, in full: *"Orthogonal; each inter-layer band is a channel
//! set, allocated by interval-graph greedy colouring"*, with edges sorted by
//! `(from rank, from x, EdgeId)`. That is what this file is.
//!
//! # The defect it removes
//!
//! Before this, every line crossing a band ran through the same midpoint x. Two
//! lines between the same pair of ranks therefore shared their whole vertical
//! run — not crossed, *coincided* — so a device with ten interfaces drew ten
//! containment lines as one thick stroke, and the picture said "one link" where
//! the graph said ten. Crossings are unavoidable in a drawing of a network and
//! are readable; coincident strokes are neither.
//!
//! # The transposition, stated once
//!
//! `56` draws layers as rows stacked down the page, so its bands are horizontal
//! and its within-layer coordinate is x. [`crate::lay_out`] draws ranks as
//! columns running left to right, so every axis in that sentence swaps: a band
//! is the vertical strip between two ranks, a channel is a vertical line at a
//! distinct x inside it, and the spec's *"from x"* — the source's position along
//! its own layer — is the source's **y** here. The algorithm is the document's,
//! unchanged; only the names of the axes move.
//!
//! # Why interval colouring, and what it does and does not promise
//!
//! Two lines can share one channel exactly when their vertical runs do not
//! touch, which makes the conflict relation an interval graph and the allocation
//! a graph colouring. Greedy — take the lowest channel no conflicting line
//! already holds — is the whole algorithm, and it is enough: it is `O(E·C)` with
//! no solver, no floats and no tie-breaking beyond the order the document fixes.
//!
//! What it promises is that **no two lines whose vertical runs meet are drawn on
//! the same x**. What it does not promise is the *fewest* channels: greedy is
//! exactly optimal on an interval graph only when the intervals are fed to it in
//! order of their low end, and `56` fixes a different order (the source's
//! position along its rank). Feeding it low-end order was considered and
//! rejected — the processing order is observable in the picture, so it is the
//! specification's to choose, not the implementer's, and the cost of obeying it
//! is at worst a few extra channels in one band, never a wrong drawing.
//!
//! # What is still missing
//!
//! An edge spanning more than one rank gets its vertical run in the first band
//! it enters and then a long horizontal that crosses whatever boxes lie in its
//! way. That is `56` §3.2 phase 4's dummy nodes, which are a separate slice; the
//! naive router had the same hole in a worse place (the vertical ran through the
//! middle of the intervening rank rather than beside it).
//!
//! Channels are spaced evenly inside a band whose width `lay_out` owns, so a
//! band needing thirty channels packs them into the same `RANK_GAP` as a band
//! needing one. The alternative — widen the band to fit its channels — was
//! rejected here because it moves every box to the right of the busiest band,
//! which is `lay_out`'s decision to make and `56` §3.5's mental-map argument to
//! answer, not a router's.
//!
//! That leaves a hard ceiling, and it is named rather than hidden: coordinates
//! are integers, so a band holds at most `RANK_GAP - 1` distinct channels and
//! above that two of them round onto the same x and coincide again. Ninety lines
//! across one band is a picture that has already failed, and `59` §3.1 has the
//! answer to it: like-kind sibling aggregation, *"a transform on the model, run
//! before layout"*, which hands this file a smaller graph and leaves it
//! unmodified. Widening the band would not have fixed it either. But a router
//! that pretended it had no ceiling would be lying, so the number is written
//! down.

use fathom_graph::{EdgeId, Graph, NodeId, Origin};
use fathom_ir::generated::ir_types::{EdgeClass, EdgeKind, NodeKind};

use crate::{Link, Node, RANK_GAP};

/// One edge that is going to be drawn, resolved to geometry.
struct Pending<'a> {
    a: &'a Node,
    b: &'a Node,
    id: EdgeId,
    kind: &'static str,
    /// True when a person drew this line rather than a parser reading it out of
    /// a capture. See [`Link::hand`].
    hand: bool,
    containment: bool,
    /// x of the band's left wall — the right face of the leftmost of the two
    /// ranks the line touches.
    ///
    /// This, and not `56`'s *"from rank"*, is the group key, because a
    /// right-to-left edge crosses the band to the **left** of its source. Group
    /// those with the source's own band and two lines in one band can be handed
    /// the same channel by two different colourings, which is the exact defect
    /// this file exists to remove.
    wall: i32,
    /// The closed interval the vertical run covers, or `None` for a line that
    /// has no vertical run at all: two boxes in different ranks at the same
    /// height are joined by one straight segment, which cannot collide with a
    /// channel because it does not occupy one.
    span: Option<(i32, i32)>,
    /// The channel index inside the band. Meaningless while `span` is `None`.
    slot: usize,
    /// How many graph edges this one line stands for. Above 1 only after a
    /// node collapse merged coincident strokes — see [`route`].
    members: usize,
    /// True for a line derived from a `Cable`, never a graph edge — see
    /// [`crate::Link::cable`].
    cable: bool,
}

fn centre(n: &Node) -> i32 {
    n.y + n.h / 2
}

fn resolve<'a>(a: &'a Node, b: &'a Node, id: EdgeId, kind: EdgeKind, hand: bool) -> Pending<'a> {
    let (ay, by) = (centre(a), centre(b));
    let left = if a.x <= b.x { a } else { b };
    Pending {
        a,
        b,
        id,
        kind: kind.name(),
        hand,
        containment: kind.class() == EdgeClass::Containment,
        wall: left.x + left.w,
        // Two boxes in the same rank are stacked, so both ends leave the same
        // (right) face and the line must detour through a channel however
        // little height it covers. Only a line that faces its target across a
        // band can be straight.
        span: if a.x != b.x && ay == by {
            None
        } else {
            Some((ay.min(by), ay.max(by)))
        },
        slot: 0,
        members: 1,
        cable: false,
    }
}

/// A device-to-device line derived from a two-ended `Cable`, never a graph
/// edge itself (ADR-0038 D10). Built directly rather than through
/// [`resolve`] because there is no [`EdgeKind`] to name: the line stands for
/// `Cable -> Terminates -> PhysicalPort -> (owning Chassis) -> (owning
/// Device)`, four hops and a node, not one edge.
fn resolve_cable<'a>(a: &'a Node, b: &'a Node, id: EdgeId, hand: bool) -> Pending<'a> {
    let (ay, by) = (centre(a), centre(b));
    let left = if a.x <= b.x { a } else { b };
    Pending {
        a,
        b,
        id,
        kind: "Cable",
        hand,
        containment: false,
        wall: left.x + left.w,
        span: if a.x != b.x && ay == by {
            None
        } else {
            Some((ay.min(by), ay.max(by)))
        },
        slot: 0,
        members: 1,
        cable: true,
    }
}

/// Did a person DRAW this line, as opposed to a parser reading it out of a
/// capture or the weld deriving it?
///
/// Two conditions, and the second one is a judgement worth stating.
///
/// `Origin::Hand` is the obvious half. The other half is **reference only**, and
/// the reason is that a containment edge is nobody's drawing. `HasChassis`
/// exists because `OP_EQUIP_ADD` made a chassis; its kind was computed from the
/// (owner, child) pair by `fathom_weld::containment_edge` and no human chose it.
/// Its provenance is `Origin::Hand` — truthfully, because a person's gesture
/// caused it — so a test that asked only about origin would mark every line in a
/// hand-built estate, which was measured in the browser: two hand-typed devices
/// and one drawn link produced **three** marked strokes, of which two said
/// nothing a reader could use.
///
/// The mark answers *"who says these two are connected"*, and that question only
/// has a contested answer for a **relationship** — `class: reference`, the same
/// class `fathom_weld::hand_link_candidates` is the only one to offer. Structure
/// is not a claim anybody disputes.
///
/// The rejected alternative was to mark every `Origin::Hand` edge and accept the
/// noise as the price of honesty. It is not honesty: a mark that appears on
/// every line in a hand-built estate carries no information, and `59`'s own rule
/// is that a signal which stops distinguishing has stopped being a signal.
fn hand_drawn(g: &Graph, e: &fathom_graph::Edge, kind: EdgeKind) -> bool {
    kind.class() == EdgeClass::Reference
        && matches!(
            g.provenance(e.prov).map(|p| p.origin),
            Some(fathom_graph::Origin::Hand)
        )
}

/// Closed intervals: two runs that meet at a single y still meet. Treating a
/// shared endpoint as free would draw two lines as one continuous stroke through
/// the box they share, which reads as a bus and is the misreading this whole
/// file is about.
fn disjoint(p: (i32, i32), q: (i32, i32)) -> bool {
    p.1 < q.0 || q.1 < p.0
}

/// Greedy interval-graph colouring over one band, in the order the slice is
/// already in. Returns how many channels the band ended up needing.
///
/// Placed runs are held flat as `(slot, lo, hi)` rather than as a `Vec` per
/// channel. A `Vec<Vec<_>>` would read better and costs an allocation and its
/// drop glue per channel for a scan that is linear either way — and this crate
/// compiles into a module with a byte ceiling (`44` §5.2), where a nicer shape
/// that nobody can see is not worth a page of code.
fn allocate(band: &mut [Pending<'_>]) -> usize {
    let mut held: Vec<(usize, i32, i32)> = Vec::new();
    let mut count = 0;
    for e in band.iter_mut() {
        let Some(span) = e.span else { continue };
        let mut slot = 0;
        while slot < count
            && !held
                .iter()
                .all(|&(s, lo, hi)| s != slot || disjoint(span, (lo, hi)))
        {
            slot += 1;
        }
        if slot == count {
            count += 1;
        }
        held.push((slot, span.0, span.1));
        e.slot = slot;
    }
    count
}

/// Where channel `slot` of `count` sits inside the band whose left wall is at
/// `wall`.
///
/// Evenly spaced rather than on a fixed pitch, because the band's width is
/// `RANK_GAP` and the router does not get to change it: whatever the estate
/// needs has to fit in what it is given. With one channel this is the exact
/// midpoint the naive router used, so a sparse picture is unchanged by this
/// file and only a crowded one moves.
fn channel_x(wall: i32, slot: usize, count: usize) -> i32 {
    // Both are bounded by the number of drawn edges, so a value that did not
    // fit an i32 would be a graph that did not fit the machine.
    let (slot, count) = (slot as i32, count as i32);
    wall + (RANK_GAP * (slot + 1)) / (count + 1)
}

fn shape(e: &Pending<'_>, x: i32) -> Vec<(i32, i32)> {
    let (a, b) = (e.a, e.b);
    let (ay, by) = (centre(a), centre(b));
    if a.x == b.x {
        // Same rank: no facing pair to join, so leave both right faces and turn
        // in the channel beside the rank. A straight line between them would be
        // DIAGONAL, which this routing does not do and which the orthogonality
        // test catches.
        return vec![(a.x + a.w, ay), (x, ay), (x, by), (b.x + b.w, by)];
    }
    let (start, end) = if a.x < b.x {
        ((a.x + a.w, ay), (b.x, by))
    } else {
        ((a.x, ay), (b.x + b.w, by))
    };
    if ay == by {
        return vec![start, end];
    }
    vec![start, (x, start.1), (x, end.1), end]
}

/// Route every effective edge between two drawn boxes.
///
/// `at` maps every live node to the box it is drawn in, so an edge whose end
/// was folded into a collapsed group terminates on the group. Returns the lines
/// and, parallel to `nodes`, how many edges each box swallowed whole.
///
/// # What merges, and the one thing that deliberately does not
///
/// **Lines onto a collapsed group merge.** After a node collapse, forty edges
/// that went to forty different boxes go to one, and they are then not forty
/// lines — they are one line drawn forty times, coincident, which is the exact
/// defect this file's own header says it exists to remove. They become one line
/// carrying the cardinal (`Link::members`), which is `59` failure mode 16's
/// fix: *"ten lines land on a stack that draws one stub."*
///
/// **Parallel edges between two plain boxes do not merge.** Ten standalone
/// `Link`s between one pair of devices stay ten lines, each with its own
/// channel. That is `59` §3.14 — a **PROPOSED** sixth aggregation level, with
/// its own mark (three rails), its own terminals and its own grouping key, and
/// §3.14.2's rule that *"any channel that differs splits the group"*. Merging
/// them here would ship that proposal early, in a form that asserts a bundle
/// the estate may not have (failure mode 15), and it would change `lay_out`'s
/// output in a way nobody asked for. The condition is therefore *"at least one
/// end is a group"*, and it is the only reason this function knows about
/// aggregation at all.
pub(crate) fn route(g: &Graph, nodes: &[Node], at: &[(NodeId, usize)]) -> (Vec<Link>, Vec<u32>) {
    let box_of = |n: NodeId| -> Option<usize> {
        let i = at.binary_search_by_key(&n, |(k, _)| *k).ok()?;
        at.get(i).map(|(_, b)| *b)
    };
    let mut interior: Vec<u32> = vec![0; nodes.len()];
    let mut pending: Vec<Pending<'_>> = Vec::new();
    // The already-merged group lines, as `(from box, to box, kind, index into
    // pending)`. A linear scan of this and not a sorted key set: it holds one
    // entry per *distinct* line touching a collapsed box, which aggregation
    // keeps small by construction — that is what aggregation is — and a second
    // `sort_unstable` instantiation measures about 5 KB of wasm (`order.rs`).
    let mut merged: Vec<(usize, usize, EdgeKind, usize)> = Vec::new();
    for (from, _) in at {
        for kind in EdgeKind::ALL {
            if kind.root_containment() {
                continue;
            }
            for e in g.out(*from, kind) {
                if e.absent_since.is_some() {
                    continue;
                }
                let (Some(ai), Some(bi)) = (box_of(*from), box_of(e.to)) else {
                    continue;
                };
                if ai == bi {
                    // Both ends inside one collapsed box. There is no line to
                    // draw between a box and itself — but something WAS hidden,
                    // and `Node::count` counts nodes, not relationships, so it
                    // is counted here and the page says so.
                    if let Some(slot) = interior.get_mut(ai) {
                        *slot += 1;
                    }
                    continue;
                }
                let (Some(a), Some(b)) = (nodes.get(ai), nodes.get(bi)) else {
                    continue;
                };
                if a.count > 1 || b.count > 1 {
                    if let Some((_, _, _, p)) = merged
                        .iter()
                        .find(|(x, y, k, _)| *x == ai && *y == bi && *k == kind)
                    {
                        if let Some(line) = pending.get_mut(*p) {
                            line.members += 1;
                            // A merged stroke is hand-drawn only when EVERY edge
                            // under it is. A line standing for forty edges of
                            // which one was drawn by a person is not a
                            // hand-drawn line, and marking it as one is the same
                            // silent-count failure `59` files against a collapse
                            // that does not say what it hid.
                            line.hand &= hand_drawn(g, e, kind);
                        }
                        continue;
                    }
                    merged.push((ai, bi, kind, pending.len()));
                }
                pending.push(resolve(a, b, e.id, kind, hand_drawn(g, e, kind)));
            }
        }
    }

    // Cable lines, ADR-0038 D10. Not reached by the loop above: `Cable` is not
    // a box `at` maps (it is laid out nowhere of its own — `layers.rs`'s
    // "drawn everywhere and counted" bucket), so its `Terminates` edges are
    // never `g.out(*from, kind)` for any `from` in `at`. Derived here instead,
    // one line per two-ended cable, walking the four hops down to the boxes
    // that ARE drawn.
    //
    // **Not folded into the collapsed-group merge above.** A cable converging
    // on a collapsed group therefore draws its own channel rather than one
    // merged stroke with a count — a real gap against `59`'s coincident-stroke
    // rule, filed rather than silently accepted: `NodeKind::Cable` carries no
    // `EdgeKind` the `merged` bookkeeping's key can hold, and folding it in
    // would mean inventing one. A one-ended cable (`Terminates.out: "0..2"`,
    // an unknown far end) derives no line, by construction: `ports.len() < 2`
    // never reaches `resolve_cable`.
    for c in g.nodes_of_kind(NodeKind::Cable) {
        if c.absent_since.is_some() {
            continue;
        }
        let mut ports: Vec<(NodeId, EdgeId)> = Vec::new();
        for e in g.out(c.id, EdgeKind::Terminates) {
            if e.absent_since.is_none() {
                ports.push((e.to, e.id));
            }
        }
        let (Some(&(p1, id1)), Some(&(p2, _))) = (ports.first(), ports.get(1)) else {
            continue;
        };
        let (Some(d1), Some(d2)) = (g.device_of(p1), g.device_of(p2)) else {
            continue;
        };
        let (Some(ai), Some(bi)) = (box_of(d1), box_of(d2)) else {
            continue;
        };
        if ai == bi {
            // Both ports land in one box (a patch lead within one device, or
            // both devices folded into one collapsed group). No line to draw
            // between a box and itself, and something WAS hidden — counted
            // exactly as the same-box arm above counts it.
            if let Some(slot) = interior.get_mut(ai) {
                *slot += 1;
            }
            continue;
        }
        let (Some(a), Some(b)) = (nodes.get(ai), nodes.get(bi)) else {
            continue;
        };
        let hand = matches!(
            g.provenance(c.existence).map(|p| p.origin),
            Some(Origin::Hand)
        );
        pending.push(resolve_cable(a, b, id1, hand));
    }

    // `56` §3.2 phase 8's order, transposed: band, then the source's position
    // along its own rank, then `EdgeId` — which the store carries per edge
    // (ADR-0007), so the document's tie-break is available literally rather
    // than approximated. Unstable is safe here and stable is not free: `EdgeId`
    // alone is unique, so the key is total and there is no tie for stability to
    // break. That is what makes the colouring a pure function of the graph
    // rather than of the walk that found the edges (invariant 9).
    pending.sort_unstable_by(|p, q| (p.wall, p.a.y, p.id).cmp(&(q.wall, q.a.y, q.id)));

    // Sorted by band, so each band is a contiguous run and the allocator gets a
    // slice rather than a map keyed by wall.
    let mut links: Vec<Link> = Vec::with_capacity(pending.len());
    let mut rest: &mut [Pending<'_>] = &mut pending;
    while let Some(wall) = rest.first().map(|p| p.wall) {
        let n = rest.iter().take_while(|p| p.wall == wall).count();
        let (band, tail) = rest.split_at_mut(n);
        let count = allocate(band);
        for e in band.iter() {
            links.push(Link {
                from: e.a.id.clone(),
                to: e.b.id.clone(),
                kind: e.kind,
                hand: e.hand,
                containment: e.containment,
                cable: e.cable,
                members: e.members,
                points: shape(e, channel_x(e.wall, e.slot, count)),
            });
        }
        rest = tail;
    }

    // Paint order is a separate question from channel order, and it is settled
    // the same way: a total order that does not depend on iteration, so the
    // picture is the same every time it is drawn.
    links.sort_by(|x, y| {
        (x.from.as_str(), x.to.as_str(), x.kind).cmp(&(y.from.as_str(), y.to.as_str(), y.kind))
    });
    (links, interior)
}
