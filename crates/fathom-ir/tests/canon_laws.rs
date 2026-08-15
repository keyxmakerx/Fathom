//! The canonical wire's laws (WO-05 §4.5).
//!
//! The headline is `from_canon(to_canon(v)?)? == v`, exercised once per live
//! family of WO-05 §4.2's table and — for rule 13, whose whole content is
//! that the `Scalar` trait decides — once per implementor, all thirty-five.
//! The refusal tests are the second half: each names one way a second
//! spelling, a lost field or a silently reordered set could get onto disk.

use std::collections::{BTreeMap, BTreeSet};

use fathom_canon::Json;
use fathom_ir::canon::{CanonError, CanonKey, CanonicalValue};
use fathom_ir::generated::accessors::{slot_from_canon, slot_to_canon};
use fathom_ir::generated::ir_types::{
    ConformanceState, Family, HostProtocol, FIELD_KEYS, SCHEMA_VERSION,
};
use fathom_ir::scalar::{self, Scalar, SecretHint, SecretLabel, SecretPlaceholder};
use fathom_ir::value;

/// `from_canon(to_canon(v)?)? == v`, the law every implementor owes.
fn law<T: CanonicalValue + PartialEq + core::fmt::Debug>(v: T) {
    let j = v
        .to_canon()
        .unwrap_or_else(|e| panic!("{v:?} must write: {e:?}"));
    let back = T::from_canon(&j).unwrap_or_else(|e| panic!("{v:?} must read back: {e:?}"));
    assert_eq!(back, v, "round trip through {j:?}");
}

/// The same law over a value built the only way a scalar admits: by parsing
/// its canonical text, which is what makes it parse-reachable.
fn scalar_law<T: Scalar + CanonicalValue + core::fmt::Debug>(text: &str) {
    let v = T::parse(text).unwrap_or_else(|e| panic!("{}: {text:?} must parse: {e:?}", T::NAME));
    let j = v
        .to_canon()
        .unwrap_or_else(|e| panic!("{}: must write: {e:?}", T::NAME));
    assert_eq!(
        j,
        Json::Str(text.to_owned()),
        "{}: the wire is canonical() verbatim",
        T::NAME
    );
    law(v);
}

fn ulid(n: u128) -> fathom_id::Ulid {
    fathom_id::Ulid(n)
}

#[test]
fn schema_version_is_the_trees() {
    // Generated from `schema/schema.yaml`'s `schema.version`, never
    // hand-written (ADR-0008). The plaintext face's header line 3 carries it.
    assert_eq!(SCHEMA_VERSION, "0.1");
}

