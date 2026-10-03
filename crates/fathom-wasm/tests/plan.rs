//! `OP_PLAN_PREVIEW` (ADR-0061 round 7), through the wire: steps applied in order on a copy,
//! findings per step, the held estate untouched.

#![allow(dead_code)]

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{
    DeviceField, EdgeKind, MaintenancePlanField, MaintenancePlanStage, NodeKind, PlanStepField,
    PlanStepKind, PlanStepState,
};
use fathom_wasm::protocol::{decode_reply, ReplyView, FACE_CHECK, FACE_PLAN_STEP};
use fathom_wasm::shell::Shell;
use fathom_wasm::{
    OP_CABLE, OP_CHECKS, OP_EQUIP_ADD, OP_EXPORT_PLAIN, OP_LOAD_PLAIN, OP_PLAN_PREVIEW,
};

fn at(n: u128) -> Ulid {
    Ulid::from_parts(1_700_000_000_000, n).unwrap()
}

fn prov(n: u128) -> ProvenanceRecord {
    ProvenanceRecord {
        id: ProvenanceId(at(9_000_000 + n)),
        origin: Origin::Hand,
        asserted_at: Timestamp(1_700_000_000_000),
        asserted_by: Actor::User(UserId(at(u128::MAX >> 8))),
        confidence: Confidence::Asserted,
        supersedes: None,
    }
}

fn equip(shell: &mut Shell, name: &str, n: u128) {
    let mut v = Vec::new();
    v.extend_from_slice(&(1_700_000_000_000u64 + n as u64).to_le_bytes());
    v.extend_from_slice(&(0x1111_0000 + n).to_le_bytes());
    v.push(2);
    for (key, text) in [
        (DeviceField::Hostname.key().0, name),
        (DeviceField::Platform.key().0, "junos-srx"),
    ] {
        v.extend_from_slice(&(key as u16).to_le_bytes());
        v.extend_from_slice(&(text.len() as u16).to_le_bytes());
        v.extend_from_slice(text.as_bytes());
    }
    let r = shell.handle(OP_EQUIP_ADD, &v);
    assert!(
        matches!(decode_reply(&r), Ok(ReplyView::FaceRows(_))),
        "{r:?}"
    );
}

fn frame(n: u128, mode: u8) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(&(1_700_000_100_000u64 + n as u64).to_le_bytes());
    v.extend_from_slice(&(0x2222_0000 + n).to_le_bytes());
    v.push(mode);
    v.push(1);
    v
}

fn mint(v: &mut Vec<u8>, boxid: &str, label: &str) {
    v.push(1);
    v.push(boxid.len() as u8);
    v.extend_from_slice(boxid.as_bytes());
    v.push(label.len() as u8);
    v.extend_from_slice(label.as_bytes());
}

fn slots(reply: &[u8]) -> Vec<String> {
    match decode_reply(reply) {
        Ok(ReplyView::FaceRows(rows)) => rows[0].strings.to_vec(),
        other => panic!("{other:?}"),
    }
}

fn device_ids(shell: &mut Shell) -> Vec<String> {
    let plain = shell.handle(OP_EXPORT_PLAIN, &[]);
    let g = fathom_workspace::read_plain(&plain).unwrap();
    let mut ids: Vec<String> = g
        .nodes_of_kind(NodeKind::Device)
        .map(|n| n.id.to_string())
        .collect();
    ids.sort();
    ids
}

/// Two switches, cable1 between their first ports, two free ports left by a cut cable.
fn estate() -> (Shell, String, String, String, String, String) {
    let mut shell = Shell::new();
    equip(&mut shell, "sw-a", 1);
    equip(&mut shell, "sw-b", 2);
    let ids = device_ids(&mut shell);
    let (a, b) = (ids[0].clone(), ids[1].clone());
    let mut f = frame(1, 1);
    mint(&mut f, &a, "p1");
    mint(&mut f, &b, "p1");
    f.push(0);
    let first = slots(&shell.handle(OP_CABLE, &f));
    let mut f = frame(2, 1);
    mint(&mut f, &a, "p2");
    mint(&mut f, &b, "p2");
    f.push(0);
    let second = slots(&shell.handle(OP_CABLE, &f));
    let mut cut = frame(3, 0);
    cut.push(second[1].len() as u8);
    cut.extend_from_slice(second[1].as_bytes());
    let r = shell.handle(OP_CABLE, &cut);
    assert!(
        matches!(decode_reply(&r), Ok(ReplyView::FaceRows(_))),
        "{r:?}"
    );
    // [1] cable, [2] near port, [3] far port
    (
        shell,
        first[1].clone(),
        first[2].clone(),
        second[2].clone(),
        second[3].clone(),
        a,
    )
}

struct Spec {
    edit: String,
    state: &'static str,
}

