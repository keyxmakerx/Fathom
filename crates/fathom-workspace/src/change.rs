//! `fathom-change 1`: one batch of a design (ADR-0063), as a document, and its
//! application to a graph through the graph's own write path.
//!
//! ```text
//! line 1   fathom-change 1
//! line 2   schema <SCHEMA_VERSION>
//! line 3   (empty)
//! line 4   {"batch": B, "provenance": [P…], "values": [V…]} as canonical JSON
//! ```
//!
//! `B` is one entry of the plain face's `batches`. `P` are the provenance
//! records `B` introduces, ascending id, with no `supersedes` (the store fills
//! it in). `values` holds one canonical value per `set_field` op whose
//! presence is `set`, in op order.

use std::collections::BTreeSet;
use std::fmt;

use fathom_canon::Json;
use fathom_graph::{
    Actor, Batch, BatchId, ElementId, Graph, NodeId, Op, ProvenanceId, ProvenanceRecord,
    StoredPresence, WriteError,
};
use fathom_ir::canon::CanonError;
use fathom_ir::generated::accessors::slot_from_canon;
use fathom_ir::generated::ir_types::{
    CaptureField, DocField, DocLinkField, NodeKind, NoteField, SCHEMA_VERSION,
};
use fathom_ir::scalar::Text;

use crate::{
    batch_to_json, get_arr, get_obj, key_or, obj, provenance_to_json, read_batch, read_provenance,
    PlainError, ACCEPTED_OLDER_SCHEMA_VERSIONS,
};

pub const CHANGE_MAGIC: &str = "fathom-change";
pub const CHANGE_FORMAT_VERSION: u32 = 1;

/// One batch, the provenance records it introduces, and the values its
/// `set_field` ops carry.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub batch: Batch,
    pub provenance: Vec<ProvenanceRecord>,
    pub values: Vec<Json>,
}

/// Why a change did not read, or was not applied.
#[derive(Debug)]
pub enum ChangeError {
    NotChange,
    UnsupportedFormat {
        found: String,
    },
    SchemaVersion {
        found: String,
    },
    MalformedHeader {
        line: u32,
    },
    Format(PlainError),
    Empty,
    /// A provenance record, tombstone or revive naming someone other than the
    /// signed-in account.
    WrongAuthor {
        what: &'static str,
    },
    ProvenanceOrder,
    /// The batch's ops and the change's provenance list do not name the same
    /// records.
    ProvenanceMismatch,
    ProvenanceKnown {
        id: ProvenanceId,
    },
    ValueCount {
        expected: usize,
        found: usize,
    },
    Value(CanonError),
    Write(WriteError),
    /// The ops the graph recorded are not the ops the change carries.
    NotCanonical,
    ReversesUnknown {
        id: BatchId,
    },
    ReversesOthers {
        id: BatchId,
    },
    Credential {
        kind: &'static str,
        line: usize,
    },
}

impl From<PlainError> for ChangeError {
    fn from(e: PlainError) -> Self {
        ChangeError::Format(e)
    }
}

impl From<WriteError> for ChangeError {
    fn from(e: WriteError) -> Self {
        ChangeError::Write(e)
    }
}

impl fmt::Display for ChangeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotChange => f.write_str("that is not a fathom-change document"),
            Self::UnsupportedFormat { found } => {
                write!(
                    f,
                    "change format version {found} is not one this server reads"
                )
            }
            Self::SchemaVersion { found } => {
                write!(
                    f,
                    "the change declares schema version {found}, which this server does not accept"
                )
            }
            Self::MalformedHeader { line } => {
                write!(f, "line {line} of the change header is malformed")
            }
            Self::Format(e) => write!(f, "the change body is malformed: {e:?}"),
            Self::Empty => f.write_str("a change must hold at least one operation"),
            Self::WrongAuthor { what } => {
                write!(f, "{what} names someone other than the signed-in account")
            }
            Self::ProvenanceOrder => {
                f.write_str("the change's provenance must be in ascending id order without repeats")
            }
            Self::ProvenanceMismatch => f.write_str(
                "the change's provenance records are not exactly the ones its operations name",
            ),
            Self::ProvenanceKnown { id } => {
                write!(
                    f,
                    "provenance record {} already exists in this design",
                    id.0
                )
            }
            Self::ValueCount { expected, found } => write!(
                f,
                "the change carries {found} values but its set operations need {expected}"
            ),
            Self::Value(e) => write!(f, "a value does not fit the field's declared type: {e:?}"),
            Self::Write(e) => write!(f, "{e}"),
            Self::NotCanonical => f.write_str(
                "the change's operations are not the ones the graph records for them (an edge \
                 on a symmetric kind must name its smaller end first)",
            ),
            Self::ReversesUnknown { id } => {
                write!(
                    f,
                    "the change reverses batch {}, which this design does not hold",
                    id.0
                )
            }
            Self::ReversesOthers { id } => {
                write!(
                    f,
                    "the change reverses batch {}, which another person made",
                    id.0
                )
            }
            Self::Credential { kind, line } => write!(
                f,
                "the change's {kind} text still carries something that looks like a credential, \
                 at line {line}; it was refused before it reached storage"
            ),
        }
    }
}

