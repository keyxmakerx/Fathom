//! **Firmware's limits, set on the Admin and Steward pages** (sign-off r71, `0062`).
//!
//! The server's settings file (`FATHOM_FIRMWARE_*`) gives the starting values ([`FileValues`]).
//! Once the admin saves a value on Admin › Firmware it wins, and a saved value can be cleared to go
//! back to the file's (r71 "file", A). Three writers, three rows:
//!
//! - **The admin** (the operator plane) sets the server's limits: the largest image, the server's
//!   total, the default ceiling for every organisation, uploads at once, the stall time and the
//!   address devices download from ([`ServerSettings`]).
//! - **The admin** also sets one organisation apart: a ceiling of its own, and a lock with a reason
//!   that stops its Stewards changing their total ([`Ceiling`]).
//! - **A Steward** sets their organisation's own total, which can only be under the ceiling
//!   ([`OrgOwn`]).
//!
//! What an upload is held to is [`Limits`], worked out by [`effective`] from all four.
//!
//! **Every change is sealed** with who made it and the values before and after: the server's on the
//! site chain, an admin's ceiling or lock on the site chain AND the organisation's (so its Stewards
//! see it), a Steward's on the organisation's. The two admin rows carry a row seal bound to the
//! entry that wrote them; a row that does not verify is refused, never used.
//!
//! **Not a security boundary on its own.** These are limits against an organisation, or a person in
//! one, filling the server's disk or tying up its uploads (r62). The authority checks are the
//! operator plane's and the Steward capability, as everywhere else.

use std::collections::BTreeMap;
use std::time::Duration;

use deadpool_postgres::{PoolError, Transaction};
use fathom_canon::Json;

use crate::authority::{self, RowFacts};
use crate::chain::EntryType;
use crate::chains::{self, ChainStoreError};
use crate::crypto;
use crate::field_defs::is_unsafe_char;
use crate::grants::{self, AuthorityError};
use crate::keys::{self, KeyRing, KeyStoreError};
use crate::repo::{self, RepoError};

/// The fewest bytes a byte limit may be set to: one mebibyte. A smaller one is a typo.
pub const MIN_BYTES: i64 = 1024 * 1024;
/// The most: one pebibyte, far past any real volume, so a number typed with three zeros too many is
/// still refused.
pub const MAX_BYTES: i64 = 1024 * 1024 * 1024 * 1024 * 1024;
/// The longest reason an admin may give a lock, in characters.
pub const MAX_REASON_CHARS: usize = 300;

/// What the server's settings file says. Built once at startup from `Config` and the firmware
/// store; the page shows each beside the saved value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileValues {
    pub max_image_bytes: u64,
    pub total_max_bytes: u64,
    pub organisation_max_bytes: u64,
    pub uploads_per_server: usize,
    pub uploads_per_organisation: usize,
    pub upload_idle_seconds: u64,
    pub fetch_base_url: String,
}

/// The admin's saved values. `None` in a field means "the settings file's".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Saved {
    pub max_image_bytes: Option<i64>,
    pub total_max_bytes: Option<i64>,
    pub organisation_max_bytes: Option<i64>,
    pub uploads_per_server: Option<i32>,
    pub uploads_per_organisation: Option<i32>,
    pub upload_idle_seconds: Option<i32>,
    pub fetch_base_url: Option<String>,
}

/// The admin's row as stored: the saved values, and who saved them when.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ServerSettings {
    pub saved: Saved,
    pub changed_by: Option<String>,
    pub changed_unix: Option<i64>,
    pub changed_seq: i64,
    /// 0 for "never saved".
    pub version: i32,
}

/// The admin's setting for one organisation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ceiling {
    pub organisation: String,
    /// `None`: the server's default ceiling.
    pub ceiling_bytes: Option<i64>,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub changed_by: String,
    pub changed_unix: i64,
    pub changed_seq: i64,
    pub version: i32,
}

/// The Stewards' own setting.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OrgOwn {
    /// `None`: as much as the ceiling allows.
    pub max_bytes: Option<i64>,
    /// The address this organisation's devices download from, when it is not the server's.
    pub fetch_base_url: Option<String>,
    pub set_by: Option<String>,
    pub set_unix: Option<i64>,
}

/// What uploads are held to now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_image_bytes: u64,
    pub total_max_bytes: u64,
    /// The most this organisation's Stewards may set: the admin's for it, or the server's default.
    pub organisation_ceiling: u64,
    /// What this organisation's images may add up to: the Stewards' own, never above the ceiling,
    /// and the ceiling itself while the admin has it locked.
    pub organisation_max_bytes: u64,
    pub uploads_per_server: usize,
    pub uploads_per_organisation: usize,
    pub upload_idle: Duration,
    pub fetch_base_url: String,
}

