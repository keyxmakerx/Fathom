//! AI access keys (ADR-0072).
//!
//! A person lets their own AI app read the designs they can read, in ONE organisation, and
//! send recommendations a person then accepts or dismisses. The app never saves anything:
//! accepting is the accepter's own edit, made in the client, exactly as a cable correction's
//! is (`src/corrections.rs`). It never reaches a password, the vault, the operator plane or
//! another organisation, because nothing on its router names them and its requests cannot
//! become a session (`src/ai_api.rs`).
//!
//! What enforces what, by function:
//! - [`verify_request`]: the four `Fathom-AI-*` headers. Time inside [`WINDOW_SECS`], a
//!   signature by the key's public half over method, path, body, nonce, time and this
//!   deployment, the nonce spent once, the key on and unexpired. The only maker of a
//!   [`VerifiedAi`], whose fields are private.
//! - [`open`]: in the handler's own transaction, again: the server switch, the key row
//!   (sealed, on, unexpired), the organisation's policy (on, owner still a maker), and the
//!   owner's membership, through `repo::open_tenant_context` as a browser request goes.
//! - [`covers`]: a key's folders. The owner's own grant is checked as well, every request.
//! - [`ai_reading`]: what leaves is `ai_reading`'s allowlist at the key's tiers, cut to the
//!   organisation's ceiling at the time of the request.
//! - [`make_key`], [`change_key`], [`stop_key`]: who may do what to which field (decision
//!   5). The owner widens or narrows; a Steward only narrows or stops; nobody moves an end
//!   later. Every act is on the organisation chain, and the database refuses the rest
//!   (`0046`'s `fathom_ai_key_moves`).
//! - [`operator_disable_key`], [`operator_set_switch`]: the server's operator may stop a
//!   key or turn AI off on the whole server. Neither grants anything.
//! - Rows are sealed under the organisation's row key (the server switch under the site's),
//!   so a key widened in the database without a reseal is refused, not obeyed.

use std::collections::{BTreeMap, BTreeSet};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use deadpool_postgres::{Pool, PoolError, Transaction};
use fathom_canon::Json;
use sha2::{Digest, Sha256};

use crate::ai_reading::{self, Tier};
use crate::authority::{self, Capability, RowFacts};
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError};
use crate::crypto::hex;
use crate::crypto::{self, CryptoError};
use crate::designs::{self, DesignError};
use crate::field_defs::{self, is_unsafe_char};
use crate::grants::{self, Authority, AuthorityError};
use crate::heads::HeadStore;
use crate::keys::{self, KeyRing, KeyStoreError};
use crate::repo::{self, AccountId, DesignId, OrganisationId, RepoError, ScopeId};

/// In-signature tag of an AI request ([`request_bytes`]).
const TAG_AI_REQUEST: &[u8] = b"fathom/ai/req/v1";
/// Hash tag of a key id derived from its public half ([`key_id_of`]).
const TAG_AI_KEY_ID: &[u8] = b"fathom/ai/key-id/v1";
/// Hash tag of a spent nonce as stored ([`nonce_hash`]).
const TAG_AI_NONCE: &[u8] = b"fathom/ai/nonce/v1";
/// AEAD associated-data tag of a sealed recommendation body.
const AAD_AI_RECOMMENDATION: &[u8] = b"fathom/ai/recommendation/v1";

/// Every label this module introduces, as `authority::LABELS` lists that module's.
pub const LABELS: &[(&str, &str)] = &[
    ("fathom/ai/req/v1", "in-signature tag of an AI request"),
    (
        "fathom/ai/key-id/v1",
        "hash tag of an AI key id, from its public half",
    ),
    ("fathom/ai/nonce/v1", "hash tag of a spent AI request nonce"),
    (
        "fathom/ai/recommendation/v1",
        "AEAD tag of a sealed AI recommendation",
    ),
];

pub const HEADER_KEY: &str = "fathom-ai-key";
pub const HEADER_TIME: &str = "fathom-ai-time";
pub const HEADER_NONCE: &str = "fathom-ai-nonce";
pub const HEADER_SIGNATURE: &str = "fathom-ai-signature";

