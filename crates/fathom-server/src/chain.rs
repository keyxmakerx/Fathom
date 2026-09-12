//! The tamper-evident history: the constructions from
//! `docs/PHASE-2-STORAGE-DESIGN.md` §11.2 and §12.2, and the verifier that
//! reports §11.2's three outcomes and its fourth sub-state.
//!
//! This module is pure. It touches no database: `designs` reads the rows and
//! hands them here, which is what lets every construction below be driven
//! from a test with no PostgreSQL at all, and what lets a chain be exported
//! and verified somewhere else.
//!
//! # The two things a verifier must never conflate
//!
//! **"Content not checked" must never render the same as "content
//! verified."** Routine verification is links plus storage bindings, no
//! decryption, runnable by an operator holding only the chain key. Deep
//! verification additionally decrypts and recomputes the plaintext binding.
//! **Both must name which they ran** — see [`Report::summary`].
//!
//! # The order of the checks is itself a control (§12.6a)
//!
//! **Everything verifiable is verified first, and a coverage gap is an extra
//! fact reported alongside — never an early return.** Returning the gap first
//! made it a switch: one `UPDATE` of any entry's `chain_key_epoch` turned a
//! detected forgery into *"a coverage gap, not a failure"*, with a summary
//! claiming the earlier entries verified over entries nothing had examined.
//! Any count of what verified comes from verification and never from a
//! position in a list, and an epoch above what this deployment ever wrote is
//! an anomaly rather than a gap, because there is no retired key to find.
//!
//! # What the chain does not do
//!
//! Each seal binds backwards only. Deleting the last three entries leaves the
//! survivors verifying end to end, and restoring last month's tables produces
//! a rollback the chain cryptographically endorses (§6's B4 fix). `seq` is in
//! the MAC input and **does not** detect tail truncation. Only an anchor
//! outside the deployment does, and this order does not build one.

use core::fmt;

use sha2::{Digest, Sha256};

use crate::crypto::{self, Key32, KeyId};

/// The per-design chain key's derivation label (§12.2).
///
/// **Length-prefixed, and that is the fix.** §6 said the chain key is scoped
/// per design; §11.2 then started from it as a given. Without length prefixes
/// on the identity inputs, tenant `ab` + design `c` and tenant `a` + design
/// `bc` derive the **same chain key** — the identical splice §11.2 closed one
/// layer up.
const CHAIN_KEY_LABEL: &[u8] = b"fathom/chain/key/v1";

/// HKDF `info` for the sealing subkey (§12.2).
///
/// **Deliberately not the same literal as the in-MAC domain tag below**, even
/// though they were in §11.2's first draft. Different functions under
/// different keys, so the reuse was not a weakness — but someone would later
/// tidy one occurrence and silently change the other, and the seals written
/// before that day would stop verifying.
const KDF_SEAL_LABEL: &[u8] = b"fathom/chain/kdf/seal/v1";

/// HKDF `info` for the content-binding subkey (§12.2).
const KDF_CONTENT_LABEL: &[u8] = b"fathom/chain/kdf/content/v1";

/// The in-MAC domain tags. §11.2's, unchanged.
const TAG_PLAINTEXT: &[u8] = b"fathom/chain/plaintext/v1";
const TAG_STORAGE: &[u8] = b"fathom/chain/storage/v1";
const TAG_CONTENT: &[u8] = b"fathom/chain/content/v1";
const TAG_SEAL: &[u8] = b"fathom/chain/seal/v1";
const TAG_GENESIS: &[u8] = b"fathom/chain/genesis/v1";

/// What kind of event an entry records.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EntryType {
    /// The first version of a design.
    Create,
    /// A new version, written by someone.
    Update,
    /// **The same content, different bytes** — a rotation re-encrypted this
    /// version under a new key (§11.2, §12.6). The entry carries
    /// `plaintext_binding` across unchanged, which is itself the proof that
    /// the content did not change when the bytes did, and its metadata
    /// records the epochs, wrap versions and storage bindings on both sides.
    ///
    /// This is what stops a routine key rotation looking exactly like an
    /// attack, and so stops operators learning to dismiss the alarm.
    Reencrypt,
}

impl EntryType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Reencrypt => "reencrypt",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "create" => Some(Self::Create),
            "update" => Some(Self::Update),
            "reencrypt" => Some(Self::Reencrypt),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/// The per-design chain key, §12.2 exactly:
///
/// ```text
/// chain_key_epoch_e = HKDF-Expand(chain_master,
///     info = LP("fathom/chain/key/v1") ‖ LP(tenant_id) ‖ LP(design_id)
///            ‖ u32(chain_key_epoch), 32)
/// ```
///
/// **Per design, which is what makes grafting fail** (§6's B5 fix): a genuine
/// run of entries lifted from one design into another does not verify under
/// the second design's chain key.
pub fn chain_key(chain_master: &Key32, tenant: &str, design: &str, epoch: i32) -> Key32 {
    let mut info = Vec::new();
    crypto::lp(&mut info, CHAIN_KEY_LABEL);
    crypto::lp(&mut info, tenant.as_bytes());
    crypto::lp(&mut info, design.as_bytes());
    crypto::u32_le(&mut info, epoch as u32);
    crypto::hkdf_expand(chain_master, &info)
}

/// `K_seal` and `K_content` for one chain key epoch.
pub struct Subkeys {
    pub seal: Key32,
    pub content: Key32,
}

impl Subkeys {
    pub fn derive(chain_key: &Key32) -> Self {
        Self {
            seal: crypto::hkdf_expand(chain_key, KDF_SEAL_LABEL),
            content: crypto::hkdf_expand(chain_key, KDF_CONTENT_LABEL),
        }
    }
}

// ---------------------------------------------------------------------------
// The bindings
// ---------------------------------------------------------------------------

/// Everything the **plaintext** binding covers. Rotation-invariant by
/// construction: nothing here is a storage fact, so re-encrypting a version
/// under a new key leaves this value unchanged.
pub struct PlaintextFacts<'a> {
    pub tenant: &'a str,
    pub design: &'a str,
    pub design_version: i64,
    pub payload_schema_version: i32,
    pub payload: &'a [u8],
}