#[test]
fn exemplar_round_trips_per_family() {
    // Rule 1 — bool.
    law(true);
    law(false);

    // Rule 2 — bare primitive integers.
    law(0u8);
    law(255u8);
    law(500u16);
    law(1500u32);
    law(1024u64);
    law(-5i32);
    law(i64::MIN);

    // Rule 13 — every `Scalar` implementor, all thirty-five, in `scalar.rs`'s
    // own row order. The trait decides membership, so the coverage is the
    // trait's population and not a shape survey.
    scalar_law::<scalar::Ip4Addr>("10.2.0.0");
    scalar_law::<scalar::Ip6Addr>("2001:db8::1");
    scalar_law::<scalar::IpAddr>("203.0.113.10");
    scalar_law::<scalar::IpPrefix>("10.2.0.0/16");
    scalar_law::<scalar::InterfaceAddress>("10.255.0.1/30");
    scalar_law::<scalar::IpRange>("10.0.0.1-10.0.0.9");
    scalar_law::<scalar::MacAddress>("aa:bb:cc:dd:ee:ff");
    scalar_law::<scalar::IpProtocol>("50");
    scalar_law::<scalar::L4Port>("500");
    scalar_law::<scalar::PortRange>("500-4500");
    scalar_law::<scalar::VlanId>("1");
    scalar_law::<scalar::Asn>("65000");
    scalar_law::<scalar::Seconds>("28800");
    scalar_law::<scalar::Kilobytes>("1024");
    scalar_law::<scalar::DhGroup>("14");
    scalar_law::<scalar::EncryptionAlgorithm>("aes-256-gcm");
    scalar_law::<scalar::IntegrityAlgorithm>("hmac-sha-256-128");
    scalar_law::<scalar::AuthMethod>("pre-shared-keys");
    scalar_law::<scalar::IkeVersion>("v2-only");
    scalar_law::<scalar::Identifier>("IKE-P1");
    scalar_law::<scalar::InterfaceName>("reth0.0");
    scalar_law::<scalar::OsVersion>("21.4R3-S4.9");
    scalar_law::<scalar::Timestamp>("1970-01-01T00:00:00.000Z");
    scalar_law::<scalar::Fqdn>("site-b.example.net");
    scalar_law::<scalar::RouteDistinguisher>("65000:100");
    scalar_law::<scalar::Text>("free prose, as written");
    scalar_law::<scalar::Date>("2026-08-01");
    scalar_law::<scalar::LatLon>("-274700000/1530280000");
    scalar_law::<scalar::Clli>("BRBNQLDA");
    scalar_law::<scalar::Bandwidth>("1000000000");
    scalar_law::<scalar::TzName>("Australia/Brisbane");
    scalar_law::<scalar::PlatformId>("junos-srx");
    scalar_law::<scalar::InferenceRuleId>("infer.route.next-hop-interface");
    scalar_law::<scalar::RouteTarget>("65000:100");
    scalar_law::<scalar::OspfAreaId>("0.0.0.0");

    // Rule 6 — the six multi-field structs in `value`, each with its
    // `Option` fields both present and absent (omission is the one spelling
    // of absence).
    law(value::Mtu { bytes: 1500 });
    law(value::PostalAddress {
        lines: vec![scalar::Text("1 Example St".to_owned())],
        locality: None,
        region: None,
        postcode: None,
        country: None,
    });
    law(value::PostalAddress {
        lines: vec![
            scalar::Text("1 Example St".to_owned()),
            scalar::Text("Level 2".to_owned()),
        ],
        locality: Some(scalar::Text("Brisbane".to_owned())),
        region: Some(scalar::Text("QLD".to_owned())),
        postcode: Some(scalar::Text("4000".to_owned())),
        country: Some(scalar::Text("AU".to_owned())),
    });
    law(value::NameConformance {
        state: ConformanceState::Conforming,
        reason: None,
    });
    law(value::NameConformance {
        state: ConformanceState::NonConforming,
        reason: Some(scalar::Text("no site code".to_owned())),
    });
    law(value::QualifiedNextHop {
        next_hop: value::NextHop::Discard,
        preference: None,
        metric: None,
    });
    law(value::QualifiedNextHop {
        next_hop: value::NextHop::Address(scalar::IpAddr::parse("203.0.113.1").expect("parses")),
        preference: Some(5),
        metric: Some(10),
    });
    law(value::NodePriority {
        member_index: 0,
        priority: 200,
    });
    law(value::EndpointCardinality { min: 1, max: None });
    law(value::EndpointCardinality {
        min: 2,
        max: Some(2),
    });

    // Rule 8 — the fifteen field-less structs in `value`.
    law(value::IkeId);
    law(value::Dpd);
    law(value::OspfArea);
    law(value::PolicyScope);
    law(value::AddressValue);
    law(value::L4Spec);
    law(value::NatScope);
    law(value::NatAction);
    law(value::VpnMonitor);
    law(value::PortPosition);
    law(value::Transceiver);
    law(value::SplitRatio);
    law(value::AttributeDecl);
    law(value::FieldPath);
    law(value::Resolution);

    // Rule 9 — the four hand-written enums in `value`, every variant.
    law(value::PeerSpec::Address(
        scalar::IpAddr::parse("203.0.113.10").expect("parses"),
    ));
    law(value::PeerSpec::Dynamic(value::IkeId));
    law(value::AttrValue::Bool(true));
    law(value::AttrValue::Integer(-9));
    law(value::AttrValue::Text(scalar::Text("prose".to_owned())));
    law(value::AttrValue::Enum {
        enum_id: 3,
        variant_id: 7,
    });
    law(value::AttrValue::Bandwidth(scalar::Bandwidth(
        1_000_000_000,
    )));
    law(value::AttrValue::VlanId(scalar::VlanId(101)));
    law(value::AttrValue::IpPrefix(
        scalar::IpPrefix::parse("10.2.0.0/16").expect("parses"),
    ));
    law(value::AttrValue::InterfaceAddress(
        scalar::InterfaceAddress::parse("10.255.0.1/30").expect("parses"),
    ));
    law(value::AttrValue::Identifier(scalar::Identifier(
        "IKE-P1".to_owned(),
    )));
    law(value::AttrValue::Date(
        scalar::Date::parse("2026-08-01").expect("parses"),
    ));
    law(value::NextHop::Address(
        scalar::IpAddr::parse("203.0.113.1").expect("parses"),
    ));
    law(value::NextHop::Interface(fathom_id::NodeId(ulid(9))));
    law(value::NextHop::Discard);
    law(value::NextHop::Reject);
    law(value::NextHop::NextTable(scalar::Identifier(
        "inet.0".to_owned(),
    )));
    law(value::SyslogHost::Address(
        scalar::IpAddr::parse("203.0.113.5").expect("parses"),
    ));
    law(value::SyslogHost::Fqdn(
        scalar::Fqdn::parse("logs.example.net").expect("parses"),
    ));

    // Rule 10 — a generated schema enum, declared and unknown.
    law(Family::Inet);
    law(Family::from_token("something-new"));

    // Rule 11 — the field-embedded reference ids.
    law(fathom_id::NodeId(ulid(1)));
    law(fathom_id::EdgeId(ulid(u128::MAX >> 48)));

    // Rule 12 — the collections.
    law(Vec::<value::NodePriority>::new());
    law(vec![
        value::NodePriority {
            member_index: 0,
            priority: 200,
        },
        value::NodePriority {
            member_index: 1,
            priority: 100,
        },
    ]);
    law(BTreeSet::<Family>::new());
    law(BTreeSet::from([Family::Inet, Family::Mpls]));
    law(BTreeSet::from([HostProtocol::Ospf, HostProtocol::Bgp]));
    law(BTreeMap::<Family, value::Mtu>::from([(
        Family::Inet,
        value::Mtu { bytes: 1500 },
    )]));

    // Rule 14 — the one registered `Scalar` exemption.
    law(SecretPlaceholder::new(SecretLabel::Psk));
}

