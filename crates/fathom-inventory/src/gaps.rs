//! What the estate does not know yet — the findings view's first real job
//! (`57` §13.5 consequence 3, §14.1 pile A item A4).
//!
//! # This is not a rule engine and must never read as one
//!
//! `.context/conventions.md` reserves the word **finding** for *"one rule
//! firing against one node"*. There are zero lines of rule engine in this
//! build and none is proposed here, so nothing in this module produces a
//! finding. What it produces is a **gap**: a field `schema/schema.yaml`
//! declares `card: "1"` — required, exactly one value, no default — against an
//! element of which the store holds no value at all.
//!
//! The distinction is the whole honesty of the view. A rule says *"this is
//! wrong"*. A gap says *"nobody has said"*, which is a fact about the record
//! rather than a judgement about the network, and it is the only one of the
//! two this build is entitled to make.
//!
//! # Why the store can answer it exactly
//!
//! `fathom_graph::StoredPresence` already has three states and the middle one
//! is the whole feature:
//!
//! | state | means | a gap? |
//! |---|---|---|
//! | `Set` | a value is stored | no |
//! | `Absent` | somebody looked and recorded that there is none (`11` §8.5) | **no** |
//! | `Unknown` | there is no slot; nobody has said (`11` §5.2) | **yes** |
//!
//! `Absent` is deliberately not a gap. It is a stored assertion with its own
//! provenance — somebody did the work and the answer was "none" — and counting
//! it as unfinished would send an operator back to a question they have
//! already answered. On a `card: "1"` field an explicit `Absent` is arguably a
//! contradiction, but resolving contradictions is a rule engine's job and this
//! module does not have one.
//!
//! # Why the required half is generated
//!
//! `fathom_ir::generated::ir_types::field_required` is emitted from the
//! `card:` column by `fathom-schemagen`. A hand-written list of required
//! fields here would be wrong the first time `schema/` moved and nothing would
//! fail (ADR-0008). The walk below therefore names no field at all.
//!
//! Every count is a count of what the graph holds. Nothing here estimates,
//! projects or extrapolates, and a gap group that would be empty is not
//! emitted.

use fathom_graph::{ElementId, Graph, NodeId, StoredPresence};
use fathom_ir::generated::ir_types::{self, NodeKind};

use crate::element::display_name;
use crate::render::field_name;

/// How many example elements travel with each gap group.
///
/// A cap rather than the lot, because a 3,000-device estate with one unstated
/// field is 3,000 rows of identical shape and the list stops being work you
/// can do. The cap is not silent: [`Gap::missing`] is the true count and
/// [`Gap::examples`] is what fits, so a reader is always told how much it is
/// not looking at (`59` §3.6's rule, applied to a list rather than a picture:
/// a collapse that does not say how many it hid is a lie with fewer
/// elements).
pub const EXAMPLES_PER_GAP: usize = 12;

/// One element that is missing the group's field.
pub struct GapExample {
    /// The full display id (`<kind-lower>:<ulid>`, ADR-0005) — postable to
    /// `OP_ELEMENT`, so a row can select what it names.
    pub id: String,
    /// The element's display name, as every other face renders it.
    pub name: String,
}

/// One thing the estate does not know: a kind, a required field, and every
/// element of that kind with no value under it.
pub struct Gap {
    pub kind_word: &'static str,
    /// The bare field name — `platform`, not `Device.platform`. The kind is
    /// the row's other half and printing it twice reads as a stutter.
    pub field: &'static str,
    /// Live elements of this kind with the field `Unknown`.
    pub missing: usize,
    /// Live elements of this kind, the denominator. Carried because
    /// *"2 devices have no platform"* means something different when there are
    /// two devices than when there are two hundred.
    pub population: usize,
    /// At most [`EXAMPLES_PER_GAP`] of them, in `NodeId` order.
    pub examples: Vec<GapExample>,
    /// The row's sentence, composed here because the page composes nothing.
    pub sentence: String,
    /// Whether a person can type this field's value today
    /// ([`crate::is_authorable`]).
    ///
    /// **A work list that lists work nobody can do has to say which rows those
    /// are.** It travels because the honest answer today is uncomfortable: of
    /// the two gaps a real estate produces in this build — `Device`'s
    /// `name_conformance` and `Interface`'s `form` — NEITHER can be typed in,
    /// so a row that looked like a job is a job for whoever writes the next
    /// scalar parser. Hiding those rows would be worse: they are true, they
    /// are what the estate does not know, and an operator who cannot see them
    /// cannot ask for them.
    ///
    /// `FieldRow` on the inspector carries the same flag for the same reason,
    /// and this is that decision applied one surface further out.
    pub authorable: bool,
}