/// How far a request's own time may be from the server's, either way, in seconds.
pub const WINDOW_SECS: i64 = 120;
/// Requests one key may make in any [`WINDOW_SECS`]: 60 a minute.
pub const REQUESTS_PER_WINDOW: i64 = 120;
/// Keys one person may have on, in one organisation.
pub const MAX_KEYS_PER_OWNER: i64 = 10;
pub const MAX_LABEL_CHARS: usize = 60;
pub const MAX_REASON_CHARS: usize = 300;
pub const MAX_KEY_SCOPES: usize = 50;
pub const MAX_MAKERS: usize = 500;
pub const MAX_SECOND_PERSON_SCOPES: usize = 200;
/// The lengths a key may be made for, in days; the organisation picks the longest.
pub const DAYS: [i32; 3] = [30, 90, 365];
/// Open recommendations on one design, and in one organisation.
pub const MAX_OPEN_PER_DESIGN: i64 = 20;
pub const MAX_OPEN_PER_ORGANISATION: i64 = 200;
/// What one recommendation may carry.
pub const MAX_STEPS: usize = 20;
pub const MAX_TITLE_CHARS: usize = 120;
pub const MAX_WHY_CHARS: usize = 1000;
pub const MAX_STEP_CHARS: usize = 300;
/// What a step does. A person reads it; nothing applies it.
pub const ACTIONS: [&str; 6] = ["add", "change", "remove", "connect", "move", "label"];
/// The apps a policy can allow through the connector sign-in (ADR-0072 decision 16):
/// Claude's hosted apps, Claude Code, and any app that registered itself.
pub const APPS: [&str; 3] = ["claude", "claude-code", "other"];
/// Decided recommendations listed beside the open ones.
const MAX_DECIDED_LISTED: i64 = 50;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum AiError {
    Pool(PoolError),
    Db(tokio_postgres::Error),
    Repo(RepoError),
    Keys(KeyStoreError),
    Crypto(CryptoError),
    Chain(ChainStoreError),
    Authority(AuthorityError),
    Design(DesignError),
    /// An AI request that does not stand: no such key, stopped, expired, wrong signature,
    /// replayed, or its owner no longer a member. ONE answer for all of them (decision 12),
    /// so a stolen or guessed key id learns nothing.
    Refused,
    /// The request's own time is more than [`WINDOW_SECS`] from the server's. Checked before
    /// the key is looked up, so it says nothing about the key.
    Clock,
    /// The operator turned AI off on this server.
    SiteOff,
    /// This organisation has AI off, or its owner is no longer among the people who may
    /// make keys.
    OrganisationOff,
    /// A key used more than [`REQUESTS_PER_WINDOW`] times in [`WINDOW_SECS`].
    Limited,
    /// A rule refused the act; the sentence says which.
    NotAllowed(&'static str),
    Malformed(&'static str),
    NotFound,
    /// The row changed since the caller read it.
    Conflict {
        version: i64,
    },
    /// Text that reads as a password or key was not taken.
    LooksSecret,
    /// One operation of an AI's change was refused; the sentence says why, never the value.
    Operation {
        index: usize,
        why: String,
    },
    /// An AI's change named a version the design has moved on from (ADR-0077 decision 6).
    Moved {
        read: i64,
        current: i64,
    },
    /// A stored row does not verify: not a permission answer (§3.4), an alarm.
    Unverifiable(&'static str),
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pool(e) => write!(f, "pool: {e}"),
            Self::Db(e) => write!(f, "database: {e}"),
            Self::Repo(e) => write!(f, "repo: {e}"),
            Self::Keys(e) => write!(f, "keys: {e}"),
            Self::Crypto(e) => write!(f, "crypto: {e:?}"),
            Self::Chain(e) => write!(f, "chain: {e}"),
            Self::Authority(e) => write!(f, "authority: {e}"),
            Self::Design(e) => write!(f, "design: {e}"),
            Self::Refused => f.write_str("refused"),
            Self::Clock => f.write_str("clock"),
            Self::SiteOff => f.write_str("AI is off on this server"),
            Self::OrganisationOff => f.write_str("AI is off in this organisation"),
            Self::Limited => f.write_str("limited"),
            Self::NotAllowed(why) | Self::Malformed(why) => f.write_str(why),
            Self::NotFound => f.write_str("not found"),
            Self::Conflict { version } => write!(f, "changed (now {version})"),
            Self::LooksSecret => f.write_str("looks secret"),
            Self::Operation { index, why } => write!(f, "operation {} {why}", index + 1),
            Self::Moved { read, current } => write!(
                f,
                "the design is at version {current}, not {read}, the version this change names; \
                 read it again and make the change against what is there now"
            ),
            Self::Unverifiable(what) => write!(f, "unverifiable: {what}"),
        }
    }
}

macro_rules! from_error {
    ($($t:ty => $v:ident),* $(,)?) => {
        $(impl From<$t> for AiError {
            fn from(e: $t) -> Self {
                Self::$v(e)
            }
        })*
    };
}

from_error!(
    PoolError => Pool,
    tokio_postgres::Error => Db,
    RepoError => Repo,
    KeyStoreError => Keys,
    CryptoError => Crypto,
    ChainStoreError => Chain,
    AuthorityError => Authority,
    DesignError => Design,
);

impl AiError {
    /// The answer a person or an AI app sees. Every refusal of a request is the same
    /// 401; an integrity fault is logged as the alarm it is and answered `refused`.
    pub fn response(self) -> Response {
        let text = |status: StatusCode, body: String| -> Response {
            (
                status,
                [(axum::http::header::CACHE_CONTROL, "no-store")],
                body,
            )
                .into_response()
        };
        match self {
            Self::Refused => text(StatusCode::UNAUTHORIZED, "refused\n".into()),
            Self::Clock => text(
                StatusCode::UNAUTHORIZED,
                "the request's time is more than two minutes from the server's; check this \
                 computer's clock\n"
                    .into(),
            ),
            Self::SiteOff => text(
                StatusCode::FORBIDDEN,
                "AI access is turned off on this server\n".into(),
            ),
            Self::OrganisationOff => text(
                StatusCode::FORBIDDEN,
                "AI access is turned off for you in this organisation\n".into(),
            ),
            Self::Limited => (
                StatusCode::TOO_MANY_REQUESTS,
                [(axum::http::header::RETRY_AFTER, "60")],
                "this key is limited to 60 requests a minute\n",
            )
                .into_response(),
            Self::NotAllowed(why) => text(StatusCode::FORBIDDEN, format!("{why}\n")),
            Self::Malformed(why) => text(StatusCode::BAD_REQUEST, format!("{why}\n")),
            Self::NotFound => text(StatusCode::NOT_FOUND, "not found\n".into()),
            Self::Conflict { version } => text(
                StatusCode::CONFLICT,
                format!("that changed (now at version {version}); reload and try again\n"),
            ),
            Self::LooksSecret => text(
                StatusCode::UNPROCESSABLE_ENTITY,
                "That looks as if it carries a password or key, so it was not taken. Reword it \
                 without the value.\n"
                    .into(),
            ),
            e @ Self::Operation { .. } => text(StatusCode::UNPROCESSABLE_ENTITY, format!("{e}\n")),
            e @ Self::Moved { .. } => text(StatusCode::CONFLICT, format!("{e}\n")),
            Self::Authority(AuthorityError::NotAuthorised)
            | Self::Authority(AuthorityError::QuorumNotMet { .. }) => text(
                StatusCode::FORBIDDEN,
                "you do not have the permission this needs\n".into(),
            ),
            Self::Design(DesignError::NoSuchDesign) => {
                text(StatusCode::NOT_FOUND, "not found\n".into())
            }
            Self::Unverifiable(what) => {
                tracing::error!(what, "an AI row did not verify");
                text(StatusCode::INTERNAL_SERVER_ERROR, "refused\n".into())
            }
            other => {
                tracing::error!(reason = %other, "AI request failed");
                text(StatusCode::INTERNAL_SERVER_ERROR, "refused\n".into())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

pub(crate) fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    text.as_bytes()
        .chunks(2)
        .map(|p| {
            let hi = (p[0] as char).to_digit(16)?;
            let lo = (p[1] as char).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

fn strs(items: &[String]) -> Json {
    Json::Arr(items.iter().map(|s| Json::Str(s.clone())).collect())
}

fn opt_str(v: &Option<String>) -> Json {
    v.as_deref()
        .map_or(Json::Null, |s| Json::Str(s.to_string()))
}

fn opt_int(v: Option<i64>) -> Json {
    v.map_or(Json::Null, Json::Int)
}

fn metadata(entry_type: EntryType, fields: &[(&str, Json)]) -> Vec<u8> {
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

/// A ULID in its canonical spelling, or nothing.
pub fn canonical_ulid(text: &str) -> Option<String> {
    fathom_id::Ulid::decode(text)
        .ok()
        .map(|u| u.to_string())
        .filter(|u| u == text)
}

/// One line a person or an app typed: whitespace collapsed, 1 to `max` characters, no
/// control or invisible character, nothing the redaction gate's BARE check reads as a
/// credential (`corrections::clean_text`'s rule).
pub fn clean_line(raw: &str, max: usize, empty_ok: bool) -> Result<String, AiError> {
    if raw
        .chars()
        .any(|c| !matches!(c, '\n' | '\r' | '\t') && is_unsafe_char(c))
    {
        return Err(AiError::Malformed(
            "text must not contain control or invisible characters",
        ));
    }
    let t = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if (t.is_empty() && !empty_ok) || t.chars().count() > max {
        return Err(AiError::Malformed("text is too short or too long"));
    }
    if !t.is_empty() && fathom_ingest::redact::looks_like_credential_bare(&t) {
        return Err(AiError::LooksSecret);
    }
    Ok(t)
}

/// The AI account a person says an app uses: one address, as typed, in lower case. Fathom never
/// checks it (ADR-0072 decision 24); it is only shown to the owner, Stewards and admins.
pub fn clean_account(raw: &str) -> Result<String, AiError> {
    let t = raw.trim().to_lowercase();
    let ok = (3..=254).contains(&t.chars().count())
        && t.matches('@').count() == 1
        && !t.starts_with('@')
        && !t.ends_with('@')
        && !t.chars().any(|c| c.is_whitespace() || is_unsafe_char(c));
    if !ok {
        return Err(AiError::Malformed(
            "say which AI account the app is signed in to, as an email address",
        ));
    }
    Ok(t)
}

/// What a key may see, as stored: `layout` always, the rest in [`Tier::ALL`]'s order.
pub fn clean_sees(raw: &[String]) -> Result<Vec<String>, AiError> {
    let mut set = BTreeSet::new();
    for s in raw {
        set.insert(Tier::parse(s).ok_or(AiError::Malformed(
            "what a key sees is layout, addresses and notes",
        ))?);
    }
    set.insert(Tier::Layout);
    Ok(Tier::ALL
        .iter()
        .filter(|t| set.contains(t))
        .map(|t| t.as_str().to_string())
        .collect())
}

fn is_subset(small: &[String], big: &[String]) -> bool {
    small.iter().all(|s| big.contains(s))
}

/// Whether a key's folders reach a design whose scope has `path` (`0002`: dot-joined ids,
/// root first, ending in the scope's own). No folders means every folder its owner can read.
pub fn covers(key_scopes: &[String], path: &str) -> bool {
    key_scopes.is_empty() || path.split('.').any(|p| key_scopes.iter().any(|s| s == p))
}

/// Whether narrowing `old` to `new` folders gives the key no folder it did not have.
fn scopes_narrow(old: &[String], new: &[String]) -> bool {
    if old.is_empty() {
        return true;
    }
    !new.is_empty() && is_subset(new, old)
}

/// A key's id, from its public half: the first 16 bytes of a tagged SHA-256, as a ULID. So
/// the helper knows its own id without being told, and a key cannot be registered twice.
pub fn key_id_of(public_key: &[u8]) -> String {
    let mut msg = Vec::new();
    crypto::lp(&mut msg, TAG_AI_KEY_ID);
    crypto::lp(&mut msg, public_key);
    let digest: [u8; 32] = Sha256::digest(&msg).into();
    let mut first = [0u8; 16];
    first.copy_from_slice(&digest[..16]);
    fathom_id::Ulid(u128::from_be_bytes(first)).to_string()
}

/// What an AI app signs.
///
/// ```text
/// LP("fathom/ai/req/v1") ‖ LP(deployment) ‖ LP(key_id) ‖ LP(method) ‖ LP(path_and_query)
///   ‖ LP(SHA-256(body)) ‖ LP(nonce) ‖ u64(unix_seconds)
/// ```
///
/// The deployment is in it so a request made for one server is refused by another.
pub fn request_bytes(
    deployment: &str,
    key_id: &str,
    method: &str,
    path: &str,
    body: &[u8],
    nonce: &[u8; 32],
    unix: i64,
) -> Vec<u8> {
    let digest: [u8; 32] = Sha256::digest(body).into();
    let mut msg = Vec::with_capacity(256);
    crypto::lp(&mut msg, TAG_AI_REQUEST);
    crypto::lp(&mut msg, deployment.as_bytes());
    crypto::lp(&mut msg, key_id.as_bytes());
    crypto::lp(&mut msg, method.as_bytes());
    crypto::lp(&mut msg, path.as_bytes());
    crypto::lp(&mut msg, &digest);
    crypto::lp(&mut msg, nonce);
    crypto::u64_le(&mut msg, unix as u64);
    msg
}

fn nonce_hash(key_id: &str, nonce: &[u8; 32]) -> Vec<u8> {
    let mut msg = Vec::new();
    crypto::lp(&mut msg, TAG_AI_NONCE);
    crypto::lp(&mut msg, key_id.as_bytes());
    crypto::lp(&mut msg, nonce);
    Sha256::digest(&msg).to_vec()
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// One organisation's AI policy. No row reads as [`Policy::off`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub allowed: bool,
    pub makers: Vec<String>,
    pub ceiling: Vec<String>,
    pub max_days: i32,
    pub second_person_scopes: Vec<String>,
    /// Which of [`APPS`] may connect through the sign-in.
    pub apps: Vec<String>,
    /// Whether a connection here may change designs at all (ADR-0077 decision 1).
    pub may_change: bool,
    pub changed_by: Option<String>,
    pub changed_unix: Option<i64>,
    changed_seq: i64,
    /// `0` when there is no row yet.
    pub version: i32,
}

impl Policy {
    pub fn off() -> Self {
        Self {
            allowed: false,
            makers: Vec::new(),
            ceiling: vec![Tier::Layout.as_str().to_string()],
            max_days: 90,
            second_person_scopes: Vec::new(),
            apps: vec!["claude".to_string()],
            may_change: false,
            changed_by: None,
            changed_unix: None,
            changed_seq: 0,
            version: 0,
        }
    }

    fn state(&self, organisation: &str) -> Vec<u8> {
        let mut m = BTreeMap::new();
        m.insert("organisation".into(), Json::Str(organisation.into()));
        m.insert("allowed".into(), Json::Bool(self.allowed));
        m.insert("makers".into(), strs(&self.makers));
        m.insert("ceiling".into(), strs(&self.ceiling));
        m.insert("max_days".into(), Json::Int(self.max_days as i64));
        m.insert(
            "second_person_scopes".into(),
            strs(&self.second_person_scopes),
        );
        m.insert("apps".into(), strs(&self.apps));
        // Only when on, so a row written before migration 0050 still verifies.
        if self.may_change {
            m.insert("may_change".into(), Json::Bool(true));
        }
        m.insert("changed_by".into(), opt_str(&self.changed_by));
        Json::Obj(m).to_canonical_bytes()
    }

    fn seal(&self, ring: &KeyRing, organisation: &str) -> [u8; 32] {
        let state = self.state(organisation);
        authority::row_seal(
            &grants::row_key_for(ring, organisation),
            &RowFacts {
                table: "ai_policies",
                row_id: organisation,
                chain_seq: self.changed_seq,
                row_version: self.version,
                row_state: &state,
            },
        )
    }

    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("allowed".into(), Json::Bool(self.allowed));
        m.insert("makers".into(), strs(&self.makers));
        m.insert("ceiling".into(), strs(&self.ceiling));
        m.insert("maxDays".into(), Json::Int(self.max_days as i64));
        m.insert(
            "secondPersonScopes".into(),
            strs(&self.second_person_scopes),
        );
        m.insert("apps".into(), strs(&self.apps));
        m.insert("mayChange".into(), Json::Bool(self.may_change));
        m.insert("changedBy".into(), opt_str(&self.changed_by));
        m.insert("changedAt".into(), opt_int(self.changed_unix));
        m.insert("version".into(), Json::Int(self.version as i64));
        Json::Obj(m)
    }
}

pub(crate) async fn read_policy(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
    lock: bool,
) -> Result<Policy, AiError> {
    let row = tx
        .query_opt(
            &format!(
                "SELECT allowed, makers, ceiling, max_days, second_person_scopes, apps, changed_by, \
                        extract(epoch FROM changed_at)::bigint, changed_seq, row_version, row_seal, may_change \
                 FROM ai_policies WHERE organisation_id = $1{}",
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&organisation],
        )
        .await?;
    let Some(row) = row else {
        return Ok(Policy::off());
    };
    let p = Policy {
        allowed: row.get(0),
        makers: row.get(1),
        ceiling: row.get(2),
        max_days: row.get(3),
        second_person_scopes: row.get(4),
        apps: row.get(5),
        changed_by: Some(row.get(6)),
        changed_unix: Some(row.get(7)),
        changed_seq: row.get(8),
        version: row.get(9),
        may_change: row.get(11),
    };
    let stored: Vec<u8> = row.get(10);
    if !crypto::ct_eq(&p.seal(ring, organisation), &stored) {
        return Err(AiError::Unverifiable("ai_policies row seal"));
    }
    Ok(p)
}

/// The server switch. No row means allowed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Switch {
    pub allowed: bool,
    pub reason: Option<String>,
    pub changed_by: Option<String>,
    pub changed_unix: Option<i64>,
    changed_seq: i64,
    pub version: i32,
}

impl Switch {
    fn on() -> Self {
        Self {
            allowed: true,
            reason: None,
            changed_by: None,
            changed_unix: None,
            changed_seq: 0,
            version: 0,
        }
    }

    fn state(&self) -> Vec<u8> {
        let mut m = BTreeMap::new();
        m.insert("allowed".into(), Json::Bool(self.allowed));
        m.insert("reason".into(), opt_str(&self.reason));
        m.insert("changed_by".into(), opt_str(&self.changed_by));
        Json::Obj(m).to_canonical_bytes()
    }

    async fn seal(&self, tx: &Transaction<'_>, ring: &KeyRing) -> Result<[u8; 32], AiError> {
        let key = grants::site_row_key(tx, ring).await?;
        let state = self.state();
        Ok(authority::row_seal(
            &key,
            &RowFacts {
                table: "ai_site_switch",
                row_id: "site",
                chain_seq: self.changed_seq,
                row_version: self.version,
                row_state: &state,
            },
        ))
    }

    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("allowed".into(), Json::Bool(self.allowed));
        m.insert("reason".into(), opt_str(&self.reason));
        m.insert("changedAt".into(), opt_int(self.changed_unix));
        m.insert("version".into(), Json::Int(self.version as i64));
        Json::Obj(m)
    }
}

pub(crate) async fn read_switch(tx: &Transaction<'_>, ring: &KeyRing) -> Result<Switch, AiError> {
    let row = tx
        .query_opt(
            "SELECT allowed, reason, changed_by, extract(epoch FROM changed_at)::bigint, \
                    changed_seq, row_version, row_seal \
             FROM ai_site_switch WHERE id = 'site'",
            &[],
        )
        .await?;
    let Some(row) = row else {
        return Ok(Switch::on());
    };
    let s = Switch {
        allowed: row.get(0),
        reason: row.get(1),
        changed_by: Some(row.get(2)),
        changed_unix: Some(row.get(3)),
        changed_seq: row.get(4),
        version: row.get(5),
    };
    let stored: Vec<u8> = row.get(6);
    if !crypto::ct_eq(&s.seal(tx, ring).await?, &stored) {
        return Err(AiError::Unverifiable("ai_site_switch row seal"));
    }
    Ok(s)
}

/// One AI key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiKey {
    pub organisation: String,
    pub id: String,
    pub owner: String,
    pub owner_name: String,
    /// `helper` or `connector` (migration `0046`).
    pub kind: String,
    /// A helper key's public half.
    pub public_key: Option<Vec<u8>>,
    /// A connector's client id.
    pub client_id: Option<String>,
    pub label: String,
    pub scopes: Vec<String>,
    pub sees: Vec<String>,
    pub may_recommend: bool,
    pub created_unix: i64,
    created_seq: i64,
    pub expires_unix: i64,
    pub state: String,
    changed_seq: i64,
    pub disabled_unix: Option<i64>,
    pub disabled_by: Option<String>,
    pub disabled_by_kind: Option<String>,
    pub disabled_reason: Option<String>,
    pub version: i32,
    /// The AI account the owner said it uses (migration `0049`). What they typed; never checked.
    pub ai_account: Option<String>,
    /// The owner's Fathom sign-in email, for the people who look after the organisation.
    pub owner_email: String,
    /// The connection's own "May change designs" tick (ADR-0077 decision 1).
    pub may_change: bool,
}

const KEY_COLUMNS: &str = "k.organisation_id, k.id, k.owner, \
     coalesce((SELECT a.display_name FROM accounts a WHERE a.id = k.owner), ''), \
     k.kind, k.public_key, k.client_id, k.label, k.scopes, k.sees, k.may_recommend, \
     extract(epoch FROM k.created_at)::bigint, k.created_seq, \
     extract(epoch FROM k.expires_at)::bigint, k.state, k.changed_seq, \
     extract(epoch FROM k.disabled_at)::bigint, k.disabled_by, k.disabled_by_kind, \
     k.disabled_reason, k.row_version, k.row_seal, k.ai_account, \
     coalesce((SELECT a.email FROM accounts a WHERE a.id = k.owner), ''), k.may_change";

/// How many columns [`KEY_COLUMNS`] selects; a query's own columns follow.
const KEY_COLUMN_COUNT: usize = 25;

impl AiKey {
    fn from_row(row: &tokio_postgres::Row) -> (Self, Vec<u8>) {
        (
            Self {
                organisation: row.get(0),
                id: row.get(1),
                owner: row.get(2),
                owner_name: row.get(3),
                kind: row.get(4),
                public_key: row.get(5),
                client_id: row.get(6),
                label: row.get(7),
                scopes: row.get(8),
                sees: row.get(9),
                may_recommend: row.get(10),
                created_unix: row.get(11),
                created_seq: row.get(12),
                expires_unix: row.get(13),
                state: row.get(14),
                changed_seq: row.get(15),
                disabled_unix: row.get(16),
                disabled_by: row.get(17),
                disabled_by_kind: row.get(18),
                disabled_reason: row.get(19),
                version: row.get(20),
                ai_account: row.get(22),
                owner_email: row.get(23),
                may_change: row.get(24),
            },
            row.get(21),
        )
    }

    fn state_bytes(&self) -> Vec<u8> {
        let mut m = BTreeMap::new();
        m.insert("organisation".into(), Json::Str(self.organisation.clone()));
        m.insert("id".into(), Json::Str(self.id.clone()));
        m.insert("owner".into(), Json::Str(self.owner.clone()));
        m.insert("kind".into(), Json::Str(self.kind.clone()));
        m.insert(
            "public_key".into(),
            match &self.public_key {
                Some(k) => Json::Str(hex(k)),
                None => Json::Null,
            },
        );
        m.insert("client_id".into(), opt_str(&self.client_id));
        m.insert("label".into(), Json::Str(self.label.clone()));
        m.insert("scopes".into(), strs(&self.scopes));
        m.insert("sees".into(), strs(&self.sees));
        m.insert("may_recommend".into(), Json::Bool(self.may_recommend));
        m.insert("created".into(), Json::Int(self.created_unix));
        m.insert("created_seq".into(), Json::Int(self.created_seq));
        m.insert("expires".into(), Json::Int(self.expires_unix));
        m.insert("state".into(), Json::Str(self.state.clone()));
        m.insert("disabled".into(), opt_int(self.disabled_unix));
        m.insert("disabled_by".into(), opt_str(&self.disabled_by));
        m.insert("disabled_by_kind".into(), opt_str(&self.disabled_by_kind));
        m.insert("disabled_reason".into(), opt_str(&self.disabled_reason));
        // Only when given, so a row made before migration 0049 still verifies.
        if let Some(account) = &self.ai_account {
            m.insert("ai_account".into(), Json::Str(account.clone()));
        }
        // Only when on, so a row written before migration 0050 still verifies.
        if self.may_change {
            m.insert("may_change".into(), Json::Bool(true));
        }
        Json::Obj(m).to_canonical_bytes()
    }

    fn seal(&self, ring: &KeyRing) -> [u8; 32] {
        let state = self.state_bytes();
        authority::row_seal(
            &grants::row_key_for(ring, &self.organisation),
            &RowFacts {
                table: "ai_keys",
                row_id: &self.id,
                chain_seq: self.changed_seq,
                row_version: self.version,
                row_state: &state,
            },
        )
    }

    /// Which app this is: `helper` for a key the helper made, else one of [`APPS`].
    pub fn app(&self) -> &'static str {
        match &self.client_id {
            None => "helper",
            Some(c) => crate::oauth::app_of(c),
        }
    }

    /// On and not past its end, at `now`.
    pub fn is_live(&self, now: i64) -> bool {
        self.state == "on" && self.expires_unix > now
    }

    pub fn to_json(&self, now: i64) -> Json {
        let mut m = BTreeMap::new();
        m.insert("id".into(), Json::Str(self.id.clone()));
        m.insert("owner".into(), Json::Str(self.owner.clone()));
        m.insert("ownerName".into(), Json::Str(self.owner_name.clone()));
        m.insert("ownerEmail".into(), Json::Str(self.owner_email.clone()));
        m.insert("aiAccount".into(), opt_str(&self.ai_account));
        m.insert("kind".into(), Json::Str(self.kind.clone()));
        m.insert("app".into(), Json::Str(self.app().to_string()));
        m.insert("label".into(), Json::Str(self.label.clone()));
        m.insert("scopes".into(), strs(&self.scopes));
        m.insert("sees".into(), strs(&self.sees));
        m.insert("mayRecommend".into(), Json::Bool(self.may_recommend));
        m.insert("mayChange".into(), Json::Bool(self.may_change));
        m.insert("createdAt".into(), Json::Int(self.created_unix));
        m.insert("expiresAt".into(), Json::Int(self.expires_unix));
        let state = if self.state == "on" && self.expires_unix <= now {
            "expired"
        } else {
            self.state.as_str()
        };
        m.insert("state".into(), Json::Str(state.to_string()));
        m.insert("stoppedAt".into(), opt_int(self.disabled_unix));
        m.insert("stoppedBy".into(), opt_str(&self.disabled_by));
        m.insert("stoppedByKind".into(), opt_str(&self.disabled_by_kind));
        m.insert("stoppedReason".into(), opt_str(&self.disabled_reason));
        m.insert("version".into(), Json::Int(self.version as i64));
        Json::Obj(m)
    }
}

fn verified(ring: &KeyRing, row: &tokio_postgres::Row) -> Result<AiKey, AiError> {
    let (key, stored) = AiKey::from_row(row);
    if !crypto::ct_eq(&key.seal(ring), &stored) {
        return Err(AiError::Unverifiable("ai_keys row seal"));
    }
    Ok(key)
}

pub(crate) async fn read_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
    id: &str,
    lock: bool,
) -> Result<Option<AiKey>, AiError> {
    let row = tx
        .query_opt(
            &format!(
                "SELECT {KEY_COLUMNS} FROM ai_keys k \
                 WHERE k.organisation_id = $1 AND k.id = $2{}",
                if lock { " FOR UPDATE OF k" } else { "" }
            ),
            &[&organisation, &id],
        )
        .await?;
    row.as_ref().map(|r| verified(ring, r)).transpose()
}

/// Write `key`'s mutable fields at `key.version`, which the caller has already bumped, with
/// a fresh seal; refuses when the row is no longer at the version before.
async fn write_key(tx: &Transaction<'_>, ring: &KeyRing, key: &AiKey) -> Result<(), AiError> {
    let seal = key.seal(ring);
    let changed = tx
        .execute(
            "UPDATE ai_keys SET label = $3, scopes = $4, sees = $5, may_recommend = $6, \
                 expires_at = to_timestamp($7::bigint), state = $8, changed_seq = $9, \
                 disabled_at = CASE WHEN $10::bigint IS NULL THEN NULL \
                                    ELSE to_timestamp($10::bigint) END, \
                 disabled_by = $11, disabled_by_kind = $12, disabled_reason = $13, \
                 row_version = $14, row_seal = $15, may_change = $16 \
             WHERE organisation_id = $1 AND id = $2 AND row_version = $14 - 1",
            &[
                &key.organisation,
                &key.id,
                &key.label,
                &key.scopes,
                &key.sees,
                &key.may_recommend,
                &key.expires_unix,
                &key.state,
                &key.changed_seq,
                &key.disabled_unix,
                &key.disabled_by,
                &key.disabled_by_kind,
                &key.disabled_reason,
                &key.version,
                &seal.to_vec(),
                &key.may_change,
            ],
        )
        .await?;
    if changed != 1 {
        return Err(AiError::Conflict {
            version: key.version as i64,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/// `Ok(true)` when `auth` holds `needed` on `scope`, `Ok(false)` when it does not, and the
/// error itself for anything that is not a permission answer.
async fn holds(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    scope: Option<ScopeId>,
    needed: Capability,
) -> Result<bool, AiError> {
    match grants::authorise_account(tx, auth, scope, needed).await {
        Ok(_) => Ok(true),
        Err(AuthorityError::NotAuthorised) | Err(AuthorityError::QuorumNotMet { .. }) => Ok(false),
        Err(other) => Err(AiError::Authority(other)),
    }
}

async fn is_steward(tx: &Transaction<'_>, auth: &Authority<'_>) -> Result<bool, AiError> {
    holds(tx, auth, None, Capability::Steward).await
}

fn parse_scope(text: &str) -> Result<ScopeId, AiError> {
    text.parse().map_err(|_| AiError::Unverifiable("scope id"))
}

/// The design's scope and that scope's path, or `None` when there is no such design here.
async fn design_place(
    tx: &Transaction<'_>,
    organisation: &str,
    design: DesignId,
) -> Result<Option<(ScopeId, String)>, AiError> {
    let row = tx
        .query_opt(
            "SELECT d.scope_id, s.path FROM designs d JOIN scopes s ON s.id = d.scope_id \
             WHERE d.id = $1 AND d.organisation_id = $2",
            &[&design.to_string(), &organisation],
        )
        .await?;
    match row {
        None => Ok(None),
        Some(r) => Ok(Some((parse_scope(&r.get::<_, String>(0))?, r.get(1)))),
    }
}

/// Every id in `ids` is a scope of this organisation.
async fn all_scopes_here(
    tx: &Transaction<'_>,
    organisation: &str,
    ids: &[String],
) -> Result<bool, AiError> {
    if ids.is_empty() {
        return Ok(true);
    }
    let row = tx
        .query_one(
            "SELECT count(*) FROM scopes WHERE organisation_id = $1 AND id = ANY($2)",
            &[&organisation, &ids],
        )
        .await?;
    Ok(row.get::<_, i64>(0) == ids.len() as i64)
}

fn clean_ids(raw: &[String], most: usize, what: &'static str) -> Result<Vec<String>, AiError> {
    let mut out = BTreeSet::new();
    for r in raw {
        out.insert(canonical_ulid(r).ok_or(AiError::Malformed(what))?);
    }
    if out.len() > most {
        return Err(AiError::Malformed(what));
    }
    Ok(out.into_iter().collect())
}

// ---------------------------------------------------------------------------
// The organisation's side: overview and policy
// ---------------------------------------------------------------------------

/// What `GET /organisations/{o}/ai` answers: the server switch, the policy, whether the
/// caller may make a key, and the keys the caller may see: their own, or as a Steward every
/// key in the organisation. Any member.
pub async fn overview(tx: &Transaction<'_>, auth: &Authority<'_>) -> Result<Json, AiError> {
    let organisation = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let switch = read_switch(tx, auth.ring).await?;
    let policy = read_policy(tx, auth.ring, &organisation, false).await?;
    let steward = is_steward(tx, auth).await?;
    let rows = tx
        .query(
            &format!(
                "SELECT {KEY_COLUMNS}, \
                    (SELECT max(u.last_at) FROM ai_key_use u WHERE u.key_id = k.id), \
                    (SELECT u.last_from FROM ai_key_use u WHERE u.key_id = k.id \
                       ORDER BY u.day DESC LIMIT 1), \
                    coalesce((SELECT u.requests FROM ai_key_use u WHERE u.key_id = k.id \
                       AND u.day = current_date), 0) \
                 FROM ai_keys k WHERE k.organisation_id = $1 AND k.state <> 'deleted' \
                   AND ($2 OR k.owner = $3) \
                 ORDER BY k.created_at, k.id"
            ),
            &[&organisation, &steward, &me],
        )
        .await?;
    let now = now_unix();
    let mut keys = Vec::new();
    for row in &rows {
        let key = verified(auth.ring, row)?;
        let Json::Obj(mut m) = key.to_json(now) else {
            unreachable!("a key renders as an object")
        };
        let last: Option<std::time::SystemTime> = row.get(KEY_COLUMN_COUNT);
        m.insert(
            "lastUsedAt".into(),
            opt_int(last.and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|d| d.as_secs() as i64)
            })),
        );
        m.insert(
            "lastUsedFrom".into(),
            opt_str(&row.get(KEY_COLUMN_COUNT + 1)),
        );
        m.insert(
            "requestsToday".into(),
            Json::Int(row.get::<_, i32>(KEY_COLUMN_COUNT + 2) as i64),
        );
        m.insert("mine".into(), Json::Bool(key.owner == me));
        keys.push(Json::Obj(m));
    }
    let mut m = BTreeMap::new();
    m.insert("server".into(), switch.to_json());
    // Who else may make keys, and which Steward set this, is for Stewards to see.
    let mut shown = policy.clone();
    if !steward {
        shown.makers.retain(|a| *a == me);
        shown.changed_by = None;
    }
    m.insert("policy".into(), shown.to_json());
    m.insert("steward".into(), Json::Bool(steward));
    m.insert(
        "canMake".into(),
        Json::Bool(switch.allowed && policy.allowed && policy.makers.contains(&me)),
    );
    m.insert("keys".into(), Json::Arr(keys));
    Ok(Json::Obj(m))
}

/// What a Steward sets.
pub struct PolicyInput {
    pub allowed: bool,
    pub makers: Vec<String>,
    pub ceiling: Vec<String>,
    pub max_days: i32,
    pub second_person_scopes: Vec<String>,
    pub apps: Vec<String>,
    pub may_change: bool,
}

/// One spelling of a policy's apps: known names only, each once, in [`APPS`] order.
pub fn clean_apps(apps: &[String]) -> Result<Vec<String>, AiError> {
    if apps.iter().any(|a| !APPS.contains(&a.as_str())) {
        return Err(AiError::Malformed(
            "the apps are claude, claude-code and other",
        ));
    }
    Ok(APPS
        .iter()
        .filter(|a| apps.iter().any(|x| x == *a))
        .map(|a| a.to_string())
        .collect())
}

/// Set the organisation's policy. Steward on the organisation. `if_version` is `0` for the
/// first. Narrowing the ceiling, shortening the longest life or removing a maker takes effect
/// at every key's next request; nothing here rewrites a key.
pub async fn set_policy(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    input: PolicyInput,
    if_version: i32,
) -> Result<Policy, AiError> {
    grants::authorise_account(tx, auth, None, Capability::Steward).await?;
    let organisation = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let makers = clean_ids(&input.makers, MAX_MAKERS, "makers are account ids")?;
    let second = clean_ids(
        &input.second_person_scopes,
        MAX_SECOND_PERSON_SCOPES,
        "folders are scope ids",
    )?;
    let ceiling = clean_sees(&input.ceiling)?;
    let apps = clean_apps(&input.apps)?;
    if !DAYS.contains(&input.max_days) {
        return Err(AiError::Malformed(
            "the longest a key lasts is 30, 90 or 365 days",
        ));
    }
    if !makers.is_empty() {
        let row = tx
            .query_one(
                "SELECT count(*) FROM memberships WHERE organisation_id = $1 AND account_id = ANY($2)",
                &[&organisation, &makers],
            )
            .await?;
        if row.get::<_, i64>(0) != makers.len() as i64 {
            return Err(AiError::Malformed(
                "every maker is a member of this organisation",
            ));
        }
    }
    if !all_scopes_here(tx, &organisation, &second).await? {
        return Err(AiError::Malformed(
            "every folder is a folder of this organisation",
        ));
    }

    let current = read_policy(tx, auth.ring, &organisation, true).await?;
    if current.version != if_version {
        return Err(AiError::Conflict {
            version: current.version as i64,
        });
    }
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::AiPolicyChanged,
        &metadata(
            EntryType::AiPolicyChanged,
            &[
                ("allowed", Json::Bool(input.allowed)),
                ("makers", strs(&makers)),
                ("ceiling", strs(&ceiling)),
                ("max_days", Json::Int(input.max_days as i64)),
                ("second_person_scopes", strs(&second)),
                ("apps", strs(&apps)),
                ("may_change", Json::Bool(input.may_change)),
                ("by", Json::Str(me.clone())),
            ],
        ),
    )
    .await?;
    let next = Policy {
        allowed: input.allowed,
        makers,
        ceiling,
        max_days: input.max_days,
        second_person_scopes: second,
        apps,
        may_change: input.may_change,
        changed_by: Some(me.clone()),
        changed_unix: Some(now_unix()),
        changed_seq: appended.seq,
        version: current.version + 1,
    };
    let seal = next.seal(auth.ring, &organisation).to_vec();
    let changed = if current.version == 0 {
        tx.execute(
            "INSERT INTO ai_policies (organisation_id, allowed, makers, ceiling, max_days, \
                 second_person_scopes, changed_by, changed_seq, row_version, row_seal, apps, \
                 may_change) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
            &[
                &organisation,
                &next.allowed,
                &next.makers,
                &next.ceiling,
                &next.max_days,
                &next.second_person_scopes,
                &me,
                &next.changed_seq,
                &next.version,
                &seal,
                &next.apps,
                &next.may_change,
            ],
        )
        .await?
    } else {
        tx.execute(
            "UPDATE ai_policies SET allowed = $2, makers = $3, ceiling = $4, max_days = $5, \
                 second_person_scopes = $6, changed_by = $7, changed_at = now(), \
                 changed_seq = $8, row_version = $9, row_seal = $10, apps = $11, \
                 may_change = $12 \
             WHERE organisation_id = $1 AND row_version = $9 - 1",
            &[
                &organisation,
                &next.allowed,
                &next.makers,
                &next.ceiling,
                &next.max_days,
                &next.second_person_scopes,
                &me,
                &next.changed_seq,
                &next.version,
                &seal,
                &next.apps,
                &next.may_change,
            ],
        )
        .await?
    };
    if changed != 1 {
        return Err(AiError::Conflict {
            version: current.version as i64,
        });
    }
    Ok(next)
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// What a person asks for when they make a key.
pub struct NewKey {
    pub public_key: Vec<u8>,
    pub label: String,
    /// The AI account the app is signed in to, as the person gives it.
    pub ai_account: String,
    pub scopes: Vec<String>,
    pub sees: Vec<String>,
    pub may_recommend: bool,
    /// Ticked "May change designs" (ADR-0077 decision 1).
    pub may_change: bool,
    pub days: i32,
}

/// Register the public half of a key the person's own computer made. The caller must be
/// one of the organisation's makers, AI must be on here and on the server, every folder
/// named must be one the caller can read, and the key may see no more than the ceiling and
/// last no longer than the organisation allows.
pub async fn make_key(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    input: NewKey,
) -> Result<AiKey, AiError> {
    if input.public_key.len() != 65
        || input.public_key[0] != 0x04
        || p256::ecdsa::VerifyingKey::from_sec1_bytes(&input.public_key).is_err()
    {
        return Err(AiError::Malformed(
            "that is not a key the Fathom AI helper made (an uncompressed P-256 public key)",
        ));
    }
    let id = key_id_of(&input.public_key);
    register(
        tx,
        auth,
        Registration {
            id,
            kind: "helper",
            public_key: Some(input.public_key),
            client_id: None,
            label: input.label,
            ai_account: input.ai_account,
            scopes: input.scopes,
            sees: input.sees,
            may_recommend: input.may_recommend,
            may_change: input.may_change,
            days: input.days,
        },
    )
    .await
}

/// What a person chose on the connector sign-in page (ADR-0072 decision 14).
pub struct NewConnector {
    /// The app's client id, already checked against the pinned apps or a registration.
    pub client_id: String,
    pub label: String,
    /// The AI account the app is signed in to, as the person gives it.
    pub ai_account: String,
    pub scopes: Vec<String>,
    pub sees: Vec<String>,
    pub may_recommend: bool,
    /// Ticked "May change designs" (ADR-0077 decision 1).
    pub may_change: bool,
    pub days: i32,
}

/// Make the grant a connector sign-in asks for: the same rules as [`make_key`], plus the
/// organisation's choice of apps. A person signing the same app in again replaces their
/// earlier grant for it, so an app that signs in afresh does not pile up live grants.
pub(crate) async fn make_connector(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    input: NewConnector,
) -> Result<AiKey, AiError> {
    let organisation = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let app = crate::oauth::app_of(&input.client_id);
    let policy = read_policy(tx, auth.ring, &organisation, false).await?;
    if policy.allowed && !policy.apps.iter().any(|a| a == app) {
        return Err(AiError::NotAllowed(
            "this organisation does not let that app connect",
        ));
    }
    let earlier = tx
        .query(
            &format!(
                "SELECT {KEY_COLUMNS} FROM ai_keys k WHERE k.organisation_id = $1 \
                   AND k.owner = $2 AND k.client_id = $3 AND k.state = 'on' \
                 ORDER BY k.id"
            ),
            &[&organisation, &me, &input.client_id],
        )
        .await?;
    for row in &earlier {
        let key = verified(auth.ring, row)?;
        stop_key(
            tx,
            auth,
            &key.id,
            key.version,
            Some("Replaced by a new sign-in from the same app.".to_string()),
            false,
        )
        .await?;
    }
    register(
        tx,
        auth,
        Registration {
            id: crate::ids::new_ulid().to_string(),
            kind: "connector",
            public_key: None,
            client_id: Some(input.client_id),
            label: input.label,
            ai_account: input.ai_account,
            scopes: input.scopes,
            sees: input.sees,
            may_recommend: input.may_recommend,
            may_change: input.may_change,
            days: input.days,
        },
    )
    .await
}

struct Registration {
    id: String,
    kind: &'static str,
    public_key: Option<Vec<u8>>,
    client_id: Option<String>,
    label: String,
    ai_account: String,
    scopes: Vec<String>,
    sees: Vec<String>,
    may_recommend: bool,
    may_change: bool,
    days: i32,
}

async fn register(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    input: Registration,
) -> Result<AiKey, AiError> {
    let organisation = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    if !read_switch(tx, auth.ring).await?.allowed {
        return Err(AiError::SiteOff);
    }
    let policy = read_policy(tx, auth.ring, &organisation, false).await?;
    if !policy.allowed {
        return Err(AiError::NotAllowed("AI access is off in this organisation"));
    }
    if !policy.makers.contains(&me) {
        return Err(AiError::NotAllowed(
            "only the people a Steward named may make AI keys here",
        ));
    }
    let label = clean_line(&input.label, MAX_LABEL_CHARS, false)?;
    let ai_account = clean_account(&input.ai_account)?;
    let scopes = clean_ids(&input.scopes, MAX_KEY_SCOPES, "folders are scope ids")?;
    let sees = clean_sees(&input.sees)?;
    if !is_subset(&sees, &policy.ceiling) {
        return Err(AiError::NotAllowed(
            "this organisation does not let a key see that much",
        ));
    }
    if input.may_change && !policy.may_change {
        return Err(AiError::NotAllowed(
            "this organisation does not let AI apps change designs",
        ));
    }
    if !DAYS.contains(&input.days) || input.days > policy.max_days {
        return Err(AiError::NotAllowed(
            "a key lasts 30, 90 or 365 days, and no longer than this organisation allows",
        ));
    }
    if !all_scopes_here(tx, &organisation, &scopes).await? {
        return Err(AiError::Malformed(
            "every folder is a folder of this organisation",
        ));
    }
    for s in &scopes {
        if !holds(tx, auth, Some(parse_scope(s)?), Capability::Read).await? {
            return Err(AiError::NotAllowed(
                "a key can only reach folders you can read yourself",
            ));
        }
    }
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        &[&format!("ai_keys:{organisation}:{me}")],
    )
    .await?;
    let live = tx
        .query_one(
            "SELECT count(*) FROM ai_keys WHERE organisation_id = $1 AND owner = $2 \
               AND state = 'on' AND expires_at > now()",
            &[&organisation, &me],
        )
        .await?
        .get::<_, i64>(0);
    if live >= MAX_KEYS_PER_OWNER {
        return Err(AiError::NotAllowed(
            "you already have 10 AI keys on here; stop one first",
        ));
    }
    let id = input.id;
    let taken = tx
        .query_opt("SELECT 1 FROM ai_key_directory WHERE key_id = $1", &[&id])
        .await?;
    if taken.is_some() {
        return Err(AiError::NotAllowed(
            "that key is already registered; run the helper's pair step again for a new one",
        ));
    }

    let now = now_unix();
    let expires = now + input.days as i64 * 86_400;
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::AiKeyMade,
        &metadata(
            EntryType::AiKeyMade,
            &[
                ("key", Json::Str(id.clone())),
                ("owner", Json::Str(me.clone())),
                ("kind", Json::Str(input.kind.to_string())),
                ("client", opt_str(&input.client_id)),
                ("scopes", strs(&scopes)),
                ("sees", strs(&sees)),
                ("may_recommend", Json::Bool(input.may_recommend)),
                ("may_change", Json::Bool(input.may_change)),
                ("expires", Json::Int(expires)),
            ],
        ),
    )
    .await?;
    let key = AiKey {
        organisation: organisation.clone(),
        id: id.clone(),
        owner: me.clone(),
        owner_name: String::new(),
        kind: input.kind.to_string(),
        public_key: input.public_key,
        client_id: input.client_id,
        label,
        scopes,
        sees,
        may_recommend: input.may_recommend,
        created_unix: now,
        created_seq: appended.seq,
        expires_unix: expires,
        state: "on".into(),
        changed_seq: appended.seq,
        disabled_unix: None,
        disabled_by: None,
        disabled_by_kind: None,
        disabled_reason: None,
        version: 1,
        ai_account: Some(ai_account),
        owner_email: String::new(),
        may_change: input.may_change,
    };
    tx.execute(
        "INSERT INTO ai_keys (organisation_id, id, owner, kind, public_key, client_id, label, \
             scopes, sees, may_recommend, created_at, created_seq, expires_at, state, \
             changed_seq, row_version, row_seal, ai_account, may_change) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11::bigint), $12, \
                 to_timestamp($13::bigint), 'on', $12, 1, $14, $15, $16)",
        &[
            &key.organisation,
            &key.id,
            &key.owner,
            &key.kind,
            &key.public_key,
            &key.client_id,
            &key.label,
            &key.scopes,
            &key.sees,
            &key.may_recommend,
            &key.created_unix,
            &key.created_seq,
            &key.expires_unix,
            &key.seal(auth.ring).to_vec(),
            &key.ai_account,
            &key.may_change,
        ],
    )
    .await?;
    tx.execute(
        "INSERT INTO ai_key_directory (key_id, organisation_id) VALUES ($1, $2)",
        &[&id, &organisation],
    )
    .await?;
    read_key(tx, auth.ring, &organisation, &id, false)
        .await?
        .ok_or(AiError::Unverifiable("a key just written"))
}

/// A change to a key that is on. `None` leaves a field as it is.
#[derive(Default)]
pub struct KeyChange {
    pub label: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub sees: Option<Vec<String>>,
    pub may_recommend: Option<bool>,
    pub may_change: Option<bool>,
    /// End the key this many days from now, if that is sooner than its end.
    pub ends_in_days: Option<i32>,
}

/// Change what a key may do (decision 5). Its owner widens or narrows, within what the
/// organisation allows and what they can read themselves; a Steward who is not the owner
/// may only narrow. Nobody moves a key's end later. On the organisation chain.
pub async fn change_key(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
    change: KeyChange,
    if_version: i32,
) -> Result<AiKey, AiError> {
    let organisation = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let mut key = read_key(tx, auth.ring, &organisation, id, true)
        .await?
        .ok_or(AiError::NotFound)?;
    let owner = key.owner == me;
    let steward = is_steward(tx, auth).await?;
    if !owner && !steward {
        return Err(AiError::NotFound);
    }
    if key.version != if_version {
        return Err(AiError::Conflict {
            version: key.version as i64,
        });
    }
    let now = now_unix();
    if !key.is_live(now) {
        return Err(AiError::NotAllowed(
            "a stopped or expired key does not change",
        ));
    }

    let mut widens = false;
    if let Some(label) = change.label {
        let label = clean_line(&label, MAX_LABEL_CHARS, false)?;
        if label != key.label && !owner {
            return Err(AiError::NotAllowed("only the key's owner renames it"));
        }
        key.label = label;
    }
    if let Some(scopes) = change.scopes {
        let scopes = clean_ids(&scopes, MAX_KEY_SCOPES, "folders are scope ids")?;
        if !all_scopes_here(tx, &organisation, &scopes).await? {
            return Err(AiError::Malformed(
                "every folder is a folder of this organisation",
            ));
        }
        if !scopes_narrow(&key.scopes, &scopes) {
            widens = true;
            for s in scopes.iter().filter(|s| !key.scopes.contains(s)) {
                if owner && !holds(tx, auth, Some(parse_scope(s)?), Capability::Read).await? {
                    return Err(AiError::NotAllowed(
                        "a key can only reach folders you can read yourself",
                    ));
                }
            }
        }
        key.scopes = scopes;
    }
    if let Some(sees) = change.sees {
        let sees = clean_sees(&sees)?;
        if !is_subset(&sees, &key.sees) {
            widens = true;
        }
        key.sees = sees;
    }
    if let Some(may) = change.may_recommend {
        if may && !key.may_recommend {
            widens = true;
        }
        key.may_recommend = may;
    }
    if let Some(may) = change.may_change {
        if may && !key.may_change {
            widens = true;
        }
        key.may_change = may;
    }
    if let Some(days) = change.ends_in_days {
        if !(0..=365).contains(&days) {
            return Err(AiError::Malformed("a key ends 0 to 365 days from now"));
        }
        key.expires_unix = key.expires_unix.min(now + days as i64 * 86_400);
        if key.expires_unix <= key.created_unix {
            key.expires_unix = key.created_unix + 1;
        }
    }
    if widens {
        if !owner {
            return Err(AiError::NotAllowed(
                "a Steward can narrow someone's key or stop it, never widen it",
            ));
        }
        let policy = read_policy(tx, auth.ring, &organisation, false).await?;
        if !policy.allowed || !policy.makers.contains(&me) {
            return Err(AiError::NotAllowed(
                "only the people a Steward named may widen an AI key here",
            ));
        }
        if !is_subset(&key.sees, &policy.ceiling) {
            return Err(AiError::NotAllowed(
                "this organisation does not let a key see that much",
            ));
        }
        if key.may_change && !policy.may_change {
            return Err(AiError::NotAllowed(
                "this organisation does not let AI apps change designs",
            ));
        }
    }

    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::AiKeyChanged,
        &metadata(
            EntryType::AiKeyChanged,
            &[
                ("key", Json::Str(key.id.clone())),
                ("by", Json::Str(me.clone())),
                (
                    "by_kind",
                    Json::Str(if owner { "owner" } else { "steward" }.into()),
                ),
                ("widened", Json::Bool(widens)),
                ("scopes", strs(&key.scopes)),
                ("sees", strs(&key.sees)),
                ("may_recommend", Json::Bool(key.may_recommend)),
                ("may_change", Json::Bool(key.may_change)),
                ("expires", Json::Int(key.expires_unix)),
            ],
        ),
    )
    .await?;
    key.changed_seq = appended.seq;
    key.version += 1;
    write_key(tx, auth.ring, &key).await?;
    read_key(tx, auth.ring, &organisation, id, false)
        .await?
        .ok_or(AiError::Unverifiable("a key just written"))
}

