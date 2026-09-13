//! The authority layer's database side: the keyring, genesis, grants, their
//! secondings, suspensions and revocations, the head that says which are live,
//! and `authorise_account` — the seven steps of §3.4, run at **every** use.
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §§3.2–3.5, §6.1 and §7.2;
//! `migrations/0011_authority.sql` is the schema and carries the reasoning for
//! every constraint. `authority.rs` holds the bytes; this file holds the SQL
//! and the order things happen in. The split is `chain.rs`/`chains.rs`', for
//! the same reason.
//!
//! # Two rules that shape every function here
//!
//! **Every signed act writes its sealed organisation-chain entry in the same
//! transaction** (§7.2, through `chains::append_org`). An act that cannot
//! record itself does not commit — which is what makes *"stopping the log
//! stops the act"* mechanical rather than aspirational.
//!
//! **Every act advances the head** (§3.4). A grant row proves who wrote it; the
//! head proves what the set currently says and which rows are still in it.
//! Without the second, deleting a `grant_revocations` row restores a revoked
//! grant, and editing `capability` on a live one changes what it grants. With
//! it, both are caught at the next use, because the head's `live_digest`
//! covers each live grant's own row seal.
//!
//! # What is not here
//!
//! - **No memoised live set.** §3.4 permits one, keyed by `(organisation,
//!   auth_epoch)` in process memory. It is an optimisation and it is not
//!   built: the brief for this layer is *nothing cached that a database write
//!   could poison*, and the cheapest way to hold that line is to have nowhere
//!   to put a stale answer.
//! - **No verdict is ever stored**, and there is no column that could hold
//!   one.
//! - **No hardware factor** (§15.1). Keys are software ES256 keys and
//!   `account_keys.key_source` records that as a fact rather than leaving it
//!   to be assumed.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::authority::{self, Capability, GrantFacts, RowFacts, SignatureRefused, ALG_ES256};
use crate::chain::{self, ChainRef, EntryType};
use crate::chains::{self, ChainStoreError, CHAIN_KEY_EPOCH};
use crate::crypto::Key32;
use crate::ids;
use crate::keys::{self, DataKey, KeyRing, KeyStoreError};
use crate::repo::{self, AccountId, OrganisationId, RepoError, ScopeId, TenantContext};

/// §3.5's delay on a sole steward appointing a second, in seconds.
///
/// *"A sole steward may appoint a second alone, with a 24-hour delay."* The
/// delay is the part of that sentence a database can enforce; the banner, the
/// mailed notice and the cancel button need a surface that does not exist yet
/// and are named in `0011`'s own comment as unbuilt.
pub const SOLE_STEWARD_DELAY_SECONDS: i64 = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything the authority layer refuses, and why.
///
/// **`AuthorityUnverifiable` is deliberately not a permission error** (§3.4
/// step 2): *"never 'no grants found', which would render as an ordinary
/// permission error and teach nobody anything."*
#[derive(Debug)]
pub enum AuthorityError {
    Db(tokio_postgres::Error),
    Chain(ChainStoreError),
    Keys(KeyStoreError),
    Repo(RepoError),
    /// A seal did not recompute. The store is not telling the truth about
    /// itself and no answer derived from it can be trusted.
    Unverifiable(&'static str),
    /// A signature was refused, with the reason from `authority`.
    Signature(SignatureRefused),
    /// The organisation id is not the one its root key derives (§6.1).
    OrganisationIdMismatch,
    /// A head whose epoch is behind one this process has already seen
    /// (§3.4 step 3).
    Rollback {
        seen: i32,
        found: i32,
    },
    /// No grant covers this scope with this capability.
    NotAuthorised,
    /// §3.5's quorum is not met for this act.
    QuorumNotMet {
        needed: usize,
        have: usize,
    },
    /// The acting account holds no enrolled signing key.
    NoSigningKey,
    /// A stored row does not decode as what its column says it is.
    Corrupt(&'static str),
}

impl core::fmt::Display for AuthorityError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Chain(e) => write!(f, "{e}"),
            Self::Keys(e) => write!(f, "{e}"),
            Self::Repo(e) => write!(f, "{e}"),
            Self::Unverifiable(what) => write!(
                f,
                "the {what} does not verify under this deployment's chain key, so nothing read \
                 from it can be trusted. This is not a permission error and must never render as \
                 one"
            ),
            Self::Signature(e) => write!(f, "{e}"),
            Self::OrganisationIdMismatch => f.write_str(
                "this organisation's id is not the one its root public key derives, so its \
                 genesis was minted under a different key",
            ),
            Self::Rollback { seen, found } => write!(
                f,
                "the authority head is at epoch {found} and this process has already seen {seen}: \
                 the store has moved backwards"
            ),
            Self::NotAuthorised => {
                f.write_str("no live, verified grant covers this scope with this capability")
            }
            Self::QuorumNotMet { needed, have } => write!(
                f,
                "this act needs {needed} steward signature(s) and has {have}"
            ),
            Self::NoSigningKey => {
                f.write_str("this account has no enrolled signing key, so it can sign nothing")
            }
            Self::Corrupt(what) => write!(f, "a stored {what} is not consistent"),
        }
    }
}

impl std::error::Error for AuthorityError {}

impl From<tokio_postgres::Error> for AuthorityError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}
impl From<ChainStoreError> for AuthorityError {
    fn from(e: ChainStoreError) -> Self {
        Self::Chain(e)
    }
}
impl From<KeyStoreError> for AuthorityError {
    fn from(e: KeyStoreError) -> Self {
        Self::Keys(e)
    }
}
impl From<RepoError> for AuthorityError {
    fn from(e: RepoError) -> Self {
        Self::Repo(e)
    }
}
impl From<SignatureRefused> for AuthorityError {
    fn from(e: SignatureRefused) -> Self {
        Self::Signature(e)
    }
}

// ---------------------------------------------------------------------------
// The epoch watch — §3.4 step 3
// ---------------------------------------------------------------------------

/// The in-process high-water mark of each organisation's `auth_epoch`.
///
/// §3.4 step 3: *"a head whose epoch is LOWER than one this container has
/// already seen is a rollback: fail closed."* Each seal binds backwards only,
/// so restoring last month's tables produces an authority that verifies
/// perfectly — nothing inside the database can notice, which is why the
/// memory holding this is the one place a tier-2 attacker cannot write.
///
/// **It is owned, not global.** A process-wide static would be poisoned by any
/// transaction that advanced the head and then rolled back, which is a shape
/// tests use constantly and deployments use on every failed request. The
/// server will hold one per process when there is a request layer to hold it;
/// until then the caller passes the one it means.
///
/// **What it does NOT do**, stated so it is not over-read: it detects a
/// rollback only within one process lifetime. A restart forgets everything,
/// which is exactly why §7.6's anchors exist and why they are still deferred.
#[derive(Default)]
pub struct EpochWatch {
    seen: Mutex<BTreeMap<String, i32>>,
}

