//! **What an AI may do, by kind of work** (ADR-0077 amendment, sign-off card r47-ai-controls,
//! approved 2026-10-27).
//!
//! An AI never changes a design itself; what it sends is an idea (steps a person carries out)
//! or a proposal (the change itself, which a person sees on the canvas and accepts). For each
//! kind of work, each of three places sets how far an AI may go:
//!
//! - the server's admin sets the most any organisation may allow (`ai_site_switch.work`);
//! - a Steward sets the organisation within that (`ai_policies.work`);
//! - a connection's owner narrows their own connection, and a Steward may narrow it too
//!   (`ai_keys.work`).
//!
//! The strictest of the three wins, at every request. Four kinds of work:
//!
//! - **design**: devices, ports, cables, racks, notes, stock: everything that is not below;
//! - **plans**: drafting maintenance plans and their steps;
//! - **issues**: troubleshooting, opening "It's down" issues and adding and answering steps;
//! - **doing**: working through a plan, the record of what really happened: a plan's stage,
//!   outcome and record, a step's state, when it was done and what it was before and after,
//!   and an issue's stage and outcome. Off unless the admin and a Steward both allow it.
//!
//! A Steward may also name the only kinds and fields an AI may touch (`only`), folders where an
//! AI may only send ideas or nothing at all, and lower the limits.

use std::collections::BTreeSet;

use fathom_canon::Json;
use fathom_ir::generated::ir_types::{
    EdgeKind, IssueField, MaintenancePlanField, NodeKind, PlanStepField,
};

/// A kind of work an AI may be allowed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Work {
    Design,
    Plans,
    Issues,
    Doing,
}

pub const WORKS: [Work; 4] = [Work::Design, Work::Plans, Work::Issues, Work::Doing];

impl Work {
    pub fn as_str(self) -> &'static str {
        match self {
            Work::Design => "design",
            Work::Plans => "plans",
            Work::Issues => "issues",
            Work::Doing => "doing",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        WORKS.into_iter().find(|w| w.as_str() == s)
    }

    /// What a refusal calls it.
    pub fn words(self) -> &'static str {
        match self {
            Work::Design => "editing the design",
            Work::Plans => "drafting maintenance plans",
            Work::Issues => "troubleshooting",
            Work::Doing => "working through a plan",
        }
    }
}

/// How far an AI may go at one kind of work. Ordered: the lesser of two is the stricter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Off,
    /// Steps a person carries out.
    Ideas,
    /// The change itself, shown on the canvas, which a person accepts.
    Propose,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Off => "off",
            Level::Ideas => "ideas",
            Level::Propose => "propose",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        [Level::Off, Level::Ideas, Level::Propose]
            .into_iter()
            .find(|l| l.as_str() == s)
    }
}

/// One level for each kind of work, in [`WORKS`] order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Levels(pub [Level; 4]);

impl Levels {
    /// What the server allows when its admin set nothing: proposals at all but `doing`.
    pub const SITE_DEFAULT: Levels =
        Levels([Level::Propose, Level::Propose, Level::Propose, Level::Off]);

    /// A row written before levels existed, read from its one "may propose changes" tick.
    pub fn from_tick(may_change: bool) -> Levels {
        let l = if may_change {
            Level::Propose
        } else {
            Level::Ideas
        };
        Levels([l, l, l, Level::Off])
    }

    pub fn get(&self, w: Work) -> Level {
        self.0[w as usize]
    }

    /// The stricter of the two, kind by kind.
    pub fn min(&self, other: &Levels) -> Levels {
        let mut out = self.0;
        for (i, l) in out.iter_mut().enumerate() {
            *l = (*l).min(other.0[i]);
        }
        Levels(out)
    }

    /// Whether every kind is at most what `ceiling` allows.
    pub fn within(&self, ceiling: &Levels) -> bool {
        self.0.iter().zip(ceiling.0.iter()).all(|(a, b)| a <= b)
    }

    /// Whether any kind allows a proposal: what the old "may propose changes" tick says.
    pub fn any_propose(&self) -> bool {
        self.0.contains(&Level::Propose)
    }

    /// Whether any kind allows at least ideas.
    pub fn any_ideas(&self) -> bool {
        self.0.iter().any(|l| *l >= Level::Ideas)
    }

