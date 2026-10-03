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
//! sealing `LP(aad_bytes) ‖ key` as the wrapped plaintext, with the AEAD's own
//! associated-data channel empty. An unwrap therefore **recovers** the
//! identity and [`crypto::unwrap_key`] compares it in exactly one place, which
//! is what makes `Misbound` a different answer from `Refused`. Derivation would
//! bind identity for free but break §4's byte-identical re-wrap requirement.
//!
//! **The tenant key is pinned from the authenticated request context, never
//! taken from the row being read** (§4; §7's claim about layer 2 depends on
//! it). Every function here takes a [`repo::TenantContext`], which only
//! [`repo::open_tenant_context`] can build, and only after a membership row has
//! been read back through the database's own policy. No constructor takes an
//! organisation id from a row.

use core::fmt;

use deadpool_postgres::{Pool, PoolError, Transaction};

use fathom_canon::Json;

use crate::crypto::{self, Key32, KeyId, UnwrapError};
use crate::keyprovider::{KeyError, KeySource, RootKey};
use crate::repo::{self, DesignId, TenantContext};

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
/// (§6's B5 fix). Keeping them apart means handing someone the chain key to
/// verify a history does not hand them the designs.
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
    ///
    /// **Two sources that resolve to the same 32 bytes are refused.** §6's B5 fix
    /// needs the chain master to be a *different* key from the master hierarchy.
    /// One key in both places collapses that separation silently: nothing
    /// downstream fails or logs. The likely cause is a copy-paste in a deployment
    /// file, or both variables pointing at one path.
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
    /// **The configured key is not the key this database was encrypted under.**
    /// ADR-0043 §4: without this check, restoring a database beside the wrong key
    /// file surfaces as an AEAD tag failure, which reads like corruption.
    Mismatch {
        stored: KeyId,
        configured: KeyId,
    },
    /// **The configured chain master is not the one this history was sealed
    /// under.** The same control as [`Self::Mismatch`] for the other root. A lost
    /// `chain.key` is recreated at startup (ADR-0043 §1), so without this every
    /// design would report *broken at entry 1*, a forgery alarm for an operator
    /// error.
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
/// Three cases: no active row (first start, stamp it), the same id (carry on),
/// a different id ([`MasterKeyError::Mismatch`]; the caller stops). **Retired
/// rows are never deleted** (OWASP, quoted in ADR-0043 §4: old keys should be
/// kept after retirement in case old backups need decrypting).
///
/// Called at startup **and** on first key use in any write transaction, so a
/// key file swapped under a running server is caught at the next write.
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
                // A row that is not a key id at all is reported as a mismatch against an
                // all-zero id: carrying on must never happen.
                None => Err(MasterKeyError::Mismatch {
                    stored: KeyId::parse("0000000000000000").expect("sixteen zeroes is hex"),
                    configured,
                }),
            }
        }
    }
}

/// Stamp the configured **chain master's** id into `chain_master_keys`, or
/// refuse (ADR-0043 §4's stamp, for the root 0007 missed).
///
/// The three cases are `register_master_key`'s, with
/// [`MasterKeyError::ChainMismatch`].
///
/// **Why the wording matters here.** A missing chain key file is recreated as
/// 32 fresh random bytes (ADR-0043 §1), so without this every history would
/// report *broken at entry 1*: an operator error rendered as an attack, which
/// a tamper-evident log must not do.
///
/// **Called at startup, not on the write path.** The master key is re-checked
/// on every use because it is unwrapped on every use. The chain master is a
/// derivation root that nothing reads back to compare, so the stamp is the
/// only place a swap can be caught, and a key file change means a restart.
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
    /// No connection to be had. Only the deployment-wide re-wrap reaches this: it
    /// owns its transaction and so takes a pool.
    Pool(PoolError),
    /// The tenant context could not be opened for a deployment-wide key
    /// custody change.
    Repo(String),
    MasterKey(MasterKeyError),
    Crypto(crypto::CryptoError),
    /// **The distinction §4's B1 fix exists for.** `Refused` is a failed tag;
    /// `Misbound` is a row that authenticated under the right wrapping key but
    /// carries an identity it was not filed under (a moved row).
    Unwrap {
        what: &'static str,
        why: UnwrapError,
    },
    /// The design does not exist in this tenant. Another tenant's design id is
    /// indistinguishable from one that never existed, which is correct.
    NoSuchDesign,
    /// The key row says an epoch whose parent key row is gone. Unreachable
    /// through the foreign keys; never silently treated as "make a new one".
    Corrupt(&'static str),
    /// **§12.6's one refusal.** `rotate` is not a synonym for `rewrap`: one revokes
    /// access and the other does not, and doing the cheap one when asked for the
    /// expensive one would leave an operator believing they had revoked something.
    NotASynonym {
        asked_for: &'static str,
    },
    /// A re-wrap to the master key already in use. Refused: it would write a
    /// `rewrap` entry claiming custody changed when nothing did.
    RewrapToTheSameMasterKey,
    /// The sealed entry could not be written. **The whole transaction fails with
    /// it**: a key operation without its audit entry is the untraceable re-wrap
    /// §12.6 exists to prevent.
    Chain(String),
}

