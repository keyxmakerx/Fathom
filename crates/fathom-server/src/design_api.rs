//! The drawing surface's HTTP endpoints: list, open, save, history and verify
//! for a design, plus read-only access to the equipment catalogue.
//!
//! `docs/PHASE-2-STORAGE-DESIGN.md` §11.2 (verify's three outcomes), §7
//! (tenant isolation, both layers), `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`
//! §3.4 (`authorise_account`'s seven steps) and §9 (the audit spool's degrade
//! table). `src/api.rs` is the pattern this follows; `src/sessions.rs`,
//! `src/designs.rs` and `src/grants.rs` hold the rules this translates into
//! routes.
//!
//! # Its own state, its own router, by design
//!
//! Two builders are adding routes to this server at once (the admin console,
//! in its own module). `api::router` is not touched here, and this module
//! does not share [`api::ApiState`] either — [`DesignApiState`] is its own
//! type, with its own [`Signed`] extractor that verifies against it, so
//! nothing here can collide with what the other module names. The caller that
//! wires both into the running server (`src/main.rs`) is unaffected by
//! either's internals; see [`DesignApiState`]'s own doc for exactly what it
//! needs constructed and handed in.
//!
//! # One transaction for verification, authorisation and the act itself
//!
//! `api.rs`'s `Signed` changed shape on 2026-09-14 (`0014`, finding 8) so that
//! a per-request signature and the authorisation that follows it share one
//! database snapshot rather than two. This module's own [`Signed`] is a
//! second implementation of the same shape for a second state type — not a
//! shortcut back to the old one.
//!
//! **This used to stop at authorisation, and that was the bug.**
//! [`save_design_handler`], [`open_design_handler`] and
//! [`verify_design_handler`] each opened exactly one transaction, called
//! [`Signed::verify`] and authorised in it — then *committed*, and asked
//! `designs.rs` to perform the write, the read or the verification in a
//! **second**, entirely separate transaction, opened fresh off the pool. That
//! second transaction re-opened a tenant context (membership only) but never
//! asked `grants::authorise_account` anything at all, so a grant revoked in
//! the gap between the two transactions changed nothing: the act still ran
//! on the capability the first transaction had already forgotten about.
//!
//! Every handler that acts on a design now opens exactly one transaction,
//! calls [`Signed::verify`] in it, and hands that same transaction and the
//! [`Authority`] it built straight to [`designs::write_version_in_tx`],
//! [`designs::read_version_in_tx`], [`designs::verify_design_in_tx`] or
//! [`designs::create_design_with_first_version_in_tx`] — each of which
//! re-checks the grant itself, immediately before doing anything to
//! `design_payload` or `chain_entries`, in that same transaction. Only after
//! the act has actually happened does the handler commit. A grant revoked
//! after the check this module used to make and before the act designs.rs
//! used to perform can no longer slip through, because there is no longer a
//! gap between the two for it to slip through in — see `tests/design_api.rs`
//! for the case this is written against.
//!
//! # Why a design the caller cannot see is absent, not forbidden
//!
//! [`list_designs_handler`] filters every row in `designs` through
//! `grants::authorise_account` before it is ever put in the answer. A design
//! the account holds no capability for is left out of the list entirely,
//! never returned with a `403`-flavoured entry — the second would tell an
//! account exactly how many designs in a scope it cannot see exist.
//!
//! The same property holds for one design named directly: [`authorise_on_design`]
//! runs the capability check against the design's own scope when the design
//! exists, and against the *organisation's* scope (`None`) when it does not —
//! so a caller who lacks the capability either way gets the identical
//! [`grants::AuthorityError::NotAuthorised`] refusal, and cannot use the
//! response to learn which of the two was true. Only a caller who clears that
//! check goes on to ask `designs.rs` for the row, where a genuinely missing
//! design answers `DesignError::NoSuchDesign` — which is safe to disclose at
//! that point, because clearing the check already proved the caller has some
//! standing in this organisation.
//!
//! # The wire format: canonical JSON for documents, raw bytes for the payload
//!
//! `api.rs`'s bodies are length-prefixed byte fields because they carry keys,
//! nonces and signatures — byte strings, not documents — and because adding
//! `axum`'s `json` feature would drag `serde` into the closure for no reason
//! at all at that layer. The routes here are different in kind: a design
//! list, a history and a verification report are genuinely structured
//! documents with named fields, and inventing a bespoke byte framing for each
//! shape would spend far more review time than it saves dependencies.
//! `fathom-canon` is already a dependency of this crate (`designs.rs` uses it
//! for the bytes a chain seal covers) and gives deterministic, canonical
//! JSON with no `serde` anywhere in the closure — so every structured
//! response here is one `fathom_canon::Json` value, rendered with
//! `to_canonical_bytes` and served as `application/json`. **The documents
//! this repository was handed are silent on a response format for these
//! routes; this is a decision, not a discovery, and is recorded here because
//! nowhere else names it.**
//!
//! The one exception is a design's own payload: [`open_design_handler`]
//! serves it as `application/octet-stream`, verbatim, with the version and
//! schema version in headers rather than wrapped in a JSON envelope. §3 of
//! the storage design already settled "whole payload, not per field" for
//! encryption; wrapping the decrypted bytes in a second, server-invented
//! envelope on the way back out would just be re-parsing cost for the
//! browser, which already knows how to read the bytes it saved.
//!
//! # The body size limit is this module's own -- and it is per route, not
//! # per module
//!
//! `api::MAX_SIGNED_BODY` is one mebibyte, and its own doc says a design
//! payload route raises the limit deliberately, in its own commit, with its
//! own number. This module's [`Signed`] does exactly that, but **only for
//! the two routes that can legitimately carry a large body**: a save and a
//! create, matched on method and path alone by [`is_large_body_route`],
//! before any header is trusted or any byte of the body is read. Every
//! other route -- a list, an open, history, verify, the catalogue, and any
//! `GET` -- reads at `api::MAX_SIGNED_BODY`'s one mebibyte, same as
//! `api.rs`'s own routes.
//!
//! This was not always so: this module used to read every request at
//! [`designs::MAX_PAYLOAD_BYTES`] plus four (64 MiB), unconditionally,
//! *before* `begin_request` ever ran -- so a caller who never held a valid
//! session, with headers of the right shape but invented values, could make
//! this process buffer 64 MiB on a plain `GET`. `begin_request` is where the
//! nonce is spent and the signature checked; nothing before it is a
//! credential check. [`is_large_body_route`]'s own doc has the rest.
//!
//! **This narrows the surface; it does not close it.** The two routes
//! `is_large_body_route` names are matched on method and path alone, with no
//! reference to authority at all, so a caller who has never held a session
//! -- headers of the right *shape*, values free to invent -- still makes
//! this process buffer up to 64 MiB on `POST .../versions` or `POST
//! .../scopes/{scope}/designs`, deliberately: the signature that would
//! prove authority covers a digest of the whole body, so it cannot be
//! checked before the body is read. N concurrent such requests are still N
//! times 64 MiB of heap from callers this server has not authenticated. On
//! `save_design_handler`/`create_design_handler` specifically, this is
//! actually worse than "buffered": [`validate_payload`] parses the body into
//! a full [`Graph`] and runs [`find_credential`] over it BEFORE
//! `signed.verify` ever runs (its own doc gives the reason: a malformed
//! request should cost nothing from the database either way), so an
//! unauthenticated caller also spends this process's CPU on a full parse of
//! up to 64 MiB, not only its heap. Recorded here rather than fixed because
//! closing it needs either a
//! session lookup ahead of the body read (a shape this crate does not have:
//! `begin_request` currently runs after) or putting these two routes behind
//! the source rate-limit bucket `api.rs` already keeps for sign-in --
//! either is a bigger change than this one.
//!
//! # The catalogue sits behind a session, and nowhere else
//!
//! It is public reference data — nothing here is per-tenant — so its routes
//! open no tenant context and run no capability check. They still require a
//! verified [`Signed`] request, exactly like every other route in this
//! module, per the brief: *"it still sits behind a session like everything
//! else."*
//!
//! [`load_catalogue`] reads `<root>/corpus/catalogue/<vendor>/*.yaml` for
//! every vendor directory it finds, which needs `<root>/schema` alongside it
//! (`fathom_corpus::catalogue::Catalogue::load_platform`'s own requirement).
//! **This module does not read that path itself at startup** — `main.rs` is
//! the lead's to wire, per the router rule this task was given — so whatever
//! calls [`load_catalogue`] to build a [`DesignApiState`] must supply that
//! root, e.g. the same directory `config.schema_root`'s parent names today.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequest, Path as PathExtractor, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
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
use crate::crypto;
use crate::designs::{self, DesignError};
use crate::grants::{self, Authority, EpochWatch};
use crate::keys::KeyRing;
use crate::repo::{self, DesignId, OrganisationId, ScopeId, TenantContext};
use crate::sessions::{
    self, PendingRequest, SessionError, SessionStore, SignedRequest, VerifiedSession,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// Everything this module's routes need. Deliberately not [`api::ApiState`]:
/// see the module doc's "its own state" section.
#[derive(Clone)]
pub struct DesignApiState {
    pub sessions: Arc<SessionStore>,
    pub watch: Arc<EpochWatch>,
    pub ring: Arc<KeyRing>,
    /// The catalogue, loaded once at startup — it is read-only reference
    /// data, and every request reads the same `Vec` rather than the
    /// filesystem. Built by [`load_catalogue`].
    pub catalogue: Arc<Vec<Model>>,
}

/// Read every vendor directory under `<root>/corpus/catalogue/` into one flat
/// list of models. `root` must also have a `schema/` directory beside
/// `corpus/`, because `Catalogue::load_platform` checks every model's vendor
/// token against the schema tree's own declared vendor list.
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

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/// This module's routes, ready to `merge` into the main router. See the
/// module doc: nothing here is added to `api::router`.
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
            "/organisations/{organisation}/designs/{design}",
            get(open_design_handler),
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
        .route("/catalogue/models", get(catalogue_list_handler))
        .route(
            "/catalogue/models/{vendor}/{model}",
            get(catalogue_model_handler),
        )
        .with_state(state)
}

