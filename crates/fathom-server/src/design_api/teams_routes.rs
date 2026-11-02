//! Teams' routes (ADR-0081). The rules are in `crate::teams`; these are plumbing in the
//! pattern of the Share routes: the server fixes the bytes, the browser signs them with the
//! person's own key, and the server rebuilds and re-checks everything when they come back.
//!
//! - `GET  /organisations/{o}/teams`: the teams the caller may see, as
//!   `{"steward": bool, "teams": [{id, slug, name, members, leads, supervisors, grants,
//!   may_staff}]}`. Every seat is `{"account", "act"}`; every grant `{"act", "scope",
//!   "capability"}`. Supervisors are `overseer` rows (the module header says why).
//! - `POST /organisations/{o}/teams/propose`: body `{"act", "as", "key", "team"?, "subject"?,
//!   "role"?, "scope"?, "capability"?, "undoes"?, "slug"?, "name"?}`, where `as` is `steward`
//!   or `lead` and `key` the hex fingerprint of the browser's signing key. Answers the proposal,
//!   every field and the hex `bytes` to sign.
//! - `POST /organisations/{o}/teams/sign`: the proposal's fields back, plus `"signature"`
//!   (hex) and, for `create`, `"slug"` and `"name"`. Answers `{"act": id, "team": id}`.
//! - `POST /organisations/{o}/teams/{team}/rename`: body `{"slug", "name"}`, a root steward's.
//! - `GET  /organisations/{o}/teams/{team}/history`: `{"acts": [...]}`, oldest first, each with
//!   `counts`: whether its signature and its signer's authority check now.

use std::collections::BTreeMap;

