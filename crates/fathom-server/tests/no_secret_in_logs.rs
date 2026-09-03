//! WO-11 §6 **G6 — no secret reaches a log.**
//!
//! > *"A test sets a configuration value containing a recognisable token and
//! > asserts it appears in no log line at any level, including on the error
//! > paths."*
//!
//! The canary is a distinctive string used as the database password. Every
//! logging and formatting path this binary has is driven at `TRACE` — the most
//! verbose level, because a leak that only appears at `debug` is still a leak —
//! and the captured bytes are searched for it.
//!
//! **The test drives the real functions**, not copies of the log statements.
//! `fathom_server::log_startup` exists as a library function for that reason: a
//! test that re-types the line it is checking proves the copy is safe, which is
//! not the claim anyone wants.

use std::io;
use std::sync::{Arc, Mutex};

use fathom_server::config::Config;
use fathom_server::db;
use fathom_server::health::Unhealthy;
use fathom_server::secret::{redact_database_url, Secret};

/// A password no other string in the tree could plausibly contain.
const CANARY: &str = "K4NaRY-pa55w0rd-do-not-log-me";

/// A `MakeWriter` over a shared buffer, so the test can read what was logged.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

impl io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Run `f` with everything it logs captured, at the most verbose level.
fn captured(f: impl FnOnce()) -> String {
    let cap = Capture::default();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(cap.clone())
        .finish();
    tracing::subscriber::with_default(subscriber, f);
    cap.text()
}

fn config_with_canary() -> Config {
    let url = format!("postgres://fathom:{CANARY}@db.internal:5432/fathom");
    Config::from_lookup(move |k| match k {
        "DATABASE_URL" => Some(url.clone()),
        "FATHOM_LOG" => Some("trace".to_string()),
        _ => None,
    })
    .unwrap()
}

fn assert_clean(where_: &str, text: &str) {
    assert!(
        !text.contains(CANARY),
        "the canary password appeared in {where_}:\n{text}"
    );
}

#[test]
fn the_startup_line_names_the_host_and_not_the_password() {
    let config = config_with_canary();
    let logged = captured(|| fathom_server::log_startup(&config));
    assert_clean("the startup log line", &logged);
    // ...and it is not clean by being empty. An operator must still learn WHICH
    // database the server is talking to.
    assert!(logged.contains("db.internal"), "{logged}");
    assert!(logged.contains("5432"), "{logged}");
}

#[test]
fn every_formatting_path_on_the_config_refuses() {
    let config = config_with_canary();
    for rendered in [
        format!("{config:?}"),
        format!("{config:#?}"),
        format!("{:?}", config.database_url),
        format!("{}", config.database_url),
        config.database_for_logging(),
    ] {
        assert_clean("a formatted Config", &rendered);
    }
}

#[test]
fn logging_the_config_at_every_level_refuses() {
    let config = config_with_canary();
    let logged = captured(|| {
        tracing::error!(?config, "error path");
        tracing::warn!(?config, "warn path");
        tracing::info!(?config, "info path");
        tracing::debug!(?config, "debug path");
        tracing::trace!(?config, "trace path");
        // The shape that actually happens: someone formats the struct into the
        // message rather than as a field.
        tracing::error!("bad configuration: {config:?}");
    });
    assert_clean("a log line at some level", &logged);
    assert!(logged.contains("error path"), "nothing was captured");
}

#[test]
fn the_error_paths_refuse_too() {
    // A ConfigError raised while a canary is in the environment.
    let url = format!("postgres://fathom:{CANARY}@db/fathom");
    let err = Config::from_lookup(move |k| match k {
        "DATABASE_URL" => Some(url.clone()),
        "FATHOM_LOG" => Some(format!("{CANARY}-is-not-a-level")),
        _ => None,
    })
    .unwrap_err();
    let logged = captured(|| {
        tracing::error!(?err, "config error as a field");
        tracing::error!(error = %err, "config error as Display");
    });
    assert_clean("a ConfigError log line", &logged);

    // A DbError raised from a URL carrying the canary.
    let bad =
        Config::from_lookup(|k| (k == "DATABASE_URL").then(|| format!("postgres://u:{CANARY}@")))
            .unwrap();
    let db_err = db::pool(&bad).unwrap_err();
    let logged = captured(|| {
        tracing::error!(?db_err, "db error as a field");
        tracing::error!(error = %db_err, "db error as Display");
    });
    assert_clean("a DbError log line", &logged);
}

#[test]
fn the_health_failure_reasons_carry_nothing_from_the_environment() {
    let logged = captured(|| {
        for why in [
            Unhealthy::NoConnection,
            Unhealthy::QueryFailed,
            Unhealthy::WrongAnswer,
        ] {
            tracing::warn!(reason = why.reason(), "health check failed");
            tracing::warn!(?why, "health check failed, as a field");
        }
    });
    assert_clean("a health log line", &logged);
    for marker in ["://", "@", "password"] {
        assert!(
            !logged.contains(marker),
            "a health line contains {marker}:\n{logged}"
        );
    }
}

#[test]
fn the_redactor_fails_safe_rather_than_guessing() {
    // A redactor that emits its input when confused is worse than none,
    // because it looks like one. Anything unparseable comes back fully
    // redacted — including a string that happens to contain a password.
    for weird in [
        // No scheme at all.
        CANARY.to_string(),
        format!("no-scheme:{CANARY}"),
        // THE TYPO THAT MADE THE REDACTOR STRICTER: the `@` left out, so the
        // password sits where a host would. The first cut printed it.
        format!("postgres://fathom:{CANARY}"),
        format!("postgres://fathom:{CANARY}/fathom"),
        // Userinfo present but no host to attach it to.
        format!("postgres://fathom:{CANARY}@"),
        // In a query parameter, which is a real libpq form.
        format!("postgres://u@db/fathom?password={CANARY}"),
    ] {
        assert_clean("the redactor's output", &redact_database_url(&weird));
    }

    // ONE SHAPE IT CANNOT CATCH, asserted so the limit is recorded rather than
    // assumed away: a password spelled like a hostname, in host position, is
    // indistinguishable from a hostname. `postgres://hunter2` names a host
    // called `hunter2`. The answer to that is `Secret` -- never having the
    // value where the mistake would print it -- not a cleverer parser.
    let host_shaped = format!("postgres://{CANARY}/fathom");
    assert!(redact_database_url(&host_shaped).contains(CANARY));
}

#[test]
fn a_secret_inside_an_arbitrary_struct_still_refuses() {
    #[derive(Debug)]
    struct Anything {
        #[allow(dead_code)]
        note: &'static str,
        #[allow(dead_code)]
        value: Secret<String>,
    }
    let a = Anything {
        note: "visible",
        value: Secret::new(CANARY.to_string()),
    };
    let logged = captured(|| tracing::error!(?a, "arbitrary struct"));
    assert_clean("an arbitrary struct's Debug", &logged);
    assert!(logged.contains("visible"), "{logged}");
}
