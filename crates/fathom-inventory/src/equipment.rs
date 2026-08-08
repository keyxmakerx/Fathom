//! The per-equipment page — the inspector grown (`52` §2.3 as amended by
//! R35/ADR-0025), never a seventh view (`52` §9.5).
//!
//! > A PORT EXISTS BECAUSE HARDWARE EXISTS. AN INTERFACE EXISTS BECAUSE
//! > CONFIGURATION EXISTS. NEITHER MAY BE THE OTHER'S IDENTITY. (`19` §3.2)
//!
//! Two tables render that law. The ports table never contains an interface
//! name; the interfaces table never contains a silkscreen except inside its
//! `ports` join column; the only bridge between them is `Occupies`.

use fathom_graph::{Graph, NodeId};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

use crate::element::{display_name, element_page, ElementPage};
use crate::render::{key, value_cell, UNKNOWN};

pub struct CabledPeer {
    pub text: String,
    /// The far device's display id.
    pub far_device: String,
}

pub struct PortRow {
    /// The port's display id.
    pub id: String,
    /// The silkscreen (19 §3.3), verbatim.
    pub label: String,
    /// The owning Chassis' `member_index`, decimal.
    pub chassis: String,
    pub connector: String,
    pub service: String,
    /// `None` renders "—".
    pub cabled: Option<CabledPeer>,
}

pub struct IfaceRow {
    pub id: String,
    /// "reth0", "st0.0" — units rendered, never stored joined.
    pub name: String,
    /// "Interface" | "RethInterface" | … | "LogicalUnit".
    pub kind_word: &'static str,
    /// Via `Occupies`: "0/3 · chassis 0"; "—" where none can exist.
    pub ports: String,
}

pub struct EquipmentPage {
    /// The device's own inspector rows.
    pub element: ElementPage,
    pub ports: Vec<PortRow>,
    pub interfaces: Vec<IfaceRow>,
}

/// WO-08 §4.2's anchor rule, exactly: `Device` -> itself; anything with a
/// `device_of` -> that device; `Site` -> its first `HasDevice` target in
/// `NodeId` order; `Premises` -> the first Device, in `NodeId` order, reached
/// by any `AtPremises` in-edge's Site's `HasDevice` targets; anything else ->
/// `None`, and the face renders the empty state. Never a guess.
fn anchor_device(g: &Graph, anchor: NodeId) -> Option<NodeId> {
    if anchor.kind == NodeKind::Device {
        return g.node(anchor).map(|_| anchor);
    }
    if let Some(d) = g.device_of(anchor) {
        return Some(d);
    }
    match anchor.kind {
        NodeKind::Site => sorted_targets(g, anchor, EdgeKind::HasDevice)
            .first()
            .copied(),
        NodeKind::Premises => {
            let mut devices: Vec<NodeId> = g
                .inn(anchor, EdgeKind::AtPremises)
                .flat_map(|e| sorted_targets(g, e.from, EdgeKind::HasDevice))
                .collect();
            devices.sort();
            devices.first().copied()
        }
        _ => None,
    }
}

/// Edge targets in `NodeId` order — the order every table on this page uses,
/// which is a property of content and not of insertion (invariant 9).
fn sorted_targets(g: &Graph, from: NodeId, kind: EdgeKind) -> Vec<NodeId> {
    let mut out: Vec<NodeId> = g.out(from, kind).map(|e| e.to).collect();
    out.sort();
    out
}

