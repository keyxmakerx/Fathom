//! The rack elevation — physical placement, projected (ADR-0035).
//!
//! # Why this is not the diagram, and must never be built inside it
//!
//! A network diagram is a layered layout over a typed graph: the y coordinate
//! is COMPUTED — a rank derived from edges, meaningful only relative to the
//! other nodes, and free to move when a neighbour arrives.
//!
//! A rack elevation inverts that. **The vertical axis IS the model.** U12 means
//! U12 whether or not anything else is in the frame, and it means the same U12
//! tomorrow when six more boxes land. Feeding a given position into a layout
//! that computes positions has only two outcomes and both are wrong: the layout
//! overrides the datum and the fact is lost, or every node is pinned and the
//! layout is an identity function wrapped in crossing-reduction machinery that
//! is paid for in module bytes and never used.
//!
//! There is a third reason and it is the decisive one. **A rack's EMPTY units
//! are information** — "is there room for this box, and where" is most of what
//! an elevation is consulted for. A graph layout has no concept of an empty
//! position; it draws nodes and the edges between them. The gaps here are
//! drawn because the grid is drawn, not because anything occupies them.
//!
//! So: a separate projection, and the geometry is arithmetic rather than
//! layout. This crate returns the numbers; the page multiplies. That split is
//! also a byte decision — see the module doc on `elevation`.
//!
//! # What it cannot do, stated here rather than discovered
//!
//! **Nothing parses a rack.** No Junos statement — none this project has
//! established for any platform — says which rack a box is in or at what
//! height. Every `Rack` and every `MountedIn` is `Origin::Hand`. This face is
//! therefore a sibling of the hand-authoring door, not of the parser: it can
//! only ever show what a person put in it, and `70` §16's rule applies
//! throughout — incomplete is drawn and MARKED, never refused.

use fathom_graph::{Edge, Graph, NodeId};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind, RackUnitNumbering};

use crate::element::display_name;
use crate::render::{key, value_cell, UNKNOWN};

/// One typed read of one edge field.
///
/// `MountedIn` is the first edge in this project whose fields anything reads,
/// and `fathom-schemagen` generates accessor modules for KINDS only — all 49
/// of them, and no edges. Two ways out; this is the cheaper one and the
/// rejected one is worth naming.
///
/// **Rejected: teach the generator to emit edge accessors.** That is the more
/// principled fix and it should happen eventually — it is how `Link.media` and
/// `VlanMember.mode` will be read when something reads them. It is rejected
/// *here* because it edits a shared generator while three sibling sessions are
/// in flight, and because it would regenerate every edge in the tree to serve
/// one caller.
///
/// **Taken: `bag::typed` against a looked-up key** — which is exactly what a
/// generated accessor's body is. ADR-0008 is satisfied because the key comes
/// from `key()`, a lookup in the generated `FIELD_KEYS` registry by declared
/// name: no integer is hand-copied, and a renamed field panics at the lookup
/// rather than silently reading the wrong slot.
fn edge_field<'a, T: std::any::Any>(edge: &'a Edge, name: &'static str) -> Option<&'a T> {
    fathom_ir::bag::typed::<T, _>(edge, key(name)).ok()
}

/// One occupied run of units.
pub struct Slot {
    /// The chassis' display id — the page addresses the box by this.
    pub id: String,
    /// The owning device's display name, or `—` where the chassis is orphaned
    /// (a chassis with no `HasChassis` in-edge is legal; the weld relies on it).
    pub device: String,
    /// `chassis 0` — the member index, which is what distinguishes the two
    /// boxes of a cluster and is the whole reason placement hangs off `Chassis`
    /// rather than off `Device`.
    pub chassis: String,
    /// The lowest-numbered unit occupied.
    pub position_u: u8,
    /// `None` means the height was never stated. It is NOT defaulted to 1 here:
    /// the page draws one unit and marks it, so "1U" and "nobody said" stay
    /// distinguishable in the picture. Collapsing them here would launder an
    /// absence into a measurement.
    pub height_u: Option<u8>,
    /// `front` | `rear` | `—`.
    pub face: &'static str,
}

