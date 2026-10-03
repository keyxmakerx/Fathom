//! The drawing surface's HTTP endpoints: list, open, save, history and verify for
//! a design, plus read-only access to the equipment catalogue.
//!
//! `docs/PHASE-2-STORAGE-DESIGN.md` §11.2 (verify's three outcomes), §7 (tenant
//! isolation); `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §3.4 (`authorise_account`'s
//! seven steps), §9 (the audit spool's degrade table). `src/api.rs` is the
//! pattern; `sessions.rs`, `designs.rs`, `grants.rs` hold the rules.
//!
//! Its own state and router: `api::router` and [`api::ApiState`] are untouched.
//! [`DesignApiState`] has its own [`Signed`] extractor (see its doc for what
//! `src/main.rs` must hand in).
//!
//! # One transaction for verification, authorisation and the act
//!
//! Every handler that acts on a design opens one transaction, calls
//! [`Signed::verify`] in it, and passes it and the [`Authority`] to
//! [`designs::write_version_in_tx`], [`designs::read_version_in_tx`],
//! [`designs::verify_design_in_tx`] or
//! [`designs::create_design_with_first_version_in_tx`]. Each re-checks the grant
//! immediately before touching `design_payload` or `chain_entries`; the handler
//! commits only after the act. With separate transactions, a grant revoked between
//! check and act would change nothing (`tests/design_api.rs`).
//!
//! # A design the caller cannot see is absent, not forbidden
//!
//! [`list_designs_handler`] filters every row through `grants::authorise_account`
//! and omits designs without capability; a `403`-flavoured entry would reveal how
//! many exist.
//!
//! For one design named directly, [`authorise_on_design`] checks the design's own
//! scope when it exists and the *organisation's* (`None`) when not, so both give
//! the identical [`grants::AuthorityError::NotAuthorised`]. Only a caller who
//! clears it reaches `designs.rs`, where a missing design answers
//! `DesignError::NoSuchDesign`: safe, since clearing proved standing here.
//!
//! # Wire format: canonical JSON for documents, raw bytes for the payload
//!
//! Lists, history and the verification report are each one `fathom_canon::Json`
//! value rendered by `to_canonical_bytes` as `application/json` (`fathom-canon`
//! has no `serde`). **The source documents were silent on this; it is a decision
//! recorded only here.** A design's payload is the exception: [`open_design_handler`]
//! serves it as `application/octet-stream`, verbatim, with version and schema
//! version in headers (storage §3: "whole payload, not per field"; an envelope
//! would only cost a re-parse).
//!
//! # The body size limit is per route
//!
//! `api::MAX_SIGNED_BODY` is one mebibyte. [`Signed`] raises it **only for a save
//! and a create**, matched on method and path alone ([`is_large_body_route`])
//! before any header is trusted or body byte read. Reading everything at
//! [`designs::MAX_PAYLOAD_BYTES`] plus four (64 MiB) let a caller with no session,
//! only well-shaped invented headers, make the process buffer 64 MiB on a plain
//! `GET`: `begin_request`, where the nonce is spent and the signature checked, runs
//! after the read.
//!
//! **This narrows the surface; it does not close it.** On `POST .../versions` and
//! `POST .../scopes/{scope}/designs` an unauthenticated caller can still make the
//! process buffer 64 MiB, since the signature covers the whole body's digest and
//! cannot be checked before the read. Worse, [`validate_payload`] parses a full
//! [`Graph`] and runs [`find_credential`] BEFORE `signed.verify`, so such a caller
//! also spends CPU. Not fixed here: it needs a session lookup before the body read
//! (a shape this crate lacks) or `api.rs`'s source rate-limit bucket.
//!
//! # The catalogue sits behind a session, and nowhere else
//!
//! Public reference data: no tenant context, no capability check, but a verified
//! [`Signed`] request is still required (*"it still sits behind a session like
//! everything else."*). [`load_catalogue`] reads
//! `<root>/corpus/catalogue/<vendor>/*.yaml` and needs `<root>/schema` beside it
//! (`fathom_corpus::catalogue::Catalogue::load_platform`). Whatever builds a
//! [`DesignApiState`] supplies the root, today `config.schema_root`'s parent.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequest, Path as PathExtractor, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::Router;
use deadpool_postgres::Transaction;

use fathom_canon::Json;
use fathom_corpus::catalogue::{Catalogue, CatalogueError, Face, Model, Port, PsuSlot, Role, Row};
use fathom_graph::Graph;
use fathom_ir::generated::accessors::{capture, note};
use fathom_ir::generated::ir_types::NodeKind;

use crate::api;
use crate::audit;
use crate::authority::Capability;
use crate::chain;
use crate::corrections;
use crate::crypto;
use crate::designs::{self, DesignError};
use crate::field_defs;
use crate::grants::{self, Authority, EpochWatch};
use crate::keys::KeyRing;
use crate::repo::{self, DesignId, OrganisationId, ScopeId, TenantContext};
use crate::sessions::{
    self, PendingRequest, SessionError, SessionStore, SignedRequest, VerifiedSession,
};

// ---- State ----

/// Everything this module's routes need. Not [`api::ApiState`]; see the module
/// doc.
#[derive(Clone)]
pub struct DesignApiState {
    pub sessions: Arc<SessionStore>,
    pub watch: Arc<EpochWatch>,
    pub ring: Arc<KeyRing>,
    /// The catalogue, loaded once at startup: read-only reference data, so every
    /// request reads the same `Vec`, not the filesystem. Built by [`load_catalogue`].
    pub catalogue: Arc<Vec<Model>>,
    /// ADR-0057 decision 7. The same policy as every route's state
    /// (`src/client_address.rs`): design payload and vault ciphertext are what §4.1
    /// clause (b) protects, so this plane is checked too.
    pub client_address: crate::client_address::ClientAddress,
}

/// Read every vendor directory under `<root>/corpus/catalogue/` into one flat
/// list of models. `root` needs a `schema/` directory beside `corpus/`, because
/// `Catalogue::load_platform` checks each model's vendor against the schema
/// tree's vendor list.
pub fn load_catalogue(root: &Path) -> Result<Vec<Model>, CatalogueError> {
    let dir = root.join("corpus").join("catalogue");
    let read = std::fs::read_dir(&dir).map_err(|e| CatalogueError {
        file: dir.display().to_string(),
        line: 0,
        gate: fathom_corpus::catalogue::CatalogueGate::Parse,
        message: format!("read_dir: {e}"),
    })?;
    let mut vendors: Vec<String> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    vendors.sort();

    let mut models = Vec::new();
    for vendor in vendors {
        let catalogue = Catalogue::load_platform(root, &vendor)?;
        models.extend(catalogue.models().iter().cloned());
    }
    Ok(models)
}

// ---- The router ----

