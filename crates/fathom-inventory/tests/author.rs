//! `parse_into_slot` — the form direction of `render.rs`'s table.
//!
//! What these pin, in order of how much they would cost to get wrong:
//!
//! 1. A parsed value is byte-identical to a value the config parser would have
//!    produced. If hand entry and paste disagree about what "SRX345" is, two
//!    records of one box can never be reconciled.
//! 2. Refusal is refusal. A form that silently coerces is worse than one that
//!    rejects, because the wrong value is then indistinguishable from a right
//!    one — and this product's whole claim is that you can trust what it shows.
//! 3. The enum's `Unknown` arm is refused HERE and accepted in the parser. That
//!    asymmetry is deliberate and is the kind of thing a later reader "fixes".

use fathom_inventory::{parse_into_slot, AuthorError};
use fathom_ir::generated::ir_types::{ChassisField, DeviceField, DeviceRole};
use fathom_ir::scalar::{self, Scalar};

/// The two fields the owner named — "set the device type model" — end to end.
#[test]
fn the_owner_s_two_fields_parse() {
    let model = parse_into_slot(ChassisField::Model.key(), "SRX345").expect("SRX345 is a model");
    let got = model
        .downcast_ref::<scalar::Identifier>()
        .expect("Chassis.model is declared Identifier");
    assert_eq!(got.canonical(), "SRX345");

    let role = parse_into_slot(DeviceField::Role.key(), "firewall").expect("firewall is a role");
    assert_eq!(
        role.downcast_ref::<DeviceRole>(),
        Some(&DeviceRole::Firewall)
    );
}

/// Hand entry and paste must produce the same bytes for the same text, or a
/// hand-made device can never be reconciled with a pasted one.
#[test]
fn hand_entry_agrees_with_the_scalar_grammar() {
    for text in ["srx-hq-01", "core1", "SRX345"] {
        let boxed = parse_into_slot(DeviceField::Hostname.key(), text).expect("valid identifier");
        let hand = boxed
            .downcast_ref::<scalar::Identifier>()
            .expect("declared type");
        let parsed = scalar::Identifier::parse(text).expect("the same grammar");
        assert_eq!(
            *hand, parsed,
            "hand entry diverged from the parser on {text}"
        );
    }
}

/// Every field the equipment form offers must be parseable, or the form can
/// accept a value it cannot store.
#[test]
fn every_field_the_form_offers_is_supported() {
    let offered: &[(&str, fathom_ir::bag::FieldKey, &str)] = &[
        ("hostname", DeviceField::Hostname.key(), "srx-hq-01"),
        ("platform", DeviceField::Platform.key(), "junos-srx"),
        ("role", DeviceField::Role.key(), "firewall"),
        ("os_version", DeviceField::OsVersion.key(), "21.4R3-S5"),
        (
            "management_address",
            DeviceField::ManagementAddress.key(),
            "192.0.2.10",
        ),
        ("model", ChassisField::Model.key(), "SRX345"),
        ("serial", ChassisField::Serial.key(), "AB1234567890"),
        ("member_index", ChassisField::MemberIndex.key(), "0"),
    ];
    for (name, key, sample) in offered {
        let got = parse_into_slot(*key, sample);
        assert!(
            got.is_ok(),
            "the form offers {name} but parse_into_slot refuses {sample:?}: {:?}",
            got.err()
        );
    }
}

/// A typo is told, not stored. `DeviceRole::from_token` would have accepted
/// this into its `Unknown` arm, which is right when reading a config from a
/// newer Fathom and wrong when a person is typing.
#[test]
fn a_misspelt_role_is_refused_not_stored_verbatim() {
    let err = parse_into_slot(DeviceField::Role.key(), "frewall")
        .expect_err("a typo must not be stored as Unknown(\"frewall\")");
    assert!(
        matches!(err, AuthorError::Parse(_)),
        "expected a parse refusal, got {err:?}"
    );
}

/// Blank is not "no value". Absence is a different assertion with different
/// provenance rules; inventing one from an empty input would be the product
/// making a closed-world claim on the user's behalf.
#[test]
fn blank_is_refused_rather_than_treated_as_absence() {
    assert!(
        parse_into_slot(DeviceField::Hostname.key(), "").is_err(),
        "an empty hostname must be refused, never stored and never read as absence"
    );
}

/// Out of range is refused, not truncated.
#[test]
fn an_out_of_range_integer_is_refused() {
    assert!(parse_into_slot(ChassisField::MemberIndex.key(), "0").is_ok());
    assert!(
        parse_into_slot(ChassisField::MemberIndex.key(), "300").is_err(),
        "member_index is u8; 300 must refuse rather than wrap to 44"
    );
}

/// A field whose slot type this narrow table does not carry says so
/// distinguishably, so the page can decline to offer an input rather than
/// offering one that always fails.
#[test]
fn an_unsupported_type_is_reported_as_unsupported() {
    // default_cross_zone_action is a policy_action enum -- real, declared, and
    // deliberately outside the equipment form's table.
    let err = parse_into_slot(DeviceField::DefaultCrossZoneAction.key(), "deny")
        .expect_err("policy_action is not in the narrow table");
    assert!(
        matches!(err, AuthorError::UnsupportedType { .. }),
        "expected UnsupportedType so the page can hide the input, got {err:?}"
    );
}
