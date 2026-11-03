//! Link is retired (r107): no change may add one, and an old one turns into a
//! cable in one change that history keeps, the Link included.

use fathom_graph::{
    Actor, BatchId, Confidence, EdgeId, ElementId, Graph, NodeId, Origin, ProvenanceId,
    ProvenanceRecord, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::bag::typed;
use fathom_ir::generated::ir_types::{
    CableEnd, CableField, CableMedia, DeviceField, EdgeKind, InterfaceField, LinkField, LinkMedia,
    NodeKind, TerminatesField,
};
use fathom_ir::scalar::{Identifier, InterfaceName, Text};
use fathom_workspace::{
    apply_change, links_to_cables, live_links, read_change, read_plain, refuse_retired_kinds,
    write_change, write_plain, ChangeError, LINKS_TO_CABLES_LABEL,
};

const AT: u64 = 1_700_000_000_000;

fn ulid(n: u128) -> Ulid {
    Ulid::from_parts(AT, n).expect("48-bit timestamp")
}

const PERSON: u128 = 7;
const SYSTEM: u128 = 9;

fn by(who: u128) -> Actor {
    Actor::User(UserId(ulid(who)))
}

fn prov(n: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(1_000_000 + n)),
        origin: Origin::Hand,
        asserted_at: Timestamp(AT),
        asserted_by: by(PERSON),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

struct Built {
    g: Graph,
    ports: [NodeId; 2],
    link: EdgeId,
}

/// Two devices, each with an interface; `ported` says which interfaces sit on
/// a port. One Link between the interfaces, carrying `media`.
fn two_devices(ported: [bool; 2], media: Option<LinkMedia>) -> Built {
    let mut g = Graph::new();
    let mut n = 0u128;
    let mut next = || {
        n += 1;
        n
    };
    g.begin_batch(BatchId(ulid(0)), "drawn by hand").unwrap();
    let mut ifaces = Vec::new();
    let mut ports = Vec::new();
    for (host, ported) in [("core-sw1", ported[0]), ("edge-r1", ported[1])] {
        let i = next();
        let dev = g.insert_node(NodeKind::Device, ulid(i), prov(i)).unwrap();
        g.set_field(
            dev.into(),
            DeviceField::Hostname.key(),
            Identifier(host.into()),
            prov(next()),
        )
        .unwrap();
        let i = next();
        let iface = g
            .insert_node(NodeKind::Interface, ulid(i), prov(i))
            .unwrap();
        g.set_field(
            iface.into(),
            InterfaceField::Name.key(),
            InterfaceName("ge-0/0/1".into()),
            prov(next()),
        )
        .unwrap();
        let i = next();
        g.insert_edge(EdgeKind::HasInterface, ulid(i), dev, iface, prov(i))
            .unwrap();
        let i = next();
        let chassis = g.insert_node(NodeKind::Chassis, ulid(i), prov(i)).unwrap();
        let i = next();
        g.insert_edge(EdgeKind::HasChassis, ulid(i), dev, chassis, prov(i))
            .unwrap();
        let i = next();
        let port = g
            .insert_node(NodeKind::PhysicalPort, ulid(i), prov(i))
            .unwrap();
        let i = next();
        g.insert_edge(EdgeKind::HasPort, ulid(i), chassis, port, prov(i))
            .unwrap();
        if ported {
            let i = next();
            g.insert_edge(EdgeKind::Occupies, ulid(i), iface, port, prov(i))
                .unwrap();
        }
        ifaces.push(iface);
        ports.push(port);
    }
    let i = next();
    let link = g
        .insert_edge(EdgeKind::Link, ulid(i), ifaces[0], ifaces[1], prov(i))
        .unwrap();
    let el = ElementId::Edge(link);
    g.set_field(
        el,
        LinkField::Label.key(),
        Text("patch 12".into()),
        prov(next()),
    )
    .unwrap();
    g.set_field(el, LinkField::LengthM.key(), 3u32, prov(next()))
        .unwrap();
    g.set_field(
        el,
        LinkField::ProviderCircuit.key(),
        Text("CKT-0042".into()),
        prov(next()),
    )
    .unwrap();
    if let Some(m) = media {
        g.set_field(el, LinkField::Media.key(), m, prov(next()))
            .unwrap();
    }
    g.end_batch().unwrap();
    Built {
        g,
        ports: [ports[0], ports[1]],
        link,
    }
}

/// Build the conversion as the server would, send it through the change
/// format, and apply it as the system account.
fn convert(g: &Graph) -> Graph {
    let mut n = 0u128;
    let change = links_to_cables(
        g,
        BatchId(ulid(500_000)),
        by(SYSTEM),
        Timestamp(AT + 1),
        || {
            n += 1;
            ulid(600_000 + n)
        },
    )
    .expect("builds")
    .expect("there is a link to convert");
    let wire = read_change(&write_change(&change)).expect("reads back");
    assert_eq!(wire, change, "the change survives its own format");
    refuse_retired_kinds(&wire).expect("the conversion adds no Link");
    let mut after = g.clone();
    apply_change(&mut after, &wire, by(SYSTEM)).expect("applies as the system account");
    after
}

fn the_cable(g: &Graph) -> NodeId {
    let live: Vec<NodeId> = g
        .nodes_of_kind(NodeKind::Cable)
        .filter(|c| c.absent_since.is_none())
        .map(|c| c.id)
        .collect();
    assert_eq!(live.len(), 1, "one cable per link");
    live[0]
}

fn terminations(g: &Graph, cable: NodeId) -> Vec<(CableEnd, NodeId)> {
    let mut out: Vec<(CableEnd, NodeId)> = g
        .out(cable, EdgeKind::Terminates)
        .map(|e| {
            let end = typed::<CableEnd, _>(e, TerminatesField::End.key())
                .unwrap()
                .clone();
            (end, e.to)
        })
        .collect();
    out.sort_by_key(|(e, _)| matches!(e, CableEnd::B));
    out
}

fn text(g: &Graph, cable: NodeId, key: fathom_ir::bag::FieldKey) -> Option<String> {
    typed::<Text, _>(g.node(cable).unwrap(), key)
        .ok()
        .map(|t| t.0.clone())
}

#[test]
fn a_design_holding_a_link_opens_with_one_cable_carrying_its_fields() {
    let b = two_devices([true, true], Some(LinkMedia::Dac));
    let after = convert(&b.g);

    // It writes and reads back: the design opens.
    let bytes = write_plain(&after).expect("writes");
    let opened = read_plain(&bytes).expect("opens");
    assert_eq!(write_plain(&opened).unwrap(), bytes, "and round-trips");

    let cable = the_cable(&opened);
    let node = opened.node(cable).unwrap();
    assert_eq!(
        text(&opened, cable, CableField::Label.key()).as_deref(),
        Some("patch 12")
    );
    assert_eq!(
        typed::<u32, _>(node, CableField::LengthM.key()).ok(),
        Some(&3)
    );
    assert_eq!(
        text(&opened, cable, CableField::ProviderCircuit.key()).as_deref(),
        Some("CKT-0042")
    );
    assert_eq!(
        typed::<CableMedia, _>(node, CableField::Media.key()).ok(),
        Some(&CableMedia::Twinax)
    );
    assert_eq!(text(&opened, cable, CableField::Notes.key()), None);
    assert_eq!(
        terminations(&opened, cable),
        vec![(CableEnd::A, b.ports[0]), (CableEnd::B, b.ports[1])]
    );

    // History keeps the Link, tombstoned, and the change that closed it.
    let link = opened.edge(b.link).expect("the Link is still held");
    assert!(link.absent_since.is_some(), "and no longer live");
    assert!(live_links(&opened).is_empty());
    let last = opened.log().last().unwrap();
    assert_eq!(last.label, LINKS_TO_CABLES_LABEL);
    assert_eq!(opened.log().len(), 2, "the hand-drawn batch is untouched");
    for rec in opened.log()[1].ops.iter().filter_map(|op| match op {
        fathom_graph::Op::AddNode { prov, .. }
        | fathom_graph::Op::AddEdge { prov, .. }
        | fathom_graph::Op::SetField { prov, .. } => Some(*prov),
        _ => None,
    }) {
        let r = opened.provenance(rec).unwrap();
        assert_eq!(
            r.asserted_by,
            by(SYSTEM),
            "made by the system, not the reader"
        );
        assert_eq!(r.confidence, Confidence::Derived);
    }
}

#[test]
fn unknown_media_stays_unset() {
    let after = convert(&two_devices([true, true], Some(LinkMedia::Unknown("unknown".into()))).g);
    let cable = the_cable(&after);
    assert!(typed::<CableMedia, _>(after.node(cable).unwrap(), CableField::Media.key()).is_err());
    assert_eq!(text(&after, cable, CableField::Notes.key()), None);
}

#[test]
fn copper_and_fibre_name_no_single_cable_media_so_the_notes_keep_them() {
    for (media, said) in [(LinkMedia::Copper, "copper"), (LinkMedia::Fibre, "fibre")] {
        let after = convert(&two_devices([true, true], Some(media)).g);
        let cable = the_cable(&after);
        assert!(
            typed::<CableMedia, _>(after.node(cable).unwrap(), CableField::Media.key()).is_err()
        );
        assert_eq!(
            text(&after, cable, CableField::Notes.key()),
            Some(format!("The old link said {said}."))
        );
    }
}

#[test]
fn an_end_with_no_port_is_left_open_and_named() {
    let b = two_devices([true, false], None);
    let after = convert(&b.g);
    let cable = the_cable(&after);
    assert_eq!(terminations(&after, cable), vec![(CableEnd::A, b.ports[0])]);
    assert_eq!(
        text(&after, cable, CableField::Notes.key()).as_deref(),
        Some("End B was edge-r1 ge-0/0/1, which sits on no single port.")
    );
    // Fathom made no tie of its own.
    assert_eq!(after.edges_of_kind(EdgeKind::Occupies).count(), 1);
}

#[test]
fn a_design_without_live_links_needs_no_change() {
    let after = convert(&two_devices([true, true], None).g);
    let again = links_to_cables(&after, BatchId(ulid(1)), by(SYSTEM), Timestamp(AT), || {
        unreachable!("nothing to mint")
    })
    .unwrap();
    assert!(again.is_none(), "converting twice changes nothing");
}

#[test]
fn a_submitted_change_adding_a_link_is_refused() {
    let b = two_devices([true, true], None);
    let mut g = b.g.clone();
    let ends = (g.edge(b.link).unwrap().from, g.edge(b.link).unwrap().to);
    g.begin_batch(BatchId(ulid(700_000)), "another link")
        .unwrap();
    let rec = ProvenanceRecord {
        id: ProvenanceId(ulid(700_001)),
        ..prov(0)
    };
    // A second Link on the same pair would break the cardinality; give it
    // fresh ends instead by reusing the pair after tombstoning the first.
    g.tombstone(ElementId::Edge(b.link), Timestamp(AT), by(PERSON))
        .unwrap();
    g.insert_edge(EdgeKind::Link, ulid(700_002), ends.0, ends.1, rec.clone())
        .unwrap();
    g.end_batch().unwrap();
    let change = fathom_workspace::Change {
        batch: g.log().last().unwrap().clone(),
        provenance: vec![rec],
        values: Vec::new(),
    };
    assert!(matches!(
        refuse_retired_kinds(&change),
        Err(ChangeError::RetiredKind { kind: "Link" })
    ));
}
