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

use crate::audit;
use crate::authority::Capability;
use crate::chain::{self, EntryType};
use crate::crypto::{self};
use crate::grants::{self, Authority, AuthorityError};
use crate::heads::{self, HeadError, HeadKey, HeadStore, Rebuild};
use crate::keys::{self, DataKey, KeyRing, KeyStoreError};
use crate::repo::{self, AccountId, DesignId, OrganisationId, RepoError, ScopeId, TenantContext};

/// The domain tag in a payload seal's associated data.
const AAD_PAYLOAD: &[u8] = b"fathom/payload/v1";

/// The domain tags of a live change's and a checkpoint's seals (ADR-0063).
const AAD_CHANGE: &[u8] = b"fathom/change/v1";
const AAD_CHECKPOINT: &[u8] = b"fathom/checkpoint/v1";

/// The domain tag in a design name's seal (ADR-0060 step 3b).
const AAD_NAME: &[u8] = b"fathom/design-name/v1";

/// The domain tag in a doc file's seal (ADR-0061 round 10).
const AAD_FILE: &[u8] = b"fathom/design-file/v1";

/// Largest file attached to a doc: 25 MiB, enforced here and not only in the browser.
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
/// What one design may hold in doc files: a count and sealed bytes (rotation reseals them all).
pub const MAX_DESIGN_FILES: i64 = 500;
pub const MAX_DESIGN_FILE_BYTES: i64 = 256 * 1024 * 1024;

/// Longest design name, in characters.
pub const MAX_NAME_CHARS: usize = 100;

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

/// One stored version, **decrypted** — so the `payload` field is the estate
/// map in the clear, and the only one in this file.
#[derive(Clone, PartialEq, Eq)]
pub struct DesignVersion {
    pub design: DesignId,
    pub version: i64,
    pub payload_schema_version: i32,
    pub payload: Vec<u8>,
}

/// **Hand-written, and that is the whole point.** A derived `Debug` prints the
/// decrypted payload, so any `{:?}`, any `tracing` field holding one of these,
/// any `unwrap` on a `Result` carrying one, and any panic message puts the
/// estate map into a log — which is the place least likely to be encrypted.
/// §3 encrypts the payload whole to keep it out of the database; printing it
/// into a log file is the same disclosure through a different door.
///
/// The length is printed because it is already disclosed: §11.3 lists
/// per-version size among what a dump reveals regardless.
impl fmt::Debug for DesignVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DesignVersion")
            .field("design", &self.design)
            .field("version", &self.version)
            .field("payload_schema_version", &self.payload_schema_version)
            .field(
                "payload",
                &format_args!("<{} bytes, not shown>", self.payload.len()),
            )
            .finish()
    }
}

/// What a rotation did, in the words §12.6 requires — **counts rather than a
/// boolean**, and the operation named `rotate`, never a verb shared with
/// re-wrap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RotationReport {
    pub design: DesignId,
    pub from_key_epoch: i32,
    pub to_key_epoch: i32,
    /// Whole saves and live changes.
    pub versions_reencrypted: usize,
    pub chain_entries_written: usize,
    /// Checkpoints (ADR-0063): re-encrypted, with no chain entry of their own.
    pub checkpoints_reencrypted: usize,
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
    /// A design name that is too long or holds control characters.
    InvalidName,
    /// Larger than [`MAX_PAYLOAD_BYTES`].
    PayloadTooLarge {
        bytes: usize,
    },
    /// A doc file larger than [`MAX_FILE_BYTES`].
    FileTooLarge {
        bytes: usize,
    },
    /// A design already holds as many doc files, or as many bytes of them, as it may.
    FileQuota,
    /// A doc file that is not a PDF, an image or text, by what its bytes are.
    FileTypeRefused,
    /// No such file on this design.
    NoSuchFile,
    /// **The audit spool is past one of §9's bounds, so design writes stop and
    /// reads continue.**
    ///
    /// §9's degrade table, third row. This is the only refusal in this file
    /// that is not about the design being written, and it is deliberately a
    /// typed error rather than a generic failure: a surface has to be able to
    /// say *which* bound, *how long* the trail has been unshipped, and that
    /// reading still works — because "save failed" with no reason is what gets
    /// the audit destination removed from the compose file.
    AuditSpoolBeyondBounds {
        bound: audit::Bound,
        /// How long the oldest unshipped entry has been waiting, in seconds.
        oldest_seconds: u64,
        /// How many entries are waiting.
        entries: i64,
        /// How many bytes they occupy.
        bytes: i64,
    },
    /// The stored row did not decrypt. **This is the sentence that must not be
    /// reached by a wrong master key**: `keys::register_master_key` runs
    /// before any key is used precisely so that the wrong-key case reports
    /// which key ids differ (ADR-0043 §4) rather than arriving here looking
    /// like corruption.
    Refused,
    /// A stored row is not shaped like one this server wrote.
    Corrupt(&'static str),
    /// The payload does not read back as a `fathom-plain` document
    /// (`fathom_workspace::read_plain`). ADR-0049 #2: **the server reads
    /// every design payload back before storing it**, and a payload the
    /// engine itself cannot parse is refused at the door rather than stored
    /// opaque and unreadable to everything downstream that expects a plain
    /// workspace face -- the walkthrough, the checker, the inventory.
    InvalidPlainPayload(fathom_workspace::PlainError),
    /// The wire body's four-byte schema-version prefix disagreed with the
    /// payload's own declared schema version on line 3. ADR-0049 #4: both
    /// name the schema version and must agree.
    SchemaVersionPrefixMismatch {
        prefix: u32,
        declared: String,
    },
    /// ADR-0054 #1: a save named a `base` that is no longer the design's
    /// current version. Nothing was written and nothing was appended --
    /// checked under the same row lock the version number itself comes from,
    /// so this is the one true answer, not a race with the write it refuses.
    VersionConflict {
        base: i64,
        current: i64,
    },
    /// ADR-0054 items 4/5: a re-check that failed. Two distinct sources
    /// share this variant, both refused the same way a capability failure
    /// anywhere else in this crate is refused:
    ///
    /// - a payload's own `Capture` or `Note` text still carries a credential
    ///   shape after the client's own gate (`kind` names which, `line` is
    ///   1-based within that field's text) -- the client redacts before
    ///   sending, so a hit here means an old or hostile client, never a real
    ///   capture;
    /// - the grant that authorised this act no longer covers it when the act
    ///   itself re-checks, immediately before doing anything irreversible,
    ///   inside the same transaction the first check ran in.
    CredentialInPayload {
        kind: &'static str,
        line: usize,
    },
    /// The re-check immediately before the act (ADR-0054 #5) found the grant
    /// no longer covers it -- carried whole rather than collapsed to a
    /// string so the caller answers exactly as every other authority
    /// refusal in this crate does.
    Authority(AuthorityError),
    /// ADR-0063: the head refused a change; the reason is one sentence.
    ChangeRefused(String),
    /// ADR-0063 #9: a batch id already stored under a different change.
    BatchIdUsed,
    /// A change `after` a version the design has not reached.
    ChangeAhead {
        after: i64,
        current: i64,
    },
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
            Self::FileTooLarge { bytes } => write!(
                f,
                "that file is {bytes} bytes; a doc file may be at most {MAX_FILE_BYTES}"
            ),
            Self::FileQuota => write!(
                f,
                "this design already holds {MAX_DESIGN_FILES} files or {} MB of them",
                MAX_DESIGN_FILE_BYTES / (1024 * 1024)
            ),
            Self::FileTypeRefused => f.write_str("a doc file must be a PDF, an image or text"),
            Self::NoSuchFile => f.write_str("no such file on this design"),
            Self::PayloadTooLarge { bytes } => write!(
                f,
                "that payload is {bytes} bytes; one design version may be at most \
                 {MAX_PAYLOAD_BYTES}"
            ),
            Self::AuditSpoolBeyondBounds {
                bound,
                oldest_seconds,
                entries,
                bytes,
            } => write!(
                f,
                "this design was NOT saved: the audit trail has not reached its destination and \
                 the spool has passed its {bound} bound ({entries} entries, {bytes} bytes, \
                 oldest {oldest_seconds}s). Reading designs still works and nothing has been \
                 lost -- every queued entry is still here. Writes resume as soon as the \
                 destination accepts them, or when an operator raises \
                 FATHOM_AUDIT_SPOOL_MAX_AGE / FATHOM_AUDIT_SPOOL_MAX_BYTES having understood \
                 that the window of unwitnessed history grows with it."
            ),
            Self::Refused => f.write_str(
                "the stored payload did not authenticate under the key this design is filed \
                 under. Check the master key id reported at startup before treating this as \
                 corruption.",
            ),
            Self::Corrupt(what) => write!(f, "a stored {what} is not shaped like one we wrote"),
            Self::InvalidPlainPayload(e) => {
                write!(
                    f,
                    "payload does not read back as a fathom-plain document: {e:?}"
                )
            }
            Self::SchemaVersionPrefixMismatch { prefix, declared } => write!(
                f,
                "the wire prefix names schema version {prefix} but the payload's own line 3 \
                 declares `{declared}`; these must agree"
            ),
            Self::VersionConflict { base, current } => write!(
                f,
                "you opened version {base}; it is now version {current}, someone saved in \
                 between. Reload to see their change; yours is still on your screen and was not \
                 written."
            ),
            Self::CredentialInPayload { kind, line } => write!(
                f,
                "that payload's {kind} text still carries something that looks like a \
                 credential, at line {line}; refused before it reaches storage"
            ),
            Self::InvalidName => write!(f, "invalid design name"),
            Self::Authority(e) => write!(f, "{e}"),
            Self::ChangeRefused(reason) => f.write_str(reason),
            Self::BatchIdUsed => f.write_str(
                "that batch id was already used for a different change; a retry must send the                  same bytes",
            ),
            Self::ChangeAhead { after, current } => write!(
                f,
                "your copy is at version {after} but this design is only at {current}; reopen it"
            ),
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
    sealed_aad(
        AAD_PAYLOAD,
        tenant,
        design,
        version,
        key_epoch,
        payload_schema_version,
    )
}

