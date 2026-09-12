//! Shared support for the tests that need a real PostgreSQL.
//!
//! **This crate's tests use a real database, not a mock**, for the
//! repository layer and for the table-allowlist test that used to be
//! `stores_nothing.rs`. That needs somewhere to connect to; this is the one
//! place that decides where.
//!
//! # Why the connecting role must not be a superuser
//!
//! `migrations/0002_identity_and_scope.sql` enables row-level security and
//! `FORCE`s it, so that it binds even for the role that owns the tables. It
//! still cannot bind for an actual Postgres superuser -- Postgres exempts
//! superusers from row security unconditionally, regardless of `FORCE`. A
//! test role that happened to be superuser would make every isolation
//! assertion in `tests/repo.rs` pass whether or not the policies actually
//! work, which is worse than not testing it at all. `.github/workflows/ci.yml`
//! provisions a dedicated, deliberately non-superuser `fathom_test` role and
//! database for exactly this reason; the default below matches it.

use deadpool_postgres::Pool;

use fathom_server::config::Config;

/// Where to find PostgreSQL for these tests.
///
/// `DATABASE_URL`, if set -- so a developer's own database can be used
/// locally -- otherwise the fixed default `.github/workflows/ci.yml`
/// provisions. `fathom_test_pw` is not a production secret; it exists only
/// inside an ephemeral CI service container and a local developer's own
/// throwaway database.
pub fn test_database_url() -> String {
    std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgres://fathom_test:fathom_test_pw@127.0.0.1:5432/fathom_test".to_string()
    })
}

/// A pool connected to a real PostgreSQL, migrated to the current schema.
///
/// Panics with a message naming what to do, rather than silently skipping --
/// the brief this crate's tests answer to is explicit that these must run
/// against a real database, not be quietly optional.
pub async fn migrated_pool() -> Pool {
    let url = test_database_url();
    let config = Config::from_lookup(|k| (k == "DATABASE_URL").then(|| url.clone()))
        .expect("a DATABASE_URL-only config must always parse");
    let pool =
        fathom_server::db::pool(&config).expect("the pool builds without touching the database");

    let mut client = pool.get().await.unwrap_or_else(|e| {
        panic!(
            "could not reach a real PostgreSQL at {url:?} ({e}). Set DATABASE_URL to point at \
             one, or see `.github/workflows/ci.yml` for how CI provisions the non-superuser \
             `fathom_test` role and database this default expects."
        )
    });
    fathom_server::migrate::run(&mut client)
        .await
        .expect("migrations must apply cleanly against a fresh or already-migrated database");

    pool
}
