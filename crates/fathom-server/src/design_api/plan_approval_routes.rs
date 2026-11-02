//! Plan approval's routes (migration 0072, sign-off r102-plan-approval). The rules are in
//! `crate::plan_approval`; these are plumbing in the teams routes' pattern: the server fixes the
//! bytes, the browser signs them with the person's own key, and the server rebuilds and
//! re-checks everything when they come back.
//!
//! - `GET  /organisations/{o}/plan-rules`: `{"steward": bool, "rules": [{scope, required}]}`,
//!   every folder's own rule (`scope` null for the whole organisation).
//! - `POST /organisations/{o}/plan-rules/propose`: body `{"key", "scope"?, "required"}`, a
//!   folder's Steward's. Answers the proposal and the hex `bytes`.
//!   `POST /organisations/{o}/plan-rules/sign`: its fields back plus `"signature"`.
//! - `GET  /organisations/{o}/designs/{d}/plan-approvals`: `{"required": bool, "plans": [..]}`,
//!   each plan `{plan, title, stage, digest, approved, flagged, approvals, asks, may_approve,
//!   may_emergency, may_approve_after, may_send_back}`, and `"names"` for every account named.
//! - `POST /organisations/{o}/designs/{d}/plan-approvals/propose`: body `{"key", "plan",
//!   "kind", "reason"?}`, kind `before`, `emergency` or `after`. Answers the proposal, the hex
//!   `plan_digest` and `bytes`. `POST .../plan-approvals/sign`: its fields back plus
//!   `"signature"`; refused when the plan changed in between.
//! - `POST /organisations/{o}/designs/{d}/plan-approvals/ask`: body `{"plan", "kind", "note"?}`,
//!   kind `ask` or `send_back` (which needs a note).

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Path as PathExtractor, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use deadpool_postgres::Transaction;
use fathom_canon::Json;

use super::{
    begin_org, design_scope, json_response, object_body, parse_design, str_field, DesignApiState,
    RouteError, Signed,
};
use crate::crypto::{hex, unhex};
use crate::designs::{self, DesignError};
use crate::grants::{self, Authority};
use crate::plan_approval::{self, ApprovalProposal, PlanFacts, RuleProposal};
use crate::repo::DesignId;
use crate::sessions::SessionError;
use crate::teams;

