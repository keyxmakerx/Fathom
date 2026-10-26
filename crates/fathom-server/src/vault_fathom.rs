//! **Logins Fathom itself can use: the vault's Mode B** (ADR-0042 §3, storage design §5 and
//! §13.4 to §13.5, ADR-0071 part two). `migrations/0043_vault_fathom.sql` carries the reasoning
//! for the tables.
//!
//! # What this adds to Mode A, and what it costs
//!
//! A Mode B login keeps everything Mode A gives it (the browser-sealed copy for each person who
//! holds it) and adds one more copy, sealed by this server under a key derived from `vault.key`,
//! that Fathom can open to use the login itself. **That copy protects against a stolen database
//! or backup. It does not protect against someone who has taken over the running server**: such
//! a person can ask this module to open it, or read the key file. The interface says so before
//! anyone consents, in the words of storage §13.4.
//!
//! # What enforces what, by function
//!
//! - [`turn_on`]: §13.5 R1 and R2. The caller must hold the login now (they hand Fathom the
//!   secret, which only a holder can open) and must be its owner. The consent is an ES256
//!   signature by the owner's account key over [`mode_change_bytes`], which names the server
//!   key that will read it, the signed recipient set at that moment and the share it came from,
//!   so a captured consent cannot be replayed against a changed login. A login shared with any
//!   other person waits for a different admin's countersignature ([`countersign`]) before
//!   Fathom will use it.
//! - [`refresh`]: a changed password (a new epoch) leaves Fathom's copy out of date; any current
//!   holder hands it the new one. No consent: the owner's still stands for this login.
//! - [`turn_off`]: §13.5 R3, the cheap direction. The owner or any admin. It un-discloses
//!   nothing, and the answer says so.
//! - [`use_login`]: Fathom opens the copy for one purpose on one device the login is marked as
//!   used on, for a person who may draw on that design. The `vault_read` chain entry is filed
//!   BEFORE the copy is opened, so a read that fails half way still leaves the record.

use std::fmt;

use deadpool_postgres::Transaction;
use fathom_canon::Json;
use sha2::{Digest, Sha256};

use crate::authority::Capability;
use crate::chain::EntryType;
use crate::chains;
use crate::crypto::{self, Key32, KeyId};
use crate::grants::{self, Authority, AuthorityError};
use crate::keyprovider::{KeyError, KeySource};
use crate::vault::{
    self, canonical_recipients, current_wrap, entry_metadata, fresh, hex, is_steward,
    live_person_key, lock_entry, require_steward, verify_account_signature, MetaOpener, Recipient,
    VaultError, MAX_SECRET_BYTES, RECOVERY_RECIPIENT,
};

const TAG_MODE: &[u8] = b"fathom/vault/mode/v1";
const TAG_COPY_KEY: &[u8] = b"fathom/vault/fathom-copy/key/v1";
const TAG_COPY_AAD: &[u8] = b"fathom/vault/fathom-copy/v1";

/// `FATHOM_VAULT_KEY`'s default, the slot ADR-0070's keys file already names.
pub const DEFAULT_VAULT_KEY: &str = "file:///var/lib/fathom/keys/vault.key";

/// What Fathom may open a login for. Each is a word on the login's card and in the history.
pub const PURPOSES: [&str; 2] = ["autopopulate", "check"];

// ---------------------------------------------------------------------------
// The server's vault key
// ---------------------------------------------------------------------------

/// `vault.key`: the root of every Fathom copy. A key of its own, beside `master.key` and
/// `chain.key`, so a copy of the database and the master key together still open no login.
pub struct FathomKey {
    key: Key32,
    source: String,
}

impl fmt::Debug for FathomKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FathomKey({})", self.key.id())
    }
}

impl FathomKey {
    /// Load through ADR-0043 §3's provider interface; a `file://` key is generated at first
    /// start, like the other two roots.
    pub fn load(source: &KeySource, create_if_missing: bool) -> Result<Self, KeyError> {
        Ok(Self {
            key: source.load(create_if_missing)?,
            source: source.describe(),
        })
    }

    pub fn from_key(key: Key32) -> Self {
        Self {
            key,
            source: "in memory".to_string(),
        }
    }

    pub fn id(&self) -> KeyId {
        self.key.id()
    }

    pub fn describe_source(&self) -> &str {
        &self.source
    }

