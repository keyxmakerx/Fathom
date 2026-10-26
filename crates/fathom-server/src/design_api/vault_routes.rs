//! The password vault's HTTP surface (ADR-0071). Every route is a signed request in an
//! organisation's tenant context, exactly as the design routes are; `crate::vault` decides who
//! may do what. Bodies are canonical JSON with bytes as lower-case hex, so nothing here parses
//! a secret: the only ciphertext that arrives is ciphertext the browser sealed.
//!
//! **The one exception is Mode B's four `fathom/...` routes** (ADR-0071 part two): there a
//! login's owner, or a holder refreshing it, hands Fathom the login itself, `{u, p, n}`, so that
//! Fathom can use it. The body is sealed under `vault.key` in `crate::vault_fathom` and the
//! plain bytes overwritten; nothing here logs a body.

use std::collections::BTreeMap;

use axum::extract::{Path as PathExtractor, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;

use fathom_canon::Json;

use super::{
    authority_refusal_response, begin_org, begin_org_keep, if_version_field, json_response,
    object_body, reopen_org, str_field, DesignApiState, RouteError, Signed,
};
use crate::grants::Authority;
use crate::sessions::SessionError;
use crate::vault::{self, Enrolment, Meta, ShareIn, VaultError, WrapIn};
use crate::vault_breach::{self, Level, Policy};
use crate::vault_fathom::{self, Consent};
use crate::vault_outside::{self as outside, bitwarden::BwKey, OutsideUrl};

pub(super) fn routes() -> Router<DesignApiState> {
    Router::new()
        .route("/organisations/{organisation}/vault", get(overview_handler))
        .route(
            "/organisations/{organisation}/vault/keys",
            post(enrol_key_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries",
            post(create_entry_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/epoch",
            post(new_epoch_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/meta",
            post(set_meta_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/revoke",
            post(revoke_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/delete",
            post(delete_handler),
        )
        .route(
            "/organisations/{organisation}/vault/recovery/open",
            post(open_recovery_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/fathom/on",
            post(fathom_on_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/fathom/countersign",
            post(fathom_countersign_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/fathom/refresh",
            post(fathom_refresh_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/fathom/off",
            post(fathom_off_handler),
        )
        .route(
            "/organisations/{organisation}/vault/breach-policy",
            post(breach_policy_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/critical",
            post(critical_handler),
        )
        .route(
            "/organisations/{organisation}/vault/entries/{credential}/breach",
            post(breach_result_handler),
        )
        .route(
            "/organisations/{organisation}/vault/outside/prepare",
            post(outside_prepare_handler),
        )
        .route(
            "/organisations/{organisation}/vault/outside/connect",
            post(outside_connect_handler),
        )
        .route(
            "/organisations/{organisation}/vault/outside/{connection}/check",
            post(outside_check_handler),
        )
        .route(
            "/organisations/{organisation}/vault/outside/{connection}/pull",
            post(outside_pull_handler),
        )
        .route(
            "/organisations/{organisation}/vault/outside/{connection}/disconnect",
            post(outside_disconnect_handler),
        )
        .route(
            "/organisations/{organisation}/vault/outside/items/{item}/remove",
            post(outside_remove_handler),
        )
        .route(
            "/organisations/{organisation}/vault/outside/items/{item}/restore",
            post(outside_restore_handler),
        )
}

/// A vault refusal. A permission answer names what the person may not do in words they can
/// act on; an integrity fault is logged and answered `refused`, never explained.
pub(super) fn vault_error_response(e: VaultError) -> Response {
    match e {
        VaultError::Authority(inner) => authority_refusal_response(&inner),
        VaultError::Malformed(why) => {
            tracing::info!(why, "malformed vault request");
            (StatusCode::BAD_REQUEST, format!("{why}\n")).into_response()
        }
        VaultError::NotAllowed(why) => (StatusCode::FORBIDDEN, format!("{why}\n")).into_response(),
        VaultError::NotFound => (StatusCode::NOT_FOUND, "no such login\n").into_response(),
        VaultError::Conflict { version } => (
            StatusCode::CONFLICT,
            format!("that login changed (now at version {version}); reload and try again\n"),
        )
            .into_response(),
        VaultError::NoVaultKey => {
            (StatusCode::CONFLICT, "set up your vault first\n").into_response()
        }
        VaultError::NoServerKey => (
            StatusCode::SERVICE_UNAVAILABLE,
            "this server has no vault.key yet, so Fathom cannot keep or open logins itself. \
             Whoever runs it updates its compose file to the current one and redeploys.\n",
        )
            .into_response(),
        VaultError::OutsideUnreachable(why) => {
            (StatusCode::BAD_GATEWAY, format!("{why}\n")).into_response()
        }
        VaultError::OutsideRefused(why) => {
            (StatusCode::CONFLICT, format!("{why}\n")).into_response()
        }
        other => {
            tracing::error!(reason = %other, "vault act failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "refused\n").into_response()
        }
    }
}

/// `vault.key`, or the refusal an install without one gives (`FathomKey::load_at_startup`).
fn fathom_key(
    state: &DesignApiState,
) -> Result<std::sync::Arc<vault_fathom::FathomKey>, RouteError> {
    state
        .fathom_key
        .clone()
        .ok_or(RouteError::Vault(VaultError::NoServerKey))
}

// ---- Body fields ----

fn malformed(what: &'static str) -> RouteError {
    RouteError::Vault(VaultError::Malformed(what))
}

fn req_str(
    m: &mut BTreeMap<String, Json>,
    key: &str,
    what: &'static str,
) -> Result<String, RouteError> {
    str_field(m, key)?.ok_or_else(|| malformed(what))
}

fn req_hex(
    m: &mut BTreeMap<String, Json>,
    key: &str,
    len: Option<usize>,
    what: &'static str,
) -> Result<Vec<u8>, RouteError> {
    let text = req_str(m, key, what)?;
    Ok(vault::unhex(&text, len, what)?)
}

fn opt_hex(
    m: &mut BTreeMap<String, Json>,
    key: &str,
    len: Option<usize>,
    what: &'static str,
) -> Result<Option<Vec<u8>>, RouteError> {
    match str_field(m, key)? {
        None => Ok(None),
        Some(text) => Ok(Some(vault::unhex(&text, len, what)?)),
    }
}

fn req_int(
    m: &mut BTreeMap<String, Json>,
    key: &str,
    what: &'static str,
) -> Result<i64, RouteError> {
    match m.remove(key) {
        Some(Json::Int(v)) => Ok(v),
        _ => Err(malformed(what)),
    }
}

fn opt_int(
    m: &mut BTreeMap<String, Json>,
    key: &str,
    what: &'static str,
) -> Result<Option<i64>, RouteError> {
    match m.remove(key) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Int(v)) => Ok(Some(v)),
        _ => Err(malformed(what)),
    }
}

fn small(v: i64, what: &'static str) -> Result<i32, RouteError> {
    i32::try_from(v).map_err(|_| malformed(what))
}

fn obj_of(
    j: Json,
    allowed: &[&str],
    what: &'static str,
) -> Result<BTreeMap<String, Json>, RouteError> {
    match j {
        Json::Obj(m) if m.keys().all(|k| allowed.contains(&k.as_str())) => Ok(m),
        _ => Err(malformed(what)),
    }
}

/// `{name, kind, usedOn: [{design, element}]}`, cleaned by [`Meta::clean`].
fn meta_from(m: &mut BTreeMap<String, Json>) -> Result<Meta, RouteError> {
    let name = req_str(m, "name", "name")?;
    let kind = req_str(m, "kind", "kind")?;
    let used_on = match m.remove("usedOn") {
        None => Vec::new(),
        Some(Json::Arr(items)) => items
            .into_iter()
            .map(|item| {
                let mut o = obj_of(item, &["design", "element"], "usedOn")?;
                Ok((
                    req_str(&mut o, "design", "usedOn")?,
                    req_str(&mut o, "element", "usedOn")?,
                ))
            })
            .collect::<Result<Vec<_>, RouteError>>()?,
        Some(_) => return Err(malformed("usedOn")),
    };
    Ok(Meta::clean(&name, &kind, used_on)?)
}

/// `{at, sharerKeyFpr, signature, viaRecovery?, wraps: [{keyId, wrap}]}`.
fn share_from(j: Json) -> Result<ShareIn, RouteError> {
    let mut m = obj_of(
        j,
        &["at", "sharerKeyFpr", "signature", "viaRecovery", "wraps"],
        "share",
    )?;
    let at = req_int(&mut m, "at", "share time")?;
    let sharer_key_fpr = req_hex(&mut m, "sharerKeyFpr", Some(32), "sharer key fingerprint")?;
    let signature = req_hex(&mut m, "signature", Some(64), "share signature")?;
    let via_recovery = match m.remove("viaRecovery") {
        None => false,
        Some(Json::Bool(b)) => b,
        Some(_) => return Err(malformed("viaRecovery")),
    };
    let wraps = match m.remove("wraps") {
        Some(Json::Arr(items)) => items
            .into_iter()
            .map(|item| {
                let mut o = obj_of(item, &["keyId", "wrap"], "wrap")?;
                Ok(WrapIn {
                    key_id: req_str(&mut o, "keyId", "wrap key id")?,
                    wrap: req_hex(&mut o, "wrap", None, "wrap")?,
                })
            })
            .collect::<Result<Vec<_>, RouteError>>()?,
        _ => return Err(malformed("wraps")),
    };
    Ok(ShareIn {
        at,
        sharer_key_fpr,
        signature,
        wraps,
        via_recovery,
    })
}

fn credential_path(text: &str) -> Result<String, RouteError> {
    if text.len() == 31 && text.starts_with("cred_") {
        Ok(text.to_string())
    } else {
        Err(SessionError::Malformed("login id").into())
    }
}

// ---- Handlers ----

macro_rules! with_vault {
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
        let out = $body;
        $tx.commit().await.map_err(SessionError::Db)?;
        out
    }};
}

/// `GET /organisations/{o}/vault`: everything the vault surface shows, in one answer. See
/// [`vault::overview`] for who sees what.
async fn overview_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    // Without `vault.key` there is nothing an outside vault connection could have been sealed
    // under on this server, so the list is empty and the consent names no key.
    let fk = state.fathom_key.clone();
    let (view, connections) = with_vault!(state, signed, organisation, |tx, auth| (
        vault::overview(&tx, &auth).await?,
        match &fk {
            Some(fk) => outside::list(&tx, &auth, fk).await?,
            None => Vec::new(),
        }
    ));
    let mut j = view.to_json();
    if let Json::Obj(m) = &mut j {
        m.insert(
            "outside".to_string(),
            Json::Arr(connections.iter().map(|c| c.to_json()).collect()),
        );
        // Which `vault.key` an owner's consent names (`vault_fathom::mode_change_bytes`).
        m.insert(
            "fathomKeyId".to_string(),
            fk.map_or(Json::Null, |k| Json::Str(k.id().to_string())),
        );
    }
    Ok(json_response(j))
}

/// `POST /organisations/{o}/vault/keys`: enrol this person's vault key, or (an admin) the
/// recovery sheet. Body: `{kind, publicKey, sealedPrivate, sealedNonce, kdfSalt?, kdfM?, kdfT?,
/// kdfP?, signerKeyFpr, enrolledAt, signature, successionSig?}`.
async fn enrol_key_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(
        &signed.body,
        &[
            "kind",
            "publicKey",
            "sealedPrivate",
            "sealedNonce",
            "kdfSalt",
            "kdfM",
            "kdfT",
            "kdfP",
            "signerKeyFpr",
            "enrolledAt",
            "signature",
            "successionSig",
        ],
    )?;
    let kdf = match (
        opt_hex(&mut m, "kdfSalt", Some(16), "kdf salt")?,
        opt_int(&mut m, "kdfM", "kdf memory")?,
        opt_int(&mut m, "kdfT", "kdf passes")?,
        opt_int(&mut m, "kdfP", "kdf lanes")?,
    ) {
        (None, None, None, None) => None,
        (Some(salt), Some(mm), Some(t), Some(p)) => Some((
            salt,
            small(mm, "kdf memory")?,
            small(t, "kdf passes")?,
            small(p, "kdf lanes")?,
        )),
        _ => return Err(malformed("passphrase settings come together")),
    };
    let e = Enrolment {
        kind: req_str(&mut m, "kind", "kind")?,
        public_key: req_hex(&mut m, "publicKey", Some(65), "public key")?,
        sealed_private: req_hex(&mut m, "sealedPrivate", None, "sealed private key")?,
        sealed_nonce: req_hex(&mut m, "sealedNonce", Some(12), "sealed nonce")?,
        kdf,
        signer_key_fpr: req_hex(&mut m, "signerKeyFpr", Some(32), "signer key fingerprint")?,
        enrolled_at: req_int(&mut m, "enrolledAt", "enrolled at")?,
        signature: req_hex(&mut m, "signature", Some(64), "signature")?,
        succession_sig: opt_hex(&mut m, "successionSig", Some(64), "succession signature")?,
    };
    let key = with_vault!(state, signed, organisation, |tx, auth| vault::enrol_key(
        &tx, &auth, e
    )
    .await?);
    Ok(json_response(key.to_json()))
}

/// `POST /organisations/{o}/vault/entries`: store a new login. Body: `{id, name, kind,
/// usedOn, secretCt, secretNonce, share}`.
async fn create_entry_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(
        &signed.body,
        &[
            "id",
            "name",
            "kind",
            "usedOn",
            "secretCt",
            "secretNonce",
            "share",
        ],
    )?;
    let id = credential_path(&req_str(&mut m, "id", "login id")?)?;
    let meta = meta_from(&mut m)?;
    let secret_ct = req_hex(&mut m, "secretCt", None, "sealed secret")?;
    let secret_nonce = req_hex(&mut m, "secretNonce", Some(12), "sealed secret nonce")?;
    let share = share_from(m.remove("share").ok_or_else(|| malformed("share"))?)?;
    let made = with_vault!(state, signed, organisation, |tx, auth| vault::create_entry(
        &tx,
        &auth,
        &id,
        meta,
        secret_ct,
        secret_nonce,
        share
    )
    .await?);
    Ok(json_response(made.to_json()))
}

/// `POST .../vault/entries/{cred}/epoch`: a changed password, changed holders, or a rotation.
/// Body: `{ifVersion, reason, secretCt, secretNonce, share}`.
async fn new_epoch_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    let mut m = object_body(
        &signed.body,
        &["ifVersion", "reason", "secretCt", "secretNonce", "share"],
    )?;
    let if_version = if_version_field(&mut m)?;
    let reason = req_str(&mut m, "reason", "reason")?;
    let secret_ct = req_hex(&mut m, "secretCt", None, "sealed secret")?;
    let secret_nonce = req_hex(&mut m, "secretNonce", Some(12), "sealed secret nonce")?;
    let share = share_from(m.remove("share").ok_or_else(|| malformed("share"))?)?;
    let done = with_vault!(state, signed, organisation, |tx, auth| vault::new_epoch(
        &tx,
        &auth,
        &credential,
        if_version,
        secret_ct,
        secret_nonce,
        share,
        &reason
    )
    .await?);
    Ok(json_response(done.to_json()))
}

/// `POST .../vault/entries/{cred}/meta`: rename, re-kind, or change where it is used. Body:
/// `{ifVersion, name, kind, usedOn}`.
async fn set_meta_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    let mut m = object_body(&signed.body, &["ifVersion", "name", "kind", "usedOn"])?;
    let if_version = if_version_field(&mut m)?;
    let meta = meta_from(&mut m)?;
    let done = with_vault!(state, signed, organisation, |tx, auth| vault::set_meta(
        &tx,
        &auth,
        &credential,
        if_version,
        meta
    )
    .await?);
    Ok(json_response(done.to_json()))
}

/// `POST .../vault/entries/{cred}/revoke`: stop serving one holder's copy. Body: `{ifVersion,
/// keyId}`. The owner or an admin.
async fn revoke_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    let mut m = object_body(&signed.body, &["ifVersion", "keyId"])?;
    let if_version = if_version_field(&mut m)?;
    let key_id = req_str(&mut m, "keyId", "key id")?;
    let done = with_vault!(state, signed, organisation, |tx, auth| vault::revoke_wrap(
        &tx,
        &auth,
        &credential,
        if_version,
        &key_id
    )
    .await?);
    Ok(json_response(done.to_json()))
}

/// `POST .../vault/entries/{cred}/delete`: tombstone it. Body: `{ifVersion}`. The owner or an
/// admin.
async fn delete_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    let mut m = object_body(&signed.body, &["ifVersion"])?;
    let if_version = if_version_field(&mut m)?;
    with_vault!(state, signed, organisation, |tx, auth| vault::delete_entry(
        &tx,
        &auth,
        &credential,
        if_version
    )
    .await?);
    let mut ok = BTreeMap::new();
    ok.insert("deleted".to_string(), Json::Str(credential));
    Ok(json_response(Json::Obj(ok)))
}

/// `POST /organisations/{o}/vault/recovery/open`: an admin, holding the printed sheet, is
/// served what it opens. Recorded before it is served. Body: `{}`.
async fn open_recovery_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    object_body(&signed.body, &[])?;
    let opened = with_vault!(state, signed, organisation, |tx, auth| {
        vault::open_recovery(&tx, &auth).await?
    });
    Ok(json_response(opened.to_json()))
}

