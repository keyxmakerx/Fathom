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

use fathom_canon::Json;

use crate::crypto::{self, Key32, KeyId, UnwrapError};
use crate::keyprovider::{KeyError, KeySource, RootKey};
use crate::repo::{DesignId, TenantContext};

/// Domain tag for a tenant key's binding.
const AAD_TENANT: &[u8] = b"fathom/key/aad/tenant/v1";
/// Domain tag for a design key's binding.
const AAD_DESIGN: &[u8] = b"fathom/key/aad/design/v1";
/// Domain tag for an **organisation content key's** binding — the key that
/// encrypts organisation-chain entry metadata (§7.3).
const AAD_ORG_CONTENT: &[u8] = b"fathom/key/aad/org-content/v1";

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
    /// **Two sources that resolve to the same 32 bytes are refused**, and that
    /// is not tidiness. §6's B5 fix makes the chain master a *different* key
    /// from the master hierarchy so that an operator who must hand someone the
    /// chain key to verify a history has not handed them every design in the
    /// database. One key in both places collapses that separation silently:
    /// nothing downstream fails, nothing logs, and the two ids printed at
    /// startup are identical in a line nobody reads twice. The most likely way
    /// in is a copy-paste in a deployment file or both variables pointing at
    /// one path.
    pub fn load(
        master: &KeySource,
        chain: &KeySource,
        create_if_missing: bool,
    ) -> Result<Self, KeyError> {
        let master_key = master.load(create_if_missing)?;
        let chain_master = chain.load(create_if_missing)?;
        if crypto::ct_eq(master_key.expose(), chain_master.expose()) {
            return Err(KeyError::RootsIdentical);
        }
        Ok(Self {
            master: master_key,
            chain_master,
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
    /// **The configured chain master is not the one this history was sealed
    /// under.** The same control as [`Self::Mismatch`], for the other root,
    /// and the symptom it replaces is worse: a lost `chain.key` is recreated
    /// at startup (ADR-0043 §1's *"generated at first start"*), so without
    /// this every design in the database reported *broken at entry 1* — a
    /// forgery alarm for an operator error.
    ChainMismatch {
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
            Self::ChainMismatch { stored, configured } => write!(
                f,
                "this database's history was sealed under chain master key {stored}, the \
                 configured chain key is {configured}. Nothing has been read or written. This \
                 is a wrong-key error and NOT a forged history: the chain key file is missing \
                 or is the wrong one, and a missing one is recreated at startup, which is why \
                 this check exists. Point the server at the chain key that belongs with this \
                 database. Retired chain keys are kept forever precisely so that an older \
                 history still verifies."
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

/// Stamp the configured **chain master's** id into `chain_master_keys`, or
/// refuse — ADR-0043 §4's stamp, applied to the root 0007 missed.
///
/// The three cases are `register_master_key`'s exactly: no active row (stamp
/// it), the same id (carry on), a different id
/// ([`MasterKeyError::ChainMismatch`], and the caller stops).
///
/// **Why the wording matters more here than for the master key.** A missing
/// master key file and a missing chain key file both come back as 32 fresh
/// random bytes, because ADR-0043 §1 creates one at first start. For the
/// master key the symptom was an AEAD tag failure that read like corruption.
/// For the chain master the symptom is every history in the database
/// reporting *broken at entry 1* — an operator error rendered as an attack,
/// which is the one thing a tamper-evident log must not do.
///
/// **Called at startup and not on the write path**, which is where this
/// differs from `register_master_key`. The master key is checked again on
/// every key use because it is unwrapped on every key use. The chain master
/// is a derivation root: nothing reads it back to compare, so the only place
/// a swap can be caught is against this stamp, and a restart is what a key
/// file change means in practice. Recorded rather than left as an omission.
pub async fn register_chain_master_key<C>(client: &C, ring: &KeyRing) -> Result<(), MasterKeyError>
where
    C: deadpool_postgres::GenericClient + Sync,
{
    let configured = ring.chain_key_id();
    let row = client
        .query_opt(
            "SELECT key_id FROM chain_master_keys WHERE status = 'active'",
            &[],
        )
        .await?;

    match row {
        None => {
            client
                .execute(
                    "INSERT INTO chain_master_keys (key_id, status) VALUES ($1, 'active') \
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
                Some(stored) => Err(MasterKeyError::ChainMismatch { stored, configured }),
                None => Err(MasterKeyError::ChainMismatch {
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
    /// **§12.6's one refusal.** A key operation was named that this function
    /// does not perform. `rotate` is not a synonym for `rewrap`: one revokes
    /// access and the other does not, and a path that quietly did the cheap one
    /// when asked for the expensive one would leave an operator believing they
    /// had revoked something.
    NotASynonym {
        asked_for: &'static str,
    },
    /// A re-wrap was asked for to the master key already in use. Not a no-op
    /// worth performing: it would write a `rewrap` entry claiming custody
    /// changed when nothing did.
    RewrapToTheSameMasterKey,
    /// The sealed entry could not be written. **The whole transaction fails
    /// with it** -- a key operation whose audit entry did not land is exactly
    /// the untraceable re-wrap §12.6 exists to prevent.
    Chain(String),
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
            Self::NotASynonym { asked_for } => write!(
                f,
                "this operation is `rewrap` and `{asked_for}` is not a synonym for it. A \
                 re-wrap changes custody and revokes nothing; a rotation re-encrypts and is the \
                 only operation that revokes anything. Ask for the one you mean."
            ),
            Self::RewrapToTheSameMasterKey => f.write_str(
                "the new master key is the one already in use, so there is no custody to \
                 change. Refusing rather than writing a `rewrap` entry that claims otherwise.",
            ),
            Self::Chain(why) => write!(
                f,
                "the sealed rewrap entry could not be written, so the re-wrap is refused: {why}"
            ),
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

/// `LP(tag) ‖ LP(tenant_id) ‖ u32(epoch)` — what an organisation content key
/// is bound to. Same shape as [`tenant_key_aad`] with its own tag, so the two
/// cannot be confused for one another by a row that was moved.
fn org_content_key_aad(tenant: &str, epoch: i32) -> Vec<u8> {
    let mut aad = Vec::new();
    crypto::lp(&mut aad, AAD_ORG_CONTENT);
    crypto::lp(&mut aad, tenant.as_bytes());
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

    // One message sealed under the tenant key: the wrap above.
    count_write_under_tenant_key(tx, &tenant, tenant_key.epoch).await?;

    Ok(DataKey { key, epoch, id })
}

// ---------------------------------------------------------------------------
// The organisation content key — what encrypts organisation-chain metadata
// ---------------------------------------------------------------------------

/// The organisation's active **content key**, created on first use, wrapped
/// under the tenant key.
///
/// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7.3: organisation-chain entry
/// metadata is stored as AEAD ciphertext, because that is where the vault's
/// recipient sets and mode changes will land and a plaintext copy in the audit
/// log is §11.3 cost 3's leak returning through a side door.
///
/// # Why this is a fourth key and not one of the three that existed
///
/// - **Not the chain key.** An operator running §11.2's routine verification
///   holds it. If it also opened organisation metadata, handing someone the
///   ability to verify a history would hand them the access map the encryption
///   exists to hide — §6's B5 separation collapsing one level down.
/// - **Not the tenant key directly.** [`count_write_under_tenant_key`] exists
///   because §12.3's birthday bound is per key. Adding an AEAD message per
///   audit entry to the tenant key is precisely what that counter was written
///   to forbid.
/// - **Not a derived key.** Chain entries are append-only, so a rotation can
///   never re-encrypt one. A key covering rows nobody may rewrite needs
///   *epochs*, kept forever — which is a wrapped key with a table, not a
///   derivation.
///
/// So: the same shape as a design key, one level across instead of one down.
/// **And being wrapped under the tenant key is what makes §12.6's re-wrap
/// cover it for free** — a re-wrap changes the tenant key's wrapping and
/// nothing beneath it moves at all.
pub async fn org_content_key(
    tx: &Transaction<'_>,
    ctx: &TenantContext,
    tenant_key: &DataKey,
) -> Result<DataKey, KeyStoreError> {
    let tenant = ctx.tenant().to_string();

    let row = tx
        .query_opt(
            "SELECT key_epoch, key_id, wrapped_key, wrap_nonce \
             FROM org_content_keys \
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
            &tenant_key.key,
            &wrapped,
            &nonce,
            &org_content_key_aad(&tenant, epoch),
            "organisation content key",
        )?;
        let id = key.id();
        if id.to_string() != id_text {
            return Err(KeyStoreError::Corrupt("organisation content key id"));
        }
        return Ok(DataKey { key, epoch, id });
    }

    let epoch = 1;
    let key = Key32::random()?;
    let id = key.id();
    let wrapped = crypto::wrap_key(&tenant_key.key, &org_content_key_aad(&tenant, epoch), &key)?;

    tx.execute(
        "INSERT INTO org_content_keys \
             (organisation_id, key_epoch, key_id, wrapped_key, wrap_nonce, tenant_key_epoch, \
              wrap_version, aead_alg_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        &[
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

    // One message sealed under the tenant key: the wrap above.
    count_write_under_tenant_key(tx, &tenant, tenant_key.epoch).await?;

    Ok(DataKey { key, epoch, id })
}

/// Open a **retired** organisation content key, for reading an entry written
/// under an older epoch.
///
/// Retired epochs are kept forever, and here that is not merely prudent: a
/// chain entry cannot be re-encrypted, because the table is append-only. A
/// deleted epoch is every organisation entry written under it, unreadable, in
/// a table whose whole purpose is to still be readable later.
pub async fn org_content_key_at_epoch(
    tx: &Transaction<'_>,
    ctx: &TenantContext,
    tenant_key: &DataKey,
    epoch: i32,
) -> Result<Key32, KeyStoreError> {
    let tenant = ctx.tenant().to_string();
    let row = tx
        .query_opt(
            "SELECT wrapped_key, wrap_nonce FROM org_content_keys \
             WHERE organisation_id = $1 AND key_epoch = $2",
            &[&tenant, &epoch],
        )
        .await?
        .ok_or(KeyStoreError::Corrupt("organisation content key epoch"))?;
    let wrapped: Vec<u8> = row.get(0);
    let nonce: Vec<u8> = row.get(1);
    unwrap(
        &tenant_key.key,
        &wrapped,
        &nonce,
        &org_content_key_aad(&tenant, epoch),
        "organisation content key",
    )
}

/// Open a **tenant key** from a copy of its row, under a master key supplied by
/// the caller.
///
/// **This is the function that makes §12.6's exposure sentence demonstrable
/// rather than merely asserted**, and it is public for that reason. Given the
/// previous master key and a copy of the key rows taken before a re-wrap,
/// anyone still decrypts everything — so the test for re-wrap does exactly
/// that and proves the sentence true, instead of asserting around it.
///
/// It is also the offline-recovery path: an operator holding a database dump
/// and the key file needs precisely this, and a private helper would have meant
/// writing it twice.
pub fn unwrap_tenant_key_snapshot(
    master: &Key32,
    tenant: &str,
    epoch: i32,
    wrapped: &[u8],
    nonce: &[u8],
) -> Result<Key32, KeyStoreError> {
    unwrap(
        master,
        wrapped,
        nonce,
        &tenant_key_aad(tenant, epoch),
        "tenant key",
    )
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

    // And one more: the new epoch's key was wrapped under the tenant key too.
    count_write_under_tenant_key(tx, &tenant, tenant_key.epoch).await?;

    Ok(Rotation {
        previous: current,
        current: DataKey { key, epoch, id },
    })
}

// ---------------------------------------------------------------------------
// Re-wrap — §12.6, and the operation this order exists to finish
// ---------------------------------------------------------------------------

/// The two key operations, **which are not synonyms and have no shared verb**.
///
/// §12.6's one refusal, made mechanical: *"no config field, flag or parameter
/// may accept 'rotate' as a synonym for 're-wrap'. A deployment with a single
/// `master_key` setting that silently re-wraps when changed leaves the operator
/// believing they revoked something."*
///
/// [`parse`](Self::parse) knows exactly two words and no aliases. Nothing maps
/// `rekey`, `rotate-master`, `change-key` or `migrate` onto either.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyOperation {
    /// Changes **custody**. The data keys are unchanged; only their wrapping
    /// changes. Revokes nothing. Seconds.
    Rewrap,
    /// Changes **bytes**. New data key, fresh nonce, new ciphertext, new
    /// storage binding. **The only operation that revokes anything.** Hours,
    /// I/O-bound.
    Rotate,
}

impl KeyOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rewrap => "rewrap",
            Self::Rotate => "rotate",
        }
    }

    /// Exactly two words. No aliases, ever.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "rewrap" => Some(Self::Rewrap),
            "rotate" => Some(Self::Rotate),
            _ => None,
        }
    }
}

/// The sentence §12.6 requires an operator to acknowledge before a re-wrap,
/// **in these words and not interchangeable ones**.
pub const REWRAP_EXPOSURE_STATEMENT: &str = "Anyone who holds the previous master key and a copy \
of the key rows taken before this switch can still decrypt all data, including data written after \
it. This changed custody, not exposure. To revoke that access, run a rotation.";

/// Proof that an operator was shown [`REWRAP_EXPOSURE_STATEMENT`] and
/// acknowledged it.
///
/// A type rather than a `bool`, and the constructor takes the sentence rather
/// than a flag, so the only way to obtain one is to have the exact text in
/// hand. A `bool` argument would be satisfied by `true` written by whoever was
/// in a hurry; this is satisfied by a surface that actually rendered the
/// sentence.
#[derive(Clone, Copy, Debug)]
pub struct ExposureAcknowledged(());

impl ExposureAcknowledged {
    /// `Some` only for the exact sentence. A paraphrase is not an
    /// acknowledgement of this statement — it is an acknowledgement of a
    /// different one.
    pub fn of(statement: &str) -> Option<Self> {
        (statement == REWRAP_EXPOSURE_STATEMENT).then_some(Self(()))
    }
}

/// What happened to the old master key material.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OldKeyDisposition {
    /// **The only value this server ever returns.** The master key is a file
    /// (or a `command://` endpoint, or an environment variable) outside this
    /// process's custody — ADR-0043 §1 — so nothing here can destroy it, and
    /// claiming otherwise would be the most dangerous sentence in the report.
    /// Its row in `master_keys` is marked retired and kept forever, because
    /// OWASP (quoted in ADR-0043 §4) keeps old keys so old backups stay
    /// readable.
    RetainedOutsideThisProcess,
    /// Reserved for a deployment that can attest the old material is gone.
    /// Nothing produces it today.
    Destroyed,
}

/// What a re-wrap did, **in the words §12.6 requires**.
///
/// *"The operation named `rewrap` or `rotate`, never a shared verb; counts
/// rather than a boolean; old and new master identity; what verification will
/// say afterwards; whether old key material was retained or destroyed."*
/// Every one of those is a field below, and `Display` renders all of them
/// followed by the exposure statement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RewrapReport {
    /// Always [`KeyOperation::Rewrap`]. Present so the word is in the report
    /// rather than implied by which function was called.
    pub operation: KeyOperation,
    pub organisation: String,
    pub from_master_key_id: KeyId,
    pub to_master_key_id: KeyId,
    /// **A count, not a boolean.** Which key rows moved.
    pub tenant_key_rows_rewrapped: usize,
    /// Which epochs those were, so an operator can check the retired ones came
    /// too — a re-wrap that moved only the active epoch would leave every
    /// backup written under a retired one openable by the old master alone.
    pub key_epochs_rewrapped: Vec<i32>,
    /// **Always 0, and reported as a count rather than asserted as a fact in
    /// prose.** Design keys and organisation content keys are wrapped under the
    /// tenant key, which did not change; §4's two-level hierarchy is exactly
    /// what makes custody move in one place.
    pub subordinate_key_rows_rewrapped: usize,
    /// **Always 0.** A re-wrap re-encrypts no payload. This is the number
    /// §12.6 exists to make visible.
    pub payload_versions_reencrypted: usize,
    pub old_master_key: OldKeyDisposition,
    /// Where the sealed `rewrap` entry landed on the organisation chain.
    pub chain_entry_seq: i64,
}

impl RewrapReport {
    /// §12.6's sentence, which a surface must show and an operator must
    /// acknowledge.
    pub fn exposure_statement(&self) -> &'static str {
        REWRAP_EXPOSURE_STATEMENT
    }
}

impl fmt::Display for RewrapReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let epochs: Vec<String> = self
            .key_epochs_rewrapped
            .iter()
            .map(i32::to_string)
            .collect();
        write!(
            f,
            "{op}: organisation {org}, master key {from} -> {to}. {rows} tenant key row(s) \
             re-wrapped (epoch(s) {epochs}); {sub} subordinate key row(s) touched; \
             {payloads} payload version(s) re-encrypted. Old master key material: {disposition}. \
             Verification will report exactly what it reported before this ran -- every \
             ciphertext, nonce, content_hash and storage_binding is byte-identical, and no \
             chain entry was written for any design. One sealed `rewrap` entry was written on \
             the organisation chain at seq {seq}. {exposure}",
            op = self.operation.as_str(),
            org = self.organisation,
            from = self.from_master_key_id,
            to = self.to_master_key_id,
            rows = self.tenant_key_rows_rewrapped,
            epochs = epochs.join(", "),
            sub = self.subordinate_key_rows_rewrapped,
            payloads = self.payload_versions_reencrypted,
            disposition = match self.old_master_key {
                OldKeyDisposition::RetainedOutsideThisProcess =>
                    "RETAINED -- it is a file outside this process's custody (ADR-0043 §1), so \
                     this server cannot destroy it and does not claim to. Its row is marked \
                     retired and kept forever so old backups stay readable",
                OldKeyDisposition::Destroyed => "destroyed",
            },
            seq = self.chain_entry_seq,
            exposure = REWRAP_EXPOSURE_STATEMENT,
        )
    }
}

