//! **The password vault, Mode A** (ADR-0042, ADR-0043 §6, storage design §5 and §13,
//! ADR-0071). `migrations/0042_vault.sql` carries the reasoning for every table and fence.
//!
//! # What the server holds, and what it cannot do
//!
//! Every password is sealed in the browser under a random content key; the content key is
//! wrapped in the browser to each recipient's vault public key (§13.7); the set of recipients
//! is signed in the browser by the sharer's account key (§13.3). This module stores those
//! bytes, checks their shape and their signatures, files the acts on the organisation chain,
//! and decides who may ask for what. **It never holds a key that opens a password**, and no
//! function here takes or returns one.
//!
//! Stewards see that each login exists, its name, where it is used, who holds it and how old
//! it is, because the name and the "used on" list are sealed under the organisation content
//! key, which the server holds. They read a password only if it was shared with them.
//!
//! # What enforces what, by function
//!
//! - [`overview`]: one read for the whole vault surface. A non-steward sees the entries they
//!   hold a live wrap for; a steward of the organisation sees every entry's metadata, and the
//!   ciphertext of only those they hold. A wrap no signed share covers is never served.
//! - [`enrol_key`]: a person's own key, or the recovery sheet (stewards only). The signature
//!   must verify against a live account key of the caller; a replacement needs a succession
//!   signature over the old and new fingerprints.
//! - [`create_entry`], [`new_epoch`]: the signed recipient set is rebuilt here from the rows
//!   submitted and must equal what was signed; every recipient key must be live in this
//!   organisation; every wrap must parse, carry a point on the curve, and be bound by its
//!   digest. Only a current holder (or a steward working from the recovery sheet) may start a
//!   new epoch: §13.5 R1, "only a principal who can currently decrypt it", is a consequence of
//!   the cryptography, and this check is the server agreeing with it, not the fence.
//! - [`revoke_wrap`], [`delete_entry`]: the cheap, widely held direction (§13.5 R3): the owner
//!   or any steward. Neither revokes what was already read, and the answers say so.
//! - [`open_recovery`]: a steward, with the sheet in hand, is served the recovery key's sealed
//!   private half and every recovery wrap. The act is sealed on the chain BEFORE anything is
//!   served and stays on the admin page for everyone to see.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use deadpool_postgres::Transaction;
use fathom_canon::Json;
use sha2::{Digest, Sha256};

use crate::authority::{self, Capability};
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError};
use crate::crypto;
use crate::field_defs::is_unsafe_char;
use crate::grants::{self, Authority, AuthorityError};
use crate::keys::{self, KeyStoreError};

/// `vault_alg = 1`: ECDH P-256 + HKDF-SHA256 + AES-256-GCM (§13.7).
pub const ALG: i16 = 1;

const TAG_KEY: &[u8] = b"fathom/vault/pubkey/v1";
const TAG_RECOVERY: &[u8] = b"fathom/vault/recovery/v1";
const TAG_FPR: &[u8] = b"fathom/vault/key/fpr/v1";
const TAG_SUPERSEDE: &[u8] = b"fathom/vault/supersede/v1";
const TAG_SHARE: &[u8] = b"fathom/vault/share/v1";
const TAG_WRAP_DIGEST: &[u8] = b"fathom/vault/wrap/digest/v1";
const TAG_META: &[u8] = b"fathom/vault/meta/v1";

/// A share or enrolment timestamp more than this far from the server's clock is refused, so a
/// captured signature cannot be replayed months later.
pub const CLOCK_SKEW_SECONDS: i64 = 600;
/// Logins one organisation may hold, and holders one login may have.
pub const MAX_ENTRIES: i64 = 5_000;
pub const MAX_RECIPIENTS: usize = 64;
/// Devices one login can be marked as used on.
pub const MAX_USED_ON: usize = 200;
pub const MAX_NAME_CHARS: usize = 120;
/// The browser-sealed secret: user name, password and note, plus the AEAD tag.
pub const MAX_SECRET_BYTES: usize = 8_192;
/// What a login is for. Shown on the Logins tab; decides nothing.
pub const KINDS: [&str; 5] = ["login", "snmp", "wifi", "api", "other"];
/// The recipient id a recovery sheet takes in a signed set, beside account ids.
pub const RECOVERY_RECIPIENT: &str = "recovery";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum VaultError {
    Db(tokio_postgres::Error),
    Keys(KeyStoreError),
    Chain(ChainStoreError),
    Crypto(crypto::CryptoError),
    Authority(AuthorityError),
    /// The request is not shaped like one this API takes. The words say which part.
    Malformed(&'static str),
    /// Understood, and not allowed for this person. The words are for the person.
    NotAllowed(&'static str),
    /// No such login in this organisation (or not one this person may see).
    NotFound,
    /// The login changed since the caller read it.
    Conflict {
        version: i64,
    },
    /// The caller has no live vault key in this organisation yet.
    NoVaultKey,
    /// This server has no `vault.key` (an install whose keys volume predates it), so the acts
    /// that need Fathom's own key are off.
    NoServerKey,
    /// A stored row did not open or is not shaped like one this server wrote.
    Corrupt(&'static str),
    /// An outside vault could not be reached, or answered with something Fathom cannot use
    /// (ADR-0071 part four). The words are for the person and name no secret.
    OutsideUnreachable(String),
    /// An outside vault's account failed a check, so Fathom will not connect to it or read it.
    OutsideRefused(String),
}

impl core::fmt::Display for VaultError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database: {e}"),
            Self::Keys(e) => write!(f, "keys: {e}"),
            Self::Chain(e) => write!(f, "chain: {e}"),
            Self::Crypto(e) => write!(f, "crypto: {e:?}"),
            Self::Authority(e) => write!(f, "authority: {e}"),
            Self::Malformed(why) => write!(f, "malformed: {why}"),
            Self::NotAllowed(why) => write!(f, "not allowed: {why}"),
            Self::NotFound => write!(f, "no such login"),
            Self::Conflict { version } => write!(f, "changed; now at version {version}"),
            Self::NoVaultKey => write!(f, "no vault key"),
            Self::NoServerKey => write!(f, "this server has no vault.key"),
            Self::Corrupt(what) => write!(f, "corrupt: {what}"),
            Self::OutsideUnreachable(why) => write!(f, "outside vault unreachable: {why}"),
            Self::OutsideRefused(why) => write!(f, "outside vault refused: {why}"),
        }
    }
}

impl From<tokio_postgres::Error> for VaultError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}
impl From<KeyStoreError> for VaultError {
    fn from(e: KeyStoreError) -> Self {
        Self::Keys(e)
    }
}
impl From<ChainStoreError> for VaultError {
    fn from(e: ChainStoreError) -> Self {
        Self::Chain(e)
    }
}
impl From<crypto::CryptoError> for VaultError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::Crypto(e)
    }
}
impl From<AuthorityError> for VaultError {
    fn from(e: AuthorityError) -> Self {
        Self::Authority(e)
    }
}

fn bad(why: &'static str) -> VaultError {
    VaultError::Malformed(why)
}

// ---------------------------------------------------------------------------
// The bytes that get signed. The client builds the same bytes (`client/src/vault/bytes.ts`)
// and `tests/vault.rs` pins one vector of each against it.
// ---------------------------------------------------------------------------

/// §13.2's fingerprint: `H("fathom/vault/key/fpr/v1" ‖ LP(vault_pub))`.
pub fn key_fpr(public_key: &[u8]) -> [u8; 32] {
    let mut m = TAG_FPR.to_vec();
    crypto::lp(&mut m, public_key);
    Sha256::digest(&m).into()
}

/// §13.2's `vault_key_bytes`, signed by the person's own account key.
pub fn person_key_bytes(
    organisation: &str,
    account: &str,
    public_key: &[u8],
    signer_key_fpr: &[u8],
    enrolled_at: u64,
) -> Vec<u8> {
    let mut m = Vec::new();
    crypto::lp(&mut m, TAG_KEY);
    crypto::lp(&mut m, organisation.as_bytes());
    crypto::lp(&mut m, account.as_bytes());
    crypto::lp(&mut m, public_key);
    crypto::u16_le(&mut m, ALG as u16);
    crypto::lp(&mut m, signer_key_fpr);
    crypto::u64_le(&mut m, enrolled_at);
    m
}

/// The recovery sheet's enrolment, signed by the steward who made it.
pub fn recovery_key_bytes(
    organisation: &str,
    public_key: &[u8],
    created_by: &str,
    signer_key_fpr: &[u8],
    enrolled_at: u64,
) -> Vec<u8> {
    let mut m = Vec::new();
    crypto::lp(&mut m, TAG_RECOVERY);
    crypto::lp(&mut m, organisation.as_bytes());
    crypto::lp(&mut m, public_key);
    crypto::u16_le(&mut m, ALG as u16);
    crypto::lp(&mut m, created_by.as_bytes());
    crypto::lp(&mut m, signer_key_fpr);
    crypto::u64_le(&mut m, enrolled_at);
    m
}

