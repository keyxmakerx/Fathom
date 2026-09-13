//! **The signed bytes.** Every message the authority layer signs, seals or
//! fingerprints, and the ES256 signing and verification over them.
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §3.3 (the constructions), §3.4
//! (the row seal, the live digest and the head seal), §6.1 (the organisation
//! id), §15.1 (software keys) and §15.3 (ES256, `p256` + `ecdsa`).
//! `docs/PHASE-2-STORAGE-DESIGN.md` §11.2 owns the length-prefixing rule and
//! §12.2 owns the label table — **that table wins over this file**, and every
//! label introduced here is listed in `LABELS` below so the two can be
//! reconciled in one read.
//!
//! # This module holds no SQL
//!
//! `grants.rs` is the database side. The split is the one `chain.rs` and
//! `chains.rs` already draw and for the same reason: a construction that can
//! only be exercised through a transaction is a construction nobody
//! cross-checks, and `tests/authority_vectors.rs` pins every value below
//! against a second implementation written in plain Python from the design's
//! own text.
//!
//! # The two corrections at the head of §3, and where each one lands
//!
//! **1. `second_bytes` must not bind `H(granter_sig)`.** ECDSA signatures are
//! malleable two ways at once — the `(r, s)` / `(r, −s)` pair, and
//! non-canonical DER encodings of the same values — so one authority can
//! produce several byte-distinct `granter_sig` values over one `grant_bytes`,
//! each yielding a different `second_bytes`. A seconding signature would then
//! be bound to an *encoding* rather than to a fact. [`second_bytes`] binds
//! `LP(H(grant_bytes)) ‖ LP(granter_key_fpr)` and never touches the signature.
//!
//! **2. The malleability itself is closed, not merely routed around.**
//! [`verify_es256`] refuses a signature that is not exactly 64 bytes (so a DER
//! blob is refused by length, and no second encoding of one signature exists)
//! and refuses a high-`s` signature (so only one of the malleable pair is ever
//! accepted). Neither is the crate's default: `NistP256::NORMALIZE_S` is
//! `false`, and `ecdsa 0.17.0`'s `hazmat::verify_prehashed` only rejects a high
//! `s` when that constant is true. Read from the crate's source on 2026-09-12
//! rather than assumed, because it is the kind of default that is easy to
//! believe backwards.
//!
//! # What this module is NOT
//!
//! **There is no WebAuthn here, and no challenge derivation.** §3.3's
//! `grant_challenge` and `second_challenge` exist because a WebAuthn
//! authenticator signs `authData ‖ SHA-256(clientDataJSON)` and needs the
//! message compressed into a challenge first. §15.1 ships v1 on software keys,
//! which sign the message itself, and §15.4's hand-written assertion
//! verification is its own piece of work. Building the challenge functions now
//! would put two unused labels in the table and a construction nothing
//! exercises next to constructions that are load-bearing. They are listed in
//! [`LABELS`] as reserved and nothing writes them.

use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::crypto::{self, Key32};

// ---------------------------------------------------------------------------
// The labels
// ---------------------------------------------------------------------------

/// The algorithm id stored in `account_keys.alg` and `organisation_roots.root_alg`.
///
/// **§3.2 calls both columns "COSE algorithm id" and this build does not fill
/// them with one.** `www.iana.org` is refused by this session's proxy (403,
/// 2026-09-12), so the COSE Algorithms registry could not be read, and
/// CLAUDE.md rule 1 forbids writing a remembered number into a stored column.
/// `1` is Fathom's own id for ES256 and `0011`'s `CHECK` admits nothing else.
/// Whoever lands WebAuthn either establishes the COSE value and migrates the
/// two columns, or keeps a Fathom id and maps at the boundary.
pub const ALG_ES256: i16 = 1;

/// A fixed-size ECDSA signature: `r ‖ s`, 32 bytes each. **Never DER.**
pub const SIGNATURE_LEN: usize = 64;

/// A SEC1 uncompressed P-256 point: `0x04 ‖ X ‖ Y`.
pub const PUBLIC_KEY_LEN: usize = 65;

/// `H("fathom/key/fpr/v1" ‖ LP(public_key))` — §3.2's fingerprint.
const TAG_KEY_FPR: &[u8] = b"fathom/key/fpr/v1";

/// §6.1's organisation id derivation.
const TAG_ORG_ID: &[u8] = b"fathom/org/id/v1";

/// §3.3's four message tags, and two this file adds because §3.3 specifies no
/// bytes for suspension at all (see [`suspend_bytes`]).
const TAG_GRANT: &[u8] = b"fathom/grant/v1";
const TAG_GRANT_SECOND: &[u8] = b"fathom/grant/second/v1";
const TAG_GRANT_REVOKE: &[u8] = b"fathom/grant/revoke/v1";
const TAG_GRANT_SUSPEND: &[u8] = b"fathom/grant/suspend/v1";
const TAG_GRANT_UNSUSPEND: &[u8] = b"fathom/grant/unsuspend/v1";

