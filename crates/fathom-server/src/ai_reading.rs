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
//!   tags, interfaces by name, containers; maintenance plans and "It's down"
//!   issues with their steps (what, when, where each stands, what it touches);
//!   and spares on hand (ADR-0076): each store's name, each spare's sort, model,
//!   state, count and bin, and the levels kept.
//! * `addresses`: what pasted configs set and an AI needs to reason about a
//!   network: IP addresses, VLANs, logical units, interface descriptions, a
//!   device's management address and domain.
//! * `notes`: shared notes, free-text labels and the notes fields on ports,
//!   cables and premises; what a plan's steps say before and after, what was
//!   typed while doing a plan or answering an issue, and where an issue pointed;
//!   a store's place and note, a spare's note, and the custom-field values on
//!   spares (prices and suppliers, r38-stock-how).
//!
//! **Never, at any tier:** history, provenance, the batch log, file contents,
//! serial numbers, street addresses and coordinates, contacts (who a spare is
//! lent to), RMA numbers, custom-field values on anything but a spare, who wrote
//! a plan or ran an issue, a plan step's stored edit, and every security, NAT,
//! IKE and IPsec kind. A tombstoned element is not shown.
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
    FieldValueField, FixedToField, InterfaceField, IssueField, IssueStepField, LabelField,
    LineEndField, LineField, LinkField, LogicalUnitField, MaintenancePlanField, MountedInField,
    NodeKind, NoteField, OccupiesField, PassiveNodeField, PhysicalPortField, PlanStepField,
    PowerSupplyField, PremisesField, PublishedPortField, RackField, SiteField, SitsOnField,
    StockItemField, StockLevelField, StoreField, SurfaceField, TagField, TerminatesField,
    VlanField, VlanMemberField,
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
    // Spares on hand (ADR-0076). Never the serial, the RMA number or who it is lent to.
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Store,
        fields: fields!(StoreField: Name),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::StockItem,
        fields: fields!(StockItemField: Part, Model, Name, Count, State, Bin, Optic, Due, CameFrom),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::StockLevel,
        fields: fields!(StockLevelField: Model, AtLeast),
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
    // ---- layout: maintenance plans and "It's down" issues (ADR-0061) ----
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::MaintenancePlan,
        fields: fields!(MaintenancePlanField: Title, WindowStart, WindowEnd, Stage, Outcome),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::PlanStep,
        fields: fields!(PlanStepField: Ordinal, Kind, Targets, Change, State, DoneAt),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::Issue,
        fields: fields!(IssueField: Title, Device, OpenedAt, Stage, Plan),
    },
    NodeRow {
        tier: Tier::Layout,
        kind: NodeKind::IssueStep,
        fields: fields!(IssueStepField: Ordinal, Topic, Question, Targets, Answer, AnsweredAt),
    },
    // ---- notes ----
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::Store,
        fields: fields!(StoreField: Place, Note),
    },
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::StockItem,
        fields: fields!(StockItemField: Note),
    },
    // Only a spare's custom-field values: [`reading`] drops any other owner's.
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::FieldValue,
        fields: fields!(FieldValueField: Definition, Value),
    },
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::MaintenancePlan,
        fields: fields!(MaintenancePlanField: Record),
    },
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::PlanStep,
        fields: fields!(PlanStepField: Before, After, Note),
    },
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::Issue,
        fields: fields!(IssueField: Outcome),
    },
    NodeRow {
        tier: Tier::Notes,
        kind: NodeKind::IssueStep,
        fields: fields!(IssueStepField: Detail, Note),
    },
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
    // ---- layout: a plan's and an issue's steps ----
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasStep,
        fields: NO_FIELDS,
    },
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::HasIssueStep,
        fields: NO_FIELDS,
    },
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
    EdgeRow {
        tier: Tier::Layout,
        kind: EdgeKind::InStore,
        fields: NO_FIELDS,
    },
    // ---- notes ----
    EdgeRow {
        tier: Tier::Notes,
        kind: EdgeKind::HasFieldValue,
        fields: NO_FIELDS,
    },
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

