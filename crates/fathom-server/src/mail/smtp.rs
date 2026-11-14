//! **The server's SMTP client** (ADR-0085 decisions 9 and 10): one message to one recipient
//! through the operator's relay, over TLS unless the relay is on this machine.
//!
//! Written here, about 300 lines, rather than taken from `lettre`. ADR-0085 decision 9 chose
//! `lettre` and named this as the other way. Measured on 2026-11-14 with `cargo tree` (Linux,
//! normal edges), `lettre` 0.11.23 with only `smtp-transport`, `builder`, `tokio1-rustls` and
//! `ring` adds 34 crates the lockfile does not hold, most of them `idna` and the ICU tables under
//! it, five with proc macros. This needs none: it is tokio, plus the rustls already approved for
//! the outside-vault client. The owner's pick on Sign-offs card r139 decides which stays.
//!
//! **C7's one exception reaches here**, as widened on 2026-11-02 (`deps/decisions/ring.md`,
//! "Widened 2026-11-02: SMTP to the operator's relay"): this module and
//! `vault_outside/https.rs` are the only two that name `rustls` or `tokio_rustls`.
//!
//! What it does, so a reviewer need not read the RFCs to know:
//! - `implicit`: TLS from the first byte (RFC 8314 §3.3). `starttls`: plain until `STARTTLS`
//!   answers 220, then TLS, then `EHLO` again with everything learned before forgotten (RFC 3207
//!   §4.2, read 2026-11-14). **A relay that does not offer STARTTLS is a failure, never a fall
//!   back to plain** (ADR-0085 decision 10). `none`: only when every address the host resolves
//!   to is a loopback one.
//! - Certificates are checked against Mozilla's roots (`webpki-roots`), plus the operator's own
//!   CA when `FATHOM_SMTP_CA` names a PEM file. There is no "skip verification" switch.
//! - `AUTH PLAIN` (RFC 4616, read 2026-11-14), or `AUTH LOGIN` when that is all the relay
//!   offers, and only ever over TLS or to loopback. The password is never logged and never
//!   part of an answer.
//! - Dot-stuffing (RFC 5321 §4.5.2): a line of the message that starts with `.` gets another.
//!   The bodies [`super::message`] writes are base64, so only a header line could, and none does.
//! - [`TIMEOUT`] for the whole conversation; a reply is at most [`REPLY_MAX`] bytes.
//! - The answer is the relay's own last reply, with control characters removed and cut to 300
//!   characters, because that is what Admin › Mail shows. A 4xx is worth trying again; a 5xx is
//!   not (RFC 5321 §4.2.1).

use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use crate::placement::{SmtpSettings, TlsMode};

use super::message::{base64, domain_of};

/// The whole conversation, connect to `QUIT`.
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// The most bytes one reply (all its lines) may hold.
pub const REPLY_MAX: usize = 16 * 1024;

/// How a send ended badly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendError {
    /// What Admin › Mail shows: the relay's reply, or one sentence of ours.
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

/// TLS settings shared by every send.
pub struct Tls {
    connector: tokio_rustls::TlsConnector,
}

