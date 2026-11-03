//! Reading a device's routes (ADR-0082; migration 0073; sign-off r100). The rules are in
//! [`crate::device_reading`]; these are plumbing. The reader is asked between two transactions,
//! so no database transaction is held open while a device answers.
//!
//! - `POST /organisations/{o}/designs/{d}/device-read`: body `{element, kind, login?,
//!   confirm?}`, kind `device` or `macarp`. Answers one of:
//!   `{"outcome": "confirm", engineId, state, previous}` — the agent at the device's address is
//!   not confirmed yet, and nothing but "who are you" was sent to it; the person types the last 8
//!   characters of `engineId` and sends them back as `confirm`.
//!   `{"outcome": "read", id, ...}` — read, through the gate, sealed and filed.
//!   `{"outcome": "failed", failure: {code, message}, engineId?, previous?}` — the device or the
//!   login refused; filed, nothing kept.
//! - `GET /organisations/{o}/designs/{d}/device-read/{element}`: what the Readings tab shows
//!   ([`crate::device_reading::panel`]).
//! - `POST /organisations/{o}/designs/{d}/device-read/dismiss`: body `{element, field, value}`.
//! - `GET /organisations/{o}/device-read/engines`: a Steward's list of agents waiting.
//! - `POST /organisations/{o}/device-read/engines/approve`: body `{addresses: [..]}`, one batch.

use std::collections::BTreeMap;
use std::net::IpAddr;

