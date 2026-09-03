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

/// Why the pool could not be built.
///
/// **Carries no string from the environment.** The database URL is the value it
/// would otherwise be describing.
#[derive(Debug)]
pub enum DbError {
    /// `DATABASE_URL` is not a connection string this driver understands.
    UnparseableUrl,
    /// The pool itself refused to be built.
    Pool,
}

impl core::fmt::Display for DbError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnparseableUrl => f.write_str(
                "DATABASE_URL is not a connection string tokio-postgres understands. \
                 Its value is not shown here on purpose.",
            ),
            Self::Pool => f.write_str("the connection pool could not be created"),
        }
    }
}

impl std::error::Error for DbError {}

/// Build a pool from the configuration.
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
pub fn pool(config: &Config) -> Result<Pool, DbError> {
    let pg: tokio_postgres::Config = config
        .database_url
        .expose()
        .parse()
        .map_err(|_| DbError::UnparseableUrl)?;

    let mut cfg = PoolConfig::new();
    cfg.manager = Some(ManagerConfig {
        // Verified: a connection handed out has been checked since it was last
        // returned. `Fast` would skip that and hand out a connection the
        // database has since closed, which turns a pool into a source of
        // intermittent failures.
        recycling_method: RecyclingMethod::Verified,
    });
    cfg.pool = Some(deadpool_postgres::PoolConfig::new(config.pool_size));
    cfg.dbname = pg.get_dbname().map(ToOwned::to_owned);
    cfg.user = pg.get_user().map(ToOwned::to_owned);
    cfg.password = pg
        .get_password()
        .map(|p| String::from_utf8_lossy(p).into_owned());
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config as ServerConfig;

    fn cfg(url: &str) -> ServerConfig {
        ServerConfig::from_lookup(|k| (k == "DATABASE_URL").then(|| url.to_string())).unwrap()
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
    fn a_pool_error_never_carries_the_password() {
        // Every path out of `pool` maps the underlying error away rather than
        // wrapping it, because tokio_postgres::Error's Display can contain the
        // connection string it failed on.
        let err = pool(&cfg("postgres://u:hunter2@")).unwrap_err();
        for rendered in [format!("{err:?}"), format!("{err}")] {
            assert!(!rendered.contains("hunter2"), "{rendered}");
        }
    }
}
