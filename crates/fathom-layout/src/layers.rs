//! The five layers of `56` §4, as data, and the filter that applies them.
//!
//! # The one decision this file exists to protect
//!
//! `56` §3.6, stated as a DECISION and repeated as failure mode 6:
//!
//! > *"layout is computed once, over the union of all layers, and a layer toggle
//! > filters what is drawn. Toggling a layer never moves anything."*
//!
//! So there is no `lay_out(graph, mask)` in this crate and there must never be
//! one. [`filter`] takes a **finished** [`Diagram`] and removes rows from it.
//! Coordinates are copied through untouched, and so is the canvas extent — an
//! L3-only picture keeps the width and height the union needed, which is what
//! makes the viewBox identical across a toggle and therefore makes the toggle
//! visually a *reveal* rather than a rearrangement. `56` §3.6 names the cost in
//! its own words and accepts it: *"an L3-only view is laid out to accommodate
//! physical nodes that are not being drawn, so it looks sparse … There will be
//! gaps whose cause is invisible."*
//!
//! The defect this prevents is the one `56` §11 row 6 predicts: *"Users stop
//! using layer toggles within a week."* A picture that rearranges under a toggle
//! destroys the mental map the toggle exists to interrogate.
//!
//! # What the table can and cannot say in this build
//!
//! §4.1 is a **projection** table: it gives each kind a *treatment* per layer —
//! `bracket`, `band`, `port stub`, `sub-row inside the device box`, `badge`,
//! `conduit`. This build draws one form: a box. So the table is read here for
//! **membership only** — *is this kind drawn at this layer* — and the treatment
//! column is deliberately dropped rather than approximated. A `Zone` at the
//! security layer is a box here and `56` §4.4 says it is a bracket; drawing a
//! box and calling it a bracket would be worse than drawing a box, because the
//! bracket is what carries `56` §4.4's tier-2 and tier-3 degradation and a box
//! silently claims tier 1. [`Projection::treatment`] carries the word §4.1 uses
//! so the gap is legible from the code rather than only from this comment.
//!
//! # Kinds §4.1 does not name
//!
//! Twenty-three of `schema/`'s forty-eight kinds have no row in §4.1 — the whole
//! of `19`'s physical model (`PhysicalPort`, `Cable`, `PassiveNode`, `Premises`)
//! and its service model (`Tenant`, `Service`, `ServiceType`, `ServiceEndpoint`,
//! `ServicePath`, `PathSegment`), plus the phase-1/phase-2 proposal and policy
//! objects, the settings kinds, and the two set kinds. `59` §3.13 already filed
//! the physical half of this as a hole in `56` and left it as *"`56`'s to
//! answer"*.
//!
//! **An unnamed kind is drawn at every layer and counted.** The alternative —
//! guessing a row by analogy with a neighbouring kind — is exactly the drift
//! `59` §3.13 complains about, and it fails in the invisible direction: a wrong
//! guess *hides* an element and the operator has no way to discover it. Drawing
//! everywhere is not a claim about layer membership; being sometimes-hidden
//! would be. [`Filter::untabled_nodes`] is the number the view band prints so
//! the picture says how much of itself is unclassified.
//!
//! The corollary that surprises people, so it is stated here: **`AddressSet` and
//! `ApplicationSet` are untabled even though `AddressObject` and `Application`
//! are inspector-only.** Extending a row to its obvious sibling is still
//! inventing a row. Both are named in the gap list rather than assumed.
//!
//! # Determinism
//!
//! Every function here is a `const fn` over an enum or a walk of an ordered
//! slice. No map, no clock, no allocation whose order depends on a hash
//! (invariant 9). `filter` preserves input order exactly, so a filtered diagram
//! is a subsequence of the unfiltered one.

use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

use crate::Diagram;

/// One of `56` §4's five layers. There is no sixth, permanently — §4.7's rule is
/// that *"a layer is a set of graph elements. An attribute of elements is a
/// treatment, not a layer"*, which is why freshness, findings and AI-proposal
/// are treatments and not the sixth bit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Layer {
    Physical,
    L2,
    L3,
    Security,
    Overlay,
}

