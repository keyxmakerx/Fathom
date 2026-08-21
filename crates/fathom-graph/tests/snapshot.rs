//! The snapshot pair (WO-05 §4.3): everything the store holds leaves memory
//! and comes back, and loading re-enforces every refusal writing did.
//!
//! The graph under test is `11` §15's side-1 slice — the same subgraph WO-02's
//! worked example builds, rebuilt here because integration tests are separate
//! binaries. Two laws: `to_snapshot(&from_snapshot(&s)?)? == s`, and the
//! reloaded store answers every observable read the same way.

use fathom_graph::{
    Actor, BatchId, Confidence, EdgeSnap, ElementId, FieldSnap, Graph, HistoryEntrySnap, NodeId,
    Origin, ProvenanceId, ProvenanceRecord, Snapshot, SnapshotError, StoredPresence, Timestamp,
    UserId, WriteError,
};
use fathom_id::Ulid;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{
    DeviceField, EdgeKind, HostService, IkeGatewayField, IkePolicyField, IkeProposalField,
    IpsecPolicyField, IpsecProposalField, IpsecVpnField, LogicalUnitField, NodeKind,
    RethInterfaceField, SiteField, TunnelInterfaceField, TunnelInterfaceTechnology,
    UsesProposalField, ZoneField, ZoneMemberField,
};
use fathom_ir::scalar::{Identifier, InterfaceName, PlatformId, Text};
use std::collections::BTreeSet;

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

/// `11` §15's side-1 slice, as WO-02 §4.3 builds it.
fn side1() -> Graph {
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

    let set = |g: &mut Graph, e: ElementId, k: FieldKey, v: Text, n: u128| {
        g.set_field(e, k, v, prov(n)).expect("text field")
    };
    set(
        &mut g,
        ElementId::Node(site),
        SiteField::Name.key(),
        Text("Site A".to_owned()),
        100,
    );
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
    // Piece #2: Absent, not Unknown — somebody looked.
    g.assert_absent(
        ElementId::Edge(member_vpn),
        ZoneMemberField::HostInboundSystemServices.key(),
        prov(110),
    )
    .expect("piece #2");
    // Piece #3: ike on the WAN-facing binding.
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
    g
}

/// The second law: the reloaded store answers every observable read the same.
fn same_observables(a: &Graph, b: &Graph) {
    let ids_a: Vec<NodeId> = a.nodes().map(|n| n.id).collect();
    let ids_b: Vec<NodeId> = b.nodes().map(|n| n.id).collect();
    assert_eq!(ids_a, ids_b, "node iteration order");
    let edges_a: Vec<_> = a
        .edges()
        .map(|e| (e.id, e.from, e.to, e.absent_since))
        .collect();
    let edges_b: Vec<_> = b
        .edges()
        .map(|e| (e.id, e.from, e.to, e.absent_since))
        .collect();
    assert_eq!(edges_a, edges_b, "edge iteration order and endpoints");
    for n in a.nodes() {
        assert_eq!(a.owner(n.id), b.owner(n.id), "containment parent");
        for k in EdgeKind::ALL {
            let oa: Vec<_> = a.out(n.id, k).map(|e| e.id).collect();
            let ob: Vec<_> = b.out(n.id, k).map(|e| e.id).collect();
            assert_eq!(oa, ob, "out adjacency");
            let ia: Vec<_> = a.inn(n.id, k).map(|e| e.id).collect();
            let ib: Vec<_> = b.inn(n.id, k).map(|e| e.id).collect();
            assert_eq!(ia, ib, "in adjacency");
        }
        for key in n.id.kind.fields() {
            let element = ElementId::Node(n.id);
            assert_eq!(a.presence(element, *key), b.presence(element, *key));
            assert_eq!(
                a.history(element, *key).map(|h| h.entries().len()),
                b.history(element, *key).map(|h| h.entries().len())
            );
        }
    }
    for e in a.edges() {
        for key in e.id.kind.fields() {
            let element = ElementId::Edge(e.id);
            assert_eq!(a.presence(element, *key), b.presence(element, *key));
        }
    }
    let prov_a: Vec<_> = a.to_snapshot().expect("closed").provenance;
    let prov_b: Vec<_> = b.to_snapshot().expect("closed").provenance;
    assert_eq!(prov_a, prov_b, "provenance table");
    assert_eq!(a.log(), b.log(), "the op log");
}