/// §8.4's key succession: the old key signs the new one, so a rotation carries
/// grants forward without a re-signing campaign. §8.4 states the fact and not
/// the bytes; these are the bytes.
const TAG_KEY_SUCCESSION: &[u8] = b"fathom/key/succession/v1";

/// §3.4's row-seal subkey, and its three in-MAC tags.
const KDF_ROW_LABEL: &[u8] = b"fathom/chain/kdf/row/v1";
const TAG_ROW: &[u8] = b"fathom/row/v1";
const TAG_AUTHHEAD_LIVE: &[u8] = b"fathom/authhead/live/v1";
const TAG_AUTHHEAD_SEAL: &[u8] = b"fathom/authhead/seal/v1";

/// **Every label this module introduces, for `PHASE-2-STORAGE-DESIGN.md`
/// §12.2's table, which owns them.**
///
/// The design's own Disagreements section says it: §12.2 owns the derivation
/// labels and a document that needs one it does not own raises it there rather
/// than shipping a second specification. This constant is the raised list, in
/// a form a test can read — `tests/authority_vectors.rs` asserts that each
/// label appears in exactly the construction named beside it, so a label
/// "tidied" in one place and not the other fails rather than silently changing
/// what a stored signature means.
///
/// The two reserved rows are §3.3's WebAuthn challenge derivations. **Nothing
/// writes them**, exactly as §12.2 already records `fathom/chain/key/read/v1`
/// as reserved and unwritten.
pub const LABELS: &[(&str, &str)] = &[
    (
        "fathom/key/fpr/v1",
        "hash tag of an account key's fingerprint (§3.2)",
    ),
    (
        "fathom/org/id/v1",
        "hash tag of the organisation id derivation (§6.1)",
    ),
    ("fathom/grant/v1", "in-signature tag of grant_bytes (§3.3)"),
    (
        "fathom/grant/second/v1",
        "in-signature tag of second_bytes (§3.3, corrected)",
    ),
    (
        "fathom/grant/revoke/v1",
        "in-signature tag of revoke_bytes (§3.3)",
    ),
    (
        "fathom/grant/suspend/v1",
        "in-signature tag of suspend_bytes (§3 is silent)",
    ),
    (
        "fathom/grant/unsuspend/v1",
        "in-signature tag of unsuspend_bytes (§3 is silent)",
    ),
    (
        "fathom/key/succession/v1",
        "in-signature tag of succession_bytes (§8.4 is silent)",
    ),
    (
        "fathom/chain/kdf/row/v1",
        "HKDF info from an organisation chain key → K_row (§3.4)",
    ),
    (
        "fathom/row/v1",
        "in-MAC tag of an authority row seal (§3.4)",
    ),
    (
        "fathom/authhead/live/v1",
        "in-MAC tag of the live digest (§3.4)",
    ),
    (
        "fathom/authhead/seal/v1",
        "in-MAC tag of the head seal (§3.4)",
    ),
    (
        "fathom/grant/challenge/v1",
        "RESERVED — WebAuthn only (§3.3, §15.4). Nothing writes it",
    ),
    (
        "fathom/grant/second/challenge/v1",
        "RESERVED — WebAuthn only (§3.3, §15.4). Nothing writes it",
    ),
    (
        "fathom/scope/move/v1",
        "RESERVED — §3.6's move_bytes. `repo::move_subtree` is not yet gated on a signature",
    ),
    (
        "fathom/device/reparent/v1",
        "RESERVED — §3.6's reparent_bytes. Nothing reparents devices yet",
    ),
];

// ---------------------------------------------------------------------------
// Fingerprints and identities
// ---------------------------------------------------------------------------

/// A public key's fingerprint — the one name a signed grant uses for a key.
///
/// ```text
/// fpr = H(LP("fathom/key/fpr/v1") ‖ LP(public_key))
/// ```
///
/// **§3.2 writes the tag without a length prefix** (`H("fathom/key/fpr/v1" ||
/// LP(public_key))`). It is prefixed here, because storage §11.2's rule is
/// *"length-prefix every variable-length field"* and `chain.rs` already
/// prefixes the tag in every construction in this product. Two spellings of
/// the same rule inside one codebase is how a seal stops verifying the day
/// someone unifies them; the deviation is reported rather than taken quietly.
pub fn key_fingerprint(public_key: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64 + public_key.len());
    crypto::lp(&mut msg, TAG_KEY_FPR);
    crypto::lp(&mut msg, public_key);
    Sha256::digest(&msg).into()
}