/// Stop a key: disable it, or delete it (a disabled key can still be deleted). Its owner or
/// a Steward; a Steward who is not the owner says why, and the owner sees it. A stopped key
/// never comes back on: the person makes a new one. On the organisation chain.
pub async fn stop_key(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
    if_version: i32,
    reason: Option<String>,
    delete: bool,
) -> Result<AiKey, AiError> {
    let organisation = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let mut key = read_key(tx, auth.ring, &organisation, id, true)
        .await?
        .ok_or(AiError::NotFound)?;
    let owner = key.owner == me;
    let steward = is_steward(tx, auth).await?;
    if !owner && !steward {
        return Err(AiError::NotFound);
    }
    if key.version != if_version {
        return Err(AiError::Conflict {
            version: key.version as i64,
        });
    }
    let reason = match reason {
        Some(r) => Some(clean_line(&r, MAX_REASON_CHARS, false)?).filter(|r| !r.is_empty()),
        None => None,
    };
    if !owner && reason.is_none() && key.state == "on" {
        return Err(AiError::Malformed(
            "say why you are stopping someone else's key; they will see it",
        ));
    }
    match (key.state.as_str(), delete) {
        ("on", _) => {
            key.disabled_unix = Some(now_unix());
            key.disabled_by = Some(me.clone());
            key.disabled_by_kind = Some(if owner { "owner" } else { "steward" }.into());
            key.disabled_reason = reason;
            key.state = if delete { "deleted" } else { "disabled" }.into();
        }
        ("disabled", true) => key.state = "deleted".into(),
        _ => return Err(AiError::NotAllowed("that key is already stopped")),
    }
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::AiKeyDisabled,
        &metadata(
            EntryType::AiKeyDisabled,
            &[
                ("key", Json::Str(key.id.clone())),
                ("owner", Json::Str(key.owner.clone())),
                ("by", Json::Str(me.clone())),
                (
                    "by_kind",
                    Json::Str(if owner { "owner" } else { "steward" }.into()),
                ),
                ("deleted", Json::Bool(delete)),
            ],
        ),
    )
    .await?;
    key.changed_seq = appended.seq;
    key.version += 1;
    write_key(tx, auth.ring, &key).await?;
    read_key(tx, auth.ring, &organisation, id, false)
        .await?
        .ok_or(AiError::Unverifiable("a key just written"))
}

