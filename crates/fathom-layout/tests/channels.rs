//! Channel allocation — `56` §3.2 phase 8.
//!
//! The naive router ran every line between two ranks through the same midpoint
//! x, so parallel lines did not cross, they *coincided*: ten containment edges
//! from one device drew as one thick stroke and the picture said "one link"
//! where the graph said ten. These tests pin the property that removes that, and
//! they pin it on an estate dense enough that the old router demonstrably failed
//! it.

use std::collections::{BTreeMap, BTreeSet};

use fathom_graph::Graph;
use fathom_layout::{Diagram, Link, Node, RANK_GAP};

/// The nine-line branch SRX the sibling suite uses, kept here so a change to one
/// fixture cannot quietly change the other's meaning.
const SPARSE: &str = "\
set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security ike gateway gw-hq address 198.51.100.10
set security ike gateway gw-hq external-interface ge-0/0/0.0
set security ipsec vpn hq-vpn ike gateway gw-hq
set security ipsec vpn hq-vpn bind-interface st0.0
set security zones security-zone trust interfaces ge-0/0/0.0
set security zones security-zone vpn interfaces st0.0
";

/// A branch SRX with `n` addressed ports, each in its own zone.
///
/// Every port and every zone hangs off the same device, so every one of those
/// containment lines crosses the same band and starts at the same y — a fan out
/// of one box, which is the shape that collapses to a single stroke without
/// channel allocation, and which is what a real edge firewall looks like.
fn dense_paste(n: usize) -> String {
    let mut s = String::from("set system host-name srx-dense-01\n");
    for i in 0..n {
        s.push_str(&format!(
            "set interfaces ge-0/0/{i} unit 0 family inet address 10.0.{i}.1/30\n"
        ));
        s.push_str(&format!(
            "set security zones security-zone z{i} interfaces ge-0/0/{i}.0\n"
        ));
    }
    s
}

fn estate(text: &str) -> Graph {
    let dict = fathom_ingest::dict::Dictionary::embedded().expect("the compiled-in dictionary");
    let ing = fathom_ingest::ingest(text.as_bytes(), &dict).expect("the fixture parses");
    let at = fathom_graph::Timestamp(1_786_147_200_000);
    let manifest = fathom_weld::Manifest {
        at,
        entropy: 0x2026,
        actor: fathom_graph::Actor::User(fathom_graph::UserId(
            fathom_id::Ulid::from_parts(at.0, 1).expect("ulid"),
        )),
        batch: fathom_graph::BatchId(fathom_id::Ulid::from_parts(at.0, 2).expect("ulid")),
        label: "test",
        platform: fathom_ir::scalar::PlatformId(dict.platform().to_owned()),
    };
    let mut g = Graph::new();
    fathom_weld::apply_new_device(&mut g, &ing, &manifest).expect("the weld applies");
    g
}

/// One line's vertical run, read back out of the drawing rather than out of the
/// router's own bookkeeping. The picture is what a reader sees, so the picture is
/// what these tests assert on.
#[derive(Debug, Clone, Copy)]
struct Run {
    /// The band: x of the right face of the leftmost of the two boxes.
    wall: i32,
    /// The channel: x of the vertical segment.
    x: i32,
    lo: i32,
    hi: i32,
}

fn box_of<'a>(d: &'a Diagram, id: &str) -> &'a Node {
    d.nodes
        .iter()
        .find(|n| n.id == id)
        .expect("every line joins two drawn boxes")
}

/// `None` for a line with no vertical segment at all — two boxes facing each
/// other across a band at the same height are joined by one straight stroke,
/// which occupies no channel and so cannot collide with one.
fn run_of(d: &Diagram, l: &Link) -> Option<Run> {
    let (a, b) = (box_of(d, &l.from), box_of(d, &l.to));
    let left = if a.x <= b.x { a } else { b };
    let mut found: Option<Run> = None;
    for w in l.points.windows(2) {
        let (p, q) = (w[0], w[1]);
        if p.0 == q.0 && p.1 != q.1 {
            assert!(found.is_none(), "a path with two vertical runs: {l:?}");
            found = Some(Run {
                wall: left.x + left.w,
                x: p.0,
                lo: p.1.min(q.1),
                hi: p.1.max(q.1),
            });
        }
    }
    found
}

fn runs(d: &Diagram) -> Vec<Run> {
    d.links.iter().filter_map(|l| run_of(d, l)).collect()
}

/// **The property greedy interval colouring actually gives you.** Not "every
/// line gets its own channel" — that would be wasteful and would run out of
/// band — but "two lines share a channel only when their vertical runs are
/// disjoint", so no two strokes are ever laid on top of each other.
///
/// Closed intervals: runs that meet at a single y are not disjoint. Two lines
/// that touched at a shared y on one x would draw as one continuous stroke
/// through the box they share, which reads as a bus that is not there.
fn no_two_runs_coincide(d: &Diagram, what: &str) {
    let rs = runs(d);
    for (i, p) in rs.iter().enumerate() {
        for q in rs.iter().skip(i + 1) {
            if p.wall != q.wall || p.x != q.x {
                continue;
            }
            assert!(
                p.hi < q.lo || q.hi < p.lo,
                "{what}: two lines on channel x={} of band {} overlap between \
                 y={} and y={}",
                p.x,
                p.wall,
                p.lo.max(q.lo),
                p.hi.min(q.hi)
            );
        }
    }
}

#[test]
fn a_shared_channel_means_disjoint_runs() {
    no_two_runs_coincide(
        &fathom_layout::lay_out(&estate(SPARSE)),
        "the sparse estate",
    );
    no_two_runs_coincide(
        &fathom_layout::lay_out(&estate(&dense_paste(8))),
        "the dense estate",
    );
    no_two_runs_coincide(
        &fathom_layout::lay_out(&estate(&dense_paste(20))),
        "the very dense estate",
    );
}

