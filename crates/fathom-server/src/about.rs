//! "About this Fathom" (sign-off cards r134-reddit-ideas and r135-about-page, approved
//! 2026-11-14).
//!
//! `GET /about`, anyone signed in (an account or an operator). It says which build is running
//! and which outside connections this server has switched on, so the people whose data it holds
//! can see where it may go. `docs/IS-IT-SAFE.md` is the written twin of this answer.
//!
//! What it carries, and what it leaves out on purpose (card r135, question 3, A: everyone sees
//! on or off, with no addresses):
//!
//! - `version`, and `commit` and `built` when the image was stamped at build time
//!   (`FATHOM_COMMIT` and `FATHOM_BUILT`, `deploy/Dockerfile`; empty in a development build);
//! - one boolean per outside connection in `docs/IS-IT-SAFE.md`'s table, read from the
//!   configuration the server started with, never a host name, a range, a path or a key;
//! - `reader`, whether the device reader answered a ping just now. The ping reads nothing from
//!   any device (`device_read::ping`).
//!
//! Nothing here is per organisation: a Steward's device-reading ranges are theirs, not this
//! page's.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use fathom_canon::Json;

use crate::api::{Refusal, Signed};
use crate::client_address::ClientAddress;
use crate::device_read::{ping, Transport};
use crate::sessions::{SessionError, SessionStore};

/// The commit this binary was built from, when the build stamped one. Read at compile time, so
/// a running server cannot be talked into reporting another.
pub const COMMIT: Option<&str> = option_env!("FATHOM_COMMIT");
/// When the stamped commit was made (ISO 8601), when the build stamped one.
pub const BUILT: Option<&str> = option_env!("FATHOM_BUILT");

/// Which outside connections this server was started with. Booleans only: card r135 lets
/// everyone signed in see these, so nothing in here may name a host, a range or a secret.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Connections {
    /// `FATHOM_DEVICE_READ=on` and a reader socket configured.
    pub device_read: bool,
    /// `FATHOM_OUTSIDE_VAULT_HOSTS` set (Vaultwarden, Delinea).
    pub outside_vaults: bool,
    /// The Passbolt helper configured (`FATHOM_PASSBOLT_HELPER`).
    pub passbolt: bool,
    /// An off-site copy has reported into the backups volume (the `offsite` profile). Filled in
    /// per request from [`AboutState::backup_dir`].
    pub offsite_backup: bool,
    /// `FATHOM_AUDIT_SYSLOG` set.
    pub audit_syslog: bool,
    /// `FATHOM_ACCESS_SYSLOG` set.
    pub access_syslog: bool,
    /// `FATHOM_TERMIX_URL` set. The browser talks to Termix; the server does not.
    pub termix: bool,
}

#[derive(Clone)]
pub struct AboutState {
    pub sessions: Arc<SessionStore>,
    pub client_address: ClientAddress,
    pub connections: Connections,
    /// `None` when device reading is off.
    pub reader: Option<Arc<dyn Transport>>,
    /// The backups volume (`FATHOM_BACKUP_DIR`), asked on each request whether an off-site copy
    /// has reported, since that profile can start after the server.
    pub backup_dir: Option<std::path::PathBuf>,
}

impl axum::extract::FromRequest<AboutState> for Signed {
    type Rejection = Refusal;

    async fn from_request(request: Request, state: &AboutState) -> Result<Self, Self::Rejection> {
        Signed::from_request_for(request, &state.sessions, &state.client_address).await
    }
}

pub fn router(state: AboutState) -> Router {
    Router::new().route("/about", get(about)).with_state(state)
}

/// Whether the backups volume holds an off-site copy's report. The server mounts that volume
/// read-only (`backup_status.rs`) and only asks whether the file is there.
pub fn offsite_reported(backup_dir: Option<&std::path::Path>) -> bool {
    backup_dir.is_some_and(|d| d.join("offsite").is_file())
}

/// The answer's body, separate so a test can check it without a server.
pub fn answer(connections: Connections, reader: bool) -> Json {
    let text = |s: Option<&str>| Json::Str(s.unwrap_or("").to_owned());
    let mut conn = BTreeMap::new();
    conn.insert(
        "access_syslog".to_owned(),
        Json::Bool(connections.access_syslog),
    );
    conn.insert(
        "audit_syslog".to_owned(),
        Json::Bool(connections.audit_syslog),
    );
    conn.insert(
        "device_read".to_owned(),
        Json::Bool(connections.device_read),
    );
    conn.insert(
        "offsite_backup".to_owned(),
        Json::Bool(connections.offsite_backup),
    );
    conn.insert(
        "outside_vaults".to_owned(),
        Json::Bool(connections.outside_vaults),
    );
    conn.insert("passbolt".to_owned(), Json::Bool(connections.passbolt));
    conn.insert("termix".to_owned(), Json::Bool(connections.termix));
    let mut map = BTreeMap::new();
    map.insert("built".to_owned(), text(BUILT));
    map.insert("commit".to_owned(), text(COMMIT));
    map.insert("connections".to_owned(), Json::Obj(conn));
    map.insert("reader".to_owned(), Json::Bool(reader));
    map.insert(
        "version".to_owned(),
        Json::Str(env!("CARGO_PKG_VERSION").to_owned()),
    );
    Json::Obj(map)
}

async fn about(State(state): State<AboutState>, signed: Signed) -> Result<Response, Refusal> {
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
    let verified: Result<(), Refusal> = async {
        let session = state.sessions.verify_pending(&tx, &signed.pending).await?;
        state
            .sessions
            .check_session_address(&tx, session.id(), &signed.address)
            .await?;
        Ok(())
    }
    .await;
    tx.commit()
        .await
        .map_err(|e| Refusal::from(SessionError::Db(e)))?;
    verified?;
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
        answer(
            Connections {
                offsite_backup: offsite_reported(state.backup_dir.as_deref()),
                ..state.connections
            },
            reader,
        )
        .to_canonical_bytes(),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_names_no_host_range_or_secret() {
        let all_on = Connections {
            device_read: true,
            outside_vaults: true,
            passbolt: true,
            offsite_backup: true,
            audit_syslog: true,
            access_syslog: true,
            termix: true,
        };
        let body = String::from_utf8(answer(all_on, true).to_canonical_bytes()).unwrap();
        // Every connection value is a boolean: the only strings are the build's own facts.
        let Json::Obj(map) = answer(all_on, true) else {
            panic!("not an object")
        };
        let Some(Json::Obj(conn)) = map.get("connections") else {
            panic!("no connections")
        };
        assert_eq!(conn.len(), 7);
        assert!(conn.values().all(|v| matches!(v, Json::Bool(true))));
        assert!(body.contains("\"version\":\""));
        assert!(body.contains("\"reader\":true"));
    }

    #[test]
    fn everything_off_by_default() {
        let body =
            String::from_utf8(answer(Connections::default(), false).to_canonical_bytes()).unwrap();
        assert!(!body.contains("true"));
    }

    #[test]
    fn an_offsite_copy_counts_only_when_its_report_is_there() {
        let dir = std::env::temp_dir().join(format!("fathom-about-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!offsite_reported(Some(&dir)));
        std::fs::write(dir.join("offsite"), b"offsite_at 2026-11-14\n").unwrap();
        assert!(offsite_reported(Some(&dir)));
        assert!(!offsite_reported(None));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
