//! **An AI connection proposes a change to a design** (ADR-0077, amended 2026-10-27).
//!
//! An AI never changes a design itself (owner, 2026-10-27). `change_design` takes the
//! version the AI read, a one-line summary and a list of operations, checks them as they
//! would be made, and keeps them in an idea. The canvas draws the idea in the plan colour
//! before anyone decides; when a person accepts it, [`apply_idea_change`] turns the
//! operations into one `fathom-change 1` batch in that person's name and writes it through
//! the path a browser's change takes (ADR-0063): the same grant check, the same head, the
//! same graph rules and the same credential refusal, streamed to every open browser.
//!
//! What it adds, in order:
//!
//! 1. **Both ticks**: the organisation's and the connection's (decision 1) let an AI
//!    propose a change at all; a folder marked for a second person still needs one at
//!    Accept (decision 2).
//! 2. **The allowlist**: a field may be set, and a node or edge added, only if the reading
//!    shows it at a tier the key sees, cut to `layout` and `notes` (decision 4). A removal
//!    takes what the element holds, as a person's does, and is refused past 20 things, for a
//!    place that still holds anything, and for anything holding what the reading hides.
//! 3. **Never over a person's work**: the proposal names the version it read and is refused
//!    if the design has moved since (decision 6). At Accept it runs on the design as it is
//!    then, and the graph's rules refuse what no longer fits.
//! 4. **Limits**: 200 operations, 10 proposals a minute and 300 a day per connection
//!    (decision 7), and the cap on ideas waiting.
//! 5. **The server's gate on every string** the AI sent, not only the fields a browser's
//!    gate covers (decision 9). A refusal names the operation, never the value.
//!
//! The graph holds `Rc`s and is not `Send`: [`build`] is synchronous and returns bytes.

use std::collections::{BTreeMap, BTreeSet};

use deadpool_postgres::Transaction;
use fathom_canon::Json;
use fathom_graph::{
    Actor, BatchId, Confidence, ElementId, Graph, NodeId, Origin, ProvenanceId, ProvenanceRecord,
    Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::accessors::slot_from_canon;
use fathom_ir::generated::ir_types::{EdgeKind, NodeKind};

use crate::ai::{self, AiError, AiSession};
use crate::ai_reading::{self, Tier};
use crate::ai_work::{self, Level, Rules, Work};
use crate::audit;
use crate::authority::Capability;
use crate::designs::{self, DesignError};
use crate::grants::{self, Authority};
use crate::heads::HeadStore;
use crate::repo::{DesignId, ScopeId};

/// The most operations one change may hold.
pub const MAX_OPERATIONS: usize = 200;
/// Changes one connection may propose in a minute, and in a day, at most; a Steward may set less.
pub const PER_MINUTE: i64 = ai_work::MAX_PER_MINUTE as i64;
pub const PER_DAY: i64 = ai_work::MAX_PER_DAY as i64;
/// The summary, which becomes the change's label in History.
pub const MAX_SUMMARY_CHARS: usize = 120;
/// What an accepted idea's change is labelled in History: the person's edit, from an AI's
/// idea. A batch label is at most 60 bytes.
const IDEA_LABEL_PREFIX: &str = "AI idea: ";
const LABEL_MAX_BYTES: usize = 60;

/// The longest name an operation may give what it adds, for later operations to use.
const MAX_NAME_CHARS: usize = 40;

/// One operation as the AI sent it, before it is checked against the design. An element is
/// named by the id the reading gave (`kind:ULID`) or by the name an earlier `add_node` or
/// `add_edge` of the same change gave what it added.
#[derive(Debug, Clone, PartialEq)]
pub enum Ask {
    /// Set one field, or clear it with `Json::Null`.
    Set {
        element: String,
        field: String,
        value: Json,
    },
    /// Add a node of a kind the reading shows, with fields of its own.
    AddNode {
        kind: String,
        name: Option<String>,
        fields: Vec<(String, Json)>,
    },
    /// Add an edge of a kind the reading shows, between two nodes it shows.
    AddEdge {
        kind: String,
        from: String,
        to: String,
        name: Option<String>,
        fields: Vec<(String, Json)>,
    },
    /// Remove an element, and what it holds, as a person's removal does.
    Remove { element: String },
}

impl Ask {
    /// How many operations of the change this one is, for the 200 limit: an add counts its
    /// fields too, since each is one operation in the stored change.
    fn weight(&self) -> usize {
        match self {
            Ask::AddNode { fields, .. } | Ask::AddEdge { fields, .. } => 1 + fields.len(),
            _ => 1,
        }
    }
}

/// A whole request, read but not yet checked against the design.
#[derive(Debug, Clone, PartialEq)]
pub struct Asked {
    pub version: i64,
    pub summary: String,
    pub ops: Vec<Ask>,
}

fn op_refused(index: usize, why: impl Into<String>) -> AiError {
    AiError::Operation {
        index,
        why: why.into(),
    }
}

/// Whether any string inside `value` reads as a password or key.
fn carries_secret(value: &Json) -> bool {
    match value {
        Json::Str(s) => fathom_ingest::redact::looks_like_credential_bare(s),
        Json::Arr(items) => items.iter().any(carries_secret),
        Json::Obj(map) => map.iter().any(|(k, v)| {
            fathom_ingest::redact::looks_like_credential_bare(k) || carries_secret(v)
        }),
        _ => false,
    }
}

const SECRET: &str = "looks as if it carries a password or key, so the change was not taken";

fn take_str(o: &mut BTreeMap<String, Json>, key: &str) -> Option<String> {
    match o.remove(key) {
        Some(Json::Str(s)) => Some(s),
        _ => None,
    }
}

/// A name an add gives what it adds: letters, digits, `-` and `_`, so it can never be
/// mistaken for an id, which has a `:`.
fn take_name(o: &mut BTreeMap<String, Json>, index: usize) -> Result<Option<String>, AiError> {
    match o.remove("as") {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Str(n))
            if (1..=MAX_NAME_CHARS).contains(&n.chars().count())
                && n.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
        {
            Ok(Some(n))
        }
        _ => Err(op_refused(
            index,
            "gives a name that is not 1 to 40 letters, digits, - or _",
        )),
    }
}