/// The login itself, `{u, p, n}`, re-written canonically: exactly the bytes Fathom seals.
fn copy_from(m: &mut BTreeMap<String, Json>) -> Result<Vec<u8>, RouteError> {
    match m.remove("copy") {
        Some(Json::Obj(c)) => Ok(Json::Obj(c).to_canonical_bytes()),
        _ => Err(malformed("copy")),
    }
}

/// `POST .../vault/entries/{cred}/fathom/on`: the owner lets Fathom use this login. Body:
/// `{ifVersion, epochBefore, at, keyFpr, signature, copy: {u, p, n}}`.
async fn fathom_on_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    let mut m = object_body(
        &signed.body,
        &[
            "ifVersion",
            "epochBefore",
            "at",
            "keyFpr",
            "signature",
            "copy",
        ],
    )?;
    let if_version = if_version_field(&mut m)?;
    let consent = Consent {
        epoch_before: small(
            req_int(&mut m, "epochBefore", "epoch before")?,
            "epoch before",
        )?,
        at: req_int(&mut m, "at", "consent time")?,
        key_fpr: req_hex(&mut m, "keyFpr", Some(32), "consent key fingerprint")?,
        signature: req_hex(&mut m, "signature", Some(64), "consent signature")?,
    };
    let copy = copy_from(&mut m)?;
    let fk = fathom_key(&state)?;
    let view = with_vault!(state, signed, organisation, |tx, auth| {
        vault_fathom::turn_on(&tx, &auth, &fk, &credential, if_version, consent, copy).await?
    });
    Ok(json_response(view.to_json()))
}

