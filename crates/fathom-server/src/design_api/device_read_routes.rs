//! Reading a device's routes (ADR-0082; migration 0073; sign-off r100). The rules are in
//! [`crate::device_reading`]; these are plumbing. The reader is asked between two transactions,
//! so no database transaction is held open while a device answers.
//!
//! - `POST /organisations/{o}/designs/{d}/device-read`: body `{element, kind, login?,
//!   confirm?, platform?}`, kind `device` or `macarp` (SNMPv3) or `config` (SSH, the platform's
//!   fixed commands; `platform` only when the design names none, and only one the reader has a
//!   list for). Answers one of:
//!   `{"outcome": "confirm", protocol, engineId | hostKey and keyType, state, previous}` — what
//!   answers at the device's address is not confirmed yet, and nothing but "who are you" was sent
//!   to it; the person types the last 8 characters of the engine id or host key and sends them
//!   back as `confirm`.
//!   `{"outcome": "read", id, ...}` — read, through the gate, sealed and filed.
//!   `{"outcome": "failed", failure: {code, message}, engineId? | hostKey?, previous?}` — the device or the
//!   login refused; filed, nothing kept. Code `already_reading` when this server is reading the
//!   same device now (r106): nothing sent, nothing filed.
//! - `GET /organisations/{o}/designs/{d}/device-read/{element}`: what the Readings tab shows
//!   ([`crate::device_reading::panel`]).
//! - `POST /organisations/{o}/designs/{d}/device-read/dismiss`: body `{element, field, value}`.
//! - `GET /organisations/{o}/device-read/engines`: a Steward's list of agents waiting.
//! - `POST /organisations/{o}/device-read/engines/approve`: body `{addresses: [..], protocol?}`,
//!   one batch of SNMP agents (the default) or of SSH host keys.

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
use crate::device_reading::{self as reading, Protocol, ReadingKeys, Target};
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
    /// Ask what answers at the address who it is; nothing else is sent.
    Discover(Target),
    /// Read with this confirmed engine id or host key, and this login.
    Read {
        target: Target,
        identity: String,
        used: crate::vault_fathom::UsedLogin,
        auth_name: Option<String>,
        login: String,
    },
}

/// The platform an SSH read runs the commands of, from the design; refused when the reader has
/// no fixed list for it.
fn ssh_platform(target: &Target) -> Result<&str, RouteError> {
    match target.platform.as_deref() {
        Some(p) if reading::SSH_PLATFORMS.contains(&p) => Ok(p),
        Some(_) => Err(VaultError::NotAllowed(
            "Fathom reads a configuration over SSH from Junos (SRX, EX) and Arista EOS so far; this device's platform has no fixed list of commands yet",
        )
        .into()),
        None => Err(VaultError::NotAllowed(
            "choose the device's platform first: it decides which read-only commands run",
        )
        .into()),
    }
}

/// The engine id or host key, and key type, an answer names, when they are well formed.
fn identity_in(protocol: Protocol, a: &BTreeMap<String, Json>) -> Option<(String, Option<String>)> {
    match protocol {
        Protocol::Snmp => match a.get("engineId") {
            Some(Json::Str(id)) if reading::engine_id_ok(id) => Some((id.clone(), None)),
            _ => None,
        },
        Protocol::Ssh => match (a.get("hostKey"), a.get("keyType")) {
            (Some(Json::Str(fp)), t) if reading::host_key_ok(fp) => Some((
                fp.clone(),
                match t {
                    Some(Json::Str(t)) if reading::key_type_ok(t) => Some(t.clone()),
                    _ => None,
                },
            )),
            _ => None,
        },
    }
}

