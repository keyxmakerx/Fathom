//! Steward-issued invitations, "Waiting for you", and confirming people in a batch.
//!
//! `migrations/0037_steward_invitations.sql` is the schema and carries the
//! reasoning for each constraint. `design_api.rs` has the routes; this file has
//! the transactions.
//!
//! # What an invitation is
//!
//! A steward invites a person the organisation has never seen. The server makes a
//! shell account (a name the person signs in with, chosen here, never an email)
//! and a one-time link. **Redeeming the link enrols the person's first key and
//! nothing else**: no membership, no grant. The invitation is a request. A steward
//! confirms it later by signing a grant that names the person's own key (admin
//! design §6.4), and the membership is written in the same transaction as that
//! signature, so nobody who has not been confirmed is ever a member.
//!
//! # Four rules this file keeps
//!
//! 1. **The body never names an account.** The shell is created here, in the same
//!    transaction as its invitation. A steward invitation bound to an existing
//!    account would let one organisation's steward enrol a key on it, and the
//!    authorisation walk matches the account, not the key.
//! 2. **The typed email is a contact note.** It is stored on the invitation row
//!    for stewards to read. It is never compared with `accounts.email`, never used
//!    to sign in and never a reset target.
//! 3. **The subject of a grant is the invitation's own sealed account.** It is
//!    never read from a request body. The key is the one the person enrolled when
//!    they redeemed the link, and confirm refuses if the account's live keys are
//!    anything other than exactly that one.
//! 4. **Steward requests are confirmed one at a time.** A batch is read and draw
//!    only.
//!
//! # No stored batch signature
//!
//! Each grant in a batch is an ordinary row with its own signature over its own
//! bytes, so `grants::verify_grant_row` checks each on its own. The batch is
//! recorded as a `batch_id` and its size in each `invitation_closed` entry. A
//! batch assertion would be theatre while keys are software keys (anyone holding
//! the key signs 500 grants as easily as one); it belongs to the hardware-key
//! work and would change how a grant is verified, so it is deferred whole.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use deadpool_postgres::{Pool, Transaction};
use fathom_canon::Json;

use crate::authority::{self, Capability, RowFacts};
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError};
use crate::crypto::{self, Key32};
use crate::grants::{
    self, AccessLine, AccountKey, Authority, AuthorityError, EpochWatch, Grant, KeyedGrantRequest,
    StewardCheck,
};
use crate::ids;
use crate::keys::{KeyRing, KeyStoreError};
use crate::operators::{self, OperatorError};
use crate::repo::{AccountId, ScopeId};

// ---------------------------------------------------------------------------
// Limits and constants
// ---------------------------------------------------------------------------

/// How many invitations an organisation may have open at once (asked or joined,
/// and inside their window). The same number as one batch.
pub const OPEN_INVITATIONS_MAX: i64 = 500;

/// How many invitations one steward may issue in a rolling day.
pub const ISSUED_PER_STEWARD_PER_DAY: i64 = 50;

/// The most invitations one confirm may sign.
pub const CONFIRM_BATCH_MAX: usize = 500;

/// How long after joining a person may be confirmed. Checked when the list is read
/// and at confirm; nothing sweeps.
pub const JOINED_WINDOW_SECONDS: i64 = 14 * 24 * 60 * 60;

/// How long a steward grant made through an invitation lasts. `0011` refuses a
/// steward grant with no expiry, and this is the number the owner chose.
pub const STEWARD_GRANT_LIFETIME_SECONDS: i64 = 365 * 24 * 60 * 60;

/// The longest display name an invitation carries, in characters.
pub const DISPLAY_NAME_MAX: usize = 100;
/// The longest contact email an invitation carries, in characters.
pub const CONTACT_EMAIL_MAX: usize = 254;

/// The two caps, as a value so a test can lower them. Production uses
/// [`Limits::STANDARD`].
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub open_max: i64,
    pub per_steward_per_day: i64,
}

impl Limits {
    pub const STANDARD: Limits = Limits {
        open_max: OPEN_INVITATIONS_MAX,
        per_steward_per_day: ISSUED_PER_STEWARD_PER_DAY,
    };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything an invitation act refuses, and why.
#[derive(Debug)]
pub enum InviteError {
    Db(tokio_postgres::Error),
    Chain(ChainStoreError),
    Authority(AuthorityError),
    Operator(OperatorError),
    Keys(KeyStoreError),
    /// A field of the request is not the shape it must be.
    Malformed(&'static str),
    /// No such invitation in this organisation. **A guessed id from another
    /// organisation gets this, the same as an id nobody ever issued.**
    NotFound,
    /// The invitation is not in a state that allows this act.
    NotOpen(&'static str),
    /// A stored row does not verify under this deployment's key. An integrity
    /// alarm, never a permission answer.
    Unverifiable(&'static str),
    /// The organisation already has [`Limits::open_max`] invitations open.
    OpenLimit,
    /// This steward has already issued [`Limits::per_steward_per_day`] today.
    RateLimit,
    /// One item of a batch was refused, and so the whole batch was.
    Batch {
        index: usize,
        reason: BatchReason,
    },
}

/// Why one item of a batch was refused. Typed so a client can act on it: `Stale`
/// means propose the whole batch again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BatchReason {
    /// The authority head moved, or a server choice changed, since the proposal.
    Stale,
    /// The caller is not a steward at this item's scope, or a quorum is missing.
    NotAuthorised,
    /// The signature did not verify over the bytes this server derives.
    BadSignature,
    /// There is no such invitation here, or it is not waiting (not joined, or
    /// already closed).
    NotWaiting,
    /// The invitation's joined window has passed.
    WindowClosed,
    /// The account's live keys are not exactly the one it enrolled when it joined,
    /// or the request names a different one.
    KeyChanged,
    /// The account is already a member.
    MembershipExists,
    /// A stored row does not verify.
    Unverifiable,
}

impl BatchReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stale => "stale",
            Self::NotAuthorised => "not_authorised",
            Self::BadSignature => "bad_signature",
            Self::NotWaiting => "not_waiting",
            Self::WindowClosed => "window_closed",
            Self::KeyChanged => "key_changed",
            Self::MembershipExists => "membership_exists",
            Self::Unverifiable => "unverifiable",
        }
    }
}

impl core::fmt::Display for InviteError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "database error: {e}"),
            Self::Chain(e) => write!(f, "{e}"),
            Self::Authority(e) => write!(f, "{e}"),
            Self::Operator(e) => write!(f, "{e}"),
            Self::Keys(e) => write!(f, "{e}"),
            Self::Malformed(what) => write!(f, "malformed {what}"),
            Self::NotFound => f.write_str("no such invitation"),
            Self::NotOpen(why) => write!(f, "{why}"),
            Self::Unverifiable(what) => write!(f, "the {what} does not verify"),
            Self::OpenLimit => write!(
                f,
                "this organisation already has the most open invitations it can hold \
                 ({OPEN_INVITATIONS_MAX})"
            ),
            Self::RateLimit => write!(
                f,
                "you have already invited {ISSUED_PER_STEWARD_PER_DAY} people today; try again \
                 tomorrow"
            ),
            Self::Batch { index, reason } => {
                write!(f, "item {index} was refused ({})", reason.as_str())
            }
        }
    }
}

impl std::error::Error for InviteError {}

impl From<tokio_postgres::Error> for InviteError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}
impl From<ChainStoreError> for InviteError {
    fn from(e: ChainStoreError) -> Self {
        Self::Chain(e)
    }
}
impl From<AuthorityError> for InviteError {
    fn from(e: AuthorityError) -> Self {
        Self::Authority(e)
    }
}
impl From<OperatorError> for InviteError {
    fn from(e: OperatorError) -> Self {
        Self::Operator(e)
    }
}
impl From<KeyStoreError> for InviteError {
    fn from(e: KeyStoreError) -> Self {
        Self::Keys(e)
    }
}

// ---------------------------------------------------------------------------
// The row, its seal, and the custody that opens it
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Asked,
    Joined,
    Confirmed,
    Refused,
    Cancelled,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asked => "asked",
            Self::Joined => "joined",
            Self::Confirmed => "confirmed",
            Self::Refused => "refused",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "asked" => Some(Self::Asked),
            "joined" => Some(Self::Joined),
            "confirmed" => Some(Self::Confirmed),
            "refused" => Some(Self::Refused),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

/// One `organisation_invitations` row, as this module reads it back.
#[derive(Clone, Debug)]
pub struct InvitationRow {
    pub id: String,
    pub organisation_id: String,
    pub scope_id: Option<String>,
    pub account_id: String,
    pub capability_asked: Capability,
    pub display_name: String,
    pub contact_email: Option<String>,
    pub sign_in_name: String,
    pub issued_by: String,
    pub issued_seq: i64,
    pub issued_at_unix: i64,
    pub asked_expires_at_unix: i64,
    pub state: State,
    /// `0` until joined.
    pub joined_at_unix: i64,
    pub joined_seq: Option<i64>,
    pub enrolled_key_id: Option<String>,
    pub enrolled_key_fpr: Option<[u8; 32]>,
    /// `0` until closed.
    pub closed_at_unix: i64,
    pub closed_seq: Option<i64>,
    pub closed_by: Option<String>,
    pub grant_id: Option<String>,
    pub row_version: i32,
    pub row_seal: Vec<u8>,
}

const INVITATION_COLUMNS: &str = "id, organisation_id, scope_id, account_id, capability_asked, \
     display_name, contact_email, sign_in_name, issued_by, issued_seq, \
     EXTRACT(EPOCH FROM issued_at)::bigint, EXTRACT(EPOCH FROM asked_expires_at)::bigint, state, \
     COALESCE(EXTRACT(EPOCH FROM joined_at)::bigint, 0), joined_seq, enrolled_key_id, \
     enrolled_key_fpr, COALESCE(EXTRACT(EPOCH FROM closed_at)::bigint, 0), closed_seq, \
     closed_by, grant_id, row_version, row_seal";

