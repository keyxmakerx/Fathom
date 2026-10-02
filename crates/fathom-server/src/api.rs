//! **The first HTTP surface**: sign-in, sign-out, nonce issuance, and one protected
//! route answering what the caller may do on a scope.
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4 (sessions), §3.4
//! (`authorise_account`'s seven steps), §1.4 (no credential in a config file), §13
//! items 1, 2 and 7. `sessions.rs` holds the rules; this file only translates them
//! to HTTP.
//!
//! # The shape every later route composes
//!
//! [`Signed`] is an axum extractor. A handler naming it cannot run until the
//! request carried a fresh single-use nonce and an ES256 signature over its
//! method, path, body digest, nonce and time, and the session row's MAC
//! recomputed under a key not in PostgreSQL. A handler that does **not** name it
//! gets no session and no actor: no other extractor produces either.
//!
//! That is §13 item 1, *"`actor` comes from a session, never from the caller"*, as
//! a type. A type cannot stop a handler calling `repo::open_tenant_context` itself
//! with an id parsed from a header, so `tests/sessions.rs` reads this file's
//! source and fails if it names one.
//!
//! Bodies are length-prefixed bytes, not JSON: axum's `json` feature is absent
//! (it drags in `serde`, `Cargo.toml`), and they carry keys, nonces and signatures
//! in the framing the server signs with (`crypto::lp`, `crypto::read_lp`).
//!
//! # What is NOT here
//!
//! * **No grant endpoints, except** `POST /enrolment/organisation` (ADR-0057
//!   decision 5). Grant proposals stay in-process (§3.8).
//! * **No design or vault routes**; they compose [`Signed`] as the demonstration
//!   route below does.
//! * **No credential in any file this adds** (§1.4).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequest, Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use deadpool_postgres::Transaction;

use crate::authority::{self, Capability};
use crate::crypto;
use crate::grants::{self, Authority, AuthorityError, EpochWatch};
use crate::keys;
use crate::operators::{OperatorError, OperatorStore};
use crate::repo::{self, OrganisationId, ScopeId};
use crate::sessions::{
    self, PrincipalKind, SessionError, SessionStore, SignedRequest, VerifiedSession,
};

/// Everything the session routes need.
#[derive(Clone)]
pub struct ApiState {
    pub sessions: Arc<SessionStore>,
    /// §3.4 step 3's in-process high-water mark, one per process
    /// (`grants::EpochWatch`).
    pub watch: Arc<EpochWatch>,
    pub ring: Arc<keys::KeyRing>,
    /// How a request's address is decided (`crate::client_address`): the peer, or a
    /// forwarding header believed only from trusted proxies. One policy for every
    /// route that counts an address, built in `main.rs`.
    pub client_address: crate::client_address::ClientAddress,
}

/// The session routes, to `merge` into the main router. Separate from
/// `lib::router` because `/health` and `/schema/kinds` hold no keys or session
/// store, and a merged router can be driven alone by a test.
pub fn router(state: ApiState) -> Router {
    Router::new()
        .route("/session/challenge", post(challenge_handler))
        .route("/session", post(sign_in_handler).delete(sign_out_handler))
        .route("/session/nonce", post(nonce_handler))
        .route(
            "/organisations/{organisation}/capability",
            axum::routing::get(organisation_capability_handler),
        )
        .route(
            "/organisations/{organisation}/scopes/{scope}/capability",
            axum::routing::get(scope_capability_handler),
        )
        .with_state(state)
}

// ---- The extractor every protected route composes ----

/// A request with a per-request proof that has **spent its single-use nonce**,
/// ready to be verified inside the handler's own transaction (§4.1 clause (b)).
///
/// **Why it does not return a `VerifiedSession`:** verification once ran in its
/// own transaction, committed before the handler opened a second for
/// `open_tenant_context` and `authorise_account`, so an account disabled or grant
/// revoked between the commits was checked against one state and authorised against
/// another (§3.4, §4). A transaction cannot leave an extractor, so the *request* is
/// carried and the handler opens one transaction for both halves.
///
/// **§13 item 1 is untouched**: a [`SessionStore::PendingRequest`] is not an
/// actor, `VerifiedSession` has private fields and no public constructor, and
/// `sessions::open_tenant_context` is the only bridge to the repository layer.
///
/// Holds the body as received: the signature covers its digest, and a handler
/// re-reading it elsewhere would act on bytes nobody signed.
///
/// [`SessionStore::PendingRequest`]: sessions::PendingRequest
pub struct Signed {
    /// The proof, waiting for the transaction that will check it.
    pub pending: sessions::PendingRequest,
    pub body: Bytes,
    /// This request's address as `ClientAddress` decided on arrival, captured here
    /// because handlers may consume the headers, so [`Signed::verify`] can check it
    /// (ADR-0057 decision 7).
    pub address: String,
}

impl Signed {
    /// Run the rest of §4.1 clause (b) **inside `tx`**, so what the handler
    /// authorises next sees the snapshot the session was verified against.
    ///
    /// **Also checks this request's address against the session's bound one**
    /// (ADR-0057 decision 7) in the same transaction, so a mismatch ends the session
    /// before the handler acts.
    pub async fn verify(
        &self,
        state: &ApiState,
        tx: &Transaction<'_>,
    ) -> Result<VerifiedSession, Refusal> {
        let session = state.sessions.verify_pending(tx, &self.pending).await?;
        state
            .sessions
            .check_session_address(tx, session.id(), &self.address)
            .await?;
        Ok(session)
    }
}

/// As [`Signed::verify`], but commits `tx` whatever the outcome and hands it back
/// on success. `verify` only borrows `tx`, so an ending it makes there would be
/// undone when the route refuses the request that found it.
async fn verify_and_commit<'a>(
    signed: &Signed,
    state: &ApiState,
    tx: Transaction<'a>,
) -> Result<(VerifiedSession, Transaction<'a>), Refusal> {
    match signed.verify(state, &tx).await {
        Ok(session) => Ok((session, tx)),
        Err(e) => {
            let _ = tx.commit().await;
            Err(e)
        }
    }
}

/// The five headers a signed request carries; one list for client library and
/// server.
pub const HEADER_SESSION: &str = "fathom-session";
pub const HEADER_TOKEN: &str = "fathom-session-token";
pub const HEADER_NONCE: &str = "fathom-nonce";
pub const HEADER_TIMESTAMP: &str = "fathom-timestamp";
pub const HEADER_COUNTER: &str = "fathom-counter";
pub const HEADER_SIGNATURE: &str = "fathom-signature";

/// How much body a signed request may carry. One mebibyte is far more than this
/// step posts. The digest covers the whole body, so without a bound an
/// unauthenticated caller chooses how much memory is spent before the signature
/// is checked. A design payload route will raise it deliberately.
pub const MAX_SIGNED_BODY: usize = 1024 * 1024;

impl Signed {
    /// The extractor's body, **callable from any state type**.
    ///
    /// `admin.rs` has its own `State` (it carries an `OperatorStore`) and axum's
    /// `FromRequest` is per state type. Without this, the admin surface would
    /// re-type the header parsing (two spellings of one protocol is how a signature
    /// stops verifying) or carry fields it does not use.
    pub async fn from_request_for(
        request: Request,
        sessions: &SessionStore,
        client_address: &crate::client_address::ClientAddress,
    ) -> Result<Self, Refusal> {
        signed_from_request(request, sessions, client_address).await
    }
}

impl FromRequest<ApiState> for Signed {
    type Rejection = Refusal;

    /// **Everything a signature covers is taken from the request itself**: method and
    /// path from the request line, the body digest from the bytes received, nonce,
    /// timestamp and counter from signed headers. Nothing reads a claim about who is
    /// calling: the session id names a row, and that row's public key is what the
    /// signature must verify under.
    ///
    /// **The path is `path_and_query`**, so a query string is signed too (§4.2
    /// `LP(path)`); an unsigned, rewritable query would be a hole for the first route
    /// that takes a filter.
    async fn from_request(request: Request, state: &ApiState) -> Result<Self, Self::Rejection> {
        signed_from_request(request, &state.sessions, &state.client_address).await
    }
}

