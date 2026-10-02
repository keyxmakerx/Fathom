//! **Where the console lives, set from the console, guarded by confirm or revert**
//! (ADR-0055 decisions 9 and 11, migration `0020_console_placement.sql`).
//!
//! `admin_exposure.rs` confines `/admin` and `/enrolment/operator` to
//! `FATHOM_ADMIN_HOSTS` / `FATHOM_ADMIN_SOURCES`; this module lets an operator change
//! that from the console. Decision 11 puts it **outside §5.3's delay**: tightening
//! gains an attacker nothing and loosening needs an operator session, so the risk
//! is lockout, not escalation. The guard is an interlock:
//!
//! 1. `POST /admin/placement` applies **at once**, sealed in the same transaction
//!    (`0020`: `sealed_seq NOT NULL`).
//! 2. The first `/admin` request that verifies on a matching `Host` inside the
//!    window is the confirmation ([`confirm_on_the_new_host`]).
//! 3. An unconfirmed placement reverts at the window's end to the last confirmed
//!    one, or to open. The clock in [`Placement::effective`] is what the gate
//!    reads; [`PlacementStore::sweep`] writes the sealed record.
//!
//! # The snapshot
//!
//! `AdminExposure::allows` runs on **every** request, so no database read there. The
//! placement is an `Arc<RwLock<Placement>>`, refreshed at startup, on every
//! placement write and by the sweep. It holds the pending AND last confirmed
//! placement, so an expired window takes effect on the next request: the clock
//! decides, not the cache.
//!
//! **Several processes write.** The `fathom-server console-placement --reset` CLI
//! (decision 11's only way back from a lockout) is a second process, and the
//! deployment may be two containers, so the snapshot re-reads every
//! [`SNAPSHOT_TTL`] (five seconds) via [`PlacementStore::spawn_snapshot_refresher`],
//! started by `main.rs`. `LISTEN`/`NOTIFY` would be a better end state.
//!
//! # The flag
//!
//! `GET /placement/flag` is unauthenticated and outside `/admin`, since a client on a
//! NON-console host needs "no" and `/admin` is 404 there. It discloses only whether
//! this host is the console host (anyone can learn that from `/admin`'s status
//! code), never other hosts or sources.
//!
//! # SMTP lives here too, and holds a credential
//!
//! `smtp` is one more `site_settings_versions` key (`0015` §F). This file validates
//! the value envelope before sealing, so a malformed form is a typed refusal.
//! §5.3: *"SMTP credentials are credentials."* The password is a
//! [`crate::secret::Secret`] from parse onward (`tests/no_secret_in_logs.rs`'s
//! second canary drives it), so no `Debug`, format string or tracing field can
//! print it.

use std::net::IpAddr;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use deadpool_postgres::{Pool, Transaction};
use fathom_canon::Json;

use crate::admin_exposure::normalise_host;
use crate::api::{Refusal, Signed};
use crate::authority::{self, RowFacts};
use crate::chain::EntryType;
use crate::chains;
use crate::client_address::{Cidr, ClientAddress};
use crate::crypto;
use crate::ids;
use crate::keys::KeyRing;
use crate::operators::{self, OperatorError};
use crate::secret::Secret;
use crate::sessions::{PrincipalKind, SessionError, SessionStore, VerifiedSession};

// ---- The labels ----

/// The bytes an operator signs to move the console (decision 11). Its own tag: a
/// signature over a placement must not verify as one over a settings row.
const TAG_PLACEMENT_REQUEST: &[u8] = b"fathom/site/placement/request/v1";

/// Same contract as [`crate::operators::LABELS`]: every label this module signs
/// under, listed once, with a test that fails if one is used and not listed.
pub const LABELS: &[(&str, &str)] = &[(
    "fathom/site/placement/request/v1",
    "the bytes an operator signs to move the operator console to a host and a set of sources \
     (ADR-0055 decision 11): LP(tag) ‖ LP(deployment) ‖ LP(operator) ‖ LP(hosts) ‖ LP(sources) ‖ \
     u64(window_seconds)",
)];

/// What an operator signs to request a placement. Every field that decides the
/// answer, including the window, is inside the signature: otherwise a proxy
/// could shorten the window and choose when the console reverts.
pub fn placement_request_bytes(
    deployment: &str,
    operator: &str,
    hosts: &str,
    sources: &str,
    window_seconds: i64,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(256);
    crypto::lp(&mut msg, TAG_PLACEMENT_REQUEST);
    crypto::lp(&mut msg, deployment.as_bytes());
    crypto::lp(&mut msg, operator.as_bytes());
    crypto::lp(&mut msg, hosts.as_bytes());
    crypto::lp(&mut msg, sources.as_bytes());
    crypto::u64_le(&mut msg, window_seconds as u64);
    msg
}

// ---- The window ----

/// Decision 11's default: five minutes to follow the console to its new host and
/// sign in.
pub const DEFAULT_WINDOW_SECONDS: i64 = 300;

/// `0020`'s `CHECK (window_seconds BETWEEN 60 AND 3600)`, restated so a bad
/// request is a typed refusal.
///
/// **The window is per request, with no site setting.** A setting would take
/// §5.3's delay and quorum, the machinery decision 11 deliberately avoids.
pub const MIN_WINDOW_SECONDS: i64 = 60;
pub const MAX_WINDOW_SECONDS: i64 = 3600;

/// One SMTP test-send per operator per five minutes, in the bucket
/// [`take_test_send_budget`] describes.
pub const TEST_SEND_WINDOW_SECONDS: i64 = 300;

/// **How stale this process's placement snapshot may be**: five seconds. It is
/// the gap between another process writing a placement (the `--reset` CLI or the
/// other container) and this one honouring it.
///
/// Not a security boundary: loosening needs an operator session or the key
/// volume, and tightening is honoured by the writer at once and by others within
/// the TTL.
pub const SNAPSHOT_TTL: Duration = Duration::from_secs(5);

// ---- The snapshot ----

/// One placement as the gate reads it: hosts and sources, already parsed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Placed {
    pub hosts: Vec<String>,
    pub sources: Vec<Cidr>,
}

/// What the placement is right now. Both halves are held and
/// [`Placement::effective`] picks by the clock, so an expired window falls back
/// to the last confirmed placement without waiting for the sweep.
#[derive(Clone, Debug, Default)]
pub struct Placement {
    confirmed: Option<Placed>,
    pending: Option<(Placed, i64)>,
}