fn invitation_from_row(row: &tokio_postgres::Row) -> Result<InvitationRow, InviteError> {
    let capability: String = row.get(4);
    let state: String = row.get(12);
    let fpr: Option<Vec<u8>> = row.get(16);
    Ok(InvitationRow {
        id: row.get(0),
        organisation_id: row.get(1),
        scope_id: row.get(2),
        account_id: row.get(3),
        capability_asked: Capability::parse(&capability)
            .ok_or(InviteError::Unverifiable("invitation capability"))?,
        display_name: row.get(5),
        contact_email: row.get(6),
        sign_in_name: row.get(7),
        issued_by: row.get(8),
        issued_seq: row.get(9),
        issued_at_unix: row.get(10),
        asked_expires_at_unix: row.get(11),
        state: State::parse(&state).ok_or(InviteError::Unverifiable("invitation state"))?,
        joined_at_unix: row.get(13),
        joined_seq: row.get(14),
        enrolled_key_id: row.get(15),
        enrolled_key_fpr: match fpr {
            Some(bytes) => Some(
                bytes
                    .try_into()
                    .map_err(|_| InviteError::Unverifiable("invitation key fingerprint"))?,
            ),
            None => None,
        },
        closed_at_unix: row.get(17),
        closed_seq: row.get(18),
        closed_by: row.get(19),
        grant_id: row.get(20),
        row_version: row.get(21),
        row_seal: row.get(22),
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is before 1970")
        .as_secs() as i64
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

fn opt_str(value: &Option<String>) -> Json {
    match value {
        Some(s) => Json::Str(s.clone()),
        None => Json::Null,
    }
}

fn obj(pairs: Vec<(&str, Json)>) -> Json {
    Json::Obj(
        pairs
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect::<BTreeMap<_, _>>(),
    )
}

/// The canonical state of a row, for its seal: every column but the seal.
fn invitation_row_state(row: &InvitationRow) -> Vec<u8> {
    let mut map = BTreeMap::new();
    let mut put = |k: &str, v: Json| {
        map.insert(k.to_string(), v);
    };
    put("account_id", Json::Str(row.account_id.clone()));
    put("asked_expires_at", Json::Int(row.asked_expires_at_unix));
    put(
        "capability_asked",
        Json::Str(row.capability_asked.as_str().to_string()),
    );
    put("closed_at", Json::Int(row.closed_at_unix));
    put("closed_by", opt_str(&row.closed_by));
    put("closed_seq", row.closed_seq.map_or(Json::Null, Json::Int));
    put("contact_email", opt_str(&row.contact_email));
    put("display_name", Json::Str(row.display_name.clone()));
    put("enrolled_key_fpr", {
        match &row.enrolled_key_fpr {
            Some(fpr) => Json::Str(hex(fpr)),
            None => Json::Null,
        }
    });
    put("enrolled_key_id", opt_str(&row.enrolled_key_id));
    put("grant_id", opt_str(&row.grant_id));
    put("id", Json::Str(row.id.clone()));
    put("issued_at", Json::Int(row.issued_at_unix));
    put("issued_by", Json::Str(row.issued_by.clone()));
    put("joined_at", Json::Int(row.joined_at_unix));
    put("joined_seq", row.joined_seq.map_or(Json::Null, Json::Int));
    put("organisation_id", Json::Str(row.organisation_id.clone()));
    put("scope_id", opt_str(&row.scope_id));
    put("sign_in_name", Json::Str(row.sign_in_name.clone()));
    put("state", Json::Str(row.state.as_str().to_string()));
    Json::Obj(map).to_canonical_bytes()
}

/// The seal the row should carry at its current version. Like `token_seal` it
/// keeps `issued_seq` and raises `row_version` on every change; the key is the
/// organisation's row key, which is why a redemption (no tenant) can still seal.
pub fn invitation_seal(ring: &KeyRing, row: &InvitationRow) -> [u8; 32] {
    authority::row_seal(
        &grants::row_key_for(ring, &row.organisation_id),
        &RowFacts {
            table: "organisation_invitations",
            row_id: &row.id,
            chain_seq: row.issued_seq,
            row_version: row.row_version,
            row_state: &invitation_row_state(row),
        },
    )
}

/// Whether the row's stored seal is the one its own contents give.
pub fn row_verifies(ring: &KeyRing, row: &InvitationRow) -> bool {
    row.row_seal == invitation_seal(ring, row)
}

/// Whether a joined invitation can still be confirmed at `now`.
fn joined_window_open(row: &InvitationRow, now: i64) -> bool {
    row.joined_at_unix + JOINED_WINDOW_SECONDS > now
}

/// The end of the window the person has been given, at `now`: the link's expiry
/// while the link is unused, the joined window afterwards.
fn window_ends_at(row: &InvitationRow) -> i64 {
    match row.state {
        State::Asked => row.asked_expires_at_unix,
        _ => row.joined_at_unix + JOINED_WINDOW_SECONDS,
    }
}

/// Open the one custody setting this module's tables need, for this transaction.
/// **Never `app.operator_custody` or `app.enrolment_custody`**, which open the
/// operator tables.
async fn enter_custody(tx: &Transaction<'_>) -> Result<(), InviteError> {
    tx.execute(
        "SELECT set_config('app.invitation_custody', 'yes', true)",
        &[],
    )
    .await?;
    Ok(())
}

async fn leave_custody(tx: &Transaction<'_>) -> Result<(), InviteError> {
    tx.execute(
        "SELECT set_config('app.invitation_custody', 'no', true)",
        &[],
    )
    .await?;
    Ok(())
}

pub async fn read_invitation(
    tx: &Transaction<'_>,
    id: &str,
    lock: bool,
) -> Result<Option<InvitationRow>, InviteError> {
    let sql = format!(
        "SELECT {INVITATION_COLUMNS} FROM organisation_invitations WHERE id = $1{}",
        if lock { " FOR UPDATE" } else { "" }
    );
    match tx.query_opt(&sql, &[&id]).await? {
        Some(row) => Ok(Some(invitation_from_row(&row)?)),
        None => Ok(None),
    }
}

/// Write `row`'s new state: bumps the version, re-seals, and updates only the
/// columns the privilege layer lets this role touch. The `WHERE` carries the
/// version read, so an intervening touch is a refusal and not a lost update.
async fn write_row(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    mut row: InvitationRow,
    read_version: i32,
) -> Result<InvitationRow, InviteError> {
    row.row_version = read_version + 1;
    row.row_seal = invitation_seal(ring, &row).to_vec();
    let fpr = row.enrolled_key_fpr.map(|f| f.to_vec());
    let updated = tx
        .execute(
            "UPDATE organisation_invitations \
                SET state = $2, \
                    joined_at = CASE WHEN $3::bigint = 0 THEN NULL ELSE to_timestamp($3::bigint) END, \
                    joined_seq = $4, enrolled_key_id = $5, enrolled_key_fpr = $6, \
                    closed_at = CASE WHEN $7::bigint = 0 THEN NULL ELSE to_timestamp($7::bigint) END, \
                    closed_seq = $8, closed_by = $9, grant_id = $10, \
                    row_version = $11, row_seal = $12 \
              WHERE id = $1 AND row_version = $13",
            &[
                &row.id,
                &row.state.as_str(),
                &row.joined_at_unix,
                &row.joined_seq,
                &row.enrolled_key_id,
                &fpr,
                &row.closed_at_unix,
                &row.closed_seq,
                &row.closed_by,
                &row.grant_id,
                &row.row_version,
                &row.row_seal,
                &read_version,
            ],
        )
        .await?;
    if updated != 1 {
        return Err(InviteError::NotOpen(
            "the invitation changed under this act",
        ));
    }
    Ok(row)
}

// ---------------------------------------------------------------------------
// Names and codes
// ---------------------------------------------------------------------------

const CROCKFORD_LOWER: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
const CROCKFORD_UPPER: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The name a person signs in with: a slug of the name the steward typed, a
/// hyphen, and 8 Crockford characters (40 bits) from the CSPRNG. **No "@"**: this
/// is never an email, so it cannot be mistaken for one and cannot collide with
/// one.
pub(crate) fn make_sign_in_name(display_name: &str) -> Result<String, InviteError> {
    let mut slug = String::new();
    for c in display_name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= 20 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    let slug = if slug.is_empty() { "guest" } else { slug };
    let random = Key32::random().map_err(|_| InviteError::Unverifiable("random source"))?;
    let bytes = random.expose();
    let mut value: u64 = 0;
    for b in &bytes[..5] {
        value = (value << 8) | u64::from(*b);
    }
    let suffix: String = (0..8)
        .map(|i| CROCKFORD_LOWER[((value >> (35 - 5 * i)) & 31) as usize] as char)
        .collect();
    Ok(format!("{slug}-{suffix}"))
}

/// The key-check code a steward compares with the joiner's screen: the first 50
/// bits of the key fingerprint as 10 Crockford characters, upper case. The
/// joiner's browser computes the same from the public key it holds, with
/// `authority::key_fingerprint`. 50 bits is an identity check between two people
/// looking at two screens, not a defence against a preimage search: the real
/// person has no code to forge.
pub fn key_code(fpr: &[u8; 32]) -> String {
    let value = u64::from_be_bytes(fpr[..8].try_into().expect("eight bytes")) >> 14;
    (0..10)
        .map(|i| CROCKFORD_UPPER[((value >> (45 - 5 * i)) & 31) as usize] as char)
        .collect()
}

fn clean_text(
    text: &str,
    max: usize,
    what: &'static str,
    required: bool,
) -> Result<Option<String>, InviteError> {
    let text = text.trim();
    if text.is_empty() {
        return if required {
            Err(InviteError::Malformed(what))
        } else {
            Ok(None)
        };
    }
    if text.chars().count() > max || text.chars().any(char::is_control) {
        return Err(InviteError::Malformed(what));
    }
    Ok(Some(text.to_string()))
}

fn parse_scope_text(text: &str) -> Result<Option<ScopeId>, InviteError> {
    if text.is_empty() {
        return Ok(None);
    }
    text.parse()
        .map(Some)
        .map_err(|_| InviteError::Malformed("scope id"))
}

fn lp_field<'a>(rest: &mut &'a [u8]) -> Result<&'a str, InviteError> {
    let (field, tail) = crypto::read_lp(rest).ok_or(InviteError::Malformed("request body"))?;
    *rest = tail;
    core::str::from_utf8(field).map_err(|_| InviteError::Malformed("request body"))
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/// What a steward typed to invite someone.
pub struct IssueRequest {
    pub display_name: String,
    pub contact_email: Option<String>,
    pub capability: Capability,
    pub scope: Option<ScopeId>,
}

/// Parse `LP(display_name) ‖ LP(contact_email or "") ‖ LP(capability) ‖
/// LP(scope_id or "")`. **There is no account field**, on purpose: the shell is
/// created in the transaction that issues the invitation.
pub fn parse_issue_body(body: &[u8]) -> Result<IssueRequest, InviteError> {
    let mut rest = body;
    let display_name = lp_field(&mut rest)?.to_string();
    let contact_email = lp_field(&mut rest)?.to_string();
    let capability =
        Capability::parse(lp_field(&mut rest)?).ok_or(InviteError::Malformed("capability"))?;
    let scope = parse_scope_text(lp_field(&mut rest)?)?;
    if !rest.is_empty() {
        return Err(InviteError::Malformed("request body"));
    }
    Ok(IssueRequest {
        display_name: clean_text(&display_name, DISPLAY_NAME_MAX, "display name", true)?
            .unwrap_or_default(),
        contact_email: clean_text(&contact_email, CONTACT_EMAIL_MAX, "contact email", false)?,
        capability,
        scope,
    })
}

/// What an issue returns to the steward, once.
pub struct Issued {
    pub invitation: String,
    pub account: String,
    pub sign_in_name: String,
    /// `inv_` and 64 lower-case hex characters. Returned once and never stored.
    pub token: String,
    pub expires_at_unix: i64,
}

impl core::fmt::Debug for Issued {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Issued")
            .field("invitation", &self.invitation)
            .field("account", &self.account)
            .field("sign_in_name", &self.sign_in_name)
            .field("token", &"<not printed>")
            .finish()
    }
}

/// Issue one invitation, in the caller's transaction (which already holds the
/// verified session and the tenant context).
///
/// In order: the caller's Steward at the invitation's scope or above (a folder
/// steward cannot invite at the root or at a sibling; a non-steward and a folder
/// steward asking at the root get the identical refusal), the shell account and
/// its sealed `account_created` entry, the two caps (counted after the site chain
/// is locked, so two concurrent issues cannot both pass), the sealed
/// `invitation_issued` entry, the invitation row, and the token with its sealed
/// `enrolment_token_issued` entry. All of it commits together or not at all.
pub async fn issue(
    tx: &Transaction<'_>,
    pool: &Pool,
    ring: &Arc<KeyRing>,
    auth: &Authority<'_>,
    request: &IssueRequest,
    limits: &Limits,
) -> Result<Issued, InviteError> {
    let actor = auth.ctx.actor().to_string();
    let organisation = auth.ctx.tenant().to_string();
    grants::authorise_account(tx, auth, request.scope, Capability::Steward).await?;
    enter_custody(tx).await?;

    let deployment = chains::deployment_id(&**tx).await?;
    let account = AccountId::new().to_string();
    let invitation_id = ids::new_ulid().to_string();

    // The shell. The site entry first, as the operator path does: no entry, no act.
    let sign_in_name = make_sign_in_name(&request.display_name)?;
    chains::append_site(
        tx,
        ring,
        &deployment,
        EntryType::AccountCreated,
        &entry_metadata(
            EntryType::AccountCreated,
            &[
                ("account", Json::Str(account.clone())),
                ("steward", Json::Str(actor.clone())),
                ("invitation", Json::Str(invitation_id.clone())),
                ("display_name", Json::Str(request.display_name.clone())),
            ],
        ),
    )
    .await?;

    // Both caps are counted now that the site chain is locked, so two issues
    // cannot each see room for one more.
    let open: i64 = tx
        .query_one(
            "SELECT count(*) FROM organisation_invitations \
              WHERE organisation_id = $1 \
                AND ((state = 'asked' AND asked_expires_at > now()) \
                  OR (state = 'joined' AND joined_at + make_interval(secs => $2) > now()))",
            &[&organisation, &(JOINED_WINDOW_SECONDS as f64)],
        )
        .await?
        .get(0);
    if open >= limits.open_max {
        return Err(InviteError::OpenLimit);
    }
    let today: i64 = tx
        .query_one(
            "SELECT count(*) FROM organisation_invitations \
              WHERE issued_by = $1 AND issued_at > now() - interval '24 hours'",
            &[&actor],
        )
        .await?
        .get(0);
    if today >= limits.per_steward_per_day {
        return Err(InviteError::RateLimit);
    }

    tx.execute(
        "INSERT INTO principals (id, kind) VALUES ($1, 'steward')",
        &[&account],
    )
    .await?;
    // The name is chosen here, so a clash is only ever a coincidence of 40 bits.
    // Retried once under a savepoint, because a failed statement aborts the
    // transaction.
    let mut sign_in_name = sign_in_name;
    for attempt in 0..2 {
        tx.batch_execute("SAVEPOINT invitation_sign_in_name")
            .await?;
        match tx
            .execute(
                "INSERT INTO accounts (id, email, display_name) VALUES ($1, $2, $3)",
                &[&account, &sign_in_name, &request.display_name],
            )
            .await
        {
            Ok(_) => {
                tx.batch_execute("RELEASE SAVEPOINT invitation_sign_in_name")
                    .await?;
                break;
            }
            Err(e)
                if attempt == 0
                    && e.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION) =>
            {
                tx.batch_execute("ROLLBACK TO SAVEPOINT invitation_sign_in_name")
                    .await?;
                sign_in_name = make_sign_in_name(&request.display_name)?;
            }
            Err(e) => return Err(e.into()),
        }
    }

    let issued = chains::append_org(
        tx,
        ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::InvitationIssued,
        &entry_metadata(
            EntryType::InvitationIssued,
            &[
                ("invitation", Json::Str(invitation_id.clone())),
                ("account", Json::Str(account.clone())),
                ("issued_by", Json::Str(actor.clone())),
                (
                    "capability_asked",
                    Json::Str(request.capability.as_str().to_string()),
                ),
                (
                    "scope",
                    request
                        .scope
                        .map_or(Json::Null, |s| Json::Str(s.to_string())),
                ),
            ],
        ),
    )
    .await?;

    let now = now_unix();
    let expires_at = now + operators::ENROLMENT_TOKEN_LIFETIME.as_secs() as i64;
    let mut row = InvitationRow {
        id: invitation_id.clone(),
        organisation_id: organisation.clone(),
        scope_id: request.scope.map(|s| s.to_string()),
        account_id: account.clone(),
        capability_asked: request.capability,
        display_name: request.display_name.clone(),
        contact_email: request.contact_email.clone(),
        sign_in_name: sign_in_name.clone(),
        issued_by: actor.clone(),
        issued_seq: issued.seq,
        issued_at_unix: now,
        asked_expires_at_unix: expires_at,
        state: State::Asked,
        joined_at_unix: 0,
        joined_seq: None,
        enrolled_key_id: None,
        enrolled_key_fpr: None,
        closed_at_unix: 0,
        closed_seq: None,
        closed_by: None,
        grant_id: None,
        row_version: 1,
        row_seal: Vec::new(),
    };
    row.row_seal = invitation_seal(ring, &row).to_vec();
    tx.execute(
        "INSERT INTO organisation_invitations \
             (id, organisation_id, scope_id, account_id, capability_asked, display_name, \
              contact_email, sign_in_name, issued_by, issued_seq, issued_at, asked_expires_at, \
              state, row_version, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11::bigint), \
                 to_timestamp($12::bigint), 'asked', 1, $13)",
        &[
            &row.id,
            &row.organisation_id,
            &row.scope_id,
            &row.account_id,
            &row.capability_asked.as_str(),
            &row.display_name,
            &row.contact_email,
            &row.sign_in_name,
            &row.issued_by,
            &row.issued_seq,
            &row.issued_at_unix,
            &row.asked_expires_at_unix,
            &row.row_seal,
        ],
    )
    .await?;

    let token = operators::issue_invitation_token(
        pool,
        ring,
        tx,
        &actor,
        &invitation_id,
        &account,
        expires_at,
    )
    .await?;
    leave_custody(tx).await?;

    Ok(Issued {
        invitation: invitation_id,
        account,
        sign_in_name,
        token: format!("inv_{}", hex(&token.token)),
        expires_at_unix: expires_at,
    })
}