impl Tls {
    /// `extra_ca`: a PEM file of certificates to trust beside Mozilla's roots
    /// (`FATHOM_SMTP_CA`), for a relay with a private CA.
    pub fn new(extra_ca: Option<&std::path::Path>) -> Result<Self, String> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if let Some(path) = extra_ca {
            let mut added = 0;
            for cert in
                CertificateDer::pem_file_iter(path).map_err(|e| format!("FATHOM_SMTP_CA: {e}"))?
            {
                let cert = cert.map_err(|e| format!("FATHOM_SMTP_CA: {e}"))?;
                roots
                    .add(cert)
                    .map_err(|e| format!("FATHOM_SMTP_CA: {e}"))?;
                added += 1;
            }
            if added == 0 {
                return Err("FATHOM_SMTP_CA holds no certificate".to_string());
            }
        }
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
        Ok(Self {
            connector: tokio_rustls::TlsConnector::from(Arc::new(config)),
        })
    }
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// Send `data` (a whole message, CRLF line ends) from the settings' from address to `to`.
/// Answers the relay's reply to the end of `DATA`.
pub async fn send(
    settings: &SmtpSettings,
    tls: &Tls,
    to: &str,
    data: &[u8],
) -> Result<String, SendError> {
    match tokio::time::timeout(TIMEOUT, conversation(settings, tls, to, data)).await {
        Ok(answer) => answer,
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
    let addresses: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, settings.port))
        .await
        .map_err(|_| SendError::ours("Fathom could not find the mail server's address.", false))?
        .collect();
    let first = *addresses.first().ok_or_else(|| {
        SendError::ours("Fathom could not find the mail server's address.", false)
    })?;
    let loopback = addresses.iter().all(|a| a.ip().is_loopback());
    if settings.tls_mode == TlsMode::None && !loopback {
        return Err(SendError::ours(
            "TLS is set to none, which is only allowed for a mail server on this machine.",
            true,
        ));
    }
    let tcp = TcpStream::connect(first)
        .await
        .map_err(|_| SendError::ours("Fathom could not reach the mail server.", false))?;

    let name = || {
        ServerName::try_from(host.to_string()).map_err(|_| {
            SendError::ours(
                "The mail server's host is not a name a certificate can carry.",
                true,
            )
        })
    };
    let wrap = |s: TcpStream| async {
        tls.connector
            .connect(name()?, s)
            .await
            .map_err(|e| SendError {
                reply: clean(&format!("TLS with the mail server failed: {e}")),
                permanent: false,
            })
    };

    let mut conn: BufReader<Box<dyn Stream>> = match settings.tls_mode {
        TlsMode::Implicit => BufReader::new(Box::new(wrap(tcp).await?)),
        _ => BufReader::new(Box::new(tcp)),
    };
    let mut encrypted = settings.tls_mode == TlsMode::Implicit;

    expect(&mut conn, 220).await?;
    let helo = domain_of(&settings.from_address).to_string();
    let mut caps = ehlo(&mut conn, &helo).await?;

    if settings.tls_mode == TlsMode::StartTls {
        if !caps.iter().any(|c| c.eq_ignore_ascii_case("STARTTLS")) {
            return Err(SendError::ours(
                "The mail server does not offer STARTTLS, so nothing was sent in the clear.",
                true,
            ));
        }
        command(&mut conn, "STARTTLS").await?;
        expect(&mut conn, 220).await?;
        // `into_inner` drops nothing that matters: a server may not send before the
        // handshake, and anything it did would be an injection attempt (RFC 3207 §5).
        if !conn.buffer().is_empty() {
            return Err(SendError::ours(
                "The mail server sent data before TLS began, so Fathom stopped.",
                true,
            ));
        }
        let plain = conn.into_inner();
        // The boxed stream is the TcpStream we put in; take it back out by re-connecting
        // through TLS over it.
        let upgraded = tls
            .connector
            .connect(name()?, plain)
            .await
            .map_err(|e| SendError {
                reply: clean(&format!("TLS with the mail server failed: {e}")),
                permanent: false,
            })?;
        conn = BufReader::new(Box::new(upgraded));
        encrypted = true;
        caps = ehlo(&mut conn, &helo).await?;
    }

    if !settings.user.is_empty() {
        if !encrypted && !loopback {
            return Err(SendError::ours(
                "Fathom does not send a password to a mail server without TLS.",
                true,
            ));
        }
        let auth = caps
            .iter()
            .find(|c| c.len() > 5 && c[..5].eq_ignore_ascii_case("AUTH "))
            .map(|c| c[5..].to_ascii_uppercase())
            .unwrap_or_default();
        let methods: Vec<&str> = auth.split_whitespace().collect();
        if methods.contains(&"PLAIN") {
            let mut token = Vec::with_capacity(settings.user.len() + 64);
            token.push(0);
            token.extend_from_slice(settings.user.as_bytes());
            token.push(0);
            token.extend_from_slice(settings.password.expose().as_bytes());
            let line = format!("AUTH PLAIN {}", base64(&token));
            token.fill(0);
            command(&mut conn, &line).await?;
            expect_auth(&mut conn, 235).await?;
        } else if methods.contains(&"LOGIN") {
            command(&mut conn, "AUTH LOGIN").await?;
            expect_auth(&mut conn, 334).await?;
            command(&mut conn, &base64(settings.user.as_bytes())).await?;
            expect_auth(&mut conn, 334).await?;
            command(&mut conn, &base64(settings.password.expose().as_bytes())).await?;
            expect_auth(&mut conn, 235).await?;
        } else {
            return Err(SendError::ours(
                "The mail server offers no sign-in Fathom uses (PLAIN or LOGIN).",
                true,
            ));
        }
    }

    command(&mut conn, &format!("MAIL FROM:<{}>", settings.from_address)).await?;
    expect(&mut conn, 250).await?;
    command(&mut conn, &format!("RCPT TO:<{to}>")).await?;
    expect_any(&mut conn, &[250, 251]).await?;
    command(&mut conn, "DATA").await?;
    expect(&mut conn, 354).await?;
    let stuffed = dot_stuff(data);
    conn.get_mut()
        .write_all(&stuffed)
        .await
        .map_err(|_| lost())?;
    conn.get_mut()
        .write_all(b".\r\n")
        .await
        .map_err(|_| lost())?;
    conn.get_mut().flush().await.map_err(|_| lost())?;
    let accepted = expect(&mut conn, 250).await?;
    let _ = command(&mut conn, "QUIT").await;
    Ok(accepted)
}

