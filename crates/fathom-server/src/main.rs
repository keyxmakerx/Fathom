//! The binary. See `lib.rs` for what this server is and is not.

use std::process::ExitCode;
use std::sync::Arc;

use fathom_server::config::Config;
use fathom_server::health::HealthState;
use fathom_server::{db, log_startup, migrate, router};

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

    let pool = match db::pool(&config) {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(error = %e, "could not build the connection pool");
            return ExitCode::from(3);
        }
    };

    // Migrations before the listener binds. A server that accepts requests
    // while its schema is half-applied is a server answering from a state
    // nobody designed.
    match pool.get().await {
        Ok(mut client) => match migrate::run(&mut client).await {
            Ok(0) => tracing::info!("schema is up to date"),
            Ok(n) => tracing::info!(applied = n, "migrations applied"),
            Err(e) => {
                tracing::error!(error = %e, "migrations failed");
                return ExitCode::from(4);
            }
        },
        Err(e) => {
            // deadpool's error Display does not carry the password (the pool
            // was built from parsed parts, not the URL), but it is not this
            // binary's guarantee to make, so it is summarised rather than
            // printed whole.
            tracing::error!(kind = %summarise(&e), "could not reach the database at startup");
            return ExitCode::from(5);
        }
    }

    let state = Arc::new(HealthState {
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

    let served = axum::serve(listener, router(state))
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