impl EpochWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an observed epoch, or refuse because the store moved backwards.
    pub fn observe(&self, organisation: &str, epoch: i32) -> Result<(), AuthorityError> {
        let mut seen = self.seen.lock().expect("the epoch watch is never poisoned");
        match seen.get(organisation) {
            Some(&high) if epoch < high => Err(AuthorityError::Rollback {
                seen: high,
                found: epoch,
            }),
            _ => {
                seen.insert(organisation.to_string(), epoch);
                Ok(())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The four things every authority act needs
// ---------------------------------------------------------------------------

/// The keys, the pinned tenant and the rollback watch, carried together.
///
/// **Not tidiness.** These four travel as a set because every one of them is a
/// control: `ring` is the only source of the chain key a seal recomputes
/// under, `ctx` is §4's pinned tenant (`repo::TenantContext` is the one type
/// that can carry it and it cannot be built from a row), `tenant_key` is what
/// the organisation chain's metadata is sealed under, and `watch` is §3.4 step
/// 3's high-water mark. Passing them as one value means a new act cannot be
/// written that quietly omits one.
pub struct Authority<'a> {
    pub ring: &'a KeyRing,
    pub ctx: &'a TenantContext,
    pub tenant_key: &'a DataKey,
    pub watch: &'a EpochWatch,
}

impl Authority<'_> {
    fn organisation(&self) -> String {
        self.ctx.tenant().to_string()
    }

    fn actor(&self) -> String {
        self.ctx.actor().to_string()
    }
}

// ---------------------------------------------------------------------------
// Rows, as this module reads them back
// ---------------------------------------------------------------------------

/// One enrolled signing key.
#[derive(Clone, Debug)]
pub struct AccountKey {
    pub id: String,
    pub account_id: String,
    pub public_key: Vec<u8>,
    pub fpr: [u8; 32],
    pub enrolled_seq: i64,
    pub row_version: i32,
    pub superseded_by: Option<String>,
    pub retired: bool,
}

/// One scope grant, as stored.
#[derive(Clone, Debug)]
pub struct Grant {
    pub id: String,
    pub organisation_id: String,
    /// `None` is the organisation itself — see `0011`'s comment on the column.
    pub scope_id: Option<String>,
    pub subject_id: String,
    pub subject_key_fpr: [u8; 32],
    pub capability: Capability,
    pub granted_by: Option<String>,
    pub granter_key_fpr: [u8; 32],
    pub granter_sig: Vec<u8>,
    pub is_genesis: bool,
    pub is_recovery: bool,
    pub sole_steward_appointment: bool,
    pub auth_epoch: i32,
    pub effective_from_unix: i64,
    pub expires_at_unix: i64,
    pub chain_seq: i64,
    pub row_version: i32,
    pub row_seal: Vec<u8>,
}

/// What `authorise_account` returns: the capability actually established, and
/// the grant that established it.
#[derive(Clone, Debug)]
pub struct Capabilities {
    pub organisation: String,
    pub scope: Option<String>,
    pub capability: Capability,
    pub via_grant: String,
    pub auth_epoch: i32,
}

// ---------------------------------------------------------------------------
// Keys, seals and canonical row state
// ---------------------------------------------------------------------------

/// `K_row` for one organisation, from the organisation chain key.
fn row_key_for(ring: &KeyRing, organisation: &str) -> Key32 {
    let chain_key = chain::chain_key(
        ring.chain_master(),
        ChainRef::Org { organisation },
        CHAIN_KEY_EPOCH,
    );
    authority::row_key(&chain_key)
}

/// `K_seal` for one organisation — the chain's own sealing subkey, which §3.4
/// reuses for the head.
fn seal_key_for(ring: &KeyRing, organisation: &str) -> Key32 {
    let chain_key = chain::chain_key(
        ring.chain_master(),
        ChainRef::Org { organisation },
        CHAIN_KEY_EPOCH,
    );
    chain::Subkeys::derive(&chain_key).seal
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The canonical state of a grant row, for its seal.
///
/// **One function, used on write and on read**, so the seal cannot depend on
/// which side computed it. Every field the signature does not already cover is
/// in here — including `is_genesis` and `sole_steward_appointment`, which
/// decide how the row is treated at use and are not inside `grant_bytes`.
fn grant_row_state(grant: &Grant) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert(
        "auth_epoch".to_string(),
        Json::Int(i64::from(grant.auth_epoch)),
    );
    map.insert(
        "capability".to_string(),
        Json::Str(grant.capability.as_str().to_string()),
    );
    map.insert(
        "effective_from".to_string(),
        Json::Int(grant.effective_from_unix),
    );
    map.insert("expires_at".to_string(), Json::Int(grant.expires_at_unix));
    map.insert(
        "granted_by".to_string(),
        match &grant.granted_by {
            Some(id) => Json::Str(id.clone()),
            None => Json::Null,
        },
    );
    map.insert(
        "granter_key_fpr".to_string(),
        Json::Str(hex(&grant.granter_key_fpr)),
    );
    map.insert(
        "granter_sig".to_string(),
        Json::Str(hex(&grant.granter_sig)),
    );
    map.insert("is_genesis".to_string(), Json::Bool(grant.is_genesis));
    map.insert("is_recovery".to_string(), Json::Bool(grant.is_recovery));
    map.insert(
        "organisation_id".to_string(),
        Json::Str(grant.organisation_id.clone()),
    );
    map.insert(
        "scope_id".to_string(),
        match &grant.scope_id {
            Some(id) => Json::Str(id.clone()),
            None => Json::Null,
        },
    );
    map.insert(
        "sole_steward_appointment".to_string(),
        Json::Bool(grant.sole_steward_appointment),
    );
    map.insert(
        "subject_id".to_string(),
        Json::Str(grant.subject_id.clone()),
    );
    map.insert(
        "subject_key_fpr".to_string(),
        Json::Str(hex(&grant.subject_key_fpr)),
    );
    Json::Obj(map).to_canonical_bytes()
}

/// The canonical state of a keyring row, for its seal.
fn account_key_row_state(key: &AccountKey) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("account_id".to_string(), Json::Str(key.account_id.clone()));
    map.insert("alg".to_string(), Json::Int(i64::from(ALG_ES256)));
    map.insert("fpr".to_string(), Json::Str(hex(&key.fpr)));
    map.insert("public_key".to_string(), Json::Str(hex(&key.public_key)));
    map.insert("retired".to_string(), Json::Bool(key.retired));
    map.insert(
        "superseded_by".to_string(),
        match &key.superseded_by {
            Some(id) => Json::Str(id.clone()),
            None => Json::Null,
        },
    );
    Json::Obj(map).to_canonical_bytes()
}

fn entry_metadata(entry_type: EntryType, fields: &[(&str, Json)]) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert(
        "entry_type".to_string(),
        Json::Str(entry_type.as_str().to_string()),
    );
    for (name, value) in fields {
        map.insert((*name).to_string(), value.clone());
    }
    Json::Obj(map).to_canonical_bytes()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before 1970")
        .as_secs() as i64
}

fn as_32(bytes: &[u8], what: &'static str) -> Result<[u8; 32], AuthorityError> {
    bytes.try_into().map_err(|_| AuthorityError::Corrupt(what))
}

// ---------------------------------------------------------------------------
// The keyring — §3.2, §7.2's `account_key_enrolled`
// ---------------------------------------------------------------------------

/// Enrol a software ES256 key for the acting account.
///
/// §15.1's downgrade, made concrete: `key_source = 'software'`, no
/// `credential_id`, and the row says so rather than leaving a reader to infer
/// it from a NULL. §6.4's *"there is no way to grant access to a phantom
/// account"* rests on this table — a grant names a subject's key fingerprint,
/// and a fingerprint that is in no keyring resolves to nothing.
pub async fn enrol_software_key(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    public_key: &[u8],
) -> Result<AccountKey, AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
    let organisation = auth.organisation();
    let account = auth.actor();
    let fpr = authority::key_fingerprint(public_key);
    let id = ids::new_ulid().to_string();

    let appended = chains::append_org(
        tx,
        ring,
        ctx,
        tenant_key,
        EntryType::AccountKeyEnrolled,
        &entry_metadata(
            EntryType::AccountKeyEnrolled,
            &[
                ("account", Json::Str(account.clone())),
                ("key", Json::Str(id.clone())),
                ("fpr", Json::Str(hex(&fpr))),
                ("key_source", Json::Str("software".to_string())),
            ],
        ),
    )
    .await?;

    let key = AccountKey {
        id: id.clone(),
        account_id: account.clone(),
        public_key: public_key.to_vec(),
        fpr,
        enrolled_seq: appended.seq,
        row_version: 1,
        superseded_by: None,
        retired: false,
    };
    let seal = authority::row_seal(
        &row_key_for(ring, &organisation),
        &RowFacts {
            table: "account_keys",
            row_id: &id,
            chain_seq: appended.seq,
            row_version: 1,
            row_state: &account_key_row_state(&key),
        },
    );

    tx.execute(
        "INSERT INTO account_keys \
             (id, account_id, key_source, public_key, alg, fpr, enrolled_seq, row_version, \
              row_seal) \
         VALUES ($1, $2, 'software', $3, $4, $5, $6, 1, $7)",
        &[
            &id,
            &account,
            &public_key.to_vec(),
            &ALG_ES256,
            &fpr.to_vec(),
            &appended.seq,
            &seal.to_vec(),
        ],
    )
    .await?;

    Ok(key)
}