// ---------------------------------------------------------------------------
// The operator's side
// ---------------------------------------------------------------------------

/// Every key on the server, with no design data: which organisation, whose, what it may
/// do, whether it is on, when it was last used. The caller has already entered operator
/// custody and checked the operator is live (`operators::OperatorStore::ai_overview`).
pub(crate) async fn operator_overview(
    tx: &Transaction<'_>,
    ring: &KeyRing,
) -> Result<Json, AiError> {
    let switch = read_switch(tx, ring).await?;
    let rows = tx
        .query(
            &format!(
                "SELECT {KEY_COLUMNS}, \
                    (SELECT extract(epoch FROM max(u.last_at))::bigint FROM ai_key_use u \
                      WHERE u.key_id = k.id) \
                 FROM ai_keys k WHERE k.state <> 'deleted' \
                 ORDER BY k.organisation_id, k.created_at, k.id"
            ),
            &[],
        )
        .await?;
    let now = now_unix();
    let mut keys = Vec::new();
    for row in &rows {
        let (key, stored) = AiKey::from_row(row);
        let Json::Obj(mut m) = key.to_json(now) else {
            unreachable!("a key renders as an object")
        };
        // The label is the owner's words about their own app; the operator plane sees ids.
        m.remove("label");
        m.insert("organisation".into(), Json::Str(key.organisation.clone()));
        m.insert(
            "verifies".into(),
            Json::Bool(crypto::ct_eq(&key.seal(ring), &stored)),
        );
        m.insert("lastUsedAt".into(), opt_int(row.get(KEY_COLUMN_COUNT)));
        keys.push(Json::Obj(m));
    }
    let mut m = BTreeMap::new();
    m.insert("server".into(), switch.to_json());
    m.insert("keys".into(), Json::Arr(keys));
    Ok(Json::Obj(m))
}