/// A replacement: the old key's fingerprint and the new one's, signed by the account key of
/// whoever replaces it (the person themselves, or a steward for the recovery sheet). Signed by
/// the account key and not the old vault key, because the usual reason is that the old vault
/// key can no longer be opened.
pub fn supersede_bytes(
    organisation: &str,
    kind: &str,
    subject: &str,
    old_fpr: &[u8],
    new_fpr: &[u8],
    at: u64,
) -> Vec<u8> {
    let mut m = Vec::new();
    crypto::lp(&mut m, TAG_SUPERSEDE);
    crypto::lp(&mut m, organisation.as_bytes());
    crypto::lp(&mut m, kind.as_bytes());
    crypto::lp(&mut m, subject.as_bytes());
    crypto::lp(&mut m, old_fpr);
    crypto::lp(&mut m, new_fpr);
    crypto::u64_le(&mut m, at);
    m
}

/// `H("fathom/vault/wrap/digest/v1" ‖ LP(wrap))`, §13.7.
pub fn wrap_digest(wrap: &[u8]) -> [u8; 32] {
    let mut m = TAG_WRAP_DIGEST.to_vec();
    crypto::lp(&mut m, wrap);
    Sha256::digest(&m).into()
}

/// One member of a signed recipient set.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Recipient {
    /// An account id, or [`RECOVERY_RECIPIENT`].
    pub who: String,
    pub key_fpr: [u8; 32],
    pub digest: [u8; 32],
}

/// The canonical recipient list: `[[who, fpr_hex, digest_hex], ...]`, sorted, as canonical
/// JSON (no spaces, one trailing newline, as `to_canonical_bytes` writes it). Plain ASCII strings only, so the client's `JSON.stringify` of the same
/// sorted arrays is byte-identical.
pub fn canonical_recipients(recipients: &[Recipient]) -> Vec<u8> {
    let mut sorted: Vec<&Recipient> = recipients.iter().collect();
    sorted.sort();
    Json::Arr(
        sorted
            .into_iter()
            .map(|r| {
                Json::Arr(vec![
                    Json::Str(r.who.clone()),
                    Json::Str(hex(&r.key_fpr)),
                    Json::Str(hex(&r.digest)),
                ])
            })
            .collect(),
    )
    .to_canonical_bytes()
}

/// §13.3's `share_bytes`.
pub fn share_bytes(
    organisation: &str,
    credential: &str,
    epoch: u32,
    recipients: &[Recipient],
    sharer: &str,
    sharer_key_fpr: &[u8],
    at: u64,
) -> Vec<u8> {
    let mut m = Vec::new();
    crypto::lp(&mut m, TAG_SHARE);
    crypto::lp(&mut m, organisation.as_bytes());
    crypto::lp(&mut m, credential.as_bytes());
    crypto::u32_le(&mut m, epoch);
    crypto::lp(&mut m, &canonical_recipients(recipients));
    crypto::lp(&mut m, sharer.as_bytes());
    crypto::lp(&mut m, sharer_key_fpr);
    crypto::u64_le(&mut m, at);
    m
}

fn meta_aad(organisation: &str, credential: &str, key_epoch: i32) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, TAG_META);
    crypto::lp(&mut a, organisation.as_bytes());
    crypto::lp(&mut a, credential.as_bytes());
    crypto::u32_le(&mut a, key_epoch as u32);
    a
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Lower-case hex of exactly `len` bytes, or the named refusal.
pub fn unhex(text: &str, len: Option<usize>, what: &'static str) -> Result<Vec<u8>, VaultError> {
    if !text.len().is_multiple_of(2)
        || !text
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(bad(what));
    }
    let out: Vec<u8> = (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("checked above"))
        .collect();
    if len.is_some_and(|l| out.len() != l) {
        return Err(bad(what));
    }
    Ok(out)
}

pub(crate) fn arr32(v: &[u8]) -> [u8; 32] {
    let mut a = [0u8; 32];
    a.copy_from_slice(v);
    a
}

/// A SEC1 uncompressed P-256 point that is actually on the curve (§13.7 rule 3).
pub fn valid_point(public_key: &[u8]) -> bool {
    public_key.len() == 65
        && public_key[0] == 4
        && p256::PublicKey::from_sec1_bytes(public_key).is_ok()
}

/// `wrap = LP(eph_pub) ‖ LP(nonce_96) ‖ LP(ciphertext)` with a 65-byte point on the curve, a
/// 12-byte nonce and a 48-byte ciphertext (a 32-byte key plus the tag).
pub fn valid_wrap(wrap: &[u8]) -> bool {
    let Some((eph, rest)) = crypto::read_lp(wrap) else {
        return false;
    };
    let Some((nonce, rest)) = crypto::read_lp(rest) else {
        return false;
    };
    let Some((ct, rest)) = crypto::read_lp(rest) else {
        return false;
    };
    rest.is_empty() && valid_point(eph) && nonce.len() == 12 && ct.len() == 48
}

pub(crate) fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn fresh(at: i64) -> Result<(), VaultError> {
    if (at - now_unix()).abs() > CLOCK_SKEW_SECONDS {
        return Err(VaultError::NotAllowed(
            "this computer's clock is more than ten minutes away from the server's; fix the clock and try again",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The metadata the server seals: name, kind, where it is used
// ---------------------------------------------------------------------------

/// What a steward may see about a login.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Meta {
    pub name: String,
    pub kind: String,
    /// `(design id, element id)` pairs.
    pub used_on: Vec<(String, String)>,
}

impl Meta {
    /// Cleaned and bounded, or refused. A name the redaction gate's bare check reads as a
    /// credential is refused: the name is server-readable, so a password typed into it would
    /// arrive where passwords must not (CLAUDE.md rule 4).
    pub fn clean(
        name: &str,
        kind: &str,
        used_on: Vec<(String, String)>,
    ) -> Result<Self, VaultError> {
        if name.chars().any(is_unsafe_char) {
            return Err(bad(
                "a name must not contain control or invisible characters",
            ));
        }
        let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            return Err(bad("a name is 1 to 120 characters"));
        }
        if fathom_ingest::redact::looks_like_credential_bare(&name) {
            return Err(VaultError::NotAllowed(
                "that name looks as if it carries the password itself; the name is what admins see, so give it a plain name and put the password in the password box",
            ));
        }
        if !KINDS.contains(&kind) {
            return Err(bad("kind is one of login, snmp, wifi, api, other"));
        }
        if used_on.len() > MAX_USED_ON {
            return Err(bad("a login can be marked on at most 200 devices"));
        }
        let mut seen = BTreeSet::new();
        for (design, element) in &used_on {
            if fathom_id::Ulid::decode(design)
                .map(|u| u.to_string())
                .as_deref()
                != Ok(design)
            {
                return Err(bad("a used-on design is a ULID"));
            }
            if element.is_empty()
                || element.len() > 64
                || !element
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b':' | b'-' | b'_' | b'.'))
            {
                return Err(bad("a used-on element is an element id"));
            }
            if !seen.insert((design.clone(), element.clone())) {
                return Err(bad("a device is listed twice"));
            }
        }
        Ok(Self {
            name,
            kind: kind.to_string(),
            used_on,
        })
    }

    pub(crate) fn to_canonical(&self) -> Vec<u8> {
        let mut m = BTreeMap::new();
        m.insert("name".to_string(), Json::Str(self.name.clone()));
        m.insert("kind".to_string(), Json::Str(self.kind.clone()));
        m.insert(
            "usedOn".to_string(),
            Json::Arr(
                self.used_on
                    .iter()
                    .map(|(d, e)| Json::Arr(vec![Json::Str(d.clone()), Json::Str(e.clone())]))
                    .collect(),
            ),
        );
        Json::Obj(m).to_canonical_bytes()
    }

    pub(crate) fn from_canonical(bytes: &[u8]) -> Result<Self, VaultError> {
        let Ok(Json::Obj(mut m)) = Json::parse_canonical(bytes) else {
            return Err(VaultError::Corrupt("vault metadata"));
        };
        let (Some(Json::Str(name)), Some(Json::Str(kind)), Some(Json::Arr(list))) =
            (m.remove("name"), m.remove("kind"), m.remove("usedOn"))
        else {
            return Err(VaultError::Corrupt("vault metadata"));
        };
        let mut used_on = Vec::with_capacity(list.len());
        for item in list {
            match item {
                Json::Arr(pair) => match pair.as_slice() {
                    [Json::Str(d), Json::Str(e)] => used_on.push((d.clone(), e.clone())),
                    _ => return Err(VaultError::Corrupt("vault metadata")),
                },
                _ => return Err(VaultError::Corrupt("vault metadata")),
            }
        }
        Ok(Self {
            name,
            kind,
            used_on,
        })
    }
}

async fn seal_meta(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    meta: &Meta,
) -> Result<(Vec<u8>, Vec<u8>, i32), VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let key = keys::org_content_key(tx, auth.ctx, auth.tenant_key).await?;
    let nonce = crypto::random_nonce()?;
    let ct = crypto::seal(
        &key.key,
        &nonce,
        &meta.to_canonical(),
        &meta_aad(&tenant, credential, key.epoch),
    )?;
    keys::count_write_under_org_content_key(tx, &tenant, key.epoch).await?;
    Ok((ct, nonce.to_vec(), key.epoch))
}

