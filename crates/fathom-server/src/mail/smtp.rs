//! **The server's SMTP client** (ADR-0085 decisions 9 and 10): one message to one recipient
//! through the operator's relay, over TLS unless the relay is on this machine.
//!
//! The conversation is `lettre`'s (0.11.23, its SMTP transport only), as ADR-0085 decision 9
//! chose and the owner confirmed on Sign-offs card r141 (B, 2026-11-14; `deps/decisions/lettre.md`).
//! Fathom writes the message itself ([`super::message`]) and hands lettre the bytes. What this
//! module adds on top is Fathom's own rules, so a reviewer need not read lettre to know them:
//!
//! - `implicit`: TLS from the first byte (RFC 8314 §3.3), lettre's `Tls::Wrapper`. `starttls`:
//!   lettre's `Tls::Required`, which upgrades with `STARTTLS` and **fails rather than carry on in
//!   the clear** when the relay does not offer it (ADR-0085 decision 10; RFC 3207 §4.2, read
//!   2026-11-14). `none`: only when every address the host resolves to is a loopback one, and
//!   then lettre is pointed at that address, not the name.
//! - Certificates are checked against Mozilla's roots (`webpki-roots`), plus the operator's own
//!   CA when `FATHOM_SMTP_CA` names a PEM file. There is no "skip verification" switch: lettre's
//!   `dangerous_accept_invalid_*` are never called.
//! - A password goes only over TLS, or to a loopback relay, which is all `none` allows. `AUTH
//!   PLAIN` (RFC 4616, read 2026-11-14) or `AUTH LOGIN`. A refused sign-in is answered with
//!   Fathom's own sentence, never the relay's text, and every answer has the password scrubbed
//!   from it in case a relay repeats it.
//! - Dot-stuffing (RFC 5321 §4.5.2) is lettre's; a test here checks it.
//! - [`TIMEOUT`] for the whole conversation, and the same for each command inside it.
//! - The answer is the relay's own reply, with control characters removed and cut to 300
//!   characters, because that is what Steward › Mail shows. A 4xx is worth trying again; a 5xx
//!   is not (RFC 5321 §4.2.1).
//!
//! **C7's one exception reaches here**, as widened on 2026-11-02 (`deps/decisions/ring.md`):
//! rustls with the ring provider is lettre's TLS, and `deny.toml` still lets ring sit only under
//! rustls.

use std::time::Duration;

use lettre::address::{Address, Envelope};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{
    Certificate, CertificateStore, Tls as LettreTls, TlsParameters,
};
use lettre::transport::smtp::extension::ClientId;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};

use crate::placement::{SmtpSettings, TlsMode};

use super::message::domain_of;

/// The whole conversation, connect to `QUIT`.
pub const TIMEOUT: Duration = Duration::from_secs(60);

/// How a send ended badly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendError {
    /// What Steward › Mail shows: the relay's reply, or one sentence of ours.
    pub reply: String,
    /// A 5xx, or a setting that can never work. Not tried again.
    pub permanent: bool,
}

impl SendError {
    fn ours(s: &str, permanent: bool) -> Self {
        Self {
            reply: s.to_string(),
            permanent,
        }
    }
}

/// TLS settings shared by every send: the operator's extra CA, read and checked once at start.
pub struct Tls {
    extra: Vec<Certificate>,
}

impl Tls {
    /// `extra_ca`: a PEM file of certificates to trust beside Mozilla's roots
    /// (`FATHOM_SMTP_CA`), for a relay with a private CA.
    pub fn new(extra_ca: Option<&std::path::Path>) -> Result<Self, String> {
        let mut extra = Vec::new();
        if let Some(path) = extra_ca {
            let pem = std::fs::read(path).map_err(|e| format!("FATHOM_SMTP_CA: {e}"))?;
            if !pem
                .windows(b"-----BEGIN CERTIFICATE-----".len())
                .any(|w| w == b"-----BEGIN CERTIFICATE-----")
            {
                return Err("FATHOM_SMTP_CA holds no certificate".to_string());
            }
            extra.push(Certificate::from_pem(&pem).map_err(|e| format!("FATHOM_SMTP_CA: {e}"))?);
        }
        // Build once now, so a bad file stops the server at start and not at the first mail.
        Tls {
            extra: extra.clone(),
        }
        .parameters("relay.invalid")
        .map_err(|e| format!("FATHOM_SMTP_CA: {}", e.reply))?;
        Ok(Self { extra })
    }

