//! The AI router: `/ai/v1/*` and nothing else (ADR-0072 decision 2).
//!
//! An AI request carries no session. It is signed by a key its person's own computer made
//! (`client/public/fathom-ai.mjs`, which the server hands out at `/fathom-ai.mjs`), and its extractor, [`AiSigned`], builds an `ai::VerifiedAi`, which
//! is not a `sessions::VerifiedSession` and cannot be made into one. So no route outside this
//! file can be reached with it: every other router's extractor wants a session's headers and
//! answers `not signed` without them. `tests/ai_access.rs` drives that.
//!
//! Five routes, all reads but one, and the one write is a recommendation that a person
//! decides on in the client:
//!
//! - `GET  /ai/v1/server`: this server's id, which every request signs over. Unsigned: the
//!   id binds a request to one server and is no secret (`POST /session/challenge` gives it
//!   too); the helper asks once.
//! - `GET  /ai/v1/whoami`: which organisation, what this key may see, until when.
//! - `GET  /ai/v1/designs`: the designs its owner can read inside its folders.
//! - `GET  /ai/v1/designs/{design}`: one design, as `ai_reading` lets it leave.
//! - `GET  /ai/v1/designs/{design}/recommendations`: what this key recommended there.
//! - `POST /ai/v1/designs/{design}/recommendations`: recommend; canonical JSON body.
//!
//! With `FATHOM_AI_PUBLIC_URL` set, the connector's routes too (ADR-0072 decisions 13 to
//! 20; `crate::oauth`, `crate::mcp`). None of them takes a session either:
//!
//! - `GET  /.well-known/oauth-protected-resource[/mcp]`, `GET
//!   /.well-known/oauth-authorization-server`: where to sign in (RFC 9728, RFC 8414);
//! - `POST /oauth/register`: an app that is not Claude registers (RFC 7591);
//! - `POST /oauth/authorize/check`: the sign-in page asks what an app's request is before
//!   the person decides; it answers the app's name and where it returns to, nothing more.
//!   Allow itself is a signed session request (`design_api::ai_routes`);
//! - `POST /oauth/token`: a code or a refresh token for tokens;
//! - `POST /mcp`: the tools, with a bearer token.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequest, Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use deadpool_postgres::Pool;
use fathom_canon::Json;

use crate::ai::{self, AiError, AiRequest, VerifiedAi};
use crate::grants::{Authority, EpochWatch};
use crate::keys::KeyRing;
use crate::live::Live;
use crate::oauth::{BearerRefusal, Connector, OAuthError, Refusal};
use crate::repo::DesignId;

/// The most an AI request body may be: one recommendation is a few kilobytes.
pub const MAX_BODY: usize = 64 * 1024;

#[derive(Clone)]
pub struct AiApiState {
    pub pool: Pool,
    pub ring: Arc<KeyRing>,
    pub watch: Arc<EpochWatch>,
    pub live: Arc<Live>,
    pub client_address: crate::client_address::ClientAddress,
    /// The connector's settings; `None` and its routes do not exist.
    pub connector: Option<Arc<Connector>>,
}

pub fn router(state: AiApiState) -> Router {
    let mut router = Router::new()
        .route("/ai/v1/server", get(server_handler))
        .route("/ai/v1/whoami", get(whoami_handler))
        .route("/ai/v1/designs", get(designs_handler))
        .route("/ai/v1/designs/{design}", get(reading_handler))
        .route(
            "/ai/v1/designs/{design}/recommendations",
            get(own_ideas_handler).post(recommend_handler),
        );
    if state.connector.is_some() {
        router = router
            .route(
                "/.well-known/oauth-protected-resource",
                get(protected_resource_handler),
            )
            .route(
                "/.well-known/oauth-protected-resource/mcp",
                get(protected_resource_handler),
            )
            .route(
                "/.well-known/oauth-authorization-server",
                get(authorization_server_handler),
            )
            .route("/oauth/register", post(register_handler))
            .route("/oauth/authorize/check", post(check_handler))
            .route("/oauth/token", post(token_handler))
            .route(
                "/mcp",
                post(mcp_handler)
                    .get(mcp_elsewhere_handler)
                    .delete(mcp_elsewhere_handler),
            );
    }
    router.with_state(state)
}

impl IntoResponse for AiError {
    fn into_response(self) -> Response {
        self.response()
    }
}

