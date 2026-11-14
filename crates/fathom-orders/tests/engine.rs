//! The order engine on the starters: jobs move as ADR-0084 says, people are
//! checked, holds follow the order, and a history replays to the same state.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use fathom_orders::engine::{
    Action, Actor, Event, JobStatus, Order, OrderStatus, People, Ref, StageStatus, Value,
};
use fathom_orders::{read_definition, read_field_set, Definition};

fn orders_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../corpus/orders")
}

fn starter(name: &str) -> Definition {
    let set =
        std::fs::read_to_string(orders_dir().join("field-sets/customer-details.yaml")).unwrap();
    let lib = vec![read_field_set(&set).unwrap()];
    let src = std::fs::read_to_string(orders_dir().join(name)).unwrap();
    let def = read_definition(&src, &lib).unwrap();
    // Install with each slug mapped to "team:<slug>".
    let map: BTreeMap<String, String> = def
        .team_slugs()
        .into_iter()
        .map(|s| (s.to_owned(), format!("team:{s}")))
        .collect();
    def.installed(&map).unwrap()
}

/// Who's who in these tests: `<name>@<slug>` is on team `team:<slug>`;
/// `lead@<slug>` is its lead and holds approve_plans; `steward` is a Steward.
struct Org;

impl People for Org {
    fn on_team(&self, account: &str, team: &str) -> bool {
        account
            .split_once('@')
            .is_some_and(|(_, slug)| team == format!("team:{slug}"))
    }
    fn has_power(&self, account: &str, team: &str, power: &str) -> bool {
        power == "approve_plans" && account.starts_with("lead@") && self.on_team(account, team)
    }
    fn has_role(&self, account: &str, team: &str, role: &str) -> bool {
        role == "lead" && account.starts_with("lead@") && self.on_team(account, team)
    }
    fn is_steward(&self, account: &str) -> bool {
        account == "steward"
    }
}

fn text(s: &str) -> Value {
    Value::Text(s.to_owned())
}

fn customer() -> Vec<(String, Value)> {
    vec![
        ("customer".into(), text("Riverside Council")),
        ("contact_name".into(), text("J. Okafor")),
    ]
}

fn dia_answers(bandwidth: &str) -> Vec<(String, Value)> {
    let mut a = customer();
    a.push(("site".into(), text("site:riverside")));
    a.push(("bandwidth".into(), text(bandwidth)));
    a
}

struct Run {
    order: Order,
    at: u64,
}

impl Run {
    fn new(def: Definition, by: &str, answers: Vec<(String, Value)>) -> Run {
        Run {
            order: Order::open(def, by, 1000, answers).expect("opens"),
            at: 1000,
        }
    }
    fn try_do(&mut self, by: &str, action: Action) -> Result<(), String> {
        self.at += 60;
        let by = if by == "engine" {
            Actor::Engine
        } else {
            Actor::Person(by.to_owned())
        };
        self.order
            .apply(
                Event {
                    at: self.at,
                    by,
                    action,
                },
                &Org,
            )
            .map_err(|r| r.0)
    }
    fn act(&mut self, by: &str, action: Action) {
        if let Err(e) = self.try_do(by, action.clone()) {
            panic!("{by} {action:?}: {e}");
        }
    }
    fn refused(&mut self, by: &str, action: Action) -> String {
        let before = self.order.events().len();
        let e = self.try_do(by, action).expect_err("should be refused");
        assert_eq!(
            self.order.events().len(),
            before,
            "a refusal changes nothing"
        );
        e
    }
    fn status(&self, job: &str) -> JobStatus {
        self.order.job(job).unwrap().status
    }
    fn tick_all(&mut self, by: &str, job: &str) {
        let n = self
            .order
            .definition()
            .jobs()
            .find(|j| j.id == job)
            .unwrap()
            .steps
            .len();
        for step in 0..n {
            self.act(
                by,
                Action::Tick {
                    job: job.into(),
                    step,
                    done: true,
                },
            );
        }
    }
    fn finish(&mut self, by: &str, job: &str) {
        self.tick_all(by, job);
        self.act(by, Action::Finish { job: job.into() });
    }
    fn plan_recorded(&mut self, by: &str, job: &str) {
        self.tick_all(by, job);
        self.act(
            by,
            Action::LinkPlan {
                job: job.into(),
                design: "design:edge".into(),
                plan: format!("plan:{job}"),
            },
        );
        self.act("engine", Action::Finish { job: job.into() });
    }
}