impl Placement {
    /// Build one from its two halves, for [`PlacementStore::refresh`] and for tests
    /// driving the gate without a database.
    pub fn from_parts(confirmed: Option<Placed>, pending: Option<(Placed, i64)>) -> Self {
        Self { confirmed, pending }
    }

    /// The placement in force at `now`, or `None` for "open": none confirmed and none
    /// pending, so the console answers everywhere.
    pub fn effective(&self, now_unix: i64) -> Option<&Placed> {
        match &self.pending {
            Some((placed, confirm_by)) if *confirm_by > now_unix => Some(placed),
            _ => self.confirmed.as_ref(),
        }
    }

    /// Whether a placement is pending and its window has run out: the state the sweep
    /// records.
    pub fn window_ran_out(&self, now_unix: i64) -> bool {
        matches!(&self.pending, Some((_, confirm_by)) if *confirm_by <= now_unix)
    }

    /// When the placement in force stops being so unless confirmed; `None` when
    /// nothing is pending.
    pub fn confirm_by(&self, now_unix: i64) -> Option<i64> {
        match &self.pending {
            Some((_, confirm_by)) if *confirm_by > now_unix => Some(*confirm_by),
            _ => None,
        }
    }
}

/// The shared handle `AdminExposure`, the flag route and the store read.
pub type PlacementView = Arc<RwLock<Placement>>;

// ---- The store ----

/// What a placement request answers with.
pub struct Requested {
    pub id: String,
    pub confirm_by_unix: i64,
}

/// Reads and writes `console_placements`, and keeps the snapshot current.
pub struct PlacementStore {
    pool: Pool,
    ring: Arc<KeyRing>,
    deployment: String,
    view: PlacementView,
}

impl PlacementStore {
    pub fn new(pool: Pool, ring: Arc<KeyRing>, deployment: String) -> Self {
        Self {
            pool,
            ring,
            deployment,
            view: Arc::new(RwLock::new(Placement::default())),
        }
    }

    /// The handle the gate and flag route hold. One snapshot per process.
    pub fn view(&self) -> PlacementView {
        Arc::clone(&self.view)
    }

    pub fn deployment(&self) -> &str {
        &self.deployment
    }

    /// Read the live placement from the database and publish it.
    ///
    /// **Under `app.placement_flag`, not operator custody** (`0020` §B): it runs at
    /// startup and after writes with no operator involved, so it uses the narrowest
    /// capability.
    pub async fn refresh(&self) -> Result<Placement, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_placement_flag(&tx).await?;

        // The last CONFIRMED placement, and the newest one still awaiting confirmation.
        // They are carried separately so an expired window falls back rather than
        // opening the console.
        let confirmed = tx
            .query_opt(
                "SELECT hosts, sources FROM console_placements \
                  WHERE confirmed_at IS NOT NULL AND reverted_at IS NULL \
                  ORDER BY requested_at DESC LIMIT 1",
                &[],
            )
            .await?;
        // **No `confirm_by > now()`, deliberately.** An expired window is still a row
        // the sweep must revert, and the snapshot is how the sweep learns of it;
        // `Placement::effective` stops honouring it by the clock.
        let pending = tx
            .query_opt(
                "SELECT hosts, sources, EXTRACT(EPOCH FROM confirm_by)::bigint \
                   FROM console_placements \
                  WHERE confirmed_at IS NULL AND reverted_at IS NULL \
                  ORDER BY requested_at DESC LIMIT 1",
                &[],
            )
            .await?;
        leave_placement_flag(&tx).await?;
        tx.commit().await?;

