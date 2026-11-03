//! Work that lands on the same devices (sign-off r105): another open maintenance plan, or an open
//! It's down issue, on a device a plan could touch, at a time that overlaps its window.
//!
//! This is the engine's answer, read from the graph; the browser asks it through `OP_WORK_CLASHES`
//! and the server can ask it of any design it holds. Nothing here writes, reads a clock or guesses a
//! cause: it says what else is open on the same devices, and, where both windows are known, a time
//! that would not overlap, for the person in charge of each plan to take or offer.
//!
//! Times. A window is typed as an ISO date (`2026-11-08`) or date and time (`2026-11-08T02:00`).
//! A bare date is that whole day. A time with no zone is read as written (wall time); one with `Z`
//! or an offset is moved to UTC, so mixing the two is approximate by that offset. Anything that
//! does not read as a date leaves that end open, so an unclear window clashes rather than hides
//! (r105 "when" A). Spans are in whole minutes and end-exclusive: 02:00–04:00 and 04:00–06:00 do
//! not clash.

use std::collections::{BTreeMap, BTreeSet};

use fathom_graph::{ElementId, Graph, NodeId};
use fathom_ir::generated::ir_types::{
    EdgeKind, IssueField, IssueStepField, MaintenancePlanField, NodeKind, PlanStepField,
};

use crate::{display_name, field_text, parse_display_id};

const DAY: i64 = 24 * 60;

/// A time span in minutes since 1970-01-01 (wall time), end-exclusive. An open end is
/// `i64::MIN` or `i64::MAX`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub from: i64,
    pub to: i64,
}

impl Span {
    pub const ALWAYS: Span = Span {
        from: i64::MIN,
        to: i64::MAX,
    };

    pub fn overlaps(self, other: Span) -> bool {
        self.from < other.to && other.from < self.to
    }

