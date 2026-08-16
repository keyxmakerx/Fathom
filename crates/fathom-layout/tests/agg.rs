//! Aggregation, against a hub big enough to need it.
//!
//! `59` failure mode 14: *"The picture is checked at four spokes. Every claim
//! holds, because below the threshold nothing fires."* So every count here is
//! read at forty and at a hundred and twenty, and the two must agree.
//!
//! The fixture is `59` §7.1 item 1 built in Rust: a hub with a fan of spokes,
//! **plus the two exceptions the study's own HTML fixtures could not show.**
//! That document is blunt about why that mattered — every spoke in all three
//! variants came out of one loop with identical age, identical note and
//! identical depth text, so *"the collapsed box is telling the truth in this
//! fixture only, and the variant would be adopted on evidence that structurally
//! excludes its worst case."* Here `spoke-17` is hand-authored among parsed
//! siblings and `spoke-30` is wired to something the others are not, and both
//! are carried out of the aggregate by name.
//!
//! **Thirteen is in this file on purpose.** A run of thirteen walked forward one
//! window leaves a trailing residual of exactly one member, which is the state
//! the previous fixture of ten could never reach and the state a reviewer drove
//! into a module refusal in the browser.

use fathom_graph::{
    Actor, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord, Timestamp,
    UserId,
};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{
    self, DeviceRole, EdgeKind, InterfaceForm, NodeKind, TunnelInterfaceTechnology,
};
use fathom_ir::scalar;
use fathom_layout::agg::{View, THRESHOLD, WINDOW};

/// 2026-07-31T00:00:00Z. A stored value, never evaluated against a clock.
const TS0: u64 = 1_785_456_000_000;

/// The spoke that was typed rather than parsed, and the spoke that is wired to
/// something the other thirty-nine are not. Both must survive the collapse.
const HAND_SPOKE: usize = 17;
const WIRED_SPOKE: usize = 30;
/// The one unit in the fan that carries an address.
const ADDRESSED_UNIT: usize = 7;

fn ulid(k: u128) -> Ulid {
    Ulid::from_parts(TS0, k).expect("TS0 fits 48 bits")
}

fn key(name: &'static str) -> FieldKey {
    let (_, k) = ir_types::FIELD_KEYS
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap_or_else(|| panic!("`{name}` is not a declared field"));
    FieldKey(*k)
}

