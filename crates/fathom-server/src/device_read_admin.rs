//! Admin › Settings › Device reading — ADR-0082 §4.4, ADR-0088 item 4.
//!
//! Whether this server reads devices is an environment setting (`FATHOM_DEVICE_READ`, read at
//! start by [`crate::config`]), so the console only shows it and never changes it: changing it is
//! a restart on the host, which `docs/OPERATING.md` describes.
//!
//! `GET /admin/device-read`, operators only. Answer: `{"reader": bool, "server": bool}`, where
//! `server` is whether the operator allowed reading and `reader` whether the reader answered a
//! ping just now. Nothing about any organisation's switch or ranges is in it; those are the
//! Stewards'.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use fathom_canon::Json;

use crate::admin::AdminRefusal;
use crate::api::{Refusal, Signed};
use crate::client_address::ClientAddress;
use crate::device_read::{ping, Transport};
use crate::operators::OperatorError;
use crate::sessions::{PrincipalKind, SessionError, SessionStore};

#[derive(Clone)]
pub struct DeviceReadAdminState {
    pub sessions: Arc<SessionStore>,
    pub client_address: ClientAddress,
    /// `None` when `FATHOM_DEVICE_READ` is off.
    pub reader: Option<Arc<dyn Transport>>,
}

impl axum::extract::FromRequest<DeviceReadAdminState> for Signed {
    type Rejection = Refusal;

    async fn from_request(
        request: Request,
        state: &DeviceReadAdminState,
    ) -> Result<Self, Self::Rejection> {
        Signed::from_request_for(request, &state.sessions, &state.client_address).await
    }
}

pub fn router(state: DeviceReadAdminState) -> Router {
    Router::new()
        .route("/admin/device-read", get(status))
        .with_state(state)
}

/// The answer's body, separate so a test can check it without a server.
pub fn answer(server: bool, reader: bool) -> Json {
    let mut map = std::collections::BTreeMap::new();
    map.insert("reader".to_owned(), Json::Bool(reader));
    map.insert("server".to_owned(), Json::Bool(server));
    Json::Obj(map)
}

async fn status(
    State(state): State<DeviceReadAdminState>,
    signed: Signed,
) -> Result<Response, Refusal> {
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
    let verified: Result<_, Refusal> = async {
        let session = state.sessions.verify_pending(&tx, &signed.pending).await?;
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
    if verified?.kind() != PrincipalKind::Operator {
        return Err(AdminRefusal(OperatorError::NotAnOperator).into());
    }
    let reader = match &state.reader {
        Some(t) => ping(t.as_ref()).await,
        None => false,
    };
    Ok((
        StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        answer(state.reader.is_some(), reader).to_canonical_bytes(),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_says_only_whether_the_server_reads_and_its_reader_answers() {
        assert_eq!(
            answer(true, false).to_canonical_bytes(),
            b"{\"reader\":false,\"server\":true}\n".to_vec()
        );
    }
}