/// This module's routes, to `merge` into the main router; nothing is added to
/// `api::router`.
pub fn router(state: DesignApiState) -> Router {
    Router::new()
        .route("/organisations", get(list_organisations_handler))
        .route(
            "/organisations/{organisation}/designs",
            get(list_designs_handler),
        )
        .route(
            "/organisations/{organisation}/scopes",
            get(list_scopes_handler).post(create_scope_handler),
        )
        .route(
            "/organisations/{organisation}/scopes/{scope}/designs",
            post(create_design_handler),
        )
        .route(
            "/organisations/{organisation}/scopes/{scope}/access",
            get(access_handler),
        )
        .route(
            "/organisations/{organisation}/scopes/{scope}/grants/propose",
            post(propose_share_handler),
        )
        .route(
            "/organisations/{organisation}/scopes/{scope}/grants/sign",
            post(sign_share_handler),
        )
        .route(
            "/organisations/{organisation}/scopes/{scope}/grants/{grant}/revoke",
            get(revoke_bytes_handler).post(revoke_share_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}",
            get(open_design_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/name",
            post(rename_design_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/versions",
            post(save_design_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/history",
            get(history_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/verify",
            get(verify_design_handler),
        )
        .route(
            "/organisations/{organisation}/field-definitions",
            get(list_field_definitions_handler).post(create_field_definition_handler),
        )
        .route(
            "/organisations/{organisation}/field-definitions/{definition}",
            patch(update_field_definition_handler),
        )
        .route(
            "/organisations/{organisation}/field-definitions/{definition}/archive",
            post(archive_field_definition_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/corrections",
            get(list_corrections_handler).post(create_correction_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/corrections/{correction}/accept",
            post(accept_correction_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/corrections/{correction}/dismiss",
            post(dismiss_correction_handler),
        )
        .route(
            "/organisations/{organisation}/designs/{design}/corrections/{correction}/reopen",
            post(reopen_correction_handler),
        )
        .route("/catalogue/models", get(catalogue_list_handler))
        .route(
            "/catalogue/models/{vendor}/{model}",
            get(catalogue_model_handler),
        )
        .with_state(state)
}

// ---- The extractor: `api::Signed`'s pattern, against `DesignApiState` ----

/// A request that has spent its single-use nonce and awaits verification inside
/// the handler's own transaction. See `api::Signed` for the reasoning.
pub struct Signed {
    pending: PendingRequest,
    body: Bytes,
    /// The raw query string, captured because `Signed` consumes the whole `Request`.
    query: Option<String>,
    /// ADR-0057 decision 7, captured at extraction like `api::Signed`'s.
    address: String,
}

impl Signed {
    /// Run the rest of §4.1 clause (b) inside `tx`, so what the handler authorises
    /// next sees the snapshot the session was verified against.
    async fn verify(
        &self,
        state: &DesignApiState,
        tx: &Transaction<'_>,
    ) -> Result<VerifiedSession, SessionError> {
        let session = state.sessions.verify_pending(tx, &self.pending).await?;
        state
            .sessions
            .check_session_address(tx, session.id(), &self.address)
            .await?;
        Ok(session)
    }

    /// As [`Signed::verify`], but commits `tx` whatever the outcome and hands it back
    /// on success. `verify` only borrows `tx`, so an ending it makes there would be
    /// undone when the route refuses the request that found it.
    async fn verify_and_commit<'a>(
        &self,
        state: &DesignApiState,
        tx: Transaction<'a>,
    ) -> Result<(VerifiedSession, Transaction<'a>), SessionError> {
        match self.verify(state, &tx).await {
            Ok(session) => Ok((session, tx)),
            Err(e) => {
                let _ = tx.commit().await;
                Err(e)
            }
        }
    }

    /// One query parameter, unescaped. Every value read here is a bare integer or
    /// `true`/`1`, so no percent-decoding is needed.
    fn query_param(&self, key: &str) -> Option<&str> {
        let q = self.query.as_deref()?;
        q.split('&').find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let name = parts.next()?;
            if name == key {
                Some(parts.next().unwrap_or(""))
            } else {
                None
            }
        })
    }
}

/// Design payloads run up to [`designs::MAX_PAYLOAD_BYTES`] (64 MiB). This is
/// *not* the cap every route reads at; see [`is_large_body_route`] and the module
/// doc.
pub const MAX_SIGNED_BODY: usize = designs::MAX_PAYLOAD_BYTES + 4;

/// True for exactly the two `POST` routes whose legitimate body may run to
/// [`MAX_SIGNED_BODY`]'s 64 MiB: a save (`.../designs/{design}/versions`) and a
/// create (`.../scopes/{scope}/designs`). Every other route, including any `GET`,
/// reads at `api::MAX_SIGNED_BODY`'s one mebibyte.
///
/// Decided from method and path alone, before the body is read, since the
/// signature cannot be checked until after it. Path shape only, never the ids: this
/// decides how many bytes `to_bytes` may buffer, nothing about authority.
fn is_large_body_route(method: &str, path: &str) -> bool {
    if method != "POST" {
        return false;
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    matches!(
        segments.as_slice(),
        [
            "organisations",
            _organisation,
            "designs",
            _design,
            "versions"
        ]
    ) || matches!(
        segments.as_slice(),
        ["organisations", _organisation, "scopes", _scope, "designs"]
    )
}

impl FromRequest<DesignApiState> for Signed {
    type Rejection = RouteError;

    async fn from_request(
        request: Request,
        state: &DesignApiState,
    ) -> Result<Self, Self::Rejection> {
        let (parts, body) = request.into_parts();
        let method = parts.method.as_str().to_string();
        let query = parts.uri.query().map(|q| q.to_string());
        let route_path = parts.uri.path().to_string();
        let path = parts
            .uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| parts.uri.path().to_string());
        let headers = parts.headers;
        let address = state.client_address.of(&headers, &parts.extensions);

        // As `api::Signed`: a missing or unreadable header is `NotSigned`, never
        // `Malformed`, so someone presenting rubbish learns nothing about which part was
        // wrong.
        let unsigned = || SessionError::NotSigned;
        let session_id = header_text(&headers, api::HEADER_SESSION).map_err(|_| unsigned())?;
        let nonce: [u8; 32] = header_hex(&headers, api::HEADER_NONCE)
            .map_err(|_| unsigned())?
            .as_slice()
            .try_into()
            .map_err(|_| unsigned())?;
        let unix_ms = header_number(&headers, api::HEADER_TIMESTAMP).map_err(|_| unsigned())?;
        let counter = header_number(&headers, api::HEADER_COUNTER).map_err(|_| unsigned())?;
        let signature: [u8; 64] = header_hex(&headers, api::HEADER_SIGNATURE)
            .map_err(|_| unsigned())?
            .as_slice()
            .try_into()
            .map_err(|_| unsigned())?;

        // Read at the small cap unless method and path alone (known before any header is
        // trusted) name one of the two large-body routes. See [`is_large_body_route`].
        let cap = if is_large_body_route(&method, &route_path) {
            MAX_SIGNED_BODY
        } else {
            api::MAX_SIGNED_BODY
        };
        let body = axum::body::to_bytes(body, cap)
            .await
            .map_err(|_| SessionError::Malformed("request body"))?;

        let pending = state
            .sessions
            .begin_request(&SignedRequest {
                session_id: &session_id,
                method: &method,
                path: &path,
                body: &body,
                nonce,
                unix_ms,
                counter,
                signature,
            })
            .await?;

        Ok(Self {
            pending,
            body,
            query,
            address,
        })
    }
}

fn header_text(headers: &HeaderMap, name: &'static str) -> Result<String, SessionError> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or(SessionError::Malformed("request headers"))
}

fn header_hex(headers: &HeaderMap, name: &'static str) -> Result<Vec<u8>, SessionError> {
    let text = header_text(headers, name)?;
    unhex(&text).ok_or(SessionError::Malformed("request headers"))
}

fn header_number(headers: &HeaderMap, name: &'static str) -> Result<i64, SessionError> {
    header_text(headers, name)?
        .parse::<i64>()
        .map_err(|_| SessionError::Malformed("request headers"))
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

// ---- Errors ----

/// Either half of what a route here can refuse with, the error type every
/// handler's `?` converges on.
pub enum RouteError {
    Session(SessionError),
    Design(DesignError),
}

impl From<SessionError> for RouteError {
    fn from(e: SessionError) -> Self {
        Self::Session(e)
    }
}

impl From<DesignError> for RouteError {
    fn from(e: DesignError) -> Self {
        Self::Design(e)
    }
}

impl IntoResponse for RouteError {
    fn into_response(self) -> Response {
        match self {
            // Reuses `api::Refusal`'s tested mapping from `SessionError` to a status and a
            // fixed sentence.
            Self::Session(e) => api::Refusal::from(e).into_response(),
            Self::Design(e) => design_error_response(e),
        }
    }
}

/// `DesignError` surfaced as itself, in particular
/// [`DesignError::AuditSpoolBeyondBounds`], which must read as the operational
/// condition it is, not a generic failure.
fn design_error_response(e: DesignError) -> Response {
    match &e {
        DesignError::NoSuchDesign | DesignError::NoSuchVersion | DesignError::NoSuchScope => {
            (StatusCode::NOT_FOUND, "no such design\n").into_response()
        }
        DesignError::NoSuchFieldDefinition => {
            (StatusCode::NOT_FOUND, "no such field definition\n").into_response()
        }
        DesignError::InvalidFieldDefinition(why) => {
            (StatusCode::BAD_REQUEST, format!("{why}\n")).into_response()
        }
        DesignError::FieldDefinitionConflict { current } => (
            StatusCode::CONFLICT,
            format!("that field is now at version {current}; reload and try again\n"),
        )
            .into_response(),
        DesignError::InvalidCorrection(why) => {
            (StatusCode::BAD_REQUEST, format!("{why}\n")).into_response()
        }
        DesignError::CorrectionLooksSecret => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "That looks as if it carries a password or key, so it was not sent. A word such as key, \
             secret, password or community next to a value is refused, even in an ordinary \
             sentence; reword it without the value.\n",
        )
            .into_response(),
        DesignError::CorrectionCap(why) => {
            (StatusCode::TOO_MANY_REQUESTS, format!("{why}\n")).into_response()
        }
        DesignError::NoSuchCorrection => {
            (StatusCode::NOT_FOUND, "no such correction\n").into_response()
        }
        DesignError::CorrectionConflict { state, version } => (
            StatusCode::CONFLICT,
            if state == "open" {
                format!(
                    "that correction changed (now at version {version}); reload and try again\n"
                )
            } else {
                format!("that correction was already {state}\n")
            },
        )
            .into_response(),
        DesignError::InvalidName => (
            StatusCode::BAD_REQUEST,
            "a design name is at most 100 characters, without control characters\n",
        )
            .into_response(),
        DesignError::PayloadTooLarge { bytes } => (
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "that payload is {bytes} bytes; one design version may be at most \
                 {} bytes\n",
                designs::MAX_PAYLOAD_BYTES
            ),
        )
            .into_response(),
        DesignError::AuditSpoolBeyondBounds {
            bound,
            oldest_seconds,
            entries,
            bytes,
        } => {
            tracing::error!(
                %bound,
                oldest_seconds,
                entries,
                bytes,
                "design write refused: audit spool beyond bounds"
            );
            (
                StatusCode::SERVICE_UNAVAILABLE,
                format!(
                    "this design was NOT saved: the audit trail spool has passed its {bound} \
                     bound ({entries} entries, {bytes} bytes, oldest {oldest_seconds}s). Reading \
                     designs still works and nothing has been lost. Writes resume once the audit \
                     destination accepts the backlog, or an operator raises the bound having \
                     understood that the window of unwitnessed history grows with it.\n"
                ),
            )
                .into_response()
        }
        DesignError::Refused | DesignError::Corrupt(_) => {
            tracing::error!(reason = %e, "design storage integrity check failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "refused\n").into_response()
        }
        // ADR-0049 #2 and #4: a distinct, non-500 status naming the plain-face error;
        // the payload is the caller's own bytes, not a storage fault.
        DesignError::InvalidPlainPayload(plain_error) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "that payload does not read back as a fathom-plain document: {plain_error:?}\n"
            ),
        )
            .into_response(),
        DesignError::SchemaVersionPrefixMismatch { prefix, declared } => (
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "the wire prefix names schema version {prefix} but the payload's own line 3 \
                 declares `{declared}`; these must agree\n"
            ),
        )
            .into_response(),
        // ADR-0054 #1: the save precondition. The header names the design's current
        // version, so a client that wants to reload and reapply needs no second round
        // trip.
        DesignError::VersionConflict { base, current } => {
            let mut headers = HeaderMap::new();
            headers.insert(
                "fathom-design-version",
                current
                    .to_string()
                    .parse()
                    .expect("a decimal integer is a valid header value"),
            );
            (
                StatusCode::CONFLICT,
                headers,
                format!(
                    "you opened version {base}; it is now version {current}, someone saved in \
                     between. Reload to see their change; yours is still on your screen and was \
                     not written.\n"
                ),
            )
                .into_response()
        }
        // The client gates before sending, so a hit here means an old or hostile client,
        // not a real capture or note: refused before the write, never stored.
        DesignError::CredentialInPayload { kind, line } => (
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "that payload's {kind} text still carries something that looks like a \
                 credential, at line {line}; refused before it reaches storage. The client \
                 redacts before sending, so this usually means an old or hostile client.\n"
            ),
        )
            .into_response(),
        // ADR-0054 #5: the re-check immediately before the act. Answered as
        // `api::Refusal` answers the same `AuthorityError` (see its comment):
        // `NotAuthorised`/`QuorumNotMet` are a permission answer, everything else an
        // integrity alarm.
        DesignError::Authority(inner) => authority_refusal_response(inner),
        DesignError::Pool(_)
        | DesignError::Db(_)
        | DesignError::Repo(_)
        | DesignError::Keys(_)
        | DesignError::Crypto(_) => {
            tracing::error!(reason = %e, "design operation failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "refused\n").into_response()
        }
    }
}

/// [`DesignError::Authority`]'s mapping: the status and sentence `api::Refusal`
/// gives `SessionError::Authority(_)`. Its own function because that impl takes
/// an owned `SessionError`, while this site holds a borrowed `AuthorityError`
/// (it carries a non-`Clone` `tokio_postgres::Error`).
fn authority_refusal_response(e: &grants::AuthorityError) -> Response {
    match e {
        grants::AuthorityError::NotAuthorised | grants::AuthorityError::QuorumNotMet { .. } => {
            tracing::info!(reason = %e, "not authorised");
            (StatusCode::FORBIDDEN, "not authorised\n").into_response()
        }
        // A proposal overtaken by another change: ask again.
        grants::AuthorityError::Stale(_) => {
            tracing::info!(reason = %e, "stale proposal");
            (StatusCode::CONFLICT, "changed since it was proposed\n").into_response()
        }
        _ => {
            tracing::error!(reason = %e, "integrity check failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "refused\n").into_response()
        }
    }
}

// ---- Authorisation, shared by open/save/history/verify ----

/// Verify tenant membership, then authorise `needed` on the design's own scope,
/// all against `tx`, the transaction the handler commits its bookkeeping in.
///
/// When the design does not exist this checks the ORGANISATION's scope (`None`)
/// instead of refusing, so either failure gives the identical
/// [`grants::AuthorityError::NotAuthorised`] (module doc, "absent, not
/// forbidden").
async fn authorise_on_design(
    tx: &Transaction<'_>,
    state: &DesignApiState,
    session: &VerifiedSession,
    tenant: OrganisationId,
    design: DesignId,
    needed: Capability,
) -> Result<TenantContext, SessionError> {
    let ctx = sessions::open_tenant_context(tx, tenant, session).await?;
    let tenant_key = crate::keys::tenant_key(tx, &state.ring, &ctx).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };

    let scope = design_scope(tx, &ctx, design).await?;
    grants::authorise_account(tx, &auth, scope, needed).await?;
    Ok(ctx)
}

/// The design's own scope, or `None` if no design with this id exists in this
/// tenant.
async fn design_scope(
    tx: &Transaction<'_>,
    ctx: &TenantContext,
    design: DesignId,
) -> Result<Option<ScopeId>, SessionError> {
    let row = tx
        .query_opt(
            "SELECT scope_id FROM designs WHERE id = $1 AND organisation_id = $2",
            &[&design.to_string(), &ctx.tenant().to_string()],
        )
        .await
        .map_err(SessionError::Db)?;
    match row {
        None => Ok(None),
        Some(row) => {
            let text: String = row.get(0);
            let scope: ScopeId = text
                .parse()
                .map_err(|_| SessionError::Corrupt("design scope id"))?;
            Ok(Some(scope))
        }
    }
}

fn parse_organisation(text: &str) -> Result<OrganisationId, SessionError> {
    text.parse()
        .map_err(|_| SessionError::Malformed("organisation id"))
}

fn parse_design(text: &str) -> Result<DesignId, SessionError> {
    text.parse()
        .map_err(|_| SessionError::Malformed("design id"))
}

fn parse_scope(text: &str) -> Result<ScopeId, SessionError> {
    text.parse()
        .map_err(|_| SessionError::Malformed("scope id"))
}

// ---- Organisations ----

/// `GET /organisations`: every organisation the signed-in account belongs to, each
/// with the account's own role (`admin` or `member`). The Home screen needs this
/// before it can name a tenant.
///
/// **Deliberately does not call [`sessions::open_tenant_context`]**, which pins one
/// tenant; this route answers "which tenants" before any is known. It uses
/// [`repo::list_organisations_for_account_in`], which sets `app.account_id` only,
/// so it reads exactly the rows RLS lets an account see about itself.
///
/// An operator session is refused with [`SessionError::NotATenantPrincipal`]
/// (operators are unrepresentable in a membership, `0004`).
async fn list_organisations_handler(
    State(state): State<DesignApiState>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;

    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    // `sessions::account_without_tenant` is the named bridge for a route with no
    // tenant to open, and refuses an operator session itself. Parsing
    // `principal_id()` into an `AccountId` here would be the bypass its doc exists to
    // prevent.
    let account = sessions::account_without_tenant(&session)?;

    let organisations = repo::list_organisations_for_account_in(&tx, account)
        .await
        .map_err(SessionError::from)?;

    tx.commit().await.map_err(SessionError::Db)?;

    let out = organisations
        .into_iter()
        .map(|(o, role)| {
            let mut map = BTreeMap::new();
            map.insert("organisation_id".to_string(), Json::Str(o.id.to_string()));
            map.insert("display_name".to_string(), Json::Str(o.display_name));
            map.insert("role".to_string(), Json::Str(role.as_str().to_string()));
            Json::Obj(map)
        })
        .collect();

    Ok(json_response(Json::Arr(out)))
}

// ---- List ----

/// `GET /organisations/{organisation}/designs`: every design the caller holds at
/// least `read` on. A design with no capability is left out, never listed as
/// forbidden (module doc).
async fn list_designs_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;

    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };

    // §3.4 steps 2-5, once for the whole list (see `grants::VerifiedAuthorityState`).
    // Each row runs only step 1's ancestors and step 6's candidate match.
    let verified = grants::verify_authority_state(&tx, &auth)
        .await
        .map_err(SessionError::Authority)?;

    let rows = tx
        .query(
            "SELECT d.id, d.scope_id, extract(epoch FROM d.created_at)::bigint, d.created_by, \
                    coalesce(max(p.design_version), 0), \
                    d.name_ciphertext, d.name_nonce, d.name_key_epoch \
             FROM designs d \
             LEFT JOIN design_payload p \
               ON p.design_id = d.id AND p.organisation_id = d.organisation_id \
             WHERE d.organisation_id = $1 \
             GROUP BY d.id, d.scope_id, d.created_at, d.created_by, \
                      d.name_ciphertext, d.name_nonce, d.name_key_epoch \
             ORDER BY d.created_at",
            &[&ctx.tenant().to_string()],
        )
        .await
        .map_err(SessionError::Db)?;

    let mut names = designs::NameOpener::new(&auth);
    let mut out = Vec::new();
    for row in rows {
        let id: String = row.get(0);
        let scope_text: String = row.get(1);
        let created_at_unix: i64 = row.get(2);
        let created_by: String = row.get(3);
        let latest_version: i64 = row.get(4);
        let sealed_name = match (
            row.get::<_, Option<Vec<u8>>>(5),
            row.get::<_, Option<Vec<u8>>>(6),
            row.get::<_, Option<i32>>(7),
        ) {
            (Some(c), Some(n), Some(e)) => Some((c, n, e)),
            _ => None,
        };

        let scope: ScopeId = scope_text
            .parse()
            .map_err(|_| SessionError::Corrupt("design scope id"))?;

        let answer = grants::authorise_in_verified_state(
            &tx,
            &auth,
            &verified,
            Some(scope),
            Capability::Read,
        )
        .await;
        let capability = match answer {
            Ok(c) => c.capability,
            Err(grants::AuthorityError::NotAuthorised)
            | Err(grants::AuthorityError::QuorumNotMet { .. }) => continue,
            Err(other) => return Err(SessionError::Authority(other).into()),
        };
        let name = names.open(&tx, &id, sealed_name).await?;

        let mut map = BTreeMap::new();
        map.insert("name".to_string(), name.map_or(Json::Null, Json::Str));
        map.insert("design_id".to_string(), Json::Str(id));
        map.insert("scope_id".to_string(), Json::Str(scope_text));
        map.insert("created_at_unix".to_string(), Json::Int(created_at_unix));
        map.insert("created_by".to_string(), Json::Str(created_by));
        map.insert(
            "capability".to_string(),
            Json::Str(capability.as_str().to_string()),
        );
        map.insert("latest_version".to_string(), Json::Int(latest_version));
        out.push(Json::Obj(map));
    }

    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(Json::Arr(out)))
}