#[test]
fn ip_noncanonical_spelling_refused() {
    // Refused by std's leading-zero rule, so `parse` never returns.
    assert_eq!(
        scalar::Ip4Addr::from_canon(&Json::Str("010.0.0.1".to_owned())),
        Err(CanonError::NonCanonicalSpelling)
    );
    // Parses, but re-renders as "::1" — a second spelling of one value.
    assert_eq!(
        scalar::Ip6Addr::from_canon(&Json::Str("0:0:0:0:0:0:0:1".to_owned())),
        Err(CanonError::NonCanonicalSpelling)
    );
}

#[test]
fn id_noncanonical_spelling_refused() {
    // `Ulid::decode` is Crockford-lenient: `O` aliases 0 and the alphabet is
    // case-insensitive. Both decode to a value whose own encoding differs.
    assert_eq!(
        fathom_id::NodeId::from_canon(&Json::Str("o0000000000000000000000001".to_owned())),
        Err(CanonError::NonCanonicalSpelling)
    );
    assert_eq!(
        fathom_id::NodeId::from_canon(&Json::Str("0000000000000000000000000a".to_owned())),
        Err(CanonError::NonCanonicalSpelling)
    );
    // The canonical spelling of the same two values is accepted.
    assert_eq!(
        fathom_id::NodeId::from_canon(&Json::Str("00000000000000000000000001".to_owned())),
        Ok(fathom_id::NodeId(ulid(1)))
    );
    assert_eq!(
        fathom_id::NodeId::from_canon(&Json::Str("0000000000000000000000000A".to_owned())),
        Ok(fathom_id::NodeId(ulid(10)))
    );
}

#[test]
fn u64_above_i64_max_refused() {
    // No slot binds a bare `u64` today, so the guard is exercised against the
    // impl directly: it lands before the binding, not after it.
    let above = (i64::MAX as u64) + 1;
    assert_eq!(above.to_canon(), Err(CanonError::IntOutOfRange));
    assert_eq!(
        (i64::MAX as u64).to_canon(),
        Ok(Json::Int(i64::MAX)),
        "the boundary value still writes"
    );
}

