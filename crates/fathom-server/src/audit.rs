//! Getting sealed entries off the box — **first cut**.
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §9, and §15.6 for what is
//! deliberately not here.
//!
//! # What this is, stated narrowly, because the alternative is a control that
//! evaporates on the day it is installed
//!
//! This ships each sealed entry as one RFC 5424 syslog line over TCP to a
//! destination the operator configures, spooling in PostgreSQL when that
//! destination is unreachable. That is all it is.
//!
//! **It is not an anchor and nothing may call it one.** §7.4 is blunt about
//! why: *"a tip digest counts as anchored only when a receipt comes back signed
//! by a key the server never holds."* The configuration a careful operator
//! chooses on install day — when the SIEM is not ready and the spool is filling
//! — is rsyslog in the same compose file on the same host, at which point every
//! guarantee is held on the box the attacker owns while the product reports
//! itself healthy. A receipt the server cannot forge is the only thing that
//! distinguishes a witness from a folder, and **there are no receipts yet**.
//!
//! Deferred per §15.6, and absent rather than weakened:
//!
//! - **Receipts and witness countersignatures (§7.4).** Without them, §7.5's
//!   guarantees 1 and 2 do not hold at all: entries are not fixed off-box, and
//!   a gap is not visible off-box within a cadence.
//! - **Heartbeats (§7.5).** A gap is an incident *at the witness*. With no
//!   witness there is nobody to notice silence, so a heartbeat stream would
//!   cost rows and prove nothing.
//! - **The witness challenge-back, anchors, and startup quarantine (§7.6).**
//! - **§9's escalating banners and the `unwitnessed` marking in every session.**
//!   Those need surfaces that do not exist. What exists instead is an honest
//!   startup log line and a warning when the spool is not draining.
//!
//! A deployment running this is `unwitnessed` in §9's sense, permanently, until
//! receipts land.
//!
//! # Two properties this does hold, and they are the ones §9 asks for first
//!
//! **Nothing is ever dropped.** The spool row is written in the *same
//! transaction* as the chain entry it describes, so an act that cannot queue
//! its audit line does not commit — that is what makes *"stopping the log stops
//! the act"* mechanical rather than aspirational. A row leaves the spool only
//! after the destination accepted the bytes.
//!
//! **The shipper never blocks a write.** The write path does one `INSERT` and
//! touches no socket. Shipping is a background task reading a shared table, so
//! a destination that accepts connections and never reads cannot stall a single
//! request. §9 is explicit that a fail-closed rule here would hand whoever
//! points the shipper at such a host a one-click site-wide outage, and
//! *"availability is not defended against the party who holds the machine"*.
//!
//! # No crate
//!
//! Syslog is a line on a socket. `tokio::net::TcpStream` and a `String`.
//!
//! # The wire format, and what was actually read
//!
//! Checked on 2026-09-12. `www.rfc-editor.org`, `datatracker.ietf.org` and
//! `www.ietf.org` are all blocked by this environment's egress proxy — the same
//! blockage `PHASE-2-STORAGE-DESIGN.md` §12.6 records — so **the RFC texts
//! themselves were not read**, and every fact below came from two independent
//! secondary sources rather than one. That is weaker evidence than the standard
//! and is recorded as such.
//!
//! - `HEADER = PRI VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP
//!   MSGID`, then `SP STRUCTURED-DATA [SP MSG]` (RFC 5424 §6).
//! - `PRI = facility * 8 + severity`. Facility 13 is *log audit*, severity 5 is
//!   *Notice*, so `<109>`.
//! - `NILVALUE` is `-`, used for any field the sender cannot determine.
//! - Field limits: HOSTNAME 255, APP-NAME 48, PROCID 128, MSGID 32 octets of
//!   printable US-ASCII.
//! - A receiver must accept at least 480 octets and should accept 2048.
//!
//! **`STRUCTURED-DATA` is `-` and the facts go in `MSG` as `key=value`.** An
//! SD-ID containing `@` requires an IANA Private Enterprise Number, and Fathom
//! has none. Inventing one would be fabricating a registry entry, so the
//! structured-data field is the nil value and nothing claims otherwise.
//!
//! **Framing is LF, RFC 6587 §3.4.2 non-transparent-framing**, not §3.4.1
//! octet-counting. Octet-counting is the more robust of the two and the one
//! that RFC's own text prefers; LF is what receivers default to, and its stated
//! defect — a message containing an LF being read as several messages — cannot
//! occur here because [`render_line`] emits a fixed set of ASCII-safe fields
//! and [`sanitise`] replaces everything else. That is checked by a test rather
//! than asserted.
//!
//! # What a line discloses
//!
//! Exactly §7.3's in-the-clear list: `seq`, `entry_type`, the chain kind and
//! id, the timestamp, `chain_key_epoch` and the seal. **No metadata** — not the
//! plaintext of a design entry and not the ciphertext of an organisation one,
//! which would be a second copy of a thing already stored once. So a SIEM
//! learns *that* an entry of a given type happened for a given id at a given
//! time, which is what it needs to notice a gap or a burst, and nothing about
//! what the entry says.