// ---- Scopes ----

/// `GET /organisations/{organisation}/scopes`: every scope the caller holds at
/// least `read` on, ordered by `path` (root first). Built for D11
/// (`docs/OPEN-QUESTIONS.md`): a design has no name of its own, so the client names
/// it by its scope, and the path control and tree pop-over need this tree.
///
/// Filters row by row through `grants::authorise_account`, like
/// [`list_designs_handler`].
///
/// **Navigation consequence:** each row is checked on its own scope, so an
/// unreadable ancestor is absent even when a descendant is present: `read` on one
/// rack and nothing above gives that rack alone, and the client draws the path from
/// the highest ancestor it was given. Showing an unreadable ancestor's name would
/// reveal a scope the account has no capability on, which
/// `docs/OPEN-QUESTIONS.md` B4 has not decided anyone may see. If that changes, it
/// changes here.
async fn list_scopes_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;

    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };

    // §3.4 steps 2-5, once for the whole list; see `list_designs_handler`.
    let verified = grants::verify_authority_state(&tx, &auth)
        .await
        .map_err(SessionError::Authority)?;

    let rows = tx
        .query(
            "SELECT id, parent_scope_id, kind, display_name, path, depth \
             FROM scopes \
             WHERE organisation_id = $1 \
             ORDER BY path",
            &[&ctx.tenant().to_string()],
        )
        .await
        .map_err(SessionError::Db)?;

    let mut out = Vec::new();
    for row in rows {
        let id_text: String = row.get(0);
        let parent_text: Option<String> = row.get(1);
        let kind_text: String = row.get(2);
        let display_name: String = row.get(3);
        let path: String = row.get(4);
        let depth: i16 = row.get(5);

        let scope: ScopeId = id_text
            .parse()
            .map_err(|_| SessionError::Corrupt("scope id"))?;
        let kind = repo::ScopeKind::parse(&kind_text).ok_or(SessionError::Corrupt("scope kind"))?;

        let answer = grants::authorise_in_verified_state(
            &tx,
            &auth,
            &verified,
            Some(scope),
            Capability::Read,
        )
        .await;
        let capability = match answer {
            Ok(c) => c.capability,
            Err(grants::AuthorityError::NotAuthorised)
            | Err(grants::AuthorityError::QuorumNotMet { .. }) => continue,
            Err(other) => return Err(SessionError::Authority(other).into()),
        };

        let mut map = BTreeMap::new();
        map.insert("scope_id".to_string(), Json::Str(id_text));
        map.insert(
            "parent_scope_id".to_string(),
            match parent_text {
                Some(p) => Json::Str(p),
                None => Json::Null,
            },
        );
        map.insert("kind".to_string(), Json::Str(kind.as_str().to_string()));
        map.insert("display_name".to_string(), Json::Str(display_name));
        map.insert("depth".to_string(), Json::Int(depth as i64));
        map.insert("path".to_string(), Json::Str(path));
        map.insert(
            "capability".to_string(),
            Json::Str(capability.as_str().to_string()),
        );
        out.push(Json::Obj(map));
    }

    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(Json::Arr(out)))
}