/// The tiers an AI change may set fields at (ADR-0077, build step 2): the key's own, cut to
/// `layout` and `notes`. Addresses wait until the sweep has looked at what a changed address
/// can break.
fn settable_tiers(tiers: &BTreeSet<Tier>) -> BTreeSet<Tier> {
    let mut out: BTreeSet<Tier> = tiers
        .iter()
        .copied()
        .filter(|t| matches!(t, Tier::Layout | Tier::Notes))
        .collect();
    out.insert(Tier::Layout);
    out
}

/// Whether the reading at `tiers` shows nodes of `kind` at all.
pub fn shows_node_kind(tiers: &BTreeSet<Tier>, kind: NodeKind) -> bool {
    let mut tiers = tiers.clone();
    tiers.insert(Tier::Layout);
    allowed_nodes(&tiers).contains_key(&kind)
}

/// The field named `name` on a node of `kind`, when an AI change may set it: it is on this
/// allowlist at a tier the key sees (ADR-0077 decision 4). `None` for anything else, so a
/// field nobody listed here cannot be written by an AI any more than it can be read.
pub fn settable_node_field(tiers: &BTreeSet<Tier>, kind: NodeKind, name: &str) -> Option<FieldKey> {
    allowed_nodes(&settable_tiers(tiers))
        .get(&kind)?
        .iter()
        .find(|(_, n)| **n == name)
        .map(|(k, _)| *k)
}

/// Whether an AI change may add a node of `kind`: the reading shows it at a tier changes
/// reach (ADR-0077 decision 4).
pub fn settable_node_kind(tiers: &BTreeSet<Tier>, kind: NodeKind) -> bool {
    allowed_nodes(&settable_tiers(tiers)).contains_key(&kind)
}

/// Whether an AI change may add an edge of `kind`.
pub fn settable_edge_kind(tiers: &BTreeSet<Tier>, kind: EdgeKind) -> bool {
    allowed_edges(&settable_tiers(tiers)).contains_key(&kind)
}

/// Whether the reading at `tiers` shows edges of `kind` at all.
pub fn shows_edge_kind(tiers: &BTreeSet<Tier>, kind: EdgeKind) -> bool {
    let mut tiers = tiers.clone();
    tiers.insert(Tier::Layout);
    allowed_edges(&tiers).contains_key(&kind)
}

/// What an AI change may add and set at `tiers`, for the reading to hand an AI that may
/// change designs: each node kind with its settable fields, and each edge kind with the
/// node kinds at its ends that the reading shows, and its settable fields.
pub fn change_vocabulary(tiers: &BTreeSet<Tier>) -> Json {
    let settable = settable_tiers(tiers);
    let names = |fields: &BTreeMap<FieldKey, &'static str>| {
        let mut n: Vec<&str> = fields.values().copied().collect();
        n.sort_unstable();
        Json::Arr(n.into_iter().map(|f| Json::Str(f.to_string())).collect())
    };
    let nodes = allowed_nodes(&settable);
    let ends = |kinds: &[NodeKind]| {
        Json::Arr(
            kinds
                .iter()
                .filter(|k| nodes.contains_key(k))
                .map(|k| Json::Str(k.name().to_string()))
                .collect(),
        )
    };
    let mut edges = BTreeMap::new();
    for (kind, fields) in allowed_edges(&settable) {
        let mut m = BTreeMap::new();
        m.insert("from".to_string(), ends(kind.from_kinds()));
        m.insert("to".to_string(), ends(kind.to_kinds()));
        m.insert("fields".to_string(), names(&fields));
        edges.insert(kind.name().to_string(), Json::Obj(m));
    }
    let mut out = BTreeMap::new();
    out.insert(
        "nodes".to_string(),
        Json::Obj(
            nodes
                .iter()
                .map(|(k, f)| (k.name().to_string(), names(f)))
                .collect(),
        ),
    );
    out.insert("edges".to_string(), Json::Obj(edges));
    Json::Obj(out)
}