fn sealed_aad(
    tag: &[u8],
    tenant: &str,
    design: &str,
    version: i64,
    key_epoch: i32,
    payload_schema_version: i32,
) -> Vec<u8> {
    let mut aad = Vec::new();
    crypto::lp(&mut aad, tag);
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

/// ADR-0054 #2: **draw creates a design.** The row in `designs` and its first
/// version are written in the ONE transaction the caller (`design_api`'s
/// scope-design route) already authorised `draw` in -- so a design with no
/// version behind it, "a bodiless design", is never minted: either both
/// inserts land, or neither does.
///
/// Re-checks `auth`'s grant on `scope` immediately before the first insert
/// (ADR-0054 #5, same reasoning as [`write_version_in_tx`]'s own doc), and
/// refuses under §9's spool bounds **before that insert**, so a spooled
/// refusal leaves no design row behind either (this task's own words: "spool
/// beyond bounds -> 503 and no row").
pub async fn create_design_with_first_version_in_tx(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    scope: ScopeId,
    payload: &[u8],
    payload_schema_version: i32,
    bounds: &audit::SpoolBounds,
) -> Result<(DesignId, i64, i64, Capability), DesignError> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(DesignError::PayloadTooLarge {
            bytes: payload.len(),
        });
    }
    refuse_if_spool_beyond_bounds(tx, bounds).await?;
    let answer = grants::authorise_account(tx, auth, Some(scope), Capability::Draw)
        .await
        .map_err(DesignError::Authority)?;

    let ctx = auth.ctx;
    let tenant_text = ctx.tenant().to_string();
    let id = DesignId::new();
    let row = tx
        .query_opt(
            "INSERT INTO designs (id, organisation_id, scope_id, created_by) \
             SELECT $1, $2, $3, $4 WHERE EXISTS \
                 (SELECT 1 FROM scopes WHERE id = $3 AND organisation_id = $2) \
             RETURNING extract(epoch FROM created_at)::bigint",
            &[
                &id.to_string(),
                &tenant_text,
                &scope.to_string(),
                &ctx.actor().to_string(),
            ],
        )
        .await?;
    let created_at_unix: i64 = row.ok_or(DesignError::NoSuchScope)?.get(0);

    let version = write_version_locked(
        tx,
        auth.ring,
        ctx,
        id,
        payload,
        payload_schema_version,
        None,
    )
    .await?;

    Ok((id, version, created_at_unix, answer.capability))
}

// ---------------------------------------------------------------------------
// Design names
// ---------------------------------------------------------------------------

fn name_aad(tenant: &str, design: &str, key_epoch: i32) -> Vec<u8> {
    let mut aad = Vec::new();
    crypto::lp(&mut aad, AAD_NAME);
    crypto::lp(&mut aad, tenant.as_bytes());
    crypto::lp(&mut aad, design.as_bytes());
    crypto::u32_le(&mut aad, key_epoch as u32);
    aad
}

/// Control, line/paragraph separator and invisible or bidi-override characters,
/// which could make a name display as something else.
fn is_unsafe_name_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}')
}

/// Set a design's name; an empty (trimmed) name clears it back to untitled.
/// Needs `draw` on the design's scope, the same as saving a version. The name
/// is sealed under the organisation content key and never stored in the clear.
pub async fn rename_design_in_tx(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    scope: Option<ScopeId>,
    name: &str,
) -> Result<(), DesignError> {
    let name = name.trim();
    if name.chars().count() > MAX_NAME_CHARS || name.chars().any(is_unsafe_name_char) {
        return Err(DesignError::InvalidName);
    }
    // Authorise before saying whether the design exists, so a missing design
    // and a forbidden one read the same to a member with no grant.
    grants::authorise_account(tx, auth, scope, Capability::Draw)
        .await
        .map_err(DesignError::Authority)?;
    scope.ok_or(DesignError::NoSuchDesign)?;

    let tenant = auth.ctx.tenant().to_string();
    let design_text = design.to_string();
    let changed = if name.is_empty() {
        tx.execute(
            "UPDATE designs SET name_ciphertext = NULL, name_nonce = NULL, name_key_epoch = NULL \
             WHERE id = $1 AND organisation_id = $2",
            &[&design_text, &tenant],
        )
        .await?
    } else {
        let key = keys::org_content_key(tx, auth.ctx, auth.tenant_key).await?;
        let nonce = crypto::random_nonce()?;
        let aad = name_aad(&tenant, &design_text, key.epoch);
        let ciphertext = crypto::seal(&key.key, &nonce, name.as_bytes(), &aad)?;
        keys::count_write_under_org_content_key(tx, &tenant, key.epoch).await?;
        tx.execute(
            "UPDATE designs SET name_ciphertext = $3, name_nonce = $4, name_key_epoch = $5 \
             WHERE id = $1 AND organisation_id = $2",
            &[
                &design_text,
                &tenant,
                &ciphertext,
                &nonce.to_vec(),
                &key.epoch,
            ],
        )
        .await?
    };
    if changed == 0 {
        return Err(DesignError::NoSuchDesign);
    }
    Ok(())
}

/// Opens design names for one request, fetching each key epoch once.
pub struct NameOpener<'a> {
    auth: &'a Authority<'a>,
    keys: BTreeMap<i32, crypto::Key32>,
}

impl<'a> NameOpener<'a> {
    pub fn new(auth: &'a Authority<'a>) -> Self {
        Self {
            auth,
            keys: BTreeMap::new(),
        }
    }

    /// The decrypted name, or `None` when the design is untitled.
    pub async fn open(
        &mut self,
        tx: &Transaction<'_>,
        design: &str,
        sealed: Option<(Vec<u8>, Vec<u8>, i32)>,
    ) -> Result<Option<String>, DesignError> {
        let Some((ciphertext, nonce, epoch)) = sealed else {
            return Ok(None);
        };
        if !self.keys.contains_key(&epoch) {
            let key =
                keys::org_content_key_at_epoch(tx, self.auth.ctx, self.auth.tenant_key, epoch)
                    .await?;
            self.keys.insert(epoch, key);
        }
        let nonce: [u8; crypto::NONCE_LEN] = nonce
            .try_into()
            .map_err(|_| DesignError::Corrupt("design name nonce"))?;
        let aad = name_aad(&self.auth.ctx.tenant().to_string(), design, epoch);
        let plain = crypto::open(&self.keys[&epoch], &nonce, &ciphertext, &aad)
            .map_err(|_| DesignError::Refused)?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| DesignError::Corrupt("design name"))
    }
}

// ---------------------------------------------------------------------------
// Writing a version
// ---------------------------------------------------------------------------

/// Encrypt a payload, store it as the next version, and seal a chain entry for
/// it — **one transaction, or none of it**.
/// Write a new version, under §9's spool bounds as this process's environment
/// configures them.
///
/// See [`write_version_under`] for the bounds themselves. This is the entry
/// point everything but a test uses, and it reads the bounds rather than being
/// handed them because nothing carries a `Config` this far down yet — there is
/// no request surface for a design write.
pub async fn write_version(
    pool: &Pool,
    ring: &KeyRing,
    tenant: OrganisationId,
    actor: AccountId,
    design: DesignId,
    payload: &[u8],
    payload_schema_version: i32,
) -> Result<i64, DesignError> {
    write_version_under(
        pool,
        ring,
        tenant,
        actor,
        design,
        payload,
        payload_schema_version,
        audit::SpoolBounds::from_env(),
    )
    .await
}

/// §9's degrade table, third row, factored into one place so the two
/// call sites — [`write_version_under`] and [`rotate_design`] — cannot drift
/// apart on what "beyond bounds" means.
///
/// Refuses with [`DesignError::AuditSpoolBeyondBounds`] once the spool has
/// passed [`audit::SpoolBounds::max_age`] or [`audit::SpoolBounds::max_bytes`],
/// and does nothing otherwise. Callers run it inside their own transaction and
/// before any key is touched, so a refusal costs one aggregate query and
/// leaves nothing half-done.
async fn refuse_if_spool_beyond_bounds(
    tx: &Transaction<'_>,
    bounds: &audit::SpoolBounds,
) -> Result<(), DesignError> {
    let spool = audit::spool_state(&**tx, bounds).await?;
    if let Some(bound) = spool.beyond(bounds) {
        return Err(DesignError::AuditSpoolBeyondBounds {
            bound,
            oldest_seconds: spool.oldest.as_secs(),
            entries: spool.entries,
            bytes: spool.bytes,
        });
    }
    Ok(())
}