#[test]
fn worked_example_snapshot_round_trips() {
    let g = side1();
    let s = g.to_snapshot().expect("closed store");
    assert_eq!(s.nodes.len(), 14);
    assert_eq!(s.edges.len(), 22);
    assert_eq!(s.batches.len(), 1);
    let reloaded = Graph::from_snapshot(&s).expect("loads");
    assert_eq!(
        reloaded.to_snapshot().expect("closed"),
        s,
        "to_snapshot(from_snapshot(s)) == s"
    );
    same_observables(&g, &reloaded);
}

#[test]
fn empty_graph_snapshot_round_trips() {
    let g = Graph::new();
    let s = g.to_snapshot().expect("no open batch");
    assert!(s.nodes.is_empty() && s.edges.is_empty() && s.batches.is_empty());
    let reloaded = Graph::from_snapshot(&s).expect("loads");
    assert_eq!(reloaded.to_snapshot().expect("closed"), s);
}

#[test]
fn open_batch_refused() {
    let mut g = Graph::new();
    g.begin_batch(BatchId(ulid(0)), "half an intention")
        .expect("open");
    match g.to_snapshot().err() {
        Some(SnapshotError::OpenBatch { open }) => assert_eq!(open, BatchId(ulid(0))),
        other => panic!("serialising mid-intention must refuse: {other:?}"),
    }
    g.end_batch().expect("close");
    assert!(g.to_snapshot().is_ok());
}

#[test]
fn dangling_provenance_refused() {
    let g = side1();
    let mut s = g.to_snapshot().expect("closed");
    let dropped = s.nodes[0].existence;
    s.provenance.retain(|r| r.id != dropped);
    match Graph::from_snapshot(&s).err() {
        Some(SnapshotError::DanglingProvenance { id }) => assert_eq!(id, dropped),
        other => panic!("a provenance id that resolves to nothing must refuse: {other:?}"),
    }
}

#[test]
fn endpoint_kind_still_refused_on_load() {
    // Hand-built: a ZoneMember whose `to` end is a Device. The write path
    // could never have produced it; the load path refuses it by the same
    // name, from the same ladder.
    let existence = prov(1);
    let zone = NodeId {
        kind: NodeKind::Zone,
        ulid: ulid(1),
    };
    let device = NodeId {
        kind: NodeKind::Device,
        ulid: ulid(2),
    };
    let mut nodes = vec![
        fathom_graph::NodeSnap {
            id: zone,
            existence: existence.id,
            absent_since: None,
            fields: vec![],
        },
        fathom_graph::NodeSnap {
            id: device,
            existence: existence.id,
            absent_since: None,
            fields: vec![],
        },
    ];
    nodes.sort_by_key(|n| n.id);
    let s = Snapshot {
        nodes,
        edges: vec![EdgeSnap {
            id: fathom_graph::EdgeId {
                kind: EdgeKind::ZoneMember,
                ulid: ulid(3),
            },
            from: zone,
            to: device,
            prov: existence.id,
            absent_since: None,
            fields: vec![],
        }],
        provenance: vec![existence],
        history: vec![],
        batches: vec![],
    };
    match Graph::from_snapshot(&s).err() {
        Some(SnapshotError::L0(WriteError::EndpointKind { edge, .. })) => {
            assert_eq!(edge, EdgeKind::ZoneMember)
        }
        other => panic!("L0 must refuse on load: {other:?}"),
    }
}

#[test]
fn symmetric_not_normalised_refused() {
    // `Link` is symmetric: the writer stores the smaller NodeId as `from`.
    let existence = prov(1);
    let lo = NodeId {
        kind: NodeKind::Interface,
        ulid: ulid(1),
    };
    let hi = NodeId {
        kind: NodeKind::Interface,
        ulid: ulid(2),
    };
    assert!(lo < hi);
    let link = fathom_graph::EdgeId {
        kind: EdgeKind::Link,
        ulid: ulid(3),
    };
    let snap = |from: NodeId, to: NodeId| Snapshot {
        nodes: vec![
            fathom_graph::NodeSnap {
                id: lo,
                existence: existence.id,
                absent_since: None,
                fields: vec![],
            },
            fathom_graph::NodeSnap {
                id: hi,
                existence: existence.id,
                absent_since: None,
                fields: vec![],
            },
        ],
        edges: vec![EdgeSnap {
            id: link,
            from,
            to,
            prov: existence.id,
            absent_since: None,
            fields: vec![],
        }],
        provenance: vec![existence.clone()],
        history: vec![],
        batches: vec![],
    };
    // Denormalised is refused, never silently fixed.
    match Graph::from_snapshot(&snap(hi, lo)).err() {
        Some(SnapshotError::SymmetricNotNormalised { edge }) => assert_eq!(edge, link),
        other => panic!("a denormalised symmetric pair must refuse: {other:?}"),
    }
    // Normalised loads.
    assert!(Graph::from_snapshot(&snap(lo, hi)).is_ok());
}

