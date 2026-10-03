//! **The per-request proof.** §4 of
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`: one principal per session, a
//! keypair the browser holds and the server has never seen, a challenge that
//! binds it, single-use nonces, and a signature on every request that reaches
//! design payload or vault ciphertext.
//!
//! `migrations/0013_sessions.sql` carries the reasoning for every constraint
//! and every departure from §4.3's SQL. This file holds the bytes and the order
//! things happen in; `api.rs` is the HTTP surface.
//!
//! # The one sentence everything else rests on
//!
//! §13 item 1: **`actor` comes from a session, never from the caller.** Made
//! structural:
//!
//! * [`VerifiedSession`] has private fields and no public constructor. Only
//!   [`SessionStore::verify_pending`] produces one: it recomputes the row MAC,
//!   checks the session has not been recorded as signed out, re-resolves the
//!   evidence key and verifies an ES256 signature over the request's own
//!   method, path, body digest, nonce and time, all inside the caller's
//!   transaction so whatever the caller authorises next sees the same
//!   snapshot. [`SessionStore::begin_request`] spends the single-use nonce
//!   first, in its own transaction that commits whatever the handler then does;
//!   [`SessionStore::verify_request`] is the two together.
//! * It does **not** expose an `AccountId`, only
//!   [`VerifiedSession::principal_id`], a string for logging and tests that the
//!   repository layer does not accept.
//! * [`open_tenant_context`] is the only way to turn a session into a
//!   [`repo::TenantContext`], and takes `&VerifiedSession`, so a handler's one
//!   route to the tenant context begins at a verified signature.
//!
//! `tests/sessions.rs` tests that the HTTP surface names no other source of an
//! actor, because the type system cannot stop a handler parsing a ULID from a
//! header and calling `repo::open_tenant_context` itself.
//!
//! # What is NOT here
//!
//! * **No password, for anyone** (§4.5, §5.1, `docs/OPEN-QUESTIONS.md` C2): no
//!   password column, reset path or "forgot" flow in this module's original
//!   design, and no field in any message it parses that a password could arrive
//!   in. ADR-0055 later reopened this for people; see `credentials.rs`.
//! * **No WebAuthn** (§15.4). Sign-in is a signature by a software ES256 key
//!   enrolled in `account_keys` (§15.1's deliberate downgrade). The challenge
//!   derivation is §4.2's, so WebAuthn lands on the same bytes.
//! * **No operator password, and no operator anything-but-a-key.** §4.5 is
//!   kept: an operator session is `A1` or it does not exist. Since
//!   `migrations/0015` an operator's key is enrolled in `operator_keys`, and the
//!   operator branch of sign-in verifies a signature over the same challenge an
//!   account signs: **the same mechanism, on the other plane**. An operator with
//!   no key enrolled is refused with the same message an unknown address gets;
//!   there is no weaker factor to fall back to and there must never be one.
//! * **No verdict is cached.** Every request re-reads the row, re-verifies the
//!   MAC, re-resolves the evidence key and re-verifies a fresh signature.
//! * **No background task.** `migrations/0014_session_hardening.sql` §C's sweep
//!   of expired rows runs on the write path of each of its three tables: this
//!   deployment is two interchangeable containers with no scheduler, and a
//!   sweeper in one stops when that one is rescheduled.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::{Pool, PoolError, Transaction};
use fathom_canon::Json;
use sha2::{Digest, Sha256};

use crate::authority::{self, RowFacts, SignatureRefused};
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError};
use crate::credentials;
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
/// §12.2's table, which owns them.** Same contract as
/// [`crate::authority::LABELS`]: the table wins, and a unit test asserts every
/// label the code uses is listed.
///
/// **Two labels §4.3 specifies are deliberately NOT here**, because nothing
/// derives them: `fathom/session/mac/v1` (a `K_sess` subkey from `chain_master`)
/// and `fathom/session/row/v1`. A session row is account-scoped like a keyring
/// row, so it is sealed under the site-scoped row key `0012` §D established,
/// with `authority::row_seal` and its `fathom/row/v1` tag. A label separates
/// uses of one key; this is not a new use (`0013`'s departure 2).
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

/// **The decoy an unresolved address is verified against**, so a sign-in
/// attempt carrying a credential costs one argon2id whether or not the address
/// belongs to anybody.
///
/// A real PHC string from [`crate::credentials::hash_password`] at the shipped
/// parameters (`m=19456, t=2, p=1`, OWASP Password Storage Cheat Sheet as read
/// by `credentials.rs` on 2026-09-21), compiled in, so the decoy does the same
/// memory-hard work. A unit test re-reads the parameters from this string and
/// fails if [`crate::credentials::ARGON2_M_COST`] and its neighbours move
/// without it: a cheaper decoy would be the oracle again, quieter.
///
/// **Its plaintext is not a secret.** The verification result is discarded;
/// only the time it took is used. This is the one string in the module that
/// looks like a stored credential and is nobody's.
///
/// OWASP ASVS 5.0.0 6.3.8: *"no account enumeration through messages, codes or
/// timing."*
/// account enumeration through messages, codes or timing."*
const A_DECOY_HASH: &str =
    "$argon2id$v=19$m=19456,t=2,p=1$H6t0pl1ZRNOBUXtZVBUtmw$EDIOwbfMpXv4IFQnmYcq+jCx6acuYc+rXo0Vt88yhGM";

// ---------------------------------------------------------------------------
// Times and sizes — every one of them named, none of them scattered
// ---------------------------------------------------------------------------

/// How long a session lives before it must be established again.
///
/// **§4 gives no number.** Twelve hours: a working day plus the evening, long
/// enough that an engineer documenting a rack is not signed out mid-task, short
/// enough that a laptop left open overnight is not live in the morning. A
/// constant, not a setting: a deployment wanting another should say so in the
/// register, which nothing yet reads.
pub const SESSION_LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);

/// ADR-0057 decision 2: how old the account session's own TOTP proof may be
/// before an operator sign-in it endorses also needs a fresh code.
pub const SECOND_FACTOR_FRESHNESS: Duration = Duration::from_secs(15 * 60);

/// ADR-0057 decision 4: how long an account-plane session may go without a
/// verified request before it is treated as dead, even inside its absolute
/// [`SESSION_LIFETIME`].
///
/// NIST SP 800-63B-4, session table: at AAL2 the idle timeout SHOULD be no more
/// than one hour. `docs/OPERATING.md` carries this number and its basis (ASVS
/// 5.0.0 7.1.1: *"document the reasoning"*).
pub const ACCOUNT_IDLE_LIMIT: Duration = Duration::from_secs(60 * 60);

/// ADR-0057 decision 4: the operator plane's idle limit — fifteen minutes,
/// the same number [`SECOND_FACTOR_FRESHNESS`] uses, and inside NIST SP
/// 800-63B-4's AAL3 idle figure. The console is the more sensitive plane,
/// so it gets the tighter of the two.
pub const OPERATOR_IDLE_LIMIT: Duration = Duration::from_secs(15 * 60);

/// Which limit applies to a session of `kind`.
fn idle_limit_seconds(kind: PrincipalKind) -> i64 {
    match kind {
        PrincipalKind::Steward => ACCOUNT_IDLE_LIMIT.as_secs() as i64,
        PrincipalKind::Operator => OPERATOR_IDLE_LIMIT.as_secs() as i64,
    }
}

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
/// carrying `i64::MAX` would set the mark there and no later nonce could
/// satisfy `counter > issued_counter`: the session dead until sign-out, a
/// self-inflicted denial of service a stolen bearer token could cause.
///
/// The window is [`MAX_OUTSTANDING_NONCES`]: all of one browser's in-flight
/// requests share an `issued_counter` and each takes the next of its own tally,
/// so `issued + 1 ..= issued + 32` is the whole legitimate range.
pub const COUNTER_WINDOW: i64 = MAX_OUTSTANDING_NONCES;

/// The absolute range a client-supplied millisecond timestamp must be inside
/// **before any arithmetic touches it** (`0014`, finding 5).
///
/// `fathom-timestamp: -9223372036854775808` parsed as an `i64` and reached
/// `now * 1000 - unix_ms`, which overflows; the server profile sets
/// `overflow-checks = true`, so that panicked the request task (`.abs()` on
/// `i64::MIN` panics too).
///
/// The bound is the honest one, not what the arithmetic needs: a wall clock in
/// milliseconds is at or after the epoch and before the end of the four-digit
/// years. Checked arithmetic follows anyway, so a later-widened bound cannot
/// quietly re-open the panic.
pub const MIN_UNIX_MS: i64 = 0;

/// The upper half of [`MIN_UNIX_MS`]'s range: `9999-12-31T23:59:59.999Z`.
pub const MAX_UNIX_MS: i64 = 253_402_300_799_999;

/// How many expired rows one write sweeps (`0014` §C).
///
/// **A sweep on the write path, not a background task**: this deployment is two
/// interchangeable containers with no scheduler, and a sweeper in one stops
/// when that one is rescheduled. Bounded so one request does not pay for a year
/// of rows, and large enough that every write clears far more than the one row
/// it adds.
pub const SWEEP_BATCH: i64 = 256;

/// How many times one source may ask `GET /setup/state` in a
/// [`SignInLimits::window`].
///
/// **Six hundred a window, per source, not the sign-in number.** The route is a
/// page load (see [`SessionStore::check_setup_state_budget`] for why it has its
/// own bucket), and a *source* is an address, which behind one office's egress
/// is everybody in it. Forty people opening the app once a minute for a quarter
/// hour is 600; a flood wants orders of magnitude more, and the answer is one
/// process-wide cached bit (`credentials::SETUP_STATE_CACHE`), so this bounds
/// the request, not the database.
///
/// Not configurable: `FATHOM_SIGNIN_MAX_PER_SOURCE` is about sign-ins. Give it
/// its own variable when a deployment needs one.
pub const SETUP_STATE_MAX_PER_SOURCE: i32 = 600;

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
    /// counted at `/session/challenge` as well as at `/session`, so a
    /// one-shot sign-in costs two and ADR-0056's two-step sign-in (challenge,
    /// probe, completion) costs three.
    pub max_per_source: i32,
}

impl SignInLimits {
    /// Fifteen minutes, ten failures per claimed identity, forty-five attempts
    /// per source.
    ///
    /// # Both numbers are rate limits. Neither is a lockout
    ///
    /// **Decided 2026-09-14; `0014` §0 carries the argument.**
    /// [`SessionStore::sign_in`] checks the source bucket before it attempts
    /// anything and reads the account bucket only on a path that has already
    /// failed, so a caller with a good signature is never refused by the account
    /// bucket however many failures that identity has collected.
    ///
    /// It stays that way. On an unauthenticated surface a lockout hands an
    /// attacker a denial of service against a named person for the price of
    /// eleven bad signatures, and the signature factor can only be passed with
    /// the private key. What the account bucket buys is a bound on the work and
    /// sealed audit one claimed identity can cause in a window, and that is all
    /// it claims.
    ///
    /// The numbers differ because a legitimate person fails a signature a
    /// handful of times at most (wrong profile, stale key), while an office
    /// behind one address signs in all morning.
    ///
    /// **Forty-five per source is fifteen complete sign-ins.** `0014` counts the
    /// challenge route, and ADR-0056's two-step sign-in (challenge, probe,
    /// completion) costs **three** now that the probe is charged (see
    /// [`SessionStore::sign_in_with_credentials`]; it was free and repeatable:
    /// forty argon2id verifications for one unit of budget). Thirty would have
    /// tightened ordinary people to ten sign-ins. **45 ÷ 3 = 15**: what a shared
    /// source may do is what it could do before.
    ///
    /// A deployment behind a single NAT should raise it:
    /// `FATHOM_SIGNIN_MAX_PER_SOURCE`.
    pub fn defaults() -> Self {
        Self {
            window: Duration::from_secs(15 * 60),
            max_per_account: 10,
            max_per_source: 45,
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

/// ADR-0057 decision 7: `FATHOM_SESSION_ADDRESS_CHECK`, which planes a
/// changed request address ends a session on.
/// OWASP Session Management Cheat Sheet, "Binding the Session ID to Other User
/// Properties": address binding detects hijacking but is "not... trustworthy"
/// alone, since a shared NAT or proxy defeats it. So an account session is never
/// ended by it (laptops, VPNs and phones change address normally) while the more
/// sensitive operator plane is by default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AddressCheckMode {
    /// Default. Only the operator plane ends on a changed address; an
    /// account session records the change and stays live.
    #[default]
    Site,
    /// Both planes end on a changed address.
    All,
    /// Neither plane is checked at all.
    Off,
}

impl AddressCheckMode {
    /// `FATHOM_SESSION_ADDRESS_CHECK`'s three spellings. `None` for anything
    /// else, for `config.rs`'s `ConfigError::Unparseable`.
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "site" => Some(Self::Site),
            "all" => Some(Self::All),
            "off" => Some(Self::Off),
            _ => None,
        }
    }

    /// Whether a changed address ends a session of `kind` under this mode.
    fn ends_session(self, kind: PrincipalKind) -> bool {
        match self {
            Self::Off => false,
            Self::Site => kind == PrincipalKind::Operator,
            Self::All => true,
        }
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
/// **The tag is length-prefixed, where §4.2 writes it bare**, as
/// `authority::key_fingerprint` records for §3.2: storage §11.2 says
/// *"length-prefix every variable-length field"* and every construction here
/// prefixes its tag. Two spellings of one rule is how a signature stops
/// verifying when somebody unifies them.
///
/// The nonce is single-use and deleted at verification, so **the same evidence
/// signature cannot bind a second public key** (§4.2). The deployment id is in
/// it so a challenge from one deployment is not one anywhere else.
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
/// §4.2 writes this message **without the nonce**, but §4.1 requires a
/// single-use nonce per request. A nonce outside the signed bytes is not bound
/// to the signature: an observer who captures one signed request can present it
/// again with a *different* fresh nonce and every check but the counter passes.
/// So `LP(nonce)` sits between the body digest and the times. The label stays
/// `v1` because v1 never shipped: nothing has produced or stored one of these
/// messages.
///
/// # What each field is for
///
/// * `session_id`: a signature for one session is not one for another, even if
///   one browser holds both keys.
/// * `method` and `path`: a signed `GET` of a scope tree is not a signed
///   `DELETE` of a design. **`path` is the path AND the query**, because an
///   unsigned query string is one an intermediary may rewrite.
/// * `H(body)`: the body itself is not signed, so a large upload is hashed once
///   rather than copied.
/// * `unix_ms`: bounds how long a captured message is worth presenting, checked
///   against [`CLOCK_SKEW`].
/// * `request_counter`: §4.3's. Anti-replay against a network observer and
///   **not** against the database attacker, who owns the column it is compared
///   with (`0013` §B).
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
/// **The token is deliberately weak.** On its own it buys one thing, a fresh
/// single-use nonce, and nothing that reaches design payload or vault
/// ciphertext, which need a signature under a key the server has never seen. It
/// is hashed at rest so a database read does not hand over even that.
pub fn token_hash(token: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64);
    crypto::lp(&mut msg, TAG_SESSION_TOKEN);
    crypto::lp(&mut msg, token);
    Sha256::digest(&msg).into()
}

/// §4.2's stored assurance evidence, in the software-key shape:
/// `H(LP(tag) ‖ LP(session_challenge) ‖ LP(evidence_sig))`.
///
/// §4.2 settles what the evidence IS (*"a signature by the account's registered
/// key over the same `session_challenge`"*); §4.3 stores a digest of a WebAuthn
/// assertion. This is the same digest for the factor §15.1 ships. The signature
/// is stored beside it, because a digest cannot be re-verified later.
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
/// This closes an account oracle: the account bucket was counted only when the
/// consumed bind nonce carried a principal, so an address belonging to nobody
/// never crossed the cap and answered `401` while a real one answered `429`.
/// Counting both closes it, but the bucket key is stored, and storing
/// non-account addresses means storing whatever people type into a sign-in box,
/// often their address at another service and occasionally a password typed
/// into the wrong field. A keyed hash groups attempts per address for the
/// window and is not a list of addresses to anybody holding the database:
/// `K_addr` derives from the chain master, which is not in PostgreSQL.
///
/// # Derived from the site chain key, as `authority::row_key` is
///
/// The site chain key is the same for every organisation, and a sign-in is not
/// organisation-scoped. The label is new because this is a new USE of that key
/// (`PHASE-2-STORAGE-DESIGN.md` §12.2's rule).
///
/// **The address is hashed exactly as typed**: no case folding or trimming,
/// because `account_by_address` matches exactly too. A variant spelling
/// resolves to no account, lands in its own bucket, and is refused as any
/// unknown address is.
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
/// **Both variants land in the same bucket kind**: an address that resolves to
/// an account and one that resolves to nothing must cross the cap at the same
/// attempt and change the answer the same way, or the rate limiter is an oracle
/// over the deployment's user list.
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

/// §4.3's assurance, with `0018` §B2's third value.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Assurance {
    /// **A password and nothing else.** Reached since ADR-0055 decision 10 by an
    /// account with a password, no app code and no operator custody (a steward
    /// who may sign in and change its own password, design §5.1), and by an
    /// account holding the operator custody that has not finished setup, which
    /// is refused everywhere but `/credentials/*`.
    A0,
    /// **A password and a verified app code**, no long-term key (`0018` §B2).
    /// Filing this as `A0` would let a reader mistake a two-factor sign-in for
    /// the unauthenticated placeholder, and filing it as `A1` would claim a
    /// long-term-key attestation that never happened.
    A0T,
    /// The session's holder signed a server challenge with an enrolled key.
    A1,
}

impl Assurance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::A0 => "A0",
            Self::A0T => "A0T",
            Self::A1 => "A1",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "A0" => Some(Self::A0),
            "A0T" => Some(Self::A0T),
            "A1" => Some(Self::A1),
            _ => None,
        }
    }
}

/// Everything `POST /session` carries, since ADR-0055 decision 10 widened it
/// from four fields to six.
///
/// **A struct, not six positional arguments**, as `grants::Authority`: each
/// field is a factor or a bucket key, and one value means a new caller cannot
/// quietly omit one or swap two same-typed `&[u8]`s.
///
/// `password` and `totp_code` are `&str` deliberately: both are typed by a
/// person and compared as text, and a byte slice would invite passing a hash.
pub struct SignInAttempt<'a> {
    pub kind: PrincipalKind,
    pub session_pubkey: &'a [u8],
    pub nonce: &'a [u8; 32],
    /// Empty when the browser holds no long-term key — which is the ordinary
    /// case for a person signing in with a password (decision 6, *"Any
    /// browser, no pairing"*).
    pub evidence_sig: &'a [u8],
    /// Empty on the key-only branch, which is every account that existed
    /// before this build and every operator sign-in.
    pub password: &'a str,
    /// Six digits is an app code; anything else is tried as a backup code.
    /// On the operator plane (ADR-0057 decision 2) this is the freshness
    /// code, checked against the account named by `account_session_id`
    /// rather than against the operator.
    pub totp_code: &'a str,
    pub source: &'a str,
    /// ADR-0057 decision 2. On the operator plane, the id of a live session of
    /// the operator's own bound account. Empty on the steward plane; the
    /// operator branch refuses an empty one.
    pub account_session_id: &'a str,
    /// A signature by that account session's own key over this attempt's own
    /// challenge (`session_challenge`), binding the two together. Empty on
    /// the steward plane.
    pub account_session_sig: &'a [u8],
    /// ADR-0057 decision 6. On the operator plane, the memory-only grace token
    /// a previous password-and-code sign-in of `account_session_id` returned
    /// (empty if none; never stored, so a reload starts empty). Checked in
    /// [`SessionStore::verify_account_endorsement`]; a mismatch only falls back
    /// to asking for a live code.
    pub grace_token: &'a [u8],
    /// ADR-0057 decision 8. The `User-Agent` header as it arrived, never stored
    /// itself: `attempt_sign_in` reduces it through `browser_label::label`
    /// first.
    pub user_agent: &'a str,
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
/// **This is not an actor and cannot become one by itself.** It proves only
/// that a nonce issued to some session id was fresh a moment ago; the row's MAC,
/// account, evidence key, clock, counter and signature are all still ahead of
/// it, and only [`SessionStore::verify_pending`] produces a
/// [`VerifiedSession`]. It exists because a transaction cannot be carried
/// across an axum extractor, so the request is carried instead. It owns its
/// fields because the `Request` it came from is gone by the time a handler
/// runs.
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
    /// A background request (a live stream, presence) does not refresh
    /// `last_seen_at`, so an unattended tab cannot keep a session alive
    /// (ADR-0063 #13).
    background: bool,
}

impl PendingRequest {
    /// Mark this request as background: it is verified like any other but does
    /// not count as the person being there.
    pub fn background(mut self) -> Self {
        self.background = true;
        self
    }
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
    /// repository layer takes `AccountId`, and the only ways to derive one from
    /// a session are [`open_tenant_context`] and [`account_without_tenant`],
    /// named so every place a session becomes an actor is greppable.
    ///
    /// This is for logging, comparison and audit entries. Parsing it back into
    /// an `AccountId` is exactly the bypass those two functions exist to
    /// prevent.
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

/// [`SessionStore::issue_request_nonce_ex`]'s answer: the nonce, and the
/// counter mark it was issued against.
pub struct IssuedNonce {
    pub nonce: [u8; 32],
    pub issued_counter: i64,
}

/// What sign-in hands back to the browser.
pub struct SignedIn {
    pub session_id: String,
    /// The bearer half, returned once and never stored in the clear.
    pub token: [u8; 32],
    pub expires_at_unix: i64,
    /// The principal's ulid. ADR-0053 §3: the client stamps this as the
    /// actor on every change it makes, so undo can tell its own batches from
    /// a colleague's.
    pub account_id: String,
    /// ADR-0057 decision 6. `Some` exactly when this sign-in verified a fresh
    /// TOTP code on the steward plane, the one moment a grace token is minted.
    /// Memory-only; presented as [`SignInAttempt::grace_token`] on a later
    /// sign-in within [`SECOND_FACTOR_FRESHNESS`].
    pub grace_token: Option<[u8; 32]>,
}

impl core::fmt::Debug for SignedIn {
    /// **Neither secret is printed**, by the rule `secret.rs` exists for:
    /// `{:?}` is reached for in a hurry and a `Debug` impl decides what ends up
    /// in a log line. The grace token is a bearer credential like the session
    /// token, for the fifteen minutes it is good.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SignedIn")
            .field("session_id", &self.session_id)
            .field("token", &"<not printed>")
            .field("expires_at_unix", &self.expires_at_unix)
            .field("account_id", &self.account_id)
            .field("grace_token", &self.grace_token.map(|_| "<not printed>"))
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

/// ADR-0057 decision 8: one row of the "Signed-in browsers" list — every
/// field this deployment already keeps, so the list adds no new place a
/// request address or a raw `User-Agent` is stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionSummary {
    pub session_id: String,
    /// `browser_label::label`'s answer at sign-in, or `None` for a session
    /// old enough to predate this column.
    pub browser_label: Option<String>,
    /// Decision 7's address class — an IPv4 address exactly, an IPv6 by its
    /// `/64` — or `None` when sign-in could not class the address. Never the
    /// raw address, and never a per-request log.
    pub bound_address_class: Option<String>,
    /// Whether a later request's address stopped matching
    /// `bound_address_class` (decision 7's `site` mode records rather than
    /// ends a steward session on this).
    pub address_changed: bool,
    pub last_active_unix: i64,
    pub issued_at_unix: i64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything this layer refuses, and why.
///
/// **[`SessionError::SignInRefused`] is deliberately one variant for several
/// causes**: an address that belongs to no account, an account with no enrolled
/// key, a nonce never issued or already used, a signature that does not verify,
/// and a challenge bound to a different public key. A caller who could tell
/// them apart could enumerate accounts. The sealed `account_signin_failed`
/// entry carries the real reason, where an operator can read it and an attacker
/// cannot.
///
/// **One variant was not enough alone (`0014` §A).**
/// [`SessionError::RateLimited`], which only a real address could reach, undid
/// the uniform message: the account bucket was counted only for an address that
/// resolved, so an unknown one answered the uniform refusal for ever while a
/// known one changed to `429` with `Retry-After` at the eleventh attempt. A
/// refusal is uniform only if *every* refusal this surface can produce is
/// uniform at every attempt, which `tests/sessions.rs` asserts.
///
/// **What is closed, narrowly.** The answer: status, headers and body are
/// identical for a known and an unknown address at every attempt, below the cap
/// and above it, tested over the wire.
///
/// **Since the 2026-09-21 review, also the dominant part of the timing.**
/// Measured on a running server, a known address with a wrong credential took a
/// median 498 ms against 5.9 ms for an unknown one (85 to 1), because argon2id
/// ran only when the address resolved to a stored hash. One verification now
/// runs on **every** refused attempt that presented a credential, against
/// [`A_DECOY_HASH`]. `tests/sessions.rs` asserts the two medians.
///
/// **This is still not a claim that sign-in is constant time.** What is
/// equalised is the one operation costing hundreds of milliseconds; the residue
/// (a keyring read, an ES256 verification) is smaller than network noise and
/// not defended against. An attempt presenting **no** credential is fast on
/// both sides: the empty-credential branch short-circuits before any hash for a
/// known address too.
///
/// **[`SessionError::Unverifiable`] is NOT a permission error** (§3.4): a row
/// MAC that does not recompute means the store is not telling the truth about
/// itself, and rendering that as "please sign in again" would teach nobody
/// anything.
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
    /// deliberately gone.** It told an unauthenticated caller that the operator
    /// plane had no key enrolled: harmless while no operator could exist, an
    /// oracle once one could (an attacker walking operator ids would learn which
    /// have enrolled). §4.5 is kept by the code, not the error type: an operator
    /// session is `A1` or it does not exist, and there is no password path to
    /// fall back to.
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
    /// **Rendered exactly as [`SessionError::NoSuchSession`]** (a signed-out and
    /// an unknown session are one answer from outside) but its own variant so
    /// the operator's log line and tests can tell them apart.
    SessionRevoked,
    /// The request carried no signature at all, or one this layer could not
    /// even parse.
    ///
    /// **Not [`SessionError::Malformed`]**: a caller who presented nothing did
    /// not get the protocol wrong, and needs "authenticate", not "your bytes are
    /// bad". Something unparseable gets the same answer, because telling the two
    /// apart tells an attacker which header they got right.
    NotSigned,
    /// The session's own lifetime has run out.
    Expired,
    /// The account this session belongs to has been disabled.
    AccountDisabled,
    /// The key that proved this session's assurance is no longer in service:
    /// retired or superseded. The session stops at its next request.
    EvidenceKeyNotInService,
    /// The nonce was never issued, has been consumed, has expired, or belongs to
    /// another session. **All four are one variant**: the same fact from the
    /// verifier's side, no fresh single-use proof of liveness.
    NonceNotFresh,
    /// The request's own timestamp is outside [`CLOCK_SKEW`].
    ClockSkew {
        by_seconds: i64,
    },
    /// The counter did not advance past the value recorded when the nonce was
    /// issued, or it ran further than [`COUNTER_WINDOW`] past it.
    ///
    /// **Both directions are one variant**: the same fact from the verifier's
    /// side, and telling them apart would reveal the stored mark.
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

    // ---- ADR-0055 stream (a) ------------------------------------------
    /// The sign-in presented a password this account's stored hash does not
    /// verify.
    ///
    /// **Rendered exactly as [`SessionError::SignInRefused`]** (decision 7, OWASP
    /// ASVS 5.0.0 6.3.8: no account enumeration through message, code or timing)
    /// but its own variant so the sealed `account_signin_failed` entry and the
    /// operator's log line say which cause it was.
    PasswordRefused,
    /// This session's account holds the operator custody and has not set up its
    /// authenticator app, so the session is a **setup session**: accepted on
    /// `/credentials/*` and refused everywhere else.
    ///
    /// ADR-0055 decision 10 (*"such an account is taken to the enrolment screen
    /// before anything else until it has one"*); a typed refusal rather than a
    /// redirect, so a client that ignores it gets nothing.
    ///
    /// **Not `AccountDisabled` and not `NotSigned`**: the holder is who they say
    /// they are and the session is real. The second factor is missing, and the
    /// client must be told precisely because the only way out is the screen that
    /// enrols it.
    TotpRequired,

    // ---- ADR-0056 decision 3 ------------------------------------------
    /// The address and the credential verify, the account holds a confirmed
    /// authenticator, and no verification code was presented. **Step one of a
    /// two-step sign-in**, not a refusal of anything the caller got wrong.
    ///
    /// **Its own variant, not [`SessionError::SignInRefused`]**, because the
    /// client must know which screen to draw next. ADR-0056 decision 3 names what
    /// this gives up (the second step tells whoever typed the right password that
    /// it was right) and why every surveyed product makes the same trade: it is
    /// not ASVS 6.3.8's rule, which is about deducing a *valid user* from a
    /// *failed* challenge, and a wrong address or credential still gets the one
    /// generic sentence.
    ///
    /// **It costs one source unit and nothing else** (2026-09-22). The
    /// transaction that produced it is rolled back: nothing is sealed, nothing is
    /// counted against the account, and **the challenge nonce is left
    /// unconsumed**, so step two re-posts the same challenge with the code. Then
    /// one count for the request is committed on its own against the source
    /// bucket.
    ///
    /// **Why the source count is not rolled back.** Rolling back everything made
    /// this answer free and repeatable: one challenge, one budget unit, and as
    /// many argon2id verifications as a password holder asked for (measured at
    /// forty on one nonce). The account bucket must still not move, since a
    /// person signing in correctly passes through here, but the request must cost
    /// the source one unit, as every other unauthenticated route does. A two-step
    /// sign-in costs **three** source units (challenge, probe, completion) and
    /// [`SignInLimits::defaults`] carries fifteen of them per window.
    SecondFactorNeeded,
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
            // ADR-0055 stream (a).
            Self::PasswordRefused => f.write_str(
                "sign-in refused. One message for every cause, so that an attacker cannot tell \
                 an unknown address from a refused credential; the sealed entry carries the \
                 reason",
            ),
            Self::TotpRequired => f.write_str(
                "this account holds the operator custody and has no authenticator set up, so \
                 its session may do nothing but finish the setup (ADR-0055 decision 10)",
            ),
            // ADR-0056 decision 3.
            Self::SecondFactorNeeded => f.write_str(
                "this account holds a confirmed authenticator, so its sign-in needs the \
                 verification code as well; no session is issued and the request costs its \
                 source one unit of the sign-in budget",
            ),
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

/// Everything the session layer needs, carried together as `grants::Authority`
/// is: each field is a control, and one value means no path can quietly omit
/// one.
pub struct SessionStore {
    pool: Pool,
    ring: Arc<KeyRing>,
    /// `0009`'s one-row deployment identity. Inside every challenge, so a
    /// challenge from one deployment is a challenge nowhere else.
    deployment: String,
    limits: SignInLimits,
    lifetime: Duration,
    /// ADR-0057 decision 7. `FATHOM_SESSION_ADDRESS_CHECK`, defaulted to
    /// [`AddressCheckMode::Site`] so a deployment built before this keeps its
    /// operator plane bound without a config change.
    address_check: AddressCheckMode,
}

/// What [`SessionStore::verify_account_endorsement`] returns: enough for its
/// caller to decide freshness without a second read of the row.
struct EndorsingFreshness {
    totp_verified_at_unix: Option<i64>,
    grace_token_hash: Option<[u8; 32]>,
}

impl SessionStore {
    pub fn new(pool: Pool, ring: Arc<KeyRing>, deployment: String, limits: SignInLimits) -> Self {
        Self::with_lifetime(pool, ring, deployment, limits, SESSION_LIFETIME)
    }

    /// As [`SessionStore::new`], with a lifetime other than
    /// [`SESSION_LIFETIME`].
    /// **A property of the store, not a constant read at the point of use**:
    /// otherwise the only way to observe an expiry is to move `expires_at` in
    /// SQL, which breaks the row MAC, so the test would prove the MAC and never
    /// the expiry.
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
            address_check: AddressCheckMode::default(),
        }
    }

    /// `FATHOM_SESSION_ADDRESS_CHECK`, set once at startup (`main.rs`). A
    /// builder rather than a `new` parameter, so existing callers compile
    /// unchanged with the default.
    pub fn with_address_check(mut self, mode: AddressCheckMode) -> Self {
        self.address_check = mode;
        self
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
    /// account.** A nonce row is written either way, with no principal (the
    /// composite foreign key is not enforced when a column of it is NULL), so
    /// the response cannot enumerate accounts. The refusal happens at
    /// [`SessionStore::sign_in`], after the attempt has been counted.
    ///
    /// # Two things `0014` changed here
    ///
    /// 1. **The route is rate limited against the source bucket.** It writes a
    ///    row and nothing swept: one anonymous POST was one permanent
    ///    `session_nonces` row. It costs one count, so a one-shot sign-in costs
    ///    two against `max_per_source` and a two-step one three
    ///    ([`SignInLimits::defaults`]).
    /// 2. **The claimed address's keyed hash travels on the nonce row**
    ///    ([`claimed_address_key`], `0014` §A), for every bind nonce. §4.2 keeps
    ///    the address out of the sign-in message, so this is the only place it
    ///    is known; without it the account bucket cannot be counted for an
    ///    address that belongs to nobody, and that asymmetry was an oracle over
    ///    the user list.
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
        // resolved in the same shape either way: a string naming nobody produces
        // a nonce with no principal, byte-identical to one that does, and the
        // refusal happens at sign-in after the attempt is counted.
        //
        // §4.5 gives an operator no address of record, so there is nothing else
        // to resolve them by. The id is not a secret: it is the operator plane's
        // equivalent of an address, and possession of the enrolled private key is
        // the whole of the factor.
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
    /// 1. **The source bucket is counted first**, before anything is looked up,
    ///    so rubbish is still rate limited.
    /// 2. **The nonce is consumed next**, by `DELETE ... RETURNING`. A failed
    ///    attempt burns it: fail-closed. The one exception is the second-factor
    ///    probe, and only because the whole transaction is rolled back (the
    ///    delete is undone with everything else), so no path reaches a session
    ///    on a spent nonce.
    /// 3. The account, its disabled flag, its live signing key and that key's
    ///    own row seal.
    /// 4. The evidence signature, over the challenge recomputed from the stored
    ///    nonce and the public key the caller is asking to register: **never
    ///    from anything the caller sent alongside it**.
    /// 5. The sealed `account_signin` entry, and only then the row, whose MAC
    ///    covers that entry's `seq`. No entry, no session.
    ///
    /// Every refusal between (2) and (5) is counted against the account bucket
    /// and written to the site chain with its real reason.
    ///
    /// **There is no address in this message.** The account is the one the
    /// consumed nonce names. Taking the address again would be a second, unbound
    /// statement of who is signing in: the shape §3.8 item 7 calls out for grant
    /// proposals, where anything the client returns outside the signed bytes
    /// must be re-derived rather than believed.
    pub async fn sign_in(
        &self,
        kind: PrincipalKind,
        session_pubkey: &[u8],
        nonce: &[u8; 32],
        evidence_sig: &[u8],
        source: &str,
    ) -> Result<SignedIn, SessionError> {
        self.sign_in_with_credentials(&SignInAttempt {
            kind,
            session_pubkey,
            nonce,
            evidence_sig,
            password: "",
            totp_code: "",
            source,
            account_session_id: "",
            account_session_sig: b"",
            grace_token: b"",
            user_agent: "",
        })
        .await
    }

    /// [`SessionStore::sign_in`] **widened by ADR-0055 decision 10**: the same
    /// act, with a password and an app code beside the evidence signature.
    ///
    /// # The two branches
    ///
    /// The branch is chosen by **the stored `accounts.password_hash`**, never by
    /// which fields the caller filled in: a caller who could pick the branch
    /// could pick the weaker one.
    ///
    /// 1. **`password_hash IS NULL`**: today's path. An enrolled long-term key
    ///    signs the challenge, `A1` or nothing. The operator plane is always this
    ///    branch (ADR-0055 resolution 8; the operator custody is exercised
    ///    through `/admin`).
    /// 2. **`password_hash IS NOT NULL`**: the password is **required**, the
    ///    evidence signature optional. Then:
    ///    * a valid evidence signature by any live key → `A1`;
    ///    * otherwise a verified app code → `A0T`;
    ///    * otherwise `A0`: a full session for a steward with no app code, and a
    ///      **setup session** for an account holding the operator custody,
    ///      refused by [`SessionStore::verify_request`] on every path but
    ///      `/credentials/*` until the code is enrolled.
    ///
    /// **`live_signing_key` is not called when no evidence signature was
    /// presented.** `AuthorityError::NoSigningKey` is the expected state for a
    /// password-only person, not a refusal.
    ///
    /// # The rate limits are the existing ones
    ///
    /// The password budget is `sign_in_attempts`' existing per-address counter
    /// (ten failures per fifteen minutes, a rate limit and **not** a lockout;
    /// [`SignInLimits::defaults`]) plus the per-source bucket counted before
    /// anything is looked up. A refused password goes through
    /// [`SessionStore::refuse`] as a refused signature does, so it costs and
    /// answers the same.
    ///
    /// # It costs the same in time, too
    ///
    /// The 2026-09-21 review measured an account-enumeration oracle by the
    /// clock: 498 ms for a known address with a wrong credential against 5.9 ms
    /// for an unknown one, because argon2id ran only on the branch with a stored
    /// hash. Every refusal that did **not** already run one now runs one against
    /// [`A_DECOY_HASH`]. The result is discarded; the time is the point.
    pub async fn sign_in_with_credentials(
        &self,
        attempt: &SignInAttempt<'_>,
    ) -> Result<SignedIn, SessionError> {
        let SignInAttempt {
            kind,
            session_pubkey,
            evidence_sig,
            password,
            source,
            ..
        } = *attempt;
        check_public_key(session_pubkey)?;
        // **The length check sits behind "was one presented at all"**: an empty
        // field is "no signature", which branch 2 allows and branch 1 refuses
        // later as `SignInRefused`. A NON-empty field of the wrong length is
        // malformed on either branch.
        if !evidence_sig.is_empty() && evidence_sig.len() != authority::SIGNATURE_LEN {
            return Err(SessionError::Malformed("evidence signature"));
        }

        // (1) The source bucket counts every attempt, not only failures, and **is
        // charged before the sign-in transaction opens, in a committed
        // transaction of its own** (ADR-0056 decision 3, second amendment,
        // 2026-09-22). Otherwise: the second-factor probe rolls the sign-in
        // transaction back, so a count taken inside it vanished and one challenge
        // bought unbounded password verifications; and a charge taken AFTER
        // verification on a second pool connection was cancellable by hanging up
        // and a deadlock once `pool_size` probes arrived together. Charging
        // first, on a connection returned before the next is taken, means the
        // count survives the rollback, is paid before the argon2id work it buys,
        // and never holds two connections.
        //
        // **Both buckets are rate limits, neither a lockout** (`0014` §0;
        // [`SignInLimits::defaults`]). They differ in when they are consulted:
        // the source bucket before anything is looked up, the account bucket on a
        // path that has already failed.
        let source_count = self.charge_source(source).await?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;

        // Expired rows first: this call writes to all three session tables and
        // each pays for its own growth (`0014` §C).
        sweep_expired_nonces(&tx).await?;
        sweep_expired_sessions(&tx).await?;

        if source_count > self.limits.max_per_source {
            let e = self
                .refuse(&tx, None, source, "rate_limited_source", kind)
                .await;
            leave_session_custody(&tx).await?;
            tx.commit().await?;
            return Err(e);
        }

        let outcome = self.attempt_sign_in(&tx, attempt).await;

        // **ADR-0056 decision 3: the second-factor probe is a ROLLBACK, not a
        // refusal, and costs one source unit.**
        //
        // It is a protocol step: the client has the address and credential right
        // and is asking which screen to draw. A `*_signin_failed` entry here
        // would relabel a person signing in correctly as a failure. So nothing
        // this transaction did is kept:
        //
        // * **the nonce stays unconsumed**, so step two is the SAME challenge:
        //   one `/session/challenge` for the whole two-step sign-in;
        // * **the account bucket does not move**, or a person would spend their
        //   own window on their own successful sign-ins;
        // * **no entry is written**, so an unauthenticated caller cannot choose
        //   how fast the sealed audit grows by probing.
        //
        // **What is NOT rolled back is one count against the source bucket**,
        // committed before this transaction opened (above). Rolling it back made
        // the probe free and repeatable (forty probes on one nonce for one unit
        // of budget: unlimited argon2id for anybody holding a password). A
        // separate short transaction is how a count survives a rollback; giving
        // it back by arithmetic would be a second decision about a row another
        // transaction may have moved. A caller who hangs up mid-verification has
        // already paid.
        //
        // The decoy verification is not run either: the real one has happened,
        // and a second would add half a second to every ordinary sign-in.
        //
        // **A wrong credential on the same account is untouched**: it never
        // reaches this arm, and is still sealed, counted, generic, and consumes
        // the nonce.
        if matches!(outcome, Err((_, _, SessionError::SecondFactorNeeded))) {
            tx.rollback().await?;
            return Err(SessionError::SecondFactorNeeded);
        }

        let result = match outcome {
            Ok(signed_in) => {
                // A success clears this window's failures for the account, so a
                // person who mistypes twice then succeeds is not left near the
                // cap.
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
                // **One argon2id per refused attempt that carried a credential,
                // whichever branch refused it.** `SessionError::PasswordRefused`
                // is exactly the set of refusals that already ran a real
                // verification (the gate, and the app code beyond it). Every other
                // refusal (an address that belongs to nobody, a disabled account,
                // an account with no stored hash, a nonce never issued) arrives
                // having done single-figure milliseconds of database work, and
                // that difference was the oracle measured at 85 to 1.
                //
                // **The variant, not a string**: a reason string is a label on a
                // sealed entry and could be renamed by somebody who does not know
                // this reads it.
                //
                // **Nothing is burnt when the field was empty**, and that is not a
                // hole: an empty credential short-circuits before the verification
                // on the known-address branch too (`password.is_empty() ||` at the
                // gate below), so both sides are fast and equal. It also keeps
                // key-only sign-ins and the rate-limit suites at the cost they had.
                if !matches!(error, SessionError::PasswordRefused) && !password.is_empty() {
                    let _ = credentials::verify_password(A_DECOY_HASH, password);
                }
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

    /// Count one attempt against the source bucket §13 item 7 keeps (the same
    /// `sign_in_attempts` rows, window and cap) and refuse over it as
    /// [`SessionStore::issue_challenge`] and [`SessionStore::sign_in`] do: the
    /// same [`SessionError::RateLimited`] with the same `Retry-After`.
    ///
    /// **For a caller with no session to compose [`sign_in`](Self::sign_in)
    /// with**: `admin.rs`'s two enrolment-redemption routes, which serve an
    /// unauthenticated caller and had no rate limit at all. This is not a second
    /// limiter: it is `count_attempt`/`refuse`. A source that has spent its
    /// budget guessing addresses at `/session` has spent it here too, and the
    /// reverse.
    ///
    /// `kind` picks which site-chain type the cap's own sealed entry is filed
    /// under when it fires ([`EntryType::AccountSigninFailed`] or
    /// [`EntryType::OperatorSigninFailed`]), matching the redemption route
    /// reached. A redemption is not a sign-in; these types are used because §13
    /// item 7's *"one entry per (source, window)"* latch lives on them and a
    /// third type would need a migration.
    ///
    /// [`EntryType::AccountSigninFailed`]: crate::chain::EntryType::AccountSigninFailed
    /// [`EntryType::OperatorSigninFailed`]: crate::chain::EntryType::OperatorSigninFailed
    pub async fn check_source_budget(
        &self,
        kind: PrincipalKind,
        source: &str,
    ) -> Result<(), SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;

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

        leave_session_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// **`GET /setup/state`'s own per-source budget**, counted in the same
    /// window and table as the sign-in one but in a bucket of its own: the key is
    /// `setup-state:` + the source, under the `source` kind `0013` §D has (the
    /// `reset:` prefix on the account bucket is the precedent for another budget
    /// without a migration).
    ///
    /// **Why it is not the sign-in bucket.** The state route is a page load,
    /// asked before the client knows whether to draw the setup flow or the
    /// sign-in door, and again on every reload. Charged to the sign-in bucket,
    /// an office behind one address that reloaded enough had its sign-ins refused
    /// by its own page loads, and a 429 here takes the FIRST-RUN screen away, so
    /// a pending deployment looks finished to everyone behind that address. Two
    /// buckets keep each fault inside its own route.
    ///
    /// The cap is [`SETUP_STATE_MAX_PER_SOURCE`] and the refusal is the ordinary
    /// [`SessionError::RateLimited`] with the usual `Retry-After`.
    ///
    /// **It writes no sealed entry.** A sign-in failure is a fact an operator
    /// wants; a page reload is not, and an unauthenticated caller choosing how
    /// fast the sealed audit grows is the amplifier `0014` §B is written against.
    pub async fn check_setup_state_budget(&self, source: &str) -> Result<(), SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;
        let key = format!("setup-state:{source}");
        let count = self.count_attempt(&tx, "source", &key).await?.unwrap_or(0);
        leave_session_custody(&tx).await?;
        tx.commit().await?;

        if count > SETUP_STATE_MAX_PER_SOURCE {
            // The line names the bucket, not the person: a source address is what
            // an operator needs to see a flood by.
            tracing::info!(
                bucket = %key,
                "a source has spent its setup-state budget for this window"
            );
            return Err(SessionError::RateLimited {
                retry_after_seconds: seconds_left_in_window(self.limits.window),
            });
        }
        Ok(())
    }

    /// **The source bucket's count for one sign-in request, committed on its own
    /// before the sign-in transaction opens**, and the count it reached.
    ///
    /// Its own transaction because the sign-in's may be rolled back (the
    /// second-factor probe, ADR-0056 decision 3) and a count that vanished with
    /// it made the probe free (forty password verifications on one challenge,
    /// 2026-09-22). Its own *connection*, returned before the sign-in takes one,
    /// because holding two at once would deadlock `pool_size` concurrent probes.
    ///
    /// **It counts and does not refuse.** The caller compares the count against
    /// the cap and refuses inside the sign-in transaction, so the sealed
    /// `rate_limited_source` entry is unchanged.
    async fn charge_source(&self, source: &str) -> Result<i32, SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;
        let count = self
            .count_attempt(&tx, "source", source)
            .await?
            .unwrap_or(0);
        leave_session_custody(&tx).await?;
        tx.commit().await?;
        Ok(count)
    }

    /// **The per-address budget for "forgot my password"**, counted against the
    /// claimed-address bucket `0014` §A keeps under the `reset:` prefix `0018` §D
    /// names.
    ///
    /// ADR-0055 decision 7 asks for per-account and per-source limits; only the
    /// per-source one was wired, and the 2026-09-21 review found ten requests for
    /// one address from one source gave ten simultaneously live 24-hour tokens
    /// and ten sealed entries. Distributed, it was unbounded per victim: a
    /// mail-bomb aimed at a named address once these links are mailed, and today
    /// an unauthenticated caller choosing how fast the sealed audit grows
    /// (`0014` §B, `0015` §F).
    ///
    /// **Returns whether the request is within budget, never an error a caller
    /// could tell addresses apart by.** `false` means the route does nothing and
    /// answers as always (decision 7: *"the same answer and timing for every
    /// address"*). It is not [`SessionError::RateLimited`]: a 429 would say "this
    /// address has asked recently", the enumeration the uniform 200 exists to
    /// prevent.
    ///
    /// **The bucket key is the keyed hash, not the address**, for
    /// [`claimed_address_key`]'s reason. An address that belongs to nobody is
    /// counted identically.
    pub async fn check_reset_budget(&self, address: &str) -> Result<bool, SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;

        let claimed = claimed_address_key(&grants::site_chain_key(&tx, &self.ring).await?, address);
        let key = format!("reset:{}", hex(&claimed));
        let count = self.count_attempt(&tx, "account", &key).await?.unwrap_or(0);

        leave_session_custody(&tx).await?;
        tx.commit().await?;

        let within = count <= self.limits.max_per_account;
        if !within {
            // The log line says a bucket closed and names no address: the keyed
            // hash is not a name to anybody holding the log either.
            tracing::info!(bucket = %key, "a reset bucket has spent its budget for this window");
        }
        Ok(within)
    }

    /// Charges the account and source buckets once, before anything is
    /// verified, so a right guess is refused too once a bucket is over cap.
    pub async fn charge_credential_refusal(
        &self,
        account: &str,
        source: &str,
    ) -> Result<(), SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;
        let account_count = self
            .count_attempt(&tx, "account", account)
            .await?
            .unwrap_or(0);
        let source_count = self
            .count_attempt(&tx, "source", source)
            .await?
            .unwrap_or(0);
        leave_session_custody(&tx).await?;
        tx.commit().await?;
        if account_count > self.limits.max_per_account || source_count > self.limits.max_per_source
        {
            Err(SessionError::RateLimited {
                retry_after_seconds: seconds_left_in_window(self.limits.window),
            })
        } else {
            Ok(())
        }
    }

    /// Gives back the unit [`Self::charge_credential_refusal`] reserved for
    /// an attempt that then succeeded — a successful change spends nothing.
    pub async fn refund_credential_charge(&self, account: &str, source: &str) {
        let Ok(mut client) = self.pool.get().await else {
            return;
        };
        let Ok(tx) = client.transaction().await else {
            return;
        };
        if enter_session_custody(&tx).await.is_err() {
            return;
        }
        for (kind, key) in [("account", account), ("source", source)] {
            let key = self::bucket_key(key);
            if key.is_empty() {
                continue;
            }
            let _ = tx
                .execute(
                    "UPDATE sign_in_attempts SET attempts = GREATEST(attempts - 1, 0) \
                      WHERE bucket_kind = $1 AND bucket_key = $2 AND window_start = $3",
                    &[&kind, &key, &window_start(self.limits.window)],
                )
                .await;
        }
        let _ = leave_session_custody(&tx).await;
        let _ = tx.commit().await;
    }

    /// A fresh signature by a live enrolled key over a bind-purpose
    /// challenge — what a no-password account's first password change needs.
    pub async fn verify_fresh_evidence(
        &self,
        account: &str,
        session_pubkey: &[u8],
        nonce: &[u8; 32],
        evidence_sig: &[u8],
    ) -> Result<(), SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;

        let consumed = tx
            .query_opt(
                "DELETE FROM session_nonces \
                  WHERE nonce = $1 AND purpose = 'bind' AND expires_at > now() \
                  RETURNING session_pubkey, principal_id, principal_kind",
                &[&nonce.to_vec()],
            )
            .await?;
        let Some(consumed) = consumed else {
            leave_session_custody(&tx).await?;
            tx.commit().await?;
            return Err(SessionError::SignInRefused);
        };
        let bound_pubkey: Vec<u8> = consumed.get(0);
        let principal: Option<String> = consumed.get(1);
        let principal_kind: Option<String> = consumed.get(2);
        if bound_pubkey != session_pubkey
            || principal.as_deref() != Some(account)
            || principal_kind.as_deref() != Some(PrincipalKind::Steward.as_str())
        {
            leave_session_custody(&tx).await?;
            tx.commit().await?;
            return Err(SessionError::SignInRefused);
        }

        set_account_id(&tx, account).await?;
        let challenge = session_challenge(session_pubkey, nonce, &self.deployment);
        let verified = grants::verify_by_any_live_key(
            &tx,
            &self.ring,
            account,
            &challenge,
            evidence_sig,
            now_unix(),
        )
        .await;

        leave_session_custody(&tx).await?;
        tx.commit().await?;
        verified
            .map(|_| ())
            .map_err(|_| SessionError::SignInRefused)
    }

    /// The part of [`SessionStore::sign_in`] that can fail without the
    /// transaction being poisoned. Returns the bucket the failure belongs to
    /// alongside the error, so it can be counted against the right one.
    #[allow(clippy::type_complexity)]
    async fn attempt_sign_in(
        &self,
        tx: &Transaction<'_>,
        attempt: &SignInAttempt<'_>,
    ) -> Result<(String, SignedIn), (Option<AccountBucket>, &'static str, SessionError)> {
        let SignInAttempt {
            kind,
            session_pubkey,
            nonce,
            evidence_sig,
            password,
            totp_code,
            account_session_id,
            account_session_sig,
            ..
        } = *attempt;
        // (2) Consume the nonce. `DELETE ... RETURNING` is the whole of "single
        // use": no row back means never issued, already used, or expired: one
        // fact from here.
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
            // **No bucket, and that is not a hole.** A nonce never issued names
            // no claimed identity, so there is nothing to count it against, and a
            // known and an unknown address reach this branch identically, which
            // is what matters. The source bucket has already counted the attempt.
            return Err((None, "nonce_not_fresh", SessionError::SignInRefused));
        };

        // Which bucket this attempt belongs to, decided before anything can
        // fail: the account the nonce named or, when none, the keyed hash of the
        // claimed address (`0014` §A). **Both are counted**; counting only the
        // first was the account oracle.
        let principal: Option<String> = consumed.get(1);
        let claimed: Option<Vec<u8>> = consumed.get(3);
        let bucket = match (&principal, &claimed) {
            (Some(account), _) => Some(AccountBucket::Account(account.clone())),
            (None, Some(key)) => Some(AccountBucket::ClaimedAddress(hex(key))),
            (None, None) => None,
        };

        // The challenge is derived over the key the nonce was issued for.
        // Registering a different key than the one challenged is refused here:
        // §4.2's *"the assertion is accepted only if the challenge inside it
        // recomputes from the session_pubkey the client is asking to register"*.
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
            // The claimed identity (an address on the account plane, an operator
            // id on the operator plane) resolved to nobody. One answer for both
            // planes and reasons.
            return Err((bucket, "no_such_principal", SessionError::SignInRefused));
        };
        if principal_kind.as_deref() != Some(kind.as_str()) {
            return Err((
                Some(AccountBucket::Account(account)),
                "principal_kind_mismatch",
                SessionError::SignInRefused,
            ));
        }

        // (3) The principal, whether it may sign in at all, and the key it signs
        // with. **Two planes, one shape.** An account has a disabled flag and a
        // keyring row; an operator has the same plus a check that the register
        // row itself verifies. Every refusal below is the other plane's refusal,
        // so the two cannot be told apart from outside.
        let now = now_unix();
        // **ADR-0055 stream (a): the credential branch, chosen by the STORED
        // hash, never by which fields the caller filled in.** `None` on the
        // operator plane always (resolution 8) and on any account with no
        // password set (every account that existed before this build).
        let credentials = match kind {
            PrincipalKind::Steward => credentials::read_credentials(tx, &self.ring, &account)
                .await
                .map_err(|_| {
                    (
                        Some(AccountBucket::Account(account.clone())),
                        "database",
                        SessionError::Corrupt("account credentials"),
                    )
                })?,
            PrincipalKind::Operator => None,
        };
        let by_password = credentials
            .as_ref()
            .and_then(|c| c.password_hash.clone())
            .is_some();

        // Derived here because the account plane verifies the evidence signature
        // WHILE resolving the key: `0055` resolution 1 accepts any live key of
        // the account, so "which key" and "does it verify" are one question.
        let challenge = session_challenge(session_pubkey, nonce, &self.deployment);

        let key: Option<SignInKey> = match kind {
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

                // `account_keys` is read through a policy showing an account its
                // own rows when `app.account_id` names it. Sign-in is exactly that
                // case: the account is the one the consumed nonce named, never one
                // the caller supplied.
                set_account_id(tx, &account)
                    .await
                    .map_err(|e| (Some(AccountBucket::Account(account.clone())), "database", e))?;

                // **The keyring is NOT read on the credential branch when no
                // signature was presented.** `NoSigningKey` is the expected state
                // for a password-only person, and refusing it would lock out
                // exactly the people ADR-0055 decision 6 is for.
                if evidence_sig.is_empty() {
                    if by_password {
                        None
                    } else {
                        // Branch 1 with nothing presented at all. The same uniform
                        // refusal a wrong signature gets: telling the two apart
                        // tells a caller which field they got right.
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "no_evidence",
                            SessionError::SignInRefused,
                        ));
                    }
                } else {
                    // **Any live key of the account, not the newest** (resolution
                    // 1; `grants::verify_by_any_live_key` carries the argument):
                    // the client registers a per-browser key after every password
                    // sign-in, so one person on two machines has two live keys and
                    // neither supersedes the other.
                    match grants::verify_by_any_live_key(
                        tx,
                        &self.ring,
                        &account,
                        &challenge,
                        evidence_sig,
                        now,
                    )
                    .await
                    {
                        Ok(key) => Some(SignInKey {
                            id: key.id,
                            fpr: key.fpr,
                        }),
                        Err(AuthorityError::NoSigningKey) if by_password => None,
                        Err(AuthorityError::Signature(_)) if by_password => {
                            // The password is still checked below. A signature
                            // that did not verify costs the session its `A1` and
                            // nothing else.
                            None
                        }
                        Err(AuthorityError::NoSigningKey) => {
                            return Err((
                                Some(AccountBucket::Account(account)),
                                "no_signing_key",
                                SessionError::SignInRefused,
                            ))
                        }
                        Err(AuthorityError::Signature(_)) => {
                            return Err((
                                Some(AccountBucket::Account(account)),
                                "evidence_signature",
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
                            return Err((
                                Some(AccountBucket::Account(account)),
                                "keyring",
                                e.into(),
                            ))
                        }
                    }
                }
            }
            PrincipalKind::Operator => {
                // **The register row is verified, not merely read.**
                // `operators::verify_operator_row` recomputes its seal AND checks
                // the site-chain entry that created it (§5.4's interlock applied
                // to the register), so an operator row minted by whoever holds the
                // database cannot sign in.
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

                // ADR-0057 decision 2: Site needs the account. The operator key
                // alone no longer opens a session: a live session of the
                // operator's own bound account must also endorse this attempt,
                // over its own challenge, or it is refused as a bad operator key
                // is.
                let endorsing_account = operators::account_of_operator(tx, &self.ring, &account)
                    .await
                    .map_err(|e| match e {
                        operators::OperatorError::Unverifiable(what) => (
                            Some(AccountBucket::Account(account.clone())),
                            "operator_binding_unverifiable",
                            SessionError::Unverifiable(what),
                        ),
                        _ => (
                            Some(AccountBucket::Account(account.clone())),
                            "operator_not_bound",
                            SessionError::SignInRefused,
                        ),
                    })?;
                let freshness = self
                    .verify_account_endorsement(
                        tx,
                        &endorsing_account,
                        account_session_id,
                        account_session_sig,
                        &challenge,
                        attempt.source,
                    )
                    .await
                    .map_err(|e| {
                        (
                            Some(AccountBucket::Account(account.clone())),
                            "account_session_endorsement",
                            e,
                        )
                    })?;

                // Freshness: a stale or absent TOTP proof on the endorsing session
                // needs a current code beside it, answered with the typed
                // `SecondFactorNeeded` of ADR-0056 decision 3 so the caller learns
                // to ask for one rather than being refused outright.
                //
                // **ADR-0057 decision 6.** Time alone is not enough: the browser
                // must also present the grace token that same sign-in minted,
                // matching the hash the endorsing row holds, a value that lives
                // only in that tab's memory (never IndexedDB), so a reload or
                // copied profile cannot produce it.
                let fresh = match (freshness.totp_verified_at_unix, freshness.grace_token_hash) {
                    (Some(at), Some(hash)) => {
                        now.saturating_sub(at) <= SECOND_FACTOR_FRESHNESS.as_secs() as i64
                            && !attempt.grace_token.is_empty()
                            && same_bytes(&Sha256::digest(attempt.grace_token), &hash)
                                .unwrap_or(false)
                    }
                    _ => false,
                };
                if !fresh {
                    if totp_code.is_empty() {
                        return Err((
                            Some(AccountBucket::Account(account.clone())),
                            "operator_second_factor_needed",
                            SessionError::SecondFactorNeeded,
                        ));
                    }
                    let credentials_row =
                        credentials::read_credentials(tx, &self.ring, &endorsing_account)
                            .await
                            .map_err(|_| {
                                (
                                    Some(AccountBucket::Account(account.clone())),
                                    "database",
                                    SessionError::Corrupt("account credentials"),
                                )
                            })?
                            .ok_or_else(|| {
                                (
                                    Some(AccountBucket::Account(account.clone())),
                                    "no_such_account",
                                    SessionError::SignInRefused,
                                )
                            })?;
                    let checked = self
                        .check_second_factor(tx, &endorsing_account, &credentials_row, totp_code)
                        .await
                        .map_err(|e| (Some(AccountBucket::Account(account.clone())), "totp", e))?;
                    if !checked {
                        return Err((
                            Some(AccountBucket::Account(account.clone())),
                            "operator_totp_refused",
                            SessionError::PasswordRefused,
                        ));
                    }
                }

                match operators::live_operator_keys(tx, &self.ring, &account, now).await {
                    Ok(keys) if !keys.is_empty() => {
                        // **The operator plane verifies here**, as the account
                        // plane now does: resolution 8 keeps `kind = 'operator'` a
                        // key sign-in, so there is one signature and no password to
                        // fall back to (§4.5: an operator session is `A1` or it
                        // does not exist).
                        //
                        // **Any live key, not the newest** (ADR-0055 decision 6,
                        // resolution 1): an operator who registered a second
                        // browser's key keeps the first's. The signature names
                        // which one by verifying under it.
                        let Some(key) = keys.into_iter().find(|key| {
                            authority::verify_es256(&key.public_key, &challenge, evidence_sig)
                                .is_ok()
                        }) else {
                            return Err((
                                Some(AccountBucket::Account(account)),
                                "evidence_signature",
                                SessionError::SignInRefused,
                            ));
                        };
                        Some(SignInKey {
                            id: key.id,
                            fpr: key.fpr,
                        })
                    }
                    Ok(_) => {
                        // §4.5: `A1` or no session. No key, no session, and no
                        // weaker factor to fall back to.
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "no_signing_key",
                            SessionError::SignInRefused,
                        ));
                    }
                    Err(operators::OperatorError::Unverifiable(what)) => {
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "operator_keyring_unverifiable",
                            SessionError::Unverifiable(what),
                        ))
                    }
                    Err(_) => {
                        // §4.5: `A1` or no session. No key, no session, and no
                        // weaker factor to fall back to.
                        return Err((
                            Some(AccountBucket::Account(account)),
                            "no_signing_key",
                            SessionError::SignInRefused,
                        ));
                    }
                }
            }
        };

        // (4) The factors. **The password first when there is one**, so no later
        // check is reachable without it: decision 10's "the password is
        // required" is a gate, not one of several ways in.
        //
        // The evidence signature was already verified above by whichever live
        // key made it: `key` is `Some` exactly when one verified it.
        let mut assurance = Assurance::A1;
        // ADR-0057 decision 2: whether this sign-in itself verified a TOTP code,
        // for the row's `totp_verified_at`.
        let mut totp_verified_now = false;

        if by_password {
            let row = credentials
                .as_ref()
                .expect("by_password is read off this row");
            let stored = row
                .password_hash
                .as_deref()
                .expect("by_password is exactly this field being set");
            if password.is_empty() || !credentials::verify_password(stored, password) {
                return Err((
                    Some(AccountBucket::Account(account)),
                    "password_refused",
                    SessionError::PasswordRefused,
                ));
            }

            // The app code, when one is enrolled. Six digits is a TOTP code;
            // anything else is tried as a backup code (resolution 3), so a lost
            // phone is recoverable without a second form field.
            if row.totp_confirmed() {
                // **ADR-0056 decision 3, step one.** An empty code on an account
                // with a confirmed authenticator is the client asking which screen
                // to draw, not a failed attempt: it has the address and credential
                // right and nothing left to guess. Answered before
                // `check_second_factor`, so no step is spent and no backup code is
                // tried against an empty string; the caller rolls this transaction
                // back, so the nonce consumed at (2) is still there for step two.
                //
                // An account with NO confirmed authenticator falls through to the
                // branch below and still gets its `A0` session on an empty code.
                if totp_code.is_empty() {
                    return Err((
                        Some(AccountBucket::Account(account)),
                        "second_factor_needed",
                        SessionError::SecondFactorNeeded,
                    ));
                }
                let checked = self
                    .check_second_factor(tx, &account, row, totp_code)
                    .await
                    .map_err(|e| (Some(AccountBucket::Account(account.clone())), "totp", e))?;
                if !checked {
                    return Err((
                        Some(AccountBucket::Account(account)),
                        "totp_refused",
                        SessionError::PasswordRefused,
                    ));
                }
                assurance = Assurance::A0T;
                totp_verified_now = true;
            } else {
                // No app code yet. A steward with no operator custody gets a full
                // `A0` session (design §5.1) and reaches the screen that sets one
                // up. An account that HOLDS the operator custody gets the same
                // `A0`, and `verify_inside` refuses it everywhere but
                // `/credentials/*` (decision 10): a refusal rather than a redirect,
                // so a client that ignores it gets nothing.
                assurance = Assurance::A0;
            }

            // A verified evidence signature still outranks both: decision 6 keeps
            // the browser-held key as the strongest factor, and resolution 1 says
            // a valid one means `A1`.
            if key.is_some() {
                assurance = Assurance::A1;
            }
        }

        // The key is recorded on the row only when it is what established the
        // session. `0013`'s `CHECK ((assurance = 'A1') = (evidence_sig IS NOT
        // NULL))` still holds: `A0` and `A0T` carry neither.
        let key = match assurance {
            Assurance::A1 => key,
            Assurance::A0 | Assurance::A0T => None,
        };
        let evidence_sig: &[u8] = if key.is_some() { evidence_sig } else { b"" };

        // (5) The entry first, then the row whose MAC covers its seq.
        let id = ids::new_ulid().to_string();
        let token = random_32()
            .map_err(|e| (Some(AccountBucket::Account(account.clone())), "random", e))?;
        let digest = key
            .as_ref()
            .map(|_| evidence_digest(&challenge, evidence_sig));
        // §7.2 names both; which one this is is the one fact a reader of the site
        // chain can group by without the metadata key.
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
                    ("assurance", Json::Str(assurance.as_str().to_string())),
                    (
                        "evidence_key",
                        match &key {
                            Some(key) => Json::Str(key.id.clone()),
                            None => Json::Null,
                        },
                    ),
                    (
                        "key_fpr",
                        match &key {
                            Some(key) => Json::Str(hex(&key.fpr)),
                            None => Json::Null,
                        },
                    ),
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

        // Not a client-supplied number (the clock and a constant), and checked
        // anyway, so a reader auditing every addition on this path need not work
        // out which are safe.
        let expires_at_unix = now.saturating_add(self.lifetime.as_secs() as i64);

        // ADR-0057 decision 6: minted only when this sign-in just verified a
        // fresh TOTP code on the steward plane. The browser holds it in memory
        // alone; this deployment keeps only its hash, under the row MAC like
        // `totp_verified_at`, so a disk copy of the session never carries the
        // fact that lets a later operator sign-in skip the code.
        let grace_token = if totp_verified_now {
            Some(
                random_32()
                    .map_err(|e| (Some(AccountBucket::Account(account.clone())), "random", e))?,
            )
        } else {
            None
        };
        let grace_token_hash = grace_token.map(|t| Sha256::digest(t).into());

        // ADR-0057 decision 7: the class this session is bound to, from the
        // address the source bucket already counted. `None` when it could not be
        // classed (unknown peer, unparseable address), so it is never compared
        // and never wrongly ended.
        let bound_address_class = crate::client_address::address_class(attempt.source);

        // ADR-0057 decision 8: derived once, here; there is no stored header to
        // re-derive it from later.
        let browser_label = Some(crate::browser_label::label(attempt.user_agent));

        let row = SessionRow {
            id: id.clone(),
            principal_id: account.clone(),
            principal_kind: kind,
            token_hash: token_hash(&token),
            session_pubkey: session_pubkey.to_vec(),
            bound_nonce: *nonce,
            evidence_key_id: key.as_ref().map(|k| k.id.clone()),
            evidence_sig: key.as_ref().map(|_| evidence_sig.to_vec()),
            assertion_digest: digest,
            assurance,
            chain_seq: appended.seq,
            row_version: 1,
            issued_at_unix: now,
            expires_at_unix,
            request_counter: 0,
            totp_verified_at_unix: totp_verified_now.then_some(now),
            grace_token_hash,
            bound_address_class: bound_address_class.clone(),
            browser_label: browser_label.clone(),
            // A row just minted is zero seconds idle; the real value matters only
            // on a row `read_session` reads back.
            idle_seconds: 0,
            stored_row_mac: Vec::new(),
        };
        let mac = self
            .row_mac(tx, &row)
            .await
            .map_err(|e| (Some(AccountBucket::Account(account.clone())), "row mac", e))?;

        // §5.5's *"the seconder has an independent sign-in on record"*, taken
        // once, on the operator plane only, here because this is the only place a
        // sign-in happens.
        if kind == PrincipalKind::Operator {
            operators::mark_first_independent_signin(tx, &self.ring, &account)
                .await
                .map_err(|_| {
                    (
                        Some(AccountBucket::Account(account.clone())),
                        "database",
                        SessionError::Corrupt("operator register"),
                    )
                })?;
        }

        // **One value, two columns, two foreign keys** (`0015` §B2). The key that
        // proved this session is in `account_keys` or `operator_keys`, never
        // both, and referential integrity is the only mechanism that answers
        // "does it exist" the same way for every caller (a trigger reading either
        // keyring answers "is it visible to me", the wrong question).
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
                  evidence_operator_key_id, totp_verified_at, grace_token_hash, \
                  bound_address_class, browser_label) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, \
                     to_timestamp($13), to_timestamp($13), to_timestamp($14), 1, $15, $16, \
                     to_timestamp($17), $18, $19, $20)",
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
                &row.totp_verified_at_unix.map(|v| v as f64),
                &row.grace_token_hash.map(|h| h.to_vec()),
                &row.bound_address_class,
                &row.browser_label,
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
            account.clone(),
            SignedIn {
                session_id: id,
                token,
                expires_at_unix,
                account_id: account,
                grace_token,
            },
        ))
    }

    /// ADR-0057 decision 2: the account session endorsing an operator sign-in.
    /// Checked before the operator's own key, so a stolen operator key alone
    /// stops here.
    ///
    /// Live (not expired, not idle-dead, not signed out, row MAC intact), naming
    /// `account`, and signing `challenge` (the operator sign-in's challenge
    /// digest) with the key that session was issued. Returns when that session
    /// last verified a TOTP code and the hash of its decision-6 grace token, for
    /// the caller to weigh against [`SECOND_FACTOR_FRESHNESS`] and a presented
    /// grace token.
    ///
    /// **Also checked against decision 7's address binding**, under the rules a
    /// live request on this session faces: recorded under `site`, ended under
    /// `all`. An ended endorsing session refuses like any other reason; the
    /// ending runs on `tx`, which `attempt_sign_in`'s caller commits regardless
    /// of outcome.
    async fn verify_account_endorsement(
        &self,
        tx: &Transaction<'_>,
        account: &str,
        account_session_id: &str,
        account_session_sig: &[u8],
        challenge: &[u8; 32],
        source: &str,
    ) -> Result<EndorsingFreshness, SessionError> {
        if account_session_id.is_empty() {
            return Err(SessionError::SignInRefused);
        }
        let Some(row) = read_session(tx, account_session_id).await? else {
            return Err(SessionError::SignInRefused);
        };
        if is_revoked(tx, &row.id).await? {
            return Err(SessionError::SignInRefused);
        }
        self.check_row_mac(tx, &row).await?;
        if row.expires_at_unix <= now_unix() {
            return Err(SessionError::SignInRefused);
        }
        // ADR-0057 decision 4: an idle-dead session endorses nothing, as one past
        // its absolute lifetime does not. Not deleted here (this row is not the
        // one this request is signed with); its idle death belongs to the next
        // request made under it, through `verify_inside`.
        if row.idle_seconds >= idle_limit_seconds(PrincipalKind::Steward) {
            return Err(SessionError::SignInRefused);
        }
        if row.principal_kind != PrincipalKind::Steward || row.principal_id != account {
            return Err(SessionError::SignInRefused);
        }
        authority::verify_es256(&row.session_pubkey, challenge, account_session_sig)
            .map_err(|_| SessionError::SignInRefused)?;
        if self.address_check != AddressCheckMode::Off {
            self.check_session_address_inside(tx, &row.id, source)
                .await
                .map_err(|_| SessionError::SignInRefused)?;
        }
        Ok(EndorsingFreshness {
            totp_verified_at_unix: row.totp_verified_at_unix,
            grace_token_hash: row.grace_token_hash,
        })
    }

    /// The second factor at sign-in: an app code, or a backup code standing in
    /// for one.
    ///
    /// **Six digits is a TOTP code; anything else is tried as a backup code**
    /// (resolution 3). One form field, so a person whose phone is in the other
    /// room types what they have and it works.
    ///
    /// **The replay refusal is the guarded `UPDATE`, not the `<=` in
    /// `credentials::verify_totp`.** The `<=` alone was no refusal under
    /// concurrency (2026-09-21 review): the mark is read by a plain `SELECT` in
    /// `credentials::read_credentials`, so simultaneous sign-ins all decide
    /// against the same stale high-water mark and all advance it. Three
    /// simultaneous `POST /session` calls with **one** six-digit code opened
    /// three sessions. The per-source row lock in `sign_in_attempts` had masked
    /// it, but it serialises attempts from one address only.
    ///
    /// So the advance **is** the guard, as in `credentials::spend_backup_code`:
    /// the `WHERE` clause carries the comparison and a row count of zero means
    /// another transaction took this step first. `READ COMMITTED` makes it true:
    /// the loser blocks on the winner's row lock and re-evaluates the `WHERE`
    /// against the committed row (PostgreSQL 17 §13.2.1, read 2026-09-21).
    ///
    /// It is committed in **this** transaction: `0018` §B requires
    /// `totp_last_step` to move inside the sign-in transaction so a request that
    /// crashed after verifying but before advancing cannot leave a code
    /// spendable twice.
    async fn check_second_factor(
        &self,
        tx: &Transaction<'_>,
        account: &str,
        row: &credentials::CredentialRow,
        code: &str,
    ) -> Result<bool, SessionError> {
        if code.is_empty() {
            return Ok(false);
        }
        let six_digits = code.chars().count() == 6 && code.chars().all(|c| c.is_ascii_digit());
        if !six_digits {
            return credentials::spend_backup_code(tx, &self.ring, &self.deployment, account, code)
                .await
                .map_err(|_| SessionError::Corrupt("backup code"));
        }

        let key = credentials::totp_key_for(tx, &self.ring)
            .await
            .map_err(|_| SessionError::Corrupt("credential key"))?;
        let secret = row
            .totp_secret(&key, &self.deployment, account)
            .map_err(|_| SessionError::Corrupt("totp secret"))?;
        let Some(secret) = secret else {
            return Ok(false);
        };
        let Some(step) = credentials::verify_totp(&secret, code, now_unix(), row.totp_last_step)
        else {
            return Ok(false);
        };
        // ADR-0055 decision 10, *"a code accepted once"*: the earlier
        // read-then-decide comparison, made again where it is atomic. Zero rows
        // is a refusal, not a failure: another sign-in in flight spent this step.
        let advanced = tx
            .execute(
                "UPDATE accounts SET totp_last_step = $2 \
                  WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)",
                &[&account, &step],
            )
            .await?;
        if advanced != 1 {
            return Ok(false);
        }
        // The credential seal (`0025`) covers whether the step is set, so the
        // advance that confirms a code at sign-in is re-sealed in the same
        // transaction; the hook checks the row really is at `step`.
        credentials::reseal_after_totp_step(tx, &self.ring, account, step)
            .await
            .map_err(|_| SessionError::Corrupt("credential seal"))?;
        Ok(true)
    }

    /// ADR-0057 decision 8's "authenticated again": a current authenticator code
    /// or a live backup code, reusing [`SessionStore::check_second_factor`].
    /// Charges no budget of its own: the caller charges and refunds `account`'s
    /// existing credential budget around it.
    pub async fn verify_current_code(
        &self,
        account: &str,
        code: &str,
    ) -> Result<bool, SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;
        let result: Result<bool, SessionError> = async {
            let Some(row) = credentials::read_credentials(&tx, &self.ring, account)
                .await
                .map_err(|_| SessionError::Corrupt("account credentials"))?
            else {
                return Ok(false);
            };
            self.check_second_factor(&tx, account, &row, code).await
        }
        .await;
        leave_session_custody(&tx).await?;
        tx.commit().await?;
        result
    }

    /// Count a failure against its account bucket, write the sealed entry if
    /// this is the refusal that gets to record itself, and say whether the
    /// bucket has now closed.
    ///
    /// # Which refusals write an entry, and why not all of them
    ///
    /// `0013` §D's rule was *"once per window rather than once per refused
    /// request"*, but its latch was taken only when a bucket had already closed.
    /// For an ANONYMOUS failure no account bucket was counted, so nothing ever
    /// closed and an entry was appended on every attempt: an unauthenticated
    /// caller chose how fast the sealed audit grew, the amplifier the rule
    /// exists to prevent. Counting a claimed-address bucket (`0014` §A) does not
    /// fix it alone: the attacker varies the address and gets a fresh bucket,
    /// cap and run of entries.
    ///
    /// So, in this order:
    ///
    /// 1. **The source cap itself.** `locked_entry_written` on the source row:
    ///    one entry per (source, window), the fact an operator wants.
    /// 2. **Any other anonymous failure** (no account resolved: unknown address,
    ///    or a nonce naming nobody). `anon_entry_written` on the source row: at
    ///    most one entry per (source, window) however many addresses are
    ///    sprayed.
    /// 3. **A failure against a resolved account.** One entry per attempt up to
    ///    that account's cap, then one more when it closes. Bounded by the
    ///    account bucket, and an attacker cannot inflate it without holding the
    ///    address, a signal worth keeping.
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
            // attempt through un-refused: the refusal stands either way and only
            // the rate limit is lost.
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
            let account = match bucket {
                Some(AccountBucket::Account(account)) => Some(account.as_str()),
                _ => None,
            };
            let claimed = match bucket {
                Some(AccountBucket::ClaimedAddress(key)) => Some(key.as_str()),
                _ => None,
            };
            self.append_sign_in_refusal(tx, kind, account, claimed, reason, locked)
                .await;
        }

        if locked {
            SessionError::RateLimited {
                retry_after_seconds: seconds_left_in_window(self.limits.window),
            }
        } else {
            SessionError::SignInRefused
        }
    }

    /// One sealed `*_signin_failed` entry, in the one spelling
    /// [`SessionStore::refuse`] writes it.
    ///
    /// **Named rather than inlined, with one caller on purpose.** The ADR-0056
    /// build gave it a second (the second-factor probe sealed a refusal of its
    /// own) and the 2026-09-22 review found that entry relabelling successful
    /// sign-ins as failures and bypassing the once-per-window latch. The probe
    /// is a rollback now ([`SessionStore::sign_in_with_credentials`]) and writes
    /// nothing, so a future second caller has to come past that history.
    ///
    /// A failure to append is swallowed, as it was inside `refuse`: the refusal
    /// stands whether or not the record could be written, and the append logs
    /// its own failure.
    ///
    /// `claimed_address_key` is the keyed hash, never the address (`0014` §A): an
    /// operator can group a spray by it, and it is not a list of what people
    /// typed.
    async fn append_sign_in_refusal(
        &self,
        tx: &Transaction<'_>,
        kind: PrincipalKind,
        account: Option<&str>,
        claimed_address_key: Option<&str>,
        reason: &'static str,
        rate_limited: bool,
    ) {
        let entry_type = match kind {
            PrincipalKind::Steward => EntryType::AccountSigninFailed,
            PrincipalKind::Operator => EntryType::OperatorSigninFailed,
        };
        let metadata = entry_metadata(
            entry_type,
            &[
                (
                    "account",
                    match account {
                        Some(account) => Json::Str(account.to_string()),
                        None => Json::Null,
                    },
                ),
                (
                    "claimed_address_key",
                    match claimed_address_key {
                        Some(key) => Json::Str(key.to_string()),
                        None => Json::Null,
                    },
                ),
                ("reason", Json::Str(reason.to_string())),
                ("principal_kind", Json::Str(kind.as_str().to_string())),
                ("rate_limited", Json::Bool(rate_limited)),
            ],
        );
        let _ = chains::append_site(tx, &self.ring, &self.deployment, entry_type, &metadata).await;
    }

    /// Increment one bucket's counter for the current window and return the
    /// new count.
    async fn count_attempt(
        &self,
        tx: &Transaction<'_>,
        bucket_kind: &str,
        bucket_key: &str,
    ) -> Result<Option<i32>, SessionError> {
        let key = self::bucket_key(bucket_key);
        if key.is_empty() {
            return Ok(None);
        }
        // The table pays for its own growth (`0014` §C): one row per (bucket,
        // window) accumulated for ever, and `0013` §F had taken DELETE away on
        // the argument that nothing would want it.
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
    /// means this call took it, so it is the one refusal that records itself.
    ///
    /// **The column is chosen from a closed set, never interpolated from a
    /// caller's string** ([`Latch`] has two values and no `From<&str>`): SQL
    /// cannot take a column name as a parameter, and "so we concatenated it" is
    /// how the next injection gets written.
    ///
    /// **The key goes through [`bucket_key`], not a copy of it.** This function
    /// kept its own truncation until the 2026-09-22 review: two places deciding
    /// which row is meant means a latch taken on one row while the count lands on
    /// another, an entry written every time.
    async fn latch(
        &self,
        tx: &Transaction<'_>,
        bucket_kind: &str,
        bucket_key: &str,
        which: Latch,
    ) -> Result<bool, SessionError> {
        let key = self::bucket_key(bucket_key);
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
    /// A row for a window that has closed can never be counted again
    /// ([`window_start`] is computed from the clock), so it is dead weight once
    /// the window turns over.
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
    /// **Authenticated by the bearer token, not a signature**, because a
    /// signature needs a nonce and the client has none yet. That is all the token
    /// buys: a nonce authorises nothing on its own.
    ///
    /// The nonce alone, for every caller before ADR-0057 decision 4;
    /// [`SessionStore::issue_request_nonce_ex`] adds the counter mark `api.rs`'s
    /// nonce answer now carries.
    pub async fn issue_request_nonce(
        &self,
        session_id: &str,
        token: &[u8],
    ) -> Result<[u8; 32], SessionError> {
        Ok(self.issue_request_nonce_ex(session_id, token).await?.nonce)
    }

    /// As [`SessionStore::issue_request_nonce`], and also the counter mark
    /// this nonce was issued against.
    ///
    /// ADR-0057 decision 4: a restored tab's in-memory counter restarts at `1`,
    /// which `verify_inside`'s `request.counter <= issued_counter` refuses
    /// outright, since the row's mark is long past `1`. The client picks its next
    /// counter up from here: `max(local, issued_counter) + 1`.
    pub async fn issue_request_nonce_ex(
        &self,
        session_id: &str,
        token: &[u8],
    ) -> Result<IssuedNonce, SessionError> {
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
        // ADR-0057 decision 4: idle death, by Postgres's clock against Postgres's
        // `last_seen_at` (the "one clock" rule), so a reload's restored session is
        // held as tightly as a live request in `verify_inside`. A dead session
        // gets no nonce, and the row goes as an expired one does.
        if row.idle_seconds >= idle_limit_seconds(row.principal_kind) {
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
        Ok(IssuedNonce {
            nonce,
            issued_counter: row.request_counter,
        })
    }

    /// **Step one of §4.1 clause (b): spend the nonce, in a transaction of its
    /// own that commits.**
    ///
    /// # Why this is separate from the rest, since `0014`
    ///
    /// Verification used to run whole in its own committed transaction, and
    /// `api.rs` then opened a *second* for `open_tenant_context` and
    /// `authorise_account`, so the disabled-account check, the evidence-key check
    /// and grant evaluation never shared a snapshot: an account disabled, a key
    /// retired or a grant revoked between the two commits was checked against one
    /// state and authorised against another. §3.4's seven steps and §4's *"before
    /// setting `app.design_capability`"* read as one continuous act; they were
    /// two.
    ///
    /// The rest of verification moved into the caller's transaction
    /// ([`SessionStore::verify_pending`]) so it and authorisation share a
    /// snapshot. The nonce did **not** move: a request whose handler fails must
    /// not leave a replayable nonce behind, and a handler that rolls back must
    /// not roll back the fact that the nonce was spent. Nonce freshness is an
    /// atomic claim about one row, so it loses nothing by standing apart.
    ///
    /// **The bounds come first, before the pool is touched.** A timestamp or
    /// counter outside [`MIN_UNIX_MS`]`..=`[`MAX_UNIX_MS`] is refused here, so
    /// nothing below does arithmetic on a number a client chose to overflow.
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
            background: false,
        })
    }

    /// **Step two: everything else, inside the transaction the caller will also
    /// authorise in.**
    ///
    /// `app.session_custody` is turned on at the start and off before this
    /// returns, so the rest of the caller's transaction (tenant context, grant
    /// evaluation, the handler) reaches zero rows in the session tables, as
    /// `0013` §E requires of every transaction that is not a verification.
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
    /// transaction (sign-out, and tests that verify for their own sake).
    ///
    /// A route that goes on to authorise must call [`begin_request`] and
    /// [`verify_pending`] instead, so verification and authorisation share one
    /// snapshot.
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

    /// ADR-0057 decision 7: check `address` (as the caller's `ClientAddress`
    /// policy decided it) against the class `session_id` was bound to at
    /// sign-in, and act on a mismatch per [`SessionStore::with_address_check`].
    ///
    /// An explicit second step, not folded into
    /// [`SessionStore::verify_inside`]: every route already holds `session_id`
    /// and a `ClientAddress` once it has a [`VerifiedSession`], so this reads the
    /// row fresh rather than threading another field through [`SignedRequest`],
    /// [`PendingRequest`] and every caller.
    ///
    /// Call this **after** the request's signature has verified: an address
    /// mismatch is a fact about a genuinely live session, not a reason to skip
    /// verifying it.
    pub async fn check_session_address(
        &self,
        tx: &Transaction<'_>,
        session_id: &str,
        address: &str,
    ) -> Result<(), SessionError> {
        if self.address_check == AddressCheckMode::Off {
            return Ok(());
        }
        enter_session_custody(tx).await?;
        let result = self
            .check_session_address_inside(tx, session_id, address)
            .await;
        leave_session_custody(tx).await?;
        result
    }

    async fn check_session_address_inside(
        &self,
        tx: &Transaction<'_>,
        session_id: &str,
        address: &str,
    ) -> Result<(), SessionError> {
        let Some(row) = read_session(tx, session_id).await? else {
            // Gone, not "already answered for": a concurrent request on another
            // connection can delete this row (sign-out, expiry sweep, decision
            // 7's ending) between `verify_inside`'s read and this one, under READ
            // COMMITTED. A missing row is never `Ok`: the caller is refused as if
            // verification had found it gone.
            return Err(SessionError::Expired);
        };
        let Some(bound) = &row.bound_address_class else {
            // Nothing to compare: a sign-in this feature could not class, or one
            // made before it existed.
            return Ok(());
        };
        // A bound session must keep matching by class. An address that does not
        // even parse is not "nothing to compare": it is not the one this session
        // is bound to, a mismatch like any other, never a free pass.
        let class = crate::client_address::address_class(address);
        if class.as_deref() == Some(bound.as_str()) {
            return Ok(());
        }
        if self.address_check.ends_session(row.principal_kind) {
            tracing::warn!(
                session = %row.id,
                kind = %row.principal_kind.as_str(),
                "session ended: this request's address does not match the one it signed in \
                 from (ADR-0057 decision 7)"
            );
            // On `tx`, never a separate connection: a request that verified
            // successfully already updated this row's
            // `last_seen_at`/`request_counter` on `tx` (`verify_inside` step 6),
            // uncommitted, so a `DELETE` on another connection would block on that
            // lock forever. Every production call site commits `tx` regardless of
            // outcome, as `verify_request` does for `Expired`.
            delete_session(tx, &row.id).await?;
            return Err(SessionError::Expired);
        }
        // Steward plane under `site` mode: recorded, not ended (laptops, VPNs and
        // phones change address normally).
        tx.execute(
            "UPDATE sessions SET address_changed_at = COALESCE(address_changed_at, now()) \
              WHERE id = $1",
            &[&row.id],
        )
        .await?;
        tracing::info!(
            session = %row.id,
            "this session's request address changed since sign-in (ADR-0057 decision 7); kept \
             live"
        );
        Ok(())
    }

    /// Steps (1) to (5) of [`SessionStore::verify_inside`]: everything about a
    /// session that does not need a request. A stream that was authorised once
    /// calls this before each delivery.
    async fn check_standing(
        &self,
        tx: &Transaction<'_>,
        row: &SessionRow,
    ) -> Result<(), SessionError> {
        // (1) Signed out, and recorded as signed out.
        if is_revoked(tx, &row.id).await? {
            return Err(SessionError::SessionRevoked);
        }

        // (2) The row MAC.
        self.check_row_mac(tx, row).await?;

        // (3) Expiry.
        let now = now_unix();
        if row.expires_at_unix <= now {
            delete_session(tx, &row.id).await?;
            return Err(SessionError::Expired);
        }

        // (3a) Idle death (ADR-0057 decision 4): Postgres's idle age against this
        // plane's limit, dead at the mark itself (`idle_seconds >= limit`, not
        // `>`). Not a recorded sign-out: the row is deleted as an expired one is,
        // because time ended the session, not a person. Durable only because the
        // caller commits `tx` regardless of outcome (as `verify_request`).
        if row.idle_seconds >= idle_limit_seconds(row.principal_kind) {
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
            // **A suspended operator stops at the next request**, as `0013` §A
            // says of a disabled account and by the same mechanism: a column
            // re-read inside the transaction that will also authorise, never a
            // flag cached in the session row (a stored "operator in good standing"
            // boolean would be one `UPDATE` from being true again).
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

        // (5) The evidence key, still in service, its own seal still true,
        // **resolved from the keyring the session's own plane keeps**. The two
        // keyrings are different tables with different seals (`0015` §B), and
        // resolving an operator's key id against `account_keys` would refuse every
        // operator session at its second request.
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
                    match operators::live_operator_keys(tx, &self.ring, &row.principal_id, now)
                        .await
                    {
                        // The key that proved this session must still be LIVE. Any
                        // live key, not the newest (ADR-0055 decision 6):
                        // registering a second browser's key does not end the first
                        // browser's session; retiring the key that made it does
                        // (§8.4).
                        Ok(keys) if keys.iter().any(|key| &key.id == key_id) => {}
                        Ok(_) => return Err(SessionError::EvidenceKeyNotInService),
                        Err(operators::OperatorError::Unverifiable(what)) => {
                            return Err(SessionError::Unverifiable(what))
                        }
                        Err(_) => return Err(SessionError::EvidenceKeyNotInService),
                    }
                }
            }
        }

        Ok(())
    }

    /// Is `session` still standing: not signed out, MAC true, unexpired, not
    /// idle, account enabled, evidence key in service? ADR-0063 #13.
    pub async fn check_session_standing(
        &self,
        tx: &Transaction<'_>,
        session: &VerifiedSession,
    ) -> Result<(), SessionError> {
        enter_session_custody(tx).await?;
        let result = match read_session(tx, &session.id).await {
            Ok(Some(row)) => self.check_standing(tx, &row).await,
            Ok(None) => Err(SessionError::NoSuchSession),
            Err(e) => Err(e),
        };
        let _ = leave_session_custody(tx).await;
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

        self.check_standing(tx, &row).await?;
        let now = now_unix();

        // (4a) **ADR-0055 stream (a): the setup session.** An account that holds
        // the operator custody and has not enrolled its app code gets a session
        // accepted on `/credentials/*` and nowhere else (decision 10: *"such an
        // account is taken to the enrolment screen before anything else until it
        // has one"*).
        //
        // **Re-read here, not cached in the row**, like the disabled flag above:
        // the moment the code is enrolled the session becomes ordinary, and a
        // boolean baked into the session row would be one `UPDATE` from being
        // wrong either way.
        //
        // # The gate is about the ACCOUNT, not the assurance
        //
        // It was `row.assurance == Assurance::A0` until the 2026-09-21 review,
        // which let the rule be stepped over: an account holding the operator
        // custody with no app code, signing in with its password **and a browser
        // key**, gets `A1`, so the check never ran and that person could reach
        // `POST /admin/operators/self/key` and register the key every operator act
        // is signed with, having never enrolled the code decision 10 requires for
        // any account holding the operator custody. The state needs no database
        // access to reach: an existing steward with a key who is promoted to
        // operator lands in it. A second factor that a stronger first factor turns
        // off is not a second factor.
        //
        // **The binding is asked first and the credentials only if there is
        // one.** The binding table holds one row per operator (standing shape:
        // two, decision 4), so for every other session this is one small `SELECT`
        // per request.
        //
        // # What the gate is still NOT about: an account with no password
        //
        // The condition is *the account's credential is a password and it has no
        // app code beside it*, decision 10's pairing, not the literal "any account
        // holding the operator custody". An account bound to an operator with
        // **no** stored hash signs in as this server always has: a signature by a
        // key its browser holds, `A1` or nothing (§4.5), the phishing-resistant
        // mechanism decision 10 itself names. There is no password there to
        // phish, reuse or mail, which is all the app code stands against, and
        // `operators.rs`'s invitation path produces exactly such an account.
        //
        // **This narrows what the 2026-09-21 checker proposed** (the check
        // regardless). The residue is a password-less bound account with a live
        // key reaching `/admin`, which `register_own_operator_key` closes at the
        // one act that matters. If decision 10 is read literally, delete the
        // stored-credential clause (`a_stored_credential`) and make
        // `tests/operators.rs`'s fixtures set a password and enrol a code first.
        if row.principal_kind == PrincipalKind::Steward
            && !is_a_credential_path(&request.path)
            && credentials::holds_operator_custody(tx, &row.principal_id)
                .await
                .map_err(|_| SessionError::Corrupt("operator binding"))?
        {
            let credentials = credentials::read_credentials(tx, &self.ring, &row.principal_id)
                .await
                .map_err(|_| SessionError::Corrupt("account credentials"))?;
            let unfinished = credentials
                .map(|c| a_stored_credential(&c) && !c.totp_confirmed())
                .unwrap_or(false);
            if unfinished {
                return Err(SessionError::TotpRequired);
            }
        }

        let issued_counter = request.issued_counter;

        // (6) Time and counter, on numbers already bounded by `begin_request` and
        // checked again here rather than assumed: every arithmetic on this path is
        // checked, so a later widening of the bound cannot re-open the panic `0014`
        // closed.
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

        // A concurrent request on another connection may have deleted this row
        // (sign-out, expiry sweep, decision 7's ending) since the read above. Zero
        // rows touched is that race, not a no-op: a request verified against a row
        // that no longer exists must never be treated as verified.
        let touched = tx
            .query_opt(
                "UPDATE sessions \
                    SET last_seen_at = CASE WHEN $3 THEN now() ELSE last_seen_at END, \
                        request_counter = GREATEST(request_counter, $2) \
                  WHERE id = $1 \
                  RETURNING id",
                &[&row.id, &request.counter, &!request.background],
            )
            .await?;
        if touched.is_none() {
            return Err(SessionError::NoSuchSession);
        }

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
    /// §4.3 has no column for it, and a boolean would put one `UPDATE` between an
    /// attacker and a live session. So the row still goes, and its outstanding
    /// nonces with it through the one `ON DELETE CASCADE` in this schema.
    ///
    /// # Why deleting it was not enough
    ///
    /// `0013` argued that *"a deleted row cannot be resurrected without the site
    /// row key, which is not in PostgreSQL"*. True of MINTING a row, false of
    /// RESTORING one. [`session_row_state`] covers the row's own fields and none
    /// changes at sign-out, so last night's backup holds bytes whose MAC
    /// recomputes for ever, and re-inserting one row silently undid the sign-out.
    ///
    /// An append-only `session_revocations` row closes it, as the authority
    /// tables do for revocation: sealed under the site-scoped row key with
    /// `authority::row_seal`, bound by `chain_seq` to a sealed
    /// `account_signed_out` entry appended first, and unreachable to `fathom_app`
    /// through UPDATE or DELETE. [`verify_inside`] refuses any session id that
    /// appears in it.
    ///
    /// What this does **not** close is a restore of the whole database to a
    /// point before the sign-out; nothing inside the database could, and §7.6
    /// says so. The off-box anchor catches that.
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
        revoke_one(
            tx,
            &self.ring,
            &self.deployment,
            session.kind,
            &principal,
            &session.id,
            None,
        )
        .await?;
        leave_session_custody(tx).await?;
        Ok(())
    }

    /// End every OTHER session of one principal, on one plane: ASVS 7.4.3 after
    /// a password or authenticator change (ADR-0057 decision 3), or ASVS 7.5.2's
    /// "sign out all other browsers" (decision 8, `by: None`). The caller's own
    /// session, `except_session_id`, is left alone.
    ///
    /// Used on the account plane for the account whose credential changed, and
    /// on the operator plane for the operator it holds the custody of, if any
    /// (`except_session_id` is empty there: the session doing the changing is
    /// never an operator one).
    ///
    /// `by`: see [`end_other_sessions`] (the free function this calls).
    pub async fn end_other_sessions(
        &self,
        tx: &Transaction<'_>,
        kind: PrincipalKind,
        principal_id: &str,
        except_session_id: &str,
        by: Option<&str>,
    ) -> Result<(), SessionError> {
        end_other_sessions(
            tx,
            &self.ring,
            &self.deployment,
            kind,
            principal_id,
            except_session_id,
            by,
        )
        .await
    }

    /// Ends exactly one of `principal_id`'s own sessions (ASVS 7.5.2); `by:
    /// Some(admin_id)` is decision 8's admin surface, `None` is the account
    /// itself. [`SessionError::NoSuchSession`] covers "no such session" and
    /// "belongs to someone else" alike, so an id cannot probe another account.
    pub async fn end_one_of(
        &self,
        principal_id: &str,
        session_id: &str,
        by: Option<&str>,
    ) -> Result<(), SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;
        let owner: Option<String> = tx
            .query_opt(
                "SELECT principal_id FROM sessions \
                  WHERE id = $1 AND principal_kind = $2",
                &[&session_id, &PrincipalKind::Steward.as_str()],
            )
            .await?
            .map(|r| r.get(0));
        if owner.as_deref() != Some(principal_id) {
            leave_session_custody(&tx).await?;
            tx.commit().await?;
            return Err(SessionError::NoSuchSession);
        }
        revoke_one(
            &tx,
            &self.ring,
            &self.deployment,
            PrincipalKind::Steward,
            principal_id,
            session_id,
            by,
        )
        .await?;
        leave_session_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// ASVS 5.0.0 7.4.5: ends every session in `organisation` except every
    /// one belonging to `caller_account` — an admin's OTHER open browsers
    /// survive too, not only the one this request is signed with.
    pub async fn end_all_in_organisation_except(
        &self,
        organisation: &str,
        caller_account: &str,
    ) -> Result<(), SessionError> {
        end_all_in_organisation_except(
            self.pool(),
            &self.ring,
            &self.deployment,
            organisation,
            caller_account,
        )
        .await
    }

    /// ADR-0057 decision 8: `principal_id`'s live steward-plane sessions,
    /// most recently active first. Knows nothing about organisations or
    /// roles — it is the caller's job to have already decided who may ask.
    pub async fn list_sessions_of(
        &self,
        principal_id: &str,
    ) -> Result<Vec<SessionSummary>, SessionError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_session_custody(&tx).await?;
        let summaries = query_sessions_of(&tx, principal_id).await?;
        leave_session_custody(&tx).await?;
        tx.commit().await?;
        Ok(summaries)
    }

    /// Disable or re-enable an account, and record it on the site chain
    /// (§7.2's `account_disabled|enabled`).
    /// **Not reachable from any HTTP route in this build.** The operator surface
    /// that will call it (§5) is not built; what exists is the column, the
    /// capability-gated write path, and the fact that a disabled account's live
    /// sessions stop at their next request (`0013` §A has the policy that admits
    /// the write).
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
        if row.stored_row_mac != recomputed {
            return Err(SessionError::Unverifiable("session row MAC"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The one bridge to the repository layer
// ---------------------------------------------------------------------------

/// Open [`repo::TenantContext`] for a **verified** session.
/// This is the only function in the server that produces a tenant context from
/// a request, and it takes a `&VerifiedSession`, which nothing but
/// [`SessionStore::verify_request`] can make: §13 item 1 as a shape.
///
/// An operator session is refused outright: an operator principal is
/// unrepresentable in a membership at every privilege level (§2, `0004`), so
/// `repo::authorise` would refuse it anyway, and a typed refusal says why rather
/// than reporting "not a member".
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
/// **The second and last bridge from a session to an `AccountId`**,
/// [`open_tenant_context`] being the first. That one cannot serve a caller who
/// does not yet know which tenant it is asking about, which is the point of
/// `list_organisations_for_account`.
///
/// **It opens no tenant context, and that is the danger.**
/// `open_tenant_context` sets the row-level-security context that keeps one
/// organisation's rows from another's; this sets nothing. A caller may use the
/// returned `AccountId` **only** with queries whose RLS policy is satisfied by
/// the `account_id` branch: the `organisations` and `memberships` policies of
/// `0002`, read through `repo::list_organisations_for_account_in`, which sets
/// `app.account_id` itself. Handing it to anything tenant-scoped would read
/// under no context at all. If a second caller ever wants this, read that
/// caller's policy first and say in its doc comment which branch it relies on.
///
/// An operator session is refused with the same
/// [`SessionError::NotATenantPrincipal`], for the same reason: an operator
/// principal belongs to no organisation, so the honest answer is a typed
/// refusal rather than an empty list.
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
    /// ADR-0057 decision 2: when this session's own sign-in last verified a TOTP
    /// code; `None` if it never did (key-only sign-in, or before the account had
    /// a confirmed authenticator). Not inside the row MAC; `0027` says why.
    totp_verified_at_unix: Option<i64>,
    /// ADR-0057 decision 6: `SHA-256` of this session's grace token, when its
    /// sign-in minted one; set with `totp_verified_at_unix` and never afterward.
    /// Inside the row MAC (`0028`'s header): a database-only attacker must not be
    /// able to plant a hash their chosen token matches.
    grace_token_hash: Option<[u8; 32]>,
    /// ADR-0057 decision 7: the address class (`client_address::address_class`)
    /// bound at sign-in, or `None` when the source could not be classed. Inside
    /// the row MAC, as `grace_token_hash` is: a database-only attacker must not
    /// be able to rewrite it to match where they call from.
    bound_address_class: Option<String>,
    /// ADR-0057 decision 8: this session's browser, as `browser_label::label`
    /// reduced its `User-Agent` at sign-in, or `None` for an older row. Inside
    /// the row MAC like `bound_address_class`.
    browser_label: Option<String>,
    /// Postgres's idle age of this row, `EXTRACT(EPOCH FROM (now() -
    /// last_seen_at))`, read in the same `SELECT` as everything else so an idle
    /// check never compares this server's clock to the database's. **Not part of
    /// the MAC**, as `last_seen_at` is not: it changes on every verified request.
    idle_seconds: i64,
    /// The stored `row_mac`, read in the same `SELECT` as the fields it covers.
    /// A second read could find the row deleted by a concurrent request.
    stored_row_mac: Vec<u8>,
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
            totp_verified_at_unix: self.totp_verified_at_unix,
            grace_token_hash: self.grace_token_hash.as_ref(),
            bound_address_class: self.bound_address_class.as_deref(),
            browser_label: self.browser_label.as_deref(),
        }
    }
}

/// Everything §4.3's row MAC covers, as a public value.
///
/// **Public, and shaped like `authority::RowFacts` on purpose**: a construction
/// only exercisable through a transaction is one nobody cross-checks
/// (`authority.rs`'s header), and `tests/session_vectors.rs` pins every byte
/// against a second implementation in plain Python from §4's text.
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
    /// Decision 2's freshness clock, inside the MAC (`0027`'s header).
    pub totp_verified_at_unix: Option<i64>,
    /// Decision 6's grace token hash, inside the MAC (`0028`'s header).
    pub grace_token_hash: Option<&'a [u8; 32]>,
    /// Decision 7's bound address class, inside the MAC (`0028`'s header).
    pub bound_address_class: Option<&'a str>,
    /// Decision 8's browser label, inside the MAC (`0029`'s header).
    pub browser_label: Option<&'a str>,
}

/// §4.3's `row_mac`, in `authority::row_seal`'s construction under the
/// site-scoped row key.
///
/// ```text
/// row_mac = MAC(K_row_site, LP("fathom/row/v1") ‖ LP("sessions") ‖ LP(id)
///               ‖ u64(chain_seq) ‖ u32(row_version) ‖ LP(canon(row_state)))
/// ```
///
/// `0013`'s departure 2: reuse the authority layer's construction rather than
/// deriving §4.3's own `K_sess` under two new labels. A session row is
/// account-scoped as a keyring row is, and a label separates uses of one key,
/// not keys.
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
/// One function, used on write and on read, so the MAC cannot depend on which side computed it
/// (`grants::grant_row_state`'s rule). It holds every field §4.3's MAC lists, plus `token_hash`
/// (a bearer token an attacker chose is the substitution §4.1 describes) and `assurance`,
/// `evidence_key_id` and `evidence_sig` (clause (a) rests on them).
///
/// `last_seen_at` and `request_counter` are deliberately NOT in it. The runtime role may rewrite
/// them (`0013` §F) and they change on every request; covering them would mean recomputing and
/// re-verifying the MAC on every write. §4.3's own MAC covers neither.
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
    // Left OUT of the map when unset, not written as null: an old seal
    // must still recompute unchanged after this column arrives.
    if let Some(at) = row.totp_verified_at_unix {
        map.insert("totp_verified_at".to_string(), Json::Int(at));
    }
    // Same rule, `0028`: a row made before decision 6 or decision 7 existed
    // has neither, and must still verify unchanged.
    if let Some(hash) = row.grace_token_hash {
        map.insert("grace_token_hash".to_string(), Json::Str(hex(hash)));
    }
    if let Some(class) = row.bound_address_class {
        map.insert(
            "bound_address_class".to_string(),
            Json::Str(class.to_string()),
        );
    }
    // `0029`: a row made before decision 8 existed has none, and must still
    // verify unchanged.
    if let Some(label) = row.browser_label {
        map.insert("browser_label".to_string(), Json::Str(label.to_string()));
    }
    Json::Obj(map).to_canonical_bytes()
}

/// The one value `session_revocations.reason` takes today.
const SIGNED_OUT: &str = "signed_out";

/// What one `session_revocations` row's seal covers (`0014` §D).
///
/// Public, and shaped like [`SessionFacts`] and `authority::RowFacts`, so the construction can be
/// cross-checked without a transaction.
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
/// `authority::row_seal` under the same site-scoped row key a session row uses, with no new label
/// (`0013` departure 2). The table name is inside the seal, so a revocation row lifted into
/// another table, or a session row filed as a revocation, does not verify where it lands.
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

/// A free function so `credentials.rs` can end an account's other sessions inside its OWN
/// transaction, atomically with the change that triggers it.
///
/// `by` is `None` when the principal ends its own other sessions (a credential change, or ASVS
/// 7.5.2), and `Some(admin_id)` when decision 8's admin surface ends a member's.
pub async fn end_other_sessions(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    kind: PrincipalKind,
    principal_id: &str,
    except_session_id: &str,
    by: Option<&str>,
) -> Result<(), SessionError> {
    enter_session_custody(tx).await?;
    let rows = tx
        .query(
            "SELECT id FROM sessions \
              WHERE principal_id = $1 AND principal_kind = $2 AND id <> $3",
            &[&principal_id, &kind.as_str(), &except_session_id],
        )
        .await?;
    for row in &rows {
        let session_id: String = row.get(0);
        revoke_one(tx, ring, deployment, kind, principal_id, &session_id, by).await?;
    }
    leave_session_custody(tx).await?;
    Ok(())
}

/// ADR-0057 decision 8: ends every steward-plane session of `organisation` except those of
/// `caller_account` (ASVS 5.0.0 7.4.5). Sets `app.tenant_id` itself, inside its own transaction:
/// `sessions` has no organisation column, and `repo::require_admin`'s transaction has committed.
pub async fn end_all_in_organisation_except(
    pool: &Pool,
    ring: &KeyRing,
    deployment: &str,
    organisation: &str,
    caller_account: &str,
) -> Result<(), SessionError> {
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    enter_session_custody(&tx).await?;
    tx.execute(
        "SELECT set_config('app.tenant_id', $1, true)",
        &[&organisation],
    )
    .await?;
    // Excluded by ACCOUNT, not by the one session this request happens to
    // be signed with — an admin's other open browsers are their own too.
    let rows = tx
        .query(
            "SELECT s.id, s.principal_id FROM sessions s \
             JOIN memberships m ON m.account_id = s.principal_id \
             WHERE m.organisation_id = $1 AND s.principal_kind = $2 AND s.principal_id <> $3",
            &[
                &organisation,
                &PrincipalKind::Steward.as_str(),
                &caller_account,
            ],
        )
        .await?;
    for row in &rows {
        let session_id: String = row.get(0);
        let principal_id: String = row.get(1);
        revoke_one(
            &tx,
            ring,
            deployment,
            PrincipalKind::Steward,
            &principal_id,
            &session_id,
            Some(caller_account),
        )
        .await?;
    }
    leave_session_custody(&tx).await?;
    tx.commit().await?;
    Ok(())
}

/// One session, signed out: the entry, the revocation row, the delete. This is what
/// [`SessionStore::sign_out_in`] and [`end_other_sessions`] reduce to.
///
/// `by` is `Some(admin_id)` when an administrator ends it (decision 8); it goes into the sealed
/// entry's metadata.
async fn revoke_one(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    kind: PrincipalKind,
    principal_id: &str,
    session_id: &str,
    by: Option<&str>,
) -> Result<(), SessionError> {
    let entry_type = match kind {
        PrincipalKind::Steward => EntryType::AccountSignedOut,
        PrincipalKind::Operator => EntryType::OperatorSignedOut,
    };
    let mut fields = vec![
        ("session", Json::Str(session_id.to_string())),
        ("account", Json::Str(principal_id.to_string())),
        ("principal_kind", Json::Str(kind.as_str().to_string())),
    ];
    if let Some(admin) = by {
        fields.push(("by", Json::Str(admin.to_string())));
    }
    let appended = chains::append_site(
        tx,
        ring,
        deployment,
        entry_type,
        &entry_metadata(entry_type, &fields),
    )
    .await?;

    let facts = RevocationFacts {
        session_id,
        principal_id,
        reason: SIGNED_OUT,
        chain_seq: appended.seq,
        row_version: 1,
    };
    let key = grants::site_row_key(tx, ring).await?;
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

    delete_session(tx, session_id).await?;
    Ok(())
}

/// Has this session id been recorded as signed out (`0014` §D)?
///
/// The row's own seal is deliberately NOT checked here, because of which way each failure falls.
/// An unsealed or resealed revocation row refuses a session: fail closed, and it gives an
/// attacker nothing they could not get by deleting the session row. Checking the seal would let
/// an attacker who corrupts a revocation get the session back: fail open, which is what this
/// table exists to stop. The seal lets an auditor detect a minted revocation; it is not what
/// makes one effective.
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
/// Every `DELETE ... RETURNING` that spends a nonce also requires `expires_at > now()`, so an
/// expired nonce is dead weight.
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
/// An expired session is refused and deleted at its next use, but most never have one: a browser
/// closed at five o'clock never comes back.
///
/// No revocation row is recorded for a swept session, unlike a sign-out: `expires_at` is inside
/// the row's own MAC, so a restored expired row is refused by the expiry check on its own bytes.
async fn sweep_expired_sessions(tx: &Transaction<'_>) -> Result<(), SessionError> {
    let ended = tx
        .query(
            "DELETE FROM sessions \
              WHERE id IN (SELECT id FROM sessions \
                            WHERE expires_at <= now() \
                            ORDER BY expires_at \
                            LIMIT $1) \
              RETURNING id",
            &[&SWEEP_BATCH],
        )
        .await?;
    for row in ended {
        notify_session_ended(tx, &row.get::<_, String>(0)).await?;
    }
    Ok(())
}

/// Refuse a client-supplied millisecond timestamp outside the range a wall clock can produce,
/// **before any arithmetic touches it** (`0014`, finding 5).
fn check_unix_ms(unix_ms: i64) -> Result<(), SessionError> {
    if !(MIN_UNIX_MS..=MAX_UNIX_MS).contains(&unix_ms) {
        return Err(SessionError::Malformed("request timestamp"));
    }
    Ok(())
}

/// `|now_seconds·1000 − unix_ms| / 1000`, with every step checked.
///
/// The old `(now * 1000 - request.unix_ms).abs() / 1000` panicked on
/// `fathom-timestamp: -9223372036854775808`: the subtraction overflows (the server profile sets
/// `overflow-checks = true`) and `.abs()` on `i64::MIN` panics. [`check_unix_ms`] already refuses
/// that input; this is checked anyway because the bound and the arithmetic are two statements of
/// one rule, and someone will one day relax the first.
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
            // `COALESCE` over the two evidence columns is unambiguous: `0015` §B2's `CHECK`s
            // let only the one matching this row's `principal_kind` be set. It yields the single
            // value `session_row_state` has always hashed.
            "SELECT id, principal_id, principal_kind, token_hash, session_pubkey, bound_nonce, \
                    COALESCE(evidence_key_id, evidence_operator_key_id), \
                    evidence_sig, assertion_digest, assurance, chain_seq, \
                    row_version, EXTRACT(EPOCH FROM issued_at)::bigint, \
                    EXTRACT(EPOCH FROM expires_at)::bigint, request_counter, \
                    EXTRACT(EPOCH FROM totp_verified_at)::bigint, grace_token_hash, \
                    bound_address_class, browser_label, \
                    EXTRACT(EPOCH FROM (now() - last_seen_at))::bigint, row_mac \
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
    let grace_token_hash: Option<Vec<u8>> = row.get(16);
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
        totp_verified_at_unix: row.get(15),
        grace_token_hash: match grace_token_hash {
            Some(h) => Some(as_32(&h, "session grace token hash")?),
            None => None,
        },
        bound_address_class: row.get(17),
        browser_label: row.get(18),
        idle_seconds: row.get(19),
        stored_row_mac: row.get(20),
    }))
}

/// ADR-0057 decision 8: every live steward-plane session of `principal_id`,
/// most recently active first. Excludes a session past `expires_at` or idle
/// past its plane's limit ([`idle_limit_seconds`]), checked against
/// Postgres's own clock so a listing agrees with `verify_inside`.
async fn query_sessions_of(
    tx: &Transaction<'_>,
    principal_id: &str,
) -> Result<Vec<SessionSummary>, SessionError> {
    let rows = tx
        .query(
            "SELECT id, browser_label, bound_address_class, \
                    address_changed_at IS NOT NULL, \
                    EXTRACT(EPOCH FROM last_seen_at)::bigint, \
                    EXTRACT(EPOCH FROM issued_at)::bigint, \
                    expires_at > now(), \
                    EXTRACT(EPOCH FROM (now() - last_seen_at))::bigint \
               FROM sessions \
              WHERE principal_id = $1 AND principal_kind = $2 \
              ORDER BY last_seen_at DESC",
            &[&principal_id, &PrincipalKind::Steward.as_str()],
        )
        .await?;
    let idle_limit = idle_limit_seconds(PrincipalKind::Steward);
    Ok(rows
        .iter()
        .filter(|row| {
            let not_expired: bool = row.get(6);
            let idle_seconds: i64 = row.get(7);
            not_expired && idle_seconds < idle_limit
        })
        .map(|row| SessionSummary {
            session_id: row.get(0),
            browser_label: row.get(1),
            bound_address_class: row.get(2),
            address_changed: row.get(3),
            last_active_unix: row.get(4),
            issued_at_unix: row.get(5),
        })
        .collect())
}

async fn delete_session(tx: &Transaction<'_>, id: &str) -> Result<(), SessionError> {
    tx.execute("DELETE FROM sessions WHERE id = $1", &[&id])
        .await?;
    notify_session_ended(tx, id).await?;
    Ok(())
}

/// Tell every process a session ended, so open live streams recheck (ADR-0063
/// #13). Delivered at commit; sent by the code that ends the session, not by a
/// trigger (the `sessions` table carries none).
pub(crate) async fn notify_session_ended(
    tx: &Transaction<'_>,
    id: &str,
) -> Result<(), tokio_postgres::Error> {
    tx.execute(
        "SELECT pg_notify('fathom_authority', 'session:' || $1::text)",
        &[&id],
    )
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
/// §4.5 gives an operator no address of record (there is no reset path to send anything to), so
/// the operator plane uses the operator's own id, handed over once at enrolment. It is not a
/// secret and is not treated as one: the factor is a signature by the key `operator_keys` holds.
///
/// A value that names nobody returns `None` and takes the path an unknown address takes on the
/// account plane, which keeps the two planes' refusals identical.
async fn operator_by_id(
    tx: &Transaction<'_>,
    claimed: &str,
) -> Result<Option<String>, SessionError> {
    let row = tx
        .query_opt("SELECT id FROM operators WHERE id = $1", &[&claimed])
        .await?;
    Ok(row.map(|r| r.get(0)))
}

/// The one shape sign-in needs from either keyring: which key proved this session, and its
/// fingerprint.
///
/// `grants::AccountKey` and `operators::OperatorKey` are different rows in different tables with
/// different seals, deliberately (`0015` §B). Sign-in needs only these fields from either, so
/// the branch below produces one value.
///
/// Since ADR-0055 stream (a) there is no public key here: both planes verify the evidence
/// signature where they resolve the key (the account plane has to try each live key, in
/// `grants::verify_by_any_live_key`).
struct SignInKey {
    id: String,
    fpr: [u8; 32],
}

// ---------------------------------------------------------------------------
// The transaction-local capability, and small helpers
// ---------------------------------------------------------------------------

/// Turn on `app.session_custody` for the rest of this transaction.
///
/// `0013` §E carries the argument. A session is not organisation-scoped and is verified before
/// any tenant context exists, so there is no tenant id for a policy to compare against. The
/// setting is scoped to one transaction that does nothing but verify, so every other transaction
/// reaches zero rows in the three session tables.
///
/// Mirrors `repo::enter_key_custody`, including setting `app.design_capability` to its refusal
/// first, so a verification transaction cannot read a design payload.
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

/// Close it again before the transaction commits, so a connection handed back to the pool carries
/// nothing. `set_config(..., true)` already scopes it to the transaction; this is a second
/// statement of the same rule.
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

/// Is this the path of a route a setup session may reach?
///
/// The path is the SIGNED one (inside the message `request_bytes` covers), so a caller cannot
/// claim `/credentials/...` for a request that went elsewhere. Only the path is compared, with
/// the query stripped, since a query string is not part of which route answered.
///
/// `/credentials` itself is included so the set is "the credentials surface" and not "anything
/// beginning with those letters": `/credentialsomething` is not on it.
/// **Is this account's credential the one ADR-0055 decision 10 pairs with an app code?** One
/// stored column, read as a yes-or-no and nothing else.
///
/// A function of its own so the gate at the bottom of this file (the field a person's credential
/// arrives in is named on the sign-in path and nowhere else) keeps its meaning. This is a
/// predicate on stored state: it takes a row already read and returns a boolean, so no value can
/// travel through it in either direction.
fn a_stored_credential(row: &credentials::CredentialRow) -> bool {
    row.password_hash.is_some()
}

fn is_a_credential_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    path == "/credentials" || path.starts_with("/credentials/")
}

fn check_public_key(public_key: &[u8]) -> Result<(), SessionError> {
    if public_key.len() != authority::PUBLIC_KEY_LEN || public_key[0] != 4 {
        return Err(SessionError::Malformed("session public key"));
    }
    Ok(())
}

/// 32 bytes from the OS CSPRNG, the one generator this server draws from (`crypto::Key32::random`).
/// The type is named for keys; the draw is the same for a nonce.
fn random_32() -> Result<[u8; 32], SessionError> {
    Ok(*Key32::random()
        .map_err(|_| SessionError::Corrupt("random source"))?
        .expose())
}

/// Compare two byte strings in constant time with `crypto::mac_verify` (`digest 0.11.3`'s `Mac`
/// trait, read rather than assumed; see `crypto.rs`), the one constant-time comparison in this
/// workspace.
///
/// Both sides are MACed under a fresh random key per call, so the timing of the equality test
/// carries nothing about either input.
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

/// One bucket's key as the column holds it.
///
/// A source key longer than the column allows is truncated rather than refused: it is still
/// grouped by its first 128 characters. Every caller goes through this
/// ([`SessionStore::count_attempt`], [`SessionStore::latch`]) so the count and the latch cannot
/// disagree about which row they mean.
fn bucket_key(key: &str) -> String {
    key.chars().take(128).collect()
}

/// The start of the current fixed window, as a `timestamptz`. Computed here rather than in SQL so
/// both buckets and both statements agree on one value per call.
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
        // Forty-five: a two-step sign-in costs three source units (challenge, probe,
        // completion), so this is fifteen sign-ins a window. `SignInLimits::defaults` carries it.
        assert_eq!(limits.max_per_source, 45);
        assert_eq!(
            limits.max_per_source / 3,
            15,
            "the number a shared source can actually sign in is what this default is chosen for"
        );
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
    fn exactly_two_places_in_this_module_name_the_credential_a_person_types() {
        // This test once forbade the WORD in this whole file (§4.5, OPEN-QUESTIONS C2). ADR-0055
        // decision 10 reopens that, so the gate is now an allowlist: the field may be named on
        // the sign-in path and nowhere else in this module.
        //
        // `tests/operators.rs` holds the same gate at the HTTP surface, per handler. Here the unit
        // is coarser, because sign-in is one act spread over `sign_in_with_credentials`,
        // `attempt_sign_in` and `check_second_factor`, so the allowlist is by function name.
        const ALLOWED: &[&str] = &[
            // The compatibility wrapper, which fills the two new fields with
            // nothing so that every existing caller is byte-identical.
            "pub async fn sign_in(",
            "pub async fn sign_in_with_credentials",
            "async fn attempt_sign_in",
            "async fn check_second_factor",
            "pub struct SignInAttempt",
            // One narrow predicate. `verify_inside`'s setup-session gate must know whether an
            // account's credential is the one decision 10 pairs with an app code, which needs
            // the stored column. A function that takes a row already read and returns a boolean
            // lets nothing arrive through it. `verify_inside` itself is the per-request path and
            // must stay unable to name the field.
            "fn a_stored_credential",
        ];

        // The test module is cut off first: this test's own name contains the
        // word, and a check that fails on the thing checking is a check that
        // gets deleted.
        let whole = include_str!("sessions.rs");
        let source = whole
            .split_once("#[cfg(test)]")
            .map(|(before, _)| before)
            .unwrap_or(whole);

        let mut inside: Option<&str> = None;
        let mut allowed_lines = 0usize;
        for line in source.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("fn ")
                || trimmed.starts_with("async fn ")
                || trimmed.starts_with("pub fn ")
                || trimmed.starts_with("pub async fn ")
                || trimmed.starts_with("pub struct ")
            {
                inside = ALLOWED.iter().find(|a| trimmed.starts_with(*a)).copied();
            }
            // A typed refusal is not a field. `SessionError::PasswordRefused` carries no value;
            // it names a uniform answer. It is removed before the scan so the gate stays about
            // a FIELD a credential could arrive in.
            let scanned = line.replace("PasswordRefused", "");
            let lower = scanned.to_ascii_lowercase();
            for forbidden in ["password", "passphrase", "passcode", "\"pin\""] {
                if !lower.contains(forbidden) {
                    continue;
                }
                // Prose about where the password path is and is not is the
                // point, not a violation of it.
                if lower.trim_start().starts_with("//")
                    || lower.trim_start().starts_with("///")
                    || lower.contains("no password")
                    || lower.contains("forbidden")
                {
                    continue;
                }
                match inside {
                    Some(_) => allowed_lines += 1,
                    None => panic!(
                        "a non-comment line outside the sign-in path mentions {forbidden}: {line}"
                    ),
                }
            }
        }
        assert!(
            allowed_lines > 0,
            "the allowlist matched nothing, so this gate is checking a shape that no longer \
             exists and would pass however the code changed"
        );
    }

    /// The decoy costs what the real thing costs. A decoy at cheaper parameters is the
    /// enumeration oracle again, quieter, so the parameters are read back out of the compiled-in
    /// string and compared with those `credentials.rs` hashes under today.
    #[test]
    fn the_decoy_hash_is_at_the_parameters_this_build_hashes_under() {
        let expected = format!(
            "$argon2id$v=19$m={},t={},p={}$",
            credentials::ARGON2_M_COST,
            credentials::ARGON2_T_COST,
            credentials::ARGON2_P_COST
        );
        assert!(
            A_DECOY_HASH.starts_with(&expected),
            "the decoy is {A_DECOY_HASH}, which is not at {expected}: a decoy verification that \
             costs less than the real one is the timing oracle it was added to close"
        );
        // It must also be a hash something can be verified against: a string that failed to parse
        // would return `false` in microseconds and burn no work, which looks exactly like success.
        let started = std::time::Instant::now();
        assert!(
            !credentials::verify_password(A_DECOY_HASH, "a-guess-that-is-not-the-decoy"),
            "the decoy must not verify anything"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(5),
            "verifying against the decoy took {:?}, which is too little for argon2id at \
             m={} — the string is not being parsed and no work is being done",
            started.elapsed(),
            credentials::ARGON2_M_COST
        );
    }

    /// `session_row_state` at 396e7be, frozen, before this column existed.
    fn session_row_state_396e7be(row: &SessionFacts<'_>) -> Vec<u8> {
        let mut map = std::collections::BTreeMap::new();
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

    #[test]
    fn a_row_state_with_totp_verified_at_unset_matches_the_pre_0027_encoding() {
        let pubkey = [3u8; 33];
        let token_hash = [4u8; 32];
        let nonce = [5u8; 32];
        let facts = SessionFacts {
            id: "01JQZ0000000000000000000AA",
            principal_id: "01JQZ0000000000000000000BB",
            principal_kind: PrincipalKind::Steward,
            token_hash: &token_hash,
            session_pubkey: &pubkey,
            bound_nonce: &nonce,
            evidence_key_id: None,
            evidence_sig: None,
            assertion_digest: None,
            assurance: Assurance::A0,
            chain_seq: 1,
            row_version: 1,
            issued_at_unix: 1_760_000_000,
            expires_at_unix: 1_760_003_600,
            totp_verified_at_unix: None,
            grace_token_hash: None,
            bound_address_class: None,
            browser_label: None,
        };
        assert_eq!(
            session_row_state(&facts),
            session_row_state_396e7be(&facts),
            "an account upgraded from before `0027` must still verify: its seal never covered \
             a key this build now omits too, rather than writing as null"
        );
    }
}
