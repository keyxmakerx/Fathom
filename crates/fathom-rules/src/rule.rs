//! A rule: the 63 §4 document, the 12 §4 selector and the compiled condition.
//!
//! Loading is where a rule is held to the pack gates (63 §19): the id matches the
//! directory, the prose is within bounds, a claim has a source or says why not, the
//! wording avoids the forbidden words, and the condition compiles against the real schema.
//! A rule that fails any of them does not load; there is no half-loaded rule.

use fathom_schema::subset::{parse_profile, Profile};
use fathom_schema::value::{Node, Value};

use crate::compile::{compile, Owner, Program, ReadSet};
use crate::schema::Schema;
use crate::value::{EdgeId, Elem, FieldId, KindId, Ty};

#[derive(Debug, Clone)]
pub struct LoadError {
    pub file: String,
    pub line: usize,
    pub message: String,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {}", self.file, self.line, self.message)
    }
}

pub(crate) fn lerr(file: &str, line: usize, message: impl Into<String>) -> LoadError {
    LoadError {
        file: file.to_owned(),
        line,
        message: message.into(),
    }
}

/// What a finding means for the gesture that produced it. Ordered most severe first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    /// Cannot work. A gesture that would make it true is refused.
    Refuse,
    /// Will probably not work, or will work badly.
    Warn,
    /// Works; there is something worth knowing.
    Idea,
}