async fn signed_from_request(
    request: Request,
    sessions: &SessionStore,
    client_address: &crate::client_address::ClientAddress,
) -> Result<Signed, Refusal> {
    {
        let (parts, body) = request.into_parts();
        let method = parts.method.as_str().to_string();
        let path = parts
            .uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| parts.uri.path().to_string());
        let headers = parts.headers;
        // Captured before the body is read (ADR-0057 decision 7), so it does not depend
        // on how much a later caller consumed.
        let address = client_address.of(&headers, &parts.extensions);

        // A missing or unreadable header is `NotSigned`, not `Malformed`: someone who
        // presented nothing is told to authenticate, and someone who presented rubbish
        // must not learn which header they got right.
        let unsigned = || Refusal::from(SessionError::NotSigned);
        let session_id = header_text(&headers, HEADER_SESSION).map_err(|_| unsigned())?;
        let nonce: [u8; 32] = header_hex(&headers, HEADER_NONCE)
            .map_err(|_| unsigned())?
            .as_slice()
            .try_into()
            .map_err(|_| unsigned())?;
        let unix_ms = header_number(&headers, HEADER_TIMESTAMP).map_err(|_| unsigned())?;
        let counter = header_number(&headers, HEADER_COUNTER).map_err(|_| unsigned())?;
        let signature: [u8; 64] = header_hex(&headers, HEADER_SIGNATURE)
            .map_err(|_| unsigned())?
            .as_slice()
            .try_into()
            .map_err(|_| unsigned())?;

        let body = axum::body::to_bytes(body, MAX_SIGNED_BODY)
            .await
            .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;

        // The nonce is spent here in its own committed transaction, so a handler that
        // fails or rolls back cannot leave a replayable one.
        let pending = sessions
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

        Ok(Signed {
            pending,
            body,
            address,
        })
    }
}

// ---- Handlers ----

/// `POST /session/challenge`: §4.2's `server_nonce`, bound to the public key the
/// browser asks to register.
///
/// Body: `LP(principal_kind) ‖ LP(address) ‖ LP(session_pubkey)`.
/// Answer: `LP(nonce) ‖ LP(deployment_id)`.
///
/// **The answer is the same for an address that belongs to no account**; the
/// refusal is at sign-in, not here.
async fn challenge_handler(
    State(state): State<ApiState>,
    request: Request,
) -> Result<Response, Refusal> {
    // Counted against the source bucket like any attempt (`0014` §C): this route
    // writes a `session_nonces` row, so one anonymous POST was one permanent row.
    let source = source_of(&state, request.headers(), request.extensions());
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 3)?;
    let kind = principal_kind(&fields[0])?;
    let address = text(&fields[1], "address")?;
    let challenge = state
        .sessions
        .issue_challenge(kind, &address, &fields[2], &source)
        .await?;

    let mut out = Vec::with_capacity(96);
    crypto::lp(&mut out, &challenge.nonce);
    crypto::lp(&mut out, challenge.deployment_id.as_bytes());
    Ok(bytes_response(out))
}

/// `POST /session`: sign-in.
///
/// Body, **nine fields** (ADR-0057 decision 6):
/// `LP(principal_kind) ‖ LP(session_pubkey) ‖ LP(nonce) ‖ LP(evidence_sig)
///  ‖ LP(password) ‖ LP(totp_code) ‖ LP(account_session_id)
///  ‖ LP(account_session_sig) ‖ LP(grace_token)`. The last three are empty on the
/// steward plane. On the operator plane the first two identify a live session of
/// the operator's bound account and carry its signature over this attempt's
/// challenge (the operator's key alone is refused). The ninth is the memory-only
/// grace token that session's sign-in minted, if the browser holds one.
///
/// Answer, **five fields**: `LP(session_id) ‖ LP(token) ‖ u64(expires_at_unix) ‖
/// LP(account_id) ‖ LP(grace_token)`. The fifth is non-empty only when this
/// sign-in verifies a fresh TOTP code on the steward plane.
///
/// `account_id` and `grace_token` are **appended, not inserted** (ADR-0053 §3), so
/// older clients that read only the fields they know keep working.
///
/// **This is the one route a password may arrive on**, reopening §4.5's rule by the
/// owner's decision in ADR-0055's header. `tests/operators.rs` allowlists this
/// handler and `credentials.rs`'s routes and fails the build if a password-shaped
/// field appears in any other handler in `api.rs`, `admin.rs` or `operators.rs`.
///
/// **The count is exact**: `read_fields(&body, 9)` refuses eight or ten fields, so
/// a client of the wrong shape is told so, not silently truncated.
async fn sign_in_handler(
    State(state): State<ApiState>,
    request: Request,
) -> Result<Response, Refusal> {
    let source = source_of(&state, request.headers(), request.extensions());
    // ADR-0057 decision 8: reduced once, here, to the fixed vocabulary a session row
    // keeps; the raw header is never stored.
    let user_agent = request
        .headers()
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 9)?;
    let kind = principal_kind(&fields[0])?;
    let nonce = thirty_two(&fields[2], "nonce")?;
    let password = text(&fields[4], "credential")?;
    // The label goes into `SessionError::Malformed`, which an operator reads:
    // "verification code" is the name on the screen (ADR-0056 decision 4).
    let totp_code = text(&fields[5], "verification code")?;
    let account_session_id = text(&fields[6], "account session")?;

    let signed_in = state
        .sessions
        .sign_in_with_credentials(&sessions::SignInAttempt {
            kind,
            session_pubkey: &fields[1],
            nonce: &nonce,
            evidence_sig: &fields[3],
            password: &password,
            totp_code: &totp_code,
            source: &source,
            account_session_id: &account_session_id,
            account_session_sig: &fields[7],
            grace_token: &fields[8],
            user_agent: &user_agent,
        })
        .await?;

    let mut out = Vec::with_capacity(96);
    crypto::lp(&mut out, signed_in.session_id.as_bytes());
    crypto::lp(&mut out, &signed_in.token);
    crypto::u64_le(&mut out, signed_in.expires_at_unix as u64);
    crypto::lp(&mut out, signed_in.account_id.as_bytes());
    crypto::lp(
        &mut out,
        signed_in
            .grace_token
            .as_ref()
            .map(|g| g.as_slice())
            .unwrap_or(&[]),
    );
    Ok(bytes_response(out))
}