/// Work out [`Limits`] from the file, the admin's row, the organisation's ceiling and its own.
pub fn effective(
    file: &FileValues,
    server: &Saved,
    ceiling: Option<&Ceiling>,
    own: &OrgOwn,
) -> Limits {
    let bytes = |saved: Option<i64>, file: u64| saved.map_or(file, |v| v.max(1) as u64);
    let default_ceiling = bytes(server.organisation_max_bytes, file.organisation_max_bytes);
    let organisation_ceiling = ceiling
        .and_then(|c| c.ceiling_bytes)
        .map_or(default_ceiling, |v| v.max(1) as u64);
    let locked = ceiling.is_some_and(|c| c.locked);
    let organisation_max_bytes = match own.max_bytes {
        Some(mine) if !locked => (mine.max(1) as u64).min(organisation_ceiling),
        _ => organisation_ceiling,
    };
    Limits {
        max_image_bytes: bytes(server.max_image_bytes, file.max_image_bytes),
        total_max_bytes: bytes(server.total_max_bytes, file.total_max_bytes),
        organisation_ceiling,
        organisation_max_bytes,
        uploads_per_server: server
            .uploads_per_server
            .map_or(file.uploads_per_server, |v| v.max(1) as usize),
        uploads_per_organisation: server
            .uploads_per_organisation
            .map_or(file.uploads_per_organisation, |v| v.max(1) as usize),
        upload_idle: Duration::from_secs(
            server
                .upload_idle_seconds
                .map_or(file.upload_idle_seconds, |v| v.max(1) as u64),
        ),
        fetch_base_url: own
            .fetch_base_url
            .clone()
            .filter(|_| !locked)
            .or_else(|| server.fetch_base_url.clone())
            .unwrap_or_else(|| file.fetch_base_url.clone()),
    }
}

/// Why a firmware setting could not be read or written.
#[derive(Debug)]
pub enum SettingsError {
    Pool(PoolError),
    Db(tokio_postgres::Error),
    Repo(RepoError),
    Keys(KeyStoreError),
    Chain(ChainStoreError),
    Authority(AuthorityError),
    /// A stored row whose seal does not verify: edited outside the server.
    Unverifiable(&'static str),
    /// The row changed since the caller read it; reload and try again.
    Conflict,
    /// A value out of its range, or text that is not allowed; the sentence says which.
    Malformed(&'static str),
    /// The admin has locked this organisation's setting.
    Locked,
    /// A Steward asked for more than the ceiling.
    OverCeiling {
        ceiling: u64,
    },
}

macro_rules! from_error {
    ($($t:ty => $v:ident),* $(,)?) => {
        $(impl From<$t> for SettingsError {
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
    ChainStoreError => Chain,
    AuthorityError => Authority,
);

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pool(e) => write!(f, "database pool: {e}"),
            Self::Db(e) => write!(f, "database: {e}"),
            Self::Repo(e) => write!(f, "{e}"),
            Self::Keys(e) => write!(f, "{e}"),
            Self::Chain(e) => write!(f, "{e}"),
            Self::Authority(e) => write!(f, "{e}"),
            Self::Unverifiable(what) => write!(f, "{what} does not verify"),
            Self::Conflict => f.write_str("that changed since it was read; reload and try again"),
            Self::Malformed(why) => f.write_str(why),
            Self::Locked => {
                f.write_str("the server's admin has locked this organisation's firmware total")
            }
            Self::OverCeiling { ceiling } => write!(
                f,
                "that is more than this organisation may have; the most is {ceiling} bytes"
            ),
        }
    }
}

impl std::error::Error for SettingsError {}

// ---------------------------------------------------------------------------
// Values in
// ---------------------------------------------------------------------------

/// A byte limit an admin or Steward typed: within [`MIN_BYTES`]..=[`MAX_BYTES`].
pub fn check_bytes(v: i64) -> Result<i64, SettingsError> {
    if (MIN_BYTES..=MAX_BYTES).contains(&v) {
        Ok(v)
    } else {
        Err(SettingsError::Malformed(
            "a size must be at least 1 MiB and at most 1 PiB",
        ))
    }
}

/// The address devices download from: `http://` or `https://`, a host, an optional port and path,
/// nothing a device's copy command or a shell could read as something else. `http://` is allowed
/// because many devices fetch over a management network without TLS; the hash checks on the device
/// are what make that safe enough, as `docs/UPGRADING-A-JUNIPER.md` says.
pub fn check_fetch_base_url(raw: &str) -> Result<String, SettingsError> {
    const SHAPE: &str = "the download address must look like https://firmware.example.com, with \
         no spaces, quotes, user name, query or fragment";
    let v = raw.trim().trim_end_matches('/');
    let rest = v
        .strip_prefix("https://")
        .or_else(|| v.strip_prefix("http://"))
        .ok_or(SettingsError::Malformed(SHAPE))?;
    let host = rest.split('/').next().unwrap_or("");
    let ok = !host.is_empty()
        && (8..=300).contains(&v.chars().count())
        && v.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '/' | '_' | '[' | ']')
        })
        && !host.starts_with(['.', '-', ':']);
    // The one `//` is the scheme's; any other is refused.
    if !ok || rest.contains("//") {
        return Err(SettingsError::Malformed(SHAPE));
    }
    Ok(v.to_string())
}