/// `POST .../vault/entries/{cred}/fathom/countersign`: another admin signs the owner's
/// statement. Body: `{at, keyFpr, signature}`.
async fn fathom_countersign_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    let mut m = object_body(&signed.body, &["at", "keyFpr", "signature"])?;
    let at = req_int(&mut m, "at", "countersign time")?;
    let key_fpr = req_hex(&mut m, "keyFpr", Some(32), "countersign key fingerprint")?;
    let signature = req_hex(&mut m, "signature", Some(64), "countersignature")?;
    let view = with_vault!(state, signed, organisation, |tx, auth| {
        vault_fathom::countersign(&tx, &auth, &credential, key_fpr, signature, at).await?
    });
    Ok(json_response(view.to_json()))
}

/// `POST .../vault/entries/{cred}/fathom/refresh`: a holder hands Fathom the login again after
/// it changed. Body: `{copy: {u, p, n}}`.
async fn fathom_refresh_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    let mut m = object_body(&signed.body, &["copy"])?;
    let copy = copy_from(&mut m)?;
    let fk = fathom_key(&state)?;
    let view = with_vault!(state, signed, organisation, |tx, auth| {
        vault_fathom::refresh(&tx, &auth, &fk, &credential, copy).await?
    });
    Ok(json_response(view.to_json()))
}

