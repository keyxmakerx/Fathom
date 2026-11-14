//! The sealed outbox (`migrations/0079_mail_outbox.sql`, ADR-0085 decision 7).
//!
//! [`enqueue`] runs inside the caller's transaction, so a mail exists exactly when the act that
//! caused it committed. [`claim_due`] and [`finish`] are the worker's: claiming moves a row's
//! next try fifteen minutes on before anything is sent, so two servers sharing a database do not
//! both send it, and a server that dies mid-send tries again later rather than never.

use std::sync::Arc;

use deadpool_postgres::{Pool, Transaction};

use crate::crypto::{self, Key32, NONCE_LEN};
use crate::grants;
use crate::ids;
use crate::keys::KeyRing;

const KDF_MAIL_OUTBOX: &[u8] = b"fathom/mail/outbox/v1";
const AAD_MAIL_OUTBOX: &[u8] = b"fathom/mail/outbox/aad/v1";

/// The waits after the first five failed tries; the sixth failure is final.
pub const RETRY_SECONDS: [i64; 5] = [60, 5 * 60, 30 * 60, 2 * 3600, 12 * 3600];
/// The most tries one mail gets.
pub const MAX_ATTEMPTS: i32 = 6;
/// How long a claimed mail is held before another worker may try it.
pub const LEASE_SECONDS: i64 = 15 * 60;
/// How long a finished row is kept for Admin › Mail.
pub const KEEP_DAYS: i64 = 90;

/// Which mail it is. Decides nothing but the words in Admin › Mail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Reset,
    Invitation,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reset => "reset",
            Self::Invitation => "invitation",
        }
    }
}

/// A mail to write. Everything but `organisation`, `kind` and `expires_at_unix` is sealed.
pub struct Draft {
    pub organisation: Option<String>,
    pub kind: Kind,
    pub to: String,
    /// A few words for Admin › Mail: "Invitation for Sam Lee".
    pub what: String,
    pub subject: String,
    pub text: String,
    pub html: String,
    /// After this the mail is not worth sending (the link in it has stopped working).
    pub expires_at_unix: i64,
}

impl core::fmt::Debug for Draft {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Draft")
            .field("organisation", &self.organisation)
            .field("kind", &self.kind)
            .field("body", &"<not printed>")
            .finish()
    }
}

/// A mail the worker holds.
pub struct Due {
    pub id: String,
    pub attempts: i32,
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// One row as Admin › Mail shows it.
#[derive(Debug, Clone)]
pub struct Listed {
    pub id: String,
    pub kind: Kind,
    pub state: &'static str,
    pub to: String,
    pub what: String,
    pub attempts: i32,
    pub created_at_unix: i64,
    pub next_attempt_at_unix: Option<i64>,
    pub finished_at_unix: Option<i64>,
    pub last_reply: Option<String>,
}

#[derive(Debug)]
pub enum MailError {
    Db(tokio_postgres::Error),
    Pool(deadpool_postgres::PoolError),
    Key(grants::AuthorityError),
    Crypto(crypto::CryptoError),
    /// A row did not open or parse.
    Corrupt(&'static str),
}

impl core::fmt::Display for MailError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database: {e}"),
            Self::Pool(e) => write!(f, "pool: {e}"),
            Self::Key(e) => write!(f, "key: {e}"),
            Self::Crypto(_) => write!(f, "crypto"),
            Self::Corrupt(what) => write!(f, "corrupt: {what}"),
        }
    }
}
impl std::error::Error for MailError {}
impl From<tokio_postgres::Error> for MailError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}
impl From<deadpool_postgres::PoolError> for MailError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        Self::Pool(e)
    }
}
impl From<grants::AuthorityError> for MailError {
    fn from(e: grants::AuthorityError) -> Self {
        Self::Key(e)
    }
}
impl From<crypto::CryptoError> for MailError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::Crypto(e)
    }
}

async fn outbox_key(tx: &Transaction<'_>, ring: &KeyRing) -> Result<Key32, MailError> {
    let site = grants::site_chain_key(tx, ring).await?;
    Ok(crypto::hkdf_expand(&site, KDF_MAIL_OUTBOX))
}

fn aad(id: &str, part: &str) -> Vec<u8> {
    let mut a = Vec::with_capacity(64);
    crypto::lp(&mut a, AAD_MAIL_OUTBOX);
    crypto::lp(&mut a, id.as_bytes());
    crypto::lp(&mut a, part.as_bytes());
    a
}

fn pack(fields: &[&str]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in fields {
        crypto::lp(&mut out, f.as_bytes());
    }
    out
}

fn unpack(bytes: &[u8], n: usize) -> Result<Vec<String>, MailError> {
    let mut rest = bytes;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let (f, r) = crypto::read_lp(rest).ok_or(MailError::Corrupt("mail fields"))?;
        out.push(String::from_utf8(f.to_vec()).map_err(|_| MailError::Corrupt("mail fields"))?);
        rest = r;
    }
    if !rest.is_empty() {
        return Err(MailError::Corrupt("mail fields"));
    }
    Ok(out)
}

