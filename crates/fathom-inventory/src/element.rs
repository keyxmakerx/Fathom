//! The inspector's meaning face over one element (`54` §18): the field table,
//! the display name, the context line, and the full display id.
//!
//! *"The node ID is shown, in full, and never truncated"* (`54` §18). The id
//! is the element's `Display` form — `<kind-lower>:<ulid>`, no product-name
//! prefix (ADR-0005) — and `parse_display_id` is its inverse, built on
//! `fathom-id`'s Crockford round-trip rather than a second decoder.

use fathom_graph::{ElementId, Graph, NodeId};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

use crate::render::{field_cell, field_name, key, value_cell, UNKNOWN};

/// One field row of the inspector table (54 §18): name, rendered value,
/// and the provenance cell ("hand · 2026-07-31" | "unset" |
/// "absent — asserted · hand · 2026-07-31").
pub struct FieldRow {
    pub name: &'static str,
    pub value: String,
    pub provenance: String,
    /// The schema's wire key for this field, carried so a UI can offer to edit
    /// the row without holding a name-to-key table of its own. A hand table on
    /// the page is exactly how a form ends up writing the model into the serial;
    /// this makes the key travel with the row it belongs to.
    pub key: fathom_ir::bag::FieldKey,
    /// Whether a person can type this field's type today
    /// (`crate::is_authorable`). The page hides the editor where this is false,
    /// so it never offers an input whose every value will be refused.
    pub editable: bool,
}

pub struct ElementPage {
    /// `NodeKind::name()`.
    pub kind_word: &'static str,
    pub name: String,
    /// The full display id, never truncated (54 §18).
    pub id: String,
    pub context: Option<String>,
    /// The kind's schema fields, declaration order.
    pub fields: Vec<FieldRow>,
}

pub fn element_page(g: &Graph, id: NodeId) -> Option<ElementPage> {
    g.node(id)?;
    Some(ElementPage {
        kind_word: id.kind.name(),
        name: display_name(g, id),
        id: id.to_string(),
        context: context_line(g, id),
        fields: id
            .kind
            .fields()
            .iter()
            .map(|k| {
                let (value, provenance) = field_cell(g, id, *k);
                FieldRow {
                    name: field_name(*k),
                    value,
                    provenance,
                    key: *k,
                    editable: crate::is_authorable(*k),
                }
            })
            .collect(),
    })
}

/// WO-08 §4.6's display-name rule. Computed here, never in JS.
pub(crate) fn display_name(g: &Graph, id: NodeId) -> String {
    match id.kind {
        NodeKind::Device => value_cell(g, id, key("Device.hostname")),
        NodeKind::PhysicalPort => value_cell(g, id, key("PhysicalPort.label")),
        NodeKind::Premises => value_cell(g, id, key("Premises.label")),
        NodeKind::Site => value_cell(g, id, key("Site.name")),
        NodeKind::Cable => {
            let label = value_cell(g, id, key("Cable.label"));
            if label == UNKNOWN {
                "(unlabelled)".to_owned()
            } else {
                label
            }
        }
        NodeKind::Interface => value_cell(g, id, key("Interface.name")),
        NodeKind::AggregateInterface => value_cell(g, id, key("AggregateInterface.name")),
        NodeKind::RethInterface => value_cell(g, id, key("RethInterface.name")),
        NodeKind::TunnelInterface => value_cell(g, id, key("TunnelInterface.name")),
        NodeKind::LogicalUnit => {
            let index = value_cell(g, id, key("LogicalUnit.index"));
            match g.owner(id) {
                // Rendered, never stored joined (`schema/schema.yaml`,
                // `LogicalUnit`: "st0.0 is rendered from (TunnelInterface
                // st0, index 0), never stored joined").
                Some(owner) => format!("{}.{index}", display_name(g, owner)),
                None => index,
            }
        }
        NodeKind::Chassis => format!("chassis {}", value_cell(g, id, key("Chassis.member_index"))),

        // The security objects a pasted junos-srx config actually builds. Added
        // 2026-08-10: before it, every one of these fell through to the arm
        // below and rendered as a raw ULID, so a config Fathom had understood
        // *perfectly* showed the operator `ikegateway:01KZ…` where `gw-hq` was
        // the whole point. `name` is `card: "1"` on all seven, so none of these
        // can be `—` on a node the parser built.
        NodeKind::Zone => value_cell(g, id, key("Zone.name")),
        NodeKind::IkeProposal => value_cell(g, id, key("IkeProposal.name")),
        NodeKind::IkePolicy => value_cell(g, id, key("IkePolicy.name")),
        NodeKind::IkeGateway => value_cell(g, id, key("IkeGateway.name")),
        NodeKind::IpsecProposal => value_cell(g, id, key("IpsecProposal.name")),
        NodeKind::IpsecPolicy => value_cell(g, id, key("IpsecPolicy.name")),
        NodeKind::IpsecVpn => value_cell(g, id, key("IpsecVpn.name")),
        // `Address` has no name; its value *is* its name, and it is the thing
        // an operator reads (`10.255.0.1/30`).
        NodeKind::Address => value_cell(g, id, key("Address.value")),

        // Deliberately last and deliberately a ULID: a kind with no arm is a
        // kind nobody has decided how to name, and showing its id says so
        // rather than inventing a label. Adding a kind here is cheap; guessing
        // is what produced the defect above.
        _ => id.to_string(),
    }
}

/// WO-08 §4.6's context lines. Roots have none; the `Device` line elides the
/// missing half rather than printing a placeholder.
fn context_line(g: &Graph, id: NodeId) -> Option<String> {
    match id.kind {
        NodeKind::PhysicalPort => {
            let device = device_word(g, id)?;
            match g.owner(id) {
                Some(chassis) if chassis.kind == NodeKind::Chassis => Some(format!(
                    "{device} · chassis {}",
                    value_cell(g, chassis, key("Chassis.member_index"))
                )),
                _ => Some(device),
            }
        }
        NodeKind::Chassis
        | NodeKind::Interface
        | NodeKind::AggregateInterface
        | NodeKind::RethInterface
        | NodeKind::TunnelInterface
        | NodeKind::LogicalUnit => device_word(g, id),
        NodeKind::Device => {
            let site = g.owner(id);
            let mut parts: Vec<String> = Vec::new();
            if let Some(s) = site {
                parts.push(format!("site {}", value_cell(g, s, key("Site.name"))));
            }
            if let Some(p) = site.and_then(|s| g.out(s, EdgeKind::AtPremises).next()) {
                parts.push(format!(
                    "premises {}",
                    value_cell(g, p.to, key("Premises.label"))
                ));
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" · "))
            }
        }
        _ => None,
    }
}

fn device_word(g: &Graph, id: NodeId) -> Option<String> {
    let d = g.device_of(id)?;
    Some(format!(
        "device {}",
        value_cell(g, d, key("Device.hostname"))
    ))
}

/// Split on the last ':', `Ulid::decode` the tail, `Graph::resolve_ref`,
/// and cross-check the kind prefix against the resolved element's kebab
/// kind; any mismatch is None. No new decoder is written (fathom-id owns
/// Crockford).
pub fn parse_display_id(g: &Graph, s: &str) -> Option<ElementId> {
    let (_, tail) = s.rsplit_once(':')?;
    let ulid = Ulid::decode(tail).ok()?;
    let resolved = g.resolve_ref(fathom_id::NodeId(ulid))?;
    // The kind prefix is not taken on trust: the element renders its own
    // display form and the two must be byte-equal.
    if resolved.to_string() == s {
        Some(resolved)
    } else {
        None
    }
}
