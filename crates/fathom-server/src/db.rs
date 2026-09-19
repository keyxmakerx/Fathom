//! The connection pool.
//!
//! Small on purpose. `deps/decisions/deadpool-postgres.md` carries the rule
//! that binds anything written on top of it: **a pool hands out whichever
//! connection is free, so nothing may depend on which one.** Session-scoped
//! state — `SET`, temporary tables, prepared statements outside the driver's
//! own cache — is therefore forbidden here, because a later request gets a
//! different connection and the state will not be there.

use deadpool_postgres::{Config as PoolConfig, ManagerConfig, Pool, RecyclingMethod, Runtime};
use tokio_postgres::NoTls;

use crate::config::Config;
use crate::secret::Secret;
use std::time::Duration;

/// Why the pool could not be built.
///
/// **Carries no string from the environment.** The database URL is the value it
/// would otherwise be describing.
#[derive(Debug)]
pub enum DbError {
    /// The connection string is not one this driver understands.
    UnparseableUrl,
    /// The pool itself refused to be built.
    Pool,
    /// `DATABASE_URL` parsed, but named no user at all, so there is nothing
    /// to hand to `ALTER ROLE ... LOGIN` when provisioning the runtime
    /// role's ability to connect (`main.rs`'s startup sequence).
    NoUser,
}

impl core::fmt::Display for DbError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnparseableUrl => f.write_str(
                "a configured database URL is not a connection string tokio-postgres \
                 understands. Its value is not shown here on purpose.",
            ),
            Self::Pool => f.write_str("the connection pool could not be created"),
            Self::NoUser => f.write_str(
                "DATABASE_URL names no user. The runtime role's name comes from this URL, \
                 and there is nothing to provision a login for without one.",
            ),
        }
    }
}

impl std::error::Error for DbError {}

/// The shared guts of [`pool`] and [`migration_pool`]: a connection string
/// and an optional password-file override, built into a deadpool `Pool`.
///
/// **`NoTls`, and that is WO-11 trigger 4 in one word.** `49` §6 keeps C7 — no
/// C or C++ in the shipped closure — only if TLS is terminated in front of the
/// binary, because `rustls`'s crypto provider brings C and assembly back in.
/// `43` §5.4 decided TLS in front, so PostgreSQL sits on a Unix socket or
/// loopback and there is nothing here to encrypt against. `deny.toml` bans the
/// four C carriers by name so this cannot be undone transitively.
///
/// **The day PostgreSQL is on another host, this line is the decision to
/// revisit** — not by adding a TLS feature without thinking, but by re-reading
/// `deps/decisions/tokio-postgres.md`'s note on the threat model the three 2026
/// advisories share.
fn build_pool(
    url: &Secret<String>,
    password_override: Option<&Secret<String>>,
    pool_size: usize,
) -> Result<Pool, DbError> {
    let pg: tokio_postgres::Config = url.expose().parse().map_err(|_| DbError::UnparseableUrl)?;

    let mut cfg = PoolConfig::new();
    cfg.manager = Some(ManagerConfig {
        // Verified: a connection handed out has been checked since it was last
        // returned. `Fast` would skip that and hand out a connection the
        // database has since closed, which turns a pool into a source of
        // intermittent failures.
        recycling_method: RecyclingMethod::Verified,
    });
    cfg.pool = Some(deadpool_postgres::PoolConfig::new(pool_size));
    cfg.dbname = pg.get_dbname().map(ToOwned::to_owned);
    cfg.user = pg.get_user().map(ToOwned::to_owned);
    // The file wins over the URL. `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`
    // §1.4: the application's database password is generated at first start
    // into the key volume, so in the shipped deployment `DATABASE_URL`
    // carries a user and a host and no password at all. The URL branch
    // remains for a developer running against a local database by hand.
    cfg.password = match password_override {
        Some(password) => Some(password.expose().clone()),
        None => pg
            .get_password()
            .map(|p| String::from_utf8_lossy(p).into_owned()),
    };
    cfg.host = pg.get_hosts().iter().find_map(|h| match h {
        tokio_postgres::config::Host::Tcp(h) => Some(h.clone()),
        #[cfg(unix)]
        tokio_postgres::config::Host::Unix(p) => Some(p.to_string_lossy().into_owned()),
        #[allow(unreachable_patterns)]
        _ => None,
    });
    cfg.port = pg.get_ports().first().copied();

    cfg.create_pool(Some(Runtime::Tokio1), NoTls)
        .map_err(|_| DbError::Pool)
}

