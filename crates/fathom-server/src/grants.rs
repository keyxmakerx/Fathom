//! The authority layer's database side: the keyring, genesis, grants, their
//! secondings, suspensions and revocations, the head that says which are live,
//! and `authorise_account` (the seven steps of §3.4, run at **every** use).
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §§3.2–3.5, §6.1 and §7.2;
//! `migrations/0011_authority.sql` is the schema and carries the reasoning for
//! each constraint. `authority.rs` holds the bytes; this file holds the SQL and
//! the order of events (the `chain.rs`/`chains.rs` split).
//!
//! # Two rules that shape every function here
//!
//! **Every signed act writes its sealed organisation-chain entry in the same
//! transaction** (§7.2, via `chains::append_org`). An act that cannot record
//! itself does not commit, so "stopping the log stops the act" is mechanical.
//!
//! **Every act advances the head** (§3.4). A grant row proves who wrote it; the
//! head proves what the set currently says. Without the head, deleting a
//! `grant_revocations` row restores a revoked grant, and editing `capability`
//! changes what a live one grants. With it both are caught at the next use,
//! because the head's `live_digest` covers each live grant's row seal.
//!
//! # What is not here
//!
//! - **No memoised live set across calls** (§3.4 permits one). Nothing is cached
//!   that a database write could poison, and the cheapest way to hold that line
//!   is to have nowhere to put a stale answer. The one memo, `QuorumPass`, lives
//!   on the stack inside a single authorisation; it keeps the seconding walk
//!   linear and no second use can see it.
//! - **No verdict is ever stored**, and no column could hold one.
//! - **No hardware factor** (§15.1). Keys are software ES256, and
//!   `account_keys.key_source` records that as fact.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{LazyLock, Mutex};

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
/// Only the delay is enforced here. The banner, mailed notice and cancel button
/// need a surface that does not exist yet (named as unbuilt in `0011`).
pub const SOLE_STEWARD_DELAY_SECONDS: i64 = 24 * 60 * 60;

/// How far into the past a proposal's `effective_from` may have drifted when the
/// signed grant comes back (§3.3).
///
/// Two minutes covers a human reading, a software key signing and clock drift,
/// and is too short for a captured proposal to be replayed into a materially
/// different authority state. The exact epoch check is the freshness control;
/// this bounds staleness for the one field the epoch does not pin.
pub const PROPOSAL_SKEW_SECONDS: i64 = 120;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything the authority layer refuses, and why.
///
/// **`Unverifiable` is deliberately not a permission error** (§3.4 step 2): it
/// must never read as "no grants found".
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
    /// A proposal was overtaken between [`propose_grant`] and [`sign_grant`]:
    /// the head moved, or `effective_from` has gone stale. **The caller must
    /// re-propose and have the new bytes signed** — the server may not adjust
    /// the bytes, because the signature covers them.
    Stale(&'static str),
    /// §3.5's sole-steward path is unavailable while a single-steward act that
    /// weakens another steward is still within its delay.
    SoleStewardPathBlocked,
    /// The organisation's `is_genesis` rows are not the ones its sealed
    /// `org_genesis` chain entry names (§6.1).
    GenesisSetMismatch,
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
            Self::Stale(what) => write!(
                f,
                "this grant proposal was overtaken ({what}). The signature covers the bytes that \
                 were issued and the server may not alter them, so propose the grant again and \
                 sign the new bytes"
            ),
            Self::SoleStewardPathBlocked => f.write_str(
                "a single-steward act that removes or weakens another steward is still within \
                 its delay, so the sole-steward appointment path is closed until it takes effect \
                 or is revoked",
            ),
            Self::GenesisSetMismatch => f.write_str(
                "this organisation's genesis grants are not the ones its sealed org_genesis \
                 entry names, so a genesis row has been added, removed or altered since \
                 creation",
            ),
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
/// §3.4 step 3: a head whose epoch is lower than one already seen is a rollback;
/// fail closed. Seals bind backwards only, so restored old tables give an
/// authority that verifies perfectly and nothing inside the database can notice.
/// This memory is the one place a tier-2 attacker cannot write.
///
/// **Owned, not global.** A process-wide static would be poisoned by any
/// transaction that advanced the head and then rolled back (routine in tests and
/// on failed requests). The caller passes the one it means.
///
/// **Limit:** it detects rollback only within one process lifetime. A restart
/// forgets everything, which is why §7.6's anchors exist (still deferred).
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
/// Each is a control. `ring` is the only source of the chain key a seal
/// recomputes under. `ctx` is §4's pinned tenant (`repo::TenantContext` cannot be
/// built from a row). `tenant_key` seals the organisation chain's metadata.
/// `watch` is §3.4 step 3's high-water mark. One value means a new act cannot
/// quietly omit one.
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
    /// When this key left service; `0` means still in service.
    ///
    /// **A timestamp, not a boolean:** §3.3 resolves a key *as of* a grant's
    /// `effective_from`, so a key retired last week must still verify grants it
    /// signed last year.
    pub retired_at_unix: i64,
}

impl AccountKey {
    /// Whether this key was in service at `at_unix` (§3.3, §8.4).
    ///
    /// Retirement and supersession both take a key out of service and are
    /// recorded with the same timestamp by [`supersede_key`], so one comparison
    /// answers both.
    ///
    /// **The boundary is inclusive, deliberately.** A key is in service up to and
    /// including the instant it is retired. An exclusive check would invalidate a
    /// grant signed before the retirement was requested (e.g. both within one
    /// second). The check exists to refuse a grant effective *after* the key left
    /// service, which `<=` does exactly.
    pub fn in_service_at(&self, at_unix: i64) -> bool {
        self.retired_at_unix == 0 || at_unix <= self.retired_at_unix
    }
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

/// `K_row_site`: the subkey **`account_keys` rows are sealed under**.
///
/// The keyring is account-scoped, and an account may belong to two
/// organisations. Sealing under one organisation's row key would make the row
/// verify only there; the other would recompute a different seal and refuse the
/// account as `Unverifiable`, an integrity alarm for a forgery that never
/// happened. The site chain key is the one key the same for every organisation,
/// so account-scoped rows are sealed under it. The label is unchanged (see
/// `authority::row_key`).
///
/// `pub(crate)` because session rows are account-scoped the same way and
/// `sessions.rs` seals under this same subkey. Nothing outside this crate can
/// reach it.
pub(crate) async fn site_row_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
) -> Result<Key32, AuthorityError> {
    Ok(authority::row_key(&site_chain_key(tx, ring).await?))
}

/// **The site chain key itself**: the one key the same for every organisation,
/// and the input every site-scoped subkey is expanded from.
///
/// `pub(crate)` because `sessions.rs` expands a second subkey from it (the keyed
/// hash of a claimed sign-in address). It needs the key, not the row subkey: a
/// KDF label separates uses of ONE key, and hashing an address is not a row seal.
///
/// Nothing inside this crate may return it to a caller not already trusted with
/// `chain_master`.
pub(crate) async fn site_chain_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
) -> Result<Key32, AuthorityError> {
    let deployment = chains::deployment_id(&**tx).await?;
    Ok(chain::chain_key(
        ring.chain_master(),
        ChainRef::Site {
            deployment: &deployment,
        },
        CHAIN_KEY_EPOCH,
    ))
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
/// which side computed it. It includes every field the signature does not
/// cover, notably `is_genesis` and `sole_steward_appointment`, which decide
/// treatment at use and are not in `grant_bytes`.
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
    map.insert("retired_at".to_string(), Json::Int(key.retired_at_unix));
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
/// §15.1's downgrade, made explicit: `key_source = 'software'`, no
/// `credential_id`. §6.4's "no way to grant access to a phantom account" rests
/// on this table: a grant names a subject's key fingerprint, and one in no
/// keyring resolves to nothing.
pub async fn enrol_software_key(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    public_key: &[u8],
) -> Result<AccountKey, AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
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

    insert_account_key(tx, ring, &id, &account, public_key, appended.seq).await
}

/// Enrol an account's **first** software key on the site chain, when an
/// enrolment token is redeemed (§1.1, §5.1, §6.2, migration `0015`).
///
/// # Why this exists beside [`enrol_software_key`]
///
/// [`enrol_software_key`] files on an ORGANISATION's chain and needs an
/// [`Authority`] (so a membership row). That cannot work for a first key: §6.4
/// lets a steward grant only to a subject with a registered key, and §6.2 has an
/// organisation shell redeemed by an account that already has one. So no
/// organisation chain exists to file it on.
///
/// §7.1: "the site chain covers everything organisation-independent". §7.2 names
/// the type `authenticator_registered` on the site chain.
///
/// **The row, its seal and the keyring's shape are identical.** Both paths use
/// `insert_account_key`, so `live_signing_key` cannot tell them apart, which is
/// what lets sign-in work for both.
pub async fn enrol_software_key_at_invitation(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    account: &str,
    public_key: &[u8],
) -> Result<AccountKey, AuthorityError> {
    let fpr = authority::key_fingerprint(public_key);
    let id = ids::new_ulid().to_string();

    let appended = chains::append_site(
        tx,
        ring,
        deployment,
        EntryType::AuthenticatorRegistered,
        &entry_metadata(
            EntryType::AuthenticatorRegistered,
            &[
                ("account", Json::Str(account.to_string())),
                ("key", Json::Str(id.clone())),
                ("fpr", Json::Str(hex(&fpr))),
                ("key_source", Json::Str("software".to_string())),
                ("principal_kind", Json::Str("steward".to_string())),
            ],
        ),
    )
    .await?;

    insert_account_key(tx, ring, &id, account, public_key, appended.seq).await
}

/// The row every enrolment path writes, sealed the one way.
///
/// One function, so the two chains cannot drift into two row shapes. The seal is
/// `authority::row_seal` under the site-scoped row key, which `verify_key_row`
/// recomputes at every use (see `site_row_key`).
async fn insert_account_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    id: &str,
    account: &str,
    public_key: &[u8],
    chain_seq: i64,
) -> Result<AccountKey, AuthorityError> {
    let key = AccountKey {
        id: id.to_string(),
        account_id: account.to_string(),
        public_key: public_key.to_vec(),
        fpr: authority::key_fingerprint(public_key),
        enrolled_seq: chain_seq,
        row_version: 1,
        superseded_by: None,
        retired_at_unix: 0,
    };
    let seal = authority::row_seal(
        &site_row_key(tx, ring).await?,
        &RowFacts {
            table: "account_keys",
            row_id: id,
            chain_seq,
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
            &key.fpr.to_vec(),
            &chain_seq,
            &seal.to_vec(),
        ],
    )
    .await?;

    Ok(key)
}