impl std::error::Error for ChangeError {}

// ---------------------------------------------------------------------------
// The document

pub fn write_change(change: &Change) -> Vec<u8> {
    let body = obj(vec![
        ("batch", batch_to_json(&change.batch)),
        (
            "provenance",
            Json::Arr(change.provenance.iter().map(provenance_to_json).collect()),
        ),
        ("values", Json::Arr(change.values.clone())),
    ]);
    let mut out =
        format!("{CHANGE_MAGIC} {CHANGE_FORMAT_VERSION}\nschema {SCHEMA_VERSION}\n\n").into_bytes();
    out.extend_from_slice(&body.to_canonical_bytes());
    out
}

pub fn read_change(bytes: &[u8]) -> Result<Change, ChangeError> {
    let magic = format!("{CHANGE_MAGIC} ");
    if !bytes.starts_with(magic.as_bytes()) {
        return Err(ChangeError::NotChange);
    }
    let mut lines: [&[u8]; 3] = [&[]; 3];
    let mut at = 0usize;
    for (i, slot) in lines.iter_mut().enumerate() {
        let end = bytes[at..]
            .iter()
            .position(|b| *b == b'\n')
            .map(|p| at + p)
            .ok_or(ChangeError::MalformedHeader { line: i as u32 + 1 })?;
        *slot = &bytes[at..end];
        at = end + 1;
    }
    let version = String::from_utf8_lossy(&lines[0][magic.len()..]).into_owned();
    if version != CHANGE_FORMAT_VERSION.to_string() {
        return Err(ChangeError::UnsupportedFormat { found: version });
    }
    let declared = core::str::from_utf8(lines[1])
        .ok()
        .and_then(|l| l.strip_prefix("schema "))
        .ok_or(ChangeError::MalformedHeader { line: 2 })?;
    if declared != SCHEMA_VERSION && !ACCEPTED_OLDER_SCHEMA_VERSIONS.contains(&declared) {
        return Err(ChangeError::SchemaVersion {
            found: declared.to_owned(),
        });
    }
    if !lines[2].is_empty() {
        return Err(ChangeError::MalformedHeader { line: 3 });
    }

    let json = Json::parse_canonical(&bytes[at..]).map_err(PlainError::from)?;
    let root = get_obj(&json, "$")?;
    if root.len() != 3 {
        return Err(PlainError::Shape {
            path: "$".to_owned(),
            expected: "exactly the keys batch, provenance and values",
        }
        .into());
    }
    let batch = read_batch(key_or(root, "batch", "$")?, "$.batch")?;
    let mut provenance = Vec::new();
    for (i, item) in get_arr(key_or(root, "provenance", "$")?, "$.provenance")?
        .iter()
        .enumerate()
    {
        provenance.push(read_provenance(item, &format!("$.provenance[{i}]"))?);
    }
    let values = get_arr(key_or(root, "values", "$")?, "$.values")?.to_vec();
    Ok(Change {
        batch,
        provenance,
        values,
    })
}

// ---------------------------------------------------------------------------
// Applying

/// Apply `change` to `graph` as `actor`, all or nothing: on refusal `graph` is
/// exactly as it was.
pub fn apply_change(graph: &mut Graph, change: &Change, actor: Actor) -> Result<(), ChangeError> {
    let mut trial = graph.clone();
    apply_change_in_place(&mut trial, change, actor)?;
    *graph = trial;
    Ok(())
}

