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
use crate::sessions::{PrincipalKind, VerifiedSession};

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
pub fn operator_request_bytes(deployment: &str, operator: &str, display_name: &str) -> Vec<u8> {
    let mut msg = Vec::with_capacity(160);
    crypto::lp(&mut msg, TAG_OPERATOR_REQUEST);
    crypto::lp(&mut msg, deployment.as_bytes());
    crypto::lp(&mut msg, operator.as_bytes());
    crypto::lp(&mut msg, display_name.as_bytes());
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
}

impl Purpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Account => "account",
            Self::Operator => "operator",
            Self::Organisation => "organisation",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "account" => Some(Self::Account),
            "operator" => Some(Self::Operator),
            "organisation" => Some(Self::Organisation),
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
}

impl Operator {
    /// §5.5's sentence for the console: *"created by X, never independently
    /// signed in"*, beside every operator until that stops being true.
    pub fn never_independently_signed_in(&self) -> bool {
        self.first_independent_signin_at_unix == 0
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
    pub invitation: Invitation,
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
    /// §5.3's `FATHOM_SINGLE_OPERATOR`. **Reduces the second signature to none
    /// and keeps the delay, the notice and (when it exists) the witness
    /// receipt.** Quorum 1 with no delay is not a configuration this product
    /// offers, and there is no code path here that shortens the delay.
    single_operator: bool,
}

impl OperatorStore {
    pub fn new(pool: Pool, ring: Arc<KeyRing>, deployment: String, single_operator: bool) -> Self {
        Self::with_delay(pool, ring, deployment, single_operator, SETTINGS_DELAY)
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
        single_operator: bool,
        settings_delay: Duration,
    ) -> Self {
        Self {
            pool,
            ring,
            deployment,
            settings_delay,
            single_operator,
        }
    }