        let placement = Placement::from_parts(
            confirmed.map(|row| placed(row.get(0), row.get(1))),
            pending.map(|row| (placed(row.get(0), row.get(1)), row.get(2))),
        );
        self.publish(placement.clone());
        Ok(placement)
    }

    /// **Re-read the snapshot every [`SNAPSHOT_TTL`], for ever.** A placement written by
    /// ANOTHER process (the `--reset` CLI, the other container) otherwise never reaches
    /// this one, and the gate kept enforcing a placement that had locked everybody out.
    ///
    /// Dropping the returned handle does not stop the task; `main.rs` aborts it on
    /// shutdown. A failed read is logged and the loop continues: the old snapshot is
    /// the safe one, and a briefly unreachable database must not open the console.
    pub fn spawn_snapshot_refresher(store: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(SNAPSHOT_TTL);
            // The first tick is immediate and `main.rs` already refreshed once.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if let Err(e) = store.refresh().await {
                    tracing::warn!(
                        error = %e,
                        "the console placement snapshot could not be re-read; this process \
                         keeps enforcing the placement it already has"
                    );
                }
            }
        })
    }

    fn publish(&self, placement: Placement) {
        match self.view.write() {
            Ok(mut view) => *view = placement,
            // A poisoned lock means a panic mid-write. Not updating is the safe half: the
            // gate keeps enforcing the placement it knows.
            Err(_) => tracing::error!("the console placement snapshot is poisoned; not updated"),
        }
    }

    /// Decision 11's request: **applies at once, sealed in the same transaction**,
    /// and starts the window.
    pub async fn request(
        &self,
        session: &VerifiedSession,
        hosts: &str,
        sources: &str,
        window_seconds: i64,
        assertion: &[u8],
    ) -> Result<Requested, OperatorError> {
        if session.kind() != PrincipalKind::Operator {
            return Err(OperatorError::NotAnOperator);
        }
        let acting = session.principal_id();
        let hosts = check_hosts(hosts)?;
        let sources = check_sources(&sources_text(sources))?;
        if !(MIN_WINDOW_SECONDS..=MAX_WINDOW_SECONDS).contains(&window_seconds) {
            return Err(OperatorError::Malformed("placement window"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        operators::enter_operator_custody(&tx).await?;

        // Asserted by the operator's ENROLLED key, not only the session key: moving the
        // console is the act most likely to lock a deployment out, so it is a key touch,
        // like a settings change or a second operator (§5.5).
        let message =
            placement_request_bytes(&self.deployment, &acting, &hosts, &sources, window_seconds);
        verify_operator_assertion(&tx, &self.ring, &acting, &message, assertion).await?;

        let requested_at: i64 = tx
            .query_one("SELECT EXTRACT(EPOCH FROM now())::bigint", &[])
            .await?
            .get(0);
        let confirm_by = requested_at + window_seconds;
        let id = ids::new_ulid().to_string();

        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::ConsolePlacementRequested,
            &entry_metadata(
                EntryType::ConsolePlacementRequested,
                &[
                    ("placement", Json::Str(id.clone())),
                    ("hosts", Json::Str(hosts.clone())),
                    ("sources", Json::Str(sources.clone())),
                    ("window_seconds", Json::Int(window_seconds)),
                    ("requested_by", Json::Str(acting.clone())),
                    ("confirm_by", Json::Int(confirm_by)),
                ],
            ),
        )
        .await?;

        let facts = PlacementFacts {
            id: &id,
            hosts: &hosts,
            sources: &sources,
            window_seconds,
            requested_by: &acting,
            request_sig: assertion,
            confirm_by_unix: confirm_by,
            confirmed_by: None,
            confirmed_at_unix: 0,
            reverted_at_unix: 0,
            revert_reason: None,
            sealed_seq: appended.seq,
        };
        let seal = row_seal(&tx, &self.ring, &facts, appended.seq, 1).await?;

        tx.execute(
            "INSERT INTO console_placements \
                 (id, hosts, sources, window_seconds, requested_by, request_sig, requested_seq, \
                  requested_at, confirm_by, sealed_seq, row_version, row_seal) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::bigint), \
                     to_timestamp($9::bigint), $10, 1, $11)",
            &[
                &id,
                &hosts,
                &sources,
                &(window_seconds as i32),
                &acting,
                &assertion.to_vec(),
                &appended.seq,
                &requested_at,
                &confirm_by,
                &appended.seq,
                &seal.to_vec(),
            ],
        )
        .await?;

        operators::leave_custody(&tx).await?;
        tx.commit().await?;
        self.refresh().await?;
        tracing::warn!(
            placement = %id,
            hosts = %hosts,
            confirm_by_unix = confirm_by,
            "the operator console has moved. Sign in on the new host before the window ends or \
             it reverts to the last confirmed placement."
        );
        Ok(Requested {
            id,
            confirm_by_unix: confirm_by,
        })
    }

    /// Decision 11's confirmation: an operator reached the console **on the new
    /// host**, inside the window. Returns the placement id when this call confirmed.
    /// Called from [`confirm_on_the_new_host`] for every verified `/admin` request,
    /// so the usual case (nothing pending) is one snapshot read, no database work.
    pub async fn confirm_on_host(
        &self,
        host: &str,
        operator: &str,
    ) -> Result<Option<String>, OperatorError> {
        let host = normalise_host(host);
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        operators::enter_operator_custody(&tx).await?;

        let Some(row) = tx
            .query_opt(
                "SELECT id, hosts, sources, window_seconds, requested_by, request_sig, \
                        requested_seq, EXTRACT(EPOCH FROM confirm_by)::bigint, sealed_seq, \
                        row_version \
                   FROM console_placements \
                  WHERE confirmed_at IS NULL AND reverted_at IS NULL AND confirm_by > now() \
                  ORDER BY requested_at DESC LIMIT 1",
                &[],
            )
            .await?
        else {
            operators::leave_custody(&tx).await?;
            tx.commit().await?;
            return Ok(None);
        };
        let id: String = row.get(0);
        let hosts: String = row.get(1);
        if !host_list(&hosts).contains(&host) {
            operators::leave_custody(&tx).await?;
            tx.commit().await?;
            return Ok(None);
        }

        let confirmed_at: i64 = tx
            .query_one("SELECT EXTRACT(EPOCH FROM now())::bigint", &[])
            .await?
            .get(0);
        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::ConsolePlacementConfirmed,
            &entry_metadata(
                EntryType::ConsolePlacementConfirmed,
                &[
                    ("placement", Json::Str(id.clone())),
                    ("host", Json::Str(host.clone())),
                    ("confirmed_by", Json::Str(operator.to_string())),
                    ("confirmed_at", Json::Int(confirmed_at)),
                ],
            ),
        )
        .await?;

        let request_sig: Vec<u8> = row.get(5);
        let window_seconds: i32 = row.get(3);
        let requested_by: String = row.get(4);
        let sources: String = row.get(2);
        let requested_seq: i64 = row.get(6);
        let version: i32 = row.get::<_, i32>(9) + 1;
        let facts = PlacementFacts {
            id: &id,
            hosts: &hosts,
            sources: &sources,
            window_seconds: window_seconds as i64,
            requested_by: &requested_by,
            request_sig: &request_sig,
            confirm_by_unix: row.get(7),
            confirmed_by: Some(operator),
            confirmed_at_unix: confirmed_at,
            reverted_at_unix: 0,
            revert_reason: None,
            sealed_seq: row.get(8),
        };
        let seal = row_seal(&tx, &self.ring, &facts, requested_seq, version).await?;

        tx.execute(
            "UPDATE console_placements \
                SET confirmed_by = $2, confirmed_at = to_timestamp($3::bigint), \
                    confirmed_seq = $4, row_version = $5, row_seal = $6 \
              WHERE id = $1 AND confirmed_at IS NULL AND reverted_at IS NULL",
            &[
                &id,
                &operator,
                &confirmed_at,
                &appended.seq,
                &version,
                &seal.to_vec(),
            ],
        )
        .await?;

        operators::leave_custody(&tx).await?;
        tx.commit().await?;
        self.refresh().await?;
        tracing::info!(placement = %id, host = %host, "the console placement was confirmed");
        Ok(Some(id))
    }

    /// The sweep: every placement whose window ran out unconfirmed reverts, sealed.
    ///
    /// Called where `apply_due_operator_requests` is swept (`admin.rs`), since there
    /// is no scheduler (`0014` §C). The GATE does not wait for it; the sweep adds the
    /// sealed record and the row's state.
    pub async fn sweep(&self) -> Result<usize, OperatorError> {
        self.revert_all("window_expired").await
    }

    /// `fathom-server console-placement --reset`, decision 11's last sentence: clear
    /// the placement that locked everyone out **from the host**, sealed, for when the
    /// window was confirmed and the host later died.
    ///
    /// **It runs in a second process.** The `refresh()` at the end of `revert_all`
    /// updates only the CLI's own snapshot; the RUNNING server picks the reset up
    /// through [`PlacementStore::spawn_snapshot_refresher`] within [`SNAPSHOT_TTL`].
    pub async fn reset_from_host(&self) -> Result<usize, OperatorError> {
        self.revert_all("host_reset").await
    }

    async fn revert_all(&self, reason: &'static str) -> Result<usize, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        operators::enter_operator_custody(&tx).await?;

        // `host_reset` clears every live placement, confirmed or not. The sweep clears
        // only windows that ran out.
        let rows = if reason == "host_reset" {
            tx.query(
                "SELECT id, hosts, sources, window_seconds, requested_by, request_sig, \
                        requested_seq, EXTRACT(EPOCH FROM confirm_by)::bigint, \
                        COALESCE(EXTRACT(EPOCH FROM confirmed_at)::bigint, 0), confirmed_by, \
                        sealed_seq, row_version \
                   FROM console_placements WHERE reverted_at IS NULL",
                &[],
            )
            .await?
        } else {
            tx.query(
                "SELECT id, hosts, sources, window_seconds, requested_by, request_sig, \
                        requested_seq, EXTRACT(EPOCH FROM confirm_by)::bigint, \
                        COALESCE(EXTRACT(EPOCH FROM confirmed_at)::bigint, 0), confirmed_by, \
                        sealed_seq, row_version \
                   FROM console_placements \
                  WHERE confirmed_at IS NULL AND reverted_at IS NULL AND confirm_by < now()",
                &[],
            )
            .await?
        };

        let mut reverted = 0usize;
        for row in &rows {
            let id: String = row.get(0);
            let hosts: String = row.get(1);
            let sources: String = row.get(2);
            let window_seconds: i32 = row.get(3);
            let requested_by: String = row.get(4);
            let request_sig: Vec<u8> = row.get(5);
            let requested_seq: i64 = row.get(6);
            let confirmed_at: i64 = row.get(8);
            let confirmed_by: Option<String> = row.get(9);
            let version: i32 = row.get::<_, i32>(11) + 1;

            let reverted_at: i64 = tx
                .query_one("SELECT EXTRACT(EPOCH FROM now())::bigint", &[])
                .await?
                .get(0);
            // **What the row gives up, the chain keeps.** `0020` has
            // `CHECK (confirmed_at IS NULL OR reverted_at IS NULL)`, so a confirmed row
            // cannot just be marked reverted, yet `--reset` exists for exactly that case.
            // The row is un-confirmed and reverted in one statement, and the entry below
            // carries `was_confirmed` and the confirming operator. The CHECK and decision
            // 11's reset case do not quite agree; this is the only shape the schema allows
            // without editing a shipped migration.
            let undo_confirmation = reason == "host_reset" && confirmed_by.is_some();
            let appended = chains::append_site(
                &tx,
                &self.ring,
                &self.deployment,
                EntryType::ConsolePlacementReverted,
                &entry_metadata(
                    EntryType::ConsolePlacementReverted,
                    &[
                        ("placement", Json::Str(id.clone())),
                        ("hosts", Json::Str(hosts.clone())),
                        ("reason", Json::Str(reason.to_string())),
                        ("reverted_at", Json::Int(reverted_at)),
                        ("was_confirmed", Json::Bool(confirmed_by.is_some())),
                        (
                            "confirmed_by",
                            match &confirmed_by {
                                Some(id) => Json::Str(id.clone()),
                                None => Json::Null,
                            },
                        ),
                        ("confirmed_at", Json::Int(confirmed_at)),
                    ],
                ),
            )
            .await?;

            let facts = PlacementFacts {
                id: &id,
                hosts: &hosts,
                sources: &sources,
                window_seconds: window_seconds as i64,
                requested_by: &requested_by,
                request_sig: &request_sig,
                confirm_by_unix: row.get(7),
                confirmed_by: if undo_confirmation {
                    None
                } else {
                    confirmed_by.as_deref()
                },
                confirmed_at_unix: if undo_confirmation { 0 } else { confirmed_at },
                reverted_at_unix: reverted_at,
                revert_reason: Some(reason),
                sealed_seq: row.get(10),
            };
            let seal = row_seal(&tx, &self.ring, &facts, requested_seq, version).await?;
            if undo_confirmation {
                tx.execute(
                    "UPDATE console_placements \
                        SET confirmed_by = NULL, confirmed_at = NULL, confirmed_seq = NULL, \
                            reverted_at = to_timestamp($2::bigint), reverted_seq = $3, \
                            revert_reason = $4, row_version = $5, row_seal = $6 \
                      WHERE id = $1 AND reverted_at IS NULL",
                    &[
                        &id,
                        &reverted_at,
                        &appended.seq,
                        &reason,
                        &version,
                        &seal.to_vec(),
                    ],
                )
                .await?;
            } else {
                tx.execute(
                    "UPDATE console_placements \
                        SET reverted_at = to_timestamp($2::bigint), reverted_seq = $3, \
                            revert_reason = $4, row_version = $5, row_seal = $6 \
                      WHERE id = $1 AND reverted_at IS NULL",
                    &[
                        &id,
                        &reverted_at,
                        &appended.seq,
                        &reason,
                        &version,
                        &seal.to_vec(),
                    ],
                )
                .await?;
            }
            reverted += 1;
        }

        operators::leave_custody(&tx).await?;
        tx.commit().await?;
        if reverted > 0 {
            self.refresh().await?;
            tracing::warn!(
                reverted,
                reason,
                "console placements reverted; the console answers on the last confirmed \
                 placement, or everywhere if there was none"
            );
        }
        Ok(reverted)
    }
}