pub(crate) struct MetaOpener<'a> {
    pub(crate) auth: &'a Authority<'a>,
    pub(crate) keys: BTreeMap<i32, crypto::Key32>,
}

impl MetaOpener<'_> {
    pub(crate) async fn open(
        &mut self,
        tx: &Transaction<'_>,
        credential: &str,
        ct: &[u8],
        nonce: &[u8],
        epoch: i32,
    ) -> Result<Meta, VaultError> {
        if !self.keys.contains_key(&epoch) {
            let key =
                keys::org_content_key_at_epoch(tx, self.auth.ctx, self.auth.tenant_key, epoch)
                    .await?;
            self.keys.insert(epoch, key);
        }
        let nonce: [u8; crypto::NONCE_LEN] = nonce
            .try_into()
            .map_err(|_| VaultError::Corrupt("vault metadata nonce"))?;
        let tenant = self.auth.ctx.tenant().to_string();
        let plain = crypto::open(
            &self.keys[&epoch],
            &nonce,
            ct,
            &meta_aad(&tenant, credential, epoch),
        )
        .map_err(|_| VaultError::Corrupt("vault metadata did not open"))?;
        Meta::from_canonical(&plain)
    }
}

// ---------------------------------------------------------------------------
// Who the caller is
// ---------------------------------------------------------------------------