/// Record that `old` named `new` its successor (§8.4).
///
/// The **old key** signs [`authority::succession_bytes`]; this verifies that
/// signature before storing it, because a succession nobody checked is a way
/// to point an account's authority at a key its holder never approved.
pub async fn supersede_key(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    old_key_id: &str,
    new_key_id: &str,
    succession_sig: &[u8],
    at_unix: i64,
) -> Result<(), AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
    let organisation = auth.organisation();
    let old = read_account_key(tx, old_key_id)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    let new = read_account_key(tx, new_key_id)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;

    let message = authority::succession_bytes(&old.account_id, &old.fpr, &new.fpr, at_unix);
    authority::verify_es256(&old.public_key, &message, succession_sig)?;

    let appended = chains::append_org(
        tx,
        ring,
        ctx,
        tenant_key,
        EntryType::AccountKeySuperseded,
        &entry_metadata(
            EntryType::AccountKeySuperseded,
            &[
                ("account", Json::Str(old.account_id.clone())),
                ("old_key", Json::Str(old.id.clone())),
                ("new_key", Json::Str(new.id.clone())),
            ],
        ),
    )
    .await?;

    let superseded = AccountKey {
        superseded_by: Some(new.id.clone()),
        retired: true,
        row_version: old.row_version + 1,
        ..old.clone()
    };
    let seal = authority::row_seal(
        &row_key_for(ring, &organisation),
        &RowFacts {
            table: "account_keys",
            row_id: &superseded.id,
            chain_seq: superseded.enrolled_seq,
            row_version: superseded.row_version,
            row_state: &account_key_row_state(&superseded),
        },
    );

    let updated = tx
        .execute(
            "UPDATE account_keys \
                SET superseded_by = $1, succession_sig = $2, retired_at = now(), \
                    row_version = $3, row_seal = $4 \
              WHERE id = $5",
            &[
                &new.id,
                &succession_sig.to_vec(),
                &superseded.row_version,
                &seal.to_vec(),
                &old.id,
            ],
        )
        .await?;
    if updated != 1 {
        return Err(AuthorityError::Unverifiable("account key"));
    }
    let _ = appended;
    Ok(())
}

async fn read_account_key(
    tx: &Transaction<'_>,
    id: &str,
) -> Result<Option<AccountKey>, AuthorityError> {
    let row = tx
        .query_opt(
            "SELECT id, account_id, public_key, fpr, enrolled_seq, row_version, superseded_by, \
                    retired_at \
               FROM account_keys WHERE id = $1",
            &[&id],
        )
        .await?;
    let Some(row) = row else { return Ok(None) };
    let fpr: Vec<u8> = row.get(3);
    let retired: Option<std::time::SystemTime> = row.get(7);
    Ok(Some(AccountKey {
        id: row.get(0),
        account_id: row.get(1),
        public_key: row.get(2),
        fpr: as_32(&fpr, "key fingerprint")?,
        enrolled_seq: row.get(4),
        row_version: row.get(5),
        superseded_by: row.get(6),
        retired: retired.is_some(),
    }))
}

/// The key an account signs with today: the one that is neither superseded nor
/// retired.
pub async fn signing_key_of(
    tx: &Transaction<'_>,
    account: &str,
) -> Result<Option<AccountKey>, AuthorityError> {
    let row = tx
        .query_opt(
            "SELECT id FROM account_keys \
              WHERE account_id = $1 AND superseded_by IS NULL AND retired_at IS NULL \
              ORDER BY enrolled_seq DESC LIMIT 1",
            &[&account],
        )
        .await?;
    match row {
        Some(row) => {
            let id: String = row.get(0);
            read_account_key(tx, &id).await
        }
        None => Ok(None),
    }
}

/// Resolve a key by fingerprint, **verifying the keyring row's own seal**
/// (§3.4 step 4).
async fn key_by_fingerprint(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
    fpr: &[u8; 32],
) -> Result<AccountKey, AuthorityError> {
    let row = tx
        .query_opt(
            "SELECT id FROM account_keys WHERE fpr = $1",
            &[&fpr.to_vec()],
        )
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    let id: String = row.get(0);
    let key = read_account_key(tx, &id)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;

    let stored: Vec<u8> = tx
        .query_one("SELECT row_seal FROM account_keys WHERE id = $1", &[&id])
        .await?
        .get(0);
    let recomputed = authority::row_seal(
        &row_key_for(ring, organisation),
        &RowFacts {
            table: "account_keys",
            row_id: &key.id,
            chain_seq: key.enrolled_seq,
            row_version: key.row_version,
            row_state: &account_key_row_state(&key),
        },
    );
    if stored != recomputed {
        return Err(AuthorityError::Unverifiable("account key row seal"));
    }
    Ok(key)
}

// ---------------------------------------------------------------------------
// Genesis — §6.1
// ---------------------------------------------------------------------------

/// One genesis steward grant, signed by the organisation root key **before the
/// server sees it** (§6.1 step 2).
pub struct GenesisGrant {
    pub subject: AccountId,
    pub subject_key_fpr: [u8; 32],
    pub capability: Capability,
    pub effective_from_unix: i64,
    pub expires_at_unix: i64,
    /// The root key's signature over `grant_bytes` with `auth_epoch = 1`.
    pub signature: [u8; 64],
}

/// What genesis produced.
#[derive(Debug)]
pub struct Genesis {
    pub organisation: OrganisationId,
    pub auth_epoch: i32,
    pub grants: Vec<String>,
}