/// Turn on `app.placement_flag`: `0020` §B's third capability, narrower than
/// operator custody, for the one read an unauthenticated answer needs.
async fn enter_placement_flag(tx: &Transaction<'_>) -> Result<(), OperatorError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute("SELECT set_config('app.placement_flag', 'yes', true)", &[])
        .await?;
    Ok(())
}

async fn leave_placement_flag(tx: &Transaction<'_>) -> Result<(), OperatorError> {
    tx.execute("SELECT set_config('app.placement_flag', 'no', true)", &[])
        .await?;
    Ok(())
}

// ---- Parsing, shared with `admin_exposure` ----

fn placed(hosts: String, sources: String) -> Placed {
    Placed {
        hosts: host_list(&hosts),
        sources: source_list(&sources),
    }
}

/// The stored text as normalised host names.
pub fn host_list(text: &str) -> Vec<String> {
    text.split(',')
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(normalise_host)
        .collect()
}

/// The stored text as ranges. **An entry that does not parse is dropped here and
/// refused at the door** ([`check_sources`]), so a stray row cannot silently
/// widen the gate.
pub fn source_list(text: &str) -> Vec<Cidr> {
    text.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(Cidr::parse)
        .collect()
}

/// `0020`'s `CHECK (char_length(hosts) BETWEEN 1 AND 2000)` and valid host names,
/// as a typed refusal.
///
/// **Returns the operator's own text, trimmed only**, because their signature
/// covers it. Case and port are normalised where the text is READ
/// ([`host_list`]), the same place the `Host` header is normalised.
fn check_hosts(text: &str) -> Result<String, OperatorError> {
    let text = text.trim().to_string();
    let hosts: Vec<String> = host_list(&text);
    if hosts.is_empty() {
        return Err(OperatorError::Malformed("placement hosts"));
    }
    if text.len() > 2000 {
        return Err(OperatorError::Malformed("placement hosts"));
    }
    for host in &hosts {
        // What a `Host` header can carry: letters, digits, `-`, `.`, and the brackets
        // and colons of an IPv6 literal. A value that cannot match `Host` would confine
        // the console to nowhere, the lockout this interlock exists to survive and
        // should not be reachable by typo.
        let ok = !host.is_empty()
            && host.len() <= 253
            && host.bytes().all(|b| {
                b.is_ascii_alphanumeric()
                    || b == b'-'
                    || b == b'.'
                    || b == b'['
                    || b == b']'
                    || b == b':'
            });
        if !ok {
            return Err(OperatorError::Malformed("placement hosts"));
        }
    }
    Ok(text)
}

