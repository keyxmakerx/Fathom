//! Configuration, read from the environment once at startup.
//!
//! `43` §5.4's container runs read-only with all capabilities dropped, so the
//! environment is where configuration comes from. Two rules shape this module:
//!
//! 1. **Read it once, at startup, and fail loudly.** A server that reads an
//!    environment variable on a request path can behave differently for two
//!    requests with no deployment in between, which makes an incident
//!    unreproducible.
//! 2. **The database URL is a [`Secret`]**, so no `{:?}` anywhere in this
//!    binary can print the password. See `secret.rs` and WO-11 §6 G6.

use core::fmt;
use core::time::Duration;

use crate::secret::{redact_database_url, Secret};

/// Everything the server needs to start.
#[derive(Debug, Clone)]
pub struct Config {
    /// Where to listen. `FATHOM_BIND`, default `127.0.0.1:8080`.
    ///
    /// **Loopback by default and not `0.0.0.0`.** `43` §5.4 puts Caddy in front
    /// terminating TLS; a default that listened on every interface would mean a
    /// misconfigured deployment serving plaintext HTTP to the network and
    /// nobody noticing, because it would work.
    pub bind: String,

    /// `DATABASE_URL`. Required — there is no default, because a default here
    /// would be a server that starts against the wrong database.
    pub database_url: Secret<String>,

    /// `FATHOM_LOG`, default `info`. One level, not a filter expression: see
    /// `deps/decisions/tracing-subscriber.md` on the five crates `env-filter`
    /// would have cost.
    pub log_level: LogLevel,

    /// How long `/health` waits for the database before answering unhealthy.
    /// `FATHOM_HEALTH_TIMEOUT_MS`, default 2000.
    pub health_timeout: Duration,

    /// Maximum pooled connections. `FATHOM_DB_POOL_SIZE`, default 8.
    pub pool_size: usize,
}

/// The five levels `tracing` has, parsed by hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "error" => Some(Self::Error),
            "warn" | "warning" => Some(Self::Warn),
            "info" => Some(Self::Info),
            "debug" => Some(Self::Debug),
            "trace" => Some(Self::Trace),
            _ => None,
        }
    }

    /// The `tracing` level this names.
    pub fn to_tracing(self) -> tracing::Level {
        match self {
            Self::Error => tracing::Level::ERROR,
            Self::Warn => tracing::Level::WARN,
            Self::Info => tracing::Level::INFO,
            Self::Debug => tracing::Level::DEBUG,
            Self::Trace => tracing::Level::TRACE,
        }
    }
}

/// Why the configuration could not be read.
///
/// **No variant carries a value read from the environment**, which is
/// deliberate: an error type is the most likely thing to be formatted into a
/// log line or a panic message, and `DATABASE_URL` is one of the values it
/// would be describing.
#[derive(Debug, PartialEq, Eq)]
pub enum ConfigError {
    /// `DATABASE_URL` is unset or empty.
    NoDatabaseUrl,
    /// A variable was set to something this program cannot parse. The variable
    /// is named; **its value is not**.
    Unparseable { variable: &'static str },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoDatabaseUrl => f.write_str(
                "DATABASE_URL is not set. There is no default: a server that starts \
                 against the wrong database is worse than one that does not start.",
            ),
            Self::Unparseable { variable } => write!(
                f,
                "{variable} is set to something this program cannot parse. \
                 Its value is not shown here on purpose."
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Read from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Read from an arbitrary lookup, so the tests do not mutate the process
    /// environment — which is global, and racy across parallel tests.
    pub fn from_lookup<F>(get: F) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let database_url = get("DATABASE_URL")
            .filter(|v| !v.trim().is_empty())
            .ok_or(ConfigError::NoDatabaseUrl)?;

        let bind = get("FATHOM_BIND")
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "127.0.0.1:8080".to_string());

        let log_level = match get("FATHOM_LOG").filter(|v| !v.trim().is_empty()) {
            None => LogLevel::Info,
            Some(v) => LogLevel::parse(&v).ok_or(ConfigError::Unparseable {
                variable: "FATHOM_LOG",
            })?,
        };