// ---------------------------------------------------------------------------
// Redemption: the link is used and a key is enrolled (operators.rs calls these)
// ---------------------------------------------------------------------------

/// What [`check_open_for_join`] found.
pub(crate) enum JoinCheck {
    /// Locked and verified; hand it back to [`mark_joined`].
    Open(Box<InvitationRow>),
    /// Refused, with the reason the sealed record carries. Never shown to the
    /// caller, who gets one message for every cause.
    Refused(&'static str),
}

/// Whether the invitation behind a token can take its first key. The caller holds
/// `app.enrolment_custody` and has set `app.account_id` to the account the TOKEN
/// names, so the keyring is readable through the account branch.
///
/// Refuses if the account already has any key (an invitation token enrols a first
/// key only), then locks the invitation row, verifies its seal, and requires it to
/// be `asked` and unexpired.
pub(crate) async fn check_open_for_join(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    invitation_id: &str,
    account: &str,
) -> Result<JoinCheck, OperatorError> {
    let has_key = tx
        .query_opt(
            "SELECT 1 FROM account_keys WHERE account_id = $1 LIMIT 1",
            &[&account],
        )
        .await?;
    if has_key.is_some() {
        return Ok(JoinCheck::Refused("account_has_key"));
    }
    let row = read_invitation(tx, invitation_id, true)
        .await
        .map_err(into_operator)?;
    let Some(row) = row else {
        return Ok(JoinCheck::Refused("invitation_missing"));
    };
    if row.account_id != account {
        return Ok(JoinCheck::Refused("invitation_account"));
    }
    if !row_verifies(ring, &row) {
        return Err(OperatorError::Unverifiable("invitation row seal"));
    }
    if row.state != State::Asked || row.asked_expires_at_unix <= now_unix() {
        return Ok(JoinCheck::Refused("invitation_not_open"));
    }
    Ok(JoinCheck::Open(Box::new(row)))
}

fn into_operator(e: InviteError) -> OperatorError {
    match e {
        InviteError::Db(e) => OperatorError::Db(e),
        InviteError::Chain(e) => OperatorError::Chain(e),
        InviteError::Authority(e) => OperatorError::Authority(e),
        InviteError::Operator(e) => e,
        InviteError::Unverifiable(what) => OperatorError::Unverifiable(what),
        _ => OperatorError::Corrupt("invitation row"),
    }
}

/// The person has redeemed the link: record the key they enrolled, and the site
/// entry that says so, on the row, and re-seal it. In the redemption's own
/// transaction.
pub(crate) async fn mark_joined(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    open: Box<InvitationRow>,
    key: &AccountKey,
    joined_seq: i64,
) -> Result<(), OperatorError> {
    let read_version = open.row_version;
    let mut row = *open;
    row.state = State::Joined;
    row.joined_at_unix = now_unix();
    row.joined_seq = Some(joined_seq);
    row.enrolled_key_id = Some(key.id.clone());
    row.enrolled_key_fpr = Some(key.fpr);
    write_row(tx, ring, row, read_version)
        .await
        .map_err(into_operator)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Cancel and refuse
// ---------------------------------------------------------------------------

/// How a steward closes an invitation without confirming it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseHow {
    /// Withdraw it: before the person has joined, or after.
    Cancel,
    /// Turn a joined person down.
    Refuse,
}

/// Cancel or refuse one invitation. The caller must be a steward at the
/// invitation's scope or above; a missing invitation, another organisation's and
/// a closed one all read as [`InviteError::NotFound`] to a steward and as the
/// plain not-authorised answer to anyone else.
///
/// Neither creates a membership, and a later confirm is refused: the state has
/// left `joined`.
pub async fn close(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    auth: &Authority<'_>,
    invitation_id: &str,
    how: CloseHow,
) -> Result<InvitationRow, InviteError> {
    let found = read_invitation(tx, invitation_id, false).await?;
    // Authorise before saying anything about the row, at its scope when it
    // exists and at the organisation when not, so both refusals are identical.
    let scope = match &found {
        Some(row) => row
            .scope_id
            .as_deref()
            .map(|s| s.parse::<ScopeId>())
            .transpose()
            .map_err(|_| InviteError::Unverifiable("invitation scope"))?,
        None => None,
    };
    grants::authorise_account(tx, auth, scope, Capability::Steward).await?;
    let Some(_) = found else {
        return Err(InviteError::NotFound);
    };
    enter_custody(tx).await?;
    // Re-read under the lock: the state that counts is the one held here.
    let row = read_invitation(tx, invitation_id, true)
        .await?
        .ok_or(InviteError::NotFound)?;
    if row.organisation_id != auth.ctx.tenant().to_string() {
        return Err(InviteError::NotFound);
    }
    if !row_verifies(ring, &row) {
        return Err(InviteError::Unverifiable("invitation row seal"));
    }
    let allowed = match how {
        CloseHow::Cancel => matches!(row.state, State::Asked | State::Joined),
        CloseHow::Refuse => row.state == State::Joined,
    };
    if !allowed {
        return Err(InviteError::NotOpen(match how {
            CloseHow::Cancel => "that invitation is already closed",
            CloseHow::Refuse => "only a person who has joined can be refused",
        }));
    }

    let new_state = match how {
        CloseHow::Cancel => State::Cancelled,
        CloseHow::Refuse => State::Refused,
    };
    let closed = close_with(tx, ring, auth, row, new_state, None, None).await?;
    leave_custody(tx).await?;
    Ok(closed)
}

/// Append `invitation_closed` and write the closed row. `batch` is the batch id
/// and size for a confirm in a batch.
async fn close_with(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    auth: &Authority<'_>,
    row: InvitationRow,
    state: State,
    grant: Option<&str>,
    batch: Option<(&str, usize)>,
) -> Result<InvitationRow, InviteError> {
    let actor = auth.ctx.actor().to_string();
    let mut fields = vec![
        ("invitation", Json::Str(row.id.clone())),
        ("reason", Json::Str(state.as_str().to_string())),
        ("actor", Json::Str(actor.clone())),
    ];
    if let Some(grant) = grant {
        fields.push(("grant", Json::Str(grant.to_string())));
    }
    if let Some((batch_id, n)) = batch {
        fields.push(("batch_id", Json::Str(batch_id.to_string())));
        fields.push(("n", Json::Int(n as i64)));
    }
    let appended = chains::append_org(
        tx,
        ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::InvitationClosed,
        &entry_metadata(EntryType::InvitationClosed, &fields),
    )
    .await?;

    let read_version = row.row_version;
    let mut next = row;
    next.state = state;
    next.closed_at_unix = now_unix();
    next.closed_seq = Some(appended.seq);
    next.closed_by = Some(actor);
    next.grant_id = grant.map(str::to_string);
    write_row(tx, ring, next, read_version).await
}

// ---------------------------------------------------------------------------
// The lists: Waiting for you, and People
// ---------------------------------------------------------------------------

/// Everything the Waiting screen needs: the open invitations in the scopes the
/// caller stewards, and the steward grants waiting for the caller's second
/// signature.
pub async fn waiting(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    auth: &Authority<'_>,
) -> Result<Json, InviteError> {
    let verified = grants::verify_authority_state(tx, auth).await?;
    let mut check = StewardCheck::new();
    require_a_steward(tx, auth, &verified, &mut check).await?;

    let scopes = grants::organisation_scopes(tx, &verified.organisation).await?;
    let organisation_name = organisation_name(tx, &verified.organisation).await?;
    let labels = LabelIndex::new(&scopes, organisation_name);

    let (views, waiting_count) = open_invitations(tx, ring, auth, &verified, &mut check).await?;
    let mut out = Vec::new();
    for view in &views {
        out.push(view.to_json(&labels, now_unix()));
    }

    // Steward grants waiting for the caller's second.
    let awaiting = grants::grants_awaiting_my_second(tx, auth, &verified, &mut check).await?;
    let mut names = NameIndex::default();
    let mut second = Vec::new();
    for g in awaiting {
        let subject_name = names.name_of(tx, &g.subject_id).await?;
        let granter_name = match &g.granted_by {
            Some(id) => Some(names.name_of(tx, id).await?),
            None => None,
        };
        second.push(obj(vec![
            ("grant", Json::Str(g.id.clone())),
            ("scope_id", opt_str(&g.scope_id)),
            (
                "scope_label",
                Json::Str(labels.label_of(g.scope_id.as_deref())),
            ),
            ("subject", Json::Str(g.subject_id.clone())),
            ("subject_name", Json::Str(subject_name)),
            ("key_code", Json::Str(key_code(&g.subject_key_fpr))),
            ("granter", opt_str(&g.granted_by)),
            ("granter_name", granter_name.map_or(Json::Null, Json::Str)),
            ("effective_from_unix", Json::Int(g.effective_from_unix)),
            ("expires_at_unix", Json::Int(g.expires_at_unix)),
        ]));
    }

    Ok(obj(vec![
        ("invitations", Json::Arr(out)),
        ("waiting_count", Json::Int(waiting_count)),
        ("seconding", Json::Arr(second)),
    ]))
}

/// Everyone in the organisation, what they can do in the scopes the caller
/// stewards, and the people who have been invited and not yet confirmed.
pub async fn people(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    auth: &Authority<'_>,
) -> Result<Json, InviteError> {
    let verified = grants::verify_authority_state(tx, auth).await?;
    let mut check = StewardCheck::new();
    require_a_steward(tx, auth, &verified, &mut check).await?;

    let organisation = verified.organisation.clone();
    let scopes = grants::organisation_scopes(tx, &organisation).await?;
    let labels = LabelIndex::new(&scopes, organisation_name(tx, &organisation).await?);
    let caller = auth.ctx.actor().to_string();

    let members = tx
        .query(
            "SELECT a.id, a.email, a.display_name FROM memberships m \
               JOIN accounts a ON a.id = m.account_id \
              WHERE m.organisation_id = $1 ORDER BY a.display_name, a.id",
            &[&organisation],
        )
        .await?;
    let ids: BTreeSet<String> = members.iter().map(|r| r.get(0)).collect();
    let lines = grants::access_lines(tx, auth, &verified, &ids, &mut check).await?;

    let mut out = Vec::new();
    for m in &members {
        let id: String = m.get(0);
        let access: Vec<Json> = lines
            .get(&id)
            .map(|v| v.iter().map(|l| access_json(l, &labels)).collect())
            .unwrap_or_default();
        out.push(obj(vec![
            ("account", Json::Str(id.clone())),
            ("name", Json::Str(m.get(2))),
            ("email", Json::Str(m.get(1))),
            ("you", Json::Bool(id == caller)),
            ("state", Json::Str("active".to_string())),
            ("invitation", Json::Null),
            ("asked", Json::Null),
            ("expired", Json::Bool(false)),
            ("access", Json::Arr(access)),
        ]));
    }

    let (views, waiting_count) = open_invitations(tx, ring, auth, &verified, &mut check).await?;
    let now = now_unix();
    for v in &views {
        let r = &v.row;
        out.push(obj(vec![
            ("account", Json::Str(r.account_id.clone())),
            ("name", Json::Str(r.display_name.clone())),
            ("email", opt_str(&r.contact_email)),
            ("you", Json::Bool(false)),
            (
                "state",
                Json::Str(
                    match r.state {
                        State::Asked => "invited",
                        _ => "waiting",
                    }
                    .to_string(),
                ),
            ),
            ("invitation", Json::Str(r.id.clone())),
            (
                "asked",
                obj(vec![
                    (
                        "capability",
                        Json::Str(r.capability_asked.as_str().to_string()),
                    ),
                    ("scope_id", opt_str(&r.scope_id)),
                    (
                        "scope_label",
                        Json::Str(labels.label_of(r.scope_id.as_deref())),
                    ),
                ]),
            ),
            ("expired", Json::Bool(window_ends_at(r) <= now)),
            ("access", Json::Arr(Vec::new())),
        ]));
    }

    Ok(obj(vec![
        ("people", Json::Arr(out)),
        ("waiting_count", Json::Int(waiting_count)),
    ]))
}

fn access_json(line: &AccessLine, labels: &LabelIndex) -> Json {
    obj(vec![
        ("scope_id", opt_str(&line.scope)),
        ("label", Json::Str(labels.label_of(line.scope.as_deref()))),
        (
            "capability",
            Json::Str(line.capability.as_str().to_string()),
        ),
        ("grant", Json::Str(line.grant.clone())),
        ("inherited", Json::Bool(line.inherited)),
        (
            "steward",
            Json::Bool(line.capability == Capability::Steward),
        ),
        ("genesis", Json::Bool(line.genesis)),
        ("revocable", Json::Bool(line.revocable)),
        ("effective_from_unix", Json::Int(line.effective_from_unix)),
        (
            "expires_at_unix",
            if line.expires_at_unix == 0 {
                Json::Null
            } else {
                Json::Int(line.expires_at_unix)
            },
        ),
        (
            "revoke_takes_effect_in_seconds",
            Json::Int(line.revoke_delay_seconds),
        ),
        (
            "revoking_at_unix",
            line.revoking_at_unix.map_or(Json::Null, Json::Int),
        ),
        ("awaiting_second", Json::Bool(line.awaiting_second)),
        ("suspended", Json::Bool(line.suspended)),
    ])
}

/// Refuse a caller who stewards nothing, with the plain not-authorised answer,
/// before any row is read: row security cannot tell a steward from a member.
async fn require_a_steward(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    verified: &grants::VerifiedAuthorityState,
    check: &mut StewardCheck,
) -> Result<(), InviteError> {
    if grants::steward_anchors(tx, auth, verified, check)
        .await?
        .is_empty()
    {
        return Err(InviteError::Authority(AuthorityError::NotAuthorised));
    }
    Ok(())
}

struct LabelIndex {
    organisation: String,
    scopes: HashMap<String, String>,
}

impl LabelIndex {
    fn new(scopes: &[grants::ScopeInfo], organisation: String) -> Self {
        Self {
            organisation,
            scopes: scopes
                .iter()
                .map(|s| (s.id.clone(), s.label.clone()))
                .collect(),
        }
    }

