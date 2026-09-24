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

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
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

/// How long a start's setup password stays live. ADR-0057 decision 1:
/// *"Open for 30 minutes after the server starts. After that, setup is
/// closed until a restart."*
///
/// **The token's own row expiry too**, since the security review's item 3:
/// [`operators::OperatorStore::issue_setup_token`] mints
/// [`SetupSecret`]'s token at exactly this lifetime rather than
/// `operators::ENROLMENT_TOKEN_LIFETIME`'s seventy-two hours, so the window
/// this process enforces in memory and the window the row itself would still
/// answer to after this process exits are the same window, not the first
/// nested inside a much longer second one nobody was told about.
pub const SETUP_SECRET_WINDOW: Duration = Duration::from_secs(30 * 60);

/// **How many live keys one account's browser keyring may hold: ten.**
///
/// `POST /credentials/key` had no cap and no rate limit of its own. Every call
/// appends a sealed `authenticator_registered` entry and inserts an
/// `account_keys` row, and `grants::verify_by_any_live_key` walks the WHOLE
/// live ring verifying each row seal at every sign-in that presents a
/// signature — so one session could grow the sealed audit and the per-sign-in
/// work without bound. It needs a verified session, so the blast radius was
/// one account's own ring plus the site chain; it is closed anyway, because
/// `0014` §B and `0015` §F both argue that an authenticated caller choosing
/// how fast the audit grows is an amplifier whether or not it is an attack.
///
/// Ten rather than two, because ADR-0055 decision 6 is *"any browser, no
/// pairing"* — a person with a laptop, a desktop, a phone and a tablet, who
/// reinstalls one of them twice a year, must never meet this number by
/// accident. The eleventh registration retires the oldest live key, sealed, so
/// the cap refuses nobody: it evicts.
pub const LIVE_ACCOUNT_KEYS_MAX: i64 = 10;

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
    /// This account already has a confirmed authenticator, so enrolment would
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
                f.write_str("this account has no authenticator set up, and this act needs one")
            }
            // **ADR-0056 decision 4: "authenticator", not "app code".** This
            // sentence is a 409's body and a client may print it, which makes
            // it a user-facing string and not an identifier. The client maps
            // the 409 by STATUS and prints its own words; this is what a
            // `curl` and a log line say.
            Self::TotpAlreadyEnrolled => f.write_str(
                "this account already has a confirmed authenticator. Replacing a live second \
                 factor from inside a session is not a form; it is a recovery, and it goes \
                 through the host command ADR-0055 decision 8 names",
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
                "this account holds the operator custody and has no authenticator yet, so its \
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
    // `password-hash 0.6` takes the salt as bytes and encodes it into the PHC
    // string itself; `0.5`'s `SaltString` step is gone with it.
    Ok(hasher()?
        .hash_password_with_salt(password.as_bytes(), &salt)
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

/// Is this — already lowercased — on the bundled list, **as itself, as its
/// stem, or as something a list entry is buried inside?**
///
/// # The rule, stated once
///
/// A password is common when, lowercased:
///
/// 1. it **equals** a list entry; or
/// 2. **with trailing digits and punctuation stripped** it equals a list
///    entry — `password123456789`, `Password1234567!`; or
/// 3. it **contains** a list entry of **eight or more characters** —
///    `passwordpassword`, `qwertyuiopasdfgh`, `iloveyouiloveyou`.
///
/// Rule 1 is the original and is kept. Rules 2 and 3 exist because rule 1 on
/// its own was **inert**, which is CLAUDE.md rule 2's exact failure mode — a
/// gate tested against an input nobody types:
///
/// > [`PASSWORD_MIN`] is fifteen, and 10,000 of the 10,001 lines in
/// > `data/common-passwords.txt` are shorter than fifteen characters, so the
/// > length rule already refused them. **Exactly one entry could ever fire
/// > this check** — `films+pic+galeries` — and that is the entry the test
/// > fixture picked, because it picked the longest line in the file. Driven
/// > over the wire against `POST /credentials/password` on 2026-09-21, every
/// > one of `passwordpassword`, `iloveyouiloveyou`, `qwertyuiopasdfgh`,
/// > `password12345678`, `Password1234567!`, `trustno1trustno1` and
/// > `123456789012345` was ACCEPTED as the password of the account holding the
/// > operator custody.
///
/// Eight, in rule 3, is NIST SP 800-63B revision 4 §3.1.1.2's own floor for a
/// password used with a second factor, read as the shortest string that is a
/// password rather than a syllable: below it, `123456` inside
/// `correct123456horse` would refuse a passphrase that is not in any
/// dictionary. Measured against the vendored list, 2,087 entries are eight or
/// longer, and none of them is inside `correct-horse-battery-staple`,
/// `the-quick-brown-fox-jumps` or `rack-diagram-estate-record`.
///
/// **What this does not claim.** It is not a breach check — decision 10's
/// online option is a separate thing, off by default because Fathom may run
/// air-gapped — and it does not catch every leet variant. It catches the
/// concatenations and paddings of common words that a fifteen-character floor
/// pushes people towards, which is the whole of what the vendored list can
/// reach at this length.
///
/// A linear scan over ten thousand short lines, on a path that is about to run
/// a memory-hard hash costing nineteen mebibytes. Building an index would be
/// optimising the cheap half.
fn is_common_password(lowered: &str) -> bool {
    // Rule 2's stem. `trim_end_matches` and not a regular expression: the
    // dependency ceiling is real (ADR-0055's own dependency note) and this is
    // two predicates.
    let stem = lowered.trim_end_matches(|c: char| c.is_ascii_digit() || c.is_ascii_punctuation());
    COMMON_PASSWORDS.lines().any(|line| {
        if line.is_empty() {
            return false;
        }
        line.eq_ignore_ascii_case(lowered)
            || (!stem.is_empty() && line.eq_ignore_ascii_case(stem))
            || (line.chars().count() >= COMMON_PASSWORD_SUBSTRING_MIN
                && lowered.contains(&line.to_ascii_lowercase()))
    })
}

/// How long a list entry must be before rule 3 of [`is_common_password`] —
/// "contains" — applies to it. Eight, and that function carries the citation.
const COMMON_PASSWORD_SUBSTRING_MIN: usize = 8;

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

/// The `otpauth://` URI the enrolment screen puts on the page.
///
/// ADR-0055 decision 10 said the client would show it as text, because *"a QR
/// code needs an encoder the browser side may not import"*. **ADR-0056
/// decision 5 settled that**: the screen draws the QR code itself, as inline
/// SVG from a zero-dependency encoder in `client/src/qr`, so the
/// Content-Security-Policy does not move and a password manager that
/// photographs the page can read the secret. The setup key and this URI are
/// still on the page beside it, for manual entry and for the person who wants
/// the link.
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
    /// `totp_enrolled_at` as seconds since the epoch, zero when unset.
    /// Carried as well as [`CredentialRow::totp_enrolled`] because the seal
    /// covers the instant and not only the fact (`0025` §A).
    pub totp_enrolled_at_unix: i64,
    /// `0025` §A. `None` is "this account has never had a credential", which
    /// is legal and is what every account created before `0018` is.
    pub credential_seal: Option<Vec<u8>>,
    pub credential_row_version: i32,
    /// The `chain_entries.seq` of the entry that last changed these columns,
    /// zero when none has (see [`credential_state_bytes`]'s doc for the one
    /// act — enrolling a secret that is not yet confirmed — that changes them
    /// without an entry of its own).
    pub credential_seq: i64,
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

    /// `credential_seq` as the column holds it: `NULL` rather than zero.
    pub fn seq_column(&self) -> Option<i64> {
        seq_column(self.credential_seq)
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

/// Everything `accounts.credential_seal` covers, canonically.
///
/// `0025` §A is the schema's statement of this list and wins over this
/// comment. Two choices in it are worth reading twice:
///
/// * **`totp_last_step` is sealed as a BOOLEAN — whether it is set.** Being
///   set is what [`CredentialRow::totp_confirmed`] means and is therefore the
///   authority fact; the value moves on every sign-in, and sealing the value
///   would mean a fresh seal on every sign-in for nothing. What the value
///   carries — "a code accepted once" — is enforced by the guarded `UPDATE`
///   at the moment it advances, which is a concurrency control and not an
///   integrity one.
/// * **The chain seq is the entry that last CHANGED these columns**, and one
///   act changes them without an entry: drawing a TOTP secret that has not
///   been confirmed yet (`enrol_totp`), because `0018` §B's own `CHECK`
///   forces the secret to rest before the person has proved they can read a
///   code off it, and the `totp_enrolled` entry is written at confirmation.
///   That state keeps the previous seq, and the confirmation sets its own.
fn credential_state_bytes(row: &CredentialRow) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert(
        "password_hash".to_string(),
        match &row.password_hash {
            Some(hash) => Json::Str(hash.clone()),
            None => Json::Null,
        },
    );
    map.insert(
        "totp_secret_ct".to_string(),
        match &row.totp_secret_ct {
            Some(ct) => Json::Str(hex(ct)),
            None => Json::Null,
        },
    );
    map.insert(
        "totp_secret_nonce".to_string(),
        match &row.totp_secret_nonce {
            Some(nonce) => Json::Str(hex(nonce)),
            None => Json::Null,
        },
    );
    map.insert(
        "totp_secret_key_epoch".to_string(),
        match row.totp_secret_key_epoch {
            Some(epoch) => Json::Int(epoch as i64),
            None => Json::Null,
        },
    );
    map.insert(
        "totp_enrolled_at_unix".to_string(),
        Json::Int(row.totp_enrolled_at_unix),
    );
    map.insert(
        "totp_confirmed".to_string(),
        Json::Bool(row.totp_confirmed()),
    );
    map.insert(
        "operator_key_hold_until_unix".to_string(),
        Json::Int(row.operator_key_hold_until_unix),
    );
    Json::Obj(map).to_canonical_bytes()
}

/// The seal on one account's credential columns.
///
/// `authority::row_seal` under `grants::site_row_key`, the same key and the
/// same construction `account_keys`, `backup_codes` and
/// `password_reset_tokens` are sealed under — the account plane is
/// site-scoped, and `site_row_key`'s own doc carries that argument. The
/// account id is the seal's `row_id`, so a credential lifted onto another
/// account's row does not verify: the same property `0018` §B's AAD gives the
/// TOTP secret, extended to the four columns beside it that had none.
fn credential_seal(row_key: &Key32, account: &str, row: &CredentialRow) -> [u8; 32] {
    authority::row_seal(
        row_key,
        &RowFacts {
            table: "accounts",
            row_id: account,
            chain_seq: row.credential_seq,
            row_version: row.credential_row_version,
            row_state: &credential_state_bytes(row),
        },
    )
}

/// Is any credential column set at all?
///
/// `operator_key_hold_until` is deliberately not in this list, and `0025` §B
/// says why: the hold is a fact about a seat, a reset writes it on accounts
/// that may have no credential, and a hold with no password is not a state
/// anybody can sign in with. It is INSIDE the seal; it does not by itself
/// REQUIRE one.
fn has_a_credential(row: &CredentialRow) -> bool {
    row.password_hash.is_some()
        || row.totp_secret_ct.is_some()
        || row.totp_secret_nonce.is_some()
        || row.totp_secret_key_epoch.is_some()
        || row.totp_enrolled
        || row.totp_last_step.is_some()
}

/// **The refusal.** A credential state that this server did not write is
/// `Unverifiable`, and `0025`'s header says what that is worth: not that a
/// database holder is locked out of anything, but that the act the row would
/// have authorised is refused rather than performed.
///
/// Three outcomes, and the middle one is the whole point:
///
/// 1. no seal and no credential — the pre-credential state, legal, and what
///    every account created before `0018` is;
/// 2. **no seal and a credential set — refused**, because that is exactly the
///    shape a writer produces who puts a password hash or an app-code secret
///    into the table from outside;
/// 3. a seal — recomputed over the row as it stands, and compared.
fn verify_credential_seal(
    row_key: &Key32,
    account: &str,
    row: &CredentialRow,
) -> Result<(), CredentialError> {
    match &row.credential_seal {
        None if has_a_credential(row) => Err(CredentialError::Unverifiable("credential seal")),
        None => Ok(()),
        Some(stored) => {
            if stored.as_slice() == credential_seal(row_key, account, row).as_slice() {
                Ok(())
            } else {
                Err(CredentialError::Unverifiable("credential seal"))
            }
        }
    }
}

/// Read one account's credential columns **and verify the seal over them**.
///
/// **Every caller reads through this one function**, so a path cannot be
/// written that quietly omits the hold, the replay mark or — since `0025` —
/// the seal. It takes the ring for that reason and no other.
pub async fn read_credentials(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    account: &str,
) -> Result<Option<CredentialRow>, CredentialError> {
    let Some(row) = read_credentials_unverified(tx, account).await? else {
        return Ok(None);
    };
    let row_key = grants::site_row_key(tx, ring).await?;
    verify_credential_seal(&row_key, account, &row)?;
    Ok(Some(row))
}

/// The columns, without the check. **Private, and it stays private**: the two
/// callers are the verification above and the re-sealing below, which reads
/// the row it has just changed and whose seal is therefore stale by
/// construction.
async fn read_credentials_unverified(
    tx: &Transaction<'_>,
    account: &str,
) -> Result<Option<CredentialRow>, CredentialError> {
    let row = tx
        .query_opt(
            "SELECT email, password_hash, totp_secret_ct, totp_secret_nonce, \
                    totp_secret_key_epoch, totp_enrolled_at IS NOT NULL, totp_last_step, \
                    COALESCE(EXTRACT(EPOCH FROM operator_key_hold_until)::bigint, 0), \
                    COALESCE(EXTRACT(EPOCH FROM totp_enrolled_at)::bigint, 0), \
                    credential_seal, credential_row_version, COALESCE(credential_seq, 0) \
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
        totp_enrolled_at_unix: row.get(8),
        credential_seal: row.get(9),
        credential_row_version: row.get(10),
        credential_seq: row.get(11),
    }))
}

