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
//! - **No memoised live set across calls.** §3.4 permits one, keyed by
//!   `(organisation, auth_epoch)` in process memory. It is an optimisation and
//!   it is not built: the brief for this layer is *nothing cached that a
//!   database write could poison*, and the cheapest way to hold that line is
//!   to have nowhere to put a stale answer. The one memo that exists,
//!   `QuorumPass`, lives on the stack **inside a single authorisation** and is
//!   dropped with it — it is what makes the seconding walk linear rather than
//!   exponential, and no second use can see it.
//! - **No verdict is ever stored**, and there is no column that could hold
//!   one.
//! - **No hardware factor** (§15.1). Keys are software ES256 keys and
//!   `account_keys.key_source` records that as a fact rather than leaving it
//!   to be assumed.

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
/// *"A sole steward may appoint a second alone, with a 24-hour delay."* The
/// delay is the part of that sentence a database can enforce; the banner, the
/// mailed notice and the cancel button need a surface that does not exist yet
/// and are named in `0011`'s own comment as unbuilt.
pub const SOLE_STEWARD_DELAY_SECONDS: i64 = 24 * 60 * 60;

/// How far into the past a proposal's `effective_from` may have drifted by the
/// time the signed grant comes back (§3.3, and the two-step split below).
///
/// **Two minutes.** The window has to cover a human reading what they are
/// signing and a software key producing the signature, plus clock drift
/// between the browser and the server; it must not be long enough for a
/// proposal captured off the wire to be replayed into a materially different
/// authority state. Two minutes is generous for the first and short enough
/// that the epoch check — which is exact, not fuzzy — is what actually carries
/// the freshness guarantee. The epoch is the control; this is a bound on
/// staleness for the one field the epoch does not pin.
pub const PROPOSAL_SKEW_SECONDS: i64 = 120;

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
    /// When this key left service — `0` for "still in service".
    ///
    /// **A timestamp rather than a boolean, because §3.3 resolves a key *as of*
    /// a grant's `effective_from`.** A key retired last week must still verify
    /// the grants it signed last year; a boolean cannot say that, and reading
    /// one meant a rotation silently invalidated history or silently validated
    /// it, depending on which way the check was written.
    pub retired_at_unix: i64,
}

impl AccountKey {
    /// Whether this key was in service at `at_unix` (§3.3, §8.4).
    ///
    /// Retirement and supersession both take a key out of service, and both
    /// are recorded with the same timestamp by [`supersede_key`], so one
    /// comparison answers both.
    ///
    /// **The boundary is inclusive, and that is deliberate.** A key is in
    /// service up to and including the instant it is retired; retirement bites
    /// after that instant. The exclusive reading breaks the ordinary case —
    /// a grant signed and a key superseded within the same second, which this
    /// repository's own succession test does — by retrospectively invalidating
    /// a grant that was signed before the retirement was even requested. What
    /// the check is for is a grant claiming to be effective *after* a key left
    /// service, and `<=` refuses that exactly.
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

/// `K_row_site` — the subkey **`account_keys` rows are sealed under**.
///
/// § The keyring is account-scoped and the seal was not (fixed here). An
/// account may belong to two organisations. Sealing its keyring row under the
/// current organisation's row key meant the row verified in whichever
/// organisation happened to enrol it and nowhere else: the second
/// organisation recomputed the seal under its own key, got a different value,
/// and refused the account with `Unverifiable` — an integrity alarm naming a
/// forgery that had not happened, which is worse than a permission error
/// because it sends someone looking for an attacker.
///
/// The site chain key is the one key in this deployment that is the same for
/// every organisation, so it is what an account-scoped row must be sealed
/// under. The label does not change — see `authority::row_key`.
///
/// `pub(crate)` since `0013`: a session row is account-scoped in exactly the
/// way a keyring row is — it belongs to a principal, not to an organisation,
/// and its verifier holds no tenant context — so `sessions.rs` seals under
/// this same subkey rather than deriving a second one. Nothing outside this
/// crate gains a way to reach it.
pub(crate) async fn site_row_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
) -> Result<Key32, AuthorityError> {
    Ok(authority::row_key(&site_chain_key(tx, ring).await?))
}

/// **The site chain key itself** — the one key in this deployment that is the
/// same for every organisation, and the input every site-scoped subkey is
/// expanded from.
///
/// `pub(crate)` since `0014`: `sessions.rs` expands a second subkey from it,
/// for the keyed hash of a claimed sign-in address, in exactly the shape
/// [`authority::row_key`] expands `K_row_site`. It needs the key and not the
/// row subkey, because a KDF label separates uses of ONE key and hashing an
/// address is not a row seal.
///
/// Nothing outside this crate gains a way to reach it, and nothing inside it
/// may return it to a caller who has not already been trusted with
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