    /// One key per organisation, so a copy cannot be moved between tenants and still open.
    fn copy_key(&self, organisation: &str) -> Key32 {
        let mut info = TAG_COPY_KEY.to_vec();
        crypto::lp(&mut info, organisation.as_bytes());
        crypto::hkdf_expand(&self.key, &info)
    }
}

fn copy_aad(organisation: &str, credential: &str, epoch: i32, key_id: &str) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, TAG_COPY_AAD);
    crypto::lp(&mut a, organisation.as_bytes());
    crypto::lp(&mut a, credential.as_bytes());
    crypto::u32_le(&mut a, epoch as u32);
    crypto::lp(&mut a, key_id.as_bytes());
    a
}

// ---------------------------------------------------------------------------
// The statement an owner signs
// ---------------------------------------------------------------------------

/// Storage §13.4's `mode_change_bytes`, with `org_chain_seq_at_request` bound to the
/// `vault_shared` entry of the epoch being consented to: the statement names the exact signed
/// recipient set it was made against, and a later share is a later sequence number.
#[allow(clippy::too_many_arguments)]
pub fn mode_change_bytes(
    organisation: &str,
    credential: &str,
    from_mode: &str,
    to_mode: &str,
    epoch_before: u32,
    epoch_after: u32,
    owner: &str,
    owner_key_fpr: &[u8],
    recipients: &[Recipient],
    server_key_id: &str,
    at: u64,
    share_seq: u64,
) -> Vec<u8> {
    let mut m = Vec::new();
    crypto::lp(&mut m, TAG_MODE);
    crypto::lp(&mut m, organisation.as_bytes());
    crypto::lp(&mut m, credential.as_bytes());
    crypto::lp(&mut m, from_mode.as_bytes());
    crypto::lp(&mut m, to_mode.as_bytes());
    crypto::u32_le(&mut m, epoch_before);
    crypto::u32_le(&mut m, epoch_after);
    crypto::lp(&mut m, owner.as_bytes());
    crypto::lp(&mut m, owner_key_fpr);
    crypto::lp(&mut m, &canonical_recipients(recipients));
    crypto::lp(&mut m, server_key_id.as_bytes());
    crypto::u64_le(&mut m, at);
    crypto::u64_le(&mut m, share_seq);
    m
}

/// What the browser sends with an A-to-B change.
#[derive(Clone, Debug)]
pub struct Consent {
    pub at: i64,
    pub key_fpr: Vec<u8>,
    pub signature: Vec<u8>,
    pub epoch_before: i32,
}

// ---------------------------------------------------------------------------
// The secret Fathom is handed
// ---------------------------------------------------------------------------

/// A login as Fathom holds it while it uses it: the user name and the password. The note
/// stays sealed for people. **No `Debug`, `Display` or `Clone`**, and the bytes are overwritten
/// on drop (best effort, as `crypto::Key32` says of itself).
pub struct UsedLogin {
    pub user: String,
    pub password: String,
}

impl Drop for UsedLogin {
    fn drop(&mut self) {
        wipe_string(&mut self.user);
        wipe_string(&mut self.password);
    }
}

fn wipe_string(s: &mut String) {
    let mut bytes = std::mem::take(s).into_bytes();
    wipe(&mut bytes);
}

fn wipe(bytes: &mut [u8]) {
    for b in bytes.iter_mut() {
        *b = 0;
    }
    core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
}

/// The secret as the browser seals it for people: `{"n":…,"p":…,"u":…}`, canonical. Fathom's
/// copy is the same bytes, so a holder hands over exactly what they opened.
fn check_secret_shape(plain: &[u8]) -> Result<(), VaultError> {
    if plain.is_empty() || plain.len() + crypto::TAG_LEN > MAX_SECRET_BYTES {
        return Err(VaultError::Malformed("login copy"));
    }
    match Json::parse_canonical(plain) {
        Ok(Json::Obj(m))
            if m.len() == 3
                && ["u", "p", "n"]
                    .iter()
                    .all(|k| matches!(m.get(*k), Some(Json::Str(_)))) =>
        {
            Ok(())
        }
        _ => Err(VaultError::Malformed(
            "a login copy is {u, p, n}, three strings, as canonical JSON",
        )),
    }
}

