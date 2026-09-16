//! **The per-request proof.** §4 of
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`: one principal per session, a
//! keypair the browser holds and the server has never seen, a challenge that
//! binds it, single-use nonces, and a signature on every request that reaches
//! design payload or vault ciphertext.
//!
//! `migrations/0013_sessions.sql` is the schema and carries the reasoning for
//! every constraint and every departure from §4.3's SQL. This file holds the
//! bytes and the order things happen in; `api.rs` is the HTTP surface over it.
//!
//! # The one sentence everything else rests on
//!
//! §13 item 1: **`actor` comes from a session, never from the caller.** That
//! is made structural here rather than asserted:
//!
//! * [`VerifiedSession`] has private fields and no public constructor. The
//!   only thing that produces one is [`SessionStore::verify_pending`], which
//!   recomputes the row MAC, checks that the session has not been recorded as
//!   signed out, re-resolves the evidence key and verifies an ES256 signature
//!   over the request's own method, path, body digest, nonce and time before
//!   it returns — all of it inside the caller's transaction, so that whatever
//!   the caller authorises next sees the same snapshot.
//!   [`SessionStore::begin_request`] spends the single-use nonce first, in a
//!   transaction of its own that commits whatever the handler then does, and
//!   [`SessionStore::verify_request`] is the two together for a caller with
//!   nothing else to do.
//! * It does **not** expose an `AccountId`. It exposes
//!   [`VerifiedSession::principal_id`], a string for logging and for tests,
//!   and that is not a type the repository layer accepts.
//! * [`open_tenant_context`] is the only way to turn a session into a
//!   [`repo::TenantContext`], and it takes `&VerifiedSession`. So a handler
//!   that wants to read a design has exactly one route to the tenant context
//!   the key hierarchy demands, and that route begins at a verified
//!   signature.
//!
//! `tests/sessions.rs` holds the test that the HTTP surface names no other
//! source of an actor, because the type system cannot stop a handler parsing
//! a ULID out of a header and calling `repo::open_tenant_context` itself.
//!
//! # What is NOT here
//!
//! * **No password, for anyone** (§4.5, §5.1, `docs/OPEN-QUESTIONS.md` C2).
//!   There is no password column, no reset path, no "forgot" flow and no
//!   field in any message this module parses that a password could arrive in.
//! * **No WebAuthn** (§15.4). Sign-in is a signature by a software ES256 key
//!   enrolled in `account_keys` (§15.1's deliberate downgrade). The challenge
//!   derivation is the one §4.2 specifies, so the WebAuthn path lands on the
//!   same bytes when it is built.
//! * **No operator password, and no operator anything-but-a-key.** §4.5 is
//!   kept exactly: an operator session is `A1` or it does not exist. Since
//!   `migrations/0015` there IS a table an operator's key is enrolled in
//!   (`operator_keys`), so the operator branch of sign-in now resolves a key
//!   and verifies a signature over the same challenge an account signs —
//!   **the same mechanism, on the other plane**, which is what §4.5 asks for.
//!   An operator with no key enrolled is refused with the same message an
//!   unknown address gets; there is no weaker factor to fall back to and
//!   there must never be one.
//! * **No verdict is cached.** Every request re-reads the row, re-verifies the
//!   MAC, re-resolves the evidence key and re-verifies a fresh signature.
//! * **No background task.** `migrations/0014_session_hardening.sql` §C's
//!   sweep of expired rows runs on the write path of each of the three tables
//!   it is about, because this deployment is two interchangeable containers
//!   with no scheduler and a sweeper that runs in one of them stops when that
//!   one is rescheduled.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::{Pool, PoolError, Transaction};
use fathom_canon::Json;
use sha2::{Digest, Sha256};

use crate::authority::{self, RowFacts, SignatureRefused};
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError};
use crate::crypto::{self, Key32};
use crate::grants::{self, AuthorityError};
use crate::ids;
use crate::keys::{KeyRing, KeyStoreError};
use crate::operators;
use crate::repo::{self, AccountId, OrganisationId, RepoError, TenantContext};

// ---------------------------------------------------------------------------
// The labels
// ---------------------------------------------------------------------------

/// §4.2's challenge derivation.
const TAG_SESSION_BIND: &[u8] = b"fathom/session/bind/v1";

/// §4.2's per-request message.
const TAG_SESSION_REQUEST: &[u8] = b"fathom/session/req/v1";

/// The bearer token's stored form. §4.3 names the column and not the
/// construction.
const TAG_SESSION_TOKEN: &[u8] = b"fathom/session/token/v1";

/// The software-key analogue of §4.3's `assertion_digest`.
const TAG_SESSION_EVIDENCE: &[u8] = b"fathom/session/evidence/v1";

/// HKDF `info` from the site chain key → `K_addr`, the key the claimed
/// sign-in address is hashed under. `0014` §A.
const KDF_SESSION_ADDRESS: &[u8] = b"fathom/session/kdf/address/v1";

/// In-MAC tag of the claimed-address key. `0014` §A.
const TAG_SESSION_ADDRESS: &[u8] = b"fathom/session/address/v1";

/// **Every label this module introduces, for `PHASE-2-STORAGE-DESIGN.md`
/// §12.2's table, which owns them.**
///
/// Same contract as [`crate::authority::LABELS`]: the table wins over this
/// file, a unit test at the bottom asserts that every label the code uses is
/// listed here, and the list is what a reader reconciles against §12.2 in one
/// read.
///
/// **Two labels §4.3 specifies are deliberately NOT here**, because nothing
/// derives them: `fathom/session/mac/v1` (a `K_sess` subkey from
/// `chain_master`) and `fathom/session/row/v1` (a session-specific row MAC).
/// A session row is account-scoped exactly as a keyring row is, so it is
/// sealed under the site-scoped row key `0012` §D already established, with
/// `authority::row_seal`'s construction and its `fathom/row/v1` tag. A label
/// separates uses of one key; this is not a new use. `0013`'s departure 2
/// carries the full argument.
pub const LABELS: &[(&str, &str)] = &[
    (
        "fathom/session/bind/v1",
        "hash tag of the session challenge: H(LP(tag) ‖ LP(session_pubkey) ‖ LP(server_nonce) \
         ‖ LP(deployment_id)) (§4.2)",
    ),
    (
        "fathom/session/req/v1",
        "in-signature tag of the per-request message (§4.2), with LP(nonce) added — see \
         `request_bytes`",
    ),
    (
        "fathom/session/token/v1",
        "hash tag of the stored bearer token: H(LP(tag) ‖ LP(token)) (§4.3 names the column and \
         not the construction)",
    ),
    (
        "fathom/session/evidence/v1",
        "hash tag of the software-key assurance evidence: H(LP(tag) ‖ LP(session_challenge) ‖ \
         LP(evidence_sig)). §4.3's `assertion_digest` presumes WebAuthn; §15.1 ships software \
         keys",
    ),
    (
        "fathom/session/kdf/address/v1",
        "HKDF `info` from the SITE chain key → `K_addr`, the key a claimed sign-in address is \
         hashed under so the rate-limit table never holds a list of addresses that are not \
         accounts (0014 §A). Same shape as `authority::row_key`'s expansion of the same input",
    ),
    (
        "fathom/session/address/v1",
        "in-MAC tag of the claimed-address key: MAC(K_addr, LP(tag) ‖ LP(address)) (0014 §A)",
    ),
];

// ---------------------------------------------------------------------------
// Times and sizes — every one of them named, none of them scattered
// ---------------------------------------------------------------------------

/// How long a session lives before it must be established again.
///
/// **§4 gives no number.** Twelve hours is a working day plus the evening: long
/// enough that a network engineer documenting a rack is not signed out
/// mid-task, short enough that a laptop left open overnight is not a live
/// session in the morning. It is a constant rather than a setting because a
/// deployment that wants a different one should say so in the register, and
/// nothing yet reads that register.
pub const SESSION_LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);

/// How long a challenge nonce — sign-in or per-request — stays usable.
///
/// Two minutes covers a human reading a prompt and a browser producing a
/// signature, and bounds how long a captured nonce is worth anything. It is
/// also the window the request timestamp is checked against, so the two cannot
/// drift apart into a gap.
pub const NONCE_LIFETIME: Duration = Duration::from_secs(120);

/// How far a request's own timestamp may sit from the server's clock.
pub const CLOCK_SKEW: Duration = NONCE_LIFETIME;

/// How many unconsumed nonces one session may hold at once.
///
/// A browser with several requests in flight needs more than one; nothing
/// legitimate needs thirty-two. The cap is what stops a live session being a
/// way to grow a table without bound.
pub const MAX_OUTSTANDING_NONCES: i64 = 32;

/// How far past the mark recorded when a nonce was issued a request counter
/// may sit before it is refused (`0014`, finding 7).
///
/// **Without an upper bound the counter is a brick.** `request_counter` is
/// stored as `GREATEST(request_counter, $counter)`, so one signed request
/// carrying `i64::MAX` set the high-water mark to `i64::MAX` and no later
/// nonce could ever satisfy `counter > issued_counter` again. The session was
/// dead for the rest of its twelve hours and nothing but a sign-out could
/// clear it — a self-inflicted denial of service a stolen bearer token could
/// trigger against the person it was stolen from.
///
/// The window is [`MAX_OUTSTANDING_NONCES`] because that is exactly how many
/// requests one browser may legitimately have in flight against one mark: all
/// of them share an `issued_counter` and each picks the next value of its own
/// tally, so `issued + 1 ..= issued + 32` is the whole legitimate range and
/// anything beyond it is a client that has lost count or an attacker.
pub const COUNTER_WINDOW: i64 = MAX_OUTSTANDING_NONCES;

/// The absolute range a client-supplied millisecond timestamp must be inside
/// **before any arithmetic touches it** (`0014`, finding 5).
///
/// `fathom-timestamp: -9223372036854775808` parsed cleanly as an `i64` and
/// reached `now * 1000 - unix_ms`, which overflows — and the server profile
/// sets `overflow-checks = true`, so that is a panic, and `.abs()` on
/// `i64::MIN` panics on the same line for a second reason. A header panicked
/// the request task.
///
/// The bound is the honest one rather than the one the arithmetic needs: a
/// request timestamp is a wall clock in milliseconds, so it is at or after the
/// epoch and before the end of the four-digit years. Checked arithmetic
/// follows anyway, because a bound that is later widened must not quietly
/// re-open the panic.
pub const MIN_UNIX_MS: i64 = 0;

/// The upper half of [`MIN_UNIX_MS`]'s range: `9999-12-31T23:59:59.999Z`.
pub const MAX_UNIX_MS: i64 = 253_402_300_799_999;

/// How many expired rows one write sweeps (`0014` §C).
///
/// **A sweep on the write path, not a background task**: this deployment is
/// two interchangeable containers with no scheduler, and a sweeper that runs
/// in one of them stops when that one is rescheduled. Bounded so that one
/// unlucky request does not pay for a year of accumulated rows, and large
/// enough that the steady state is bounded by the arrival rate — every write
/// clears far more than the one row it adds.
pub const SWEEP_BATCH: i64 = 256;

/// §13 item 7's shape, which the design does not specify. See
/// `migrations/0013_sessions.sql` §D for the argument and
/// `migrations/0014_session_hardening.sql` §0 for the correction to it; this
/// is the part a deployment can change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SignInLimits {
    /// `FATHOM_SIGNIN_WINDOW_SECONDS`. The fixed window both buckets count in.
    pub window: Duration,
    /// `FATHOM_SIGNIN_MAX_PER_ACCOUNT`. **Failures** against one claimed
    /// identity — an account id where the address resolved, a keyed hash of
    /// the address where it did not (`0014` §A).
    pub max_per_account: i32,
    /// `FATHOM_SIGNIN_MAX_PER_SOURCE`. **Attempts** from one source address,
    /// counted at `/session/challenge` as well as at `/session`, so one
    /// complete sign-in costs two.
    pub max_per_source: i32,
}

impl SignInLimits {
    /// Fifteen minutes, ten failures per claimed identity, thirty attempts per
    /// source.
    ///
    /// # Both numbers are rate limits. Neither is a lockout
    ///
    /// **Decided 2026-09-14, and `0014` §0 carries the whole argument.** This
    /// doc comment used to read *"the account number is a lockout and the
    /// source number is a rate limit"*, and `0013` §D said either bucket
    /// refuses. Neither was true of the code: [`SessionStore::sign_in`] checks
    /// the source bucket before it attempts anything and reads the account
    /// bucket only on a path that has already failed, so a caller whose
    /// signature is good has never been refused by the account bucket however
    /// many failures that identity has collected.
    ///
    /// It stays that way. On an unauthenticated surface a lockout hands an
    /// attacker a denial of service against a named person for the price of
    /// eleven bad signatures, and there is no password here to brute force —
    /// the factor is a signature by a key enrolled in `account_keys`, and the
    /// only way past it is the private half. What the account bucket buys is a
    /// bound on how much work and how much sealed audit one claimed identity
    /// can cause inside a window, which is worth having and is all it claims.
    ///
    /// The two numbers still differ, for the reason they always did: a
    /// legitimate person fails a signature a handful of times at most (a wrong
    /// profile, a stale key), while a legitimate office behind one address
    /// signs in all morning.
    ///
    /// **Thirty per source is fifteen complete sign-ins**, since `0014` counts
    /// the challenge route too. A deployment behind a single NAT should raise
    /// it; that is what `FATHOM_SIGNIN_MAX_PER_SOURCE` is for.
    pub fn defaults() -> Self {
        Self {
            window: Duration::from_secs(15 * 60),
            max_per_account: 10,
            max_per_source: 30,
        }
    }

    /// Parse from a lookup, exactly as `audit::SpoolBounds::from_lookup` does.
    /// `Err` names the variable and never its value.
    pub fn from_lookup<F>(get: F) -> Result<Self, &'static str>
    where
        F: Fn(&str) -> Option<String>,
    {
        let d = Self::defaults();
        let window = match get("FATHOM_SIGNIN_WINDOW_SECONDS").filter(|v| !v.trim().is_empty()) {
            None => d.window,
            Some(v) => v
                .trim()
                .parse::<u64>()
                .ok()
                .filter(|s| *s > 0)
                .map(Duration::from_secs)
                .ok_or("FATHOM_SIGNIN_WINDOW_SECONDS")?,
        };
        let max_per_account =
            match get("FATHOM_SIGNIN_MAX_PER_ACCOUNT").filter(|v| !v.trim().is_empty()) {
                None => d.max_per_account,
                Some(v) => v
                    .trim()
                    .parse::<i32>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or("FATHOM_SIGNIN_MAX_PER_ACCOUNT")?,
            };
        let max_per_source =
            match get("FATHOM_SIGNIN_MAX_PER_SOURCE").filter(|v| !v.trim().is_empty()) {
                None => d.max_per_source,
                Some(v) => v
                    .trim()
                    .parse::<i32>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or("FATHOM_SIGNIN_MAX_PER_SOURCE")?,
            };
        Ok(Self {
            window,
            max_per_account,
            max_per_source,
        })
    }
}

impl Default for SignInLimits {
    fn default() -> Self {
        Self::defaults()
    }
}

// ---------------------------------------------------------------------------
// The signed and hashed messages
// ---------------------------------------------------------------------------

/// §4.2's `session_challenge`.
///
/// ```text
/// session_challenge = H(LP("fathom/session/bind/v1") ‖ LP(session_pubkey)
///                       ‖ LP(server_nonce) ‖ LP(deployment_id))
/// ```
///
/// **The tag is length-prefixed, where §4.2 writes it bare** — the same
/// deviation `authority::key_fingerprint` records for §3.2's fingerprint, for
/// the same reason: storage §11.2's rule is *"length-prefix every
/// variable-length field"* and every construction in this codebase already
/// prefixes its tag. Two spellings of one rule inside one codebase is how a
/// signature stops verifying the day somebody unifies them.
///
/// The nonce is single-use and is deleted at verification, so **the same
/// evidence signature cannot bind a second public key** (§4.2). The
/// deployment id is in it so a challenge from one deployment is not a
/// challenge anywhere else.
pub fn session_challenge(
    session_pubkey: &[u8],
    server_nonce: &[u8; 32],
    deployment_id: &str,
) -> [u8; 32] {
    let mut msg = Vec::with_capacity(192);
    crypto::lp(&mut msg, TAG_SESSION_BIND);
    crypto::lp(&mut msg, session_pubkey);
    crypto::lp(&mut msg, server_nonce);
    crypto::lp(&mut msg, deployment_id.as_bytes());
    Sha256::digest(&msg).into()
}