/// Everything the **storage** binding covers: the actual bytes on disk, so a
/// swapped blob is caught without decrypting anything.
pub struct StorageFacts<'a> {
    pub key_id: KeyId,
    pub key_epoch: i32,
    pub wrap_version: i32,
    pub aead_alg_id: i16,
    pub nonce: &'a [u8],
    pub ciphertext: &'a [u8],
}

/// `plaintext_binding`, §11.2.
pub fn plaintext_binding(content_key: &Key32, facts: &PlaintextFacts<'_>) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64 + facts.payload.len());
    crypto::lp(&mut msg, TAG_PLAINTEXT);
    crypto::lp(&mut msg, facts.tenant.as_bytes());
    crypto::lp(&mut msg, facts.design.as_bytes());
    // The database column is `bigint`/`int` (signed, and non-negative by a
    // CHECK constraint); §11.2 writes u64/u32. The cast is bit-preserving and
    // the value is in range, so the two spellings are the same bytes.
    crypto::u64_le(&mut msg, facts.design_version as u64);
    crypto::u32_le(&mut msg, facts.payload_schema_version as u32);
    crypto::lp(&mut msg, facts.payload);
    crypto::mac(content_key.expose(), &msg)
}

/// `storage_binding`, §11.2.
pub fn storage_binding(content_key: &Key32, facts: &StorageFacts<'_>) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64 + facts.ciphertext.len());
    crypto::lp(&mut msg, TAG_STORAGE);
    crypto::lp(&mut msg, facts.key_id.as_bytes());
    crypto::u32_le(&mut msg, facts.key_epoch as u32);
    crypto::u32_le(&mut msg, facts.wrap_version as u32);
    crypto::u16_le(&mut msg, facts.aead_alg_id as u16);
    crypto::lp(&mut msg, facts.nonce);
    crypto::lp(&mut msg, facts.ciphertext);
    crypto::mac(content_key.expose(), &msg)
}

/// `content_hash`, §11.2 — **keyed**, because an unkeyed hash of plaintext is
/// a confirmation oracle against a stolen dump.
pub fn content_hash(content_key: &Key32, plaintext: &[u8; 32], storage: &[u8; 32]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(96);
    crypto::lp(&mut msg, TAG_CONTENT);
    crypto::lp(&mut msg, plaintext);
    crypto::lp(&mut msg, storage);
    crypto::mac(content_key.expose(), &msg)
}

/// The value that stands in for `seal_0`.
///
/// **§11.2 writes this as `LP(H("fathom/chain/genesis/v1" ‖ tenant_id ‖
/// design_id))` and this implementation differs from that line in two
/// deliberate ways, both reported back rather than quietly taken.**
///
/// 1. The `LP(...)` is read as *how the value enters the MAC*, not as part of
///    the value. Every `seal_{n-1}` enters the seal input through `LP(...)`
///    already, so treating the outer prefix as part of the stored value would
///    length-prefix the genesis value twice and nothing else once.
/// 2. The inner concatenation is **length-prefixed**, where §11.2 writes it
///    bare. Bare, tenant `ab` + design `c` and tenant `a` + design `bc` give
///    the same genesis — the exact splice the same section closes one line
///    above and §12.2 closes again for the chain-key derivation. It is
///    harmless in practice, because the chain key is already per design, but
///    an unprefixed concatenation sitting next to a rule that says
///    "length-prefix every variable-length field" is what gets copied.
pub fn genesis(tenant: &str, design: &str) -> [u8; 32] {
    let mut msg = Vec::new();
    crypto::lp(&mut msg, TAG_GENESIS);
    crypto::lp(&mut msg, tenant.as_bytes());
    crypto::lp(&mut msg, design.as_bytes());
    Sha256::digest(&msg).into()
}

/// Everything a seal covers.
pub struct SealFacts<'a> {
    pub chain_key_epoch: i32,
    pub seq: i64,
    pub tenant: &'a str,
    pub design: &'a str,
    pub prev_seal: &'a [u8],
    pub content_hash: &'a [u8],
    pub entry_type: EntryType,
    /// `fathom-canon`'s canonical bytes. One spelling per value, sorted keys,
    /// no insignificant whitespace — so two verifiers cannot disagree about
    /// what was sealed.
    pub metadata: &'a [u8],
}

/// `seal_n`, §11.2.
pub fn seal(seal_key: &Key32, facts: &SealFacts<'_>) -> [u8; 32] {
    crypto::mac(seal_key.expose(), &seal_message(facts))
}

/// Verify a seal through `digest`'s own constant-time path — never `==` on
/// two byte slices.
pub fn seal_verifies(seal_key: &Key32, facts: &SealFacts<'_>, tag: &[u8]) -> bool {
    crypto::mac_verify(seal_key.expose(), &seal_message(facts), tag)
}

fn seal_message(facts: &SealFacts<'_>) -> Vec<u8> {
    let mut msg = Vec::with_capacity(160 + facts.metadata.len());
    crypto::lp(&mut msg, TAG_SEAL);
    crypto::u32_le(&mut msg, facts.chain_key_epoch as u32);
    crypto::u64_le(&mut msg, facts.seq as u64);
    crypto::lp(&mut msg, facts.tenant.as_bytes());
    crypto::lp(&mut msg, facts.design.as_bytes());
    crypto::lp(&mut msg, facts.prev_seal);
    crypto::lp(&mut msg, facts.content_hash);
    crypto::lp(&mut msg, facts.entry_type.as_str().as_bytes());
    crypto::lp(&mut msg, facts.metadata);
    msg
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/// One entry as it was stored, handed to the verifier.
#[derive(Clone, Debug)]
pub struct StoredEntry {
    pub seq: i64,
    pub entry_type: EntryType,
    pub chain_key_epoch: i32,
    pub design_version: i64,
    pub prev_seal: Vec<u8>,
    pub plaintext_binding: Vec<u8>,
    pub storage_binding: Vec<u8>,
    pub content_hash: Vec<u8>,
    pub seal: Vec<u8>,
    pub metadata: Vec<u8>,
}

/// The stored bytes of one payload version, as a verifier sees them — no
/// decryption needed to check a storage binding.
#[derive(Clone, Debug)]
pub struct StoredPayload {
    pub design_version: i64,
    pub key_id: KeyId,
    pub key_epoch: i32,
    pub wrap_version: i32,
    pub aead_alg_id: i16,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub payload_schema_version: i32,
}

/// How much was actually checked. **Named in every report**, because §11.2
/// requires both levels to say which they ran.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Depth {
    /// Links, sequence and storage bindings. No decryption. The routine
    /// check, runnable by an operator holding only the chain key.
    Links,
    /// The above, plus: decrypt every version and recompute its plaintext
    /// binding.
    Deep,
}