fn parse_secret(mut plain: Vec<u8>) -> Result<UsedLogin, VaultError> {
    let parsed = Json::parse_canonical(&plain);
    wipe(&mut plain);
    let Ok(Json::Obj(mut m)) = parsed else {
        return Err(VaultError::Corrupt("Fathom's copy is not a login"));
    };
    let (Some(Json::Str(user)), Some(Json::Str(password))) = (m.remove("u"), m.remove("p")) else {
        return Err(VaultError::Corrupt("Fathom's copy is not a login"));
    };
    if let Some(Json::Str(mut note)) = m.remove("n") {
        wipe_string(&mut note);
    }
    Ok(UsedLogin { user, password })
}

// ---------------------------------------------------------------------------
// Reading Fathom's copy row
// ---------------------------------------------------------------------------

/// Fathom's copy of one login, as its card shows it.
#[derive(Clone, Debug)]
pub struct FathomView {
    /// `waiting`, `on` or `off`.
    pub state: String,
    pub consented_by: String,
    pub consented_by_name: String,
    pub consent_at: i64,
    pub countersign_needed: bool,
    pub countersigned_by: Option<String>,
    pub countersigned_by_name: Option<String>,
    pub copy_epoch: i32,
    pub server_key_id: String,
    /// The statement the owner signed, for a countersigning admin to sign the same bytes.
    pub consent_bytes: Vec<u8>,
    pub reads: i64,
    pub last_read_ms: Option<i64>,
    pub last_purpose: Option<String>,
}

impl FathomView {
    pub fn to_json(&self) -> Json {
        let opt_s = |v: &Option<String>| v.as_ref().map_or(Json::Null, |x| Json::Str(x.clone()));
        Json::Obj(
            [
                ("state", Json::Str(self.state.clone())),
                ("consentedBy", Json::Str(self.consented_by.clone())),
                ("consentedByName", Json::Str(self.consented_by_name.clone())),
                ("consentAt", Json::Int(self.consent_at)),
                ("countersignNeeded", Json::Bool(self.countersign_needed)),
                ("countersignedBy", opt_s(&self.countersigned_by)),
                ("countersignedByName", opt_s(&self.countersigned_by_name)),
                ("copyEpoch", Json::Int(self.copy_epoch as i64)),
                ("serverKeyId", Json::Str(self.server_key_id.clone())),
                ("consentBytes", Json::Str(hex(&self.consent_bytes))),
                ("reads", Json::Int(self.reads)),
                ("lastRead", self.last_read_ms.map_or(Json::Null, Json::Int)),
                ("lastPurpose", opt_s(&self.last_purpose)),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        )
    }
}

/// Fathom's copy of one login, or nothing if it was never in Mode B.
pub async fn view_for(
    tx: &Transaction<'_>,
    tenant: &str,
    credential: &str,
) -> Result<Option<FathomView>, VaultError> {
    let Some(r) = tx
        .query_opt(
            "SELECT c.state, c.consented_by, \
                    coalesce((SELECT a.display_name FROM accounts a WHERE a.id = c.consented_by), ''), \
                    c.consent_at_unix, c.countersign_needed, c.countersigned_by, \
                    (SELECT a.display_name FROM accounts a WHERE a.id = c.countersigned_by), \
                    c.copy_epoch, c.server_key_id, c.consent_bytes, \
                    (SELECT count(*) FROM vault.fathom_reads r WHERE r.organisation_id = c.organisation_id \
                        AND r.entry_id = c.entry_id), \
                    (SELECT (extract(epoch from max(r.read_at)) * 1000)::bigint FROM vault.fathom_reads r \
                        WHERE r.organisation_id = c.organisation_id AND r.entry_id = c.entry_id), \
                    (SELECT r.purpose FROM vault.fathom_reads r WHERE r.organisation_id = c.organisation_id \
                        AND r.entry_id = c.entry_id ORDER BY r.read_at DESC LIMIT 1) \
             FROM vault.fathom_copies c WHERE c.organisation_id = $1 AND c.entry_id = $2",
            &[&tenant, &credential],
        )
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(FathomView {
        state: r.get(0),
        consented_by: r.get(1),
        consented_by_name: r.get(2),
        consent_at: r.get(3),
        countersign_needed: r.get(4),
        countersigned_by: r.get(5),
        countersigned_by_name: r.get(6),
        copy_epoch: r.get(7),
        server_key_id: r.get(8),
        consent_bytes: r.get(9),
        reads: r.get(10),
        last_read_ms: r.get(11),
        last_purpose: r.get(12),
    }))
}

// ---------------------------------------------------------------------------
// The recipient set and share of the current epoch, as the server stored them
// ---------------------------------------------------------------------------

