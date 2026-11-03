//! `OP_WORK_CLASHES` (sign-off r105), through the wire: other open work on a plan's devices, a free
//! time to offer, and the plans under way on a device.

use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::ir_types::{
    DeviceField, EdgeKind, IssueField, IssueStage, IssueStepField, IssueStepTopic,
    MaintenancePlanField, MaintenancePlanStage, NodeKind, PlanStepField, PlanStepKind,
    PlanStepState,
};
use fathom_wasm::protocol::{
    decode_reply, ReplyView, FACE_CLASH, FACE_CLASH_HEAD, FACE_CLASH_WHO, FACE_RUNNING,
};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_CABLE, OP_EQUIP_ADD, OP_EXPORT_PLAIN, OP_LOAD_PLAIN, OP_WORK_CLASHES};

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

fn rows(reply: &[u8]) -> Vec<(u8, Vec<String>)> {
    match decode_reply(reply) {
        Ok(ReplyView::FaceRows(rows)) => {
            rows.iter().map(|r| (r.role, r.strings.to_vec())).collect()
        }
        other => panic!("{other:?}"),
    }
}

fn graph(shell: &mut Shell) -> Graph {
    fathom_workspace::read_plain(&shell.handle(OP_EXPORT_PLAIN, &[])).unwrap()
}

/// sw-a and sw-b with a cable between their p1 ports: (shell, sw-a, sw-b, cable, a's p1, b's p1).
fn lab() -> (Shell, String, String, String, String, String) {
    let mut shell = Shell::new();
    equip(&mut shell, "sw-a", 1);
    equip(&mut shell, "sw-b", 2);
    let g = graph(&mut shell);
    let mut devices: Vec<(String, String)> = g
        .nodes_of_kind(NodeKind::Device)
        .map(|n| (fathom_inventory::display_name(&g, n.id), n.id.to_string()))
        .collect();
    devices.sort();
    let (a, b) = (devices[0].1.clone(), devices[1].1.clone());
    let mut f = Vec::new();
    f.extend_from_slice(&1_700_000_100_001u64.to_le_bytes());
    f.extend_from_slice(&0x2222_0001u128.to_le_bytes());
    f.push(1);
    f.push(1);
    for d in [&a, &b] {
        f.push(1);
        f.push(d.len() as u8);
        f.extend_from_slice(d.as_bytes());
        f.push(2);
        f.extend_from_slice(b"p1");
    }
    f.push(0);
    let made = rows(&shell.handle(OP_CABLE, &f));
    let s = &made[0].1;
    (shell, a, b, s[1].clone(), s[2].clone(), s[3].clone())
}

fn set(g: &mut Graph, n: NodeId, key: fathom_ir::bag::FieldKey, text: &str, p: u128) {
    if text.is_empty() {
        return;
    }
    let v = fathom_inventory::parse_into_slot(key, text)
        .or_else(|_| fathom_rules::graph::box_from_text(key, text))
        .expect("parse");
    g.set_field_boxed(ElementId::Node(n), key, v, prov(p))
        .unwrap();
}

fn token<T: std::any::Any>(g: &mut Graph, n: NodeId, key: fathom_ir::bag::FieldKey, v: T, p: u128) {
    g.set_field(ElementId::Node(n), key, v, prov(p)).unwrap();
}

struct Plan<'a> {
    title: &'a str,
    stage: &'a str,
    start: &'a str,
    end: &'a str,
    team: &'a str,
    /// Each step: its targets, and whether it is done.
    steps: Vec<(Vec<String>, bool)>,
}

struct Issue<'a> {
    title: &'a str,
    device: String,
    stage: &'a str,
}

