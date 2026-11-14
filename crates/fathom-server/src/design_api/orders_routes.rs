//! Orders' routes (ADR-0084 piece 2). The rules are the engine's and `crate::orders`'; these are
//! plumbing. Any member of the organisation reads order types and orders and opens an order;
//! saving an order type is a Steward's; who may take each action on an order is the engine's
//! answer, from the caller's standing on the order's teams.
//!
//! - `GET  /organisations/{o}/order-types`: `{"steward": bool, "types": [{id, version, name,
//!   code, file_id, saved_by, saved_at}]}`, the latest version of each, by name.
//! - `POST /organisations/{o}/order-types`: body `{"source", "field_sets"?, "teams"?, "id"?}`.
//!   `teams` matches slugs to team ids by hand; a slug left out matches the team with that slug.
//!   With `id`, a new version of that type. Answers the saved type as `GET` below does.
//!   Refusals a Steward can act on are JSON: `{"error": "problems", "problems": [{line,
//!   message}]}`, `{"error": "unmatched_teams", "slugs": [..]}`, `{"error": "looks_secret"}`.
//! - `POST /organisations/{o}/order-types/check`: body `{"source", "field_sets"?}`. A Steward's.
//!   Saves nothing: `{"problems": [{line, message}], "definition": {..} | null, "slugs": [..],
//!   "teams": {id: {slug, name}}}`, what the board draws and the File tab marks as it is typed.
//! - `GET  /organisations/{o}/order-types/{t}`: `{id, version, name, code, file_id, saved_by,
//!   saved_at, source, field_sets, teams, definition, live_teams}`.
//! - `GET  /organisations/{o}/orders` (open) and `.../orders/finished`: `{"orders": [{id, number,
//!   type, type_version, opened_by, opened_at, status, updated_at}], "people": {id: name}}`,
//!   newest first.
//! - `POST /organisations/{o}/orders`: body `{"type", "answers"}`, answers keyed by field.
//!   Answers the order as `GET` below does.
//! - `GET  /organisations/{o}/orders/{id}`: the order as it stands: answers, lanes with their
//!   stages and jobs, holds, its history, its definition as asked, the caller's standing on its
//!   teams (`you`), and the names of its people and teams. A `makes: plan` job whose plan is now
//!   recorded is finished by the engine first.
//! - `POST /organisations/{o}/orders/{id}/act`: body `{"action", ..}` with the action's own
//!   keys (`job`, `step`, `done`, `field`, `value`, `reason`, `stage`, `design`, `plan`).
//!   Answers the order. The engine's refusal is `409 {"error": "refused", "message"}`.

use std::collections::BTreeMap;

