//! The starters under corpus/orders/ read and check, and the check refuses
//! what ADR-0084 says it refuses.

use std::path::PathBuf;

use fathom_orders::{
    read_definition, read_field_set, Compare, Condition, FieldKind, FieldSet, OverdueAction,
};

fn orders_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/orders")
}

fn library() -> Vec<FieldSet> {
    let src =
        std::fs::read_to_string(orders_dir().join("field-sets/customer-details.yaml")).unwrap();
    vec![read_field_set(&src).expect("customer-details reads")]
}

fn starter(name: &str) -> fathom_orders::Definition {
    let src = std::fs::read_to_string(orders_dir().join(name)).unwrap();
    match read_definition(&src, &library()) {
        Ok(d) => d,
        Err(p) => panic!("{name}: {p:?}"),
    }
}

/// The problems for `src`, as one string per problem.
fn refused(src: &str) -> Vec<String> {
    match read_definition(src, &library()) {
        Ok(_) => panic!("expected a refusal"),
        Err(p) => p.into_iter().map(|p| p.to_string()).collect(),
    }
}

fn has(problems: &[String], needle: &str) -> bool {
    problems.iter().any(|p| p.contains(needle))
}

#[test]
fn every_starter_checks_out() {
    let mut n = 0;
    for entry in std::fs::read_dir(orders_dir()).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) == Some("yaml") {
            starter(path.file_name().unwrap().to_str().unwrap());
            n += 1;
        }
    }
    assert!(
        n >= 3,
        "DIA, site build and service removal ship (decision 12)"
    );
}

#[test]
fn dia_is_one_lane_with_the_shared_customer_fields() {
    let d = starter("dia.yaml");
    assert_eq!(d.lanes.len(), 1);
    assert!(d.lanes[0].implicit);
    assert_eq!(d.fields[0].key, "customer");
    assert_eq!(d.fields[0].from_set.as_deref(), Some("customer-details"));
    assert_eq!(d.field_sets.len(), 1);
    assert_eq!(d.field("wan_v4").unwrap().kind, FieldKind::Prefix);
    assert_eq!(
        d.team_slugs(),
        [
            "order-desk",
            "ip-design",
            "network-design",
            "provisioning",
            "field"
        ]
    );
    let port = d.jobs().find(|j| j.id == "port").unwrap();
    assert!(matches!(
        &port.when,
        Some(Condition::Field { field, compare: Compare::In(v) }) if field == "bandwidth" && v.len() == 2
    ));
}

#[test]
fn site_build_runs_two_lanes_joined_by_a_need() {
    let d = starter("site-build.yaml");
    assert_eq!(d.lanes.len(), 2);
    assert_eq!(d.lanes[1].starts_after.as_deref(), Some("design"));
    let rack = d.jobs().find(|j| j.id == "rack").unwrap();
    assert_eq!(rack.needs, ["on-site"]);
    let unknown = d.unmatched_teams(|t| t != "order-entry");
    assert_eq!(unknown, ["order-entry"]);
}

#[test]
fn service_removal_moves_on_an_optional_job() {
    let d = starter("service-removal.yaml");
    let collect = d.jobs().find(|j| j.id == "collect").unwrap();
    assert!(collect.optional);
    assert_eq!(
        collect.overdue.last().unwrap().action,
        OverdueAction::MoveOn
    );
}

const HEAD: &str = "fathom: order-definition/1\nid: t\nname: T\n";

#[test]
fn unknown_keys_are_refused_not_ignored() {
    let p = refused(&format!(
        "{HEAD}stages:\n  - id: a\n    name: A\n    jobs:\n      - {{ id: j, name: J, team: x, neds: [k] }}\n"
    ));
    assert!(has(&p, "unknown key `neds`"), "{p:?}");
}

