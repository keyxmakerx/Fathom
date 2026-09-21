//! **The first HTTP surface**: sign-in, sign-out, nonce issuance, and one
//! protected route that answers what the caller may do on a scope.
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4 (sessions), §3.4
//! (`authorise_account`'s seven steps), §1.4 (no credential in a config file),
//! §13 items 1, 2 and 7. `sessions.rs` holds the rules; this file is the
//! translation between them and HTTP, and deliberately holds none of its own.
//!
//! # The shape every later route composes
//!
//! [`Signed`] is an axum extractor. A handler that names it in its arguments
//! cannot run until a request has carried a fresh single-use nonce and an
//! ES256 signature over its own method, path, body digest, nonce and time, and
//! until the session row's MAC has recomputed under a key that is not in
//! PostgreSQL. A handler that does **not** name it gets no session and no
//! actor, because there is no other extractor in this server that produces
//! either.
//!
//! That is §13 item 1 — *"`actor` comes from a session, never from the
//! caller"* — expressed as a type. The one thing a type cannot stop is a
//! handler parsing an id out of a header and calling `repo::open_tenant_context`
//! itself, so `tests/sessions.rs` reads this file's source and fails if it
//! ever names one.
//!
//! # Why the messages are length-prefixed bytes and not JSON
//!
//! `Cargo.toml` is explicit that axum's `json` feature is absent because it
//! drags `serde` in, and `engine.rs` already answers `text/plain` for that
//! reason. The bodies here carry public keys, nonces and signatures — byte
//! strings, not documents — so they use the length-prefixed framing the rest
//! of this server already signs with (`crypto::lp`, `crypto::read_lp`), and
//! the client assembles them with the same rule. No parser arrives with this
//! surface.
//!
//! # What is NOT here
//!
//! * **No grant endpoints.** `GrantProposal`, `sign_grant`, `second_grant` and
//!   the rest of the authority API stay in-process in this step. §3.8's
//!   closing paragraph names *"everything that changes when a proposal crosses
//!   a real HTTP boundary"* as its own open question, and answering it under a
//!   surface built in the same hour would be answering it by accident.
//! * **No design or vault routes.** They are the next step, and they compose
//!   [`Signed`] exactly as the demonstration route below does.
//! * **No credential of any kind in any file this adds** (§1.4).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequest, Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use deadpool_postgres::Transaction;

use crate::authority::Capability;
use crate::crypto;
use crate::grants::{self, Authority, AuthorityError, EpochWatch};
use crate::keys;
use crate::repo::{OrganisationId, ScopeId};
use crate::sessions::{
    self, PrincipalKind, SessionError, SessionStore, SignedRequest, VerifiedSession,
};

/// Everything the session routes need.
#[derive(Clone)]
pub struct ApiState {
    pub sessions: Arc<SessionStore>,
    /// §3.4 step 3's in-process high-water mark, one per process, held here
    /// because this is the first thing in the server with a request layer to
    /// hold it — `grants::EpochWatch`'s own doc says so.
    pub watch: Arc<EpochWatch>,
    pub ring: Arc<keys::KeyRing>,
    /// How a request's address is decided (`crate::client_address`): the
    /// peer, or a forwarding header believed only from the trusted proxies.
    /// One policy for every route that counts an address, built in `main.rs`.
    pub client_address: crate::client_address::ClientAddress,
}

/// The session routes, ready to `merge` into the main router.
///
/// Separate from `lib::router` rather than folded into `AppState`, because the
/// two have genuinely different needs — `/health` and `/schema/kinds` hold no
/// keys and no session store — and because a router that is merged is a router
/// a test can drive on its own.
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

// ---------------------------------------------------------------------------
// The extractor every protected route composes
// ---------------------------------------------------------------------------