async fn recipients_at(
    tx: &Transaction<'_>,
    tenant: &str,
    credential: &str,
    epoch: i32,
) -> Result<Vec<Recipient>, VaultError> {
    tx.query(
        "SELECT k.kind, k.account_id, k.fpr, w.wrap_digest FROM vault.wraps w JOIN vault.keys k \
           ON k.organisation_id = w.organisation_id AND k.id = w.recipient_key_id \
         WHERE w.organisation_id = $1 AND w.entry_id = $2 AND w.epoch = $3",
        &[&tenant, &credential, &epoch],
    )
    .await?
    .iter()
    .map(|r| {
        let kind: String = r.get(0);
        let who = if kind == "recovery" {
            RECOVERY_RECIPIENT.to_string()
        } else {
            r.get::<_, Option<String>>(1)
                .ok_or(VaultError::Corrupt("person key without an account"))?
        };
        Ok(Recipient {
            who,
            key_fpr: vault::arr32(&r.get::<_, Vec<u8>>(2)),
            digest: vault::arr32(&r.get::<_, Vec<u8>>(3)),
        })
    })
    .collect()
}

async fn share_seq_at(
    tx: &Transaction<'_>,
    tenant: &str,
    credential: &str,
    epoch: i32,
) -> Result<i64, VaultError> {
    Ok(tx
        .query_opt(
            "SELECT chain_seq FROM vault.shares WHERE organisation_id = $1 AND entry_id = $2 \
             AND epoch = $3",
            &[&tenant, &credential, &epoch],
        )
        .await?
        .ok_or(VaultError::Corrupt("an epoch without its share"))?
        .get(0))
}

/// The caller holds a live wrap at the login's current epoch: §13.5 R1 as the server sees it.
async fn require_holder(
    tx: &Transaction<'_>,
    tenant: &str,
    me: &str,
    credential: &str,
    epoch: i32,
    why: &'static str,
) -> Result<(), VaultError> {
    let mine = live_person_key(tx, tenant, me)
        .await?
        .ok_or(VaultError::NoVaultKey)?;
    if current_wrap(tx, tenant, credential, epoch, Some(&mine))
        .await?
        .is_none()
    {
        return Err(VaultError::NotAllowed(why));
    }
    Ok(())
}

fn seal_copy(
    fk: &FathomKey,
    tenant: &str,
    credential: &str,
    epoch: i32,
    mut plain: Vec<u8>,
) -> Result<(Vec<u8>, Vec<u8>, String), VaultError> {
    let shape = check_secret_shape(&plain);
    if let Err(e) = shape {
        wipe(&mut plain);
        return Err(e);
    }
    let key_id = fk.id().to_string();
    let nonce = crypto::random_nonce()?;
    let sealed = crypto::seal(
        &fk.copy_key(tenant),
        &nonce,
        &plain,
        &copy_aad(tenant, credential, epoch, &key_id),
    );
    wipe(&mut plain);
    Ok((sealed?, nonce.to_vec(), key_id))
}