impl Slot {
    /// Units actually drawn. An unstated height draws as one unit — the page
    /// marks it, this does not silently become a fact.
    fn drawn(&self) -> u8 {
        self.height_u.unwrap_or(1).max(1)
    }

    /// The highest-numbered unit this run covers. Saturating: a `position_u`
    /// near 255 with a tall height must not wrap into a low number and appear
    /// to sit at the bottom of the frame (`Cargo.toml` keeps overflow-checks on
    /// in release for exactly this class, and this arithmetic is reached from
    /// user input).
    fn last_u(&self) -> u8 {
        self.position_u
            .saturating_add(self.drawn().saturating_sub(1))
    }
}

/// One rack and everything placed in it.
pub struct Elevation {
    pub id: String,
    pub label: String,
    /// Capacity in units.
    pub height_u: u8,
    /// `true` when U1 is at the floor. Read from `Rack.unit_numbering`, never
    /// assumed — ADR-0035 records the three sources that failed to establish a
    /// universal convention, which is why this is data.
    pub ascending: bool,
    /// The stored token, for the page to print. A rack whose numbering is the
    /// generated `Unknown` arm renders its token verbatim rather than being
    /// silently treated as ascending.
    pub numbering: String,
    /// Placements that fit, ordered by `position_u`.
    pub slots: Vec<Slot>,
    /// Placements naming a unit the frame does not have. **Named, never
    /// dropped and never clipped**: a 42U rack with a box recorded at U48 is a
    /// data error somebody must see, and silently drawing it at U42 would
    /// destroy the evidence of the error.
    pub overflow: Vec<Slot>,
    /// Pairs of chassis display ids whose runs intersect. Two boxes cannot
    /// occupy one unit, so this is always a defect in the record — reported,
    /// not resolved, because this face has no basis for choosing which is right.
    pub collisions: Vec<(String, String)>,
}

/// One rack's stored label, or `None` where it was never set.
///
/// Separate from `value_cell`, which renders `—` for an unset field: the
/// find-or-create in `OP_RACK_PLACE` matches on this, and a rack with no label
/// must NOT match another rack with no label. Rendering both as `—` and
/// comparing the rendering would silently merge every unlabelled frame in the
/// estate into one.
pub fn rack_label(g: &Graph, rack: NodeId) -> Option<String> {
    let node = g.node(rack)?;
    fathom_ir::generated::accessors::rack::label(node)
        .ok()
        .map(|t| t.0.clone())
}

