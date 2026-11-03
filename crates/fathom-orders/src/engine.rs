//! The order engine (ADR-0084 piece 2): one open order, moved by actions.
//!
//! An order is its installed definition plus the list of actions taken on it.
//! Each action is checked against the order as it stands and against who may
//! take it, then applied; a refused action changes nothing. The state is
//! never stored on its own: [`Order::replay`] rebuilds it from the definition
//! and the actions, so the server keeps the actions in the sealed history
//! (decision 10) and nothing else can drift from them.
//!
//! The engine is pure. It reads no clock (each action carries its time), sends
//! nothing, touches no device and changes no design (decision 10). Who is on
//! a team, who holds a power and who is a Steward come from the server through
//! [`People`].
//!
//! How a job moves:
//!
//! ```text
//! NotStarted ─stage starts─▶ Waiting ─needs met─▶ Ready ─Finish─▶ Done
//!     │                                             ├─SendBack─▶ (its lane goes back; jobs reset)
//!     └─`when` false─▶ LeftOut                      └─Cancel──▶ Cancelled
//! ```
//!
//! A stage is done when every job in it is finished (Done, Cancelled or
//! LeftOut) and, if it asks for a sign-off, someone allowed has signed it.
//! The next stage in its lane then starts, as do lanes that start after it.
//! The order is done when every lane's last stage is.

use std::collections::{BTreeMap, BTreeSet};

use crate::{Compare, Condition, Definition, Field, FieldKind, Job, Scalar};

/// A team role id (ADR-0081) used for "a lead of that team".
pub const LEAD: &str = "lead";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/// Something in the drawing a field points at: a device, or one of its ports.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Ref {
    pub design: String,
    pub device: String,
    pub port: Option<String>,
}

/// An answer to one field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// text, long_text, site, team, person, prefix (as typed), and a choice.
    Text(String),
    Int(i64),
    Bool(bool),
    /// `YYYY-MM-DD`.
    Date(String),
    /// Several choices.
    List(Vec<String>),
    /// A device or a port.
    Ref(Ref),
}

// ---------------------------------------------------------------------------
// Actions and who takes them
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Actor {
    /// An account id.
    Person(String),
    /// The server on the order's behalf: a plan was recorded, a clock ran out.
    Engine,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Opens the order with the answers asked when it opens. Always first.
    Open { answers: Vec<(String, Value)> },
    /// Sets or clears one answer. A reason is required once the field's own
    /// job is finished (decision 16).
    Answer {
        field: String,
        value: Option<Value>,
        reason: Option<String>,
    },
    /// A person on the job's team takes it.
    PickUp { job: String },
    /// Ticks or unticks one step (0-based).
    Tick {
        job: String,
        step: usize,
        done: bool,
    },
    /// Ties the plan a `makes: plan` job opened.
    LinkPlan {
        job: String,
        design: String,
        plan: String,
    },
    /// The job is done.
    Finish { job: String },
    /// Sends the order back to the job's `send_back` stage.
    SendBack { job: String, reason: String },
    /// The job won't be done.
    Cancel { job: String, reason: String },
    /// Signs a stage off.
    Approve { stage: String },
    /// Closes the whole order unfinished.
    CancelOrder { reason: String },
}

/// One action as the history keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// Unix seconds, from the server's clock when it was taken.
    pub at: u64,
    pub by: Actor,
    pub action: Action,
}

/// What the engine asks the server about people. Team ids are the installed
/// definition's (decision 8).
pub trait People {
    fn on_team(&self, account: &str, team: &str) -> bool;
    /// Holds this team power (ADR-0081 as built: `approve_plans` and so on).
    fn has_power(&self, account: &str, team: &str, power: &str) -> bool;
    /// Holds this role on the team (`lead`, `overseer`, …).
    fn has_role(&self, account: &str, team: &str, role: &str) -> bool;
    /// A Steward over where the order lives.
    fn is_steward(&self, account: &str) -> bool;
}

