//! The five layers, against the estate a real SRX paste builds.
//!
//! The property that matters most here is not what any one mask draws — it is
//! that a mask **never moves anything**. `56` §3.6 decides it and `56` §11 row 6
//! predicts what happens if it is got wrong: *"Users stop using layer toggles
//! within a week."* Three tests below pin it from three directions, because it
//! is the one thing that cannot be seen from a screenshot of a single mask.

use fathom_graph::Graph;
use fathom_layout::layers::{self, Layer, LayerMask};

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

/// Every non-empty mask, in ascending order. `56` §4 calls these *"the fixture
/// space for `55` §4.5.8's bijection test"*; they are this file's fixture space
/// too.
fn every_mask() -> Vec<LayerMask> {
    (1..=LayerMask::ALL.bits())
        .filter_map(LayerMask::from_bits)
        .collect()
}

/// **`56` §3.6, the decision this whole module exists to protect.** Over all 31
/// non-empty masks, every box that survives sits at exactly the coordinates the
/// union layout gave it, and the canvas keeps the union's extent.
///
/// The canvas half is not decoration. If the extent shrank to the visible set,
/// the viewBox would change and a page that scales to fit would re-scale the
/// whole picture on a toggle — nothing would have moved in scene coordinates and
/// everything would have moved on screen, which is failure mode 6 arriving by a
/// side door.
#[test]
fn no_mask_moves_anything() {
    let union = fathom_layout::lay_out(&estate());
    for mask in every_mask() {
        let (d, _) = layers::filter(&union, mask);
        assert_eq!(
            (d.width, d.height),
            (union.width, union.height),
            "mask {:05b} changed the canvas extent",
            mask.bits()
        );
        for n in &d.nodes {
            let was = union
                .nodes
                .iter()
                .find(|u| u.id == n.id)
                .expect("a filtered node was not in the union layout");
            assert_eq!(n, was, "mask {:05b} moved {}", mask.bits(), n.label);
        }
    }
}

/// A filter removes rows; it never reorders or invents them. Asserted as a
/// subsequence, which is stronger than a set comparison and is what makes the
/// drawing order — and therefore the paint order — stable across a toggle.
#[test]
fn every_mask_is_a_subsequence_of_the_union() {
    let union = fathom_layout::lay_out(&estate());
    for mask in every_mask() {
        let (d, _) = layers::filter(&union, mask);
        let mut at = union.nodes.iter();
        for n in &d.nodes {
            assert!(
                at.any(|u| u.id == n.id),
                "mask {:05b} put {} out of order",
                mask.bits(),
                n.id
            );
        }
        let mut at = union.links.iter();
        for l in &d.links {
            assert!(
                at.any(|u| u.from == l.from && u.to == l.to && u.kind == l.kind),
                "mask {:05b} put a {} line out of order",
                mask.bits(),
                l.kind
            );
        }
    }
}

/// Invariant 9 for the filter: same diagram, same mask, same output, twice.
#[test]
fn the_same_mask_filters_identically() {
    let union = fathom_layout::lay_out(&estate());
    for mask in every_mask() {
        assert_eq!(
            layers::filter(&union, mask),
            layers::filter(&union, mask),
            "mask {:05b} filtered two different ways",
            mask.bits()
        );
    }
}

/// **The union of the five single-layer pictures is the all-layers picture.**
/// `56` §4: *"A node or edge is drawn if it is in **any** active layer."* A mask
/// is therefore a union and never an intersection, and this is the algebra that
/// says so.
#[test]
fn a_mask_is_the_union_of_its_layers() {
    let union = fathom_layout::lay_out(&estate());
    let (all, _) = layers::filter(&union, LayerMask::ALL);

    let mut seen: Vec<String> = Vec::new();
    for layer in Layer::ALL {
        let (one, _) = layers::filter(&union, LayerMask::NONE.with(layer));
        for n in &one.nodes {
            if !seen.contains(&n.id) {
                seen.push(n.id.clone());
            }
        }
    }
    seen.sort_unstable();

    let mut want: Vec<String> = all.nodes.iter().map(|n| n.id.clone()).collect();
    want.sort_unstable();
    assert_eq!(seen, want, "one layer at a time did not add up to all five");
}

/// The empty mask draws nothing at all, and still keeps the canvas — a page with
/// all five toggles off gets an empty picture the same size, not a collapsed one
/// and not a refusal.
#[test]
fn the_empty_mask_draws_nothing_and_keeps_the_canvas() {
    let union = fathom_layout::lay_out(&estate());
    let (d, f) = layers::filter(&union, LayerMask::NONE);
    assert!(d.nodes.is_empty() && d.links.is_empty());
    assert_eq!((d.width, d.height), (union.width, union.height));
    assert_eq!(f.hidden_nodes as usize, union.nodes.len());
    assert_eq!(f.hidden_links as usize, union.links.len());
}

/// No line may join a box that is not drawn. A line into empty space is a
/// filtered picture asserting a relationship between things it is not showing.
#[test]
fn no_line_survives_without_both_of_its_boxes() {
    let union = fathom_layout::lay_out(&estate());
    for mask in every_mask() {
        let (d, _) = layers::filter(&union, mask);
        for l in &d.links {
            assert!(
                d.nodes.iter().any(|n| n.id == l.from) && d.nodes.iter().any(|n| n.id == l.to),
                "mask {:05b} kept a {} line whose endpoint is not drawn",
                mask.bits(),
                l.kind
            );
        }
    }
}