    fn finite(self) -> bool {
        self.from != i64::MIN && self.to != i64::MAX
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (
        if m <= 2 {
            yoe + era * 400 + 1
        } else {
            yoe + era * 400
        },
        m,
        d,
    )
}

fn digits(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// One end of a window: minutes, and whether it was a bare date.
fn moment(text: &str) -> Option<(i64, bool)> {
    let s = text.trim();
    if s.len() < 10 || !s.is_char_boundary(10) {
        return None;
    }
    let (date, rest) = s.split_at(10);
    let b = date.as_bytes();
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (
        digits(&date[..4])?,
        digits(&date[5..7])?,
        digits(&date[8..])?,
    );
    if !(1..=12).contains(&m) || d < 1 {
        return None;
    }
    let next = if m == 12 {
        days_from_civil(y + 1, 1, 1)
    } else {
        days_from_civil(y, m + 1, 1)
    };
    if d > next - days_from_civil(y, m, 1) {
        return None;
    }
    let day = days_from_civil(y, m, d) * DAY;
    if rest.is_empty() {
        return Some((day, true));
    }
    let rest = rest.strip_prefix('T').or_else(|| rest.strip_prefix(' '))?;
    if rest.len() < 5 || !rest.is_char_boundary(5) || rest.as_bytes()[2] != b':' {
        return None;
    }
    let (h, mi) = (digits(&rest[..2])?, digits(&rest[3..5])?);
    if h > 23 || mi > 59 {
        return None;
    }
    let mut tail = &rest[5..];
    // Seconds and fractions are read and dropped: windows are planned to the minute.
    if let Some(sec) = tail.strip_prefix(':') {
        let n = sec.bytes().take_while(u8::is_ascii_digit).count();
        if n != 2 {
            return None;
        }
        tail = &sec[2..];
        if let Some(frac) = tail.strip_prefix('.') {
            let n = frac.bytes().take_while(u8::is_ascii_digit).count();
            if n == 0 {
                return None;
            }
            tail = &frac[n..];
        }
    }
    let offset = match tail {
        "" | "Z" | "z" => 0,
        t if t.starts_with('+') || t.starts_with('-') => {
            let sign = if t.starts_with('-') { -1 } else { 1 };
            let o = t[1..].replace(':', "");
            if o.len() != 4 {
                return None;
            }
            let (oh, om) = (digits(&o[..2])?, digits(&o[2..])?);
            if oh > 23 || om > 59 {
                return None;
            }
            sign * (oh * 60 + om)
        }
        _ => return None,
    };
    Some((day + h * 60 + mi - offset, false))
}

/// A window as typed. A bare date runs to the end of that day; an end that does not read is open.
/// A start with no end is that day when the start is a bare date, and open otherwise.
pub fn window_span(start: &str, end: &str) -> Span {
    let from = moment(start);
    let to = match moment(end) {
        Some((m, true)) => Some(m + DAY),
        Some((m, false)) => Some(m),
        None => match from {
            Some((m, true)) if end.trim().is_empty() => Some(m + DAY),
            _ => None,
        },
    };
    Span {
        from: from.map_or(i64::MIN, |(m, _)| m),
        to: to.unwrap_or(i64::MAX),
    }
}

/// When a plan is busy: its window, or always when it has none.
pub fn plan_span(start: &str, end: &str) -> Span {
    if start.trim().is_empty() && end.trim().is_empty() {
        Span::ALWAYS
    } else {
        window_span(start, end)
    }
}

/// A span back to a window as typed: bare dates when `bare`, else date and time to the minute.
pub fn window_text(span: Span, bare: bool) -> (String, String) {
    let date = |m: i64| {
        let (y, mo, d) = civil_from_days(m.div_euclid(DAY));
        format!("{y:04}-{mo:02}-{d:02}")
    };
    let full = |m: i64| {
        let r = m.rem_euclid(DAY);
        format!("{}T{:02}:{:02}", date(m), r / 60, r % 60)
    };
    if bare {
        (date(span.from), date(span.to - 1))
    } else {
        (full(span.from), full(span.to))
    }
}

fn is_bare(text: &str) -> bool {
    matches!(moment(text), Some((_, true)))
}

fn live(g: &Graph, n: NodeId) -> bool {
    g.node(n).is_some_and(|node| node.absent_since.is_none())
}

fn node_of(g: &Graph, display: &str) -> Option<NodeId> {
    match parse_display_id(g, display.trim())? {
        ElementId::Node(n) if live(g, n) => Some(n),
        _ => None,
    }
}

fn children(g: &Graph, n: NodeId, k: EdgeKind) -> Vec<NodeId> {
    g.out(n, k)
        .filter(|e| e.absent_since.is_none())
        .map(|e| e.to)
        .filter(|c| live(g, *c))
        .collect()
}

fn ends_of(g: &Graph, cable: NodeId) -> Vec<NodeId> {
    g.out(cable, EdgeKind::Terminates)
        .filter(|e| e.absent_since.is_none())
        .map(|e| e.to)
        .collect()
}

/// The ids an edit line names, as the client's `targetsOf` reads them.
fn edit_targets(line: &str) -> Vec<String> {
    let p: Vec<&str> = line.split('\t').collect();
    let pick: Vec<&str> = match p.as_slice() {
        ["field", id, ..] | ["cut", id] | ["unlag", id] | ["part", id, ..] => vec![*id],
        ["cable", a, b] | ["move", a, b] => vec![*a, *b],
        ["lag", device, _, _, members @ ..] => std::iter::once(*device)
            .chain(members.iter().copied())
            .collect(),
        _ => Vec::new(),
    };
    pick.into_iter().map(str::to_owned).collect()
}

fn lines(text: Option<String>) -> Vec<String> {
    text.map(|t| {
        t.split('\n')
            .filter(|l| !l.trim().is_empty())
            .map(str::to_owned)
            .collect()
    })
    .unwrap_or_default()
}

/// What one plan step names: its typed targets, or else what its edit touches.
fn step_targets(g: &Graph, step: NodeId) -> Vec<String> {
    let typed = lines(field_text(g, step, PlanStepField::Targets.key()));
    if !typed.is_empty() {
        return typed;
    }
    field_text(g, step, PlanStepField::Edit.key())
        .map(|e| edit_targets(&e))
        .unwrap_or_default()
}

/// The devices some ids land on: a port or chassis on its device, a cable on the devices it joins.
fn devices_of(g: &Graph, ids: &[String]) -> BTreeSet<NodeId> {
    let mut out = BTreeSet::new();
    for n in ids.iter().filter_map(|id| node_of(g, id)) {
        let at = if n.kind == NodeKind::Cable {
            ends_of(g, n)
        } else {
            vec![n]
        };
        out.extend(
            at.into_iter()
                .filter_map(|x| g.device_of(x))
                .filter(|d| live(g, *d)),
        );
    }
    out
}

/// The ports some ids name: a port itself, and both ends of a cable.
fn ports_of(g: &Graph, ids: &[String]) -> BTreeSet<NodeId> {
    let mut out = BTreeSet::new();
    for n in ids.iter().filter_map(|id| node_of(g, id)) {
        match n.kind {
            NodeKind::PhysicalPort => {
                out.insert(n);
            }
            NodeKind::Cable => out.extend(ends_of(g, n)),
            _ => {}
        }
    }
    out
}

fn text(g: &Graph, n: NodeId, k: fathom_ir::bag::FieldKey) -> String {
    field_text(g, n, k).unwrap_or_default()
}

/// A port reads as `device port`; anything else as its own name.
fn name(g: &Graph, n: NodeId) -> String {
    let own = display_name(g, n);
    match (n.kind, g.device_of(n)) {
        (NodeKind::PhysicalPort, Some(d)) => format!("{} {own}", display_name(g, d)),
        _ => own,
    }
}

fn named(g: &Graph, ids: impl IntoIterator<Item = NodeId>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = ids
        .into_iter()
        .map(|n| (n.to_string(), name(g, n)))
        .collect();
    out.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    out
}

/// One open plan as the clash check reads it.
struct OpenPlan {
    id: NodeId,
    stage: String,
    start: String,
    end: String,
    span: Span,
    ids: Vec<String>,
}

fn plan_stage(g: &Graph, n: NodeId) -> String {
    field_text(g, n, MaintenancePlanField::Stage.key()).unwrap_or_else(|| "planned".to_owned())
}

fn is_over(stage: &str) -> bool {
    stage == "recorded" || stage == "called_off"
}

fn open_plan(g: &Graph, n: NodeId) -> Option<OpenPlan> {
    let stage = plan_stage(g, n);
    if is_over(&stage) {
        return None;
    }
    let start = text(g, n, MaintenancePlanField::WindowStart.key());
    let end = text(g, n, MaintenancePlanField::WindowEnd.key());
    let mut seen = BTreeSet::new();
    // Every live step, If paths too: what the plan could touch.
    let ids = children(g, n, EdgeKind::HasStep)
        .into_iter()
        .flat_map(|s| step_targets(g, s))
        .filter(|t| seen.insert(t.clone()))
        .collect();
    Some(OpenPlan {
        id: n,
        span: plan_span(&start, &end),
        stage,
        start,
        end,
        ids,
    })
}

fn open_plans(g: &Graph) -> Vec<OpenPlan> {
    g.nodes_of_kind(NodeKind::MaintenancePlan)
        .filter(|n| n.absent_since.is_none())
        .filter_map(|n| open_plan(g, n.id))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ClashKind {
    Plan,
    Issue,
}

impl ClashKind {
    pub fn word(self) -> &'static str {
        match self {
            ClashKind::Plan => "plan",
            ClashKind::Issue => "issue",
        }
    }
}

/// Other open work on the same devices.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Clash {
    pub kind: ClashKind,
    pub id: NodeId,
    pub title: String,
    /// `planned` or `doing` for a plan; `open` for an issue.
    pub stage: String,
    /// The devices both touch: display id and name, in name order.
    pub devices: Vec<(String, String)>,
    /// The ports both touch, by name (`core-sw1 Gi1/0/48`): the tighter clash.
    pub ports: Vec<(String, String)>,
    /// The other plan's window as typed; empty for an issue.
    pub window_start: String,
    pub window_end: String,
    /// Who has it: the plan's team (server id), whoever it is assigned to (account id), and the
    /// name it was written under. Any may be empty; the page names them.
    pub team: String,
    pub assigned_to: String,
    pub author: String,
    /// A window for the other plan that starts when this one ends, keeping its length: what the
    /// person in charge of this plan can offer them. `None` when either window is open.
    pub theirs_after_mine: Option<(String, String)>,
}

/// Everything the clash check says about one plan.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlanClashes {
    pub clashes: Vec<Clash>,
    /// The earliest window at or after this plan's own, of the same length, that overlaps no other
    /// open plan on its devices: what the person in charge can move it to. `None` when there is no
    /// plan clash, or a window is open, or the next free time cannot be found.
    pub mine_free: Option<(String, String)>,
}