    /// As stored: `kind:level`, one each, in [`WORKS`] order.
    pub fn to_strs(&self) -> Vec<String> {
        WORKS
            .iter()
            .map(|w| format!("{}:{}", w.as_str(), self.get(*w).as_str()))
            .collect()
    }

    /// From a stored column; `None` when it is empty (a row from before levels) or not one
    /// spelling of four.
    pub fn from_strs(stored: &[String]) -> Option<Levels> {
        if stored.len() != WORKS.len() {
            return None;
        }
        let mut out = [Level::Off; 4];
        for (i, (s, w)) in stored.iter().zip(WORKS).enumerate() {
            let (k, l) = s.split_once(':')?;
            if k != w.as_str() {
                return None;
            }
            out[i] = Level::parse(l)?;
        }
        Some(Levels(out))
    }

    /// As the API gives it: `{design: "propose", ...}`.
    pub fn to_json(&self) -> Json {
        Json::Obj(
            WORKS
                .iter()
                .map(|w| {
                    (
                        w.as_str().to_string(),
                        Json::Str(self.get(*w).as_str().into()),
                    )
                })
                .collect(),
        )
    }

    /// From the API: every kind named once with a level.
    pub fn from_json(j: &Json) -> Option<Levels> {
        let Json::Obj(m) = j else { return None };
        if m.len() != WORKS.len() {
            return None;
        }
        let mut out = [Level::Off; 4];
        for (i, w) in WORKS.iter().enumerate() {
            match m.get(w.as_str()) {
                Some(Json::Str(s)) => out[i] = Level::parse(s)?,
                _ => return None,
            }
        }
        Some(Levels(out))
    }
}

/// The kind of work setting `field` on a node of `kind` is.
pub fn work_of_node_field(kind: NodeKind, field: &str) -> Work {
    let doing = match kind {
        NodeKind::MaintenancePlan => [
            MaintenancePlanField::Stage.name(),
            MaintenancePlanField::Outcome.name(),
            MaintenancePlanField::Record.name(),
        ]
        .contains(&field),
        NodeKind::PlanStep => [
            PlanStepField::State.name(),
            PlanStepField::DoneAt.name(),
            PlanStepField::Before.name(),
            PlanStepField::After.name(),
        ]
        .contains(&field),
        NodeKind::Issue => [IssueField::Stage.name(), IssueField::Outcome.name()].contains(&field),
        _ => false,
    };
    if doing {
        Work::Doing
    } else {
        work_of_node(kind)
    }
}

/// The kind of work adding or removing a node of `kind` is.
pub fn work_of_node(kind: NodeKind) -> Work {
    match kind {
        NodeKind::MaintenancePlan | NodeKind::PlanStep => Work::Plans,
        NodeKind::Issue | NodeKind::IssueStep => Work::Issues,
        _ => Work::Design,
    }
}

/// The kind of work adding, removing or setting a field on an edge of `kind` is.
pub fn work_of_edge(kind: EdgeKind) -> Work {
    match kind {
        EdgeKind::HasStep => Work::Plans,
        EdgeKind::HasIssueStep => Work::Issues,
        _ => Work::Design,
    }
}

/// The most entries a Steward's list of the only kinds and fields may hold.
pub const MAX_ONLY: usize = 100;

/// A Steward's list of the only kinds and fields an AI may touch: `Kind` allows the kind
/// whole, `Kind.field` one field of it. Empty allows everything the reading does.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Only(pub BTreeSet<String>);

impl Only {
    /// Checked: each entry a node or edge kind, with a field the reading names if it has one.
    pub fn parse(entries: &[String]) -> Result<Only, &'static str> {
        if entries.len() > MAX_ONLY {
            return Err("at most 100 kinds and fields");
        }
        let mut out = BTreeSet::new();
        for e in entries {
            let (kind, field) = match e.split_once('.') {
                Some((k, f)) => (k, Some(f)),
                None => (e.as_str(), None),
            };
            let known = NodeKind::from_name(kind).is_some() || EdgeKind::from_name(kind).is_some();
            let field_ok = field.is_none_or(|f| {
                !f.is_empty()
                    && f.len() <= 64
                    && f.chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            });
            if !known || !field_ok {
                return Err(
                    "each entry is a kind (Device) or a kind and a field (Device.hostname)",
                );
            }
            out.insert(e.clone());
        }
        Ok(Only(out))
    }

    pub fn is_open(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether the kind may be added or removed.
    pub fn kind(&self, kind: &str) -> bool {
        self.is_open() || self.0.contains(kind)
    }

    /// Whether the field of the kind may be set.
    pub fn field(&self, kind: &str, field: &str) -> bool {
        self.is_open() || self.0.contains(kind) || self.0.contains(&format!("{kind}.{field}"))
    }

    pub fn to_vec(&self) -> Vec<String> {
        self.0.iter().cloned().collect()
    }
}