/// §6.1, as far as §15.2 allows.
///
/// The creator's side generates an organisation root keypair, derives the
/// organisation id from the public half and a 16-byte salt, signs one or two
/// genesis steward grants with the private half, and **discards the private
/// key**. This function is the server half: it recomputes the derivation
/// before storing anything, verifies every genesis signature under the root
/// public key, writes `org_genesis` and one `grant_signed` entry per grant,
/// and opens the head at epoch 1.
///
/// # What §15.2 defers, precisely
///
/// §6.1 step 3 — *"Shamir-splits the root private key t-of-n (default 2-of-3),
/// wraps each share to a named recovery holder's account key, renders each as
/// a printable artefact"* — **is not built, and neither is its replacement.**
/// §15.2 stages Shamir last and reconsiders its shape: with software keys the
/// root private key can instead be wrapped to each named recovery holder's
/// account key, *"weaker on paper and it must be said so"*. Neither mechanism
/// is chosen here, so this function takes no shares and no recovery holders,
/// and `recovery_holders` is not a table yet.
///
/// **The consequence, stated rather than implied: whatever the caller does
/// with the root private key after genesis is outside this system.** If it is
/// kept, it can sign a recovery grant later — §8.2's controls on that are not
/// built either. If it is discarded, break-glass is unavailable for that
/// organisation and nothing here will say so. The one control that *is* real
/// today is the trigger `0011` installs: after genesis the root key can write
/// no further genesis grant, at any privilege level, because the head's epoch
/// is past 0.
pub async fn bootstrap_organisation(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    creator: AccountId,
    display_name: &str,
    root_pubkey: &[u8],
    id_salt: &[u8; 16],
    grants: &[GenesisGrant],
) -> Result<Genesis, AuthorityError> {
    let organisation_id = authority::derive_organisation_id(root_pubkey, id_salt);
    let organisation: OrganisationId = organisation_id
        .parse()
        .map_err(|_| AuthorityError::Corrupt("derived organisation id"))?;
    let root_fpr = authority::key_fingerprint(root_pubkey);

    repo::create_organisation_in(tx, organisation, creator, display_name).await?;
    let ctx = repo::open_tenant_context(tx, organisation, creator).await?;
    let tenant_key = keys::tenant_key(tx, ring, &ctx).await?;

    let genesis_entry = chains::append_org(
        tx,
        ring,
        &ctx,
        &tenant_key,
        EntryType::OrgGenesis,
        &entry_metadata(
            EntryType::OrgGenesis,
            &[
                ("organisation", Json::Str(organisation_id.clone())),
                ("root_fpr", Json::Str(hex(&root_fpr))),
                ("creator", Json::Str(creator.to_string())),
            ],
        ),
    )
    .await?;

    let root_seal = authority::row_seal(
        &row_key_for(ring, &organisation_id),
        &RowFacts {
            table: "organisation_roots",
            row_id: &organisation_id,
            chain_seq: genesis_entry.seq,
            row_version: 1,
            row_state: &{
                let mut map = BTreeMap::new();
                map.insert("id_salt".to_string(), Json::Str(hex(id_salt)));
                map.insert("root_alg".to_string(), Json::Int(i64::from(ALG_ES256)));
                map.insert("root_pubkey".to_string(), Json::Str(hex(root_pubkey)));
                Json::Obj(map).to_canonical_bytes()
            },
        },
    );
    tx.execute(
        "INSERT INTO organisation_roots \
             (organisation_id, root_pubkey, root_alg, id_salt, created_seq, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        &[
            &organisation_id,
            &root_pubkey.to_vec(),
            &ALG_ES256,
            &id_salt.to_vec(),
            &genesis_entry.seq,
            &root_seal.to_vec(),
        ],
    )
    .await?;

    let mut written = Vec::new();
    for request in grants {
        let facts = GrantFacts {
            organisation: &organisation_id,
            root_pubkey_fpr: &root_fpr,
            scope: "",
            subject: &request.subject.to_string(),
            subject_key_fpr: &request.subject_key_fpr,
            capability: request.capability,
            granter: None,
            granter_key_fpr: &root_fpr,
            effective_from_unix: request.effective_from_unix,
            expires_at_unix: request.expires_at_unix,
            auth_epoch: 1,
        };
        let message = authority::grant_bytes(&facts);
        // **Verified before it is stored, and verified again at every use.**
        // This call is not the control; §3.4's is. It is here so that a
        // signature that could never verify is refused at the door rather
        // than becoming a row that fails confusingly later.
        authority::verify_es256(root_pubkey, &message, &request.signature)?;

        let grant = Grant {
            id: ids::new_ulid().to_string(),
            organisation_id: organisation_id.clone(),
            scope_id: None,
            subject_id: request.subject.to_string(),
            subject_key_fpr: request.subject_key_fpr,
            capability: request.capability,
            granted_by: None,
            granter_key_fpr: root_fpr,
            granter_sig: request.signature.to_vec(),
            is_genesis: true,
            is_recovery: false,
            sole_steward_appointment: false,
            auth_epoch: 1,
            effective_from_unix: request.effective_from_unix,
            expires_at_unix: request.expires_at_unix,
            chain_seq: 0,
            row_version: 1,
            row_seal: Vec::new(),
        };
        let id = insert_grant(tx, ring, &ctx, &tenant_key, grant).await?;
        written.push(id);
    }

    advance_head(tx, ring, &ctx, &tenant_key).await?;

    Ok(Genesis {
        organisation,
        auth_epoch: 1,
        grants: written,
    })
}

// ---------------------------------------------------------------------------
// Signing a grant — §3.3, §3.5
// ---------------------------------------------------------------------------

/// What a steward is asking to grant.
pub struct GrantRequest<'a> {
    pub scope: Option<ScopeId>,
    pub subject: AccountId,
    pub capability: Capability,
    /// `0` for "does not expire". `0011` refuses it for `steward`.
    pub expires_at_unix: i64,
    /// The granter's signature over [`authority::grant_bytes`]. The server
    /// never holds a steward's private key, so this arrives made.
    pub signature: &'a [u8],
}

/// Sign a grant into existence (§3.3), enforcing §3.5's quorum rule for
/// `steward`.
///
/// The granter must already hold `steward` at or above the scope, **verified
/// through `authorise_account`** — so the seven steps run before a grant is
/// written as well as before a design is opened, and a granter whose own grant
/// has been revoked cannot grant.
///
/// # §3.5's quorum, and the sole-steward path
///
/// Granting `read` or `draw` needs one steward. Granting `steward` needs
/// `min(2, live distinct stewards of the organisation)`:
///
/// - **Two or more live stewards** → the grant is written and is **not usable
///   until a second steward seconds it** ([`second_grant`]). That is the
///   quorum, enforced at use by `authorise_account`.
/// - **Exactly one live steward** → §3.5's sole-steward path: the grant is
///   marked `sole_steward_appointment`, its `effective_from` is pushed 24
///   hours out, and it needs no seconding. *"What matters — that no new
///   grant-granting authority appears silently — survives. What does not
///   survive is the demand for a second signature that cannot exist."*
pub async fn sign_grant(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    request: &GrantRequest<'_>,
) -> Result<String, AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
    let organisation = auth.organisation();
    let granter = auth.actor();

    // The granter's own authority, checked the same way a design read is.
    authorise_account(tx, auth, request.scope, Capability::Steward).await?;

    let granter_key = signing_key_of(tx, &granter)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    let subject_key = signing_key_of(tx, &request.subject.to_string())
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    let root_fpr = organisation_root_fpr(tx, ring, &organisation).await?;

    let live_stewards = live_steward_count(tx, ring, &organisation).await?;
    let sole_steward = request.capability == Capability::Steward && live_stewards <= 1;

    let epoch = next_epoch(tx, &organisation).await?;
    let now = now_unix();
    let effective_from = if sole_steward {
        now + SOLE_STEWARD_DELAY_SECONDS
    } else {
        now
    };
    let scope_text = request.scope.map(|s| s.to_string());

    let facts = GrantFacts {
        organisation: &organisation,
        root_pubkey_fpr: &root_fpr,
        scope: scope_text.as_deref().unwrap_or(""),
        subject: &request.subject.to_string(),
        subject_key_fpr: &subject_key.fpr,
        capability: request.capability,
        granter: Some(&granter),
        granter_key_fpr: &granter_key.fpr,
        effective_from_unix: effective_from,
        expires_at_unix: request.expires_at_unix,
        auth_epoch: epoch,
    };
    authority::verify_es256(
        &granter_key.public_key,
        &authority::grant_bytes(&facts),
        request.signature,
    )?;

    let grant = Grant {
        id: ids::new_ulid().to_string(),
        organisation_id: organisation.clone(),
        scope_id: scope_text,
        subject_id: request.subject.to_string(),
        subject_key_fpr: subject_key.fpr,
        capability: request.capability,
        granted_by: Some(granter),
        granter_key_fpr: granter_key.fpr,
        granter_sig: request.signature.to_vec(),
        is_genesis: false,
        is_recovery: false,
        sole_steward_appointment: sole_steward,
        auth_epoch: epoch,
        effective_from_unix: effective_from,
        expires_at_unix: request.expires_at_unix,
        chain_seq: 0,
        row_version: 1,
        row_seal: Vec::new(),
    };
    let id = insert_grant(tx, ring, ctx, tenant_key, grant).await?;
    advance_head(tx, auth.ring, auth.ctx, auth.tenant_key).await?;
    Ok(id)
}

