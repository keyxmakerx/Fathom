//! Encrypted design storage, and the sealed history that goes with it.
//!
//! `docs/PHASE-2-STORAGE-DESIGN.md` §§2a, 3, 4, 6, 11.2, 12. Every write here
//! does three things in one transaction — encrypt the payload, store it, and
//! append a sealed chain entry — because a payload written without its entry
//! is a history with a hole in it, and a hole is indistinguishable from an
//! erasure.
//!
//! # Who encrypts, said once more because it is the thing most often misread
//!
//! §2a: **the server encrypts.** Plaintext designs exist in this process on
//! every read and write. Encryption protects the database, the backups and the
//! disk — not the running process. Nothing customer-facing may describe design
//! data as unreadable by Fathom.
//!
//! # Whole payload, not per field
//!
//! §3: partial encryption leaks structure. Encrypt device names but leave link
//! counts, node counts and edge types in the clear and an attacker with the
//! database learns the estate's shape without decrypting anything. What that
//! costs is stated there and inherited here: no server-side search, no
//! server-side rendering, no cross-design queries.

use core::fmt;
use std::collections::BTreeMap;

use deadpool_postgres::{Pool, PoolError, Transaction};

use fathom_canon::Json;

use crate::chain::{self, EntryType};
use crate::crypto::{self};
use crate::keys::{self, DataKey, KeyRing, KeyStoreError};
use crate::repo::{self, AccountId, DesignId, OrganisationId, RepoError, ScopeId, TenantContext};

/// The domain tag in a payload seal's associated data.
const AAD_PAYLOAD: &[u8] = b"fathom/payload/v1";

/// The chain key epoch everything is written under today. Retired chain keys
/// are kept forever and every entry carries its own epoch (§11.2), so raising
/// this later is a new key and a new epoch, never a rewrite.
const CHAIN_KEY_EPOCH: i32 = 1;

/// A ceiling on one design payload, so that a single request cannot ask this
/// process to hold an unbounded buffer — and so that the AEAD's own limit is
/// never the thing that decides.
///
/// §3's scale argument is *"thousands of devices per design is a payload
/// measured in megabytes"*. 64 MiB is far above that and far below anything
/// that threatens the process.
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;

/// One stored version, decrypted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesignVersion {
    pub design: DesignId,
    pub version: i64,
    pub payload_schema_version: i32,
    pub payload: Vec<u8>,
}

/// What a rotation did, in the words §12.6 requires — **counts rather than a
/// boolean**, and the operation named `rotate`, never a verb shared with
/// re-wrap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RotationReport {
    pub design: DesignId,
    pub from_key_epoch: i32,
    pub to_key_epoch: i32,
    pub versions_reencrypted: usize,
    pub chain_entries_written: usize,
}

impl fmt::Display for RotationReport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "rotate: design {}, key epoch {} -> {}, {} version(s) re-encrypted, {} reencrypt \
             entry/entries written. This re-encrypted data and therefore revokes the previous \
             key. Verification will report the new storage bindings, accounted for by those \
             entries; the plaintext bindings are unchanged, which is the proof the content did \
             not change when the bytes did.",
            self.design,
            self.from_key_epoch,
            self.to_key_epoch,
            self.versions_reencrypted,
            self.chain_entries_written
        )
    }
}

