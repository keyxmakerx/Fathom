//! **The person's credential**: a password, an app code, ten backup codes, and
//! the two ways back in when one of them is lost.
//!
//! ADR-0055 (`docs/decisions/adr-0055-one-person-two-custodies.md`, accepted
//! 2026-09-21) decision 10, built to the contract in
//! `docs/archive/2026-09-21-adr-0055-build-contracts.md` stream (a).
//! `migrations/0018_credentials.sql` is the schema and carries the reasoning
//! for every column, every policy and the third `sessions.assurance` value;
//! `migrations/0021_operator_seat_hold.sql` is the hold a reset puts on the
//! operator seat. This file holds the bytes and the order things happen in,
//! and `api.rs` is the HTTP surface over it.
//!
//! # The line this module does not cross
//!
//! **A network device's credential still never arrives.** CLAUDE.md rule 4 and
//! ADR-0045 are untouched: what is added here is the credential a PERSON uses
//! to open their own session, which is a different noun the redaction gate was
//! never about. `0018`'s own header states the same boundary at the schema, and
//! `tests/operators.rs` keeps every other handler in this server forbidden from
//! carrying a password-shaped field.
//!
//! **This reopens `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4.5 by the owner's
//! own decision, recorded in ADR-0055's header, and nowhere else.**
//!
//! # What guards what
//!
//! Two capabilities `0018` §E creates, and one it reuses:
//!
//! * `app.credential_custody` — a verified session doing its OWN credential
//!   work. Every route below that names [`crate::api::Signed`] runs under it,
//!   for one transaction, after the session has already proved itself.
//! * `app.reset_custody` — the unauthenticated forgot/reset pair. No session
//!   exists yet, and the token stands in for one: single use, 24 hours, sealed,
//!   and bound to an account the SERVER chose from the address on record.
//! * `app.session_custody` — sign-in's own, reused by `sessions.rs` to read the
//!   password hash and the app-code columns inside the same transaction that
//!   writes the session row.
//!
//! # Four things that are true of every route here
//!
//! 1. **The acting account comes from the session, never from the body.**
//!    §13 item 1, kept the same way `api.rs` keeps it: the routes take a
//!    [`VerifiedSession`] and read the account off it.
//! 2. **Every act is a sealed site-chain entry, appended before the row it is
//!    about.** No entry, no act — the order `sessions::attempt_sign_in` uses
//!    and for the same reason.
//! 3. **Nothing here re-displays a secret.** The TOTP secret is shown once, at
//!    enrolment, because the person has to type it into an application; it is
//!    sealed at rest and there is no route that reads it back out. The ten
//!    backup codes are returned once, hashed at rest, and single use.
//! 4. **No refusal explains which check it failed**, except the password
//!    policy — which is a statement about the caller's OWN proposed password
//!    and tells an attacker nothing they did not supply themselves.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use deadpool_postgres::{Pool, PoolError, Transaction};
use fathom_canon::Json;
use hmac::digest::KeyInit;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::authority::{self, RowFacts};
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError, CHAIN_KEY_EPOCH};
use crate::crypto::{self, Key32};
use crate::grants::{self, AuthorityError};
use crate::ids;
use crate::keys::KeyRing;
use crate::operators::{self, OperatorError};
use crate::sessions::{PrincipalKind, SessionError, VerifiedSession};

// ---------------------------------------------------------------------------
// The labels
// ---------------------------------------------------------------------------

/// HKDF `info` from the site chain key → the key the TOTP secret is sealed
/// under. `0018` §B names it.
const KDF_CREDENTIALS_TOTP: &[u8] = b"fathom/credentials/totp/v1";

/// The AEAD's additional data for a sealed TOTP secret.
const AAD_CREDENTIALS_TOTP: &[u8] = b"fathom/credentials/totp/aad/v1";

/// Hash tag of a backup code. `0018` §C names it.
const TAG_BACKUP_CODE: &[u8] = b"fathom/credentials/backup/code/v1";

/// Hash tag of a password-reset token. `0018` §D names it.
const TAG_RESET_TOKEN: &[u8] = b"fathom/credentials/reset/token/v1";

/// **Every label this module introduces**, for
/// `docs/PHASE-2-STORAGE-DESIGN.md` §12.2's table, which owns them. Same
/// contract as [`crate::sessions::LABELS`] and [`crate::operators::LABELS`]:
/// the table wins over this file, and a unit test at the bottom asserts that
/// every label the code uses is listed here.
pub const LABELS: &[(&str, &str)] = &[
    (
        "fathom/credentials/totp/v1",
        "HKDF `info` from the SITE chain key → the key an account's TOTP secret is sealed \
         under (0018 §B). A label separates USES of one key; 0013's departure 2 carries the \
         argument, and `operators::settings_key` is the same shape one setting over",
    ),
    (
        "fathom/credentials/totp/aad/v1",
        "the AEAD's additional data for a sealed TOTP secret: LP(tag) ‖ LP(deployment) ‖ \
         LP(account) ‖ u32(key_epoch), so a secret lifted onto another account's row or \
         another deployment does not open",
    ),
    (
        "fathom/credentials/backup/code/v1",
        "hash tag of a backup code: H(LP(tag) ‖ LP(code)) (0018 §C). A database read hands an \
         attacker a hash and a hash cannot be signed in with",
    ),
    (
        "fathom/credentials/reset/token/v1",
        "hash tag of a password-reset token: H(LP(tag) ‖ LP(token)) (0018 §D). The token \
         itself is returned once, in the mailed link, and never stored",
    ),
];

// ---------------------------------------------------------------------------
// The numbers, every one of them cited
// ---------------------------------------------------------------------------

/// The shortest password this server accepts.
///
/// **Fifteen**, ADR-0055 decision 10, whose own citation is NIST SP 800-63B
/// revision 4 §3.1.1.2 as the ADR read it on 2026-09-21: a password used alone
/// must be at least fifteen characters, and at least eight when a second
/// factor stands beside it. This build takes the higher of the two for every
/// account, because the account that most needs the floor — the one holding the
/// operator custody — is exactly the one the ADR requires a second factor of,
/// and two rules would mean the weaker one applies somewhere.
pub const PASSWORD_MIN: usize = 15;

/// The longest. ADR-0055 decision 10: *"at least 15 characters and at most
/// 128"*. An upper bound exists at all because the hash below is memory-hard
/// and an unbounded input is an unbounded amount of work an unauthenticated
/// caller chooses.
pub const PASSWORD_MAX: usize = 128;

/// Argon2id's memory cost, in kibibytes.
///
/// **Looked up at build time, not fixed from memory** — ADR-0055 decision 10
/// says so explicitly and CLAUDE.md rule 1 requires it. Source: the OWASP
/// Password Storage Cheat Sheet,
/// `https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Password_Storage_Cheat_Sheet.md`,
/// read 2026-09-21, which opens with *"Use Argon2id with a minimum
/// configuration of 19 MiB of memory, an iteration count of 2, and 1 degree of
/// parallelism"* and lists `m=19456 (19 MiB), t=2, p=1` among five settings it
/// calls *"an equal level of defense, and the only difference is a trade off
/// between CPU and RAM usage."*
///
/// The sheet's own headline minimum is taken rather than one of the other four,
/// because a server answering many sign-ins at once pays the memory figure per
/// concurrent hash and the sheet is explicit that the five are equivalent.
pub const ARGON2_M_COST: u32 = 19456;

/// Argon2id's iteration count. Same source, same line: `t=2`.
pub const ARGON2_T_COST: u32 = 2;

/// Argon2id's degree of parallelism. Same source, same line: `p=1`.
pub const ARGON2_P_COST: u32 = 1;

/// RFC 6238's time step, in seconds. ADR-0055 decision 10: *"30-second step"*.
pub const TOTP_STEP_SECONDS: i64 = 30;

/// How many digits a code has. RFC 4226 §5.3's truncation, six of them, which
/// is what every authenticator application produces.
pub const TOTP_DIGITS: u32 = 6;

/// How many steps either side of the current one are accepted. ADR-0055
/// decision 10: *"one step of skew"*.
pub const TOTP_SKEW_STEPS: i64 = 1;

/// How many bytes of secret. RFC 4226 §4 R6 requires at least 128 bits and
/// recommends 160; 160 is what a SHA-1 HMAC's block structure wants and what
/// every authenticator application is tested against.
pub const TOTP_SECRET_LEN: usize = 20;

/// Ten backup codes, ADR-0055 decision 10: *"Ten single-use backup codes,
/// hashed, shown once at enrolment, for the lost phone."*
pub const BACKUP_CODE_COUNT: usize = 10;

/// Sixteen Crockford base32 characters — **eighty bits**, the lead's
/// resolution 3 of the contracts' open issue 3, rendered `xxxx-xxxx-xxxx-xxxx`.
/// Eighty bits of a single-use secret behind a rate limit is far past what a
/// guessing attack reaches; the length is chosen so a person can read one off
/// paper and type it without an ambiguous character in it.
pub const BACKUP_CODE_CHARS: usize = 16;

/// Crockford base32's alphabet: the decimal digits and the letters, less
/// `I`, `L`, `O` and `U`. The first three are dropped because they are read as
/// `1`, `1` and `0`; `U` is dropped because it turns a random string into a
/// word somebody has to read out.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// RFC 4648 §6's alphabet, for the `otpauth://` secret. **Not Crockford** —
/// an authenticator application parses RFC 4648 and nothing else.
const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// How long a reset token lives. ADR-0055 decision 7: *"at least 128 bits,
/// single use, 24 hours"*.
pub const RESET_TOKEN_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// How many bytes of reset token. **Thirty-two — wider than decision 7's
/// 128-bit floor**, chosen by the contracts to match `enrolment_tokens`' own
/// 32-byte convention rather than invent a second size.
pub const RESET_TOKEN_LEN: usize = 32;

