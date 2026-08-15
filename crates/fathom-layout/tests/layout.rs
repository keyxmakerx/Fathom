//! Layout, against the estate a real SRX paste builds.
//!
//! The property that matters most is determinism: a diagram that differs between
//! two machines cannot be put in a change ticket, which is the whole point of
//! drawing it.

use fathom_graph::Graph;
use fathom_ir::generated::ir_types::NodeKind;

const PASTE: &str = "\
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

/// The repository root, from this crate's manifest directory.
///
/// The dictionary used to be `Dictionary::embedded()` -- compiled into the
/// binary. It moved into the page on 2026-08-15 to buy back 26,915 bytes of the
/// wasm module's ceiling, so a test loads it from disk like every other
/// non-wasm caller does.
fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("the workspace root is two above this crate")
        .to_path_buf()
}

fn estate() -> Graph {
    let dict =
        fathom_ingest::dict::Dictionary::load(&repo_root()).expect("the shipped dictionary loads");
    let ing = fathom_ingest::ingest(PASTE.as_bytes(), &dict).expect("the fixture parses");
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

/// Every live node is drawn, and nothing is drawn twice.
#[test]
fn every_node_gets_exactly_one_box() {
    let g = estate();
    let d = fathom_layout::lay_out(&g);
    let live = NodeKind::ALL
        .into_iter()
        .flat_map(|k| g.nodes_of_kind(k))
        .filter(|n| n.absent_since.is_none())
        .count();
    assert_eq!(d.nodes.len(), live, "one box per live node");

    let mut ids: Vec<&str> = d.nodes.iter().map(|n| n.id.as_str()).collect();
    ids.sort_unstable();
    let before = ids.len();
    ids.dedup();
    assert_eq!(ids.len(), before, "a node was drawn twice");
}

/// **Invariant 9, applied to pictures.** Same graph, same coordinates, always.
#[test]
fn the_same_estate_lays_out_identically() {
    let a = fathom_layout::lay_out(&estate());
    let b = fathom_layout::lay_out(&estate());
    assert_eq!(a, b, "two layouts of the same estate disagreed");
}

/// The device is a root, so it sits at rank 0; the things it contains sit to its
/// right. If this inverts, the picture reads backwards.
#[test]
fn containment_runs_left_to_right() {
    let g = estate();
    let d = fathom_layout::lay_out(&g);
    let device = d
        .nodes
        .iter()
        .find(|n| n.kind == "Device")
        .expect("the paste built a device");
    assert_eq!(device.x, fathom_layout::MARGIN, "a root sits at rank 0");

    for n in &d.nodes {
        if n.kind == "Address" {
            assert!(
                n.x > device.x,
                "an address is contained by the device and must sit right of it"
            );
        }
    }
}

/// Boxes in one rank must not overlap, or labels sit on top of each other.
#[test]
fn boxes_in_a_rank_do_not_overlap() {
    let d = fathom_layout::lay_out(&estate());
    for a in &d.nodes {
        for b in &d.nodes {
            if a.id >= b.id || a.x != b.x {
                continue;
            }
            let apart = (a.y - b.y).abs() >= a.h;
            assert!(apart, "{} and {} overlap at x={}", a.label, b.label, a.x);
        }
    }
}

/// Every line joins two drawn boxes, and every path is orthogonal — each segment
/// is either horizontal or vertical. A diagonal here would mean the routing did
/// something it does not claim to.
#[test]
fn every_line_joins_two_boxes_and_is_orthogonal() {
    let d = fathom_layout::lay_out(&estate());
    assert!(!d.links.is_empty(), "the fixture has edges to draw");
    for l in &d.links {
        assert!(
            d.nodes.iter().any(|n| n.id == l.from),
            "line from an undrawn node"
        );
        assert!(
            d.nodes.iter().any(|n| n.id == l.to),
            "line to an undrawn node"
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

/// The tunnel binding is the fact an engineer looks for, so it must be a line.
#[test]
fn the_tunnel_binding_is_drawn() {
    let d = fathom_layout::lay_out(&estate());
    assert!(
        d.links.iter().any(|l| l.kind == "BindsInterface"),
        "the VPN binds st0.0 and that edge must appear: {:?}",
        d.links.iter().map(|l| l.kind).collect::<Vec<_>>()
    );
}

/// An empty estate draws nothing rather than a box of nothing.
#[test]
fn an_empty_estate_draws_nothing() {
    let d = fathom_layout::lay_out(&Graph::new());
    assert!(d.nodes.is_empty() && d.links.is_empty());
    assert_eq!((d.width, d.height), (0, 0));
}

// --- hand placement (ADR-0035) ------------------------------------------------
//
// The pin is written here through the store's own API rather than through
// `OP_PLACE`, because this crate must not depend on the wasm shell. The wire
// half is `crates/fathom-wasm/tests/place.rs`; this half is the layout rule.

/// Pin `id` at `(x, y)` — a `LayoutPin` contained by it, exactly as `OP_PLACE`
/// builds one.
fn pin(g: &mut Graph, id: fathom_graph::NodeId, x: i32, y: i32, n: u128) {
    use fathom_graph::{Actor, BatchId, ElementId, Timestamp, UserId};
    use fathom_ir::generated::ir_types::{EdgeKind, LayoutPinField};

    let at = Timestamp(1_786_147_200_000);
    let ulid = |k: u128| fathom_id::Ulid::from_parts(at.0 + 1, n * 16 + k).expect("ulid");
    let rec = |k: u128| fathom_graph::ProvenanceRecord {
        id: fathom_graph::ProvenanceId(ulid(k)),
        origin: fathom_graph::Origin::Hand,
        asserted_at: at,
        asserted_by: Actor::User(UserId(ulid(0))),
        confidence: fathom_graph::Confidence::Asserted,
        supersedes: None,
    };
    g.begin_batch(BatchId(ulid(1)), "place").expect("batch");
    let p = g
        .insert_node(
            fathom_ir::generated::ir_types::NodeKind::LayoutPin,
            ulid(2),
            rec(3),
        )
        .expect("pin node");
    g.insert_edge(EdgeKind::HasLayoutPin, ulid(4), id, p, rec(5))
        .expect("the containment edge");
    g.set_field(ElementId::Node(p), LayoutPinField::X.key(), x, rec(6))
        .expect("x");
    g.set_field(ElementId::Node(p), LayoutPinField::Y.key(), y, rec(7))
        .expect("y");
    g.end_batch().expect("batch closes");
}

fn node_of(g: &Graph, kind: NodeKind) -> fathom_graph::NodeId {
    g.nodes_of_kind(kind)
        .find(|n| n.absent_since.is_none())
        .expect("the fixture has one")
        .id
}

/// A pin is never drawn. It is an assertion about the picture, not a thing on
/// the network, and a box for it would be the diagram describing its own
/// bookkeeping.
#[test]
fn a_pin_is_not_itself_drawn() {
    let mut g = estate();
    let before = fathom_layout::lay_out(&g).nodes.len();
    let device = node_of(&g, NodeKind::Device);
    pin(&mut g, device, 800, 600, 1);
    let after = fathom_layout::lay_out(&g);
    assert_eq!(after.nodes.len(), before, "the pin was drawn as a box");
    assert!(
        after.nodes.iter().all(|n| n.kind != "LayoutPin"),
        "a LayoutPin reached the picture"
    );
    assert!(
        after.links.iter().all(|l| l.kind != "HasLayoutPin"),
        "the pin's containment edge was drawn as a line"
    );
}

/// The override, and the one property `56` §3.5 argues hardest for: a pin moves
/// the box it names and moves nothing else.
#[test]
fn a_pin_moves_one_box_and_leaves_the_rest_alone() {
    let mut g = estate();
    let before = fathom_layout::lay_out(&g);
    let device = node_of(&g, NodeKind::Device);
    pin(&mut g, device, 800, 600, 1);
    let after = fathom_layout::lay_out(&g);

    let id = device.to_string();
    let moved = after
        .nodes
        .iter()
        .find(|n| n.id == id)
        .expect("still drawn");
    assert_eq!((moved.x, moved.y), (800, 600));
    assert!(moved.placed, "and it is marked as placed");

    for b in &before.nodes {
        if b.id == id {
            continue;
        }
        let now = after
            .nodes
            .iter()
            .find(|n| n.id == b.id)
            .expect("still drawn");
        assert_eq!((now.x, now.y), (b.x, b.y), "{} moved", b.id);
        assert!(!now.placed);
    }
}

/// Determinism survives the feature (invariant 9): the same estate with the same
/// pin lays out to the same coordinates.
#[test]
fn a_pinned_estate_still_lays_out_identically() {
    let build = || {
        let mut g = estate();
        let device = node_of(&g, NodeKind::Device);
        pin(&mut g, device, 404, 96, 1);
        fathom_layout::lay_out(&g)
    };
    assert_eq!(build(), build());
}

/// A tombstoned pin is no pin. That is what `OP_PLACE` mode 0 writes, and it is
/// also what `Graph::tombstone` does to a pin when the box it places is removed
/// — the containment edge is what makes the second case free.
#[test]
fn a_tombstoned_pin_gives_the_box_back_to_the_layout() {
    let mut g = estate();
    let before = fathom_layout::lay_out(&g);
    let device = node_of(&g, NodeKind::Device);
    pin(&mut g, device, 800, 600, 1);

    let at = fathom_graph::Timestamp(1_786_147_200_002);
    let p = fathom_layout::pin_node(&g, device).expect("the pin is there");
    g.begin_batch(
        fathom_graph::BatchId(fathom_id::Ulid::from_parts(at.0, 9).expect("ulid")),
        "free",
    )
    .expect("batch");
    g.tombstone(fathom_graph::ElementId::Node(p), at)
        .expect("tombstone");
    g.end_batch().expect("batch closes");

    assert_eq!(
        fathom_layout::lay_out(&g),
        before,
        "the picture is restored"
    );
    assert!(fathom_layout::pin_node(&g, device).is_none());
}

/// A pin on a member of a COLLAPSED group is ignored. A box standing for forty
/// nodes has no single element whose position it could be, and honouring one
/// member's pin would move the other thirty-nine with it.
#[test]
fn a_pin_inside_a_collapsed_group_does_not_move_the_group() {
    let mut g = estate();
    let unit = node_of(&g, NodeKind::LogicalUnit);
    let folded = fathom_layout::agg::View::folded();
    let before = fathom_layout::lay_out_with(&g, &folded);
    pin(&mut g, unit, 900, 900, 1);
    let after = fathom_layout::lay_out_with(&g, &folded);
    for b in &after.nodes {
        if b.count > 1 {
            assert!(!b.placed, "a collapsed box claimed a hand position");
        }
    }
    // Whichever box the unit ended up in, no box in the folded picture may have
    // jumped to (900, 900) unless it stands for that one node alone.
    for b in &after.nodes {
        if b.count > 1 {
            let was = before.nodes.iter().find(|n| n.id == b.id);
            if let Some(was) = was {
                assert_eq!((b.x, b.y), (was.x, was.y), "{} moved", b.id);
            }
        }
    }
}

/// The 4 px grid, in the core (`56` §3.5). Snapping in the page would put a
/// rounding rule where nothing checks it.
#[test]
fn snap_rounds_to_the_grid_in_both_directions() {
    for (v, want) in [
        (0, 0),
        (1, 0),
        (2, 4),
        (3, 4),
        (4, 4),
        (-1, 0),
        (-2, 0),
        (-3, -4),
        (-4, -4),
        (-6, -4),
    ] {
        assert_eq!(fathom_layout::snap(v), want, "snap({v})");
    }
    assert_eq!(fathom_layout::snap(i32::MAX) % 4, 0, "no overflow panic");
    assert_eq!(fathom_layout::snap(i32::MIN) % 4, 0, "no overflow panic");
}