/// **Re-wrap: change custody of a tenant's keys without re-encrypting a byte.**
///
/// §12.6. `keys::rotate_design_key`'s doc recorded why this could not be built
/// before: *"§12.6 requires it to write a sealed `rewrap` entry on the
/// tenant-level chain, and this order builds per-design chains only. A re-wrap
/// without its audit trail would be the one security-relevant key operation
/// leaving no trace."* The organisation chain now exists, so this does.
///
/// # What it touches, and what it must not
///
/// Only the wrapping columns of `tenant_keys`: `wrapped_key`, `wrap_nonce`,
/// `master_key_id`, `master_key_epoch`, `wrap_version`, `rewrapped_at`,
/// `rewrapped_by`. **Never `key_epoch`. Never `design_payload`.** §12.6: *"if a
/// re-wrap moves `key_epoch`, the two operations are conflated in the schema
/// and no interface can separate them afterwards."*
///
/// Every epoch is re-wrapped, retired ones included. Re-wrapping only the
/// active epoch would leave every version written under a retired key still
/// openable by the old master key alone, which is a custody change that did not
/// change custody.
///
/// Design keys and organisation content keys are **not** touched and do not
/// need to be: they are wrapped under the tenant key, which is unchanged. That
/// is §4's two-level hierarchy paying for itself.
///
/// # Why it refuses `rotate`
///
/// §12.6's one refusal. `operation` must be [`KeyOperation::Rewrap`]; passing
/// [`KeyOperation::Rotate`] is an error and not a fallback, because a setting
/// that silently re-wraps when an operator asked to rotate leaves them
/// believing they revoked something.
pub async fn rewrap_tenant_keys(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    to_master: &Key32,
    operation: KeyOperation,
    _acknowledged: ExposureAcknowledged,
) -> Result<RewrapReport, KeyStoreError> {
    if operation != KeyOperation::Rewrap {
        return Err(KeyStoreError::NotASynonym {
            asked_for: operation.as_str(),
        });
    }

    // The database's active master key must be the one this ring holds, or the
    // unwraps below would fail as tag errors and read like corruption.
    register_master_key(tx, ring).await?;

    let from_id = ring.master_key_id();
    let to_id = to_master.id();
    if from_id == to_id {
        return Err(KeyStoreError::RewrapToTheSameMasterKey);
    }

    let tenant = ctx.tenant().to_string();

    // Retire the old, activate the new. The partial unique index allows one
    // active row, so the order matters. `ON CONFLICT` covers re-wrapping back
    // to a key this database used before: the row is kept forever and comes
    // back into use rather than being inserted twice.
    tx.execute(
        "UPDATE master_keys SET status = 'retired', retired_at = now(), \
                retired_reason = 'superseded by a re-wrap' \
         WHERE key_id = $1 AND status = 'active'",
        &[&from_id.to_string()],
    )
    .await?;
    tx.execute(
        "INSERT INTO master_keys (key_id, status) VALUES ($1, 'active') \
         ON CONFLICT (key_id) DO UPDATE \
            SET status = 'active', retired_at = NULL, retired_reason = NULL",
        &[&to_id.to_string()],
    )
    .await?;

    // Every epoch, active and retired. See the doc above for why.
    let rows = tx
        .query(
            "SELECT key_epoch, key_id, wrapped_key, wrap_nonce, master_key_epoch \
             FROM tenant_keys WHERE organisation_id = $1 ORDER BY key_epoch",
            &[&tenant],
        )
        .await?;

    let mut epochs = Vec::new();
    for row in &rows {
        let epoch: i32 = row.get(0);
        let id_text: String = row.get(1);
        let wrapped: Vec<u8> = row.get(2);
        let nonce: Vec<u8> = row.get(3);
        let master_epoch: i32 = row.get(4);

        let aad = tenant_key_aad(&tenant, epoch);
        let key = unwrap(ring.master(), &wrapped, &nonce, &aad, "tenant key")?;
        if key.id().to_string() != id_text {
            return Err(KeyStoreError::Corrupt("tenant key id"));
        }

        // **The same associated data.** The identity binding is over the
        // tenant and the epoch, neither of which moves, so the unwrapped
        // plaintext is byte-identical and only the wrapping changes. That is
        // what "custody, not exposure" means at the byte level.
        let rewrapped = crypto::wrap_key(to_master, &aad, &key)?;

        let updated = tx
            .execute(
                "UPDATE tenant_keys \
                    SET wrapped_key = $3, wrap_nonce = $4, master_key_id = $5, \
                        master_key_epoch = $6, wrap_version = $7, rewrapped_at = now(), \
                        rewrapped_by = $8 \
                  WHERE organisation_id = $1 AND key_epoch = $2",
                &[
                    &tenant,
                    &epoch,
                    &rewrapped.ciphertext,
                    &rewrapped.nonce.to_vec(),
                    &to_id.to_string(),
                    &(master_epoch + 1),
                    &crypto::WRAP_VERSION,
                    &ctx.actor().to_string(),
                ],
            )
            .await?;
        if updated != 1 {
            return Err(KeyStoreError::Corrupt("tenant key re-wrap"));
        }
        epochs.push(epoch);
    }

    // The sealed entry, on the organisation chain, in the same transaction.
    // Without it this whole operation leaves no trace -- which is the gap
    // §12.6 named and the reason this function did not exist until now.
    //
    // The tenant key is read back AFTER the re-wrap, under the NEW master, so
    // the organisation content key that encrypts this entry's own metadata is
    // opened through the custody that now applies. An entry written under the
    // old custody describing its own replacement would be a small, confusing
    // lie in the one record that must not contain any.
    let new_ring = KeyRing::from_keys(
        Key32::from_bytes(*to_master.expose()),
        Key32::from_bytes(*ring.chain_master().expose()),
    );
    let tenant_key = tenant_key(tx, &new_ring, ctx).await?;

    let metadata = rewrap_metadata(ctx, &tenant, from_id, to_id, &epochs);
    let appended = crate::chains::append_org(
        tx,
        &new_ring,
        ctx,
        &tenant_key,
        crate::chain::EntryType::Rewrap,
        &metadata,
    )
    .await
    .map_err(|e| KeyStoreError::Chain(e.to_string()))?;

    Ok(RewrapReport {
        operation: KeyOperation::Rewrap,
        organisation: tenant,
        from_master_key_id: from_id,
        to_master_key_id: to_id,
        tenant_key_rows_rewrapped: rows.len(),
        key_epochs_rewrapped: epochs,
        subordinate_key_rows_rewrapped: 0,
        payload_versions_reencrypted: 0,
        old_master_key: OldKeyDisposition::RetainedOutsideThisProcess,
        chain_entry_seq: appended.seq,
    })
}