/// Write one grant row and its `grant_signed` entry, in this transaction.
async fn insert_grant(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    tenant_key: &DataKey,
    mut grant: Grant,
) -> Result<String, AuthorityError> {
    let appended = chains::append_org(
        tx,
        ring,
        ctx,
        tenant_key,
        EntryType::GrantSigned,
        &entry_metadata(
            EntryType::GrantSigned,
            &[
                ("grant", Json::Str(grant.id.clone())),
                ("subject", Json::Str(grant.subject_id.clone())),
                (
                    "capability",
                    Json::Str(grant.capability.as_str().to_string()),
                ),
                (
                    "scope",
                    match &grant.scope_id {
                        Some(id) => Json::Str(id.clone()),
                        None => Json::Null,
                    },
                ),
                (
                    "granter",
                    match &grant.granted_by {
                        Some(id) => Json::Str(id.clone()),
                        None => Json::Str("org_root".to_string()),
                    },
                ),
            ],
        ),
    )
    .await?;
    grant.chain_seq = appended.seq;

    let seal = authority::row_seal(
        &row_key_for(ring, &grant.organisation_id),
        &RowFacts {
            table: "scope_grants",
            row_id: &grant.id,
            chain_seq: grant.chain_seq,
            row_version: grant.row_version,
            row_state: &grant_row_state(&grant),
        },
    );

    let granter_kind = if grant.granted_by.is_some() {
        "account"
    } else {
        "org_root"
    };
    tx.execute(
        "INSERT INTO scope_grants \
             (id, organisation_id, scope_id, subject_id, subject_key_fpr, capability, \
              granter_kind, granted_by, granter_key_fpr, granter_sig, is_genesis, is_recovery, \
              sole_steward_appointment, auth_epoch, effective_from, expires_at, chain_seq, \
              row_version, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, \
                 to_timestamp($15::bigint), \
                 CASE WHEN $16::bigint = 0 THEN NULL ELSE to_timestamp($16::bigint) END, \
                 $17, $18, $19)",
        &[
            &grant.id,
            &grant.organisation_id,
            &grant.scope_id,
            &grant.subject_id,
            &grant.subject_key_fpr.to_vec(),
            &grant.capability.as_str(),
            &granter_kind,
            &grant.granted_by,
            &grant.granter_key_fpr.to_vec(),
            &grant.granter_sig,
            &grant.is_genesis,
            &grant.is_recovery,
            &grant.sole_steward_appointment,
            &grant.auth_epoch,
            &grant.effective_from_unix,
            &grant.expires_at_unix,
            &grant.chain_seq,
            &grant.row_version,
            &seal.to_vec(),
        ],
    )
    .await?;
    Ok(grant.id)
}

/// §3.5's second signature.
///
/// The seconder must hold `steward`, must not be the subject or the granter
/// (`0011` refuses both through a three-column foreign key and a `CHECK`), and
/// signs [`authority::second_bytes`] — which binds `LP(H(grant_bytes)) ‖
/// LP(granter_key_fpr)` and **never** the granter's signature, per the
/// correction at the head of §3.
pub async fn second_grant(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    grant_id: &str,
    signature: &[u8],
) -> Result<(), AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
    let organisation = auth.organisation();
    let seconder = auth.actor();
    let grant = read_grant(tx, grant_id)
        .await?
        .ok_or(AuthorityError::NotAuthorised)?;

    authorise_account(
        tx,
        auth,
        grant.scope_id.as_deref().map(parse_scope).transpose()?,
        Capability::Steward,
    )
    .await?;

    let seconder_key = signing_key_of(tx, &seconder)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    let message = authority::second_bytes(
        &grant_bytes_of(tx, ring, &grant).await?,
        &grant.granter_key_fpr,
    );
    authority::verify_es256(&seconder_key.public_key, &message, signature)?;

    let appended = chains::append_org(
        tx,
        ring,
        ctx,
        tenant_key,
        EntryType::GrantSeconded,
        &entry_metadata(
            EntryType::GrantSeconded,
            &[
                ("grant", Json::Str(grant.id.clone())),
                ("seconder", Json::Str(seconder.clone())),
            ],
        ),
    )
    .await?;

    let id = ids::new_ulid().to_string();
    let mut map = BTreeMap::new();
    map.insert("grant_id".to_string(), Json::Str(grant.id.clone()));
    map.insert("seconded_by".to_string(), Json::Str(seconder.clone()));
    map.insert(
        "seconder_key_fpr".to_string(),
        Json::Str(hex(&seconder_key.fpr)),
    );
    map.insert("seconder_sig".to_string(), Json::Str(hex(signature)));
    let seal = authority::row_seal(
        &row_key_for(ring, &organisation),
        &RowFacts {
            table: "grant_secondings",
            row_id: &id,
            chain_seq: appended.seq,
            row_version: 1,
            row_state: &Json::Obj(map).to_canonical_bytes(),
        },
    );

    tx.execute(
        "INSERT INTO grant_secondings \
             (id, grant_id, organisation_id, grant_subject_id, grant_granter_id, seconded_by, \
              seconder_key_fpr, seconder_sig, chain_seq, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        &[
            &id,
            &grant.id,
            &organisation,
            &grant.subject_id,
            &grant.granted_by,
            &seconder,
            &seconder_key.fpr.to_vec(),
            &signature.to_vec(),
            &appended.seq,
            &seal.to_vec(),
        ],
    )
    .await?;

    advance_head(tx, auth.ring, auth.ctx, auth.tenant_key).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Suspension and revocation
// ---------------------------------------------------------------------------

/// Suspend or lift, signed by a steward.
pub async fn set_suspension(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    grant_id: &str,
    suspend: bool,
    signature: &[u8],
    at_unix: i64,
) -> Result<(), AuthorityError> {
    let ring = auth.ring;
    let organisation = auth.organisation();
    let actor = auth.actor();
    let grant = read_grant(tx, grant_id)
        .await?
        .ok_or(AuthorityError::NotAuthorised)?;

    authorise_account(
        tx,
        auth,
        grant.scope_id.as_deref().map(parse_scope).transpose()?,
        Capability::Steward,
    )
    .await?;

    let key = signing_key_of(tx, &actor)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    let grant_bytes = grant_bytes_of(tx, ring, &grant).await?;
    let message = if suspend {
        authority::suspend_bytes(&organisation, &grant.id, &grant_bytes, at_unix)
    } else {
        authority::unsuspend_bytes(&organisation, &grant.id, &grant_bytes, at_unix)
    };
    authority::verify_es256(&key.public_key, &message, signature)?;

    write_suspension(
        tx,
        auth,
        &grant,
        suspend,
        "steward",
        &actor,
        Some(&key.fpr),
        Some(signature),
        at_unix,
    )
    .await
}