use axum::extract::{Path as PathExtractor, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use fathom_canon::Json;

use super::{begin_org, json_response, object_body, str_field, DesignApiState, RouteError, Signed};
use crate::authority::Capability;
use crate::crypto::{hex, unhex};
use crate::grants::Authority;
use crate::sessions::SessionError;
use crate::teams::{self, NewTeam, TeamActProposal, TeamActRequest};

pub(super) fn routes() -> Router<DesignApiState> {
    Router::new()
        .route("/organisations/{organisation}/teams", get(list_handler))
        .route(
            "/organisations/{organisation}/teams/propose",
            post(propose_handler),
        )
        .route(
            "/organisations/{organisation}/teams/sign",
            post(sign_handler),
        )
        .route(
            "/organisations/{organisation}/teams/{team}/rename",
            post(rename_handler),
        )
        .route(
            "/organisations/{organisation}/teams/{team}/history",
            get(history_handler),
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

/// A field that is a string or absent (`null` counts as absent).
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

fn fpr(text: &str) -> Result<[u8; 32], RouteError> {
    unhex(text)
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| malformed("key fingerprint"))
}

/// `read` or `draw`; anything else, `steward` included, is malformed (T4).
fn capability(text: Option<String>) -> Result<Option<Capability>, RouteError> {
    match text.as_deref() {
        None => Ok(None),
        Some("read") => Ok(Some(Capability::Read)),
        Some("draw") => Ok(Some(Capability::Draw)),
        Some(_) => Err(malformed("capability")),
    }
}

fn new_team(m: &mut BTreeMap<String, Json>) -> Result<Option<NewTeam>, RouteError> {
    match (opt_str(m, "slug")?, opt_str(m, "name")?) {
        (Some(slug), Some(name)) => Ok(Some(NewTeam { slug, name })),
        (None, None) => Ok(None),
        _ => Err(malformed("slug and name")),
    }
}

const ACT_FIELDS: &[&str] = &[
    "act",
    "as",
    "key",
    "team",
    "subject",
    "role",
    "scope",
    "capability",
    "undoes",
    "slug",
    "name",
];

const SIGN_FIELDS: &[&str] = &[
    "act_id",
    "team",
    "act",
    "subject",
    "subject_key_fpr",
    "role",
    "scope",
    "capability",
    "undoes",
    "signer",
    "signer_key_fpr",
    "as",
    "at",
    "auth_epoch",
    "root_fpr",
    "signature",
    "slug",
    "name",
];

fn proposal_json(p: &TeamActProposal) -> Json {
    let mut m = BTreeMap::new();
    m.insert("act_id".to_string(), Json::Str(p.act_id.clone()));
    m.insert("team".to_string(), Json::Str(p.team.clone()));
    m.insert("act".to_string(), Json::Str(p.act.clone()));
    m.insert("subject".to_string(), opt_json(&p.subject));
    m.insert(
        "subject_key_fpr".to_string(),
        Json::Str(hex(&p.subject_key_fpr)),
    );
    m.insert("role".to_string(), opt_json(&p.role));
    m.insert("scope".to_string(), opt_json(&p.scope));
    m.insert(
        "capability".to_string(),
        match p.capability {
            Some(c) => Json::Str(c.as_str().to_string()),
            None => Json::Null,
        },
    );
    m.insert("undoes".to_string(), opt_json(&p.undoes));
    m.insert("signer".to_string(), Json::Str(p.signer.clone()));
    m.insert(
        "signer_key_fpr".to_string(),
        Json::Str(hex(&p.signer_key_fpr)),
    );
    m.insert("as".to_string(), Json::Str(p.signer_authority.clone()));
    m.insert("at".to_string(), Json::Int(p.at_unix));
    m.insert("auth_epoch".to_string(), Json::Int(i64::from(p.auth_epoch)));
    m.insert("root_fpr".to_string(), Json::Str(hex(&p.root_fpr)));
    m.insert("bytes".to_string(), Json::Str(hex(&p.bytes)));
    Json::Obj(m)
}

async fn list_handler(
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
    let (steward, list) = teams::list(&tx, &auth)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;

    let seats = |seats: &[teams::Seat]| {
        Json::Arr(
            seats
                .iter()
                .map(|s| {
                    let mut m = BTreeMap::new();
                    m.insert("account".to_string(), Json::Str(s.account.clone()));
                    m.insert("act".to_string(), Json::Str(s.act_id.clone()));
                    Json::Obj(m)
                })
                .collect(),
        )
    };
    let teams_json = list
        .iter()
        .map(|t| {
            let mut m = BTreeMap::new();
            m.insert("id".to_string(), Json::Str(t.id.clone()));
            m.insert("slug".to_string(), Json::Str(t.slug.clone()));
            m.insert("name".to_string(), Json::Str(t.name.clone()));
            m.insert("members".to_string(), seats(&t.members));
            m.insert("leads".to_string(), seats(&t.leads));
            m.insert("supervisors".to_string(), seats(&t.overseers));
            m.insert(
                "grants".to_string(),
                Json::Arr(
                    t.grants
                        .iter()
                        .map(|g| {
                            let mut m = BTreeMap::new();
                            m.insert("act".to_string(), Json::Str(g.act_id.clone()));
                            m.insert("scope".to_string(), opt_json(&g.scope));
                            m.insert(
                                "capability".to_string(),
                                Json::Str(g.capability.as_str().to_string()),
                            );
                            Json::Obj(m)
                        })
                        .collect(),
                ),
            );
            m.insert("may_staff".to_string(), Json::Bool(t.may_staff));
            Json::Obj(m)
        })
        .collect();
    let mut answer = BTreeMap::new();
    answer.insert("steward".to_string(), Json::Bool(steward));
    answer.insert("teams".to_string(), Json::Arr(teams_json));
    Ok(json_response(Json::Obj(answer)))
}

async fn propose_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, ACT_FIELDS)?;
    let request = TeamActRequest {
        act: need_str(&mut m, "act")?,
        signer_authority: need_str(&mut m, "as")?,
        team: opt_str(&mut m, "team")?,
        subject: opt_str(&mut m, "subject")?,
        role: opt_str(&mut m, "role")?,
        scope: opt_str(&mut m, "scope")?,
        capability: capability(opt_str(&mut m, "capability")?)?,
        undoes: opt_str(&mut m, "undoes")?,
    };
    let key = fpr(&need_str(&mut m, "key")?)?;
    let new_team = new_team(&mut m)?;

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
    let proposal = teams::propose_act(&tx, &auth, &request, new_team.as_ref(), &key)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(proposal_json(&proposal)))
}