/// A request that arrived with a per-request proof and has **spent its
/// single-use nonce**, ready to be verified inside the handler's own
/// transaction (§4.1 clause (b)).
///
/// # Why the extractor no longer returns a `VerifiedSession`
///
/// Until `0014` it did, and verification therefore ran in a transaction of its
/// own that committed before the handler opened a second one for
/// `open_tenant_context` and `authorise_account`. The disabled-account check,
/// the evidence-key check and grant evaluation never shared a snapshot: an
/// account disabled, a key retired or a grant revoked between the two commits
/// was checked against one state and authorised against another. §3.4's seven
/// steps and §4's *"before setting `app.design_capability`"* both read as one
/// continuous act, and they were two.
///
/// A transaction cannot be carried out of an axum extractor, so the *request*
/// is carried instead and the handler opens one transaction for both halves.
/// **§13 item 1 is untouched**: a [`SessionStore::PendingRequest`] is not an
/// actor and cannot become one, `VerifiedSession` still has private fields and
/// no public constructor, and `sessions::open_tenant_context` is still the only
/// bridge to the repository layer.
///
/// Holds the body as it arrived, because the signature covers its digest and a
/// handler that re-read the body from anywhere else would be acting on bytes
/// nobody signed.
///
/// [`SessionStore::PendingRequest`]: sessions::PendingRequest
pub struct Signed {
    /// The proof, waiting for the transaction that will check it.
    pub pending: sessions::PendingRequest,
    pub body: Bytes,
}

impl Signed {
    /// Run the rest of §4.1 clause (b) **inside `tx`**, so that whatever this
    /// handler authorises next sees the same snapshot the session was verified
    /// against.
    pub async fn verify(
        &self,
        state: &ApiState,
        tx: &Transaction<'_>,
    ) -> Result<VerifiedSession, Refusal> {
        Ok(state.sessions.verify_pending(tx, &self.pending).await?)
    }
}

/// The five headers a signed request carries. Named here rather than inline so
/// that a client library and this file have one list to agree on.
pub const HEADER_SESSION: &str = "fathom-session";
pub const HEADER_TOKEN: &str = "fathom-session-token";
pub const HEADER_NONCE: &str = "fathom-nonce";
pub const HEADER_TIMESTAMP: &str = "fathom-timestamp";
pub const HEADER_COUNTER: &str = "fathom-counter";
pub const HEADER_SIGNATURE: &str = "fathom-signature";

/// How much body a signed request may carry.
///
/// One mebibyte is far more than anything this step posts, and the limit
/// exists because the digest is computed over the whole body: without a bound,
/// an unauthenticated caller chooses how much memory this server spends
/// before the signature that would have refused them is even checked. A design
/// payload route will raise it deliberately, in its own commit, with its own
/// number.
pub const MAX_SIGNED_BODY: usize = 1024 * 1024;

impl Signed {
    /// The extractor's body, **as a function any state type can call**.
    ///
    /// `admin.rs` has its own `State` — it carries an `OperatorStore` that the
    /// session routes have no use for — and axum's `FromRequest` is
    /// implemented per state type. Without this the admin surface would either
    /// re-type the header parsing (two spellings of one protocol, which is how
    /// a signature stops verifying) or borrow `ApiState` and carry fields it
    /// does not use. The rules stay in one place; only the state differs.
    pub async fn from_request_for(
        request: Request,
        sessions: &SessionStore,
    ) -> Result<Self, Refusal> {
        signed_from_request(request, sessions).await
    }
}

impl FromRequest<ApiState> for Signed {
    type Rejection = Refusal;

    /// **Everything a signature covers is taken from the request itself.**
    ///
    /// The method and the path come off the request line, the body digest from
    /// the bytes as they arrived, and the nonce, timestamp and counter from
    /// headers that are themselves inside the signed message. Nothing here
    /// reads a claim about who is calling: the session id names a row, and the
    /// row's public key is what the signature has to verify under.
    ///
    /// **The path is `path_and_query`**, so a query string is signed too.
    /// §4.2 writes `LP(path)`; a query an intermediary may rewrite is part of
    /// what a request asks for, and leaving it outside the signature would be
    /// a hole the first route that takes a filter would fall into.
    async fn from_request(request: Request, state: &ApiState) -> Result<Self, Self::Rejection> {
        signed_from_request(request, &state.sessions).await
    }
}

