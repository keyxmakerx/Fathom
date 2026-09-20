//! The binary. See `lib.rs` for what this server is and is not.

use std::process::ExitCode;
use std::sync::Arc;

use fathom_server::config::Config;
use fathom_server::engine::EngineState;
use fathom_server::health::HealthState;
use fathom_server::{db, keys, log_startup, migrate, rls, router, AppState};

/// Where the first operator's enrolment token is written -- on a first start,
/// and by `reissue-bootstrap-token`.
///
/// **The deployment chooses it; it is no longer derived from where the master
/// key lives.** It was derived, until 2026-09-14, on the argument that the key
/// volume is the place the operator has already been told to guard -- and that
/// argument was right about the guarding and wrong about the filesystem. ADR-
/// 0043 §3 gives the master key its own volume; `compose.yaml` mounts
/// that volume READ-ONLY on the server, because the server reads the key and
/// does not write it. So a first start in a container tried to write a bearer
/// token into a read-only mount, failed, and exited -- with the operator row
/// already committed, which meant nothing would ever re-bootstrap either. See
/// `config::Config::bootstrap_token_file`.
fn bootstrap_token_path(config: &Config) -> std::path::PathBuf {
    std::path::PathBuf::from(&config.bootstrap_token_file)
}

/// Write the bootstrap token, readable by its owner and nobody else.
///
/// The mode is set **before** the bytes are written, not after, because a file
/// created world-readable and then chmodded is world-readable for the length
/// of that window, and this is a bearer token. Hex rather than raw bytes so an
/// operator can read it out of a terminal without a hex dump, and a trailing
/// newline so `cat` behaves.
fn write_bootstrap_token(path: &std::path::Path, token: &[u8; 32]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;

    let mut hex = String::with_capacity(65);
    for byte in token {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex.push('\n');

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(path)?;
    file.write_all(hex.as_bytes())?;
    file.sync_all()
}

#[tokio::main]
async fn main() -> ExitCode {
    // `43` §5.4: "distroless has no shell and no curl. The binary is its own
    // health check." One subcommand, handled before anything else, because it
    // needs no configuration and must not fail for want of DATABASE_URL — the
    // container running the probe is the container being probed.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("healthcheck") {
        let addr = match args.iter().position(|a| a == "--addr") {
            Some(i) => args.get(i + 1).cloned(),
            None => None,
        }
        .unwrap_or_else(|| "127.0.0.1:8080".to_string());

        return match fathom_server::healthcheck::probe(&addr).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(why) => {
                // stderr, not tracing: no subscriber has been installed and
                // this process exists for one second to answer one question.
                eprintln!("fathom-server: unhealthy: {why}");
                ExitCode::FAILURE
            }
        };
    }
    // The second subcommand, and the one that has to be read carefully.
    // `reissue_bootstrap_token` below carries the argument; the short version
    // is that it mints a fresh first-operator enrolment token ONLY while no
    // operator key has ever been enrolled, and refuses loudly afterwards.
    //
    // Unlike `healthcheck` it needs the full configuration, the database and
    // the key material, so it is handled after the arguments are checked and
    // not before.
    if args.first().map(String::as_str) == Some("reissue-bootstrap-token") {
        if args.len() > 1 {
            eprintln!("fathom-server: reissue-bootstrap-token takes no arguments");
            return ExitCode::from(2);
        }
        return reissue_bootstrap_token().await;
    }
    if !args.is_empty() {
        eprintln!(
            "fathom-server: the subcommands are `healthcheck [--addr HOST:PORT]` and \
             `reissue-bootstrap-token`; with no arguments it runs the server"
        );
        return ExitCode::from(2);
    }

    // Configuration BEFORE logging, so a bad configuration fails on stderr
    // rather than through a subscriber that may not have been set up yet.
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fathom-server: {e}");
            return ExitCode::from(2);
        }
    };

    // The schema tree, same shape as the config it sits beside: read before
    // logging, fail on stderr, no subscriber to blame for having missed it.
    // A schema that failed to parse — or failed one of its own gates, see
    // `engine::EngineState::load` — is as fundamental a startup problem as a
    // missing DATABASE_URL, and for the same reason gets no default beyond
    // `config.schema_root`'s own (`FATHOM_SCHEMA_ROOT`, `config.rs`).
    let engine = match EngineState::load(std::path::Path::new(&config.schema_root)) {
        Ok(e) => Arc::new(e),
        Err(e) => {
            eprintln!("fathom-server: {e}");
            return ExitCode::from(7);
        }
    };

    tracing_subscriber::fmt()
        .with_max_level(config.log_level.to_tracing())
        // No ANSI. RUSTSEC-2025-0055 is untrusted input logged with escape
        // sequences intact; 0.3.23 escapes them and the `ansi` feature is off
        // in the manifest as well. This line is the third layer of the same
        // decision and costs nothing.
        .with_ansi(false)
        .with_target(true)
        .init();

    // The redacted URL, never the real one. `Config::database_for_logging`
    // fails safe: anything it cannot parse confidently comes back fully
    // redacted rather than as a best guess. The call lives in the library so
    // that G6's test drives this exact line rather than a copy of it.
    log_startup(&config);

    // ---- The migration role, used once, then dropped -------------------
    //
    // `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §15.0: the migration role owns
    // the schema and holds `CREATEROLE`. It applies any outstanding
    // migrations and provisions the runtime role's ability to log in
    // (`migrations/0006_runtime_role.sql` creates that role `NOLOGIN`;
    // `db::provision_runtime_login` is the `ALTER ROLE ... LOGIN PASSWORD`
    // that turns it into one the runtime pool can actually connect as) --
    // and then this pool and its one connection go out of scope. Nothing
    // past this block holds the migration credential.
    //
    // `FATHOM_MIGRATE_DATABASE_URL` unset is a supported shape, not a partial
    // failure: the owner's call is that a deployment that never hands the
    // server this credential still starts and serves, PROVIDED the schema is
    // already at the version this binary expects -- checked below, against
    // the runtime connection, by `migrate::verify_current`.
    match db::migration_pool(&config) {
        Ok(Some(migrate_pool)) => {
            if let Some(migrate_url) = config.migrate_database_for_logging() {
                tracing::info!(migrate_database = %migrate_url, "migrating");
            }

            let mut migrate_client = match migrate_pool.get().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!(
                        kind = %summarise(&e),
                        "could not reach the database as the migration role"
                    );
                    return ExitCode::from(5);
                }
            };

            // Same gate as the runtime role's below, and for the same
            // reason: `FORCE ROW LEVEL SECURITY` does not bind for a
            // superuser or for `BYPASSRLS`, and the migration role owns
            // every table in this database, so a mistake here is at least as
            // dangerous as the same mistake on the runtime role.
            if let Err(e) = rls::assert_rls_binds(&migrate_client).await {
                tracing::error!(error = %e, "refusing to start (migration role)");
                return ExitCode::from(8);
            }

            // `migrate::run`'s own advisory lock only covers `run` itself,
            // and `provision_runtime_login` below is a second write against
            // shared, cluster-wide state (`pg_authid`) that two migrating
            // processes racing at startup could otherwise both touch at
            // once. Held across both calls -- `pg_advisory_lock` is
            // session-level and re-entrant, so `run`'s own acquisition on
            // this same session nests inside it without deadlocking.
            if let Err(e) = migrate_client
                .execute(
                    "SELECT pg_advisory_lock($1)",
                    &[&migrate::MIGRATION_LOCK_KEY],
                )
                .await
            {
                tracing::error!(error = %e, "could not take the migration lock");
                return ExitCode::from(4);
            }

            // Migrations before the listener binds. A server that accepts
            // requests while its schema is half-applied is a server
            // answering from a state nobody designed.
            let migration_result = migrate::run(&mut migrate_client).await;

            // Determined (and, if possible, acted on) while the lock is
            // still held, but reported on only after it is released -- the
            // lock must not stay taken behind an early return.
            let runtime_role_result = db::runtime_role(&config);
            let provision_result = match &runtime_role_result {
                Ok(role) => {
                    let runtime_password = config
                        .database_password
                        .as_ref()
                        .map(|p| p.expose().as_str());
                    Some(db::provision_runtime_login(&migrate_client, role, runtime_password).await)
                }
                Err(_) => None,
            };

            let _ = migrate_client
                .execute(
                    "SELECT pg_advisory_unlock($1)",
                    &[&migrate::MIGRATION_LOCK_KEY],
                )
                .await;

            match migration_result {
                Ok(0) => tracing::info!("schema is up to date"),
                Ok(n) => tracing::info!(applied = n, "migrations applied"),
                Err(e) => {
                    tracing::error!(error = %e, "migrations failed");
                    return ExitCode::from(4);
                }
            }
            if let Err(e) = runtime_role_result {
                tracing::error!(error = %e, "could not determine the runtime role's name");
                return ExitCode::from(3);
            }
            if let Err(e) = provision_result.expect("Ok(_) checked just above") {
                tracing::error!(error = %e, "could not provision the runtime role's login");
                return ExitCode::from(4);
            }
            // `migrate_client` and `migrate_pool` drop at the end of this
            // match arm.
        }
        Ok(None) => {
            tracing::info!(
                "no migration credential configured; the runtime role must already exist, be \
                 able to log in, and be at the schema version this binary expects"
            );
        }
        Err(e) => {
            tracing::error!(error = %e, "could not build the migration connection pool");
            return ExitCode::from(3);
        }
    }

    // ---- The runtime pool: what serves every request from here on ------
    let pool = match db::pool(&config) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(error = %e, "could not build the connection pool");
            return ExitCode::from(3);
        }
    };

    // The tenant-isolation gate, before the listener binds, against the
    // RUNTIME role specifically -- this is the connection every request is
    // served from, and the one whose isolation actually matters.
    // `migrations/0002_identity_and_scope.sql` FORCEs row-level security, but
    // that binds for nothing if the role this server connected as is a
    // superuser or carries BYPASSRLS -- Postgres exempts both
    // unconditionally. Found 2026-09-12: the shipped `compose.yaml`
    // connected as exactly such a role, so every isolation policy was inert
    // in production while the tests, which provision a restricted role on
    // purpose, kept passing. This asks the database what the connected role
    // actually is and refuses to start rather than warn -- the same shape as
    // `EngineState::load`'s schema gate above.
    match pool.get().await {
        Ok(client) => {
            if let Err(e) = rls::assert_rls_binds(&client).await {
                tracing::error!(error = %e, "refusing to start");
                return ExitCode::from(8);
            }

            if config.migrate_database_url.is_none() {
                match migrate::verify_current(&client).await {
                    Ok(true) => {
                        tracing::info!("schema is up to date (no migration credential configured)")
                    }
                    Ok(false) => {
                        tracing::error!(
                            "the schema is not at the version this binary expects, and no \
                             migration credential was configured to bring it there"
                        );
                        return ExitCode::from(9);
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "the schema does not match what this binary expects");
                        return ExitCode::from(4);
                    }
                }
            }
        }
        Err(e) => {
            // deadpool's error Display does not carry the password (the pool
            // was built from parsed parts, not the URL), but it is not this
            // binary's guarantee to make, so it is summarised rather than
            // printed whole.
            tracing::error!(kind = %summarise(&e), "could not reach the database at startup");
            return ExitCode::from(5);
        }
    }

    // ---- The keys, and the one check that must run before any read -------
    //
    // ADR-0043 §4, and it is the whole reason this block is here rather than
    // at the first write: *"a restore with the wrong key must report 'this
    // database was encrypted under master key a41f...; the configured key is
    // 9c02...' rather than surfacing as an AEAD tag failure that reads like
    // corruption. Without it the most common operator error produces the most
    // alarming possible symptom."*
    // `Arc` because the shipper holds it too: `audit::spawn`'s threshold
    // entries are sealed site-chain entries like any other, so the background
    // task needs the chain master. It is one allocation and it is the only
    // thing that makes "the spool passed a bound" recordable.
    let ring = match keys::KeyRing::load(&config.master_key, &config.chain_key, true) {
        Ok(r) => Arc::new(r),
        Err(e) => {
            tracing::error!(
                error = %e,
                master_key = %config.master_key.describe(),
                chain_key = %config.chain_key.describe(),
                "refusing to start: the key material could not be loaded"
            );
            return ExitCode::from(10);
        }
    };

    {
        let (master_source, chain_source) = ring.describe_sources();
        // ADR-0043 §10: "the key file gets its own named volume, a startup log
        // line naming the volume that must never be archived with the
        // database, and that sentence repeated in the backup documentation."
        // The standard self-hosted backup recipe is "tar all the volumes",
        // which would otherwise put both halves in one archive.
        tracing::info!(
            master_key_id = %ring.master_key_id(),
            master_key_source = %master_source,
            chain_key_id = %ring.chain_key_id(),
            chain_key_source = %chain_source,
            "keys loaded. The key volume must never be archived with a database backup: \
             together they are both halves. Copy it off the machine, somewhere the database \
             backups are not, and test a restore with it."
        );
    }

    match pool.get().await {
        Ok(client) => {
            if let Err(e) = keys::register_master_key(&client, &ring).await {
                tracing::error!(error = %e, "refusing to start");
                return ExitCode::from(11);
            }
            // The same stamp for the other root. Without it a lost chain key
            // file -- which `KeyRing::load(..., true)` above silently recreates
            // -- makes every history in this database report "broken at entry
            // 1", which is an operator error rendered as an attack.
            if let Err(e) = keys::register_chain_master_key(&client, &ring).await {
                tracing::error!(error = %e, "refusing to start");
                return ExitCode::from(11);
            }
        }
        Err(e) => {
            tracing::error!(kind = %summarise(&e), "could not reach the database at startup");
            return ExitCode::from(5);
        }
    }

    // ---- The site chain, and the deployment identity it is sealed under ----
    //
    // `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7.1 derives the site chain key
    // over a `deployment_id`, so one is stamped on first start and never
    // changes. §7.2's `deployment_started` is then the first thing this
    // deployment can prove about itself, and one more is appended on every
    // start — so a restart nobody authorised is a row somebody can point at.
    let deployment = match pool.get().await {
        Ok(mut client) => {
            let registered = match fathom_server::chains::register_deployment(&**client).await {
                Ok(id) => id,
                Err(e) => {
                    tracing::error!(error = %e, "could not establish this deployment's identity");
                    return ExitCode::from(12);
                }
            };
            let tx = match client.transaction().await {
                Ok(tx) => tx,
                Err(e) => {
                    tracing::error!(error = %e, "could not open a transaction for the site chain");
                    return ExitCode::from(12);
                }
            };
            let appended = fathom_server::chains::record_deployment_started(
                &tx,
                &ring,
                &registered,
                migrate::MIGRATIONS.len() as i32,
            )
            .await;
            match appended {
                Ok(entry) => {
                    if let Err(e) = tx.commit().await {
                        tracing::error!(error = %e, "could not commit the site chain entry");
                        return ExitCode::from(12);
                    }
                    tracing::info!(
                        deployment = %registered,
                        site_chain_seq = entry.seq,
                        "site chain appended: deployment_started"
                    );
                }
                Err(e) => {
                    // Refusing to start rather than serving with no site chain.
                    // An audit trail that begins whenever it happened to work
                    // is one nobody can reason about a gap in.
                    tracing::error!(error = %e, "could not append to the site chain");
                    return ExitCode::from(12);
                }
            }
            registered
        }
        Err(e) => {
            tracing::error!(kind = %summarise(&e), "could not reach the database at startup");
            return ExitCode::from(5);
        }
    };

    // ---- Shipping the trail off the box (§9) ----------------------------
    //
    // **The absence of a destination is stated, not tolerated silently.** §9
    // permits no witness at all and requires it to be permanently marked;
    // §7.4 forbids calling an un-countersigned target an anchor. Receipts are
    // deferred (§15.6), so this deployment is `unwitnessed` either way and the
    // line says so in both branches rather than only the embarrassing one.
    match &config.audit_syslog {
        Some(target) => {
            tracing::info!(
                destination = %target,
                deployment = %deployment,
                "audit shipping enabled: one RFC 5424 line per sealed entry over TCP. Entries \
                 spool in PostgreSQL when the destination is unreachable and drain in order when \
                 it returns; nothing is dropped and shipping never blocks a write. This \
                 deployment is UNWITNESSED: no countersigned receipt exists yet, so the \
                 destination is a folder and not an anchor."
            );
            fathom_server::audit::spawn(
                pool.clone(),
                target.clone(),
                fathom_server::audit::DEFAULT_INTERVAL,
                config.audit_spool_bounds,
                Arc::clone(&ring),
                deployment.clone(),
            );
        }
        None => {
            tracing::info!(
                deployment = %deployment,
                "FATHOM_AUDIT_SYSLOG is not set: audit entries are SPOOL-ONLY. Every sealed \
                 entry is written and queued in PostgreSQL, and nothing ships anywhere. This \
                 deployment is UNWITNESSED: nothing outside this machine holds a copy of the \
                 audit trail, so a party who holds the machine holds all of it."
            );
        }
    }

    // ---- Sessions, and the first routes that need one --------------------
    //
    // `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4. The store holds the pool,
    // the chain master (for the site-scoped row key a session row's MAC is
    // taken under), this deployment's identity (inside every challenge) and
    // §13 item 7's limits. `EpochWatch` is the one per-process value §3.4 step
    // 3 asks for, and this is the first thing in the server with a request
    // layer to hold it.
    let sessions = Arc::new(fathom_server::sessions::SessionStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment.clone(),
        config.sign_in_limits,
    ));
    let watch = Arc::new(fathom_server::grants::EpochWatch::new());
    // One address policy for every route that counts one
    // (`src/client_address.rs`). Parsed again here from text the config
    // already validated, so the `expect` cannot fire.
    let client_address = fathom_server::client_address::ClientAddress::new(
        config.trusted_client_ip_header.clone(),
        fathom_server::client_address::parse_trusted_proxies(&config.trusted_proxies.join(","))
            .expect("config refuses an unparseable FATHOM_TRUSTED_PROXIES"),
    );
    match (
        client_address.header_name(),
        client_address.trusted_proxies().is_empty(),
    ) {
        (None, _) => tracing::info!("client addresses: the peer, no forwarding header trusted"),
        (Some(header), true) => tracing::warn!(
            header,
            "client addresses: the forwarding header is believed from EVERY peer; set \
             FATHOM_TRUSTED_PROXIES to the proxy's address so a client reaching this port \
             directly cannot choose its own"
        ),
        (Some(header), false) => tracing::info!(
            header,
            trusted_proxies = ?config.trusted_proxies,
            "client addresses: the forwarding header, believed only from the trusted proxies"
        ),
    }
    let api = fathom_server::api::ApiState {
        sessions: Arc::clone(&sessions),
        watch: Arc::clone(&watch),
        ring: Arc::clone(&ring),
        client_address: client_address.clone(),
    };

    // The design routes share the session store and the epoch watch with the
    // session routes deliberately: two `SessionStore`s would be two nonce
    // tables' worth of state in one process, and two `EpochWatch`es would
    // defeat the single per-process value §3.4 step 3 asks for. They are built
    // once above and both routers hold the same `Arc`.
    //
    // The catalogue is read once, here, and never from a request: it is
    // read-only reference data and a per-request filesystem read would be a
    // way to make an authenticated caller do disk work. A catalogue that will
    // not load is a startup failure with the file and the line, the same
    // treatment `EngineState::load` gives a broken schema tree -- serving a
    // faceplate the operator cannot see the source of is worse than not
    // starting. `load_catalogue` wants the directory that holds both `corpus/`
    // and `schema/`, which is `schema_root`'s parent.
    let corpus_root = std::path::Path::new(&config.schema_root)
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let catalogue = match fathom_server::design_api::load_catalogue(&corpus_root) {
        Ok(models) => {
            tracing::info!(
                models = models.len(),
                root = %corpus_root.display(),
                "equipment catalogue loaded"
            );
            Arc::new(models)
        }
        Err(e) => {
            tracing::error!(
                file = %e.file,
                line = e.line,
                gate = ?e.gate,
                message = %e.message,
                root = %corpus_root.display(),
                "the equipment catalogue could not be loaded; refusing to start"
            );
            return ExitCode::from(8);
        }
    };
    let sessions_for_firmware = Arc::clone(&sessions);
    let watch_for_firmware = Arc::clone(&watch);
    let designs = fathom_server::design_api::DesignApiState {
        sessions: Arc::clone(&sessions),
        watch,
        ring: Arc::clone(&ring),
        catalogue,
    };

    // The operator plane. `single_operator` is read from the configuration
    // rather than decided here, and it removes the second signature without
    // removing the delay -- admin design §5.3, and `config.rs` says why on the
    // field itself.
    let operators = Arc::new(fathom_server::operators::OperatorStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment.clone(),
        config.single_operator,
    ));

    // §5.3's mode is written to the site chain at startup rather than left as
    // a belief held only by this process's environment. An auditor reading the
    // chain can then see that the deployment was running with one operator,
    // and when.
    if config.single_operator {
        match operators.record_single_operator_mode().await {
            Ok(seq) => tracing::warn!(
                site_chain_seq = seq,
                "FATHOM_SINGLE_OPERATOR is set: settings changes need ONE operator's assertion                  instead of two. The delay is unchanged and is now the only thing standing                  between one compromised operator and a changed setting."
            ),
            Err(e) => {
                tracing::error!(error = ?e, "could not record single-operator mode; refusing to start");
                return ExitCode::from(9);
            }
        }
    }

    // First start mints the first operator and their enrolment token. The
    // token is the one secret in this program that a human has to read, so it
    // goes to a file the DEPLOYMENT names (`FATHOM_BOOTSTRAP_TOKEN_FILE`),
    // mode 0400, and its PATH is logged while the token itself never is --
    // logs are shipped off the box by design (`audit.rs`), and a token in a
    // log is a token in whatever holds the logs.
    let notice_address = config.operator_notice_address.clone().unwrap_or_default();
    match operators
        .bootstrap_first_operator("the first operator", &notice_address)
        .await
    {
        Ok(bootstrap) => {
            let path = bootstrap_token_path(&config);
            match write_bootstrap_token(&path, &bootstrap.invitation.token) {
                Ok(()) => tracing::warn!(
                    operator_id = %bootstrap.operator_id,
                    token_file = %path.display(),
                    expires_at_unix = bootstrap.invitation.expires_at_unix,
                    "FIRST START: an operator was created and an enrolment token written. Read                      the file, redeem it in a browser, then delete it. The token is not in this                      log and will not be shown again."
                ),
                Err(e) => {
                    tracing::error!(
                        error = %e,
                        token_file = %path.display(),
                        "the first operator was created but their enrolment token could not be                          written, so nobody can redeem it; refusing to start. Point                          FATHOM_BOOTSTRAP_TOKEN_FILE at a path this process can create a file in --                          it must NOT be inside the read-only key volume -- and then run                          `fathom-server reissue-bootstrap-token` to mint a fresh one, which is                          still permitted because no operator key has been enrolled yet"
                    );
                    return ExitCode::from(10);
                }
            }
        }
        // Every start after the first. Not an error here: the deployment is
        // already bootstrapped, which is the ordinary case.
        Err(fathom_server::operators::OperatorError::AlreadyBootstrapped) => {}
        Err(e) => {
            tracing::error!(
                error = ?e,
                notice_address_set = config.operator_notice_address.is_some(),
                "could not bootstrap the first operator; refusing to start. On a first start, set                  FATHOM_OPERATOR_NOTICE_ADDRESS to the address that should receive operator                  notices."
            );
            return ExitCode::from(9);
        }
    }

    // Firmware staging (ADR-0045). Absent configuration means the routes are
    // not mounted at all rather than mounted and failing: a route that answers
    // is a route an attacker can probe, and most deployments will never stage
    // an image. The directory is proved writable HERE, by writing and removing
    // a probe file, so a deployment that cannot stage learns it at startup and
    // not from an operator halfway through a maintenance window.
    let firmware = match &config.firmware_dir {
        None => None,
        Some(dir) => {
            let base = config
                .firmware_fetch_base_url
                .clone()
                .expect("config refuses a firmware directory with no fetch base URL");
            match fathom_server::firmware::FirmwareStore::open(
                std::path::PathBuf::from(dir),
                config.firmware_max_bytes,
                base.clone(),
                client_address.clone(),
            ) {
                Ok(store) => {
                    tracing::info!(
                        directory = %dir,
                        max_image_bytes = config.firmware_max_bytes,
                        fetch_base_url = %base,
                        "firmware staging enabled. The fetch base URL must be an origin a DEVICE \
                         can reach, which is often not the one a browser uses."
                    );
                    Some(Arc::new(store))
                }
                Err(e) => {
                    tracing::error!(
                        error = %e,
                        directory = %dir,
                        "the firmware staging directory is unusable; refusing to start"
                    );
                    return ExitCode::from(11);
                }
            }
        }
    };

    // The web client, served by this binary (`src/client.rs`, 2026-09-20:
    // one published port behind the operator's own reverse proxy, like every
    // other service they run). A root that names no `index.html` is refused
    // at startup, not discovered as a 404 on the first visit.
    let client_root = match &config.client_root {
        None => {
            tracing::info!("no FATHOM_CLIENT_ROOT; serving the API only");
            None
        }
        Some(dir) => match fathom_server::client::ClientRoot::open(dir) {
            Ok(root) => {
                tracing::info!(directory = %root.path().display(), "serving the web client");
                Some(root)
            }
            Err(e) => {
                tracing::error!(
                    error = %e,
                    directory = %dir,
                    "FATHOM_CLIENT_ROOT is not a built client; refusing to start"
                );
                return ExitCode::from(13);
            }
        },
    };

    let admin = fathom_server::admin::AdminState {
        sessions,
        operators,
        ring: Arc::clone(&ring),
        client_address: client_address.clone(),
    };
    tracing::info!(
        window_seconds = config.sign_in_limits.window.as_secs(),
        max_per_account = config.sign_in_limits.max_per_account,
        max_per_source = config.sign_in_limits.max_per_source,
        "sign-in limits"
    );

    let health = Arc::new(HealthState {
        pool,
        timeout: config.health_timeout,
    });

    let listener = match tokio::net::TcpListener::bind(&config.bind).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(error = %e, bind = %config.bind, "could not bind");
            return ExitCode::from(6);
        }
    };

    tracing::info!(bind = %config.bind, "listening");

    // `into_make_service_with_connect_info` rather than the router directly:
    // §13 item 7's source bucket needs the peer address, and without this the
    // extension it reads is never populated, so every sign-in in the
    // deployment would count into one bucket named "unknown".
    // Where the operator console answers (`src/admin_exposure.rs`): confined
    // to the configured hosts and source addresses, or open, which the log
    // says in so many words so that nobody assumes otherwise.
    let exposure = fathom_server::admin_exposure::AdminExposure::new(
        config.admin_hosts.clone(),
        config
            .admin_sources
            .iter()
            .filter_map(|s| fathom_server::admin_exposure::Cidr::parse(s)),
        client_address.clone(),
    );
    let admin_router = if exposure.is_open() {
        tracing::warn!(
            "the operator console (/admin, /enrolment/operator) answers on every host and from \
             every address; set FATHOM_ADMIN_HOSTS and/or FATHOM_ADMIN_SOURCES to confine it"
        );
        fathom_server::admin::router(admin)
    } else {
        tracing::info!(
            hosts = ?exposure.hosts(),
            sources = ?config.admin_sources,
            "the operator console answers only on these hosts and from these addresses; \
             elsewhere its paths are 404"
        );
        fathom_server::admin::router(admin).layer(axum::middleware::from_fn_with_state(
            exposure,
            fathom_server::admin_exposure::gate,
        ))
    };
    let mut app = router(AppState { health, engine })
        .merge(fathom_server::api::router(api))
        .merge(fathom_server::design_api::router(designs))
        .merge(admin_router);
    if let Some(store) = firmware {
        app = app.merge(fathom_server::firmware::router(
            fathom_server::firmware::FirmwareState {
                sessions: Arc::clone(&sessions_for_firmware),
                watch: Arc::clone(&watch_for_firmware),
                ring: Arc::clone(&ring),
                store,
            },
        ));
    }
    // Last, so that every API route above wins over a file of the same name.
    if let Some(root) = client_root {
        app = root.attach(app);
    }
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await;

    match served {
        Ok(()) => {
            tracing::info!("stopped cleanly");
            ExitCode::SUCCESS
        }
        Err(e) => {
            tracing::error!(error = %e, "stopped with an error");
            ExitCode::FAILURE
        }
    }
}