/// How long a reset holds the operator seat shut.
///
/// ADR-0055 decision 7: a mailed reset *"does not restore that custody by
/// itself: the seat waits for another operator's confirmation or the 24-hour
/// delay with notice to every operator, so a colleague who controls the mail
/// server cannot reset their way into a second seat."*
/// `0021_operator_seat_hold.sql` is the column; this is the interval written
/// into it.
pub const OPERATOR_KEY_HOLD: Duration = Duration::from_secs(24 * 60 * 60);

/// The bundled list of the most common passwords, compiled in.
///
/// `deps/decisions/common-passwords.md` records the URL, the licence, the
/// fetch date and the SHA-256 of these exact bytes. It is compared
/// **lowercased**, because the dictionary an attacker runs is case-folded and
/// a check that is not would refuse `password` and accept `Password`.
const COMMON_PASSWORDS: &str = include_str!("../data/common-passwords.txt");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything this layer refuses, and why.
///
/// **The four policy variants are the only ones that explain themselves**, and
/// they are safe to: each is a statement about a password the caller just
/// chose and already holds. Every other refusal is uniform, for
/// `SessionError::SignInRefused`'s reason.
#[derive(Debug)]
pub enum CredentialError {
    Db(tokio_postgres::Error),
    Pool(PoolError),
    Chain(ChainStoreError),
    Session(SessionError),
    Authority(AuthorityError),
    Operator(Box<OperatorError>),
    Crypto(crypto::CryptoError),

    /// Shorter than [`PASSWORD_MIN`].
    PasswordTooShort,
    /// Longer than [`PASSWORD_MAX`].
    PasswordTooLong,
    /// On the bundled list of common passwords.
    PasswordIsCommon,
    /// Contains the account's own address. ADR-0055 decision 10.
    PasswordContainsAddress,

    /// The app code did not verify, or has already been used for its own step.
    /// One variant for both, because they are one fact from outside.
    CodeRefused,
    /// This account has no app code enrolled yet, and the act needs one.
    NoTotpEnrolled,
    /// This account already has a confirmed app code, so enrolment would
    /// replace a live second factor from inside a session.
    TotpAlreadyEnrolled,
    /// A token — reset or setup — did not name a live row, or did and then
    /// failed a check. One variant for every cause.
    TokenRefused,
    /// This session is not a steward session, so it has no account of its own
    /// to do credential work on.
    NotAnAccountSession,
    /// The account holds the operator custody and has no app code yet: the
    /// session is a setup session and may do nothing but finish the setup.
    TotpRequired,
    /// A stored row does not verify under this deployment's keys.
    Unverifiable(&'static str),
    /// A field of a message was not the shape it must be.
    Malformed(&'static str),
    /// A stored row does not decode as what its column says it is.
    Corrupt(&'static str),
}

impl core::fmt::Display for CredentialError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Pool(_) => f.write_str("no database connection was available"),
            Self::Chain(e) => write!(f, "{e}"),
            Self::Session(e) => write!(f, "{e}"),
            Self::Authority(e) => write!(f, "{e}"),
            Self::Operator(e) => write!(f, "{e}"),
            Self::Crypto(e) => write!(f, "{e}"),
            Self::PasswordTooShort => write!(
                f,
                "a password must be at least {PASSWORD_MIN} characters. There are no \
                 composition rules and no expiry: length is the whole of the requirement"
            ),
            Self::PasswordTooLong => {
                write!(f, "a password must be at most {PASSWORD_MAX} characters")
            }
            Self::PasswordIsCommon => f.write_str(
                "that is one of the most common passwords in use and is the first thing an \
                 attacker tries. Choose another",
            ),
            Self::PasswordContainsAddress => f.write_str(
                "a password must not contain the address it opens, in any case: the address is \
                 the one thing an attacker already knows",
            ),
            Self::CodeRefused => f.write_str(
                "that code was refused. One message for every cause, so that a caller cannot \
                 tell a wrong code from one that has already been used",
            ),
            Self::NoTotpEnrolled => {
                f.write_str("this account has no app code enrolled, and this act needs one")
            }
            Self::TotpAlreadyEnrolled => f.write_str(
                "this account already has a confirmed app code. Replacing a live second factor \
                 from inside a session is not a form; it is a recovery, and it goes through the \
                 host command ADR-0055 decision 8 names",
            ),
            Self::TokenRefused => f.write_str(
                "that token was refused. One message for every cause: unknown, already spent, \
                 expired, or for a different purpose",
            ),
            Self::NotAnAccountSession => f.write_str(
                "an operator session has no account of its own, so it has no credential to \
                 change here. The operator custody is exercised through /admin",
            ),
            Self::TotpRequired => f.write_str(
                "this account holds the operator custody and has no app code yet, so its \
                 session may do nothing but finish the setup (ADR-0055 decision 10)",
            ),
            Self::Unverifiable(what) => write!(
                f,
                "the {what} does not verify under this deployment's keys, so it was not written \
                 by this server. This is not a permission error and must never render as one"
            ),
            Self::Malformed(what) => write!(f, "the {what} is not the shape it must be"),
            Self::Corrupt(what) => write!(f, "a stored {what} is not consistent"),
        }
    }
}

impl std::error::Error for CredentialError {}

impl From<tokio_postgres::Error> for CredentialError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}
impl From<PoolError> for CredentialError {
    fn from(e: PoolError) -> Self {
        Self::Pool(e)
    }
}
impl From<ChainStoreError> for CredentialError {
    fn from(e: ChainStoreError) -> Self {
        Self::Chain(e)
    }
}
impl From<SessionError> for CredentialError {
    fn from(e: SessionError) -> Self {
        Self::Session(e)
    }
}
impl From<AuthorityError> for CredentialError {
    fn from(e: AuthorityError) -> Self {
        Self::Authority(e)
    }
}
impl From<OperatorError> for CredentialError {
    fn from(e: OperatorError) -> Self {
        Self::Operator(Box::new(e))
    }
}
impl From<crypto::CryptoError> for CredentialError {
    fn from(e: crypto::CryptoError) -> Self {
        Self::Crypto(e)
    }
}

// ---------------------------------------------------------------------------
// The password
// ---------------------------------------------------------------------------

/// Argon2id at the parameters [`ARGON2_M_COST`] and its two neighbours name.
///
/// Built per call rather than held in a `static`, because the parameters are
/// three integers and the cost of constructing one is nothing beside the
/// memory-hard hash it is about to run.
fn hasher() -> Result<Argon2<'static>, CredentialError> {
    let params = Params::new(ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST, None)
        .map_err(|_| CredentialError::Corrupt("argon2 parameters"))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// Hash a password into the PHC string `accounts.password_hash` holds.
///
/// **The salt comes from `getrandom`**, the one generator this crate draws
/// from (`crypto::Key32::random`'s own rule), never from a userspace generator
/// with its own state — which is why `argon2`'s `rand` feature is off in the
/// manifest.
pub fn hash_password(password: &str) -> Result<String, CredentialError> {
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|_| CredentialError::Corrupt("random source"))?;
    let salt = SaltString::encode_b64(&salt).map_err(|_| CredentialError::Corrupt("salt"))?;
    Ok(hasher()?
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| CredentialError::Corrupt("password hash"))?
        .to_string())
}