/// §4.2's `request_bytes`, **with the nonce inside them**.
///
/// ```text
/// request_bytes = LP("fathom/session/req/v1") ‖ LP(session_id) ‖ LP(method)
///               ‖ LP(path) ‖ LP(H(body)) ‖ LP(nonce)
///               ‖ u64(unix_ms) ‖ u64(request_counter)
/// ```
///
/// # The departure, which is the whole control
///
/// §4.2 writes this message **without the nonce**: tag, session id, method,
/// path, body digest, time, counter. §4.1 and this build's brief both require
/// a single-use nonce per request. A nonce that is not inside the signed bytes
/// is not bound to the signature at all: an observer who captures one signed
/// request can present it again with a *different* fresh nonce, and every
/// check but the counter passes. So `LP(nonce)` sits between the body digest
/// and the times, and the label stays `v1` because v1 never shipped — nothing
/// has ever produced or stored one of these messages.
///
/// # What each field is for
///
/// * `session_id` — so a signature made for one session is not a signature for
///   another, even if the same browser holds both keys.
/// * `method` and `path` — so a signed `GET` of a scope tree is not a signed
///   `DELETE` of a design, and a signature over one path is not a signature
///   over another. **`path` is the path AND the query**, because a query
///   string that is not signed is a query string an intermediary may rewrite.
/// * `H(body)` — the body itself is not signed, so a large upload is hashed
///   once rather than copied.
/// * `unix_ms` — bounds how long a captured message is worth presenting, and
///   is checked against [`CLOCK_SKEW`].
/// * `request_counter` — §4.3's, and §4.3's own sentence about it is repeated
///   in `0013` §B: it is anti-replay against a network observer and **not**
///   against the database attacker, who owns the column it is compared with.
pub fn request_bytes(
    session_id: &str,
    method: &str,
    path: &str,
    body_digest: &[u8; 32],
    nonce: &[u8; 32],
    unix_ms: i64,
    request_counter: i64,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(256);
    crypto::lp(&mut msg, TAG_SESSION_REQUEST);
    crypto::lp(&mut msg, session_id.as_bytes());
    crypto::lp(&mut msg, method.as_bytes());
    crypto::lp(&mut msg, path.as_bytes());
    crypto::lp(&mut msg, body_digest);
    crypto::lp(&mut msg, nonce);
    crypto::u64_le(&mut msg, unix_ms as u64);
    crypto::u64_le(&mut msg, request_counter as u64);
    msg
}

/// `H(body)` — SHA-256 over the request body exactly as it arrived, with no
/// length prefix, because the body is the whole input and the digest is
/// length-prefixed where it is used.
pub fn body_digest(body: &[u8]) -> [u8; 32] {
    Sha256::digest(body).into()
}

/// The stored form of the bearer token: `H(LP(tag) ‖ LP(token))`.
///
/// **The token is deliberately weak and this is where to say so.** On its own
/// it buys exactly one thing — a fresh single-use nonce — and nothing that
/// reaches design payload or vault ciphertext, because those need a signature
/// under a key the server has never seen. It is hashed at rest so that a
/// database read does not hand an attacker even that.
pub fn token_hash(token: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64);
    crypto::lp(&mut msg, TAG_SESSION_TOKEN);
    crypto::lp(&mut msg, token);
    Sha256::digest(&msg).into()
}

/// §4.2's stored assurance evidence, in the software-key shape:
/// `H(LP(tag) ‖ LP(session_challenge) ‖ LP(evidence_sig))`.
///
/// §4.2 settles what the evidence IS — *"a signature by the account's
/// registered key over the same `session_challenge`"* — and §4.3 stores a
/// digest of a WebAuthn assertion. This is the same digest for the factor
/// §15.1 actually ships. The signature itself is stored beside it, because a
/// digest is not something a later reader can re-verify.
pub fn evidence_digest(challenge: &[u8; 32], evidence_sig: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(160);
    crypto::lp(&mut msg, TAG_SESSION_EVIDENCE);
    crypto::lp(&mut msg, challenge);
    crypto::lp(&mut msg, evidence_sig);
    Sha256::digest(&msg).into()
}

/// The keyed hash a claimed sign-in address is counted under (`0014` §A).
///
/// ```text
/// K_addr              = HKDF-Expand(site chain key,
///                                   "fathom/session/kdf/address/v1", 32)
/// claimed_address_key = MAC(K_addr, LP("fathom/session/address/v1")
///                                   ‖ LP(address))
/// ```
///
/// # Why the table may not hold the address
///
/// The defect this closes is an account oracle: the account bucket used to be
/// counted only when the consumed bind nonce carried a principal, so an
/// address belonging to nobody never crossed the cap and always answered `401`
/// while a real one answered `429`. Counting both closes it — but the bucket
/// key is stored, and storing the addresses that are NOT accounts means
/// storing whatever people type into a sign-in box, which is their address at
/// some other service often enough to matter and occasionally a password typed
/// into the wrong field. A keyed hash groups attempts per address for as long
/// as the window lasts and is not a list of addresses to anybody holding the
/// database, because `K_addr` is derived from the chain master and the chain
/// master is not in PostgreSQL.
///
/// # Derived from the site chain key, exactly as `authority::row_key` is
///
/// The site chain key is the one key in this deployment that is the same for
/// every organisation, and a sign-in is not organisation-scoped. The label is
/// new because this is a new USE of that key, which is the rule
/// `PHASE-2-STORAGE-DESIGN.md` §12.2 states for when a label is and is not
/// warranted.
///
/// **The address is hashed exactly as it was typed.** No case folding and no
/// trimming, because `account_by_address` matches exactly too: a variant
/// spelling resolves to no account, lands in its own bucket, and is refused
/// for the same reason any other unknown address is.
pub fn claimed_address_key(site_chain_key: &Key32, address: &str) -> [u8; 32] {
    let subkey = crypto::hkdf_expand(site_chain_key, KDF_SESSION_ADDRESS);
    let mut msg = Vec::with_capacity(96);
    crypto::lp(&mut msg, TAG_SESSION_ADDRESS);
    crypto::lp(&mut msg, address.as_bytes());
    crypto::mac(subkey.expose(), &msg)
}

// ---------------------------------------------------------------------------
// Small types
// ---------------------------------------------------------------------------

/// Which plane a session belongs to (§13 item 2: *"a session carries exactly
/// one principal, and its kind is recorded"*).
///
/// The two values are `0004`'s `principals.kind`, not §4.3's
/// `('account','operator')` — see `0013`'s departure 1.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PrincipalKind {
    /// An account. §0: *"stewards hold the data."*
    Steward,
    /// A machine-side administrator. §1.3, §4.5.
    Operator,
}

impl PrincipalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Steward => "steward",
            Self::Operator => "operator",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "steward" => Some(Self::Steward),
            "operator" => Some(Self::Operator),
            _ => None,
        }
    }
}

/// Which key a failed sign-in is counted against in the account bucket
/// (`0014` §A).
///
/// **Both variants are counted and both land in the same bucket kind**, which
/// is the whole point: an address that resolves to an account and one that
/// resolves to nothing must cross the cap at the same attempt and change the
/// answer in the same way, or the rate limiter is an oracle over the
/// deployment's user list.
#[derive(Clone, Debug, PartialEq, Eq)]
enum AccountBucket {
    /// The account id the consumed bind nonce named.
    Account(String),
    /// The hex of [`claimed_address_key`], for an address that named none.
    ClaimedAddress(String),
}

impl AccountBucket {
    fn key(&self) -> &str {
        match self {
            Self::Account(id) => id,
            Self::ClaimedAddress(key) => key,
        }
    }
}

/// Which of a `sign_in_attempts` row's two latches is being taken.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Latch {
    /// `locked_entry_written` — this bucket crossed its cap.
    Locked,
    /// `anon_entry_written` — a refusal from this source with no account
    /// behind it (`0014` §B).
    Anonymous,
}

/// §4.3's assurance. `A1` is the only value anything writes today.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Assurance {
    /// A password-only session. **Nothing in this build produces one**: there
    /// is no password path anywhere (§4.5, §5.1). It exists because §4.3's
    /// rule is uniform and a reset-issued session will be recorded this way.
    A0,
    /// The session's holder signed a server challenge with an enrolled key.
    A1,
}

impl Assurance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::A0 => "A0",
            Self::A1 => "A1",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "A0" => Some(Self::A0),
            "A1" => Some(Self::A1),
            _ => None,
        }
    }
}

/// What a caller must present on every request that reaches a design payload
/// or vault ciphertext (§4.1 clause (b)).
pub struct SignedRequest<'a> {
    pub session_id: &'a str,
    pub method: &'a str,
    /// Path **and query**, exactly as signed. See [`request_bytes`].
    pub path: &'a str,
    pub body: &'a [u8],
    pub nonce: [u8; 32],
    pub unix_ms: i64,
    pub counter: i64,
    pub signature: [u8; 64],
}

/// A request whose single-use nonce has been spent and which is waiting to be
/// verified — inside the transaction that will also authorise it (`0014`,
/// finding 8).
///
/// **This is not an actor and cannot become one by itself.** Holding it proves
/// only that a nonce issued to some session id was fresh a moment ago; every
/// check that matters — the row's MAC, the account, the evidence key, the
/// clock, the counter and the signature — is still ahead of it, and
/// [`VerifiedSession`] is still what nothing but
/// [`SessionStore::verify_pending`] produces. It exists because a transaction
/// cannot be carried across an axum extractor, so the request has to be
/// carried instead.
///
/// It owns its fields rather than borrowing the request, for the same reason:
/// the `Request` it came from is gone by the time a handler runs.
pub struct PendingRequest {
    session_id: String,
    method: String,
    path: String,
    body_digest: [u8; 32],
    nonce: [u8; 32],
    unix_ms: i64,
    counter: i64,
    signature: [u8; 64],
    issued_counter: i64,
}

/// A session that has just proved itself on this request.
///
/// **Private fields, no public constructor, and no accessor that yields an
/// `AccountId`.** See the module header: this type is how §13 item 1 stops
/// being a sentence and starts being a shape.
#[derive(Clone, Debug)]
pub struct VerifiedSession {
    id: String,
    actor: AccountId,
    kind: PrincipalKind,
    assurance: Assurance,
    expires_at_unix: i64,
}

impl VerifiedSession {
    /// This session's own id — the value that was inside the signed bytes.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The principal, as text. **Deliberately not an `AccountId`**: the
    /// repository layer takes `AccountId`, and the only ways to hand it one
    /// derived from a session are [`open_tenant_context`] and
    /// [`account_without_tenant`] — named functions, so that every place a
    /// session becomes an actor is greppable.
    ///
    /// This returns text for logging, comparison and audit entries. Parsing
    /// it back into an `AccountId` is exactly the bypass those two functions
    /// exist to prevent; call one of them instead.
    pub fn principal_id(&self) -> String {
        self.actor.to_string()
    }

    pub fn kind(&self) -> PrincipalKind {
        self.kind
    }

    pub fn assurance(&self) -> Assurance {
        self.assurance
    }

    pub fn expires_at_unix(&self) -> i64 {
        self.expires_at_unix
    }
}

/// What sign-in hands back to the browser.
pub struct SignedIn {
    pub session_id: String,
    /// The bearer half, returned once and never stored in the clear.
    pub token: [u8; 32],
    pub expires_at_unix: i64,
}

