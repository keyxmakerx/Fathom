//! Phases 4 and 5 of `56` §3.2: dummy nodes for edges that span more than one
//! rank, then a fixed-length barycentre sweep that reorders each rank so fewer
//! lines have to cross.
//!
//! # What this replaces
//!
//! Order within a rank used to be `NodeId` order — deterministic, and
//! arbitrary. Arbitrary is the problem: a zone whose members sit at the far end
//! of the next rank drags its lines across every other line in the band, and
//! the reader pays for an accident of ULID generation. This module puts each
//! rank in an order derived from where its neighbours already are, which is the
//! one thing `NodeId` order cannot know.
//!
//! # Determinism, which is the whole difficulty
//!
//! A barycentre sweep sorts by a computed mean and ties are the common case in
//! a small estate — two interfaces with one unit each have the same mean. Four
//! rules, each closing a way this could stop being a pure function of content:
//!
//! 1. **Every tie breaks on a total, content-derived key**: the vertex number.
//!    Real nodes are numbered in the caller's order, which `lay_out` sorts by
//!    `NodeId`, and dummies after them in the order of the edges that created
//!    them — so "lowest vertex number wins" *is* `56` §3.2 phase 5's "ties
//!    broken by `NodeId`", extended to cover dummies, which that line does not
//!    mention and which need an answer too. Sort stability is therefore never
//!    load-bearing: the comparator is a total order, so the result cannot
//!    depend on which sort algorithm ran.
//! 2. **A fixed sweep count, never "until stable".** `56` §3.2 phase 5 fixes it
//!    at eight, four down and four up, and `56` §11 row 4 names the defect an
//!    adaptive stop condition would introduce: two builds draw two pictures
//!    from one workspace and the export digest moves. Sweeps can also oscillate
//!    between two orderings of equal cost and never converge at all.
//! 3. **No floating point.** Barycentres are compared as exact rationals by
//!    cross-multiplication, so nothing rounds. Same reason the rest of the
//!    crate is integer: a picture that differs by a pixel between two machines
//!    is a diff nobody can explain.
//! 4. **No hash-ordered collection anywhere.** Vectors indexed by vertex, and
//!    one `BTreeMap` at the graph boundary (invariant 9).
//!
//! # Never worse than the order it replaces
//!
//! A fixed sweep count means the *last* pass is not necessarily the *best*
//! pass: passes 5 to 8 can hand back something worse than pass 4 did, and on a
//! shape with nothing to gain the sweep can leave the picture worse than it
//! found it. So crossings are counted after every pass and the best ordering
//! seen is the one returned — with the naive input order as the baseline that
//! has to be beaten. **The result can never have more crossings than the order
//! it replaced.** `crossings_before` and `crossings_after` are returned so a
//! test can hold it to that rather than take it on trust.
//!
//! # The median rule, which `56` §3.2 names and this does not implement
//!
//! `56` §3.2 phase 5 says *"median heuristic"*. The design prototype
//! (`design/prototype/fathom-app.html`) and Sugiyama's original use the
//! barycentre, and so does this. **That gap is real and is recorded here rather
//! than quietly reconciled.**
//!
//! It was built: both rules ran from the same start and whichever counted fewer
//! crossings won, which is better than either alone on some shapes. It came out
//! again for `44` §5.2's 900,000-byte module ceiling — the two-rule version
//! measured **909,779 bytes, 9,779 over**. Two honest qualifications on that
//! number: it was measured before `rows_for_graph` stopped using a
//! `BTreeMap<NodeId, u32>`, which turned out to be worth 11,197 bytes, so the
//! median could probably be afforded now; and the specific cost of the extra
//! `sort_unstable` instantiation a median needs was never isolated — the one
//! sort that remains measures 5,052 bytes, which is the closest thing to an
//! estimate anybody has. Adding it back is a measurement, not a guess, and the
//! ceiling question in `79-work-orders/00-ROUTE-TO-WORKABLE.md` §2 stage 1
//! should be settled before anyone spends the headroom on a second heuristic.
//!
//! The same ceiling took out three of the four sorts this module started with —
//! not inlined, *deleted*, because the orders they produced were already in
//! hand (see `reset` and `Layered::bands`).
//!
//! # What is deliberately not here
//!
//! - **Seeding from the previous layout's ordering** (`56` §3.5's mental-map
//!   fix). There is no previous ordering to seed from: `LayoutHint` and pins
//!   are unbuilt, so nothing persists between two runs. The seam is the `ranks`
//!   / `edges` signature — a caller that has a previous ordering can pass its
//!   nodes in that order and the sweep will start from it.
//! - **Space for dummies.** A dummy orders; it does not reserve a slot in the
//!   drawn picture, because this slice has no channel allocation (`56` §3.2
//!   phase 8) and a reserved slot with nothing routed through it is a gap the
//!   reader cannot account for.
//! - **Same-rank edges.** Two nodes in one rank cannot cross a rank boundary
//!   between them, so such an edge cannot take part in a bilayer crossing and
//!   is skipped here. It is still drawn — `lay_out`'s router has a detour for
//!   exactly that case.