/// `POST /session/nonce`: one single-use nonce for a live session.
///
/// Authenticated by the bearer token, since a signature needs a nonce and the
/// caller has none. A nonce authorises nothing alone.
///
/// Answer, **two fields** (ADR-0057 decision 4): `LP(nonce) ‖ u64(issued_counter)`,
/// appended like `account_id`, so a reloading client resumes at
/// `max(local, issued_counter) + 1`.
async fn nonce_handler(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Response, Refusal> {
    let session_id = header_text(&headers, HEADER_SESSION)?;
    let token = header_hex(&headers, HEADER_TOKEN)?;
    let issued = state
        .sessions
        .issue_request_nonce_ex(&session_id, &token)
        .await?;
    let mut out = Vec::with_capacity(48);
    crypto::lp(&mut out, &issued.nonce);
    crypto::u64_le(&mut out, issued.issued_counter as u64);
    Ok(bytes_response(out))
}

/// `DELETE /session`: sign-out, deleting the row.
///
/// Signed like every protected route, so ending a session needs its private key:
/// someone who only copied the row cannot end it.
async fn sign_out_handler(
    State(state): State<ApiState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    // One transaction for the verification and the act.
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(|e| Refusal::from(SessionError::Pool(e)))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    let (session, tx) = verify_and_commit(&signed, &state, tx).await?;
    state.sessions.sign_out_in(&tx, &session).await?;
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    Ok((
        StatusCode::OK,
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        "signed out\n",
    )
        .into_response())
}

/// `GET /organisations/{organisation}/capability`: the demonstration route, at the
/// organisation scope.
async fn organisation_capability_handler(
    State(state): State<ApiState>,
    Path(organisation): Path<String>,
    signed: Signed,
) -> Result<Response, Refusal> {
    capability(&state, &signed, &organisation, None).await
}

/// `GET /organisations/{organisation}/scopes/{scope}/capability`.
async fn scope_capability_handler(
    State(state): State<ApiState>,
    Path((organisation, scope)): Path<(String, String)>,
    signed: Signed,
) -> Result<Response, Refusal> {
    capability(&state, &signed, &organisation, Some(scope)).await
}

/// **The whole chain in one route.** A verified session becomes a tenant context
/// through the one function taking a `&VerifiedSession`; that becomes an
/// `Authority`; `grants::authorise_account` then runs §3.4's seven steps before
/// anything is answered.
///
/// It asks for `read`, the weakest capability, and answers with the strongest one
/// established, so `NotAuthorised` is a real refusal, not a question about the
/// wrong verb. **One transaction** for verification and authorisation, so they
/// share a snapshot (§3.4, §4).
async fn capability(
    state: &ApiState,
    signed: &Signed,
    organisation: &str,
    scope: Option<String>,
) -> Result<Response, Refusal> {
    let tenant: OrganisationId = organisation
        .parse()
        .map_err(|_| Refusal::from(SessionError::Malformed("organisation id")))?;
    let scope_id = match scope {
        None => None,
        Some(s) => Some(
            s.parse::<ScopeId>()
                .map_err(|_| Refusal::from(SessionError::Malformed("scope id")))?,
        ),
    };

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(|e| Refusal::from(SessionError::Pool(e)))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;

    let (session, tx) = verify_and_commit(signed, state, tx).await?;
    let ctx = sessions::open_tenant_context(&tx, tenant, &session).await?;
    let tenant_key = keys::tenant_key(&tx, &state.ring, &ctx)
        .await
        .map_err(|e| Refusal::from(SessionError::Keys(e)))?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &state.watch,
    };

    let answer = grants::authorise_account(&tx, &auth, scope_id, Capability::Read).await;

    // **It commits.** The HANDLER writes nothing (a question that leaves a row can
    // be answered from the row), but the transaction carries verification's own
    // bookkeeping: the advanced `request_counter`, the mark later nonces are issued
    // against. Rolling it back would leave the browser's tally ahead and the session
    // stopping at `CounterNotFresh` a window later.
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;

    match answer {
        Ok(capabilities) => Ok((
            StatusCode::OK,
            [(axum::http::header::CACHE_CONTROL, "no-store")],
            format!("{}\n", capabilities.capability.as_str()),
        )
            .into_response()),
        Err(e) => Err(Refusal::from(SessionError::Authority(e))),
    }
}

// ---- ADR-0055 stream (a): the credential routes ----
//
// Own state and router so other ADR-0055 streams merge mechanically. **Own state,
// not a widened `ApiState`** (as `admin.rs`): `ApiState` is built in seven places,
// none needing a `CredentialStore`.
//
// **They are NOT behind `admin_exposure`.** Every route is account-plane and
// answers on every host, like `/session`: `AdminExposure::covers` matches
// `/admin*` and the exact `/enrolment/operator`, and `/enrolment/operator/setup`
// is neither (it is reached from where the token was handed over). A judgement,
// not a certainty: reopen with stream (c), which owns that module, if the first
// operator's setup belongs on the console host.

/// Everything the credential routes need.
#[derive(Clone)]
pub struct CredentialApiState {
    pub sessions: Arc<SessionStore>,
    pub credentials: Arc<crate::credentials::CredentialStore>,
    /// For `POST /enrolment/operator/setup` only, which spends a `purpose = 'setup'`
    /// enrolment token through the operator plane's own seal and expiry checks, not a
    /// second copy.
    pub operators: Arc<crate::operators::OperatorStore>,
    /// ADR-0057 decision 1: this start's setup secret, minted once and held here (no
    /// token file). `None` whenever `FATHOM_SETUP_PASSWORD` is unset, fails the
    /// account password policy, or the first operator has finished setup; `main.rs`
    /// decides once at startup. The setup routes fall back to it only when the field
    /// does not check out as a token, so a recovery code works as always.
    pub setup_secret: Option<crate::credentials::SetupSecret>,
    pub client_address: crate::client_address::ClientAddress,
}

/// The credential routes, to `merge` into the main router.
pub fn credential_router(state: CredentialApiState) -> Router {
    Router::new()
        .route("/credentials/password", post(set_password_handler))
        .route(
            "/credentials/status",
            axum::routing::get(credential_status_handler),
        )
        .route("/credentials/key", post(register_key_handler))
        .route("/credentials/totp/enrol", post(enrol_totp_handler))
        .route("/credentials/totp/confirm", post(confirm_totp_handler))
        .route("/credentials/reset", post(request_reset_handler))
        .route("/credentials/reset/redeem", post(redeem_reset_handler))
        .route("/enrolment/operator/setup", post(operator_setup_handler))
        // ADR-0056 decisions 1 and 2. On every host, like the route they walk up to.
        .route(
            "/enrolment/operator/setup/check",
            post(operator_setup_check_handler),
        )
        .route("/setup/state", axum::routing::get(setup_state_handler))
        // ADR-0057 decision 8: signed-in browsers. Self-service; the admin routes are a
        // separate block below, gated by `repo::require_admin*`.
        .route("/sessions", axum::routing::get(list_own_sessions_handler))
        .route("/sessions/end", post(end_own_session_handler))
        .route("/sessions/end-others", post(end_own_other_sessions_handler))
        .route(
            "/organisations/{organisation}/members/{account}/sessions",
            axum::routing::get(admin_list_member_sessions_handler),
        )
        .route(
            "/organisations/{organisation}/members/{account}/sessions/end",
            post(admin_end_member_session_handler),
        )
        .route(
            "/organisations/{organisation}/members/{account}/sessions/end-all",
            post(admin_end_member_sessions_handler),
        )
        .route(
            "/organisations/{organisation}/sessions/end-all",
            post(admin_end_organisation_sessions_handler),
        )
        .with_state(state)
}

impl FromRequest<CredentialApiState> for Signed {
    type Rejection = Refusal;

    async fn from_request(
        request: Request,
        state: &CredentialApiState,
    ) -> Result<Self, Self::Rejection> {
        signed_from_request(request, &state.sessions, &state.client_address).await
    }
}

/// Verify a credential route's session inside one transaction, run the act, and
/// commit: the shape of every signed route here.
async fn verified(state: &CredentialApiState, signed: &Signed) -> Result<VerifiedSession, Refusal> {
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(|e| Refusal::from(SessionError::Pool(e)))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    let result: Result<VerifiedSession, Refusal> = async {
        let session = state.sessions.verify_pending(&tx, &signed.pending).await?;
        // ADR-0057 decision 7: must run in the verification's transaction. The row just
        // advanced is locked until it resolves, so a `DELETE` on another connection
        // would wait forever.
        state
            .sessions
            .check_session_address(&tx, session.id(), &signed.address)
            .await?;
        Ok(session)
    }
    .await;
    // Committed whatever the block decided: an advanced counter, idle death or
    // address-mismatch ending would otherwise be rolled back.
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    result
}

/// `POST /credentials/password`. Body: `LP(current) ‖ LP(new) ‖
/// LP(session_pubkey) ‖ LP(nonce) ‖ LP(evidence_sig)`, the last three non-empty
/// only for a first password.
async fn set_password_handler(
    State(state): State<CredentialApiState>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    let source = state.client_address.of(&headers, &extensions);
    let fields = read_fields(&signed.body, 5)?;
    let current = text(&fields[0], "current credential")?;
    let chosen = text(&fields[1], "credential")?;
    let account = session.principal_id();

    // Charged once, unconditionally, before anything below is verified.
    state
        .sessions
        .charge_credential_refusal(&account, &source)
        .await?;

    let fresh_evidence_verified =
        if fields[2].is_empty() && fields[3].is_empty() && fields[4].is_empty() {
            false
        } else {
            let nonce = thirty_two(&fields[3], "nonce")?;
            state
                .sessions
                .verify_fresh_evidence(&account, &fields[2], &nonce, &fields[4])
                .await
                .is_ok()
        };

    if let Err(e) = state
        .credentials
        .set_password(&session, &current, &chosen, fresh_evidence_verified)
        .await
    {
        return credential_check_refused(e);
    }
    // A successful change must not spend the budget the attempt reserved.
    state
        .sessions
        .refund_credential_charge(&account, &source)
        .await;
    Ok(empty_response())
}