/// Turn AI on or off for the whole server. Off stops every key at its next request and
/// stops new ones being made; on gives nothing back that an organisation had not turned on.
/// On the site chain. The caller holds operator custody.
pub(crate) async fn operator_set_switch(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    operator: &str,
    allowed: bool,
    reason: Option<String>,
    if_version: i32,
) -> Result<Switch, AiError> {
    let reason = match reason {
        Some(r) => Some(clean_line(&r, MAX_REASON_CHARS, false)?).filter(|r| !r.is_empty()),
        None => None,
    };
    let current = read_switch(tx, ring).await?;
    if current.version != if_version {
        return Err(AiError::Conflict {
            version: current.version as i64,
        });
    }
    let appended = chains::append_site(
        tx,
        ring,
        deployment,
        EntryType::AiSwitchChanged,
        &metadata(
            EntryType::AiSwitchChanged,
            &[
                ("allowed", Json::Bool(allowed)),
                ("operator", Json::Str(operator.to_string())),
                ("reason", opt_str(&reason)),
            ],
        ),
    )
    .await?;
    let next = Switch {
        allowed,
        reason,
        changed_by: Some(operator.to_string()),
        changed_unix: Some(now_unix()),
        changed_seq: appended.seq,
        version: current.version + 1,
    };
    let seal = next.seal(tx, ring).await?.to_vec();
    let changed = if current.version == 0 {
        tx.execute(
            "INSERT INTO ai_site_switch (id, allowed, reason, changed_by, changed_seq, \
                 row_version, row_seal) VALUES ('site', $1, $2, $3, $4, $5, $6)",
            &[
                &next.allowed,
                &next.reason,
                &operator,
                &next.changed_seq,
                &next.version,
                &seal,
            ],
        )
        .await?
    } else {
        tx.execute(
            "UPDATE ai_site_switch SET allowed = $1, reason = $2, changed_by = $3, \
                 changed_at = now(), changed_seq = $4, row_version = $5, row_seal = $6 \
             WHERE id = 'site' AND row_version = $5 - 1",
            &[
                &next.allowed,
                &next.reason,
                &operator,
                &next.changed_seq,
                &next.version,
                &seal,
            ],
        )
        .await?
    };
    if changed != 1 {
        return Err(AiError::Conflict {
            version: current.version as i64,
        });
    }
    Ok(next)
}

