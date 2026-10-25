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
    authority_refusal_response, begin_org, if_version_field, json_response, object_body, str_field,
    DesignApiState, RouteError, Signed,
};
use crate::grants::Authority;
use crate::sessions::SessionError;
use crate::vault::{self, Enrolment, Meta, ShareIn, VaultError, WrapIn};
use crate::vault_fathom::{self, Consent};

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
        other => {
            tracing::error!(reason = %other, "vault act failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "refused\n").into_response()
        }
    }
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
    let view = with_vault!(state, signed, organisation, |tx, auth| vault::overview(
        &tx, &auth
    )
    .await?);
    let mut j = view.to_json();
    if let Json::Obj(m) = &mut j {
        // Which `vault.key` an owner's consent names (`vault_fathom::mode_change_bytes`).
        m.insert(
            "fathomKeyId".to_string(),
            Json::Str(state.fathom_key.id().to_string()),
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
    let fk = std::sync::Arc::clone(&state.fathom_key);
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
    let fk = std::sync::Arc::clone(&state.fathom_key);
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