/// A lock reason: one line, no control or invisible characters, nothing shaped like a password.
pub fn check_reason(raw: &str) -> Result<Option<String>, SettingsError> {
    if raw
        .chars()
        .any(|c| !matches!(c, '\n' | '\r' | '\t') && is_unsafe_char(c))
    {
        return Err(SettingsError::Malformed(
            "the reason must not contain control or invisible characters",
        ));
    }
    let t = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return Ok(None);
    }
    if t.chars().count() > MAX_REASON_CHARS {
        return Err(SettingsError::Malformed("the reason is too long"));
    }
    if fathom_ingest::redact::looks_like_credential_bare(&t) {
        return Err(SettingsError::Malformed(
            "that reason looks as if it carries a password or key",
        ));
    }
    Ok(Some(t))
}

/// The saved values, checked together. The largest image cannot be more than the server's total.
pub fn check_saved(saved: Saved, file: &FileValues) -> Result<Saved, SettingsError> {
    let saved = Saved {
        max_image_bytes: saved.max_image_bytes.map(check_bytes).transpose()?,
        total_max_bytes: saved.total_max_bytes.map(check_bytes).transpose()?,
        organisation_max_bytes: saved.organisation_max_bytes.map(check_bytes).transpose()?,
        uploads_per_server: match saved.uploads_per_server {
            Some(n) if !(1..=64).contains(&n) => {
                return Err(SettingsError::Malformed(
                    "uploads at once must be between 1 and 64",
                ));
            }
            other => other,
        },
        uploads_per_organisation: match saved.uploads_per_organisation {
            Some(n) if !(1..=64).contains(&n) => {
                return Err(SettingsError::Malformed(
                    "uploads at once must be between 1 and 64",
                ));
            }
            other => other,
        },
        upload_idle_seconds: match saved.upload_idle_seconds {
            Some(n) if !(10..=3600).contains(&n) => {
                return Err(SettingsError::Malformed(
                    "the stall time must be between 10 seconds and an hour",
                ));
            }
            other => other,
        },
        fetch_base_url: saved
            .fetch_base_url
            .as_deref()
            .map(check_fetch_base_url)
            .transpose()?,
    };
    let image = saved
        .max_image_bytes
        .map_or(file.max_image_bytes, |v| v as u64);
    let total = saved
        .total_max_bytes
        .map_or(file.total_max_bytes, |v| v as u64);
    if image > total {
        return Err(SettingsError::Malformed(
            "the largest image cannot be more than the server's total",
        ));
    }
    let per_org = saved
        .uploads_per_organisation
        .map_or(file.uploads_per_organisation, |v| v as usize);
    let per_server = saved
        .uploads_per_server
        .map_or(file.uploads_per_server, |v| v as usize);
    if per_org > per_server {
        return Err(SettingsError::Malformed(
            "uploads at once for one organisation cannot be more than for the server",
        ));
    }
    Ok(saved)
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

fn opt_int(v: Option<i64>) -> Json {
    v.map_or(Json::Null, Json::Int)
}

fn opt_str(v: &Option<String>) -> Json {
    v.as_ref().map_or(Json::Null, |s| Json::Str(s.clone()))
}

impl Saved {
    fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("max_image_bytes".into(), opt_int(self.max_image_bytes));
        m.insert("total_max_bytes".into(), opt_int(self.total_max_bytes));
        m.insert(
            "organisation_max_bytes".into(),
            opt_int(self.organisation_max_bytes),
        );
        m.insert(
            "uploads_per_server".into(),
            opt_int(self.uploads_per_server.map(i64::from)),
        );
        m.insert(
            "uploads_per_organisation".into(),
            opt_int(self.uploads_per_organisation.map(i64::from)),
        );
        m.insert(
            "upload_idle_seconds".into(),
            opt_int(self.upload_idle_seconds.map(i64::from)),
        );
        m.insert("fetch_base_url".into(), opt_str(&self.fetch_base_url));
        Json::Obj(m)
    }
}

impl FileValues {
    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert(
            "max_image_bytes".into(),
            Json::Int(self.max_image_bytes as i64),
        );
        m.insert(
            "total_max_bytes".into(),
            Json::Int(self.total_max_bytes as i64),
        );
        m.insert(
            "organisation_max_bytes".into(),
            Json::Int(self.organisation_max_bytes as i64),
        );
        m.insert(
            "uploads_per_server".into(),
            Json::Int(self.uploads_per_server as i64),
        );
        m.insert(
            "uploads_per_organisation".into(),
            Json::Int(self.uploads_per_organisation as i64),
        );
        m.insert(
            "upload_idle_seconds".into(),
            Json::Int(self.upload_idle_seconds as i64),
        );
        m.insert(
            "fetch_base_url".into(),
            Json::Str(self.fetch_base_url.clone()),
        );
        Json::Obj(m)
    }
}