    fn label_of(&self, scope: Option<&str>) -> String {
        match scope {
            None => self.organisation.clone(),
            Some(id) => self.scopes.get(id).cloned().unwrap_or_default(),
        }
    }
}

async fn organisation_name(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<String, InviteError> {
    Ok(tx
        .query_opt(
            "SELECT display_name FROM organisations WHERE id = $1",
            &[&organisation],
        )
        .await?
        .map(|r| r.get(0))
        .unwrap_or_default())
}

/// Display names of accounts, read once each.
#[derive(Default)]
struct NameIndex {
    seen: HashMap<String, String>,
}

impl NameIndex {
    async fn name_of(
        &mut self,
        tx: &Transaction<'_>,
        account: &str,
    ) -> Result<String, InviteError> {
        if let Some(name) = self.seen.get(account) {
            return Ok(name.clone());
        }
        let name: String = tx
            .query_opt(
                "SELECT display_name FROM accounts WHERE id = $1",
                &[&account],
            )
            .await?
            .map(|r| r.get(0))
            .unwrap_or_default();
        self.seen.insert(account.to_string(), name.clone());
        Ok(name)
    }
}

/// One open invitation as the Waiting screen shows it.
struct InvitationView {
    row: InvitationRow,
    verified: bool,
    issuer_name: String,
}

impl InvitationView {
    fn to_json(&self, labels: &LabelIndex, now: i64) -> Json {
        let r = &self.row;
        let expired = window_ends_at(r) <= now;
        let waiting = r.state == State::Joined && !expired && self.verified;
        obj(vec![
            ("id", Json::Str(r.id.clone())),
            ("account", Json::Str(r.account_id.clone())),
            ("state", Json::Str(r.state.as_str().to_string())),
            ("display_name", Json::Str(r.display_name.clone())),
            ("contact_email", opt_str(&r.contact_email)),
            ("sign_in_name", Json::Str(r.sign_in_name.clone())),
            (
                "capability_asked",
                Json::Str(r.capability_asked.as_str().to_string()),
            ),
            ("scope_id", opt_str(&r.scope_id)),
            (
                "scope_label",
                Json::Str(labels.label_of(r.scope_id.as_deref())),
            ),
            (
                "key_code",
                match &r.enrolled_key_fpr {
                    Some(fpr) => Json::Str(key_code(fpr)),
                    None => Json::Null,
                },
            ),
            ("issued_by", Json::Str(r.issued_by.clone())),
            ("issued_by_name", Json::Str(self.issuer_name.clone())),
            ("issued_at_unix", Json::Int(r.issued_at_unix)),
            (
                "joined_at_unix",
                if r.joined_at_unix == 0 {
                    Json::Null
                } else {
                    Json::Int(r.joined_at_unix)
                },
            ),
            ("window_ends_at_unix", Json::Int(window_ends_at(r))),
            ("expired", Json::Bool(expired)),
            ("unverifiable", Json::Bool(!self.verified)),
            ("can_confirm", Json::Bool(waiting)),
        ])
    }
}

/// The open (asked or joined) invitations in scopes the caller stewards, each
/// seal checked, and how many of them can be confirmed right now.
async fn open_invitations(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    auth: &Authority<'_>,
    verified: &grants::VerifiedAuthorityState,
    check: &mut StewardCheck,
) -> Result<(Vec<InvitationView>, i64), InviteError> {
    let rows = tx
        .query(
            &format!(
                "SELECT {INVITATION_COLUMNS} FROM organisation_invitations \
                  WHERE organisation_id = $1 AND state IN ('asked', 'joined') \
                  ORDER BY issued_at, id"
            ),
            &[&auth.ctx.tenant().to_string()],
        )
        .await?;
    let now = now_unix();
    let mut names = NameIndex::default();
    let mut out = Vec::new();
    let mut waiting = 0;
    for r in &rows {
        let row = invitation_from_row(r)?;
        if !check
            .holds(tx, auth, verified, row.scope_id.as_deref())
            .await?
        {
            continue;
        }
        let ok = row_verifies(ring, &row);
        if ok && row.state == State::Joined && joined_window_open(&row, now) {
            waiting += 1;
        }
        let issuer_name = names.name_of(tx, &row.issued_by).await?;
        out.push(InvitationView {
            row,
            verified: ok,
            issuer_name,
        });
    }
    Ok((out, waiting))
}

// ---------------------------------------------------------------------------
// Confirm: the wire format
// ---------------------------------------------------------------------------

/// One line of a confirm proposal, as the client asks for it. Capability and
/// scope are the values after any Change.
pub struct ProposeItem {
    pub invitation: String,
    pub capability: Capability,
    pub scope: Option<ScopeId>,
    /// A steward grant's own expiry, when the client names one; `None` takes
    /// [`STEWARD_GRANT_LIFETIME_SECONDS`] from now.
    pub expires_at_unix: Option<i64>,
}

fn read_count(rest: &mut &[u8]) -> Result<usize, InviteError> {
    let n: usize = lp_field(rest)?
        .parse()
        .map_err(|_| InviteError::Malformed("count"))?;
    if n == 0 || n > CONFIRM_BATCH_MAX {
        return Err(InviteError::Malformed("count"));
    }
    Ok(n)
}

fn check_invitation_id(id: &str, previous: Option<&str>) -> Result<(), InviteError> {
    if id.len() != 26 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(InviteError::Malformed("invitation id"));
    }
    // Strictly ascending: one canonical order, and no duplicate.
    if previous.is_some_and(|p| p >= id) {
        return Err(InviteError::Malformed("invitation order"));
    }
    Ok(())
}

/// Parse `LP(n) ‖ n×[LP(invitation_id) ‖ LP(capability) ‖ LP(scope_id or "")]`,
/// then, for `n = 1` asking `steward` only, `LP(expires_at or "")`.
///
/// n is 1..=500 and the ids are strictly ascending. `steward` is allowed only
/// alone; nothing follows the last field. **Every shape check is here, before any
/// work.**
pub fn parse_propose_body(body: &[u8]) -> Result<Vec<ProposeItem>, InviteError> {
    let mut rest = body;
    let n = read_count(&mut rest)?;
    let mut items: Vec<ProposeItem> = Vec::with_capacity(n);
    for _ in 0..n {
        let invitation = lp_field(&mut rest)?.to_string();
        check_invitation_id(&invitation, items.last().map(|i| i.invitation.as_str()))?;
        let capability =
            Capability::parse(lp_field(&mut rest)?).ok_or(InviteError::Malformed("capability"))?;
        let scope = parse_scope_text(lp_field(&mut rest)?)?;
        if capability == Capability::Steward && n > 1 {
            return Err(InviteError::Malformed(
                "a steward request is confirmed alone",
            ));
        }
        items.push(ProposeItem {
            invitation,
            capability,
            scope,
            expires_at_unix: None,
        });
    }
    if items.len() == 1 && items[0].capability == Capability::Steward {
        let text = lp_field(&mut rest)?;
        if !text.is_empty() {
            items[0].expires_at_unix = Some(
                text.parse()
                    .map_err(|_| InviteError::Malformed("expires at"))?,
            );
        }
    }
    if !rest.is_empty() {
        return Err(InviteError::Malformed("request body"));
    }
    Ok(items)
}

/// One signed line of a confirm, as the client sends it back.
pub struct ConfirmItem {
    pub invitation: String,
    pub capability: Capability,
    pub scope: Option<ScopeId>,
    pub effective_from_unix: i64,
    pub auth_epoch: i32,
    pub expires_at_unix: i64,
    pub granter_key_fpr: [u8; 32],
    pub subject_key_fpr: [u8; 32],
    pub root_pubkey_fpr: [u8; 32],
    pub signature: Vec<u8>,
}

fn read_fpr(rest: &mut &[u8], what: &'static str) -> Result<[u8; 32], InviteError> {
    unhex(lp_field(rest)?)
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or(InviteError::Malformed(what))
}

/// Parse `LP(n) ‖ n×[LP(invitation_id) ‖ LP(capability) ‖ LP(scope) ‖
/// LP(effective_from) ‖ LP(auth_epoch) ‖ LP(expires_at) ‖ LP(granter_fpr hex) ‖
/// LP(subject_fpr hex) ‖ LP(root_fpr hex) ‖ LP(sig hex)]`.
///
/// **Refused before any work:** n outside 1..=500, a duplicate or unsorted id, an
/// epoch that does not follow the one before it, a `steward` item in a batch of
/// more than one, a read or draw item that names an expiry. The subject is never
/// in the body: it is the invitation's own sealed account.
pub fn parse_confirm_body(body: &[u8]) -> Result<Vec<ConfirmItem>, InviteError> {
    let mut rest = body;
    let n = read_count(&mut rest)?;
    let mut items: Vec<ConfirmItem> = Vec::with_capacity(n);
    for _ in 0..n {
        let invitation = lp_field(&mut rest)?.to_string();
        check_invitation_id(&invitation, items.last().map(|i| i.invitation.as_str()))?;
        let capability =
            Capability::parse(lp_field(&mut rest)?).ok_or(InviteError::Malformed("capability"))?;
        let scope = parse_scope_text(lp_field(&mut rest)?)?;
        let effective_from_unix: i64 = lp_field(&mut rest)?
            .parse()
            .map_err(|_| InviteError::Malformed("effective from"))?;
        let auth_epoch = lp_field(&mut rest)?
            .parse::<i32>()
            .map_err(|_| InviteError::Malformed("authority epoch"))?;
        let expires_at_unix: i64 = lp_field(&mut rest)?
            .parse()
            .map_err(|_| InviteError::Malformed("expires at"))?;
        let granter_key_fpr = read_fpr(&mut rest, "key fingerprint")?;
        let subject_key_fpr = read_fpr(&mut rest, "key fingerprint")?;
        let root_pubkey_fpr = read_fpr(&mut rest, "key fingerprint")?;
        let signature = unhex(lp_field(&mut rest)?)
            .filter(|s| s.len() == 64)
            .ok_or(InviteError::Malformed("signature"))?;

        if capability == Capability::Steward && n > 1 {
            return Err(InviteError::Malformed(
                "a steward request is confirmed alone",
            ));
        }
        if capability != Capability::Steward && expires_at_unix != 0 {
            return Err(InviteError::Malformed("expires at"));
        }
        if let Some(previous) = items.last() {
            if previous.auth_epoch.checked_add(1) != Some(auth_epoch) {
                return Err(InviteError::Malformed(
                    "authority epochs are not consecutive",
                ));
            }
        }
        items.push(ConfirmItem {
            invitation,
            capability,
            scope,
            effective_from_unix,
            auth_epoch,
            expires_at_unix,
            granter_key_fpr,
            subject_key_fpr,
            root_pubkey_fpr,
            signature,
        });
    }
    if !rest.is_empty() {
        return Err(InviteError::Malformed("request body"));
    }
    Ok(items)
}

// ---------------------------------------------------------------------------
// Confirm: propose
// ---------------------------------------------------------------------------

/// One proposed grant: everything the client needs to rebuild `bytes` itself, and
/// the bytes.
pub struct Proposed {
    pub invitation: InvitationRow,
    pub proposal: grants::GrantProposal,
}

/// Look at a waiting invitation for the caller: the row exists in this
/// organisation, verifies, is joined, and its window is open. `index` is the
/// item's place in a batch.
fn waiting_row(
    ring: &KeyRing,
    row: Option<InvitationRow>,
    organisation: &str,
    now: i64,
    index: usize,
) -> Result<InvitationRow, InviteError> {
    let refuse = |reason| InviteError::Batch { index, reason };
    let row = row.ok_or(refuse(BatchReason::NotWaiting))?;
    if row.organisation_id != organisation {
        return Err(refuse(BatchReason::NotWaiting));
    }
    if !row_verifies(ring, &row) {
        return Err(refuse(BatchReason::Unverifiable));
    }
    if row.state != State::Joined {
        return Err(refuse(BatchReason::NotWaiting));
    }
    if !joined_window_open(&row, now) {
        return Err(refuse(BatchReason::WindowClosed));
    }
    Ok(row)
}

/// Hide a row from a caller who does not steward the **invitation's own** scope
/// (the scope it was issued at, not the one the request names): the answer is the
/// one a missing id gets, so a folder steward cannot tell an organisation-wide
/// invitation from nothing, and cannot confirm one.
async fn hide_outside_scope(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    verified: &grants::VerifiedAuthorityState,
    check: &mut StewardCheck,
    row: Option<InvitationRow>,
    index: usize,
) -> Result<Option<InvitationRow>, InviteError> {
    let Some(row) = row else { return Ok(None) };
    if row.organisation_id == auth.ctx.tenant().to_string()
        && !check
            .holds(tx, auth, verified, row.scope_id.as_deref())
            .await?
    {
        return Err(InviteError::Batch {
            index,
            reason: BatchReason::NotWaiting,
        });
    }
    Ok(Some(row))
}

/// The expiry a request implies: none for read and draw, and for a steward grant
/// the one named or [`STEWARD_GRANT_LIFETIME_SECONDS`] from `now`. An expiry past
/// that lifetime, or not in the future, is refused.
fn grant_expiry(capability: Capability, asked: Option<i64>, now: i64) -> Result<i64, InviteError> {
    if capability != Capability::Steward {
        return Ok(0);
    }
    let latest = now + STEWARD_GRANT_LIFETIME_SECONDS;
    match asked {
        None => Ok(latest),
        Some(at) if at > now + grants::SOLE_STEWARD_DELAY_SECONDS && at <= latest => Ok(at),
        Some(_) => Err(InviteError::Malformed("expires at")),
    }
}

/// Propose a confirm: for each item the grant the caller would sign, as
/// consecutive epochs from the head, **writing nothing**.
///
/// The caller's Steward at every item's scope comes first (so a non-steward
/// learns nothing about which invitations exist). The subject is the invitation's
/// sealed account and the key is its sealed `enrolled_key_fpr`: the steward
/// cannot read a non-member's keyring, so the proposal is built from the row.
pub async fn propose(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    auth: &Authority<'_>,
    items: &[ProposeItem],
    now: i64,
) -> Result<Vec<Proposed>, InviteError> {
    let organisation = auth.ctx.tenant().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    let mut check = StewardCheck::new();
    for item in items {
        let scope = item.scope.map(|s| s.to_string());
        if !check.holds(tx, auth, &verified, scope.as_deref()).await? {
            return Err(InviteError::Authority(AuthorityError::NotAuthorised));
        }
    }

    let mut rows = Vec::with_capacity(items.len());
    let mut requests = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let row = hide_outside_scope(
            tx,
            auth,
            &verified,
            &mut check,
            read_invitation(tx, &item.invitation, false).await?,
            index,
        )
        .await?;
        let row = waiting_row(ring, row, &organisation, now, index)?;
        let fpr = row.enrolled_key_fpr.ok_or(InviteError::Batch {
            index,
            reason: BatchReason::KeyChanged,
        })?;
        requests.push(KeyedGrantRequest {
            scope: item.scope,
            subject: row.account_id.clone(),
            subject_key_fpr: fpr,
            capability: item.capability,
            expires_at_unix: grant_expiry(item.capability, item.expires_at_unix, now)?,
        });
        rows.push(row);
    }

