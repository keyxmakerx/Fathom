//! The key hierarchy: master key → tenant key → design key → payload.
//!
//! ```text
//! master key (ADR-0043: a file on the server, or command://, or env://)
//!   └─ wraps → tenant key (one per organisation)
//!        └─ wraps → design key (one per design, MANDATORY -- §12.3)
//!             └─ encrypts → design payload
//! ```
//!
//! `docs/PHASE-2-STORAGE-DESIGN.md` §4 and §12, ADR-0043.
//!
//! # The two rules this module exists to hold
//!
//! **Data keys are random and wrapped, never derived** (§4). Identity binds by
//! sealing `LP(aad_bytes) ‖ key` as the wrapped plaintext with the AEAD's own
//! associated-data channel empty, so an unwrap **recovers** the identity and
//! [`crypto::unwrap_key`] compares it at exactly one path — which is what makes
//! `Misbound` a different answer from `Refused`. Derivation would bind identity
//! for free and destroy the byte-identical re-wrap requirement in the same
//! section.
//!
//! **The tenant key is pinned from the authenticated request context and never
//! taken from the row being read** (§4, and §7's claim about layer 2 depends on
//! it). Mechanically: every function here takes a [`repo::TenantContext`],
//! which only [`repo::open_tenant_context`] can build and which it only builds
//! after a membership row has been read back through the database's own policy.
//! There is no constructor that takes an organisation id from a row.

use core::fmt;

use deadpool_postgres::Transaction;

use crate::crypto::{self, Key32, KeyId, UnwrapError};
use crate::keyprovider::{KeyError, KeySource, RootKey};
use crate::repo::{DesignId, TenantContext};

/// Domain tag for a tenant key's binding.
const AAD_TENANT: &[u8] = b"fathom/key/aad/tenant/v1";
/// Domain tag for a design key's binding.
const AAD_DESIGN: &[u8] = b"fathom/key/aad/design/v1";

/// The two roots this server holds, loaded once at startup.
///
/// **They are different keys and neither is in PostgreSQL.** The master key
/// wraps the tenant keys; the chain master derives every per-design chain key
/// (§6's B5 fix). Keeping them apart means an operator who must hand someone
/// the chain key to verify a history has not handed them the designs.
pub struct KeyRing {
    master: RootKey,
    chain_master: RootKey,
    master_source: String,
    chain_source: String,
}

impl KeyRing {
    /// Load both roots through ADR-0043 §3's provider interface.
    ///
    /// `create_if_missing` is ADR-0043 §1's *"generated at first start"* and
    /// applies to `file://` only.
    pub fn load(
        master: &KeySource,
        chain: &KeySource,
        create_if_missing: bool,
    ) -> Result<Self, KeyError> {
        Ok(Self {
            master: master.load(create_if_missing)?,
            chain_master: chain.load(create_if_missing)?,
            master_source: master.describe(),
            chain_source: chain.describe(),
        })
    }

    /// Build one from key material directly — for tests, and for a caller
    /// that already holds the bytes.
    pub fn from_keys(master: RootKey, chain_master: RootKey) -> Self {
        Self {
            master_source: "<in memory>".to_string(),
            chain_source: "<in memory>".to_string(),
            master,
            chain_master,
        }
    }

    /// The master key's **non-secret** id — ADR-0043 §4's stamp.
    pub fn master_key_id(&self) -> KeyId {
        self.master.id()
    }

    /// The chain master's non-secret id. Logged at startup so an operator can
    /// see that the two roots are not the same file.
    pub fn chain_key_id(&self) -> KeyId {
        self.chain_master.id()
    }

    /// Where each came from, for one startup log line. Never a value.
    pub fn describe_sources(&self) -> (&str, &str) {
        (&self.master_source, &self.chain_source)
    }

    pub(crate) fn master(&self) -> &Key32 {
        &self.master
    }