/// The seal for the state a transaction is **about to write**, with the
/// version bumped and the seq recorded.
///
/// `next` is the row as it will stand after the `UPDATE`; this mutates its
/// two bookkeeping fields so the caller can splice them into the same
/// statement. **One statement, columns and seal together**, because `0025`
/// §B's constraint trigger asks its question of every row image a transaction
/// leaves behind, and a credential written in one statement and sealed in the
/// next leaves an unsealed image between them. It is also simply true: there
/// is no instant, even inside a transaction, at which the credential is at
/// rest without its seal.
///
/// `seq` is the entry that made the change, or `None` to keep the one already
/// on the row — see [`credential_state_bytes`] for the one act that changes
/// these columns without an entry of its own.
fn next_seal(
    row_key: &Key32,
    account: &str,
    next: &mut CredentialRow,
    seq: Option<i64>,
) -> Vec<u8> {
    next.credential_row_version = next.credential_row_version.saturating_add(1);
    if let Some(seq) = seq {
        next.credential_seq = seq;
    }
    credential_seal(row_key, account, next).to_vec()
}

/// `credential_seq` as the column holds it: `NULL` rather than zero.
fn seq_column(seq: i64) -> Option<i64> {
    (seq != 0).then_some(seq)
}

/// [`next_seal`], for a caller outside this module.
///
/// **The shape a path that writes a FIRST credential has to take**: read the
/// row, change the fields it is about to write, take the seal, and put the
/// columns and the seal in ONE `UPDATE`. `0025` §B's constraint trigger is
/// what requires it — a row image that carries a credential and no seal is
/// refused whichever statement left it behind — and
/// [`CredentialStore::set_password`] is the worked example.
///
/// `next` comes back with `credential_row_version` bumped and
/// `credential_seq` set; [`CredentialRow::seq_column`] is the value the column
/// takes.
pub async fn seal_for_write(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    account: &str,
    next: &mut CredentialRow,
    seq: Option<i64>,
) -> Result<Vec<u8>, CredentialError> {
    let row_key = grants::site_row_key(tx, ring).await?;
    Ok(next_seal(&row_key, account, next, seq))
}

/// **Re-seal an account's credential columns, in the transaction that changed
/// them.** `0025` §A.
///
/// Reads the row back as it now stands — so the seal is over what is actually
/// at rest and not over what the caller believes it wrote — bumps
/// `credential_row_version`, and records `seq` as the entry that made the
/// change. `None` keeps the seq already there.
///
/// **For a row that already carries a seal**, which is every case outside this
/// module: the caller has changed one column on a credential that already
/// exists, so the row image their statement left behind already satisfies
/// `0025` §B and this one only brings the seal up to date. A path that puts a
/// FIRST credential on an unsealed row writes both in one statement instead —
/// [`next_seal`] says why.
///
/// **It is `pub` because three transactions outside this module change a
/// column the seal covers**, and a seal that is not rewritten there is an
/// integrity alarm on an honest act:
///
/// * `sessions::check_second_factor` advances `totp_last_step`
///   ([`reseal_after_totp_step`], which is the spelling that path should
///   call);
/// * `operators::confirm_recovery` clears `operator_key_hold_until`;
/// * any later path that writes one of `0025` §A's columns.
pub async fn reseal_credentials(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    account: &str,
    seq: Option<i64>,
) -> Result<(), CredentialError> {
    let Some(current) = read_credentials_unverified(tx, account).await? else {
        return Err(CredentialError::Corrupt("account"));
    };
    let sealed = CredentialRow {
        credential_row_version: current.credential_row_version.saturating_add(1),
        credential_seq: seq.unwrap_or(current.credential_seq),
        ..current
    };
    let row_key = grants::site_row_key(tx, ring).await?;
    let seal = credential_seal(&row_key, account, &sealed);
    let updated = tx
        .execute(
            "UPDATE accounts \
                SET credential_seal = $2, credential_row_version = $3, credential_seq = $4 \
              WHERE id = $1",
            &[
                &account,
                &seal.to_vec(),
                &sealed.credential_row_version,
                &seq_column(sealed.credential_seq),
            ],
        )
        .await?;
    if updated != 1 {
        return Err(CredentialError::Corrupt("account"));
    }
    Ok(())
}

/// What `sessions::check_second_factor` calls once its guarded `UPDATE` has
/// advanced `totp_last_step` to `step`.
///
/// **In the steady state this changes nothing in the sealed bytes** — the
/// seal covers whether `totp_last_step` is set, not its value
/// ([`credential_state_bytes`]) — so a sign-in that advances an already-
/// confirmed code re-seals the same state at the next version. The case that
/// needs it is the one where the column goes from NULL to set outside
/// `confirm_totp`: an account whose secret is at rest but unconfirmed, whose
/// first accepted code is presented at sign-in.
///
/// `step` is taken and checked rather than ignored, so a caller that reseals
/// after an `UPDATE` which did NOT take effect — the rowcount-0 branch of the
/// guard, which means another request won the race — is told so instead of
/// sealing a state it did not produce.
pub async fn reseal_after_totp_step(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    account: &str,
    step: i64,
) -> Result<(), CredentialError> {
    let Some(current) = read_credentials_unverified(tx, account).await? else {
        return Err(CredentialError::Corrupt("account"));
    };
    if current.totp_last_step != Some(step) {
        return Err(CredentialError::CodeRefused);
    }
    reseal_credentials(tx, ring, account, None).await
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

/// Whether this deployment's first operator has finished setting up.
///
/// ADR-0056 decision 1. The two spellings are the wire's:
/// `GET /setup/state` answers `LP(as_str())` and nothing else, so a client
/// reads one word and never parses a document.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SetupState {
    /// The first operator has no stored credential yet. The client shows the
    /// setup flow and nothing else (decision 2).
    Pending,
    /// Setup is finished, or there is nothing to set up. For ever after.
    Done,
}

impl SetupState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Done => "done",
        }
    }
}

/// How long [`CredentialStore::setup_state`] may answer from memory.
///
/// Five seconds, ADR-0056 decision 1's own number. Long enough that a burst of
/// page loads is one query, short enough that a second browser watching a
/// deployment being set up sees it finish without being told to reload.
pub const SETUP_STATE_CACHE: Duration = Duration::from_secs(5);