fn port(p: &str) -> Value {
    Value::Ref(Ref {
        design: "design:edge".into(),
        device: "device:pe1".into(),
        port: Some(p.into()),
    })
}

#[test]
fn dia_runs_end_to_end() {
    let mut r = Run::new(starter("dia.yaml"), "ana@order-desk", dia_answers("10G"));
    assert_eq!(r.status("check"), JobStatus::Ready);
    assert_eq!(r.status("addresses"), JobStatus::NotStarted);
    r.act(
        "ana@order-desk",
        Action::PickUp {
            job: "check".into(),
        },
    );
    r.finish("ana@order-desk", "check");

    // Design: both jobs side by side; the port job is in, since 10G.
    assert_eq!(r.status("addresses"), JobStatus::Ready);
    assert_eq!(r.status("port"), JobStatus::Ready);
    r.act(
        "bo@network-design",
        Action::Answer {
            field: "edge_port".into(),
            value: Some(port("Et49")),
            reason: None,
        },
    );
    r.finish("bo@network-design", "port");
    r.finish("cy@ip-design", "addresses");
    assert_eq!(
        r.order.stage("design").unwrap().status,
        StageStatus::AwaitingSignOff
    );
    assert_eq!(
        r.status("configure"),
        JobStatus::NotStarted,
        "waits for the sign-off"
    );

    // The sign-off: not by whoever worked on it, not without the power.
    let e = r.refused(
        "lead@network-design",
        Action::Approve {
            stage: "order".into(),
        },
    );
    assert!(e.contains("doesn't ask for a sign-off"), "{e}");
    let e = r.refused(
        "dee@network-design",
        Action::Approve {
            stage: "design".into(),
        },
    );
    assert!(e.contains("approve_plans"), "{e}");
    r.act(
        "lead@ip-design",
        Action::Approve {
            stage: "design".into(),
        },
    );
    assert_eq!(r.status("configure"), JobStatus::Ready);

    // Provisioning opens a plan; a person can't mark it done by hand.
    let e = r.refused(
        "eve@provisioning",
        Action::Finish {
            job: "configure".into(),
        },
    );
    assert!(e.contains("when its plan is recorded"), "{e}");
    r.plan_recorded("eve@provisioning", "configure");
    r.finish("fin@field", "handoff");
    assert_eq!(r.order.status(), OrderStatus::Done);
    assert!(r.order.holds().is_empty(), "a closed order holds nothing");
}

#[test]
fn a_job_left_out_by_when_counts_as_met() {
    let mut r = Run::new(starter("dia.yaml"), "ana@order-desk", dia_answers("100M"));
    r.finish("ana@order-desk", "check");
    assert_eq!(r.status("port"), JobStatus::LeftOut);
    r.finish("cy@ip-design", "addresses");
    r.act(
        "lead@ip-design",
        Action::Approve {
            stage: "design".into(),
        },
    );
    assert_eq!(
        r.status("configure"),
        JobStatus::Ready,
        "needs [addresses, port] is met"
    );
}