async fn signed_from_request(request: Request, sessions: &SessionStore) -> Result<Signed, Refusal> {
    {
        let (parts, body) = request.into_parts();
        let method = parts.method.as_str().to_string();
        let path = parts
            .uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| parts.uri.path().to_string());
        let headers = parts.headers;

        // A missing or unreadable header here is `NotSigned`, not
        // `Malformed`: a caller who presented nothing needs to be told to
        // authenticate, and a caller who presented rubbish must not learn
        // which header they got right.
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

        // The nonce is spent here, in its own committed transaction, so that a
        // handler which fails — or which rolls its own transaction back —
        // cannot leave a replayable one behind.
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

        Ok(Signed { pending, body })
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /session/challenge` — §4.2's `server_nonce`, bound to the public key
/// the browser is asking to register.
///
/// Body: `LP(principal_kind) ‖ LP(address) ‖ LP(session_pubkey)`.
/// Answer: `LP(nonce) ‖ LP(deployment_id)`.
///
/// **The answer is the same for an address that belongs to no account**, which
/// is why the refusal is at sign-in and not here.
async fn challenge_handler(
    State(state): State<ApiState>,
    request: Request,
) -> Result<Response, Refusal> {
    // Counted against the source bucket like any other attempt (`0014` §C):
    // this route writes a `session_nonces` row, and until that change one
    // anonymous POST was one permanent row.
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

/// `POST /session` — sign-in.
///
/// Body, **six fields since ADR-0055 decision 10**:
/// `LP(principal_kind) ‖ LP(session_pubkey) ‖ LP(nonce) ‖ LP(evidence_sig)
///  ‖ LP(password) ‖ LP(totp_code)`.
/// Answer, unchanged:
/// `LP(session_id) ‖ LP(token) ‖ u64(expires_at_unix) ‖ LP(account_id)`.
///
/// **`account_id` is appended, not inserted.** ADR-0053 §3: the client
/// stamps it as the actor on every change it makes from here on, so undo can
/// tell its own batches from a colleague's. It is additive on the wire — a
/// client built before this change reads the first three fields and never
/// looks past them, so it keeps working unchanged.
///
/// **This is the one route in this server a password may arrive on**, and
/// §4.5's rule that it may not is reopened by the owner's own decision,
/// recorded in ADR-0055's header and nowhere else. `tests/operators.rs`
/// allowlists exactly this handler and `credentials.rs`'s routes, and still
/// fails the build if a password-shaped field appears in any other handler in
/// `api.rs`, `admin.rs` or `operators.rs`.
///
/// **The count is still exact.** `read_fields(&body, 6)` refuses a body with
/// five fields and a body with seven, so a client built against either shape
/// is told it is wrong rather than having a field silently dropped — which is
/// the same rule that used to be the reason there were four.
async fn sign_in_handler(
    State(state): State<ApiState>,
    request: Request,
) -> Result<Response, Refusal> {
    let source = source_of(&state, request.headers(), request.extensions());
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 6)?;
    let kind = principal_kind(&fields[0])?;
    let nonce = thirty_two(&fields[2], "nonce")?;
    let password = text(&fields[4], "credential")?;
    let totp_code = text(&fields[5], "app code")?;

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
        })
        .await?;

    let mut out = Vec::with_capacity(96);
    crypto::lp(&mut out, signed_in.session_id.as_bytes());
    crypto::lp(&mut out, &signed_in.token);
    crypto::u64_le(&mut out, signed_in.expires_at_unix as u64);
    crypto::lp(&mut out, signed_in.account_id.as_bytes());
    Ok(bytes_response(out))
}