/// Sources as text, with a whole-internet default for confining by host alone:
/// `0020` requires a non-empty column, so "from anywhere" is spelled out.
fn sources_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        "0.0.0.0/0,::/0".to_string()
    } else {
        trimmed.to_string()
    }
}

fn check_sources(text: &str) -> Result<String, OperatorError> {
    let entries: Vec<&str> = text
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if entries.is_empty() {
        return Err(OperatorError::Malformed("placement sources"));
    }
    for entry in &entries {
        if Cidr::parse(entry).is_none() {
            return Err(OperatorError::Malformed("placement sources"));
        }
    }
    let text = text.trim().to_string();
    if text.len() > 2000 {
        return Err(OperatorError::Malformed("placement sources"));
    }
    Ok(text)
}

// ---- The row seal ----

struct PlacementFacts<'a> {
    id: &'a str,
    hosts: &'a str,
    sources: &'a str,
    window_seconds: i64,
    requested_by: &'a str,
    request_sig: &'a [u8],
    confirm_by_unix: i64,
    confirmed_by: Option<&'a str>,
    confirmed_at_unix: i64,
    reverted_at_unix: i64,
    revert_reason: Option<&'a str>,
    sealed_seq: i64,
}

async fn row_seal(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    facts: &PlacementFacts<'_>,
    chain_seq: i64,
    row_version: i32,
) -> Result<[u8; 32], OperatorError> {
    let mut map = std::collections::BTreeMap::new();
    map.insert("confirm_by".to_string(), Json::Int(facts.confirm_by_unix));
    map.insert(
        "confirmed_at".to_string(),
        Json::Int(facts.confirmed_at_unix),
    );
    map.insert(
        "confirmed_by".to_string(),
        match facts.confirmed_by {
            Some(id) => Json::Str(id.to_string()),
            None => Json::Null,
        },
    );
    map.insert("hosts".to_string(), Json::Str(facts.hosts.to_string()));
    map.insert("id".to_string(), Json::Str(facts.id.to_string()));
    map.insert("request_sig".to_string(), Json::Str(hex(facts.request_sig)));
    map.insert(
        "requested_by".to_string(),
        Json::Str(facts.requested_by.to_string()),
    );
    map.insert(
        "revert_reason".to_string(),
        match facts.revert_reason {
            Some(r) => Json::Str(r.to_string()),
            None => Json::Null,
        },
    );
    map.insert("reverted_at".to_string(), Json::Int(facts.reverted_at_unix));
    map.insert("sealed_seq".to_string(), Json::Int(facts.sealed_seq));
    map.insert("sources".to_string(), Json::Str(facts.sources.to_string()));
    map.insert(
        "window_seconds".to_string(),
        Json::Int(facts.window_seconds),
    );
    Ok(authority::row_seal(
        &crate::grants::site_row_key(tx, ring).await?,
        &RowFacts {
            table: "console_placements",
            row_id: facts.id,
            chain_seq,
            row_version,
            row_state: &Json::Obj(map).to_canonical_bytes(),
        },
    ))
}

async fn verify_operator_assertion(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    operator: &str,
    message: &[u8],
    signature: &[u8],
) -> Result<(), OperatorError> {
    if signature.len() != authority::SIGNATURE_LEN {
        return Err(OperatorError::Malformed("assertion signature"));
    }
    let key = operators::live_operator_key(tx, ring, operator, now_unix()).await?;
    authority::verify_es256(&key.public_key, message, signature)?;
    Ok(())
}

fn entry_metadata(entry_type: EntryType, fields: &[(&str, Json)]) -> Vec<u8> {
    let mut map = std::collections::BTreeMap::new();
    map.insert(
        "entry_type".to_string(),
        Json::Str(entry_type.as_str().to_string()),
    );
    for (name, value) in fields {
        map.insert((*name).to_string(), value.clone());
    }
    Json::Obj(map).to_canonical_bytes()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before 1970")
        .as_secs() as i64
}

// ---- The SMTP value envelope (decision 11) ----

/// `LP(host)‖LP(port as text)‖LP(tls_mode)‖LP(user)‖LP(password)‖LP(from_address)`,
/// parsed and checked before it is sealed into `site_settings_versions`.
///
/// **The password is a [`Secret`] from the moment it exists.** §5.3: *"SMTP
/// credentials are credentials"*. `tests/no_secret_in_logs.rs` drives this type's
/// refusals and `Debug` with a password shape a real SMTP server accepts.
pub struct SmtpSettings {
    pub host: String,
    pub port: u16,
    pub tls_mode: TlsMode,
    pub user: String,
    pub password: Secret<String>,
    pub from_address: String,
}

impl core::fmt::Debug for SmtpSettings {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SmtpSettings")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("tls_mode", &self.tls_mode)
            .field("user", &self.user)
            .field("password", &self.password)
            .field("from_address", &self.from_address)
            .finish()
    }
}

/// Text, not an integer, so a malformed row is legible in a dump.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TlsMode {
    /// Connect in the clear and upgrade with `STARTTLS` (RFC 3207).
    StartTls,
    /// TLS from the first byte, the "submissions" port (RFC 8314 §3.3).
    Implicit,
    /// No TLS at all. Allowed because a deployment may hand mail to a relay on its
    /// own loopback; never the default.
    None,
}

impl TlsMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StartTls => "starttls",
            Self::Implicit => "implicit",
            Self::None => "none",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "starttls" => Some(Self::StartTls),
            "implicit" => Some(Self::Implicit),
            "none" => Some(Self::None),
            _ => None,
        }
    }
}