impl fmt::Display for KeyStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Pool(_) => f.write_str("could not get a database connection"),
            Self::Repo(why) => write!(f, "{why}"),
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
/// **The organisation id comes from `ctx` and nowhere else**: not from a row,
/// not from a handler's parameter. [`TenantContext`] is built only by
/// `repo::open_tenant_context`, after the database has confirmed a membership
/// row under the acting account's identity.
pub async fn tenant_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
) -> Result<DataKey, KeyStoreError> {
    tenant_key_for(tx, ring, &ctx.tenant().to_string()).await
}

/// The half of [`tenant_key`] that takes the organisation id directly.
///
/// **`pub(crate)`, and the caller list is the whole argument.** §4 pins the
/// tenant key from the request context, never from the row being read;
/// [`TenantContext`] is that rule as a type. This has exactly two callers, both
/// acts with no account:
///
///  1. `rewrap_master_key`: deployment-wide, enumerates organisations from
///     `tenant_keys`, and no account is acting.
///  2. `grants::suspend_grant_by_operator`, §1.1's operator suspend verb. **A
///     deliberate crossing of §4's pinning rule.** An operator is not and
///     cannot be a member (`0004`'s composite keys), so there is no membership
///     row and `TenantContext` is unbuildable; the caller names the
///     organisation. Compensations: `app.design_capability` stays at its
///     refusal for the whole transaction, the grant's own `organisation_id` is
///     checked against the named tenant, the act writes only a suspension and
///     its chain entries, and `0011`'s `CHECK` refuses `unsuspend` for an
///     operator principal so the verb is one-way.
///
/// It stays `pub(crate)` so nothing outside this crate can name a tenant that
/// did not come from `repo::TenantContext`.
pub(crate) async fn tenant_key_for(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    tenant: &str,
) -> Result<DataKey, KeyStoreError> {
    // Every write path passes through here, so this is where a master key
    // swapped under a running server is caught.
    register_master_key(tx, ring).await?;

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
            &tenant_key_aad(tenant, epoch),
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
    let wrapped = crypto::wrap_key(ring.master(), &tenant_key_aad(tenant, epoch), &key)?;

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
/// **Per design, and that is load-bearing** (§12.3; see the comment on
/// `design_keys` in `migrations/0007_key_hierarchy_and_designs.sql`). Random
/// 96-bit nonces are safe only because one key covers one design's versions.
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

    // The design must exist in this tenant before it has a key; this gives the
    // right error rather than a constraint violation.
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
/// metadata is stored as AEAD ciphertext, because a plaintext copy in the audit
/// log would be §11.3 cost 3's leak returning through a side door.
///
/// # Why a fourth key
///
/// - **Not the chain key.** An operator running §11.2's routine verification
///   holds it; if it also opened organisation metadata, verifying a history
///   would hand over the access map (§6's B5 separation, one level down).
/// - **Not the tenant key directly.** §12.3's birthday bound is per key, and
///   [`count_write_under_tenant_key`] exists to stop an AEAD message per audit
///   entry piling onto the tenant key.
/// - **Not a derived key.** Chain entries are append-only and can never be
///   re-encrypted, so a key covering them needs *epochs* kept forever: a
///   wrapped key with a table.
///
/// Same shape as a design key, one level across. **Being wrapped under the
/// tenant key means §12.6's re-wrap covers it for free**: nothing beneath the
/// tenant key moves.
pub async fn org_content_key(
    tx: &Transaction<'_>,
    ctx: &TenantContext,
    tenant_key: &DataKey,
) -> Result<DataKey, KeyStoreError> {
    org_content_key_for(tx, &ctx.tenant().to_string(), tenant_key).await
}

/// The half of [`org_content_key`] that takes the organisation id directly.
/// `pub(crate)` for `chains::append_org_as` (the ordinary append and the
/// deployment-wide re-wrap); see [`tenant_key_for`].
pub(crate) async fn org_content_key_for(
    tx: &Transaction<'_>,
    tenant: &str,
    tenant_key: &DataKey,
) -> Result<DataKey, KeyStoreError> {
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
            &org_content_key_aad(tenant, epoch),
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
    let wrapped = crypto::wrap_key(&tenant_key.key, &org_content_key_aad(tenant, epoch), &key)?;

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
    count_write_under_tenant_key(tx, tenant, tenant_key.epoch).await?;

    Ok(DataKey { key, epoch, id })
}

/// Open a **retired** organisation content key, for reading an entry written
/// under an older epoch.
///
/// Retired epochs are kept forever: chain entries are append-only and cannot
/// be re-encrypted, so a deleted epoch makes every entry written under it
/// unreadable.
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
/// **This makes §12.6's exposure sentence demonstrable**, hence `pub`: given
/// the previous master key and a copy of the key rows from before a re-wrap,
/// anyone still decrypts everything, and the re-wrap test proves that. It is
/// also the offline-recovery path for an operator holding a dump and the key
/// file.
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

/// Retire the design's active key and mint the next epoch: the key half of a
/// **rotation**, the only operation that revokes anything (§12.6).
///
/// The old row stays forever as `retired`, like retired chain keys, or every
/// version written under it becomes unreadable.
///
/// **This is not a re-wrap and no configuration field may treat the two as
/// synonyms** (§12.6's one refusal). A re-wrap changes custody only, touches
/// only the wrapping columns and must not move `key_epoch`. Re-wrap is **not
/// implemented here**: it must write a sealed `rewrap` entry on the
/// tenant-level chain, and one without that trail would be a security-relevant
/// key operation leaving no trace. See [`rewrap_master_key`].
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
/// §12.6's one refusal, made mechanical: no config field, flag or parameter may
/// accept 'rotate' as a synonym for 're-wrap', or an operator is left believing
/// they revoked something.
///
/// [`parse`](Self::parse) knows exactly two words and no aliases.
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
/// A type, not a `bool`: the constructor takes the sentence, so the only way to
/// obtain one is to have the exact text in hand.
#[derive(Clone, Copy, Debug)]
pub struct ExposureAcknowledged(());

impl ExposureAcknowledged {
    /// `Some` only for the exact sentence; a paraphrase acknowledges a different
    /// statement.
    pub fn of(statement: &str) -> Option<Self> {
        (statement == REWRAP_EXPOSURE_STATEMENT).then_some(Self(()))
    }
}

/// What happened to the old master key material.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum OldKeyDisposition {
    /// **The only value this server ever returns.** The master key is a file,
    /// `command://` endpoint or environment variable outside this process's
    /// custody (ADR-0043 §1), so nothing here can destroy it, and claiming
    /// otherwise would be the most dangerous sentence in the report. Its
    /// `master_keys` row is marked retired and kept forever (OWASP, quoted in
    /// ADR-0043 §4).
    RetainedOutsideThisProcess,
    /// Reserved for a deployment that can attest the old material is gone.
    /// Nothing produces it today.
    Destroyed,
}