/// §6.1's organisation id, derived from the root public key and a 16-byte salt.
///
/// ```text
/// organisation_id = b32(H(LP("fathom/org/id/v1") ‖ LP(root_pubkey) ‖ LP(id_salt)))
/// ```
///
/// **This is what makes a second genesis unconstructible rather than merely
/// detected** (§6.1): a re-minted genesis under a different root key yields a
/// *different organisation id* and matches no existing row.
///
/// # One deviation from §6.1, and it is forced by this repository's ids
///
/// §6.1 writes `b32(H(...))[0..26]` — the first 26 Crockford characters of the
/// digest. 26 characters carry 130 bits, and every id in this product is a
/// `fathom_id::Ulid`: 128 bits, rendered in 26 characters, whose **first
/// character may not exceed `7`** or the value does not fit. Truncating a
/// base32 rendering of a hash would therefore produce something `Ulid::decode`
/// refuses roughly three times in four, and `organisations.id` is a 26-
/// character column every other table joins on. So the first **128 bits** of
/// the digest are taken and encoded with the same alphabet the rest of the
/// product uses. The property §6.1 needs — the id is a function of the root
/// key and the salt, recomputable at every authorisation — is untouched.
///
/// The ULID field split (48-bit timestamp, 80-bit random) is **meaningless**
/// for a derived id, and that is fine: invariant 7 says ids are opaque. What
/// it means in practice is that a derived organisation id does not sort by
/// creation time. Nothing in this product relies on that for organisations.
pub fn derive_organisation_id(root_pubkey: &[u8], id_salt: &[u8]) -> String {
    let mut msg = Vec::with_capacity(128);
    crypto::lp(&mut msg, TAG_ORG_ID);
    crypto::lp(&mut msg, root_pubkey);
    crypto::lp(&mut msg, id_salt);
    let digest: [u8; 32] = Sha256::digest(&msg).into();
    let mut first16 = [0u8; 16];
    first16.copy_from_slice(&digest[..16]);
    fathom_id::Ulid(u128::from_be_bytes(first16)).encode()
}

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

/// §3.1's three capabilities. `steward` is the only grant-granting power in the
/// product and it lives *inside* the scope.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Capability {
    Read,
    Draw,
    Steward,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Draw => "draw",
            Self::Steward => "steward",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "read" => Some(Self::Read),
            "draw" => Some(Self::Draw),
            "steward" => Some(Self::Steward),
            _ => None,
        }
    }

    /// Whether holding this capability implies holding `other`.
    ///
    /// `steward` implies `draw` implies `read`. Stated once, here, rather than
    /// as a comparison at each call site — §3.1's table is an ordering and an
    /// `==` against it is the bug that grants a steward no read.
    pub fn covers(self, other: Self) -> bool {
        self >= other
    }
}

// ---------------------------------------------------------------------------
// The signed messages
// ---------------------------------------------------------------------------

/// Everything `grant_bytes` covers (§3.3).
///
/// **`subject_key_fpr` and `granter_key_fpr` are both inside the signed
/// bytes**, and §3.3 gives the reason for each: without the first, an
/// administrator swaps the subject's public key for one they hold and replays
/// a year-old legitimate grant; without the second, a granter's key rotation
/// leaves no statement of which key should have verified the grants they
/// signed.
pub struct GrantFacts<'a> {
    pub organisation: &'a str,
    /// The fingerprint of the organisation ROOT key — so a grant is bound to
    /// the organisation's identity as well as to its id.
    pub root_pubkey_fpr: &'a [u8; 32],
    pub scope: &'a str,
    pub subject: &'a str,
    pub subject_key_fpr: &'a [u8; 32],
    pub capability: Capability,
    /// `None` for a grant signed by the organisation root key: §3.3's
    /// `LP(granter_id_or_empty)`, which is the empty string in that case and
    /// still length-prefixed, so "no granter" and a granter whose id is empty
    /// are the same impossible thing rather than two encodings.
    pub granter: Option<&'a str>,
    pub granter_key_fpr: &'a [u8; 32],
    pub effective_from_unix: i64,
    /// `0` means "does not expire" — §3.3's `u64(expires_at_unix_or_0)`. A
    /// `steward` grant may not use it (`0011` has the `CHECK`).
    pub expires_at_unix: i64,
    pub auth_epoch: i32,
}

/// §3.3's `grant_bytes`, exactly.
///
/// ```text
/// grant_bytes = LP("fathom/grant/v1")
///             ‖ LP(organisation_id) ‖ LP(root_pubkey_fpr) ‖ LP(scope_id)
///             ‖ LP(subject_id) ‖ LP(subject_key_fpr)
///             ‖ LP(capability)
///             ‖ LP(granter_id_or_empty) ‖ LP(granter_key_fpr)
///             ‖ u64(effective_from_unix) ‖ u64(expires_at_unix_or_0)
///             ‖ u32(auth_epoch)
/// ```
pub fn grant_bytes(facts: &GrantFacts<'_>) -> Vec<u8> {
    let mut msg = Vec::with_capacity(256);
    crypto::lp(&mut msg, TAG_GRANT);
    crypto::lp(&mut msg, facts.organisation.as_bytes());
    crypto::lp(&mut msg, facts.root_pubkey_fpr);
    crypto::lp(&mut msg, facts.scope.as_bytes());
    crypto::lp(&mut msg, facts.subject.as_bytes());
    crypto::lp(&mut msg, facts.subject_key_fpr);
    crypto::lp(&mut msg, facts.capability.as_str().as_bytes());
    crypto::lp(&mut msg, facts.granter.unwrap_or("").as_bytes());
    crypto::lp(&mut msg, facts.granter_key_fpr);
    crypto::u64_le(&mut msg, facts.effective_from_unix as u64);
    crypto::u64_le(&mut msg, facts.expires_at_unix as u64);
    crypto::u32_le(&mut msg, facts.auth_epoch as u32);
    msg
}