/// How many plans a free time may step past before the check gives up.
const FREE_STEPS: usize = 64;

/// Other open work on the devices `plan` could touch, at a time that overlaps its window. Called-off
/// and recorded plans and closed issues never clash. A plan that is itself over has none.
pub fn plan_clashes(g: &Graph, plan: NodeId) -> PlanClashes {
    let Some(mine) = open_plan(g, plan) else {
        return PlanClashes::default();
    };
    let my_devices = devices_of(g, &mine.ids);
    if my_devices.is_empty() {
        return PlanClashes::default();
    }
    let my_ports = ports_of(g, &mine.ids);
    let my_bare = is_bare(&mine.start) && (mine.end.trim().is_empty() || is_bare(&mine.end));
    let mut out = Vec::new();
    // Every other open plan on the same devices, whether or not its time overlaps: a free time
    // has to step past all of them.
    let mut neighbours: Vec<Span> = Vec::new();

    for other in open_plans(g) {
        if other.id == plan {
            continue;
        }
        let shared: Vec<NodeId> = devices_of(g, &other.ids)
            .intersection(&my_devices)
            .copied()
            .collect();
        if shared.is_empty() {
            continue;
        }
        neighbours.push(other.span);
        if !mine.span.overlaps(other.span) {
            continue;
        }
        let ports: Vec<NodeId> = ports_of(g, &other.ids)
            .intersection(&my_ports)
            .copied()
            .collect();
        let theirs_after_mine = (mine.span.finite() && other.span.finite()).then(|| {
            let bare = is_bare(&other.start);
            let mut from = mine.span.to;
            if bare && from.rem_euclid(DAY) != 0 {
                from += DAY - from.rem_euclid(DAY);
            }
            window_text(
                Span {
                    from,
                    to: from + (other.span.to - other.span.from),
                },
                bare,
            )
        });
        out.push(Clash {
            kind: ClashKind::Plan,
            id: other.id,
            title: text(g, other.id, MaintenancePlanField::Title.key()),
            stage: other.stage,
            devices: named(g, shared),
            ports: named(g, ports),
            window_start: other.start,
            window_end: other.end,
            team: text(g, other.id, MaintenancePlanField::Team.key()),
            assigned_to: text(g, other.id, MaintenancePlanField::AssignedTo.key()),
            author: text(g, other.id, MaintenancePlanField::Author.key()),
            theirs_after_mine,
        });
    }

    // An open issue has no window: it is open now, so it clashes with any window.
    for issue in g
        .nodes_of_kind(NodeKind::Issue)
        .filter(|n| n.absent_since.is_none())
        .map(|n| n.id)
    {
        let stage =
            field_text(g, issue, IssueField::Stage.key()).unwrap_or_else(|| "open".to_owned());
        if stage != "open" {
            continue;
        }
        let ids: Vec<String> = std::iter::once(text(g, issue, IssueField::Device.key()))
            .chain(
                children(g, issue, EdgeKind::HasIssueStep)
                    .into_iter()
                    .flat_map(|s| lines(field_text(g, s, IssueStepField::Targets.key()))),
            )
            .collect();
        let shared: Vec<NodeId> = devices_of(g, &ids)
            .intersection(&my_devices)
            .copied()
            .collect();
        if shared.is_empty() {
            continue;
        }
        let ports: Vec<NodeId> = ports_of(g, &ids).intersection(&my_ports).copied().collect();
        out.push(Clash {
            kind: ClashKind::Issue,
            id: issue,
            title: text(g, issue, IssueField::Title.key()),
            stage,
            devices: named(g, shared),
            ports: named(g, ports),
            window_start: String::new(),
            window_end: String::new(),
            team: String::new(),
            assigned_to: text(g, issue, IssueField::AssignedTo.key()),
            author: text(g, issue, IssueField::Author.key()),
            theirs_after_mine: None,
        });
    }

    // A plan already under way first, then issues, then plans still being planned.
    let rank = |c: &Clash| match (c.kind, c.stage.as_str()) {
        (ClashKind::Plan, "doing") => 0,
        (ClashKind::Issue, _) => 1,
        _ => 2,
    };
    out.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.id.to_string().cmp(&b.id.to_string()))
    });

    let plan_clash = out.iter().any(|c| c.kind == ClashKind::Plan);
    let mine_free = (plan_clash && mine.span.finite())
        .then(|| free_from(mine.span, &neighbours, my_bare))
        .flatten()
        .map(|s| window_text(s, my_bare));
    PlanClashes {
        clashes: out,
        mine_free,
    }
}

