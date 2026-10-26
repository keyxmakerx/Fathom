//! **The server's one outbound HTTPS client** (ADR-0071 part four): HTTP/1.1 over rustls, to an
//! outside vault and nowhere else.
//!
//! **C7's one exception lives here.** rustls's `ring` provider carries C and assembly; the owner
//! allowed it on 2026-10-26 (sign-off card r34-vault-ring, A) only underneath `rustls` and only
//! for this. `deny.toml` keeps `ring` banned for every other parent, and nothing outside this
//! module names `rustls` or `tokio_rustls`.
//!
//! What it does, so a reviewer need not read rustls to know:
//! - **Certificates are checked** against Mozilla's roots (`webpki-roots`), plus the operator's
//!   own CA when `FATHOM_OUTSIDE_VAULT_CA` names a PEM file, for a vault on a home network with
//!   a private CA. There is no "skip verification" switch, by design.
//! - TLS 1.2 and 1.3 with rustls's safe defaults; no ALPN, so the server speaks HTTP/1.1.
//! - One request per connection (`Connection: close`), no redirects followed (a 3xx is answered
//!   in words), at most [`super::MAX_ANSWER_BYTES`] read, and [`TIMEOUT`] for the whole round.
//!
//! It is ~200 lines rather than a client crate because the job is two requests, and hyper's
//! client feature would add crates the owner did not approve.

use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{HttpAnswer, HttpRequest, Net, NetError, NetFuture, MAX_ANSWER_BYTES};

/// Connect, TLS, request and answer, all of it.
pub const TIMEOUT: Duration = Duration::from_secs(20);

pub struct Https {
    connector: tokio_rustls::TlsConnector,
}

impl Https {
    /// `extra_ca`: a PEM file of certificates to trust beside Mozilla's roots.
    pub fn new(extra_ca: Option<&std::path::Path>) -> Result<Self, String> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if let Some(path) = extra_ca {
            let mut added = 0;
            for cert in CertificateDer::pem_file_iter(path)
                .map_err(|e| format!("FATHOM_OUTSIDE_VAULT_CA: {e}"))?
            {
                let cert = cert.map_err(|e| format!("FATHOM_OUTSIDE_VAULT_CA: {e}"))?;
                roots
                    .add(cert)
                    .map_err(|e| format!("FATHOM_OUTSIDE_VAULT_CA: {e}"))?;
                added += 1;
            }
            if added == 0 {
                return Err("FATHOM_OUTSIDE_VAULT_CA holds no certificate".to_string());
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

    async fn round(&self, req: HttpRequest) -> Result<HttpAnswer, NetError> {
        let say = |s: &str| NetError(s.to_string());
        let host = req.url.bare_host().to_string();
        let name = ServerName::try_from(host.clone())
            .map_err(|_| say("that address is not a name a certificate can carry"))?;
        let tcp = tokio::net::TcpStream::connect((host.as_str(), req.url.port))
            .await
            .map_err(|_| say("Fathom could not reach that address; check it, and that this server can reach it"))?;
        let mut tls = self.connector.connect(name, tcp).await.map_err(|e| {
            tracing::info!(error = %e, "outside vault TLS failed");
            say("the vault's certificate was not one Fathom trusts, or TLS failed; a vault with a private CA needs FATHOM_OUTSIDE_VAULT_CA")
        })?;
        let mut head = format!(
            "{} {}{} HTTP/1.1\r\nHost: {}\r\nUser-Agent: Fathom\r\nAccept: application/json\r\nConnection: close\r\nContent-Length: {}\r\n",
            req.method,
            req.url.prefix,
            req.path,
            req.url.host_header(),
            req.body.len()
        );
        for (k, v) in &req.headers {
            if v.contains(['\r', '\n']) {
                return Err(say("a header carried a line break"));
            }
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        let mut out = head.into_bytes();
        out.extend_from_slice(&req.body);
        tls.write_all(&out)
            .await
            .map_err(|_| say("the vault closed the connection"))?;
        out.iter_mut().for_each(|b| *b = 0);
        let mut raw = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match tls.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    raw.extend_from_slice(&buf[..n]);
                    if raw.len() > MAX_ANSWER_BYTES + 64 * 1024 {
                        return Err(say("the vault's answer was larger than Fathom reads"));
                    }
                }
                // A server that closes without close_notify after a complete answer is common;
                // the framing below decides whether the answer was complete.
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(_) => return Err(say("the connection to the vault broke")),
            }
        }
        parse_answer(&raw)
    }
}