    pub(crate) fn chain_master(&self) -> &Key32 {
        &self.chain_master
    }
}

impl fmt::Debug for KeyRing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "KeyRing(master {}, chain {})",
            self.master_key_id(),
            self.chain_key_id()
        )
    }
}

// ---------------------------------------------------------------------------
// The master key's id, stamped into the database — ADR-0043 §4
// ---------------------------------------------------------------------------

/// What went wrong with the master key itself.
#[derive(Debug)]
pub enum MasterKeyError {
    Db(tokio_postgres::Error),
    /// **The configured key is not the key this database was encrypted
    /// under.** ADR-0043 §4: without this check the most common operator
    /// error — restoring a database beside the wrong key file — surfaces as
    /// an AEAD tag failure, which reads exactly like corruption.
    Mismatch {
        stored: KeyId,
        configured: KeyId,
    },
}

impl fmt::Display for MasterKeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Mismatch { stored, configured } => write!(
                f,
                "this database was encrypted under master key {stored}, the configured key is \
                 {configured}. Nothing has been read or written. This is a wrong-key error and \
                 not corruption: point the server at the key file that belongs with this \
                 database, or restore the database that belongs with this key. Retired master \
                 keys are kept forever precisely so that an older backup stays readable."
            ),
        }
    }
}

impl std::error::Error for MasterKeyError {}

impl From<tokio_postgres::Error> for MasterKeyError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}

/// Stamp the configured master key's id into `master_keys`, or refuse.
///
/// Three cases and no fourth: no active row (first start — stamp it), the same
/// id (carry on), a different id ([`MasterKeyError::Mismatch`], and the caller
/// stops). **Retired rows are left exactly where they are**: OWASP, quoted in
/// ADR-0043 §4, *"old keys should generally be stored for a certain period
/// after they have been retired, in case old backups of copies of the data
/// need to be decrypted."* Nothing in this server deletes from this table.
///
/// Called at startup **and** on the first key use in any write transaction, so
/// a key file swapped under a running server is caught at the next write
/// rather than at the next restart.
pub async fn register_master_key<C>(client: &C, ring: &KeyRing) -> Result<(), MasterKeyError>
where
    C: deadpool_postgres::GenericClient + Sync,
{
    let configured = ring.master_key_id();
    let row = client
        .query_opt(
            "SELECT key_id FROM master_keys WHERE status = 'active'",
            &[],
        )
        .await?;

    match row {
        None => {
            client
                .execute(
                    "INSERT INTO master_keys (key_id, status) VALUES ($1, 'active') \
                     ON CONFLICT (key_id) DO NOTHING",
                    &[&configured.to_string()],
                )
                .await?;
            Ok(())
        }
        Some(row) => {
            let stored_text: String = row.get(0);
            match KeyId::parse(&stored_text) {
                Some(stored) if stored == configured => Ok(()),
                Some(stored) => Err(MasterKeyError::Mismatch { stored, configured }),
                // A row that is not a key id at all. Reported as a mismatch
                // against an all-zero id rather than ignored: the one thing
                // that must not happen is carrying on.
                None => Err(MasterKeyError::Mismatch {
                    stored: KeyId::parse("0000000000000000").expect("sixteen zeroes is hex"),
                    configured,
                }),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Data keys
// ---------------------------------------------------------------------------

/// A data key as the rest of the server uses it: the key, which epoch it is,
/// and its non-secret id (which is what goes into a storage binding).
pub struct DataKey {
    pub key: Key32,
    pub epoch: i32,
    pub id: KeyId,
}

/// Why a data key could not be produced.
#[derive(Debug)]
pub enum KeyStoreError {
    Db(tokio_postgres::Error),
    MasterKey(MasterKeyError),
    Crypto(crypto::CryptoError),
    /// **The distinction §4's B1 fix exists for.** `Refused` is a failed tag;
    /// `Misbound` is a key row that authenticated under the right wrapping key
    /// and carries an identity that is not the one it was filed under — a row
    /// that was moved.
    Unwrap {
        what: &'static str,
        why: UnwrapError,
    },
    /// The design does not exist in this tenant. Not "no key": a design id
    /// from another tenant is indistinguishable from one that never existed,
    /// which is the correct answer to give.
    NoSuchDesign,
    /// The key row says an epoch whose parent key row is gone. Unreachable
    /// through the foreign keys; never silently treated as "make a new one".
    Corrupt(&'static str),
}

impl fmt::Display for KeyStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::MasterKey(e) => write!(f, "{e}"),
            Self::Crypto(e) => write!(f, "{e}"),
            Self::Unwrap { what, why } => write!(f, "the {what} could not be unwrapped: {why}"),
            Self::NoSuchDesign => f.write_str("no such design in this organisation"),
            Self::Corrupt(what) => write!(f, "a stored {what} is not consistent"),
        }
    }
}

impl std::error::Error for KeyStoreError {}

impl From<tokio_postgres::Error> for KeyStoreError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}

impl From<MasterKeyError> for KeyStoreError {
    fn from(e: MasterKeyError) -> Self {
        Self::MasterKey(e)
    }
}

impl From<crypto::CryptoError> for KeyStoreError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::Crypto(e)
    }
}

