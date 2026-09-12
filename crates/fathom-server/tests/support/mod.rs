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
//!
//! # Two roles, since `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §15.0
//!
//! [`migrated_pool`] now does exactly what `src/main.rs` does at startup:
//! connects as the MIGRATION role (`migrate_test_database_url`, `fathom_test`
//! -- unchanged, still `CREATEROLE`, still the owner) to run
//! `migrate::run` and `db::provision_runtime_login`, then hands back a pool
//! connected as the RUNTIME role (`test_database_url`, `fathom_app` --
//! new, `migrations/0006_runtime_role.sql` creates it `NOLOGIN` and this
//! provisioning step is what turns it into one the driver can actually
//! connect as). **`fathom_app` is the same literal name here and in
//! production** -- unlike the migration role, it is created inside the
//! migration chain itself, so its name is part of the checksummed SQL and
//! cannot vary per deployment the way `fathom`/`fathom_test` does. Every
//! other test in this crate keeps calling
//! [`migrated_pool`] exactly as before; what changed is what is on the other
//! end of the connection it returns.

use deadpool_postgres::Pool;
use tokio_postgres::NoTls;

use fathom_server::config::Config;

/// Where to find PostgreSQL's MIGRATION role for these tests -- the one that
/// owns the schema and holds `CREATEROLE`.
///
/// `FATHOM_MIGRATE_DATABASE_URL`, if set -- so a developer's own database can
/// be used locally -- otherwise the fixed default `.github/workflows/ci.yml`
/// provisions. `fathom_test_pw` is not a production secret; it exists only
/// inside an ephemeral CI service container and a local developer's own
/// throwaway database. **Unchanged from before the role split** -- this is
/// the same role and the same default `test_database_url` used to return.
pub fn migrate_test_database_url() -> String {
    std::env::var("FATHOM_MIGRATE_DATABASE_URL").unwrap_or_else(|_| {
        "postgres://fathom_test:fathom_test_pw@127.0.0.1:5432/fathom_test".to_string()
    })
}

/// Where to find PostgreSQL's RUNTIME role for these tests -- data
/// privileges only, no ownership, no DDL, no `CREATEROLE`. This is the
/// connection every isolation assertion in `tests/repo.rs` and elsewhere
/// runs against, and the one `rls_startup.rs` checks `assert_rls_binds`
/// against, exactly as `DATABASE_URL` is in the shipped deployment.
///
/// `DATABASE_URL`, if set, otherwise the fixed default
/// `.github/workflows/ci.yml` provisions -- **not by creating the role
/// directly**, but by letting [`migrated_pool`] provision it the same way
/// `src/main.rs` does, off the migration role's `CREATEROLE` connection.
pub fn test_database_url() -> String {
    std::env::var("DATABASE_URL").unwrap_or_else(|_| {
        "postgres://fathom_app:fathom_app_pw@127.0.0.1:5432/fathom_test".to_string()
    })
}

/// The password half of a `postgres://` URL, parsed with the driver's own
/// parser rather than by string surgery -- the same reasoning
/// `superuser_client_on_test_database` below already uses for the database
/// name.
fn password_in(url: &str) -> Option<String> {
    let parsed: tokio_postgres::Config = url.parse().ok()?;
    parsed
        .get_password()
        .map(|p| String::from_utf8_lossy(p).into_owned())
}

/// A pool connected to a real PostgreSQL as the MIGRATION role, migrated to
/// the current schema. `#[allow(dead_code)]`: only `tests/migrate_gate.rs`
/// needs to act as this role directly; every other test needs only the
/// runtime pool [`migrated_pool`] returns.
#[allow(dead_code)]
pub async fn migration_pool() -> Pool {
    let url = migrate_test_database_url();
    let config = Config::from_lookup(|k| (k == "DATABASE_URL").then(|| url.clone()))
        .expect("a DATABASE_URL-only config must always parse");
    fathom_server::db::pool(&config).expect("the pool builds without touching the database")
}

/// A pool connected to a real PostgreSQL **as the runtime role**, migrated
/// to the current schema and with that role's login freshly provisioned.
///
/// Mirrors `src/main.rs`'s own startup sequence exactly, rather than a copy
/// of it: connect as the migration role, run `migrate::run`, provision the
/// runtime role's login with `db::provision_runtime_login`, drop the
/// migration connection, then hand back a pool connected as the runtime
/// role. Panics with a message naming what to do, rather than silently
/// skipping -- the brief this crate's tests answer to is explicit that these
/// must run against a real database, not be quietly optional.
pub async fn migrated_pool() -> Pool {
    let migrate_url = migrate_test_database_url();
    let migrate_config =
        Config::from_lookup(|k| (k == "DATABASE_URL").then(|| migrate_url.clone()))
            .expect("a DATABASE_URL-only config must always parse");
    let migrate_pool = fathom_server::db::pool(&migrate_config)
        .expect("the pool builds without touching the database");

    let mut client = migrate_pool.get().await.unwrap_or_else(|e| {
        panic!(
            "could not reach a real PostgreSQL at {migrate_url:?} ({e}). Set \
             FATHOM_MIGRATE_DATABASE_URL to point at one, or see `.github/workflows/ci.yml` for \
             how CI provisions the non-superuser, CREATEROLE-holding `fathom_test` role and \
             database this default expects."
        )
    });
    // Every test in this crate calls `migrated_pool`, and `#[tokio::test]`s
    // run concurrently by default -- so without serialising, many of them
    // issue `ALTER ROLE fathom_app ... PASSWORD` at once and PostgreSQL's
    // catalog update can lose that race with "tuple concurrently updated".
    // `migrate::run` already takes `MIGRATION_LOCK_KEY` for its own duration;
    // holding it across the provisioning step too is the same fix
    // `src/main.rs` applies, and `pg_advisory_lock` is session-level and
    // re-entrant, so `run`'s own acquisition nests inside this one without
    // deadlocking against it.
    client
        .execute(
            "SELECT pg_advisory_lock($1)",
            &[&fathom_server::migrate::MIGRATION_LOCK_KEY],
        )
        .await
        .expect("take the migration lock");

    let migrate_result = fathom_server::migrate::run(&mut client).await;

    let app_url = test_database_url();
    let app_config = Config::from_lookup(|k| (k == "DATABASE_URL").then(|| app_url.clone()))
        .expect("a DATABASE_URL-only config must always parse");
    let runtime_role = fathom_server::db::runtime_role(&app_config)
        .expect("the runtime test URL must name a user");
    let provision_result = fathom_server::db::provision_runtime_login(
        &client,
        &runtime_role,
        password_in(&app_url).as_deref(),
    )
    .await;

    let _ = client
        .execute(
            "SELECT pg_advisory_unlock($1)",
            &[&fathom_server::migrate::MIGRATION_LOCK_KEY],
        )
        .await;

    migrate_result
        .expect("migrations must apply cleanly against a fresh or already-migrated database");
    provision_result.expect("provisioning the runtime test role's login must succeed");

    fathom_server::db::pool(&app_config).expect("the pool builds without touching the database")
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