fn mode_metadata(
    credential: &str,
    from: &str,
    to: &str,
    epoch: i32,
    fk_id: &str,
    by: &str,
    extra: Vec<(&'static str, Json)>,
) -> Vec<(&'static str, Json)> {
    let mut fields: Vec<(&'static str, Json)> = vec![
        ("credential", Json::Str(credential.to_string())),
        ("from", Json::Str(from.to_string())),
        ("to", Json::Str(to.to_string())),
        ("epoch", Json::Int(epoch as i64)),
        ("server_key", Json::Str(fk_id.to_string())),
        ("by", Json::Str(by.to_string())),
    ];
    fields.extend(extra);
    fields
}

// ---------------------------------------------------------------------------
// The acts
// ---------------------------------------------------------------------------

/// A to B. The owner, holding it now, with a signed consent; see the module comment.
#[allow(clippy::too_many_arguments)]
pub async fn turn_on(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    credential: &str,
    if_version: i64,
    consent: Consent,
    secret: Vec<u8>,
) -> Result<FathomView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let mut secret = secret;
    let checked = async {
        let row = lock_entry(tx, &tenant, credential).await?;
        let (version, epoch, owner): (i64, i32, String) = (row.get(0), row.get(1), row.get(2));
        if version != if_version {
            return Err(VaultError::Conflict { version });
        }
        if owner != me {
            return Err(VaultError::NotAllowed(
                "only the person who stored this login can let Fathom use it",
            ));
        }
        require_holder(
            tx,
            &tenant,
            &me,
            credential,
            epoch,
            "open this login in your own vault first",
        )
        .await?;
        if let Some(existing) = view_for(tx, &tenant, credential).await? {
            if existing.state != "off" {
                return Err(VaultError::NotAllowed("Fathom can already use this login"));
            }
        }
        // A to B rotates the content key, so the people who hold it are re-established
        // explicitly at the moment it becomes server-readable (§13.4: epoch_after > before).
        if consent.epoch_before < 1 || consent.epoch_before >= epoch {
            return Err(VaultError::NotAllowed(
                "share the login again first, so it has a fresh key, then let Fathom use it",
            ));
        }
        fresh(consent.at)?;
        let recipients = recipients_at(tx, &tenant, credential, epoch).await?;
        let seq = share_seq_at(tx, &tenant, credential, epoch).await?;
        let bytes = mode_change_bytes(
            &tenant,
            credential,
            "A",
            "B",
            consent.epoch_before as u32,
            epoch as u32,
            &me,
            &consent.key_fpr,
            &recipients,
            &fk.id().to_string(),
            consent.at as u64,
            seq as u64,
        );
        verify_account_signature(
            tx,
            auth,
            &me,
            &consent.key_fpr,
            &bytes,
            &consent.signature,
            consent.at,
        )
        .await?;
        let others = recipients
            .iter()
            .any(|r| r.who != me && r.who != RECOVERY_RECIPIENT);
        Ok::<_, VaultError>((epoch, bytes, others))
    }
    .await;
    let (epoch, bytes, others) = match checked {
        Ok(v) => v,
        Err(e) => {
            wipe(&mut secret);
            return Err(e);
        }
    };
    let (ct, nonce, key_id) = seal_copy(fk, &tenant, credential, epoch, secret)?;
    let state = if others { "waiting" } else { "on" };
    let digest = hex(&Sha256::digest(&bytes));
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultModeChanged,
        &entry_metadata(
            EntryType::VaultModeChanged,
            &mode_metadata(
                credential,
                "A",
                "B",
                epoch,
                &key_id,
                &me,
                vec![
                    (
                        "stage",
                        Json::Str(if others { "consented" } else { "in force" }.to_string()),
                    ),
                    ("consent_digest", Json::Str(digest)),
                ],
            ),
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO vault.fathom_copies (organisation_id, entry_id, state, consented_by, \
            consent_bytes, consent_key_fpr, consent_sig, consent_at_unix, countersign_needed, \
            copy_epoch, server_key_id, copy_nonce, copy_ct, updated_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $4) \
         ON CONFLICT (organisation_id, entry_id) DO UPDATE SET state = EXCLUDED.state, \
            consented_by = EXCLUDED.consented_by, consent_bytes = EXCLUDED.consent_bytes, \
            consent_key_fpr = EXCLUDED.consent_key_fpr, consent_sig = EXCLUDED.consent_sig, \
            consent_at_unix = EXCLUDED.consent_at_unix, \
            countersign_needed = EXCLUDED.countersign_needed, countersigned_by = NULL, \
            countersign_key_fpr = NULL, countersign_sig = NULL, countersigned_at_unix = NULL, \
            copy_epoch = EXCLUDED.copy_epoch, server_key_id = EXCLUDED.server_key_id, \
            copy_nonce = EXCLUDED.copy_nonce, copy_ct = EXCLUDED.copy_ct, \
            updated_by = EXCLUDED.updated_by, updated_at = now()",
        &[
            &tenant,
            &credential,
            &state,
            &me,
            &bytes,
            &consent.key_fpr,
            &consent.signature,
            &consent.at,
            &others,
            &epoch,
            &key_id,
            &nonce,
            &ct,
        ],
    )
    .await?;
    view_for(tx, &tenant, credential)
        .await?
        .ok_or(VaultError::Corrupt("the copy just written"))
}