/// `POST .../vault/entries/{cred}/fathom/off`: stop Fathom using it. Body: `{}`. The owner or
/// an admin.
async fn fathom_off_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    object_body(&signed.body, &[])?;
    let view = with_vault!(state, signed, organisation, |tx, auth| {
        vault_fathom::turn_off(&tx, &auth, &credential).await?
    });
    Ok(json_response(view.to_json()))
}

// ---- Breach checks (part three) ----

fn req_bool(
    m: &mut BTreeMap<String, Json>,
    key: &str,
    what: &'static str,
) -> Result<bool, RouteError> {
    match m.remove(key) {
        Some(Json::Bool(b)) => Ok(b),
        _ => Err(malformed(what)),
    }
}

/// `{enabled, intervalDays, action}`.
fn level_from(j: Json) -> Result<Level, RouteError> {
    let mut m = obj_of(
        j,
        &["enabled", "intervalDays", "action"],
        "breach policy level",
    )?;
    Ok(Level {
        enabled: req_bool(&mut m, "enabled", "breach checks on or off")?,
        interval_days: small(
            req_int(&mut m, "intervalDays", "re-check interval")?,
            "re-check interval",
        )?,
        action: req_str(&mut m, "action", "warn or refuse")?,
    })
}

/// `POST .../vault/breach-policy`: an admin sets the whole policy. Body:
/// `{organisation: level | null, kinds: {kind: level}}`; a kind left out is the same as the
/// organisation.
async fn breach_policy_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["organisation", "kinds"])?;
    let organisation_level = match m.remove("organisation") {
        None | Some(Json::Null) => None,
        Some(j) => Some(level_from(j)?),
    };
    let mut kinds = BTreeMap::new();
    match m.remove("kinds") {
        None => {}
        Some(Json::Obj(k)) => {
            for (kind, j) in k {
                kinds.insert(kind, level_from(j)?);
            }
        }
        Some(_) => return Err(malformed("kinds")),
    }
    let policy = Policy {
        organisation: organisation_level,
        kinds,
    };
    let saved = with_vault!(state, signed, organisation, |tx, auth| {
        vault_breach::set_policy(&tx, &auth, policy).await?
    });
    Ok(json_response(saved.to_json()))
}