/// A kind the estate holds none of, named rather than passed over in silence.
///
/// A gap list that simply reports nothing for `Cable` is telling an operator
/// their cabling is complete, when the truth is that **no opcode in this build
/// creates a `Cable` and no dictionary entry produces one** (`57` §6.2). Zero
/// because there are none is a different claim from zero because they are all
/// filled in, and a work list that cannot tell them apart is one an operator
/// works down to a false zero.
///
/// **Every empty kind is reported, including the ones that declare no required
/// field at all.** `Cable` is exactly that case — not one of its nine fields
/// is `card: "1"` — so a filter of "kinds that would have had something to
/// check" would have dropped the one kind `57` §6.2 names by name. The
/// required-field count travels instead, and zero is a real answer.
pub struct EmptyKind {
    pub kind_word: &'static str,
    /// How many required fields would have been checked had there been any.
    pub required_fields: usize,
}

/// Everything the view renders, in one answer.
pub struct Findings {
    pub gaps: Vec<Gap>,
    pub empty: Vec<EmptyKind>,
    /// Live elements walked. The denominator for the whole view.
    pub checked: usize,
    /// Kinds the estate holds at least one live element of.
    pub kinds_present: usize,
}

impl Findings {
    /// Every gap group's `missing`, summed — how many separate facts are
    /// unstated, not how many elements are incomplete.
    ///
    /// A `for` loop rather than `map().sum()` for the reason the walk below
    /// gives: each iterator-adapter shape monomorphises its own `next` into
    /// the module, and `47` §3 measures `core::iter::adapters` at 23,355
    /// bytes already.
    pub fn total_missing(&self) -> usize {
        let mut n = 0;
        for g in &self.gaps {
            n += g.missing;
        }
        n
    }
}