    fn parameters(&self, host: &str) -> Result<TlsParameters, SendError> {
        let mut b = TlsParameters::builder(host.to_string())
            .certificate_store(CertificateStore::WebpkiRoots);
        for cert in &self.extra {
            b = b.add_root_certificate(cert.clone());
        }
        b.build_rustls().map_err(|e| SendError {
            reply: clean(&format!("TLS settings for the mail server failed: {e}")),
            permanent: true,
        })
    }
}

/// Send `data` (a whole message, CRLF line ends) from the settings' from address to `to`.
/// Answers the relay's reply to the end of `DATA`.
pub async fn send(
    settings: &SmtpSettings,
    tls: &Tls,
    to: &str,
    data: &[u8],
) -> Result<String, SendError> {
    match tokio::time::timeout(TIMEOUT, conversation(settings, tls, to, data)).await {
        Ok(answer) => answer.map(|a| scrub(settings, &a)).map_err(|mut e| {
            e.reply = scrub(settings, &e.reply);
            e
        }),
        Err(_) => Err(SendError::ours(
            "The mail server did not answer in time.",
            false,
        )),
    }
}

/// The host without the brackets an IPv6 literal is written in.
fn bare(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

async fn conversation(
    settings: &SmtpSettings,
    tls: &Tls,
    to: &str,
    data: &[u8],
) -> Result<String, SendError> {
    let host = bare(&settings.host);
    let from: Address = settings.from_address.parse().map_err(|_| {
        SendError::ours(
            "The from address in the mail settings is not an address.",
            true,
        )
    })?;
    let rcpt: Address = to
        .parse()
        .map_err(|_| SendError::ours("That is not an address Fathom can mail.", true))?;
    let envelope = Envelope::new(Some(from), vec![rcpt])
        .map_err(|_| SendError::ours("That is not an address Fathom can mail.", true))?;

    let (server, mode) = match settings.tls_mode {
        TlsMode::Implicit => (host.to_string(), LettreTls::Wrapper(tls.parameters(host)?)),
        TlsMode::StartTls => (host.to_string(), LettreTls::Required(tls.parameters(host)?)),
        TlsMode::None => {
            let addresses: Vec<std::net::SocketAddr> =
                tokio::net::lookup_host((host, settings.port))
                    .await
                    .map_err(|_| {
                        SendError::ours("Fathom could not find the mail server's address.", false)
                    })?
                    .collect();
            if addresses.is_empty() {
                return Err(SendError::ours(
                    "Fathom could not find the mail server's address.",
                    false,
                ));
            }
            if !addresses.iter().all(|a| a.ip().is_loopback()) {
                return Err(SendError::ours(
                    "TLS is set to none, which is only allowed for a mail server on this machine.",
                    true,
                ));
            }
            // Connect to the loopback address just checked, so a second lookup cannot answer
            // differently.
            (addresses[0].ip().to_string(), LettreTls::None)
        }
    };

    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(server)
        .port(settings.port)
        .tls(mode)
        .hello_name(ClientId::Domain(
            domain_of(&settings.from_address).to_string(),
        ))
        .timeout(Some(TIMEOUT));
    let signing_in = !settings.user.is_empty();
    if signing_in {
        builder = builder
            .credentials(Credentials::new(
                settings.user.clone(),
                settings.password.expose().to_string(),
            ))
            .authentication(vec![Mechanism::Plain, Mechanism::Login]);
    }
    let transport = builder.build();

    // lettre ends the message with CRLF "." CRLF itself, so a message that already ends in a
    // CRLF would gain an empty last line.
    let data = data.strip_suffix(b"\r\n").unwrap_or(data);
    match transport.send_raw(&envelope, data).await {
        Ok(response) => {
            let words: Vec<&str> = response.message().collect();
            Ok(clean(&format!("{} {}", response.code(), words.join(" "))))
        }
        Err(e) => Err(explain(&e, signing_in)),
    }
}

/// What a person is told about a failed send.
fn explain(e: &lettre::transport::smtp::Error, signing_in: bool) -> SendError {
    let said = std::error::Error::source(e)
        .map(|s| s.to_string())
        .unwrap_or_default();
    if let Some(code) = e.status() {
        let code = code.to_string();
        // 530, 534, 535 and 538 refuse a sign-in, 454 for now (RFC 4954 §6). The relay's text
        // may repeat what was sent, so it is not shown.
        if signing_in && ["530", "534", "535", "538", "454"].contains(&code.as_str()) {
            return SendError {
                reply: format!(
                    "{code} The mail server refused Fathom's sign-in. Check the user and password in the console."
                ),
                permanent: code != "454",
            };
        }
        return SendError {
            reply: clean(&format!("{code} {said}")),
            permanent: e.is_permanent(),
        };
    }
    if said.contains("STARTTLS") {
        return SendError::ours(
            "The mail server does not offer STARTTLS, so nothing was sent in the clear.",
            true,
        );
    }
    if said.contains("No compatible authentication mechanism") {
        return SendError::ours(
            "The mail server offers no sign-in Fathom uses (PLAIN or LOGIN).",
            true,
        );
    }
    if e.is_tls() {
        return SendError {
            reply: clean(&format!("TLS with the mail server failed: {said}")),
            permanent: false,
        };
    }
    if e.is_timeout() {
        return SendError::ours("The mail server did not answer in time.", false);
    }
    if e.is_client() {
        return SendError {
            reply: clean(&format!("Fathom could not send this mail: {said}")),
            permanent: true,
        };
    }
    SendError::ours("Fathom could not reach the mail server.", false)
}

/// Takes the password out of anything a relay said, in case it repeats it.
fn scrub(settings: &SmtpSettings, s: &str) -> String {
    let mut out = s.to_string();
    let password = settings.password.expose();
    if password.len() >= 4 {
        out = out.replace(password, "(password)");
    }
    out
}

/// What a person may be shown of a reply: printable, one line, at most 300 characters.
pub fn clean(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(300)
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret::Secret;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn settings(port: u16, tls: TlsMode, user: &str) -> SmtpSettings {
        SmtpSettings {
            host: "127.0.0.1".into(),
            port,
            tls_mode: tls,
            user: user.into(),
            password: Secret::new("a-real-length-password".into()),
            from_address: "fathom@example.net".into(),
        }
    }

    /// A relay on loopback that plays a script: each entry is what it says after reading one
    /// line (the first is the greeting, said before reading anything). Answers every line the
    /// client sent, so a test can check the conversation.
    async fn relay(
        script: Vec<&'static str>,
        data_reply: &'static str,
    ) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut seen = String::new();
            let mut script = script.into_iter();
            s.write_all(script.next().unwrap().as_bytes())
                .await
                .unwrap();
            let mut buf = vec![0u8; 65536];
            let mut pending = String::new();
            let mut in_data = false;
            loop {
                let n = s.read(&mut buf).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(i) = pending.find("\r\n") {
                    let line: String = pending.drain(..i + 2).collect();
                    seen.push_str(&line);
                    if in_data {
                        if line == ".\r\n" {
                            in_data = false;
                            s.write_all(data_reply.as_bytes()).await.unwrap();
                        }
                        continue;
                    }
                    if line.starts_with("DATA") {
                        in_data = true;
                    }
                    match script.next() {
                        Some(answer) => s.write_all(answer.as_bytes()).await.unwrap(),
                        None => return seen,
                    }
                }
            }
            seen
        });
        (port, handle)
    }

    #[tokio::test]
    async fn plain_to_loopback_sends_and_answers_the_relays_reply() {
        let (port, seen) = relay(
            vec![
                "220 relay ESMTP\r\n",
                "250-relay\r\n250 8BITMIME\r\n",
                "250 ok\r\n",
                "250 ok\r\n",
                "354 go\r\n",
                "221 bye\r\n",
            ],
            "250 2.0.0 queued as ABC\r\n",
        )
        .await;
        let tls = Tls::new(None).unwrap();
        let answer = send(
            &settings(port, TlsMode::None, ""),
            &tls,
            "sam@example.org",
            b"Subject: x\r\n\r\n.hidden\r\n",
        )
        .await
        .unwrap();
        assert_eq!(answer, "250 2.0.0 queued as ABC");
        let seen = seen.await.unwrap();
        assert!(seen.contains("EHLO example.net\r\n"));
        assert!(seen.contains("MAIL FROM:<fathom@example.net>"));
        assert!(seen.contains("RCPT TO:<sam@example.org>"));
        // Dot-stuffing is lettre's: a line that starts with "." gets another.
        assert!(seen.contains("\r\n..hidden\r\n.\r\n"), "{seen:?}");
    }

    #[tokio::test]
    async fn starttls_that_is_not_offered_is_a_failure_not_plain_text() {
        let (port, seen) = relay(
            vec![
                "220 relay\r\n",
                "250-relay\r\n250 AUTH PLAIN\r\n",
                "221 bye\r\n",
            ],
            "",
        )
        .await;
        let tls = Tls::new(None).unwrap();
        let err = send(
            &settings(port, TlsMode::StartTls, "fathom"),
            &tls,
            "sam@example.org",
            b"x\r\n",
        )
        .await
        .unwrap_err();
        assert!(err.permanent);
        assert!(err.reply.contains("STARTTLS"));
        drop(seen);
    }

    #[tokio::test]
    async fn a_5xx_is_permanent_and_a_4xx_is_not() {
        for (code, permanent) in [
            ("550 5.1.1 no such user\r\n", true),
            ("451 4.3.0 try later\r\n", false),
        ] {
            let (port, _seen) = relay(
                vec!["220 relay\r\n", "250 relay\r\n", "250 ok\r\n", code],
                "",
            )
            .await;
            let tls = Tls::new(None).unwrap();
            let err = send(
                &settings(port, TlsMode::None, ""),
                &tls,
                "sam@example.org",
                b"x\r\n",
            )
            .await
            .unwrap_err();
            assert_eq!(err.permanent, permanent, "{code}");
            assert_eq!(err.reply, code.trim());
        }
    }

    #[tokio::test]
    async fn a_refused_password_is_never_echoed() {
        let (port, _seen) = relay(
            vec![
                "220 relay\r\n",
                "250-relay\r\n250 AUTH PLAIN LOGIN\r\n",
                "535 5.7.8 bad credentials for a-real-length-password\r\n",
            ],
            "",
        )
        .await;
        let tls = Tls::new(None).unwrap();
        let err = send(
            &settings(port, TlsMode::None, "fathom"),
            &tls,
            "sam@example.org",
            b"x\r\n",
        )
        .await
        .unwrap_err();
        assert!(err.permanent);
        assert!(
            err.reply.contains("refused Fathom's sign-in"),
            "{}",
            err.reply
        );
        assert!(
            !err.reply.contains("a-real-length-password"),
            "{}",
            err.reply
        );
    }

    #[test]
    fn a_ca_file_with_no_certificate_stops_the_server_at_start() {
        let path = std::env::temp_dir().join(format!("fathom-smtp-ca-{}.pem", std::process::id()));
        std::fs::write(&path, "not a certificate\n").unwrap();
        let err = Tls::new(Some(&path)).err().expect("refused");
        std::fs::remove_file(&path).ok();
        assert!(err.contains("FATHOM_SMTP_CA"), "{err}");
    }

    #[tokio::test]
    async fn none_to_a_host_that_is_not_loopback_is_refused_before_connecting() {
        let mut s = settings(25, TlsMode::None, "");
        s.host = "192.0.2.1".into();
        let tls = Tls::new(None).unwrap();
        let err = send(&s, &tls, "sam@example.org", b"x\r\n")
            .await
            .unwrap_err();
        assert!(err.permanent);
    }
}