/// Why an action was refused. The order is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal(pub String);

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn no(msg: impl Into<String>) -> Refusal {
    Refusal(msg.into())
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrderStatus {
    Open,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    /// Its stage hasn't started.
    NotStarted,
    /// Its `when` didn't match this order; counts as met for `needs`.
    LeftOut,
    /// Its stage has started; something it needs isn't done.
    Waiting,
    Ready,
    Done,
    Cancelled,
}

impl JobStatus {
    /// Finished, as far as its stage and anything that needs it care.
    pub fn finished(self) -> bool {
        matches!(
            self,
            JobStatus::Done | JobStatus::Cancelled | JobStatus::LeftOut
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobState {
    pub status: JobStatus,
    pub picked_by: Option<String>,
    pub ticks: BTreeSet<usize>,
    /// When it became ready, for `due` (piece 3).
    pub ready_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub finished_by: Option<Actor>,
    /// The reason it was cancelled.
    pub note: Option<String>,
    /// The plan a `makes: plan` job opened: (design, plan).
    pub plan: Option<(String, String)>,
}

impl JobState {
    fn fresh() -> Self {
        JobState {
            status: JobStatus::NotStarted,
            picked_by: None,
            ticks: BTreeSet::new(),
            ready_at: None,
            finished_at: None,
            finished_by: None,
            note: None,
            plan: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageStatus {
    NotStarted,
    Running,
    /// Every job is finished; it waits for a sign-off.
    AwaitingSignOff,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageState {
    pub status: StageStatus,
    pub approved_by: Option<String>,
}

/// A device or port an open order holds through a job's `holds` (decision 18).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Hold {
    pub job: String,
    pub field: String,
    pub what: Ref,
}

#[derive(Debug, Clone)]
pub struct Order {
    def: Definition,
    status: OrderStatus,
    opened_by: String,
    answers: BTreeMap<String, Value>,
    jobs: BTreeMap<String, JobState>,
    stages: BTreeMap<String, StageState>,
    events: Vec<Event>,
}

impl Order {
    /// Opens an order. `def` is the installed definition (team ids, not
    /// slugs). The `Open` event is the first in its history.
    pub fn open(
        def: Definition,
        by: &str,
        at: u64,
        answers: Vec<(String, Value)>,
    ) -> Result<Order, Refusal> {
        let mut order = Order {
            status: OrderStatus::Open,
            opened_by: by.to_owned(),
            answers: BTreeMap::new(),
            jobs: BTreeMap::new(),
            stages: BTreeMap::new(),
            events: Vec::new(),
            def,
        };
        for job in order.def.jobs() {
            order.jobs.insert(job.id.clone(), JobState::fresh());
        }
        for lane in &order.def.lanes {
            for stage in &lane.stages {
                order.stages.insert(
                    stage.id.clone(),
                    StageState {
                        status: StageStatus::NotStarted,
                        approved_by: None,
                    },
                );
            }
        }
        let mut seen = BTreeSet::new();
        for (key, value) in &answers {
            if !seen.insert(key.as_str()) {
                return Err(no(format!("`{key}` is answered twice")));
            }
            let field = order.field(key)?;
            check_value(field, value)?;
            order.answers.insert(key.clone(), value.clone());
        }
        for field in &order.def.fields {
            let asked_at_open = !order.def.jobs().any(|j| j.asks.contains(&field.key));
            if !order.asked(field) {
                if order.answers.contains_key(&field.key) {
                    return Err(no(format!(
                        "`{}` isn't asked for this order, given the other answers",
                        field.label
                    )));
                }
                continue;
            }
            if asked_at_open && field.required && !order.answers.contains_key(&field.key) {
                return Err(no(format!("`{}` is required", field.label)));
            }
        }
        let start_lanes: Vec<String> = order
            .def
            .lanes
            .iter()
            .filter(|l| l.starts_after.is_none())
            .filter_map(|l| l.stages.first().map(|s| s.id.clone()))
            .collect();
        for stage in start_lanes {
            order.start_stage(&stage, at);
        }
        order.settle(at);
        order.events.push(Event {
            at,
            by: Actor::Person(by.to_owned()),
            action: Action::Open { answers },
        });
        Ok(order)
    }

    /// Rebuilds an order from its history. Every event must apply as it did
    /// when it was taken; one that doesn't means the history and the
    /// definition disagree, and the server should refuse to show the order.
    pub fn replay(
        def: Definition,
        events: &[Event],
        people: &dyn People,
    ) -> Result<Order, Refusal> {
        let Some((first, rest)) = events.split_first() else {
            return Err(no("an order's history starts with Open"));
        };
        let (Actor::Person(by), Action::Open { answers }) = (&first.by, &first.action) else {
            return Err(no("an order's history starts with Open, by a person"));
        };
        let mut order = Order::open(def, by, first.at, answers.clone())?;
        for (i, e) in rest.iter().enumerate() {
            order
                .apply(e.clone(), people)
                .map_err(|r| no(format!("event {} no longer applies: {r}", i + 2)))?;
        }
        Ok(order)
    }

    // ---- reading -----------------------------------------------------------

    pub fn definition(&self) -> &Definition {
        &self.def
    }
    pub fn status(&self) -> OrderStatus {
        self.status
    }
    pub fn opened_by(&self) -> &str {
        &self.opened_by
    }
    pub fn answer(&self, key: &str) -> Option<&Value> {
        self.answers.get(key)
    }
    pub fn job(&self, id: &str) -> Option<&JobState> {
        self.jobs.get(id)
    }
    pub fn stage(&self, id: &str) -> Option<&StageState> {
        self.stages.get(id)
    }
    pub fn events(&self) -> &[Event] {
        &self.events
    }

    /// Jobs that are ready, in definition order: each team's queue.
    pub fn ready_jobs(&self) -> Vec<&Job> {
        self.def
            .jobs()
            .filter(|j| self.jobs[&j.id].status == JobStatus::Ready)
            .collect()
    }

    /// What this order holds right now (decision 18): each `holds` field of a
    /// job that has become ready, while the order is open. Sorted.
    pub fn holds(&self) -> Vec<Hold> {
        if self.status != OrderStatus::Open {
            return Vec::new();
        }
        let mut out = Vec::new();
        for job in self.def.jobs() {
            let st = &self.jobs[&job.id];
            if !matches!(st.status, JobStatus::Ready | JobStatus::Done) {
                continue;
            }
            for key in &job.holds {
                if let Some(Value::Ref(r)) = self.answers.get(key) {
                    out.push(Hold {
                        job: job.id.clone(),
                        field: key.clone(),
                        what: r.clone(),
                    });
                }
            }
        }
        out.sort();
        out
    }

    // ---- acting ------------------------------------------------------------

    /// Checks and applies one action. A refusal leaves the order unchanged.
    pub fn apply(&mut self, event: Event, people: &dyn People) -> Result<(), Refusal> {
        if let Some(last) = self.events.last() {
            if event.at < last.at {
                return Err(no("an action can't be earlier than the one before it"));
            }
        }
        if matches!(event.action, Action::Open { .. }) {
            return Err(no("the order is already open"));
        }
        if self.status != OrderStatus::Open {
            return Err(no("the order is closed"));
        }
        // Work on a copy so a refusal half way changes nothing.
        let mut next = self.clone();
        next.act(&event, people)?;
        next.settle(event.at);
        next.events.push(event);
        *self = next;
        Ok(())
    }

    fn act(&mut self, e: &Event, people: &dyn People) -> Result<(), Refusal> {
        let person = match &e.by {
            Actor::Person(p) => Some(p.as_str()),
            Actor::Engine => None,
        };
        let at = e.at;
        match &e.action {
            Action::Open { .. } => unreachable!("refused in apply"),
            Action::Answer {
                field,
                value,
                reason,
            } => {
                let who = person.ok_or_else(|| no("only a person changes an answer"))?;
                self.change_answer(who, field, value.as_ref(), reason.as_deref(), people)
            }
            Action::PickUp { job } => {
                let who = person.ok_or_else(|| no("only a person picks up a job"))?;
                let team = self.job_def(job)?.team.clone();
                self.must_be_ready(job)?;
                if !people.on_team(who, &team) {
                    return Err(no("only someone on the job's team can pick it up"));
                }
                self.jobs.get_mut(job).expect("checked").picked_by = Some(who.to_owned());
                Ok(())
            }
            Action::Tick { job, step, done } => {
                let who = person.ok_or_else(|| no("only a person ticks a step"))?;
                let def = self.job_def(job)?.clone();
                self.must_be_ready(job)?;
                self.must_work_on(who, &def, people)?;
                if *step >= def.steps.len() {
                    return Err(no(format!("`{}` has no step {}", def.name, step + 1)));
                }
                let ticks = &mut self.jobs.get_mut(job).expect("checked").ticks;
                if *done {
                    ticks.insert(*step);
                } else {
                    ticks.remove(step);
                }
                Ok(())
            }
            Action::LinkPlan { job, design, plan } => {
                let def = self.job_def(job)?.clone();
                if !def.makes_plan {
                    return Err(no(format!("`{}` doesn't open a plan", def.name)));
                }
                self.must_be_ready(job)?;
                if let Some(who) = person {
                    self.must_work_on(who, &def, people)?;
                }
                let st = self.jobs.get_mut(job).expect("checked");
                if st.plan.is_some() {
                    return Err(no(format!("`{}` already has its plan", def.name)));
                }
                st.plan = Some((design.clone(), plan.clone()));
                Ok(())
            }
            Action::Finish { job } => {
                let def = self.job_def(job)?.clone();
                self.must_be_ready(job)?;
                match person {
                    Some(who) => {
                        self.must_work_on(who, &def, people)?;
                        if def.makes_plan {
                            return Err(no(format!(
                                "`{}` is done when its plan is recorded",
                                def.name
                            )));
                        }
                    }
                    None => {
                        if !def.makes_plan || self.jobs[job].plan.is_none() {
                            return Err(no(
                                "the engine finishes only a job whose plan was recorded",
                            ));
                        }
                    }
                }
                let st = &self.jobs[job];
                if st.ticks.len() < def.steps.len() {
                    return Err(no(format!(
                        "`{}` has {} of {} steps ticked",
                        def.name,
                        st.ticks.len(),
                        def.steps.len()
                    )));
                }
                for key in &def.asks {
                    let f = self.field(key)?;
                    if f.required && self.asked(f) && !self.answers.contains_key(key) {
                        return Err(no(format!("`{}` needs an answer first", f.label)));
                    }
                }
                let st = self.jobs.get_mut(job).expect("checked");
                st.status = JobStatus::Done;
                st.finished_at = Some(at);
                st.finished_by = Some(e.by.clone());
                Ok(())
            }
            Action::SendBack { job, reason } => {
                let who = person.ok_or_else(|| no("only a person sends an order back"))?;
                let def = self.job_def(job)?.clone();
                self.must_be_ready(job)?;
                self.must_work_on(who, &def, people)?;
                let Some(sb) = &def.send_back else {
                    return Err(no(format!("`{}` can't send the order back", def.name)));
                };
                if reason.trim().is_empty() {
                    return Err(no("say why it goes back"));
                }
                self.go_back(&sb.to.clone(), at);
                Ok(())
            }
            Action::Cancel { job, reason } => {
                let who = person.ok_or_else(|| no("only a person cancels a job"))?;
                let def = self.job_def(job)?.clone();
                let st = &self.jobs[job];
                if !matches!(st.status, JobStatus::Waiting | JobStatus::Ready) {
                    return Err(no(format!("`{}` isn't open", def.name)));
                }
                let lead = people.has_role(who, &def.team, LEAD) || people.is_steward(who);
                if !(lead || (def.optional && people.on_team(who, &def.team))) {
                    return Err(no(
                        "only a lead of the job's team or a Steward cancels a job that isn't optional",
                    ));
                }
                if reason.trim().is_empty() {
                    return Err(no("say why it's cancelled"));
                }
                let st = self.jobs.get_mut(job).expect("checked");
                st.status = JobStatus::Cancelled;
                st.note = Some(reason.clone());
                st.finished_at = Some(at);
                st.finished_by = Some(e.by.clone());
                Ok(())
            }
            Action::Approve { stage } => {
                let who = person.ok_or_else(|| no("only a person signs a stage off"))?;
                self.approve(who, stage, people)
            }
            Action::CancelOrder { reason } => {
                let who = person.ok_or_else(|| no("the engine never cancels an order"))?;
                let teams: BTreeSet<&str> = self.def.jobs().map(|j| j.team.as_str()).collect();
                let lead = teams.iter().any(|t| people.has_role(who, t, LEAD));
                if !(lead || people.is_steward(who)) {
                    return Err(no(
                        "only a lead of one of the order's teams or a Steward cancels an order",
                    ));
                }
                if reason.trim().is_empty() {
                    return Err(no("say why it's cancelled"));
                }
                self.status = OrderStatus::Cancelled;
                Ok(())
            }
        }
    }

    fn approve(&mut self, who: &str, stage: &str, people: &dyn People) -> Result<(), Refusal> {
        let (power, jobs) = self
            .def
            .lanes
            .iter()
            .flat_map(|l| l.stages.iter())
            .find(|s| s.id == stage)
            .map(|s| (s.approval.clone(), s.jobs.clone()))
            .ok_or_else(|| no(format!("no stage `{stage}`")))?;
        let Some(power) = power else {
            return Err(no("this stage doesn't ask for a sign-off"));
        };
        if self.stages[stage].status != StageStatus::AwaitingSignOff {
            return Err(no("this stage isn't waiting for a sign-off"));
        }
        // The author, the assignee and whoever asked never sign it off.
        if who == self.opened_by {
            return Err(no("whoever opened the order can't sign its stages off"));
        }
        for j in &jobs {
            let st = &self.jobs[&j.id];
            let did = st.picked_by.as_deref() == Some(who)
                || st.finished_by == Some(Actor::Person(who.to_owned()));
            if did {
                return Err(no("nobody signs off a stage they worked on"));
            }
        }
        let allowed =
            people.is_steward(who) || jobs.iter().any(|j| people.has_power(who, &j.team, &power));
        if !allowed {
            return Err(no(format!(
                "signing this off needs `{power}` on the job's team, or a Steward"
            )));
        }
        let st = self.stages.get_mut(stage).expect("checked");
        st.approved_by = Some(who.to_owned());
        st.status = StageStatus::Done;
        Ok(())
    }

    fn change_answer(
        &mut self,
        who: &str,
        key: &str,
        value: Option<&Value>,
        reason: Option<&str>,
        people: &dyn People,
    ) -> Result<(), Refusal> {
        let field = self.field(key)?.clone();
        if let Some(v) = value {
            check_value(&field, v)?;
        }
        if !self.asked(&field) {
            return Err(no(format!("`{}` isn't asked for this order", field.label)));
        }
        // Decision 16. A field's owners are the jobs that ask for it; a field
        // asked when the order opens belongs to the first stage's jobs, and
        // to whoever opened the order, until that stage is done.
        let owners: Vec<&Job> = {
            let asking: Vec<&Job> = self
                .def
                .jobs()
                .filter(|j| j.asks.contains(&field.key))
                .collect();
            if asking.is_empty() {
                self.def
                    .lanes
                    .first()
                    .and_then(|l| l.stages.first())
                    .map(|s| s.jobs.iter().collect())
                    .unwrap_or_default()
            } else {
                asking
            }
        };
        let open_owner = owners.iter().any(|j| !self.jobs[&j.id].status.finished());
        let at_open = !self.def.jobs().any(|j| j.asks.contains(&field.key));
        let may_freely = open_owner
            && (owners.iter().any(|j| people.on_team(who, &j.team))
                || (at_open && who == self.opened_by));
        if !may_freely {
            let lead = owners.iter().any(|j| people.has_role(who, &j.team, LEAD))
                || people.is_steward(who);
            if !lead {
                return Err(no(format!(
                    "once its job is done, only a lead of that team changes `{}`",
                    field.label
                )));
            }
            if reason.map(str::trim).unwrap_or("").is_empty() {
                return Err(no(format!("say why `{}` changes", field.label)));
            }
        }
        match value {
            Some(v) => {
                self.answers.insert(key.to_owned(), v.clone());
            }
            None => {
                if field.required && at_open {
                    return Err(no(format!("`{}` is required", field.label)));
                }
                self.answers.remove(key);
            }
        }
        Ok(())
    }

    // ---- moving --------------------------------------------------------------

    fn start_stage(&mut self, stage: &str, at: u64) {
        let jobs: Vec<Job> = self
            .def
            .lanes
            .iter()
            .flat_map(|l| l.stages.iter())
            .find(|s| s.id == stage)
            .map(|s| s.jobs.clone())
            .unwrap_or_default();
        self.stages.get_mut(stage).expect("known stage").status = StageStatus::Running;
        for job in jobs {
            let included = job.when.as_ref().is_none_or(|c| self.holds_true(c));
            let st = self.jobs.get_mut(&job.id).expect("known job");
            *st = JobState::fresh();
            st.status = if included {
                JobStatus::Waiting
            } else {
                JobStatus::LeftOut
            };
        }
        let _ = at;
    }

    /// Moves everything that can move, until nothing does.
    fn settle(&mut self, at: u64) {
        loop {
            let mut moved = false;
            // Waiting → Ready, and back when something it needs went back.
            let ids: Vec<(String, Vec<String>)> = self
                .def
                .jobs()
                .map(|j| (j.id.clone(), j.needs.clone()))
                .collect();
            for (id, needs) in &ids {
                let met = needs.iter().all(|n| self.jobs[n].status.finished());
                let st = self.jobs.get_mut(id).expect("known job");
                match (st.status, met) {
                    (JobStatus::Waiting, true) => {
                        st.status = JobStatus::Ready;
                        st.ready_at = Some(at);
                        moved = true;
                    }
                    (JobStatus::Ready, false) => {
                        st.status = JobStatus::Waiting;
                        moved = true;
                    }
                    _ => {}
                }
            }
            // Stages that are finished move on.
            let lanes = self.def.lanes.clone();
            for lane in &lanes {
                for (i, stage) in lane.stages.iter().enumerate() {
                    let status = self.stages[&stage.id].status;
                    if status == StageStatus::Running
                        && stage
                            .jobs
                            .iter()
                            .all(|j| self.jobs[&j.id].status.finished())
                    {
                        self.stages.get_mut(&stage.id).expect("known").status =
                            if stage.approval.is_some() {
                                StageStatus::AwaitingSignOff
                            } else {
                                StageStatus::Done
                            };
                        moved = true;
                    }
                    if self.stages[&stage.id].status == StageStatus::Done {
                        if let Some(next) = lane.stages.get(i + 1) {
                            if self.stages[&next.id].status == StageStatus::NotStarted {
                                self.start_stage(&next.id, at);
                                moved = true;
                            }
                        }
                        for other in &lanes {
                            if other.starts_after.as_deref() == Some(stage.id.as_str()) {
                                if let Some(first) = other.stages.first() {
                                    if self.stages[&first.id].status == StageStatus::NotStarted {
                                        self.start_stage(&first.id, at);
                                        moved = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if !moved {
                break;
            }
        }
        let all_done = self.def.lanes.iter().all(|l| {
            l.stages
                .last()
                .is_none_or(|s| self.stages[&s.id].status == StageStatus::Done)
        });
        if all_done && self.status == OrderStatus::Open {
            self.status = OrderStatus::Done;
        }
    }

    /// Sends a lane back to `to`: that stage and every later one in its lane
    /// start over. Other lanes carry on; a job there that needs one of the
    /// reset jobs goes back to waiting (in `settle`).
    fn go_back(&mut self, to: &str, at: u64) {
        let lane = self
            .def
            .lanes
            .iter()
            .find(|l| l.stages.iter().any(|s| s.id == to))
            .expect("checked by the reader")
            .clone();
        let from = lane.stages.iter().position(|s| s.id == to).expect("found");
        for stage in &lane.stages[from..] {
            *self.stages.get_mut(&stage.id).expect("known") = StageState {
                status: StageStatus::NotStarted,
                approved_by: None,
            };
            for job in &stage.jobs {
                *self.jobs.get_mut(&job.id).expect("known") = JobState::fresh();
            }
        }
        self.start_stage(to, at);
    }

    // ---- helpers -------------------------------------------------------------

    fn field(&self, key: &str) -> Result<&Field, Refusal> {
        self.def
            .field(key)
            .ok_or_else(|| no(format!("no field `{key}`")))
    }

    fn job_def(&self, id: &str) -> Result<&Job, Refusal> {
        self.def
            .jobs()
            .find(|j| j.id == id)
            .ok_or_else(|| no(format!("no job `{id}`")))
    }

    fn must_be_ready(&self, job: &str) -> Result<(), Refusal> {
        match self.jobs[job].status {
            JobStatus::Ready => Ok(()),
            JobStatus::Waiting => Err(no("that job is still waiting for others")),
            JobStatus::NotStarted => Err(no("that job's stage hasn't started")),
            _ => Err(no("that job is finished")),
        }
    }

    fn must_work_on(&self, who: &str, job: &Job, people: &dyn People) -> Result<(), Refusal> {
        if people.on_team(who, &job.team) || people.is_steward(who) {
            Ok(())
        } else {
            Err(no(format!(
                "only someone on the team works on `{}`",
                job.name
            )))
        }
    }

    /// Whether a field is asked for this order, given its `when`.
    fn asked(&self, f: &Field) -> bool {
        f.when.as_ref().is_none_or(|c| self.holds_true(c))
    }

    /// Evaluates a condition over the answers. An unanswered field matches
    /// only `not_set` and `is_not`.
    pub fn holds_true(&self, c: &Condition) -> bool {
        match c {
            Condition::All(cs) => cs.iter().all(|c| self.holds_true(c)),
            Condition::Any(cs) => cs.iter().any(|c| self.holds_true(c)),
            Condition::Field { field, compare } => {
                let v = self.answers.get(field);
                match compare {
                    Compare::Set => v.is_some(),
                    Compare::NotSet => v.is_none(),
                    Compare::Is(s) => v.is_some_and(|v| matches(v, s)),
                    Compare::IsNot(s) => !v.is_some_and(|v| matches(v, s)),
                    Compare::In(list) => v.is_some_and(|v| list.iter().any(|s| matches(v, s))),
                    Compare::AtLeast(n) => matches!(v, Some(Value::Int(i)) if i >= n),
                    Compare::AtMost(n) => matches!(v, Some(Value::Int(i)) if i <= n),
                }
            }
        }
    }
}

fn matches(v: &Value, s: &Scalar) -> bool {
    match (v, s) {
        (Value::Text(a), Scalar::Text(b)) | (Value::Date(a), Scalar::Text(b)) => a == b,
        (Value::List(a), Scalar::Text(b)) => a.contains(b),
        (Value::Int(a), Scalar::Int(b)) => a == b,
        (Value::Bool(a), Scalar::Bool(b)) => a == b,
        _ => false,
    }
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10)) {
        return false;
    }
    let m: u32 = s[5..7].parse().unwrap_or(0);
    let d: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&m) && (1..=31).contains(&d)
}

/// The value fits the field's kind.
fn check_value(f: &Field, v: &Value) -> Result<(), Refusal> {
    let bad = || {
        Err(no(format!(
            "`{}` takes {}",
            f.label,
            match f.kind {
                FieldKind::Number => "a whole number",
                FieldKind::YesNo => "yes or no",
                FieldKind::Date => "a date (YYYY-MM-DD)",
                FieldKind::Choices => "a list of its choices",
                FieldKind::Device => "a device",
                FieldKind::Port => "a port on a device",
                _ => "text",
            }
        )))
    };
    match (f.kind, v) {
        (FieldKind::Number, Value::Int(i)) => {
            if f.min.is_some_and(|m| *i < m) || f.max.is_some_and(|m| *i > m) {
                return Err(no(format!("`{}` is out of range", f.label)));
            }
        }
        (FieldKind::YesNo, Value::Bool(_)) => {}
        (FieldKind::Date, Value::Date(d)) if is_date(d) => {}
        (FieldKind::Choice, Value::Text(t)) => {
            if !f.choices.contains(t) {
                return Err(no(format!("`{t}` isn't one of `{}`'s choices", f.label)));
            }
        }
        (FieldKind::Choices, Value::List(items)) => {
            if let Some(t) = items.iter().find(|t| !f.choices.contains(t)) {
                return Err(no(format!("`{t}` isn't one of `{}`'s choices", f.label)));
            }
        }
        (FieldKind::Device, Value::Ref(r)) if r.port.is_none() => {}
        (FieldKind::Port, Value::Ref(r)) if r.port.is_some() => {}
        (
            FieldKind::Text
            | FieldKind::LongText
            | FieldKind::Site
            | FieldKind::Team
            | FieldKind::Person
            | FieldKind::Prefix,
            Value::Text(t),
        ) if !t.trim().is_empty() => {}
        _ => return bad(),
    }
    if let Value::Ref(r) = v {
        if r.design.is_empty() || r.device.is_empty() || r.port.as_deref() == Some("") {
            return bad();
        }
    }
    Ok(())
}