/// **The two kinds `56` §4.1 draws nowhere.** This is the one place the layer
/// model removes something from the unfiltered picture, so it is pinned rather
/// than left to be discovered as a regression.
#[test]
fn inspector_only_kinds_are_drawn_at_no_layer() {
    use fathom_ir::generated::ir_types::NodeKind;
    for k in [NodeKind::AddressObject, NodeKind::Application] {
        let p = layers::projection_of(k);
        assert!(p.layers.is_empty(), "{} must be inspector only", k.name());
        assert!(p.tabled, "{} has a row in 56 §4.1", k.name());
    }
}

/// The zone and the tunnel are the two facts each of their layers exists to
/// carry. If either drops out of its own layer the toggle is worthless.
#[test]
fn the_security_and_overlay_layers_carry_their_own_estate() {
    let union = fathom_layout::lay_out(&estate());

    let (sec, _) = layers::filter(&union, LayerMask::NONE.with(Layer::Security));
    assert!(
        sec.nodes.iter().filter(|n| n.kind == "Zone").count() >= 2,
        "the paste declares two zones and the security layer must draw both"
    );
    assert!(
        sec.links.iter().any(|l| l.kind == "ZoneMember"),
        "zone membership is the security layer's whole content in this build"
    );

    let (ovl, _) = layers::filter(&union, LayerMask::NONE.with(Layer::Overlay));
    assert!(
        ovl.nodes.iter().any(|n| n.kind == "IpsecVpn"),
        "the overlay layer must draw the VPN"
    );
    assert!(
        !ovl.nodes.iter().any(|n| n.kind == "Address"),
        "an Address is an L3 label and has no business on the overlay layer"
    );
}

/// The physical layer draws the box and its ports and nothing logical; the L3
/// layer draws the addresses and not the ports. Two masks, opposite content —
/// the demonstration that a toggle says something.
#[test]
fn physical_and_l3_disagree_about_what_matters() {
    let union = fathom_layout::lay_out(&estate());
    let (phy, _) = layers::filter(&union, LayerMask::NONE.with(Layer::Physical));
    let (l3, _) = layers::filter(&union, LayerMask::NONE.with(Layer::L3));

    assert!(phy.nodes.iter().any(|n| n.kind == "Device"));
    assert!(phy.nodes.iter().any(|n| n.kind == "Interface"));
    assert!(
        !phy.nodes.iter().any(|n| n.kind == "Address"),
        "an IP address is not a physical fact"
    );

    assert!(l3.nodes.iter().any(|n| n.kind == "Address"));
    assert!(
        !l3.nodes.iter().any(|n| n.kind == "Interface"),
        "a physical port is not an L3 fact -- §4.1 gives Interface the physical column only"
    );
}

/// Every kind in `schema/` is classified, and the untabled ones are visible
/// rather than silently absent. The count is not asserted as a number: it is a
/// gap that should shrink, and a test that pins it would have to be edited by
/// the person closing it, which is the wrong incentive.
#[test]
fn every_kind_is_classified_and_untabled_ones_are_never_hidden() {
    use fathom_ir::generated::ir_types::NodeKind;
    let mut untabled = 0;
    for k in NodeKind::ALL {
        let p = layers::projection_of(k);
        if !p.tabled {
            untabled += 1;
            assert_eq!(
                p.layers,
                LayerMask::ALL,
                "{} has no row in 56 §4.1 and must therefore never be hidden by a mask",
                k.name()
            );
        }
    }
    assert!(
        untabled > 0 && untabled < NodeKind::ALL.len(),
        "the gap is real and is not the whole table"
    );
}

/// The mask type refuses a bit that is not a layer. A page that sends `0xFF`
/// gets a refusal, not a picture that disagrees with its own toggles.
#[test]
fn a_mask_outside_the_five_bits_is_refused() {
    assert_eq!(LayerMask::from_bits(0b0001_1111), Some(LayerMask::ALL));
    assert_eq!(LayerMask::from_bits(0), Some(LayerMask::NONE));
    for bad in [0b0010_0000u8, 0b0100_0000, 0b1000_0000, 0xFF] {
        assert_eq!(LayerMask::from_bits(bad), None, "{bad:#010b} was accepted");
    }
    assert_eq!(every_mask().len(), 31, "56 §4's 31 non-empty combinations");
}

/// Bit order is the wire order. A stored or transmitted mask means the same
/// thing tomorrow only if this holds.
#[test]
fn the_bit_order_is_the_declaration_order() {
    for (i, layer) in Layer::ALL.into_iter().enumerate() {
        assert_eq!(layer.bit(), 1u8 << i, "{} moved", layer.name());
        assert!(LayerMask::ALL.contains(layer));
        assert!(!LayerMask::NONE.contains(layer));
        assert_eq!(LayerMask::NONE.with(layer).bits(), layer.bit());
        assert!(!LayerMask::ALL.without(layer).contains(layer));
        assert_eq!(
            LayerMask::NONE.toggled(layer).toggled(layer),
            LayerMask::NONE
        );
    }
    assert_eq!(LayerMask::ALL.count(), 5);
    assert_eq!(
        Layer::ALL.map(|l| l.name()),
        ["physical", "l2", "l3", "security", "overlay"]
    );
}
