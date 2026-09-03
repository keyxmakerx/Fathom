//! `/health`, and the reason it is not a function that returns `"ok"`.
//!
//! WO-11 §5 step 4: *"It must perform a real query. A health check that reports
//! healthy while the database is down is worse than none: it is the paste hint
//! that said `REPLACES` (`49` §19's lesson (d)) in operational clothing."*
//!
//! That lesson is worth restating because it is the same defect twice. The
//! paste sheet told an operator a paste would REPLACE the estate after the
//! behaviour had changed to additive; a warning that names the wrong outcome is
//! worse than none, because it teaches an operator to ignore the next one. A
//! health check that answers 200 while the database is unreachable teaches an
//! orchestrator the same lesson, and the orchestrator acts on it by routing
//! traffic to a server that cannot serve.
//!
//! So this handler:
//!
//! 1. takes a connection **from the pool**, which fails if the pool cannot
//!    reach the database;
//! 2. runs a real query and **checks the value that comes back**, not merely
//!    that no error was returned;
//! 3. does both under a timeout, so a hung database answers 503 rather than
//!    holding the request open until something else gives up.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use deadpool_postgres::Pool;

/// What the handler needs.
#[derive(Clone)]
pub struct HealthState {
    pub pool: Pool,
    pub timeout: Duration,
}

/// Why the check failed. Each variant is a different question answered.
#[derive(Debug, PartialEq, Eq)]
pub enum Unhealthy {
    /// The pool could not give us a connection inside the timeout.
    NoConnection,
    /// The query itself failed or timed out.
    QueryFailed,
    /// The query returned, and returned the wrong thing. **This is the variant
    /// that stops the check being a formality**: something answered on the
    /// port, and it did not answer like PostgreSQL.
    WrongAnswer,
}

impl Unhealthy {
    /// The one word this failure puts in the response body.
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NoConnection => "no database connection",
            Self::QueryFailed => "database query failed",
            Self::WrongAnswer => "database answered unexpectedly",
        }
    }
}

/// Ask the database whether it is really there.
///
/// Separate from the handler so it can be driven directly against a real
/// PostgreSQL without an HTTP client in the way.
pub async fn probe(pool: &Pool, timeout: Duration) -> Result<(), Unhealthy> {
    let client = match tokio::time::timeout(timeout, pool.get()).await {
        Ok(Ok(c)) => c,
        // Both a pool error and the timeout elapsing mean the same thing to a
        // caller: there is no connection to be had right now.
        Ok(Err(_)) | Err(_) => return Err(Unhealthy::NoConnection),
    };

    // `SELECT 1` and then CHECK THE 1. A query that returns no rows, or a row
    // with the wrong value, is not a healthy database — and asserting only that
    // the call did not error would pass on both.
    let rows = match tokio::time::timeout(timeout, client.query("SELECT 1::int4", &[])).await {
        Ok(Ok(rows)) => rows,
        Ok(Err(_)) | Err(_) => return Err(Unhealthy::QueryFailed),
    };

    match rows.first().map(|r| r.get::<_, i32>(0)) {
        Some(1) => Ok(()),
        _ => Err(Unhealthy::WrongAnswer),
    }
}

/// `GET /health`.
///
/// 200 with `ok` when the database answered; **503** with the reason otherwise.
/// 503 rather than 500 because it is the status an orchestrator reads as
/// *"do not send me traffic yet"* rather than *"this server is broken"*.
pub async fn handler(State(state): State<Arc<HealthState>>) -> impl IntoResponse {
    match probe(&state.pool, state.timeout).await {
        Ok(()) => (StatusCode::OK, "ok\n".to_string()),
        Err(why) => {
            // The reason is logged and returned. Neither carries the database
            // URL: `Unhealthy` holds no strings from the environment, and the
            // driver's own error is deliberately not formatted in, because a
            // connection error's Display can contain the connection string.
            tracing::warn!(reason = why.reason(), "health check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("unavailable: {}\n", why.reason()),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_reason_is_a_distinct_sentence() {
        let all = [
            Unhealthy::NoConnection,
            Unhealthy::QueryFailed,
            Unhealthy::WrongAnswer,
        ];
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a.reason(), b.reason());
            }
        }
    }

    #[test]
    fn no_reason_could_carry_a_connection_string() {
        // The variants hold no data at all, so there is nothing for a URL to
        // travel in. This test exists so that adding a `String` field to one of
        // them is a deliberate act with a failing test attached.
        for r in [
            Unhealthy::NoConnection,
            Unhealthy::QueryFailed,
            Unhealthy::WrongAnswer,
        ] {
            assert!(!r.reason().contains("://"), "{}", r.reason());
            assert!(!r.reason().contains('@'), "{}", r.reason());
        }
    }
}
