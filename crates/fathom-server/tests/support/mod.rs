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
use tokio_postgres::NoTls;

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

/// Where to find PostgreSQL's bootstrap superuser -- the role
/// `src/rls.rs`'s startup gate must refuse, and the role
/// `.github/workflows/ci.yml`'s `postgres` service already runs as.
///
/// `SUPERUSER_DATABASE_URL`, if set, otherwise the fixed default the CI
/// service container's own `POSTGRES_USER`/`POSTGRES_PASSWORD` matches.
/// **Not a production credential** -- exactly like `test_database_url`'s
/// `fathom_test_pw`, this exists only inside an ephemeral CI service
/// container or a local developer's own throwaway database.
///
/// `#[allow(dead_code)]`: `mod support;` is compiled fresh into every test
/// binary in this crate, and only `tests/rls_startup.rs` calls this one --
/// the others have no reason to hold a superuser connection at all.
#[allow(dead_code)]
pub fn superuser_database_url() -> String {
    std::env::var("SUPERUSER_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:5432/postgres".to_string())
}

/// A raw connection as the bootstrap superuser, but to the **test
/// database** rather than to the superuser's own.
///
/// `migrations/0004_principals.sql` builds a fence out of composite foreign
/// keys precisely because a constraint binds at every privilege level:
/// PostgreSQL exempts superusers from row security, but not from referential
/// integrity. Proving that needs the most privileged role available pointed
/// at the schema the migrations built, which is neither of the two
/// connections above -- [`migrated_pool`] is deliberately restricted, and
/// [`superuser_client`] is deliberately connected elsewhere.
///
/// Built by parsing both URLs with the driver's own parser and moving the
/// database name across, rather than by string surgery on a URL that may
/// carry a password.
///
/// `#[allow(dead_code)]`: `mod support;` compiles into every test binary in
/// this crate, and only the plane and principal fence tests need this one.
#[allow(dead_code)]
pub async fn superuser_client_on_test_database() -> tokio_postgres::Client {
    let test: tokio_postgres::Config = test_database_url()
        .parse()
        .expect("the test DATABASE_URL must parse");
    let mut config: tokio_postgres::Config = superuser_database_url()
        .parse()
        .expect("the superuser database URL must parse");
    config.dbname(test.get_dbname().expect("a database name"));

    let (client, connection) = config.connect(NoTls).await.unwrap_or_else(|e| {
        panic!(
            "could not reach a PostgreSQL superuser on the test database ({e}). Set \
             SUPERUSER_DATABASE_URL to a bootstrap superuser on the same cluster as \
             DATABASE_URL -- see `.github/workflows/ci.yml`."
        )
    });
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}

/// A raw connection authenticated as the PostgreSQL bootstrap superuser --
/// deliberately not a pool, because the only thing this is ever used for is
/// proving `rls::assert_rls_binds` refuses it.
///
/// Panics with a message naming what to do, rather than silently skipping,
/// for the same reason `migrated_pool` does: this crate's tests answer to a
/// brief that requires a real database, not a mock.
#[allow(dead_code)]
pub async fn superuser_client() -> tokio_postgres::Client {
    let url = superuser_database_url();
    let (client, connection) = tokio_postgres::connect(&url, NoTls)
        .await
        .unwrap_or_else(|e| {
            panic!(
                "could not reach a real PostgreSQL superuser at {url:?} ({e}). Set \
             SUPERUSER_DATABASE_URL to point at one, or see `.github/workflows/ci.yml` for the \
             bootstrap `postgres` role this default expects."
            )
        });
    // The connection object drives the actual I/O; it must be polled for the
    // client to do anything. Spawned and deliberately dropped rather than
    // held: this connection lives exactly as long as the test that asked for
    // it, and there is no pool here to outlive it.
    tokio::spawn(async move {
        let _ = connection.await;
    });
    client
}