pub(crate) async fn is_steward(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
) -> Result<bool, VaultError> {
    match grants::authorise_account(tx, auth, None, Capability::Steward).await {
        Ok(_) => Ok(true),
        Err(AuthorityError::NotAuthorised) | Err(AuthorityError::QuorumNotMet { .. }) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

pub(crate) async fn require_steward(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
) -> Result<(), VaultError> {
    if is_steward(tx, auth).await? {
        Ok(())
    } else {
        Err(VaultError::NotAllowed(
            "only an admin of the organisation can do that",
        ))
    }
}

/// Verify an ES256 signature by an account key of `account`, named by its fingerprint and in
/// service at `at`. The key row's own seal is checked first (`grants::key_by_fingerprint`).
pub(crate) async fn verify_account_signature(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    account: &str,
    signer_fpr: &[u8],
    message: &[u8],
    signature: &[u8],
    at: i64,
) -> Result<(), VaultError> {
    if signer_fpr.len() != 32 {
        return Err(bad("signer key fingerprint"));
    }
    let key = grants::key_by_fingerprint(tx, auth.ring, &arr32(signer_fpr), at).await?;
    if key.account_id != account {
        return Err(VaultError::NotAllowed(
            "that signature is not from one of your own keys",
        ));
    }
    authority::verify_es256(&key.public_key, message, signature)
        .map_err(|e| VaultError::Authority(AuthorityError::from(e)))
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// One vault key as the API returns it. `sealed_private` and the KDF columns are included
/// only for the caller's own key.
#[derive(Clone, Debug)]
pub struct KeyView {
    pub id: String,
    pub kind: String,
    pub account: Option<String>,
    pub created_by: String,
    pub public_key: Vec<u8>,
    pub fpr: Vec<u8>,
    pub signer_key_fpr: Vec<u8>,
    /// The signer's account public key, so a browser can check the signature itself.
    pub signer_public_key: Vec<u8>,
    pub enrolled_at: i64,
    pub signature: Vec<u8>,
    /// For the caller's own key: what unlocking needs.
    pub own: Option<OwnKey>,
    /// The key this one replaced, with the account-key signature over both fingerprints.
    pub supersedes: Option<Supersession>,
}

#[derive(Clone, Debug)]
pub struct OwnKey {
    pub sealed_private: Vec<u8>,
    pub sealed_nonce: Vec<u8>,
    pub kdf_salt: Option<Vec<u8>>,
    pub kdf_m: Option<i32>,
    pub kdf_t: Option<i32>,
    pub kdf_p: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct Supersession {
    pub old_fpr: Vec<u8>,
    pub at: i64,
    pub signature: Vec<u8>,
}

const KEY_COLUMNS: &str = "k.id, k.kind, k.account_id, k.created_by, k.public_key, k.fpr, \
     k.signer_key_fpr, k.enrolled_at_unix, k.signature, k.sealed_private, k.sealed_nonce, \
     k.kdf_salt, k.kdf_m_kib, k.kdf_t, k.kdf_p, \
     (SELECT a.public_key FROM account_keys a WHERE a.fpr = k.signer_key_fpr), \
     (SELECT o.fpr FROM vault.keys o WHERE o.organisation_id = k.organisation_id \
        AND o.superseded_by = k.id), \
     (SELECT (extract(epoch from o.superseded_at))::bigint FROM vault.keys o \
        WHERE o.organisation_id = k.organisation_id AND o.superseded_by = k.id), \
     (SELECT o.succession_sig FROM vault.keys o WHERE o.organisation_id = k.organisation_id \
        AND o.superseded_by = k.id)";

fn key_view(row: &tokio_postgres::Row, me: &str) -> KeyView {
    let kind: String = row.get(1);
    let account: Option<String> = row.get(2);
    let own = (kind == "person" && account.as_deref() == Some(me)).then(|| OwnKey {
        sealed_private: row.get(9),
        sealed_nonce: row.get(10),
        kdf_salt: row.get(11),
        kdf_m: row.get(12),
        kdf_t: row.get(13),
        kdf_p: row.get(14),
    });
    let supersedes = match (
        row.get::<_, Option<Vec<u8>>>(16),
        row.get::<_, Option<i64>>(17),
        row.get::<_, Option<Vec<u8>>>(18),
    ) {
        (Some(old_fpr), Some(at), Some(signature)) => Some(Supersession {
            old_fpr,
            at,
            signature,
        }),
        _ => None,
    };
    KeyView {
        id: row.get(0),
        kind,
        account,
        created_by: row.get(3),
        public_key: row.get(4),
        fpr: row.get(5),
        signer_key_fpr: row.get(6),
        enrolled_at: row.get(7),
        signature: row.get(8),
        signer_public_key: row.get::<_, Option<Vec<u8>>>(15).unwrap_or_default(),
        own,
        supersedes,
    }
}

/// What a browser sends to enrol a key.
#[derive(Clone, Debug)]
pub struct Enrolment {
    pub kind: String,
    pub public_key: Vec<u8>,
    pub sealed_private: Vec<u8>,
    pub sealed_nonce: Vec<u8>,
    pub kdf: Option<(Vec<u8>, i32, i32, i32)>,
    pub signer_key_fpr: Vec<u8>,
    pub enrolled_at: i64,
    pub signature: Vec<u8>,
    /// Present when this replaces a live key: the account-key signature over
    /// [`supersede_bytes`].
    pub succession_sig: Option<Vec<u8>>,
}

/// Enrol the caller's own vault key, or (stewards only) the organisation's recovery sheet.
pub async fn enrol_key(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    e: Enrolment,
) -> Result<KeyView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let recovery = match e.kind.as_str() {
        "person" => false,
        "recovery" => true,
        _ => return Err(bad("kind is person or recovery")),
    };
    if recovery {
        require_steward(tx, auth).await?;
        if e.kdf.is_some() {
            return Err(bad("a recovery sheet has no passphrase settings"));
        }
    } else if e.kdf.is_none() {
        return Err(bad("a person's key carries its passphrase settings"));
    }
    if !valid_point(&e.public_key) {
        return Err(bad("public key is not a P-256 point"));
    }
    if e.sealed_nonce.len() != 12 || !(16..=512).contains(&e.sealed_private.len()) {
        return Err(bad("sealed private key"));
    }
    if let Some((salt, m, t, p)) = &e.kdf {
        let ok = salt.len() == 16
            && (19_456..=262_144).contains(m)
            && (2..=10).contains(t)
            && (1..=4).contains(p);
        if !ok {
            return Err(bad("passphrase settings out of range"));
        }
    }
    fresh(e.enrolled_at)?;
    let fpr = key_fpr(&e.public_key);
    let signed = if recovery {
        recovery_key_bytes(
            &tenant,
            &e.public_key,
            &me,
            &e.signer_key_fpr,
            e.enrolled_at as u64,
        )
    } else {
        person_key_bytes(
            &tenant,
            &me,
            &e.public_key,
            &e.signer_key_fpr,
            e.enrolled_at as u64,
        )
    };
    verify_account_signature(
        tx,
        auth,
        &me,
        &e.signer_key_fpr,
        &signed,
        &e.signature,
        e.enrolled_at,
    )
    .await?;

    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        &[&format!("vault_keys:{tenant}")],
    )
    .await?;
    let live = if recovery {
        tx.query_opt(
            "SELECT id, fpr FROM vault.keys WHERE organisation_id = $1 AND kind = 'recovery' \
             AND superseded_by IS NULL FOR UPDATE",
            &[&tenant],
        )
        .await?
    } else {
        tx.query_opt(
            "SELECT id, fpr FROM vault.keys WHERE organisation_id = $1 AND kind = 'person' \
             AND account_id = $2 AND superseded_by IS NULL FOR UPDATE",
            &[&tenant, &me],
        )
        .await?
    };
    let id = crate::ids::new_ulid().to_string();
    let replaced = match (live, &e.succession_sig) {
        (None, None) => None,
        (None, Some(_)) => return Err(bad("there is no key to replace")),
        (Some(_), None) => {
            return Err(VaultError::NotAllowed(if recovery {
                "this organisation already has a recovery sheet; replacing it needs a signed replacement"
            } else {
                "you already have a vault here; resetting it needs a signed replacement"
            }))
        }
        (Some(row), Some(sig)) => {
            let old_id: String = row.get(0);
            let old_fpr: Vec<u8> = row.get(1);
            let subject = if recovery { "" } else { me.as_str() };
            let bytes = supersede_bytes(
                &tenant,
                &e.kind,
                subject,
                &old_fpr,
                &fpr,
                e.enrolled_at as u64,
            );
            verify_account_signature(tx, auth, &me, &e.signer_key_fpr, &bytes, sig, e.enrolled_at)
                .await?;
            Some((old_id, old_fpr, sig.clone()))
        }
    };

    let mut fields = vec![
        ("vault_key", Json::Str(id.clone())),
        ("kind", Json::Str(e.kind.clone())),
        ("fpr", Json::Str(hex(&fpr))),
        ("signer_key_fpr", Json::Str(hex(&e.signer_key_fpr))),
        ("created_by", Json::Str(me.clone())),
    ];
    if let Some((old_id, old_fpr, _)) = &replaced {
        fields.push(("replaces", Json::Str(old_id.clone())));
        fields.push(("replaces_fpr", Json::Str(hex(old_fpr))));
    }
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultKeyEnrolled,
        &entry_metadata(EntryType::VaultKeyEnrolled, &fields),
    )
    .await?;

    let (salt, m, t, p) = match &e.kdf {
        Some((s, m, t, p)) => (Some(s.clone()), Some(*m), Some(*t), Some(*p)),
        None => (None, None, None, None),
    };
    let account = (!recovery).then(|| me.clone());
    // The old key steps aside first: the partial unique index allows one live key per person,
    // and `superseded_by` names the new id before its row exists (it is not a foreign key).
    if let Some((old_id, _, sig)) = &replaced {
        tx.execute(
            "UPDATE vault.keys SET superseded_by = $3, superseded_at = to_timestamp($4), \
             succession_sig = $5 WHERE organisation_id = $1 AND id = $2",
            &[&tenant, old_id, &id, &(e.enrolled_at as f64), sig],
        )
        .await?;
    }
    tx.execute(
        "INSERT INTO vault.keys (organisation_id, id, kind, account_id, created_by, public_key, \
         fpr, alg, kdf_salt, kdf_m_kib, kdf_t, kdf_p, sealed_private, sealed_nonce, \
         signer_key_fpr, enrolled_at_unix, signature, chain_seq) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
        &[
            &tenant,
            &id,
            &e.kind,
            &account,
            &me,
            &e.public_key,
            &fpr.to_vec(),
            &ALG,
            &salt,
            &m,
            &t,
            &p,
            &e.sealed_private,
            &e.sealed_nonce,
            &e.signer_key_fpr,
            &e.enrolled_at,
            &e.signature,
            &appended.seq,
        ],
    )
    .await?;
    if let Some((old_id, old_fpr, _)) = replaced {
        chains::append_org(
            tx,
            auth.ring,
            auth.ctx,
            auth.tenant_key,
            EntryType::VaultKeySuperseded,
            &entry_metadata(
                EntryType::VaultKeySuperseded,
                &[
                    ("vault_key", Json::Str(old_id)),
                    ("kind", Json::Str(e.kind.clone())),
                    ("old_fpr", Json::Str(hex(&old_fpr))),
                    ("new_fpr", Json::Str(hex(&fpr))),
                    ("by", Json::Str(me.clone())),
                ],
            ),
        )
        .await?;
    }
    let row = tx
        .query_one(
            &format!(
                "SELECT {KEY_COLUMNS} FROM vault.keys k WHERE k.organisation_id = $1 AND k.id = $2"
            ),
            &[&tenant, &id],
        )
        .await?;
    Ok(key_view(&row, &me))
}

pub(crate) fn entry_metadata(entry_type: EntryType, fields: &[(&str, Json)]) -> Vec<u8> {
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

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/// One recipient wrap as submitted.
#[derive(Clone, Debug)]
pub struct WrapIn {
    pub key_id: String,
    pub wrap: Vec<u8>,
}

/// A signed recipient set for one epoch, as submitted.
#[derive(Clone, Debug)]
pub struct ShareIn {
    pub at: i64,
    pub sharer_key_fpr: Vec<u8>,
    pub signature: Vec<u8>,
    pub wraps: Vec<WrapIn>,
    /// A steward working from the recovery sheet rather than from their own wrap.
    pub via_recovery: bool,
}

/// Check a submitted share against the live keys, rebuild the signed bytes, verify the
/// signature, and return the recipients with their key rows' ids.
async fn check_share(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    epoch: i32,
    share: &ShareIn,
) -> Result<Vec<(String, Recipient)>, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    fresh(share.at)?;
    if share.wraps.is_empty() || share.wraps.len() > MAX_RECIPIENTS {
        return Err(bad("a login is held by 1 to 64 keys"));
    }
    let mut out = Vec::with_capacity(share.wraps.len());
    let mut who_seen = BTreeSet::new();
    for w in &share.wraps {
        if !valid_wrap(&w.wrap) {
            return Err(bad(
                "a wrap is not shaped as LP(point) LP(nonce) LP(ciphertext)",
            ));
        }
        let row = tx
            .query_opt(
                "SELECT kind, account_id, fpr FROM vault.keys \
                 WHERE organisation_id = $1 AND id = $2 AND superseded_by IS NULL",
                &[&tenant, &w.key_id],
            )
            .await?
            .ok_or(VaultError::NotAllowed(
                "one of the people chosen has reset their vault since this page loaded; reload and choose again",
            ))?;
        let kind: String = row.get(0);
        let who = if kind == "recovery" {
            RECOVERY_RECIPIENT.to_string()
        } else {
            row.get::<_, Option<String>>(1)
                .ok_or(VaultError::Corrupt("person key without an account"))?
        };
        if !who_seen.insert(who.clone()) {
            return Err(bad("a recipient is listed twice"));
        }
        let fpr: Vec<u8> = row.get(2);
        out.push((
            w.key_id.clone(),
            Recipient {
                who,
                key_fpr: arr32(&fpr),
                digest: wrap_digest(&w.wrap),
            },
        ));
    }
    let recipients: Vec<Recipient> = out.iter().map(|(_, r)| r.clone()).collect();
    let bytes = share_bytes(
        &tenant,
        credential,
        epoch as u32,
        &recipients,
        &me,
        &share.sharer_key_fpr,
        share.at as u64,
    );
    verify_account_signature(
        tx,
        auth,
        &me,
        &share.sharer_key_fpr,
        &bytes,
        &share.signature,
        share.at,
    )
    .await?;
    Ok(out)
}

async fn write_share(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    epoch: i32,
    share: &ShareIn,
    recipients: &[(String, Recipient)],
    reason: &str,
) -> Result<(), VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let list: Vec<Recipient> = recipients.iter().map(|(_, r)| r.clone()).collect();
    let bytes = share_bytes(
        &tenant,
        credential,
        epoch as u32,
        &list,
        &me,
        &share.sharer_key_fpr,
        share.at as u64,
    );
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultShared,
        &entry_metadata(
            EntryType::VaultShared,
            &[
                ("credential", Json::Str(credential.to_string())),
                ("epoch", Json::Int(epoch as i64)),
                ("reason", Json::Str(reason.to_string())),
                ("sharer", Json::Str(me.clone())),
                ("sharer_key_fpr", Json::Str(hex(&share.sharer_key_fpr))),
                ("via_recovery", Json::Bool(share.via_recovery)),
                (
                    "recipients",
                    Json::parse_canonical(&canonical_recipients(&list))
                        .map_err(|_| VaultError::Corrupt("recipient list"))?,
                ),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO vault.shares (organisation_id, entry_id, epoch, sharer, sharer_key_fpr, \
         share_bytes, signature, via_recovery, at_unix, chain_seq) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        &[
            &tenant,
            &credential,
            &epoch,
            &me,
            &share.sharer_key_fpr,
            &bytes,
            &share.signature,
            &share.via_recovery,
            &share.at,
            &appended.seq,
        ],
    )
    .await?;
    for (key_id, r) in recipients {
        let wrap = share
            .wraps
            .iter()
            .find(|w| &w.key_id == key_id)
            .map(|w| w.wrap.clone())
            .ok_or(VaultError::Corrupt("wrap for a checked recipient"))?;
        tx.execute(
            "INSERT INTO vault.wraps (organisation_id, entry_id, epoch, recipient_key_id, wrap, \
             wrap_digest) VALUES ($1, $2, $3, $4, $5, $6)",
            &[
                &tenant,
                &credential,
                &epoch,
                key_id,
                &wrap,
                &r.digest.to_vec(),
            ],
        )
        .await?;
    }
    Ok(())
}

/// A new login. The creator owns it and must be one of its holders.
#[allow(clippy::too_many_arguments)]
pub async fn create_entry(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    meta: Meta,
    secret_ct: Vec<u8>,
    secret_nonce: Vec<u8>,
    share: ShareIn,
) -> Result<EntryView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    clean_credential_id(credential)?;
    check_secret(&secret_ct, &secret_nonce)?;
    if share.via_recovery {
        return Err(bad("a new login is shared from your own vault"));
    }
    let my_key = live_person_key(tx, &tenant, &me)
        .await?
        .ok_or(VaultError::NoVaultKey)?;
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        &[&format!("vault_entries:{tenant}")],
    )
    .await?;
    let count: i64 = tx
        .query_one(
            "SELECT count(*) FROM vault.entries WHERE organisation_id = $1 AND deleted_at IS NULL",
            &[&tenant],
        )
        .await?
        .get(0);
    if count >= MAX_ENTRIES {
        return Err(VaultError::NotAllowed(
            "this organisation already holds 5,000 logins, the most it may",
        ));
    }
    let exists = tx
        .query_opt(
            "SELECT 1 FROM vault.entries WHERE organisation_id = $1 AND id = $2",
            &[&tenant, &credential],
        )
        .await?;
    if exists.is_some() {
        return Err(bad("that login id is taken"));
    }
    let recipients = check_share(tx, auth, credential, 1, &share).await?;
    if !recipients.iter().any(|(k, _)| k == &my_key) {
        return Err(bad("you must hold a login you store"));
    }
    let (meta_ct, meta_nonce, meta_epoch) = seal_meta(tx, auth, credential, &meta).await?;
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultEntryCreated,
        &entry_metadata(
            EntryType::VaultEntryCreated,
            &[
                ("credential", Json::Str(credential.to_string())),
                ("owner", Json::Str(me.clone())),
                ("mode", Json::Str("A".to_string())),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO vault.entries (organisation_id, id, owner, created_by, meta_ct, meta_nonce, \
         meta_key_epoch, epoch, secret_ct, secret_nonce, updated_by) \
         VALUES ($1, $2, $3, $3, $4, $5, $6, 1, $7, $8, $3)",
        &[
            &tenant,
            &credential,
            &me,
            &meta_ct,
            &meta_nonce,
            &meta_epoch,
            &secret_ct,
            &secret_nonce,
        ],
    )
    .await?;
    write_share(tx, auth, credential, 1, &share, &recipients, "created").await?;
    entry_by_id(tx, auth, credential).await
}