/// The earliest span of `mine`'s length, starting at or after it, that overlaps none of `others`.
fn free_from(mine: Span, others: &[Span], bare: bool) -> Option<Span> {
    let len = mine.to - mine.from;
    let mut at = mine.from;
    for _ in 0..=FREE_STEPS {
        let here = Span {
            from: at,
            to: at.checked_add(len)?,
        };
        match others
            .iter()
            .filter(|o| here.overlaps(**o))
            .map(|o| o.to)
            .max()
        {
            None => return Some(here),
            Some(i64::MAX) => return None,
            Some(end) => {
                at = end;
                if bare && at.rem_euclid(DAY) != 0 {
                    at += DAY - at.rem_euclid(DAY);
                }
            }
        }
    }
    None
}

/// A plan under way on a device, for It's down (r105 "trouble" A).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Running {
    pub plan: NodeId,
    /// Its steps already done or skipped that touched the device, newest first.
    pub steps: Vec<NodeId>,
}

/// Plans in Do whose steps touch `device`, with the finished ones there. A plan still being planned
/// has changed nothing, so it is not listed.
pub fn running_on(g: &Graph, device: NodeId) -> Vec<Running> {
    let Some(dev) = g.device_of(device) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for plan in g
        .nodes_of_kind(NodeKind::MaintenancePlan)
        .filter(|n| n.absent_since.is_none())
        .map(|n| n.id)
    {
        if plan_stage(g, plan) != "doing" {
            continue;
        }
        let steps = children(g, plan, EdgeKind::HasStep);
        let touches: BTreeMap<NodeId, bool> = steps
            .iter()
            .map(|s| (*s, devices_of(g, &step_targets(g, *s)).contains(&dev)))
            .collect();
        if !touches.values().any(|t| *t) {
            continue;
        }
        let mut done: Vec<(String, NodeId)> = steps
            .into_iter()
            .filter(|s| touches[s])
            .filter(|s| {
                field_text(g, *s, PlanStepField::State.key()).is_some_and(|st| st != "planned")
            })
            .map(|s| (text(g, s, PlanStepField::DoneAt.key()), s))
            .collect();
        done.sort_by(|a, b| b.0.cmp(&a.0));
        out.push(Running {
            plan,
            steps: done.into_iter().map(|(_, s)| s).collect(),
        });
    }
    out.sort_by_key(|r| r.plan.to_string());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dates_and_times() {
        let day = window_span("2026-11-04", "");
        assert_eq!(day.to - day.from, DAY);
        assert_eq!(window_span("2026-11-04T22:00", "after lunch").to, i64::MAX);
        assert_eq!(window_span("", "").from, i64::MIN);
        let z = window_span("2026-11-04T22:00Z", "2026-11-04T23:00+01:00");
        assert_eq!(z.to - z.from, 0);
        assert_eq!(moment("2026-02-30"), None);
        assert_eq!(moment("2026-11-04T24:00"), None);
        assert_eq!(moment("2026-11-04T22:00:5"), None);
        assert!(moment("2026-11-04T22:00:05.123-05:30").is_some());
        assert_eq!(moment("２０２６-11-04"), None);
    }

    #[test]
    fn end_exclusive_overlap() {
        let a = window_span("2026-11-04T02:00", "2026-11-04T04:00");
        let b = window_span("2026-11-04T04:00", "2026-11-04T06:00");
        assert!(!a.overlaps(b));
        assert!(a.overlaps(window_span("2026-11-04T03:59", "2026-11-04T05:00")));
        assert!(a.overlaps(Span::ALWAYS));
        assert!(!window_span("2026-11-04", "").overlaps(window_span("2026-11-05", "")));
    }

    #[test]
    fn round_trips_text() {
        let s = window_span("2026-12-31T23:30", "2027-01-01T01:00");
        assert_eq!(
            window_text(s, false),
            ("2026-12-31T23:30".to_owned(), "2027-01-01T01:00".to_owned())
        );
        let d = window_span("2028-02-28", "2028-02-29");
        assert_eq!(
            window_text(d, true),
            ("2028-02-28".to_owned(), "2028-02-29".to_owned())
        );
        for days in [-1_000_000, -1, 0, 59, 60, 365, 11_000, 2_000_000] {
            let (y, m, dd) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, dd), days);
        }
    }

    #[test]
    fn free_time_steps_past_every_neighbour() {
        let mine = window_span("2026-11-04T22:00", "2026-11-05T00:00");
        let others = [
            window_span("2026-11-04T23:00", "2026-11-05T01:00"),
            window_span("2026-11-05T01:30", "2026-11-05T02:30"),
        ];
        let got = free_from(mine, &others, false).map(|s| window_text(s, false));
        assert_eq!(
            got,
            Some(("2026-11-05T02:30".to_owned(), "2026-11-05T04:30".to_owned()))
        );
        assert_eq!(free_from(mine, &[Span::ALWAYS], false), None);
        let day = window_span("2026-11-04", "");
        let got = free_from(
            day,
            &[window_span("2026-11-04T09:00", "2026-11-05T09:00")],
            true,
        );
        assert_eq!(
            got.map(|s| window_text(s, true)),
            Some(("2026-11-06".to_owned(), "2026-11-06".to_owned()))
        );
    }

    #[test]
    fn edit_lines_name_what_the_client_names() {
        assert_eq!(edit_targets("cable\tp:1\tp:2"), vec!["p:1", "p:2"]);
        assert_eq!(
            edit_targets("lag\td:1\tae0\tactive\ti:1\ti:2"),
            vec!["d:1", "i:1", "i:2"]
        );
        assert_eq!(edit_targets("field\tx:1\tDevice.hostname\tsw"), vec!["x:1"]);
        assert!(edit_targets("nonsense").is_empty());
    }
}
