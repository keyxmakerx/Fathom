//! `fathom-server healthcheck --addr HOST:PORT` — the binary as its own health
//! check.
//!
//! **`43` §5.4 requires this** and the reason is in its own comment: *"distroless
//! has no shell and no curl. The binary is its own health check."* A container
//! image with nothing in it but this binary has no `curl` to `HEALTHCHECK` with,
//! and adding one to get a health check back is adding a shell and a network
//! tool to a production image so that a probe can run.
//!
//! # Why this speaks HTTP by hand
//!
//! `hyper` is already in the closure, as axum's server. Using it as a *client*
//! would mean enabling its `client` feature and `hyper-util`'s, which is more
//! code compiled into the image so that one probe can send eleven bytes. A
//! `GET /health HTTP/1.1` and a look at the status line is forty lines of
//! `tokio::net`, needs no feature at all, and cannot pull anything new into the
//! closure.
//!
//! It is deliberately **not** a general HTTP client and must never grow into
//! one: it talks to this same binary, over loopback, about one path.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long the whole probe may take. A health check that can hang is a health
/// check that turns a slow server into a stuck orchestrator.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// The most we will read of a response. The body is `ok\n` or a short reason;
/// anything larger is not this server answering and the cap means a hostile or
/// broken peer cannot make the probe allocate.
const MAX_RESPONSE: usize = 4096;

/// Probe `addr`. `Ok(())` means a 200; everything else is a failure with a
/// one-line reason.
pub async fn probe(addr: &str) -> Result<(), String> {
    let work = async {
        let mut stream = TcpStream::connect(addr)
            .await
            .map_err(|e| format!("could not connect to {addr}: {e}"))?;

        // `Connection: close` so the server does not hold the socket open
        // waiting for a second request that is never coming.
        let request = format!(
            "GET /health HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nUser-Agent: fathom-server-healthcheck\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| format!("could not send the request: {e}"))?;

        let mut buf = Vec::new();
        let mut chunk = [0u8; 512];
        loop {
            let n = stream
                .read(&mut chunk)
                .await
                .map_err(|e| format!("could not read the response: {e}"))?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() >= MAX_RESPONSE {
                break;
            }
        }

        status_of(&buf)
    };

    match tokio::time::timeout(PROBE_TIMEOUT, work).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "no answer from {addr} within {}s",
            PROBE_TIMEOUT.as_secs()
        )),
    }
}

/// Read the status line and decide.
///
/// Split out so it can be tested without a socket — and the interesting cases
/// are all in here: a 503, a truncated response, and something that is not HTTP
/// at all answering on the port.
pub fn status_of(response: &[u8]) -> Result<(), String> {
    let head = response
        .iter()
        .position(|b| *b == b'\r' || *b == b'\n')
        .map(|i| &response[..i])
        .unwrap_or(response);
    let line = String::from_utf8_lossy(head);

    let mut parts = line.split(' ');
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/") {
        return Err("the reply was not HTTP".to_string());
    }
    match parts.next() {
        Some("200") => Ok(()),
        Some(code) => Err(format!("the server answered {code}")),
        None => Err("the reply had no status code".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_200_is_healthy_and_nothing_else_is() {
        assert!(status_of(b"HTTP/1.1 200 OK\r\n\r\nok\n").is_ok());
        assert!(status_of(b"HTTP/1.1 503 Service Unavailable\r\n\r\n").is_err());
        assert!(status_of(b"HTTP/1.1 500 Internal Server Error\r\n\r\n").is_err());
        // A 2xx that is not 200 is not a pass either: /health answers 200 or
        // 503 and nothing else, so a 204 means something unexpected is on the
        // port.
        assert!(status_of(b"HTTP/1.1 204 No Content\r\n\r\n").is_err());
    }

    #[test]
    fn something_that_is_not_http_is_a_failure_not_a_pass() {
        // The failure that matters: a probe that treats an unparseable reply
        // as healthy reports a broken server as fine.
        for junk in [
            &b""[..],
            b"\x00\x01\x02",
            b"SSH-2.0-OpenSSH_9.6\r\n",
            b"200 OK\r\n",
            b"<html>hello</html>",
        ] {
            assert!(
                status_of(junk).is_err(),
                "{:?}",
                String::from_utf8_lossy(junk)
            );
        }
    }

    #[test]
    fn a_truncated_status_line_is_a_failure() {
        assert!(status_of(b"HTTP/1.1").is_err());
        assert!(status_of(b"HTTP/1.1 ").is_err());
    }
}
