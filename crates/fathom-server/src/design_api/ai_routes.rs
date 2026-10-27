//! The browser's half of AI access (ADR-0072): a person's keys, the organisation's policy,
//! and the AI ideas on a design. Ordinary signed session requests, through
//! [`super::begin_org`] like every other organisation route; the rules are in `crate::ai`.

use std::collections::BTreeMap;

use axum::extract::{Path as PathExtractor, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use fathom_canon::Json;

use super::{
    begin_org, json_response, object_body, parse_design, DesignApiState, RouteError, Signed,
};
use crate::ai::{self, AiError, KeyChange, NewConnector, NewKey, PolicyInput};
use crate::grants::Authority;
use crate::sessions::SessionError;

pub(super) fn routes() -> Router<DesignApiState> {
    Router::new()
        .route("/organisations/{organisation}/ai", get(overview_handler))
        .route(
            "/organisations/{organisation}/ai/policy",
            post(set_policy_handler),
        )
        .route(
            "/organisations/{organisation}/ai/keys",
            post(make_key_handler),
        )
        .route(
            "/organisations/{organisation}/ai/keys/{key}",
            post(change_key_handler),
        )
        .route(
            "/organisations/{organisation}/ai/keys/{key}/disable",
            post(disable_key_handler),
        )
        .route(
            "/organisations/{organisation}/ai/keys/{key}/delete",
            post(delete_key_handler),
        )
        .route(
            "/organisations/{organisation}/ai/connect",
            post(connect_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/ai-ideas",
            get(list_ideas_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/ai-ideas/{idea}/accept",
            post(accept_idea_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/ai-ideas/{idea}/dismiss",
            post(dismiss_idea_handler),
        )
}

impl From<AiError> for RouteError {
    fn from(e: AiError) -> Self {
        Self::Ai(e)
    }
}

fn malformed() -> RouteError {
    SessionError::Malformed("request body").into()
}

fn take_bool(m: &mut BTreeMap<String, Json>, key: &str) -> Result<Option<bool>, RouteError> {
    match m.remove(key) {
        None => Ok(None),
        Some(Json::Bool(b)) => Ok(Some(b)),
        Some(_) => Err(malformed()),
    }
}

fn take_int(m: &mut BTreeMap<String, Json>, key: &str) -> Result<Option<i64>, RouteError> {
    match m.remove(key) {
        None => Ok(None),
        Some(Json::Int(v)) => Ok(Some(v)),
        Some(_) => Err(malformed()),
    }
}

fn take_str(m: &mut BTreeMap<String, Json>, key: &str) -> Result<Option<String>, RouteError> {
    match m.remove(key) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Str(s)) => Ok(Some(s)),
        Some(_) => Err(malformed()),
    }
}

fn take_strs(m: &mut BTreeMap<String, Json>, key: &str) -> Result<Option<Vec<String>>, RouteError> {
    match m.remove(key) {
        None => Ok(None),
        Some(Json::Arr(items)) => items
            .into_iter()
            .map(|j| match j {
                Json::Str(s) => Ok(s),
                _ => Err(malformed()),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(malformed()),
    }
}

fn version(m: &mut BTreeMap<String, Json>) -> Result<i64, RouteError> {
    match take_int(m, "ifVersion")? {
        Some(v) if v >= 0 => Ok(v),
        _ => Err(malformed()),
    }
}

fn key_id(text: &str) -> Result<String, RouteError> {
    ai::canonical_ulid(text).ok_or(RouteError::Ai(AiError::NotFound))
}

async fn deployment(tx: &deadpool_postgres::Transaction<'_>) -> Result<String, RouteError> {
    Ok(tx
        .query_one("SELECT id FROM deployments", &[])
        .await
        .map_err(SessionError::Db)?
        .get(0))
}

/// `GET /organisations/{o}/ai`: the switch, the policy, the caller's keys (a Steward's: all),
/// the deployment id the helper signs for, and the connector's `/mcp` address or null. Any
/// member.
async fn overview_handler(
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
    let mut page = ai::overview(&tx, &auth).await?;
    if let Json::Obj(m) = &mut page {
        m.insert("deployment".into(), Json::Str(deployment(&tx).await?));
        // The address a person pastes into their AI app, when the operator turned the
        // connector on (ADR-0072 decision 13).
        m.insert(
            "connector".into(),
            match &state.ai_connector {
                Some(c) => Json::Str(c.resource()),
                None => Json::Null,
            },
        );
    }
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(page))
}

/// `POST /organisations/{o}/ai/policy`: `{allowed, makers, ceiling, maxDays, mayChange,
/// secondPersonScopes, ifVersion}`, `ifVersion` 0 for the first. Steward.
async fn set_policy_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(
        &signed.body,
        &[
            "allowed",
            "makers",
            "ceiling",
            "maxDays",
            "secondPersonScopes",
            "apps",
            "mayChange",
            "ifVersion",
        ],
    )?;
    let input = PolicyInput {
        allowed: take_bool(&mut m, "allowed")?.ok_or_else(malformed)?,
        makers: take_strs(&mut m, "makers")?.ok_or_else(malformed)?,
        ceiling: take_strs(&mut m, "ceiling")?.ok_or_else(malformed)?,
        max_days: take_int(&mut m, "maxDays")?
            .and_then(|d| i32::try_from(d).ok())
            .ok_or_else(malformed)?,
        second_person_scopes: take_strs(&mut m, "secondPersonScopes")?.unwrap_or_default(),
        // Absent: Claude only, as a policy with no row reads.
        apps: take_strs(&mut m, "apps")?.unwrap_or_else(|| vec!["claude".to_string()]),
        // Absent: off, the safe reading of a client that does not know the tick.
        may_change: take_bool(&mut m, "mayChange")?.unwrap_or(false),
    };
    let if_version = i32::try_from(version(&mut m)?).map_err(|_| malformed())?;
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
    let policy = ai::set_policy(&tx, &auth, input, if_version).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(policy.to_json()))
}

/// `POST /organisations/{o}/ai/keys`: `{publicKey, label, scopes, sees, mayRecommend, days}`,
/// the public key as the helper's pair step prints it (hex). Answers the key and the
/// deployment id, which the helper needs to sign.
async fn make_key_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(
        &signed.body,
        &[
            "publicKey",
            "label",
            "aiAccount",
            "scopes",
            "sees",
            "mayRecommend",
            "mayChange",
            "days",
        ],
    )?;
    let input = NewKey {
        public_key: take_str(&mut m, "publicKey")?
            .and_then(|h| ai::unhex(h.trim()))
            .ok_or(RouteError::Ai(AiError::Malformed(
                "that is not a key the Fathom AI helper made",
            )))?,
        label: take_str(&mut m, "label")?.ok_or_else(malformed)?,
        ai_account: take_str(&mut m, "aiAccount")?.unwrap_or_default(),
        scopes: take_strs(&mut m, "scopes")?.unwrap_or_default(),
        sees: take_strs(&mut m, "sees")?.unwrap_or_default(),
        may_recommend: take_bool(&mut m, "mayRecommend")?.unwrap_or(false),
        may_change: take_bool(&mut m, "mayChange")?.unwrap_or(false),
        days: take_int(&mut m, "days")?
            .and_then(|d| i32::try_from(d).ok())
            .ok_or_else(malformed)?,
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
    let key = ai::make_key(&tx, &auth, input).await?;
    let deployment = deployment(&tx).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    let mut out = BTreeMap::new();
    out.insert("key".into(), key.to_json(0));
    out.insert("deployment".into(), Json::Str(deployment));
    out.insert("organisation".into(), Json::Str(organisation));
    Ok(json_response(Json::Obj(out)))
}

/// `POST /organisations/{o}/ai/connect`: the person's answer on the "Connect an AI app"
/// page (ADR-0072 decision 15). `{request, allow, label?, scopes, sees, mayRecommend,
/// days}`, where `request` is the app's sign-in query string as the page was given it. The
/// request is checked again here, not trusted from the page. Answers `{redirect}`, where
/// the browser goes next: back to the app with a code, or with `access_denied`.
async fn connect_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let Some(connector) = state.ai_connector.clone() else {
        return Err(RouteError::Ai(AiError::NotFound));
    };
    let mut m = object_body(
        &signed.body,
        &[
            "request",
            "allow",
            "label",
            "aiAccount",
            "scopes",
            "sees",
            "mayRecommend",
            "mayChange",
            "days",
        ],
    )?;
    let request = take_str(&mut m, "request")?.ok_or_else(malformed)?;
    let allow = take_bool(&mut m, "allow")?.ok_or_else(malformed)?;
    let form = crate::oauth::form(request.trim_start_matches('?'))
        .map_err(|_| RouteError::Ai(AiError::Malformed("that sign-in request is not readable")))?;
    let checked = match connector
        .check(
            state.sessions.pool(),
            &crate::oauth::AuthRequest::from_form(&form),
        )
        .await?
    {
        Ok(c) => c,
        Err(problem) => return Err(RouteError::Ai(AiError::NotAllowed(problem.description))),
    };
    let mut out = BTreeMap::new();
    if !allow {
        out.insert("redirect".into(), Json::Str(connector.denied(&checked)));
        return Ok(json_response(Json::Obj(out)));
    }
    let choice = NewConnector {
        client_id: checked.client.id.clone(),
        label: take_str(&mut m, "label")?.unwrap_or_else(|| {
            checked
                .client
                .name
                .chars()
                .take(ai::MAX_LABEL_CHARS)
                .collect()
        }),
        ai_account: take_str(&mut m, "aiAccount")?.unwrap_or_default(),
        scopes: take_strs(&mut m, "scopes")?.unwrap_or_default(),
        sees: take_strs(&mut m, "sees")?.unwrap_or_default(),
        may_recommend: take_bool(&mut m, "mayRecommend")?.unwrap_or(false),
        may_change: take_bool(&mut m, "mayChange")?.unwrap_or(false),
        days: take_int(&mut m, "days")?
            .and_then(|d| i32::try_from(d).ok())
            .ok_or_else(malformed)?,
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
    let (key, redirect) = connector.allow(&tx, &auth, &checked, choice).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    out.insert("key".into(), key.to_json(0));
    out.insert("redirect".into(), Json::Str(redirect));
    Ok(json_response(Json::Obj(out)))
}

/// `POST /organisations/{o}/ai/keys/{k}`: `{ifVersion, label?, scopes?, sees?,
/// mayRecommend?, endsInDays?}`. The owner widens or narrows; a Steward narrows.
async fn change_key_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, key)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let id = key_id(&key)?;
    let mut m = object_body(
        &signed.body,
        &[
            "ifVersion",
            "label",
            "scopes",
            "sees",
            "mayRecommend",
            "mayChange",
            "endsInDays",
        ],
    )?;
    let if_version = i32::try_from(version(&mut m)?).map_err(|_| malformed())?;
    let change = KeyChange {
        label: take_str(&mut m, "label")?,
        scopes: take_strs(&mut m, "scopes")?,
        sees: take_strs(&mut m, "sees")?,
        may_recommend: take_bool(&mut m, "mayRecommend")?,
        may_change: take_bool(&mut m, "mayChange")?,
        ends_in_days: take_int(&mut m, "endsInDays")?
            .map(|d| i32::try_from(d).map_err(|_| malformed()))
            .transpose()?,
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
    let key = ai::change_key(&tx, &auth, &id, change, if_version).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(key.to_json(0)))
}