pub fn equipment_page(g: &Graph, anchor: NodeId) -> Option<EquipmentPage> {
    let device = anchor_device(g, anchor)?;
    let element = element_page(g, device)?;

    let mut ports: Vec<PortRow> = Vec::new();
    for chassis in sorted_targets(g, device, EdgeKind::HasChassis) {
        let member = value_cell(g, chassis, key("Chassis.member_index"));
        for port in sorted_targets(g, chassis, EdgeKind::HasPort) {
            ports.push(PortRow {
                id: port.to_string(),
                label: value_cell(g, port, key("PhysicalPort.label")),
                chassis: member.clone(),
                connector: value_cell(g, port, key("PhysicalPort.connector")),
                service: value_cell(g, port, key("PhysicalPort.service")),
                cabled: cabled_peer(g, port),
            });
        }
    }

    let mut interfaces: Vec<IfaceRow> = Vec::new();
    for iface in sorted_targets(g, device, EdgeKind::HasInterface) {
        interfaces.push(iface_row(g, iface));
        let mut units = sorted_targets(g, iface, EdgeKind::HasUnit);
        units.sort_by_key(|u| value_cell(g, *u, key("LogicalUnit.index")));
        for unit in units {
            interfaces.push(iface_row(g, unit));
        }
    }

    Some(EquipmentPage {
        element,
        ports,
        interfaces,
    })
}

fn iface_row(g: &Graph, id: NodeId) -> IfaceRow {
    IfaceRow {
        id: id.to_string(),
        name: display_name(g, id),
        kind_word: id.kind.name(),
        ports: occupied_ports(g, id),
    }
}

/// The `Occupies` join, and the only bridge between the two tables. `19` §3.7:
/// *"`from` is `[Interface]` only"* — `reth0` and `ae0` reach hardware through
/// their members, `st0` reaches nothing, so those rows read `—` by
/// construction rather than by a special case.
fn occupied_ports(g: &Graph, id: NodeId) -> String {
    let cells: Vec<String> = sorted_targets(g, id, EdgeKind::Occupies)
        .into_iter()
        .map(|port| {
            let label = value_cell(g, port, key("PhysicalPort.label"));
            match g.owner(port) {
                Some(chassis) if chassis.kind == NodeKind::Chassis => format!(
                    "{label} · chassis {}",
                    value_cell(g, chassis, key("Chassis.member_index"))
                ),
                _ => label,
            }
        })
        .collect();
    if cells.is_empty() {
        UNKNOWN.to_owned()
    } else {
        cells.join(" · ")
    }
}

/// The owning device's `hostname`, through the containment forest.
pub(crate) fn port_device_hostname(g: &Graph, port: NodeId) -> Option<String> {
    let device = g.device_of(port)?;
    Some(value_cell(g, device, key("Device.hostname")))
}

/// WO-08 §4.6's cabled-peer walk, exactly: the `Terminates` in-edges at `p`
/// name the cable(s); each cable's other `Terminates` out-edge names the far
/// port `q`; the cell reads `<far hostname> · <q.label> · <cable label>`, with
/// `itself` for a same-device peer. A cable with no second modelled port end
/// reads `<cable label> · far end unmodelled`; no cable at all is `None`, and
/// the caller renders `—`.
pub(crate) fn cabled_peer(g: &Graph, port: NodeId) -> Option<CabledPeer> {
    let cable = g.inn(port, EdgeKind::Terminates).map(|e| e.from).next()?;
    let cable_label = value_cell(g, cable, key("Cable.label"));

    let far = sorted_targets(g, cable, EdgeKind::Terminates)
        .into_iter()
        .find(|q| *q != port && q.kind == NodeKind::PhysicalPort);

    let Some(q) = far else {
        return Some(CabledPeer {
            text: format!("{cable_label} · far end unmodelled"),
            far_device: String::new(),
        });
    };

    let Some(far_device) = g.device_of(q) else {
        return Some(CabledPeer {
            text: format!("{cable_label} · far end unmodelled"),
            far_device: String::new(),
        });
    };

    let near_device = g.device_of(port);
    let who = if near_device == Some(far_device) {
        "itself".to_owned()
    } else {
        value_cell(g, far_device, key("Device.hostname"))
    };
    let label = value_cell(g, q, key("PhysicalPort.label"));
    Some(CabledPeer {
        text: format!("{who} · {label} · {cable_label}"),
        far_device: far_device.to_string(),
    })
}