impl Limits {
    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert(
            "max_image_bytes".into(),
            Json::Int(self.max_image_bytes as i64),
        );
        m.insert(
            "total_max_bytes".into(),
            Json::Int(self.total_max_bytes as i64),
        );
        m.insert(
            "organisation_ceiling".into(),
            Json::Int(self.organisation_ceiling as i64),
        );
        m.insert(
            "organisation_max_bytes".into(),
            Json::Int(self.organisation_max_bytes as i64),
        );
        m.insert(
            "uploads_per_server".into(),
            Json::Int(self.uploads_per_server as i64),
        );
        m.insert(
            "uploads_per_organisation".into(),
            Json::Int(self.uploads_per_organisation as i64),
        );
        m.insert(
            "upload_idle_seconds".into(),
            Json::Int(self.upload_idle.as_secs() as i64),
        );
        m.insert(
            "fetch_base_url".into(),
            Json::Str(self.fetch_base_url.clone()),
        );
        Json::Obj(m)
    }
}

impl ServerSettings {
    fn state(&self) -> Vec<u8> {
        let mut m = BTreeMap::new();
        m.insert("saved".into(), self.saved.to_json());
        m.insert("changed_by".into(), opt_str(&self.changed_by));
        Json::Obj(m).to_canonical_bytes()
    }

    async fn seal(&self, tx: &Transaction<'_>, ring: &KeyRing) -> Result<[u8; 32], SettingsError> {
        let key = grants::site_row_key(tx, ring).await?;
        Ok(authority::row_seal(
            &key,
            &RowFacts {
                table: "firmware_server_settings",
                row_id: "site",
                chain_seq: self.changed_seq,
                row_version: self.version,
                row_state: &self.state(),
            },
        ))
    }

    /// The saved values alone, for a Steward: who saved them is the operator plane's.
    pub fn saved_json(&self) -> Json {
        self.saved.to_json()
    }

    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("saved".into(), self.saved.to_json());
        m.insert("changed_at_unix".into(), opt_int(self.changed_unix));
        m.insert("version".into(), Json::Int(i64::from(self.version)));
        Json::Obj(m)
    }
}

impl Ceiling {
    fn state(&self) -> Vec<u8> {
        let mut m = BTreeMap::new();
        m.insert("ceiling_bytes".into(), opt_int(self.ceiling_bytes));
        m.insert("locked".into(), Json::Bool(self.locked));
        m.insert("lock_reason".into(), opt_str(&self.lock_reason));
        m.insert("changed_by".into(), Json::Str(self.changed_by.clone()));
        Json::Obj(m).to_canonical_bytes()
    }

    async fn seal(&self, tx: &Transaction<'_>, ring: &KeyRing) -> Result<[u8; 32], SettingsError> {
        let key = grants::site_row_key(tx, ring).await?;
        Ok(authority::row_seal(
            &key,
            &RowFacts {
                table: "firmware_org_ceilings",
                row_id: &self.organisation,
                chain_seq: self.changed_seq,
                row_version: self.version,
                row_state: &self.state(),
            },
        ))
    }

    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("organisation".into(), Json::Str(self.organisation.clone()));
        m.insert("ceiling_bytes".into(), opt_int(self.ceiling_bytes));
        m.insert("locked".into(), Json::Bool(self.locked));
        m.insert("lock_reason".into(), opt_str(&self.lock_reason));
        m.insert("changed_at_unix".into(), Json::Int(self.changed_unix));
        m.insert("version".into(), Json::Int(i64::from(self.version)));
        Json::Obj(m)
    }
}

fn own_json(max_bytes: Option<i64>, fetch_base_url: &Option<String>) -> Json {
    let mut m = BTreeMap::new();
    m.insert("max_bytes".into(), opt_int(max_bytes));
    m.insert("fetch_base_url".into(), opt_str(fetch_base_url));
    Json::Obj(m)
}

impl OrgOwn {
    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("max_bytes".into(), opt_int(self.max_bytes));
        m.insert("fetch_base_url".into(), opt_str(&self.fetch_base_url));
        m.insert("set_at_unix".into(), opt_int(self.set_unix));
        Json::Obj(m)
    }
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

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// The admin's row, verified. No row: nothing saved, everything from the file.
pub async fn read_server(
    tx: &Transaction<'_>,
    ring: &KeyRing,
) -> Result<ServerSettings, SettingsError> {
    let Some(row) = tx
        .query_opt(
            "SELECT max_image_bytes, total_max_bytes, organisation_max_bytes, \
                    uploads_per_server, uploads_per_organisation, upload_idle_seconds, \
                    fetch_base_url, changed_by, extract(epoch FROM changed_at)::bigint, \
                    changed_seq, row_version, row_seal \
             FROM firmware_server_settings WHERE id = 'site'",
            &[],
        )
        .await?
    else {
        return Ok(ServerSettings::default());
    };
    let s = ServerSettings {
        saved: Saved {
            max_image_bytes: row.get(0),
            total_max_bytes: row.get(1),
            organisation_max_bytes: row.get(2),
            uploads_per_server: row.get(3),
            uploads_per_organisation: row.get(4),
            upload_idle_seconds: row.get(5),
            fetch_base_url: row.get(6),
        },
        changed_by: Some(row.get(7)),
        changed_unix: Some(row.get(8)),
        changed_seq: row.get(9),
        version: row.get(10),
    };
    let stored: Vec<u8> = row.get(11);
    if !crypto::ct_eq(&s.seal(tx, ring).await?, &stored) {
        return Err(SettingsError::Unverifiable(
            "firmware_server_settings row seal",
        ));
    }
    Ok(s)
}

