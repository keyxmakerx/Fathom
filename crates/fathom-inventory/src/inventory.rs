//! The row set — a kind plus a filter (`52` §3.7). Slice one carries the
//! kind and no filter, and the rows come back in `NodeId` order, which is a
//! pure function of content (invariant 9), not of insertion.
//!
//! Every join, walk and count happens here. The JS in the artifact renders
//! the strings this module returns and computes nothing (WO-08 §4.2).

use fathom_graph::{Graph, NodeId};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

use crate::equipment;
use crate::render::{key, value_cell, UNKNOWN};

/// The slice-one kind strip. Service and Tenant join with the service-layer
/// work order; Cable rows are WO-08 §8 item 6.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvKind {
    Device,
    PhysicalPort,
    Premises,
    // Added 2026-08-10. The first three are the estate a *hand-built* workspace
    // has; these six are what a **pasted config** actually produces, and until
    // now not one of them had a row to appear in — so an operator who pasted a
    // working VPN saw a single device and no way to reach the zones, the
    // gateway or the tunnel Fathom had correctly understood.
    //
    // Order is the order an engineer builds a tunnel in — interface, zone, then
    // outward through IKE to IPsec — not schema declaration order, because this
    // is a strip of buttons a human reads left to right.
    Interface,
    TunnelInterface,
    Zone,
    IkeGateway,
    IpsecVpn,
    IkeProposal,
    IpsecProposal,
    // Added 2026-08-11 at the owner's request: OSPF and BGP. Both kinds have
    // been in `schema/` since the beginning and neither had a row, so a routing
    // protocol Fathom understood had nowhere to appear. Nothing produces them
    // yet -- no dictionary entry is under `protocols` -- so these two are empty
    // today by construction, and that is the point: the parser work lands into a
    // face that already exists rather than into one nobody remembers to add.
    RoutingProtocol,
    ProtocolAdjacency,
    // Added 2026-08-11 with hand authoring. A `Chassis` is where `model` and
    // `serial` live -- a chassis cluster is one Device with two boxes -- so
    // without this row the equipment form could STORE a model and no view could
    // SHOW it. APPENDED, never inserted: the wire byte OP_INV_ROWS takes is this
    // array's index, so inserting would silently repoint every existing byte.
    Chassis,
}

impl InvKind {
    pub fn label(self) -> &'static str {
        match self {
            InvKind::Device => "Device",
            InvKind::PhysicalPort => "PhysicalPort",
            InvKind::Premises => "Premises",
            InvKind::Interface => "Interface",
            InvKind::TunnelInterface => "TunnelInterface",
            InvKind::Zone => "Zone",
            InvKind::IkeGateway => "IkeGateway",
            InvKind::IpsecVpn => "IpsecVpn",
            InvKind::IkeProposal => "IkeProposal",
            InvKind::IpsecProposal => "IpsecProposal",
            InvKind::RoutingProtocol => "RoutingProtocol",
            InvKind::ProtocolAdjacency => "ProtocolAdjacency",
            InvKind::Chassis => "Chassis",
        }
    }

    pub const ALL: [InvKind; 13] = [
        InvKind::Device,
        InvKind::PhysicalPort,
        InvKind::Premises,
        InvKind::Interface,
        InvKind::TunnelInterface,
        InvKind::Zone,
        InvKind::IkeGateway,
        InvKind::IpsecVpn,
        InvKind::IkeProposal,
        InvKind::IpsecProposal,
        InvKind::RoutingProtocol,
        InvKind::ProtocolAdjacency,
        InvKind::Chassis,
    ];

    fn node_kind(self) -> NodeKind {
        match self {
            InvKind::Device => NodeKind::Device,
            InvKind::PhysicalPort => NodeKind::PhysicalPort,
            InvKind::Premises => NodeKind::Premises,
            InvKind::Interface => NodeKind::Interface,
            InvKind::TunnelInterface => NodeKind::TunnelInterface,
            InvKind::Zone => NodeKind::Zone,
            InvKind::IkeGateway => NodeKind::IkeGateway,
            InvKind::IpsecVpn => NodeKind::IpsecVpn,
            InvKind::IkeProposal => NodeKind::IkeProposal,
            InvKind::IpsecProposal => NodeKind::IpsecProposal,
            InvKind::RoutingProtocol => NodeKind::RoutingProtocol,
            InvKind::ProtocolAdjacency => NodeKind::ProtocolAdjacency,
            InvKind::Chassis => NodeKind::Chassis,
        }
    }
}

