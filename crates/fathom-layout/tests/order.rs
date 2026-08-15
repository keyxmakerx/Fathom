//! Crossing reduction (`56` §3.2 phases 4 and 5): is it still deterministic,
//! and does the picture actually get better?
//!
//! Both halves matter and only one of them is obvious. A sweep that reduces
//! crossings but reorders a rank differently on two machines has broken
//! invariant 9 and made the diagram useless in a change ticket, which is the
//! thing it exists for. A sweep that is perfectly deterministic and reduces
//! nothing has added cost for nothing. So every fixture here is asserted twice.

use std::collections::BTreeMap;
use std::time::Instant;

use fathom_graph::{
    Actor, BatchId, Confidence, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord, Timestamp,
    UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};
use fathom_layout::order::order;

// ---------------------------------------------------------------------------
// Fixtures stated as bare layerings, so the algorithm can be held to account
// without a graph in the way.
// ---------------------------------------------------------------------------

/// Two ranks of `k`, wired straight across but in reverse: node `i` of rank 0
/// joins node `k-1-i` of rank 1. Every pair of lines crosses, so the naive
/// order costs `k(k-1)/2` crossings and a correct sweep costs none.
fn reversed_bipartite(k: u32) -> (Vec<u32>, Vec<(u32, u32)>) {
    let ranks: Vec<u32> = (0..k).map(|_| 0).chain((0..k).map(|_| 1)).collect();
    let edges: Vec<(u32, u32)> = (0..k).map(|i| (i, k + (k - 1 - i))).collect();
    (ranks, edges)
}

/// A deterministic pseudo-random layering: `ranks` layers of `width`, each node
/// wired to two nodes in the next rank. The generator is a plain LCG with a
/// fixed seed — this is a test, so the numbers only have to be arbitrary and
/// repeatable, and repeatable is the half that matters.
fn scrambled(ranks_n: u32, width: u32, seed: u64) -> (Vec<u32>, Vec<(u32, u32)>) {
    let mut state = seed;
    let mut next = || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        (state >> 33) as u32
    };
    let ranks: Vec<u32> = (0..ranks_n)
        .flat_map(|r| (0..width).map(move |_| r))
        .collect();
    let mut edges = Vec::new();
    for r in 0..ranks_n.saturating_sub(1) {
        for i in 0..width {
            for _ in 0..2 {
                edges.push((r * width + i, (r + 1) * width + next() % width));
            }
        }
    }
    (ranks, edges)
}

// ---------------------------------------------------------------------------
// Phase 4 — dummies
// ---------------------------------------------------------------------------

/// `56` §3.2 phase 4: one dummy per *crossed* rank, so an edge from rank 0 to
/// rank 3 gets two and an edge to the adjacent rank gets none.
#[test]
fn one_dummy_per_crossed_rank() {
    assert_eq!(order(&[0, 3], &[(0, 1)]).dummies, 2);
    assert_eq!(order(&[0, 1], &[(0, 1)]).dummies, 0);
    assert_eq!(order(&[0, 4], &[(0, 1)]).dummies, 3);
    // Direction is irrelevant: a line crosses the same ranks either way.
    assert_eq!(order(&[0, 3], &[(1, 0)]).dummies, 2);
    // A same-rank edge crosses nothing, so it gets nothing.
    assert_eq!(order(&[2, 2], &[(0, 1)]).dummies, 0);
}

/// A long edge must pull the ranks it passes through, or dummies were inserted
/// and then ignored. Rank 1 here holds one node wired to nothing, plus the
/// dummy of the long edge; the long edge's far end must not be dragged to the
/// wrong end of rank 2.
#[test]
fn a_long_edge_orders_the_ranks_it_passes_through() {
    // rank 0: 0, 1     rank 1: 2, 3      rank 2: 4, 5
    // 0 → 5 spans two ranks; 1 → 2 → 4 is a chain through rank 1.
    let ranks = [0, 0, 1, 1, 2, 2];
    let edges = [(0, 5), (1, 2), (2, 4)];
    let out = order(&ranks, &edges);
    assert_eq!(out.dummies, 1, "the span-2 edge gets exactly one dummy");
    assert!(
        out.crossings_after <= out.crossings_before,
        "{} → {}",
        out.crossings_before,
        out.crossings_after
    );
}

// ---------------------------------------------------------------------------
// Phase 5 — the sweep
// ---------------------------------------------------------------------------

