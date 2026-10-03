//! Maintenance plans (ADR-0061 round 7): read a plan's remaining steps out of the held
//! estate, and say what each would touch. Nothing here writes; `shell::plan_preview` applies
//! each step to a scratch copy and runs the rules over it.
//!
//! A step's `edit` is one tab-separated line, the same edits the canvas makes:
//!   `field` id, wire name (`Device.management_address`), value
//!   `cable` port id, port id        `cut` cable id        `move` chassis id, rack id
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

/// The plan's steps still `planned`, in order. Done steps are already in the estate.
pub fn planned_steps(g: &Graph, plan: NodeId) -> Vec<Step> {
    let mut out: Vec<Step> = g
        .out(plan, EdgeKind::HasStep)
        .filter(|e| e.absent_since.is_none())
        .filter_map(|e| g.node(e.to).filter(|n| n.absent_since.is_none()))
        .filter(|n| field_text(g, n.id, PlanStepField::State.key()).as_deref() == Some("planned"))
        .map(|n| Step {
            id: n.id,
            ordinal: field_text(g, n.id, PlanStepField::Ordinal.key())
                .and_then(|t| t.parse().ok())
                .unwrap_or(u32::MAX),
            edit: field_text(g, n.id, PlanStepField::Edit.key())
                .map(|t| Edit::parse(&t))
                .unwrap_or(Edit::None),
        })
        .collect();
    out.sort_by_key(|s| s.ordinal);
    out
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
                for other in g.nodes().filter(|o| o.absent_since.is_none() && o.id != n) {
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