/// Put plans and issues into the shell's estate; their ids, plans first.
fn add(shell: &mut Shell, plans: &[Plan], issues: &[Issue]) -> Vec<String> {
    let mut g = graph(shell);
    g.begin_batch(BatchId(at(1)), "work").unwrap();
    let mut out = Vec::new();
    let mut n: u128 = 1000;
    let mut next = || {
        n += 10;
        n
    };
    for p in plans {
        let k = next();
        let plan = g
            .insert_node(NodeKind::MaintenancePlan, at(k), prov(k))
            .unwrap();
        set(
            &mut g,
            plan,
            MaintenancePlanField::Title.key(),
            p.title,
            k + 1,
        );
        token(
            &mut g,
            plan,
            MaintenancePlanField::Stage.key(),
            MaintenancePlanStage::from_token(p.stage),
            k + 2,
        );
        set(
            &mut g,
            plan,
            MaintenancePlanField::WindowStart.key(),
            p.start,
            k + 3,
        );
        set(
            &mut g,
            plan,
            MaintenancePlanField::WindowEnd.key(),
            p.end,
            k + 4,
        );
        set(
            &mut g,
            plan,
            MaintenancePlanField::Team.key(),
            p.team,
            k + 5,
        );
        set(
            &mut g,
            plan,
            MaintenancePlanField::Author.key(),
            "Sam",
            k + 6,
        );
        for (i, (targets, done)) in p.steps.iter().enumerate() {
            let k = next();
            let step = g.insert_node(NodeKind::PlanStep, at(k), prov(k)).unwrap();
            g.insert_edge(EdgeKind::HasStep, at(k + 1), plan, step, prov(k + 1))
                .unwrap();
            set(
                &mut g,
                step,
                PlanStepField::Ordinal.key(),
                &i.to_string(),
                k + 2,
            );
            token(
                &mut g,
                step,
                PlanStepField::Kind.key(),
                PlanStepKind::Other,
                k + 3,
            );
            set(&mut g, step, PlanStepField::Change.key(), "a step", k + 4);
            set(
                &mut g,
                step,
                PlanStepField::Targets.key(),
                &targets.join("\n"),
                k + 5,
            );
            token(
                &mut g,
                step,
                PlanStepField::State.key(),
                if *done {
                    PlanStepState::Done
                } else {
                    PlanStepState::Planned
                },
                k + 6,
            );
            if *done {
                set(
                    &mut g,
                    step,
                    PlanStepField::DoneAt.key(),
                    &format!("2026-11-04T22:0{i}"),
                    k + 7,
                );
            }
        }
        out.push(plan.to_string());
    }
    for i in issues {
        let k = next();
        let issue = g.insert_node(NodeKind::Issue, at(k), prov(k)).unwrap();
        set(&mut g, issue, IssueField::Title.key(), i.title, k + 1);
        set(&mut g, issue, IssueField::Device.key(), &i.device, k + 2);
        token(
            &mut g,
            issue,
            IssueField::Stage.key(),
            IssueStage::from_token(i.stage),
            k + 3,
        );
        let k = next();
        let step = g.insert_node(NodeKind::IssueStep, at(k), prov(k)).unwrap();
        g.insert_edge(EdgeKind::HasIssueStep, at(k + 1), issue, step, prov(k + 1))
            .unwrap();
        set(&mut g, step, IssueStepField::Ordinal.key(), "0", k + 2);
        token(
            &mut g,
            step,
            IssueStepField::Topic.key(),
            IssueStepTopic::Power,
            k + 3,
        );
        set(
            &mut g,
            step,
            IssueStepField::Question.key(),
            "Is it on?",
            k + 4,
        );
        out.push(issue.to_string());
    }
    g.end_batch().unwrap();
    let r = shell.handle(OP_LOAD_PLAIN, &fathom_workspace::write_plain(&g).unwrap());
    assert!(
        matches!(decode_reply(&r), Ok(ReplyView::FaceRows(_))),
        "{r:?}"
    );
    out
}

fn clashes(shell: &mut Shell, plan: &str) -> Vec<(u8, Vec<String>)> {
    let mut req = vec![0u8];
    req.extend_from_slice(plan.as_bytes());
    rows(&shell.handle(OP_WORK_CLASHES, &req))
}

fn running(shell: &mut Shell, device: &str) -> Vec<(u8, Vec<String>)> {
    let mut req = vec![1u8];
    req.extend_from_slice(device.as_bytes());
    rows(&shell.handle(OP_WORK_CLASHES, &req))
}

fn plan<'a>(
    title: &'a str,
    start: &'a str,
    end: &'a str,
    steps: Vec<(Vec<String>, bool)>,
) -> Plan<'a> {
    Plan {
        title,
        stage: "planned",
        start,
        end,
        team: "",
        steps,
    }
}