/// The elevation of one rack.
///
/// Returns the numbers and none of the geometry. `y` is one multiply and one
/// subtract from `position_u`, `height_u` and `ascending`, and it is done in
/// the page: page bytes are ARTIFACT bytes (`44` §5.5's 4.5 MB budget) while
/// this crate is linked into the WASM module, which is the constraint that
/// actually binds. Putting the arithmetic here would buy nothing and spend the
/// scarce budget instead of the ample one.
pub fn elevation(g: &Graph, rack: NodeId) -> Option<Elevation> {
    if rack.kind != NodeKind::Rack {
        return None;
    }
    let node = g.node(rack)?;
    let height_u = *fathom_ir::generated::accessors::rack::height_u(node).ok()?;
    let numbering = fathom_ir::generated::accessors::rack::unit_numbering(node).ok();
    // A rack with no stated direction cannot be drawn, and the caller renders
    // that refusal. `ascending` is not defaulted: an elevation drawn the wrong
    // way up is upside down in every position while looking entirely plausible,
    // which is the silent wrongness `56` §0 exists to prevent.
    let ascending = match numbering {
        Some(RackUnitNumbering::Ascending) => true,
        Some(RackUnitNumbering::Descending) => false,
        // The generated unknown arm: a token from a newer schema. Drawn
        // ascending would be a guess, so it is carried to the page as its own
        // token and the page refuses the picture, not this function.
        _ => true,
    };
    let numbering_token = match numbering {
        Some(RackUnitNumbering::Ascending) => "ascending".to_owned(),
        Some(RackUnitNumbering::Descending) => "descending".to_owned(),
        Some(RackUnitNumbering::Unknown(t)) => t.clone(),
        None => UNKNOWN.to_owned(),
    };

    let mut all: Vec<Slot> = Vec::new();
    for edge in g.inn(rack, EdgeKind::MountedIn) {
        let chassis = edge.from;
        let Some(position_u) = edge_field::<u8>(edge, "MountedIn.position_u").copied() else {
            // `position_u` is `card: "1"`; an edge without one was written by
            // something that bypassed the opcode. Skipping it silently would
            // hide the box entirely, so it is treated as an overflow row —
            // visible, and obviously wrong.
            all.push(Slot {
                id: fathom_graph::ElementId::Node(chassis).to_string(),
                device: owner_name(g, chassis),
                chassis: display_name(g, chassis),
                position_u: 0,
                height_u: None,
                face: face_word(edge),
            });
            continue;
        };
        all.push(Slot {
            id: fathom_graph::ElementId::Node(chassis).to_string(),
            device: owner_name(g, chassis),
            chassis: display_name(g, chassis),
            position_u,
            height_u: edge_field::<u8>(edge, "MountedIn.height_u").copied(),
            face: face_word(edge),
        });
    }
    // Order by position, then by id so two boxes at one unit have a stable
    // order rather than an edge-iteration-order one (invariant 9).
    all.sort_by(|a, b| {
        a.position_u
            .cmp(&b.position_u)
            .then_with(|| a.id.cmp(&b.id))
    });

    let (slots, overflow): (Vec<Slot>, Vec<Slot>) = all
        .into_iter()
        .partition(|s| s.position_u >= 1 && s.last_u() <= height_u);

    // Overlap, on the drawn runs. O(n^2) over the boxes in ONE rack, which is
    // tens; a sweep would be fewer comparisons and more code, and code is the
    // scarce resource here.
    let mut collisions: Vec<(String, String)> = Vec::new();
    for (i, a) in slots.iter().enumerate() {
        for b in slots.iter().skip(i + 1) {
            // Same-unit runs on OPPOSITE faces are not a collision: front and
            // rear are different mounting positions and a rack full of
            // back-to-back pairs is normal, not a defect. Only an unstated
            // face collides with everything, because nobody has said it does
            // not.
            let faces_differ = a.face != b.face && a.face != UNKNOWN && b.face != UNKNOWN;
            if !faces_differ && a.position_u <= b.last_u() && b.position_u <= a.last_u() {
                collisions.push((a.id.clone(), b.id.clone()));
            }
        }
    }

    Some(Elevation {
        id: fathom_graph::ElementId::Node(rack).to_string(),
        label: value_cell(g, rack, key("Rack.label")),
        height_u,
        ascending,
        numbering: numbering_token,
        slots,
        overflow,
        collisions,
    })
}

/// The device a chassis belongs to, or `—`. A chassis with no containment
/// parent is legal (every paste can produce one), so this never panics.
fn owner_name(g: &Graph, chassis: NodeId) -> String {
    match g.owner(chassis) {
        Some(d) => display_name(g, d),
        None => UNKNOWN.to_owned(),
    }
}

fn face_word(edge: &Edge) -> &'static str {
    use fathom_ir::generated::ir_types::MountedInFace;
    match edge_field::<MountedInFace>(edge, "MountedIn.face") {
        Some(MountedInFace::Front) => "front",
        Some(MountedInFace::Rear) => "rear",
        // The generated unknown arm reaches here too, and `—` is right for it:
        // a face token this build does not know is not a face it can draw.
        _ => UNKNOWN,
    }
}