#[test]
fn the_edge_port_is_held_from_design_until_the_order_closes() {
    let mut r = Run::new(starter("dia.yaml"), "ana@order-desk", dia_answers("1G"));
    assert!(r.order.holds().is_empty());
    r.finish("ana@order-desk", "check");
    r.act(
        "bo@network-design",
        Action::Answer {
            field: "edge_port".into(),
            value: Some(port("Et50")),
            reason: None,
        },
    );
    let held = r.order.holds();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].what.port.as_deref(), Some("Et50"));
    r.finish("bo@network-design", "port");
    r.finish("cy@ip-design", "addresses");
    r.act(
        "lead@ip-design",
        Action::Approve {
            stage: "design".into(),
        },
    );
    assert_eq!(r.order.holds().len(), 1, "still held through Provisioning");
    r.act(
        "lead@provisioning",
        Action::CancelOrder {
            reason: "Customer withdrew".into(),
        },
    );
    assert_eq!(r.order.status(), OrderStatus::Cancelled);
    assert!(r.order.holds().is_empty());
}

#[test]
fn installation_sends_the_order_back_to_design() {
    let mut r = Run::new(starter("dia.yaml"), "ana@order-desk", dia_answers("10G"));
    r.finish("ana@order-desk", "check");
    r.act(
        "bo@network-design",
        Action::Answer {
            field: "edge_port".into(),
            value: Some(port("Et49")),
            reason: None,
        },
    );
    r.finish("bo@network-design", "port");
    r.finish("cy@ip-design", "addresses");
    r.act(
        "lead@ip-design",
        Action::Approve {
            stage: "design".into(),
        },
    );
    r.plan_recorded("eve@provisioning", "configure");
    assert_eq!(r.status("handoff"), JobStatus::Ready);

    let e = r.refused(
        "fin@field",
        Action::SendBack {
            job: "handoff".into(),
            reason: " ".into(),
        },
    );
    assert!(e.contains("say why"), "{e}");
    r.act(
        "fin@field",
        Action::SendBack {
            job: "handoff".into(),
            reason: "Port is wrong".into(),
        },
    );
    // Design and everything after it start over; the sign-off is gone.
    assert_eq!(r.status("port"), JobStatus::Ready);
    assert_eq!(r.status("configure"), JobStatus::NotStarted);
    assert_eq!(r.status("handoff"), JobStatus::NotStarted);
    assert_eq!(r.status("check"), JobStatus::Done, "earlier stages stand");
    assert_eq!(r.order.stage("design").unwrap().approved_by, None);
    // The port job finished before, so changing its answer needed a lead; now
    // it's open again, its team may change it freely.
    r.act(
        "bo@network-design",
        Action::Answer {
            field: "edge_port".into(),
            value: Some(port("Et51")),
            reason: None,
        },
    );
}

#[test]
fn site_build_lanes_run_side_by_side_and_join() {
    let mut answers = customer();
    answers.push(("site".into(), text("site:depot")));
    answers.push(("racks".into(), Value::Int(2)));
    answers.push(("ship_to".into(), text("Gate 2, loading bay")));
    let mut r = Run::new(starter("site-build.yaml"), "ana@order-entry", answers);
    assert_eq!(r.status("site-design"), JobStatus::Ready);
    assert_eq!(
        r.status("order-kit"),
        JobStatus::NotStarted,
        "Equipment starts after Design"
    );

    r.plan_recorded("bo@network-design", "site-design");
    r.act(
        "lead@network-design",
        Action::Approve {
            stage: "design".into(),
        },
    );
    // Both lanes now move at once.
    assert_eq!(r.status("room"), JobStatus::Ready);
    assert_eq!(
        r.status("power-work"),
        JobStatus::LeftOut,
        "no power work asked"
    );
    assert_eq!(r.status("order-kit"), JobStatus::Ready);

    r.finish("cal@construction", "room");
    assert_eq!(
        r.status("rack"),
        JobStatus::Waiting,
        "waits for the equipment"
    );
    r.finish("ana@order-entry", "order-kit");
    r.act(
        "sam@order-management",
        Action::Answer {
            field: "tracking".into(),
            value: Some(text("1Z999")),
            reason: None,
        },
    );
    r.finish("sam@order-management", "ship-it");
    r.finish("fin@field", "on-site");
    assert_eq!(r.status("rack"), JobStatus::Ready, "the join is met");
    r.plan_recorded("fin@field", "rack");
    assert_eq!(r.order.status(), OrderStatus::Done);
}