/// What one tenant's share of a re-wrap was, inside [`RewrapReport`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TenantRewrap {
    pub organisation: String,
    /// Which epochs moved, so an operator can check the retired ones came too:
    /// moving only the active epoch would leave backups from retired epochs
    /// openable by the old master alone.
    pub key_epochs_rewrapped: Vec<i32>,
    /// Where this tenant's sealed `rewrap` entry landed on its own chain.
    pub chain_entry_seq: i64,
}

/// What a re-wrap did, **in the words §12.6 requires**: the operation named,
/// counts rather than a boolean, old and new master identity, what verification
/// will say afterwards, and whether old key material was retained or destroyed.
/// Each is a field below, and `Display` renders all of them followed by the
/// exposure statement.
///
/// **Counts are deployment-wide**, because there is one active master key per
/// database and no such thing as re-wrapping one tenant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RewrapReport {
    /// Always [`KeyOperation::Rewrap`]. Present so the word is in the report
    /// rather than implied by which function was called.
    pub operation: KeyOperation,
    pub from_master_key_id: KeyId,
    pub to_master_key_id: KeyId,
    /// **A count, not a boolean.** How many tenants moved.
    pub tenants_rewrapped: usize,
    /// **A count, not a boolean.** How many key rows moved, across every
    /// tenant and every epoch.
    pub tenant_key_rows_rewrapped: usize,
    /// One entry per tenant, in the order they were processed.
    pub tenants: Vec<TenantRewrap>,
    /// **Always 0, reported as a count.** Design keys and organisation content keys
    /// are wrapped under the tenant key, which did not change; §4's two-level
    /// hierarchy makes custody move in one place.
    pub subordinate_key_rows_rewrapped: usize,
    /// **Always 0.** A re-wrap re-encrypts no payload. This is the number
    /// §12.6 exists to make visible.
    pub payload_versions_reencrypted: usize,
    pub old_master_key: OldKeyDisposition,
    /// Where the summary `rewrap` entry landed on the site chain.
    pub site_chain_entry_seq: i64,
}