/// `GET /credentials/status`: does this session's account have a confirmed
/// authenticator? ADR-0057 decision 3. No body. Answer: `LP("yes"|"no")`.
async fn credential_status_handler(
    State(state): State<CredentialApiState>,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    let _ = read_fields(&signed.body, 0)?;
    let confirmed = state
        .credentials
        .totp_confirmed(&session)
        .await
        .map_err(CredentialRefusal)?;
    let mut out = Vec::with_capacity(8);
    crypto::lp(&mut out, if confirmed { b"yes" } else { b"no" });
    Ok(bytes_response(out))
}

/// `POST /credentials/key` — register this browser's long-term key.
///
/// Body: `LP(public_key)`. Answer: `LP(key_id)`.
async fn register_key_handler(
    State(state): State<CredentialApiState>,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    let fields = read_fields(&signed.body, 1)?;
    let id = state
        .credentials
        .register_key(&session, &fields[0])
        .await
        .map_err(CredentialRefusal)?;
    let mut out = Vec::with_capacity(40);
    crypto::lp(&mut out, id.as_bytes());
    Ok(bytes_response(out))
}

/// `POST /credentials/totp/enrol` — draws a secret into the PENDING slot.
/// Body: `LP(current) ‖ LP(code)`, both empty unless replacing a confirmed one.
async fn enrol_totp_handler(
    State(state): State<CredentialApiState>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    let source = state.client_address.of(&headers, &extensions);
    let fields = read_fields(&signed.body, 2)?;
    let current = text(&fields[0], "current credential")?;
    let code = text(&fields[1], "verification code")?;
    let account = session.principal_id();

    // Charged once, unconditionally, before anything below is verified.
    state
        .sessions
        .charge_credential_refusal(&account, &source)
        .await?;

    let enrolment = match state
        .credentials
        .enrol_totp(&session, &current, &code)
        .await
    {
        Ok(enrolment) => enrolment,
        Err(e) => return credential_check_refused(e),
    };
    // A successful draw must not spend the budget the attempt reserved.
    state
        .sessions
        .refund_credential_charge(&account, &source)
        .await;
    let mut out = Vec::with_capacity(256);
    crypto::lp(&mut out, enrolment.otpauth_uri.as_bytes());
    crypto::lp(&mut out, enrolment.secret_base32.as_bytes());
    Ok(bytes_response(out))
}

/// `POST /credentials/totp/confirm`. Body: `LP(app_code)`. Answer: ten
/// `LP(backup_code)` fields, once. Ends this account's other sessions on success.
async fn confirm_totp_handler(
    State(state): State<CredentialApiState>,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    let fields = read_fields(&signed.body, 1)?;
    let code = text(&fields[0], "verification code")?;
    let codes = match state.credentials.confirm_totp(&session, &code).await {
        Ok(codes) => codes,
        Err(e) => return credential_check_refused(e),
    };
    let mut out = Vec::with_capacity(256);
    for code in &codes {
        crypto::lp(&mut out, code.as_bytes());
    }
    Ok(bytes_response(out))
}

/// `POST /credentials/reset`: *"forgot my password"*.
///
/// Body: `LP(address)`. Answer: **200, empty, always** (ADR-0055 decision 7; OWASP
/// ASVS 5.0.0 6.3.8). The refusal paths are the rate limits, which answer the same
/// way for every address.
///
/// **Two buckets.** Decision 7 asks for per-account and per-source limits. Source
/// alone let ten requests from one source mint ten live tokens for one person and
/// left a distributed caller unbounded per victim, so the per-address bucket
/// (`0018` §D: `reset:` over `sessions::claimed_address_key`) is counted too. Over
/// it, the route does nothing and answers as if it had.
async fn request_reset_handler(
    State(state): State<CredentialApiState>,
    request: Request,
) -> Result<Response, CredentialRefusal> {
    let source = state
        .client_address
        .of(request.headers(), request.extensions());
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 1)?;
    let address = text(&fields[0], "address")?;

    // The same `sign_in_attempts` source bucket `/session` spends (§13 item 7), so a
    // source that spent its budget guessing at `/session` has spent it here.
    state
        .sessions
        .check_source_budget(PrincipalKind::Steward, &source)
        .await?;
    // **The same 200 over the cap as under it.** A 429 would say "this address has
    // asked recently", the enumeration the uniform answer prevents.
    if !state.sessions.check_reset_budget(&address).await? {
        return Ok(empty_response());
    }
    state
        .credentials
        .request_reset(&address, &source)
        .await
        .map_err(CredentialRefusal)?;
    Ok(empty_response())
}

/// `POST /credentials/reset/redeem`: spend a reset token, set a password.
///
/// Body: `LP(token) ‖ LP(new_credential)`. Answer: 200, empty. **No session**
/// (decision 7's *"no automatic sign-in"*, per the OWASP Forgot Password Cheat
/// Sheet).
async fn redeem_reset_handler(
    State(state): State<CredentialApiState>,
    request: Request,
) -> Result<Response, CredentialRefusal> {
    let source = state
        .client_address
        .of(request.headers(), request.extensions());
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 2)?;
    let chosen = text(&fields[1], "credential")?;
    state
        .sessions
        .check_source_budget(PrincipalKind::Steward, &source)
        .await?;
    state
        .credentials
        .redeem_reset(&fields[0], &chosen)
        .await
        .map_err(CredentialRefusal)?;
    Ok(empty_response())
}

/// `POST /enrolment/operator/setup`: the first operator's setup screen.
///
/// Body: `LP(setup_secret) ‖ LP(new_credential)`. Answer: 200, empty, no session;
/// the client signs in with `POST /session` next, so a token never becomes a
/// session without the password being checked.
///
/// ADR-0057 decision 1: the field is tried as a live setup token first (a
/// `recover-operator` code has that shape), then as this start's setup password
/// (`credentials::redeem_setup`). A refusal is
/// [`crate::credentials::CredentialError::TokenRefused`], rendered as a bad token.
async fn operator_setup_handler(
    State(state): State<CredentialApiState>,
    request: Request,
) -> Result<Response, CredentialRefusal> {
    let source = state
        .client_address
        .of(request.headers(), request.extensions());
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 2)?;
    let chosen = text(&fields[1], "credential")?;
    state
        .sessions
        .check_source_budget(PrincipalKind::Operator, &source)
        .await?;
    state
        .credentials
        .redeem_setup(
            &state.operators,
            state.setup_secret.as_ref(),
            &fields[0],
            &chosen,
            &source,
        )
        .await
        .map_err(CredentialRefusal)?;
    Ok(empty_response())
}

/// `GET /setup/state`: has this deployment's first operator finished?
///
/// No body, session or signature. Answer: `LP("pending")` or `LP("done")`.
///
/// ADR-0056 decision 1. One bit about the DEPLOYMENT, never an address: a visitor
/// to a pending deployment sees the setup screen anyway, and `/session`'s
/// per-address answers are unchanged in content and time (ASVS 5.0.0 6.3.8).
///
/// **It charges its own per-source budget** (`setup-state:` + the source,
/// [`crate::sessions::SETUP_STATE_MAX_PER_SOURCE`] per window). Exempting the route
/// let an unauthenticated caller drive it for free; charging the SIGN-IN bucket made
/// an office behind one address refuse its own sign-ins and, worse, a 429 here
/// takes the first-run screen away so a pending deployment looks finished. Its own
/// bucket keeps each fault in its own route (see
/// [`crate::sessions::SessionStore::check_setup_state_budget`]).
///
/// **A 429 carries `Retry-After`**, so the client waits rather than guessing setup
/// is finished.
///
/// **Two guards bound different things**: the budget bounds one source's requests;
/// the single-flight cache in [`crate::credentials::CredentialStore::setup_state`]
/// bounds the database work of a crowd.
///
/// `Cache-Control: no-store` (from [`bytes_response`]): a proxy holding `pending`
/// after the bit moved would send people back to a finished setup.
async fn setup_state_handler(
    State(state): State<CredentialApiState>,
    request: Request,
) -> Result<Response, CredentialRefusal> {
    let source = state
        .client_address
        .of(request.headers(), request.extensions());
    state.sessions.check_setup_state_budget(&source).await?;
    let answer = state
        .credentials
        .setup_state()
        .await
        .map_err(CredentialRefusal)?;
    let mut out = Vec::with_capacity(16);
    crypto::lp(&mut out, answer.as_str().as_bytes());
    Ok(bytes_response(out))
}