use core::fmt;
use core::time::Duration;

use deadpool_postgres::{Pool, Transaction};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

use crate::chain::{ChainKind, EntryType};

/// Facility 13 (*log audit*) times 8, plus severity 5 (*Notice*).
const PRI: u8 = 13 * 8 + 5;

/// RFC 5424's version field. There is exactly one version.
const SYSLOG_VERSION: u8 = 1;

/// `APP-NAME`. 12 octets, inside the 48 the format allows.
const APP_NAME: &str = "fathom-audit";

/// How many entries one drain attempt ships before returning.
///
/// Small on purpose. A failure part-way through a batch re-sends the whole
/// batch, because the alternative — deleting rows the far end may not have
/// received — drops evidence, and §9's rule is that nothing is ever dropped. A
/// small batch bounds how much duplication that costs; the `seq` is in every
/// line, so a duplicate is detectable at the far end, and a gap is not.
const BATCH: i64 = 64;

/// How often the shipper tries.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(5);

/// How PostgreSQL renders `occurred_at` — RFC 3339, UTC, microseconds.
///
/// Done in SQL rather than in Rust because formatting a timestamp otherwise
/// means a date crate, and this is one `to_char` call. The `"T"` and `"Z"` are
/// quoted so `to_char` treats them as literals rather than as pattern letters.
const TIMESTAMP_FORMAT: &str = "YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"";

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/// Queue one sealed entry for shipping.
///
/// **Called inside the transaction that wrote the entry, always.** See the
/// module doc: that is the whole of *"stopping the log stops the act"*. A
/// caller that queued afterwards, in its own transaction, would have written
/// the act and lost the record on any failure between the two.
pub async fn spool(
    tx: &Transaction<'_>,
    chain_kind: ChainKind,
    chain_id: &str,
    seq: i64,
    entry_type: EntryType,
    chain_key_epoch: i32,
    seal: &[u8; 32],
) -> Result<(), tokio_postgres::Error> {
    tx.execute(
        "INSERT INTO audit_spool \
             (chain_kind, chain_id, seq, entry_type, chain_key_epoch, seal, occurred_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now()) \
         ON CONFLICT (chain_kind, chain_id, seq) DO NOTHING",
        &[
            &chain_kind.as_str(),
            &chain_id,
            &seq,
            &entry_type.as_str(),
            &chain_key_epoch,
            &seal.to_vec(),
        ],
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The destination
// ---------------------------------------------------------------------------

/// Where sealed entries are shipped. `host:port`, TCP.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyslogTarget {
    addr: String,
}

/// Why `FATHOM_AUDIT_SYSLOG` could not be read.
#[derive(Debug, PartialEq, Eq)]
pub enum TargetError {
    /// A scheme was given. **Refused rather than ignored**: an operator who
    /// writes `udp://` has said something about delivery that this shipper
    /// cannot honour, and silently sending TCP instead would leave them
    /// believing a thing that is not true.
    HasScheme,
    /// No port, an unparseable port, or an empty host.
    NotHostAndPort,
}

impl fmt::Display for TargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HasScheme => f.write_str(
                "FATHOM_AUDIT_SYSLOG takes a bare host:port and no scheme. TCP is the only \
                 transport this shipper speaks; accepting a udp:// or tls:// prefix and then \
                 sending plain TCP would tell an operator something untrue about their audit \
                 path.",
            ),
            Self::NotHostAndPort => f.write_str(
                "FATHOM_AUDIT_SYSLOG must be host:port -- for example 10.0.0.5:514, or \
                 [2001:db8::1]:514 for a literal IPv6 address.",
            ),
        }
    }
}