/// Fixed maximums a Steward may lower: proposals a minute, a day, and removals in one.
pub const MAX_PER_MINUTE: i32 = 10;
pub const MAX_PER_DAY: i32 = 300;
pub const MAX_REMOVALS: i32 = 20;

/// Everything a proposal is checked against beyond the reading's tiers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rules {
    pub levels: Levels,
    pub only: Only,
    pub max_removals: usize,
}

impl Rules {
    /// No narrowing beyond the tiers: every kind proposable, every kind and field, 20 removals.
    pub fn open() -> Rules {
        Rules {
            levels: Levels([Level::Propose; 4]),
            only: Only::default(),
            max_removals: MAX_REMOVALS as usize,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_strictest_level_wins_kind_by_kind() {
        let site = Levels::SITE_DEFAULT;
        let org = Levels([Level::Ideas, Level::Propose, Level::Propose, Level::Propose]);
        let key = Levels([Level::Propose, Level::Off, Level::Propose, Level::Propose]);
        let eff = site.min(&org).min(&key);
        assert_eq!(
            eff,
            Levels([Level::Ideas, Level::Off, Level::Propose, Level::Off])
        );
        assert!(!org.within(&site), "doing is off at the site");
        assert!(eff.within(&site));
    }

    #[test]
    fn a_stored_spelling_round_trips_and_anything_else_reads_as_none() {
        let l = Levels([Level::Propose, Level::Ideas, Level::Off, Level::Off]);
        assert_eq!(Levels::from_strs(&l.to_strs()), Some(l));
        assert_eq!(Levels::from_json(&l.to_json()), Some(l));
        assert_eq!(Levels::from_strs(&[]), None);
        let mut swapped = l.to_strs();
        swapped.swap(0, 1);
        assert_eq!(Levels::from_strs(&swapped), None);
        assert_eq!(Levels::from_tick(true).get(Work::Doing), Level::Off);
        assert_eq!(Levels::from_tick(false).get(Work::Design), Level::Ideas);
    }

    #[test]
    fn recording_what_happened_is_its_own_kind_of_work() {
        assert_eq!(work_of_node_field(NodeKind::PlanStep, "state"), Work::Doing);
        assert_eq!(
            work_of_node_field(NodeKind::MaintenancePlan, "stage"),
            Work::Doing
        );
        assert_eq!(work_of_node_field(NodeKind::Issue, "stage"), Work::Doing);
        assert_eq!(
            work_of_node_field(NodeKind::PlanStep, "change"),
            Work::Plans
        );
        assert_eq!(
            work_of_node_field(NodeKind::IssueStep, "answer"),
            Work::Issues
        );
        assert_eq!(
            work_of_node_field(NodeKind::Device, "hostname"),
            Work::Design
        );
        assert_eq!(work_of_edge(EdgeKind::HasStep), Work::Plans);
        assert_eq!(work_of_edge(EdgeKind::HasCable), Work::Design);
    }

    #[test]
    fn the_only_list_takes_kinds_and_fields_and_nothing_else() {
        let only = Only::parse(&["Device.hostname".into(), "Note".into()]).unwrap();
        assert!(only.field("Device", "hostname"));
        assert!(!only.field("Device", "domain_name"));
        assert!(!only.kind("Device"));
        assert!(only.kind("Note") && only.field("Note", "text"));
        assert!(Only::parse(&["Nonsense".into()]).is_err());
        assert!(Only::parse(&["Device.Host Name".into()]).is_err());
        assert!(Only::default().field("Device", "anything"));
    }
}