/// `POST /enrolment/operator/setup/check`: whose setup does this secret open?
///
/// Body: `LP(setup_secret)`. Answer: 200, `LP(address)`.
///
/// ADR-0056 decision 1: the address is never typed, so it cannot mismatch. A read:
/// nothing is spent or written. **ADR-0057 decision 1**: tried as a live token
/// first, then as this start's setup password (`credentials.rs`'s `check_setup`).
///
/// **One sentence for every refused secret**, rendered inline: wrong, spent,
/// expired, window expired and setup closed are one fact from outside. A body that
/// is not one length-prefixed field is still a `400 malformed request`: a caller
/// speaking another protocol, not a fact about a secret. Rate limited against the
/// same source bucket as the redemption beside it.
async fn operator_setup_check_handler(
    State(state): State<CredentialApiState>,
    request: Request,
) -> Result<Response, CredentialRefusal> {
    let source = state
        .client_address
        .of(request.headers(), request.extensions());
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 1)?;
    state
        .sessions
        .check_source_budget(PrincipalKind::Operator, &source)
        .await?;
    let address = match state
        .credentials
        .check_setup(
            &state.operators,
            state.setup_secret.as_ref(),
            &fields[0],
            &source,
        )
        .await
    {
        Ok(address) => address,
        // **The sentence is this route's own.** `TokenRefused` reaches
        // [`CredentialRefusal`] from three routes and renders as the uniform `sign-in
        // refused` for the two about a credential; this one is about the setup secret,
        // so the person must be told which thing was refused. The sentence is the same
        // for wrong, spent, expired and closed, as elsewhere a setup secret is presented.
        Err(crate::credentials::CredentialError::TokenRefused) => {
            tracing::info!(
                reason = "setup_secret_refused",
                "a setup secret was refused"
            );
            return Ok((
                StatusCode::UNAUTHORIZED,
                format!("{}\n", crate::credentials::SETUP_SECRET_REFUSED),
            )
                .into_response());
        }
        Err(e) => return Err(CredentialRefusal(e)),
    };
    let mut out = Vec::with_capacity(64);
    crypto::lp(&mut out, address.as_bytes());
    Ok(bytes_response(out))
}

// ---- ADR-0057 decision 8: signed-in browsers (OWASP ASVS 5.0.0 7.4.5, 7.5.2) ----

/// Every route below is steward-plane: an operator principal has no "signed-in
/// browsers" of its own (§2, `0004`) and belongs to no organisation.
fn require_steward(session: &VerifiedSession) -> Result<(), Refusal> {
    if session.kind() != PrincipalKind::Steward {
        return Err(SessionError::NotATenantPrincipal.into());
    }
    Ok(())
}

/// One [`sessions::SessionSummary`] on the wire. Empty `LP`s, not absent ones, for
/// a session old enough to predate the column (ADR-0053 §3).
fn write_session_summary(out: &mut Vec<u8>, s: &sessions::SessionSummary, is_current: bool) {
    crypto::lp(out, s.session_id.as_bytes());
    crypto::lp(out, s.browser_label.as_deref().unwrap_or("").as_bytes());
    crypto::lp(
        out,
        s.bound_address_class.as_deref().unwrap_or("").as_bytes(),
    );
    out.push(u8::from(s.address_changed));
    crypto::u64_le(out, s.last_active_unix.max(0) as u64);
    crypto::u64_le(out, s.issued_at_unix.max(0) as u64);
    out.push(u8::from(is_current));
}

/// `u32(count)` then that many [`write_session_summary`] records.
fn write_session_summaries(list: &[sessions::SessionSummary], current_session_id: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 96 * list.len());
    crypto::u32_le(&mut out, list.len() as u32);
    for s in list {
        write_session_summary(&mut out, s, s.session_id == current_session_id);
    }
    out
}

/// `GET /sessions` (ASVS 5.0.0 7.5.2): this account's signed-in browsers, most
/// recently active first. No body.
async fn list_own_sessions_handler(
    State(state): State<CredentialApiState>,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    require_steward(&session)?;
    let _ = read_fields(&signed.body, 0)?;
    let account = session.principal_id();
    let list = state.sessions.list_sessions_of(&account).await?;
    Ok(bytes_response(write_session_summaries(&list, session.id())))
}

/// `POST /sessions/end`: ends one of this account's OTHER sessions (ASVS 5.0.0
/// 7.5.2). Body: `LP(session_id) ‖ LP(code)`. The current session is refused
/// here, code-free; `DELETE /session` signs a browser out.
async fn end_own_session_handler(
    State(state): State<CredentialApiState>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    require_steward(&session)?;
    let source = state.client_address.of(&headers, &extensions);
    let fields = read_fields(&signed.body, 2)?;
    let target = text(&fields[0], "session id")?;
    let code = text(&fields[1], "verification code")?;
    if target == session.id() {
        return Err(SessionError::Malformed("session id").into());
    }
    let account = session.principal_id();

    // Charged once, unconditionally, before anything below is verified, as
    // `set_password_handler` does: a wrong code costs budget whether or not the
    // session id names a real session.
    state
        .sessions
        .charge_credential_refusal(&account, &source)
        .await?;
    if !state.sessions.verify_current_code(&account, &code).await? {
        return Ok(refusal_text(
            StatusCode::FORBIDDEN,
            "verification code refused",
        ));
    }
    match state.sessions.end_one_of(&account, &target, None).await {
        Ok(()) => {}
        Err(SessionError::NoSuchSession) => {
            return Ok(refusal_text(StatusCode::NOT_FOUND, "no such session"));
        }
        Err(e) => return Err(e.into()),
    }
    state
        .sessions
        .refund_credential_charge(&account, &source)
        .await;
    Ok(empty_response())
}

/// `POST /sessions/end-others`: "sign out all other browsers" (ASVS 5.0.0 7.5.2).
/// Body: `LP(code)`. This session is left alone, code-free.
async fn end_own_other_sessions_handler(
    State(state): State<CredentialApiState>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    require_steward(&session)?;
    let source = state.client_address.of(&headers, &extensions);
    let fields = read_fields(&signed.body, 1)?;
    let code = text(&fields[0], "verification code")?;
    let account = session.principal_id();

    state
        .sessions
        .charge_credential_refusal(&account, &source)
        .await?;
    if !state.sessions.verify_current_code(&account, &code).await? {
        return Ok(refusal_text(
            StatusCode::FORBIDDEN,
            "verification code refused",
        ));
    }
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(|e| Refusal::from(SessionError::Pool(e)))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    state
        .sessions
        .end_other_sessions(&tx, PrincipalKind::Steward, &account, session.id(), None)
        .await?;
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    state
        .sessions
        .refund_credential_charge(&account, &source)
        .await;
    Ok(empty_response())
}

/// Confirms `actor` administers `organisation` and `member` belongs to it, and
/// returns the CANONICAL member id. Callers must use it, never raw path text, which
/// a differently cased id would not match.
async fn admin_over_member(
    state: &CredentialApiState,
    session: &VerifiedSession,
    organisation: &str,
    member: &str,
) -> Result<String, CredentialRefusal> {
    require_steward(session)?;
    let tenant: OrganisationId = organisation
        .parse()
        .map_err(|_| Refusal::from(SessionError::Malformed("organisation id")))?;
    let canonical = repo::require_admin_over_member(
        state.sessions.pool(),
        tenant,
        &session.principal_id(),
        member,
    )
    .await
    .map_err(SessionError::from)?;
    Ok(canonical)
}

