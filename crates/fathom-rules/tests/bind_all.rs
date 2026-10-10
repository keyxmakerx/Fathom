//! The `all: Kind` binding: every live node of a kind, not reached by an edge.

use fathom_rules::engine::Delta;
use fathom_rules::eval::eval_rule;
use fathom_rules::fixture::build;
use fathom_rules::graph::{delta_since, GraphWorld, IrSchema};
use fathom_rules::rule::{load_rule, Rule};
use fathom_schema::subset::{parse_profile, Profile};

fn rule_src(bind: &str, condition: &str) -> String {
    format!(
        "id: test.bind.all\nrule_version: 1.0.0\nstatus: active\nseverity: idea\ncategory: correctness\n\
         title: \"A test\"\nwhy: >\n  A rule written to exercise the all binding of the engine.\n\
         fix: >\n  Nothing.\nconcept: check.test\nacceptable_when: >\n  Always.\n\
         reviewed_by: \"pending: test\"\nreviewed_on: 2026-10-10\nsources_note: >\n  A test.\n\
         applies_to:\n  kind: Device\n  with:\n    targets: {bind}\ncondition: >\n  {condition}\n"
    )
}

fn load(bind: &str, condition: &str) -> Result<Rule, String> {
    load_rule(
        &rule_src(bind, condition),
        "rules/test.bind.all/rule.yaml",
        "test.bind.all",
        &IrSchema,
    )
    .map_err(|e| e.message)
}

const ESTATE: &str = "nodes:
  - { id: d1, kind: Device, set: { hostname: a, platform: eos } }
  - { id: d2, kind: Device, set: { hostname: b, platform: eos } }
  - { id: t1, kind: FirmwareTarget, set: { model: m1, version: \"4.30.2F\" } }
  - { id: t2, kind: FirmwareTarget, set: { model: m2, version: \"4.31.1.1M\" } }
";

fn anchors(rule: &Rule, estate: &str) -> usize {
    let root = parse_profile(estate, Profile::Corpus).unwrap();
    let (g, _) = build(&root).unwrap();
    let (mut out, mut diags) = (Vec::new(), Vec::new());
    eval_rule(rule, 0, &GraphWorld { g: &g }, &mut out, &mut diags);
    assert!(diags.is_empty(), "{:?}", diags);
    out.len()
}

#[test]
fn every_node_of_the_kind_is_bound_to_every_anchor() {
    let r = load("{ all: FirmwareTarget, card: many }", "count(targets) == 2").unwrap();
    assert_eq!(anchors(&r, ESTATE), 2);
    let r = load(
        "{ all: FirmwareTarget, card: many }",
        "targets.exists(t, t.model == \"m2\")",
    )
    .unwrap();
    assert_eq!(anchors(&r, ESTATE), 2);
    // No targets, no match; the anchors are still visited.
    let none = "nodes:\n  - { id: d1, kind: Device, set: { hostname: a, platform: eos } }\n";
    let r = load("{ all: FirmwareTarget, card: many }", "count(targets) == 0").unwrap();
    assert_eq!(anchors(&r, none), 1);
}

#[test]
fn the_kind_population_is_in_the_read_set() {
    let r = load("{ all: FirmwareTarget, card: many }", "count(targets) == 2").unwrap();
    let root = parse_profile(ESTATE, Profile::Corpus).unwrap();
    let (g, _) = build(&root).unwrap();
    // A target appearing touches the rule, though no edge or Device field moved.
    let d = delta_since(&g, 0);
    assert!(d.touches(&r.reads));
    assert!(!Delta::default().touches(&r.reads));
}

#[test]
fn a_malformed_all_binding_is_refused() {
    let e = load("{ all: Nonesuch, card: many }", "count(targets) == 2")
        .err()
        .expect("refused");
    assert!(e.contains("not a kind"), "{e}");
    let e = load("{ all: FirmwareTarget, card: one }", "count(targets) == 2")
        .err()
        .expect("refused");
    assert!(e.contains("card many"), "{e}");
    let e = load(
        "{ all: FirmwareTarget, via: HasChassis, card: many }",
        "count(targets) == 2",
    )
    .err()
    .expect("refused");
    assert!(e.contains("no `via`"), "{e}");
}

#[test]
fn version_older_is_null_not_false_when_it_cannot_say() {
    let bind = "{ all: FirmwareTarget, card: many }";
    // eos 4.30.2F is older than t2's 4.31.1.1M and not older than t1's 4.30.2F.
    let older = "targets.exists(t, version_older(platform, \"4.30.2F\", t.version))";
    assert_eq!(anchors(&load(bind, older).unwrap(), ESTATE), 2);
    let all = "targets.all(t, version_older(platform, \"4.30.2F\", t.version))";
    assert_eq!(anchors(&load(bind, all).unwrap(), ESTATE), 0);
    // An unparsable version is never reported as older.
    let junk = "targets.exists(t, version_older(platform, \"banana\", t.version))";
    assert_eq!(anchors(&load(bind, junk).unwrap(), ESTATE), 0);
    let e = load(bind, "version_older(platform, 3, \"x\")")
        .err()
        .expect("refused");
    assert!(e.contains("three strings"), "{e}");
    let e = load(bind, "version_older(platform, \"x\")")
        .err()
        .expect("refused");
    assert!(e.contains("3 argument"), "{e}");
}