/// Anything the design store can refuse.
#[derive(Debug)]
pub enum DesignError {
    Pool(PoolError),
    Db(tokio_postgres::Error),
    Repo(RepoError),
    Keys(KeyStoreError),
    Crypto(crypto::CryptoError),
    /// The design does not exist in this tenant. A design id belonging to
    /// another tenant reads exactly like one that never existed, which is the
    /// right answer to give.
    NoSuchDesign,
    /// No such version of this design.
    NoSuchVersion,
    /// No such scope in this tenant to hang the design on. A scope id from
    /// another organisation reads the same way, which is the right answer.
    NoSuchScope,
    /// Larger than [`MAX_PAYLOAD_BYTES`].
    PayloadTooLarge {
        bytes: usize,
    },
    /// The stored row did not decrypt. **This is the sentence that must not be
    /// reached by a wrong master key**: `keys::register_master_key` runs
    /// before any key is used precisely so that the wrong-key case reports
    /// which key ids differ (ADR-0043 §4) rather than arriving here looking
    /// like corruption.
    Refused,
    /// A stored row is not shaped like one this server wrote.
    Corrupt(&'static str),
}

impl fmt::Display for DesignError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pool(_) => f.write_str("could not get a database connection"),
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Repo(e) => write!(f, "{e}"),
            Self::Keys(e) => write!(f, "{e}"),
            Self::Crypto(e) => write!(f, "{e}"),
            Self::NoSuchDesign => f.write_str("no such design in this organisation"),
            Self::NoSuchVersion => f.write_str("no such version of this design"),
            Self::NoSuchScope => f.write_str("no such scope in this organisation"),
            Self::PayloadTooLarge { bytes } => write!(
                f,
                "that payload is {bytes} bytes; one design version may be at most \
                 {MAX_PAYLOAD_BYTES}"
            ),
            Self::Refused => f.write_str(
                "the stored payload did not authenticate under the key this design is filed \
                 under. Check the master key id reported at startup before treating this as \
                 corruption.",
            ),
            Self::Corrupt(what) => write!(f, "a stored {what} is not shaped like one we wrote"),
        }
    }
}

impl std::error::Error for DesignError {}

impl From<PoolError> for DesignError {
    fn from(e: PoolError) -> Self {
        Self::Pool(e)
    }
}
impl From<tokio_postgres::Error> for DesignError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}
impl From<RepoError> for DesignError {
    fn from(e: RepoError) -> Self {
        Self::Repo(e)
    }
}
impl From<KeyStoreError> for DesignError {
    fn from(e: KeyStoreError) -> Self {
        Self::Keys(e)
    }
}
impl From<crypto::CryptoError> for DesignError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::Crypto(e)
    }
}

// ---------------------------------------------------------------------------
// The payload's associated data
// ---------------------------------------------------------------------------

/// What a payload seal is bound to.
///
/// **The AEAD's associated-data channel IS used here, and that is not a
/// contradiction of §4's B1 fix.** That fix scopes the empty-AAD rule to *key*
/// seals, where recovering the identity is what separates `Misbound` from
/// `Refused`; the same section says design-payload seals keep identity in the
/// AEAD. A payload has nothing to recover — either the row is the row it says
/// it is, or it does not authenticate.
fn payload_aad(
    tenant: &str,
    design: &str,
    version: i64,
    key_epoch: i32,
    payload_schema_version: i32,
) -> Vec<u8> {
    let mut aad = Vec::new();
    crypto::lp(&mut aad, AAD_PAYLOAD);
    crypto::lp(&mut aad, tenant.as_bytes());
    crypto::lp(&mut aad, design.as_bytes());
    crypto::u64_le(&mut aad, version as u64);
    crypto::u32_le(&mut aad, key_epoch as u32);
    crypto::u32_le(&mut aad, payload_schema_version as u32);
    aad
}

// ---------------------------------------------------------------------------
// Creating a design
// ---------------------------------------------------------------------------

/// Create a design at a scope. No name: see [`DesignId`].
pub async fn create_design(
    pool: &Pool,
    tenant: OrganisationId,
    actor: AccountId,
    scope: ScopeId,
) -> Result<DesignId, DesignError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let ctx = repo::open_tenant_context(&tx, tenant, actor).await?;

    let id = DesignId::new();
    // The scope must be in THIS tenant. `WHERE EXISTS` rather than a bare
    // insert so that a scope id from another organisation inserts nothing --
    // and the row count is then checked, because an insert that quietly
    // matched nothing and still returned an id would hand the caller a design
    // that does not exist.
    let inserted = tx
        .execute(
            "INSERT INTO designs (id, organisation_id, scope_id, created_by) \
             SELECT $1, $2, $3, $4 WHERE EXISTS \
                 (SELECT 1 FROM scopes WHERE id = $3 AND organisation_id = $2)",
            &[
                &id.to_string(),
                &ctx.tenant().to_string(),
                &scope.to_string(),
                &ctx.actor().to_string(),
            ],
        )
        .await?;
    if inserted != 1 {
        return Err(DesignError::NoSuchScope);
    }

    tx.commit().await?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// Writing a version