impl Layer {
    /// Declaration order **is** the wire order: bit 0 is physical, bit 4 is
    /// overlay. A layer is appended, never inserted — the same rule
    /// `InvKind::ALL` carries, for the same reason. There will never be a sixth
    /// (§4.7), so the rule costs nothing and closes the class of bug where a
    /// stored mask means something different after an edit.
    pub const ALL: [Layer; 5] = [
        Layer::Physical,
        Layer::L2,
        Layer::L3,
        Layer::Security,
        Layer::Overlay,
    ];

    pub const fn bit(self) -> u8 {
        1u8 << (self as u8)
    }

    /// The name as the view band prints it — lowercase, unpunctuated, the
    /// margin-tab register `56` §5.5 sets for anything that is not an
    /// identifier.
    pub const fn name(self) -> &'static str {
        match self {
            Layer::Physical => "physical",
            Layer::L2 => "l2",
            Layer::L3 => "l3",
            Layer::Security => "security",
            Layer::Overlay => "overlay",
        }
    }
}

/// `56` §4's 5-bit set. `LayerMask` is session state and never graph data
/// (§0's governing rule: the only view-local state in the diagram is the
/// pan/zoom transform and this).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LayerMask(u8);

impl LayerMask {
    /// All five on. §4 counts *31 non-empty combinations*; the empty mask is the
    /// thirty-second and is legal here — a page whose five toggles are all off
    /// must get an empty picture and a true sentence, not a refusal it has to
    /// pre-empt.
    pub const ALL: LayerMask = LayerMask(0b0001_1111);
    pub const NONE: LayerMask = LayerMask(0);
    /// Every bit above this is a page defect, not a layer.
    pub const WIDTH: u8 = 5;

    /// `None` when a bit outside the five is set. Refusing is deliberate:
    /// masking the stray bits off would let a page send `0xFF` and receive a
    /// picture that silently disagrees with its own toggles.
    pub const fn from_bits(bits: u8) -> Option<LayerMask> {
        if bits & !LayerMask::ALL.0 == 0 {
            Some(LayerMask(bits))
        } else {
            None
        }
    }

    pub const fn bits(self) -> u8 {
        self.0
    }

    pub const fn contains(self, layer: Layer) -> bool {
        self.0 & layer.bit() != 0
    }

    pub const fn intersects(self, other: LayerMask) -> bool {
        self.0 & other.0 != 0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub const fn with(self, layer: Layer) -> LayerMask {
        LayerMask(self.0 | layer.bit())
    }

    pub const fn without(self, layer: Layer) -> LayerMask {
        LayerMask(self.0 & !layer.bit())
    }

    pub const fn toggled(self, layer: Layer) -> LayerMask {
        LayerMask(self.0 ^ layer.bit())
    }

    pub const fn count(self) -> u32 {
        self.0.count_ones()
    }
}

const PHY: u8 = Layer::Physical.bit();
const L2: u8 = Layer::L2.bit();
const L3: u8 = Layer::L3.bit();
const SEC: u8 = Layer::Security.bit();
const OVL: u8 = Layer::Overlay.bit();

/// One row of `56` §4.1, read for this build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Projection {
    /// The layers the kind is drawn at. Empty means *drawn nowhere* — §4.1's
    /// `— (inspector only)`, which is a decision and not an omission.
    pub layers: LayerMask,
    /// False when §4.1 has no row for the kind at all. Such a kind is given
    /// [`LayerMask::ALL`] above, so `tabled: false` is the only way to tell
    /// *"drawn everywhere because the spec says so"* (`Site`, `Device`,
    /// `ExternalPeer`) from *"drawn everywhere because the spec is silent"*.
    pub tabled: bool,
    /// The word §4.1 uses for the treatment, or `"box"` where §4.1 says box and
    /// where the kind is untabled. This build draws a box regardless; the word
    /// is carried so the distance between what is drawn and what is specified
    /// is readable at the row that decides it, not only in prose above it that
    /// will drift from it. **Nothing branches on it.**
    ///
    /// **Measured cost: 1,264 bytes of the release module** (879,554 with it,
    /// 878,290 without, `wasm32-unknown-unknown` release, 2026-08-15). That is
    /// the cheapest thing in this file to cut if `44` §5.2's ceiling ever gets
    /// close, and it is recorded here so the next byte squeeze does not have to
    /// re-measure to find that out.
    pub treatment: &'static str,
}