/// **§1.1's operator suspend verb is schema-only, and this is where its caller
/// would be.**
///
/// `0011`'s `grant_suspensions` admits `actor_kind = 'operator'` — with a
/// `CHECK` that refuses `unsuspend` for one, so an operator can stop a grant
/// and cannot restore it (*"any steward of that organisation may lift it"*).
/// **No function writes that row**, because the operator surface it belongs to
/// does not exist: §15.6 stages the admin surface after sessions, and §1.3's
/// admin pool is read-only, so the write has to come from an application
/// endpoint that has not been built. Writing one now would mean a path with no
/// authentication in front of it that mutates authority in every tenant.
///
/// The schema carries the shape so that the surface, when it lands, has a
/// constraint to land against rather than a column to add.
#[allow(clippy::too_many_arguments)]
async fn write_suspension(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    grant: &Grant,
    suspend: bool,
    actor_kind: &str,
    actor_id: &str,
    actor_key_fpr: Option<&[u8; 32]>,
    actor_sig: Option<&[u8]>,
    at_unix: i64,
) -> Result<(), AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
    let organisation = grant.organisation_id.clone();
    let entry_type = if suspend {
        EntryType::GrantSuspended
    } else {
        EntryType::GrantUnsuspended
    };
    let appended = chains::append_org(
        tx,
        ring,
        ctx,
        tenant_key,
        entry_type,
        &entry_metadata(
            entry_type,
            &[
                ("grant", Json::Str(grant.id.clone())),
                ("actor", Json::Str(actor_id.to_string())),
                ("actor_kind", Json::Str(actor_kind.to_string())),
            ],
        ),
    )
    .await?;

    let mut map = BTreeMap::new();
    map.insert(
        "action".to_string(),
        Json::Str(if suspend { "suspend" } else { "unsuspend" }.to_string()),
    );
    map.insert("actor_id".to_string(), Json::Str(actor_id.to_string()));
    map.insert("actor_kind".to_string(), Json::Str(actor_kind.to_string()));
    map.insert("at".to_string(), Json::Int(at_unix));
    map.insert("grant_id".to_string(), Json::Str(grant.id.clone()));
    let row_state = Json::Obj(map).to_canonical_bytes();

    // The seal names the chain sequence, which is unique per organisation
    // chain, so it is the row's identity here: `grant_suspensions.seq` is an
    // identity column the database assigns after this is computed.
    let seal = authority::row_seal(
        &row_key_for(ring, &organisation),
        &RowFacts {
            table: "grant_suspensions",
            row_id: &grant.id,
            chain_seq: appended.seq,
            row_version: 1,
            row_state: &row_state,
        },
    );

    tx.execute(
        "INSERT INTO grant_suspensions \
             (grant_id, organisation_id, action, actor_kind, actor_id, actor_key_fpr, actor_sig, \
              at, chain_seq, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::bigint), $9, $10)",
        &[
            &grant.id,
            &organisation,
            &if suspend { "suspend" } else { "unsuspend" },
            &actor_kind,
            &actor_id,
            &actor_key_fpr.map(|f| f.to_vec()),
            &actor_sig.map(|s| s.to_vec()),
            &at_unix,
            &appended.seq,
            &seal.to_vec(),
        ],
    )
    .await?;

    advance_head(tx, auth.ring, auth.ctx, auth.tenant_key).await?;
    Ok(())
}

/// Revoke a grant — the positive, append-only fact §3.2 requires.
pub async fn revoke_grant(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    grant_id: &str,
    signature: &[u8],
    at_unix: i64,
) -> Result<(), AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
    let organisation = auth.organisation();
    let actor = auth.actor();
    let grant = read_grant(tx, grant_id)
        .await?
        .ok_or(AuthorityError::NotAuthorised)?;

    authorise_account(
        tx,
        auth,
        grant.scope_id.as_deref().map(parse_scope).transpose()?,
        Capability::Steward,
    )
    .await?;

    let key = signing_key_of(tx, &actor)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    let message = authority::revoke_bytes(
        &organisation,
        &grant.id,
        &grant_bytes_of(tx, ring, &grant).await?,
        at_unix,
    );
    authority::verify_es256(&key.public_key, &message, signature)?;

    let appended = chains::append_org(
        tx,
        ring,
        ctx,
        tenant_key,
        EntryType::GrantRevoked,
        &entry_metadata(
            EntryType::GrantRevoked,
            &[
                ("grant", Json::Str(grant.id.clone())),
                ("actor", Json::Str(actor.clone())),
            ],
        ),
    )
    .await?;

    let mut map = BTreeMap::new();
    map.insert("grant_id".to_string(), Json::Str(grant.id.clone()));
    map.insert("revoked_at".to_string(), Json::Int(at_unix));
    map.insert("revoked_by".to_string(), Json::Str(actor.clone()));
    map.insert("revoked_sig".to_string(), Json::Str(hex(signature)));
    map.insert("revoker_key_fpr".to_string(), Json::Str(hex(&key.fpr)));
    let seal = authority::row_seal(
        &row_key_for(ring, &organisation),
        &RowFacts {
            table: "grant_revocations",
            row_id: &grant.id,
            chain_seq: appended.seq,
            row_version: 1,
            row_state: &Json::Obj(map).to_canonical_bytes(),
        },
    );

    tx.execute(
        "INSERT INTO grant_revocations \
             (grant_id, organisation_id, revoked_at, revoked_by, revoker_key_fpr, revoked_sig, \
              chain_seq, row_seal) \
         VALUES ($1, $2, to_timestamp($3::bigint), $4, $5, $6, $7, $8)",
        &[
            &grant.id,
            &organisation,
            &at_unix,
            &actor,
            &key.fpr.to_vec(),
            &signature.to_vec(),
            &appended.seq,
            &seal.to_vec(),
        ],
    )
    .await?;

    advance_head(tx, auth.ring, auth.ctx, auth.tenant_key).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The head — §3.4
// ---------------------------------------------------------------------------

/// Recompute the live set, reseal the head and advance its epoch.
pub async fn advance_head(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    tenant_key: &DataKey,
) -> Result<i32, AuthorityError> {
    let organisation = ctx.tenant().to_string();
    let epoch = next_epoch(tx, &organisation).await?;
    let live = live_set(tx, ring, &organisation).await?;
    let digest = authority::live_digest(
        &row_key_for(ring, &organisation),
        &organisation,
        epoch,
        &live,
    );

    let appended = chains::append_org(
        tx,
        ring,
        ctx,
        tenant_key,
        EntryType::AuthHeadAdvanced,
        &entry_metadata(
            EntryType::AuthHeadAdvanced,
            &[
                ("auth_epoch", Json::Int(i64::from(epoch))),
                ("live_count", Json::Int(live.len() as i64)),
            ],
        ),
    )
    .await?;

    let seal = authority::head_seal(
        &seal_key_for(ring, &organisation),
        &organisation,
        epoch,
        appended.seq,
        &digest,
    );

    tx.execute(
        "INSERT INTO organisation_auth_head \
             (organisation_id, auth_epoch, chain_seq, live_count, live_digest, head_seal) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (organisation_id) DO UPDATE \
            SET auth_epoch = EXCLUDED.auth_epoch, chain_seq = EXCLUDED.chain_seq, \
                live_count = EXCLUDED.live_count, live_digest = EXCLUDED.live_digest, \
                head_seal = EXCLUDED.head_seal, advanced_at = now()",
        &[
            &organisation,
            &epoch,
            &appended.seq,
            &(live.len() as i32),
            &digest.to_vec(),
            &seal.to_vec(),
        ],
    )
    .await?;
    Ok(epoch)
}

/// The next epoch for an organisation: one past the head, or 1 if there is
/// none.
async fn next_epoch(tx: &Transaction<'_>, organisation: &str) -> Result<i32, AuthorityError> {
    let row = tx
        .query_opt(
            "SELECT auth_epoch FROM organisation_auth_head WHERE organisation_id = $1 FOR UPDATE",
            &[&organisation],
        )
        .await?;
    Ok(match row {
        Some(row) => {
            let current: i32 = row.get(0);
            current + 1
        }
        None => 1,
    })
}

/// Every live grant's id and row seal — a grant that is neither revoked nor
/// currently suspended.
///
/// **Expiry is not a member of this set's definition.** A grant that has
/// expired is still a live row; it fails the time check at use. Folding time
/// into the set would mean the head has to be rewritten as clocks pass, which
/// nothing triggers, so the head would go stale and every authorisation would
/// fail.
async fn live_set(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
) -> Result<Vec<(String, [u8; 32])>, AuthorityError> {
    let rows = tx
        .query(
            "SELECT g.id \
               FROM scope_grants g \
              WHERE g.organisation_id = $1 \
                AND NOT EXISTS (SELECT 1 FROM grant_revocations r WHERE r.grant_id = g.id) \
                AND COALESCE(( \
                        SELECT s.action FROM grant_suspensions s \
                         WHERE s.grant_id = g.id ORDER BY s.seq DESC LIMIT 1 \
                    ), 'unsuspend') = 'unsuspend' \
              ORDER BY g.id",
            &[&organisation],
        )
        .await?;

    let mut live = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get(0);
        let grant = read_grant(tx, &id)
            .await?
            .ok_or(AuthorityError::Corrupt("grant"))?;
        // The seal in the digest is the RECOMPUTED one, not the stored one: a
        // head built from stored seals would carry an edited row's own lie
        // forward.
        let recomputed = authority::row_seal(
            &row_key_for(ring, organisation),
            &RowFacts {
                table: "scope_grants",
                row_id: &grant.id,
                chain_seq: grant.chain_seq,
                row_version: grant.row_version,
                row_state: &grant_row_state(&grant),
            },
        );
        live.push((id, recomputed));
    }
    Ok(live)
}