/// Whether the content was re-bound to its plaintext — §11.2's fourth
/// sub-state, and the reason [`Depth`] is in every report.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ContentState {
    /// Every version was decrypted and its plaintext binding recomputed.
    Rebound,
    /// **Links verified, content not re-bound.** The design key was
    /// unavailable, or deep verification was not asked for. This is not a
    /// failure and it is not a pass either.
    NotRebound,
}

/// Which of the four things failed first (§11.2), plus the three this
/// implementation adds because a verifier that cannot say them would have to
/// stay silent about a real tamper.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BreakReason {
    /// The seal does not recompute from what the entry says it covers.
    SealDoesNotRecompute,
    /// The sequence skips or repeats.
    SequenceSkippedOrRepeated,
    /// `prev_seal` does not match entry N−1's seal.
    PrevSealMismatch,
    /// The stored blob's storage binding does not match, and no `reencrypt`
    /// entry accounts for it.
    StorageBindingMismatchUnexplained,
    /// The entry's own `content_hash` is not the keyed combination of its two
    /// bindings.
    ContentHashMismatch,
    /// Deep verification: the payload decrypted, and its plaintext binding is
    /// not the one sealed.
    PlaintextBindingMismatch,
    /// The entry names a payload version that is not in the database.
    PayloadMissing,
    /// **A stored payload version that no entry in the history names.** The
    /// other direction of [`Self::PayloadMissing`], and it has to be checked
    /// separately: walking entries can only ever find a row an entry points
    /// at. An inserted payload row is invisible to that walk, verifies as
    /// nothing, and — carrying the highest `design_version` — is what a read
    /// of "the latest version" then refuses on.
    PayloadNotNamedByAnyEntry,
    /// **The entry names a chain key epoch this deployment has never
    /// written.** Not a coverage gap: there is no retired key to go and find,
    /// because no such epoch was ever minted. Someone changed the column.
    ChainKeyEpochNeverWritten,
}

impl BreakReason {
    fn describe(self) -> &'static str {
        match self {
            Self::SealDoesNotRecompute => "the seal does not recompute",
            Self::SequenceSkippedOrRepeated => "the sequence number skips or repeats",
            Self::PrevSealMismatch => "prev_seal does not match the previous entry's seal",
            Self::StorageBindingMismatchUnexplained => {
                "the stored bytes do not match the sealed storage binding, and no reencrypt \
                 entry accounts for it"
            }
            Self::ContentHashMismatch => {
                "content_hash is not the keyed combination of the two bindings it claims"
            }
            Self::PlaintextBindingMismatch => {
                "the decrypted payload does not match the sealed plaintext binding"
            }
            Self::PayloadMissing => "the entry names a payload version that is not stored",
            Self::PayloadNotNamedByAnyEntry => {
                "a stored payload version is named by no entry in the history"
            }
            Self::ChainKeyEpochNeverWritten => {
                "the entry names a chain key epoch this deployment has never written, so there \
                 is no retired key to find -- the column was changed"
            }
        }
    }
}

/// §11.2's three outcomes, and no fourth: a verifier that can say anything
/// else can say something nobody has to act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Every seal recomputes, `seq` is contiguous, every entry's storage
    /// binding matches the payload it names directly or via a `reencrypt`
    /// chain, and no stored payload is unaccounted for.
    Verified { entries: usize },
    /// N is the **first** index where one of the checks fails. Everything
    /// before N that was actually verified is reported as such.
    BrokenAt {
        /// The failing entry's `seq`, or `0` when the break is not at an entry
        /// at all — a stored payload no entry names has no `seq` to report,
        /// and inventing one would send an operator to an entry that verifies.
        seq: i64,
        reason: BreakReason,
        /// **Counted by verification, never by a position in a list.** An
        /// entry that could not be checked — no key for its epoch — does not
        /// count towards this, so the number never claims more than was done.
        verified_before: usize,
        /// The failing entry's own metadata, so a reader has something to act
        /// on rather than an index. Empty when the break is not at an entry.
        metadata: Vec<u8>,
        /// The design version involved, when there is one.
        design_version: Option<i64>,
    },
    /// **A coverage gap, not a failure.** Some entries name a chain key epoch
    /// this verifier was not given — **and everything that could be checked
    /// was checked first, and nothing was broken.** This outcome can only be
    /// reached after a full pass.
    CannotVerifyUnderKeyEpoch {
        epochs: Vec<i32>,
        ranges: Vec<(i64, i64)>,
        verified_before: usize,
    },
}

/// The entries a run could not check, reported **alongside** an outcome rather
/// than instead of one.
///
/// §12.6a: *"verify everything verifiable first and report every break found;
/// a coverage gap is an additional fact reported alongside, never an early
/// return."* Before that rule, one `UPDATE` of any entry's `chain_key_epoch`
/// turned a detected forgery into a coverage gap and sent the operator to look
/// for a retired key that does not exist.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coverage {
    /// The epochs no key was given for.
    pub epochs: Vec<i32>,
    /// The contiguous `seq` ranges those entries occupy.
    pub ranges: Vec<(i64, i64)>,
    /// How many entries went unchecked.
    pub entries: usize,
}

