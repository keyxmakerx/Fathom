//! The `Scalar` contract, pinned (WO-01 §4.5).
//!
//! Three parts: the weld test — the trait-conformance half of gate
//! `schema.scalar.unbound` (62 §18.1) — the law harness with its per-scalar
//! fixture cases, and the two named structural tests.

use std::collections::BTreeSet;
use std::path::Path;

/// The 35 bindings that implement `Scalar` (WO-01 §4.2 part A minus
/// `SecretPlaceholder`).
const IMPLEMENTING: &[&str] = &[
    "Ip4Addr",
    "Ip6Addr",
    "IpAddr",
    "IpPrefix",
    "InterfaceAddress",
    "IpRange",
    "MacAddress",
    "IpProtocol",
    "L4Port",
    "PortRange",
    "VlanId",
    "Asn",
    "Seconds",
    "Kilobytes",
    "DhGroup",
    "EncryptionAlgorithm",
    "IntegrityAlgorithm",
    "AuthMethod",
    "IkeVersion",
    "Identifier",
    "InterfaceName",
    "OsVersion",
    "Timestamp",
    "Fqdn",
    "RouteDistinguisher",
    "Text",
    "Date",
    "LatLon",
    "Clli",
    "Bandwidth",
    "TzName",
    "PlatformId",
    "InferenceRuleId",
    "RouteTarget",
    "OspfAreaId",
];

/// `SecretPlaceholder` (exempt, 11 §4.5) plus the 25 `structured: true`
/// bindings (62 §3.1 row 3 — no vendor round-trip obligation).
const NOT_IMPLEMENTING: &[&str] = &[
    "SecretPlaceholder",
    "Mtu",
    "IkeId",
    "PeerSpec",
    "Dpd",
    "PostalAddress",
    "AttrValue",
    "NameConformance",
    "NextHop",
    "QualifiedNextHop",
    "NodePriority",
    "OspfArea",
    "PolicyScope",
    "AddressValue",
    "L4Spec",
    "NatScope",
    "NatAction",
    "VpnMonitor",
    "PortPosition",
    "Transceiver",
    "SplitRatio",
    "EndpointCardinality",
    "AttributeDecl",
    "FieldPath",
    "Resolution",
    "SyslogHost",
];

/// schema.scalar.unbound, trait half (62 §18.1: "…or lacks the trait"):
/// every `scalars:` row is classified, and every classified-implementing
/// name is welded to the trait by `welded!` below. A row this test does not
/// know refuses the build — the answer is to extend WO-01's catalogue by a
/// planning session, never to add a name here ad hoc.
#[test]
fn every_bound_scalar_is_classified() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crate lives two levels under the repo root")
        .join("schema");
    let tree = fathom_schema::SchemaTree::load(&root).expect("shipped tree loads");
    let declared: BTreeSet<&str> = tree.scalars.iter().map(|s| s.name.as_str()).collect();
    let known: BTreeSet<&str> = IMPLEMENTING
        .iter()
        .chain(NOT_IMPLEMENTING)
        .copied()
        .collect();
    assert_eq!(declared.len(), 61, "the scalars: block grew or shrank");
    assert_eq!(
        declared, known,
        "a scalars: row this work order does not classify"
    );
}

macro_rules! welded {
    ($($name:ident),+ $(,)?) => {
        #[test]
        fn names_match_the_schema_spelling() {
            fn weld<S: fathom_ir::scalar::Scalar>() -> &'static str {
                S::NAME
            }
            $(assert_eq!(weld::<fathom_ir::scalar::$name>(), stringify!($name));)+
        }
    };
}

welded!(
    Ip4Addr,
    Ip6Addr,
    IpAddr,
    IpPrefix,
    InterfaceAddress,
    IpRange,
    MacAddress,
    IpProtocol,
    L4Port,
    PortRange,
    VlanId,
    Asn,
    Seconds,
    Kilobytes,
    DhGroup,
    EncryptionAlgorithm,
    IntegrityAlgorithm,
    AuthMethod,
    IkeVersion,
    Identifier,
    InterfaceName,
    OsVersion,
    Timestamp,
    Fqdn,
    RouteDistinguisher,
    Text,
    Date,
    LatLon,
    Clli,
    Bandwidth,
    TzName,
    PlatformId,
    InferenceRuleId,
    RouteTarget,
    OspfAreaId,
);