/// Record that `old` named `new` its successor (§8.4).
///
/// The **old key** signs [`authority::succession_bytes`]; this verifies that
/// signature before storing it. An unchecked succession could point an account's
/// authority at a key its holder never approved.
pub async fn supersede_key(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    old_key_id: &str,
    new_key_id: &str,
    succession_sig: &[u8],
    at_unix: i64,
) -> Result<(), AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
    let old = read_account_key(tx, old_key_id)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    let new = read_account_key(tx, new_key_id)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;

    // **The successor must belong to the same account.** Otherwise one signature
    // could name somebody else's key as successor and carry every grant naming
    // the old fingerprint onto an account that never asked. A key's holder may
    // retire it, not redirect it (§8.4).
    if new.account_id != old.account_id {
        return Err(AuthorityError::Unverifiable(
            "key succession across accounts",
        ));
    }

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
        retired_at_unix: at_unix,
        row_version: old.row_version + 1,
        ..old.clone()
    };
    let seal = authority::row_seal(
        &site_row_key(tx, ring).await?,
        &RowFacts {
            table: "account_keys",
            row_id: &superseded.id,
            chain_seq: superseded.enrolled_seq,
            row_version: superseded.row_version,
            row_state: &account_key_row_state(&superseded),
        },
    );

    // `retired_at` is the signed `at_unix`, not `now()`: the seal covers it, and
    // verifiers resolve a key as of a grant's `effective_from` against it. Row
    // and signature must agree on when the key left service.
    let updated = tx
        .execute(
            "UPDATE account_keys \
                SET superseded_by = $1, succession_sig = $2, \
                    retired_at = to_timestamp($3::bigint), \
                    row_version = $4, row_seal = $5 \
              WHERE id = $6",
            &[
                &new.id,
                &succession_sig.to_vec(),
                &at_unix,
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

/// Retire a key: take it out of service **without** naming a successor.
///
/// `0011` created `account_key_retired` and `account_keys.retired_at`, but
/// nothing wrote either; a schema element no code produces reads as a mechanism
/// that exists. This is that mechanism.
///
/// # Who may sign it
///
/// The key's own holder, **or a steward of the organisation** (§8.4's succession
/// shape plus one extension). Succession needs the old key. Retirement is the
/// case where the holder is gone (the dropped laptop, §6.4's departure), so
/// holder-only would leave the keys that most need retiring unretirable. A
/// steward already holds revocation over every grant the key names, so this
/// grants nothing new; it makes the keyring say so.
///
/// The signer's own fingerprint is inside [`authority::retire_bytes`], so a
/// steward's retirement of someone else's key is not readable as that person's
/// act.
pub async fn retire_key(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    key_id: &str,
    signature: &[u8],
    at_unix: i64,
) -> Result<(), AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
    let actor = auth.actor();
    let key = read_account_key(tx, key_id)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;

    if key.retired_at_unix != 0 {
        return Err(AuthorityError::Unverifiable("key already retired"));
    }

    // The signer: the holder, or a steward established through the same seven
    // steps as every other authority act, so there is no second, weaker notion of
    // "is a steward" here.
    let signer = signing_key_of(tx, &actor)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    if key.account_id != actor {
        authorise_account(tx, auth, None, Capability::Steward).await?;
    }

    let message = authority::retire_bytes(&key.account_id, &key.fpr, &signer.fpr, at_unix);
    authority::verify_es256(&signer.public_key, &message, signature)?;

    let appended = chains::append_org(
        tx,
        ring,
        ctx,
        tenant_key,
        EntryType::AccountKeyRetired,
        &entry_metadata(
            EntryType::AccountKeyRetired,
            &[
                ("account", Json::Str(key.account_id.clone())),
                ("key", Json::Str(key.id.clone())),
                ("fpr", Json::Str(hex(&key.fpr))),
                ("retired_by", Json::Str(actor.clone())),
                ("at", Json::Int(at_unix)),
            ],
        ),
    )
    .await?;

    let retired = AccountKey {
        retired_at_unix: at_unix,
        row_version: key.row_version + 1,
        ..key.clone()
    };
    let seal = authority::row_seal(
        &site_row_key(tx, ring).await?,
        &RowFacts {
            table: "account_keys",
            row_id: &retired.id,
            chain_seq: retired.enrolled_seq,
            row_version: retired.row_version,
            row_state: &account_key_row_state(&retired),
        },
    );

    let updated = tx
        .execute(
            "UPDATE account_keys \
                SET retired_at = to_timestamp($1::bigint), row_version = $2, row_seal = $3 \
              WHERE id = $4 AND retired_at IS NULL",
            &[&at_unix, &retired.row_version, &seal.to_vec(), &retired.id],
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
                    COALESCE(EXTRACT(EPOCH FROM retired_at)::bigint, 0) \
               FROM account_keys WHERE id = $1",
            &[&id],
        )
        .await?;
    let Some(row) = row else { return Ok(None) };
    let fpr: Vec<u8> = row.get(3);
    Ok(Some(AccountKey {
        id: row.get(0),
        account_id: row.get(1),
        public_key: row.get(2),
        fpr: as_32(&fpr, "key fingerprint")?,
        enrolled_seq: row.get(4),
        row_version: row.get(5),
        superseded_by: row.get(6),
        retired_at_unix: row.get(7),
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

/// The account's key **as `sign_in` must resolve it**: the live one, its keyring
/// row seal verified, and in service at `at_unix`.
///
/// [`signing_key_of`] verifies nothing, which suits a caller handing bytes to a
/// human. A caller accepting a signature as proof of identity needs the seal
/// checked: an edited `public_key` is how an administrator would sign in as
/// somebody else. Added for `sessions.rs` (§4.2).
pub async fn live_signing_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    account: &str,
    at_unix: i64,
) -> Result<AccountKey, AuthorityError> {
    let key = signing_key_of(tx, account)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    verify_key_row(tx, ring, &key, at_unix).await?;
    Ok(key)
}

// ---- ADR-0055 stream (a): any live key of the account, not the newest ------

/// **Every** key this account could sign with today: neither superseded nor
/// retired, newest first.
///
/// [`signing_key_of`] uses `LIMIT 1`, right while an account had one key.
/// ADR-0055 decision 6 ("Any browser, no pairing") registers a per-browser key
/// after each password sign-in, so a person on two machines has two live keys and
/// neither supersedes the other. `LIMIT 1` would refuse the older browser, which
/// reads as a stolen key rather than a second machine.
///
/// `ORDER BY enrolled_seq DESC` is kept so the single-key case returns exactly
/// what `signing_key_of` does.
pub async fn live_signing_keys(
    tx: &Transaction<'_>,
    account: &str,
) -> Result<Vec<AccountKey>, AuthorityError> {
    let rows = tx
        .query(
            "SELECT id FROM account_keys \
              WHERE account_id = $1 AND superseded_by IS NULL AND retired_at IS NULL \
              ORDER BY enrolled_seq DESC",
            &[&account],
        )
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let id: String = row.get(0);
        if let Some(key) = read_account_key(tx, &id).await? {
            out.push(key);
        }
    }
    Ok(out)
}

/// Verify `signature` over `message` against **any** of this account's live
/// keys, and say which one verified.
///
/// Each candidate's own row seal is checked before its public key is believed,
/// as [`live_signing_key`] does: an edited `public_key` is how an administrator
/// would sign as somebody else.
///
/// [`AuthorityError::NoSigningKey`] when the account has no live key: the
/// expected state for a password-only person, which a caller with another factor
/// must not read as a refusal.
pub async fn verify_by_any_live_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    account: &str,
    message: &[u8],
    signature: &[u8],
    at_unix: i64,
) -> Result<AccountKey, AuthorityError> {
    let candidates = live_signing_keys(tx, account).await?;
    if candidates.is_empty() {
        return Err(AuthorityError::NoSigningKey);
    }
    let mut refused: Option<AuthorityError> = None;
    for key in candidates {
        // An UNVERIFIABLE row is an integrity alarm; do not swallow it by trying
        // the next key (§3.4 step 2). A keyring with one edited row is an
        // incident whichever key was used.
        verify_key_row(tx, ring, &key, at_unix).await?;
        match authority::verify_es256(&key.public_key, message, signature) {
            Ok(()) => return Ok(key),
            Err(e) => refused = Some(AuthorityError::from(e)),
        }
    }
    Err(refused.unwrap_or(AuthorityError::NoSigningKey))
}

/// One keyring row by id, seal verified, in service at `at_unix`.
///
/// A session records **which** key proved it, so the session dies with that key
/// (§8.4's retirement, checked every request). Resolving the account's *current*
/// key would let a retired key's session survive on its successor's authority,
/// which nobody authorised.
pub async fn signing_key_by_id(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    key_id: &str,
    at_unix: i64,
) -> Result<AccountKey, AuthorityError> {
    let key = read_account_key(tx, key_id)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    verify_key_row(tx, ring, &key, at_unix).await?;
    Ok(key)
}

/// The seal-and-service check both of the two above share with
/// [`key_by_fingerprint`].
async fn verify_key_row(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    key: &AccountKey,
    at_unix: i64,
) -> Result<(), AuthorityError> {
    let stored: Vec<u8> = tx
        .query_one(
            "SELECT row_seal FROM account_keys WHERE id = $1",
            &[&key.id],
        )
        .await?
        .get(0);
    let recomputed = authority::row_seal(
        &site_row_key(tx, ring).await?,
        &RowFacts {
            table: "account_keys",
            row_id: &key.id,
            chain_seq: key.enrolled_seq,
            row_version: key.row_version,
            row_state: &account_key_row_state(key),
        },
    );
    if stored != recomputed {
        return Err(AuthorityError::Unverifiable("account key row seal"));
    }
    if !key.in_service_at(at_unix) {
        return Err(AuthorityError::NoSigningKey);
    }
    Ok(())
}

/// Resolve a key by fingerprint **as of `at_unix`**, verifying the keyring row's
/// own seal (§3.4 step 4, §3.3, §8.4).
///
/// # Why this takes a time
///
/// §3.3: verification uses the keyring entry live at `effective_from`; that is
/// why a rotation does not invalidate a year of grants. A key retired or
/// superseded **after** a grant was signed still verifies it; one retired
/// **before** verifies nothing.
///
/// Reading these as booleans ("retired *now*") gets both wrong: it invalidates
/// history on every rotation and accepts a grant backdated to before the key
/// existed. The comparison is against the grant's own `effective_from`, which is
/// inside the signed bytes and not the attacker's to choose.
///
/// `pub(crate)`: `operators::redeem_organisation_claim` also calls this, to
/// check a genesis grant's key at the door.
pub(crate) async fn key_by_fingerprint(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    fpr: &[u8; 32],
    at_unix: i64,
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
        &site_row_key(tx, ring).await?,
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
    if !key.in_service_at(at_unix) {
        return Err(AuthorityError::NoSigningKey);
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
/// genesis steward grants, and **discards the private key**. This function is
/// the server half: it recomputes the derivation, verifies every genesis
/// signature under the root public key, writes `org_genesis` and one
/// `grant_signed` entry per grant, and opens the head at epoch 1.
///
/// # What §15.2 defers
///
/// §6.1 step 3 (Shamir-splitting the root private key to recovery holders) is
/// **not built, and neither is its replacement** (wrapping it to each holder's
/// account key, "weaker on paper"). So this takes no shares or recovery holders,
/// and `recovery_holders` is not a table yet.
///
/// **Whatever the caller does with the root private key after genesis is outside
/// this system.** If kept, it can sign a recovery grant later (§8.2's controls
/// on that are not built). If discarded, break-glass is unavailable for that
/// organisation and nothing says so. The one real control is the `0011` trigger:
/// after genesis the root key can write no further genesis grant at any
/// privilege level, because the head's epoch is past 0.
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

    // **The genesis grants are named in the sealed entry before any is written**
    // (§6.1, `0012`'s header). No `CHECK` can read another table, so no constraint
    // can say "no genesis after creation"; the organisation's chain can. Each id
    // is minted here, listed in `org_genesis`, then used as the row's primary key,
    // so a genesis row this entry does not name is refused at use, and a late one
    // cannot be named by an earlier-sealed entry.
    let mut ids_for: Vec<String> = Vec::with_capacity(grants.len());
    for _ in grants {
        ids_for.push(ids::new_ulid().to_string());
    }
    let named_genesis = Json::Arr(
        grants
            .iter()
            .zip(&ids_for)
            .map(|(request, id)| {
                let mut map = BTreeMap::new();
                map.insert("grant".to_string(), Json::Str(id.clone()));
                map.insert(
                    "subject".to_string(),
                    Json::Str(request.subject.to_string()),
                );
                map.insert(
                    "subject_key_fpr".to_string(),
                    Json::Str(hex(&request.subject_key_fpr)),
                );
                Json::Obj(map)
            })
            .collect(),
    );

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
                ("genesis_grants", named_genesis),
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
    for (request, grant_id) in grants.iter().zip(&ids_for) {
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
            // Root-signed, so needs no seconding for its own reason (§6.1). Not
            // §3.5's sole-steward path, so no flag.
            sole_steward_appointment: false,
            auth_epoch: 1,
        };
        let message = authority::grant_bytes(&facts);
        // **Verified before it is stored, and again at every use.** This call is
        // not the control (§3.4's is); it refuses a signature that could never
        // verify at the door.
        authority::verify_es256(root_pubkey, &message, &request.signature)?;

        let grant = Grant {
            id: grant_id.clone(),
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
//
// Two steps. `propose_grant` fixes every server-chosen value (`auth_epoch`,
// `now`, `effective_from`) and returns exactly the bytes to sign. `sign_grant`
// verifies over those bytes AS ISSUED and never recomputes them. At commit it
// only re-checks that the proposal is still current, and otherwise refuses and
// says to propose again. A one-step shape cannot work: the client cannot sign
// bytes that do not exist until after it signed. The server may not quietly
// adjust bytes somebody has signed.
// ---------------------------------------------------------------------------

/// What a steward is asking to grant.
pub struct GrantRequest {
    pub scope: Option<ScopeId>,
    pub subject: AccountId,
    pub capability: Capability,
    /// `0` for "does not expire". `0011` refuses it for `steward`.
    pub expires_at_unix: i64,
}

/// A proposal: every server-chosen value fixed, and the exact bytes to sign.
/// Signed by the granter and handed back to [`sign_grant`] unchanged; nothing is
/// recomputed on the way back.
#[derive(Clone, Debug)]
pub struct GrantProposal {
    pub organisation: String,
    pub scope: Option<String>,
    pub subject: String,
    pub subject_key_fpr: [u8; 32],
    pub capability: Capability,
    pub granter: String,
    pub granter_key_fpr: [u8; 32],
    pub root_pubkey_fpr: [u8; 32],
    /// Server-chosen, and therefore inside the bytes before anybody signs.
    pub effective_from_unix: i64,
    pub expires_at_unix: i64,
    /// Server-chosen. Re-checked at [`sign_grant`], never re-derived.
    pub auth_epoch: i32,
    /// §3.5's sole-steward path: server-chosen, **inside the signed bytes**
    /// (`fathom/grant/v2`), and re-derived at [`sign_grant`], not believed. It
    /// decides whether a `steward` grant is live on one signature.
    pub sole_steward_appointment: bool,
    /// **Exactly the bytes to sign**: `authority::grant_bytes` over the facts
    /// above, built once so the two steps cannot disagree.
    pub bytes: Vec<u8>,
}

impl GrantProposal {
    /// A proposal read back off the wire, with `bytes` rebuilt from its own fields.
    /// [`sign_grant`] re-derives every server-chosen field, so a changed one is
    /// refused there or fails the signature, which covers all of them.
    pub fn rebuilt(self) -> Self {
        Self {
            bytes: proposal_bytes(&self),
            ..self
        }
    }
}

/// Step one: fix the server's choices and produce the bytes to sign (§3.3).
///
/// The granter must already hold `steward` at or above the scope, **verified
/// through `authorise_account`**.
///
/// # §3.5's quorum, and the sole-steward path
///
/// Granting `read` or `draw` needs one steward. Granting `steward` needs
/// `min(2, live distinct stewards)`:
///
/// - **Two or more live stewards**: the grant is not usable until a second
///   steward seconds it ([`second_grant`]), enforced at use by
///   `authorise_account`.
/// - **Exactly one live steward**: §3.5's sole-steward path. The grant is marked
///   `sole_steward_appointment`, its `effective_from` is pushed 24 hours out, and
///   it needs no seconding.
///
/// The count is [`AuthorityState::steward_count`] (see its note on suspended and
/// expired stewards). The sole path is closed while a single-steward act that
/// weakens another steward is still in its delay, so suspending your co-steward
/// does not make you sole.
pub async fn propose_grant(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    request: &GrantRequest,
) -> Result<GrantProposal, AuthorityError> {
    let ring = auth.ring;
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

    let now = now_unix();
    let state = read_authority_state(tx, &organisation).await?;
    let choices = server_choices(&state, request.capability, now)?;

    let epoch = next_epoch(tx, &organisation).await?;
    let scope_text = request.scope.map(|s| s.to_string());

    let proposal = GrantProposal {
        organisation,
        scope: scope_text,
        subject: request.subject.to_string(),
        subject_key_fpr: subject_key.fpr,
        capability: request.capability,
        granter,
        granter_key_fpr: granter_key.fpr,
        root_pubkey_fpr: root_fpr,
        effective_from_unix: choices.effective_from_unix,
        expires_at_unix: request.expires_at_unix,
        auth_epoch: epoch,
        sole_steward_appointment: choices.sole_steward_appointment,
        // Filled in below, from the fields above and nothing else.
        bytes: Vec::new(),
    };
    Ok(GrantProposal {
        bytes: proposal_bytes(&proposal),
        ..proposal
    })
}

/// Every value the **server** picks for a grant, derived from the authority
/// state at `now`.
///
/// Called by both [`propose_grant`] and [`sign_grant`] (which refuses if the
/// answer changed). Two spellings of "is this a sole-steward appointment" is how
/// the two ends come to disagree.
struct ServerChoices {
    sole_steward_appointment: bool,
    effective_from_unix: i64,
}

fn server_choices(
    state: &AuthorityState,
    capability: Capability,
    now: i64,
) -> Result<ServerChoices, AuthorityError> {
    let sole = capability == Capability::Steward && state.steward_count(now) <= 1;
    if sole && state.a_weakening_act_is_pending(now) {
        return Err(AuthorityError::SoleStewardPathBlocked);
    }
    Ok(ServerChoices {
        sole_steward_appointment: sole,
        // §3.5: the delay is what stands in for the second signature, so the
        // flag and the offset are one decision and are taken in one place.
        effective_from_unix: if sole {
            now + SOLE_STEWARD_DELAY_SECONDS
        } else {
            now
        },
    })
}

/// The bytes a proposal's own fields say it is.
///
/// `GrantProposal`'s fields are all `pub` and it crosses a process boundary, so
/// `bytes` and the fields beside it are two statements of one thing.
/// [`sign_grant`] recomputes this and refuses a proposal whose `bytes` differ.
fn proposal_bytes(proposal: &GrantProposal) -> Vec<u8> {
    authority::grant_bytes(&GrantFacts {
        organisation: &proposal.organisation,
        root_pubkey_fpr: &proposal.root_pubkey_fpr,
        scope: proposal.scope.as_deref().unwrap_or(""),
        subject: &proposal.subject,
        subject_key_fpr: &proposal.subject_key_fpr,
        capability: proposal.capability,
        granter: Some(&proposal.granter),
        granter_key_fpr: &proposal.granter_key_fpr,
        effective_from_unix: proposal.effective_from_unix,
        expires_at_unix: proposal.expires_at_unix,
        sole_steward_appointment: proposal.sole_steward_appointment,
        auth_epoch: proposal.auth_epoch,
    })
}

/// Step two: verify the signature **over the bytes as issued**, and commit.
///
/// The signature is verified over `proposal.bytes` exactly as [`propose_grant`]
/// produced them, never over bytes rebuilt for verification: that would let the
/// server verify something other than what was signed.
///
/// # Every other field IS re-derived
///
/// `GrantProposal` crosses a process boundary with `pub` fields. Copying
/// `sole_steward_appointment` off it would let a steward sign an honest
/// proposal, flip the flag on the way back, and mint a `steward` grant needing no
/// seconding or 24-hour wait, defeating §3.5's quorum. Three things each close it
/// alone:
///
/// 1. **The flag is inside `grant_bytes`** (`fathom/grant/v2`), so flipping it
///    invalidates the granter's and seconder's signatures.
/// 2. **The bytes are recomputed from the proposal's fields** and must equal
///    those presented. A mismatch is a forged proposal, refused as
///    [`AuthorityError::Unverifiable`].
/// 3. **Every server-chosen value is re-derived at commit** and must match: the
///    epoch, the sole-steward determination, its implied `effective_from`, the
///    organisation root fingerprint and the subject's key fingerprint.
///
/// Freshness checks, each exact:
///
/// - **The epoch must still be the head's next.** Otherwise the grant lands in a
///   state its signer never saw.
/// - **The sole-steward determination must still hold.** A second steward
///   appearing between the steps turns a one-signature appointment into one
///   needing seconding.
/// - **`effective_from` must be the one the flag implies**, within
///   [`PROPOSAL_SKEW_SECONDS`]: `now` for an ordinary grant, `now +`
///   [`SOLE_STEWARD_DELAY_SECONDS`] for a sole appointment. Backdating makes a
///   grant look older than the revocation that should have caught it.
///
/// Any failure is [`AuthorityError::Stale`]: propose again. The server cannot
/// adjust and re-sign because it holds no steward's private key (§3.3).
pub async fn sign_grant(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    proposal: &GrantProposal,
    signature: &[u8],
) -> Result<String, AuthorityError> {
    let (ring, ctx, tenant_key) = (auth.ring, auth.ctx, auth.tenant_key);
    let organisation = auth.organisation();

    if proposal.organisation != organisation || proposal.granter != auth.actor() {
        return Err(AuthorityError::Stale("it was issued for another actor"));
    }

    // The bytes must be what the fields spell out. Every field below is read off
    // the proposal, so this makes what the signature covers and what the row is
    // built from one statement.
    if proposal_bytes(proposal) != proposal.bytes {
        return Err(AuthorityError::Unverifiable(
            "the proposal's fields are not the bytes it carries",
        ));
    }

    // The granter's authority again at commit: a proposal is not a permit, and a
    // granter revoked between the steps grants nothing.
    let scope = proposal.scope.as_deref().map(parse_scope).transpose()?;
    authorise_account(tx, auth, scope, Capability::Steward).await?;

    // Every server-chosen value, re-derived from current state. The sole-steward
    // determination is checked BEFORE the epoch, so an overtaken proposal says
    // which fact moved.
    let now = now_unix();
    let state = read_authority_state(tx, &organisation).await?;
    let choices = server_choices(&state, proposal.capability, now)?;
    if choices.sole_steward_appointment != proposal.sole_steward_appointment {
        return Err(AuthorityError::Stale(
            "the sole-steward determination has changed",
        ));
    }
    // `effective_from` must be the value the flag implies, allowing for signing
    // time. Not "not too old": a sole appointment's is a day in the FUTURE, which
    // a one-sided test against `now` passed trivially.
    let drift = choices.effective_from_unix - proposal.effective_from_unix;
    if !(0..=PROPOSAL_SKEW_SECONDS).contains(&drift) {
        return Err(AuthorityError::Stale(
            "effective_from is not the one this proposal's own facts imply",
        ));
    }
    if next_epoch(tx, &organisation).await? != proposal.auth_epoch {
        return Err(AuthorityError::Stale("the authority head has moved"));
    }
    // Re-resolve the two fingerprints. A key rotated between the steps means the
    // bytes name a key the organisation no longer points at: re-propose, not
    // silent substitution.
    if organisation_root_fpr(tx, ring, &organisation).await? != proposal.root_pubkey_fpr {
        return Err(AuthorityError::Stale("the organisation root has moved"));
    }
    let subject_key = signing_key_of(tx, &proposal.subject)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    if subject_key.fpr != proposal.subject_key_fpr {
        return Err(AuthorityError::Stale("the subject's signing key has moved"));
    }

    let granter_key = key_by_fingerprint(
        tx,
        ring,
        &proposal.granter_key_fpr,
        proposal.effective_from_unix,
    )
    .await?;
    if granter_key.account_id != proposal.granter {
        return Err(AuthorityError::Unverifiable("granter key binding"));
    }
    authority::verify_es256(&granter_key.public_key, &proposal.bytes, signature)?;

    let grant = Grant {
        id: ids::new_ulid().to_string(),
        organisation_id: organisation.clone(),
        scope_id: proposal.scope.clone(),
        subject_id: proposal.subject.clone(),
        subject_key_fpr: proposal.subject_key_fpr,
        capability: proposal.capability,
        granted_by: Some(proposal.granter.clone()),
        granter_key_fpr: proposal.granter_key_fpr,
        granter_sig: signature.to_vec(),
        is_genesis: false,
        is_recovery: false,
        // The RE-DERIVED flag, not the proposal's copy. Equal by the check above;
        // if that is ever loosened, the row still says what the state says.
        sole_steward_appointment: choices.sole_steward_appointment,
        auth_epoch: proposal.auth_epoch,
        effective_from_unix: proposal.effective_from_unix,
        expires_at_unix: proposal.expires_at_unix,
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
/// The seconder must hold `steward` and must not be the subject or granter
/// (`0011` refuses both via a three-column foreign key and a `CHECK`). It signs
/// [`authority::second_bytes`], which binds `LP(H(grant_bytes)) ‖
/// LP(granter_key_fpr)` and **never** the granter's signature (§3's correction).
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

    let message = authority::second_bytes(
        &grant_bytes_of(tx, ring, &grant).await?,
        &grant.granter_key_fpr,
    );
    // ADR-0055 stream (a): any live key of the seconder (see
    // `verify_by_any_live_key`), with its row seal checked. The key that VERIFIED
    // goes on the seconding row, so the record names what actually signed.
    let seconder_key =
        verify_by_any_live_key(tx, ring, &seconder, &message, signature, now_unix()).await?;

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

    let row = Seconding {
        id: ids::new_ulid().to_string(),
        grant_id: grant.id.clone(),
        seconded_by: seconder.clone(),
        seconder_key_fpr: seconder_key.fpr,
        seconder_sig: signature.to_vec(),
        chain_seq: appended.seq,
        seconded_at_unix: 0,
        row_seal: Vec::new(),
    };
    let id = row.id.clone();
    let seal = authority::row_seal(
        &row_key_for(ring, &organisation),
        &RowFacts {
            table: "grant_secondings",
            row_id: &id,
            chain_seq: appended.seq,
            row_version: 1,
            row_state: &seconding_row_state(&row),
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

    let grant_bytes = grant_bytes_of(tx, ring, &grant).await?;
    let message = if suspend {
        authority::suspend_bytes(&organisation, &grant.id, &grant_bytes, at_unix)
    } else {
        authority::unsuspend_bytes(&organisation, &grant.id, &grant_bytes, at_unix)
    };
    // ADR-0055 stream (a): any live key of the actor. The key that VERIFIED goes
    // on the suspension row, so the record names what actually signed.
    let key = verify_by_any_live_key(tx, ring, &actor, &message, signature, at_unix).await?;

    let takes_effect = weakening_act_takes_effect_at(&grant, &actor, suspend, at_unix);

    write_suspension(
        tx,
        auth.ring,
        auth.tenant_key,
        &grant,
        suspend,
        "steward",
        &actor,
        Some(&key.fpr),
        Some(signature),
        at_unix,
        takes_effect,
    )
    .await
}

/// When an act against a grant takes effect: now, or after §3.5's delay.
///
/// # The sequence this exists to refuse
///
/// One steward suspends the other, the organisation now looks single-stewarded,
/// the survivor appoints a third **alone** as a sole-steward appointment, then
/// lifts the suspension: two signatures' worth of authority from one, each step
/// permitted.
///
/// [`AuthorityState::steward_count`] closes it from one side by counting a
/// suspended steward. This closes it from the other: **a single-steward act that
/// removes or weakens another steward waits out the same 24 hours a sole
/// appointment does.** While pending it is visible, marked on the organisation
/// chain, and the sole-steward path is closed.
///
/// Three acts are immediate because none weakens anybody else: revoking or
/// suspending a `read` or `draw` grant, acting on your own grant, and lifting a
/// suspension.
///
/// **Cost:** offboarding a steward takes a day to bite. §3.5 accepts that for the
/// mirror-image act; otherwise one signature that cannot appoint a steward
/// immediately could remove one immediately. An organisation needing a steward
/// stopped *now* has operator suspension (§1.1).
fn weakening_act_takes_effect_at(grant: &Grant, actor: &str, weakening: bool, at_unix: i64) -> i64 {
    let weakens_another_steward =
        weakening && grant.capability == Capability::Steward && grant.subject_id != actor;
    if weakens_another_steward {
        at_unix + SOLE_STEWARD_DELAY_SECONDS
    } else {
        at_unix
    }
}

/// Write one suspension row and its sealed entry, then advance the head.
///
/// Shared by steward suspend/unsuspend and [`suspend_grant_by_operator`] (§1.1).
/// An operator row carries no signature or key fingerprint.
#[allow(clippy::too_many_arguments)]
async fn write_suspension(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    tenant_key: &DataKey,
    grant: &Grant,
    suspend: bool,
    actor_kind: &str,
    actor_id: &str,
    actor_key_fpr: Option<&[u8; 32]>,
    actor_sig: Option<&[u8]>,
    at_unix: i64,
    takes_effect_unix: i64,
) -> Result<(), AuthorityError> {
    let organisation = grant.organisation_id.clone();
    let entry_type = if suspend {
        EntryType::GrantSuspended
    } else {
        EntryType::GrantUnsuspended
    };
    let appended = chains::append_org_as(
        tx,
        ring,
        &organisation,
        actor_id,
        tenant_key,
        entry_type,
        &entry_metadata(
            entry_type,
            &[
                ("grant", Json::Str(grant.id.clone())),
                ("actor", Json::Str(actor_id.to_string())),
                ("actor_kind", Json::Str(actor_kind.to_string())),
                ("at", Json::Int(at_unix)),
                ("takes_effect_at", Json::Int(takes_effect_unix)),
                // §3.5: a single-steward act that weakens another steward is
                // *recorded as such* on the organisation chain, not merely delayed,
                // so a reader can see why it waited.
                (
                    "single_steward_act",
                    Json::Bool(takes_effect_unix > at_unix),
                ),
            ],
        ),
    )
    .await?;

    let row = Suspension {
        grant_id: grant.id.clone(),
        action: if suspend { "suspend" } else { "unsuspend" }.to_string(),
        actor_kind: actor_kind.to_string(),
        actor_id: actor_id.to_string(),
        at_unix,
        takes_effect_unix,
        chain_seq: appended.seq,
        row_seal: Vec::new(),
    };

    // The seal's row identity is the chain sequence (unique per organisation
    // chain): `grant_suspensions.seq` is database-assigned, after this is computed.
    let seal = authority::row_seal(
        &row_key_for(ring, &organisation),
        &RowFacts {
            table: "grant_suspensions",
            row_id: &grant.id,
            chain_seq: appended.seq,
            row_version: 1,
            row_state: &suspension_row_state(&row),
        },
    );

    tx.execute(
        "INSERT INTO grant_suspensions \
             (grant_id, organisation_id, action, actor_kind, actor_id, actor_key_fpr, actor_sig, \
              at, takes_effect_at, chain_seq, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::bigint), \
                 to_timestamp($9::bigint), $10, $11)",
        &[
            &grant.id,
            &organisation,
            &row.action,
            &actor_kind,
            &actor_id,
            &actor_key_fpr.map(|f| f.to_vec()),
            &actor_sig.map(|s| s.to_vec()),
            &at_unix,
            &takes_effect_unix,
            &appended.seq,
            &seal.to_vec(),
        ],
    )
    .await?;

    advance_head_as(tx, ring, &organisation, actor_id, tenant_key).await?;
    Ok(())
}

/// **§1.1's operator suspend verb.**
///
/// The one authority-adjacent act the operator plane has, and deliberately
/// one-way: `0011`'s `CHECK` refuses `action = 'unsuspend'` for
/// `actor_kind = 'operator'`, so restoring what an operator stopped needs a
/// steward (or the recovery key if none is live).
///
/// # What an operator does NOT gain
///
/// * **No capability.** Suspension only removes a grant from the live set. An
///   operator who suspends every grant has locked stewards out and read nothing.
/// * **No design payload.** `repo::enter_operator_tenant_scope` sets
///   `app.design_capability` to its refusal and never anything else.
/// * **No signature.** `actor_sig` is `NULL`: the operator's authority is the
///   operator session, which the site chain records. The organisation chain
///   records the act with `actor_kind = 'operator'`, so stewards can see the
///   machine side did it.
/// * **No delay.** §3.5's delay is about one steward weakening another. §1.1
///   makes this immediate because it exists to stop a steward now; that
///   asymmetry is why the act is one-way and loudly recorded.
///
/// # Why this takes an organisation id
///
/// `scope_grants` is behind `organisation_id = app.tenant_id`, so the grant
/// cannot be read until a tenant is named, and the tenant cannot be read off the
/// unreadable grant (§4's pinning rule). So the caller names both and **the pair
/// is checked**: the grant is read inside the organisation's scope and refused
/// unless its own `organisation_id` matches. A guessed grant id from another
/// tenant gets `NotAuthorised`. Widening `scope_grants`' read policy to any
/// transaction setting `app.operator_custody` was rejected: it would let the
/// application role read every grant in the estate.
pub async fn suspend_grant_by_operator(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    operator_id: &str,
    organisation: &str,
    grant_id: &str,
    at_unix: i64,
) -> Result<String, AuthorityError> {
    let organisation = organisation.to_string();
    repo::enter_operator_tenant_scope(tx, &organisation).await?;

    let grant = read_grant(tx, grant_id)
        .await?
        .ok_or(AuthorityError::NotAuthorised)?;
    if grant.organisation_id != organisation {
        return Err(AuthorityError::NotAuthorised);
    }

    let tenant_key = keys::tenant_key_for(tx, ring, &organisation).await?;

    write_suspension(
        tx,
        ring,
        &tenant_key,
        &grant,
        true,
        "operator",
        operator_id,
        None,
        None,
        at_unix,
        // Immediate, the point of the verb (§1.1). §3.5's delay is about one
        // steward weakening another, and an operator is not a steward.
        at_unix,
    )
    .await?;
    Ok(organisation)
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

    let message = authority::revoke_bytes(
        &organisation,
        &grant.id,
        &grant_bytes_of(tx, ring, &grant).await?,
        at_unix,
    );
    // ADR-0055 stream (a): any live key of the actor, not the newest.
    let key = verify_by_any_live_key(tx, ring, &actor, &message, signature, at_unix).await?;
    let _ = &key;

    // §3.5, as amended: revoking another steward's grant on one signature is a
    // single-steward weakening act and waits out the sole-appointment delay. See
    // `weakening_act_takes_effect_at`.
    let takes_effect = weakening_act_takes_effect_at(&grant, &actor, true, at_unix);

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
                ("at", Json::Int(at_unix)),
                ("takes_effect_at", Json::Int(takes_effect)),
                ("single_steward_act", Json::Bool(takes_effect > at_unix)),
            ],
        ),
    )
    .await?;

    let row = Revocation {
        grant_id: grant.id.clone(),
        revoked_by: actor.clone(),
        revoker_key_fpr: key.fpr,
        revoked_sig: signature.to_vec(),
        revoked_at_unix: at_unix,
        takes_effect_unix: takes_effect,
        chain_seq: appended.seq,
        row_seal: Vec::new(),
    };
    let seal = authority::row_seal(
        &row_key_for(ring, &organisation),
        &RowFacts {
            table: "grant_revocations",
            row_id: &grant.id,
            chain_seq: appended.seq,
            row_version: 1,
            row_state: &revocation_row_state(&row),
        },
    );

    tx.execute(
        "INSERT INTO grant_revocations \
             (grant_id, organisation_id, revoked_at, takes_effect_at, revoked_by, \
              revoker_key_fpr, revoked_sig, chain_seq, row_seal) \
         VALUES ($1, $2, to_timestamp($3::bigint), to_timestamp($4::bigint), $5, $6, $7, $8, $9)",
        &[
            &grant.id,
            &organisation,
            &at_unix,
            &takes_effect,
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
// Sharing a scope: who can do what here, and View/Draw grants
// ---------------------------------------------------------------------------

/// One member's standing at a scope.
#[derive(Clone, Debug)]
pub struct AccessRow {
    pub account: String,
    /// The widest capability that applies here, direct or inherited.
    pub capability: Option<Capability>,
    /// Whether that capability comes from a grant above this scope.
    pub inherited: bool,
    /// Live `read` and `draw` grants made exactly at this scope: `(id, capability)`.
    pub direct: Vec<(String, Capability)>,
}

/// Who among `members` holds what at `scope`. Needs `steward` there.
pub async fn access_at_scope(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    scope: ScopeId,
    members: &[String],
) -> Result<Vec<AccessRow>, AuthorityError> {
    let verified = verify_authority_state(tx, auth).await?;
    authorise_in_verified_state(tx, auth, &verified, Some(scope), Capability::Steward).await?;
    let scope_text = scope.to_string();
    let now = now_unix();
    let mut rows = Vec::with_capacity(members.len());
    for member in members {
        let best = match authorise_subject_in_verified_state(
            tx,
            auth,
            &verified,
            member,
            Some(scope),
            Capability::Read,
        )
        .await
        {
            Ok(found) => Some(found),
            Err(AuthorityError::NotAuthorised | AuthorityError::QuorumNotMet { .. }) => None,
            Err(other) => return Err(other),
        };
        let direct = verified
            .state
            .grants
            .iter()
            .filter(|g| {
                g.subject_id == *member
                    && g.scope_id.as_deref() == Some(scope_text.as_str())
                    && g.capability != Capability::Steward
                    && !g.is_genesis
                    && !verified.state.revoked_by(&g.id, now)
                    && (g.expires_at_unix == 0 || g.expires_at_unix > now)
            })
            .map(|g| (g.id.clone(), g.capability))
            .collect();
        rows.push(AccessRow {
            account: member.clone(),
            inherited: best
                .as_ref()
                .is_some_and(|b| b.scope.as_deref() != Some(scope_text.as_str())),
            capability: best.map(|b| b.capability),
            direct,
        });
    }
    Ok(rows)
}

/// The Share panel hands out `read` and `draw` only; `steward` has a quorum and
/// its own flow.
pub fn is_shareable(capability: Capability) -> bool {
    capability != Capability::Steward
}

/// The message to sign to revoke one `read`/`draw` grant made exactly at `scope`.
/// Refuses anything else, so this route cannot be pointed at a steward's grant.
pub async fn revoke_bytes_for_share(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    scope: ScopeId,
    grant_id: &str,
    at_unix: i64,
) -> Result<Vec<u8>, AuthorityError> {
    let grant = shareable_grant_at(tx, auth, scope, grant_id).await?;
    Ok(authority::revoke_bytes(
        &auth.organisation(),
        &grant.id,
        &grant_bytes_of(tx, auth.ring, &grant).await?,
        at_unix,
    ))
}

/// [`revoke_grant`], limited to a `read`/`draw` grant made exactly at `scope`.
pub async fn revoke_shared_grant(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    scope: ScopeId,
    grant_id: &str,
    signature: &[u8],
    at_unix: i64,
) -> Result<(), AuthorityError> {
    shareable_grant_at(tx, auth, scope, grant_id).await?;
    revoke_grant(tx, auth, grant_id, signature, at_unix).await
}

async fn shareable_grant_at(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    scope: ScopeId,
    grant_id: &str,
) -> Result<Grant, AuthorityError> {
    authorise_account(tx, auth, Some(scope), Capability::Steward).await?;
    let grant = read_grant(tx, grant_id)
        .await?
        .ok_or(AuthorityError::NotAuthorised)?;
    if grant.organisation_id != auth.organisation()
        || grant.scope_id.as_deref() != Some(scope.to_string().as_str())
        || !is_shareable(grant.capability)
        || grant.is_genesis
    {
        return Err(AuthorityError::NotAuthorised);
    }
    // Already revoked: a second revocation row would be refused by its key.
    if read_authority_state(tx, &auth.organisation())
        .await?
        .revoked_by(&grant.id, i64::MAX)
    {
        return Err(AuthorityError::NotAuthorised);
    }
    Ok(grant)
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
    advance_head_as(
        tx,
        ring,
        &ctx.tenant().to_string(),
        &ctx.actor().to_string(),
        tenant_key,
    )
    .await
}

/// The half of [`advance_head`] taking the organisation and actor directly, for
/// §1.1's operator suspend verb (an operator is never a member, `0004`, so has no
/// tenant context).
///
/// **The head MUST advance for every act that changes authority state**,
/// operator acts included: §3.4 step 4 recomputes the digest over the whole state
/// and refuses the organisation if it disagrees with the head. Skipping it would
/// make every authorisation in that organisation an integrity alarm.
pub(crate) async fn advance_head_as(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
    actor: &str,
    tenant_key: &DataKey,
) -> Result<i32, AuthorityError> {
    let organisation = organisation.to_string();
    let epoch = next_epoch(tx, &organisation).await?;
    let state = read_authority_state(tx, &organisation).await?;
    let live = state.digest_entries(&row_key_for(ring, &organisation));
    let digest = authority::live_digest(
        &row_key_for(ring, &organisation),
        &organisation,
        epoch,
        &live,
    );

    let appended = chains::append_org_as(
        tx,
        ring,
        &organisation,
        actor,
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

/// The **whole authority state** of one organisation, read once per act.
///
/// The head covers every seconding, suspension and revocation as well as live
/// grants. Every verdict is computed from this one read, so two checks in one
/// authorisation cannot disagree about what the database said.
struct AuthorityState {
    organisation: String,
    grants: Vec<Grant>,
    secondings: Vec<Seconding>,
    /// Ordered by `seq` ascending — the append-only history, not a snapshot.
    suspensions: Vec<Suspension>,
    revocations: Vec<Revocation>,
}

/// One seconding, as stored (§3.5).
#[derive(Clone, Debug)]
struct Seconding {
    id: String,
    grant_id: String,
    seconded_by: String,
    seconder_key_fpr: [u8; 32],
    seconder_sig: Vec<u8>,
    chain_seq: i64,
    seconded_at_unix: i64,
    row_seal: Vec<u8>,
}

/// One suspension or its lifting, as stored.
#[derive(Clone, Debug)]
struct Suspension {
    grant_id: String,
    action: String,
    actor_kind: String,
    actor_id: String,
    at_unix: i64,
    takes_effect_unix: i64,
    chain_seq: i64,
    row_seal: Vec<u8>,
}

/// One revocation, as stored.
#[derive(Clone, Debug)]
struct Revocation {
    grant_id: String,
    revoked_by: String,
    revoker_key_fpr: [u8; 32],
    revoked_sig: Vec<u8>,
    revoked_at_unix: i64,
    takes_effect_unix: i64,
    chain_seq: i64,
    row_seal: Vec<u8>,
}

fn seconding_row_state(s: &Seconding) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("grant_id".to_string(), Json::Str(s.grant_id.clone()));
    map.insert("seconded_by".to_string(), Json::Str(s.seconded_by.clone()));
    map.insert(
        "seconder_key_fpr".to_string(),
        Json::Str(hex(&s.seconder_key_fpr)),
    );
    map.insert("seconder_sig".to_string(), Json::Str(hex(&s.seconder_sig)));
    Json::Obj(map).to_canonical_bytes()
}

fn suspension_row_state(s: &Suspension) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("action".to_string(), Json::Str(s.action.clone()));
    map.insert("actor_id".to_string(), Json::Str(s.actor_id.clone()));
    map.insert("actor_kind".to_string(), Json::Str(s.actor_kind.clone()));
    map.insert("at".to_string(), Json::Int(s.at_unix));
    map.insert("grant_id".to_string(), Json::Str(s.grant_id.clone()));
    map.insert(
        "takes_effect_at".to_string(),
        Json::Int(s.takes_effect_unix),
    );
    Json::Obj(map).to_canonical_bytes()
}

fn revocation_row_state(r: &Revocation) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("grant_id".to_string(), Json::Str(r.grant_id.clone()));
    map.insert("revoked_at".to_string(), Json::Int(r.revoked_at_unix));
    map.insert("revoked_by".to_string(), Json::Str(r.revoked_by.clone()));
    map.insert("revoked_sig".to_string(), Json::Str(hex(&r.revoked_sig)));
    map.insert(
        "revoker_key_fpr".to_string(),
        Json::Str(hex(&r.revoker_key_fpr)),
    );
    map.insert(
        "takes_effect_at".to_string(),
        Json::Int(r.takes_effect_unix),
    );
    Json::Obj(map).to_canonical_bytes()
}

/// Read every authority row for one organisation.
async fn read_authority_state(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<AuthorityState, AuthorityError> {
    let grants = read_grants_of(tx, organisation).await?;

    let mut secondings = Vec::new();
    for row in tx
        .query(
            "SELECT id, grant_id, seconded_by, seconder_key_fpr, seconder_sig, chain_seq, \
                    EXTRACT(EPOCH FROM seconded_at)::bigint, row_seal \
               FROM grant_secondings WHERE organisation_id = $1 ORDER BY id",
            &[&organisation],
        )
        .await?
    {
        let fpr: Vec<u8> = row.get(3);
        secondings.push(Seconding {
            id: row.get(0),
            grant_id: row.get(1),
            seconded_by: row.get(2),
            seconder_key_fpr: as_32(&fpr, "seconder key fingerprint")?,
            seconder_sig: row.get(4),
            chain_seq: row.get(5),
            seconded_at_unix: row.get(6),
            row_seal: row.get(7),
        });
    }

    let mut suspensions = Vec::new();
    for row in tx
        .query(
            // ORDER BY the identity column, so "the latest suspension" does not
            // depend on a clock anybody can set. `seq` is not carried on the
            // struct: the row's identity inside its seal is the chain sequence.
            "SELECT grant_id, action, actor_kind, actor_id, \
                    EXTRACT(EPOCH FROM at)::bigint, \
                    EXTRACT(EPOCH FROM takes_effect_at)::bigint, chain_seq, row_seal \
               FROM grant_suspensions WHERE organisation_id = $1 ORDER BY seq",
            &[&organisation],
        )
        .await?
    {
        suspensions.push(Suspension {
            grant_id: row.get(0),
            action: row.get(1),
            actor_kind: row.get(2),
            actor_id: row.get(3),
            at_unix: row.get(4),
            takes_effect_unix: row.get(5),
            chain_seq: row.get(6),
            row_seal: row.get(7),
        });
    }

    let mut revocations = Vec::new();
    for row in tx
        .query(
            "SELECT grant_id, revoked_by, revoker_key_fpr, revoked_sig, \
                    EXTRACT(EPOCH FROM revoked_at)::bigint, \
                    EXTRACT(EPOCH FROM takes_effect_at)::bigint, chain_seq, row_seal \
               FROM grant_revocations WHERE organisation_id = $1 ORDER BY grant_id",
            &[&organisation],
        )
        .await?
    {
        let fpr: Vec<u8> = row.get(2);
        revocations.push(Revocation {
            grant_id: row.get(0),
            revoked_by: row.get(1),
            revoker_key_fpr: as_32(&fpr, "revoker key fingerprint")?,
            revoked_sig: row.get(3),
            revoked_at_unix: row.get(4),
            takes_effect_unix: row.get(5),
            chain_seq: row.get(6),
            row_seal: row.get(7),
        });
    }

    Ok(AuthorityState {
        organisation: organisation.to_string(),
        grants,
        secondings,
        suspensions,
        revocations,
    })
}

impl AuthorityState {
    /// Every row the head's digest covers, keyed `"<table>/<row identity>"` and
    /// carrying its **recomputed** seal.
    ///
    /// The digest uses recomputed seals, never stored ones: a head built from
    /// stored seals would carry an edited row's own lie forward. The stored seal
    /// is compared separately at use (see [`AuthorityState::verify_stored_seals`]);
    /// the two checks catch different things.
    ///
    /// **Grants with a revocation row drop out of the grant portion** and their
    /// revocation row is in the set instead, so deleting a revocation changes the
    /// digest twice over. Whether a revocation has *taken effect* is a question
    /// for use, not the digest: folding time in would require resealing the head
    /// as clocks pass, which nothing triggers, so every authorisation would fail.
    fn digest_entries(&self, row_key: &Key32) -> Vec<(String, [u8; 32])> {
        let revoked: BTreeSet<&str> = self
            .revocations
            .iter()
            .map(|r| r.grant_id.as_str())
            .collect();

        let mut entries = Vec::new();
        for grant in &self.grants {
            if revoked.contains(grant.id.as_str()) {
                continue;
            }
            entries.push((
                format!("scope_grants/{}", grant.id),
                authority::row_seal(
                    row_key,
                    &RowFacts {
                        table: "scope_grants",
                        row_id: &grant.id,
                        chain_seq: grant.chain_seq,
                        row_version: grant.row_version,
                        row_state: &grant_row_state(grant),
                    },
                ),
            ));
        }
        for s in &self.secondings {
            entries.push((
                format!("grant_secondings/{}", s.id),
                authority::row_seal(
                    row_key,
                    &RowFacts {
                        table: "grant_secondings",
                        row_id: &s.id,
                        chain_seq: s.chain_seq,
                        row_version: 1,
                        row_state: &seconding_row_state(s),
                    },
                ),
            ));
        }
        for s in &self.suspensions {
            // The seal names the grant and the chain sequence (`seq` is
            // database-assigned; the chain sequence is unique per organisation
            // chain). The digest key is zero-padded so string and numeric
            // ordering agree.
            entries.push((
                format!("grant_suspensions/{:020}", s.chain_seq),
                authority::row_seal(
                    row_key,
                    &RowFacts {
                        table: "grant_suspensions",
                        row_id: &s.grant_id,
                        chain_seq: s.chain_seq,
                        row_version: 1,
                        row_state: &suspension_row_state(s),
                    },
                ),
            ));
        }
        for r in &self.revocations {
            entries.push((
                format!("grant_revocations/{}", r.grant_id),
                authority::row_seal(
                    row_key,
                    &RowFacts {
                        table: "grant_revocations",
                        row_id: &r.grant_id,
                        chain_seq: r.chain_seq,
                        row_version: 1,
                        row_state: &revocation_row_state(r),
                    },
                ),
            ));
        }
        entries
    }

    /// Every authority row's **stored** seal recomputes.
    ///
    /// [`AuthorityState::digest_entries`] puts the *recomputed* seal in the head's
    /// digest, which catches an edited row. A row with a forged stored seal and
    /// untouched content yields the same recomputed seal and passes the digest
    /// comparison, so the stored seal must be compared too.
    ///
    /// Across the whole state, not only the rows an answer rests on: the head
    /// speaks for the whole authority, and a store lying about one row is not one
    /// to take a permission from. §3.4's posture: `Unverifiable`, never "no grants
    /// found".
    fn verify_stored_seals(&self, row_key: &Key32) -> Result<(), AuthorityError> {
        let check = |stored: &[u8], facts: &RowFacts<'_>, what: &'static str| {
            if stored != authority::row_seal(row_key, facts) {
                Err(AuthorityError::Unverifiable(what))
            } else {
                Ok(())
            }
        };

        for g in &self.grants {
            check(
                &g.row_seal,
                &RowFacts {
                    table: "scope_grants",
                    row_id: &g.id,
                    chain_seq: g.chain_seq,
                    row_version: g.row_version,
                    row_state: &grant_row_state(g),
                },
                "grant row seal",
            )?;
        }
        for s in &self.secondings {
            check(
                &s.row_seal,
                &RowFacts {
                    table: "grant_secondings",
                    row_id: &s.id,
                    chain_seq: s.chain_seq,
                    row_version: 1,
                    row_state: &seconding_row_state(s),
                },
                "grant seconding row seal",
            )?;
        }
        for s in &self.suspensions {
            check(
                &s.row_seal,
                &RowFacts {
                    table: "grant_suspensions",
                    row_id: &s.grant_id,
                    chain_seq: s.chain_seq,
                    row_version: 1,
                    row_state: &suspension_row_state(s),
                },
                "grant suspension row seal",
            )?;
        }
        for r in &self.revocations {
            check(
                &r.row_seal,
                &RowFacts {
                    table: "grant_revocations",
                    row_id: &r.grant_id,
                    chain_seq: r.chain_seq,
                    row_version: 1,
                    row_state: &revocation_row_state(r),
                },
                "grant revocation row seal",
            )?;
        }
        Ok(())
    }

    /// Whether a revocation has taken effect against this grant by `at_unix`.
    ///
    /// §3.5, as amended: a single-steward weakening act waits out the
    /// sole-appointment delay, so a revocation row existing and taking effect are
    /// two different moments.
    fn revoked_by(&self, grant_id: &str, at_unix: i64) -> bool {
        self.revocations
            .iter()
            .any(|r| r.grant_id == grant_id && r.takes_effect_unix <= at_unix)
    }

    /// As [`AuthorityState::revoked_by`], counting only revocations written by
    /// chain position `as_of_seq`: the historical question a seconding asks about
    /// its seconder.
    fn revoked_as_of(&self, grant_id: &str, at_unix: i64, as_of_seq: i64) -> bool {
        self.revocations.iter().any(|r| {
            r.grant_id == grant_id && r.takes_effect_unix <= at_unix && r.chain_seq <= as_of_seq
        })
    }

    /// Whether this grant stands suspended at `at_unix`, counting only
    /// suspension rows that have taken effect and were written by `as_of_seq`.
    fn suspended_at(&self, grant_id: &str, at_unix: i64, as_of_seq: i64) -> bool {
        self.suspensions
            .iter()
            .rfind(|s| {
                s.grant_id == grant_id && s.takes_effect_unix <= at_unix && s.chain_seq <= as_of_seq
            })
            .map(|s| s.action == "suspend")
            .unwrap_or(false)
    }

    /// Is any single-steward weakening act still inside its delay?
    ///
    /// §3.5: the sole-steward path cannot be taken while one is pending.
    /// Otherwise one steward suspends the other, waits for the count to fall to
    /// one, and appoints a third alone.
    fn a_weakening_act_is_pending(&self, at_unix: i64) -> bool {
        self.revocations
            .iter()
            .any(|r| r.takes_effect_unix > at_unix)
            || self
                .suspensions
                .iter()
                .any(|s| s.action == "suspend" && s.takes_effect_unix > at_unix)
    }

    /// §3.5's `min(2, live distinct stewards)`: the count.
    ///
    /// **Expired grants do not count.** `0011` requires every steward grant to
    /// expire. Counting lapsed ones would leave an organisation whose co-steward
    /// lapsed with one steward who is not sole and can never appoint anyone: a
    /// permanent deadlock.
    ///
    /// **Suspended grants DO count.** A suspension is reversible by any steward,
    /// so treating a suspended steward as absent would let one steward suspend the
    /// other, become "sole", appoint a third alone and lift the suspension: a
    /// steward manufactured from one signature. Suspension stops a steward acting;
    /// it does not remove them from the count that decides whether a second
    /// signature is required.
    fn steward_count(&self, at_unix: i64) -> usize {
        let mut subjects = BTreeSet::new();
        for grant in &self.grants {
            if grant.capability != Capability::Steward {
                continue;
            }
            if self.revoked_by(&grant.id, at_unix) {
                continue;
            }
            if grant.effective_from_unix > at_unix {
                continue;
            }
            if grant.expires_at_unix != 0 && grant.expires_at_unix <= at_unix {
                continue;
            }
            subjects.insert(grant.subject_id.clone());
        }
        subjects.len()
    }
}

// ---------------------------------------------------------------------------
// Reading grants back
// ---------------------------------------------------------------------------

fn parse_scope(id: &str) -> Result<ScopeId, AuthorityError> {
    id.parse().map_err(|_| AuthorityError::Corrupt("scope id"))
}

/// The column list every grant read uses, so that one read cannot drift from
/// another and produce a different `grant_row_state` for the same row.
const GRANT_COLUMNS: &str =
    "id, organisation_id, scope_id, subject_id, subject_key_fpr, capability, \
     granted_by, granter_key_fpr, granter_sig, is_genesis, is_recovery, \
     sole_steward_appointment, auth_epoch, \
     EXTRACT(EPOCH FROM effective_from)::bigint, \
     COALESCE(EXTRACT(EPOCH FROM expires_at)::bigint, 0), \
     chain_seq, row_version, row_seal";

fn grant_from_row(row: &tokio_postgres::Row) -> Result<Grant, AuthorityError> {
    let subject_fpr: Vec<u8> = row.get(4);
    let granter_fpr: Vec<u8> = row.get(7);
    let capability: String = row.get(5);
    Ok(Grant {
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
    })
}

async fn read_grant(tx: &Transaction<'_>, id: &str) -> Result<Option<Grant>, AuthorityError> {
    let row = tx
        .query_opt(
            &format!("SELECT {GRANT_COLUMNS} FROM scope_grants WHERE id = $1"),
            &[&id],
        )
        .await?;
    match row {
        Some(row) => Ok(Some(grant_from_row(&row)?)),
        None => Ok(None),
    }
}

async fn read_grants_of(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<Vec<Grant>, AuthorityError> {
    let rows = tx
        .query(
            &format!(
                "SELECT {GRANT_COLUMNS} FROM scope_grants \
                  WHERE organisation_id = $1 ORDER BY id"
            ),
            &[&organisation],
        )
        .await?;
    rows.iter().map(grant_from_row).collect()
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

/// Check that the organisation's `is_genesis` rows are exactly the ones its
/// sealed `org_genesis` chain entry names (§6.1).
///
/// # Why a chain entry, not a constraint
///
/// A `CHECK` cannot read another table, so no constraint can say "there is no
/// genesis after creation". It can only say what a genesis row looks like, and an
/// attacker writing one picks `auth_epoch = 1` freely. (`0012`'s
/// `CHECK (NOT is_genesis OR auth_epoch = 1)` is belt-and-braces, not the fence.
/// `0011`'s trigger refused nothing: under `SECURITY DEFINER` plus `FORCE ROW
/// LEVEL SECURITY` and no tenant context, its `EXISTS` was false in exactly the
/// session a second genesis would be written from.)
///
/// The fence is this function, resting on the chain. `bootstrap_organisation`
/// mints each genesis grant's id, names it in the `org_genesis` entry with its
/// subject and subject key fingerprint, and seals that entry before writing any
/// grant row. A later genesis row is not in the list and cannot be added: the
/// entry was sealed first, and re-sealing needs the organisation content key. So
/// a late genesis grant is **unusable**, not merely late.
///
/// **It is not unconstructible at the SQL level.** The row inserts; it just
/// authorises nobody.
async fn verify_genesis_set(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    state: &AuthorityState,
) -> Result<(), AuthorityError> {
    let metadata = chains::read_org_entry_metadata(tx, ring, ctx, EntryType::OrgGenesis)
        .await?
        .ok_or(AuthorityError::Unverifiable("org_genesis chain entry"))?;
    let parsed = Json::parse_canonical(&metadata)
        .map_err(|_| AuthorityError::Corrupt("org_genesis metadata"))?;
    let Json::Obj(map) = parsed else {
        return Err(AuthorityError::Corrupt("org_genesis metadata"));
    };
    let Some(Json::Arr(named)) = map.get("genesis_grants") else {
        return Err(AuthorityError::Corrupt("org_genesis metadata"));
    };

    // What the sealed entry says genesis was: (grant id, subject, subject fpr).
    let mut sealed: BTreeSet<(String, String, String)> = BTreeSet::new();
    for item in named {
        let Json::Obj(fields) = item else {
            return Err(AuthorityError::Corrupt("org_genesis metadata"));
        };
        let get = |k: &str| match fields.get(k) {
            Some(Json::Str(s)) => Ok(s.clone()),
            _ => Err(AuthorityError::Corrupt("org_genesis metadata")),
        };
        sealed.insert((get("grant")?, get("subject")?, get("subject_key_fpr")?));
    }

    // What the tables say it is now.
    let found: BTreeSet<(String, String, String)> = state
        .grants
        .iter()
        .filter(|g| g.is_genesis)
        .map(|g| (g.id.clone(), g.subject_id.clone(), hex(&g.subject_key_fpr)))
        .collect();

    // Missing, extra, or a different subject -- all three are the same answer.
    if sealed != found {
        return Err(AuthorityError::GenesisSetMismatch);
    }
    Ok(())
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
        sole_steward_appointment: grant.sole_steward_appointment,
        auth_epoch: grant.auth_epoch,
    }))
}

// ---------------------------------------------------------------------------
// §3.4 — the seven steps
// ---------------------------------------------------------------------------

/// The scope ids a grant may sit at and still cover `scope`: the scope itself,
/// every ancestor, and `None` — the organisation, which is above everything.
async fn covering_scopes(
    tx: &Transaction<'_>,
    organisation: &str,
    scope: Option<&str>,
) -> Result<BTreeSet<Option<String>>, AuthorityError> {
    let mut covering: BTreeSet<Option<String>> = BTreeSet::new();
    covering.insert(None);
    if let Some(scope) = scope {
        let row = tx
            .query_opt(
                "SELECT path FROM scopes WHERE id = $1 AND organisation_id = $2",
                &[&scope, &organisation],
            )
            .await?
            .ok_or(AuthorityError::NotAuthorised)?;
        let path: String = row.get(0);
        for ancestor in path.split('.') {
            covering.insert(Some(ancestor.to_string()));
        }
    }
    Ok(covering)
}

/// Verify one grant **row**: its own seal, both key bindings, and the
/// granter's signature over recomputed bytes. No liveness, no clock, no
/// quorum — those are separate questions asked by separate callers.
async fn verify_grant_row(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    root_fpr: &[u8; 32],
    grant: &Grant,
) -> Result<(), AuthorityError> {
    let organisation = grant.organisation_id.clone();

    let recomputed = authority::row_seal(
        &row_key_for(ring, &organisation),
        &RowFacts {
            table: "scope_grants",
            row_id: &grant.id,
            chain_seq: grant.chain_seq,
            row_version: grant.row_version,
            row_state: &grant_row_state(grant),
        },
    );
    if grant.row_seal != recomputed {
        return Err(AuthorityError::Unverifiable("grant row seal"));
    }

    // The subject's key, resolved as of the grant's `effective_from` (§3.3; the
    // keyring row seal is verified inside `key_by_fingerprint`), and bound to the
    // row's subject.
    let subject_key =
        key_by_fingerprint(tx, ring, &grant.subject_key_fpr, grant.effective_from_unix).await?;
    if subject_key.account_id != grant.subject_id {
        return Err(AuthorityError::Unverifiable("subject key binding"));
    }

    let message = authority::grant_bytes(&GrantFacts {
        organisation: &organisation,
        root_pubkey_fpr: root_fpr,
        scope: grant.scope_id.as_deref().unwrap_or(""),
        subject: &grant.subject_id,
        subject_key_fpr: &grant.subject_key_fpr,
        capability: grant.capability,
        granter: grant.granted_by.as_deref(),
        granter_key_fpr: &grant.granter_key_fpr,
        effective_from_unix: grant.effective_from_unix,
        expires_at_unix: grant.expires_at_unix,
        // v2: the flag is inside the signature, so an edited flag fails the
        // granter's signature as well as the row seal.
        sole_steward_appointment: grant.sole_steward_appointment,
        auth_epoch: grant.auth_epoch,
    });

    let granter_public_key = match &grant.granted_by {
        Some(granter_id) => {
            let key =
                key_by_fingerprint(tx, ring, &grant.granter_key_fpr, grant.effective_from_unix)
                    .await?;
            // **The granter's key must belong to the granter's account** (§3.3's
            // subject-side binding, applied here too). Otherwise a row naming
            // account A as granter with B's fingerprint verifies under B's key,
            // reading in the audit trail as A's act when B signed it.
            if key.account_id != *granter_id {
                return Err(AuthorityError::Unverifiable("granter key binding"));
            }
            key.public_key
        }
        None => {
            // Root-signed (genesis or recovery). The row's fingerprint must be the
            // root's own, or the signature would be checked against whatever key
            // the keyring holds.
            if grant.granter_key_fpr != *root_fpr {
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
    Ok(())
}

/// Does this grant carry the signatures §3.5 requires of it?
///
/// **Quorum is met when at least one QUALIFYING seconding exists.** A
/// qualifying seconding has a stored seal that recomputes, a signature over
/// `second_bytes` that verifies under the key in service when it was made, a
/// seconder who is neither granter nor subject, and a seconder who held a
/// verified live `steward` grant covering this grant's scope **at the
/// seconding's own chain position**, not now. A seconder revoked afterwards
/// still seconded; one who never held stewardship never did.
///
/// # A non-qualifying seconding is NOT COUNTED, and is not an alarm
///
/// Anybody holding `steward` can second any grant. If one bad seconding failed
/// the grant it was attached to, one steward could brick another's stewardship
/// permanently. Not counting it loses nothing: a forged seal is caught for the
/// whole organisation by [`AuthorityState::verify_stored_seals`], which runs at
/// every use. What remains is a question about one signature's standing.
///
/// # The cycle, and why the recursion terminates
///
/// Step 4 recurses: the seconder's own steward grant may itself need seconding.
/// A grant may be seconded long after it was written, so chain positions do not
/// strictly descend, and `A seconds B` plus `B seconds A` is constructible. A
/// depth limit would turn a cycle into a permanent
/// [`AuthorityError::Unverifiable`] for everyone in it (a seconding cannot be
/// withdrawn) and refuse an ordinary long appointment chain.
///
/// Instead [`QuorumPass::on_path`] holds the grant ids on the current path, so
/// **every path is simple**: a seconder whose stewardship depends transitively
/// on the grant under evaluation does not qualify. [`QuorumPass::settled`]
/// memoises each grant's answer, so **every grant is evaluated once** per pass.
/// Cost is linear in grants plus secondings.
fn grant_quorum_met<'a>(
    tx: &'a Transaction<'a>,
    ring: &'a KeyRing,
    state: &'a AuthorityState,
    root_fpr: &'a [u8; 32],
    grant: &'a Grant,
    pass: &'a Mutex<QuorumPass>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, AuthorityError>> + Send + 'a>>
{
    Box::pin(async move {
        // §3.5: genesis and recovery grants are root-signed with their own
        // controls; a sole-steward appointment answers an unmeetable quorum and
        // pays with the delay. All three are covered by the granter's signature
        // (`is_genesis`/`is_recovery` via the row seal, the sole flag via
        // `grant_bytes` since `fathom/grant/v2`).
        if grant.capability != Capability::Steward
            || grant.is_genesis
            || grant.is_recovery
            || grant.sole_steward_appointment
        {
            return Ok(true);
        }
        let settled = pass.lock().expect(POISON).settled.get(&grant.id).copied();
        if let Some(settled) = settled {
            return Ok(settled);
        }
        if !pass.lock().expect(POISON).on_path.insert(grant.id.clone()) {
            // Already under evaluation further up this path. **Not memoised**:
            // it is an answer about this path, not this grant.
            return Ok(false);
        }

        let met = a_qualifying_seconding_exists(tx, ring, state, root_fpr, grant, pass).await;

        pass.lock().expect(POISON).on_path.remove(&grant.id);
        let met = met?;
        pass.lock()
            .expect(POISON)
            .settled
            .insert(grant.id.clone(), met);
        Ok(met)
    })
}

/// What a poisoned pass lock would mean, said once.
///
/// It cannot happen: the mutex is created inside one authorisation, locked only
/// for one map operation with no `await` held, and nothing in those sections can
/// panic. `expect` rather than `unwrap` so the message names the lock.
const POISON: &str = "the quorum pass lock is never held across an await and never poisoned";

/// One pass's working memory: the path being walked, and what it has settled.
///
/// **A `Mutex`, not a `RefCell`,** because `&RefCell<T>` is not `Send`: held
/// across an `await` it yields a future axum will not accept, so no route could
/// ever authorise anybody. The lock is taken for one map operation at a time and
/// never across an `await`.
///
/// **Created inside one authorisation and dropped with it.** §3.4 permits a memo
/// "of the live set within a use" and forbids a stored verdict; this is the
/// first and cannot become the second. It lives on the stack, holds only values
/// derived from rows read in the same transaction, and no second use can see it,
/// so `no_verdict_is_cached_between_two_uses_in_one_process` is unaffected.
#[derive(Default)]
struct QuorumPass {
    /// The grant ids on the path currently under evaluation. What makes every
    /// path simple, and therefore what makes the walk terminate.
    on_path: BTreeSet<String>,
    /// Grant id → does this grant carry the signatures §3.5 requires.
    settled: BTreeMap<String, bool>,
    /// Grant id → did [`verify_grant_row`] accept it, in the soft sense this walk
    /// asks (a non-verifying grant is not a steward's; it is not an alarm raised
    /// inside somebody else's authorisation).
    rows: BTreeMap<String, bool>,
}

/// A refusal that makes a seconding or supporting grant **not count**, rather
/// than making the store untrustworthy.
///
/// `Unverifiable` and `Signature` mean *this row does not say what it claims*:
/// an alarm for the grant an answer is being given for, but for some other
/// account's grant several steps away, just a row that supports nothing.
/// `NoSigningKey` (a fingerprint resolving to no live keyring entry) is the same
/// kind of answer. A database error, a corrupt column or a rollback propagates.
fn is_a_disqualification(error: &AuthorityError) -> bool {
    matches!(
        error,
        AuthorityError::Unverifiable(_)
            | AuthorityError::Signature(_)
            | AuthorityError::NoSigningKey
    )
}

async fn a_qualifying_seconding_exists<'a>(
    tx: &'a Transaction<'a>,
    ring: &'a KeyRing,
    state: &'a AuthorityState,
    root_fpr: &'a [u8; 32],
    grant: &'a Grant,
    pass: &'a Mutex<QuorumPass>,
) -> Result<bool, AuthorityError> {
    let grant_bytes = grant_bytes_of(tx, ring, grant).await?;
    let covering = covering_scopes(tx, &state.organisation, grant.scope_id.as_deref()).await?;

    for seconding in state.secondings.iter().filter(|s| s.grant_id == grant.id) {
        let qualifies = seconding_qualifies(
            tx,
            ring,
            state,
            root_fpr,
            grant,
            &grant_bytes,
            &covering,
            seconding,
            pass,
        )
        .await?;
        if qualifies {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Everything one seconding has to be before it counts towards §3.5's quorum.
#[allow(clippy::too_many_arguments)]
async fn seconding_qualifies<'a>(
    tx: &'a Transaction<'a>,
    ring: &'a KeyRing,
    state: &'a AuthorityState,
    root_fpr: &'a [u8; 32],
    grant: &'a Grant,
    grant_bytes: &[u8],
    covering: &BTreeSet<Option<String>>,
    seconding: &Seconding,
    pass: &'a Mutex<QuorumPass>,
) -> Result<bool, AuthorityError> {
    // 1. The stored seal. The head's digest carries the RECOMPUTED seal, so a
    //    forged stored seal passes the head and `verify_stored_seals` refuses the
    //    organisation over it. Here it only stops the row counting.
    let recomputed = authority::row_seal(
        &row_key_for(ring, &state.organisation),
        &RowFacts {
            table: "grant_secondings",
            row_id: &seconding.id,
            chain_seq: seconding.chain_seq,
            row_version: 1,
            row_state: &seconding_row_state(seconding),
        },
    );
    if seconding.row_seal != recomputed {
        return Ok(false);
    }

    // 2. Neither the granter nor the subject. `0011` binds this with a foreign
    //    key and a `CHECK`; it is restated because a rule stated only by a
    //    constraint disappears when the constraint is relaxed.
    if Some(&seconding.seconded_by) == grant.granted_by.as_ref()
        || seconding.seconded_by == grant.subject_id
    {
        return Ok(false);
    }

    // 3. The signature, under the key that was in service when the seconding
    //    was made.
    let key = match key_by_fingerprint(
        tx,
        ring,
        &seconding.seconder_key_fpr,
        seconding.seconded_at_unix,
    )
    .await
    {
        Ok(key) => key,
        Err(e) if is_a_disqualification(&e) => return Ok(false),
        Err(e) => return Err(e),
    };
    if key.account_id != seconding.seconded_by {
        return Ok(false);
    }
    let message = authority::second_bytes(grant_bytes, &grant.granter_key_fpr);
    if authority::verify_es256(&key.public_key, &message, &seconding.seconder_sig).is_err() {
        return Ok(false);
    }

    // 4. And the seconder actually held stewardship, then, there.
    steward_held_at(
        tx,
        ring,
        state,
        root_fpr,
        &seconding.seconded_by,
        covering,
        seconding.seconded_at_unix,
        seconding.chain_seq,
        pass,
    )
    .await
}

/// Did `account` hold a fully verified, live `steward` grant covering one of
/// `covering`, at `at_unix` and as of chain position `as_of_seq`?
///
/// A grant failing [`verify_grant_row`] is passed over, not raised: this is about
/// somebody else's grant, asked inside a third party's authorisation, and the
/// whole-state seal check is what refuses a lying store. Memoised per pass, so
/// each grant is verified once.
#[allow(clippy::too_many_arguments)]
async fn steward_held_at<'a>(
    tx: &'a Transaction<'a>,
    ring: &'a KeyRing,
    state: &'a AuthorityState,
    root_fpr: &'a [u8; 32],
    account: &str,
    covering: &BTreeSet<Option<String>>,
    at_unix: i64,
    as_of_seq: i64,
    pass: &'a Mutex<QuorumPass>,
) -> Result<bool, AuthorityError> {
    for grant in &state.grants {
        if grant.subject_id != account || grant.capability != Capability::Steward {
            continue;
        }
        if !covering.contains(&grant.scope_id) {
            continue;
        }
        // It has to have existed, and been in force, at that moment.
        if grant.chain_seq > as_of_seq || grant.effective_from_unix > at_unix {
            continue;
        }
        if grant.expires_at_unix != 0 && grant.expires_at_unix <= at_unix {
            continue;
        }
        if state.revoked_as_of(&grant.id, at_unix, as_of_seq)
            || state.suspended_at(&grant.id, at_unix, as_of_seq)
        {
            continue;
        }
        if !row_verifies(tx, ring, root_fpr, grant, pass).await? {
            continue;
        }
        if grant_quorum_met(tx, ring, state, root_fpr, grant, pass).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// [`verify_grant_row`], memoised for one pass and soft on the refusals
/// [`is_a_disqualification`] names.
async fn row_verifies<'a>(
    tx: &'a Transaction<'a>,
    ring: &'a KeyRing,
    root_fpr: &'a [u8; 32],
    grant: &'a Grant,
    pass: &'a Mutex<QuorumPass>,
) -> Result<bool, AuthorityError> {
    let settled = pass.lock().expect(POISON).rows.get(&grant.id).copied();
    if let Some(settled) = settled {
        return Ok(settled);
    }
    let verdict = match verify_grant_row(tx, ring, root_fpr, grant).await {
        Ok(()) => true,
        Err(e) if is_a_disqualification(&e) => false,
        Err(e) => return Err(e),
    };
    pass.lock()
        .expect(POISON)
        .rows
        .insert(grant.id.clone(), verdict);
    Ok(verdict)
}

/// Steps 2-5 of [`authorise_account`]'s seven, done once: the head and its seal,
/// the rollback watch, the whole authority state digested against the head, and
/// the genesis set.
///
/// None of this depends on the scope or capability asked for, only the
/// organisation. A caller asking about many rows (a list route) calls this once
/// and [`authorise_in_verified_state`] per row, instead of re-reading the head,
/// re-digesting the state and re-verifying genesis per row. `authorise_account`
/// still does all seven steps every time, by calling both in sequence.
pub(crate) struct VerifiedAuthorityState {
    organisation: String,
    auth_epoch: i32,
    root_fpr: [u8; 32],
    state: AuthorityState,
}

/// Test-only instrumentation, always compiled (an integration test binary cannot
/// see `#[cfg(test)]` items in the library it links): how many times
/// [`verify_authority_state`] has run to completion for `organisation` in this
/// process.
///
/// Keyed by organisation so a test asserting "ran once" is not made flaky by
/// other tests authorising concurrently against their own organisations. Carries
/// no secret.
static VERIFY_AUTHORITY_STATE_CALLS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// See [`VERIFY_AUTHORITY_STATE_CALLS`].
pub fn verify_authority_state_calls(organisation: &str) -> u64 {
    VERIFY_AUTHORITY_STATE_CALLS
        .lock()
        .expect(POISON)
        .get(organisation)
        .copied()
        .unwrap_or(0)
}

/// §3.4 steps 2-5. See [`VerifiedAuthorityState`]'s doc for why this is its
/// own function rather than inline in [`authorise_account`].
pub(crate) async fn verify_authority_state(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
) -> Result<VerifiedAuthorityState, AuthorityError> {
    let (ring, ctx, watch) = (auth.ring, auth.ctx, auth.watch);
    let organisation = auth.organisation();

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
    let stored_live_count: i32 = head.get(2);
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

    // 4. The whole authority state as the database says it is now, and the digest
    //    over it. A disagreement with the head means a row was added, removed or
    //    edited since it was sealed: the hand-inserted grant, edited capability,
    //    deleted revocation, or a seconding nobody was entitled to make.
    let state = read_authority_state(tx, &organisation).await?;
    let entries = state.digest_entries(&row_key_for(ring, &organisation));
    let recomputed_digest = authority::live_digest(
        &row_key_for(ring, &organisation),
        &organisation,
        auth_epoch,
        &entries,
    );
    if stored_digest != recomputed_digest {
        return Err(AuthorityError::Unverifiable("authority state"));
    }
    // `live_count` is a second statement of the same fact; one nobody checks can
    // be false. §3.2 stores it and it must agree here.
    if stored_live_count as usize != entries.len() {
        return Err(AuthorityError::Unverifiable("authority head live_count"));
    }
    // Then the row-level check. The digest carries the RECOMPUTED seals, so
    // untouched content with a forged STORED seal passes it; this catches that.
    // Head first: it is the statement about the whole authority.
    state.verify_stored_seals(&row_key_for(ring, &organisation))?;

    // 5. The organisation id, recomputed from its root key, and the genesis
    //    set against what the chain says genesis was.
    let root_fpr = organisation_root_fpr(tx, ring, &organisation).await?;
    verify_genesis_set(tx, ring, ctx, &state).await?;

    *VERIFY_AUTHORITY_STATE_CALLS
        .lock()
        .expect(POISON)
        .entry(organisation.clone())
        .or_insert(0) += 1;

    Ok(VerifiedAuthorityState {
        organisation,
        auth_epoch,
        root_fpr,
        state,
    })
}

/// §3.4 steps 1, 6 and 7, against a [`VerifiedAuthorityState`] that steps 2-5
/// already settled. Scope- and capability-dependent, so a list route still runs
/// this once per row.
pub(crate) async fn authorise_in_verified_state(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    verified: &VerifiedAuthorityState,
    scope: Option<ScopeId>,
    needed: Capability,
) -> Result<Capabilities, AuthorityError> {
    authorise_subject_in_verified_state(tx, auth, verified, &auth.actor(), scope, needed).await
}

/// As [`authorise_in_verified_state`], for `account` rather than the caller. The
/// Share panel asks it of each member; the walk is the same one a request runs.
async fn authorise_subject_in_verified_state(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    verified: &VerifiedAuthorityState,
    account: &str,
    scope: Option<ScopeId>,
    needed: Capability,
) -> Result<Capabilities, AuthorityError> {
    let ring = auth.ring;
    let organisation = &verified.organisation;
    let auth_epoch = verified.auth_epoch;
    let root_fpr = &verified.root_fpr;
    let state = &verified.state;

    // 1. The scope and its ancestors. `None` is the organisation itself, which
    //    every grant in the organisation is at or above.
    let scope_text = scope.map(|s| s.to_string());
    let covering = covering_scopes(tx, organisation, scope_text.as_deref()).await?;

    // 6. The candidates.
    let now = now_unix();
    let mut best: Option<Capabilities> = None;
    // Whether any candidate was refused for want of a seconding, so the refusal
    // can say so. A missing quorum differs from holding no grant, and both are
    // permission answers, not integrity alarms.
    let mut short_of_quorum = false;
    for grant in &state.grants {
        if grant.subject_id != account {
            continue;
        }
        if !covering.contains(&grant.scope_id) {
            continue;
        }
        if !grant.capability.covers(needed) {
            continue;
        }
        // Revoked or suspended -- as of now, honouring the delay §3.5 puts on
        // a single-steward act. Not an error: another grant may cover it.
        if state.revoked_by(&grant.id, now) || state.suspended_at(&grant.id, now, i64::MAX) {
            continue;
        }
        if grant.effective_from_unix > now {
            continue;
        }
        // **Expiry, evaluated at use.** Every steward grant carries one (`0011`);
        // ignoring it here would let a lapsed grant keep working.
        if grant.expires_at_unix != 0 && grant.expires_at_unix <= now {
            continue;
        }

        // The row: a hard question, because the answer would rest on this grant;
        // `Unverifiable` is the alarm §3.4 asks for.
        verify_grant_row(tx, ring, root_fpr, grant).await?;
        // The quorum: a soft one. A `steward` grant with no qualifying seconding
        // is not a broken store, just not yet usable, so it is passed over and
        // another candidate may answer. Each candidate gets its own pass.
        let pass = Mutex::new(QuorumPass::default());
        if !grant_quorum_met(tx, ring, state, root_fpr, grant, &pass).await? {
            short_of_quorum = true;
            continue;
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

    match best {
        Some(capabilities) => Ok(capabilities),
        None if short_of_quorum => Err(AuthorityError::QuorumNotMet { needed: 2, have: 1 }),
        None => Err(AuthorityError::NotAuthorised),
    }
}

/// **Authorise, from scratch, every time** (§3.4).
///
/// 1. the scope's ancestors, so a grant above it counts;
/// 2. the head, and **its seal verified** — `Unverifiable`, never "no grants";
/// 3. the epoch against this process's high-water mark;
/// 4. the whole authority state, digested and compared against the head —
///    grants, secondings, suspensions and revocations, not grants alone;
/// 5. the organisation id recomputed from the root key, and the genesis set
///    compared against what the sealed `org_genesis` entry names;
/// 6. each candidate grant: its row seal, both key bindings, the granter's
///    signature over recomputed bytes, its times, and §3.5's quorum — which is
///    met by **one qualifying seconding**, walked with a visited set so that a
///    seconder whose own stewardship depends on the grant under evaluation
///    does not qualify;
/// 7. only then the answer.
///
/// Step 4 is why a hand-inserted grant grants nothing, why editing `capability`
/// on a real one grants nothing, why deleting a revocation row does not restore
/// the grant, and why a seconding nobody was entitled to make does not make a
/// steward (the digest covers the whole state).
///
/// Steps 2-5 live in [`verify_authority_state`] and steps 1, 6 and 7 in
/// [`authorise_in_verified_state`]; this is the two in sequence.
/// [`list_designs_handler`](crate::design_api) and
/// [`list_scopes_handler`](crate::design_api) call them separately (see
/// [`VerifiedAuthorityState`]).
///
/// # Nothing is cached
///
/// §3.4: no verdict is ever stored. Everything here is read inside the call and
/// recomputed from sealed rows, so tampering between two authorisations is
/// visible.
pub async fn authorise_account(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    scope: Option<ScopeId>,
    needed: Capability,
) -> Result<Capabilities, AuthorityError> {
    let verified = verify_authority_state(tx, auth).await?;
    authorise_in_verified_state(tx, auth, &verified, scope, needed).await
}

// ---------------------------------------------------------------------------
// ADR-0055 fix (S3)
// ---------------------------------------------------------------------------

/// **Retire the oldest live keys of one account until `cap` are left**, and say
/// which ones went.
///
/// `POST /credentials/key` had no cap, and [`verify_by_any_live_key`] walks the
/// whole live ring at every signed sign-in, verifying each row seal.
/// `credentials::LIVE_ACCOUNT_KEYS_MAX` carries the number and argument; this is
/// the eviction.
///
/// **Oldest by `enrolled_seq`**, the site chain's own order rather than a clock,
/// so two keys registered in one second still have an order.
///
/// # Why this is not [`retire_key`]
///
/// That is §8.4's verb: a signed act filed on the ORGANISATION chain as
/// `account_key_retired`. Neither half fits here. There is no signature (the
/// person registering an eleventh browser has already proved themselves to the
/// session), and a password-only account may belong to no organisation, so there
/// may be no org chain. **The record is the row itself**: `retired_at` is inside
/// `account_key_row_state`, so the retirement is under the row seal at the
/// next version and clearing it leaves an unverifiable row (as `0018` §D states for a
/// spent token). The site-chain record is the `authenticator_registered` entry of
/// the key that caused the eviction, appended in the same transaction by the
/// caller.
///
/// **No site-chain entry type exists for retiring an account key** (`0018` §F
/// files `account_key_retired` on an org chain only). Adding one means re-listing
/// `chain_entries_type_belongs_to_kind` in a migration, so it is not built; the
/// eviction is sealed either way.
pub async fn retire_oldest_over_cap(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    account: &str,
    cap: i64,
    at_unix: i64,
) -> Result<Vec<String>, AuthorityError> {
    let live = tx
        .query(
            "SELECT id FROM account_keys \
              WHERE account_id = $1 AND superseded_by IS NULL AND retired_at IS NULL \
              ORDER BY enrolled_seq ASC",
            &[&account],
        )
        .await?;
    let over = (live.len() as i64) - cap + 1;
    if over <= 0 {
        return Ok(Vec::new());
    }

    let row_key = site_row_key(tx, ring).await?;
    let mut retired = Vec::new();
    for row in live.into_iter().take(over as usize) {
        let id: String = row.get(0);
        let Some(key) = read_account_key(tx, &id).await? else {
            continue;
        };
        // The seal before the change, as every other path checks it: a ring with
        // one edited row is an incident, and evicting is not the moment to stop
        // noticing.
        let stored: Vec<u8> = tx
            .query_one("SELECT row_seal FROM account_keys WHERE id = $1", &[&id])
            .await?
            .get(0);
        let expected = authority::row_seal(
            &row_key,
            &RowFacts {
                table: "account_keys",
                row_id: &key.id,
                chain_seq: key.enrolled_seq,
                row_version: key.row_version,
                row_state: &account_key_row_state(&key),
            },
        );
        if stored != expected {
            return Err(AuthorityError::Unverifiable("account key row seal"));
        }

        let evicted = AccountKey {
            retired_at_unix: at_unix,
            row_version: key.row_version + 1,
            ..key
        };
        let seal = authority::row_seal(
            &row_key,
            &RowFacts {
                table: "account_keys",
                row_id: &evicted.id,
                chain_seq: evicted.enrolled_seq,
                row_version: evicted.row_version,
                row_state: &account_key_row_state(&evicted),
            },
        );
        let updated = tx
            .execute(
                "UPDATE account_keys \
                    SET retired_at = to_timestamp($1::bigint), row_version = $2, row_seal = $3 \
                  WHERE id = $4 AND retired_at IS NULL",
                &[&at_unix, &evicted.row_version, &seal.to_vec(), &evicted.id],
            )
            .await?;
        if updated != 1 {
            return Err(AuthorityError::Unverifiable("account key"));
        }
        retired.push(evicted.id);
    }
    Ok(retired)
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
    fn only_a_steward_grant_can_take_the_sole_steward_path() {
        // §3.5's sole path is an answer to a quorum of two that cannot be met,
        // and `read` and `draw` have never needed two. The flag decides
        // whether a grant is live without a seconding, so a `draw` grant
        // wearing it would be a `draw` grant with a 24-hour delay and a
        // meaningless exemption -- and one more way for the bit to be set.
        let state = AuthorityState {
            organisation: "01JQZ0000000000000000000BB".to_string(),
            grants: Vec::new(),
            secondings: Vec::new(),
            suspensions: Vec::new(),
            revocations: Vec::new(),
        };
        // No live steward at all, which is the most permissive input there is.
        assert_eq!(state.steward_count(1_000), 0);
        for capability in [Capability::Read, Capability::Draw] {
            let choices = server_choices(&state, capability, 1_000).expect("not blocked");
            assert!(
                !choices.sole_steward_appointment,
                "{capability:?} never takes §3.5's sole-steward path"
            );
            assert_eq!(choices.effective_from_unix, 1_000, "and it is live at once");
        }
        let choices = server_choices(&state, Capability::Steward, 1_000).expect("not blocked");
        assert!(choices.sole_steward_appointment);
        assert_eq!(
            choices.effective_from_unix,
            1_000 + SOLE_STEWARD_DELAY_SECONDS,
            "the flag and the delay are one decision"
        );
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
