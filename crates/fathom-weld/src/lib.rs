//! fathom-weld: one ingest fragment applied onto the typed store as one
//! **new** device (WO-09 — the join between `76` §7.2's S6 and S3 slices).
//!
//! `fathom-ingest` turns pasted junos-srx text into a typed `Fragment`;
//! `fathom-graph` holds typed nodes and edges. This crate is the one call that
//! carries the first into the second: every fragment node becomes a store node
//! with a minted ULID, every `FragNode.owner` becomes the containment edge the
//! schema declares for that (owner kind, child kind) pair, every fragment edge
//! becomes a store edge, every field assertion becomes a `set_field` carrying
//! an `Origin::Parsed` provenance record with the capture and the
//! post-redaction byte span that produced it, `Device.platform` is stamped,
//! and the whole apply lands in one caller-labelled batch.
//!
//! **First application only.** Nothing here reconciles a re-parse, resolves a
//! reference against the existing store, or decides what a second paste of the
//! same box means: `11` §10.4's re-identification has no implementation
//! anywhere (WO-09 §8 item 1, §10 item 1). Applying two captures of one box
//! produces two `Device` nodes, and `apply_new_device`'s name says so.
//!
//! **What changed on 2026-08-09, and what did not.** This comment used to add
//! *"and `schema/schema.yaml` declares `identity: []` for `Device`"* as a second
//! reason. That is no longer true — `Device` declares `[hostname, platform]`
//! then `[platform, management_address]`, and `Site` declares its two
//! (`70` §16.3). The behaviour here is unchanged and correct: **a declared
//! identity tuple is not an implementation of one.** Nothing in the tree
//! evaluates a tuple against a node's values, so this crate still cannot
//! recognise a box it has seen. The line is corrected rather than deleted
//! because a stale reason in a doc comment is how a future reader concludes the
//! work is blocked when it is merely unwritten.
//!
//! **Pure** (invariant 9): no clock, no entropy source, no environment read,
//! no I/O, and no hash-ordered collection — `BTreeMap`/`BTreeSet` and sorted
//! `Vec` only, so iteration order is a pure function of content. Everything
//! the weld cannot derive from the fragment is a `Manifest` field the caller
//! supplies.

#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

pub mod apply;
pub mod mint;
pub mod plan;
pub mod prov;

pub use apply::{apply_new_device, Unresolved, WeldError, WeldOutput};
pub use mint::{Mint, MintError};

use fathom_ir::generated::ir_types::{EdgeClass, EdgeKind, NodeKind};

/// Everything the weld cannot know (invariant 9; `fathom-id`'s no-clock rule).
#[derive(Debug, Clone)]
pub struct Manifest<'a> {
    /// Host clock, once, for the whole apply. Becomes every record's
    /// `asserted_at` and the timestamp half of every minted ULID.
    pub at: fathom_graph::Timestamp,
    /// Host entropy, once: 80 bits, the base of the mint (§4.4).
    pub entropy: u128,
    /// Who pasted it. `11` §8.2's `Actor::Parser` is deferred (§10 item 4).
    pub actor: fathom_graph::Actor,
    /// The batch's undo label (`53` §7.2, `BoundedText<60>`). Passed through:
    /// an over-long label is the store's `LabelTooLong`, surfaced, never
    /// truncated here.
    pub batch: fathom_graph::BatchId,
    pub label: &'a str,
    /// The platform whose dictionary parsed the capture — in practice
    /// `PlatformId(dict.platform().to_owned())`. A foreign key into
    /// `schema/platforms.yaml` (`62` §3.4); this crate does not re-validate it.
    pub platform: fathom_ir::scalar::PlatformId,
}

/// The containment edge kind the schema declares for one (owner, child) pair,
/// computed from the generated tables — never a hand-written table (ADR-0008).
/// `None` when no containment edge admits the pair.
///
/// Uniqueness — that no pair is admitted by two containment edge kinds — is
/// not assumed here; it is proved over all 48 × 48 pairs by
/// `tests/containment.rs`, which is WO-09's G5. This function returns the
/// first admitting kind in `EdgeKind::ALL` order, so if uniqueness ever broke
/// the gate would go red rather than the answer going quietly ambiguous.
pub fn containment_edge(owner: NodeKind, child: NodeKind) -> Option<EdgeKind> {
    EdgeKind::ALL
        .into_iter()
        .find(|k| admits_containment(*k, owner, child))
}

/// Edge kinds another write opcode owns, and which a hand-drawn line may
/// therefore never create.
///
/// One entry, named with its reason rather than derived, because this is a
/// **policy** statement — which door owns which fact — and policy is the one
/// thing that must be written down rather than computed.
///
/// `MountedIn` is `OP_RACK_PLACE`'s (ADR-0036). It declares `position_u` at
/// `card: "1"`, the rack opcode writes the edge and that field together, and
/// `fathom_inventory::rack` already carries the comment that names the defect:
/// an edge without a position "was written by something that bypassed the
/// opcode", and it renders as an overflow row — visible, and obviously wrong.
/// A second door that produces exactly that is not a feature.
///
/// **The general rule this is a special case of could not be derived.** "Refuse
/// any reference edge that declares a `card: "1"` field the gesture cannot
/// supply" is the honest rule, and field cardinality is not in the generated
/// tables — `EdgeKind::fields()` gives the keys and nothing says which are
/// required. Deriving it would mean extending `fathom-schemagen` and
/// regenerating the checked-in `ir_types.rs`; hand-writing it would mean the
/// per-edge table ADR-0008 forbids. One named exception, pinned by a test so it
/// cannot grow in silence, is the smaller lie.
pub const HAND_LINK_EXCLUDED: &[EdgeKind] = &[EdgeKind::MountedIn];