/// [`apply_change`] without the copy. On refusal `graph` may be half written:
/// the caller must discard it.
pub fn apply_change_in_place(
    graph: &mut Graph,
    change: &Change,
    actor: Actor,
) -> Result<(), ChangeError> {
    check_shape(graph, change, actor)?;
    let batch = &change.batch;

    let mut written: Vec<(NodeKind, fathom_ir::bag::FieldKey, String)> = Vec::new();
    graph.begin_batch(batch.id, &batch.label)?;
    if let Some(comment) = &batch.comment {
        graph.set_batch_comment(comment.clone())?;
    }
    if let Some(reverses) = batch.reverses {
        graph.set_batch_reverses(reverses)?;
    }

    let mut values = change.values.iter();
    for op in &batch.ops {
        match op {
            Op::AddNode { node, prov } => {
                graph.insert_node(node.kind, node.ulid, record(change, *prov)?)?;
            }
            Op::AddEdge {
                edge,
                from,
                to,
                prov,
            } => {
                graph.insert_edge(edge.kind, edge.ulid, *from, *to, record(change, *prov)?)?;
            }
            Op::SetField {
                element,
                key,
                presence,
                prov,
            } => {
                let rec = record(change, *prov)?;
                match presence {
                    StoredPresence::Set => {
                        let value = values.next().ok_or(ChangeError::ValueCount {
                            expected: batch.ops.len(),
                            found: change.values.len(),
                        })?;
                        let boxed = slot_from_canon(*key, value).map_err(ChangeError::Value)?;
                        // Every value written, not only the one left standing: a
                        // secret set and then overwritten is still in the change.
                        if let (ElementId::Node(n), Some(text)) =
                            (element, boxed.downcast_ref::<Text>())
                        {
                            // Read once the batch has ended: an id in a target list may
                            // name a node a later op of this batch adds.
                            written.push((n.kind, *key, text.0.clone()));
                        }
                        graph.set_field_boxed(*element, *key, boxed, rec)?;
                    }
                    StoredPresence::Absent => graph.assert_absent(*element, *key, rec)?,
                    StoredPresence::Unknown => graph.clear_field(*element, *key, rec)?,
                }
            }
            Op::Tombstone { element, at, by } => graph.tombstone_exact(*element, *at, *by)?,
            Op::Revive { element, at, by } => graph.revive(*element, *at, *by)?,
        }
    }
    graph.end_batch()?;

    if let Some((kind, line)) = batch_credential(batch) {
        return Err(ChangeError::Credential { kind, line });
    }
    for (kind, key, text) in &written {
        if let Some((kind, line)) = credential_in_text(graph, *kind, *key, text) {
            return Err(ChangeError::Credential { kind, line });
        }
    }
    if graph.log().last() != Some(batch) {
        return Err(ChangeError::NotCanonical);
    }
    for op in &batch.ops {
        let node = match op {
            Op::AddNode { node, .. } => Some(*node),
            Op::SetField {
                element: ElementId::Node(node),
                ..
            } => Some(*node),
            _ => None,
        };
        if let Some((kind, line)) = node.and_then(|n| credential_in_node(graph, n)) {
            return Err(ChangeError::Credential { kind, line });
        }
    }
    Ok(())
}

fn record(change: &Change, id: ProvenanceId) -> Result<ProvenanceRecord, ChangeError> {
    change
        .provenance
        .binary_search_by(|r| r.id.cmp(&id))
        .map(|i| change.provenance[i].clone())
        .map_err(|_| ChangeError::ProvenanceMismatch)
}