// ---------------------------------------------------------------------------

/// Encrypt a payload, store it as the next version, and seal a chain entry for
/// it — **one transaction, or none of it**.
pub async fn write_version(
    pool: &Pool,
    ring: &KeyRing,
    tenant: OrganisationId,
    actor: AccountId,
    design: DesignId,
    payload: &[u8],
    payload_schema_version: i32,
) -> Result<i64, DesignError> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(DesignError::PayloadTooLarge {
            bytes: payload.len(),
        });
    }

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let ctx = repo::open_tenant_context(&tx, tenant, actor).await?;

    let key = keys::design_key(&tx, ring, &ctx, design).await?;
    let tenant_text = ctx.tenant().to_string();
    let design_text = design.to_string();

    let version: i64 = tx
        .query_one(
            "SELECT coalesce(max(design_version), 0) + 1 FROM design_payload \
             WHERE design_id = $1 AND organisation_id = $2",
            &[&design_text, &tenant_text],
        )
        .await?
        .get(0);

    let nonce = crypto::random_nonce()?;
    let aad = payload_aad(
        &tenant_text,
        &design_text,
        version,
        key.epoch,
        payload_schema_version,
    );
    let ciphertext = crypto::seal(&key.key, &nonce, payload, &aad)?;

    tx.execute(
        "INSERT INTO design_payload \
             (design_id, organisation_id, design_version, ciphertext, nonce, key_epoch, \
              wrap_version, aead_alg_id, payload_schema_version, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        &[
            &design_text,
            &tenant_text,
            &version,
            &ciphertext,
            &nonce.to_vec(),
            &key.epoch,
            &crypto::WRAP_VERSION,
            &crypto::AEAD_ALG_CHACHA20POLY1305_IETF,
            &payload_schema_version,
            &ctx.actor().to_string(),
        ],
    )
    .await?;

    keys::count_write_under_key(&tx, design, key.epoch).await?;

    let entry_type = if version == 1 {
        EntryType::Create
    } else {
        EntryType::Update
    };
    let metadata = metadata_for_write(&ctx, version, payload_schema_version, entry_type);
    append_entry(
        &tx,
        ring,
        &ctx,
        design,
        AppendFacts {
            entry_type,
            design_version: version,
            plaintext: Some(payload),
            payload_schema_version,
            key: &key,
            nonce: &nonce,
            ciphertext: &ciphertext,
            carried_plaintext_binding: None,
            metadata: &metadata,
        },
    )
    .await?;

    tx.commit().await?;
    Ok(version)
}

// ---------------------------------------------------------------------------
// Reading a version
// ---------------------------------------------------------------------------

