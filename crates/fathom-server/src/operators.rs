//! **The operator console and the enrolment path an invitation travels.**
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.1 (the verbs), §1.3 (two
//! database roles, and the admin pool is read-only), §4.5 (the operator
//! surface has no password path at all), §5.1 (reset), §5.3–§5.5 (settings and
//! the execution interlock), §6.2–§6.3 (shells, claims, and the very first
//! operator), §7.2 (the sealed entry types). `migrations/0015` is the schema
//! and carries the reasoning for every table and every privilege;
//! `src/admin.rs` is the HTTP surface over this file.
//!
//! # The one line that does not move
//!
//! **An operator cannot grant capability inside an organisation.** Nothing in
//! this file writes `memberships`, `scope_grants` or `grant_secondings`, and
//! `0004`'s composite foreign keys make an operator principal unrepresentable
//! in any of them at every privilege level including superuser. What an
//! operator does here is: create shells, issue invitations, suspend, disable,
//! and administer the site.
//!
//! The one authority-adjacent verb §1.1 does give the operator plane —
//! suspending a scope grant — lives in `grants::suspend_grant_by_operator`,
//! because that is where every other act against a grant lives and because
//! suspension only ever REMOVES a grant from the live set. There is no
//! operator unsuspend, here or in the schema.
//!
//! # No password, for anyone, anywhere
//!
//! §4.5: an operator session is `A1` or it does not exist. There is no
//! password column, no reset link, no "forgot" flow, and **no field in any
//! message this module parses that a password could arrive in**. §5.1's
//! "reset" is [`OperatorStore::issue_account_enrolment`] — a fresh single-use
//! enrolment token to the account's address of record — because there is no
//! password to reset. `tests/operators.rs` greps this file, `admin.rs` and the
//! wire types for the shape of one.
//!
//! # Invite only (`docs/OPEN-QUESTIONS.md` B5, answered by the owner)
//!
//! Nobody self-registers. Every account in this deployment exists because an
//! operator created a shell for an address, and every key on it exists because
//! somebody redeemed a single-use, expiring token that named that address.
//! There is no route in this module that takes an address and creates an
//! account without a verified operator session behind it.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::{Pool, PoolError, Transaction};
use fathom_canon::Json;
use sha2::{Digest, Sha256};

use crate::authority::{self, RowFacts, SignatureRefused};
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError, CHAIN_KEY_EPOCH};
use crate::crypto::{self, Key32};
use crate::grants::{self, AuthorityError, GenesisGrant};
use crate::ids;
use crate::keys::KeyRing;
use crate::repo::{AccountId, OrganisationId, RepoError};
use crate::sessions::{Assurance, PrincipalKind, VerifiedSession};

// ---------------------------------------------------------------------------
// The labels
// ---------------------------------------------------------------------------

/// The stored form of an enrolment token.
const TAG_ENROLMENT_TOKEN: &[u8] = b"fathom/enrolment/token/v1";

/// HKDF `info` from the site chain key → the key a site setting's value is
/// sealed under.
const KDF_SITE_SETTINGS: &[u8] = b"fathom/site/settings/v1";

/// The AEAD associated data a setting's ciphertext is bound to.
const AAD_SITE_SETTINGS: &[u8] = b"fathom/site/settings/aad/v1";

/// The bytes an operator signs to REQUEST a setting change (§5.3).
const TAG_SETTING_REQUEST: &[u8] = b"fathom/site/setting/request/v1";

/// The bytes an operator signs to SECOND one (§5.5).
const TAG_SETTING_SECOND: &[u8] = b"fathom/site/setting/second/v1";

/// The bytes an operator signs to REQUEST a new operator (§5.5).
const TAG_OPERATOR_REQUEST: &[u8] = b"fathom/site/operator/request/v1";

/// The bytes an operator signs to SECOND one (§5.5).
const TAG_OPERATOR_SECOND: &[u8] = b"fathom/site/operator/second/v1";

/// **Every label this module introduces, for `PHASE-2-STORAGE-DESIGN.md`
/// §12.2's table, which owns them.**
///
/// Same contract as [`crate::authority::LABELS`] and
/// [`crate::sessions::LABELS`]: the table wins over this file, a unit test at
/// the bottom asserts that every label the code uses is listed here, and the
/// list is what a reader reconciles against §12.2 in one read.
///
/// **No new row-seal label.** Every row this module seals goes through
/// `authority::row_seal` under the site-scoped row key with its own table name
/// inside the seal — `0013`'s departure 2 carries the argument: a label
/// separates USES of one key, and sealing one more site-scoped table is not a
/// new use.
pub const LABELS: &[(&str, &str)] = &[
    (
        "fathom/enrolment/token/v1",
        "hash tag of a stored enrolment token: H(LP(tag) ‖ LP(token)). The token itself is \
         returned once and never stored (§1.1, §6.2, §6.3)",
    ),
    (
        "fathom/site/settings/v1",
        "HKDF `info` from the SITE chain key → the key a site setting's value ciphertext is \
         sealed under (§5.3, 'SMTP credentials are credentials')",
    ),
    (
        "fathom/site/settings/aad/v1",
        "AEAD associated data tag for that ciphertext: LP(tag) ‖ LP(deployment) ‖ LP(row id) \
         ‖ LP(setting key) ‖ u32(epoch), so a value cannot be moved between settings or \
         deployments",
    ),
    (
        "fathom/site/setting/request/v1",
        "the bytes an operator's enrolled key signs to request a setting change (§5.3)",
    ),
    (
        "fathom/site/setting/second/v1",
        "the bytes a SECOND operator's enrolled key signs to second one (§5.5: seconding is a \
         key touch and not a row)",
    ),
    (
        "fathom/site/operator/request/v1",
        "the bytes an operator's enrolled key signs to request a new operator (§5.5)",
    ),
    (
        "fathom/site/operator/second/v1",
        "the bytes a second operator's enrolled key signs to second one (§5.5)",
    ),
];

// ---------------------------------------------------------------------------
// Times, named once
// ---------------------------------------------------------------------------

/// §5.3's delay: *"two operators, a 24-hour delay, and during the delay the
/// old settings still apply — so the notice of the change travels the mail
/// path the change is trying to capture."*
pub const SETTINGS_DELAY: Duration = Duration::from_secs(24 * 60 * 60);

/// How long an enrolment token stays redeemable.
///
/// **§1.1, §6.2 and §6.3 give no number.** Seventy-two hours is long enough to
/// survive a weekend and a mail queue, short enough that a token read out of an
/// old mailbox is worthless. It is a constant rather than a setting because a
/// setting here would be a setting an operator could lengthen through the very
/// machinery §5.3 exists to slow down.
pub const ENROLMENT_TOKEN_LIFETIME: Duration = Duration::from_secs(72 * 60 * 60);

/// The prefix the bootstrap token file carries before the hex
/// (`main.rs`'s `write_bootstrap_token`): it says which door the token is
/// for, so the enrolment screen needs no choice made on it. The client's
/// `parseToken` reads `op_` as the operator plane and `inv_`, which the
/// console puts in front of account invitations, as the account plane; the
/// bytes on the wire carry no prefix. A file written before 2026-09-21 is
/// bare hex, and the client treats a bare token with no address typed as an
/// operator's.
pub const BOOTSTRAP_TOKEN_PREFIX: &str = "op_";

// ---- ADR-0055 stream (b) --------------------------------------------------

/// **Ten minutes**, for the setup code `fathom-server recover-operator` prints
/// to a terminal (ADR-0055 decision 8: *"prints a one-shot ten-minute setup
/// code"*).
///
/// Short because it is read off a screen by the person who just typed the
/// command, not mailed: the whole life of this token is the walk from the
/// host's terminal to a browser. It is deliberately NOT
/// [`ENROLMENT_TOKEN_LIFETIME`] -- seventy-two hours exists to survive a
/// weekend and a mail queue, and neither is in play here.
pub const RECOVERY_SETUP_TOKEN_LIFETIME: Duration = Duration::from_secs(10 * 60);

/// **Seven days**, the window ADR-0055 decision 8 banners every operator
/// session for after a host recovery: *"notifies every operator, and banners
/// every operator session for seven days"*.
///
/// Derived from the site chain, never stored: [`OperatorStore::notices`] asks
/// the chain whether an `operator_recovered_from_host` entry landed inside
/// this window. A column would be a column somebody could clear.
pub const RECOVERY_BANNER_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// **Seven days**, the seconder-independence window
/// `0015_operator_console.sql` §G pins in `fathom_seconder_is_independent`:
/// *"that sign-in is older than the longest delay window in force"*.
///
/// Named here because ADR-0055 decision 3's quorum has to agree with it. The
/// lead's resolution 9, 2026-09-21: *"live independent operators are operators
/// not disabled whose `first_independent_signin_at IS NOT NULL` and older than
/// the seconder trigger's 7-day window, so quorum never demands a seconder who
/// cannot second."* A quorum of two counting an operator the trigger would
/// refuse is a quorum that can never be met, which is the deadlock decision 3
/// exists to remove.
///
/// **The literal is in two places and has to be.** The trigger's copy is in
/// SQL because a trigger cannot read a Rust constant, and this one is in Rust
/// because the quorum is computed here. `the_quorum_window_matches_the_trigger`
/// in `tests/operators.rs` reads the trigger's own source out of the catalogue
/// and asserts the two agree.
pub const INDEPENDENCE_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything the operator plane refuses, and why.
///
/// **[`OperatorError::EnrolmentRefused`] is deliberately one variant for
/// several causes**: a token that was never issued, one already redeemed, one
/// past its expiry, one presented with the wrong address, and one whose row
/// seal does not verify all produce it. A caller who could tell those apart
/// could probe for live tokens and for which addresses exist. The sealed entry
/// carries the real reason, where an operator can read it and an attacker
/// cannot.
#[derive(Debug)]
pub enum OperatorError {
    Db(tokio_postgres::Error),
    Pool(PoolError),
    Chain(ChainStoreError),
    Repo(RepoError),
    Authority(AuthorityError),
    Crypto(crypto::CryptoError),
    /// The caller's session is not an operator session. §1.1's verbs are the
    /// operator plane's and no account reaches them.
    NotAnOperator,
    /// This operator has been disabled. Their live sessions stop at their next
    /// request; this is the refusal at the act itself.
    OperatorDisabled,
    /// A stored row does not verify under this deployment's row key, or the
    /// sealed entry it names does not verify: the store is not telling the
    /// truth about itself. **Not a permission error** (§3.4's argument) and it
    /// must never render as one.
    Unverifiable(&'static str),
    /// An enrolment token was refused. One variant for every cause.
    EnrolmentRefused,
    /// A signature by the acting operator's enrolled key was refused.
    Signature(SignatureRefused),
    /// This operator has no key enrolled, so there is nothing to verify an
    /// assertion against. §4.5: there is no weaker factor to fall back to.
    NoOperatorKey,
    /// §5.5: the seconder may not be the requester. The database says so too,
    /// in a `CHECK` and a `SECURITY DEFINER` trigger; this is the same refusal
    /// before the statement is issued, so the caller gets a sentence rather
    /// than a constraint name.
    SecondedByTheRequester,
    /// `0015` §G's `fathom_seconder_is_independent` refused this seconder:
    /// they are disabled, they were created by the requester, they have no
    /// independent sign-in on record, or that sign-in is newer than
    /// [`INDEPENDENCE_WINDOW`]. **A rule, not an alarm** — before ADR-0055
    /// fix (c) the trigger's `P0001` fell through to
    /// `Corrupt("operator plane")` and reached the console as a 500.
    SeconderNotIndependent,
    /// §5.3: this change has not reached its `effective_at`, or has not been
    /// seconded, or has been cancelled, so it does not apply.
    NotYetEffective,
    /// §5.4 step 5: a candidate row failed a check and was **not** silently
    /// skipped. An incident, bannered by the deployment.
    SettingUnresolvable,
    /// There is no such pending change, token, shell, account or operator.
    NotFound(&'static str),
    /// A first operator already exists, so the bootstrap path is closed
    /// (§6.3). Idempotent callers should read this as "nothing to do".
    AlreadyBootstrapped,
    /// **An operator key is enrolled, so there is no re-issuing the first
    /// operator's enrolment token** — see
    /// [`OperatorStore::reissue_bootstrap_token`], which is the only thing
    /// that produces this.
    ///
    /// The refusal is the control. A re-issue that still worked after
    /// enrolment would let anyone who can run a command on the host mint
    /// themselves an operator enrolment token, and an operator session with
    /// it, without holding any key this deployment has ever seen.
    AlreadyEnrolled,
    // ---- ADR-0055 stream (b) ------------------------------------------
    /// The acting account holds no operator custody: there is no row in
    /// `operator_account_bindings` naming it (ADR-0055 decision 1). Also the
    /// refusal when a binding exists but names a disabled operator.
    NotBoundToAnOperator,
    /// `accounts.operator_key_hold_until` (`0021`) is in the future: this
    /// account's credential was reset, and ADR-0055 decision 7 will not let a
    /// reset restore the operator seat by itself. Another operator confirms
    /// it, or the hold runs out.
    SeatHeld,
    /// `0019` §C's floor: disabling this operator would leave the deployment
    /// with none, and there is no way back from that but the key volume.
    LastLiveOperator,
    /// The session is the setup-only one ADR-0055 decision 1 gives an account
    /// that holds the operator custody and has not enrolled an app code yet.
    /// It reaches the credential routes and nothing else.
    SetupSessionOnly,
    /// **An `operators` row verifies under no row-state shape any build of
    /// this server has ever written**, so it was not written by this server.
    ///
    /// Produced by [`OperatorStore::reseal_legacy_operator_rows`] and by
    /// nothing else: every other reader of that table asks
    /// [`verify_operator_row`], which knows only the current shape and answers
    /// [`OperatorError::Unverifiable`]. It carries the operator id because the
    /// start-time re-seal is the one place where naming the row is what makes
    /// the refusal actionable, and its only reader is a log line on a host
    /// where the database is already reachable.
    UnverifiableOperatorRow(String),
    /// A field of a message was not the shape it must be.
    Malformed(&'static str),
    /// A stored row does not decode as what its column says it is.
    Corrupt(&'static str),
}

impl core::fmt::Display for OperatorError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            // **The database's own message, where there is one.**
            // `tokio_postgres::Error` renders as the bare string "db error",
            // which tells an operator reading a log line nothing at all — and
            // this error only ever reaches a log, because `admin.rs` answers a
            // fixed sentence per status and never this. The same reasoning
            // `tests/planes.rs` gives for reading `as_db_error` rather than
            // the `Display`.
            Self::Db(e) => match e.as_db_error() {
                Some(db) => write!(f, "database error: {}: {}", db.code().code(), db.message()),
                None => write!(f, "database error: {e}"),
            },
            Self::Pool(_) => f.write_str("no database connection was available"),
            Self::Chain(e) => write!(f, "{e}"),
            Self::Repo(e) => write!(f, "{e}"),
            Self::Authority(e) => write!(f, "{e}"),
            Self::Crypto(e) => write!(f, "{e}"),
            Self::NotAnOperator => {
                f.write_str("this is an operator verb and the session is not an operator session")
            }
            Self::OperatorDisabled => f.write_str("this operator is disabled"),
            Self::Unverifiable(what) => write!(
                f,
                "the {what} does not verify under this deployment's chain key, so it was not \
                 written by this server. This is not a permission error and must never render \
                 as one"
            ),
            Self::EnrolmentRefused => f.write_str(
                "enrolment refused. One message for every cause, so that an attacker cannot \
                 tell a spent token from an unknown one or a wrong address from a right one; \
                 the sealed entry carries the reason",
            ),
            Self::Signature(e) => write!(f, "{e}"),
            Self::NoOperatorKey => f.write_str(
                "this operator has no enrolled key, and there is no weaker factor to fall back \
                 to (admin design 4.5)",
            ),
            Self::SecondedByTheRequester => f.write_str(
                "the operator who requested a change cannot second it: two ids that differ is \
                 what the CHECK tests, and two humans is what the rule is about",
            ),
            Self::SeconderNotIndependent => f.write_str(
                "this operator cannot second this request: two ids are two humans only if the \
                 seconder is not disabled, was not created by the requester, and has an \
                 independent sign-in on record older than the longest delay window in force \
                 (admin design 5.5). When nobody is eligible the request stands alone after \
                 its delay (ADR-0055 decision 3)",
            ),
            Self::NotYetEffective => f.write_str(
                "this change is not effective: it is inside its delay, unseconded, or cancelled",
            ),
            Self::SettingUnresolvable => f.write_str(
                "a settings row that claims to be applied does not stand up to its own sealed \
                 entry. The effective value is NOT this row, and this is an incident",
            ),
            Self::NotFound(what) => write!(f, "no such {what}"),
            Self::AlreadyBootstrapped => f.write_str(
                "this deployment already has an operator, so the first-start path is closed",
            ),
            Self::AlreadyEnrolled => f.write_str(
                "an operator key is already enrolled in this deployment, so the first \
                 operator's enrolment token cannot be re-issued. The way back in is another \
                 operator, or a restore from backup. Re-issuing after enrolment would be a \
                 way for anyone who can run a command on this host to mint themselves an \
                 operator session",
            ),
            // ---- ADR-0055 stream (b) --------------------------------
            Self::NotBoundToAnOperator => f.write_str(
                "this account holds no operator custody: there is no binding naming it, or the \
                 operator it names is disabled (ADR-0055 decision 1)",
            ),
            Self::SeatHeld => f.write_str(
                "the operator seat on this account is held: its credential was reset, and a \
                 reset does not restore the operator custody by itself. Another operator \
                 confirms the recovery, or the hold runs out (ADR-0055 decision 7)",
            ),
            Self::LastLiveOperator => f.write_str(
                "disabling the last live operator is refused: the deployment would have none, \
                 and the way back would be the key volume. Add a colleague first (ADR-0055 \
                 decision 4)",
            ),
            Self::SetupSessionOnly => f.write_str(
                "this session is the setup-only one an account holding the operator custody \
                 gets before it has set up an authenticator. It reaches the credential routes \
                 and nothing else (ADR-0055 decision 1)",
            ),
            Self::UnverifiableOperatorRow(id) => write!(
                f,
                "the operators row {id} verifies under neither this build's row seal nor the \
                 one every build before ADR-0055's fix round wrote, so it was not written by \
                 this server. This is not a permission error and must never render as one"
            ),
            Self::Malformed(what) => write!(f, "the {what} is not the shape it must be"),
            Self::Corrupt(what) => write!(f, "a stored {what} is not consistent"),
        }
    }
}

impl std::error::Error for OperatorError {}

impl From<tokio_postgres::Error> for OperatorError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}
impl From<PoolError> for OperatorError {
    fn from(e: PoolError) -> Self {
        Self::Pool(e)
    }
}
impl From<ChainStoreError> for OperatorError {
    fn from(e: ChainStoreError) -> Self {
        Self::Chain(e)
    }
}
impl From<RepoError> for OperatorError {
    fn from(e: RepoError) -> Self {
        Self::Repo(e)
    }
}
impl From<AuthorityError> for OperatorError {
    fn from(e: AuthorityError) -> Self {
        Self::Authority(e)
    }
}
impl From<crypto::CryptoError> for OperatorError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::Crypto(e)
    }
}
impl From<SignatureRefused> for OperatorError {
    fn from(e: SignatureRefused) -> Self {
        Self::Signature(e)
    }
}

/// **What a failed credential read or re-seal means here** -- written
/// 2026-09-21, because it used to mean one thing and one thing only.
///
/// Three call sites in this file read or re-sealed a credential row through
/// `map_err(|_| OperatorError::Corrupt("credential seal"))`, which turns a
/// lost connection, a statement timeout and a permission refusal into *"a
/// stored credential seal is not consistent"* -- an integrity alarm, raised by
/// a database hiccup, on a path (`recover_operator`, the adoption) whose whole
/// job is to be believable when it says something is wrong. A transport error
/// is carried through as a transport error, and only a seal that does not
/// verify is an alarm.
fn credential_failure(e: crate::credentials::CredentialError) -> OperatorError {
    use crate::credentials::CredentialError as C;
    match e {
        C::Db(e) => OperatorError::Db(e),
        C::Pool(e) => OperatorError::Pool(e),
        C::Chain(e) => OperatorError::Chain(e),
        C::Authority(e) => OperatorError::Authority(e),
        C::Crypto(e) => OperatorError::Crypto(e),
        C::Operator(e) => *e,
        // The alarm, and the only one: the row is there and does not verify.
        C::Unverifiable(what) => OperatorError::Unverifiable(what),
        C::Corrupt(what) => OperatorError::Corrupt(what),
        // Everything else is a refusal about a password, a code or a token,
        // and none of these call sites presents one. It cannot be rendered as
        // a database error and it is not an alarm either.
        _ => OperatorError::Corrupt("credential row"),
    }
}

// ---------------------------------------------------------------------------
// The signed and hashed messages
// ---------------------------------------------------------------------------

/// The stored form of an enrolment token: `H(LP(tag) ‖ LP(token))`.
///
/// The token is 32 bytes from the OS CSPRNG and is returned exactly once. It is
/// hashed at rest so that a database read hands an attacker nothing they can
/// redeem, exactly as `sessions::token_hash` does for a bearer token.
pub fn token_hash(token: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64);
    crypto::lp(&mut msg, TAG_ENROLMENT_TOKEN);
    crypto::lp(&mut msg, token);
    Sha256::digest(&msg).into()
}

/// §5.3's request assertion.
///
/// ```text
/// LP("fathom/site/setting/request/v1") ‖ LP(deployment) ‖ LP(operator)
///   ‖ LP(key) ‖ LP(H(value))
/// ```
///
/// # Every field in it is one the client already knows
///
/// `grants::propose_grant` exists because `sign_grant` used to make the client
/// sign bytes containing values the server chose after the client signed. That
/// failure is designed out here rather than worked around: the digest is over
/// the setting's PLAINTEXT value, which the client has, and never over the
/// ciphertext, whose nonce the server draws. The row's `value_digest` is
/// `H(value_ct)` — §5.4's — and is a different statement about the same change:
/// one binds what was meant, the other binds what was stored.
///
/// The operator id is inside the bytes so that an assertion made by one
/// operator cannot be presented inside another's session.
pub fn setting_request_bytes(deployment: &str, operator: &str, key: &str, value: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(160);
    crypto::lp(&mut msg, TAG_SETTING_REQUEST);
    crypto::lp(&mut msg, deployment.as_bytes());
    crypto::lp(&mut msg, operator.as_bytes());
    crypto::lp(&mut msg, key.as_bytes());
    crypto::lp(&mut msg, &Sha256::digest(value));
    msg
}

/// §5.5's seconding assertion: *"the seconder's `second_sig` is a fresh
/// assertion over `H(change digest)`, so seconding is a hardware touch and not
/// a row."*
///
/// ```text
/// LP("fathom/site/setting/second/v1") ‖ LP(deployment) ‖ LP(operator)
///   ‖ LP(change id) ‖ LP(key) ‖ LP(value_digest)
/// ```
///
/// The row exists by now, so the seconder signs over the row's own id and the
/// digest of the bytes that are actually stored — which is what they are
/// agreeing to, and what §5.4's resolver will later check the sealed entry
/// against.
pub fn setting_second_bytes(
    deployment: &str,
    operator: &str,
    change_id: &str,
    key: &str,
    value_digest: &[u8; 32],
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(192);
    crypto::lp(&mut msg, TAG_SETTING_SECOND);
    crypto::lp(&mut msg, deployment.as_bytes());
    crypto::lp(&mut msg, operator.as_bytes());
    crypto::lp(&mut msg, change_id.as_bytes());
    crypto::lp(&mut msg, key.as_bytes());
    crypto::lp(&mut msg, value_digest);
    msg
}

/// §5.5's *"two existing operator assertions"* for creating an operator, half
/// one.
///
/// **The address is inside the assertion** (ADR-0055 decision 5, the lead's
/// resolution 5, 2026-09-21). What an operator asserts is not "mint somebody
/// called Sam" but "invite Sam, at this address, to hold this custody" -- and
/// the address is where the invitation goes. Outside the signature it would be
/// a field whoever holds the database could rewrite between the request and
/// the apply, redirecting an invitation two operators had signed for.
///
/// **The tag stays `fathom/site/operator/request/v1`.** A length-prefixed
/// field added to the end cannot make an old signature verify against the new
/// shape or the other way round -- the bytes differ, and
/// `the_signed_messages_change_with_every_field_they_cover` pins that -- so
/// what a version bump would buy is a second label in §12.2's table for a
/// message no deployment has ever signed outside a test. The cost of the
/// change is stated instead: an operator request signed before 2026-09-21 does
/// not verify after it.
pub fn operator_request_bytes(
    deployment: &str,
    operator: &str,
    display_name: &str,
    address: &str,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(224);
    crypto::lp(&mut msg, TAG_OPERATOR_REQUEST);
    crypto::lp(&mut msg, deployment.as_bytes());
    crypto::lp(&mut msg, operator.as_bytes());
    crypto::lp(&mut msg, display_name.as_bytes());
    crypto::lp(&mut msg, address.as_bytes());
    msg
}

/// Half two, over the row that now exists.
pub fn operator_second_bytes(
    deployment: &str,
    operator: &str,
    request_id: &str,
    display_name: &str,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(192);
    crypto::lp(&mut msg, TAG_OPERATOR_SECOND);
    crypto::lp(&mut msg, deployment.as_bytes());
    crypto::lp(&mut msg, operator.as_bytes());
    crypto::lp(&mut msg, request_id.as_bytes());
    crypto::lp(&mut msg, display_name.as_bytes());
    msg
}

// ---------------------------------------------------------------------------
// Small types
// ---------------------------------------------------------------------------

/// What an enrolment token is for. Mirrors `enrolment_tokens.purpose`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Purpose {
    /// §1.1's authenticator-enrolment token, and §5.1's reset, which are the
    /// same act because there is no password.
    Account,
    /// §5.5's *"a first sign-in that must register an authenticator"*, and
    /// §6.3's first operator.
    Operator,
    /// §6.2's organisation enrolment claim.
    Organisation,
    /// ADR-0055 decision 10's first-operator setup: the token the first start
    /// writes opens the screen that sets a password and enrols the app code,
    /// instead of enrolling a browser key. Subject column: `operator_id`, as
    /// `0019` §B's CHECK requires.
    Setup,
}

impl Purpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Account => "account",
            Self::Operator => "operator",
            Self::Organisation => "organisation",
            Self::Setup => "setup",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "account" => Some(Self::Account),
            "operator" => Some(Self::Operator),
            "organisation" => Some(Self::Organisation),
            "setup" => Some(Self::Setup),
            _ => None,
        }
    }
}

/// A token, handed back **once**, and the row it belongs to.
///
/// The token is not printed by `Debug`, by the rule `secret.rs` exists for and
/// that `sessions::SignedIn` already follows.
pub struct Invitation {
    pub id: String,
    pub purpose: Purpose,
    /// The subject: an account id, an operator id, or an organisation shell id.
    pub subject: String,
    /// The bearer half. Returned once and never stored in the clear.
    pub token: [u8; 32],
    pub expires_at_unix: i64,
}

impl core::fmt::Debug for Invitation {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Invitation")
            .field("id", &self.id)
            .field("purpose", &self.purpose)
            .field("subject", &self.subject)
            .field("token", &"<not printed>")
            .field("expires_at_unix", &self.expires_at_unix)
            .finish()
    }
}

/// One enrolled operator key, as this module reads it back.
#[derive(Clone, Debug)]
pub struct OperatorKey {
    pub id: String,
    pub operator_id: String,
    pub public_key: Vec<u8>,
    pub fpr: [u8; 32],
    pub enrolled_seq: i64,
    pub row_version: i32,
    /// When this key left service — `0` for "still in service", exactly as
    /// `grants::AccountKey::retired_at_unix` is, and for the same reason.
    pub retired_at_unix: i64,
}

/// One operator, as the console and the sign-in path read them.
#[derive(Clone, Debug)]
pub struct Operator {
    pub id: String,
    pub display_name: String,
    pub created_by: Option<String>,
    pub created_seq: Option<i64>,
    pub first_independent_signin_at_unix: i64,
    pub disabled_at_unix: i64,
    pub row_version: i32,
    /// **ADR-0055 stream (b).** The address of the account this operator's
    /// custody is bound to (`operator_account_bindings`, `0019` §A), which is
    /// decision 1's *"the address is the identity"* and decision 5's
    /// destination for a notice.
    ///
    /// `None` for an operator with no binding -- which is every operator a
    /// deployment created before ADR-0055, and nothing this code writes. It is
    /// NOT inside `operators.row_seal`: the binding is a row of its own with
    /// its own seal, for `0019`'s reported reason.
    pub address: Option<String>,
}

impl Operator {
    /// §5.5's sentence for the console: *"created by X, never independently
    /// signed in"*, beside every operator until that stops being true.
    pub fn never_independently_signed_in(&self) -> bool {
        self.first_independent_signin_at_unix == 0
    }

    /// ADR-0055 decision 3, the lead's resolution 9: could this operator
    /// second ANYBODY?
    ///
    /// **Live is not enough.** `0015` §G's `fathom_seconder_is_independent`
    /// refuses a seconder with no independent sign-in on record, and one whose
    /// first sign-in is newer than [`INDEPENDENCE_WINDOW`]. Counting such an
    /// operator towards a quorum of two would be demanding a second signature
    /// from somebody the database will not accept one from -- a deadlock with
    /// a number in front of it, which is exactly what decision 3 removes.
    ///
    /// **Three of the trigger's four clauses, and it says so now.** The fourth
    /// is per-requester and lives in [`Operator::is_eligible_to_second`]; this
    /// one is the deployment-wide fact decision 4's banner is about ("how many
    /// operators could act at all"), not the quorum.
    pub fn counts_towards_quorum(&self, now_unix: i64) -> bool {
        self.disabled_at_unix == 0
            && self.first_independent_signin_at_unix != 0
            && self.first_independent_signin_at_unix
                <= now_unix - INDEPENDENCE_WINDOW.as_secs() as i64
    }

    /// **All four of `fathom_seconder_is_independent`'s clauses, against one
    /// named requester** — ADR-0055 fix (c), 2026-09-21.
    ///
    /// The fourth clause is `0015_operator_console.sql`:719, *"the seconder
    /// was created by the requester, so two ids are not two humans"*, and
    /// leaving it out of the count was a deadlock in exactly the shape
    /// decision 5 calls standing: bootstrap operator A, colleague B whom A
    /// added. Once both had been independently signed in for seven days the
    /// quorum read 2 and B was the only candidate — but B was created by A, so
    /// B's signature raised `P0001` and A could never add a third operator.
    /// The request sat pending for ever.
    ///
    /// So the quorum is per requester: [`quorum_for`] counts the operators who
    /// could second THIS requester and asks for a second signature only when
    /// there is somebody who can give one. When there is nobody, the request
    /// stands alone — **with the delay**, which decision 3 says quorum 1 never
    /// removes.
    pub fn is_eligible_to_second(&self, requester: &str, now_unix: i64) -> bool {
        self.id != requester
            && self.created_by.as_deref() != Some(requester)
            && self.counts_towards_quorum(now_unix)
    }
}

/// One pending change — a setting or an operator — as §5.3 stores it.
#[derive(Clone, Debug)]
pub struct PendingChange {
    pub id: String,
    /// The setting's key, or the new operator's display name.
    pub subject: String,
    pub requested_by: String,
    pub seconded_by: Option<String>,
    pub single_operator: bool,
    pub effective_at_unix: i64,
    pub applied_at_unix: i64,
    pub cancelled_at_unix: i64,
    pub sealed_seq: Option<i64>,
}

/// What §6.3's first start produces.
pub struct Bootstrap {
    pub operator_id: String,
    /// **ADR-0055 decision 1.** The account the first start created for
    /// `FATHOM_OPERATOR_NOTICE_ADDRESS`, and bound the operator custody to.
    /// The person signs in as this account; the operator principal underneath
    /// is what the console checks.
    pub account_id: String,
    pub invitation: Invitation,
}

