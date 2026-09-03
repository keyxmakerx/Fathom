//! The Fathom server.
//!
//! **WO-11's skeleton, and deliberately almost nothing.** It starts, it answers
//! a health check, it shuts down cleanly, and **it stores nothing at all** —
//! WO-11 §6 G8 forbids any table but the migrations table, because ADR-0040's
//! key boundary is not yet decided and *the first row written before custody is
//! decided is exactly the retrofit ADR-0040 exists to prevent*.
//!
//! The real objective of the order this crate arrived under is the dependency
//! gate around it, not the server: `49` §20 says zero external dependencies is
//! *"the project's greatest current security advantage, and it is about to be
//! spent. Spend it deliberately."* See `deny.toml`, `scripts/gate-zero.sh`,
//! `scripts/lockfile-lookalikes.sh` and `scripts/crate-cooldown.sh`.
//!
//! # What is NOT here, and where it goes
//!
//! Accounts, sessions, sign-in, tenants, graph tables, the HTTP API, WebSockets
//! and opcodes are all the next order's, and every one of them needs the key
//! boundary first (WO-11 §8).

fn main() {
    println!("fathom-server: nothing to run yet");
}