use fathom_graph::{Graph, NodeId};
use fathom_ir::generated::ir_types::EdgeKind;

/// `56` §3.2 phase 5: four down, four up. Fixed, and not a tuning knob — see
/// rule 2 in the module docs.
const SWEEPS: u32 = 8;

/// What one ordering decided, and what it cost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    /// Row within its own rank for each input node, in input order. Rows in a
    /// rank are exactly `0..n` — dummies are not given rows, so the drawn
    /// picture has no gaps.
    pub rows: Vec<u32>,
    /// Crossings in the caller's input order, over the dummy-expanded layering.
    pub crossings_before: u64,
    /// Crossings in the returned order. Never greater than `crossings_before`.
    pub crossings_after: u64,
    /// How many dummies phase 4 inserted. Diagnostic: it is the quantity that
    /// says whether the sweep is doing real work or shuffling leaves.
    pub dummies: u32,
}

/// Order every rank.
///
/// `ranks[i]` is node `i`'s rank; `edges` are `(from, to)` pairs of indices
/// into `ranks`, and both directions are treated alike because a crossing does
/// not care which way a line points.
///
/// **The caller must pass nodes sorted by `(rank, NodeId)`**, which is what
/// `lay_out` already computes. That is what makes "ties break on the vertex
/// number" mean "ties break on `NodeId`" (`56` §3.2 phase 5). An unsorted list
/// is not an error and not a panic — it produces a layout whose ties break on
/// the caller's order instead, which is still deterministic and is simply not
/// the documented rule.
pub fn order(ranks: &[u32], edges: &[(u32, u32)]) -> Order {
    let mut layered = Layered::build(ranks, edges);
    let dummies = (layered.rank.len() - layered.reals) as u32;
    let before = layered.crossings();

    let mut best = layered.layers.clone();
    let mut best_crossings = before;
    for sweep in 0..SWEEPS {
        // Down, up, down, up … starting downward, because rank 0 is the one
        // rank that has nothing before it to be ordered against.
        layered.pass(sweep % 2 == 0);
        let now = layered.crossings();
        if now < best_crossings {
            best_crossings = now;
            best.clone_from(&layered.layers);
        }
    }

    Order {
        rows: rows_of(&best, layered.reals),
        crossings_before: before,
        crossings_after: best_crossings,
        dummies,
    }
}

/// Order the drawn nodes of an estate.
///
/// `live` is every drawn node in `NodeId` order and `ranked` is the same set in
/// `(rank, NodeId)` order — both of which `lay_out` has already built.
///
/// The edge walk is `lay_out`'s own: every effective edge of every non-root
/// containment kind, tombstones skipped, in `(node, kind, edge)` order. It is
/// walked twice per layout — once here and once by the router — rather than
/// shared, because the two want different things: this one wants indices into
/// the ranked list, the router wants placed boxes.
///
/// The `NodeId` → index lookup goes through a binary search of `live` rather
/// than a `BTreeMap<NodeId, u32>`, which is what this was written with and
/// reads better. The map costs **11,197 bytes of wasm** — measured 2026-08-15
/// by building the module both ways — against `44` §5.2's 900,000-byte ceiling,
/// which had 29,056 bytes left in it. Nearly two-fifths of a feature's budget
/// for a lookup an already-sorted slice does is not a trade worth making.
/// `live` is sorted because `lay_out` builds it by walking `NodeKind::ALL` and
/// `Graph::nodes_of_kind` is a range scan; `tests/order.rs` pins that, because
/// if it ever stopped being true this would silently drop edges rather than
/// fail.
pub(crate) fn rows_for_graph(g: &Graph, live: &[NodeId], ranked: &[(u32, NodeId)]) -> Order {
    let mut to_ranked: Vec<u32> = vec![0; live.len()];
    for (j, (_, id)) in ranked.iter().enumerate() {
        if let Ok(i) = live.binary_search(id) {
            if let Some(slot) = to_ranked.get_mut(i) {
                *slot = j as u32;
            }
        }
    }
    let ranks: Vec<u32> = ranked.iter().map(|(r, _)| *r).collect();

    let mut edges: Vec<(u32, u32)> = Vec::new();
    for (from, (_, id)) in ranked.iter().enumerate() {
        for kind in EdgeKind::ALL {
            if kind.root_containment() {
                continue;
            }
            for e in g.out(*id, kind) {
                if e.absent_since.is_some() {
                    continue;
                }
                // A tombstoned target is not in `live` and the search fails,
                // which drops the edge — the same answer the router reaches by
                // failing to find a box for it.
                if let Ok(i) = live.binary_search(&e.to) {
                    if let Some(to) = to_ranked.get(i) {
                        edges.push((from as u32, *to));
                    }
                }
            }
        }
    }
    order(&ranks, &edges)
}