/// [`settable_node_field`] for an edge.
pub fn settable_edge_field(tiers: &BTreeSet<Tier>, kind: EdgeKind, name: &str) -> Option<FieldKey> {
    allowed_edges(&settable_tiers(tiers))
        .get(&kind)?
        .iter()
        .find(|(_, n)| **n == name)
        .map(|(k, _)| *k)
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

    // A custom-field value leaves only when it is on a spare (a price, a supplier).
    let spare_values: BTreeSet<String> = snap
        .edges
        .iter()
        .filter(|e| {
            e.absent_since.is_none()
                && e.id.kind == EdgeKind::HasFieldValue
                && e.from.kind == NodeKind::StockItem
        })
        .map(|e| e.to.to_string())
        .collect();

    let mut withheld = 0usize;
    let mut shown = BTreeSet::new();
    let mut nodes = Vec::new();
    for node in &snap.nodes {
        if node.absent_since.is_some() {
            continue;
        }
        if node.id.kind == NodeKind::FieldValue && !spare_values.contains(&node.id.to_string()) {
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
                if field.key == PhysicalPortField::Transceiver.key()
                    || field.key == StockItemField::Optic.key()
                {
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
    fn no_serial_street_coordinate_contact_author_or_stored_edit_field_is_listed() {
        let banned = [
            ChassisField::Serial.key(),
            PassiveNodeField::Serial.key(),
            PowerSupplyField::Serial.key(),
            CardField::Serial.key(),
            PremisesField::Street.key(),
            PremisesField::Coordinates.key(),
            ExternalPeerField::Contact.key(),
            ExternalPeerField::Address.key(),
            StockItemField::Serial.key(),
            StockItemField::Rma.key(),
            StockItemField::LentTo.key(),
            MaintenancePlanField::Author.key(),
            IssueField::Author.key(),
            PlanStepField::Edit.key(),
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

    /// ADR-0076: a spare reaches an AI by sort, model and state, never by serial; its price
    /// (a custom-field value) only at the notes tier, and no other owner's custom field at all.
    #[test]
    fn a_spare_shows_without_its_serial_and_its_price_only_at_notes() {
        use fathom_graph::BatchId;
        use fathom_ir::generated::ir_types::{DeviceField, StockItemPart, StockItemState};
        use fathom_ir::{scalar, value};
        let mut g = Graph::new();
        g.begin_batch(BatchId(fathom_id::Ulid(80)), "ai_reading spares")
            .expect("open batch");
        let spare = g
            .insert_node(NodeKind::StockItem, fathom_id::Ulid(81), prov(8))
            .expect("spare");
        g.set_field(
            spare.into(),
            StockItemField::Part.key(),
            StockItemPart::from_token("optic"),
            prov(8),
        )
        .expect("part");
        g.set_field(
            spare.into(),
            StockItemField::State.key(),
            StockItemState::from_token("spare"),
            prov(8),
        )
        .expect("state");
        g.set_field(
            spare.into(),
            StockItemField::Model.key(),
            scalar::Identifier("SFP-10G-SR".into()),
            prov(8),
        )
        .expect("model");
        g.set_field(
            spare.into(),
            StockItemField::Serial.key(),
            scalar::Identifier("AVP19230XYZ".into()),
            prov(8),
        )
        .expect("serial");
        g.set_field(
            spare.into(),
            StockItemField::Optic.key(),
            value::Transceiver {
                r#type: Some(scalar::Text("10GBASE-SR".into())),
                serial: Some(scalar::Identifier("AVP19230XYZ".into())),
                ..Default::default()
            },
            prov(8),
        )
        .expect("optic");
        g.set_field(
            spare.into(),
            StockItemField::LentTo.key(),
            scalar::Text("Sam Field".into()),
            prov(8),
        )
        .expect("lent to");
        let price = g
            .insert_node(NodeKind::FieldValue, fathom_id::Ulid(82), prov(8))
            .expect("price");
        g.set_field(
            price.into(),
            FieldValueField::Definition.key(),
            scalar::Text("01JPRICE0000000000000000AA".into()),
            prov(8),
        )
        .expect("definition");
        g.set_field(
            price.into(),
            FieldValueField::Value.key(),
            scalar::Text("41.50".into()),
            prov(8),
        )
        .expect("value");
        g.insert_edge(
            EdgeKind::HasFieldValue,
            fathom_id::Ulid(83),
            spare,
            price,
            prov(8),
        )
        .expect("has price");
        let device = g
            .insert_node(NodeKind::Device, fathom_id::Ulid(84), prov(8))
            .expect("device");
        g.set_field(
            device.into(),
            DeviceField::Hostname.key(),
            scalar::Identifier("core-sw1".into()),
            prov(8),
        )
        .expect("hostname");
        let budget = g
            .insert_node(NodeKind::FieldValue, fathom_id::Ulid(85), prov(8))
            .expect("budget");
        g.set_field(
            budget.into(),
            FieldValueField::Definition.key(),
            scalar::Text("01JBUDGET000000000000000AA".into()),
            prov(8),
        )
        .expect("definition");
        g.set_field(
            budget.into(),
            FieldValueField::Value.key(),
            scalar::Text("cost-centre-77".into()),
            prov(8),
        )
        .expect("value");
        g.insert_edge(
            EdgeKind::HasFieldValue,
            fathom_id::Ulid(86),
            device,
            budget,
            prov(8),
        )
        .expect("has budget");
        g.end_batch().expect("close batch");

        let text = |tiers: &[Tier]| {
            let tiers: BTreeSet<Tier> = tiers.iter().copied().collect();
            String::from_utf8(
                reading(&g, &tiers)
                    .expect("a reading")
                    .document
                    .to_canonical_bytes(),
            )
            .unwrap()
        };
        let layout = text(&[Tier::Layout]);
        assert!(
            layout.contains("SFP-10G-SR") && layout.contains("10GBASE-SR"),
            "{layout}"
        );
        assert!(!layout.contains("AVP19230XYZ"), "{layout}");
        assert!(!layout.contains("Sam Field"), "{layout}");
        assert!(!layout.contains("41.50"), "{layout}");
        let notes = text(&[Tier::Layout, Tier::Notes]);
        assert!(notes.contains("41.50"), "{notes}");
        assert!(!notes.contains("AVP19230XYZ"), "{notes}");
        assert!(!notes.contains("cost-centre-77"), "{notes}");
    }

    /// A plan and its steps are read at `layout`; what a step says before and after only at
    /// `notes`; who wrote it and the stored edit never.
    #[test]
    fn a_plan_is_read_without_its_author_or_stored_edit() {
        use fathom_graph::BatchId;
        use fathom_ir::scalar;
        let mut g = Graph::new();
        g.begin_batch(BatchId(fathom_id::Ulid(80)), "ai_reading plan fixture")
            .expect("open batch");
        let plan = g
            .insert_node(NodeKind::MaintenancePlan, fathom_id::Ulid(81), prov(8))
            .expect("plan");
        for (key, text) in [
            (MaintenancePlanField::Title.key(), "Move uplinks to sw2"),
            (MaintenancePlanField::Author.key(), "Dana Writer"),
        ] {
            g.set_field(plan.into(), key, scalar::Text(text.into()), prov(8))
                .expect("plan field");
        }
        let step = g
            .insert_node(NodeKind::PlanStep, fathom_id::Ulid(82), prov(8))
            .expect("step");
        for (key, text) in [
            (PlanStepField::Change.key(), "Recable port 1"),
            (PlanStepField::Before.key(), "On sw1 port 1"),
            (PlanStepField::Edit.key(), "cable\tstored-edit-line"),
        ] {
            g.set_field(step.into(), key, scalar::Text(text.into()), prov(8))
                .expect("step field");
        }
        g.insert_edge(EdgeKind::HasStep, fathom_id::Ulid(83), plan, step, prov(8))
            .expect("has step");
        g.end_batch().expect("close batch");

        let layout: BTreeSet<Tier> = [Tier::Layout].into_iter().collect();
        let text =
            String::from_utf8(reading(&g, &layout).unwrap().document.to_canonical_bytes()).unwrap();
        assert!(text.contains("Move uplinks to sw2"), "{text}");
        assert!(text.contains("Recable port 1"), "{text}");
        assert!(text.contains("HasStep"), "{text}");
        assert!(!text.contains("On sw1 port 1"), "{text}");
        assert!(!text.contains("Dana Writer"), "{text}");
        assert!(!text.contains("stored-edit-line"), "{text}");

        let notes: BTreeSet<Tier> = [Tier::Notes].into_iter().collect();
        let text =
            String::from_utf8(reading(&g, &notes).unwrap().document.to_canonical_bytes()).unwrap();
        assert!(text.contains("On sw1 port 1"), "{text}");
        assert!(!text.contains("Dana Writer"), "{text}");
        assert!(!text.contains("stored-edit-line"), "{text}");
    }
}