impl core::fmt::Debug for SignedIn {
    /// **The token is not printed**, by the same rule `secret.rs` exists for
    /// and that `SoftwareKey`'s own `Debug` already follows: a type that can
    /// be formatted into a log line is a type whose `Debug` decides what ends
    /// up in one, and `{:?}` is reached for in a hurry.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SignedIn")
            .field("session_id", &self.session_id)
            .field("token", &"<not printed>")
            .field("expires_at_unix", &self.expires_at_unix)
            .finish()
    }
}

/// What a challenge request hands back. The client derives the challenge
/// itself with [`session_challenge`] — the server does not send it, so the two
/// assemblies of that message stay independent.
pub struct Challenge {
    pub nonce: [u8; 32],
    pub deployment_id: String,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything this layer refuses, and why.
///
/// **[`SessionError::SignInRefused`] is deliberately one variant for several
/// causes**: an address that belongs to no account, an account with no
/// enrolled key, a nonce that was never issued or has already been used, a
/// signature that does not verify, and a challenge bound to a different public
/// key all produce it. A caller who could tell those apart could enumerate
/// accounts. The sealed `account_signin_failed` entry carries the real reason,
/// where an operator can read it and an attacker cannot.
///
/// **One variant was not enough on its own, and `0014` §A is the fix.** The
/// uniform message was undone one layer up by [`SessionError::RateLimited`],
/// which only a real address could ever reach: the account bucket was counted
/// only for an address that resolved, so an unknown one answered the uniform
/// refusal for ever while a known one changed to a `429` with a `Retry-After`
/// header at the eleventh attempt. A refusal is uniform only if *every*
/// refusal this surface can produce is uniform, at every attempt, which is now
/// what `tests/sessions.rs` asserts rather than assuming from one try.
///
/// **What is closed and what is not, stated narrowly.** What is closed is the
/// answer: status, headers and body are identical for a known and an unknown
/// address at every attempt, below the cap and above it, tested over the wire.
/// What is **not** closed is how long the answer takes. An address that
/// resolves sends this code on to read `accounts`, resolve a live signing key,
/// verify that key's own row seal and verify an ES256 signature; an address
/// that resolves to nothing stops several steps earlier. That is a timing
/// difference of real size, it is not measured here, and it is not defended
/// against. Closing it means doing the same work either way — verifying a
/// signature against a decoy key for an address nobody holds — which changes
/// what sign-in *does* rather than what it answers, and is not this build's.
/// **Nothing here is a claim that sign-in is constant time.**
///
/// **[`SessionError::Unverifiable`] is NOT a permission error**, on §3.4's
/// argument: a row MAC that does not recompute means the store is not telling
/// the truth about itself, and rendering that as "please sign in again" would
/// teach nobody anything.
#[derive(Debug)]
pub enum SessionError {
    Db(tokio_postgres::Error),
    Pool(PoolError),
    Chain(ChainStoreError),
    Keys(KeyStoreError),
    Repo(RepoError),
    Authority(AuthorityError),
    /// A stored session row's MAC does not recompute under this deployment's
    /// site row key: it was written by something that does not hold the chain
    /// master. §4.3's second fence, caught.
    Unverifiable(&'static str),
    /// Sign-in did not succeed. One variant for every cause, on purpose.
    ///
    /// **`OperatorHasNoAuthenticator` was a variant here until `0015` and is
    /// deliberately gone.** It said, to an unauthenticated caller, that the
    /// operator plane had no key enrolled — which was harmless while no
    /// operator could exist at all and became an oracle the moment one could:
    /// an attacker walking operator ids would learn which of them have
    /// enrolled and which are still holding a token. §4.5 is unchanged and is
    /// kept by the code rather than by the error type: an operator session is
    /// `A1` or it does not exist, and there is no password path to fall back
    /// to.
    SignInRefused,
    /// Too many attempts in this window (§13 item 7).
    RateLimited {
        retry_after_seconds: i64,
    },
    /// No live session with that id.
    NoSuchSession,
    /// This session id is in `session_revocations`: it was signed out, and the
    /// row presenting itself now is one a restore put back (`0014` §D).
    ///
    /// **Rendered exactly as [`SessionError::NoSuchSession`]** — a signed-out
    /// session and an unknown one are one answer from outside — but kept as
    /// its own variant so that the log line an operator reads says which of
    /// the two it was, and so that a test can tell them apart.
    SessionRevoked,
    /// The request carried no signature at all, or one this layer could not
    /// even parse.
    ///
    /// **Not [`SessionError::Malformed`]**: a caller who presented nothing is
    /// not a caller who got the protocol wrong, and the answer they need is
    /// "authenticate", not "your bytes are bad". A caller who presented
    /// something unparseable gets the same answer, because telling the two
    /// apart tells an attacker which header they got right.
    NotSigned,
    /// The session's own lifetime has run out.
    Expired,
    /// The account this session belongs to has been disabled.
    AccountDisabled,
    /// The key that proved this session's assurance is no longer in service:
    /// retired or superseded. The session stops at its next request.
    EvidenceKeyNotInService,
    /// The nonce was never issued, has already been consumed, has expired, or
    /// belongs to another session. **All four are one variant**: they are the
    /// same fact from the verifier's side — this request carries no fresh,
    /// single-use proof of liveness.
    NonceNotFresh,
    /// The request's own timestamp is outside [`CLOCK_SKEW`].
    ClockSkew {
        by_seconds: i64,
    },
    /// The counter did not advance past the value recorded when the nonce was
    /// issued, or it ran further than [`COUNTER_WINDOW`] past it.
    ///
    /// **Both directions are one variant.** They are the same fact from the
    /// verifier's side — this request's counter is not the next one — and
    /// telling them apart would tell a caller what the stored mark is.
    CounterNotFresh,
    /// The per-request signature was refused, with `authority`'s reason.
    Signature(SignatureRefused),
    /// This session already holds [`MAX_OUTSTANDING_NONCES`] unconsumed
    /// nonces.
    TooManyNonces,
    /// An operator session cannot open a tenant context: an operator principal
    /// is unrepresentable in a membership (§2, `0004`).
    NotATenantPrincipal,
    /// A field of a message was not the shape it must be.
    Malformed(&'static str),
    /// A stored row does not decode as what its column says it is.
    Corrupt(&'static str),
}

impl core::fmt::Display for SessionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Pool(_) => f.write_str("no database connection was available"),
            Self::Chain(e) => write!(f, "{e}"),
            Self::Keys(e) => write!(f, "{e}"),
            Self::Repo(e) => write!(f, "{e}"),
            Self::Authority(e) => write!(f, "{e}"),
            Self::Unverifiable(what) => write!(
                f,
                "the {what} does not verify under this deployment's chain key, so it was not \
                 written by this server. This is not a permission error and must never render \
                 as one"
            ),
            Self::SignInRefused => f.write_str(
                "sign-in refused. One message for every cause, so that an attacker cannot tell \
                 an unknown address from a wrong signature; the sealed entry carries the reason",
            ),
            Self::RateLimited {
                retry_after_seconds,
            } => write!(
                f,
                "too many sign-in attempts; this window closes in {retry_after_seconds} seconds"
            ),
            Self::NoSuchSession => f.write_str("no live session with that id"),
            Self::SessionRevoked => f.write_str(
                "this session was signed out and is recorded as signed out, so the row \
                 presenting itself now is one something put back",
            ),
            Self::NotSigned => f.write_str(
                "this route serves only signed requests: §4.1 clause (b), a fresh signature by \
                 the key this session's browser holds",
            ),
            Self::Expired => f.write_str("this session has expired; sign in again"),
            Self::AccountDisabled => f.write_str("this account is disabled"),
            Self::EvidenceKeyNotInService => f.write_str(
                "the key that proved this session is no longer in service, so the session stops \
                 here rather than outliving the key that established it",
            ),
            Self::NonceNotFresh => f.write_str(
                "this request carries no fresh single-use nonce: it was never issued, has \
                 already been used, has expired, or belongs to another session",
            ),
            Self::ClockSkew { by_seconds } => write!(
                f,
                "this request's own timestamp is {by_seconds} seconds from this server's clock"
            ),
            Self::CounterNotFresh => f.write_str(
                "the request counter is not the next one: it did not advance past the issued \
                 nonce's mark, or it ran further than a window past it",
            ),
            Self::Signature(e) => write!(f, "{e}"),
            Self::TooManyNonces => write!(
                f,
                "this session already holds {MAX_OUTSTANDING_NONCES} unused nonces"
            ),
            Self::NotATenantPrincipal => f.write_str(
                "an operator session cannot open a tenant context: an operator principal is \
                 unrepresentable in a membership at every privilege level",
            ),
            Self::Malformed(what) => write!(f, "the {what} is not the shape it must be"),
            Self::Corrupt(what) => write!(f, "a stored {what} is not consistent"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<tokio_postgres::Error> for SessionError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}
impl From<PoolError> for SessionError {
    fn from(e: PoolError) -> Self {
        Self::Pool(e)
    }
}
impl From<ChainStoreError> for SessionError {
    fn from(e: ChainStoreError) -> Self {
        Self::Chain(e)
    }
}
impl From<KeyStoreError> for SessionError {
    fn from(e: KeyStoreError) -> Self {
        Self::Keys(e)
    }
}
impl From<RepoError> for SessionError {
    fn from(e: RepoError) -> Self {
        Self::Repo(e)
    }
}
impl From<AuthorityError> for SessionError {
    fn from(e: AuthorityError) -> Self {
        Self::Authority(e)
    }
}
impl From<SignatureRefused> for SessionError {
    fn from(e: SignatureRefused) -> Self {
        Self::Signature(e)
    }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/// Everything the session layer needs, carried together for the same reason
/// `grants::Authority` is: each field is a control, and passing them as one
/// value means a new path cannot be written that quietly omits one.
pub struct SessionStore {
    pool: Pool,
    ring: Arc<KeyRing>,
    /// `0009`'s one-row deployment identity. Inside every challenge, so a
    /// challenge from one deployment is a challenge nowhere else.
    deployment: String,
    limits: SignInLimits,
    lifetime: Duration,
}

impl SessionStore {
    pub fn new(pool: Pool, ring: Arc<KeyRing>, deployment: String, limits: SignInLimits) -> Self {
        Self::with_lifetime(pool, ring, deployment, limits, SESSION_LIFETIME)
    }

    /// As [`SessionStore::new`], with a lifetime other than
    /// [`SESSION_LIFETIME`].
    ///
    /// **The lifetime is a property of the store rather than a constant read
    /// at the point of use**, because otherwise the only way to observe an
    /// expiry is to move `expires_at` in SQL — which breaks the row MAC, so
    /// the test proves the MAC and never the expiry. Two separate claims need
    /// two separate ways to reach them.
    pub fn with_lifetime(
        pool: Pool,
        ring: Arc<KeyRing>,
        deployment: String,
        limits: SignInLimits,
        lifetime: Duration,
    ) -> Self {
        Self {
            pool,
            ring,
            deployment,
            limits,
            lifetime,
        }
    }

    pub fn deployment(&self) -> &str {
        &self.deployment
    }

    pub fn limits(&self) -> SignInLimits {
        self.limits
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    // -----------------------------------------------------------------------
    // Sign-in
    // -----------------------------------------------------------------------

    /// Issue §4.2's `server_nonce` for a sign-in, bound to the public key the
    /// browser is asking to register.
    ///
    /// **The answer is the same shape for an address that belongs to no
    /// account.** A nonce row is written either way — with no principal, which
    /// the composite foreign key permits because it is not enforced when a
    /// column of it is NULL — so the response cannot be used to enumerate
    /// accounts. The refusal happens at [`SessionStore::sign_in`], after the
    /// attempt has been counted.
    ///
    /// # Two things `0014` changed here
    ///
    /// 1. **The route is rate limited against the source bucket.** It was not,
    ///    and it writes a row: one anonymous POST was one permanent
    ///    `session_nonces` row, since nothing swept and the only deletes
    ///    matched one exact nonce. It costs one count, so a complete sign-in
    ///    costs two against `max_per_source` — see [`SignInLimits::defaults`].
    /// 2. **The claimed address's keyed hash travels on the nonce row**
    ///    ([`claimed_address_key`], `0014` §A), for every bind nonce and not
    ///    only for the ones that resolve to nothing. §4.2 deliberately keeps
    ///    the address out of the sign-in message, so this is the only place it
    ///    is known; without it the account bucket cannot be counted for an
    ///    address that belongs to nobody, and that asymmetry was an oracle
    ///    over the deployment's user list.
    pub async fn issue_challenge(
        &self,
        kind: PrincipalKind,
        address: &str,
        session_pubkey: &[u8],
        source: &str,
    ) -> Result<Challenge, SessionError> {
        check_public_key(session_pubkey)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;

        // Expired rows first, so the table this is about to write to is the
        // one that pays for its own growth (`0014` §C).
        sweep_expired_nonces(&tx).await?;

        let source_count = self
            .count_attempt(&tx, "source", source)
            .await?
            .unwrap_or(0);
        if source_count > self.limits.max_per_source {
            let e = self
                .refuse(&tx, None, source, "rate_limited_source", kind)
                .await;
            leave_session_custody(&tx).await?;
            tx.commit().await?;
            return Err(e);
        }

        // **What an operator types in the address box is their operator id**,
        // and the resolution is the same shape either way: a string that names
        // nobody produces a nonce with no principal, byte-identical to one
        // that does, and the refusal happens at sign-in after the attempt has
        // been counted.
        //
        // §4.5 gives an operator no address of record — there is no reset path
        // to send anything to — so there is nothing else to resolve them by.
        // The id is not a secret and is not treated as one: it is the operator
        // plane's equivalent of an address, and possession of the enrolled
        // private key is the whole of the factor.
        let principal = match kind {
            PrincipalKind::Steward => account_by_address(&tx, address).await?,
            PrincipalKind::Operator => operator_by_id(&tx, address).await?,
        };
        let claimed = claimed_address_key(&grants::site_chain_key(&tx, &self.ring).await?, address);

        let nonce = random_32()?;
        tx.execute(
            "INSERT INTO session_nonces \
                 (nonce, purpose, session_pubkey, principal_id, principal_kind, \
                  claimed_address_key, expires_at) \
             VALUES ($1, 'bind', $2, $3, $4, $5, now() + make_interval(secs => $6))",
            &[
                &nonce.to_vec(),
                &session_pubkey.to_vec(),
                &principal,
                &principal.as_ref().map(|_| kind.as_str()),
                &claimed.to_vec(),
                &(NONCE_LIFETIME.as_secs() as f64),
            ],
        )
        .await?;

        leave_session_custody(&tx).await?;
        tx.commit().await?;

        Ok(Challenge {
            nonce,
            deployment_id: self.deployment.clone(),
        })
    }

    /// §4.2's binding, completed: the account proves possession of an enrolled
    /// signing key by signing the challenge that also binds the fresh session
    /// public key.
    ///
    /// # The order, and why it is not arbitrary
    ///
    /// 1. **The source bucket is counted first**, before anything is looked
    ///    up, so an attacker who sends nothing but rubbish is still rate
    ///    limited.
    /// 2. **The nonce is consumed next**, by `DELETE ... RETURNING`. Consumed
    ///    means consumed: a failed attempt burns it, which is the fail-closed
    ///    direction.
    /// 3. The account, its disabled flag, its live signing key and that key's
    ///    own row seal.
    /// 4. The evidence signature, over the challenge recomputed from the
    ///    stored nonce and the public key the caller is asking to register —
    ///    **never from anything the caller sent alongside it**.
    /// 5. The sealed `account_signin` entry, and only then the row, whose MAC
    ///    covers that entry's `seq`. No entry, no session.
    ///
    /// Every refusal between (2) and (5) is counted against the account bucket
    /// and written to the site chain with its real reason.
    ///
    /// **There is no address in this message.** The account is the one the
    /// consumed nonce names, and the nonce was issued against an address the
    /// caller gave at [`SessionStore::issue_challenge`]. Taking the address
    /// again here would be a second, unbound statement of who is signing in —
    /// exactly the shape §3.8 item 7 calls out for grant proposals, where
    /// anything the client returns that is not inside the signed bytes must be
    /// re-derived rather than believed.
    pub async fn sign_in(
        &self,
        kind: PrincipalKind,
        session_pubkey: &[u8],
        nonce: &[u8; 32],
        evidence_sig: &[u8],
        source: &str,
    ) -> Result<SignedIn, SessionError> {
        check_public_key(session_pubkey)?;
        if evidence_sig.len() != authority::SIGNATURE_LEN {
            return Err(SessionError::Malformed("evidence signature"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;

        // Expired rows first — this call writes to all three session tables
        // and each pays for its own growth (`0014` §C).
        sweep_expired_nonces(&tx).await?;
        sweep_expired_sessions(&tx).await?;

        // (1) The source bucket counts every attempt, not only the failures.
        // **Both buckets are rate limits and neither is a lockout** — `0014`
        // §0 carries the decision and [`SignInLimits::defaults`] carries the
        // argument. What differs is not their nature but when they are
        // consulted: the source bucket before anything is looked up, the
        // account bucket on a path that has already failed.
        let source_count = self
            .count_attempt(&tx, "source", source)
            .await?
            .unwrap_or(0);
        if source_count > self.limits.max_per_source {
            let e = self
                .refuse(&tx, None, source, "rate_limited_source", kind)
                .await;
            leave_session_custody(&tx).await?;
            tx.commit().await?;
            return Err(e);
        }

        let outcome = self
            .attempt_sign_in(&tx, kind, session_pubkey, nonce, evidence_sig)
            .await;

        let result = match outcome {
            Ok(signed_in) => {
                // A success clears this window's failures for the account, so
                // a person who mistypes twice and then succeeds is not one
                // mistake away from a lockout for the next quarter of an hour.
                tx.execute(
                    "UPDATE sign_in_attempts SET attempts = 0 \
                      WHERE bucket_kind = 'account' AND bucket_key = $1 \
                        AND window_start = $2",
                    &[&signed_in.0, &window_start(self.limits.window)],
                )
                .await?;
                Ok(signed_in.1)
            }
            Err((bucket, reason, error)) => {
                let counted = self
                    .refuse(&tx, bucket.as_ref(), source, reason, kind)
                    .await;
                // A rate-limit refusal outranks the underlying reason: the
                // caller must be told to wait rather than to try again.
                Err(match counted {
                    SessionError::RateLimited { .. } => counted,
                    _ => error,
                })
            }
        };

        leave_session_custody(&tx).await?;
        tx.commit().await?;
        result
    }

    /// The part of [`SessionStore::sign_in`] that can fail without the
    /// transaction being poisoned. Returns the bucket the failure belongs to
    /// alongside the error, so it can be counted against the right one.
    #[allow(clippy::type_complexity)]
    async fn attempt_sign_in(
        &self,
        tx: &Transaction<'_>,
        kind: PrincipalKind,
        session_pubkey: &[u8],
        nonce: &[u8; 32],
        evidence_sig: &[u8],
    ) -> Result<(String, SignedIn), (Option<AccountBucket>, &'static str, SessionError)> {
        // (2) Consume the nonce. `DELETE ... RETURNING` is the whole of
        // "single use": no row back means it was never issued, has already
        // been used, or has expired, and those are one fact from here.
        let consumed = tx
            .query_opt(
                "DELETE FROM session_nonces \
                  WHERE nonce = $1 AND purpose = 'bind' AND expires_at > now() \
                  RETURNING session_pubkey, principal_id, principal_kind, claimed_address_key",
                &[&nonce.to_vec()],
            )
            .await
            .map_err(|e| (None, "database", SessionError::Db(e)))?;
        let Some(consumed) = consumed else {
            // **No bucket, and that is not a hole.** A nonce that was never
            // issued names no claimed identity at all, so there is nothing to
            // count it against — and a known address and an unknown one reach
            // this branch identically, which is the property that matters.
            // The source bucket has already counted the attempt.
            return Err((None, "nonce_not_fresh", SessionError::SignInRefused));
        };

        // Which bucket this attempt belongs to, decided before anything can
        // fail: the account the nonce named, or — when it named none — the
        // keyed hash of the address that was claimed (`0014` §A). **Both are
        // counted.** Counting only the first was the account oracle.
        let principal: Option<String> = consumed.get(1);
        let claimed: Option<Vec<u8>> = consumed.get(3);
        let bucket = match (&principal, &claimed) {
            (Some(account), _) => Some(AccountBucket::Account(account.clone())),
            (None, Some(key)) => Some(AccountBucket::ClaimedAddress(hex(key))),
            (None, None) => None,
        };

        // The challenge is derived over the key the nonce was issued for. A
        // caller who asks to register a different key than the one they asked
        // a challenge for is refused here, which is §4.2's *"the assertion is
        // accepted only if the challenge inside it recomputes from the
        // session_pubkey the client is asking to register"*.
        let bound_pubkey: Vec<u8> = consumed.get(0);
        if bound_pubkey != session_pubkey {
            return Err((
                bucket,
                "pubkey_not_the_bound_one",
                SessionError::SignInRefused,
            ));
        }

        let principal_kind: Option<String> = consumed.get(2);
        let Some(account) = principal else {
            // The claimed identity — an address on the account plane, an
            // operator id on the operator plane — resolved to nobody. One
            // answer for both planes and for both reasons.
            return Err((bucket, "no_such_principal", SessionError::SignInRefused));
        };
        if principal_kind.as_deref() != Some(kind.as_str()) {
            return Err((
                Some(AccountBucket::Account(account)),
                "principal_kind_mismatch",
                SessionError::SignInRefused,
            ));
        }

        // (3) The principal, whether it may sign in at all, and the key it
        // signs with. **Two planes, one shape.** An account has a disabled
        // flag and a keyring row; an operator has a disabled flag, a keyring
        // row of its own, and one check an account does not need — that the
        // register row itself verifies. Every refusal below is the refusal the
        // other plane gives, so the two cannot be told apart from outside.
        let now = now_unix();
        let key: SignInKey = match kind {
            PrincipalKind::Steward => {
                let disabled = tx
                    .query_opt(
                        "SELECT disabled_at IS NOT NULL FROM accounts WHERE id = $1",
                        &[&account],
                    )
                    .await
                    .map_err(|e| {
                        (
                            Some(AccountBucket::Account(account.clone())),
                            "database",
                            SessionError::Db(e),
                        )
                    })?;
                match disabled {
                    Some(row) if row.get::<_, bool>(0) => {
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "account_disabled",
                            SessionError::SignInRefused,
                        ))
                    }
                    Some(_) => {}
                    None => {
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "no_such_account",
                            SessionError::SignInRefused,
                        ))
                    }
                }

                // `account_keys` is read through a policy that shows an account
                // its own rows when `app.account_id` names it. Sign-in is
                // exactly that case: the account is the one the consumed nonce
                // named, never one the caller supplied.
                set_account_id(tx, &account)
                    .await
                    .map_err(|e| (Some(AccountBucket::Account(account.clone())), "database", e))?;
                match grants::live_signing_key(tx, &self.ring, &account, now).await {
                    Ok(key) => SignInKey {
                        id: key.id,
                        public_key: key.public_key,
                        fpr: key.fpr,
                    },
                    Err(AuthorityError::NoSigningKey) => {
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "no_signing_key",
                            SessionError::SignInRefused,
                        ))
                    }
                    Err(e @ AuthorityError::Unverifiable(_)) => {
                        // An integrity alarm, not a sign-in failure: say so
                        // rather than folding it into the uniform refusal.
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "keyring_unverifiable",
                            e.into(),
                        ));
                    }
                    Err(e) => {
                        return Err((Some(AccountBucket::Account(account)), "keyring", e.into()))
                    }
                }
            }
            PrincipalKind::Operator => {
                // **The register row is verified, not merely read.**
                // `operators::verify_operator_row` recomputes its seal AND
                // checks the site-chain entry that created it — §5.4's
                // interlock applied to the register itself, so an operator row
                // minted by whoever holds the database cannot sign in.
                let row = match operators::verify_operator_row(tx, &self.ring, &account).await {
                    Ok(row) => row,
                    Err(operators::OperatorError::Unverifiable(what)) => {
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "operator_row_unverifiable",
                            SessionError::Unverifiable(what),
                        ))
                    }
                    Err(_) => {
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "no_such_operator",
                            SessionError::SignInRefused,
                        ))
                    }
                };
                if row.disabled_at_unix != 0 {
                    return Err((
                        Some(AccountBucket::Account(account)),
                        "operator_disabled",
                        SessionError::SignInRefused,
                    ));
                }
                match operators::live_operator_key(tx, &self.ring, &account, now).await {
                    Ok(key) => SignInKey {
                        id: key.id,
                        public_key: key.public_key,
                        fpr: key.fpr,
                    },
                    Err(operators::OperatorError::Unverifiable(what)) => {
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "operator_keyring_unverifiable",
                            SessionError::Unverifiable(what),
                        ))
                    }
                    Err(_) => {
                        // §4.5: an operator session is `A1` or it does not
                        // exist. No key, no session, and no weaker factor to
                        // fall back to.
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "no_signing_key",
                            SessionError::SignInRefused,
                        ));
                    }
                }
            }
        };

        // (4) The evidence signature.
        let challenge = session_challenge(session_pubkey, nonce, &self.deployment);
        if let Err(refused) = authority::verify_es256(&key.public_key, &challenge, evidence_sig) {
            let _ = refused;
            return Err((
                Some(AccountBucket::Account(account)),
                "evidence_signature",
                SessionError::SignInRefused,
            ));
        }

        // (5) The entry first, then the row whose MAC covers its seq.
        let id = ids::new_ulid().to_string();
        let token = random_32()
            .map_err(|e| (Some(AccountBucket::Account(account.clone())), "random", e))?;
        let digest = evidence_digest(&challenge, evidence_sig);
        // §7.2 names both, and which one this is is the one fact a reader of
        // the site chain can group by without holding the metadata key.
        let entry_type = match kind {
            PrincipalKind::Steward => EntryType::AccountSignin,
            PrincipalKind::Operator => EntryType::OperatorSignin,
        };
        let appended = chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            entry_type,
            &entry_metadata(
                entry_type,
                &[
                    ("account", Json::Str(account.clone())),
                    ("session", Json::Str(id.clone())),
                    ("principal_kind", Json::Str(kind.as_str().to_string())),
                    ("assurance", Json::Str(Assurance::A1.as_str().to_string())),
                    ("evidence_key", Json::Str(key.id.clone())),
                    ("key_fpr", Json::Str(hex(&key.fpr))),
                ],
            ),
        )
        .await
        .map_err(|e| {
            (
                Some(AccountBucket::Account(account.clone())),
                "chain",
                e.into(),
            )
        })?;

        // Not a client-supplied number — the clock and a constant — and
        // checked anyway, because the audit that found the timestamp panic
        // looked for every addition on this path and a reader doing that again
        // should not have to work out which ones are safe.
        let expires_at_unix = now.saturating_add(self.lifetime.as_secs() as i64);
        let row = SessionRow {
            id: id.clone(),
            principal_id: account.clone(),
            principal_kind: kind,
            token_hash: token_hash(&token),
            session_pubkey: session_pubkey.to_vec(),
            bound_nonce: *nonce,
            evidence_key_id: Some(key.id.clone()),
            evidence_sig: Some(evidence_sig.to_vec()),
            assertion_digest: Some(digest),
            assurance: Assurance::A1,
            chain_seq: appended.seq,
            row_version: 1,
            issued_at_unix: now,
            expires_at_unix,
            request_counter: 0,
        };
        let mac = self
            .row_mac(tx, &row)
            .await
            .map_err(|e| (Some(AccountBucket::Account(account.clone())), "row mac", e))?;

        // §5.5's *"the seconder has an independent sign-in on record"*, taken
        // once, on the operator plane only. It is recorded here rather than at
        // the console because what §5.5 is asking about is a sign-in, and this
        // is the only place one happens.
        if kind == PrincipalKind::Operator {
            operators::note_first_signin(tx, &account)
                .await
                .map_err(|_| {
                    (
                        Some(AccountBucket::Account(account.clone())),
                        "database",
                        SessionError::Corrupt("operator register"),
                    )
                })?;
        }

        // **One value, two columns, two foreign keys** (`0015` §B2). The key
        // that proved this session is in `account_keys` or in `operator_keys`,
        // never both, and referential integrity is the only mechanism that
        // answers "does it exist" the same way for every caller — a trigger
        // reading either keyring answers "is it visible to me", which is a
        // different question and was the wrong one.
        //
        // `row.evidence_key_id` is still the single value the MAC covers, so
        // `session_row_state` and its pinned vectors are untouched.
        let (account_evidence, operator_evidence) = match kind {
            PrincipalKind::Steward => (row.evidence_key_id.clone(), None),
            PrincipalKind::Operator => (None, row.evidence_key_id.clone()),
        };
        tx.execute(
            "INSERT INTO sessions \
                 (id, principal_id, principal_kind, token_hash, session_pubkey, session_alg, \
                  bound_nonce, evidence_key_id, evidence_sig, assertion_digest, assurance, \
                  chain_seq, issued_at, last_seen_at, expires_at, row_version, row_mac, \
                  evidence_operator_key_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, \
                     to_timestamp($13), to_timestamp($13), to_timestamp($14), 1, $15, $16)",
            &[
                &row.id,
                &row.principal_id,
                &row.principal_kind.as_str(),
                &row.token_hash.to_vec(),
                &row.session_pubkey,
                &authority::ALG_ES256,
                &row.bound_nonce.to_vec(),
                &account_evidence,
                &row.evidence_sig,
                &row.assertion_digest.map(|d| d.to_vec()),
                &row.assurance.as_str(),
                &row.chain_seq,
                &(row.issued_at_unix as f64),
                &(row.expires_at_unix as f64),
                &mac.to_vec(),
                &operator_evidence,
            ],
        )
        .await
        .map_err(|e| {
            (
                Some(AccountBucket::Account(account.clone())),
                "database",
                SessionError::Db(e),
            )
        })?;

        Ok((
            account,
            SignedIn {
                session_id: id,
                token,
                expires_at_unix,
            },
        ))
    }

    /// Count a failure against its account bucket, write the sealed entry if
    /// this is the refusal that gets to record itself, and say whether the
    /// bucket has now closed.
    ///
    /// # Which refusals write an entry, and why not all of them
    ///
    /// `0013` §D's rule was *"once per window rather than once per refused
    /// request"*, and the latch that implemented it was taken only when a
    /// bucket had already closed. For an ANONYMOUS failure no account bucket
    /// was counted at all, so nothing ever closed and an entry was appended on
    /// every attempt: an unauthenticated caller chose how fast this
    /// deployment's sealed audit grew, which is the amplifier the rule exists
    /// to prevent. Counting a claimed-address bucket (`0014` §A) does not fix
    /// it on its own — the attacker varies the address and gets a fresh
    /// bucket, a fresh cap and a fresh run of entries.
    ///
    /// So there are three cases, in this order:
    ///
    /// 1. **The source cap itself.** `locked_entry_written` on the source row:
    ///    one entry per (source, window), which is the fact an operator wants.
    /// 2. **Any other anonymous failure** — no account resolved, whether the
    ///    address was unknown or the nonce named nobody. `anon_entry_written`
    ///    on the source row: at most one entry per (source, window) however
    ///    many addresses are sprayed through it.
    /// 3. **A failure against a resolved account.** One entry per attempt up
    ///    to that account's cap, then one more when the cap closes. Bounded by
    ///    the account bucket, and an attacker cannot inflate it without
    ///    holding the address — which is a signal worth keeping.
    async fn refuse(
        &self,
        tx: &Transaction<'_>,
        bucket: Option<&AccountBucket>,
        source: &str,
        reason: &'static str,
        kind: PrincipalKind,
    ) -> SessionError {
        let mut locked = false;
        let mut latched = false;
        if let Some(bucket) = bucket {
            // A counter that could not be written is not a reason to let the
            // attempt through un-refused: the refusal below stands either way,
            // and only the rate limit is lost.
            if let Ok(Some(count)) = self.count_attempt(tx, "account", bucket.key()).await {
                locked = count > self.limits.max_per_account;
                if locked {
                    latched = matches!(
                        self.latch(tx, "account", bucket.key(), Latch::Locked).await,
                        Ok(true)
                    );
                }
            }
        }
        let source_cap = reason == "rate_limited_source";
        if source_cap {
            locked = true;
            latched = matches!(
                self.latch(tx, "source", source, Latch::Locked).await,
                Ok(true)
            );
        }

        let anonymous = !matches!(bucket, Some(AccountBucket::Account(_)));
        let write_entry = if source_cap {
            latched
        } else if anonymous {
            matches!(
                self.latch(tx, "source", source, Latch::Anonymous).await,
                Ok(true)
            )
        } else {
            !locked || latched
        };

        if write_entry {
            let entry_type = match kind {
                PrincipalKind::Steward => EntryType::AccountSigninFailed,
                PrincipalKind::Operator => EntryType::OperatorSigninFailed,
            };
            let metadata = entry_metadata(
                entry_type,
                &[
                    (
                        "account",
                        match bucket {
                            Some(AccountBucket::Account(a)) => Json::Str(a.clone()),
                            _ => Json::Null,
                        },
                    ),
                    // The keyed hash and never the address (`0014` §A): an
                    // operator can group a spray by it, and it is not a list
                    // of what people typed.
                    (
                        "claimed_address_key",
                        match bucket {
                            Some(AccountBucket::ClaimedAddress(k)) => Json::Str(k.clone()),
                            _ => Json::Null,
                        },
                    ),
                    ("reason", Json::Str(reason.to_string())),
                    ("principal_kind", Json::Str(kind.as_str().to_string())),
                    ("rate_limited", Json::Bool(locked)),
                ],
            );
            let _ =
                chains::append_site(tx, &self.ring, &self.deployment, entry_type, &metadata).await;
        }

        if locked {
            SessionError::RateLimited {
                retry_after_seconds: seconds_left_in_window(self.limits.window),
            }
        } else {
            SessionError::SignInRefused
        }
    }

    /// Increment one bucket's counter for the current window and return the
    /// new count.
    async fn count_attempt(
        &self,
        tx: &Transaction<'_>,
        bucket_kind: &str,
        bucket_key: &str,
    ) -> Result<Option<i32>, SessionError> {
        // A source key longer than the column allows is truncated rather than
        // refused: the bucket is a bucket, and an oversized value is still
        // usefully grouped by its first 128 characters.
        let key: String = bucket_key.chars().take(128).collect();
        if key.is_empty() {
            return Ok(None);
        }
        // The table pays for its own growth (`0014` §C): one row per (bucket,
        // window) accumulated for ever, and `0013` §F had taken DELETE away on
        // the argument that nothing would ever want it.
        self.sweep_old_attempts(tx).await?;
        let row = tx
            .query_one(
                "INSERT INTO sign_in_attempts (bucket_kind, bucket_key, window_start, attempts) \
                 VALUES ($1, $2, $3, 1) \
                 ON CONFLICT (bucket_kind, bucket_key, window_start) \
                 DO UPDATE SET attempts = sign_in_attempts.attempts + 1 \
                 RETURNING attempts",
                &[&bucket_kind, &key, &window_start(self.limits.window)],
            )
            .await?;
        Ok(Some(row.get(0)))
    }

    /// Take one of this window's "the entry has been written" latches. `true`
    /// means this call took it, so this is the one refusal that records
    /// itself.
    ///
    /// **The column is chosen from a closed set and never interpolated from a
    /// string a caller supplied** — [`Latch`] has two values and no `From<&str>`
    /// — because the only reason this statement cannot take the column name as
    /// a parameter is that SQL does not allow it, and "so we concatenated it"
    /// is how the next injection gets written.
    async fn latch(
        &self,
        tx: &Transaction<'_>,
        bucket_kind: &str,
        bucket_key: &str,
        which: Latch,
    ) -> Result<bool, SessionError> {
        let key: String = bucket_key.chars().take(128).collect();
        let statement = match which {
            Latch::Locked => {
                "UPDATE sign_in_attempts SET locked_entry_written = true \
                  WHERE bucket_kind = $1 AND bucket_key = $2 AND window_start = $3 \
                    AND NOT locked_entry_written \
                  RETURNING true"
            }
            Latch::Anonymous => {
                "UPDATE sign_in_attempts SET anon_entry_written = true \
                  WHERE bucket_kind = $1 AND bucket_key = $2 AND window_start = $3 \
                    AND NOT anon_entry_written \
                  RETURNING true"
            }
        };
        let row = tx
            .query_opt(
                statement,
                &[&bucket_kind, &key, &window_start(self.limits.window)],
            )
            .await?;
        Ok(row.is_some())
    }

    /// `0014` §C's sweep of `sign_in_attempts`.
    ///
    /// A row for a window that has already closed can never be counted again —
    /// [`window_start`] is computed from the clock — so it is dead weight from
    /// the moment the window turns over.
    async fn sweep_old_attempts(&self, tx: &Transaction<'_>) -> Result<(), SessionError> {
        tx.execute(
            "DELETE FROM sign_in_attempts a \
              USING (SELECT bucket_kind, bucket_key, window_start \
                       FROM sign_in_attempts \
                      WHERE window_start < $1 \
                      ORDER BY window_start \
                      LIMIT $2) d \
              WHERE a.bucket_kind = d.bucket_kind \
                AND a.bucket_key = d.bucket_key \
                AND a.window_start = d.window_start",
            &[&window_start(self.limits.window), &SWEEP_BATCH],
        )
        .await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Nonces and the per-request proof
    // -----------------------------------------------------------------------

    /// Issue a single-use nonce for one live session.
    ///
    /// **Authenticated by the bearer token and not by a signature**, because a
    /// signature needs a nonce and the client has none yet. That is the whole
    /// of what the token buys, and it buys nothing else: a nonce authorises
    /// nothing on its own.
    pub async fn issue_request_nonce(
        &self,
        session_id: &str,
        token: &[u8],
    ) -> Result<[u8; 32], SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;

        // This call writes a nonce row, so it sweeps expired ones (`0014` §C).
        sweep_expired_nonces(&tx).await?;

        let row = read_session(&tx, session_id).await?;
        let Some(row) = row else {
            return Err(SessionError::NoSuchSession);
        };
        if is_revoked(&tx, &row.id).await? {
            return Err(SessionError::SessionRevoked);
        }
        // The MAC first: a row this server did not write is not a session, and
        // handing it a nonce would be answering a question about a forgery.
        self.check_row_mac(&tx, &row).await?;
        if !same_bytes(&token_hash(token), &row.token_hash)? {
            // The same error as an unknown session id, so a wrong token and a
            // wrong id are one answer from outside.
            return Err(SessionError::NoSuchSession);
        }
        if row.expires_at_unix <= now_unix() {
            delete_session(&tx, &row.id).await?;
            leave_session_custody(&tx).await?;
            tx.commit().await?;
            return Err(SessionError::Expired);
        }

        let outstanding: i64 = tx
            .query_one(
                "SELECT count(*) FROM session_nonces \
                  WHERE session_id = $1 AND expires_at > now()",
                &[&row.id],
            )
            .await?
            .get(0);
        if outstanding >= MAX_OUTSTANDING_NONCES {
            return Err(SessionError::TooManyNonces);
        }

        let nonce = random_32()?;
        tx.execute(
            "INSERT INTO session_nonces \
                 (nonce, purpose, session_id, issued_counter, expires_at) \
             VALUES ($1, 'request', $2, $3, now() + make_interval(secs => $4))",
            &[
                &nonce.to_vec(),
                &row.id,
                &row.request_counter,
                &(NONCE_LIFETIME.as_secs() as f64),
            ],
        )
        .await?;

        leave_session_custody(&tx).await?;
        tx.commit().await?;
        Ok(nonce)
    }

    /// **Step one of §4.1 clause (b): spend the nonce, in a transaction of its
    /// own that commits.**
    ///
    /// # Why this is separate from the rest, since `0014`
    ///
    /// Verification used to run whole in its own committed transaction, and
    /// `api.rs` then opened a *second* one for `open_tenant_context` and
    /// `authorise_account`. The disabled-account check, the evidence-key check
    /// and grant evaluation therefore never shared a snapshot: an account
    /// disabled, or a key retired, or a grant revoked between the two commits
    /// was checked against one state and authorised against another. §3.4's
    /// seven steps and §4's *"before setting `app.design_capability`"* both
    /// read as one continuous act; they were two.
    ///
    /// The rest of verification moved into the caller's transaction
    /// ([`SessionStore::verify_pending`]) so that it and authorisation share a
    /// snapshot. The nonce did **not** move, because the reason it committed
    /// separately is still true: a request whose handler fails must not leave
    /// a replayable nonce behind, and a handler that rolls its own transaction
    /// back must not roll back the fact that this nonce has been spent. Nonce
    /// freshness is an atomic claim about a single row, not a fact about a
    /// consistent view of several tables, so it loses nothing by standing
    /// apart.
    ///
    /// **The bounds come first, before the pool is even touched.** A timestamp
    /// or counter outside [`MIN_UNIX_MS`]`..=`[`MAX_UNIX_MS`] is refused here,
    /// so nothing further down ever arithmetics on a number a client chose to
    /// make overflow.
    pub async fn begin_request(
        &self,
        request: &SignedRequest<'_>,
    ) -> Result<PendingRequest, SessionError> {
        check_unix_ms(request.unix_ms)?;
        if request.counter < 0 {
            return Err(SessionError::CounterNotFresh);
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;
        sweep_expired_nonces(&tx).await?;

        let consumed = tx
            .query_opt(
                "DELETE FROM session_nonces \
                  WHERE nonce = $1 AND purpose = 'request' AND session_id = $2 \
                    AND expires_at > now() \
                  RETURNING issued_counter",
                &[&request.nonce.to_vec(), &request.session_id],
            )
            .await?;
        leave_session_custody(&tx).await?;
        tx.commit().await?;

        let Some(consumed) = consumed else {
            return Err(SessionError::NonceNotFresh);
        };
        Ok(PendingRequest {
            session_id: request.session_id.to_string(),
            method: request.method.to_string(),
            path: request.path.to_string(),
            body_digest: body_digest(request.body),
            nonce: request.nonce,
            unix_ms: request.unix_ms,
            counter: request.counter,
            signature: request.signature,
            issued_counter: consumed.get(0),
        })
    }

    /// **Step two: everything else, inside the transaction the caller will
    /// also authorise in.**
    ///
    /// `app.session_custody` is turned on at the start and off again before
    /// this returns, so the rest of the caller's transaction — the tenant
    /// context, the grant evaluation, whatever the handler does — reaches zero
    /// rows in the session tables exactly as `0013` §E requires of every
    /// transaction that is not a verification.
    ///
    /// # What is checked, in order
    ///
    /// 1. the row exists, and **has not been recorded as signed out** (`0014`
    ///    §D: a row restored from a backup does not come back to life);
    /// 2. **its MAC recomputes** — §4.3's second fence: a tier-2 attacker
    ///    cannot mint a row, because the site row key is not in PostgreSQL;
    /// 3. the session has not expired (and if it has, the row is deleted);
    /// 4. the account is not disabled;
    /// 5. the key that proved this session is still in service, and **its own
    ///    keyring row seal verifies** — so a retired or superseded key stops
    ///    the session at its next request;
    /// 6. the timestamp is inside [`CLOCK_SKEW`] and the counter is the next
    ///    one, inside [`COUNTER_WINDOW`] of the mark the nonce was issued at;
    /// 7. the ES256 signature verifies over [`request_bytes`] recomputed from
    ///    **the request as it arrived**, never from anything the caller
    ///    asserted about it.
    pub async fn verify_pending(
        &self,
        tx: &Transaction<'_>,
        pending: &PendingRequest,
    ) -> Result<VerifiedSession, SessionError> {
        enter_session_custody(tx).await?;
        let result = self.verify_inside(tx, pending).await;
        match result {
            Ok(session) => {
                leave_session_custody(tx).await?;
                Ok(session)
            }
            // The transaction may already be aborted, in which case closing
            // the capability fails too and has nothing left to protect.
            Err(e) => {
                let _ = leave_session_custody(tx).await;
                Err(e)
            }
        }
    }

    /// §4.1 clause (b) whole, for a caller with nothing else to do in the same
    /// transaction — sign-out, and every test that verifies for its own sake.
    ///
    /// A route that goes on to authorise must call [`begin_request`] and
    /// [`verify_pending`] instead, so that verification and authorisation
    /// share one snapshot.
    ///
    /// [`begin_request`]: SessionStore::begin_request
    /// [`verify_pending`]: SessionStore::verify_pending
    pub async fn verify_request(
        &self,
        request: &SignedRequest<'_>,
    ) -> Result<VerifiedSession, SessionError> {
        let pending = self.begin_request(request).await?;
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        let result = self.verify_pending(&tx, &pending).await;
        // The advanced counter and any expiry deletion are committed either
        // way; the refusal is returned afterwards.
        tx.commit().await?;
        result
    }

    async fn verify_inside(
        &self,
        tx: &Transaction<'_>,
        request: &PendingRequest,
    ) -> Result<VerifiedSession, SessionError> {
        let Some(row) = read_session(tx, &request.session_id).await? else {
            return Err(SessionError::NoSuchSession);
        };

        // (1) Signed out, and recorded as signed out.
        if is_revoked(tx, &row.id).await? {
            return Err(SessionError::SessionRevoked);
        }

        // (2) The row MAC.
        self.check_row_mac(tx, &row).await?;

        // (3) Expiry.
        let now = now_unix();
        if row.expires_at_unix <= now {
            delete_session(tx, &row.id).await?;
            return Err(SessionError::Expired);
        }

        // (4) The principal — on both planes.
        set_account_id(tx, &row.principal_id).await?;
        match row.principal_kind {
            PrincipalKind::Steward => {
                let disabled: Option<bool> = tx
                    .query_opt(
                        "SELECT disabled_at IS NOT NULL FROM accounts WHERE id = $1",
                        &[&row.principal_id],
                    )
                    .await?
                    .map(|r| r.get(0));
                match disabled {
                    Some(false) => {}
                    Some(true) => return Err(SessionError::AccountDisabled),
                    None => return Err(SessionError::NoSuchSession),
                }
            }
            // **A suspended operator stops at the next request**, which is the
            // same sentence `0013` §A wrote for a disabled account and the same
            // mechanism: a column re-read inside the transaction that will also
            // authorise, never a flag cached in the session row. A session
            // carrying a stored "is an operator in good standing" boolean would
            // be one `UPDATE` from being true again.
            PrincipalKind::Operator => {
                let disabled: Option<bool> = tx
                    .query_opt(
                        "SELECT disabled_at IS NOT NULL FROM operators WHERE id = $1",
                        &[&row.principal_id],
                    )
                    .await?
                    .map(|r| r.get(0));
                match disabled {
                    Some(false) => {}
                    Some(true) => return Err(SessionError::AccountDisabled),
                    None => return Err(SessionError::NoSuchSession),
                }
            }
        }

        // (5) The evidence key, still in service, its own seal still true —
        // **resolved from the keyring the session's own plane keeps**. The two
        // keyrings are different tables with different seals (`0015` §B), and
        // resolving an operator's key id against `account_keys` would refuse
        // every operator session at its second request.
        if let Some(key_id) = &row.evidence_key_id {
            match row.principal_kind {
                PrincipalKind::Steward => {
                    match grants::signing_key_by_id(tx, &self.ring, key_id, now).await {
                        Ok(_) => {}
                        Err(AuthorityError::NoSigningKey) => {
                            return Err(SessionError::EvidenceKeyNotInService)
                        }
                        Err(e) => return Err(e.into()),
                    }
                }
                PrincipalKind::Operator => {
                    match operators::live_operator_key(tx, &self.ring, &row.principal_id, now).await
                    {
                        // The operator's LIVE key must still be the one that
                        // proved this session. An operator who enrolled a
                        // second key does not keep a session the first one
                        // established, for §8.4's reason: a session dies with
                        // the key that made it.
                        Ok(key) if &key.id == key_id => {}
                        Ok(_) => return Err(SessionError::EvidenceKeyNotInService),
                        Err(operators::OperatorError::Unverifiable(what)) => {
                            return Err(SessionError::Unverifiable(what))
                        }
                        Err(_) => return Err(SessionError::EvidenceKeyNotInService),
                    }
                }
            }
        }

        let issued_counter = request.issued_counter;

        // (6) Time and counter, on numbers that have already been bounded by
        // `begin_request` and are checked again here rather than assumed —
        // every arithmetic on this path is checked, so a later widening of the
        // bound cannot quietly re-open the panic that `0014` closed.
        let skew = clock_skew_seconds(now, request.unix_ms)?;
        if skew > CLOCK_SKEW.as_secs() as i64 {
            return Err(SessionError::ClockSkew { by_seconds: skew });
        }
        let ceiling = issued_counter
            .checked_add(COUNTER_WINDOW)
            .ok_or(SessionError::CounterNotFresh)?;
        if request.counter <= issued_counter || request.counter > ceiling {
            return Err(SessionError::CounterNotFresh);
        }

        // (7) The signature, over the request as it arrived.
        let message = request_bytes(
            &request.session_id,
            &request.method,
            &request.path,
            &request.body_digest,
            &request.nonce,
            request.unix_ms,
            request.counter,
        );
        authority::verify_es256(&row.session_pubkey, &message, &request.signature)?;

        tx.execute(
            "UPDATE sessions \
                SET last_seen_at = now(), \
                    request_counter = GREATEST(request_counter, $2) \
              WHERE id = $1",
            &[&row.id, &request.counter],
        )
        .await?;

        Ok(VerifiedSession {
            id: row.id,
            actor: row
                .principal_id
                .parse::<AccountId>()
                .map_err(|_| SessionError::Corrupt("session principal id"))?,
            kind: row.principal_kind,
            assurance: row.assurance,
            expires_at_unix: row.expires_at_unix,
        })
    }

    /// Sign-out. **The row is deleted AND the fact is recorded** (`0014` §D).
    ///
    /// §4.3 has no column for it, and adding one would put a boolean between
    /// an attacker and a live session — one `UPDATE` from being false again.
    /// So the row still goes, and the outstanding nonces go with it through
    /// the one `ON DELETE CASCADE` in this schema.
    ///
    /// # Why deleting it was not enough
    ///
    /// `0013` argued that *"a deleted row cannot be resurrected without the
    /// site row key, which is not in PostgreSQL"*. That is true of MINTING a
    /// row and false of RESTORING one. [`session_row_state`] covers the row's
    /// own fields and nothing else, and none of them changes when a session is
    /// signed out — so last night's backup holds bytes whose MAC recomputes
    /// for ever, and re-inserting one row silently undid the sign-out. Nothing
    /// anywhere recorded that the id had existed.
    ///
    /// An append-only `session_revocations` row closes it, in the shape the
    /// authority tables already use for revocation: sealed under the same
    /// site-scoped row key with `authority::row_seal`, bound by `chain_seq` to
    /// a sealed `account_signed_out` entry appended first, and unreachable to
    /// `fathom_app` through UPDATE or DELETE at all. [`verify_inside`] refuses
    /// any session id that appears in it.
    ///
    /// What this does **not** close is a restore of the whole database to a
    /// point before the sign-out; nothing inside the database could, and §7.6
    /// says so. What catches that is the off-box anchor.
    ///
    /// Takes a [`VerifiedSession`], so signing another session out requires
    /// having signed this request with that session's own key.
    ///
    /// [`verify_inside`]: SessionStore::verify_inside
    pub async fn sign_out(&self, session: &VerifiedSession) -> Result<(), SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        let result = self.sign_out_in(&tx, session).await;
        result?;
        tx.commit().await?;
        Ok(())
    }

    /// [`SessionStore::sign_out`], inside a transaction the caller owns — so
    /// that a route which verified in that transaction signs out in it too and
    /// the two cannot come apart.
    pub async fn sign_out_in(
        &self,
        tx: &Transaction<'_>,
        session: &VerifiedSession,
    ) -> Result<(), SessionError> {
        enter_session_custody(tx).await?;
        let principal = session.actor.to_string();

        // The entry first, then the row whose MAC covers its seq: no record,
        // no sign-out, which is the order `attempt_sign_in` uses for the same
        // reason (§0, "stopping the log stops the act").
        // §7.2 names `account_signed_out` and, since `0015`, `operator_signed_out`
        // — two types rather than one with a `principal_kind` field, because
        // the type is what a reader holding only the chain key can group by,
        // and an operator's acts must be legible as operator acts to whoever
        // audits the operator plane.
        let entry_type = match session.kind {
            PrincipalKind::Steward => EntryType::AccountSignedOut,
            PrincipalKind::Operator => EntryType::OperatorSignedOut,
        };
        let appended = chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            entry_type,
            &entry_metadata(
                entry_type,
                &[
                    ("session", Json::Str(session.id.clone())),
                    ("account", Json::Str(principal.clone())),
                    (
                        "principal_kind",
                        Json::Str(session.kind.as_str().to_string()),
                    ),
                ],
            ),
        )
        .await?;

        let facts = RevocationFacts {
            session_id: &session.id,
            principal_id: &principal,
            reason: SIGNED_OUT,
            chain_seq: appended.seq,
            row_version: 1,
        };
        let key = grants::site_row_key(tx, &self.ring).await?;
        let mac = revocation_row_mac(&key, &facts);

        tx.execute(
            "INSERT INTO session_revocations \
                 (session_id, principal_id, reason, chain_seq, row_version, row_mac) \
             VALUES ($1, $2, $3, $4, 1, $5) \
             ON CONFLICT (session_id) DO NOTHING",
            &[
                &facts.session_id,
                &facts.principal_id,
                &facts.reason,
                &facts.chain_seq,
                &mac.to_vec(),
            ],
        )
        .await?;

        delete_session(tx, &session.id).await?;
        leave_session_custody(tx).await?;
        Ok(())
    }

    /// Disable or re-enable an account, and record it on the site chain
    /// (§7.2's `account_disabled|enabled`).
    ///
    /// **Not reachable from any HTTP route in this build.** The operator
    /// surface that will call it is §5's and is not built; what exists now is
    /// the column, the capability-gated write path, and the fact that a
    /// disabled account's live sessions stop at their next request. Listed in
    /// `0013` §A with the policy that admits the write.
    pub async fn set_account_disabled(
        &self,
        account: &str,
        disabled: bool,
    ) -> Result<(), SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;
        let entry_type = if disabled {
            EntryType::AccountDisabled
        } else {
            EntryType::AccountEnabled
        };
        chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            entry_type,
            &entry_metadata(entry_type, &[("account", Json::Str(account.to_string()))]),
        )
        .await?;
        let changed = tx
            .execute(
                "UPDATE accounts SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END \
                  WHERE id = $1",
                &[&account, &disabled],
            )
            .await?;
        tx.execute("SELECT set_config('app.account_custody', 'no', true)", &[])
            .await?;
        if changed == 0 {
            return Err(SessionError::NoSuchSession);
        }
        tx.commit().await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // The row MAC — §4.3's second fence
    // -----------------------------------------------------------------------

    /// `row_seal(K_row_site, "sessions", id, chain_seq, row_version,
    /// canon(row_state))`.
    ///
    /// See `0013`'s departure 2 for why this is `authority::row_seal` under
    /// the site-scoped row key rather than §4.3's own `K_sess` construction.
    async fn row_mac(
        &self,
        tx: &Transaction<'_>,
        row: &SessionRow,
    ) -> Result<[u8; 32], SessionError> {
        let key = grants::site_row_key(tx, &self.ring).await?;
        Ok(session_row_mac(&key, &row.facts()))
    }

    async fn check_row_mac(
        &self,
        tx: &Transaction<'_>,
        row: &SessionRow,
    ) -> Result<(), SessionError> {
        let recomputed = self.row_mac(tx, row).await?;
        let stored: Vec<u8> = tx
            .query_one("SELECT row_mac FROM sessions WHERE id = $1", &[&row.id])
            .await?
            .get(0);
        if stored != recomputed {
            return Err(SessionError::Unverifiable("session row MAC"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The one bridge to the repository layer
// ---------------------------------------------------------------------------

/// Open [`repo::TenantContext`] for a **verified** session.
///
/// This is the only function in the server that produces a tenant context from
/// a request, and it takes a `&VerifiedSession` — which nothing but
/// [`SessionStore::verify_request`] can make. §13 item 1, as a shape rather
/// than a sentence.
///
/// An operator session is refused outright: an operator principal is
/// unrepresentable in a membership at every privilege level (§2, `0004`), so
/// `repo::authorise` would refuse it anyway, and a typed refusal says why
/// rather than reporting "not a member" about a principal that could never be
/// one.
pub async fn open_tenant_context(
    tx: &Transaction<'_>,
    tenant: OrganisationId,
    session: &VerifiedSession,
) -> Result<TenantContext, SessionError> {
    if session.kind != PrincipalKind::Steward {
        return Err(SessionError::NotATenantPrincipal);
    }
    Ok(repo::open_tenant_context(tx, tenant, session.actor).await?)
}

/// The account behind a session, for the one kind of query that has no tenant
/// to open: *"which organisations do I belong to?"*.
///
/// **This is the second and last bridge from a session to an `AccountId`**,
/// [`open_tenant_context`] being the first. It exists because that one cannot
/// serve a caller who does not yet know which tenant it is asking about —
/// which is the whole point of `list_organisations_for_account`, whose own
/// doc comment says so.
///
/// **It opens no tenant context, and that is the danger.** `open_tenant_context`
/// sets the row-level-security context that keeps one organisation's rows away
/// from another's; this sets nothing. A caller may therefore use the returned
/// `AccountId` **only** with queries whose RLS policy is satisfied by the
/// `account_id` branch — the `organisations` and `memberships` policies of
/// `0002`, read through `repo::list_organisations_for_account_in`, which sets
/// `app.account_id` itself. Handing it to anything tenant-scoped would read
/// under no context at all. If a second caller ever wants this, read that
/// caller's policy first and say in its doc comment which branch it relies on.
///
/// An operator session is refused with the same
/// [`SessionError::NotATenantPrincipal`] `open_tenant_context` gives, for the
/// same reason: an operator principal is unrepresentable in a membership at
/// every privilege level (§2, `0004`), so it belongs to no organisation and
/// the honest answer is a typed refusal rather than an empty list.
pub fn account_without_tenant(session: &VerifiedSession) -> Result<AccountId, SessionError> {
    if session.kind != PrincipalKind::Steward {
        return Err(SessionError::NotATenantPrincipal);
    }
    Ok(session.actor)
}

// ---------------------------------------------------------------------------
// Rows, as this module reads them back
// ---------------------------------------------------------------------------

struct SessionRow {
    id: String,
    principal_id: String,
    principal_kind: PrincipalKind,
    token_hash: [u8; 32],
    session_pubkey: Vec<u8>,
    bound_nonce: [u8; 32],
    evidence_key_id: Option<String>,
    evidence_sig: Option<Vec<u8>>,
    assertion_digest: Option<[u8; 32]>,
    assurance: Assurance,
    chain_seq: i64,
    row_version: i32,
    issued_at_unix: i64,
    expires_at_unix: i64,
    request_counter: i64,
}

impl SessionRow {
    fn facts(&self) -> SessionFacts<'_> {
        SessionFacts {
            id: &self.id,
            principal_id: &self.principal_id,
            principal_kind: self.principal_kind,
            token_hash: &self.token_hash,
            session_pubkey: &self.session_pubkey,
            bound_nonce: &self.bound_nonce,
            evidence_key_id: self.evidence_key_id.as_deref(),
            evidence_sig: self.evidence_sig.as_deref(),
            assertion_digest: self.assertion_digest.as_ref(),
            assurance: self.assurance,
            chain_seq: self.chain_seq,
            row_version: self.row_version,
            issued_at_unix: self.issued_at_unix,
            expires_at_unix: self.expires_at_unix,
        }
    }
}

/// Everything §4.3's row MAC covers, as a public value.
///
/// **Public, and shaped like `authority::RowFacts` on purpose.** A
/// construction that can only be exercised through a transaction is a
/// construction nobody cross-checks — `authority.rs`'s own module header makes
/// the argument — and `tests/session_vectors.rs` pins every byte of this one
/// against a second implementation written in plain Python from §4's text.
pub struct SessionFacts<'a> {
    pub id: &'a str,
    pub principal_id: &'a str,
    pub principal_kind: PrincipalKind,
    pub token_hash: &'a [u8; 32],
    pub session_pubkey: &'a [u8],
    pub bound_nonce: &'a [u8; 32],
    pub evidence_key_id: Option<&'a str>,
    pub evidence_sig: Option<&'a [u8]>,
    pub assertion_digest: Option<&'a [u8; 32]>,
    pub assurance: Assurance,
    pub chain_seq: i64,
    pub row_version: i32,
    pub issued_at_unix: i64,
    pub expires_at_unix: i64,
}

/// §4.3's `row_mac`, in `authority::row_seal`'s construction under the
/// site-scoped row key.
///
/// ```text
/// row_mac = MAC(K_row_site, LP("fathom/row/v1") ‖ LP("sessions") ‖ LP(id)
///               ‖ u64(chain_seq) ‖ u32(row_version) ‖ LP(canon(row_state)))
/// ```
///
/// `0013`'s departure 2 carries the argument for reusing the authority layer's
/// construction rather than deriving §4.3's own `K_sess` under two new labels:
/// a session row is account-scoped in exactly the way a keyring row is, and a
/// label separates uses of one key, not keys.
pub fn session_row_mac(row_key: &Key32, facts: &SessionFacts<'_>) -> [u8; 32] {
    authority::row_seal(
        row_key,
        &RowFacts {
            table: "sessions",
            row_id: facts.id,
            chain_seq: facts.chain_seq,
            row_version: facts.row_version,
            row_state: &session_row_state(facts),
        },
    )
}

/// The canonical state of a session row, for its MAC.
///
/// **One function, used on write and on read**, so the MAC cannot depend on
/// which side computed it — `grants::grant_row_state`'s rule. Every field
/// §4.3's MAC lists is here, plus `token_hash`, because a bearer token an
/// attacker chose is exactly the substitution §4.1 describes, and plus
/// `assurance`, `evidence_key_id` and `evidence_sig` because they are what
/// clause (a) rests on.
///
/// **`last_seen_at` and `request_counter` are deliberately NOT in it.** They
/// are the two columns the runtime role may rewrite (`0013` §F), they change
/// on every request, and a MAC that covered them would have to be recomputed —
/// and re-verified — on every write, which is a second place for the chain
/// master to be needed for no gain. §4.3's own MAC covers neither.
fn session_row_state(row: &SessionFacts<'_>) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert(
        "assertion_digest".to_string(),
        match row.assertion_digest {
            Some(d) => Json::Str(hex(d)),
            None => Json::Null,
        },
    );
    map.insert(
        "assurance".to_string(),
        Json::Str(row.assurance.as_str().to_string()),
    );
    map.insert("bound_nonce".to_string(), Json::Str(hex(row.bound_nonce)));
    map.insert(
        "evidence_key_id".to_string(),
        match row.evidence_key_id {
            Some(id) => Json::Str(id.to_string()),
            None => Json::Null,
        },
    );
    map.insert(
        "evidence_sig".to_string(),
        match row.evidence_sig {
            Some(sig) => Json::Str(hex(sig)),
            None => Json::Null,
        },
    );
    map.insert("expires_at".to_string(), Json::Int(row.expires_at_unix));
    map.insert("issued_at".to_string(), Json::Int(row.issued_at_unix));
    map.insert(
        "principal_id".to_string(),
        Json::Str(row.principal_id.to_string()),
    );
    map.insert(
        "principal_kind".to_string(),
        Json::Str(row.principal_kind.as_str().to_string()),
    );
    map.insert(
        "session_pubkey".to_string(),
        Json::Str(hex(row.session_pubkey)),
    );
    map.insert("token_hash".to_string(), Json::Str(hex(row.token_hash)));
    Json::Obj(map).to_canonical_bytes()
}

/// The one value `session_revocations.reason` takes today.
const SIGNED_OUT: &str = "signed_out";

/// What one `session_revocations` row's seal covers (`0014` §D).
///
/// **Public, and shaped like [`SessionFacts`] and `authority::RowFacts` on
/// purpose** — same argument as `SessionFacts`': a construction that can only
/// be exercised through a transaction is a construction nobody cross-checks.
pub struct RevocationFacts<'a> {
    pub session_id: &'a str,
    pub principal_id: &'a str,
    pub reason: &'a str,
    pub chain_seq: i64,
    pub row_version: i32,
}

