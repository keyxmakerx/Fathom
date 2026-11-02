//! The IP plan store's routes (ADR-0083; the store itself is `crate::ipam`).
//!
//! - `POST /organisations/{organisation}/ipam/list`, body `{"kind": text?, "folder": text?}`:
//!   the records the caller may read, each `{"id", "kind", "version", "fields"}` with what is
//!   worked out beside it (a reservation's `lapsed`, a block's `addresses` and `usable`).
//! - `POST /organisations/{organisation}/ipam/create`, body `{"kind": text, "fields": {...}}`.
//! - `POST /organisations/{organisation}/ipam/update`, body `{"id", "version", "fields"}`: the
//!   whole set of fields; `version` is the one the caller read, and a record changed since is
//!   answered 409.
//! - `POST /organisations/{organisation}/ipam/delete`, body `{"id"}`: deletes a record, or
//!   releases a reservation.
//! - `POST /organisations/{organisation}/ipam/next`, body `{"parent", "want": "prefix" |
//!   "address" | "vlan" | "asn", "length": n?, "name": text?, "take": bool, "key": text?,
//!   "hold": {...}?}`: the next free thing in `parent`. With `take` false it only looks; with
//!   `take` true it hands it out under `key` and answers the record made, or the one the same
//!   key made before (`"again": true`).
//!
//! Every answer is JSON; a refusal says why in a sentence (`{"error": text}`), so the browser
//! can show it as it is.

use std::collections::BTreeMap;

use axum::extract::{Path as PathExtractor, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use fathom_canon::Json;
use fathom_ir::scalar::Scalar;

use super::{begin_org, json_response, object_body, DesignApiState, RouteError, Signed};
use crate::grants::{Authority, AuthorityError};
use crate::ipam::{self, Ask, IpamError, IpamKeys, Kind, Want};
use crate::sessions::SessionError;

pub(super) fn routes() -> Router<DesignApiState> {
    Router::new()
        .route(
            "/organisations/{organisation}/ipam/list",
            post(list_handler),
        )
        .route(
            "/organisations/{organisation}/ipam/create",
            post(create_handler),
        )
        .route(
            "/organisations/{organisation}/ipam/update",
            post(update_handler),
        )
        .route(
            "/organisations/{organisation}/ipam/delete",
            post(delete_handler),
        )
        .route(
            "/organisations/{organisation}/ipam/next",
            post(next_handler),
        )
}

/// A refusal from the store, as a status and a sentence.
pub(super) fn ipam_error_response(e: IpamError) -> Response {
    let (status, sentence) = match &e {
        IpamError::Invalid(_) => (StatusCode::UNPROCESSABLE_ENTITY, e.to_string()),
        IpamError::NotFound => (StatusCode::NOT_FOUND, e.to_string()),
        IpamError::Stale
        | IpamError::Clash
        | IpamError::KeyUsedElsewhere
        | IpamError::Full
        | IpamError::InUse(_) => (StatusCode::CONFLICT, e.to_string()),
        IpamError::Authority(AuthorityError::NotAuthorised)
        | IpamError::Authority(AuthorityError::QuorumNotMet { .. }) => {
            (StatusCode::FORBIDDEN, "not authorised".to_string())
        }
        IpamError::Authority(inner) => return super::authority_refusal_response(inner),
        IpamError::Db(_) | IpamError::Corrupt(_) => {
            tracing::error!(reason = %e, "ip plan store failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "refused".to_string())
        }
    };
    let mut m = BTreeMap::new();
    m.insert("error".to_string(), Json::Str(sentence));
    (
        status,
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        Json::Obj(m).to_canonical_bytes(),
    )
        .into_response()
}

fn kind_field(m: &mut BTreeMap<String, Json>) -> Result<Option<Kind>, RouteError> {
    match m.remove("kind") {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Str(k)) => Kind::from_token(&k)
            .map(Some)
            .ok_or_else(|| SessionError::Malformed("kind").into()),
        Some(_) => Err(SessionError::Malformed("kind").into()),
    }
}

fn id_field(m: &mut BTreeMap<String, Json>, name: &'static str) -> Result<String, RouteError> {
    match m.remove(name) {
        Some(Json::Str(id)) if id.len() == 26 && id.chars().all(|c| c.is_ascii_alphanumeric()) => {
            Ok(id)
        }
        _ => Err(SessionError::Malformed(name).into()),
    }
}

fn fields_field(
    m: &mut BTreeMap<String, Json>,
    name: &'static str,
) -> Result<ipam::Fields, RouteError> {
    match m.remove(name) {
        Some(Json::Obj(fields)) => Ok(fields),
        None | Some(Json::Null) if name == "hold" => Ok(ipam::Fields::new()),
        _ => Err(SessionError::Malformed(name).into()),
    }
}

fn record_answer(record: &ipam::Record, today: &fathom_ir::scalar::Date) -> Json {
    record.to_json(today)
}

async fn list_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut body = object_body(&signed.body, &["kind", "folder"])?;
    let kind = kind_field(&mut body)?;
    let folder = match body.remove("folder") {
        None | Some(Json::Null) => None,
        Some(Json::Str(f)) => Some(f),
        Some(_) => return Err(SessionError::Malformed("folder").into()),
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
    let keys = IpamKeys::derive(&tenant_key, &ctx.tenant().to_string());
    let records = match ipam::list(&tx, &auth, &keys, kind, folder.as_deref()).await {
        Ok(r) => r,
        Err(e) => return Ok(ipam_error_response(e)),
    };
    tx.commit().await.map_err(SessionError::Db)?;
    let today = ipam::today();
    let mut m = BTreeMap::new();
    m.insert(
        "records".into(),
        Json::Arr(records.iter().map(|r| record_answer(r, &today)).collect()),
    );
    m.insert("today".into(), Json::Str(today.canonical()));
    Ok(json_response(Json::Obj(m)))
}

async fn create_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut body = object_body(&signed.body, &["kind", "fields"])?;
    let kind = kind_field(&mut body)?.ok_or(SessionError::Malformed("kind"))?;
    let fields = fields_field(&mut body, "fields")?;
    write(&state, &signed, &organisation, Op::Create { kind, fields }).await
}

