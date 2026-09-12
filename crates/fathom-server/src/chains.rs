//! The **site** and **organisation** chains: appending to them, reading them
//! back, and verifying them.
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7. The per-design edit chain lives
//! in `designs`, because every one of its entries is written beside a payload
//! and shares that transaction's locks. These two are written beside acts that
//! have no payload at all, so they live here.
//!
//! **`chain` is still the only thing that decides what verifies.** This module
//! holds SQL and key handling; every seal, binding and ordering rule comes from
//! there unchanged. That is deliberate: a second verifier is a second place for
//! §12.6a's ordering rule — the one an attack found — to be right or wrong.
//!
//! # What is deferred, per §15.6, and said here rather than half-built
//!
//! §15.6 ships the chains early and puts **receipts, the witness and anchors**
//! after the admin surface. So none of the following exists yet, and the
//! documentation may not imply otherwise:
//!
//! - **Receipts (§7.4).** A tip digest counts as anchored only when a receipt
//!   comes back signed by a key the server never holds. Until then a shipper
//!   target is a folder, not a witness, and `audit`'s shipper says exactly that
//!   at startup. Without receipts, §7.5's guarantees 1 and 2 are **absent**,
//!   not weakened.
//! - **Witness countersignatures and the challenge-back (§7.4).** A tier-3
//!   attacker holding the chain key can ship a forged stream at the right
//!   cadence and routine verification at the far end reports *verified* on a
//!   fabrication. Only a receipt the compromised box cannot mint fixes that.
//! - **Anchors and startup quarantine (§7.6).** Each seal binds backwards only,
//!   so restoring last month's tables produces a rollback this chain verifies
//!   perfectly. Nothing here detects that.
//! - **Heartbeats (§7.5).** A gap is an incident *at the witness*; with no
//!   witness, a heartbeat stream costs rows and proves nothing.
//!
//! # What the chains do buy today
//!
//! A database-only attacker — the tier-2 attacker, who holds `psql` and not the
//! key volume — cannot alter, delete or reorder an entry without the chain
//! reporting *broken at entry N*, and cannot erase one through any parent
//! because the fences are referential. That is the whole claim.

use deadpool_postgres::Transaction;

use fathom_canon::Json;
use std::collections::BTreeMap;

use crate::chain::{self, ChainKind, ChainRef, EntryType};
use crate::crypto::{self, Key32};
use crate::ids;
use crate::keys::{self, DataKey, KeyRing, KeyStoreError};
use crate::repo::TenantContext;

/// The chain key epoch every chain is written under today, matching
/// `designs::CHAIN_KEY_EPOCH`. Retired chain keys are kept forever and every
/// entry carries its own epoch (§11.2), so raising this is a new key and a new
/// epoch, never a rewrite.
pub const CHAIN_KEY_EPOCH: i32 = 1;

/// Anything the site or organisation chain can refuse.
#[derive(Debug)]
pub enum ChainStoreError {
    Db(tokio_postgres::Error),
    Keys(KeyStoreError),
    Crypto(crypto::CryptoError),
    /// A stored row is not self-consistent. Never silently repaired.
    Corrupt(&'static str),
    /// This database has no deployment identity, so the site chain has no name
    /// to be sealed under. `register_deployment` runs at startup, before
    /// anything appends.
    NoDeployment,
}

impl core::fmt::Display for ChainStoreError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Keys(e) => write!(f, "{e}"),
            Self::Crypto(e) => write!(f, "{e}"),
            Self::Corrupt(what) => write!(f, "a stored {what} is not consistent"),
            Self::NoDeployment => f.write_str(
                "this database has no deployment identity, so the site chain has no name to be \
                 sealed under",
            ),
        }
    }
}

impl std::error::Error for ChainStoreError {}

impl From<tokio_postgres::Error> for ChainStoreError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}

impl From<KeyStoreError> for ChainStoreError {
    fn from(e: KeyStoreError) -> Self {
        Self::Keys(e)
    }
}

impl From<crypto::CryptoError> for ChainStoreError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::Crypto(e)
    }
}

// ---------------------------------------------------------------------------
// The deployment's identity
// ---------------------------------------------------------------------------