/// What [`OperatorStore::adopt_first_operator_from_install`] produces on a
/// deployment whose first start happened under a build older than ADR-0055.
///
/// The operator existed already; what the adoption creates is the account at
/// `site_install.notice_address`, the sealed binding between the two, and --
/// only where there is no app code to sign in behind -- the one-shot `setup`
/// token that opens the screen decision 10 describes. `invitation` is `None`
/// when the account already holds a confirmed app code: that person signs in
/// with what they have and registers an operator key from the console
/// (decision 9), and a token minted for them would be a second bearer secret
/// nobody asked for.
///
/// No `Debug`, for [`Reissued`]'s reason: [`Invitation`]'s own `Debug`
/// withholds the token and this type is carried straight to a file.
pub struct Adopted {
    pub operator_id: String,
    pub account_id: String,
    /// The address the install record named, which is now this operator's
    /// identity (ADR-0055 decision 1).
    pub notice_address: String,
    pub invitation: Option<Invitation>,
    /// How many live operator keys the adoption retired, and how many sessions
    /// it ended. Logged by `main.rs` and inside the sealed `operator_adopted`
    /// entry, so the cost of the upgrade is stated in both places.
    pub retired_keys: usize,
    pub ended_sessions: usize,
}

/// **What one start's adoption did, or did not do, and why** -- written
/// 2026-09-21 after the checker found three ways
/// [`OperatorStore::adopt_first_operator_from_install`] could answer "nothing
/// happened" when something had in fact gone wrong.
///
/// The old signature was `Option<Adopted>`, and `None` meant five different
/// things: the ordinary ADR-0055-native start, a deployment that has never
/// started, an install record that is missing while operators exist, a
/// bootstrapped operator that is disabled, and -- once the refusals below
/// existed -- an account that cannot be bound. `main.rs` logged the first of
/// those, correctly, by saying nothing; it logged the rest the same way, which
/// is how an upgrade that did not happen looks exactly like an upgrade that
/// was not needed.
///
/// So: [`Adoption::Nothing`] is the silent case and the only one, and every
/// [`AdoptionRefusal`] is a sentence `main.rs` prints at `error` or `warn` and
/// then **keeps running** -- none of these is a reason to take a working site
/// down, and a refusal is not an integrity alarm. What stops the start is an
/// `Err`, which still means the database or a seal did not answer.
///
/// No `Debug`, for [`Adopted`]'s reason: it carries an [`Invitation`].
pub enum Adoption {
    /// The operator was bound. [`Adopted::invitation`] says whether a token
    /// was written or the account already held a stronger way in.
    Adopted(Adopted),
    /// Nothing to adopt: every operator has a binding (every deployment
    /// installed since 2026-09-21, and every start after an adoption), or the
    /// deployment has no operator and no install record at all because its
    /// first start has not run yet.
    Nothing,
    /// There is something to adopt and it was **not** adopted. Said out loud,
    /// once per start, until somebody fixes it.
    Refused(AdoptionRefusal),
}

impl Adoption {
    /// The adopted operator, or `None` for every other outcome.
    ///
    /// **For assertions and for tests.** `main.rs` matches every variant by
    /// hand and must go on doing so: a refusal that collapsed back into
    /// `None` here would be the silent no-op this type exists to remove.
    pub fn adopted(self) -> Option<Adopted> {
        match self {
            Self::Adopted(adopted) => Some(adopted),
            _ => None,
        }
    }
}

/// **Why an adoption that had something to do did not do it.**
///
/// Every variant carries what a person on the host needs to act: the address,
/// and the ids of the rows involved. None of them carries a secret, because
/// none of these paths mints one -- a refusal happens before the sealed
/// `operator_adopted` entry is appended, so a refused start writes nothing at
/// all.
#[derive(Debug)]
pub enum AdoptionRefusal {
    /// There are operators and no `site_install` row, so there is no address
    /// to bind anybody to. `0015` §C writes that row on the first start and
    /// no role can rewrite it; operators without it means a restore that left
    /// it behind, or a hand-built database.
    NoInstallRecord { operators: i64 },
    /// The one operator a pre-ADR-0055 first start created is **disabled**, so
    /// binding it would hand the deployment's only custody to a seat that
    /// cannot act. Nothing here re-enables an operator: `0015` §A's register
    /// is append-only in effect and §4.5 has re-enrolment go through §5.4's
    /// machinery, not through a start-up path.
    OperatorDisabled {
        operator_id: String,
        address: String,
    },
    /// The account at the install address is **disabled**, so the binding
    /// would be permanent (`0019`'s trigger refuses `UPDATE` and `DELETE` at
    /// every privilege level) and the sign-in behind it would be refused
    /// (`sessions.rs`, `account_disabled`). A token minted against it would
    /// redeem and then dead-end. Enable the account, or restore.
    AccountDisabled {
        operator_id: String,
        account_id: String,
        address: String,
    },
    /// The account at the install address **already holds another operator's
    /// custody**. `operator_account_bindings.account_id` is UNIQUE (`0019`
    /// §A), so the insert would raise `23505` at every start; and a binding
    /// cannot be moved, because nothing may rewrite one.
    AccountAlreadyBound {
        operator_id: String,
        account_id: String,
        address: String,
        bound_to: String,
    },
    /// **More than one operator matches**, so which one holds the install
    /// address is not a question this path may answer by taking the oldest.
    /// The ids are named and an operator chooses -- by disabling the ones that
    /// are not the seat, from a console another operator can still reach, or
    /// from a restore.
    SeveralCandidates {
        operator_ids: Vec<String>,
        address: String,
    },
}

impl core::fmt::Display for AdoptionRefusal {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::NoInstallRecord { operators } => write!(
                f,
                "this deployment has {operators} operator(s) and no site_install row, so \
                 there is no notice address to bind one to"
            ),
            Self::OperatorDisabled { operator_id, .. } => write!(
                f,
                "the operator created before this build ({operator_id}) is disabled, so \
                 it was not bound"
            ),
            Self::AccountDisabled { address, .. } => write!(
                f,
                "the account at the install address ({address}) is disabled, so the \
                 operator was not bound"
            ),
            Self::AccountAlreadyBound {
                address, bound_to, ..
            } => write!(
                f,
                "the account at the install address ({address}) already holds the custody \
                 of operator {bound_to}, and a binding cannot be moved"
            ),
            Self::SeveralCandidates { operator_ids, .. } => write!(
                f,
                "{} operators have no binding and no creator, so which one the install \
                 address belongs to is not this path's to guess",
                operator_ids.len()
            ),
        }
    }
}

/// What [`OperatorStore::reissue_bootstrap_token`] produces: the same
/// invitation §6.3's first start produces, and what it cost.
///
/// No `Debug`, deliberately — [`Invitation`]'s own `Debug` withholds the
/// token, and this type exists to be carried straight to a file.
pub struct Reissued {
    pub operator_id: String,
    pub invitation: Invitation,
    /// The site-chain `seq` of the sealed `enrolment_token_issued` entry this
    /// re-issue wrote. Logged, so that the act can be pointed at.
    pub issued_seq: i64,
    /// The ids of the tokens this re-issue expired — a previously issued and
    /// unredeemed one, if there was one. Ids, never tokens.
    pub expired: Vec<String>,
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/// Everything the operator plane needs, carried together for the same reason
/// `grants::Authority` and `sessions::SessionStore` are: each field is a
/// control, and passing them as one value means a new verb cannot be written
/// that quietly omits one.
pub struct OperatorStore {
    /// **The application pool, `fathom_app`.** §1.3: *"the admin pool is
    /// read-only. Every administrative write goes through an application
    /// endpoint on the application role, which writes the row and its chain
    /// entry in one transaction."* Every write in this file is on this pool.
    pool: Pool,
    ring: Arc<KeyRing>,
    /// `0009`'s one-row deployment identity, inside every signed message so an
    /// assertion made here is an assertion nowhere else.
    deployment: String,
    /// §5.3's delay. A field rather than a constant read at the point of use,
    /// for `SessionStore::with_lifetime`'s reason: otherwise the only way to
    /// observe the delay elapsing in a test is to move a timestamp in SQL,
    /// which breaks the row seal, so the test proves the seal and never the
    /// delay.
    settings_delay: Duration,
}

impl OperatorStore {
    pub fn new(pool: Pool, ring: Arc<KeyRing>, deployment: String) -> Self {
        Self::with_delay(pool, ring, deployment, SETTINGS_DELAY)
    }

    /// As [`OperatorStore::new`], with a delay other than [`SETTINGS_DELAY`].
    ///
    /// **There is no environment variable for this and there must not be**: a
    /// deployment that could set the delay to zero would be a deployment where
    /// one operator changes SMTP instantly, which is the whole attack §5.3 is
    /// about. It is a constructor argument so that a test can watch the delay
    /// elapse, and `main.rs` passes the constant.
    pub fn with_delay(
        pool: Pool,
        ring: Arc<KeyRing>,
        deployment: String,
        settings_delay: Duration,
    ) -> Self {
        Self {
            pool,
            ring,
            deployment,
            settings_delay,
        }
    }

    pub fn deployment(&self) -> &str {
        &self.deployment
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    // -----------------------------------------------------------------------
    // ADR-0055 decision 3 -- the quorum, derived
    // -----------------------------------------------------------------------

    /// **How many operators could actually second something right now.**
    ///
    /// ADR-0055 decision 3 retires `FATHOM_SINGLE_OPERATOR` and ports §3.5's
    /// `min(2, live stewards)` to the operator plane. The lead's resolution 9,
    /// 2026-09-21, fixes what "live" means here, and it is narrower than
    /// "`disabled_at IS NULL`": `0015` §G's `fathom_seconder_is_independent`
    /// refuses a seconder with no independent sign-in on record and one whose
    /// first sign-in is newer than [`INDEPENDENCE_WINDOW`]. A quorum of two
    /// that counted such an operator would be asking for a signature the
    /// database refuses to store -- a deadlock, which is the thing decision 3
    /// exists to remove.
    ///
    /// The predicate is [`Operator::counts_towards_quorum`], so that the rule
    /// is written once and the tests can drive it without a database.
    pub async fn live_independent_operators(&self) -> Result<i64, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        let count = live_independent_operators(&tx).await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(count)
    }

    /// `min(2, live independent operators)` -- decision 3's rule, named.
    ///
    /// **Deployment-wide, and not what gates a request.** Decision 4's banner
    /// asks this; [`OperatorStore::quorum_for`] is what `request_operator`,
    /// `request_setting` and the two applies ask, because the fourth of
    /// `0015` §G's clauses is per requester (ADR-0055 fix (c)).
    pub async fn operator_quorum(&self) -> Result<i64, OperatorError> {
        Ok(self.live_independent_operators().await?.min(2))
    }

    /// **The quorum a request by `requester` actually has to reach** --
    /// [`quorum_for`], in a transaction of its own, for a caller outside one.
    pub async fn quorum_for(&self, requester: &str) -> Result<i64, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        let quorum = quorum_for(&tx, &self.ring, requester).await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(quorum)
    }

    /// **Is this deployment down to a quorum of one?**
    ///
    /// The replacement for the stored `single_operator` field ADR-0055
    /// decision 3 retires. Every reader of the old field calls this instead,
    /// and every one of them now asks the register rather than the process's
    /// environment -- which is what `apply_if_due` and `apply_operator_request`
    /// were already doing by calling `self.single_operator()` rather than
    /// reading the row's own stamped field (their own comments, 2026-09-21).
    pub async fn single_operator(&self) -> Result<bool, OperatorError> {
        Ok(self.operator_quorum().await? < 2)
    }

    pub fn settings_delay(&self) -> Duration {
        self.settings_delay
    }

    // -----------------------------------------------------------------------
    // §6.3 — the very first operator
    // -----------------------------------------------------------------------

    /// **The first operator, and the install record**, written at first start
    /// when no operator exists (§6.3).
    ///
    /// Returns the single-use enrolment token exactly once. §6.3 wants it
    /// written to `/var/lib/fathom/keys/first_operator.token`, 0400, with the
    /// PATH logged and never the token — *"whoever can read that volume is the
    /// legitimate installer"*. That write is the caller's, because `43` §5.4's
    /// container runs with a read-only filesystem and only the key volume is
    /// writable: a function in here that silently failed to write it would be
    /// a deployment with no way in and no message saying so.
    ///
    /// **Idempotent, and it has to be**: two interchangeable containers start
    /// at once. The second one finds an operator and answers
    /// [`OperatorError::AlreadyBootstrapped`], which a caller reads as
    /// "nothing to do". The advisory lock makes that a race nobody loses.
    ///
    /// The `notice_address` is §6.2's install-time address, recorded here
    /// because this is the one moment the product has a human in front of it
    /// and no mail path yet. **No role can ever update it** — `0015` §C
    /// withholds the privilege and raises in a trigger — which is what stops an
    /// operator reseating an organisation through a channel they control.
    pub async fn bootstrap_first_operator(
        &self,
        display_name: &str,
        notice_address: &str,
    ) -> Result<Bootstrap, OperatorError> {
        if display_name.trim().is_empty() {
            return Err(OperatorError::Malformed("operator display name"));
        }
        if notice_address.trim().len() < 3 {
            return Err(OperatorError::Malformed("notice address"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        enter_enrolment_custody(&tx).await?;
        // ADR-0055 decision 1: this start creates an ACCOUNT as well as an
        // operator, and `accounts_readable` (`0013` §A) admits the account
        // custody rather than the operator one. The same pair
        // `set_account_disabled` takes.
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;

        // One bootstrapper at a time, deployment-wide. `chains::append_site`
        // takes the same kind of lock for the chain itself; this one covers
        // the "is there an operator yet" question and the insert together.
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('fathom/operator/bootstrap', 0))",
            &[],
        )
        .await?;

        let existing: i64 = tx
            .query_one("SELECT count(*) FROM operators", &[])
            .await?
            .get(0);
        if existing > 0 {
            return Err(OperatorError::AlreadyBootstrapped);
        }

        let id = ids::new_ulid().to_string();
        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorBootstrapped,
            &entry_metadata(
                EntryType::OperatorBootstrapped,
                &[
                    ("operator", Json::Str(id.clone())),
                    ("display_name", Json::Str(display_name.to_string())),
                    ("notice_address", Json::Str(notice_address.to_string())),
                ],
            ),
        )
        .await?;

        self.insert_operator(&tx, &id, display_name, None, appended.seq)
            .await?;

        // **ADR-0055 decision 1: the address is the identity.** The first
        // start creates the account for `FATHOM_OPERATOR_NOTICE_ADDRESS` and
        // binds the operator custody to it, so that the installer signs in
        // with an address like everybody else and the console recognises them
        // through the binding. The account's display name is the address: it
        // is the one thing the installer has already told this deployment
        // about themselves, and a guessed name would be a name nobody chose.
        let account_id = self
            .account_for_address(&tx, notice_address, notice_address, &id)
            .await?;
        self.bind_operator_to_account(&tx, &id, &account_id, appended.seq)
            .await?;

        // **An install record that already exists wins, and is not
        // overwritten.** §6.2 pins an organisation's enrolment claim to this
        // address precisely because no role can rewrite it, and a second
        // bootstrap that replaced it would be the rewrite the pin exists to
        // refuse. The `DO NOTHING` is what makes "written once" true even on a
        // deployment whose operator register was emptied and rebuilt: the
        // address stays the one install time recorded, and `0015` §C's trigger
        // refuses every other way of changing it.
        tx.execute(
            "INSERT INTO site_install (id, notice_address, installed_seq) \
             VALUES ('install', $1, $2) ON CONFLICT (id) DO NOTHING",
            &[&notice_address, &appended.seq],
        )
        .await?;

        // **ADR-0055 decision 10's last bullet: a `setup` token, not an
        // `operator` one.** *"The first operator's setup: the token file the
        // first start writes opens a setup screen (set the password, enrol the
        // app code, save the backup codes) instead of enrolling a browser
        // key."* The bytes, the file and the `op_` prefix are unchanged; what
        // changed is which screen the token opens, and `0019` §B is the CHECK
        // that lets the column say so.
        //
        // `SETUP_SECRET_WINDOW`, not `ENROLMENT_TOKEN_LIFETIME`. This
        // invitation is never handed to anybody (`main.rs`: no token file is
        // written, ADR-0057 decision 1); `issue_setup_token` mints the one
        // that is, below, once `main.rs` knows whether `FATHOM_SETUP_PASSWORD`
        // is even set. A shorter row lifetime here matches the window a
        // person actually sees, rather than leaving a live, unheld secret in
        // the database for three days after nobody could still be holding
        // it.
        let invitation = self
            .issue_token(
                &tx,
                Purpose::Setup,
                &id,
                &id,
                "bootstrap",
                crate::credentials::SETUP_SECRET_WINDOW,
            )
            .await?;

        tx.execute("SELECT set_config('app.account_custody', 'no', true)", &[])
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        // As the adoption below: the first start has just created the operator
        // ADR-0056 decision 1's bit is about, and the browser at the door must
        // be told `pending` rather than whatever was remembered before it.
        crate::credentials::forget_setup_state(&self.deployment);
        Ok(Bootstrap {
            operator_id: id,
            account_id,
            invitation,
        })
    }