/// The law harness (WO-01 §4.5(b)). Per scalar: every accept pair parses,
/// canonicalises to the stated text and survives L1c's round trip; every
/// refuse string is refused by *that* scalar; and L3 holds pairwise over the
/// accepted values, in both directions, so alternates that map onto one value
/// are exercised rather than special-cased.
macro_rules! scalar_cases {
    (
        $fname:ident, $ty:ident,
        accept: [ $( ($text:expr, $canon:expr) ),* $(,)? ],
        refuse: [ $( $bad:expr ),* $(,)? ]
        $(, extra: $extra:block )? $(,)?
    ) => {
        #[test]
        fn $fname() {
            use fathom_ir::scalar::{$ty, Scalar};
            let name = <$ty as Scalar>::NAME;
            let mut accepted: Vec<$ty> = Vec::new();
            $(
                let value = match <$ty as Scalar>::parse($text) {
                    Ok(v) => v,
                    Err(e) => panic!("{name} must accept {:?}: {e:?}", $text),
                };
                assert_eq!(
                    value.canonical(),
                    $canon,
                    "{name} canonicalises {:?} wrongly",
                    $text
                );
                let round = <$ty as Scalar>::parse(&value.canonical());
                assert_eq!(
                    round.as_ref(),
                    Ok(&value),
                    "L1c: {name} does not round-trip its own canonical form of {:?}",
                    $text
                );
                accepted.push(value);
            )*
            $(
                match <$ty as Scalar>::parse($bad) {
                    Ok(v) => panic!("{name} must refuse {:?}, got {v:?}", $bad),
                    Err(e) => assert_eq!(
                        e.scalar, name,
                        "{name} refused {:?} under another scalar's name",
                        $bad
                    ),
                }
            )*
            for a in &accepted {
                for b in &accepted {
                    assert_eq!(
                        a == b,
                        a.canonical() == b.canonical(),
                        "L3: {name} disagrees on {a:?} vs {b:?}"
                    );
                }
            }
            $( $extra )?
        }
    };
}

scalar_cases! {
    cases_ip4_addr, Ip4Addr,
    accept: [("10.2.0.0", "10.2.0.0"), ("203.0.113.10", "203.0.113.10")],
    refuse: ["010.1.1.1", "1.2.3.4 "],
}

scalar_cases! {
    cases_ip6_addr, Ip6Addr,
    accept: [
        ("2001:DB8:0:0:0:0:0:1", "2001:db8::1"),
        ("::FFFF:C000:201", "::ffff:192.0.2.1"),
        ("2001:0db8:0000:0000:0001:0000:0000:0001", "2001:db8::1:0:0:1"),
    ],
    refuse: ["1::2::3"],
}

scalar_cases! {
    cases_ip_addr, IpAddr,
    accept: [("203.0.113.10", "203.0.113.10"), ("2001:DB8::A", "2001:db8::a")],
    refuse: ["not-an-ip"],
}

scalar_cases! {
    cases_ip_prefix, IpPrefix,
    accept: [("10.2.0.0/16", "10.2.0.0/16")],
    refuse: ["10.2.0.1/16", "10.2.0.0/33"],
}

scalar_cases! {
    cases_interface_address, InterfaceAddress,
    accept: [("10.255.0.1/30", "10.255.0.1/30")],
    refuse: ["10.255.0.1/33", "10.255.0.1"],
}

scalar_cases! {
    cases_ip_range, IpRange,
    accept: [("10.0.0.1-10.0.0.9", "10.0.0.1-10.0.0.9")],
    refuse: ["10.0.0.9-10.0.0.1", "10.0.0.1-::1"],
}