// ---------------------------------------------------------------------------
// The extractor this module's routes compose — `api::Signed`'s pattern,
// against `DesignApiState` rather than `api::ApiState`.
// ---------------------------------------------------------------------------

/// A request that has spent its single-use nonce and is waiting to be
/// verified inside the handler's own transaction. See `api::Signed`'s doc for
/// the reasoning in full; this is that shape, once more, for this module's
/// state type.
pub struct Signed {
    pending: PendingRequest,
    body: Bytes,
    /// The raw query string, if any — captured here because `Signed`
    /// consumes the whole `Request`, so a handler that also wants a query
    /// parameter has nowhere else to read it from once this has run.
    query: Option<String>,
}

impl Signed {
    /// Run the rest of §4.1 clause (b) inside `tx`, so that whatever the
    /// handler authorises next sees the same snapshot the session was
    /// verified against.
    async fn verify(
        &self,
        state: &DesignApiState,
        tx: &Transaction<'_>,
    ) -> Result<VerifiedSession, SessionError> {
        state.sessions.verify_pending(tx, &self.pending).await
    }

    /// One query parameter, unescaped. Every value this module reads off a
    /// query string is a bare integer or `true`/`1`, so there is nothing here
    /// that needs percent-decoding.
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

/// Design payloads run up to [`designs::MAX_PAYLOAD_BYTES`] (64 MiB); this
/// is *not* the cap every route in this module reads at -- see
/// [`is_large_body_route`] and the module doc's "body size limit" section.
pub const MAX_SIGNED_BODY: usize = designs::MAX_PAYLOAD_BYTES + 4;

/// True for exactly the two `POST` routes a legitimate body may run to
/// [`MAX_SIGNED_BODY`]'s 64 MiB: a save (`.../designs/{design}/versions`)
/// and a create (`.../scopes/{scope}/designs`). Every other route this
/// module serves -- `list_designs_handler`, `list_scopes_handler`,
/// `create_scope_handler`, `open_design_handler`, `history_handler`,
/// `verify_design_handler`, the catalogue routes, and any GET, which never
/// carries a legitimate body at all -- reads at `api::MAX_SIGNED_BODY`
/// (one mebibyte) instead.
///
/// This has to be decided from the method and path alone, before the body
/// is read at all: the credential this body would belong to is not checked
/// until `begin_request` runs, *after* the read below, because the
/// signature covers a digest of the whole body and cannot be verified
/// without it (see `api::MAX_SIGNED_BODY`'s own doc). Before this function
/// existed, every route in this module read at the 64 MiB cap regardless,
/// so a caller who never held a valid session -- headers of the right
/// shape are free to invent -- could make this process buffer 64 MiB on a
/// plain `GET /organisations/{o}/designs`, once per request, before
/// `begin_request` ever ran. Matched on the path's shape only, never on the
/// ids inside it: this decides how many bytes `to_bytes` may buffer, never
/// anything about the request's authority.
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