/// `GET /organisations/{organisation}/members/{account}/sessions`: an
/// administrator's list of a member's signed-in browsers (ASVS 5.0.0 7.4.5). No
/// body.
async fn admin_list_member_sessions_handler(
    State(state): State<CredentialApiState>,
    Path((organisation, account)): Path<(String, String)>,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    let member = admin_over_member(&state, &session, &organisation, &account).await?;
    let _ = read_fields(&signed.body, 0)?;
    let list = state.sessions.list_sessions_of(&member).await?;
    // Never this admin's own session on someone else's account: `""` equals no real
    // session id.
    Ok(bytes_response(write_session_summaries(&list, "")))
}

/// Refuses an admin ending route whose `member` is the caller: ending one's own
/// sessions is `/sessions/end`'s job, which asks for the caller's own fresh
/// factor, not the organisation's authority.
fn refuse_administering_self(session: &VerifiedSession, member: &str) -> Option<Response> {
    if member == session.principal_id() {
        Some(refusal_text(
            StatusCode::BAD_REQUEST,
            "end your own sessions from your account's Signed-in browsers list",
        ))
    } else {
        None
    }
}

/// The admin's own current authenticator code (ASVS 5.0.0 7.4.5), charged,
/// checked and refunded as `end_own_session_handler` does, but keyed to the
/// ADMIN's account, never the member's.
async fn admin_current_code(
    state: &CredentialApiState,
    headers: &HeaderMap,
    extensions: &axum::http::Extensions,
    admin: &str,
    code: &str,
) -> Result<bool, CredentialRefusal> {
    let source = state.client_address.of(headers, extensions);
    state
        .sessions
        .charge_credential_refusal(admin, &source)
        .await?;
    let ok = state.sessions.verify_current_code(admin, code).await?;
    if ok {
        state
            .sessions
            .refund_credential_charge(admin, &source)
            .await;
    }
    Ok(ok)
}

/// `POST /organisations/{organisation}/members/{account}/sessions/end`: an
/// administrator ends one of a member's sessions (ASVS 5.0.0 7.4.5). Body:
/// `LP(session_id) ‖ LP(code)`, the admin's own current code.
async fn admin_end_member_session_handler(
    State(state): State<CredentialApiState>,
    Path((organisation, account)): Path<(String, String)>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    let member = admin_over_member(&state, &session, &organisation, &account).await?;
    if let Some(refusal) = refuse_administering_self(&session, &member) {
        return Ok(refusal);
    }
    let fields = read_fields(&signed.body, 2)?;
    let target_session = text(&fields[0], "session id")?;
    let code = text(&fields[1], "verification code")?;
    if !admin_current_code(
        &state,
        &headers,
        &extensions,
        &session.principal_id(),
        &code,
    )
    .await?
    {
        return Ok(refusal_text(
            StatusCode::FORBIDDEN,
            "verification code refused",
        ));
    }
    match state
        .sessions
        .end_one_of(&member, &target_session, Some(&session.principal_id()))
        .await
    {
        Ok(()) => {}
        Err(SessionError::NoSuchSession) => {
            return Ok(refusal_text(StatusCode::NOT_FOUND, "no such session"));
        }
        Err(e) => return Err(e.into()),
    }
    Ok(empty_response())
}

/// `POST /organisations/{organisation}/members/{account}/sessions/end-all`: an
/// administrator ends every session of one member (ASVS 5.0.0 7.4.5). Body:
/// `LP(code)`, the admin's own current code.
async fn admin_end_member_sessions_handler(
    State(state): State<CredentialApiState>,
    Path((organisation, account)): Path<(String, String)>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    let member = admin_over_member(&state, &session, &organisation, &account).await?;
    if let Some(refusal) = refuse_administering_self(&session, &member) {
        return Ok(refusal);
    }
    let fields = read_fields(&signed.body, 1)?;
    let code = text(&fields[0], "verification code")?;
    if !admin_current_code(
        &state,
        &headers,
        &extensions,
        &session.principal_id(),
        &code,
    )
    .await?
    {
        return Ok(refusal_text(
            StatusCode::FORBIDDEN,
            "verification code refused",
        ));
    }
    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(|e| Refusal::from(SessionError::Pool(e)))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    state
        .sessions
        .end_other_sessions(
            &tx,
            PrincipalKind::Steward,
            &member,
            // No exception: this ends every one of the member's sessions, never the admin's
            // own (`refuse_administering_self` refused that id).
            "",
            Some(&session.principal_id()),
        )
        .await?;
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    Ok(empty_response())
}

/// `POST /organisations/{organisation}/sessions/end-all`: ends every session in
/// the organisation except the caller's own (ASVS 5.0.0 7.4.5). Body: `LP(code)`,
/// the admin's own current code.
async fn admin_end_organisation_sessions_handler(
    State(state): State<CredentialApiState>,
    Path(organisation): Path<String>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    signed: Signed,
) -> Result<Response, CredentialRefusal> {
    let session = verified(&state, &signed).await?;
    require_steward(&session)?;
    let tenant: OrganisationId = organisation
        .parse()
        .map_err(|_| Refusal::from(SessionError::Malformed("organisation id")))?;
    repo::require_admin(state.sessions.pool(), tenant, &session.principal_id())
        .await
        .map_err(SessionError::from)?;
    let fields = read_fields(&signed.body, 1)?;
    let code = text(&fields[0], "verification code")?;
    if !admin_current_code(
        &state,
        &headers,
        &extensions,
        &session.principal_id(),
        &code,
    )
    .await?
    {
        return Ok(refusal_text(
            StatusCode::FORBIDDEN,
            "verification code refused",
        ));
    }
    state
        .sessions
        .end_all_in_organisation_except(&organisation, &session.principal_id())
        .await?;
    Ok(empty_response())
}

/// One credential-plane refusal, on its way to a status code and a sentence.
///
/// **The password policy explains itself and nothing else does.** A policy refusal
/// concerns a password the caller just chose, so it discloses nothing; every other
/// refusal goes through [`Refusal`], whose sentence is fixed per status.
///
/// Handlers return this type, so [`IntoResponse`] is the one place a credential
/// verdict is decided. A `From` impl once folded the four policy variants into
/// `SessionError::Malformed`, so someone whose password contained their own address
/// was told **"malformed request"** and retried with something shorter rather than
/// better. `credentials.rs`'s header rule 4, *"no refusal explains which check it
/// failed, except the password policy"*, is now kept in both halves. `?` still
/// works on `Refusal`-shaped helpers through [`From<Refusal>`], which wraps rather
/// than re-maps, so every other refusal renders byte for byte as before.
pub struct CredentialRefusal(pub crate::credentials::CredentialError);

/// A session-plane refusal reaching a credential handler through `?`.
/// **Wrapped, not re-mapped**: `CredentialError::Session` is rendered by
/// `Refusal`'s own `IntoResponse`, so status, sentence and log line are unchanged.
impl From<Refusal> for CredentialRefusal {
    fn from(e: Refusal) -> Self {
        CredentialRefusal(crate::credentials::CredentialError::Session(e.0))
    }
}

impl From<SessionError> for CredentialRefusal {
    fn from(e: SessionError) -> Self {
        CredentialRefusal(crate::credentials::CredentialError::Session(e))
    }
}