/// `POST .../vault/entries/{cred}/critical`: the owner or an admin. Body: `{critical}`.
async fn critical_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    let mut m = object_body(&signed.body, &["critical"])?;
    let critical = req_bool(&mut m, "critical", "critical")?;
    let now = with_vault!(state, signed, organisation, |tx, auth| {
        vault_breach::set_critical(&tx, &auth, &credential, critical).await?
    });
    Ok(json_response(Json::Obj(
        [("critical".to_string(), Json::Bool(now))]
            .into_iter()
            .collect(),
    )))
}

/// `POST .../vault/entries/{cred}/breach`: a holder's browser records what it found. Body:
/// `{epoch, found}`.
async fn breach_result_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, credential)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let credential = credential_path(&credential)?;
    let mut m = object_body(&signed.body, &["epoch", "found"])?;
    let epoch = small(req_int(&mut m, "epoch", "epoch")?, "epoch")?;
    let found = req_bool(&mut m, "found", "found")?;
    let result = with_vault!(state, signed, organisation, |tx, auth| {
        vault_breach::record(&tx, &auth, &credential, epoch, found).await?
    });
    Ok(json_response(result.to_json()))
}

// ---- Outside vaults (part four) ----
//
// A route here makes its network round BETWEEN two transactions: the first verifies the signed
// request and reads what the round needs, the second records what came back. No database
// transaction is held while an outside vault answers.