impl RewrapReport {
    /// §12.6's sentence, which a surface must show and an operator must
    /// acknowledge.
    pub fn exposure_statement(&self) -> &'static str {
        REWRAP_EXPOSURE_STATEMENT
    }

    /// Every epoch that moved for one organisation, or `None` if that
    /// organisation had no key rows at all.
    pub fn tenant(&self, organisation: &str) -> Option<&TenantRewrap> {
        self.tenants.iter().find(|t| t.organisation == organisation)
    }
}

impl fmt::Display for RewrapReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{op}: master key {from} -> {to}, deployment-wide. {tenants} tenant(s) and {rows} \
             tenant key row(s) re-wrapped; {sub} subordinate key row(s) touched; {payloads} \
             payload version(s) re-encrypted. Old master key material: {disposition}. \
             Verification will report exactly what it reported before this ran -- every \
             ciphertext, nonce, content_hash and storage_binding is byte-identical, and no \
             chain entry was written for any design. One sealed `rewrap` entry was written on \
             the site chain at seq {site}, and one on each affected organisation's chain. \
             {exposure}",
            op = self.operation.as_str(),
            from = self.from_master_key_id,
            to = self.to_master_key_id,
            tenants = self.tenants_rewrapped,
            rows = self.tenant_key_rows_rewrapped,
            sub = self.subordinate_key_rows_rewrapped,
            payloads = self.payload_versions_reencrypted,
            disposition = match self.old_master_key {
                OldKeyDisposition::RetainedOutsideThisProcess =>
                    "RETAINED -- it is a file outside this process's custody (ADR-0043 §1), so \
                     this server cannot destroy it and does not claim to. Its row is marked \
                     retired and kept forever so old backups stay readable",
                OldKeyDisposition::Destroyed => "destroyed",
            },
            site = self.site_chain_entry_seq,
            exposure = REWRAP_EXPOSURE_STATEMENT,
        )
    }
}

/// The advisory lock two concurrent re-wraps serialise on.
/// Transaction-scoped, so there is no unlock to forget. Without it, a lost race
/// would fail as a unique-index violation half way through a key table.
const CUSTODY_LOCK: &str = "fathom:master-key-custody";