/// What a verification run says. **The depth and the content state travel with
/// the outcome and cannot be dropped by a caller formatting it**, which is the
/// mechanical half of *"content not checked must never render the same as
/// content verified"*.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub outcome: Outcome,
    pub depth: Depth,
    pub content: ContentState,
    /// `Some` when some entries could not be checked at all. **Present
    /// whatever the outcome is**, including beside a break: "I could not check
    /// these" and "this one is broken" are both true at once and the second
    /// must not be swallowed by the first.
    pub coverage: Option<Coverage>,
}

impl Report {
    /// One line an operator can act on. Never says "verified" without saying
    /// in the same breath what was and was not checked.
    pub fn summary(&self) -> String {
        let mut out = match &self.outcome {
            Outcome::Verified { entries } => match (self.depth, self.content) {
                (Depth::Deep, ContentState::Rebound) => format!(
                    "verified: {entries} entries, links and content \
                     (every version decrypted and re-bound to its plaintext)"
                ),
                _ => format!(
                    "verified: {entries} entries, LINKS AND STORED BYTES ONLY -- \
                     CONTENT NOT RE-BOUND. Nothing was decrypted, so this run says the history \
                     is intact, not that the designs are what they were."
                ),
            },
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                design_version,
                ..
            } => {
                let version = match design_version {
                    Some(v) => format!(" (design version {v})"),
                    None => String::new(),
                };
                if *seq == 0 {
                    format!(
                        "BROKEN: {}{version}. {verified_before} entries verify, and the stored \
                         data does not match what they say is there.",
                        reason.describe()
                    )
                } else {
                    format!(
                        "BROKEN AT ENTRY {seq}: {}{version}. The {verified_before} entries \
                         before it verify.",
                        reason.describe()
                    )
                }
            }
            Outcome::CannotVerifyUnderKeyEpoch {
                epochs,
                ranges,
                verified_before,
            } => {
                let epochs: Vec<String> = epochs.iter().map(i32::to_string).collect();
                let ranges: Vec<String> = ranges.iter().map(|(a, b)| format!("{a}-{b}")).collect();
                format!(
                    "cannot verify under chain key epoch(s) {}: entries {} are not covered by \
                     the key this run was given. That is a coverage gap and not a failure -- \
                     everything else was checked FIRST and {verified_before} entries verify. \
                     Retired chain keys are kept forever; find the one for that epoch.",
                    epochs.join(", "),
                    ranges.join(", ")
                )
            }
        };

        // The additional fact, never the headline. Suppressed for the gap
        // outcome, which is already this sentence said in full.
        if let (Some(coverage), false) = (
            self.coverage.as_ref(),
            matches!(self.outcome, Outcome::CannotVerifyUnderKeyEpoch { .. }),
        ) {
            let epochs: Vec<String> = coverage.epochs.iter().map(i32::to_string).collect();
            out.push_str(&format!(
                " Separately, {} entr{} could not be checked at all: chain key epoch(s) {} were \
                 not given to this run. That is a coverage gap and is not what is reported above.",
                coverage.entries,
                if coverage.entries == 1 { "y" } else { "ies" },
                epochs.join(", ")
            ));
        }
        out
    }
}

impl fmt::Display for Report {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.summary())
    }
}

/// What the verifier is given: the chain keys it holds, by epoch.
pub struct AvailableKeys {
    /// `(epoch, subkeys)`, every epoch this run can check.
    pub by_epoch: Vec<(i32, Subkeys)>,
    /// The highest chain key epoch this deployment has ever written, when the
    /// caller knows it.
    ///
    /// **An epoch above it is an anomaly, not a coverage gap** (§12.6a): no
    /// such key was ever minted, so there is nothing to go and find. A caller
    /// that genuinely does not know — an offline verifier handed an exported
    /// chain — passes `None` and gets the coverage reading.
    pub written_through: Option<i32>,
}

impl AvailableKeys {
    /// Keys with no claim about what this deployment ever wrote.
    pub fn new(by_epoch: Vec<(i32, Subkeys)>) -> Self {
        Self {
            by_epoch,
            written_through: None,
        }
    }

    /// The same, from a caller that knows the highest epoch ever written here.
    pub fn written_through(mut self, epoch: i32) -> Self {
        self.written_through = Some(epoch);
        self
    }

    fn get(&self, epoch: i32) -> Option<&Subkeys> {
        self.by_epoch
            .iter()
            .find(|(e, _)| *e == epoch)
            .map(|(_, k)| k)
    }
}