fn take_fields(
    o: &mut BTreeMap<String, Json>,
    index: usize,
) -> Result<Vec<(String, Json)>, AiError> {
    match o.remove("fields") {
        None | Some(Json::Null) => Ok(Vec::new()),
        Some(Json::Obj(f)) => {
            if f.values().any(carries_secret) {
                return Err(op_refused(index, SECRET));
            }
            Ok(f.into_iter().collect())
        }
        _ => Err(op_refused(
            index,
            "gives fields that are not an object of name to value",
        )),
    }
}

/// Read a request: `{version, summary, operations}`, canonical JSON, nothing else in it.
/// Each operation is `{op: "set", element, field, value}`, `{op: "add_node", kind, as?,
/// fields?}`, `{op: "add_edge", kind, from, to, as?, fields?}` or `{op: "remove", element}`.
pub fn read_ask(body: &[u8]) -> Result<Asked, AiError> {
    let bad = || {
        AiError::Malformed(
            "a change is {version, summary, operations: [...]}, each operation set, add_node, \
             add_edge or remove",
        )
    };
    let Ok(Json::Obj(mut m)) = Json::parse_canonical(body) else {
        return Err(bad());
    };
    if m.keys()
        .any(|k| !["version", "summary", "operations"].contains(&k.as_str()))
    {
        return Err(bad());
    }
    let version = match m.remove("version") {
        Some(Json::Int(v)) if v >= 1 => v,
        _ => {
            return Err(AiError::Malformed(
                "version is the design version read_design gave",
            ))
        }
    };
    let summary = match m.remove("summary") {
        Some(Json::Str(s)) => ai::clean_line(&s, MAX_SUMMARY_CHARS, false)?,
        _ => return Err(bad()),
    };
    let Some(Json::Arr(raw)) = m.remove("operations") else {
        return Err(bad());
    };
    if raw.is_empty() || raw.len() > MAX_OPERATIONS {
        return Err(AiError::Malformed("a change has 1 to 200 operations"));
    }
    let mut ops = Vec::with_capacity(raw.len());
    for (index, op) in raw.into_iter().enumerate() {
        let Json::Obj(mut o) = op else {
            return Err(op_refused(index, "is not an object"));
        };
        let verb = take_str(&mut o, "op").unwrap_or_default();
        let allowed: &[&str] = match verb.as_str() {
            "set" => &["element", "field", "value"],
            "add_node" => &["kind", "as", "fields"],
            "add_edge" => &["kind", "from", "to", "as", "fields"],
            "remove" => &["element"],
            _ => {
                return Err(op_refused(
                    index,
                    "is not set, add_node, add_edge or remove",
                ))
            }
        };
        if let Some(extra) = o.keys().find(|k| !allowed.contains(&k.as_str())) {
            return Err(op_refused(
                index,
                format!("has {extra:?}, which a {verb} does not take"),
            ));
        }
        let missing = || op_refused(index, format!("is a {verb} without everything it needs"));
        let ask = match verb.as_str() {
            "set" => {
                let element = take_str(&mut o, "element").ok_or_else(missing)?;
                let field = take_str(&mut o, "field").ok_or_else(missing)?;
                let value = o.remove("value").ok_or_else(missing)?;
                if carries_secret(&value) {
                    return Err(op_refused(index, SECRET));
                }
                Ask::Set {
                    element,
                    field,
                    value,
                }
            }
            "add_node" => Ask::AddNode {
                kind: take_str(&mut o, "kind").ok_or_else(missing)?,
                name: take_name(&mut o, index)?,
                fields: take_fields(&mut o, index)?,
            },
            "add_edge" => Ask::AddEdge {
                kind: take_str(&mut o, "kind").ok_or_else(missing)?,
                from: take_str(&mut o, "from").ok_or_else(missing)?,
                to: take_str(&mut o, "to").ok_or_else(missing)?,
                name: take_name(&mut o, index)?,
                fields: take_fields(&mut o, index)?,
            },
            _ => Ask::Remove {
                element: take_str(&mut o, "element").ok_or_else(missing)?,
            },
        };
        ops.push(ask);
    }
    if ops.iter().map(Ask::weight).sum::<usize>() > MAX_OPERATIONS {
        return Err(AiError::Malformed(
            "a change has at most 200 operations, counting each field an add sets",
        ));
    }
    Ok(Asked {
        version,
        summary,
        ops,
    })
}

/// The change's label: the summary after `prefix`, cut on a character boundary.
fn label_of(prefix: &str, summary: &str) -> String {
    let mut label = String::from(prefix);
    for c in summary.chars() {
        if label.len() + c.len_utf8() > LABEL_MAX_BYTES {
            break;
        }
        label.push(c);
    }
    label.trim_end().to_string()
}