/// The remembered answer, **per process and not per store**.
///
/// ADR-0056 decision 1 calls the bit a fact about the deployment, and the two
/// acts that can move it — `operators::bootstrap_first_operator` and
/// `operators::adopt_first_operator_from_install` — run at startup against an
/// `OperatorStore` that holds no `CredentialStore` at all. With a cache per
/// store neither could reach it, so a browser at the door in the five seconds
/// after a first start was told the wrong thing by the very server that had
/// just changed it. A static is what both can reach.
///
/// **Keyed by deployment id.** One process serves one deployment in the
/// product, but not in `cargo test`, where a binary drives several databases
/// side by side; a single unkeyed slot would answer one deployment's question
/// with another's fact, which is a correctness bug before it is a test
/// nuisance.
///
/// Two locks, and they are not interchangeable:
///
/// * `answers` is a `std::sync::Mutex` because nothing is awaited while it is
///   held, and a lock that cannot be held across an await cannot be the reason
///   one request waits on another's database round trip. A poisoned lock is
///   treated as no cached answer — the query is the truth and is always
///   available.
/// * `refresh` is a `tokio::sync::Mutex` and IS held across the query, which
///   is the whole point of it: see [`CredentialStore::setup_state`].
#[derive(Default)]
struct SetupStateCache {
    answers: std::sync::Mutex<HashMap<String, Slot>>,
    /// How many times the query has actually run, per deployment. See
    /// [`setup_state_queries`].
    queries: std::sync::Mutex<HashMap<String, u64>>,
    /// The single-flight gate. One refresh in flight at a time, deployment or
    /// no deployment: the gate exists to bound concurrent unauthenticated
    /// callers, and a gate per deployment would be a map an unauthenticated
    /// caller could grow.
    refresh: tokio::sync::Mutex<()>,
}

/// One deployment's slot: what is remembered, and **which generation of the
/// fact it is remembered from**.
///
/// The generation is the whole of the 2026-09-22 fix. A reader queries, the act
/// that flips the bit commits and calls [`forget_setup_state`], and only then
/// does the reader store what it read — putting `pending` back over a
/// deployment that has finished setting up, for the whole five seconds of
/// [`SETUP_STATE_CACHE`], which is the browser that just finished setup being
/// sent back to step one of it. Forgetting bumps the generation; a put carries
/// the generation its query was issued under and is dropped if that is no
/// longer the current one. It is the ordinary ABA guard, and it is exact: the
/// counter only ever moves forward, under the same lock the answer is stored
/// under.
#[derive(Default, Clone, Copy)]
struct Slot {
    generation: u64,
    answer: Option<(std::time::Instant, SetupState)>,
}

/// The one cache, made on first use.
static SETUP_STATE_CACHE_CELL: OnceLock<SetupStateCache> = OnceLock::new();

fn setup_state_cache() -> &'static SetupStateCache {
    SETUP_STATE_CACHE_CELL.get_or_init(SetupStateCache::default)
}

/// **Forget this deployment's remembered setup state**, because the act that
/// changes it has just committed.
///
/// Called by [`CredentialStore::redeem_setup`], which is the act that finishes
/// setup, and by the two startup acts in `operators.rs` that create the
/// operator the bit is about. A caller that forgets to call it is not wrong for
/// longer than [`SETUP_STATE_CACHE`]; a caller that calls it needlessly costs
/// one query.
/// **It bumps the generation as well as dropping the answer**, so a query that
/// was already in flight when this ran cannot store its now-stale reading
/// afterwards. [`Slot`] carries the argument.
pub fn forget_setup_state(deployment: &str) {
    if let Ok(mut held) = setup_state_cache().answers.lock() {
        let slot = held.entry(deployment.to_string()).or_default();
        slot.generation = slot.generation.wrapping_add(1);
        slot.answer = None;
    }
}

/// How many times the setup-state query has actually run for one deployment.
///
/// **It exists so that the single-flight claim can be measured**, and it is the
/// cheapest honest way to measure it: the alternative is a statistics view
/// PostgreSQL updates asynchronously, which would make the test flaky rather
/// than the claim true. It is per deployment and not per process for the same
/// reason the cache is — a binary driving several databases at once would
/// otherwise measure its neighbours. It counts, and it names nothing.
pub fn setup_state_queries(deployment: &str) -> u64 {
    setup_state_cache()
        .queries
        .lock()
        .ok()
        .and_then(|held| held.get(deployment).copied())
        .unwrap_or(0)
}

impl SetupStateCache {
    fn get(&self, deployment: &str) -> Option<SetupState> {
        let held = self.answers.lock().ok()?;
        let (taken_at, state) = held.get(deployment)?.answer?;
        (taken_at.elapsed() < SETUP_STATE_CACHE).then_some(state)
    }

    /// The generation a reader must carry from **before** its query to the put
    /// after it. A deployment nothing has asked about yet is generation zero,
    /// and asking creates the slot so that a [`forget_setup_state`] arriving
    /// while the query runs has something to bump.
    fn generation(&self, deployment: &str) -> u64 {
        match self.answers.lock() {
            Ok(mut held) => held.entry(deployment.to_string()).or_default().generation,
            // A poisoned lock is no cache at all: `put_if_current` cannot take
            // it either, so nothing is remembered and every caller queries.
            Err(_) => 0,
        }
    }

    /// Remember this answer **only if the fact has not moved since the query
    /// that produced it was issued**. `false` means it was dropped, which is
    /// the forget/put race closing.
    fn put_if_current(&self, deployment: &str, state: SetupState, generation: u64) -> bool {
        let Ok(mut held) = self.answers.lock() else {
            return false;
        };
        let slot = held.entry(deployment.to_string()).or_default();
        if slot.generation != generation {
            return false;
        }
        slot.answer = Some((std::time::Instant::now(), state));
        true
    }

    fn count_query(&self, deployment: &str) {
        if let Ok(mut held) = self.queries.lock() {
            *held.entry(deployment.to_string()).or_insert(0) += 1;
        }
    }
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