/// How many distinct accounts hold a live `steward` grant — §3.5's
/// `min(2, live distinct stewards)`.
async fn live_steward_count(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
) -> Result<usize, AuthorityError> {
    let live: BTreeSet<String> = live_set(tx, ring, organisation)
        .await?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let rows = tx
        .query(
            "SELECT id, subject_id FROM scope_grants \
              WHERE organisation_id = $1 AND capability = 'steward'",
            &[&organisation],
        )
        .await?;
    let mut subjects = BTreeSet::new();
    for row in rows {
        let id: String = row.get(0);
        let subject: String = row.get(1);
        if live.contains(&id) {
            subjects.insert(subject);
        }
    }
    Ok(subjects.len())
}

// ---------------------------------------------------------------------------
// Reading grants back
// ---------------------------------------------------------------------------

fn parse_scope(id: &str) -> Result<ScopeId, AuthorityError> {
    id.parse().map_err(|_| AuthorityError::Corrupt("scope id"))
}

async fn read_grant(tx: &Transaction<'_>, id: &str) -> Result<Option<Grant>, AuthorityError> {
    let row = tx
        .query_opt(
            "SELECT id, organisation_id, scope_id, subject_id, subject_key_fpr, capability, \
                    granted_by, granter_key_fpr, granter_sig, is_genesis, is_recovery, \
                    sole_steward_appointment, auth_epoch, \
                    EXTRACT(EPOCH FROM effective_from)::bigint, \
                    COALESCE(EXTRACT(EPOCH FROM expires_at)::bigint, 0), \
                    chain_seq, row_version, row_seal \
               FROM scope_grants WHERE id = $1",
            &[&id],
        )
        .await?;
    let Some(row) = row else { return Ok(None) };
    let subject_fpr: Vec<u8> = row.get(4);
    let granter_fpr: Vec<u8> = row.get(7);
    let capability: String = row.get(5);
    Ok(Some(Grant {
        id: row.get(0),
        organisation_id: row.get(1),
        scope_id: row.get(2),
        subject_id: row.get(3),
        subject_key_fpr: as_32(&subject_fpr, "subject key fingerprint")?,
        capability: Capability::parse(&capability).ok_or(AuthorityError::Corrupt("capability"))?,
        granted_by: row.get(6),
        granter_key_fpr: as_32(&granter_fpr, "granter key fingerprint")?,
        granter_sig: row.get(8),
        is_genesis: row.get(9),
        is_recovery: row.get(10),
        sole_steward_appointment: row.get(11),
        auth_epoch: row.get(12),
        effective_from_unix: row.get(13),
        expires_at_unix: row.get(14),
        chain_seq: row.get(15),
        row_version: row.get(16),
        row_seal: row.get(17),
    }))
}

/// The organisation root key's fingerprint, **recomputing the organisation id
/// from it** (§3.4 step 5, §6.1).
async fn organisation_root_fpr(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
) -> Result<[u8; 32], AuthorityError> {
    let row = tx
        .query_opt(
            "SELECT root_pubkey, id_salt, created_seq, row_seal \
               FROM organisation_roots WHERE organisation_id = $1",
            &[&organisation],
        )
        .await?
        .ok_or(AuthorityError::Unverifiable("organisation root"))?;
    let root_pubkey: Vec<u8> = row.get(0);
    let id_salt: Vec<u8> = row.get(1);
    let created_seq: i64 = row.get(2);
    let stored_seal: Vec<u8> = row.get(3);

    let mut map = BTreeMap::new();
    map.insert("id_salt".to_string(), Json::Str(hex(&id_salt)));
    map.insert("root_alg".to_string(), Json::Int(i64::from(ALG_ES256)));
    map.insert("root_pubkey".to_string(), Json::Str(hex(&root_pubkey)));
    let recomputed = authority::row_seal(
        &row_key_for(ring, organisation),
        &RowFacts {
            table: "organisation_roots",
            row_id: organisation,
            chain_seq: created_seq,
            row_version: 1,
            row_state: &Json::Obj(map).to_canonical_bytes(),
        },
    );
    if stored_seal != recomputed {
        return Err(AuthorityError::Unverifiable("organisation root row seal"));
    }

    // §6.1's recomputation, at every authorisation that chains to genesis.
    if authority::derive_organisation_id(&root_pubkey, &id_salt) != organisation {
        return Err(AuthorityError::OrganisationIdMismatch);
    }
    Ok(authority::key_fingerprint(&root_pubkey))
}

/// Rebuild a stored grant's signed bytes — the only way to check a signature
/// is to recompute what it should have covered.
async fn grant_bytes_of(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    grant: &Grant,
) -> Result<Vec<u8>, AuthorityError> {
    let root_fpr = organisation_root_fpr(tx, ring, &grant.organisation_id).await?;
    Ok(authority::grant_bytes(&GrantFacts {
        organisation: &grant.organisation_id,
        root_pubkey_fpr: &root_fpr,
        scope: grant.scope_id.as_deref().unwrap_or(""),
        subject: &grant.subject_id,
        subject_key_fpr: &grant.subject_key_fpr,
        capability: grant.capability,
        granter: grant.granted_by.as_deref(),
        granter_key_fpr: &grant.granter_key_fpr,
        effective_from_unix: grant.effective_from_unix,
        expires_at_unix: grant.expires_at_unix,
        auth_epoch: grant.auth_epoch,
    }))
}

// ---------------------------------------------------------------------------
// §3.4 — the seven steps
// ---------------------------------------------------------------------------