/// The seal on a `session_revocations` row.
///
/// ```text
/// row_mac = MAC(K_row_site, LP("fathom/row/v1") ‖ LP("session_revocations")
///               ‖ LP(session_id) ‖ u64(chain_seq) ‖ u32(row_version)
///               ‖ LP(canon(row_state)))
/// ```
///
/// `authority::row_seal` under the same site-scoped row key a session row is
/// sealed under, and **no new label**: `0013`'s departure 2 carries the whole
/// argument, and a revocation is account-scoped in exactly the way the session
/// it revokes was. The table name is inside the seal, so a revocation row
/// lifted into another table — or a session row filed as a revocation — does
/// not verify where it lands.
pub fn revocation_row_mac(row_key: &Key32, facts: &RevocationFacts<'_>) -> [u8; 32] {
    authority::row_seal(
        row_key,
        &RowFacts {
            table: "session_revocations",
            row_id: facts.session_id,
            chain_seq: facts.chain_seq,
            row_version: facts.row_version,
            row_state: &revocation_row_state(facts),
        },
    )
}

fn revocation_row_state(facts: &RevocationFacts<'_>) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert(
        "principal_id".to_string(),
        Json::Str(facts.principal_id.to_string()),
    );
    map.insert("reason".to_string(), Json::Str(facts.reason.to_string()));
    map.insert(
        "session_id".to_string(),
        Json::Str(facts.session_id.to_string()),
    );
    Json::Obj(map).to_canonical_bytes()
}

