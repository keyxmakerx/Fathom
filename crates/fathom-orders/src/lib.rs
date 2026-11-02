//! fathom-orders: ADR-0084's order definitions, with ADR-0084's lanes and
//! shared field sets (decisions 14 and 15).
//!
//! An order type is one YAML document, read through the project's own YAML
//! subset parser (`fathom_schema::subset`, decision 13) and checked here. The
//! file only describes; nothing in it runs (decision 2). Every key is from a
//! fixed list and an unknown one is refused, so a typo shows rather than
//! silently dropping a step.
//!
//! This crate is piece 1 of ADR-0084's build: read and check. It keeps no
//! records, knows no organisation and calls no redaction gate; the server does
//! those when it stores a definition (pieces 1 and 2 there). It is pure and
//! deterministic so the builder can run the same check in the browser later.

#![forbid(unsafe_code)]

mod read;

pub use read::{read_definition, read_field_set};

/// The value of a definition file's `fathom:` key.
pub const DEFINITION_FORMAT: &str = "order-definition/1";
/// The value of a shared field set file's `fathom:` key.
pub const FIELD_SET_FORMAT: &str = "field-set/1";

/// The team powers (ADR-0081, as built by the teams work) a stage's
/// `approval:` may name. A stage is then done only when someone holding that
/// power on the job's team, or a Steward of the folder, signs it off; the
/// author, the assignee and whoever asked never can (the engine's rule).
pub const APPROVAL_POWERS: &[&str] = &["approve_plans"];

/// One thing wrong with a file, at a 1-based line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub line: usize,
    pub message: String,
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

/// What a field holds. On screen these read as the r103 card lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Text,
    LongText,
    Number,
    YesNo,
    Date,
    /// One of `choices`.
    Choice,
    /// Any number of `choices`.
    Choices,
    Site,
    Device,
    Team,
    Person,
    /// An address block of a family and size (ADR-0084 decision 9, ADR-0083).
    Prefix,
}

impl FieldKind {
    pub const ALL: &'static [(&'static str, FieldKind)] = &[
        ("text", FieldKind::Text),
        ("long_text", FieldKind::LongText),
        ("number", FieldKind::Number),
        ("yes_no", FieldKind::YesNo),
        ("date", FieldKind::Date),
        ("choice", FieldKind::Choice),
        ("choices", FieldKind::Choices),
        ("site", FieldKind::Site),
        ("device", FieldKind::Device),
        ("team", FieldKind::Team),
        ("person", FieldKind::Person),
        ("prefix", FieldKind::Prefix),
    ];

    pub fn from_word(s: &str) -> Option<FieldKind> {
        Self::ALL.iter().find(|(w, _)| *w == s).map(|(_, k)| *k)
    }

    pub fn word(self) -> &'static str {
        Self::ALL
            .iter()
            .find(|(_, k)| *k == self)
            .map(|(w, _)| *w)
            .unwrap_or("text")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Ipv4,
    Ipv6,
}

/// One question an order asks, when it opens or when a job fills it in.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub kind: FieldKind,
    pub required: bool,
    pub choices: Vec<String>,
    pub family: Option<Family>,
    pub size: Option<u8>,
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub help: Option<String>,
    /// Asked only when this holds; it names a field declared earlier.
    pub when: Option<Condition>,
    /// The shared set this field came from, if any.
    pub from_set: Option<String>,
    pub line: usize,
}