/// Verify a password against a stored PHC string.
///
/// **The parameters come from the stored hash, not from this file.** That is
/// why `0018` §A stores the whole encoded string in one column: a later change
/// to [`ARGON2_M_COST`] does not strand every row hashed under the old one.
///
/// A stored string this build cannot parse is `false` and not an error — it is
/// the same answer a wrong password gets, because the alternative tells a
/// caller which accounts have an unreadable hash.
pub fn verify_password(stored: &str, password: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// ADR-0055 decision 10's policy, whole: **15 to 128 characters, no
/// composition rules, no expiry, not on the bundled common list, and not
/// containing the address it opens.**
///
/// The length is counted in `char`s and not bytes, because a person choosing a
/// passphrase in a language that is not English should not be told it is too
/// long for being spelled in more bytes.
pub fn check_password(password: &str, address: &str) -> Result<(), CredentialError> {
    let length = password.chars().count();
    if length < PASSWORD_MIN {
        return Err(CredentialError::PasswordTooShort);
    }
    if length > PASSWORD_MAX {
        return Err(CredentialError::PasswordTooLong);
    }
    let lowered = password.to_lowercase();
    if is_common_password(&lowered) {
        return Err(CredentialError::PasswordIsCommon);
    }
    // The whole address, and the local part on its own: `alice@example.org`
    // and `alice` are both things an attacker reads off the sign-in form.
    let address = address.to_lowercase();
    if !address.is_empty() && lowered.contains(&address) {
        return Err(CredentialError::PasswordContainsAddress);
    }
    if let Some((local, _)) = address.split_once('@') {
        if local.chars().count() >= 3 && lowered.contains(local) {
            return Err(CredentialError::PasswordContainsAddress);
        }
    }
    Ok(())
}

/// Is this — already lowercased — on the bundled list?
///
/// A linear scan over ten thousand short lines, on a path that is about to run
/// a memory-hard hash costing nineteen mebibytes. Building an index would be
/// optimising the cheap half.
fn is_common_password(lowered: &str) -> bool {
    COMMON_PASSWORDS
        .lines()
        .any(|line| !line.is_empty() && line.eq_ignore_ascii_case(lowered))
}

// ---------------------------------------------------------------------------
// The app code — RFC 6238
// ---------------------------------------------------------------------------

/// RFC 6238's `T`: the number of [`TOTP_STEP_SECONDS`] steps since the epoch.
pub fn totp_step(unix_seconds: i64) -> i64 {
    unix_seconds.div_euclid(TOTP_STEP_SECONDS)
}

/// One code, RFC 4226 §5.3's dynamic truncation over `HMAC-SHA-1(K, C)` with
/// `C` the step counter — which is the whole of RFC 6238 once `C` comes from a
/// clock (§4, *"TOTP = HOTP(K, T)"*).
///
/// SHA-1 is RFC 6238 §1.2's default and what every authenticator application
/// implements; `deps/decisions/sha1.md` carries the argument for why a hash
/// broken for collisions is sound as the HMAC inside a one-time code, and the
/// pinned RFC 4226 Appendix D vectors are in `tests/credentials.rs`.
pub fn totp_code(secret: &[u8], step: i64) -> String {
    // Reached through `KeyInit` explicitly, the same spelling `crypto::mac`
    // uses one module over, because `Mac`'s own `new_from_slice` is not the
    // one in scope here.
    let mut mac =
        <Hmac<Sha1> as KeyInit>::new_from_slice(secret).expect("HMAC takes a key of any length");
    mac.update(&(step as u64).to_be_bytes());
    let tag = mac.finalize().into_bytes();

    let offset = (tag[tag.len() - 1] & 0x0f) as usize;
    let binary = ((tag[offset] & 0x7f) as u32) << 24
        | (tag[offset + 1] as u32) << 16
        | (tag[offset + 2] as u32) << 8
        | (tag[offset + 3] as u32);
    let modulus = 10u32.pow(TOTP_DIGITS);
    format!("{:0width$}", binary % modulus, width = TOTP_DIGITS as usize)
}

/// Which step, if any, this code is for — **refusing any step at or below
/// `last_step`.**
///
/// ADR-0055 decision 10: *"a code accepted once"*. `0018` §B makes that a
/// column rather than a cache, and the comparison is `<=` and not `<` on
/// purpose: a code replayed inside its OWN thirty-second step still verifies,
/// and it is the stored high-water mark that refuses it the second time.
/// `tests/credentials.rs` drives exactly that — a real six-digit code, replayed
/// inside its own step — because CLAUDE.md rule 2 says a safety gate is tested
/// against what a real input looks like.
pub fn verify_totp(
    secret: &[u8],
    code: &str,
    now_unix: i64,
    last_step: Option<i64>,
) -> Option<i64> {
    if code.chars().count() != TOTP_DIGITS as usize || !code.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let current = totp_step(now_unix);
    // Newest first, so a code that is valid for two steps at once is recorded
    // at the higher one and the window closes behind it.
    for step in ((current - TOTP_SKEW_STEPS)..=(current + TOTP_SKEW_STEPS)).rev() {
        if let Some(last) = last_step {
            if step <= last {
                continue;
            }
        }
        if constant_time_eq(totp_code(secret, step).as_bytes(), code.as_bytes()) {
            return Some(step);
        }
    }
    None
}

/// Compare two byte strings without leaking their difference in timing, using
/// the one constant-time comparison this workspace has.
///
/// `crypto::mac_verify` keyed under a fresh random value per call: an attacker
/// who could time it learns about a MAC under a key that exists for one call
/// and is then dropped. `sessions::same_bytes` is the same construction one
/// module over, and this is a second copy rather than a widening of that one
/// because it is four lines and making it public would put a general-purpose
/// comparison in a module whose header says what it does not have.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let Ok(key) = Key32::random() else {
        return false;
    };
    crypto::mac_verify(key.expose(), a, &crypto::mac(key.expose(), b))
}

