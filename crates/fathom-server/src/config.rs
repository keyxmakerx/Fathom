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
    ///
    /// **This is the RUNTIME role's connection string** —
    /// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §15.0: data privileges only,
    /// no ownership, no DDL, no `CREATEROLE`. `db::pool` builds the pool every
    /// request is served from out of this field. See
    /// [`Config::migrate_database_url`] for the other half of the split.
    pub database_url: Secret<String>,

    /// The runtime role's password, read from the file named by
    /// `FATHOM_DB_PASSWORD_FILE`. Overrides whatever `DATABASE_URL` carries.
    ///
    /// **`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §0.1 and §1.4: the
    /// application's own database password must never appear in the compose
    /// file or the environment.** In a Docker deployment whoever writes
    /// `compose.yaml` holds the Docker socket and is therefore a host-level
    /// attacker, so a password typed there proves nothing about what any
    /// other credential can reach. Generated at first start into the key
    /// volume instead (`deploy/init-db/10-app-role.sh`), so that "the
    /// operator role cannot read design data" is a statement about an
    /// attacker holding the operator credential, rather than about one
    /// holding whichever credential the deployer typed.
    ///
    /// `None` when the variable is unset, which is the shape every test and
    /// every local developer uses.
    pub database_password: Option<Secret<String>>,

    /// `FATHOM_MIGRATE_DATABASE_URL`. The migration role's connection string
    /// — owns the schema, holds `CREATEROLE`, used once at startup to run
    /// `migrate::run` and to provision the runtime role's ability to log in,
    /// and then not held (`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §15.0).
    ///
    /// **`None` when unset, and that is a supported shape, not an error.**
    /// The owner's inclination (repeated in `main.rs`'s own comment on the
    /// startup sequence): a deployment that never hands the server this
    /// credential still starts and serves, PROVIDED the schema is already at
    /// the version this binary expects; it refuses only where it would
    /// actually need to migrate and cannot. That is checked against the
    /// runtime connection with `migrate::verify_current`, not asserted here.
    pub migrate_database_url: Option<Secret<String>>,

    /// The migration role's password, read from the file named by
    /// `FATHOM_MIGRATE_DB_PASSWORD_FILE`. Overrides whatever
    /// `migrate_database_url` carries, exactly as `database_password`
    /// overrides `database_url` — same reasoning, same file-based mechanism,
    /// a second credential rather than a second exception to §1.4.
    pub migrate_database_password: Option<Secret<String>>,

    /// `FATHOM_LOG`, default `info`. One level, not a filter expression: see
    /// `deps/decisions/tracing-subscriber.md` on the five crates `env-filter`
    /// would have cost.
    pub log_level: LogLevel,

    /// How long `/health` waits for the database before answering unhealthy.
    /// `FATHOM_HEALTH_TIMEOUT_MS`, default 2000.
    pub health_timeout: Duration,

    /// Maximum pooled connections. `FATHOM_DB_POOL_SIZE`, default 8.
    pub pool_size: usize,

    /// Where the `schema/` tree lives. `FATHOM_SCHEMA_ROOT`, default
    /// `schema` (`engine::DEFAULT_ROOT`), relative to the process's working
    /// directory.
    ///
    /// **Every other startup input already had a `FATHOM_*` override; this
    /// one did not.** `deploy/Dockerfile`'s runtime stage copies only the
    /// binary, so a default resolved against the working directory left an
    /// operator with no way to point the server at a tree living anywhere
    /// else, and the production container crash-looped on exit 7 for want of
    /// it.
    pub schema_root: String,
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
    /// `FATHOM_DB_PASSWORD_FILE` is set and the file could not be read, or
    /// held nothing. **Refusing to start is the only correct shape**: the
    /// alternative is a server that silently falls back to whatever password
    /// `DATABASE_URL` carries, which in the shipped deployment is none, and
    /// then reports a connection failure that names the wrong cause.
    UnreadableDbPasswordFile,
    /// `FATHOM_MIGRATE_DB_PASSWORD_FILE` is set and the file could not be
    /// read, or held nothing. Same reasoning as
    /// [`ConfigError::UnreadableDbPasswordFile`], for the migration role's
    /// credential rather than the runtime role's.
    UnreadableMigrateDbPasswordFile,
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
            Self::UnreadableDbPasswordFile => f.write_str(
                "FATHOM_DB_PASSWORD_FILE is set and the file behind it could not be read, or \
                 was empty. The application's database password is generated at first start \
                 into the key volume rather than typed into the compose file -- see \
                 deploy/init-db/10-app-role.sh. Refusing to start rather than falling back to \
                 a password from somewhere else.",
            ),
            Self::UnreadableMigrateDbPasswordFile => f.write_str(
                "FATHOM_MIGRATE_DB_PASSWORD_FILE is set and the file behind it could not be \
                 read, or was empty. The migration role's database password is generated at \
                 first start into the key volume rather than typed into the compose file -- see \
                 deploy/init-db/10-app-role.sh. Refusing to start rather than falling back to \
                 a password from somewhere else.",
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Read from the process environment, and from the one file the
    /// environment may point at.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup_and_files(
            |key| std::env::var(key).ok(),
            |path| std::fs::read_to_string(path).ok(),
        )
    }

    /// Read from an arbitrary lookup, so the tests do not mutate the process
    /// environment — which is global, and racy across parallel tests.
    ///
    /// **Reads no file.** `FATHOM_DB_PASSWORD_FILE` is refused by this
    /// entry point rather than ignored, because ignoring it would make a
    /// test that sets it silently prove the opposite of what it says.
    pub fn from_lookup<F>(get: F) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        Self::from_lookup_and_files(get, |_| None)
    }

    /// Read from an arbitrary lookup and an arbitrary file reader.
    ///
    /// The reader returns `None` for "could not read it", which becomes
    /// [`ConfigError::UnreadableDbPasswordFile`] — never a silent fallback.
    pub fn from_lookup_and_files<F, R>(get: F, read: R) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
        R: Fn(&str) -> Option<String>,
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

        let schema_root = get("FATHOM_SCHEMA_ROOT")
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| crate::engine::DEFAULT_ROOT.to_string());

        // Trailing newline trimmed: the file is written by a shell script and
        // a newline is what a shell script writes. Only the ends are trimmed
        // — a password is otherwise taken exactly as generated.
        let database_password =
            match get("FATHOM_DB_PASSWORD_FILE").filter(|v| !v.trim().is_empty()) {
                None => None,
                Some(path) => {
                    let value = read(path.trim())
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .ok_or(ConfigError::UnreadableDbPasswordFile)?;
                    Some(Secret::new(value))
                }
            };

        // `FATHOM_MIGRATE_DATABASE_URL` has no default and no fallback: unlike
        // `DATABASE_URL`, it is fine for this to be absent. See
        // `main.rs`'s startup sequence and `migrate::verify_current` for what
        // that means for a server that starts anyway.
        let migrate_database_url = get("FATHOM_MIGRATE_DATABASE_URL")
            .filter(|v| !v.trim().is_empty())
            .map(Secret::new);

        let migrate_database_password =
            match get("FATHOM_MIGRATE_DB_PASSWORD_FILE").filter(|v| !v.trim().is_empty()) {
                None => None,
                Some(path) => {
                    let value = read(path.trim())
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .ok_or(ConfigError::UnreadableMigrateDbPasswordFile)?;
                    Some(Secret::new(value))
                }
            };

        Ok(Self {
            bind,
            database_url: Secret::new(database_url),
            database_password,
            migrate_database_url,
            migrate_database_password,
            log_level,
            health_timeout,
            pool_size,
            schema_root,
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

    /// The migration database URL with its password removed, for a log line.
    /// `None` when no migration credential was configured at all — logging
    /// that absence is `main.rs`'s job, not this accessor's.
    pub fn migrate_database_for_logging(&self) -> Option<String> {
        self.migrate_database_url
            .as_ref()
            .map(|url| redact_database_url(url.expose()))
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
        assert_eq!(c.schema_root, "schema");
    }

    #[test]
    fn a_schema_root_override_is_read_from_the_environment() {
        // Finding 1: the distroless runtime stage copies only the binary, so
        // a default resolved against the working directory left an operator
        // with no way to point the server at a `schema/` tree living
        // anywhere else. Every other startup input already has a `FATHOM_*`
        // override; this is the one that did not, until now.
        let c = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_SCHEMA_ROOT", "/schema"),
        ]))
        .unwrap();
        assert_eq!(c.schema_root, "/schema");
    }

    #[test]
    fn a_blank_schema_root_override_falls_back_to_the_default() {
        let c = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_SCHEMA_ROOT", "   "),
        ]))
        .unwrap();
        assert_eq!(c.schema_root, "schema");
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

    // ---- §1.4: the app password is not in the environment ----------------

    #[test]
    fn the_database_password_is_read_from_the_file_the_environment_names() {
        let c = Config::from_lookup_and_files(
            env(&[
                ("DATABASE_URL", "postgres://fathom@db:5432/fathom"),
                ("FATHOM_DB_PASSWORD_FILE", "/var/lib/fathom/keys/db_app.pw"),
            ]),
            |path| {
                assert_eq!(path, "/var/lib/fathom/keys/db_app.pw");
                // As a shell script writes it: with a trailing newline.
                Some("generated-at-first-start\n".to_string())
            },
        )
        .unwrap();
        assert_eq!(
            c.database_password.as_ref().map(|p| p.expose().as_str()),
            Some("generated-at-first-start")
        );
    }

    #[test]
    fn an_unreadable_password_file_refuses_to_start_rather_than_falling_back() {
        // The silent fallback this rules out is the dangerous one: the URL in
        // the shipped compose file carries NO password, so a fallback would
        // produce an authentication failure naming the wrong cause -- and, in
        // a deployment where the URL did carry one, would quietly keep using
        // the credential §1.4 exists to get out of the environment.
        for file in [None, Some(String::new()), Some("   \n".to_string())] {
            let err = Config::from_lookup_and_files(
                env(&[
                    ("DATABASE_URL", "postgres://fathom:fallback@db/fathom"),
                    ("FATHOM_DB_PASSWORD_FILE", "/keys/db_app.pw"),
                ]),
                |_| file.clone(),
            )
            .unwrap_err();
            assert_eq!(err, ConfigError::UnreadableDbPasswordFile);
        }
    }

    #[test]
    fn no_password_file_means_no_override() {
        let c = Config::from_lookup(env(&[("DATABASE_URL", "postgres://u:p@h/db")])).unwrap();
        assert!(c.database_password.is_none());
    }

    #[test]
    fn the_password_read_from_a_file_is_a_secret_like_every_other() {
        // G6 at the type level, for the value §1.4 adds. A `{:?}` on the
        // config is the realistic way a password reaches a log.
        let c = Config::from_lookup_and_files(
            env(&[
                ("DATABASE_URL", "postgres://fathom@db/fathom"),
                ("FATHOM_DB_PASSWORD_FILE", "/keys/db_app.pw"),
            ]),
            |_| Some("hunter2".to_string()),
        )
        .unwrap();
        for rendered in [format!("{c:?}"), format!("{c:#?}")] {
            assert!(!rendered.contains("hunter2"), "{rendered}");
        }
    }

    #[test]
    fn the_lookup_only_entry_point_refuses_a_password_file_rather_than_ignoring_it() {
        // `from_lookup` reads no files. If it silently ignored the variable, a
        // test that set it would pass while proving the opposite of its name.
        assert_eq!(
            Config::from_lookup(env(&[
                ("DATABASE_URL", "postgres://u@h/db"),
                ("FATHOM_DB_PASSWORD_FILE", "/keys/db_app.pw"),
            ]))
            .unwrap_err(),
            ConfigError::UnreadableDbPasswordFile
        );
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

    // ---- §15.0: the migration role's connection string is a second,
    // independent input, absent by default -------------------------------

    #[test]
    fn no_migrate_database_url_means_none_and_that_is_not_an_error() {
        let c = Config::from_lookup(env(&[("DATABASE_URL", "postgres://u@h/db")])).unwrap();
        assert!(c.migrate_database_url.is_none());
        assert!(c.migrate_database_password.is_none());
        assert!(c.migrate_database_for_logging().is_none());
    }

    #[test]
    fn a_blank_migrate_database_url_is_the_same_as_absent() {
        let c = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_MIGRATE_DATABASE_URL", "   "),
        ]))
        .unwrap();
        assert!(c.migrate_database_url.is_none());
    }

    #[test]
    fn a_migrate_database_url_is_read_independently_of_database_url() {
        let c = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://fathom_app@db:5432/fathom"),
            (
                "FATHOM_MIGRATE_DATABASE_URL",
                "postgres://fathom@db:5432/fathom",
            ),
        ]))
        .unwrap();
        assert_eq!(
            c.migrate_database_url.as_ref().map(|u| u.expose().clone()),
            Some("postgres://fathom@db:5432/fathom".to_string())
        );
        // The two are genuinely independent -- one must not fall back to
        // the other, or the split this exists for is only a naming exercise.
        assert_eq!(
            c.database_url.expose(),
            "postgres://fathom_app@db:5432/fathom"
        );
    }

    #[test]
    fn the_migrate_database_password_is_read_from_the_file_the_environment_names() {
        let c = Config::from_lookup_and_files(
            env(&[
                ("DATABASE_URL", "postgres://fathom_app@db:5432/fathom"),
                (
                    "FATHOM_MIGRATE_DATABASE_URL",
                    "postgres://fathom@db:5432/fathom",
                ),
                (
                    "FATHOM_MIGRATE_DB_PASSWORD_FILE",
                    "/var/lib/fathom/keys/db_migrate.pw",
                ),
            ]),
            |path| {
                assert_eq!(path, "/var/lib/fathom/keys/db_migrate.pw");
                Some("generated-at-first-start-too\n".to_string())
            },
        )
        .unwrap();
        assert_eq!(
            c.migrate_database_password
                .as_ref()
                .map(|p| p.expose().as_str()),
            Some("generated-at-first-start-too")
        );
    }

    #[test]
    fn an_unreadable_migrate_password_file_refuses_to_start_rather_than_falling_back() {
        for file in [None, Some(String::new()), Some("   \n".to_string())] {
            let err = Config::from_lookup_and_files(
                env(&[
                    ("DATABASE_URL", "postgres://fathom_app@db/fathom"),
                    (
                        "FATHOM_MIGRATE_DATABASE_URL",
                        "postgres://fathom:fallback@db/fathom",
                    ),
                    ("FATHOM_MIGRATE_DB_PASSWORD_FILE", "/keys/db_migrate.pw"),
                ]),
                |_| file.clone(),
            )
            .unwrap_err();
            assert_eq!(err, ConfigError::UnreadableMigrateDbPasswordFile);
        }
    }

    #[test]
    fn the_lookup_only_entry_point_refuses_a_migrate_password_file_rather_than_ignoring_it() {
        assert_eq!(
            Config::from_lookup(env(&[
                ("DATABASE_URL", "postgres://u@h/db"),
                ("FATHOM_MIGRATE_DB_PASSWORD_FILE", "/keys/db_migrate.pw"),
            ]))
            .unwrap_err(),
            ConfigError::UnreadableMigrateDbPasswordFile
        );
    }

    #[test]
    fn the_migrate_password_is_a_secret_like_every_other() {
        let c = Config::from_lookup_and_files(
            env(&[
                ("DATABASE_URL", "postgres://fathom_app@db/fathom"),
                ("FATHOM_MIGRATE_DATABASE_URL", "postgres://fathom@db/fathom"),
                ("FATHOM_MIGRATE_DB_PASSWORD_FILE", "/keys/db_migrate.pw"),
            ]),
            |_| Some("hunter2".to_string()),
        )
        .unwrap();
        for rendered in [format!("{c:?}"), format!("{c:#?}")] {
            assert!(!rendered.contains("hunter2"), "{rendered}");
        }
    }

    #[test]
    fn the_loggable_migrate_url_names_the_host_and_not_the_password() {
        let c = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://fathom_app@db/fathom"),
            (
                "FATHOM_MIGRATE_DATABASE_URL",
                "postgres://fathom:hunter2@db.internal:5432/fathom",
            ),
        ]))
        .unwrap();
        let logged = c
            .migrate_database_for_logging()
            .expect("a migrate URL was configured");
        assert!(!logged.contains("hunter2"), "{logged}");
        assert!(logged.contains("db.internal"), "{logged}");
    }
}