impl IntoResponse for CredentialRefusal {
    fn into_response(self) -> Response {
        use crate::credentials::CredentialError as E;
        match self.0 {
            e @ (E::PasswordTooShort
            | E::PasswordTooLong
            | E::PasswordIsCommon
            | E::PasswordContainsAddress) => {
                // Not logged: the sentence is about a password the caller supplied, and logging
                // which rule it broke is logging about somebody's password.
                (StatusCode::BAD_REQUEST, format!("{e}\n")).into_response()
            }
            E::TotpRequired => {
                tracing::info!(reason = "totp_required", "credential act refused");
                Refusal::from(SessionError::TotpRequired).into_response()
            }
            // **409 and a sentence, not the uniform sign-in refusal.** This is an
            // authenticated route answering its own session about its own account, and the
            // fact ("you already have an app code") is one the caller holds the session for.
            // A `401 sign-in refused` would read as "your session died" and send the client
            // back to the door. Told plainly, the person learns the answer is ADR-0055
            // decision 8's host command, not a retry. It discloses nothing to anyone who
            // cannot reach the route.
            E::TotpAlreadyEnrolled => {
                tracing::info!(reason = %self.0, "credential act refused");
                (StatusCode::CONFLICT, format!("{}\n", self.0)).into_response()
            }
            // A wrong current password renders as a wrong code does: neither is an
            // integrity alarm, so neither logs at error severity.
            E::CodeRefused | E::TokenRefused | E::NoTotpEnrolled | E::CurrentPasswordRefused => {
                tracing::info!(reason = %self.0, "credential act refused");
                Refusal::from(SessionError::SignInRefused).into_response()
            }
            E::NotAnAccountSession => {
                tracing::info!(reason = %self.0, "not an account session");
                Refusal::from(SessionError::NotATenantPrincipal).into_response()
            }
            E::Malformed(what) => Refusal::from(SessionError::Malformed(what)).into_response(),
            E::Session(e) => Refusal::from(e).into_response(),
            // An integrity alarm is NOT a permission error (§3.4 step 2).
            E::Unverifiable(what) => {
                tracing::error!(reason = %self.0, "integrity check failed");
                Refusal::from(SessionError::Unverifiable(what)).into_response()
            }
            other => {
                tracing::error!(reason = %other, "credential request failed");
                Refusal::from(SessionError::Corrupt("credential plane")).into_response()
            }
        }
    }
}

/// A plain-text refusal at a status other than `sessions.rs`'s uniform 401: wrong
/// or missing code (403), or an already-gone session (404). A 401 here would make
/// `signedFetch.ts`'s `clearOnUnauthorized` sign the caller out of a live tab.
fn refusal_text(status: StatusCode, message: &str) -> Response {
    (status, format!("{message}\n")).into_response()
}

/// A wrong current password or code, wrong token, or unconfirmed authenticator on
/// the credential routes: 403, never the uniform `sign-in refused` 401, since the
/// session making the attempt is alive.
fn credential_check_refused(
    e: crate::credentials::CredentialError,
) -> Result<Response, CredentialRefusal> {
    use crate::credentials::CredentialError as E;
    match e {
        E::CodeRefused | E::TokenRefused | E::NoTotpEnrolled | E::CurrentPasswordRefused => {
            tracing::info!(reason = %e, "credential act refused");
            Ok(refusal_text(
                StatusCode::FORBIDDEN,
                "current credential refused",
            ))
        }
        other => Err(CredentialRefusal(other)),
    }
}

/// The same headers as [`bytes_response`] over an empty body: a 200 with no bytes
/// still answers about one caller's account, so `no-store` applies.
fn empty_response() -> Response {
    (
        StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        Vec::new(),
    )
        .into_response()
}

// ---- Message framing ----

/// Read exactly `n` length-prefixed fields, and refuse anything else.
///
/// **Exactly**, not "at least": a body with a field this server does not read
/// comes from a sender who believes something untrue about the protocol, and the
/// answer is a refusal.
fn read_fields(body: &[u8], n: usize) -> Result<Vec<Vec<u8>>, Refusal> {
    let mut rest = body;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let (field, remainder) =
            crypto::read_lp(rest).ok_or(Refusal::from(SessionError::Malformed("request body")))?;
        out.push(field.to_vec());
        rest = remainder;
    }
    if !rest.is_empty() {
        return Err(SessionError::Malformed("request body").into());
    }
    Ok(out)
}

fn text(field: &[u8], what: &'static str) -> Result<String, Refusal> {
    String::from_utf8(field.to_vec()).map_err(|_| SessionError::Malformed(what).into())
}

fn principal_kind(field: &[u8]) -> Result<PrincipalKind, Refusal> {
    let text = text(field, "principal kind")?;
    PrincipalKind::parse(&text).ok_or_else(|| SessionError::Malformed("principal kind").into())
}

fn thirty_two(field: &[u8], what: &'static str) -> Result<[u8; 32], Refusal> {
    field
        .try_into()
        .map_err(|_| SessionError::Malformed(what).into())
}