/// `POST /organisations/{organisation}/scopes`: ADR-0054 #3 /
/// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §6.4: **a steward of the parent creates
/// a scope.** Body: two length-prefixed fields: the parent scope id (empty for a
/// new root network), then the display name.
///
/// The child's *kind* is not on the wire: it is the one kind that fits directly
/// under the parent ([`child_kind_under`]; the hierarchy is three fixed levels).
///
/// Authorises `steward` on the parent (organisation-wide for a new root network;
/// §6.4: stewardship inherits down the path), then inserts in the same
/// transaction (ADR-0054 #5). A drawer, or a steward elsewhere, gets the same
/// `403` as a missing or foreign parent. Answers in the shape of
/// [`list_scopes_handler`]'s rows.
async fn create_scope_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;

    let (parent_bytes, rest) =
        crypto::read_lp(&signed.body).ok_or(SessionError::Malformed("request body"))?;
    let (label_bytes, _) = crypto::read_lp(rest).ok_or(SessionError::Malformed("request body"))?;
    let parent: Option<ScopeId> = if parent_bytes.is_empty() {
        None
    } else {
        Some(
            core::str::from_utf8(parent_bytes)
                .ok()
                .and_then(|s| s.parse().ok())
                .ok_or(SessionError::Malformed("parent scope id"))?,
        )
    };
    let label = core::str::from_utf8(label_bytes)
        .map_err(|_| SessionError::Malformed("scope label"))?
        .to_string();

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let answer = grants::authorise_account(&tx, &auth, parent, Capability::Steward)
        .await
        .map_err(SessionError::Authority)?;

    let parent_kind = match parent {
        None => None,
        Some(p) => {
            let row = tx
                .query_opt(
                    "SELECT kind FROM scopes WHERE id = $1 AND organisation_id = $2",
                    &[&p.to_string(), &ctx.tenant().to_string()],
                )
                .await
                .map_err(SessionError::Db)?
                .ok_or(DesignError::NoSuchScope)?;
            let kind_text: String = row.get(0);
            Some(repo::ScopeKind::parse(&kind_text).ok_or(SessionError::Corrupt("scope kind"))?)
        }
    };
    let kind = child_kind_under(parent_kind)
        .ok_or(SessionError::Malformed("a rack may not contain a scope"))?;

    let scope = repo::create_scope_in_tx(&tx, tenant, parent, kind, &label)
        .await
        .map_err(SessionError::from)?;
    tx.commit().await.map_err(SessionError::Db)?;

    let mut map = BTreeMap::new();
    map.insert("scope_id".to_string(), Json::Str(scope.id.to_string()));
    map.insert(
        "parent_scope_id".to_string(),
        match scope.parent_scope_id {
            Some(p) => Json::Str(p.to_string()),
            None => Json::Null,
        },
    );
    map.insert(
        "kind".to_string(),
        Json::Str(scope.kind.as_str().to_string()),
    );
    map.insert(
        "display_name".to_string(),
        Json::Str(scope.display_name.clone()),
    );
    map.insert("depth".to_string(), Json::Int(scope.depth as i64));
    map.insert("path".to_string(), Json::Str(scope.path.clone()));
    map.insert(
        "capability".to_string(),
        Json::Str(answer.capability.as_str().to_string()),
    );
    Ok(json_response(Json::Obj(map)))
}

/// The one scope kind that fits directly under a parent of kind `parent_kind`
/// (see [`create_scope_handler`]). `None` for `Rack`: the hierarchy is three
/// levels deep.
fn child_kind_under(parent_kind: Option<repo::ScopeKind>) -> Option<repo::ScopeKind> {
    match parent_kind {
        None => Some(repo::ScopeKind::Network),
        Some(repo::ScopeKind::Network) => Some(repo::ScopeKind::Building),
        Some(repo::ScopeKind::Building) => Some(repo::ScopeKind::Rack),
        Some(repo::ScopeKind::Rack) => None,
    }
}

// ---- Create a design ----

/// `POST /organisations/{organisation}/scopes/{scope}/designs`: ADR-0054 #2:
/// **draw creates a design.** The body is a save's framing
/// (`u32_le(payload_schema_version) ‖ payload_bytes`), validated by the shared
/// [`validate_payload`], and carries the client's empty document
/// (`client/src/document/model.ts`'s `emptyDocument`, via
/// `fathom_workspace::write_plain`).
///
/// Authorises `draw` on `scope` (or an ancestor) and creates the design and its
/// first version in the same transaction (ADR-0054 #5), through
/// [`designs::create_design_with_first_version_in_tx`], so a bodiless design is
/// never minted. A reader, or a foreign or missing scope, gets an identical `403`.
/// A payload pushing the audit spool beyond its bound is refused `503` with no
/// design row left. Answers in the shape of [`list_designs_handler`]'s rows.
async fn create_design_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, scope)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;

    let (schema_version, payload) = validate_payload(&signed.body)?;

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };

    let (design_id, version, created_at_unix, capability) =
        designs::create_design_with_first_version_in_tx(
            &tx,
            &auth,
            scope_id,
            payload,
            schema_version as i32,
            &audit::SpoolBounds::from_env(),
        )
        .await?;

    tx.commit().await.map_err(SessionError::Db)?;

    let mut map = BTreeMap::new();
    map.insert("design_id".to_string(), Json::Str(design_id.to_string()));
    map.insert("scope_id".to_string(), Json::Str(scope_id.to_string()));
    map.insert("created_at_unix".to_string(), Json::Int(created_at_unix));
    map.insert("created_by".to_string(), Json::Str(ctx.actor().to_string()));
    map.insert(
        "capability".to_string(),
        Json::Str(capability.as_str().to_string()),
    );
    map.insert("latest_version".to_string(), Json::Int(version));
    Ok(json_response(Json::Obj(map)))
}

// ---- Sharing a scope (View / Draw) ----
//
// Every route here needs `steward` on the scope, checked in `grants::`. The grant
// is signed in the steward's browser (§3.3); the server fixes the bytes first and
// re-derives every field of them when the signature comes back.

/// A revoke signature is accepted for a time within this many seconds of now.
const REVOKE_SKEW_SECONDS: i64 = 300;

fn to_hex(bytes: &[u8]) -> String {
    use core::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn lp_text<'a>(rest: &mut &'a [u8], what: &'static str) -> Result<&'a str, SessionError> {
    let (field, tail) = crypto::read_lp(rest).ok_or(SessionError::Malformed("request body"))?;
    *rest = tail;
    core::str::from_utf8(field).map_err(|_| SessionError::Malformed(what))
}

fn lp_number(rest: &mut &[u8], what: &'static str) -> Result<i64, SessionError> {
    lp_text(rest, what)?
        .parse()
        .map_err(|_| SessionError::Malformed(what))
}

fn fixed32(text: &str, what: &'static str) -> Result<[u8; 32], SessionError> {
    unhex(text)
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or(SessionError::Malformed(what))
}

/// The shareable capability named in a body: `read` or `draw`, never `steward`.
fn shareable(text: &str) -> Result<Capability, SessionError> {
    Capability::parse(text)
        .filter(|c| grants::is_shareable(*c))
        .ok_or(SessionError::Malformed("capability"))
}

/// `subject` must already belong to the organisation and not be the caller.
async fn require_other_member(
    tx: &Transaction<'_>,
    ctx: &TenantContext,
    subject: &str,
) -> Result<String, SessionError> {
    let canonical: repo::AccountId = subject
        .parse()
        .map_err(|_| SessionError::Malformed("account id"))?;
    if canonical.to_string() == ctx.actor().to_string() {
        return Err(SessionError::Malformed("account id"));
    }
    tx.query_opt(
        "SELECT 1 FROM memberships WHERE organisation_id = $1 AND account_id = $2",
        &[&ctx.tenant().to_string(), &canonical.to_string()],
    )
    .await
    .map_err(SessionError::Db)?
    .ok_or(SessionError::Malformed("account id"))?;
    Ok(canonical.to_string())
}

/// `GET .../scopes/{scope}/access`: every member and what they can do here.
async fn access_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, scope)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    // The caller's own authority before anything about the organisation is read.
    grants::authorise_account(&tx, &auth, Some(scope_id), Capability::Steward)
        .await
        .map_err(SessionError::Authority)?;
    let people = tx
        .query(
            "SELECT a.id, a.email, a.display_name FROM memberships m \
               JOIN accounts a ON a.id = m.account_id \
              WHERE m.organisation_id = $1 ORDER BY a.display_name, a.id",
            &[&ctx.tenant().to_string()],
        )
        .await
        .map_err(SessionError::Db)?;
    let ids: Vec<String> = people.iter().map(|r| r.get(0)).collect();
    let rows = grants::access_at_scope(&tx, &auth, scope_id, &ids)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;

    let out = people
        .iter()
        .zip(rows)
        .map(|(person, row)| {
            let mut map = BTreeMap::new();
            map.insert("account".to_string(), Json::Str(row.account.clone()));
            map.insert("email".to_string(), Json::Str(person.get(1)));
            map.insert("name".to_string(), Json::Str(person.get(2)));
            map.insert(
                "you".to_string(),
                Json::Bool(row.account == ctx.actor().to_string()),
            );
            map.insert(
                "capability".to_string(),
                match row.capability {
                    Some(c) => Json::Str(c.as_str().to_string()),
                    None => Json::Null,
                },
            );
            map.insert("inherited".to_string(), Json::Bool(row.inherited));
            map.insert(
                "direct".to_string(),
                Json::Arr(
                    row.direct
                        .iter()
                        .map(|(id, c)| {
                            let mut g = BTreeMap::new();
                            g.insert("grant".to_string(), Json::Str(id.clone()));
                            g.insert("capability".to_string(), Json::Str(c.as_str().to_string()));
                            Json::Obj(g)
                        })
                        .collect(),
                ),
            );
            Json::Obj(map)
        })
        .collect();
    let mut map = BTreeMap::new();
    map.insert("people".to_string(), Json::Arr(out));
    Ok(json_response(Json::Obj(map)))
}

