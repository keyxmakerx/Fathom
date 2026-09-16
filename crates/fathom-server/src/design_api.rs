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
//! # One transaction for verification and authorisation, still
//!
//! `api.rs`'s `Signed` changed shape on 2026-09-14 (`0014`, finding 8) so that
//! a per-request signature and the authorisation that follows it share one
//! database snapshot rather than two. This module's own [`Signed`] is a
//! second implementation of the same shape for a second state type — not a
//! shortcut back to the old one. Every handler below opens exactly one
//! transaction, calls [`Signed::verify`] in it, authorises in the same `tx`,
//! and only commits after both have run.
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
//! # The body size limit is this module's own
//!
//! `api::MAX_SIGNED_BODY` is one mebibyte, and its own doc says a design
//! payload route raises the limit deliberately, in its own commit, with its
//! own number. This module's [`Signed`] does exactly that: its cap is
//! [`designs::MAX_PAYLOAD_BYTES`] plus the four-byte schema version prefix
//! [`save_design_handler`] reads off the front of the body, not `api.rs`'s
//! one mebibyte.
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
use fathom_corpus::catalogue::{Catalogue, CatalogueError, Face, Model, Port, Row};

use crate::api;
use crate::authority::Capability;
use crate::chain;
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

/// Design payloads run up to [`designs::MAX_PAYLOAD_BYTES`] (64 MiB);
/// `api::MAX_SIGNED_BODY` (1 MiB) is for the session-establishment routes
/// only. See the module doc's "body size limit" section.
pub const MAX_SIGNED_BODY: usize = designs::MAX_PAYLOAD_BYTES + 4;

impl FromRequest<DesignApiState> for Signed {
    type Rejection = RouteError;

    async fn from_request(
        request: Request,
        state: &DesignApiState,
    ) -> Result<Self, Self::Rejection> {
        let (parts, body) = request.into_parts();
        let method = parts.method.as_str().to_string();
        let query = parts.uri.query().map(|q| q.to_string());
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

        let body = axum::body::to_bytes(body, MAX_SIGNED_BODY)
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

        let answer = grants::authorise_account(&tx, &auth, Some(scope), Capability::Read).await;
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
// Open
// ---------------------------------------------------------------------------

/// `GET /organisations/{organisation}/designs/{design}[?version=N]` — the
/// decrypted payload, verbatim, plus its version numbers in headers. Requires
/// at least `read`.
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
    let ctx =
        authorise_on_design(&tx, &state, &session, tenant, design_id, Capability::Read).await?;
    tx.commit().await.map_err(SessionError::Db)?;

    let stored = designs::read_version(
        state.sessions.pool(),
        &state.ring,
        tenant,
        ctx.actor(),
        design_id,
        version,
    )
    .await?;

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

/// `POST /organisations/{organisation}/designs/{design}/versions` — a new
/// version. Requires `draw`; a `read`-only caller is refused, and the refusal
/// does not distinguish a design that exists from one that does not (module
/// doc).
///
/// Body: `u32_le(payload_schema_version) ‖ payload_bytes` — the schema
/// version fixed at four bytes because everything after it is the payload
/// verbatim, and a length-prefixed field here would mean copying up to 64 MiB
/// twice for no reason.
async fn save_design_handler(
    State(state): State<DesignApiState>,
    PathExtractor((organisation, design)): PathExtractor<(String, String)>,
    signed: Signed,
) -> Result<Response, RouteError> {
    let tenant = parse_organisation(&organisation)?;
    let design_id = parse_design(&design)?;

    let (schema_version, payload) =
        read_u32_le(&signed.body).ok_or(SessionError::Malformed("design payload body"))?;

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(SessionError::Pool)?;
    let tx = client.transaction().await.map_err(SessionError::Db)?;
    let session = signed.verify(&state, &tx).await?;
    let ctx =
        authorise_on_design(&tx, &state, &session, tenant, design_id, Capability::Draw).await?;
    tx.commit().await.map_err(SessionError::Db)?;

    let version = designs::write_version(
        state.sessions.pool(),
        &state.ring,
        tenant,
        ctx.actor(),
        design_id,
        payload,
        schema_version as i32,
    )
    .await?;

    Ok((StatusCode::OK, format!("{version}\n")).into_response())
}

fn read_u32_le(bytes: &[u8]) -> Option<(u32, &[u8])> {
    if bytes.len() < 4 {
        return None;
    }
    let (head, rest) = bytes.split_at(4);
    let arr: [u8; 4] = head.try_into().ok()?;
    Some((u32::from_le_bytes(arr), rest))
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
/// `cannot_verify_under_key_epoch`. Requires at least `read`.
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
    let ctx =
        authorise_on_design(&tx, &state, &session, tenant, design_id, Capability::Read).await?;
    tx.commit().await.map_err(SessionError::Db)?;

    let report = designs::verify_design(
        state.sessions.pool(),
        &state.ring,
        tenant,
        ctx.actor(),
        design_id,
        deep,
    )
    .await?;

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
        "psu_inlets".to_string(),
        match &m.psu_inlets {
            Some(p) => {
                let mut pm = BTreeMap::new();
                pm.insert("kind".to_string(), Json::Str(p.kind.token().to_string()));
                pm.insert("count".to_string(), Json::Int(i64::from(p.count)));
                Json::Obj(pm)
            }
            None => Json::Null,
        },
    );

    map.insert(
        "faceplates".to_string(),
        Json::Arr(m.faceplates.iter().map(json_of_faceplate).collect()),
    );

    Json::Obj(map)
}

fn json_of_faceplate(f: &fathom_corpus::catalogue::Faceplate) -> Json {
    let mut map = BTreeMap::new();
    map.insert(
        "face".to_string(),
        Json::Str(
            match f.face {
                Face::Front => "front",
                Face::Rear => "rear",
            }
            .to_string(),
        ),
    );
    map.insert("port_count".to_string(), Json::Int(i64::from(f.port_count)));
    map.insert(
        "ports".to_string(),
        Json::Arr(f.ports().iter().map(json_of_port).collect()),
    );
    Json::Obj(map)
}

fn json_of_port(p: &Port) -> Json {
    let mut map = BTreeMap::new();
    map.insert("kind".to_string(), Json::Str(p.kind.token().to_string()));
    map.insert("number".to_string(), Json::Int(i64::from(p.number)));
    map.insert("uplink".to_string(), Json::Bool(p.uplink));
    map.insert(
        "row".to_string(),
        Json::Str(
            match p.row {
                Row::Top => "top",
                Row::Bottom => "bottom",
                Row::Single => "single",
            }
            .to_string(),
        ),
    );
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
