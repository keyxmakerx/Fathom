//! The demo estate — WO-08 §4.8, constructed in code, in one batch, with
//! every ULID and timestamp pinned.
//!
//! No clock and no RNG (invariant 9): every id is `Ulid::from_parts(TS0, k)`
//! with `k` the row number of §4.8's tables, and the one provenance record is
//! re-interned byte-equal on every write. It is a **demo**, not corpus data,
//! and every surface that renders it says so.

use fathom_graph::{
    Actor, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord, Timestamp,
    UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{
    CableEnd, CableMedia, DeviceRole, EdgeKind, InterfaceForm, NodeKind, PhysicalPortConnector,
    PhysicalPortService, PremisesForm, TunnelInterfaceTechnology,
};
use fathom_ir::scalar;
use fathom_ir::value;

use crate::render::key;

/// 2026-07-31T00:00:00Z — a stored value, rendered as stored, never evaluated
/// against a clock.
const TS0: u64 = 1_785_456_000_000;

/// `53` §7.2's undo label for the one batch this estate is built in.
const BATCH_LABEL: &str = "demo estate — WO-08";

fn ulid(k: u128) -> Ulid {
    Ulid::from_parts(TS0, k).expect("TS0 fits 48 bits")
}

/// The one record, byte-identical on every write (WO-02 permits re-interning).
fn prov() -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(ulid(9001)),
        origin: Origin::Hand,
        asserted_at: Timestamp(TS0),
        asserted_by: Actor::User(UserId(ulid(9000))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

fn set<T: core::any::Any>(g: &mut Graph, id: NodeId, field: &'static str, v: T) {
    g.set_field(ElementId::Node(id), key(field), v, prov())
        .unwrap_or_else(|e| panic!("{field}: {e}"));
}

fn absent(g: &mut Graph, id: NodeId, field: &'static str) {
    g.assert_absent(ElementId::Node(id), key(field), prov())
        .unwrap_or_else(|e| panic!("{field}: {e}"));
}

fn text(s: &str) -> scalar::Text {
    scalar::Text(s.to_owned())
}

fn street(line: &str) -> value::PostalAddress {
    value::PostalAddress {
        lines: vec![text(line)],
        locality: None,
        region: None,
        postcode: None,
        country: None,
    }
}

/// One node of §4.8's table: its `k`, its kind, and the writes that follow it.
type NodeStep = (u128, NodeKind, fn(&mut Graph, NodeId));

/// One edge of §4.8's table: its `k`, its kind, the two endpoints' `k`s, and
/// the `Terminates.end` value where the row carries one.
type EdgeStep = (u128, EdgeKind, u128, u128, Option<CableEnd>);

fn node_steps() -> Vec<NodeStep> {
    vec![
        (1, NodeKind::Premises, |g, id| {
            set(g, id, "Premises.label", text("Riverside CO"));
            set(g, id, "Premises.clli", scalar::Clli("RVSDTX01".to_owned()));
            set(g, id, "Premises.form", PremisesForm::CentralOffice);
            set(g, id, "Premises.street", street("101 Riverside Dr"));
        }),
        (2, NodeKind::Premises, |g, id| {
            set(g, id, "Premises.label", text("Midtown hut"));
            set(g, id, "Premises.clli", scalar::Clli("MDTNTX01".to_owned()));
            set(g, id, "Premises.form", PremisesForm::Hut);
            set(g, id, "Premises.street", street("88 Frontage Rd"));
        }),
        (3, NodeKind::Premises, |g, id| {
            set(g, id, "Premises.label", text("Bramble Logistics HQ"));
            absent(g, id, "Premises.clli");
            set(g, id, "Premises.form", PremisesForm::CustomerPremises);
            set(g, id, "Premises.street", street("1200 Commerce Pkwy"));
        }),
        (4, NodeKind::Site, |g, id| {
            set(g, id, "Site.name", text("Riverside"));
        }),
        (5, NodeKind::Site, |g, id| {
            set(g, id, "Site.name", text("Midtown"));
        }),
        (6, NodeKind::Device, |g, id| {
            set(
                g,
                id,
                "Device.hostname",
                scalar::Identifier("srx-a".to_owned()),
            );
            set(
                g,
                id,
                "Device.platform",
                scalar::PlatformId("junos-srx".to_owned()),
            );
            set(
                g,
                id,
                "Device.os_version",
                scalar::OsVersion("21.4R3".to_owned()),
            );
            set(g, id, "Device.role", DeviceRole::Firewall);
            set(g, id, "Device.cluster_id", 1u16);
        }),
        (7, NodeKind::Device, |g, id| {
            set(
                g,
                id,
                "Device.hostname",
                scalar::Identifier("hub-a".to_owned()),
            );
            set(
                g,
                id,
                "Device.platform",
                scalar::PlatformId("junos-mx".to_owned()),
            );
            set(
                g,
                id,
                "Device.os_version",
                scalar::OsVersion("21.4R3".to_owned()),
            );
            set(g, id, "Device.role", DeviceRole::Router);
        }),
        (8, NodeKind::Chassis, |g, id| {
            set(g, id, "Chassis.member_index", 0u8);
            set(
                g,
                id,
                "Chassis.model",
                scalar::Identifier("SRX345".to_owned()),
            );
        }),
        (9, NodeKind::Chassis, |g, id| {
            set(g, id, "Chassis.member_index", 1u8);
            set(
                g,
                id,
                "Chassis.model",
                scalar::Identifier("SRX345".to_owned()),
            );
        }),
        (10, NodeKind::Chassis, |g, id| {
            set(g, id, "Chassis.member_index", 0u8);
            set(
                g,
                id,
                "Chassis.model",
                scalar::Identifier("MX204".to_owned()),
            );
        }),
        (11, NodeKind::PhysicalPort, |g, id| {
            port(
                g,
                id,
                "0/3",
                PhysicalPortConnector::Rj45,
                Some(1_000_000_000),
            );
        }),
        (12, NodeKind::PhysicalPort, |g, id| {
            port(g, id, "fab", PhysicalPortConnector::Sfp, None);
        }),
        (13, NodeKind::PhysicalPort, |g, id| {
            port(
                g,
                id,
                "0/3",
                PhysicalPortConnector::Rj45,
                Some(1_000_000_000),
            );
        }),
        (14, NodeKind::PhysicalPort, |g, id| {
            port(g, id, "fab", PhysicalPortConnector::Sfp, None);
        }),
        (15, NodeKind::PhysicalPort, |g, id| {
            port(
                g,
                id,
                "0/1/0",
                PhysicalPortConnector::SfpPlus,
                Some(10_000_000_000),
            );
        }),
        (16, NodeKind::PhysicalPort, |g, id| {
            port(
                g,
                id,
                "0/1/1",
                PhysicalPortConnector::SfpPlus,
                Some(10_000_000_000),
            );
        }),
        (17, NodeKind::Cable, |g, id| {
            set(g, id, "Cable.label", text("RVSD-FW-01"));
            set(g, id, "Cable.media", CableMedia::Cat6a);
            set(g, id, "Cable.length_m", 12u32);
        }),
        (18, NodeKind::Cable, |g, id| {
            set(g, id, "Cable.label", text("FAB-0"));
            set(g, id, "Cable.media", CableMedia::Twinax);
            set(g, id, "Cable.length_m", 1u32);
        }),
        (19, NodeKind::Interface, |g, id| {
            set(
                g,
                id,
                "Interface.name",
                scalar::InterfaceName("ge-0/0/3".to_owned()),
            );
            set(g, id, "Interface.form", InterfaceForm::Ethernet);
        }),
        (20, NodeKind::Interface, |g, id| {
            set(
                g,
                id,
                "Interface.name",
                scalar::InterfaceName("ge-5/0/3".to_owned()),
            );
            set(g, id, "Interface.form", InterfaceForm::Ethernet);
        }),
        (21, NodeKind::RethInterface, |g, id| {
            set(
                g,
                id,
                "RethInterface.name",
                scalar::InterfaceName("reth0".to_owned()),
            );
        }),
        (22, NodeKind::LogicalUnit, |g, id| {
            set(g, id, "LogicalUnit.index", 0u32);
        }),
        (23, NodeKind::TunnelInterface, |g, id| {
            set(
                g,
                id,
                "TunnelInterface.name",
                scalar::InterfaceName("st0".to_owned()),
            );
            set(
                g,
                id,
                "TunnelInterface.technology",
                TunnelInterfaceTechnology::IpsecVti,
            );
        }),
        (24, NodeKind::LogicalUnit, |g, id| {
            set(g, id, "LogicalUnit.index", 0u32);
        }),
        (25, NodeKind::Interface, |g, id| {
            set(
                g,
                id,
                "Interface.name",
                scalar::InterfaceName("xe-0/1/0".to_owned()),
            );
            set(g, id, "Interface.form", InterfaceForm::Ethernet);
        }),
    ]
}

fn port(
    g: &mut Graph,
    id: NodeId,
    label: &str,
    connector: PhysicalPortConnector,
    speed_max: Option<u64>,
) {
    set(g, id, "PhysicalPort.label", text(label));
    set(g, id, "PhysicalPort.connector", connector);
    set(g, id, "PhysicalPort.service", PhysicalPortService::Ethernet);
    if let Some(bps) = speed_max {
        set(g, id, "PhysicalPort.speed_max", scalar::Bandwidth(bps));
    }
}

fn edge_steps() -> Vec<EdgeStep> {
    vec![
        (26, EdgeKind::HasDevice, 4, 6, None),
        (27, EdgeKind::HasDevice, 5, 7, None),
        (28, EdgeKind::AtPremises, 4, 1, None),
        (29, EdgeKind::AtPremises, 5, 2, None),
        (30, EdgeKind::HasChassis, 6, 8, None),
        (31, EdgeKind::HasChassis, 6, 9, None),
        (32, EdgeKind::HasChassis, 7, 10, None),
        (33, EdgeKind::HasPort, 8, 11, None),
        (34, EdgeKind::HasPort, 8, 12, None),
        (35, EdgeKind::HasPort, 9, 13, None),
        (36, EdgeKind::HasPort, 9, 14, None),
        (37, EdgeKind::HasPort, 10, 15, None),
        (38, EdgeKind::HasPort, 10, 16, None),
        (39, EdgeKind::Terminates, 17, 11, Some(CableEnd::A)),
        (40, EdgeKind::Terminates, 17, 15, Some(CableEnd::B)),
        (41, EdgeKind::Terminates, 18, 12, Some(CableEnd::A)),
        (42, EdgeKind::Terminates, 18, 14, Some(CableEnd::B)),
        (43, EdgeKind::HasInterface, 6, 19, None),
        (44, EdgeKind::HasInterface, 6, 20, None),
        (45, EdgeKind::HasInterface, 6, 21, None),
        (46, EdgeKind::HasInterface, 6, 23, None),
        (47, EdgeKind::HasInterface, 7, 25, None),
        (48, EdgeKind::HasUnit, 21, 22, None),
        (49, EdgeKind::HasUnit, 23, 24, None),
        (50, EdgeKind::Occupies, 19, 11, None),
        (51, EdgeKind::Occupies, 20, 13, None),
        (52, EdgeKind::Occupies, 25, 15, None),
    ]
}

/// The estate WO-08 §4.8 pins. Deterministic: no clock, no RNG, and a pure
/// function of the tables above.
pub fn demo_estate() -> Graph {
    build(false)
}

/// The same estate, applied in reverse insertion order. Private: it exists so
/// `rows_are_insertion_independent` can prove the projections do not read
/// insertion order. The two graphs differ only in their op log.
pub(crate) fn build(reverse: bool) -> Graph {
    let mut g = Graph::new();
    g.begin_batch(fathom_graph::BatchId(ulid(9002)), BATCH_LABEL)
        .expect("a fresh graph has no open batch");

    let mut nodes = node_steps();
    let mut edges = edge_steps();
    if reverse {
        nodes.reverse();
        edges.reverse();
    }

    let mut ids: Vec<(u128, NodeId)> = Vec::new();
    for (k, kind, fields) in &nodes {
        let id = g
            .insert_node(*kind, ulid(*k), prov())
            .unwrap_or_else(|e| panic!("node {k}: {e}"));
        ids.push((*k, id));
        fields(&mut g, id);
    }
    let node_of = |k: u128| -> NodeId {
        ids.iter()
            .find(|(n, _)| *n == k)
            .map(|(_, id)| *id)
            .unwrap_or_else(|| panic!("node {k} is not in the estate"))
    };

    for (k, kind, from, to, end) in &edges {
        let id = g
            .insert_edge(*kind, ulid(*k), node_of(*from), node_of(*to), prov())
            .unwrap_or_else(|e| panic!("edge {k}: {e}"));
        if let Some(e) = end {
            g.set_field(
                ElementId::Edge(id),
                key("Terminates.end"),
                e.clone(),
                prov(),
            )
            .unwrap_or_else(|err| panic!("edge {k} end: {err}"));
        }
    }

    g.end_batch().expect("the batch is open");
    g
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_estate_builds_with_zero_refusals() {
        // Every insert `unwrap`s, so the function returning at all is the
        // assertion that no write was refused (WO-08 §4.7.1).
        let g = demo_estate();
        assert_eq!(g.log().len(), 1, "one committed batch");
        assert_eq!(g.log()[0].label, BATCH_LABEL);
    }

    /// WO-08 §4.7.1's `rows_are_insertion_independent`. It lives here rather
    /// than in `tests/projection.rs` because the second insertion order is
    /// reached through `build`, which stays crate-private: a public builder
    /// would be a public name §4's Deliverables do not list (`78` §9 failure
    /// 1). Recorded in §12 item 10.
    #[test]
    fn rows_are_insertion_independent() {
        let a = build(false);
        let b = build(true);

        for kind in crate::InvKind::ALL {
            let render = |g: &Graph| {
                crate::rows(g, kind)
                    .into_iter()
                    .map(|r| format!("{}|{}|{}|{}", r.id, r.cells.join("|"), r.opinions, r.hints))
                    .collect::<Vec<_>>()
            };
            assert_eq!(render(&a), render(&b), "{}", kind.label());
        }

        for node in a.nodes() {
            assert_eq!(
                element_text(&a, node.id),
                element_text(&b, node.id),
                "{}",
                node.id
            );
        }

        for device in a.nodes_of_kind(NodeKind::Device) {
            assert_eq!(
                equipment_text(&a, device.id),
                equipment_text(&b, device.id),
                "{}",
                device.id
            );
        }
    }

    fn element_text(g: &Graph, id: NodeId) -> String {
        let p = crate::element_page(g, id).expect("a live node has a page");
        let fields: Vec<String> = p
            .fields
            .iter()
            .map(|f| format!("{}={}@{}", f.name, f.value, f.provenance))
            .collect();
        format!(
            "{}|{}|{}|{}|{}",
            p.kind_word,
            p.name,
            p.id,
            p.context.unwrap_or_default(),
            fields.join(";")
        )
    }

    fn equipment_text(g: &Graph, id: NodeId) -> String {
        let p = crate::equipment_page(g, id).expect("a device has an equipment page");
        let ports: Vec<String> = p
            .ports
            .iter()
            .map(|r| {
                let cable = r
                    .cabled
                    .as_ref()
                    .map(|c| format!("{}>{}", c.text, c.far_device))
                    .unwrap_or_default();
                format!(
                    "{}|{}|{}|{}|{}|{cable}",
                    r.id, r.label, r.chassis, r.connector, r.service
                )
            })
            .collect();
        let ifaces: Vec<String> = p
            .interfaces
            .iter()
            .map(|r| format!("{}|{}|{}|{}", r.id, r.name, r.kind_word, r.ports))
            .collect();
        format!(
            "{}||{}||{}",
            element_text(g, id),
            ports.join(";"),
            ifaces.join(";")
        )
    }

    #[test]
    fn demo_estate_counts_are_pinned() {
        let g = demo_estate();
        assert_eq!(g.nodes().count(), 25, "25 nodes");
        assert_eq!(g.edges().count(), 27, "27 edges");
        for (kind, n) in [
            (NodeKind::Site, 2),
            (NodeKind::Device, 2),
            (NodeKind::Chassis, 3),
            (NodeKind::Interface, 3),
            (NodeKind::RethInterface, 1),
            (NodeKind::TunnelInterface, 1),
            (NodeKind::LogicalUnit, 2),
            (NodeKind::PhysicalPort, 6),
            (NodeKind::Cable, 2),
            (NodeKind::Premises, 3),
        ] {
            assert_eq!(g.nodes_of_kind(kind).count(), n, "{kind:?}");
        }
        for (kind, n) in [
            (EdgeKind::HasDevice, 2),
            (EdgeKind::AtPremises, 2),
            (EdgeKind::HasChassis, 3),
            (EdgeKind::HasPort, 6),
            (EdgeKind::Terminates, 4),
            (EdgeKind::HasInterface, 5),
            (EdgeKind::HasUnit, 2),
            (EdgeKind::Occupies, 3),
        ] {
            assert_eq!(g.edges_of_kind(kind).count(), n, "{kind:?}");
        }
    }
}