/// Read one version, or the latest if `version` is `None`.
pub async fn read_version(
    pool: &Pool,
    ring: &KeyRing,
    tenant: OrganisationId,
    actor: AccountId,
    design: DesignId,
    version: Option<i64>,
) -> Result<DesignVersion, DesignError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let ctx = repo::open_tenant_context(&tx, tenant, actor).await?;

    let tenant_text = ctx.tenant().to_string();
    let design_text = design.to_string();

    let row = match version {
        Some(v) => {
            tx.query_opt(
                "SELECT design_version, ciphertext, nonce, key_epoch, payload_schema_version \
                 FROM design_payload \
                 WHERE design_id = $1 AND organisation_id = $2 AND design_version = $3",
                &[&design_text, &tenant_text, &v],
            )
            .await?
        }
        None => {
            tx.query_opt(
                "SELECT design_version, ciphertext, nonce, key_epoch, payload_schema_version \
                 FROM design_payload \
                 WHERE design_id = $1 AND organisation_id = $2 \
                 ORDER BY design_version DESC LIMIT 1",
                &[&design_text, &tenant_text],
            )
            .await?
        }
    };
    let row = row.ok_or(DesignError::NoSuchVersion)?;

    let version: i64 = row.get(0);
    let ciphertext: Vec<u8> = row.get(1);
    let nonce: Vec<u8> = row.get(2);
    let key_epoch: i32 = row.get(3);
    let payload_schema_version: i32 = row.get(4);

    let key = design_key_at_epoch(&tx, ring, &ctx, design, key_epoch).await?;
    let payload = open_payload(
        &key,
        &tenant_text,
        &design_text,
        version,
        key_epoch,
        payload_schema_version,
        &nonce,
        &ciphertext,
    )?;

    tx.commit().await?;
    Ok(DesignVersion {
        design,
        version,
        payload_schema_version,
        payload,
    })
}

// ---------------------------------------------------------------------------
// Rotation — the only operation that revokes anything (§12.6)
// ---------------------------------------------------------------------------

