//! The Fathom server.
//!
//! **WO-11's skeleton, and deliberately almost nothing.** It starts, it answers
//! a health check, it shuts down cleanly, and **it stores nothing at all**.
//!
//! # Why it stores nothing
//!
//! WO-11 §6 G8 forbids any table but the migrations table, and
//! `tests/stores_nothing.rs` enforces it. ADR-0040 decided the server holds a
//! data key per tenant **and** per design from the first stored byte, and
//! ADR-0040 §9 items 1 and 2 leave the key-management service undecided —
//! including for self-hosted deployments with no cloud KMS. WO-11 §7 trigger 2:
//! *the first row written before custody is decided is exactly the retrofit
//! ADR-0040 exists to prevent.*
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
//! Accounts, sessions, sign-in, tenants, graph tables, the HTTP API,
//! WebSockets and opcodes are all the next order's, and every one of them needs
//! the key boundary first (WO-11 §8).

pub mod config;
pub mod db;
pub mod health;
pub mod healthcheck;
pub mod migrate;
pub mod secret;

use std::sync::Arc;

use axum::routing::get;
use axum::Router;

use crate::config::Config;

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

/// The router. One endpoint.
pub fn router(state: Arc<health::HealthState>) -> Router {
    Router::new()
        .route("/health", get(health::handler))
        .with_state(state)
}