/// The demonstration, on a fixture the naive router provably failed.
///
/// Sixteen ports and sixteen zones all hang off one device, so sixteen lines
/// leave the same box at the same y and cross the same band. Their runs all
/// contain that y, so *every* pair conflicts and the colouring must give every
/// one of them its own channel. The old router gave all sixteen the midpoint of
/// the band: one x, sixteen coincident strokes.
#[test]
fn the_dense_band_is_not_one_stroke() {
    let d = fathom_layout::lay_out(&estate(&dense_paste(16)));

    let mut by_band: BTreeMap<i32, Vec<Run>> = BTreeMap::new();
    for r in runs(&d) {
        by_band.entry(r.wall).or_default().push(r);
    }
    let (wall, band) = by_band
        .iter()
        .max_by_key(|(_, rs)| rs.len())
        .expect("the fixture has lines to draw");

    assert!(
        band.len() >= 16,
        "the fixture is not dense enough to be evidence: {} lines in the busiest band",
        band.len()
    );

    // Every pair in this band conflicts, so the honest channel count is the line
    // count. Anything fewer means two of them are sharing a stroke.
    let xs: BTreeSet<i32> = band.iter().map(|r| r.x).collect();
    assert_eq!(
        xs.len(),
        band.len(),
        "band at x={wall} drew {} lines on {} channels",
        band.len(),
        xs.len()
    );

    // The naive router's one answer, named: `mid = (start.x + end.x) / 2`, which
    // for every line across this band is the band's midpoint. At most one line
    // may sit there now. Asserting the negative directly is what makes this test
    // evidence about the defect rather than a description of the fix.
    let midpoint = band.iter().filter(|r| r.x == wall + RANK_GAP / 2).count();
    assert!(
        midpoint <= 1,
        "{midpoint} lines still share the band midpoint x={}",
        wall + RANK_GAP / 2
    );

    // And they stay inside the band they were allocated in. A channel that
    // wandered past the wall would be drawn over the next rank's boxes, which is
    // how an orthogonal router turns into a scribble.
    for r in band {
        assert!(
            r.x > *wall && r.x < wall + RANK_GAP,
            "channel x={} is outside band [{}, {}]",
            r.x,
            wall,
            wall + RANK_GAP
        );
    }
}

/// A band that needs one channel still puts it at the midpoint, exactly where
/// the naive router put every line. Channel allocation must not move a sparse
/// picture: `56` §3.5's mental-map argument — a small graph change must produce
/// a small position change — costs more than the tidiness would buy.
#[test]
fn a_band_with_one_channel_keeps_the_midpoint() {
    let d = fathom_layout::lay_out(&estate(&dense_paste(1)));
    let mut by_band: BTreeMap<i32, Vec<Run>> = BTreeMap::new();
    for r in runs(&d) {
        by_band.entry(r.wall).or_default().push(r);
    }
    let mut checked = 0;
    for (wall, band) in &by_band {
        let xs: BTreeSet<i32> = band.iter().map(|r| r.x).collect();
        if xs.len() != 1 {
            continue;
        }
        for r in band {
            assert_eq!(
                r.x,
                wall + RANK_GAP / 2,
                "the only line in band {wall} moved"
            );
            checked += 1;
        }
    }
    assert!(
        checked > 0,
        "no single-channel band in the fixture to check"
    );
}

/// **A channel is reused when it can be.** Greedy interval colouring is not
/// "one line, one x" — two lines whose runs miss each other share a channel, and
/// they must, or a band of forty short lines would need forty channels and the
/// band would saturate for nothing.
#[test]
fn disjoint_runs_share_a_channel() {
    let d = fathom_layout::lay_out(&estate(SPARSE));
    let mut by_x: BTreeMap<(i32, i32), Vec<Run>> = BTreeMap::new();
    for r in runs(&d) {
        by_x.entry((r.wall, r.x)).or_default().push(r);
    }
    assert!(
        by_x.values().any(|rs| rs.len() > 1),
        "no channel in the sparse estate carries two lines, so reuse is untested"
    );
}

/// **Invariant 9, applied to the router.** The allocation is a pure function of
/// the graph: same estate, same channels, on every machine and every run. A
/// diagram whose lines move between two runs cannot go in a change ticket.
#[test]
fn the_dense_estate_routes_identically() {
    let a = fathom_layout::lay_out(&estate(&dense_paste(12)));
    let b = fathom_layout::lay_out(&estate(&dense_paste(12)));
    assert_eq!(
        a.links, b.links,
        "two routings of the same estate disagreed"
    );
}

/// The two properties the existing suite pins on nine lines of config, re-pinned
/// on an estate forty times the size — because a router with channel allocation
/// has far more ways to emit a diagonal than one with a single midpoint had.
#[test]
fn the_dense_estate_is_orthogonal_and_joined_up() {
    let d = fathom_layout::lay_out(&estate(&dense_paste(20)));
    assert!(
        d.links.len() > 40,
        "the fixture must be worth the assertion"
    );
    for l in &d.links {
        assert!(
            d.nodes.iter().any(|n| n.id == l.from) && d.nodes.iter().any(|n| n.id == l.to),
            "a line joins something that was not drawn"
        );
        assert!(l.points.len() >= 2, "a path needs at least two points");
        for w in l.points.windows(2) {
            let (p, q) = (w[0], w[1]);
            assert!(
                p.0 == q.0 || p.1 == q.1,
                "segment {p:?}->{q:?} of a {} line is diagonal",
                l.kind
            );
        }
    }
}