/// A new epoch: a changed password, a changed set of holders, or a rotation after someone's
/// access was taken away. Always a fresh content key and fresh wraps.
#[allow(clippy::too_many_arguments)]
pub async fn new_epoch(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    if_version: i64,
    secret_ct: Vec<u8>,
    secret_nonce: Vec<u8>,
    share: ShareIn,
    reason: &str,
) -> Result<EntryView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    if !["changed", "shared", "rotated"].contains(&reason) {
        return Err(bad("reason is changed, shared or rotated"));
    }
    check_secret(&secret_ct, &secret_nonce)?;
    let row = lock_entry(tx, &tenant, credential).await?;
    let (version, epoch, owner): (i64, i32, String) = (row.get(0), row.get(1), row.get(2));
    if version != if_version {
        return Err(VaultError::Conflict { version });
    }
    if share.via_recovery {
        require_steward(tx, auth).await?;
        if current_wrap(tx, &tenant, credential, epoch, None)
            .await?
            .is_none()
        {
            return Err(VaultError::NotAllowed(
                "the recovery sheet does not hold this login",
            ));
        }
        let opened = tx
            .query_opt(
                "SELECT 1 FROM vault.recovery_uses WHERE organisation_id = $1 AND used_by = $2 \
                 AND used_at > now() - interval '1 hour'",
                &[&tenant, &me],
            )
            .await?;
        if opened.is_none() {
            return Err(VaultError::NotAllowed(
                "open the recovery sheet first; it stays open for an hour",
            ));
        }
    } else {
        let mine = live_person_key(tx, &tenant, &me)
            .await?
            .ok_or(VaultError::NoVaultKey)?;
        if current_wrap(tx, &tenant, credential, epoch, Some(&mine))
            .await?
            .is_none()
        {
            return Err(VaultError::NotAllowed(
                "only someone who holds this login can change it or who holds it",
            ));
        }
    }
    let next = epoch + 1;
    let recipients = check_share(tx, auth, credential, next, &share).await?;
    // The owner stays a holder while they have a vault here: a holder can share it on, but
    // cannot take it away from the person it belongs to.
    if let Some(owner_key) = live_person_key(tx, &tenant, &owner).await? {
        if !recipients.iter().any(|(k, _)| k == &owner_key) {
            return Err(VaultError::NotAllowed(
                "the person who stored this login must keep it",
            ));
        }
    }
    let changed = tx
        .execute(
            "UPDATE vault.entries SET epoch = $3, secret_ct = $4, secret_nonce = $5, \
             version = version + 1, updated_at = now(), updated_by = $6, needs_rotation = false \
             WHERE organisation_id = $1 AND id = $2 AND deleted_at IS NULL",
            &[&tenant, &credential, &next, &secret_ct, &secret_nonce, &me],
        )
        .await?;
    if changed != 1 {
        return Err(VaultError::NotFound);
    }
    write_share(tx, auth, credential, next, &share, &recipients, reason).await?;
    entry_by_id(tx, auth, credential).await
}

/// Rename a login, or change what it is or where it is used. Holders and admins.
pub async fn set_meta(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    if_version: i64,
    meta: Meta,
) -> Result<EntryView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let row = lock_entry(tx, &tenant, credential).await?;
    let (version, epoch): (i64, i32) = (row.get(0), row.get(1));
    if version != if_version {
        return Err(VaultError::Conflict { version });
    }
    let holds = match live_person_key(tx, &tenant, &me).await? {
        Some(k) => current_wrap(tx, &tenant, credential, epoch, Some(&k))
            .await?
            .is_some(),
        None => false,
    };
    if !holds && !is_steward(tx, auth).await? {
        return Err(VaultError::NotFound);
    }
    let (ct, nonce, key_epoch) = seal_meta(tx, auth, credential, &meta).await?;
    tx.execute(
        "UPDATE vault.entries SET meta_ct = $3, meta_nonce = $4, meta_key_epoch = $5, \
         version = version + 1, updated_at = now(), updated_by = $6 \
         WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &credential, &ct, &nonce, &key_epoch, &me],
    )
    .await?;
    entry_by_id(tx, auth, credential).await
}

/// Stop serving one holder's wrap. The owner or an admin. **This revokes nothing already
/// read**: the person still holds whatever they saw, and the login is marked for rotation so
/// the next holder to open it replaces the content key. The real revocation is changing the
/// password on the device, and the interface says so at this moment.
pub async fn revoke_wrap(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    if_version: i64,
    key_id: &str,
) -> Result<EntryView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let row = lock_entry(tx, &tenant, credential).await?;
    let (version, epoch, owner): (i64, i32, String) = (row.get(0), row.get(1), row.get(2));
    if version != if_version {
        return Err(VaultError::Conflict { version });
    }
    if owner != me && !is_steward(tx, auth).await? {
        return Err(VaultError::NotAllowed(
            "only the person who stored it, or an admin, can take someone's access away",
        ));
    }
    if live_person_key(tx, &tenant, &owner).await?.as_deref() == Some(key_id) {
        return Err(VaultError::NotAllowed(
            "the person who stored this login keeps it; delete it instead",
        ));
    }
    let changed = tx
        .execute(
            "UPDATE vault.wraps SET revoked_at = now(), revoked_by = $5 \
             WHERE organisation_id = $1 AND entry_id = $2 AND epoch = $3 \
               AND recipient_key_id = $4 AND revoked_at IS NULL",
            &[&tenant, &credential, &epoch, &key_id, &me],
        )
        .await?;
    if changed != 1 {
        return Err(bad("that key does not hold this login"));
    }
    tx.execute(
        "UPDATE vault.entries SET needs_rotation = true, version = version + 1, \
         updated_at = now(), updated_by = $3 WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &credential, &me],
    )
    .await?;
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultShareRevoked,
        &entry_metadata(
            EntryType::VaultShareRevoked,
            &[
                ("credential", Json::Str(credential.to_string())),
                ("epoch", Json::Int(epoch as i64)),
                ("vault_key", Json::Str(key_id.to_string())),
                ("by", Json::Str(me.clone())),
                ("remediation", Json::Str("none".to_string())),
            ],
        ),
    )
    .await?;
    entry_by_id(tx, auth, credential).await
}