/// **The way back into a deployment whose first-operator token was lost**, and
/// the one command in this binary that mints a bearer secret with no session
/// behind it.
///
/// Read `operators::OperatorStore::reissue_bootstrap_token` before changing
/// anything here: the gate is that no operator key has ever been enrolled, and
/// it is what stops this being a way for anyone who can run a command on this
/// host to mint themselves an operator session.
///
/// What this function adds around that gate:
///
/// - **The token goes to the file and nowhere else.** Not stdout, not the log,
///   not an error message. The log line names the path, the operator, the
///   expiry and the site-chain `seq`, which is everything an operator needs and
///   nothing an attacker holding the logs can use.
/// - **An existing file is refused, not overwritten.** The file that is already
///   there may be the valid token this command was run because somebody could
///   not find; replacing it would destroy the thing it is here to restore. The
///   check happens twice -- once before the database is touched, so the common
///   case fails before anything is minted, and once in `create_new` at the
///   write, which is the one that is not a race.
/// - **The key material is loaded but never created.** The server's own
///   startup passes `create_if_missing: true`; this passes `false`, because a
///   chain key invented here would make every entry ever sealed under the real
///   one unverifiable, and the symptom would read as tampering.
async fn reissue_bootstrap_token() -> ExitCode {
    // Configuration BEFORE logging, exactly as the server does and for the
    // same reason: a bad configuration fails on stderr rather than through a
    // subscriber that has not been set up.
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fathom-server: {e}");
            return ExitCode::from(2);
        }
    };

    tracing_subscriber::fmt()
        .with_max_level(config.log_level.to_tracing())
        .with_ansi(false)
        .with_target(true)
        .init();

    let path = bootstrap_token_path(&config);

    // Before the database, before the keys, before anything is minted. A
    // token file that already exists may be the live one, and this command
    // must never be the thing that destroys it.
    if path.exists() {
        tracing::error!(
            token_file = %path.display(),
            "refusing: a token file already exists at this path. It may be the valid token. \
             Read it, or move it out of the way deliberately, and run this again"
        );
        return ExitCode::from(10);
    }

    tracing::info!(
        database = %config.database_for_logging(),
        token_file = %path.display(),
        "re-issuing the first operator's enrolment token"
    );

    let pool = match db::pool(&config) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(error = %e, "could not build the connection pool");
            return ExitCode::from(3);
        }
    };

    let client = match pool.get().await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(kind = %summarise(&e), "could not reach the database");
            return ExitCode::from(5);
        }
    };

    // The same gate the server refuses to start without, and for the same
    // reason: this command writes rows and appends to the site chain through
    // the runtime role, and a superuser connection would have every isolation
    // policy in the database inert underneath it.
    if let Err(e) = rls::assert_rls_binds(&client).await {
        tracing::error!(error = %e, "refusing");
        return ExitCode::from(8);
    }

    // `false`: load the keys, never create them. See this function's own doc.
    let ring = match keys::KeyRing::load(&config.master_key, &config.chain_key, false) {
        Ok(r) => Arc::new(r),
        Err(e) => {
            tracing::error!(
                error = %e,
                master_key = %config.master_key.describe(),
                chain_key = %config.chain_key.describe(),
                "refusing: the key material could not be loaded. This command seals a site-chain \
                 entry like every other operator act, so it needs the same keys the server runs \
                 with -- and it will not invent one"
            );
            return ExitCode::from(10);
        }
    };

    // ADR-0043 §4's check, here for the reason it is there: a wrong key must
    // report which key this database was encrypted under, not surface as an
    // AEAD failure that reads like corruption.
    if let Err(e) = keys::register_master_key(&client, &ring).await {
        tracing::error!(error = %e, "refusing");
        return ExitCode::from(11);
    }
    if let Err(e) = keys::register_chain_master_key(&client, &ring).await {
        tracing::error!(error = %e, "refusing");
        return ExitCode::from(11);
    }

    let deployment = match fathom_server::chains::deployment_id(&**client).await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(
                error = %e,
                "this deployment has no identity, so it has never started and has no first \
                 operator to re-issue for. Start the server once"
            );
            return ExitCode::from(12);
        }
    };
    drop(client);

    let operators = fathom_server::operators::OperatorStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment,
        config.single_operator,
    );

    let reissued = match operators.reissue_bootstrap_token().await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "the enrolment token was NOT re-issued");
            return ExitCode::from(9);
        }
    };

    match write_bootstrap_token(&path, &reissued.invitation.token) {
        Ok(()) => {
            tracing::warn!(
                operator_id = %reissued.operator_id,
                token_file = %path.display(),
                expires_at_unix = reissued.invitation.expires_at_unix,
                site_chain_seq = reissued.issued_seq,
                expired_tokens = reissued.expired.len(),
                "a fresh enrolment token was written for the first operator. Any previously \
                 issued and unredeemed token for them is now dead. Read the file, redeem it in \
                 a browser, then delete it. The token is not in this log and will not be shown \
                 again"
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            // The database has already committed, so the old token is dead and
            // the new one is unreadable. Running the command again is the
            // remedy and still works -- no key has been enrolled, which is the
            // only condition the gate cares about.
            tracing::error!(
                error = %e,
                token_file = %path.display(),
                "the token was minted but could not be written, so nobody can read it. Point \
                 FATHOM_BOOTSTRAP_TOKEN_FILE at a path this process can create a file in and \
                 run this again"
            );
            ExitCode::from(10)
        }
    }
}

/// One word for a pool error, so nothing the driver formatted can travel into a
/// log line.
fn summarise(_e: &deadpool_postgres::PoolError) -> &'static str {
    "unreachable"
}

/// SIGTERM or Ctrl-C.
///
/// **SIGTERM is the one that matters**: it is what a container runtime sends to
/// stop a service (`43` §5.4), and a process that ignores it is a process the
/// runtime eventually kills mid-request.
async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => tracing::info!("interrupt received, shutting down"),
        () = terminate => tracing::info!("SIGTERM received, shutting down"),
    }
}