fn prov(k: u128, origin: Origin) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(k)),
        origin,
        asserted_at: Timestamp(TS0),
        asserted_by: Actor::User(UserId(ulid(9000))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

fn parsed() -> ProvenanceRecord {
    prov(
        9001,
        Origin::Parsed {
            capture: fathom_graph::CaptureId(ulid(9500)),
            span: fathom_graph::CaptureSpan { start: 0, end: 1 },
        },
    )
}

fn hand() -> ProvenanceRecord {
    prov(9002, Origin::Hand)
}

fn set<T: core::any::Any>(g: &mut Graph, id: NodeId, field: &'static str, v: T) {
    g.set_field(ElementId::Node(id), key(field), v, parsed())
        .unwrap_or_else(|e| panic!("{field}: {e}"));
}

/// A hub with `spokes` spoke devices, one `st0` carrying one unit per spoke,
/// and the two heterogeneous members `59` §3.11 exists for.
///
/// Every id is `Ulid::from_parts(TS0, k)`: no clock, no RNG (invariant 9).
fn hub(spokes: usize) -> Graph {
    let mut g = Graph::new();
    g.begin_batch(fathom_graph::BatchId(ulid(9003)), "hub fixture")
        .expect("a fresh graph has no open batch");
    // A shared counter rather than two `&mut` captures: ids must be minted from
    // one monotonic sequence so that insertion order and ULID order agree.
    let seq = core::cell::Cell::new(1u128);
    let next = || {
        seq.set(seq.get() + 1);
        seq.get()
    };
    let mint = |g: &mut Graph, kind: NodeKind, p: ProvenanceRecord| -> NodeId {
        let k = next();
        g.insert_node(kind, ulid(k), p)
            .unwrap_or_else(|e| panic!("node {k}: {e}"))
    };
    let edge = |g: &mut Graph, kind: EdgeKind, from: NodeId, to: NodeId| {
        let k = next();
        g.insert_edge(kind, ulid(k), from, to, parsed())
            .unwrap_or_else(|e| panic!("edge {k}: {e}"));
    };

    let site = mint(&mut g, NodeKind::Site, parsed());
    set(
        &mut g,
        site,
        "Site.name",
        scalar::Text("Hub site".to_owned()),
    );

    // The hub is minted before the spokes so it sorts first inside the
    // (Site, Device) bucket; its own run is one box because it is the only
    // device in the estate that owns an interface.
    let dev = mint(&mut g, NodeKind::Device, parsed());
    set(
        &mut g,
        dev,
        "Device.hostname",
        scalar::Identifier("hub-a".to_owned()),
    );
    set(&mut g, dev, "Device.role", DeviceRole::Firewall);
    edge(&mut g, EdgeKind::HasDevice, site, dev);

    let st0 = mint(&mut g, NodeKind::TunnelInterface, parsed());
    set(
        &mut g,
        st0,
        "TunnelInterface.name",
        scalar::InterfaceName("st0".to_owned()),
    );
    set(
        &mut g,
        st0,
        "TunnelInterface.technology",
        TunnelInterfaceTechnology::IpsecVti,
    );
    edge(&mut g, EdgeKind::HasInterface, dev, st0);

    for i in 1..=spokes {
        let p = if i == HAND_SPOKE { hand() } else { parsed() };
        let s = mint(&mut g, NodeKind::Device, p);
        set(
            &mut g,
            s,
            "Device.hostname",
            scalar::Identifier(format!("spoke-{i:02}")),
        );
        set(&mut g, s, "Device.role", DeviceRole::Router);
        edge(&mut g, EdgeKind::HasDevice, site, s);

        if i == WIRED_SPOKE {
            let ge = mint(&mut g, NodeKind::Interface, parsed());
            set(
                &mut g,
                ge,
                "Interface.name",
                scalar::InterfaceName("ge-0/0/0".to_owned()),
            );
            set(&mut g, ge, "Interface.form", InterfaceForm::Ethernet);
            edge(&mut g, EdgeKind::HasInterface, s, ge);
        }
    }

    for i in 0..spokes {
        let u = mint(&mut g, NodeKind::LogicalUnit, parsed());
        set(&mut g, u, "LogicalUnit.index", i as u32);
        edge(&mut g, EdgeKind::HasUnit, st0, u);

        if i == ADDRESSED_UNIT {
            let a = mint(&mut g, NodeKind::Address, parsed());
            set(
                &mut g,
                a,
                "Address.value",
                scalar::InterfaceAddress {
                    addr: core::net::IpAddr::V4(core::net::Ipv4Addr::new(10, 255, 0, 1)),
                    prefix_len: 30,
                },
            );
            edge(&mut g, EdgeKind::HasAddress, u, a);
        }
    }
    g.end_batch().expect("the batch is open");
    g
}

/// One device, one `ae0`, and `members` interfaces bundled into it.
///
/// The set `59` §3.7 exempts from windowing: *"An aggregate interface is a
/// bounded, unordered set … so there is no page to walk and no ordering worth
/// walking it in."* Every member carries `MemberOfAggregate`, which is what
/// `agg::bounded` reads.
fn lag(members: usize) -> Graph {
    let mut g = Graph::new();
    g.begin_batch(fathom_graph::BatchId(ulid(9004)), "lag fixture")
        .expect("a fresh graph has no open batch");
    let seq = core::cell::Cell::new(1u128);
    let next = || {
        seq.set(seq.get() + 1);
        seq.get()
    };

    let dev = g
        .insert_node(NodeKind::Device, ulid(next()), parsed())
        .expect("device");
    set(
        &mut g,
        dev,
        "Device.hostname",
        scalar::Identifier("core-01".to_owned()),
    );
    set(&mut g, dev, "Device.role", DeviceRole::Switch);

    let ae = g
        .insert_node(NodeKind::AggregateInterface, ulid(next()), parsed())
        .expect("ae0");
    set(
        &mut g,
        ae,
        "AggregateInterface.name",
        scalar::InterfaceName("ae0".to_owned()),
    );
    g.insert_edge(EdgeKind::HasInterface, ulid(next()), dev, ae, parsed())
        .expect("the device owns ae0");

    for i in 0..members {
        let xe = g
            .insert_node(NodeKind::Interface, ulid(next()), parsed())
            .expect("member");
        set(
            &mut g,
            xe,
            "Interface.name",
            scalar::InterfaceName(format!("xe-0/0/{i}")),
        );
        set(&mut g, xe, "Interface.form", InterfaceForm::Ethernet);
        g.insert_edge(EdgeKind::HasInterface, ulid(next()), dev, xe, parsed())
            .expect("the device owns the member");
        g.insert_edge(EdgeKind::MemberOfAggregate, ulid(next()), xe, ae, parsed())
            .expect("the member joins the bundle");
    }
    g.end_batch().expect("the batch is open");
    g
}

/// One site and a ring of `n` devices, each of which `PeersWith` the next.
///
/// The shape `59`'s heterogeneity guard cannot split, because every member
/// looks identical: one containment edge in, one `PeersWith` out, one
/// `PeersWith` in. Collapsing them therefore hides `n` **edges** as well as `n`
/// nodes, and [`fathom_layout::Node::interior`] is the only thing that can say
/// so — a box's count counts nodes.
///
/// A ring rather than a chain because a chain's two ends have different
/// signatures and split off, which is the guard working and is not the case
/// under test here.
fn ring(n: usize) -> Graph {
    let mut g = Graph::new();
    g.begin_batch(fathom_graph::BatchId(ulid(9005)), "ring fixture")
        .expect("a fresh graph has no open batch");
    let seq = core::cell::Cell::new(1u128);
    let next = || {
        seq.set(seq.get() + 1);
        seq.get()
    };

    let site = g
        .insert_node(NodeKind::Site, ulid(next()), parsed())
        .expect("site");
    set(
        &mut g,
        site,
        "Site.name",
        scalar::Text("Ring site".to_owned()),
    );

    let mut peers: Vec<NodeId> = Vec::new();
    for i in 0..n {
        let d = g
            .insert_node(NodeKind::Device, ulid(next()), parsed())
            .expect("device");
        set(
            &mut g,
            d,
            "Device.hostname",
            scalar::Identifier(format!("ring-{i:02}")),
        );
        set(&mut g, d, "Device.role", DeviceRole::Router);
        g.insert_edge(EdgeKind::HasDevice, ulid(next()), site, d, parsed())
            .expect("the site holds the device");
        peers.push(d);
    }
    for i in 0..n {
        let (a, b) = (peers[i], peers[(i + 1) % n]);
        g.insert_edge(EdgeKind::PeersWith, ulid(next()), a, b, parsed())
            .expect("the ring closes");
    }
    g.end_batch().expect("the batch is open");
    g
}

fn live(g: &Graph) -> usize {
    NodeKind::ALL
        .into_iter()
        .flat_map(|k| g.nodes_of_kind(k))
        .filter(|n| n.absent_since.is_none())
        .count()
}

fn folded(g: &Graph) -> fathom_layout::Diagram {
    fathom_layout::lay_out_with(g, &View::folded())
}

fn bare(group: &str) -> String {
    group
        .split_once('#')
        .map(|(k, _)| k.to_owned())
        .unwrap_or_else(|| group.to_owned())
}

fn group_key(d: &fathom_layout::Diagram, label: &str) -> String {
    let n = d
        .nodes
        .iter()
        .find(|n| n.label == label)
        .unwrap_or_else(|| panic!("no group labelled {label}"));
    bare(&n.group)
}

fn view_with(key: &str, at: usize) -> View {
    let mut v = View::folded();
    v.open_at(key, at);
    v
}

/// One line per drawn box, in drawn order: `label@x,y`. The whole picture, as
/// a string that can be compared to a golden captured before a change.
fn shape(d: &fathom_layout::Diagram) -> String {
    let mut out = String::new();
    for n in &d.nodes {
        out.push_str(&format!("{}@{},{}\n", n.label, n.x, n.y));
    }
    out
}

/// **The headline measurement.** Eighty-five live nodes, thirteen boxes, and
/// every one of the seventy-two that are not drawn individually is counted in
/// the picture rather than dropped from it.
#[test]
fn eighty_five_nodes_draw_as_thirteen_boxes() {
    let g = hub(40);
    assert_eq!(live(&g), 85, "the fixture is 85 live nodes");

    let whole = fathom_layout::lay_out(&g);
    assert_eq!(
        whole.nodes.len(),
        85,
        "un-aggregated draws one box per node"
    );

    let d = folded(&g);
    assert_eq!(d.nodes.len(), 13, "aggregated draws 13 boxes");

    // 59 §3.6's affordance contract, asserted rather than assumed: what every
    // box stands for adds back up to the estate, so nothing was hidden without
    // being counted.
    let stood: usize = d.nodes.iter().map(|n| n.count).sum();
    assert_eq!(stood, 85, "every live node is inside exactly one box");
}

/// **X3, and the property that makes aggregation worth having.** The drawing
/// stops being a function of estate repetition: 40 spokes and 120 spokes are
/// the same picture, at the same size.
#[test]
fn forty_spokes_and_a_hundred_and_twenty_draw_identically() {
    let a = folded(&hub(40));
    let b = folded(&hub(120));
    assert_eq!(a.nodes.len(), b.nodes.len(), "box count is O(1) in the fan");
    assert_eq!(a.links.len(), b.links.len(), "line count is O(1) too");
    assert_eq!((a.width, a.height), (b.width, b.height), "so is the canvas");

    // The un-aggregated form is not, which is the whole reason.
    assert_eq!(fathom_layout::lay_out(&hub(40)).nodes.len(), 85);
    assert_eq!(fathom_layout::lay_out(&hub(120)).nodes.len(), 245);
}

/// **X2.** Below the threshold the aggregated and un-aggregated pictures are
/// the same picture. There is no regression to weigh against the gain.
#[test]
fn below_the_threshold_aggregation_is_a_no_op() {
    for spokes in 1..=THRESHOLD {
        let g = hub(spokes);
        assert_eq!(
            folded(&g),
            fathom_layout::lay_out(&g),
            "{spokes} spokes: nothing may fire at or below the threshold"
        );
    }
    // And the first count above it does fire.
    let g = hub(THRESHOLD + 1);
    assert!(folded(&g).nodes.len() < fathom_layout::lay_out(&g).nodes.len());
}

/// **DEFECT 5, closed with the measurement that found it.**
///
/// A reviewer re-implemented the pre-aggregation ordering rule and compared:
/// *"spokes=40: 2 of 85 positions differ; first divergence at position 42"*,
/// because the previous attempt routed the un-aggregated picture through run
/// detection and rows moved wherever two nodes with different parents
/// interleave in ULID order. `tests/layout.rs` pinned no coordinates and did
/// not catch it.
///
/// This is that pin. Both strings were captured from the build at the merge
/// base, **before this feature existed**, and every box in them is a live node
/// drawn as itself. If aggregation ever moves the un-aggregated picture again,
/// it fails here and prints which box moved.
#[test]
fn aggregation_does_not_move_the_un_aggregated_picture() {
    assert_eq!(
        shape(&fathom_layout::lay_out(&hub(13))),
        HUB13_BEFORE,
        "lay_out's own ordering changed"
    );
    let after40 = shape(&fathom_layout::lay_out(&hub(40)));
    assert_eq!(
        after40.lines().count(),
        85,
        "the golden is the whole picture"
    );
    assert_eq!(after40, HUB40_BEFORE, "lay_out's own ordering changed");
}

/// **X7, and `59` failure mode 2 — the most dangerous failure in that
/// document.** A member that differs in a declared attribute is carried out of
/// the group and drawn on its own; the aggregate's count is reduced and its
/// range splits around it, which is `59` §9's recommendation exactly.
#[test]
fn a_member_that_differs_is_never_collapsed_into_the_aggregate() {
    let d = folded(&hub(40));
    let labels: Vec<&str> = d.nodes.iter().map(|n| n.label.as_str()).collect();

    for (name, why) in [
        ("spoke-17", "hand-authored among parsed siblings"),
        ("spoke-30", "wired to an interface the others do not have"),
    ] {
        let own = d
            .nodes
            .iter()
            .find(|n| n.label == name)
            .unwrap_or_else(|| panic!("{name} ({why}) must be drawn on its own: {labels:?}"));
        assert_eq!(own.count, 1, "{name} must stand for itself alone");
    }

    // 59 §9: `SPOKE-01–16`, `SPOKE-17`, `SPOKE-18–40`. The aggregate's range
    // never covers a member it is not standing for.
    for want in [
        "spoke-01–spoke-16",
        "spoke-18–spoke-29",
        "spoke-31–spoke-40",
    ] {
        assert!(
            labels.contains(&want),
            "the run must split around the exception: wanted {want} in {labels:?}"
        );
    }
    assert!(
        !labels.contains(&"spoke-01–spoke-40"),
        "a range that covers the exceptions would be a count that lies"
    );
}

/// **`59` §3.6, the silent count.** No box hides members without saying how
/// many, and no collapsed box is drawn without both ends of its range.
///
/// The third assertion is the one the previous attempt wrote as a dead
/// disjunct — `n.count > THRESHOLD || !n.group.ends_with("#0") || n.count > 1`
/// inside a loop that had already skipped `count == 1` — so it could never
/// fire, in the file whose job was to catch exactly the defect it describes. It
/// is live here, on every box, and stated the way round that can fail.
#[test]
fn no_collapsed_box_hides_its_members() {
    for spokes in [7, 12, 13, 19, 40, 120] {
        let d = folded(&hub(spokes));
        for n in &d.nodes {
            if n.count == 1 {
                // A box standing for one node carries that node's own display
                // id — never a group key — or the page posts a key `OP_ELEMENT`
                // refuses. This is DEFECT 1, asserted at every size.
                assert!(
                    !n.id.starts_with("agg:"),
                    "{spokes} spokes: a box standing for one node carries a \
                     group key as its id: {:?}",
                    n.id
                );
                continue;
            }
            assert!(
                n.label.contains('–'),
                "{spokes} spokes: a collapsed box must print a named range, got {:?}",
                n.label
            );
            assert!(
                !n.kind.is_empty(),
                "a collapsed box must print the noun as well as the number"
            );
            assert!(
                n.count > 1,
                "a group of one is drawn as itself (59 §3.14.2)"
            );
        }
        // And the same rule on the lines: a merged line carries its cardinal.
        for l in &d.links {
            assert!(l.members >= 1, "every line stands for at least one edge");
        }
    }
}

/// **DEFECT 1, driven in Rust the same way it was driven in the browser.**
///
/// A run whose length is `1 mod WINDOW` — 13, 19, 25, 31 — leaves a trailing
/// residual holding exactly one member when the window is walked forward once.
/// The previous attempt emitted it as a collapsed box with `count == 1` whose
/// id was a group key, so the page drew a plain box and posted
/// `agg:logical-unit:…#12` to `OP_ELEMENT`, which refused with code 6, and
/// neither Enter nor Space did anything at all.
///
/// The fixture of ten could not reach it. Thirteen and nineteen both can.
#[test]
fn a_residual_of_one_member_is_that_member() {
    // Two runs whose length is `1 mod WINDOW`: thirteen spoke devices, and
    // nineteen units left after `59` §3.11 carried `st0.7` out of the fan.
    for (g, range, last, prefix, len) in [
        (hub(13), "spoke-01–spoke-13", "spoke-13", "device:", 13usize),
        (hub(27), "st0.8–st0.26", "st0.26", "logical-unit:", 19),
    ] {
        assert_eq!(len % WINDOW, 1, "{range}: the case only arises at 1 mod 6");
        let base = folded(&g);
        let key = group_key(&base, range);
        // Walk forward until exactly one member is left over.
        let d = fathom_layout::lay_out_with(&g, &view_with(&key, len - WINDOW - 1));

        let tail = d
            .nodes
            .iter()
            .find(|n| n.label == last)
            .unwrap_or_else(|| panic!("{range}: the last member must be drawn"));
        assert_eq!(tail.count, 1, "{range}: it stands for itself alone");
        assert!(
            tail.id.starts_with(prefix),
            "{range}: it must carry its own display id, not a group key: {:?}",
            tail.id
        );
        assert_eq!(
            tail.group, key,
            "{range}: it still belongs to the group, so Escape can collapse it"
        );
        assert!(
            !tail.label.contains('–'),
            "{range}: one member is not a range"
        );
        // And no box anywhere in that picture pairs a group-key id with a count
        // of one, which is the shape the page mis-drew.
        for n in &d.nodes {
            assert!(
                !(n.count == 1 && n.id.starts_with("agg:")),
                "{range}: {:?} is one node with a group key for an id",
                n.label
            );
        }
    }
}

/// **DEFECT 4.** The leading residual steps the window BACK by one window. It
/// used to reset to zero, so a reader at member 108 of 120 needed eighteen
/// forward activations to get back to 102 — and the module header, the code
/// comment and the report all claimed otherwise.
#[test]
fn the_leading_residual_steps_the_window_back_rather_than_to_the_start() {
    let g = hub(40);
    let base = folded(&g);
    // The fan of thirty-two units left after §3.11 carried `st0.7` out: member
    // 0 of this run is `st0.8`.
    let key = group_key(&base, "st0.8–st0.39");

    let at = 18;
    let d = fathom_layout::lay_out_with(&g, &view_with(&key, at));
    let lead = d
        .nodes
        .iter()
        .find(|n| n.count > 1 && n.label.starts_with("st0.8–"))
        .expect("a leading residual covering everything before the window");
    assert_eq!(lead.label, "st0.8–st0.25", "it names what it is hiding");
    assert_eq!(lead.count, 18);
    assert_eq!(
        lead.group,
        format!("{key}#{}", at - WINDOW),
        "activating it must land one window back, not at the start"
    );

    // And activating it really does land there: the window shows members 12–17.
    let back = fathom_layout::lay_out_with(&g, &view_with(&key, at - WINDOW));
    let shown: Vec<&str> = back
        .nodes
        .iter()
        .filter(|n| n.count == 1 && n.group == key)
        .map(|n| n.label.as_str())
        .collect();
    assert_eq!(
        shown,
        vec!["st0.20", "st0.21", "st0.22", "st0.23", "st0.24", "st0.25"],
        "one window back, not the first page"
    );

    // The previous attempt's behaviour, stated as the thing that must not
    // happen: activating the leading residual landed at offset 0.
    let start = fathom_layout::lay_out_with(&g, &view_with(&key, 0));
    assert_ne!(
        back, start,
        "stepping back one window must not be the same as jumping to the start"
    );
}

/// **DEFECT 8.** `59` §9's DECISION has two halves — *"expansion is windowed on
/// unbounded groups and all-or-nothing on bounded ones"* — and the previous
/// attempt built one `WINDOW` for every kind and reported the decision as
/// complete.
///
/// A LAG member set is bounded: it opens whole, with no residual and no page to
/// walk. A tunnel fan is not: it opens six at a time.
#[test]
fn a_bounded_group_opens_whole_and_an_unbounded_one_opens_a_window() {
    let g = lag(9);
    let base = folded(&g);
    let key = group_key(&base, "xe-0/0/0–xe-0/0/8");
    let open = fathom_layout::lay_out_with(&g, &view_with(&key, 0));

    let members: Vec<&str> = open
        .nodes
        .iter()
        .filter(|n| n.count == 1 && n.group == key)
        .map(|n| n.label.as_str())
        .collect();
    assert_eq!(
        members.len(),
        9,
        "an `ae`'s members open all at once: 59 §3.7"
    );
    assert!(
        !open.nodes.iter().any(|n| n.count > 1 && n.group == key),
        "a bounded group leaves no residual, because there is no page to walk"
    );

    // The unbounded fan in the same fixture family still windows.
    let hubg = hub(40);
    let fan = group_key(&folded(&hubg), "st0.8–st0.39");
    let windowed = fathom_layout::lay_out_with(&hubg, &view_with(&fan, 0));
    assert_eq!(
        windowed
            .nodes
            .iter()
            .filter(|n| n.count == 1 && n.group == fan)
            .count(),
        WINDOW,
        "a spoke fan is unbounded and ordered, so it opens a window"
    );
}

/// **X5, and DEFECT 6(a).** Expanding and collapsing again restores the picture
/// exactly — every box, every coordinate.
///
/// The previous attempt sold this as X5 and asserted `folded(&g) == folded(&g)`
/// with nothing ever expanded: a pure function compared to itself, true by
/// determinism and already covered elsewhere. This one opens the group, checks
/// the picture really changed, then collapses it through the same wire form the
/// page uses and compares the whole `Diagram`.
#[test]
fn expand_then_collapse_restores_the_picture_exactly() {
    let g = hub(40);
    let before = folded(&g);
    let key = group_key(&before, "spoke-01–spoke-16");

    let open = fathom_layout::lay_out_with(&g, &view_with(&key, 0));
    assert!(
        open.nodes.len() > before.nodes.len(),
        "the group did not open: {} boxes either way",
        before.nodes.len()
    );
    assert_ne!(open, before, "expansion must change the picture");

    // Collapsing is dropping the key from the request, which is what the page
    // does. Round-tripped through the wire form rather than through a Rust
    // constructor, so the string the browser sends is the thing under test.
    let back = fathom_layout::lay_out_with(&g, &View::parse(""));
    assert_eq!(back, before, "collapsing must restore the picture exactly");
    assert_eq!(
        back.nodes.len(),
        13,
        "and it is the collapsed picture, not a fresh un-aggregated one"
    );
}

/// **X6.** Expansion is windowed, so no reachable state draws more boxes than
/// never aggregating at all. `59` §3.7 records A3's ladder terminating at 521
/// elements against the 515 it costs never to aggregate; that is the failure
/// this asserts against.
#[test]
fn no_reachable_expansion_draws_more_than_the_un_aggregated_form() {
    for spokes in [13, 19, 40] {
        let g = hub(spokes);
        let ceiling = fathom_layout::lay_out(&g).nodes.len();
        let base = folded(&g);

        // Every group in the picture, opened at every offset it can be walked
        // to — including the offsets that leave a one-member residual.
        let keys: Vec<String> = base
            .nodes
            .iter()
            .filter(|n| n.count > 1)
            .map(|n| bare(&n.group))
            .collect();
        let mut every = View::folded();
        for at in 0..=spokes {
            for k in &keys {
                every.open_at(k, at);
            }
            let d = fathom_layout::lay_out_with(&g, &every);
            assert!(
                d.nodes.len() <= ceiling,
                "{spokes} spokes, every group open at {at}: {} boxes against \
                 {ceiling} un-aggregated",
                d.nodes.len()
            );
        }
    }
}

/// An opened group draws a window of exactly [`WINDOW`] members plus the
/// residuals that state what is still hidden — never the whole fan.
#[test]
fn expansion_is_windowed_and_the_residuals_carry_their_own_counts() {
    let g = hub(40);
    let base = folded(&g);
    let key = group_key(&base, "spoke-31–spoke-40");
    let d = fathom_layout::lay_out_with(&g, &view_with(&key, 0));

    // `spoke-30` is its own run (§3.11 carried it out), so it is drawn whatever
    // this group is doing and is not part of the window.
    let members: Vec<&str> = d
        .nodes
        .iter()
        .filter(|n| n.count == 1 && n.group == key)
        .map(|n| n.label.as_str())
        .collect();
    assert_eq!(
        members,
        vec!["spoke-31", "spoke-32", "spoke-33", "spoke-34", "spoke-35", "spoke-36"],
        "a window of six, anchored at the offset asked for"
    );

    let residual = d
        .nodes
        .iter()
        .find(|n| n.label == "spoke-37–spoke-40")
        .expect("the remainder is a residual, not a silence");
    assert_eq!(
        residual.count, 4,
        "and it states how many it is still hiding"
    );
    assert_eq!(
        residual.group,
        format!("{key}#6"),
        "activating it walks the window on rather than expanding everything"
    );
}

/// **Invariant 9, applied to the folded picture.** Same estate, same view, same
/// coordinates — including which members ended up in which run.
#[test]
fn the_same_estate_folds_identically() {
    assert_eq!(folded(&hub(40)), folded(&hub(40)));
    let v = view_with("agg:device:nonexistent", 6);
    assert_eq!(
        fathom_layout::lay_out_with(&hub(40), &v),
        fathom_layout::lay_out_with(&hub(40), &v),
        "an open key that names no group changes nothing, twice"
    );
}

/// Forty lines landing on one box are one line with a count, never forty
/// coincident paths (`59` failure mode 16).
#[test]
fn lines_onto_a_collapsed_box_merge_and_say_how_many() {
    let d = folded(&hub(40));
    let fan = d
        .links
        .iter()
        .find(|l| l.kind == "HasUnit")
        .expect("the tunnel interface owns the unit fan");
    assert!(
        fan.members > 1,
        "the fan must be drawn as one line carrying its cardinal"
    );
    let drawn: usize = d.links.iter().map(|l| l.members).sum();
    let interior: u32 = d.nodes.iter().map(|n| n.interior).sum();
    assert_eq!(
        drawn + interior as usize,
        fathom_layout::lay_out(&hub(40)).links.len(),
        "every edge in the estate is inside exactly one drawn line, or counted \
         as one this box swallowed"
    );
}

/// **DEFECT 7.** An edge with both ends inside one collapsed box is drawn
/// nowhere — there is no line from a box to itself — and the box's own count
/// cannot say so, because it counts *nodes*. It is counted separately, and
/// this is the fixture that reaches it: a ring of like-kind siblings, whose
/// members all carry one in-edge and one out-edge of the same kind and
/// therefore share a signature.
///
/// Not reachable from junos-srx ingest today. That is why the previous attempt
/// dropped it silently with a comment arguing the count covered it, and why
/// this fixture exists rather than a comment saying it cannot happen.
#[test]
fn an_edge_hidden_inside_a_collapsed_box_is_counted() {
    let g = ring(8);
    let d = folded(&g);
    let collapsed = d
        .nodes
        .iter()
        .find(|n| n.count > 1)
        .expect("eight like-kind siblings collapse");
    assert_eq!(collapsed.count, 8);
    assert_eq!(
        collapsed.interior, 8,
        "the ring's eight edges are all inside the box and none is drawn"
    );

    let whole = fathom_layout::lay_out(&g);
    let drawn: usize = d.links.iter().map(|l| l.members).sum();
    assert_eq!(
        drawn + collapsed.interior as usize,
        whole.links.len(),
        "hidden + drawn must account for every edge in the estate"
    );
    assert!(
        d.nodes
            .iter()
            .filter(|n| n.count == 1)
            .all(|n| n.interior == 0),
        "a plain box swallows nothing"
    );
}

/// ADR-0037. **A role is a fact about ONE node, so only a box standing for one
/// node may print it** — the same rule that already governs `Cell::key` and the
/// hand-placed pin.
///
/// The ring is the fixture that can actually catch the wrong answer: all eight
/// of its devices carry `Device.role = router`, so a `residual` that copied its
/// anchor's role would produce a collapsed box confidently labelled `router`
/// and the test would still pass on any fixture where no role is set. Here it
/// would not: the collapsed box must be blank while the drawn siblings are not.
///
/// Why it matters beyond tidiness: the aggregation signature does not include
/// `role`. A run of like-kind siblings can hold a firewall and a server, so a
/// role printed on their collapsed box is not merely imprecise — it is a claim
/// about eight boxes made from one of them, which is `59` §3.6's silent-count
/// rule in a different coat.
#[test]
fn only_a_box_standing_for_one_device_carries_a_role() {
    let g = ring(8);

    // Un-aggregated: every box stands for one device, and every one says what
    // it is for. This is the half that proves the field is populated at all.
    let whole = fathom_layout::lay_out(&g);
    let devices: Vec<_> = whole.nodes.iter().filter(|n| n.kind == "Device").collect();
    assert_eq!(devices.len(), 8, "the ring draws eight devices");
    assert!(
        devices.iter().all(|n| n.role == "router"),
        "every device in the ring carries Device.role = router: {:?}",
        devices.iter().map(|n| &n.role).collect::<Vec<_>>()
    );
    assert!(
        whole
            .nodes
            .iter()
            .filter(|n| n.kind != "Device")
            .all(|n| n.role.is_empty()),
        "role is a Device field; nothing else may carry one"
    );

    // Folded: the box that stands for eight says nothing about what they are
    // for, even though all eight agree.
    let d = folded(&g);
    let collapsed = d
        .nodes
        .iter()
        .find(|n| n.count > 1)
        .expect("eight like-kind siblings collapse");
    assert!(
        collapsed.role.is_empty(),
        "a box standing for {} nodes printed the role {:?}",
        collapsed.count,
        collapsed.role
    );
}

/// `*` on the wire is `59` §3.7's retained control: *"an engineer who does not
/// believe the count is entitled to see the forty."*
#[test]
fn the_un_aggregated_form_is_reachable_from_the_wire() {
    let g = hub(40);
    assert_eq!(
        fathom_layout::lay_out_with(&g, &View::parse("*")),
        fathom_layout::lay_out(&g)
    );
}
const HUB13_BEFORE: &str = "\
Hub site@24,24\n\
hub-a@314,24\n\
spoke-01@314,86\n\
spoke-02@314,148\n\
spoke-03@314,210\n\
spoke-04@314,272\n\
spoke-05@314,334\n\
spoke-06@314,396\n\
spoke-07@314,458\n\
spoke-08@314,520\n\
spoke-09@314,582\n\
spoke-10@314,644\n\
spoke-11@314,706\n\
spoke-12@314,768\n\
spoke-13@314,830\n\
st0@604,24\n\
st0.0@894,24\n\
st0.1@894,86\n\
st0.2@894,148\n\
st0.3@894,210\n\
st0.4@894,272\n\
st0.5@894,334\n\
st0.6@894,396\n\
st0.7@894,458\n\
st0.8@894,520\n\
st0.9@894,582\n\
st0.10@894,644\n\
st0.11@894,706\n\
st0.12@894,768\n\
10.255.0.1/30@1184,24\n\
";

const HUB40_BEFORE: &str = "\
Hub site@24,24\n\
hub-a@314,24\n\
spoke-01@314,86\n\
spoke-02@314,148\n\
spoke-03@314,210\n\
spoke-04@314,272\n\
spoke-05@314,334\n\
spoke-06@314,396\n\
spoke-07@314,458\n\
spoke-08@314,520\n\
spoke-09@314,582\n\
spoke-10@314,644\n\
spoke-11@314,706\n\
spoke-12@314,768\n\
spoke-13@314,830\n\
spoke-14@314,892\n\
spoke-15@314,954\n\
spoke-16@314,1016\n\
spoke-17@314,1078\n\
spoke-18@314,1140\n\
spoke-19@314,1202\n\
spoke-20@314,1264\n\
spoke-21@314,1326\n\
spoke-22@314,1388\n\
spoke-23@314,1450\n\
spoke-24@314,1512\n\
spoke-25@314,1574\n\
spoke-26@314,1636\n\
spoke-27@314,1698\n\
spoke-28@314,1760\n\
spoke-29@314,1822\n\
spoke-30@314,1884\n\
spoke-31@314,1946\n\
spoke-32@314,2008\n\
spoke-33@314,2070\n\
spoke-34@314,2132\n\
spoke-35@314,2194\n\
spoke-36@314,2256\n\
spoke-37@314,2318\n\
spoke-38@314,2380\n\
spoke-39@314,2442\n\
spoke-40@314,2504\n\
ge-0/0/0@604,86\n\
st0@604,24\n\
st0.0@894,24\n\
st0.1@894,86\n\
st0.2@894,148\n\
st0.3@894,210\n\
st0.4@894,272\n\
st0.5@894,334\n\
st0.6@894,396\n\
st0.7@894,458\n\
st0.8@894,520\n\
st0.9@894,582\n\
st0.10@894,644\n\
st0.11@894,706\n\
st0.12@894,768\n\
st0.13@894,830\n\
st0.14@894,892\n\
st0.15@894,954\n\
st0.16@894,1016\n\
st0.17@894,1078\n\
st0.18@894,1140\n\
st0.19@894,1202\n\
st0.20@894,1264\n\
st0.21@894,1326\n\
st0.22@894,1388\n\
st0.23@894,1450\n\
st0.24@894,1512\n\
st0.25@894,1574\n\
st0.26@894,1636\n\
st0.27@894,1698\n\
st0.28@894,1760\n\
st0.29@894,1822\n\
st0.30@894,1884\n\
st0.31@894,1946\n\
st0.32@894,2008\n\
st0.33@894,2070\n\
st0.34@894,2132\n\
st0.35@894,2194\n\
st0.36@894,2256\n\
st0.37@894,2318\n\
st0.38@894,2380\n\
st0.39@894,2442\n\
10.255.0.1/30@1184,24\n\
";

/// **The mask's counts are in OBJECTS, and one collapsed box is not one object.**
///
/// The defect this pins is the one the rebuild's reviewer found, and it is the
/// silent-count rule failing in the sentence written to enforce it: a
/// thirteen-member group masked away reported *"1 objects and 1 links hidden by
/// the mask"*, because `layers::filter` differenced `nodes.len()` across itself.
/// Before aggregation a box was an object and the two numbers were the same;
/// after it they are different quantities, and the band prints the wrong one.
///
/// Read at thirteen and at forty, per this file's header rule.
#[test]
fn the_mask_hides_objects_and_does_not_count_boxes() {
    for spokes in [THRESHOLD + 7, 40] {
        let g = hub(spokes);
        let folded = fathom_layout::lay_out_with(&g, &View::folded());
        let plain = fathom_layout::lay_out(&g);
        let (_, f) = fathom_layout::layers::filter(&folded, fathom_layout::layers::LayerMask::NONE);

        // The fixture must actually collapse something, or this test passes for
        // the wrong reason -- it would be asserting that two equal numbers are
        // equal, which is exactly how the original defect survived its own test.
        assert!(
            folded.nodes.len() < plain.nodes.len(),
            "at {spokes} the fixture does not aggregate: {} boxes folded vs {} \
             plain, so this test cannot tell an object count from a box count",
            folded.nodes.len(),
            plain.nodes.len()
        );
        assert_eq!(
            f.hidden_objects as usize,
            plain.nodes.len(),
            "at {spokes} the empty mask hid every box, so it hid every object \
             the estate has"
        );
        assert!(
            (f.hidden_objects as usize) > folded.nodes.len(),
            "at {spokes} hidden_objects {} is not larger than the {} boxes that \
             were hidden -- it is still counting shapes",
            f.hidden_objects,
            folded.nodes.len()
        );
        // The same defect on the other axis: a merged stroke stands for many
        // edges, and hiding it hides all of them.
        let edges: usize = plain.links.len();
        assert_eq!(
            f.hidden_edges as usize, edges,
            "at {spokes} the empty mask hid every line, so it hid every edge"
        );
    }
}