/// `LP(tag) ‖ LP(tenant_id) ‖ u32(epoch)` — what a tenant key is bound to.
fn tenant_key_aad(tenant: &str, epoch: i32) -> Vec<u8> {
    let mut aad = Vec::new();
    crypto::lp(&mut aad, AAD_TENANT);
    crypto::lp(&mut aad, tenant.as_bytes());
    crypto::u32_le(&mut aad, epoch as u32);
    aad
}

/// `LP(tag) ‖ LP(tenant_id) ‖ LP(design_id) ‖ u32(epoch)` — what a design key
/// is bound to. Length-prefixed for §12.2's reason: without it, tenant `ab` +
/// design `c` and tenant `a` + design `bc` are the same binding.
fn design_key_aad(tenant: &str, design: &str, epoch: i32) -> Vec<u8> {
    let mut aad = Vec::new();
    crypto::lp(&mut aad, AAD_DESIGN);
    crypto::lp(&mut aad, tenant.as_bytes());
    crypto::lp(&mut aad, design.as_bytes());
    crypto::u32_le(&mut aad, epoch as u32);
    aad
}

/// The tenant's active data key, created on first use.
///
/// **The organisation id comes from `ctx` and from nowhere else.** Not from a
/// row, not from a parameter a handler parsed: [`TenantContext`] is only built
/// by `repo::open_tenant_context`, after the database itself has confirmed a
/// membership row under the acting account's own identity.
pub async fn tenant_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
) -> Result<DataKey, KeyStoreError> {
    // Every write path passes through here, so this is where a master key
    // swapped under a running server is caught.
    register_master_key(tx, ring).await?;

    let tenant = ctx.tenant().to_string();
    let row = tx
        .query_opt(
            "SELECT key_epoch, key_id, wrapped_key, wrap_nonce \
             FROM tenant_keys \
             WHERE organisation_id = $1 AND status = 'active'",
            &[&tenant],
        )
        .await?;

    if let Some(row) = row {
        let epoch: i32 = row.get(0);
        let id_text: String = row.get(1);
        let wrapped: Vec<u8> = row.get(2);
        let nonce: Vec<u8> = row.get(3);
        let key = unwrap(
            ring.master(),
            &wrapped,
            &nonce,
            &tenant_key_aad(&tenant, epoch),
            "tenant key",
        )?;
        let id = key.id();
        if id.to_string() != id_text {
            return Err(KeyStoreError::Corrupt("tenant key id"));
        }
        return Ok(DataKey { key, epoch, id });
    }

    // First use for this tenant. A fresh random key, wrapped under the master
    // key and bound to this organisation at this epoch.
    let epoch = 1;
    let key = Key32::random()?;
    let id = key.id();
    let wrapped = crypto::wrap_key(ring.master(), &tenant_key_aad(&tenant, epoch), &key)?;

    tx.execute(
        "INSERT INTO tenant_keys \
             (organisation_id, key_epoch, key_id, wrapped_key, wrap_nonce, master_key_id, \
              wrap_version, aead_alg_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        &[
            &tenant,
            &epoch,
            &id.to_string(),
            &wrapped.ciphertext,
            &wrapped.nonce.to_vec(),
            &ring.master_key_id().to_string(),
            &crypto::WRAP_VERSION,
            &crypto::AEAD_ALG_CHACHA20POLY1305_IETF,
        ],
    )
    .await?;

    Ok(DataKey { key, epoch, id })
}