/// Build the RUNTIME pool from the configuration.
///
/// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §15.0: this is the role that
/// serves every request, holding data privileges only — no ownership, no
/// DDL, no `CREATEROLE`. See [`migration_pool`] for the other half.
pub fn pool(config: &Config) -> Result<Pool, DbError> {
    build_pool(
        &config.database_url,
        config.database_password.as_ref(),
        config.pool_size,
    )
}

/// Build the MIGRATION pool from the configuration, if a migration
/// credential was configured at all.
///
/// `Ok(None)` when `FATHOM_MIGRATE_DATABASE_URL` is unset — a supported
/// shape, not a partial failure. `main.rs` decides what that means for
/// startup; this function only reports whether there is anything to connect
/// with. Used once, briefly, and then dropped — `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`
/// §15.0: "used once at startup and then not held."
pub fn migration_pool(config: &Config) -> Result<Option<Pool>, DbError> {
    match &config.migrate_database_url {
        None => Ok(None),
        Some(url) => build_pool(
            url,
            config.migrate_database_password.as_ref(),
            config.pool_size,
        )
        .map(Some),
    }
}

/// The runtime role's name, read out of `DATABASE_URL` rather than
/// hardcoded — a deployment names its own roles, and this crate does not
/// need to know `fathom_app` by name to provision its login (see
/// `migrations/0006_runtime_role.sql`'s header for why the role itself is
/// still created under a fixed name there).
pub fn runtime_role(config: &Config) -> Result<String, DbError> {
    let pg: tokio_postgres::Config = config
        .database_url
        .expose()
        .parse()
        .map_err(|_| DbError::UnparseableUrl)?;
    pg.get_user().map(ToOwned::to_owned).ok_or(DbError::NoUser)
}