/// A request whose four `Fathom-AI-*` headers verified and whose nonce is spent.
pub struct AiSigned {
    verified: VerifiedAi,
    body: Bytes,
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, AiError> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or(AiError::Refused)
}

impl FromRequest<AiApiState> for AiSigned {
    type Rejection = AiError;

    async fn from_request(request: Request, state: &AiApiState) -> Result<Self, Self::Rejection> {
        let (parts, body) = request.into_parts();
        let method = parts.method.as_str().to_string();
        let path = parts
            .uri
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| parts.uri.path().to_string());
        let headers = parts.headers;
        let address = state.client_address.of(&headers, &parts.extensions);

        // A missing or unreadable header is the one refusal, as for a wrong signature.
        let key_id = header(&headers, ai::HEADER_KEY)?.to_string();
        let unix: i64 = header(&headers, ai::HEADER_TIME)?
            .parse()
            .map_err(|_| AiError::Refused)?;
        let nonce: [u8; 32] = ai::unhex(header(&headers, ai::HEADER_NONCE)?)
            .and_then(|v| v.try_into().ok())
            .ok_or(AiError::Refused)?;
        let signature: [u8; 64] = ai::unhex(header(&headers, ai::HEADER_SIGNATURE)?)
            .and_then(|v| v.try_into().ok())
            .ok_or(AiError::Refused)?;
        let body = axum::body::to_bytes(body, MAX_BODY)
            .await
            .map_err(|_| AiError::Malformed("request body too large"))?;

        let verified = ai::verify_request(
            &state.pool,
            &state.ring,
            &AiRequest {
                key_id: &key_id,
                unix,
                nonce,
                signature,
                method: &method,
                path: &path,
                body: &body,
            },
            &address,
        )
        .await?;
        Ok(Self { verified, body })
    }
}

fn json(j: Json) -> Response {
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

fn parse_design(text: &str) -> Result<DesignId, AiError> {
    text.parse().map_err(|_| AiError::NotFound)
}

async fn server_handler(State(state): State<AiApiState>) -> Result<Response, AiError> {
    let client = state.pool.get().await?;
    let deployment: String = client
        .query_opt("SELECT id FROM deployments", &[])
        .await?
        .ok_or(AiError::Unverifiable("no deployment row"))?
        .get(0);
    let mut m = std::collections::BTreeMap::new();
    m.insert("deployment".to_string(), Json::Str(deployment));
    m.insert("api".to_string(), Json::Str("fathom-ai/1".to_string()));
    Ok(json(Json::Obj(m)))
}

async fn whoami_handler(
    State(state): State<AiApiState>,
    signed: AiSigned,
) -> Result<Response, AiError> {
    let mut client = state.pool.get().await?;
    let tx = client.transaction().await?;
    let session = ai::open(&tx, &state.ring, &signed.verified).await?;
    let answer = ai::whoami(&session);
    tx.commit().await?;
    Ok(json(answer))
}

async fn designs_handler(
    State(state): State<AiApiState>,
    signed: AiSigned,
) -> Result<Response, AiError> {
    let mut client = state.pool.get().await?;
    let tx = client.transaction().await?;
    let session = ai::open(&tx, &state.ring, &signed.verified).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &session.ctx,
        tenant_key: &session.tenant_key,
        watch: &state.watch,
    };
    let answer = ai::ai_designs(&tx, &auth, &session.key).await?;
    tx.commit().await?;
    Ok(json(answer))
}

async fn reading_handler(
    State(state): State<AiApiState>,
    Path(design): Path<String>,
    signed: AiSigned,
) -> Result<Response, AiError> {
    let design = parse_design(&design)?;
    let mut client = state.pool.get().await?;
    let tx = client.transaction().await?;
    let session = ai::open(&tx, &state.ring, &signed.verified).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &session.ctx,
        tenant_key: &session.tenant_key,
        watch: &state.watch,
    };
    let answer = ai::ai_reading(&tx, &auth, Some(&state.live.heads), &session, design).await?;
    tx.commit().await?;
    Ok(json(answer))
}