#[test]
fn non_parse_reachable_scalar_refused_at_write() {
    // `canonical()` returns the empty string outside ENC_TABLE's eight
    // tokens; written unchecked, the file would save and refuse to load.
    let unreachable = scalar::EncryptionAlgorithm {
        family: scalar::EncFamily::Aes,
        key_bits: Some(512),
        mode: scalar::EncMode::Cbc,
        aead: false,
    };
    assert_eq!(
        unreachable.to_canon(),
        Err(CanonError::NonCanonicalSpelling)
    );
    // `Fqdn::parse` case-folds, so this value's own text reads back as a
    // different value.
    assert_eq!(
        scalar::Fqdn("EXAMPLE.COM".to_owned()).to_canon(),
        Err(CanonError::NonCanonicalSpelling)
    );
}

#[test]
fn secret_placeholder_round_trips_label_and_hint() {
    law(SecretPlaceholder::new(SecretLabel::TacacsKey));
    law(SecretPlaceholder::with_hint(
        SecretLabel::Psk,
        SecretHint::new("vault: net/psk/site-b").expect("within the cap"),
    ));
    // The label survives: a reloaded TACACS placeholder must not emit <PSK>.
    let j = SecretPlaceholder::new(SecretLabel::TacacsKey)
        .to_canon()
        .expect("writes");
    assert_eq!(
        SecretPlaceholder::from_canon(&j)
            .expect("reads")
            .placeholder(),
        "<TACACS-KEY>"
    );
    // The five wire tokens are this format's, pinned literally so a change to
    // `SecretLabel::token()` cannot move them.
    for (label, token) in [
        (SecretLabel::Psk, "psk"),
        (SecretLabel::CertKey, "cert-key"),
        (SecretLabel::SnmpCommunity, "snmp-community"),
        (SecretLabel::TacacsKey, "tacacs-key"),
        (SecretLabel::Password, "password"),
    ] {
        let mut want = BTreeMap::new();
        want.insert("label".to_owned(), Json::Str(token.to_owned()));
        assert_eq!(
            SecretPlaceholder::new(label).to_canon(),
            Ok(Json::Obj(want)),
            "{token} is the wire token"
        );
    }
    // An unknown label token is named, not guessed.
    let mut bad = BTreeMap::new();
    bad.insert("label".to_owned(), Json::Str("root-password".to_owned()));
    assert_eq!(
        SecretPlaceholder::from_canon(&Json::Obj(bad)),
        Err(CanonError::UnknownVariant {
            token: "root-password".to_owned()
        })
    );
}

#[test]
fn secret_placeholder_hint_cap_reenforced_on_read() {
    let mut m = BTreeMap::new();
    m.insert("label".to_owned(), Json::Str("psk".to_owned()));
    m.insert("hint".to_owned(), Json::Str("x".repeat(121)));
    assert_eq!(
        SecretPlaceholder::from_canon(&Json::Obj(m)),
        Err(CanonError::Shape {
            expected: "a hint of at most 120 bytes"
        })
    );
    // 120 is inside the cap.
    let mut ok = BTreeMap::new();
    ok.insert("label".to_owned(), Json::Str("psk".to_owned()));
    ok.insert("hint".to_owned(), Json::Str("x".repeat(120)));
    assert!(SecretPlaceholder::from_canon(&Json::Obj(ok)).is_ok());
}

#[test]
fn set_members_out_of_order_refused() {
    // `Family` orders by declaration: inet < inet6 < iso < mpls.
    let descending = Json::Arr(vec![
        Json::Str("mpls".to_owned()),
        Json::Str("inet".to_owned()),
    ]);
    assert_eq!(
        BTreeSet::<Family>::from_canon(&descending),
        Err(CanonError::NonCanonicalOrder)
    );
    let repeated = Json::Arr(vec![
        Json::Str("inet".to_owned()),
        Json::Str("inet".to_owned()),
    ]);
    assert_eq!(
        BTreeSet::<Family>::from_canon(&repeated),
        Err(CanonError::NonCanonicalOrder)
    );
    let ascending = Json::Arr(vec![
        Json::Str("inet".to_owned()),
        Json::Str("mpls".to_owned()),
    ]);
    assert_eq!(
        BTreeSet::<Family>::from_canon(&ascending),
        Ok(BTreeSet::from([Family::Inet, Family::Mpls]))
    );
}