async fn read_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(
        &signed.body,
        &["element", "kind", "login", "confirm", "platform"],
    )?;
    let element = need(&mut m, "element")?;
    let kind = need(&mut m, "kind")?;
    // Only for a configuration read of a device the design names no platform for (a device drawn
    // by hand; a pasted one carries its own).
    let asked_platform = str_field(&mut m, "platform")?;
    let purposes: &[&str] = match kind.as_str() {
        "device" => &reading::DEVICE_PURPOSES,
        "macarp" => &reading::MACARP_PURPOSES,
        "config" => &[],
        _ => return Err(malformed("kind")),
    };
    let protocol = Protocol::of_kind(&kind);
    let login = str_field(&mut m, "login")?;
    let confirm = str_field(&mut m, "confirm")?;
    let Some(transport) = state.device_reader.clone() else {
        return Err(VaultError::NotAllowed(
            "this server does not read devices; its operator turns it on with FATHOM_DEVICE_READ=on",
        )
        .into());
    };
    let fk = state.fathom_key.clone();

    // 1. Who, where, what answers there, which login.
    let (next, _claim) = in_org!(state, signed, organisation, |tx, auth, keys| {
        let settings = crate::device_read::load(&tx, &auth.ctx.tenant().to_string())
            .await
            .map_err(SessionError::Db)?;
        let mut target = reading::target(&tx, &auth, &settings, true, &design, &element).await?;
        match (&asked_platform, &target.platform) {
            (None, _) => {}
            (Some(_), _) if protocol != Protocol::Ssh => return Err(malformed("platform")),
            (Some(asked), Some(drawn)) if asked != drawn => {
                return Err(VaultError::NotAllowed(
                    "the design already says this device's platform; it is read as that one",
                )
                .into())
            }
            (Some(asked), _) => target.platform = Some(asked.clone()),
        }
        if protocol == Protocol::Ssh {
            ssh_platform(&target)?;
        }
        // One read per device at a time (r106), claimed before any login is opened, so a read
        // turned away files nothing; the claim is let go however this handler returns.
        let Some(claim) =
            reading::ReadingNow::claim(&auth.ctx.tenant().to_string(), target.address)
        else {
            return Ok(json_response(already_reading()));
        };
        let tenant = auth.ctx.tenant().to_string();
        let mut known = reading::identity_at(&tx, &keys, &tenant, protocol, target.address).await?;
        if let Some(typed) = &confirm {
            known =
                Some(reading::approve_typed(&tx, &auth, &keys, &target, protocol, typed).await?);
        }
        match known {
            Some(e) if e.state == "approved" => {
                let Some(login) = login.clone() else {
                    return Err(VaultError::NotAllowed(
                        "choose a read-only login to read this device with",
                    )
                    .into());
                };
                let fk = fk.as_ref().ok_or(VaultError::NoServerKey)?;
                let (used, auth_name) =
                    reading::open_login(&tx, &auth, fk, &target, protocol, &login).await?;
                (
                    Next::Read {
                        target,
                        identity: e.value,
                        used,
                        auth_name,
                        login,
                    },
                    claim,
                )
            }
            _ => (Next::Discover(target), claim),
        }
    });

    // 2. The reader, outside any transaction.
    match next {
        Next::Discover(target) => {
            let request = match protocol {
                Protocol::Snmp => reading::request(reading::job(&target, purposes, None), None),
                Protocol::Ssh => reading::ssh_request(
                    reading::ssh_job(&target, ssh_platform(&target)?, None),
                    None,
                ),
            };
            let answer = reading::ask(transport.as_ref(), request).await?;
            let expected = match protocol {
                Protocol::Snmp => "engine",
                Protocol::Ssh => "host_key",
            };
            let (value, key_type) = match &answer {
                Json::Obj(a) if matches!(a.get("outcome"), Some(Json::Str(o)) if o == expected) => {
                    identity_in(protocol, a)
                        .ok_or(VaultError::Corrupt("the reader's engine id or host key"))?
                }
                Json::Obj(a) => return Ok(json_response(failed_answer(a))),
                _ => return Err(VaultError::Corrupt("the device reader's answer").into()),
            };
            let seen = in_org!(state, signed, organisation, |tx, auth, keys| {
                reading::record_seen(
                    &tx,
                    &auth,
                    &keys,
                    &target,
                    protocol,
                    &value,
                    key_type.as_deref(),
                )
                .await?
            });
            Ok(json_response(confirm_answer(&seen)))
        }
        Next::Read {
            target,
            identity,
            used,
            auth_name,
            login,
        } => {
            let request = match protocol {
                Protocol::Snmp => {
                    let auth_name = auth_name
                        .as_deref()
                        .ok_or(VaultError::Corrupt("an SNMP login's authentication"))?;
                    reading::request(
                        reading::job(&target, purposes, Some(&identity)),
                        Some((&used, auth_name)),
                    )
                }
                Protocol::Ssh => reading::ssh_request(
                    reading::ssh_job(&target, ssh_platform(&target)?, Some(&identity)),
                    Some(&used),
                ),
            };
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
            // A failure is filed, and an agent or host key that changed is recorded for
            // confirming.
            let changed_code = match protocol {
                Protocol::Snmp => "engine_changed",
                Protocol::Ssh => "host_key_changed",
            };
            let changed = match a.get("failure") {
                Some(Json::Obj(f)) if matches!(f.get("code"), Some(Json::Str(c)) if c == changed_code) => {
                    identity_in(protocol, a)
                }
                _ => None,
            };
            let seen = in_org!(state, signed, organisation, |tx, auth, keys| {
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
                    Some((value, key_type)) => Some(
                        reading::record_seen(
                            &tx,
                            &auth,
                            &keys,
                            &target,
                            protocol,
                            value,
                            key_type.as_deref(),
                        )
                        .await?,
                    ),
                    None => None,
                }
            });
            let mut out = failed_answer(a);
            if let (Json::Obj(o), Some(e)) = (&mut out, seen) {
                if let Json::Obj(identity) = identity_fields(&e) {
                    o.extend(identity);
                }
            }
            Ok(json_response(out))
        }
    }
}

