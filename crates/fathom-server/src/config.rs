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

use crate::audit::{SpoolBounds, SyslogTarget};
use crate::keyprovider::KeySource;
use crate::secret::{redact_database_url, Secret};
use crate::sessions::SignInLimits;

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

    /// Where the **master key** comes from. `FATHOM_MASTER_KEY`, default
    /// `file:///var/lib/fathom/keys/master.key`.
    ///
    /// ADR-0043 §1 and §3: 32 bytes in a file on the Fathom server, owned by
    /// the Fathom process user, mode 0400, **in its own volume -- not the
    /// PostgreSQL volume, and not in any database backup**. `command://` is
    /// how every key service on the market plugs in without an SDK reaching
    /// `Cargo.lock`; `env://` is supported and documented as discouraged, in
    /// that order, on OWASP's *"avoid storing keys in environment variables,
    /// as these can be accidentally exposed."*
    ///
    /// Parsed here, at startup, so a mistyped scheme fails before the
    /// listener binds rather than at the first write.
    pub master_key: KeySource,

    /// Where the **chain master** comes from. `FATHOM_CHAIN_KEY`, default
    /// `file:///var/lib/fathom/keys/chain.key`.
    ///
    /// `docs/PHASE-2-STORAGE-DESIGN.md` §6's B5 fix: the chain key is
    /// distinct from the master hierarchy, sits behind the same provider
    /// interface, and never lives in PostgreSQL. Separate from the master key
    /// so that handing someone the ability to verify a history is not handing
    /// them the designs.
    pub chain_key: KeySource,

    /// Where sealed audit entries are shipped. `FATHOM_AUDIT_SYSLOG`, a bare
    /// `host:port`, TCP, RFC 5424.
    ///
    /// **`None` is a supported shape and means spool-only**, not a partial
    /// failure: entries accumulate in `audit_spool` and every act still
    /// applies. `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §9 requires that
    /// absence to be permanently and visibly marked rather than silently
    /// tolerated — *"the startup log line, the admin page, the organisation
    /// pages and the operator's register all say `unwitnessed`"* — and the
    /// startup log line is the part of that which exists today. `src/main.rs`
    /// writes it either way.
    ///
    /// Parsed here, at startup, so a mistyped destination fails before the
    /// listener binds rather than at the first entry. A scheme is REFUSED
    /// rather than stripped: see `audit::TargetError::HasScheme`.
    pub audit_syslog: Option<SyslogTarget>,

    /// §9's two bounds on the audit spool. `FATHOM_AUDIT_SPOOL_MAX_AGE`
    /// (seconds, default 72 hours) and `FATHOM_AUDIT_SPOOL_MAX_BYTES`
    /// (default 1 GiB), *whichever comes first*.
    ///
    /// Parsed here so a mistyped bound fails at startup rather than silently
    /// falling back to a default and letting a deployment believe it is
    /// bounded at a number it is not. `audit::SpoolBounds::from_env` reads the
    /// same two variables on the design write path, which has no configuration
    /// handle; the two must agree because they are the same parser, and this
    /// one is what refuses a malformed value.
    pub audit_spool_bounds: SpoolBounds,

    /// §13 item 7's rate limit and lockout, which
    /// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` does not specify.
    /// `FATHOM_SIGNIN_WINDOW_SECONDS` (default 900),
    /// `FATHOM_SIGNIN_MAX_PER_ACCOUNT` (failures, default 10) and
    /// `FATHOM_SIGNIN_MAX_PER_SOURCE` (attempts, default 30).
    ///
    /// Configurable because a deployment behind one NAT and a deployment on
    /// the open internet are different shapes, and a fixed number would be
    /// wrong for one of them. Parsed here, at startup, for
    /// `audit_spool_bounds`' reason: a mistyped bound must fail before the
    /// listener binds rather than leave a deployment believing it is limited
    /// at a number it is not. **A zero is refused**, because a zero limit
    /// locks every account out for a window and would read as "no limit".
    pub sign_in_limits: SignInLimits,

    /// `FATHOM_SESSION_ADDRESS_CHECK`, default `site`. ADR-0057 decision 7:
    /// `site` ends only the operator plane on an address change and records
    /// it on an account session; `all` ends both; `off` checks neither.
    pub session_address_check: crate::sessions::AddressCheckMode,

    /// Which request header carries the real client address, for the source
    /// half of the sign-in rate limit. `FATHOM_TRUSTED_CLIENT_IP_HEADER`,
    /// **unset by default**.
    ///
    /// Unset means the peer address, which is the honest default: a header a
    /// client can set is a rate limit a client can evade, and this server
    /// cannot know whether anything in front of it overwrites one. But `43`
    /// §5.4 puts Caddy in front, and behind a proxy every request arrives from
    /// the proxy — so with this unset in that deployment, the source bucket is
    /// one bucket for the whole site and a single attacker rate-limits
    /// everybody. **Set it only when the proxy you control overwrites the
    /// header on every request.** Both failure modes are real; the deployment
    /// chooses which one it is not in, and this comment is the place that says
    /// so.
    pub trusted_client_ip_header: Option<String>,
    /// `FATHOM_TRUSTED_PROXIES`. Addresses and ranges, comma-separated, or
    /// the word `private`, from which the header above is believed; from
    /// any other peer it is ignored and the peer is the address
    /// (`src/client_address.rs`). Setting this and not the header selects
    /// `X-Forwarded-For`; setting the header and not this is refused, since
    /// 2026-09-21 -- a header believed from every peer is a rate limit any
    /// client can evade, and until then the server ran that way and only
    /// warned.
    pub trusted_proxies: Vec<String>,
    /// `FATHOM_FORWARDED_HOPS`, default `1`: which entry of the forwarding
    /// header, counted from the right, is the client. `1` is the last, the
    /// one the trusted proxy appended; `2` when that proxy sits behind one
    /// more hop that appends (`src/client_address.rs`).
    pub forwarded_hops: usize,

    /// `FATHOM_SINGLE_OPERATOR`. **Retired by ADR-0055 decision 3, and parsed
    /// anyway so that the refusal can name what was set.**
    ///
    /// It used to be admin design §5.3's documented escape for a deployment
    /// with one operator: it removed the second signature and kept the delay.
    /// ADR-0055 decision 3 replaces it with `min(2, live independent
    /// operators)` counted off the register, which a sole operator satisfies
    /// without declaring anything and which stops being satisfied the moment a
    /// colleague signs in. The switch's own failure was the deadlock it left
    /// behind: off by default, absent from `compose.yaml` and `.env.example`,
    /// so *a fresh install's sole operator could not add a second operator at
    /// all*.
    ///
    /// **Nothing reads this field's VALUE for behaviour.** `main.rs` refuses
    /// to start when it is set at all, naming the variable and ADR-0055
    /// decision 3 — CLAUDE.md rule 2's spirit: a stale switch somebody
    /// believes still works is worse than a refusal. The parse stays so that
    /// the refusal can say what it found; `grep` for this field finds exactly
    /// that one refusal.
    ///
    /// Absent, empty or anything but `1`/`true`/`yes` means false: the safe
    /// value is still the one you get by not setting it or by fumbling it, and
    /// a fumbled value starts the server rather than refusing on a typo.
    pub single_operator: bool,

    /// `FATHOM_OPERATOR_NOTICE_ADDRESS`. Where operator notices go, and the
    /// address the first operator is created against on a first start.
    ///
    /// **Read at every start and used only at the first.** There is no default:
    /// a deployment that bootstrapped an operator against a guessed address
    /// would have an operator nobody can reach, and admin design §5.5's notices
    /// are part of how a second operator learns that a settings change was
    /// requested at all.
    pub operator_notice_address: Option<String>,

    /// ADR-0057 decision 1: a temporary setup password, set in `.env` rather
    /// than read out of a file or a log. `FATHOM_SETUP_PASSWORD`, unset by
    /// default. Read here, but checked against the account password policy
    /// and logged only in `main.rs` — this field just reads what was given.
    ///
    /// A [`Secret`] like every other credential this binary reads from the
    /// environment. Not trimmed: the client sends what was typed,
    /// unmodified, so this must match `.env` exactly. Empty is still `None`:
    /// `compose.yaml`'s `${FATHOM_SETUP_PASSWORD:-}` makes an unset variable
    /// arrive as `""`, not absent.
    pub setup_password: Option<Secret<String>>,

    /// Where the first operator's enrolment token is written — by a first
    /// start, and by `fathom-server reissue-bootstrap-token`.
    /// `FATHOM_BOOTSTRAP_TOKEN_FILE`, default
    /// [`DEFAULT_BOOTSTRAP_TOKEN_FILE`].
    ///
    /// **Chosen by the deployment, not derived from where the master key
    /// lives.** It was derived, until 2026-09-14, and that is what made a
    /// first start in a container impossible: ADR-0043 §3 gives the master key
    /// its own volume, `compose.yaml` mounts that volume READ-ONLY on
    /// the server because the server only reads it, and a token path derived
    /// from the key's path therefore pointed at a filesystem this process
    /// cannot write. The write failed, the first operator existed with an
    /// enrolment token nobody could ever read, and the server exited. A
    /// derived path cannot be fixed by a deployment; a variable can.
    ///
    /// **The default is deliberately not inside the key volume**, for the
    /// same reason: that volume is read-only to this process in the shipped
    /// deployment, so a default that pointed into it would be a default that
    /// cannot work where it matters most. It is relative to the working
    /// directory, which is the honest default for somebody running the binary
    /// from a checkout — and in a container, where the root filesystem is
    /// read-only (`43` §5.4), it fails loudly at the write with the path in
    /// the message rather than quietly putting a bearer token somewhere
    /// nobody was told about. The shipped `compose.yaml` sets this
    /// variable explicitly at a writable volume of its own.
    pub bootstrap_token_file: String,

    /// `FATHOM_FIRMWARE_DIR`. Where staged firmware images live (ADR-0045).
    ///
    /// **Absent means the feature is off and its routes are not mounted**, not
    /// that they exist and fail. A route that answers at all is a route an
    /// attacker can probe, and a deployment that never stages firmware should
    /// not carry one.
    pub firmware_dir: Option<String>,
    /// `FATHOM_CLIENT_ROOT`. A directory of built web client files, served
    /// by this binary for every path no API route claims (`src/client.rs`).
    /// The image sets it to `/srv/www`. **Absent means the API only**: a
    /// developer running the Vite dev server wants exactly that.
    pub client_root: Option<String>,
    /// `FATHOM_ADMIN_HOSTS`. Host names, comma-separated, on which the
    /// operator console (`/admin/*`, `/enrolment/operator`) answers; on any
    /// other host those paths are 404 (`src/admin_exposure.rs`). Empty means
    /// every host. A subdomain of the site's, or a different domain
    /// altogether: the site itself is served on all of them.
    pub admin_hosts: Vec<String>,
    /// `FATHOM_ADMIN_SOURCES`. Addresses and CIDR ranges, comma-separated,
    /// the operator console may be used from, judged the way the rate
    /// limiter judges a client's address (`FATHOM_TRUSTED_CLIENT_IP_HEADER`,
    /// else the peer). Empty means every address. Refused at startup if an
    /// entry does not parse.
    pub admin_sources: Vec<String>,

    /// `FATHOM_FIRMWARE_MAX_BYTES`. The largest image that may be staged, and
    /// also the worst case a single fetch holds in memory until the streaming
    /// body lands. Default two gibibytes, which covers a Junos image with room.
    pub firmware_max_bytes: u64,

    /// `FATHOM_FIRMWARE_FETCH_BASE_URL`. **The origin a SWITCH can reach**,
    /// which is very often not the one an operator's browser used.
    ///
    /// The server cannot discover this. It sees the address a request arrived
    /// on, and behind a reverse proxy, a NAT or a management VLAN that says
    /// nothing about what a device in a rack can resolve. It is rendered into
    /// the `file copy` line an operator pastes into a switch, so a wrong value
    /// fails visibly on the device rather than silently here. Required
    /// whenever `firmware_dir` is set.
    pub firmware_fetch_base_url: Option<String>,
}