/// The same, with §9's spool bounds named explicitly.
///
/// # The one row of §9's degrade table this enforces
///
/// > *"Beyond bounds — design **writes** stop; design **reads** continue and
/// > keep spooling; the deployment is marked `unwitnessed` in every session."*
///
/// The check is [`refuse_if_spool_beyond_bounds`], shared with
/// [`rotate_design`] — a rotation re-encrypts every version and appends one
/// `reencrypt` entry per version, so it grows the very backlog this bound
/// exists to cap, and §9 draws no line between a write growing the spool one
/// entry at a time and a rotation growing it a thousand at once. Between the
/// two of them the rest of the degrade table holds true by construction:
/// reads do not consult it, the site chain does not consult it, and
/// `audit::spool` is an unconditional `INSERT`, so the entries that record the
/// condition can always be written. **Nothing is deleted to make room and no
/// entry is ever dropped.**
///
/// It is checked inside the write's own transaction and before any key is
/// touched, so a refusal costs one aggregate query and leaves nothing
/// half-done.
#[allow(clippy::too_many_arguments)]
pub async fn write_version_under(
    pool: &Pool,
    ring: &KeyRing,
    tenant: OrganisationId,
    actor: AccountId,
    design: DesignId,
    payload: &[u8],
    payload_schema_version: i32,
    bounds: audit::SpoolBounds,
) -> Result<i64, DesignError> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(DesignError::PayloadTooLarge {
            bytes: payload.len(),
        });
    }

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;

    refuse_if_spool_beyond_bounds(&tx, &bounds).await?;

    let ctx = repo::open_tenant_context(&tx, tenant, actor).await?;
    let version = write_version_locked(
        &tx,
        ring,
        &ctx,
        design,
        payload,
        payload_schema_version,
        None,
    )
    .await?;

    tx.commit().await?;
    Ok(version)
}

/// ADR-0054 #1's save precondition and #5's one-transaction rule, together:
/// the same write as [`write_version_under`], in the transaction and
/// [`TenantContext`] the caller already authorised in
/// (`design_api::save_design_handler`), naming the version it was based on.
///
/// **Refuses with [`DesignError::VersionConflict`] and writes nothing** when
/// `base` disagrees with the design's current version, read under the same
/// row lock [`write_version_locked`] takes for the write itself -- so the
/// read that decides and the write it gates can never see two different
/// answers. Also re-checks `auth`'s grant, in this same transaction,
/// immediately before touching `design_payload` (ADR-0054 #5): the earlier
/// check the handler ran authorised the *request*; this is what stops a
/// grant revoked in the moment between that check and this act from being
/// carried out anyway, which two separate transactions with only the first
/// one checking could not.
#[allow(clippy::too_many_arguments)]
pub async fn write_version_in_tx(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    scope: Option<ScopeId>,
    payload: &[u8],
    payload_schema_version: i32,
    base: i64,
    bounds: &audit::SpoolBounds,
) -> Result<i64, DesignError> {
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(DesignError::PayloadTooLarge {
            bytes: payload.len(),
        });
    }
    refuse_if_spool_beyond_bounds(tx, bounds).await?;
    grants::authorise_account(tx, auth, scope, Capability::Draw)
        .await
        .map_err(DesignError::Authority)?;
    write_version_locked(
        tx,
        auth.ring,
        auth.ctx,
        design,
        payload,
        payload_schema_version,
        Some(base),
    )
    .await
}

/// The shared core of every version write: the row lock, the next version
/// number, ADR-0054 #1's precondition when `expected_base` is `Some`, the
/// seal and the chain entry -- all inside the caller's own transaction.
///
/// `expected_base` is `None` for every write from before ADR-0054 (this
/// function's two callers other than [`write_version_in_tx`]): the next
/// version is written unconditionally, exactly as it always was, so nothing
/// that already calls [`write_version_under`] or
/// [`create_design_with_first_version_in_tx`] had to change its own
/// signature for this task.
async fn write_version_locked(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    payload: &[u8],
    payload_schema_version: i32,
    expected_base: Option<i64>,
) -> Result<i64, DesignError> {
    let tenant_text = ctx.tenant().to_string();
    let design_text = design.to_string();
    lock_design(tx, &design_text, &tenant_text).await?;

    let key = keys::design_key(tx, ring, ctx, design).await?;

    let (current, _) = head_snapshot(tx, &design_text, &tenant_text).await?;

    if let Some(base) = expected_base {
        if current != base {
            return Err(DesignError::VersionConflict { base, current });
        }
    }
    let version = current + 1;

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

    keys::count_write_under_key(tx, design, key.epoch).await?;

    let entry_type = if version == 1 {
        EntryType::Create
    } else {
        EntryType::Update
    };
    let metadata = metadata_for_write(ctx, version, payload_schema_version, entry_type);
    append_entry(
        tx,
        ring,
        ctx,
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

    Ok(version)
}

// ---------------------------------------------------------------------------
// Reading a version
// ---------------------------------------------------------------------------

/// Read one version, or the head if `version` is `None`. A head that has
/// changes after its newest full face is replayed from storage.
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
    let result = read_version_locked(&tx, ring, &ctx, design, version, None).await?;
    tx.commit().await?;
    Ok(result)
}

/// The same read, re-checking `auth`'s grant immediately before it, in the
/// transaction and [`TenantContext`] `design_api::open_design_handler`
/// already authorised in -- ADR-0054 #5, exactly as
/// [`write_version_in_tx`]'s own doc explains for a save.
pub async fn read_version_in_tx(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    heads: Option<&HeadStore>,
    design: DesignId,
    scope: Option<ScopeId>,
    version: Option<i64>,
) -> Result<DesignVersion, DesignError> {
    grants::authorise_account(tx, auth, scope, Capability::Read)
        .await
        .map_err(DesignError::Authority)?;
    read_version_locked(tx, auth.ring, auth.ctx, design, version, heads).await
}

/// The wire number of this build's schema version (`"0.13"` is 13).
fn current_schema_number() -> i32 {
    fathom_ir::generated::ir_types::SCHEMA_VERSION
        .strip_prefix("0.")
        .and_then(|minor| minor.parse().ok())
        .unwrap_or(1)
}

async fn read_version_locked(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    version: Option<i64>,
    store: Option<&HeadStore>,
) -> Result<DesignVersion, DesignError> {
    let tenant_text = ctx.tenant().to_string();
    let design_text = design.to_string();

    // One snapshot of "now": the head's version and the chain's tip seal.
    let (current, tip) = head_snapshot(tx, &design_text, &tenant_text).await?;
    let target = version.unwrap_or(current);
    if target < 1 || target > current {
        return Err(DesignError::NoSuchVersion);
    }

    let row = tx
        .query_opt(
            "SELECT design_version, ciphertext, nonce, key_epoch, payload_schema_version \
             FROM design_payload \
             WHERE design_id = $1 AND organisation_id = $2 AND design_version = $3",
            &[&design_text, &tenant_text, &target],
        )
        .await?;

    if let Some(row) = row {
        let version: i64 = row.get(0);
        let ciphertext: Vec<u8> = row.get(1);
        let nonce: Vec<u8> = row.get(2);
        let key_epoch: i32 = row.get(3);
        let payload_schema_version: i32 = row.get(4);

        let key = design_key_at_epoch(tx, ring, ctx, design, key_epoch).await?;
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
        return Ok(DesignVersion {
            design,
            version,
            payload_schema_version,
            payload,
        });
    }

    // A change version: the head at that version, replayed from the newest
    // full face (ADR-0063 #8). Only the live head is worth caching.
    let key = (target == current).then(|| HeadKey {
        design: design_text.clone(),
        version: target,
        tip: tip.clone().unwrap_or_default(),
    });
    let payload = materialise(tx, ring, ctx, design, target, key.as_ref(), store).await?;
    Ok(DesignVersion {
        design,
        version: target,
        payload_schema_version: current_schema_number(),
        payload,
    })
}

fn head_failure(e: HeadError) -> DesignError {
    match e {
        HeadError::Refused(reason) => DesignError::ChangeRefused(reason),
        HeadError::NeedRebuild | HeadError::Rebuild(_) | HeadError::Gone => {
            DesignError::Corrupt("design head")
        }
    }
}

/// How many older bases a head build may fall back through.
const BASE_FALLBACKS: usize = 4;

