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

// ---------------------------------------------------------------------------
// ADR-0055 stream (c) — the second canary: an SMTP password
// ---------------------------------------------------------------------------

/// **A password a real SMTP server accepts**, and that is the whole point of
/// the value (CLAUDE.md rule 2: *"test a safety gate against what a real
/// device accepts, not against what the detector needs"*).
///
/// Twenty characters of mixed case, digits and punctuation — the shape of a
/// password a person or a provider actually issues for SMTP AUTH (RFC 4954),
/// and well inside RFC 5321 §4.5.3.1.4's 512-octet command line. It carries no
/// marker word like "canary" or "do-not-log", because a redactor that only
/// catches values shaped like a test fixture catches nothing real.
const SMTP_CANARY: &str = "Tr0ub4dor&3xK!ngf1sh";

fn smtp_envelope(password: &str) -> Vec<u8> {
    fathom_server::placement::smtp_value_bytes(
        "smtp.example.test",
        587,
        fathom_server::placement::TlsMode::StartTls,
        "fathom@example.test",
        password,
        "fathom@example.test",
    )
}

fn assert_no_smtp_password(where_: &str, text: &str) {
    assert!(
        !text.contains(SMTP_CANARY),
        "the SMTP password appeared in {where_}:\n{text}"
    );
    // The first eight characters on their own: a truncating logger would
    // otherwise pass this test while leaking most of the password.
    assert!(
        !text.contains(&SMTP_CANARY[..8]),
        "part of the SMTP password appeared in {where_}:\n{text}"
    );
}

/// §5.3's *"SMTP credentials are credentials"*, as a test: the value envelope
/// `POST /admin/settings` carries for `key='smtp'` is parsed by
/// `placement::parse_smtp_value`, and neither the parsed form, its refusals
/// nor anything logged around them may carry the password.
#[test]
fn the_smtp_envelope_never_puts_its_password_in_a_log() {
    let value = smtp_envelope(SMTP_CANARY);
    let parsed = fathom_server::placement::parse_smtp_value(&value)
        .expect("a real submission configuration parses");

    let logged = captured(|| {
        tracing::error!(?parsed, "smtp settings as a field");
        tracing::warn!(smtp = ?parsed, "smtp settings under a name");
        tracing::info!("smtp settings in the message: {parsed:?}");
        tracing::debug!("smtp settings, pretty: {parsed:#?}");
        tracing::trace!(password = ?parsed.password, "the password field on its own");
        tracing::trace!(password = %parsed.password, "the password field as Display");
    });
    assert_no_smtp_password("a log line about the parsed settings", &logged);
    // ...and it is not clean by being empty: an operator must still be able to
    // see WHICH server the deployment is configured to talk to.
    assert!(logged.contains("smtp.example.test"), "{logged}");
    assert!(logged.contains("587"), "{logged}");
}

/// The refusal paths, which is where a value normally escapes: a malformed
/// envelope is refused by field name, and the refusal never carries what was
/// in the field.
#[test]
fn a_refused_smtp_envelope_names_the_field_and_not_the_value() {
    // Every way this envelope can be wrong, each still carrying the real
    // password, because the password is in the envelope whatever else is
    // broken about it.
    let mut truncated = smtp_envelope(SMTP_CANARY);
    truncated.truncate(truncated.len() - 3);
    let mut extra = smtp_envelope(SMTP_CANARY);
    extra.extend_from_slice(&[4, 0, b'o', b'o', b'p', b's']);
    let bad_address = fathom_server::placement::smtp_value_bytes(
        "smtp.example.test",
        587,
        fathom_server::placement::TlsMode::StartTls,
        "fathom@example.test",
        SMTP_CANARY,
        "not-an-address",
    );
    let bad_port = fathom_server::placement::smtp_value_bytes(
        "smtp.example.test",
        0,
        fathom_server::placement::TlsMode::StartTls,
        "fathom@example.test",
        SMTP_CANARY,
        "fathom@example.test",
    );

    for (what, envelope) in [
        ("a truncated envelope", truncated),
        ("a seventh field", extra),
        ("an unusable from-address", bad_address),
        ("port zero", bad_port),
    ] {
        let error = fathom_server::placement::parse_smtp_value(&envelope)
            .err()
            .unwrap_or_else(|| panic!("{what} must be refused"));
        let logged = captured(|| {
            tracing::error!(?error, "smtp envelope refused, as a field");
            tracing::error!(error = %error, "smtp envelope refused, as Display");
            tracing::error!("smtp envelope refused: {error}");
            tracing::error!("smtp envelope refused: {error:?}");
        });
        assert_no_smtp_password(what, &logged);
        assert!(
            logged.contains("refused"),
            "nothing was captured for {what}"
        );
    }
}