/// §3.3's `second_bytes`, **with the correction at the head of §3**.
///
/// ```text
/// second_bytes = LP("fathom/grant/second/v1")
///              ‖ LP(H(grant_bytes)) ‖ LP(granter_key_fpr)
/// ```
///
/// The superseded line bound `LP(H(granter_sig))`. A seconder would then have
/// been signing *an encoding of* the granter's signature, of which several
/// exist over one grant, so a seconding could be made not to match a
/// re-encoded — but entirely genuine — granter signature. The granter is
/// already pinned by fingerprint, so binding the fingerprint costs nothing and
/// binds the fact.
pub fn second_bytes(grant_bytes: &[u8], granter_key_fpr: &[u8; 32]) -> Vec<u8> {
    let grant_hash: [u8; 32] = Sha256::digest(grant_bytes).into();
    let mut msg = Vec::with_capacity(128);
    crypto::lp(&mut msg, TAG_GRANT_SECOND);
    crypto::lp(&mut msg, &grant_hash);
    crypto::lp(&mut msg, granter_key_fpr);
    msg
}

/// §3.3's `revoke_bytes`.
///
/// ```text
/// revoke_bytes = LP("fathom/grant/revoke/v1") ‖ LP(organisation_id)
///              ‖ LP(grant_id) ‖ LP(H(grant_bytes)) ‖ u64(revoked_at_unix)
/// ```
pub fn revoke_bytes(
    organisation: &str,
    grant_id: &str,
    grant_bytes: &[u8],
    revoked_at_unix: i64,
) -> Vec<u8> {
    let grant_hash: [u8; 32] = Sha256::digest(grant_bytes).into();
    let mut msg = Vec::with_capacity(160);
    crypto::lp(&mut msg, TAG_GRANT_REVOKE);
    crypto::lp(&mut msg, organisation.as_bytes());
    crypto::lp(&mut msg, grant_id.as_bytes());
    crypto::lp(&mut msg, &grant_hash);
    crypto::u64_le(&mut msg, revoked_at_unix as u64);
    msg
}

/// Suspension and its lifting, in `revoke_bytes`' shape.
///
/// ```text
/// suspend_bytes   = LP("fathom/grant/suspend/v1")   ‖ LP(organisation_id)
///                 ‖ LP(grant_id) ‖ LP(H(grant_bytes)) ‖ u64(at_unix)
/// unsuspend_bytes = LP("fathom/grant/unsuspend/v1") ‖ … the same fields
/// ```
///
/// **§3 specifies no bytes for either.** It names the acts (§1.1's suspend
/// verb, §3.5's *"revoke or suspend anything — 1 steward"*) and the sealed
/// entries (§7.2's `grant_suspended|unsuspended`) and stops. These follow
/// `revoke_bytes` because the act is the same shape: a statement about one
/// existing grant at one time.
///
/// **The two directions have different tags rather than one tag and an action
/// field.** A suspension and its lifting are opposite acts, and a domain tag
/// is the product's own mechanism for keeping two messages from being read as
/// each other — the same reasoning `chain.rs` uses for three chain levels.
pub fn suspend_bytes(
    organisation: &str,
    grant_id: &str,
    grant_bytes: &[u8],
    at_unix: i64,
) -> Vec<u8> {
    suspension_message(
        TAG_GRANT_SUSPEND,
        organisation,
        grant_id,
        grant_bytes,
        at_unix,
    )
}

/// The lifting half of [`suspend_bytes`].
pub fn unsuspend_bytes(
    organisation: &str,
    grant_id: &str,
    grant_bytes: &[u8],
    at_unix: i64,
) -> Vec<u8> {
    suspension_message(
        TAG_GRANT_UNSUSPEND,
        organisation,
        grant_id,
        grant_bytes,
        at_unix,
    )
}

fn suspension_message(
    tag: &[u8],
    organisation: &str,
    grant_id: &str,
    grant_bytes: &[u8],
    at_unix: i64,
) -> Vec<u8> {
    let grant_hash: [u8; 32] = Sha256::digest(grant_bytes).into();
    let mut msg = Vec::with_capacity(160);
    crypto::lp(&mut msg, tag);
    crypto::lp(&mut msg, organisation.as_bytes());
    crypto::lp(&mut msg, grant_id.as_bytes());
    crypto::lp(&mut msg, &grant_hash);
    crypto::u64_le(&mut msg, at_unix as u64);
    msg
}

