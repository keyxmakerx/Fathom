//! The plaintext dev face (WO-05 §4.4–§4.5).
//!
//! Three headline proofs live here: **round-trip byte identity**, **version
//! present and checked**, and **the plaintext face is labelled as such**.
//!
//! The five-line vector in `PINNED` is typed in from WO-05 §4.4, never
//! regenerated from the code it checks. If the code disagrees with it, one of
//! the two is wrong and deciding which is not this test's job.

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{
    DeviceField, EdgeKind, HostService, IkeGatewayField, IkePolicyField, IkeProposalField,
    IpsecPolicyField, IpsecProposalField, IpsecVpnField, LogicalUnitField, NodeKind,
    RethInterfaceField, SiteField, TunnelInterfaceField, TunnelInterfaceTechnology,
    UsesProposalField, ZoneField, ZoneMemberField,
};
use fathom_ir::scalar::{Identifier, InterfaceName, PlatformId, Text};
use fathom_workspace::{check_plain_name, read_plain, write_plain, PlainError, PLAIN_WARNING};
use std::collections::BTreeSet;

/// WO-05 §4.4's pinned first vector, typed from the document.
///
/// Line 3 tracks `SCHEMA_VERSION` and is therefore the ONE line of this vector
/// that is not a constant of the file format: the document typed it when the
/// tree was at 0.1, and ADR-0036 moved the tree to 0.2 on 2026-08-15. The
/// payload below is byte-identical across that bump, which is the useful
/// thing this vector proves — adding a kind and two edges changes the header
/// and nothing else, so no existing workspace's body is rewritten.
///
/// **THAT IS TRUE AND IT IS NOT THE WHOLE STORY**, so it is said here rather
/// than left to be discovered: `read_plain` refuses a mismatched version on
/// THIS LINE, before the body is reached, and the migration chain is empty. A
/// 0.1 workspace is therefore unreadable by a 0.2 build regardless of the
/// payload being identical. Deliberate pre-release (nothing has shipped and
/// `schema/released/` holds no snapshot) and reasoned in ADR-0036 §5.2.
/// `pinned_header_tracks_the_schema_version` keeps the coupling honest rather
/// than leaving the next bump to discover it as a mystery diff.
const PINNED: &str = concat!(
    "fathom-plain 1\n",
    "THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.\n",
    "schema 0.2\n",
    "\n",
    r#"{"batches":[{"id":"00000000000000000000000002","label":"seed","ops":[{"add_node":{"node":"device:00000000000000000000000001","prov":"00000000000000000000000003"}}]}],"edges":[],"history":[],"nodes":[{"existence":"00000000000000000000000003","fields":{},"id":"device:00000000000000000000000001"}],"provenance":[{"asserted_at":0,"asserted_by":{"user":"00000000000000000000000004"},"confidence":"asserted","id":"00000000000000000000000003","origin":"hand"}]}"#,
    "\n",
);

/// The graph WO-05 §4.4 names, built exactly as it states it.
fn minimal_estate() -> Graph {
    let mut g = Graph::new();
    g.begin_batch(BatchId(Ulid(2)), "seed").expect("open");
    g.insert_node(
        NodeKind::Device,
        Ulid(1),
        ProvenanceRecord {
            id: ProvenanceId(Ulid(3)),
            origin: Origin::Hand,
            asserted_at: Timestamp(0),
            asserted_by: Actor::User(UserId(Ulid(4))),
            confidence: Confidence::Asserted,
            supersedes: None,
        },
    )
    .expect("bare device");
    g.end_batch().expect("close");
    g
}

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

