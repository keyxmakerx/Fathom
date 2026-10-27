//! **An AI connection changes a design** (ADR-0073).
//!
//! `change_design` takes the version the AI read, a one-line summary and a list of
//! operations, and turns them into one `fathom-change 1` batch that the server applies
//! through the same path a browser's change takes (ADR-0063): the same grant check, the
//! same head, the same graph rules and the same credential refusal, streamed to every open
//! browser. Nothing is written that a browser could not write.
//!
//! What it adds, in order:
//!
//! 1. **Both ticks**: the organisation's and the connection's (decision 1), and never in a
//!    folder a Steward marked for a second person (decision 2).
//! 2. **The allowlist**: a field may be set only if the reading shows it at a tier the key
//!    sees, cut to `layout` and `notes` while only setting is built (decision 4).
//! 3. **Never over a person's work**: the change names the version it read and is refused
//!    if the design has moved since (decision 6).
//! 4. **Limits**: 200 operations, 10 changes a minute and 300 a day per connection
//!    (decision 7), counted from `ai_design_changes`, which is also the mark that an AI
//!    made the change (decision 5).
//! 5. **The server's gate on every string** the AI sent, not only the fields a browser's
//!    gate covers (decision 9). A refusal names the operation, never the value.
//!
//! The graph holds `Rc`s and is not `Send`: [`build`] is synchronous and returns bytes.

use std::collections::BTreeSet;

use deadpool_postgres::Transaction;
use fathom_canon::Json;
use fathom_graph::{
    Actor, Batch, BatchId, Confidence, ElementId, Graph, Op, Origin, ProvenanceId,
    ProvenanceRecord, StoredPresence, Timestamp, UserId,
};
use fathom_id::Ulid;
use fathom_ir::generated::accessors::slot_from_canon;

use crate::ai::{self, AiError, AiSession};
use crate::ai_reading::{self, Tier};
use crate::audit;
use crate::designs::{self, DesignError};
use crate::grants::Authority;
use crate::heads::HeadStore;
use crate::repo::DesignId;

/// The most operations one change may hold.
pub const MAX_OPERATIONS: usize = 200;
/// Changes one connection may make in a minute, and in a day.
pub const PER_MINUTE: i64 = 10;
pub const PER_DAY: i64 = 300;
/// The summary, which becomes the change's label in History.
pub const MAX_SUMMARY_CHARS: usize = 120;
/// What History shows before the summary. A batch label is at most 60 bytes.
const LABEL_PREFIX: &str = "AI: ";
const LABEL_MAX_BYTES: usize = 60;

/// One operation as the AI sent it, before it is checked against the design.
#[derive(Debug, Clone, PartialEq)]
pub struct SetAsk {
    pub element: String,
    pub field: String,
    /// `Json::Null` clears the field.
    pub value: Json,
}

/// A whole request, read but not yet checked against the design.
#[derive(Debug, Clone, PartialEq)]
pub struct Asked {
    pub version: i64,
    pub summary: String,
    pub sets: Vec<SetAsk>,
}

/// What a change made: the design's new version and how many operations it held.
pub struct Made {
    pub version: i64,
    pub batch: String,
    pub operations: usize,
}

impl Made {
    pub fn to_json(&self, design: DesignId) -> Json {
        let mut m = std::collections::BTreeMap::new();
        m.insert("design".into(), Json::Str(design.to_string()));
        m.insert("version".into(), Json::Int(self.version));
        m.insert("change".into(), Json::Str(self.batch.clone()));
        m.insert("operations".into(), Json::Int(self.operations as i64));
        m.insert(
            "about".into(),
            Json::Str(
                "Made as one change, in the connection owner's name and marked as an AI's. \
                 Anyone who can draw in the design can undo it in one step."
                    .into(),
            ),
        );
        Json::Obj(m)
    }
}

