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
}

impl InvKind {
    pub fn label(self) -> &'static str {
        match self {
            InvKind::Device => "Device",
            InvKind::PhysicalPort => "PhysicalPort",
            InvKind::Premises => "Premises",
        }
    }

    pub const ALL: [InvKind; 3] = [InvKind::Device, InvKind::PhysicalPort, InvKind::Premises];

    fn node_kind(self) -> NodeKind {
        match self {
            InvKind::Device => NodeKind::Device,
            InvKind::PhysicalPort => NodeKind::PhysicalPort,
            InvKind::Premises => NodeKind::Premises,
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

pub fn columns(kind: InvKind) -> &'static [&'static str] {
    match kind {
        InvKind::Device => DEVICE_COLUMNS,
        InvKind::PhysicalPort => PORT_COLUMNS,
        InvKind::Premises => PREMISES_COLUMNS,
    }
}

pub fn rows(g: &Graph, kind: InvKind) -> Vec<Row> {
    g.nodes_of_kind(kind.node_kind())
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
    }
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