/// The design's active data key, created on first use, wrapped under the
/// tenant key.
///
/// **Per design, and that is load-bearing rather than tidy** — see §12.3 and
/// the comment on `design_keys` in `migrations/0007_key_hierarchy_and_designs.sql`.
/// Random 96-bit nonces are safe here only because one key covers one design's
/// versions.
pub async fn design_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
) -> Result<DataKey, KeyStoreError> {
    let tenant_key = tenant_key(tx, ring, ctx).await?;
    design_key_under(tx, ctx, &tenant_key, design).await
}

/// The half of [`design_key`] that takes an already-unwrapped tenant key, so a
/// caller doing several designs in one transaction unwraps it once.
pub async fn design_key_under(
    tx: &Transaction<'_>,
    ctx: &TenantContext,
    tenant_key: &DataKey,
    design: DesignId,
) -> Result<DataKey, KeyStoreError> {
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();

    // The tenant is in the WHERE clause as well as in the policy: §7's "both,
    // neither alone". A design id from another tenant reads as absent.
    let row = tx
        .query_opt(
            "SELECT key_epoch, key_id, wrapped_key, wrap_nonce \
             FROM design_keys \
             WHERE design_id = $1 AND organisation_id = $2 AND status = 'active'",
            &[&design_text, &tenant],
        )
        .await?;

    if let Some(row) = row {
        let epoch: i32 = row.get(0);
        let id_text: String = row.get(1);
        let wrapped: Vec<u8> = row.get(2);
        let nonce: Vec<u8> = row.get(3);
        let key = unwrap(
            &tenant_key.key,
            &wrapped,
            &nonce,
            &design_key_aad(&tenant, &design_text, epoch),
            "design key",
        )?;
        let id = key.id();
        if id.to_string() != id_text {
            return Err(KeyStoreError::Corrupt("design key id"));
        }
        return Ok(DataKey { key, epoch, id });
    }

    // The design must exist in this tenant before it can have a key. The
    // composite foreign key would refuse anyway; this makes the error the
    // right word rather than a constraint violation.
    let exists = tx
        .query_opt(
            "SELECT 1 FROM designs WHERE id = $1 AND organisation_id = $2",
            &[&design_text, &tenant],
        )
        .await?;
    if exists.is_none() {
        return Err(KeyStoreError::NoSuchDesign);
    }

    let epoch = 1;
    let key = Key32::random()?;
    let id = key.id();
    let wrapped = crypto::wrap_key(
        &tenant_key.key,
        &design_key_aad(&tenant, &design_text, epoch),
        &key,
    )?;

    tx.execute(
        "INSERT INTO design_keys \
             (design_id, organisation_id, key_epoch, key_id, wrapped_key, wrap_nonce, \
              tenant_key_epoch, wrap_version, aead_alg_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        &[
            &design_text,
            &tenant,
            &epoch,
            &id.to_string(),
            &wrapped.ciphertext,
            &wrapped.nonce.to_vec(),
            &tenant_key.epoch,
            &crypto::WRAP_VERSION,
            &crypto::AEAD_ALG_CHACHA20POLY1305_IETF,
        ],
    )
    .await?;

    Ok(DataKey { key, epoch, id })
}