impl std::error::Error for TargetError {}

impl SyslogTarget {
    /// Parse `host:port`, or a bracketed IPv6 literal with a port.
    ///
    /// Not resolved here. A name resolved once at startup is a name that stops
    /// working when the SIEM moves, and a shipper that fails for an hour after
    /// a DNS change is one an operator turns off.
    pub fn parse(raw: &str) -> Result<Self, TargetError> {
        let raw = raw.trim();
        if raw.contains("://") {
            return Err(TargetError::HasScheme);
        }
        let (host, port) = if let Some(rest) = raw.strip_prefix('[') {
            let (host, rest) = rest.split_once(']').ok_or(TargetError::NotHostAndPort)?;
            let port = rest.strip_prefix(':').ok_or(TargetError::NotHostAndPort)?;
            (host, port)
        } else {
            raw.rsplit_once(':').ok_or(TargetError::NotHostAndPort)?
        };
        if host.is_empty() {
            return Err(TargetError::NotHostAndPort);
        }
        let port: u16 = port.parse().map_err(|_| TargetError::NotHostAndPort)?;
        if port == 0 {
            return Err(TargetError::NotHostAndPort);
        }
        Ok(Self {
            addr: raw.to_string(),
        })
    }

    /// The address, for a log line and for `TcpStream::connect`. Never carries
    /// a credential — a syslog destination has none.
    pub fn addr(&self) -> &str {
        &self.addr
    }
}

impl fmt::Display for SyslogTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.addr)
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// One spooled entry, as the shipper reads it back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpooledEntry {
    pub spool_seq: i64,
    pub chain_kind: String,
    pub chain_id: String,
    pub seq: i64,
    pub entry_type: String,
    pub chain_key_epoch: i32,
    pub seal_hex: String,
    /// Already RFC 3339, rendered by PostgreSQL — see [`TIMESTAMP_FORMAT`].
    pub occurred_at: String,
}

/// Everything outside this set becomes `_`.
///
/// Printable US-ASCII minus space, which is RFC 5424's separator, and minus
/// `=` so a `key=value` pair cannot be forged from inside a value. **This is
/// what makes LF framing safe**: no rendered field can contain the byte that
/// ends a frame. Every value that reaches it is already an opaque id, an entry
/// type, a number or hex, so in practice it changes nothing — which is the
/// point. A sanitiser that fires is a sanitiser somebody will later decide to
/// remove.
fn sanitise(value: &str, max: usize) -> String {
    let mut out = String::with_capacity(value.len().min(max));
    for ch in value.chars() {
        if out.len() >= max {
            break;
        }
        let ok = ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '/' | '+');
        out.push(if ok { ch } else { '_' });
    }
    if out.is_empty() {
        out.push('-');
    }
    out
}

/// One RFC 5424 line, without its framing LF.
///
/// See the module doc for what was read, what was not, and why
/// `STRUCTURED-DATA` is the nil value.
pub fn render_line(entry: &SpooledEntry) -> String {
    // HOSTNAME and PROCID are the nil value. A container's hostname is a random
    // hex string that identifies nothing an operator can act on, and claiming
    // an identity this process cannot establish is worse than saying it does
    // not know. The chain id in MSG is the identity that matters.
    format!(
        "<{PRI}>{SYSLOG_VERSION} {timestamp} - {APP_NAME} - {msgid} - \
         chain_kind={kind} chain_id={id} seq={seq} chain_key_epoch={epoch} seal={seal}",
        timestamp = sanitise(&entry.occurred_at, 64),
        msgid = sanitise(&entry.entry_type, 32),
        kind = sanitise(&entry.chain_kind, 16),
        id = sanitise(&entry.chain_id, 64),
        seq = entry.seq,
        epoch = entry.chain_key_epoch,
        seal = sanitise(&entry.seal_hex, 64),
    )
}