/// One inventory row. `id` is the element's full display id
/// (`<kind-lower>:<ulid>`, ADR-0005) — rows reference IDs, never names
/// (invariant 7). `opinions` is "—" in this build: no rule engine exists,
/// and the column is structural (52 §3.7.1), so it renders empty rather
/// than being dropped.
pub struct Row {
    pub id: String,
    pub cells: Vec<String>,
    pub opinions: &'static str,
}

/// The opinions cell in a build with no rule engine. The column stays.
const NO_OPINION: &str = "—";

const DEVICE_COLUMNS: &[&str] = &[
    "hostname",
    "platform",
    "os_version",
    "role",
    "premises",
    "name_conformance",
];
const PORT_COLUMNS: &[&str] = &[
    "label",
    "owner",
    "connector",
    "service",
    "speed_max",
    "cables to",
];
const PREMISES_COLUMNS: &[&str] = &["label", "clli", "form", "street", "devices"];
/// Every one a field `schema/schema.yaml` declares on `Chassis`, plus the
/// owning device, which is the traversal that makes the row locatable.
const CHASSIS_COLUMNS: &[&str] = &["model", "serial", "member_index", "slots", "device"];
/// OSPF and BGP, `56` §4.8. `protocol` first because it is what tells the two
/// apart, then the one identifying number each uses -- `local_as` for BGP,
/// `router_id` for OSPF -- so one table serves both without a per-protocol view.
const ROUTING_PROTOCOL_COLUMNS: &[&str] = &[
    "protocol",
    "router_id",
    "local_as",
    "reference_bandwidth",
    "device",
];
/// One neighbour. `peer_address` and `peer_as` are the BGP half, `area` and
/// `cost` the OSPF half; a row fills whichever its protocol uses and leaves the
/// other empty, which is `56` §4.8's table made legible in one place.
const PROTOCOL_ADJACENCY_COLUMNS: &[&str] = &[
    "peer_address",
    "peer_as",
    "area",
    "cost",
    "network_type",
    "device",
];

// The six pasted-config kinds. Every column below is a field `schema/schema.yaml`
// declares on that kind — no column is computed here except the named traversals
// at the foot of this file, which is `52` §3.7's rule: a row set is a kind plus a
// filter, and a cell is a field or a stated walk.
const INTERFACE_COLUMNS: &[&str] = &["name", "device", "description", "units"];
// `st0` on an SRX. Its own row set rather than a row in `Interface`, because a
// row set is a kind plus a filter (`52` §3.7) and these are different kinds --
// and because for the job this product does first, the tunnel interface is the
// one an engineer looks for.
const TUNNEL_COLUMNS: &[&str] = &["name", "device", "technology", "description", "units"];
const ZONE_COLUMNS: &[&str] = &["name", "device", "interfaces"];
const IKE_GATEWAY_COLUMNS: &[&str] = &["name", "device", "peer", "version", "external interface"];
const IPSEC_VPN_COLUMNS: &[&str] = &["name", "device", "mode", "bound to", "establish"];
const IKE_PROPOSAL_COLUMNS: &[&str] = &[
    "name",
    "device",
    "authentication",
    "dh group",
    "encryption",
    "integrity",
];
const IPSEC_PROPOSAL_COLUMNS: &[&str] = &["name", "device", "protocol", "encryption", "integrity"];

pub fn columns(kind: InvKind) -> &'static [&'static str] {
    match kind {
        InvKind::Device => DEVICE_COLUMNS,
        InvKind::PhysicalPort => PORT_COLUMNS,
        InvKind::Premises => PREMISES_COLUMNS,
        InvKind::Interface => INTERFACE_COLUMNS,
        InvKind::TunnelInterface => TUNNEL_COLUMNS,
        InvKind::Zone => ZONE_COLUMNS,
        InvKind::IkeGateway => IKE_GATEWAY_COLUMNS,
        InvKind::IpsecVpn => IPSEC_VPN_COLUMNS,
        InvKind::IkeProposal => IKE_PROPOSAL_COLUMNS,
        InvKind::IpsecProposal => IPSEC_PROPOSAL_COLUMNS,
        InvKind::RoutingProtocol => ROUTING_PROTOCOL_COLUMNS,
        InvKind::ProtocolAdjacency => PROTOCOL_ADJACENCY_COLUMNS,
        InvKind::Chassis => CHASSIS_COLUMNS,
    }
}

pub fn rows(g: &Graph, kind: InvKind) -> Vec<Row> {
    g.nodes_of_kind(kind.node_kind())
        // Tombstoned nodes are NOT rows. `nodes_of_kind` yields every node the
        // store has ever held, because the store never hard-deletes -- an
        // element removed is marked absent from a moment and kept, which is what
        // makes an estate a record rather than a snapshot.
        //
        // The inventory is a view of what is true NOW, so it must filter. Until
        // 2026-08-11 nothing removed anything, so nothing here noticed; the
        // first removal opcode made a removed device go on listing itself, which
        // is the worst kind of wrong for a tool whose claim is that you can
        // trust what it shows. Provenance and history are how you ask what USED
        // to be true, and both still hold the node.
        .filter(|n| n.absent_since.is_none())
        .map(|n| Row {
            id: n.id.to_string(),
            cells: cells(g, kind, n.id),
            opinions: NO_OPINION,
        })
        .collect()
}