/// Has this session id been recorded as signed out (`0014` §D)?
///
/// **The row's own seal is deliberately NOT checked here, and the reason is
/// which way each failure falls.** An unsealed or resealed revocation row
/// refuses a session, which is the fail-closed direction and costs an attacker
/// who can write one nothing they could not get by deleting the session row
/// instead. Verifying the seal would mean an attacker who *corrupts* a
/// revocation gets the session back, which is the fail-open direction and is
/// exactly what this table exists to stop. The seal is what makes a minted
/// revocation detectable by an auditor, not what makes it effective here.
async fn is_revoked(tx: &Transaction<'_>, session_id: &str) -> Result<bool, SessionError> {
    let row = tx
        .query_opt(
            "SELECT 1 FROM session_revocations WHERE session_id = $1",
            &[&session_id],
        )
        .await?;
    Ok(row.is_some())
}

/// `0014` §C's sweep of `session_nonces`, driving `session_nonces_expiry_idx`.
///
/// A nonce past its `expires_at` can never be consumed — every `DELETE ...
/// RETURNING` that spends one also requires `expires_at > now()` — so it is
/// dead weight from the moment it expires.
async fn sweep_expired_nonces(tx: &Transaction<'_>) -> Result<(), SessionError> {
    tx.execute(
        "DELETE FROM session_nonces \
          WHERE nonce IN (SELECT nonce FROM session_nonces \
                           WHERE expires_at <= now() \
                           ORDER BY expires_at \
                           LIMIT $1)",
        &[&SWEEP_BATCH],
    )
    .await?;
    Ok(())
}

