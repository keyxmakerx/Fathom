//! Contract tests over the generated code: the EnumMap compatibility
//! promises (dense index, COUNT, name round-trip), the unknown arms, the
//! append-only key table, and an end-to-end typed read through the field
//! bag — proving the generated accessors actually function, not merely
//! compile.

use fathom_ir::bag::{FieldBag, FieldError, FieldKey};
use fathom_ir::generated::accessors;
use fathom_ir::generated::ir_types::{
    field_required, DerivedEdgeKind, EdgeKind, EstablishTunnels, LinkMedia, NodeKind, SiteField,
    FIELD_KEYS, FIELD_REQUIRED_BITS,
};
use fathom_ir::scalar::{Text, TzName};
use std::any::Any;
use std::collections::BTreeMap;

#[test]
fn node_kind_is_enum_map_compatible() {
    assert_eq!(NodeKind::COUNT, NodeKind::ALL.len());
    for (i, k) in NodeKind::ALL.iter().enumerate() {
        assert_eq!(k.index(), i, "dense declaration-order index");
        assert_eq!(NodeKind::from_name(k.name()), Some(*k), "name round-trip");
    }
    assert_eq!(NodeKind::from_name("NoSuchKind"), None);
}

#[test]
fn edge_kinds_are_enum_map_compatible_and_separated() {
    assert_eq!(EdgeKind::COUNT, EdgeKind::ALL.len());
    assert_eq!(DerivedEdgeKind::COUNT, DerivedEdgeKind::ALL.len());
    for (i, e) in EdgeKind::ALL.iter().enumerate() {
        assert_eq!(e.index(), i);
        assert_eq!(EdgeKind::from_name(e.name()), Some(*e));
    }
    for (i, e) in DerivedEdgeKind::ALL.iter().enumerate() {
        assert_eq!(e.index(), i);
        assert_eq!(DerivedEdgeKind::from_name(e.name()), Some(*e));
        assert!(
            e.produced_by().starts_with("infer."),
            "`{}` produced_by `{}` outside the closed infer.* namespace",
            e.name(),
            e.produced_by()
        );
        // Derived edges are a separate arena (62 §11.4) — never also an
        // asserted EdgeKind.
        assert_eq!(EdgeKind::from_name(e.name()), None);
    }
}

#[test]
fn unknown_arms_carry_the_token() {
    assert_eq!(
        EstablishTunnels::from_token("on_traffic"),
        EstablishTunnels::OnTraffic
    );
    let u = EstablishTunnels::from_token("some-future-variant");
    assert_eq!(u.token(), "some-future-variant");
    assert!(matches!(u, EstablishTunnels::Unknown(_)));
}

#[test]
fn link_media_declared_unknown_folds_into_the_generated_arm() {
    // The shipped tree's one declared `unknown` variant (Link.media, the
    // filed 62 §7 rule 2 collision): the token stays a schema fact in
    // DECLARED, and round-trips through the generated arm.
    assert!(LinkMedia::DECLARED.contains(&"unknown"));
    let v = LinkMedia::from_token("unknown");
    assert!(matches!(v, LinkMedia::Unknown(_)));
    assert_eq!(v.token(), "unknown");
}

#[test]
fn field_key_table_is_append_only_shaped() {
    assert!(!FIELD_KEYS.is_empty());
    let mut last = 0u32;
    for (name, key) in FIELD_KEYS {
        assert!(
            key > last,
            "`{name}` key {key} does not increase over {last} — the registry is append-only"
        );
        last = key;
    }
}

#[test]
fn field_enum_keys_come_from_the_registry() {
    assert_eq!(SiteField::COUNT, SiteField::ALL.len());
    for f in SiteField::ALL {
        let registered = FIELD_KEYS
            .iter()
            .find(|(n, _)| *n == format!("Site.{}", f.name()))
            .map(|(_, k)| *k);
        assert_eq!(Some(f.key().0), registered);
    }
}

struct TestBag(BTreeMap<u32, Box<dyn Any>>);

impl FieldBag for TestBag {
    fn field(&self, key: FieldKey) -> Option<&dyn Any> {
        self.0.get(&key.0).map(|b| b.as_ref())
    }
}

