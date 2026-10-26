//! **What an AI key is shown of a design** (ADR-0072 decision 6).
//!
//! A design reaches an AI as a *reading*: a purpose-built JSON document listing
//! the nodes and edges an allowlist names, each with only the fields the
//! allowlist names. It is built field by field from the stored graph. A kind,
//! an edge kind or a field nobody listed here does not leave, so a schema
//! release that adds a field adds nothing to what an AI sees until someone
//! lists it here on purpose.
//!
//! Three tiers, matching the key's ticks:
//!
//! * `layout`, always: places, racks, devices and their models, ports, cables,
//!   tags, interfaces by name, containers.
//! * `addresses`: what pasted configs set and an AI needs to reason about a
//!   network: IP addresses, VLANs, logical units, interface descriptions, a
//!   device's management address and domain.
//! * `notes`: shared notes, free-text labels and the notes fields on ports,
//!   cables and premises.
//!
//! **Never, at any tier:** history, provenance, the batch log, file contents,
//! serial numbers, street addresses and coordinates, contacts, and every
//! security, NAT, IKE and IPsec kind. A tombstoned element is not shown.
//!
//! **Belt and braces on text.** Every string value that leaves is run through
//! the redaction gate's bare check (`fathom_ingest::redact::looks_like_credential_bare`),
//! the same check a cable correction's text passes. A value it flags is
//! replaced by `null` and counted in `withheld`, so a credential that reached a
//! note despite the save-time gate still does not reach an AI vendor.
//!
//! The graph type holds `Rc`s and is not `Send`: everything here is synchronous
//! and returns plain [`Json`], so no graph is held across an `.await`.

use std::collections::{BTreeMap, BTreeSet};

use fathom_canon::Json;
use fathom_graph::Graph;
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{
    AddressField, AggregateInterfaceField, CableField, CableRunField, CableTieField, CardField,
    ChassisField, ContainerField, ContainerNetworkField, DeviceField, EdgeKind, ExternalPeerField,
    FixedToField, InterfaceField, LabelField, LineEndField, LineField, LinkField, LogicalUnitField,
    MountedInField, NodeKind, NoteField, OccupiesField, PassiveNodeField, PhysicalPortField,
    PowerSupplyField, PremisesField, PublishedPortField, RackField, SiteField, SitsOnField,
    SurfaceField, TagField, TerminatesField, VlanField, VlanMemberField,
};

/// The three things a key may be allowed to see.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Layout,
    Addresses,
    Notes,
}

impl Tier {
    pub const ALL: [Tier; 3] = [Tier::Layout, Tier::Addresses, Tier::Notes];

    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Layout => "layout",
            Tier::Addresses => "addresses",
            Tier::Notes => "notes",
        }
    }

    pub fn parse(text: &str) -> Option<Tier> {
        Tier::ALL.into_iter().find(|t| t.as_str() == text)
    }
}

/// One allowlist row: a node kind and the fields of it a tier shows.
struct NodeRow {
    tier: Tier,
    kind: NodeKind,
    fields: &'static [(FieldKey, &'static str)],
}

/// One allowlist row for an edge kind.
struct EdgeRow {
    tier: Tier,
    kind: EdgeKind,
    fields: &'static [(FieldKey, &'static str)],
}

macro_rules! fields {
    ($ty:ident: $($variant:ident),* $(,)?) => {
        &[$(($ty::$variant.key(), $ty::$variant.name())),*]
    };
}