/// Enrol an account's **first** software key, on the site chain, at the moment
/// an enrolment token is redeemed (§1.1, §5.1, §6.2, migration `0015`).
///
/// # Why this exists beside [`enrol_software_key`], which does not change
///
/// [`enrol_software_key`] files `account_key_enrolled` on an ORGANISATION's
/// chain, and needs an [`Authority`] to do it — which needs a
/// [`repo::TenantContext`], which needs a membership row. That is right for a
/// key enrolled by somebody who is already in an organisation, and impossible
/// for the case this build is about: **§6.4 says a steward may only grant to a
/// subject who already has a registered key, and §6.2 says an organisation
/// shell is redeemed by an account that already has one.** So the first key of
/// an invited person is enrolled before any organisation knows their name, and
/// there is no organisation chain it could be filed on.
///
/// §7.1 answers what to do with it: *"the site chain covers everything
/// organisation-independent."* §7.2 already names the type —
/// `authenticator_registered` — on the site chain, which is where this files
/// it.
///
/// **The row, its seal and the keyring's shape are identical.** Both paths go
/// through `insert_account_key`, so a key enrolled at invitation and one
/// enrolled inside an organisation are the same row sealed the same way, and
/// `live_signing_key` cannot tell them apart — which is the property that
/// makes sign-in work for both.
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
/// **One function, so the two chains cannot drift into two row shapes.** The
/// seal is `authority::row_seal` under the site-scoped row key, which is what
/// `verify_key_row` recomputes at every use — an account's keyring is
/// account-scoped, not organisation-scoped, and `site_row_key`'s own doc
/// carries that argument.
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
    let old = read_account_key(tx, old_key_id)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;
    let new = read_account_key(tx, new_key_id)
        .await?
        .ok_or(AuthorityError::NoSigningKey)?;

    // **The successor must belong to the same account.** Without this, a key
    // holder could name somebody else's key their successor, and every grant
    // naming the old fingerprint would carry forward onto an account that
    // never asked for it -- authority moved by one signature from a key whose
    // holder is entitled to retire it and not to redirect it. §8.4's
    // succession is a statement about one account's own keyring.
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

    // `retired_at` is the signed `at_unix`, not `now()`: the seal covers the
    // value and a verifier resolving a key as of a grant's `effective_from`
    // compares against it, so the row and the signature must agree on when
    // the key left service.
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
/// # A name that was pretending to be a control
///
/// `0011` put `account_key_retired` in `chain_entries`' entry-type `CHECK` and
/// `account_keys.retired_at` in the keyring, and **nothing wrote either**. A
/// column and an entry type that no code path produces read, to anyone
/// auditing the schema, as a retirement mechanism that exists. This is that
/// mechanism.
///
/// # Who may sign it
///
/// §8.4's succession shape, with the one extension it forces: the key's own
/// holder, **or a steward of the organisation**. Succession needs the old key,
/// because only its holder can prove the successor is theirs. Retirement is
/// the case where the holder is gone — the dropped laptop, the departure §6.4
/// describes — so restricting it to the key's own holder would mean the keys
/// that most need retiring are the ones that cannot be. A steward already
/// holds revocation over every grant the key names, so this grants them
/// nothing they did not have; what it adds is that the keyring says so.
///
/// The signer's own fingerprint is inside [`authority::retire_bytes`], so a
/// steward's retirement of somebody else's key is not readable as that
/// person's own act.
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

    // The signer: the holder, or a steward. A steward is established the same
    // way every other authority act establishes one -- through the seven steps
    // -- so there is no second, weaker notion of "is a steward" in this file.
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

/// The account's key **as `sign_in` must resolve it**: the live one, its own
/// keyring row seal verified, and in service at `at_unix`.
///
/// [`signing_key_of`] answers "which row would this account sign with" and
/// verifies nothing, which is right for a caller that is about to hand the
/// bytes to a human. A caller that is about to accept a signature as proof of
/// identity needs the seal checked, because a keyring row whose `public_key`
/// was edited is exactly how an administrator would sign in as somebody else.
/// This is that caller's function, added for `sessions.rs` (§4.2).
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
//
// Added in a labelled block so the other two ADR-0055 streams' additions land
// beside it and the merge is mechanical.

/// **Every** key this account could sign with today: neither superseded nor
/// retired, newest first.
///
/// [`signing_key_of`] answers the same question with `LIMIT 1`, and that was
/// right while an account had exactly one key — a browser enrolled at an
/// invitation, and a rotation that superseded the old row. ADR-0055 decision 6
/// ends that: *"Any browser, no pairing"*, and the lead's resolution 1 of the
/// build contracts makes it concrete — the client registers a per-browser key
/// through `POST /credentials/key` after every password sign-in, so one person
/// on a laptop and a desktop has two live keys and neither supersedes the
/// other. With `LIMIT 1` the older browser signs in and is refused, which
/// reads as a stolen key rather than as a second machine.
///
/// **`ORDER BY enrolled_seq DESC` is kept**, so that when only one key is live
/// this returns exactly what `signing_key_of` returns, in the same order, and
/// the single-key path is unchanged.
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
/// exactly as [`live_signing_key`] checks the single one: a keyring row whose
/// `public_key` was edited is how an administrator would sign as somebody else,
/// and that is no less true when there are two rows.
///
/// [`AuthorityError::NoSigningKey`] when the account has no live key at all —
/// which is the expected state for a password-only person and must not be read
/// as a refusal by a caller that has another factor.
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
        // An UNVERIFIABLE row is an integrity alarm and is not swallowed by
        // trying the next key: §3.4 step 2 is explicit that an alarm must not
        // render as a permission error, and a keyring with one edited row is
        // an incident whichever key the caller happened to use.
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
/// A session records **which** key proved it, not merely that some key did, so
/// that the session dies with that key (§8.4's retirement, checked at every
/// request). Resolving the account's *current* key instead would mean a
/// retired key's session surviving on its successor's authority, which nobody
/// authorised.
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

