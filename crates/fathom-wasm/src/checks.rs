//! Live checks (ADR-0061 §5): the rule pack baked into the module, the incremental engine
//! over the held estate, and the gesture dry run. No rule reads a secret: the checker
//! refuses `Ty::Secret`, and the estate holds no credential (CLAUDE.md rule 4).

use fathom_graph::{Graph, NodeId};
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::NodeKind;
use fathom_rules::engine::{Dirty, Engine, Pack};
use fathom_rules::graph::{box_from_text, delta_since, field_from_boxed, GraphWorld, IrSchema};
use fathom_rules::overlay::{refusals, Ov, Proposal, VirtEdge};
use fathom_rules::rule::{load_rule, Rule};
use fathom_rules::schema::Schema;
use fathom_rules::value::FieldId;

/// `corpus/rules/<id>/rule.yaml`, in id order. `tests/checks.rs` asserts this is the
/// directory, so a rule added there and not here fails loudly.
pub const RULES: &[(&str, &str)] = &[
    (
        "fw.device.behind-chosen-version",
        include_str!("../../../corpus/rules/fw.device.behind-chosen-version/rule.yaml"),
    ),
    (
        "ip.address.different-subnet-on-link",
        include_str!("../../../corpus/rules/ip.address.different-subnet-on-link/rule.yaml"),
    ),
    (
        "ip.address.network-or-broadcast",
        include_str!("../../../corpus/rules/ip.address.network-or-broadcast/rule.yaml"),
    ),
    (
        "ip.address.same-on-link",
        include_str!("../../../corpus/rules/ip.address.same-on-link/rule.yaml"),
    ),
    (
        "l2.vlan.access-mismatch",
        include_str!("../../../corpus/rules/l2.vlan.access-mismatch/rule.yaml"),
    ),
    (
        "l2.vlan.trunk-missing",
        include_str!("../../../corpus/rules/l2.vlan.trunk-missing/rule.yaml"),
    ),
    (
        "phy.cable.copper-in-cage",
        include_str!("../../../corpus/rules/phy.cable.copper-in-cage/rule.yaml"),
    ),
    (
        "phy.cable.fibre-or-dac-in-rj45",
        include_str!("../../../corpus/rules/phy.cable.fibre-or-dac-in-rj45/rule.yaml"),
    ),
    (
        "phy.link.speed-mismatch",
        include_str!("../../../corpus/rules/phy.link.speed-mismatch/rule.yaml"),
    ),
    (
        "phy.link.speed-over-media",
        include_str!("../../../corpus/rules/phy.link.speed-over-media/rule.yaml"),
    ),
    (
        "phy.port.already-cabled",
        include_str!("../../../corpus/rules/phy.port.already-cabled/rule.yaml"),
    ),
    (
        "power.psu.single-fed",
        include_str!("../../../corpus/rules/power.psu.single-fed/rule.yaml"),
    ),
    (
        "topo.switch.single-cable",
        include_str!("../../../corpus/rules/topo.switch.single-cable/rule.yaml"),
    ),
];

pub struct Checks {
    pack: Pack,
    engine: Engine<NodeId>,
    /// The graph the cache was built from, and how much of its log it has seen.
    instance: u64,
    seen: usize,
    /// Set if a baked rule failed to load: the product shows no checks rather than guess.
    pub load_error: Option<String>,
    /// Rules that ran out of budget on some anchor in the last pass: their findings are
    /// incomplete, and the panel says so.
    pub unfinished: usize,
}

impl Checks {
    pub fn new() -> Checks {
        let mut rules: Vec<Rule> = Vec::new();
        let mut load_error = None;
        for (id, text) in RULES {
            match load_rule(text, &format!("rules/{id}/rule.yaml"), id, &IrSchema) {
                Ok(r) => rules.push(r),
                Err(e) => {
                    load_error = Some(e.to_string());
                    rules.clear();
                    break;
                }
            }
        }
        Checks {
            engine: Engine::new(rules.len()),
            pack: Pack { rules },
            instance: 0,
            seen: 0,
            load_error,
            unfinished: 0,
        }
    }

    /// The rules the last `OP_CHECKS` evaluated again, as indexes into [`RULES`].
    pub fn last_run(&self) -> &[usize] {
        &self.engine.last_run
    }

    pub fn rule_count(&self) -> usize {
        self.pack.rules.len()
    }

    /// Bring the cache up to date with `g`, re-running only rules whose read set the
    /// new batches touched.
    fn refresh(&mut self, g: &Graph) {
        let log = g.log().len();
        let dirty = if g.instance() != self.instance || log < self.seen {
            Dirty::All
        } else {
            Dirty::Delta(delta_since(g, self.seen))
        };
        self.engine.refresh(&self.pack, &GraphWorld { g }, &dirty);
        self.instance = g.instance();
        self.seen = log;
        let mut rules: Vec<usize> = self.engine.diagnostics().iter().map(|d| d.rule).collect();
        rules.dedup();
        self.unfinished = rules.len();
    }

    /// Every standing finding, most severe first, as rows.
    pub fn standing(&mut self, g: &Graph) -> Vec<Row> {
        self.refresh(g);
        self.engine
            .findings(&self.pack)
            .iter()
            .map(|f| row(&self.pack, g, f.rule, &[f.anchor], &f.involves))
            .collect()
    }