/// **Re-wrap: change custody of every key wrapped under the master key,
/// without re-encrypting a byte.**
///
/// §12.6, and **deployment-wide, because the master key is**: one active master
/// key per database (0007's `master_keys_one_active_idx`), so retiring it
/// changes custody for every tenant at once. An earlier per-organisation
/// version retired the deployment's master key and re-wrapped one tenant,
/// leaving **every other tenant openable under neither key**: a total, silent
/// loss. There is no per-organisation entry point now.
///
/// # Which tables hold key material wrapped directly under the master key
///
/// Read off 0007, 0008 and 0009; a wrong list is the defect above in another
/// form:
///
/// | table | wrapped under | re-wrapped here |
/// |---|---|---|
/// | `tenant_keys` (0007) | the **master key** | **yes — every row, every organisation, every epoch, whatever its status** |
/// | `master_keys` (0007) | nothing — it holds key *ids* | no material to move; the old row is retired and the new one activated |
/// | `chain_master_keys` (0008) | nothing — key *ids* again, for the chain master | untouched: the chain master is a different root and a re-wrap does not change it |
/// | `design_keys` (0007) | the tenant key | no, and it needs none — §4's two-level hierarchy |
/// | `org_content_keys` (0009) | the tenant key | no, same reason |
/// | `design_payload` (0007) | the design key | never — a re-wrap re-encrypts nothing |
///
/// So: **one table**, and the report's count is of its rows. Every epoch is
/// re-wrapped, retired and compromised included; moving only the active epoch
/// would leave versions under a retired key openable by the old master alone.
///
/// # What it touches, and what it must not
///
/// Only the wrapping columns of `tenant_keys`: `wrapped_key`, `wrap_nonce`,
/// `master_key_id`, `master_key_epoch`, `wrap_version`, `rewrapped_at`,
/// `rewrapped_by`. **Never `key_epoch`. Never `design_payload`.** §12.6: *"if a
/// re-wrap moves `key_epoch`, the two operations are conflated in the schema
/// and no interface can separate them afterwards."* The unwrapped plaintext is
/// byte-identical on both sides (the binding is over tenant and epoch, neither
/// of which moves), so ciphertext, nonces, `content_hash` and every
/// `storage_binding` are untouched.
///
/// # One transaction, owned here
///
/// It begins and commits inside this function and a failure rolls everything
/// back. The key change and its sealed record must stand or fall together: no
/// key change without its entries, no entry without its key change. A caller
/// cannot commit half.
///
/// # What it writes
///
/// - One sealed `rewrap` entry on the **site** chain: both master identities
///   and the count of tenants. The act is deployment-wide and the site chain is
///   the only chain that is.
/// - One on **each affected organisation's** chain, naming that tenant's own
///   epochs (§12.6; §7.2 allows the site summary beside it).
///
/// The organisation entries are written after the key rows move, so each
/// entry's metadata key is opened through the custody that now applies. An
/// entry written under the old custody describing its own replacement would be
/// a confusing lie in the one record that must not contain any.
///
/// # Why it refuses `rotate`
///
/// §12.6's one refusal. `operation` must be [`KeyOperation::Rewrap`];
/// [`KeyOperation::Rotate`] is an error, not a fallback, or an operator who
/// asked to rotate would believe they revoked something.
pub async fn rewrap_master_key(
    pool: &Pool,
    ring: &KeyRing,
    to_master: &Key32,
    operation: KeyOperation,
    by: &str,
    _acknowledged: ExposureAcknowledged,
) -> Result<RewrapReport, KeyStoreError> {
    if operation != KeyOperation::Rewrap {
        return Err(KeyStoreError::NotASynonym {
            asked_for: operation.as_str(),
        });
    }

    let from_id = ring.master_key_id();
    let to_id = to_master.id();
    if from_id == to_id {
        return Err(KeyStoreError::RewrapToTheSameMasterKey);
    }

    let mut client = pool.get().await.map_err(KeyStoreError::Pool)?;
    let tx = client.transaction().await?;

    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&CUSTODY_LOCK],
    )
    .await?;

    // The database's active master key must be the one this ring holds, or the
    // unwraps below would fail as tag errors and read like corruption.
    register_master_key(&tx, ring).await?;

    // Enumeration: every key table's row security would hide rows from a
    // transaction with no tenant, and a re-wrap that re-wrapped nothing would
    // report success. See `repo::enter_key_custody` and 0010 §F.
    repo::enter_key_custody(&tx)
        .await
        .map_err(|e| KeyStoreError::Repo(e.to_string()))?;

    // Retire the old, activate the new (the partial unique index allows one
    // active row, so order matters). `ON CONFLICT` covers re-wrapping back to a
    // key used before: the row comes back into use rather than being inserted
    // twice.
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

    // Every row of the one table wrapped under the master key, every
    // organisation and epoch, whatever its status. Ordered so one organisation's
    // rows are contiguous.
    let rows = tx
        .query(
            "SELECT organisation_id, key_epoch, key_id, wrapped_key, wrap_nonce, \
                    master_key_epoch \
             FROM tenant_keys ORDER BY organisation_id, key_epoch",
            &[],
        )
        .await?;

    let mut per_tenant: Vec<(String, Vec<i32>)> = Vec::new();
    for row in &rows {
        let tenant: String = row.get(0);
        let epoch: i32 = row.get(1);
        let id_text: String = row.get(2);
        let wrapped: Vec<u8> = row.get(3);
        let nonce: Vec<u8> = row.get(4);
        let master_epoch: i32 = row.get(5);

        // The UPDATE goes through `tenant_keys_updatable`, keyed on `app.tenant_id`.
        // Set per row so no path here can update a row for a tenant the context
        // does not name.
        repo::set_custody_tenant(&tx, &tenant)
            .await
            .map_err(|e| KeyStoreError::Repo(e.to_string()))?;

        let aad = tenant_key_aad(&tenant, epoch);
        let key = unwrap(ring.master(), &wrapped, &nonce, &aad, "tenant key")?;
        if key.id().to_string() != id_text {
            return Err(KeyStoreError::Corrupt("tenant key id"));
        }

        // **The same associated data**: the binding is over tenant and epoch,
        // neither of which moves, so the plaintext is byte-identical and only the
        // wrapping changes. That is "custody, not exposure" at the byte level.
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
                    &by,
                ],
            )
            .await?;
        if updated != 1 {
            return Err(KeyStoreError::Corrupt("tenant key re-wrap"));
        }

        match per_tenant.last_mut() {
            Some((last, epochs)) if *last == tenant => epochs.push(epoch),
            _ => per_tenant.push((tenant, vec![epoch])),
        }
    }

    // The sealed entries, in the same transaction; without them this operation
    // leaves no trace (the gap §12.6 named).
    //
    // Under the NEW master: each entry's metadata key is wrapped under the
    // tenant key, which is wrapped under the master, and the new custody applies.
    let new_ring = KeyRing::from_keys(
        Key32::from_bytes(*to_master.expose()),
        Key32::from_bytes(*ring.chain_master().expose()),
    );

    let mut tenants = Vec::with_capacity(per_tenant.len());
    for (tenant, epochs) in per_tenant {
        repo::set_custody_tenant(&tx, &tenant)
            .await
            .map_err(|e| KeyStoreError::Repo(e.to_string()))?;
        let tenant_key = tenant_key_for(&tx, &new_ring, &tenant).await?;
        let metadata = rewrap_metadata(by, &tenant, from_id, to_id, &epochs);
        let appended = crate::chains::append_org_as(
            &tx,
            &new_ring,
            &tenant,
            by,
            &tenant_key,
            crate::chain::EntryType::Rewrap,
            &metadata,
        )
        .await
        .map_err(|e| KeyStoreError::Chain(e.to_string()))?;
        tenants.push(TenantRewrap {
            organisation: tenant,
            key_epochs_rewrapped: epochs,
            chain_entry_seq: appended.seq,
        });
    }

    // The deployment-wide summary, on the one deployment-wide chain. The site
    // chain's metadata key derives from the chain master, which a re-wrap does
    // not touch.
    let deployment = crate::chains::deployment_id(&*tx)
        .await
        .map_err(|e| KeyStoreError::Chain(e.to_string()))?;
    let site_metadata = site_rewrap_metadata(by, from_id, to_id, &tenants, rows.len());
    let site = crate::chains::append_site(
        &tx,
        &new_ring,
        &deployment,
        crate::chain::EntryType::Rewrap,
        &site_metadata,
    )
    .await
    .map_err(|e| KeyStoreError::Chain(e.to_string()))?;

    tx.commit().await?;

    Ok(RewrapReport {
        operation: KeyOperation::Rewrap,
        from_master_key_id: from_id,
        to_master_key_id: to_id,
        tenants_rewrapped: tenants.len(),
        tenant_key_rows_rewrapped: rows.len(),
        tenants,
        subordinate_key_rows_rewrapped: 0,
        payload_versions_reencrypted: 0,
        old_master_key: OldKeyDisposition::RetainedOutsideThisProcess,
        site_chain_entry_seq: site.seq,
    })
}