/// The sealed entry's metadata: old and new master identity, which key rows
/// moved, who ran it, and — **as a statement of fact in the entry itself** —
/// that no payload was re-encrypted.
///
/// That last field is not decoration. A reader of this chain in two years is
/// asking whether the estate was ever exposed to a key somebody else holds, and
/// the answer has to be inside the sealed record rather than inferred from the
/// entry type's documentation.
fn rewrap_metadata(
    ctx: &TenantContext,
    organisation: &str,
    from: KeyId,
    to: KeyId,
    epochs: &[i32],
) -> Vec<u8> {
    let mut map = std::collections::BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(ctx.actor().to_string()));
    map.insert(
        "entry_type".to_string(),
        Json::Str(crate::chain::EntryType::Rewrap.as_str().to_string()),
    );
    map.insert(
        "operation".to_string(),
        Json::Str(KeyOperation::Rewrap.as_str().to_string()),
    );
    map.insert(
        "organisation".to_string(),
        Json::Str(organisation.to_string()),
    );
    map.insert(
        "from_master_key_id".to_string(),
        Json::Str(from.to_string()),
    );
    map.insert("to_master_key_id".to_string(), Json::Str(to.to_string()));
    map.insert(
        "tenant_key_rows_rewrapped".to_string(),
        Json::Int(epochs.len() as i64),
    );
    map.insert(
        "key_epochs_rewrapped".to_string(),
        Json::Arr(epochs.iter().map(|e| Json::Int(i64::from(*e))).collect()),
    );
    map.insert("payload_versions_reencrypted".to_string(), Json::Int(0));
    map.insert("payload_reencrypted".to_string(), Json::Bool(false));
    map.insert(
        "exposure".to_string(),
        Json::Str(REWRAP_EXPOSURE_STATEMENT.to_string()),
    );
    Json::Obj(map).to_canonical_bytes()
}