    /// §5.3's declaration: **write `single_operator_mode` at every startup**,
    /// *"so nobody can later claim two-person control was in force"*.
    ///
    /// Called by `main.rs` at every startup, and by nothing else.
    ///
    /// **ADR-0055 decision 3: it is a derived fact now, not a declaration.**
    /// It used to be written only when `FATHOM_SINGLE_OPERATOR` was set, and
    /// what it recorded was what the environment said. The switch is retired;
    /// what this records is what the register says -- how many operators could
    /// actually second something -- so a reader of the trail can see that this
    /// deployment was running on one pair of hands, and when, without taking a
    /// process's environment on trust. There is still no path here that turns
    /// the quorum up or down: it is counted, never set.
    ///
    /// **An entry per startup and not per act.** Two interchangeable containers
    /// restarting is the ordinary case, so this is bounded by restarts; an
    /// entry per change would be bounded by whatever an operator does.
    pub async fn record_single_operator_mode(&self) -> Result<i64, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // **Derived, not declared** (ADR-0055 decision 3). The count is read
        // in the same transaction the entry is appended in, so the sealed
        // statement is about the register as it was when it was made and not
        // about a number this process read a second earlier.
        let live = live_independent_operators(&tx).await?;
        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::SingleOperatorMode,
            &entry_metadata(
                EntryType::SingleOperatorMode,
                &[
                    ("single_operator", Json::Bool(live.min(2) < 2)),
                    ("live_independent_operators", Json::Int(live)),
                    ("quorum", Json::Int(live.min(2))),
                    // The delay is stated beside it, because §5.3's sentence is
                    // that single-operator mode *"reduces the second signature
                    // to none and KEEPS the delay"* — a reader of the trail
                    // should not have to take that on trust.
                    (
                        "settings_delay_seconds",
                        Json::Int(self.settings_delay.as_secs() as i64),
                    ),
                ],
            ),
        )
        .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(appended.seq)
    }

    /// Has this deployment been bootstrapped at all? `main.rs` asks before it
    /// decides whether to write §6.3's token file.
    pub async fn is_bootstrapped(&self) -> Result<bool, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        let count: i64 = tx
            .query_one("SELECT count(*) FROM operators", &[])
            .await?
            .get(0);
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(count > 0)
    }

    /// **The way back in, from the host, for an operator who already exists**
    /// — ADR-0055 decision 8, which reopens §6.3's refusal on the owner's
    /// decision.
    ///
    /// `fathom-server recover-operator <address>` runs where the key volume is
    /// mounted and prints a one-shot ten-minute `setup` code for the operator
    /// bound to that address. That code opens the same screen the first
    /// operator's own token opens: set a credential, enrol the app code, save
    /// the backup codes.
    ///
    /// # What changed, and why it is not a backdoor
    ///
    /// Until 2026-09-21 this function was `reissue_bootstrap_token`, and its
    /// whole safety was one gate: **any** row in `operator_keys` and it
    /// refused. The argument was that a re-issue that worked after enrolment
    /// would let whoever can run a command on this host mint an operator
    /// session without holding a key this deployment has ever seen.
    ///
    /// ADR-0055 decision 8 answers that argument rather than ignoring it, and
    /// the answer is in the ADR: *"the host already holds every key (ADR-0043
    /// §2), so a delay here is theatre"*. A host-level attacker is tier 3 in
    /// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §0.1 and already holds the
    /// master key, the chain key and the database; the gate was never the
    /// thing standing between them and the deployment. What it cost was real:
    /// a sole operator who lost their browser had no way back that was not a
    /// restore, which is the lockout the whole ADR is about. Every product the
    /// ADR surveyed on 2026-09-21 recovers from the host (GitLab, Grafana,
    /// NetBox, Portainer, Keycloak — the ADR's own table), and Microsoft
    /// Entra's break-glass model is custody plus alerting, not a weaker front
    /// door.
    ///
    /// So the control moves from refusal to record: a sealed
    /// `operator_recovered_from_host` entry, a notice to every operator when
    /// mail exists, and a banner on every operator session for seven days
    /// ([`RECOVERY_BANNER_WINDOW`], served by [`OperatorStore::notices`]).
    ///
    /// **And no delay** — decision 8 is explicit that one here would be
    /// theatre. In particular this does NOT set `0021`'s
    /// `operator_key_hold_until`: that hold exists because a MAILED reset is a
    /// route an attacker who controls the mail server can walk, and the key
    /// volume is not. Since ADR-0055 fix (f) it CLEARS one that is already
    /// set, for the same reason — on a sole-operator deployment
    /// [`OperatorStore::confirm_recovery`] refuses self-confirmation, so a
    /// hold had no exit but the clock and the host could not override it.
    ///
    /// # What it takes away — ADR-0055 fix (a), 2026-09-21
    ///
    /// Until that date this restored access and dispossessed nobody: one
    /// `UPDATE accounts SET password_hash`, and the lost browser kept its
    /// session, kept its operator key, and its app code and backup codes still
    /// worked. The quiet mailed path was strictly stronger than the loud host
    /// path, which is backwards. In the same transaction as the record, this
    /// now:
    ///
    /// 1. retires **every live `operator_keys` row** of that operator
    ///    (migration `0024`), so the browser that was lost can sign nothing;
    /// 2. ends **every session of both principals** — the bound account's
    ///    steward sessions and the operator principal's own — each with its
    ///    sealed entry and its `session_revocations` row, because a deleted
    ///    session row is undone by a restore and a revocation row is not
    ///    (`0014` §D);
    /// 3. clears the **app code**: the TOTP secret and all four columns
    ///    `0018` §B's CHECK correlates, so the setup screen this code opens
    ///    enrols a new one — which is what decision 8 already promised — and
    ///    retires the **ten backup codes** that stand beside it, since an app
    ///    code that is gone and codes that still open the account is not a
    ///    cleared second factor;
    /// 4. clears `operator_key_hold_until` (fix (f), above).
    ///
    /// None of that is a power the host did not have: ADR-0043 §2 puts the key
    /// volume inside tier 3, which is the ADR's own argument for there being
    /// no delay here. What it changes is that the act now costs the holder of
    /// a stolen browser their access, which is the whole point of break-glass.
    ///
    /// # What it still refuses
    ///
    /// **It mints no operator.** The address must resolve, through
    /// `operator_account_bindings`, to an operator row that already exists and
    /// is not disabled. An unknown address is [`OperatorError::NotFound`] and
    /// nothing is written — not an account, not an operator, not a token.
    /// That is the line decision 8 draws and it is the line this function
    /// keeps: recovery restores a seat somebody already held, and creating a
    /// seat is still two operators' work or a first start's.
    ///
    /// # The token it replaces
    ///
    /// Any live, unredeemed `setup` or `operator` token for that operator is
    /// expired first, in the same transaction, each with its own sealed
    /// `enrolment_token_expired` entry — `reissue_bootstrap_token`'s rule,
    /// kept for its own reason: two live bearer secrets for one seat, and the
    /// one this command is run because nobody can find is exactly the one
    /// nobody can account for.
    ///
    /// The token is returned once. **Nothing in this module logs it.**
    pub async fn recover_operator(&self, address: &str) -> Result<Reissued, OperatorError> {
        if address.trim().len() < 3 {
            return Err(OperatorError::Malformed("address"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        enter_enrolment_custody(&tx).await?;
        // `accounts` is read here, and `accounts_readable` admits the account
        // custody and not the operator custody (`0013` §A). The same pair
        // `set_account_disabled` takes, for the same reason.
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;

        // The bootstrap's own lock, because this act is the bootstrap's
        // neighbour: a recovery racing a first start must not read the
        // register from one snapshot and mint against another.
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('fathom/operator/bootstrap', 0))",
            &[],
        )
        .await?;

        // **The address is resolved through the BINDING, never through a
        // display name.** `operators.display_name` is free text an operator
        // chose; `operator_account_bindings` is the sealed fact that names
        // which account holds which custody, and `accounts.email` is unique.
        let found = tx
            .query_opt(
                "SELECT b.operator_id, b.account_id FROM operator_account_bindings b \
                   JOIN accounts a ON a.id = b.account_id \
                  WHERE a.email = $1",
                &[&address],
            )
            .await?;
        let Some(found) = found else {
            return Err(OperatorError::NotFound("operator"));
        };
        let operator: String = found.get(0);
        let account: String = found.get(1);

        // The row's own seal, before a token is minted against it. An
        // `operators` row edited in the database is exactly how somebody would
        // point a recovery at a seat nobody expects — and the binding's own
        // seal, because the binding is what just chose the seat.
        let row = verify_operator_row(&tx, &self.ring, &operator).await?;
        if row.disabled_at_unix != 0 {
            return Err(OperatorError::OperatorDisabled);
        }
        self.verify_binding(&tx, &operator, &account).await?;

        let mut expired = self
            .expire_live_tokens(
                &tx,
                Purpose::Setup,
                &operator,
                "operator_recovered_from_host",
            )
            .await?;
        expired.extend(
            self.expire_live_tokens(
                &tx,
                Purpose::Operator,
                &operator,
                "operator_recovered_from_host",
            )
            .await?,
        );

        // ---------------------------------------------------------------
        // ADR-0055 fix (a) -- **the dispossession**, counted here and
        // written below the entry that records it.
        //
        // Until 2026-09-21 this command restored ACCESS and dispossessed
        // NOBODY. Redeeming its code changed exactly one thing,
        // `accounts.password_hash`: the lost browser kept its operator
        // session, kept its operator key, and the old app code and backup
        // codes still worked. The quiet mailed path (decision 7) was
        // strictly stronger than the loud host path, which is backwards --
        // and on a sole-operator deployment, the shape decision 4 calls
        // standing, a stolen browser was permanent, because such an
        // operator can neither disable themselves nor be disabled.
        //
        // Decision 8 says the code *"lets that person set a new password
        // AND enrol a new app code"*, so the app code has to be gone for
        // the setup screen to enrol one; and the host *"already holds every
        // key (ADR-0043 §2)"*, which is the same sentence that says a delay
        // here is theatre and therefore also says retiring those keys from
        // the host gives away nothing the host did not have.
        //
        // The counts are taken in this transaction, put inside the sealed
        // entry, and then performed. Nothing commits unless all of it does.
        //
        // `app.session_custody` for the length of the two phases and no
        // longer: the session rows, the revocation rows, the credential
        // columns on `accounts` and the backup codes are all behind it
        // (`0013` §E, `0014` §D, `0018` §E), and it is the narrowest
        // capability that can read or end a session at all.
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await?;
        let recovered_at = now_unix();
        // Every row's seal verified on the way past: a keyring row edited in
        // the database is how somebody would keep a key alive through a
        // recovery, and `live_operator_keys` answers that with an alarm
        // rather than a shrug.
        let live_keys = live_operator_keys(&tx, &self.ring, &operator, recovered_at).await?;
        let retired_keys = live_keys.len();
        // **Both principals.** `credentials::end_every_session_of` filters
        // `principal_kind = 'steward'`, which is the account; the operator
        // principal has an id of its own and a session of its own, and it
        // is the operator session the lost browser is holding.
        let doomed_sessions: Vec<(String, String)> = tx
            .query(
                "SELECT id, principal_id FROM sessions \
                  WHERE (principal_id = $1 AND principal_kind = 'steward') \
                     OR (principal_id = $2 AND principal_kind = 'operator') \
                  ORDER BY id",
                &[&account, &operator],
            )
            .await?
            .iter()
            .map(|row| (row.get(0), row.get(1)))
            .collect();
        let ended_sessions = doomed_sessions.len();
        let live_codes: Vec<(String, Vec<u8>, i32)> = tx
            .query(
                "SELECT id, code_hash, row_version FROM backup_codes \
                  WHERE account_id = $1 AND used_at IS NULL",
                &[&account],
            )
            .await?
            .iter()
            .map(|row| (row.get(0), row.get(1), row.get(2)))
            .collect();
        let retired_codes = live_codes.len();
        // The hold `credentials::redeem_reset` sets (`0021`, decision 7).
        // Clearing it is fix (f): on a sole-operator deployment `confirm_recovery`
        // refuses self-confirmation, so a redeemed reset parked the only
        // operator seat for 24 hours with no way back from the host -- while
        // decision 8's whole argument is that a delay on the host path is
        // theatre. The host holds every key; it does not need to wait.
        let hold_cleared: bool = tx
            .query_one(
                "SELECT operator_key_hold_until IS NOT NULL FROM accounts WHERE id = $1",
                &[&account],
            )
            .await?
            .get(0);

        // **The record, before the token.** `chains::append_site` is what
        // makes stopping the log stop the act: the entry is appended in this
        // transaction, and if it fails nothing is minted.
        let recorded = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorRecoveredFromHost,
            &entry_metadata(
                EntryType::OperatorRecoveredFromHost,
                &[
                    ("operator", Json::Str(operator.clone())),
                    ("account", Json::Str(account.clone())),
                    // Inside the sealed metadata, like every other address
                    // this module records.
                    ("address", Json::Str(address.to_string())),
                    ("expired_tokens", Json::Int(expired.len() as i64)),
                    // ADR-0055 fix (e): **the time, inside the seal.**
                    // `chain_entries.created_at` is not in the entry's content
                    // hash or seal (`chains.rs`'s INSERT column list), and
                    // `notices()` used to select on it BEFORE verifying
                    // anything -- so a row moved eight days into the past was
                    // simply not selected and the seven-day banner went quiet
                    // with no alarm, which is the opposite of what this act's
                    // whole control is.
                    ("at", Json::Int(recovered_at)),
                    ("retired_keys", Json::Int(retired_keys as i64)),
                    ("ended_sessions", Json::Int(ended_sessions as i64)),
                    ("retired_backup_codes", Json::Int(retired_codes as i64)),
                    ("app_code_cleared", Json::Bool(true)),
                    ("seat_hold_cleared", Json::Bool(hold_cleared)),
                ],
            ),
        )
        .await?;

        // ---------------------------------------------------------------
        // ADR-0055 fix (a) -- the writes the entry above just recorded.
        // `operator_keys` is behind `0024`'s own `UPDATE` policy, under the
        // operator custody this transaction already holds.
        let row_key = grants::site_row_key(&tx, &self.ring).await?;

        // 1. Every live operator key of this operator leaves service.
        // `retired_at` was in `operator_key_row_state` from the day the table
        // was written and nothing had ever set it; `0024` grants the three
        // columns and adds the policy.
        retire_operator_keys(&tx, &row_key, live_keys, recovered_at).await?;

        // 2. Every session of both principals ends -- the revocation row
        // first, then the delete, because `0014` §D's whole argument is that
        // a deleted session row is undone by a restore and a revocation row
        // is not.
        self.end_sessions_as_revocations(
            &tx,
            &row_key,
            &doomed_sessions,
            &operator,
            "operator_recovered_from_host",
        )
        .await?;

        // 3. The app code goes, so the setup screen this code opens enrols a
        // new one -- which is what decision 8 already says it does.
        // `credentials::enrol_totp` refuses an account whose code is
        // confirmed, so leaving the secret in place would make decision 8's
        // second promise unkeepable. All four columns together, because
        // `0018` §B's `accounts_totp_secret_is_whole` correlates them.
        tx.execute(
            "UPDATE accounts \
                SET totp_secret_ct = NULL, totp_secret_nonce = NULL, \
                    totp_secret_key_epoch = NULL, totp_enrolled_at = NULL, \
                    totp_last_step = NULL \
              WHERE id = $1",
            &[&account],
        )
        .await?;

        // 4. The ten backup codes stand BESIDE the app code (decision 10,
        // *"for the lost phone"*), so an app code that is gone and codes that
        // still open the account is not a cleared second factor. Marked
        // spent, because `0018` §C gives `fathom_app` no DELETE -- a spent
        // code stays as the record that it was spent -- and sealed at
        // version 2 against this recovery's own entry, so clearing `used_at`
        // in the database leaves a row that does not verify.
        for (code_id, code_hash, _version) in &live_codes {
            let hash = as_32(code_hash, "backup code hash")?;
            let seal = crate::credentials::backup_code_seal_for(
                &row_key,
                code_id,
                &account,
                &hash,
                recorded.seq,
                2,
                recovered_at,
            );
            tx.execute(
                "UPDATE backup_codes \
                    SET used_at = to_timestamp($2::bigint), used_seq = $3, row_version = 2, \
                        row_seal = $4 \
                  WHERE id = $1 AND used_at IS NULL",
                &[code_id, &recovered_at, &recorded.seq, &seal.to_vec()],
            )
            .await?;
        }

        // 5. The seat hold, cleared -- fix (f). See the count above.
        if hold_cleared {
            tx.execute(
                "UPDATE accounts SET operator_key_hold_until = NULL WHERE id = $1",
                &[&account],
            )
            .await?;
        }

        // 6. The credential seal (migration 0025) covers the app-code columns
        // and the hold, both changed above, so the row is re-sealed here in
        // the same transaction over what is now at rest; without this the
        // next read of the account is an integrity alarm, not a sign-in.
        crate::credentials::reseal_credentials(&tx, &self.ring, &account, None)
            .await
            .map_err(credential_failure)?;

        tx.execute("SELECT set_config('app.session_custody', 'no', true)", &[])
            .await?;

        let invitation = self
            .issue_token(
                &tx,
                Purpose::Setup,
                &operator,
                &operator,
                "operator_recovered_from_host",
                RECOVERY_SETUP_TOKEN_LIFETIME,
            )
            .await?;

        tx.execute("SELECT set_config('app.account_custody', 'no', true)", &[])
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(Reissued {
            operator_id: operator,
            invitation,
            issued_seq: recorded.seq,
            expired,
        })
    }

    /// **The operator a build before ADR-0055 created, bound to the install
    /// address on the first start of a build that has decision 1.**
    ///
    /// Called by `main.rs` at every start, in the arm where
    /// [`OperatorStore::bootstrap_first_operator`] answered
    /// [`OperatorError::AlreadyBootstrapped`]. On every ADR-0055-native
    /// deployment, and on every start after an adoption, it answers `Ok(None)`
    /// after two indexed reads and writes nothing. That is the ordinary case
    /// and it has to stay silent.
    ///
    /// # What it is for
    ///
    /// Decision 1 -- *"the address is the identity"* -- made the first start
    /// create an ACCOUNT for `FATHOM_OPERATOR_NOTICE_ADDRESS`, an operator,
    /// and a sealed row in `operator_account_bindings` between them. A
    /// deployment that did its first start under the older build has the
    /// operator row and the `site_install` row and no binding. On the new
    /// build the bootstrap finds an operator, answers `AlreadyBootstrapped`,
    /// and stops: nobody can sign in, because a sign-in resolves an address to
    /// an account and there is none; and `fathom-server recover-operator
    /// <address>` resolves the address THROUGH the binding, so it refuses with
    /// `NotFound("operator")` and mints nothing. Observed on a real deployment
    /// on 2026-09-21. The remedy has to run without a human, because the
    /// person it exists for is the one who cannot get in.
    ///
    /// # Which operator, and why that one
    ///
    /// The bootstrap's own: `created_by IS NULL` (nobody created it), not
    /// disabled, lowest `created_seq`, and **no binding**. The last clause is
    /// what makes this idempotent -- after an adoption there is a binding, so
    /// the next start finds nothing -- and it is also what stops this touching
    /// a colleague: every operator the console creates has a `created_by` and
    /// a binding of its own.
    ///
    /// The row's seal and its creating entry are verified before anything
    /// rests on it, exactly as [`OperatorStore::recover_operator`] does. An
    /// `operators` row edited in the database is how somebody would point an
    /// adoption at a seat nobody expects.
    ///
    /// # What it takes away
    ///
    /// **The record first**: one sealed `operator_adopted` entry (migration
    /// `0026`), carrying the operator, the address and the counts, appended
    /// before any of the writes it describes -- so a failure to record stops
    /// the act.
    ///
    /// Then, in the same transaction: every live `setup` and `operator` token
    /// of that operator is expired; every live operator key of that operator
    /// is retired; and every session of the operator principal ends as a
    /// sealed revocation. Those keys were enrolled by the older flow, which
    /// redeemed a one-shot token and had no second factor anywhere in the act;
    /// ADR-0055 decision 9 has the operator key register only from the console
    /// with a confirmed app code behind it. Leaving them in service would keep
    /// the weaker route alive underneath the stronger one, which is the shape
    /// fix (a) removed from `recover_operator` on the same day.
    ///
    /// **It is not a recovery and it does not pretend to be one.** It does not
    /// touch the account's credential, its app code, its backup codes or
    /// `0021`'s seat hold, and it raises no seven-day banner: nothing here
    /// says a key volume was reached for, and an upgrade that cleared a
    /// working second factor would lock out the person it is meant to let in.
    ///
    /// # The token, only where there is no other way in
    ///
    /// A `setup` token is minted **only if the account at that address has no
    /// confirmed app code**. If it has one, that person signs in with what
    /// they already hold and registers an operator key from the console
    /// (decision 9), and a token would be a second bearer secret nobody asked
    /// for. The token is returned once and **nothing in this module logs it**.
    ///
    /// # What it refuses, and why a refusal is not an error (2026-09-21)
    ///
    /// Four shapes cannot be adopted and are not failures of this server:
    /// the account at the install address is disabled; it already holds
    /// another operator's custody; the bootstrapped operator is disabled;
    /// more than one operator has no creator and no binding. Each comes back
    /// as an [`AdoptionRefusal`] that `main.rs` names in a log line and keeps
    /// running for, because taking a working site down over a binding nobody
    /// can write yet helps nobody. **Every one of them is decided before the
    /// sealed `operator_adopted` entry is appended**, so a refused start
    /// leaves the site chain exactly as it found it.
    pub async fn adopt_first_operator_from_install(&self) -> Result<Adoption, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        enter_enrolment_custody(&tx).await?;
        // The account is read and written here, and `accounts_readable`
        // (`0013` §A) admits the account custody rather than the operator one
        // -- the pair `bootstrap_first_operator` takes, for its reason.
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;

        // **The bootstrap's own lock.** Two interchangeable containers start
        // at once, and this act reads "is there an unbound operator" and
        // writes the binding that answers it; without the lock both could read
        // the same answer and both adopt.
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('fathom/operator/bootstrap', 0))",
            &[],
        )
        .await?;

        // No install record and no operator means no first start ever ran
        // here, which is a deployment `bootstrap_first_operator` is about to
        // handle or has just failed at: nothing to adopt and nothing to say.
        //
        // **No install record WITH operators is a different thing** and is
        // said out loud (2026-09-21). `0015` §C writes that row on the first
        // start and no role can rewrite it, so operators standing beside a
        // missing one is a restore that left it behind -- and every start
        // after it was silent, because both shapes answered `None`.
        let Some(install) = tx
            .query_opt("SELECT notice_address FROM site_install", &[])
            .await?
        else {
            let operators: i64 = tx
                .query_one("SELECT count(*) FROM operators", &[])
                .await?
                .get(0);
            return Ok(if operators == 0 {
                Adoption::Nothing
            } else {
                Adoption::Refused(AdoptionRefusal::NoInstallRecord { operators })
            });
        };
        let notice_address: String = install.get(0);

        // The one operator this is ever about. `NOT EXISTS` against the
        // binding is the idempotence: it is false for every operator on an
        // ADR-0055-native deployment and for this one after the commit below.
        //
        // **No `LIMIT 1`** (2026-09-21). Two unbound operators with no creator
        // is not a deployment this path understands, and picking the oldest
        // would hand the install address to whichever row sorted first and
        // leave the other one permanently unable to sign in. Both ids are
        // named instead and an operator decides.
        let candidates: Vec<String> = tx
            .query(
                "SELECT o.id FROM operators o \
                  WHERE o.created_by IS NULL AND o.disabled_at IS NULL \
                    AND NOT EXISTS (SELECT 1 FROM operator_account_bindings b \
                                     WHERE b.operator_id = o.id) \
                  ORDER BY o.created_seq ASC",
                &[],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        if candidates.len() > 1 {
            return Ok(Adoption::Refused(AdoptionRefusal::SeveralCandidates {
                operator_ids: candidates,
                address: notice_address,
            }));
        }
        let Some(operator) = candidates.into_iter().next() else {
            // Nothing live to adopt. Before answering "nothing to do", ask
            // whether the one operator a pre-ADR-0055 first start created is
            // sitting there DISABLED: the query above skips it, and until
            // 2026-09-21 that was indistinguishable from an ADR-0055-native
            // deployment in the log and in this return value.
            let disabled = tx
                .query_opt(
                    "SELECT o.id FROM operators o \
                      WHERE o.created_by IS NULL AND o.disabled_at IS NOT NULL \
                        AND NOT EXISTS (SELECT 1 FROM operator_account_bindings b \
                                         WHERE b.operator_id = o.id) \
                      ORDER BY o.created_seq ASC \
                      LIMIT 1",
                    &[],
                )
                .await?;
            return Ok(match disabled {
                Some(row) => Adoption::Refused(AdoptionRefusal::OperatorDisabled {
                    operator_id: row.get(0),
                    address: notice_address,
                }),
                None => Adoption::Nothing,
            });
        };

        // The row's own seal and the entry that created it, before an address
        // is attached to it or a token is minted against it.
        //
        // A row sealed by a build before ADR-0055's fix round fails here, and
        // that is the whole of why `main.rs` runs
        // [`OperatorStore::reseal_legacy_operator_rows`] before this -- on the
        // deployment this path was written for, the seal predates the shape
        // this verifies against.
        verify_operator_row(&tx, &self.ring, &operator).await?;

        // ---------------------------------------------------------------
        // **The two ways the account at that address cannot take this
        // custody** (2026-09-21). Both are checked HERE, before the sealed
        // entry is appended and before anything is written, because a refusal
        // must leave the site chain exactly as it found it.
        if let Some(row) = tx
            .query_opt(
                "SELECT id, disabled_at IS NOT NULL FROM accounts WHERE email = $1",
                &[&notice_address],
            )
            .await?
        {
            let account_id: String = row.get(0);
            let disabled: bool = row.get(1);
            // A disabled account signs in nowhere (`sessions.rs` answers
            // `account_disabled`), and the binding that would be written here
            // can never be undone -- `0019`'s trigger refuses `UPDATE` and
            // `DELETE` on that table at every privilege level including its
            // owner. Binding to it and minting a token would produce a token
            // that redeems and a sign-in that refuses, permanently.
            if disabled {
                return Ok(Adoption::Refused(AdoptionRefusal::AccountDisabled {
                    operator_id: operator,
                    account_id,
                    address: notice_address,
                }));
            }
            // `operator_account_bindings.account_id` is UNIQUE (`0019` §A).
            // Inserting a second binding for it raises `23505`, which came
            // back as an `Err` and took the exit code with it at EVERY start,
            // not just this one.
            if let Some(bound) = tx
                .query_opt(
                    "SELECT operator_id FROM operator_account_bindings WHERE account_id = $1",
                    &[&account_id],
                )
                .await?
            {
                return Ok(Adoption::Refused(AdoptionRefusal::AccountAlreadyBound {
                    operator_id: operator,
                    account_id,
                    address: notice_address,
                    bound_to: bound.get(0),
                }));
            }
        }

        // `app.session_custody` for the length of the dispossession and no
        // longer: the operator keyring, the session rows and the revocation
        // rows are behind it (`0015` §J, `0013` §E, `0014` §D), and it is the
        // narrowest capability that can end a session at all.
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await?;
        let adopted_at = now_unix();

        // **The counts are taken before the entry, so they are inside it.**
        // Every row's seal is verified on the way past: a keyring row edited
        // in the database is how somebody would keep a key alive through an
        // adoption, and `live_operator_keys` answers that with an alarm rather
        // than a shrug.
        let live_keys = live_operator_keys(&tx, &self.ring, &operator, adopted_at).await?;
        let retired_keys = live_keys.len();
        // **The operator principal only.** The account does not exist yet on
        // the deployment this is written for, and where it does exist it is a
        // steward seat this act has no quarrel with: what decision 9 says has
        // no second factor behind it is the operator key and the operator
        // session the older flow issued against it.
        let doomed_sessions: Vec<(String, String)> = tx
            .query(
                "SELECT id, principal_id FROM sessions \
                  WHERE principal_id = $1 AND principal_kind = 'operator' \
                  ORDER BY id",
                &[&operator],
            )
            .await?
            .iter()
            .map(|row| (row.get(0), row.get(1)))
            .collect();
        let ended_sessions = doomed_sessions.len();
        // The same predicate `expire_live_tokens` uses, counted here because
        // the entry that records the act is appended before the act.
        let expiring: i64 = tx
            .query_one(
                "SELECT count(*) FROM enrolment_tokens \
                  WHERE operator_id = $1 AND purpose IN ('setup', 'operator') \
                    AND redeemed_at IS NULL AND expired_at IS NULL",
                &[&operator],
            )
            .await?
            .get(0);

        // **The record, before anything else.** `chains::append_site` is what
        // makes stopping the log stop the act.
        let recorded = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorAdopted,
            &entry_metadata(
                EntryType::OperatorAdopted,
                &[
                    ("operator", Json::Str(operator.clone())),
                    // Inside the sealed metadata, like every other address
                    // this module records.
                    ("notice_address", Json::Str(notice_address.clone())),
                    ("at", Json::Int(adopted_at)),
                    ("retired_keys", Json::Int(retired_keys as i64)),
                    ("ended_sessions", Json::Int(ended_sessions as i64)),
                    ("expired_tokens", Json::Int(expiring)),
                ],
            ),
        )
        .await?;

        // ADR-0055 decision 1: the address is the identity. An account that
        // already exists at that address is REUSED -- one person, two
        // custodies, one address -- and `accounts.email`'s uniqueness would
        // force it anyway.
        let account = self
            .account_for_address(&tx, &notice_address, &notice_address, &operator)
            .await?;
        self.bind_operator_to_account(&tx, &operator, &account, recorded.seq)
            .await?;

        // ---------------------------------------------------------------
        // The dispossession the entry above just recorded.
        let mut expired = self
            .expire_live_tokens(&tx, Purpose::Setup, &operator, "operator_adopted")
            .await?;
        expired.extend(
            self.expire_live_tokens(&tx, Purpose::Operator, &operator, "operator_adopted")
                .await?,
        );
        if expired.len() as i64 != expiring {
            // The count went inside a sealed entry; a read and a write one
            // statement apart under the bootstrap advisory lock cannot
            // disagree, and an entry that misstates what happened is worse
            // than a refusal.
            return Err(OperatorError::Corrupt("enrolment token row"));
        }

        let row_key = grants::site_row_key(&tx, &self.ring).await?;
        retire_operator_keys(&tx, &row_key, live_keys, adopted_at).await?;
        self.end_sessions_as_revocations(
            &tx,
            &row_key,
            &doomed_sessions,
            &operator,
            "operator_adopted",
        )
        .await?;

        // **A token only where there is no other way in.** An account with a
        // confirmed app code already holds a credential and a second factor;
        // decision 9 has it register an operator key from the console, and a
        // token here would be a bearer secret standing beside a stronger
        // route.
        let has_app_code = crate::credentials::read_credentials(&tx, &self.ring, &account)
            .await
            .map_err(credential_failure)?
            .is_some_and(|row| row.totp_confirmed());

        tx.execute("SELECT set_config('app.session_custody', 'no', true)", &[])
            .await?;

        // `SETUP_SECRET_WINDOW`, not `ENROLMENT_TOKEN_LIFETIME` — the same
        // fix and the same reason as `bootstrap_first_operator`'s own
        // invitation above it: this one is never handed to anybody either
        // (`main.rs`'s adoption arm says so at the point it discards it),
        // and `issue_setup_token` mints the token a person actually redeems,
        // separately, once `main.rs` knows the shape this start is.
        let invitation = if has_app_code {
            None
        } else {
            Some(
                self.issue_token(
                    &tx,
                    Purpose::Setup,
                    &operator,
                    &operator,
                    "adoption",
                    crate::credentials::SETUP_SECRET_WINDOW,
                )
                .await?,
            )
        };

        tx.execute("SELECT set_config('app.account_custody', 'no', true)", &[])
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        // ADR-0056 decision 1's one bit has just come into existence: this
        // deployment now has a first operator with no credential, so
        // `GET /setup/state` must say `pending` to the very next caller. The
        // cache is process-wide (`credentials::forget_setup_state`) precisely
        // so that this path -- a startup act, with no `CredentialStore` in
        // reach -- can drop it.
        crate::credentials::forget_setup_state(&self.deployment);
        Ok(Adoption::Adopted(Adopted {
            operator_id: operator,
            account_id: account,
            notice_address,
            invitation,
            retired_keys,
            ended_sessions,
        }))
    }

    /// **Every live operator who holds no account custody**, oldest first --
    /// the colleagues a pre-ADR-0055 build created, named at every start
    /// (2026-09-21).
    ///
    /// [`OperatorStore::adopt_first_operator_from_install`] adopts exactly one
    /// operator: the one with no `created_by`, which is the one a first start
    /// minted. An operator a pre-ADR-0055 build created through the console
    /// has a `created_by` and no binding, and ADR-0055 decision 1 gives it no
    /// way to acquire one -- it cannot sign in, because sign-in resolves the
    /// custody through the binding, and nothing but a new operator row and a
    /// new binding would let that person in.
    ///
    /// **It still counts towards the quorum**, because
    /// [`live_independent_operators`] asks `disabled_at` and
    /// `first_independent_signin_at` and not the binding. Deliberately not
    /// changed here: a count that dropped would change what a second signature
    /// means on a live deployment, and that is a decision, not a fix. What
    /// this does is say the ids out loud so an operator can disable them from
    /// the console, which is the supported way to make the count right.
    ///
    /// One query, and `main.rs` logs only when it comes back non-empty.
    pub async fn operators_without_a_binding(&self) -> Result<Vec<String>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        let ids: Vec<String> = tx
            .query(
                "SELECT o.id FROM operators o \
                  WHERE o.disabled_at IS NULL \
                    AND NOT EXISTS (SELECT 1 FROM operator_account_bindings b \
                                     WHERE b.operator_id = o.id) \
                  ORDER BY o.created_seq ASC",
                &[],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(ids)
    }

    /// **End every session in `doomed`, each as a sealed revocation** -- the
    /// shape `0014` §D requires: the entry, then the `session_revocations`
    /// row whose MAC covers that entry's `seq`, then the delete, because a
    /// deleted session row is undone by a restore and a revocation row is not.
    ///
    /// Shared by [`OperatorStore::recover_operator`] and
    /// [`OperatorStore::adopt_first_operator_from_install`], which end
    /// different sets of sessions for different reasons and must not end them
    /// in two slightly different ways. A session whose `principal_id` is
    /// `operator` is filed as `operator_signed_out`; anything else is the
    /// bound account's own seat and is filed as `account_signed_out`.
    ///
    /// `reason` goes inside the sealed metadata. The `session_revocations`
    /// row's own reason is `signed_out`, which is the one value `0014` §D's
    /// CHECK takes.
    async fn end_sessions_as_revocations(
        &self,
        tx: &Transaction<'_>,
        row_key: &Key32,
        doomed: &[(String, String)],
        operator: &str,
        reason: &str,
    ) -> Result<(), OperatorError> {
        for (session_id, principal) in doomed {
            let is_operator_session = principal == operator;
            let appended = chains::append_site(
                tx,
                &self.ring,
                &self.deployment,
                if is_operator_session {
                    EntryType::OperatorSignedOut
                } else {
                    EntryType::AccountSignedOut
                },
                &entry_metadata(
                    if is_operator_session {
                        EntryType::OperatorSignedOut
                    } else {
                        EntryType::AccountSignedOut
                    },
                    &[
                        ("session", Json::Str(session_id.clone())),
                        (
                            if is_operator_session {
                                "operator"
                            } else {
                                "account"
                            },
                            Json::Str(principal.clone()),
                        ),
                        (
                            "principal_kind",
                            Json::Str(
                                if is_operator_session {
                                    "operator"
                                } else {
                                    "steward"
                                }
                                .to_string(),
                            ),
                        ),
                        ("reason", Json::Str(reason.to_string())),
                    ],
                ),
            )
            .await?;
            let mac = crate::sessions::revocation_row_mac(
                row_key,
                &crate::sessions::RevocationFacts {
                    session_id,
                    principal_id: principal,
                    // The one value `0014` §D's CHECK takes, and a
                    // break-glass IS a sign-out of every browser.
                    reason: "signed_out",
                    chain_seq: appended.seq,
                    row_version: 1,
                },
            );
            tx.execute(
                "INSERT INTO session_revocations \
                     (session_id, principal_id, reason, chain_seq, row_version, row_mac) \
                 VALUES ($1, $2, 'signed_out', $3, 1, $4) \
                 ON CONFLICT (session_id) DO NOTHING",
                &[session_id, principal, &appended.seq, &mac.to_vec()],
            )
            .await?;
            tx.execute("DELETE FROM sessions WHERE id = $1", &[session_id])
                .await?;
        }
        Ok(())
    }

    /// Expire every live, unredeemed token of `purpose` for this subject, so
    /// a re-issue leaves one bearer secret alive and not two. Returns their
    /// ids, never the tokens.
    ///
    /// Shared by [`OperatorStore::reissue_bootstrap_token`] (`purpose =
    /// operator`) and [`OperatorStore::issue_account_enrolment`] (`purpose =
    /// account`), and by `credentials::CredentialStore::redeem_setup_by_token`
    /// (`purpose = setup`) — `pub(crate)` for that last caller. `subject` is
    /// checked against the column `purpose` names, never trusted to match it.
    ///
    /// The kill is `expired_at`, with its `enrolment_token_expired` entry;
    /// `0015` §I grants the runtime role no other way to retire a token row.
    pub(crate) async fn expire_live_tokens(
        &self,
        tx: &Transaction<'_>,
        purpose: Purpose,
        subject: &str,
        reason: &'static str,
    ) -> Result<Vec<String>, OperatorError> {
        // The column a subject id is checked against, from a closed set and
        // never taken from a caller (`sessions.rs`'s `latch` rule).
        let column = match purpose {
            Purpose::Account => "account_id",
            Purpose::Operator | Purpose::Setup => "operator_id",
            Purpose::Organisation => "shell_id",
        };
        // The site chain's advisory lock, before the row lock below — ADR-0057
        // decision 1's fix round: every append already takes this lock ahead
        // of its row's `UPDATE`, and taking the row lock first here inverted
        // that order against a concurrent redemption, deadlocking (40P01).
        chains::lock_site(tx, &self.deployment).await?;
        // Every candidate row is locked here, before a chain entry is
        // appended for any of them, so a concurrent spend of one of these
        // same rows blocks behind this transaction instead of racing it.
        let rows = tx
            .query(
                &format!(
                    "SELECT {TOKEN_COLUMNS} FROM enrolment_tokens \
                      WHERE purpose = $1 AND {column} = $2 \
                        AND redeemed_at IS NULL AND expired_at IS NULL \
                      ORDER BY id FOR UPDATE"
                ),
                &[&purpose.as_str(), &subject],
            )
            .await?;

        let now = now_unix();
        let mut expired = Vec::with_capacity(rows.len());
        for row in &rows {
            let (token, stored_seal) = token_row(row)?;

            // The seal first. A token row that does not verify is not re-sealed
            // into a new state by this path -- that would launder it -- and the
            // whole re-issue refuses instead.
            let as_stored = self
                .token_seal(tx, &token.facts(), token.issued_seq, token.row_version)
                .await?;
            if stored_seal != as_stored {
                return Err(OperatorError::Unverifiable("enrolment token row seal"));
            }

            // §7.2's type, with the reason inside the sealed metadata: this
            // token did not run out of time, it was replaced. A reader holding
            // the chain key can tell the two apart.
            let appended = chains::append_site(
                tx,
                &self.ring,
                &self.deployment,
                EntryType::EnrolmentTokenExpired,
                &entry_metadata(
                    EntryType::EnrolmentTokenExpired,
                    &[
                        ("token", Json::Str(token.id.clone())),
                        ("purpose", Json::Str(token.purpose.as_str().to_string())),
                        ("reason", Json::Str(reason.to_string())),
                    ],
                ),
            )
            .await?;

            let mut facts = token.facts();
            facts.expired_at_unix = now;
            let version = token.row_version + 1;
            let seal = self
                .token_seal(tx, &facts, token.issued_seq, version)
                .await?;

            // Both columns in one statement, because the table's own
            // `CHECK ((expired_at IS NULL) = (expired_seq IS NULL))` refuses
            // the state between them. `row_version = $6` ties this write to
            // the exact row this loop iteration read, the same guard
            // `mark_redeemed` now carries for the identical reason.
            let updated = tx
                .execute(
                    "UPDATE enrolment_tokens \
                        SET expired_at = to_timestamp($2::bigint), expired_seq = $3, \
                            row_version = $4, row_seal = $5 \
                      WHERE id = $1 AND redeemed_at IS NULL AND expired_at IS NULL \
                            AND row_version = $6",
                    &[
                        &token.id,
                        &now,
                        &appended.seq,
                        &version,
                        &seal.to_vec(),
                        &token.row_version,
                    ],
                )
                .await?;
            if updated == 0 {
                // Should not happen: this row was locked above, in this same
                // transaction, before any chain entry was appended for it.
                // Abort rather than commit a chain entry no write backs.
                return Err(OperatorError::Corrupt("enrolment token row"));
            }
            expired.push(token.id);
        }
        Ok(expired)
    }

    // -----------------------------------------------------------------------
    // §1.1 — account shells and their invitations
    // -----------------------------------------------------------------------

    /// §1.1: *"create an account shell (email, display name)"*, and the
    /// invitation that turns it into somebody who can sign in.
    ///
    /// **The account has no key and no membership and gets neither here.** It
    /// is a shell: an address, a name, and a token the holder of that address
    /// redeems to enrol the key everything else rests on. §6.4's *"a steward
    /// signs a grant naming a subject who already has a registered key"* is
    /// what stops this being a route to authority — an account with no key is
    /// a subject no grant can name.
    ///
    /// One transaction: the principal row, the account row, the sealed
    /// `account_created` entry, the token row and the sealed
    /// `enrolment_token_issued` entry, or none of them.
    pub async fn create_account_shell(
        &self,
        operator: &VerifiedSession,
        address: &str,
        display_name: &str,
    ) -> Result<Invitation, OperatorError> {
        let acting = self.acting_operator(operator)?;
        if address.trim().len() < 3 {
            return Err(OperatorError::Malformed("address"));
        }
        if display_name.trim().is_empty() {
            return Err(OperatorError::Malformed("display name"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        let account = AccountId::new().to_string();
        chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::AccountCreated,
            &entry_metadata(
                EntryType::AccountCreated,
                &[
                    ("account", Json::Str(account.clone())),
                    ("operator", Json::Str(acting.clone())),
                    // The address is inside the SEALED metadata, which is
                    // AEAD ciphertext under a key that is not in PostgreSQL
                    // (§7.3), so recording who was invited does not put a list
                    // of addresses in the clear anywhere the entries are read.
                    ("address", Json::Str(address.to_string())),
                    ("display_name", Json::Str(display_name.to_string())),
                ],
            ),
        )
        .await?;

        // `0004`: every account is a steward principal through a composite key
        // whose `kind` half is a generated constant, so the principal row must
        // exist before the account row can. That is the fence which makes an
        // operator id unrepresentable in a membership — and it is why this is
        // two statements rather than `repo::create_account`, which opens a
        // transaction of its own and would put the rows outside the entry's.
        tx.execute(
            "INSERT INTO principals (id, kind) VALUES ($1, 'steward')",
            &[&account],
        )
        .await?;
        tx.execute(
            "INSERT INTO accounts (id, email, display_name) VALUES ($1, $2, $3)",
            &[&account, &address, &display_name],
        )
        .await?;

        let invitation = self
            .issue_token(
                &tx,
                Purpose::Account,
                &account,
                &acting,
                "account_shell",
                ENROLMENT_TOKEN_LIFETIME,
            )
            .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(invitation)
    }

    /// §1.1's *"initiate an authenticator-enrolment token"* for an account that
    /// already exists, **which is also §5.1's reset**.
    ///
    /// §5.1: *"the admin page has no 'set password' control. It has 'send a
    /// reset link', and the link goes only to the account's verified address of
    /// record. No override field, no operator-supplied destination."* There is
    /// no password in this product, so what the link carries is an enrolment
    /// token, and this is the one function that issues one — **there is no
    /// parameter here for a destination**: the token is bound to the account,
    /// and redemption re-reads that account's own address.
    ///
    /// §4.4's third path is *"a one-time enrolment token AND a steward
    /// co-signature"*, and an operator *"may initiate it and cannot complete
    /// it"*. **The steward co-signature is not built** and its absence is the
    /// one place this build is weaker than §4.4: today, an operator who
    /// intercepts the token of an account that already holds grants can enrol a
    /// key on it. `docs/OPEN-QUESTIONS.md` has no entry for this; it is
    /// reported to the lead rather than closed here, because closing it means
    /// building the steward co-signature path, which is a grant-shaped act and
    /// belongs with the authority layer.
    ///
    /// **A re-issue kills the account's other live tokens first**, mirroring
    /// [`OperatorStore::reissue_bootstrap_token`]'s own kill through the same
    /// [`OperatorStore::expire_live_tokens`]: without it, a first invitation
    /// that leaked stayed redeemable for its whole 72-hour life even after a
    /// second was issued to fix exactly that. This does not touch any key
    /// already enrolled — an account may hold more than one, by §4.4's own
    /// *"two authenticators at enrolment, not one"*, and retiring one on a
    /// re-issue is a steward-co-signed act this function is not.
    pub async fn issue_account_enrolment(
        &self,
        operator: &VerifiedSession,
        account: &str,
    ) -> Result<Invitation, OperatorError> {
        let acting = self.acting_operator(operator)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // `enrolment_tokens_updatable` (`0015`) grants `UPDATE` only under
        // `app.enrolment_custody`, not `app.operator_custody` — the same
        // second capability `reissue_bootstrap_token` already holds for the
        // identical reason: `expire_live_tokens`'s `UPDATE` is a spend of the
        // token it is retiring, the redemption path's own act, and operator
        // custody alone does not carry it.
        enter_enrolment_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        // `accounts_readable` (`0013`) has no `app.operator_custody` branch —
        // only `account_custody`, `session_custody` and the account's own
        // `app.account_id` — so `app.operator_custody` alone leaves this
        // read seeing no row at all, for every account this function is ever
        // called with. `set_account_disabled` already carries this exact
        // second setting for the same table; this function needed it too and
        // did not have it, so §5.1's reset could never find the account it
        // was resetting.
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;
        let exists = tx
            .query_opt("SELECT 1 FROM accounts WHERE id = $1", &[&account])
            .await?;
        if exists.is_none() {
            return Err(OperatorError::NotFound("account"));
        }

        self.expire_live_tokens(&tx, Purpose::Account, account, "reissued")
            .await?;

        let invitation = self
            .issue_token(
                &tx,
                Purpose::Account,
                account,
                &acting,
                "reissued",
                ENROLMENT_TOKEN_LIFETIME,
            )
            .await?;

        tx.execute("SELECT set_config('app.account_custody', 'no', true)", &[])
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(invitation)
    }

    /// **Redeem an account's enrolment token: the act that turns an invitation
    /// into a person who can sign in.**
    ///
    /// The browser generates a keypair, keeps the private half, and sends the
    /// public half with the token and the address it believes it is enrolling.
    ///
    /// # What is checked, and the order
    ///
    /// 1. the token hash names a live row — never redeemed, not expired, seal
    ///    verifies;
    /// 2. the row's purpose is `account`;
    /// 3. **the address the caller claims is the address on the account the
    ///    TOKEN names** — so a token for one address cannot enrol a key for
    ///    another, whichever of the two the caller controls;
    /// 4. the account is not disabled;
    /// 5. the token is spent, atomically, by a guarded `UPDATE` whose new state
    ///    goes back into the row seal;
    /// 6. the key is enrolled through `grants::enrol_software_key_at_invitation`
    ///    — the same row, the same seal and the same keyring shape every other
    ///    enrolment writes.
    ///
    /// Every refusal is [`OperatorError::EnrolmentRefused`], one message for
    /// every cause, and the sealed entry carries the reason.
    ///
    /// **The reason survives the refusal that finds it.** The transaction
    /// above refuses without committing — so an entry appended inside it,
    /// naming the reason, rolls back with everything else — and until this
    /// was fixed the guess that mattered most (an address checked against the
    /// wrong account) left no trace at all: the token stayed live and nobody
    /// could tell it had been tried. [`OperatorStore::record_redemption_refused`]
    /// is the second, short transaction that survives the rollback, appended
    /// after this one has already failed and the caller still gets the one
    /// uniform [`OperatorError::EnrolmentRefused`] either way.
    pub async fn redeem_account_enrolment(
        &self,
        token: &[u8],
        address: &str,
        public_key: &[u8],
    ) -> Result<String, OperatorError> {
        check_public_key(public_key)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_enrolment_custody(&tx).await?;

        let row = match self.spend_token(&tx, token, Purpose::Account).await {
            Ok(row) => row,
            Err(OperatorError::EnrolmentRefused) => {
                self.record_redemption_refused(
                    EntryType::AccountSigninFailed,
                    Purpose::Account,
                    "token_invalid",
                )
                .await;
                return Err(OperatorError::EnrolmentRefused);
            }
            Err(e) => return Err(e),
        };
        let account = row
            .account_id
            .clone()
            .ok_or(OperatorError::Corrupt("enrolment token subject"))?;

        // The account is named by the TOKEN. The address is checked against
        // that account's own row, never used to find one: a caller who could
        // choose the account by address could enrol a key on any account whose
        // address they could guess, which is the takeover this path exists to
        // refuse.
        set_account_id(&tx, &account).await?;
        let found = tx
            .query_opt(
                "SELECT email, disabled_at IS NOT NULL FROM accounts WHERE id = $1",
                &[&account],
            )
            .await?;
        let Some(found) = found else {
            self.record_redemption_refused(
                EntryType::AccountSigninFailed,
                Purpose::Account,
                "account_not_found",
            )
            .await;
            return Err(OperatorError::EnrolmentRefused);
        };
        let on_record: String = found.get(0);
        let disabled: bool = found.get(1);
        if on_record != address || disabled {
            // **This is the guessing oracle's own check.** Somebody holding a
            // leaked token can present any address; the reason distinguishes a
            // wrong guess from a disabled account for an operator reading the
            // sealed entry, and neither reason is ever returned to the caller.
            let reason = if on_record != address {
                "address_mismatch"
            } else {
                "account_disabled"
            };
            self.record_redemption_refused(
                EntryType::AccountSigninFailed,
                Purpose::Account,
                reason,
            )
            .await;
            return Err(OperatorError::EnrolmentRefused);
        }

        let redeemed = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::EnrolmentTokenRedeemed,
            &entry_metadata(
                EntryType::EnrolmentTokenRedeemed,
                &[
                    ("token", Json::Str(row.id.clone())),
                    ("purpose", Json::Str(Purpose::Account.as_str().to_string())),
                    ("account", Json::Str(account.clone())),
                ],
            ),
        )
        .await?;
        self.mark_redeemed(&tx, &row, redeemed.seq).await?;

        let key = grants::enrol_software_key_at_invitation(
            &tx,
            &self.ring,
            &self.deployment,
            &account,
            public_key,
        )
        .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(key.id)
    }

    // -----------------------------------------------------------------------
    // §6.2 — organisation shells and their claims
    // -----------------------------------------------------------------------

    /// §6.2: *"an operator may create an organisation shell: a row with a name,
    /// no genesis, and an enrolment claim. The shell holds no data and permits
    /// no design creation until the claim is redeemed by an account with a
    /// registered authenticator."*
    ///
    /// The claim is pinned to the install-time `notice_address`, which no role
    /// can update. Redeeming it requires presenting that address, so an
    /// operator who rewrote the destination — which they cannot — would still
    /// have to know it.
    pub async fn create_organisation_shell(
        &self,
        operator: &VerifiedSession,
        display_name: &str,
    ) -> Result<(String, Invitation), OperatorError> {
        let acting = self.acting_operator(operator)?;
        if display_name.trim().is_empty() {
            return Err(OperatorError::Malformed("display name"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        let notice = self.notice_address(&tx).await?;
        let shell = ids::new_ulid().to_string();
        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OrgShellCreated,
            &entry_metadata(
                EntryType::OrgShellCreated,
                &[
                    ("shell", Json::Str(shell.clone())),
                    ("display_name", Json::Str(display_name.to_string())),
                    // §6.2's *"this organisation was bootstrapped by operator X
                    // on date D"*, rendered from the chain, permanently.
                    ("operator", Json::Str(acting.clone())),
                    ("notice_address", Json::Str(notice)),
                ],
            ),
        )
        .await?;

        let seal = self
            .shell_seal(&tx, &shell, display_name, &acting, None, 0, appended.seq, 1)
            .await?;
        tx.execute(
            "INSERT INTO organisation_shells \
                 (id, display_name, created_by, created_seq, row_version, row_seal) \
             VALUES ($1, $2, $3, $4, 1, $5)",
            &[
                &shell,
                &display_name,
                &acting,
                &appended.seq,
                &seal.to_vec(),
            ],
        )
        .await?;

        let invitation = self
            .issue_token(
                &tx,
                Purpose::Organisation,
                &shell,
                &acting,
                "org_shell",
                ENROLMENT_TOKEN_LIFETIME,
            )
            .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok((shell, invitation))
    }

    /// **Redeem an organisation claim: §6.1's genesis, run by the account that
    /// holds the claim.**
    ///
    /// The redeemer is a steward session — an account that already has a key,
    /// which is §6.2's *"redeemed by an account with a registered
    /// authenticator"*. The organisation that results has the id §6.1 derives
    /// from the root public key, so the shell's own id is not it: the shell
    /// records which organisation its claim produced and stops being
    /// redeemable. `0015` §D carries the argument for why a shell is not a row
    /// in `organisations`.
    ///
    /// **An operator cannot call this**, and not because of a check in here:
    /// `grants::bootstrap_organisation` needs an `AccountId` and a membership
    /// it creates for that account, and `0004`'s composite keys make an
    /// operator principal unrepresentable in a membership at every privilege
    /// level. The session check below is the polite refusal in front of a fence
    /// that does not need it.
    #[allow(clippy::too_many_arguments)]
    pub async fn redeem_organisation_claim(
        &self,
        session: &VerifiedSession,
        token: &[u8],
        notice_address: &str,
        root_pubkey: &[u8],
        id_salt: &[u8; 16],
        genesis: &[GenesisGrant],
    ) -> Result<OrganisationId, OperatorError> {
        if session.kind() != PrincipalKind::Steward {
            return Err(OperatorError::EnrolmentRefused);
        }
        let creator: AccountId = session
            .principal_id()
            .parse()
            .map_err(|_| OperatorError::Corrupt("session principal id"))?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_enrolment_custody(&tx).await?;

        // The claim is pinned to the install-time address and the caller has
        // to present it. §6.2: this is the piece that stops an operator
        // reseating an organisation through a channel inside their own plane.
        if self.notice_address(&tx).await? != notice_address {
            return Err(OperatorError::EnrolmentRefused);
        }

        let row = self.spend_token(&tx, token, Purpose::Organisation).await?;
        let shell = row
            .shell_id
            .clone()
            .ok_or(OperatorError::Corrupt("enrolment token subject"))?;

        let found = tx
            .query_opt(
                "SELECT display_name, organisation_id IS NOT NULL, created_by, created_seq, \
                        row_version, row_seal \
                   FROM organisation_shells WHERE id = $1",
                &[&shell],
            )
            .await?;
        let Some(found) = found else {
            return Err(OperatorError::EnrolmentRefused);
        };
        let display_name: String = found.get(0);
        let already: bool = found.get(1);
        let created_by: String = found.get(2);
        let created_seq: i64 = found.get(3);
        let row_version: i32 = found.get(4);
        let stored_seal: Vec<u8> = found.get(5);
        if already {
            return Err(OperatorError::EnrolmentRefused);
        }
        let recomputed = self
            .shell_seal(
                &tx,
                &shell,
                &display_name,
                &created_by,
                None,
                0,
                created_seq,
                row_version,
            )
            .await?;
        if stored_seal != recomputed {
            return Err(OperatorError::Unverifiable("organisation shell row seal"));
        }

        let genesis_result = grants::bootstrap_organisation(
            &tx,
            &self.ring,
            creator,
            &display_name,
            root_pubkey,
            id_salt,
            genesis,
        )
        .await?;
        let organisation = genesis_result.organisation.to_string();

        // Back to enrolment custody: `bootstrap_organisation` leaves the
        // transaction pointed at the new tenant, and the two statements below
        // are site-scoped.
        enter_enrolment_custody(&tx).await?;
        let redeemed = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::EnrolmentTokenRedeemed,
            &entry_metadata(
                EntryType::EnrolmentTokenRedeemed,
                &[
                    ("token", Json::Str(row.id.clone())),
                    (
                        "purpose",
                        Json::Str(Purpose::Organisation.as_str().to_string()),
                    ),
                    ("shell", Json::Str(shell.clone())),
                    ("organisation", Json::Str(organisation.clone())),
                    ("redeemed_by", Json::Str(creator.to_string())),
                ],
            ),
        )
        .await?;
        self.mark_redeemed(&tx, &row, redeemed.seq).await?;

        let now = now_unix();
        let seal = self
            .shell_seal(
                &tx,
                &shell,
                &display_name,
                &created_by,
                Some(&organisation),
                now,
                created_seq,
                row_version + 1,
            )
            .await?;
        tx.execute(
            "UPDATE organisation_shells \
                SET organisation_id = $2, redeemed_at = to_timestamp($3::bigint), \
                    redeemed_seq = $4, row_version = $5, row_seal = $6 \
              WHERE id = $1 AND organisation_id IS NULL",
            &[
                &shell,
                &organisation,
                &now,
                &redeemed.seq,
                &(row_version + 1),
                &seal.to_vec(),
            ],
        )
        .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(genesis_result.organisation)
    }

    // -----------------------------------------------------------------------
    // §1.1 — suspend, disable
    // -----------------------------------------------------------------------

    /// §1.1's *"suspend a scope grant (immediate)"*, from an operator session.
    ///
    /// The act itself is `grants::suspend_grant_by_operator`; this adds the
    /// operator session in front of it and the site-chain record beside the
    /// organisation's own. **There is no unsuspend here**: §1.1 gives lifting
    /// to the organisation's stewards, and `0011`'s `CHECK` refuses an
    /// `unsuspend` row for an operator principal whatever this code does.
    pub async fn suspend_grant(
        &self,
        operator: &VerifiedSession,
        organisation: &str,
        grant_id: &str,
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;

        // **The register first, and in this transaction.** A disabled operator
        // does not suspend a grant, and the check has to share a snapshot with
        // the act or it is a check against a different moment.
        enter_operator_custody(&tx).await?;
        self.check_operator_live(&tx, &acting).await?;

        let now = now_unix();
        let organisation = grants::suspend_grant_by_operator(
            &tx,
            &self.ring,
            &acting,
            organisation,
            grant_id,
            now,
        )
        .await?;

        // **`grant_suspended` is filed on BOTH chains, and `rewrap` is the
        // precedent** (§7.2: *"on both lists"*). The organisation's own chain
        // records the act for the stewards who may lift it; the site chain
        // records that the machine side did it, because every verb §1.1 gives
        // an operator has to be legible in one place to somebody auditing the
        // operator plane. Neither entry is a copy of the other: this one names
        // the operator and the session, that one names the grant's own scope
        // and epoch.
        enter_operator_custody(&tx).await?;
        chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::GrantSuspended,
            &entry_metadata(
                EntryType::GrantSuspended,
                &[
                    ("operator", Json::Str(acting.clone())),
                    ("grant", Json::Str(grant_id.to_string())),
                    ("organisation", Json::Str(organisation)),
                    ("session", Json::Str(operator.id().to_string())),
                    ("actor_kind", Json::Str("operator".to_string())),
                ],
            ),
        )
        .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// §1.1's *"disable / re-enable an account"*.
    ///
    /// A disabled account's live sessions stop at their next request, because
    /// `sessions::verify_pending` re-reads the row inside the same transaction
    /// that authorises. §1.1 also requires that every steward of every scope
    /// the account holds is notified, and **that notice is not built** — there
    /// is no mail path in this build at all. Reported rather than implied.
    pub async fn set_account_disabled(
        &self,
        operator: &VerifiedSession,
        account: &str,
        disabled: bool,
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;
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
            &entry_metadata(
                entry_type,
                &[
                    ("account", Json::Str(account.to_string())),
                    ("operator", Json::Str(acting)),
                    ("session", Json::Str(operator.id().to_string())),
                ],
            ),
        )
        .await?;

        let changed = tx
            .execute(
                "UPDATE accounts SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END \
                  WHERE id = $1",
                &[&account, &disabled],
            )
            .await?;
        if changed == 0 {
            return Err(OperatorError::NotFound("account"));
        }

        tx.execute("SELECT set_config('app.account_custody', 'no', true)", &[])
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Disable an operator. §7.2's `operator_disabled`.
    ///
    /// **There is no re-enable**, and the absence is deliberate: §4.5 says an
    /// operator who loses their authenticators is re-enrolled by two other
    /// operators through §5.4's machinery, and §7.2 names no `operator_enabled`
    /// type to record the opposite act. A one-way verb with two-operator
    /// re-entry is the shape the design asks for; a re-enable button would make
    /// disabling reversible by the person who did it.
    ///
    /// An operator cannot disable themselves — not as a courtesy, but because a
    /// deployment whose last operator disabled themselves has no way back in
    /// that is not the key volume.
    pub async fn disable_operator(
        &self,
        operator: &VerifiedSession,
        target: &str,
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;
        if acting == target {
            return Err(OperatorError::Malformed("operator to disable"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        let Some(row) = read_operator(&tx, target).await? else {
            return Err(OperatorError::NotFound("operator"));
        };

        // **`0019` §C's floor, refused here as well as in the trigger.**
        // Two checks and not one, for `check_operator_live`'s reason: the
        // trigger is the fence that binds whoever holds a connection, and
        // this is the same refusal before the statement is issued, so the
        // caller gets a sentence rather than a constraint's message. Both read
        // inside the transaction the act runs in.
        //
        // Live, not live-and-independent: the floor is about the deployment
        // having ANY operator, which is the one case that is not a policy
        // choice. ADR-0055 decision 4 keeps a sole operator a supported shape
        // and warns rather than blocks.
        if row.disabled_at_unix == 0 {
            let live: i64 = tx
                .query_one(
                    "SELECT count(*) FROM operators WHERE disabled_at IS NULL",
                    &[],
                )
                .await?
                .get(0);
            if live <= 1 {
                return Err(OperatorError::LastLiveOperator);
            }
        }

        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorDisabled,
            &entry_metadata(
                EntryType::OperatorDisabled,
                &[
                    ("operator", Json::Str(target.to_string())),
                    ("by", Json::Str(acting)),
                    ("session", Json::Str(operator.id().to_string())),
                ],
            ),
        )
        .await?;

        let now = now_unix();
        let version = row.row_version + 1;
        let seal = self
            .operator_seal(
                &tx,
                &row.id,
                &row.display_name,
                row.created_by.as_deref(),
                now,
                row.first_independent_signin_at_unix,
                row.created_seq.unwrap_or(appended.seq),
                version,
            )
            .await?;
        // The trigger is the one that is not a race. Its message is mapped
        // rather than surfaced: `0019` §C raises a plain exception, which
        // arrives as `SQLSTATE P0001`, and a caller must not have to read a
        // database sentence to learn it hit a rule this module already names.
        if let Err(e) = tx
            .execute(
                "UPDATE operators \
                    SET disabled_at = to_timestamp($2::bigint), row_version = $3, row_seal = $4 \
                  WHERE id = $1",
                &[&target, &now, &version, &seal.to_vec()],
            )
            .await
        {
            if is_operator_floor(&e) {
                return Err(OperatorError::LastLiveOperator);
            }
            return Err(e.into());
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // §1.1 — the read surface, and its sampled entry
    // -----------------------------------------------------------------------

    /// §1.1's `operator_read`, *"sampled: one entry per session per surface"*.
    ///
    /// The latch is taken first and the entry is appended only if this call
    /// took it, so a console that polls a page every five seconds writes one
    /// entry and not seventeen thousand. Both are in one transaction: a handler
    /// that fails leaves neither.
    pub async fn record_read(
        &self,
        operator: &VerifiedSession,
        surface: &str,
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        let took = tx
            .query_opt(
                "INSERT INTO operator_read_samples (session_id, surface) VALUES ($1, $2) \
                 ON CONFLICT (session_id, surface) DO NOTHING RETURNING 1",
                &[&operator.id(), &surface],
            )
            .await?;
        if took.is_some() {
            chains::append_site(
                &tx,
                &self.ring,
                &self.deployment,
                EntryType::OperatorRead,
                &entry_metadata(
                    EntryType::OperatorRead,
                    &[
                        ("operator", Json::Str(acting)),
                        ("session", Json::Str(operator.id().to_string())),
                        ("surface", Json::Str(surface.to_string())),
                    ],
                ),
            )
            .await?;
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// The operator register, as §5.5's page renders it.
    ///
    /// Runs on the **read-only** operator pool where one is configured (§1.3).
    pub async fn list_operators(&self) -> Result<Vec<Operator>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // ADR-0055 decision 1: the register shows the address, which lives
        // on the bound account. `accounts_readable` (`0013` §A) admits the
        // account custody, so this read takes it beside the operator one --
        // the same pair `set_account_disabled` takes, and dropped again
        // before the transaction ends.
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;
        let rows = tx
            .query(
                "SELECT o.id, o.display_name, o.created_by, o.created_seq, \
                        COALESCE(EXTRACT(EPOCH FROM o.first_independent_signin_at)::bigint, 0), \
                        COALESCE(EXTRACT(EPOCH FROM o.disabled_at)::bigint, 0), o.row_version, \
                        a.email \
                   FROM operators o \
                   LEFT JOIN operator_account_bindings b ON b.operator_id = o.id \
                   LEFT JOIN accounts a ON a.id = b.account_id \
                  ORDER BY o.created_at",
                &[],
            )
            .await?;
        tx.execute("SELECT set_config('app.account_custody', 'no', true)", &[])
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(rows
            .iter()
            .map(|row| Operator {
                id: row.get(0),
                display_name: row.get(1),
                created_by: row.get(2),
                created_seq: row.get(3),
                first_independent_signin_at_unix: row.get(4),
                disabled_at_unix: row.get(5),
                row_version: row.get(6),
                address: row.get(7),
            })
            .collect())
    }

    /// Every organisation the estate holds, by id and display name. §1.2 keeps
    /// organisation display names readable because support and billing need to
    /// know which customer they are looking at; everything below them is opaque
    /// ids and shape.
    pub async fn list_organisations(&self) -> Result<Vec<(String, String)>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        // **This read is on the application pool and not on `fathom_operator`,
        // and the reason is that the operator role has no login in this build.**
        // §1.3 wants the console's reads on a read-only pool, `0005` creates
        // `fathom_operator` `NOLOGIN`, and `tests/planes.rs` asserts it cannot
        // be connected to at all. Provisioning that login is a deployment
        // change (a second credential in the key volume, §1.4's shape) and is
        // reported to the lead rather than invented here. What holds either
        // way: `organisations.display_name` is §1.2's one readable name, and
        // `app.design_capability` is at its refusal for this whole
        // transaction, so the sightlessness §1.3 is actually about does not
        // depend on which role ran the query.
        enter_operator_custody(&tx).await?;
        let rows = tx
            .query(
                "SELECT id, display_name FROM organisations ORDER BY created_at",
                &[],
            )
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(rows.iter().map(|row| (row.get(0), row.get(1))).collect())
    }

    // -----------------------------------------------------------------------
    // §5.3, §5.4, §5.5 — settings and the interlock
    // -----------------------------------------------------------------------

    /// Request a change to a site setting (§5.3). One operator, one assertion.
    ///
    /// **The first version of a setting applies immediately** — §5.3's
    /// first-version rule, stated there so nobody invents a skip flag later:
    /// *"a setting with no prior applied version applies immediately, with no
    /// delay and no second operator. On a fresh install there is no old value
    /// to protect and no mail path to capture."* The condition is checkable and
    /// is checked here with §5.3's own SQL, not with a mode.
    ///
    /// Every later version takes the delay, and — outside single-operator mode
    /// — a second operator.
    pub async fn request_setting(
        &self,
        operator: &VerifiedSession,
        key: &str,
        value: &[u8],
        signature: &[u8],
    ) -> Result<PendingChange, OperatorError> {
        let acting = self.acting_operator(operator)?;
        if key.trim().is_empty() || key.len() > 64 {
            return Err(OperatorError::Malformed("setting key"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        // The assertion first: a change nobody signed never becomes a row.
        let message = setting_request_bytes(&self.deployment, &acting, key, value);
        self.verify_operator_assertion(&tx, &acting, &message, signature)
            .await?;

        let id = ids::new_ulid().to_string();
        let (ciphertext, nonce) = self.seal_setting(&tx, &id, key, value).await?;
        let value_digest: [u8; 32] = Sha256::digest(&ciphertext).into();

        let first_version = tx
            .query_opt(
                "SELECT 1 FROM site_settings_versions \
                  WHERE key = $1 AND applied_at IS NOT NULL AND cancelled_at IS NULL",
                &[&key],
            )
            .await?
            .is_none();

        // Whole seconds, both terms: the delay is kept to within a second of
        // what was configured, never more. A test that needs a delay it can
        // rely on asks for at least two seconds, because one is anything from
        // zero to one.
        let now = now_unix();
        let effective_at = if first_version {
            now
        } else {
            now + self.settings_delay.as_secs() as i64
        };

        // ADR-0055 decision 3: the stamp is the quorum in force AT REQUEST
        // TIME, read off the register in this transaction. It is a record, not
        // a gate -- `apply_if_due` re-reads the live quorum, and `0022` §A
        // takes away the `CHECK` that used to make this stamp a bar to
        // seconding the row later.
        //
        // **Per requester** (fix (c)): the question is not how many operators
        // exist but how many could second THIS one, which is the fourth
        // clause `0015` §G applies and `live_independent_operators` omits.
        let single_operator = quorum_for(&tx, &self.ring, &acting).await? < 2;

        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::SettingRequested,
            &entry_metadata(
                EntryType::SettingRequested,
                &[
                    ("change", Json::Str(id.clone())),
                    ("key", Json::Str(key.to_string())),
                    ("value_digest", Json::Str(hex(&value_digest))),
                    ("requested_by", Json::Str(acting.clone())),
                    ("effective_at", Json::Int(effective_at)),
                    ("first_version", Json::Bool(first_version)),
                    ("single_operator", Json::Bool(single_operator)),
                ],
            ),
        )
        .await?;

        let facts = SettingFacts {
            id: &id,
            key,
            value_digest: &value_digest,
            requested_by: &acting,
            request_sig: signature,
            seconded_by: None,
            second_sig: None,
            single_operator,
            effective_at_unix: effective_at,
            cancelled_at_unix: 0,
            applied_at_unix: 0,
            sealed_seq: None,
        };
        let seal = self.setting_seal(&tx, &facts, appended.seq, 1).await?;

        tx.execute(
            "INSERT INTO site_settings_versions \
                 (id, key, value_ct, value_nonce, value_key_epoch, value_digest, requested_by, \
                  request_sig, requested_seq, single_operator, effective_at, row_version, row_seal) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11::bigint), 1, $12)",
            &[
                &id,
                &key,
                &ciphertext,
                &nonce.to_vec(),
                &CHAIN_KEY_EPOCH,
                &value_digest.to_vec(),
                &acting,
                &signature.to_vec(),
                &appended.seq,
                &single_operator,
                &effective_at,
                &seal.to_vec(),
            ],
        )
        .await?;

        // The first version of a setting is applied in the same transaction,
        // because there is nothing for a delay to protect (§5.3) — and it is
        // applied through the SAME function every later version goes through,
        // so the interlock is not skipped, only the waiting is.
        let applied = self.apply_if_due(&tx, &id).await?;

        let pending = self.read_setting(&tx, &id).await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        let _ = applied;
        Ok(pending)
    }

    /// Second a pending setting change (§5.5). A **different** operator, a
    /// fresh assertion over the row that exists.
    ///
    /// The three conditions §5.5 states about the seconder — not created by the
    /// requester, an independent sign-in on record, and that sign-in older than
    /// the longest delay window — are enforced by the `SECURITY DEFINER`
    /// trigger `0015` §G installs, so they bind for a statement this code never
    /// issued as well as for one it did. The fourth, the signature, is here.
    pub async fn second_setting(
        &self,
        operator: &VerifiedSession,
        change_id: &str,
        signature: &[u8],
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        let row = self.read_setting_row(&tx, change_id).await?;
        if row.facts.requested_by == acting {
            return Err(OperatorError::SecondedByTheRequester);
        }
        if row.facts.seconded_by.is_some()
            || row.facts.cancelled_at_unix != 0
            || row.facts.applied_at_unix != 0
        {
            return Err(OperatorError::NotYetEffective);
        }

        let message = setting_second_bytes(
            &self.deployment,
            &acting,
            change_id,
            &row.facts.key,
            &row.facts.value_digest,
        );
        self.verify_operator_assertion(&tx, &acting, &message, signature)
            .await?;

        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::SettingSeconded,
            &entry_metadata(
                EntryType::SettingSeconded,
                &[
                    ("change", Json::Str(change_id.to_string())),
                    ("key", Json::Str(row.facts.key.clone())),
                    ("seconded_by", Json::Str(acting.clone())),
                ],
            ),
        )
        .await?;

        let mut facts = row.facts.clone();
        facts.seconded_by = Some(acting.clone());
        facts.second_sig = Some(signature.to_vec());
        let version = row.row_version + 1;
        let seal = self
            .setting_seal(&tx, &facts.as_ref(), row.chain_seq, version)
            .await?;

        // ADR-0055 fix (c): the same trigger guards this table (`0015` §G
        // installs `site_settings_versions_seconder` beside
        // `operator_requests_seconder`), so the same typed refusal.
        if let Err(e) = tx
            .execute(
                "UPDATE site_settings_versions \
                SET seconded_by = $2, second_sig = $3, seconded_seq = $4, row_version = $5, \
                    row_seal = $6 \
              WHERE id = $1 AND seconded_by IS NULL",
                &[
                    &change_id,
                    &acting,
                    &signature.to_vec(),
                    &appended.seq,
                    &version,
                    &seal.to_vec(),
                ],
            )
            .await
        {
            if is_seconder_refusal(&e) {
                return Err(OperatorError::SeconderNotIndependent);
            }
            return Err(e.into());
        }

        self.apply_if_due(&tx, change_id).await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Cancel a pending change during its delay (§5.3).
    pub async fn cancel_setting(
        &self,
        operator: &VerifiedSession,
        change_id: &str,
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        let row = self.read_setting_row(&tx, change_id).await?;
        if row.facts.applied_at_unix != 0 || row.facts.cancelled_at_unix != 0 {
            return Err(OperatorError::NotYetEffective);
        }

        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::SettingCancelled,
            &entry_metadata(
                EntryType::SettingCancelled,
                &[
                    ("change", Json::Str(change_id.to_string())),
                    ("key", Json::Str(row.facts.key.clone())),
                    ("cancelled_by", Json::Str(acting)),
                ],
            ),
        )
        .await?;

        let now = now_unix();
        let mut facts = row.facts.clone();
        facts.cancelled_at_unix = now;
        let version = row.row_version + 1;
        let seal = self
            .setting_seal(&tx, &facts.as_ref(), row.chain_seq, version)
            .await?;

        tx.execute(
            "UPDATE site_settings_versions \
                SET cancelled_at = to_timestamp($2::bigint), cancelled_seq = $3, \
                    row_version = $4, row_seal = $5 \
              WHERE id = $1 AND cancelled_at IS NULL AND applied_at IS NULL",
            &[&change_id, &now, &appended.seq, &version, &seal.to_vec()],
        )
        .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// **§5.4's resolver: what is the effective value of this setting?**
    ///
    /// Not "the newest row". §5.4, step by step:
    ///
    /// 1. candidates are rows with `applied_at IS NOT NULL`, `cancelled_at IS
    ///    NULL` and `sealed_seq IS NOT NULL`;
    /// 2. for each, load site-chain entry `sealed_seq`, **verify its seal**,
    ///    and check its sealed metadata names this row's `(id, key,
    ///    value_digest, effective_at)`;
    /// 3. check the links: `prev_seal` matches entry `sealed_seq - 1`, whose
    ///    seal also verifies — `chains::read_site_entry_verified` does 2 and 3
    ///    together;
    /// 4. **NOT IMPLEMENTED**: check `effective_receipt_id` names a witness
    ///    receipt at or after `effective_at`. There is no `chain_receipts`
    ///    table in this schema and `0009` says receipts are deliberately
    ///    deferred, so the delay here is measured against this server's own
    ///    clock and not against the party it protects. `0015` §F reports it;
    ///    nothing in this file may be read as claiming otherwise;
    /// 5. the newest survivor. **A candidate that fails any check is not
    ///    silently skipped**: it raises `setting_unresolvable` and this returns
    ///    [`OperatorError::SettingUnresolvable`] so the deployment can banner
    ///    it.
    ///
    /// This is what turns the audit trail from evidence into a gate: a row
    /// inserted directly into PostgreSQL has no sealed entry naming its digest,
    /// so step 2 rejects it, and **stopping the log to act unobserved also
    /// stops the act**.
    ///
    /// It also applies anything whose delay has elapsed, because this
    /// deployment has no scheduler — `0014` §C's argument for sweeping on the
    /// write path, applied to the one read that cares.
    pub async fn effective_setting(&self, key: &str) -> Result<Option<Vec<u8>>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;

        self.apply_due(&tx, key).await?;

        let rows = tx
            .query(
                "SELECT id FROM site_settings_versions \
                  WHERE key = $1 AND applied_at IS NOT NULL AND cancelled_at IS NULL \
                    AND sealed_seq IS NOT NULL \
                  ORDER BY applied_at DESC, id DESC",
                &[&key],
            )
            .await?;

        // **The newest candidate decides, and a failure is an incident rather
        // than a reason to fall back to an older one.** §5.4 step 5: *"a
        // candidate that fails any check is NOT silently skipped."* Trying the
        // previous version instead would hand an attacker who can corrupt one
        // row the power to put the setting back to whatever it was before —
        // silently, and with the audit trail showing a change that did apply.
        // So there is one candidate considered here, and one answer: the value,
        // or an incident.
        let mut answer = None;
        let mut unresolvable = false;
        if let Some(row) = rows.first() {
            let id: String = row.get(0);
            match self.resolve_candidate(&tx, &id).await {
                Ok(value) => answer = Some(value),
                Err(OperatorError::Unverifiable(what)) => {
                    self.raise_unresolvable(&tx, &id, what).await?;
                    unresolvable = true;
                }
                Err(e) => return Err(e),
            }
        }

        leave_custody(&tx).await?;
        tx.commit().await?;

        if unresolvable {
            return Err(OperatorError::SettingUnresolvable);
        }
        Ok(answer)
    }

    /// One candidate row, checked against its own sealed entry.
    async fn resolve_candidate(
        &self,
        tx: &Transaction<'_>,
        id: &str,
    ) -> Result<Vec<u8>, OperatorError> {
        let row = self.read_setting_row(tx, id).await?;
        let Some(sealed_seq) = row.facts.sealed_seq else {
            return Err(OperatorError::Unverifiable("settings row seal"));
        };

        // The row's own seal first: a row edited in place fails here before any
        // chain read happens.
        let recomputed = self
            .setting_seal(tx, &row.facts.as_ref(), row.chain_seq, row.row_version)
            .await?;
        if row.stored_seal != recomputed {
            return Err(OperatorError::Unverifiable("settings row seal"));
        }

        // Steps 2 and 3.
        let entry = chains::read_site_entry_verified(tx, &self.ring, sealed_seq)
            .await
            .map_err(|_| OperatorError::Unverifiable("settings sealed entry"))?;
        let Some(entry) = entry else {
            return Err(OperatorError::Unverifiable("settings sealed entry"));
        };
        if entry.entry_type != EntryType::SettingApplied {
            return Err(OperatorError::Unverifiable("settings sealed entry"));
        }

        // The entry's sealed metadata must name this row's (id, key,
        // value_digest, effective_at). Reconstructed and compared as canonical
        // bytes, so a metadata object with an extra field or a different
        // spelling does not pass.
        let expected = entry_metadata(
            EntryType::SettingApplied,
            &[
                ("change", Json::Str(row.facts.id.clone())),
                ("key", Json::Str(row.facts.key.clone())),
                ("value_digest", Json::Str(hex(&row.facts.value_digest))),
                ("effective_at", Json::Int(row.facts.effective_at_unix)),
                ("requested_by", Json::Str(row.facts.requested_by.clone())),
                (
                    "seconded_by",
                    match &row.facts.seconded_by {
                        Some(id) => Json::Str(id.clone()),
                        None => Json::Null,
                    },
                ),
                ("single_operator", Json::Bool(row.facts.single_operator)),
            ],
        );
        if entry.metadata != expected {
            return Err(OperatorError::Unverifiable("settings sealed entry"));
        }

        // And the ciphertext must be the one the digest names.
        let digest: [u8; 32] = Sha256::digest(&row.value_ct).into();
        if digest != row.facts.value_digest {
            return Err(OperatorError::Unverifiable("settings value digest"));
        }

        let key = self.settings_key(tx).await?;
        let nonce: [u8; crypto::NONCE_LEN] = row
            .value_nonce
            .as_slice()
            .try_into()
            .map_err(|_| OperatorError::Corrupt("settings value nonce"))?;
        let aad = self.settings_aad(&row.facts.id, &row.facts.key, row.value_key_epoch);
        Ok(crypto::open(&key, &nonce, &row.value_ct, &aad)?)
    }

    /// §5.4 step 5's incident, latched so it is raised once per row rather than
    /// once per read (`0014` §B's argument).
    async fn raise_unresolvable(
        &self,
        tx: &Transaction<'_>,
        id: &str,
        what: &'static str,
    ) -> Result<(), OperatorError> {
        // **The row is locked, then the entry is appended, then both marker
        // columns are written together.** Two statements would break the
        // `CHECK` that keeps them in step, and appending before the lock would
        // let two readers raise the same incident twice — which is `0014` §B's
        // amplifier with a different name.
        let took = tx
            .query_opt(
                "SELECT 1 FROM site_settings_versions \
                  WHERE id = $1 AND unresolvable_at IS NULL FOR UPDATE",
                &[&id],
            )
            .await?;
        if took.is_none() {
            return Ok(());
        }
        let appended = chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            EntryType::SettingUnresolvable,
            &entry_metadata(
                EntryType::SettingUnresolvable,
                &[
                    ("change", Json::Str(id.to_string())),
                    ("failed", Json::Str(what.to_string())),
                ],
            ),
        )
        .await?;
        tx.execute(
            "UPDATE site_settings_versions \
                SET unresolvable_at = now(), unresolvable_seq = $2 \
              WHERE id = $1 AND unresolvable_at IS NULL",
            &[&id, &appended.seq],
        )
        .await?;
        Ok(())
    }

    /// Apply every pending change for one key whose delay has elapsed.
    async fn apply_due(&self, tx: &Transaction<'_>, key: &str) -> Result<(), OperatorError> {
        let rows = tx
            .query(
                "SELECT id FROM site_settings_versions \
                  WHERE key = $1 AND applied_at IS NULL AND cancelled_at IS NULL \
                    AND effective_at <= now() \
                  ORDER BY effective_at",
                &[&key],
            )
            .await?;
        for row in &rows {
            let id: String = row.get(0);
            self.apply_if_due(tx, &id).await?;
        }
        Ok(())
    }

    /// **Apply one change, and stamp `sealed_seq` in the same transaction that
    /// appends the entry** (§5.4).
    ///
    /// Returns `false` when the change is not due, unseconded or cancelled.
    /// Nothing reachable from the operator surface stamps `sealed_seq` any
    /// other way: this function is the only writer of that column, and it
    /// cannot write it without `chains::append_site` having succeeded under a
    /// chain key that is not in PostgreSQL.
    async fn apply_if_due(&self, tx: &Transaction<'_>, id: &str) -> Result<bool, OperatorError> {
        let row = self.read_setting_row(tx, id).await?;
        if row.facts.applied_at_unix != 0 || row.facts.cancelled_at_unix != 0 {
            return Ok(false);
        }
        if row.facts.effective_at_unix > now_unix() {
            return Ok(false);
        }
        // Two operators, or the documented single-operator mode — **or §5.3's
        // first version, which needs neither**: *"a setting with no prior
        // applied version applies immediately, with no delay and no second
        // operator. On a fresh install there is no old value to protect and no
        // mail path to capture."*
        //
        // The condition is re-evaluated HERE rather than remembered from the
        // request, and the difference matters: between requesting and applying,
        // some other change may have become this key's first applied version,
        // and a remembered flag would then let a second change through with one
        // signature. §5.3 states the condition as SQL over the applied rows,
        // and this is that SQL, excluding the row being considered.
        let first_version = tx
            .query_opt(
                "SELECT 1 FROM site_settings_versions \
                  WHERE key = $1 AND id <> $2 AND applied_at IS NOT NULL \
                    AND cancelled_at IS NULL",
                &[&row.facts.key, &row.facts.id],
            )
            .await?
            .is_none();
        // **The LIVE quorum, not `row.facts.single_operator`.** The
        // row's own field is what this deployment was configured as at
        // REQUEST time, stamped onto the row and sealed there -- a fixed
        // record, on purpose, of what was true then. Gating on it here would
        // be exactly the mistake the comment above just finished ruling out
        // for `first_version`, for the identical reason: an operator turns
        // `FATHOM_SINGLE_OPERATOR` off (a restart, between a request and its
        // delayed apply) meaning to require a second signature from that
        // point on, and a change requested a minute before the restart would
        // still apply alone on the strength of a flag that is no longer this
        // deployment's policy. The live value is asked fresh, here, same as
        // `first_version` above it.
        //
        // ADR-0055 decision 3 makes "the live value" a count over the
        // register rather than a process's environment, and the lead's
        // resolution 10 adds the other half: a row stamped `single_operator =
        // true` at request time may still be seconded later, because `0022`
        // §A took away the `CHECK` that forbade it. So this re-read is now the
        // only thing that decides, in both directions.
        //
        // **Per requester** (fix (c)): `quorum_for` counts the operators who
        // could second the operator who asked for THIS change. A quorum of 2
        // that no living operator could satisfy left the change pending for
        // ever.
        let single_operator = quorum_for(tx, &self.ring, &row.facts.requested_by).await? < 2;
        if !first_version && row.facts.seconded_by.is_none() && !single_operator {
            return Ok(false);
        }

        let appended = chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            EntryType::SettingApplied,
            &entry_metadata(
                EntryType::SettingApplied,
                &[
                    ("change", Json::Str(row.facts.id.clone())),
                    ("key", Json::Str(row.facts.key.clone())),
                    ("value_digest", Json::Str(hex(&row.facts.value_digest))),
                    ("effective_at", Json::Int(row.facts.effective_at_unix)),
                    ("requested_by", Json::Str(row.facts.requested_by.clone())),
                    (
                        "seconded_by",
                        match &row.facts.seconded_by {
                            Some(id) => Json::Str(id.clone()),
                            None => Json::Null,
                        },
                    ),
                    // **The row's own stamped field, and it has to be.**
                    // `resolve_candidate` reconstructs this entire object from
                    // the row and compares it byte for byte, so every field in
                    // it must be reconstructible from the row -- and the live
                    // quorum is not: it is a count that moves.
                    //
                    // Nothing is lost by that. What an auditor wants to know
                    // is whether this change took one signature or two, and
                    // `seconded_by` in this same entry says so: applied with
                    // `seconded_by` null is applied at quorum 1, and the
                    // condition above is what enforced it. Until 2026-09-21
                    // this wrote the live value and `resolve_candidate`
                    // compared the stamp, which agreed only because
                    // `FATHOM_SINGLE_OPERATOR` could not change while a
                    // process ran; ADR-0055 decision 3 makes the two differ,
                    // and the symptom was every seconded change reading as
                    // `SettingUnresolvable` -- an integrity alarm raised by
                    // using the product correctly, which is the worst kind.
                    ("single_operator", Json::Bool(row.facts.single_operator)),
                ],
            ),
        )
        .await?;

        let now = now_unix();
        let mut facts = row.facts.clone();
        facts.applied_at_unix = now;
        facts.sealed_seq = Some(appended.seq);
        let version = row.row_version + 1;
        let seal = self
            .setting_seal(tx, &facts.as_ref(), row.chain_seq, version)
            .await?;

        tx.execute(
            "UPDATE site_settings_versions \
                SET applied_at = to_timestamp($2::bigint), sealed_seq = $3, row_version = $4, \
                    row_seal = $5 \
              WHERE id = $1 AND applied_at IS NULL AND cancelled_at IS NULL",
            &[&id, &now, &appended.seq, &version, &seal.to_vec()],
        )
        .await?;
        Ok(true)
    }

    // -----------------------------------------------------------------------
    // §5.5 — operator creation through the same machinery
    // -----------------------------------------------------------------------

    /// §5.5: *"operator creation is itself routed through this machinery: two
    /// existing operator assertions, the delay, notice to every organisation's
    /// stewards, sealed."*
    ///
    /// **The notice is not built** — there is no mail path in this build — and
    /// that is reported rather than implied. What is built is the two
    /// assertions, the delay, the seconder rules and the sealed entries.
    ///
    /// **ADR-0055 decision 5 and the lead's resolution 5: the colleague's
    /// address is taken here, at request time.** *"Add the successor, they
    /// sign in on their own"* — and they cannot sign in on their own without
    /// an address to be invited at and an account shell behind it. Collecting
    /// it at their own first sign-in, the alternative the contracts document
    /// left open as issue 5, would mean an invitation with nowhere to go. The
    /// address goes inside the assertion (`operator_request_bytes`) and inside
    /// the row seal (`0022` §B), so it is neither the requesting operator's
    /// word alone nor the database holder's to rewrite.
    ///
    /// Quorum is ADR-0055 decision 3's `min(2, live independent operators)`:
    /// with one operator this applies alone after the delay, and nothing here
    /// shortens the delay.
    pub async fn request_operator(
        &self,
        operator: &VerifiedSession,
        display_name: &str,
        address: &str,
        signature: &[u8],
    ) -> Result<PendingChange, OperatorError> {
        let acting = self.acting_operator(operator)?;
        if display_name.trim().is_empty() || display_name.len() > 200 {
            return Err(OperatorError::Malformed("display name"));
        }
        // The same floor `create_account_shell` puts under an address, and the
        // same ceiling `0022` §B's CHECK does: an address this server cannot
        // store is refused here with a sentence rather than by a constraint.
        if address.trim().len() < 3 || address.len() > 320 {
            return Err(OperatorError::Malformed("address"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        let message = operator_request_bytes(&self.deployment, &acting, display_name, address);
        self.verify_operator_assertion(&tx, &acting, &message, signature)
            .await?;

        // Per requester (fix (c)) -- see `request_setting`'s own note.
        let single_operator = quorum_for(&tx, &self.ring, &acting).await? < 2;
        let id = ids::new_ulid().to_string();
        // **No first-version exemption here.** §5.3's immediate-first-version
        // rule is about a setting with no prior value to protect; an operator
        // register always has a prior value, because a deployment with no
        // operator cannot reach this function at all.
        let effective_at = now_unix() + self.settings_delay.as_secs() as i64;

        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorCreated,
            &entry_metadata(
                EntryType::OperatorCreated,
                &[
                    ("request", Json::Str(id.clone())),
                    ("display_name", Json::Str(display_name.to_string())),
                    // Inside the SEALED metadata, which is AEAD ciphertext
                    // under a key that is not in PostgreSQL (§7.3), for the
                    // reason `create_account_shell` records an address the
                    // same way: the trail says who was invited without putting
                    // a list of addresses in the clear.
                    ("address", Json::Str(address.to_string())),
                    ("requested_by", Json::Str(acting.clone())),
                    ("effective_at", Json::Int(effective_at)),
                    ("single_operator", Json::Bool(single_operator)),
                    ("state", Json::Str("requested".to_string())),
                ],
            ),
        )
        .await?;

        let facts = OperatorRequestFacts {
            id: &id,
            display_name,
            address,
            requested_by: &acting,
            request_sig: signature,
            seconded_by: None,
            second_sig: None,
            single_operator,
            effective_at_unix: effective_at,
            cancelled_at_unix: 0,
            applied_at_unix: 0,
            sealed_seq: None,
            created_operator_id: None,
        };
        let seal = self.request_seal(&tx, &facts, appended.seq, 1).await?;

        tx.execute(
            "INSERT INTO operator_requests \
                 (id, display_name, address, requested_by, request_sig, requested_seq, \
                  single_operator, effective_at, row_version, row_seal) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::bigint), 1, $9)",
            &[
                &id,
                &display_name,
                &address,
                &acting,
                &signature.to_vec(),
                &appended.seq,
                &single_operator,
                &effective_at,
                &seal.to_vec(),
            ],
        )
        .await?;

        let pending = self.read_operator_request(&tx, &id).await?.pending();
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(pending)
    }

    /// Second a pending operator creation (§5.5).
    pub async fn second_operator(
        &self,
        operator: &VerifiedSession,
        request_id: &str,
        signature: &[u8],
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        let row = self.read_operator_request(&tx, request_id).await?;
        if row.requested_by == acting {
            return Err(OperatorError::SecondedByTheRequester);
        }
        if row.seconded_by.is_some() || row.cancelled_at_unix != 0 || row.applied_at_unix != 0 {
            return Err(OperatorError::NotYetEffective);
        }

        let message =
            operator_second_bytes(&self.deployment, &acting, request_id, &row.display_name);
        self.verify_operator_assertion(&tx, &acting, &message, signature)
            .await?;

        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorSeconded,
            &entry_metadata(
                EntryType::OperatorSeconded,
                &[
                    ("request", Json::Str(request_id.to_string())),
                    ("display_name", Json::Str(row.display_name.clone())),
                    ("seconded_by", Json::Str(acting.clone())),
                ],
            ),
        )
        .await?;

        let mut next = row.clone();
        next.seconded_by = Some(acting.clone());
        next.second_sig = Some(signature.to_vec());
        let version = row.row_version + 1;
        let seal = self
            .request_seal(&tx, &next.as_ref(), row.chain_seq, version)
            .await?;

        // ADR-0055 fix (c): `0015` §G's trigger is the fence, and its `P0001`
        // is a RULE. Until 2026-09-21 it fell through `admin.rs`'s `other` arm
        // and reached the operator as a 500 integrity alarm; the same shape
        // `disable_operator` already uses for `0019` §C's floor.
        if let Err(e) = tx
            .execute(
                "UPDATE operator_requests \
                SET seconded_by = $2, second_sig = $3, seconded_seq = $4, row_version = $5, \
                    row_seal = $6 \
              WHERE id = $1 AND seconded_by IS NULL",
                &[
                    &request_id,
                    &acting,
                    &signature.to_vec(),
                    &appended.seq,
                    &version,
                    &seal.to_vec(),
                ],
            )
            .await
        {
            if is_seconder_refusal(&e) {
                return Err(OperatorError::SeconderNotIndependent);
            }
            return Err(e.into());
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Apply every operator request whose delay has elapsed, and return an
    /// invitation for each operator created.
    ///
    /// On the write path and on the console's own read of the register, because
    /// this deployment has no scheduler (`0014` §C).
    pub async fn apply_due_operator_requests(&self) -> Result<Vec<Invitation>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        enter_enrolment_custody(&tx).await?;

        // **The candidate filter no longer reads the stamped flag.** ADR-0055
        // decision 3 makes the quorum a live count, so a row stamped
        // `single_operator = false` at request time is a candidate the moment
        // this deployment drops to one operator, and `apply_operator_request`
        // is what decides. Reading the stamp here would silently exclude
        // exactly the rows the new rule is about.
        let rows = tx
            .query(
                "SELECT id FROM operator_requests \
                  WHERE applied_at IS NULL AND cancelled_at IS NULL AND effective_at <= now() \
                  ORDER BY effective_at",
                &[],
            )
            .await?;

        let mut issued = Vec::new();
        for row in &rows {
            let id: String = row.get(0);
            if let Some(invitation) = self.apply_operator_request(&tx, &id).await? {
                issued.push(invitation);
            }
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(issued)
    }

    async fn apply_operator_request(
        &self,
        tx: &Transaction<'_>,
        id: &str,
    ) -> Result<Option<Invitation>, OperatorError> {
        let row = self.read_operator_request(tx, id).await?;
        if row.applied_at_unix != 0 || row.cancelled_at_unix != 0 {
            return Ok(None);
        }
        if row.effective_at_unix > now_unix() {
            return Ok(None);
        }
        // **The LIVE quorum, not `row.single_operator`.** Same
        // finding, same fix, as `apply_if_due` above (see that function's own
        // comment): the row's field is a record of this deployment's
        // configuration at REQUEST time, sealed there deliberately; gating a
        // creation that mints a whole new operator on a flag that may since
        // have been turned off (a restart, between the request and its
        // delayed apply) would let a request made under the escape hatch
        // still use it after the deployment turned it off intending exactly
        // the opposite. The outer caller's `SELECT` (`apply_due_operator_requests`)
        // still reads the row's own column to decide which requests are even
        // candidates -- that is fine: a row it excludes because neither is
        // true yet is not one this check would have accepted either, and a
        // row it includes because it stamped `single_operator = true` still
        // has to pass the live check here before anything is created.
        //
        // ADR-0055 decision 3: "the live value" is now a count over the
        // register (`live_independent_operators`), so a sole operator's
        // request applies alone after the delay and stops applying alone the
        // moment a second independent operator exists.
        //
        // **Per requester** (fix (c)): "a second independent operator" means
        // one who could second THIS requester. Bootstrap operator A plus
        // colleague B whom A added is two independent operators and zero
        // eligible seconders for A, and the old count left A's request for a
        // third operator pending for ever.
        let single_operator = quorum_for(tx, &self.ring, &row.requested_by).await? < 2;
        if row.seconded_by.is_none() && !single_operator {
            return Ok(None);
        }

        let operator_id = ids::new_ulid().to_string();
        let appended = chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorCreated,
            &entry_metadata(
                EntryType::OperatorCreated,
                &[
                    ("request", Json::Str(row.id.clone())),
                    ("operator", Json::Str(operator_id.clone())),
                    ("display_name", Json::Str(row.display_name.clone())),
                    ("requested_by", Json::Str(row.requested_by.clone())),
                    (
                        "seconded_by",
                        match &row.seconded_by {
                            Some(id) => Json::Str(id.clone()),
                            None => Json::Null,
                        },
                    ),
                    // The live value this apply was actually gated on, same
                    // as the condition above.
                    ("single_operator", Json::Bool(single_operator)),
                    ("state", Json::Str("applied".to_string())),
                ],
            ),
        )
        .await?;

        self.insert_operator(
            tx,
            &operator_id,
            &row.display_name,
            Some(&row.requested_by),
            appended.seq,
        )
        .await?;

        // **ADR-0055 decision 1: the address is the identity.** The account
        // shell for the address this request named is created here if none
        // exists, and the operator custody is bound to it in the same
        // transaction as the operator row. An operator with no bound account
        // is an operator with no address to be invited at, no address for a
        // notice, and nothing to sign in with once the key-only path is gone.
        //
        // An account that already exists at the address is USED, not
        // duplicated: this is decision 1's whole point — one person, two
        // custodies, one address — and `accounts.email` is unique, so a second
        // shell for the same address is not a state this schema can hold
        // anyway.
        let account_id = self
            .account_for_address(tx, &row.address, &row.display_name, &row.requested_by)
            .await?;
        self.bind_operator_to_account(tx, &operator_id, &account_id, appended.seq)
            .await?;

        let now = now_unix();
        let mut next = row.clone();
        next.applied_at_unix = now;
        next.sealed_seq = Some(appended.seq);
        next.created_operator_id = Some(operator_id.clone());
        let version = row.row_version + 1;
        let seal = self
            .request_seal(tx, &next.as_ref(), row.chain_seq, version)
            .await?;
        tx.execute(
            "UPDATE operator_requests \
                SET applied_at = to_timestamp($2::bigint), sealed_seq = $3, \
                    created_operator_id = $4, row_version = $5, row_seal = $6 \
              WHERE id = $1 AND applied_at IS NULL AND cancelled_at IS NULL",
            &[
                &row.id,
                &now,
                &appended.seq,
                &operator_id,
                &version,
                &seal.to_vec(),
            ],
        )
        .await?;

        // §5.5's *"a first sign-in that must register an authenticator"*, as
        // ADR-0055 decision 10 rewrites it: the new operator exists, holds
        // nothing, and the one thing they get is a `setup` token — the screen
        // that sets a credential and enrols the app code, not a screen that
        // enrols a browser key. The `operator` purpose stays in the schema for
        // the passkey step NEXT.md item 4 holds open; nothing issues one.
        let invitation = self
            .issue_token(
                tx,
                Purpose::Setup,
                &operator_id,
                &row.requested_by,
                "operator_created",
                ENROLMENT_TOKEN_LIFETIME,
            )
            .await?;
        Ok(Some(invitation))
    }

    /// Redeem an operator's enrolment token: their first key (§5.5, §6.3).
    ///
    /// The operator id comes from the TOKEN, never from the caller, for
    /// `redeem_account_enrolment`'s reason. **It is also the answer**: the
    /// returned [`OperatorKey`] names the operator the token was for, because
    /// that id is what the operator signs in with (`sessions::operator_by_id`:
    /// *"handed to them once at enrolment"*) and this is the once. Before
    /// 2026-09-21 only the key id came back, and a browser that had just
    /// enrolled had no way to learn who it had enrolled as.
    ///
    /// Every refusal here is [`OperatorError::EnrolmentRefused`] too, and
    /// `redeem_account_enrolment`'s note about
    /// [`OperatorStore::record_redemption_refused`] applies exactly: the
    /// reason is appended after this transaction has already rolled back, in
    /// a second one of its own.
    pub async fn redeem_operator_enrolment(
        &self,
        token: &[u8],
        public_key: &[u8],
    ) -> Result<OperatorKey, OperatorError> {
        check_public_key(public_key)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_enrolment_custody(&tx).await?;

        let row = match self.spend_token(&tx, token, Purpose::Operator).await {
            Ok(row) => row,
            Err(OperatorError::EnrolmentRefused) => {
                self.record_redemption_refused(
                    EntryType::OperatorSigninFailed,
                    Purpose::Operator,
                    "token_invalid",
                )
                .await;
                return Err(OperatorError::EnrolmentRefused);
            }
            Err(e) => return Err(e),
        };
        let operator = row
            .operator_id
            .clone()
            .ok_or(OperatorError::Corrupt("enrolment token subject"))?;

        // A disabled operator does not enrol a key. §4.5's re-enrolment is two
        // operators' work, not a token that was issued before the disabling.
        let Some(existing) = read_operator(&tx, &operator).await? else {
            self.record_redemption_refused(
                EntryType::OperatorSigninFailed,
                Purpose::Operator,
                "operator_not_found",
            )
            .await;
            return Err(OperatorError::EnrolmentRefused);
        };
        if existing.disabled_at_unix != 0 {
            self.record_redemption_refused(
                EntryType::OperatorSigninFailed,
                Purpose::Operator,
                "operator_disabled",
            )
            .await;
            return Err(OperatorError::EnrolmentRefused);
        }

        let redeemed = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::EnrolmentTokenRedeemed,
            &entry_metadata(
                EntryType::EnrolmentTokenRedeemed,
                &[
                    ("token", Json::Str(row.id.clone())),
                    ("purpose", Json::Str(Purpose::Operator.as_str().to_string())),
                    ("operator", Json::Str(operator.clone())),
                ],
            ),
        )
        .await?;
        self.mark_redeemed(&tx, &row, redeemed.seq).await?;

        let fpr = authority::key_fingerprint(public_key);
        let key_id = ids::new_ulid().to_string();
        let enrolled = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorEnrolled,
            &entry_metadata(
                EntryType::OperatorEnrolled,
                &[
                    ("operator", Json::Str(operator.clone())),
                    ("key", Json::Str(key_id.clone())),
                    ("fpr", Json::Str(hex(&fpr))),
                    ("key_source", Json::Str("software".to_string())),
                    ("principal_kind", Json::Str("operator".to_string())),
                ],
            ),
        )
        .await?;

        let key = OperatorKey {
            id: key_id.clone(),
            operator_id: operator.clone(),
            public_key: public_key.to_vec(),
            fpr,
            enrolled_seq: enrolled.seq,
            row_version: 1,
            retired_at_unix: 0,
        };
        let seal = authority::row_seal(
            &grants::site_row_key(&tx, &self.ring).await?,
            &RowFacts {
                table: "operator_keys",
                row_id: &key_id,
                chain_seq: enrolled.seq,
                row_version: 1,
                row_state: &operator_key_row_state(&key),
            },
        );
        tx.execute(
            "INSERT INTO operator_keys \
                 (id, operator_id, key_source, public_key, alg, fpr, enrolled_seq, row_version, \
                  row_seal) \
             VALUES ($1, $2, 'software', $3, $4, $5, $6, 1, $7)",
            &[
                &key_id,
                &operator,
                &public_key.to_vec(),
                &authority::ALG_ES256,
                &fpr.to_vec(),
                &enrolled.seq,
                &seal.to_vec(),
            ],
        )
        .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(key)
    }

    // -----------------------------------------------------------------------
    // Shared internals
    // -----------------------------------------------------------------------

    /// The acting operator's id, from a **verified** session and from nowhere
    /// else.
    ///
    /// §13 item 1: *"`actor` comes from a session, never from the caller."*
    /// This is that rule for the operator plane: every verb above starts here,
    /// takes a `&VerifiedSession` — which only `sessions::verify_pending` can
    /// make — and refuses anything that is not an operator session.
    ///
    /// It also refuses a **disabled** operator at the act, which is one check
    /// past where `sessions::verify_pending` already stops them: a session
    /// verified a microsecond before the disabling commits must not go on to
    /// act on it.
    fn acting_operator(&self, session: &VerifiedSession) -> Result<String, OperatorError> {
        if session.kind() != PrincipalKind::Operator {
            return Err(OperatorError::NotAnOperator);
        }
        Ok(session.principal_id())
    }

    /// The operator register's half of the same question, **inside the
    /// transaction the act will run in**.
    ///
    /// Two checks and not one: `sessions::verify_pending` has already refused
    /// a session whose operator is disabled, and this refuses one disabled
    /// between that check and this statement. They are in the same transaction
    /// as the act, so what this reads is what the act writes against — `0014`
    /// finding 3's rule, which is that verification and authorisation must
    /// share a snapshot.
    async fn check_operator_live(
        &self,
        tx: &Transaction<'_>,
        operator: &str,
    ) -> Result<(), OperatorError> {
        match read_operator(tx, operator).await? {
            None => Err(OperatorError::NotAnOperator),
            Some(row) if row.disabled_at_unix != 0 => Err(OperatorError::OperatorDisabled),
            Some(_) => Ok(()),
        }
    }

    /// Verify an assertion by the acting operator's **enrolled** key — §5.5's
    /// *"seconding is a hardware touch and not a row"*, and the same for a
    /// request.
    ///
    /// The session signature already proved the browser holds the session key;
    /// this proves the human holds the key the operator register knows them by,
    /// which is a different key and, for an authenticator, a different touch.
    async fn verify_operator_assertion(
        &self,
        tx: &Transaction<'_>,
        operator: &str,
        message: &[u8],
        signature: &[u8],
    ) -> Result<(), OperatorError> {
        if signature.len() != authority::SIGNATURE_LEN {
            return Err(OperatorError::Malformed("assertion signature"));
        }
        // **Every live key, not the newest one** (ADR-0055, the lead's
        // resolution 1, 2026-09-21: *"any live key of the account must be
        // accepted wherever sign-in evidence or grant signatures are
        // verified"*). Decision 6 is that any browser can be signed in to with
        // no pairing, and decision 1 has the browser register a key of its
        // own; an operator with two browsers therefore has two live keys, and
        // a `LIMIT 1` on the newest would refuse the one they are sitting at.
        // Retiring a key is still what takes it out of this set.
        let keys = live_operator_keys(tx, &self.ring, operator, now_unix()).await?;
        let mut refused = None;
        for key in &keys {
            match authority::verify_es256(&key.public_key, message, signature) {
                Ok(()) => return Ok(()),
                Err(e) => refused = Some(e),
            }
        }
        Err(match refused {
            Some(e) => OperatorError::Signature(e),
            None => OperatorError::NoOperatorKey,
        })
    }

    /// The operator's key as anything accepting a signature must resolve it:
    /// the live one, **its own row seal verified**, in service now.
    ///
    /// `grants::live_signing_key`'s argument, for the operator keyring: a
    /// keyring row whose `public_key` was edited is exactly how an
    /// administrator would sign in as somebody else.
    pub async fn live_operator_key(
        &self,
        tx: &Transaction<'_>,
        operator: &str,
        at_unix: i64,
    ) -> Result<OperatorKey, OperatorError> {
        live_operator_key(tx, &self.ring, operator, at_unix).await
    }

    /// [`OperatorStore::verify_operator_row`]'s free half, for `sessions.rs`.
    pub async fn verify_operator_row(
        &self,
        tx: &Transaction<'_>,
        operator: &str,
    ) -> Result<Operator, OperatorError> {
        verify_operator_row(tx, &self.ring, operator).await
    }
}

/// The operator's key as anything accepting a signature must resolve it: the
/// live one, **its own row seal verified**, in service now.
///
/// A free function rather than a method, because `sessions.rs` resolves it on
/// the sign-in path and has no `OperatorStore` — the same shape
/// `grants::live_signing_key` has for the account plane, and for the same
/// reason.
pub async fn live_operator_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    operator: &str,
    at_unix: i64,
) -> Result<OperatorKey, OperatorError> {
    live_operator_keys(tx, ring, operator, at_unix)
        .await?
        .into_iter()
        .next()
        .ok_or(OperatorError::NoOperatorKey)
}

/// **Every key this operator holds that is in service now**, newest first,
/// each one's own row seal verified.
///
/// ADR-0055, the lead's resolution 1 (2026-09-21): *"any live key of the
/// account must be accepted wherever sign-in evidence or grant signatures are
/// verified (no `LIMIT 1` on the newest)."* Decision 6 says any browser, with
/// no pairing, and decision 1 has each browser register a key of its own, so
/// an operator with a laptop and a phone holds two live keys and either must
/// work. Before 2026-09-21 this was `ORDER BY enrolled_seq DESC LIMIT 1` and
/// registering a second browser silently locked the first one out.
///
/// A row whose seal does not verify is an ALARM and not a skipped key:
/// [`OperatorError::Unverifiable`] comes back rather than the remaining keys,
/// because a keyring row whose `public_key` was edited is exactly how an
/// administrator would sign in as somebody else, and quietly ignoring it would
/// turn the alarm into a shrug.
pub async fn live_operator_keys(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    operator: &str,
    at_unix: i64,
) -> Result<Vec<OperatorKey>, OperatorError> {
    let rows = tx
        .query(
            "SELECT id, operator_id, public_key, fpr, enrolled_seq, row_version, \
                    COALESCE(EXTRACT(EPOCH FROM retired_at)::bigint, 0), row_seal \
               FROM operator_keys \
              WHERE operator_id = $1 AND retired_at IS NULL \
              ORDER BY enrolled_seq DESC",
            &[&operator],
        )
        .await?;
    let row_key = grants::site_row_key(tx, ring).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let fpr: Vec<u8> = row.get(3);
        let key = OperatorKey {
            id: row.get(0),
            operator_id: row.get(1),
            public_key: row.get(2),
            fpr: as_32(&fpr, "operator key fingerprint")?,
            enrolled_seq: row.get(4),
            row_version: row.get(5),
            retired_at_unix: row.get(6),
        };
        let stored_seal: Vec<u8> = row.get(7);
        let recomputed = authority::row_seal(
            &row_key,
            &RowFacts {
                table: "operator_keys",
                row_id: &key.id,
                chain_seq: key.enrolled_seq,
                row_version: key.row_version,
                row_state: &operator_key_row_state(&key),
            },
        );
        if stored_seal != recomputed {
            return Err(OperatorError::Unverifiable("operator key row seal"));
        }
        if key.retired_at_unix != 0 && at_unix > key.retired_at_unix {
            continue;
        }
        out.push(key);
    }
    Ok(out)
}

/// **Take every key in `keys` out of service at `at_unix`**, re-sealing each
/// row at `row_version + 1` over the state that now stands.
///
/// Shared by [`OperatorStore::recover_operator`] (ADR-0055 fix (a)) and
/// [`OperatorStore::adopt_first_operator_from_install`] (decision 9), because
/// two acts that retire a key must retire it the same way: `retired_at` is
/// inside [`operator_key_row_state`], so a row updated without its seal is an
/// alarm on the next read rather than a retired key.
///
/// The guarded `WHERE ... retired_at IS NULL` is what makes it once against a
/// concurrent writer; `0024` is the migration that grants the three columns
/// and adds the `UPDATE` policy, which names the operator custody.
async fn retire_operator_keys(
    tx: &Transaction<'_>,
    row_key: &Key32,
    keys: Vec<OperatorKey>,
    at_unix: i64,
) -> Result<(), OperatorError> {
    for key in keys {
        let mut key = key;
        key.retired_at_unix = at_unix;
        key.row_version += 1;
        let seal = authority::row_seal(
            row_key,
            &RowFacts {
                table: "operator_keys",
                row_id: &key.id,
                chain_seq: key.enrolled_seq,
                row_version: key.row_version,
                row_state: &operator_key_row_state(&key),
            },
        );
        tx.execute(
            "UPDATE operator_keys \
                SET retired_at = to_timestamp($2::bigint), row_version = $3, row_seal = $4 \
              WHERE id = $1 AND retired_at IS NULL",
            &[&key.id, &at_unix, &key.row_version, &seal.to_vec()],
        )
        .await?;
    }
    Ok(())
}

/// **The operator register's own interlock**: an operator row verifies only if
/// its seal recomputes AND the site-chain entry that created it verifies and
/// names it.
///
/// §5.4's *"no administrative change takes effect while its `sealed_seq` is
/// `NULL`, and nothing on the operator surface can stamp it"*, applied to the
/// register itself. A row hand-inserted by whoever holds the database fails at
/// the seal; a row whose creating entry was removed to hide it fails here.
/// Called on the operator sign-in path, so **a minted operator cannot sign
/// in**.
pub async fn verify_operator_row(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    operator: &str,
) -> Result<Operator, OperatorError> {
    {
        let Some(row) = read_operator(tx, operator).await? else {
            return Err(OperatorError::NotFound("operator"));
        };
        let stored: Option<Vec<u8>> = tx
            .query_one("SELECT row_seal FROM operators WHERE id = $1", &[&operator])
            .await?
            .get(0);
        // A NULL seal is refused exactly as a wrong one is (`0015` §A).
        let Some(stored) = stored else {
            return Err(OperatorError::Unverifiable("operator row seal"));
        };
        let Some(created_seq) = row.created_seq else {
            return Err(OperatorError::Unverifiable("operator row seal"));
        };
        let recomputed = operator_row_seal(
            tx,
            ring,
            &row.id,
            &row.display_name,
            row.created_by.as_deref(),
            row.disabled_at_unix,
            // ADR-0055 fix (d): inside the seal since 2026-09-21, because
            // decision 3 made this column decide whether a second signature
            // is required at all.
            row.first_independent_signin_at_unix,
            created_seq,
            row.row_version,
        )
        .await?;
        if stored != recomputed {
            return Err(OperatorError::Unverifiable("operator row seal"));
        }

        let entry = chains::read_site_entry_verified(tx, ring, created_seq)
            .await
            .map_err(|_| OperatorError::Unverifiable("operator creation entry"))?;
        let Some(entry) = entry else {
            return Err(OperatorError::Unverifiable("operator creation entry"));
        };
        if !matches!(
            entry.entry_type,
            EntryType::OperatorCreated | EntryType::OperatorBootstrapped
        ) {
            return Err(OperatorError::Unverifiable("operator creation entry"));
        }
        // The entry must name this operator. Parsing the canonical metadata
        // back would mean a second parser; instead the one field that matters
        // is re-rendered and searched for as canonical bytes.
        let needle = {
            let mut map = BTreeMap::new();
            map.insert("operator".to_string(), Json::Str(row.id.clone()));
            let whole = Json::Obj(map).to_canonical_bytes();
            // `to_canonical_bytes` emits `{"operator":"…"}` and a trailing
            // newline; what is wanted is the pair as it appears INSIDE the
            // entry's own object, so the leading `{` and the trailing `}\n`
            // come off. A unit test at the bottom of this file pins that
            // shape, because a silently wrong needle would make this check
            // pass on everything.
            whole[1..whole.len() - 2].to_vec()
        };
        if !contains(&entry.metadata, &needle) {
            return Err(OperatorError::Unverifiable("operator creation entry"));
        }
        Ok(row)
    }
}

/// **Record an operator's first independent sign-in (§5.5), once, and re-seal
/// the row** — ADR-0055 fix (d), 2026-09-21.
///
/// The guarded `UPDATE ... WHERE first_independent_signin_at IS NULL` is what
/// makes it once against a concurrent second sign-in; the re-seal at
/// `row_version + 1` is what makes it once against whoever holds a database
/// connection. Returns `true` when this call was the one that recorded it.
///
/// # Why it takes a `KeyRing` and the old one did not
///
/// [`note_first_signin`] wrote this column with no seal update, justified by
/// *"what it gates — seconding — additionally requires a signature by that
/// operator's own key"*. ADR-0055 decision 3 made the column gate whether a
/// second signature is required AT ALL, so moving it forward on every
/// operator row drives [`quorum_for`] to 1 and a single signature mints a new
/// operator. `0015_operator_console.sql`:162 grants that `UPDATE` to
/// `fathom_app`. The seal is the fence, and a seal needs the row key.
///
/// The read and the write are in one transaction and the write is guarded on
/// the same NULL the read saw, so two sign-ins racing produce one recorded
/// time and one seal: the loser's `UPDATE` matches no row and it returns
/// `false` without having sealed anything.
pub async fn mark_first_independent_signin(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    operator: &str,
) -> Result<bool, OperatorError> {
    let Some(row) = read_operator(tx, operator).await? else {
        return Err(OperatorError::NotFound("operator"));
    };
    if row.first_independent_signin_at_unix != 0 {
        return Ok(false);
    }
    let Some(created_seq) = row.created_seq else {
        return Err(OperatorError::Unverifiable("operator row seal"));
    };

    // The value the seal must cover is the value the row will hold, so it is
    // chosen here rather than left to `now()` inside the statement: a seal
    // over a timestamp the database picked a microsecond later would not
    // verify. Whole seconds, as every other time in this module's seals.
    let at = now_unix();
    let version = row.row_version + 1;
    let seal = operator_row_seal(
        tx,
        ring,
        &row.id,
        &row.display_name,
        row.created_by.as_deref(),
        row.disabled_at_unix,
        at,
        created_seq,
        version,
    )
    .await?;
    let updated = tx
        .execute(
            "UPDATE operators \
                SET first_independent_signin_at = to_timestamp($2::bigint), \
                    row_version = $3, row_seal = $4 \
              WHERE id = $1 AND first_independent_signin_at IS NULL",
            &[&operator, &at, &version, &seal.to_vec()],
        )
        .await?;
    Ok(updated == 1)
}

/// **Superseded by [`mark_first_independent_signin`] and deliberately inert.**
///
/// This used to be the raw `UPDATE` of `operators.first_independent_signin_at`
/// on the operator sign-in path, with no seal update — which is exactly what
/// ADR-0055 fix (d) closes now that decision 3 makes that column decide
/// whether a second signature is required at all. Writing it here would leave
/// the row failing its own seal at the next `verify_operator_row`, which is on
/// the sign-in path: an operator who signed in once could never sign in again.
///
/// **It is a no-op rather than deleted** because its one caller is
/// `sessions.rs:1896`, which belongs to another stream in this build and is
/// not edited here. The call to replace it with is:
///
/// ```text
/// operators::mark_first_independent_signin(tx, &self.ring, &account).await
/// ```
///
/// **Until that is wired, this build is weaker, and it is said out loud
/// rather than left to be discovered.** No sign-in records a first
/// independent sign-in, so `first_independent_signin_at` stays NULL for every
/// operator, [`quorum_for`] answers 1 for every requester, and a request that
/// ought to need two signatures applies on one after its 24-hour delay. The
/// delay and the sealed record stay; the second signature does not. The
/// column cannot be written from the sign-in path without the row key, and
/// the row key is not reachable from this signature — which is why the call
/// site has to change rather than this function.
pub async fn note_first_signin(
    _tx: &Transaction<'_>,
    _operator: &str,
) -> Result<(), OperatorError> {
    Ok(())
}

impl OperatorStore {
    async fn insert_operator(
        &self,
        tx: &Transaction<'_>,
        id: &str,
        display_name: &str,
        created_by: Option<&str>,
        created_seq: i64,
    ) -> Result<(), OperatorError> {
        tx.execute(
            "INSERT INTO principals (id, kind) VALUES ($1, 'operator')",
            &[&id],
        )
        .await?;
        let seal = self
            .operator_seal(tx, id, display_name, created_by, 0, 0, created_seq, 1)
            .await?;
        tx.execute(
            "INSERT INTO operators (id, display_name, created_by, created_seq, row_version, row_seal) \
             VALUES ($1, $2, $3, $4, 1, $5)",
            &[&id, &display_name, &created_by, &created_seq, &seal.to_vec()],
        )
        .await?;
        Ok(())
    }

    /// Issue one enrolment token: **its sealed entry, the row bound to that
    /// entry, and the token returned once.**
    ///
    /// §7.2's `enrolment_token_issued` is appended HERE rather than by each
    /// caller, so that every token this schema can hold was recorded when it
    /// was minted — there is no path that issues one quietly. The row's own
    /// seal names this entry's `seq`, which is the same "no entry, no act"
    /// order `sessions::sign_in` uses: stopping the log stops the issuance.
    ///
    /// The caller's own entry — `account_created`, `org_shell_created`,
    /// `operator_created`, `operator_bootstrapped` — records the act that
    /// warranted the token, and is a different fact.
    /// `lifetime` is a parameter and not [`ENROLMENT_TOKEN_LIFETIME`] read at
    /// the point of use, because ADR-0055 decision 8's break-glass code lives
    /// for ten minutes and everything else lives for seventy-two hours. Every
    /// caller states which, so a new one cannot get a three-day token by
    /// forgetting to think about it.
    async fn issue_token(
        &self,
        tx: &Transaction<'_>,
        purpose: Purpose,
        subject: &str,
        issued_by: &str,
        reason: &str,
        lifetime: Duration,
    ) -> Result<Invitation, OperatorError> {
        let issued = chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            EntryType::EnrolmentTokenIssued,
            &entry_metadata(
                EntryType::EnrolmentTokenIssued,
                &[
                    ("purpose", Json::Str(purpose.as_str().to_string())),
                    ("subject", Json::Str(subject.to_string())),
                    ("issued_by", Json::Str(issued_by.to_string())),
                    ("reason", Json::Str(reason.to_string())),
                ],
            ),
        )
        .await?;
        let issued_seq = issued.seq;
        let id = ids::new_ulid().to_string();
        let token = random_32()?;
        let hash = token_hash(&token);
        let expires_at = now_unix() + lifetime.as_secs() as i64;

        let (account, operator, shell) = match purpose {
            Purpose::Account => (Some(subject), None, None),
            Purpose::Operator | Purpose::Setup => (None, Some(subject), None),
            Purpose::Organisation => (None, None, Some(subject)),
        };

        let facts = TokenFacts {
            id: &id,
            purpose,
            token_hash: &hash,
            subject,
            issued_by,
            expires_at_unix: expires_at,
            redeemed_at_unix: 0,
            expired_at_unix: 0,
        };
        let seal = self.token_seal(tx, &facts, issued_seq, 1).await?;

        tx.execute(
            "INSERT INTO enrolment_tokens \
                 (id, purpose, token_hash, account_id, operator_id, shell_id, issued_by, \
                  issued_seq, expires_at, row_version, row_seal) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9::bigint), 1, $10)",
            &[
                &id,
                &purpose.as_str(),
                &hash.to_vec(),
                &account,
                &operator,
                &shell,
                &issued_by,
                &issued_seq,
                &expires_at,
                &seal.to_vec(),
            ],
        )
        .await?;

        Ok(Invitation {
            id,
            purpose,
            subject: subject.to_string(),
            token,
            expires_at_unix: expires_at,
        })
    }

    /// Find and check a token, refusing everything with one message.
    ///
    /// **Does not mark it redeemed** — that is `mark_redeemed`, after the act's
    /// own entry has been appended, so the row's new seal names the entry that
    /// records the redemption.
    async fn spend_token(
        &self,
        tx: &Transaction<'_>,
        token: &[u8],
        purpose: Purpose,
    ) -> Result<TokenRow, OperatorError> {
        self.find_token(tx, token, purpose, TokenUse::Spend).await
    }

    /// The lookup and every check [`OperatorStore::spend_token`] makes, with
    /// the caller saying whether this is the act or a question about it.
    ///
    /// **ADR-0056 decision 1, step 1 of the setup flow** adds a caller that
    /// asks whether a token is live without spending it, so that the setup
    /// screen can name the address instead of asking a person to type it. One
    /// function rather than two, because a second copy of the seal check, the
    /// purpose check, the redemption check and the two expiry checks is a
    /// second place for one of them to be forgotten — and the check route
    /// would be exactly the place a caller would attack.
    ///
    /// The only difference [`TokenUse::Check`] makes is that a token presented
    /// after its expiry is not recorded as presented: a read writes nothing,
    /// and `note_expired`'s own doc explains that the record does not survive
    /// the caller's rollback anyway.
    async fn find_token(
        &self,
        tx: &Transaction<'_>,
        token: &[u8],
        purpose: Purpose,
        using: TokenUse,
    ) -> Result<TokenRow, OperatorError> {
        let hash = token_hash(token);
        let row = tx
            .query_opt(
                &format!("SELECT {TOKEN_COLUMNS} FROM enrolment_tokens WHERE token_hash = $1"),
                &[&hash.to_vec()],
            )
            .await?;
        let Some(row) = row else {
            return Err(OperatorError::EnrolmentRefused);
        };
        let (out, stored_seal) = token_row(&row)?;

        if out.purpose != purpose {
            return Err(OperatorError::EnrolmentRefused);
        }

        // The seal, before anything else is believed about the row. A token
        // whose `redeemed_at` was cleared to re-open it fails here, which is
        // what makes a guarded flag as strong as a delete (`0015` §E).
        let recomputed = self
            .token_seal(tx, &out.facts(), out.issued_seq, out.row_version)
            .await?;
        if stored_seal != recomputed {
            return Err(OperatorError::Unverifiable("enrolment token row seal"));
        }

        if out.redeemed_at_unix != 0 {
            return Err(OperatorError::EnrolmentRefused);
        }
        // **`expired_at` is a terminal state and not only a note.** It was only
        // a note until 2026-09-14 -- set by `note_expired` when a token was
        // presented after `expires_at` had already passed, and read by nothing
        // -- which was harmless while the only thing that set it was a check
        // the next redemption would make again anyway. It is now also how
        // `expire_live_operator_tokens` kills the token a re-issue replaces,
        // and that token's `expires_at` is still in the future: the runtime
        // role is deliberately not granted `UPDATE (expires_at)` (`0015` §I:
        // "a token is issued once, and then either redeemed or expired"), so
        // the flag has to be the state rather than a comment on one.
        if out.expired_at_unix != 0 {
            return Err(OperatorError::EnrolmentRefused);
        }
        if out.expires_at_unix <= now_unix() {
            if using == TokenUse::Spend {
                self.note_expired(tx, &out).await?;
            }
            return Err(OperatorError::EnrolmentRefused);
        }
        Ok(out)
    }

    /// Record that a token was presented after its expiry (§7.2's
    /// `enrolment_token_expired`), **once**: the guarded `UPDATE` is the latch,
    /// so presenting a dead token in a loop does not grow the chain.
    ///
    /// **`expired_at` and `expired_seq` move in ONE statement.** They were two,
    /// until 2026-09-14, and the table's own
    /// `CHECK ((expired_at IS NULL) = (expired_seq IS NULL))` refuses the state
    /// between them -- so the first statement always failed, and this function
    /// had never run against a real database. It could not: the only path that
    /// reaches it is a token presented after its expiry, and the one test that
    /// produced one moved `expires_at` without re-sealing the row, so
    /// `spend_token` refused on the seal a few lines earlier and never got
    /// here. The seq is not known until the entry is appended, so the append
    /// moves ahead of the write rather than the two columns moving apart.
    ///
    /// **A caller that refuses AFTER calling this must commit if it wants the
    /// entry.** `spend_token` does not: it calls this and then returns
    /// `EnrolmentRefused`, and every caller of `spend_token` drops the
    /// transaction, so the record of the presentation rolls back with it.
    /// Reported 2026-09-14 and NOT fixed here -- recording a refusal durably
    /// while refusing means a second transaction, and that is its own act with
    /// its own review.
    async fn note_expired(
        &self,
        tx: &Transaction<'_>,
        row: &TokenRow,
    ) -> Result<(), OperatorError> {
        // The latch, read from the row this transaction already holds.
        if row.expired_at_unix != 0 {
            return Ok(());
        }
        let appended = chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            EntryType::EnrolmentTokenExpired,
            &entry_metadata(
                EntryType::EnrolmentTokenExpired,
                &[
                    ("token", Json::Str(row.id.clone())),
                    ("purpose", Json::Str(row.purpose.as_str().to_string())),
                    ("reason", Json::Str("presented_after_expiry".to_string())),
                ],
            ),
        )
        .await?;

        let now = now_unix();
        let mut facts = row.facts();
        facts.expired_at_unix = now;
        let version = row.row_version + 1;
        let seal = self.token_seal(tx, &facts, row.issued_seq, version).await?;
        tx.execute(
            "UPDATE enrolment_tokens \
                SET expired_at = to_timestamp($2::bigint), expired_seq = $3, \
                    row_version = $4, row_seal = $5 \
              WHERE id = $1 AND expired_at IS NULL",
            &[&row.id, &now, &appended.seq, &version, &seal.to_vec()],
        )
        .await?;
        Ok(())
    }

    /// Spend the token: a guarded `UPDATE` whose new state goes back into the
    /// seal.
    ///
    /// `WHERE redeemed_at IS NULL` is what makes this single-use against a
    /// concurrent second redemption — the first writer holds the row lock and
    /// the second sees no row — and the seal is what makes it single-use
    /// against whoever holds the database.
    ///
    /// `AND expired_at IS NULL AND row_version = $6`: spending any
    /// setup-class token expires the operator's every other live one
    /// ([`OperatorStore::expire_live_tokens`]), so a redemption can race a
    /// concurrent expiry of this same row. `redeemed_at IS NULL` alone would
    /// let that expiry commit first, unnoticed, and this `UPDATE` then
    /// clobber the row with a seal computed from stale facts — both
    /// `redeemed_at` and `expired_at` set but sealed as if only one were
    /// true, unverifiable ever after. Tying this write to the exact
    /// `row_version` the read of `row` saw makes anything that touched the
    /// row in between (expiry included) an ordinary refusal, `updated ==
    /// 0`, instead of that.
    async fn mark_redeemed(
        &self,
        tx: &Transaction<'_>,
        row: &TokenRow,
        redeemed_seq: i64,
    ) -> Result<(), OperatorError> {
        let now = now_unix();
        let mut facts = row.facts();
        facts.redeemed_at_unix = now;
        let version = row.row_version + 1;
        let seal = self.token_seal(tx, &facts, row.issued_seq, version).await?;
        let updated = tx
            .execute(
                "UPDATE enrolment_tokens \
                    SET redeemed_at = to_timestamp($2::bigint), redeemed_seq = $3, \
                        row_version = $4, row_seal = $5 \
                  WHERE id = $1 AND redeemed_at IS NULL AND expired_at IS NULL \
                        AND row_version = $6",
                &[
                    &row.id,
                    &now,
                    &redeemed_seq,
                    &version,
                    &seal.to_vec(),
                    &row.row_version,
                ],
            )
            .await?;
        if updated == 0 {
            return Err(OperatorError::EnrolmentRefused);
        }
        Ok(())
    }

    /// **Record a refused redemption, in a transaction of its own.**
    ///
    /// `redeem_account_enrolment` and `redeem_operator_enrolment` refuse
    /// without committing — every check after `spend_token` runs inside the
    /// transaction that opened to spend the token, and a caller that finds a
    /// reason to refuse returns before that transaction ever commits — so an
    /// entry appended inside it rolls back with everything else. `note_expired`
    /// already reported exactly this gap for one cause (a token presented
    /// after its own expiry) on 2026-09-14; this is the fix, for every cause
    /// a redemption is refused, not only that one.
    ///
    /// Called AFTER the refusing transaction's own work, never before: this
    /// opens a fresh connection and a fresh transaction, so the entry it
    /// appends survives however the caller's transaction resolves.
    ///
    /// **`entry_type` is one of the two site-chain types `sessions.rs` already
    /// writes for a failed sign-in** — [`EntryType::AccountSigninFailed`] for
    /// an account redemption, [`EntryType::OperatorSigninFailed`] for an
    /// operator one — reused rather than a third type of this function's own:
    /// a redemption that fails is, from an operator reading the site chain,
    /// the same fact a failed sign-in is (somebody who does not hold what this
    /// surface asked for presented themselves), and a new `EntryType` needs a
    /// migration this fix does not make.
    ///
    /// **Best-effort.** A failure here must not turn an ordinary refusal into
    /// a 500: it is logged and swallowed, never propagated to the caller, who
    /// gets [`OperatorError::EnrolmentRefused`] either way.
    async fn record_redemption_refused(
        &self,
        entry_type: EntryType,
        purpose: Purpose,
        reason: &'static str,
    ) {
        let attempt: Result<(), OperatorError> = async {
            let mut client = self.pool.get().await?;
            let tx = client.transaction().await?;
            enter_enrolment_custody(&tx).await?;
            chains::append_site(
                &tx,
                &self.ring,
                &self.deployment,
                entry_type,
                &entry_metadata(
                    entry_type,
                    &[
                        ("purpose", Json::Str(purpose.as_str().to_string())),
                        ("reason", Json::Str(reason.to_string())),
                    ],
                ),
            )
            .await?;
            leave_custody(&tx).await?;
            tx.commit().await?;
            Ok(())
        }
        .await;
        if let Err(e) = attempt {
            tracing::error!(
                error = %e,
                purpose = purpose.as_str(),
                reason,
                "could not record a refused enrolment redemption"
            );
        }
    }

    async fn notice_address(&self, tx: &Transaction<'_>) -> Result<String, OperatorError> {
        let row = tx
            .query_opt("SELECT notice_address FROM site_install", &[])
            .await?;
        row.map(|r| r.get(0))
            .ok_or(OperatorError::NotFound("install record"))
    }

    // ---- seals ------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    async fn operator_seal(
        &self,
        tx: &Transaction<'_>,
        id: &str,
        display_name: &str,
        created_by: Option<&str>,
        disabled_at_unix: i64,
        first_independent_signin_at_unix: i64,
        created_seq: i64,
        row_version: i32,
    ) -> Result<[u8; 32], OperatorError> {
        operator_row_seal(
            tx,
            &self.ring,
            id,
            display_name,
            created_by,
            disabled_at_unix,
            first_independent_signin_at_unix,
            created_seq,
            row_version,
        )
        .await
    }
}