/// This deployment's id, stamped on first start and never changed.
///
/// §7.1 derives the site chain key over a `deployment_id`, so there has to be
/// one, and it has to survive: rewriting it orphans every site entry ever
/// written and deleting it removes the site chain's only anchor. The
/// append-only trigger in `0009` refuses both, for every role.
///
/// Two containers starting at once is the ordinary case and is handled by the
/// one-row unique index plus `ON CONFLICT DO NOTHING`: one inserts, the other
/// reads back what the first wrote. There is no window in which two ids exist.
pub async fn register_deployment<C>(client: &C) -> Result<String, ChainStoreError>
where
    C: tokio_postgres::GenericClient,
{
    if let Some(row) = client.query_opt("SELECT id FROM deployments", &[]).await? {
        return Ok(row.get(0));
    }
    let id = ids::new_ulid().to_string();
    client
        .execute(
            "INSERT INTO deployments (id) VALUES ($1) ON CONFLICT DO NOTHING",
            &[&id],
        )
        .await?;
    let row = client
        .query_opt("SELECT id FROM deployments", &[])
        .await?
        .ok_or(ChainStoreError::NoDeployment)?;
    Ok(row.get(0))
}

/// Read the deployment id without creating one.
pub async fn deployment_id<C>(client: &C) -> Result<String, ChainStoreError>
where
    C: tokio_postgres::GenericClient,
{
    client
        .query_opt("SELECT id FROM deployments", &[])
        .await?
        .map(|row| row.get(0))
        .ok_or(ChainStoreError::NoDeployment)
}

// ---------------------------------------------------------------------------
// Appending
// ---------------------------------------------------------------------------

/// What one append produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Appended {
    pub seq: i64,
    pub seal: [u8; 32],
}

/// How an entry's metadata is protected on this chain.
enum MetadataKey {
    /// Site chain: derived from `chain_master` at the entry's own
    /// `chain_key_epoch`, so no extra column is needed to find it again.
    Derived(Key32),
    /// Organisation chain: a wrapped DEK, named by `metadata_key_epoch`.
    Wrapped { key: Key32, epoch: i32 },
}

/// Append a sealed entry to the **site** chain.
///
/// No tenant context, deliberately: a site entry is written at startup, before
/// any organisation exists. `0009`'s insert policy has a branch for exactly
/// that, and the migration says in full why a policy is not what protects this
/// chain — the seal is, and its key lives in a file PostgreSQL cannot read.
pub async fn append_site(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    entry_type: EntryType,
    metadata: &[u8],
) -> Result<Appended, ChainStoreError> {
    debug_assert!(entry_type.may_be_filed_on(ChainKind::Site));
    let chain = ChainRef::Site { deployment };
    let metadata_key = MetadataKey::Derived(chain::site_metadata_key(
        ring.chain_master(),
        deployment,
        CHAIN_KEY_EPOCH,
    ));
    append(tx, ring, chain, entry_type, metadata, metadata_key).await
}

/// Append a sealed entry to an **organisation** chain, writing `org_genesis`
/// first if the chain is empty.
///
/// The genesis entry is not ceremony: §7.2 names it, and it means the first
/// real act on a tenant's chain is never `seq 1`, so `prev_seal` is exercised
/// by the first thing anybody looks at rather than by the second.
pub async fn append_org(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    tenant_key: &DataKey,
    entry_type: EntryType,
    metadata: &[u8],
) -> Result<Appended, ChainStoreError> {
    append_org_as(
        tx,
        ring,
        &ctx.tenant().to_string(),
        &ctx.actor().to_string(),
        tenant_key,
        entry_type,
        metadata,
    )
    .await
}