/// The full face of `design` at `target`, from the cache when `key` is given
/// and the head is there, else rebuilt from the newest base that loads.
async fn materialise(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    target: i64,
    key: Option<&HeadKey>,
    store: Option<&HeadStore>,
) -> Result<Vec<u8>, DesignError> {
    if let (Some(store), Some(key)) = (store, key) {
        match store.plain(key, None).await {
            Ok(bytes) => return Ok(bytes),
            Err(HeadError::NeedRebuild) => {}
            Err(e) => return Err(head_failure(e)),
        }
    }
    for skip in 0..BASE_FALLBACKS {
        let Some(rebuild) = rebuild_inputs(tx, ring, ctx, design, target, skip, true).await? else {
            break;
        };
        let built = match (store, key) {
            (Some(store), Some(key)) => store.plain(key, Some(rebuild)).await,
            _ => heads::replay(rebuild).await,
        };
        match built {
            Ok(bytes) => return Ok(bytes),
            Err(HeadError::Rebuild(why)) => {
                tracing::warn!(%design, %why, "a base would not load; trying an older one");
            }
            Err(e) => return Err(head_failure(e)),
        }
    }
    Err(DesignError::Corrupt("design head"))
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
///
/// **Also under §9's spool bounds** (see [`refuse_if_spool_beyond_bounds`]):
/// a rotation appends one `reencrypt` entry per version, so a design with a
/// thousand versions adds a thousand unshippable spool rows in the one
/// transaction a plain design write adds one. What §9 bounds is the growth of
/// unshipped sealed entries, not the shape of the write that grows them, so
/// the same refusal applies here.
pub async fn rotate_design(
    pool: &Pool,
    ring: &KeyRing,
    tenant: OrganisationId,
    actor: AccountId,
    design: DesignId,
    reason: &str,
) -> Result<RotationReport, DesignError> {
    rotate_design_under(
        pool,
        ring,
        tenant,
        actor,
        design,
        reason,
        audit::SpoolBounds::from_env(),
    )
    .await
}

/// The same, with §9's spool bounds named explicitly — see
/// [`write_version_under`] for why a bounds-explicit twin exists at all.
#[allow(clippy::too_many_arguments)]
pub async fn rotate_design_under(
    pool: &Pool,
    ring: &KeyRing,
    tenant: OrganisationId,
    actor: AccountId,
    design: DesignId,
    reason: &str,
    bounds: audit::SpoolBounds,
) -> Result<RotationReport, DesignError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let ctx = repo::open_tenant_context(&tx, tenant, actor).await?;

    let tenant_text = ctx.tenant().to_string();
    let design_text = design.to_string();
    // **Before the old key is retired, not after.** A `write_version` running
    // concurrently reads the active design key, encrypts under it, and inserts
    // — and a rotation that retires that key in between leaves a payload row
    // under an epoch the rotation has already walked past, so the next
    // rotation refuses with `Corrupt("payload key epoch")` and the version is
    // stranded under a key nothing re-encrypts. Both paths take this lock
    // first, so one waits for the other's transaction to commit.
    lock_design(&tx, &design_text, &tenant_text).await?;

    // Same bound, same reason: see this function's own doc. Checked after the
    // lock so a rotation waiting on a concurrent write sees the spool state as
    // of when it actually runs, and before any key is touched so a refusal
    // costs one aggregate query and leaves nothing half-done — no key
    // retired, no version re-encrypted.
    refuse_if_spool_beyond_bounds(&tx, &bounds).await?;

    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await?;
    let rotation = keys::rotate_design_key(&tx, &ctx, &tenant_key, design, reason).await?;

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

    // Files sealed under the old key move to the new one (all rows loaded at once; the per-design quota bounds that).
    let file_rows = tx
        .query(
            "SELECT file_id, ciphertext, nonce, key_epoch FROM design_files \
             WHERE design_id = $1 AND organisation_id = $2",
            &[&design_text, &tenant_text],
        )
        .await?;
    for row in file_rows {
        let file: String = row.get(0);
        let old_ciphertext: Vec<u8> = row.get(1);
        let old_nonce: Vec<u8> = row.get(2);
        let old_epoch: i32 = row.get(3);
        if old_epoch != rotation.previous.epoch {
            return Err(DesignError::Corrupt("file key epoch"));
        }
        let old_nonce: [u8; crypto::NONCE_LEN] = old_nonce
            .try_into()
            .map_err(|_| DesignError::Corrupt("file nonce"))?;
        let plain = crypto::open(
            &rotation.previous.key,
            &old_nonce,
            &old_ciphertext,
            &file_aad(&tenant_text, &design_text, &file, old_epoch),
        )
        .map_err(|_| DesignError::Refused)?;
        let nonce = crypto::random_nonce()?;
        let ciphertext = crypto::seal(
            &rotation.current.key,
            &nonce,
            &plain,
            &file_aad(&tenant_text, &design_text, &file, rotation.current.epoch),
        )?;
        tx.execute(
            "UPDATE design_files SET ciphertext = $4, nonce = $5, key_epoch = $6 \
             WHERE design_id = $1 AND organisation_id = $2 AND file_id = $3",
            &[
                &design_text,
                &tenant_text,
                &file,
                &ciphertext,
                &nonce.to_vec(),
                &rotation.current.epoch,
            ],
        )
        .await?;
        keys::count_write_under_key(&tx, design, rotation.current.epoch).await?;
    }

    // ADR-0063 #8: live changes and checkpoints, in pages, with the spool
    // bound re-checked before each page. All inside this transaction, so a
    // refusal part way leaves no key retired and nothing re-encrypted.
    let changes = rotate_sealed_rows(
        &tx,
        ring,
        &ctx,
        design,
        &rotation,
        reason,
        &bounds,
        Sealed::Change,
    )
    .await?;
    let checkpoints = rotate_sealed_rows(
        &tx,
        ring,
        &ctx,
        design,
        &rotation,
        reason,
        &bounds,
        Sealed::Checkpoint,
    )
    .await?;

    tx.commit().await?;

    Ok(RotationReport {
        design,
        from_key_epoch: rotation.previous.epoch,
        to_key_epoch: rotation.current.epoch,
        versions_reencrypted: versions + changes,
        chain_entries_written: entries + changes,
        checkpoints_reencrypted: checkpoints,
    })
}

/// Rows per rotation page.
const ROTATION_PAGE: i64 = 200;

/// Re-encrypt every `kind` row of a design under the new key. A change gets a
/// `reencrypt` entry, as a whole save does; a checkpoint is derived data and
/// gets none. Returns how many rows.
#[allow(clippy::too_many_arguments)]
async fn rotate_sealed_rows(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    rotation: &keys::Rotation,
    reason: &str,
    bounds: &audit::SpoolBounds,
    kind: Sealed,
) -> Result<usize, DesignError> {
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();
    let mut done = 0usize;
    let mut after = 0i64;
    loop {
        refuse_if_spool_beyond_bounds(tx, bounds).await?;
        let rows = tx
            .query(
                &format!(
                    "SELECT design_version, ciphertext, nonce, key_epoch, payload_schema_version                        FROM {} WHERE design_id = $1 AND organisation_id = $2                         AND design_version > $3 ORDER BY design_version LIMIT $4",
                    kind.table()
                ),
                &[&design_text, &tenant, &after, &ROTATION_PAGE],
            )
            .await?;
        if rows.is_empty() {
            return Ok(done);
        }
        for row in rows {
            let version: i64 = row.get(0);
            let old_epoch: i32 = row.get(3);
            let schema: i32 = row.get(4);
            if old_epoch != rotation.previous.epoch {
                return Err(DesignError::Corrupt("sealed row key epoch"));
            }
            let plaintext = open_sealed(
                kind,
                &rotation.previous,
                &tenant,
                &design_text,
                version,
                old_epoch,
                schema,
                &row.get::<_, Vec<u8>>(2),
                &row.get::<_, Vec<u8>>(1),
            )?;
            let nonce = crypto::random_nonce()?;
            let aad = sealed_aad(
                kind.tag(),
                &tenant,
                &design_text,
                version,
                rotation.current.epoch,
                schema,
            );
            let ciphertext = crypto::seal(&rotation.current.key, &nonce, &plaintext, &aad)?;
            tx.execute(
                &format!(
                    "UPDATE {} SET ciphertext = $4, nonce = $5, key_epoch = $6 \
                      WHERE design_id = $1 AND organisation_id = $2 AND design_version = $3",
                    kind.table()
                ),
                &[
                    &design_text,
                    &tenant,
                    &version,
                    &ciphertext,
                    &nonce.to_vec(),
                    &rotation.current.epoch,
                ],
            )
            .await?;
            keys::count_write_under_key(tx, design, rotation.current.epoch).await?;
            if kind == Sealed::Change {
                let previous = last_entry_for_version(tx, &design_text, &tenant, version).await?;
                let metadata = metadata_for_reencrypt(
                    ctx,
                    version,
                    schema,
                    old_epoch,
                    rotation.current.epoch,
                    &previous.storage_binding,
                    reason,
                );
                append_entry(
                    tx,
                    ring,
                    ctx,
                    design,
                    AppendFacts {
                        entry_type: EntryType::Reencrypt,
                        design_version: version,
                        plaintext: Some(&plaintext),
                        payload_schema_version: schema,
                        key: &rotation.current,
                        nonce: &nonce,
                        ciphertext: &ciphertext,
                        carried_plaintext_binding: Some(&previous.plaintext_binding),
                        metadata: &metadata,
                    },
                )
                .await?;
            }
            after = version;
            done += 1;
        }
    }
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
    let report = verify_design_locked(&tx, ring, &ctx, design, deep).await?;
    tx.commit().await?;
    Ok(report)
}

/// The same verification, re-checking `auth`'s grant immediately before it,
/// in the transaction and [`TenantContext`]
/// `design_api::verify_design_handler` already authorised in -- ADR-0054 #5,
/// exactly as [`write_version_in_tx`]'s own doc explains for a save.
pub async fn verify_design_in_tx(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    scope: Option<ScopeId>,
    deep: bool,
) -> Result<chain::Report, DesignError> {
    grants::authorise_account(tx, auth, scope, Capability::Read)
        .await
        .map_err(DesignError::Authority)?;
    verify_design_locked(tx, auth.ring, auth.ctx, design, deep).await
}