/// Parse and check the envelope. Every refusal names the FIELD and never its
/// value: echoing it would put an SMTP password in a 400 body and its logs.
pub fn parse_smtp_value(value: &[u8]) -> Result<SmtpSettings, OperatorError> {
    let mut rest = value;
    let mut fields: Vec<&[u8]> = Vec::with_capacity(6);
    for _ in 0..6 {
        let (field, remainder) =
            crypto::read_lp(rest).ok_or(OperatorError::Malformed("smtp settings"))?;
        fields.push(field);
        rest = remainder;
    }
    if !rest.is_empty() {
        // Exactly six fields; a seventh means a sender believes something untrue about
        // the envelope.
        return Err(OperatorError::Malformed("smtp settings"));
    }
    let text = |i: usize, what: &'static str| -> Result<String, OperatorError> {
        String::from_utf8(fields[i].to_vec()).map_err(|_| OperatorError::Malformed(what))
    };

    let host = text(0, "smtp host")?;
    let host = host.trim().to_string();
    if host.is_empty()
        || host.len() > 253
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b':')
    {
        return Err(OperatorError::Malformed("smtp host"));
    }

    let port: u16 = text(1, "smtp port")?
        .trim()
        .parse()
        .map_err(|_| OperatorError::Malformed("smtp port"))?;
    if port == 0 {
        return Err(OperatorError::Malformed("smtp port"));
    }

    let tls_mode = TlsMode::parse(text(2, "smtp tls mode")?.trim())
        .ok_or(OperatorError::Malformed("smtp tls mode"))?;

    let user = text(3, "smtp user")?;
    if user.len() > 320 {
        return Err(OperatorError::Malformed("smtp user"));
    }

    // **Read as bytes and wrapped before anything can print it.** The bound is what
    // a real SMTP AUTH exchange carries: RFC 4954's initial response is one command
    // line, and RFC 5321 §4.5.3.1.4 bounds that at 512 octets including CRLF. CLAUDE.md
    // rule 2: test against what a real server accepts, not what makes the check easy.
    let password_bytes = fields[4];
    if password_bytes.len() > 255 {
        return Err(OperatorError::Malformed("smtp password"));
    }
    let password = Secret::new(
        String::from_utf8(password_bytes.to_vec())
            .map_err(|_| OperatorError::Malformed("smtp password"))?,
    );

    let from_address = text(5, "smtp from address")?;
    let from_address = from_address.trim().to_string();
    // One `@`, something either side, no spaces or control characters: the shape
    // `accounts.email` carries. Deliberately NOT a full RFC 5322 parser; the mail
    // server will refuse a bad address and a regex here would be a second, wronger
    // rule.
    let at = from_address.find('@');
    let plausible = match at {
        Some(i) => {
            i > 0
                && i + 1 < from_address.len()
                && from_address.len() <= 320
                && !from_address.contains(char::is_whitespace)
                && from_address.rfind('@') == Some(i)
                && !from_address.chars().any(|c| c.is_control())
        }
        None => false,
    };
    if !plausible {
        return Err(OperatorError::Malformed("smtp from address"));
    }

    Ok(SmtpSettings {
        host,
        port,
        tls_mode,
        user,
        password,
        from_address,
    })
}

/// The envelope as the client sends it, for tests and the client library.
pub fn smtp_value_bytes(
    host: &str,
    port: u16,
    tls_mode: TlsMode,
    user: &str,
    password: &str,
    from_address: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(256);
    crypto::lp(&mut out, host.as_bytes());
    crypto::lp(&mut out, port.to_string().as_bytes());
    crypto::lp(&mut out, tls_mode.as_str().as_bytes());
    crypto::lp(&mut out, user.as_bytes());
    crypto::lp(&mut out, password.as_bytes());
    crypto::lp(&mut out, from_address.as_bytes());
    out
}

// ---- The confirmation hook ----

tokio::task_local! {
    /// Which operator the `/admin` request being served verified as.
    ///
    /// **Filled by `admin::verify`, read by [`confirm_on_the_new_host`].** A
    /// task-local, because the handler gets the extensions by value and `verify`
    /// never sees them, and a middleware cannot name the operator without verifying
    /// the session twice. The confirmation must be attributed to the operator who
    /// actually reached the new host.
    static ACTING_OPERATOR: Arc<Mutex<Option<String>>>;
}

/// Record the operator this request verified as. Does nothing outside
/// [`confirm_on_the_new_host`]'s scope, so other callers of `admin::verify` are
/// unaffected.
pub fn note_acting_operator(session: &VerifiedSession) {
    if session.kind() != PrincipalKind::Operator {
        return;
    }
    let id = session.principal_id();
    let _ = ACTING_OPERATOR.try_with(|slot| {
        if let Ok(mut slot) = slot.lock() {
            *slot = Some(id);
        }
    });
}

/// Decision 11's confirmation, as a layer over the console router.
///
/// **The first `/admin` request that VERIFIES on a matching `Host` inside the
/// window.** Not a route: the browser that followed the console signs in on the
/// new host and asks for the console. A 404, refused signature or disabled
/// operator is never a success, so never reaches it.
pub async fn confirm_on_the_new_host(
    State(store): State<Arc<PlacementStore>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let response = ACTING_OPERATOR
        .scope(Arc::clone(&slot), next.run(request))
        .await;
    if !response.status().is_success() {
        return response;
    }
    // Two snapshot reads; with nothing pending or expired, no database work.
    let now = now_unix();
    let (pending, expired) = match store.view().read() {
        Ok(view) => (view.confirm_by(now).is_some(), view.window_ran_out(now)),
        Err(_) => (false, false),
    };
    if expired {
        // The sweep `admin.rs` points at: a window that ran out writes its sealed
        // `console_placement_reverted` on the next console request (no scheduler). The
        // gate already stopped honouring it.
        if let Err(e) = store.sweep().await {
            tracing::error!(error = %e, "an expired console placement could not be reverted");
        }
        return response;
    }
    if !pending {
        return response;
    }
    let operator = slot.lock().ok().and_then(|mut slot| slot.take());
    if let Some(operator) = operator {
        if let Err(e) = store.confirm_on_host(&host, &operator).await {
            tracing::error!(error = %e, "a console placement could not be confirmed");
        }
    }
    response
}

// ---- Routes ----