scalar_cases! {
    cases_mac_address, MacAddress,
    accept: [("AA:BB:CC:DD:EE:FF", "aa:bb:cc:dd:ee:ff")],
    refuse: ["aabb.ccdd.eeff"],
}

scalar_cases! {
    cases_ip_protocol, IpProtocol,
    accept: [("50", "50"), ("51", "51")],
    refuse: ["256", "050"],
}

scalar_cases! {
    cases_l4_port, L4Port,
    accept: [("500", "500"), ("4500", "4500")],
    refuse: ["65536"],
}

scalar_cases! {
    cases_port_range, PortRange,
    accept: [("500-4500", "500-4500")],
    refuse: ["4500-500"],
}

scalar_cases! {
    cases_vlan_id, VlanId,
    accept: [("1", "1"), ("4094", "4094")],
    refuse: ["0", "4095"],
}

scalar_cases! {
    cases_asn, Asn,
    accept: [("65000", "65000"), ("1.100", "65636")],
    refuse: ["65536.0"],
}

scalar_cases! {
    cases_seconds, Seconds,
    accept: [("28800", "28800")],
    refuse: ["4294967296"],
}

scalar_cases! {
    cases_kilobytes, Kilobytes,
    accept: [("1024", "1024")],
    refuse: ["-1"],
}

scalar_cases! {
    cases_dh_group, DhGroup,
    accept: [("14", "14"), ("5", "5")],
    refuse: ["0"],
}

scalar_cases! {
    cases_encryption_algorithm, EncryptionAlgorithm,
    accept: [("aes-256-cbc", "aes-256-cbc"), ("aes-256-gcm", "aes-256-gcm")],
    refuse: ["aes-512-cbc"],
    extra: {
        // 11 §4.3: the `aead` flag is load-bearing, so it is asserted, not
        // inferred from the token.
        assert!(!EncryptionAlgorithm::parse("aes-256-cbc").unwrap().aead);
        assert!(EncryptionAlgorithm::parse("aes-256-gcm").unwrap().aead);
    },
}

scalar_cases! {
    cases_integrity_algorithm, IntegrityAlgorithm,
    accept: [("hmac-sha-256-128", "hmac-sha-256-128")],
    refuse: ["sha-256"],
}

scalar_cases! {
    cases_auth_method, AuthMethod,
    accept: [("pre-shared-keys", "pre-shared-keys")],
    refuse: ["psk"],
}

scalar_cases! {
    cases_ike_version, IkeVersion,
    accept: [("v2-only", "v2-only")],
    refuse: ["ikev2"],
}

scalar_cases! {
    cases_identifier, Identifier,
    accept: [("IKE-P1", "IKE-P1")],
    refuse: ["", "two words"],
}

scalar_cases! {
    cases_interface_name, InterfaceName,
    accept: [("reth0.0", "reth0.0"), ("st0.0", "st0.0")],
    refuse: [""],
}

scalar_cases! {
    cases_os_version, OsVersion,
    accept: [("21.4R3-S4.9", "21.4R3-S4.9")],
    refuse: [""],
}

scalar_cases! {
    cases_timestamp, Timestamp,
    accept: [
        ("1970-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z"),
        ("2000-02-29T00:00:00.000Z", "2000-02-29T00:00:00.000Z"),
        ("2026-08-01T00:00:00Z", "2026-08-01T00:00:00.000Z"),
    ],
    refuse: ["1969-12-31T23:59:59.999Z", "2026-01-01T00:00:60.000Z"],
    extra: {
        // The two values WO-01 §4.5(b) names beside their texts.
        assert_eq!(Timestamp::parse("1970-01-01T00:00:00.000Z"), Ok(Timestamp(0)));
        assert_eq!(
            Timestamp::parse("2000-02-29T00:00:00.000Z"),
            Ok(Timestamp(951_782_400_000))
        );
    },
}

scalar_cases! {
    cases_fqdn, Fqdn,
    accept: [
        ("Site-B.Example.NET.", "site-b.example.net"),
        ("site-b.example.net", "site-b.example.net"),
    ],
    refuse: ["-bad.example", "a..b"],
}