fn lost() -> SendError {
    SendError::ours("The connection to the mail server was lost.", false)
}

async fn command(conn: &mut BufReader<Box<dyn Stream>>, line: &str) -> Result<(), SendError> {
    if line.contains('\r') || line.contains('\n') {
        return Err(SendError::ours(
            "A line to the mail server was malformed.",
            true,
        ));
    }
    let w = conn.get_mut();
    w.write_all(line.as_bytes()).await.map_err(|_| lost())?;
    w.write_all(b"\r\n").await.map_err(|_| lost())?;
    w.flush().await.map_err(|_| lost())
}

/// One reply: its code and its lines' text.
async fn reply(conn: &mut BufReader<Box<dyn Stream>>) -> Result<(u16, Vec<String>), SendError> {
    let mut lines = Vec::new();
    let mut total = 0usize;
    loop {
        let mut raw = Vec::new();
        let n = (&mut *conn)
            .take((REPLY_MAX - total) as u64 + 1)
            .read_until(b'\n', &mut raw)
            .await
            .map_err(|_| lost())?;
        if n == 0 {
            return Err(lost());
        }
        total += n;
        if total > REPLY_MAX {
            return Err(SendError::ours(
                "The mail server's reply was too long.",
                false,
            ));
        }
        let line = String::from_utf8_lossy(&raw);
        let line = line.trim_end_matches(['\r', '\n']);
        if line.len() < 3 || !line.as_bytes()[..3].iter().all(u8::is_ascii_digit) {
            return Err(SendError::ours(
                "The mail server answered something that is not SMTP.",
                true,
            ));
        }
        let code: u16 = line[..3].parse().unwrap_or(0);
        let more = line.as_bytes().get(3) == Some(&b'-');
        lines.push(line.get(4..).unwrap_or("").to_string());
        if !more {
            return Ok((code, lines));
        }
    }
}

fn refused(code: u16, lines: &[String]) -> SendError {
    SendError {
        reply: clean(&format!("{code} {}", lines.join(" "))),
        permanent: code >= 500,
    }
}

async fn expect(conn: &mut BufReader<Box<dyn Stream>>, want: u16) -> Result<String, SendError> {
    expect_any(conn, &[want]).await
}

async fn expect_any(
    conn: &mut BufReader<Box<dyn Stream>>,
    want: &[u16],
) -> Result<String, SendError> {
    let (code, lines) = reply(conn).await?;
    if want.contains(&code) {
        Ok(clean(&format!("{code} {}", lines.join(" "))))
    } else {
        Err(refused(code, &lines))
    }
}

/// As [`expect`], but a refusal never echoes the server's text, which may quote what was sent.
async fn expect_auth(conn: &mut BufReader<Box<dyn Stream>>, want: u16) -> Result<(), SendError> {
    let (code, _) = reply(conn).await?;
    if code == want {
        Ok(())
    } else {
        Err(SendError {
            reply: format!("{code}: the mail server refused the user and password."),
            permanent: code >= 500,
        })
    }
}

async fn ehlo(conn: &mut BufReader<Box<dyn Stream>>, name: &str) -> Result<Vec<String>, SendError> {
    command(conn, &format!("EHLO {name}")).await?;
    let (code, lines) = reply(conn).await?;
    if code != 250 {
        return Err(refused(code, &lines));
    }
    // The first line is the greeting; the rest are the extensions it offers.
    Ok(lines
        .into_iter()
        .skip(1)
        .map(|l| l.trim().to_string())
        .collect())
}

/// RFC 5321 §4.5.2: every line that begins with `.` gets one more.
pub fn dot_stuff(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 16);
    let mut at_line_start = true;
    for &b in data {
        if at_line_start && b == b'.' {
            out.push(b'.');
        }
        out.push(b);
        at_line_start = b == b'\n';
    }
    if !out.ends_with(b"\r\n") {
        out.extend_from_slice(b"\r\n");
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
    use tokio::net::TcpListener;

    #[test]
    fn dot_stuffing_doubles_a_leading_period() {
        assert_eq!(
            dot_stuff(b".a\r\nb\r\n.\r\n"),
            b"..a\r\nb\r\n..\r\n".to_vec()
        );
        assert_eq!(dot_stuff(b"a"), b"a\r\n".to_vec());
    }

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
        assert!(seen.contains("MAIL FROM:<fathom@example.net>\r\n"));
        assert!(seen.contains("RCPT TO:<sam@example.org>\r\n"));
        assert!(seen.contains("\r\n..hidden\r\n.\r\n"));
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
            !err.reply.contains("a-real-length-password"),
            "{}",
            err.reply
        );
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