/// `0014` §C's sweep of `sessions`, driving `sessions_expiry_idx`.
///
/// An expired session is refused and deleted at its next use, which is where
/// the refusal has to happen anyway — `0013`'s argument, and it is still true.
/// What it left out is the session that has **no** next use, which is most of
/// them: a browser closed at five o'clock never comes back, and its row and
/// its outstanding nonces stayed for ever.
///
/// **No revocation row is recorded for a swept session**, unlike a sign-out:
/// `expires_at` is inside the row's own MAC, so a restored expired row is
/// refused by the expiry check on its own bytes.
async fn sweep_expired_sessions(tx: &Transaction<'_>) -> Result<(), SessionError> {
    tx.execute(
        "DELETE FROM sessions \
          WHERE id IN (SELECT id FROM sessions \
                        WHERE expires_at <= now() \
                        ORDER BY expires_at \
                        LIMIT $1)",
        &[&SWEEP_BATCH],
    )
    .await?;
    Ok(())
}

/// Refuse a client-supplied millisecond timestamp outside the range a wall
/// clock can produce, **before any arithmetic touches it** (`0014`, finding
/// 5).
fn check_unix_ms(unix_ms: i64) -> Result<(), SessionError> {
    if !(MIN_UNIX_MS..=MAX_UNIX_MS).contains(&unix_ms) {
        return Err(SessionError::Malformed("request timestamp"));
    }
    Ok(())
}