/// Re-encrypt every version of a design under a new key, writing one
/// `reencrypt` chain entry per version.
///
/// **This is rotation, not re-wrap, and the two words are never
/// interchangeable** (§12.6). Rotation writes new bytes and revokes the old
/// key. Re-wrap changes custody only — it leaves ciphertext, nonce,
/// `content_hash` and `storage_binding` byte-identical, revokes nothing, and
/// is not implemented here; see `keys::rotate_design_key`'s doc for why its
/// audit trail must land with it.
pub async fn rotate_design(
    pool: &Pool,
    ring: &KeyRing,
    tenant: OrganisationId,
    actor: AccountId,
    design: DesignId,
    reason: &str,
) -> Result<RotationReport, DesignError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let ctx = repo::open_tenant_context(&tx, tenant, actor).await?;

    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await?;
    let rotation = keys::rotate_design_key(&tx, &ctx, &tenant_key, design, reason).await?;

    let tenant_text = ctx.tenant().to_string();
    let design_text = design.to_string();

    let rows = tx
        .query(
            "SELECT design_version, ciphertext, nonce, key_epoch, payload_schema_version \
             FROM design_payload \
             WHERE design_id = $1 AND organisation_id = $2 ORDER BY design_version",
            &[&design_text, &tenant_text],
        )
        .await?;

    let mut versions = 0usize;
    let mut entries = 0usize;

    for row in rows {
        let version: i64 = row.get(0);
        let old_ciphertext: Vec<u8> = row.get(1);
        let old_nonce: Vec<u8> = row.get(2);
        let old_epoch: i32 = row.get(3);
        let payload_schema_version: i32 = row.get(4);

        if old_epoch != rotation.previous.epoch {
            // A version under an epoch older than the one just retired. Not
            // reachable today (rotation re-encrypts every version), and left
            // explicit rather than silently skipped.
            return Err(DesignError::Corrupt("payload key epoch"));
        }

        let plaintext = open_payload(
            &rotation.previous,
            &tenant_text,
            &design_text,
            version,
            old_epoch,
            payload_schema_version,
            &old_nonce,
            &old_ciphertext,
        )?;

        let nonce = crypto::random_nonce()?;
        let aad = payload_aad(
            &tenant_text,
            &design_text,
            version,
            rotation.current.epoch,
            payload_schema_version,
        );
        let ciphertext = crypto::seal(&rotation.current.key, &nonce, &plaintext, &aad)?;

        tx.execute(
            "UPDATE design_payload SET ciphertext = $4, nonce = $5, key_epoch = $6 \
             WHERE design_id = $1 AND organisation_id = $2 AND design_version = $3",
            &[
                &design_text,
                &tenant_text,
                &version,
                &ciphertext,
                &nonce.to_vec(),
                &rotation.current.epoch,
            ],
        )
        .await?;

        keys::count_write_under_key(&tx, design, rotation.current.epoch).await?;

        // §11.2: a `reencrypt` entry carries `plaintext_binding` across
        // UNCHANGED -- which is itself the proof that the content did not
        // change when the bytes did -- and records old and new epochs, wrap
        // versions and storage bindings.
        let previous = last_entry_for_version(&tx, &design_text, &tenant_text, version).await?;
        let metadata = metadata_for_reencrypt(
            &ctx,
            version,
            payload_schema_version,
            old_epoch,
            rotation.current.epoch,
            &previous.storage_binding,
            reason,
        );

        append_entry(
            &tx,
            ring,
            &ctx,
            design,
            AppendFacts {
                entry_type: EntryType::Reencrypt,
                design_version: version,
                plaintext: Some(&plaintext),
                payload_schema_version,
                key: &rotation.current,
                nonce: &nonce,
                ciphertext: &ciphertext,
                carried_plaintext_binding: Some(&previous.plaintext_binding),
                metadata: &metadata,
            },
        )
        .await?;

        versions += 1;
        entries += 1;
    }

    tx.commit().await?;

    Ok(RotationReport {
        design,
        from_key_epoch: rotation.previous.epoch,
        to_key_epoch: rotation.current.epoch,
        versions_reencrypted: versions,
        chain_entries_written: entries,
    })
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// Verify a design's chain.
///
/// `deep` decides which of §11.2's two levels runs, and **the answer names
/// which one it was**: a links-only run reports *links verified, content not
/// re-bound*, which must never render the same as content that was checked.
pub async fn verify_design(
    pool: &Pool,
    ring: &KeyRing,
    tenant: OrganisationId,
    actor: AccountId,
    design: DesignId,
    deep: bool,
) -> Result<chain::Report, DesignError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let ctx = repo::open_tenant_context(&tx, tenant, actor).await?;

    let tenant_text = ctx.tenant().to_string();
    let design_text = design.to_string();

    let exists = tx
        .query_opt(
            "SELECT 1 FROM designs WHERE id = $1 AND organisation_id = $2",
            &[&design_text, &tenant_text],
        )
        .await?;
    if exists.is_none() {
        return Err(DesignError::NoSuchDesign);
    }

    let entries = read_entries(&tx, &design_text, &tenant_text).await?;
    let payloads = read_payload_facts(&tx, &design_text, &tenant_text).await?;

    // Every chain key epoch the entries name, derived from the chain master
    // this server holds. An epoch it cannot derive is a coverage gap, and the
    // verifier says so rather than calling it broken.
    let mut by_epoch = Vec::new();
    for epoch in entries
        .iter()
        .map(|e| e.chain_key_epoch)
        .collect::<std::collections::BTreeSet<_>>()
    {
        if epoch != CHAIN_KEY_EPOCH {
            continue;
        }
        let ck = chain::chain_key(ring.chain_master(), &tenant_text, &design_text, epoch);
        by_epoch.push((epoch, chain::Subkeys::derive(&ck)));
    }
    let keys_available = chain::AvailableKeys { by_epoch };

    let plaintexts = if deep {
        let mut out: Vec<(i64, Vec<u8>)> = Vec::new();
        for p in &payloads {
            let key = design_key_at_epoch(&tx, ring, &ctx, design, p.key_epoch).await?;
            let bytes = open_payload(
                &key,
                &tenant_text,
                &design_text,
                p.design_version,
                p.key_epoch,
                p.payload_schema_version,
                &p.nonce,
                &p.ciphertext,
            )?;
            out.push((p.design_version, bytes));
        }
        Some(out)
    } else {
        None
    };

    let report = chain::verify(
        &tenant_text,
        &design_text,
        &entries,
        &payloads,
        &keys_available,
        plaintexts.as_deref(),
    );

    tx.commit().await?;
    Ok(report)
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