        let health_timeout = match get("FATHOM_HEALTH_TIMEOUT_MS").filter(|v| !v.trim().is_empty())
        {
            None => Duration::from_millis(2000),
            Some(v) => v
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|ms| *ms > 0)
                .map(Duration::from_millis)
                .ok_or(ConfigError::Unparseable {
                    variable: "FATHOM_HEALTH_TIMEOUT_MS",
                })?,
        };

        let pool_size = match get("FATHOM_DB_POOL_SIZE").filter(|v| !v.trim().is_empty()) {
            None => 8,
            Some(v) => v.trim().parse::<usize>().ok().filter(|n| *n > 0).ok_or(
                ConfigError::Unparseable {
                    variable: "FATHOM_DB_POOL_SIZE",
                },
            )?,
        };

        Ok(Self {
            bind,
            database_url: Secret::new(database_url),
            log_level,
            health_timeout,
            pool_size,
        })
    }

    /// The database URL with its password removed, for a log line.
    ///
    /// An operator debugging a failed connection needs to know **which**
    /// database was unreachable; refusing to say anything is its own kind of
    /// unhelpful. `redact_database_url` fails safe.
    pub fn database_for_logging(&self) -> String {
        redact_database_url(self.database_url.expose())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| {
            pairs
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
        }
    }

    #[test]
    fn the_defaults_are_the_documented_ones() {
        let c = Config::from_lookup(env(&[("DATABASE_URL", "postgres://u@h/db")])).unwrap();
        assert_eq!(c.bind, "127.0.0.1:8080");
        assert_eq!(c.log_level, LogLevel::Info);
        assert_eq!(c.health_timeout, Duration::from_millis(2000));
        assert_eq!(c.pool_size, 8);
    }

    #[test]
    fn the_default_bind_is_loopback_not_every_interface() {
        // A default of 0.0.0.0 would mean a misconfigured deployment serving
        // plaintext HTTP to the network and nobody noticing, because it works.
        let c = Config::from_lookup(env(&[("DATABASE_URL", "postgres://u@h/db")])).unwrap();
        assert!(c.bind.starts_with("127.0.0.1"), "{}", c.bind);
    }

    #[test]
    fn a_missing_database_url_is_an_error_and_not_a_default() {
        assert_eq!(
            Config::from_lookup(env(&[])).unwrap_err(),
            ConfigError::NoDatabaseUrl
        );
        assert_eq!(
            Config::from_lookup(env(&[("DATABASE_URL", "   ")])).unwrap_err(),
            ConfigError::NoDatabaseUrl
        );
    }

    #[test]
    fn every_level_parses_and_nonsense_does_not() {
        for (text, level) in [
            ("error", LogLevel::Error),
            ("WARN", LogLevel::Warn),
            ("warning", LogLevel::Warn),
            (" info ", LogLevel::Info),
            ("Debug", LogLevel::Debug),
            ("trace", LogLevel::Trace),
        ] {
            let c = Config::from_lookup(env(&[
                ("DATABASE_URL", "postgres://u@h/db"),
                ("FATHOM_LOG", text),
            ]))
            .unwrap();
            assert_eq!(c.log_level, level, "{text}");
        }
        assert_eq!(
            Config::from_lookup(env(&[
                ("DATABASE_URL", "postgres://u@h/db"),
                ("FATHOM_LOG", "verbose"),
            ]))
            .unwrap_err(),
            ConfigError::Unparseable {
                variable: "FATHOM_LOG"
            }
        );
    }

    #[test]
    fn a_zero_timeout_is_refused_rather_than_accepted() {
        // Zero would make /health answer unhealthy before it had asked.
        assert!(Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_HEALTH_TIMEOUT_MS", "0"),
        ]))
        .is_err());
        assert!(Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_DB_POOL_SIZE", "0"),
        ]))
        .is_err());
    }

    // ---- G6, at the type level -------------------------------------------

    #[test]
    fn debug_on_the_whole_config_does_not_print_the_password() {
        let c = Config::from_lookup(env(&[(
            "DATABASE_URL",
            "postgres://fathom:hunter2@db.internal:5432/fathom",
        )]))
        .unwrap();
        for rendered in [format!("{c:?}"), format!("{c:#?}")] {
            assert!(!rendered.contains("hunter2"), "{rendered}");
        }
    }

    #[test]
    fn no_config_error_carries_a_value_from_the_environment() {
        // An error type is the most likely thing to be formatted into a log
        // line or a panic message, so it names variables and never values.
        let err = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://fathom:hunter2@db/fathom"),
            ("FATHOM_LOG", "hunter2-as-a-level"),
        ]))
        .unwrap_err();
        for rendered in [format!("{err:?}"), format!("{err}")] {
            assert!(!rendered.contains("hunter2"), "{rendered}");
            assert!(rendered.contains("FATHOM_LOG"), "{rendered}");
        }
    }

    #[test]
    fn the_loggable_url_names_the_host_and_not_the_password() {
        let c = Config::from_lookup(env(&[(
            "DATABASE_URL",
            "postgres://fathom:hunter2@db.internal:5432/fathom",
        )]))
        .unwrap();
        let logged = c.database_for_logging();
        assert!(!logged.contains("hunter2"), "{logged}");
        assert!(logged.contains("db.internal"), "{logged}");
        assert!(logged.contains("5432"), "{logged}");
    }
}