/// Resolve a key by fingerprint **as of `at_unix`**, verifying the keyring
/// row's own seal (§3.4 step 4, §3.3, §8.4).
///
/// # Why this takes a time
///
/// §3.3: *"verification uses the keyring entry live at `effective_from`"*, and
/// §8.4 turns that into the reason a key rotation does not invalidate a year
/// of grants. A key that was retired or superseded **after** a grant was
/// signed still verifies that grant; one retired **before** it verifies
/// nothing, because at the moment the grant claims to have been signed that
/// key was already out of service.
///
/// Reading `retired_at` and `superseded_by` as booleans — "is this key retired
/// *now*" — gets both halves wrong at once: it invalidates history on every
/// rotation, and it accepts a grant backdated to before a key existed. The
/// comparison is against the grant's own `effective_from`, which is inside the
/// signed bytes and therefore not the attacker's to choose.
async fn key_by_fingerprint(
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

    // **The genesis grants are named in the sealed entry, before any of them
    // is written.** §6.1 and the note in `0012`'s header: no `CHECK` can read
    // another table, so no constraint can say "there is no genesis after
    // creation". The organisation's own chain can. Each grant's id is minted
    // here, listed in `org_genesis`, and then used as the row's primary key,
    // so a genesis row that this entry does not name is refused at use — and
    // a late genesis row cannot be named by an entry sealed before it existed.
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
            // A genesis grant is root-signed and needs no seconding for a
            // reason of its own (§6.1); it is not §3.5's sole-steward path and
            // does not claim the flag.
            sole_steward_appointment: false,
            auth_epoch: 1,
        };
        let message = authority::grant_bytes(&facts);
        // **Verified before it is stored, and verified again at every use.**
        // This call is not the control; §3.4's is. It is here so that a
        // signature that could never verify is refused at the door rather
        // than becoming a row that fails confusingly later.
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
// TWO STEPS, AND WHY THE ONE-STEP SHAPE COULD NOT WORK
//
// `sign_grant` used to take a finished signature and then choose, itself,
// three of the values that signature had to cover: the `auth_epoch`, the
// wall-clock `now`, and the `effective_from` derived from it. The client could
// not have signed those bytes, because they did not exist until after the
// client signed. It worked only while the server's second and the client's
// second happened to be the same one — and this repository's own suite flaked
// on exactly that, refusing a correct signature with `DoesNotVerify` whenever
// the clock ticked between the two.
//
// So: `propose_grant` fixes every server-chosen value and returns exactly the
// bytes to sign. `sign_grant` verifies over those bytes AS ISSUED and never
// recomputes them. What it re-checks at commit is whether the proposal is
// still current -- and if it is not, it refuses and says to propose again. The
// server may not quietly adjust bytes somebody has signed; that is the whole
// point of the signature.
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
///
/// Handed to the granter, signed by them, and handed back to [`sign_grant`]
/// unchanged. Nothing in here is recomputed on the way back.
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
    /// (`fathom/grant/v2`), and re-derived at [`sign_grant`] rather than
    /// believed. All three, because this one bool decides whether a `steward`
    /// grant is live on one signature.
    pub sole_steward_appointment: bool,
    /// **Exactly the bytes to sign** — `authority::grant_bytes` over the
    /// facts above, built once so that the two steps cannot disagree.
    pub bytes: Vec<u8>,
}