#[test]
fn who_may_do_what() {
    let mut r = Run::new(starter("dia.yaml"), "ana@order-desk", dia_answers("10G"));
    let e = r.refused(
        "bo@network-design",
        Action::PickUp {
            job: "check".into(),
        },
    );
    assert!(e.contains("team"), "{e}");
    let e = r.refused("ana@order-desk", Action::PickUp { job: "port".into() });
    assert!(e.contains("hasn't started"), "{e}");
    let e = r.refused(
        "engine",
        Action::Tick {
            job: "check".into(),
            step: 0,
            done: true,
        },
    );
    assert!(e.contains("person"), "{e}");
    let e = r.refused(
        "ana@order-desk",
        Action::Tick {
            job: "check".into(),
            step: 9,
            done: true,
        },
    );
    assert!(e.contains("no step 10"), "{e}");
    let e = r.refused(
        "ana@order-desk",
        Action::Finish {
            job: "check".into(),
        },
    );
    assert!(e.contains("0 of 3 steps"), "{e}");
    let e = r.refused("engine", Action::CancelOrder { reason: "x".into() });
    assert!(e.contains("never cancels"), "{e}");
    let e = r.refused("ana@order-desk", Action::CancelOrder { reason: "x".into() });
    assert!(e.contains("lead"), "{e}");
    let e = r.refused(
        "ana@order-desk",
        Action::Cancel {
            job: "check".into(),
            reason: "x".into(),
        },
    );
    assert!(e.contains("isn't optional"), "{e}");
}

#[test]
fn whoever_opened_or_worked_never_signs_off() {
    // The opener is a lead with the power on the design team.
    let mut r = Run::new(starter("dia.yaml"), "lead@ip-design", dia_answers("100M"));
    r.finish("steward", "check");
    r.act(
        "lead@ip-design",
        Action::PickUp {
            job: "addresses".into(),
        },
    );
    r.finish("lead@ip-design", "addresses");
    let e = r.refused(
        "lead@ip-design",
        Action::Approve {
            stage: "design".into(),
        },
    );
    assert!(e.contains("opened the order"), "{e}");
    r.act(
        "steward",
        Action::Approve {
            stage: "design".into(),
        },
    );
}

#[test]
fn answers_after_their_job_is_done_need_a_lead_and_a_reason() {
    let mut r = Run::new(starter("dia.yaml"), "ana@order-desk", dia_answers("10G"));
    // Asked at open, owned by the first stage: its team and the opener may change it.
    r.act(
        "ana@order-desk",
        Action::Answer {
            field: "customer".into(),
            value: Some(text("Riverside District Council")),
            reason: None,
        },
    );
    let e = r.refused(
        "ana@order-desk",
        Action::Answer {
            field: "customer".into(),
            value: None,
            reason: None,
        },
    );
    assert!(e.contains("required"), "{e}");
    let e = r.refused(
        "ana@order-desk",
        Action::Answer {
            field: "bandwidth".into(),
            value: Some(text("40G")),
            reason: None,
        },
    );
    assert!(e.contains("choices"), "{e}");
    r.finish("ana@order-desk", "check");
    let change = |reason: Option<&str>| Action::Answer {
        field: "customer".into(),
        value: Some(text("RDC")),
        reason: reason.map(str::to_owned),
    };
    let e = r.refused("ana@order-desk", change(None));
    assert!(e.contains("only a lead"), "{e}");
    let e = r.refused("lead@order-desk", change(None));
    assert!(e.contains("say why"), "{e}");
    r.act("lead@order-desk", change(Some("Renamed by the customer")));
    assert_eq!(r.order.answer("customer"), Some(&text("RDC")));
}