use axum::extract::{Path as PathExtractor, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use fathom_canon::Json;

use super::{
    authority_refusal_response, begin_org, design_error_response, json_response, object_body,
    DesignApiState, RouteError, Signed,
};
use crate::grants::{self, Authority};
use crate::orders::{self, OrderError, OrderType, TypeRequest};
use crate::sessions::SessionError;

pub(super) fn routes() -> Router<DesignApiState> {
    Router::new()
        .route(
            "/organisations/{organisation}/order-types",
            get(types_handler).post(save_type_handler),
        )
        .route(
            "/organisations/{organisation}/order-types/check",
            post(check_type_handler),
        )
        .route(
            "/organisations/{organisation}/order-types/{id}",
            get(type_handler),
        )
        .route(
            "/organisations/{organisation}/orders",
            get(open_orders_handler).post(open_order_handler),
        )
        .route(
            "/organisations/{organisation}/orders/finished",
            get(finished_orders_handler),
        )
        .route(
            "/organisations/{organisation}/orders/{id}",
            get(order_handler),
        )
        .route(
            "/organisations/{organisation}/orders/{id}/act",
            post(act_handler),
        )
}

fn json_status(status: StatusCode, j: Json) -> Response {
    (
        status,
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        j.to_canonical_bytes(),
    )
        .into_response()
}

fn obj(entries: Vec<(&str, Json)>) -> Json {
    Json::Obj(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

/// An order act's refusal.
pub(super) fn order_error_response(e: OrderError) -> Response {
    match e {
        OrderError::Design(e) => design_error_response(e),
        OrderError::Authority(e) => authority_refusal_response(&e),
        OrderError::Problems(problems) => json_status(
            StatusCode::UNPROCESSABLE_ENTITY,
            obj(vec![
                ("error", Json::Str("problems".into())),
                (
                    "problems",
                    Json::Arr(
                        problems
                            .into_iter()
                            .map(|p| {
                                obj(vec![
                                    ("line", Json::Int(p.line as i64)),
                                    ("message", Json::Str(p.message)),
                                ])
                            })
                            .collect(),
                    ),
                ),
            ]),
        ),
        OrderError::Unmatched(slugs) => json_status(
            StatusCode::UNPROCESSABLE_ENTITY,
            obj(vec![
                ("error", Json::Str("unmatched_teams".into())),
                (
                    "slugs",
                    Json::Arr(slugs.into_iter().map(Json::Str).collect()),
                ),
            ]),
        ),
        OrderError::Refused(message) => json_status(
            StatusCode::CONFLICT,
            obj(vec![
                ("error", Json::Str("refused".into())),
                ("message", Json::Str(message)),
            ]),
        ),
        OrderError::LooksSecret(what) => json_status(
            StatusCode::UNPROCESSABLE_ENTITY,
            obj(vec![
                ("error", Json::Str("looks_secret".into())),
                ("what", Json::Str(what)),
            ]),
        ),
        OrderError::NotFound => {
            (StatusCode::NOT_FOUND, "no such order or order type\n").into_response()
        }
        OrderError::Malformed(what) => {
            tracing::info!(what, "malformed order request");
            (StatusCode::BAD_REQUEST, "malformed request\n").into_response()
        }
        OrderError::Limit(why) => (StatusCode::CONFLICT, format!("{why}\n")).into_response(),
    }
}

fn malformed() -> RouteError {
    SessionError::Malformed("request body").into()
}

fn strings(j: Option<Json>) -> Result<Vec<String>, RouteError> {
    match j {
        None | Some(Json::Null) => Ok(Vec::new()),
        Some(Json::Arr(items)) => items
            .into_iter()
            .map(|i| match i {
                Json::Str(s) => Ok(s),
                _ => Err(malformed()),
            })
            .collect(),
        Some(_) => Err(malformed()),
    }
}

fn type_json(t: &OrderType, with_source: bool) -> Json {
    let mut entries = vec![
        ("id", Json::Str(t.id.clone())),
        ("version", Json::Int(i64::from(t.version))),
        ("name", Json::Str(t.definition.name.clone())),
        (
            "code",
            t.definition
                .number
                .as_ref()
                .map_or(Json::Null, |n| Json::Str(n.clone())),
        ),
        ("file_id", Json::Str(t.definition.id.clone())),
        ("saved_by", Json::Str(t.saved_by.clone())),
        ("saved_at", Json::Int(t.saved_at)),
    ];
    if with_source {
        entries.push(("source", Json::Str(t.source.clone())));
        entries.push((
            "field_sets",
            Json::Arr(t.field_sets.iter().cloned().map(Json::Str).collect()),
        ));
        entries.push((
            "teams",
            Json::Obj(
                t.teams
                    .iter()
                    .map(|(k, v)| (k.clone(), Json::Str(v.clone())))
                    .collect(),
            ),
        ));
    }
    obj(entries)
}

/// Opens the organisation's transaction and runs `f` in it, committing only on success.
macro_rules! in_org {
    ($state:expr, $signed:expr, $organisation:expr, |$tx:ident, $auth:ident| $body:expr) => {{
        let mut client = $state
            .sessions
            .pool()
            .get()
            .await
            .map_err(SessionError::Pool)?;
        let ($tx, ctx, tenant_key) =
            begin_org(&$state, &$signed, &mut client, &$organisation).await?;
        let $auth = Authority {
            ring: &$state.ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &$state.watch,
        };
        let out = match $body {
            Ok(v) => v,
            Err(e) => return Ok(order_error_response(e)),
        };
        $tx.commit().await.map_err(SessionError::Db)?;
        out
    }};
}

async fn types_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let (steward, types) = in_org!(state, signed, organisation, |tx, auth| async {
        let steward = grants::is_steward(&tx, &auth).await?;
        Ok::<_, OrderError>((steward, orders::list_types(&tx, &auth).await?))
    }
    .await);
    Ok(json_response(obj(vec![
        ("steward", Json::Bool(steward)),
        (
            "types",
            Json::Arr(types.iter().map(|t| type_json(t, false)).collect()),
        ),
    ])))
}

async fn save_type_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["id", "source", "field_sets", "teams"])?;
    let id = match m.remove("id") {
        None | Some(Json::Null) => None,
        Some(Json::Str(s)) => Some(s),
        Some(_) => return Err(malformed()),
    };
    let Some(Json::Str(source)) = m.remove("source") else {
        return Err(malformed());
    };
    let field_sets = strings(m.remove("field_sets"))?;
    let teams = match m.remove("teams") {
        None | Some(Json::Null) => BTreeMap::new(),
        Some(Json::Obj(t)) => t
            .into_iter()
            .map(|(k, v)| match v {
                Json::Str(v) => Ok((k, v)),
                _ => Err(malformed()),
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err(malformed()),
    };
    let req = TypeRequest {
        id,
        source,
        field_sets,
        teams,
    };
    let saved = in_org!(state, signed, organisation, |tx, auth| orders::save_type(
        &tx, &auth, req
    )
    .await);
    Ok(json_response(type_json(&saved, true)))
}

async fn type_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, id)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let (ty, teams) = in_org!(state, signed, organisation, |tx, auth| async {
        let ty = orders::get_type(&tx, &auth, &id, None).await?;
        let teams = orders::live_teams(&tx, &auth).await?;
        Ok::<_, OrderError>((ty, teams))
    }
    .await);
    let Json::Obj(mut m) = type_json(&ty, true) else {
        unreachable!("an order type is an object")
    };
    m.insert("definition".into(), orders::definition_json(&ty.definition));
    m.insert("live_teams".into(), teams);
    Ok(json_response(Json::Obj(m)))
}