scalar_cases! {
    cases_route_distinguisher, RouteDistinguisher,
    accept: [("65000:100", "65000:100"), ("198.51.100.1:100", "198.51.100.1:100")],
    refuse: ["70000:100", "65000:4294967296"],
}

scalar_cases! {
    cases_text, Text,
    accept: [("", ""), ("free prose, as written", "free prose, as written")],
    refuse: [],
}

scalar_cases! {
    cases_date, Date,
    accept: [("2026-08-01", "2026-08-01"), ("2000-02-29", "2000-02-29")],
    refuse: ["1900-02-29", "2026-02-30", "2026-13-01"],
}

scalar_cases! {
    cases_lat_lon, LatLon,
    accept: [("-274700000/1530280000", "-274700000/1530280000"), ("0/0", "0/0")],
    refuse: ["900000001/0", "0/-1800000001", "-0/0"],
}

scalar_cases! {
    cases_clli, Clli,
    accept: [("BRBNQLDA", "BRBNQLDA"), ("BRBNQLDA001", "BRBNQLDA001")],
    refuse: ["brbnqlda", "BRBN"],
}

scalar_cases! {
    cases_bandwidth, Bandwidth,
    accept: [("1000000000", "1000000000")],
    refuse: ["1g"],
}

scalar_cases! {
    cases_tz_name, TzName,
    accept: [("Australia/Brisbane", "Australia/Brisbane"), ("UTC", "UTC")],
    refuse: ["Australia Brisbane"],
}

scalar_cases! {
    cases_platform_id, PlatformId,
    accept: [("junos-srx", "junos-srx"), ("panos", "panos"), ("ios-xe", "ios-xe")],
    refuse: ["Junos-SRX"],
}

scalar_cases! {
    cases_inference_rule_id, InferenceRuleId,
    accept: [("infer.route.next-hop-interface", "infer.route.next-hop-interface")],
    refuse: ["route.next-hop-interface"],
}

scalar_cases! {
    cases_route_target, RouteTarget,
    accept: [("target:65000:100", "65000:100"), ("65000:100", "65000:100")],
    refuse: ["target:"],
}

scalar_cases! {
    cases_ospf_area_id, OspfAreaId,
    accept: [("0.0.0.0", "0.0.0.0"), ("0", "0.0.0.0")],
    refuse: ["0.0.0.256"],
}

// --- WO-01 §4.5(c): the two named structural tests. -------------------------

// The civil-date conversion, transcribed from WO-01 §4.2's fence. It is
// re-stated here rather than reached for so the test derives its vectors
// instead of trusting the implementation it checks.
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

fn days_from_civil(y: u64, m: u64, d: u64) -> u64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[test]
fn timestamp_civil_conversion_vectors() {
    use fathom_ir::scalar::{Scalar, Timestamp};

    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(civil_from_days(11_016), (2000, 2, 29));

    // The ceiling is derived, not trusted.
    let ceiling = (days_from_civil(9999, 12, 31) * 86_400 + 86_399) * 1_000 + 999;
    assert_eq!(ceiling, 253_402_300_799_999);
    assert_eq!(
        Timestamp(ceiling).canonical(),
        "9999-12-31T23:59:59.999Z",
        "the last representable instant must render exactly"
    );
    assert!(
        Timestamp::parse("10000-01-01T00:00:00.000Z").is_err(),
        "one millisecond past the ceiling is out of range on the parse side"
    );
}

#[test]
fn secret_placeholder_constructs_only_from_label() {
    use fathom_ir::scalar::{SecretHint, SecretLabel, SecretPlaceholder};

    assert_eq!(
        SecretPlaceholder::new(SecretLabel::Psk).placeholder(),
        "<PSK>"
    );

    let at_cap = "v".repeat(120);
    let hint = SecretHint::new(&at_cap).expect("120 bytes is the cap, not past it");
    assert_eq!(hint.as_str(), at_cap);

    let past_cap = "v".repeat(121);
    assert!(
        SecretHint::new(&past_cap).is_err(),
        "11 §4.5 caps the hint at 120 bytes"
    );
}
