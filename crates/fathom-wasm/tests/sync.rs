//! `OP_SYNC` through the wire: a pure append is taken, anything else is `ERR_RESYNC` and the
//! module is left exactly as it was. The differential oracle over random edits is `sync_diff.rs`.

#![allow(dead_code)]

use fathom_graph::{
    Actor, Batch, BatchId, ElementId, Graph, NodeId, Op, Snapshot, Timestamp, UserId,
};
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};
use fathom_wasm::protocol::{decode_reply, ReplyView, ERR_NOT_INITIALISED, ERR_RESYNC};
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_CHECKS, OP_EXPORT_PLAIN, OP_LOAD_PLAIN, OP_SYNC};

mod sim;
use sim::{checks, finding_rows, load, sync_reply, Sim};

fn code(reply: &[u8]) -> Option<u16> {
    match decode_reply(reply) {
        Ok(ReplyView::Error(e)) => Some(e.code),
        _ => None,
    }
}

fn export(shell: &mut Shell) -> Vec<u8> {
    shell.handle(OP_EXPORT_PLAIN, &[])
}

fn sim_with(seed: u64, steps: usize) -> Sim {
    let mut s = Sim::new(seed);
    for _ in 0..steps {
        s.step();
    }
    s
}

/// A module holding `sim`'s design and what it exported.
fn held(sim: &Sim) -> (Shell, Vec<u8>) {
    let mut sh = Shell::new();
    load(&mut sh, &sim.g);
    let bytes = export(&mut sh);
    (sh, bytes)
}

#[test]
fn a_pure_append_is_taken_with_an_empty_reply() {
    let mut sim = sim_with(1, 30);
    let (mut sh, _) = held(&sim);
    let seen = sim.g.log().len();
    for _ in 0..10 {
        sim.step();
    }
    assert!(sync_reply(&mut sh, &sim.g, seen).is_empty());
    let (mut fresh, want) = held(&sim);
    assert_eq!(export(&mut sh), want);
    assert_eq!(checks(&mut sh), checks(&mut fresh));
}

#[test]
fn no_estate_is_resync_not_a_clean_bill() {
    let sim = sim_with(2, 5);
    let mut sh = Shell::new();
    assert_eq!(code(&sync_reply(&mut sh, &sim.g, 0)), Some(ERR_RESYNC));
    // And the module still has none.
    assert_eq!(code(&sh.handle(OP_CHECKS, &[])), Some(ERR_NOT_INITIALISED));
}

#[test]
fn an_empty_module_takes_a_whole_log_from_none() {
    let sim = sim_with(3, 12);
    let mut sh = Shell::new();
    let empty = Graph::new();
    load(&mut sh, &empty);
    assert!(sync_reply(&mut sh, &sim.g, 0).is_empty());
    let (_, want) = held(&sim);
    assert_eq!(export(&mut sh), want);
}

#[test]
fn an_unrelated_history_is_resync_and_the_module_is_unchanged() {
    let a = sim_with(4, 20);
    let b = sim_with(5, 20);
    let (mut sh, before) = held(&a);
    let before_checks = checks(&mut sh);
    // A delta from another design, whatever it claims to follow.
    let other_all = sync_reply(&mut Shell::new(), &b.g, 0);
    assert_eq!(code(&other_all), Some(ERR_RESYNC));
    assert_eq!(code(&sync_reply(&mut sh, &b.g, 0)), Some(ERR_RESYNC));
    assert_eq!(code(&sync_reply(&mut sh, &b.g, 7)), Some(ERR_RESYNC));
    assert_eq!(export(&mut sh), before);
    assert_eq!(checks(&mut sh), before_checks);
}

#[test]
fn a_base_that_is_not_the_modules_last_batch_is_resync() {
    let mut sim = sim_with(6, 20);
    let (mut sh, before) = held(&sim);
    let seen = sim.g.log().len();
    for _ in 0..4 {
        sim.step();
    }
    // Skipping a batch the module never saw, then re-sending one it has.
    assert_eq!(
        code(&sync_reply(&mut sh, &sim.g, seen + 1)),
        Some(ERR_RESYNC)
    );
    assert_eq!(
        code(&sync_reply(&mut sh, &sim.g, seen - 1)),
        Some(ERR_RESYNC)
    );
    assert_eq!(export(&mut sh), before);
    // The right one still lands afterwards.
    assert!(sync_reply(&mut sh, &sim.g, seen).is_empty());
}