/// Every node kind and field an AI may be shown, by tier. A kind listed in a
/// higher tier with no layout row appears only at that tier.
const NODES: &[NodeRow] = &[
    // ---- layout ----
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Site,
        fields: fields!(SiteField: Name, Code),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Premises,
        fields: fields!(PremisesField: Label, Form),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Rack,
        fields: fields!(RackField: Label, HeightU, UnitNumbering, Row, Bay),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Surface,
        fields: fields!(SurfaceField: Label, Form, WidthMm, HeightMm),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Device,
        fields: fields!(DeviceField: Hostname, Platform, OsVersion, Role),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Chassis,
        fields: fields!(ChassisField: MemberIndex, Model, Slots),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::PowerSupply,
        fields: fields!(PowerSupplyField: Slot, Model),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Card,
        fields: fields!(CardField: Slot, Name, Model),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::ExternalPeer,
        fields: fields!(ExternalPeerField: Label, PlatformGuess),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::PhysicalPort,
        fields: fields!(PhysicalPortField: Label, Position, Connector, Service, Face, SpeedMax, Transceiver),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Cable,
        fields: fields!(CableField: Label, Assembly, Media, LengthM, Sheath, NeedsFinishing),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::CableRun,
        fields: fields!(CableRunField: Form, Side, Label),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::CableTie,
        fields: fields!(CableTieField: At),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::PassiveNode,
        fields: fields!(PassiveNodeField: Label, Form, SplitRatio, Model, Slots),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Interface,
        fields: fields!(InterfaceField: Name, Form, AdminUp, Speed),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::AggregateInterface,
        fields: fields!(AggregateInterfaceField: Name, AdminUp, LinkSpeed, MinimumLinks),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Container,
        fields: fields!(ContainerField: Name),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::ContainerNetwork,
        fields: fields!(ContainerNetworkField: Name, Driver),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::PublishedPort,
        fields: fields!(PublishedPortField: Protocol, ContainerPort, HostPort),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Tag,
        fields: fields!(TagField: Name),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Line,
        fields: fields!(LineField: Label),
    },
    // ---- addresses, VLANs and what configs set ----
    NodeRow {
        tier: Tier::Addresses,
        kind: NodeKind::Device,
        fields: fields!(DeviceField: DomainName, ManagementAddress),
    },
    NodeRow {
        tier: Tier::Addresses,
        kind: NodeKind::Interface,
        fields: fields!(InterfaceField: Description, Mtu, Duplex, VlanTagging),
    },
    NodeRow {
        tier: Tier::Addresses,
        kind: NodeKind::AggregateInterface,
        fields: fields!(AggregateInterfaceField: Description, LacpMode, Mtu),
    },
    NodeRow {
        tier: Tier::Addresses,
        kind: NodeKind::LogicalUnit,
        fields: fields!(LogicalUnitField: Index, Description, VlanId, Families, AdminUp),
    },
    NodeRow {
        tier: Tier::Addresses,
        kind: NodeKind::Address,
        fields: fields!(AddressField: Value, Family, IsPrimary),
    },
    NodeRow {
        tier: Tier::Addresses,
        kind: NodeKind::Vlan,
        fields: fields!(VlanField: VlanId, Name, Description),
    },
    NodeRow {
        tier: Tier::Addresses,
        kind: NodeKind::ContainerNetwork,
        fields: fields!(ContainerNetworkField: Subnet, Gateway),
    },
    NodeRow {
        tier: Tier::Addresses,
        kind: NodeKind::PublishedPort,
        fields: fields!(PublishedPortField: HostAddress),
    },
    NodeRow {
        tier: Tier::Addresses,
        kind: NodeKind::PhysicalPort,
        fields: fields!(PhysicalPortField: Mac),
    },
    // ---- notes ----
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::Note,
        fields: fields!(NoteField: Text),
    },
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::Label,
        fields: fields!(LabelField: Text),
    },
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::PhysicalPort,
        fields: fields!(PhysicalPortField: Notes),
    },
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::Cable,
        fields: fields!(CableField: Notes),
    },
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::Premises,
        fields: fields!(PremisesField: Notes),
    },
];

const NO_FIELDS: &[(FieldKey, &str)] = &[];