/// The half of [`append_org`] that takes the organisation and the actor
/// directly, for the one act that has neither a tenant context nor an account:
/// `keys::rewrap_master_key`, which is deployment-wide because the master key
/// is, and enumerates its organisations rather than being handed one.
///
/// `pub(crate)`, deliberately. See `keys::tenant_key_for` for the same
/// argument: nothing outside this crate gains a way to name a tenant that did
/// not come from `repo::TenantContext`.
pub(crate) async fn append_org_as(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
    actor: &str,
    tenant_key: &DataKey,
    entry_type: EntryType,
    metadata: &[u8],
) -> Result<Appended, ChainStoreError> {
    debug_assert!(entry_type.may_be_filed_on(ChainKind::Org));
    let chain = ChainRef::Org { organisation };

    let content = keys::org_content_key_for(tx, organisation, tenant_key).await?;
    let metadata_key = MetadataKey::Wrapped {
        key: Key32::from_bytes(*content.key.expose()),
        epoch: content.epoch,
    };

    // The lock covers the genesis check and the append together: two
    // transactions that both found the chain empty would both write `seq 1`,
    // and the primary key would refuse one of them -- which is the good case,
    // and the bad case is two `org_genesis` entries racing a real act.
    lock(tx, chain).await?;

    if entry_type != EntryType::OrgGenesis && tip(tx, chain).await?.is_none() {
        let genesis_metadata = genesis_metadata(organisation, actor);
        append_locked(
            tx,
            ring,
            chain,
            EntryType::OrgGenesis,
            &genesis_metadata,
            &metadata_key,
        )
        .await?;
    }

    append_locked(tx, ring, chain, entry_type, metadata, &metadata_key).await
}

fn genesis_metadata(organisation: &str, actor: &str) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("actor".to_string(), Json::Str(actor.to_string()));
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::OrgGenesis.as_str().to_string()),
    );
    map.insert(
        "organisation".to_string(),
        Json::Str(organisation.to_string()),
    );
    Json::Obj(map).to_canonical_bytes()
}

async fn append(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    chain: ChainRef<'_>,
    entry_type: EntryType,
    metadata: &[u8],
    metadata_key: MetadataKey,
) -> Result<Appended, ChainStoreError> {
    lock(tx, chain).await?;
    append_locked(tx, ring, chain, entry_type, metadata, &metadata_key).await
}

/// One writer per chain at a time.
///
/// A transaction-scoped advisory lock rather than a row lock: the site chain's
/// anchor row is in a table the runtime role holds no `UPDATE` on, so
/// `SELECT ... FOR UPDATE` is not available to it, and an advisory lock needs
/// no privilege at all. Transaction-scoped means there is no `unlock` to
/// forget on an error path.
async fn lock(tx: &Transaction<'_>, chain: ChainRef<'_>) -> Result<(), ChainStoreError> {
    let name = format!("{}:{}", chain.kind().as_str(), chain.chain_id());
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        &[&name],
    )
    .await?;
    Ok(())
}

async fn tip(
    tx: &Transaction<'_>,
    chain: ChainRef<'_>,
) -> Result<Option<(i64, Vec<u8>)>, ChainStoreError> {
    let row = tx
        .query_opt(
            "SELECT seq, seal FROM chain_entries \
             WHERE chain_kind = $1 AND chain_id = $2 ORDER BY seq DESC LIMIT 1",
            &[&chain.kind().as_str(), &chain.chain_id()],
        )
        .await?;
    Ok(row.map(|r| (r.get(0), r.get(1))))
}

