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

/// A field's rendered value **only if it is actually set**.
///
/// `value_cell` answers with `render::UNKNOWN` — an em dash — for an unset
/// field, which is right for a table cell and wrong for composing a name: it is
/// never the empty string, so `is_empty()` is always false and a name built by
/// checking it produces `peer —`. That shipped for one build. This is the test
/// the composing arms in `display_name` actually want.
fn bound(g: &Graph, id: NodeId, k: fathom_ir::bag::FieldKey) -> Option<String> {
    let v = value_cell(g, id, k);
    if v.is_empty() || v == UNKNOWN || v == "absent" {
        None
    } else {
        Some(v)
    }
}

/// `Device.role`'s token, only when it is a `Device` and only when the field is
/// actually set. `None` for every other kind and for a device nobody has said a
/// role for.
///
/// This exists so the DIAGRAM can say what a box is for (ADR-0037). The
/// inventory has had a `role` column since WO-08 and the inspector renders the
/// field like any other, but the picture drew `Device` over every box — so a
/// home lab of a firewall, a switch, an access point and four servers looked
/// like seven identical boxes, which is the state the owner would be drawing
/// INTO. A role you can only see by clicking is not on the diagram.
///
/// It goes through `bound` rather than `value_cell` for the reason `bound`'s own
/// doc records: `value_cell` answers with an em dash for an unset field, which
/// is never empty, so a caller testing `is_empty()` would print `Device —` on
/// every box that has no role. That exact defect shipped once already.
pub fn role_word(g: &Graph, id: NodeId) -> Option<String> {
    if id.kind != NodeKind::Device {
        return None;
    }
    bound(g, id, key("Device.role"))
}

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
        // ADR-0038 D11. `PhysicalPort.label` became legally absent at schema
        // 0.4 (2026-08-28) so the port picker could mint a port with no
        // silkscreen read yet — and until the cabling gesture minted the
        // first one, nothing here had ever rendered that state: it fell
        // through to the bare field read below and showed the em-dash
        // `UNKNOWN` marker everywhere, indistinguishable from a second
        // unlabelled port on the same box. `Cable`'s own arm three lines down
        // already has this fallback; a port gets the same one.
        NodeKind::PhysicalPort => {
            let label = value_cell(g, id, key("PhysicalPort.label"));
            if label == UNKNOWN {
                "(unlabelled)".to_owned()
            } else {
                label
            }
        }
        NodeKind::Premises => value_cell(g, id, key("Premises.label")),
        // THE THIRD TIME THIS DEFECT HAS BEEN FIXED, and the comment below
        // records the first two. `Rack` shipped with ADR-0036 and no arm here,
        // so a rack drew on the diagram, listed in the Outline and titled its
        // inspector as `rack:01M0JR…` while `R12` sat bound on the node — and
        // it went unnoticed because a rack was only ever reached through a
        // picker that reads `Rack.label` out of the inventory columns instead.
        //
        // It is load-bearing now rather than cosmetic: `57` §2 makes SELECTING
        // a rack the way into its elevation, and you cannot select a frame you
        // cannot tell from the frame beside it. `Rack.label` is `card: "1"`,
        // so there is always one to show.
        NodeKind::Rack => value_cell(g, id, key("Rack.label")),
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

        // Added 2026-08-15, and it is the SECOND time this defect has been
        // fixed. The comment below records the first: seven security kinds
        // showed `ikegateway:01KZ…` for a config Fathom had understood
        // perfectly. The routing and VLAN kinds landed on 2026-08-15 with
        // names bound in the graph and no arm here, so three ULID blobs sat on
        // the canvas where an operator's VLANs should have been. The lesson is
        // not "remember to add an arm" — it is that a kind whose name IS bound
        // and is not shown looks identical to one nobody has named.
        NodeKind::Vlan => value_cell(g, id, key("Vlan.name")),
        NodeKind::NtpServer => value_cell(g, id, key("NtpServer.address")),
        // WO-10 §7.3, 2026-08-29: "a relay's name is its server address." The
        // arm is not optional, for the reason the comment above records twice.
        NodeKind::DhcpRelay => value_cell(g, id, key("DhcpRelay.server")),
        // A device has one unnamed default instance and any number of named
        // ones, so the unbound case is common and is NOT an error. `—` alone
        // identifies nothing and a ULID is noise; saying it is the unnamed one
        // is the only reading that is both true and useful. Junos's own name
        // for it is not written here, because the parser has not read one.
        NodeKind::RoutingInstance => bound(g, id, key("RoutingInstance.name"))
            .unwrap_or_else(|| "routing instance (unnamed)".to_owned()),

        // These two have no name field at all in `schema/`, so what identifies
        // them is what they ARE: a protocol, and the peer or area it speaks to.
        // Composed from bound fields rather than invented, and falling back to
        // the id when nothing is bound, which is the honest empty state.
        //
        // `value_cell` returns `render::UNKNOWN` — an em dash — for a field that
        // is not set, NOT an empty string, so `is_empty()` is never true and the
        // first draft of this arm produced `peer —` on every OSPF adjacency.
        // `bound` is the test that was meant.
        NodeKind::RoutingProtocol => match bound(g, id, key("RoutingProtocol.protocol")) {
            Some(p) => p,
            None => id.to_string(),
        },
        NodeKind::ProtocolAdjacency => {
            match (
                bound(g, id, key("ProtocolAdjacency.peer_address")),
                bound(g, id, key("ProtocolAdjacency.area")),
            ) {
                (Some(peer), _) => format!("peer {peer}"),
                (None, Some(area)) => format!("area {area}"),
                _ => id.to_string(),
            }
        }

        // SINGLETONS, WHERE THE KIND IS THE NAME. A device holds exactly one of
        // each of these and `schema/` gives neither a name field, so there is
        // nothing to disambiguate and nothing to invent — "system settings" IS
        // which one it is. That is a different case from the fall-through
        // below, which exists for kinds that CAN have many and whose naming
        // nobody has decided; showing a ULID there says so honestly, and
        // showing one here would just be unreadable.
        NodeKind::SystemSettings => "system settings".to_owned(),
        NodeKind::SecurityFlowSettings => "security flow settings".to_owned(),

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