/// Delete a login: the ciphertext is overwritten and the tombstone kept. The owner or an
/// admin. A copy anyone already read is not deleted by this, and neither is the password on
/// the device.
pub async fn delete_entry(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    if_version: i64,
) -> Result<(), VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let row = lock_entry(tx, &tenant, credential).await?;
    let (version, owner): (i64, String) = (row.get(0), row.get(2));
    if version != if_version {
        return Err(VaultError::Conflict { version });
    }
    if owner != me && !is_steward(tx, auth).await? {
        return Err(VaultError::NotAllowed(
            "only the person who stored it, or an admin, can delete it",
        ));
    }
    tx.execute(
        "UPDATE vault.entries SET secret_ct = ''::bytea, deleted_at = now(), deleted_by = $3, \
         version = version + 1, updated_at = now(), updated_by = $3 \
         WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &credential, &me],
    )
    .await?;
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultEntryDeleted,
        &entry_metadata(
            EntryType::VaultEntryDeleted,
            &[
                ("credential", Json::Str(credential.to_string())),
                ("by", Json::Str(me)),
            ],
        ),
    )
    .await?;
    Ok(())
}

pub(crate) fn clean_credential_id(id: &str) -> Result<(), VaultError> {
    let ok = id
        .strip_prefix("cred_")
        .is_some_and(|u| fathom_id::Ulid::decode(u).is_ok_and(|x| x.to_string() == u));
    if ok {
        Ok(())
    } else {
        Err(bad("a login id is cred_ and a ULID"))
    }
}

fn check_secret(ct: &[u8], nonce: &[u8]) -> Result<(), VaultError> {
    if nonce.len() != 12 || ct.len() < 17 || ct.len() > MAX_SECRET_BYTES {
        return Err(bad("sealed secret"));
    }
    Ok(())
}

pub(crate) async fn live_person_key(
    tx: &Transaction<'_>,
    tenant: &str,
    account: &str,
) -> Result<Option<String>, VaultError> {
    Ok(tx
        .query_opt(
            "SELECT id FROM vault.keys WHERE organisation_id = $1 AND kind = 'person' \
             AND account_id = $2 AND superseded_by IS NULL",
            &[&tenant, &account],
        )
        .await?
        .map(|r| r.get(0)))
}

/// The live (unrevoked) wrap at `epoch` for `key` (or, with `None`, for the live recovery key).
pub(crate) async fn current_wrap(
    tx: &Transaction<'_>,
    tenant: &str,
    credential: &str,
    epoch: i32,
    key: Option<&str>,
) -> Result<Option<Vec<u8>>, VaultError> {
    let row = match key {
        Some(k) => {
            tx.query_opt(
                "SELECT w.wrap FROM vault.wraps w WHERE w.organisation_id = $1 \
                 AND w.entry_id = $2 AND w.epoch = $3 AND w.recipient_key_id = $4 \
                 AND w.revoked_at IS NULL",
                &[&tenant, &credential, &epoch, &k],
            )
            .await?
        }
        None => {
            tx.query_opt(
                "SELECT w.wrap FROM vault.wraps w JOIN vault.keys k \
                   ON k.organisation_id = w.organisation_id AND k.id = w.recipient_key_id \
                 WHERE w.organisation_id = $1 AND w.entry_id = $2 AND w.epoch = $3 \
                   AND k.kind = 'recovery' AND k.superseded_by IS NULL AND w.revoked_at IS NULL",
                &[&tenant, &credential, &epoch],
            )
            .await?
        }
    };
    Ok(row.map(|r| r.get(0)))
}

pub(crate) async fn lock_entry(
    tx: &Transaction<'_>,
    tenant: &str,
    credential: &str,
) -> Result<tokio_postgres::Row, VaultError> {
    clean_credential_id(credential)?;
    tx.query_opt(
        "SELECT version, epoch, owner FROM vault.entries \
         WHERE organisation_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
        &[&tenant, &credential],
    )
    .await?
    .ok_or(VaultError::NotFound)
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// One holder of a login at its current epoch.
#[derive(Clone, Debug)]
pub struct Holder {
    pub key_id: String,
    pub kind: String,
    pub account: Option<String>,
    pub name: String,
    pub fpr: Vec<u8>,
    pub digest: Vec<u8>,
    pub revoked: bool,
    /// The key has been replaced since: this wrap opens for nobody any more.
    pub stale: bool,
}

/// What a browser needs to open a login it holds.
#[derive(Clone, Debug)]
pub struct Opening {
    pub key_id: String,
    pub wrap: Vec<u8>,
    pub secret_ct: Vec<u8>,
    pub secret_nonce: Vec<u8>,
    pub sharer: String,
    pub sharer_key_fpr: Vec<u8>,
    pub sharer_public_key: Vec<u8>,
    pub share_at: i64,
    pub signature: Vec<u8>,
    pub via_recovery: bool,
}

#[derive(Clone, Debug)]
pub struct EntryView {
    pub id: String,
    pub meta: Meta,
    pub owner: String,
    pub owner_name: String,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub updated_by: String,
    pub version: i64,
    pub epoch: i32,
    pub needs_rotation: bool,
    pub holders: Vec<Holder>,
    pub opening: Option<Opening>,
    /// The `vault_shared` chain entry of the current epoch: the sequence an owner's consent to
    /// Mode B names (`vault_fathom::mode_change_bytes`).
    pub share_seq: i64,
    /// Fathom's own copy (Mode B), if this login was ever given one.
    pub fathom: Option<crate::vault_fathom::FathomView>,
    /// Marked critical: checked weekly, a breached password refused (`vault_breach.rs`).
    pub critical: bool,
    /// What a holder's browser last found for the current epoch, if it was checked.
    pub breach: Option<crate::vault_breach::Result_>,
}

const ENTRY_COLUMNS: &str = "e.id, e.owner, e.meta_ct, e.meta_nonce, e.meta_key_epoch, \
     e.epoch, e.version, e.needs_rotation, e.secret_ct, e.secret_nonce, e.updated_by, \
     (extract(epoch from e.created_at) * 1000)::bigint, \
     (extract(epoch from e.updated_at) * 1000)::bigint, \
     (SELECT a.display_name FROM accounts a WHERE a.id = e.owner)";

async fn build_entry(
    tx: &Transaction<'_>,
    opener: &mut MetaOpener<'_>,
    tenant: &str,
    my_key: Option<&str>,
    row: &tokio_postgres::Row,
) -> Result<EntryView, VaultError> {
    let id: String = row.get(0);
    let epoch: i32 = row.get(5);
    let meta = opener
        .open(
            tx,
            &id,
            &row.get::<_, Vec<u8>>(2),
            &row.get::<_, Vec<u8>>(3),
            row.get(4),
        )
        .await?;
    let holders = tx
        .query(
            "SELECT w.recipient_key_id, k.kind, k.account_id, \
                    coalesce((SELECT a.display_name FROM accounts a WHERE a.id = k.account_id), ''), \
                    k.fpr, w.wrap_digest, w.revoked_at IS NOT NULL, k.superseded_by IS NOT NULL \
             FROM vault.wraps w JOIN vault.keys k \
               ON k.organisation_id = w.organisation_id AND k.id = w.recipient_key_id \
             WHERE w.organisation_id = $1 AND w.entry_id = $2 AND w.epoch = $3 \
             ORDER BY k.kind DESC, 4, w.recipient_key_id",
            &[&tenant, &id, &epoch],
        )
        .await?
        .iter()
        .map(|h| Holder {
            key_id: h.get(0),
            kind: h.get(1),
            account: h.get(2),
            name: h.get(3),
            fpr: h.get(4),
            digest: h.get(5),
            revoked: h.get(6),
            stale: h.get(7),
        })
        .collect::<Vec<_>>();
    let opening = match my_key {
        Some(k) => opening_for(tx, tenant, &id, epoch, k, row).await?,
        None => None,
    };
    let share_seq: i64 = tx
        .query_opt(
            "SELECT chain_seq FROM vault.shares WHERE organisation_id = $1 AND entry_id = $2 \
             AND epoch = $3",
            &[&tenant, &id, &epoch],
        )
        .await?
        .map_or(0, |r| r.get(0));
    let fathom = crate::vault_fathom::view_for(tx, tenant, &id).await?;
    let (critical, breach) = crate::vault_breach::entry_facts(tx, tenant, &id, epoch).await?;
    Ok(EntryView {
        id,
        meta,
        owner: row.get(1),
        owner_name: row.get::<_, Option<String>>(13).unwrap_or_default(),
        created_ms: row.get(11),
        updated_ms: row.get(12),
        updated_by: row.get(10),
        version: row.get(6),
        epoch,
        needs_rotation: row.get(7),
        holders,
        opening,
        share_seq,
        fathom,
        critical,
        breach,
    })
}

/// The wrap and signed share for `key` at `epoch`, or nothing. A wrap with no share row is
/// never served (§13.3: "a wrap row no `vault_shared` entry covers is not a recipient").
async fn opening_for(
    tx: &Transaction<'_>,
    tenant: &str,
    credential: &str,
    epoch: i32,
    key: &str,
    row: &tokio_postgres::Row,
) -> Result<Option<Opening>, VaultError> {
    let Some(wrap) = current_wrap(tx, tenant, credential, epoch, Some(key)).await? else {
        return Ok(None);
    };
    let Some(s) = tx
        .query_opt(
            "SELECT s.sharer, s.sharer_key_fpr, s.at_unix, s.signature, s.via_recovery, \
                    (SELECT a.public_key FROM account_keys a WHERE a.fpr = s.sharer_key_fpr) \
             FROM vault.shares s WHERE s.organisation_id = $1 AND s.entry_id = $2 AND s.epoch = $3",
            &[&tenant, &credential, &epoch],
        )
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(Opening {
        key_id: key.to_string(),
        wrap,
        secret_ct: row.get(8),
        secret_nonce: row.get(9),
        sharer: s.get(0),
        sharer_key_fpr: s.get(1),
        share_at: s.get(2),
        signature: s.get(3),
        via_recovery: s.get(4),
        sharer_public_key: s.get::<_, Option<Vec<u8>>>(5).unwrap_or_default(),
    }))
}