fn ceiling_from(row: &tokio_postgres::Row) -> (Ceiling, Vec<u8>) {
    (
        Ceiling {
            organisation: row.get(0),
            ceiling_bytes: row.get(1),
            locked: row.get(2),
            lock_reason: row.get(3),
            changed_by: row.get(4),
            changed_unix: row.get(5),
            changed_seq: row.get(6),
            version: row.get(7),
        },
        row.get(8),
    )
}

const CEILING_COLUMNS: &str = "organisation_id, ceiling_bytes, locked, lock_reason, changed_by, \
     extract(epoch FROM changed_at)::bigint, changed_seq, row_version, row_seal";

/// One organisation's ceiling, verified. Readable in that organisation's context and the operator
/// plane's (`0062`).
pub async fn read_ceiling(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
) -> Result<Option<Ceiling>, SettingsError> {
    let Some(row) = tx
        .query_opt(
            &format!(
                "SELECT {CEILING_COLUMNS} FROM firmware_org_ceilings WHERE organisation_id = $1"
            ),
            &[&organisation],
        )
        .await?
    else {
        return Ok(None);
    };
    let (c, stored) = ceiling_from(&row);
    if !crypto::ct_eq(&c.seal(tx, ring).await?, &stored) {
        return Err(SettingsError::Unverifiable(
            "firmware_org_ceilings row seal",
        ));
    }
    Ok(Some(c))
}

/// The Stewards' own row. Read in the organisation's context, or the operator plane's.
pub async fn read_own(tx: &Transaction<'_>, organisation: &str) -> Result<OrgOwn, SettingsError> {
    Ok(tx
        .query_opt(
            "SELECT max_bytes, fetch_base_url, set_by, extract(epoch FROM set_at)::bigint \
             FROM firmware_org_settings WHERE organisation_id = $1",
            &[&organisation],
        )
        .await?
        .map(|r| OrgOwn {
            max_bytes: r.get(0),
            fetch_base_url: r.get(1),
            set_by: Some(r.get(2)),
            set_unix: Some(r.get(3)),
        })
        .unwrap_or_default())
}

/// What one organisation's uploads are held to now. Called in that organisation's context.
pub async fn limits_for(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    file: &FileValues,
    organisation: &str,
) -> Result<Limits, SettingsError> {
    let server = read_server(tx, ring).await?;
    let ceiling = read_ceiling(tx, ring, organisation).await?;
    let own = read_own(tx, organisation).await?;
    Ok(effective(file, &server.saved, ceiling.as_ref(), &own))
}

/// The server-wide half of [`Limits`]: what does not depend on an organisation (uploads at once,
/// the stall time, the download address, the largest image and the total). Readable with no
/// tenant set.
pub async fn server_limits(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    file: &FileValues,
) -> Result<Limits, SettingsError> {
    let server = read_server(tx, ring).await?;
    Ok(effective(file, &server.saved, None, &OrgOwn::default()))
}

// ---------------------------------------------------------------------------
// The admin's writes. The caller holds operator custody and has checked the operator is live.
// ---------------------------------------------------------------------------

/// Save the server's values. `saved` is the whole set: a `None` clears that value back to the
/// file's. Sealed on the site chain with the values before and after.
pub async fn operator_set_server(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    operator: &str,
    file: &FileValues,
    saved: Saved,
    if_version: i32,
) -> Result<ServerSettings, SettingsError> {
    let saved = check_saved(saved, file)?;
    let current = read_server(tx, ring).await?;
    if current.version != if_version {
        return Err(SettingsError::Conflict);
    }
    let appended = chains::append_site(
        tx,
        ring,
        deployment,
        EntryType::FirmwareServerSettingsChanged,
        &metadata(
            EntryType::FirmwareServerSettingsChanged,
            &[
                ("operator", Json::Str(operator.to_string())),
                ("before", current.saved.to_json()),
                ("after", saved.to_json()),
            ],
        ),
    )
    .await?;
    let next = ServerSettings {
        saved,
        changed_by: Some(operator.to_string()),
        changed_unix: Some(crypto::now_unix()),
        changed_seq: appended.seq,
        version: current.version + 1,
    };
    let seal = next.seal(tx, ring).await?.to_vec();
    let s = &next.saved;
    let changed = if current.version == 0 {
        tx.execute(
            "INSERT INTO firmware_server_settings (id, max_image_bytes, total_max_bytes, \
                 organisation_max_bytes, uploads_per_server, uploads_per_organisation, \
                 upload_idle_seconds, fetch_base_url, changed_by, changed_seq, row_version, \
                 row_seal) \
             VALUES ('site', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
            &[
                &s.max_image_bytes,
                &s.total_max_bytes,
                &s.organisation_max_bytes,
                &s.uploads_per_server,
                &s.uploads_per_organisation,
                &s.upload_idle_seconds,
                &s.fetch_base_url,
                &operator,
                &next.changed_seq,
                &next.version,
                &seal,
            ],
        )
        .await?
    } else {
        tx.execute(
            "UPDATE firmware_server_settings SET max_image_bytes = $1, total_max_bytes = $2, \
                 organisation_max_bytes = $3, uploads_per_server = $4, \
                 uploads_per_organisation = $5, upload_idle_seconds = $6, fetch_base_url = $7, \
                 changed_by = $8, changed_at = now(), changed_seq = $9, row_version = $10, \
                 row_seal = $11 \
             WHERE id = 'site' AND row_version = $10 - 1",
            &[
                &s.max_image_bytes,
                &s.total_max_bytes,
                &s.organisation_max_bytes,
                &s.uploads_per_server,
                &s.uploads_per_organisation,
                &s.upload_idle_seconds,
                &s.fetch_base_url,
                &operator,
                &next.changed_seq,
                &next.version,
                &seal,
            ],
        )
        .await?
    };
    if changed != 1 {
        return Err(SettingsError::Conflict);
    }
    Ok(next)
}