// ---------------------------------------------------------------------------
// Shipping
// ---------------------------------------------------------------------------

/// What one drain attempt did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Drained {
    /// Entries the destination accepted, and which have left the spool.
    pub shipped: usize,
    /// Entries still queued after this attempt.
    pub remaining: i64,
}

/// Why a drain attempt failed. Never carries anything but an address and an
/// operating-system message.
#[derive(Debug)]
pub enum ShipError {
    Db(tokio_postgres::Error),
    Unreachable(std::io::Error),
    Write(std::io::Error),
}

impl fmt::Display for ShipError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Unreachable(e) => write!(f, "the audit destination is unreachable: {e}"),
            Self::Write(e) => write!(f, "the audit destination stopped accepting: {e}"),
        }
    }
}

impl std::error::Error for ShipError {}

impl From<tokio_postgres::Error> for ShipError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}

/// Read one batch of spooled entries, oldest first.
pub async fn peek<C>(client: &C, limit: i64) -> Result<Vec<SpooledEntry>, tokio_postgres::Error>
where
    C: tokio_postgres::GenericClient,
{
    let rows = client
        .query(
            &format!(
                "SELECT spool_seq, chain_kind, chain_id, seq, entry_type, chain_key_epoch, \
                        encode(seal, 'hex'), \
                        to_char(occurred_at AT TIME ZONE 'UTC', '{TIMESTAMP_FORMAT}') \
                 FROM audit_spool ORDER BY spool_seq LIMIT $1"
            ),
            &[&limit],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| SpooledEntry {
            spool_seq: row.get(0),
            chain_kind: row.get(1),
            chain_id: row.get(2),
            seq: row.get(3),
            entry_type: row.get(4),
            chain_key_epoch: row.get(5),
            seal_hex: row.get(6),
            occurred_at: row.get(7),
        })
        .collect())
}

/// How many entries are waiting.
pub async fn depth<C>(client: &C) -> Result<i64, tokio_postgres::Error>
where
    C: tokio_postgres::GenericClient,
{
    let row = client
        .query_one("SELECT count(*) FROM audit_spool", &[])
        .await?;
    Ok(row.get(0))
}

/// Try once to drain the spool to `target`.
///
/// Exposed rather than hidden inside the loop so a test can drive it
/// deterministically: *"kill the destination, prove the act applied and the
/// entry spooled; bring it back, prove the spool drained in order"* is three
/// calls to this, not a race against a timer.
///
/// # In order, and the order is `spool_seq`
///
/// Three chains interleave in one queue, and `spool_seq` is the only total
/// order over them. Within a chain it agrees with `seq`, because the spool row
/// and the entry are written in one transaction.
///
/// # Where "accepted" stops meaning anything
///
/// A `write_all` that returns `Ok` has put bytes in a socket. It does not mean
/// the far end parsed them, stored them, or still exists. **Receipts are what
/// would make this claim real and they are deferred** (§15.6) — so the spool's
/// notion of shipped is *handed to the socket*, and the module doc says so
/// rather than letting the word imply more.
pub async fn drain_once<C>(client: &C, target: &SyslogTarget) -> Result<Drained, ShipError>
where
    C: tokio_postgres::GenericClient,
{
    let batch = peek(client, BATCH).await?;
    if batch.is_empty() {
        return Ok(Drained {
            shipped: 0,
            remaining: 0,
        });
    }

    let mut stream = match TcpStream::connect(target.addr()).await {
        Ok(s) => s,
        Err(e) => {
            note_failure(client, &batch, &e.to_string()).await?;
            return Err(ShipError::Unreachable(e));
        }
    };

    let mut wire = String::new();
    for entry in &batch {
        wire.push_str(&render_line(entry));
        // RFC 6587 §3.4.2 framing. Safe only because `sanitise` guarantees no
        // rendered field contains one; `a_rendered_line_never_contains_the_frame_terminator`
        // is what holds that rather than this comment.
        wire.push('\n');
    }

    if let Err(e) = stream.write_all(wire.as_bytes()).await {
        note_failure(client, &batch, &e.to_string()).await?;
        return Err(ShipError::Write(e));
    }
    if let Err(e) = stream.flush().await {
        note_failure(client, &batch, &e.to_string()).await?;
        return Err(ShipError::Write(e));
    }

    // Only now. A row deleted before the bytes were accepted is evidence
    // dropped, and §9's rule is that nothing is ever dropped -- a duplicate at
    // the far end is detectable from the `seq` in the line, and a gap is not.
    let ids: Vec<i64> = batch.iter().map(|e| e.spool_seq).collect();
    client
        .execute("DELETE FROM audit_spool WHERE spool_seq = ANY($1)", &[&ids])
        .await?;

    Ok(Drained {
        shipped: batch.len(),
        remaining: depth(client).await?,
    })
}

