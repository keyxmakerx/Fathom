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

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{FromRequest, Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use deadpool_postgres::Pool;
use fathom_canon::Json;

use crate::ai::{self, AiError, AiRequest, VerifiedAi};
use crate::grants::{Authority, EpochWatch};
use crate::keys::KeyRing;
use crate::live::Live;
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
}

pub fn router(state: AiApiState) -> Router {
    Router::new()
        .route("/ai/v1/server", get(server_handler))
        .route("/ai/v1/whoami", get(whoami_handler))
        .route("/ai/v1/designs", get(designs_handler))
        .route("/ai/v1/designs/{design}", get(reading_handler))
        .route(
            "/ai/v1/designs/{design}/recommendations",
            get(own_ideas_handler).post(recommend_handler),
        )
        .with_state(state)
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