/// `POST /session/nonce` — one single-use nonce for a live session.
///
/// Authenticated by the bearer token, because a signature needs a nonce and
/// the caller has none yet. A nonce authorises nothing on its own.
async fn nonce_handler(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Result<Response, Refusal> {
    let session_id = header_text(&headers, HEADER_SESSION)?;
    let token = header_hex(&headers, HEADER_TOKEN)?;
    let nonce = state
        .sessions
        .issue_request_nonce(&session_id, &token)
        .await?;
    let mut out = Vec::with_capacity(40);
    crypto::lp(&mut out, &nonce);
    Ok(bytes_response(out))
}

/// `DELETE /session` — sign-out, which deletes the row.
///
/// Signed like every other protected route, so signing a session out requires
/// holding that session's private key: an attacker who has only copied the row
/// cannot even end it.
async fn sign_out_handler(
    State(state): State<ApiState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    // One transaction for the verification and the act, so a session cannot be
    // verified against one state and signed out against another.
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
    let session = signed.verify(&state, &tx).await?;
    state.sessions.sign_out_in(&tx, &session).await?;
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    Ok((StatusCode::OK, "signed out\n").into_response())
}

/// `GET /organisations/{organisation}/capability` — the demonstration route,
/// at the organisation scope.
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

/// **The whole chain, end to end, in one route.**
///
/// A verified session becomes a tenant context through the one function that
/// takes a `&VerifiedSession`; the tenant context becomes an `Authority`; and
/// `grants::authorise_account` then runs §3.4's seven steps — the head's seal,
/// the rollback check, the whole authority state against the head's digest,
/// each row's own seal, the organisation id recomputed from its root key, the
/// genesis set against the sealed `org_genesis` entry, and every candidate
/// grant's signature and quorum — before anything is answered.
///
/// It asks for `read`, the weakest capability, and answers with the strongest
/// one actually established, so a steward sees `steward` and a `NotAuthorised`
/// is a real refusal rather than a question about the wrong verb.
///
/// **One transaction, since `0014`.** Verification and authorisation share a
/// snapshot, which is what §3.4's seven steps and §4's *"before setting
/// `app.design_capability`"* have always read as and were not.
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

    let session = signed.verify(state, &tx).await?;
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

    // **It commits, and that changed with `0014`.** The HANDLER still writes
    // nothing — an authorisation is a question, and a question that leaves a
    // row behind is a question that can be answered from the row. What the
    // transaction now also carries is verification's own bookkeeping: the
    // advanced `request_counter`, which is the mark every later nonce is
    // issued against. Rolling that back would leave the mark where it was
    // while the browser's own tally moved on, and the session would stop at
    // `CounterNotFresh` a window later.
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;

    match answer {
        Ok(capabilities) => Ok((
            StatusCode::OK,
            format!("{}\n", capabilities.capability.as_str()),
        )
            .into_response()),
        Err(e) => Err(Refusal::from(SessionError::Authority(e))),
    }
}

// ---------------------------------------------------------------------------
// ADR-0055 stream (a) — the credential routes
//
// Added at the END of this file's handlers, with their own state and their own
// router, so the other two ADR-0055 streams' additions land beside them and the
// merge is mechanical.
//
// **Their own state rather than a widened `ApiState`.** `admin.rs` already set
// the precedent and the argument is the same: `ApiState` is constructed in
// seven places, none of which has any use for a `CredentialStore`, and the
// alternative to a second state type is either seven edits or an `Option` field
// that a route has to unwrap at request time.
//
// **They are NOT behind `admin_exposure`.** Every route below is account-plane
// and answers on every host, exactly like `/session` — `AdminExposure::covers`
// matches `/admin*` and the exact path `/enrolment/operator`, and
// `/enrolment/operator/setup` is neither. The lead's resolution 8 is explicit
// that `admin_exposure` is not widened by this stream, and a setup screen a
// person reaches from the address the token file was handed to them at is the
// account plane's, not the console's. **Reported as a judgement, not a
// certainty**: a reader who thinks the first operator's setup belongs on the
// console host should reopen it with stream (c), which owns that module.
// ---------------------------------------------------------------------------

/// Everything the credential routes need.
#[derive(Clone)]
pub struct CredentialApiState {
    pub sessions: Arc<SessionStore>,
    pub credentials: Arc<crate::credentials::CredentialStore>,
    /// For `POST /enrolment/operator/setup` only, which spends a
    /// `purpose = 'setup'` enrolment token through the operator plane's own
    /// seal and expiry checks rather than a second copy of them.
    pub operators: Arc<crate::operators::OperatorStore>,
    pub client_address: crate::client_address::ClientAddress,
}

/// The credential routes, ready to `merge` into the main router.
pub fn credential_router(state: CredentialApiState) -> Router {
    Router::new()
        .route("/credentials/password", post(set_password_handler))
        .route("/credentials/key", post(register_key_handler))
        .route("/credentials/totp/enrol", post(enrol_totp_handler))
        .route("/credentials/totp/confirm", post(confirm_totp_handler))
        .route("/credentials/reset", post(request_reset_handler))
        .route("/credentials/reset/redeem", post(redeem_reset_handler))
        .route("/enrolment/operator/setup", post(operator_setup_handler))
        .with_state(state)
}

impl FromRequest<CredentialApiState> for Signed {
    type Rejection = Refusal;