/// Record that an attempt failed, on the rows it failed for.
///
/// The message is truncated and comes from the operating system: a connect or
/// write error carries an address and an errno, never a credential.
async fn note_failure<C>(
    client: &C,
    batch: &[SpooledEntry],
    why: &str,
) -> Result<(), tokio_postgres::Error>
where
    C: tokio_postgres::GenericClient,
{
    let ids: Vec<i64> = batch.iter().map(|e| e.spool_seq).collect();
    let why: String = why.chars().take(200).collect();
    client
        .execute(
            "UPDATE audit_spool SET attempts = attempts + 1, last_error = $2 \
             WHERE spool_seq = ANY($1)",
            &[&ids, &why],
        )
        .await?;
    Ok(())
}

/// Run the shipper until the process ends.
///
/// **Never blocks a write.** It holds its own pooled connection and reads a
/// shared table; the write path does one `INSERT` and touches no socket. A
/// destination that accepts connections and never reads stalls this task and
/// nothing else, which is §9's requirement rather than an accident of the
/// implementation.
pub fn spawn(pool: Pool, target: SyslogTarget, interval: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // Logged on transitions only. A destination that is down for a day at
        // a five-second cadence would otherwise write seventeen thousand
        // identical lines, and an operator who has learned to filter them out
        // is an operator who will not see the one that matters.
        let mut reachable = true;
        loop {
            tokio::time::sleep(interval).await;

            let client = match pool.get().await {
                Ok(c) => c,
                Err(_) => continue,
            };

            match drain_once(&**client, &target).await {
                Ok(drained) => {
                    if !reachable {
                        tracing::info!(
                            destination = %target,
                            shipped = drained.shipped,
                            remaining = drained.remaining,
                            "the audit destination is reachable again; the spool is draining in \
                             order"
                        );
                        reachable = true;
                    }
                }
                Err(e) => {
                    if reachable {
                        let waiting = depth(&**client).await.unwrap_or(-1);
                        tracing::warn!(
                            destination = %target,
                            error = %e,
                            spooled = waiting,
                            "the audit destination is unreachable. Entries are spooling in \
                             PostgreSQL and nothing is being dropped; acts continue to apply. \
                             This deployment is unwitnessed: no receipt has ever been \
                             countersigned, so the destination is a folder and not an anchor."
                        );
                        reachable = false;
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn an_entry() -> SpooledEntry {
        SpooledEntry {
            spool_seq: 1,
            chain_kind: "org".to_string(),
            chain_id: "01JQZ0000000000000000000AA".to_string(),
            seq: 4,
            entry_type: "rewrap".to_string(),
            chain_key_epoch: 1,
            seal_hex: "ab".repeat(32),
            occurred_at: "2026-09-12T10:11:12.123456Z".to_string(),
        }
    }

    #[test]
    fn a_line_has_the_header_rfc_5424_specifies() {
        let line = render_line(&an_entry());
        // PRI: facility 13 (log audit) * 8 + severity 5 (notice).
        assert!(line.starts_with("<109>1 "), "{line}");
        let fields: Vec<&str> = line.splitn(7, ' ').collect();
        assert_eq!(fields[0], "<109>1");
        assert_eq!(fields[1], "2026-09-12T10:11:12.123456Z");
        assert_eq!(fields[2], "-", "HOSTNAME is the nil value");
        assert_eq!(fields[3], "fathom-audit");
        assert_eq!(fields[4], "-", "PROCID is the nil value");
        assert_eq!(fields[5], "rewrap", "MSGID is the entry type");
        assert!(
            fields[6].starts_with("- chain_kind="),
            "STRUCTURED-DATA must be the nil value -- Fathom has no Private Enterprise Number \
             and an SD-ID with @ requires one: {line}"
        );
    }

    #[test]
    fn a_line_carries_what_7_3_says_is_in_the_clear_and_nothing_else() {
        let line = render_line(&an_entry());
        for expected in [
            "chain_kind=org",
            "chain_id=01JQZ0000000000000000000AA",
            "seq=4",
            "chain_key_epoch=1",
        ] {
            assert!(line.contains(expected), "{expected} missing from {line}");
        }
        assert!(line.contains(&"ab".repeat(32)), "{line}");
        // And nothing that would be a second copy of the metadata.
        assert!(!line.contains("metadata"), "{line}");
    }

    #[test]
    fn a_rendered_line_never_contains_the_frame_terminator() {
        // LF framing (RFC 6587 §3.4.2) is safe only if no field can contain an
        // LF. Driven over values no caller would produce, because the check is
        // about what the renderer GUARANTEES rather than what it is usually
        // given -- a control tested against its own happy path is not a
        // control.
        let hostile = SpooledEntry {
            spool_seq: 1,
            chain_kind: "org\nchain_kind=site".to_string(),
            chain_id: "id with spaces\r\n<0>1 forged".to_string(),
            seq: 1,
            entry_type: "type\nwith\nnewlines".to_string(),
            chain_key_epoch: 1,
            seal_hex: "00\n11".to_string(),
            occurred_at: "not\na\ntimestamp".to_string(),
        };
        let line = render_line(&hostile);
        assert!(!line.contains('\n'), "{line:?}");
        assert!(!line.contains('\r'), "{line:?}");
        // A forged second message cannot be smuggled in either: the injected
        // PRI is neutralised along with the newline.
        assert!(!line.contains("<0>1 forged"), "{line:?}");
    }

    #[test]
    fn the_msgid_stays_inside_rfc_5424s_thirty_two_octets() {
        let mut entry = an_entry();
        entry.entry_type = "a".repeat(100);
        let line = render_line(&entry);
        let msgid = line.split(' ').nth(5).unwrap();
        assert_eq!(msgid.len(), 32, "{line}");
    }

    #[test]
    fn a_destination_is_host_and_port_and_a_scheme_is_refused() {
        assert_eq!(
            SyslogTarget::parse("10.0.0.5:514").unwrap().addr(),
            "10.0.0.5:514"
        );
        assert_eq!(
            SyslogTarget::parse("  siem.internal:6514  ")
                .unwrap()
                .addr(),
            "siem.internal:6514"
        );
        assert_eq!(
            SyslogTarget::parse("[2001:db8::1]:514").unwrap().addr(),
            "[2001:db8::1]:514"
        );

        // A scheme is refused rather than ignored: an operator who wrote
        // `udp://` has said something this shipper cannot honour.
        assert_eq!(
            SyslogTarget::parse("udp://10.0.0.5:514").unwrap_err(),
            TargetError::HasScheme
        );
        assert_eq!(
            SyslogTarget::parse("tcp://10.0.0.5:514").unwrap_err(),
            TargetError::HasScheme
        );

        for bad in [
            "10.0.0.5",
            ":514",
            "10.0.0.5:",
            "10.0.0.5:0",
            "host:portname",
        ] {
            assert_eq!(
                SyslogTarget::parse(bad).unwrap_err(),
                TargetError::NotHostAndPort,
                "{bad}"
            );
        }
    }
}