/// `POST .../scopes/{scope}/grants/propose`: body `LP(account) ‖ LP(capability)`.
/// Answers the fields of the proposal and the `bytes` to sign, hex.
async fn propose_share_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, scope)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;
    let mut rest: &[u8] = &signed.body;
    let subject = lp_text(&mut rest, "account id")?.to_string();
    let capability = shareable(lp_text(&mut rest, "capability")?)?;

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    // The caller's own authority first, so a non-steward learns nothing about
    // who belongs to the organisation.
    grants::authorise_account(&tx, &auth, Some(scope_id), Capability::Steward)
        .await
        .map_err(SessionError::Authority)?;
    let subject = require_other_member(&tx, &ctx, &subject).await?;
    let proposal = grants::propose_grant(
        &tx,
        &auth,
        &grants::GrantRequest {
            scope: Some(scope_id),
            subject: subject
                .parse()
                .map_err(|_| SessionError::Malformed("account id"))?,
            capability,
            expires_at_unix: 0,
        },
    )
    .await
    .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;

    let mut map = BTreeMap::new();
    map.insert("subject".to_string(), Json::Str(proposal.subject.clone()));
    map.insert(
        "capability".to_string(),
        Json::Str(proposal.capability.as_str().to_string()),
    );
    map.insert(
        "effective_from_unix".to_string(),
        Json::Int(proposal.effective_from_unix),
    );
    map.insert(
        "auth_epoch".to_string(),
        Json::Int(i64::from(proposal.auth_epoch)),
    );
    map.insert(
        "granter_key_fpr".to_string(),
        Json::Str(to_hex(&proposal.granter_key_fpr)),
    );
    map.insert(
        "subject_key_fpr".to_string(),
        Json::Str(to_hex(&proposal.subject_key_fpr)),
    );
    map.insert(
        "root_pubkey_fpr".to_string(),
        Json::Str(to_hex(&proposal.root_pubkey_fpr)),
    );
    map.insert("bytes".to_string(), Json::Str(to_hex(&proposal.bytes)));
    Ok(json_response(Json::Obj(map)))
}

/// `POST .../scopes/{scope}/grants/sign`: body `LP(account) ‖ LP(capability) ‖
/// LP(effective_from) ‖ LP(auth_epoch) ‖ LP(granter_key_fpr hex) ‖
/// LP(subject_key_fpr hex) ‖ LP(root_pubkey_fpr hex) ‖ LP(signature hex)`: the
/// proposal's fields back with the signature. Rebuilt, then re-derived and
/// verified in `grants::sign_grant`; the scope comes from the path, not the body.
async fn sign_share_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, scope)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;
    let mut rest: &[u8] = &signed.body;
    let subject = lp_text(&mut rest, "account id")?.to_string();
    let capability = shareable(lp_text(&mut rest, "capability")?)?;
    let effective_from_unix = lp_number(&mut rest, "effective-from")?;
    let auth_epoch = i32::try_from(lp_number(&mut rest, "authority epoch")?)
        .map_err(|_| SessionError::Malformed("authority epoch"))?;
    let granter_key_fpr = fixed32(lp_text(&mut rest, "key fingerprint")?, "key fingerprint")?;
    let subject_key_fpr = fixed32(lp_text(&mut rest, "key fingerprint")?, "key fingerprint")?;
    let root_pubkey_fpr = fixed32(lp_text(&mut rest, "key fingerprint")?, "key fingerprint")?;
    let signature = unhex(lp_text(&mut rest, "signature")?)
        .filter(|s| s.len() == 64)
        .ok_or(SessionError::Malformed("signature"))?;

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    grants::authorise_account(&tx, &auth, Some(scope_id), Capability::Steward)
        .await
        .map_err(SessionError::Authority)?;
    let subject = require_other_member(&tx, &ctx, &subject).await?;
    let proposal = grants::GrantProposal {
        organisation: ctx.tenant().to_string(),
        scope: Some(scope_id.to_string()),
        subject,
        subject_key_fpr,
        capability,
        granter: ctx.actor().to_string(),
        granter_key_fpr,
        root_pubkey_fpr,
        effective_from_unix,
        expires_at_unix: 0,
        auth_epoch,
        sole_steward_appointment: false,
        bytes: Vec::new(),
    }
    .rebuilt();
    let grant_id = grants::sign_grant(&tx, &auth, &proposal, &signature)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;

    let mut map = BTreeMap::new();
    map.insert("grant".to_string(), Json::Str(grant_id));
    Ok(json_response(Json::Obj(map)))
}

/// `GET .../grants/{grant}/revoke`: the time and the bytes to sign to revoke it.
async fn revoke_bytes_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, scope, grant)): PathExtractor<(String, String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;
    let at = unix_now();
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    let bytes = grants::revoke_bytes_for_share(&tx, &auth, scope_id, &grant, at)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;

    let mut map = BTreeMap::new();
    map.insert("at".to_string(), Json::Int(at));
    map.insert("bytes".to_string(), Json::Str(to_hex(&bytes)));
    Ok(json_response(Json::Obj(map)))
}

/// `POST .../grants/{grant}/revoke`: body `LP(at) ‖ LP(signature hex)`. Takes
/// effect on the next request: `authorise_account` reads the revocation each time.
async fn revoke_share_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, scope, grant)): PathExtractor<(String, String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let scope_id = parse_scope(&scope)?;
    let mut rest: &[u8] = &signed.body;
    let at = lp_number(&mut rest, "revoke time")?;
    let signature = unhex(lp_text(&mut rest, "signature")?)
        .filter(|s| s.len() == 64)
        .ok_or(SessionError::Malformed("signature"))?;
    // Never in the future: a future time would leave the grant working after the 200.
    if at > unix_now() || unix_now() - at > REVOKE_SKEW_SECONDS {
        return Err(SessionError::Malformed("revoke time").into());
    }

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    grants::revoke_shared_grant(&tx, &auth, scope_id, &grant, &signature, at)
        .await
        .map_err(SessionError::Authority)?;
    tx.commit().await.map_err(SessionError::Db)?;

    let mut map = BTreeMap::new();
    map.insert("grant".to_string(), Json::Str(grant));
    Ok(json_response(Json::Obj(map)))
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---- Rename ----

/// `POST /organisations/{organisation}/designs/{design}/name`: the body is the
/// new name in UTF-8; empty clears it. Needs `draw` on the design's scope.
async fn rename_design_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let design_id = parse_design(&design)?;
    let name = core::str::from_utf8(&signed.body)
        .map_err(|_| SessionError::Malformed("design name"))?
        .to_string();

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let scope = design_scope(&tx, &ctx, design_id).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };
    designs::rename_design_in_tx(&tx, &auth, design_id, scope, &name).await?;
    tx.commit().await.map_err(SessionError::Db)?;

    let mut map = BTreeMap::new();
    map.insert("design_id".to_string(), Json::Str(design_id.to_string()));
    Ok(json_response(Json::Obj(map)))
}

// ---- Open ----

/// `GET /organisations/{organisation}/designs/{design}[?version=N]`: the
/// decrypted payload, verbatim, plus version numbers in headers. Requires at
/// least `read`.
///
/// ADR-0054 #5: one transaction; the capability check lives inside
/// [`designs::read_version_in_tx`] (see [`save_design_handler`]).
async fn open_design_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let design_id = parse_design(&design)?;
    let version = match signed.query_param("version") {
        Some(v) => Some(
            v.parse::<i64>()
                .map_err(|_| SessionError::Malformed("version"))?,
        ),
        None => None,
    };

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let scope = design_scope(&tx, &ctx, design_id).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };

    let stored = designs::read_version_in_tx(&tx, &auth, design_id, scope, version).await?;
    tx.commit().await.map_err(SessionError::Db)?;

    let mut headers = HeaderMap::new();
    headers.insert(
        "fathom-design-version",
        stored
            .version
            .to_string()
            .parse()
            .expect("a decimal integer is a valid header value"),
    );
    headers.insert(
        "fathom-payload-schema-version",
        stored
            .payload_schema_version
            .to_string()
            .parse()
            .expect("a decimal integer is a valid header value"),
    );
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "application/octet-stream"
            .parse()
            .expect("a static content type is a valid header value"),
    );
    // A design read under one person's authority must not sit in a shared cache; the
    // next caller through that proxy may not be allowed to read it. `api::bytes_response`'s
    // rule, restated because this response is built by hand.
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store"
            .parse()
            .expect("a static cache-control is a valid header value"),
    );
    Ok((StatusCode::OK, headers, stored.payload).into_response())
}

// ---- Save ----

/// `POST /organisations/{organisation}/designs/{design}/versions?base=N`: a new
/// version. Requires `draw`; a `read`-only caller is refused, without distinguishing
/// an existing design from a missing one (module doc).
///
/// # ADR-0054 #1: a save names the version it was based on
///
/// `base` is REQUIRED, in the signed query: an optional precondition is no
/// precondition. Missing or non-integer is a `400` before the session is verified.
/// A well-formed `base` that disagrees with the current version is a refusal,
/// decided by [`designs::write_version_in_tx`] under the row lock that also decides
/// the next version number.
///
/// Body: `u32_le(payload_schema_version) ‖ payload_bytes`. The prefix is four fixed
/// bytes because a length-prefixed field would copy up to 64 MiB twice. See
/// [`validate_payload`] for the checks before a transaction opens.
async fn save_design_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let design_id = parse_design(&design)?;

    let (schema_version, payload) = validate_payload(&signed.body)?;

    // ADR-0054 #1: required, a signed query parameter.
    let base: i64 = signed
        .query_param("base")
        .ok_or(SessionError::Malformed("base"))?
        .parse()
        .map_err(|_| SessionError::Malformed("base"))?;

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;

    // ADR-0054 #5: one transaction. The capability check lives in
    // `write_version_in_tx`, immediately before the write it gates, so nothing can
    // change in between (module doc, "one transaction").
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let scope = design_scope(&tx, &ctx, design_id).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };

    let version = designs::write_version_in_tx(
        &tx,
        &auth,
        design_id,
        scope,
        payload,
        schema_version as i32,
        base,
        &audit::SpoolBounds::from_env(),
    )
    .await?;

    tx.commit().await.map_err(SessionError::Db)?;

    Ok((
        StatusCode::OK,
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        format!("{version}\n"),
    )
        .into_response())
}