#[test]
fn map_keys_round_trip() {
    // The only two `BTreeMap` key types the registry binds.
    let ident: BTreeMap<scalar::Identifier, value::AttrValue> = BTreeMap::from([
        (
            scalar::Identifier("bandwidth".to_owned()),
            value::AttrValue::Bandwidth(scalar::Bandwidth(100_000_000)),
        ),
        (
            scalar::Identifier("vlan".to_owned()),
            value::AttrValue::VlanId(scalar::VlanId(7)),
        ),
    ]);
    law(ident);
    let fam: BTreeMap<Family, value::Mtu> = BTreeMap::from([
        (Family::Inet, value::Mtu { bytes: 1500 }),
        (Family::Mpls, value::Mtu { bytes: 1508 }),
    ]);
    law(fam);
    // An `Identifier` key goes through the same `Scalar` pair as its value
    // form, so the two spellings cannot diverge.
    assert_eq!(
        scalar::Identifier("IKE-P1".to_owned()).to_key(),
        Ok("IKE-P1".to_owned())
    );
    assert_eq!(
        <scalar::Identifier as CanonKey>::from_key("two words"),
        Err(CanonError::NonCanonicalSpelling)
    );
    assert_eq!(<Family as CanonKey>::from_key("inet"), Ok(Family::Inet));
}

#[test]
fn enum_tokens_round_trip_including_unknown() {
    for token in Family::DECLARED {
        let v = Family::from_token(token);
        assert_eq!(v.to_canon(), Ok(Json::Str(token.to_owned())));
        law(v);
    }
    // An undeclared token survives verbatim inside the generated arm — what
    // makes a new schema token a minor bump an old build can still read.
    let unknown = Family::from_canon(&Json::Str("gre".to_owned())).expect("total");
    assert_eq!(unknown, Family::Unknown("gre".to_owned()));
    assert_eq!(unknown.to_canon(), Ok(Json::Str("gre".to_owned())));
    // A non-string is still a shape error.
    assert_eq!(
        Family::from_canon(&Json::Int(1)),
        Err(CanonError::Shape {
            expected: "a schema enum token"
        })
    );
}

#[test]
fn dispatch_names_every_registry_key() {
    assert_eq!(FIELD_KEYS.len(), 301, "the registry grew or shrank");
    // `()` is no slot type, so every key must reach an arm and refuse on the
    // type — which proves the arm exists. A missing arm would answer
    // `UnknownKey` instead.
    for (name, key) in FIELD_KEYS {
        let err =
            slot_to_canon(fathom_ir::bag::FieldKey(key), &()).expect_err("() is no slot type");
        assert!(
            matches!(err, CanonError::WrongType { key: k, .. } if k == key),
            "{name} (key {key}) has no dispatch arm: {err:?}"
        );
    }
    // A key outside the registry is named as such, in both directions.
    let absent = fathom_ir::bag::FieldKey(u32::MAX);
    assert_eq!(
        slot_to_canon(absent, &()),
        Err(CanonError::UnknownKey { key: u32::MAX })
    );
    assert!(matches!(
        slot_from_canon(absent, &Json::Null),
        Err(CanonError::UnknownKey { key: u32::MAX })
    ));
    // And one worked pair through both halves, so the dispatch is exercised
    // and not only counted: `Device.hostname` is key 6, an `Identifier`.
    let key = fathom_ir::bag::FieldKey(6);
    let j = slot_to_canon(key, &scalar::Identifier("srx-b".to_owned())).expect("writes");
    assert_eq!(j, Json::Str("srx-b".to_owned()));
    let back = slot_from_canon(key, &j).expect("reads");
    assert_eq!(
        back.downcast_ref::<scalar::Identifier>(),
        Some(&scalar::Identifier("srx-b".to_owned()))
    );
}