/// Set one organisation's ceiling and lock. Filed on the organisation's chain, so its Stewards see
/// it on their page, and on the site chain, so the operator plane's record has it too (as an
/// admin's AI key disable is). `if_version` is 0 when the organisation has no row yet.
#[allow(clippy::too_many_arguments)]
pub async fn operator_set_ceiling(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    deployment: &str,
    operator: &str,
    session: &str,
    organisation: &str,
    ceiling_bytes: Option<i64>,
    locked: bool,
    lock_reason: &str,
    if_version: i32,
) -> Result<Ceiling, SettingsError> {
    let ceiling_bytes = ceiling_bytes.map(check_bytes).transpose()?;
    let lock_reason = check_reason(lock_reason)?;
    if locked && lock_reason.is_none() {
        return Err(SettingsError::Malformed(
            "say why, so the organisation's Stewards know: a lock needs a reason",
        ));
    }
    let lock_reason = if locked { lock_reason } else { None };
    repo::enter_operator_tenant_scope(tx, organisation).await?;
    // The organisation must exist; its id came from the admin's request. Asked inside
    // its scope, which is what lets the row be seen.
    let exists = tx
        .query_opt(
            "SELECT 1 FROM organisations WHERE id = $1",
            &[&organisation],
        )
        .await?;
    if exists.is_none() {
        return Err(SettingsError::Malformed("no such organisation"));
    }
    let current = read_ceiling(tx, ring, organisation).await?;
    if current.as_ref().map_or(0, |c| c.version) != if_version {
        return Err(SettingsError::Conflict);
    }
    let before = current.as_ref().map_or(Json::Null, |c| {
        let mut m = BTreeMap::new();
        m.insert("ceiling_bytes".into(), opt_int(c.ceiling_bytes));
        m.insert("locked".into(), Json::Bool(c.locked));
        m.insert("lock_reason".into(), opt_str(&c.lock_reason));
        Json::Obj(m)
    });
    let after = {
        let mut m = BTreeMap::new();
        m.insert("ceiling_bytes".into(), opt_int(ceiling_bytes));
        m.insert("locked".into(), Json::Bool(locked));
        m.insert("lock_reason".into(), opt_str(&lock_reason));
        Json::Obj(m)
    };
    let tenant_key = keys::tenant_key_for(tx, ring, organisation).await?;
    let appended = chains::append_org_as(
        tx,
        ring,
        organisation,
        operator,
        &tenant_key,
        EntryType::FirmwareCeilingChanged,
        &metadata(
            EntryType::FirmwareCeilingChanged,
            &[
                ("by", Json::Str(operator.to_string())),
                ("by_kind", Json::Str("operator".into())),
                ("before", before.clone()),
                ("after", after.clone()),
            ],
        ),
    )
    .await?;
    let next = Ceiling {
        organisation: organisation.to_string(),
        ceiling_bytes,
        locked,
        lock_reason,
        changed_by: operator.to_string(),
        changed_unix: crypto::now_unix(),
        changed_seq: appended.seq,
        version: if_version + 1,
    };
    let seal = next.seal(tx, ring).await?.to_vec();
    let changed = if if_version == 0 {
        tx.execute(
            "INSERT INTO firmware_org_ceilings (organisation_id, ceiling_bytes, locked, \
                 lock_reason, changed_by, changed_seq, row_version, row_seal) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            &[
                &organisation,
                &next.ceiling_bytes,
                &next.locked,
                &next.lock_reason,
                &operator,
                &next.changed_seq,
                &next.version,
                &seal,
            ],
        )
        .await?
    } else {
        tx.execute(
            "UPDATE firmware_org_ceilings SET ceiling_bytes = $2, locked = $3, lock_reason = $4, \
                 changed_by = $5, changed_at = now(), changed_seq = $6, row_version = $7, \
                 row_seal = $8 \
             WHERE organisation_id = $1 AND row_version = $7 - 1",
            &[
                &organisation,
                &next.ceiling_bytes,
                &next.locked,
                &next.lock_reason,
                &operator,
                &next.changed_seq,
                &next.version,
                &seal,
            ],
        )
        .await?
    };
    if changed != 1 {
        return Err(SettingsError::Conflict);
    }
    chains::append_site(
        tx,
        ring,
        deployment,
        EntryType::FirmwareCeilingChanged,
        &metadata(
            EntryType::FirmwareCeilingChanged,
            &[
                ("organisation", Json::Str(organisation.to_string())),
                ("operator", Json::Str(operator.to_string())),
                ("session", Json::Str(session.to_string())),
                ("before", before),
                ("after", after),
            ],
        ),
    )
    .await?;
    Ok(next)
}