async fn append_locked(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    chain: ChainRef<'_>,
    entry_type: EntryType,
    metadata: &[u8],
    metadata_key: &MetadataKey,
) -> Result<Appended, ChainStoreError> {
    let ck = chain::chain_key(ring.chain_master(), chain, CHAIN_KEY_EPOCH);
    let sub = chain::Subkeys::derive(&ck);

    let (seq, prev_seal) = match tip(tx, chain).await? {
        Some((seq, seal)) => (seq + 1, seal),
        None => (1, chain::genesis(chain).to_vec()),
    };

    // No payload on either of these chains, so both content bindings carry the
    // keyed "this entry binds nothing" value and `content_hash` is computed by
    // the same function over the same shape as on a design entry. The seal
    // input does not branch.
    let absent = chain::absent_content_binding(&sub.content);
    let content_hash = chain::content_hash(&sub.content, &absent, &absent);

    // The binding is over the PLAINTEXT canonical bytes; the seal covers the
    // STORED bytes. On these two chains those are different things, which is
    // the whole point of the metadata tier.
    let metadata_binding = chain::metadata_binding(&sub.content, metadata);

    let (key, key_epoch, stored_epoch) = match metadata_key {
        MetadataKey::Derived(key) => (key, CHAIN_KEY_EPOCH, None),
        MetadataKey::Wrapped { key, epoch } => (key, *epoch, Some(*epoch)),
    };
    let nonce = crypto::random_nonce()?;
    let aad = chain::metadata_aad(chain, seq, key_epoch);
    let metadata_stored = crypto::seal(key, &nonce, metadata, &aad)?;

    let seal = chain::seal(
        &sub.seal,
        &chain::SealFacts {
            chain_key_epoch: CHAIN_KEY_EPOCH,
            seq,
            chain,
            prev_seal: &prev_seal,
            content_hash: &content_hash,
            entry_type,
            metadata_stored: &metadata_stored,
            metadata_binding: &metadata_binding,
        },
    );

    tx.execute(
        "INSERT INTO chain_entries \
             (chain_kind, chain_id, organisation_id, seq, entry_type, chain_key_epoch, \
              prev_seal, plaintext_binding, storage_binding, content_hash, seal, metadata, \
              metadata_binding, metadata_key_epoch, metadata_nonce, metadata_aead_alg_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
        &[
            &chain.kind().as_str(),
            &chain.chain_id(),
            &chain.organisation(),
            &seq,
            &entry_type.as_str(),
            &CHAIN_KEY_EPOCH,
            &prev_seal,
            &absent.to_vec(),
            &absent.to_vec(),
            &content_hash.to_vec(),
            &seal.to_vec(),
            &metadata_stored,
            &metadata_binding.to_vec(),
            &stored_epoch,
            &nonce.to_vec(),
            &crypto::AEAD_ALG_CHACHA20POLY1305_IETF,
        ],
    )
    .await?;

    // One AEAD message under the organisation content key: the metadata seal
    // above. §12.3's birthday bound is per key, so the key that seals an entry
    // on every organisation append is the one most likely to reach the budget
    // first -- and organisation entries are append-only, so they can never be
    // re-encrypted under a fresh one. A detector, never the nonce source.
    //
    // Nothing to count on the site chain: its metadata key is DERIVED from
    // `chain_master` per epoch, so it has no row to count in and no wrap to
    // age. That asymmetry is §7.3's, not this function's.
    if let MetadataKey::Wrapped { epoch, .. } = metadata_key {
        let organisation = chain.organisation().ok_or(ChainStoreError::Corrupt(
            "organisation chain with no tenant",
        ))?;
        keys::count_write_under_org_content_key(tx, organisation, *epoch).await?;
    }

    // **The same transaction.** An act that cannot queue its audit line does
    // not commit, which is what makes "stopping the log stops the act"
    // mechanical rather than aspirational. See `audit`'s module doc.
    crate::audit::spool(
        tx,
        chain.kind(),
        chain.chain_id(),
        seq,
        entry_type,
        CHAIN_KEY_EPOCH,
        &seal,
    )
    .await?;

    Ok(Appended { seq, seal })
}

// ---------------------------------------------------------------------------
// Reading and verifying
// ---------------------------------------------------------------------------

/// Every entry on one chain, in `seq` order, as the verifier wants them.
pub async fn read_entries(
    tx: &Transaction<'_>,
    chain: ChainRef<'_>,
) -> Result<Vec<chain::StoredEntry>, ChainStoreError> {
    let rows = tx
        .query(
            "SELECT seq, entry_type, chain_key_epoch, design_version, prev_seal, \
                    plaintext_binding, storage_binding, content_hash, seal, metadata, \
                    metadata_binding \
             FROM chain_entries WHERE chain_kind = $1 AND chain_id = $2 ORDER BY seq",
            &[&chain.kind().as_str(), &chain.chain_id()],
        )
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        // **Carried, never refused.** A type this build cannot parse is a
        // break AT THAT ROW (`BreakReason::EntryTypeNotRecognised`), with
        // everything before it still reported verified. Returning an error
        // here -- which is what this did until 2026-09-12 -- let one junk
        // value make a whole chain unverifiable for ever, and before `0010`
        // the runtime role could insert one.
        let entry_type: String = row.get(1);
        out.push(chain::StoredEntry {
            seq: row.get(0),
            entry_type: chain::StoredEntryType::from_column(&entry_type),
            chain_key_epoch: row.get(2),
            design_version: row.get(3),
            prev_seal: row.get(4),
            plaintext_binding: row.get(5),
            storage_binding: row.get(6),
            content_hash: row.get(7),
            seal: row.get(8),
            metadata_stored: row.get(9),
            metadata_binding: row.get(10),
        });
    }
    Ok(out)
}