fn open_part(
    key: &Key32,
    id: &str,
    part: &str,
    ct: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>, MailError> {
    let nonce: [u8; NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| MailError::Corrupt("mail nonce"))?;
    crypto::open(key, &nonce, ct, &aad(id, part)).map_err(|_| MailError::Corrupt("mail seal"))
}

async fn custody(tx: &Transaction<'_>, on: bool) -> Result<(), MailError> {
    tx.execute(
        "SELECT set_config('app.mail_custody', $1, true)",
        &[&if on { "yes" } else { "no" }],
    )
    .await?;
    Ok(())
}

/// Write a mail, in the caller's transaction. Answers its id.
pub async fn enqueue(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    draft: &Draft,
) -> Result<String, MailError> {
    let id = format!("mail_{}", ids::new_ulid());
    let key = outbox_key(tx, ring).await?;
    let summary = pack(&[&draft.to, &draft.what]);
    let body = pack(&[&draft.to, &draft.subject, &draft.text, &draft.html]);
    let summary_nonce = crypto::random_nonce()?;
    let body_nonce = crypto::random_nonce()?;
    let summary_ct = crypto::seal(&key, &summary_nonce, &summary, &aad(&id, "summary"))?;
    let body_ct = crypto::seal(&key, &body_nonce, &body, &aad(&id, "body"))?;
    custody(tx, true).await?;
    tx.execute(
        "INSERT INTO mail_outbox (id, organisation_id, kind, state, summary_ct, summary_nonce, \
                                  body_ct, body_nonce, expires_at) \
         VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, to_timestamp($8))",
        &[
            &id,
            &draft.organisation,
            &draft.kind.as_str(),
            &summary_ct,
            &summary_nonce.as_slice(),
            &body_ct,
            &body_nonce.as_slice(),
            &(draft.expires_at_unix as f64),
        ],
    )
    .await?;
    custody(tx, false).await?;
    Ok(id)
}

/// Fail every queued mail whose link has stopped working, then claim up to `limit` that are due.
pub async fn claim_due(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    limit: i64,
) -> Result<Vec<Due>, MailError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    custody(&tx, true).await?;
    tx.execute(
        "UPDATE mail_outbox SET state = 'failed', body_ct = NULL, body_nonce = NULL, \
                finished_at = now(), \
                last_reply = 'It expired before it could be sent.' \
          WHERE state = 'queued' AND expires_at <= now()",
        &[],
    )
    .await?;
    let rows = tx
        .query(
            "SELECT id, attempts, body_ct, body_nonce FROM mail_outbox \
              WHERE state = 'queued' AND next_attempt_at <= now() \
              ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED",
            &[&limit],
        )
        .await?;
    let mut due = Vec::with_capacity(rows.len());
    if !rows.is_empty() {
        let key = outbox_key(&tx, ring).await?;
        for row in rows {
            let id: String = row.get(0);
            tx.execute(
                "UPDATE mail_outbox SET next_attempt_at = now() + make_interval(secs => $2) \
                  WHERE id = $1",
                &[&id, &(LEASE_SECONDS as f64)],
            )
            .await?;
            let ct: Vec<u8> = row.get(2);
            let nonce: Vec<u8> = row.get(3);
            match open_part(&key, &id, "body", &ct, &nonce).and_then(|b| unpack(&b, 4)) {
                Ok(mut f) => {
                    let html = f.pop().unwrap_or_default();
                    let text = f.pop().unwrap_or_default();
                    let subject = f.pop().unwrap_or_default();
                    let to = f.pop().unwrap_or_default();
                    due.push(Due {
                        id,
                        attempts: row.get(1),
                        to,
                        subject,
                        text,
                        html,
                    });
                }
                Err(_) => {
                    // A body that does not open (a rekeyed chain master, or a row written by
                    // hand) is failed rather than retried for ever.
                    tx.execute(
                        "UPDATE mail_outbox SET state = 'failed', body_ct = NULL, \
                                body_nonce = NULL, finished_at = now(), \
                                last_reply = 'Fathom could not open this mail to send it.' \
                          WHERE id = $1",
                        &[&id],
                    )
                    .await?;
                }
            }
        }
    }
    custody(&tx, false).await?;
    tx.commit().await?;
    Ok(due)
}

/// How one try ended.
pub enum Outcome {
    Sent(String),
    Refused { reply: String, permanent: bool },
}