/// Kinds that hold others: removing one that still holds anything is refused (decision 4),
/// so a whole site does not go in one call.
fn holds_others(kind: NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Site | NodeKind::Premises | NodeKind::Rack | NodeKind::Surface
    )
}

fn live_nodes(graph: &Graph) -> BTreeSet<NodeId> {
    graph
        .nodes()
        .filter(|n| n.absent_since.is_none())
        .map(|n| n.id)
        .collect()
}

/// Everything [`build`] works with while it runs the operations on a copy of the design.
struct Builder<'a, F: FnMut() -> Ulid> {
    graph: Graph,
    tiers: &'a BTreeSet<Tier>,
    rules: &'a Rules,
    by: Actor,
    at: Timestamp,
    next_id: F,
    provenance: Vec<ProvenanceRecord>,
    values: Vec<Json>,
    named: BTreeMap<String, ElementId>,
    /// What this change itself adds: a field set on one is part of adding it.
    added: BTreeSet<ElementId>,
    removed: usize,
}

impl<F: FnMut() -> Ulid> Builder<'_, F> {
    fn record(&mut self) -> ProvenanceRecord {
        let rec = ProvenanceRecord {
            id: ProvenanceId((self.next_id)()),
            origin: Origin::Hand,
            asserted_at: self.at,
            asserted_by: self.by,
            confidence: Confidence::Asserted,
            supersedes: None,
        };
        self.provenance.push(rec.clone());
        rec
    }

    /// Whether the organisation, the connection and the server all let an AI propose `work`.
    fn permit(&self, index: usize, work: Work) -> Result<(), AiError> {
        if self.rules.levels.get(work) == Level::Propose {
            Ok(())
        } else {
            Err(op_refused(
                index,
                format!(
                    "is {}, which this connection may not propose; send steps only",
                    work.words()
                ),
            ))
        }
    }

    /// Whether the Steward's list of the only kinds lets this kind be added or removed.
    fn only_kind(&self, index: usize, kind: &str) -> Result<(), AiError> {
        if self.rules.only.kind(kind) {
            Ok(())
        } else {
            Err(op_refused(
                index,
                format!("touches a {kind}, which this organisation keeps from AI apps"),
            ))
        }
    }

    /// An element the reading gave, live and of a kind it shows, or one this change added.
    fn resolve(&self, index: usize, raw: &str) -> Result<ElementId, AiError> {
        let raw = raw.trim();
        if let Some(e) = self.named.get(raw) {
            return Ok(*e);
        }
        let not_there = || op_refused(index, "names nothing the reading of this design gave");
        let element = ElementId::parse(raw).map_err(|_| not_there())?;
        let shown = match element {
            ElementId::Node(n) => {
                self.graph
                    .node(n)
                    .is_some_and(|node| node.absent_since.is_none())
                    && ai_reading::shows_node_kind(self.tiers, n.kind)
            }
            ElementId::Edge(e) => self.graph.edge(e).is_some_and(|edge| {
                edge.absent_since.is_none()
                    && ai_reading::shows_edge_kind(self.tiers, e.kind)
                    && [edge.from, edge.to].iter().all(|n| {
                        self.graph
                            .node(*n)
                            .is_some_and(|node| node.absent_since.is_none())
                            && ai_reading::shows_node_kind(self.tiers, n.kind)
                    })
            }),
        };
        if shown {
            Ok(element)
        } else {
            Err(not_there())
        }
    }

    fn resolve_node(&self, index: usize, raw: &str) -> Result<NodeId, AiError> {
        match self.resolve(index, raw)? {
            ElementId::Node(n) => Ok(n),
            ElementId::Edge(_) => Err(op_refused(index, "joins an edge, not a node")),
        }
    }

    fn set(
        &mut self,
        index: usize,
        element: ElementId,
        field: &str,
        value: &Json,
    ) -> Result<(), AiError> {
        let key = match element {
            ElementId::Node(n) => ai_reading::settable_node_field(self.tiers, n.kind, field),
            ElementId::Edge(e) => ai_reading::settable_edge_field(self.tiers, e.kind, field),
        }
        .ok_or_else(|| {
            op_refused(
                index,
                format!("sets {field:?}, which this connection may not change"),
            )
        })?;
        let (kind, work) = match element {
            ElementId::Node(n) if self.added.contains(&element) => {
                (n.kind.name(), ai_work::work_of_node(n.kind))
            }
            ElementId::Node(n) => (n.kind.name(), ai_work::work_of_node_field(n.kind, field)),
            ElementId::Edge(e) => (e.kind.name(), ai_work::work_of_edge(e.kind)),
        };
        self.permit(index, work)?;
        if !self.rules.only.field(kind, field) {
            return Err(op_refused(
                index,
                format!("sets {field:?} on a {kind}, which this organisation keeps from AI apps"),
            ));
        }
        let rec = self.record();
        if *value == Json::Null {
            return self
                .graph
                .clear_field(element, key, rec)
                .map_err(|e| op_refused(index, format!("is refused by the design's rules: {e}")));
        }
        let boxed = slot_from_canon(key, value)
            .map_err(|_| op_refused(index, format!("gives {field:?} a value it does not take")))?;
        self.values.push(value.clone());
        self.graph
            .set_field_boxed(element, key, boxed, rec)
            .map_err(|e| op_refused(index, format!("is refused by the design's rules: {e}")))
    }

    fn name(
        &mut self,
        index: usize,
        name: &Option<String>,
        element: ElementId,
    ) -> Result<(), AiError> {
        if let Some(n) = name {
            if self.named.insert(n.clone(), element).is_some() {
                return Err(op_refused(index, "gives a name an earlier operation gave"));
            }
        }
        Ok(())
    }

    fn run(&mut self, index: usize, ask: &Ask) -> Result<(), AiError> {
        match ask {
            Ask::Set {
                element,
                field,
                value,
            } => {
                let element = self.resolve(index, element)?;
                self.set(index, element, field, value)
            }
            Ask::AddNode { kind, name, fields } => {
                let kind = NodeKind::from_name(kind)
                    .filter(|k| ai_reading::settable_node_kind(self.tiers, *k))
                    .ok_or_else(|| op_refused(index, "adds a kind this connection may not add"))?;
                self.permit(index, ai_work::work_of_node(kind))?;
                self.only_kind(index, kind.name())?;
                let rec = self.record();
                let ulid = (self.next_id)();
                let node = self.graph.insert_node(kind, ulid, rec).map_err(|e| {
                    op_refused(index, format!("is refused by the design's rules: {e}"))
                })?;
                self.added.insert(node.into());
                self.name(index, name, node.into())?;
                for (field, value) in fields {
                    self.set(index, node.into(), field, value)?;
                }
                Ok(())
            }
            Ask::AddEdge {
                kind,
                from,
                to,
                name,
                fields,
            } => {
                let kind = EdgeKind::from_name(kind)
                    .filter(|k| ai_reading::settable_edge_kind(self.tiers, *k))
                    .ok_or_else(|| op_refused(index, "adds a kind this connection may not add"))?;
                self.permit(index, ai_work::work_of_edge(kind))?;
                self.only_kind(index, kind.name())?;
                let from = self.resolve_node(index, from)?;
                let to = self.resolve_node(index, to)?;
                let rec = self.record();
                let ulid = (self.next_id)();
                let edge = self
                    .graph
                    .insert_edge(kind, ulid, from, to, rec)
                    .map_err(|e| {
                        op_refused(index, format!("is refused by the design's rules: {e}"))
                    })?;
                self.added.insert(edge.into());
                self.name(index, name, edge.into())?;
                for (field, value) in fields {
                    self.set(index, edge.into(), field, value)?;
                }
                Ok(())
            }
            Ask::Remove { element } => {
                let element = self.resolve(index, element)?;
                let (kind, work) = match element {
                    ElementId::Node(n) => (n.kind.name(), ai_work::work_of_node(n.kind)),
                    ElementId::Edge(e) => (e.kind.name(), ai_work::work_of_edge(e.kind)),
                };
                self.permit(index, work)?;
                self.only_kind(index, kind)?;
                let before = live_nodes(&self.graph);
                self.graph
                    .tombstone(element, self.at, self.by)
                    .map_err(|e| {
                        op_refused(index, format!("is refused by the design's rules: {e}"))
                    })?;
                let gone: Vec<NodeId> = before
                    .difference(&live_nodes(&self.graph))
                    .copied()
                    .collect();
                if let ElementId::Node(n) = element {
                    if holds_others(n.kind) && gone.len() > 1 {
                        return Err(op_refused(
                            index,
                            "removes a place that still holds things; remove what it holds \
                             first, or send an idea",
                        ));
                    }
                }
                if gone
                    .iter()
                    .any(|n| !ai_reading::shows_node_kind(self.tiers, n.kind))
                {
                    return Err(op_refused(
                        index,
                        "removes something that holds what this connection cannot see; a \
                         person removes it",
                    ));
                }
                self.removed += gone.len().max(1);
                if self.removed > self.rules.max_removals {
                    return Err(op_refused(
                        index,
                        format!(
                            "takes this change past {} removals, counting what each takes with \
                             it; split it, or send steps only",
                            self.rules.max_removals
                        ),
                    ));
                }
                Ok(())
            }
        }
    }
}