/// The decryption facts a deep run needs, read off the rows themselves.
struct MetadataFraming {
    seq: i64,
    key_epoch: i32,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

async fn read_metadata_framing(
    tx: &Transaction<'_>,
    chain: ChainRef<'_>,
) -> Result<Vec<MetadataFraming>, ChainStoreError> {
    // `metadata_key_epoch` is NULL on a site entry, whose key is derived at the
    // entry's own `chain_key_epoch` -- `COALESCE` is where that rule is
    // applied, once, rather than at each call site.
    let rows = tx
        .query(
            "SELECT seq, COALESCE(metadata_key_epoch, chain_key_epoch), metadata_nonce, metadata \
             FROM chain_entries WHERE chain_kind = $1 AND chain_id = $2 ORDER BY seq",
            &[&chain.kind().as_str(), &chain.chain_id()],
        )
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let nonce: Option<Vec<u8>> = row.get(2);
        out.push(MetadataFraming {
            seq: row.get(0),
            key_epoch: row.get(1),
            nonce: nonce.ok_or(ChainStoreError::Corrupt("metadata nonce"))?,
            ciphertext: row.get(3),
        });
    }
    Ok(out)
}

/// Verify the **site** chain.
///
/// `deep` decides which of §11.2's two levels runs, and the report names which
/// it was. A links-only run recomputes every seal from the stored columns with
/// the chain key alone — so a swapped or corrupted metadata ciphertext is
/// caught without decrypting anything. A deep run additionally decrypts each
/// entry's metadata and recomputes its binding.
pub async fn verify_site(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deep: bool,
) -> Result<chain::Report, ChainStoreError> {
    let deployment = deployment_id(&**tx).await?;
    let chain = ChainRef::Site {
        deployment: &deployment,
    };
    let entries = read_entries(tx, chain).await?;
    let keys_available = available_keys(ring, chain, &entries);

    let metadata = if deep {
        let mut out = Vec::new();
        let mut refused = Vec::new();
        for framing in read_metadata_framing(tx, chain).await? {
            let key = chain::site_metadata_key(ring.chain_master(), &deployment, framing.key_epoch);
            match open_metadata(&key, chain, &framing)? {
                Some(bytes) => out.push((framing.seq, bytes)),
                // The key for this entry's epoch was in hand and the AEAD
                // still refused. Reported as a REFUSAL rather than as an
                // absence -- see `chain::DeepInputs::refused_metadata`.
                None => refused.push(framing.seq),
            }
        }
        Some((out, refused))
    } else {
        None
    };

    let deep_inputs = metadata
        .as_ref()
        .map(|(metadata, refused)| chain::DeepInputs {
            payloads: &[],
            metadata,
            refused_metadata: refused,
        });

    Ok(chain::verify(
        chain,
        &entries,
        &[],
        &keys_available,
        deep_inputs.as_ref(),
    ))
}