    async fn from_request(
        request: Request,
        state: &CredentialApiState,
    ) -> Result<Self, Self::Rejection> {
        signed_from_request(request, &state.sessions).await
    }
}

/// Verify a credential route's session inside one transaction, run the act,
/// and commit — the shape every signed route in this server uses.
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
    let session = state.sessions.verify_pending(&tx, &signed.pending).await?;
    // The advanced `request_counter` is committed whatever the act does next,
    // for the reason `capability` above states: rolling it back would leave
    // the mark where it was while the browser's own tally moved on.
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    Ok(session)
}

/// `POST /credentials/password` — set or change this session's own password.
///
/// Body: `LP(new_credential)`. Answer: 200, empty.
async fn set_password_handler(
    State(state): State<CredentialApiState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verified(&state, &signed).await?;
    let fields = read_fields(&signed.body, 1)?;
    let chosen = text(&fields[0], "credential")?;
    state
        .credentials
        .set_password(&session, &chosen)
        .await
        .map_err(CredentialRefusal)?;
    Ok(empty_response())
}

/// `POST /credentials/key` — register this browser's long-term key.
///
/// Body: `LP(public_key)`. Answer: `LP(key_id)`.
async fn register_key_handler(
    State(state): State<CredentialApiState>,
    signed: Signed,
) -> Result<Response, Refusal> {
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

/// `POST /credentials/totp/enrol` — draw an app-code secret.
///
/// Body: empty. Answer: `LP(otpauth_uri) ‖ LP(secret_base32)`.
async fn enrol_totp_handler(
    State(state): State<CredentialApiState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verified(&state, &signed).await?;
    let _ = read_fields(&signed.body, 0)?;
    let enrolment = state
        .credentials
        .enrol_totp(&session)
        .await
        .map_err(CredentialRefusal)?;
    let mut out = Vec::with_capacity(256);
    crypto::lp(&mut out, enrolment.otpauth_uri.as_bytes());
    crypto::lp(&mut out, enrolment.secret_base32.as_bytes());
    Ok(bytes_response(out))
}

/// `POST /credentials/totp/confirm` — prove the app code works.
///
/// Body: `LP(app_code)`. Answer: ten `LP(backup_code)` fields, once.
async fn confirm_totp_handler(
    State(state): State<CredentialApiState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verified(&state, &signed).await?;
    let fields = read_fields(&signed.body, 1)?;
    let code = text(&fields[0], "app code")?;
    let codes = state
        .credentials
        .confirm_totp(&session, &code)
        .await
        .map_err(CredentialRefusal)?;
    let mut out = Vec::with_capacity(256);
    for code in &codes {
        crypto::lp(&mut out, code.as_bytes());
    }
    Ok(bytes_response(out))
}

/// `POST /credentials/reset` — *"forgot my password"*.
///
/// Body: `LP(address)`. Answer: **200, empty, always** — ADR-0055 decision 7
/// and OWASP ASVS 5.0.0 6.3.8 as the ADR read them on 2026-09-21. The refusal
/// paths above it are the rate limits, which answer the same way for every
/// address.
async fn request_reset_handler(
    State(state): State<CredentialApiState>,
    request: Request,
) -> Result<Response, Refusal> {
    let source = state
        .client_address
        .of(request.headers(), request.extensions());
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 1)?;
    let address = text(&fields[0], "address")?;

    // The same `sign_in_attempts` source bucket `/session` spends, reached
    // through the function §13 item 7 already built for callers that are not a
    // sign-in. A source that has spent its budget guessing addresses at
    // `/session` has spent it here too.
    state
        .sessions
        .check_source_budget(PrincipalKind::Steward, &source)
        .await?;
    state
        .credentials
        .request_reset(&address, &source)
        .await
        .map_err(CredentialRefusal)?;
    Ok(empty_response())
}

