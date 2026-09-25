//! The binary. See `lib.rs` for what this server is and is not.

use std::process::ExitCode;
use std::sync::Arc;

use fathom_server::config::Config;
use fathom_server::engine::EngineState;
use fathom_server::health::HealthState;
use fathom_server::{db, keys, log_startup, migrate, rls, AppState};

/// **ADR-0055 decision 3 retired `FATHOM_SINGLE_OPERATOR`, and a deployment
/// that still sets it is refused rather than quietly ignored.**
///
/// A switch somebody believes still works is worse than a refusal: the
/// variable used to be the only way a sole operator could change a setting
/// alone, and an installer who set it and got a running server would believe
/// a control was in force that no longer exists. The quorum is now
/// `min(2, live independent operators)`, counted off the register at every
/// act, which a sole operator satisfies without declaring anything.
///
/// CLAUDE.md rule 2's spirit, applied to configuration.
const RETIRED_SINGLE_OPERATOR: &str = "FATHOM_SINGLE_OPERATOR is set, and it was retired by ADR-0055 decision 3. Remove it from the environment and start again. The second signature is now min(2, live independent operators), counted from the operator register: a deployment with one operator adds a colleague alone, after the 24-hour delay, and needs no switch to do it.";

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
    // `recover_operator` below carries the argument; the short version is that
    // it prints a ten-minute setup code for an operator who ALREADY EXISTS,
    // records the act on the site chain, and mints no operator (ADR-0055
    // decision 8).
    //
    // Unlike `healthcheck` it needs the full configuration, the database and
    // the key material, so it is handled after the arguments are checked and
    // not before.
    if args.first().map(String::as_str) == Some("recover-operator") {
        let Some(address) = args.get(1) else {
            eprintln!("fathom-server: recover-operator takes one argument, the operator's address");
            return ExitCode::from(2);
        };
        if args.len() > 2 {
            eprintln!("fathom-server: recover-operator takes exactly one argument");
            return ExitCode::from(2);
        }
        return recover_operator(address, false).await;
    }
    // ADR-0055 decision 8: `reissue-bootstrap-token` folds into
    // `recover-operator`. Kept as an alias because it is in
    // `docs/OPERATING.md`'s drill and in operators' shell history, and a
    // command that vanished would be discovered at the worst moment. With no
    // address it falls back to FATHOM_OPERATOR_NOTICE_ADDRESS, which is the
    // address the first start bound the first operator to.
    if args.first().map(String::as_str) == Some("reissue-bootstrap-token") {
        if args.len() > 2 {
            eprintln!("fathom-server: reissue-bootstrap-token takes at most one argument");
            return ExitCode::from(2);
        }
        let address = match args.get(1) {
            Some(a) => a.clone(),
            None => match std::env::var("FATHOM_OPERATOR_NOTICE_ADDRESS") {
                Ok(a) if !a.trim().is_empty() => a.trim().to_string(),
                _ => {
                    eprintln!(
                        "fathom-server: reissue-bootstrap-token is an alias for \
                         `recover-operator <address>` (ADR-0055 decision 8) and needs an \
                         address: pass one, or set FATHOM_OPERATOR_NOTICE_ADDRESS"
                    );
                    return ExitCode::from(2);
                }
            },
        };
        return recover_operator(&address, true).await;
    }
    // ADR-0055 stream (c) -- decision 11's last sentence: the way back in when
    // a placement locked everyone out of the console. Run ON THE HOST, where
    // the key volume is mounted, like `reissue-bootstrap-token` above; it
    // needs the full configuration and the key material, so it is handled
    // here and not before.
    if args.first().map(String::as_str) == Some("console-placement") {
        if args.get(1).map(String::as_str) != Some("--reset") || args.len() > 2 {
            eprintln!("fathom-server: console-placement takes exactly `--reset`");
            return ExitCode::from(2);
        }
        return reset_console_placement().await;
    }
    if !args.is_empty() {
        eprintln!(
            "fathom-server: the subcommands are `healthcheck [--addr HOST:PORT]`, \
             `recover-operator <address>` (with `reissue-bootstrap-token` kept as a deprecated \
             alias) and `console-placement --reset`; with no arguments it runs the server"
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

    // ADR-0055 stream (b). Before the schema, before logging, before the
    // database: a deployment that believes a retired control is in force must
    // not get a running server out of this process. See
    // `RETIRED_SINGLE_OPERATOR`.
    if config.single_operator {
        eprintln!("fathom-server: {RETIRED_SINGLE_OPERATOR}");
        return ExitCode::from(2);
    }

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
                    let runtime_password = config.runtime_login_password();
                    let runtime_password = runtime_password.as_ref().map(|p| p.expose().as_str());
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
    )
    .with_hops(config.forwarded_hops);
    match client_address.header_name() {
        None => tracing::warn!(
            "client addresses: the peer. Behind a reverse proxy that is the proxy, so every \
             client shares one sign-in rate-limit bucket and one address in the audit trail; \
             set FATHOM_TRUSTED_PROXIES to the proxy's address or range to count clients apart"
        ),
        Some(header) => tracing::info!(
            header,
            trusted_proxies = ?config.trusted_proxies,
            hops = client_address.hops(),
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

    // The operator plane. ADR-0055 decision 3: the quorum is not configured
    // here or anywhere -- it is `min(2, live independent operators)`, counted
    // off the register at every act.
    let operators = Arc::new(fathom_server::operators::OperatorStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment.clone(),
    ));

    // ADR-0055 stream (c) -- where the console answers, as the console itself
    // set it (`src/placement.rs`). Loaded once here; refreshed on every
    // placement write, by the sweep, and every `placement::SNAPSHOT_TTL` by
    // the task started below -- so `admin_exposure` never runs a query per
    // request AND a placement written by another process (the
    // `console-placement --reset` CLI, or the other container) is honoured
    // here without a restart.
    let placement = Arc::new(fathom_server::placement::PlacementStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment.clone(),
    ));
    match placement.refresh().await {
        Ok(_) => {}
        Err(e) => {
            tracing::error!(
                error = ?e,
                "the console placement could not be read; refusing to start rather than \
                 answering the console on every host because a query failed"
            );
            return ExitCode::from(14);
        }
    }
    // ADR-0055 fix (b): the snapshot re-reads on a timer, so
    // `fathom-server console-placement --reset` -- decision 11's only way
    // back from a console lockout -- takes effect on THIS process without a
    // restart. Before 2026-09-21 the CLI reverted the rows, refreshed its own
    // process's snapshot and exited, and the server kept enforcing the dead
    // placement.
    let placement_refresher =
        fathom_server::placement::PlacementStore::spawn_snapshot_refresher(Arc::clone(&placement));
    tracing::info!(
        ttl_seconds = fathom_server::placement::SNAPSHOT_TTL.as_secs(),
        "the console placement snapshot re-reads on this interval, so a placement written by \
         another process -- `console-placement --reset` on the host, or the other container -- \
         is honoured here without a restart"
    );

    // First start mints the first operator. ADR-0057 decision 1: there is no
    // token file any more. The one-time setup secret that opens the setup
    // screen is minted below, once, after this whole block -- unified across
    // the first start, the adoption path and any later start that is still
    // pending, rather than written here per arm and again there.
    // The first operator is named after the notice address: the one thing
    // the installer already knows about themselves, and what the console
    // then shows beside their operator id (the owner's ask, 2026-09-21).
    let notice_address = config.operator_notice_address.clone().unwrap_or_default();

    // **Before either of them**: every `operators` row sealed by a build older
    // than ADR-0055's fix round is brought up to this build's seal
    // (2026-09-21).
    //
    // `6d1b5de` put `first_independent_signin_at` inside the operator row
    // seal, because decision 3 had just made that column decide whether a
    // second signature is required at all. Every row written before that
    // fails `verify_operator_row` under this build — which is the sign-in
    // path, the seconding path, and the adoption below, all of which verify
    // the row before they do anything with it. A deployment that upgrades
    // into this build would refuse to start at all, having started perfectly
    // well the day before, so this runs first and on every start.
    //
    // It is idempotent: a row already sealed under the current shape is left
    // alone and the next start re-seals nothing.
    match operators.reseal_legacy_operator_rows().await {
        Ok(0) => {}
        Ok(rows) => tracing::warn!(
            rows,
            "re-sealed {rows} operator row(s) written by a build before ADR-0055's fix \
             round. Their seal did not cover first_independent_signin_at; it does now, \
             and nothing else about the rows changed"
        ),
        Err(e) => {
            tracing::error!(
                error = ?e,
                "an operator row verifies under neither this build's row seal nor the one \
                 every build before ADR-0055's fix round wrote, so it was not written by \
                 this server; refusing to start. This is an integrity alarm and not a \
                 permission error: the row named in the error was edited in the database, \
                 and the way back is a restore"
            );
            return ExitCode::from(9);
        }
    }

    match operators
        .bootstrap_first_operator(&notice_address, &notice_address)
        .await
    {
        Ok(bootstrap) => {
            // The invitation `bootstrap_first_operator` mints alongside the
            // operator is not used: nobody is ever handed its bytes (no
            // token file, ADR-0057 decision 1), so it is cryptographically
            // inert and simply expires in its own time. The setup secret a
            // person actually redeems is minted below, from
            // `FATHOM_SETUP_PASSWORD`, after this match.
            tracing::warn!(
                operator_id = %bootstrap.operator_id,
                "FIRST START: an operator was created for FATHOM_OPERATOR_NOTICE_ADDRESS. \
                 Whether setup is open, and how, is decided below."
            );
        }
        // Every start after the first. Not an error here: the deployment is
        // already bootstrapped, which is the ordinary case.
        //
        // **And it is where the upgrade lands.** A deployment whose first
        // start ran under a build before ADR-0055 has an operator, an install
        // record and no binding, so the bootstrap answers here and, until
        // 2026-09-21, nothing else happened: nobody could sign in and
        // `recover-operator` refused, because it resolves an address through
        // the binding. `adopt_first_operator_from_install` answers
        // `Adoption::Nothing` on every deployment that does not have that
        // shape, which is every ADR-0055-native one and every start after an
        // adoption -- and, since 2026-09-21, a NAMED refusal on the shapes
        // that have something to adopt and cannot.
        Err(fathom_server::operators::OperatorError::AlreadyBootstrapped) => {
            use fathom_server::operators::{Adoption, AdoptionRefusal};
            match operators.adopt_first_operator_from_install().await {
                // The ADR-0055-native case, and the only silent one: every
                // operator on this deployment already holds a binding, or the
                // first start has not run yet. Every other shape says
                // something, because "nothing happened" and "nothing needed to
                // happen" looked identical here until 2026-09-21.
                Ok(Adoption::Nothing) => {}
                Ok(Adoption::Adopted(adopted)) => match adopted.invitation {
                    // As the first-start arm above: this invitation is never
                    // handed to anybody (ADR-0057 decision 1 -- no token
                    // file), so it is inert. The setup secret is minted below
                    // from `FATHOM_SETUP_PASSWORD`, once, for every shape
                    // this start might be.
                    Some(_) => {
                        tracing::warn!(
                            operator_id = %adopted.operator_id,
                            notice_address = %adopted.notice_address,
                            retired_keys = adopted.retired_keys,
                            ended_sessions = adopted.ended_sessions,
                            "UPGRADE: the operator created before this build was bound to \
                             the install address. Whether setup is open, and how, is \
                             decided below."
                        );
                    }
                    // ADR-0055 decision 9: the account already holds a
                    // credential and a confirmed authenticator, so there is
                    // nothing to hand anybody. A token here would be a second
                    // bearer secret standing beside a stronger route.
                    //
                    // **The words in the line below are the words on the
                    // screen** (ADR-0056 decision 4, 2026-09-22): the factor is
                    // an authenticator app wherever a person reads it, and an
                    // operator reading this log line at two in the morning is a
                    // person.
                    None => tracing::warn!(
                        operator_id = %adopted.operator_id,
                        notice_address = %adopted.notice_address,
                        retired_keys = adopted.retired_keys,
                        ended_sessions = adopted.ended_sessions,
                        "UPGRADE: the operator created before this build was bound to the \
                         install address, and WHOEVER HOLDS THE ACCOUNT AT THAT ADDRESS NOW \
                         HOLDS THE OPERATOR CUSTODY. No token was written and none is needed: \
                         that account already holds a credential and a confirmed \
                         authenticator, so it signs in with those and registers an operator \
                         key from the \
                         console. Its own sessions were not ended -- only the operator \
                         principal's were -- so a browser already signed in to that account \
                         stays signed in."
                    ),
                },
                // ---- the refusals ------------------------------------------
                //
                // None of these is a reason to take a running site down: the
                // deployment served requests yesterday and will serve them
                // now. Each is said once per start, distinctly, until somebody
                // acts on it.
                Ok(Adoption::Refused(AdoptionRefusal::AccountDisabled {
                    operator_id,
                    account_id,
                    address,
                })) => tracing::error!(
                    operator_id = %operator_id,
                    account_id = %account_id,
                    notice_address = %address,
                    "the account at the install address is disabled, so the operator was not \
                     bound; enable it or restore. Binding it would have been permanent -- a \
                     binding cannot be rewritten at any privilege level -- and the token it \
                     would have minted would redeem into a sign-in that refuses"
                ),
                Ok(Adoption::Refused(AdoptionRefusal::AccountAlreadyBound {
                    operator_id,
                    account_id,
                    address,
                    bound_to,
                })) => tracing::error!(
                    operator_id = %operator_id,
                    already_bound_to_operator_id = %bound_to,
                    account_id = %account_id,
                    notice_address = %address,
                    "the account at the install address already holds the custody of another \
                     operator, so the operator created before this build was not bound: one \
                     account holds one operator custody and a binding cannot be moved. \
                     Whoever is meant to hold this seat needs an account at an address of \
                     their own, or a restore"
                ),
                Ok(Adoption::Refused(AdoptionRefusal::OperatorDisabled {
                    operator_id,
                    address,
                })) => tracing::warn!(
                    operator_id = %operator_id,
                    notice_address = %address,
                    "the operator created before this build is disabled, so it was not bound \
                     to the install address and nobody gained a way in from it. Nothing here \
                     re-enables an operator; if this deployment has no other live operator, \
                     the way back is a restore"
                ),
                Ok(Adoption::Refused(AdoptionRefusal::NoInstallRecord { operators })) => {
                    tracing::warn!(
                        operators,
                        "this deployment has operators and no site_install row, so there is no \
                         notice address to bind one to and nothing was adopted. That row is \
                         written on the first start and no role can rewrite it, so this is a \
                         restore that left it behind"
                    )
                }
                Ok(Adoption::Refused(AdoptionRefusal::SeveralCandidates {
                    operator_ids,
                    address,
                })) => tracing::error!(
                    operator_ids = ?operator_ids,
                    notice_address = %address,
                    "more than one operator has no creator and no binding, so which of them \
                     the install address belongs to is not this server's to guess; none was \
                     bound. Disable the ones that are not the seat, and this start will adopt \
                     the one that is"
                ),
                Err(e) => {
                    tracing::error!(
                        error = ?e,
                        "the operator created before this build could not be bound to the install \
                         address; refusing to start rather than running a deployment nobody can \
                         sign in to"
                    );
                    return ExitCode::from(9);
                }
            }
        }
        Err(e) => {
            tracing::error!(
                error = ?e,
                notice_address_set = config.operator_notice_address.is_some(),
                "could not bootstrap the first operator; refusing to start. On a first start, set FATHOM_OPERATOR_NOTICE_ADDRESS to the address that should receive operator notices."
            );
            return ExitCode::from(9);
        }
    }

    // ---- ADR-0057 decision 1: the setup password, replacing the token file
    //
    // "Every start while setup is pending means the first operator has no
    // stored credential. That covers the first start, the adoption path, and
    // any later start still pending." One check below covers all three,
    // rather than the three separate token writes the arms above used to
    // make: `credentials::CredentialStore::operator_pending_setup` asks the
    // single question that is true in every one of those shapes.
    let credentials_for_setup = fathom_server::credentials::CredentialStore::new(
        pool.clone(),
        Arc::clone(&ring),
        deployment.clone(),
    );
    // A `docker compose restart` does NOT re-read `.env` -- it sends the
    // running container a restart signal and keeps its existing environment
    // (docker/compose `docs/reference/compose_restart.md`, read 2026-09-24).
    // Every message below that asks for `.env` to be edited therefore says
    // what actually re-reads it.
    const REREAD_ENV: &str = "run `docker compose up -d` -- a plain `docker compose restart` \
         does not re-read .env";
    let setup_secret = match &config.setup_password {
        None => {
            tracing::warn!(
                "FATHOM_SETUP_PASSWORD is not set; setup is closed. Set FATHOM_SETUP_PASSWORD \
                 (15+ characters, in single quotes) in .env, then {REREAD_ENV}; setup then stays \
                 open for 30 minutes."
            );
            None
        }
        Some(setup_password) => match fathom_server::credentials::check_password(
            setup_password.expose(),
            &notice_address,
        ) {
            Err(rule) => {
                tracing::warn!(
                    rule = %rule,
                    "FATHOM_SETUP_PASSWORD does not meet the account password policy; setup is \
                     closed. Set FATHOM_SETUP_PASSWORD (15+ characters, in single quotes) in \
                     .env, then {REREAD_ENV}; setup then stays open for 30 minutes."
                );
                None
            }
            Ok(()) => match credentials_for_setup.operator_pending_setup().await {
                Ok(None) => {
                    // Decision 1's own warning: a secret left in `.env` after
                    // it no longer does anything.
                    tracing::warn!(
                        "FATHOM_SETUP_PASSWORD is set, and this deployment's first operator has \
                         already finished setup; remove FATHOM_SETUP_PASSWORD from .env, then \
                         {REREAD_ENV}."
                    );
                    None
                }
                Ok(Some(operator_id)) => match operators.issue_setup_token(&operator_id).await {
                    Ok(invitation) => {
                        // `Instant`, not `SystemTime`: measured against this
                        // process's own monotonic clock, so a wall-clock
                        // step (NTP, a manual change, a leap second) cannot
                        // open or close the window early.
                        let closes_at = std::time::Instant::now()
                            + fathom_server::credentials::SETUP_SECRET_WINDOW;
                        tracing::warn!(
                            operator_id = %operator_id,
                            window_seconds = fathom_server::credentials::SETUP_SECRET_WINDOW
                                .as_secs(),
                            "SETUP IS OPEN for 30 minutes: open this server in a browser and \
                             enter the setup password FATHOM_SETUP_PASSWORD holds in .env. No \
                             token file is written; the password is the only thing to type."
                        );
                        Some(fathom_server::credentials::SetupSecret::new(
                            setup_password.expose(),
                            invitation.token,
                            closes_at,
                        ))
                    }
                    Err(e) => {
                        tracing::error!(
                            error = ?e,
                            operator_id = %operator_id,
                            "could not open setup for the first operator this start; setup is \
                             closed until the next start"
                        );
                        None
                    }
                },
                Err(e) => {
                    tracing::error!(
                        error = ?e,
                        "could not tell whether this deployment's first operator has finished \
                         setup; setup is closed this start"
                    );
                    None
                }
            },
        },
    };

    // ---- the colleagues a pre-ADR-0055 build created (2026-09-21) --------
    //
    // The adoption above binds exactly one operator: the one with no
    // `created_by`, which is the one a first start minted. An operator created
    // through the console by a build before ADR-0055 has a `created_by` and no
    // binding, and decision 1 gives it no way to acquire one -- sign-in
    // resolves the operator custody THROUGH the binding, so that person cannot
    // get in and no act on any surface can give them a route.
    //
    // They still count towards the quorum, because the count asks `disabled_at`
    // and `first_independent_signin_at` and not the binding. That is left
    // exactly as it is -- changing what a second signature means on a live
    // deployment is a decision and not a fix -- and the ids are named here
    // instead, at every start, so an operator can disable them from the
    // console, which is the supported way to make the count right.
    match operators.operators_without_a_binding().await {
        Ok(ids) if ids.is_empty() => {}
        Ok(ids) => tracing::warn!(
            operator_ids = ?ids,
            count = ids.len(),
            "these operators hold no account custody, so nobody can sign in as them: they were \
             created by a build before ADR-0055 and only the first operator can be adopted. \
             They still count towards the operator quorum. Disable them from the console, or \
             the number of signatures this deployment thinks it has is not the number it has"
        ),
        Err(e) => {
            // Not fatal. This is a warning about a shape somebody has to act
            // on by hand; failing to compute it is no reason to refuse a start
            // that everything else has just agreed to.
            tracing::error!(
                error = ?e,
                "could not check for operators with no account custody; the start continues \
                 and this check runs again at the next one"
            )
        }
    }

    // ---- ADR-0055 stream (b): what this start has to say out loud --------
    //
    // §5.3 wanted `single_operator_mode` on the site chain *"at every startup,
    // so nobody can later claim two-person control was in force"*. ADR-0055
    // decision 3 makes it a DERIVED fact, so it is written at every start and
    // not only when a switch was set: an auditor reading the chain sees how
    // many pairs of hands this deployment was running on, and when, without
    // taking any process's environment on trust.
    //
    // **After the bootstrap, not before**: on a first start the register is
    // empty until the block above runs, and an entry saying "zero operators"
    // would be a true statement about a moment nobody cares about.
    let live_operators = match operators.record_single_operator_mode().await {
        Ok(seq) => match operators.live_independent_operators().await {
            Ok(live) => {
                tracing::info!(
                    site_chain_seq = seq,
                    live_independent_operators = live,
                    "the operator quorum for this start was recorded on the site chain"
                );
                live
            }
            Err(e) => {
                tracing::error!(error = ?e, "could not count the operator register; refusing to start");
                return ExitCode::from(9);
            }
        },
        Err(e) => {
            tracing::error!(error = ?e, "could not record the operator quorum; refusing to start");
            return ExitCode::from(9);
        }
    };

    // ADR-0055 decision 4: *"with one live operator the server warns at every
    // start and the console shows a standing banner that escalates weekly. It
    // never blocks work."* This is the first half; `GET /admin/notices` is the
    // second.
    if live_operators < 2 {
        tracing::warn!(
            live_independent_operators = live_operators,
            "THIS DEPLOYMENT HAS ONE OPERATOR who can act. GitHub's own advice, verbatim: 'if \
             an organisation only has one owner, the organisation's projects can become \
             inaccessible if the owner is unreachable.' Add a colleague in the console: one \
             operator may do it alone, and it applies after the 24-hour delay. Until then, the \
             only way back from a lost browser is `fathom-server recover-operator <address>` on \
             this host."
        );
    }

    // ADR-0055 decision 7's last sentence, verbatim: *"Until SMTP is applied,
    // every start logs: 'recovery by mail is unavailable until SMTP is set in
    // the console; until then the only recovery is fathom-server
    // recover-operator'."*
    //
    // The setting is read rather than assumed. A read that FAILS is not
    // treated as "no SMTP": a settings row that does not stand up to its own
    // sealed entry is an incident (`operators::OperatorError::
    // SettingUnresolvable`), and reporting it as a missing form would bury it.
    match operators.effective_setting("smtp").await {
        Ok(None) => tracing::warn!(
            "recovery by mail is unavailable until SMTP is set in the console; until then the \
             only recovery is `fathom-server recover-operator`"
        ),
        Ok(Some(_)) => {}
        Err(e) => tracing::error!(
            error = ?e,
            "the SMTP setting could not be resolved. This is not the same as it being unset: \
             treat it as an incident and read the site chain"
        ),
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

    // ---- ADR-0055 stream (a): the credential routes ----------------------
    //
    // Built before `AdminState` takes `sessions` and `operators` by value, and
    // merged below. Its own state rather than a widened `ApiState`, for the
    // reason `api::CredentialApiState`'s own doc gives.
    let credential_api = fathom_server::api::CredentialApiState {
        sessions: Arc::clone(&sessions),
        // The same store the setup-secret check above already built: one
        // pool, one ring, one deployment id, and no reason for a second copy.
        credentials: Arc::new(credentials_for_setup),
        operators: Arc::clone(&operators),
        setup_secret,
        client_address: client_address.clone(),
    };

    // ---- ADR-0057 decision 5: the organisation claim ----------------------
    // Built before `AdminState` takes `operators` by value.
    let claim_api = fathom_server::api::ClaimApiState {
        sessions: Arc::clone(&sessions),
        operators: Arc::clone(&operators),
        client_address: client_address.clone(),
    };

    let admin = fathom_server::admin::AdminState {
        // ADR-0055 stream (c): cloned rather than moved -- the placement
        // router beside this one needs the same session store.
        sessions: Arc::clone(&sessions),
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
    // ADR-0055 stream (c): the policy now reads the console's own placement as
    // well as the two environment variables, so the gate is ALWAYS mounted --
    // a placement can be written at any moment from the console, and a layer
    // that was not mounted at startup cannot start enforcing one.
    let exposure = exposure.with_placement(placement.view());
    if exposure.environment_wins() {
        tracing::info!(
            hosts = ?exposure.hosts(),
            sources = ?config.admin_sources,
            "the operator console answers only on these hosts and from these addresses; \
             elsewhere its paths are 404. FATHOM_ADMIN_HOSTS/FATHOM_ADMIN_SOURCES win over any \
             placement set in the console, and the console's form is read-only"
        );
    } else if exposure.confines() {
        tracing::info!(
            "the operator console answers only where its placement says (set in the console \
             itself, ADR-0055 decision 11); elsewhere its paths are 404"
        );
    } else {
        tracing::warn!(
            "the operator console (/admin, /enrolment/operator) answers on every host and from \
             every address; set FATHOM_ADMIN_HOSTS and/or FATHOM_ADMIN_SOURCES, or move it from \
             the console itself, to confine it"
        );
    }
    let admin_router = fathom_server::admin::router(admin)
        // ADR-0055 stream (c): `POST /admin/placement`, merged INSIDE the same
        // gate -- moving the console is a console act.
        .merge(fathom_server::placement::router(
            fathom_server::placement::PlacementState {
                sessions: Arc::clone(&sessions),
                placement: Arc::clone(&placement),
            },
        ))
        // The confirmation and the sweep: the first verified `/admin` request
        // on the new host inside the window confirms the placement, and an
        // expired window writes its sealed revert here.
        .layer(axum::middleware::from_fn_with_state(
            Arc::clone(&placement),
            fathom_server::placement::confirm_on_the_new_host,
        ))
        .layer(axum::middleware::from_fn_with_state(
            exposure.clone(),
            fathom_server::admin_exposure::gate,
        ));
    let mut app = fathom_server::router_with_placement(
        AppState { health, engine },
        // The same policy the console's own gate uses, so the flag and the
        // 404 can never disagree.
        exposure,
    )
    .merge(fathom_server::api::router(api))
    // ADR-0055 stream (a). Account-plane, on every host, exactly like
    // `/session` — deliberately NOT inside `admin_router` and so not behind
    // `admin_exposure`, per the lead's resolution 8.
    .merge(fathom_server::api::credential_router(credential_api))
    // ADR-0057 decision 5. Account-plane, on every host, for the same reason
    // the credential routes are.
    .merge(fathom_server::api::claim_router(claim_api))
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
    // ADR-0055 stream (c) -- decision 12's two headers, over EVERYTHING
    // including the fallback that serves the client's own files.
    let app = app.layer(axum::middleware::from_fn_with_state(
        fathom_server::client::SecurityHeaders::new(client_address.clone()),
        fathom_server::client::security_headers,
    ));
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await;

    // ADR-0055 fix (b): the placement refresher outlives nothing. Stopped
    // here so a shutdown does not leave a task holding a pooled connection.
    placement_refresher.abort();

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

/// **`fathom-server recover-operator <address>`** — ADR-0055 decision 8's
/// break-glass, and the one command in this binary that mints a bearer secret
/// with no session behind it.
///
/// Read `operators::OperatorStore::recover_operator` before changing anything
/// here: that function carries the whole argument for why a host command that
/// works AFTER an operator key exists is not a backdoor, and what it still
/// refuses (it mints no operator; an unknown address writes nothing).
///
/// What this function adds around it:
///
/// - **The code goes to stdout, and nowhere else.** Not the log, not a file,
///   not an error message. It is read off the terminal by the person who just
///   typed the command and it dies in ten minutes
///   (`operators::RECOVERY_SETUP_TOKEN_LIFETIME`). The log line names the
///   operator, the expiry and the site-chain `seq` — everything an operator
///   needs and nothing an attacker holding the logs can use. The first start's
///   own token still goes to a FILE, because at that moment there is no
///   terminal: a container wrote it.
/// - **The key material is loaded but never created.** The server's own
///   startup passes `create_if_missing: true`; this passes `false`, because a
///   chain key invented here would make every entry ever sealed under the real
///   one unverifiable, and the symptom would read as tampering.
/// - **`reissue-bootstrap-token` is an alias** (ADR-0055 decision 8: *"it
///   folds into it"*). It takes an optional address and falls back to
///   `FATHOM_OPERATOR_NOTICE_ADDRESS`, prints a deprecation line, and is
///   otherwise this same function. Kept because it is in
///   `docs/OPERATING.md`'s drill and in operators' shell history.
async fn recover_operator(address: &str, called_as_reissue: bool) -> ExitCode {
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
    if config.single_operator {
        eprintln!("fathom-server: {RETIRED_SINGLE_OPERATOR}");
        return ExitCode::from(2);
    }

    // **The log goes to stderr here, and only here.** Everywhere else in this
    // binary the subscriber writes to stdout, which is what a container
    // runtime collects. This subcommand prints ONE secret to stdout -- the
    // setup code -- and a deployment that ships its logs off the box
    // (`audit.rs`) must not ship that code with them. Two streams, two
    // audiences: `fathom-server recover-operator a@b > code` is a working
    // sentence, and the log still lands wherever logs land.
    tracing_subscriber::fmt()
        .with_max_level(config.log_level.to_tracing())
        .with_ansi(false)
        .with_target(true)
        .with_writer(std::io::stderr)
        .init();

    if called_as_reissue {
        tracing::warn!(
            "`reissue-bootstrap-token` is deprecated and is now an alias for \
             `recover-operator <address>` (ADR-0055 decision 8). It no longer refuses once an \
             operator key is enrolled, it takes an address, and it prints the code to stdout \
             instead of writing a file. Use the new name."
        );
    }

    tracing::info!(
        database = %config.database_for_logging(),
        "recovering an operator from the host. This is a loud act: it appends a sealed \
         `operator_recovered_from_host` entry and banners every operator session for seven days"
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
                "this deployment has no identity, so it has never started and has no operator \
                 to recover. Start the server once"
            );
            return ExitCode::from(12);
        }
    };
    drop(client);

    let operators =
        fathom_server::operators::OperatorStore::new(pool.clone(), Arc::clone(&ring), deployment);

    let recovered = match operators.recover_operator(address).await {
        Ok(r) => r,
        Err(fathom_server::operators::OperatorError::NotFound(_)) => {
            // **Nothing was written.** Said plainly, because the whole line
            // decision 8 draws is that recovery restores a seat somebody
            // already held and never creates one.
            tracing::error!(
                "no operator is bound to that address, so nothing was recovered and nothing \
                 was minted -- not an account, not an operator, not a code. Check the address \
                 against `GET /admin/operators`, or bootstrap a deployment that has none. An \
                 operator created by a build before ADR-0055 is bound on the first start of \
                 this build; start the server once, then run this again"
            );
            return ExitCode::from(9);
        }
        Err(e) => {
            tracing::error!(error = %e, "no code was issued");
            return ExitCode::from(9);
        }
    };

    // stdout, and only here. `println!` rather than `tracing`, so that a
    // deployment shipping its logs off the box (`audit.rs`) does not ship the
    // one bearer secret this command exists to hand to a human.
    let mut code = String::with_capacity(69);
    code.push_str(fathom_server::operators::BOOTSTRAP_TOKEN_PREFIX);
    for byte in &recovered.invitation.token {
        code.push_str(&format!("{byte:02x}"));
    }
    println!("{code}");

    tracing::warn!(
        operator_id = %recovered.operator_id,
        expires_at_unix = recovered.invitation.expires_at_unix,
        site_chain_seq = recovered.issued_seq,
        expired_tokens = recovered.expired.len(),
        "a one-shot setup code was printed to stdout and is NOT in this log. It is good for ten \
         minutes. Any previously issued and unredeemed setup or operator token for this \
         operator is now dead. Every operator session banners this recovery for seven days"
    );
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// ADR-0055 stream (c) -- `fathom-server console-placement --reset`
// ---------------------------------------------------------------------------

/// **The way back in when a placement locked everyone out of the console** --
/// ADR-0055 decision 11's last sentence, for the case where the window WAS
/// confirmed and the host later died, so confirm-or-revert has nothing left to
/// revert to.
///
/// Run on the host, where the key volume is mounted, exactly as
/// `reissue-bootstrap-token` is: it clears every live placement, writes a
/// sealed `console_placement_reverted` entry for each (`revert_reason =
/// 'host_reset'`), and leaves the console answering wherever
/// `FATHOM_ADMIN_HOSTS`/`FATHOM_ADMIN_SOURCES` say, or everywhere if they say
/// nothing -- on a RUNNING server within `placement::SNAPSHOT_TTL`, because
/// the serving process holds its own snapshot and this command runs in a
/// second process. It is loud on purpose: ADR-0043 §2 already puts the host inside
/// tier 3, so what protects this is custody of the host plus the record that
/// it happened -- the same argument decision 8 makes for `recover-operator`.
///
/// It mints nothing, it grants nobody anything, and the next operator sign-in
/// is still a sign-in.
async fn reset_console_placement() -> ExitCode {
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
    // The same gate the server refuses to start without: this writes rows and
    // appends to the site chain through the runtime role, and a superuser
    // connection would have every isolation policy inert underneath it.
    if let Err(e) = rls::assert_rls_binds(&client).await {
        tracing::error!(error = %e, "refusing");
        return ExitCode::from(8);
    }
    // `false`: load the keys, never create them -- a chain key invented here
    // would make every entry sealed under the real one unverifiable.
    let ring = match keys::KeyRing::load(&config.master_key, &config.chain_key, false) {
        Ok(r) => Arc::new(r),
        Err(e) => {
            tracing::error!(
                error = %e,
                "refusing: the key material could not be loaded. This command seals a site-chain \
                 entry like every other operator act"
            );
            return ExitCode::from(10);
        }
    };
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
                "this deployment has no identity, so it has never started and has no console \
                 placement to clear. Start the server once"
            );
            return ExitCode::from(12);
        }
    };
    drop(client);

    let placement =
        fathom_server::placement::PlacementStore::new(pool.clone(), Arc::clone(&ring), deployment);
    match placement.reset_from_host().await {
        Ok(0) => {
            tracing::warn!(
                "no console placement was in force; nothing to clear. The console answers \
                 wherever FATHOM_ADMIN_HOSTS / FATHOM_ADMIN_SOURCES say, or everywhere if they \
                 are unset"
            );
            ExitCode::SUCCESS
        }
        Ok(cleared) => {
            // ADR-0055 fix (b): this sentence used to say the console
            // answered everywhere AS OF THIS COMMAND, which was false -- a
            // running server held its own snapshot and kept enforcing the
            // dead placement until it was restarted. It now says what is
            // true, and the server re-reads on `placement::SNAPSHOT_TTL`.
            tracing::warn!(
                cleared,
                takes_effect_within_seconds = fathom_server::placement::SNAPSHOT_TTL.as_secs(),
                "the console placement was cleared FROM THE HOST and the act is on the site \
                 chain. A running server picks this up within the seconds named above, \
                 without a restart; after that the console answers wherever \
                 FATHOM_ADMIN_HOSTS / FATHOM_ADMIN_SOURCES say, or everywhere if they are \
                 unset. Set it again from the console as soon as there is somewhere to set \
                 it to"
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            tracing::error!(error = ?e, "the console placement was NOT cleared");
            ExitCode::from(9)
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
