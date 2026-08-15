//! The generated schema tables an L0-enforcing store reads (WO-02 §4.1):
//! endpoint kind sets, both L0 cardinality bounds, the symmetric flag, the
//! root-containment flag, and the slot-type registry.
//!
//! These tests pin the tables to the facts `schema/schema.yaml` states, so a
//! store never has to hand-copy one of them (ADR-0008) and a schema edit that
//! moves one of these facts shows up here rather than as a store that quietly
//! refuses the wrong writes.

use fathom_ir::generated::accessors::slot_type;
use fathom_ir::generated::ir_types::{EdgeCardBound, EdgeClass, EdgeKind, FIELD_KEYS};

/// The five `from: [root]` containment edges (`11` §7.2's *root*, as
/// transcribed in `schema/schema.yaml`'s containment section).
const ROOT_EDGES: [EdgeKind; 5] = [
    EdgeKind::HasTunnel,
    EdgeKind::HasPremises,
    EdgeKind::HasCable,
    EdgeKind::HasTenant,
    EdgeKind::HasServiceType,
];

#[test]
fn containment_in_bounds_are_exactly_one() {
    // 11 §7.2: "Exactly one containment in-edge per node." Every containment
    // edge kind states it as `in: "1"`; the root five are excluded because
    // the workspace root is not a node and this store refuses their writes.
    for k in EdgeKind::ALL {
        if k.class() != EdgeClass::Containment || ROOT_EDGES.contains(&k) {
            continue;
        }
        assert_eq!(
            k.in_bound_l0(),
            EdgeCardBound {
                min: 1,
                max: Some(1)
            },
            "containment edge `{}` in-bound",
            k.name()
        );
    }
}

#[test]
fn symmetric_is_link_and_passthrough_only() {
    let symmetric: Vec<&'static str> = EdgeKind::ALL
        .iter()
        .filter(|k| k.symmetric())
        .map(|k| k.name())
        .collect();
    assert_eq!(symmetric, vec!["Link", "PassThrough"]);
}

#[test]
fn root_containment_is_the_five_root_edges() {
    let root: Vec<&'static str> = EdgeKind::ALL
        .iter()
        .filter(|k| k.root_containment())
        .map(|k| k.name())
        .collect();
    let expected: Vec<&'static str> = ROOT_EDGES.iter().map(|k| k.name()).collect();
    assert_eq!(root, expected);
    for k in ROOT_EDGES {
        assert_eq!(k.class(), EdgeClass::Containment, "{}", k.name());
    }
}

#[test]
fn from_to_sets_nonempty_unless_root() {
    for k in EdgeKind::ALL {
        assert!(
            !k.to_kinds().is_empty(),
            "`{}` declares an empty to: set",
            k.name()
        );
        assert_eq!(
            k.from_kinds().is_empty(),
            k.root_containment(),
            "`{}`: an empty from: set is the root token and nothing else",
            k.name()
        );
    }
}

#[test]
fn slot_type_covers_every_registry_key() {
    // 299 -> 306 on 2026-08-15: ADR-0035's seven placement keys. See the twin
    // assertion in `canon_laws.rs` — both pin the same registry from opposite
    // sides (canon dispatch and slot typing), so both move together or one of
    // the two tables has silently lost a key.
    assert_eq!(
        FIELD_KEYS.len(),
        306,
        "the registry the tables are cut from"
    );
    for (name, key) in FIELD_KEYS {
        let slot = slot_type(fathom_ir::bag::FieldKey(key));
        let (_, path) = slot.unwrap_or_else(|| panic!("no slot type for `{name}` (key {key})"));
        assert!(!path.is_empty(), "`{name}` declares an empty type path");
    }
    // A key outside the registry has no slot type — retired keys are never
    // reused (62 §2.3), so `None` is the honest answer, not a panic.
    assert!(slot_type(fathom_ir::bag::FieldKey(0)).is_none());
    assert!(slot_type(fathom_ir::bag::FieldKey(u32::MAX)).is_none());
}