/// What [`build`] hands back: the change document, and the names the AI gave.
pub struct Built {
    pub doc: Vec<u8>,
    pub named: BTreeMap<String, String>,
}

/// Run a request on a copy of `graph`, as `actor`, and write what it did as one
/// `fathom-change 1` document. The graph's own rules refuse what a browser's change would
/// be refused for; on top of them every element must be one the reading shows, every
/// field and kind on the allowlist at `tiers`, each kind of work at a level `rules` lets it be proposed, and removals within
/// `rules.max_removals`.
/// `next_id` hands out every id the change mints.
#[allow(clippy::too_many_arguments)]
pub fn build(
    graph: &Graph,
    tiers: &BTreeSet<Tier>,
    rules: &Rules,
    label_prefix: &str,
    asked: &Asked,
    actor: Ulid,
    now_ms: u64,
    mut next_id: impl FnMut() -> Ulid,
) -> Result<Built, AiError> {
    let batch_id = BatchId(next_id());
    let mut b = Builder {
        graph: graph.clone(),
        tiers,
        rules,
        by: Actor::User(UserId(actor)),
        at: Timestamp(now_ms),
        next_id,
        provenance: Vec::new(),
        values: Vec::new(),
        named: BTreeMap::new(),
        added: BTreeSet::new(),
        removed: 0,
    };
    b.graph
        .begin_batch(batch_id, &label_of(label_prefix, &asked.summary))
        .map_err(|_| AiError::Unverifiable("a stored design with a batch open"))?;
    for (index, ask) in asked.ops.iter().enumerate() {
        b.run(index, ask)?;
    }
    b.graph
        .end_batch()
        .map_err(|_| AiError::Unverifiable("a batch this server opened"))?;
    let batch = b
        .graph
        .log()
        .last()
        .cloned()
        .ok_or(AiError::Unverifiable("a batch this server closed"))?;
    let mut provenance = b.provenance;
    provenance.sort_by_key(|r| r.id);
    let change = fathom_workspace::Change {
        batch,
        provenance,
        values: b.values,
    };
    Ok(Built {
        doc: fathom_workspace::write_change(&change),
        named: b
            .named
            .into_iter()
            .map(|(k, v)| (k, v.to_string()))
            .collect(),
    })
}