async fn own_ideas_handler(
    State(state): State<AiApiState>,
    Path(design): Path<String>,
    signed: AiSigned,
) -> Result<Response, AiError> {
    let design = parse_design(&design)?;
    let mut client = state.pool.get().await?;
    let tx = client.transaction().await?;
    let session = ai::open(&tx, &state.ring, &signed.verified).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &session.ctx,
        tenant_key: &session.tenant_key,
        watch: &state.watch,
    };
    let found = ai::ai_own_ideas(&tx, &auth, &session, design).await?;
    tx.commit().await?;
    Ok(json(Json::Arr(
        found.iter().map(ai::Idea::to_json).collect(),
    )))
}

async fn recommend_handler(
    State(state): State<AiApiState>,
    Path(design): Path<String>,
    signed: AiSigned,
) -> Result<Response, AiError> {
    let design = parse_design(&design)?;
    let mut client = state.pool.get().await?;
    let tx = client.transaction().await?;
    let session = ai::open(&tx, &state.ring, &signed.verified).await?;
    let auth = Authority {
        ring: &state.ring,
        ctx: &session.ctx,
        tenant_key: &session.tenant_key,
        watch: &state.watch,
    };
    let made = ai::recommend(&tx, &auth, &session, design, &signed.body).await?;
    tx.commit().await?;
    Ok(json(made.to_json()))
}

// ---------------------------------------------------------------------------
// The connector (ADR-0072 decisions 13 to 20)
// ---------------------------------------------------------------------------

/// The most a sign-in, registration or token request may be.
const MAX_OAUTH_BODY: usize = 16 * 1024;

/// The connector's routes are only registered with it set; this is the type's guarantee.
fn connector(state: &AiApiState) -> Result<&Connector, Refusal> {
    state
        .connector
        .as_deref()
        .ok_or(Refusal::Ai(AiError::NotFound))
}

/// An OAuth answer: JSON, never cached (RFC 6749 section 5.1).
fn oauth_json(status: StatusCode, j: Json) -> Response {
    (
        status,
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
            (axum::http::header::PRAGMA, "no-cache"),
        ],
        j.to_canonical_bytes(),
    )
        .into_response()
}

fn refusal(r: Refusal) -> Response {
    let fault = |status: u16, error, description| OAuthError {
        status,
        error,
        description,
    };
    let e = match r {
        Refusal::OAuth(e) => e,
        Refusal::Ai(AiError::NotFound) => return StatusCode::NOT_FOUND.into_response(),
        Refusal::Ai(AiError::Limited) => return AiError::Limited.response(),
        Refusal::Ai(AiError::SiteOff) => fault(
            400,
            "access_denied",
            "AI access is turned off on this server",
        ),
        Refusal::Ai(e) => {
            tracing::error!(reason = %e, "a connector sign-in request failed");
            fault(500, "server_error", "refused")
        }
    };
    oauth_json(
        StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_REQUEST),
        e.to_json(),
    )
}

/// Run a connector handler and answer its refusal the OAuth way.
fn answer(r: Result<Response, Refusal>) -> Response {
    r.unwrap_or_else(refusal)
}

async fn read_body(body: axum::body::Body, max: usize) -> Result<Bytes, Refusal> {
    axum::body::to_bytes(body, max).await.map_err(|_| {
        Refusal::OAuth(OAuthError {
            status: 413,
            error: "invalid_request",
            description: "the request is too large",
        })
    })
}

fn form_of(body: &[u8]) -> Result<std::collections::BTreeMap<String, String>, Refusal> {
    let bad = |description| {
        Refusal::OAuth(OAuthError {
            status: 400,
            error: "invalid_request",
            description,
        })
    };
    let text = std::str::from_utf8(body).map_err(|_| bad("the form is not UTF-8"))?;
    crate::oauth::form(text).map_err(bad)
}

async fn protected_resource_handler(State(state): State<AiApiState>) -> Response {
    answer(connector(&state).map(|c| oauth_json(StatusCode::OK, c.protected_resource())))
}

async fn authorization_server_handler(State(state): State<AiApiState>) -> Response {
    answer(connector(&state).map(|c| oauth_json(StatusCode::OK, c.authorization_server())))
}

async fn register_handler(State(state): State<AiApiState>, body: axum::body::Body) -> Response {
    answer(
        async {
            connector(&state)?;
            let body = read_body(body, MAX_OAUTH_BODY).await?;
            let j = crate::oauth::register(&state.pool, &body).await?;
            Ok(oauth_json(StatusCode::CREATED, j))
        }
        .await,
    )
}

