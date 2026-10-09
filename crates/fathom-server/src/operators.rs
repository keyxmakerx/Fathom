//! **The operator console and the enrolment path an invitation travels.**
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.1 (verbs), §1.3 (two database
//! roles; the admin pool is read-only), §4.5 (no password path on the operator
//! surface), §5.1 (reset), §5.3–§5.5 (settings and the execution interlock),
//! §6.2–§6.3 (shells, claims, the first operator), §7.2 (sealed entry types).
//! `migrations/0015` is the schema and carries the reasoning for each table and
//! privilege; `src/admin.rs` is the HTTP surface.
//!
//! # The one line that does not move
//!
//! **An operator cannot grant capability inside an organisation.** Nothing here
//! writes `memberships`, `scope_grants` or `grant_secondings`, and `0004`'s
//! composite foreign keys make an operator principal unrepresentable in any of
//! them, even for a superuser. Operators create shells, issue invitations,
//! suspend, disable, and administer the site.
//!
//! The one authority-adjacent verb §1.1 gives the operator plane, suspending a
//! scope grant, lives in `grants::suspend_grant_by_operator`: that is where every
//! act against a grant lives, and suspension only REMOVES a grant from the live
//! set. There is no operator unsuspend, here or in the schema.
//!
//! # No password on the operator surface
//!
//! §4.5: an operator session is `A1` or does not exist. There is no password
//! column, reset link or "forgot" flow, and **no field in any message this module
//! parses that a password could arrive in**. §5.1's "reset" is
//! [`OperatorStore::issue_account_enrolment`], a fresh single-use enrolment token
//! to the account's address of record. `tests/operators.rs` greps this file,
//! `admin.rs` and the wire types for the shape of a password.
//!
//! # Invite only (`docs/OPEN-QUESTIONS.md` B5, answered by the owner)
//!
//! Nobody self-registers. Every account exists because an operator created a
//! shell for an address, and every key on it because somebody redeemed a
//! single-use, expiring token naming that address. No route here creates an
//! account without a verified operator session behind it.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::{Pool, PoolError, Transaction};
use fathom_canon::Json;
use sha2::{Digest, Sha256};

use crate::authority::{self, GrantFacts, RowFacts, SignatureRefused};
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError, CHAIN_KEY_EPOCH};
use crate::crypto::{self, Key32};
use crate::grants::{self, AuthorityError, GenesisGrant};
use crate::ids;
use crate::invitations;
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
/// [`crate::sessions::LABELS`]: the table wins, and a unit test asserts every
/// label the code uses is listed here.
///
/// **No new row-seal label.** Rows sealed here go through `authority::row_seal`
/// under the site-scoped row key with the table name inside the seal (`0013`
/// departure 2): a label separates USES of one key, and one more site-scoped
/// table is not a new use.
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

/// §5.3's delay: two operators, 24 hours, and the old settings apply meanwhile,
/// so notice of the change travels the mail path the change is trying to capture.
pub const SETTINGS_DELAY: Duration = Duration::from_secs(24 * 60 * 60);

/// How long an enrolment token stays redeemable.
///
/// §1.1, §6.2 and §6.3 give no number. Seventy-two hours survives a weekend and a
/// mail queue and is short enough that a token from an old mailbox is worthless.
/// A constant, not a setting: a setting could be lengthened through the
/// machinery §5.3 exists to slow down.
pub const ENROLMENT_TOKEN_LIFETIME: Duration = Duration::from_secs(72 * 60 * 60);

/// The prefix the bootstrap token file carries before the hex (`main.rs`'s
/// `write_bootstrap_token`). It says which door the token is for. The client's
/// `parseToken` reads `op_` as the operator plane and `inv_` (which the console
/// puts before account invitations) as the account plane; wire bytes carry no
/// prefix. A bare-hex token with no address typed is treated as an operator's.
pub const BOOTSTRAP_TOKEN_PREFIX: &str = "op_";

// ---- ADR-0055 stream (b) --------------------------------------------------

/// **Ten minutes**, for the setup code `fathom-server recover-operator` prints to
/// a terminal (ADR-0055 decision 8).
///
/// Short because it is read off a screen by the person who just ran the command,
/// not mailed. Deliberately NOT [`ENROLMENT_TOKEN_LIFETIME`], whose seventy-two
/// hours exist to survive a mail queue.
pub const RECOVERY_SETUP_TOKEN_LIFETIME: Duration = Duration::from_secs(10 * 60);

/// **Seven days**, the window ADR-0055 decision 8 banners every operator session
/// after a host recovery.
///
/// Derived from the site chain, never stored: [`OperatorStore::notices`] asks
/// whether an `operator_recovered_from_host` entry landed inside it. A column
/// could be cleared.
pub const RECOVERY_BANNER_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// **Seven days**, the seconder-independence window `0015_operator_console.sql`
/// §G pins in `fathom_seconder_is_independent`.
///
/// ADR-0055 decision 3's quorum must agree with it: live independent operators
/// are those not disabled whose `first_independent_signin_at` is older than this
/// window, so quorum never demands a seconder who cannot second (a quorum
/// counting an operator the trigger would refuse can never be met).
///
/// **The literal is in two places and has to be**: SQL cannot read a Rust
/// constant, and the quorum is computed here.
/// `the_quorum_window_matches_the_trigger` in `tests/operators.rs` reads the
/// trigger's source and asserts they agree.
pub const INDEPENDENCE_WINDOW: Duration = Duration::from_secs(7 * 24 * 60 * 60);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything the operator plane refuses, and why.
///
/// **[`OperatorError::EnrolmentRefused`] is deliberately one variant for several
/// causes** (never issued, redeemed, expired, wrong address, row seal fails). A
/// caller who could tell them apart could probe for live tokens and existing
/// addresses. The sealed entry carries the real reason, readable by an operator
/// and not by an attacker.
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
    /// sealed entry it names does not: the store is not telling the truth about
    /// itself. **Not a permission error** (§3.4) and must never render as one.
    Unverifiable(&'static str),
    /// An enrolment token was refused. One variant for every cause.
    EnrolmentRefused,
    /// A signature by the acting operator's enrolled key was refused.
    Signature(SignatureRefused),
    /// This operator has no key enrolled, so there is nothing to verify an
    /// assertion against. §4.5: there is no weaker factor to fall back to.
    NoOperatorKey,
    /// §5.5: the seconder may not be the requester. The database also refuses (a
    /// `CHECK` and a `SECURITY DEFINER` trigger); this refuses first so the caller
    /// gets a sentence, not a constraint name.
    SecondedByTheRequester,
    /// `0015` §G's `fathom_seconder_is_independent` refused this seconder:
    /// disabled, created by the requester, no independent sign-in on record, or
    /// that sign-in is newer than [`INDEPENDENCE_WINDOW`]. **A rule, not an alarm.**
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
    /// **An operator key is enrolled, so the first operator's enrolment token
    /// cannot be re-issued** (see [`OperatorStore::reissue_bootstrap_token`]).
    ///
    /// The refusal is the control: a re-issue that worked after enrolment would
    /// let anyone who can run a command on the host mint themselves an operator
    /// session without holding any known key.
    AlreadyEnrolled,
    // ---- ADR-0055 stream (b) ------------------------------------------
    /// The acting account holds no operator custody: no `operator_account_bindings`
    /// row names it (ADR-0055 decision 1), or the binding names a disabled operator.
    NotBoundToAnOperator,
    /// `accounts.operator_key_hold_until` (`0021`) is in the future: the credential
    /// was reset, and ADR-0055 decision 7 does not let a reset restore the
    /// operator seat by itself. Another operator confirms it, or the hold runs out.
    SeatHeld,
    /// `0019` §C's floor: disabling this operator would leave none, and the only
    /// way back is the key volume.
    LastLiveOperator,
    /// The setup-only session ADR-0055 decision 1 gives an account holding the
    /// operator custody that has not enrolled an app code. It reaches the
    /// credential routes and nothing else.
    SetupSessionOnly,
    /// **An `operators` row verifies under no row-state shape any build has
    /// written**, so this server did not write it.
    ///
    /// Produced only by [`OperatorStore::reseal_legacy_operator_rows`]; every other
    /// reader uses [`verify_operator_row`], which knows only the current shape and
    /// answers [`OperatorError::Unverifiable`]. It carries the operator id because
    /// the start-time re-seal is where naming the row makes the refusal actionable.
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
            // useless in a log, and this error only reaches a log (`admin.rs`
            // answers a fixed sentence per status).
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

/// **What a failed credential read or re-seal means here.**
///
/// A transport error (lost connection, timeout, permission refusal) must not
/// render as "a stored credential seal is not consistent": an integrity alarm
/// raised by a database hiccup, on paths (`recover_operator`, the adoption) whose
/// job is to be believable when they say something is wrong. Transport errors
/// pass through; only a seal that does not verify is an alarm.
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
        // Everything else is a refusal about a password, a code or a token, and
        // none of these call sites presents one: not a database error, not an alarm.
        _ => OperatorError::Corrupt("credential row"),
    }
}

// ---------------------------------------------------------------------------
// The signed and hashed messages
// ---------------------------------------------------------------------------

/// The stored form of an enrolment token: `H(LP(tag) ‖ LP(token))`.
///
/// The token is 32 bytes from the OS CSPRNG, returned exactly once, and hashed at
/// rest so a database read hands an attacker nothing redeemable (as
/// `sessions::token_hash`).
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
/// The digest is over the setting's PLAINTEXT value, which the client has, never
/// the ciphertext whose nonce the server draws (the failure
/// `grants::propose_grant` exists to avoid). The row's `value_digest` is
/// `H(value_ct)` (§5.4), a different statement about the same change: one binds
/// what was meant, the other what was stored.
///
/// The operator id is inside the bytes so one operator's assertion cannot be
/// presented in another's session.
pub fn setting_request_bytes(deployment: &str, operator: &str, key: &str, value: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(160);
    crypto::lp(&mut msg, TAG_SETTING_REQUEST);
    crypto::lp(&mut msg, deployment.as_bytes());
    crypto::lp(&mut msg, operator.as_bytes());
    crypto::lp(&mut msg, key.as_bytes());
    crypto::lp(&mut msg, &Sha256::digest(value));
    msg
}

/// §5.5's seconding assertion: a fresh assertion over `H(change digest)`, so
/// seconding is a key touch and not a row.
///
/// ```text
/// LP("fathom/site/setting/second/v1") ‖ LP(deployment) ‖ LP(operator)
///   ‖ LP(change id) ‖ LP(key) ‖ LP(value_digest)
/// ```
///
/// The row exists by now, so the seconder signs over the row's own id and the
/// digest of the bytes actually stored: what they are agreeing to, and what
/// §5.4's resolver later checks the sealed entry against.
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

/// §5.5's "two existing operator assertions" for creating an operator, half one.
///
/// **The address is inside the assertion** (ADR-0055 decision 5). What an
/// operator asserts is "invite Sam, at this address, to hold this custody".
/// Outside the signature, whoever holds the database could rewrite the address
/// between request and apply, redirecting an invitation two operators signed for.
///
/// **The tag stays `fathom/site/operator/request/v1`.** A length-prefixed field
/// added at the end cannot make an old signature verify against the new shape or
/// vice versa (`the_signed_messages_change_with_every_field_they_cover` pins
/// that), so a version bump would only add a §12.2 label for a message never
/// signed outside a test. Cost: a request signed before the address was added
/// does not verify.
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
    /// writes opens the screen that sets a password and enrols the app code, not a
    /// browser key. Subject column `operator_id` (`0019` §B's CHECK).
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
/// `Debug` does not print the token (the rule `secret.rs` exists for, as
/// `sessions::SignedIn`).
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
    /// When this key left service; `0` means still in service, as
    /// `grants::AccountKey::retired_at_unix`.
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
    /// **ADR-0055 stream (b).** The address of the account this operator's custody
    /// is bound to (`operator_account_bindings`, `0019` §A): decision 1's "the
    /// address is the identity" and decision 5's notice destination.
    ///
    /// `None` for an operator with no binding (every operator created before
    /// ADR-0055). Not inside `operators.row_seal`: the binding is a row of its own
    /// with its own seal (`0019` gives the reason).
    pub address: Option<String>,
}

impl Operator {
    /// §5.5's sentence for the console: *"created by X, never independently
    /// signed in"*, beside every operator until that stops being true.
    pub fn never_independently_signed_in(&self) -> bool {
        self.first_independent_signin_at_unix == 0
    }

    /// ADR-0055 decision 3: could this operator second ANYBODY?
    ///
    /// **Live is not enough.** `0015` §G's `fathom_seconder_is_independent`
    /// refuses a seconder with no independent sign-in on record, or one whose
    /// first sign-in is newer than [`INDEPENDENCE_WINDOW`]. Counting such an
    /// operator toward a quorum of two would demand a signature the database will
    /// not accept: a deadlock.
    ///
    /// This is three of the trigger's four clauses. The fourth is per requester
    /// ([`Operator::is_eligible_to_second`]); this one is the deployment-wide fact
    /// decision 4's banner is about.
    pub fn counts_towards_quorum(&self, now_unix: i64) -> bool {
        self.disabled_at_unix == 0
            && self.first_independent_signin_at_unix != 0
            && self.first_independent_signin_at_unix
                <= now_unix - INDEPENDENCE_WINDOW.as_secs() as i64
    }

    /// **All four of `fathom_seconder_is_independent`'s clauses, against one
    /// named requester.**
    ///
    /// The fourth clause (`0015_operator_console.sql`: "the seconder was created
    /// by the requester, so two ids are not two humans") must be in the count.
    /// Otherwise bootstrap operator A and colleague B (added by A) both read as
    /// eligible and the quorum reads 2, but B's signature raises `P0001` and A
    /// could never add a third operator.
    ///
    /// So the quorum is per requester: [`quorum_for`] counts the operators who
    /// could second THIS requester and asks for a second signature only if there
    /// is one. With nobody, the request stands alone **with the delay**, which
    /// decision 3 says quorum 1 never removes.
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
    /// `FATHOM_OPERATOR_NOTICE_ADDRESS` and bound the operator custody to. The
    /// person signs in as this account; the console checks the operator principal
    /// beneath it.
    pub account_id: String,
    pub invitation: Invitation,
}

/// What [`OperatorStore::adopt_first_operator_from_install`] produces on a
/// deployment whose first start happened under a build older than ADR-0055.
///
/// The operator already existed. Adoption creates the account at
/// `site_install.notice_address`, the sealed binding, and, only where there is no
/// app code to sign in behind, the one-shot `setup` token for decision 10's
/// screen. `invitation` is `None` when the account already holds a confirmed app
/// code (they sign in and register an operator key from the console, decision 9);
/// a token for them would be a bearer secret nobody asked for.
///
/// No `Debug`, for [`Reissued`]'s reason.
pub struct Adopted {
    pub operator_id: String,
    pub account_id: String,
    /// The address the install record named, now this operator's identity
    /// (ADR-0055 decision 1).
    pub notice_address: String,
    pub invitation: Option<Invitation>,
    /// How many live operator keys the adoption retired and sessions it ended.
    /// Logged by `main.rs` and sealed in the `operator_adopted` entry, so the cost
    /// of the upgrade is stated in both places.
    pub retired_keys: usize,
    pub ended_sessions: usize,
}