#[test]
fn opening_checks_the_answers() {
    let def = starter("dia.yaml");
    let e = Order::open(def.clone(), "ana@order-desk", 1, customer()).unwrap_err();
    assert!(e.0.contains("required"), "{e}");
    let mut a = dia_answers("10G");
    a.push(("edge_port".into(), text("Et49")));
    let e = Order::open(def.clone(), "ana@order-desk", 1, a).unwrap_err();
    assert!(e.0.contains("a port on a device"), "{e}");
    let mut a = dia_answers("10G");
    a.push(("customer".into(), text("twice")));
    let e = Order::open(def, "ana@order-desk", 1, a).unwrap_err();
    assert!(e.0.contains("twice"), "{e}");
}

#[test]
fn an_optional_job_is_cancelled_by_its_team_and_counts_as_met() {
    let mut answers = customer();
    answers.push(("site".into(), text("site:depot")));
    answers.push(("circuit".into(), text("C-1")));
    answers.push(("last_day".into(), Value::Date("2026-12-01".into())));
    answers.push(("kit_back".into(), Value::Bool(true)));
    let mut r = Run::new(starter("service-removal.yaml"), "ana@order-desk", answers);
    r.finish("ana@order-desk", "confirm");
    r.plan_recorded("eve@provisioning", "unconfigure");
    r.finish("cy@ip-design", "release");
    r.act(
        "lead@provisioning",
        Action::Approve {
            stage: "deprovision".into(),
        },
    );
    assert_eq!(r.status("collect"), JobStatus::Ready);
    r.act(
        "fin@field",
        Action::Cancel {
            job: "collect".into(),
            reason: "Customer keeps the router".into(),
        },
    );
    assert_eq!(r.order.status(), OrderStatus::Done);
}

#[test]
fn time_only_moves_forward_and_a_closed_order_takes_nothing() {
    let mut r = Run::new(starter("dia.yaml"), "ana@order-desk", dia_answers("100M"));
    let e = r
        .order
        .apply(
            Event {
                at: 10,
                by: Actor::Person("ana@order-desk".into()),
                action: Action::PickUp {
                    job: "check".into(),
                },
            },
            &Org,
        )
        .unwrap_err();
    assert!(e.0.contains("earlier"), "{e}");
    r.act(
        "steward",
        Action::CancelOrder {
            reason: "Test".into(),
        },
    );
    let e = r.refused(
        "ana@order-desk",
        Action::PickUp {
            job: "check".into(),
        },
    );
    assert!(e.contains("closed"), "{e}");
}

#[test]
fn a_history_replays_to_the_same_order() {
    let mut r = Run::new(starter("dia.yaml"), "ana@order-desk", dia_answers("10G"));
    r.finish("ana@order-desk", "check");
    r.act(
        "bo@network-design",
        Action::Answer {
            field: "edge_port".into(),
            value: Some(port("Et49")),
            reason: None,
        },
    );
    r.finish("bo@network-design", "port");
    let again = Order::replay(starter("dia.yaml"), r.order.events()).expect("replays");
    for job in r.order.definition().jobs() {
        assert_eq!(again.job(&job.id), r.order.job(&job.id), "{}", job.id);
    }
    assert_eq!(again.holds(), r.order.holds());
    assert_eq!(again.events(), r.order.events());

    // A history that no longer fits is refused, not shown wrong.
    let mut events = r.order.events().to_vec();
    events.swap(1, 2);
    assert!(Order::replay(starter("dia.yaml"), &events).is_err());
}

#[test]
fn ready_jobs_are_each_teams_queue() {
    let r = Run::new(starter("dia.yaml"), "ana@order-desk", dia_answers("10G"));
    let ids: BTreeSet<&str> = r.order.ready_jobs().iter().map(|j| j.id.as_str()).collect();
    assert_eq!(ids, BTreeSet::from(["check"]));
}

