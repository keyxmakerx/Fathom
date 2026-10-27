//! What the Backups panel in Admin › Settings shows — ADR-0070.
//!
//! The nightly service (`deploy/backup-loop.sh`) writes `status` into the
//! backups volume, and `keys-file --record` writes `keys-file` beside it. The
//! server mounts that volume read-only and only reads: it cannot make a backup
//! (it has no `pg_dump`) and it never holds a keys file. When the `offsite`
//! profile runs, its copy to S3-compatible storage writes `offsite` there too,
//! `offsite_*` lines that are answered as part of the status.
//!
//! `GET /admin/backups`, operators only. Answer, five length-prefixed fields:
//! `LP(status) ‖ LP(keys-file record) ‖ LP(current key ids) ‖ LP(data files)
//! ‖ LP(notices)`. The first three are `name value` lines, the files are
//! `name bytes` lines, newest first, and the notices are one sentence per line.

use std::path::PathBuf;

use axum::extract::{Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::admin::AdminRefusal;
use crate::api::{Refusal, Signed};
use crate::backup::{date, Label};
use crate::client_address::ClientAddress;
use crate::crypto;
use crate::operators::OperatorError;
use crate::sessions::{PrincipalKind, SessionError, SessionStore, VerifiedSession};

/// How old the newest backup may be before it is called missing: a nightly
/// schedule plus a day's slack.
pub const STALE_AFTER_SECONDS: u64 = 48 * 3600;

#[derive(Clone)]
pub struct BackupStatusState {
    pub sessions: std::sync::Arc<SessionStore>,
    pub client_address: ClientAddress,
    /// `FATHOM_BACKUP_DIR`. `None` when this install runs no backup service.
    pub dir: Option<PathBuf>,
    /// The ids of the keys this server holds now.
    pub current: Label,
}

impl axum::extract::FromRequest<BackupStatusState> for Signed {
    type Rejection = Refusal;

    async fn from_request(
        request: Request,
        state: &BackupStatusState,
    ) -> Result<Self, Self::Rejection> {
        Signed::from_request_for(request, &state.sessions, &state.client_address).await
    }
}

pub fn router(state: BackupStatusState) -> Router {
    Router::new()
        .route("/admin/backups", get(backups))
        .with_state(state)
}

async fn verify(state: &BackupStatusState, signed: &Signed) -> Result<VerifiedSession, Refusal> {
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
    result
}

async fn backups(
    State(state): State<BackupStatusState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    if session.kind() != PrincipalKind::Operator {
        return Err(AdminRefusal(OperatorError::NotAnOperator).into());
    }
    let read = |name: &str| -> Option<String> {
        let dir = state.dir.as_ref()?;
        // Small files the service writes; anything large is not ours.
        let bytes = std::fs::read(dir.join(name)).ok()?;
        if bytes.len() > 16 * 1024 {
            return None;
        }
        String::from_utf8(bytes).ok()
    };
    // The off-site copy's lines all start `offsite_`, so they join the
    // status without colliding with it.
    let status = match (read("status"), read("offsite")) {
        (None, None) => None,
        (a, b) => Some(format!(
            "{}{}",
            a.unwrap_or_default(),
            b.unwrap_or_default()
        )),
    };
    let record = read("keys-file");
    let files = state
        .dir
        .as_ref()
        .map(|d| list_data_files(d))
        .unwrap_or_default();
    let notes = notices(
        state.dir.is_some(),
        status.as_deref(),
        record.as_deref(),
        &state.current,
        crypto::now_unix() as u64,
    );

    let mut out = Vec::new();
    crypto::lp(&mut out, status.unwrap_or_default().as_bytes());
    crypto::lp(&mut out, record.unwrap_or_default().as_bytes());
    crypto::lp(&mut out, state.current.to_text().as_bytes());
    let listing: String = files.iter().map(|(n, b)| format!("{n} {b}\n")).collect();
    crypto::lp(&mut out, listing.as_bytes());
    crypto::lp(&mut out, notes.join("\n").as_bytes());
    Ok((
        axum::http::StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream"),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        out,
    )
        .into_response())
}

/// The data files in the volume, newest first.
fn list_data_files(dir: &std::path::Path) -> Vec<(String, u64)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<(String, u64)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let ok = name.starts_with("fathom-") && name.ends_with(".fdata");
            let meta = e.metadata().ok()?;
            (ok && meta.is_file()).then_some((name, meta.len()))
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

/// One `name value` field out of a status text.
pub fn field<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines()
        .find_map(|l| l.strip_prefix(name)?.strip_prefix(' '))
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "-")
}