    let proposals = grants::propose_grants_for_keys(tx, auth, &verified, &requests, now)
        .await
        .map_err(|e| batch_error_from(0, e))?;
    Ok(rows
        .into_iter()
        .zip(proposals)
        .map(|(invitation, proposal)| Proposed {
            invitation,
            proposal,
        })
        .collect())
}

/// Turn what the authority layer refused into the typed reason a client acts on.
fn batch_error_from(index: usize, e: AuthorityError) -> InviteError {
    let reason = match e {
        AuthorityError::Stale(_) | AuthorityError::SoleStewardPathBlocked => BatchReason::Stale,
        AuthorityError::Signature(_) => BatchReason::BadSignature,
        AuthorityError::NotAuthorised | AuthorityError::QuorumNotMet { .. } => {
            BatchReason::NotAuthorised
        }
        AuthorityError::NoSigningKey => BatchReason::KeyChanged,
        AuthorityError::Unverifiable(_) => BatchReason::Unverifiable,
        other => return InviteError::Authority(other),
    };
    InviteError::Batch { index, reason }
}

// ---------------------------------------------------------------------------
// Confirm: sign, in one transaction
// ---------------------------------------------------------------------------

/// What one confirmed person got.
pub struct Confirmed {
    pub invitation: String,
    pub account: String,
    pub grant: String,
    pub capability: Capability,
    pub scope: Option<String>,
    pub effective_from_unix: i64,
    /// A steward grant made while others steward: not usable until seconded.
    pub needs_second: bool,
}