/// Two transactions around a network round, from one verified request.
macro_rules! with_session {
    ($state:expr, $session:expr, $client:expr, $organisation:expr, |$tx:ident, $auth:ident| $body:expr) => {{
        let ($tx, ctx, tenant_key) =
            reopen_org(&$state, &$session, &mut $client, &$organisation).await?;
        let $auth = Authority {
            ring: &$state.ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &$state.watch,
        };
        let out = $body;
        $tx.commit().await.map_err(SessionError::Db)?;
        out
    }};
}

/// The first transaction: verify, open the tenant, run `$body`, commit; hand back the session.
macro_rules! first_session {
    ($state:expr, $signed:expr, $client:expr, $organisation:expr, |$tx:ident, $auth:ident| $body:expr) => {{
        let ($tx, ctx, tenant_key, session) =
            begin_org_keep(&$state, &$signed, &mut $client, &$organisation).await?;
        let $auth = Authority {
            ring: &$state.ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &$state.watch,
        };
        let out = $body;
        $tx.commit().await.map_err(SessionError::Db)?;
        (out, session)
    }};
}

fn outside_url(m: &mut BTreeMap<String, Json>) -> Result<OutsideUrl, RouteError> {
    Ok(OutsideUrl::parse(&req_str(
        m,
        "url",
        "the vault's address",
    )?)?)
}

fn api_key(m: &mut BTreeMap<String, Json>) -> Result<(String, String), RouteError> {
    let id = req_str(m, "clientId", "client id")?;
    let secret = req_str(m, "clientSecret", "client secret")?;
    outside::check_api_key(&id, &secret)?;
    Ok((id, secret))
}

fn used_on_list(m: &mut BTreeMap<String, Json>) -> Result<Vec<(String, String)>, RouteError> {
    match m.remove("usedOn") {
        None => Ok(Vec::new()),
        Some(Json::Arr(items)) => items
            .into_iter()
            .map(|item| {
                let mut o = obj_of(item, &["design", "element"], "usedOn")?;
                Ok((
                    req_str(&mut o, "design", "usedOn")?,
                    req_str(&mut o, "element", "usedOn")?,
                ))
            })
            .collect(),
        Some(_) => Err(malformed("usedOn")),
    }
}

fn outside_id(text: &str, prefix: &str) -> Result<String, RouteError> {
    if text.len() == prefix.len() + 26
        && text.starts_with(prefix)
        && text[prefix.len()..]
            .bytes()
            .all(|c| c.is_ascii_alphanumeric())
    {
        Ok(text.to_string())
    } else {
        Err(RouteError::Vault(VaultError::NotFound))
    }
}

fn pairs(fields: Vec<(&str, Json)>) -> Json {
    Json::Obj(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
    )
}

/// The body's `provider`, Vaultwarden when it is left out (the first one built).
fn provider_of(m: &mut BTreeMap<String, Json>) -> Result<outside::Provider, RouteError> {
    match str_field(m, "provider")? {
        None => Ok(outside::Provider::Vaultwarden),
        Some(p) => Ok(outside::Provider::parse(&p)?),
    }
}

/// A Secret Server application account: `username` and `password`.
fn account(m: &mut BTreeMap<String, Json>) -> Result<(String, String), RouteError> {
    let user = req_str(m, "username", "the account's user name")?;
    let password = req_str(m, "password", "the account's password")?;
    outside::check_account(&user, &password)?;
    Ok((user, password))
}

fn folders_json(answer: &outside::delinea::Answer) -> Json {
    Json::Arr(
        answer
            .folders
            .iter()
            .map(|f| {
                pairs(vec![
                    ("id", Json::Str(f.id.clone())),
                    ("name", Json::Str(f.name.clone())),
                ])
            })
            .collect(),
    )
}