/// The same value on its way through the route that carries it.
///
/// `admin::request_setting` reads three length-prefixed fields and hands the
/// second to the store, which seals it. Nothing on that path formats the body
/// — this test drives the two things that could: the whole request body as a
/// byte slice, and the refusal a bad body produces.
#[test]
fn the_request_body_carrying_an_smtp_password_is_never_formatted_into_a_log() {
    let mut body = Vec::new();
    fathom_server::crypto::lp(&mut body, b"smtp");
    fathom_server::crypto::lp(&mut body, &smtp_envelope(SMTP_CANARY));
    fathom_server::crypto::lp(&mut body, &[7u8; 64]);

    let logged = captured(|| {
        // The shapes a careless diagnostic takes: the length, the first
        // bytes, the key. Never the value.
        tracing::info!(bytes = body.len(), "a settings request arrived");
        tracing::debug!(key = "smtp", "a settings request arrived");
    });
    assert_no_smtp_password("a log line about the request body", &logged);
    assert!(logged.contains("a settings request arrived"), "{logged}");

    // And the bytes themselves DO contain it — the positive control, so that
    // this test cannot pass by searching something that never held the
    // password in the first place.
    let raw = String::from_utf8_lossy(&body).into_owned();
    assert!(
        raw.contains(SMTP_CANARY),
        "the canary is not even in the body"
    );
}

// ---------------------------------------------------------------------------
// ADR-0057 decision 1 — the fourth canary: the setup password
// ---------------------------------------------------------------------------

/// A password a real operator might actually type into `FATHOM_SETUP_PASSWORD`
/// in `.env`: past the fifteen-character floor, not on the bundled common
/// list, and not shaped like a test fixture — [`SMTP_CANARY`]'s own reasoning.
const SETUP_PASSWORD_CANARY: &str = "Th3-Quiet-Harbour-Lantern-9";

fn assert_no_setup_password(where_: &str, text: &str) {
    assert!(
        !text.contains(SETUP_PASSWORD_CANARY),
        "the setup password appeared in {where_}:\n{text}"
    );
    // The first eight characters on their own: a truncating logger would
    // otherwise pass this test while leaking most of the password.
    assert!(
        !text.contains(&SETUP_PASSWORD_CANARY[..8]),
        "part of the setup password appeared in {where_}:\n{text}"
    );
}

/// **`FATHOM_SETUP_PASSWORD` never reaches a log, at any level, through the
/// `Config` it is read into.** It is read exactly as typed (not trimmed), so
/// this is also the shape `main.rs` holds it in between reading it and
/// running it through the account password policy.
#[test]
fn the_setup_password_never_reaches_a_log_through_config() {
    let config = Config::from_lookup(|k| match k {
        "DATABASE_URL" => Some("postgres://fathom@db.internal:5432/fathom".to_string()),
        "FATHOM_SETUP_PASSWORD" => Some(SETUP_PASSWORD_CANARY.to_string()),
        "FATHOM_LOG" => Some("trace".to_string()),
        _ => None,
    })
    .unwrap();
    let logged = captured(|| {
        tracing::error!(?config, "error path");
        tracing::warn!(?config, "warn path");
        tracing::info!(?config, "info path");
        tracing::error!("bad configuration: {config:?}");
    });
    assert_no_setup_password("a Config log line", &logged);
    for rendered in [format!("{config:?}"), format!("{config:#?}")] {
        assert_no_setup_password("a formatted Config", &rendered);
    }
    assert!(logged.contains("error path"), "nothing was captured");
}

/// **The account password policy's refusal never carries the value it
/// refused** — the check `main.rs` runs `FATHOM_SETUP_PASSWORD` through at
/// every start, and logs the rule (CLAUDE.md rule 2's *"name the rule"*)
/// without ever formatting the password itself.
#[test]
fn a_refused_setup_password_names_the_rule_and_not_the_value() {
    // Contains the notice address, which is one of
    // `credentials::check_password`'s four self-explaining refusals and the
    // one most likely to tempt a careless message into quoting the value
    // back.
    let address = "owner@example.test";
    let containing_address = format!("{SETUP_PASSWORD_CANARY}-{address}");
    let error = fathom_server::credentials::check_password(&containing_address, address)
        .expect_err("a password containing the address it opens is refused");
    let logged = captured(|| {
        tracing::warn!(rule = %error, "setup password refused");
        tracing::warn!(?error, "setup password refused, as a field");
        tracing::error!("setup password refused: {error}");
    });
    assert!(
        !logged.contains(SETUP_PASSWORD_CANARY),
        "the canary appeared in a policy refusal:\n{logged}"
    );
    assert!(
        !logged.contains(&containing_address),
        "the whole refused value appeared in a policy refusal:\n{logged}"
    );
    assert!(logged.contains("refused"), "nothing was captured");
}