/// A different admin signs the same statement the owner signed, for a login shared with other
/// people (§13.5 R2's "friction scales with blast radius").
pub async fn countersign(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    key_fpr: Vec<u8>,
    signature: Vec<u8>,
    at: i64,
) -> Result<FathomView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    require_steward(tx, auth).await?;
    let row = lock_entry(tx, &tenant, credential).await?;
    let epoch: i32 = row.get(1);
    let copy = view_for(tx, &tenant, credential)
        .await?
        .ok_or(VaultError::NotFound)?;
    if copy.state != "waiting" {
        return Err(VaultError::NotAllowed(
            "this login is not waiting for an admin's signature",
        ));
    }
    if copy.consented_by == me {
        return Err(VaultError::NotAllowed(
            "another admin signs this, not the person who asked",
        ));
    }
    if copy.copy_epoch != epoch {
        return Err(VaultError::NotAllowed(
            "this login changed since it was asked; its owner asks again",
        ));
    }
    fresh(at)?;
    verify_account_signature(tx, auth, &me, &key_fpr, &copy.consent_bytes, &signature, at).await?;
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultModeChanged,
        &entry_metadata(
            EntryType::VaultModeChanged,
            &mode_metadata(
                credential,
                "A",
                "B",
                epoch,
                &copy.server_key_id,
                &me,
                vec![
                    ("stage", Json::Str("countersigned".to_string())),
                    (
                        "consent_digest",
                        Json::Str(hex(&Sha256::digest(&copy.consent_bytes))),
                    ),
                ],
            ),
        ),
    )
    .await?;
    tx.execute(
        "UPDATE vault.fathom_copies SET state = 'on', countersigned_by = $3, \
            countersign_key_fpr = $4, countersign_sig = $5, countersigned_at_unix = $6, \
            updated_by = $3, updated_at = now() \
         WHERE organisation_id = $1 AND entry_id = $2",
        &[&tenant, &credential, &me, &key_fpr, &signature, &at],
    )
    .await?;
    view_for(tx, &tenant, credential)
        .await?
        .ok_or(VaultError::Corrupt("the copy just written"))
}

/// Hand Fathom the login again after it changed. Any current holder; Mode B stays in force.
pub async fn refresh(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    credential: &str,
    secret: Vec<u8>,
) -> Result<FathomView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let mut secret = secret;
    let checked = async {
        let row = lock_entry(tx, &tenant, credential).await?;
        let epoch: i32 = row.get(1);
        let copy = view_for(tx, &tenant, credential)
            .await?
            .ok_or(VaultError::NotAllowed(
                "Fathom cannot use this login; its owner can let it",
            ))?;
        if copy.state == "off" {
            return Err(VaultError::NotAllowed(
                "Fathom cannot use this login; its owner can let it",
            ));
        }
        // A login still waiting for its countersignature is not refreshed: the statement the
        // owner signed names the holders of the epoch it was made at, and an admin must not
        // countersign it over a different set. Its owner asks again instead.
        if copy.state == "waiting" {
            return Err(VaultError::NotAllowed(
                "this login changed while it waited for an admin; its owner asks again",
            ));
        }
        require_holder(
            tx,
            &tenant,
            &me,
            credential,
            epoch,
            "only someone who holds this login can hand Fathom the new one",
        )
        .await?;
        Ok::<_, VaultError>(epoch)
    }
    .await;
    let epoch = match checked {
        Ok(e) => e,
        Err(e) => {
            wipe(&mut secret);
            return Err(e);
        }
    };
    let (ct, nonce, key_id) = seal_copy(fk, &tenant, credential, epoch, secret)?;
    tx.execute(
        "UPDATE vault.fathom_copies SET copy_epoch = $3, server_key_id = $4, copy_nonce = $5, \
            copy_ct = $6, updated_by = $7, updated_at = now() \
         WHERE organisation_id = $1 AND entry_id = $2",
        &[&tenant, &credential, &epoch, &key_id, &nonce, &ct, &me],
    )
    .await?;
    view_for(tx, &tenant, credential)
        .await?
        .ok_or(VaultError::Corrupt("the copy just written"))
}