/// The seal on one `operators` row.
///
/// Free, because `verify_operator_row` is — `sessions.rs` checks this on the
/// sign-in path and has no `OperatorStore`.
///
/// **`first_independent_signin_at` is INSIDE it since ADR-0055 fix (d)**,
/// 2026-09-21, and [`mark_first_independent_signin`] is the only writer.
///
/// It used to be outside, justified by *"what it gates — seconding —
/// additionally requires a signature by that operator's own key, so a
/// backdated timestamp buys an attacker nothing"*. ADR-0055 decision 3 made
/// the column gate whether a second signature is required AT ALL: move it
/// forward on every row and `live_independent_operators` reads 0,
/// [`quorum_for`] reads 1, and `apply_operator_request` mints a new operator
/// on one signature. `0015_operator_console.sql`:162 grants `fathom_app`
/// `UPDATE (first_independent_signin_at)` and the `operators` write policy's
/// WITH CHECK is only the two custodies, so that write is inside the
/// application role, not only inside tier 3.
#[allow(clippy::too_many_arguments)]
pub async fn operator_row_seal(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    id: &str,
    display_name: &str,
    created_by: Option<&str>,
    disabled_at_unix: i64,
    first_independent_signin_at_unix: i64,
    created_seq: i64,
    row_version: i32,
) -> Result<[u8; 32], OperatorError> {
    {
        let mut map = BTreeMap::new();
        map.insert(
            "created_by".to_string(),
            match created_by {
                Some(by) => Json::Str(by.to_string()),
                None => Json::Null,
            },
        );
        map.insert("created_seq".to_string(), Json::Int(created_seq));
        map.insert("disabled_at".to_string(), Json::Int(disabled_at_unix));
        map.insert(
            "first_independent_signin_at".to_string(),
            Json::Int(first_independent_signin_at_unix),
        );
        map.insert(
            "display_name".to_string(),
            Json::Str(display_name.to_string()),
        );
        map.insert("id".to_string(), Json::Str(id.to_string()));
        Ok(authority::row_seal(
            &grants::site_row_key(tx, ring).await?,
            &RowFacts {
                table: "operators",
                row_id: id,
                chain_seq: created_seq,
                row_version,
                row_state: &Json::Obj(map).to_canonical_bytes(),
            },
        ))
    }
}