/// Count one AEAD message under a **tenant** key — the same detector, for the
/// layer that had none.
///
/// §12.3's birthday bound is per key, not per table: the tenant key seals a
/// wrap with a fresh random 96-bit nonce every time a design key is minted or
/// rotated, and those are messages under one key exactly as payload writes
/// are. `tenant_keys.writes_under_key` existed from 0007 and nothing ever
/// incremented it, so the column read zero forever and the detector could
/// never fire for this layer — a counter that cannot count is worse than no
/// column, because it reads as evidence.
///
/// **A detector, never the nonce source** (§12.3), and the same sentence binds
/// here as one layer down: nothing in the write path consults this to build a
/// nonce, and nothing may be added that does.
pub async fn count_write_under_tenant_key(
    tx: &Transaction<'_>,
    tenant: &str,
    epoch: i32,
) -> Result<i64, KeyStoreError> {
    let row = tx
        .query_one(
            "UPDATE tenant_keys SET writes_under_key = writes_under_key + 1 \
             WHERE organisation_id = $1 AND key_epoch = $2 RETURNING writes_under_key",
            &[&tenant, &epoch],
        )
        .await?;
    let count: i64 = row.get(0);
    if count >= crypto::WRITES_UNDER_KEY_BUDGET {
        tracing::warn!(
            organisation = %tenant,
            key_epoch = epoch,
            writes = count,
            budget = crypto::WRITES_UNDER_KEY_BUDGET,
            "a tenant key has passed its random-nonce write budget; rotate it. This counter is \
             a detector and is not the nonce source."
        );
    }
    Ok(count)
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

    #[test]
    fn two_key_sources_that_resolve_to_the_same_bytes_are_refused() {
        // §6's B5 fix makes the chain master a DIFFERENT key from the master
        // hierarchy, so that handing someone the chain key to verify a
        // history does not hand them every design. Both settings naming one
        // file is a copy-paste away, and nothing downstream would fail.
        let dir = std::env::temp_dir().join(format!("fathom-rootstest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        let one = KeySource::File(dir.join("master.key"));
        let two = KeySource::File(dir.join("chain.key"));
        assert_eq!(
            KeyRing::load(&one, &one, true).err(),
            Some(KeyError::RootsIdentical)
        );
        // Two different files: fine, and the ids differ.
        let ring = KeyRing::load(&one, &two, true).expect("two distinct keys");
        assert_ne!(ring.master_key_id(), ring.chain_key_id());

        // ...and the same 32 bytes reached through two different paths is
        // still the same key, which is the case a path comparison would miss.
        let copy = dir.join("copy.key");
        std::fs::copy(dir.join("master.key"), &copy).unwrap();
        let mut perms = std::fs::metadata(&copy).unwrap().permissions();
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o400);
        }
        std::fs::set_permissions(&copy, perms).unwrap();
        assert_eq!(
            KeyRing::load(&one, &KeySource::File(copy), false).err(),
            Some(KeyError::RootsIdentical)
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