#[test]
fn the_same_delta_twice_is_refused_the_second_time() {
    let mut sim = sim_with(7, 20);
    let (mut sh, _) = held(&sim);
    let seen = sim.g.log().len();
    for _ in 0..4 {
        sim.step();
    }
    assert!(sync_reply(&mut sh, &sim.g, seen).is_empty());
    let after = export(&mut sh);
    assert_eq!(code(&sync_reply(&mut sh, &sim.g, seen)), Some(ERR_RESYNC));
    assert_eq!(export(&mut sh), after);
}

/// A delta that follows the module's last batch (so the base passes) with a hand-made fragment.
fn follow(sim: &Sim, batches: Vec<Batch>) -> Vec<u8> {
    let snap = sim.g.to_snapshot().unwrap();
    let base = sim.g.log().last().map(|b| b.id);
    let mut f = snap.since(sim.g.log().len());
    f.batches = batches;
    f.nodes = snap.nodes;
    f.edges = snap.edges;
    f.provenance = snap.provenance;
    f.history = snap.history;
    fathom_workspace::write_delta(base, &f)
}

fn batch(id: u128, ops: Vec<Op>) -> Batch {
    Batch {
        id: BatchId(fathom_id::Ulid::from_parts(1_790_899_200_000, 9_000_000 + id).unwrap()),
        label: "hand".into(),
        ops,
        comment: None,
        reverses: None,
    }
}

fn by() -> Actor {
    Actor::User(UserId::LOCAL)
}

#[test]
fn the_same_op_again_is_refused_by_the_store_not_merged() {
    let sim = sim_with(8, 40);
    let (mut sh, before) = held(&sim);
    // An AddNode for a node the module already holds, under a batch id it has never seen.
    let (node, prov) = sim
        .g
        .log()
        .iter()
        .flat_map(|b| &b.ops)
        .find_map(|o| match o {
            Op::AddNode { node, prov } => Some((*node, *prov)),
            _ => None,
        })
        .unwrap();
    let frame = follow(&sim, vec![batch(1, vec![Op::AddNode { node, prov }])]);
    assert_eq!(code(&sh.handle(OP_SYNC, &frame)), Some(ERR_RESYNC));
    assert_eq!(export(&mut sh), before);
    // A batch id the module already holds, with ops that would otherwise be fine.
    let dup = sim.g.log()[3].id;
    let mut b = batch(2, vec![]);
    b.id = dup;
    assert_eq!(
        code(&sh.handle(OP_SYNC, &follow(&sim, vec![b]))),
        Some(ERR_RESYNC)
    );
    assert_eq!(export(&mut sh), before);
}

#[test]
fn a_failure_in_a_later_batch_leaves_the_estate_untouched() {
    let mut sim = sim_with(9, 40);
    let (mut sh, before) = held(&sim);
    let seen = sim.g.log().len();
    for _ in 0..5 {
        sim.step();
    }
    let good =
        fathom_workspace::read_delta(&fathom_workspace::write_delta_since(&sim.g, seen).unwrap())
            .unwrap();
    // The same batches, then one that tombstones something that does not exist.
    let mut f: Snapshot = good.fragment;
    let ghost = NodeId {
        kind: NodeKind::Device,
        ulid: fathom_id::Ulid::from_parts(1, 1).unwrap(),
    };
    f.batches.push(batch(
        3,
        vec![Op::Tombstone {
            element: ElementId::Node(ghost),
            at: Timestamp(1),
            by: by(),
        }],
    ));
    let frame = fathom_workspace::write_delta(good.base, &f);
    assert_eq!(code(&sh.handle(OP_SYNC, &frame)), Some(ERR_RESYNC));
    assert_eq!(
        export(&mut sh),
        before,
        "no earlier batch of the delta survived"
    );
    // The honest delta still lands.
    assert!(sync_reply(&mut sh, &sim.g, seen).is_empty());
}

#[test]
fn a_schema_version_that_is_not_ours_is_resync() {
    let mut sim = sim_with(10, 10);
    let (mut sh, before) = held(&sim);
    let seen = sim.g.log().len();
    sim.step();
    let frame = fathom_workspace::write_delta_since(&sim.g, seen).unwrap();
    let text = String::from_utf8(frame).unwrap();
    let bad = text.replacen("schema ", "schema 99.", 1).into_bytes();
    assert_eq!(code(&sh.handle(OP_SYNC, &bad)), Some(ERR_RESYNC));
    assert_eq!(export(&mut sh), before);
}

#[test]
fn a_plain_face_is_not_a_delta_and_a_delta_is_not_a_plain_face() {
    let sim = sim_with(11, 10);
    let (mut sh, before) = held(&sim);
    let plain = fathom_workspace::write_plain(&sim.g).unwrap();
    assert_eq!(code(&sh.handle(OP_SYNC, &plain)), Some(ERR_RESYNC));
    let delta = fathom_workspace::write_delta_since(&sim.g, 0).unwrap();
    assert!(code(&sh.handle(OP_LOAD_PLAIN, &delta)).is_some());
    // The refused load did not replace the estate either.
    assert_eq!(export(&mut sh), before);
}

