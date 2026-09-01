//! The row set — a kind plus a filter (`52` §3.7). Slice one carries the
//! kind and no filter, and the rows come back in `NodeId` order, which is a
//! pure function of content (invariant 9), not of insertion.
//!
//! Every join, walk and count happens here. The JS in the artifact renders
//! the strings this module returns and computes nothing (WO-08 §4.2).

use fathom_graph::{Graph, NodeId};
use fathom_ir::bag::FieldKey;
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
    // Added 2026-08-15 with ADR-0036's physical placement. A rack IS inventory
    // -- a thing the estate holds, with a label and a capacity -- so it gets a
    // row here rather than a bespoke opcode of its own. That choice also pays:
    // reusing `rows()` costs four lines, where a dedicated list opcode cost a
    // handler, a Vec<Row> built by hand and its own reply.
    Rack,
    // Added 2026-08-15 with the OPNsense rules CSV. APPENDED, never inserted,
    // for the reason `Chassis` states above: the wire byte `OP_INV_ROWS` takes
    // is this array's index.
    //
    // A firewall rule is the first thing the owner asked for by name that is
    // not a Junos statement, and until now `SecurityPolicy` had no row — so a
    // ruleset Fathom parsed correctly had nowhere to appear.
    SecurityPolicy,
    // Appended 2026-08-29 with WO-10. A relay's server address is a thing the
    // estate holds and a person will look for by kind; APPENDED for the reason
    // `Chassis` states above.
    DhcpRelay,
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
            InvKind::Rack => "Rack",
            InvKind::SecurityPolicy => "SecurityPolicy",
            InvKind::DhcpRelay => "DhcpRelay",
        }
    }

    pub const ALL: [InvKind; 16] = [
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
        InvKind::Rack,
        InvKind::SecurityPolicy,
        InvKind::DhcpRelay,
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
            InvKind::Rack => NodeKind::Rack,
            InvKind::SecurityPolicy => NodeKind::SecurityPolicy,
            InvKind::DhcpRelay => NodeKind::DhcpRelay,
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

/// What one column of a row set IS — and it is this, not the column's name,
/// that decides whether the cell can be typed into.
///
/// `52` §3.7: the inventory "lets you change **field values, in place, in the
/// cell**". A cell that is a traversal, a join or a count is not a field of the
/// row's own node, so a typed value has nowhere to go — the walk that computed
/// it is not invertible. `routing_protocol_router_id` says the same thing at
/// the bottom of this file and has said it since 2026-08-15: *"an editable cell
/// that is not the row's own field has nowhere to write."*
///
/// The two arms are declared HERE, beside the column's name, rather than in a
/// second list the page or the protocol keeps in step by memory. That is the
/// whole reason this table replaced the two parallel arrays it grew out of: a
/// name array and a positional `match` can disagree about which field column
/// four is, and the disagreement is invisible until somebody's serial number
/// lands in somebody's model.
enum Cell {
    /// The row's own stored field, by the schema path [`key`] takes. Editable
    /// exactly when `crate::is_authorable` says the type can be parsed from
    /// text (`author.rs`).
    Field(&'static str),
    /// Computed from the graph by the walk named. Never editable, at any point
    /// in the future, for the reason above: there is no field behind it.
    Walk(Walk),
}

/// The joins, counts and traversals a row set renders. Each arm is one function
/// at the foot of this file; naming them in the table is what lets the table be
/// the single declaration of a column.
enum Walk {
    /// Device -> Site -> Premises `label`.
    DevicePremises,
    /// PhysicalPort -> its Device's `hostname`.
    PortDevice,
    /// PhysicalPort -> the far end of its cable, rendered.
    CabledPeer,
    /// Premises -> how many devices are at it.
    PremisesDevices,
    /// Anything -> the `hostname` of the Device that contains it.
    OwningDevice,
    /// Interface -> its units, by the name an engineer would say.
    UnitNames,
    /// Everything this node points at over one edge kind, comma-separated.
    Targets(EdgeKind),
    /// RoutingProtocol -> its own `router_id`, else its instance's.
    RouterId,
    /// Rack -> how many chassis are mounted in it.
    Mounted,
}

/// One column: what it is called, and what it is.
struct Col {
    name: &'static str,
    cell: Cell,
}

/// A column that is the row's own field. `name` is written out rather than
/// derived from the path because several columns are deliberately NOT the bare
/// field name — `authentication` for `authentication_method`, `dh group` for
/// `dh_group` — and a table that derived them would rename four columns.
const fn f(name: &'static str, path: &'static str) -> Col {
    Col {
        name,
        cell: Cell::Field(path),
    }
}

/// A column that is a walk.
const fn w(name: &'static str, walk: Walk) -> Col {
    Col {
        name,
        cell: Cell::Walk(walk),
    }
}

const DEVICE_COLUMNS: &[Col] = &[
    f("hostname", "Device.hostname"),
    f("platform", "Device.platform"),
    f("os_version", "Device.os_version"),
    f("role", "Device.role"),
    w("premises", Walk::DevicePremises),
    f("name_conformance", "Device.name_conformance"),
];
const PORT_COLUMNS: &[Col] = &[
    f("label", "PhysicalPort.label"),
    w("owner", Walk::PortDevice),
    f("connector", "PhysicalPort.connector"),
    f("service", "PhysicalPort.service"),
    f("speed_max", "PhysicalPort.speed_max"),
    w("cables to", Walk::CabledPeer),
];
const PREMISES_COLUMNS: &[Col] = &[
    f("label", "Premises.label"),
    f("clli", "Premises.clli"),
    f("form", "Premises.form"),
    f("street", "Premises.street"),
    w("devices", Walk::PremisesDevices),
];
/// Every one a field `schema/schema.yaml` declares on `Chassis`, plus the
/// owning device, which is the traversal that makes the row locatable.
const CHASSIS_COLUMNS: &[Col] = &[
    f("model", "Chassis.model"),
    f("serial", "Chassis.serial"),
    f("member_index", "Chassis.member_index"),
    f("slots", "Chassis.slots"),
    w("device", Walk::OwningDevice),
];
// `numbering` is a column rather than a footnote because ADR-0036 makes it
// required with no default: a reader who cannot see which end is U1 cannot
// check the elevation against the frame in front of them.
const RACK_COLUMNS: &[Col] = &[
    f("label", "Rack.label"),
    f("height_u", "Rack.height_u"),
    f("numbering", "Rack.unit_numbering"),
    // How many boxes are in it. A count, not a join: the elevation is where the
    // boxes are named, and a row that tried to list them would be unreadable
    // for a full 42U frame.
    w("mounted", Walk::Mounted),
];
/// OSPF and BGP, `56` §4.8. `protocol` first because it is what tells the two
/// apart, then the one identifying number each uses -- `local_as` for BGP,
/// `router_id` for OSPF -- so one table serves both without a per-protocol view.
const ROUTING_PROTOCOL_COLUMNS: &[Col] = &[
    f("protocol", "RoutingProtocol.protocol"),
    w("router_id", Walk::RouterId),
    f("local_as", "RoutingProtocol.local_as"),
    f("reference_bandwidth", "RoutingProtocol.reference_bandwidth"),
    w("device", Walk::OwningDevice),
];
/// One neighbour. `peer_address` and `peer_as` are the BGP half, `area` and
/// `cost` the OSPF half; a row fills whichever its protocol uses and leaves the
/// other empty, which is `56` §4.8's table made legible in one place.
const PROTOCOL_ADJACENCY_COLUMNS: &[Col] = &[
    f("peer_address", "ProtocolAdjacency.peer_address"),
    f("peer_as", "ProtocolAdjacency.peer_as"),
    f("area", "ProtocolAdjacency.area"),
    f("cost", "ProtocolAdjacency.cost"),
    f("network_type", "ProtocolAdjacency.network_type"),
    w("device", Walk::OwningDevice),
];

// The six pasted-config kinds. Every column below is a field `schema/schema.yaml`
// declares on that kind — no column is computed here except the named traversals
// at the foot of this file.
//
// `52` §3.7 is the source for the row-set half and is quoted for it: "The row
// set — a kind plus a filter." It is NOT the source for the cell half. The
// phrase "a cell is a field or a stated walk" appeared here as a §3.7 quotation
// and §3.7 does not contain it; re-read 2026-08-15. What §3.7 does say points
// the other way: "Columns are kind-dependent and chosen from the schema", and
// "Lets you change | Field values, in place, in the cell." The cell rule below
// is this file's own convention, and it is written as one — and since the
// inventory became editable it is machine-readable, which is what `Cell` is for.
const INTERFACE_COLUMNS: &[Col] = &[
    f("name", "Interface.name"),
    w("device", Walk::OwningDevice),
    f("description", "Interface.description"),
    w("units", Walk::UnitNames),
];
// `st0` on an SRX. Its own row set rather than a row in `Interface`, because a
// row set is a kind plus a filter (`52` §3.7) and these are different kinds --
// and because for the job this product does first, the tunnel interface is the
// one an engineer looks for.
const TUNNEL_COLUMNS: &[Col] = &[
    f("name", "TunnelInterface.name"),
    w("device", Walk::OwningDevice),
    f("technology", "TunnelInterface.technology"),
    f("description", "TunnelInterface.description"),
    w("units", Walk::UnitNames),
];
const ZONE_COLUMNS: &[Col] = &[
    f("name", "Zone.name"),
    w("device", Walk::OwningDevice),
    w("interfaces", Walk::Targets(EdgeKind::ZoneMember)),
];
const IKE_GATEWAY_COLUMNS: &[Col] = &[
    f("name", "IkeGateway.name"),
    w("device", Walk::OwningDevice),
    f("peer", "IkeGateway.peer"),
    f("version", "IkeGateway.version"),
    w(
        "external interface",
        Walk::Targets(EdgeKind::ExternalInterface),
    ),
];
const IPSEC_VPN_COLUMNS: &[Col] = &[
    f("name", "IpsecVpn.name"),
    w("device", Walk::OwningDevice),
    f("mode", "IpsecVpn.mode"),
    w("bound to", Walk::Targets(EdgeKind::BindsInterface)),
    f("establish", "IpsecVpn.establish_tunnels"),
];
const IKE_PROPOSAL_COLUMNS: &[Col] = &[
    f("name", "IkeProposal.name"),
    w("device", Walk::OwningDevice),
    f("authentication", "IkeProposal.authentication_method"),
    f("dh group", "IkeProposal.dh_group"),
    f("encryption", "IkeProposal.encryption_algorithm"),
    f("integrity", "IkeProposal.authentication_algorithm"),
];
const IPSEC_PROPOSAL_COLUMNS: &[Col] = &[
    f("name", "IpsecProposal.name"),
    w("device", Walk::OwningDevice),
    f("protocol", "IpsecProposal.protocol"),
    f("encryption", "IpsecProposal.encryption_algorithm"),
    f("integrity", "IpsecProposal.authentication_algorithm"),
];

/// One firewall rule. `ordinal` first because a ruleset is read in order and
/// the order is the meaning; `enabled` beside `action` because "is it off" and
/// "does it allow" are the two facts an engineer checks first.
///
/// `any source` and `any dest` are the ONLY match columns, and their loneliness
/// is the honest shape of the schema today: a rule's real source, destination
/// and ports need `AddressValue` and `L4Spec`, which are empty structs in
/// `crates/fathom-ir/src/value.rs`. Columns that could only ever be blank would
/// be worse than none -- they would read as "this rule matches nothing".
///
/// **SIX, because six is the wire's limit.** `fathom_wasm::protocol`'s face
/// record carries `FACE_SLOTS = 8` strings: slot 0 is the id, slot 7 is the
/// opinions header, and the columns sit between. A seventh column is not
/// refused -- it is silently truncated, and the page then reads `undefined` for
/// the tail. `name` (the OPNsense uuid, which the row's own element id already
/// carries) and `device` (one paste is one device today) are what came off to
/// stay inside it. `crates/fathom-wasm/tests/face.rs` now pins the limit so the
/// next kind that wants seven gets a failing test instead of a broken table.
const SECURITY_POLICY_COLUMNS: &[Col] = &[
    f("ordinal", "SecurityPolicy.ordinal"),
    f("action", "SecurityPolicy.action"),
    f("enabled", "SecurityPolicy.enabled"),
    f("any source", "SecurityPolicy.match_any_source"),
    f("any dest", "SecurityPolicy.match_any_destination"),
    f("description", "SecurityPolicy.description"),
];

/// One relay target: the server address first because it IS the row's name
/// (WO-10 §7.3), the device beside it because a relay is meaningless without
/// the box that relays, then the group and the two limits. Five of the six
/// slots; names by sibling precedent, as WO-10 §11 item 6 authorises. The
/// routing instance is an EDGE (`RelayServerIn`) and is read off the element
/// page, not a column -- the same reason `bound to` is a walk above.
const DHCP_RELAY_COLUMNS: &[Col] = &[
    f("server", "DhcpRelay.server"),
    w("device", Walk::OwningDevice),
    f("group", "DhcpRelay.group_name"),
    f("max hops", "DhcpRelay.maximum_hop_count"),
    f("min wait", "DhcpRelay.minimum_wait_time"),
];

fn table(kind: InvKind) -> &'static [Col] {
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
        InvKind::Rack => RACK_COLUMNS,
        InvKind::SecurityPolicy => SECURITY_POLICY_COLUMNS,
        InvKind::DhcpRelay => DHCP_RELAY_COLUMNS,
    }
}