const fn tabled(bits: u8, treatment: &'static str) -> Projection {
    Projection {
        layers: LayerMask(bits),
        tabled: true,
        treatment,
    }
}

const UNTABLED: Projection = Projection {
    layers: LayerMask::ALL,
    tabled: false,
    treatment: "box · no row in 56 §4.1",
};

/// `56` §4.1's projection table, kind by kind.
///
/// The match is **exhaustive with no wildcard arm**, which is the guard: adding
/// a kind to `schema/` stops this crate compiling until somebody decides which
/// layers it belongs to. That is the defect `59` §3.13 found by grepping — a
/// projection table that predates four kinds and says nothing about them, with
/// nothing anywhere to notice. A compile error is a cheap noticer.
pub const fn projection_of(kind: NodeKind) -> Projection {
    match kind {
        // --- drawn at every layer, by the table --------------------------
        // Site is a band and Device is subdivided by Chassis at the physical
        // layer; both are boxes here.
        NodeKind::Site => tabled(PHY | L2 | L3 | SEC | OVL, "band"),
        NodeKind::Device => tabled(PHY | L2 | L3 | SEC | OVL, "box"),
        NodeKind::ExternalPeer => tabled(PHY | L2 | L3 | SEC | OVL, "box, rank 0"),

        // --- physical only ----------------------------------------------
        NodeKind::Chassis => tabled(PHY, "sub-row inside the device box"),
        NodeKind::Interface => tabled(PHY, "port stub on the device edge"),

        // The two aggregate kinds are the same three layers and differ only in
        // treatment — §4.2's whole worked answer is that a reth brackets at the
        // device end only while a LAG brackets at both, and neither difference
        // is expressible in a box. The L3 column is conditional in §4.1 (*"if
        // it has units with addresses"*); the condition is a predicate over the
        // graph and this table is a function of the kind, so L3 is included
        // unconditionally and the kind is over-drawn rather than under-drawn.
        NodeKind::AggregateInterface => tabled(PHY | L2 | L3, "bracket joining member ports"),
        NodeKind::RethInterface => tabled(PHY | L2 | L3, "bracket spanning two chassis sub-rows"),

        // --- L3 and overlay ----------------------------------------------
        NodeKind::TunnelInterface => tabled(L3 | OVL, "interface stub · conduit endpoint"),

        // Three conditional columns in §4.1, all three included for the reason
        // given above: a unit is a stub at L2 only if `EthernetSwitching`, and
        // at security only if it is a `ZoneMember`.
        NodeKind::LogicalUnit => tabled(L2 | L3 | SEC, "stub"),

        NodeKind::Address => tabled(L3, "label on the unit"),
        NodeKind::Vlan => tabled(L2, "band across the devices that carry it"),
        NodeKind::RoutingInstance => tabled(L3, "box containing its units"),
        NodeKind::StaticRoute => tabled(L3, "arrow to the next-hop unit"),
        // §4.8, added 2026-08-11. Both belong to L3 and to no other layer: an
        // adjacency is an agreement between two addresses, which does not exist
        // on the physical layer and would fight the conduit on the overlay one.
        NodeKind::RoutingProtocol => tabled(L3, "badge on the RI box"),
        NodeKind::ProtocolAdjacency => tabled(L3, "line between the two units that peer"),

        // --- security ------------------------------------------------------
        NodeKind::Zone => tabled(SEC, "bracket around its member units"),
        NodeKind::PolicySet => tabled(SEC, "edge between two zone brackets"),
        NodeKind::SecurityPolicy => tabled(SEC, "count on the PolicySet edge"),
        NodeKind::NatRuleSet => tabled(SEC, "tick on the scoped unit or zone"),

        // --- overlay --------------------------------------------------------
        NodeKind::Tunnel => tabled(OVL, "conduit"),
        NodeKind::IpsecVpn => tabled(OVL, "endpoint label on the conduit"),
        NodeKind::IkeGateway => tabled(OVL, "label on the endpoint: peer + version"),
        NodeKind::TrafficSelector => tabled(OVL, "label on the conduit midpoint"),

        // --- drawn nowhere, by the table -------------------------------------
        // §4.1: `— (inspector only)`. This is the one place the layer model
        // REMOVES something from today's picture, and it does so on the
        // strength of an explicit row rather than a guess. An address book is
        // an ordered list of names; there is no position in a topology where
        // one belongs, and `56` §4.4's argument about the policy list applies
        // unchanged — the inspector is the right place for a list.
        NodeKind::AddressObject | NodeKind::Application => tabled(0, "inspector only"),

        // --- no row in §4.1 ---------------------------------------------------
        // Drawn everywhere and counted. Grouped by why the gap exists, because
        // they are not one question and answering them needs different people.
        //
        // (a) `19`'s physical model, which postdates `56` §4.1 — `59` §3.13
        //     grepped `56` for these and found nothing.
        NodeKind::PhysicalPort
        | NodeKind::Cable
        | NodeKind::PassiveNode
        | NodeKind::Premises
        // (b) `19`'s service model, which `56` does not mention at all.
        | NodeKind::Tenant
        | NodeKind::Service
        | NodeKind::ServiceType
        | NodeKind::ServiceEndpoint
        | NodeKind::ServicePath
        | NodeKind::PathSegment
        // (c) Phase-1/phase-2 objects behind the three overlay kinds §4.1 does
        //     name. A proposal has no position; it is almost certainly a label
        //     on the conduit or an inspector row, and "almost certainly" is not
        //     a row.
        | NodeKind::IkeProposal
        | NodeKind::IkePolicy
        | NodeKind::IpsecProposal
        | NodeKind::IpsecPolicy
        // (d) Members and sets of kinds §4.1 does name. `NatRule` sits under a
        //     tabled `NatRuleSet`; `AddressSet` and `ApplicationSet` sit beside
        //     inspector-only `AddressObject` and `Application`. Extending a row
        //     to its obvious sibling is still inventing a row.
        | NodeKind::NatRule
        | NodeKind::AddressSet
        | NodeKind::ApplicationSet
        // (e) Per-device settings, and the redundancy group §4.2 draws as a
        //     LABEL on the reth bracket rather than as an element of its own.
        | NodeKind::RedundancyGroup
        | NodeKind::SecurityFlowSettings
        | NodeKind::SystemSettings
        | NodeKind::NtpServer
        | NodeKind::SyslogTarget
        // (f) `56` §1.3 puts learned routes out of scope as runtime state, and
        //     `11` §6.9 keeps them out of the graph — but the kind exists, so
        //     something could hold one, and hiding it on the strength of a
        //     scope sentence would be the invisible failure again.
        | NodeKind::LearnedRoute => UNTABLED,
    }
}