async fn verify_design_locked(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    deep: bool,
) -> Result<chain::Report, DesignError> {
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

    let design_chain = chain::ChainRef::Design {
        organisation: &tenant_text,
        design: &design_text,
    };

    let entries = read_entries(tx, &design_text, &tenant_text).await?;
    let facts = read_payload_facts(tx, &design_text, &tenant_text).await?;

    // **Every chain key epoch the entries name, derived.** `chain::chain_key`
    // takes the epoch as an input and the chain master in hand produces any of
    // them, so there is nothing here this server cannot check. Refusing to
    // derive anything but `CHAIN_KEY_EPOCH` -- which is what this did until
    // 2026-09-12 -- turned one `UPDATE` of an entry's `chain_key_epoch` into a
    // guaranteed way to make that entry unverifiable, which was half of the
    // switch §12.6a closed.
    //
    // `written_through` is the other half: this server has only ever written
    // `CHAIN_KEY_EPOCH`, so an entry naming anything above it is a changed
    // column and not a retired key somebody else holds. When retired chain key
    // epochs become a table, this becomes a query against it.
    let mut by_epoch = Vec::new();
    for epoch in entries
        .iter()
        .map(|e| e.chain_key_epoch)
        .collect::<std::collections::BTreeSet<_>>()
    {
        let ck = chain::chain_key(ring.chain_master(), design_chain, epoch);
        by_epoch.push((epoch, chain::Subkeys::derive(&ck)));
    }
    let keys_available = chain::AvailableKeys::new(by_epoch).written_through(CHAIN_KEY_EPOCH);

    let deep_payloads = if deep {
        let mut out: Vec<(i64, Vec<u8>)> = Vec::new();
        for (kind, p) in &facts {
            let key = design_key_at_epoch(tx, ring, ctx, design, p.key_epoch).await?;
            let bytes = open_sealed(
                *kind,
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

    // ADR-0063 #8: a checkpoint has no chain entry, so verify replays to check
    // it: each one must open, read, and equal the face replayed from whole
    // saves and changes alone.
    if deep {
        verify_checkpoints(tx, ring, ctx, design).await?;
    }

    // A design chain stores its metadata in the clear (§7.3: it is an actor,
    // an entry type and two version numbers), so `DeepInputs::metadata` is
    // empty and the verifier reads the column directly -- which means the
    // metadata binding is checked on a LINKS-ONLY run here, not only a deep
    // one. The encrypted chains are the ones that need handing plaintext.
    let deep_inputs = deep_payloads.as_ref().map(|payloads| chain::DeepInputs {
        payloads,
        metadata: &[],
        // Nothing to refuse: a design chain's metadata column is the
        // canonical plaintext, so there is no AEAD to open at all.
        refused_metadata: &[],
    });

    let payloads: Vec<chain::StoredPayload> = facts.into_iter().map(|(_, p)| p).collect();
    let report = chain::verify(
        design_chain,
        &entries,
        &payloads,
        &keys_available,
        deep_inputs.as_ref(),
    );

    Ok(report)
}

// ---------------------------------------------------------------------------
// Live changes and checkpoints (ADR-0063)
// ---------------------------------------------------------------------------

/// Every checkpoint of `design` against a replay that does not use any.
async fn verify_checkpoints(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
) -> Result<(), DesignError> {
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();
    let rows = tx
        .query(
            "SELECT design_version, ciphertext, nonce, key_epoch, payload_schema_version \
               FROM design_checkpoint WHERE design_id = $1 AND organisation_id = $2 \
              ORDER BY design_version",
            &[&design_text, &tenant],
        )
        .await?;
    let mut keys = KeyCache::default();
    for row in rows {
        let version: i64 = row.get(0);
        let key_epoch: i32 = row.get(3);
        let schema: i32 = row.get(4);
        let stored = open_sealed(
            Sealed::Checkpoint,
            keys.get(tx, ring, ctx, design, key_epoch).await?,
            &tenant,
            &design_text,
            version,
            key_epoch,
            schema,
            &row.get::<_, Vec<u8>>(2),
            &row.get::<_, Vec<u8>>(1),
        )?;
        let rebuild = rebuild_inputs(tx, ring, ctx, design, version, 0, false)
            .await?
            .ok_or(DesignError::Corrupt("checkpoint with no base to replay"))?;
        let replayed = heads::replay(rebuild).await.map_err(head_failure)?;
        if replayed != stored {
            tracing::error!(%design, version, "a checkpoint differs from its replay");
            return Err(DesignError::Corrupt("checkpoint differs from its replay"));
        }
    }
    Ok(())
}

/// A change body above this is refused before the signature is checked.
pub const MAX_CHANGE_BYTES: usize = 4 * 1024 * 1024;

/// The server writes a checkpoint after this many changes past the newest
/// full face.
pub const CHECKPOINT_EVERY: i64 = 100;

/// A stream more than this far behind resyncs instead of catching up.
pub const MAX_BEHIND_BYTES: i64 = 8 * 1024 * 1024;

/// The design's current version (the highest across whole saves and changes)
/// and the newest seal on its chain, read in one statement so they describe
/// the same instant.
pub(crate) async fn head_snapshot(
    tx: &Transaction<'_>,
    design: &str,
    tenant: &str,
) -> Result<(i64, Option<Vec<u8>>), DesignError> {
    let row = tx
        .query_one(
            "SELECT greatest( \
                 coalesce((SELECT max(design_version) FROM design_payload \
                            WHERE design_id = $1 AND organisation_id = $2), 0), \
                 coalesce((SELECT max(design_version) FROM design_change \
                            WHERE design_id = $1 AND organisation_id = $2), 0)), \
                    (SELECT seal FROM chain_entries \
                      WHERE design_id = $1 AND organisation_id = $2 \
                      ORDER BY seq DESC LIMIT 1)",
            &[&design, &tenant],
        )
        .await?;
    Ok((row.get(0), row.get(1)))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Sealed {
    Payload,
    Change,
    Checkpoint,
}

impl Sealed {
    fn tag(self) -> &'static [u8] {
        match self {
            Self::Payload => AAD_PAYLOAD,
            Self::Change => AAD_CHANGE,
            Self::Checkpoint => AAD_CHECKPOINT,
        }
    }

    fn table(self) -> &'static str {
        match self {
            Self::Payload => "design_payload",
            Self::Change => "design_change",
            Self::Checkpoint => "design_checkpoint",
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn open_sealed(
    kind: Sealed,
    key: &DataKey,
    tenant: &str,
    design: &str,
    version: i64,
    key_epoch: i32,
    schema: i32,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, DesignError> {
    let nonce: [u8; crypto::NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| DesignError::Corrupt("sealed row nonce"))?;
    let aad = sealed_aad(kind.tag(), tenant, design, version, key_epoch, schema);
    crypto::open(&key.key, &nonce, ciphertext, &aad).map_err(|_| DesignError::Refused)
}

/// Design keys by epoch, fetched once per call.
#[derive(Default)]
struct KeyCache(BTreeMap<i32, DataKey>);

impl KeyCache {
    async fn get(
        &mut self,
        tx: &Transaction<'_>,
        ring: &KeyRing,
        ctx: &TenantContext,
        design: DesignId,
        epoch: i32,
    ) -> Result<&DataKey, DesignError> {
        Ok(match self.0.entry(epoch) {
            std::collections::btree_map::Entry::Occupied(o) => o.into_mut(),
            std::collections::btree_map::Entry::Vacant(v) => {
                v.insert(design_key_at_epoch(tx, ring, ctx, design, epoch).await?)
            }
        })
    }
}

/// The bases a head at `target` can start from, newest first: whole saves and
/// checkpoints at or below it.
async fn base_candidates(
    tx: &Transaction<'_>,
    design: &str,
    tenant: &str,
    target: i64,
    checkpoints: bool,
) -> Result<Vec<(i64, Sealed)>, DesignError> {
    let rows = tx
        .query(
            "SELECT design_version, false FROM design_payload \
              WHERE design_id = $1 AND organisation_id = $2 AND design_version <= $3 \
             UNION ALL \
             SELECT design_version, true FROM design_checkpoint \
              WHERE design_id = $1 AND organisation_id = $2 AND design_version <= $3 \
                AND $4 \
             ORDER BY 1 DESC LIMIT 8",
            &[&design, &tenant, &target, &checkpoints],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let checkpoint: bool = r.get(1);
            (
                r.get(0),
                if checkpoint {
                    Sealed::Checkpoint
                } else {
                    Sealed::Payload
                },
            )
        })
        .collect())
}

/// The inputs for a head at `target`: the `skip`th newest base and every
/// change after it. `None` when there is no such base. Only a checkpoint may
/// be skipped (a failing whole save is not replaceable by an older one).
/// With `checkpoints` false only whole saves are bases: a replay that does not
/// trust the derived data (verify).
pub(crate) async fn rebuild_inputs(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    target: i64,
    skip: usize,
    checkpoints: bool,
) -> Result<Option<Rebuild>, DesignError> {
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();
    let candidates = base_candidates(tx, &design_text, &tenant, target, checkpoints).await?;
    if candidates[..skip.min(candidates.len())]
        .iter()
        .any(|(_, kind)| *kind != Sealed::Checkpoint)
    {
        return Ok(None);
    }
    let Some(&(base_version, kind)) = candidates.get(skip) else {
        return Ok(None);
    };

    let mut keys = KeyCache::default();
    let row = tx
        .query_opt(
            &format!(
                "SELECT ciphertext, nonce, key_epoch, payload_schema_version FROM {} \
                  WHERE design_id = $1 AND organisation_id = $2 AND design_version = $3",
                kind.table()
            ),
            &[&design_text, &tenant, &base_version],
        )
        .await?
        .ok_or(DesignError::Corrupt("base version"))?;
    let key_epoch: i32 = row.get(2);
    let schema: i32 = row.get(3);
    let base = open_sealed(
        kind,
        keys.get(tx, ring, ctx, design, key_epoch).await?,
        &tenant,
        &design_text,
        base_version,
        key_epoch,
        schema,
        &row.get::<_, Vec<u8>>(1),
        &row.get::<_, Vec<u8>>(0),
    )?;

    let rows = tx
        .query(
            "SELECT design_version, ciphertext, nonce, key_epoch, payload_schema_version, \
                    created_by \
               FROM design_change \
              WHERE design_id = $1 AND organisation_id = $2 \
                AND design_version > $3 AND design_version <= $4 \
              ORDER BY design_version",
            &[&design_text, &tenant, &base_version, &target],
        )
        .await?;
    let mut changes = Vec::with_capacity(rows.len());
    let mut expected = base_version + 1;
    for row in rows {
        let version: i64 = row.get(0);
        if version != expected {
            return Err(DesignError::Corrupt("change sequence"));
        }
        expected += 1;
        let key_epoch: i32 = row.get(3);
        let schema: i32 = row.get(4);
        let author: String = row.get(5);
        let author: AccountId = author
            .parse()
            .map_err(|_| DesignError::Corrupt("change author"))?;
        let doc = open_sealed(
            Sealed::Change,
            keys.get(tx, ring, ctx, design, key_epoch).await?,
            &tenant,
            &design_text,
            version,
            key_epoch,
            schema,
            &row.get::<_, Vec<u8>>(2),
            &row.get::<_, Vec<u8>>(1),
        )?;
        changes.push((doc, author.0));
    }
    if expected != target + 1 {
        return Err(DesignError::Corrupt("change sequence"));
    }
    Ok(Some(Rebuild { base, changes }))
}

/// The keyed digest a change's batch id is idempotent against.
fn change_digest(ring: &KeyRing, tenant: &str, design: &str, body: &[u8]) -> [u8; 32] {
    let design_chain = chain::ChainRef::Design {
        organisation: tenant,
        design,
    };
    let ck = chain::chain_key(ring.chain_master(), design_chain, CHAIN_KEY_EPOCH);
    let sub = chain::Subkeys::derive(&ck);
    let mut message = Vec::new();
    crypto::lp(&mut message, b"fathom/change/digest/v1");
    message.extend_from_slice(body);
    crypto::mac(sub.content.expose(), &message)
}

/// The newest version that is a full face (a whole save or a checkpoint).
async fn newest_base(tx: &Transaction<'_>, design: &str, tenant: &str) -> Result<i64, DesignError> {
    let row = tx
        .query_one(
            "SELECT greatest( \
                 coalesce((SELECT max(design_version) FROM design_payload \
                            WHERE design_id = $1 AND organisation_id = $2), 0), \
                 coalesce((SELECT max(design_version) FROM design_checkpoint \
                            WHERE design_id = $1 AND organisation_id = $2), 0))",
            &[&design, &tenant],
        )
        .await?;
    Ok(row.get(0))
}

/// A stored change: the new version and the head that goes with it once the
/// transaction commits.
pub struct ChangeWritten {
    pub version: i64,
    /// `Some` unless this was a retry of a change already stored.
    pub applied: Option<AppliedChange>,
}

pub struct AppliedChange {
    pub ticket: u64,
    /// The chain tip after this change's entry.
    pub tip: Vec<u8>,
}

/// ADR-0063 #3: apply a signed-in account's change to the design's head, and
/// if the head accepts it, store it as the next version with its chain entry,
/// all in `tx`. The caller commits, then reports to `store`
/// ([`HeadStore::commit`]); on any refusal here the pending copy is dropped.
///
/// Order, which matters: spool bound, `draw`, the row lock, then (only for an
/// authorised caller) the idempotency lookup, then the head.
#[allow(clippy::too_many_arguments)]
pub async fn write_change_in_tx(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    store: &HeadStore,
    design: DesignId,
    scope: Option<ScopeId>,
    doc: &[u8],
    schema: i32,
    after: i64,
    bounds: &audit::SpoolBounds,
) -> Result<ChangeWritten, DesignError> {
    refuse_if_spool_beyond_bounds(tx, bounds).await?;
    grants::authorise_account(tx, auth, scope, Capability::Draw)
        .await
        .map_err(DesignError::Authority)?;
    let ctx = auth.ctx;
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();
    lock_design(tx, &design_text, &tenant).await?;

    let parsed = fathom_workspace::read_change(doc)
        .map_err(|e| DesignError::ChangeRefused(e.to_string()))?;
    let batch_id = parsed.batch.id.0.encode();
    let digest = change_digest(auth.ring, &tenant, &design_text, doc);

    if let Some(row) = tx
        .query_opt(
            "SELECT design_version, body_digest FROM design_change \
              WHERE design_id = $1 AND organisation_id = $2 AND batch_id = $3",
            &[&design_text, &tenant, &batch_id],
        )
        .await?
    {
        let stored: Vec<u8> = row.get(1);
        return if stored == digest {
            Ok(ChangeWritten {
                version: row.get(0),
                applied: None,
            })
        } else {
            Err(DesignError::BatchIdUsed)
        };
    }

    let (current, tip) = head_snapshot(tx, &design_text, &tenant).await?;
    if current == 0 {
        return Err(DesignError::NoSuchVersion);
    }
    if after > current {
        return Err(DesignError::ChangeAhead { after, current });
    }
    let version = current + 1;
    let want_checkpoint =
        version - newest_base(tx, &design_text, &tenant).await? >= CHECKPOINT_EVERY;

    let key = HeadKey {
        design: design_text.clone(),
        version: current,
        tip: tip.unwrap_or_default(),
    };
    let mut rebuild: Option<Rebuild> = None;
    let mut skip = 0usize;
    let applied = loop {
        match store
            .apply(
                &key,
                rebuild.take(),
                doc.to_vec(),
                ctx.actor().0,
                want_checkpoint,
            )
            .await
        {
            Ok(applied) => break applied,
            Err(HeadError::NeedRebuild) => {}
            Err(HeadError::Rebuild(why)) => {
                tracing::warn!(%design, %why, "a base would not load; trying an older one");
                skip += 1;
            }
            Err(e) => return Err(head_failure(e)),
        }
        if skip >= BASE_FALLBACKS {
            return Err(DesignError::Corrupt("design head"));
        }
        rebuild = Some(
            rebuild_inputs(tx, auth.ring, ctx, design, current, skip, true)
                .await?
                .ok_or(DesignError::Corrupt("design head"))?,
        );
    };

    let stored = store_change(
        tx, auth.ring, ctx, design, version, &batch_id, &digest, doc, schema,
    )
    .await;
    let tip = match stored {
        Ok(tip) => tip,
        Err(e) => {
            store.abort(&design_text, applied.ticket);
            return Err(e);
        }
    };
    if let Some(plain) = &applied.plain {
        if let Err(e) = insert_checkpoint(tx, auth.ring, ctx, design, version, plain).await {
            store.abort(&design_text, applied.ticket);
            return Err(e);
        }
    }
    Ok(ChangeWritten {
        version,
        applied: Some(AppliedChange {
            ticket: applied.ticket,
            tip,
        }),
    })
}

/// Seal and insert one change, and append its chain entry. Returns the new
/// chain tip.
#[allow(clippy::too_many_arguments)]
async fn store_change(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    version: i64,
    batch_id: &str,
    digest: &[u8; 32],
    doc: &[u8],
    schema: i32,
) -> Result<Vec<u8>, DesignError> {
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();
    let key = keys::design_key(tx, ring, ctx, design).await?;
    let nonce = crypto::random_nonce()?;
    let aad = sealed_aad(
        AAD_CHANGE,
        &tenant,
        &design_text,
        version,
        key.epoch,
        schema,
    );
    let ciphertext = crypto::seal(&key.key, &nonce, doc, &aad)?;
    tx.execute(
        "INSERT INTO design_change \
             (design_id, organisation_id, design_version, batch_id, body_digest, ciphertext, \
              nonce, key_epoch, wrap_version, aead_alg_id, payload_schema_version, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        &[
            &design_text,
            &tenant,
            &version,
            &batch_id,
            &digest.to_vec(),
            &ciphertext,
            &nonce.to_vec(),
            &key.epoch,
            &crypto::WRAP_VERSION,
            &crypto::AEAD_ALG_CHACHA20POLY1305_IETF,
            &schema,
            &ctx.actor().to_string(),
        ],
    )
    .await?;
    keys::count_write_under_key(tx, design, key.epoch).await?;

    let metadata = metadata_for_write(ctx, version, schema, EntryType::Change);
    append_entry(
        tx,
        ring,
        ctx,
        design,
        AppendFacts {
            entry_type: EntryType::Change,
            design_version: version,
            plaintext: Some(doc),
            payload_schema_version: schema,
            key: &key,
            nonce: &nonce,
            ciphertext: &ciphertext,
            carried_plaintext_binding: None,
            metadata: &metadata,
        },
    )
    .await
}

/// Seal `plain` as the checkpoint at `version`, under the acting account.
/// No chain entry: it is derived from chained data.
async fn insert_checkpoint(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    version: i64,
    plain: &[u8],
) -> Result<(), DesignError> {
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();
    let schema = current_schema_number();
    let key = keys::design_key(tx, ring, ctx, design).await?;
    let nonce = crypto::random_nonce()?;
    let aad = sealed_aad(
        AAD_CHECKPOINT,
        &tenant,
        &design_text,
        version,
        key.epoch,
        schema,
    );
    let ciphertext = crypto::seal(&key.key, &nonce, plain, &aad)?;
    let inserted = tx
        .execute(
            "INSERT INTO design_checkpoint \
                 (design_id, organisation_id, design_version, ciphertext, nonce, key_epoch, \
                  wrap_version, aead_alg_id, payload_schema_version, written_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
             ON CONFLICT (design_id, design_version) DO NOTHING",
            &[
                &design_text,
                &tenant,
                &version,
                &ciphertext,
                &nonce.to_vec(),
                &key.epoch,
                &crypto::WRAP_VERSION,
                &crypto::AEAD_ALG_CHACHA20POLY1305_IETF,
                &schema,
                &ctx.actor().to_string(),
            ],
        )
        .await?;
    if inserted == 1 {
        keys::count_write_under_key(tx, design, key.epoch).await?;
    }
    Ok(())
}

/// When the last stream on a design closes: write a checkpoint at the current
/// version if changes landed since the newest full face. Under `auth`'s
/// account, after a `read` check; takes the design lock so it cannot race a
/// change.
pub async fn checkpoint_if_due_in_tx(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    store: &HeadStore,
    design: DesignId,
    scope: Option<ScopeId>,
) -> Result<bool, DesignError> {
    grants::authorise_account(tx, auth, scope, Capability::Read)
        .await
        .map_err(DesignError::Authority)?;
    let ctx = auth.ctx;
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();
    lock_design(tx, &design_text, &tenant).await?;
    let (current, tip) = head_snapshot(tx, &design_text, &tenant).await?;
    if current == 0 || current <= newest_base(tx, &design_text, &tenant).await? {
        return Ok(false);
    }
    let key = HeadKey {
        design: design_text,
        version: current,
        tip: tip.unwrap_or_default(),
    };
    let plain = materialise(tx, auth.ring, ctx, design, current, Some(&key), Some(store)).await?;
    if fathom_workspace::read_plain(&plain).is_err() {
        tracing::error!(%design, "a checkpoint did not read back; skipped");
        return Ok(false);
    }
    insert_checkpoint(tx, auth.ring, ctx, design, current, &plain).await?;
    Ok(true)
}

/// What a stream has to say about a design since a version.
pub enum LiveBatch {
    /// Frames to send, oldest first. A whole save is a `Reload` with no body.
    Rows(Vec<LiveRow>),
    /// Too far behind to catch up in frames.
    Resync,
}

pub struct LiveRow {
    pub version: i64,
    /// `Some(change document)`, or `None` for a whole save that landed.
    pub change: Option<Vec<u8>>,
    /// The account that made the change.
    pub author: Option<String>,
}

/// The rows after `since`, at most `limit` of them. If a whole save landed
/// after `since`, the first row is that save and the changes follow it.
pub(crate) async fn live_rows_after(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    ctx: &TenantContext,
    design: DesignId,
    since: i64,
    limit: i64,
) -> Result<LiveBatch, DesignError> {
    let tenant = ctx.tenant().to_string();
    let design_text = design.to_string();
    let (current, _) = head_snapshot(tx, &design_text, &tenant).await?;
    if since > current {
        return Ok(LiveBatch::Resync);
    }
    let mut rows = Vec::new();
    let mut floor = since;
    let save: Option<i64> = tx
        .query_one(
            "SELECT max(design_version) FROM design_payload \
              WHERE design_id = $1 AND organisation_id = $2 AND design_version > $3",
            &[&design_text, &tenant, &since],
        )
        .await?
        .get(0);
    if let Some(save) = save {
        rows.push(LiveRow {
            version: save,
            change: None,
            author: None,
        });
        floor = save;
    }
    let behind: i64 = tx
        .query_one(
            "SELECT coalesce(sum(octet_length(ciphertext)), 0)::bigint FROM design_change \
              WHERE design_id = $1 AND organisation_id = $2 AND design_version > $3 \
                AND design_version <= $4",
            &[&design_text, &tenant, &floor, &current],
        )
        .await?
        .get(0);
    if behind > MAX_BEHIND_BYTES {
        return Ok(LiveBatch::Resync);
    }
    let found = tx
        .query(
            "SELECT design_version, ciphertext, nonce, key_epoch, payload_schema_version, \
                    created_by \
               FROM design_change \
              WHERE design_id = $1 AND organisation_id = $2 \
                AND design_version > $3 AND design_version <= $4 \
              ORDER BY design_version LIMIT $5",
            &[&design_text, &tenant, &floor, &current, &limit],
        )
        .await?;
    let mut keys = KeyCache::default();
    for row in found {
        let version: i64 = row.get(0);
        let key_epoch: i32 = row.get(3);
        let schema: i32 = row.get(4);
        let doc = open_sealed(
            Sealed::Change,
            keys.get(tx, ring, ctx, design, key_epoch).await?,
            &tenant,
            &design_text,
            version,
            key_epoch,
            schema,
            &row.get::<_, Vec<u8>>(2),
            &row.get::<_, Vec<u8>>(1),
        )?;
        rows.push(LiveRow {
            version,
            change: Some(doc),
            author: Some(row.get(5)),
        });
    }
    Ok(LiveBatch::Rows(rows))
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
) -> Result<Vec<u8>, DesignError> {
    let tenant_text = ctx.tenant().to_string();
    let design_text = design.to_string();

    let design_chain = chain::ChainRef::Design {
        organisation: &tenant_text,
        design: &design_text,
    };
    let ck = chain::chain_key(ring.chain_master(), design_chain, CHAIN_KEY_EPOCH);
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
        None => (1, chain::genesis(design_chain).to_vec()),
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

    // A design entry's metadata is stored in the clear, so `metadata_stored`
    // and the bytes the binding is taken over are the same slice. On the site
    // and organisation chains they are not, which is why the seal takes both.
    let metadata_binding = chain::metadata_binding(&sub.content, facts.metadata);

    let seal = chain::seal(
        &sub.seal,
        &chain::SealFacts {
            chain_key_epoch: CHAIN_KEY_EPOCH,
            seq,
            chain: design_chain,
            prev_seal: &prev_seal,
            content_hash: &content_hash,
            entry_type: facts.entry_type,
            metadata_stored: facts.metadata,
            metadata_binding: &metadata_binding,
        },
    );

    tx.execute(
        "INSERT INTO chain_entries \
             (chain_kind, chain_id, design_id, organisation_id, seq, entry_type, \
              chain_key_epoch, design_version, prev_seal, plaintext_binding, storage_binding, \
              content_hash, seal, metadata, metadata_binding) \
         VALUES ('design', $1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
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
            &metadata_binding.to_vec(),
        ],
    )
    .await?;

    // **The same transaction as the entry, which is the same transaction as
    // the payload.** `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §9: an act that
    // cannot queue its audit line does not commit, which is the whole of
    // "stopping the log stops the act". Queuing afterwards, in its own
    // transaction, would have written the design and lost the record on any
    // failure between the two.
    crate::audit::spool(
        tx,
        crate::chain::ChainKind::Design,
        &design_text,
        seq,
        facts.entry_type,
        CHAIN_KEY_EPOCH,
        &seal,
    )
    .await?;

    Ok(seal.to_vec())
}

/// Take the design's own row as the lock for everything that writes under it.
///
/// **One writer per design at a time**, which is what both `write_version` and
/// `rotate_design` need and neither had: the version number comes from
/// `max(design_version) + 1` and the chain's `seq` from `max(seq) + 1`, and
/// two transactions reading either at once produce two rows claiming the same
/// number — the primary key refuses one of them, which is the good case, and
/// the bad case is a rotation walking a version list another transaction is
/// still adding to.
///
/// `FOR UPDATE` on the `designs` row rather than an advisory lock: it is
/// scoped to the transaction, released on commit or rollback with no `unlock`
/// to forget, and it is the row every one of these operations already has to
/// exist for. A design id from another tenant locks nothing and reads as
/// absent, which is the same answer every other path here gives.
async fn lock_design(tx: &Transaction<'_>, design: &str, tenant: &str) -> Result<(), DesignError> {
    tx.query_opt(
        "SELECT 1 FROM designs WHERE id = $1 AND organisation_id = $2 FOR UPDATE",
        &[&design, &tenant],
    )
    .await?
    .ok_or(DesignError::NoSuchDesign)?;
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
                    plaintext_binding, storage_binding, content_hash, seal, metadata, \
                    metadata_binding \
             FROM chain_entries WHERE design_id = $1 AND organisation_id = $2 ORDER BY seq",
            &[&design, &tenant],
        )
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        // Carried, never refused -- see `chain::StoredEntryType`. A type this
        // build cannot parse breaks AT that row and leaves everything before
        // it verified, rather than making the design's whole history
        // unreadable.
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

/// The stored bodies the chain's entries bind: whole saves and live changes
/// (never checkpoints, which have no entry), each tagged with what it is.
async fn read_payload_facts(
    tx: &Transaction<'_>,
    design: &str,
    tenant: &str,
) -> Result<Vec<(Sealed, chain::StoredPayload)>, DesignError> {
    // The key id comes from `design_keys`, which is where a verifier holding
    // only the chain key finds it: it is the data key's NON-SECRET id, not the
    // key.
    let mut out = Vec::new();
    for kind in [Sealed::Payload, Sealed::Change] {
        let rows = tx
            .query(
                &format!(
                    "SELECT p.design_version, k.key_id, p.key_epoch, p.wrap_version, \
                            p.aead_alg_id, p.nonce, p.ciphertext, p.payload_schema_version \
                     FROM {} p \
                     JOIN design_keys k \
                       ON k.design_id = p.design_id AND k.key_epoch = p.key_epoch \
                     WHERE p.design_id = $1 AND p.organisation_id = $2 \
                     ORDER BY p.design_version",
                    kind.table()
                ),
                &[&design, &tenant],
            )
            .await?;
        for row in rows {
            let key_id: String = row.get(1);
            out.push((
                kind,
                chain::StoredPayload {
                    design_version: row.get(0),
                    key_id: crypto::KeyId::parse(&key_id).ok_or(DesignError::Corrupt("key id"))?,
                    key_epoch: row.get(2),
                    wrap_version: row.get(3),
                    aead_alg_id: row.get(4),
                    nonce: row.get(5),
                    ciphertext: row.get(6),
                    payload_schema_version: row.get(7),
                },
            ));
        }
    }
    out.sort_by_key(|(_, p)| p.design_version);
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

/// Decrypt one stored version with a design key the **caller** supplies.
///
/// The offline-recovery path: an operator holding a database dump and the key
/// files needs exactly this, and there is no server to ask.
///
/// **It is also what makes §12.6's exposure sentence demonstrable rather than
/// asserted.** *"Anyone who holds the previous master key and a copy of the key
/// rows taken before this switch can still decrypt all data"* — a test can now
/// do that, through the same AAD construction the real read path uses, instead
/// of asserting around the claim. A private helper would have meant writing the
/// associated data twice, and two copies of an AAD is how one of them quietly
/// stops matching.
#[allow(clippy::too_many_arguments)]
pub fn open_stored_version(
    key: &crypto::Key32,
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
    crypto::open(key, &nonce, ciphertext, &aad).map_err(|_| DesignError::Refused)
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

    #[test]
    fn debugging_a_decrypted_version_does_not_print_the_design() {
        // A derived `Debug` puts the estate map into any log line, tracing
        // field or panic message that happens to carry one of these. §3
        // encrypts the payload whole to keep it out of the database; a log
        // file is the same disclosure through a different door.
        let version = DesignVersion {
            design: DesignId::new(),
            version: 4,
            payload_schema_version: 1,
            payload: br#"{"devices":[{"name":"core-fw-01","address":"10.1.1.0/24"}]}"#.to_vec(),
        };
        let rendered = format!("{version:?}");
        assert!(!rendered.contains("core-fw-01"), "{rendered}");
        assert!(!rendered.contains("10.1.1.0/24"), "{rendered}");
        assert!(!rendered.contains("devices"), "{rendered}");
        // What it does say is what is already disclosed by a dump (§11.3):
        // which version, and how big.
        assert!(rendered.contains("version: 4"), "{rendered}");
        assert!(rendered.contains("59 bytes"), "{rendered}");
    }
}

// ---------------------------------------------------------------------------
// Files on docs (ADR-0061 round 10)
// ---------------------------------------------------------------------------

/// What a file's own bytes say it is. Never the name, never a client-declared type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileMedia {
    Text,
    Pdf,
    Image,
}

impl FileMedia {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Pdf => "pdf",
            Self::Image => "image",
        }
    }
}