pub fn columns(kind: InvKind) -> Vec<&'static str> {
    table(kind).iter().map(|c| c.name).collect()
}

/// For each column, the field a person may type into it — `None` where the
/// column is a walk, and `None` where it is a field whose type `author.rs`
/// cannot yet parse from text.
///
/// This is the inventory's half of the promise `element.rs` already keeps for
/// the inspector: **the key travels with the column**, so the page holds no
/// name-to-key table of its own. A hand table in JavaScript is exactly how a
/// form ends up writing one field into another's slot, and a table of COLUMN
/// names would be worse than the inspector's, because four inventory columns
/// are deliberately not spelled like their field.
///
/// `is_authorable` is asked here rather than re-derived, so the inventory and
/// the inspector can never disagree about which fields are typeable: there is
/// one rule, in `author.rs`, and both faces read it.
pub fn column_keys(kind: InvKind) -> Vec<Option<FieldKey>> {
    table(kind)
        .iter()
        .map(|c| match c.cell {
            Cell::Field(path) => {
                let k = key(path);
                crate::is_authorable(k).then_some(k)
            }
            Cell::Walk(_) => None,
        })
        .collect()
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

/// One row's cells, in column order, straight off the same table `columns` and
/// `column_keys` read. There is no positional `match` here any more: a cell IS
/// its column's declaration, so a column and the value under it cannot drift.
fn cells(g: &Graph, kind: InvKind, id: NodeId) -> Vec<String> {
    table(kind)
        .iter()
        .map(|c| match &c.cell {
            Cell::Field(path) => value_cell(g, id, key(path)),
            Cell::Walk(walk) => match walk {
                Walk::DevicePremises => device_premises(g, id),
                Walk::PortDevice => {
                    equipment::port_device_hostname(g, id).unwrap_or_else(|| UNKNOWN.to_owned())
                }
                Walk::CabledPeer => match equipment::cabled_peer(g, id) {
                    Some(p) => p.text,
                    None => UNKNOWN.to_owned(),
                },
                Walk::PremisesDevices => premises_device_count(g, id).to_string(),
                Walk::OwningDevice => owning_device(g, id),
                Walk::UnitNames => unit_names(g, id),
                Walk::Targets(e) => edge_targets(g, id, *e),
                Walk::RouterId => routing_protocol_router_id(g, id),
                Walk::Mounted => g.inn(id, EdgeKind::MountedIn).count().to_string(),
            },
        })
        .collect()
}

/// The router id for a `RoutingProtocol` row: its own field where something
/// set it, otherwise the owning `RoutingInstance`'s.
///
/// THIS CELL IS NOT A STORED FIELD OF THE ROW'S OWN NODE, and `52` §3.7 does
/// not licence it. An earlier version of this comment quoted §3.7 as "a cell is
/// a field or a stated walk"; that sentence is not in §3.7, which instead says
/// columns are "chosen from the schema" and that the view "lets you change
/// field values, in place, in the cell". Read 2026-08-15. So this walk is a
/// deviation from the view's stated contract, recorded as one rather than
/// dressed as a citation — and it has a consequence the owner will meet when
/// inventory editing lands: an editable cell that is not the row's own field
/// has nowhere to write. `73` §14 is where that belongs when it is decided.
///
/// `schema/schema.yaml` declares `router_id` on both kinds, and
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

/// The column table's own guards. They live here rather than in
/// `tests/projection.rs` because the two things worth pinning — that a declared
/// path is a field of the ROW'S OWN kind, and that no walk is ever offered as
/// editable — are statements about the private table, and a test that could
/// only see the public surface would have to keep a second copy of it.
#[cfg(test)]
mod tests {
    use super::*;

    /// A path that names another kind's field would render `—` on every row
    /// forever, which looks exactly like a field nobody has filled in — and now
    /// that the key travels to the page it would be worse than a blank cell: an
    /// editor over column four of a `Chassis` writing into a `Device`.
    #[test]
    fn every_field_column_names_a_field_of_its_own_kind() {
        for kind in InvKind::ALL {
            let declared = kind.node_kind().fields();
            for col in table(kind) {
                let Cell::Field(path) = col.cell else {
                    continue;
                };
                let k = key(path);
                assert!(
                    declared.contains(&k),
                    "{}'s `{}` column declares {path}, which is not a field of {}",
                    kind.label(),
                    col.name,
                    kind.node_kind().name()
                );
            }
        }
    }

    /// The page indexes the key row by column position, so a shorter or longer
    /// list is an off-by-one that would offer the wrong field's editor.
    #[test]
    fn a_key_travels_with_every_column_and_no_more() {
        for kind in InvKind::ALL {
            assert_eq!(
                columns(kind).len(),
                column_keys(kind).len(),
                "{}",
                kind.label()
            );
        }
    }

    /// The rule the whole table exists to make unrepresentable: a cell computed
    /// by a walk has nowhere to write, so it is never offered.
    #[test]
    fn a_walk_is_never_offered_as_editable() {
        for kind in InvKind::ALL {
            let keys = column_keys(kind);
            for (i, col) in table(kind).iter().enumerate() {
                if matches!(col.cell, Cell::Walk(_)) {
                    assert!(
                        keys[i].is_none(),
                        "{}'s `{}` column is a walk and was offered as editable",
                        kind.label(),
                        col.name
                    );
                }
            }
        }
    }

    /// The named case, because it is the one column whose NAME is spelled
    /// exactly like a real field of its own kind: `RoutingProtocol.router_id`
    /// exists, and this column is still not it — the value may have come from
    /// the owning `RoutingInstance`. A page matching columns to fields by name
    /// would offer an editor here and write the wrong node's answer.
    #[test]
    fn the_router_id_column_is_a_walk_and_stays_read_only() {
        let cols = columns(InvKind::RoutingProtocol);
        let at = cols.iter().position(|c| *c == "router_id").expect("column");
        assert!(column_keys(InvKind::RoutingProtocol)[at].is_none());
    }

    /// `is_authorable` is the one rule, and the inventory asks it rather than
    /// keeping a second list. If `author.rs` ever grew a type, this test says
    /// which columns woke up; if it lost one, it says which went quiet.
    #[test]
    fn the_editable_columns_are_the_authorable_fields() {
        for kind in InvKind::ALL {
            let keys = column_keys(kind);
            for (i, col) in table(kind).iter().enumerate() {
                let Cell::Field(path) = col.cell else {
                    continue;
                };
                assert_eq!(
                    keys[i].is_some(),
                    crate::is_authorable(key(path)),
                    "{}'s `{}` column disagrees with author.rs about {path}",
                    kind.label(),
                    col.name
                );
            }
        }
    }
}
