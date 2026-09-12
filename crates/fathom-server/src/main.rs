//! The binary. See `lib.rs` for what this server is and is not.

use std::process::ExitCode;
use std::sync::Arc;

use fathom_server::config::Config;
use fathom_server::engine::EngineState;
use fathom_server::health::HealthState;
use fathom_server::{db, keys, log_startup, migrate, rls, router, AppState};

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
    if !args.is_empty() {
        eprintln!(
            "fathom-server: the only subcommand is `healthcheck [--addr HOST:PORT]`;              with no arguments it runs the server"
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
    // unconditionally. Found 2026-09-12: the shipped `deploy/compose.yaml`
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
    let ring = match keys::KeyRing::load(&config.master_key, &config.chain_key, true) {
        Ok(r) => r,
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

    let served = axum::serve(listener, router(AppState { health, engine }))
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