/// **The `row_state` an `operators` row was sealed under before ADR-0055's
/// fix round S2** -- [`operator_row_seal`]'s map with
/// `first_independent_signin_at` left out.
///
/// Written by every build from `d774af8` (the operator console and migration
/// `0015`, which gave this table its `row_seal` column) through `0aadb0f`
/// (ADR-0055 stream (b)). `6d1b5de`, 2026-09-21, brought the column inside the
/// seal, because decision 3 had just made it decide whether a second signature
/// is required at all.
///
/// **There is exactly one legacy shape, and this is it.** `git log -p -S
/// first_independent_signin_at -- crates/fathom-server/src/operators.rs` names
/// three commits: `d774af8`, which created the file; `0aadb0f`, which did not
/// touch this map; and `6d1b5de`, which added the key. `authority::row_seal`
/// and `RowFacts` have not changed since `3c931c1`, which predates all three,
/// so nothing else about the computation has moved either. If a fourth shape
/// ever exists it gets its own `legacy_operator_row_state_v2` beside this one
/// and [`OperatorStore::reseal_legacy_operator_rows`] tries both.
fn legacy_operator_row_state_v1(
    id: &str,
    display_name: &str,
    created_by: Option<&str>,
    disabled_at_unix: i64,
    created_seq: i64,
) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert(
        "created_by".to_string(),
        match created_by {
            Some(by) => Json::Str(by.to_string()),
            None => Json::Null,
        },
    );
    map.insert("created_seq".to_string(), Json::Int(created_seq));
    map.insert("disabled_at".to_string(), Json::Int(disabled_at_unix));
    map.insert(
        "display_name".to_string(),
        Json::Str(display_name.to_string()),
    );
    map.insert("id".to_string(), Json::Str(id.to_string()));
    Json::Obj(map).to_canonical_bytes()
}