/// `2026-10-25T02:00:04Z` to unix seconds. Only the shape the service writes.
pub fn parse_utc(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[19] != b'Z' {
        return None;
    }
    let n = |r: core::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    let (hh, mm, ss) = (n(11..13)?, n(14..16)?, n(17..19)?);
    // Howard Hinnant's days_from_civil, the inverse of `backup::date`.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    u64::try_from(days * 86_400 + hh * 3600 + mm * 60 + ss).ok()
}

/// What an operator must hear about backups, in their register. Empty when
/// all is well. Pure, so it is tested without a volume.
pub fn notices(
    configured: bool,
    status: Option<&str>,
    record: Option<&str>,
    current: &Label,
    now: u64,
) -> Vec<String> {
    let mut out = Vec::new();
    if !configured {
        out.push(
            "No nightly backup runs on this server: the backup service is not set up. \
             docs/OPERATING.md, Backups, says how."
                .to_string(),
        );
        return out;
    }
    match status {
        None => out.push(
            "The backup service has not reported yet. If it has been running for a day, check \
             its log: docker compose logs backup."
                .to_string(),
        ),
        Some(s) => {
            if field(s, "last_result") == Some("failed") {
                let when = field(s, "last_failed_at").unwrap_or("recently");
                let why = field(s, "last_error").unwrap_or("no reason was recorded");
                out.push(format!("The last backup failed ({when}): {why}"));
            }
            match field(s, "last_backup_at").and_then(parse_utc) {
                None => out.push("No backup has been made yet.".to_string()),
                Some(t) if now.saturating_sub(t) > STALE_AFTER_SECONDS => {
                    out.push(format!("No backup has been made since {}.", date(t)))
                }
                Some(_) => {}
            }
            if field(s, "offsite_result") == Some("failed") {
                let when = field(s, "offsite_failed_at").unwrap_or("recently");
                let why = field(s, "offsite_error").unwrap_or("no reason was recorded");
                out.push(format!(
                    "The last copy to off-site storage failed ({when}): {why}. The backups on this \
                     host are fine; the copies elsewhere are behind."
                ));
            }
            if field(s, "last_test_result") == Some("failed") {
                let why = field(s, "last_test_error").unwrap_or("no reason was recorded");
                out.push(format!(
                    "The last restore test failed: {why}. Until one passes, assume the backups \
                     cannot be restored."
                ));
            }
        }
    }
    match record.map(Label::from_text) {
        None | Some(Err(_)) => out.push(
            "No keys file has been made for this install, so no backup can be opened yet. Make \
             one and keep it away from the backups: docker compose run --rm -T backup-keys > \
             fathom-keys.fkeys"
                .to_string(),
        ),
        Some(Ok(held)) => {
            // A key the keys file never held (the vault's, ADR-0071, on an
            // install whose keys file predates it) is said apart from one
            // that was replaced: the first means that key is in no keys file
            // at all, and a lost host would take it with it.
            let mut missing: Vec<&str> = Vec::new();
            let mut changed: Vec<&str> = Vec::new();
            for (what, now, then) in [
                ("master", current.master_key, held.master_key),
                ("chain", current.chain_key, held.chain_key),
                ("backup", current.backup_key, held.backup_key),
                ("vault", current.vault_key, held.vault_key),
            ] {
                match (now, then) {
                    (Some(_), None) => missing.push(what),
                    (Some(n), Some(t)) if n != t => changed.push(what),
                    _ => {}
                }
            }
            let keys = |v: &[&str]| {
                format!(
                    "the {} key{}",
                    v.join(" and "),
                    if v.len() == 1 { "" } else { "s" }
                )
            };
            let mut why = Vec::new();
            if !missing.is_empty() {
                why.push(format!(
                    "{} {} not in it",
                    keys(&missing),
                    if missing.len() == 1 { "is" } else { "are" }
                ));
            }
            if !changed.is_empty() {
                why.push(format!("{} changed since", keys(&changed)));
            }
            if !why.is_empty() {
                out.push(format!(
                    "The keys file made {} is out of date: {}. Make a new one now; keep the old \
                     one for older backups.",
                    date(held.made_at_unix),
                    why.join(", and "),
                ));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::Key32;

    fn current() -> Label {
        let k = |b| Key32::from_bytes([b; 32]);
        crate::backup::label_now(&k(1), Some(&k(2)), Some(&k(3)), None)
    }

    #[test]
    fn utc_round_trips_with_date() {
        let t = parse_utc("2026-10-25T02:00:04Z").unwrap();
        assert_eq!(date(t), "2026-10-25");
        assert_eq!(t % 86_400, 2 * 3600 + 4);
        assert!(parse_utc("2026-10-25 02:00").is_none());
    }

    #[test]
    fn all_well_is_silent() {
        let now = parse_utc("2026-10-25T09:00:00Z").unwrap();
        let status = "last_backup_at 2026-10-25T02:00:04Z\nlast_result ok\nlast_test_result ok\n";
        let record = current().to_text();
        assert!(notices(true, Some(status), Some(&record), &current(), now).is_empty());
    }

    #[test]
    fn failures_staleness_and_a_missing_keys_file_are_each_said() {
        let now = parse_utc("2026-10-28T09:00:00Z").unwrap();
        let status = "last_backup_at 2026-10-25T02:00:04Z\nlast_result failed\n\
                      last_failed_at 2026-10-28T02:00:01Z\nlast_error pg_dump: connection refused\n\
                      last_test_result failed\nlast_test_error pg_restore: bad\n";
        let n = notices(true, Some(status), None, &current(), now);
        assert_eq!(n.len(), 4, "{n:?}");
        assert!(n[0].contains("connection refused"));
        assert!(n[1].contains("since 2026-10-25"));
        assert!(n[2].contains("restore test failed"));
        assert!(n[3].contains("No keys file"));
    }

    #[test]
    fn a_changed_key_makes_the_keys_file_out_of_date() {
        let now = parse_utc("2026-10-25T09:00:00Z").unwrap();
        let status = "last_backup_at 2026-10-25T02:00:04Z\nlast_result ok\n";
        let mut old = current();
        old.master_key = Some(Key32::from_bytes([9; 32]).id());
        let n = notices(true, Some(status), Some(&old.to_text()), &current(), now);
        assert_eq!(n.len(), 1);
        assert!(n[0].contains("out of date") && n[0].contains("master key changed"));
    }

    #[test]
    fn a_failed_offsite_copy_is_said() {
        let now = parse_utc("2026-10-25T09:00:00Z").unwrap();
        let status = "last_backup_at 2026-10-25T02:00:04Z\nlast_result ok\n\
                      offsite_result failed\noffsite_failed_at 2026-10-25T03:00:02Z\n\
                      offsite_error AccessDenied\n";
        let n = notices(
            true,
            Some(status),
            Some(&current().to_text()),
            &current(),
            now,
        );
        assert_eq!(n.len(), 1, "{n:?}");
        assert!(n[0].contains("off-site") && n[0].contains("AccessDenied"));
    }

    #[test]
    fn a_vault_key_the_keys_file_never_held_is_named_as_missing() {
        let now = parse_utc("2026-10-25T09:00:00Z").unwrap();
        let status = "last_backup_at 2026-10-25T02:00:04Z\nlast_result ok\n";
        let old = current();
        let mut with_vault = current();
        with_vault.vault_key = Some(Key32::from_bytes([4; 32]).id());
        let n = notices(true, Some(status), Some(&old.to_text()), &with_vault, now);
        assert_eq!(n.len(), 1, "{n:?}");
        assert!(n[0].contains("the vault key is not in it"), "{}", n[0]);
        assert!(!n[0].contains("changed"), "{}", n[0]);
    }

    #[test]
    fn no_service_says_so_once() {
        let n = notices(false, None, None, &current(), 0);
        assert_eq!(n.len(), 1);
        assert!(n[0].contains("not set up"));
    }
}