    /// Refusals a proposed change would add. Empty when it would add none.
    pub fn gesture(&self, g: &Graph, p: &Proposal<NodeId>) -> Vec<Row> {
        let (found, _diags) = refusals(&self.pack, &GraphWorld { g }, p);
        found
            .iter()
            .map(|f| {
                let el = |n: &Ov<NodeId>| match n {
                    Ov::Virt(0) => El::New("the new cable"),
                    Ov::Virt(_) => El::New("the new port"),
                    Ov::Real(r) => El::Old(*r),
                };
                let mut els = vec![el(&f.anchor)];
                els.extend(f.involves.iter().map(el));
                row_opt(&self.pack, g, f.rule, &els)
            })
            .collect()
    }

    pub fn severity_counts(rows: &[Row]) -> [usize; 3] {
        let mut c = [0; 3];
        for r in rows {
            match r.severity {
                "refuse" => c[0] += 1,
                "warn" => c[1] += 1,
                _ => c[2] += 1,
            }
        }
        c
    }
}

impl Default for Checks {
    fn default() -> Checks {
        Checks::new()
    }
}

/// One finding, as the page shows it.
pub struct Row {
    pub rule: String,
    pub severity: &'static str,
    pub title: String,
    pub fix: String,
    pub why: String,
    pub concept: String,
    /// publisher and document, url, then the note, one per line.
    pub source: String,
    /// `display id` TAB `name`, one element per line. An element the proposal would mint
    /// has an empty id.
    pub elements: String,
}

fn row(pack: &Pack, g: &Graph, rule: usize, anchor: &[NodeId], rest: &[NodeId]) -> Row {
    let els: Vec<El> = anchor.iter().chain(rest).map(|n| El::Old(*n)).collect();
    row_opt(pack, g, rule, &els)
}

/// An element of a finding: one in the estate, or one the proposal would create.
enum El {
    Old(NodeId),
    New(&'static str),
}

fn row_opt(pack: &Pack, g: &Graph, rule: usize, els: &[El]) -> Row {
    let m = &pack.rules[rule].meta;
    let source = match m.sources.first() {
        Some(s) => format!("{}, {}\n{}\n{}", s.publisher, s.doc, s.url, s.note),
        None => m.sources_note.clone(),
    };
    let elements = els
        .iter()
        .map(|e| match e {
            El::Old(n) => format!("{n}\t{}", name_of(g, *n)),
            El::New(w) => format!("\t{w}"),
        })
        .collect::<Vec<_>>()
        .join("\n");
    Row {
        rule: m.id.clone(),
        severity: m.severity.word(),
        title: m.title.clone(),
        fix: m.fix.clone(),
        why: m.why.clone(),
        concept: m.concept.clone(),
        source,
        elements,
    }
}

/// A port reads as `device port`; everything else as its own display name.
fn name_of(g: &Graph, n: NodeId) -> String {
    let own = fathom_inventory::display_name(g, n);
    match (n.kind, g.device_of(n)) {
        (NodeKind::PhysicalPort, Some(d)) => {
            format!("{} {own}", fathom_inventory::display_name(g, d))
        }
        _ => own,
    }
}

/// The cable gesture as a proposal: a virtual `Cable` with one `Terminates` edge per known
/// end, and a virtual port for each end the gesture would mint.
pub enum End {
    Port(NodeId),
    Minted,
    Unknown,
}

pub fn cable_proposal(near: &End, far: &End, media: &str) -> Proposal<NodeId> {
    let s = IrSchema;
    let mut p = Proposal::default();
    let (Some(cable), Some(port), Some(term)) = (
        s.kind("Cable"),
        s.kind("PhysicalPort"),
        s.edge("Terminates"),
    ) else {
        return p;
    };
    let mut fields = Vec::new();
    if !media.is_empty() {
        if let Some(info) = s.node_field(cable, "media") {
            let key = FieldKey(info.id.0);
            if let Ok(v) = box_from_text(key, media) {
                fields.push((info.id, field_from_boxed(key, v)));
            }
        }
    }
    p.nodes.push((cable, fields));
    for end in [near, far] {
        let to = match end {
            End::Port(n) => Ov::Real(*n),
            End::Minted => {
                p.nodes.push((port, Vec::new()));
                Ov::Virt((p.nodes.len() - 1) as u32)
            }
            End::Unknown => continue,
        };
        p.edges.push(VirtEdge {
            edge: term.id,
            from: Ov::Virt(0),
            to,
            fields: Vec::new(),
        });
    }
    p
}

/// A field edit as a proposal. `None` when the value does not parse (the write refuses that
/// itself) or the key is not one a rule can read.
pub fn field_proposal(node: NodeId, key: FieldKey, text: &str) -> Option<Proposal<NodeId>> {
    let v = fathom_inventory::parse_into_slot(key, text)
        .or_else(|_| box_from_text(key, text))
        .ok()?;
    let mut p = Proposal::default();
    p.fields
        .push((Ov::Real(node), FieldId(key.0), field_from_boxed(key, v)));
    Some(p)
}
