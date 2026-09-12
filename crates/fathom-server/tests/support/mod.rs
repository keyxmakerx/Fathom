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

/// The chain master every test that touches the **site chain** must use.
///
/// There is exactly one site chain per database (`0009`'s one-row
/// `deployments` table), and these tests share a database. A suite that
/// appended under its own chain master would leave entries no other suite can
/// verify -- and the symptom is `BROKEN AT ENTRY 1`, which reads as a forgery
/// alarm rather than as a fixture problem.
///
/// Per-design and per-organisation chains need no such agreement: those chains
/// are per id, so each test's own design or organisation is already isolated.
#[allow(dead_code)]
pub const SITE_CHAIN_MASTER: [u8; 32] = [83; 32];

/// The advisory lock key that serialises access to the shared site chain.
const SITE_CHAIN_LOCK: i64 = 0x5f17_e0a1_7a11_0001u64 as i64;

/// The advisory lock key that serialises access to the shared audit spool.
const SPOOL_LOCK: i64 = 0x5f17_e0a1_7a11_0002u64 as i64;

/// Hold the site chain against every other test, in this binary and in every
/// other one.
///
/// Two tests deliberately break a site entry to prove the verifier reports it,
/// and there is exactly one site chain per database. A process-local mutex
/// would not do: `cargo test` runs each test BINARY in parallel, so
/// `design_storage`, `append_only_fence` and `audit_chains` are separate
/// processes against one PostgreSQL. A session-level advisory lock is the
/// thing that spans them, and it needs no privilege and no cleanup -- it is
/// released when the returned connection drops at the end of the test.
///
/// Returned rather than dropped, and named `_site` at the call sites, because
/// what keeps the lock is the connection being alive.
#[allow(dead_code)]
pub async fn lock_the_site_chain() -> tokio_postgres::Client {
    let client = superuser_client_on_test_database().await;
    client
        .execute("SELECT pg_advisory_lock($1)", &[&SITE_CHAIN_LOCK])
        .await
        .expect("take the site chain lock");
    client
}

/// Act as **the** shipper, exclusively.
///
/// `audit_spool` is one queue per deployment and `audit::drain_once` takes the
/// oldest batch of it, whoever queued them -- which is the design, because in
/// production there is one shipper. So two tests draining at once each ship
/// some of the other's entries, and both then find their own queue short. The
/// lock makes "I am the shipper" true for the duration of a test, which is the
/// condition the code was written under.
///
/// Other test binaries may still QUEUE entries while this is held; that is
/// harmless, because every assertion is scoped to its own `chain_id`.
///
/// Take it AFTER [`lock_the_site_chain`] where both are needed -- one order,
/// so two tests cannot each hold one and wait for the other.
#[allow(dead_code)]
pub async fn lock_the_spool() -> tokio_postgres::Client {
    let client = superuser_client_on_test_database().await;
    client
        .execute("SELECT pg_advisory_lock($1)", &[&SPOOL_LOCK])
        .await
        .expect("take the spool lock");
    client
}

/// Tamper with an append-only table, the way a **tier-3** attacker would have
/// to.
///
/// `migrations/0009_chains_at_three_levels.sql` puts a `BEFORE UPDATE OR
/// DELETE ... FOR EACH ROW` trigger on `chain_entries` and `deployments`, plus
/// a statement-level one for `TRUNCATE`. A trigger fires for whoever is
/// connected, so it binds a superuser too -- which is the point, and
/// `tests/append_only_fence.rs` proves it by trying and failing.
///
/// But several tests in `design_storage.rs` need to PRODUCE a tampered row, so
/// that the verifier can be shown to catch it. `ALTER TABLE ... DISABLE
/// TRIGGER USER` is the only way in, and that is exactly the point: the
/// migration's own header says the fence *"does not bind someone who alters
/// the table first"* and rates that a tier-3 move. So these tests now also
/// demonstrate the escape they depend on, rather than quietly having a
/// privilege the fence was supposed to remove.
///
/// Not a weakening of anything: every assertion those tests made about what
/// the verifier reports is unchanged. What changed is the cost of getting
/// there, which is now visible in the test body.
#[allow(dead_code)]
pub async fn tamper(
    client: &tokio_postgres::Client,
    table: &str,
    sql: &str,
    params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
) -> u64 {
    client
        .batch_execute(&format!("ALTER TABLE {table} DISABLE TRIGGER USER"))
        .await
        .unwrap_or_else(|e| {
            panic!(
                "disabling the append-only trigger on {table} needs ownership -- a tier-3 move, \
                 which is what this helper exists to make visible: {e}"
            )
        });
    let result = client.execute(sql, params).await;
    client
        .batch_execute(&format!("ALTER TABLE {table} ENABLE TRIGGER USER"))
        .await
        .expect("re-enable the append-only trigger");
    result.expect("the tampering statement itself must succeed once the trigger is off")
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
