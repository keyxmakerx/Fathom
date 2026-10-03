//! Differential test for `OP_SYNC`: a module kept in step by deltas must answer `OP_CHECKS`
//! byte for byte as a fresh module that loads the same design whole. The full load is the
//! oracle, and stays the fallback.
//!
//! A seeded writer (`sim`) grows a realistic estate through the real write path, including
//! re-parents, ids ordered before the rest, and revives of cut owner edges: histories the write
//! path takes and `OP_LOAD_PLAIN` may refuse. After every sync the incremental module is
//! compared with a fresh one: the checks reply and the exported design (every fourth step), which
//! must be exactly the writer's plain face, so it reloads. A delta the loader would refuse must be
//! refused, and a delta it would take must be taken.

#![allow(dead_code)]

use std::collections::BTreeMap;

use fathom_wasm::protocol::decode_reply;
use fathom_wasm::shell::Shell;
use fathom_wasm::{OP_EXPORT_PLAIN, OP_LOAD_PLAIN};

mod sim;
use sim::{checks, finding_rows, is_error, load, sync_reply, sync_took, Rng, Sim};

fn run(seed: u64, steps: usize, stats: &mut BTreeMap<&'static str, usize>) {
    let mut sim = Sim::new(seed);
    // A starting estate, loaded whole, as a design opened from the server.
    for _ in 0..6 {
        sim.step();
    }
    sim.wild = true;
    let mut inc = Shell::new();
    load(&mut inc, &sim.g);
    let instance = inc.estate_for_test().unwrap().instance();
    let rules = fathom_wasm::checks::RULES.len();
    let mut seen = sim.g.log().len();
    // The last design a full load took: where the writer goes back to when the loader refuses one.
    let mut good = fathom_workspace::write_plain(&sim.g).unwrap();
    let mut rng = Rng(seed ^ 0xDEAD);
    let mut max_rows = 0;
    for step in 0..steps {
        sim.step();
        // Sometimes let several batches pile up before syncing, as a debounce does.
        if rng.chance(30) && step + 1 < steps {
            continue;
        }
        let reply = sync_reply(&mut inc, &sim.g, seen);
        let plain = fathom_workspace::write_plain(&sim.g).unwrap();
        let mut fresh = Shell::new();
        let loadable = !is_error(&fresh.handle(OP_LOAD_PLAIN, &plain));
        let took = sync_took(&reply, &sim.g);
        if !loadable {
            assert!(
                !took,
                "seed {seed} step {step}: sync took a design the loader refuses: {:?}",
                decode_reply(&reply)
            );
            assert_eq!(
                inc.handle(OP_EXPORT_PLAIN, &[]),
                good,
                "seed {seed} step {step}: a refusal changed the module"
            );
            *stats.entry("refused_unloadable").or_default() += 1;
            sim.g = fathom_workspace::read_plain(&good).unwrap();
            seen = sim.g.log().len();
            continue;
        }
        assert!(
            took,
            "seed {seed} step {step}: a design the loader takes must sync, got {:?}",
            decode_reply(&reply)
        );
        // What the module holds is the writer's design, so it reloads (every fourth: it is dear).
        if step % 4 == 0 {
            assert_eq!(
                inc.handle(OP_EXPORT_PLAIN, &[]),
                plain,
                "seed {seed} step {step}: the held design differs from the full load"
            );
        }
        good = plain;
        seen = sim.g.log().len();
        let got = checks(&mut inc);
        // The store grew in place, so the cache was kept and only touched rules ran again.
        assert_eq!(inc.estate_for_test().unwrap().instance(), instance);
        let ran = inc.checks_last_run_for_test().len();
        *stats.entry("rules_run").or_default() += ran;
        *stats.entry("rules_possible").or_default() += rules;

        let want = checks(&mut fresh);
        assert_eq!(
            got, want,
            "seed {seed} step {step}: incremental checks differ from a full load"
        );
        max_rows = max_rows.max(finding_rows(&got).len());
        *stats.entry("syncs").or_default() += 1;
        *stats.entry("findings_seen").or_default() += finding_rows(&got).len();
    }
    *stats.entry("seeds").or_default() += 1;
    *stats.entry("max_findings_at_once").or_default() =
        (*stats.get("max_findings_at_once").unwrap_or(&0)).max(max_rows);
}

#[test]
fn incremental_checks_equal_a_full_load_over_random_edit_sequences() {
    // 40 seeds of 200 steps, spread over the cores (each seed owns its modules).
    let seeds: Vec<u64> = (1..=40).collect();
    let workers = std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .min(8);
    let stats = std::sync::Mutex::new(BTreeMap::new());
    std::thread::scope(|s| {
        for w in 0..workers {
            let (seeds, stats) = (&seeds, &stats);
            s.spawn(move || {
                let mut mine = BTreeMap::new();
                for seed in seeds.iter().skip(w).step_by(workers) {
                    run(*seed, 200, &mut mine);
                }
                let mut all = stats.lock().unwrap();
                for (k, v) in mine {
                    let e = all.entry(k).or_insert(0);
                    *e = if k == "max_findings_at_once" {
                        (*e).max(v)
                    } else {
                        *e + v
                    };
                }
            });
        }
    });
    let stats = stats.into_inner().unwrap();
    eprintln!("sync_diff: {stats:?}");
    assert_eq!(stats["seeds"], 40);
    assert!(
        stats["rules_run"] < stats["rules_possible"],
        "checks must be incremental: {stats:?}"
    );
    assert!(
        stats["refused_unloadable"] > 0,
        "the generator must make designs the loader refuses: {stats:?}"
    );
    assert!(
        stats["findings_seen"] > 500,
        "the generator must actually produce findings: {stats:?}"
    );
}