/// One tenant's sealed entry: old and new master identity, which of **its** key
/// rows moved, who ran it, and, **as a statement of fact in the entry itself**,
/// that no payload was re-encrypted.
///
/// A reader in two years asking whether the estate was ever exposed needs the
/// answer inside the sealed record, not inferred from documentation.
fn rewrap_metadata(
    actor: &str,
    organisation: &str,
    from: KeyId,
    to: KeyId,
    epochs: &[i32],
) -> Vec<u8> {
    let mut map = std::collections::BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(actor.to_string()));
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

/// The deployment-wide summary entry's metadata: both master identities, how
/// many tenants and rows moved, and who ran it.
///
/// **No organisation ids.** A verifier holding `chain_master` can read
/// site-chain metadata (0009's header), and which tenants exist is the
/// organisation chains' business; a count is all that is written here.
fn site_rewrap_metadata(
    actor: &str,
    from: KeyId,
    to: KeyId,
    tenants: &[TenantRewrap],
    rows: usize,
) -> Vec<u8> {
    let mut map = std::collections::BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(actor.to_string()));
    map.insert(
        "entry_type".to_string(),
        Json::Str(crate::chain::EntryType::Rewrap.as_str().to_string()),
    );
    map.insert(
        "operation".to_string(),
        Json::Str(KeyOperation::Rewrap.as_str().to_string()),
    );
    map.insert(
        "from_master_key_id".to_string(),
        Json::Str(from.to_string()),
    );
    map.insert("to_master_key_id".to_string(), Json::Str(to.to_string()));
    map.insert(
        "tenants_rewrapped".to_string(),
        Json::Int(tenants.len() as i64),
    );
    map.insert(
        "tenant_key_rows_rewrapped".to_string(),
        Json::Int(rows as i64),
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
/// §12.3's birthday bound is per key: the tenant key seals a wrap with a fresh
/// random 96-bit nonce whenever a design key is minted or rotated.
/// `tenant_keys.writes_under_key` existed from 0007 but nothing incremented it,
/// so the detector could never fire; a counter that cannot count reads as false
/// evidence.
///
/// **A detector, never the nonce source** (§12.3): nothing in the write path
/// consults this to build a nonce, and nothing may be added that does.
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

/// Count one AEAD message under an **organisation content key** — the same
/// detector, for the third layer that had none.
///
/// The column existed from 0009 but nothing incremented it, so the alarm could
/// never fire and the column read as evidence the key was unused.
///
/// One message per organisation-chain append: `chains::append_locked` seals
/// that entry's metadata under this key with a fresh random 96-bit nonce
/// (§12.3's per-key birthday bound). Organisation entries accumulate for a
/// tenant's life and are never re-encrypted, so this is the counter most likely
/// to reach the budget first.
///
/// **A detector, never the nonce source** (§12.3). Nothing in the write path
/// consults it to build a nonce and nothing may be added that does.
pub async fn count_write_under_org_content_key(
    tx: &Transaction<'_>,
    tenant: &str,
    epoch: i32,
) -> Result<i64, KeyStoreError> {
    let row = tx
        .query_one(
            "UPDATE org_content_keys SET writes_under_key = writes_under_key + 1 \
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
            "an organisation content key has passed its random-nonce write budget; mint the \
             next epoch. This counter is a detector and is not the nonce source."
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

/// Open a **retired** design key's wrap, for reading a version written under an
/// older epoch. Retired data keys are kept forever (§12.6) or those versions
/// become unreadable.
///
/// It uses the same [`unwrap`] path as everything else, so a moved retired row
/// is `Misbound` here as an active one would be.
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
        // Different strings even when the identifiers line up: the domain tag is
        // length-prefixed first.
        assert_ne!(tenant_key_aad("abc", 1), design_key_aad("abc", "", 1));
        // And neither can be spliced.
        assert_ne!(design_key_aad("ab", "c", 1), design_key_aad("a", "bc", 1));
        assert_ne!(tenant_key_aad("a", 1), tenant_key_aad("a", 2));
    }

    #[test]
    fn a_tenant_key_wrapped_for_one_tenant_is_misbound_for_another() {
        // The database path's check without a database: it catches a key row moved
        // between organisations, and is a DIFFERENT error from a failed tag.
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
        // §6's B5 fix: the chain master is a DIFFERENT key from the master
        // hierarchy. Both settings naming one file is a copy-paste away and nothing
        // downstream would fail.
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