async fn check_type_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["source", "field_sets"])?;
    let Some(Json::Str(source)) = m.remove("source") else {
        return Err(malformed());
    };
    let field_sets = strings(m.remove("field_sets"))?;
    let answer = in_org!(state, signed, organisation, |tx, auth| orders::check_type(
        &tx,
        &auth,
        &source,
        &field_sets
    )
    .await);
    Ok(json_response(answer))
}

async fn list(
    state: DesignApiState,
    organisation: String,
    signed: Signed,
    done: bool,
) -> Result<Response, RouteError> {
    let (lines, names) = in_org!(state, signed, organisation, |tx, auth| async {
        let lines = orders::list_orders(&tx, &auth, done, 200).await?;
        let names = orders::opener_names(&tx, &auth, &lines).await?;
        Ok::<_, OrderError>((lines, names))
    }
    .await);
    Ok(json_response(obj(vec![
        (
            "people",
            Json::Obj(names.into_iter().map(|(k, v)| (k, Json::Str(v))).collect()),
        ),
        (
            "orders",
            Json::Arr(
                lines
                    .into_iter()
                    .map(|l| {
                        obj(vec![
                            ("id", Json::Str(l.id)),
                            ("number", Json::Int(l.number)),
                            ("type", Json::Str(l.type_id)),
                            ("type_version", Json::Int(i64::from(l.type_version))),
                            ("opened_by", Json::Str(l.opened_by)),
                            ("opened_at", Json::Int(l.opened_at)),
                            ("status", Json::Str(l.status)),
                            ("updated_at", Json::Int(l.updated_at)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])))
}

async fn open_orders_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    list(state, organisation, signed, false).await
}

async fn finished_orders_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    list(state, organisation, signed, true).await
}

async fn open_order_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["type", "answers"])?;
    let Some(Json::Str(type_id)) = m.remove("type") else {
        return Err(malformed());
    };
    let answers = match m.remove("answers") {
        None | Some(Json::Null) => BTreeMap::new(),
        Some(Json::Obj(a)) => a,
        Some(_) => return Err(malformed()),
    };
    let view = in_org!(state, signed, organisation, |tx, auth| async {
        let view = orders::open_order(&tx, &auth, &type_id, answers).await?;
        orders::describe(&tx, &auth, &view).await
    }
    .await);
    Ok(json_response(view))
}

async fn order_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, id)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let view = in_org!(state, signed, organisation, |tx, auth| async {
        let view = orders::get_order(&tx, &auth, &id).await?;
        orders::describe(&tx, &auth, &view).await
    }
    .await);
    Ok(json_response(view))
}

async fn act_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, id)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(
        &signed.body,
        &[
            "action", "job", "step", "done", "field", "value", "reason", "stage", "design", "plan",
        ],
    )?;
    let Some(Json::Str(word)) = m.remove("action") else {
        return Err(malformed());
    };
    let view = in_org!(state, signed, organisation, |tx, auth| async {
        let view = orders::act(&tx, &auth, &id, &word, m).await?;
        orders::describe(&tx, &auth, &view).await
    }
    .await);
    Ok(json_response(view))
}
