//! Maintenance plans (ADR-0061 round 7): read a plan's remaining steps out of the held
//! estate, and say what each would touch. Nothing here writes; `shell::plan_preview` applies
//! each step to a scratch copy and runs the rules over it.
//!
//! A step's `edit` is one tab-separated line, the same edits the canvas makes:
//!   `field` id, wire name (`Device.management_address`), value
//!   `cable` port id, port id        `cut` cable id        `move` chassis id, rack id
//!   `lag` device id, LAG name, LACP mode, member interface ids (two or more)
//!   `unlag` LAG id (a back-out step: the LAG goes, its members stay)
//!   `part` card, power supply or port id, new model, new serial (a swap: the part's place,
//!   ports and cables stay)
//! A value may not hold a tab or a line break; the client refuses one when the step is made.

use std::collections::BTreeMap;

use fathom_graph::{Graph, NodeId};
use fathom_inventory::{display_name, field_text};
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind, PlanStepField, FIELD_KEYS};

pub enum Edit {
    None,
    Field {
        id: String,
        key: FieldKey,
        value: String,
    },
    Cable {
        a: String,
        b: String,
    },
    Cut {
        cable: String,
    },
    Move {
        chassis: String,
        rack: String,
    },
    Lag {
        device: String,
        name: String,
        members: Vec<String>,
    },
    Unlag {
        lag: String,
    },
    Part {
        id: String,
    },
}

/// The fields a step may set: mirrors `EDITABLE_FIELDS` in `client/src/document/plans.ts`.
const EDITABLE_FIELDS: &[&str] = &[
    "Device.hostname",
    "Device.role",
    "Device.management_address",
    "Chassis.serial",
    "Rack.row",
    "Rack.bay",
    "Rack.height_u",
    "PassiveNode.label",
    "Cable.label",
    "Cable.sheath",
    "Cable.media",
    "Cable.length_m",
    "Cable.ownership",
];

impl Edit {
    /// A line that is not a known edit, or names a field no hand can set, is `Edit::None`.
    pub fn parse(line: &str) -> Edit {
        let p: Vec<&str> = line.split('\t').collect();
        match p.as_slice() {
            ["field", id, wire, value] => match FIELD_KEYS
                .iter()
                .find(|(n, _)| n == wire && EDITABLE_FIELDS.contains(n))
            {
                Some((_, k)) => Edit::Field {
                    id: (*id).to_owned(),
                    key: FieldKey(*k),
                    value: (*value).to_owned(),
                },
                None => Edit::None,
            },
            ["cable", a, b, ..] => Edit::Cable {
                a: (*a).to_owned(),
                b: (*b).to_owned(),
            },
            ["cut", cable] => Edit::Cut {
                cable: (*cable).to_owned(),
            },
            ["move", chassis, rack, ..] => Edit::Move {
                chassis: (*chassis).to_owned(),
                rack: (*rack).to_owned(),
            },
            ["lag", device, name, lacp, members @ ..]
                if !members.is_empty() && ["active", "passive", "off", ""].contains(lacp) =>
            {
                Edit::Lag {
                    device: (*device).to_owned(),
                    name: (*name).to_owned(),
                    members: members.iter().map(|m| (*m).to_owned()).collect(),
                }
            }
            ["unlag", lag] => Edit::Unlag {
                lag: (*lag).to_owned(),
            },
            ["part", id, _model, _serial] => Edit::Part {
                id: (*id).to_owned(),
            },
            _ => Edit::None,
        }
    }
}

/// One step of the reply, ready to encode.
pub struct StepOut {
    pub id: String,
    pub ordinal: u32,
    pub error: String,
    pub impact: String,
    pub touches: String,
    pub rows: Vec<crate::checks::Row>,
}

pub struct Step {
    pub id: NodeId,
    pub ordinal: u32,
    pub edit: Edit,
}