fn cells(g: &Graph, kind: InvKind, id: NodeId) -> Vec<String> {
    match kind {
        InvKind::Device => vec![
            value_cell(g, id, key("Device.hostname")),
            value_cell(g, id, key("Device.platform")),
            value_cell(g, id, key("Device.os_version")),
            value_cell(g, id, key("Device.role")),
            device_premises(g, id),
            value_cell(g, id, key("Device.name_conformance")),
        ],
        InvKind::PhysicalPort => vec![
            value_cell(g, id, key("PhysicalPort.label")),
            equipment::port_device_hostname(g, id).unwrap_or_else(|| UNKNOWN.to_owned()),
            value_cell(g, id, key("PhysicalPort.connector")),
            value_cell(g, id, key("PhysicalPort.service")),
            value_cell(g, id, key("PhysicalPort.speed_max")),
            match equipment::cabled_peer(g, id) {
                Some(p) => p.text,
                None => UNKNOWN.to_owned(),
            },
        ],
        InvKind::Premises => vec![
            value_cell(g, id, key("Premises.label")),
            value_cell(g, id, key("Premises.clli")),
            value_cell(g, id, key("Premises.form")),
            value_cell(g, id, key("Premises.street")),
            premises_device_count(g, id).to_string(),
        ],
        InvKind::Interface => vec![
            value_cell(g, id, key("Interface.name")),
            owning_device(g, id),
            value_cell(g, id, key("Interface.description")),
            unit_names(g, id),
        ],
        InvKind::TunnelInterface => vec![
            value_cell(g, id, key("TunnelInterface.name")),
            owning_device(g, id),
            value_cell(g, id, key("TunnelInterface.technology")),
            value_cell(g, id, key("TunnelInterface.description")),
            unit_names(g, id),
        ],
        InvKind::Zone => vec![
            value_cell(g, id, key("Zone.name")),
            owning_device(g, id),
            edge_targets(g, id, EdgeKind::ZoneMember),
        ],
        InvKind::IkeGateway => vec![
            value_cell(g, id, key("IkeGateway.name")),
            owning_device(g, id),
            value_cell(g, id, key("IkeGateway.peer")),
            value_cell(g, id, key("IkeGateway.version")),
            edge_targets(g, id, EdgeKind::ExternalInterface),
        ],
        InvKind::IpsecVpn => vec![
            value_cell(g, id, key("IpsecVpn.name")),
            owning_device(g, id),
            value_cell(g, id, key("IpsecVpn.mode")),
            edge_targets(g, id, EdgeKind::BindsInterface),
            value_cell(g, id, key("IpsecVpn.establish_tunnels")),
        ],
        InvKind::IkeProposal => vec![
            value_cell(g, id, key("IkeProposal.name")),
            owning_device(g, id),
            value_cell(g, id, key("IkeProposal.authentication_method")),
            value_cell(g, id, key("IkeProposal.dh_group")),
            value_cell(g, id, key("IkeProposal.encryption_algorithm")),
            value_cell(g, id, key("IkeProposal.authentication_algorithm")),
        ],
        InvKind::IpsecProposal => vec![
            value_cell(g, id, key("IpsecProposal.name")),
            owning_device(g, id),
            value_cell(g, id, key("IpsecProposal.protocol")),
            value_cell(g, id, key("IpsecProposal.encryption_algorithm")),
            value_cell(g, id, key("IpsecProposal.authentication_algorithm")),
        ],
        InvKind::RoutingProtocol => vec![
            value_cell(g, id, key("RoutingProtocol.protocol")),
            routing_protocol_router_id(g, id),
            value_cell(g, id, key("RoutingProtocol.local_as")),
            value_cell(g, id, key("RoutingProtocol.reference_bandwidth")),
            owning_device(g, id),
        ],
        InvKind::ProtocolAdjacency => vec![
            value_cell(g, id, key("ProtocolAdjacency.peer_address")),
            value_cell(g, id, key("ProtocolAdjacency.peer_as")),
            value_cell(g, id, key("ProtocolAdjacency.area")),
            value_cell(g, id, key("ProtocolAdjacency.cost")),
            value_cell(g, id, key("ProtocolAdjacency.network_type")),
            owning_device(g, id),
        ],
        InvKind::Chassis => vec![
            value_cell(g, id, key("Chassis.model")),
            value_cell(g, id, key("Chassis.serial")),
            value_cell(g, id, key("Chassis.member_index")),
            value_cell(g, id, key("Chassis.slots")),
            owning_device(g, id),
        ],
    }
}