/// Every organisation's ceiling and own total, for the Admin page, each with whether its seal
/// verifies. A row that does not is shown so marked rather than refusing the page, so the admin
/// can see and fix it; [`limits_for`] still refuses to use it. Operator custody.
pub async fn operator_list(
    tx: &Transaction<'_>,
    ring: &KeyRing,
) -> Result<Vec<(Ceiling, OrgOwn, bool)>, SettingsError> {
    let rows = tx
        .query(
            &format!(
                "SELECT {CEILING_COLUMNS} FROM firmware_org_ceilings ORDER BY organisation_id"
            ),
            &[],
        )
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let (c, stored) = ceiling_from(row);
        let verifies = crypto::ct_eq(&c.seal(tx, ring).await?, &stored);
        let own = read_own(tx, &c.organisation).await?;
        out.push((c, own, verifies));
    }
    Ok(out)
}

/// The Stewards' own total and download address, as the Steward page sets them. A `None` clears
/// that one back to the ceiling or the server's address. Refused while the admin has the
/// organisation locked, or above the ceiling. Sealed on the organisation's chain with both before
/// and after. The caller has authorised a Steward in this organisation's context.
#[allow(clippy::too_many_arguments)]
pub async fn steward_set_own(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    file: &FileValues,
    organisation: &str,
    account: &str,
    max_bytes: Option<i64>,
    fetch_base_url: Option<String>,
) -> Result<Limits, SettingsError> {
    let max_bytes = max_bytes.map(check_bytes).transpose()?;
    let fetch_base_url = fetch_base_url
        .as_deref()
        .map(check_fetch_base_url)
        .transpose()?;
    let server = read_server(tx, ring).await?;
    let ceiling = read_ceiling(tx, ring, organisation).await?;
    if ceiling.as_ref().is_some_and(|c| c.locked) {
        return Err(SettingsError::Locked);
    }
    let current = read_own(tx, organisation).await?;
    let limits_now = effective(file, &server.saved, ceiling.as_ref(), &current);
    if let Some(v) = max_bytes {
        if v as u64 > limits_now.organisation_ceiling {
            return Err(SettingsError::OverCeiling {
                ceiling: limits_now.organisation_ceiling,
            });
        }
    }
    let tenant_key = keys::tenant_key_for(tx, ring, organisation).await?;
    chains::append_org_as(
        tx,
        ring,
        organisation,
        account,
        &tenant_key,
        EntryType::FirmwareOrgSettingsChanged,
        &metadata(
            EntryType::FirmwareOrgSettingsChanged,
            &[
                ("by", Json::Str(account.to_string())),
                (
                    "before",
                    own_json(current.max_bytes, &current.fetch_base_url),
                ),
                ("after", own_json(max_bytes, &fetch_base_url)),
            ],
        ),
    )
    .await?;
    tx.execute(
        "INSERT INTO firmware_org_settings (organisation_id, max_bytes, fetch_base_url, set_by) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (organisation_id) DO UPDATE \
             SET max_bytes = EXCLUDED.max_bytes, fetch_base_url = EXCLUDED.fetch_base_url, \
                 set_by = EXCLUDED.set_by, set_at = now()",
        &[&organisation, &max_bytes, &fetch_base_url, &account],
    )
    .await?;
    let own = OrgOwn {
        max_bytes,
        fetch_base_url,
        set_by: Some(account.to_string()),
        set_unix: Some(crypto::now_unix()),
    };
    Ok(effective(file, &server.saved, ceiling.as_ref(), &own))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file() -> FileValues {
        FileValues {
            max_image_bytes: 2 << 30,
            total_max_bytes: 50 << 30,
            organisation_max_bytes: 20 << 30,
            uploads_per_server: 3,
            uploads_per_organisation: 1,
            upload_idle_seconds: 120,
            fetch_base_url: "https://fathom.example".into(),
        }
    }

    fn ceiling(bytes: Option<i64>, locked: bool) -> Ceiling {
        Ceiling {
            organisation: "o".into(),
            ceiling_bytes: bytes,
            locked,
            lock_reason: locked.then(|| "busy".into()),
            changed_by: "op".into(),
            changed_unix: 1,
            changed_seq: 1,
            version: 1,
        }
    }

    #[test]
    fn nothing_saved_is_the_settings_file() {
        let l = effective(&file(), &Saved::default(), None, &OrgOwn::default());
        assert_eq!(l.max_image_bytes, 2 << 30);
        assert_eq!(l.organisation_ceiling, 20 << 30);
        assert_eq!(l.organisation_max_bytes, 20 << 30);
        assert_eq!(l.uploads_per_server, 3);
        assert_eq!(l.upload_idle, Duration::from_secs(120));
        assert_eq!(l.fetch_base_url, "https://fathom.example");
    }

    #[test]
    fn a_saved_value_wins_over_the_file() {
        let saved = Saved {
            organisation_max_bytes: Some(5 << 30),
            uploads_per_server: Some(6),
            fetch_base_url: Some("http://10.0.0.5:8080".into()),
            ..Saved::default()
        };
        let l = effective(&file(), &saved, None, &OrgOwn::default());
        assert_eq!(l.organisation_ceiling, 5 << 30);
        assert_eq!(l.uploads_per_server, 6);
        assert_eq!(l.fetch_base_url, "http://10.0.0.5:8080");
        assert_eq!(
            l.total_max_bytes,
            50 << 30,
            "untouched values stay the file's"
        );
    }

    #[test]
    fn a_steward_can_go_under_the_ceiling_never_over_and_not_at_all_while_locked() {
        let own = |v| OrgOwn {
            max_bytes: Some(v),
            ..OrgOwn::default()
        };
        let c = ceiling(Some(10 << 30), false);
        assert_eq!(
            effective(&file(), &Saved::default(), Some(&c), &own(4 << 30)).organisation_max_bytes,
            4 << 30
        );
        assert_eq!(
            effective(&file(), &Saved::default(), Some(&c), &own(40 << 30)).organisation_max_bytes,
            10 << 30,
            "a value above the ceiling (the ceiling lowered after it was set) is held to it"
        );
        let locked = ceiling(Some(10 << 30), true);
        assert_eq!(
            effective(&file(), &Saved::default(), Some(&locked), &own(4 << 30))
                .organisation_max_bytes,
            10 << 30,
            "while locked the ceiling is the total"
        );
        let default = ceiling(None, false);
        assert_eq!(
            effective(
                &file(),
                &Saved::default(),
                Some(&default),
                &OrgOwn::default()
            )
            .organisation_ceiling,
            20 << 30,
            "no ceiling of its own: the server's default"
        );
    }

    #[test]
    fn a_stewards_download_address_wins_unless_locked() {
        let own = OrgOwn {
            fetch_base_url: Some("http://192.0.2.10:8080".into()),
            ..OrgOwn::default()
        };
        assert_eq!(
            effective(&file(), &Saved::default(), None, &own).fetch_base_url,
            "http://192.0.2.10:8080"
        );
        let locked = ceiling(None, true);
        assert_eq!(
            effective(&file(), &Saved::default(), Some(&locked), &own).fetch_base_url,
            "https://fathom.example",
            "locked: the server's address"
        );
    }

    #[test]
    fn values_out_of_range_are_refused() {
        assert!(check_bytes(1000).is_err());
        assert!(check_bytes(MAX_BYTES + 1).is_err());
        assert!(check_bytes(MIN_BYTES).is_ok());
        let f = file();
        assert!(
            check_saved(
                Saved {
                    max_image_bytes: Some(60 << 30),
                    ..Saved::default()
                },
                &f
            )
            .is_err(),
            "an image larger than the server's total"
        );
        assert!(
            check_saved(
                Saved {
                    uploads_per_organisation: Some(5),
                    ..Saved::default()
                },
                &f
            )
            .is_err(),
            "more per organisation than per server"
        );
        assert!(check_saved(
            Saved {
                upload_idle_seconds: Some(5),
                ..Saved::default()
            },
            &f
        )
        .is_err());
    }

    #[test]
    fn the_download_address_must_be_plain() {
        for good in [
            "https://firmware.example.com",
            "http://10.0.0.5:8080",
            "https://fathom.example/fw/",
            "http://[fd00::5]:80",
        ] {
            assert!(check_fetch_base_url(good).is_ok(), "{good}");
        }
        for bad in [
            "ftp://x.example",
            "https://",
            "https://user@x.example",
            "https://x.example/a b",
            "https://x.example/?q=1",
            "https://x.example/#f",
            "https://x.example;reboot",
            "https://x.example/'",
            "https://x.example//evil",
            "x.example",
        ] {
            assert!(check_fetch_base_url(bad).is_err(), "{bad}");
        }
        assert_eq!(
            check_fetch_base_url(" https://fathom.example/ ").unwrap(),
            "https://fathom.example"
        );
    }

    #[test]
    fn a_lock_reason_that_looks_like_a_password_is_refused() {
        assert!(check_reason("over budget until January").is_ok());
        assert_eq!(check_reason("   ").unwrap(), None);
        assert!(check_reason(&"a".repeat(301)).is_err());
        assert!(check_reason("bad\u{200b}").is_err());
    }
}