/// Sniff a file by content: PDF and image by signature, text when it is valid UTF-8 with no NUL
/// and no control character beyond tab, newline, carriage return and form feed. `None` for
/// anything else, and for an empty file.
pub fn sniff_file(bytes: &[u8]) -> Option<FileMedia> {
    if bytes.is_empty() {
        return None;
    }
    if bytes.starts_with(b"%PDF-") {
        return Some(FileMedia::Pdf);
    }
    let image = bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
        || bytes.starts_with(&[0xff, 0xd8, 0xff])
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP");
    if image {
        return Some(FileMedia::Image);
    }
    let text = core::str::from_utf8(bytes).ok()?;
    let clean = text
        .chars()
        .all(|c| !c.is_control() || matches!(c, '\t' | '\n' | '\r' | '\u{c}'));
    clean.then_some(FileMedia::Text)
}

fn file_aad(tenant: &str, design: &str, file: &str, key_epoch: i32) -> Vec<u8> {
    let mut aad = Vec::new();
    crypto::lp(&mut aad, AAD_FILE);
    crypto::lp(&mut aad, tenant.as_bytes());
    crypto::lp(&mut aad, design.as_bytes());
    crypto::lp(&mut aad, file.as_bytes());
    crypto::u32_le(&mut aad, key_epoch as u32);
    aad
}