/// Confirm `items` in the caller's transaction: all of them, or none.
///
/// In order, before any work: the shape (done by [`parse_confirm_body`]) and that
/// the first epoch is the head's next. Then the caller's Steward at each scope,
/// the invitation rows locked in id order, and `now` taken once. For each item, in
/// order: the invitation's seal, joined and in its window; **the membership**
/// (always `member`: `admin` gates acts over members); the account's live keys must
/// be exactly the one it enrolled; the grant is rebuilt from the invitation's own
/// subject and key and handed to `grants::sign_grant_at`, which re-derives every
/// server choice, checks the epoch, verifies the signature and advances the head;
/// then the invitation is closed `confirmed` with the grant, and `invitation_closed`
/// records the `batch_id` and size.
///
/// Any failure rolls back everything: no grant, no membership, no state change,
/// head unchanged. The answer names the item and a typed reason.
pub async fn confirm(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    auth: &Authority<'_>,
    items: &[ConfirmItem],
    now: i64,
) -> Result<(String, Vec<Confirmed>), InviteError> {
    let organisation = auth.ctx.tenant().to_string();
    let n = items.len();
    let batch_id = ids::new_ulid().to_string();

    // The caller stewards every scope named, under the real epoch watch and before
    // anything is written. This comes before the epoch compare, so a member who
    // stewards nothing learns nothing about the head.
    let verified = grants::verify_authority_state(tx, auth).await?;
    let mut check = StewardCheck::new();
    for (index, item) in items.iter().enumerate() {
        let scope = item.scope.map(|s| s.to_string());
        if !check.holds(tx, auth, &verified, scope.as_deref()).await? {
            return Err(InviteError::Batch {
                index,
                reason: BatchReason::NotAuthorised,
            });
        }
    }
    // The head's next epoch is the first item's.
    let head = grants::head_epoch(tx, &organisation).await?;
    if items.first().map(|i| i.auth_epoch) != head.checked_add(1) {
        return Err(InviteError::Batch {
            index: 0,
            reason: BatchReason::Stale,
        });
    }
    enter_custody(tx).await?;

    // Lock the rows in id order (the order the ids are strictly ascending in).
    let wanted: Vec<&str> = items.iter().map(|i| i.invitation.as_str()).collect();
    let locked = tx
        .query(
            &format!(
                "SELECT {INVITATION_COLUMNS} FROM organisation_invitations \
                  WHERE id = ANY($1) AND organisation_id = $2 ORDER BY id FOR UPDATE"
            ),
            &[&wanted, &organisation],
        )
        .await?;
    let mut rows: HashMap<String, InvitationRow> = HashMap::new();
    for r in &locked {
        let row = invitation_from_row(r)?;
        rows.insert(row.id.clone(), row);
    }

    // Later items see the head the earlier ones moved. That is the point of a
    // batch, and it must not touch the process-wide rollback watch: a batch that
    // then fails rolls the head back, and a watch that had seen the in-flight
    // epoch would call the rolled-back store a rollback.
    let batch_watch = EpochWatch::new();
    let batch_auth = Authority {
        ring: auth.ring,
        ctx: auth.ctx,
        tenant_key: auth.tenant_key,
        watch: &batch_watch,
    };

    let mut out = Vec::with_capacity(n);
    for (index, item) in items.iter().enumerate() {
        let refuse = |reason| InviteError::Batch { index, reason };
        let row = hide_outside_scope(
            tx,
            auth,
            &verified,
            &mut check,
            rows.remove(&item.invitation),
            index,
        )
        .await?;
        let row = waiting_row(ring, row, &organisation, now, index)?;
        let enrolled = row
            .enrolled_key_fpr
            .ok_or(refuse(BatchReason::KeyChanged))?;
        // The key the person enrolled, and nothing else: the request names it
        // and it must match what the row sealed when they joined.
        if item.subject_key_fpr != enrolled {
            return Err(refuse(BatchReason::KeyChanged));
        }

        // The membership first: until it exists a steward cannot read the
        // person's keyring. Always `member`.
        match tx
            .execute(
                "INSERT INTO memberships (account_id, organisation_id, role) \
                 VALUES ($1, $2, 'member')",
                &[&row.account_id, &organisation],
            )
            .await
        {
            Ok(_) => {}
            Err(e) if e.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION) => {
                return Err(refuse(BatchReason::MembershipExists));
            }
            Err(e) => return Err(e.into()),
        }
        let live = grants::live_signing_keys(tx, &row.account_id)
            .await
            .map_err(|e| batch_error_from(index, e))?;
        if live.len() != 1 || live[0].fpr != enrolled {
            return Err(refuse(BatchReason::KeyChanged));
        }

        let sole = grants::is_sole_steward_appointment(tx, &organisation, item.capability, now)
            .await
            .map_err(|e| batch_error_from(index, e))?;
        let proposal = grants::GrantProposal {
            organisation: organisation.clone(),
            scope: item.scope.map(|s| s.to_string()),
            subject: row.account_id.clone(),
            subject_key_fpr: enrolled,
            capability: item.capability,
            granter: auth.ctx.actor().to_string(),
            granter_key_fpr: item.granter_key_fpr,
            root_pubkey_fpr: item.root_pubkey_fpr,
            effective_from_unix: item.effective_from_unix,
            expires_at_unix: grant_expiry(
                item.capability,
                (item.capability == Capability::Steward).then_some(item.expires_at_unix),
                now,
            )?,
            auth_epoch: item.auth_epoch,
            sole_steward_appointment: sole,
            bytes: Vec::new(),
        }
        .rebuilt();
        let grant = grants::sign_grant_at(tx, &batch_auth, &proposal, &item.signature, now)
            .await
            .map_err(|e| batch_error_from(index, e))?;

        close_with(
            tx,
            ring,
            auth,
            row.clone(),
            State::Confirmed,
            Some(&grant),
            Some((&batch_id, n)),
        )
        .await?;
        out.push(Confirmed {
            invitation: row.id.clone(),
            account: row.account_id.clone(),
            grant,
            capability: item.capability,
            scope: item.scope.map(|s| s.to_string()),
            effective_from_unix: item.effective_from_unix,
            needs_second: item.capability == Capability::Steward && !sole,
        });
    }
    leave_custody(tx).await?;
    Ok((batch_id, out))
}