/// The seal an `operators` row carried before ADR-0055's fix round S2, over
/// [`legacy_operator_row_state_v1`].
///
/// **Public for two callers and for no others**:
/// [`OperatorStore::reseal_legacy_operator_rows`], which runs once at start
/// and converts such a seal into a current one, and the test that proves it by
/// sealing a row the way the old build did.
///
/// **[`verify_operator_row`] does not call it and must never call it.** The
/// sign-in path, the seconding path and every console verb verify against the
/// CURRENT shape only; a verifier that quietly accepted the old shape would
/// leave `first_independent_signin_at` outside the seal forever, which is the
/// hole fix (d) closed.
#[allow(clippy::too_many_arguments)]
pub async fn legacy_operator_row_seal(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    id: &str,
    display_name: &str,
    created_by: Option<&str>,
    disabled_at_unix: i64,
    created_seq: i64,
    row_version: i32,
) -> Result<[u8; 32], OperatorError> {
    Ok(authority::row_seal(
        &grants::site_row_key(tx, ring).await?,
        &RowFacts {
            table: "operators",
            row_id: id,
            chain_seq: created_seq,
            row_version,
            row_state: &legacy_operator_row_state_v1(
                id,
                display_name,
                created_by,
                disabled_at_unix,
                created_seq,
            ),
        },
    ))
}

impl OperatorStore {
    /// **Bring every `operators` row sealed by an older build up to this
    /// build's seal** -- written 2026-09-21, and run by `main.rs` on every
    /// start before the bootstrap and the adoption.
    ///
    /// # Why a deployment cannot start without this
    ///
    /// ADR-0055 fix (d) (`6d1b5de`) put `first_independent_signin_at` inside
    /// [`operator_row_seal`]. Every `operators` row written before that was
    /// sealed over [`legacy_operator_row_state_v1`], so on the first start of
    /// this build [`verify_operator_row`] answers
    /// `Unverifiable("operator row seal")` for it -- and that is not a corner:
    /// it is the sign-in path, it is [`eligible_seconders_for`], which reads
    /// and verifies EVERY row in the register, and it is
    /// [`OperatorStore::adopt_first_operator_from_install`], which verifies
    /// the row before it binds it. A deployment that upgraded from a build
    /// before the fix round would refuse to start at all, having started
    /// perfectly well the day before.
    ///
    /// # What it will and will not do
    ///
    /// A row whose stored seal matches the current shape is left alone, so a
    /// second run returns 0 and this is idempotent. A row whose stored seal
    /// matches the legacy shape is re-sealed under the current shape at
    /// `row_version + 1` -- `row_seal` and `row_version` and no other column,
    /// which is exactly the `UPDATE` `0015` §A grants `fathom_app` and exactly
    /// the custody [`mark_first_independent_signin`] re-seals under. A row that
    /// matches neither is [`OperatorError::UnverifiableOperatorRow`], by id,
    /// and `main.rs` refuses to start: a row that was not written by any build
    /// of this server is a tampered row, and re-sealing it would be forging a
    /// seal over whatever somebody put there.
    ///
    /// **It launders nothing.** The re-seal proves only that the row's bytes
    /// are the bytes an older build sealed; [`verify_operator_row`] still
    /// demands the sealed creation entry naming this operator afterwards, and
    /// that check is untouched. And it carries the row's CURRENT
    /// `first_independent_signin_at` into the new seal, because that is the
    /// value at rest -- under the old build that column was outside the seal
    /// and `note_first_signin` wrote it raw, so nothing here or anywhere can
    /// tell a value that was moved before this start from one that was not.
    /// From this start on it is sealed.
    ///
    /// Under the bootstrap's own advisory lock, for the reason the adoption
    /// takes it: two interchangeable containers start at once, and both would
    /// otherwise read the same row and write the same `row_version + 1`.
    pub async fn reseal_legacy_operator_rows(&self) -> Result<usize, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('fathom/operator/bootstrap', 0))",
            &[],
        )
        .await?;

        let ids: Vec<String> = tx
            .query("SELECT id FROM operators ORDER BY id", &[])
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        let mut resealed = 0usize;
        for id in ids {
            if self.reseal_one_legacy_operator_row(&tx, &id).await? {
                resealed += 1;
            }
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(resealed)
    }

    /// One row of [`OperatorStore::reseal_legacy_operator_rows`]. `true` when
    /// this call re-sealed it.
    async fn reseal_one_legacy_operator_row(
        &self,
        tx: &Transaction<'_>,
        id: &str,
    ) -> Result<bool, OperatorError> {
        let Some(row) = read_operator(tx, id).await? else {
            // Nothing deletes an `operators` row -- there is no DELETE
            // privilege and no policy for one (`0015` §A) -- so this is a read
            // that raced nothing. It is not an error either way.
            return Ok(false);
        };
        let stored: Option<Vec<u8>> = tx
            .query_one("SELECT row_seal FROM operators WHERE id = $1", &[&id])
            .await?
            .get(0);
        // A NULL seal and a NULL `created_seq` are refused exactly as a wrong
        // seal is, and for the same reason: there is no older shape they could
        // be the honest remains of.
        let (Some(stored), Some(created_seq)) = (stored, row.created_seq) else {
            return Err(OperatorError::UnverifiableOperatorRow(id.to_string()));
        };

        let current = operator_row_seal(
            tx,
            &self.ring,
            &row.id,
            &row.display_name,
            row.created_by.as_deref(),
            row.disabled_at_unix,
            row.first_independent_signin_at_unix,
            created_seq,
            row.row_version,
        )
        .await?;
        if stored == current {
            return Ok(false);
        }

        let legacy = legacy_operator_row_seal(
            tx,
            &self.ring,
            &row.id,
            &row.display_name,
            row.created_by.as_deref(),
            row.disabled_at_unix,
            created_seq,
            row.row_version,
        )
        .await?;
        if stored != legacy {
            return Err(OperatorError::UnverifiableOperatorRow(id.to_string()));
        }

        let version = row.row_version + 1;
        let seal = operator_row_seal(
            tx,
            &self.ring,
            &row.id,
            &row.display_name,
            row.created_by.as_deref(),
            row.disabled_at_unix,
            row.first_independent_signin_at_unix,
            created_seq,
            version,
        )
        .await?;
        // Guarded on the version that was read, so a second process that took
        // the lock first and re-sealed this row updates nothing here rather
        // than writing a seal over a `row_version` that has moved.
        let updated = tx
            .execute(
                "UPDATE operators SET row_version = $2, row_seal = $3 \
                  WHERE id = $1 AND row_version = $4",
                &[&id, &version, &seal.to_vec(), &row.row_version],
            )
            .await?;
        if updated != 1 {
            return Err(OperatorError::UnverifiableOperatorRow(id.to_string()));
        }
        Ok(true)
    }
}