/// Stop one key in one organisation, with a reason the owner and the Stewards see. Filed on
/// both chains, as an operator's grant suspension is. The database lets the operator plane
/// make this one move and no other (`0046`'s trigger). The caller holds operator custody;
/// this points it at the organisation, which leaves `app.design_capability` at its refusal.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn operator_disable_key(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    operator: &str,
    session: &str,
    organisation: &str,
    id: &str,
    reason: &str,
) -> Result<(), AiError> {
    let reason = clean_line(reason, MAX_REASON_CHARS, false)?;
    repo::enter_operator_tenant_scope(tx, organisation).await?;
    let mut key = read_key(tx, ring, organisation, id, true)
        .await?
        .ok_or(AiError::NotFound)?;
    if key.state != "on" {
        return Err(AiError::NotAllowed("that key is already stopped"));
    }
    let tenant_key = keys::tenant_key_for(tx, ring, organisation).await?;
    let appended = chains::append_org_as(
        tx,
        ring,
        organisation,
        operator,
        &tenant_key,
        EntryType::AiKeyDisabled,
        &metadata(
            EntryType::AiKeyDisabled,
            &[
                ("key", Json::Str(key.id.clone())),
                ("owner", Json::Str(key.owner.clone())),
                ("by", Json::Str(operator.to_string())),
                ("by_kind", Json::Str("operator".into())),
                ("deleted", Json::Bool(false)),
                ("reason", Json::Str(reason.clone())),
            ],
        ),
    )
    .await?;
    key.disabled_unix = Some(now_unix());
    key.disabled_by = Some(operator.to_string());
    key.disabled_by_kind = Some("operator".into());
    key.disabled_reason = Some(reason);
    key.state = "disabled".into();
    key.changed_seq = appended.seq;
    key.version += 1;
    write_key(tx, ring, &key).await?;
    chains::append_site(
        tx,
        ring,
        deployment,
        EntryType::AiKeyDisabled,
        &metadata(
            EntryType::AiKeyDisabled,
            &[
                ("key", Json::Str(key.id.clone())),
                ("organisation", Json::Str(organisation.to_string())),
                ("operator", Json::Str(operator.to_string())),
                ("session", Json::Str(session.to_string())),
                ("actor_kind", Json::Str("operator".into())),
            ],
        ),
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The AI's side: verifying a request
// ---------------------------------------------------------------------------

/// One AI request as it arrived.
pub struct AiRequest<'a> {
    pub key_id: &'a str,
    pub unix: i64,
    pub nonce: [u8; 32],
    pub signature: [u8; 64],
    pub method: &'a str,
    pub path: &'a str,
    pub body: &'a [u8],
}

/// A request whose signature verified and whose nonce is spent. Private fields and one
/// maker, [`verify_request`]; it can open a tenant context through [`open`] and nothing
/// else, and it is not a `sessions::VerifiedSession` and cannot become one.
pub struct VerifiedAi {
    organisation: String,
    key_id: String,
    owner: String,
    address: String,
    /// `helper` from [`verify_request`], `connector` from `oauth::verify_bearer`: [`open`]
    /// refuses a key used the other way.
    kind: &'static str,
}

impl VerifiedAi {
    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    /// Only `oauth::verify_bearer` makes one this way, after the token's hash, its expiry,
    /// the key's seal and the key's state have been checked.
    pub(crate) fn for_connector(
        organisation: String,
        key_id: String,
        owner: String,
        address: &str,
    ) -> Self {
        Self {
            organisation,
            key_id,
            owner,
            address: address.chars().take(64).collect(),
            kind: "connector",
        }
    }
}

/// Verify an AI request in its own transaction and commit the spent nonce, so a request
/// refused later still cannot be replayed. See the module doc for the order.
pub async fn verify_request(
    pool: &Pool,
    ring: &KeyRing,
    request: &AiRequest<'_>,
    address: &str,
) -> Result<VerifiedAi, AiError> {
    let now = now_unix();
    if (now - request.unix).abs() > WINDOW_SECS {
        return Err(AiError::Clock);
    }
    let key_id = canonical_ulid(request.key_id).ok_or(AiError::Refused)?;

    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    tx.execute("SELECT set_config('app.ai_custody', 'yes', true)", &[])
        .await?;
    if !read_switch(&tx, ring).await?.allowed {
        return Err(AiError::SiteOff);
    }
    let organisation: String = tx
        .query_opt(
            "SELECT organisation_id FROM ai_key_directory WHERE key_id = $1",
            &[&key_id],
        )
        .await?
        .ok_or(AiError::Refused)?
        .get(0);
    // The key row is the organisation's: point the policies at it, with no account and the
    // design capability at its refusal, to read the one row that says whose key this is.
    repo::set_custody_tenant(&tx, &organisation).await?;
    let key = read_key(&tx, ring, &organisation, &key_id, false)
        .await?
        .ok_or(AiError::Refused)?;
    if !key.is_live(now) {
        return Err(AiError::Refused);
    }
    let deployment: String = tx
        .query_opt("SELECT id FROM deployments", &[])
        .await?
        .ok_or(AiError::Unverifiable("no deployment row"))?
        .get(0);
    let message = request_bytes(
        &deployment,
        &key_id,
        request.method,
        request.path,
        request.body,
        &request.nonce,
        request.unix,
    );
    // A connector's grant has no public half and is never used through a signature.
    let Some(public_key) = &key.public_key else {
        return Err(AiError::Refused);
    };
    if authority::verify_es256(public_key, &message, &request.signature).is_err() {
        return Err(AiError::Refused);
    }

    spend(&tx, &key_id, &request.nonce, request.unix + WINDOW_SECS + 1).await?;
    tx.execute("SELECT set_config('app.ai_custody', 'no', true)", &[])
        .await?;
    tx.commit().await?;
    Ok(VerifiedAi {
        organisation,
        key_id,
        owner: key.owner,
        address: address.chars().take(64).collect(),
        kind: "helper",
    })
}

/// Count one request against the key's [`REQUESTS_PER_WINDOW`] and spend its nonce, which
/// may not have been spent before. A connector's request has no nonce of its own, so
/// `oauth::verify_bearer` spends a random one: the same window, the same limit. Under
/// `app.ai_custody`.
pub(crate) async fn spend(
    tx: &Transaction<'_>,
    key_id: &str,
    nonce: &[u8; 32],
    forget_after_unix: i64,
) -> Result<(), AiError> {
    tx.execute(
        "DELETE FROM ai_request_nonces WHERE key_id = $1 AND expires_at < now()",
        &[&key_id],
    )
    .await?;
    let recent = tx
        .query_one(
            "SELECT count(*) FROM ai_request_nonces WHERE key_id = $1",
            &[&key_id],
        )
        .await?
        .get::<_, i64>(0);
    if recent >= REQUESTS_PER_WINDOW {
        return Err(AiError::Limited);
    }
    let spent = tx
        .execute(
            "INSERT INTO ai_request_nonces (key_id, nonce_hash, expires_at) \
             VALUES ($1, $2, to_timestamp($3::bigint)) ON CONFLICT DO NOTHING",
            &[&key_id, &nonce_hash(key_id, nonce), &forget_after_unix],
        )
        .await?;
    if spent != 1 {
        return Err(AiError::Refused);
    }
    Ok(())
}

/// What a handler on the AI router works with: the owner's tenant context and the key and
/// policy as they stand in this transaction.
pub struct AiSession {
    pub ctx: repo::TenantContext,
    pub tenant_key: keys::DataKey,
    pub key: AiKey,
    pub policy: Policy,
}

/// Open the owner's tenant context for a verified request, re-reading everything that
/// could have changed since [`verify_request`] committed, and count the use.
pub async fn open(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    verified: &VerifiedAi,
) -> Result<AiSession, AiError> {
    tx.execute(
        "SELECT set_config('app.design_capability', 'no', true)",
        &[],
    )
    .await?;
    if !read_switch(tx, ring).await?.allowed {
        return Err(AiError::SiteOff);
    }
    let tenant: OrganisationId = verified
        .organisation
        .parse()
        .map_err(|_| AiError::Unverifiable("organisation id"))?;
    let owner: AccountId = verified
        .owner
        .parse()
        .map_err(|_| AiError::Unverifiable("account id"))?;
    let ctx = match repo::open_tenant_context(tx, tenant, owner).await {
        Ok(ctx) => ctx,
        Err(RepoError::NotAMember) => return Err(AiError::Refused),
        Err(e) => return Err(e.into()),
    };
    let key = read_key(tx, ring, &verified.organisation, &verified.key_id, false)
        .await?
        .ok_or(AiError::Refused)?;
    if !key.is_live(now_unix()) || key.owner != verified.owner {
        return Err(AiError::Refused);
    }
    let policy = read_policy(tx, ring, &verified.organisation, false).await?;
    if !policy.allowed || !policy.makers.contains(&key.owner) {
        return Err(AiError::OrganisationOff);
    }
    if key.kind != verified.kind {
        return Err(AiError::Refused);
    }
    if key.kind == "connector" && !policy.apps.iter().any(|a| a == key.app()) {
        return Err(AiError::OrganisationOff);
    }
    let tenant_key = keys::tenant_key(tx, ring, &ctx).await?;
    tx.execute(
        "INSERT INTO ai_key_use (organisation_id, key_id, day, requests, last_at, last_from) \
         VALUES ($1, $2, current_date, 1, now(), $3) \
         ON CONFLICT (key_id, day) DO UPDATE \
           SET requests = ai_key_use.requests + 1, last_at = now(), last_from = $3",
        &[&verified.organisation, &verified.key_id, &verified.address],
    )
    .await?;
    Ok(AiSession {
        ctx,
        tenant_key,
        key,
        policy,
    })
}

/// What the key sees at this moment: its own tiers, cut to the organisation's ceiling.
pub fn tiers(key: &AiKey, policy: &Policy) -> BTreeSet<Tier> {
    let mut out: BTreeSet<Tier> = key
        .sees
        .iter()
        .filter(|s| policy.ceiling.contains(s))
        .filter_map(|s| Tier::parse(s))
        .collect();
    out.insert(Tier::Layout);
    out
}

/// Whether this connection may change designs now: its own tick and its organisation's
/// (ADR-0077 decision 1).
pub fn may_change(session: &AiSession) -> bool {
    session.key.may_change && session.policy.may_change
}

/// `GET /ai/v1/whoami`: what this key is, so the app can tell its person.
pub fn whoami(session: &AiSession) -> Json {
    let mut m = BTreeMap::new();
    m.insert(
        "organisation".into(),
        Json::Str(session.ctx.tenant().to_string()),
    );
    m.insert("key".into(), Json::Str(session.key.id.clone()));
    m.insert("label".into(), Json::Str(session.key.label.clone()));
    m.insert("owner".into(), Json::Str(session.key.owner.clone()));
    m.insert(
        "sees".into(),
        Json::Arr(
            tiers(&session.key, &session.policy)
                .iter()
                .map(|t| Json::Str(t.as_str().to_string()))
                .collect(),
        ),
    );
    m.insert("scopes".into(), strs(&session.key.scopes));
    m.insert("mayRecommend".into(), Json::Bool(session.key.may_recommend));
    m.insert("mayChange".into(), Json::Bool(may_change(session)));
    m.insert("expiresAt".into(), Json::Int(session.key.expires_unix));
    m.insert("readOnly".into(), Json::Bool(!may_change(session)));
    Json::Obj(m)
}

/// ADR-0074 §8: where a design sits, as its folders root first (site, building, closet), each
/// with its kind of place and hand-set role. Only a folder this key reaches **and** its owner
/// may read is named: an ancestor above the key's folders is left out, as `/scopes` leaves out
/// one its caller cannot read, so a reading never names a place the key was not given.
async fn folder_chain(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    verified: &grants::VerifiedAuthorityState,
    key: &AiKey,
    path: &str,
) -> Result<Json, AiError> {
    let ids: Vec<String> = path.split('.').map(str::to_string).collect();
    let rows = tx
        .query(
            "SELECT id, kind, display_name, path, place_form, place_role FROM scopes \
             WHERE organisation_id = $1 AND id = ANY($2) ORDER BY depth",
            &[&auth.ctx.tenant().to_string(), &ids],
        )
        .await?;
    let mut out = Vec::new();
    for row in rows {
        let id: String = row.get(0);
        let folder_path: String = row.get(3);
        if !covers(&key.scopes, &folder_path) {
            continue;
        }
        match grants::authorise_in_verified_state(
            tx,
            auth,
            verified,
            Some(parse_scope(&id)?),
            Capability::Read,
        )
        .await
        {
            Ok(_) => {}
            Err(AuthorityError::NotAuthorised) | Err(AuthorityError::QuorumNotMet { .. }) => {
                continue
            }
            Err(other) => return Err(other.into()),
        }
        let kind: String = row.get(1);
        let level = match kind.as_str() {
            "network" => "site",
            "building" => "building",
            _ => "closet",
        };
        let opt = |v: Option<String>| v.map_or(Json::Null, Json::Str);
        let mut m = BTreeMap::new();
        m.insert("id".into(), Json::Str(id));
        m.insert("level".into(), Json::Str(level.into()));
        m.insert("name".into(), Json::Str(row.get(2)));
        m.insert("kind".into(), opt(row.get(4)));
        m.insert("role".into(), opt(row.get(5)));
        out.push(Json::Obj(m));
    }
    Ok(Json::Arr(out))
}

/// `GET /ai/v1/designs`: every design the owner can read that the key's folders reach, each
/// with where it sits ([`folder_chain`]). `within`, when given, keeps only the designs in that
/// folder or one inside it (ADR-0074 §8), as the key sees the folders.
pub async fn ai_designs(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    key: &AiKey,
    within: Option<ScopeId>,
) -> Result<Json, AiError> {
    let verified = grants::verify_authority_state(tx, auth).await?;
    let within = within.map(|w| w.to_string());
    let rows = tx
        .query(
            "SELECT d.id, d.scope_id, s.path, d.name_ciphertext, d.name_nonce, d.name_key_epoch, \
                    greatest( \
                        coalesce((SELECT max(p.design_version) FROM design_payload p \
                                   WHERE p.design_id = d.id \
                                     AND p.organisation_id = d.organisation_id), 0), \
                        coalesce((SELECT max(c.design_version) FROM design_change c \
                                   WHERE c.design_id = d.id \
                                     AND c.organisation_id = d.organisation_id), 0)) \
             FROM designs d JOIN scopes s ON s.id = d.scope_id \
             WHERE d.organisation_id = $1 ORDER BY d.created_at",
            &[&auth.ctx.tenant().to_string()],
        )
        .await?;
    let mut names = designs::NameOpener::new(auth);
    let mut out = Vec::new();
    for row in rows {
        let id: String = row.get(0);
        let scope_text: String = row.get(1);
        let path: String = row.get(2);
        if !covers(&key.scopes, &path) {
            continue;
        }
        let scope = parse_scope(&scope_text)?;
        match grants::authorise_in_verified_state(
            tx,
            auth,
            &verified,
            Some(scope),
            Capability::Read,
        )
        .await
        {
            Ok(_) => {}
            Err(AuthorityError::NotAuthorised) | Err(AuthorityError::QuorumNotMet { .. }) => {
                continue
            }
            Err(other) => return Err(other.into()),
        }
        let sealed = match (
            row.get::<_, Option<Vec<u8>>>(3),
            row.get::<_, Option<Vec<u8>>>(4),
            row.get::<_, Option<i32>>(5),
        ) {
            (Some(c), Some(n), Some(e)) => Some((c, n, e)),
            _ => None,
        };
        // Filter by a folder only as the key sees it: one it does not reach, or an ancestor its
        // owner cannot read, matches nothing rather than confirming what is inside it.
        let place = folder_chain(tx, auth, &verified, key, &path).await?;
        if let Some(w) = &within {
            let named = matches!(&place, Json::Arr(fs) if fs.iter().any(|f|
                matches!(f, Json::Obj(m) if m.get("id") == Some(&Json::Str(w.clone())))));
            if !named {
                continue;
            }
        }
        let name = names.open(tx, &id, sealed).await?;
        let mut m = BTreeMap::new();
        m.insert("id".into(), Json::Str(id));
        m.insert("name".into(), name.map_or(Json::Null, Json::Str));
        m.insert("folder".into(), Json::Str(scope_text));
        m.insert("where".into(), place);
        m.insert("version".into(), Json::Int(row.get(6)));
        out.push(Json::Obj(m));
    }
    Ok(Json::Arr(out))
}

/// The design's scope, when this key and its owner may read it; [`AiError::NotFound`] for a
/// design that is not there, outside the key's folders, or that the owner cannot read, so
/// the three are one answer.
pub(crate) async fn readable_place(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    key: &AiKey,
    design: DesignId,
) -> Result<(ScopeId, String), AiError> {
    let organisation = auth.ctx.tenant().to_string();
    let (scope, path) = design_place(tx, &organisation, design)
        .await?
        .ok_or(AiError::NotFound)?;
    if !covers(&key.scopes, &path) || !holds(tx, auth, Some(scope), Capability::Read).await? {
        return Err(AiError::NotFound);
    }
    Ok((scope, path))
}

/// `GET /ai/v1/designs/{d}`: the design as the key may see it (`ai_reading`).
pub async fn ai_reading(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    heads: Option<&HeadStore>,
    session: &AiSession,
    design: DesignId,
) -> Result<Json, AiError> {
    let (scope, path) = readable_place(tx, auth, &session.key, design).await?;
    let stored = designs::read_version_in_tx(tx, auth, heads, design, Some(scope), None).await?;
    // Before the reading is built: what it holds is not `Send`, so no await may follow it.
    let verified = grants::verify_authority_state(tx, auth).await?;
    let place = folder_chain(tx, auth, &verified, &session.key, &path).await?;
    let tiers = tiers(&session.key, &session.policy);
    // ADR-0076: a spare's custom-field values say only their definition's id; name the
    // organisation's `part` fields (Price, Supplier) so the values read. Notes tier only, as the
    // values are, and each name through the same credential check. Read before the graph is
    // built: the graph is not `Send` and must not be held across an await.
    let field_names = if tiers.contains(&Tier::Notes) {
        let mut names = BTreeMap::new();
        for def in field_defs::list(tx, auth).await? {
            if def.kind == "part"
                && !def.archived
                && !fathom_ingest::redact::looks_like_credential_bare(&def.name)
            {
                names.insert(def.id, Json::Str(def.name));
            }
        }
        Some(Json::Obj(names))
    } else {
        None
    };
    let graph = fathom_workspace::read_plain(&stored.payload)
        .map_err(|_| AiError::Unverifiable("a stored design that does not parse"))?;
    let reading = ai_reading::reading(&graph, &tiers).map_err(AiError::Unverifiable)?;
    let Json::Obj(mut m) = reading.document else {
        return Err(AiError::Unverifiable("a reading that is not an object"));
    };
    if let Some(names) = field_names {
        m.insert("field_names".into(), names);
    }
    m.insert("design".into(), Json::Str(design.to_string()));
    m.insert("version".into(), Json::Int(stored.version));
    m.insert("where".into(), place);
    if may_change(session) {
        m.insert("mayChange".into(), ai_reading::change_vocabulary(&tiers));
    }
    m.insert(
        "about".into(),
        Json::Str(if may_change(session) {
            "Fields that looked like a password or key were left out and counted in \
             `withheld`. Change the design with POST .../changes naming this version, one \
             change a person can undo; or recommend with POST .../recommendations for a \
             person to accept or dismiss. A printed label's code holds this server's \
             address, `/scan#`, this design's id, `/` and an id from here (a rack, \
             cable, port, device or store); a person who scans it opens that item."
                .into()
        } else {
            "Read-only. Fields that looked like a password or key were left out and counted \
             in `withheld`. Recommend changes with POST .../recommendations; a person \
             accepts or dismisses each. A printed label's code holds this server's \
             address, `/scan#`, this design's id, `/` and an id from here (a rack, \
             cable, port, device or store); a person who scans it opens that item."
                .into()
        }),
    );
    Ok(Json::Obj(m))
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/// One step of a recommendation, as a person reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step {
    pub action: String,
    /// The element it is about, as the client spells an id (`kind:ULID`), if any.
    pub target: Option<String>,
    pub text: String,
}

/// One recommendation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Idea {
    pub id: String,
    pub design: String,
    pub key_id: String,
    pub owner: String,
    pub owner_name: String,
    pub title: String,
    pub why: String,
    pub steps: Vec<Step>,
    pub created_unix: i64,
    pub state: String,
    pub decided_by: Option<String>,
    pub decided_unix: Option<i64>,
    pub version: i64,
}