    pub fn deployment(&self) -> &str {
        &self.deployment
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    pub fn single_operator(&self) -> bool {
        self.single_operator
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

        let invitation = self
            .issue_token(&tx, Purpose::Operator, &id, &id, "bootstrap")
            .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(Bootstrap {
            operator_id: id,
            invitation,
        })
    }

    /// §5.3's declaration: **write `single_operator_mode` at every startup**,
    /// *"so nobody can later claim two-person control was in force"*.
    ///
    /// Called by `main.rs` at startup when `FATHOM_SINGLE_OPERATOR` is set, and
    /// by nothing else. It is a sealed statement about how this deployment is
    /// configured, not a setting: there is no path here that turns the mode on
    /// or off, because the mode is read from the process's own configuration
    /// and a mode an operator could change through the console would be the
    /// second signature removing itself.
    ///
    /// **An entry per startup and not per act.** Two interchangeable containers
    /// restarting is the ordinary case, so this is bounded by restarts; an
    /// entry per change would be bounded by whatever an operator does.
    pub async fn record_single_operator_mode(&self) -> Result<i64, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::SingleOperatorMode,
            &entry_metadata(
                EntryType::SingleOperatorMode,
                &[
                    ("single_operator", Json::Bool(self.single_operator)),
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

    /// **A fresh enrolment token for the first operator, and only while no
    /// operator key has ever been enrolled.**
    ///
    /// The problem this answers: §6.3's token is handed out exactly once, in a
    /// file, and it is the only way into a new deployment. Lose it — a
    /// container restarted before anybody read it, a volume discarded, a
    /// terminal closed — and nothing re-bootstraps, because an operator row
    /// exists and [`OperatorStore::bootstrap_first_operator`] is idempotent by
    /// design. Before this, the only remedy was destroying the database.
    ///
    /// # The gate, which is the whole of this function
    ///
    /// **If any row exists in `operator_keys`, this refuses.** Not "if the
    /// first operator has a live key", not "if that operator has one": *any*
    /// row, retired or not. A re-issue that worked after enrolment would let
    /// whoever can run a command on this host mint an operator enrolment
    /// token, redeem it with a key of their own, and hold an operator session
    /// — without ever holding a key this deployment has seen. That is a
    /// backdoor with a subcommand in front of it, and no amount of logging
    /// makes it not one. Once a key exists, the way back in is another
    /// operator or a restore, and [`OperatorError::AlreadyEnrolled`] says so.
    ///
    /// A host-level attacker is tier 3 in
    /// `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §0.1 and already holds the key
    /// volume and the database, so this does not pretend to fence them out of
    /// the deployment. What it fences is the *window*: before enrolment there
    /// is no operator key in existence and so nothing to steal a march on —
    /// the installer and the attacker are in the same position, which is the
    /// position §6.3's own token file already puts them in. After enrolment
    /// there is a key, and this must not be a way around it.
    ///
    /// # Which operator
    ///
    /// Exactly one operator must exist and it must be the bootstrap one
    /// (`created_by IS NULL`). With no key enrolled anywhere, that is the only
    /// state the console can have produced: §5.5's operator-creation path
    /// needs two operator sessions, and an operator session needs an enrolled
    /// key. Anything else is a register this path cannot reason about, and it
    /// refuses rather than guessing which row to hand a token for.
    ///
    /// # The token it replaces
    ///
    /// **Any live, unredeemed operator token for that operator is expired
    /// first**, in the same transaction, each with its own sealed
    /// `enrolment_token_expired` entry. Two live tokens would be two bearer
    /// secrets for one enrolment, and the one this command is run because
    /// nobody can find is exactly the one nobody can account for: leaving it
    /// live would mean a deployment where the operator believes they hold the
    /// only way in while a lost file still holds another. The cost is that
    /// running this while somebody is mid-enrolment invalidates the token they
    /// are holding; they run it again and get the new one, which is the lesser
    /// harm and the recoverable one.
    ///
    /// Each of those rows' seals is verified before it is expired. A token row
    /// that does not verify is not re-sealed into a new state by this path —
    /// that would launder it — and the whole act refuses instead.
    ///
    /// The token is returned once, exactly as the bootstrap returns it, and it
    /// is the caller's job to write it where a human can read it. **Nothing in
    /// this module logs it.**
    pub async fn reissue_bootstrap_token(&self) -> Result<Reissued, OperatorError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        enter_enrolment_custody(&tx).await?;

        // The bootstrap's own lock, because this is the bootstrap's act: a
        // re-issue racing a first start must not read "no key enrolled" from
        // one snapshot and mint against another.
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended('fathom/operator/bootstrap', 0))",
            &[],
        )
        .await?;

        // THE GATE. Every row, retired or live, for every operator.
        let enrolled: i64 = tx
            .query_one("SELECT count(*) FROM operator_keys", &[])
            .await?
            .get(0);
        if enrolled > 0 {
            return Err(OperatorError::AlreadyEnrolled);
        }

        let rows = tx
            .query("SELECT id, created_by FROM operators", &[])
            .await?;
        if rows.is_empty() {
            // Nothing to re-issue for. The server's own first start is what
            // mints the first operator, and it has not run yet.
            return Err(OperatorError::NotFound("first operator"));
        }
        if rows.len() > 1 {
            return Err(OperatorError::Corrupt("operator register"));
        }
        let operator: String = rows[0].get(0);
        let created_by: Option<String> = rows[0].get(1);
        if created_by.is_some() {
            return Err(OperatorError::Corrupt("operator register"));
        }

        // The row's own seal, before a token is minted against it. An
        // `operators` row edited in the database is exactly how somebody would
        // point the first operator at a name nobody expects.
        let row = verify_operator_row(&tx, &self.ring, &operator).await?;
        if row.disabled_at_unix != 0 {
            return Err(OperatorError::OperatorDisabled);
        }

        let expired = self
            .expire_live_tokens(&tx, Purpose::Operator, &operator, "bootstrap_reissue")
            .await?;

        // `reason` is the field `issue_token` already carries for this — the
        // bootstrap's own token says `bootstrap` — and it is inside the sealed
        // metadata, so a reader holding the chain key can tell a token minted
        // from the host command line from one minted by the console. It is
        // deliberately not a new `EntryType`: the act IS an enrolment token
        // being issued, which is what `enrolment_token_issued` means, and a
        // new type would cost a migration rewriting a `CHECK` that three
        // migrations have already rewritten, for a distinction the sealed
        // metadata already carries.
        let invitation = self
            .issue_token(
                &tx,
                Purpose::Operator,
                &operator,
                &operator,
                "bootstrap_reissue",
            )
            .await?;
        let issued_seq: i64 = tx
            .query_one(
                "SELECT issued_seq FROM enrolment_tokens WHERE id = $1",
                &[&invitation.id],
            )
            .await?
            .get(0);

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(Reissued {
            operator_id: operator,
            invitation,
            issued_seq,
            expired,
        })
    }