/// Random bytes, and valid frames cut and flipped: never a panic, and a refusal changes nothing.
#[test]
fn fuzzed_frames_never_panic_and_a_refusal_changes_nothing() {
    let mut sim = sim_with(12, 25);
    let (mut sh, mut before) = held(&sim);
    let seen = sim.g.log().len();
    for _ in 0..3 {
        sim.step();
    }
    let valid = fathom_workspace::write_delta_since(&sim.g, seen).unwrap();
    let mut rng = sim::Rng(0xF00D);
    let (mut refused, mut accepted) = (0, 0);
    let mut try_frame = |sh: &mut Shell, before: &mut Vec<u8>, frame: &[u8]| {
        let reply = sh.handle(OP_SYNC, frame);
        if reply.is_empty() {
            // A mutation that still parses and applies: a new baseline for the module.
            accepted += 1;
            *before = export(sh);
        } else {
            assert_eq!(code(&reply), Some(ERR_RESYNC));
            refused += 1;
            assert_eq!(&export(sh), before, "a refused delta changed the estate");
        }
    };
    for len in 0..300 {
        let mut junk = vec![0u8; len];
        for b in &mut junk {
            *b = rng.next() as u8;
        }
        try_frame(&mut sh, &mut before, &junk);
        // The header's own words, then junk.
        let mut framed = b"fathom-delta 1\nschema 0.13\nbase none\n\n".to_vec();
        framed.extend_from_slice(&junk);
        try_frame(&mut sh, &mut before, &framed);
    }
    for cut in (0..valid.len()).step_by(37) {
        try_frame(&mut sh, &mut before, &valid[..cut]);
    }
    for i in 0..400 {
        let mut f = valid.clone();
        for _ in 0..1 + i % 3 {
            let at = rng.below(f.len());
            f[at] = rng.next() as u8;
        }
        try_frame(&mut sh, &mut before, &f);
    }
    assert!(refused > 500, "{refused} refused, {accepted} accepted");
    // Whatever happened, a full load recovers.
    load(&mut sh, &sim.g);
    let (_, want) = held(&sim);
    assert_eq!(export(&mut sh), want);
}

// --- the checks claim: a store that grows keeps its cache -----------------------------------

/// Sync, check, compare with a fresh full load; return the rule ids standing.
fn step_check(inc: &mut Shell, sim: &Sim, seen: &mut usize) -> Vec<String> {
    assert!(sync_reply(inc, &sim.g, *seen).is_empty());
    *seen = sim.g.log().len();
    let got = checks(inc);
    let mut fresh = Shell::new();
    load(&mut fresh, &sim.g);
    assert_eq!(
        got,
        checks(&mut fresh),
        "incremental differs from a full load"
    );
    finding_rows(&got).iter().map(|r| r[0].clone()).collect()
}

fn two_switches(sim: &mut Sim) -> Vec<NodeId> {
    let mut ports = Vec::new();
    sim.batch("lab", |s| {
        for name in ["sw-a", "sw-b"] {
            let d = s.node(NodeKind::Device).unwrap();
            s.set(ElementId::Node(d), "Device", "hostname", name);
            let c = s.node(NodeKind::Chassis).unwrap();
            s.edge(EdgeKind::HasChassis, d, c);
            for i in 0..3 {
                let p = s.node(NodeKind::PhysicalPort).unwrap();
                s.edge(EdgeKind::HasPort, c, p);
                s.set(
                    ElementId::Node(p),
                    "PhysicalPort",
                    "label",
                    &format!("ge-0/0/{i}"),
                );
                s.set(ElementId::Node(p), "PhysicalPort", "connector", "rj45");
                s.set(ElementId::Node(p), "PhysicalPort", "service", "ethernet");
                ports.push(p);
            }
        }
    });
    ports
}

fn cable(sim: &mut Sim, a: NodeId, b: NodeId) -> (NodeId, Vec<fathom_graph::EdgeId>) {
    let mut out = None;
    sim.batch("cable", |s| {
        let c = s.node(NodeKind::Cable).unwrap();
        s.set(ElementId::Node(c), "Cable", "media", "cat6");
        let mut es = Vec::new();
        for (end, p) in [("a", a), ("b", b)] {
            let e = s.edge(EdgeKind::Terminates, c, p).unwrap();
            s.set(ElementId::Edge(e), "Terminates", "end", end);
            es.push(e);
        }
        out = Some((c, es));
    });
    out.unwrap()
}