/// §8.4's succession: what the **old** key signs about the **new** one.
///
/// ```text
/// succession_bytes = LP("fathom/key/succession/v1") ‖ LP(account_id)
///                  ‖ LP(old_key_fpr) ‖ LP(new_key_fpr) ‖ u64(at_unix)
/// ```
///
/// §8.4 requires the signature (`account_keys.succession_sig`) and does not say
/// what it covers. Both fingerprints are in it, in order, so the statement is
/// *"this key, which you already trust, says that key is its successor"* and
/// not a signature that could be replayed to make some third key a successor.
pub fn succession_bytes(
    account: &str,
    old_key_fpr: &[u8; 32],
    new_key_fpr: &[u8; 32],
    at_unix: i64,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(160);
    crypto::lp(&mut msg, TAG_KEY_SUCCESSION);
    crypto::lp(&mut msg, account.as_bytes());
    crypto::lp(&mut msg, old_key_fpr);
    crypto::lp(&mut msg, new_key_fpr);
    crypto::u64_le(&mut msg, at_unix as u64);
    msg
}

// ---------------------------------------------------------------------------
// The seals — §3.4
// ---------------------------------------------------------------------------

/// `K_row = HKDF-Expand(organisation chain key, "fathom/chain/kdf/row/v1", 32)`.
///
/// A third subkey beside `chain::Subkeys`' `K_seal` and `K_content`, derived
/// from the same organisation chain key and domain-separated from both. §3.4
/// names it; §12.2's table does not have it yet, which is why it is in
/// [`LABELS`].
pub fn row_key(organisation_chain_key: &Key32) -> Key32 {
    crypto::hkdf_expand(organisation_chain_key, KDF_ROW_LABEL)
}

/// What one authority row's seal covers.
pub struct RowFacts<'a> {
    pub table: &'a str,
    pub row_id: &'a str,
    pub chain_seq: i64,
    pub row_version: i32,
    /// `canon(row_state)` — `fathom-canon`'s canonical bytes for the row's
    /// own fields. One spelling per value, so the seal does not depend on how
    /// a formatter felt.
    pub row_state: &'a [u8],
}

/// §3.4's `row_seal`.
///
/// ```text
/// row_seal = MAC(K_row, LP("fathom/row/v1") ‖ LP(table_name) ‖ LP(row_id)
///                ‖ u64(chain_seq) ‖ u32(row_version) ‖ LP(canon(row_state)))
/// ```
///
/// **The table name is in it**, so a row lifted from one authority table into
/// another — a revocation re-filed as a seconding, say — does not verify where
/// it lands.
pub fn row_seal(row_key: &Key32, facts: &RowFacts<'_>) -> [u8; 32] {
    let mut msg = Vec::with_capacity(128 + facts.row_state.len());
    crypto::lp(&mut msg, TAG_ROW);
    crypto::lp(&mut msg, facts.table.as_bytes());
    crypto::lp(&mut msg, facts.row_id.as_bytes());
    crypto::u64_le(&mut msg, facts.chain_seq as u64);
    crypto::u32_le(&mut msg, facts.row_version as u32);
    crypto::lp(&mut msg, facts.row_state);
    crypto::mac(row_key.expose(), &msg)
}

/// §3.4's `live_digest` — the keyed statement of **which grants are live**.
///
/// ```text
/// live_digest = MAC(K_row, LP("fathom/authhead/live/v1") ‖ LP(organisation_id)
///                   ‖ u32(auth_epoch) ‖ u32(live_count)
///                   ‖ ⟦ LP(grant_id_i) ‖ LP(row_seal_i) for i in sorted(live) ⟧)
/// ```
///
/// **Sorted by grant id, and the caller does not get to choose the order**:
/// this function sorts, because a digest over a set whose order the caller
/// picks is a digest over a different value per caller. `live_count` is
/// derived from the slice for the same reason — a count that disagreed with
/// the list would be a second, unchecked statement of the same fact.
///
/// Each grant's **own row seal** is in the digest, not just its id, so the head
/// covers what every live grant *says* as well as which ones there are. That
/// is what makes "editing `capability` on a real grant grants nothing" true
/// (§14's test list) without the head being rewritten.
pub fn live_digest(
    row_key: &Key32,
    organisation: &str,
    auth_epoch: i32,
    live: &[(String, [u8; 32])],
) -> [u8; 32] {
    let mut sorted: Vec<&(String, [u8; 32])> = live.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));

    let mut msg = Vec::with_capacity(64 + sorted.len() * 72);
    crypto::lp(&mut msg, TAG_AUTHHEAD_LIVE);
    crypto::lp(&mut msg, organisation.as_bytes());
    crypto::u32_le(&mut msg, auth_epoch as u32);
    crypto::u32_le(&mut msg, sorted.len() as u32);
    for (grant_id, seal) in sorted {
        crypto::lp(&mut msg, grant_id.as_bytes());
        crypto::lp(&mut msg, seal);
    }
    crypto::mac(row_key.expose(), &msg)
}