/// Read the design, run `asked` on it as the caller and write the result through the
/// browser's write path (ADR-0063). The operations run on the design as it is now, and the
/// graph's rules refuse whatever no longer fits.
#[allow(clippy::too_many_arguments)]
async fn build_and_write(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    heads: &HeadStore,
    design: DesignId,
    scope: ScopeId,
    tiers: &BTreeSet<Tier>,
    rules: &Rules,
    label_prefix: &str,
    asked: &Asked,
) -> Result<(Built, designs::ChangeWritten), AiError> {
    let stored =
        designs::read_version_in_tx(tx, auth, Some(heads), design, Some(scope), None).await?;
    let built = {
        let graph = fathom_workspace::read_plain(&stored.payload)
            .map_err(|_| AiError::Unverifiable("a stored design that does not parse"))?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        build(
            &graph,
            tiers,
            rules,
            label_prefix,
            asked,
            auth.ctx.actor().0,
            now_ms,
            crate::ids::new_ulid,
        )?
    };
    let schema_minor: i32 = fathom_ir::generated::ir_types::SCHEMA_VERSION
        .strip_prefix("0.")
        .and_then(|minor| minor.parse().ok())
        .ok_or(AiError::Unverifiable("this server's schema version"))?;
    let written = designs::write_change_in_tx(
        tx,
        auth,
        heads,
        design,
        Some(scope),
        &built.doc,
        schema_minor,
        stored.version,
        true,
        &audit::SpoolBounds::from_env(),
    )
    .await
    .map_err(|e| match e {
        DesignError::ChangeAhead { current, .. } => AiError::Moved {
            read: stored.version,
            current,
        },
        DesignError::ChangeRefused(why) if why.contains("credential") => AiError::LooksSecret,
        DesignError::ChangeRefused(_) => AiError::NotAllowed(
            "the design's own rules refused this change; read it again and check each operation",
        ),
        // The person's own grant refused it: the same answer as any act they may not do.
        DesignError::Authority(e) => AiError::Authority(e),
        other => AiError::Design(other),
    })?;
    Ok((built, written))
}

/// The change an idea carries (ADR-0072 decision 7, amended): read and run on the design
/// as it is now, without writing, so an idea that cannot be made is refused when it is sent.
#[allow(clippy::too_many_arguments)]
pub async fn check_idea_change(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    heads: Option<&HeadStore>,
    design: DesignId,
    scope: ScopeId,
    tiers: &BTreeSet<Tier>,
    rules: &Rules,
    asked: &Asked,
) -> Result<(), AiError> {
    // A connection lends no more than its owner holds: a change its owner could not make
    // is not proposed in their name.
    grants::authorise_account(tx, auth, Some(scope), Capability::Draw).await?;
    let stored = designs::read_version_in_tx(tx, auth, heads, design, Some(scope), None).await?;
    if stored.version != asked.version {
        return Err(AiError::Moved {
            read: asked.version,
            current: stored.version,
        });
    }
    let graph = fathom_workspace::read_plain(&stored.payload)
        .map_err(|_| AiError::Unverifiable("a stored design that does not parse"))?;
    build(
        &graph,
        tiers,
        rules,
        IDEA_LABEL_PREFIX,
        asked,
        auth.ctx.actor().0,
        0,
        crate::ids::new_ulid,
    )
    .map(|_| ())
}

/// Accepting an idea that carries a change: the change made now, as the person accepting
/// it, on the design as it is now. It is their own edit, labelled as from an AI's idea, and
/// not counted against the connection's limits.
#[allow(clippy::too_many_arguments)]
pub async fn apply_idea_change(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    heads: &HeadStore,
    design: DesignId,
    scope: ScopeId,
    tiers: &BTreeSet<Tier>,
    asked: &Asked,
) -> Result<designs::ChangeWritten, AiError> {
    build_and_write(
        tx,
        auth,
        heads,
        design,
        scope,
        tiers,
        &Rules::open(),
        IDEA_LABEL_PREFIX,
        asked,
    )
    .await
    .map(|(_, written)| written)
}

/// The proposals one connection may send in a minute and a day (decision 7), counted from the
/// ideas it sent with a change, whatever became of them.
pub async fn within_rate(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    key_id: &str,
    policy: &ai::Policy,
) -> Result<(), AiError> {
    let tenant = auth.ctx.tenant().to_string();
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        &[&format!("ai_proposals:{key_id}")],
    )
    .await?;
    let counts = tx
        .query_one(
            "SELECT count(*) FILTER (WHERE created_at > now() - interval '1 minute'), \
                    count(*) FILTER (WHERE created_at > now() - interval '1 day') \
             FROM ai_recommendations WHERE organisation_id = $1 AND key_id = $2",
            &[&tenant, &key_id],
        )
        .await?;
    let (minute, day): (i64, i64) = (counts.get(0), counts.get(1));
    // A Steward may lower the limits, never raise them past the fixed ones.
    let per_minute = (policy.per_minute as i64).clamp(1, PER_MINUTE);
    let per_day = (policy.per_day as i64).clamp(1, PER_DAY);
    if minute >= per_minute {
        return Err(AiError::LimitReached(format!(
            "this connection sent {per_minute} ideas in the last minute; try again in a minute"
        )));
    }
    if day >= per_day {
        return Err(AiError::LimitReached(format!(
            "this connection sent {per_day} ideas today; try again tomorrow"
        )));
    }
    Ok(())
}