/// Walk the estate and answer what it does not know.
///
/// # Order
///
/// Biggest gap first, because the view is a work list and the work is
/// wherever the count is. Ties break on `NodeKind::ALL` order and then on
/// declared field order — both schema declaration orders, which is the
/// deterministic iteration invariant 9 relies on (62 §2.3). The same estate
/// therefore produces the same list every time, with no clock, no map
/// iteration and no sort by anything a build could reorder.
pub fn findings(g: &Graph) -> Findings {
    let mut gaps: Vec<Gap> = Vec::new();
    let mut empty: Vec<EmptyKind> = Vec::new();
    let mut checked = 0usize;
    let mut kinds_present = 0usize;

    for kind in NodeKind::ALL {
        // Tombstoned nodes are not gaps. An element marked absent from a
        // moment is not work anybody has left to do, and `rows()` filters the
        // same way for the same reason — a removed device that went on
        // appearing in the inventory was a real defect on 2026-08-11.
        //
        // A `for` loop and a `push`, not `filter().map().collect()`. Every
        // distinct iterator-adapter chain over `nodes_of_kind` monomorphises
        // its own `next` into the module — `47` §3's census shows the one
        // `rows()` built weighing 5,917 bytes on its own — and a second chain
        // that differs only in its closure buys a second copy of it. This
        // walk is measured against `44` §5.2's ceiling to the byte.
        let mut live: Vec<NodeId> = Vec::new();
        for n in g.nodes_of_kind(kind) {
            if n.absent_since.is_none() {
                live.push(n.id);
            }
        }

        // The required fields of this kind, asked of the generated table and
        // never listed here (ADR-0008). Counted by walking the slice rather
        // than collected, for the reason above.
        let mut required_count = 0usize;
        for k in kind.fields() {
            if ir_types::field_required(*k) {
                required_count += 1;
            }
        }

        if live.is_empty() {
            empty.push(EmptyKind {
                kind_word: kind.name(),
                required_fields: required_count,
            });
            continue;
        }
        checked += live.len();
        kinds_present += 1;

        for key in kind.fields().iter().copied() {
            if !ir_types::field_required(key) {
                continue;
            }
            let mut examples: Vec<GapExample> = Vec::new();
            let mut missing = 0usize;
            for id in &live {
                // `Err` is unreachable: the element exists and the key came
                // out of its own kind's field list. Treated as "not a gap"
                // rather than unwrapped, because a panic here would take the
                // whole module down over a view that is only ever advisory.
                let unknown = matches!(
                    g.presence(ElementId::Node(*id), key),
                    Ok(info) if info.presence == StoredPresence::Unknown
                );
                if !unknown {
                    continue;
                }
                missing += 1;
                if examples.len() < EXAMPLES_PER_GAP {
                    examples.push(GapExample {
                        id: id.to_string(),
                        name: display_name(g, *id),
                    });
                }
            }
            if missing == 0 {
                continue;
            }
            let field = field_name(key);
            gaps.push(Gap {
                kind_word: kind.name(),
                field,
                missing,
                population: live.len(),
                sentence: sentence(kind.name(), field, missing, live.len()),
                authorable: crate::is_authorable(key),
                examples,
            });
        }
    }

    // Biggest gap first, by insertion sort written out.
    //
    // `sort_by` would read better and it monomorphises another copy of
    // `core::slice::sort` for this one comparator — a driver already at
    // 120,522 bytes across 423 functions, and the third of `47` §4's three
    // byte levers is precisely "six sort sites as one shared insertion sort".
    // Adding a seventh site while that lever is unspent would be arguing
    // against the census in the same commit that cites it.
    //
    // Insertion sort is stable, so equal counts keep the push order above,
    // which is `NodeKind::ALL` order then declared field order — both schema
    // declaration orders, which is the deterministic iteration invariant 9
    // relies on (62 §2.3). The list is one row per (kind, required field) and
    // cannot exceed the schema's own count of those, so the quadratic term is
    // bounded by the schema and not by the estate.
    for i in 1..gaps.len() {
        let mut j = i;
        while j > 0 && gaps[j - 1].missing < gaps[j].missing {
            gaps.swap(j - 1, j);
            j -= 1;
        }
    }

    Findings {
        gaps,
        empty,
        checked,
        kinds_present,
    }
}

/// The row's own sentence.
///
/// Composed here and not on the page for the reason the whole crate exists:
/// the page renders the strings a reply carries and computes nothing. The
/// KIND is not pluralised — `Chassis` has no plural anyone would agree on and
/// `Chassises` in an estate of record is worse than a slightly formal
/// sentence — so the countable noun is `node`, which is the word
/// `.context/conventions.md` blesses for exactly this.
fn sentence(kind: &str, field: &str, missing: usize, population: usize) -> String {
    let verb = if missing == 1 { "has" } else { "have" };
    format!("{missing} of {population} {kind} nodes {verb} no {field}")
}

#[cfg(test)]
mod tests {
    //! The three presence states, driven against a real `Graph`.
    //!
    //! These live here rather than in `fathom-wasm/tests/findings.rs` because
    //! **the shell cannot reach two of the three states.** `OP_EQUIP_ADD`
    //! fills `Chassis.member_index` with `"0"` when the form omits it, and
    //! nothing in the module calls `Graph::assert_absent` at all — so
    //! `Absent`, which is the rule most likely to be got wrong, has no route
    //! in from the browser and no test through the shell could exercise it.
    //! A rule with no test is a rule only until somebody edits it.

    use fathom_graph::{
        Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId,
        ProvenanceRecord, Timestamp, UserId,
    };
    use fathom_id::Ulid;
    use fathom_ir::scalar;

    use super::*;
    use crate::render::key;

    /// 2026-07-31T00:00:00Z, pinned. No clock (invariant 9).
    const TS0: u64 = 1_785_456_000_000;

    fn ulid(k: u128) -> Ulid {
        Ulid::from_parts(TS0, k).expect("TS0 fits 48 bits")
    }