use axum::extract::{Path as PathExtractor, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use fathom_canon::Json;

use super::{begin_org, json_response, object_body, str_field, DesignApiState, RouteError, Signed};
use crate::chain::EntryType;
use crate::chains;
use crate::device_reading::{self as reading, ReadingKeys, Target};
use crate::grants::Authority;
use crate::sessions::SessionError;
use crate::vault::{entry_metadata, VaultError};

pub(super) fn routes() -> Router<DesignApiState> {
    Router::new()
        .route(
            "/organisations/{organisation}/designs/{design}/device-read",
            post(read_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/device-read/dismiss",
            post(dismiss_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/device-read/{element}",
            get(panel_handler),
        )
        .route(
            "/organisations/{organisation}/device-read/engines",
            get(engines_handler),
        )
        .route(
            "/organisations/{organisation}/device-read/engines/approve",
            post(approve_handler),
        )
}

fn malformed(what: &'static str) -> RouteError {
    SessionError::Malformed(what).into()
}

fn need(m: &mut BTreeMap<String, Json>, key: &'static str) -> Result<String, RouteError> {
    str_field(m, key)?.ok_or_else(|| malformed(key))
}

fn s(v: &str) -> Json {
    Json::Str(v.to_string())
}

macro_rules! in_org {
    ($state:expr, $signed:expr, $organisation:expr, |$tx:ident, $auth:ident, $keys:ident| $body:expr) => {{
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
        let $keys = ReadingKeys::derive(&tenant_key, &ctx.tenant().to_string());
        let out = $body;
        $tx.commit().await.map_err(SessionError::Db)?;
        out
    }};
}

/// What the first transaction decided.
enum Next {
    /// Ask the agent who it is; nothing else is sent.
    Discover(Target),
    /// Read with this engine id and login.
    Read(
        Target,
        String,
        crate::vault_fathom::UsedLogin,
        String,
        String,
    ),
}

async fn read_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["element", "kind", "login", "confirm"])?;
    let element = need(&mut m, "element")?;
    let kind = need(&mut m, "kind")?;
    let purposes: &[&str] = match kind.as_str() {
        "device" => &reading::DEVICE_PURPOSES,
        "macarp" => &reading::MACARP_PURPOSES,
        _ => return Err(malformed("kind")),
    };
    let login = str_field(&mut m, "login")?;
    let confirm = str_field(&mut m, "confirm")?;
    let Some(transport) = state.device_reader.clone() else {
        return Err(VaultError::NotAllowed(
            "this server does not read devices; its operator turns it on with FATHOM_DEVICE_READ=on",
        )
        .into());
    };
    let fk = state.fathom_key.clone();

    // 1. Who, where, which agent, which login.
    let next = in_org!(state, signed, organisation, |tx, auth, keys| {
        let settings = crate::device_read::load(&tx, &auth.ctx.tenant().to_string())
            .await
            .map_err(SessionError::Db)?;
        let target = reading::target(&tx, &auth, &settings, true, &design, &element).await?;
        let mut engine =
            reading::engine_at(&tx, &keys, &auth.ctx.tenant().to_string(), target.address).await?;
        if let Some(typed) = &confirm {
            engine = Some(reading::approve_typed(&tx, &auth, &keys, &target, typed).await?);
        }
        match engine {
            Some(e) if e.state == "approved" => {
                let Some(login) = login.clone() else {
                    return Err(VaultError::NotAllowed(
                        "choose a read-only login to read this device with",
                    )
                    .into());
                };
                let fk = fk.as_ref().ok_or(VaultError::NoServerKey)?;
                let (used, auth_name) =
                    reading::open_login(&tx, &auth, fk, &target, &login).await?;
                Next::Read(target, e.engine_id, used, auth_name, login)
            }
            _ => Next::Discover(target),
        }
    });

    // 2. The reader, outside any transaction.
    match next {
        Next::Discover(target) => {
            let answer = reading::ask(
                transport.as_ref(),
                reading::request(reading::job(&target, purposes, None), None),
            )
            .await?;
            let engine_id = match &answer {
                Json::Obj(a) if matches!(a.get("outcome"), Some(Json::Str(o)) if o == "engine") => {
                    match a.get("engineId") {
                        Some(Json::Str(id)) if reading::engine_id_ok(id) => id.clone(),
                        _ => return Err(VaultError::Corrupt("the reader's engine id").into()),
                    }
                }
                Json::Obj(a) => return Ok(json_response(failed_answer(a))),
                _ => return Err(VaultError::Corrupt("the device reader's answer").into()),
            };
            let engine = in_org!(state, signed, organisation, |tx, auth, keys| {
                reading::record_seen(&tx, &auth, &keys, &target, &engine_id).await?
            });
            Ok(json_response(confirm_answer(&engine)))
        }
        Next::Read(target, engine_id, used, auth_name, login) => {
            let request = reading::request(
                reading::job(&target, purposes, Some(&engine_id)),
                Some((&used, &auth_name)),
            );
            drop(used);
            let answer = reading::ask(transport.as_ref(), request).await?;
            let Json::Obj(a) = &answer else {
                return Err(VaultError::Corrupt("the device reader's answer").into());
            };
            let outcome = match a.get("outcome") {
                Some(Json::Str(o)) => o.clone(),
                _ => return Err(VaultError::Corrupt("the device reader's answer").into()),
            };
            if outcome == "read" {
                let body = reading::kept(&answer, &kind);
                let id = in_org!(state, signed, organisation, |tx, auth, keys| {
                    reading::store(&tx, &auth, &keys, &target, &kind, &login, &body).await?
                });
                let mut out = match body {
                    Json::Obj(b) => b,
                    _ => BTreeMap::new(),
                };
                out.insert("id".into(), s(&id));
                return Ok(json_response(Json::Obj(out)));
            }
            // A failure is filed, and an agent that changed is recorded for confirming.
            let changed = match (a.get("failure"), a.get("engineId")) {
                (Some(Json::Obj(f)), Some(Json::Str(id)))
                    if matches!(f.get("code"), Some(Json::Str(c)) if c == "engine_changed")
                        && reading::engine_id_ok(id) =>
                {
                    Some(id.clone())
                }
                _ => None,
            };
            let engine = in_org!(state, signed, organisation, |tx, auth, keys| {
                let actor = auth.ctx.actor().to_string();
                chains::append_org(
                    &tx,
                    auth.ring,
                    auth.ctx,
                    auth.tenant_key,
                    EntryType::DeviceReadDone,
                    &entry_metadata(
                        EntryType::DeviceReadDone,
                        &[
                            ("actor", s(&actor)),
                            ("design", s(&target.design)),
                            ("element", s(&target.element)),
                            ("kind", s(&kind)),
                            ("login", s(&login)),
                            ("outcome", s("failed")),
                            (
                                "code",
                                a.get("failure")
                                    .and_then(|f| match f {
                                        Json::Obj(f) => f.get("code").cloned(),
                                        _ => None,
                                    })
                                    .unwrap_or(Json::Null),
                            ),
                        ],
                    ),
                )
                .await
                .map_err(VaultError::from)?;
                match &changed {
                    Some(id) => Some(reading::record_seen(&tx, &auth, &keys, &target, id).await?),
                    None => None,
                }
            });
            let mut out = failed_answer(a);
            if let (Json::Obj(o), Some(e)) = (&mut out, engine) {
                o.insert("engineId".into(), s(&e.engine_id));
                o.insert(
                    "previous".into(),
                    e.previous.as_deref().map_or(Json::Null, s),
                );
            }
            Ok(json_response(out))
        }
    }
}

fn confirm_answer(e: &reading::Engine) -> Json {
    Json::Obj(BTreeMap::from([
        ("outcome".to_string(), s("confirm")),
        ("engineId".to_string(), s(&e.engine_id)),
        ("state".to_string(), s(&e.state)),
        (
            "previous".to_string(),
            e.previous.as_deref().map_or(Json::Null, s),
        ),
    ]))
}

/// A refusal as the person sees it: the reader's code and words, which never carry a password.
fn failed_answer(a: &BTreeMap<String, Json>) -> Json {
    Json::Obj(BTreeMap::from([
        ("outcome".to_string(), s("failed")),
        (
            "failure".to_string(),
            a.get("failure").cloned().unwrap_or(Json::Null),
        ),
    ]))
}

async fn panel_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design, element)): PathExtractor<(String, String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let answer = in_org!(state, signed, organisation, |tx, auth, keys| {
        reading::panel(&tx, &auth, &keys, &design, &element).await?
    });
    Ok(json_response(answer))
}