/// Everything ADR-0049 and the brief require of a wire payload before it is
/// written, by a save or a design-creation route (shared, so they cannot drift).
///
/// # The server reads every payload back before storing it (ADR-0049 #2)
///
/// `payload` is parsed with [`fathom_workspace::read_plain`] before the database is
/// touched. A design payload is a `fathom-plain 1` document (ADR-0049 #1), the one
/// graph format the engine reads, so unreadable bytes are refused at the door, not
/// stored opaque. This runs before the session is verified, like [`read_u32_le`]:
/// a malformed request costs the database nothing.
///
/// ADR-0049 #4: the wire prefix and the payload's declared schema version (line 3)
/// must agree. `read_plain` already refused a line 3 that is not this build's
/// version, so [`declared_schema_version`] reads it back from the same bytes.
/// [`schema_version_as_u32`] defines the wire number: strip the fixed `"0."` from
/// `SCHEMA_VERSION` and parse the minor.
///
/// # The payload's own text fields, checked once more, at the door
///
/// The redaction gate runs client-side (`fathom-ingest`, compiled for the browser;
/// CLAUDE.md rule 3), so every `Capture.text` and `Note.text` here should already
/// have had credential shapes destroyed. A hit means an old client that predates
/// the gate or a hostile one that skipped it: the write is refused, naming field
/// kind and line, before anything is stored.
///
/// [`find_credential`] uses `fathom_ingest::redact::looks_like_credential_bare` for
/// `Capture.text`, not a second detector: the gate's `looks_like_credential` plus
/// its `raw_walk`/`gate_unshaped` bare-adjacency rule, restated because this caller
/// has no lexed token list. Plain `looks_like_credential` needs a `:`/`=` beside a
/// secret word and misses most real device output (`keyword <secret>` with a bare
/// space; CLAUDE.md rule 2). `Note.text` stays on the plain predicate, since a note
/// may be hand-typed prose and bare adjacency flags "replaced the key switch"
/// (ADR-0053 §5). Both are hints over unstructured text, not the dictionary-driven
/// path, so a keyword missing from the static list (SNMPv3's `auth`/`priv`) is not
/// caught: a residual gap, not claimed closed.
fn validate_payload(body: &[u8]) -> Result<(u32, &[u8]), RouteError> {
    let (schema_version, payload) =
        read_u32_le(body).ok_or(SessionError::Malformed("design payload body"))?;

    // ADR-0049 #2: refuse anything the engine cannot read, before the session is
    // verified or the database touched. This function is not `async`, and
    // `fathom_graph::Graph` boxes values as `dyn Any` with no `Send` bound, so the
    // `Graph` is built, scanned and dropped before return; nothing crosses an
    // `.await`.
    let graph = fathom_workspace::read_plain(payload).map_err(DesignError::InvalidPlainPayload)?;

    // ADR-0049 #4: the wire prefix and the payload's declared schema version must
    // agree. `read_plain` already proved line 3 is a well-formed `schema <version>`
    // line.
    let declared = declared_schema_version(payload)
        .expect("read_plain already validated a well-formed line 3");
    if schema_version_as_u32(declared) != Some(schema_version) {
        return Err(DesignError::SchemaVersionPrefixMismatch {
            prefix: schema_version,
            declared: declared.to_owned(),
        }
        .into());
    }

    if let Some((kind, line)) = find_credential(&graph) {
        return Err(DesignError::CredentialInPayload { kind, line }.into());
    }

    Ok((schema_version, payload))
}

/// Every `Capture.text` and `Note.text` in the plain face, line by line, so the
/// refusal names which one. `Some((kind, line))` on the first hit (node order
/// within a kind, line order within a node); `None` when nothing trips the gate's
/// own sketch predicate.
fn find_credential(graph: &Graph) -> Option<(&'static str, usize)> {
    // `Capture` is never hand-typed (its node id is the weld's `CaptureId`, minted
    // only by a parse), so it is always pasted device output and bare adjacency is
    // the right aggression. `Note.text` may be EITHER pasted (through the same gate)
    // OR hand-typed prose (ADR-0053 §5: "Fathom does not redact what you type, only
    // what you paste"), and the plain-face payload cannot say which, so it stays on
    // the delimiter-only check, which is prose-safe, rather than risk refusing a
    // real sentence like "replaced the key switch". A credential a hostile client
    // typed into a `Note` with no delimiter is the residual.
    for node in graph.nodes_of_kind(NodeKind::Capture) {
        if let Ok(text) = capture::text(node) {
            if let Some(line) = credential_line(&text.0, true) {
                return Some(("Capture", line));
            }
        }
    }
    for node in graph.nodes_of_kind(NodeKind::Note) {
        if let Ok(text) = note::text(node) {
            if let Some(line) = credential_line(&text.0, false) {
                return Some(("Note", line));
            }
        }
    }
    None
}

/// The 1-based line in one field's text that first looks like a credential, run
/// per line because a multi-line `Capture.text` is a whole configuration file and
/// the refusal names the line. `bare` selects `looks_like_credential_bare` over
/// `looks_like_credential`; see [`find_credential`].
fn credential_line(text: &str, bare: bool) -> Option<usize> {
    text.lines()
        .enumerate()
        .find(|(_, line)| {
            if bare {
                fathom_ingest::redact::looks_like_credential_bare(line)
            } else {
                fathom_ingest::redact::looks_like_credential(line)
            }
        })
        .map(|(idx, _)| idx + 1)
}

fn read_u32_le(bytes: &[u8]) -> Option<(u32, &[u8])> {
    if bytes.len() < 4 {
        return None;
    }
    let (head, rest) = bytes.split_at(4);
    let arr: [u8; 4] = head.try_into().ok()?;
    Some((u32::from_le_bytes(arr), rest))
}

/// Line 3 of a `fathom-plain` payload, read from the raw bytes (`fathom_workspace`
/// has no policy of its own). Only called after `read_plain` accepted the same
/// bytes, so line 3 is well-formed (`schema <version>`); `None` only if that
/// breaks.
fn declared_schema_version(payload: &[u8]) -> Option<&str> {
    payload
        .split(|&b| b == b'\n')
        .nth(2)
        .and_then(|line| core::str::from_utf8(line).ok())
        .and_then(|line| line.strip_prefix("schema "))
}

/// ADR-0049 #4's wire number for `SCHEMA_VERSION` (`fathom-ir`'s `"0.N"` string).
/// Nothing else in the tree has a numeric form, so this defines it: strip the
/// fixed `"0."` (no major bump yet; `schema/schema.yaml`) and parse the minor.
/// Any other shape, such as a future major bump, returns `None`, an unconditional
/// refusal until the 1.x wire form is decided.
fn schema_version_as_u32(declared: &str) -> Option<u32> {
    declared
        .strip_prefix("0.")
        .and_then(|minor| minor.parse().ok())
}

// ---- History ----

/// `GET /organisations/{organisation}/designs/{design}/history`: every chain
/// entry for this design, in order. Requires at least `read`. A design chain
/// stores its metadata in the clear (§7.3), so no key beyond the open tenant
/// context is needed.
async fn history_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let design_id = parse_design(&design)?;

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx =
        authorise_on_design(&tx, &state, &session, tenant, design_id, Capability::Read).await?;

    // `authorise_on_design` alone does not prove the design exists: an
    // organisation-wide grant clears it for an id nothing was created under.
    let exists = tx
        .query_opt(
            "SELECT 1 FROM designs WHERE id = $1 AND organisation_id = $2",
            &[&design_id.to_string(), &ctx.tenant().to_string()],
        )
        .await
        .map_err(SessionError::Db)?;
    if exists.is_none() {
        return Err(RouteError::Design(DesignError::NoSuchDesign));
    }

    let rows = tx
        .query(
            "SELECT seq, entry_type, chain_key_epoch, design_version FROM chain_entries \
             WHERE chain_kind = 'design' AND design_id = $1 AND organisation_id = $2 \
             ORDER BY seq",
            &[&design_id.to_string(), &ctx.tenant().to_string()],
        )
        .await
        .map_err(SessionError::Db)?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let seq: i64 = row.get(0);
        let entry_type_text: String = row.get(1);
        let chain_key_epoch: i32 = row.get(2);
        let design_version: Option<i64> = row.get(3);
        let entry_type = chain::StoredEntryType::from_column(&entry_type_text);

        let mut map = BTreeMap::new();
        map.insert("seq".to_string(), Json::Int(seq));
        map.insert(
            "entry_type".to_string(),
            Json::Str(entry_type.as_str().to_string()),
        );
        map.insert(
            "chain_key_epoch".to_string(),
            Json::Int(i64::from(chain_key_epoch)),
        );
        map.insert(
            "design_version".to_string(),
            match design_version {
                Some(v) => Json::Int(v),
                None => Json::Null,
            },
        );
        out.push(Json::Obj(map));
    }

    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(Json::Arr(out)))
}

// ---- Verify ----

/// `GET /organisations/{organisation}/designs/{design}/verify[?deep=true]`:
/// storage §11.2's three outcomes by name: `verified`, `broken_at`,
/// `cannot_verify_under_key_epoch`. Requires at least `read`. ADR-0054 #5: one
/// transaction (see [`open_design_handler`]).
async fn verify_design_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let design_id = parse_design(&design)?;
    let deep = matches!(signed.query_param("deep"), Some("1") | Some("true"));

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(&state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    let scope = design_scope(&tx, &ctx, design_id).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };

    let report = designs::verify_design_in_tx(&tx, &auth, design_id, scope, deep).await?;
    tx.commit().await.map_err(SessionError::Db)?;

    Ok(json_response(json_of_report(&report)))
}