/// Step one: fix the server's choices and produce the bytes to sign (§3.3).
///
/// The granter must already hold `steward` at or above the scope, **verified
/// through `authorise_account`** — so the seven steps run before a grant is
/// proposed as well as before a design is opened.
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
///   hours out, and it needs no seconding.
///
/// The count is [`AuthorityState::steward_count`], which counts a suspended
/// steward and does not count an expired one — see its own note for the two
/// attacks that turned on those choices. And the sole path is closed outright
/// while a single-steward act that weakens another steward is still inside its
/// delay, so suspending your co-steward does not make you sole.
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
/// state as it is at `now`.
///
/// # One function, called twice, and that is the point
///
/// [`propose_grant`] calls it to fix the values a granter is about to sign;
/// [`sign_grant`] calls it again at commit and refuses if the answer has
/// changed. Two spellings of "is this a sole-steward appointment" — one at
/// each end — is how the two ends come to disagree, and the disagreement that
/// mattered was the one where the proposal's own copy of the flag was simply
/// believed.
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
/// **`GrantProposal`'s fields are all `pub` and it crosses a process
/// boundary**, so `bytes` and the fields beside it are two statements of one
/// thing and nothing made them agree. [`sign_grant`] recomputes this and
/// refuses a proposal whose `bytes` are not what its fields spell out.
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
/// # What is checked here, and what is deliberately not
///
/// The signature is verified over `proposal.bytes` exactly as
/// [`propose_grant`] produced them. The bytes are not *rebuilt for
/// verification* — a server that verifies a signature over something it
/// assembled itself has given itself the ability to verify something other
/// than what was signed, and rebuilding them at that point is what made the
/// one-step version fail.
///
/// # But every field beside them IS re-derived, and this is the defect that
/// taught it
///
/// `GrantProposal` crosses a process boundary with all its fields `pub`, and
/// this function used to copy `sole_steward_appointment` off it onto the row.
/// Nothing bound the flag to the signature and nothing re-derived it, so a
/// steward could sign an honest proposal, flip the flag on the way back, and
/// mint a `steward` grant that needed no seconding and waited no 24 hours —
/// §3.5's whole quorum, defeated by setting a `bool` on a struct. Three
/// things close it, and each closes it alone:
///
/// 1. **The flag is inside `grant_bytes`** (`fathom/grant/v2`), so flipping it
///    invalidates the granter's signature and the seconder's with it.
/// 2. **The bytes are recomputed from the proposal's own fields** and must be
///    the bytes presented. A proposal whose fields and bytes disagree is not a
///    stale proposal, it is a forged one, and it is refused as
///    [`AuthorityError::Unverifiable`].
/// 3. **Every server-chosen value is re-derived from the state as it is at
///    commit** and must match exactly: the epoch, the sole-steward
///    determination, the `effective_from` that determination implies, the
///    organisation root fingerprint and the subject's key fingerprint.
///
/// The freshness checks, each exact rather than fuzzy:
///
/// - **The epoch must still be the head's next.** If another transaction
///   advanced the authority in between, the signed `auth_epoch` is stale and
///   the grant would take its place in a state its signer never saw.
/// - **The sole-steward determination must still hold.** A second steward
///   appearing between the two steps turns a one-signature appointment into
///   one that needs a seconding; a proposal signed under the old answer is
///   refused rather than committed under the new one.
/// - **`effective_from` must be the one the flag implies**, within
///   [`PROPOSAL_SKEW_SECONDS`] of it — `now` for an ordinary grant, `now +
///   `[`SOLE_STEWARD_DELAY_SECONDS`] for a sole appointment. A grant that says
///   it took effect an hour ago is backdated, and backdating is how a grant is
///   made to look older than the revocation that should have caught it.
///
/// Any of those is [`AuthorityError::Stale`], which says to propose again. The
/// server does not adjust and re-sign, because it cannot: it holds no
/// steward's private key, which is the property §3.3 is built on.
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

    // The proposal's bytes must be the bytes its fields spell out. Every field
    // below is read off the proposal, and this is what makes reading them
    // safe: what the signature covers and what the row is built from are one
    // statement, not two.
    if proposal_bytes(proposal) != proposal.bytes {
        return Err(AuthorityError::Unverifiable(
            "the proposal's fields are not the bytes it carries",
        ));
    }

    // The granter's authority again, at commit: a proposal is not a permit,
    // and a granter revoked between the two steps grants nothing.
    let scope = proposal.scope.as_deref().map(parse_scope).transpose()?;
    authorise_account(tx, auth, scope, Capability::Steward).await?;

    // Every server-chosen value, re-derived from the state as it is now.
    //
    // The sole-steward determination is checked BEFORE the epoch, so that a
    // proposal overtaken by a second steward's arrival says which fact moved.
    // Both refusals are the same typed re-propose error.
    let now = now_unix();
    let state = read_authority_state(tx, &organisation).await?;
    let choices = server_choices(&state, proposal.capability, now)?;
    if choices.sole_steward_appointment != proposal.sole_steward_appointment {
        return Err(AuthorityError::Stale(
            "the sole-steward determination has changed",
        ));
    }
    // `effective_from` must be the value the flag implies, allowing only for
    // the time the signer took. Not "not too old": a sole appointment's
    // `effective_from` is a day in the FUTURE, and a one-sided staleness test
    // against `now` passed it trivially.
    let drift = choices.effective_from_unix - proposal.effective_from_unix;
    if !(0..=PROPOSAL_SKEW_SECONDS).contains(&drift) {
        return Err(AuthorityError::Stale(
            "effective_from is not the one this proposal's own facts imply",
        ));
    }
    if next_epoch(tx, &organisation).await? != proposal.auth_epoch {
        return Err(AuthorityError::Stale("the authority head has moved"));
    }
    // The two fingerprints the server resolved for the signer, resolved again.
    // A key rotated between the two steps means the bytes name a key the
    // organisation no longer points at, which is a re-propose and not a
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
        // The RE-DERIVED flag, not the proposal's copy of it. They are equal
        // by the check above; taking the derived one means that if the check
        // is ever loosened, the row still says what the state says.
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

    let message = authority::second_bytes(
        &grant_bytes_of(tx, ring, &grant).await?,
        &grant.granter_key_fpr,
    );
    // ADR-0055 stream (a): any live key of the seconder, not the newest —
    // `verify_by_any_live_key`'s own doc carries the argument. It also checks
    // the keyring row's own seal, which `signing_key_of` did not. The key that
    // VERIFIED is the one whose fingerprint goes on the seconding row below,
    // so the record names what actually signed.
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
    // ADR-0055 stream (a): any live key of the actor, not the newest. The key
    // that VERIFIED is the one whose fingerprint goes on the suspension row
    // below, so the record names what actually signed.
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