#[test]
fn typed_accessors_read_hit_miss_and_wrong_type() {
    let mut slots: BTreeMap<u32, Box<dyn Any>> = BTreeMap::new();
    slots.insert(
        SiteField::Name.key().0,
        Box::new(Text("Brisbane HQ".to_owned())),
    );
    // Wrong type on purpose: Site.timezone is declared TzName.
    slots.insert(SiteField::Timezone.key().0, Box::new(7u32));
    let bag = TestBag(slots);

    assert_eq!(
        accessors::site::name(&bag),
        Ok(&Text("Brisbane HQ".to_owned()))
    );
    assert_eq!(accessors::site::timezone(&bag), Err(FieldError::WrongType));
    assert_eq!(accessors::site::code(&bag), Err(FieldError::Missing));

    // And the declared type is what a correct slot yields.
    let mut slots: BTreeMap<u32, Box<dyn Any>> = BTreeMap::new();
    slots.insert(
        SiteField::Timezone.key().0,
        Box::new(TzName("Australia/Brisbane".to_owned())),
    );
    let bag = TestBag(slots);
    assert_eq!(
        accessors::site::timezone(&bag).map(|t| t.0.as_str()),
        Ok("Australia/Brisbane")
    );
}

/// The required-field bitset agrees, field for field, with the `card:` string
/// the OTHER generated artifact prints in its documentation.
///
/// `field_required` is emitted by `rust_gen::required_field_bits` as packed
/// bits; the same `card` string is emitted, independently, by
/// `rust_gen::accessors` into each field's doc line. Two emission paths from
/// one source, compared here — which is the only cross-check available without
/// a YAML parser in this crate, and it catches the failure that matters: a
/// bitset that stops tracking `schema/` while still compiling.
///
/// It reads the checked-in file rather than a rebuilt one on purpose. What
/// ships is what is on disk (62 §17.1), and `fathom-schemagen`'s own stale
/// check is what proves the disk matches the generator.
#[test]
fn the_required_bitset_agrees_with_the_generated_documentation() {
    let accessors = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/generated/accessors.rs"),
    )
    .expect("the generated accessors are checked in");

    let mut checked = 0usize;
    let mut required = 0usize;
    for line in accessors.lines() {
        // `    /// `Site.name` — `Text`, card `1`, emit `—`.`
        let Some(rest) = line.trim_start().strip_prefix("/// `") else {
            continue;
        };
        let Some((name, tail)) = rest.split_once("` — `") else {
            continue;
        };
        let Some(at) = tail.find(", card `") else {
            continue;
        };
        let card = &tail[at + ", card `".len()..];
        let Some((card, _)) = card.split_once('`') else {
            continue;
        };
        let Some((_, key)) = FIELD_KEYS.iter().find(|(n, _)| *n == name) else {
            continue;
        };
        checked += 1;
        if card == "1" {
            required += 1;
        }
        assert_eq!(
            field_required(FieldKey(*key)),
            card == "1",
            "`{name}` is documented `card: \"{card}\"` and the bitset disagrees"
        );
    }
    assert!(
        checked > 250 && required > 50,
        "the parse found {checked} documented fields and {required} required ones, \
         which is too few to have read the file: a cross-check that silently \
         matches nothing is not one"
    );
}

/// A key outside the registry is not required — the only safe answer, and the
/// one a reader relies on when it meets a key from a newer schema.
#[test]
fn an_unregistered_key_is_never_required() {
    let max = FIELD_KEYS.iter().map(|(_, k)| *k).max().expect("keys");
    assert!(!field_required(FieldKey(max + 1)));
    assert!(!field_required(FieldKey(u32::MAX)));
    // Key 0 is never allocated: the registry starts at 1.
    assert!(!field_required(FieldKey(0)));
}

/// Every key the bitset marks is a key the registry holds. A stray bit would
/// make a reader report a gap against a field that does not exist.
#[test]
fn the_bitset_marks_only_registered_keys() {
    for (byte, bits) in FIELD_REQUIRED_BITS.iter().enumerate() {
        for bit in 0..8u32 {
            if bits & (1 << bit) == 0 {
                continue;
            }
            let key = (byte as u32) * 8 + bit;
            assert!(
                FIELD_KEYS.iter().any(|(_, k)| *k == key),
                "bit for key {key} is set and no field claims it"
            );
        }
    }
}