/// Everything the placement routes need.
///
/// **Its own state and router, deliberately not a field on `admin::AdminState`**,
/// which `main.rs` and two test binaries build. A merging router avoids a
/// conflict in every file that constructs the struct.
#[derive(Clone)]
pub struct PlacementState {
    pub sessions: Arc<SessionStore>,
    pub placement: Arc<PlacementStore>,
    /// ADR-0057 decision 7: the same policy as every other route's state
    /// (`src/client_address.rs`).
    pub client_address: ClientAddress,
}

impl axum::extract::FromRequest<PlacementState> for Signed {
    type Rejection = Refusal;

    async fn from_request(
        request: Request,
        state: &PlacementState,
    ) -> Result<Self, Self::Rejection> {
        Signed::from_request_for(request, &state.sessions, &state.client_address).await
    }
}

/// `POST /admin/placement`, merged **inside** `admin_exposure`'s gate: moving the
/// console is a console act.
pub fn router(state: PlacementState) -> Router {
    Router::new()
        .route("/admin/placement", post(request_placement))
        .with_state(state)
}

/// The unauthenticated flag, **outside `/admin`** (decision 9); answer in [`flag`].
///
/// **It asks the console's own gate, not the placement table.**
/// `FATHOM_ADMIN_HOSTS`/`FATHOM_ADMIN_SOURCES` win over a placement (decision 11),
/// so a client on an ENVIRONMENT-named host must hear "yes" though no row says so.
/// The question is *"would a console request from here be answered?"*, put to
/// [`AdminExposure::allows`] with this request's headers and peer, so there is no
/// second rule to keep in step.
pub fn flag_router(exposure: crate::admin_exposure::AdminExposure) -> Router {
    Router::new()
        .route("/placement/flag", axum::routing::get(flag))
        .with_state(exposure)
}

/// The three fields, in order:
///
/// 1. `LP("yes"|"no")`: would a console request from this host be answered?
/// 2. `LP(confirm_by as text)`, **only when the first is "yes"**; empty when nothing
///    awaits confirmation (so the shape does not depend on which).
/// 3. `LP("environment"|"console"|"open")`: **which rule decided**
///    ([`crate::admin_exposure::AdminExposure::decided_by`]).
///
/// The third is decision 11's *"the form says so and is read-only then"*: the form
/// must know whether the environment is deciding, and a missing deadline cannot say
/// (a confirmed placement has none either). It discloses only which rule is in
/// force.
async fn flag(
    State(exposure): State<crate::admin_exposure::AdminExposure>,
    request: Request<Body>,
) -> Response {
    let now = now_unix();
    let yes = exposure.allows(request.headers(), request.extensions());
    let confirm_by = if yes { exposure.confirm_by(now) } else { None };
    let mut out = Vec::with_capacity(48);
    crypto::lp(&mut out, if yes { b"yes" } else { b"no" });
    if yes {
        let deadline = confirm_by.map(|t| t.to_string()).unwrap_or_default();
        crypto::lp(&mut out, deadline.as_bytes());
    }
    crypto::lp(&mut out, exposure.decided_by().as_bytes());
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        out,
    )
        .into_response()
}

/// `POST /admin/placement`, decision 11.
///
/// Body: `LP(hosts) ‖ LP(sources) ‖ LP(window_seconds) ‖ LP(assertion)`.
/// Answer: `LP(id) ‖ u64(confirm_by)`. An empty window field means
/// [`DEFAULT_WINDOW_SECONDS`].
async fn request_placement(
    State(state): State<PlacementState>,
    signed: Signed,
) -> Result<Response, Refusal> {
    let session = verify(&state, &signed).await?;
    let fields = read_fields(&signed.body, 4)?;
    let hosts = text(&fields[0], "placement hosts")?;
    let sources = text(&fields[1], "placement sources")?;
    let window = text(&fields[2], "placement window")?;
    let window_seconds = if window.trim().is_empty() {
        DEFAULT_WINDOW_SECONDS
    } else {
        window
            .trim()
            .parse::<i64>()
            .map_err(|_| Refusal::from(SessionError::Malformed("placement window")))?
    };

    let requested = state
        .placement
        .request(&session, &hosts, &sources, window_seconds, &fields[3])
        .await
        .map_err(crate::admin::AdminRefusal)?;
    let mut out = Vec::with_capacity(64);
    crypto::lp(&mut out, requested.id.as_bytes());
    crypto::u64_le(&mut out, requested.confirm_by_unix as u64);
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        out,
    )
        .into_response())
}

async fn verify(state: &PlacementState, signed: &Signed) -> Result<VerifiedSession, Refusal> {
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
        // ADR-0057 decision 7: the ending delete a mismatch triggers must run on this
        // transaction; the row just advanced is locked, so a separate connection's
        // `DELETE` would wait forever.
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
    note_acting_operator(&session);
    Ok(session)
}

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

// ---- The test-send's rate limit ----

/// One test-send per operator per five minutes, in the `sign_in_attempts` table §13
/// item 7 keeps: no new table. `bucket_kind` is closed by `0013`'s `CHECK`
/// (`'account'`, `'source'`), so the bucket is `('account', "smtp-test:<operator>")`,
/// which cannot collide with a 26-character ULID account id. The caller ALSO spends
/// the per-source budget via [`SessionStore::check_source_budget`].
pub async fn take_test_send_budget(
    pool: &Pool,
    operator: &str,
    window_seconds: i64,
) -> Result<bool, OperatorError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    // `sign_in_attempts` is behind `app.session_custody` (`0013` §E). Set here
    // because `sessions.rs`'s helper is private; same capability.
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
        .await?;
    let key = format!("smtp-test:{operator}");
    let window = window_seconds.max(1);
    let attempts: i32 = tx
        .query_one(
            // The window start matches `sessions::window_start`: the epoch second floored to
            // the window. The casts are explicit because `EXTRACT(EPOCH FROM ...)` is
            // `numeric` in PostgreSQL 14+, and an unqualified parameter beside it is
            // inferred `numeric` too.
            "INSERT INTO sign_in_attempts (bucket_kind, bucket_key, window_start, attempts) \
             VALUES ('account', $1, \
                     to_timestamp((EXTRACT(EPOCH FROM now())::bigint / $2::bigint) * $2::bigint), \
                     1) \
             ON CONFLICT (bucket_kind, bucket_key, window_start) \
             DO UPDATE SET attempts = sign_in_attempts.attempts + 1 \
             RETURNING attempts",
            &[&key, &window],
        )
        .await?
        .get(0);
    tx.execute("SELECT set_config('app.session_custody', 'no', true)", &[])
        .await?;
    tx.commit().await?;
    Ok(attempts <= 1)
}