    /// **Expire every live, unredeemed token of `purpose` for this subject**,
    /// so that a re-issue leaves one bearer secret alive and not two. Returns
    /// their ids -- ids, never tokens.
    ///
    /// **One function for both callers this store has**:
    /// [`OperatorStore::reissue_bootstrap_token`] (`purpose = operator`,
    /// `subject` the operator id) and [`OperatorStore::issue_account_enrolment`]
    /// (`purpose = account`, `subject` the account id). The two mint a new
    /// token in an otherwise identical shape — an operator's own reset and
    /// §5.1's account reset are the same act on two planes — so the kill that
    /// keeps a re-issue from leaving two live tokens belongs here once rather
    /// than twice. `subject` is checked against the column `purpose` names,
    /// never trusted to already match it.
    ///
    /// The kill is `expired_at`, with its `enrolment_token_expired` entry, and
    /// it is the only kill this schema offers: the runtime role is granted
    /// `UPDATE (redeemed_at, redeemed_seq, expired_at, expired_seq,
    /// row_version, row_seal)` on `enrolment_tokens` and nothing else
    /// (`0015` §I), because a token is issued once and then either redeemed or
    /// expired. Moving `expires_at` instead would need a privilege this design
    /// withholds on purpose, and a `revoked_at` column would change
    /// [`TokenFacts`] and so the seal over every token row a live database
    /// already holds. [`OperatorStore::spend_token`] refuses on the flag.
    async fn expire_live_tokens(
        &self,
        tx: &Transaction<'_>,
        purpose: Purpose,
        subject: &str,
        reason: &'static str,
    ) -> Result<Vec<String>, OperatorError> {
        // The column a subject id is checked against, chosen from a closed set
        // and never taken from a caller — `latch`'s own rule in `sessions.rs`,
        // restated here because this is the other place in the codebase a
        // column name is interpolated at all.
        let column = match purpose {
            Purpose::Account => "account_id",
            Purpose::Operator => "operator_id",
            Purpose::Organisation => "shell_id",
        };
        let rows = tx
            .query(
                &format!(
                    "SELECT {TOKEN_COLUMNS} FROM enrolment_tokens \
                      WHERE purpose = $1 AND {column} = $2 \
                        AND redeemed_at IS NULL AND expired_at IS NULL \
                      ORDER BY id"
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
            // the state between them.
            let updated = tx
                .execute(
                    "UPDATE enrolment_tokens \
                        SET expired_at = to_timestamp($2::bigint), expired_seq = $3, \
                            row_version = $4, row_seal = $5 \
                      WHERE id = $1 AND redeemed_at IS NULL AND expired_at IS NULL",
                    &[&token.id, &now, &appended.seq, &version, &seal.to_vec()],
                )
                .await?;
            if updated != 1 {
                // The read above and this write are one transaction under the
                // bootstrap advisory lock, so this cannot happen; a row that
                // moved underneath us is a state this path will not write over.
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
            .issue_token(&tx, Purpose::Account, &account, &acting, "account_shell")
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
            .issue_token(&tx, Purpose::Account, account, &acting, "reissued")
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
            .issue_token(&tx, Purpose::Organisation, &shell, &acting, "org_shell")
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
                row.created_seq.unwrap_or(appended.seq),
                version,
            )
            .await?;
        tx.execute(
            "UPDATE operators \
                SET disabled_at = to_timestamp($2::bigint), row_version = $3, row_seal = $4 \
              WHERE id = $1",
            &[&target, &now, &version, &seal.to_vec()],
        )
        .await?;

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
        let rows = tx
            .query(
                "SELECT id, display_name, created_by, created_seq, \
                        COALESCE(EXTRACT(EPOCH FROM first_independent_signin_at)::bigint, 0), \
                        COALESCE(EXTRACT(EPOCH FROM disabled_at)::bigint, 0), row_version \
                   FROM operators ORDER BY created_at",
                &[],
            )
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
                    ("single_operator", Json::Bool(self.single_operator)),
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
            single_operator: self.single_operator,
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
                &self.single_operator,
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

        tx.execute(
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
        .await?;

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
        // **`self.single_operator()`, not `row.facts.single_operator`.** The
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
        if !first_version && row.facts.seconded_by.is_none() && !self.single_operator() {
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
                    // The live value this apply was actually gated on, same
                    // as the condition above -- not the row's own stamped
                    // request-time field, for the same reason.
                    ("single_operator", Json::Bool(self.single_operator())),
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
    pub async fn request_operator(
        &self,
        operator: &VerifiedSession,
        display_name: &str,
        signature: &[u8],
    ) -> Result<PendingChange, OperatorError> {
        let acting = self.acting_operator(operator)?;
        if display_name.trim().is_empty() || display_name.len() > 200 {
            return Err(OperatorError::Malformed("display name"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_operator_custody(&tx).await?;
        // The register's own half of the same question, in the transaction the
        // act runs in (§1.1: a suspended operator stops at the next request).
        self.check_operator_live(&tx, &acting).await?;

        let message = operator_request_bytes(&self.deployment, &acting, display_name);
        self.verify_operator_assertion(&tx, &acting, &message, signature)
            .await?;

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
                    ("requested_by", Json::Str(acting.clone())),
                    ("effective_at", Json::Int(effective_at)),
                    ("single_operator", Json::Bool(self.single_operator)),
                    ("state", Json::Str("requested".to_string())),
                ],
            ),
        )
        .await?;

        let facts = OperatorRequestFacts {
            id: &id,
            display_name,
            requested_by: &acting,
            request_sig: signature,
            seconded_by: None,
            second_sig: None,
            single_operator: self.single_operator,
            effective_at_unix: effective_at,
            cancelled_at_unix: 0,
            applied_at_unix: 0,
            sealed_seq: None,
            created_operator_id: None,
        };
        let seal = self.request_seal(&tx, &facts, appended.seq, 1).await?;

        tx.execute(
            "INSERT INTO operator_requests \
                 (id, display_name, requested_by, request_sig, requested_seq, single_operator, \
                  effective_at, row_version, row_seal) \
             VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::bigint), 1, $8)",
            &[
                &id,
                &display_name,
                &acting,
                &signature.to_vec(),
                &appended.seq,
                &self.single_operator,
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

        tx.execute(
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
        .await?;

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

        let rows = tx
            .query(
                "SELECT id FROM operator_requests \
                  WHERE applied_at IS NULL AND cancelled_at IS NULL AND effective_at <= now() \
                    AND (seconded_by IS NOT NULL OR single_operator) \
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
        // **`self.single_operator()`, live, not `row.single_operator`.** Same
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
        if row.seconded_by.is_none() && !self.single_operator() {
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
                    ("single_operator", Json::Bool(self.single_operator())),
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

        // §5.5's *"a first sign-in that must register an authenticator"*: the
        // new operator exists and has no key, and the only way they get one is
        // this token.
        let invitation = self
            .issue_token(
                tx,
                Purpose::Operator,
                &operator_id,
                &row.requested_by,
                "operator_created",
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
        let key = self.live_operator_key(tx, operator, now_unix()).await?;
        authority::verify_es256(&key.public_key, message, signature)?;
        Ok(())
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
    {
        let row = tx
            .query_opt(
                "SELECT id, operator_id, public_key, fpr, enrolled_seq, row_version, \
                        COALESCE(EXTRACT(EPOCH FROM retired_at)::bigint, 0), row_seal \
                   FROM operator_keys \
                  WHERE operator_id = $1 AND retired_at IS NULL \
                  ORDER BY enrolled_seq DESC LIMIT 1",
                &[&operator],
            )
            .await?;
        let Some(row) = row else {
            return Err(OperatorError::NoOperatorKey);
        };
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
            &grants::site_row_key(tx, ring).await?,
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
            return Err(OperatorError::NoOperatorKey);
        }
        Ok(key)
    }
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

/// Record an operator's first independent sign-in (§5.5), once.
///
/// Called by `sessions.rs` on a successful operator sign-in. **Not inside the
/// row seal**, deliberately: it is a fact the sign-in path records about a row
/// it does not own, exactly as `sessions.last_seen_at` is outside the session
/// MAC. What it gates — seconding — additionally requires a signature by that
/// operator's own key, so a backdated timestamp buys an attacker nothing they
/// could not already do with the key they would still need.
pub async fn note_first_signin(tx: &Transaction<'_>, operator: &str) -> Result<(), OperatorError> {
    tx.execute(
        "UPDATE operators SET first_independent_signin_at = now() \
          WHERE id = $1 AND first_independent_signin_at IS NULL",
        &[&operator],
    )
    .await?;
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
            .operator_seal(tx, id, display_name, created_by, 0, created_seq, 1)
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
    async fn issue_token(
        &self,
        tx: &Transaction<'_>,
        purpose: Purpose,
        subject: &str,
        issued_by: &str,
        reason: &str,
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
        let expires_at = now_unix() + ENROLMENT_TOKEN_LIFETIME.as_secs() as i64;

        let (account, operator, shell) = match purpose {
            Purpose::Account => (Some(subject), None, None),
            Purpose::Operator => (None, Some(subject), None),
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
            self.note_expired(tx, &out).await?;
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
                  WHERE id = $1 AND redeemed_at IS NULL",
                &[&row.id, &now, &redeemed_seq, &version, &seal.to_vec()],
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
/// **`first_independent_signin_at` is deliberately outside it**, and
/// [`note_first_signin`] carries the argument.
#[allow(clippy::too_many_arguments)]
pub async fn operator_row_seal(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    id: &str,
    display_name: &str,
    created_by: Option<&str>,
    disabled_at_unix: i64,
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
                        sealed_seq, created_operator_id, row_version \
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
            Purpose::Operator => self.operator_id.as_deref().unwrap_or(""),
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
    }))
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
            operator_request_bytes("D", "OP", "Sam"),
            operator_second_bytes("D", "OP", "R", "Sam")
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