/// RFC 4648 §6 base32, upper case, **no padding** — which is what an
/// `otpauth://` URI carries and what every authenticator application parses.
fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u16 = 0;
    let mut bits: u32 = 0;
    for byte in bytes {
        buffer = (buffer << 8) | *byte as u16;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// The `otpauth://` URI decision 10 says the client shows as text.
///
/// *"The client shows the TOTP secret and its `otpauth://` URI as text; a QR
/// code needs an encoder the browser side may not import (OPEN-QUESTIONS A3)
/// and can be hand-written later."*
///
/// The algorithm, digit count and period are stated explicitly rather than
/// left to an application's defaults: the defaults happen to be these, and an
/// application that silently used others would produce codes this server
/// refuses with no way for the person to tell why.
fn otpauth_uri(deployment: &str, address: &str, secret: &[u8]) -> String {
    let issuer = percent_encode("Fathom");
    let label = percent_encode(address);
    let _ = deployment;
    format!(
        "otpauth://totp/{issuer}:{label}?secret={}&issuer={issuer}&algorithm=SHA1&digits={}&period={}",
        base32_encode(secret),
        TOTP_DIGITS,
        TOTP_STEP_SECONDS,
    )
}

/// Percent-encode everything that is not unreserved (RFC 3986 §2.3), so an
/// address with a `#`, a `&` or a space cannot change the shape of the URI it
/// is placed in.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

/// One fresh backup code, as the person reads it: `xxxx-xxxx-xxxx-xxxx`.
///
/// [`BACKUP_CODE_CHARS`] Crockford base32 characters — eighty bits from the OS
/// CSPRNG — grouped in fours. The hyphens are presentation: [`normalise_code`]
/// strips them, and the stored hash is over the normalised form, so a person
/// typing the code without them is not refused for it.
fn new_backup_code() -> Result<String, CredentialError> {
    let mut bytes = [0u8; BACKUP_CODE_CHARS * 5 / 8];
    getrandom::fill(&mut bytes).map_err(|_| CredentialError::Corrupt("random source"))?;

    let mut raw = String::with_capacity(BACKUP_CODE_CHARS);
    let mut buffer: u16 = 0;
    let mut bits: u32 = 0;
    for byte in bytes {
        buffer = (buffer << 8) | byte as u16;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            raw.push(CROCKFORD[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }

    let mut out = String::with_capacity(BACKUP_CODE_CHARS + 3);
    for (i, c) in raw.chars().enumerate() {
        if i > 0 && i % 4 == 0 {
            out.push('-');
        }
        out.push(c);
    }
    Ok(out)
}

/// The form a backup code is hashed in: hyphens and spaces gone, upper case,
/// and Crockford's three confusable letters folded onto the digits they are
/// read as (`I` and `L` to `1`, `O` to `0`).
///
/// Folding is part of what Crockford base32 IS, not a convenience: the
/// alphabet excludes those letters precisely so that a person who writes a `1`
/// as a serif `I` is still read correctly. A server that did not fold would
/// hand out codes people cannot type back.
pub fn normalise_code(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect()
}

/// `H(LP("fathom/credentials/backup/code/v1") ‖ LP(code))`. `0018` §C's shape,
/// and `operators::token_hash`'s construction one label over.
pub fn backup_code_hash(code: &str) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64);
    crypto::lp(&mut msg, TAG_BACKUP_CODE);
    crypto::lp(&mut msg, normalise_code(code).as_bytes());
    Sha256::digest(&msg).into()
}

/// `H(LP("fathom/credentials/reset/token/v1") ‖ LP(token))`. `0018` §D.
pub fn reset_token_hash(token: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(64);
    crypto::lp(&mut msg, TAG_RESET_TOKEN);
    crypto::lp(&mut msg, token);
    Sha256::digest(&msg).into()
}

// ---------------------------------------------------------------------------
// The sealed TOTP secret
// ---------------------------------------------------------------------------

/// The key an account's TOTP secret is sealed under.
///
/// Derived from the **site chain key**, in exactly the shape
/// `operators::settings_key` derives a setting's key and
/// `sessions::claimed_address_key` derives its own, and for the same reason
/// `0018` §B gives: a label separates USES of one key, and sealing one more
/// site-scoped secret is not a new use. `0013`'s departure 2 carries the whole
/// argument.
pub async fn totp_key_for(tx: &Transaction<'_>, ring: &KeyRing) -> Result<Key32, CredentialError> {
    let site = grants::site_chain_key(tx, ring).await?;
    Ok(crypto::hkdf_expand(&site, KDF_CREDENTIALS_TOTP))
}

/// The AEAD's additional data, binding a sealed secret to this deployment,
/// this account and this key epoch. A row lifted onto another account does not
/// open.
fn totp_aad(deployment: &str, account: &str, epoch: i32) -> Vec<u8> {
    let mut aad = Vec::with_capacity(96);
    crypto::lp(&mut aad, AAD_CREDENTIALS_TOTP);
    crypto::lp(&mut aad, deployment.as_bytes());
    crypto::lp(&mut aad, account.as_bytes());
    crypto::u32_le(&mut aad, epoch as u32);
    aad
}

/// The credential columns of one account, as every path here reads them.
#[derive(Clone, Debug, Default)]
pub struct CredentialRow {
    pub address: String,
    pub password_hash: Option<String>,
    pub totp_secret_ct: Option<Vec<u8>>,
    pub totp_secret_nonce: Option<Vec<u8>>,
    pub totp_secret_key_epoch: Option<i32>,
    pub totp_enrolled: bool,
    pub totp_last_step: Option<i64>,
    pub operator_key_hold_until_unix: i64,
}

impl CredentialRow {
    /// **Has the app code been confirmed?**
    ///
    /// `totp_last_step` and not `totp_enrolled_at`, and `0018` §B is the reason
    /// the two are different questions here. That file's
    /// `accounts_totp_secret_is_whole` CHECK correlates all four secret columns
    /// — a secret cannot be at rest without `totp_enrolled_at` beside it — so
    /// enrolment has to write `totp_enrolled_at` at the moment it writes the
    /// ciphertext, one request before the person has proved they can produce a
    /// code from it. `totp_last_step` is what the confirming code sets, and it
    /// is therefore the column that means "this app code is real".
    ///
    /// **Reported as a departure from the contracts**, which assumed one
    /// transaction for enrol-and-confirm and therefore one column for both
    /// facts. Two round trips is what a person pointing a phone camera at a
    /// screen needs, and the schema that shipped cannot hold a pending secret
    /// any other way.
    pub fn totp_confirmed(&self) -> bool {
        self.totp_last_step.is_some()
    }

    /// The secret, opened. `None` when none is enrolled.
    pub fn totp_secret(
        &self,
        key: &Key32,
        deployment: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, CredentialError> {
        let (Some(ct), Some(nonce), Some(epoch)) = (
            self.totp_secret_ct.as_ref(),
            self.totp_secret_nonce.as_ref(),
            self.totp_secret_key_epoch,
        ) else {
            return Ok(None);
        };
        let nonce: [u8; crypto::NONCE_LEN] = nonce
            .as_slice()
            .try_into()
            .map_err(|_| CredentialError::Corrupt("totp secret nonce"))?;
        let aad = totp_aad(deployment, account, epoch);
        Ok(Some(crypto::open(key, &nonce, ct, &aad)?))
    }
}

/// Read one account's credential columns. **Every caller reads through this
/// one function**, so a path cannot be written that quietly omits the hold or
/// the replay mark.
pub async fn read_credentials(
    tx: &Transaction<'_>,
    account: &str,
) -> Result<Option<CredentialRow>, CredentialError> {
    let row = tx
        .query_opt(
            "SELECT email, password_hash, totp_secret_ct, totp_secret_nonce, \
                    totp_secret_key_epoch, totp_enrolled_at IS NOT NULL, totp_last_step, \
                    COALESCE(EXTRACT(EPOCH FROM operator_key_hold_until)::bigint, 0) \
               FROM accounts WHERE id = $1",
            &[&account],
        )
        .await?;
    let Some(row) = row else { return Ok(None) };
    Ok(Some(CredentialRow {
        address: row.get(0),
        password_hash: row.get(1),
        totp_secret_ct: row.get(2),
        totp_secret_nonce: row.get(3),
        totp_secret_key_epoch: row.get(4),
        totp_enrolled: row.get(5),
        totp_last_step: row.get(6),
        operator_key_hold_until_unix: row.get(7),
    }))
}

/// Does this account hold the operator custody? `0019`'s binding table, read
/// as a lookup.
///
/// **The binding's own seal is stream (b)'s to verify**, at the point stream
/// (b) writes and reads it; this is a membership question, not an
/// authorisation, and the authorisation it feeds is a REFUSAL — an account with
/// a binding and no app code is refused everywhere but the setup screen. A
/// forged binding therefore locks its own holder out rather than letting
/// anybody in, which is the fail-closed direction.
pub async fn holds_operator_custody(
    tx: &Transaction<'_>,
    account: &str,
) -> Result<bool, CredentialError> {
    Ok(tx
        .query_opt(
            "SELECT 1 FROM operator_account_bindings WHERE account_id = $1",
            &[&account],
        )
        .await?
        .is_some())
}

/// Spend one backup code, if this is one of this account's live ones.
///
/// The guarded `UPDATE ... WHERE used_at IS NULL RETURNING` is what makes it
/// single use against a concurrent second attempt; the seal is what makes it
/// single use against whoever holds the database. Called from sign-in, inside
/// `app.session_custody`, and from nowhere else.
pub async fn spend_backup_code(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    account: &str,
    code: &str,
) -> Result<bool, CredentialError> {
    let hash = backup_code_hash(code);
    let row = tx
        .query_opt(
            "SELECT id, account_id, COALESCE(EXTRACT(EPOCH FROM used_at)::bigint, 0), \
                    COALESCE(used_seq, 0), row_version, row_seal \
               FROM backup_codes WHERE code_hash = $1",
            &[&hash.to_vec()],
        )
        .await?;
    let Some(row) = row else { return Ok(false) };
    let id: String = row.get(0);
    let owner: String = row.get(1);
    let used_at_unix: i64 = row.get(2);
    let used_seq: i64 = row.get(3);
    let row_version: i32 = row.get(4);
    let stored_seal: Vec<u8> = row.get(5);

    // The code names its own account. A code is eighty random bits, so this is
    // not how an attacker gets here — but a code that opened a session on
    // somebody else's account would be a takeover, and the check costs one
    // comparison.
    if owner != account {
        return Ok(false);
    }

    // **The seal is recomputed at whichever version the row claims**, so a
    // code that has ALREADY been spent verifies as a spent code and is
    // refused, rather than looking like a forged one. Getting this wrong turns
    // "you have used this code" into an integrity alarm, and an alarm that
    // fires on ordinary misuse is an alarm people learn to dismiss — which is
    // the failure ADR-0055's own `reencrypt` note describes one table over.
    let key = grants::site_row_key(tx, ring).await?;
    let expected = backup_code_seal(
        &key,
        &id,
        &owner,
        &hash,
        if used_at_unix == 0 { 0 } else { used_seq },
        row_version,
        used_at_unix,
    );
    if stored_seal != expected {
        return Err(CredentialError::Unverifiable("backup code row seal"));
    }
    if used_at_unix != 0 {
        return Ok(false);
    }

    let appended = chains::append_site(
        tx,
        ring,
        deployment,
        EntryType::BackupCodeUsed,
        &entry_metadata(
            EntryType::BackupCodeUsed,
            &[
                ("account", Json::Str(account.to_string())),
                ("code", Json::Str(id.clone())),
            ],
        ),
    )
    .await?;

    let now = now_unix();
    let seal = backup_code_seal(&key, &id, &owner, &hash, appended.seq, 2, now);
    let updated = tx
        .execute(
            "UPDATE backup_codes \
                SET used_at = to_timestamp($2::bigint), used_seq = $3, row_version = 2, \
                    row_seal = $4 \
              WHERE id = $1 AND used_at IS NULL",
            &[&id, &now, &appended.seq, &seal.to_vec()],
        )
        .await?;
    Ok(updated == 1)
}

/// The seal on one `backup_codes` row.
///
/// **`chain_seq` is zero at version 1 and the spending entry's seq at version
/// 2**, because `0018` §C gives the table no `issued_seq`: the batch of ten is
/// part of the ONE `totp_enrolled` entry, deliberately, so there is no
/// per-code issue seq to cover. Spending one DOES carry its own entry, and
/// version 2's seal names it — so a spent code cannot be un-spent by clearing
/// `used_at`, which is the property `0018` §D states for the token beside it.
fn backup_code_seal(
    row_key: &Key32,
    id: &str,
    account: &str,
    code_hash: &[u8; 32],
    chain_seq: i64,
    row_version: i32,
    used_at_unix: i64,
) -> [u8; 32] {
    let mut map = BTreeMap::new();
    map.insert("account_id".to_string(), Json::Str(account.to_string()));
    map.insert("code_hash".to_string(), Json::Str(hex(code_hash)));
    map.insert(
        "used_at_unix".to_string(),
        Json::Str(used_at_unix.to_string()),
    );
    authority::row_seal(
        row_key,
        &RowFacts {
            table: "backup_codes",
            row_id: id,
            chain_seq,
            row_version,
            row_state: &Json::Obj(map).to_canonical_bytes(),
        },
    )
}

/// Everything one `password_reset_tokens` row's seal covers.
///
/// **A struct and not nine arguments**, shaped like `authority::RowFacts` and
/// `sessions::RevocationFacts` for their reason: a construction that takes a
/// row of same-typed positional values is one two callers can get out of order
/// and nobody notices, because a seal that disagrees reads as tampering.
pub struct ResetTokenFacts<'a> {
    pub id: &'a str,
    pub account_id: &'a str,
    pub token_hash: &'a [u8; 32],
    pub source: &'a str,
    pub issued_seq: i64,
    pub expires_at_unix: i64,
    pub row_version: i32,
    /// Zero until the token is spent, which is what makes a cleared `spent_at`
    /// an unverifiable row rather than a re-openable one (`0018` §D).
    pub spent_at_unix: i64,
}

/// The seal on one `password_reset_tokens` row. `issued_seq` is a real column
/// here, so the seal names it at both versions and `spent_at` is what moves.
fn reset_token_seal(row_key: &Key32, facts: &ResetTokenFacts<'_>) -> [u8; 32] {
    let mut map = BTreeMap::new();
    map.insert(
        "account_id".to_string(),
        Json::Str(facts.account_id.to_string()),
    );
    map.insert(
        "expires_at_unix".to_string(),
        Json::Str(facts.expires_at_unix.to_string()),
    );
    map.insert("source".to_string(), Json::Str(facts.source.to_string()));
    map.insert(
        "spent_at_unix".to_string(),
        Json::Str(facts.spent_at_unix.to_string()),
    );
    map.insert("token_hash".to_string(), Json::Str(hex(facts.token_hash)));
    authority::row_seal(
        row_key,
        &RowFacts {
            table: "password_reset_tokens",
            row_id: facts.id,
            chain_seq: facts.issued_seq,
            row_version: facts.row_version,
            row_state: &Json::Obj(map).to_canonical_bytes(),
        },
    )
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/// What every credential act needs, carried together for `SessionStore`'s own
/// reason: each field is a control, and passing them as one value means a new
/// path cannot be written that quietly omits one.
pub struct CredentialStore {
    pool: Pool,
    ring: Arc<KeyRing>,
    deployment: String,
    reset_lifetime: Duration,
}

/// What enrolling an app code hands back, **once**.
pub struct TotpEnrolment {
    pub otpauth_uri: String,
    pub secret_base32: String,
}

impl core::fmt::Debug for TotpEnrolment {
    /// The secret is not printed, by the rule `secret.rs` exists for and that
    /// `sessions::SignedIn` and `operators::Invitation` already follow.
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("TotpEnrolment")
            .field("otpauth_uri", &"<not printed>")
            .field("secret_base32", &"<not printed>")
            .finish()
    }
}

impl CredentialStore {
    pub fn new(pool: Pool, ring: Arc<KeyRing>, deployment: String) -> Self {
        Self::with_reset_lifetime(pool, ring, deployment, RESET_TOKEN_LIFETIME)
    }

    /// As [`CredentialStore::new`], with a reset-token lifetime other than
    /// [`RESET_TOKEN_LIFETIME`].
    ///
    /// **The lifetime is a property of the store rather than a constant read at
    /// the point of use**, for exactly the reason
    /// `SessionStore::with_lifetime` gives for a session's: otherwise the only
    /// way to observe an expiry is to move `expires_at` in SQL — which breaks
    /// the row seal, so the test proves the seal and never the expiry. Two
    /// separate claims need two separate ways to reach them, and
    /// `tests/credentials.rs` drives both.
    pub fn with_reset_lifetime(
        pool: Pool,
        ring: Arc<KeyRing>,
        deployment: String,
        reset_lifetime: Duration,
    ) -> Self {
        Self {
            pool,
            ring,
            deployment,
            reset_lifetime,
        }
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }

    pub fn deployment(&self) -> &str {
        &self.deployment
    }

    /// The account a credential act is about: **the session's own, always.**
    ///
    /// An operator session has no account of its own — an operator principal is
    /// unrepresentable in a membership (§2, `0004`) — so it is refused here
    /// rather than being given somebody's credential to change.
    fn acting_account(&self, session: &VerifiedSession) -> Result<String, CredentialError> {
        if session.kind() != PrincipalKind::Steward {
            return Err(CredentialError::NotAnAccountSession);
        }
        Ok(session.principal_id())
    }

    /// Refuse a session that is mid-setup: the account holds the operator
    /// custody and has no confirmed app code yet.
    ///
    /// The lead's resolution 1: such a session is *"accepted ONLY on
    /// /credentials/* routes (setup-only); every other signed route refuses it
    /// with a typed `TotpRequired`."* This is the check the routes inside
    /// `/credentials/` that are NOT part of finishing the setup make for
    /// themselves; `sessions::verify_request` makes it for everything else.
    async fn refuse_a_setup_session(
        &self,
        tx: &Transaction<'_>,
        account: &str,
        row: &CredentialRow,
    ) -> Result<(), CredentialError> {
        if row.totp_confirmed() {
            return Ok(());
        }
        if holds_operator_custody_here(tx, account).await? {
            return Err(CredentialError::TotpRequired);
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // POST /credentials/password
    // -----------------------------------------------------------------------

    /// Set or change this session's own password.
    ///
    /// **Rate limit.** None of its own, and the lead's resolution 12 is why:
    /// the password budget is `sign_in_attempts`' existing per-address counter
    /// (ten failures per fifteen minutes, no lockout) plus the per-source
    /// bucket, both of which are spent at `POST /session` where a wrong
    /// password is actually guessed. This route does not guess anything — it
    /// already holds a verified session, which cost a single-use nonce and an
    /// ES256 signature, and `sessions::MAX_OUTSTANDING_NONCES` bounds how many
    /// of those one browser may have in flight.
    pub async fn set_password(
        &self,
        session: &VerifiedSession,
        new_password: &str,
    ) -> Result<(), CredentialError> {
        let account = self.acting_account(session)?;
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_credential_custody(&tx, &account).await?;

        let Some(row) = read_credentials(&tx, &account).await? else {
            return Err(CredentialError::Corrupt("account"));
        };
        check_password(new_password, &row.address)?;
        let hash = hash_password(new_password)?;

        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::PasswordSet,
            &entry_metadata(
                EntryType::PasswordSet,
                &[
                    ("account", Json::Str(account.clone())),
                    ("was_reset", Json::Bool(false)),
                ],
            ),
        )
        .await?;
        let _ = appended;

        tx.execute(
            "UPDATE accounts SET password_hash = $2 WHERE id = $1",
            &[&account, &hash],
        )
        .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // POST /credentials/totp/enrol
    // -----------------------------------------------------------------------

    /// Draw a fresh app-code secret, seal it, and hand back the `otpauth://`
    /// URI and the base32 text decision 10 says the client shows.
    ///
    /// **Shown once.** There is no route that reads the secret back out, and
    /// this one refuses once the code has been confirmed — so a session that
    /// has been taken over cannot quietly replace a live second factor. The way
    /// back from a lost phone is a backup code, or ADR-0055 decision 8's host
    /// command; it is not a form.
    pub async fn enrol_totp(
        &self,
        session: &VerifiedSession,
    ) -> Result<TotpEnrolment, CredentialError> {
        let account = self.acting_account(session)?;
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_credential_custody(&tx, &account).await?;

        let Some(row) = read_credentials(&tx, &account).await? else {
            return Err(CredentialError::Corrupt("account"));
        };
        if row.totp_confirmed() {
            return Err(CredentialError::TotpAlreadyEnrolled);
        }

        let mut secret = [0u8; TOTP_SECRET_LEN];
        getrandom::fill(&mut secret).map_err(|_| CredentialError::Corrupt("random source"))?;

        let key = totp_key_for(&tx, &self.ring).await?;
        let nonce = crypto::random_nonce()?;
        let aad = totp_aad(&self.deployment, &account, CHAIN_KEY_EPOCH);
        let ciphertext = crypto::seal(&key, &nonce, &secret, &aad)?;

        // **`totp_enrolled_at` moves now and not at confirmation**, because
        // `0018` §B's `accounts_totp_secret_is_whole` CHECK correlates all four
        // columns and a secret cannot be at rest without it. What "confirmed"
        // means is `totp_last_step`, which the next request sets — see
        // `CredentialRow::totp_confirmed`, which carries the report.
        tx.execute(
            "UPDATE accounts \
                SET totp_secret_ct = $2, totp_secret_nonce = $3, totp_secret_key_epoch = $4, \
                    totp_enrolled_at = now(), totp_last_step = NULL \
              WHERE id = $1",
            &[&account, &ciphertext, &nonce.to_vec(), &CHAIN_KEY_EPOCH],
        )
        .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;

        Ok(TotpEnrolment {
            otpauth_uri: otpauth_uri(&self.deployment, &row.address, &secret),
            secret_base32: base32_encode(&secret),
        })
    }

    // -----------------------------------------------------------------------
    // POST /credentials/totp/confirm
    // -----------------------------------------------------------------------

    /// Prove the app code works, and take the ten backup codes.
    ///
    /// The code that confirms is spent by the same `totp_last_step` rule every
    /// later one is, so the confirming code cannot be replayed at sign-in a
    /// moment later.
    ///
    /// The ten backup codes are minted in **the same transaction** as the
    /// confirmation, so there is no window in which the app code is real and no
    /// lost-phone path exists — `0018` §C's requirement, moved from enrolment
    /// to confirmation for the reason `CredentialRow::totp_confirmed` gives.
    pub async fn confirm_totp(
        &self,
        session: &VerifiedSession,
        code: &str,
    ) -> Result<Vec<String>, CredentialError> {
        let account = self.acting_account(session)?;
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_credential_custody(&tx, &account).await?;

        let Some(row) = read_credentials(&tx, &account).await? else {
            return Err(CredentialError::Corrupt("account"));
        };
        if row.totp_confirmed() {
            return Err(CredentialError::TotpAlreadyEnrolled);
        }
        let key = totp_key_for(&tx, &self.ring).await?;
        let Some(secret) = row.totp_secret(&key, &self.deployment, &account)? else {
            return Err(CredentialError::NoTotpEnrolled);
        };
        let Some(step) = verify_totp(&secret, code, now_unix(), row.totp_last_step) else {
            return Err(CredentialError::CodeRefused);
        };

        let appended = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::TotpEnrolled,
            &entry_metadata(
                EntryType::TotpEnrolled,
                &[
                    ("account", Json::Str(account.clone())),
                    ("backup_codes", Json::Str(BACKUP_CODE_COUNT.to_string())),
                ],
            ),
        )
        .await?;
        let _ = appended;

        tx.execute(
            "UPDATE accounts SET totp_last_step = $2 WHERE id = $1",
            &[&account, &step],
        )
        .await?;

        let row_key = grants::site_row_key(&tx, &self.ring).await?;
        let mut codes = Vec::with_capacity(BACKUP_CODE_COUNT);
        for _ in 0..BACKUP_CODE_COUNT {
            let code = new_backup_code()?;
            let hash = backup_code_hash(&code);
            let id = ids::new_ulid().to_string();
            let seal = backup_code_seal(&row_key, &id, &account, &hash, 0, 1, 0);
            tx.execute(
                "INSERT INTO backup_codes (id, account_id, code_hash, row_version, row_seal) \
                 VALUES ($1, $2, $3, 1, $4)",
                &[&id, &account, &hash.to_vec(), &seal.to_vec()],
            )
            .await?;
            codes.push(code);
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(codes)
    }

    // -----------------------------------------------------------------------
    // POST /credentials/key
    // -----------------------------------------------------------------------

    /// Register the long-term key this browser will sign grants with.
    ///
    /// The lead's resolution 1: *"right after a password sign-in the CLIENT
    /// registers a per-browser key through a new signed route
    /// `POST /credentials/key` into `account_keys` (`key_source 'software'`)"*.
    /// A password sign-in produces a session with no long-term key behind it,
    /// and grant signing needs one regardless — so this is the route that gives
    /// the browser one, in the same shape `operators::redeem_account_enrolment`
    /// already enrols a first key at an invitation.
    ///
    /// **Two departures, both reported rather than hidden.**
    ///
    /// 1. **The entry type is `authenticator_registered`, not
    ///    `account_key_enrolled`.** Resolution 1 names the latter, but `0018`'s
    ///    own `chain_entries_type_belongs_to_kind` CHECK — which this stream may
    ///    not edit, it is a shipped migration under the checksum gate — files
    ///    `account_key_enrolled` on an ORGANISATION chain only, and a
    ///    password-only account may belong to no organisation yet.
    ///    `authenticator_registered` is the SITE-chain type for exactly this act
    ///    and `grants::enrol_software_key_at_invitation` already writes it, so
    ///    this route reuses that function whole rather than writing a second
    ///    enrolment path.
    /// 2. **Allowed at `A0T` and `A1`, read as "not while the seat is in
    ///    setup".** A session whose account holds the operator custody and has
    ///    no confirmed app code may not register a long-term key: the second
    ///    factor has to exist before a key that outlives the session does.
    ///
    /// **Any live key is accepted afterwards**, which is the other half of
    /// resolution 1 and lives in `grants::verify_by_any_live_key`: an account
    /// that has registered a key in each of two browsers can sign in and sign
    /// grants from either.
    pub async fn register_key(
        &self,
        session: &VerifiedSession,
        public_key: &[u8],
    ) -> Result<String, CredentialError> {
        let account = self.acting_account(session)?;
        if public_key.len() != authority::PUBLIC_KEY_LEN || public_key[0] != 4 {
            return Err(CredentialError::Malformed("public key"));
        }

        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_credential_custody(&tx, &account).await?;

        let Some(row) = read_credentials(&tx, &account).await? else {
            return Err(CredentialError::Corrupt("account"));
        };
        self.refuse_a_setup_session(&tx, &account, &row).await?;

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
    // POST /credentials/reset
    // -----------------------------------------------------------------------

    /// *"Forgot my password."* **Always 200, for every address.**
    ///
    /// ADR-0055 decision 7 and OWASP ASVS 5.0.0 6.3.8 as the ADR read them on
    /// 2026-09-21: *"the same answer and timing for every address"*, and *"no
    /// account enumeration through messages, codes or timing."*
    ///
    /// **What is closed and what is not, stated as narrowly as
    /// `SessionError::SignInRefused` states its own version.** What is closed is
    /// the ANSWER: status, headers and body are identical for an address that
    /// belongs to an account and one that belongs to nobody, and
    /// `tests/credentials.rs` asserts that over the wire. What is **not** closed
    /// is how long it takes: an address that resolves goes on to append a sealed
    /// entry and write a row, and one that resolves to nothing stops earlier.
    /// That is a timing difference of real size, it is not measured here, and
    /// **nothing in this file is a claim that this route is constant time.**
    ///
    /// **The token is not returned** — there is no mail path yet (ADR-0055
    /// decision 7's *"until SMTP is applied"*), so until stream 5 builds one the
    /// only way to a token is the site chain an operator reads. Returning it
    /// here would make "forgot my password" a password reset for anybody who
    /// knows an address.
    pub async fn request_reset(&self, address: &str, source: &str) -> Result<(), CredentialError> {
        self.issue_reset_token(address, source).await?;
        Ok(())
    }

    /// [`CredentialStore::request_reset`]'s whole body, handing back the token
    /// it drew — or `None` when the address belongs to no live account.
    ///
    /// **This is where the mailed link's token comes from**, and it is
    /// separate from `request_reset` for one reason: ADR-0055 decision 7's
    /// *"Until SMTP is applied, every start logs ... the only recovery is
    /// `fathom-server recover-operator`"*. There is no mail path in this
    /// build, so the ROUTE must discard the token — returning it would make
    /// "forgot my password" a password reset for anybody who knows an address.
    /// When stream 5 builds the mail path it calls this and posts what it
    /// gets, and the route above still discards.
    ///
    /// It is `pub` rather than `#[cfg(test)]` deliberately: a function that
    /// exists only under `cfg(test)` is a second code path, and the whole
    /// point is that the test drives the same one the route does.
    pub async fn issue_reset_token(
        &self,
        address: &str,
        source: &str,
    ) -> Result<Option<Vec<u8>>, CredentialError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_reset_custody(&tx).await?;

        // Drawn whether or not an account is found, so the work either side of
        // the branch is as close to equal as this build makes it.
        let mut token = [0u8; RESET_TOKEN_LEN];
        getrandom::fill(&mut token).map_err(|_| CredentialError::Corrupt("random source"))?;
        let hash = reset_token_hash(&token);

        let found = tx
            .query_opt(
                "SELECT id FROM accounts WHERE email = $1 AND disabled_at IS NULL",
                &[&address],
            )
            .await?;
        let mut issued = None;

        if let Some(found) = found {
            let account: String = found.get(0);
            let source: String = source.chars().take(128).collect();
            let appended = chains::append_site(
                &tx,
                &self.ring,
                &self.deployment,
                EntryType::ResetRequested,
                &entry_metadata(
                    EntryType::ResetRequested,
                    &[
                        ("account", Json::Str(account.clone())),
                        ("source", Json::Str(source.clone())),
                    ],
                ),
            )
            .await?;

            let id = ids::new_ulid().to_string();
            let expires = now_unix() + self.reset_lifetime.as_secs() as i64;
            let row_key = grants::site_row_key(&tx, &self.ring).await?;
            let seal = reset_token_seal(
                &row_key,
                &ResetTokenFacts {
                    id: &id,
                    account_id: &account,
                    token_hash: &hash,
                    source: &source,
                    issued_seq: appended.seq,
                    expires_at_unix: expires,
                    row_version: 1,
                    spent_at_unix: 0,
                },
            );
            tx.execute(
                "INSERT INTO password_reset_tokens \
                     (id, account_id, token_hash, source, issued_seq, expires_at, row_version, \
                      row_seal) \
                 VALUES ($1, $2, $3, $4, $5, to_timestamp($6::bigint), 1, $7)",
                &[
                    &id,
                    &account,
                    &hash.to_vec(),
                    &source,
                    &appended.seq,
                    &expires,
                    &seal.to_vec(),
                ],
            )
            .await?;
            issued = Some(token.to_vec());
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(issued)
    }

    // -----------------------------------------------------------------------
    // POST /credentials/reset/redeem
    // -----------------------------------------------------------------------

    /// Spend a reset token and set a new password.
    ///
    /// ADR-0055 decision 7, point by point:
    ///
    /// * **single use** — the guarded `UPDATE ... WHERE spent_at IS NULL` is
    ///   what makes it so against a concurrent second attempt, and the seal is
    ///   what makes it so against whoever holds the database. A wrong password
    ///   on a live token still spends it: the contracts are explicit that this
    ///   is not a second chance.
    /// * **24 hours** — `expires_at`, checked here.
    /// * **it never skips the app code** — this sets `password_hash` and
    ///   touches no TOTP column, so the sign-in that follows still asks for a
    ///   code.
    /// * **it does not restore the operator custody by itself** — resolution
    ///   11: when the account holds a binding, `operator_key_hold_until` is set
    ///   to twenty-four hours out, and stream (b)'s operator key registration
    ///   refuses while it is in the future. *"A colleague who controls the mail
    ///   server cannot reset their way into a second seat."*
    /// * **every other session of the account ends** — below, with a sealed
    ///   `account_signed_out` entry and a `session_revocations` row each, so a
    ///   restore cannot quietly put one back.
    pub async fn redeem_reset(
        &self,
        token: &[u8],
        new_password: &str,
    ) -> Result<(), CredentialError> {
        let hash = reset_token_hash(token);
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        enter_reset_custody(&tx).await?;
        // `sessions` and `session_revocations` are `app.session_custody`'s
        // (`0013` §E, `0014` §D) and ending this account's other sessions is
        // part of this act, not a separate one — so this transaction holds both
        // capabilities and drops them together.
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await?;

        let row = tx
            .query_opt(
                "SELECT id, account_id, source, issued_seq, \
                        EXTRACT(EPOCH FROM expires_at)::bigint, \
                        COALESCE(EXTRACT(EPOCH FROM spent_at)::bigint, 0), row_version, row_seal \
                   FROM password_reset_tokens WHERE token_hash = $1",
                &[&hash.to_vec()],
            )
            .await?;
        let Some(row) = row else {
            return Err(CredentialError::TokenRefused);
        };
        let id: String = row.get(0);
        let account: String = row.get(1);
        let source: String = row.get(2);
        let issued_seq: i64 = row.get(3);
        let expires_at_unix: i64 = row.get(4);
        let spent_at_unix: i64 = row.get(5);
        let row_version: i32 = row.get(6);
        let stored_seal: Vec<u8> = row.get(7);

        // The seal, before anything else about the row is believed. A token
        // whose `spent_at` was cleared to re-open it fails here, which is what
        // makes a guarded flag as strong as a delete (`0015` §E's argument,
        // `0018` §D's restatement of it).
        let row_key = grants::site_row_key(&tx, &self.ring).await?;
        let facts = ResetTokenFacts {
            id: &id,
            account_id: &account,
            token_hash: &hash,
            source: &source,
            issued_seq,
            expires_at_unix,
            row_version,
            spent_at_unix,
        };
        let expected = reset_token_seal(&row_key, &facts);
        if stored_seal != expected {
            return Err(CredentialError::Unverifiable("reset token row seal"));
        }
        if spent_at_unix != 0 || expires_at_unix <= now_unix() {
            return Err(CredentialError::TokenRefused);
        }

        let address: Option<String> = tx
            .query_opt("SELECT email FROM accounts WHERE id = $1", &[&account])
            .await?
            .map(|r| r.get(0));
        let Some(address) = address else {
            return Err(CredentialError::TokenRefused);
        };

        // **Spent before the password is checked.** The token is single use
        // whatever happens next, so a caller who presents a live token with a
        // refused password does not get to try again with the same token.
        let now = now_unix();
        let spent_entry = chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::ResetSpent,
            &entry_metadata(
                EntryType::ResetSpent,
                &[
                    ("account", Json::Str(account.clone())),
                    ("token_id", Json::Str(id.clone())),
                ],
            ),
        )
        .await?;
        let spent_seal = reset_token_seal(
            &row_key,
            &ResetTokenFacts {
                row_version: row_version + 1,
                spent_at_unix: now,
                ..facts
            },
        );
        let spent = tx
            .execute(
                "UPDATE password_reset_tokens \
                    SET spent_at = to_timestamp($2::bigint), spent_seq = $3, row_version = $4, \
                        row_seal = $5 \
                  WHERE id = $1 AND spent_at IS NULL",
                &[
                    &id,
                    &now,
                    &spent_entry.seq,
                    &(row_version + 1),
                    &spent_seal.to_vec(),
                ],
            )
            .await?;
        if spent != 1 {
            return Err(CredentialError::TokenRefused);
        }

        // Only now: the policy, and the write.
        //
        // **A refusal here leaves the token SPENT**, which is the fail-closed
        // direction and what the contracts mean by *"a wrong password on a
        // live token is a typed refusal, not a second chance — token still
        // spends"*. Returning `Err` from inside this transaction would roll the
        // spend back with everything else, so the refusal commits first and is
        // returned afterwards. `operators::record_redemption_refused` reports
        // the same trap one module over and solves it with a second
        // transaction; here one commit is enough, because the spend and the
        // refusal are the same act's two halves.
        if let Err(refused) = check_password(new_password, &address) {
            leave_custody(&tx).await?;
            tx.commit().await?;
            return Err(refused);
        }
        let password_hash = hash_password(new_password)?;

        chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::PasswordSet,
            &entry_metadata(
                EntryType::PasswordSet,
                &[
                    ("account", Json::Str(account.clone())),
                    ("was_reset", Json::Bool(true)),
                ],
            ),
        )
        .await?;

        let holds_custody = holds_operator_custody(&tx, &account).await?;
        if holds_custody {
            let until = now + OPERATOR_KEY_HOLD.as_secs() as i64;
            tx.execute(
                "UPDATE accounts SET password_hash = $2, \
                        operator_key_hold_until = to_timestamp($3::bigint) \
                  WHERE id = $1",
                &[&account, &password_hash, &until],
            )
            .await?;
        } else {
            tx.execute(
                "UPDATE accounts SET password_hash = $2 WHERE id = $1",
                &[&account, &password_hash],
            )
            .await?;
        }

        self.end_every_session_of(&tx, &account).await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // POST /enrolment/operator/setup
    // -----------------------------------------------------------------------

    /// The first operator's setup screen, server half.
    ///
    /// ADR-0055 decision 10's last bullet: *"the token file the first start
    /// writes opens a setup screen (set the password, enrol the app code, save
    /// the backup codes) instead of enrolling a browser key."*
    ///
    /// **It returns no session**, on the lead's resolution 4: the client signs
    /// in with `POST /session` immediately afterwards, which is one more round
    /// trip and one fewer way for a token to become a session without the
    /// password being checked.
    ///
    /// The token is a `purpose = 'setup'` row (`0019` §B), spent through
    /// `operators::spend_setup_token` so that the seal check, the expiry check
    /// and the `enrolment_token_redeemed` entry are the ones the operator plane
    /// already uses rather than a second copy of them here.
    pub async fn redeem_setup(
        &self,
        operators: &operators::OperatorStore,
        token: &[u8],
        new_password: &str,
    ) -> Result<(), CredentialError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        operators::enter_enrolment_custody(&tx).await?;
        // The binding lookup below and the `accounts` write are
        // `app.session_custody`'s and `app.reset_custody`'s respectively
        // (`0019` §A, `0018` §E). This act spans all three, and they are
        // dropped together.
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await?;
        tx.execute("SELECT set_config('app.reset_custody', 'yes', true)", &[])
            .await?;

        let operator = match operators.spend_setup_token(&tx, token).await {
            Ok(operator) => operator,
            Err(_) => return Err(CredentialError::TokenRefused),
        };

        let account: Option<String> = tx
            .query_opt(
                "SELECT account_id FROM operator_account_bindings WHERE operator_id = $1",
                &[&operator],
            )
            .await?
            .map(|r| r.get(0));
        let Some(account) = account else {
            // No binding means the first start did not create one, which is
            // stream (b)'s `bootstrap_first_operator`. Refused uniformly: a
            // caller holding a real token learns nothing from it, and an
            // operator reading the site chain sees the redemption that
            // preceded it.
            return Err(CredentialError::TokenRefused);
        };

        let address: Option<String> = tx
            .query_opt("SELECT email FROM accounts WHERE id = $1", &[&account])
            .await?
            .map(|r| r.get(0));
        let Some(address) = address else {
            return Err(CredentialError::TokenRefused);
        };

        check_password(new_password, &address)?;
        let password_hash = hash_password(new_password)?;

        chains::append_site(
            &tx,
            &self.ring,
            &self.deployment,
            EntryType::PasswordSet,
            &entry_metadata(
                EntryType::PasswordSet,
                &[
                    ("account", Json::Str(account.clone())),
                    ("was_reset", Json::Bool(false)),
                ],
            ),
        )
        .await?;
        tx.execute(
            "UPDATE accounts SET password_hash = $2 WHERE id = $1",
            &[&account, &password_hash],
        )
        .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(())
    }

    /// End every live session of one account, recording each.
    ///
    /// The shape `sessions::sign_out_in` uses — the sealed entry first, then
    /// the `session_revocations` row whose MAC covers its seq, then the delete
    /// — rather than a bare `DELETE`, because `0014` §D's whole argument is
    /// that deleting a session row is undone by a restore and a revocation row
    /// is not. Written here rather than called there because `sign_out_in`
    /// takes a `VerifiedSession`, and a reset has none: nobody is signed in.
    async fn end_every_session_of(
        &self,
        tx: &Transaction<'_>,
        account: &str,
    ) -> Result<(), CredentialError> {
        let rows = tx
            .query(
                "SELECT id FROM sessions WHERE principal_id = $1 AND principal_kind = 'steward'",
                &[&account],
            )
            .await?;
        let row_key = grants::site_row_key(tx, &self.ring).await?;
        for row in rows {
            let id: String = row.get(0);
            let appended = chains::append_site(
                tx,
                &self.ring,
                &self.deployment,
                EntryType::AccountSignedOut,
                &entry_metadata(
                    EntryType::AccountSignedOut,
                    &[
                        ("session", Json::Str(id.clone())),
                        ("account", Json::Str(account.to_string())),
                        ("principal_kind", Json::Str("steward".to_string())),
                    ],
                ),
            )
            .await?;
            let facts = crate::sessions::RevocationFacts {
                session_id: &id,
                principal_id: account,
                // The one value `session_revocations.reason` takes (`0014` §D's
                // `CHECK`), and a reset IS a sign-out of every other browser.
                reason: "signed_out",
                chain_seq: appended.seq,
                row_version: 1,
            };
            let mac = crate::sessions::revocation_row_mac(&row_key, &facts);
            tx.execute(
                "INSERT INTO session_revocations \
                     (session_id, principal_id, reason, chain_seq, row_version, row_mac) \
                 VALUES ($1, $2, $3, $4, 1, $5) ON CONFLICT (session_id) DO NOTHING",
                &[&id, &account, &facts.reason, &appended.seq, &mac.to_vec()],
            )
            .await?;
            tx.execute("DELETE FROM sessions WHERE id = $1", &[&id])
                .await?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// The capabilities
// ---------------------------------------------------------------------------

/// `0018` §E's self-service capability, for one transaction.
///
/// `app.account_id` is set beside it because `accounts_readable`'s first branch
/// and `account_keys`' policy both want it — and the value is always one this
/// server read off a verified session, never one a caller supplied.
async fn enter_credential_custody(
    tx: &Transaction<'_>,
    account: &str,
) -> Result<(), CredentialError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute(
        "SELECT set_config('app.credential_custody', 'yes', true)",
        &[],
    )
    .await?;
    tx.execute("SELECT set_config('app.account_id', $1, true)", &[&account])
        .await?;
    Ok(())
}

/// Read the operator binding under `app.session_custody`, **for one statement,
/// and put it back**.
///
/// `operator_account_bindings` is readable under `app.operator_custody` or
/// `app.session_custody` and under neither of the two capabilities this module
/// creates (`0019` §A). The setup-only refusal has to read it, and without a
/// capability the read returns no row SILENTLY — which is the fail-OPEN
/// direction, and is exactly how `register_key` let a session register a
/// long-term key while its seat was still mid-setup. Found by
/// `tests/credentials.rs`'s `an_operator_session_requires_totp_before_it_is_usable`
/// on 2026-09-21.
///
/// **Taken around the one statement and not for the transaction**, because
/// `app.session_custody` opens `sessions`, `session_nonces`, `sign_in_attempts`
/// and `session_revocations` as well, and a credential act has no business with
/// any of them. One `SELECT`, then closed again.
async fn holds_operator_custody_here(
    tx: &Transaction<'_>,
    account: &str,
) -> Result<bool, CredentialError> {
    tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
        .await?;
    let held = holds_operator_custody(tx, account).await;
    tx.execute("SELECT set_config('app.session_custody', 'no', true)", &[])
        .await?;
    held
}

/// `0018` §E's unauthenticated capability. **No `app.account_id`**: the reset
/// pair has no session and resolves its account from the address on record or
/// from the token, never from a caller's claim.
async fn enter_reset_custody(tx: &Transaction<'_>) -> Result<(), CredentialError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute("SELECT set_config('app.reset_custody', 'yes', true)", &[])
        .await?;
    Ok(())
}

/// Close every capability this module opens, before the transaction commits, so
/// a connection handed back to the pool carries none of them.
async fn leave_custody(tx: &Transaction<'_>) -> Result<(), CredentialError> {
    for setting in [
        "app.credential_custody",
        "app.reset_custody",
        "app.session_custody",
        "app.enrolment_custody",
        "app.operator_custody",
    ] {
        tx.execute("SELECT set_config($1, 'no', true)", &[&setting])
            .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_list_names_every_label_this_module_uses() {
        let listed: Vec<&str> = LABELS.iter().map(|(name, _)| *name).collect();
        for label in [
            KDF_CREDENTIALS_TOTP,
            AAD_CREDENTIALS_TOTP,
            TAG_BACKUP_CODE,
            TAG_RESET_TOKEN,
        ] {
            let label = std::str::from_utf8(label).expect("a label is text");
            assert!(listed.contains(&label), "{label} is not in LABELS");
        }
        assert_eq!(listed.len(), 4, "LABELS lists a label nothing uses");
    }

    #[test]
    fn every_label_this_module_introduces_is_scoped_and_versioned() {
        for (name, _) in LABELS {
            assert!(name.starts_with("fathom/credentials/"), "{name}");
            assert!(name.ends_with("/v1"), "{name}");
        }
    }

    #[test]
    fn the_parameters_are_the_ones_the_cheat_sheet_names() {
        // The figures, not the reasoning: the reasoning is in the doc comments
        // with the URL and the date. This is the test that notices somebody
        // lowering them in a hurry.
        assert_eq!((ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST), (19456, 2, 1));
        assert_eq!((PASSWORD_MIN, PASSWORD_MAX), (15, 128));
        assert_eq!(TOTP_STEP_SECONDS, 30);
        assert_eq!(TOTP_DIGITS, 6);
        assert_eq!(TOTP_SKEW_STEPS, 1);
        assert_eq!(BACKUP_CODE_COUNT, 10);
        assert_eq!(BACKUP_CODE_CHARS, 16);
    }

    #[test]
    fn a_backup_code_is_eighty_bits_in_four_groups_of_four() {
        let code = new_backup_code().expect("randomness");
        assert_eq!(code.len(), BACKUP_CODE_CHARS + 3, "{code}");
        assert_eq!(code.matches('-').count(), 3, "{code}");
        let normalised = normalise_code(&code);
        assert_eq!(normalised.chars().count(), BACKUP_CODE_CHARS);
        for c in normalised.chars() {
            assert!(
                CROCKFORD.contains(&(c as u8)),
                "{c} is not Crockford base32"
            );
        }
    }

    #[test]
    fn a_backup_code_is_read_back_however_it_is_typed() {
        // Crockford's whole point: the alphabet has no I, L, O or U, so a
        // person who writes a 1 as a serif I is still read correctly.
        assert_eq!(normalise_code("ab12-cd34"), "AB12CD34");
        assert_eq!(normalise_code("abI2 cdO4"), "AB12CD04");
        assert_eq!(normalise_code("AbL2-Cd04"), "AB12CD04");
    }

    #[test]
    fn the_common_list_is_not_empty_and_is_matched_case_folded() {
        assert!(
            COMMON_PASSWORDS.lines().filter(|l| !l.is_empty()).count() > 1000,
            "the bundled common-password list is empty or truncated; \
             deps/decisions/common-passwords.md records what it should hold"
        );
        assert!(is_common_password("password"));
        assert!(is_common_password("PASSWORD"));
    }

    #[test]
    fn base32_is_rfc_4648_and_not_crockford() {
        // RFC 4648 §10's own test vectors, so the encoder is pinned against
        // the document an authenticator application implements.
        assert_eq!(base32_encode(b""), "");
        assert_eq!(base32_encode(b"f"), "MY");
        assert_eq!(base32_encode(b"fo"), "MZXQ");
        assert_eq!(base32_encode(b"foo"), "MZXW6");
        assert_eq!(base32_encode(b"foob"), "MZXW6YQ");
        assert_eq!(base32_encode(b"fooba"), "MZXW6YTB");
        assert_eq!(base32_encode(b"foobar"), "MZXW6YTBOI");
    }

    #[test]
    fn the_otpauth_uri_states_every_parameter_rather_than_relying_on_a_default() {
        let uri = otpauth_uri("deployment", "alice@example.org", &[0u8; 20]);
        assert!(
            uri.starts_with("otpauth://totp/Fathom:alice%40example.org?"),
            "{uri}"
        );
        assert!(uri.contains("algorithm=SHA1"), "{uri}");
        assert!(uri.contains("digits=6"), "{uri}");
        assert!(uri.contains("period=30"), "{uri}");
        // An address with a URI metacharacter in it cannot change the shape of
        // the query string it sits in.
        let awkward = otpauth_uri("d", "a&b=c#d@example.org", &[0u8; 20]);
        assert!(
            !awkward["otpauth://totp/Fathom:".len()..].contains('&')
                || awkward.matches("&issuer=").count() == 1
        );
        assert!(!awkward.contains("#"), "{awkward}");
    }

    #[test]
    fn hotp_matches_rfc_4226_appendix_d() {
        // `deps/decisions/sha1.md`'s condition of approval, and the same shape
        // `deps/decisions/argon2.md` sets for Argon2: an unaudited
        // implementation of a SPECIFIED algorithm is pinned against the
        // specification's own known-answer tests.
        //
        // RFC 4226 Appendix D, the published table for the secret
        // "12345678901234567890", counters 0 through 9.
        let secret = b"12345678901234567890";
        let expected = [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583",
            "399871", "520489",
        ];
        for (counter, want) in expected.iter().enumerate() {
            assert_eq!(
                &totp_code(secret, counter as i64),
                want,
                "counter {counter}"
            );
        }
    }

    #[test]
    fn totp_matches_rfc_6238_appendix_b_for_sha1() {
        // RFC 6238 Appendix B's SHA-1 rows. The RFC prints eight digits; this
        // server produces six, so the comparison is against the last six of
        // each, which is what truncation to six gives.
        let secret = b"12345678901234567890";
        for (unix, want8) in [
            (59i64, "94287082"),
            (1_111_111_109, "07081804"),
            (1_111_111_111, "14050471"),
            (1_234_567_890, "89005924"),
            (2_000_000_000, "69279037"),
        ] {
            let got = totp_code(secret, totp_step(unix));
            assert_eq!(got, want8[2..], "at {unix}");
        }
    }

    #[test]
    fn a_code_is_refused_at_or_below_the_stored_step() {
        // The replay rule, at the unit level; `tests/credentials.rs` drives the
        // same claim through a real sign-in with a real six-digit code.
        let secret = b"12345678901234567890";
        let now = 1_111_111_111i64;
        let step = totp_step(now);
        let code = totp_code(secret, step);
        assert_eq!(verify_totp(secret, &code, now, None), Some(step));
        assert_eq!(verify_totp(secret, &code, now, Some(step)), None);
        assert_eq!(verify_totp(secret, &code, now, Some(step + 5)), None);
    }

    #[test]
    fn one_step_of_skew_either_side_and_no_more() {
        let secret = b"12345678901234567890";
        let now = 1_111_111_111i64;
        let step = totp_step(now);
        assert!(verify_totp(secret, &totp_code(secret, step - 1), now, None).is_some());
        assert!(verify_totp(secret, &totp_code(secret, step + 1), now, None).is_some());
        assert!(verify_totp(secret, &totp_code(secret, step - 2), now, None).is_none());
        assert!(verify_totp(secret, &totp_code(secret, step + 2), now, None).is_none());
    }

    #[test]
    fn anything_that_is_not_six_digits_is_not_a_code() {
        let secret = b"12345678901234567890";
        let now = 1_111_111_111i64;
        for not_a_code in ["", "12345", "1234567", "abcdef", "12 456", "ABCD-EFGH"] {
            assert!(
                verify_totp(secret, not_a_code, now, None).is_none(),
                "{not_a_code}"
            );
        }
    }

    #[test]
    fn the_password_policy_is_length_a_list_and_the_address_and_nothing_else() {
        // A REAL password of the length a person actually chooses (CLAUDE.md
        // rule 2): a four-word passphrase, not a synthetic string tuned to the
        // check.
        assert!(check_password("correct-horse-battery-staple", "alice@example.org").is_ok());
        // No composition rule: fifteen lower-case letters is fine.
        assert!(check_password("aaaaaaaaaaaaaaa", "alice@example.org").is_ok());

        assert!(matches!(
            check_password("short-one-1234", "alice@example.org"),
            Err(CredentialError::PasswordTooShort)
        ));
        assert!(matches!(
            check_password(&"a".repeat(PASSWORD_MAX + 1), "alice@example.org"),
            Err(CredentialError::PasswordTooLong)
        ));
        assert!(matches!(
            check_password("alice@example.org-and-more", "alice@example.org"),
            Err(CredentialError::PasswordContainsAddress)
        ));
        assert!(matches!(
            check_password("ALICE@EXAMPLE.ORG-and-more", "alice@example.org"),
            Err(CredentialError::PasswordContainsAddress)
        ));
    }

    #[test]
    fn a_password_from_the_bundled_list_is_refused_however_it_is_cased() {
        // Taken from the vendored file rather than typed here, so the test
        // cannot drift from the list it is about.
        let longest = COMMON_PASSWORDS
            .lines()
            .filter(|l| l.chars().count() >= PASSWORD_MIN)
            .max_by_key(|l| l.chars().count())
            .expect("the list holds at least one entry of policy length");
        assert!(matches!(
            check_password(longest, "nobody@example.org"),
            Err(CredentialError::PasswordIsCommon)
        ));
        assert!(matches!(
            check_password(&longest.to_uppercase(), "nobody@example.org"),
            Err(CredentialError::PasswordIsCommon)
        ));
    }

    #[test]
    fn a_hash_verifies_and_a_wrong_password_does_not() {
        let hash = hash_password("correct-horse-battery-staple").expect("hash");
        assert!(hash.starts_with("$argon2id$"), "{hash}");
        assert!(verify_password(&hash, "correct-horse-battery-staple"));
        assert!(!verify_password(&hash, "correct-horse-battery-stapl"));
        assert!(!verify_password("not a phc string", "anything at all"));
    }

    #[test]
    fn two_hashes_of_one_password_differ_because_the_salt_does() {
        let a = hash_password("correct-horse-battery-staple").expect("hash");
        let b = hash_password("correct-horse-battery-staple").expect("hash");
        assert_ne!(a, b, "a salt that does not change is not a salt");
        assert!(verify_password(&a, "correct-horse-battery-staple"));
        assert!(verify_password(&b, "correct-horse-battery-staple"));
    }
}