/// `POST /credentials/reset/redeem` — spend a reset token, set a password.
///
/// Body: `LP(token) ‖ LP(new_credential)`. Answer: 200, empty. **No session**:
/// decision 7's *"no automatic sign-in"*, from the OWASP Forgot Password Cheat
/// Sheet as ADR-0055 read it.
async fn redeem_reset_handler(
    State(state): State<CredentialApiState>,
    request: Request,
) -> Result<Response, Refusal> {
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

/// `POST /enrolment/operator/setup` — the first operator's setup screen.
///
/// Body: `LP(token) ‖ LP(new_credential)`. Answer: **200, empty, and no
/// session** — the lead's resolution 4: the client signs in with `POST
/// /session` immediately afterwards, which is one more round trip and one
/// fewer way for a token to become a session without the password being
/// checked.
async fn operator_setup_handler(
    State(state): State<CredentialApiState>,
    request: Request,
) -> Result<Response, Refusal> {
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
        .redeem_setup(&state.operators, &fields[0], &chosen)
        .await
        .map_err(CredentialRefusal)?;
    Ok(empty_response())
}

/// One credential-plane refusal, on its way to a status code and a sentence.
///
/// **The password policy explains itself and nothing else does.** A policy
/// refusal is a statement about a password the caller just chose and already
/// holds, so it discloses nothing; every other refusal here goes through
/// [`Refusal`], whose sentence is fixed per status for the reason its own doc
/// gives.
pub struct CredentialRefusal(pub crate::credentials::CredentialError);

impl IntoResponse for CredentialRefusal {
    fn into_response(self) -> Response {
        use crate::credentials::CredentialError as E;
        match self.0 {
            e @ (E::PasswordTooShort
            | E::PasswordTooLong
            | E::PasswordIsCommon
            | E::PasswordContainsAddress) => {
                // Not logged at all: the sentence is about a password the
                // caller supplied, and a log line naming which rule it broke
                // is a log line about somebody's password.
                (StatusCode::BAD_REQUEST, format!("{e}\n")).into_response()
            }
            E::TotpRequired => {
                tracing::info!(reason = "totp_required", "credential act refused");
                Refusal::from(SessionError::TotpRequired).into_response()
            }
            E::CodeRefused | E::TokenRefused | E::NoTotpEnrolled | E::TotpAlreadyEnrolled => {
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

impl From<CredentialRefusal> for Refusal {
    fn from(e: CredentialRefusal) -> Self {
        Refusal::from(SessionError::Corrupt(match e.0 {
            crate::credentials::CredentialError::Unverifiable(what) => what,
            _ => "credential plane",
        }))
    }
}

fn empty_response() -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        Vec::new(),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Message framing
// ---------------------------------------------------------------------------

/// Read exactly `n` length-prefixed fields, and refuse anything else.
///
/// **Exactly**, not "at least": a body with a field this server does not read
/// is a body whose sender believes something about this protocol that is not
/// true, and the honest answer to that is a refusal rather than silence.
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

fn bytes_response(body: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        body,
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

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

/// Which bucket a sign-in attempt is counted against: the request's address
/// as [`ApiState::client_address`] decides it. The rule, and why the header's
/// entries are read from the right, is in `crate::client_address`.
fn source_of(state: &ApiState, headers: &HeaderMap, extensions: &axum::http::Extensions) -> String {
    state.client_address.of(headers, extensions)
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/// One refusal, on its way to a status code and a short sentence.
///
/// **The sentence is fixed per status and the detail goes to the log.** A
/// refusal that explained itself would tell an attacker which of the checks
/// they failed, and `SessionError`'s own Display is written for an operator
/// reading a log line, not for the network.
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
            // ADR-0055 stream (a). A password that does not verify answers
            // EXACTLY as a wrong signature and an unknown address do — the
            // same status, the same body, the same absent headers — which is
            // decision 7's anti-enumeration rule and what
            // `tests/credentials.rs` asserts over the wire.
            SessionError::PasswordRefused => {
                tracing::info!(reason = %self.0, "sign-in refused");
                (StatusCode::UNAUTHORIZED, "sign-in refused\n")
            }
            // A setup session reaching a route it may not. **403 and not 401**:
            // the holder IS authenticated, and telling them to authenticate
            // again would send them round a loop that cannot end.
            SessionError::TotpRequired => {
                tracing::info!(reason = %self.0, "an app code must be enrolled first");
                (StatusCode::FORBIDDEN, "enrol an app code first\n")
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
            // An integrity alarm is NOT a permission error (§3.4 step 2) and
            // must not render as one. It is a 500 because something in the
            // store is not telling the truth about itself, and the log line is
            // the point.
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