/// Verify an **organisation** chain.
///
/// A deep run needs the organisation content key, which is wrapped under the
/// tenant key — so unlike the site chain, an operator holding only
/// `chain_master` can run the routine check here and cannot read a word of what
/// the entries say. That asymmetry is the point of §7.3 and is stated in
/// `0009`'s header.
pub async fn verify_org(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    deep: bool,
) -> Result<chain::Report, ChainStoreError> {
    let organisation = ctx.tenant().to_string();
    let chain = ChainRef::Org {
        organisation: &organisation,
    };
    let entries = read_entries(tx, chain).await?;
    let keys_available = available_keys(ring, chain, &entries);

    let metadata = if deep {
        let tenant_key = keys::tenant_key(tx, ring, ctx).await?;
        let mut out = Vec::new();
        let mut refused = Vec::new();
        for framing in read_metadata_framing(tx, chain).await? {
            let key =
                keys::org_content_key_at_epoch(tx, ctx, &tenant_key, framing.key_epoch).await?;
            match open_metadata(&key, chain, &framing)? {
                Some(bytes) => out.push((framing.seq, bytes)),
                None => refused.push(framing.seq),
            }
        }
        Some((out, refused))
    } else {
        None
    };

    let deep_inputs = metadata
        .as_ref()
        .map(|(metadata, refused)| chain::DeepInputs {
            payloads: &[],
            metadata,
            refused_metadata: refused,
        });

    Ok(chain::verify(
        chain,
        &entries,
        &[],
        &keys_available,
        deep_inputs.as_ref(),
    ))
}

/// Decrypt one entry's metadata, or report that it could not be.
///
/// **A refusal is `None`, not an error**: failing the whole run would let one
/// unreadable entry hide every real break after it. What the caller does with
/// that `None` is the part that matters, and it is not "nothing" — the key for
/// the entry's own epoch was in hand here, so a refusal means the blob does
/// not belong at this position. The callers collect those `seq`s into
/// `chain::DeepInputs::refused_metadata` and the verifier reports
/// `MetadataDoesNotOpenUnderItsOwnAad` at that row. §11.2's fourth sub-state
/// — *content not re-bound* — is for the entry whose key epoch this run was
/// never given, which is a different thing and is decided one level up.
fn open_metadata(
    key: &Key32,
    chain: ChainRef<'_>,
    framing: &MetadataFraming,
) -> Result<Option<Vec<u8>>, ChainStoreError> {
    let nonce: [u8; crypto::NONCE_LEN] = framing
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| ChainStoreError::Corrupt("metadata nonce"))?;
    let aad = chain::metadata_aad(chain, framing.seq, framing.key_epoch);
    Ok(crypto::open(key, &nonce, &framing.ciphertext, &aad).ok())
}

/// Every chain key epoch the entries name, derived.
///
/// `written_through` is the other half of §12.6a: this server has only ever
/// written `CHAIN_KEY_EPOCH`, so an entry naming anything above it is a changed
/// column rather than a retired key somebody else holds — an anomaly, and the
/// verifier reads it as one.
fn available_keys(
    ring: &KeyRing,
    chain: ChainRef<'_>,
    entries: &[chain::StoredEntry],
) -> chain::AvailableKeys {
    let mut by_epoch = Vec::new();
    for epoch in entries
        .iter()
        .map(|e| e.chain_key_epoch)
        .collect::<std::collections::BTreeSet<_>>()
    {
        let ck = chain::chain_key(ring.chain_master(), chain, epoch);
        by_epoch.push((epoch, chain::Subkeys::derive(&ck)));
    }
    chain::AvailableKeys::new(by_epoch).written_through(CHAIN_KEY_EPOCH)
}

// ---------------------------------------------------------------------------
// The one site entry this order writes
// ---------------------------------------------------------------------------

/// Record that this deployment started (§7.2).
///
/// §7.2 lists thirty-odd site entry types. This is the one this order emits;
/// the rest arrive with the surfaces that cause them, because an entry type
/// nothing writes is a name in a `CHECK` constraint pretending to be a control.
pub async fn record_deployment_started(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    schema_version: i32,
) -> Result<Appended, ChainStoreError> {
    let mut map = BTreeMap::new();
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::DeploymentStarted.as_str().to_string()),
    );
    map.insert("deployment".to_string(), Json::Str(deployment.to_string()));
    map.insert(
        "schema_version".to_string(),
        Json::Int(i64::from(schema_version)),
    );
    let metadata = Json::Obj(map).to_canonical_bytes();
    append_site(
        tx,
        ring,
        deployment,
        EntryType::DeploymentStarted,
        &metadata,
    )
    .await
}