fn op_refused(index: usize, why: &'static str) -> AiError {
    AiError::Operation { index, why }
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

/// Read a request: `{version, summary, operations: [{op: "set", element, field, value}]}`,
/// canonical JSON, nothing else in it.
pub fn read_ask(body: &[u8]) -> Result<Asked, AiError> {
    let bad = || {
        AiError::Malformed(
            "a change is {version, summary, operations: [{op: \"set\", element, field, value}]}",
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
    let mut sets = Vec::with_capacity(raw.len());
    for (index, op) in raw.into_iter().enumerate() {
        let Json::Obj(mut o) = op else {
            return Err(op_refused(index, "is not an object"));
        };
        if o.keys()
            .any(|k| !["op", "element", "field", "value"].contains(&k.as_str()))
        {
            return Err(op_refused(
                index,
                "has something other than op, element, field and value",
            ));
        }
        match o.remove("op") {
            Some(Json::Str(s)) if s == "set" => {}
            _ => {
                return Err(op_refused(
                    index,
                    "is not one this connection may make yet: only \"set\"",
                ))
            }
        }
        let (Some(Json::Str(element)), Some(Json::Str(field)), Some(value)) =
            (o.remove("element"), o.remove("field"), o.remove("value"))
        else {
            return Err(op_refused(index, "needs an element, a field and a value"));
        };
        if carries_secret(&value) {
            return Err(op_refused(
                index,
                "looks as if it carries a password or key, so the change was not taken",
            ));
        }
        sets.push(SetAsk {
            element,
            field,
            value,
        });
    }
    Ok(Asked {
        version,
        summary,
        sets,
    })
}

/// The change's label: the summary after [`LABEL_PREFIX`], cut on a character boundary.
fn label_of(summary: &str) -> String {
    let mut label = String::from(LABEL_PREFIX);
    for c in summary.chars() {
        if label.len() + c.len_utf8() > LABEL_MAX_BYTES {
            break;
        }
        label.push(c);
    }
    label.trim_end().to_string()
}

/// Turn a request into one `fathom-change 1` document against `graph`, as `actor`. Every
/// element must be live and every field on the allowlist at `tiers`; every value must fit
/// its field. `next_id` hands out the batch's and the provenance records' ids.
pub fn build(
    graph: &Graph,
    tiers: &BTreeSet<Tier>,
    asked: &Asked,
    actor: Ulid,
    now_ms: u64,
    mut next_id: impl FnMut() -> Ulid,
) -> Result<Vec<u8>, AiError> {
    let mut ops = Vec::with_capacity(asked.sets.len());
    let mut provenance = Vec::with_capacity(asked.sets.len());
    let mut values = Vec::new();
    for (index, set) in asked.sets.iter().enumerate() {
        let not_there = || op_refused(index, "names nothing the reading of this design gave");
        let element = ElementId::parse(set.element.trim()).map_err(|_| not_there())?;
        let key = match element {
            ElementId::Node(n) => {
                let live = graph
                    .node(n)
                    .is_some_and(|node| node.absent_since.is_none());
                if !live || !ai_reading::shows_node_kind(tiers, n.kind) {
                    return Err(not_there());
                }
                ai_reading::settable_node_field(tiers, n.kind, &set.field)
            }
            ElementId::Edge(e) => {
                let Some(edge) = graph.edge(e).filter(|edge| edge.absent_since.is_none()) else {
                    return Err(not_there());
                };
                if !ai_reading::shows_node_kind(tiers, edge.from.kind)
                    || !ai_reading::shows_node_kind(tiers, edge.to.kind)
                {
                    return Err(not_there());
                }
                ai_reading::settable_edge_field(tiers, e.kind, &set.field)
            }
        }
        .ok_or_else(|| op_refused(index, "sets a field this connection may not change"))?;
        let presence = if set.value == Json::Null {
            StoredPresence::Unknown
        } else {
            if slot_from_canon(key, &set.value).is_err() {
                return Err(op_refused(index, "gives a value that field does not take"));
            }
            values.push(set.value.clone());
            StoredPresence::Set
        };
        let prov = ProvenanceId(next_id());
        provenance.push(ProvenanceRecord {
            id: prov,
            origin: Origin::Hand,
            asserted_at: Timestamp(now_ms),
            asserted_by: Actor::User(UserId(actor)),
            confidence: Confidence::Asserted,
            supersedes: None,
        });
        ops.push(Op::SetField {
            element,
            key,
            presence,
            prov,
        });
    }
    provenance.sort_by_key(|r| r.id);
    let change = fathom_workspace::Change {
        batch: Batch {
            id: BatchId(next_id()),
            label: label_of(&asked.summary),
            ops,
            comment: None,
            reverses: None,
        },
        provenance,
        values,
    };
    Ok(fathom_workspace::write_change(&change))
}

/// `POST /ai/v1/designs/{d}/changes`: make one change to a design, as the connection's
/// owner, marked as the AI's. `heads` is the live head store, which the change goes
/// through and which the caller commits to once the transaction has.
pub async fn change_design(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    heads: &HeadStore,
    session: &AiSession,
    design: DesignId,
    body: &[u8],
) -> Result<(Made, designs::ChangeWritten), AiError> {
    if !session.policy.may_change {
        return Err(AiError::NotAllowed(
            "this organisation does not let AI apps change designs; send an idea instead",
        ));
    }
    if !session.key.may_change {
        return Err(AiError::NotAllowed(
            "this connection may not change designs; send an idea instead, or ask its owner",
        ));
    }
    let asked = read_ask(body)?;
    let (scope, path) = ai::readable_place(tx, auth, &session.key, design).await?;
    let second = &session.policy.second_person_scopes;
    if !second.is_empty() && ai::covers(second, &path) {
        return Err(AiError::NotAllowed(
            "this folder needs a second person to accept changes; send an idea instead",
        ));
    }

    let tenant = auth.ctx.tenant().to_string();
    let key_id = session.key.id.clone();
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        &[&format!("ai_design_changes:{key_id}")],
    )
    .await?;
    let counts = tx
        .query_one(
            "SELECT count(*) FILTER (WHERE made_at > now() - interval '1 minute'), \
                    count(*) FILTER (WHERE made_at > now() - interval '1 day') \
             FROM ai_design_changes WHERE organisation_id = $1 AND key_id = $2",
            &[&tenant, &key_id],
        )
        .await?;
    let (minute, day): (i64, i64) = (counts.get(0), counts.get(1));
    if minute >= PER_MINUTE {
        return Err(AiError::NotAllowed(
            "this connection made 10 changes in the last minute; try again in a minute",
        ));
    }
    if day >= PER_DAY {
        return Err(AiError::NotAllowed(
            "this connection made 300 changes today; try again tomorrow",
        ));
    }

    let stored =
        designs::read_version_in_tx(tx, auth, Some(heads), design, Some(scope), None).await?;
    if stored.version != asked.version {
        return Err(AiError::Moved {
            read: asked.version,
            current: stored.version,
        });
    }
    let doc = {
        let graph = fathom_workspace::read_plain(&stored.payload)
            .map_err(|_| AiError::Unverifiable("a stored design that does not parse"))?;
        let tiers = ai::tiers(&session.key, &session.policy);
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        build(
            &graph,
            &tiers,
            &asked,
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
        &doc,
        schema_minor,
        asked.version,
        true,
        &audit::SpoolBounds::from_env(),
    )
    .await
    .map_err(|e| match e {
        DesignError::ChangeAhead { current, .. } => AiError::Moved {
            read: asked.version,
            current,
        },
        DesignError::ChangeRefused(why) if why.contains("credential") => AiError::LooksSecret,
        DesignError::ChangeRefused(_) => AiError::NotAllowed(
            "the design's own rules refused this change; read it again and check each operation",
        ),
        other => AiError::Design(other),
    })?;
    let batch = fathom_workspace::read_change(&doc)
        .map(|c| c.batch.id.0.encode())
        .map_err(|_| AiError::Unverifiable("a change this server built"))?;
    tx.execute(
        "INSERT INTO ai_design_changes (organisation_id, design_id, batch_id, key_id, owner, \
             design_version, operations) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        &[
            &tenant,
            &design.to_string(),
            &batch,
            &key_id,
            &auth.ctx.actor().to_string(),
            &written.version,
            &(asked.sets.len() as i32),
        ],
    )
    .await?;
    Ok((
        Made {
            version: written.version,
            batch,
            operations: asked.sets.len(),
        },
        written,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(ok.sets.len(), 1);
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
        assert_eq!(label_of("Name it"), "AI: Name it");
        let long = "é".repeat(100);
        let l = label_of(&long);
        assert!(l.len() <= LABEL_MAX_BYTES && l.starts_with(LABEL_PREFIX));
    }

    #[test]
    fn more_than_two_hundred_operations_are_refused() {
        let one = r#"{"op":"set","element":"a","field":"b","value":1}"#;
        let ops = vec![one; MAX_OPERATIONS + 1].join(",");
        let j = format!(r#"{{"version":1,"summary":"x","operations":[{ops}]}}"#);
        assert!(read_ask(&body(&j)).is_err());
    }
}