/// B to A. The owner or any admin. Empties Fathom's copy; un-discloses nothing.
pub async fn turn_off(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
) -> Result<FathomView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let row = lock_entry(tx, &tenant, credential).await?;
    let (epoch, owner): (i32, String) = (row.get(1), row.get(2));
    if owner != me && !is_steward(tx, auth).await? {
        return Err(VaultError::NotAllowed(
            "only the person who stored it, or an admin, can stop Fathom using it",
        ));
    }
    let copy = view_for(tx, &tenant, credential)
        .await?
        .ok_or(VaultError::NotAllowed("Fathom cannot use this login now"))?;
    if copy.state == "off" {
        return Err(VaultError::NotAllowed("Fathom cannot use this login now"));
    }
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultModeChanged,
        &entry_metadata(
            EntryType::VaultModeChanged,
            &mode_metadata(
                credential,
                "B",
                "A",
                epoch,
                &copy.server_key_id,
                &me,
                vec![("stage", Json::Str("in force".to_string()))],
            ),
        ),
    )
    .await?;
    tx.execute(
        "UPDATE vault.fathom_copies SET state = 'off', copy_ct = ''::bytea, updated_by = $3, \
            updated_at = now() WHERE organisation_id = $1 AND entry_id = $2",
        &[&tenant, &credential, &me],
    )
    .await?;
    view_for(tx, &tenant, credential)
        .await?
        .ok_or(VaultError::Corrupt("the copy just written"))
}