struct AppendFacts<'a> {
    entry_type: EntryType,
    design_version: i64,
    plaintext: Option<&'a [u8]>,
    payload_schema_version: i32,
    key: &'a DataKey,
    nonce: &'a [u8; crypto::NONCE_LEN],
    ciphertext: &'a [u8],
    /// `Some` for a `reencrypt` entry: §11.2's binding carried across
    /// unchanged. `None` everywhere else, where it is computed from the
    /// plaintext in hand.
    carried_plaintext_binding: Option<&'a [u8]>,
    metadata: &'a [u8],
}

async fn append_entry(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    facts: AppendFacts<'_>,
) -> Result<(), DesignError> {
    let tenant_text = ctx.tenant().to_string();
    let design_text = design.to_string();

    let ck = chain::chain_key(
        ring.chain_master(),
        &tenant_text,
        &design_text,
        CHAIN_KEY_EPOCH,
    );
    let sub = chain::Subkeys::derive(&ck);

    let tip = tx
        .query_opt(
            "SELECT seq, seal FROM chain_entries \
             WHERE design_id = $1 AND organisation_id = $2 ORDER BY seq DESC LIMIT 1",
            &[&design_text, &tenant_text],
        )
        .await?;
    let (seq, prev_seal) = match tip {
        Some(row) => {
            let seq: i64 = row.get(0);
            let seal: Vec<u8> = row.get(1);
            (seq + 1, seal)
        }
        None => (1, chain::genesis(&tenant_text, &design_text).to_vec()),
    };

    let plaintext_binding: Vec<u8> = match facts.carried_plaintext_binding {
        Some(carried) => carried.to_vec(),
        None => {
            let bytes = facts.plaintext.unwrap_or(&[]);
            chain::plaintext_binding(
                &sub.content,
                &chain::PlaintextFacts {
                    tenant: &tenant_text,
                    design: &design_text,
                    design_version: facts.design_version,
                    payload_schema_version: facts.payload_schema_version,
                    payload: bytes,
                },
            )
            .to_vec()
        }
    };

    let storage_binding = chain::storage_binding(
        &sub.content,
        &chain::StorageFacts {
            key_id: facts.key.id,
            key_epoch: facts.key.epoch,
            wrap_version: crypto::WRAP_VERSION,
            aead_alg_id: crypto::AEAD_ALG_CHACHA20POLY1305_IETF,
            nonce: facts.nonce,
            ciphertext: facts.ciphertext,
        },
    );

    let content_hash =
        chain::content_hash(&sub.content, &to32(&plaintext_binding), &storage_binding);

    let seal = chain::seal(
        &sub.seal,
        &chain::SealFacts {
            chain_key_epoch: CHAIN_KEY_EPOCH,
            seq,
            tenant: &tenant_text,
            design: &design_text,
            prev_seal: &prev_seal,
            content_hash: &content_hash,
            entry_type: facts.entry_type,
            metadata: facts.metadata,
        },
    );

    tx.execute(
        "INSERT INTO chain_entries \
             (design_id, organisation_id, seq, entry_type, chain_key_epoch, design_version, \
              prev_seal, plaintext_binding, storage_binding, content_hash, seal, metadata) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        &[
            &design_text,
            &tenant_text,
            &seq,
            &facts.entry_type.as_str(),
            &CHAIN_KEY_EPOCH,
            &facts.design_version,
            &prev_seal,
            &plaintext_binding,
            &storage_binding.to_vec(),
            &content_hash.to_vec(),
            &seal.to_vec(),
            &facts.metadata.to_vec(),
        ],
    )
    .await?;

    Ok(())
}

struct PreviousEntry {
    plaintext_binding: Vec<u8>,
    storage_binding: Vec<u8>,
}