/// Seal and store one file for a design, drawing rights required. Returns its id.
/// The caller has already run the content check ([`sniff_file`]) and any text scan.
pub async fn store_file_in_tx(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    scope: Option<ScopeId>,
    bytes: &[u8],
) -> Result<String, DesignError> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(DesignError::FileTooLarge { bytes: bytes.len() });
    }
    grants::authorise_account(tx, auth, scope, Capability::Draw)
        .await
        .map_err(DesignError::Authority)?;
    let tenant_text = auth.ctx.tenant().to_string();
    let design_text = design.to_string();
    lock_design(tx, &design_text, &tenant_text).await?;
    let held = tx
        .query_one(
            "SELECT count(*), COALESCE(sum(octet_length(ciphertext)), 0)::bigint \
             FROM design_files WHERE design_id = $1 AND organisation_id = $2",
            &[&design_text, &tenant_text],
        )
        .await
        .map_err(DesignError::Db)?;
    let (count, total): (i64, i64) = (held.get(0), held.get(1));
    if count >= MAX_DESIGN_FILES || total + bytes.len() as i64 > MAX_DESIGN_FILE_BYTES {
        return Err(DesignError::FileQuota);
    }
    let key = keys::design_key(tx, auth.ring, auth.ctx, design).await?;

    let id = {
        let a = crypto::random_nonce()?;
        let b = crypto::random_nonce()?;
        let mut raw = a.to_vec();
        raw.extend_from_slice(&b[..4]);
        hex(&raw)
    };
    let nonce = crypto::random_nonce()?;
    let aad = file_aad(&tenant_text, &design_text, &id, key.epoch);
    let ciphertext = crypto::seal(&key.key, &nonce, bytes, &aad)?;
    tx.execute(
        "INSERT INTO design_files \
             (design_id, organisation_id, file_id, ciphertext, nonce, key_epoch, wrap_version, \
              aead_alg_id, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        &[
            &design_text,
            &tenant_text,
            &id,
            &ciphertext,
            &nonce.to_vec(),
            &key.epoch,
            &crypto::WRAP_VERSION,
            &crypto::AEAD_ALG_CHACHA20POLY1305_IETF,
            &auth.ctx.actor().to_string(),
        ],
    )
    .await?;
    keys::count_write_under_key(tx, design, key.epoch).await?;
    Ok(id)
}

