//! **The operator console's HTTP surface, and the two unauthenticated routes
//! an invitation is redeemed through.**
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.1 (the verbs), §1.3 (every
//! administrative write goes through an application endpoint), §4.5 (no
//! password path), §5.1, §5.3–§5.5, §6.2–§6.3. `operators.rs` holds the rules;
//! this file is the translation between them and HTTP and deliberately holds
//! none of its own.
//!
//! # This module owns its router, and does not touch `api::router`
//!
//! [`router`] returns a `Router` the caller merges. The two surfaces share
//! `api::Signed` — the same extractor, the same five headers, the same
//! per-request signature — because two spellings of one protocol inside one
//! server is how a signature stops verifying the day somebody unifies them.
//!
//! # Every operator route is a signed request by an operator session
//!
//! A handler that names [`api::Signed`] cannot run until the request carried a
//! fresh single-use nonce and an ES256 signature by the key the browser holds,
//! and [`OperatorStore`] refuses anything that is not an operator session
//! after that. §13 item 1 — *"`actor` comes from a session, never from the
//! caller"* — holds here exactly as it does on the account plane: **no route
//! below takes an operator id as a parameter**, and the two that take an id at
//! all take the id of the operator being acted ON.
//!
//! # The two routes with no session, and why they are safe to have
//!
//! `POST /enrolment/account` and `POST /enrolment/operator` are reached by
//! somebody who has an invitation and no key — the whole point of the act is to
//! give them the key a session would need, so requiring one would be a
//! deadlock. What stands in for the session is the token: single-use, expiring,
//! bound to a subject the server chose, and sealed under a key that is not in
//! PostgreSQL. §6.2's residual is named where it lives (`operators.rs`), and
//! `docs/OPEN-QUESTIONS.md` B5 is kept: **nobody self-registers**, because
//! neither route creates anything — both attach a key to a shell an operator
//! made.
//!
//! # No password field, anywhere in this file
//!
//! §4.5 and §5.1. Every body below is a fixed number of length-prefixed
//! fields, and a body carrying one more is refused rather than having the extra
//! ignored — so a client that thinks it is sending a password is told it is
//! wrong rather than having it quietly dropped. `tests/operators.rs` greps this
//! file, `api.rs` and `operators.rs` for the shape of one.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, FromRequest, Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;

use crate::api::{self, Refusal, Signed, MAX_SIGNED_BODY};
use crate::crypto;
use crate::keys;
use crate::operators::{Invitation, OperatorError, OperatorStore};
use crate::sessions::{PrincipalKind, SessionError, SessionStore};

/// Everything the operator console needs.
#[derive(Clone)]
pub struct AdminState {
    pub sessions: Arc<SessionStore>,
    pub operators: Arc<OperatorStore>,
    pub ring: Arc<keys::KeyRing>,
    /// Which header, if any, carries the real client address for the two
    /// unauthenticated redemption routes' source bucket.
    ///
    /// `ApiState::trusted_client_ip_header`'s own field, exactly: `None`
    /// means the peer address, right for a server on the open internet and
    /// wrong behind a reverse proxy that does not overwrite this header on
    /// every request. Wired from the same configuration value in `main.rs`,
    /// because a deployment behind one proxy is behind it for every route.
    pub trusted_client_ip_header: Option<String>,
}

impl FromRequest<AdminState> for Signed {
    type Rejection = Refusal;

    async fn from_request(request: Request, state: &AdminState) -> Result<Self, Self::Rejection> {
        api::Signed::from_request_for(request, &state.sessions).await
    }
}

/// The operator routes, ready to `merge` into the main router.
///
/// **Its own function in its own module**, so that the surface an operator
/// reaches is a thing somebody can read in one file and a test can drive on its
/// own — and so that adding a route here cannot silently widen the account
/// plane's.
pub fn router(state: AdminState) -> Router {
    Router::new()
        // §1.1's verbs.
        .route("/admin/accounts", post(create_account_shell))
        .route(
            "/admin/accounts/{account}/enrolment",
            post(issue_account_enrolment),
        )
        .route(
            "/admin/accounts/{account}/disabled",
            post(set_account_disabled),
        )
        .route("/admin/organisations", post(create_organisation_shell))
        .route(
            "/admin/organisations/{organisation}/grants/{grant}/suspension",
            post(suspend_grant),
        )
        .route(
            "/admin/operators",
            get(list_operators).post(request_operator),
        )
        .route("/admin/operators/{request}/second", post(second_operator))
        .route(
            "/admin/operators/{operator}/disabled",
            post(disable_operator),
        )
        .route("/admin/organisations/list", get(list_organisations))
        // §5.3's settings, behind §5.4's interlock.
        .route("/admin/settings", post(request_setting))
        .route("/admin/settings/{change}/second", post(second_setting))
        .route("/admin/settings/{change}/cancel", post(cancel_setting))
        // The two redemption routes. No session, by necessity — see the module
        // header.
        .route("/enrolment/account", post(redeem_account))
        .route("/enrolment/operator", post(redeem_operator))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// §1.1 — accounts
// ---------------------------------------------------------------------------

/// `POST /admin/accounts` — §1.1's *"create an account shell (email, display
/// name)"*.
///
/// Body: `LP(address) ‖ LP(display_name)`.
/// Answer: `LP(account) ‖ LP(token) ‖ LP(token_id) ‖ u64(expires_at)`.
///
/// **The token is answered once and never again.** There is no route that
/// re-reads it, because the server stores only its hash; a lost invitation is
/// reissued through `/admin/accounts/{account}/enrolment`, which mints a new
/// one and records that it did.
async fn create_account_shell(
    State(state): State<AdminState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    let fields = read_fields(&signed.body, 2)?;
    let address = text(&fields[0], "address")?;
    let display_name = text(&fields[1], "display name")?;

    let invitation = state
        .operators
        .create_account_shell(&session, &address, &display_name)
        .await
        .map_err(AdminRefusal)?;
    Ok(invitation_response(&invitation))
}

/// `POST /admin/accounts/{account}/enrolment` — §1.1's *"initiate an
/// authenticator-enrolment token"*, **which is also §5.1's reset**.
///
/// Body: empty. There is deliberately **no destination field**: §5.1's *"no
/// override field, no operator-supplied destination"*, and the token is bound
/// to the account, whose own address of record redemption checks.
async fn issue_account_enrolment(
    State(state): State<AdminState>,
    Path(account): Path<String>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    read_fields(&signed.body, 0)?;
    let invitation = state
        .operators
        .issue_account_enrolment(&session, &account)
        .await
        .map_err(AdminRefusal)?;
    Ok(invitation_response(&invitation))
}

/// `POST /admin/accounts/{account}/disabled` — §1.1's *"disable / re-enable an
/// account"*.
///
/// Body: `LP("yes" | "no")`.
async fn set_account_disabled(
    State(state): State<AdminState>,
    Path(account): Path<String>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    let fields = read_fields(&signed.body, 1)?;
    let disabled = match text(&fields[0], "disabled flag")?.as_str() {
        "yes" => true,
        "no" => false,
        _ => return Err(SessionError::Malformed("disabled flag").into()),
    };
    state
        .operators
        .set_account_disabled(&session, &account, disabled)
        .await
        .map_err(AdminRefusal)?;
    Ok(ok())
}

// ---------------------------------------------------------------------------
// §6.2 — organisation shells
// ---------------------------------------------------------------------------

/// `POST /admin/organisations` — §6.2's shell and its enrolment claim.
///
/// Body: `LP(display_name)`.
/// Answer: `LP(shell) ‖ LP(token) ‖ LP(token_id) ‖ u64(expires_at)`.
///
/// **There is no route here that redeems the claim**, and that is deliberate:
/// redemption runs §6.1's genesis, which needs a root public key, an id salt
/// and one or more signed genesis grants. `api.rs` already records why no grant
/// crosses this boundary yet — §3.8's *"everything that changes when a proposal
/// crosses a real HTTP boundary"* is its own open question, and answering it
/// under a surface built in the same hour would be answering it by accident.
/// `operators::redeem_organisation_claim` is the act; the route lands with the
/// authority layer's own surface.
async fn create_organisation_shell(
    State(state): State<AdminState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    let fields = read_fields(&signed.body, 1)?;
    let display_name = text(&fields[0], "display name")?;

    let (shell, invitation) = state
        .operators
        .create_organisation_shell(&session, &display_name)
        .await
        .map_err(AdminRefusal)?;
    let mut out = Vec::with_capacity(128);
    crypto::lp(&mut out, shell.as_bytes());
    crypto::lp(&mut out, &invitation.token);
    crypto::lp(&mut out, invitation.id.as_bytes());
    crypto::u64_le(&mut out, invitation.expires_at_unix as u64);
    Ok(bytes_response(out))
}

// ---------------------------------------------------------------------------
// §1.1 — suspension, the one authority-adjacent verb
// ---------------------------------------------------------------------------

/// `POST /admin/grants/{grant}/suspension` — §1.1's *"suspend a scope grant
/// (immediate)"*.
///
/// Body: empty.
///
/// **There is no unsuspend route and there must not be one.** §1.1 gives
/// lifting to the organisation's own stewards; `0011`'s `CHECK` refuses an
/// `unsuspend` row for an operator principal; and `grants` exposes no function
/// an operator could call to write one.
async fn suspend_grant(
    State(state): State<AdminState>,
    Path((organisation, grant)): Path<(String, String)>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    read_fields(&signed.body, 0)?;
    state
        .operators
        .suspend_grant(&session, &organisation, &grant)
        .await
        .map_err(AdminRefusal)?;
    Ok(ok())
}

// ---------------------------------------------------------------------------
// §5.5 — operators
// ---------------------------------------------------------------------------

/// `GET /admin/operators` — the register, with §5.5's sentence beside each row.
///
/// Answer: one line per operator, `id display_name created_by
/// never_independently_signed_in disabled`.
///
/// Applying anything whose delay has elapsed happens here too, because this
/// deployment has no scheduler (`0014` §C's argument for sweeping on the paths
/// that care).
async fn list_operators(
    State(state): State<AdminState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    state
        .operators
        .record_read(&session, "operators")
        .await
        .map_err(AdminRefusal)?;
    state
        .operators
        .apply_due_operator_requests()
        .await
        .map_err(AdminRefusal)?;

    let operators = state
        .operators
        .list_operators()
        .await
        .map_err(AdminRefusal)?;
    let mut out = String::new();
    for operator in &operators {
        out.push_str(&format!(
            "{} {} {} {} {}\n",
            operator.id,
            operator.display_name,
            operator.created_by.as_deref().unwrap_or("-"),
            // §5.5: *"the admin page shows 'created by X, never independently
            // signed in' beside every operator until that stops being true."*
            operator.never_independently_signed_in(),
            operator.disabled_at_unix != 0,
        ));
    }
    Ok((StatusCode::OK, out).into_response())
}

/// `GET /admin/organisations/list` — §1.1's first verb, at the top level.
///
/// §1.2: organisation display names stay readable because support and billing
/// need to know which customer they are looking at; everything below them is
/// opaque ids and shape.
async fn list_organisations(
    State(state): State<AdminState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    state
        .operators
        .record_read(&session, "organisations")
        .await
        .map_err(AdminRefusal)?;
    let rows = state
        .operators
        .list_organisations()
        .await
        .map_err(AdminRefusal)?;
    let mut out = String::new();
    for (id, name) in &rows {
        out.push_str(&format!("{id} {name}\n"));
    }
    Ok((StatusCode::OK, out).into_response())
}

/// `POST /admin/operators` — §5.5's request half.
///
/// Body: `LP(display_name) ‖ LP(assertion)`, where the assertion is over
/// `operators::operator_request_bytes` **signed by the requesting operator's
/// enrolled key** — a different key from the session key, so requesting a
/// colleague is a key touch and not a form submission.
async fn request_operator(
    State(state): State<AdminState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    let fields = read_fields(&signed.body, 2)?;
    let display_name = text(&fields[0], "display name")?;
    let pending = state
        .operators
        .request_operator(&session, &display_name, &fields[1])
        .await
        .map_err(AdminRefusal)?;
    Ok(pending_response(&pending.id, pending.effective_at_unix))
}

/// `POST /admin/operators/{request}/second` — §5.5's second assertion.
///
/// Body: `LP(assertion)` over `operators::operator_second_bytes`.
async fn second_operator(
    State(state): State<AdminState>,
    Path(request_id): Path<String>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    let fields = read_fields(&signed.body, 1)?;
    state
        .operators
        .second_operator(&session, &request_id, &fields[0])
        .await
        .map_err(AdminRefusal)?;
    Ok(ok())
}

/// `POST /admin/operators/{operator}/disabled` — §7.2's `operator_disabled`.
///
/// Body: empty. **There is no re-enable route**: §4.5 re-enrols an operator
/// through §5.4's machinery, and §7.2 names no entry type for the opposite act.
async fn disable_operator(
    State(state): State<AdminState>,
    Path(operator): Path<String>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    read_fields(&signed.body, 0)?;
    state
        .operators
        .disable_operator(&session, &operator)
        .await
        .map_err(AdminRefusal)?;
    Ok(ok())
}

// ---------------------------------------------------------------------------
// §5.3 — settings, behind §5.4's interlock
// ---------------------------------------------------------------------------

/// `POST /admin/settings` — request a change (§5.3).
///
/// Body: `LP(key) ‖ LP(value) ‖ LP(assertion)`.
///
/// **The value is a credential often enough to be treated as one always**:
/// §5.3's *"SMTP credentials are credentials"*. It is sealed before it is
/// stored and never logged.
///
/// **A test send is not here.** §5.3 allows one, to the requesting operator's
/// own verified address, rate-limited and itself a sealed entry — and this
/// build has no mail path at all, so an SMTP form that connected anywhere would
/// be the outbound-connection console §5.3 refuses. The interlock is a property
/// of this path, and sending mail is not what proves it works.
async fn request_setting(
    State(state): State<AdminState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    let fields = read_fields(&signed.body, 3)?;
    let key = text(&fields[0], "setting key")?;
    let pending = state
        .operators
        .request_setting(&session, &key, &fields[1], &fields[2])
        .await
        .map_err(AdminRefusal)?;
    Ok(pending_response(&pending.id, pending.effective_at_unix))
}

/// `POST /admin/settings/{change}/second` — §5.5's second assertion.
///
/// Body: `LP(assertion)` over `operators::setting_second_bytes`.
async fn second_setting(
    State(state): State<AdminState>,
    Path(change): Path<String>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    let fields = read_fields(&signed.body, 1)?;
    state
        .operators
        .second_setting(&session, &change, &fields[0])
        .await
        .map_err(AdminRefusal)?;
    Ok(ok())
}

/// `POST /admin/settings/{change}/cancel` — cancel during the delay (§5.3).
async fn cancel_setting(
    State(state): State<AdminState>,
    Path(change): Path<String>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    read_fields(&signed.body, 0)?;
    state
        .operators
        .cancel_setting(&session, &change)
        .await
        .map_err(AdminRefusal)?;
    Ok(ok())
}

// ---------------------------------------------------------------------------
// Redemption — the two routes with no session
// ---------------------------------------------------------------------------

/// `POST /enrolment/account` — **the act that turns an invitation into a person
/// who can sign in.**
///
/// Body: `LP(token) ‖ LP(address) ‖ LP(session_public_key)`.
///
/// The browser generated the keypair and keeps the private half; this enrols
/// the public half against the account the TOKEN names, after checking that the
/// address the caller claims is that account's own address of record. A token
/// for one address cannot enrol a key for another, whichever of the two the
/// caller controls.
///
/// Every refusal is the same refusal, and the sealed entry carries the reason.
///
/// **Counted against the source bucket, like `/session/challenge` and
/// `/session`.** This route has no session by necessity (the module header
/// says why), which used to mean no rate limit and no lockout at all: a
/// leaked token's whole 72-hour life was free, unlimited address guessing.
/// [`SessionStore::check_source_budget`] is the same limiter §13 item 7
/// already built, reached from a caller that is not a sign-in; past the cap
/// this answers exactly what `/session` does — the same status, the same
/// `Retry-After`.
async fn redeem_account(
    State(state): State<AdminState>,
    request: Request,
) -> Result<Response, Refusal> {
    let source = source_of(&state, request.headers(), request.extensions());
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 3)?;
    let address = text(&fields[1], "address")?;
    state
        .sessions
        .check_source_budget(PrincipalKind::Steward, &source)
        .await?;
    let key = state
        .operators
        .redeem_account_enrolment(&fields[0], &address, &fields[2])
        .await
        .map_err(AdminRefusal)?;
    let mut out = Vec::with_capacity(48);
    crypto::lp(&mut out, key.as_bytes());
    Ok(bytes_response(out))
}

/// `POST /enrolment/operator` — an operator's first key (§5.5, §6.3).
///
/// Body: `LP(token) ‖ LP(public_key)`.
///
/// **No operator id field**: the operator is the one the token names, so a
/// token issued for one operator cannot enrol a key for another.
///
/// Counted against the source bucket exactly as [`redeem_account`] is — see
/// its own doc comment.
async fn redeem_operator(
    State(state): State<AdminState>,
    request: Request,
) -> Result<Response, Refusal> {
    let source = source_of(&state, request.headers(), request.extensions());
    let body = axum::body::to_bytes(request.into_body(), MAX_SIGNED_BODY)
        .await
        .map_err(|_| Refusal::from(SessionError::Malformed("request body")))?;
    let fields = read_fields(&body, 2)?;
    state
        .sessions
        .check_source_budget(PrincipalKind::Operator, &source)
        .await?;
    let key = state
        .operators
        .redeem_operator_enrolment(&fields[0], &fields[1])
        .await
        .map_err(AdminRefusal)?;
    let mut out = Vec::with_capacity(48);
    crypto::lp(&mut out, key.as_bytes());
    Ok(bytes_response(out))
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/// Run the rest of §4.1 clause (b) and hand back the verified session.
///
/// **A transaction of its own**, unlike the capability route in `api.rs`: none
/// of the verbs here reaches a design payload or a tenant context, and each of
/// them opens its own transaction inside `operators.rs` where the act and its
/// chain entry commit together. What must share a snapshot — the operator
/// register's disabled flag and the act — does, inside that transaction; what
/// this proves is that the request was signed by the session's own key.
async fn verify(
    state: &AdminState,
    signed: &Signed,
) -> Result<crate::sessions::VerifiedSession, Refusal> {
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
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    Ok(session)
}

/// Which bucket a redemption attempt is counted against.
///
/// `api::source_of`'s shape exactly, repeated here rather than shared,
/// because it reads one field off a different state type — `firmware.rs`
/// already made the same choice for the same reason, and its own doc comment
/// names `api::source_of` as the shape it mirrors. The peer address unless
/// [`AdminState::trusted_client_ip_header`] is configured: a header a client
/// can set is a rate limit a client can evade.
fn source_of(
    state: &AdminState,
    headers: &HeaderMap,
    extensions: &axum::http::Extensions,
) -> String {
    if let Some(name) = &state.trusted_client_ip_header {
        if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
            // The first entry of a comma-separated list is the client in
            // every forwarding convention; the rest are proxies.
            let first = value.split(',').next().unwrap_or("").trim();
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Read exactly `n` length-prefixed fields, and refuse anything else.
///
/// **Exactly**, not "at least" — `api.rs`'s rule, restated because it is the
/// structural half of §4.5's claim: a body with a field this server does not
/// read is a body whose sender believes something about this protocol that is
/// not true, and a password quietly ignored is a password somebody thinks was
/// accepted.
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

fn invitation_response(invitation: &Invitation) -> Response {
    let mut out = Vec::with_capacity(128);
    crypto::lp(&mut out, invitation.subject.as_bytes());
    crypto::lp(&mut out, &invitation.token);
    crypto::lp(&mut out, invitation.id.as_bytes());
    crypto::u64_le(&mut out, invitation.expires_at_unix as u64);
    bytes_response(out)
}

fn pending_response(id: &str, effective_at_unix: i64) -> Response {
    let mut out = Vec::with_capacity(64);
    crypto::lp(&mut out, id.as_bytes());
    crypto::u64_le(&mut out, effective_at_unix as u64);
    bytes_response(out)
}

fn bytes_response(body: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        body,
    )
        .into_response()
}

fn ok() -> Response {
    (StatusCode::OK, "done\n").into_response()
}

/// One operator-plane refusal, on its way to a status code and a short
/// sentence.
///
/// **The sentence is fixed per status and the detail goes to the log**, for
/// `api::Refusal`'s reason: a refusal that explained itself would tell an
/// attacker which check they failed. The one distinction that IS made at the
/// status code is between a permission answer and an integrity alarm, because
/// §3.4 is explicit that an alarm must never render as a permission error.
pub struct AdminRefusal(pub OperatorError);

impl From<AdminRefusal> for Refusal {
    fn from(e: AdminRefusal) -> Self {
        match e.0 {
            // Not authenticated as an operator at all.
            OperatorError::NotAnOperator => {
                tracing::info!(reason = %e.0, "not an operator");
                Refusal::from(SessionError::NotATenantPrincipal)
            }
            OperatorError::OperatorDisabled => {
                tracing::info!(reason = %e.0, "operator disabled");
                Refusal::from(SessionError::AccountDisabled)
            }
            OperatorError::EnrolmentRefused => {
                tracing::info!(reason = %e.0, "enrolment refused");
                Refusal::from(SessionError::SignInRefused)
            }
            OperatorError::Signature(refused) => {
                tracing::info!(reason = %refused, "operator assertion refused");
                Refusal::from(SessionError::Signature(refused))
            }
            OperatorError::NoOperatorKey => {
                tracing::info!(reason = %e.0, "operator has no enrolled key");
                Refusal::from(SessionError::SignInRefused)
            }
            OperatorError::SecondedByTheRequester
            | OperatorError::NotYetEffective
            | OperatorError::AlreadyBootstrapped => {
                tracing::info!(reason = %e.0, "operator act refused");
                Refusal::from(SessionError::NotATenantPrincipal)
            }
            OperatorError::Malformed(what) => Refusal::from(SessionError::Malformed(what)),
            OperatorError::NotFound(what) => {
                tracing::info!(what, "no such thing");
                Refusal::from(SessionError::Malformed(what))
            }
            // Integrity alarms. NOT permission errors (§3.4 step 2).
            OperatorError::Unverifiable(what) => {
                tracing::error!(reason = %e.0, "integrity check failed");
                Refusal::from(SessionError::Unverifiable(what))
            }
            OperatorError::SettingUnresolvable => {
                tracing::error!(reason = %e.0, "a settings row does not stand up to its entry");
                Refusal::from(SessionError::Unverifiable("settings row"))
            }
            other => {
                tracing::error!(reason = %other, "operator request failed");
                Refusal::from(SessionError::Corrupt("operator plane"))
            }
        }
    }
}

impl IntoResponse for AdminRefusal {
    fn into_response(self) -> Response {
        Refusal::from(self).into_response()
    }
}