/// Every edge kind an AI may be shown, by tier. An edge leaves only when both
/// its ends do.
const EDGES: &[EdgeRow] = &[
    // ---- layout: containment, placement and cabling ----
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasPremises,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::AtPremises,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::AtLocation,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasRack,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasSurface,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasDevice,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasChassis,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasExternalPeer,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasPassiveNode,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasPort,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasCable,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasInterface,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::MemberOfAggregate,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::MountedIn,
        fields: fields!(MountedInField: PositionU, HeightU, Face),
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::FittedIn,
        fields: NO_FIELDS,
    },
    // A card in its slot, and the ports on it (ADR-0073).
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasCard,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::OnCard,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::SitsOn,
        fields: fields!(SitsOnField: Slot),
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::FixedTo,
        fields: fields!(FixedToField: XMm, YMm),
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::Terminates,
        fields: fields!(TerminatesField: End, Lane),
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::Occupies,
        fields: fields!(OccupiesField: Lane),
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::Link,
        fields: fields!(LinkField: Media, LengthM, Label),
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::PassThrough,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasCableRun,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasCableTie,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::Ties,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasTag,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::TaggedWith,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasContainer,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasContainerNetwork,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasPublishedPort,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasLine,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::LineEnd,
        fields: fields!(LineEndField: End),
    },
    // ---- addresses ----
    EdgeRow {
        tier: Tier::Addresses,
        kind: EdgeKind::HasUnit,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Addresses,
        kind: EdgeKind::HasAddress,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Addresses,
        kind: EdgeKind::HasVlan,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Addresses,
        kind: EdgeKind::VlanMember,
        fields: fields!(VlanMemberField: Mode),
    },
    EdgeRow {
        tier: Tier::Addresses,
        kind: EdgeKind::AttachedTo,
        fields: NO_FIELDS,
    },
    // ---- notes ----
    EdgeRow {
        tier: Tier::Notes,
        kind: EdgeKind::HasNote,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Notes,
        kind: EdgeKind::HasLabel,
        fields: NO_FIELDS,
    },
];

/// What [`reading`] hands back besides the document.
pub struct Reading {
    pub document: Json,
    /// String values the credential check replaced with `null`.
    pub withheld: usize,
}

fn allowed_nodes(tiers: &BTreeSet<Tier>) -> BTreeMap<NodeKind, BTreeMap<FieldKey, &'static str>> {
    let mut out: BTreeMap<NodeKind, BTreeMap<FieldKey, &'static str>> = BTreeMap::new();
    for row in NODES.iter().filter(|r| tiers.contains(&r.tier)) {
        let entry = out.entry(row.kind).or_default();
        for (key, name) in row.fields {
            entry.insert(*key, name);
        }
    }
    out
}

fn allowed_edges(tiers: &BTreeSet<Tier>) -> BTreeMap<EdgeKind, BTreeMap<FieldKey, &'static str>> {
    let mut out: BTreeMap<EdgeKind, BTreeMap<FieldKey, &'static str>> = BTreeMap::new();
    for row in EDGES.iter().filter(|r| tiers.contains(&r.tier)) {
        let entry = out.entry(row.kind).or_default();
        for (key, name) in row.fields {
            entry.insert(*key, name);
        }
    }
    out
}