/// `POST .../vault/outside/prepare`: sign in to the outside vault, and hand the person's browser
/// what it needs to go on.
///
/// Vaultwarden, body `{url, clientId, clientSecret}`: the protected keys, how they are derived, the
/// organisations and collections the account sees (names still sealed) and the checks as far as
/// they can run before a collection is chosen; the master password that opens them never comes
/// here. Secret Server, body `{provider: "delinea", url, username, password}`: the folders the
/// account sees, by name, and the checks.
async fn outside_prepare_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(
        &signed.body,
        &[
            "provider",
            "url",
            "clientId",
            "clientSecret",
            "username",
            "password",
        ],
    )?;
    let provider = provider_of(&mut m)?;
    let url = outside_url(&mut m)?;
    if provider == outside::Provider::Delinea {
        let (user, password) = account(&mut m)?;
        if !m.is_empty() {
            return Err(malformed("request body"));
        }
        state.outside.check_host(&url)?;
        let mut client = state
            .sessions
            .pool()
            .get()
            .await
            .map_err(SessionError::Pool)?;
        let ((), _session) = first_session!(state, signed, client, organisation, |tx, _auth| ());
        let answer = outside::dl_read(&state.outside, &url, &user, &password, None).await?;
        let lines = outside::delinea::checks(&answer, None, None);
        return Ok(json_response(pairs(vec![
            ("provider", Json::Str("delinea".to_string())),
            ("url", Json::Str(url.to_text())),
            ("folders", folders_json(&answer)),
            ("checks", outside::checks_json(&lines)),
        ])));
    }
    let (client_id, secret) = api_key(&mut m)?;
    if !m.is_empty() {
        return Err(malformed("request body"));
    }
    state.outside.check_host(&url)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let ((), _session) = first_session!(state, signed, client, organisation, |tx, _auth| ());
    let device_id = outside::new_device_id()?;
    let (token, sync) =
        outside::vw_read(&state.outside, &url, &client_id, &secret, &device_id).await?;
    let lines = outside::vaultwarden::checks(&sync, None, None);
    let opt_i = |v: Option<i64>| v.map_or(Json::Null, Json::Int);
    Ok(json_response(pairs(vec![
        ("url", Json::Str(url.to_text())),
        ("deviceId", Json::Str(device_id)),
        (
            "protectedUserKey",
            Json::Str(token.protected_user_key.clone()),
        ),
        (
            "protectedPrivateKey",
            Json::Str(token.protected_private_key.clone()),
        ),
        (
            "kdf",
            pairs(vec![
                ("type", Json::Int(token.kdf_type)),
                ("iterations", Json::Int(token.kdf_iterations)),
                ("memory", opt_i(token.kdf_memory)),
                ("parallelism", opt_i(token.kdf_parallelism)),
            ]),
        ),
        ("salt", token.salt.clone().map_or(Json::Null, Json::Str)),
        (
            "organisations",
            Json::Arr(
                sync.memberships
                    .iter()
                    .map(|o| {
                        pairs(vec![
                            ("id", Json::Str(o.org_id.clone())),
                            ("name", Json::Str(o.name.clone())),
                            ("role", Json::Int(o.role)),
                            ("status", Json::Int(o.status)),
                            (
                                "protectedKey",
                                o.protected_key.clone().map_or(Json::Null, Json::Str),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "collections",
            Json::Arr(
                sync.collections
                    .iter()
                    .map(|c| {
                        pairs(vec![
                            ("id", Json::Str(c.id.clone())),
                            ("organisationId", Json::Str(c.org_id.clone())),
                            ("protectedName", Json::Str(c.protected_name.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("checks", outside::checks_json(&lines)),
    ])))
}

/// `POST .../vault/outside/connect`. Body: `{url, clientId, clientSecret, deviceId,
/// collectionId, collectionName, orgKey}`, the organisation key as 128 hex characters.
async fn outside_connect_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(
        &signed.body,
        &[
            "provider",
            "url",
            "clientId",
            "clientSecret",
            "deviceId",
            "collectionId",
            "collectionName",
            "orgKey",
            "username",
            "password",
            "folderName",
        ],
    )?;
    let provider = provider_of(&mut m)?;
    let url = outside_url(&mut m)?;
    if provider == outside::Provider::Delinea {
        let (user, password) = account(&mut m)?;
        let folder_name = req_str(&mut m, "folderName", "the folder's name")?;
        if !m.is_empty() {
            return Err(malformed("request body"));
        }
        state.outside.check_host(&url)?;
        let mut client = state
            .sessions
            .pool()
            .get()
            .await
            .map_err(SessionError::Pool)?;
        let ((), session) = first_session!(state, signed, client, organisation, |tx, _auth| ());
        let answer = outside::dl_read(&state.outside, &url, &user, &password, None).await?;
        // The one folder the account sees; when it sees another number, the checks in
        // `connect` refuse and say so.
        let folder_id = match answer.folders.as_slice() {
            [f] => f.id.clone(),
            _ => String::new(),
        };
        let fk = std::sync::Arc::clone(&state.fathom_key);
        let input = outside::ConnectIn {
            provider,
            url,
            client_id: user,
            client_secret: password,
            device_id: outside::new_device_id()?,
            collection_id: folder_id,
            collection_name: folder_name,
            org_key: None,
        };
        let answer = outside::Answer::Delinea(answer);
        let view = with_session!(state, session, client, organisation, |tx, auth| {
            outside::connect(&tx, &auth, &fk, input, &answer).await?
        });
        return Ok(json_response(view.to_json()));
    }
    let (client_id, secret) = api_key(&mut m)?;
    let device_id = req_str(&mut m, "deviceId", "device id")?;
    outside::check_device_id(&device_id)?;
    let collection_id = req_str(&mut m, "collectionId", "collection")?;
    let collection_name = req_str(&mut m, "collectionName", "the collection's name")?;
    let mut raw = req_hex(&mut m, "orgKey", Some(64), "organisation key")?;
    let org_key = BwKey::from_slice(&raw).ok_or_else(|| malformed("organisation key"));
    vault_fathom::wipe(&mut raw);
    let org_key = org_key?;
    if !m.is_empty() {
        return Err(malformed("request body"));
    }
    state.outside.check_host(&url)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let ((), session) = first_session!(state, signed, client, organisation, |tx, _auth| ());
    let (_, sync) = outside::vw_read(&state.outside, &url, &client_id, &secret, &device_id).await?;
    let fk = fathom_key(&state)?;
    let input = outside::ConnectIn {
        provider,
        url,
        client_id,
        client_secret: secret,
        device_id,
        collection_id,
        collection_name,
        org_key: Some(org_key),
    };
    let answer = outside::Answer::from(sync);
    let view = with_session!(state, session, client, organisation, |tx, auth| {
        outside::connect(&tx, &auth, &fk, input, &answer).await?
    });
    Ok(json_response(view.to_json()))
}

/// `POST .../vault/outside/{connection}/check`: "Check now". The owner or an admin. Body `{}`.
/// Answers the connection, the check lines and the collection's logins by name; a failed check
/// stops the connection and is answered 409 with why.
async fn outside_check_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, connection)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let connection = outside_id(&connection, "out_")?;
    object_body(&signed.body, &[])?;
    let fk = fathom_key(&state)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (plan, session) = first_session!(state, signed, client, organisation, |tx, auth| {
        outside::plan(&tx, &auth, &fk, &connection, outside::Why::Check).await?
    });
    let read = outside::read(
        &state.outside,
        &plan.url,
        &plan.secrets,
        &plan.device_id,
        None,
    )
    .await;
    let checked = with_session!(state, session, client, organisation, |tx, auth| {
        outside::after_check(&tx, &auth, &fk, &plan, read).await?
    })?;
    Ok(json_response(pairs(vec![
        ("connection", checked.view.to_json()),
        ("checks", outside::checks_json(&checked.lines)),
        ("logins", outside::logins_json(&checked.logins)),
    ])))
}

/// `POST .../vault/outside/{connection}/pull`: the owner pulls one login into Fathom, or changes
/// the devices it is marked on. Body: `{cipherId, kind, usedOn: [{design, element}]}`.
async fn outside_pull_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, connection)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let connection = outside_id(&connection, "out_")?;
    let mut m = object_body(&signed.body, &["cipherId", "kind", "usedOn"])?;
    let cipher_id = req_str(&mut m, "cipherId", "the login")?;
    if cipher_id.is_empty() || cipher_id.len() > 64 {
        return Err(malformed("the login"));
    }
    let kind = req_str(&mut m, "kind", "kind")?;
    let used_on = used_on_list(&mut m)?;
    let fk = fathom_key(&state)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let (plan, session) = first_session!(state, signed, client, organisation, |tx, auth| {
        outside::plan(&tx, &auth, &fk, &connection, outside::Why::Pull).await?
    });
    let answer = outside::read(
        &state.outside,
        &plan.url,
        &plan.secrets,
        &plan.device_id,
        None,
    )
    .await?;
    let view = with_session!(state, session, client, organisation, |tx, auth| {
        outside::pull(&tx, &auth, &fk, &plan, &answer, &cipher_id, &kind, used_on).await?
    })?;
    Ok(json_response(view.to_json()))
}

/// `POST .../vault/outside/{connection}/disconnect`: the owner or an admin. Body `{}`.
async fn outside_disconnect_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, connection)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let connection = outside_id(&connection, "out_")?;
    object_body(&signed.body, &[])?;
    let fk = fathom_key(&state)?;
    let view = with_vault!(state, signed, organisation, |tx, auth| {
        outside::disconnect(&tx, &auth, &fk, &connection).await?
    });
    Ok(json_response(view.to_json()))
}

/// `POST .../vault/outside/items/{item}/remove`: the owner or an admin. Body `{}`.
async fn outside_remove_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, item)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let item = outside_id(&item, "oit_")?;
    object_body(&signed.body, &[])?;
    let fk = fathom_key(&state)?;
    let view = with_vault!(state, signed, organisation, |tx, auth| {
        outside::remove(&tx, &auth, &fk, &item).await?
    });
    Ok(json_response(view.to_json()))
}

/// `POST .../vault/outside/items/{item}/restore`: an admin, or the owner of a login they
/// removed themselves. Body `{}`.
async fn outside_restore_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, item)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let item = outside_id(&item, "oit_")?;
    object_body(&signed.body, &[])?;
    let fk = fathom_key(&state)?;
    let view = with_vault!(state, signed, organisation, |tx, auth| {
        outside::restore(&tx, &auth, &fk, &item).await?
    });
    Ok(json_response(view.to_json()))
}