#[test]
fn a_loop_across_lanes_is_refused() {
    // Equipment starts after Install; Install waits for Equipment's job.
    let src = format!(
        "{HEAD}lanes:
  - id: build
    name: Build
    stages:
      - id: install
        name: Install
        jobs:
          - {{ id: rack, name: Rack, team: field, needs: [ship] }}
  - id: kit
    name: Kit
    starts_after: install
    stages:
      - id: shipping
        name: Shipping
        jobs:
          - {{ id: ship, name: Ship, team: om }}
"
    );
    let p = refused(&src);
    assert!(has(&p, "loop"), "{p:?}");
    assert!(has(&p, "rack") && has(&p, "ship"), "{p:?}");
}

#[test]
fn needing_a_later_stage_in_the_same_lane_is_a_loop() {
    let src = format!(
        "{HEAD}stages:
  - id: a
    name: A
    jobs:
      - {{ id: one, name: One, team: x, needs: [two] }}
  - id: b
    name: B
    jobs:
      - {{ id: two, name: Two, team: x }}
"
    );
    assert!(has(&refused(&src), "loop"));
}

#[test]
fn names_that_resolve_nowhere_are_refused() {
    let src = format!(
        "{HEAD}lanes:
  - id: one
    name: One
    starts_after: nowhere
    stages:
      - id: a
        name: A
        jobs:
          - id: j
            name: J
            team: x
            needs: [ghost]
            send_back: {{ to: a, label: Again }}
            reserves: nope
            asks: [nothing]
"
    );
    let p = refused(&src);
    for needle in [
        "`starts_after` names `nowhere`",
        "`needs` names `ghost`",
        "not an earlier stage",
        "`reserves` names `nope`",
        "`asks` names `nothing`",
    ] {
        assert!(has(&p, needle), "missing {needle}: {p:?}");
    }
}

#[test]
fn starts_after_in_its_own_lane_is_refused() {
    let src = format!(
        "{HEAD}lanes:
  - id: one
    name: One
    starts_after: a
    stages:
      - id: a
        name: A
        jobs:
          - {{ id: j, name: J, team: x }}
"
    );
    assert!(has(&refused(&src), "same lane"));
}

#[test]
fn send_back_stays_in_its_lane() {
    let src = format!(
        "{HEAD}lanes:
  - id: one
    name: One
    stages:
      - id: a
        name: A
        jobs:
          - {{ id: j, name: J, team: x }}
  - id: two
    name: Two
    stages:
      - id: b
        name: B
        jobs:
          - id: k
            name: K
            team: x
            send_back: {{ to: a, label: Back }}
"
    );
    assert!(has(&refused(&src), "another lane"));
}

#[test]
fn move_on_needs_optional_and_no_sign_off() {
    let src = format!(
        "{HEAD}stages:
  - id: a
    name: A
    approval: approve_plans
    jobs:
      - id: j
        name: J
        team: x
        due: 1d
        overdue:
          - {{ after: 1d, move_on: true }}
"
    );
    let p = refused(&src);
    assert!(has(&p, "optional: true"), "{p:?}");
    assert!(has(&p, "sign-off"), "{p:?}");
}

#[test]
fn overdue_needs_due_and_time_order() {
    let src = format!(
        "{HEAD}stages:
  - id: a
    name: A
    jobs:
      - id: j
        name: J
        team: x
        overdue:
          - {{ after: 2d, escalate: lead }}
          - {{ after: 1d, reassign: team }}
"
    );
    let p = refused(&src);
    assert!(has(&p, "needs a `due`"), "{p:?}");
    assert!(has(&p, "time order"), "{p:?}");
}

#[test]
fn approval_names_a_power_not_a_role() {
    let src = format!(
        "{HEAD}stages:\n  - id: a\n    name: A\n    approval: lead\n    jobs:\n      - {{ id: j, name: J, team: x }}\n"
    );
    assert!(has(&refused(&src), "team power"));
}