async fn stop_key(
    state: DesignApiState,
    organisation: String,
    key: String,
    signed: Signed,
    delete: bool,
) -> Result<Response, RouteError> {
    let id = key_id(&key)?;
    let mut m = object_body(&signed.body, &["ifVersion", "reason"])?;
    let if_version = i32::try_from(version(&mut m)?).map_err(|_| malformed())?;
    let reason = take_str(&mut m, "reason")?;
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
    let key = ai::stop_key(&tx, &auth, &id, if_version, reason, delete).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(key.to_json(0)))
}

/// `POST /organisations/{o}/ai/keys/{k}/disable`: `{ifVersion, reason?}`; a Steward stopping
/// someone else's key gives a reason.
async fn disable_key_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, key)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    stop_key(state, organisation, key, signed, false).await
}

/// `POST /organisations/{o}/ai/keys/{k}/delete`: `{ifVersion, reason?}`.
async fn delete_key_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, key)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    stop_key(state, organisation, key, signed, true).await
}

/// `GET /organisations/{o}/designs/{d}/ai-ideas`. Needs `read`.
async fn list_ideas_handler(
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
    let found = ai::list_ideas(&tx, &auth, design_id).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(Json::Arr(
        found.iter().map(ai::Idea::to_json).collect(),
    )))
}

async fn decide_idea(
    state: DesignApiState,
    path: (String, String, String),
    signed: Signed,
    accept: bool,
) -> Result<Response, RouteError> {
    let (organisation, design, idea) = path;
    let design_id = parse_design(&design)?;
    let id = ai::canonical_ulid(&idea).ok_or(RouteError::Ai(AiError::NotFound))?;
    let mut m = object_body(&signed.body, &["ifVersion"])?;
    let if_version = version(&mut m)?;
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
    let done = ai::decide_idea(&tx, &auth, design_id, &id, if_version, accept).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(done.to_json()))
}

/// `POST .../ai-ideas/{i}/accept`: `{ifVersion}`. Needs `draw`; see `ai::decide_idea` for
/// the second-person rule.
async fn accept_idea_handler(
    State(state): State<DesignApiState>,
    PathExtractor(path): PathExtractor<(String, String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    decide_idea(state, path, signed, true).await
}

/// `POST .../ai-ideas/{i}/dismiss`: `{ifVersion}`. Needs `draw`.
async fn dismiss_idea_handler(
    State(state): State<DesignApiState>,
    PathExtractor(path): PathExtractor<(String, String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    decide_idea(state, path, signed, false).await
}
