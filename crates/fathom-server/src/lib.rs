//! The Fathom server.
//!
//! **WO-11's skeleton**, plus Phase 2's foundation: accounts, organisations,
//! membership, and the scope hierarchy (`repo`, `ids`).
//!
//! # Why identity and structure may be stored, and nothing else may be yet
//!
//! `docs/OPEN-QUESTIONS.md` A1 -- where the master key lives -- is still
//! open, and ADR-0040 requires a data key per tenant **and** per design from
//! the first stored byte of a design or a credential. That gate has not
//! lifted. What changed is that `docs/PHASE-2-STORAGE-DESIGN.md` §1 names two
//! things that are **not** behind it: "Identity" (accounts, organisations,
//! membership) and "Structure" (the scope hierarchy), both "Low -- must be
//! queryable", as distinct from "Designs" and "Vault", which stay gated.
//! `tests/no_key_protected_data.rs` (successor to `tests/stores_nothing.rs`)
//! enforces the narrowed line: an explicit table allowlist, so a design
//! payload, a credential or a wrapped key still cannot appear here without
//! someone deliberately widening that list and saying why.
//!
//! # What the order this crate arrived under was actually about
//!
//! Not the server. `49` §20: zero external dependencies is *"the project's
//! greatest current security advantage, and it is about to be spent. Spend it
//! deliberately."* The five layers that spend it are `scripts/gate-zero.sh`,
//! `deny.toml`, `cargo audit`, the reviewed lockfile diff (with
//! `scripts/lockfile-lookalikes.sh` doing its mechanical half) and
//! `scripts/crate-cooldown.sh`. All four gates found something real on the way
//! in; `deps/decisions/00-CLOSURE-SERVER.md` records what.
//!
//! # What is NOT here, and where it goes
//!
//! Sessions, sign-in, the HTTP API, WebSockets and opcodes are all a later
//! order's. Design tables and the credential vault need the key boundary
//! first (WO-11 §8, ADR-0040 §9 items 1 and 2).

pub mod config;
pub mod db;
pub mod engine;
pub mod health;
pub mod healthcheck;
pub mod ids;
pub mod migrate;
pub mod repo;
pub mod secret;

use std::sync::Arc;

use axum::extract::FromRef;
use axum::routing::get;
use axum::Router;

use crate::config::Config;
use crate::engine::EngineState;
use crate::health::HealthState;

/// The one startup line the server logs about its own configuration.
///
/// **It lives here rather than inline in `main` so that WO-11 §6 G6's test can
/// drive the real thing.** A test that re-types the log statement it is
/// checking proves that the copy is safe, which is not the claim anyone wants.
pub fn log_startup(config: &Config) {
    tracing::info!(
        database = %config.database_for_logging(),
        bind = %config.bind,
        "starting"
    );
}

/// Everything the router hands handlers via `State`.
///
/// Two independent pieces held together only because axum wants one state
/// type per router: `HealthState` reads the database and never the schema;
/// `EngineState` reads the schema and never the database. `FromRef` below is
/// what lets `health::handler` and `engine::kinds_handler` keep asking for
/// their own piece (`State<Arc<HealthState>>`, `State<Arc<EngineState>>`)
/// rather than this struct.
#[derive(Clone)]
pub struct AppState {
    pub health: Arc<HealthState>,
    pub engine: Arc<EngineState>,
}

impl FromRef<AppState> for Arc<HealthState> {
    fn from_ref(app: &AppState) -> Self {
        app.health.clone()
    }
}

impl FromRef<AppState> for Arc<EngineState> {
    fn from_ref(app: &AppState) -> Self {
        app.engine.clone()
    }
}

/// The router. `/health` (WO-11's), and `/schema/kinds` (this order's) —
/// still read-only, still nothing stored.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::handler))
        .route("/schema/kinds", get(engine::kinds_handler))
        .with_state(state)
}