/// The layering, with phase 4's dummies already in it.
///
/// Vertices are numbered: reals first, in the caller's order, then one dummy
/// per crossed rank per long edge. `reals` is the boundary between them and is
/// the only thing that distinguishes a dummy — a dummy is a vertex that gets no
/// row.
struct Layered {
    reals: usize,
    rank: Vec<u32>,
    /// Neighbours one rank lower / one rank higher. After phase 4 every edge
    /// spans exactly one rank, so these two are the whole adjacency. "Lower"
    /// is toward rank 0, which this layout draws to the left rather than above:
    /// the sweep is the textbook's, turned ninety degrees.
    prev: Vec<Vec<u32>>,
    next: Vec<Vec<u32>>,
    /// Span-1 segments grouped by band, indexed by the higher of the two ranks
    /// they join: `bands[r]` holds `(vertex at r-1, vertex at r)` pairs. Built
    /// grouped rather than built flat and sorted, because grouping is what the
    /// crossing count wants and a sort here would be a second `sort_unstable`
    /// instantiation for an order that costs nothing to keep.
    bands: Vec<Vec<(u32, u32)>>,
    layers: Vec<Vec<u32>>,
    /// Row of each vertex within its own rank. Kept in step with `layers`.
    pos: Vec<u32>,
}

impl Layered {
    fn build(ranks: &[u32], edges: &[(u32, u32)]) -> Layered {
        let reals = ranks.len();
        let mut rank: Vec<u32> = ranks.to_vec();
        let depth = ranks.iter().copied().max().map_or(0, |m| m as usize + 1);
        let mut bands: Vec<Vec<(u32, u32)>> = vec![Vec::new(); depth];

        for (a, b) in edges {
            let (Some(ra), Some(rb)) = (
                ranks.get(*a as usize).copied(),
                ranks.get(*b as usize).copied(),
            ) else {
                continue; // an index the caller gave no rank for
            };
            if ra == rb {
                continue; // see the module docs: cannot cross a band it never enters
            }
            let (lo, hi, r_lo, r_hi) = if ra < rb {
                (*a, *b, ra, rb)
            } else {
                (*b, *a, rb, ra)
            };
            // Phase 4. One dummy per crossed rank, chained, so a long edge
            // becomes a run of span-1 segments and phase 5 can see where it
            // passes rather than only where it ends.
            let mut prev_v = lo;
            for r in (r_lo + 1)..r_hi {
                let dummy = rank.len() as u32;
                rank.push(r);
                if let Some(band) = bands.get_mut(r as usize) {
                    band.push((prev_v, dummy));
                }
                prev_v = dummy;
            }
            if let Some(band) = bands.get_mut(r_hi as usize) {
                band.push((prev_v, hi));
            }
        }

        let n = rank.len();
        let mut prev: Vec<Vec<u32>> = vec![Vec::new(); n];
        let mut next: Vec<Vec<u32>> = vec![Vec::new(); n];
        for band in &bands {
            for (near, far) in band {
                if let Some(v) = next.get_mut(*near as usize) {
                    v.push(*far);
                }
                if let Some(v) = prev.get_mut(*far as usize) {
                    v.push(*near);
                }
            }
        }

        let mut layered = Layered {
            reals,
            rank,
            prev,
            next,
            bands,
            layers: vec![Vec::new(); depth],
            pos: vec![0; n],
        };
        layered.reset();
        layered
    }

    /// The starting order: vertices in vertex-number order, which is the
    /// caller's `NodeId` order for real nodes followed by dummies in the order
    /// of the edges that made them.
    ///
    /// No sort. Vertex numbers ascend as they are created, so pushing them into
    /// their layers in numeric order already produces that order — and a dummy
    /// of one edge is never in the same rank as another dummy of the same edge,
    /// so within a rank the dummies are in edge order too. Sorting would be
    /// several thousand bytes of wasm to reproduce a sequence already in hand.
    fn reset(&mut self) {
        for layer in &mut self.layers {
            layer.clear();
        }
        for (v, r) in self.rank.iter().enumerate() {
            if let Some(layer) = self.layers.get_mut(*r as usize) {
                layer.push(v as u32);
            }
        }
        for r in 0..self.layers.len() {
            self.sync(r);
        }
    }