/// One `200` carrying bytes, with the two headers every API answer here wants.
///
/// **`Cache-Control: no-store` on all of them.** Nothing here is a document: it
/// is a session, a token's answer, a deployment's state, a design read under one
/// person's authority. A shared cache would hold it stale or offer one caller's
/// bytes to the next.
fn bytes_response(body: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

// ---- Headers ----

fn header_text(headers: &HeaderMap, name: &'static str) -> Result<String, Refusal> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| SessionError::Malformed("request headers").into())
}

fn header_hex(headers: &HeaderMap, name: &'static str) -> Result<Vec<u8>, Refusal> {
    let text = header_text(headers, name)?;
    unhex(&text).ok_or_else(|| SessionError::Malformed("request headers").into())
}

fn header_number(headers: &HeaderMap, name: &'static str) -> Result<i64, Refusal> {
    header_text(headers, name)?
        .parse::<i64>()
        .map_err(|_| SessionError::Malformed("request headers").into())
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

/// Which bucket a sign-in attempt counts against: the address as
/// [`ApiState::client_address`] decides it (why the header is read from the right
/// is in `crate::client_address`).
fn source_of(state: &ApiState, headers: &HeaderMap, extensions: &axum::http::Extensions) -> String {
    state.client_address.of(headers, extensions)
}

// ---- Refusals ----

/// One refusal, on its way to a status code and a short sentence.
///
/// **The sentence is fixed per status and the detail goes to the log.** An
/// explaining refusal would tell an attacker which check they failed, and
/// `SessionError`'s Display is for an operator reading a log.
pub struct Refusal(SessionError);

impl From<SessionError> for Refusal {
    fn from(e: SessionError) -> Self {
        Self(e)
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let (status, body) = match &self.0 {
            SessionError::RateLimited {
                retry_after_seconds,
            } => {
                tracing::warn!(reason = %self.0, "sign-in rate limited");
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    [(
                        axum::http::header::RETRY_AFTER,
                        retry_after_seconds.to_string(),
                    )],
                    "too many attempts\n",
                )
                    .into_response();
            }
            SessionError::Malformed(_) => (StatusCode::BAD_REQUEST, "malformed request\n"),
            SessionError::SignInRefused => {
                tracing::info!(reason = %self.0, "sign-in refused");
                (StatusCode::UNAUTHORIZED, "sign-in refused\n")
            }
            // ADR-0055 stream (a). A password that does not verify answers EXACTLY as a
            // wrong signature or unknown address does (same status, body and absent
            // headers): decision 7's anti-enumeration rule, asserted over the wire by
            // `tests/credentials.rs`.
            SessionError::PasswordRefused => {
                tracing::info!(reason = %self.0, "sign-in refused");
                (StatusCode::UNAUTHORIZED, "sign-in refused\n")
            }
            // A setup session reaching a route it may not. **403, not 401**: the holder IS
            // authenticated, and telling them to authenticate again loops forever.
            //
            // **The sentence** (ADR-0056 decision 4) was `enrol an app code first`; the
            // factor is an *authenticator app* everywhere a person reads it. The client
            // matches either spelling for one release, since a client and server from
            // different builds may run across one restart.
            SessionError::TotpRequired => {
                tracing::info!(reason = %self.0, "an authenticator must be set up first");
                (StatusCode::FORBIDDEN, "set up an authenticator first\n")
            }
            // ADR-0056 decision 3, step one of two-step sign-in. **401 and its own
            // sentence**: no session was issued, so not a 200, and the client must ask for
            // the verification code rather than redraw the first screen with a refusal. The
            // sentence is the client's contract, asserted byte for byte by
            // `scripts/ci/first-operator-signin.mjs`.
            SessionError::SecondFactorNeeded => {
                tracing::info!(reason = %self.0, "a second factor is needed");
                (StatusCode::UNAUTHORIZED, "second factor needed\n")
            }
            SessionError::NotSigned
            | SessionError::NoSuchSession
            | SessionError::SessionRevoked
            | SessionError::Expired
            | SessionError::AccountDisabled
            | SessionError::EvidenceKeyNotInService
            | SessionError::NonceNotFresh
            | SessionError::ClockSkew { .. }
            | SessionError::CounterNotFresh
            | SessionError::TooManyNonces
            | SessionError::Signature(_) => {
                tracing::info!(reason = %self.0, "request not authenticated");
                (StatusCode::UNAUTHORIZED, "not authenticated\n")
            }
            SessionError::NotATenantPrincipal
            | SessionError::Authority(AuthorityError::NotAuthorised)
            | SessionError::Authority(AuthorityError::QuorumNotMet { .. })
            | SessionError::Repo(_) => {
                tracing::info!(reason = %self.0, "not authorised");
                (StatusCode::FORBIDDEN, "not authorised\n")
            }
            // An integrity alarm is NOT a permission error (§3.4 step 2). A 500, because
            // something in the store is not truthful about itself; the log line is the
            // point.
            SessionError::Unverifiable(_)
            | SessionError::Authority(AuthorityError::Unverifiable(_))
            | SessionError::Authority(AuthorityError::Rollback { .. })
            | SessionError::Authority(AuthorityError::GenesisSetMismatch)
            | SessionError::Authority(AuthorityError::OrganisationIdMismatch)
            | SessionError::Corrupt(_) => {
                tracing::error!(reason = %self.0, "integrity check failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "refused\n")
            }
            other => {
                tracing::error!(reason = %other, "request failed");
                (StatusCode::INTERNAL_SERVER_ERROR, "refused\n")
            }
        };
        (status, body).into_response()
    }
}

// ---- ADR-0057 decision 5: the organisation claim ----
//
// Account-plane, not `admin.rs`: the steward who holds the claim redeems it,
// never an operator.

/// Everything `POST /enrolment/organisation` needs.
#[derive(Clone)]
pub struct ClaimApiState {
    pub sessions: Arc<SessionStore>,
    pub operators: Arc<OperatorStore>,
    pub client_address: crate::client_address::ClientAddress,
}

/// The claim route, to `merge` into the main router.
pub fn claim_router(state: ClaimApiState) -> Router {
    Router::new()
        .route(
            "/enrolment/organisation",
            post(redeem_organisation_claim_handler),
        )
        .with_state(state)
}

/// `POST /enrolment/organisation` (ADR-0057 decision 5). `subject` travels on the
/// wire, but `redeem_organisation_claim` refuses any grant whose subject is not
/// the session's own.
async fn redeem_organisation_claim_handler(
    State(state): State<ClaimApiState>,
    request: Request,
) -> Result<Response, Refusal> {
    // Computed before `Signed::from_request_for` consumes the request, as
    // `challenge_handler` and `sign_in_handler` do.
    let source = state
        .client_address
        .of(request.headers(), request.extensions());
    let signed = Signed::from_request_for(request, &state.sessions, &state.client_address).await?;
    let fields = read_fields(&signed.body, 9)?;
    let token = &fields[0];
    let notice_address = text(&fields[1], "notice address")?;
    let root_pubkey = &fields[2];
    if root_pubkey.len() != authority::PUBLIC_KEY_LEN {
        return Err(SessionError::Malformed("organisation root key").into());
    }
    let id_salt: [u8; 16] = fixed_bytes(&fields[3], "organisation id salt")?;
    // Kept as text: turning it into an id is
    // `redeem_organisation_claim_over_http`'s job (see its doc).
    let subject_text = text(&fields[4], "grant subject")?;
    let subject_pubkey = &fields[5];
    if subject_pubkey.len() != authority::PUBLIC_KEY_LEN {
        return Err(SessionError::Malformed("account public key").into());
    }
    let effective_from_unix = parse_unix(&fields[6], "grant effective-from")?;
    let expires_at_unix = parse_unix(&fields[7], "grant expiry")?;
    let signature: [u8; 64] = fixed_bytes(&fields[8], "grant signature")?;
    // `0011`'s CHECK refuses an inverted window in the database; checked here too,
    // plus `effective_from > 0`, for this route's own 400.
    if !(effective_from_unix > 0 && effective_from_unix < expires_at_unix) {
        return Err(SessionError::Malformed("grant time window").into());
    }

    // The per-source budget the unauthenticated redemption routes spend
    // (`admin.rs`): the claim token is a bearer secret too.
    state
        .sessions
        .check_source_budget(PrincipalKind::Steward, &source)
        .await?;

    let mut client = state
        .sessions
        .pool()
        .get()
        .await
        .map_err(|e| Refusal::from(SessionError::Pool(e)))?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    let result: Result<VerifiedSession, Refusal> = async {
        let session = state.sessions.verify_pending(&tx, &signed.pending).await?;
        // ADR-0057 decision 7: same transaction as the verification, committed below
        // whether this refuses or not (as `verify_and_commit`), so an ending delete is
        // not lost.
        state
            .sessions
            .check_session_address(&tx, session.id(), &signed.address)
            .await?;
        Ok(session)
    }
    .await;
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    let session = result?;

    let organisation = match state
        .operators
        .redeem_organisation_claim_over_http(
            &session,
            token,
            &notice_address,
            root_pubkey,
            &id_salt,
            &subject_text,
            authority::key_fingerprint(subject_pubkey),
            effective_from_unix,
            expires_at_unix,
            signature,
        )
        .await
    {
        Ok(organisation) => organisation,
        // A refused claim or bad signature is this live session's own act refused, not
        // the session dying: 403, not `SignInRefused`'s 401, which the client reads as
        // "sign this tab out".
        Err(
            e @ (OperatorError::EnrolmentRefused
            | OperatorError::Authority(AuthorityError::Signature(_))),
        ) => {
            tracing::info!(reason = %e, "organisation claim refused");
            return Ok(refusal_text(
                StatusCode::FORBIDDEN,
                "organisation claim refused",
            ));
        }
        Err(e) => return Err(OrganisationClaimRefusal(e).into()),
    };

    let mut out = Vec::with_capacity(32);
    crypto::lp(&mut out, organisation.to_string().as_bytes());
    Ok(bytes_response(out))
}

/// `N` raw bytes, exactly: a length-prefixed field read as a fixed-size array (a
/// key, salt or signature).
fn fixed_bytes<const N: usize>(field: &[u8], what: &'static str) -> Result<[u8; N], Refusal> {
    field
        .try_into()
        .map_err(|_| SessionError::Malformed(what).into())
}

/// A decimal Unix timestamp, LP-wrapped as text like other numeric fields sent
/// beside byte fields.
fn parse_unix(field: &[u8], what: &'static str) -> Result<i64, Refusal> {
    text(field, what)?
        .parse::<i64>()
        .map_err(|_| SessionError::Malformed(what).into())
}

/// One claim refusal, on its way to a status code and a sentence. Uniform, like
/// `admin.rs`'s `AdminRefusal`: ordinary refusals are one sentence; only an
/// integrity failure alarms.
struct OrganisationClaimRefusal(OperatorError);

impl From<OrganisationClaimRefusal> for Refusal {
    fn from(e: OrganisationClaimRefusal) -> Self {
        match e.0 {
            OperatorError::EnrolmentRefused
            | OperatorError::Authority(AuthorityError::Signature(_)) => {
                tracing::info!(reason = %e.0, "organisation claim refused");
                Refusal::from(SessionError::SignInRefused)
            }
            OperatorError::Malformed(what) => Refusal::from(SessionError::Malformed(what)),
            OperatorError::Unverifiable(what) => {
                tracing::error!(reason = %e.0, "integrity check failed");
                Refusal::from(SessionError::Unverifiable(what))
            }
            other => {
                tracing::error!(reason = %other, "organisation claim request failed");
                Refusal::from(SessionError::Corrupt("organisation claim"))
            }
        }
    }
}

impl IntoResponse for OrganisationClaimRefusal {
    fn into_response(self) -> Response {
        Refusal::from(self).into_response()
    }
}