/// ADR-0043 §9's path, in the operator's register and therefore in the code
/// that reads it: *"the key that unlocks the per-tenant keys is 32 bytes in
/// `/var/lib/fathom/keys/master.key`, readable only by the `fathom` user. It
/// is not in the database, not in an environment variable, and not in any
/// backup Fathom takes."*
pub const DEFAULT_MASTER_KEY: &str = "file:///var/lib/fathom/keys/master.key";

/// The chain master's default path, beside the master key in the same volume
/// and deliberately not the same file.
pub const DEFAULT_CHAIN_KEY: &str = "file:///var/lib/fathom/keys/chain.key";

/// Where the first operator's enrolment token goes when nothing says
/// otherwise: beside the process, in its working directory.
///
/// **Not in the key volume**, though the token is as sensitive as what lives
/// there for the few hours it is live. ADR-0043 §3's volume is mounted
/// read-only on the server in the shipped deployment, because the server
/// reads the key and does not write it; a default that pointed into it would
/// be a default that fails in precisely the deployment this product ships.
/// See [`Config::bootstrap_token_file`].
pub const DEFAULT_BOOTSTRAP_TOKEN_FILE: &str = "first-operator-token";

/// Two gibibytes. A Junos install package is one to two gigabytes, so this
/// admits the images this feature exists for and refuses anything that is
/// plainly not one.
pub const DEFAULT_FIRMWARE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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
    /// `FATHOM_TRUSTED_CLIENT_IP_HEADER` without `FATHOM_TRUSTED_PROXIES`: a
    /// header believed from every peer is an address any client chooses, and
    /// until 2026-09-21 the server ran that way and only warned.
    HeaderWithoutProxies,
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
            Self::HeaderWithoutProxies => f.write_str(
                "FATHOM_TRUSTED_CLIENT_IP_HEADER is set but FATHOM_TRUSTED_PROXIES is not. A \
                 forwarding header believed from every peer is an address any client chooses; \
                 name the proxy that writes it, or unset the header and the peer is the address.",
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

        let master_key = KeySource::parse(
            &get("FATHOM_MASTER_KEY")
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_MASTER_KEY.to_string()),
        )
        .map_err(|_| ConfigError::Unparseable {
            variable: "FATHOM_MASTER_KEY",
        })?;

        let chain_key = KeySource::parse(
            &get("FATHOM_CHAIN_KEY")
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_CHAIN_KEY.to_string()),
        )
        .map_err(|_| ConfigError::Unparseable {
            variable: "FATHOM_CHAIN_KEY",
        })?;

        // No default, and absence is not an error: a deployment with no audit
        // destination spools and says so. A MALFORMED one is an error, because
        // the alternative is a server that starts, reports healthy, and ships
        // nothing anywhere.
        let audit_syslog = match get("FATHOM_AUDIT_SYSLOG").filter(|v| !v.trim().is_empty()) {
            None => None,
            Some(v) => Some(
                SyslogTarget::parse(&v).map_err(|_| ConfigError::Unparseable {
                    variable: "FATHOM_AUDIT_SYSLOG",
                })?,
            ),
        };

        // Both bounds, or the §9 defaults. A malformed value is refused here
        // and nowhere else: the design write path falls back to the default
        // rather than failing a write, on the argument that a server which is
        // running has already passed this check.
        let audit_spool_bounds = SpoolBounds::from_lookup(&get)
            .map_err(|variable| ConfigError::Unparseable { variable })?;

        let sign_in_limits = SignInLimits::from_lookup(&get)
            .map_err(|variable| ConfigError::Unparseable { variable })?;

        let session_address_check =
            match get("FATHOM_SESSION_ADDRESS_CHECK").filter(|v| !v.trim().is_empty()) {
                None => crate::sessions::AddressCheckMode::default(),
                Some(v) => crate::sessions::AddressCheckMode::parse(&v).ok_or(
                    ConfigError::Unparseable {
                        variable: "FATHOM_SESSION_ADDRESS_CHECK",
                    },
                )?,
            };

        let firmware_dir = get("FATHOM_FIRMWARE_DIR")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let client_root = get("FATHOM_CLIENT_ROOT")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let admin_hosts: Vec<String> = get("FATHOM_ADMIN_HOSTS")
            .unwrap_or_default()
            .split(',')
            .map(|h| h.trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect();
        let admin_sources: Vec<String> = get("FATHOM_ADMIN_SOURCES")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if admin_sources
            .iter()
            .any(|s| crate::admin_exposure::Cidr::parse(s).is_none())
        {
            return Err(ConfigError::Unparseable {
                variable: "FATHOM_ADMIN_SOURCES",
            });
        }
        let firmware_fetch_base_url = get("FATHOM_FIRMWARE_FETCH_BASE_URL")
            .map(|v| v.trim().trim_end_matches('/').to_string())
            .filter(|v| !v.is_empty());
        let firmware_max_bytes =
            match get("FATHOM_FIRMWARE_MAX_BYTES").filter(|v| !v.trim().is_empty()) {
                None => DEFAULT_FIRMWARE_MAX_BYTES,
                Some(v) => v.trim().parse::<u64>().ok().filter(|n| *n > 0).ok_or(
                    ConfigError::Unparseable {
                        variable: "FATHOM_FIRMWARE_MAX_BYTES",
                    },
                )?,
            };
        // Staging with nowhere for a device to fetch from is a half-configured
        // feature that looks whole until the first upgrade. Refused at startup
        // rather than discovered by an operator holding a command that cannot
        // work.
        if firmware_dir.is_some() && firmware_fetch_base_url.is_none() {
            return Err(ConfigError::Unparseable {
                variable: "FATHOM_FIRMWARE_FETCH_BASE_URL",
            });
        }

        let operator_notice_address = get("FATHOM_OPERATOR_NOTICE_ADDRESS")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        // Filtered on emptiness (compose passes an unset variable through as
        // `""`), but not trimmed: the client sends what was typed,
        // unmodified, so this must match `.env` exactly.
        let setup_password = get("FATHOM_SETUP_PASSWORD")
            .filter(|v| !v.is_empty())
            .map(Secret::new);

        // Trimmed, and an all-whitespace value falls back to the default
        // exactly as `FATHOM_SCHEMA_ROOT` does: a template that filled
        // nothing in must not leave this server trying to create a file
        // called " ".
        let bootstrap_token_file = get("FATHOM_BOOTSTRAP_TOKEN_FILE")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| DEFAULT_BOOTSTRAP_TOKEN_FILE.to_string());

        let single_operator = matches!(
            get("FATHOM_SINGLE_OPERATOR")
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "1" | "true" | "yes"
        );

        let trusted_client_ip_header = get("FATHOM_TRUSTED_CLIENT_IP_HEADER")
            .map(|v| v.trim().to_ascii_lowercase())
            .filter(|v| !v.is_empty());
        let trusted_proxies: Vec<String> = get("FATHOM_TRUSTED_PROXIES")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if crate::client_address::parse_trusted_proxies(&trusted_proxies.join(",")).is_err() {
            return Err(ConfigError::Unparseable {
                variable: "FATHOM_TRUSTED_PROXIES",
            });
        }
        let trusted_client_ip_header = match (trusted_client_ip_header, trusted_proxies.is_empty())
        {
            (None, false) => Some("X-Forwarded-For".to_string()),
            (Some(_), true) => return Err(ConfigError::HeaderWithoutProxies),
            (h, _) => h,
        };
        let forwarded_hops = match get("FATHOM_FORWARDED_HOPS").filter(|v| !v.trim().is_empty()) {
            None => 1,
            Some(v) => match v.trim().parse::<usize>() {
                Ok(n) if n >= 1 => n,
                _ => {
                    return Err(ConfigError::Unparseable {
                        variable: "FATHOM_FORWARDED_HOPS",
                    })
                }
            },
        };

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
            master_key,
            chain_key,
            audit_syslog,
            audit_spool_bounds,
            sign_in_limits,
            session_address_check,
            trusted_client_ip_header,
            trusted_proxies,
            forwarded_hops,
            single_operator,
            operator_notice_address,
            setup_password,
            bootstrap_token_file,
            firmware_dir,
            client_root,
            admin_hosts,
            admin_sources,
            firmware_max_bytes,
            firmware_fetch_base_url,
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

    /// The password the runtime role is given at startup: the password file's
    /// when set, otherwise the one in `DATABASE_URL` (a from-source start).
    pub fn runtime_login_password(&self) -> Option<Secret<String>> {
        if let Some(password) = &self.database_password {
            return Some(password.clone());
        }
        let parsed: tokio_postgres::Config = self.database_url.expose().parse().ok()?;
        parsed
            .get_password()
            .map(|p| Secret::new(String::from_utf8_lossy(p).into_owned()))
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
    fn the_runtime_login_takes_the_url_password_when_there_is_no_file() {
        let c = Config::from_lookup(env(&[(
            "DATABASE_URL",
            "postgres://fathom_app:from-url@127.0.0.1:5432/fathom",
        )]))
        .unwrap();
        let password = c.runtime_login_password().expect("the URL carries one");
        assert_eq!(password.expose(), "from-url");
    }

    #[test]
    fn the_password_file_wins_over_the_url() {
        let c = Config::from_lookup_and_files(
            env(&[
                (
                    "DATABASE_URL",
                    "postgres://fathom_app:from-url@db:5432/fathom",
                ),
                ("FATHOM_DB_PASSWORD_FILE", "/keys/db_app.pw"),
            ]),
            |_| Some("from-file\n".to_string()),
        )
        .unwrap();
        let password = c.runtime_login_password().expect("the file carries one");
        assert_eq!(password.expose(), "from-file");
    }

    #[test]
    fn no_file_and_no_url_password_means_none() {
        let c = Config::from_lookup(env(&[("DATABASE_URL", "postgres://fathom_app@db/fathom")]))
            .unwrap();
        assert!(c.runtime_login_password().is_none());
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
    fn the_session_address_check_defaults_to_site_and_parses_its_three_words() {
        let c = Config::from_lookup(env(&[("DATABASE_URL", "postgres://u@h/db")])).unwrap();
        assert_eq!(
            c.session_address_check,
            crate::sessions::AddressCheckMode::Site
        );

        for (word, mode) in [
            ("site", crate::sessions::AddressCheckMode::Site),
            ("all", crate::sessions::AddressCheckMode::All),
            ("off", crate::sessions::AddressCheckMode::Off),
            ("ALL", crate::sessions::AddressCheckMode::All),
        ] {
            let c = Config::from_lookup(env(&[
                ("DATABASE_URL", "postgres://u@h/db"),
                ("FATHOM_SESSION_ADDRESS_CHECK", word),
            ]))
            .unwrap();
            assert_eq!(c.session_address_check, mode, "{word}");
        }

        let err = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_SESSION_ADDRESS_CHECK", "sometimes"),
        ]))
        .unwrap_err();
        assert!(
            matches!(
                err,
                ConfigError::Unparseable {
                    variable: "FATHOM_SESSION_ADDRESS_CHECK"
                }
            ),
            "{err:?}"
        );
    }

    #[test]
    fn staging_firmware_with_nowhere_to_fetch_it_from_is_refused_at_startup() {
        // Half-configured looks whole until the first upgrade, which is the
        // worst moment to find out.
        let err = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_FIRMWARE_DIR", "/var/lib/fathom/firmware"),
        ]))
        .unwrap_err();
        assert!(
            matches!(
                err,
                ConfigError::Unparseable {
                    variable: "FATHOM_FIRMWARE_FETCH_BASE_URL"
                }
            ),
            "{err:?}"
        );

        // Both together are fine, and the trailing slash is not the operator's
        // problem: it is rendered into a command, so it is normalised here.
        let c = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_FIRMWARE_DIR", "/var/lib/fathom/firmware"),
            ("FATHOM_FIRMWARE_FETCH_BASE_URL", "https://fathom.example/"),
        ]))
        .unwrap();
        assert_eq!(
            c.firmware_fetch_base_url.as_deref(),
            Some("https://fathom.example")
        );
        assert_eq!(c.firmware_max_bytes, DEFAULT_FIRMWARE_MAX_BYTES);

        // Neither set: the feature is simply off, and that is not an error.
        let off = Config::from_lookup(env(&[("DATABASE_URL", "postgres://u@h/db")])).unwrap();
        assert!(off.firmware_dir.is_none());
    }

    #[test]
    fn single_operator_mode_is_off_unless_it_is_asked_for_unambiguously() {
        // The safe value is what a fumbled setting gives you. `FATHOM_SINGLE_
        // OPERATOR=flase` must not be single-operator mode, and neither must
        // an empty string left behind by a template that filled nothing in.
        for absent_or_wrong in ["", "   ", "0", "false", "no", "flase", "off", "2"] {
            let c = Config::from_lookup(env(&[
                ("DATABASE_URL", "postgres://u@h/db"),
                ("FATHOM_SINGLE_OPERATOR", absent_or_wrong),
            ]))
            .unwrap();
            assert!(!c.single_operator, "must be off for {absent_or_wrong:?}");
        }
        for asked in ["1", "true", "TRUE", "yes", " Yes "] {
            let c = Config::from_lookup(env(&[
                ("DATABASE_URL", "postgres://u@h/db"),
                ("FATHOM_SINGLE_OPERATOR", asked),
            ]))
            .unwrap();
            assert!(c.single_operator, "must be on for {asked:?}");
        }
        let c = Config::from_lookup(env(&[("DATABASE_URL", "postgres://u@h/db")])).unwrap();
        assert!(!c.single_operator, "absent means off");
    }

    #[test]
    fn the_bootstrap_token_path_is_the_deployments_choice_and_is_not_in_the_key_volume() {
        // The fault this variable exists for: the path used to be DERIVED
        // from `FATHOM_MASTER_KEY`, so it landed in a volume the shipped
        // compose file mounts read-only, and a first start in a container
        // could not write the one secret a human has to read. Two claims,
        // both of which have to hold.
        let default = Config::from_lookup(env(&[("DATABASE_URL", "postgres://u@h/db")])).unwrap();
        assert_eq!(default.bootstrap_token_file, DEFAULT_BOOTSTRAP_TOKEN_FILE);
        assert!(
            !default.bootstrap_token_file.contains("/keys/"),
            "the default must not land in the key volume: it is read-only to this process \
             in the shipped deployment"
        );

        // And it does not move when the master key does, which is the whole
        // point of the change.
        let elsewhere = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            (
                "FATHOM_MASTER_KEY",
                "file:///var/lib/fathom/keys/master.key",
            ),
        ]))
        .unwrap();
        assert_eq!(
            elsewhere.bootstrap_token_file, DEFAULT_BOOTSTRAP_TOKEN_FILE,
            "the token path must not be derived from where the master key lives"
        );

        let chosen = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            (
                "FATHOM_BOOTSTRAP_TOKEN_FILE",
                "  /var/lib/fathom/bootstrap/first-operator-token  ",
            ),
        ]))
        .unwrap();
        assert_eq!(
            chosen.bootstrap_token_file,
            "/var/lib/fathom/bootstrap/first-operator-token"
        );

        let blank = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_BOOTSTRAP_TOKEN_FILE", "   "),
        ]))
        .unwrap();
        assert_eq!(
            blank.bootstrap_token_file, DEFAULT_BOOTSTRAP_TOKEN_FILE,
            "a template that filled nothing in falls back to the default"
        );
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

    // ---- ADR-0057 decision 1: the setup password -------------------------

    #[test]
    fn no_setup_password_means_none() {
        let c = Config::from_lookup(env(&[("DATABASE_URL", "postgres://u@h/db")])).unwrap();
        assert!(c.setup_password.is_none());
    }

    #[test]
    fn an_empty_setup_password_is_also_none() {
        // compose passes an unset variable through as `""`, not absent.
        let c = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_SETUP_PASSWORD", ""),
        ]))
        .unwrap();
        assert!(c.setup_password.is_none());
    }

    #[test]
    fn the_setup_password_is_read_exactly_as_given_and_not_trimmed() {
        // The client sends what was typed, unmodified, so leading and
        // trailing characters must survive unchanged.
        let c = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            (
                "FATHOM_SETUP_PASSWORD",
                " correct horse battery staple padding ",
            ),
        ]))
        .unwrap();
        assert_eq!(
            c.setup_password.as_ref().map(|p| p.expose().as_str()),
            Some(" correct horse battery staple padding ")
        );
    }

    #[test]
    fn the_setup_password_is_a_secret_like_every_other() {
        let c = Config::from_lookup(env(&[
            ("DATABASE_URL", "postgres://u@h/db"),
            ("FATHOM_SETUP_PASSWORD", "hunter2-hunter2-hunter2"),
        ]))
        .unwrap();
        for rendered in [format!("{c:?}"), format!("{c:#?}")] {
            assert!(!rendered.contains("hunter2"), "{rendered}");
        }
    }
}