fn tombstone(sim: &mut Sim, els: &[ElementId]) {
    sim.batch("remove", |s| {
        for el in els {
            let at = s.at();
            s.g.tombstone(*el, at, Actor::User(UserId::LOCAL)).unwrap();
        }
    });
}

fn revive(sim: &mut Sim, els: &[ElementId]) {
    sim.batch("undo", |s| {
        for el in els {
            let at = s.at();
            s.g.revive(*el, at, Actor::User(UserId::LOCAL)).unwrap();
        }
    });
}

const ALREADY: &str = "phy.port.already-cabled";

#[test]
fn a_tombstone_leaves_no_stale_finding_and_a_revive_brings_it_back() {
    let mut sim = Sim::new(100);
    let ports = two_switches(&mut sim);
    let (_, _) = cable(&mut sim, ports[0], ports[3]);
    let mut inc = Shell::new();
    load(&mut inc, &sim.g);
    let instance = inc.estate_for_test().unwrap().instance();
    let mut seen = sim.g.log().len();
    assert!(!step_check(&mut inc, &sim, &mut seen).contains(&ALREADY.to_owned()));

    // A second cable on port 0 stands as a finding.
    let (c2, e2) = cable(&mut sim, ports[0], ports[4]);
    assert!(step_check(&mut inc, &sim, &mut seen).contains(&ALREADY.to_owned()));

    // Remove it the way the page does (the cable and its two ends): the finding is gone.
    let mut els = vec![ElementId::Node(c2)];
    els.extend(e2.iter().map(|e| ElementId::Edge(*e)));
    tombstone(&mut sim, &els);
    assert!(!step_check(&mut inc, &sim, &mut seen).contains(&ALREADY.to_owned()));

    // And an undo brings back the same finding.
    revive(&mut sim, &els);
    assert!(step_check(&mut inc, &sim, &mut seen).contains(&ALREADY.to_owned()));

    // Only the end edge cut: a cable that no longer lands on port 0.
    tombstone(&mut sim, &[ElementId::Edge(e2[0])]);
    assert!(!step_check(&mut inc, &sim, &mut seen).contains(&ALREADY.to_owned()));
    revive(&mut sim, &[ElementId::Edge(e2[0])]);
    assert!(step_check(&mut inc, &sim, &mut seen).contains(&ALREADY.to_owned()));

    // The whole device (and with it its ports and their cables' ends) goes.
    let dev = sim
        .g
        .nodes_of_kind(NodeKind::Device)
        .find(|d| d.absent_since.is_none())
        .unwrap()
        .id;
    tombstone(&mut sim, &[ElementId::Node(dev)]);
    let standing = step_check(&mut inc, &sim, &mut seen);
    assert!(
        !standing.contains(&ALREADY.to_owned()),
        "a finding survived its device's tombstone: {standing:?}"
    );
    revive(&mut sim, &[ElementId::Node(dev)]);
    step_check(&mut inc, &sim, &mut seen);

    assert_eq!(inc.estate_for_test().unwrap().instance(), instance);
}

#[test]
fn only_the_rules_a_batch_touched_run_again() {
    let mut sim = Sim::new(101);
    let ports = two_switches(&mut sim);
    cable(&mut sim, ports[0], ports[3]);
    let mut inc = Shell::new();
    load(&mut inc, &sim.g);
    let mut seen = sim.g.log().len();
    let rules = fathom_wasm::checks::RULES;
    let idx = |id: &str| rules.iter().position(|(r, _)| *r == id).unwrap();

    step_check(&mut inc, &sim, &mut seen);
    assert_eq!(
        inc.checks_last_run_for_test().len(),
        rules.len(),
        "first run: all"
    );

    // A hostname is read by no rule.
    let dev = sim.g.nodes_of_kind(NodeKind::Device).next().unwrap().id;
    sim.batch("rename", |s| {
        s.set(ElementId::Node(dev), "Device", "hostname", "renamed")
    });
    step_check(&mut inc, &sim, &mut seen);
    assert!(
        inc.checks_last_run_for_test().is_empty(),
        "nothing reads a hostname, yet {:?} ran",
        inc.checks_last_run_for_test()
    );

    // Nothing new at all: nothing runs.
    step_check(&mut inc, &sim, &mut seen);
    assert!(inc.checks_last_run_for_test().is_empty());

    // A cable touches cable rules, and not the address rules.
    cable(&mut sim, ports[1], ports[4]);
    step_check(&mut inc, &sim, &mut seen);
    let ran = inc.checks_last_run_for_test();
    assert!(ran.contains(&idx(ALREADY)));
    assert!(
        !ran.contains(&idx("ip.address.network-or-broadcast")),
        "{ran:?}"
    );
    assert!(ran.len() < rules.len());
}