/// The layers a kind is drawn at.
pub fn layers_of(kind: NodeKind) -> LayerMask {
    projection_of(kind).layers
}

/// `56` §4.1's four edge rows.
///
/// Unlike [`projection_of`] this match **has a wildcard**, and the asymmetry is
/// deliberate. Eighty-one edge kinds against §4.1's four rows would be
/// seventy-seven hand-written `ALL`s carrying no information, and the default is
/// safe in a way the node default is not: an edge is drawn only when both its
/// endpoints are drawn ([`filter`]), so an unnamed edge kind is already governed
/// by the node table and `ALL` here means *"add no constraint of your own"*
/// rather than *"draw this everywhere"*.
pub fn layers_of_edge(kind: EdgeKind) -> LayerMask {
    match kind {
        // Physical and L2, per §4.1. At L2 §4.1 says *"collapsed through
        // aggregates"*, which this build does not do.
        EdgeKind::Link => LayerMask(PHY | L2),
        // *"line, with trunk/access marking"* — the marking is `56` §5.2 G6 and
        // is not drawn here.
        EdgeKind::VlanMember => LayerMask(L2),
        // §4.1: *"membership in the bracket, not a line"*. There is no bracket
        // in this build, so it IS a line — drawn rather than dropped, because
        // `70` §16.1's rule is that an incomplete drawing is marked, never
        // refused, and a zone with no visible membership at all would be the
        // security layer saying nothing.
        EdgeKind::ZoneMember => LayerMask(SEC),
        _ => LayerMask::ALL,
    }
}