/// The plan's steps still `planned`, in the order the work does them. Done steps are already in the estate.
///
/// An If path (schema 0.33) is not on that line until it is taken: a step whose `branch_of` names a main-line
/// step comes right after that step, in its own `ordinal` order, only when the main-line step has `if_taken`.
/// A `branch_of` naming no live main-line step of this plan reads as the main line, as the client reads it.
pub fn planned_steps(g: &Graph, plan: NodeId) -> Vec<Step> {
    let ordinal = |n: NodeId| -> u32 {
        field_text(g, n, PlanStepField::Ordinal.key())
            .and_then(|t| t.parse().ok())
            .unwrap_or(u32::MAX)
    };
    let all: Vec<NodeId> = g
        .out(plan, EdgeKind::HasStep)
        .filter(|e| e.absent_since.is_none())
        .filter_map(|e| g.node(e.to).filter(|n| n.absent_since.is_none()))
        .map(|n| n.id)
        .collect();
    // The main-line step a step's If path hangs from, when it names one of this plan's main-line steps.
    let parent_of = |n: NodeId| -> Option<NodeId> {
        let text = field_text(g, n, PlanStepField::BranchOf.key())?;
        match fathom_inventory::parse_display_id(g, &text)? {
            fathom_graph::ElementId::Node(p) => Some(p),
            fathom_graph::ElementId::Edge(_) => None,
        }
    };
    let main: std::collections::BTreeSet<NodeId> = all
        .iter()
        .copied()
        .filter(|n| parent_of(*n).is_none_or(|p| !all.contains(&p)))
        .collect();
    let mut keyed: Vec<((u32, u32, u32), NodeId)> = Vec::with_capacity(all.len());
    for n in &all {
        match parent_of(*n).filter(|p| main.contains(p) && !main.contains(n)) {
            None => keyed.push(((ordinal(*n), 0, 0), *n)),
            Some(p) => {
                let taken =
                    field_text(g, p, PlanStepField::IfTaken.key()).as_deref() == Some("true");
                if taken {
                    keyed.push(((ordinal(p), 1, ordinal(*n)), *n));
                }
            }
        }
    }
    keyed.sort_by_key(|(k, _)| *k);
    keyed
        .into_iter()
        .filter(|(_, n)| {
            field_text(g, *n, PlanStepField::State.key()).as_deref() == Some("planned")
        })
        .map(|((k, _, _), n)| Step {
            id: n,
            ordinal: k,
            edit: field_text(g, n, PlanStepField::Edit.key())
                .map(|t| Edit::parse(&t))
                .unwrap_or(Edit::None),
        })
        .collect()
}

fn live(g: &Graph, display: &str) -> Option<NodeId> {
    match fathom_inventory::parse_display_id(g, display)? {
        fathom_graph::ElementId::Node(n) => g
            .node(n)
            .filter(|node| node.absent_since.is_none())
            .map(|node| node.id),
        fathom_graph::ElementId::Edge(_) => None,
    }
}

/// A port reads as `device port`; anything else as its own name.
fn name(g: &Graph, n: NodeId) -> String {
    let own = display_name(g, n);
    match (n.kind, g.device_of(n)) {
        (NodeKind::PhysicalPort, Some(d)) => format!("{} {own}", display_name(g, d)),
        _ => own,
    }
}

fn touch(g: &Graph, n: NodeId) -> (String, String) {
    (n.to_string(), name(g, n))
}

/// The live cable ends at `port`, as the cables themselves.
fn cables_at(g: &Graph, port: NodeId) -> Vec<NodeId> {
    g.inn(port, EdgeKind::Terminates)
        .filter(|e| e.absent_since.is_none())
        .filter_map(|e| g.node(e.from))
        .filter(|c| c.absent_since.is_none())
        .map(|c| c.id)
        .collect()
}