/// Verify a design's chain.
///
/// `entries` must be every entry for the design, in `seq` order. `payloads`
/// is every stored version. `plaintexts` is `Some` only for a deep run, and
/// carries the decrypted bytes by version — this module never decrypts
/// anything itself, because it holds no data key and should not.
///
/// # The order, which is the control
///
/// Everything checkable is checked **first**, in one pass, in `seq` order, and
/// the first break found is the one reported. `seq` and `prev_seal` need no
/// key at all, so they are checked even for an entry whose epoch this run
/// cannot open. A coverage gap is collected as it is met and reported
/// alongside; it never returns early and it never contributes to
/// `verified_before`.
pub fn verify(
    tenant: &str,
    design: &str,
    entries: &[StoredEntry],
    payloads: &[StoredPayload],
    keys: &AvailableKeys,
    plaintexts: Option<&[(i64, Vec<u8>)]>,
) -> Report {
    let depth = if plaintexts.is_some() {
        Depth::Deep
    } else {
        Depth::Links
    };
    let mut content = if plaintexts.is_some() {
        ContentState::Rebound
    } else {
        ContentState::NotRebound
    };

    // **The coverage gap is collected before the pass and reported with
    // whatever the pass finds** -- never instead of it (§12.6a). Working it
    // out first costs one key lookup per entry and means a break found at
    // entry 1 still carries the fact that entry 3 could not be checked;
    // collecting it as the pass went would lose that, because the pass stops
    // at the break.
    //
    // An epoch above what this deployment ever wrote is deliberately NOT
    // counted here: there is no retired key to find, so it is an anomaly and
    // the pass reports it as a break.
    let uncovered: Vec<(i32, i64)> = entries
        .iter()
        .filter(|e| {
            keys.get(e.chain_key_epoch).is_none()
                && keys
                    .written_through
                    .is_none_or(|highest| e.chain_key_epoch <= highest)
        })
        .map(|e| (e.chain_key_epoch, e.seq))
        .collect();
    let coverage = coverage_of(&uncovered);

    // Counted by verification and by nothing else.
    let mut verified: usize = 0;

    let mut prev_seal = genesis(tenant, design).to_vec();
    let mut expected_seq: i64 = 1;

    for entry in entries {
        let broke = |reason: BreakReason| Report {
            outcome: Outcome::BrokenAt {
                seq: entry.seq,
                reason,
                verified_before: verified,
                metadata: entry.metadata.clone(),
                design_version: Some(entry.design_version),
            },
            depth,
            content,
            coverage: coverage.clone(),
        };

        // ---- What needs no key -------------------------------------------
        if entry.seq != expected_seq {
            return broke(BreakReason::SequenceSkippedOrRepeated);
        }
        if entry.prev_seal != prev_seal {
            return broke(BreakReason::PrevSealMismatch);
        }
        let sealed_over = prev_seal.clone();
        prev_seal = entry.seal.clone();
        expected_seq += 1;

        // An epoch beyond anything this deployment ever wrote is a changed
        // column, not a key somebody else holds -- checked before the key
        // lookup so that it reads as the anomaly it is even when a key for
        // that epoch happens to be derivable.
        if keys
            .written_through
            .is_some_and(|highest| entry.chain_key_epoch > highest)
        {
            return broke(BreakReason::ChainKeyEpochNeverWritten);
        }

        // ---- What needs the key for this entry's epoch --------------------
        let Some(subkeys) = keys.get(entry.chain_key_epoch) else {
            // Not verified, and so not counted. The links either side of it
            // were checked above; nothing sealed under a key this run does not
            // hold is claimed to be anything.
            continue;
        };

        // The entry's own two bindings must combine to the content_hash it
        // carries — otherwise a seal could cover a content_hash that is not
        // the bindings beside it, and the storage check below would be
        // checking something the seal never committed to.
        let recomputed = content_hash(
            &subkeys.content,
            &to32(&entry.plaintext_binding),
            &to32(&entry.storage_binding),
        );
        if recomputed.as_slice() != entry.content_hash.as_slice() {
            return broke(BreakReason::ContentHashMismatch);
        }

        let facts = SealFacts {
            chain_key_epoch: entry.chain_key_epoch,
            seq: entry.seq,
            tenant,
            design,
            prev_seal: &sealed_over,
            content_hash: &entry.content_hash,
            entry_type: entry.entry_type,
            metadata: &entry.metadata,
        };
        if !seal_verifies(&subkeys.seal, &facts, &entry.seal) {
            return broke(BreakReason::SealDoesNotRecompute);
        }

        // ---- The stored bytes, ENTRY-DRIVEN (§12.6a) ----------------------
        //
        // For each entry, the payload it names. Driving this from the entries
        // rather than from the payload rows is what closes the gap the seal
        // itself leaves: the seal does not cover `design_version`, so an entry
        // re-pointed at another version is unauthenticated — but the storage
        // binding it carries is over the bytes of the version it was written
        // for, and those are not the bytes of the version it now names.
        // Deleting the entry instead breaks the next entry's `prev_seal`.
        let Some(payload) = payloads
            .iter()
            .find(|p| p.design_version == entry.design_version)
        else {
            return broke(BreakReason::PayloadMissing);
        };
        let stored = storage_binding(
            &subkeys.content,
            &StorageFacts {
                key_id: payload.key_id,
                key_epoch: payload.key_epoch,
                wrap_version: payload.wrap_version,
                aead_alg_id: payload.aead_alg_id,
                nonce: &payload.nonce,
                ciphertext: &payload.ciphertext,
            },
        );
        if stored.as_slice() != entry.storage_binding.as_slice() {
            // §11.2: *"a verifier meeting a storage-binding mismatch looks for
            // a reencrypt entry accounting for it: found, routine; absent,
            // broken."* A later `reencrypt` on this same version is exactly
            // that account -- it supersedes this entry's storage binding, and
            // is itself checked when the pass reaches it.
            let superseded = entries.iter().any(|later| {
                later.seq > entry.seq
                    && later.design_version == entry.design_version
                    && later.entry_type == EntryType::Reencrypt
            });
            if !superseded {
                return broke(BreakReason::StorageBindingMismatchUnexplained);
            }
        }

        // ---- Deep only: the plaintext ------------------------------------
        if let Some(plaintexts) = plaintexts {
            match plaintexts.iter().find(|(v, _)| *v == entry.design_version) {
                Some((_, bytes)) => {
                    let facts = PlaintextFacts {
                        tenant,
                        design,
                        design_version: entry.design_version,
                        payload_schema_version: payload.payload_schema_version,
                        payload: bytes,
                    };
                    if plaintext_binding(&subkeys.content, &facts).as_slice()
                        != entry.plaintext_binding.as_slice()
                    {
                        return broke(BreakReason::PlaintextBindingMismatch);
                    }
                }
                None => {
                    // Asked for a deep run and one version could not be
                    // decrypted: the links still verified, and saying
                    // "verified" here would be the exact conflation §11.2
                    // forbids.
                    content = ContentState::NotRebound;
                }
            }
        }

        verified += 1;
    }

    // The other direction, and it cannot be folded into the loop above: an
    // inserted payload row is named by no entry, so no entry-driven walk can
    // reach it. It is a break and not a skip -- being the highest
    // `design_version`, it is what a read of "the latest version" lands on.
    for payload in payloads {
        if !entries
            .iter()
            .any(|e| e.design_version == payload.design_version)
        {
            return Report {
                outcome: Outcome::BrokenAt {
                    seq: 0,
                    reason: BreakReason::PayloadNotNamedByAnyEntry,
                    verified_before: verified,
                    metadata: Vec::new(),
                    design_version: Some(payload.design_version),
                },
                depth,
                content,
                coverage,
            };
        }
    }

    let outcome = match &coverage {
        Some(c) => Outcome::CannotVerifyUnderKeyEpoch {
            epochs: c.epochs.clone(),
            ranges: c.ranges.clone(),
            verified_before: verified,
        },
        None => Outcome::Verified { entries: verified },
    };

    Report {
        outcome,
        depth,
        content,
        coverage,
    }
}