/// A value as it may leave: every string inside it checked, a flagged one
/// replaced by `null`.
fn screened(value: &Json, withheld: &mut usize) -> Json {
    match value {
        Json::Str(s) => {
            if fathom_ingest::redact::looks_like_credential_bare(s) {
                *withheld += 1;
                Json::Null
            } else {
                Json::Str(s.clone())
            }
        }
        Json::Arr(items) => Json::Arr(items.iter().map(|v| screened(v, withheld)).collect()),
        Json::Obj(map) => Json::Obj(
            map.iter()
                .map(|(k, v)| (k.clone(), screened(v, withheld)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Build the reading of `graph` for a key that sees `tiers`. `layout` is always
/// included whatever `tiers` says.
///
/// `Err` only when the graph cannot be snapshotted (an open batch), which a
/// stored design never has.
pub fn reading(graph: &Graph, tiers: &BTreeSet<Tier>) -> Result<Reading, &'static str> {
    let mut tiers = tiers.clone();
    tiers.insert(Tier::Layout);
    let node_rows = allowed_nodes(&tiers);
    let edge_rows = allowed_edges(&tiers);
    let snap = graph
        .to_snapshot()
        .map_err(|_| "the design could not be read")?;

    let mut withheld = 0usize;
    let mut shown = BTreeSet::new();
    let mut nodes = Vec::new();
    for node in &snap.nodes {
        if node.absent_since.is_some() {
            continue;
        }
        let Some(allowed) = node_rows.get(&node.id.kind) else {
            continue;
        };
        let mut fields = BTreeMap::new();
        for field in &node.fields {
            if let (Some(name), Some(value)) = (allowed.get(&field.key), &field.value) {
                let mut value = screened(value, &mut withheld);
                // An optic's serial is a serial number (ADR-0073): the rest of it may leave.
                if field.key == PhysicalPortField::Transceiver.key() {
                    if let Json::Obj(m) = &mut value {
                        m.remove("serial");
                    }
                }
                fields.insert((*name).to_string(), value);
            }
        }
        let id = node.id.to_string();
        shown.insert(id.clone());
        let mut m = BTreeMap::new();
        m.insert("id".to_string(), Json::Str(id));
        m.insert(
            "kind".to_string(),
            Json::Str(node.id.kind.name().to_string()),
        );
        m.insert("fields".to_string(), Json::Obj(fields));
        nodes.push(Json::Obj(m));
    }

    let mut edges = Vec::new();
    for edge in &snap.edges {
        if edge.absent_since.is_some() {
            continue;
        }
        let Some(allowed) = edge_rows.get(&edge.id.kind) else {
            continue;
        };
        let (from, to) = (edge.from.to_string(), edge.to.to_string());
        if !shown.contains(&from) || !shown.contains(&to) {
            continue;
        }
        let mut fields = BTreeMap::new();
        for field in &edge.fields {
            if let (Some(name), Some(value)) = (allowed.get(&field.key), &field.value) {
                fields.insert((*name).to_string(), screened(value, &mut withheld));
            }
        }
        let mut m = BTreeMap::new();
        m.insert("id".to_string(), Json::Str(edge.id.to_string()));
        m.insert(
            "kind".to_string(),
            Json::Str(edge.id.kind.name().to_string()),
        );
        m.insert("from".to_string(), Json::Str(from));
        m.insert("to".to_string(), Json::Str(to));
        m.insert("fields".to_string(), Json::Obj(fields));
        edges.push(Json::Obj(m));
    }

    let mut doc = BTreeMap::new();
    doc.insert(
        "sees".to_string(),
        Json::Arr(
            tiers
                .iter()
                .map(|t| Json::Str(t.as_str().to_string()))
                .collect(),
        ),
    );
    doc.insert("nodes".to_string(), Json::Arr(nodes));
    doc.insert("edges".to_string(), Json::Arr(edges));
    doc.insert("withheld".to_string(), Json::Int(withheld as i64));
    Ok(Reading {
        document: Json::Obj(doc),
        withheld,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_security_nat_or_vpn_kind_is_on_any_list() {
        for row in NODES {
            assert!(
                !matches!(
                    row.kind,
                    NodeKind::SecurityPolicy
                        | NodeKind::PolicySet
                        | NodeKind::Zone
                        | NodeKind::NatRule
                        | NodeKind::NatRuleSet
                        | NodeKind::IkeGateway
                        | NodeKind::IkePolicy
                        | NodeKind::IkeProposal
                        | NodeKind::IpsecPolicy
                        | NodeKind::IpsecProposal
                        | NodeKind::IpsecVpn
                        | NodeKind::Capture
                        | NodeKind::DocFile
                        | NodeKind::SystemSettings
                        | NodeKind::OverlayNetwork
                ),
                "{} must never reach an AI",
                row.kind.name()
            );
        }
    }

    #[test]
    fn no_serial_street_coordinate_or_contact_field_is_listed() {
        let banned = [
            ChassisField::Serial.key(),
            PassiveNodeField::Serial.key(),
            PowerSupplyField::Serial.key(),
            CardField::Serial.key(),
            PremisesField::Street.key(),
            PremisesField::Coordinates.key(),
            ExternalPeerField::Contact.key(),
            ExternalPeerField::Address.key(),
        ];
        for row in NODES {
            for (key, name) in row.fields {
                assert!(!banned.contains(key), "{name} must never reach an AI");
            }
        }
    }

    #[test]
    fn a_tier_is_spelled_three_ways_only() {
        for t in Tier::ALL {
            assert_eq!(Tier::parse(t.as_str()), Some(t));
        }
        assert_eq!(Tier::parse("passwords"), None);
        assert_eq!(Tier::parse("Layout"), None);
    }

    fn prov(seed: u128) -> fathom_graph::ProvenanceRecord {
        use fathom_graph::{
            Actor, Confidence, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
        };
        ProvenanceRecord {
            id: ProvenanceId(fathom_id::Ulid(seed * 10 + 2)),
            origin: Origin::Hand,
            asserted_at: Timestamp(0),
            asserted_by: Actor::User(UserId(fathom_id::Ulid(seed * 10 + 3))),
            confidence: Confidence::Asserted,
            supersedes: None,
        }
    }

    /// Belt and braces: a value that slipped past the gate on the way in, in a field the
    /// allowlist does let out, still does not leave. Device syntax, as a real device takes it.
    #[test]
    fn a_listed_field_that_reads_as_a_credential_is_withheld_and_counted() {
        use fathom_graph::BatchId;
        use fathom_ir::generated::ir_types::{CableField, DeviceField};
        use fathom_ir::scalar;
        let mut g = Graph::new();
        g.begin_batch(BatchId(fathom_id::Ulid(70)), "ai_reading fixture")
            .expect("open batch");
        let device = g
            .insert_node(NodeKind::Device, fathom_id::Ulid(71), prov(7))
            .expect("device");
        g.set_field(
            device.into(),
            DeviceField::Hostname.key(),
            scalar::Identifier("core-sw1".into()),
            prov(7),
        )
        .expect("hostname");
        let cable = g
            .insert_node(NodeKind::Cable, fathom_id::Ulid(74), prov(7))
            .expect("cable");
        g.set_field(
            cable.into(),
            CableField::Label.key(),
            scalar::Text("snmp-server community s3cr3tR0 RO".into()),
            prov(7),
        )
        .expect("label");
        g.end_batch().expect("close batch");

        let tiers: BTreeSet<Tier> = [Tier::Layout].into_iter().collect();
        let out = reading(&g, &tiers).expect("a reading");
        let text = String::from_utf8(out.document.to_canonical_bytes()).unwrap();
        assert!(text.contains("core-sw1"), "{text}");
        assert!(!text.contains("s3cr3tR0"), "{text}");
        assert_eq!(out.withheld, 1);
    }

    /// A card, the slot it sits in and the ports on it all leave at the layout tier; the
    /// card's serial does not (ADR-0073).
    #[test]
    fn a_card_and_its_ports_leave_without_the_serial() {
        use fathom_graph::BatchId;
        use fathom_ir::generated::ir_types::PhysicalPortField;
        use fathom_ir::scalar;
        let mut g = Graph::new();
        g.begin_batch(BatchId(fathom_id::Ulid(80)), "ai_reading card fixture")
            .expect("open batch");
        let chassis = g
            .insert_node(NodeKind::Chassis, fathom_id::Ulid(81), prov(8))
            .expect("chassis");
        let card = g
            .insert_node(NodeKind::Card, fathom_id::Ulid(82), prov(8))
            .expect("card");
        g.set_field(
            card.into(),
            CardField::Model.key(),
            scalar::Identifier("NM-4X".into()),
            prov(8),
        )
        .expect("model");
        g.set_field(
            card.into(),
            CardField::Serial.key(),
            scalar::Identifier("FOC2231X0QZ".into()),
            prov(8),
        )
        .expect("serial");
        let port = g
            .insert_node(NodeKind::PhysicalPort, fathom_id::Ulid(83), prov(8))
            .expect("port");
        g.set_field(
            port.into(),
            PhysicalPortField::Label.key(),
            scalar::Text("1/1".into()),
            prov(8),
        )
        .expect("label");
        g.insert_edge(
            EdgeKind::HasCard,
            fathom_id::Ulid(84),
            chassis,
            card,
            prov(8),
        )
        .expect("has card");
        g.insert_edge(
            EdgeKind::HasPort,
            fathom_id::Ulid(85),
            chassis,
            port,
            prov(8),
        )
        .expect("has port");
        g.insert_edge(EdgeKind::OnCard, fathom_id::Ulid(86), port, card, prov(8))
            .expect("on card");
        g.end_batch().expect("close batch");

        let tiers: BTreeSet<Tier> = [Tier::Layout].into_iter().collect();
        let out = reading(&g, &tiers).expect("a reading");
        let text = String::from_utf8(out.document.to_canonical_bytes()).unwrap();
        for word in ["NM-4X", "\"HasCard\"", "\"OnCard\"", "\"HasPort\""] {
            assert!(text.contains(word), "{word} missing: {text}");
        }
        assert!(!text.contains("FOC2231X0QZ"), "{text}");
    }
}
