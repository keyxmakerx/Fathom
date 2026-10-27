//! **Termix, a self-hosted SSH manager, beside Fathom** (ADR-0078).
//!
//! The operator names one Termix with `FATHOM_TERMIX_URL`. The server does two things with it and
//! nothing else: it adds that one origin to the client's `connect-src` (`client.rs`), and it tells
//! a signed-in browser the address (`GET /integrations/termix`). The server never calls Termix.
//!
//! A person's browser does the rest with the person's own Termix API key, which never reaches this
//! server: it finds the Termix host whose address is a device's management address, adds one when
//! there is none, and opens Termix's full-screen terminal on it in a new tab. No password goes to
//! Termix from Fathom; Termix keeps its own credentials.
//!
//! **Invariant 2 still holds.** Fathom opens no connection to a device. Termix does, in a tab the
//! person opened, as the Termix user the key belongs to.
//!
//! **Why the origin is parsed so strictly.** It is written into a response header, so a value with
//! a space, a semicolon or a quote could add a CSP directive or a source. Only a scheme, a host of
//! letters, digits, dots and hyphens, and a port are accepted, and the whole value is refused
//! otherwise at startup.

/// The one Termix this deployment names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Termix {
    origin: String,
}

impl Termix {
    /// `https://host[:port]`, with an optional trailing `/`; `http://` only to a loopback host
    /// (`localhost`, `127.0.0.1`), for a Termix on the same machine. No user name, path, query or
    /// fragment.
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        const VARIABLE: &str = "FATHOM_TERMIX_URL";
        let value = value.trim();
        let value = value.strip_suffix('/').unwrap_or(value);
        let (scheme, rest) = value.split_once("://").ok_or(VARIABLE)?;
        let scheme = scheme.to_ascii_lowercase();
        let (host, port) = match rest.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        };
        let host = host.to_ascii_lowercase();
        let host_ok = !host.is_empty()
            && host.len() <= 253
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && !host.starts_with(['.', '-'])
            && !host.ends_with(['.', '-']);
        if !host_ok {
            return Err(VARIABLE);
        }
        if let Some(p) = port {
            match p.parse::<u16>() {
                Ok(n) if n > 0 && p.bytes().all(|b| b.is_ascii_digit()) => {}
                _ => return Err(VARIABLE),
            }
        }
        let loopback = host == "localhost" || host == "127.0.0.1";
        match scheme.as_str() {
            "https" => {}
            "http" if loopback => {}
            _ => return Err(VARIABLE),
        }
        let origin = match port {
            Some(p) => format!("{scheme}://{host}:{p}"),
            None => format!("{scheme}://{host}"),
        };
        Ok(Self { origin })
    }

    /// The origin, as the browser compares it: `https://termix.example.lan`.
    pub fn origin(&self) -> &str {
        &self.origin
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_https_origin_is_kept_as_an_origin() {
        let t = Termix::parse(" https://Termix.Example.lan/ ").unwrap();
        assert_eq!(t.origin(), "https://termix.example.lan");
        let t = Termix::parse("https://10.0.0.5:8443").unwrap();
        assert_eq!(t.origin(), "https://10.0.0.5:8443");
    }

    #[test]
    fn plain_http_only_to_this_machine() {
        assert_eq!(
            Termix::parse("http://localhost:8080").unwrap().origin(),
            "http://localhost:8080"
        );
        assert!(Termix::parse("http://termix.example.lan").is_err());
        assert!(Termix::parse("ftp://termix.example.lan").is_err());
    }

    #[test]
    fn anything_that_could_add_to_a_header_is_refused() {
        for bad in [
            "https://termix.example.lan; script-src *",
            "https://termix.example.lan *",
            "https://termix.example.lan/path",
            "https://user@termix.example.lan",
            "https://termix.example.lan?x=1",
            "https://termix.example.lan#x",
            "https://\"termix\"",
            "https://termix.example.lan:0",
            "https://termix.example.lan:99999",
            "https://termix.example.lan:+80",
            "https://",
            "https://-termix",
            "termix.example.lan",
            "https://[::1]",
        ] {
            assert!(Termix::parse(bad).is_err(), "{bad}");
        }
    }
}