impl Net for Https {
    fn send(&self, req: HttpRequest) -> NetFuture<'_> {
        Box::pin(async move {
            tokio::time::timeout(TIMEOUT, self.round(req))
                .await
                .unwrap_or_else(|_| Err(NetError("the vault took too long to answer".to_string())))
        })
    }
}

/// One HTTP/1.1 answer: status, headers, then a body framed by chunks, a length, or the close.
pub fn parse_answer(raw: &[u8]) -> Result<HttpAnswer, NetError> {
    let say = |s: &str| NetError(s.to_string());
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| say("the vault's answer was cut short"))?;
    let head =
        std::str::from_utf8(&raw[..end]).map_err(|_| say("the vault's answer was not HTTP"))?;
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    let (Some(version), Some(code)) = (parts.next(), parts.next()) else {
        return Err(say("the vault's answer was not HTTP"));
    };
    if !version.starts_with("HTTP/1.") {
        return Err(say("the vault's answer was not HTTP/1.1"));
    }
    let status: u16 = code
        .parse()
        .ok()
        .filter(|c| (100..600).contains(c))
        .ok_or_else(|| say("the vault's answer was not HTTP"))?;
    if (300..400).contains(&status) {
        return Err(say(
            "the vault's address redirects; give Fathom the address it redirects to",
        ));
    }
    let mut length: Option<usize> = None;
    let mut chunked = false;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            return Err(say("the vault's answer was not HTTP"));
        };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        if k == "content-length" {
            let n: usize = v
                .parse()
                .map_err(|_| say("the vault's answer was not HTTP"))?;
            if length.is_some_and(|l| l != n) {
                return Err(say("the vault's answer was not HTTP"));
            }
            length = Some(n);
        } else if k == "transfer-encoding" {
            if !v.eq_ignore_ascii_case("chunked") {
                return Err(say(
                    "the vault's answer used an encoding Fathom does not read",
                ));
            }
            chunked = true;
        }
    }
    let rest = &raw[end + 4..];
    let body = if chunked {
        let mut body = Vec::new();
        let mut at = 0;
        loop {
            let nl = rest[at..]
                .windows(2)
                .position(|w| w == b"\r\n")
                .ok_or_else(|| say("the vault's answer was cut short"))?;
            let size_text = std::str::from_utf8(&rest[at..at + nl])
                .map_err(|_| say("the vault's answer was not HTTP"))?;
            let size_text = size_text.split(';').next().unwrap_or("").trim();
            let size = usize::from_str_radix(size_text, 16)
                .map_err(|_| say("the vault's answer was not HTTP"))?;
            at += nl + 2;
            if size == 0 {
                break;
            }
            if size > MAX_ANSWER_BYTES || at + size + 2 > rest.len() {
                return Err(say("the vault's answer was cut short"));
            }
            body.extend_from_slice(&rest[at..at + size]);
            if body.len() > MAX_ANSWER_BYTES {
                return Err(say("the vault's answer was larger than Fathom reads"));
            }
            at += size;
            if &rest[at..at + 2] != b"\r\n" {
                return Err(say("the vault's answer was not HTTP"));
            }
            at += 2;
        }
        body
    } else if let Some(n) = length {
        if rest.len() < n {
            return Err(say("the vault's answer was cut short"));
        }
        rest[..n].to_vec()
    } else {
        rest.to_vec()
    };
    if body.len() > MAX_ANSWER_BYTES {
        return Err(say("the vault's answer was larger than Fathom reads"));
    }
    Ok(HttpAnswer { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_reads_a_length_a_chunked_body_and_a_close() {
        let a = parse_answer(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!((a.status, a.body.as_slice()), (200, &b"{}"[..]));
        let a = parse_answer(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4;x=y\r\n\":1}\r\n0\r\n\r\n",
        )
        .unwrap();
        assert_eq!(a.body, b"{\"a\":1}");
        let a = parse_answer(b"HTTP/1.0 401 Unauthorized\r\n\r\nno").unwrap();
        assert_eq!((a.status, a.body.as_slice()), (401, &b"no"[..]));
    }

    #[test]
    fn it_refuses_what_it_cannot_frame() {
        for bad in [
            &b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n{}"[..],
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n{}",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{}",
            b"HTTP/1.1 302 Found\r\nLocation: http://x\r\n\r\n",
            b"HTTP/2 200\r\n\r\n",
            b"garbage",
        ] {
            assert!(
                parse_answer(bad).is_err(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
    }
}