impl Severity {
    pub fn word(self) -> &'static str {
        match self {
            Severity::Refuse => "refuse",
            Severity::Warn => "warn",
            Severity::Idea => "idea",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Card {
    One,
    Optional,
    Many,
}

/// What a rule does when a field it reads has never been set (12 §2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnUnset {
    /// Claim nothing about this instance. The default.
    Skip,
    /// Evaluate with the field as null.
    Fire,
}

#[derive(Debug, Clone)]
pub struct Source {
    pub publisher: String,
    pub doc: String,
    pub url: String,
    pub read_on: String,
    pub note: String,
}

#[derive(Debug, Clone)]
pub struct HopPlan {
    pub edge: EdgeId,
    pub rev: bool,
    /// Keep only neighbours of this kind (and name the bound kind when the edge allows several).
    pub kind: Option<KindId>,
    /// Keep only edges whose field holds this token.
    pub filter: Vec<(FieldId, String)>,
    /// Keep only edges whose field is not set (a plain cable, not a breakout lane).
    pub without: Vec<FieldId>,
}

#[derive(Debug, Clone)]
pub struct BindPlan {
    pub name: String,
    pub hops: Vec<HopPlan>,
    pub card: Card,
    pub kind: KindId,
}

#[derive(Debug, Clone)]
pub struct Meta {
    pub id: String,
    pub rule_version: String,
    pub severity: Severity,
    pub category: String,
    pub title: String,
    pub why: String,
    pub fix: String,
    pub concept: String,
    pub acceptable_when: String,
    pub reviewed_by: String,
    pub reviewed_on: String,
    pub sources: Vec<Source>,
    pub sources_note: String,
}

pub struct Rule {
    pub meta: Meta,
    pub anchor: KindId,
    pub filter: Option<Program>,
    pub binds: Vec<BindPlan>,
    pub cond: Program,
    pub reads: ReadSet,
    /// Bindings whose nodes the finding names beside the anchor.
    pub involves: Vec<usize>,
    pub on_unset: OnUnset,
    /// Fire once per pair: only when the anchor sorts before this binding's node.
    pub canonical: Option<usize>,
}

/// UI-SPEC: the product states a fact and a fix; it never says "permitted", "denied" or
/// "you're wrong".
const FORBIDDEN: [&str; 4] = ["permitted", "denied", "you're wrong", "you are wrong"];

const MAX_BINDS: usize = 8;
pub const MAX_HOPS: usize = 6;

fn text(n: &Node, key: &str, file: &str) -> Result<String, LoadError> {
    match n.get(key) {
        Some(Node {
            value: Value::Str(s),
            ..
        }) => Ok(s.trim().to_owned()),
        Some(other) => Err(lerr(file, other.line, format!("`{key}` must be text"))),
        None => Err(lerr(file, n.line, format!("`{key}` is required"))),
    }
}

fn opt_text(n: &Node, key: &str) -> String {
    n.get(key)
        .and_then(Node::as_str)
        .map(|s| s.trim().to_owned())
        .unwrap_or_default()
}

fn valid_id(id: &str) -> bool {
    let segs: Vec<&str> = id.split('.').collect();
    (2..=5).contains(&segs.len())
        && segs.iter().enumerate().all(|(i, s)| {
            let mut c = s.chars();
            let first_ok = c
                .next()
                .is_some_and(|f| f.is_ascii_lowercase() || (i > 0 && f.is_ascii_digit()));
            first_ok
                && s.chars().all(|ch| {
                    ch.is_ascii_lowercase() || ch.is_ascii_digit() || (i > 0 && ch == '-')
                })
        })
}

/// Load one `rule.yaml`. `dir` is the directory name the file sat in; the id must equal it.
pub fn load_rule(
    source: &str,
    file: &str,
    dir: &str,
    schema: &dyn Schema,
) -> Result<Rule, LoadError> {
    let root = parse_profile(source, Profile::Corpus)
        .map_err(|e| lerr(file, e.line, e.message.clone()))?;
    let id = text(&root, "id", file)?;
    if !valid_id(&id) {
        return Err(lerr(
            file,
            root.line,
            format!("`{id}` is not a rule id (dotted, lowercase, 2 to 5 segments)"),
        ));
    }
    if id != dir {
        return Err(lerr(
            file,
            root.line,
            format!("the id `{id}` must equal its directory `{dir}`"),
        ));
    }
    let sev = match text(&root, "severity", file)?.as_str() {
        "refuse" => Severity::Refuse,
        "warn" => Severity::Warn,
        "idea" => Severity::Idea,
        other => {
            return Err(lerr(
                file,
                root.line,
                format!("severity `{other}` is not refuse, warn or idea"),
            ))
        }
    };
    let status = opt_text(&root, "status");
    if !matches!(status.as_str(), "" | "active") {
        return Err(lerr(
            file,
            root.line,
            "only `status: active` rules are loaded here; a draft stays out of the build",
        ));
    }

    let title = text(&root, "title", file)?;
    if title.chars().count() > 72 || title.ends_with('.') {
        return Err(lerr(
            file,
            root.line,
            "title: at most 72 characters, no trailing period",
        ));
    }
    let why = text(&root, "why", file)?;
    if !(20..=600).contains(&why.chars().count()) {
        return Err(lerr(file, root.line, "why: 20 to 600 characters"));
    }
    let fix = text(&root, "fix", file)?;
    let acceptable_when = text(&root, "acceptable_when", file)?;
    for (field, body) in [("title", &title), ("why", &why), ("fix", &fix)] {
        let low = body.to_lowercase();
        if let Some(w) = FORBIDDEN.iter().find(|w| low.contains(**w)) {
            return Err(lerr(file, root.line, format!("{field}: the word \"{w}\" is not how Fathom talks (UI-SPEC): state the fact and the fix")));
        }
    }
    let reviewed_by = text(&root, "reviewed_by", file)?;
    if reviewed_by.is_empty() || reviewed_by.starts_with('<') {
        return Err(lerr(file, root.line, "reviewed_by must be a name, or `pending: <name>`; a placeholder does not ship (invariant 10)"));
    }
    let mut sources = Vec::new();
    if let Some(list) = root.get("sources").and_then(Node::as_seq) {
        for s in list {
            let src = Source {
                publisher: text(s, "publisher", file)?,
                doc: text(s, "doc", file)?,
                url: opt_text(s, "url"),
                read_on: text(s, "read_on", file)?,
                note: opt_text(s, "note"),
            };
            sources.push(src);
        }
    }
    let sources_note = opt_text(&root, "sources_note");
    if sources.is_empty() && sources_note.is_empty() {
        return Err(lerr(
            file,
            root.line,
            "a rule needs `sources`, or `sources_note` saying why it has none (CLAUDE.md rule 1)",
        ));
    }

    let meta = Meta {
        id,
        rule_version: text(&root, "rule_version", file)?,
        severity: sev,
        category: text(&root, "category", file)?,
        title,
        why,
        fix,
        concept: text(&root, "concept", file)?,
        acceptable_when,
        reviewed_by,
        reviewed_on: text(&root, "reviewed_on", file)?,
        sources,
        sources_note,
    };

    let at = root
        .get("applies_to")
        .ok_or_else(|| lerr(file, root.line, "`applies_to` is required"))?;
    let anchor_name = text(at, "kind", file)?;
    let anchor = schema.kind(&anchor_name).ok_or_else(|| {
        lerr(
            file,
            at.line,
            format!("`{anchor_name}` is not a kind in schema/"),
        )
    })?;
    let mut reads = ReadSet::default();
    reads.kinds.insert(anchor);

    let filter = match at.get("where").and_then(Node::as_str) {
        Some(src) => {
            let (p, r) = compile(src, schema, anchor, &[])
                .map_err(|e| lerr(file, at.line, format!("where: {} (at {})", e.msg, e.pos)))?;
            if p.result != Ty::Bool {
                return Err(lerr(file, at.line, "where must be a bool"));
            }
            reads.extend(&r);
            Some(p)
        }
        None => None,
    };

    let mut binds: Vec<BindPlan> = Vec::new();
    if let Some(with) = at.get("with") {
        let entries = with
            .as_map()
            .ok_or_else(|| lerr(file, with.line, "`with` is a map of bindings"))?;
        if entries.len() > MAX_BINDS {
            return Err(lerr(
                file,
                with.line,
                format!("at most {MAX_BINDS} bindings"),
            ));
        }
        for (name, spec) in entries {
            if name == "self" || binds.iter().any(|b| b.name == *name) {
                return Err(lerr(file, spec.line, format!("`{name}` is already a name")));
            }
            if schema.node_field(anchor, name).is_some() {
                return Err(lerr(
                    file,
                    spec.line,
                    format!("`{name}` is also a field of {anchor_name}; rename the binding"),
                ));
            }
            binds.push(plan_bind(name, spec, anchor, schema, &mut reads, file)?);
        }
    }

    let bind_tys: Vec<(String, Ty)> = binds
        .iter()
        .map(|b| {
            (
                b.name.clone(),
                if b.card == Card::Many {
                    Ty::List(Elem::Node(b.kind))
                } else {
                    Ty::Node(b.kind)
                },
            )
        })
        .collect();
    let cond_src = text(&root, "condition", file)?;
    let (cond, r) = compile(&cond_src, schema, anchor, &bind_tys).map_err(|e| {
        lerr(
            file,
            root.line,
            format!("condition: {} (at byte {})", e.msg, e.pos),
        )
    })?;
    if cond.result != Ty::Bool {
        return Err(lerr(file, root.line, "condition must be a bool"));
    }
    reads.extend(&r);

    let mut involves = Vec::new();
    if let Some(list) = root.get("involves").and_then(Node::as_seq) {
        for n in list {
            let name = n.as_str().unwrap_or_default();
            let i = binds.iter().position(|b| b.name == name).ok_or_else(|| {
                lerr(file, n.line, format!("involves: `{name}` is not a binding"))
            })?;
            involves.push(i);
        }
    }
    let on_unset = match opt_text(&root, "on_unset").as_str() {
        "" | "skip" => OnUnset::Skip,
        "fire" => OnUnset::Fire,
        other => {
            return Err(lerr(
                file,
                root.line,
                format!("on_unset `{other}` is not skip or fire"),
            ))
        }
    };
    let canonical = match at.get("canonical").and_then(Node::as_str) {
        None => None,
        Some(name) => Some(
            binds
                .iter()
                .position(|b| b.name == name && b.card != Card::Many)
                .ok_or_else(|| {
                    lerr(
                        file,
                        at.line,
                        format!("canonical: `{name}` must be a one/optional binding"),
                    )
                })?,
        ),
    };

    Ok(Rule {
        meta,
        anchor,
        filter,
        binds,
        cond,
        reads,
        involves,
        on_unset,
        canonical,
    })
}

fn plan_bind(
    name: &str,
    spec: &Node,
    anchor: KindId,
    schema: &dyn Schema,
    reads: &mut ReadSet,
    file: &str,
) -> Result<BindPlan, LoadError> {
    let card = match text(spec, "card", file)?.as_str() {
        "one" => Card::One,
        "optional" => Card::Optional,
        "many" => Card::Many,
        other => {
            return Err(lerr(
                file,
                spec.line,
                format!("card `{other}` is not one, optional or many"),
            ))
        }
    };
    let via = spec
        .get("via")
        .ok_or_else(|| lerr(file, spec.line, "a binding needs `via`"))?;
    let hops_src: Vec<&Node> = match &via.value {
        Value::Seq(items) => items.iter().collect(),
        _ => vec![via],
    };
    if hops_src.is_empty() || hops_src.len() > MAX_HOPS {
        return Err(lerr(
            file,
            via.line,
            format!("a binding walks 1 to {MAX_HOPS} edges"),
        ));
    }
    let mut cur: Vec<KindId> = vec![anchor];
    let mut hops = Vec::new();
    for h in hops_src {
        let (role, rev, kind_name, filters, without_names) = match &h.value {
            Value::Str(s) => match s.strip_prefix('~') {
                Some(r) => (r.to_owned(), true, String::new(), Vec::new(), Vec::new()),
                None => (s.clone(), false, String::new(), Vec::new(), Vec::new()),
            },
            Value::Map(_) => {
                let mut f = Vec::new();
                if let Some(w) = h.get("where").and_then(Node::as_map) {
                    for (k, v) in w {
                        f.push((k.clone(), v.as_str().unwrap_or_default().to_owned()));
                    }
                }
                (
                    text(h, "role", file)?,
                    h.get("reverse").and_then(Node::as_bool).unwrap_or(false),
                    opt_text(h, "kind"),
                    f,
                    h.get("without")
                        .and_then(Node::as_seq)
                        .unwrap_or_default()
                        .iter()
                        .map(Node::scalar_display)
                        .collect::<Vec<_>>(),
                )
            }
            _ => return Err(lerr(file, h.line, "a hop is a role name or a map")),
        };
        let e = schema.edge(&role).ok_or_else(|| {
            lerr(
                file,
                h.line,
                format!("`{role}` is not an edge role in schema/"),
            )
        })?;
        let (here, next) = if rev {
            (&e.to, &e.from)
        } else {
            (&e.from, &e.to)
        };
        if !cur.iter().any(|k| here.contains(k)) {
            return Err(lerr(
                file,
                h.line,
                format!(
                    "`{role}` does not leave a {}",
                    cur.iter()
                        .map(|k| schema.kind_name(*k))
                        .collect::<Vec<_>>()
                        .join(" or ")
                ),
            ));
        }
        let mut next = next.clone();
        let kind = if kind_name.is_empty() {
            None
        } else {
            let k = schema
                .kind(&kind_name)
                .ok_or_else(|| lerr(file, h.line, format!("`{kind_name}` is not a kind")))?;
            if !next.contains(&k) {
                return Err(lerr(
                    file,
                    h.line,
                    format!("`{role}` does not reach a {kind_name}"),
                ));
            }
            next = vec![k];
            Some(k)
        };
        let mut filter = Vec::new();
        for (field, tok) in filters {
            let info = schema
                .edge_field(e.id, &field)
                .ok_or_else(|| lerr(file, h.line, format!("`{role}` has no field `{field}`")))?;
            let Ty::Enum(en) = info.ty else {
                return Err(lerr(
                    file,
                    h.line,
                    "a hop filter compares an enum field with its token",
                ));
            };
            if let Some(d) = schema.enum_tokens(en) {
                if !d.contains(&tok) {
                    return Err(lerr(
                        file,
                        h.line,
                        format!("`{tok}` is not a declared token ({})", d.join(", ")),
                    ));
                }
            }
            reads.fields.insert((Owner::Edge(e.id), info.id));
            filter.push((info.id, tok));
        }
        let mut without = Vec::new();
        for name in without_names {
            let info = schema
                .edge_field(e.id, &name)
                .ok_or_else(|| lerr(file, h.line, format!("`{role}` has no field `{name}`")))?;
            reads.fields.insert((Owner::Edge(e.id), info.id));
            without.push(info.id);
        }
        reads.adjacency.insert((e.id, rev));
        reads.kinds.extend(next.iter().copied());
        cur = next;
        hops.push(HopPlan {
            edge: e.id,
            rev,
            kind,
            filter,
            without,
        });
    }
    let [kind] = cur[..] else {
        return Err(lerr(
            file,
            via.line,
            format!(
                "binding `{name}` ends on {} kinds; add `kind:` to its last hop",
                cur.len()
            ),
        ));
    };
    Ok(BindPlan {
        name: name.to_owned(),
        hops,
        card,
        kind,
    })
}