/// **Authorise, from scratch, every time** (§3.4).
///
/// 1. the scope's ancestors, so a grant above it counts;
/// 2. the head, and **its seal verified** — `Unverifiable`, never "no grants";
/// 3. the epoch against this process's high-water mark;
/// 4. each candidate grant: **its row seal**, its membership of the head's
///    `live_digest`, its times, the keyring rows for granter and subject with
///    **their own seals**, and the signatures over recomputed bytes;
/// 5. the organisation id recomputed from the root key;
/// 6. §3.5's quorum for the capability;
/// 7. only then the answer.
///
/// Step 4 is why a hand-inserted grant grants nothing, why editing
/// `capability` on a real one grants nothing, and why deleting a revocation
/// row does not restore the grant: the first two break the row seal, and the
/// third leaves the head's `live_digest` disagreeing with a live set that now
/// has one more member.
pub async fn authorise_account(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    scope: Option<ScopeId>,
    needed: Capability,
) -> Result<Capabilities, AuthorityError> {
    let (ring, watch) = (auth.ring, auth.watch);
    let organisation = auth.organisation();
    let account = auth.actor();

    // 1. The scope and its ancestors. `None` is the organisation itself, which
    //    every grant in the organisation is at or above.
    let mut covering: BTreeSet<Option<String>> = BTreeSet::new();
    covering.insert(None);
    if let Some(scope) = scope {
        let row = tx
            .query_opt(
                "SELECT path FROM scopes WHERE id = $1 AND organisation_id = $2",
                &[&scope.to_string(), &organisation],
            )
            .await?
            .ok_or(AuthorityError::NotAuthorised)?;
        let path: String = row.get(0);
        for ancestor in path.split('.') {
            covering.insert(Some(ancestor.to_string()));
        }
    }

    // 2. The head, and its seal.
    let head = tx
        .query_opt(
            "SELECT auth_epoch, chain_seq, live_count, live_digest, head_seal \
               FROM organisation_auth_head WHERE organisation_id = $1",
            &[&organisation],
        )
        .await?
        .ok_or(AuthorityError::Unverifiable("authority head"))?;
    let auth_epoch: i32 = head.get(0);
    let head_chain_seq: i64 = head.get(1);
    let stored_digest: Vec<u8> = head.get(3);
    let stored_head_seal: Vec<u8> = head.get(4);

    let recomputed_head = authority::head_seal(
        &seal_key_for(ring, &organisation),
        &organisation,
        auth_epoch,
        head_chain_seq,
        &as_32(&stored_digest, "live digest")?,
    );
    if stored_head_seal != recomputed_head {
        return Err(AuthorityError::Unverifiable("authority head seal"));
    }

    // 3. The rollback check.
    watch.observe(&organisation, auth_epoch)?;

    // The live set as the database says it is now, and the digest over it. If
    // the head's digest disagrees, a live row has been added, removed or
    // edited since the head was sealed -- which is precisely the
    // hand-inserted grant, the edited capability and the deleted revocation.
    let live = live_set(tx, ring, &organisation).await?;
    let recomputed_digest = authority::live_digest(
        &row_key_for(ring, &organisation),
        &organisation,
        auth_epoch,
        &live,
    );
    if stored_digest != recomputed_digest {
        return Err(AuthorityError::Unverifiable("live set"));
    }
    let live_ids: BTreeSet<String> = live.into_iter().map(|(id, _)| id).collect();

    // 5. The organisation id, recomputed from its root key. Every grant in
    //    this organisation chains to genesis, so this runs once here rather
    //    than per grant.
    let root_fpr = organisation_root_fpr(tx, ring, &organisation).await?;

    // 4. The candidates.
    let rows = tx
        .query(
            "SELECT id FROM scope_grants \
              WHERE organisation_id = $1 AND subject_id = $2",
            &[&organisation, &account],
        )
        .await?;

    let now = now_unix();
    let mut best: Option<Capabilities> = None;
    for row in rows {
        let id: String = row.get(0);
        let grant = read_grant(tx, &id)
            .await?
            .ok_or(AuthorityError::Corrupt("grant"))?;

        if !covering.contains(&grant.scope_id) {
            continue;
        }
        if !live_ids.contains(&grant.id) {
            // Revoked or suspended. Not an error: another grant may cover it.
            continue;
        }
        if grant.effective_from_unix > now {
            continue;
        }
        if grant.expires_at_unix != 0 && grant.expires_at_unix <= now {
            continue;
        }
        if !grant.capability.covers(needed) {
            continue;
        }

        // The row's own seal.
        let recomputed = authority::row_seal(
            &row_key_for(ring, &organisation),
            &RowFacts {
                table: "scope_grants",
                row_id: &grant.id,
                chain_seq: grant.chain_seq,
                row_version: grant.row_version,
                row_state: &grant_row_state(&grant),
            },
        );
        if grant.row_seal != recomputed {
            return Err(AuthorityError::Unverifiable("grant row seal"));
        }

        // The subject's key, and the granter's, each with its own row seal
        // verified, and the signature over recomputed bytes.
        let subject_key =
            key_by_fingerprint(tx, ring, &organisation, &grant.subject_key_fpr).await?;
        if subject_key.account_id != grant.subject_id {
            return Err(AuthorityError::Unverifiable("subject key binding"));
        }

        let message = authority::grant_bytes(&GrantFacts {
            organisation: &organisation,
            root_pubkey_fpr: &root_fpr,
            scope: grant.scope_id.as_deref().unwrap_or(""),
            subject: &grant.subject_id,
            subject_key_fpr: &grant.subject_key_fpr,
            capability: grant.capability,
            granter: grant.granted_by.as_deref(),
            granter_key_fpr: &grant.granter_key_fpr,
            effective_from_unix: grant.effective_from_unix,
            expires_at_unix: grant.expires_at_unix,
            auth_epoch: grant.auth_epoch,
        });

        let granter_public_key = match &grant.granted_by {
            Some(_) => {
                let key =
                    key_by_fingerprint(tx, ring, &organisation, &grant.granter_key_fpr).await?;
                key.public_key
            }
            None => {
                // Root-signed: genesis or recovery. The fingerprint in the row
                // must be the root's own, or the signature would be checked
                // against whatever key the keyring happens to hold.
                if grant.granter_key_fpr != root_fpr {
                    return Err(AuthorityError::Unverifiable("root grant fingerprint"));
                }
                tx.query_one(
                    "SELECT root_pubkey FROM organisation_roots WHERE organisation_id = $1",
                    &[&organisation],
                )
                .await?
                .get(0)
            }
        };
        authority::verify_es256(&granter_public_key, &message, &grant.granter_sig)?;

        // 6. §3.5's quorum, at use.
        if grant.capability == Capability::Steward
            && !grant.is_genesis
            && !grant.is_recovery
            && !grant.sole_steward_appointment
        {
            let secondings = tx
                .query(
                    "SELECT seconder_key_fpr, seconder_sig FROM grant_secondings \
                      WHERE grant_id = $1",
                    &[&grant.id],
                )
                .await?;
            let mut verified = 0usize;
            for seconding in &secondings {
                let fpr: Vec<u8> = seconding.get(0);
                let sig: Vec<u8> = seconding.get(1);
                let fpr = as_32(&fpr, "seconder key fingerprint")?;
                let key = key_by_fingerprint(tx, ring, &organisation, &fpr).await?;
                let second = authority::second_bytes(&message, &grant.granter_key_fpr);
                authority::verify_es256(&key.public_key, &second, &sig)?;
                verified += 1;
            }
            if verified == 0 {
                return Err(AuthorityError::QuorumNotMet { needed: 2, have: 1 });
            }
        }

        // 7. The answer. The widest capability wins, so a steward who also
        //    holds `read` somewhere is not answered with `read`.
        let candidate = Capabilities {
            organisation: organisation.clone(),
            scope: grant.scope_id.clone(),
            capability: grant.capability,
            via_grant: grant.id.clone(),
            auth_epoch,
        };
        best = match best {
            Some(current) if current.capability >= candidate.capability => Some(current),
            _ => Some(candidate),
        };
    }

    best.ok_or(AuthorityError::NotAuthorised)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_epoch_watch_refuses_a_head_that_went_backwards() {
        let watch = EpochWatch::new();
        assert!(watch.observe("org", 3).is_ok());
        assert!(watch.observe("org", 3).is_ok());
        assert!(watch.observe("org", 4).is_ok());
        let refused = watch.observe("org", 2);
        assert!(
            matches!(refused, Err(AuthorityError::Rollback { seen: 4, found: 2 })),
            "{refused:?}"
        );
        // Per organisation, not global: another tenant's epochs are its own.
        assert!(watch.observe("other", 1).is_ok());
    }

    #[test]
    fn a_grant_row_state_covers_the_fields_a_signature_does_not() {
        let grant = Grant {
            id: "01JQZ0000000000000000000AA".to_string(),
            organisation_id: "01JQZ0000000000000000000BB".to_string(),
            scope_id: None,
            subject_id: "01JQZ0000000000000000000CC".to_string(),
            subject_key_fpr: [1u8; 32],
            capability: Capability::Steward,
            granted_by: None,
            granter_key_fpr: [2u8; 32],
            granter_sig: vec![3u8; 64],
            is_genesis: true,
            is_recovery: false,
            sole_steward_appointment: false,
            auth_epoch: 1,
            effective_from_unix: 100,
            expires_at_unix: 200,
            chain_seq: 1,
            row_version: 1,
            row_seal: Vec::new(),
        };
        let a = grant_row_state(&grant);
        let b = grant_row_state(&Grant {
            is_genesis: false,
            ..grant.clone()
        });
        assert_ne!(
            a, b,
            "is_genesis is not inside grant_bytes, so the row seal must cover it"
        );
        let c = grant_row_state(&Grant {
            sole_steward_appointment: true,
            ..grant
        });
        assert_ne!(
            a, c,
            "the sole-steward flag decides whether a seconding is needed"
        );
    }
}