/// `|now_seconds·1000 − unix_ms| / 1000`, with every step checked.
///
/// The line this replaces was `(now * 1000 - request.unix_ms).abs() / 1000`.
/// With `fathom-timestamp: -9223372036854775808` the subtraction overflows —
/// and the server profile sets `overflow-checks = true`, so that is a panic —
/// and `.abs()` on `i64::MIN` panics on the same line for a second reason.
/// [`check_unix_ms`] already refuses that input; this is checked anyway,
/// because the bound and the arithmetic are two statements of one rule and
/// somebody will one day relax the first.
fn clock_skew_seconds(now_seconds: i64, unix_ms: i64) -> Result<i64, SessionError> {
    let now_ms = now_seconds
        .checked_mul(1000)
        .ok_or(SessionError::Malformed("server clock"))?;
    let delta = now_ms
        .checked_sub(unix_ms)
        .ok_or(SessionError::Malformed("request timestamp"))?;
    let magnitude = delta
        .checked_abs()
        .ok_or(SessionError::Malformed("request timestamp"))?;
    Ok(magnitude / 1000)
}

async fn read_session(tx: &Transaction<'_>, id: &str) -> Result<Option<SessionRow>, SessionError> {
    let row = tx
        .query_opt(
            // `COALESCE` over the two evidence columns, and it is unambiguous
            // because `0015` §B2's `CHECK`s let only the one matching this
            // row's `principal_kind` be set. What comes back is the same single
            // value `session_row_state` has always hashed.
            "SELECT id, principal_id, principal_kind, token_hash, session_pubkey, bound_nonce, \
                    COALESCE(evidence_key_id, evidence_operator_key_id), \
                    evidence_sig, assertion_digest, assurance, chain_seq, \
                    row_version, EXTRACT(EPOCH FROM issued_at)::bigint, \
                    EXTRACT(EPOCH FROM expires_at)::bigint, request_counter \
               FROM sessions WHERE id = $1",
            &[&id],
        )
        .await?;
    let Some(row) = row else { return Ok(None) };
    let token_hash: Vec<u8> = row.get(3);
    let bound_nonce: Vec<u8> = row.get(5);
    let assertion_digest: Option<Vec<u8>> = row.get(8);
    let kind: String = row.get(2);
    let assurance: String = row.get(9);
    Ok(Some(SessionRow {
        id: row.get(0),
        principal_id: row.get(1),
        principal_kind: PrincipalKind::parse(&kind)
            .ok_or(SessionError::Corrupt("session principal kind"))?,
        token_hash: as_32(&token_hash, "session token hash")?,
        session_pubkey: row.get(4),
        bound_nonce: as_32(&bound_nonce, "session bound nonce")?,
        evidence_key_id: row.get(6),
        evidence_sig: row.get(7),
        assertion_digest: match assertion_digest {
            Some(d) => Some(as_32(&d, "session assertion digest")?),
            None => None,
        },
        assurance: Assurance::parse(&assurance)
            .ok_or(SessionError::Corrupt("session assurance"))?,
        chain_seq: row.get(10),
        row_version: row.get(11),
        issued_at_unix: row.get(12),
        expires_at_unix: row.get(13),
        request_counter: row.get(14),
    }))
}