// ---- The overdue clock (decision 11, piece 3) ---------------------------------------------

const DAY: u64 = 86_400;

fn overdue(job: &str, rule: usize) -> Action {
    Action::Overdue {
        job: job.into(),
        rule,
    }
}

impl Run {
    /// Sets the clock to `at` and carries out every overdue rule due by then, as the server does.
    fn clock(&mut self, at: u64) -> Vec<(String, usize)> {
        let mut fired = Vec::new();
        self.at = self.at.max(at);
        while let Some((job, rule, when)) = self.order.overdue_due(self.at).into_iter().next() {
            let last = self.order.events().last().map_or(0, |e| e.at);
            self.order
                .apply(
                    Event {
                        at: when.max(last),
                        by: Actor::Engine,
                        action: overdue(&job, rule),
                    },
                    &Org,
                )
                .unwrap_or_else(|r| panic!("{job} rule {rule}: {}", r.0));
            fired.push((job, rule));
        }
        fired
    }
}

#[test]
fn an_overdue_job_is_escalated_then_handed_back_to_its_team() {
    let mut run = Run::new(starter("dia.yaml"), "opener@sales", dia_answers("10G"));
    // Check the order is ready from 1000 and due a day later.
    let check = run
        .order
        .definition()
        .jobs()
        .find(|j| j.id == "check")
        .unwrap()
        .clone();
    assert_eq!(run.order.due_at(&check), Some(1000 + DAY));
    run.act(
        "ann@order-desk",
        Action::PickUp {
            job: "check".into(),
        },
    );

    // Before it's due, nothing is listed, and the engine can't jump the gun.
    assert!(run.order.overdue_due(1000 + DAY - 1).is_empty());
    assert!(run
        .refused("engine", overdue("check", 0))
        .contains("hasn't come"));

    // A person never carries out a rule.
    run.at = 1000 + DAY;
    assert!(run
        .refused("lead@order-desk", overdue("check", 0))
        .contains("only the engine"));

    // Due passes: `after: 0d, escalate: lead`. Ann keeps it.
    assert_eq!(run.clock(1000 + DAY), vec![("check".to_owned(), 0)]);
    let st = run.order.job("check").unwrap();
    assert_eq!(st.escalated.as_deref(), Some("lead"));
    assert_eq!(st.picked_by.as_deref(), Some("ann@order-desk"));

    // Two days later: `reassign: team` takes it off Ann and back to the queue.
    assert_eq!(run.clock(1000 + 3 * DAY), vec![("check".to_owned(), 1)]);
    let st = run.order.job("check").unwrap();
    assert_eq!(st.picked_by, None);
    assert_eq!(run.status("check"), JobStatus::Ready);
    // Every rule fires once.
    assert!(run.clock(1000 + 30 * DAY).is_empty());
    assert!(run
        .refused("engine", overdue("check", 1))
        .contains("already"));

    // The moves are the engine's in the history, at the time each fell due.
    let moves: Vec<(u64, &Actor)> = run
        .order
        .events()
        .iter()
        .filter(|e| matches!(e.action, Action::Overdue { .. }))
        .map(|e| (e.at, &e.by))
        .collect();
    assert_eq!(
        moves,
        vec![
            (1000 + DAY, &Actor::Engine),
            (1000 + 3 * DAY, &Actor::Engine)
        ]
    );

    // And a history with them replays to the same order.
    let again = Order::replay(run.order.definition().clone(), run.order.events()).unwrap();
    assert_eq!(again.job("check"), run.order.job("check"));
}