// Kept in one place so the route and the tests agree on what a confirmed item
// looks like on the wire.
impl Confirmed {
    pub fn to_json(&self) -> Json {
        obj(vec![
            ("invitation", Json::Str(self.invitation.clone())),
            ("account", Json::Str(self.account.clone())),
            ("grant", Json::Str(self.grant.clone())),
            (
                "capability",
                Json::Str(self.capability.as_str().to_string()),
            ),
            ("scope_id", opt_str(&self.scope)),
            ("effective_from_unix", Json::Int(self.effective_from_unix)),
            ("needs_second", Json::Bool(self.needs_second)),
        ])
    }
}

impl Proposed {
    pub fn to_json(&self) -> Json {
        let p = &self.proposal;
        let r = &self.invitation;
        obj(vec![
            ("invitation", Json::Str(r.id.clone())),
            ("subject", Json::Str(p.subject.clone())),
            ("subject_key_fpr", Json::Str(hex(&p.subject_key_fpr))),
            ("key_code", Json::Str(key_code(&p.subject_key_fpr))),
            ("capability", Json::Str(p.capability.as_str().to_string())),
            ("scope_id", opt_str(&p.scope)),
            ("effective_from_unix", Json::Int(p.effective_from_unix)),
            ("expires_at_unix", Json::Int(p.expires_at_unix)),
            ("auth_epoch", Json::Int(i64::from(p.auth_epoch))),
            (
                "sole_steward_appointment",
                Json::Bool(p.sole_steward_appointment),
            ),
            ("granter_key_fpr", Json::Str(hex(&p.granter_key_fpr))),
            ("root_pubkey_fpr", Json::Str(hex(&p.root_pubkey_fpr))),
            ("bytes", Json::Str(hex(&p.bytes))),
        ])
    }
}