pub(crate) async fn entry_by_id(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
) -> Result<EntryView, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let row = tx
        .query_opt(
            &format!(
                "SELECT {ENTRY_COLUMNS} FROM vault.entries e \
                 WHERE e.organisation_id = $1 AND e.id = $2 AND e.deleted_at IS NULL"
            ),
            &[&tenant, &credential],
        )
        .await?
        .ok_or(VaultError::NotFound)?;
    let my_key = live_person_key(tx, &tenant, &me).await?;
    let mut opener = MetaOpener {
        auth,
        keys: BTreeMap::new(),
    };
    build_entry(tx, &mut opener, &tenant, my_key.as_deref(), &row).await
}

/// One person in the organisation, as the share dialog lists them.
#[derive(Clone, Debug)]
pub struct Person {
    pub account: String,
    pub name: String,
    pub key: Option<KeyView>,
}

/// One opening of the recovery sheet.
#[derive(Clone, Debug)]
pub struct RecoveryUse {
    pub by: String,
    pub by_name: String,
    pub at_ms: i64,
}

#[derive(Clone, Debug)]
pub struct Overview {
    pub me: String,
    pub steward: bool,
    pub my_key: Option<KeyView>,
    pub recovery: Option<KeyView>,
    pub recovery_uses: Vec<RecoveryUse>,
    pub people: Vec<Person>,
    pub entries: Vec<EntryView>,
    pub breach_policy: crate::vault_breach::Policy,
}

/// Everything the vault surface reads, in one call.
pub async fn overview(tx: &Transaction<'_>, auth: &Authority<'_>) -> Result<Overview, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let steward = is_steward(tx, auth).await?;

    let keys = tx
        .query(
            &format!(
                "SELECT {KEY_COLUMNS} FROM vault.keys k \
                 WHERE k.organisation_id = $1 AND k.superseded_by IS NULL"
            ),
            &[&tenant],
        )
        .await?;
    let mut my_key = None;
    let mut recovery = None;
    let mut by_account: BTreeMap<String, KeyView> = BTreeMap::new();
    for row in &keys {
        let view = key_view(row, &me);
        match (view.kind.as_str(), view.account.clone()) {
            ("recovery", _) => recovery = Some(view),
            (_, Some(account)) => {
                if account == me {
                    my_key = Some(view.clone());
                }
                by_account.insert(account, view);
            }
            _ => return Err(VaultError::Corrupt("person key without an account")),
        }
    }

    let people = tx
        .query(
            "SELECT m.account_id, a.display_name FROM memberships m \
             JOIN accounts a ON a.id = m.account_id \
             WHERE m.organisation_id = $1 AND a.disabled_at IS NULL \
             ORDER BY a.display_name, m.account_id",
            &[&tenant],
        )
        .await?
        .iter()
        .map(|r| {
            let account: String = r.get(0);
            Person {
                key: by_account.get(&account).cloned(),
                name: r.get(1),
                account,
            }
        })
        .collect();

    let recovery_uses = tx
        .query(
            "SELECT u.used_by, coalesce((SELECT a.display_name FROM accounts a \
                    WHERE a.id = u.used_by), ''), \
                    (extract(epoch from u.used_at) * 1000)::bigint \
             FROM vault.recovery_uses u WHERE u.organisation_id = $1 \
             ORDER BY u.used_at DESC LIMIT 20",
            &[&tenant],
        )
        .await?
        .iter()
        .map(|r| RecoveryUse {
            by: r.get(0),
            by_name: r.get(1),
            at_ms: r.get(2),
        })
        .collect();

    let my_key_id = my_key.as_ref().map(|k: &KeyView| k.id.clone());
    let rows = if steward {
        tx.query(
            &format!(
                "SELECT {ENTRY_COLUMNS} FROM vault.entries e \
                 WHERE e.organisation_id = $1 AND e.deleted_at IS NULL ORDER BY e.created_at, e.id"
            ),
            &[&tenant],
        )
        .await?
    } else {
        tx.query(
            &format!(
                "SELECT {ENTRY_COLUMNS} FROM vault.entries e \
                 WHERE e.organisation_id = $1 AND e.deleted_at IS NULL \
                   AND EXISTS (SELECT 1 FROM vault.wraps w WHERE w.organisation_id = e.organisation_id \
                       AND w.entry_id = e.id AND w.epoch = e.epoch AND w.revoked_at IS NULL \
                       AND w.recipient_key_id = $2) \
                 ORDER BY e.created_at, e.id"
            ),
            &[&tenant, &my_key_id.clone().unwrap_or_default()],
        )
        .await?
    };
    let mut opener = MetaOpener {
        auth,
        keys: BTreeMap::new(),
    };
    let mut entries = Vec::with_capacity(rows.len());
    for row in &rows {
        entries.push(build_entry(tx, &mut opener, &tenant, my_key_id.as_deref(), row).await?);
    }
    Ok(Overview {
        me,
        steward,
        my_key,
        recovery,
        recovery_uses,
        people,
        entries,
        breach_policy: crate::vault_breach::load_policy(tx, &tenant).await?,
    })
}

/// What opening the recovery sheet serves: its sealed private half, and for every login the
/// sheet holds, the wrap and signed share to check before using it.
#[derive(Clone, Debug)]
pub struct RecoveryOpening {
    pub key: KeyView,
    pub sealed_private: Vec<u8>,
    pub sealed_nonce: Vec<u8>,
    pub entries: Vec<EntryView>,
}