/// §11.2's three outcomes by name, never a boolean (module doc).
fn json_of_report(report: &chain::Report) -> Json {
    let mut map = BTreeMap::new();

    let outcome_name = match &report.outcome {
        chain::Outcome::Verified { .. } => "verified",
        chain::Outcome::BrokenAt { .. } => "broken_at",
        chain::Outcome::CannotVerifyUnderKeyEpoch { .. } => "cannot_verify_under_key_epoch",
    };
    map.insert("outcome".to_string(), Json::Str(outcome_name.to_string()));

    match &report.outcome {
        chain::Outcome::Verified { entries } => {
            map.insert("entries".to_string(), Json::Int(*entries as i64));
        }
        chain::Outcome::BrokenAt {
            seq,
            reason,
            verified_before,
            metadata: _,
            entry_type,
            chain_key_epoch,
            design_version,
        } => {
            map.insert("seq".to_string(), Json::Int(*seq));
            map.insert("reason".to_string(), Json::Str(format!("{reason:?}")));
            map.insert(
                "verified_before".to_string(),
                Json::Int(*verified_before as i64),
            );
            map.insert(
                "entry_type".to_string(),
                match entry_type {
                    Some(t) => Json::Str(t.as_str().to_string()),
                    None => Json::Null,
                },
            );
            map.insert(
                "chain_key_epoch".to_string(),
                match chain_key_epoch {
                    Some(e) => Json::Int(i64::from(*e)),
                    None => Json::Null,
                },
            );
            map.insert(
                "design_version".to_string(),
                match design_version {
                    Some(v) => Json::Int(*v),
                    None => Json::Null,
                },
            );
        }
        chain::Outcome::CannotVerifyUnderKeyEpoch {
            epochs,
            ranges,
            verified_before,
        } => {
            map.insert(
                "epochs".to_string(),
                Json::Arr(epochs.iter().map(|e| Json::Int(i64::from(*e))).collect()),
            );
            map.insert(
                "ranges".to_string(),
                Json::Arr(
                    ranges
                        .iter()
                        .map(|(a, b)| Json::Arr(vec![Json::Int(*a), Json::Int(*b)]))
                        .collect(),
                ),
            );
            map.insert(
                "verified_before".to_string(),
                Json::Int(*verified_before as i64),
            );
        }
    }

    map.insert(
        "depth".to_string(),
        Json::Str(
            match report.depth {
                chain::Depth::Links => "links",
                chain::Depth::Deep => "deep",
            }
            .to_string(),
        ),
    );
    map.insert(
        "content".to_string(),
        Json::Str(
            match report.content {
                chain::ContentState::Rebound => "rebound",
                chain::ContentState::NotRebound => "not_rebound",
            }
            .to_string(),
        ),
    );
    map.insert(
        "coverage".to_string(),
        match &report.coverage {
            Some(c) => {
                let mut cm = BTreeMap::new();
                cm.insert(
                    "epochs".to_string(),
                    Json::Arr(c.epochs.iter().map(|e| Json::Int(i64::from(*e))).collect()),
                );
                cm.insert(
                    "ranges".to_string(),
                    Json::Arr(
                        c.ranges
                            .iter()
                            .map(|(a, b)| Json::Arr(vec![Json::Int(*a), Json::Int(*b)]))
                            .collect(),
                    ),
                );
                cm.insert("entries".to_string(), Json::Int(c.entries as i64));
                Json::Obj(cm)
            }
            None => Json::Null,
        },
    );
    map.insert("summary".to_string(), Json::Str(report.summary()));

    Json::Obj(map)
}

// ---- Catalogue: public reference data, behind a session and nothing else ----

/// `GET /catalogue/models`: every model this deployment's corpus carries, enough
/// to populate a picker.
async fn catalogue_list_handler(
    State(state): State<DesignApiState>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (_, tx) = signed.verify_and_commit(&state, tx).await?;
    tx.commit().await.map_err(SessionError::Db)?;

    let items = state
        .catalogue
        .iter()
        .map(|m| {
            let mut map = BTreeMap::new();
            map.insert("vendor".to_string(), Json::Str(m.vendor.clone()));
            map.insert("model".to_string(), Json::Str(m.model.clone()));
            map.insert("rack_units".to_string(), Json::Int(i64::from(m.rack_units)));
            Json::Obj(map)
        })
        .collect();
    Ok(json_response(Json::Arr(items)))
}

/// `GET /catalogue/models/{vendor}/{model}`: one model's full detail, including
/// every faceplate's ports **already positioned and numbered**
/// (`Faceplate::ports`), so the browser does not recompute the odd/even, 12-port
/// or uplink-right rules.
async fn catalogue_model_handler(
    State(state): State<DesignApiState>,
    PathExtractor((vendor, model)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (_, tx) = signed.verify_and_commit(&state, tx).await?;
    tx.commit().await.map_err(SessionError::Db)?;

    match state
        .catalogue
        .iter()
        .find(|m| m.vendor == vendor && m.model == model)
    {
        Some(m) => Ok(json_response(json_of_model(m))),
        None => Ok((StatusCode::NOT_FOUND, "no such model\n").into_response()),
    }
}

fn json_of_model(m: &Model) -> Json {
    let mut map = BTreeMap::new();
    map.insert("vendor".to_string(), Json::Str(m.vendor.clone()));
    map.insert("model".to_string(), Json::Str(m.model.clone()));
    map.insert("rack_units".to_string(), Json::Int(i64::from(m.rack_units)));
    map.insert("reviewed_by".to_string(), Json::Str(m.reviewed_by.clone()));

    let mut source = BTreeMap::new();
    source.insert("cite".to_string(), Json::Str(m.source.cite.clone()));
    source.insert("read_on".to_string(), Json::Str(m.source.read_on.clone()));
    map.insert("source".to_string(), Json::Obj(source));

    map.insert(
        "psu_slots".to_string(),
        Json::Arr(m.psu_slots.iter().map(json_of_psu_slot).collect()),
    );

    map.insert(
        "faceplates".to_string(),
        Json::Arr(m.faceplates.iter().map(json_of_faceplate).collect()),
    );

    Json::Obj(map)
}

/// ADR-0050 §3/§4: a PSU bay is a positioned entry on a face, not a count (see
/// `fathom_corpus::catalogue::PsuSlot`).
fn json_of_psu_slot(s: &PsuSlot) -> Json {
    let mut map = BTreeMap::new();
    map.insert("name".to_string(), Json::Str(s.name.clone()));
    map.insert("hot_swap".to_string(), Json::Bool(s.hot_swap));
    map.insert(
        "face".to_string(),
        Json::Str(json_of_face(s.face).to_string()),
    );
    let mut position = BTreeMap::new();
    position.insert(
        "row".to_string(),
        Json::Str(json_of_row(s.position.row).to_string()),
    );
    position.insert(
        "column".to_string(),
        Json::Int(i64::from(s.position.column)),
    );
    map.insert("position".to_string(), Json::Obj(position));
    Json::Obj(map)
}

fn json_of_face(f: Face) -> &'static str {
    match f {
        Face::Front => "front",
        Face::Rear => "rear",
    }
}

fn json_of_row(r: Row) -> &'static str {
    match r {
        Row::Top => "top",
        Row::Bottom => "bottom",
        Row::Single => "single",
    }
}

fn json_of_role(r: Role) -> &'static str {
    match r {
        Role::Access => "access",
        Role::Uplink => "uplink",
        Role::Management => "management",
        Role::Console => "console",
    }
}

fn json_of_faceplate(f: &fathom_corpus::catalogue::Faceplate) -> Json {
    let mut map = BTreeMap::new();
    map.insert(
        "face".to_string(),
        Json::Str(json_of_face(f.face).to_string()),
    );
    map.insert("port_count".to_string(), Json::Int(i64::from(f.port_count)));
    map.insert(
        "ports".to_string(),
        Json::Arr(f.ports().iter().map(json_of_port).collect()),
    );
    Json::Obj(map)
}

/// `number` and `name` are the mirror-image pair `Port` carries (ADR-0050 §5): a
/// numbered port sends `number` and `name: null`; a named port (`me0`, `con`)
/// sends `number: null` and `name`. `uplink` stays beside the fuller `role` (see
/// `Port::uplink`).
fn json_of_port(p: &Port) -> Json {
    let mut map = BTreeMap::new();
    map.insert("kind".to_string(), Json::Str(p.kind.token().to_string()));
    map.insert(
        "number".to_string(),
        p.number.map_or(Json::Null, |n| Json::Int(i64::from(n))),
    );
    map.insert(
        "name".to_string(),
        p.name.clone().map_or(Json::Null, Json::Str),
    );
    map.insert("uplink".to_string(), Json::Bool(p.uplink));
    map.insert(
        "role".to_string(),
        Json::Str(json_of_role(p.role).to_string()),
    );
    map.insert("row".to_string(), Json::Str(json_of_row(p.row).to_string()));
    map.insert("column".to_string(), Json::Int(i64::from(p.column)));
    map.insert(
        "group_gap_before".to_string(),
        Json::Bool(p.group_gap_before),
    );
    Json::Obj(map)
}

// ---- Custom-field definitions (ADR-0062) ----
//
// Bodies are canonical JSON (sorted keys, no whitespace, one trailing LF).