/// What a proposed change touches, for the canvas to draw before anyone accepts it: the
/// elements it sets a field on, the ones it removes, the nodes it adds and the edges it
/// draws, each end as the reading named it.
pub fn preview(asked: &Asked) -> Json {
    let mut changes = BTreeSet::new();
    let mut removes = BTreeSet::new();
    let mut adds = Vec::new();
    let mut links = Vec::new();
    let name_json = |n: &Option<String>| n.clone().map_or(Json::Null, Json::Str);
    for op in &asked.ops {
        match op {
            Ask::Set { element, .. } => {
                changes.insert(element.clone());
            }
            Ask::Remove { element } => {
                removes.insert(element.clone());
            }
            Ask::AddNode { kind, name, .. } => {
                let mut m = BTreeMap::new();
                m.insert("kind".into(), Json::Str(kind.clone()));
                m.insert("name".into(), name_json(name));
                adds.push(Json::Obj(m));
            }
            Ask::AddEdge { kind, from, to, .. } => {
                let mut m = BTreeMap::new();
                m.insert("kind".into(), Json::Str(kind.clone()));
                m.insert("from".into(), Json::Str(from.clone()));
                m.insert("to".into(), Json::Str(to.clone()));
                links.push(Json::Obj(m));
            }
        }
    }
    // A field set on what the same change removes is the removal, not a change.
    changes.retain(|e| !removes.contains(e));
    let ids = |set: BTreeSet<String>| Json::Arr(set.into_iter().map(Json::Str).collect());
    let mut m = BTreeMap::new();
    m.insert("changes".into(), ids(changes));
    m.insert("removes".into(), ids(removes));
    m.insert("adds".into(), Json::Arr(adds));
    m.insert("links".into(), Json::Arr(links));
    Json::Obj(m)
}