        let Some(row) = read_credentials(&tx, &self.ring, &account).await? else {
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

        // `0025`: the hash and the seal over it, in one statement.
        let mut next = row.clone();
        next.password_hash = Some(hash.clone());
        let row_key = grants::site_row_key(&tx, &self.ring).await?;
        let seal = next_seal(&row_key, &account, &mut next, Some(appended.seq));
        tx.execute(
            "UPDATE accounts \
                SET password_hash = $2, credential_seal = $3, credential_row_version = $4, \
                    credential_seq = $5 \
              WHERE id = $1",
            &[
                &account,
                &hash,
                &seal,
                &next.credential_row_version,
                &seq_column(next.credential_seq),
            ],
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

        let Some(row) = read_credentials(&tx, &self.ring, &account).await? else {
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
        // `0025`: the pending secret is at rest, so it is sealed at rest, in
        // the same statement. No entry is appended here — see
        // `credential_state_bytes` — so the seq already on the row stands
        // until the confirmation writes its own.
        //
        // **`totp_enrolled_at` is an explicit instant and no longer `now()`**,
        // because the seal covers it: a value the database chose is a value
        // this server would have to read back before it could seal it.
        let enrolled_at = now_unix();
        let mut next = row.clone();
        next.totp_secret_ct = Some(ciphertext.clone());
        next.totp_secret_nonce = Some(nonce.to_vec());
        next.totp_secret_key_epoch = Some(CHAIN_KEY_EPOCH);
        next.totp_enrolled = true;
        next.totp_enrolled_at_unix = enrolled_at;
        next.totp_last_step = None;
        let row_key = grants::site_row_key(&tx, &self.ring).await?;
        let seal = next_seal(&row_key, &account, &mut next, None);
        tx.execute(
            "UPDATE accounts \
                SET totp_secret_ct = $2, totp_secret_nonce = $3, totp_secret_key_epoch = $4, \
                    totp_enrolled_at = to_timestamp($5::bigint), totp_last_step = NULL, \
                    credential_seal = $6, credential_row_version = $7, credential_seq = $8 \
              WHERE id = $1",
            &[
                &account,
                &ciphertext,
                &nonce.to_vec(),
                &CHAIN_KEY_EPOCH,
                &enrolled_at,
                &seal,
                &next.credential_row_version,
                &seq_column(next.credential_seq),
            ],
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

        let Some(row) = read_credentials(&tx, &self.ring, &account).await? else {
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

        // **The advance IS the guard**, the shape `spend_backup_code` uses one
        // function up: two confirmations racing on one code both read the same
        // `NULL` high-water mark, and only the `UPDATE` sees the other. The
        // row lock serialises them and the loser gets rowcount 0, which is
        // `CodeRefused` — decision 10's *"a code accepted once"*, made true by
        // the write rather than by the read that preceded it.
        let row_key = grants::site_row_key(&tx, &self.ring).await?;
        let mut next = row.clone();
        next.totp_last_step = Some(step);
        let seal = next_seal(&row_key, &account, &mut next, Some(appended.seq));
        let advanced = tx
            .execute(
                "UPDATE accounts \
                    SET totp_last_step = $2, credential_seal = $3, \
                        credential_row_version = $4, credential_seq = $5 \
                  WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)",
                &[
                    &account,
                    &step,
                    &seal,
                    &next.credential_row_version,
                    &seq_column(next.credential_seq),
                ],
            )
            .await?;
        if advanced != 1 {
            return Err(CredentialError::CodeRefused);
        }

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
    ///
    /// **And at most [`LIVE_ACCOUNT_KEYS_MAX`] of them are live at once.**
    /// This route had no cap and no rate limit of its own, so one session
    /// could grow both the sealed audit and the per-sign-in verification work
    /// without bound; the eleventh registration retires the oldest, sealed,
    /// rather than refusing the person their new browser.
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

        let Some(row) = read_credentials(&tx, &self.ring, &account).await? else {
            return Err(CredentialError::Corrupt("account"));
        };
        self.refuse_a_setup_session(&tx, &account, &row).await?;

        // **The cap, before the enrolment.** `grants::retire_oldest_over_cap`
        // retires whatever is over [`LIVE_ACCOUNT_KEYS_MAX`] — oldest first,
        // each row re-sealed at its next version — so the eleventh browser
        // costs the first one its key instead of costing every later sign-in
        // one more signature verification.
        grants::retire_oldest_over_cap(
            &tx,
            &self.ring,
            &account,
            LIVE_ACCOUNT_KEYS_MAX,
            now_unix(),
        )
        .await?;

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
    /// `tests/credentials.rs` asserts that over the wire. What is **narrowed
    /// and not closed** is how long it takes: since the ADR-0055 fix of
    /// 2026-09-21 both branches draw the token, hash it, derive the site row
    /// key and compute a token seal, so the key derivation and the
    /// cryptography no longer depend on whether the address exists. The found
    /// branch still appends a sealed entry and inserts two rows, which the
    /// other cannot mirror without writing rows for an address that belongs to
    /// nobody — [`CredentialStore::issue_reset_token`] carries the argument
    /// and what to do instead when the mail path lands. **Nothing in this file
    /// is a claim that this route is constant time.**
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
        let source: String = source.chars().take(128).collect();

        let found = tx
            .query_opt(
                "SELECT id FROM accounts WHERE email = $1 AND disabled_at IS NULL",
                &[&address],
            )
            .await?;
        let mut issued = None;

        // **Both branches derive the key and compute the seal.** Decision 7
        // asks for *"the same answer and timing for every address"* and OWASP
        // ASVS 5.0.0 6.3.8 forbids enumeration *"through messages, codes or
        // timing"*; before this, an address that resolved to nobody returned
        // here having done nothing but one `SELECT`, and a measurement over
        // HTTP separated the two branches by about 60% (9.8 ms against 6.2 ms
        // on the reviewer's own server, 2026-09-21).
        //
        // `site_row_key` is a round trip and a key derivation, and the seal is
        // the MAC — the same work, on the same values, for an address that
        // exists and one that does not. The id is drawn rather than read so
        // that the seal is over a string of the same shape and length.
        //
        // **What is still not equal, stated rather than claimed away.** The
        // found branch goes on to append a sealed entry and insert a row: the
        // chain's advisory lock, its tip read and two INSERTs. Those are not
        // mirrored, because mirroring them means either writing rows for an
        // address that belongs to nobody — which is the audit amplifier
        // `0014` §B exists against — or taking the site chain's writer lock on
        // an unauthenticated route, which hands a prober a contention signal
        // in place of a timing one. **Nothing here is a claim that this route
        // is constant time.** Closing the rest needs decision 7's mail path,
        // where the whole act moves off the request (stream 5); that is the
        // shape to take when it lands.
        let row_key = grants::site_row_key(&tx, &self.ring).await?;
        let id = ids::new_ulid().to_string();
        let expires = now_unix() + self.reset_lifetime.as_secs() as i64;

        if let Some(found) = found {
            let account: String = found.get(0);
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
        } else {
            // The other half of the equalisation above: the same round trips,
            // the same key, the same seal, over an account id this deployment
            // does not have.
            //
            // The tip read is `chains::append`'s own first query, spelled here
            // rather than called, because what is being mirrored is its COST
            // and not its effect. **Its advisory lock is deliberately not
            // mirrored**: taking the site chain's writer lock on an
            // unauthenticated route for an address that belongs to nobody
            // would hand a caller who knows no address the ability to
            // serialise every sign-in in the deployment, which is a worse
            // thing to give away than the milliseconds it buys back.
            let _ = tx
                .query_opt(
                    "SELECT seq, seal FROM chain_entries \
                      WHERE chain_kind = 'site' AND chain_id = $1 ORDER BY seq DESC LIMIT 1",
                    &[&self.deployment],
                )
                .await?;
            let _ = reset_token_seal(
                &row_key,
                &ResetTokenFacts {
                    id: &id,
                    account_id: &id,
                    token_hash: &hash,
                    source: &source,
                    issued_seq: 1,
                    expires_at_unix: expires,
                    row_version: 1,
                    spent_at_unix: 0,
                },
            );

            // And the chain entry's cryptography, which is the largest single
            // thing the other branch does: canonical metadata, an AEAD over
            // it, a content hash and a seal. **This is a COST mirror and says
            // so** — it is deliberately not a second implementation of
            // `chains::append`'s seal, because a second implementation of a
            // seal is a thing that drifts and this is a thing that must only
            // cost the same. What it costs is what `chains::append_locked`
            // costs with the INSERT taken out.
            let metadata = entry_metadata(
                EntryType::ResetRequested,
                &[
                    ("account", Json::Str(id.clone())),
                    ("source", Json::Str(source.clone())),
                ],
            );
            let nonce = crypto::random_nonce()?;
            // No label on the additional data: a label names a USE, and these
            // bytes are never stored and never opened. `LABELS` stays the
            // four this module actually writes with.
            let sealed = crypto::seal(&row_key, &nonce, &metadata, b"")?;
            let mut content = Vec::with_capacity(sealed.len() + 64);
            crypto::lp(&mut content, &sealed);
            crypto::lp(&mut content, &nonce);
            let digest: [u8; 32] = Sha256::digest(&content).into();
            let _ = crypto::mac(row_key.expose(), &digest);
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

        // **The credential state, seal checked, before anything is written
        // over it.** A reset writes a new `password_hash` into the same sealed
        // state the app-code columns live in, so a row that does not verify is
        // refused here rather than re-sealed with whatever a writer left in it
        // — the fail-closed direction, and ADR-0055 decision 8's host command
        // is the way back from it.
        let Some(row) = read_credentials(&tx, &self.ring, &account).await? else {
            return Err(CredentialError::TokenRefused);
        };
        let address = row.address.clone();
        if address.is_empty() {
            return Err(CredentialError::TokenRefused);
        }

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

        let password_entry = chains::append_site(
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

        // `0025`, over both branches: the hold is inside the seal, so a reset
        // that parks the operator seat seals the parking together with the
        // password it wrote, in one statement.
        let holds_custody = holds_operator_custody(&tx, &account).await?;
        let mut next = row.clone();
        next.password_hash = Some(password_hash.clone());
        if holds_custody {
            next.operator_key_hold_until_unix = now + OPERATOR_KEY_HOLD.as_secs() as i64;
        }
        let seal = next_seal(&row_key, &account, &mut next, Some(password_entry.seq));
        let version = next.credential_row_version;
        let seq = seq_column(next.credential_seq);
        if holds_custody {
            tx.execute(
                "UPDATE accounts SET password_hash = $2, \
                        operator_key_hold_until = to_timestamp($3::bigint), \
                        credential_seal = $4, credential_row_version = $5, credential_seq = $6 \
                  WHERE id = $1",
                &[
                    &account,
                    &password_hash,
                    &next.operator_key_hold_until_unix,
                    &seal,
                    &version,
                    &seq,
                ],
            )
            .await?;
        } else {
            tx.execute(
                "UPDATE accounts SET password_hash = $2, credential_seal = $3, \
                        credential_row_version = $4, credential_seq = $5 \
                  WHERE id = $1",
                &[&account, &password_hash, &seal, &version, &seq],
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
    /// ADR-0057 decision 1 amends ADR-0055 decision 10's last bullet: there is
    /// no token file. The first LP field is the **setup secret**, and
    /// [`CredentialStore::redeem_setup`] below tries it as a live `purpose =
    /// 'setup'` token first — a recovery code `fathom-server recover-operator`
    /// printed is exactly that shape, and is handled exactly as before — and,
    /// only if that fails, as this start's setup password. This is the token
    /// path both fall back to: it sets the password, enrols the app code and
    /// saves the backup codes once the token itself is proven.
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
    /// `require_pending` is `true` only for the setup-password-derived call
    /// [`CredentialStore::redeem_setup`] makes — never for a raw token, a
    /// recovery code included. **The security review that found the blocking
    /// issue this exists to close, in full**: two live `purpose = 'setup'`
    /// tokens for one operator (two containers each minting their own at
    /// start, or a recovery code minted before a restart standing beside the
    /// new start's own) both matched the same `FATHOM_SETUP_PASSWORD`, so
    /// finishing setup through one left the other able to overwrite the
    /// password it had just set — through a *different*, still-live DB row,
    /// which single-use-per-token alone does nothing to stop. `require_pending`
    /// closes it two ways, together:
    ///
    /// 1. **The `UPDATE` itself is guarded**, `AND password_hash IS NULL`,
    ///    and a caller who does not know the row already has a stored
    ///    password gets zero updated rows and [`CredentialError::TokenRefused`].
    ///    This is what closes the RACE: two transactions racing this same
    ///    guarded statement each take the row lock in turn, the loser's
    ///    `WHERE` re-evaluates under it and no longer matches, and it is
    ///    Postgres's own MVCC doing the serialising, not a check this code
    ///    could be timed around.
    /// 2. **Spending any setup-class token, either way, expires every other
    ///    live one for the same operator** — [`operators::OperatorStore::expire_live_tokens`],
    ///    the exact sweep [`operators::OperatorStore::recover_operator`]
    ///    already ran before this fix, ported to the path that did not have
    ///    it. A second still-live token minted before this one is no longer
    ///    presentable at all, guard or no guard.
    async fn redeem_setup_by_token(
        &self,
        operators: &operators::OperatorStore,
        token: &[u8],
        new_password: &str,
        require_pending: bool,
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
        // Whichever token this was, no OTHER live `purpose = 'setup'` token
        // for this operator survives its spend — see the doc above.
        operators
            .expire_live_tokens(&tx, operators::Purpose::Setup, &operator, "setup_redeemed")
            .await?;

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

        let Some(row) = read_credentials(&tx, &self.ring, &account).await? else {
            return Err(CredentialError::TokenRefused);
        };
        let address = row.address.clone();
        if address.is_empty() {
            return Err(CredentialError::TokenRefused);
        }
        // The read half of the guard: a setup-password redemption against an
        // account that already holds a credential is refused before it ever
        // hashes the candidate password, let alone reaches the `UPDATE`.
        // Left to the `UPDATE` alone this would still be safe (see above),
        // but a caller who cannot possibly win must not pay argon2id's cost
        // to be told so.
        if require_pending && row.password_hash.is_some() {
            return Err(CredentialError::TokenRefused);
        }

        check_password(new_password, &address)?;
        let password_hash = hash_password(new_password)?;

        let password_entry = chains::append_site(
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
        let mut next = row.clone();
        next.password_hash = Some(password_hash.clone());
        let row_key = grants::site_row_key(&tx, &self.ring).await?;
        let seal = next_seal(&row_key, &account, &mut next, Some(password_entry.seq));
        let updated = if require_pending {
            tx.execute(
                "UPDATE accounts SET password_hash = $2, credential_seal = $3, \
                        credential_row_version = $4, credential_seq = $5 \
                  WHERE id = $1 AND password_hash IS NULL",
                &[
                    &account,
                    &password_hash,
                    &seal,
                    &next.credential_row_version,
                    &seq_column(next.credential_seq),
                ],
            )
            .await?
        } else {
            tx.execute(
                "UPDATE accounts SET password_hash = $2, credential_seal = $3, \
                        credential_row_version = $4, credential_seq = $5 \
                  WHERE id = $1",
                &[
                    &account,
                    &password_hash,
                    &seal,
                    &next.credential_row_version,
                    &seq_column(next.credential_seq),
                ],
            )
            .await?
        };
        // The write half of the guard. Rolled back with everything else in
        // this transaction: the token this call already spent above, and the
        // `PasswordSet` entry just appended, neither of which may stand for
        // an act that did not, in the end, change the row it was about.
        if require_pending && updated == 0 {
            return Err(CredentialError::TokenRefused);
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        // The one bit `GET /setup/state` answers has just moved, and the cache
        // must not answer "pending" for another five seconds to the very
        // browser that did it.
        forget_setup_state(&self.deployment);
        Ok(())
    }

    /// `POST /enrolment/operator/setup` — ADR-0057 decision 1's "setup
    /// secret" in front of [`CredentialStore::redeem_setup_by_token`].
    ///
    /// **Compared against the in-memory setup password first, and only on a
    /// miss is `candidate` even asked whether it is shaped like a recovery
    /// code.** The security review's item 5, both rounds. Round 1: the other
    /// order sent a hash of every candidate — including a candidate that was
    /// in fact the real setup password — to PostgreSQL as a bind parameter
    /// before the in-process comparison ever ran, which is a derivative of
    /// the secret reaching a system that did not need it for every wrong
    /// guess and every right one alike. `SetupSecret::token_for` is a fixed
    /// pair of SHA-256 digests compared in this process, nothing sent
    /// anywhere. Round 2, finished: on a miss, `candidate` is no longer
    /// assumed to already BE a raw token — [`parse_recovery_code`] decides
    /// whether the text is shaped like one (an `op_` line, tolerant of case,
    /// spaces and hyphens, the same as `client/src/api/enrolment.ts`'s
    /// `parseToken`) and only a candidate that parses reaches the database
    /// at all, decoded, exactly as [`CredentialStore::redeem_setup_by_token`]
    /// has always tried one. A recovery code `fathom-server recover-operator`
    /// prints reaches the database this way and needs nothing more: it will
    /// as a rule not equal the setup password, so the first comparison is a
    /// fast, certain miss and the second is what redeems it.
    ///
    /// `setup_secret` is `None` whenever `FATHOM_SETUP_PASSWORD` is unset,
    /// fails the account password policy, or this deployment's first operator
    /// has already finished setup (`main.rs`, at every start) — decision 1's
    /// "setup is closed", carried here as the absence of anything to match
    /// against rather than a second code path.
    ///
    /// Every refusal is still [`CredentialError::TokenRefused`], whichever of
    /// the two attempts it came from and whichever of "wrong", "spent",
    /// "expired", "the window closed" or "setup is closed" caused it — one
    /// fact from outside, as decision 1 asks, and the route above renders one
    /// sentence for it.
    ///
    /// **`source` is for the security review's item 4 and nothing else** — a
    /// process-wide brute-force limit on the setup password. It is never read
    /// from, only logged beside a refusal, and never touches the account or
    /// the candidate.
    pub async fn redeem_setup(
        &self,
        operators: &operators::OperatorStore,
        setup_secret: Option<&SetupSecret>,
        candidate: &[u8],
        new_password: &str,
        source: &str,
    ) -> Result<(), CredentialError> {
        let result = self
            .redeem_setup_trying_password_first(operators, setup_secret, candidate, new_password)
            .await;
        if let Err(CredentialError::TokenRefused) = &result {
            log_setup_secret_refusal(&self.deployment, source);
        }
        result
    }

    async fn redeem_setup_trying_password_first(
        &self,
        operators: &operators::OperatorStore,
        setup_secret: Option<&SetupSecret>,
        candidate: &[u8],
        new_password: &str,
    ) -> Result<(), CredentialError> {
        // The brute-force limit closes ONLY this comparison — the security
        // review's item 4 names it "close setup", and this is the half of
        // setup that is actually guessable; the raw-token path just below is
        // 256 bits and stays open, because a recovery code is how a person
        // holding one gets back in and a flood of wrong passwords must not
        // be able to take that away too.
        //
        // **The reservation happens before `token_for`, in the same
        // critical section as the count check — round 2 of the security
        // review.** Round 1 read the count, then compared, then counted only
        // a refusal, all as separate steps; sixty concurrent callers each
        // read "not yet closed" before any of them had finished a single
        // comparison, so all sixty compared, including the right password
        // arriving last in the burst, well past where twenty ought to have
        // closed it. `reserve_setup_secret_attempt` makes "is there budget"
        // and "spend one unit of it" one atomic step, so at most
        // [`SETUP_SECRET_REFUSAL_LIMIT`] concurrent attempts — right or
        // wrong — ever reach a comparison at all.
        if let Some(secret) = setup_secret {
            if reserve_setup_secret_attempt(&self.deployment) {
                if let Some(token) = secret.token_for(candidate, std::time::Instant::now()) {
                    return self
                        .redeem_setup_by_token(operators, &token, new_password, true)
                        .await;
                }
            }
        }
        // Security review, round 2, item 5, finished: the client sends
        // exactly what was typed now, `op_` codes included, so this is the
        // only place that decides whether the same text is shaped like a
        // recovery code at all. Anything that is not reaches no database.
        match parse_recovery_code(candidate) {
            Some(token) => {
                self.redeem_setup_by_token(operators, &token, new_password, false)
                    .await
            }
            None => Err(CredentialError::TokenRefused),
        }
    }

    // -----------------------------------------------------------------------
    // ADR-0056 decisions 1 and 2 — the two reads the setup screen makes
    // -----------------------------------------------------------------------

    /// **Has this deployment's first operator finished setting up?** One bit
    /// about the deployment, never about an address.
    ///
    /// ADR-0056 decision 1. `pending` while the install's first operator — the
    /// operator bound (`0019` §A) to the account at `site_install.notice_address`
    /// (`0015` §C), which on a native install is the one
    /// `bootstrap_first_operator` minted and on an upgraded one is the adopted
    /// operator — has no stored credential. `done` otherwise, and `done` when
    /// there is no install record or no such account at all: the setup screen
    /// would have nothing to offer, so sending a visitor to it would be a door
    /// onto a wall.
    ///
    /// **Why it is here and not beside the bootstrap.** The bit is the state
    /// of one column of `accounts`, this module is the only one that reads
    /// that column, and `tests/operators.rs` forbids naming it in
    /// `operators.rs` outside the handlers ADR-0055 allowlists. The act that
    /// flips the bit — [`CredentialStore::redeem_setup`] — is a few lines
    /// above.
    ///
    /// **It discloses nothing new.** A visitor to a pending deployment is
    /// shown the setup screen; the answer is what they would see. The
    /// per-address answers of `/session` are untouched in content and in time,
    /// which is what ASVS 5.0.0 6.3.8 is about.
    ///
    /// **Cached for [`SETUP_STATE_CACHE`], process-wide and single-flight.**
    /// The query is one index lookup on each of three tables, and the client
    /// asks it on every page load.
    ///
    /// The 2026-09-22 review measured what the cache actually bounded and found
    /// it was not what the ADR-0056 build claimed: C concurrent callers arriving
    /// while the answer was stale each ran the query, because the cache was
    /// read, missed, and then every one of them went to the pool — eight
    /// connections, and an unauthenticated caller choosing how many of them to
    /// take. The gate below is the fix and it is the ordinary one: **the first
    /// caller through does the work and the rest wait for its answer.** A
    /// waiter re-reads the cache after taking the gate, so it takes the
    /// refresher's answer rather than starting a second refresh behind it.
    ///
    /// An error is not cached, so a deployment whose database is down does not
    /// hold a wrong answer for five seconds; the next caller retries.
    ///
    /// **Nor is an answer the fact has already moved past.** The second round of
    /// the 2026-09-22 review found the remaining window: a reader that queried
    /// `pending` before [`CredentialStore::redeem_setup`] committed could store
    /// it AFTER `forget_setup_state` had run, and the deployment that had just
    /// finished setting up answered `pending` for another five seconds — which
    /// is the browser that did it being sent back to step one. The put carries
    /// the generation its query was issued under and is dropped if a forget has
    /// landed in between ([`Slot`]).
    ///
    /// **The route charges the per-source budget as well** (`api.rs`). The
    /// cache bounds the database and the budget bounds the request, and the
    /// build that had only the first of those left one unauthenticated route
    /// that cost nothing to call.
    pub async fn setup_state(&self) -> Result<SetupState, CredentialError> {
        let cache = setup_state_cache();
        if let Some(state) = cache.get(&self.deployment) {
            return Ok(state);
        }
        // Single flight. Held across the query on purpose: what waits here is a
        // request that would otherwise have been a second copy of the query the
        // holder is already running.
        let _refreshing = cache.refresh.lock().await;
        if let Some(state) = cache.get(&self.deployment) {
            return Ok(state);
        }
        // **Read before the query, checked after it**: see [`Slot`]. Anything
        // that moves the bit between these two lines makes this reading stale,
        // and a stale reading must not be remembered for five seconds.
        let generation = cache.generation(&self.deployment);
        cache.count_query(&self.deployment);
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        // `site_install` is readable under enrolment custody, the binding and
        // the account under session custody (`0015` §H, `0019` §A, `0018` §E).
        // The same pair `redeem_setup` above holds, for the same rows.
        operators::enter_enrolment_custody(&tx).await?;
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await?;

        let row = tx
            .query_opt(
                "SELECT a.password_hash IS NULL \
                   FROM site_install s \
                   JOIN accounts a ON a.email = s.notice_address \
                   JOIN operator_account_bindings b ON b.account_id = a.id \
                  WHERE s.id = 'install'",
                &[],
            )
            .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;

        let state = match row {
            Some(row) if row.get::<_, bool>(0) => SetupState::Pending,
            _ => SetupState::Done,
        };
        cache.put_if_current(&self.deployment, state, generation);
        Ok(state)
    }

    /// **Is this a live setup token, and whose address does it open?**
    ///
    /// ADR-0056 decision 1, step 1 of the setup flow: the person pastes the
    /// line from the token file and the server names the address, so the
    /// address is never typed and can never mismatch. The owner's ask — *"give
    /// an error if the email doesn't match"* — is met by removing the field.
    ///
    /// **It spends nothing and writes nothing.** The lookup is
    /// `operators::check_setup_token`, which is `spend_setup_token`'s own
    /// checks without the `UPDATE` and without the entry; this transaction
    /// rolls back whatever it did, and there is nothing to roll back.
    ///
    /// `require_pending` is `true` only for the setup-password-derived call
    /// [`CredentialStore::check_setup`] makes: an account that already holds
    /// a credential refuses here too, and stops naming the address, for the
    /// same reason [`CredentialStore::redeem_setup_by_token`]'s guarded
    /// `UPDATE` refuses the write — the setup password opens a screen for an
    /// operator who has not finished setup, never a second way to learn who
    /// an account belongs to once it has.
    ///
    /// Every refusal is [`CredentialError::TokenRefused`] — wrong, spent,
    /// expired and malformed alike — and the route answers one sentence for
    /// all of them.
    async fn check_setup_by_token(
        &self,
        operators: &operators::OperatorStore,
        token: &[u8],
        require_pending: bool,
    ) -> Result<String, CredentialError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        // `redeem_setup`'s custodies minus `reset_custody`: nothing here
        // writes a credential column, so nothing here asks for the capability
        // that would let it.
        operators::enter_enrolment_custody(&tx).await?;
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await?;

        let operator = match operators.check_setup_token(&tx, token).await {
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
        // No binding, no account, no address on it: one refusal for each, as
        // `redeem_setup` gives, because a caller holding a real token learns
        // nothing from the difference and a caller holding none must not.
        let Some(account) = account else {
            return Err(CredentialError::TokenRefused);
        };
        let Some(row) = read_credentials(&tx, &self.ring, &account).await? else {
            return Err(CredentialError::TokenRefused);
        };
        if row.address.is_empty() {
            return Err(CredentialError::TokenRefused);
        }
        if require_pending && row.password_hash.is_some() {
            return Err(CredentialError::TokenRefused);
        }

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(row.address)
    }

    /// `POST /enrolment/operator/setup/check` — ADR-0057 decision 1's "setup
    /// secret" in front of [`CredentialStore::check_setup_by_token`].
    ///
    /// **Compared against the in-memory setup password first**, exactly as
    /// [`CredentialStore::redeem_setup`] now does and for the same reason
    /// (the security review's item 5, both rounds): only a miss asks
    /// [`parse_recovery_code`] whether `candidate` is shaped like a recovery
    /// code at all, which is what a recovery code `fathom-server
    /// recover-operator` prints needs — it will as a rule miss the first
    /// comparison and be found by the second.
    ///
    /// `source` is [`CredentialStore::redeem_setup`]'s own: logged beside a
    /// refusal, and the budget [`reserve_setup_secret_attempt`] spends is the
    /// same process-wide one — one budget across both routes, since a caller
    /// can check for free and then redeem, and a limit that only watched one
    /// of the two routes would not be a limit.
    pub async fn check_setup(
        &self,
        operators: &operators::OperatorStore,
        setup_secret: Option<&SetupSecret>,
        candidate: &[u8],
        source: &str,
    ) -> Result<String, CredentialError> {
        let result = self
            .check_setup_trying_password_first(operators, setup_secret, candidate)
            .await;
        if let Err(CredentialError::TokenRefused) = &result {
            log_setup_secret_refusal(&self.deployment, source);
        }
        result
    }

    async fn check_setup_trying_password_first(
        &self,
        operators: &operators::OperatorStore,
        setup_secret: Option<&SetupSecret>,
        candidate: &[u8],
    ) -> Result<String, CredentialError> {
        // See `redeem_setup_trying_password_first`: the limit closes only
        // this comparison, never the raw-token path a recovery code needs,
        // and the reservation is atomic with the count check for the same
        // reason (security review, round 2, item A).
        if let Some(secret) = setup_secret {
            if reserve_setup_secret_attempt(&self.deployment) {
                if let Some(token) = secret.token_for(candidate, std::time::Instant::now()) {
                    return self.check_setup_by_token(operators, &token, true).await;
                }
            }
        }
        // Security review, round 2, item 5, finished: see
        // `redeem_setup_trying_password_first`.
        match parse_recovery_code(candidate) {
            Some(token) => self.check_setup_by_token(operators, &token, false).await,
            None => Err(CredentialError::TokenRefused),
        }
    }

    /// **Which operator, if any, should receive a fresh setup secret this
    /// start?** ADR-0057 decision 1: *"Every start while setup is pending
    /// means the first operator has no stored credential. That covers the
    /// first start, the adoption path, and any later start still pending."*
    ///
    /// One query rather than three special cases in `main.rs`: the operator
    /// bound to the install's notice address, if that account still holds no
    /// stored password. `None` on every other shape — no install record, no
    /// binding yet (the first start has not run), or a credential already
    /// set, which is decision 1's "setup is finished".
    ///
    /// The same join [`CredentialStore::setup_state`] runs, with the operator
    /// id selected instead of the bit — kept here for
    /// `tests/operators.rs`'s reason: this module is the one place a `password`
    /// column may be named outside the handlers ADR-0055 allowlists.
    pub async fn operator_pending_setup(&self) -> Result<Option<String>, CredentialError> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        operators::enter_enrolment_custody(&tx).await?;
        tx.execute("SELECT set_config('app.session_custody', 'yes', true)", &[])
            .await?;

        let row = tx
            .query_opt(
                "SELECT b.operator_id \
                   FROM site_install s \
                   JOIN accounts a ON a.email = s.notice_address \
                   JOIN operator_account_bindings b ON b.account_id = a.id \
                  WHERE s.id = 'install' AND a.password_hash IS NULL",
                &[],
            )
            .await?;

        leave_custody(&tx).await?;
        tx.commit().await?;
        Ok(row.map(|r| r.get(0)))
    }

    /// End every live session of one account, recording each.
    ///
    /// The shape `sessions::sign_out_in` uses — the sealed entry first, then
    /// the `session_revocations` row whose MAC covers its seq, then the delete
    /// — rather than a bare `DELETE`, because `0014` §D's whole argument is
    /// that deleting a session row is undone by a restore and a revocation row
    /// is not. Written here rather than called there because `sign_out_in`
    /// takes a `VerifiedSession`, and a reset has none: nobody is signed in.
    ///
    /// **Both planes, since the ADR-0055 fix of 2026-09-21.** It ended only
    /// `principal_kind = 'steward'` sessions, so an operator-kind session of
    /// the operator bound to this account survived the reset of the password
    /// that person signs in with — and decision 7 says *"Every other session
    /// of the account ends"* without qualification. The operator principal has
    /// an id of its own, so no filter on `principal_id` could ever have caught
    /// it: it is resolved through `operator_account_bindings` (`0019` §A),
    /// which this transaction can read because `redeem_reset` holds
    /// `app.session_custody` for the revocation rows anyway.
    ///
    /// Each plane's own entry type: `account_signed_out` for the account's
    /// sessions, `operator_signed_out` for the operator's — both already on
    /// the site chain's list (`0018` §F), so no schema change is needed to
    /// say which plane ended.
    async fn end_every_session_of(
        &self,
        tx: &Transaction<'_>,
        account: &str,
    ) -> Result<(), CredentialError> {
        self.end_sessions_of_principal(tx, account, PrincipalKind::Steward, account)
            .await?;

        // The operator bound to this account, if there is one. A binding is
        // one row (`0019` §A's unique account), and its own seal is the
        // operator plane's to verify — reading it here is a membership
        // question, and the act it drives is ENDING sessions, so a forged
        // binding costs somebody a sign-out and grants nobody anything.
        let bound: Option<String> = tx
            .query_opt(
                "SELECT operator_id FROM operator_account_bindings WHERE account_id = $1",
                &[&account],
            )
            .await?
            .map(|r| r.get(0));
        if let Some(operator) = bound {
            self.end_sessions_of_principal(tx, &operator, PrincipalKind::Operator, account)
                .await?;
        }
        Ok(())
    }

    /// One plane's worth of [`CredentialStore::end_every_session_of`].
    ///
    /// `account` is carried into the entry as well as `principal`, because on
    /// the operator branch the two differ and the sealed record has to say
    /// whose password reset ended an operator's session.
    async fn end_sessions_of_principal(
        &self,
        tx: &Transaction<'_>,
        principal: &str,
        kind: PrincipalKind,
        account: &str,
    ) -> Result<(), CredentialError> {
        let (kind_name, entry_type) = match kind {
            PrincipalKind::Steward => ("steward", EntryType::AccountSignedOut),
            PrincipalKind::Operator => ("operator", EntryType::OperatorSignedOut),
        };
        let rows = tx
            .query(
                "SELECT id FROM sessions WHERE principal_id = $1 AND principal_kind = $2",
                &[&principal, &kind_name],
            )
            .await?;
        let row_key = grants::site_row_key(tx, &self.ring).await?;
        for row in rows {
            let id: String = row.get(0);
            let appended = chains::append_site(
                tx,
                &self.ring,
                &self.deployment,
                entry_type,
                &entry_metadata(
                    entry_type,
                    &[
                        ("session", Json::Str(id.clone())),
                        ("account", Json::Str(account.to_string())),
                        ("principal", Json::Str(principal.to_string())),
                        ("principal_kind", Json::Str(kind_name.to_string())),
                    ],
                ),
            )
            .await?;
            let facts = crate::sessions::RevocationFacts {
                session_id: &id,
                principal_id: principal,
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
                &[&id, &principal, &facts.reason, &appended.seq, &mac.to_vec()],
            )
            .await?;
            tx.execute("DELETE FROM sessions WHERE id = $1", &[&id])
                .await?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// ADR-0057 decision 1 — the setup password, held in memory
// ---------------------------------------------------------------------------

/// **One sentence for every refused setup secret** — wrong, an expired
/// window, or setup closed altogether. ADR-0057 decision 1 verbatim:
/// *"refuse exactly as a bad token is refused: same status, same budget
/// charge, same timing path."* `api.rs`'s check route renders this in place
/// of the token-file sentence it used to carry; the redeem route already
/// answers the same way a bad token always has
/// ([`CredentialError::TokenRefused`] → `sign-in refused`), so this text
/// belongs to the one route that ever explained itself.
pub const SETUP_SECRET_REFUSED: &str = "Setup password is missing, invalid or expired. Setup \
     stays open for 30 minutes after the server starts.";

/// **This start's setup password, and the token it stands in for.**
///
/// ADR-0057 decision 1: no token file. `main.rs` builds one of these at every
/// start where `FATHOM_SETUP_PASSWORD` passes the account password policy and
/// this deployment's first operator still has no stored password — see
/// [`CredentialStore::operator_pending_setup`] — and holds it in
/// [`crate::api::CredentialApiState`] and nowhere else. A start with no valid
/// setup password, or nothing left pending, builds none: `check_setup` and
/// `redeem_setup` then have only the token path a recovery code still uses.
///
/// **The password itself is not kept.** Only its SHA-256 is, so what
/// [`SetupSecret::token_for`] compares are two 32-byte digests — the shape
/// [`constant_time_eq`] wants regardless of how long the typed password
/// was — and a `Debug` derive here would still have nothing to print.
#[derive(Clone)]
pub struct SetupSecret {
    hash: [u8; 32],
    token: [u8; 32],
    /// The instant after which the window is closed, however live the
    /// underlying token row still is. **`Instant`, not a wall-clock
    /// timestamp** — the security review's item 6: a step in the system
    /// clock (NTP, a manual change, a leap second) must not open or close
    /// this window early or late, so it is measured against this process's
    /// own monotonic clock, the one thing [`std::time::Instant`] is for.
    /// Still a plain value the caller computes and not read here, so a test
    /// can set it to anything without controlling any clock at all —
    /// decision 1's *"make the window injectable for tests"*.
    closes_at: std::time::Instant,
}

impl SetupSecret {
    /// `token` is [`crate::operators::OperatorStore::issue_setup_token`]'s
    /// own bytes, minted once at this start; `closes_at` is ordinarily
    /// `Instant::now() + `[`SETUP_SECRET_WINDOW`], computed by the caller
    /// and not here, for the same reason.
    pub fn new(setup_password: &str, token: [u8; 32], closes_at: std::time::Instant) -> Self {
        Self {
            hash: Sha256::digest(setup_password.as_bytes()).into(),
            token,
            closes_at,
        }
    }

    /// The in-memory token, if `candidate` is this start's setup password and
    /// the window is still open at `now`. `None` on a mismatch or an expired
    /// window — one predicate, so the two causes are refused exactly alike
    /// from outside.
    fn token_for(&self, candidate: &[u8], now: std::time::Instant) -> Option<[u8; 32]> {
        if now >= self.closes_at {
            return None;
        }
        let candidate_hash: [u8; 32] = Sha256::digest(candidate).into();
        if constant_time_eq(&candidate_hash, &self.hash) {
            Some(self.token)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Security review item 5, finished — only a recovery-code shape reaches the
// database as a token
// ---------------------------------------------------------------------------

/// **The one place left that decides whether typed text is shaped like a
/// recovery code — security review, round 2, item 5.**
///
/// Round 1 had the CLIENT decide this (`setupSecretBytes`,
/// `client/src/components/FirstRun.tsx`): an explicit `op_` prefix was
/// decoded to raw bytes before the request was ever sent, and everything
/// else went as typed. The round-2 probes found two shapes that decided it
/// wrong — `op3f9c…` with no underscore, and a hyphenated `OP-3f9c9…` — both
/// of which the client's own lenient `parseToken` reads as a token (its
/// prefix is `(op|inv|org)_?`, the underscore optional, and its own noise
/// filter throws hyphens away before the prefix is even read), and either
/// could in principle be what an installer actually typed as a setup
/// password, not a recovery code at all.
///
/// The fix moves the decision here, and makes the client stop making it at
/// all: `FirstRun.tsx`'s `setupSecretBytes` now sends exactly what was
/// typed, as UTF-8, every time, `op_` codes included. The setup password is
/// still compared first, in memory, byte for byte
/// ([`SetupSecret::token_for`]) — so a real setup password that happens to
/// LOOK like a recovery code still matches on the first comparison and never
/// reaches this function at all. Only once that comparison misses does this
/// decide whether the same text is shaped like a recovery code; anything it
/// says no to is refused without a database query, exactly as if there were
/// no fallback at all.
///
/// **The same tolerance the client's `parseToken` has** — noise
/// (whitespace, a soft hyphen a terminal's line wrap can insert, and a
/// hyphen a person retyping one by hand reaches for) is discarded and case
/// is folded before anything is compared, and the `_` after `op` is
/// optional, matching `TOKEN_PREFIX_RE`'s `(op|inv|org)_?` — because this
/// function replaces the client's decision, it has to tolerate exactly what
/// the client's decision used to.
///
/// **Not a length check.** `docs/RUNNING-IT.md` and `.env.example` suggest
/// `openssl rand -base64 24` for the setup password, which is exactly 32
/// characters — the same length as nothing this function looks at, because
/// it never compares a length against anything. It looks for one shape —
/// `op`, optionally `_`, then exactly 64 hex digits — and refuses everything
/// else, whatever its length.
fn parse_recovery_code(candidate: &[u8]) -> Option<[u8; 32]> {
    let text = std::str::from_utf8(candidate).ok()?;
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{00AD}' && *c != '-')
        .flat_map(|c| c.to_lowercase())
        .collect();
    let hex = cleaned.strip_prefix("op")?;
    let hex = hex.strip_prefix('_').unwrap_or(hex);
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Security review item 4 — the brute-force limit on the setup password
// ---------------------------------------------------------------------------

/// How many attempts against the setup password this process permits, per
/// deployment, before it stops comparing a candidate against it at all.
///
/// Twenty: enough that a person who mistypes their own password a few times
/// is never the one who trips it, and small enough that guessing a
/// human-chosen password never gets near a useful number of tries. Nothing
/// clears the count but a restart, on purpose — there is no route that
/// could, and a caller who found one would have found a way to keep
/// guessing forever.
///
/// **Every attempt spends one unit, not only a wrong one** — security
/// review, round 2, item A: the budget is reserved before the comparison
/// runs at all ([`reserve_setup_secret_attempt`]), so a password that turns
/// out to be right still spent the unit it reserved. It is not refunded;
/// "right" is not a reason a concurrent flood should get to keep guessing.
const SETUP_SECRET_REFUSAL_LIMIT: u32 = 20;

/// Setup-secret attempts this process has counted, per deployment — keyed
/// the way [`SETUP_STATE_CACHE_CELL`] is, and for the identical reason: one
/// process serves one deployment in the product and several, side by side,
/// in `cargo test`.
static SETUP_SECRET_REFUSALS: OnceLock<std::sync::Mutex<HashMap<String, u32>>> = OnceLock::new();

fn setup_secret_refusals() -> &'static std::sync::Mutex<HashMap<String, u32>> {
    SETUP_SECRET_REFUSALS.get_or_init(Default::default)
}

/// **Reserve one attempt against `deployment`'s budget, atomically —
/// security review, round 2, item A.**
///
/// Round 1 checked the budget, compared, and counted only an actual
/// refusal — three separate steps, none of them holding the lock across the
/// others. The round-2 probe fired sixty concurrent checks, fifty-nine
/// wrong and the right one last; every one of the sixty read "budget
/// remains" before any of them had finished a single comparison, so every
/// one of the sixty compared, the right password included, long after
/// twenty attempts ought to have closed it.
///
/// The fix: the check and the spend are one critical section, under the
/// same lock `setup_secret_refusals` always used, so a `true` answer has
/// already spent its unit before the caller ever compares anything, and a
/// `false` answer means somebody else already spent the last one — the
/// caller must not touch the database on the strength of a budget that was
/// gone before this call started.
///
/// Logged once, loudly, on the call that crosses the limit — the closing
/// line always was.
fn reserve_setup_secret_attempt(deployment: &str) -> bool {
    let mut refusals = setup_secret_refusals()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let count = refusals.entry(deployment.to_string()).or_insert(0);
    if *count >= SETUP_SECRET_REFUSAL_LIMIT {
        return false;
    }
    *count += 1;
    let reached_limit = *count == SETUP_SECRET_REFUSAL_LIMIT;
    drop(refusals);
    if reached_limit {
        tracing::warn!(
            deployment,
            limit = SETUP_SECRET_REFUSAL_LIMIT,
            "SETUP PASSWORD CLOSED: {SETUP_SECRET_REFUSAL_LIMIT} setup-secret attempts in this \
             process. The setup password no longer opens anything; a recovery code from \
             `fathom-server recover-operator` still does. Restart the server to open the setup \
             password again."
        );
    }
    true
}

/// Log one refusal at warn level, with the client source address and the
/// count currently on record for `deployment`.
///
/// **Never the count's own writer** — [`reserve_setup_secret_attempt`] is,
/// so that the budget closes on its own critical section and this can run
/// afterward, once the actual outcome is known, without spending a second
/// unit for the one attempt that already spent one.
///
/// **Never carries the candidate** — only `source`, the client address the
/// route already computed, and the running count. A wrong guess is not
/// evidence about anything except that a guess was made; what would make it
/// evidence is exactly what must never reach a log.
fn log_setup_secret_refusal(deployment: &str, source: &str) {
    let count = setup_secret_refusals()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(deployment)
        .copied()
        .unwrap_or(0);
    tracing::warn!(source, count, "a setup secret was refused");
}

#[cfg(test)]
/// Put this deployment's counted attempts exactly where the next one would
/// leave it, so a test proves the limit closes the password at twenty
/// without twenty real attempts first.
fn set_setup_secret_refusals_for_test(deployment: &str, count: u32) {
    setup_secret_refusals()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(deployment.to_string(), count);
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

// ---------------------------------------------------------------------------
// ADR-0055 fix (a) -- appended 2026-09-21 by the operators/placement stream
//
// The one thing `operators::recover_operator` needs from this module and
// cannot honestly build for itself: the seal on a `backup_codes` row.
//
// Decision 8's break-glass now clears the second factor as well as the
// password, because the ADR says the code *"lets that person set a new
// password AND enrol a new app code"* and because ten live backup codes
// beside a cleared app code is not a cleared second factor. `0018` §C gives
// `fathom_app` no DELETE on this table -- a spent code stays as the record
// that it was spent -- so the retirement is the same guarded `UPDATE` and the
// same version-2 seal `spend_backup_code` writes.
//
// **A thin wrapper and not a second seal**: it calls `backup_code_seal`, so
// there is one definition of what a `backup_codes` row's seal covers and one
// place to change it. Put at the END of the file, in its own block, because
// this file belongs to another stream in this build.
// ---------------------------------------------------------------------------

/// [`backup_code_seal`], for `operators::recover_operator`.
///
/// `chain_seq` is the `operator_recovered_from_host` entry's seq and
/// `row_version` is 2, exactly as a spend writes them, so a code retired by a
/// recovery reads back as a spent code rather than as a forged one -- and
/// clearing `used_at` in the database leaves a row that does not verify.
pub fn backup_code_seal_for(
    row_key: &Key32,
    id: &str,
    account: &str,
    code_hash: &[u8; 32],
    chain_seq: i64,
    row_version: i32,
    used_at_unix: i64,
) -> [u8; 32] {
    backup_code_seal(
        row_key,
        id,
        account,
        code_hash,
        chain_seq,
        row_version,
        used_at_unix,
    )
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
    fn a_common_password_with_padding_on_it_is_still_a_common_password() {
        // **The fixtures are what people type**, not what the check wants:
        // every one of these was ACCEPTED over the wire on 2026-09-21, because
        // the fifteen-character floor had made the whole bundled list
        // unreachable but for one line. CLAUDE.md rule 2.
        for real in [
            "password123456789",
            "qwertyuiop1234567",
            "passwordpassword",
            "iloveyouiloveyou",
            "qwertyuiopasdfgh",
            "password12345678",
            "password1234567!",
            "trustno1trustno1",
            "123456789012345",
        ] {
            assert!(
                matches!(
                    check_password(real, "nobody@example.org"),
                    Err(CredentialError::PasswordIsCommon)
                ),
                "{real} is a common password with padding on it"
            );
        }

        // And the passphrases people are actually told to choose are not
        // caught by it. Each clears fifteen characters, so it is not the
        // length rule passing them.
        for passphrase in [
            "correct-horse-battery-staple",
            "the-quick-brown-fox-jumps",
            "rack-diagram-estate-record",
            "harbour-lantern-copper-nine",
        ] {
            assert!(
                check_password(passphrase, "nobody@example.org").is_ok(),
                "{passphrase} is on no list and must be accepted"
            );
        }
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
        //
        // **Not fifteen `a`s any more.** `aaaaaaaa` is itself on the bundled
        // list, so [`is_common_password`]'s rule 3 refuses a run of them —
        // which is right, and means this assertion needs an ordinary string
        // rather than a repetitive one to say what it is about.
        assert!(check_password("fifteenlettersx", "alice@example.org").is_ok());

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
    fn a_credential_with_no_seal_over_it_is_unverifiable_and_no_credential_is_not() {
        // `0025` §B's three outcomes, at the unit level. The database refuses
        // the middle one too (its constraint trigger), and
        // `tests/credentials.rs` drives that; this is the half that still has
        // to hold for a row written before `0025` existed, which the trigger
        // never saw.
        let key = Key32::from_bytes([9u8; 32]);
        let account = "01ACCOUNT0000000000000000A";

        let empty = CredentialRow::default();
        assert!(
            verify_credential_seal(&key, account, &empty).is_ok(),
            "an account with no credential has nothing to seal"
        );

        let mut with_password = CredentialRow {
            password_hash: Some("$argon2id$v=19$m=19456,t=2,p=1$abc$def".to_string()),
            ..CredentialRow::default()
        };
        assert!(
            matches!(
                verify_credential_seal(&key, account, &with_password),
                Err(CredentialError::Unverifiable(_))
            ),
            "a password hash with no seal over it is not a state this server writes"
        );

        // Sealed, and then the second factor switched off underneath it.
        with_password.totp_last_step = Some(59_666_877);
        with_password.credential_seal =
            Some(credential_seal(&key, account, &with_password).to_vec());
        assert!(verify_credential_seal(&key, account, &with_password).is_ok());
        let downgraded = CredentialRow {
            totp_last_step: None,
            ..with_password.clone()
        };
        assert!(
            matches!(
                verify_credential_seal(&key, account, &downgraded),
                Err(CredentialError::Unverifiable(_))
            ),
            "clearing totp_last_step is what turns a two-factor account into a \
             password-only one, so the seal must cover whether it is set"
        );
        // And the same row under another account's id.
        assert!(
            matches!(
                verify_credential_seal(&key, "01ACCOUNT0000000000000000B", &with_password),
                Err(CredentialError::Unverifiable(_))
            ),
            "the seal names the account it was written for"
        );
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

    // ---- ADR-0057 decision 1: the setup password, held in memory ---------
    //
    // `Instant` cannot be constructed at an arbitrary point (security review
    // item 6: that is the whole reason it is not `SystemTime`), so every test
    // below fixes one `base = Instant::now()` and reasons only in `Duration`s
    // added to or before it — never a sleep, and never the system clock.

    #[test]
    fn a_matching_setup_password_inside_the_window_gives_back_the_token() {
        let token = [7u8; 32];
        let base = std::time::Instant::now();
        let secret = SetupSecret::new(
            "this-is-the-setup-password",
            token,
            base + Duration::from_secs(1_000),
        );
        assert_eq!(
            secret.token_for(
                b"this-is-the-setup-password",
                base + Duration::from_secs(999)
            ),
            Some(token),
            "the last second before the window closes still matches"
        );
    }

    #[test]
    fn the_window_is_injectable_and_closes_at_an_exact_instant() {
        // Decision 1: "make the window injectable for tests" -- no sleeping
        // and no system clock, just calls at a `Duration` from `base` chosen
        // by hand.
        let token = [9u8; 32];
        let base = std::time::Instant::now();
        let secret = SetupSecret::new(
            "open-sesame-and-then-some",
            token,
            base + Duration::from_secs(1_000),
        );
        assert_eq!(
            secret.token_for(b"open-sesame-and-then-some", base),
            Some(token)
        );
        assert_eq!(
            secret.token_for(
                b"open-sesame-and-then-some",
                base + Duration::from_secs(999)
            ),
            Some(token)
        );
        assert_eq!(
            secret.token_for(
                b"open-sesame-and-then-some",
                base + Duration::from_secs(1_000)
            ),
            None,
            "closes_at itself is already closed"
        );
        assert_eq!(
            secret.token_for(
                b"open-sesame-and-then-some",
                base + Duration::from_secs(1_001)
            ),
            None
        );
    }

    #[test]
    fn a_wrong_setup_password_is_refused_inside_the_window() {
        let base = std::time::Instant::now();
        let secret = SetupSecret::new(
            "the-real-setup-password-here",
            [1u8; 32],
            base + Duration::from_secs(1_000),
        );
        assert_eq!(secret.token_for(b"a-wrong-guess-entirely-here", base), None);
        // Close, a prefix, a suffix, different case -- none of them match.
        assert_eq!(secret.token_for(b"the-real-setup-password-her", base), None);
        assert_eq!(
            secret.token_for(b"THE-REAL-SETUP-PASSWORD-HERE", base),
            None
        );
        assert_eq!(secret.token_for(b"", base), None);
    }

    // ---- security review item 4: the brute-force limit -------------------

    #[test]
    fn the_limit_closes_the_password_at_twenty_and_not_before() {
        let deployment = "unit-test-brute-force-not-yet";
        set_setup_secret_refusals_for_test(deployment, SETUP_SECRET_REFUSAL_LIMIT - 1);
        assert!(
            reserve_setup_secret_attempt(deployment),
            "the twentieth attempt is still inside the budget"
        );
        assert!(
            !reserve_setup_secret_attempt(deployment),
            "the twenty-first has nothing left to spend"
        );
    }

    #[test]
    fn counting_a_refusal_never_closes_a_different_deployment() {
        let a = "unit-test-brute-force-deployment-a";
        let b = "unit-test-brute-force-deployment-b";
        set_setup_secret_refusals_for_test(a, SETUP_SECRET_REFUSAL_LIMIT);
        assert!(!reserve_setup_secret_attempt(a));
        assert!(
            reserve_setup_secret_attempt(b),
            "one process serves several deployments in cargo test, and the limit is per \
             deployment or it is not a limit on anything real"
        );
    }

    #[test]
    fn counting_advances_the_stored_count_by_one_each_time() {
        let deployment = "unit-test-brute-force-counts-up";
        for expected in 1..=3u32 {
            assert!(reserve_setup_secret_attempt(deployment));
            let stored = setup_secret_refusals()
                .lock()
                .unwrap()
                .get(deployment)
                .copied();
            assert_eq!(stored, Some(expected));
        }
    }

    /// Security review, round 2, item A's own burst, reproduced with real OS
    /// threads rather than cooperative async scheduling: two hundred of them
    /// racing [`reserve_setup_secret_attempt`] for the same deployment at
    /// once. Exactly [`SETUP_SECRET_REFUSAL_LIMIT`] may come back `true` —
    /// not more, which is what a lost update under the race would look like,
    /// and not fewer, which would be a caller refused for budget that was
    /// never actually spent.
    #[test]
    fn two_hundred_real_threads_cannot_reserve_more_than_the_limit_between_them() {
        let deployment = "unit-test-brute-force-thread-burst";
        let successes = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..200)
                .map(|_| scope.spawn(|| reserve_setup_secret_attempt(deployment)))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("the reservation thread did not panic"))
                .filter(|&ok| ok)
                .count()
        });
        assert_eq!(successes, SETUP_SECRET_REFUSAL_LIMIT as usize);
        let stored = setup_secret_refusals()
            .lock()
            .unwrap()
            .get(deployment)
            .copied();
        assert_eq!(stored, Some(SETUP_SECRET_REFUSAL_LIMIT));
    }

    // ---- security review item 5, finished: only a recovery-code shape ----
    // ---- reaches the database ----------------------------------------

    #[test]
    fn an_op_prefixed_sixty_four_hex_parses_whatever_noise_surrounds_it() {
        // Built, not hand-counted: sixty-four hex digits is exactly the
        // shape this function looks for, and a hand-typed literal of that
        // length is exactly the kind of off-by-a-few a reviewer would have
        // to notice separately from whether the function itself is right.
        let raw: [u8; 32] = std::array::from_fn(|i| i as u8);
        let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex.len(), 64);

        // `op_`, exactly as `formatToken` writes it.
        let typed = format!("op_{hex}");
        assert_eq!(parse_recovery_code(typed.as_bytes()), Some(raw));

        // No underscore -- `TOKEN_PREFIX_RE`'s `_?` is optional client-side,
        // so it has to be optional here too.
        let typed = format!("op{hex}");
        assert_eq!(parse_recovery_code(typed.as_bytes()), Some(raw));

        // Upper case, with hyphens and spaces sprinkled through the hex --
        // the same noise `parseToken` discards, wherever it falls.
        let noisy_hex: String = hex
            .to_uppercase()
            .chars()
            .enumerate()
            .map(|(i, c)| {
                if i > 0 && i % 4 == 0 {
                    format!("{} {c}", if i % 8 == 0 { "-" } else { "" })
                } else {
                    c.to_string()
                }
            })
            .collect();
        let typed = format!("OP-{noisy_hex}");
        assert_eq!(parse_recovery_code(typed.as_bytes()), Some(raw));
    }

    #[test]
    fn text_without_the_op_shape_never_parses_as_a_recovery_code() {
        // A real setup password, `openssl rand -base64 24` shaped: 32
        // characters, and not hex.
        assert_eq!(
            parse_recovery_code(b"K9mQ2xVzL7pR4wN8jT6yB3hC1dF5sG0k"),
            None
        );
        // Starts with "op" but is not the shape at all.
        assert_eq!(parse_recovery_code(b"operations-manual-forty-two"), None);
        // The right prefix, the wrong length.
        assert_eq!(parse_recovery_code(b"op_3f9c2a7b"), None);
        // The right prefix and length, not hex.
        assert_eq!(
            parse_recovery_code(
                b"op_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
            ),
            None
        );
        assert_eq!(parse_recovery_code(b""), None);
    }
}