async fn last_entry_for_version(
    tx: &Transaction<'_>,
    design: &str,
    tenant: &str,
    version: i64,
) -> Result<PreviousEntry, DesignError> {
    let row = tx
        .query_opt(
            "SELECT plaintext_binding, storage_binding FROM chain_entries \
             WHERE design_id = $1 AND organisation_id = $2 AND design_version = $3 \
             ORDER BY seq DESC LIMIT 1",
            &[&design, &tenant, &version],
        )
        .await?
        .ok_or(DesignError::Corrupt("chain entry for a stored version"))?;
    Ok(PreviousEntry {
        plaintext_binding: row.get(0),
        storage_binding: row.get(1),
    })
}

async fn read_entries(
    tx: &Transaction<'_>,
    design: &str,
    tenant: &str,
) -> Result<Vec<chain::StoredEntry>, DesignError> {
    let rows = tx
        .query(
            "SELECT seq, entry_type, chain_key_epoch, design_version, prev_seal, \
                    plaintext_binding, storage_binding, content_hash, seal, metadata \
             FROM chain_entries WHERE design_id = $1 AND organisation_id = $2 ORDER BY seq",
            &[&design, &tenant],
        )
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let entry_type: String = row.get(1);
        out.push(chain::StoredEntry {
            seq: row.get(0),
            entry_type: EntryType::parse(&entry_type)
                .ok_or(DesignError::Corrupt("chain entry type"))?,
            chain_key_epoch: row.get(2),
            design_version: row.get(3),
            prev_seal: row.get(4),
            plaintext_binding: row.get(5),
            storage_binding: row.get(6),
            content_hash: row.get(7),
            seal: row.get(8),
            metadata: row.get(9),
        });
    }
    Ok(out)
}

async fn read_payload_facts(
    tx: &Transaction<'_>,
    design: &str,
    tenant: &str,
) -> Result<Vec<chain::StoredPayload>, DesignError> {
    // The key id comes from `design_keys`, which is where a verifier holding
    // only the chain key finds it: it is the data key's NON-SECRET id, not the
    // key.
    let rows = tx
        .query(
            "SELECT p.design_version, k.key_id, p.key_epoch, p.wrap_version, p.aead_alg_id, \
                    p.nonce, p.ciphertext, p.payload_schema_version \
             FROM design_payload p \
             JOIN design_keys k \
               ON k.design_id = p.design_id AND k.key_epoch = p.key_epoch \
             WHERE p.design_id = $1 AND p.organisation_id = $2 ORDER BY p.design_version",
            &[&design, &tenant],
        )
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let key_id: String = row.get(1);
        out.push(chain::StoredPayload {
            design_version: row.get(0),
            key_id: crypto::KeyId::parse(&key_id).ok_or(DesignError::Corrupt("key id"))?,
            key_epoch: row.get(2),
            wrap_version: row.get(3),
            aead_alg_id: row.get(4),
            nonce: row.get(5),
            ciphertext: row.get(6),
            payload_schema_version: row.get(7),
        });
    }
    Ok(out)
}

/// The design key at a given epoch — the active one, or a retired one for an
/// older version. **Retired data keys are kept forever** (§12.6), or old
/// versions become unreadable.
async fn design_key_at_epoch(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    epoch: i32,
) -> Result<DataKey, DesignError> {
    let tenant_key = keys::tenant_key(tx, ring, ctx).await?;
    let active = keys::design_key_under(tx, ctx, &tenant_key, design).await?;
    if active.epoch == epoch {
        return Ok(active);
    }
    // A retired epoch. Read it by epoch explicitly rather than by status, so
    // that "the key for these bytes" and "the key to write with" are two
    // different questions with two different answers.
    let row = tx
        .query_opt(
            "SELECT key_id, wrapped_key, wrap_nonce FROM design_keys \
             WHERE design_id = $1 AND organisation_id = $2 AND key_epoch = $3",
            &[&design.to_string(), &ctx.tenant().to_string(), &epoch],
        )
        .await?
        .ok_or(DesignError::Corrupt("design key epoch"))?;

    let id_text: String = row.get(0);
    let wrapped: Vec<u8> = row.get(1);
    let nonce: Vec<u8> = row.get(2);
    let key = keys::unwrap_design_key(
        &tenant_key,
        &ctx.tenant().to_string(),
        &design.to_string(),
        epoch,
        &wrapped,
        &nonce,
    )?;
    let id = key.id();
    if id.to_string() != id_text {
        return Err(DesignError::Corrupt("design key id"));
    }
    Ok(DataKey { key, epoch, id })
}