/// **What one start's adoption did, or did not do, and why.**
///
/// A bare `Option<Adopted>` made `None` mean five different things (ordinary
/// start, never started, missing install record while operators exist, disabled
/// operator, unbindable account), so an upgrade that did not happen looked
/// exactly like one that was not needed.
///
/// So [`Adoption::Nothing`] is the only silent case. Every [`AdoptionRefusal`] is
/// a sentence `main.rs` prints at `error` or `warn` and then **keeps running**: a
/// refusal is not an integrity alarm and no reason to take a working site down.
/// What stops the start is an `Err` (the database or a seal did not answer).
///
/// No `Debug`, for [`Adopted`]'s reason: it carries an [`Invitation`].
pub enum Adoption {
    /// The operator was bound. [`Adopted::invitation`] says whether a token
    /// was written or the account already held a stronger way in.
    Adopted(Adopted),
    /// Nothing to adopt: every operator has a binding, or the deployment has no
    /// operator and no install record because its first start has not run.
    Nothing,
    /// There is something to adopt and it was **not** adopted. Said out loud,
    /// once per start, until somebody fixes it.
    Refused(AdoptionRefusal),
}

impl Adoption {
    /// The adopted operator, or `None` for every other outcome. For assertions and
    /// tests only: `main.rs` matches every variant by hand, since collapsing a
    /// refusal into `None` would be the silent no-op this type exists to remove.
    pub fn adopted(self) -> Option<Adopted> {
        match self {
            Self::Adopted(adopted) => Some(adopted),
            _ => None,
        }
    }
}

/// **Why an adoption that had something to do did not do it.**
///
/// Each variant carries the address and row ids a person on the host needs, and
/// no secret: a refusal happens before the sealed `operator_adopted` entry, so a
/// refused start writes nothing.
#[derive(Debug)]
pub enum AdoptionRefusal {
    /// Operators exist but no `site_install` row, so there is no address to bind.
    /// `0015` §C writes that row at first start and no role can rewrite it; this
    /// means a restore that dropped it, or a hand-built database.
    NoInstallRecord { operators: i64 },
    /// The one operator a pre-ADR-0055 first start created is **disabled**;
    /// binding it would hand the only custody to a seat that cannot act. Nothing
    /// re-enables an operator from a start-up path (§4.5 routes re-enrolment
    /// through §5.4).
    OperatorDisabled {
        operator_id: String,
        address: String,
    },
    /// The account at the install address is **disabled**: the binding would be
    /// permanent (`0019`'s trigger refuses `UPDATE`/`DELETE` at every privilege
    /// level) and sign-in behind it refused. A token would redeem and dead-end.
    /// Enable the account, or restore.
    AccountDisabled {
        operator_id: String,
        account_id: String,
        address: String,
    },
    /// The account at the install address **already holds another operator's
    /// custody**. `operator_account_bindings.account_id` is UNIQUE (`0019` §A) and
    /// a binding cannot be moved.
    AccountAlreadyBound {
        operator_id: String,
        account_id: String,
        address: String,
        bound_to: String,
    },
    /// **More than one operator matches**, so which holds the install address is
    /// not this path's to guess. The ids are named; an operator chooses, by
    /// disabling the others from a console another operator can reach, or from a
    /// restore.
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

/// What [`OperatorStore::reissue_bootstrap_token`] produces: the same invitation
/// §6.3's first start produces, and what it cost.
///
/// No `Debug`: [`Invitation`]'s `Debug` withholds the token, and this type is
/// carried straight to a file.
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

/// Everything the operator plane needs, carried together (as `grants::Authority`
/// and `sessions::SessionStore`): each field is a control, and one value means a
/// new verb cannot quietly omit one.
pub struct OperatorStore {
    /// **The application pool, `fathom_app`.** §1.3: the admin pool is read-only;
    /// every administrative write goes through an application endpoint that writes
    /// the row and its chain entry in one transaction. Every write here is on this
    /// pool.
    pool: Pool,
    ring: Arc<KeyRing>,
    /// `0009`'s one-row deployment identity, inside every signed message so an
    /// assertion made here is an assertion nowhere else.
    deployment: String,
    /// §5.3's delay. A field, not a constant at the point of use (as
    /// `SessionStore::with_lifetime`), so a test can watch the delay elapse; moving
    /// a timestamp in SQL would break the row seal and prove only the seal.
    settings_delay: Duration,
}

impl OperatorStore {
    pub fn new(pool: Pool, ring: Arc<KeyRing>, deployment: String) -> Self {
        Self::with_delay(pool, ring, deployment, SETTINGS_DELAY)
    }

    /// As [`OperatorStore::new`], with a delay other than [`SETTINGS_DELAY`].
    ///
    /// **There is no environment variable for this and there must not be**: a
    /// deployment that could set the delay to zero would let one operator change
    /// SMTP instantly, the attack §5.3 is about. A constructor argument lets a
    /// test watch the delay elapse; `main.rs` passes the constant.
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
    /// `min(2, live stewards)` here. "Live" is narrower than `disabled_at IS NULL`:
    /// it excludes operators `0015` §G's `fathom_seconder_is_independent` would
    /// refuse (no independent sign-in, or one newer than [`INDEPENDENCE_WINDOW`]).
    /// Counting them would ask for a signature the database refuses to store.
    ///
    /// The predicate is [`Operator::counts_towards_quorum`], written once so tests
    /// can drive it without a database.
    pub async fn live_independent_operators(&self) -> Result<i64, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        let count = live_independent_operators(&tx).await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(count)
    }

    /// `min(2, live independent operators)`: decision 3's rule, named.
    ///
    /// **Deployment-wide, and not what gates a request.** Decision 4's banner asks
    /// this; [`OperatorStore::quorum_for`] gates `request_operator`,
    /// `request_setting` and the applies, because the fourth `0015` §G clause is
    /// per requester.
    pub async fn operator_quorum(&self) -> Result<i64, OperatorError> {
        Ok(self.live_independent_operators().await?.min(2))
    }

    /// **The quorum a request by `requester` actually has to reach**: [`quorum_for`]
    /// in a transaction of its own, for a caller outside one.
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
    /// Replaces the stored `single_operator` field ADR-0055 decision 3 retires:
    /// every reader now asks the register, not the process environment.
    pub async fn single_operator(&self) -> Result<bool, OperatorError> {
        Ok(self.operator_quorum().await? < 2)
    }

    pub fn settings_delay(&self) -> Duration {
        self.settings_delay
    }

    // -----------------------------------------------------------------------
    // §6.3 — the very first operator
    // -----------------------------------------------------------------------

    /// **The first operator, and the install record**, written at first start when
    /// no operator exists (§6.3).
    ///
    /// Returns the single-use enrolment token exactly once. §6.3 wants it written
    /// to `/var/lib/fathom/keys/first_operator.token`, 0400, with the PATH logged
    /// and never the token ("whoever can read that volume is the legitimate
    /// installer"). That write is the caller's: the container's filesystem is
    /// read-only except the key volume, and a function here that silently failed to
    /// write it would leave a deployment with no way in and no message.
    ///
    /// **Idempotent, and it has to be**: two interchangeable containers start at
    /// once. The second finds an operator and answers
    /// [`OperatorError::AlreadyBootstrapped`] ("nothing to do"); the advisory lock
    /// makes that a race nobody loses.
    ///
    /// `notice_address` is §6.2's install-time address, recorded now because this
    /// is the one moment the product has a human in front of it and no mail path.
    /// **No role can ever update it** (`0015` §C withholds the privilege and raises
    /// in a trigger), which stops an operator reseating an organisation through a
    /// channel they control.
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
        // operator, and `accounts_readable` (`0013` §A) admits the account custody,
        // not the operator one. The same pair `set_account_disabled` takes.
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;

        // One bootstrapper at a time, deployment-wide. `chains::append_site` locks
        // the chain itself; this covers the "is there an operator yet" check and
        // the insert together.
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

        // **ADR-0055 decision 1: the address is the identity.** Create the account
        // for `FATHOM_OPERATOR_NOTICE_ADDRESS` and bind the operator custody to it,
        // so the installer signs in with an address like everybody else. The
        // display name is the address, the one thing the installer has told this
        // deployment about themselves.
        let account_id = self
            .account_for_address(&tx, notice_address, notice_address, &id)
            .await?;
        self.bind_operator_to_account(&tx, &id, &account_id, appended.seq)
            .await?;

        // **An existing install record wins and is not overwritten.** §6.2 pins an
        // organisation's enrolment claim to this address because no role can
        // rewrite it. `DO NOTHING` keeps it the address install time recorded, even
        // if the operator register was rebuilt; `0015` §C's trigger refuses every
        // other change.
        tx.execute(
            "INSERT INTO site_install (id, notice_address, installed_seq) \
             VALUES ('install', $1, $2) ON CONFLICT (id) DO NOTHING",
            &[&notice_address, &appended.seq],
        )
        .await?;

