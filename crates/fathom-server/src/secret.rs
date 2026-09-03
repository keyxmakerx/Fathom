//! A value that must never reach a log line.
//!
//! **This is the mechanism behind WO-11 §6 G6**, and it is the same shape as
//! invariant 3 on the client: the protection is *not having the value where the
//! mistake would print it*.
//!
//! The realistic way a database password reaches a log is not carelessness. It
//! is an error path formatting the thing it failed to parse — `tracing::error!(?config,
//! "bad configuration")`, `{:?}` on a struct, a panic message, an `anyhow`
//! chain. Every one of those goes through [`Debug`] or [`Display`], so
//! [`Secret`] implements both to print a fixed string and nothing else.
//!
//! What it does NOT do, stated so nobody mistakes it for more: it is not
//! encryption, it does not zero memory, and it cannot stop
//! `secret.expose()` being written deliberately. It stops the ACCIDENT, which
//! is the failure that actually happens.

use core::fmt;

/// What every formatting impl prints instead of the value.
pub const REDACTED: &str = "<redacted>";

/// A wrapper whose [`Debug`] and [`Display`] refuse to print the value.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret<T>(T);

impl<T> Secret<T> {
    /// Wrap a value.
    pub fn new(value: T) -> Self {
        Self(value)
    }

    /// Read the value. **Deliberately verbose**: `expose` in a diff is a thing
    /// a reviewer can look for, which `as_str` would not be.
    pub fn expose(&self) -> &T {
        &self.0
    }

    /// Take the value out, consuming the wrapper.
    pub fn into_exposed(self) -> T {
        self.0
    }
}

impl<T> fmt::Debug for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

impl<T> fmt::Display for Secret<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

/// A PostgreSQL connection URL with its password removed, safe to log.
///
/// An operator debugging a failed connection needs to know **which** database
/// was unreachable, and refusing to say anything is its own kind of unhelpful.
/// So this keeps the scheme, the user, the host, the port and the database name
/// and destroys the password.
///
/// **It fails safe.** Anything it cannot parse confidently comes back as
/// `REDACTED` in full rather than as a best guess — a redactor that emits the
/// input when it is confused is worse than no redactor, because it looks like
/// one.
///
/// # The case that made this stricter than it started
///
/// The first cut split userinfo off at `@` and emitted whatever was left as the
/// host. `no_secret_in_logs.rs` then produced `postgres://user:PASSWORD` — a
/// URL with the `@` **missing**, which is an ordinary typo — and the redactor
/// printed the password, because with no `@` there is no userinfo and the whole
/// thing looks like a host.
///
/// So what is emitted is now validated as well as parsed: after the userinfo is
/// removed, what remains must LOOK LIKE a host — a socket path, an IPv6
/// literal in brackets, or a name of host characters with an optional numeric
/// port. Anything else is refused in full.
///
/// **What this still cannot do**, stated so nobody reads it as more: a password
/// that happens to be spelled like a hostname, in host position, is
/// indistinguishable from a hostname. `postgres://hunter2` emits `hunter2`. The
/// answer to that is [`Secret`] — never having the value where the mistake
/// would print it — not a cleverer parser.
pub fn redact_database_url(url: &str) -> String {
    // scheme://[user[:password]@]host[:port][/db][?params]
    let Some((scheme, rest)) = url.split_once("://") else {
        return REDACTED.to_string();
    };
    if scheme.is_empty() || rest.is_empty() {
        return REDACTED.to_string();
    }

    // The authority ends at the first '/', '?' or '#'. Everything before the
    // LAST '@' inside it is userinfo — last, not first, because a password may
    // legally contain an '@' once percent-decoded and we would rather cut too
    // much than too little.
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);

    let cleaned = match authority.rfind('@') {
        None => authority.to_string(),
        Some(at) => {
            let (userinfo, host) = authority.split_at(at);
            let host = &host[1..];
            // `postgres://user@/var/run/postgresql/fathom` is the local-socket
            // form: the authority ends at the first `/` so the host is empty
            // and the socket directory is the path. Legitimate, and only when a
            // path actually follows -- `postgres://u:p@` with nothing after it
            // is a truncated URL and gets refused below.
            if host.is_empty() && !tail.starts_with('/') {
                return REDACTED.to_string();
            }
            match userinfo.split_once(':') {
                // A password was present: name the user, destroy the rest.
                Some((user, _password)) if !user.is_empty() => {
                    format!("{user}:{REDACTED}@{host}")
                }
                // `:password@host` with no user, or an empty user.
                Some(_) => format!("{REDACTED}@{host}"),
                // No colon, so no password to remove.
                None => format!("{userinfo}@{host}"),
            }
        }
    };

    // Whatever is left where a host should be must look like one. This is what
    // catches `postgres://user:PASSWORD` with the `@` missing: `PASSWORD` ends
    // up in the port position, is not digits, and the whole string is refused.
    let host_part = match cleaned.rfind('@') {
        Some(at) => &cleaned[at + 1..],
        None => &cleaned[..],
    };
    // An empty host is only allowed in the local-socket form checked above,
    // where the path carries the socket directory.
    let local_socket = host_part.is_empty() && tail.starts_with('/');
    if !local_socket && !looks_like_host(host_part) {
        return REDACTED.to_string();
    }

    // Query parameters can carry a password too (`?password=...`), and picking
    // them apart is a second parser. Drop them wholesale.
    let tail = match tail.find(['?', '#']) {
        Some(i) => &tail[..i],
        None => tail,
    };

    format!("{scheme}://{cleaned}{tail}")
}