#[allow(clippy::too_many_arguments)]
fn open_payload(
    key: &DataKey,
    tenant: &str,
    design: &str,
    version: i64,
    key_epoch: i32,
    payload_schema_version: i32,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, DesignError> {
    let nonce: [u8; crypto::NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| DesignError::Corrupt("payload nonce"))?;
    let aad = payload_aad(tenant, design, version, key_epoch, payload_schema_version);
    crypto::open(&key.key, &nonce, ciphertext, &aad).map_err(|_| DesignError::Refused)
}

fn to32(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let n = bytes.len().min(32);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

// ---------------------------------------------------------------------------
// Metadata — canonical bytes, because the seal covers them
// ---------------------------------------------------------------------------

fn metadata_for_write(
    ctx: &TenantContext,
    version: i64,
    payload_schema_version: i32,
    entry_type: EntryType,
) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(ctx.actor().to_string()));
    map.insert(
        "entry_type".to_string(),
        Json::Str(entry_type.as_str().to_string()),
    );
    map.insert("design_version".to_string(), Json::Int(version));
    map.insert(
        "payload_schema_version".to_string(),
        Json::Int(i64::from(payload_schema_version)),
    );
    Json::Obj(map).to_canonical_bytes()
}

#[allow(clippy::too_many_arguments)]
fn metadata_for_reencrypt(
    ctx: &TenantContext,
    version: i64,
    payload_schema_version: i32,
    from_epoch: i32,
    to_epoch: i32,
    from_storage_binding: &[u8],
    reason: &str,
) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(ctx.actor().to_string()));
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::Reencrypt.as_str().to_string()),
    );
    map.insert("design_version".to_string(), Json::Int(version));
    map.insert(
        "payload_schema_version".to_string(),
        Json::Int(i64::from(payload_schema_version)),
    );
    map.insert(
        "from_key_epoch".to_string(),
        Json::Int(i64::from(from_epoch)),
    );
    map.insert("to_key_epoch".to_string(), Json::Int(i64::from(to_epoch)));
    map.insert(
        "from_wrap_version".to_string(),
        Json::Int(i64::from(crypto::WRAP_VERSION)),
    );
    map.insert(
        "to_wrap_version".to_string(),
        Json::Int(i64::from(crypto::WRAP_VERSION)),
    );
    map.insert(
        "from_storage_binding".to_string(),
        Json::Str(hex(from_storage_binding)),
    );
    map.insert("reason".to_string(), Json::Str(reason.to_string()));
    Json::Obj(map).to_canonical_bytes()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_payloads_associated_data_pins_every_coordinate_of_the_row() {
        let base = payload_aad("T", "D", 1, 1, 1);
        assert_ne!(base, payload_aad("T2", "D", 1, 1, 1));
        assert_ne!(base, payload_aad("T", "D2", 1, 1, 1));
        assert_ne!(base, payload_aad("T", "D", 2, 1, 1));
        assert_ne!(base, payload_aad("T", "D", 1, 2, 1));
        assert_ne!(base, payload_aad("T", "D", 1, 1, 2));
        // And it cannot be spliced: `T`+`D2` is not `T2`+`D`.
        assert_ne!(
            payload_aad("ab", "c", 1, 1, 1),
            payload_aad("a", "bc", 1, 1, 1)
        );
    }
}