/// Fathom opens a Mode B login to use it on `(design, element)` for `purpose`, at the request
/// of the signed-in person, who must be able to draw on that design. Filed on the chain first.
pub async fn use_login(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    fk: &FathomKey,
    credential: &str,
    design: &str,
    element: &str,
    purpose: &str,
) -> Result<UsedLogin, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    if !PURPOSES.contains(&purpose) {
        return Err(VaultError::Malformed("purpose"));
    }
    let scope = tx
        .query_opt(
            "SELECT scope_id FROM designs WHERE id = $1 AND organisation_id = $2",
            &[&design, &tenant],
        )
        .await?
        .ok_or(VaultError::NotFound)?
        .get::<_, String>(0)
        .parse::<crate::repo::ScopeId>()
        .map_err(|_| VaultError::Corrupt("design scope id"))?;
    match grants::authorise_account(tx, auth, Some(scope), Capability::Draw).await {
        Ok(_) => {}
        Err(AuthorityError::NotAuthorised) => {
            return Err(VaultError::NotAllowed(
                "Fathom uses a login only for someone who can draw on that design",
            ))
        }
        Err(e) => return Err(e.into()),
    }
    let row = tx
        .query_opt(
            "SELECT e.epoch, e.meta_ct, e.meta_nonce, e.meta_key_epoch, c.state, c.copy_epoch, \
                    c.server_key_id, c.copy_nonce, c.copy_ct \
             FROM vault.entries e JOIN vault.fathom_copies c \
               ON c.organisation_id = e.organisation_id AND c.entry_id = e.id \
             WHERE e.organisation_id = $1 AND e.id = $2 AND e.deleted_at IS NULL",
            &[&tenant, &credential],
        )
        .await?
        .ok_or(VaultError::NotAllowed(
            "Fathom cannot use this login; its owner can let it",
        ))?;
    let (epoch, state, copy_epoch, key_id): (i32, String, i32, String) =
        (row.get(0), row.get(4), row.get(5), row.get(6));
    match state.as_str() {
        "on" => {}
        "waiting" => {
            return Err(VaultError::NotAllowed(
                "this login waits for another admin to sign before Fathom may use it",
            ))
        }
        _ => {
            return Err(VaultError::NotAllowed(
                "Fathom cannot use this login; its owner can let it",
            ))
        }
    }
    if copy_epoch != epoch {
        return Err(VaultError::NotAllowed(
            "this login changed since Fathom was given it; someone who holds it opens it once to hand Fathom the new one",
        ));
    }
    if key_id != fk.id().to_string() {
        tracing::error!(
            copy_key = %key_id,
            configured_key = %fk.id(),
            "a Fathom copy was sealed under a different vault.key than the one configured"
        );
        return Err(VaultError::NotAllowed(
            "Fathom's copy of this login was made under a different vault key than this server has; restore that key file, or have someone who holds the login hand it over again",
        ));
    }
    let mut opener = MetaOpener {
        auth,
        keys: Default::default(),
    };
    let meta = opener
        .open(
            tx,
            credential,
            &row.get::<_, Vec<u8>>(1),
            &row.get::<_, Vec<u8>>(2),
            row.get(3),
        )
        .await?;
    if !meta
        .used_on
        .iter()
        .any(|(d, e)| d == design && e == element)
    {
        return Err(VaultError::NotAllowed(
            "this login is not marked as used on that device",
        ));
    }
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultRead,
        &entry_metadata(
            EntryType::VaultRead,
            &[
                ("credential", Json::Str(credential.to_string())),
                ("epoch", Json::Int(epoch as i64)),
                ("purpose", Json::Str(purpose.to_string())),
                ("design", Json::Str(design.to_string())),
                ("element", Json::Str(element.to_string())),
                ("asked_by", Json::Str(me.clone())),
                ("server_key", Json::Str(key_id.clone())),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO vault.fathom_reads (organisation_id, id, entry_id, epoch, purpose, design_id, \
            element_id, asked_by, chain_seq) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        &[
            &tenant,
            &crate::ids::new_ulid().to_string(),
            &credential,
            &epoch,
            &purpose,
            &design,
            &element,
            &me,
            &appended.seq,
        ],
    )
    .await?;
    let nonce: [u8; crypto::NONCE_LEN] = row
        .get::<_, Vec<u8>>(7)
        .as_slice()
        .try_into()
        .map_err(|_| VaultError::Corrupt("Fathom copy nonce"))?;
    let plain = crypto::open(
        &fk.copy_key(&tenant),
        &nonce,
        &row.get::<_, Vec<u8>>(8),
        &copy_aad(&tenant, credential, epoch, &key_id),
    )
    .map_err(|_| VaultError::Corrupt("Fathom's copy did not open"))?;
    parse_secret(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Canonical JSON as `to_canonical_bytes` writes it: one trailing newline.
    fn canon(text: &str) -> Vec<u8> {
        format!("{text}\n").into_bytes()
    }

    #[test]
    fn a_copy_is_three_strings_and_nothing_else() {
        assert!(check_secret_shape(&canon(r#"{"n":"","p":"x","u":"admin"}"#)).is_ok());
        assert!(check_secret_shape(&canon(r#"{"p":"x","u":"admin"}"#)).is_err());
        assert!(check_secret_shape(&canon(r#"{"n":"","p":1,"u":"admin"}"#)).is_err());
        assert!(check_secret_shape(&canon(r#"{"n":"","p":"x","u":"admin","z":""}"#)).is_err());
        assert!(check_secret_shape(b"").is_err());
    }

    #[test]
    fn a_copy_opens_only_for_its_organisation_login_and_epoch() {
        let fk = FathomKey::from_key(Key32::from_bytes([7; 32]));
        let plain = canon(r#"{"n":"","p":"s3cret-Pass!","u":"admin"}"#);
        let (ct, nonce, key_id) =
            seal_copy(&fk, "01JORG", "cred_X", 3, plain.clone()).expect("seal");
        let nonce: [u8; 12] = nonce.try_into().unwrap();
        let open = |org: &str, cred: &str, epoch: i32| {
            crypto::open(
                &fk.copy_key(org),
                &nonce,
                &ct,
                &copy_aad(org, cred, epoch, &key_id),
            )
        };
        assert_eq!(open("01JORG", "cred_X", 3).unwrap(), plain);
        assert!(
            open("01JOTHER", "cred_X", 3).is_err(),
            "another organisation"
        );
        assert!(open("01JORG", "cred_Y", 3).is_err(), "another login");
        assert!(open("01JORG", "cred_X", 4).is_err(), "another epoch");
        let other = FathomKey::from_key(Key32::from_bytes([8; 32]));
        assert!(crypto::open(
            &other.copy_key("01JORG"),
            &nonce,
            &ct,
            &copy_aad("01JORG", "cred_X", 3, &key_id)
        )
        .is_err());
    }
    /// Shared with `client/src/vault/bytes.test.ts`: the same fixed inputs and the same pinned
    /// SHA-256, so the browser's consent and the server's check cannot drift apart.
    #[test]
    fn the_consent_bytes_match_the_clients() {
        let account = "01JACC0000000000000000000B";
        let bytes = mode_change_bytes(
            "01JORG0000000000000000000A",
            "cred_01JCRED000000000000000000",
            "A",
            "B",
            2,
            3,
            account,
            &[0x11; 32],
            &[
                Recipient {
                    who: "recovery".into(),
                    key_fpr: [3; 32],
                    digest: [4; 32],
                },
                Recipient {
                    who: account.into(),
                    key_fpr: [5; 32],
                    digest: [6; 32],
                },
            ],
            "0123456789abcdef",
            1_761_400_000,
            41,
        );
        assert_eq!(
            vault::hex(&Sha256::digest(&bytes)),
            "9ff91a76deeba277d39400308bfb32b227ad55ffb97ec3529719a8d212ff5fc7",
            "the consent bytes changed: the client's builder must change with it"
        );
    }
}