/// Put a plan with these steps into the shell's estate and return the plan's id.
fn add_plan(shell: &mut Shell, steps: &[Spec]) -> String {
    let plain = shell.handle(OP_EXPORT_PLAIN, &[]);
    let mut g: Graph = fathom_workspace::read_plain(&plain).unwrap();
    g.begin_batch(BatchId(at(1)), "plan").unwrap();
    let plan = g
        .insert_node(NodeKind::MaintenancePlan, at(100), prov(1))
        .unwrap();
    let set = |g: &mut Graph, n: NodeId, key: fathom_ir::bag::FieldKey, text: &str, p: u128| {
        let v = fathom_inventory::parse_into_slot(key, text)
            .or_else(|_| fathom_rules::graph::box_from_text(key, text))
            .expect("parse");
        g.set_field_boxed(ElementId::Node(n), key, v, prov(p))
            .unwrap();
    };
    set(
        &mut g,
        plan,
        MaintenancePlanField::Title.key(),
        "Swap uplink",
        2,
    );
    g.set_field(
        ElementId::Node(plan),
        MaintenancePlanField::Stage.key(),
        MaintenancePlanStage::Planned,
        prov(3),
    )
    .unwrap();
    for (i, s) in steps.iter().enumerate() {
        let n = 10 * (i as u128 + 1);
        let step = g
            .insert_node(NodeKind::PlanStep, at(200 + n), prov(10 + n))
            .unwrap();
        g.insert_edge(EdgeKind::HasStep, at(300 + n), plan, step, prov(11 + n))
            .unwrap();
        set(
            &mut g,
            step,
            PlanStepField::Ordinal.key(),
            &i.to_string(),
            12 + n,
        );
        g.set_field(
            ElementId::Node(step),
            PlanStepField::Kind.key(),
            PlanStepKind::Cable,
            prov(13 + n),
        )
        .unwrap();
        set(&mut g, step, PlanStepField::Change.key(), "a step", 14 + n);
        set(&mut g, step, PlanStepField::Edit.key(), &s.edit, 15 + n);
        let state = if s.state == "done" {
            PlanStepState::Done
        } else {
            PlanStepState::Planned
        };
        g.set_field(
            ElementId::Node(step),
            PlanStepField::State.key(),
            state,
            prov(16 + n),
        )
        .unwrap();
    }
    g.end_batch().unwrap();
    let bytes = fathom_workspace::write_plain(&g).unwrap();
    let r = shell.handle(OP_LOAD_PLAIN, &bytes);
    assert!(
        matches!(decode_reply(&r), Ok(ReplyView::FaceRows(_))),
        "{r:?}"
    );
    plan.to_string()
}

struct Out {
    step: Vec<String>,
    findings: Vec<String>,
}

fn preview(shell: &mut Shell, plan: &str) -> Vec<Out> {
    match decode_reply(&shell.handle(OP_PLAN_PREVIEW, plan.as_bytes())) {
        Ok(ReplyView::FaceRows(rows)) => {
            let mut out: Vec<Out> = Vec::new();
            for r in rows {
                if r.role == FACE_PLAN_STEP {
                    out.push(Out {
                        step: r.strings.to_vec(),
                        findings: Vec::new(),
                    });
                } else if r.role == FACE_CHECK {
                    out.last_mut()
                        .expect("a finding follows its step")
                        .findings
                        .push(r.strings[0].clone());
                }
            }
            out
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn steps_run_in_order_and_each_reports_what_it_adds() {
    let (mut shell, cable1, a1, a2, b2, _) = estate();
    let plan = add_plan(
        &mut shell,
        &[
            Spec {
                edit: format!("cable\t{a2}\t{b2}"),
                state: "planned",
            },
            // a1 already carries cable1: the already-cabled rule fires after this step only.
            Spec {
                edit: format!("cable\t{a1}\t{b2}"),
                state: "planned",
            },
            Spec {
                edit: format!("cut\t{cable1}"),
                state: "planned",
            },
            Spec {
                edit: format!("cable\t{a1}\tdevice:nope"),
                state: "planned",
            },
            Spec {
                edit: format!("cable\t{a1}\t{b2}"),
                state: "done",
            },
        ],
    );
    let held_before = shell.handle(OP_EXPORT_PLAIN, &[]);
    let checks_before = shell.handle(OP_CHECKS, &[]);

    let out = preview(&mut shell, &plan);
    assert_eq!(out.len(), 4, "the done step is skipped");
    assert_eq!(out[0].step[1], "0");
    assert_eq!(out[0].step[2], "", "step 1 applies: {:?}", out[0].step);
    assert!(out[0].findings.is_empty(), "{:?}", out[0].findings);
    assert!(
        out[0].step[4].contains("sw-a"),
        "touches name the devices: {:?}",
        out[0].step[4]
    );

    assert!(
        out[1].step[3].contains("already carries a cable"),
        "{:?}",
        out[1].step[3]
    );
    assert!(
        out[1]
            .findings
            .iter()
            .any(|r| r == "phy.port.already-cabled"),
        "{:?}",
        out[1].findings
    );

    assert_eq!(out[2].step[2], "", "cut applies: {:?}", out[2].step);
    assert!(
        out[3].step[2].contains("not in the design"),
        "{:?}",
        out[3].step[2]
    );

    // Nothing was written, and the check cache still answers the same.
    assert_eq!(shell.handle(OP_EXPORT_PLAIN, &[]), held_before);
    assert_eq!(shell.handle(OP_CHECKS, &[]), checks_before);
}

#[test]
fn not_a_plan_or_no_estate_answers_no_steps() {
    let mut shell = Shell::new();
    assert!(matches!(
        decode_reply(&shell.handle(OP_PLAN_PREVIEW, b"x")),
        Ok(ReplyView::Error(_))
    ));
    let (mut shell, _, a1, ..) = estate();
    assert!(preview(&mut shell, &a1).is_empty());
    assert!(preview(&mut shell, "garbage").is_empty());
}