/// Every edge kind a person may draw by hand between a `from` box and a `to`
/// box, in `EdgeKind::ALL` order.
///
/// Computed from the generated tables, exactly as [`containment_edge`] is and
/// for the same reason (ADR-0008): the schema declares 84 edge kinds, and a
/// hand-written list of which ones join which kinds would be wrong the first
/// time `schema/` moved.
///
/// # Reference only, and that is the design decision
///
/// **Containment is not offerable.** Not because it is dangerous but because it
/// is not a matter of opinion: every containment edge declares `in: "1"`, so a
/// node has exactly one parent, the weld already computes it from the kind pair
/// alone ([`containment_edge`]), and a second assertion of it would be refused
/// by the store's own cardinality check. A person pointing at two boxes is
/// saying *"these two are related"*, which is what `class: reference` means.
///
/// Rejected: offering all 84 kinds and letting the store refuse the illegal
/// ones. That turns a design question into an error message, and the operator
/// would meet 84 names to pick the one that works.
///
/// # What the caller does with the answer
///
/// Zero — say so plainly, naming both kinds. Exactly one — **do not ask**; the
/// schema has already decided and a menu of one is a question with no content.
/// More than one — the caller asks, because guessing writes a false fact into
/// an estate of record and that is worse than a prompt.
///
/// # What this deliberately does not do
///
/// It does not rename an edge to what an operator might wish it meant. A home
/// lab's *"this switch is cabled to that firewall"* comes back as `PeersWith`,
/// because `PeersWith` is the only reference edge the schema declares between
/// two `Device`s. The schema's cable is a `Cable` node with two `Terminates`
/// edges onto `PhysicalPort`s (`19` §5.1), no opcode creates a `Cable`, and
/// naming that gap is worth more than dressing `PeersWith` up as a patch lead.
/// A `Vec` rather than `impl Iterator`, and it is bytes: an iterator returned
/// across a crate boundary monomorphises its adapter chain into every caller,
/// where a `Vec` instantiates the filter once here. The caller wants the length
/// anyway — none, one and several are three different behaviours.
///
/// Rejected, and **measured**: three separate scans (`count`, `names`,
/// `admits`) returning no collection at all, on the theory that `Vec<EdgeKind>`
/// drags in a growth path nothing else needs. It cost **135 bytes more** than
/// this, because the three call sites inline three copies of the predicate. The
/// lesson is `47` §2's, again: the byte argument that sounds right is not the
/// measurement.
pub fn hand_link_candidates(from: NodeKind, to: NodeKind) -> Vec<EdgeKind> {
    let mut out = Vec::new();
    for k in EdgeKind::ALL {
        if k.class() == EdgeClass::Reference
            && !HAND_LINK_EXCLUDED.contains(&k)
            && k.from_kinds().contains(&from)
            && k.to_kinds().contains(&to)
        {
            out.push(k);
        }
    }
    out
}

/// The edge kind whose declared name is `name`, or `None`.
///
/// A linear scan over `EdgeKind::ALL` rather than the generated
/// `EdgeKind::from_name`, and the reason is bytes: `from_name` is an 84-arm
/// string match nothing else in the module links, while `name()` is already
/// linked because the diagram sends every edge kind's name to the page. The
/// scan reuses what is there; the match would have added a table.
///
/// **The wire carries the name, not an ordinal**, and that is deliberate. A
/// hand-drawn link is journalled, an exported journal outlives the build that
/// wrote it, and an index into `EdgeKind::ALL` is a number whose meaning moves
/// the next time `schema/` declares an edge. A name also reads as itself in the
/// exported JSON, which is the file an operator keeps.
pub fn edge_kind_named(name: &str) -> Option<EdgeKind> {
    EdgeKind::ALL.into_iter().find(|&k| k.name() == name)
}

/// The one node kind the schema allows to contain `child`, or `None` when
/// zero kinds may or several may.
///
/// This is the lookup WO-09 §10 item 10's answer names: a fragment node that
/// declares no `owner` does not need a default, because its containment parent
/// is already determined by its kind. Where the schema stops determining it —
/// zero parents, or more than one — the caller refuses rather than choosing
/// (`apply.rs`, `WeldError::NoContainmentEdge`).
pub(crate) fn sole_containment_parent(child: NodeKind) -> Option<NodeKind> {
    let mut found: Option<NodeKind> = None;
    for owner in NodeKind::ALL {
        if containment_edge(owner, child).is_some() {
            if found.is_some() {
                return None;
            }
            found = Some(owner);
        }
    }
    found
}

/// Is `kind` a containment edge that admits `owner` at its from end and
/// `child` at its to end? A root-containment kind is excluded: its owner is
/// the workspace root, which is not a node, and the store refuses it
/// (`11` §7.2).
fn admits_containment(kind: EdgeKind, owner: NodeKind, child: NodeKind) -> bool {
    kind.class() == EdgeClass::Containment
        && !kind.root_containment()
        && kind.from_kinds().contains(&owner)
        && kind.to_kinds().contains(&child)
}