    /// One sweep: every rank in turn, ordered against the rank the sweep came
    /// from.
    fn pass(&mut self, downward: bool) {
        let depth = self.layers.len();
        if downward {
            for r in 1..depth {
                self.reorder(r, true);
            }
        } else {
            for r in (0..depth.saturating_sub(1)).rev() {
                self.reorder(r, false);
            }
        }
    }

    /// Reorder one rank by where its neighbours in the reference rank sit.
    ///
    /// A vertex with no neighbour in that rank keeps its current row, which
    /// holds it where it is. The prototype sends it to the end of the rank
    /// instead (`bary = 1e9`); that is wrong here, because ranks come from the
    /// containment forest and a leaf with nothing beyond it is the common case,
    /// not the exception — sending every leaf to the end on every upward sweep
    /// would shuffle the picture for no gain.
    fn reorder(&mut self, r: usize, from_prev: bool) {
        let Some(layer) = self.layers.get(r) else {
            return;
        };
        if layer.len() < 2 {
            return;
        }
        // (sum of neighbour rows, how many) — the barycentre as an exact
        // rational, never divided out, plus the vertex number for the tie.
        let mut keyed: Vec<(u64, u64, u32)> = Vec::with_capacity(layer.len());
        for v in layer {
            let refs = if from_prev {
                self.prev.get(*v as usize)
            } else {
                self.next.get(*v as usize)
            };
            let (mut sum, mut count) = (0u64, 0u64);
            if let Some(refs) = refs {
                for n in refs {
                    sum += u64::from(self.row(*n));
                    count += 1;
                }
            }
            if count == 0 {
                sum = u64::from(self.row(*v));
                count = 1;
            }
            keyed.push((sum, count, *v));
        }
        keyed.sort_unstable_by(|a, b| {
            // a.0/a.1 against b.0/b.1 without dividing. Denominators are
            // neighbour counts and numerators are sums of row numbers, so both
            // products are far inside u64 at any picture a person can read.
            (a.0 * b.1).cmp(&(b.0 * a.1)).then_with(|| a.2.cmp(&b.2))
        });
        if let Some(layer) = self.layers.get_mut(r) {
            layer.clear();
            layer.extend(keyed.iter().map(|k| k.2));
        }
        self.sync(r);
    }

    /// Rewrite `pos` for one rank from `layers`.
    fn sync(&mut self, r: usize) {
        let (layers, pos) = (&self.layers, &mut self.pos);
        if let Some(layer) = layers.get(r) {
            for (row, v) in layer.iter().enumerate() {
                if let Some(slot) = pos.get_mut(*v as usize) {
                    *slot = row as u32;
                }
            }
        }
    }

    /// How many pairs of segments in the same band cross.
    ///
    /// Two segments cross exactly when their endpoints are in opposite orders
    /// in the two ranks — the standard bilayer count, which is a count over the
    /// *layering* and not a count of pixel intersections in the drawn picture.
    /// Segments sharing an endpoint never count, which is right: lines that
    /// meet at a box do not cross there.
    ///
    /// `O(k²)` per band, over segments rather than nodes, and it runs nine
    /// times per layout — once for the baseline and once after each pass. The
    /// alternative is inversion counting with a Fenwick tree at `O(k log k)`.
    /// It was not built, because the measurement said not to: **571 nodes, 740
    /// edges, 1.54 ms for the whole of phases 4 and 5 in a release build**
    /// (`tests/order.rs`, measured 2026-08-15), against `44` B12's 160 ms
    /// first-render budget — and `k` is bounded above by a product decision,
    /// since `44` §4.7.4 caps the picture at 2,000 live elements. Revisit when
    /// a measurement, not this comment, says to.
    fn crossings(&self) -> u64 {
        let mut total = 0u64;
        for band in &self.bands {
            for (i, (a_near, a_far)) in band.iter().enumerate() {
                let (ax, ay) = (self.row(*a_near), self.row(*a_far));
                for (b_near, b_far) in band.iter().skip(i + 1) {
                    let (bx, by) = (self.row(*b_near), self.row(*b_far));
                    if (ax < bx && ay > by) || (ax > bx && ay < by) {
                        total += 1;
                    }
                }
            }
        }
        total
    }

    fn row(&self, v: u32) -> u32 {
        self.pos.get(v as usize).copied().unwrap_or(0)
    }
}

/// Rows for the real nodes only: a dummy is skipped and takes no row with it,
/// so every rank is numbered `0..n` with no gap where a dummy stood.
fn rows_of(layers: &[Vec<u32>], reals: usize) -> Vec<u32> {
    let mut rows = vec![0u32; reals];
    for layer in layers {
        let mut row = 0u32;
        for v in layer {
            if (*v as usize) < reals {
                if let Some(slot) = rows.get_mut(*v as usize) {
                    *slot = row;
                }
                row += 1;
            }
        }
    }
    rows
}