/// A scalar a condition compares with.
#[derive(Debug, Clone, PartialEq)]
pub enum Scalar {
    Text(String),
    Int(i64),
    Bool(bool),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Compare {
    Is(Scalar),
    IsNot(Scalar),
    In(Vec<Scalar>),
    AtLeast(i64),
    AtMost(i64),
    Set,
    NotSet,
}

/// ADR-0084 decision 2: one structured comparison on one of the order's own
/// fields, or `all` / `any` of those. Never an expression.
#[derive(Debug, Clone, PartialEq)]
pub enum Condition {
    Field { field: String, compare: Compare },
    All(Vec<Condition>),
    Any(Vec<Condition>),
}

/// A length of time, as `30m`, `4h`, `2d` or `1w`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Duration {
    pub minutes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverdueAction {
    /// `escalate: lead` or `escalate: overseer` (role ids, ADR-0081).
    Escalate(String),
    /// `reassign: team`: back to the team's queue.
    ReassignToQueue,
    /// `reassign: <team-slug>`: hand it to another team.
    ReassignTo(String),
    /// `move_on: true`: finish as Skipped (only on an optional job).
    MoveOn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverdueRule {
    pub after: Duration,
    pub action: OverdueAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendBack {
    /// An earlier stage in the same lane.
    pub to: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub id: String,
    pub name: String,
    /// Exactly one team, by slug (ADR-0084 decision 8).
    pub team: String,
    pub steps: Vec<String>,
    pub asks: Vec<String>,
    pub when: Option<Condition>,
    pub due: Option<Duration>,
    pub overdue: Vec<OverdueRule>,
    pub optional: bool,
    pub makes_plan: bool,
    /// Jobs anywhere in the order, in this lane or another, that must be done
    /// first. A need on a job left out by its `when` counts as met.
    pub needs: Vec<String>,
    pub send_back: Option<SendBack>,
    pub reserves: Option<String>,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stage {
    pub id: String,
    pub name: String,
    /// A power from [`APPROVAL_POWERS`].
    pub approval: Option<String>,
    pub jobs: Vec<Job>,
    pub line: usize,
}

/// One line of stages. Lanes run at the same time (ADR-0084 decision 14).
#[derive(Debug, Clone, PartialEq)]
pub struct Lane {
    pub id: String,
    pub name: String,
    /// A stage in another lane; this lane's first stage starts when it is
    /// done. `None`: when the order opens.
    pub starts_after: Option<String>,
    pub stages: Vec<Stage>,
    /// True when the file said `stages:` at the top rather than `lanes:`.
    pub implicit: bool,
    pub line: usize,
}

/// A shared field set a Steward keeps once and uses in many order types
/// (ADR-0084 decision 15).
#[derive(Debug, Clone, PartialEq)]
pub struct FieldSet {
    pub id: String,
    pub name: String,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Definition {
    pub id: String,
    pub name: String,
    /// The short code orders show after their W- number.
    pub number: Option<String>,
    /// Fields in order, with shared sets expanded where they were used.
    pub fields: Vec<Field>,
    /// The sets this definition used, as resolved; an export carries them.
    pub field_sets: Vec<FieldSet>,
    pub lanes: Vec<Lane>,
}

impl Definition {
    pub fn jobs(&self) -> impl Iterator<Item = &Job> {
        self.lanes
            .iter()
            .flat_map(|l| l.stages.iter())
            .flat_map(|s| s.jobs.iter())
    }

    pub fn field(&self, key: &str) -> Option<&Field> {
        self.fields.iter().find(|f| f.key == key)
    }

    /// Every team slug the file names, once each, in order of first use:
    /// what a Steward matches to teams when installing it (decision 8).
    pub fn team_slugs(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for job in self.jobs() {
            let reassigned = job.overdue.iter().filter_map(|r| match &r.action {
                OverdueAction::ReassignTo(slug) => Some(slug.as_str()),
                _ => None,
            });
            for slug in std::iter::once(job.team.as_str()).chain(reassigned) {
                if !out.contains(&slug) {
                    out.push(slug);
                }
            }
        }
        out
    }

    /// The slugs `is_team` does not know. Installing is blocked while any is
    /// left (decision 8).
    pub fn unmatched_teams(&self, is_team: impl Fn(&str) -> bool) -> Vec<String> {
        self.team_slugs()
            .into_iter()
            .filter(|s| !is_team(s))
            .map(str::to_owned)
            .collect()
    }
}