/// §3.4's `head_seal`, under `K_seal` — the same subkey the chain's own seals
/// use, because the head is a statement about the chain's organisation.
///
/// ```text
/// head_seal = MAC(K_seal, LP("fathom/authhead/seal/v1") ‖ LP(organisation_id)
///                 ‖ u32(auth_epoch) ‖ u64(chain_seq) ‖ LP(live_digest))
/// ```
pub fn head_seal(
    seal_key: &Key32,
    organisation: &str,
    auth_epoch: i32,
    chain_seq: i64,
    live_digest: &[u8; 32],
) -> [u8; 32] {
    let mut msg = Vec::with_capacity(128);
    crypto::lp(&mut msg, TAG_AUTHHEAD_SEAL);
    crypto::lp(&mut msg, organisation.as_bytes());
    crypto::u32_le(&mut msg, auth_epoch as u32);
    crypto::u64_le(&mut msg, chain_seq as u64);
    crypto::lp(&mut msg, live_digest);
    crypto::mac(seal_key.expose(), &msg)
}

// ---------------------------------------------------------------------------
// ES256
// ---------------------------------------------------------------------------

/// Why a signature was refused. **Every variant is a refusal**; there is no
/// variant meaning "probably fine".
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SignatureRefused {
    /// The public key is not a SEC1 uncompressed P-256 point, or is not on the
    /// curve.
    PublicKeyMalformed,
    /// Not exactly [`SIGNATURE_LEN`] bytes. **This is the branch a DER
    /// signature lands in** — an ASN.1 encoding of a P-256 signature is 70 to
    /// 72 bytes, and the one length this accepts is the fixed pair.
    WrongLength { len: usize },
    /// 64 bytes, but `r` or `s` is zero or not a reduced scalar.
    Malformed,
    /// `s` is in the upper half of the curve order. A perfectly valid ECDSA
    /// signature, and refused: it is the second member of the malleable pair,
    /// and admitting it means one grant has two signatures (§3's correction).
    HighS,
    /// The signature does not verify under this key over these bytes.
    DoesNotVerify,
}

impl core::fmt::Display for SignatureRefused {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::PublicKeyMalformed => {
                f.write_str("the public key is not an uncompressed P-256 point on the curve")
            }
            Self::WrongLength { len } => write!(
                f,
                "a signature is 64 bytes of r || s and this is {len}; DER is not accepted, \
                 because several DER encodings of one signature are several byte strings over \
                 one fact"
            ),
            Self::Malformed => f.write_str("r or s is zero or out of range"),
            Self::HighS => f.write_str(
                "s is in the upper half of the group order. That is a valid ECDSA signature and \
                 it is refused: admitting both halves of the malleable pair would mean one act \
                 has two signatures",
            ),
            Self::DoesNotVerify => {
                f.write_str("the signature does not verify under this key over these bytes")
            }
        }
    }
}

impl std::error::Error for SignatureRefused {}

/// A software ES256 signing key.
///
/// **§15.1 admits this as a deliberate downgrade and says what it costs.** A
/// software key is exactly as strong as hardware at tier 1 and tier 2; what it
/// gives up is tier 3, where *"one bundle substitution plus one unlock mints
/// grants for that steward indefinitely, where hardware would have required
/// catching a real steward at a real touch, one grant at a time."* Nothing in
/// this type may be described as more than that.
///
/// Signing is deterministic — `ecdsa 0.17.0`'s `Signer` impl derives the
/// ephemeral scalar per RFC 6979 — which is why `tests/authority_vectors.rs`
/// can pin a signature as a literal at all.
pub struct SoftwareKey(SigningKey);

impl SoftwareKey {
    /// From the 32-byte private scalar.
    pub fn from_bytes(bytes: &[u8; 32]) -> Option<Self> {
        SigningKey::from_slice(bytes).ok().map(Self)
    }

    /// A fresh key from the OS CSPRNG — the same generator every other key in
    /// this server comes from (`crypto::Key32::random`), never a userspace
    /// generator with its own state.
    pub fn random() -> Result<Self, crypto::CryptoError> {
        loop {
            let bytes = *Key32::random()?.expose();
            if let Some(key) = Self::from_bytes(&bytes) {
                return Ok(key);
            }
            // A uniformly random 32-byte string is out of range for the curve
            // with probability far below 2^-32. Looping is the correct
            // handling and it is not a hot path.
        }
    }

    /// The SEC1 uncompressed public point — what `account_keys.public_key` and
    /// `organisation_roots.root_pubkey` hold.
    pub fn public_key(&self) -> [u8; PUBLIC_KEY_LEN] {
        let point = VerifyingKey::from(*self.0.verifying_key()).to_sec1_point(false);
        let mut out = [0u8; PUBLIC_KEY_LEN];
        out.copy_from_slice(point.as_ref());
        out
    }