        // As `api::Signed`: a missing or unreadable header is `NotSigned`,
        // never `Malformed`, so a caller who presented nothing is told to
        // authenticate and a caller who presented rubbish learns nothing
        // about which part of it was wrong.
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

        // The finding this fixes: read at the small cap unless the method
        // and path alone -- known before any of the header bytes above are
        // trusted -- name one of the two routes a real payload can be large
        // on. See [`is_large_body_route`].
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Either half of what a route here can refuse with, carried as the error
/// type every handler's `?` converges on.
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
            // Reuses `api::Refusal`'s existing, tested mapping from
            // `SessionError` to a status and a fixed sentence, rather than a
            // second copy of the same match.
            Self::Session(e) => api::Refusal::from(e).into_response(),
            Self::Design(e) => design_error_response(e),
        }
    }
}

/// `DesignError` surfaced as itself — in particular
/// [`DesignError::AuditSpoolBeyondBounds`], which must read as the
/// operational condition it is rather than as a generic failure (the brief's
/// own words).
fn design_error_response(e: DesignError) -> Response {
    match &e {
        DesignError::NoSuchDesign | DesignError::NoSuchVersion | DesignError::NoSuchScope => {
            (StatusCode::NOT_FOUND, "no such design\n").into_response()
        }
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
        // ADR-0049 #2 and #4: a distinct, non-500 status naming the
        // plain-face error, never a generic failure -- the payload is the
        // caller's own bytes, not a storage fault.
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
        // ADR-0054 #1: the save precondition. The header names the version
        // this design is actually on now, so a client that wants to reload
        // and reapply does not have to make a second round trip to learn it.
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
        // This session's brief, item 4: the client gates before sending, so a
        // hit here means an old or hostile client, not a real capture or
        // note -- refused before the write, never stored.
        DesignError::CredentialInPayload { kind, line } => (
            StatusCode::UNPROCESSABLE_ENTITY,
            format!(
                "that payload's {kind} text still carries something that looks like a \
                 credential, at line {line}; refused before it reaches storage. The client \
                 redacts before sending, so this usually means an old or hostile client.\n"
            ),
        )
            .into_response(),
        // ADR-0054 #5: the re-check immediately before the act. Answered
        // exactly as `api::Refusal` answers the same `AuthorityError`
        // elsewhere in this crate -- see that mapping's own comment for why
        // `NotAuthorised`/`QuorumNotMet` are a permission answer and
        // everything else here is an integrity alarm.
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

/// [`DesignError::Authority`]'s mapping -- the same status and sentence
/// `api::Refusal` gives `SessionError::Authority(_)`, kept as its own
/// function because that impl matches on an owned `SessionError` and this
/// site only ever holds a borrowed `AuthorityError` (`design_error_response`
/// matches `&e`, and `AuthorityError` carries a `tokio_postgres::Error` that
/// is not `Clone`, so there is no owned value to hand the other mapping).
fn authority_refusal_response(e: &grants::AuthorityError) -> Response {
    match e {
        grants::AuthorityError::NotAuthorised | grants::AuthorityError::QuorumNotMet { .. } => {
            tracing::info!(reason = %e, "not authorised");
            (StatusCode::FORBIDDEN, "not authorised\n").into_response()
        }
        _ => {
            tracing::error!(reason = %e, "integrity check failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "refused\n").into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// Authorisation, shared by open/save/history/verify
// ---------------------------------------------------------------------------

/// Verify tenant membership, then authorise `needed` on the design's own
/// scope — all against `tx`, the one transaction the handler will also
/// commit its bookkeeping in.
///
/// See the module doc's "absent, not forbidden" section: when the design does
/// not exist, this checks the ORGANISATION's own scope (`None`) instead of
/// refusing outright, so a caller who fails either check gets the identical
/// [`grants::AuthorityError::NotAuthorised`] refusal and cannot use it to
/// learn which design ids are real.
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

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------

/// `GET /organisations` — every organisation the signed-in account belongs
/// to. The client's Home screen needs this before it can name a tenant in
/// any of the routes below it, so it lives here rather than in `api.rs`:
/// this module already owns the [`Signed`] extractor for non-admin session
/// routes (see the module doc's "its own state" section), and that is the
/// extractor this route needs too.
///
/// **Deliberately does not call [`sessions::open_tenant_context`].** That
/// bridge pins one tenant for the rest of a request; this route answers
/// "which tenants" *before* any tenant is known, so there is nothing yet to
/// pin. It authorises instead through
/// [`repo::list_organisations_for_account_in`], the transaction half of
/// `repo::list_organisations_for_account` -- the query the `organisations`
/// and `memberships` RLS policies' `account_id` branch exists for. That
/// function sets `app.account_id` and nothing else, so it reads exactly the
/// rows RLS lets an account see about itself, no more.
///
/// An operator session is refused with the same
/// [`SessionError::NotATenantPrincipal`] `sessions::open_tenant_context`
/// uses for the same reason: an operator principal is unrepresentable in a
/// membership at every privilege level (`0004`), so it belongs to no
/// organisation this route could ever answer with.
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

    let session = signed.verify(&state, &tx).await?;
    // `sessions::account_without_tenant` is the named bridge for a route with
    // no tenant to open; it refuses an operator session itself. Parsing
    // `principal_id()` back into an `AccountId` here instead would be the
    // bypass that function's doc comment exists to prevent.
    let account = sessions::account_without_tenant(&session)?;

    let organisations = repo::list_organisations_for_account_in(&tx, account)
        .await
        .map_err(SessionError::from)?;

    tx.commit().await.map_err(SessionError::Db)?;

    let out = organisations
        .into_iter()
        .map(|o| {
            let mut map = BTreeMap::new();
            map.insert("organisation_id".to_string(), Json::Str(o.id.to_string()));
            map.insert("display_name".to_string(), Json::Str(o.display_name));
            Json::Obj(map)
        })
        .collect();

    Ok(json_response(Json::Arr(out)))
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/// `GET /organisations/{organisation}/designs` — every design in scope the
/// caller holds at least `read` on. See the module doc: a design with no
/// capability is left out, never listed as forbidden.
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

    let session = signed.verify(&state, &tx).await?;
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

    // §3.4 steps 2-5, once for this whole list, not once per row: see
    // `grants::VerifiedAuthorityState`'s doc. Each row below only runs step
    // 1's ancestors and step 6's candidate match against this one snapshot.
    let verified = grants::verify_authority_state(&tx, &auth)
        .await
        .map_err(SessionError::Authority)?;

    let rows = tx
        .query(
            "SELECT d.id, d.scope_id, extract(epoch FROM d.created_at)::bigint, d.created_by, \
                    coalesce(max(p.design_version), 0) \
             FROM designs d \
             LEFT JOIN design_payload p \
               ON p.design_id = d.id AND p.organisation_id = d.organisation_id \
             WHERE d.organisation_id = $1 \
             GROUP BY d.id, d.scope_id, d.created_at, d.created_by \
             ORDER BY d.created_at",
            &[&ctx.tenant().to_string()],
        )
        .await
        .map_err(SessionError::Db)?;

    let mut out = Vec::new();
    for row in rows {
        let id: String = row.get(0);
        let scope_text: String = row.get(1);
        let created_at_unix: i64 = row.get(2);
        let created_by: String = row.get(3);
        let latest_version: i64 = row.get(4);

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

        let mut map = BTreeMap::new();
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

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/// `GET /organisations/{organisation}/scopes` — every scope in the
/// organisation the caller holds at least `read` on, ordered by `path` (root
/// first). Built for D11 (`docs/OPEN-QUESTIONS.md`): a design has no name of
/// its own, so the client names it by its scope, and the shell's path control
/// and tree pop-over need the tree this route serves.
///
/// Filters exactly the way [`list_designs_handler`] does, row by row through
/// `grants::authorise_account`, and for the same reason (module doc, "Why a
/// design the caller cannot see is absent, not forbidden"): a scope the
/// caller holds no capability on is left out of the answer entirely, never
/// returned as a `403`-flavoured entry.
///
/// **The consequence for navigation, spelled out because it is easy to miss:**
/// an ancestor the caller may not read is absent even when one of its
/// descendants is present, because each row is checked on its own scope, not
/// on its whole ancestor chain's readability. A caller holding `read` on one
/// rack but nothing on the building or network above it gets that rack alone
/// — not the rack plus bare-name ancestors to make the path look complete.
/// The client must therefore draw the path from the highest ancestor it was
/// actually given, and the tree pop-over shows only what came back. This is
/// "omit rather than forbid" applied to navigation, and it is deliberate:
/// showing an unreadable ancestor's name, even without its content, would
/// tell an account the name of a scope it holds no capability on, and
/// `docs/OPEN-QUESTIONS.md` B4 has not decided anyone may see that. If a
/// later decision wants ancestor names shown regardless, it changes here, in
/// one place.
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

    let session = signed.verify(&state, &tx).await?;
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

    // §3.4 steps 2-5, once for this whole list, not once per row: see
    // `grants::VerifiedAuthorityState`'s doc, and
    // `list_designs_handler`'s identical comment above.
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

/// `POST /organisations/{organisation}/scopes` — ADR-0054 #3 /
/// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §6.4: **a steward of the parent
/// creates a scope.** The body is two length-prefixed fields, `crypto::lp`'s
/// own framing (the shape `api.rs`'s session routes already use for a
/// request with more than one field): the parent scope id, empty for a new
/// root network, then the display name.
///
/// The child's *kind* is not on the wire at all -- it is the one kind that
/// fits directly under the named parent (network under nothing, building
/// under a network, rack under a building; [`child_kind_under`]), because the
/// scope hierarchy is exactly three fixed levels deep and a client asking to
/// create "the next thing under this scope" has nothing else it could mean.
///
/// Authorises `steward` on the parent (organisation-wide, `None`, for a new
/// root network -- §6.4's "stewardship inherits down the path, so no new
/// signature") and only then inserts, in the one transaction that
/// authorised it (ADR-0054 #5): a drawer, or a steward of some other
/// subtree, is refused with the same `403` a missing or foreign parent scope
/// gets, because `grants::authorise_account` cannot tell the two apart any
/// more here than it can anywhere else in this module (module doc, "absent,
/// not forbidden").
///
/// Answers with the shape [`list_scopes_handler`]'s own rows have.
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
    let session = signed.verify(&state, &tx).await?;
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

/// The one scope kind that fits directly under a parent of kind
/// `parent_kind` — see [`create_scope_handler`]'s own doc. `None` for `Rack`,
/// which has no child kind at all: the hierarchy is exactly three levels
/// deep (`repo::ScopeKind`'s own doc).
fn child_kind_under(parent_kind: Option<repo::ScopeKind>) -> Option<repo::ScopeKind> {
    match parent_kind {
        None => Some(repo::ScopeKind::Network),
        Some(repo::ScopeKind::Network) => Some(repo::ScopeKind::Building),
        Some(repo::ScopeKind::Building) => Some(repo::ScopeKind::Rack),
        Some(repo::ScopeKind::Rack) => None,
    }
}

// ---------------------------------------------------------------------------
// Create a design
// ---------------------------------------------------------------------------

/// `POST /organisations/{organisation}/scopes/{scope}/designs` — ADR-0054 #2:
/// **draw creates a design.** The body carries a save's own framing
/// (`u32_le(payload_schema_version) ‖ payload_bytes`), validated by
/// [`validate_payload`] -- the same function [`save_design_handler`] uses, so
/// the two cannot drift apart on what counts as a valid payload -- carrying
/// the client's empty document (`client/src/document/model.ts`'s
/// `emptyDocument`, written through `fathom_workspace::write_plain`).
///
/// Authorises `draw` on `scope` (or an ancestor) and creates the design and
/// its first version in the one transaction that authorised it
/// (ADR-0054 #5), through [`designs::create_design_with_first_version_in_tx`]
/// -- a bodiless design (a row in `designs` with no version behind it) is
/// never minted, because the two inserts share this transaction and neither
/// commits without the other.
///
/// A reader is refused with `403`; a foreign or missing scope answers
/// identically, for the reason the module doc's "absent, not forbidden"
/// section gives for a design named directly. A payload that would push the
/// audit spool beyond its bound is refused `503`, with no design row left
/// behind either.
///
/// Answers with the shape [`list_designs_handler`]'s own rows have.
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
    let session = signed.verify(&state, &tx).await?;
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

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/// `GET /organisations/{organisation}/designs/{design}[?version=N]` — the
/// decrypted payload, verbatim, plus its version numbers in headers. Requires
/// at least `read`.
///
/// ADR-0054 #5: opens exactly one transaction, and reads the version inside
/// it -- see [`save_design_handler`]'s own comment on why the capability
/// check now lives inside [`designs::read_version_in_tx`] rather than in a
/// separate call this handler makes and commits before it.
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
    let session = signed.verify(&state, &tx).await?;
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
    Ok((StatusCode::OK, headers, stored.payload).into_response())
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/// `POST /organisations/{organisation}/designs/{design}/versions?base=N` — a
/// new version. Requires `draw`; a `read`-only caller is refused, and the
/// refusal does not distinguish a design that exists from one that does not
/// (module doc).
///
/// # ADR-0054 #1: a save names the version it was based on
///
/// `base` is REQUIRED, in the signed query -- an optional precondition is no
/// precondition (the ADR's own words). Missing or not a plain integer is a
/// `400`, before the session is even verified: like every check
/// [`validate_payload`] already runs, a malformed request costs nothing from
/// the database either way. A present, well-formed `base` that simply
/// disagrees with the design's current version is a different thing
/// entirely -- not malformed, refused -- and is [`designs::write_version_in_tx`]'s
/// job, under the row lock that also decides the next version number, so the
/// two can never disagree with each other.
///
/// Body: `u32_le(payload_schema_version) ‖ payload_bytes` — the schema
/// version fixed at four bytes because everything after it is the payload
/// verbatim, and a length-prefixed field here would mean copying up to 64 MiB
/// twice for no reason. See [`validate_payload`] for everything checked
/// about it before this handler ever opens a transaction.
async fn save_design_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let design_id = parse_design(&design)?;

    let (schema_version, payload) = validate_payload(&signed.body)?;

    // ADR-0054 #1: required, and a signed query parameter -- an optional
    // precondition is no precondition.
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
    let session = signed.verify(&state, &tx).await?;

    // ADR-0054 #5: one transaction. `ctx`, `tenant_key` and `scope` below are
    // exactly what `authorise_on_design` used to compute and check itself in
    // this same transaction before committing it -- the capability check
    // itself now lives in `write_version_in_tx`, immediately before the
    // write it gates, rather than here, a step earlier, with a chance for
    // something to change in between (see the module doc's "one
    // transaction" section for what that chance used to cost).
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

    Ok((StatusCode::OK, format!("{version}\n")).into_response())
}

/// Everything ADR-0049 and this session's brief require of a wire payload
/// before it is written, whether by a save or by a scope's design-creation
/// route (both call this, so the two cannot drift apart on what counts as a
/// valid payload).
///
/// # The server reads every payload back before storing it (ADR-0049 #2)
///
/// `payload` is parsed with [`fathom_workspace::read_plain`] before anything
/// else touches the database. A design payload is a `fathom-plain 1`
/// document by decision, not by convention (ADR-0049 #1) — the one graph
/// format the Rust engine reads — so bytes the engine itself cannot read
/// back are refused at the door rather than stored opaque, unreadable to
/// everything downstream that later opens this design. This runs before the
/// session is even verified, for the same reason [`read_u32_le`] already
/// does: a malformed request costs nothing from the database either way.
///
/// ADR-0049 #4 also requires the wire prefix and the payload's own declared
/// schema version (its line 3) to agree. `read_plain` already refused any
/// payload whose line 3 is not this build's current schema version, so by
/// the time it has returned `Ok`, line 3 is known; [`declared_schema_version`]
/// reads it back out of the same bytes rather than threading a second copy
/// of it out of `fathom_workspace`, which is deliberately bytes-in/bytes-out
/// with no policy of its own (that crate's own module doc). There is no
/// existing numeric form of the schema version (`SCHEMA_VERSION` is the
/// string `"0.N"`; no major bump has happened yet) anywhere in this tree, so
/// [`schema_version_as_u32`] is the one place that defines the wire number:
/// strip the fixed `"0."` and parse the remainder as the minor number.
///
/// # The payload's own text fields, checked once more, at the door
///
/// This session's brief, item 4: the redaction gate runs client-side before a
/// capture or a pasted note ever reaches this server (`fathom-ingest`,
/// compiled for the browser — CLAUDE.md rule 3), so every `Capture.text` and
/// `Note.text` this handler sees ought to have already had a credential shape
/// destroyed at the gate. "Ought to have" is not "did": a hit here means an
/// old client that predates the gate, or a hostile one that skipped it, never
/// a real capture — and either way the write is refused, naming which field
/// kind and which line, before anything is stored. [`find_credential`] calls
/// `fathom_ingest::redact::looks_like_credential_bare` for `Capture.text`,
/// never a second, hand-tuned detector: it is `looks_like_credential` (the
/// gate's own safety-net predicate) plus that crate's own
/// `raw_walk`/`gate_unshaped` bare-adjacency rule, both already used by the
/// ingest gate itself, restated only because this caller has no lexed token
/// list to hand it (see that function's doc). Plain `looks_like_credential`
/// alone requires a `:`/`=` beside a secret word and so misses most real
/// device output, which overwhelmingly writes `keyword <secret>` with a bare
/// space — CLAUDE.md rule 2 names exactly this failure mode, and
/// `fathom-ingest`'s own unit tests pin the space-separated Cisco/Junos
/// forms this must catch. `Note.text` stays on plain `looks_like_credential`
/// — [`find_credential`]'s own doc says why (ADR-0053 §5: a note may be
/// hand-typed prose, not only pasted device output, and bare adjacency's own
/// unit test shows it flags an ordinary sentence like "replaced the key
/// switch"). Both halves are still a hint over unstructured text, not the
/// dictionary-driven bound-statement path, so a keyword the crate's static
/// list does not carry (SNMPv3's `auth`/`priv`) is not caught in either — a
/// residual gap, not claimed closed.
fn validate_payload(body: &[u8]) -> Result<(u32, &[u8]), RouteError> {
    let (schema_version, payload) =
        read_u32_le(body).ok_or(SessionError::Malformed("design payload body"))?;

    // ADR-0049 #2: refuse anything the engine cannot read, before the
    // session is verified or the database is touched. This function is not
    // `async`, so the `Graph` below -- `fathom_graph::Graph` boxes field
    // values as `dyn Any` with no `Send` bound -- is built and fully scanned
    // for a credential shape, then dropped, before this function ever
    // returns; nothing here crosses an `.await` boundary.
    let graph = fathom_workspace::read_plain(payload).map_err(DesignError::InvalidPlainPayload)?;

    // ADR-0049 #4: the wire prefix and the payload's own declared schema
    // version must agree. `read_plain` above already proved line 3 is a
    // well-formed `schema <version>` line, so this only re-reads it.
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

/// This session's brief, item 4: every `Capture.text` and `Note.text` in the
/// plain face, line by line -- so the refusal can name which one, rather than
/// only that the payload as a whole was refused. `Some((kind, line))` on the
/// first hit, in node order within a kind and line order within a node;
/// `None` when nothing in either kind trips the gate's own sketch predicate.
fn find_credential(graph: &Graph) -> Option<(&'static str, usize)> {
    // `Capture` is never hand-typed (its doc: "what the redaction gate let
    // through" -- its node id is the weld's own `CaptureId`, minted only by
    // a parse), so it is always pasted device output and the bare-adjacency
    // check is the right aggression for it. `Note.text` is the one field
    // ADR-0053 §5's own schema doc says may be EITHER pasted (through the
    // same gate) OR hand-typed prose ("Fathom does not redact what you
    // type, only what you paste"), and this handler has no way from the
    // plain-face payload alone to tell which one a given `Note` is -- so it
    // stays on the delimiter-only check, which is prose-safe by
    // construction, rather than risk refusing a real, hand-typed sentence
    // like "replaced the key switch" (`looks_like_credential_bare`'s own
    // unit test on that exact sentence). A credential a hostile client
    // typed into a `Note` with no delimiter is the residual this leaves.
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

/// The 1-based line within one field's text that first looks like a
/// credential, run per line rather than over the whole field: a multi-line
/// `Capture.text` is a whole configuration file, and naming the line is what
/// this session's brief asks for. `bare` selects
/// `looks_like_credential_bare` over plain `looks_like_credential` -- see
/// [`find_credential`]'s doc for which caller passes which and why.
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

/// Line 3 of a `fathom-plain` payload, read back out of the raw bytes rather
/// than threaded out of `fathom_workspace::read_plain` — that crate is
/// deliberately bytes-in/bytes-out with no policy of its own (its own module
/// doc), and this is only ever called after `read_plain` has already
/// accepted the same bytes, so line 3 is guaranteed well-formed
/// (`schema <version>`) here. `None` only if that guarantee is broken.
fn declared_schema_version(payload: &[u8]) -> Option<&str> {
    payload
        .split(|&b| b == b'\n')
        .nth(2)
        .and_then(|line| core::str::from_utf8(line).ok())
        .and_then(|line| line.strip_prefix("schema "))
}

/// ADR-0049 #4's wire number for `SCHEMA_VERSION` (`fathom-ir`'s generated
/// `"0.N"` string). No numeric form of it exists anywhere else in this tree
/// to compare the four-byte prefix against, so this defines the one used on
/// the wire: strip the fixed `"0."` — no major bump has happened yet
/// (`schema/schema.yaml`'s own comment on the baseline) — and parse the
/// remainder as the minor number. Any other shape (in particular a future
/// major bump) returns `None`, which is an unconditional refusal until
/// someone decides what the wire form of a 1.x schema version is.
fn schema_version_as_u32(declared: &str) -> Option<u32> {
    declared
        .strip_prefix("0.")
        .and_then(|minor| minor.parse().ok())
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/// `GET /organisations/{organisation}/designs/{design}/history` — every chain
/// entry for this design, in order. Requires at least `read`. A design chain
/// stores its metadata in the clear (§7.3), so this needs no key beyond the
/// tenant context already open in `tx`.
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
    let session = signed.verify(&state, &tx).await?;
    let ctx =
        authorise_on_design(&tx, &state, &session, tenant, design_id, Capability::Read).await?;

    // `authorise_on_design` alone does not say the design exists (see its own
    // doc) — a caller with an organisation-wide grant clears it even for an
    // id nothing was ever created under.
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

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/// `GET /organisations/{organisation}/designs/{design}/verify[?deep=true]` —
/// storage design §11.2's three outcomes, by name: `verified`, `broken_at`,
/// `cannot_verify_under_key_epoch`. Requires at least `read`. ADR-0054 #5:
/// one transaction, see [`open_design_handler`]'s own comment.
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
    let session = signed.verify(&state, &tx).await?;
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

/// §11.2's three outcomes, by their names, never as a boolean — see the
/// module doc.
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

// ---------------------------------------------------------------------------
// Catalogue — public reference data, behind a session and nothing else
// ---------------------------------------------------------------------------

/// `GET /catalogue/models` — every model this deployment's corpus carries,
/// enough to populate a picker.
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
    signed.verify(&state, &tx).await?;
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

/// `GET /catalogue/models/{vendor}/{model}` — one model's full detail,
/// including every faceplate's ports **already positioned and numbered**
/// (`Faceplate::ports`), so a browser draws it without recomputing the
/// odd/even, 12-port or uplink-right rules itself.
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
    signed.verify(&state, &tx).await?;
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

/// ADR-0050 §3/§4: a PSU bay is a positioned entry on a face, not a count —
/// see `fathom_corpus::catalogue::PsuSlot`'s own doc for why it carries no
/// connector `kind` any more.
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

/// `number` and `name` are the mirror-image pair `Port` itself carries
/// (ADR-0050 §5): a numbered port sends `number` and `name: null`; a named
/// port (`me0`, `con`) sends `number: null` and `name`. `uplink` is kept
/// alongside the fuller `role` for the reason `Port::uplink`'s own doc
/// comment gives.
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

// ---------------------------------------------------------------------------
// Response framing
// ---------------------------------------------------------------------------

fn json_response(j: Json) -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        j.to_canonical_bytes(),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Tests that need no database: the rendering rules themselves
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn json_text(j: &Json) -> String {
        String::from_utf8(j.to_canonical_bytes()).expect("canonical JSON is UTF-8")
    }

    /// §11.2's three outcomes, named — not rendered as a boolean, and not
    /// collapsed into each other.
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

    /// The brief's own words: a save past the audit spool's bound must
    /// surface as itself, not as a generic failure — a different status and a
    /// body that says what still works, never the same `500 refused` a
    /// corrupt row gets.
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