/// `POST /oauth/authorize/check`: the sign-in page's query string as a form body. Answers
/// `{app: {id, name, kind, returnsTo}}` for a request the page may show, or `{error,
/// description, back?}` for one it may not, where `back` is where to send the browser if
/// the app is to hear about it.
async fn check_handler(State(state): State<AiApiState>, body: axum::body::Body) -> Response {
    answer(
        async {
            let c = connector(&state)?;
            let body = read_body(body, MAX_OAUTH_BODY).await?;
            let form = form_of(&body)?;
            let checked = match c
                .check(&state.pool, &crate::oauth::AuthRequest::from_form(&form))
                .await?
            {
                Ok(checked) => checked,
                Err(problem) => return Ok(oauth_json(StatusCode::BAD_REQUEST, problem.to_json())),
            };
            let mut app = std::collections::BTreeMap::new();
            app.insert("id".into(), Json::Str(checked.client.id.clone()));
            app.insert("name".into(), Json::Str(checked.client.name.clone()));
            app.insert("kind".into(), Json::Str(checked.client.app.into()));
            app.insert(
                "returnsTo".into(),
                Json::Str(crate::oauth::redirect_host(&checked.redirect_uri)),
            );
            let mut out = std::collections::BTreeMap::new();
            out.insert("app".into(), Json::Obj(app));
            Ok(oauth_json(StatusCode::OK, Json::Obj(out)))
        }
        .await,
    )
}

async fn token_handler(State(state): State<AiApiState>, request: Request) -> Response {
    answer(
        async {
            let c = connector(&state)?;
            let (parts, body) = request.into_parts();
            let address = state.client_address.of(&parts.headers, &parts.extensions);
            let body = read_body(body, MAX_OAUTH_BODY).await?;
            let form = form_of(&body)?;
            let j = c.token(&state.pool, &state.ring, &form, &address).await?;
            Ok(oauth_json(StatusCode::OK, j))
        }
        .await,
    )
}

/// `GET` and `DELETE /mcp`: this server opens no stream and keeps no session.
async fn mcp_elsewhere_handler() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(axum::http::header::ALLOW, "POST")],
    )
        .into_response()
}

async fn mcp_handler(State(state): State<AiApiState>, request: Request) -> Response {
    let Some(c) = state.connector.as_deref() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (parts, body) = request.into_parts();
    let headers = &parts.headers;
    // DNS rebinding: a browser page on another site may not drive this.
    if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
        let origin = origin.to_str().unwrap_or("").trim_end_matches('/');
        if !origin.eq_ignore_ascii_case(c.issuer())
            && !origin.eq_ignore_ascii_case(c.sign_in_origin())
        {
            return (StatusCode::FORBIDDEN, "that origin may not use /mcp\n").into_response();
        }
    }
    let unauthorised = |error: Option<&str>| {
        (
            StatusCode::UNAUTHORIZED,
            [
                (axum::http::header::WWW_AUTHENTICATE, c.challenge(error)),
                (axum::http::header::CACHE_CONTROL, "no-store".to_string()),
            ],
        )
            .into_response()
    };
    let token = crate::oauth::bearer(
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
    );
    let Some(token) = token else {
        return unauthorised(None);
    };
    let address = state.client_address.of(headers, &parts.extensions);
    let verified = match c
        .verify_bearer(&state.pool, &state.ring, token, &address)
        .await
    {
        Ok(v) => v,
        Err(BearerRefusal::Invalid) => return unauthorised(Some("invalid_token")),
        Err(BearerRefusal::Ai(e)) => return e.response(),
    };
    if let Some(v) = headers.get("mcp-protocol-version") {
        let v = v.to_str().unwrap_or("");
        if !crate::oauth::PROTOCOL_VERSIONS.contains(&v) {
            return (
                StatusCode::BAD_REQUEST,
                "this server does not speak that MCP protocol version\n",
            )
                .into_response();
        }
    }
    let body = match axum::body::to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(_) => return AiError::Malformed("request body too large").response(),
    };
    match crate::mcp::handle(&state, &verified, &body).await {
        crate::mcp::Answer::Accepted => StatusCode::ACCEPTED.into_response(),
        crate::mcp::Answer::Reply(j) => json(j),
        crate::mcp::Answer::Bad(j) => {
            let mut r = json(j);
            *r.status_mut() = StatusCode::BAD_REQUEST;
            r
        }
    }
}