#[test]
fn unknown_presence_in_fields_refused() {
    let g = side1();
    let mut s = g.to_snapshot().expect("closed");
    let node = s
        .nodes
        .iter_mut()
        .find(|n| !n.fields.is_empty())
        .expect("some node carries a field");
    let element = ElementId::Node(node.id);
    let key = node.fields[0].key;
    node.fields[0] = FieldSnap {
        key,
        presence: StoredPresence::Unknown,
        value: None,
        prov: node.fields[0].prov,
    };
    match Graph::from_snapshot(&s).err() {
        Some(SnapshotError::UnknownFieldPresence { element: e, key: k }) => {
            assert_eq!((e, k), (element, key))
        }
        other => panic!("Unknown is the absence of a slot, never a slot: {other:?}"),
    }
    // The value/presence rule is enforced in the same place.
    let mut s = g.to_snapshot().expect("closed");
    let node = s
        .nodes
        .iter_mut()
        .find(|n| n.fields.iter().any(|f| f.presence == StoredPresence::Set))
        .expect("some node carries a set field");
    let slot = node
        .fields
        .iter_mut()
        .find(|f| f.presence == StoredPresence::Set)
        .expect("checked");
    slot.value = None;
    assert!(matches!(
        Graph::from_snapshot(&s).err(),
        Some(SnapshotError::ValuePresenceMismatch { .. })
    ));
}

#[test]
fn tombstones_history_and_log_survive() {
    let mut g = side1();
    let device = g
        .nodes()
        .find(|n| n.id.kind == NodeKind::Device)
        .expect("side 1 has a device")
        .id;
    let site = g
        .nodes()
        .find(|n| n.id.kind == NodeKind::Site)
        .expect("side 1 has a site")
        .id;

    g.begin_batch(BatchId(ulid(500)), "rename, clear, retire")
        .expect("open");
    // A re-write: the replaced value moves into the history.
    g.set_field(
        ElementId::Node(device),
        DeviceField::Hostname.key(),
        Identifier("srx-a-02".to_owned()),
        prov(200),
    )
    .expect("rename");
    // A clear: `Unknown`, with its own history entry and no slot left.
    g.clear_field(ElementId::Node(site), SiteField::Name.key(), prov(201))
        .expect("clear");
    // A tombstone, which cascades down containment.
    g.tombstone(
        ElementId::Node(site),
        Timestamp(AT + 1),
        fathom_graph::Actor::User(fathom_graph::UserId::LOCAL),
    )
    .expect("tombstone");
    g.end_batch().expect("close");

    let s = g.to_snapshot().expect("closed");
    assert_eq!(s.batches.len(), 2, "both batches are in the log");
    assert!(
        s.nodes
            .iter()
            .all(|n| n.absent_since == Some(Timestamp(AT + 1))),
        "the cascade reached the whole containment subtree"
    );
    let hostname_history = s
        .history
        .iter()
        .find(|h| h.element == ElementId::Node(device) && h.key == DeviceField::Hostname.key())
        .expect("the replaced hostname is recorded");
    assert_eq!(hostname_history.entries.len(), 1);
    assert_eq!(
        hostname_history.entries[0],
        HistoryEntrySnap {
            presence: StoredPresence::Set,
            value: Some(fathom_canon::Json::Str("srx-a-01".to_owned())),
            prov: prov(101).id,
        }
    );
    let name_history = s
        .history
        .iter()
        .find(|h| h.element == ElementId::Node(site) && h.key == SiteField::Name.key())
        .expect("the cleared name is recorded");
    assert_eq!(
        name_history.entries.len(),
        2,
        "the old value, then the clear"
    );
    assert_eq!(name_history.entries[1].presence, StoredPresence::Unknown);
    assert_eq!(name_history.entries[1].value, None);

    let reloaded = Graph::from_snapshot(&s).expect("loads");
    assert_eq!(reloaded.to_snapshot().expect("closed"), s);
    same_observables(&g, &reloaded);
}