impl Idea {
    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("id".into(), Json::Str(self.id.clone()));
        m.insert("designId".into(), Json::Str(self.design.clone()));
        m.insert("key".into(), Json::Str(self.key_id.clone()));
        m.insert("owner".into(), Json::Str(self.owner.clone()));
        m.insert("ownerName".into(), Json::Str(self.owner_name.clone()));
        m.insert("title".into(), Json::Str(self.title.clone()));
        m.insert("why".into(), Json::Str(self.why.clone()));
        m.insert(
            "steps".into(),
            Json::Arr(self.steps.iter().map(step_json).collect()),
        );
        m.insert("createdAt".into(), Json::Int(self.created_unix));
        m.insert("state".into(), Json::Str(self.state.clone()));
        m.insert("decidedBy".into(), opt_str(&self.decided_by));
        m.insert("decidedAt".into(), opt_int(self.decided_unix));
        m.insert("version".into(), Json::Int(self.version));
        Json::Obj(m)
    }
}

fn step_json(s: &Step) -> Json {
    let mut m = BTreeMap::new();
    m.insert("action".into(), Json::Str(s.action.clone()));
    m.insert("target".into(), opt_str(&s.target));
    m.insert("text".into(), Json::Str(s.text.clone()));
    Json::Obj(m)
}

/// An element id as the client writes it: a lower-case kind, `:`, a canonical ULID.
fn clean_target(raw: &str) -> Result<String, AiError> {
    let ok = raw.split_once(':').is_some_and(|(kind, id)| {
        !kind.is_empty()
            && kind.len() <= 40
            && kind.chars().all(|c| c.is_ascii_lowercase() || c == '-')
            && canonical_ulid(id).is_some()
    });
    if ok {
        Ok(raw.to_string())
    } else {
        Err(AiError::Malformed(
            "a step's target is an element id (kind:ULID)",
        ))
    }
}

/// The body of `POST /ai/v1/designs/{d}/recommendations`, checked: `{title, why?, steps}`,
/// each step `{action, target?, text}`. Every piece of text goes through [`clean_line`].
pub fn clean_idea(body: &[u8]) -> Result<(String, String, Vec<Step>), AiError> {
    let bad =
        || AiError::Malformed("a recommendation is {title, why, steps: [{action, target, text}]}");
    let Ok(Json::Obj(mut m)) = Json::parse_canonical(body) else {
        return Err(bad());
    };
    if m.keys()
        .any(|k| !["title", "why", "steps"].contains(&k.as_str()))
    {
        return Err(bad());
    }
    let title = match m.remove("title") {
        Some(Json::Str(s)) => clean_line(&s, MAX_TITLE_CHARS, false)?,
        _ => return Err(bad()),
    };
    let why = match m.remove("why") {
        None | Some(Json::Null) => String::new(),
        Some(Json::Str(s)) => clean_line(&s, MAX_WHY_CHARS, true)?,
        _ => return Err(bad()),
    };
    let Some(Json::Arr(raw_steps)) = m.remove("steps") else {
        return Err(bad());
    };
    if raw_steps.is_empty() || raw_steps.len() > MAX_STEPS {
        return Err(AiError::Malformed("a recommendation has 1 to 20 steps"));
    }
    let mut steps = Vec::with_capacity(raw_steps.len());
    for raw in raw_steps {
        let Json::Obj(mut s) = raw else {
            return Err(bad());
        };
        if s.keys()
            .any(|k| !["action", "target", "text"].contains(&k.as_str()))
        {
            return Err(bad());
        }
        let action = match s.remove("action") {
            Some(Json::Str(a)) if ACTIONS.contains(&a.as_str()) => a,
            _ => {
                return Err(AiError::Malformed(
                    "a step's action is add, change, remove, connect, move or label",
                ))
            }
        };
        let target = match s.remove("target") {
            None | Some(Json::Null) => None,
            Some(Json::Str(t)) => Some(clean_target(&t)?),
            _ => return Err(bad()),
        };
        let text = match s.remove("text") {
            Some(Json::Str(t)) => clean_line(&t, MAX_STEP_CHARS, false)?,
            _ => return Err(bad()),
        };
        steps.push(Step {
            action,
            target,
            text,
        });
    }
    Ok((title, why, steps))
}

fn idea_aad(
    tenant: &str,
    id: &str,
    design: &str,
    key_id: &str,
    owner: &str,
    epoch: i32,
) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, AAD_AI_RECOMMENDATION);
    crypto::lp(&mut a, tenant.as_bytes());
    crypto::lp(&mut a, id.as_bytes());
    crypto::lp(&mut a, design.as_bytes());
    crypto::lp(&mut a, key_id.as_bytes());
    crypto::lp(&mut a, owner.as_bytes());
    crypto::u32_le(&mut a, epoch as u32);
    a
}

fn idea_body(title: &str, why: &str, steps: &[Step]) -> Vec<u8> {
    let mut m = BTreeMap::new();
    m.insert("title".into(), Json::Str(title.to_string()));
    m.insert("why".into(), Json::Str(why.to_string()));
    m.insert(
        "steps".into(),
        Json::Arr(steps.iter().map(step_json).collect()),
    );
    Json::Obj(m).to_canonical_bytes()
}

#[allow(clippy::too_many_arguments)]
async fn seal_idea(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
    design: &str,
    key_id: &str,
    owner: &str,
    plain: &[u8],
) -> Result<(Vec<u8>, [u8; crypto::NONCE_LEN], i32), AiError> {
    let tenant = auth.ctx.tenant().to_string();
    let key = keys::org_content_key(tx, auth.ctx, auth.tenant_key).await?;
    let nonce = crypto::random_nonce()?;
    let ciphertext = crypto::seal(
        &key.key,
        &nonce,
        plain,
        &idea_aad(&tenant, id, design, key_id, owner, key.epoch),
    )?;
    keys::count_write_under_org_content_key(tx, &tenant, key.epoch).await?;
    Ok((ciphertext, nonce, key.epoch))
}

const IDEA_COLUMNS: &str = "r.id, r.design_id, r.key_id, r.owner, r.state, r.decided_by, \
     r.version, r.ciphertext, r.nonce, r.key_epoch, \
     extract(epoch FROM r.created_at)::bigint, extract(epoch FROM r.decided_at)::bigint, \
     coalesce((SELECT a.display_name FROM accounts a WHERE a.id = r.owner), '')";

struct IdeaOpener<'a> {
    auth: &'a Authority<'a>,
    keys: BTreeMap<i32, crypto::Key32>,
}

impl IdeaOpener<'_> {
    async fn open(
        &mut self,
        tx: &Transaction<'_>,
        row: &tokio_postgres::Row,
    ) -> Result<Idea, AiError> {
        let id: String = row.get(0);
        let design: String = row.get(1);
        let key_id: String = row.get(2);
        let owner: String = row.get(3);
        let epoch: i32 = row.get(9);
        if !self.keys.contains_key(&epoch) {
            let key =
                keys::org_content_key_at_epoch(tx, self.auth.ctx, self.auth.tenant_key, epoch)
                    .await?;
            self.keys.insert(epoch, key);
        }
        let nonce: [u8; crypto::NONCE_LEN] = row
            .get::<_, Vec<u8>>(8)
            .try_into()
            .map_err(|_| AiError::Unverifiable("recommendation nonce"))?;
        let tenant = self.auth.ctx.tenant().to_string();
        let plain = crypto::open(
            &self.keys[&epoch],
            &nonce,
            &row.get::<_, Vec<u8>>(7),
            &idea_aad(&tenant, &id, &design, &key_id, &owner, epoch),
        )
        .map_err(|_| AiError::Unverifiable("recommendation body"))?;
        let (title, why, steps) = if plain.is_empty() {
            (String::new(), String::new(), Vec::new())
        } else {
            open_body(&plain)?
        };
        Ok(Idea {
            id,
            design,
            key_id,
            owner,
            owner_name: row.get(12),
            title,
            why,
            steps,
            created_unix: row.get(10),
            state: row.get(4),
            decided_by: row.get(5),
            decided_unix: row.get(11),
            version: row.get(6),
        })
    }
}

fn open_body(plain: &[u8]) -> Result<(String, String, Vec<Step>), AiError> {
    let corrupt = || AiError::Unverifiable("recommendation body");
    let Ok(Json::Obj(mut m)) = Json::parse_canonical(plain) else {
        return Err(corrupt());
    };
    let (Some(Json::Str(title)), Some(Json::Str(why)), Some(Json::Arr(raw))) =
        (m.remove("title"), m.remove("why"), m.remove("steps"))
    else {
        return Err(corrupt());
    };
    let mut steps = Vec::new();
    for s in raw {
        let Json::Obj(mut s) = s else {
            return Err(corrupt());
        };
        let (Some(Json::Str(action)), Some(target), Some(Json::Str(text))) =
            (s.remove("action"), s.remove("target"), s.remove("text"))
        else {
            return Err(corrupt());
        };
        steps.push(Step {
            action,
            target: match target {
                Json::Str(t) => Some(t),
                _ => None,
            },
            text,
        });
    }
    Ok((title, why, steps))
}

/// `POST /ai/v1/designs/{d}/recommendations`. The key may recommend, and its owner can read
/// the design; caps counted under an advisory lock; the body sealed.
pub async fn recommend(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    session: &AiSession,
    design: DesignId,
    body: &[u8],
) -> Result<Idea, AiError> {
    if !session.key.may_recommend {
        return Err(AiError::NotAllowed(
            "this key may read but not recommend; its owner can change that",
        ));
    }
    readable_place(tx, auth, &session.key, design).await?;
    let (title, why, steps) = clean_idea(body)?;
    let tenant = auth.ctx.tenant().to_string();
    let design_text = design.to_string();
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        &[&format!("ai_recommendations:{tenant}")],
    )
    .await?;
    let counts = tx
        .query_one(
            "SELECT count(*), count(*) FILTER (WHERE design_id = $2) \
             FROM ai_recommendations WHERE organisation_id = $1 AND state = 'open'",
            &[&tenant, &design_text],
        )
        .await?;
    let (open, here): (i64, i64) = (counts.get(0), counts.get(1));
    if here >= MAX_OPEN_PER_DESIGN {
        return Err(AiError::NotAllowed(
            "this design has 20 AI ideas waiting; they need deciding first",
        ));
    }
    if open >= MAX_OPEN_PER_ORGANISATION {
        return Err(AiError::NotAllowed(
            "this organisation has 200 AI ideas waiting; they need deciding first",
        ));
    }
    let id = crate::ids::new_ulid().to_string();
    let owner = auth.ctx.actor().to_string();
    let (ciphertext, nonce, epoch) = seal_idea(
        tx,
        auth,
        &id,
        &design_text,
        &session.key.id,
        &owner,
        &idea_body(&title, &why, &steps),
    )
    .await?;
    tx.execute(
        "INSERT INTO ai_recommendations (organisation_id, id, design_id, key_id, owner, \
             step_count, ciphertext, nonce, key_epoch) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        &[
            &tenant,
            &id,
            &design_text,
            &session.key.id,
            &owner,
            &(steps.len() as i32),
            &ciphertext,
            &nonce.to_vec(),
            &epoch,
        ],
    )
    .await?;
    read_idea(tx, auth, &id).await
}

async fn read_idea(tx: &Transaction<'_>, auth: &Authority<'_>, id: &str) -> Result<Idea, AiError> {
    let row = tx
        .query_one(
            &format!(
                "SELECT {IDEA_COLUMNS} FROM ai_recommendations r \
                 WHERE r.organisation_id = $1 AND r.id = $2"
            ),
            &[&auth.ctx.tenant().to_string(), &id],
        )
        .await?;
    IdeaOpener {
        auth,
        keys: BTreeMap::new(),
    }
    .open(tx, &row)
    .await
}

/// `GET /ai/v1/designs/{d}/recommendations`: what this key recommended on the design, and
/// what became of each.
pub async fn ai_own_ideas(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    session: &AiSession,
    design: DesignId,
) -> Result<Vec<Idea>, AiError> {
    readable_place(tx, auth, &session.key, design).await?;
    let rows = tx
        .query(
            &format!(
                "SELECT {IDEA_COLUMNS} FROM ai_recommendations r \
                 WHERE r.organisation_id = $1 AND r.design_id = $2 AND r.key_id = $3 \
                 ORDER BY r.created_at DESC, r.id DESC LIMIT 100"
            ),
            &[
                &auth.ctx.tenant().to_string(),
                &design.to_string(),
                &session.key.id,
            ],
        )
        .await?;
    let mut opener = IdeaOpener {
        auth,
        keys: BTreeMap::new(),
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(opener.open(tx, row).await?);
    }
    Ok(out)
}