/// `POST /ai/v1/designs/{d}/changes`: propose one change to a design. An AI never changes a
/// design itself (owner, 2026-10-27): the change is checked as it would be made, then waits
/// as an idea, drawn on the canvas in the plan colour, until a person accepts it, when it is
/// made in that person's name. The body is `{version, summary, operations}`; the summary is
/// the idea's title and its one step.
pub async fn change_design(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    heads: &HeadStore,
    session: &AiSession,
    design: DesignId,
    body: &[u8],
) -> Result<ai::Idea, AiError> {
    let asked = read_ask(body)?;
    let Ok(Json::Obj(mut m)) = Json::parse_canonical(body) else {
        return Err(AiError::Malformed(
            "a change is {version, summary, operations}",
        ));
    };
    let mut step = BTreeMap::new();
    step.insert("action".into(), Json::Str("change".into()));
    step.insert("text".into(), Json::Str(asked.summary.clone()));
    let mut change = BTreeMap::new();
    change.insert("version".into(), Json::Int(asked.version));
    change.insert(
        "operations".into(),
        m.remove("operations").unwrap_or(Json::Null),
    );
    let mut idea = BTreeMap::new();
    idea.insert("title".into(), Json::Str(asked.summary.clone()));
    idea.insert("steps".into(), Json::Arr(vec![Json::Obj(step)]));
    idea.insert("change".into(), Json::Obj(change));
    ai::recommend(
        tx,
        auth,
        Some(heads),
        session,
        design,
        &Json::Obj(idea).to_canonical_bytes(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_work::Levels;

    fn body(j: &str) -> Vec<u8> {
        crate::json_in::parse(j.as_bytes())
            .expect("test JSON")
            .to_canonical_bytes()
    }

    #[test]
    fn a_request_is_read_strictly() {
        let ok = read_ask(&body(
            r#"{"version":3,"summary":"Name the core switch","operations":[{"op":"set","element":"device:01ARZ3NDEKTSV4RRFFQ69G5FAV","field":"name","value":"core-1"}]}"#,
        ))
        .unwrap();
        assert_eq!(ok.version, 3);
        assert_eq!(ok.ops.len(), 1);
        for bad in [
            r#"{"version":3,"summary":"x","operations":[]}"#,
            r#"{"version":0,"summary":"x","operations":[{"op":"set","element":"a","field":"b","value":1}]}"#,
            r#"{"version":3,"summary":"x","operations":[{"op":"tombstone","element":"a"}]}"#,
            r#"{"version":3,"summary":"x","operations":[{"op":"set","element":"a","field":"b"}]}"#,
            r#"{"version":3,"summary":"x","extra":1,"operations":[{"op":"set","element":"a","field":"b","value":1}]}"#,
        ] {
            assert!(read_ask(&body(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_secret_anywhere_in_a_value_is_refused_by_operation_never_echoed() {
        let secret = "enable secret 5 $1$mERr$hx5rVt7rPNoS4wqbXKX7m0";
        let j = format!(
            r#"{{"version":3,"summary":"x","operations":[{{"op":"set","element":"a","field":"b","value":"ok"}},{{"op":"set","element":"a","field":"c","value":["fine",{secret:?}]}}]}}"#
        );
        match read_ask(&body(&j)) {
            Err(AiError::Operation { index, why }) => {
                assert_eq!(index, 1);
                assert!(!why.contains("mERr"));
            }
            Err(other) => panic!("refused for the wrong reason: {other}"),
            Ok(_) => panic!("a secret was let through"),
        }
    }

    #[test]
    fn the_label_is_the_summary_cut_to_sixty_bytes() {
        assert_eq!(label_of(IDEA_LABEL_PREFIX, "Name it"), "AI idea: Name it");
        let long = "é".repeat(100);
        let l = label_of(IDEA_LABEL_PREFIX, &long);
        assert!(l.len() <= LABEL_MAX_BYTES && l.starts_with(IDEA_LABEL_PREFIX));
    }

    fn fixture() -> Graph {
        let rec = |n: u128| ProvenanceRecord {
            id: ProvenanceId(Ulid(n)),
            origin: Origin::Hand,
            asserted_at: Timestamp(0),
            asserted_by: Actor::User(UserId(Ulid(9_999))),
            confidence: Confidence::Asserted,
            supersedes: None,
        };
        let mut g = Graph::new();
        g.begin_batch(BatchId(Ulid(1)), "fixture").unwrap();
        let premises = g.insert_node(NodeKind::Premises, Ulid(4), rec(5)).unwrap();
        let rack = g.insert_node(NodeKind::Rack, Ulid(2), rec(3)).unwrap();
        g.insert_edge(EdgeKind::HasRack, Ulid(6), premises, rack, rec(7))
            .unwrap();
        for i in 0..25u128 {
            g.insert_node(NodeKind::Device, Ulid(100 + i), rec(200 + i))
                .unwrap();
        }
        // The last device holds a policy set, which no reading shows.
        let holder = fathom_graph::NodeId {
            kind: NodeKind::Device,
            ulid: Ulid(124),
        };
        let policies = g
            .insert_node(NodeKind::PolicySet, Ulid(50), rec(51))
            .unwrap();
        g.insert_edge(EdgeKind::HasPolicySet, Ulid(52), holder, policies, rec(53))
            .unwrap();
        g.end_batch().unwrap();
        g
    }

    fn ids() -> impl FnMut() -> Ulid {
        let mut n = 10_000u128;
        move || {
            n += 1;
            Ulid(n)
        }
    }

    fn ask(ops: &str) -> Asked {
        read_ask(&body(&format!(
            r#"{{"version":1,"summary":"test","operations":[{ops}]}}"#
        )))
        .expect("a request that reads")
    }

    fn layout() -> BTreeSet<Tier> {
        BTreeSet::from([Tier::Layout])
    }

    fn device(i: u128) -> String {
        fathom_graph::NodeId {
            kind: NodeKind::Device,
            ulid: Ulid(100 + i),
        }
        .to_string()
    }

    #[test]
    fn an_add_is_named_and_a_later_operation_uses_the_name() {
        let g = fixture();
        let a = ask(&format!(
            r#"{{"op":"add_node","kind":"Device","as":"core","fields":{{"hostname":"core-1"}}}},{{"op":"set","element":"core","field":"role","value":null}},{{"op":"add_node","kind":"Chassis","as":"c1"}},{{"op":"add_edge","kind":"HasChassis","from":"core","to":"c1"}},{{"op":"add_edge","kind":"MountedIn","from":"c1","to":{:?}}}"#,
            fathom_graph::NodeId {
                kind: NodeKind::Rack,
                ulid: Ulid(2)
            }
            .to_string()
        ));
        let built = build(
            &g,
            &layout(),
            &Rules::open(),
            IDEA_LABEL_PREFIX,
            &a,
            Ulid(9_999),
            5,
            ids(),
        )
        .expect("built");
        let change = fathom_workspace::read_change(&built.doc).expect("reads back");
        assert!(built.named["core"].starts_with("device:"));
        // Add, set hostname, clear role, add the chassis, two edges: six operations, six
        // records, one value.
        assert_eq!(change.batch.ops.len(), 6);
        assert_eq!(change.provenance.len(), 6);
        assert_eq!(change.values, vec![Json::Str("core-1".into())]);
        let mut applied = g.clone();
        fathom_workspace::apply_change(&mut applied, &change, Actor::User(UserId(Ulid(9_999))))
            .expect("the head would take it");
    }

    fn refusal(rules: &Rules, ops: &str) -> String {
        match build(
            &fixture(),
            &layout(),
            rules,
            IDEA_LABEL_PREFIX,
            &ask(ops),
            Ulid(9_999),
            5,
            ids(),
        ) {
            Err(AiError::Operation { why, .. }) => why,
            Err(other) => panic!("refused for the wrong reason: {other}"),
            Ok(_) => panic!("let through"),
        }
    }

    #[test]
    fn a_kind_of_work_below_propose_is_refused_whatever_the_reading_allows() {
        let mut rules = Rules::open();
        rules.levels = Levels([Level::Ideas, Level::Propose, Level::Propose, Level::Off]);
        let why = refusal(&rules, r#"{"op":"add_node","kind":"Device"}"#);
        assert!(why.contains("editing the design"), "{why}");
        let rename = format!(
            r#"{{"op":"set","element":{:?},"field":"hostname","value":"core-1"}}"#,
            device(1)
        );
        assert!(refusal(&rules, &rename).contains("editing the design"));
        let remove = format!(r#"{{"op":"remove","element":{:?}}}"#, device(1));
        assert!(refusal(&rules, &remove).contains("editing the design"));
    }

    #[test]
    fn the_only_list_keeps_every_other_kind_and_field_out() {
        let mut rules = Rules::open();
        rules.only = ai_work::Only::parse(&["Device.hostname".into()]).unwrap();
        let rename = format!(
            r#"{{"op":"set","element":{:?},"field":"hostname","value":"core-1"}}"#,
            device(1)
        );
        assert!(build(
            &fixture(),
            &layout(),
            &rules,
            IDEA_LABEL_PREFIX,
            &ask(&rename),
            Ulid(9_999),
            5,
            ids(),
        )
        .is_ok());
        let role = format!(
            r#"{{"op":"set","element":{:?},"field":"role","value":null}}"#,
            device(1)
        );
        assert!(refusal(&rules, &role).contains("keeps from AI apps"));
        // A field on the list does not let the kind be added or removed.
        assert!(
            refusal(&rules, r#"{"op":"add_node","kind":"Device"}"#).contains("keeps from AI apps")
        );
        let remove = format!(r#"{{"op":"remove","element":{:?}}}"#, device(1));
        assert!(refusal(&rules, &remove).contains("keeps from AI apps"));
    }

    #[test]
    fn a_steward_may_lower_the_removals_one_change_takes() {
        let mut rules = Rules::open();
        rules.max_removals = 1;
        let two = format!(
            r#"{{"op":"remove","element":{:?}}},{{"op":"remove","element":{:?}}}"#,
            device(1),
            device(2)
        );
        assert!(refusal(&rules, &two).contains("past 1 removals"));
        rules.max_removals = 0;
        let one = format!(r#"{{"op":"remove","element":{:?}}}"#, device(1));
        assert!(refusal(&rules, &one).contains("past 0 removals"));
    }

    #[test]
    fn a_kind_or_field_the_reading_does_not_show_is_refused() {
        let g = fixture();
        for (ops, why) in [
            (
                r#"{"op":"add_node","kind":"SecurityPolicy"}"#,
                "adds a kind",
            ),
            (r#"{"op":"add_node","kind":"Note"}"#, "adds a kind"),
            (
                r#"{"op":"add_node","kind":"Device","fields":{"serial_number":"X1"}}"#,
                "may not change",
            ),
        ] {
            match build(
                &g,
                &layout(),
                &Rules::open(),
                IDEA_LABEL_PREFIX,
                &ask(ops),
                Ulid(9_999),
                5,
                ids(),
            ) {
                Err(AiError::Operation { index: 0, why: w }) => assert!(w.contains(why), "{w}"),
                Err(e) => panic!("{ops}: {e}"),
                Ok(_) => panic!("{ops} was let through"),
            }
        }
        // Notes are addable once the key sees notes.
        let notes = BTreeSet::from([Tier::Layout, Tier::Notes]);
        assert!(build(
            &g,
            &notes,
            &Rules::open(),
            IDEA_LABEL_PREFIX,
            &ask(r#"{"op":"add_node","kind":"Note"}"#),
            Ulid(9_999),
            5,
            ids()
        )
        .is_ok());
    }

    #[test]
    fn a_place_that_holds_things_is_not_removed_and_twenty_is_the_most() {
        let g = fixture();
        let premises = fathom_graph::NodeId {
            kind: NodeKind::Premises,
            ulid: Ulid(4),
        }
        .to_string();
        match build(
            &g,
            &layout(),
            &Rules::open(),
            IDEA_LABEL_PREFIX,
            &ask(&format!(r#"{{"op":"remove","element":{premises:?}}}"#)),
            Ulid(9_999),
            5,
            ids(),
        ) {
            Err(AiError::Operation { why, .. }) => {
                assert!(why.contains("still holds things"), "{why}")
            }
            other => panic!("premises holding a rack went: {:?}", other.is_ok()),
        }
        let removes = |n: u128| {
            (0..n)
                .map(|i| format!(r#"{{"op":"remove","element":{:?}}}"#, device(i)))
                .collect::<Vec<_>>()
                .join(",")
        };
        assert!(build(
            &g,
            &layout(),
            &Rules::open(),
            IDEA_LABEL_PREFIX,
            &ask(&removes(20)),
            Ulid(9_999),
            5,
            ids()
        )
        .is_ok());
        let hidden = format!(r#"{{"op":"remove","element":{:?}}}"#, device(24));
        match build(
            &g,
            &layout(),
            &Rules::open(),
            IDEA_LABEL_PREFIX,
            &ask(&hidden),
            Ulid(9_999),
            5,
            ids(),
        ) {
            Err(AiError::Operation { why, .. }) => assert!(why.contains("cannot see"), "{why}"),
            other => panic!(
                "a device holding what the AI cannot see went: {:?}",
                other.is_ok()
            ),
        }
        match build(
            &g,
            &layout(),
            &Rules::open(),
            IDEA_LABEL_PREFIX,
            &ask(&removes(21)),
            Ulid(9_999),
            5,
            ids(),
        ) {
            Err(AiError::Operation { index, why }) => {
                assert_eq!(index, 20);
                assert!(why.contains("20 removals"), "{why}");
            }
            other => panic!("21 removals went: {:?}", other.is_ok()),
        }
    }

    #[test]
    fn more_than_two_hundred_operations_are_refused() {
        let one = r#"{"op":"set","element":"a","field":"b","value":1}"#;
        let ops = vec![one; MAX_OPERATIONS + 1].join(",");
        let j = format!(r#"{{"version":1,"summary":"x","operations":[{ops}]}}"#);
        assert!(read_ask(&body(&j)).is_err());
    }
}