/// Double an embedded single quote, the same escaping PostgreSQL's own
/// string-literal syntax uses, and wrap the result in quotes.
///
/// **Why not a bind parameter.** `ALTER ROLE ... PASSWORD $1` is not valid:
/// PostgreSQL's grammar for `AlterRoleStmt` takes the password as an
/// `Sconst` — a literal in the query text — not an expression position a
/// parameter can fill, which is exactly why the existing
/// `deploy/init-db/10-app-role.sh` uses `psql -v` variable substitution
/// rather than a driver-level parameter for the same statement. The values
/// this crate passes here are generated by that same script from
/// `/dev/urandom` and are 64 lowercase hex characters, so escaping is belt
/// and braces rather than the load-bearing control — but a role or password
/// this function might one day be asked to quote should never be assumed to
/// stay that shape.
fn quote_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The same escaping, for a role name used as an identifier.
fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Give the runtime role the ability to log in, with the current runtime
/// password — idempotent, safe to run on every startup that holds a
/// migration connection.
///
/// **Why this is code and not a numbered migration.** A migration's text is
/// checksum-pinned (`migrate::checksum`, `MigrateError::Changed`) precisely
/// so that an applied one is never silently edited. A password read from a
/// file at startup is not a constant either file could embed that way — it
/// is a secret regenerated per deployment, not a schema change — so it is
/// applied here, by the migration connection, after `migrate::run` and
/// before that connection is dropped. `migrations/0006_runtime_role.sql`
/// creates the role `NOLOGIN`, exactly as `fathom_operator` was created in
/// `0005`; this is what turns that into a role the runtime pool can actually
/// connect as, mirroring `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.4's own
/// words: *"the server generates a random password ... and `ALTER ROLE
/// fathom_app PASSWORD` it."* The one place this still deviates from §1.4 as
/// written is that the SERVER does not generate the password itself — `43`
/// §5.4's read-only filesystem means the server container cannot write into
/// the key volume, so `deploy/init-db/10-app-role.sh` generates it, exactly
/// as it already does for the migration role's own password.
pub async fn provision_runtime_login(
    client: &tokio_postgres::Client,
    role: &str,
    password: Option<&str>,
) -> Result<(), tokio_postgres::Error> {
    let statement = match password {
        Some(password) => format!(
            "ALTER ROLE {} LOGIN PASSWORD {}",
            quote_ident(role),
            quote_literal(password)
        ),
        // No password configured -- a local developer's trust/peer-auth
        // database, most likely. Grant LOGIN and leave authentication to
        // whatever `pg_hba.conf` already decides for this role.
        None => format!("ALTER ROLE {} LOGIN", quote_ident(role)),
    };
    // `ALTER ROLE` updates `pg_authid`, which is a CLUSTER-wide catalogue, and
    // two backends updating the same role's row at once lose that race with
    // `XX000 tuple concurrently updated`. This is not hypothetical and it is
    // not only a test concern: this deployment runs **two interchangeable
    // containers** (REBUILD-PLAN, operational foundations item 1), both of
    // which provision the runtime login at startup, so a simultaneous start
    // races exactly here and one container dies.
    //
    // **An advisory lock cannot fix this, and one was believed to.**
    // `tests/support/mod.rs` held `MIGRATION_LOCK_KEY` across this call and
    // said so in a comment. Advisory locks are scoped to the database: measured
    // on PostgreSQL 16 on 2026-09-14, the same key taken in database A is
    // still free in database B on the same cluster, while this catalogue row is
    // shared by both. So the lock serialises callers inside one database and
    // nothing across databases -- which is the arrangement `docs/NEXT.md`
    // rule 3 asks every builder to use.
    //
    // The statement is idempotent, the conflict is transient, and a bounded
    // retry is what PostgreSQL's own catalogue-update contention wants. Five
    // attempts over roughly 750 ms is far past what a handful of concurrent
    // starters needs, and a failure after that is a real one worth surfacing.
    let mut backoff = Duration::from_millis(50);
    for attempt in 1..=5 {
        match client.batch_execute(&statement).await {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 5 && is_concurrent_catalogue_update(&e) => {
                tokio::time::sleep(backoff).await;
                backoff *= 2;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!("the loop returns on the fifth attempt either way")
}

/// Did this fail because another backend updated the same catalogue row?
///
/// Matched on the message rather than on `SqlState` alone: `XX000` is
/// `internal_error` and covers a great deal more than this, so treating every
/// `XX000` as retryable would retry genuine faults. PostgreSQL raises this one
/// from `simple_heap_update` in `heapam.c` with a fixed wording.
fn is_concurrent_catalogue_update(e: &tokio_postgres::Error) -> bool {
    e.as_db_error()
        .is_some_and(|db| is_concurrent_catalogue_update_message(db.message()))
}

/// The message half of [`is_concurrent_catalogue_update`], split out so it can
/// be tested without manufacturing a `tokio_postgres::Error`, which has no
/// public constructor.
fn is_concurrent_catalogue_update_message(message: &str) -> bool {
    message.contains("tuple concurrently updated")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config as ServerConfig;

    fn cfg(url: &str) -> ServerConfig {
        ServerConfig::from_lookup(|k| (k == "DATABASE_URL").then(|| url.to_string())).unwrap()
    }

    #[test]
    fn only_a_concurrent_catalogue_update_is_retried() {
        // The real wording PostgreSQL 16 raised from `simple_heap_update` on
        // 2026-09-14, when two test runs in two databases on one cluster both
        // provisioned the runtime login.
        assert!(is_concurrent_catalogue_update_message(
            "tuple concurrently updated"
        ));
        // Everything else is a real failure and must surface, not spin. These
        // are all `XX000` too, which is why the class alone is not the test.
        for other in [
            "role \"fathom_app\" does not exist",
            "permission denied to alter role",
            "password authentication failed for user \"fathom_app\"",
            "canceling statement due to statement timeout",
            "tuple concurrently deleted",
        ] {
            assert!(
                !is_concurrent_catalogue_update_message(other),
                "must not retry: {other}"
            );
        }
    }

    #[test]
    fn a_pool_is_built_without_touching_the_database() {
        // deadpool is lazy: creating a pool opens no connection, so this test
        // needs no PostgreSQL and asserts only that the URL was understood.
        assert!(pool(&cfg("postgres://fathom:hunter2@127.0.0.1:5432/fathom")).is_ok());
    }

    #[test]
    fn an_unparseable_url_is_refused_without_naming_it() {
        // The canary is in the VALUE, so a message that echoed the input would
        // fail here. (An earlier version of this test looked for a phrase that
        // is also in the static error text, and so could never have failed.)
        let err = pool(&cfg("K4NaRY not-a-connection-string K4NaRY")).unwrap_err();
        for rendered in [format!("{err:?}"), format!("{err}")] {
            assert!(!rendered.contains("K4NaRY"), "{rendered}");
        }
    }

    #[test]
    fn a_url_with_no_password_still_builds_a_pool_when_the_file_supplies_one() {
        // The shipped deployment's shape: `DATABASE_URL` carries a user, a
        // host and a database, and the password comes from the key volume
        // (`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.4).
        let config = ServerConfig::from_lookup_and_files(
            |k| match k {
                "DATABASE_URL" => Some("postgres://fathom@db:5432/fathom".to_string()),
                "FATHOM_DB_PASSWORD_FILE" => Some("/keys/db_app.pw".to_string()),
                _ => None,
            },
            |_| Some("from-the-key-volume".to_string()),
        )
        .unwrap();
        assert!(pool(&config).is_ok());
    }

    #[test]
    fn a_pool_error_never_carries_the_password() {
        // Every path out of `pool` maps the underlying error away rather than
        // wrapping it, because tokio_postgres::Error's Display can contain the
        // connection string it failed on.
        let err = pool(&cfg("postgres://u:hunter2@")).unwrap_err();
        for rendered in [format!("{err:?}"), format!("{err}")] {
            assert!(!rendered.contains("hunter2"), "{rendered}");
        }
    }

    // ---- §15.0: the migration pool is a genuinely separate, optional input ----

    #[test]
    fn no_migration_credential_means_no_migration_pool_and_no_error() {
        let config = cfg("postgres://fathom_app@127.0.0.1:5432/fathom");
        assert!(config.migrate_database_url.is_none());
        assert!(migration_pool(&config).unwrap().is_none());
    }

    #[test]
    fn a_migration_credential_builds_a_pool_without_touching_the_database() {
        let config = ServerConfig::from_lookup(|k| match k {
            "DATABASE_URL" => Some("postgres://fathom_app@127.0.0.1:5432/fathom".to_string()),
            "FATHOM_MIGRATE_DATABASE_URL" => {
                Some("postgres://fathom:hunter2@127.0.0.1:5432/fathom".to_string())
            }
            _ => None,
        })
        .unwrap();
        assert!(migration_pool(&config).unwrap().is_some());
    }

    #[test]
    fn an_unparseable_migration_url_is_refused_without_naming_it() {
        let config = ServerConfig::from_lookup(|k| match k {
            "DATABASE_URL" => Some("postgres://fathom_app@127.0.0.1:5432/fathom".to_string()),
            "FATHOM_MIGRATE_DATABASE_URL" => {
                Some("K4NaRY not-a-connection-string K4NaRY".to_string())
            }
            _ => None,
        })
        .unwrap();
        let err = migration_pool(&config).unwrap_err();
        for rendered in [format!("{err:?}"), format!("{err}")] {
            assert!(!rendered.contains("K4NaRY"), "{rendered}");
        }
    }

    // ---- runtime_role: the role name comes from DATABASE_URL, never hardcoded ----

    #[test]
    fn the_runtime_role_is_read_from_database_url() {
        let config = cfg("postgres://fathom_app@127.0.0.1:5432/fathom");
        assert_eq!(runtime_role(&config).unwrap(), "fathom_app");
    }

    #[test]
    fn a_database_url_with_no_user_refuses_rather_than_guessing() {
        let config = cfg("postgres://127.0.0.1:5432/fathom");
        assert!(matches!(runtime_role(&config), Err(DbError::NoUser)));
    }

    // ---- the ALTER ROLE statement provision_runtime_login builds -----------

    #[test]
    fn quote_literal_escapes_an_embedded_single_quote() {
        assert_eq!(quote_literal("plain"), "'plain'");
        assert_eq!(quote_literal("a'b"), "'a''b'");
    }

    #[test]
    fn quote_ident_escapes_an_embedded_double_quote() {
        assert_eq!(quote_ident("fathom_app"), "\"fathom_app\"");
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }
}