async fn dismiss_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["element", "field", "value"])?;
    let element = need(&mut m, "element")?;
    let field = need(&mut m, "field")?;
    let value = need(&mut m, "value")?;
    in_org!(state, signed, organisation, |tx, auth, keys| {
        reading::dismiss(&tx, &auth, &keys, &design, &element, &field, &value).await?
    });
    Ok(json_response(Json::Obj(BTreeMap::from([(
        "dismissed".to_string(),
        Json::Bool(true),
    )]))))
}

async fn engines_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let list = in_org!(state, signed, organisation, |tx, auth, keys| {
        reading::waiting(&tx, &auth, &keys).await?
    });
    Ok(json_response(Json::Obj(BTreeMap::from([(
        "engines".to_string(),
        Json::Arr(list.iter().map(reading::Engine::to_json).collect()),
    )]))))
}

async fn approve_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["addresses"])?;
    let Some(Json::Arr(items)) = m.remove("addresses") else {
        return Err(malformed("addresses"));
    };
    let addresses = items
        .iter()
        .map(|i| match i {
            Json::Str(a) => a.parse::<IpAddr>().map_err(|_| malformed("addresses")),
            _ => Err(malformed("addresses")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let count = in_org!(state, signed, organisation, |tx, auth, keys| {
        reading::approve_batch(&tx, &auth, &keys, &addresses).await?
    });
    Ok(json_response(Json::Obj(BTreeMap::from([(
        "approved".to_string(),
        Json::Int(count as i64),
    )]))))
}