/// What [`filter`] removed, so the view band can say so.
///
/// `59`'s governing rule, applied to layers: *"A COLLAPSE THAT DOES NOT NAME
/// WHAT IT HID AND HOW MANY THERE WERE IS NOT A BETTER DIAGRAM — IT IS A LIE
/// WITH FEWER ELEMENTS."* A layer toggle hides more than the operator asked for
/// whenever an edge loses an endpoint, and these counts are how the picture
/// admits it.
///
/// **These count OBJECTS AND EDGES, NOT SHAPES**, and that distinction is the
/// whole reason the fields were renamed on 2026-08-15. Before aggregation a box
/// was an object and the two were the same number; after it, one hidden box can
/// carry thirteen addresses, and a band reading *"1 objects hidden by the mask"*
/// is the silent-count rule failing in the sentence that exists to enforce it.
/// The shapes are `Diagram::nodes.len()`, which the caller already has; what it
/// cannot recover afterwards is what went away, so that is what is reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Filter {
    pub mask: LayerMask,
    /// Graph objects the mask removed — summed over the removed boxes' `count`,
    /// so a collapsed group of thirteen reports thirteen.
    pub hidden_objects: u32,
    /// Graph edges removed — by their own layer set **or** by losing an
    /// endpoint — summed over the removed lines' `members`.
    pub hidden_edges: u32,
    /// Boxes still drawn that `56` §4.1 has no row for. Not an error and not a
    /// hidden thing: the number of shapes in the picture whose presence at this
    /// layer nothing has decided. **Shapes, deliberately** — the reader is being
    /// told which drawn things are unclassified, and a collapsed group is one
    /// drawn thing whatever it stands for.
    pub untabled_nodes: u32,
}

/// Apply a mask to a finished layout.
///
/// **After layout, never during it** — see the module comment. `width` and
/// `height` are copied through unchanged, so two masks over one graph produce
/// two pictures with one viewBox and every surviving box at the same
/// coordinates.
pub fn filter(d: &Diagram, mask: LayerMask) -> (Diagram, Filter) {
    // Sorted, not hashed: invariant 9 forbids a hash-ordered collection below
    // the host boundary, and `d.nodes` is already in layout order so the sort is
    // over a small key set.
    let mut kept: Vec<&str> = Vec::new();
    let mut nodes = Vec::with_capacity(d.nodes.len());
    let mut untabled_nodes = 0u32;
    // Accumulated on the way OUT rather than differenced at the end: after
    // aggregation `nodes.len()` and the number of objects are different
    // quantities, so `d.nodes.len() - nodes.len()` answers a question nobody
    // asked. Summing each removed box's own `count` answers the one the band
    // prints. Same for the links, whose `members` is the edge count a merged
    // stroke stands for.
    let mut hidden_objects = 0u32;
    let mut hidden_edges = 0u32;
    for n in &d.nodes {
        // The round trip through the kind's own name is exact: `Node::kind` is
        // `NodeKind::name()`'s `&'static str` and `from_name` is its inverse.
        // A kind that does not round-trip cannot be classified, so it is drawn
        // and counted as untabled rather than dropped.
        let p = match NodeKind::from_name(n.kind) {
            Some(k) => projection_of(k),
            None => UNTABLED,
        };
        if p.layers.intersects(mask) {
            if !p.tabled {
                untabled_nodes += 1;
            }
            kept.push(n.id.as_str());
            nodes.push(n.clone());
        } else {
            hidden_objects += n.count as u32;
        }
    }
    kept.sort_unstable();

    let drawn = |id: &str| kept.binary_search(&id).is_ok();
    let mut links = Vec::with_capacity(d.links.len());
    for l in &d.links {
        let own = match EdgeKind::from_name(l.kind) {
            Some(k) => layers_of_edge(k),
            None => LayerMask::ALL,
        };
        // Both endpoints, always. An edge to a box that is not drawn is a line
        // into empty space, and drawing one is how a filtered picture starts
        // asserting relationships between things it is not showing.
        if own.intersects(mask) && drawn(&l.from) && drawn(&l.to) {
            links.push(l.clone());
        } else {
            hidden_edges += l.members as u32;
        }
    }

    let f = Filter {
        mask,
        hidden_objects,
        hidden_edges,
        untabled_nodes,
    };
    (
        Diagram {
            nodes,
            links,
            width: d.width,
            height: d.height,
        },
        f,
    )
}