/// Both halves of a rotation: the key that was in use, and the one that now
/// is. The caller needs both — the old one to decrypt what is stored, the new
/// one to write it back.
pub struct Rotation {
    pub previous: DataKey,
    pub current: DataKey,
}

/// Retire the design's active key and mint the next epoch — the key half of a
/// **rotation**, which is the only operation that revokes anything (§12.6).
///
/// The old row stays forever with `status = 'retired'`, exactly as retired
/// chain keys do, or every version written under it becomes unreadable.
///
/// **This is not a re-wrap and no configuration field may treat the two as
/// synonyms** (§12.6's one refusal). A re-wrap changes custody and revokes
/// nothing; it touches only the key tables' wrapping columns and must not move
/// `key_epoch`. Re-wrap is deliberately **not implemented here**: §12.6
/// requires it to write a sealed `rewrap` entry on the *tenant-level* chain,
/// and this order builds per-design chains only. A re-wrap without its audit
/// trail would be the one security-relevant key operation leaving no trace, in
/// a system whose integrity story is an append-only sealed log. Its columns
/// exist (`rewrapped_at`, `rewrapped_by`, `master_key_id`,
/// `master_key_epoch`), so adding it later is a function, not a migration.
pub async fn rotate_design_key(
    tx: &Transaction<'_>,
    ctx: &TenantContext,
    tenant_key: &DataKey,
    design: DesignId,
    reason: &str,
) -> Result<Rotation, KeyStoreError> {
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();

    let current = design_key_under(tx, ctx, tenant_key, design).await?;

    let retired = tx
        .execute(
            "UPDATE design_keys SET status = 'retired', retired_at = now(), retired_reason = $3 \
             WHERE design_id = $1 AND organisation_id = $2 AND status = 'active'",
            &[&design_text, &tenant, &reason],
        )
        .await?;
    if retired != 1 {
        return Err(KeyStoreError::Corrupt("design key retirement"));
    }

    let epoch = current.epoch + 1;
    let key = Key32::random()?;
    let id = key.id();
    let wrapped = crypto::wrap_key(
        &tenant_key.key,
        &design_key_aad(&tenant, &design_text, epoch),
        &key,
    )?;

    tx.execute(
        "INSERT INTO design_keys \
             (design_id, organisation_id, key_epoch, key_id, wrapped_key, wrap_nonce, \
              tenant_key_epoch, wrap_version, aead_alg_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        &[
            &design_text,
            &tenant,
            &epoch,
            &id.to_string(),
            &wrapped.ciphertext,
            &wrapped.nonce.to_vec(),
            &tenant_key.epoch,
            &crypto::WRAP_VERSION,
            &crypto::AEAD_ALG_CHACHA20POLY1305_IETF,
        ],
    )
    .await?;

    Ok(Rotation {
        previous: current,
        current: DataKey { key, epoch, id },
    })
}

/// Count one write under a design key — **a detector, never the nonce source**
/// (§12.3).
///
/// Returns the new count. A key approaching the birthday budget is shouted
/// about here and nowhere else; nothing in the write path consults it to build
/// a nonce, and nothing may be added that does.
pub async fn count_write_under_key(
    tx: &Transaction<'_>,
    design: DesignId,
    epoch: i32,
) -> Result<i64, KeyStoreError> {
    let row = tx
        .query_one(
            "UPDATE design_keys SET writes_under_key = writes_under_key + 1 \
             WHERE design_id = $1 AND key_epoch = $2 RETURNING writes_under_key",
            &[&design.to_string(), &epoch],
        )
        .await?;
    let count: i64 = row.get(0);
    if count >= crypto::WRITES_UNDER_KEY_BUDGET {
        tracing::warn!(
            design = %design,
            key_epoch = epoch,
            writes = count,
            budget = crypto::WRITES_UNDER_KEY_BUDGET,
            "a design key has passed its random-nonce write budget; rotate it. This counter is \
             a detector and is not the nonce source."
        );
    }
    Ok(count)
}