/// A steward opens the recovery sheet. Sealed on the chain and recorded for the admin page
/// BEFORE anything is served; a transfer that fails half way still leaves the record.
pub async fn open_recovery(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
) -> Result<RecoveryOpening, VaultError> {
    require_steward(tx, auth).await?;
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let row = tx
        .query_opt(
            &format!(
                "SELECT {KEY_COLUMNS} FROM vault.keys k WHERE k.organisation_id = $1 \
                 AND k.kind = 'recovery' AND k.superseded_by IS NULL"
            ),
            &[&tenant],
        )
        .await?
        .ok_or(VaultError::NotAllowed(
            "this organisation has no recovery sheet yet",
        ))?;
    let key = key_view(&row, &me);
    let sealed_private: Vec<u8> = row.get(9);
    let sealed_nonce: Vec<u8> = row.get(10);
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultRecoveryUsed,
        &entry_metadata(
            EntryType::VaultRecoveryUsed,
            &[
                ("vault_key", Json::Str(key.id.clone())),
                ("by", Json::Str(me.clone())),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO vault.recovery_uses (organisation_id, id, recovery_key_id, used_by, chain_seq) \
         VALUES ($1, $2, $3, $4, $5)",
        &[
            &tenant,
            &crate::ids::new_ulid().to_string(),
            &key.id,
            &me,
            &appended.seq,
        ],
    )
    .await?;
    let rows = tx
        .query(
            &format!(
                "SELECT {ENTRY_COLUMNS} FROM vault.entries e \
                 WHERE e.organisation_id = $1 AND e.deleted_at IS NULL \
                   AND EXISTS (SELECT 1 FROM vault.wraps w WHERE w.organisation_id = e.organisation_id \
                       AND w.entry_id = e.id AND w.epoch = e.epoch AND w.revoked_at IS NULL \
                       AND w.recipient_key_id = $2) \
                 ORDER BY e.created_at, e.id"
            ),
            &[&tenant, &key.id],
        )
        .await?;
    let mut opener = MetaOpener {
        auth,
        keys: BTreeMap::new(),
    };
    let mut entries = Vec::with_capacity(rows.len());
    for row in &rows {
        entries.push(build_entry(tx, &mut opener, &tenant, Some(&key.id), row).await?);
    }
    Ok(RecoveryOpening {
        key,
        sealed_private,
        sealed_nonce,
        entries,
    })
}

// ---------------------------------------------------------------------------
// JSON, as the API writes it. Bytes are lower-case hex.
// ---------------------------------------------------------------------------

fn obj(pairs: Vec<(&str, Json)>) -> Json {
    Json::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}
fn s(v: &str) -> Json {
    Json::Str(v.to_string())
}
fn h(v: &[u8]) -> Json {
    Json::Str(hex(v))
}
fn opt<T>(v: &Option<T>, f: impl Fn(&T) -> Json) -> Json {
    v.as_ref().map_or(Json::Null, f)
}

impl KeyView {
    pub fn to_json(&self) -> Json {
        let mut pairs = vec![
            ("id", s(&self.id)),
            ("kind", s(&self.kind)),
            ("account", opt(&self.account, |a| s(a))),
            ("createdBy", s(&self.created_by)),
            ("publicKey", h(&self.public_key)),
            ("fpr", h(&self.fpr)),
            ("signerKeyFpr", h(&self.signer_key_fpr)),
            ("signerPublicKey", h(&self.signer_public_key)),
            ("enrolledAt", Json::Int(self.enrolled_at)),
            ("signature", h(&self.signature)),
            (
                "supersedes",
                opt(&self.supersedes, |x| {
                    obj(vec![
                        ("oldFpr", h(&x.old_fpr)),
                        ("at", Json::Int(x.at)),
                        ("signature", h(&x.signature)),
                    ])
                }),
            ),
        ];
        if let Some(own) = &self.own {
            pairs.push((
                "own",
                obj(vec![
                    ("sealedPrivate", h(&own.sealed_private)),
                    ("sealedNonce", h(&own.sealed_nonce)),
                    ("kdfSalt", opt(&own.kdf_salt, |v| h(v))),
                    ("kdfM", opt(&own.kdf_m, |v| Json::Int(*v as i64))),
                    ("kdfT", opt(&own.kdf_t, |v| Json::Int(*v as i64))),
                    ("kdfP", opt(&own.kdf_p, |v| Json::Int(*v as i64))),
                ]),
            ));
        }
        obj(pairs)
    }
}

impl EntryView {
    pub fn to_json(&self) -> Json {
        obj(vec![
            ("id", s(&self.id)),
            ("name", s(&self.meta.name)),
            ("kind", s(&self.meta.kind)),
            (
                "usedOn",
                Json::Arr(
                    self.meta
                        .used_on
                        .iter()
                        .map(|(d, e)| obj(vec![("design", s(d)), ("element", s(e))]))
                        .collect(),
                ),
            ),
            ("owner", s(&self.owner)),
            ("ownerName", s(&self.owner_name)),
            ("createdAt", Json::Int(self.created_ms)),
            ("updatedAt", Json::Int(self.updated_ms)),
            ("updatedBy", s(&self.updated_by)),
            ("version", Json::Int(self.version)),
            ("epoch", Json::Int(self.epoch as i64)),
            ("needsRotation", Json::Bool(self.needs_rotation)),
            ("shareSeq", Json::Int(self.share_seq)),
            (
                "fathom",
                opt(&self.fathom, crate::vault_fathom::FathomView::to_json),
            ),
            ("critical", Json::Bool(self.critical)),
            (
                "breach",
                opt(&self.breach, crate::vault_breach::Result_::to_json),
            ),
            (
                "holders",
                Json::Arr(
                    self.holders
                        .iter()
                        .map(|x| {
                            obj(vec![
                                ("keyId", s(&x.key_id)),
                                ("kind", s(&x.kind)),
                                ("account", opt(&x.account, |a| s(a))),
                                ("name", s(&x.name)),
                                ("fpr", h(&x.fpr)),
                                ("digest", h(&x.digest)),
                                ("revoked", Json::Bool(x.revoked)),
                                ("stale", Json::Bool(x.stale)),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "opening",
                opt(&self.opening, |o| {
                    obj(vec![
                        ("keyId", s(&o.key_id)),
                        ("wrap", h(&o.wrap)),
                        ("secretCt", h(&o.secret_ct)),
                        ("secretNonce", h(&o.secret_nonce)),
                        ("sharer", s(&o.sharer)),
                        ("sharerKeyFpr", h(&o.sharer_key_fpr)),
                        ("sharerPublicKey", h(&o.sharer_public_key)),
                        ("shareAt", Json::Int(o.share_at)),
                        ("signature", h(&o.signature)),
                        ("viaRecovery", Json::Bool(o.via_recovery)),
                    ])
                }),
            ),
        ])
    }
}

impl Overview {
    pub fn to_json(&self) -> Json {
        obj(vec![
            ("me", s(&self.me)),
            ("steward", Json::Bool(self.steward)),
            ("myKey", opt(&self.my_key, KeyView::to_json)),
            ("recovery", opt(&self.recovery, KeyView::to_json)),
            (
                "recoveryUses",
                Json::Arr(
                    self.recovery_uses
                        .iter()
                        .map(|u| {
                            obj(vec![
                                ("by", s(&u.by)),
                                ("byName", s(&u.by_name)),
                                ("at", Json::Int(u.at_ms)),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "people",
                Json::Arr(
                    self.people
                        .iter()
                        .map(|p| {
                            obj(vec![
                                ("account", s(&p.account)),
                                ("name", s(&p.name)),
                                ("key", opt(&p.key, KeyView::to_json)),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "entries",
                Json::Arr(self.entries.iter().map(EntryView::to_json).collect()),
            ),
            ("breachPolicy", self.breach_policy.to_json()),
        ])
    }
}

impl RecoveryOpening {
    pub fn to_json(&self) -> Json {
        obj(vec![
            ("key", self.key.to_json()),
            ("sealedPrivate", h(&self.sealed_private)),
            ("sealedNonce", h(&self.sealed_nonce)),
            (
                "entries",
                Json::Arr(self.entries.iter().map(EntryView::to_json).collect()),
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wrap_must_carry_a_point_on_the_curve() {
        // The P-256 generator, uncompressed (SEC 2 §2.4.2).
        let g = unhex(
            "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296\
             4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
            Some(65),
            "g",
        )
        .unwrap();
        assert!(valid_point(&g));
        let mut off = g.clone();
        off[64] ^= 1;
        assert!(!valid_point(&off), "a point off the curve is refused");

        let mut wrap = Vec::new();
        crypto::lp(&mut wrap, &g);
        crypto::lp(&mut wrap, &[0u8; 12]);
        crypto::lp(&mut wrap, &[0u8; 48]);
        assert!(valid_wrap(&wrap));
        let mut bad_wrap = Vec::new();
        crypto::lp(&mut bad_wrap, &off);
        crypto::lp(&mut bad_wrap, &[0u8; 12]);
        crypto::lp(&mut bad_wrap, &[0u8; 48]);
        assert!(!valid_wrap(&bad_wrap));
        let mut short = Vec::new();
        crypto::lp(&mut short, &g);
        crypto::lp(&mut short, &[0u8; 12]);
        crypto::lp(&mut short, &[0u8; 47]);
        assert!(!valid_wrap(&short));
        wrap.push(0);
        assert!(!valid_wrap(&wrap), "trailing bytes are refused");
    }

    #[test]
    fn the_recipient_list_is_sorted_and_canonical() {
        let a = Recipient {
            who: "recovery".into(),
            key_fpr: [1; 32],
            digest: [2; 32],
        };
        let b = Recipient {
            who: "01JABCDEFGHJKMNPQRSTVWXYZ0".into(),
            key_fpr: [3; 32],
            digest: [4; 32],
        };
        let one = canonical_recipients(&[a.clone(), b.clone()]);
        let two = canonical_recipients(&[b, a]);
        assert_eq!(one, two);
        let text = String::from_utf8(one).unwrap();
        assert!(text.starts_with("[[\"01JABCDEFGHJKMNPQRSTVWXYZ0\",\"0303"));
        assert!(!text.contains(' '));
    }

    #[test]
    fn a_name_that_carries_a_password_is_refused() {
        assert!(Meta::clean("core-sw-01 admin", "login", vec![]).is_ok());
        assert!(matches!(
            Meta::clean("enable secret cisco123", "login", vec![]),
            Err(VaultError::NotAllowed(_))
        ));
        assert!(Meta::clean("", "login", vec![]).is_err());
        assert!(Meta::clean("a\u{202e}b", "login", vec![]).is_err());
        assert!(Meta::clean("x", "nope", vec![]).is_err());
        let d = "01JABCDEFGHJKMNPQRSTVWXYZ0".to_string();
        assert!(Meta::clean("x", "login", vec![(d.clone(), "sw-1".into())]).is_ok());
        assert!(Meta::clean(
            "x",
            "login",
            vec![(d.clone(), "sw-1".into()), (d, "sw-1".into())]
        )
        .is_err());
    }

    #[test]
    fn credential_ids_are_cred_and_a_ulid() {
        assert!(clean_credential_id("cred_01JABCDEFGHJKMNPQRSTVWXYZ0").is_ok());
        for bad in [
            "",
            "cred_",
            "01JABCDEFGHJKMNPQRSTVWXYZ0",
            "cred_01jabcdefghjkmnpqrstvwxyz0",
        ] {
            assert!(clean_credential_id(bad).is_err(), "{bad}");
        }
    }
}