        // **ADR-0055 decision 10: a `setup` token, not an `operator` one.** It opens
        // a setup screen (set the password, enrol the app code, save backup codes)
        // instead of enrolling a browser key. Bytes, file and `op_` prefix are
        // unchanged; `0019` §B's CHECK lets the column say which screen.
        //
        // `SETUP_SECRET_WINDOW`, not `ENROLMENT_TOKEN_LIFETIME`: this invitation is
        // never handed to anybody (`main.rs` writes no token file, ADR-0057
        // decision 1); `issue_setup_token` mints the one that is. A short row
        // lifetime avoids a live, unheld secret sitting in the database for three
        // days.
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
        // As the adoption below: the operator ADR-0056 decision 1's bit is about
        // now exists, so the browser at the door must be told `pending`, not what
        // was remembered before.
        crate::credentials::forget_setup_state(&self.deployment);
        Ok(Bootstrap {
            operator_id: id,
            account_id,
            invitation,
        })
    }

    /// §5.3's declaration: **write `single_operator_mode` at every startup**, so
    /// nobody can later claim two-person control was in force.
    ///
    /// Called by `main.rs` at every startup, and nothing else.
    ///
    /// **ADR-0055 decision 3: a derived fact, not a declaration.** It records how
    /// many operators could actually second something, counted from the register,
    /// so the trail shows when this deployment ran on one pair of hands without
    /// trusting a process environment. Nothing here sets the quorum: it is counted,
    /// never set.
    ///
    /// **An entry per startup, not per act**, so it is bounded by restarts and not
    /// by whatever an operator does.
    pub async fn record_single_operator_mode(&self) -> Result<i64, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // **Derived, not declared** (ADR-0055 decision 3). Counted in the same
        // transaction the entry is appended in, so the sealed statement is about
        // the register as it was then.
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
                    // The delay is stated beside it: §5.3 says single-operator mode
                    // "reduces the second signature to none and KEEPS the delay",
                    // and the trail should not need trust.
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
    /// (ADR-0055 decision 8, which reopens §6.3's refusal).
    ///
    /// `fathom-server recover-operator <address>` runs where the key volume is
    /// mounted and prints a one-shot ten-minute `setup` code for the operator bound
    /// to that address. The code opens the first operator's setup screen.
    ///
    /// # Why it is not a backdoor
    ///
    /// `reissue_bootstrap_token` refused once any `operator_keys` row existed, so a
    /// host command could not mint a session. Decision 8 answers that: the host
    /// already holds every key (ADR-0043 §2), so a delay is theatre, and the gate
    /// left a sole operator with no way back but a restore. A host-level attacker
    /// is tier 3 (`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §0.1). The control moves
    /// from refusal to record: a sealed `operator_recovered_from_host` entry and a
    /// banner on every operator session for seven days
    /// ([`RECOVERY_BANNER_WINDOW`], [`OperatorStore::notices`]).
    ///
    /// **No delay, and it does not set `0021`'s `operator_key_hold_until`**: that
    /// hold guards a MAILED reset, which whoever controls the mail server can walk,
    /// and the key volume cannot. It CLEARS an existing hold (fix (f)), since
    /// [`OperatorStore::confirm_recovery`] refuses self-confirmation.
    ///
    /// # What it takes away (fix (a))
    ///
    /// Break-glass must dispossess, or the lost browser keeps its session, key and
    /// codes. In the transaction that records it, this:
    ///
    /// 1. retires **every live `operator_keys` row** of the operator (`0024`);
    /// 2. ends **every session of both principals**, each with a sealed entry and a
    ///    `session_revocations` row, because a deleted session row is undone by a
    ///    restore and a revocation is not (`0014` §D);
    /// 3. clears the **app code** (the TOTP secret and the columns `0018` §B's CHECK
    ///    correlates) and retires the **ten backup codes**, which would otherwise
    ///    still open the account;
    /// 4. clears `operator_key_hold_until`.
    ///
    /// None is a power the host lacked; a stolen browser loses its access.
    ///
    /// # What it still refuses
    ///
    /// **It mints no operator.** The address must resolve through
    /// `operator_account_bindings` to an existing, non-disabled operator row, else
    /// [`OperatorError::NotFound`] and nothing is written. Creating a seat is two
    /// operators' work or a first start's.
    ///
    /// # The token it replaces
    ///
    /// Any live `setup` or `operator` token for the operator is expired first, each
    /// with a sealed `enrolment_token_expired` entry (as `reissue_bootstrap_token`):
    /// two live bearer secrets for one seat, one of them lost, is the one nobody
    /// can account for.
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
        // `accounts_readable` admits the account custody, not the operator custody
        // (`0013` §A). The same pair `set_account_disabled` takes.
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;

        // The bootstrap's own lock: a recovery racing a first start must not read
        // the register from one snapshot and mint against another.
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('fathom/operator/bootstrap', 0))",
            &[],
        )
        .await?;

        // **Resolve the address through the BINDING, never a display name.**
        // `operators.display_name` is operator-chosen free text;
        // `operator_account_bindings` is the sealed fact of which account holds
        // which custody, and `accounts.email` is unique.
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

        // The row's own seal before a token is minted against it: an `operators`
        // row edited in the database is how someone would point a recovery at an
        // unexpected seat. The binding's seal too, since it just chose the seat.
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

        // ADR-0055 fix (a): **the dispossession**, counted here and written below
        // the entry that records it (see the doc above). The counts are taken in
        // this transaction, put inside the sealed entry, then performed; nothing
        // commits unless all of it does.
        //
        // `app.session_custody` for these two phases only: session rows, revocation
        // rows, credential columns on `accounts` and backup codes are behind it
        // (`0013` §E, `0014` §D, `0018` §E), the narrowest capability that can read
        // or end a session.
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await?;
        let recovered_at = now_unix();
        // Every row's seal is verified on the way past: a keyring row edited in the
        // database is how someone would keep a key alive through a recovery, and
        // `live_operator_keys` answers with an alarm.
        let live_keys = live_operator_keys(&tx, &self.ring, &operator, recovered_at).await?;
        let retired_keys = live_keys.len();
        // **Both principals.** `credentials::end_every_session_of` filters
        // `principal_kind = 'steward'` (the account); the operator principal has
        // its own id and session, and that is the one the lost browser holds.
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
        // The hold `credentials::redeem_reset` sets (`0021`, decision 7). Clearing
        // it is fix (f): on a sole-operator deployment `confirm_recovery` refuses
        // self-confirmation, so a redeemed reset parked the only seat for 24 hours
        // with no way back from the host, though a delay on the host path is theatre.
        let hold_cleared: bool = tx
            .query_one(
                "SELECT operator_key_hold_until IS NOT NULL FROM accounts WHERE id = $1",
                &[&account],
            )
            .await?
            .get(0);

        // **The record, before the token.** `chains::append_site` makes stopping
        // the log stop the act: if the entry fails, nothing is minted.
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
                    // Inside the sealed metadata, like every other address recorded here.
                    ("address", Json::Str(address.to_string())),
                    ("expired_tokens", Json::Int(expired.len() as i64)),
                    // ADR-0055 fix (e): **the time, inside the seal.**
                    // `chain_entries.created_at` is not in the content hash or seal,
                    // and `notices()` used to select on it before verifying, so a
                    // row moved eight days into the past silently quieted the
                    // seven-day banner.
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

        // ADR-0055 fix (a): the writes the entry above just recorded.
        // `operator_keys` is behind `0024`'s own `UPDATE` policy, under the
        // operator custody this transaction already holds.
        let row_key = grants::site_row_key(&tx, &self.ring).await?;

        // 1. Every live operator key of this operator leaves service.
        // (`retired_at` was always in `operator_key_row_state` and nothing set it;
        // `0024` grants the three columns and the policy.)
        retire_operator_keys(&tx, &row_key, live_keys, recovered_at).await?;

        // 2. Every session of both principals ends: the revocation row first, then
        // the delete (`0014` §D: a deleted session row is undone by a restore, a
        // revocation row is not).
        self.end_sessions_as_revocations(
            &tx,
            &row_key,
            &doomed_sessions,
            &operator,
            "operator_recovered_from_host",
        )
        .await?;

        // 3. The app code goes, so the setup screen enrols a new one
        // (`credentials::enrol_totp` refuses an account whose code is confirmed).
        // All four columns together, because `0018` §B's
        // `accounts_totp_secret_is_whole` correlates them.
        tx.execute(
            "UPDATE accounts \
                SET totp_secret_ct = NULL, totp_secret_nonce = NULL, \
                    totp_secret_key_epoch = NULL, totp_enrolled_at = NULL, \
                    totp_last_step = NULL \
              WHERE id = $1",
            &[&account],
        )
        .await?;

        // 4. The ten backup codes stand BESIDE the app code, so leaving them would
        // not clear the second factor. Marked spent, because `0018` §C gives
        // `fathom_app` no DELETE (a spent code stays as the record), and sealed at
        // version 2 against this recovery's entry, so clearing `used_at` leaves a
        // row that does not verify.
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

        // 6. The credential seal (migration 0025) covers the app-code columns and
        // the hold, both changed above, so re-seal in the same transaction;
        // otherwise the next read of the account is an integrity alarm.
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
    /// Called by `main.rs` at every start where
    /// [`OperatorStore::bootstrap_first_operator`] answered
    /// [`OperatorError::AlreadyBootstrapped`]. On native deployments and after an
    /// adoption it answers `Adoption::Nothing` after two reads and writes nothing.
    ///
    /// # What it is for
    ///
    /// Decision 1 ("the address is the identity") has the first start create an
    /// ACCOUNT for `FATHOM_OPERATOR_NOTICE_ADDRESS`, an operator and a sealed
    /// `operator_account_bindings` row. An older deployment has the operator and no
    /// binding: nobody can sign in, and `recover-operator` resolves the address
    /// THROUGH the binding, so it refuses. The remedy must run without a human,
    /// because the person it is for cannot get in.
    ///
    /// # Which operator
    ///
    /// The bootstrap's own: `created_by IS NULL`, not disabled, lowest
    /// `created_seq`, and **no binding**. The last clause makes it idempotent and
    /// keeps it off colleagues. The row's seal and creating entry are verified
    /// before anything rests on it, as in [`OperatorStore::recover_operator`].
    ///
    /// # What it takes away
    ///
    /// **The record first**: one sealed `operator_adopted` entry (`0026`) with the
    /// operator, address and counts, appended before the writes it describes, so a
    /// failure to record stops the act.
    ///
    /// Then, in the same transaction: every live `setup` and `operator` token is
    /// expired, every live operator key retired, and every session of the operator
    /// principal ended as a sealed revocation. Those keys came from the older flow
    /// (a one-shot token, no second factor); decision 9 has keys register only from
    /// the console behind a confirmed app code, and leaving them would keep the
    /// weaker route alive.
    ///
    /// **It is not a recovery.** It leaves the account's credential, app code,
    /// backup codes and seat hold alone and raises no banner: nothing says a key
    /// volume was reached, and clearing a working second factor would lock out the
    /// person it lets in.
    ///
    /// # The token
    ///
    /// A `setup` token is minted **only if the account has no confirmed app code**;
    /// otherwise the person signs in and registers a key from the console. Returned
    /// once; **nothing in this module logs it**.
    ///
    /// # What it refuses
    ///
    /// Four shapes are not server failures: the install-address account is disabled
    /// or holds another operator's custody, the bootstrapped operator is disabled,
    /// or several operators have no creator and no binding. Each returns an
    /// [`AdoptionRefusal`] that `main.rs` logs while running on. **Every one is
    /// decided before the `operator_adopted` entry is appended**, so a refused
    /// start leaves the site chain as it found it.
    pub async fn adopt_first_operator_from_install(&self) -> Result<Adoption, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        enter_enrolment_custody(&tx).await?;
        // The account is read and written here, and `accounts_readable` (`0013` §A)
        // admits the account custody, not the operator one (as
        // `bootstrap_first_operator`).
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;

        // **The bootstrap's own lock.** Two containers may start at once; this act
        // reads "is there an unbound operator" and writes the binding that answers
        // it, so without the lock both could adopt.
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('fathom/operator/bootstrap', 0))",
            &[],
        )
        .await?;

        // No install record and no operator: no first start ever ran, so
        // `bootstrap_first_operator` is about to handle it. Nothing to adopt,
        // nothing to say.
        //
        // **No install record WITH operators is different** and is said out loud:
        // `0015` §C writes that row at first start and no role can rewrite it, so a
        // missing one beside operators is a restore that left it behind.
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

        // The one operator this is ever about. `NOT EXISTS` against the binding is
        // the idempotence. **No `LIMIT 1`**: two unbound creator-less operators is
        // not a shape this path understands, and taking the oldest would hand the
        // install address to whichever sorted first and strand the other. Both ids
        // are named and an operator decides.
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
            // Nothing live to adopt. Before answering "nothing to do", check for a
            // DISABLED pre-ADR-0055 bootstrap operator, which the query above skips
            // and which would otherwise look like an ADR-0055-native deployment.
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

        // The row's own seal and creating entry, before an address is attached or
        // a token minted. A row sealed by a build before ADR-0055's fix round fails
        // here, which is why `main.rs` runs
        // [`OperatorStore::reseal_legacy_operator_rows`] first.
        verify_operator_row(&tx, &self.ring, &operator).await?;

        // **The two ways the account at that address cannot take this custody**,
        // both checked HERE, before the entry is appended or anything written: a
        // refusal must leave the site chain as it found it.
        if let Some(row) = tx
            .query_opt(
                "SELECT id, disabled_at IS NOT NULL FROM accounts WHERE email = $1",
                &[&notice_address],
            )
            .await?
        {
            let account_id: String = row.get(0);
            let disabled: bool = row.get(1);
            // A disabled account signs in nowhere (`sessions.rs`:
            // `account_disabled`) and the binding written here could never be undone
            // (`0019`'s trigger refuses `UPDATE`/`DELETE` at every privilege level).
            // A token would redeem and the sign-in refuse, permanently.
            if disabled {
                return Ok(Adoption::Refused(AdoptionRefusal::AccountDisabled {
                    operator_id: operator,
                    account_id,
                    address: notice_address,
                }));
            }
            // `operator_account_bindings.account_id` is UNIQUE (`0019` §A). A second
            // binding would raise `23505` and, as an `Err`, fail EVERY start.
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

        // `app.session_custody` for the dispossession only: the operator keyring,
        // session rows and revocation rows are behind it (`0015` §J, `0013` §E,
        // `0014` §D), the narrowest capability that can end a session.
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await?;
        let adopted_at = now_unix();

        // **The counts are taken before the entry, so they are inside it.** Every
        // row's seal is verified on the way past: a keyring row edited in the
        // database is how someone would keep a key alive through an adoption, and
        // `live_operator_keys` answers with an alarm.
        let live_keys = live_operator_keys(&tx, &self.ring, &operator, adopted_at).await?;
        let retired_keys = live_keys.len();
        // **The operator principal only.** The account does not exist yet on the
        // deployment this is for, and where it does it is a steward seat this act
        // has no quarrel with. What has no second factor behind it is the operator
        // key and operator session the older flow issued.
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
        // The same predicate `expire_live_tokens` uses, counted here because the
        // entry recording the act is appended before the act.
        let expiring: i64 = tx
            .query_one(
                "SELECT count(*) FROM enrolment_tokens \
                  WHERE operator_id = $1 AND purpose IN ('setup', 'operator') \
                    AND redeemed_at IS NULL AND expired_at IS NULL",
                &[&operator],
            )
            .await?
            .get(0);

        // **The record, before anything else.** `chains::append_site` makes
        // stopping the log stop the act.
        let recorded = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::OperatorAdopted,
            &entry_metadata(
                EntryType::OperatorAdopted,
                &[
                    ("operator", Json::Str(operator.clone())),
                    // Inside the sealed metadata, like every other address recorded here.
                    ("notice_address", Json::Str(notice_address.clone())),
                    ("at", Json::Int(adopted_at)),
                    ("retired_keys", Json::Int(retired_keys as i64)),
                    ("ended_sessions", Json::Int(ended_sessions as i64)),
                    ("expired_tokens", Json::Int(expiring)),
                ],
            ),
        )
        .await?;

        // ADR-0055 decision 1: the address is the identity. An existing account at
        // that address is REUSED (one person, two custodies, one address);
        // `accounts.email` uniqueness forces it anyway.
        let account = self
            .account_for_address(&tx, &notice_address, &notice_address, &operator)
            .await?;
        self.bind_operator_to_account(&tx, &operator, &account, recorded.seq)
            .await?;

        // The dispossession the entry above just recorded.
        let mut expired = self
            .expire_live_tokens(&tx, Purpose::Setup, &operator, "operator_adopted")
            .await?;
        expired.extend(
            self.expire_live_tokens(&tx, Purpose::Operator, &operator, "operator_adopted")
                .await?,
        );
        if expired.len() as i64 != expiring {
            // The count went inside a sealed entry; a read and write one statement
            // apart under the bootstrap advisory lock cannot disagree, and an entry
            // that misstates what happened is worse than a refusal.
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
        // confirmed app code holds a credential and a second factor; decision 9 has
        // it register an operator key from the console, and a token would be a
        // bearer secret beside a stronger route.
        let has_app_code = crate::credentials::read_credentials(&tx, &self.ring, &account)
            .await
            .map_err(credential_failure)?
            .is_some_and(|row| row.totp_confirmed());

        tx.execute("SELECT set_config('app.session_custody', 'no', true)", &[])
            .await?;

        // `SETUP_SECRET_WINDOW`, not `ENROLMENT_TOKEN_LIFETIME`, for
        // `bootstrap_first_operator`'s reason: this one is never handed to anybody
        // either (`main.rs`'s adoption arm discards it), and `issue_setup_token`
        // mints the token a person redeems.
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
        // ADR-0056 decision 1's one bit has just come into existence (a first
        // operator with no credential), so `GET /setup/state` must say `pending` to
        // the next caller. The cache is process-wide
        // (`credentials::forget_setup_state`) so this startup path, with no
        // `CredentialStore` in reach, can drop it.
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

    /// **Every live operator who holds no account custody**, oldest first: the
    /// colleagues a pre-ADR-0055 build created, named at every start.
    ///
    /// [`OperatorStore::adopt_first_operator_from_install`] adopts only the one
    /// with no `created_by` (the first start's). An operator created through the
    /// console under the older build has a `created_by` and no binding, cannot sign
    /// in (sign-in resolves custody through the binding), and decision 1 gives it
    /// no way to acquire one.
    ///
    /// **It still counts towards the quorum**, because
    /// [`live_independent_operators`] asks `disabled_at` and
    /// `first_independent_signin_at`, not the binding. Deliberately unchanged: a
    /// dropping count would change what a second signature means on a live
    /// deployment, which is a decision, not a fix. This says the ids aloud so an
    /// operator can disable them from the console.
    ///
    /// One query; `main.rs` logs only when it is non-empty.
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

    /// **End every session in `doomed`, each as a sealed revocation** (`0014` §D):
    /// the entry, then the `session_revocations` row whose MAC covers that entry's
    /// `seq`, then the delete, because a deleted session row is undone by a restore
    /// and a revocation row is not.
    ///
    /// Shared by [`OperatorStore::recover_operator`] and
    /// [`OperatorStore::adopt_first_operator_from_install`], which end different
    /// sets of sessions and must not do it two ways. A session whose `principal_id`
    /// is `operator` is filed as `operator_signed_out`; anything else is the bound
    /// account's seat and is filed as `account_signed_out`.
    ///
    /// `reason` goes inside the sealed metadata. The `session_revocations` row's
    /// own reason is `signed_out`, the one value `0014` §D's CHECK takes.
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
                    // The one value `0014` §D's CHECK takes; a break-glass IS a
                    // sign-out of every browser.
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
            crate::sessions::notify_session_ended(tx, session_id).await?;
        }
        Ok(())
    }

    /// Expire every live, unredeemed token of `purpose` for this subject, so a
    /// re-issue leaves one bearer secret alive, not two. Returns their ids, never
    /// the tokens.
    ///
    /// Shared by [`OperatorStore::reissue_bootstrap_token`] (`operator`),
    /// [`OperatorStore::issue_account_enrolment`] (`account`) and
    /// `credentials::CredentialStore::redeem_setup_by_token` (`setup`; hence
    /// `pub(crate)`). `subject` is checked against the column `purpose` names,
    /// never trusted to match it.
    ///
    /// The kill is `expired_at` with its `enrolment_token_expired` entry; `0015` §I
    /// grants the runtime role no other way to retire a token row.
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
        // Take the site chain's advisory lock before the row lock below (ADR-0057
        // decision 1): every append takes it ahead of its row's `UPDATE`, and
        // taking the row lock first inverted that order against a concurrent
        // redemption and deadlocked (40P01).
        chains::lock_site(tx, &self.deployment).await?;
        // Every candidate row is locked here, before any chain entry is appended,
        // so a concurrent spend of one blocks behind this transaction instead of
        // racing it.
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
            // into a new state (that would launder it); the whole re-issue refuses.
            let as_stored = self
                .token_seal(tx, &token.facts(), token.issued_seq, token.row_version)
                .await?;
            if stored_seal != as_stored {
                return Err(OperatorError::Unverifiable("enrolment token row seal"));
            }

            // §7.2's type, with the reason inside the sealed metadata: this token
            // was replaced, not timed out, and a reader holding the chain key can
            // tell.
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

            // Both columns in one statement: the table's
            // `CHECK ((expired_at IS NULL) = (expired_seq IS NULL))` refuses the
            // state between. `row_version = $6` ties the write to the exact row read
            // here, as `mark_redeemed`.
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
                // Should not happen: the row was locked above, in this transaction,
                // before any chain entry was appended. Abort rather than commit an
                // entry no write backs.
                return Err(OperatorError::Corrupt("enrolment token row"));
            }
            expired.push(token.id);
        }
        Ok(expired)
    }

    // -----------------------------------------------------------------------
    // §1.1 — account shells and their invitations
    // -----------------------------------------------------------------------

    /// §1.1: "create an account shell (email, display name)", and the invitation
    /// that turns it into somebody who can sign in.
    ///
    /// **The account has no key and no membership and gets neither here.** It is
    /// an address, a name and a token the holder redeems to enrol the key
    /// everything else rests on. §6.4 (a grant names a subject who already has a
    /// registered key) stops this being a route to authority.
    ///
    /// One transaction: principal row, account row, sealed `account_created`
    /// entry, token row and sealed `enrolment_token_issued` entry, or none.
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
        // The register's own check, in the act's transaction (§1.1: a suspended
        // operator stops at the next request).
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
                    // The address is inside the SEALED metadata (AEAD ciphertext
                    // under a key not in PostgreSQL, §7.3), so recording who was
                    // invited puts no address list in the clear.
                    ("address", Json::Str(address.to_string())),
                    ("display_name", Json::Str(display_name.to_string())),
                ],
            ),
        )
        .await?;

        // `0004`: every account is a steward principal through a composite key
        // whose `kind` half is a generated constant, so the principal row must exist
        // first. That fence makes an operator id unrepresentable in a membership,
        // and is why this is two statements rather than `repo::create_account`,
        // which opens its own transaction and would put the rows outside the entry's.
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

    /// §1.1's "initiate an authenticator-enrolment token" for an existing account,
    /// **which is also §5.1's reset**.
    ///
    /// §5.1: no "set password" control; "send a reset link" goes only to the
    /// account's verified address of record, with no override field and no
    /// operator-supplied destination. So there is **no destination parameter**: the
    /// token is bound to the account and redemption re-reads that account's address.
    ///
    /// §4.4's third path is "a one-time enrolment token AND a steward
    /// co-signature", which an operator may initiate and cannot complete. **The
    /// steward co-signature is not built**: today an operator who intercepts the
    /// token of an account that already holds grants can enrol a key on it. Closing
    /// it means a grant-shaped steward co-signature path in the authority layer;
    /// `docs/OPEN-QUESTIONS.md` has no entry for it.
    ///
    /// **A re-issue kills the account's other live tokens first**, through
    /// [`OperatorStore::expire_live_tokens`] as
    /// [`OperatorStore::reissue_bootstrap_token`] does: otherwise a leaked first
    /// invitation stays redeemable for its whole 72 hours. It touches no enrolled
    /// key (an account may hold several, §4.4); retiring one is a steward-co-signed
    /// act this is not.
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
        // `app.enrolment_custody`, not `app.operator_custody`:
        // `expire_live_tokens`'s `UPDATE` is a spend of the token it retires (as in
        // `reissue_bootstrap_token`).
        enter_enrolment_custody(&tx).await?;
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
        self.check_operator_live(&tx, &acting).await?;

        // `accounts_readable` (`0013`) has no `app.operator_custody` branch, so
        // operator custody alone sees no row at all. `set_account_disabled` carries
        // the same second setting; without it §5.1's reset could never find the
        // account it was resetting.
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
    /// The browser keeps the private half of a fresh keypair and sends the public
    /// half with the token and the address it believes it is enrolling.
    ///
    /// # Checked, in order
    ///
    /// 1. the token hash names a live row (not redeemed, not expired, seal verifies);
    /// 2. the purpose is `account`;
    /// 3. **the claimed address is the address on the account the TOKEN names**, so
    ///    a token for one address cannot enrol a key for another;
    /// 4. the account is not disabled;
    /// 5. the token is spent by a guarded `UPDATE` whose new state goes back into
    ///    the row seal;
    /// 6. the key is enrolled through `grants::enrol_software_key_at_invitation`.
    ///
    /// Every refusal is [`OperatorError::EnrolmentRefused`], one message for every
    /// cause; the sealed entry carries the reason.
    ///
    /// **The reason survives the refusal.** This transaction refuses without
    /// committing, so an entry appended inside would roll back and a guess would
    /// leave no trace. [`OperatorStore::record_redemption_refused`] records it in a
    /// second transaction.
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
                return Err(self
                    .refuse_expired_or_invalid_token(
                        tx,
                        token,
                        Purpose::Account,
                        EntryType::AccountSigninFailed,
                        "token_invalid",
                    )
                    .await);
            }
            Err(e) => return Err(e),
        };
        let account = row
            .account_id
            .clone()
            .ok_or(OperatorError::Corrupt("enrolment token subject"))?;

        // The account is named by the TOKEN. The address is checked against that
        // account's row, never used to find one: a caller who could choose the
        // account by address could enrol a key on any account whose address they
        // could guess.
        set_account_id(&tx, &account).await?;
        let found = tx
            .query_opt(
                "SELECT email, disabled_at IS NOT NULL FROM accounts WHERE id = $1",
                &[&account],
            )
            .await?;
        let Some(found) = found else {
            return Err(self
                .refuse_redemption(
                    tx,
                    EntryType::AccountSigninFailed,
                    Purpose::Account,
                    "account_not_found",
                )
                .await);
        };
        let on_record: String = found.get(0);
        let disabled: bool = found.get(1);
        if on_record != address || disabled {
            // **The guessing oracle's own check.** Someone holding a leaked token
            // can present any address; the sealed reason tells an operator a wrong
            // guess from a disabled account, and neither is returned to the caller.
            let reason = if on_record != address {
                "address_mismatch"
            } else {
                "account_disabled"
            };
            return Err(self
                .refuse_redemption(tx, EntryType::AccountSigninFailed, Purpose::Account, reason)
                .await);
        }

        let mut fields = vec![
            ("token", Json::Str(row.id.clone())),
            ("purpose", Json::Str(Purpose::Account.as_str().to_string())),
            ("account", Json::Str(account.clone())),
        ];
        // A steward's invitation: the join is recorded as this same entry, with
        // the invitation named (redemption has no tenant to file anything else on).
        if let Some(invitation) = &row.invitation_id {
            fields.push(("invitation", Json::Str(invitation.clone())));
        }
        let redeemed = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::EnrolmentTokenRedeemed,
            &entry_metadata(EntryType::EnrolmentTokenRedeemed, &fields),
        )
        .await?;
        self.mark_redeemed(&tx, &row, redeemed.seq).await?;

        // An invitation token enrols the account's FIRST key and only while the
        // invitation is still open (`0037`): a second key on an account that
        // already has one would get everything that account holds. Taken after
        // the site chain lock above (ADR-0057 decision 1's order).
        let open = match &row.invitation_id {
            Some(invitation) => {
                match invitations::check_open_for_join(&tx, &self.ring, invitation, &account)
                    .await?
                {
                    invitations::JoinCheck::Open(open) => Some(open),
                    invitations::JoinCheck::Refused(reason) => {
                        return Err(self
                            .refuse_redemption(
                                tx,
                                EntryType::AccountSigninFailed,
                                Purpose::Account,
                                reason,
                            )
                            .await);
                    }
                }
            }
            None => None,
        };

        let key = grants::enrol_software_key_at_invitation(
            &tx,
            &self.ring,
            &self.deployment,
            &account,
            public_key,
        )
        .await?;
        if let Some(open) = open {
            invitations::mark_joined(&tx, &self.ring, open, &key, redeemed.seq).await?;
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(key.id)
    }

    // -----------------------------------------------------------------------
    // §6.2 — organisation shells and their claims
    // -----------------------------------------------------------------------

    /// §6.2: "an operator may create an organisation shell: a row with a name, no
    /// genesis, and an enrolment claim. The shell holds no data and permits no
    /// design creation until the claim is redeemed by an account with a registered
    /// authenticator."
    ///
    /// The claim is pinned to the install-time `notice_address`, which no role can
    /// update, and redemption requires presenting it.
    pub async fn create_organisation_shell(
        &self,
        operator: &VerifiedSession,
        display_name: &str,
    ) -> Result<(String, Invitation, String), OperatorError> {
        let acting = self.acting_operator(operator)?;
        if display_name.trim().is_empty() {
            return Err(OperatorError::Malformed("display name"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
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
                    ("notice_address", Json::Str(notice.clone())),
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
        Ok((shell, invitation, notice))
    }

    /// **Redeem an organisation claim: §6.1's genesis, run by the account that
    /// holds the claim.**
    ///
    /// The redeemer is a steward session (an account that already has a key:
    /// §6.2's "an account with a registered authenticator"). The organisation has
    /// the id §6.1 derives from the root public key, not the shell's id; the shell
    /// records which organisation its claim produced and stops being redeemable
    /// (`0015` §D: why a shell is not a row in `organisations`).
    ///
    /// **An operator cannot call this**, and not by a check in here:
    /// `grants::bootstrap_organisation` needs an `AccountId` and creates a
    /// membership for it, and `0004`'s composite keys make an operator principal
    /// unrepresentable in a membership at every privilege level. The session check
    /// below is a polite refusal in front of a fence that does not need it.
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
        // Needed below for `account_keys_readable`'s policy; `creator` came from
        // the verified session, not the caller's claim.
        set_account_id(&tx, &creator.to_string()).await?;

        // The claim is pinned to the install-time address and the caller must
        // present it (§6.2): this stops an operator reseating an organisation
        // through a channel inside their own plane. Trimmed like `config.rs` trims
        // `FATHOM_OPERATOR_NOTICE_ADDRESS`.
        if self.notice_address(&tx).await? != notice_address.trim() {
            return Err(self
                .refuse_redemption(
                    tx,
                    EntryType::AccountSigninFailed,
                    Purpose::Organisation,
                    "notice_address_mismatch",
                )
                .await);
        }

        let row = match self.spend_token(&tx, token, Purpose::Organisation).await {
            Ok(row) => row,
            Err(OperatorError::EnrolmentRefused) => {
                return Err(self
                    .refuse_expired_or_invalid_token(
                        tx,
                        token,
                        Purpose::Organisation,
                        EntryType::AccountSigninFailed,
                        "token_invalid",
                    )
                    .await);
            }
            Err(e) => return Err(e),
        };
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
            return Err(self
                .refuse_redemption(
                    tx,
                    EntryType::AccountSigninFailed,
                    Purpose::Organisation,
                    "shell_not_found",
                )
                .await);
        };
        let display_name: String = found.get(0);
        let already: bool = found.get(1);
        let created_by: String = found.get(2);
        let created_seq: i64 = found.get(3);
        let row_version: i32 = found.get(4);
        let stored_seal: Vec<u8> = found.get(5);
        if already {
            return Err(self
                .refuse_redemption(
                    tx,
                    EntryType::AccountSigninFailed,
                    Purpose::Organisation,
                    "shell_already_claimed",
                )
                .await);
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
            // An integrity alarm (§3.4 step 2), not a refused redemption:
            // that ledger is for a caller's own claim, not a row lying.
            return Err(OperatorError::Unverifiable("organisation shell row seal"));
        }

        // Refused here, not inside `bootstrap_organisation`, which trusts
        // every subject it is handed: the redeemer must be the founding steward.
        if genesis.iter().any(|grant| grant.subject != creator) {
            return Err(self
                .refuse_redemption(
                    tx,
                    EntryType::AccountSigninFailed,
                    Purpose::Organisation,
                    "grant_subject_mismatch",
                )
                .await);
        }

        // Each grant's key must be a real, live key of its subject -- the
        // same check `verify_grant_row` runs later, moved to the door.
        for grant in genesis {
            let key = match grants::key_by_fingerprint(
                &tx,
                &self.ring,
                &grant.subject_key_fpr,
                grant.effective_from_unix,
            )
            .await
            {
                Ok(key) => key,
                Err(AuthorityError::Unverifiable(what)) => {
                    return Err(OperatorError::Unverifiable(what));
                }
                Err(_) => {
                    return Err(self
                        .refuse_redemption(
                            tx,
                            EntryType::AccountSigninFailed,
                            Purpose::Organisation,
                            "grant_subject_key_invalid",
                        )
                        .await);
                }
            };
            if key.account_id != grant.subject.to_string() {
                return Err(self
                    .refuse_redemption(
                        tx,
                        EntryType::AccountSigninFailed,
                        Purpose::Organisation,
                        "grant_subject_key_invalid",
                    )
                    .await);
            }
        }

        // §6.1's id is derived: the same key and salt twice would otherwise
        // hit `bootstrap_organisation`'s own unique-violation, an alarm.
        let candidate_organisation = authority::derive_organisation_id(root_pubkey, id_salt);
        let root_fpr = authority::key_fingerprint(root_pubkey);
        tx.execute(
            "SELECT set_config('app.tenant_id', $1, true)",
            &[&candidate_organisation],
        )
        .await?;
        let organisation_exists = tx
            .query_opt(
                "SELECT 1 FROM organisations WHERE id = $1",
                &[&candidate_organisation],
            )
            .await?
            .is_some();
        if organisation_exists {
            return Err(self
                .refuse_redemption(
                    tx,
                    EntryType::AccountSigninFailed,
                    Purpose::Organisation,
                    "organisation_exists",
                )
                .await);
        }

        // Verified before `bootstrap_organisation` writes anything -- its
        // own check runs mid-insert, too late for a refusal to mean nothing wrote.
        for grant in genesis {
            let facts = GrantFacts {
                organisation: &candidate_organisation,
                root_pubkey_fpr: &root_fpr,
                scope: "",
                subject: &grant.subject.to_string(),
                subject_key_fpr: &grant.subject_key_fpr,
                capability: grant.capability,
                granter: None,
                granter_key_fpr: &root_fpr,
                effective_from_unix: grant.effective_from_unix,
                expires_at_unix: grant.expires_at_unix,
                sole_steward_appointment: false,
                auth_epoch: 1,
            };
            let message = authority::grant_bytes(&facts);
            if authority::verify_es256(root_pubkey, &message, &grant.signature).is_err() {
                return Err(self
                    .refuse_redemption(
                        tx,
                        EntryType::AccountSigninFailed,
                        Purpose::Organisation,
                        "grant_signature_invalid",
                    )
                    .await);
            }
        }

        let genesis_result = match grants::bootstrap_organisation(
            &tx,
            &self.ring,
            creator,
            &display_name,
            root_pubkey,
            id_salt,
            genesis,
        )
        .await
        {
            Ok(g) => g,
            Err(AuthorityError::Signature(_)) => {
                return Err(self
                    .refuse_redemption(
                        tx,
                        EntryType::AccountSigninFailed,
                        Purpose::Organisation,
                        "grant_signature_invalid",
                    )
                    .await);
            }
            Err(e) => return Err(e.into()),
        };
        let organisation = genesis_result.organisation.to_string();

        // Back to enrolment custody: `bootstrap_organisation` leaves the
        // transaction pointed at the new tenant, and the next statements are
        // site-scoped.
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

    /// The same act as [`Self::redeem_organisation_claim`], but parses the
    /// subject text into an [`AccountId`] here: `tests/sessions.rs` forbids `api.rs` handlers from doing it themselves.
    #[allow(clippy::too_many_arguments)]
    pub async fn redeem_organisation_claim_over_http(
        &self,
        session: &VerifiedSession,
        token: &[u8],
        notice_address: &str,
        root_pubkey: &[u8],
        id_salt: &[u8; 16],
        subject_text: &str,
        subject_key_fpr: [u8; 32],
        effective_from_unix: i64,
        expires_at_unix: i64,
        signature: [u8; 64],
    ) -> Result<OrganisationId, OperatorError> {
        let subject: AccountId = subject_text
            .parse()
            .map_err(|_| OperatorError::Malformed("grant subject"))?;
        let genesis = [GenesisGrant {
            subject,
            subject_key_fpr,
            capability: authority::Capability::Steward,
            effective_from_unix,
            expires_at_unix,
            signature,
        }];
        self.redeem_organisation_claim(
            session,
            token,
            notice_address,
            root_pubkey,
            id_salt,
            &genesis,
        )
        .await
    }

    // -----------------------------------------------------------------------
    // §1.1 — suspend, disable
    // -----------------------------------------------------------------------

    /// §1.1's "suspend a scope grant (immediate)", from an operator session.
    ///
    /// The act is `grants::suspend_grant_by_operator`; this adds the operator
    /// session in front and the site-chain record beside the organisation's own.
    /// **There is no unsuspend here**: §1.1 gives lifting to the organisation's
    /// stewards, and `0011`'s `CHECK` refuses an operator `unsuspend` row regardless.
    pub async fn suspend_grant(
        &self,
        operator: &VerifiedSession,
        organisation: &str,
        grant_id: &str,
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;

        // **The register first, in this transaction.** A disabled operator does not
        // suspend a grant, and the check must share a snapshot with the act.
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

        // **`grant_suspended` is filed on BOTH chains** (as `rewrap`, §7.2 "on both
        // lists"). The organisation chain records the act for the stewards who may
        // lift it; the site chain records that the machine side did it, so every
        // operator verb is legible in one place to an auditor of the operator
        // plane. The entries differ: this one names the operator and session, that
        // one the grant's scope and epoch.
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

    /// §1.1's "disable / re-enable an account".
    ///
    /// A disabled account's live sessions stop at their next request, because
    /// `sessions::verify_pending` re-reads the row in the authorising transaction.
    /// §1.1 also requires notifying every steward of every scope the account holds;
    /// **that notice is not built** (no mail path in this build).
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
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
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
    /// **There is no re-enable, deliberately**: §4.5 has an operator who loses
    /// their authenticators re-enrolled by two others through §5.4's machinery, and
    /// §7.2 names no `operator_enabled` type. A re-enable button would make
    /// disabling reversible by the person who did it.
    ///
    /// An operator cannot disable themselves: a deployment whose last operator did
    /// would have no way back in but the key volume.
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
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
        self.check_operator_live(&tx, &acting).await?;

        let Some(row) = read_operator(&tx, target).await? else {
            return Err(OperatorError::NotFound("operator"));
        };

        // **`0019` §C's floor, refused here as well as in the trigger.** The
        // trigger binds whoever holds a connection; this is the same refusal before
        // the statement, so the caller gets a sentence, not a constraint message.
        // Both read inside the act's transaction.
        //
        // Live, not live-and-independent: the floor is about having ANY operator.
        // ADR-0055 decision 4 keeps a sole operator supported and warns rather than
        // blocks.
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
        // The trigger is the one that is not a race. Its `P0001` is mapped, not
        // surfaced, so a caller need not read a database sentence to learn it hit a
        // rule this module already names.
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

    /// §1.1's `operator_read`, "sampled: one entry per session per surface".
    ///
    /// The latch is taken first and the entry appended only if this call took it,
    /// so a page polled every five seconds writes one entry, not seventeen
    /// thousand. Both are in one transaction: a failing handler leaves neither.
    pub async fn record_read(
        &self,
        operator: &VerifiedSession,
        surface: &str,
    ) -> Result<(), OperatorError> {
        let acting = self.acting_operator(operator)?;

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
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
        // ADR-0055 decision 1: the register shows the address, which lives on the
        // bound account. `accounts_readable` (`0013` §A) admits the account custody,
        // so this read takes it beside the operator one (as `set_account_disabled`)
        // and drops it again.
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
    /// organisation display names readable because support and billing need to know
    /// which customer they are looking at; everything below is opaque ids and shape.
    pub async fn list_organisations(&self) -> Result<Vec<(String, String)>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        // **This read is on the application pool, not `fathom_operator`, because the
        // operator role has no login in this build** (§1.3 wants a read-only pool;
        // `0005` creates it `NOLOGIN` and `tests/planes.rs` asserts it cannot
        // connect). Provisioning that login is a deployment change (a second
        // credential in the key volume, §1.4) and not built. Either way,
        // `organisations.display_name` is §1.2's one readable name and
        // `app.design_capability` is at its refusal for the whole transaction, so
        // the sightlessness §1.3 is about does not depend on which role ran the
        // query.
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
    /// **The first version of a setting applies immediately** (§5.3's first-version
    /// rule, stated so nobody invents a skip flag): "a setting with no prior applied
    /// version applies immediately, with no delay and no second operator. On a fresh
    /// install there is no old value to protect and no mail path to capture." The
    /// condition is checked here with §5.3's own SQL, not a mode.
    ///
    /// Every later version takes the delay and, outside single-operator mode, a
    /// second operator.
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
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
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

        // Whole seconds, both terms: the delay is kept to within a second of what
        // was configured, never more. A test needing a reliable delay should ask for
        // at least two seconds.
        let now = now_unix();
        let effective_at = if first_version {
            now
        } else {
            now + self.settings_delay.as_secs() as i64
        };

        // ADR-0055 decision 3: the stamp is the quorum in force AT REQUEST TIME,
        // read from the register in this transaction. A record, not a gate:
        // `apply_if_due` re-reads the live quorum, and `0022` §A removed the `CHECK`
        // that made the stamp a bar to later seconding.
        //
        // **Per requester** (fix (c)): the question is how many operators could
        // second THIS one, the fourth clause `0015` §G applies and
        // `live_independent_operators` omits.
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

        // The first version is applied in the same transaction, since there is
        // nothing for a delay to protect (§5.3), through the SAME function every
        // later version uses: the interlock is not skipped, only the waiting.
        let applied = self.apply_if_due(&tx, &id).await?;

        let pending = self.read_setting(&tx, &id).await?;
        leave_custody(&tx).await?;
        tx.commit().await?;
        let _ = applied;
        Ok(pending)
    }

    /// Second a pending setting change (§5.5). A **different** operator, a fresh
    /// assertion over the row that exists.
    ///
    /// §5.5's three conditions on the seconder (not created by the requester, an
    /// independent sign-in on record, that sign-in older than the longest delay
    /// window) are enforced by `0015` §G's `SECURITY DEFINER` trigger, so they bind
    /// statements this code never issued too. The fourth, the signature, is checked
    /// here.
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
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
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

        // ADR-0055 fix (c): the same trigger guards this table
        // (`site_settings_versions_seconder`, beside `operator_requests_seconder`),
        // so the same typed refusal.
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
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
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
    /// Not "the newest row". §5.4:
    ///
    /// 1. candidates are rows with `applied_at IS NOT NULL`, `cancelled_at IS NULL`
    ///    and `sealed_seq IS NOT NULL`;
    /// 2. load site-chain entry `sealed_seq`, **verify its seal**, and check its
    ///    sealed metadata names this row's `(id, key, value_digest, effective_at)`;
    /// 3. check `prev_seal` matches entry `sealed_seq - 1`, whose seal also verifies
    ///    (`chains::read_site_entry_verified` does 2 and 3);
    /// 4. **NOT IMPLEMENTED**: check `effective_receipt_id` names a witness receipt
    ///    at or after `effective_at`. `0009` defers receipts, so the delay is
    ///    measured against this server's own clock, not the party it protects
    ///    (`0015` §F);
    /// 5. the newest survivor. **A candidate that fails any check is not silently
    ///    skipped**: it raises `setting_unresolvable` and this returns
    ///    [`OperatorError::SettingUnresolvable`].
    ///
    /// This turns the trail from evidence into a gate: a row inserted directly into
    /// PostgreSQL has no sealed entry naming its digest, so step 2 rejects it, and
    /// **stopping the log to act unobserved also stops the act**.
    ///
    /// It also applies anything whose delay has elapsed (no scheduler; `0014` §C).
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

        // **The newest candidate decides, and a failure is an incident, not a
        // reason to fall back** (§5.4 step 5: "a candidate that fails any check is
        // NOT silently skipped"). Falling back would let an attacker who can corrupt
        // one row silently put the setting back to its previous value while the
        // trail shows the change applied.
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

        // The entry's sealed metadata must name this row's (id, key, value_digest,
        // effective_at), compared as canonical bytes so an extra field or different
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
        // **Lock the row, then append the entry, then write both marker columns
        // together.** Two statements would break the `CHECK` that keeps them in
        // step, and appending before the lock would let two readers raise the same
        // incident twice (`0014` §B's amplifier).
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
    /// Returns `false` when the change is not due, unseconded or cancelled. This is
    /// the only writer of `sealed_seq`, and it cannot write it without
    /// `chains::append_site` having succeeded under a chain key that is not in
    /// PostgreSQL.
    async fn apply_if_due(&self, tx: &Transaction<'_>, id: &str) -> Result<bool, OperatorError> {
        let row = self.read_setting_row(tx, id).await?;
        if row.facts.applied_at_unix != 0 || row.facts.cancelled_at_unix != 0 {
            return Ok(false);
        }
        if row.facts.effective_at_unix > now_unix() {
            return Ok(false);
        }
        // Two operators, the single-operator condition, **or §5.3's first version,
        // which needs neither** ("a setting with no prior applied version applies
        // immediately... no old value to protect and no mail path to capture").
        //
        // Re-evaluated HERE, not remembered from the request: another change may
        // have become this key's first applied version in between, and a remembered
        // flag would let a second change through on one signature. This is §5.3's
        // SQL over the applied rows, excluding the row considered.
        let first_version = tx
            .query_opt(
                "SELECT 1 FROM site_settings_versions \
                  WHERE key = $1 AND id <> $2 AND applied_at IS NOT NULL \
                    AND cancelled_at IS NULL",
                &[&row.facts.key, &row.facts.id],
            )
            .await?
            .is_none();
        // **The LIVE quorum, not `row.facts.single_operator`.** The row's field is
        // what was true at REQUEST time, stamped and sealed as a fixed record.
        // Gating on it would be the mistake ruled out for `first_version`: if the
        // quorum rises between request and delayed apply, a change requested earlier
        // would still apply alone on a stale flag. The live value is asked fresh.
        //
        // ADR-0055 decision 3 makes the live value a count over the register, and a
        // row stamped `single_operator = true` at request time may still be seconded
        // later (`0022` §A removed the forbidding `CHECK`), so this re-read alone
        // decides, in both directions.
        //
        // **Per requester** (fix (c)): `quorum_for` counts the operators who could
        // second whoever asked for THIS change. A quorum no living operator could
        // satisfy would leave the change pending forever.
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
                    // `resolve_candidate` rebuilds this whole object from the row and
                    // compares byte for byte, so every field must be reconstructible
                    // from the row, and the live quorum (a moving count) is not.
                    // Nothing is lost: `seconded_by` in this entry says whether the
                    // change took one signature or two. Writing the live value here
                    // made every seconded change read as `SettingUnresolvable`, an
                    // integrity alarm raised by correct use.
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

    /// §5.5: "operator creation is itself routed through this machinery: two
    /// existing operator assertions, the delay, notice to every organisation's
    /// stewards, sealed."
    ///
    /// **The notice is not built** (no mail path in this build). Built: the two
    /// assertions, the delay, the seconder rules and the sealed entries.
    ///
    /// **ADR-0055 decision 5: the colleague's address is taken here, at request
    /// time.** They cannot sign in on their own without an address to be invited at
    /// and an account shell behind it; collecting it at first sign-in would mean an
    /// invitation with nowhere to go. The address goes inside the assertion
    /// (`operator_request_bytes`) and the row seal (`0022` §B), so it is neither the
    /// requester's word alone nor the database holder's to rewrite.
    ///
    /// Quorum is decision 3's `min(2, live independent operators)`: with one
    /// operator this applies alone after the delay, and nothing shortens the delay.
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
        // The same floor `create_account_shell` puts under an address, and the same
        // ceiling as `0022` §B's CHECK: an address this server cannot store is
        // refused with a sentence, not a constraint.
        if address.trim().len() < 3 || address.len() > 320 {
            return Err(OperatorError::Malformed("address"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
        self.check_operator_live(&tx, &acting).await?;

        let message = operator_request_bytes(&self.deployment, &acting, display_name, address);
        self.verify_operator_assertion(&tx, &acting, &message, signature)
            .await?;

        // Per requester (fix (c)) -- see `request_setting`'s own note.
        let single_operator = quorum_for(&tx, &self.ring, &acting).await? < 2;
        let id = ids::new_ulid().to_string();
        // **No first-version exemption here.** §5.3's rule is about a setting with
        // no prior value to protect; the operator register always has one (a
        // deployment with no operator cannot reach this).
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
                    // Inside the SEALED metadata (§7.3), as `create_account_shell`
                    // records an address: the trail says who was invited without a
                    // list of addresses in the clear.
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
        // Live-operator check in this transaction (§1.1; see `check_operator_live`).
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

        // ADR-0055 fix (c): `0015` §G's trigger is the fence, and its `P0001` is a
        // RULE, so it maps to a typed refusal (as `disable_operator` does for `0019`
        // §C's floor) rather than reaching the operator as a 500.
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
    /// On the write path and on the console's own read of the register, since there
    /// is no scheduler (`0014` §C).
    pub async fn apply_due_operator_requests(&self) -> Result<Vec<Invitation>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        enter_enrolment_custody(&tx).await?;

        // **The candidate filter does not read the stamped flag.** The quorum is a
        // live count (ADR-0055 decision 3), so a row stamped `single_operator =
        // false` becomes a candidate once the deployment drops to one operator, and
        // `apply_operator_request` decides. Reading the stamp would exclude exactly
        // those rows.
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
        // **The LIVE quorum, not `row.single_operator`**, for `apply_if_due`'s
        // reason: the row's field records the configuration at REQUEST time, and
        // gating a creation that mints a whole operator on it would let a request
        // made under a since-removed escape hatch still use it. Every candidate must
        // pass the live check before anything is created.
        //
        // ADR-0055 decision 3: the live value is a count over the register
        // (`live_independent_operators`), so a sole operator's request applies alone
        // after the delay and stops doing so once a second independent operator
        // exists.
        //
        // **Per requester** (fix (c)): "a second independent operator" means one who
        // could second THIS requester. Bootstrap operator A plus colleague B (added
        // by A) is two independent operators and zero eligible seconders for A; the
        // old count left A's request for a third operator pending forever.
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
                    // The live value this apply was gated on.
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

        // **ADR-0055 decision 1: the address is the identity.** Create the account
        // shell for the requested address if none exists and bind the operator
        // custody to it in the operator row's transaction. An operator with no bound
        // account has no address to be invited at or noticed on. An existing account
        // at the address is USED, not duplicated (one person, two custodies, one
        // address); `accounts.email` is unique anyway.
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

        // §5.5's "first sign-in that must register an authenticator", as ADR-0055
        // decision 10 rewrites it: the new operator holds nothing but a `setup`
        // token (the screen that sets a credential and enrols the app code). The
        // `operator` purpose stays in the schema for the passkey step `NEXT.md` item
        // 4 holds open; nothing issues one.
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
    /// The operator id comes from the TOKEN, never the caller (as
    /// `redeem_account_enrolment`). **It is also the answer**: the returned
    /// [`OperatorKey`] names the operator the token was for, because that id is
    /// what the operator signs in with (`sessions::operator_by_id`: "handed to them
    /// once at enrolment") and this is the once.
    ///
    /// Every refusal is [`OperatorError::EnrolmentRefused`], and
    /// `redeem_account_enrolment`'s note on
    /// [`OperatorStore::record_redemption_refused`] applies: the reason is appended
    /// in a second transaction after this one has rolled back.
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
                return Err(self
                    .refuse_expired_or_invalid_token(
                        tx,
                        token,
                        Purpose::Operator,
                        EntryType::OperatorSigninFailed,
                        "token_invalid",
                    )
                    .await);
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
            return Err(self
                .refuse_redemption(
                    tx,
                    EntryType::OperatorSigninFailed,
                    Purpose::Operator,
                    "operator_not_found",
                )
                .await);
        };
        if existing.disabled_at_unix != 0 {
            return Err(self
                .refuse_redemption(
                    tx,
                    EntryType::OperatorSigninFailed,
                    Purpose::Operator,
                    "operator_disabled",
                )
                .await);
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

    /// The acting operator's id, from a **verified** session and nowhere else.
    ///
    /// §13 item 1: "`actor` comes from a session, never from the caller." Every
    /// verb above starts here, takes a `&VerifiedSession` (which only
    /// `sessions::verify_pending` can make), and refuses anything that is not an
    /// operator session.
    fn acting_operator(&self, session: &VerifiedSession) -> Result<String, OperatorError> {
        if session.kind() != PrincipalKind::Operator {
            return Err(OperatorError::NotAnOperator);
        }
        Ok(session.principal_id())
    }

    /// The operator register's half of the same question, **inside the
    /// transaction the act will run in**.
    ///
    /// Two checks, not one: `sessions::verify_pending` has already refused a
    /// session whose operator is disabled, and this refuses one disabled between
    /// that check and this statement (a session verified a microsecond before the
    /// disabling commits must not go on to act). Same transaction as the act, so
    /// what it reads is what the act writes against (`0014` finding 3).
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

    /// Verify an assertion by the acting operator's **enrolled** key: §5.5's
    /// "seconding is a hardware touch and not a row", and the same for a request.
    ///
    /// The session signature proved the browser holds the session key; this proves
    /// the human holds the key the register knows them by, a different key and, for
    /// an authenticator, a different touch.
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
        // **Every live key, not the newest** (ADR-0055 resolution 1: any live key
        // must be accepted wherever sign-in evidence or grant signatures are
        // verified). Decision 6 lets any browser sign in with no pairing and
        // decision 1 has each register its own key, so an operator with two
        // browsers has two live keys and `LIMIT 1` would refuse the one they are
        // using. Retiring a key is what removes it from this set.
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

    /// The operator's key as anything accepting a signature must resolve it: the
    /// live one, **its own row seal verified**, in service now.
    ///
    /// `grants::live_signing_key`'s argument for the operator keyring: an edited
    /// `public_key` is how an administrator would sign in as somebody else.
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
/// A free function because `sessions.rs` resolves it on the sign-in path without
/// an `OperatorStore` (as `grants::live_signing_key`).
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

/// **Every key this operator holds that is in service now**, newest first, each
/// one's own row seal verified.
///
/// ADR-0055 resolution 1: any live key must be accepted wherever sign-in evidence
/// or grant signatures are verified (no `LIMIT 1`). With any browser and a key per
/// browser (decisions 6 and 1), an operator with a laptop and phone holds two live
/// keys and either must work.
///
/// A row whose seal does not verify is an ALARM, not a skipped key:
/// [`OperatorError::Unverifiable`] comes back, because ignoring an edited
/// `public_key` row would turn the alarm into a shrug.
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

/// **Take every key in `keys` out of service at `at_unix`**, re-sealing each row
/// at `row_version + 1` over the state that now stands.
///
/// Shared by [`OperatorStore::recover_operator`] (ADR-0055 fix (a)) and
/// [`OperatorStore::adopt_first_operator_from_install`] (decision 9):
/// `retired_at` is inside [`operator_key_row_state`], so a row updated without its
/// seal is an alarm on the next read rather than a retired key.
///
/// The guarded `WHERE ... retired_at IS NULL` makes it once against a concurrent
/// writer; `0024` grants the three columns and the `UPDATE` policy (operator
/// custody).
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

/// The operator-account binding's own interlock: the row seals, or nothing rests
/// on it. [`OperatorStore::verify_binding`]'s free half, for `sessions.rs`'s
/// operator-plane sign-in (ADR-0057 decision 2), which has no `OperatorStore`.
///
/// Called wherever a binding decides something (which seat a recovery restores,
/// which operator an account may register a key for). A hand-inserted row fails
/// here, so the binding cannot attach an operator custody to an account never
/// given one.
pub async fn verify_operator_binding(
    tx: &Transaction<'_>,
    ring: &KeyRing,
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
    let recomputed = authority::row_seal(
        &grants::site_row_key(tx, ring).await?,
        &RowFacts {
            table: "operator_account_bindings",
            row_id: operator,
            chain_seq: bound_seq,
            row_version,
            row_state: &binding_row_state(operator, account),
        },
    );
    if stored != recomputed {
        return Err(OperatorError::Unverifiable("operator account binding seal"));
    }
    Ok(())
}

/// The account bound to this operator's custody: the reverse of
/// [`OperatorStore::operator_of_account`], and its free half for `sessions.rs`.
/// The binding's seal is verified before the answer is believed.
///
/// ADR-0057 decision 2: an operator-plane sign-in must also prove a live session
/// of the account this returns.
pub async fn account_of_operator(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    operator: &str,
) -> Result<String, OperatorError> {
    let row = tx
        .query_opt(
            "SELECT account_id FROM operator_account_bindings WHERE operator_id = $1",
            &[&operator],
        )
        .await?;
    let Some(row) = row else {
        return Err(OperatorError::NotBoundToAnOperator);
    };
    let account: String = row.get(0);
    verify_operator_binding(tx, ring, operator, &account).await?;
    Ok(account)
}

/// A free function so `credentials.rs` can look up the operator custody an
/// account holds, if any, from inside its OWN transaction.
pub async fn operator_of_account(
    tx: &Transaction<'_>,
    ring: &KeyRing,
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
    verify_operator_binding(tx, ring, &operator, account).await?;
    let live = verify_operator_row(tx, ring, &operator).await?;
    if live.disabled_at_unix != 0 {
        return Err(OperatorError::NotBoundToAnOperator);
    }
    Ok(operator)
}

/// **The operator register's own interlock**: an operator row verifies only if its
/// seal recomputes AND the site-chain entry that created it verifies and names it.
///
/// §5.4's "no administrative change takes effect while its `sealed_seq` is `NULL`,
/// and nothing on the operator surface can stamp it", applied to the register. A
/// hand-inserted row fails at the seal; a row whose creating entry was removed
/// fails here. Called on the operator sign-in path, so **a minted operator cannot
/// sign in**.
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
            // ADR-0055 fix (d): inside the seal, because decision 3 made this
            // column decide whether a second signature is required at all.
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
        // The entry must name this operator. The one field that matters is
        // re-rendered and searched for as canonical bytes, rather than parsing the
        // metadata back (a second parser).
        let needle = {
            let mut map = BTreeMap::new();
            map.insert("operator".to_string(), Json::Str(row.id.clone()));
            let whole = Json::Obj(map).to_canonical_bytes();
            // `to_canonical_bytes` emits `{"operator":"…"}` plus a trailing newline;
            // the pair as it appears INSIDE the entry's own object needs the leading
            // `{` and trailing `}\n` removed. A unit test at the bottom of this file
            // pins the shape, since a wrong needle would make this check pass on
            // everything.
            whole[1..whole.len() - 2].to_vec()
        };
        if !contains(&entry.metadata, &needle) {
            return Err(OperatorError::Unverifiable("operator creation entry"));
        }
        Ok(row)
    }
}

/// **Record an operator's first independent sign-in (§5.5), once, and re-seal the
/// row** (ADR-0055 fix (d)).
///
/// The guarded `UPDATE ... WHERE first_independent_signin_at IS NULL` makes it once
/// against a concurrent second sign-in; the re-seal at `row_version + 1` makes it
/// once against whoever holds a database connection. Returns `true` when this call
/// recorded it.
///
/// # Why it takes a `KeyRing`
///
/// ADR-0055 decision 3 made this column gate whether a second signature is
/// required AT ALL, so moving it forward on every operator row would drive
/// [`quorum_for`] to 1 and let a single signature mint an operator.
/// `0015_operator_console.sql` grants that `UPDATE` to `fathom_app`; the seal is
/// the fence, and a seal needs the row key.
///
/// Read and write are in one transaction and the write is guarded on the same NULL
/// the read saw, so two racing sign-ins produce one time and one seal: the loser's
/// `UPDATE` matches no row and returns `false` without sealing anything.
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

    // The seal must cover the value the row will hold, so it is chosen here rather
    // than left to `now()` in the statement (a seal over a timestamp the database
    // picked later would not verify). Whole seconds, as every other time in these
    // seals.
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
/// It was a raw `UPDATE` of `operators.first_independent_signin_at` with no seal
/// update. Writing it now would leave the row failing its own seal at the next
/// `verify_operator_row` (on the sign-in path), so an operator who signed in once
/// could never sign in again. No caller remains; use
/// [`mark_first_independent_signin`].
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

    /// Issue one enrolment token: **its sealed entry, the row bound to that entry,
    /// and the token returned once.**
    ///
    /// §7.2's `enrolment_token_issued` is appended HERE, not by each caller, so
    /// every token this schema can hold was recorded when minted. The row's seal
    /// names this entry's `seq` (the "no entry, no act" order `sessions::sign_in`
    /// uses): stopping the log stops the issuance. The caller's own entry
    /// (`account_created`, `org_shell_created`, ...) records the act that warranted
    /// the token, a different fact.
    ///
    /// `lifetime` is a parameter, not [`ENROLMENT_TOKEN_LIFETIME`] at the point of
    /// use: the break-glass code lives ten minutes and everything else
    /// seventy-two hours, and every caller must state which.
    async fn issue_token(
        &self,
        tx: &Transaction<'_>,
        purpose: Purpose,
        subject: &str,
        issued_by: &str,
        reason: &str,
        lifetime: Duration,
    ) -> Result<Invitation, OperatorError> {
        let expires_at = now_unix() + lifetime.as_secs() as i64;
        self.issue_token_for(
            tx,
            purpose,
            subject,
            TokenIssuer::Operator(issued_by),
            reason,
            expires_at,
        )
        .await
    }

    /// [`OperatorStore::issue_token`] for either kind of issuer, with the expiry
    /// as an absolute time so a steward's invitation row can carry the same one.
    async fn issue_token_for(
        &self,
        tx: &Transaction<'_>,
        purpose: Purpose,
        subject: &str,
        issuer: TokenIssuer<'_>,
        reason: &str,
        expires_at: i64,
    ) -> Result<Invitation, OperatorError> {
        let issued_by = match issuer {
            TokenIssuer::Operator(id) => id,
            TokenIssuer::Steward { account, .. } => account,
        };
        let mut fields = vec![
            ("purpose", Json::Str(purpose.as_str().to_string())),
            ("subject", Json::Str(subject.to_string())),
            ("issued_by", Json::Str(issued_by.to_string())),
            ("reason", Json::Str(reason.to_string())),
        ];
        if let TokenIssuer::Steward { invitation, .. } = issuer {
            fields.push(("invitation", Json::Str(invitation.to_string())));
        }
        let issued = chains::append_site(
            tx,
            &self.ring,
            &self.deployment,
            EntryType::EnrolmentTokenIssued,
            &entry_metadata(EntryType::EnrolmentTokenIssued, &fields),
        )
        .await?;
        let issued_seq = issued.seq;
        let id = ids::new_ulid().to_string();
        let token = random_32()?;
        let hash = token_hash(&token);

        let (account, operator, shell) = match purpose {
            Purpose::Account => (Some(subject), None, None),
            Purpose::Operator | Purpose::Setup => (None, Some(subject), None),
            Purpose::Organisation => (None, None, Some(subject)),
        };
        // A steward's token has no operator behind it: the column holds NULL and
        // the seal covers the account and the invitation instead (`0037` §E).
        let (operator_issuer, steward_issuer, invitation) = match issuer {
            TokenIssuer::Operator(id) => (Some(id), None, None),
            TokenIssuer::Steward {
                account,
                invitation,
            } => (None, Some(account), Some(invitation)),
        };

        let facts = TokenFacts {
            id: &id,
            purpose,
            token_hash: &hash,
            subject,
            issued_by: operator_issuer.unwrap_or(""),
            issued_by_account: steward_issuer,
            invitation,
            expires_at_unix: expires_at,
            redeemed_at_unix: 0,
            expired_at_unix: 0,
        };
        let seal = self.token_seal(tx, &facts, issued_seq, 1).await?;

        tx.execute(
            "INSERT INTO enrolment_tokens \
                 (id, purpose, token_hash, account_id, operator_id, shell_id, issued_by, \
                  issued_by_account, invitation_id, issued_seq, expires_at, row_version, \
                  row_seal) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11::bigint), 1, $12)",
            &[
                &id,
                &purpose.as_str(),
                &hash.to_vec(),
                &account,
                &operator,
                &shell,
                &operator_issuer,
                &steward_issuer,
                &invitation,
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
    /// **Does not mark it redeemed**: that is `mark_redeemed`, after the act's own
    /// entry is appended, so the row's new seal names the entry recording the
    /// redemption.
    async fn spend_token(
        &self,
        tx: &Transaction<'_>,
        token: &[u8],
        purpose: Purpose,
    ) -> Result<TokenRow, OperatorError> {
        self.find_token(tx, token, purpose, TokenUse::Spend).await
    }

    /// The lookup and every check [`OperatorStore::spend_token`] makes, with the
    /// caller saying whether this is the act or a question about it.
    ///
    /// **ADR-0056 decision 1, step 1 of setup** asks whether a token is live
    /// without spending it, so the setup screen can name the address. One function,
    /// not two: a second copy of the seal, purpose, redemption and expiry checks is
    /// a second place to forget one, and the check route is where a caller would
    /// attack.
    ///
    /// [`TokenUse::Check`] differs only in that a token presented after expiry is
    /// not recorded as presented: a read writes nothing, and `note_expired`'s record
    /// would not survive the caller's rollback anyway.
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

        // The seal, before anything else is believed about the row. A token whose
        // `redeemed_at` was cleared to re-open it fails here, which makes a guarded
        // flag as strong as a delete (`0015` §E).
        let recomputed = self
            .token_seal(tx, &out.facts(), out.issued_seq, out.row_version)
            .await?;
        if stored_seal != recomputed {
            return Err(OperatorError::Unverifiable("enrolment token row seal"));
        }

        if out.redeemed_at_unix != 0 {
            return Err(OperatorError::EnrolmentRefused);
        }
        // **`expired_at` is a terminal state, not only a note.** It is also how
        // `expire_live_tokens` kills the token a re-issue replaces, whose
        // `expires_at` is still in the future: the runtime role is not granted
        // `UPDATE (expires_at)` (`0015` §I: "a token is issued once, and then
        // either redeemed or expired"), so the flag has to be the state.
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
    /// `enrolment_token_expired`), **once**: the guarded `UPDATE` is the latch, so
    /// presenting a dead token in a loop does not grow the chain.
    ///
    /// **`expired_at` and `expired_seq` move in ONE statement**: the table's
    /// `CHECK ((expired_at IS NULL) = (expired_seq IS NULL))` refuses the state
    /// between them. The seq is not known until the entry is appended, so the
    /// append goes first.
    ///
    /// **A caller that refuses AFTER calling this must commit if it wants the
    /// entry.** `spend_token` does not, and every caller of it drops the
    /// transaction, so the presentation record rolls back;
    /// [`OperatorStore::note_expiry_durably`] records it in a second transaction.
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

    /// Spend the token: a guarded `UPDATE` whose new state goes back into the seal.
    ///
    /// `WHERE redeemed_at IS NULL` makes it single-use against a concurrent second
    /// redemption (the first writer holds the row lock); the seal makes it
    /// single-use against whoever holds the database.
    ///
    /// `AND expired_at IS NULL AND row_version = $6`: spending a setup-class token
    /// expires the operator's other live ones ([`OperatorStore::expire_live_tokens`]),
    /// so a redemption can race an expiry of this same row. `redeemed_at IS NULL`
    /// alone would let that expiry commit unnoticed and this `UPDATE` clobber the
    /// row with a seal from stale facts (both columns set, sealed as if one),
    /// unverifiable ever after. Tying the write to the `row_version` read makes any
    /// intervening touch an ordinary refusal (`updated == 0`).
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
    /// `redeem_account_enrolment` and `redeem_operator_enrolment` refuse without
    /// committing (every check after `spend_token` runs in the transaction opened
    /// to spend the token), so an entry appended inside would roll back.
    /// `note_expired` reported this gap for one cause; this covers every cause.
    ///
    /// Called AFTER the refusing transaction's own work: it opens a fresh
    /// connection and transaction, so the entry survives however the caller's
    /// resolves.
    ///
    /// **`entry_type` is one of the two site-chain types `sessions.rs` already
    /// writes for a failed sign-in** ([`EntryType::AccountSigninFailed`] for an
    /// account redemption, [`EntryType::OperatorSigninFailed`] for an operator
    /// one). A failed redemption is the same fact to an operator reading the chain
    /// (someone lacking what the surface asked for), and a new `EntryType` needs a
    /// migration.
    ///
    /// **Best-effort.** A failure here is logged and swallowed, never turned into a
    /// 500: the caller gets [`OperatorError::EnrolmentRefused`] either way.
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

    /// Rolls `tx` back before recording the refusal on a second
    /// connection, so nothing a rejected claim wrote survives it.
    async fn refuse_redemption(
        &self,
        tx: Transaction<'_>,
        entry_type: EntryType,
        purpose: Purpose,
        reason: &'static str,
    ) -> OperatorError {
        if let Err(e) = tx.rollback().await {
            tracing::error!(error = %e, "could not roll back a refusing transaction");
        }
        self.record_redemption_refused(entry_type, purpose, reason)
            .await;
        OperatorError::EnrolmentRefused
    }

    /// [`OperatorStore::refuse_redemption`], but first re-derives the
    /// token and gives an expired one its own note.
    async fn refuse_expired_or_invalid_token(
        &self,
        tx: Transaction<'_>,
        token: &[u8],
        purpose: Purpose,
        entry_type: EntryType,
        reason: &'static str,
    ) -> OperatorError {
        if let Err(e) = tx.rollback().await {
            tracing::error!(error = %e, "could not roll back a refusing transaction");
        }
        self.note_expiry_durably(token, purpose).await;
        self.record_redemption_refused(entry_type, purpose, reason)
            .await;
        OperatorError::EnrolmentRefused
    }

    /// Best-effort, on its own connection: gives an expired, unflagged
    /// token `note_expired`'s entry.
    async fn note_expiry_durably(&self, token: &[u8], purpose: Purpose) {
        let hash = token_hash(token);
        let attempt: Result<(), OperatorError> = async {
            let mut client = self.pool.get().await?;
            let tx = client.transaction().await?;
            enter_enrolment_custody(&tx).await?;
            // Chain lock before the read, as every append takes it: concurrent callers note the expiry once.
            chains::lock_site(&tx, &self.deployment).await?;
            let row = tx
                .query_opt(
                    &format!("SELECT {TOKEN_COLUMNS} FROM enrolment_tokens WHERE token_hash = $1"),
                    &[&hash.to_vec()],
                )
                .await?;
            if let Some(row) = row {
                let (out, stored_seal) = token_row(&row)?;
                let recomputed = self
                    .token_seal(&tx, &out.facts(), out.issued_seq, out.row_version)
                    .await?;
                if out.purpose == purpose
                    && stored_seal == recomputed
                    && out.redeemed_at_unix == 0
                    && out.expired_at_unix == 0
                    && out.expires_at_unix <= now_unix()
                {
                    self.note_expired(&tx, &out).await?;
                }
            }
            leave_custody(&tx).await?;
            tx.commit().await?;
            Ok(())
        }
        .await;
        if let Err(e) = attempt {
            tracing::error!(error = %e, "could not record a token's own expiry");
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
/// Free, because `verify_operator_row` is: `sessions.rs` checks it on the sign-in
/// path without an `OperatorStore`.
///
/// **`first_independent_signin_at` is INSIDE it** (ADR-0055 fix (d)), and
/// [`mark_first_independent_signin`] is the only writer. ADR-0055 decision 3 made
/// the column gate whether a second signature is required AT ALL: moved forward on
/// every row, `live_independent_operators` reads 0, [`quorum_for`] reads 1, and
/// `apply_operator_request` mints a new operator on one signature.
/// `0015_operator_console.sql` grants `fathom_app`
/// `UPDATE (first_independent_signin_at)` and the `operators` write policy's WITH
/// CHECK is only the two custodies, so that write is reachable by the application
/// role, not only tier 3.
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

/// **The `row_state` an `operators` row was sealed under before ADR-0055's fix
/// round S2**: [`operator_row_seal`]'s map without `first_independent_signin_at`.
///
/// Written by every build from `d774af8` (the operator console and migration
/// `0015`) through `0aadb0f`; `6d1b5de` brought the column inside the seal.
///
/// **There is exactly one legacy shape, and this is it** (`git log -p -S
/// first_independent_signin_at -- crates/fathom-server/src/operators.rs` names
/// `d774af8`, `0aadb0f`, `6d1b5de`; `authority::row_seal` and `RowFacts` are
/// unchanged since `3c931c1`, which predates all three). A fourth shape would get
/// its own `legacy_operator_row_state_v2` and
/// [`OperatorStore::reseal_legacy_operator_rows`] would try both.
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
/// **Public for two callers and no others**:
/// [`OperatorStore::reseal_legacy_operator_rows`], which runs once at start to
/// convert such a seal into a current one, and the test that seals a row the way
/// the old build did.
///
/// **[`verify_operator_row`] does not call it and must never.** The sign-in path,
/// seconding path and every console verb verify against the CURRENT shape only;
/// accepting the old shape would leave `first_independent_signin_at` outside the
/// seal forever, the hole fix (d) closed.
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
    /// **Bring every `operators` row sealed by an older build up to this build's
    /// seal**, run by `main.rs` on every start before the bootstrap and adoption.
    ///
    /// # Why a deployment cannot start without this
    ///
    /// ADR-0055 fix (d) put `first_independent_signin_at` inside
    /// [`operator_row_seal`]. Earlier rows were sealed over
    /// [`legacy_operator_row_state_v1`], so [`verify_operator_row`] answers
    /// `Unverifiable("operator row seal")` for them on the sign-in path, in
    /// [`eligible_seconders_for`] (which verifies EVERY row) and in
    /// [`OperatorStore::adopt_first_operator_from_install`]. An upgraded deployment
    /// would refuse to start though it ran the day before.
    ///
    /// # What it will and will not do
    ///
    /// A row matching the current shape is left alone (a second run returns 0). One
    /// matching the legacy shape is re-sealed under the current shape at
    /// `row_version + 1`, touching only `row_seal` and `row_version` (the `UPDATE`
    /// `0015` §A grants `fathom_app`). One matching neither is
    /// [`OperatorError::UnverifiableOperatorRow`], by id, and `main.rs` refuses to
    /// start: no build of this server wrote it, and re-sealing would forge a seal
    /// over whatever somebody put there.
    ///
    /// **It launders nothing.** The re-seal proves only that the bytes are what an
    /// older build sealed; [`verify_operator_row`] still demands the sealed
    /// creation entry naming this operator. It carries the row's CURRENT
    /// `first_independent_signin_at` into the seal (under the old build the column
    /// was outside it, so a moved value cannot be told from an unmoved one).
    ///
    /// Runs under the bootstrap's advisory lock, as the adoption does: two
    /// containers would otherwise write the same `row_version + 1`.
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
            // Nothing deletes an `operators` row (no DELETE privilege or policy,
            // `0015` §A), so this raced nothing. Not an error either way.
            return Ok(false);
        };
        let stored: Option<Vec<u8>> = tx
            .query_one("SELECT row_seal FROM operators WHERE id = $1", &[&id])
            .await?
            .get(0);
        // A NULL seal or NULL `created_seq` is refused like a wrong seal: no older
        // shape could be their honest remains.
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
        // Guarded on the version read, so a second process that took the lock
        // first and re-sealed this row updates nothing rather than sealing a moved
        // `row_version`.
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

    /// `pub`, not `#[cfg(test)]` (`credentials.rs`'s `issue_reset_token`
    /// says why): lets `tests/operators.rs` re-seal a row it backdated.
    pub async fn token_seal(
        &self,
        tx: &Transaction<'_>,
        facts: &TokenFacts<'_>,
        issued_seq: i64,
        row_version: i32,
    ) -> Result<[u8; 32], OperatorError> {
        Ok(authority::row_seal(
            &grants::site_row_key(tx, &self.ring).await?,
            &RowFacts {
                table: "enrolment_tokens",
                row_id: facts.id,
                chain_seq: issued_seq,
                row_version,
                row_state: &token_row_state(facts),
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
    /// Derived from the **site chain key**, in the shape `authority::row_key` and
    /// `sessions::claimed_address_key` use: a site setting belongs to no
    /// organisation, and the site chain key is the one key common to all of them.
    ///
    /// **Not the master key hierarchy.** Every level below the master is a wrapped
    /// key row so `§12.6`'s re-wrap can move custody without re-encrypting. A site
    /// key row would need `keys::rewrap_master_key` to learn about it, or a re-wrap
    /// would leave the settings unopenable. Deriving from the chain key puts a
    /// value in the same custody as the same change's `value_digest`
    /// (`chain::site_metadata_key`). A decision the documents do not make; reported
    /// to the lead.
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

    /// Issue a `purpose = 'setup'` token for an operator who already exists.
    /// ADR-0057 decision 1's T is minted here, at every start.
    ///
    /// Its lifetime is [`credentials::SETUP_SECRET_WINDOW`], not seventy-two hours:
    /// `main.rs` enforces that window in memory, and the row must not outlive it
    /// whichever invitation it came from (bootstrap, adoption or an earlier start).
    ///
    /// **Deliberately no sweep of the operator's other live setup-class tokens.**
    /// Two containers starting together each mint one, and both must stay presentable
    /// until one is redeemed. [`CredentialStore::redeem_setup_by_token`]'s guarded
    /// `UPDATE` and its own sweep rely on that.
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
    /// ADR-0055 decision 10: this token opens the setup screen that sets a password
    /// and enrols the app code. `credentials.rs` is the one caller; the seal,
    /// expiry and `enrolment_token_redeemed` checks live here so they are not copied.
    ///
    /// **The caller must already hold `app.enrolment_custody`** (`0015` §H grants
    /// the `UPDATE` to that capability alone) and must commit for the redemption to
    /// stand. Every refusal is [`OperatorError::EnrolmentRefused`], one message for
    /// every cause.
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

    /// **Is this a live `purpose = 'setup'` token?** Says which operator it is for,
    /// spends nothing and writes nothing.
    ///
    /// ADR-0056 decision 1: the setup screen's first step asks this so it can name
    /// the address the token opens. The token is still the whole proof.
    ///
    /// **A read; the caller may roll back.** [`OperatorStore::spend_setup_token`] is
    /// still the only way a setup token stops being live. Every refusal is
    /// [`OperatorError::EnrolmentRefused`] (wrong, spent, expired and malformed
    /// alike), the same message redemption gives.
    ///
    /// **The caller must already hold `app.enrolment_custody`** (`0015` §H).
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
/// Two values and no `From<&str>`, as `sessions::Latch`: reading a token and
/// spending one must not be a flag computed from a string.
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
/// [`token_row`] expects. One constant, because a column added to one query and
/// not another is a row read at the wrong indices, which reads as corruption.
const TOKEN_COLUMNS: &str = "id, purpose, account_id, operator_id, shell_id, issued_by, \
     issued_seq, EXTRACT(EPOCH FROM expires_at)::bigint, \
     COALESCE(EXTRACT(EPOCH FROM redeemed_at)::bigint, 0), \
     COALESCE(EXTRACT(EPOCH FROM expired_at)::bigint, 0), row_version, row_seal, token_hash, \
     issued_by_account, invitation_id";

/// One `enrolment_tokens` row and **the seal as stored**, returned beside it
/// rather than checked: the two callers mean different things by a failure.
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
            // NULL for a steward's token (`0037` §E): the seal reads it as "".
            issued_by: row.get::<_, Option<String>>(5).unwrap_or_default(),
            issued_by_account: row.get(13),
            invitation_id: row.get(14),
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
    /// Read back from the row, never recomputed: the seal covers it, and the token
    /// it hashes is gone once handed out.
    token_hash: [u8; 32],
    account_id: Option<String>,
    operator_id: Option<String>,
    shell_id: Option<String>,
    issued_by: String,
    /// Set, with `invitation_id`, exactly on a steward's invitation token.
    issued_by_account: Option<String>,
    invitation_id: Option<String>,
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
            issued_by_account: self
                .invitation_id
                .as_ref()
                .and(self.issued_by_account.as_deref()),
            invitation: self.invitation_id.as_deref(),
            expires_at_unix: self.expires_at_unix,
            redeemed_at_unix: self.redeemed_at_unix,
            expired_at_unix: self.expired_at_unix,
        }
    }
}

/// The sealed state of one `enrolment_tokens` row, as canonical JSON. A pure
/// function so `tests/authority_vectors.rs` can pin its bytes: an operator's row
/// must keep sealing byte for byte as it did before `0037`.
pub fn token_row_state(facts: &TokenFacts<'_>) -> Vec<u8> {
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
    // Only a steward's token carries these, so an operator's row seals byte
    // for byte as it did before `0037`.
    if let Some(invitation) = facts.invitation {
        map.insert("invitation".to_string(), Json::Str(invitation.to_string()));
        map.insert(
            "issued_by_account".to_string(),
            Json::Str(facts.issued_by_account.unwrap_or("").to_string()),
        );
    }
    Json::Obj(map).to_canonical_bytes()
}

/// What a token row's seal covers.
///
/// **`token_hash` is in it**, re-read from the row: the token is handed out once
/// and never seen again, and a seal that skipped the hash would let a row be
/// repointed at a token somebody else chose.
pub struct TokenFacts<'a> {
    pub id: &'a str,
    pub purpose: Purpose,
    pub token_hash: &'a [u8; 32],
    pub subject: &'a str,
    pub issued_by: &'a str,
    /// A steward's invitation token names the steward's account and its
    /// invitation, and has no operator (`issued_by` is then empty). `None` on an
    /// operator's token, which is sealed exactly as before `0037`.
    pub issued_by_account: Option<&'a str>,
    pub invitation: Option<&'a str>,
    pub expires_at_unix: i64,
    pub redeemed_at_unix: i64,
    pub expired_at_unix: i64,
}

/// Who issued an enrolment token.
#[derive(Clone, Copy)]
enum TokenIssuer<'a> {
    Operator(&'a str),
    Steward {
        account: &'a str,
        invitation: &'a str,
    },
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
/// `grants`' `account_key_row_state` with `operator_id`; the table name inside the
/// seal keeps the two apart.
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
        // **Not read here**: this runs on the sign-in and act paths, which do not
        // need the binding, and joining `accounts` needs a custody they do not
        // take. `list_operators` reads the address (ADR-0055 stream (b)).
        address: None,
    }))
}

// ---------------------------------------------------------------------------
// ADR-0055 stream (b) -- the operator custody an account holds
//
// ADR-0055 decisions 1, 3, 4, 5, 7 and 8; `0019` (binding and floor), `0021`
// (hold), `0022` (quorum and new entry types).
// ---------------------------------------------------------------------------

/// **How many operators could actually second something**, inside a transaction
/// already holding the operator custody.
///
/// ADR-0055 decision 3: not disabled, with an independent sign-in on record that
/// is older than [`INDEPENDENCE_WINDOW`].
///
/// **Three of `0015` §G's four clauses, and not the quorum.** The trigger also
/// refuses a seconder the requester created (`0015_operator_console.sql`:719),
/// which is per requester; that is [`quorum_for`]. This count is the
/// deployment-wide fact decision 4's banner reports.
///
/// **The SQL does it, not a Rust filter**, so the count shares a snapshot with
/// the act that commits (`0014` finding 3).
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

/// **How many operators could second a request made by `requester`**: all four
/// of `0015` §G's clauses, in the transaction the act commits in.
///
/// The fourth clause, `seconder_created_by = requested_by`
/// (`0015_operator_console.sql`:719), is the one [`live_independent_operators`]
/// omits; omitting it made the quorum demand a signature the database refuses
/// (see [`Operator::is_eligible_to_second`]). `id <> requester` too, since §5.5
/// and `operator_requests`' CHECK refuse self-seconding and the trigger does not
/// test it.
///
/// **Every row in the register is verified, then the predicate is applied in
/// Rust** (ADR-0055 fix (d), which gives `first_independent_signin_at`'s place
/// inside [`operator_row_seal`] its meaning). `0015` grants `fathom_app`
/// `UPDATE (first_independent_signin_at)` and the write policy's `WITH CHECK` is
/// only the two custodies, so the application role can move it.
///
/// **Verifying only the SQL's candidates would be wrong.** The attack removes a
/// seconder: clear the column or set `disabled_at` on everybody and the quorum
/// falls to 1, and a filter never looks at the row edited out of its selection.
/// A row that does not verify is an alarm, not a skipped candidate (as
/// `live_operator_keys`).
///
/// The register is small (decision 4 says two), so this is a handful of seals on
/// the request, second and apply paths only.
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
/// seconders)`, ADR-0055 decision 3 made per requester by fix (c).
///
/// One is the requester's own signature. Two only when somebody exists who can
/// give the second; otherwise the request stands alone, with the delay.
pub async fn quorum_for(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    requester: &str,
) -> Result<i64, OperatorError> {
    Ok((1 + eligible_seconders_for(tx, ring, requester).await?).min(2))
}

/// Is this `0015` §G's seconder trigger refusing, rather than another database
/// error?
///
/// `fathom_seconder_is_independent` raises five sentences, each ending
/// `(admin design 5.5)`, the stable fragment (as `is_operator_floor`). Without
/// the match a refusal reached the operator as a 500 `Corrupt("operator plane")`,
/// an integrity alarm for a rule correctly applied.
fn is_seconder_refusal(e: &tokio_postgres::Error) -> bool {
    match e.as_db_error() {
        Some(db) => db.message().contains("(admin design 5.5)"),
        None => false,
    }
}

/// The bytes an `operator_account_bindings` row's seal covers.
///
/// Two fields, because the row has two facts: which operator, which account.
/// `bound_at` is outside (a timestamp claims nothing, unlike
/// `first_independent_signin_at`, which decision 3 made an authority fact), and
/// `bound_seq` is inside through [`RowFacts::chain_seq`], as every row binds its
/// creating entry.
fn binding_row_state(operator: &str, account: &str) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("account_id".to_string(), Json::Str(account.to_string()));
    map.insert("operator_id".to_string(), Json::Str(operator.to_string()));
    Json::Obj(map).to_canonical_bytes()
}

/// Is this the `0019` §C floor trigger refusing, rather than another database
/// error?
///
/// `RAISE EXCEPTION` arrives as `SQLSTATE P0001` and only the message tells it
/// from other `RAISE`s. Matched on a stable fragment of the sentence so a
/// punctuation edit does not turn a typed refusal back into
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
    /// account. Callers: the first start (the notice address) and
    /// `apply_operator_request` (the colleague's). Both run under
    /// `app.account_custody` as well, because `accounts_readable` (`0013` §A)
    /// admits that and not the operator custody.
    ///
    /// **An existing account is used, not duplicated**: one person, two
    /// custodies, one address (`accounts.email` is unique anyway).
    ///
    /// The account is a SHELL: no key, no membership, no credential. §6.4's rule
    /// that a grant names a subject who already has a registered key stops this
    /// being a route to authority.
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
                    // Inside the SEALED metadata, as `create_account_shell`.
                    ("address", Json::Str(address.to_string())),
                    ("display_name", Json::Str(display_name.to_string())),
                    ("reason", Json::Str("operator_custody".to_string())),
                ],
            ),
        )
        .await?;

        // `0004`: the principal row first, since the composite key that keeps an
        // operator id out of a membership runs through it.
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

    /// Write the sealed fact that this operator's custody is held by this account
    /// (`0019` §A).
    ///
    /// Written once: `0019`'s trigger refuses `UPDATE` and `DELETE` at every
    /// privilege level including the owner's, and the seal is what a tier-3
    /// attacker cannot forge. A handoff never rewrites a binding: the successor
    /// gets a new operator row and binding, and the predecessor is disabled
    /// (decision 5).
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
    /// [`verify_operator_binding`]'s method half.
    async fn verify_binding(
        &self,
        tx: &Transaction<'_>,
        operator: &str,
        account: &str,
    ) -> Result<(), OperatorError> {
        verify_operator_binding(tx, &self.ring, operator, account).await
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
        operator_of_account(tx, &self.ring, account).await
    }

    // -----------------------------------------------------------------------
    // ADR-0055 decision 1 -- the operator key a browser registers
    // -----------------------------------------------------------------------

    /// **`POST /admin/operators/self/key`**: the account signed in at this browser
    /// registers an operator key for it.
    ///
    /// ADR-0055 decision 1: there is no separate operator sign-in. A person signs
    /// in with address, credential and app code; if their account holds the
    /// operator custody, this is how the browser gets the key every operator act is
    /// signed with (`verify_operator_assertion`). Decision 6 ("any browser, no
    /// pairing"): a second browser registers a second key and both stay live, so
    /// `live_operator_keys` has no `LIMIT 1`.
    ///
    /// # Checked, in order
    ///
    /// 1. **A steward session.** An operator principal has no account binding, and
    ///    a route that took one would let an operator session mint itself a key.
    /// 2. **Not the setup-only session, and a confirmed app code on the account.**
    ///    An `A0` session reaches `/credentials/*` and nothing else. The assurance
    ///    check alone is not enough (ADR-0055 fix (g)): an account with one live
    ///    browser key reaches this route at `A1` with no app code ever enrolled.
    /// 3. **A live, sealed binding**, and an operator row that verifies and is not
    ///    disabled.
    /// 4. **The seat is not held.** `accounts.operator_key_hold_until` (`0021`,
    ///    decision 7): after a mailed credential reset, the seat waits for another
    ///    operator's confirmation or 24 hours. Otherwise a reset would restore the
    ///    seat by itself, which decision 7 refuses.
    ///
    /// The entry is `operator_key_enrolled` (`0022` §C), not `operator_enrolled`, so
    /// an auditor can tell a one-shot invitation being redeemed from someone who
    /// knew the credential registering a key.
    ///
    /// **`via` is the session's assurance** (`A0T` for credential and app code,
    /// `A1` for a key), not the `via=password` the lead's resolution 8 asked for.
    /// An account with a browser key arrives at `A1`, so the other name would file a
    /// false fact. The literal is also forbidden on a non-comment line by this
    /// module's gate test, and weakening that for an audit label is the wrong
    /// trade. Reported to the lead.
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
        // because every operator key used to arrive by redemption. This is the other
        // way in. It takes the same custody rather than widening the policy; the
        // verified session and the sealed binding above are what authorise it.
        enter_enrolment_custody(&tx).await?;
        tx.execute("SELECT set_config('app.account_custody', 'yes', true)", &[])
            .await?;

        let operator = self.operator_of_account(&tx, &account_id).await?;

        // **ADR-0055 fix (g): the app code, not the assurance.**
        //
        // An account holding the operator custody with ONE live account key escapes
        // the `A0` gate: password plus a key signature is `A1`, so
        // `sessions::verify_request`'s setup-only check does not run. That person
        // would register the operator key without ever enrolling the app code
        // decision 10 requires. It needs no database access:
        // `account_for_address` REUSES an existing account, and an ordinary steward
        // may register a browser key.
        //
        // So the question is the account's, not the session's.
        // `totp_last_step IS NOT NULL` is what `CredentialRow::totp_confirmed`
        // reads; it stays NULL until a real code has been accepted once
        // (`credentials::confirm_totp`).
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
                    // See the doc comment: the assurance IS the route.
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

    /// **`POST /admin/operators/{operator}/confirm-recovery`**: another operator
    /// clears the seat hold early.
    ///
    /// ADR-0055 decision 7: an account whose credential was reset by mail does not
    /// restore its operator custody by itself; the seat waits for another operator's
    /// confirmation or the 24-hour delay. This is the confirmation half; the delay
    /// half is [`OperatorStore::register_own_operator_key`] reading the clock.
    ///
    /// **Not the operator's own seat.** The colleague decision 7 worries about
    /// controls the mail server, and confirming their own recovery would be the
    /// control confirming itself.
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

    /// **`GET /admin/notices`**: the standing facts an operator session must show,
    /// derived from the chain and the register.
    ///
    /// Nothing is stored (the lead's resolution 6): a column somebody could clear is
    /// a banner somebody could clear, and both facts are about someone having done
    /// something they should not be able to hide.
    ///
    /// One space-separated line per notice, as `list_operators`:
    ///
    /// - `recovered_from_host <at_unix> <until_unix>`: ADR-0055 decision 8's
    ///   seven-day banner. Present while an `operator_recovered_from_host` entry
    ///   lies inside [`RECOVERY_BANNER_WINDOW`], **measured by the time inside that
    ///   entry's own seal, not `chain_entries.created_at`**, which nothing seals
    ///   (fix (e)). **The entry is verified before it is reported**: a row inserted
    ///   by whoever holds the database cannot raise a banner, and a row whose seal
    ///   was broken to suppress one is an alarm, not a silence.
    /// - `one_operator <live_independent> <weeks_since_install>`: decision 4's
    ///   standing banner, which escalates weekly and never blocks work. The number
    ///   is weeks since this deployment's own `operator_bootstrapped` entry, because
    ///   nothing stores the history of the count and a banner is no reason to add
    ///   storage.
    pub async fn notices(&self) -> Result<Vec<String>, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;

        let mut out = Vec::new();
        let now = now_unix();

        // **ADR-0055 fix (e): the newest entry of this type, whatever its
        // `created_at` says, verified, and then the SEALED time.**
        //
        // `created_at` is not in `chains::append_site`'s content hash or seal, so
        // filtering on it in the SELECT meant a row moved eight days back was never
        // selected: verification never ran and the banner went quiet with nothing
        // raised. (It needs a database owner; `fathom_app` holds only SELECT and
        // INSERT on `chain_entries`.)
        //
        // So the row is selected by seq alone, verified, and the window is measured
        // against the `at` in the entry's own sealed metadata. A row of this type
        // with no sealed `at` is an ALARM: the only code that appends this type
        // writes it, so such an entry is one this server did not write.
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

/// Turn on `app.operator_custody` for the rest of this transaction (`0015` §H).
///
/// The mirror of `sessions::enter_session_custody` and `repo::enter_key_custody`,
/// including that it first sets `app.design_capability` to its refusal: **an
/// operator transaction has no business reading a design payload** (§1.3).
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
/// because its point is to give the caller the key a session would need.
///
/// A second capability rather than a wider first: an unauthenticated caller must
/// not reach the tables the console writes.
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

/// Close both again before commit, so a connection handed back to the pool carries
/// nothing. `set_config(..., true)` already scopes them to the transaction.
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
/// The value always comes from a row this server read, never from a caller.
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

/// **One integer field out of a verified entry's sealed metadata** (ADR-0055 fix
/// (e)).
///
/// [`contains`] answers "does the entry say X?", not "what does it say?". A time
/// the banner compares against a clock needs the second, so the metadata is parsed
/// with `fathom_canon`'s parser, as `grants::verify_genesis_set` does.
///
/// A missing or wrongly-typed field is [`OperatorError::Unverifiable`], not a
/// default: this server wrote the entry or it did not.
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

/// Issue the enrolment token for a steward's invitation, in the caller's
/// transaction. The shell account and the invitation row must already be written
/// there; the caller holds `app.invitation_custody` and is the steward named.
/// `expires_at_unix` is the invitation row's own `asked_expires_at`.
pub(crate) async fn issue_invitation_token(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    tx: &Transaction<'_>,
    steward: &str,
    invitation: &str,
    account: &str,
    expires_at_unix: i64,
) -> Result<Invitation, OperatorError> {
    let deployment = chains::deployment_id(&**tx).await?;
    OperatorStore::new(pool.clone(), Arc::clone(ring), deployment)
        .issue_token_for(
            tx,
            Purpose::Account,
            account,
            TokenIssuer::Steward {
                account: steward,
                invitation,
            },
            "steward_invitation",
            expires_at_unix,
        )
        .await
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