fn prov(n: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(1_000_000 + n)),
        origin: Origin::Hand,
        asserted_at: Timestamp(AT),
        asserted_by: Actor::User(UserId(ulid(u128::MAX))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

/// `11` §15's side-1 slice, plus a second batch that exercises the shapes a
/// one-batch estate never reaches: a superseded value, a clear, a tombstone
/// cascade — and therefore all four op kinds and all three presence states.
fn worked_example() -> Graph {
    let mut g = Graph::new();
    g.begin_batch(BatchId(ulid(0)), "paste srx-a-01")
        .expect("open");

    let node = |g: &mut Graph, kind: NodeKind, n: u128| {
        g.insert_node(kind, ulid(n), prov(n)).expect("bare node")
    };
    let site = node(&mut g, NodeKind::Site, 1);
    let device = node(&mut g, NodeKind::Device, 2);
    let reth = node(&mut g, NodeKind::RethInterface, 3);
    let reth_unit = node(&mut g, NodeKind::LogicalUnit, 4);
    let st0 = node(&mut g, NodeKind::TunnelInterface, 5);
    let st0_unit = node(&mut g, NodeKind::LogicalUnit, 6);
    let zone_vpn = node(&mut g, NodeKind::Zone, 7);
    let zone_wan = node(&mut g, NodeKind::Zone, 8);
    let ike_proposal = node(&mut g, NodeKind::IkeProposal, 9);
    let ike_policy = node(&mut g, NodeKind::IkePolicy, 10);
    let ike_gateway = node(&mut g, NodeKind::IkeGateway, 11);
    let ipsec_proposal = node(&mut g, NodeKind::IpsecProposal, 12);
    let ipsec_policy = node(&mut g, NodeKind::IpsecPolicy, 13);
    let ipsec_vpn = node(&mut g, NodeKind::IpsecVpn, 14);

    let edge = |g: &mut Graph, kind: EdgeKind, from: NodeId, to: NodeId, n: u128| {
        g.insert_edge(kind, ulid(n), from, to, prov(n))
            .expect("edge")
    };
    edge(&mut g, EdgeKind::HasDevice, site, device, 20);
    edge(&mut g, EdgeKind::HasInterface, device, reth, 21);
    edge(&mut g, EdgeKind::HasUnit, reth, reth_unit, 22);
    edge(&mut g, EdgeKind::HasInterface, device, st0, 23);
    edge(&mut g, EdgeKind::HasUnit, st0, st0_unit, 24);
    edge(&mut g, EdgeKind::HasZone, device, zone_vpn, 25);
    edge(&mut g, EdgeKind::HasZone, device, zone_wan, 26);
    let member_vpn = edge(&mut g, EdgeKind::ZoneMember, zone_vpn, st0_unit, 27);
    let member_wan = edge(&mut g, EdgeKind::ZoneMember, zone_wan, reth_unit, 28);
    edge(&mut g, EdgeKind::HasIkeProposal, device, ike_proposal, 29);
    edge(&mut g, EdgeKind::HasIkePolicy, device, ike_policy, 30);
    edge(&mut g, EdgeKind::HasIkeGateway, device, ike_gateway, 31);
    edge(
        &mut g,
        EdgeKind::HasIpsecProposal,
        device,
        ipsec_proposal,
        32,
    );
    edge(&mut g, EdgeKind::HasIpsecPolicy, device, ipsec_policy, 33);
    edge(&mut g, EdgeKind::HasIpsecVpn, device, ipsec_vpn, 34);
    let uses_ike_proposal = edge(&mut g, EdgeKind::UsesProposal, ike_policy, ike_proposal, 35);
    edge(&mut g, EdgeKind::UsesIkePolicy, ike_gateway, ike_policy, 36);
    edge(
        &mut g,
        EdgeKind::ExternalInterface,
        ike_gateway,
        reth_unit,
        37,
    );
    edge(&mut g, EdgeKind::UsesIkeGateway, ipsec_vpn, ike_gateway, 38);
    let uses_ipsec_proposal = edge(
        &mut g,
        EdgeKind::UsesProposal,
        ipsec_policy,
        ipsec_proposal,
        39,
    );
    edge(
        &mut g,
        EdgeKind::UsesIpsecPolicy,
        ipsec_vpn,
        ipsec_policy,
        40,
    );
    edge(&mut g, EdgeKind::BindsInterface, ipsec_vpn, st0_unit, 41);

    g.set_field(
        ElementId::Node(site),
        SiteField::Name.key(),
        Text("Site A".to_owned()),
        prov(100),
    )
    .expect("Site.name");
    g.set_field(
        ElementId::Node(device),
        DeviceField::Hostname.key(),
        Identifier("srx-a-01".to_owned()),
        prov(101),
    )
    .expect("Device.hostname");
    g.set_field(
        ElementId::Node(device),
        DeviceField::Platform.key(),
        PlatformId("junos-srx".to_owned()),
        prov(102),
    )
    .expect("Device.platform");
    g.set_field(
        ElementId::Node(reth),
        RethInterfaceField::Name.key(),
        InterfaceName("reth0".to_owned()),
        prov(103),
    )
    .expect("reth0");
    g.set_field(
        ElementId::Node(reth_unit),
        LogicalUnitField::Index.key(),
        0u32,
        prov(104),
    )
    .expect("reth0.0");
    g.set_field(
        ElementId::Node(st0),
        TunnelInterfaceField::Name.key(),
        InterfaceName("st0".to_owned()),
        prov(105),
    )
    .expect("st0");
    g.set_field(
        ElementId::Node(st0),
        TunnelInterfaceField::Technology.key(),
        TunnelInterfaceTechnology::IpsecVti,
        prov(106),
    )
    .expect("st0 technology");
    g.set_field(
        ElementId::Node(st0_unit),
        LogicalUnitField::Index.key(),
        0u32,
        prov(107),
    )
    .expect("st0.0");
    g.set_field(
        ElementId::Node(zone_vpn),
        ZoneField::Name.key(),
        Identifier("VPN".to_owned()),
        prov(108),
    )
    .expect("zone VPN");
    g.set_field(
        ElementId::Node(zone_wan),
        ZoneField::Name.key(),
        Identifier("WAN".to_owned()),
        prov(109),
    )
    .expect("zone WAN");
    g.assert_absent(
        ElementId::Edge(member_vpn),
        ZoneMemberField::HostInboundSystemServices.key(),
        prov(110),
    )
    .expect("piece #2");
    g.set_field(
        ElementId::Edge(member_wan),
        ZoneMemberField::HostInboundSystemServices.key(),
        BTreeSet::from([HostService::Ike]),
        prov(111),
    )
    .expect("piece #3");
    for (element, key, name, n) in [
        (
            ike_proposal,
            IkeProposalField::Name.key(),
            "IKE-P1",
            112u128,
        ),
        (ike_policy, IkePolicyField::Name.key(), "IKE-POL", 113),
        (ike_gateway, IkeGatewayField::Name.key(), "GW-B", 114),
        (
            ipsec_proposal,
            IpsecProposalField::Name.key(),
            "IPSEC-P2",
            115,
        ),
        (ipsec_policy, IpsecPolicyField::Name.key(), "IPSEC-POL", 116),
        (ipsec_vpn, IpsecVpnField::Name.key(), "VPN-B", 117),
    ] {
        g.set_field(
            ElementId::Node(element),
            key,
            Identifier(name.to_owned()),
            prov(n),
        )
        .expect("name");
    }
    g.set_field(
        ElementId::Edge(uses_ike_proposal),
        UsesProposalField::Ordinal.key(),
        1u8,
        prov(118),
    )
    .expect("proposal ordinal");
    g.set_field(
        ElementId::Edge(uses_ipsec_proposal),
        UsesProposalField::Ordinal.key(),
        1u8,
        prov(119),
    )
    .expect("proposal ordinal");
    g.end_batch().expect("close");

    g.begin_batch(BatchId(ulid(500)), "rename, clear, retire")
        .expect("open");
    g.set_field(
        ElementId::Node(device),
        DeviceField::Hostname.key(),
        Identifier("srx-a-02".to_owned()),
        prov(200),
    )
    .expect("rename");
    g.clear_field(ElementId::Node(zone_wan), ZoneField::Name.key(), prov(201))
        .expect("clear");
    g.tombstone(ElementId::Edge(member_vpn), Timestamp(AT + 1))
        .expect("tombstone");
    g.end_batch().expect("close");
    g
}

#[test]
fn minimal_estate_matches_the_pinned_vector() {
    let bytes = write_plain(&minimal_estate()).expect("writes");
    assert_eq!(
        String::from_utf8(bytes).expect("UTF-8"),
        PINNED,
        "the constructed bytes and WO-05 §4.4's pinned vector must agree"
    );
}

#[test]
fn worked_example_round_trips_byte_identical() {
    let first = write_plain(&worked_example()).expect("writes");
    let reloaded = read_plain(&first).expect("reads");
    let second = write_plain(&reloaded).expect("writes again");
    assert_eq!(first, second, "write -> read -> write is byte-identical");
}

#[test]
fn empty_graph_round_trips_byte_identical() {
    let first = write_plain(&Graph::new()).expect("writes");
    let reloaded = read_plain(&first).expect("reads");
    assert_eq!(write_plain(&reloaded).expect("writes again"), first);
}

#[test]
fn banner_is_line_two_verbatim() {
    for bytes in [
        write_plain(&Graph::new()).expect("writes"),
        write_plain(&minimal_estate()).expect("writes"),
        write_plain(&worked_example()).expect("writes"),
    ] {
        let text = String::from_utf8(bytes).expect("UTF-8");
        let line2 = text.split('\n').nth(1).expect("a second line");
        assert_eq!(line2, PLAIN_WARNING);
    }
}

#[test]
fn face_version_2_refused_by_name() {
    let bumped = PINNED.replacen("fathom-plain 1", "fathom-plain 2", 1);
    match read_plain(bumped.as_bytes()).err() {
        Some(PlainError::UnsupportedFaceVersion { found }) => assert_eq!(found, "2"),
        other => panic!("a future face version must refuse by name: {other:?}"),
    }
}

/// The one line of `PINNED` that is not a format constant. Without this, the
/// next schema bump shows up as an unexplained golden-vector diff and the
/// tempting fix is to edit the vector until it passes.
#[test]
fn pinned_header_tracks_the_schema_version() {
    use fathom_ir::generated::ir_types::SCHEMA_VERSION;
    assert!(
        PINNED.contains(&format!("\nschema {SCHEMA_VERSION}\n")),
        "PINNED's line 3 is stale: the tree is at {SCHEMA_VERSION}. Retype line 3 \
         and leave the payload alone — if the payload also moved, that is a \
         wire-format change and a different conversation."
    );
}

#[test]
fn schema_version_mismatch_refused_by_name() {
    // Any version that is NOT the tree's, so this keeps testing a mismatch
    // after every bump. 0.1 is the deliberate choice: it is the version this
    // build genuinely can no longer read, so the test doubles as the
    // downgrade case — an older workspace meeting a newer build.
    let bumped = PINNED.replacen("schema 0.2", "schema 0.1", 1);
    match read_plain(bumped.as_bytes()).err() {
        Some(PlainError::SchemaVersionMismatch { found, supported }) => {
            assert_eq!(found, "0.1");
            assert_eq!(supported, "0.2");
        }
        other => panic!("a schema version difference must refuse by name: {other:?}"),
    }
}

#[test]
fn missing_banner_refused() {
    // A file whose warning has been edited away is refused, not tolerated.
    let stripped = PINNED.replacen(PLAIN_WARNING, "# nothing to see here", 1);
    assert!(matches!(
        read_plain(stripped.as_bytes()).err(),
        Some(PlainError::MissingPlaintextBanner)
    ));
    // Even a single byte of difference.
    let nudged = PINNED.replacen(PLAIN_WARNING, &PLAIN_WARNING.replace('.', "!"), 1);
    assert!(matches!(
        read_plain(nudged.as_bytes()).err(),
        Some(PlainError::MissingPlaintextBanner)
    ));
}

#[test]
fn sealed_magic_refused_as_not_plain() {
    // 32 §7.1's envelope magic: "FTHM\x1fREC".
    let mut sealed = vec![0x46, 0x54, 0x48, 0x4D, 0x1F, 0x52, 0x45, 0x43];
    sealed.extend_from_slice(&[0x01, 0x01, 0x00, 0x00]);
    assert!(matches!(
        read_plain(&sealed).err(),
        Some(PlainError::NotPlainFace)
    ));
    // And an ordinary text file is not this face either.
    assert!(matches!(
        read_plain(b"hello\n\n\n\n{}\n").err(),
        Some(PlainError::NotPlainFace)
    ));
}

#[test]
fn trailing_bytes_refused() {
    let mut extra = PINNED.as_bytes().to_vec();
    extra.push(b'x');
    match read_plain(&extra).err() {
        Some(PlainError::Json(e)) => {
            assert_eq!(e.reason, fathom_canon::ParseReason::TrailingBytes)
        }
        other => panic!("a byte after the final LF must refuse: {other:?}"),
    }
}

#[test]
fn noncanonical_ulid_in_body_refused() {
    // The same value, a second spelling: Crockford's `O` aliases `0`.
    let respelled = PINNED.replacen(
        r#""existence":"00000000000000000000000003""#,
        r#""existence":"O0000000000000000000000003""#,
        1,
    );
    assert_ne!(respelled, PINNED, "the vector must actually change");
    assert!(matches!(
        read_plain(respelled.as_bytes()).err(),
        Some(PlainError::Id(fathom_graph::IdParseError::NonCanonicalUlid))
    ));
    // And in a composite id's ULID segment.
    let respelled = PINNED.replacen(
        r#""id":"device:00000000000000000000000001""#,
        r#""id":"device:O0000000000000000000000001""#,
        1,
    );
    assert!(matches!(
        read_plain(respelled.as_bytes()).err(),
        Some(PlainError::Id(fathom_graph::IdParseError::NonCanonicalUlid))
    ));
}

#[test]
fn masquerading_names_refused() {
    for name in [
        "site-b.fathom",
        "x.frec",
        "y.fathom.fplain",
        "z.fcap",
        "m.fm",
    ] {
        assert!(
            matches!(
                check_plain_name(name).err(),
                Some(PlainError::MasqueradingName { .. })
            ),
            "{name} must not be worn by these bytes"
        );
    }
    assert!(matches!(
        check_plain_name("notes.txt").err(),
        Some(PlainError::NotPlainExtension { .. })
    ));
    assert!(check_plain_name("site-b.fplain").is_ok());
}