    /// This key's fingerprint, the name a grant knows it by.
    pub fn fingerprint(&self) -> [u8; 32] {
        key_fingerprint(&self.public_key())
    }

    /// Sign, and **normalise `s` low before returning**.
    ///
    /// P-256 does not normalise by default (`NistP256::NORMALIZE_S` is
    /// `false`), so without this line this server would sometimes produce
    /// signatures its own [`verify_es256`] refuses — roughly half of them.
    /// Normalising at the one place signatures are produced is what makes the
    /// rule at the one place they are checked affordable.
    pub fn sign(&self, message: &[u8]) -> [u8; SIGNATURE_LEN] {
        let signature: Signature = self.0.sign(message);
        let normalised = signature.normalize_s();
        let bytes = normalised.to_bytes();
        let mut out = [0u8; SIGNATURE_LEN];
        out.copy_from_slice(bytes.as_ref());
        out
    }
}

impl core::fmt::Debug for SoftwareKey {
    /// Prints the fingerprint, never the scalar.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let fpr = self.fingerprint();
        write!(
            f,
            "SoftwareKey({:02x}{:02x}{:02x}{:02x}…)",
            fpr[0], fpr[1], fpr[2], fpr[3]
        )
    }
}

/// Verify an ES256 signature over `message` under a SEC1 uncompressed key.
///
/// **Three refusals happen before any curve arithmetic**, and each one closes a
/// half of §3's malleability correction:
///
/// 1. not 64 bytes → [`SignatureRefused::WrongLength`]. A DER blob dies here.
/// 2. `r` or `s` zero or out of range → [`SignatureRefused::Malformed`].
/// 3. `s` high → [`SignatureRefused::HighS`]. **This is not the crate's
///    default**: `ecdsa 0.17.0` only rejects a high `s` for curves whose
///    `NORMALIZE_S` is true, and P-256's is false, so a verifier that wants one
///    canonical signature per act has to say so itself. It is said here.
///
/// # Nothing is cached
///
/// §3.4: *"no verdict is ever stored"*. This function takes the key bytes and
/// the message bytes and returns a result; it holds no state, consults no
/// table, and has nowhere to put a verdict even if someone wanted one. The one
/// thing `grants.rs` memoises is the live set itself, keyed by
/// `(organisation, auth_epoch)`, in process memory — a pure function of sealed
/// rows, discarded on epoch change, and never a stored answer to "may they?".
pub fn verify_es256(
    public_key: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<(), SignatureRefused> {
    if signature.len() != SIGNATURE_LEN {
        return Err(SignatureRefused::WrongLength {
            len: signature.len(),
        });
    }
    let parsed = Signature::from_slice(signature).map_err(|_| SignatureRefused::Malformed)?;
    if parsed != parsed.normalize_s() {
        return Err(SignatureRefused::HighS);
    }
    let key = VerifyingKey::from_sec1_bytes(public_key)
        .map_err(|_| SignatureRefused::PublicKeyMalformed)?;
    key.verify(message, &parsed)
        .map_err(|_| SignatureRefused::DoesNotVerify)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_key() -> SoftwareKey {
        SoftwareKey::from_bytes(&[7u8; 32]).expect("a valid scalar")
    }

    #[test]
    fn a_signature_this_server_produced_verifies() {
        let key = a_key();
        let sig = key.sign(b"the estate");
        assert_eq!(verify_es256(&key.public_key(), b"the estate", &sig), Ok(()));
    }

    #[test]
    fn one_bit_of_the_message_is_a_refusal() {
        let key = a_key();
        let sig = key.sign(b"the estate");
        assert_eq!(
            verify_es256(&key.public_key(), b"the estatf", &sig),
            Err(SignatureRefused::DoesNotVerify)
        );
    }

    #[test]
    fn a_signature_is_refused_under_another_key() {
        let key = a_key();
        let other = SoftwareKey::from_bytes(&[9u8; 32]).unwrap();
        let sig = key.sign(b"the estate");
        assert_eq!(
            verify_es256(&other.public_key(), b"the estate", &sig),
            Err(SignatureRefused::DoesNotVerify)
        );
    }

    #[test]
    fn the_signatures_this_server_produces_are_always_low_s() {
        // Deterministic signing, so this is a statement about the normalising
        // line rather than a sampling argument: sign many distinct messages
        // and require every one to survive its own verifier.
        let key = a_key();
        for n in 0..64u32 {
            let message = format!("message {n}");
            let sig = key.sign(message.as_bytes());
            assert_eq!(
                verify_es256(&key.public_key(), message.as_bytes(), &sig),
                Ok(()),
                "signature {n} was not accepted by this server's own rule"
            );
        }
    }

    #[test]
    fn the_capability_order_is_an_order() {
        assert!(Capability::Steward.covers(Capability::Read));
        assert!(Capability::Steward.covers(Capability::Draw));
        assert!(Capability::Draw.covers(Capability::Read));
        assert!(!Capability::Read.covers(Capability::Draw));
        assert!(!Capability::Draw.covers(Capability::Steward));
    }

    #[test]
    fn a_derived_organisation_id_is_a_usable_id() {
        let key = a_key();
        let id = derive_organisation_id(&key.public_key(), &[3u8; 16]);
        assert_eq!(id.len(), 26);
        assert!(
            fathom_id::Ulid::decode(&id).is_ok(),
            "{id} is not decodable"
        );
    }

    #[test]
    fn a_different_root_key_derives_a_different_organisation() {
        // §6.1's whole claim, in one assertion: a re-minted genesis under a
        // different key is a different organisation and matches no row.
        let a = derive_organisation_id(&a_key().public_key(), &[3u8; 16]);
        let b = derive_organisation_id(
            &SoftwareKey::from_bytes(&[9u8; 32]).unwrap().public_key(),
            &[3u8; 16],
        );
        assert_ne!(a, b);
    }

    #[test]
    fn the_salt_is_in_the_derivation_too() {
        let key = a_key();
        assert_ne!(
            derive_organisation_id(&key.public_key(), &[3u8; 16]),
            derive_organisation_id(&key.public_key(), &[4u8; 16])
        );
    }

    #[test]
    fn seconding_binds_the_grant_and_not_an_encoding_of_a_signature() {
        // The §3 correction, stated as a property: `second_bytes` is a
        // function of the grant and the granter's key and of nothing else, so
        // no re-encoding of the granter's signature can change it.
        let fpr = [1u8; 32];
        let a = second_bytes(b"grant bytes", &fpr);
        let b = second_bytes(b"grant bytes", &fpr);
        assert_eq!(a, b);
        assert_ne!(a, second_bytes(b"grant byteS", &fpr));
        assert_ne!(a, second_bytes(b"grant bytes", &[2u8; 32]));
    }

    #[test]
    fn every_message_is_domain_separated() {
        // Same fields, different acts: nothing here may be replayed as
        // anything else here.
        let suspend = suspend_bytes("org", "grant", b"bytes", 7);
        let unsuspend = unsuspend_bytes("org", "grant", b"bytes", 7);
        let revoke = revoke_bytes("org", "grant", b"bytes", 7);
        assert_ne!(suspend, unsuspend);
        assert_ne!(suspend, revoke);
        assert_ne!(unsuspend, revoke);
    }

    #[test]
    fn the_live_digest_does_not_depend_on_the_callers_order() {
        let key = Key32::from_bytes([5u8; 32]);
        let one = ("01JQZ0000000000000000000AA".to_string(), [1u8; 32]);
        let two = ("01JQZ0000000000000000000BB".to_string(), [2u8; 32]);
        assert_eq!(
            live_digest(&key, "org", 3, &[one.clone(), two.clone()]),
            live_digest(&key, "org", 3, &[two, one])
        );
    }

    #[test]
    fn the_live_digest_covers_what_each_grant_says() {
        let key = Key32::from_bytes([5u8; 32]);
        let id = "01JQZ0000000000000000000AA".to_string();
        assert_ne!(
            live_digest(&key, "org", 3, &[(id.clone(), [1u8; 32])]),
            live_digest(&key, "org", 3, &[(id, [2u8; 32])]),
            "the head must move when a live grant's own row seal moves"
        );
    }

    #[test]
    fn the_row_seal_names_its_table() {
        let key = Key32::from_bytes([5u8; 32]);
        let facts = |table| RowFacts {
            table,
            row_id: "01JQZ0000000000000000000AA",
            chain_seq: 4,
            row_version: 1,
            row_state: b"{}",
        };
        assert_ne!(
            row_seal(&key, &facts("scope_grants")),
            row_seal(&key, &facts("grant_revocations")),
            "a row lifted into another authority table must not verify where it lands"
        );
    }

    #[test]
    fn the_label_list_names_every_label_this_module_uses() {
        for label in [
            TAG_KEY_FPR,
            TAG_ORG_ID,
            TAG_GRANT,
            TAG_GRANT_SECOND,
            TAG_GRANT_REVOKE,
            TAG_GRANT_SUSPEND,
            TAG_GRANT_UNSUSPEND,
            TAG_KEY_SUCCESSION,
            KDF_ROW_LABEL,
            TAG_ROW,
            TAG_AUTHHEAD_LIVE,
            TAG_AUTHHEAD_SEAL,
        ] {
            let text = core::str::from_utf8(label).unwrap();
            assert!(
                LABELS.iter().any(|(name, _)| *name == text),
                "{text} is used and is not in LABELS, so PHASE-2-STORAGE-DESIGN.md \
                 §12.2's table cannot be reconciled against this file"
            );
        }
    }
}