async fn sign_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, SIGN_FIELDS)?;
    let int = |m: &mut BTreeMap<String, Json>, key: &str| match m.remove(key) {
        Some(Json::Int(n)) => Ok(n),
        _ => Err(malformed("request body")),
    };
    let mut proposal = TeamActProposal {
        act_id: need_str(&mut m, "act_id")?,
        team: need_str(&mut m, "team")?,
        act: need_str(&mut m, "act")?,
        subject: opt_str(&mut m, "subject")?,
        subject_key_fpr: fpr(&need_str(&mut m, "subject_key_fpr")?)?,
        role: opt_str(&mut m, "role")?,
        scope: opt_str(&mut m, "scope")?,
        capability: capability(opt_str(&mut m, "capability")?)?,
        undoes: opt_str(&mut m, "undoes")?,
        signer: need_str(&mut m, "signer")?,
        signer_key_fpr: fpr(&need_str(&mut m, "signer_key_fpr")?)?,
        signer_authority: need_str(&mut m, "as")?,
        at_unix: int(&mut m, "at")?,
        auth_epoch: i32::try_from(int(&mut m, "auth_epoch")?)
            .map_err(|_| malformed("authority epoch"))?,
        root_fpr: fpr(&need_str(&mut m, "root_fpr")?)?,
        bytes: Vec::new(),
    };
    let signature = unhex(&need_str(&mut m, "signature")?)
        .filter(|s| s.len() == 64)
        .ok_or_else(|| malformed("signature"))?;
    let new_team = new_team(&mut m)?;
    // `bytes` is rebuilt inside `commit_act` from the fields; nothing sent is believed.
    proposal.bytes.clear();

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
    let act = teams::commit_act(&tx, &auth, &proposal, new_team.as_ref(), &signature)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    let mut answer = BTreeMap::new();
    answer.insert("act".to_string(), Json::Str(act));
    answer.insert("team".to_string(), Json::Str(proposal.team));
    Ok(json_response(Json::Obj(answer)))
}

async fn rename_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, team)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["slug", "name"])?;
    let renamed = NewTeam {
        slug: need_str(&mut m, "slug")?,
        name: need_str(&mut m, "name")?,
    };
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
    teams::rename(&tx, &auth, &team, &renamed)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    let mut answer = BTreeMap::new();
    answer.insert("team".to_string(), Json::Str(team));
    Ok(json_response(Json::Obj(answer)))
}

async fn history_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, team)): PathExtractor<(String, String)>,
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
    let lines = teams::history(&tx, &auth, &team)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;
    let acts = lines
        .iter()
        .map(|l| {
            let a = &l.act;
            let mut m = BTreeMap::new();
            m.insert("id".to_string(), Json::Str(a.id.clone()));
            m.insert("act".to_string(), Json::Str(a.act.clone()));
            m.insert("subject".to_string(), opt_json(&a.subject_id));
            m.insert("role".to_string(), opt_json(&a.role));
            m.insert("scope".to_string(), opt_json(&a.scope_id));
            m.insert(
                "capability".to_string(),
                match a.capability {
                    Some(c) => Json::Str(c.as_str().to_string()),
                    None => Json::Null,
                },
            );
            m.insert("undoes".to_string(), opt_json(&a.undoes));
            m.insert("by".to_string(), Json::Str(a.signed_by.clone()));
            m.insert("as".to_string(), Json::Str(a.signer_authority.clone()));
            m.insert("at".to_string(), Json::Int(a.at_unix));
            m.insert("counts".to_string(), Json::Bool(l.counts));
            Json::Obj(m)
        })
        .collect();
    let mut answer = BTreeMap::new();
    answer.insert("acts".to_string(), Json::Arr(acts));
    Ok(json_response(Json::Obj(answer)))
}