/// The grant, for a seconder to compare with what they are shown.
pub fn second_view_json(view: &grants::SecondView, subject_name: &str, scope_label: &str) -> Json {
    let g: &Grant = &view.grant;
    obj(vec![
        ("grant", Json::Str(g.id.clone())),
        ("organisation", Json::Str(g.organisation_id.clone())),
        ("scope_id", opt_str(&g.scope_id)),
        ("scope_label", Json::Str(scope_label.to_string())),
        ("subject", Json::Str(g.subject_id.clone())),
        ("subject_name", Json::Str(subject_name.to_string())),
        ("subject_key_fpr", Json::Str(hex(&g.subject_key_fpr))),
        ("key_code", Json::Str(key_code(&g.subject_key_fpr))),
        ("capability", Json::Str(g.capability.as_str().to_string())),
        ("granter", opt_str(&g.granted_by)),
        ("granter_key_fpr", Json::Str(hex(&g.granter_key_fpr))),
        ("root_pubkey_fpr", Json::Str(hex(&view.root_pubkey_fpr))),
        ("effective_from_unix", Json::Int(g.effective_from_unix)),
        ("expires_at_unix", Json::Int(g.expires_at_unix)),
        ("auth_epoch", Json::Int(i64::from(g.auth_epoch))),
        (
            "sole_steward_appointment",
            Json::Bool(g.sole_steward_appointment),
        ),
        ("grant_bytes", Json::Str(hex(&view.grant_bytes))),
        ("second_bytes", Json::Str(hex(&view.second_bytes))),
    ])
}

/// A scope's display label, or the organisation's name for the organisation.
pub async fn scope_label(
    tx: &Transaction<'_>,
    organisation: &str,
    scope: Option<&str>,
) -> Result<String, InviteError> {
    match scope {
        None => organisation_name(tx, organisation).await,
        Some(id) => Ok(tx
            .query_opt(
                "SELECT display_name FROM scopes WHERE id = $1 AND organisation_id = $2",
                &[&id, &organisation],
            )
            .await?
            .map(|r| r.get(0))
            .unwrap_or_default()),
    }
}

/// The display name of an account a steward may read (a member's), for the
/// seconding view.
pub async fn account_name(tx: &Transaction<'_>, account: &str) -> Result<String, InviteError> {
    NameIndex::default().name_of(tx, account).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_code_is_ten_crockford_characters_of_the_first_fifty_bits() {
        // Pinned so the TypeScript client can share the vector.
        let mut fpr = [0u8; 32];
        for (i, b) in fpr.iter_mut().enumerate() {
            *b = i as u8;
        }
        assert_eq!(key_code(&fpr), "000G40R40M");
        assert_eq!(key_code(&[0xff; 32]), "ZZZZZZZZZZ");
        assert_eq!(key_code(&[0; 32]), "0000000000");
    }

    #[test]
    fn a_sign_in_name_is_a_slug_and_eight_characters_and_never_an_email() {
        let name = make_sign_in_name("Ada Lovelace-King").unwrap();
        assert!(!name.contains('@'), "{name}");
        let (slug, suffix) = name.rsplit_once('-').unwrap();
        assert_eq!(slug, "ada-lovelace-king");
        assert_eq!(suffix.len(), 8);
        assert!(name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        // A name with nothing sluggable still gets one.
        assert!(make_sign_in_name("   ").unwrap().starts_with("guest-"));
        assert!(!make_sign_in_name("a@b.example").unwrap().contains('@'));
        assert_ne!(
            make_sign_in_name("Ada").unwrap(),
            make_sign_in_name("Ada").unwrap()
        );
    }

    fn lp(out: &mut Vec<u8>, field: &str) {
        crypto::lp(out, field.as_bytes());
    }

    fn id(n: u8) -> String {
        format!("{:0>26}", format!("{n}"))
    }

    fn propose_body(items: &[(&str, &str, &str)], tail: Option<&str>, count: &str) -> Vec<u8> {
        let mut out = Vec::new();
        lp(&mut out, count);
        for (a, b, c) in items {
            lp(&mut out, a);
            lp(&mut out, b);
            lp(&mut out, c);
        }
        if let Some(t) = tail {
            lp(&mut out, t);
        }
        out
    }

    #[test]
    fn a_proposal_is_refused_for_count_order_duplicates_and_steward_in_a_batch() {
        let (a, b) = (id(1), id(2));
        let ok = propose_body(&[(&a, "read", ""), (&b, "draw", "")], None, "2");
        assert_eq!(parse_propose_body(&ok).unwrap().len(), 2);
        for (why, body) in [
            ("zero", propose_body(&[], None, "0")),
            ("501", propose_body(&[(&a, "read", "")], None, "501")),
            (
                "duplicate",
                propose_body(&[(&a, "read", ""), (&a, "read", "")], None, "2"),
            ),
            (
                "unsorted",
                propose_body(&[(&b, "read", ""), (&a, "read", "")], None, "2"),
            ),
            (
                "steward among two",
                propose_body(&[(&a, "read", ""), (&b, "steward", "")], None, "2"),
            ),
            (
                "count says 2, body has 1",
                propose_body(&[(&a, "read", "")], None, "2"),
            ),
            (
                "trailing bytes",
                propose_body(&[(&a, "read", "")], Some("x"), "1"),
            ),
            (
                "steward alone but no expiry field",
                propose_body(&[(&a, "steward", "")], None, "1"),
            ),
            ("short id", propose_body(&[("abc", "read", "")], None, "1")),
        ] {
            assert!(parse_propose_body(&body).is_err(), "{why}");
        }
        let alone = propose_body(&[(&a, "steward", "")], Some(""), "1");
        let parsed = parse_propose_body(&alone).unwrap();
        assert_eq!(parsed[0].expires_at_unix, None);
    }

    fn confirm_line(out: &mut Vec<u8>, id: &str, capability: &str, epoch: i32, expires: i64) {
        lp(out, id);
        lp(out, capability);
        lp(out, "");
        lp(out, "1700000000");
        lp(out, &epoch.to_string());
        lp(out, &expires.to_string());
        lp(out, &"ab".repeat(32));
        lp(out, &"cd".repeat(32));
        lp(out, &"ef".repeat(32));
        lp(out, &"01".repeat(64));
    }

    fn confirm_body(lines: &[(String, &str, i32, i64)], count: &str) -> Vec<u8> {
        let mut out = Vec::new();
        lp(&mut out, count);
        for (id, cap, epoch, expires) in lines {
            confirm_line(&mut out, id, cap, *epoch, *expires);
        }
        out
    }

    #[test]
    fn a_confirm_is_refused_before_any_work_for_every_shape_fault() {
        let (a, b) = (id(1), id(2));
        let ok = confirm_body(&[(a.clone(), "read", 5, 0), (b.clone(), "draw", 6, 0)], "2");
        assert_eq!(parse_confirm_body(&ok).unwrap().len(), 2);
        for (why, body) in [
            ("zero", confirm_body(&[], "0")),
            ("501", confirm_body(&[(a.clone(), "read", 5, 0)], "501")),
            (
                "duplicate",
                confirm_body(&[(a.clone(), "read", 5, 0), (a.clone(), "read", 6, 0)], "2"),
            ),
            (
                "unsorted",
                confirm_body(&[(b.clone(), "read", 5, 0), (a.clone(), "read", 6, 0)], "2"),
            ),
            (
                "epoch gap",
                confirm_body(&[(a.clone(), "read", 5, 0), (b.clone(), "read", 7, 0)], "2"),
            ),
            (
                "epoch repeats",
                confirm_body(&[(a.clone(), "read", 5, 0), (b.clone(), "read", 5, 0)], "2"),
            ),
            (
                "steward in a batch",
                confirm_body(
                    &[(a.clone(), "read", 5, 0), (b.clone(), "steward", 6, 99)],
                    "2",
                ),
            ),
            (
                "read with an expiry",
                confirm_body(&[(a.clone(), "read", 5, 99)], "1"),
            ),
        ] {
            assert!(parse_confirm_body(&body).is_err(), "{why}");
        }
        let mut with_extra = ok.clone();
        with_extra.push(0);
        assert!(parse_confirm_body(&with_extra).is_err());
        let alone = confirm_body(&[(a, "steward", 5, 1_800_000_000)], "1");
        assert_eq!(parse_confirm_body(&alone).unwrap().len(), 1);
    }

    #[test]
    fn an_issue_body_has_no_account_field_and_refuses_an_extra_one() {
        let mut body = Vec::new();
        for f in ["Ada", "ada@example.org", "read", ""] {
            lp(&mut body, f);
        }
        let parsed = parse_issue_body(&body).unwrap();
        assert_eq!(parsed.display_name, "Ada");
        assert_eq!(parsed.contact_email.as_deref(), Some("ada@example.org"));
        lp(&mut body, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert!(
            parse_issue_body(&body).is_err(),
            "a fifth field naming an account is not part of the format"
        );
        let mut blank = Vec::new();
        for f in ["  ", "", "read", ""] {
            lp(&mut blank, f);
        }
        assert!(parse_issue_body(&blank).is_err(), "a name is required");
    }

    #[test]
    fn a_steward_grant_expiry_is_named_or_a_year_and_never_longer() {
        let now = 1_000_000_000;
        assert_eq!(grant_expiry(Capability::Read, Some(5), now).unwrap(), 0);
        assert_eq!(
            grant_expiry(Capability::Steward, None, now).unwrap(),
            now + STEWARD_GRANT_LIFETIME_SECONDS
        );
        assert!(grant_expiry(
            Capability::Steward,
            Some(now + STEWARD_GRANT_LIFETIME_SECONDS + 1),
            now
        )
        .is_err());
        assert!(grant_expiry(Capability::Steward, Some(now), now).is_err());
        assert!(grant_expiry(Capability::Steward, Some(now + 3600), now).is_err());
        assert!(grant_expiry(Capability::Steward, Some(now + 40 * 86_400), now).is_ok());
    }
}