/// Everything that can be refused without touching the graph.
fn check_shape(graph: &Graph, change: &Change, actor: Actor) -> Result<(), ChangeError> {
    let batch = &change.batch;
    if batch.ops.is_empty() {
        return Err(ChangeError::Empty);
    }
    if change.provenance.windows(2).any(|w| w[0].id >= w[1].id) {
        return Err(ChangeError::ProvenanceOrder);
    }
    for rec in &change.provenance {
        if rec.asserted_by != actor {
            return Err(ChangeError::WrongAuthor {
                what: "a provenance record",
            });
        }
        if graph.provenance(rec.id).is_some() {
            return Err(ChangeError::ProvenanceKnown { id: rec.id });
        }
    }

    let mut named: BTreeSet<ProvenanceId> = BTreeSet::new();
    let mut set_ops = 0usize;
    for op in &batch.ops {
        match op {
            Op::AddNode { prov, .. } | Op::AddEdge { prov, .. } => {
                named.insert(*prov);
            }
            Op::SetField { prov, presence, .. } => {
                named.insert(*prov);
                set_ops += usize::from(*presence == StoredPresence::Set);
            }
            Op::Tombstone { by, .. } | Op::Revive { by, .. } => {
                if *by != actor {
                    return Err(ChangeError::WrongAuthor {
                        what: "a removal or revival",
                    });
                }
            }
        }
    }
    let introduced: BTreeSet<ProvenanceId> = change.provenance.iter().map(|r| r.id).collect();
    if named != introduced {
        return Err(ChangeError::ProvenanceMismatch);
    }
    if change.values.len() != set_ops {
        return Err(ChangeError::ValueCount {
            expected: set_ops,
            found: change.values.len(),
        });
    }

    if let Some(id) = batch.reverses {
        let target = graph
            .log()
            .iter()
            .find(|b| b.id == id)
            .ok_or(ChangeError::ReversesUnknown { id })?;
        if !made_only_by(graph, target, actor) {
            return Err(ChangeError::ReversesOthers { id });
        }
    }
    Ok(())
}

/// Every op of `batch` is attributable, and to `actor`.
fn made_only_by(graph: &Graph, batch: &Batch, actor: Actor) -> bool {
    !batch.ops.is_empty()
        && batch.ops.iter().all(|op| match op {
            Op::AddNode { prov, .. } | Op::AddEdge { prov, .. } | Op::SetField { prov, .. } => {
                graph
                    .provenance(*prov)
                    .is_some_and(|r| r.asserted_by == actor)
            }
            Op::Tombstone { by, .. } | Op::Revive { by, .. } => *by == actor,
        })
}

// ---------------------------------------------------------------------------
// The credential check on stored text (ADR-0049 #2, ADR-0054 #4)

/// How one gated field's text is read.
#[derive(Clone, Copy)]
enum Read {
    /// Line by line; `true` counts bare adjacency (`looks_like_credential_bare`).
    Lines(bool),
    /// `PlanStep.targets`: ids per line, nothing typed.
    Targets,
    /// `PlanStep.edit`: tab-separated; only a `field` edit's fourth part is a typed value.
    Edit,
}

/// The text fields the credential check reads: kind, field, label, how to read it.
///
/// `Capture` is never hand-typed, so it is always pasted device output and
/// bare adjacency is the right aggression. Note, doc and plan text may be prose,
/// so it stays on the delimiter-only check (ADR-0053 §5). A link's address is
/// stored as typed: ordinary ones carry long ids this check reads as secrets.
fn gated_fields() -> Vec<(NodeKind, fathom_ir::bag::FieldKey, &'static str, Read)> {
    use fathom_ir::generated::ir_types::{MaintenancePlanField as P, PlanStepField as S};
    let prose = Read::Lines(false);
    let mut v = vec![
        (
            NodeKind::Capture,
            CaptureField::Text.key(),
            "Capture",
            Read::Lines(true),
        ),
        (NodeKind::Note, NoteField::Text.key(), "Note", prose),
        (NodeKind::Doc, DocField::Title.key(), "Doc", prose),
        (NodeKind::Doc, DocField::Body.key(), "Doc", prose),
        (
            NodeKind::DocLink,
            DocLinkField::Title.key(),
            "DocLink",
            prose,
        ),
    ];
    for f in [P::Title, P::WindowStart, P::WindowEnd, P::Author, P::Record] {
        v.push((NodeKind::MaintenancePlan, f.key(), "MaintenancePlan", prose));
    }
    for f in [S::Change, S::Before, S::After, S::Note, S::DoneAt] {
        v.push((NodeKind::PlanStep, f.key(), "PlanStep", prose));
    }
    v.push((
        NodeKind::PlanStep,
        S::Targets.key(),
        "PlanStep",
        Read::Targets,
    ));
    v.push((NodeKind::PlanStep, S::Edit.key(), "PlanStep", Read::Edit));
    v
}