impl OperatorStore {
    #[allow(clippy::too_many_arguments)]
    async fn shell_seal(
        &self,
        tx: &Transaction<'_>,
        id: &str,
        display_name: &str,
        created_by: &str,
        organisation: Option<&str>,
        redeemed_at_unix: i64,
        created_seq: i64,
        row_version: i32,
    ) -> Result<[u8; 32], OperatorError> {
        let mut map = BTreeMap::new();
        map.insert("created_by".to_string(), Json::Str(created_by.to_string()));
        map.insert(
            "display_name".to_string(),
            Json::Str(display_name.to_string()),
        );
        map.insert("id".to_string(), Json::Str(id.to_string()));
        map.insert(
            "organisation_id".to_string(),
            match organisation {
                Some(id) => Json::Str(id.to_string()),
                None => Json::Null,
            },
        );
        map.insert("redeemed_at".to_string(), Json::Int(redeemed_at_unix));
        Ok(authority::row_seal(
            &grants::site_row_key(tx, &self.ring).await?,
            &RowFacts {
                table: "organisation_shells",
                row_id: id,
                chain_seq: created_seq,
                row_version,
                row_state: &Json::Obj(map).to_canonical_bytes(),
            },
        ))
    }

    async fn token_seal(
        &self,
        tx: &Transaction<'_>,
        facts: &TokenFacts<'_>,
        issued_seq: i64,
        row_version: i32,
    ) -> Result<[u8; 32], OperatorError> {
        let mut map = BTreeMap::new();
        map.insert("expired_at".to_string(), Json::Int(facts.expired_at_unix));
        map.insert("expires_at".to_string(), Json::Int(facts.expires_at_unix));
        map.insert("id".to_string(), Json::Str(facts.id.to_string()));
        map.insert(
            "issued_by".to_string(),
            Json::Str(facts.issued_by.to_string()),
        );
        map.insert(
            "purpose".to_string(),
            Json::Str(facts.purpose.as_str().to_string()),
        );
        map.insert("redeemed_at".to_string(), Json::Int(facts.redeemed_at_unix));
        map.insert("subject".to_string(), Json::Str(facts.subject.to_string()));
        map.insert("token_hash".to_string(), Json::Str(hex(facts.token_hash)));
        Ok(authority::row_seal(
            &grants::site_row_key(tx, &self.ring).await?,
            &RowFacts {
                table: "enrolment_tokens",
                row_id: facts.id,
                chain_seq: issued_seq,
                row_version,
                row_state: &Json::Obj(map).to_canonical_bytes(),
            },
        ))
    }

    async fn setting_seal(
        &self,
        tx: &Transaction<'_>,
        facts: &SettingFacts<'_>,
        requested_seq: i64,
        row_version: i32,
    ) -> Result<[u8; 32], OperatorError> {
        let mut map = BTreeMap::new();
        map.insert("applied_at".to_string(), Json::Int(facts.applied_at_unix));
        map.insert(
            "cancelled_at".to_string(),
            Json::Int(facts.cancelled_at_unix),
        );
        map.insert(
            "effective_at".to_string(),
            Json::Int(facts.effective_at_unix),
        );
        map.insert("id".to_string(), Json::Str(facts.id.to_string()));
        map.insert("key".to_string(), Json::Str(facts.key.to_string()));
        map.insert("request_sig".to_string(), Json::Str(hex(facts.request_sig)));
        map.insert(
            "requested_by".to_string(),
            Json::Str(facts.requested_by.to_string()),
        );
        map.insert(
            "sealed_seq".to_string(),
            match facts.sealed_seq {
                Some(seq) => Json::Int(seq),
                None => Json::Null,
            },
        );
        map.insert(
            "second_sig".to_string(),
            match facts.second_sig {
                Some(sig) => Json::Str(hex(sig)),
                None => Json::Null,
            },
        );
        map.insert(
            "seconded_by".to_string(),
            match facts.seconded_by {
                Some(id) => Json::Str(id.to_string()),
                None => Json::Null,
            },
        );
        map.insert(
            "single_operator".to_string(),
            Json::Bool(facts.single_operator),
        );
        map.insert(
            "value_digest".to_string(),
            Json::Str(hex(facts.value_digest)),
        );
        Ok(authority::row_seal(
            &grants::site_row_key(tx, &self.ring).await?,
            &RowFacts {
                table: "site_settings_versions",
                row_id: facts.id,
                chain_seq: requested_seq,
                row_version,
                row_state: &Json::Obj(map).to_canonical_bytes(),
            },
        ))
    }

    async fn request_seal(
        &self,
        tx: &Transaction<'_>,
        facts: &OperatorRequestFacts<'_>,
        requested_seq: i64,
        row_version: i32,
    ) -> Result<[u8; 32], OperatorError> {
        let mut map = BTreeMap::new();
        map.insert("applied_at".to_string(), Json::Int(facts.applied_at_unix));
        map.insert(
            "cancelled_at".to_string(),
            Json::Int(facts.cancelled_at_unix),
        );
        map.insert(
            "created_operator_id".to_string(),
            match facts.created_operator_id {
                Some(id) => Json::Str(id.to_string()),
                None => Json::Null,
            },
        );
        map.insert("address".to_string(), Json::Str(facts.address.to_string()));
        map.insert(
            "display_name".to_string(),
            Json::Str(facts.display_name.to_string()),
        );
        map.insert(
            "effective_at".to_string(),
            Json::Int(facts.effective_at_unix),
        );
        map.insert("id".to_string(), Json::Str(facts.id.to_string()));
        map.insert("request_sig".to_string(), Json::Str(hex(facts.request_sig)));
        map.insert(
            "requested_by".to_string(),
            Json::Str(facts.requested_by.to_string()),
        );
        map.insert(
            "sealed_seq".to_string(),
            match facts.sealed_seq {
                Some(seq) => Json::Int(seq),
                None => Json::Null,
            },
        );
        map.insert(
            "second_sig".to_string(),
            match facts.second_sig {
                Some(sig) => Json::Str(hex(sig)),
                None => Json::Null,
            },
        );
        map.insert(
            "seconded_by".to_string(),
            match facts.seconded_by {
                Some(id) => Json::Str(id.to_string()),
                None => Json::Null,
            },
        );
        map.insert(
            "single_operator".to_string(),
            Json::Bool(facts.single_operator),
        );
        Ok(authority::row_seal(
            &grants::site_row_key(tx, &self.ring).await?,
            &RowFacts {
                table: "operator_requests",
                row_id: facts.id,
                chain_seq: requested_seq,
                row_version,
                row_state: &Json::Obj(map).to_canonical_bytes(),
            },
        ))
    }

    // ---- the settings value's key ----------------------------------------

    /// The key a setting's value is sealed under.
    ///
    /// Derived from the **site chain key**, in exactly the shape
    /// `authority::row_key` and `sessions::claimed_address_key` derive theirs,
    /// and for the same reason: the site chain key is the one key in this
    /// deployment that is the same for every organisation, and a site setting
    /// belongs to no organisation.
    ///
    /// **Why not the master key hierarchy.** ADR-0043's hierarchy is master →
    /// tenant → design, and every level below the master is a WRAPPED key row
    /// so that §12.6's re-wrap can move custody without re-encrypting anything.
    /// A site-level data key has no tenant to hang off, and inventing a wrapped
    /// site key row means `keys::rewrap_master_key` has to learn about it or a
    /// re-wrap silently leaves the settings unopenable. Deriving from the chain
    /// master instead puts a setting's value in exactly the custody a site
    /// chain entry's metadata is already in (`chain::site_metadata_key`), which
    /// is where the same change's `value_digest` and its whole history already
    /// live. **Reported to the lead as a decision the documents do not make.**
    async fn settings_key(&self, tx: &Transaction<'_>) -> Result<Key32, OperatorError> {
        let site = grants::site_chain_key(tx, &self.ring).await?;
        Ok(crypto::hkdf_expand(&site, KDF_SITE_SETTINGS))
    }

    fn settings_aad(&self, id: &str, key: &str, epoch: i32) -> Vec<u8> {
        let mut aad = Vec::with_capacity(128);
        crypto::lp(&mut aad, AAD_SITE_SETTINGS);
        crypto::lp(&mut aad, self.deployment.as_bytes());
        crypto::lp(&mut aad, id.as_bytes());
        crypto::lp(&mut aad, key.as_bytes());
        crypto::u32_le(&mut aad, epoch as u32);
        aad
    }

    async fn seal_setting(
        &self,
        tx: &Transaction<'_>,
        id: &str,
        key: &str,
        value: &[u8],
    ) -> Result<(Vec<u8>, [u8; crypto::NONCE_LEN]), OperatorError> {
        let sealing_key = self.settings_key(tx).await?;
        let nonce = crypto::random_nonce()?;
        let aad = self.settings_aad(id, key, CHAIN_KEY_EPOCH);
        let ciphertext = crypto::seal(&sealing_key, &nonce, value, &aad)?;
        Ok((ciphertext, nonce))
    }

    // ---- reads ------------------------------------------------------------

    async fn read_setting(
        &self,
        tx: &Transaction<'_>,
        id: &str,
    ) -> Result<PendingChange, OperatorError> {
        let row = self.read_setting_row(tx, id).await?;
        Ok(PendingChange {
            id: row.facts.id.clone(),
            subject: row.facts.key.clone(),
            requested_by: row.facts.requested_by.clone(),
            seconded_by: row.facts.seconded_by.clone(),
            single_operator: row.facts.single_operator,
            effective_at_unix: row.facts.effective_at_unix,
            applied_at_unix: row.facts.applied_at_unix,
            cancelled_at_unix: row.facts.cancelled_at_unix,
            sealed_seq: row.facts.sealed_seq,
        })
    }

    async fn read_setting_row(
        &self,
        tx: &Transaction<'_>,
        id: &str,
    ) -> Result<SettingRow, OperatorError> {
        let row = tx
            .query_opt(
                "SELECT id, key, value_ct, value_nonce, value_key_epoch, value_digest, \
                        requested_by, request_sig, requested_seq, seconded_by, second_sig, \
                        single_operator, EXTRACT(EPOCH FROM effective_at)::bigint, \
                        COALESCE(EXTRACT(EPOCH FROM cancelled_at)::bigint, 0), \
                        COALESCE(EXTRACT(EPOCH FROM applied_at)::bigint, 0), \
                        sealed_seq, row_version, row_seal \
                   FROM site_settings_versions WHERE id = $1",
                &[&id],
            )
            .await?;
        let Some(row) = row else {
            return Err(OperatorError::NotFound("pending change"));
        };
        let digest: Vec<u8> = row.get(5);
        Ok(SettingRow {
            facts: OwnedSettingFacts {
                id: row.get(0),
                key: row.get(1),
                value_digest: as_32(&digest, "settings value digest")?,
                requested_by: row.get(6),
                request_sig: row.get(7),
                seconded_by: row.get(9),
                second_sig: row.get(10),
                single_operator: row.get(11),
                effective_at_unix: row.get(12),
                cancelled_at_unix: row.get(13),
                applied_at_unix: row.get(14),
                sealed_seq: row.get(15),
            },
            value_ct: row.get(2),
            value_nonce: row.get(3),
            value_key_epoch: row.get(4),
            chain_seq: row.get(8),
            row_version: row.get(16),
            stored_seal: row.get(17),
        })
    }

    async fn read_operator_request(
        &self,
        tx: &Transaction<'_>,
        id: &str,
    ) -> Result<OwnedRequestFacts, OperatorError> {
        let row = tx
            .query_opt(
                "SELECT id, display_name, requested_by, request_sig, requested_seq, \
                        seconded_by, second_sig, single_operator, \
                        EXTRACT(EPOCH FROM effective_at)::bigint, \
                        COALESCE(EXTRACT(EPOCH FROM cancelled_at)::bigint, 0), \
                        COALESCE(EXTRACT(EPOCH FROM applied_at)::bigint, 0), \
                        sealed_seq, created_operator_id, row_version, address \
                   FROM operator_requests WHERE id = $1",
                &[&id],
            )
            .await?;
        let Some(row) = row else {
            return Err(OperatorError::NotFound("pending change"));
        };
        Ok(OwnedRequestFacts {
            id: row.get(0),
            display_name: row.get(1),
            address: row.get(14),
            requested_by: row.get(2),
            request_sig: row.get(3),
            chain_seq: row.get(4),
            seconded_by: row.get(5),
            second_sig: row.get(6),
            single_operator: row.get(7),
            effective_at_unix: row.get(8),
            cancelled_at_unix: row.get(9),
            applied_at_unix: row.get(10),
            sealed_seq: row.get(11),
            created_operator_id: row.get(12),
            row_version: row.get(13),
        })
    }

    /// Every pending settings change, for the console.
    pub async fn list_pending_settings(&self) -> Result<Vec<PendingChange>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        let rows = tx
            .query(
                "SELECT id, key, requested_by, seconded_by, single_operator, \
                        EXTRACT(EPOCH FROM effective_at)::bigint, \
                        COALESCE(EXTRACT(EPOCH FROM applied_at)::bigint, 0), \
                        COALESCE(EXTRACT(EPOCH FROM cancelled_at)::bigint, 0), sealed_seq \
                   FROM site_settings_versions \
                  WHERE applied_at IS NULL AND cancelled_at IS NULL \
                  ORDER BY effective_at",
                &[],
            )
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(rows
            .iter()
            .map(|row| PendingChange {
                id: row.get(0),
                subject: row.get(1),
                requested_by: row.get(2),
                seconded_by: row.get(3),
                single_operator: row.get(4),
                effective_at_unix: row.get(5),
                applied_at_unix: row.get(6),
                cancelled_at_unix: row.get(7),
                sealed_seq: row.get(8),
            })
            .collect())
    }

    // ---- ADR-0055 stream (a): the first operator's setup token -------------
    //
    // Added at the END of this impl, in a labelled block, so the other two
    // ADR-0055 streams' additions land beside it and the merge is mechanical.

    /// Issue a `purpose = 'setup'` token for an operator who already exists —
    /// this is where ADR-0057 decision 1's T is minted, at every start.
    ///
    /// Its lifetime is the setup password's own window
    /// ([`credentials::SETUP_SECRET_WINDOW`]), not the seventy-two hours
    /// every other enrolment token gets: `main.rs` enforces that window in
    /// memory (`credentials::SetupSecret`'s `closes_at`), and the row
    /// underneath must not outlive it, wherever the token came from — the
    /// bootstrap invitation, the adoption invitation, or one minted here at
    /// an earlier start and never redeemed. All three share this one
    /// constant.
    ///
    /// **Deliberately not an active sweep of every other live setup-class
    /// token for this operator.** Two containers of the same deployment
    /// starting close together each mint their own token here, and both must
    /// stay independently presentable until one is actually redeemed —
    /// [`CredentialStore::redeem_setup_by_token`]'s guarded `UPDATE` and its
    /// own sweep (spending any one expires every other live one) are what
    /// that relies on; a sweep here would pre-empt it a start too early.
    ///
    /// Returns the token exactly once.
    pub async fn issue_setup_token(&self, operator: &str) -> Result<Invitation, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        enter_enrolment_custody(&tx).await?;
        self.check_operator_live(&tx, operator).await?;
        let invitation = self
            .issue_token(
                &tx,
                Purpose::Setup,
                operator,
                operator,
                "setup",
                crate::credentials::SETUP_SECRET_WINDOW,
            )
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(invitation)
    }

    /// Spend a `purpose = 'setup'` token (`0019` §B) **inside the caller's
    /// transaction**, and say which operator it was for.
    ///
    /// ADR-0055 decision 10's last bullet: the token the first start writes
    /// opens the setup screen that sets a password and enrols the app code,
    /// instead of enrolling a browser key. `credentials.rs` is the one caller;
    /// it is here rather than there so that the seal check, the expiry check
    /// and the `enrolment_token_redeemed` entry are the ones this module
    /// already makes for every other purpose, and not a second copy of them.
    ///
    /// **The caller must already hold `app.enrolment_custody`** — `0015` §H
    /// grants the `UPDATE` on `enrolment_tokens` to that capability and to no
    /// other — and must commit for the redemption to stand. Every refusal is
    /// [`OperatorError::EnrolmentRefused`], one message for every cause.
    pub async fn spend_setup_token(
        &self,
        tx: &Transaction<'_>,
        token: &[u8],
    ) -> Result<String, OperatorError> {
        let row = self.spend_token(tx, token, Purpose::Setup).await?;
        let operator = row
            .operator_id
            .clone()
            .ok_or(OperatorError::Corrupt("enrolment token subject"))?;

        let redeemed = chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            EntryType::EnrolmentTokenRedeemed,
            &entry_metadata(
                EntryType::EnrolmentTokenRedeemed,
                &[
                    ("token", Json::Str(row.id.clone())),
                    ("purpose", Json::Str(Purpose::Setup.as_str().to_string())),
                    ("operator", Json::Str(operator.clone())),
                ],
            ),
        )
        .await?;
        self.mark_redeemed(tx, &row, redeemed.seq).await?;
        Ok(operator)
    }

    /// **Is this a live `purpose = 'setup'` token?** Answers which operator it
    /// is for, spends nothing and writes nothing.
    ///
    /// ADR-0056 decision 1: the setup screen's first step asks this so that it
    /// can name the address the token opens rather than asking a person to
    /// type an address that could then not match. The token is still the whole
    /// of the proof; this only moves where it is checked.
    ///
    /// **A read, and the caller may roll back.** No entry is appended, no
    /// column moves, and [`OperatorStore::spend_setup_token`] is still the only
    /// way a setup token stops being live. Every refusal is
    /// [`OperatorError::EnrolmentRefused`] — wrong, spent, expired and
    /// malformed alike — which is the same one message the redemption gives.
    ///
    /// **The caller must already hold `app.enrolment_custody`**, as `0015` §H
    /// requires for reading `enrolment_tokens` at all.
    pub async fn check_setup_token(
        &self,
        tx: &Transaction<'_>,
        token: &[u8],
    ) -> Result<String, OperatorError> {
        let row = self
            .find_token(tx, token, Purpose::Setup, TokenUse::Check)
            .await?;
        row.operator_id
            .clone()
            .ok_or(OperatorError::Corrupt("enrolment token subject"))
    }
}

/// What a caller of [`OperatorStore::find_token`] is doing with the row.
///
/// Two values and no `From<&str>`, for the reason `sessions::Latch` states
/// about its own closed set: the difference between reading a token and
/// spending one is not a flag somebody should be able to compute from a
/// string.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TokenUse {
    /// The redemption itself, which may record a token presented after its
    /// expiry.
    Spend,
    /// A question about the token. Writes nothing at all.
    Check,
}

// ---------------------------------------------------------------------------
// Rows, as this module reads them back
// ---------------------------------------------------------------------------

/// The columns every read of an `enrolment_tokens` row selects, in the order
/// [`token_row`] expects them. One constant rather than two copies of the
/// list: a column added to one query and not the other is a row read with the
/// wrong indices, which is the kind of mistake that reads as corruption.
const TOKEN_COLUMNS: &str = "id, purpose, account_id, operator_id, shell_id, issued_by, \
     issued_seq, EXTRACT(EPOCH FROM expires_at)::bigint, \
     COALESCE(EXTRACT(EPOCH FROM redeemed_at)::bigint, 0), \
     COALESCE(EXTRACT(EPOCH FROM expired_at)::bigint, 0), row_version, row_seal, token_hash";

/// One `enrolment_tokens` row and **the seal as stored**, which is returned
/// beside it rather than checked here: the caller decides what a failure to
/// verify means, and the two callers mean different things by it.
fn token_row(row: &tokio_postgres::Row) -> Result<(TokenRow, Vec<u8>), OperatorError> {
    let purpose_text: String = row.get(1);
    let stored_seal: Vec<u8> = row.get(11);
    let stored_hash: Vec<u8> = row.get(12);
    Ok((
        TokenRow {
            id: row.get(0),
            purpose: Purpose::parse(&purpose_text)
                .ok_or(OperatorError::Corrupt("enrolment token purpose"))?,
            token_hash: as_32(&stored_hash, "enrolment token hash")?,
            account_id: row.get(2),
            operator_id: row.get(3),
            shell_id: row.get(4),
            issued_by: row.get(5),
            issued_seq: row.get(6),
            expires_at_unix: row.get(7),
            redeemed_at_unix: row.get(8),
            expired_at_unix: row.get(9),
            row_version: row.get(10),
        },
        stored_seal,
    ))
}

struct TokenRow {
    id: String,
    purpose: Purpose,
    /// Read back from the row, never recomputed: the seal covers it, and the
    /// token it hashes is gone the moment it is handed out.
    token_hash: [u8; 32],
    account_id: Option<String>,
    operator_id: Option<String>,
    shell_id: Option<String>,
    issued_by: String,
    issued_seq: i64,
    expires_at_unix: i64,
    redeemed_at_unix: i64,
    expired_at_unix: i64,
    row_version: i32,
}

impl TokenRow {
    fn subject(&self) -> &str {
        match self.purpose {
            Purpose::Account => self.account_id.as_deref().unwrap_or(""),
            Purpose::Operator | Purpose::Setup => self.operator_id.as_deref().unwrap_or(""),
            Purpose::Organisation => self.shell_id.as_deref().unwrap_or(""),
        }
    }

    fn facts(&self) -> TokenFacts<'_> {
        TokenFacts {
            id: &self.id,
            purpose: self.purpose,
            token_hash: &self.token_hash,
            subject: self.subject(),
            issued_by: &self.issued_by,
            expires_at_unix: self.expires_at_unix,
            redeemed_at_unix: self.redeemed_at_unix,
            expired_at_unix: self.expired_at_unix,
        }
    }
}

/// What a token row's seal covers.
///
/// **`token_hash` is in it**, and it is re-read from the row rather than
/// recomputed: the token itself is handed out once and this server never sees
/// it again, so a seal that did not cover the hash would let a stored row be
/// repointed at a token somebody else chose.
pub struct TokenFacts<'a> {
    pub id: &'a str,
    pub purpose: Purpose,
    pub token_hash: &'a [u8; 32],
    pub subject: &'a str,
    pub issued_by: &'a str,
    pub expires_at_unix: i64,
    pub redeemed_at_unix: i64,
    pub expired_at_unix: i64,
}

struct SettingRow {
    facts: OwnedSettingFacts,
    value_ct: Vec<u8>,
    value_nonce: Vec<u8>,
    value_key_epoch: i32,
    chain_seq: i64,
    row_version: i32,
    stored_seal: Vec<u8>,
}

#[derive(Clone)]
struct OwnedSettingFacts {
    id: String,
    key: String,
    value_digest: [u8; 32],
    requested_by: String,
    request_sig: Vec<u8>,
    seconded_by: Option<String>,
    second_sig: Option<Vec<u8>>,
    single_operator: bool,
    effective_at_unix: i64,
    cancelled_at_unix: i64,
    applied_at_unix: i64,
    sealed_seq: Option<i64>,
}

impl OwnedSettingFacts {
    fn as_ref(&self) -> SettingFacts<'_> {
        SettingFacts {
            id: &self.id,
            key: &self.key,
            value_digest: &self.value_digest,
            requested_by: &self.requested_by,
            request_sig: &self.request_sig,
            seconded_by: self.seconded_by.as_deref(),
            second_sig: self.second_sig.as_deref(),
            single_operator: self.single_operator,
            effective_at_unix: self.effective_at_unix,
            cancelled_at_unix: self.cancelled_at_unix,
            applied_at_unix: self.applied_at_unix,
            sealed_seq: self.sealed_seq,
        }
    }
}

/// What a settings row's seal covers.
pub struct SettingFacts<'a> {
    pub id: &'a str,
    pub key: &'a str,
    pub value_digest: &'a [u8; 32],
    pub requested_by: &'a str,
    pub request_sig: &'a [u8],
    pub seconded_by: Option<&'a str>,
    pub second_sig: Option<&'a [u8]>,
    pub single_operator: bool,
    pub effective_at_unix: i64,
    pub cancelled_at_unix: i64,
    pub applied_at_unix: i64,
    pub sealed_seq: Option<i64>,
}

#[derive(Clone)]
struct OwnedRequestFacts {
    id: String,
    display_name: String,
    /// ADR-0055 decision 5: the colleague's address, taken at request time and
    /// inside the seal (`0022` §B).
    address: String,
    requested_by: String,
    request_sig: Vec<u8>,
    chain_seq: i64,
    seconded_by: Option<String>,
    second_sig: Option<Vec<u8>>,
    single_operator: bool,
    effective_at_unix: i64,
    cancelled_at_unix: i64,
    applied_at_unix: i64,
    sealed_seq: Option<i64>,
    created_operator_id: Option<String>,
    row_version: i32,
}

impl OwnedRequestFacts {
    fn as_ref(&self) -> OperatorRequestFacts<'_> {
        OperatorRequestFacts {
            id: &self.id,
            display_name: &self.display_name,
            address: &self.address,
            requested_by: &self.requested_by,
            request_sig: &self.request_sig,
            seconded_by: self.seconded_by.as_deref(),
            second_sig: self.second_sig.as_deref(),
            single_operator: self.single_operator,
            effective_at_unix: self.effective_at_unix,
            cancelled_at_unix: self.cancelled_at_unix,
            applied_at_unix: self.applied_at_unix,
            sealed_seq: self.sealed_seq,
            created_operator_id: self.created_operator_id.as_deref(),
        }
    }

    fn pending(&self) -> PendingChange {
        PendingChange {
            id: self.id.clone(),
            subject: self.display_name.clone(),
            requested_by: self.requested_by.clone(),
            seconded_by: self.seconded_by.clone(),
            single_operator: self.single_operator,
            effective_at_unix: self.effective_at_unix,
            applied_at_unix: self.applied_at_unix,
            cancelled_at_unix: self.cancelled_at_unix,
            sealed_seq: self.sealed_seq,
        }
    }
}

/// What an operator-request row's seal covers.
pub struct OperatorRequestFacts<'a> {
    pub id: &'a str,
    pub display_name: &'a str,
    /// ADR-0055 decision 5, `0022` §B.
    pub address: &'a str,
    pub requested_by: &'a str,
    pub request_sig: &'a [u8],
    pub seconded_by: Option<&'a str>,
    pub second_sig: Option<&'a [u8]>,
    pub single_operator: bool,
    pub effective_at_unix: i64,
    pub cancelled_at_unix: i64,
    pub applied_at_unix: i64,
    pub sealed_seq: Option<i64>,
    pub created_operator_id: Option<&'a str>,
}

/// The canonical state of an operator keyring row, for its seal. Mirrors
/// `grants`' `account_key_row_state`, with `operator_id` where `account_id`
/// was — and the table name inside the seal keeps the two apart.
fn operator_key_row_state(key: &OperatorKey) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert(
        "alg".to_string(),
        Json::Int(i64::from(authority::ALG_ES256)),
    );
    map.insert("fpr".to_string(), Json::Str(hex(&key.fpr)));
    map.insert(
        "operator_id".to_string(),
        Json::Str(key.operator_id.clone()),
    );
    map.insert("public_key".to_string(), Json::Str(hex(&key.public_key)));
    map.insert("retired_at".to_string(), Json::Int(key.retired_at_unix));
    Json::Obj(map).to_canonical_bytes()
}

async fn read_operator(tx: &Transaction<'_>, id: &str) -> Result<Option<Operator>, OperatorError> {
    let row = tx
        .query_opt(
            "SELECT id, display_name, created_by, created_seq, \
                    COALESCE(EXTRACT(EPOCH FROM first_independent_signin_at)::bigint, 0), \
                    COALESCE(EXTRACT(EPOCH FROM disabled_at)::bigint, 0), row_version \
               FROM operators WHERE id = $1",
            &[&id],
        )
        .await?;
    Ok(row.map(|row| Operator {
        id: row.get(0),
        display_name: row.get(1),
        created_by: row.get(2),
        created_seq: row.get(3),
        first_independent_signin_at_unix: row.get(4),
        disabled_at_unix: row.get(5),
        row_version: row.get(6),
        // **Not read here**, deliberately: this function is on the sign-in
        // and act paths, where the binding is not needed and where joining
        // `accounts` would need a custody those transactions do not take.
        // `list_operators` is where the address is read, under the custody
        // that admits it. ADR-0055 stream (b).
        address: None,
    }))
}

// ---------------------------------------------------------------------------
// ADR-0055 stream (b) -- the operator custody an account holds
//
// `docs/decisions/adr-0055-one-person-two-custodies.md` decisions 1, 3, 4, 5,
// 7 and 8; `migrations/0019_operator_account_binding.sql` for the binding and
// the floor, `0021_operator_seat_hold.sql` for the hold, `0022_...` for the
// quorum and the new entry types.
// ---------------------------------------------------------------------------

/// **How many operators could actually second something**, inside a
/// transaction that is already holding the operator custody.
///
/// ADR-0055 decision 3 with the lead's resolution 9 (2026-09-21): not disabled,
/// with an independent sign-in on record, and that sign-in older than
/// [`INDEPENDENCE_WINDOW`].
///
/// **Three of `0015` §G's four clauses, and not the quorum.** Until ADR-0055
/// fix (c) this doc claimed the three were *"exactly what
/// `fathom_seconder_is_independent` will accept as a seconder"*, which was
/// false: the trigger also refuses a seconder the requester created
/// (`0015_operator_console.sql`:719), and that clause is per requester. The
/// quorum is [`quorum_for`]; this count is the deployment-wide fact decision
/// 4's *"two operators is the standing expectation"* banner reports, where
/// the requester is nobody in particular.
///
/// **The SQL says it, not a filter in Rust**, because the count has to be a
/// snapshot of the same transaction the act commits in -- `0014` finding 3's
/// rule that verification and authorisation share a snapshot.
pub async fn live_independent_operators(tx: &Transaction<'_>) -> Result<i64, OperatorError> {
    let count: i64 = tx
        .query_one(
            "SELECT count(*) FROM operators \
              WHERE disabled_at IS NULL \
                AND first_independent_signin_at IS NOT NULL \
                AND first_independent_signin_at <= now() - make_interval(secs => $1::double precision)",
            &[&(INDEPENDENCE_WINDOW.as_secs() as f64)],
        )
        .await?
        .get(0);
    Ok(count)
}