/// The two ports a cable terminates on.
fn ends_of(g: &Graph, cable: NodeId) -> Vec<NodeId> {
    g.out(cable, EdgeKind::Terminates)
        .filter(|e| e.absent_since.is_none())
        .map(|e| e.to)
        .collect()
}

/// What `edit` touches in `g` as it stands now, and facts about it read from the graph.
/// Says what is touched, never what would go wrong (ADR-0020).
pub fn impact(g: &Graph, edit: &Edit) -> (Vec<String>, Vec<(String, String)>) {
    let mut lines = Vec::new();
    let mut touches = Vec::new();
    match edit {
        Edit::None => {}
        Edit::Field { id, key, value } => {
            let Some(n) = live(g, id) else {
                return (lines, touches);
            };
            // A key the node's kind does not have reads nothing; skip rather than trap.
            if !n.kind.fields().iter().any(|k| k.0 == key.0) {
                return (lines, touches);
            }
            touches.push(touch(g, n));
            let old = field_text(g, n, *key).unwrap_or_default();
            if old.len() >= 2 && old != *value {
                // Everything else that holds the value being replaced, by kind and field.
                let mut held: BTreeMap<(&'static str, &'static str), usize> = BTreeMap::new();
                // A plan's own words (a step's before and after) are not the design holding the value.
                let words =
                    |k: NodeKind| matches!(k, NodeKind::PlanStep | NodeKind::MaintenancePlan);
                for other in g
                    .nodes()
                    .filter(|o| o.absent_since.is_none() && o.id != n && !words(o.id.kind))
                {
                    for k in other.id.kind.fields() {
                        if field_text(g, other.id, *k).as_deref() == Some(old.as_str()) {
                            let field = FIELD_KEYS
                                .iter()
                                .find(|(_, v)| *v == k.0)
                                .map_or("a field", |(name, _)| {
                                    name.split_once('.').map_or(*name, |(_, f)| f)
                                });
                            *held.entry((other.id.kind.name(), field)).or_insert(0) += 1;
                        }
                    }
                }
                for ((kind, field), count) in held {
                    lines.push(format!(
                        "{count} other {kind} {} {old} in {}",
                        if count == 1 { "holds" } else { "hold" },
                        field.replace('_', " ")
                    ));
                }
            }
        }
        Edit::Cable { a, b } => {
            for end in [a, b] {
                let Some(p) = live(g, end) else { continue };
                touches.push(touch(g, p));
                if let Some(d) = g.device_of(p) {
                    let t = touch(g, d);
                    if !touches.contains(&t) {
                        touches.push(t);
                    }
                }
                if !cables_at(g, p).is_empty() {
                    lines.push(format!("{} already carries a cable", name(g, p)));
                }
            }
        }
        Edit::Cut { cable } => {
            let Some(c) = live(g, cable) else {
                return (lines, touches);
            };
            touches.push(touch(g, c));
            for p in ends_of(g, c) {
                let Some(d) = g.device_of(p) else { continue };
                let t = touch(g, d);
                if !touches.contains(&t) {
                    touches.push(t);
                }
                // Other cables the same box keeps.
                let others = g
                    .edges_of_kind(EdgeKind::Terminates)
                    .filter(|e| e.absent_since.is_none() && e.from != c)
                    .filter(|e| g.device_of(e.to) == Some(d))
                    .count();
                if others == 0 {
                    lines.push(format!("{} has no other cable", display_name(g, d)));
                }
            }
        }
        Edit::Move { chassis, rack } => {
            for id in [chassis, rack] {
                if let Some(n) = live(g, id) {
                    touches.push(touch(g, n));
                }
            }
        }
        Edit::Lag {
            device,
            name,
            members,
        } => {
            let Some(d) = live(g, device) else {
                return (lines, touches);
            };
            touches.push(touch(g, d));
            let taken = g
                .out(d, EdgeKind::HasInterface)
                .filter(|e| e.absent_since.is_none())
                .filter_map(|e| g.node(e.to).filter(|n| n.absent_since.is_none()))
                .any(|n| display_name(g, n.id) == *name);
            if taken {
                lines.push(format!("{} already has {name}", display_name(g, d)));
            }
            for m in members {
                let Some(i) = live(g, m) else { continue };
                touches.push(touch(g, i));
                let held = g
                    .out(i, EdgeKind::MemberOfAggregate)
                    .filter(|e| e.absent_since.is_none())
                    .find_map(|e| g.node(e.to).filter(|n| n.absent_since.is_none()));
                if let Some(ae) = held {
                    lines.push(format!(
                        "{} is already in {}",
                        display_name(g, i),
                        display_name(g, ae.id)
                    ));
                }
            }
        }
        Edit::Part { id } => {
            let Some(p) = live(g, id) else {
                return (lines, touches);
            };
            touches.push(touch(g, p));
            if let Some(d) = g.device_of(p) {
                touches.push(touch(g, d));
            }
            // What goes dark while the part is out: a card's cabled ports, or the link on an optic's port.
            let ports: Vec<NodeId> = match p.kind {
                NodeKind::Card => g
                    .inn(p, EdgeKind::OnCard)
                    .filter(|e| e.absent_since.is_none())
                    .map(|e| e.from)
                    .collect(),
                NodeKind::PhysicalPort => vec![p],
                _ => Vec::new(),
            };
            let cabled = ports
                .iter()
                .filter(|q| !cables_at(g, **q).is_empty())
                .count();
            if p.kind == NodeKind::Card && !ports.is_empty() {
                lines.push(format!(
                    "{} port{} on this card, {cabled} cabled, go down while it is out",
                    ports.len(),
                    if ports.len() == 1 { "" } else { "s" }
                ));
            } else if p.kind == NodeKind::PhysicalPort && cabled > 0 {
                lines.push(format!(
                    "the link on {} goes down while the optic is out",
                    name(g, p)
                ));
            }
        }
        Edit::Unlag { lag } => {
            let Some(ae) = live(g, lag) else {
                return (lines, touches);
            };
            touches.push(touch(g, ae));
            if let Some(d) = g.device_of(ae) {
                touches.push(touch(g, d));
            }
            let members = g
                .inn(ae, EdgeKind::MemberOfAggregate)
                .filter(|e| e.absent_since.is_none())
                .count();
            lines.push(format!(
                "{} loses its {members} member{}",
                display_name(g, ae),
                if members == 1 { "" } else { "s" }
            ));
        }
    }
    (lines, touches)
}