/// The router id for a `RoutingProtocol` row: its own field where something
/// set it, otherwise the owning `RoutingInstance`'s.
///
/// This is `52` §3.7's "a cell is a field or a stated walk", and the walk is
/// stated here. `schema/schema.yaml` declares `router_id` on both kinds, and
/// on Junos only one of them is reachable: there is no `set protocols ospf
/// router-id` and no `set protocols bgp router-id` — the statement is `set
/// routing-options router-id`, which is the routing instance, and Juniper's own
/// description of it says it is used by BGP and OSPF alike (read 2026-08-15,
/// https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/statement/router-id-edit-routing-options.html).
///
/// Without this walk the column would be empty on every Junos paste forever,
/// which is the failure mode the `UNRENDERED` marker in `render.rs` was added
/// to stop: a real, present, provenanced value that reads on screen exactly
/// like a field nobody filled in. The rejected alternative was to bind
/// `routing-options router-id` onto `RoutingProtocol.router_id` in the
/// dictionary — that puts an instance-wide fact on a protocol and, worse,
/// would have to mint a `RoutingProtocol` without knowing its card-1
/// `protocol`. Storing it correctly and reading it here is the honest split.
///
/// The protocol's own field still wins where a platform does set it, so this
/// is a fallback and not an override.
fn routing_protocol_router_id(g: &Graph, id: NodeId) -> String {
    let own = value_cell(g, id, key("RoutingProtocol.router_id"));
    if !own.is_empty() && own != UNKNOWN {
        return own;
    }
    match g.owner(id) {
        Some(owner) if owner.kind == NodeKind::RoutingInstance => {
            value_cell(g, owner, key("RoutingInstance.router_id"))
        }
        _ => own,
    }
}

/// The hostname of the `Device` that contains this node, found by walking
/// containment upward rather than by assuming a depth: a `Zone` is owned by a
/// `Device` directly, an `Interface` likewise, but nothing here should encode
/// that — the schema decides, and the schema changes.
///
/// Bounded: `11` §7.2's containment is a forest, so the walk terminates, and the
/// bound is stated rather than trusted.
fn owning_device(g: &Graph, id: NodeId) -> String {
    let mut at = id;
    for _ in 0..16 {
        match g.owner(at) {
            Some(owner) if owner.kind == NodeKind::Device => {
                return value_cell(g, owner, key("Device.hostname"))
            }
            Some(owner) => at = owner,
            None => break,
        }
    }
    UNKNOWN.to_owned()
}

/// The display names of everything this node points at over one edge kind,
/// comma-separated, in edge order. `—` when there are none, which is a real
/// answer: a zone with no interfaces is a zone somebody has not finished.
fn edge_targets(g: &Graph, id: NodeId, kind: EdgeKind) -> String {
    let names: Vec<String> = g
        .out(id, kind)
        .map(|e| crate::element::display_name(g, e.to))
        .collect();
    if names.is_empty() {
        UNKNOWN.to_owned()
    } else {
        names.join(", ")
    }
}

/// An interface's units, by the name an engineer would say — `ge-0/0/0.0`, not
/// `0`. `display_name` already renders a `LogicalUnit` joined to its owner
/// (`11` §4.6: rendered, never stored joined), so this reuses it rather than
/// re-deriving the join here and risking a second, different answer.
fn unit_names(g: &Graph, id: NodeId) -> String {
    edge_targets(g, id, EdgeKind::HasUnit)
}

/// Traversal: `owner` Site -> `AtPremises` -> Premises `label`. `—` when the
/// walk fails — a device with no site, or a site at no premises.
fn device_premises(g: &Graph, device: NodeId) -> String {
    let Some(site) = g.owner(device) else {
        return UNKNOWN.to_owned();
    };
    match g.out(site, EdgeKind::AtPremises).next() {
        Some(e) => value_cell(g, e.to, key("Premises.label")),
        None => UNKNOWN.to_owned(),
    }
}

/// Traversal: over `AtPremises` in-edges, the sum of each Site's `HasDevice`
/// out-degree. *"'several units at this address' becomes a count of in-edges,
/// not a population scan"* (`schema/schema.yaml`, `AtPremises`).
fn premises_device_count(g: &Graph, premises: NodeId) -> usize {
    g.inn(premises, EdgeKind::AtPremises)
        .map(|e| g.out(e.from, EdgeKind::HasDevice).count())
        .sum()
}