/// The point of the exercise. Eight lines that all cross each other cost 28
/// crossings in `NodeId` order and none once the rank is sorted by where its
/// neighbours are.
#[test]
fn crossings_go_down_versus_the_naive_order() {
    let (ranks, edges) = reversed_bipartite(8);
    let out = order(&ranks, &edges);
    assert_eq!(
        out.crossings_before, 28,
        "8 reversed lines cross 8·7/2 times"
    );
    assert_eq!(out.crossings_after, 0, "and a correct sweep untangles them");
    assert!(out.crossings_after < out.crossings_before);
}

/// The property that makes the cost defensible: whatever the shape, the
/// ordering handed back is never worse than the one it replaced. Held over
/// twelve unrelated layerings rather than one, because "never" is the claim.
#[test]
fn the_result_is_never_worse_than_the_naive_order() {
    for seed in 0..12u64 {
        let (ranks, edges) = scrambled(5, 7, 1 + seed * 7919);
        let out = order(&ranks, &edges);
        assert!(
            out.crossings_after <= out.crossings_before,
            "seed {seed}: {} crossings became {}",
            out.crossings_before,
            out.crossings_after
        );
    }
}

/// On a shape with crossings to remove, at least one of the twelve must
/// actually improve — otherwise the previous test passes on a sweep that does
/// nothing at all, which is the failure it cannot see.
#[test]
fn the_sweep_improves_a_scrambled_layering() {
    let improved = (0..12u64)
        .filter(|seed| {
            let (ranks, edges) = scrambled(5, 7, 1 + seed * 7919);
            let out = order(&ranks, &edges);
            out.crossings_after < out.crossings_before
        })
        .count();
    assert!(
        improved >= 10,
        "only {improved} of 12 scrambled layerings improved"
    );
}

/// Every rank is numbered `0..n` exactly once. A repeated row stacks two boxes
/// on the same pixel; a skipped row is a gap the reader cannot account for,
/// which is what would happen if a dummy were given a row of its own.
#[test]
fn every_rank_is_numbered_without_gap_or_repeat() {
    let (ranks, edges) = scrambled(6, 9, 42);
    let out = order(&ranks, &edges);
    let mut by_rank: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for (r, row) in ranks.iter().zip(out.rows.iter()) {
        by_rank.entry(*r).or_default().push(*row);
    }
    for (rank, mut rows) in by_rank {
        let n = rows.len() as u32;
        rows.sort_unstable();
        assert_eq!(
            rows,
            (0..n).collect::<Vec<u32>>(),
            "rank {rank} is not a permutation of its rows"
        );
    }
}

/// **Invariant 9.** Same layering in, same ordering out — and the sweep sorts
/// by a computed mean, where ties are the common case, so this is the assertion
/// the whole design of the tie-break exists to pass.
#[test]
fn the_same_layering_orders_identically() {
    let (ranks, edges) = scrambled(6, 9, 99);
    assert_eq!(order(&ranks, &edges), order(&ranks, &edges));

    // And the ties are real: a fixture where every node in a rank has the same
    // barycentre, so nothing but the tie-break decides the order.
    let ranks = [0, 1, 1, 1, 1];
    let edges = [(0, 1), (0, 2), (0, 3), (0, 4)];
    let out = order(&ranks, &edges);
    assert_eq!(
        out.rows,
        vec![0, 0, 1, 2, 3],
        "ties fall back to input order"
    );
    assert_eq!(out, order(&ranks, &edges));
}

/// An edge between two nodes of one rank cannot cross a rank boundary, so it
/// must not perturb the ordering — and must not panic either.
#[test]
fn a_same_rank_edge_changes_nothing() {
    let ranks = [0, 0, 0];
    let edges = [(0, 1), (1, 2)];
    let out = order(&ranks, &edges);
    assert_eq!(out.rows, vec![0, 1, 2]);
    assert_eq!(out.crossings_before, 0);
    assert_eq!(out.crossings_after, 0);
}

/// Degenerate inputs draw nothing rather than fall over.
#[test]
fn nothing_in_nothing_out() {
    let empty = order(&[], &[]);
    assert!(empty.rows.is_empty());
    assert_eq!(empty.crossings_before, 0);
    // An edge naming a node that is not in the layering is dropped, not
    // followed: the caller filtered tombstones and this must survive it.
    let out = order(&[0, 1], &[(0, 9)]);
    assert_eq!(out.rows, vec![0, 0]);
}