/// When an act against a grant takes effect — now, or after §3.5's delay.
///
/// # The sequence this exists to refuse
///
/// One steward suspends the other; the organisation now looks
/// single-stewarded; the survivor appoints a third **alone**, as a "sole
/// steward" appointment; then lifts the suspension. Two signatures' worth of
/// authority manufactured out of one, and every individual step permitted by
/// the rules as they stood.
///
/// [`AuthorityState::steward_count`] closes it from one side by counting a
/// suspended steward. This closes it from the other, and is the general
/// statement: **a single-steward act that removes or weakens another steward
/// waits out the same 24 hours a sole appointment does.** For the 24 hours it
/// is pending it is visible, it is on the organisation chain marked as what it
/// is, and the sole-steward path is closed while it stands.
///
/// Three acts are immediate, because none of them weakens anybody else:
/// revoking or suspending a `read` or `draw` grant, acting on your own grant,
/// and lifting a suspension.
///
/// **The cost, stated rather than buried:** offboarding a steward now takes a
/// day to bite. §3.5 already accepts that cost for the mirror-image act, and
/// the alternative is that the same single signature that cannot appoint a
/// steward immediately can remove one immediately — which is the asymmetry the
/// attack walks through. An organisation that needs a steward stopped *now*
/// has suspension by an operator (§1.1), which is a different fence.
fn weakening_act_takes_effect_at(grant: &Grant, actor: &str, weakening: bool, at_unix: i64) -> i64 {
    let weakens_another_steward =
        weakening && grant.capability == Capability::Steward && grant.subject_id != actor;
    if weakens_another_steward {
        at_unix + SOLE_STEWARD_DELAY_SECONDS
    } else {
        at_unix
    }
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
                // *recorded as such* on the organisation chain, not merely
                // delayed. A reader of the trail can see why it waited.
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

/// **§1.1's operator suspend verb, made real.**
///
/// *"Suspend a scope grant (immediate) | operator session; any steward of that
/// organisation may lift it; if no steward is live, the recovery key lifts
/// it."* This is the one authority-adjacent act the operator plane has, and it
/// is deliberately one-way: there is no operator unsuspend here, and `0011`'s
/// own `CHECK` refuses `action = 'unsuspend'` for an `actor_kind = 'operator'`
/// row, so a second opinion is needed to restore what one operator stopped.
///
/// # What an operator does NOT gain by holding this
///
/// * **No capability anywhere.** Suspension only ever removes a grant from the
///   live set; `authorise_account` skips a suspended grant and nothing about
///   this act can add one. An operator who suspends every grant in an
///   organisation has locked its stewards out and has still read nothing.
/// * **No design payload.** `repo::enter_operator_tenant_scope` sets
///   `app.design_capability` to its refusal and never to anything else.
/// * **No signature.** `actor_sig` is `NULL` for an operator, because there is
///   nothing an operator could sign that a steward would honour — their
///   authority for this act is the operator session, and the session is what
///   the site chain records. The organisation's own chain records the act with
///   `actor_kind = 'operator'`, so a steward reading their own trail can see
///   that the machine side did this and who to ask.
/// * **No immediacy against a steward's own protections.** §3.5's delay on a
///   weakening act is a rule about a *steward* acting alone; §1.1 makes the
///   operator's suspension immediate on purpose, because the case it exists
///   for is a steward who must be stopped now. That asymmetry is the design's,
///   is written down there, and is why the act is one-way and loudly recorded.
///
/// # Why this takes an organisation id, which §4's pinning rule would rather it
/// did not
///
/// `scope_grants` is behind `organisation_id = app.tenant_id`, so the grant row
/// cannot be read until a tenant is named — and the tenant cannot be read off
/// the grant row that cannot be read. An earlier draft of this function took
/// only a grant id for exactly the reason §4 gives, and it could not read
/// anything.
///
/// So the caller names both, and **the pair is checked**: the organisation
/// scopes the transaction, the grant is read inside that scope, and a grant
/// whose own `organisation_id` is not the one named is refused. An operator who
/// guesses a grant id from another tenant gets `NotAuthorised` rather than a
/// suspension in the organisation they named. The alternative — widening
/// `scope_grants`' read policy to any transaction that sets
/// `app.operator_custody` — would give the application role a way to read every
/// grant in the estate, which is a larger door than this one.
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
        // Immediate, which is the whole point of the verb (§1.1). §3.5's delay
        // is a rule about one steward weakening another, and an operator is
        // not a steward.
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
    // single-steward act that weakens a steward, and waits out the same delay
    // a sole appointment does. See `weakening_act_takes_effect_at`.
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

/// The half of [`advance_head`] that takes the organisation and the actor
/// directly, for §1.1's operator suspend verb — which has no tenant context
/// because an operator can never be a member (`0004`).
///
/// **The head MUST advance for every act that changes the authority state**,
/// operator acts included: §3.4 step 4 recomputes the digest over the whole
/// state and refuses the organisation outright if it disagrees with the head.
/// An operator suspension that skipped this would not weaken one grant, it
/// would make every authorisation in that organisation an integrity alarm.
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
/// §3.4's head covered the live grants and nothing else, which left every
/// seconding, suspension and revocation outside every seal and outside the
/// head. This is the set the head now covers, and the set every verdict is
/// computed from — read once, so that two checks in one authorisation cannot
/// disagree about what the database said.
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
            // ORDER BY the identity column, so "the latest suspension" does
            // not depend on a clock anybody can set. `seq` is not carried on
            // the struct: the row's identity inside its seal is the chain
            // sequence, and two statements of one identity is one too many.
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
    /// Every row the head's digest covers, keyed `"<table>/<row identity>"`
    /// and carrying its **recomputed** seal.
    ///
    /// The seal in the digest is recomputed, never the stored one: a head
    /// built from stored seals would carry an edited row's own lie forward.
    /// The stored seal is compared separately, at use, for every row an answer
    /// actually rests on — the two checks catch different things, and a
    /// seconding with a valid signature but a forged stored seal is caught
    /// only by the second.
    ///
    /// **Grants with a revocation row drop out of the grant portion**, and
    /// their revocation row is in the set instead, so a revocation that is
    /// deleted changes the digest twice over. Whether that revocation has yet
    /// *taken effect* is a question for use, not for the digest: folding time
    /// into the set would mean the head has to be resealed as clocks pass,
    /// which nothing triggers, so the head would go stale and every
    /// authorisation in the organisation would fail.
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
            // `seq` is an identity column the database assigns, so the seal
            // names the grant and the chain sequence -- which is unique per
            // organisation chain -- and the digest key is zero-padded so that
            // string ordering and numeric ordering agree.
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
    /// # Why this is a second check and not the same one
    ///
    /// [`AuthorityState::digest_entries`] puts the *recomputed* seal into the
    /// head's digest, which is what makes an edited row change the digest and
    /// fail against the sealed head. But a row whose stored seal is forged and
    /// whose content is untouched produces the same recomputed seal, so it
    /// sails through the digest comparison. The stored seal has to be compared
    /// against the recomputation as well, and this is where.
    ///
    /// Across the whole state, not only the rows an answer rests on: the head
    /// is a statement about the whole authority, and a store that is lying
    /// about one row of it is not a store to take a permission from. §3.4's
    /// posture, unchanged — `Unverifiable`, never "no grants found".
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
    /// §3.5, as amended: a single-steward act that removes or weakens another
    /// steward waits out the same 24 hours a sole appointment does, so the
    /// existence of a revocation row and its taking effect are two different
    /// moments.
    fn revoked_by(&self, grant_id: &str, at_unix: i64) -> bool {
        self.revocations
            .iter()
            .any(|r| r.grant_id == grant_id && r.takes_effect_unix <= at_unix)
    }

    /// As [`AuthorityState::revoked_by`], but only counting revocations
    /// written by chain position `as_of_seq` — the historical question a
    /// seconding asks about its seconder.
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
    /// §3.5: *"the sole-steward path cannot be taken while such an act is
    /// pending."* Otherwise one steward suspends the other, waits for the
    /// count to fall to one, and appoints a third alone — which is the
    /// sequence this clause exists to refuse.
    fn a_weakening_act_is_pending(&self, at_unix: i64) -> bool {
        self.revocations
            .iter()
            .any(|r| r.takes_effect_unix > at_unix)
            || self
                .suspensions
                .iter()
                .any(|s| s.action == "suspend" && s.takes_effect_unix > at_unix)
    }

    /// §3.5's `min(2, live distinct stewards)` — the count.
    ///
    /// # What counts, and the two ways this was wrong
    ///
    /// **Expired grants do not count.** `0011` requires every steward grant to
    /// carry an expiry, and the old count ignored expiry entirely — so an
    /// organisation whose co-steward's grant had lapsed had one steward who
    /// could do nothing and one who was not sole, and could never appoint
    /// anybody again. Every organisation deadlocked eventually.
    ///
    /// **Suspended grants DO count.** A suspension is reversible by any
    /// steward, so treating a suspended steward as absent let one steward
    /// suspend the other, become "sole" on the strength of it, appoint a third
    /// alone, and lift the suspension — manufacturing a steward out of one
    /// signature. Suspension stops a steward acting; it does not remove them
    /// from the count that decides whether a second signature is required.
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
/// # What this replaces, and what it does not claim
///
/// `0011` carried a `BEFORE INSERT` trigger meant to refuse a genesis grant
/// once the head had moved past epoch 0. It refused nothing. The function was
/// `SECURITY DEFINER`, so its read of `organisation_auth_head` ran as the
/// table's owner; that table is `FORCE ROW LEVEL SECURITY`, so the owner is
/// subject to its policies too; the policy compares `organisation_id` against
/// `current_setting('app.tenant_id', true)`, which with no tenant context set
/// is `NULL`. The `EXISTS` was therefore false in exactly the session a second
/// genesis would be written from, and the trigger returned `NEW`.
///
/// `0012` drops it and adds `CHECK (NOT is_genesis OR auth_epoch = 1)`, which
/// binds at every privilege level. **That `CHECK` is belt-and-braces and not
/// the fence**: a `CHECK` cannot read another table, so no constraint can
/// express *"there is no genesis after creation"* — it can only say what a
/// genesis row must look like, and an attacker writing one directly picks
/// `auth_epoch = 1` freely.
///
/// The fence is this function, and it rests on the chain. `bootstrap_organisation`
/// mints each genesis grant's id, names it in the `org_genesis` entry together
/// with its subject and subject key fingerprint, and seals that entry before
/// writing a single grant row. A genesis row added later is not in that list —
/// and it cannot be added to it, because the entry was sealed before the row
/// existed and re-sealing it needs the organisation content key. So a late
/// genesis grant is **unusable**, not merely late.
///
/// **It is not unconstructible at the SQL level and must not be described as
/// if it were.** The row inserts. What it does not do is authorise anybody.
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

    // The subject's key, resolved as of the grant's own `effective_from`
    // (§3.3), with the keyring row's seal verified inside
    // `key_by_fingerprint`, and bound to the subject named on the row.
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
        // v2: the flag is inside the signature, so an edited flag on a stored
        // row fails the granter's signature as well as the row seal.
        sole_steward_appointment: grant.sole_steward_appointment,
        auth_epoch: grant.auth_epoch,
    });

    let granter_public_key = match &grant.granted_by {
        Some(granter_id) => {
            let key =
                key_by_fingerprint(tx, ring, &grant.granter_key_fpr, grant.effective_from_unix)
                    .await?;
            // **The granter's key must belong to the granter's account.**
            // This is the same binding §3.3 argues for on the subject side and
            // it was checked only there. Without it, a row naming account A as
            // granter and account B's key fingerprint verifies happily under
            // B's key -- so a grant reads, in the audit trail and on the
            // permission screen, as A's act, and B is who actually signed it.
            if key.account_id != *granter_id {
                return Err(AuthorityError::Unverifiable("granter key binding"));
            }
            key.public_key
        }
        None => {
            // Root-signed: genesis or recovery. The fingerprint in the row
            // must be the root's own, or the signature would be checked
            // against whatever key the keyring happens to hold.
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
/// qualifying seconding is one whose stored seal recomputes, whose signature
/// over `second_bytes` verifies under the key that was in service when it was
/// made, whose seconder is neither the granter nor the subject, and whose
/// seconder held a verified live `steward` grant covering this grant's scope
/// **at the seconding's own chain position** — not now. A seconding is a
/// statement made at a moment; a seconder whose stewardship was revoked
/// afterwards still seconded it, and one who never held stewardship never did.
///
/// # A seconding that does not qualify is NOT COUNTED, and is not an alarm
///
/// This is the correction. Every check above used to return
/// [`AuthorityError::Unverifiable`] for the whole grant, so **one bad
/// seconding failed the grant it was attached to** — and since anybody who
/// holds `steward` can second any grant, one steward could brick another's
/// stewardship permanently by adding a seconding that fails to qualify. Not
/// counting it loses nothing: a forged seal is caught for the whole
/// organisation by [`AuthorityState::verify_stored_seals`], which runs over
/// every authority row at every use and is where a store that is lying about
/// itself is refused. What is left here is a question about one signature's
/// standing, and the answer to "this signature does not count" is that it does
/// not count.
///
/// # The cycle, and why the recursion terminates
///
/// Step 4 recurses: the seconder's own steward grant may itself have needed
/// seconding. **The termination argument in the superseded comment was false.**
/// It claimed each step moves strictly backwards through `chain_seq`; it does
/// not, because a grant may be seconded long after it was written, so
/// `A seconds B` and `B seconds A` is constructible and the walk between them
/// does not descend. What was there instead was a depth limit of eight, which
/// turned a cycle into [`AuthorityError::Unverifiable`] for everyone in it —
/// permanently, since a seconding cannot be withdrawn — and refused generation
/// nine of an ordinary appointment chain along with it.
///
/// The argument that is true: [`QuorumPass::on_path`] holds the grant ids on
/// the path under evaluation, so **every path is simple** — a seconder whose
/// stewardship depends, transitively, on the grant being evaluated does not
/// qualify, and the walk cannot revisit a grant it is already inside. And
/// [`QuorumPass::settled`] memoises each grant's answer, so **every grant is
/// evaluated once** per pass. Cost is linear in grants plus secondings, and
/// the depth limit is gone.
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
        // §3.5: genesis and recovery grants are root-signed and have their own
        // controls; a sole-steward appointment is §3.5's answer to a quorum
        // that cannot be met, and pays for it with the delay instead. All
        // three are facts the granter's signature covers -- `is_genesis` and
        // `is_recovery` through the row seal, the sole flag through
        // `grant_bytes` itself since `fathom/grant/v2`.
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
            // it is an answer about this path, not about this grant.
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
/// It cannot happen: the mutex is created inside one authorisation, is locked
/// only for the length of a map lookup or insert with no `await` in between,
/// and nothing inside those sections can panic. The `expect` is here rather
/// than an `unwrap` so that if it ever did, the message says which lock.
const POISON: &str = "the quorum pass lock is never held across an await and never poisoned";

/// One pass's working memory: the path being walked, and what it has settled.
///
/// **A `Mutex`, not a `RefCell`, and the reason is the HTTP boundary.**
/// `&RefCell<T>` is not `Send`, so an authorisation that held one across an
/// `await` produced a future axum will not accept — which is to say: with a
/// `RefCell` here, **no route in this server could ever authorise anybody**.
/// The change is mechanical (the lock is taken for one map operation at a
/// time, never across an `await`, and there is exactly one thread in the
/// walk), and it is the alternative to a borrow that works everywhere except
/// where the product needs it.
///
/// **Created inside one authorisation question and dropped with it.** §3.4
/// permits a memo *"of the live set within a use"* and forbids a stored
/// verdict; this is the first and cannot become the second. It lives on the
/// stack, every value in it is derived from rows read inside the same
/// transaction, and no second use can see it — so the property the test
/// `no_verdict_is_cached_between_two_uses_in_one_process` asserts is untouched.
#[derive(Default)]
struct QuorumPass {
    /// The grant ids on the path currently under evaluation. What makes every
    /// path simple, and therefore what makes the walk terminate.
    on_path: BTreeSet<String>,
    /// Grant id → does this grant carry the signatures §3.5 requires.
    settled: BTreeMap<String, bool>,
    /// Grant id → did [`verify_grant_row`] accept it, in the soft sense this
    /// walk asks it (a grant that does not verify is not a steward's; it is
    /// not an alarm raised from inside somebody else's authorisation).
    rows: BTreeMap<String, bool>,
}

/// A refusal that makes a seconding or a supporting grant **not count**,
/// rather than one that makes the store untrustworthy.
///
/// The distinction is the whole of the correction above. `Unverifiable` and
/// `Signature` mean *this row does not say what it claims*; asked about the
/// grant an answer is being given for, that is an alarm, and asked about some
/// other account's grant several steps away it is simply a row that supports
/// nothing. `NoSigningKey` means a fingerprint resolves to no live keyring
/// entry, which is the same kind of answer.
///
/// A database error, a corrupt column or a rollback is none of those and
/// propagates.
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
    //    forged stored seal passes the head; `verify_stored_seals` is what
    //    refuses the organisation over it. Here it only stops the row
    //    counting.
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

    // 2. Neither the granter nor the subject. `0011` binds this with a
    //    three-column foreign key and a `CHECK`, and it is restated here
    //    because a constraint that is the only statement of a rule is a rule
    //    that disappears the day the constraint is relaxed.
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
/// A grant that fails [`verify_grant_row`] is passed over rather than raised:
/// this is a question about somebody else's grant, asked from inside a third
/// party's authorisation, and the whole-state seal check is what refuses a
/// store that is lying. The result is memoised per pass, so a grant is
/// verified once however many secondings lean on it.
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

/// Steps 2-5 of [`authorise_account`]'s seven, done once: the head and its
/// seal, the rollback watch, the whole authority state digested against the
/// head, and the genesis set. None of this depends on the scope or the
/// capability being asked for -- only on the organisation -- so a caller
/// that is about to ask the same organisation the same question for many
/// rows (a list route, one row per design or per scope) calls this once and
/// [`authorise_in_verified_state`] per row, rather than re-reading the head,
/// re-digesting the whole authority state and re-verifying genesis for every
/// row in the list. `authorise_account` itself is unchanged in behaviour: it
/// still does all seven steps, every time, by calling this and then that in
/// sequence, for every caller that authorises a single act.
pub(crate) struct VerifiedAuthorityState {
    organisation: String,
    auth_epoch: i32,
    root_fpr: [u8; 32],
    state: AuthorityState,
}

/// Test-only instrumentation, always compiled (an integration test binary
/// does not see `#[cfg(test)]` items in the library it links, so this cannot
/// be gated behind one): how many times [`verify_authority_state`] has run
/// to completion for `organisation`, this process's lifetime. Keyed by
/// organisation, not one process-wide total, so that a test asserting "ran
/// once" is not made flaky by every *other* test's own authorisations
/// running concurrently against their own, different, organisations — each
/// test in `tests/design_api.rs` bootstraps a fresh organisation, so its own
/// count is its own. Read nowhere outside tests; carries no secret (an
/// organisation id and a count).
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

    // 4. The whole authority state as the database says it is now, and the
    //    digest over it. If the head's digest disagrees, a row has been added,
    //    removed or edited somewhere in the authority since the head was
    //    sealed -- the hand-inserted grant, the edited capability, the deleted
    //    revocation, and the seconding nobody was entitled to make.
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
    // `live_count` is a second, independent statement of the same fact, and a
    // statement nobody checks is a statement that can be false. §3.2 stores
    // it; this is where it has to agree.
    if stored_live_count as usize != entries.len() {
        return Err(AuthorityError::Unverifiable("authority head live_count"));
    }
    // Then the row-level statement. The digest above carries the RECOMPUTED
    // seals, so a row whose content is untouched and whose STORED seal is
    // forged passes it; this is what catches that. Head first, rows second:
    // the head is the statement about the whole authority, and a disagreement
    // there is the more general fact.
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

/// §3.4 steps 1, 6 and 7, against a [`VerifiedAuthorityState`] steps 2-5
/// already settled. Scope-dependent (step 1's ancestors) and
/// capability-dependent (step 6's `covers` and quorum checks), so this is
/// the part a list route still runs once per row -- see
/// [`VerifiedAuthorityState`]'s doc.
pub(crate) async fn authorise_in_verified_state(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    verified: &VerifiedAuthorityState,
    scope: Option<ScopeId>,
    needed: Capability,
) -> Result<Capabilities, AuthorityError> {
    let ring = auth.ring;
    let account = auth.actor();
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
    // Whether any candidate was refused for want of a seconding, so that the
    // refusal can say so. §3.5's quorum not being met is a different fact from
    // holding no grant at all, and both are permission answers -- neither is
    // an integrity alarm.
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
        // **Expiry, evaluated at use.** Every steward grant carries one
        // (`0011`), so a layer that ignored expiry here would have let a
        // lapsed grant keep working.
        if grant.expires_at_unix != 0 && grant.expires_at_unix <= now {
            continue;
        }

        // The row: a hard question, because this is the grant the answer
        // would rest on. `Unverifiable` here is the alarm §3.4 asks for.
        verify_grant_row(tx, ring, root_fpr, grant).await?;
        // The quorum: a soft one. A `steward` grant with no qualifying
        // seconding is not a broken store, it is a grant that is not yet
        // usable -- so it is passed over and another candidate may still
        // answer. Each candidate gets its own pass, discarded with it.
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
/// Step 4 is why a hand-inserted grant grants nothing, why editing
/// `capability` on a real one grants nothing, why deleting a revocation row
/// does not restore the grant, and — since the digest covers the whole state
/// rather than the grants alone — why a seconding nobody was entitled to make
/// does not make a steward.
///
/// Steps 2-5 live in [`verify_authority_state`] and steps 1, 6 and 7 in
/// [`authorise_in_verified_state`]; this function is the two of them in
/// sequence, for every caller that authorises one act at a time.
/// [`list_designs_handler`](crate::design_api) and
/// [`list_scopes_handler`](crate::design_api) call the two separately
/// instead, once and many times, for the reason given on
/// [`VerifiedAuthorityState`].
///
/// # Nothing is cached, and there is nowhere to put a verdict
///
/// §3.4: *"no verdict is ever stored"*. Every value this function rests on is
/// read inside the call and recomputed from sealed rows. Two authorisations in
/// one process, one second apart, do the same work — which is what makes
/// tampering between them visible.
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

/// **Retire the oldest live keys of one account until `cap` are left**, and
/// say which ones went.
///
/// `POST /credentials/key` (`credentials::CredentialStore::register_key`) had
/// no cap: every call inserted a row and appended a sealed entry, and
/// [`verify_by_any_live_key`] walks the whole live ring at every signed
/// sign-in, verifying each row seal. `credentials::LIVE_ACCOUNT_KEYS_MAX`
/// carries the number and the argument for it; this is the eviction.
///
/// **Oldest by `enrolled_seq`**, which is the site chain's own order and not a
/// clock: two keys registered in one second still have an order, and it is the
/// order the sealed chain records.
///
/// # Why this is not [`retire_key`]
///
/// That one is §8.4's verb: a steward or the holder signs
/// [`authority::retire_bytes`] and the act is filed on the ORGANISATION chain
/// as `account_key_retired`. Neither half fits here. There is no signature —
/// the act is the person registering an eleventh browser, and they have
/// already proved themselves to the session this runs under — and a
/// password-only account need belong to no organisation at all, so there may
/// be no org chain to file it on. **The record is therefore the row itself**:
/// `retired_at` is inside `account_key_row_state`, so the retirement is under
/// the row seal at version + 1 and a writer who clears it leaves an
/// unverifiable row, which is the same property `0018` §D states for a spent
/// token. The site-chain record of the act is the `authenticator_registered`
/// entry of the key that caused the eviction, appended in this same
/// transaction by the caller.
///
/// **Reported, not hidden**: there is no site-chain entry type for retiring an
/// account key (`0018` §F files `account_key_retired` on an org chain only),
/// and adding one means editing `chain_entries_type_belongs_to_kind`, which
/// every migration that touches it must re-list whole. That is a merge hazard
/// while three streams are in flight, so it is left for the lead — the
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
        // The seal before the change, as every other path here checks it: a
        // ring with one edited row is an incident, and evicting a row is not
        // the moment to stop noticing.
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