async fn update_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut body = object_body(&signed.body, &["id", "version", "fields"])?;
    let id = id_field(&mut body, "id")?;
    let version = match body.remove("version") {
        Some(Json::Int(v)) if v >= 1 => v,
        _ => return Err(SessionError::Malformed("version").into()),
    };
    let fields = fields_field(&mut body, "fields")?;
    write(
        &state,
        &signed,
        &organisation,
        Op::Update {
            id,
            version,
            fields,
        },
    )
    .await
}

async fn delete_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut body = object_body(&signed.body, &["id"])?;
    let id = id_field(&mut body, "id")?;
    write(&state, &signed, &organisation, Op::Delete { id }).await
}

/// One write the store does.
enum Op {
    Create {
        kind: Kind,
        fields: ipam::Fields,
    },
    Update {
        id: String,
        version: i64,
        fields: ipam::Fields,
    },
    Delete {
        id: String,
    },
}

/// Run one write in the caller's tenant transaction and answer the record.
async fn write(
    state: &DesignApiState,
    signed: &Signed,
    organisation: &str,
    op: Op,
) -> Result<Response, RouteError> {
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key) = begin_org(state, signed, &mut client, organisation).await?;
    let keys = IpamKeys::derive(&tenant_key, &ctx.tenant().to_string());
    let today = ipam::today();
    let result = {
        let auth = Authority {
            ring: &state.ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &state.watch,
        };
        match &op {
            Op::Create { kind, fields } => {
                ipam::create(&tx, &auth, &keys, *kind, fields, &today).await
            }
            Op::Update {
                id,
                version,
                fields,
            } => ipam::update(&tx, &auth, &keys, id, *version, fields).await,
            Op::Delete { id } => ipam::delete(&tx, &auth, &keys, id).await,
        }
    };
    match result {
        Ok(record) => {
            tx.commit().await.map_err(SessionError::Db)?;
            let mut m = BTreeMap::new();
            m.insert("record".into(), record_answer(&record, &today));
            Ok(json_response(Json::Obj(m)))
        }
        Err(e) => Ok(ipam_error_response(e)),
    }
}

async fn next_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut body = object_body(
        &signed.body,
        &["parent", "want", "length", "name", "take", "key", "hold"],
    )?;
    let parent = id_field(&mut body, "parent")?;
    let want = match (
        body.remove("want"),
        body.remove("length"),
        body.remove("name"),
    ) {
        (Some(Json::Str(w)), Some(Json::Int(len)), None)
            if w == "prefix" && (0..=128).contains(&len) =>
        {
            Want::Prefix(len as u8)
        }
        (Some(Json::Str(w)), None, None) if w == "address" => Want::Address,
        (Some(Json::Str(w)), None, Some(Json::Str(name))) if w == "vlan" => Want::Vlan(name),
        (Some(Json::Str(w)), None, None) if w == "vlan" => Want::Vlan(String::new()),
        (Some(Json::Str(w)), None, None) if w == "asn" => Want::Asn,
        _ => return Err(SessionError::Malformed("want").into()),
    };
    let take = match body.remove("take") {
        Some(Json::Bool(b)) => b,
        None => false,
        Some(_) => return Err(SessionError::Malformed("take").into()),
    };
    let key = match body.remove("key") {
        None | Some(Json::Null) => None,
        Some(Json::Str(k)) => Some(k),
        Some(_) => return Err(SessionError::Malformed("key").into()),
    };
    let hold = fields_field(&mut body, "hold")?;
    if take {
        if let Want::Vlan(name) = &want {
            if name.trim().is_empty() {
                return Err(SessionError::Malformed("name").into());
            }
        }
    }
    let ask = Ask {
        parent,
        want,
        key,
        hold,
    };
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (tx, ctx, tenant_key) = begin_org(&state, &signed, &mut client, &organisation).await?;
    let keys = IpamKeys::derive(&tenant_key, &ctx.tenant().to_string());
    let today = ipam::today();
    let answer = {
        let auth = Authority {
            ring: &state.ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &state.watch,
        };
        ipam::allocate(&tx, &auth, &keys, &ask, take, &today).await
    };
    let answer = match answer {
        Ok(a) => a,
        Err(e) => return Ok(ipam_error_response(e)),
    };
    tx.commit().await.map_err(SessionError::Db)?;
    let mut m = BTreeMap::new();
    match answer {
        ipam::Answer::Free(value) => {
            m.insert("free".into(), Json::Str(value));
        }
        ipam::Answer::Taken { record, again } => {
            m.insert("record".into(), record_answer(&record, &today));
            m.insert("again".into(), Json::Bool(again));
        }
    }
    Ok(json_response(Json::Obj(m)))
}