/// Record one try. A refusal that is worth another try waits [`RETRY_SECONDS`]; the sixth, or
/// a permanent one, is final. Either way a finished mail loses its body.
pub async fn finish(
    pool: &Pool,
    id: &str,
    attempts_before: i32,
    outcome: Outcome,
) -> Result<(), MailError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    custody(&tx, true).await?;
    let attempts = attempts_before + 1;
    match outcome {
        Outcome::Sent(reply) => {
            tx.execute(
                "UPDATE mail_outbox SET state = 'sent', body_ct = NULL, body_nonce = NULL, \
                        attempts = $2, finished_at = now(), last_reply = $3 \
                  WHERE id = $1 AND state = 'queued'",
                &[&id, &attempts, &truncate(&reply)],
            )
            .await?;
        }
        Outcome::Refused { reply, permanent } if permanent || attempts >= MAX_ATTEMPTS => {
            tx.execute(
                "UPDATE mail_outbox SET state = 'failed', body_ct = NULL, body_nonce = NULL, \
                        attempts = $2, finished_at = now(), last_reply = $3 \
                  WHERE id = $1 AND state = 'queued'",
                &[&id, &attempts, &truncate(&reply)],
            )
            .await?;
        }
        Outcome::Refused { reply, .. } => {
            let wait = RETRY_SECONDS[(attempts - 1).clamp(0, 4) as usize];
            tx.execute(
                "UPDATE mail_outbox SET attempts = $2, last_reply = $3, \
                        next_attempt_at = now() + make_interval(secs => $4) \
                  WHERE id = $1 AND state = 'queued'",
                &[&id, &attempts, &truncate(&reply), &(wait as f64)],
            )
            .await?;
        }
    }
    custody(&tx, false).await?;
    tx.commit().await?;
    Ok(())
}

/// Forget finished mail older than [`KEEP_DAYS`].
pub async fn prune(pool: &Pool) -> Result<u64, MailError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    custody(&tx, true).await?;
    let n = tx
        .execute(
            "DELETE FROM mail_outbox WHERE state <> 'queued' \
               AND finished_at < now() - make_interval(days => $1)",
            &[&(KEEP_DAYS as i32)],
        )
        .await?;
    custody(&tx, false).await?;
    tx.commit().await?;
    Ok(n)
}

/// The newest `limit` mails of one organisation, in the caller's transaction. **The caller has
/// already checked the reader is a Steward of that organisation.**
pub async fn list_for_organisation(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
    limit: i64,
) -> Result<Vec<Listed>, MailError> {
    custody(tx, true).await?;
    let rows = tx
        .query(
            "SELECT id, kind, state, summary_ct, summary_nonce, attempts, \
                    EXTRACT(EPOCH FROM created_at)::bigint, \
                    CASE WHEN state = 'queued' THEN EXTRACT(EPOCH FROM next_attempt_at)::bigint END, \
                    EXTRACT(EPOCH FROM finished_at)::bigint, last_reply \
               FROM mail_outbox WHERE organisation_id = $1 \
              ORDER BY created_at DESC, id DESC LIMIT $2",
            &[&organisation, &limit],
        )
        .await?;
    let key = if rows.is_empty() {
        None
    } else {
        Some(outbox_key(tx, ring).await?)
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get(0);
        let kind: String = row.get(1);
        let state: String = row.get(2);
        let ct: Vec<u8> = row.get(3);
        let nonce: Vec<u8> = row.get(4);
        let (to, what) = match key
            .as_ref()
            .ok_or(MailError::Corrupt("mail key"))
            .and_then(|k| open_part(k, &id, "summary", &ct, &nonce))
            .and_then(|b| unpack(&b, 2))
        {
            Ok(mut f) => {
                let what = f.pop().unwrap_or_default();
                (f.pop().unwrap_or_default(), what)
            }
            Err(_) => (String::new(), "A mail Fathom could not open".to_string()),
        };
        out.push(Listed {
            id,
            kind: if kind == "reset" {
                Kind::Reset
            } else {
                Kind::Invitation
            },
            state: match state.as_str() {
                "queued" => "queued",
                "sent" => "sent",
                _ => "failed",
            },
            to,
            what,
            attempts: row.get(5),
            created_at_unix: row.get(6),
            next_attempt_at_unix: row.get(7),
            finished_at_unix: row.get(8),
            last_reply: row.get(9),
        });
    }
    custody(tx, false).await?;
    Ok(out)
}

fn truncate(s: &str) -> String {
    s.chars().take(400).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_round_trip_and_extra_bytes_are_refused() {
        let packed = pack(&["a@b.c", "Reset", "t", "<p>h</p>"]);
        assert_eq!(unpack(&packed, 4).unwrap()[3], "<p>h</p>");
        let mut longer = packed.clone();
        longer.push(0);
        assert!(unpack(&longer, 4).is_err());
    }

    #[test]
    fn the_retry_schedule_is_the_decided_one() {
        // ADR-0085 decision 7: 1, 5, 30 minutes, then 2 and 12 hours; then failed.
        assert_eq!(RETRY_SECONDS, [60, 300, 1800, 7200, 43200]);
        assert_eq!(MAX_ATTEMPTS as usize, RETRY_SECONDS.len() + 1);
    }

    #[test]
    fn a_summary_does_not_open_as_a_body() {
        let key = Key32::from_bytes([7u8; 32]);
        let nonce = [1u8; NONCE_LEN];
        let ct = crypto::seal(&key, &nonce, b"x", &aad("mail_1", "summary")).unwrap();
        assert!(open_part(&key, "mail_1", "body", &ct, &nonce).is_err());
        assert!(open_part(&key, "mail_2", "summary", &ct, &nonce).is_err());
        assert!(open_part(&key, "mail_1", "summary", &ct, &nonce).is_ok());
    }
}