/// `GET /organisations/{o}/designs/{d}/ai-ideas`: every open idea on the design and the most
/// recently decided, for anyone who can read it. A design the caller cannot read is the same
/// refusal as one that is not there.
pub async fn list_ideas(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
) -> Result<Vec<Idea>, AiError> {
    let organisation = auth.ctx.tenant().to_string();
    let place = design_place(tx, &organisation, design).await?;
    let scope = place.as_ref().map(|(s, _)| *s);
    grants::authorise_account(tx, auth, scope, Capability::Read).await?;
    if place.is_none() {
        return Err(AiError::NotFound);
    }
    let rows = tx
        .query(
            &format!(
                "SELECT {IDEA_COLUMNS} FROM ai_recommendations r \
                 WHERE r.organisation_id = $1 AND r.design_id = $2 AND (r.state = 'open' \
                   OR r.id IN (SELECT d.id FROM ai_recommendations d \
                               WHERE d.organisation_id = $1 AND d.design_id = $2 \
                                 AND d.state <> 'open' \
                               ORDER BY d.decided_at DESC, d.id DESC LIMIT $3)) \
                 ORDER BY r.created_at, r.id"
            ),
            &[&organisation, &design.to_string(), &MAX_DECIDED_LISTED],
        )
        .await?;
    let mut opener = IdeaOpener {
        auth,
        keys: BTreeMap::new(),
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(opener.open(tx, row).await?);
    }
    Ok(out)
}

/// Accept or dismiss one idea. Needs `draw` on the design's place. Where the organisation
/// asks for a second person on that folder, the key's owner cannot accept their own AI's
/// idea. Accepting changes nothing else here: the edit is the accepter's, in the client. A
/// dismissal re-seals the body empty, so what the AI wrote is not kept.
pub async fn decide_idea(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    id: &str,
    if_version: i64,
    accept: bool,
) -> Result<Idea, AiError> {
    let organisation = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let place = design_place(tx, &organisation, design).await?;
    grants::authorise_account(tx, auth, place.as_ref().map(|(s, _)| *s), Capability::Draw).await?;
    let (_, path) = place.ok_or(AiError::NotFound)?;
    let row = tx
        .query_opt(
            &format!(
                "SELECT {IDEA_COLUMNS} FROM ai_recommendations r \
                 WHERE r.organisation_id = $1 AND r.design_id = $2 AND r.id = $3 \
                 FOR UPDATE OF r"
            ),
            &[&organisation, &design.to_string(), &id],
        )
        .await?
        .ok_or(AiError::NotFound)?;
    let mut opener = IdeaOpener {
        auth,
        keys: BTreeMap::new(),
    };
    let idea = opener.open(tx, &row).await?;
    if idea.state != "open" || idea.version != if_version {
        return Err(AiError::Conflict {
            version: idea.version,
        });
    }
    if accept && idea.owner == me {
        let policy = read_policy(tx, auth.ring, &organisation, false).await?;
        if !policy.second_person_scopes.is_empty() && covers(&policy.second_person_scopes, &path) {
            return Err(AiError::NotAllowed(
                "this folder needs a second person: someone other than the key's owner accepts \
                 its ideas",
            ));
        }
    }
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::AiRecommendationDecided,
        &metadata(
            EntryType::AiRecommendationDecided,
            &[
                ("recommendation", Json::Str(idea.id.clone())),
                ("design", Json::Str(idea.design.clone())),
                ("key", Json::Str(idea.key_id.clone())),
                ("by", Json::Str(me.clone())),
                (
                    "decision",
                    Json::Str(if accept { "accepted" } else { "dismissed" }.into()),
                ),
            ],
        ),
    )
    .await?;
    let changed = if accept {
        tx.execute(
            "UPDATE ai_recommendations SET state = 'accepted', decided_by = $4, \
                 decided_at = now(), version = version + 1 \
             WHERE organisation_id = $1 AND id = $2 AND version = $3 AND state = 'open'",
            &[&organisation, &id, &if_version, &me],
        )
        .await?
    } else {
        let (ciphertext, nonce, epoch) =
            seal_idea(tx, auth, id, &idea.design, &idea.key_id, &idea.owner, b"").await?;
        tx.execute(
            "UPDATE ai_recommendations SET state = 'dismissed', decided_by = $4, \
                 decided_at = now(), version = version + 1, \
                 ciphertext = $5, nonce = $6, key_epoch = $7 \
             WHERE organisation_id = $1 AND id = $2 AND version = $3 AND state = 'open'",
            &[
                &organisation,
                &id,
                &if_version,
                &me,
                &ciphertext,
                &nonce.to_vec(),
                &epoch,
            ],
        )
        .await?
    };
    if changed != 1 {
        return Err(AiError::Conflict {
            version: idea.version,
        });
    }
    read_idea(tx, auth, id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_list_names_every_label_this_module_uses() {
        for label in [
            TAG_AI_REQUEST,
            TAG_AI_KEY_ID,
            TAG_AI_NONCE,
            AAD_AI_RECOMMENDATION,
        ] {
            let text = core::str::from_utf8(label).unwrap();
            assert!(LABELS.iter().any(|(name, _)| *name == text), "{text}");
        }
        for (name, _) in LABELS {
            assert!(
                !authority::LABELS.iter().any(|(n, _)| n == name),
                "{name} is already another module's"
            );
        }
    }

    #[test]
    fn a_key_id_is_a_canonical_ulid_and_differs_per_key() {
        let a = key_id_of(&[4u8; 65]);
        let b = key_id_of(&[5u8; 65]);
        assert_eq!(canonical_ulid(&a).as_deref(), Some(a.as_str()));
        assert_ne!(a, b);
        assert_eq!(a, key_id_of(&[4u8; 65]));
    }

    #[test]
    fn every_part_of_a_request_is_in_what_is_signed() {
        let base = request_bytes("dep", "key", "GET", "/ai/v1/designs", b"", &[1; 32], 10);
        for other in [
            request_bytes("dep2", "key", "GET", "/ai/v1/designs", b"", &[1; 32], 10),
            request_bytes("dep", "key2", "GET", "/ai/v1/designs", b"", &[1; 32], 10),
            request_bytes("dep", "key", "POST", "/ai/v1/designs", b"", &[1; 32], 10),
            request_bytes("dep", "key", "GET", "/ai/v1/designs?x", b"", &[1; 32], 10),
            request_bytes("dep", "key", "GET", "/ai/v1/designs", b"x", &[1; 32], 10),
            request_bytes("dep", "key", "GET", "/ai/v1/designs", b"", &[2; 32], 10),
            request_bytes("dep", "key", "GET", "/ai/v1/designs", b"", &[1; 32], 11),
        ] {
            assert_ne!(base, other);
        }
    }

    #[test]
    fn folders_cover_their_own_subtree_and_nothing_else() {
        let n = "01JAAAAAAAAAAAAAAAAAAAAAAA";
        let b = "01JBBBBBBBBBBBBBBBBBBBBBBB";
        let r = "01JCCCCCCCCCCCCCCCCCCCCCCC";
        let path = format!("{n}.{b}.{r}");
        assert!(covers(&[], &path));
        assert!(covers(&[b.to_string()], &path));
        assert!(covers(&[r.to_string()], &path));
        assert!(!covers(&[r.to_string()], &format!("{n}.{b}")));
        assert!(!covers(&["01JDDDDDDDDDDDDDDDDDDDDDDD".to_string()], &path));
    }

    #[test]
    fn narrowing_folders_never_gives_a_new_one() {
        let a = "01JAAAAAAAAAAAAAAAAAAAAAAA".to_string();
        let b = "01JBBBBBBBBBBBBBBBBBBBBBBB".to_string();
        let only_a = std::slice::from_ref(&a);
        let only_b = std::slice::from_ref(&b);
        assert!(scopes_narrow(&[], only_a));
        assert!(scopes_narrow(&[a.clone(), b.clone()], only_a));
        assert!(!scopes_narrow(only_a, &[]), "every folder is wider");
        assert!(!scopes_narrow(only_a, only_b));
    }

    #[test]
    fn the_ai_account_is_one_address_in_lower_case() {
        assert_eq!(
            clean_account("  Dana@Example.ORG ").unwrap(),
            "dana@example.org"
        );
        for bad in [
            "",
            "dana",
            "@example.org",
            "dana@",
            "a@b@c",
            "dana smith@example.org",
        ] {
            assert!(clean_account(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn what_a_key_sees_always_includes_layout_and_has_one_spelling() {
        assert_eq!(clean_sees(&[]).unwrap(), vec!["layout"]);
        assert_eq!(
            clean_sees(&["notes".into(), "layout".into(), "notes".into()]).unwrap(),
            vec!["layout", "notes"]
        );
        assert!(clean_sees(&["passwords".into()]).is_err());
        assert!(clean_sees(&["vault".into()]).is_err());
    }

    #[test]
    fn the_ceiling_cuts_what_a_key_sees_at_each_request() {
        let mut policy = Policy::off();
        policy.ceiling = vec!["layout".into(), "addresses".into()];
        let key_sees = vec!["layout".into(), "addresses".into(), "notes".into()];
        let key = AiKey {
            organisation: String::new(),
            id: String::new(),
            owner: String::new(),
            owner_name: String::new(),
            kind: "helper".into(),
            public_key: None,
            client_id: None,
            label: String::new(),
            scopes: Vec::new(),
            sees: key_sees,
            may_recommend: false,
            created_unix: 0,
            created_seq: 1,
            expires_unix: 1,
            state: "on".into(),
            changed_seq: 1,
            disabled_unix: None,
            disabled_by: None,
            disabled_by_kind: None,
            disabled_reason: None,
            version: 1,
            ai_account: None,
            owner_email: String::new(),
            may_change: false,
        };
        let t = tiers(&key, &policy);
        assert!(t.contains(&Tier::Addresses));
        assert!(!t.contains(&Tier::Notes));
    }

    /// Forms a real device accepts (`corrections.rs`'s list).
    const DEVICE_SECRETS: [&str; 5] = [
        "enable secret cisco123",
        "username admin password 0 Cisco123!",
        "snmp-server community s3cr3tR0 RO",
        "tacacs-server key 7 0822455D0A16",
        "wpa-psk Tr0ub4dor&3",
    ];

    /// A body as an AI app's helper sends it: canonical JSON.
    fn body(fields: &[(&str, Json)]) -> Vec<u8> {
        Json::Obj(
            fields
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
        .to_canonical_bytes()
    }

    fn step(fields: &[(&str, &str)]) -> Json {
        Json::Obj(
            fields
                .iter()
                .map(|(k, v)| (k.to_string(), Json::Str(v.to_string())))
                .collect(),
        )
    }

    fn s(v: &str) -> Json {
        Json::Str(v.to_string())
    }

    #[test]
    fn a_recommendation_carrying_a_device_secret_is_refused_anywhere_in_it() {
        for secret in DEVICE_SECRETS {
            let in_step = body(&[
                ("title", s("Tidy rack B3")),
                (
                    "steps",
                    Json::Arr(vec![step(&[("action", "change"), ("text", secret)])]),
                ),
            ]);
            assert!(
                matches!(clean_idea(&in_step), Err(AiError::LooksSecret)),
                "{secret}"
            );
            let in_title = body(&[
                ("title", s(secret)),
                (
                    "steps",
                    Json::Arr(vec![step(&[("action", "add"), ("text", "a patch panel")])]),
                ),
            ]);
            assert!(
                matches!(clean_idea(&in_title), Err(AiError::LooksSecret)),
                "{secret}"
            );
            let in_why = body(&[
                ("title", s("Tidy")),
                ("why", s(&format!("the switch config says {secret}"))),
                (
                    "steps",
                    Json::Arr(vec![step(&[("action", "add"), ("text", "a patch panel")])]),
                ),
            ]);
            assert!(
                matches!(clean_idea(&in_why), Err(AiError::LooksSecret)),
                "{secret}"
            );
        }
    }

    #[test]
    fn a_recommendation_is_typed_and_bounded() {
        let one = |fields: &[(&str, &str)]| Json::Arr(vec![step(fields)]);
        let ok = body(&[
            ("title", s("Add a patch panel")),
            ("why", s("Rack B3 has none")),
            (
                "steps",
                one(&[
                    ("action", "add"),
                    ("target", "rack:01JAAAAAAAAAAAAAAAAAAAAAAA"),
                    ("text", "A 24-port panel at U42"),
                ]),
            ),
        ]);
        let (title, why, steps) = clean_idea(&ok).unwrap();
        assert_eq!(title, "Add a patch panel");
        assert_eq!(why, "Rack B3 has none");
        assert_eq!(steps.len(), 1);
        let add = one(&[("action", "add"), ("text", "x")]);
        for bad in [
            body(&[("title", s("x")), ("steps", Json::Arr(vec![]))]),
            body(&[("title", s("")), ("steps", add.clone())]),
            body(&[
                ("title", s("x")),
                ("steps", one(&[("action", "save"), ("text", "x")])),
            ]),
            body(&[
                ("title", s("x")),
                (
                    "steps",
                    one(&[("action", "add"), ("text", "x"), ("run", "rm")]),
                ),
            ]),
            body(&[
                ("title", s("x")),
                (
                    "steps",
                    one(&[("action", "add"), ("target", "Rack 1"), ("text", "x")]),
                ),
            ]),
            body(&[
                ("apply", Json::Bool(true)),
                ("title", s("x")),
                ("steps", add.clone()),
            ]),
            Json::Arr(vec![Json::Int(1)]).to_canonical_bytes(),
            // Not canonical: a person's app goes through the helper, which writes it so.
            br#"{"title":"x", "steps":[]}"#.to_vec(),
        ] {
            assert!(
                clean_idea(&bad).is_err(),
                "{}",
                String::from_utf8_lossy(&bad)
            );
        }
        let many = body(&[
            ("title", s("x")),
            (
                "steps",
                Json::Arr(vec![step(&[("action", "add"), ("text", "x")]); 21]),
            ),
        ]);
        assert!(clean_idea(&many).is_err());
    }
}