/// Every gated text field in the graph ([`gated_fields`]), line by line, so a
/// refusal names which one. `Some((kind, line))` on the first hit.
///
/// Superseded values count too: the history of those fields is stored and
/// streamed with the face, so a secret there is as stored as one in the value.
pub fn find_credential(graph: &Graph) -> Option<(&'static str, usize)> {
    if let Some(hit) = graph.log().iter().find_map(batch_credential) {
        return Some(hit);
    }
    for (kind, key, _, _) in gated_fields() {
        for node in graph.nodes_of_kind(kind) {
            let value = fathom_ir::bag::typed::<Text, _>(node, key).ok();
            if let Some(hit) = value.and_then(|t| credential_in_text(graph, kind, key, &t.0)) {
                return Some(hit);
            }
            let Some(history) = graph.history(node.id.into(), key) else {
                continue;
            };
            for entry in history.entries() {
                let text = entry.value.as_ref().and_then(|v| v.downcast_ref::<Text>());
                if let Some(hit) = text.and_then(|t| credential_in_text(graph, kind, key, &t.0)) {
                    return Some(hit);
                }
            }
        }
    }
    None
}

/// A batch's own free text, its label and its "Why?" comment, read as prose. Both are stored
/// and streamed with the change.
fn batch_credential(batch: &fathom_graph::Batch) -> Option<(&'static str, usize)> {
    credential_line(&batch.label, false)
        .map(|l| ("Batch label", l))
        .or_else(|| {
            let comment = batch.comment.as_ref()?;
            credential_line(&comment.0, false).map(|l| ("Batch comment", l))
        })
}

/// The credential check for one value written to `key` of a `kind` node:
/// `None` unless that field is gated ([`gated_fields`]).
fn credential_in_text(
    graph: &Graph,
    kind: NodeKind,
    key: fathom_ir::bag::FieldKey,
    text: &str,
) -> Option<(&'static str, usize)> {
    gated_fields()
        .into_iter()
        .find(|(k, f, _, _)| *k == kind && *f == key)
        .and_then(|(_, _, label, read)| read_line(graph, text, read).map(|l| (label, l)))
}

/// [`find_credential`] for one node's current values; `None` for an ungated kind.
pub fn credential_in_node(graph: &Graph, id: NodeId) -> Option<(&'static str, usize)> {
    let node = graph.node(id)?;
    gated_fields()
        .into_iter()
        .filter(|(k, ..)| *k == id.kind)
        .find_map(|(kind, key, _, _)| {
            let text = fathom_ir::bag::typed::<Text, _>(node, key).ok()?;
            credential_in_text(graph, kind, key, &text.0)
        })
}

/// The 1-based line in `text` that first looks like a credential. `bare`
/// selects `looks_like_credential_bare` over `looks_like_credential`.
pub fn credential_line(text: &str, bare: bool) -> Option<usize> {
    text.lines()
        .enumerate()
        .find(|(_, line)| {
            if bare {
                fathom_ingest::redact::looks_like_credential_bare(line)
            } else {
                fathom_ingest::redact::looks_like_credential(line)
            }
        })
        .map(|(idx, _)| idx + 1)
}

fn read_line(graph: &Graph, text: &str, read: Read) -> Option<usize> {
    match read {
        Read::Lines(bare) => credential_line(text, bare),
        Read::Targets => parts_credential_line(graph, text, '\n', None),
        Read::Edit => {
            let prose = text.starts_with("field\t").then_some(3);
            parts_credential_line(graph, text, '\t', prose)
        }
    }
}

/// `kind:ULID` naming a node this graph holds: a design id, which the shape detectors would
/// otherwise read as base64. A shape alone is not enough: a secret fits it, so the part must
/// parse as a real id and name a node that exists (tombstoned ones count).
fn id_shaped(graph: &Graph, part: &str) -> bool {
    NodeId::parse(part).is_ok_and(|id| graph.node(id).is_some())
}

/// The 1-based line of `text` with a part (split on `sep`) that is not an id and looks
/// like a credential. `prose_part` is the one part index that may be a typed value, so it
/// gets the prose-safe check; every other part is read bare, as it should hold no prose.
fn parts_credential_line(
    graph: &Graph,
    text: &str,
    sep: char,
    prose_part: Option<usize>,
) -> Option<usize> {
    text.lines()
        .enumerate()
        .find(|(_, line)| {
            line.split(sep).enumerate().any(|(i, part)| {
                if id_shaped(graph, part) {
                    return false;
                }
                if Some(i) == prose_part {
                    fathom_ingest::redact::looks_like_credential(part)
                } else {
                    fathom_ingest::redact::looks_like_credential_bare(part)
                }
            })
        })
        .map(|(idx, _)| idx + 1)
}