/// The uncovered entries, folded into the epochs they name and the contiguous
/// `seq` ranges they occupy.
fn coverage_of(uncovered: &[(i32, i64)]) -> Option<Coverage> {
    if uncovered.is_empty() {
        return None;
    }
    let mut epochs: Vec<i32> = Vec::new();
    for (epoch, _) in uncovered {
        if !epochs.contains(epoch) {
            epochs.push(*epoch);
        }
    }
    let mut ranges: Vec<(i64, i64)> = Vec::new();
    let mut run: Option<(i64, i64)> = None;
    for (_, seq) in uncovered {
        match run {
            Some((start, last)) if *seq == last + 1 => run = Some((start, *seq)),
            Some(r) => {
                ranges.push(r);
                run = Some((*seq, *seq));
            }
            None => run = Some((*seq, *seq)),
        }
    }
    if let Some(r) = run {
        ranges.push(r);
    }
    Some(Coverage {
        epochs,
        ranges,
        entries: uncovered.len(),
    })
}

/// A stored 32-byte binding. A column shorter than 32 cannot occur — the
/// migration `CHECK`s it — and a value that somehow is shorter must not
/// silently compare equal to a prefix, so it is zero-padded into a fixed
/// array and will simply fail to match.
fn to32(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let n = bytes.len().min(32);
    out[..n].copy_from_slice(&bytes[..n]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys_for(epoch: i32) -> AvailableKeys {
        let master = Key32::from_bytes([9u8; 32]);
        let ck = chain_key(&master, "T", "D", epoch);
        AvailableKeys::new(vec![(epoch, Subkeys::derive(&ck))])
    }

    /// **Different bytes per version, which is what the real table holds.**
    /// A helper that gave every version the same ciphertext would make the
    /// entry-driven storage pass untestable: an entry re-pointed at another
    /// version would match the wrong row's binding by accident.
    fn ciphertext_of(version: i64) -> Vec<u8> {
        format!("ciphertext-of-version-{version}").into_bytes()
    }

    fn entry(seq: i64, version: i64, prev: Vec<u8>, keys: &AvailableKeys) -> StoredEntry {
        let sub = keys.get(1).unwrap();
        let pb = plaintext_binding(
            &sub.content,
            &PlaintextFacts {
                tenant: "T",
                design: "D",
                design_version: version,
                payload_schema_version: 1,
                payload: b"payload",
            },
        );
        let sb = storage_binding(
            &sub.content,
            &StorageFacts {
                key_id: Key32::from_bytes([1u8; 32]).id(),
                key_epoch: 1,
                wrap_version: 1,
                aead_alg_id: 1,
                nonce: &[2u8; 12],
                ciphertext: &ciphertext_of(version),
            },
        );
        let ch = content_hash(&sub.content, &pb, &sb);
        let metadata = b"{}".to_vec();
        let s = seal(
            &sub.seal,
            &SealFacts {
                chain_key_epoch: 1,
                seq,
                tenant: "T",
                design: "D",
                prev_seal: &prev,
                content_hash: &ch,
                entry_type: EntryType::Update,
                metadata: &metadata,
            },
        );
        StoredEntry {
            seq,
            entry_type: EntryType::Update,
            chain_key_epoch: 1,
            design_version: version,
            prev_seal: prev,
            plaintext_binding: pb.to_vec(),
            storage_binding: sb.to_vec(),
            content_hash: ch.to_vec(),
            seal: s.to_vec(),
            metadata,
        }
    }

    fn payload(version: i64) -> StoredPayload {
        StoredPayload {
            design_version: version,
            key_id: Key32::from_bytes([1u8; 32]).id(),
            key_epoch: 1,
            wrap_version: 1,
            aead_alg_id: 1,
            nonce: vec![2u8; 12],
            ciphertext: ciphertext_of(version),
            payload_schema_version: 1,
        }
    }

    fn three() -> (AvailableKeys, Vec<StoredEntry>, Vec<StoredPayload>) {
        let keys = keys_for(1);
        let mut entries = Vec::new();
        let mut prev = genesis("T", "D").to_vec();
        for seq in 1..=3i64 {
            let e = entry(seq, seq, prev.clone(), &keys);
            prev = e.seal.clone();
            entries.push(e);
        }
        let payloads = (1..=3).map(payload).collect();
        (keys, entries, payloads)
    }

    #[test]
    fn an_untouched_chain_verifies_and_says_what_it_did_not_check() {
        let (keys, entries, payloads) = three();
        let report = verify("T", "D", &entries, &payloads, &keys, None);
        assert_eq!(report.outcome, Outcome::Verified { entries: 3 });
        assert_eq!(report.content, ContentState::NotRebound);
        // The whole point of the fourth sub-state: this must not read like a
        // content check.
        let summary = report.summary();
        assert!(summary.contains("CONTENT NOT RE-BOUND"), "{summary}");
        assert!(!summary.contains("content verified"), "{summary}");
    }

    #[test]
    fn a_deep_run_says_so_and_reads_differently() {
        let (keys, entries, payloads) = three();
        let plaintexts: Vec<(i64, Vec<u8>)> = (1..=3).map(|v| (v, b"payload".to_vec())).collect();
        let report = verify("T", "D", &entries, &payloads, &keys, Some(&plaintexts));
        assert_eq!(report.depth, Depth::Deep);
        assert_eq!(report.content, ContentState::Rebound);
        assert!(report.summary().contains("links and content"), "{report}");
    }

    #[test]
    fn tampering_with_the_middle_entry_breaks_at_it_and_not_before_it() {
        let (keys, mut entries, payloads) = three();
        // Rewrite what the second entry says happened. Its seal no longer
        // recomputes; the first entry is untouched and must still verify.
        entries[1].metadata = br#"{"who":"someone else"}"#.to_vec();
        let report = verify("T", "D", &entries, &payloads, &keys, None);
        match report.outcome {
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                ..
            } => {
                assert_eq!(seq, 2);
                assert_eq!(reason, BreakReason::SealDoesNotRecompute);
                assert_eq!(verified_before, 1);
            }
            other => panic!("{other:?}"),
        }
        assert!(report.summary().contains("BROKEN AT ENTRY 2"), "{report}");
    }

    #[test]
    fn a_removed_middle_entry_breaks_the_links() {
        let (keys, mut entries, payloads) = three();
        entries.remove(1);
        match verify("T", "D", &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(seq, 3);
                assert_eq!(reason, BreakReason::SequenceSkippedOrRepeated);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_swapped_blob_is_caught_without_decrypting_anything() {
        let (keys, entries, mut payloads) = three();
        payloads[2].ciphertext = b"someone else's bytes".to_vec();
        match verify("T", "D", &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(seq, 3);
                assert_eq!(reason, BreakReason::StorageBindingMismatchUnexplained);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_missing_chain_key_epoch_is_a_coverage_gap_and_not_a_failure() {
        let (keys, mut entries, payloads) = three();
        entries[2].chain_key_epoch = 2;
        let report = verify("T", "D", &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::CannotVerifyUnderKeyEpoch {
                epochs,
                ranges,
                verified_before,
            } => {
                assert_eq!(epochs, &[2]);
                assert_eq!(ranges, &[(3, 3)]);
                assert_eq!(*verified_before, 2);
            }
            other => panic!("{other:?}"),
        }
        let summary = report.summary();
        assert!(summary.contains("coverage gap"), "{summary}");
        assert!(!summary.contains("BROKEN"), "{summary}");
    }

    #[test]
    fn a_chain_does_not_verify_under_another_designs_key() {
        // §6's B5 fix: per-design chain keys are what make grafting fail.
        let (keys, entries, payloads) = three();
        let master = Key32::from_bytes([9u8; 32]);
        let other = AvailableKeys::new(vec![(
            1,
            Subkeys::derive(&chain_key(&master, "T", "OTHER", 1)),
        )]);
        assert!(matches!(
            verify("T", "OTHER", &entries, &payloads, &other, None).outcome,
            Outcome::BrokenAt { seq: 1, .. }
        ));
        // ...and the same entries under the same key but a different tenant
        // do not verify either.
        assert!(matches!(
            verify("OTHER", "D", &entries, &payloads, &keys, None).outcome,
            Outcome::BrokenAt { seq: 1, .. }
        ));
    }

    #[test]
    fn the_chain_key_derivation_cannot_be_spliced() {
        // §12.2: without length prefixes, tenant `ab` + design `c` and tenant
        // `a` + design `bc` derive the same key.
        let master = Key32::from_bytes([1u8; 32]);
        assert_ne!(
            chain_key(&master, "ab", "c", 1).expose(),
            chain_key(&master, "a", "bc", 1).expose()
        );
        assert_ne!(
            chain_key(&master, "a", "b", 1).expose(),
            chain_key(&master, "a", "b", 2).expose()
        );
        // ...and the same for genesis, which this module length-prefixes
        // where §11.2 wrote a bare concatenation. See `genesis`.
        assert_ne!(genesis("ab", "c"), genesis("a", "bc"));
    }

    // -----------------------------------------------------------------------
    // §12.6a: a coverage gap is a fact reported alongside, never a switch
    // -----------------------------------------------------------------------

    #[test]
    fn one_update_of_an_epoch_column_cannot_silence_a_forgery() {
        // Reproduced against bb04ccb: forge entry 1, then set UNRELATED entry
        // 3's `chain_key_epoch` to an epoch this run holds no key for, and the
        // whole report became "a coverage gap, not a failure -- the 2 entries
        // before it verify", over entries nothing had examined. The forgery
        // was never named.
        let (keys, mut entries, payloads) = three();
        entries[0].metadata = br#"{"who":"someone else"}"#.to_vec();
        entries[2].chain_key_epoch = 2;

        let report = verify("T", "D", &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                ..
            } => {
                assert_eq!(*seq, 1);
                assert_eq!(*reason, BreakReason::SealDoesNotRecompute);
                assert_eq!(*verified_before, 0);
            }
            other => panic!("the forgery must be reported, got {other:?}"),
        }
        let summary = report.summary();
        assert!(summary.starts_with("BROKEN AT ENTRY 1"), "{summary}");
        // The gap is still stated -- as an additional fact, not the headline.
        assert!(summary.contains("coverage gap"), "{summary}");
        assert_eq!(report.coverage.as_ref().map(|c| c.entries), Some(1));
    }

    #[test]
    fn verified_before_counts_only_entries_that_were_actually_verified() {
        // Entry 2 cannot be checked at all; entry 3 is forged. One entry
        // verified, and the number must say one -- not "the two before it",
        // which is what a `position()` in a list would have said.
        let (keys, mut entries, payloads) = three();
        entries[1].chain_key_epoch = 2;
        entries[2].metadata = br#"{"who":"someone else"}"#.to_vec();

        match verify("T", "D", &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt {
                seq,
                verified_before,
                ..
            } => {
                assert_eq!(seq, 3);
                assert_eq!(verified_before, 1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_epoch_on_every_entry_claims_nothing_verified() {
        let (keys, mut entries, payloads) = three();
        for e in &mut entries {
            e.chain_key_epoch = 2;
        }
        let report = verify("T", "D", &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::CannotVerifyUnderKeyEpoch {
                verified_before, ..
            } => assert_eq!(*verified_before, 0),
            other => panic!("{other:?}"),
        }
        let summary = report.summary();
        assert!(summary.contains("0 entries verify"), "{summary}");
    }

    #[test]
    fn an_epoch_this_deployment_never_wrote_is_an_anomaly_and_not_a_gap() {
        // The verifier holds the key for epoch 2 -- a chain master derives any
        // epoch -- and knows this deployment has only ever written epoch 1. So
        // there is no retired key to go and find; the column was changed.
        let (keys, mut entries, payloads) = three();
        entries[2].chain_key_epoch = 2;
        let master = Key32::from_bytes([9u8; 32]);
        let mut both = keys.by_epoch;
        both.push((2, Subkeys::derive(&chain_key(&master, "T", "D", 2))));
        let keys = AvailableKeys::new(both).written_through(1);

        let report = verify("T", "D", &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(*seq, 3);
                assert_eq!(*reason, BreakReason::ChainKeyEpochNeverWritten);
            }
            other => panic!("{other:?}"),
        }
        assert!(!report.summary().contains("coverage gap"), "{report}");
    }

    // -----------------------------------------------------------------------
    // §12.6a: the storage pass is entry-driven, and it runs per entry
    // -----------------------------------------------------------------------

    #[test]
    fn an_entry_repointed_at_another_version_is_caught_with_the_seal_unchanged() {
        // The seal does not cover `design_version`, so this edit leaves every
        // seal recomputing. Against bb04ccb it returned `Verified` -- a
        // version destroyed and the history endorsing it. The entry-driven
        // storage pass catches it because entry 2's storage binding is over
        // version 2's bytes and those are not version 3's.
        let (keys, mut entries, mut payloads) = three();
        payloads.retain(|p| p.design_version != 2);
        entries[1].design_version = 3;

        match verify("T", "D", &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(seq, 2);
                assert_eq!(reason, BreakReason::StorageBindingMismatchUnexplained);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_first_break_is_the_first_break_and_not_the_first_link_break() {
        // A storage break at entry 1 and a link break at entry 3. Checking all
        // the links first and the stored bytes afterwards -- which is what
        // bb04ccb did -- reports entry 3 and claims two entries verified.
        let (keys, mut entries, mut payloads) = three();
        payloads[0].ciphertext = b"someone else's bytes".to_vec();
        entries[2].metadata = br#"{"who":"someone else"}"#.to_vec();

        match verify("T", "D", &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                ..
            } => {
                assert_eq!(seq, 1);
                assert_eq!(reason, BreakReason::StorageBindingMismatchUnexplained);
                assert_eq!(verified_before, 0);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_payload_row_no_entry_names_is_a_break_and_not_a_skip() {
        let (keys, entries, mut payloads) = three();
        payloads.push(payload(9));

        let report = verify("T", "D", &entries, &payloads, &keys, None);
        match &report.outcome {
            Outcome::BrokenAt {
                seq,
                reason,
                verified_before,
                design_version,
                ..
            } => {
                assert_eq!(*seq, 0, "there is no entry to blame, and none is invented");
                assert_eq!(*reason, BreakReason::PayloadNotNamedByAnyEntry);
                assert_eq!(*verified_before, 3);
                assert_eq!(*design_version, Some(9));
            }
            other => panic!("{other:?}"),
        }
        let summary = report.summary();
        assert!(summary.starts_with("BROKEN"), "{summary}");
        assert!(summary.contains("design version 9"), "{summary}");
    }

    #[test]
    fn a_design_whose_whole_chain_was_deleted_does_not_report_verified() {
        // The ciphertext is still there; every entry is gone. "verified: 0
        // entries" was the old answer.
        let (keys, _entries, payloads) = three();
        let report = verify("T", "D", &[], &payloads, &keys, None);
        assert!(
            matches!(
                report.outcome,
                Outcome::BrokenAt {
                    reason: BreakReason::PayloadNotNamedByAnyEntry,
                    ..
                }
            ),
            "{report}"
        );
    }

    #[test]
    fn an_entry_naming_a_version_that_is_not_stored_is_still_a_break() {
        let (keys, entries, mut payloads) = three();
        payloads.retain(|p| p.design_version != 3);
        match verify("T", "D", &entries, &payloads, &keys, None).outcome {
            Outcome::BrokenAt { seq, reason, .. } => {
                assert_eq!(seq, 3);
                assert_eq!(reason, BreakReason::PayloadMissing);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_reencrypt_entry_still_accounts_for_the_bytes_it_changed() {
        // The routine case, kept here because the entry-driven pass is what
        // now decides it: entry 1's storage binding no longer matches the
        // stored bytes, and the later `reencrypt` on the same version is the
        // account §11.2 asks a verifier to look for.
        let keys = keys_for(1);
        let sub = keys.get(1).unwrap();
        let mut entries = vec![entry(1, 1, genesis("T", "D").to_vec(), &keys)];

        // The bytes as a rotation would leave them.
        let rotated = b"re-encrypted bytes".to_vec();
        let sb = storage_binding(
            &sub.content,
            &StorageFacts {
                key_id: Key32::from_bytes([1u8; 32]).id(),
                key_epoch: 2,
                wrap_version: 1,
                aead_alg_id: 1,
                nonce: &[3u8; 12],
                ciphertext: &rotated,
            },
        );
        let pb = entries[0].plaintext_binding.clone();
        let ch = content_hash(&sub.content, &to32(&pb), &sb);
        let metadata = br#"{"entry_type":"reencrypt"}"#.to_vec();
        let prev = entries[0].seal.clone();
        let s = seal(
            &sub.seal,
            &SealFacts {
                chain_key_epoch: 1,
                seq: 2,
                tenant: "T",
                design: "D",
                prev_seal: &prev,
                content_hash: &ch,
                entry_type: EntryType::Reencrypt,
                metadata: &metadata,
            },
        );
        entries.push(StoredEntry {
            seq: 2,
            entry_type: EntryType::Reencrypt,
            chain_key_epoch: 1,
            design_version: 1,
            prev_seal: prev,
            plaintext_binding: pb,
            storage_binding: sb.to_vec(),
            content_hash: ch.to_vec(),
            seal: s.to_vec(),
            metadata,
        });

        let payloads = vec![StoredPayload {
            design_version: 1,
            key_id: Key32::from_bytes([1u8; 32]).id(),
            key_epoch: 2,
            wrap_version: 1,
            aead_alg_id: 1,
            nonce: vec![3u8; 12],
            ciphertext: rotated,
            payload_schema_version: 1,
        }];

        let report = verify("T", "D", &entries, &payloads, &keys, None);
        assert_eq!(report.outcome, Outcome::Verified { entries: 2 }, "{report}");
    }
}