/// Open a **retired** design key's wrap, for reading a version written under
/// an older epoch. Retired data keys are kept forever (§12.6) or those
/// versions become unreadable; this is how they are read.
///
/// It goes through the same [`unwrap`] path as everything else, so a retired
/// key row that was moved is `Misbound` here exactly as an active one would
/// be.
pub fn unwrap_design_key(
    tenant_key: &DataKey,
    tenant: &str,
    design: &str,
    epoch: i32,
    wrapped: &[u8],
    nonce: &[u8],
) -> Result<Key32, KeyStoreError> {
    unwrap(
        &tenant_key.key,
        wrapped,
        nonce,
        &design_key_aad(tenant, design, epoch),
        "design key",
    )
}

/// The one place a wrapped key is opened. Keeps `Misbound` and `Refused`
/// distinct all the way out to the caller (§4).
fn unwrap(
    wrapping: &Key32,
    wrapped: &[u8],
    nonce: &[u8],
    aad: &[u8],
    what: &'static str,
) -> Result<Key32, KeyStoreError> {
    let nonce: [u8; crypto::NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| KeyStoreError::Corrupt("wrap nonce"))?;
    crypto::unwrap_key(
        wrapping,
        &crypto::Wrapped {
            ciphertext: wrapped.to_vec(),
            nonce,
        },
        aad,
    )
    .map_err(|why| KeyStoreError::Unwrap { what, why })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_binding_shapes_cannot_collide() {
        // A tenant key's binding and a design key's binding are different
        // strings even when the identifiers line up, because the domain tag
        // is length-prefixed first.
        assert_ne!(tenant_key_aad("abc", 1), design_key_aad("abc", "", 1));
        // And neither can be spliced.
        assert_ne!(design_key_aad("ab", "c", 1), design_key_aad("a", "bc", 1));
        assert_ne!(tenant_key_aad("a", 1), tenant_key_aad("a", 2));
    }

    #[test]
    fn a_tenant_key_wrapped_for_one_tenant_is_misbound_for_another() {
        // The same check the database path makes, without a database: this is
        // what catches a key row moved between organisations, and it is a
        // DIFFERENT error from a failed tag.
        let master = Key32::from_bytes([4u8; 32]);
        let key = Key32::random().unwrap();
        let wrapped = crypto::wrap_key(&master, &tenant_key_aad("A", 1), &key).unwrap();

        assert!(crypto::unwrap_key(&master, &wrapped, &tenant_key_aad("A", 1)).is_ok());
        assert_eq!(
            crypto::unwrap_key(&master, &wrapped, &tenant_key_aad("B", 1)).unwrap_err(),
            UnwrapError::Misbound
        );
        assert_eq!(
            crypto::unwrap_key(&master, &wrapped, &tenant_key_aad("A", 2)).unwrap_err(),
            UnwrapError::Misbound
        );
        assert_eq!(
            crypto::unwrap_key(
                &Key32::from_bytes([5u8; 32]),
                &wrapped,
                &tenant_key_aad("A", 1)
            )
            .unwrap_err(),
            UnwrapError::Refused
        );
    }

    #[test]
    fn a_mismatch_error_names_both_keys_and_does_not_read_like_corruption() {
        let stored = Key32::from_bytes([1u8; 32]).id();
        let configured = Key32::from_bytes([2u8; 32]).id();
        let text = MasterKeyError::Mismatch { stored, configured }.to_string();
        assert!(text.contains(&stored.to_string()), "{text}");
        assert!(text.contains(&configured.to_string()), "{text}");
        assert!(
            text.contains("wrong-key error and not corruption"),
            "{text}"
        );
    }
}