#[test]
fn names_the_other_plan_its_shared_port_and_a_free_time_both_ways() {
    let (mut shell, a, _b, _cable, pa, _pb) = lab();
    let ids = add(
        &mut shell,
        &[
            plan(
                "Move uplinks",
                "2026-11-04T22:00",
                "2026-11-05T00:00",
                vec![(vec![pa.clone()], false)],
            ),
            Plan {
                team: "team-7",
                ..plan(
                    "Replace PSU",
                    "2026-11-04T23:00",
                    "2026-11-05T01:00",
                    vec![(vec![pa.clone(), a.clone()], false)],
                )
            },
        ],
        &[],
    );
    let got = clashes(&mut shell, &ids[0]);
    assert_eq!(got.len(), 3, "{got:?}");
    assert_eq!(got[0].0, FACE_CLASH_HEAD);
    // Mine is two hours; the next two hours that meet nothing start when Replace PSU ends.
    assert_eq!(got[0].1[..2], ["2026-11-05T01:00", "2026-11-05T03:00"]);
    assert_eq!(got[1].0, FACE_CLASH);
    assert_eq!(
        got[1].1[..4],
        ["plan", ids[1].as_str(), "Replace PSU", "planned"]
    );
    assert_eq!(got[1].1[4], format!("{a}\tsw-a"));
    assert!(
        got[1].1[5].starts_with(&format!("{pa}\tsw-a ")),
        "{:?}",
        got[1].1[5]
    );
    assert_eq!(got[2].0, FACE_CLASH_WHO);
    // Their two hours, offered from when mine ends.
    assert_eq!(
        got[2].1[..5],
        ["team-7", "", "Sam", "2026-11-05T00:00", "2026-11-05T02:00"]
    );
    let back = clashes(&mut shell, &ids[1]);
    assert_eq!(back[1].1[1], ids[0]);
}

#[test]
fn a_cable_reaches_both_its_devices_and_windows_that_meet_do_not_clash() {
    let (mut shell, _a, b, cable, _pa, pb) = lab();
    let ids = add(
        &mut shell,
        &[
            plan(
                "Recable",
                "2026-11-04T02:00",
                "2026-11-04T04:00",
                vec![(vec![cable.clone()], false)],
            ),
            plan(
                "After",
                "2026-11-04T04:00",
                "2026-11-04T06:00",
                vec![(vec![pb.clone()], false)],
            ),
            plan("Whenever", "", "", vec![(vec![b.clone()], false)]),
        ],
        &[],
    );
    let got = clashes(&mut shell, &ids[0]);
    let titles: Vec<&str> = got
        .iter()
        .filter(|r| r.0 == FACE_CLASH)
        .map(|r| r.1[2].as_str())
        .collect();
    assert_eq!(titles, ["Whenever"]);
    // "Whenever" has no window, so no time can be offered either way.
    assert_eq!(got[0].1[..2], ["", ""]);
    assert_eq!(got[2].1[3..5], ["", ""]);
}

#[test]
fn open_issues_clash_closed_ones_and_finished_plans_do_not() {
    let (mut shell, a, b, _cable, pa, _pb) = lab();
    let ids = add(
        &mut shell,
        &[
            plan("Mine", "2026-11-04", "", vec![(vec![pa.clone()], false)]),
            Plan {
                stage: "called_off",
                ..plan("Old", "", "", vec![(vec![a.clone()], false)])
            },
        ],
        &[
            Issue {
                title: "sw-a flapping",
                device: a.clone(),
                stage: "open",
            },
            Issue {
                title: "sw-a was down",
                device: a.clone(),
                stage: "closed",
            },
            Issue {
                title: "sw-b down",
                device: b.clone(),
                stage: "open",
            },
        ],
    );
    let got = clashes(&mut shell, &ids[0]);
    assert_eq!(got.len(), 3, "{got:?}");
    assert_eq!(
        got[1].1[..4],
        ["issue", ids[2].as_str(), "sw-a flapping", "open"]
    );
    // Only an issue: there is no plan to move away from.
    assert_eq!(got[0].1[..2], ["", ""]);
}

#[test]
fn running_lists_a_plan_in_do_with_its_finished_steps_on_that_device() {
    let (mut shell, a, b, _cable, pa, pb) = lab();
    let ids = add(
        &mut shell,
        &[
            Plan {
                stage: "doing",
                ..plan(
                    "Night work",
                    "",
                    "",
                    vec![
                        (vec![pa.clone()], true),
                        (vec![pb.clone()], true),
                        (vec![a.clone()], false),
                    ],
                )
            },
            plan("Not started", "", "", vec![(vec![pa.clone()], false)]),
        ],
        &[],
    );
    let got = running(&mut shell, &a);
    assert_eq!(got.len(), 1, "{got:?}");
    assert_eq!(got[0].0, FACE_RUNNING);
    assert_eq!(got[0].1[0], ids[0]);
    assert_eq!(got[0].1[1].split('\n').count(), 1);
    // A port asks for its device.
    assert_eq!(running(&mut shell, &pb)[0].1[1].split('\n').count(), 1);
    assert!(running(&mut shell, &b)[0].1[1] != got[0].1[1]);
    // Not a plan, not a device, another mode: no rows.
    assert!(clashes(&mut shell, &a).is_empty());
    assert!(rows(&shell.handle(OP_WORK_CLASHES, &[7, b'x'])).is_empty());
    assert!(rows(&shell.handle(OP_WORK_CLASHES, &[])).is_empty());
}