/// The frame `OP_CABLE` takes for drawing a cable between two existing ports.
pub fn cable_frame(prefix: &[u8; 24], a: &str, b: &str) -> Vec<u8> {
    let mut f = prefix.to_vec();
    f.extend_from_slice(&[1, 1]);
    for id in [a, b] {
        f.push(0);
        f.push(id.len().min(255) as u8);
        f.extend_from_slice(&id.as_bytes()[..id.len().min(255)]);
    }
    f.push(0);
    f
}

/// The frame `OP_CABLE` takes for cutting a cable.
pub fn cut_frame(prefix: &[u8; 24], cable: &str) -> Vec<u8> {
    let mut f = prefix.to_vec();
    f.extend_from_slice(&[0, 1, cable.len().min(255) as u8]);
    f.extend_from_slice(&cable.as_bytes()[..cable.len().min(255)]);
    f
}

/// The frame `OP_FIELD_SET` takes.
pub fn field_frame(prefix: &[u8; 24], key: FieldKey, id: &str, value: &str) -> Vec<u8> {
    let mut f = prefix.to_vec();
    f.extend_from_slice(&key.0.to_le_bytes());
    f.extend_from_slice(&(id.len() as u16).to_le_bytes());
    f.extend_from_slice(id.as_bytes());
    f.extend_from_slice(value.as_bytes());
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_keeps_only_editable_fields() {
        let ok = Edit::parse("field\tdevice:X\tDevice.role\tswitch");
        assert!(matches!(ok, Edit::Field { .. }));
        for line in [
            "field\tdevice:X\tMaintenancePlan.stage\trecorded",
            "field\tdevice:X\tDevice.platform\tx",
            "field\tdevice:X\tNope.nothing\tx",
            "field\tdevice:X\tDevice.role",
            "field\tdevice:X\tDevice.role\ta\tb",
            "field\t\t\t",
            "",
            "\t\t\t",
            "cut",
            "cut\ta\tb",
            "move\tonly",
            "cable\tonly",
            "bogus\tx",
        ] {
            assert!(matches!(Edit::parse(line), Edit::None), "{line:?}");
        }
        assert!(matches!(Edit::parse("cut\tcable:X"), Edit::Cut { .. }));
        assert!(matches!(
            Edit::parse("lag\tdevice:X\tae0\tactive\tinterface:A\tinterface:B"),
            Edit::Lag { ref members, .. } if members.len() == 2
        ));
        assert!(matches!(
            Edit::parse("unlag\taggregate-interface:X"),
            Edit::Unlag { .. }
        ));
        for line in [
            "lag\tdevice:X\tae0\tactive",
            "lag\tdevice:X\tae0\tsideways\tinterface:A",
            "lag\tdevice:X",
            "unlag",
            "unlag\ta\tb",
            "part\tcard:X",
            "part\tcard:X\tmodel",
        ] {
            assert!(matches!(Edit::parse(line), Edit::None), "{line:?}");
        }
        assert!(matches!(
            Edit::parse("part\tcard:X\t\tSERIAL2"),
            Edit::Part { ref id } if id == "card:X"
        ));
        assert!(matches!(
            Edit::parse("cable\ta\tb\textra"),
            Edit::Cable { .. }
        ));
    }

    #[test]
    fn parse_round_trips_hostile_values_and_never_panics() {
        let values = [
            "",
            " ",
            "switch",
            "caf\u{e9} \u{1f600} \u{2028}",
            "$9$Qz7Lx-VYgoJDm5T3",
            "\"quoted\" \\ back",
            "a\0b",
            "set security ike policy p pre-shared-key ascii-text Ab3dE6gH",
            &"x".repeat(1 << 20),
        ];
        for wire in EDITABLE_FIELDS {
            for v in values {
                match Edit::parse(&format!("field\tdevice:X\t{wire}\t{v}")) {
                    Edit::Field { id, key, value } => {
                        assert_eq!(id, "device:X");
                        assert_eq!(value, v);
                        assert!(FIELD_KEYS.iter().any(|(n, k)| n == wire && *k == key.0));
                    }
                    _ => panic!("{wire} with {v:?} should parse"),
                }
            }
        }
        // A value with a tab is a different shape: refused as an edit, never half-read.
        assert!(matches!(
            Edit::parse("field\tdevice:X\tDevice.role\ta\tb"),
            Edit::None
        ));
        for line in [
            "move\tchassis:X\track:Y\t4\tfront",
            "move\t\t\t\t",
            "cable\t\t",
            "cut\t",
            "\u{0}\t\u{0}",
            "FIELD\tdevice:X\tDevice.role\tx",
            " field\tdevice:X\tDevice.role\tx",
            "field\tdevice:X\tDevice.role \tx",
            "field\tdevice:X\tdevice.role\tx",
        ] {
            let _ = Edit::parse(line);
        }
        assert!(matches!(
            Edit::parse("FIELD\tdevice:X\tDevice.role\tx"),
            Edit::None
        ));
        assert!(matches!(
            Edit::parse("field\tdevice:X\tDevice.role \tx"),
            Edit::None
        ));
        assert!(matches!(
            Edit::parse("field\tdevice:X\tdevice.role\tx"),
            Edit::None
        ));
    }
}