/// Does this look like a host — or a host and port, or a socket path?
///
/// Deliberately strict. The cost of refusing a legitimate host is one log line
/// saying `<redacted>` instead of a name; the cost of accepting a password is a
/// password in a log.
fn looks_like_host(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    // A Unix socket path, which is how `43` §5.4 connects.
    if s.starts_with('/') {
        return !s.contains(char::is_whitespace);
    }
    // An IPv6 literal, optionally with a port: `[::1]` or `[::1]:5432`.
    if let Some(rest) = s.strip_prefix('[') {
        let Some((addr, tail)) = rest.split_once(']') else {
            return false;
        };
        if addr.is_empty()
            || !addr
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.')
        {
            return false;
        }
        return tail.is_empty() || is_port(tail.strip_prefix(':').unwrap_or("x"));
    }
    // A name or an IPv4 address, optionally with a port.
    let (name, port) = match s.split_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (s, None),
    };
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return false;
    }
    match port {
        None => true,
        Some(p) => is_port(p),
    }
}

fn is_port(s: &str) -> bool {
    !s.is_empty() && s.len() <= 5 && s.chars().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_and_display_refuse() {
        let s = Secret::new("hunter2");
        assert_eq!(format!("{s:?}"), REDACTED);
        assert_eq!(format!("{s}"), REDACTED);
        assert_eq!(format!("{s:#?}"), REDACTED);
        // The width and precision forms go through the same impl.
        assert_eq!(format!("{s:>40?}"), REDACTED);
    }

    #[test]
    fn a_struct_holding_one_does_not_leak_it_either() {
        #[derive(Debug)]
        struct Config {
            #[allow(dead_code)]
            host: String,
            #[allow(dead_code)]
            password: Secret<String>,
        }
        let c = Config {
            host: "db.internal".into(),
            password: Secret::new("hunter2".to_string()),
        };
        let rendered = format!("{c:?}");
        assert!(!rendered.contains("hunter2"), "{rendered}");
        assert!(rendered.contains("db.internal"));
    }

    #[test]
    fn expose_still_works() {
        assert_eq!(*Secret::new(7).expose(), 7);
        assert_eq!(Secret::new(7).into_exposed(), 7);
    }

    #[test]
    fn redaction_keeps_what_an_operator_needs() {
        assert_eq!(
            redact_database_url("postgres://fathom:hunter2@db.internal:5432/fathom"),
            format!("postgres://fathom:{REDACTED}@db.internal:5432/fathom")
        );
        assert_eq!(
            redact_database_url("postgresql://u:p@127.0.0.1/db"),
            format!("postgresql://u:{REDACTED}@127.0.0.1/db")
        );
    }

    #[test]
    fn redaction_handles_the_forms_without_a_password() {
        assert_eq!(
            redact_database_url("postgres://fathom@/var/run/postgresql/fathom"),
            "postgres://fathom@/var/run/postgresql/fathom"
        );
        assert_eq!(
            redact_database_url("postgres://localhost:5432/fathom"),
            "postgres://localhost:5432/fathom"
        );
    }

    #[test]
    fn a_password_containing_an_at_sign_is_still_destroyed() {
        // The '@' inside the password is why the split is on the LAST one.
        let out = redact_database_url("postgres://u:p@ss@db.internal/fathom");
        assert!(!out.contains("p@ss"), "{out}");
        assert!(!out.contains("ss@db"), "{out}");
        assert_eq!(out, format!("postgres://u:{REDACTED}@db.internal/fathom"));
    }

    #[test]
    fn query_parameters_are_dropped_wholesale() {
        // `?password=` is a real libpq form and picking it apart is a second
        // parser. Everything after the '?' goes.
        let out = redact_database_url("postgres://u@db/fathom?password=hunter2&sslmode=require");
        assert!(!out.contains("hunter2"), "{out}");
        assert_eq!(out, "postgres://u@db/fathom");
    }

    #[test]
    fn anything_unparseable_is_redacted_in_full() {
        // A redactor that emits its input when confused is worse than none: it
        // looks like a redactor.
        for weird in ["", "hunter2", "://", "postgres://", "no-scheme/db"] {
            assert_eq!(redact_database_url(weird), REDACTED, "{weird}");
        }
    }

    #[test]
    fn an_empty_host_after_userinfo_is_refused() {
        assert_eq!(redact_database_url("postgres://u:p@"), REDACTED);
    }

    #[test]
    fn a_url_with_the_at_sign_missing_is_refused_in_full() {
        // THE CASE THAT MADE THIS STRICTER. `postgres://user:PASSWORD` is an
        // ordinary typo -- the `@` left out -- and the first cut of this
        // function printed the password, because with no `@` there is no
        // userinfo and the whole thing parses as a host.
        assert_eq!(redact_database_url("postgres://fathom:hunter2"), REDACTED);
        assert_eq!(
            redact_database_url("postgres://fathom:hunter2/db"),
            REDACTED
        );
    }

    #[test]
    fn only_things_shaped_like_a_host_are_emitted() {
        for good in [
            "postgres://db.internal/fathom",
            "postgres://db.internal:5432/fathom",
            "postgres://127.0.0.1:5432/fathom",
            "postgres://[::1]:5432/fathom",
            "postgres://[::1]/fathom",
            "postgres://u@/var/run/postgresql/fathom",
        ] {
            assert_ne!(redact_database_url(good), REDACTED, "{good}");
        }
        for bad in [
            "postgres://host:notaport/db",
            "postgres://host:999999/db",
            "postgres://has space/db",
            "postgres://[not hex]/db",
            "postgres://[::1/db",
        ] {
            assert_eq!(redact_database_url(bad), REDACTED, "{bad}");
        }
    }
}