#[test]
fn a_server_that_was_down_fires_each_rule_once_in_order() {
    let mut run = Run::new(starter("dia.yaml"), "opener@sales", dia_answers("10G"));
    // Nobody looked for a week: both rules fire, the earlier first.
    assert_eq!(
        run.clock(1000 + 7 * DAY),
        vec![("check".to_owned(), 0), ("check".to_owned(), 1)]
    );
    // Rules go in order: the second is refused while the first hasn't fired.
    let mut fresh = Run::new(starter("dia.yaml"), "opener@sales", dia_answers("10G"));
    fresh.at = 1000 + 7 * DAY;
    assert!(fresh
        .refused("engine", overdue("check", 1))
        .contains("in order"));
}

#[test]
fn a_finished_job_is_never_overdue() {
    let mut run = Run::new(starter("dia.yaml"), "opener@sales", dia_answers("1G"));
    run.finish("ann@order-desk", "check");
    assert!(
        run.clock(1000 + 30 * DAY).is_empty(),
        "a done job is never overdue"
    );
}

#[test]
fn move_on_skips_an_optional_job_and_its_stage_carries_on() {
    let mut run = Run::new(
        starter("service-removal.yaml"),
        "opener@sales",
        vec![
            ("customer".into(), text("Harbour Clinic")),
            ("contact_name".into(), text("J. Okafor")),
            ("site".into(), text("site:harbour")),
            ("circuit".into(), text("C-1")),
            ("last_day".into(), Value::Date("2026-12-01".into())),
            ("kit_back".into(), Value::Bool(true)),
        ],
    );
    run.finish("ann@order-desk", "confirm");
    run.plan_recorded("pat@provisioning", "unconfigure");
    run.finish("ian@ip-design", "release");
    run.act(
        "lead@provisioning",
        Action::Approve {
            stage: "deprovision".into(),
        },
    );
    assert_eq!(run.status("collect"), JobStatus::Ready);
    let ready = run.order.job("collect").unwrap().ready_at.unwrap();

    // Due in 10 days: escalated then, moved on five days after.
    assert_eq!(run.clock(ready + 10 * DAY), vec![("collect".to_owned(), 0)]);
    assert_eq!(run.clock(ready + 15 * DAY), vec![("collect".to_owned(), 1)]);
    assert_eq!(run.status("collect"), JobStatus::Skipped);
    assert_eq!(
        run.order.job("collect").unwrap().finished_by,
        Some(Actor::Engine)
    );
    // The last stage had only that job, so the order is done. The engine never closes an order
    // any other way: it can't cancel one.
    assert_eq!(run.order.status(), OrderStatus::Done);
}

#[test]
fn reassign_to_another_team_moves_who_may_work_on_it() {
    let src = "fathom: order-definition/1\nid: t\nname: T\nnumber: T\nfields:\n  - { key: what, label: What, kind: text }\nstages:\n  - id: s\n    name: S\n    jobs:\n      - id: j\n        name: J\n        team: alpha\n        steps: [One]\n        due: 1h\n        overdue:\n          - { after: 30m, reassign: beta }\n";
    let def = read_definition(src, &[]).expect("reads");
    let map: BTreeMap<String, String> = def
        .team_slugs()
        .into_iter()
        .map(|s| (s.to_owned(), format!("team:{s}")))
        .collect();
    let mut run = Run::new(def.installed(&map).unwrap(), "opener@sales", vec![]);
    run.act("amy@alpha", Action::PickUp { job: "j".into() });
    assert_eq!(run.clock(1000 + 3600 + 1800), vec![("j".to_owned(), 0)]);
    let job = run.order.definition().jobs().next().unwrap().clone();
    assert_eq!(run.order.team_of(&job), "team:beta");
    assert_eq!(run.order.job("j").unwrap().picked_by, None);
    assert!(run
        .refused("amy@alpha", Action::PickUp { job: "j".into() })
        .contains("team"));
    run.act("bob@beta", Action::PickUp { job: "j".into() });
    run.finish("bob@beta", "j");
    assert_eq!(run.order.status(), OrderStatus::Done);
}