/// Open one stored file, read rights required.
pub async fn read_file_in_tx(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    scope: Option<ScopeId>,
    file: &str,
) -> Result<Vec<u8>, DesignError> {
    grants::authorise_account(tx, auth, scope, Capability::Read)
        .await
        .map_err(DesignError::Authority)?;
    let tenant_text = auth.ctx.tenant().to_string();
    let design_text = design.to_string();
    let row = tx
        .query_opt(
            "SELECT ciphertext, nonce, key_epoch FROM design_files \
             WHERE design_id = $1 AND organisation_id = $2 AND file_id = $3",
            &[&design_text, &tenant_text, &file],
        )
        .await?
        .ok_or(DesignError::NoSuchFile)?;
    let ciphertext: Vec<u8> = row.get(0);
    let nonce: Vec<u8> = row.get(1);
    let epoch: i32 = row.get(2);
    let key = design_key_at_epoch(tx, auth.ring, auth.ctx, design, epoch).await?;
    let nonce: [u8; crypto::NONCE_LEN] = nonce
        .try_into()
        .map_err(|_| DesignError::Corrupt("file nonce"))?;
    let aad = file_aad(&tenant_text, &design_text, file, epoch);
    crypto::open(&key.key, &nonce, &ciphertext, &aad).map_err(|_| DesignError::Refused)
}

#[cfg(test)]
mod file_sniff_tests {
    use super::*;

    #[test]
    fn sniffs_by_content_not_by_name() {
        assert_eq!(sniff_file(b"%PDF-1.7\n%..."), Some(FileMedia::Pdf));
        assert_eq!(
            sniff_file(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0]),
            Some(FileMedia::Image)
        );
        assert_eq!(
            sniff_file(&[0xff, 0xd8, 0xff, 0xe0]),
            Some(FileMedia::Image)
        );
        assert_eq!(sniff_file(b"GIF89a.."), Some(FileMedia::Image));
        assert_eq!(
            sniff_file(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some(FileMedia::Image)
        );
        assert_eq!(
            sniff_file(b"hostname core-01\nset x y\n"),
            Some(FileMedia::Text)
        );
        assert_eq!(
            sniff_file("naïve – unicode".as_bytes()),
            Some(FileMedia::Text)
        );
    }

    #[test]
    fn refuses_what_is_not_one_of_the_three() {
        assert_eq!(sniff_file(b""), None);
        assert_eq!(sniff_file(b"MZ\x90\x00\x03"), None); // an executable
        assert_eq!(sniff_file(b"PK\x03\x04"), None); // a zip, also docx
        assert_eq!(sniff_file(b"\x7fELF\x02"), None);
        assert_eq!(sniff_file(b"text with a nul\x00inside"), None);
        assert_eq!(sniff_file(&[0xc3, 0x28]), None); // invalid UTF-8
        assert_eq!(sniff_file(b"escape \x1b[31m"), None);
    }
}