    fn prov(k: u128) -> ProvenanceRecord {
        ProvenanceRecord {
            id: ProvenanceId(ulid(9000 + k)),
            origin: Origin::Hand,
            asserted_at: Timestamp(TS0),
            asserted_by: Actor::User(UserId(ulid(1))),
            confidence: Confidence::Asserted,
            supersedes: None,
        }
    }

    /// One device, nothing said about it, in one closed batch.
    fn one_device(g: &mut Graph, k: u128) -> NodeId {
        g.begin_batch(BatchId(ulid(500 + k)), "gaps test")
            .expect("a fresh batch");
        let id = g
            .insert_node(NodeKind::Device, ulid(k), prov(k))
            .expect("a device");
        g.end_batch().expect("the batch closes");
        id
    }

    fn gap_for(f: &Findings, kind: &str, field: &str) -> Option<usize> {
        f.gaps
            .iter()
            .find(|g| g.kind_word == kind && g.field == field)
            .map(|g| g.missing)
    }

    #[test]
    fn unknown_is_a_gap() {
        let mut g = Graph::new();
        one_device(&mut g, 1);
        let f = findings(&g);
        assert_eq!(gap_for(&f, "Device", "hostname"), Some(1));
        assert_eq!(gap_for(&f, "Device", "platform"), Some(1));
    }

    #[test]
    fn set_is_not_a_gap() {
        let mut g = Graph::new();
        let id = one_device(&mut g, 1);
        g.begin_batch(BatchId(ulid(600)), "gaps test")
            .expect("a fresh batch");
        g.set_field(
            ElementId::Node(id),
            key("Device.hostname"),
            scalar::Identifier("sw-core-01".to_owned()),
            prov(2),
        )
        .expect("hostname is an Identifier");
        g.end_batch().expect("the batch closes");

        let f = findings(&g);
        assert_eq!(gap_for(&f, "Device", "hostname"), None);
        assert_eq!(
            gap_for(&f, "Device", "platform"),
            Some(1),
            "the field beside it is untouched"
        );
    }

    /// **The rule this whole module turns on.** `Absent` is somebody having
    /// looked and recorded that there is no value — an answer with its own
    /// provenance. Counting it as unfinished sends an operator back to a
    /// question he has already closed, which is how a work list stops being
    /// worked.
    #[test]
    fn absent_is_an_answer_and_not_a_gap() {
        let mut g = Graph::new();
        let id = one_device(&mut g, 1);
        g.begin_batch(BatchId(ulid(700)), "gaps test")
            .expect("a fresh batch");
        g.assert_absent(ElementId::Node(id), key("Device.hostname"), prov(3))
            .expect("absence is assertable");
        g.end_batch().expect("the batch closes");

        let f = findings(&g);
        assert_eq!(
            gap_for(&f, "Device", "hostname"),
            None,
            "a field somebody looked at is not outstanding work"
        );
    }

    /// The count is of elements, and it moves when the graph moves.
    #[test]
    fn the_count_follows_the_graph() {
        let mut g = Graph::new();
        for k in 1..=3 {
            one_device(&mut g, k);
        }
        assert_eq!(gap_for(&findings(&g), "Device", "platform"), Some(3));

        let fourth = one_device(&mut g, 4);
        assert_eq!(gap_for(&findings(&g), "Device", "platform"), Some(4));

        g.begin_batch(BatchId(ulid(800)), "gaps test")
            .expect("a fresh batch");
        g.tombstone(ElementId::Node(fourth), Timestamp(TS0 + 1))
            .expect("a device can be removed");
        g.end_batch().expect("the batch closes");
        assert_eq!(
            gap_for(&findings(&g), "Device", "platform"),
            Some(3),
            "a removed element is not work anybody has left to do"
        );
    }

    /// An estate with nothing in it says so plainly: no gaps, nothing checked,
    /// and every declared kind reported empty. It is never an error.
    #[test]
    fn an_empty_estate_reports_no_gaps_and_says_why() {
        let g = Graph::new();
        let f = findings(&g);
        assert!(f.gaps.is_empty());
        assert_eq!(f.checked, 0);
        assert_eq!(f.kinds_present, 0);
        assert_eq!(f.empty.len(), NodeKind::ALL.len());
        assert_eq!(f.total_missing(), 0);
    }
}
