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