/// **How many operators could second a request made by `requester`** — all
/// four of `0015` §G's clauses, in the transaction the act commits in.
///
/// The fourth clause, `seconder_created_by = requested_by`
/// (`0015_operator_console.sql`:719), is the one
/// [`live_independent_operators`] leaves out, and leaving it out is what made
/// the quorum demand a signature the database refuses to store. See
/// [`Operator::is_eligible_to_second`] for the deadlock it produced on the
/// deployment shape ADR-0055 decision 5 calls standing.
///
/// `id <> requester` as well, because §5.5 and `operator_requests`' own CHECK
/// both refuse a requester seconding themselves — the trigger does not test
/// it, so counting the requester here would have been the same deadlock one
/// operator smaller.
/// **Every row in the register is verified, and then the predicate is applied
/// in Rust** — ADR-0055 fix (d), which is what makes bringing
/// `first_independent_signin_at` inside [`operator_row_seal`] mean anything.
///
/// `0015_operator_console.sql`:162 grants `fathom_app`
/// `UPDATE (first_independent_signin_at)` and the `operators` write policy's
/// `WITH CHECK` is only the two custodies, so moving that column is inside the
/// APPLICATION role, not only inside tier 3. Decision 3 then made the column
/// decide whether a second signature is required at all.
///
/// **Not "verify the candidates the SQL selected", which was the first shape
/// of this function and was wrong.** The attack is not adding a seconder, it
/// is REMOVING one: clear `first_independent_signin_at` (or set `disabled_at`)
/// on everybody and the quorum falls to 1, and a filter that verifies only the
/// rows it selected never looks at the row that was edited out of the
/// selection. So every row is read and verified, and the four clauses are
/// applied to the verified form. A row that does not verify is an alarm and
/// not a skipped candidate, for `live_operator_keys`' reason.
///
/// The register is small — operators are people, and decision 4 says two — so
/// this is a handful of row seals and chain entries on the request, second and
/// apply paths, and on no per-request path at all.
pub async fn eligible_seconders_for(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    requester: &str,
) -> Result<i64, OperatorError> {
    let rows = tx
        .query("SELECT id FROM operators ORDER BY id", &[])
        .await?;
    let now = now_unix();
    let mut count = 0i64;
    for row in &rows {
        let id: String = row.get(0);
        let operator = verify_operator_row(tx, ring, &id).await?;
        if operator.is_eligible_to_second(requester, now) {
            count += 1;
        }
    }
    Ok(count)
}

/// **The quorum for a request made by `requester`**: `min(2, 1 + eligible
/// seconders)` — ADR-0055 decision 3, made per requester by fix (c).
///
/// One is the requester's own signature, which they have already given. Two
/// only when somebody exists who can actually give the second; when nobody
/// can, the answer is 1 and the request stands alone, with the delay.
pub async fn quorum_for(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    requester: &str,
) -> Result<i64, OperatorError> {
    Ok((1 + eligible_seconders_for(tx, ring, requester).await?).min(2))
}

/// Is this `0015` §G's seconder trigger refusing, rather than any other
/// database error?
///
/// `fathom_seconder_is_independent` raises five different sentences and every
/// one of them ends `(admin design 5.5)`, which is the stable fragment —
/// `is_operator_floor` matches its trigger the same way and gives the reason.
/// Before ADR-0055 fix (c) a refusal here fell through `admin.rs`'s `other`
/// arm and reached the operator as a 500 `Corrupt("operator plane")`: an
/// integrity alarm for a rule the deployment was correctly applying.
fn is_seconder_refusal(e: &tokio_postgres::Error) -> bool {
    match e.as_db_error() {
        Some(db) => db.message().contains("(admin design 5.5)"),
        None => false,
    }
}

/// The bytes an `operator_account_bindings` row's seal covers.
///
/// Two fields and no more, because the row has two facts: which operator, and
/// which account. `bound_at` is outside it because it is a timestamp the row
/// does not claim anything by -- unlike `first_independent_signin_at`, which
/// ADR-0055 decision 3 turned into an authority fact and fix (d) therefore
/// brought inside the `operators` seal -- and `bound_seq` is
/// inside the seal through [`RowFacts::chain_seq`], as every other row in this
/// module binds its creating entry.
fn binding_row_state(operator: &str, account: &str) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("account_id".to_string(), Json::Str(account.to_string()));
    map.insert("operator_id".to_string(), Json::Str(operator.to_string()));
    Json::Obj(map).to_canonical_bytes()
}

/// Is this the `0019` §C floor trigger refusing, rather than any other
/// database error?
///
/// `RAISE EXCEPTION` in PL/pgSQL arrives as `SQLSTATE P0001` with the message
/// the trigger wrote, and the message is the only thing that distinguishes it
/// from every other `RAISE` in this schema. Matched on a stable fragment of
/// `0019` §C's own sentence rather than on the whole of it, so that an edit to
/// the punctuation does not silently turn a typed refusal back into
/// `Corrupt("operator plane")`.
fn is_operator_floor(e: &tokio_postgres::Error) -> bool {
    match e.as_db_error() {
        Some(db) => db.message().contains("disabling the last live operator"),
        None => false,
    }
}

impl OperatorStore {
    // -----------------------------------------------------------------------
    // The binding
    // -----------------------------------------------------------------------

    /// The account at this address, **created if there is none**, and its id.
    ///
    /// ADR-0055 decision 1: an operator has an address, and the address is an
    /// account. Two callers: the first start (the notice address) and
    /// `apply_operator_request` (the colleague's). Both run under
    /// `app.account_custody` as well as the operator custody, because
    /// `accounts_readable` (`0013` §A) admits the first and not the second.
    ///
    /// **An account that already exists is used, not duplicated.** One person,
    /// two custodies, one address (decision 1) -- a colleague who is already a
    /// steward here gets the operator custody on the account they already
    /// have, which is the whole shape of the decision and also what
    /// `accounts.email`'s own uniqueness would force anyway.
    ///
    /// The account is a SHELL: no key, no membership, no credential. §6.4's
    /// *"a steward signs a grant naming a subject who already has a registered
    /// key"* is what stops this being a route to authority.
    async fn account_for_address(
        &self,
        tx: &Transaction<'_>,
        address: &str,
        display_name: &str,
        created_by: &str,
    ) -> Result<String, OperatorError> {
        if let Some(row) = tx
            .query_opt("SELECT id FROM accounts WHERE email = $1", &[&address])
            .await?
        {
            return Ok(row.get(0));
        }

        let account = AccountId::new().to_string();
        chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            EntryType::AccountCreated,
            &entry_metadata(
                EntryType::AccountCreated,
                &[
                    ("account", Json::Str(account.clone())),
                    ("operator", Json::Str(created_by.to_string())),
                    // Inside the SEALED metadata, exactly as
                    // `create_account_shell` records one.
                    ("address", Json::Str(address.to_string())),
                    ("display_name", Json::Str(display_name.to_string())),
                    ("reason", Json::Str("operator_custody".to_string())),
                ],
            ),
        )
        .await?;

        // `0004`: the principal row before the account row, because the
        // composite key that makes an operator id unrepresentable in a
        // membership runs through it.
        tx.execute(
            "INSERT INTO principals (id, kind) VALUES ($1, 'steward')",
            &[&account],
        )
        .await?;
        tx.execute(
            "INSERT INTO accounts (id, email, display_name) VALUES ($1, $2, $3)",
            &[&account, &address, &display_name],
        )
        .await?;
        Ok(account)
    }

    /// Write the sealed fact that this operator's custody is held by this
    /// account (`0019` §A).
    ///
    /// Append-only and written once: `0019`'s trigger refuses an `UPDATE` or a
    /// `DELETE` on this table at every privilege level including the table's
    /// owner, and the seal is what a tier-3 attacker cannot forge. A handoff
    /// never rewrites a binding -- the successor gets a new operator row and a
    /// new binding, and the predecessor's row is disabled (decision 5).
    async fn bind_operator_to_account(
        &self,
        tx: &Transaction<'_>,
        operator: &str,
        account: &str,
        bound_seq: i64,
    ) -> Result<(), OperatorError> {
        let seal = self
            .binding_seal(tx, operator, account, bound_seq, 1)
            .await?;
        tx.execute(
            "INSERT INTO operator_account_bindings \
                 (operator_id, account_id, bound_seq, row_version, row_seal) \
             VALUES ($1, $2, $3, 1, $4)",
            &[&operator, &account, &bound_seq, &seal.to_vec()],
        )
        .await?;
        Ok(())
    }

    async fn binding_seal(
        &self,
        tx: &Transaction<'_>,
        operator: &str,
        account: &str,
        bound_seq: i64,
        row_version: i32,
    ) -> Result<[u8; 32], OperatorError> {
        Ok(authority::row_seal(
            &grants::site_row_key(tx, &self.ring).await?,
            &RowFacts {
                table: "operator_account_bindings",
                row_id: operator,
                chain_seq: bound_seq,
                row_version,
                row_state: &binding_row_state(operator, account),
            },
        ))
    }

    /// The binding's own interlock: the row seals, or nothing rests on it.
    ///
    /// Called wherever a binding decides something -- which seat a recovery
    /// restores, which operator an account may register a key for. A row
    /// hand-inserted by whoever holds the database fails here, which is what
    /// stops the binding being a way to attach an operator custody to an
    /// account that was never given one.
    async fn verify_binding(
        &self,
        tx: &Transaction<'_>,
        operator: &str,
        account: &str,
    ) -> Result<(), OperatorError> {
        let row = tx
            .query_opt(
                "SELECT bound_seq, row_version, row_seal FROM operator_account_bindings \
                  WHERE operator_id = $1 AND account_id = $2",
                &[&operator, &account],
            )
            .await?;
        let Some(row) = row else {
            return Err(OperatorError::NotBoundToAnOperator);
        };
        let bound_seq: i64 = row.get(0);
        let row_version: i32 = row.get(1);
        let stored: Vec<u8> = row.get(2);
        let recomputed = self
            .binding_seal(tx, operator, account, bound_seq, row_version)
            .await?;
        if stored != recomputed {
            return Err(OperatorError::Unverifiable("operator account binding seal"));
        }
        Ok(())
    }

    /// Which operator custody does this account hold, if any?
    ///
    /// The binding's seal is verified before the answer is believed, and a
    /// disabled or unverifiable operator answers `NotBoundToAnOperator` --
    /// one refusal for several causes, [`OperatorError::EnrolmentRefused`]'s
    /// argument: a caller who could tell them apart could probe the register.
    pub async fn operator_of_account(
        &self,
        tx: &Transaction<'_>,
        account: &str,
    ) -> Result<String, OperatorError> {
        let row = tx
            .query_opt(
                "SELECT operator_id FROM operator_account_bindings WHERE account_id = $1",
                &[&account],
            )
            .await?;
        let Some(row) = row else {
            return Err(OperatorError::NotBoundToAnOperator);
        };
        let operator: String = row.get(0);
        self.verify_binding(tx, &operator, account).await?;
        let live = verify_operator_row(tx, &self.ring, &operator).await?;
        if live.disabled_at_unix != 0 {
            return Err(OperatorError::NotBoundToAnOperator);
        }
        Ok(operator)
    }

    // -----------------------------------------------------------------------
    // ADR-0055 decision 1 -- the operator key a browser registers
    // -----------------------------------------------------------------------

    /// **`POST /admin/operators/self/key`**: the account signed in at this
    /// browser registers an operator key for it.
    ///
    /// ADR-0055 decision 1 with the lead's resolution 8 (2026-09-21): there is
    /// no separate operator sign-in any more. A person signs in with their
    /// address, their credential and their app code; if their account holds
    /// the operator custody, this is how the browser gets the key every
    /// operator act is signed with (`verify_operator_assertion`). Decision 6's
    /// *"any browser, no pairing"*: a second browser registers a second key
    /// and both stay live, which is why `live_operator_keys` has no `LIMIT 1`.
    ///
    /// # What it checks, in order
    ///
    /// 1. **A steward session.** The acting principal is an account, not an
    ///    operator: an operator principal has no account binding of its own,
    ///    and a route that took one would be a route that let an operator
    ///    session mint itself a second key.
    /// 2. **Not the setup-only session, AND a confirmed app code on the
    ///    account.** Resolution 1: an account holding the operator custody
    ///    with no app code enrolled gets an `A0` session that reaches
    ///    `/credentials/*` and nothing else. Registering the key every
    ///    operator act is signed with is emphatically not the setup screen.
    ///    ADR-0055 fix (g), 2026-09-21: the assurance check is not enough by
    ///    itself, because an account with one live browser key reaches this
    ///    route at `A1` with no app code ever enrolled — see the check itself
    ///    for the whole of it.
    /// 3. **A live, sealed binding**, and an operator row that verifies and is
    ///    not disabled.
    /// 4. **The seat is not held.** `accounts.operator_key_hold_until`
    ///    (`0021`, ADR-0055 decision 7): if a mailed reset set the credential
    ///    on this account, the operator seat waits for another operator's
    ///    confirmation or for the 24 hours to run out. Without this check the
    ///    reset would restore the seat by itself, which is exactly what
    ///    decision 7 refuses -- *"a colleague who controls the mail server
    ///    cannot reset their way into a second seat"*.
    ///
    /// The sealed entry is `operator_key_enrolled` (`0022` §C) and not
    /// `operator_enrolled`: an auditor reading the trail has to be able to
    /// tell a one-shot invitation being redeemed from somebody who knew the
    /// credential registering a key, and the entry type is the half of that
    /// which is legible without the chain key.
    ///
    /// **A note on the `via` field.** The lead's resolution 8 asks for
    /// `via=password`. The value written is the SESSION'S ASSURANCE instead --
    /// `A0T` for credential-and-app-code, `A1` for a key -- which names the
    /// same route more precisely, because an account that already holds a
    /// browser key reaches this route at `A1` and calling that route by the
    /// other name would be filing a false fact. The literal the resolution
    /// names is also a word this module's own gate test
    /// (`no_message_in_this_module_has_a_field_a_...`) forbids on a
    /// non-comment line, and weakening that test for an audit label would be
    /// the wrong trade. Reported to the lead rather than decided silently.
    pub async fn register_own_operator_key(
        &self,
        account: &VerifiedSession,
        public_key: &[u8],
    ) -> Result<OperatorKey, OperatorError> {
        if account.kind() != PrincipalKind::Steward {
            return Err(OperatorError::NotBoundToAnOperator);
        }
        if account.assurance() == Assurance::A0 {
            return Err(OperatorError::SetupSessionOnly);
        }
        check_public_key(public_key)?;
        let account_id = account.principal_id();

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // `operator_keys_insertable` (`0015` §H) names the enrolment custody,
        // because until today every operator key arrived by redemption. This
        // is the other way in, and it takes the same custody to write the same
        // table rather than widening the policy: what authorises it is the
        // verified session and the sealed binding above, checked here.
        enter_enrolment_custody(&tx).await?;
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;

        let operator = self.operator_of_account(&tx, &account_id).await?;

        // **ADR-0055 fix (g): the app code, not the assurance.**
        //
        // The gate above is `assurance == A0`, and an account that holds the
        // operator custody with ONE live account key escapes it entirely:
        // password plus a key signature is `A1`, so
        // `sessions::verify_request`'s setup-only check does not run and this
        // one passes — and that person registers the operator key every
        // operator act is signed with, having never enrolled the app code
        // decision 10 calls **Required for any account holding the operator
        // custody**. The state is reachable with no database access at all:
        // `account_for_address` REUSES an account that already exists at the
        // address, and an ordinary steward may register a browser key, so any
        // existing keyed steward promoted to operator lands in it.
        //
        // So the question asked here is the account's, not the session's:
        // `totp_last_step IS NOT NULL` is what `CredentialRow::totp_confirmed`
        // reads, and it is NULL until a real six-digit code has been accepted
        // once (`credentials::confirm_totp`).
        let confirmed_app_code: bool = tx
            .query_opt(
                "SELECT totp_last_step IS NOT NULL FROM accounts WHERE id = $1",
                &[&account_id],
            )
            .await?
            .map(|row| row.get(0))
            .unwrap_or(false);
        if !confirmed_app_code {
            return Err(OperatorError::SetupSessionOnly);
        }

        let hold: Option<i64> = tx
            .query_opt(
                "SELECT EXTRACT(EPOCH FROM operator_key_hold_until)::bigint FROM accounts \
                  WHERE id = $1",
                &[&account_id],
            )
            .await?
            .and_then(|row| row.get(0));
        if let Some(until) = hold {
            if until > now_unix() {
                return Err(OperatorError::SeatHeld);
            }
        }

        let fpr = authority::key_fingerprint(public_key);
        let key_id = ids::new_ulid().to_string();
        let enrolled = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorKeyEnrolled,
            &entry_metadata(
                EntryType::OperatorKeyEnrolled,
                &[
                    ("operator", Json::Str(operator.clone())),
                    ("account", Json::Str(account_id.clone())),
                    ("key", Json::Str(key_id.clone())),
                    ("fpr", Json::Str(hex(&fpr))),
                    ("key_source", Json::Str("software".to_string())),
                    ("principal_kind", Json::Str("operator".to_string())),
                    ("session", Json::Str(account.id().to_string())),
                    // See this function's doc comment: the assurance IS the
                    // route, and it is the honest form of the field the lead
                    // asked for.
                    ("via", Json::Str(account.assurance().as_str().to_string())),
                ],
            ),
        )
        .await?;

        let key = OperatorKey {
            id: key_id.clone(),
            operator_id: operator.clone(),
            public_key: public_key.to_vec(),
            fpr,
            enrolled_seq: enrolled.seq,
            row_version: 1,
            retired_at_unix: 0,
        };
        let seal = authority::row_seal(
            &grants::site_row_key(&tx, &self.ring).await?,
            &RowFacts {
                table: "operator_keys",
                row_id: &key_id,
                chain_seq: enrolled.seq,
                row_version: 1,
                row_state: &operator_key_row_state(&key),
            },
        );
        tx.execute(
            "INSERT INTO operator_keys \
                 (id, operator_id, key_source, public_key, alg, fpr, enrolled_seq, row_version, \
                  row_seal) \
             VALUES ($1, $2, 'software', $3, $4, $5, $6, 1, $7)",
            &[
                &key_id,
                &operator,
                &public_key.to_vec(),
                &authority::ALG_ES256,
                &fpr.to_vec(),
                &enrolled.seq,
                &seal.to_vec(),
            ],
        )
        .await?;

        tx.execute("SELECT set_config('app.account_custody', 'no', true)", &[])
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(key)
    }

    /// **`POST /admin/operators/{operator}/confirm-recovery`**: another
    /// operator clears the seat hold early.
    ///
    /// ADR-0055 decision 7: an account whose credential was reset by mail *"does
    /// not restore that custody by itself: the seat waits for another
    /// operator's confirmation or the 24-hour delay with notice to every
    /// operator"*. This is the confirmation half. The delay half needs nothing
    /// -- [`OperatorStore::register_own_operator_key`] reads the clock.
    ///
    /// **Not the operator's own seat.** The colleague decision 7 is worried
    /// about is the one who controls the mail server; letting them confirm
    /// their own recovery would be the control confirming itself.
    pub async fn confirm_recovery(
        &self,
        operator: &VerifiedSession,
        target: &str,
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;
        if acting == target {
            return Err(OperatorError::Malformed("operator to confirm"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        self.check_operator_live(&tx, &acting).await?;
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;

        let row = tx
            .query_opt(
                "SELECT account_id FROM operator_account_bindings WHERE operator_id = $1",
                &[&target],
            )
            .await?;
        let Some(row) = row else {
            return Err(OperatorError::NotBoundToAnOperator);
        };
        let account: String = row.get(0);
        self.verify_binding(&tx, target, &account).await?;
        verify_operator_row(&tx, &self.ring, target).await?;

        chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorSeatHoldCleared,
            &entry_metadata(
                EntryType::OperatorSeatHoldCleared,
                &[
                    ("operator", Json::Str(target.to_string())),
                    ("account", Json::Str(account.clone())),
                    ("by", Json::Str(acting)),
                    ("session", Json::Str(operator.id().to_string())),
                ],
            ),
        )
        .await?;

        tx.execute(
            "UPDATE accounts SET operator_key_hold_until = NULL WHERE id = $1",
            &[&account],
        )
        .await?;
        // The hold is inside the credential seal (migration 0025): re-seal in
        // the transaction that cleared it.
        crate::credentials::reseal_credentials(&tx, &self.ring, &account, None)
            .await
            .map_err(credential_failure)?;

        tx.execute("SELECT set_config('app.account_custody', 'no', true)", &[])
            .await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // ADR-0055 decisions 4 and 8 -- what the console has to say out loud
    // -----------------------------------------------------------------------

    /// **`GET /admin/notices`**: the standing facts an operator session has to
    /// show, derived from the chain and the register.
    ///
    /// The lead's resolution 6 (2026-09-21): *"the seven-day 'recovered from
    /// host' banner and the one-operator fact are derived from the chain and
    /// the register, served by `GET /admin/notices` as LP-framed lines; no new
    /// storage."* That closes the contracts document's open issue 6, which
    /// asked where the banner state should live: nowhere. A column somebody
    /// could clear is a banner somebody could clear, and the two facts this
    /// answers are both about somebody having done something they should not
    /// be able to hide.
    ///
    /// One line per notice, space-separated, in the shape `list_operators`
    /// already uses:
    ///
    /// - `recovered_from_host <at_unix> <until_unix>` — ADR-0055 decision 8's
    ///   seven-day banner. Present while an `operator_recovered_from_host`
    ///   entry lies inside [`RECOVERY_BANNER_WINDOW`], **measured by the time
    ///   inside that entry's own seal and not by `chain_entries.created_at`**,
    ///   which nothing seals (ADR-0055 fix (e)). **The entry is verified
    ///   before it is reported**, so a row inserted by whoever holds the
    ///   database cannot raise a banner, and a row whose seal was broken to
    ///   suppress one is an alarm rather than a silence — which is now true
    ///   of a row whose `created_at` was moved as well, because the newest
    ///   entry of the type is selected whatever its `created_at` says.
    /// - `one_operator <live_independent> <weeks_since_install>` — decision
    ///   4's standing banner, which *"escalates weekly"* and *"never blocks
    ///   work"*. The escalation number is weeks since this deployment's own
    ///   `operator_bootstrapped` entry, and it is that rather than "weeks
    ///   spent with one operator" for an honest reason: nothing stores the
    ///   history of the count, and inventing one to make a banner shout louder
    ///   would be storage this resolution just said not to add.
    pub async fn notices(&self) -> Result<Vec<String>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;

        let mut out = Vec::new();
        let now = now_unix();

        // **ADR-0055 fix (e): the newest entry of this type, whatever its
        // `created_at` says, verified, and then the SEALED time.**
        //
        // This used to filter `created_at > window_start` in the SELECT and
        // verify afterwards, while the comment above promised that *"a row
        // whose seal was broken to suppress one is an alarm rather than a
        // silence"*. `created_at` is not in `chains::append_site`'s content
        // hash or seal, so a row moved eight days into the past was simply
        // not selected: the verification never ran and the banner went quiet
        // with nothing raised. (It needs a database owner -- `fathom_app`
        // holds only SELECT and INSERT on `chain_entries` -- but the comment
        // made a claim the code did not support.)
        //
        // So the row is selected by seq alone, verified, and the window is
        // measured against the `at` the entry's own sealed metadata carries.
        // A row of this type with no sealed `at` is an ALARM: the field is
        // written by the only code that appends this entry type, which landed
        // with the entry type itself in this unreleased build, so an entry
        // without it is an entry this server did not write.
        let recovered = tx
            .query_opt(
                "SELECT seq FROM chain_entries \
                  WHERE chain_kind = 'site' AND entry_type = $1 \
                  ORDER BY seq DESC LIMIT 1",
                &[&EntryType::OperatorRecoveredFromHost.as_str()],
            )
            .await?;
        if let Some(row) = recovered {
            let seq: i64 = row.get(0);
            let entry = chains::read_site_entry_verified(&tx, &self.ring, seq)
                .await
                .map_err(|_| OperatorError::Unverifiable("host recovery entry"))?;
            let Some(entry) = entry else {
                return Err(OperatorError::Unverifiable("host recovery entry"));
            };
            if entry.entry_type != EntryType::OperatorRecoveredFromHost {
                return Err(OperatorError::Unverifiable("host recovery entry"));
            }
            let at = sealed_int(&entry.metadata, "at")?;
            if at + RECOVERY_BANNER_WINDOW.as_secs() as i64 > now {
                out.push(format!(
                    "recovered_from_host {at} {}",
                    at + RECOVERY_BANNER_WINDOW.as_secs() as i64
                ));
            }
        }

        let live = live_independent_operators(&tx).await?;
        if live.min(2) < 2 {
            let installed: Option<i64> = tx
                .query_opt(
                    "SELECT EXTRACT(EPOCH FROM min(created_at))::bigint FROM chain_entries \
                      WHERE chain_kind = 'site' AND entry_type = $1",
                    &[&EntryType::OperatorBootstrapped.as_str()],
                )
                .await?
                .and_then(|row| row.get(0));
            let weeks = match installed {
                Some(at) if now > at => (now - at) / (7 * 24 * 60 * 60),
                _ => 0,
            };
            out.push(format!("one_operator {live} {weeks}"));
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// The transaction-local capabilities, and small helpers
// ---------------------------------------------------------------------------

/// Turn on `app.operator_custody` for the rest of this transaction (`0015`
/// §H).
///
/// The mirror of `sessions::enter_session_custody` and
/// `repo::enter_key_custody`, including that it sets `app.design_capability` to
/// its refusal first: **an operator transaction has no business reading a
/// design payload** (§1.3), and the setting every payload policy reads is
/// closed before the one this needs is opened.
pub(crate) async fn enter_operator_custody(tx: &Transaction<'_>) -> Result<(), OperatorError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute(
        "SELECT set_config('app.operator_custody', 'yes', true)",
        &[],
    )
    .await?;
    Ok(())
}

/// Turn on `app.enrolment_custody`: the REDEMPTION path, which has no session
/// at all because the whole point of the act is to give its caller the key a
/// session would need.
///
/// Deliberately a second capability rather than a wider use of the first: an
/// unauthenticated caller must not reach the tables the console writes.
pub(crate) async fn enter_enrolment_custody(tx: &Transaction<'_>) -> Result<(), OperatorError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute(
        "SELECT set_config('app.enrolment_custody', 'yes', true)",
        &[],
    )
    .await?;
    Ok(())
}

/// Close both again before the transaction commits, so a connection handed
/// back to the pool carries nothing. `set_config(..., true)` already scopes
/// them to the transaction; this is the second statement of the same rule.
pub(crate) async fn leave_custody(tx: &Transaction<'_>) -> Result<(), OperatorError> {
    tx.execute("SELECT set_config('app.operator_custody', 'no', true)", &[])
        .await?;
    tx.execute(
        "SELECT set_config('app.enrolment_custody', 'no', true)",
        &[],
    )
    .await?;
    Ok(())
}

/// Name the acting account for the policies that show an account its own rows.
/// The value always comes from a row this server read — here, from the token —
/// never from a caller.
async fn set_account_id(tx: &Transaction<'_>, account: &str) -> Result<(), OperatorError> {
    tx.execute("SELECT set_config('app.account_id', $1, true)", &[&account])
        .await?;
    Ok(())
}

fn check_public_key(public_key: &[u8]) -> Result<(), OperatorError> {
    if public_key.len() != authority::PUBLIC_KEY_LEN || public_key[0] != 4 {
        return Err(OperatorError::Malformed("public key"));
    }
    Ok(())
}

/// 32 bytes from the OS CSPRNG — the one generator this server draws from.
fn random_32() -> Result<[u8; 32], OperatorError> {
    Ok(*Key32::random()
        .map_err(|_| OperatorError::Corrupt("random source"))?
        .expose())
}

/// **One integer field out of a verified entry's sealed metadata** —
/// ADR-0055 fix (e).
///
/// The module's usual trick, [`contains`], re-renders the one pair it wants
/// and searches the canonical bytes for it: enough to ask *"does the entry
/// say X?"* and useless for *"what does the entry say?"*. Reading a time the
/// banner has to compare against a clock is the second question, so the
/// metadata is parsed — with `fathom_canon`'s own parser, which is what
/// `grants::verify_genesis_set` already does with `org_genesis`, and not a
/// second one written here.
///
/// A missing or wrongly-typed field is [`OperatorError::Unverifiable`] and
/// not a default: the entry was written by this server or it was not.
fn sealed_int(metadata: &[u8], field: &'static str) -> Result<i64, OperatorError> {
    let parsed = Json::parse_canonical(metadata)
        .map_err(|_| OperatorError::Unverifiable("entry metadata"))?;
    let Json::Obj(map) = parsed else {
        return Err(OperatorError::Unverifiable("entry metadata"));
    };
    match map.get(field) {
        Some(Json::Int(value)) => Ok(*value),
        _ => Err(OperatorError::Unverifiable("entry metadata")),
    }
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn as_32(bytes: &[u8], what: &'static str) -> Result<[u8; 32], OperatorError> {
    bytes.try_into().map_err(|_| OperatorError::Corrupt(what))
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len().max(1))
        .any(|window| window == needle)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before 1970")
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_list_names_every_label_this_module_uses() {
        for label in [
            TAG_ENROLMENT_TOKEN,
            KDF_SITE_SETTINGS,
            AAD_SITE_SETTINGS,
            TAG_SETTING_REQUEST,
            TAG_SETTING_SECOND,
            TAG_OPERATOR_REQUEST,
            TAG_OPERATOR_SECOND,
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
    fn every_label_this_module_introduces_is_versioned() {
        for (name, _) in LABELS {
            assert!(name.starts_with("fathom/"), "{name}");
            assert!(name.ends_with("/v1"), "{name}");
        }
    }

    #[test]
    fn the_signed_messages_change_with_every_field_they_cover() {
        let base = setting_request_bytes("D", "OP", "smtp", b"value");
        for variant in [
            setting_request_bytes("E", "OP", "smtp", b"value"),
            setting_request_bytes("D", "OQ", "smtp", b"value"),
            setting_request_bytes("D", "OP", "shipper", b"value"),
            setting_request_bytes("D", "OP", "smtp", b"other"),
        ] {
            assert_ne!(base, variant);
        }

        let second = setting_second_bytes("D", "OP", "C", "smtp", &[1u8; 32]);
        for variant in [
            setting_second_bytes("E", "OP", "C", "smtp", &[1u8; 32]),
            setting_second_bytes("D", "OQ", "C", "smtp", &[1u8; 32]),
            setting_second_bytes("D", "OP", "X", "smtp", &[1u8; 32]),
            setting_second_bytes("D", "OP", "C", "shipper", &[1u8; 32]),
            setting_second_bytes("D", "OP", "C", "smtp", &[2u8; 32]),
        ] {
            assert_ne!(second, variant);
        }

        // A request and a seconding of the same change are different bytes, so
        // one cannot be replayed as the other — which is what would let one
        // operator satisfy §5.5 twice.
        assert_ne!(
            setting_request_bytes("D", "OP", "smtp", b"value"),
            setting_second_bytes("D", "OP", "C", "smtp", &Sha256::digest(b"value").into())
        );
        assert_ne!(
            operator_request_bytes("D", "OP", "Sam", "sam@example.org"),
            operator_second_bytes("D", "OP", "R", "Sam")
        );

        // ADR-0055 decision 5: the address is covered, so two requests that
        // differ only in where the invitation goes are different bytes. A
        // signature that did not cover it would be a signature an attacker
        // holding the database could re-point at a mailbox of their own.
        assert_ne!(
            operator_request_bytes("D", "OP", "Sam", "sam@example.org"),
            operator_request_bytes("D", "OP", "Sam", "sam@example.com")
        );
    }

    #[test]
    fn the_length_prefixes_stop_two_fields_running_together() {
        assert_ne!(
            setting_request_bytes("D", "OP", "smtp", b"v"),
            setting_request_bytes("D", "OPsm", "tp", b"v")
        );
    }

    #[test]
    fn the_canonical_pair_this_module_searches_an_entry_for_is_the_shape_it_assumes() {
        // `verify_operator_row` checks that a creation entry NAMES its operator
        // by looking for the canonical `"operator":"…"` pair inside the entry's
        // own object. The slice that produces it is `whole[1..len - 2]`, which
        // is right only while `to_canonical_bytes` emits `{…}` and a trailing
        // newline — and a silently wrong slice would make that check pass on
        // everything, which is the worst failure a check can have.
        let mut map = BTreeMap::new();
        map.insert("operator".to_string(), Json::Str("OP".to_string()));
        let whole = Json::Obj(map).to_canonical_bytes();
        assert_eq!(whole.as_slice(), b"{\"operator\":\"OP\"}\n");
        assert_eq!(&whole[1..whole.len() - 2], b"\"operator\":\"OP\"");
    }

    #[test]
    fn the_substring_search_matches_only_what_is_there() {
        assert!(contains(b"aXbYc", b"Xb"));
        assert!(!contains(b"aXbYc", b"bX"));
    }

    #[test]
    fn no_message_in_this_module_has_a_field_a_password_could_arrive_in() {
        // §4.5, §5.1 and OPEN-QUESTIONS C2, checked on the source of this file
        // rather than on a type, because what must not exist is a FIELD and a
        // field that does not exist has no type to assert about.
        //
        // The test module is cut off first: this test's own name contains the
        // word, and a check that fails on the thing checking is a check that
        // gets deleted.
        let whole = include_str!("operators.rs");
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