pub(super) fn routes() -> Router<DesignApiState> {
    Router::new()
        .route(
            "/organisations/{organisation}/plan-rules",
            get(rules_handler),
        )
        .route(
            "/organisations/{organisation}/plan-rules/propose",
            post(rule_propose_handler),
        )
        .route(
            "/organisations/{organisation}/plan-rules/sign",
            post(rule_sign_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/plan-approvals",
            get(status_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/plan-approvals/propose",
            post(propose_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/plan-approvals/sign",
            post(sign_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/plan-approvals/ask",
            post(ask_handler),
        )
}

fn malformed(what: &'static str) -> RouteError {
    SessionError::Malformed(what).into()
}

fn opt_json(v: &Option<String>) -> Json {
    match v {
        Some(s) => Json::Str(s.clone()),
        None => Json::Null,
    }
}

fn opt_str(m: &mut BTreeMap<String, Json>, key: &str) -> Result<Option<String>, RouteError> {
    match m.remove(key) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Str(s)) => Ok(Some(s)),
        Some(_) => Err(malformed("request body")),
    }
}

fn need_str(m: &mut BTreeMap<String, Json>, key: &str) -> Result<String, RouteError> {
    str_field(m, key)?.ok_or_else(|| malformed("request body"))
}

fn need_int(m: &mut BTreeMap<String, Json>, key: &str) -> Result<i64, RouteError> {
    match m.remove(key) {
        Some(Json::Int(n)) => Ok(n),
        _ => Err(malformed("request body")),
    }
}

fn need_bool(m: &mut BTreeMap<String, Json>, key: &str) -> Result<bool, RouteError> {
    match m.remove(key) {
        Some(Json::Bool(b)) => Ok(b),
        _ => Err(malformed("request body")),
    }
}

fn fpr(text: &str) -> Result<[u8; 32], RouteError> {
    unhex(text)
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| malformed("key fingerprint"))
}

fn signature(m: &mut BTreeMap<String, Json>) -> Result<Vec<u8>, RouteError> {
    unhex(&need_str(m, "signature")?)
        .filter(|s| s.len() == 64)
        .ok_or_else(|| malformed("signature"))
}

fn obj(entries: Vec<(&str, Json)>) -> Json {
    Json::Obj(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Folder rules
// ---------------------------------------------------------------------------

async fn rules_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key) = begin_org(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let steward = grants::is_steward(&tx, &auth)
        .await
        .map_err(SessionError::Authority)?;
    let rules = plan_approval::rules_now(&tx, &auth)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(obj(vec![
        ("steward", Json::Bool(steward)),
        (
            "rules",
            Json::Arr(
                rules
                    .into_iter()
                    .map(|(scope, required)| {
                        obj(vec![
                            ("scope", opt_json(&scope)),
                            ("required", Json::Bool(required)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])))
}

fn rule_proposal_json(p: &RuleProposal) -> Json {
    obj(vec![
        ("rule_id", Json::Str(p.rule_id.clone())),
        ("scope", opt_json(&p.scope)),
        ("required", Json::Bool(p.required)),
        ("signer", Json::Str(p.signer.clone())),
        ("signer_key_fpr", Json::Str(hex(&p.signer_key_fpr))),
        ("at", Json::Int(p.at_unix)),
        ("auth_epoch", Json::Int(i64::from(p.auth_epoch))),
        ("root_fpr", Json::Str(hex(&p.root_fpr))),
        ("bytes", Json::Str(hex(&p.bytes))),
    ])
}

async fn rule_propose_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["key", "scope", "required"])?;
    let scope = opt_str(&mut m, "scope")?;
    let required = need_bool(&mut m, "required")?;
    let key = fpr(&need_str(&mut m, "key")?)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key) = begin_org(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let proposal = plan_approval::propose_rule(&tx, &auth, scope, required, &key)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(rule_proposal_json(&proposal)))
}

async fn rule_sign_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(
        &signed.body,
        &[
            "rule_id",
            "scope",
            "required",
            "signer",
            "signer_key_fpr",
            "at",
            "auth_epoch",
            "root_fpr",
            "bytes",
            "signature",
        ],
    )?;
    let proposal = RuleProposal {
        rule_id: need_str(&mut m, "rule_id")?,
        scope: opt_str(&mut m, "scope")?,
        required: need_bool(&mut m, "required")?,
        signer: need_str(&mut m, "signer")?,
        signer_key_fpr: fpr(&need_str(&mut m, "signer_key_fpr")?)?,
        at_unix: need_int(&mut m, "at")?,
        auth_epoch: i32::try_from(need_int(&mut m, "auth_epoch")?)
            .map_err(|_| malformed("authority epoch"))?,
        root_fpr: fpr(&need_str(&mut m, "root_fpr")?)?,
        // Rebuilt inside `commit_rule` from the fields; nothing sent is believed.
        bytes: Vec::new(),
    };
    let signature = signature(&mut m)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key) = begin_org(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let id = plan_approval::commit_rule(&tx, &auth, &proposal, &signature)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(obj(vec![("rule", Json::Str(id))])))
}

// ---------------------------------------------------------------------------
// One design's plans
// ---------------------------------------------------------------------------

/// The design's folder and its plans as the head holds them now, read under the caller's
/// `read`.
async fn plans_now(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    state: &DesignApiState,
    design: DesignId,
) -> Result<(Option<String>, Vec<PlanFacts>), RouteError> {
    let scope = design_scope(tx, auth.ctx, design)
        .await?
        .ok_or(RouteError::from(DesignError::NoSuchDesign))?;
    let stored =
        designs::read_version_in_tx(tx, auth, Some(&state.live.heads), design, Some(scope), None)
            .await?;
    let payload = stored.payload;
    let plans = tokio::task::spawn_blocking(move || {
        fathom_workspace::read_plain(&payload)
            .map(|graph| plan_approval::plans_of(&graph))
            .map_err(|_| DesignError::Corrupt("design head"))
    })
    .await
    .map_err(|_| DesignError::Corrupt("design head"))??;
    Ok((Some(scope.to_string()), plans))
}

fn find(plans: Vec<PlanFacts>, plan: &str) -> Result<PlanFacts, RouteError> {
    plans
        .into_iter()
        .find(|p| p.plan == plan)
        .ok_or_else(|| malformed("plan"))
}

async fn status_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let design_id = parse_design(&design)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key) = begin_org(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let (scope, plans) = plans_now(&tx, &auth, &state, design_id).await?;
    let (required, statuses) =
        plan_approval::status(&tx, &auth, &design_id.to_string(), scope.as_deref(), &plans)
            .await
            .map_err(SessionError::Authority)?;
    let mut accounts = BTreeSet::new();
    for s in &statuses {
        accounts.extend(s.approvals.iter().map(|a| a.by.clone()));
        accounts.extend(s.asks.iter().map(|a| a.account.clone()));
    }
    let names = teams::names_of(&tx, &accounts.into_iter().collect::<Vec<_>>())
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    let plans_json = statuses
        .iter()
        .map(|s| {
            obj(vec![
                ("plan", Json::Str(s.plan.clone())),
                ("title", Json::Str(s.title.clone())),
                ("stage", Json::Str(s.stage.clone())),
                ("digest", Json::Str(hex(&s.digest))),
                ("approved", Json::Bool(s.approved)),
                ("flagged", Json::Bool(s.flagged)),
                (
                    "approvals",
                    Json::Arr(
                        s.approvals
                            .iter()
                            .map(|a| {
                                obj(vec![
                                    ("kind", Json::Str(a.kind.clone())),
                                    ("by", Json::Str(a.by.clone())),
                                    ("team", opt_json(&a.team)),
                                    ("reason", Json::Str(a.reason.clone())),
                                    ("at", Json::Int(a.at_unix)),
                                    ("current", Json::Bool(a.current)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "asks",
                    Json::Arr(
                        s.asks
                            .iter()
                            .map(|a| {
                                obj(vec![
                                    ("kind", Json::Str(a.kind.clone())),
                                    ("by", Json::Str(a.account.clone())),
                                    ("note", Json::Str(a.note.clone())),
                                    ("at", Json::Int(a.at_unix)),
                                    ("current", Json::Bool(a.plan_digest == s.digest)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("may_approve", Json::Bool(s.may_approve)),
                ("may_emergency", Json::Bool(s.may_emergency)),
                ("may_approve_after", Json::Bool(s.may_approve_after)),
                ("may_send_back", Json::Bool(s.may_send_back)),
            ])
        })
        .collect();
    Ok(json_response(obj(vec![
        ("required", Json::Bool(required)),
        ("plans", Json::Arr(plans_json)),
        (
            "names",
            Json::Obj(names.into_iter().map(|(k, v)| (k, Json::Str(v))).collect()),
        ),
    ])))
}

fn proposal_json(p: &ApprovalProposal) -> Json {
    obj(vec![
        ("approval_id", Json::Str(p.approval_id.clone())),
        ("design", Json::Str(p.design.clone())),
        ("plan", Json::Str(p.plan.clone())),
        ("plan_digest", Json::Str(hex(&p.plan_digest))),
        ("kind", Json::Str(p.kind.clone())),
        ("team", opt_json(&p.team)),
        ("reason", Json::Str(p.reason.clone())),
        ("signer", Json::Str(p.signer.clone())),
        ("signer_key_fpr", Json::Str(hex(&p.signer_key_fpr))),
        ("at", Json::Int(p.at_unix)),
        ("auth_epoch", Json::Int(i64::from(p.auth_epoch))),
        ("root_fpr", Json::Str(hex(&p.root_fpr))),
        ("bytes", Json::Str(hex(&p.bytes))),
    ])
}

async fn propose_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let design_id = parse_design(&design)?;
    let mut m = object_body(&signed.body, &["key", "plan", "kind", "reason"])?;
    let plan = need_str(&mut m, "plan")?;
    let kind = need_str(&mut m, "kind")?;
    let reason = opt_str(&mut m, "reason")?.unwrap_or_default();
    let key = fpr(&need_str(&mut m, "key")?)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key) = begin_org(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let (scope, plans) = plans_now(&tx, &auth, &state, design_id).await?;
    let facts = find(plans, &plan)?;
    let proposal = plan_approval::propose_approval(
        &tx,
        &auth,
        &design_id.to_string(),
        scope.as_deref(),
        &facts,
        &kind,
        &reason,
        &key,
    )
    .await
    .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(proposal_json(&proposal)))
}

async fn sign_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let design_id = parse_design(&design)?;
    let mut m = object_body(
        &signed.body,
        &[
            "approval_id",
            "design",
            "plan",
            "plan_digest",
            "kind",
            "team",
            "reason",
            "signer",
            "signer_key_fpr",
            "at",
            "auth_epoch",
            "root_fpr",
            "bytes",
            "signature",
        ],
    )?;
    let proposal = ApprovalProposal {
        approval_id: need_str(&mut m, "approval_id")?,
        design: need_str(&mut m, "design")?,
        plan: need_str(&mut m, "plan")?,
        plan_digest: fpr(&need_str(&mut m, "plan_digest")?)?,
        kind: need_str(&mut m, "kind")?,
        team: opt_str(&mut m, "team")?,
        reason: need_str(&mut m, "reason")?,
        signer: need_str(&mut m, "signer")?,
        signer_key_fpr: fpr(&need_str(&mut m, "signer_key_fpr")?)?,
        at_unix: need_int(&mut m, "at")?,
        auth_epoch: i32::try_from(need_int(&mut m, "auth_epoch")?)
            .map_err(|_| malformed("authority epoch"))?,
        root_fpr: fpr(&need_str(&mut m, "root_fpr")?)?,
        // Rebuilt inside `commit_approval` from the fields; nothing sent is believed.
        bytes: Vec::new(),
    };
    if proposal.design != design_id.to_string() {
        return Err(malformed("design"));
    }
    let signature = signature(&mut m)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key) = begin_org(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let (scope, plans) = plans_now(&tx, &auth, &state, design_id).await?;
    let facts = find(plans, &proposal.plan)?;
    let id =
        plan_approval::commit_approval(&tx, &auth, scope.as_deref(), &facts, &proposal, &signature)
            .await
            .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(obj(vec![("approval", Json::Str(id))])))
}

async fn ask_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let design_id = parse_design(&design)?;
    let mut m = object_body(&signed.body, &["plan", "kind", "note"])?;
    let plan = need_str(&mut m, "plan")?;
    let kind = need_str(&mut m, "kind")?;
    let note = opt_str(&mut m, "note")?.unwrap_or_default();
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key) = begin_org(&state, &signed, &mut client, &organisation).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let (scope, plans) = plans_now(&tx, &auth, &state, design_id).await?;
    let facts = find(plans, &plan)?;
    // Asking is the plan writer's step: it needs `draw` on the design's folder. Sending back
    // is an approver's, whose standing `plan_approval::ask` checks.
    if kind == "ask" {
        let scope_id = design_scope(&tx, &ctx, design_id).await?;
        grants::authorise_account(&tx, &auth, scope_id, crate::authority::Capability::Draw)
            .await
            .map_err(SessionError::Authority)?;
    }
    plan_approval::ask(
        &tx,
        &auth,
        &design_id.to_string(),
        scope.as_deref(),
        &facts,
        &kind,
        &note,
    )
    .await
    .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(obj(vec![("ok", Json::Bool(true))])))
}