/// Peer address, for the HSTS decision and for nothing else.
pub(crate) fn peer_ip(extensions: &axum::http::Extensions) -> Option<IpAddr> {
    extensions
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|axum::extract::ConnectInfo(addr)| addr.ip())
}

/// Whether the request arrived through a proxy this deployment trusts.
pub(crate) fn from_a_trusted_proxy(
    client_address: &ClientAddress,
    extensions: &axum::http::Extensions,
) -> bool {
    let Some(ip) = peer_ip(extensions) else {
        return false;
    };
    client_address
        .trusted_proxies()
        .iter()
        .any(|c| c.contains(ip))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_list_names_every_label_this_module_uses() {
        // One label today; a slice so adding another is a one-line change.
        let used: &[&[u8]] = &[TAG_PLACEMENT_REQUEST];
        for label in used {
            let text = core::str::from_utf8(label).unwrap();
            assert!(
                LABELS.iter().any(|(name, _)| *name == text),
                "{text} is used and is not in LABELS"
            );
        }
    }

    #[test]
    fn an_expired_window_falls_back_and_does_not_open_the_console() {
        let confirmed = Placed {
            hosts: vec!["old.example.test".to_string()],
            sources: vec![],
        };
        let pending = Placed {
            hosts: vec!["new.example.test".to_string()],
            sources: vec![],
        };
        let placement = Placement {
            confirmed: Some(confirmed.clone()),
            pending: Some((pending.clone(), 1_000)),
        };
        assert_eq!(placement.effective(999), Some(&pending));
        assert_eq!(placement.confirm_by(999), Some(1_000));
        // The window has run out and NOTHING has swept it: the gate falls back to the
        // last confirmed placement, not open.
        assert_eq!(placement.effective(1_001), Some(&confirmed));
        assert_eq!(placement.confirm_by(1_001), None);
    }

    #[test]
    fn with_nothing_confirmed_an_expired_window_leaves_the_console_open() {
        let placement = Placement {
            confirmed: None,
            pending: Some((
                Placed {
                    hosts: vec!["new.example.test".to_string()],
                    sources: vec![],
                },
                1_000,
            )),
        };
        assert!(placement.effective(1_001).is_none());
    }

    #[test]
    fn hosts_and_sources_are_checked_before_they_are_stored() {
        // The operator's own text comes back, since their signature covers it.
        assert_eq!(
            check_hosts(" Admin.Example.test:8443, console.example.test ").unwrap(),
            "Admin.Example.test:8443, console.example.test"
        );
        assert_eq!(
            host_list("Admin.Example.test:8443, console.example.test"),
            vec![
                "admin.example.test".to_string(),
                "console.example.test".to_string()
            ]
        );
        assert!(check_hosts("").is_err());
        assert!(check_hosts("   ,  ").is_err());
        assert!(check_hosts("https://admin.example.test").is_err());
        assert!(check_hosts("admin.example.test/console").is_err());
        assert!(check_hosts("admin example test").is_err());

        assert_eq!(
            check_sources("10.0.0.0/8, 127.0.0.1").unwrap(),
            "10.0.0.0/8, 127.0.0.1"
        );
        assert!(check_sources("10.0.0.0/8, nonsense").is_err());
        assert_eq!(sources_text("  "), "0.0.0.0/0,::/0");
    }

    #[test]
    fn the_smtp_envelope_round_trips_and_refuses_what_is_malformed() {
        // A real submission service: host, 587, STARTTLS, an address as login, and a
        // password of the length a provider issues.
        let value = smtp_value_bytes(
            "smtp.example.test",
            587,
            TlsMode::StartTls,
            "fathom@example.test",
            "Tr0ub4dor&3xK!ngf1sh",
            "fathom@example.test",
        );
        let parsed = parse_smtp_value(&value).expect("a well-formed envelope");
        assert_eq!(parsed.host, "smtp.example.test");
        assert_eq!(parsed.port, 587);
        assert_eq!(parsed.tls_mode, TlsMode::StartTls);
        assert_eq!(parsed.from_address, "fathom@example.test");

        // Five fields, not six.
        let mut short = Vec::new();
        crypto::lp(&mut short, b"smtp.example.test");
        crypto::lp(&mut short, b"587");
        crypto::lp(&mut short, b"starttls");
        crypto::lp(&mut short, b"user");
        crypto::lp(&mut short, b"Tr0ub4dor&3xK!ngf1sh");
        assert!(parse_smtp_value(&short).is_err());

        // A seventh field: refused rather than ignored.
        let mut long = value.clone();
        crypto::lp(&mut long, b"surprise");
        assert!(parse_smtp_value(&long).is_err());

        for bad in [
            smtp_value_bytes("", 587, TlsMode::StartTls, "u", "p", "a@b.test"),
            smtp_value_bytes(
                "smtp.example.test",
                0,
                TlsMode::StartTls,
                "u",
                "p",
                "a@b.test",
            ),
            smtp_value_bytes(
                "smtp.example.test",
                587,
                TlsMode::StartTls,
                "u",
                "p",
                "not-an-address",
            ),
            smtp_value_bytes(
                "smtp.example.test",
                587,
                TlsMode::StartTls,
                "u",
                "p",
                "a@b c.test",
            ),
        ] {
            assert!(parse_smtp_value(&bad).is_err());
        }

        // A tls_mode outside the closed set.
        let mut wrong_mode = Vec::new();
        crypto::lp(&mut wrong_mode, b"smtp.example.test");
        crypto::lp(&mut wrong_mode, b"587");
        crypto::lp(&mut wrong_mode, b"ssl-maybe");
        crypto::lp(&mut wrong_mode, b"u");
        crypto::lp(&mut wrong_mode, b"p");
        crypto::lp(&mut wrong_mode, b"a@b.test");
        assert!(parse_smtp_value(&wrong_mode).is_err());
    }

    #[test]
    fn the_smtp_password_is_not_in_the_struct_s_debug() {
        let value = smtp_value_bytes(
            "smtp.example.test",
            587,
            TlsMode::StartTls,
            "fathom@example.test",
            "Tr0ub4dor&3xK!ngf1sh",
            "fathom@example.test",
        );
        let parsed = parse_smtp_value(&value).expect("a well-formed envelope");
        let rendered = format!("{parsed:?}");
        assert!(!rendered.contains("Tr0ub4dor"), "{rendered}");
        assert!(rendered.contains("smtp.example.test"), "{rendered}");
    }
}
