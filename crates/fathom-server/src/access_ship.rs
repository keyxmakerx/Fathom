//! Sending the access lines (`access_log.rs`) to a log server.
//!
//! `FATHOM_ACCESS_SYSLOG`, a bare `host:port`: one RFC 5424 line per operator
//! console or sign-in request over TCP, LF-framed, in the same shape as the
//! audit shipper's (`audit.rs`, whose module doc records what was read about
//! the format and when). The owner asked for it on 2026-10-27 (sign-offs r52:
//! "it needs to be able to push to a log server").
//!
//! **Best effort, and said so.** The audit shipper spools in PostgreSQL and
//! never drops a sealed entry; this one does not spool. A request never waits
//! on it: [`send`] puts the line on a bounded queue and returns, and a line the
//! queue cannot take, or the server cannot be reached for, is dropped and
//! counted. What must not be lost is already kept elsewhere: the server's own
//! log has every line, and the sealed site history keeps the same two
//! addresses for every operator act (`chains::append_site`).
//!
//! What a line carries: the plane, the method, the path without its query, the
//! status, the client's address, the proxy it came through and the `Host`
//! header. Nothing from a body and no header but `Host`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::audit::{sanitise, SyslogTarget};

/// Facility 13 (*log audit*) times 8, plus severity 6 (*Informational*).
const PRI: u8 = 13 * 8 + 6;
const APP_NAME: &str = "fathom-access";
/// Lines waiting to be written. Past it, a line is dropped rather than held.
const QUEUE: usize = 4096;
/// How long a connect or a write may take before the line is given up.
const IO_TIMEOUT: Duration = Duration::from_secs(3);
/// After a failed connect, lines are dropped without trying again for this long,
/// so an unreachable server costs one attempt per window rather than one per
/// request.
const RETRY_AFTER: Duration = Duration::from_secs(5);

static QUEUE_TX: OnceLock<mpsc::Sender<String>> = OnceLock::new();
static DROPPED: AtomicU64 = AtomicU64::new(0);

/// Lines dropped since start: the queue was full or the server unreachable.
pub fn dropped() -> u64 {
    DROPPED.load(Ordering::Relaxed)
}

/// Start sending to `target`. Called once from `main.rs` when
/// `FATHOM_ACCESS_SYSLOG` is set; a second call does nothing.
pub fn start(target: SyslogTarget) {
    let (tx, rx) = mpsc::channel(QUEUE);
    if QUEUE_TX.set(tx).is_err() {
        return;
    }
    tokio::spawn(run(target, rx));
}

/// Queue one access line. Does nothing when no log server is set.
pub fn send(
    plane: &str,
    method: &str,
    path: &str,
    status: u16,
    client: &str,
    via: &str,
    host: &str,
) {
    let Some(tx) = QUEUE_TX.get() else { return };
    let line = render_line(
        crate::crypto::now_unix() as u64,
        plane,
        method,
        path,
        status,
        client,
        via,
        host,
    );
    if tx.try_send(line).is_err() {
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
}

/// One RFC 5424 line, without its framing LF. The plane goes in MSGID with its
/// space made `_`, so a collector can filter on it.
#[allow(clippy::too_many_arguments)]
pub fn render_line(
    unix: u64,
    plane: &str,
    method: &str,
    path: &str,
    status: u16,
    client: &str,
    via: &str,
    host: &str,
) -> String {
    format!(
        "<{PRI}>1 {timestamp} - {APP_NAME} - {msgid} - method={method} path={path} \
         status={status} client={client} via={via} host={host}",
        timestamp = timestamp(unix),
        msgid = sanitise(plane, 32),
        method = sanitise(method, 16),
        path = sanitise(path, 512),
        client = sanitise(client, 64),
        via = sanitise(via, 64),
        host = sanitise(host, 255),
    )
}

/// RFC 3339 in UTC, to the second.
fn timestamp(unix: u64) -> String {
    let s = unix % 86_400;
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        crate::backup::date(unix),
        s / 3600,
        (s / 60) % 60,
        s % 60
    )
}

async fn run(target: SyslogTarget, mut rx: mpsc::Receiver<String>) {
    let mut stream: Option<TcpStream> = None;
    let mut wait_until: Option<Instant> = None;
    let mut warned = false;
    while let Some(line) = rx.recv().await {
        if stream.is_none() {
            if wait_until.is_some_and(|t| Instant::now() < t) {
                DROPPED.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            match tokio::time::timeout(IO_TIMEOUT, TcpStream::connect(target.addr())).await {
                Ok(Ok(s)) => {
                    stream = Some(s);
                    wait_until = None;
                    if warned {
                        tracing::info!(destination = %target, "the access log server is reachable again");
                        warned = false;
                    }
                }
                _ => {
                    wait_until = Some(Instant::now() + RETRY_AFTER);
                    DROPPED.fetch_add(1, Ordering::Relaxed);
                    if !warned {
                        tracing::warn!(
                            destination = %target,
                            "the access log server is unreachable; access lines are dropped until \
                             it answers (the server's own log still has them)"
                        );
                        warned = true;
                    }
                    continue;
                }
            }
        }
        let Some(s) = stream.as_mut() else { continue };
        let mut framed = line.into_bytes();
        framed.push(b'\n');
        let wrote = tokio::time::timeout(IO_TIMEOUT, s.write_all(&framed)).await;
        if !matches!(wrote, Ok(Ok(()))) {
            stream = None;
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_names_the_client_and_the_proxy_and_cannot_be_split() {
        let line = render_line(
            1_793_131_179,
            "operator console",
            "POST",
            "/admin/settings\nforged=1",
            200,
            "203.0.113.7",
            "10.0.0.2",
            "admin.example",
        );
        assert!(line.starts_with("<110>1 2026-10-27T"), "{line}");
        assert!(
            line.contains(" fathom-access - operator_console - "),
            "{line}"
        );
        assert!(line.contains("client=203.0.113.7 via=10.0.0.2"), "{line}");
        assert!(!line.contains('\n'));
        assert!(
            !line.contains("forged=1"),
            "an `=` inside a value is replaced"
        );
    }

    #[test]
    fn the_timestamp_is_utc_to_the_second() {
        assert_eq!(timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(timestamp(86_399), "1970-01-01T23:59:59Z");
    }

    #[tokio::test]
    async fn lines_reach_a_listening_server() {
        use tokio::io::AsyncBufReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(run(SyslogTarget::parse(&addr.to_string()).unwrap(), rx));
        tx.send("<110>1 one".into()).await.unwrap();
        let (sock, _) = listener.accept().await.unwrap();
        let mut lines = tokio::io::BufReader::new(sock).lines();
        assert_eq!(
            lines.next_line().await.unwrap().as_deref(),
            Some("<110>1 one")
        );
        tx.send("<110>1 two".into()).await.unwrap();
        assert_eq!(
            lines.next_line().await.unwrap().as_deref(),
            Some("<110>1 two")
        );
    }
}