/// What the person confirms: the protocol, the engine id or the host key and its type, and the
/// value approved before when it changed.
fn identity_fields(e: &reading::Identity) -> Json {
    let mut m = BTreeMap::from([
        ("protocol".to_string(), s(e.protocol.as_str())),
        (
            "previous".to_string(),
            e.previous.as_deref().map_or(Json::Null, s),
        ),
    ]);
    match e.protocol {
        Protocol::Snmp => {
            m.insert("engineId".to_string(), s(&e.value));
        }
        Protocol::Ssh => {
            m.insert("hostKey".to_string(), s(&e.value));
            m.insert(
                "keyType".to_string(),
                e.key_type.as_deref().map_or(Json::Null, s),
            );
        }
    }
    Json::Obj(m)
}

fn confirm_answer(e: &reading::Identity) -> Json {
    let mut m = match identity_fields(e) {
        Json::Obj(m) => m,
        _ => BTreeMap::new(),
    };
    m.insert("outcome".to_string(), s("confirm"));
    m.insert("state".to_string(), s(&e.state));
    Json::Obj(m)
}

/// A refusal as the person sees it: the reader's code and words, which never carry a password.
/// Someone is reading this device now; nothing was sent to it and nothing is filed.
fn already_reading() -> Json {
    Json::Obj(BTreeMap::from([
        ("outcome".to_string(), s("failed")),
        (
            "failure".to_string(),
            Json::Obj(BTreeMap::from([
                ("code".to_string(), s(reading::ALREADY_READING)),
                (
                    "message".to_string(),
                    s("Someone is reading this device now. Try again once that read is answered; it takes a few seconds."),
                ),
            ])),
        ),
    ]))
}

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
        Json::Arr(list.iter().map(reading::Identity::to_json).collect()),
    )]))))
}

async fn approve_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["addresses", "protocol"])?;
    let protocol = match str_field(&mut m, "protocol")? {
        None => Protocol::Snmp,
        Some(p) => Protocol::parse(&p).ok_or_else(|| malformed("protocol"))?,
    };
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
        reading::approve_batch(&tx, &auth, &keys, protocol, &addresses).await?
    });
    Ok(json_response(Json::Obj(BTreeMap::from([(
        "approved".to_string(),
        Json::Int(count as i64),
    )]))))
}