/// Verify the session, open the tenant context and the organisation content key.
async fn begin_org<'a>(
    state: &DesignApiState,
    signed: &Signed,
    client: &'a mut deadpool_postgres::Client,
    organisation: &str,
) -> Result<(Transaction<'a>, TenantContext, crate::keys::DataKey), RouteError> {
    let tenant = parse_organisation(organisation)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let (session, tx) = signed.verify_and_commit(state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = crate::keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(SessionError::Keys)?;
    Ok((tx, ctx, tenant_key))
}

/// The body as an object whose keys are all among `allowed`.
fn object_body(body: &[u8], allowed: &[&str]) -> Result<BTreeMap<String, Json>, SessionError> {
    match Json::parse_canonical(body) {
        Ok(Json::Obj(m)) if m.keys().all(|k| allowed.contains(&k.as_str())) => Ok(m),
        _ => Err(SessionError::Malformed("request body")),
    }
}

fn str_field(m: &mut BTreeMap<String, Json>, key: &str) -> Result<Option<String>, SessionError> {
    match m.remove(key) {
        None => Ok(None),
        Some(Json::Str(s)) => Ok(Some(s)),
        Some(_) => Err(SessionError::Malformed("request body")),
    }
}

fn choices_field(m: &mut BTreeMap<String, Json>) -> Result<Option<Vec<String>>, SessionError> {
    match m.remove("choices") {
        None => Ok(None),
        Some(Json::Arr(items)) => items
            .into_iter()
            .map(|j| match j {
                Json::Str(s) => Ok(s),
                _ => Err(SessionError::Malformed("request body")),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(_) => Err(SessionError::Malformed("request body")),
    }
}

fn if_version_field(m: &mut BTreeMap<String, Json>) -> Result<i64, SessionError> {
    match m.remove("ifVersion") {
        Some(Json::Int(v)) if v >= 1 => Ok(v),
        _ => Err(SessionError::Malformed("request body")),
    }
}

fn parse_definition_id(text: &str) -> Result<String, SessionError> {
    fathom_id::Ulid::decode(text)
        .map(|u| u.to_string())
        .map_err(|_| SessionError::Malformed("field definition id"))
}

/// `GET /organisations/{o}/field-definitions`: every definition, archived ones
/// flagged. Any member.
async fn list_field_definitions_handler(
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
    let defs = field_defs::list(&tx, &auth).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(Json::Arr(
        defs.iter()
            .map(field_defs::FieldDefinition::to_json)
            .collect(),
    )))
}

/// `POST /organisations/{o}/field-definitions`: body `{kind, name, type, choices?}`.
/// Needs `draw` somewhere in the organisation.
async fn create_field_definition_handler(
    State(state): State<DesignApiState>,
    PathExtractor(organisation): PathExtractor<String>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let mut m = object_body(&signed.body, &["kind", "name", "type", "choices"])?;
    let kind = str_field(&mut m, "kind")?.ok_or(SessionError::Malformed("request body"))?;
    let name = str_field(&mut m, "name")?.ok_or(SessionError::Malformed("request body"))?;
    let ty = str_field(&mut m, "type")?.ok_or(SessionError::Malformed("request body"))?;
    let choices = choices_field(&mut m)?.unwrap_or_default();

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
    let def = field_defs::create(&tx, &auth, &kind, &name, &ty, &choices).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(def.to_json()))
}

/// `PATCH /organisations/{o}/field-definitions/{id}`: body `{name?, choices?,
/// ifVersion}`. The creator or an organisation admin.
async fn update_field_definition_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, definition)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let id = parse_definition_id(&definition)?;
    let mut m = object_body(&signed.body, &["name", "choices", "ifVersion"])?;
    let if_version = if_version_field(&mut m)?;
    let name = str_field(&mut m, "name")?;
    let choices = choices_field(&mut m)?;

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
    let def = field_defs::update(
        &tx,
        &auth,
        &id,
        if_version,
        name.as_deref(),
        choices.as_deref(),
    )
    .await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(def.to_json()))
}

/// `POST /organisations/{o}/field-definitions/{id}/archive`: body `{ifVersion}`.
/// The creator or an organisation admin.
async fn archive_field_definition_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, definition)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let id = parse_definition_id(&definition)?;
    let mut m = object_body(&signed.body, &["ifVersion"])?;
    let if_version = if_version_field(&mut m)?;

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
    let def = field_defs::archive(&tx, &auth, &id, if_version).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(def.to_json()))
}

// ---- Cable corrections from the floor ----

/// `GET /organisations/{o}/designs/{d}/corrections`: a `draw` caller sees every open correction
/// on the design, a `read` caller only their own. See [`corrections::list`].
async fn list_corrections_handler(
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
    let found = corrections::list(&tx, &auth, design_id).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(Json::Arr(
        found.iter().map(corrections::Correction::to_json).collect(),
    )))
}

/// `POST /organisations/{o}/designs/{d}/corrections`: body `{cable, kind, text?}`. Needs `read`
/// on the design's place; see [`corrections::create`].
async fn create_correction_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let design_id = parse_design(&design)?;
    let mut m = object_body(&signed.body, &["cable", "kind", "text"])?;
    let cable = str_field(&mut m, "cable")?.ok_or(SessionError::Malformed("request body"))?;
    let kind = str_field(&mut m, "kind")?.ok_or(SessionError::Malformed("request body"))?;
    let text = str_field(&mut m, "text")?.unwrap_or_default();

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
    let made = corrections::create(&tx, &auth, design_id, &cable, &kind, &text).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(made.to_json()))
}

async fn decide_correction(
    state: DesignApiState,
    path: (String, String, String),
    signed: Signed,
    verb: corrections::Verb,
) -> Result<Response, RouteError> {
    let (organisation, design, correction) = path;
    let design_id = parse_design(&design)?;
    let id = fathom_id::Ulid::decode(&correction)
        .map(|u| u.to_string())
        .map_err(|_| SessionError::Malformed("correction id"))?;
    let mut m = object_body(&signed.body, &["ifVersion"])?;
    let if_version = if_version_field(&mut m)?;

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
    let done = corrections::decide(&tx, &auth, design_id, &id, if_version, verb).await?;
    tx.commit().await.map_err(SessionError::Db)?;
    Ok(json_response(done.to_json()))
}

/// `POST .../corrections/{id}/accept`: body `{ifVersion}`. Needs `draw`.
async fn accept_correction_handler(
    State(state): State<DesignApiState>,
    PathExtractor(path): PathExtractor<(String, String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    decide_correction(state, path, signed, corrections::Verb::Accept).await
}

/// `POST .../corrections/{id}/dismiss`: body `{ifVersion}`. Needs `draw`.
async fn dismiss_correction_handler(
    State(state): State<DesignApiState>,
    PathExtractor(path): PathExtractor<(String, String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    decide_correction(state, path, signed, corrections::Verb::Dismiss).await
}

/// `POST .../corrections/{id}/reopen`: body `{ifVersion}`. Needs `draw`. An ACCEPTED correction
/// goes back to open (the edit it was accepted for failed); a dismissed one cannot, because its
/// text was scrubbed when it was dismissed.
async fn reopen_correction_handler(
    State(state): State<DesignApiState>,
    PathExtractor(path): PathExtractor<(String, String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    decide_correction(state, path, signed, corrections::Verb::Reopen).await
}

// ---- Response framing ----

/// `Cache-Control: no-store` on all of them, per `api::bytes_response`. Nothing
/// here is a document: it is one caller's answer under one caller's authority,
/// and a shared cache would hold it stale or offer it to the next caller.
fn json_response(j: Json) -> Response {
    (
        StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        j.to_canonical_bytes(),
    )
        .into_response()
}

// ---- Tests that need no database: the rendering rules ----

#[cfg(test)]
mod tests {
    use super::*;

    fn json_text(j: &Json) -> String {
        String::from_utf8(j.to_canonical_bytes()).expect("canonical JSON is UTF-8")
    }

    /// §11.2's three outcomes, named: not a boolean, not collapsed together.
    #[test]
    fn verify_reports_each_of_storage_designs_11_2_three_outcomes_by_name() {
        let verified = chain::Report {
            outcome: chain::Outcome::Verified { entries: 4 },
            depth: chain::Depth::Links,
            content: chain::ContentState::NotRebound,
            coverage: None,
        };
        let text = json_text(&json_of_report(&verified));
        assert!(text.contains("\"outcome\":\"verified\""), "{text}");
        assert!(text.contains("\"entries\":4"), "{text}");

        let broken = chain::Report {
            outcome: chain::Outcome::BrokenAt {
                seq: 2,
                reason: chain::BreakReason::SealDoesNotRecompute,
                verified_before: 1,
                metadata: chain::EntryMetadata::None,
                entry_type: Some(chain::StoredEntryType::Known(chain::EntryType::Update)),
                chain_key_epoch: Some(1),
                design_version: Some(2),
            },
            depth: chain::Depth::Links,
            content: chain::ContentState::NotRebound,
            coverage: None,
        };
        let text = json_text(&json_of_report(&broken));
        assert!(text.contains("\"outcome\":\"broken_at\""), "{text}");
        assert!(text.contains("\"seq\":2"), "{text}");
        assert!(text.contains("\"verified_before\":1"), "{text}");

        let gap = chain::Report {
            outcome: chain::Outcome::CannotVerifyUnderKeyEpoch {
                epochs: vec![7],
                ranges: vec![(3, 5)],
                verified_before: 2,
            },
            depth: chain::Depth::Links,
            content: chain::ContentState::NotRebound,
            coverage: None,
        };
        let text = json_text(&json_of_report(&gap));
        assert!(
            text.contains("\"outcome\":\"cannot_verify_under_key_epoch\""),
            "{text}"
        );
        assert!(text.contains("\"epochs\":[7]"), "{text}");

        // The three outcomes must not read alike.
        assert_ne!(
            json_text(&json_of_report(&verified)),
            json_text(&json_of_report(&broken))
        );
        assert_ne!(
            json_text(&json_of_report(&broken)),
            json_text(&json_of_report(&gap))
        );
    }

    /// A save past the audit spool's bound must surface as itself, not a generic
    /// failure: a different status and a body saying what still works, never the
    /// `500 refused` a corrupt row gets.
    #[tokio::test]
    async fn the_audit_spool_bound_surfaces_as_itself_not_as_a_generic_failure() {
        let spool_response = design_error_response(DesignError::AuditSpoolBeyondBounds {
            bound: crate::audit::Bound::Size,
            oldest_seconds: 120,
            entries: 4,
            bytes: 4096,
        });
        let spool_status = spool_response.status();
        assert_eq!(spool_status, StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(spool_response.into_body(), usize::MAX)
            .await
            .expect("a body");
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("NOT saved"), "{text}");
        assert!(text.contains("nothing has been lost"), "{text}");

        let generic_response = design_error_response(DesignError::Corrupt("a stored row"));
        assert_eq!(generic_response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        assert_ne!(
            spool_status,
            generic_response.status(),
            "the typed error must not collapse into the generic one"
        );
    }
}