// ---------------------------------------------------------------------------
// The same thing, against a real estate
// ---------------------------------------------------------------------------

const AT: u64 = 1_786_147_200_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

fn prov(n: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(9_000_000 + n)),
        origin: Origin::Hand,
        asserted_at: Timestamp(AT),
        asserted_by: Actor::User(UserId(ulid(u128::MAX))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

struct Builder {
    g: Graph,
    n: u128,
}

impl Builder {
    fn new(label: &str) -> Builder {
        let mut g = Graph::new();
        g.begin_batch(BatchId(ulid(0)), label).expect("open");
        Builder { g, n: 1 }
    }
    fn node(&mut self, kind: NodeKind) -> NodeId {
        self.n += 1;
        let n = self.n;
        self.g
            .insert_node(kind, ulid(n), prov(n))
            .expect("bare node")
    }
    fn edge(&mut self, kind: EdgeKind, from: NodeId, to: NodeId) {
        self.n += 1;
        let n = self.n;
        self.g
            .insert_edge(kind, ulid(n), from, to, prov(n))
            .expect("edge");
    }
}

/// One device, `k` interfaces each carrying a unit, and `k` zones whose
/// membership runs backwards: zone `i` holds the unit of interface `k-1-i`.
///
/// This is the shape the naive order is worst at and it is not contrived — a
/// zone is a *set* (`56` §4.4) and nothing makes its ULID order agree with the
/// ULID order of the units it holds. In `NodeId` order every membership line
/// crosses every other one.
fn crossed_estate(k: u128) -> (Graph, Vec<NodeId>, Vec<NodeId>) {
    let mut b = Builder::new("crossed");
    let device = b.node(NodeKind::Device);
    let mut units = Vec::new();
    for _ in 0..k {
        let iface = b.node(NodeKind::Interface);
        b.edge(EdgeKind::HasInterface, device, iface);
        let unit = b.node(NodeKind::LogicalUnit);
        b.edge(EdgeKind::HasUnit, iface, unit);
        units.push(unit);
    }
    let mut zones = Vec::new();
    for i in 0..k as usize {
        let zone = b.node(NodeKind::Zone);
        b.edge(EdgeKind::HasZone, device, zone);
        let unit = *units.get(k as usize - 1 - i).expect("unit");
        b.edge(EdgeKind::ZoneMember, zone, unit);
        zones.push(zone);
    }
    b.g.end_batch().expect("close");
    (b.g, zones, units)
}

fn box_of(d: &fathom_layout::Diagram, id: NodeId) -> &fathom_layout::Node {
    let want = id.to_string();
    d.nodes.iter().find(|n| n.id == want).expect("a drawn box")
}

/// End to end, through `lay_out`: the zone that holds the topmost unit is drawn
/// topmost. In `NodeId` order the zones ran the other way and every membership
/// line crossed every other one.
#[test]
fn the_estate_draws_zones_in_the_order_of_their_members() {
    let (g, zones, units) = crossed_estate(6);
    let d = fathom_layout::lay_out(&g);

    let zone_y: Vec<i32> = zones.iter().map(|z| box_of(&d, *z).y).collect();
    let member_y: Vec<i32> = units
        .iter()
        .rev()
        .map(|u| box_of(&d, *u).y)
        .collect::<Vec<i32>>();

    let ordered_by_zone = {
        let mut v: Vec<(i32, i32)> = zone_y
            .iter()
            .copied()
            .zip(member_y.iter().copied())
            .collect();
        v.sort_unstable();
        v
    };
    let mut previous = i32::MIN;
    for (zy, my) in &ordered_by_zone {
        assert!(
            *my > previous,
            "zone at y={zy} holds a member at y={my}, out of order with the zone above it"
        );
        previous = *my;
    }
}

/// **Invariant 9 through the whole layout**, on the estate that exercises the
/// sweep hardest. `tests/layout.rs` pins this for the pasted fixture; this pins
/// it for a graph where the ordering has real work to do.
#[test]
fn a_crossing_heavy_estate_lays_out_identically() {
    let (a, _, _) = crossed_estate(9);
    let (b, _, _) = crossed_estate(9);
    assert_eq!(fathom_layout::lay_out(&a), fathom_layout::lay_out(&b));
}

/// Boxes must still not overlap once the rows have been reordered — the same
/// property `tests/layout.rs` pins for the pasted estate, checked on the one
/// the sweep actually moves.
#[test]
fn reordered_boxes_still_do_not_overlap() {
    let (g, _, _) = crossed_estate(7);
    let d = fathom_layout::lay_out(&g);
    for a in &d.nodes {
        for b in &d.nodes {
            if a.id >= b.id || a.x != b.x {
                continue;
            }
            assert!(
                (a.y - b.y).abs() >= a.h,
                "{} and {} overlap at x={}",
                a.label,
                b.label,
                a.x
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Cost, at `44`'s size
// ---------------------------------------------------------------------------

/// The ranked node list, exactly as `lay_out` computes it: live nodes in
/// `NodeId` order — kind declaration order, then ULID — ranked by depth in the
/// containment forest. Duplicated here rather than exported, because a test
/// that reads the naive order out of the thing it is testing proves nothing.
fn naive_ranked(g: &Graph) -> Vec<(u32, NodeId)> {
    let mut ranked: Vec<(u32, NodeId)> = NodeKind::ALL
        .into_iter()
        .flat_map(|k| g.nodes_of_kind(k))
        .filter(|n| n.absent_since.is_none())
        .map(|n| {
            let mut depth = 0;
            let mut at = n.id;
            while depth < 64 {
                match g.owner(at) {
                    Some(p) => {
                        depth += 1;
                        at = p;
                    }
                    None => break,
                }
            }
            (depth, n.id)
        })
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    ranked
}

fn edge_pairs(g: &Graph, ranked: &[(u32, NodeId)]) -> Vec<(u32, u32)> {
    let index: BTreeMap<NodeId, u32> = ranked
        .iter()
        .enumerate()
        .map(|(i, (_, id))| (*id, i as u32))
        .collect();
    let mut edges = Vec::new();
    for (_, id) in ranked {
        for kind in EdgeKind::ALL {
            if kind.root_containment() {
                continue;
            }
            for e in g.out(*id, kind) {
                if e.absent_since.is_some() {
                    continue;
                }
                if let (Some(a), Some(b)) = (index.get(id), index.get(&e.to)) {
                    edges.push((*a, *b));
                }
            }
        }
    }
    edges
}

/// A synthetic estate at `44` §4.7's stated size: 20 devices under one site,
/// each with 8 interfaces (a unit and an address apiece), 2 zones and a VPN,
/// plus 10 tunnels whose endpoints span two ranks so phase 4 has dummies to
/// insert. Zone membership is scrambled by a fixed stride, which is what gives
/// the sweep something to fix.
fn estate_at_scale() -> Graph {
    let mut b = Builder::new("scale");
    let site = b.node(NodeKind::Site);
    let mut vpns = Vec::new();
    for _ in 0..20 {
        let device = b.node(NodeKind::Device);
        b.edge(EdgeKind::HasDevice, site, device);
        let mut units = Vec::new();
        for _ in 0..8 {
            let iface = b.node(NodeKind::Interface);
            b.edge(EdgeKind::HasInterface, device, iface);
            let unit = b.node(NodeKind::LogicalUnit);
            b.edge(EdgeKind::HasUnit, iface, unit);
            let address = b.node(NodeKind::Address);
            b.edge(EdgeKind::HasAddress, unit, address);
            units.push(unit);
        }
        let zones: Vec<NodeId> = (0..2)
            .map(|_| {
                let zone = b.node(NodeKind::Zone);
                b.edge(EdgeKind::HasZone, device, zone);
                zone
            })
            .collect();
        // Stride 3 through the units, so membership does not agree with ULID
        // order — the honest version of "a zone is a set".
        for (i, unit) in units.iter().enumerate() {
            let zone = *zones.get((i * 3) % 2).expect("zone");
            b.edge(EdgeKind::ZoneMember, zone, *unit);
        }
        let vpn = b.node(NodeKind::IpsecVpn);
        b.edge(EdgeKind::HasIpsecVpn, device, vpn);
        vpns.push(vpn);
    }
    // Tunnels are roots (`HasTunnel` is root containment), so a tunnel sits at
    // rank 0 and its endpoint VPN at rank 2: every one of these is a span-2
    // edge and therefore a dummy.
    for t in 0..10usize {
        let tunnel = b.node(NodeKind::Tunnel);
        for side in 0..2usize {
            if let Some(vpn) = vpns.get(t * 2 + side) {
                b.edge(EdgeKind::TunnelEndpoint, tunnel, *vpn);
            }
        }
    }
    b.g.end_batch().expect("close");
    b.g
}

/// The estate the page actually draws when it is opened with
/// `?fixture=demo-estate`, which is the picture a person sees first.
///
/// The claim being made is small and it is the one worth making: on the estate
/// this build ships, the ordering removes crossings rather than merely not
/// adding any. The number is printed rather than asserted at a fixed value —
/// the demo estate is content and will change, and a test that has to be edited
/// every time content changes gets edited without being read.
#[test]
fn the_demo_estate_the_page_draws_loses_crossings() {
    let g = fathom_inventory::demo_estate();
    let ranked = naive_ranked(&g);
    let edges = edge_pairs(&g, &ranked);
    let ranks: Vec<u32> = ranked.iter().map(|(r, _)| *r).collect();
    let out = order(&ranks, &edges);
    println!(
        "demo estate: {} nodes, {} edges, {} dummies, {} crossings → {}",
        ranks.len(),
        edges.len(),
        out.dummies,
        out.crossings_before,
        out.crossings_after
    );
    assert!(
        out.crossings_after < out.crossings_before,
        "the shipped demo picture gained nothing: {} → {}",
        out.crossings_before,
        out.crossings_after
    );
}

/// The assumption `rows_for_graph` binary-searches on: walking `NodeKind::ALL`
/// and taking each kind's nodes yields every node in `NodeId` order, because
/// `ALL` is in declaration order and `NodeId`'s derived `Ord` is (kind
/// declaration order, then ULID).
///
/// It is pinned here because of how it would fail. A binary search of an
/// unsorted slice does not error — it returns `Err` and the edge is quietly
/// dropped, so the diagram would lose lines with nothing to say it had. If a
/// future `NodeKind::ALL` is reordered, this fails first and says why.
#[test]
fn the_walk_that_builds_the_live_set_is_in_node_id_order() {
    let g = estate_at_scale();
    let walked: Vec<NodeId> = NodeKind::ALL
        .into_iter()
        .flat_map(|k| g.nodes_of_kind(k))
        .map(|n| n.id)
        .collect();
    let mut sorted = walked.clone();
    sorted.sort_unstable();
    assert_eq!(
        walked, sorted,
        "NodeKind::ALL is no longer in NodeId order; order::rows_for_graph binary-searches it"
    );
}

/// `56` §3.3 budgets phase 5 at roughly 50,000 comparisons for 500 nodes and
/// 700 edges and says layout is not the bottleneck. This measures it rather
/// than believing it.
///
/// The assertion is deliberately loose — a wall clock on a shared machine is
/// not a measurement of an algorithm, and a tight bound here would fail on a
/// loaded CI box and teach everyone to ignore it. What it does catch is the
/// defect that matters: an ordering that has quietly become quadratic in the
/// wrong quantity. The real numbers are printed; run with `--nocapture`.
#[test]
fn phase_five_at_five_hundred_nodes() {
    let g = estate_at_scale();
    let ranked = naive_ranked(&g);
    let edges = edge_pairs(&g, &ranked);
    let ranks: Vec<u32> = ranked.iter().map(|(r, _)| *r).collect();

    let started = Instant::now();
    let out = order(&ranks, &edges);
    let ordering = started.elapsed();

    let started = Instant::now();
    let drawn = fathom_layout::lay_out(&g);
    let whole = started.elapsed();

    println!(
        "phases 4+5: {} nodes, {} edges, {} dummies, {} crossings → {} in {:?} \
         (whole lay_out, router included: {:?}; {} build)",
        ranks.len(),
        edges.len(),
        out.dummies,
        out.crossings_before,
        out.crossings_after,
        ordering,
        whole,
        // The shipped module is release. Printing "debug" under `--release`
        // would make the number look four times worse than the product's.
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );

    assert_eq!(drawn.nodes.len(), ranks.len(), "every node is drawn");
    assert!(out.dummies > 0, "the tunnels must produce dummies");
    assert!(
        out.crossings_after < out.crossings_before,
        "{} crossings became {}",
        out.crossings_before,
        out.crossings_after
    );
    assert!(
        ordering.as_millis() < 500,
        "phases 4+5 took {ordering:?} at {} nodes",
        ranks.len()
    );
}