async fn delete_session(tx: &Transaction<'_>, id: &str) -> Result<(), SessionError> {
    tx.execute("DELETE FROM sessions WHERE id = $1", &[&id])
        .await?;
    Ok(())
}

/// Resolve an address to an account id, for sign-in only.
async fn account_by_address(
    tx: &Transaction<'_>,
    address: &str,
) -> Result<Option<String>, SessionError> {
    let row = tx
        .query_opt("SELECT id FROM accounts WHERE email = $1", &[&address])
        .await?;
    Ok(row.map(|r| r.get(0)))
}

/// Resolve what an operator typed to an operator id, for sign-in only.
///
/// **§4.5 gives an operator no address of record**, because there is no reset
/// path to send anything to, so the operator plane's equivalent of an address
/// is the operator's own id — handed to them once at enrolment and shown on the
/// console beside their name. It is not a secret and is not treated as one: the
/// factor is a signature by the key `operator_keys` holds for them.
///
/// A value that names nobody returns `None` and takes exactly the path an
/// unknown address takes on the account plane, which is what keeps the two
/// planes' refusals identical.
async fn operator_by_id(
    tx: &Transaction<'_>,
    claimed: &str,
) -> Result<Option<String>, SessionError> {
    let row = tx
        .query_opt("SELECT id FROM operators WHERE id = $1", &[&claimed])
        .await?;
    Ok(row.map(|r| r.get(0)))
}

/// The one shape sign-in needs from either keyring: which key proved this
/// session, and what verifies against it.
///
/// `grants::AccountKey` and `operators::OperatorKey` are different rows in
/// different tables with different seals, and deliberately so — `0015` §B
/// carries that argument. What sign-in needs from either is the same three
/// fields, and this is that, so the branch below produces one value and the
/// forty lines after it are written once.
struct SignInKey {
    id: String,
    public_key: Vec<u8>,
    fpr: [u8; 32],
}

// ---------------------------------------------------------------------------
// The transaction-local capability, and small helpers
// ---------------------------------------------------------------------------

/// Turn on `app.session_custody` for the rest of this transaction.
///
/// `0013` §E carries the argument. The short version: a session is not
/// organisation-scoped and is verified before any tenant context exists, so
/// there is no tenant id for a policy to compare against — and the setting is
/// scoped to one transaction, which does nothing but verify, so every other
/// transaction in this server reaches zero rows in the three session tables.
///
/// The mirror of `repo::enter_key_custody`, including that it sets
/// `app.design_capability` to its refusal first: a verification transaction
/// has no business reading a design payload, and the setting every payload
/// policy reads is closed before the one this needs is opened.
async fn enter_session_custody(tx: &Transaction<'_>) -> Result<(), SessionError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
        .await?;
    Ok(())
}

/// Close it again before the transaction commits, so that a connection handed
/// back to the pool mid-transaction-block carries nothing. `set_config(...,
/// true)` already scopes it to the transaction; this is the second statement
/// of the same rule, and it costs one round trip on a path that has already
/// done several.
async fn leave_session_custody(tx: &Transaction<'_>) -> Result<(), SessionError> {
    tx.execute("SELECT set_config('app.session_custody', 'no', true)", &[])
        .await?;
    Ok(())
}

/// Name the acting account for the policies that show an account its own rows.
/// The value always comes from a row this server read, never from a caller.
async fn set_account_id(tx: &Transaction<'_>, account: &str) -> Result<(), SessionError> {
    tx.execute("SELECT set_config('app.account_id', $1, true)", &[&account])
        .await?;
    Ok(())
}

fn check_public_key(public_key: &[u8]) -> Result<(), SessionError> {
    if public_key.len() != authority::PUBLIC_KEY_LEN || public_key[0] != 4 {
        return Err(SessionError::Malformed("session public key"));
    }
    Ok(())
}

/// 32 bytes from the OS CSPRNG — the one generator this server draws from
/// (`crypto::Key32::random`), never a userspace generator with its own state.
/// The type is named for keys and this is a nonce; the draw is the same draw.
fn random_32() -> Result<[u8; 32], SessionError> {
    Ok(*Key32::random()
        .map_err(|_| SessionError::Corrupt("random source"))?
        .expose())
}

/// Compare two byte strings in constant time, with the primitives already in
/// this crate and no hand-rolled loop.
///
/// `crypto::mac_verify` is the one constant-time comparison this workspace has
/// (`digest 0.11.3`'s `Mac` trait, read rather than assumed — see
/// `crypto.rs`). Keying both sides under a fresh random value per call turns it
/// into an equality test whose timing carries nothing about either input: an
/// attacker who could time it learns about a MAC under a key that exists for
/// one call and is then dropped.
fn same_bytes(a: &[u8], b: &[u8]) -> Result<bool, SessionError> {
    let key = Key32::random().map_err(|_| SessionError::Corrupt("random source"))?;
    Ok(crypto::mac_verify(
        key.expose(),
        a,
        &crypto::mac(key.expose(), b),
    ))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn as_32(bytes: &[u8], what: &'static str) -> Result<[u8; 32], SessionError> {
    bytes.try_into().map_err(|_| SessionError::Corrupt(what))
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

/// The start of the current fixed window, as a `timestamptz` the database can
/// compare. Computed here rather than in SQL so that both buckets and both
/// statements agree on one value per call.
fn window_start(window: Duration) -> std::time::SystemTime {
    let secs = window.as_secs().max(1);
    let now = now_unix().max(0) as u64;
    std::time::UNIX_EPOCH + Duration::from_secs(now - (now % secs))
}

fn seconds_left_in_window(window: Duration) -> i64 {
    let secs = window.as_secs().max(1) as i64;
    secs - (now_unix().rem_euclid(secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_list_names_every_label_this_module_uses() {
        for label in [
            TAG_SESSION_BIND,
            TAG_SESSION_REQUEST,
            TAG_SESSION_TOKEN,
            TAG_SESSION_EVIDENCE,
        ] {
            let text = core::str::from_utf8(label).unwrap();
            assert!(
                LABELS.iter().any(|(name, _)| *name == text),
                "{text} is used and is not in LABELS, so PHASE-2-STORAGE-DESIGN.md \
                 §12.2's table cannot be reconciled against this file"
            );
        }
    }

    #[test]
    fn every_label_this_module_introduces_is_session_scoped_and_versioned() {
        for (name, _) in LABELS {
            assert!(name.starts_with("fathom/session/"), "{name}");
            assert!(name.ends_with("/v1"), "{name}");
        }
    }

    #[test]
    fn the_request_message_changes_with_every_field_it_covers() {
        let base = || {
            request_bytes(
                "01JQZ0000000000000000000AA",
                "GET",
                "/organisations/x/capability",
                &[1u8; 32],
                &[2u8; 32],
                1_760_000_000_000,
                7,
            )
        };
        let variants = [
            request_bytes(
                "01JQZ0000000000000000000AB",
                "GET",
                "/organisations/x/capability",
                &[1u8; 32],
                &[2u8; 32],
                1_760_000_000_000,
                7,
            ),
            request_bytes(
                "01JQZ0000000000000000000AA",
                "POST",
                "/organisations/x/capability",
                &[1u8; 32],
                &[2u8; 32],
                1_760_000_000_000,
                7,
            ),
            request_bytes(
                "01JQZ0000000000000000000AA",
                "GET",
                "/organisations/y/capability",
                &[1u8; 32],
                &[2u8; 32],
                1_760_000_000_000,
                7,
            ),
            request_bytes(
                "01JQZ0000000000000000000AA",
                "GET",
                "/organisations/x/capability",
                &[9u8; 32],
                &[2u8; 32],
                1_760_000_000_000,
                7,
            ),
            request_bytes(
                "01JQZ0000000000000000000AA",
                "GET",
                "/organisations/x/capability",
                &[1u8; 32],
                &[9u8; 32],
                1_760_000_000_000,
                7,
            ),
            request_bytes(
                "01JQZ0000000000000000000AA",
                "GET",
                "/organisations/x/capability",
                &[1u8; 32],
                &[2u8; 32],
                1_760_000_000_001,
                7,
            ),
            request_bytes(
                "01JQZ0000000000000000000AA",
                "GET",
                "/organisations/x/capability",
                &[1u8; 32],
                &[2u8; 32],
                1_760_000_000_000,
                8,
            ),
        ];
        for (n, variant) in variants.iter().enumerate() {
            assert_ne!(
                base(),
                *variant,
                "field {n} is not covered by the request signature"
            );
        }
    }

    #[test]
    fn the_length_prefixes_stop_two_fields_running_together() {
        // Without LP, "GET" + "/a/b" and "GET/a" + "/b" would assemble to the
        // same bytes. This is the trap storage §11.2's rule exists to close.
        assert_ne!(
            request_bytes("s", "GET", "/a/b", &[0u8; 32], &[0u8; 32], 1, 1),
            request_bytes("s", "GET/a", "/b", &[0u8; 32], &[0u8; 32], 1, 1)
        );
    }

    #[test]
    fn the_challenge_binds_the_public_key_the_nonce_and_the_deployment() {
        let key = [4u8; 65];
        let base = session_challenge(&key, &[1u8; 32], "01JQZ0000000000000000000AA");
        let mut other_key = key;
        other_key[3] = 9;
        assert_ne!(
            base,
            session_challenge(&other_key, &[1u8; 32], "01JQZ0000000000000000000AA")
        );
        assert_ne!(
            base,
            session_challenge(&key, &[2u8; 32], "01JQZ0000000000000000000AA")
        );
        assert_ne!(
            base,
            session_challenge(&key, &[1u8; 32], "01JQZ0000000000000000000AB")
        );
    }

    #[test]
    fn the_defaults_are_the_documented_ones() {
        let limits = SignInLimits::from_lookup(|_| None).unwrap();
        assert_eq!(limits, SignInLimits::defaults());
        assert_eq!(limits.window, Duration::from_secs(900));
        assert_eq!(limits.max_per_account, 10);
        assert_eq!(limits.max_per_source, 30);
    }

    #[test]
    fn a_limit_of_zero_is_refused_rather_than_locking_everybody_out() {
        let get = |k: &str| (k == "FATHOM_SIGNIN_MAX_PER_ACCOUNT").then(|| "0".to_string());
        assert_eq!(
            SignInLimits::from_lookup(get),
            Err("FATHOM_SIGNIN_MAX_PER_ACCOUNT")
        );
    }

    #[test]
    fn no_message_in_this_module_has_a_field_a_password_could_arrive_in() {
        // §4.5 and OPEN-QUESTIONS C2. The check is on the source of this file
        // rather than on a type, because what must not exist is a FIELD, and
        // a field that does not exist has no type to assert about.
        //
        // The test module is cut off first: this test's own name contains the
        // word, and a check that fails on the thing checking is a check that
        // gets deleted.
        let whole = include_str!("sessions.rs");
        let source = whole
            .split_once("#[cfg(test)]")
            .map(|(before, _)| before)
            .unwrap_or(whole);
        for forbidden in ["password", "passphrase", "passcode", "\"pin\""] {
            for line in source.lines() {
                let lower = line.to_ascii_lowercase();
                if !lower.contains(forbidden) {
                    continue;
                }
                // Prose about there being no password path is the point, not a
                // violation of it.
                assert!(
                    lower.trim_start().starts_with("//")
                        || lower.trim_start().starts_with("///")
                        || lower.contains("no password")
                        || lower.contains("forbidden"),
                    "a non-comment line mentions {forbidden}: {line}"
                );
            }
        }
    }
}