#[test]
fn field_rules() {
    let src = format!(
        "{HEAD}fields:
  - {{ key: speed, label: Speed, kind: choice, choices: [1G, 10G] }}
  - {{ key: n, label: N, kind: number, min: 5, max: 1 }}
  - {{ key: wan, label: WAN, kind: prefix, family: ipv4, size: 64 }}
  - {{ key: note, label: Note, kind: text, choices: [a] }}
  - {{ key: later, label: Later, kind: text, when: {{ field: after, set: true }} }}
  - {{ key: after, label: After, kind: text }}
  - {{ key: pick, label: Pick, kind: text, when: {{ field: speed, is: 40G }} }}
  - {{ key: big, label: Big, kind: text, when: {{ field: speed, at_least: 3 }} }}
  - {{ key: Bad, label: Bad, kind: colour }}
  - {{ use: no-such-set }}
stages:
  - id: a
    name: A
    jobs:
      - {{ id: j, name: J, team: x }}
"
    );
    let p = refused(&src);
    for needle in [
        "`min` is above `max`",
        "/32 or shorter",
        "`choices` is only for",
        "not a field declared before it",
        "`40G` is not one of",
        "only for number fields",
        "not a usable field key",
        "not a field kind",
        "no shared field set `no-such-set`",
    ] {
        assert!(has(&p, needle), "missing {needle}: {p:?}");
    }
}

#[test]
fn a_carried_set_is_used_before_the_library() {
    let src = format!(
        "{HEAD}field_sets:
  - id: customer-details
    name: Customer details
    fields:
      - {{ key: account, label: Account, kind: text }}
fields:
  - {{ use: customer-details }}
stages:
  - id: a
    name: A
    jobs:
      - {{ id: j, name: J, team: x, asks: [account] }}
"
    );
    let d = read_definition(&src, &library()).expect("reads");
    assert_eq!(d.fields.len(), 1);
    assert_eq!(d.fields[0].key, "account");
}

#[test]
fn a_set_field_clashing_with_the_types_own_is_refused() {
    let src = format!(
        "{HEAD}fields:
  - {{ key: customer, label: Customer, kind: text }}
  - {{ use: customer-details }}
stages:
  - id: a
    name: A
    jobs:
      - {{ id: j, name: J, team: x }}
"
    );
    assert!(has(&refused(&src), "clashes"));
}

#[test]
fn stages_and_lanes_together_are_refused() {
    let src = format!(
        "{HEAD}stages:\n  - id: a\n    name: A\n    jobs:\n      - {{ id: j, name: J, team: x }}\nlanes:\n  - id: l\n    name: L\n    stages:\n      - id: b\n        name: B\n        jobs:\n          - {{ id: k, name: K, team: x }}\n"
    );
    assert!(has(&refused(&src), "not both"));
}

#[test]
fn the_wrong_format_and_yaml_outside_the_subset_are_refused() {
    let p = refused("fathom: order-definition/2\nid: t\nname: T\nstages:\n  - id: a\n    name: A\n    jobs:\n      - { id: j, name: J, team: x }\n");
    assert!(has(&p, "is not `order-definition/1`"), "{p:?}");
    let p = refused("fathom: order-definition/1\nid: &x t\n");
    assert!(!p.is_empty());
}

#[test]
fn holds_names_a_device_or_port_field() {
    let src = format!(
        "{HEAD}fields:
  - {{ key: port, label: Port, kind: port }}
  - {{ key: note, label: Note, kind: text }}
stages:
  - id: a
    name: A
    jobs:
      - {{ id: j, name: J, team: x, holds: [port, note, ghost, port] }}
"
    );
    let p = refused(&src);
    for needle in [
        "`holds` names `note`, which is not a device or port field",
        "`holds` names `ghost`, which is not a field",
        "`holds` names `port` twice",
    ] {
        assert!(has(&p, needle), "missing {needle}: {p:?}");
    }
}

#[test]
fn dia_holds_its_edge_port() {
    let d = starter("dia.yaml");
    let port = d.jobs().find(|j| j.id == "port").unwrap();
    assert_eq!(port.holds, ["edge_port"]);
    assert_eq!(d.field("edge_port").unwrap().kind, FieldKind::Port);
}
