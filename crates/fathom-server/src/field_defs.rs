//! Custom-field definitions, one set per organisation (ADR-0062).
//!
//! A definition is a field's name, type and choices. It lives here, not in any
//! design, so every design in the organisation shares one list. The VALUES stay
//! in the design payload and carry the definition's id.
//!
//! The name, type and choices are one JSON blob sealed under the organisation
//! content key, with tenant, definition id, kind and key epoch in the associated
//! data. There is no plaintext copy. `kind`, `version`, `created_by` and
//! `archived` are plain columns because the server decides on them.

use std::collections::BTreeMap;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::crypto;
use crate::designs::DesignError;
use crate::grants::{Authority, AuthorityError};
use crate::keys;
use crate::repo::Role;

const AAD_FIELD_DEF: &[u8] = b"fathom/field-definition/v1";

pub const KINDS: [&str; 5] = ["device", "rack", "cable", "port", "network"];
pub const TYPES: [&str; 5] = ["text", "number", "date", "choice", "url"];
pub const MAX_NAME_CHARS: usize = 100;
pub const MAX_CHOICES: usize = 100;
pub const MAX_CHOICE_CHARS: usize = 100;
/// Live and archived together, so a loop of creates cannot grow the list.
pub const MAX_DEFINITIONS: i64 = 500;

/// One definition as the API returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FieldDefinition {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub ty: String,
    pub choices: Vec<String>,
    pub version: i64,
    pub created_by: String,
    pub archived: bool,
}

impl FieldDefinition {
    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("id".to_string(), Json::Str(self.id.clone()));
        m.insert("kind".to_string(), Json::Str(self.kind.clone()));
        m.insert("name".to_string(), Json::Str(self.name.clone()));
        m.insert("type".to_string(), Json::Str(self.ty.clone()));
        m.insert(
            "choices".to_string(),
            Json::Arr(self.choices.iter().cloned().map(Json::Str).collect()),
        );
        m.insert("version".to_string(), Json::Int(self.version));
        m.insert("createdBy".to_string(), Json::Str(self.created_by.clone()));
        m.insert("archived".to_string(), Json::Bool(self.archived));
        Json::Obj(m)
    }
}

fn bad(why: &'static str) -> DesignError {
    DesignError::InvalidFieldDefinition(why)
}

/// Control, line/paragraph separator and invisible or bidi-override characters,
/// which could make a name display as something else.
fn is_unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{FEFF}')
}

fn clean_text(raw: &str, max: usize, what: &'static str) -> Result<String, DesignError> {
    let t = raw.trim();
    if t.is_empty() || t.chars().count() > max || t.chars().any(is_unsafe_char) {
        return Err(bad(what));
    }
    Ok(t.to_string())
}

pub fn clean_name(raw: &str) -> Result<String, DesignError> {
    clean_text(
        raw,
        MAX_NAME_CHARS,
        "a field name is 1 to 100 characters, without control or invisible characters",
    )
}

pub fn clean_choices(raw: &[String]) -> Result<Vec<String>, DesignError> {
    const WHY: &str = "choices: at most 100, each 1 to 100 characters, no repeats, \
                       without control or invisible characters";
    if raw.len() > MAX_CHOICES {
        return Err(bad(WHY));
    }
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for c in raw {
        let c = clean_text(c, MAX_CHOICE_CHARS, WHY)?;
        if out.contains(&c) {
            return Err(bad(WHY));
        }
        out.push(c);
    }
    Ok(out)
}

fn aad(tenant: &str, id: &str, kind: &str, epoch: i32) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, AAD_FIELD_DEF);
    crypto::lp(&mut a, tenant.as_bytes());
    crypto::lp(&mut a, id.as_bytes());
    crypto::lp(&mut a, kind.as_bytes());
    crypto::u32_le(&mut a, epoch as u32);
    a
}

struct Sealed {
    ciphertext: Vec<u8>,
    nonce: Vec<u8>,
    epoch: i32,
}

async fn seal_body(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
    kind: &str,
    name: &str,
    ty: &str,
    choices: &[String],
) -> Result<Sealed, DesignError> {
    let mut body = BTreeMap::new();
    body.insert("name".to_string(), Json::Str(name.to_string()));
    body.insert("type".to_string(), Json::Str(ty.to_string()));
    body.insert(
        "choices".to_string(),
        Json::Arr(choices.iter().cloned().map(Json::Str).collect()),
    );
    let plain = Json::Obj(body).to_canonical_bytes();
    let tenant = auth.ctx.tenant().to_string();
    let key = keys::org_content_key(tx, auth.ctx, auth.tenant_key).await?;
    let nonce = crypto::random_nonce()?;
    let ciphertext = crypto::seal(&key.key, &nonce, &plain, &aad(&tenant, id, kind, key.epoch))?;
    keys::count_write_under_org_content_key(tx, &tenant, key.epoch).await?;
    Ok(Sealed {
        ciphertext,
        nonce: nonce.to_vec(),
        epoch: key.epoch,
    })
}

const COLUMNS: &str = "id, kind, version, created_by, archived, ciphertext, nonce, key_epoch";

/// Opens definition rows, fetching each key epoch once per request.
struct Opener<'a> {
    auth: &'a Authority<'a>,
    keys: BTreeMap<i32, crypto::Key32>,
}

impl Opener<'_> {
    async fn open(
        &mut self,
        tx: &Transaction<'_>,
        row: &tokio_postgres::Row,
    ) -> Result<FieldDefinition, DesignError> {
        let id: String = row.get(0);
        let kind: String = row.get(1);
        let epoch: i32 = row.get(7);
        if !self.keys.contains_key(&epoch) {
            let key =
                keys::org_content_key_at_epoch(tx, self.auth.ctx, self.auth.tenant_key, epoch)
                    .await?;
            self.keys.insert(epoch, key);
        }
        let nonce: [u8; crypto::NONCE_LEN] = row
            .get::<_, Vec<u8>>(6)
            .try_into()
            .map_err(|_| DesignError::Corrupt("field definition nonce"))?;
        let tenant = self.auth.ctx.tenant().to_string();
        let plain = crypto::open(
            &self.keys[&epoch],
            &nonce,
            &row.get::<_, Vec<u8>>(5),
            &aad(&tenant, &id, &kind, epoch),
        )
        .map_err(|_| DesignError::Refused)?;
        let corrupt = || DesignError::Corrupt("field definition");
        let Ok(Json::Obj(mut m)) = Json::parse_canonical(&plain) else {
            return Err(corrupt());
        };
        let (Some(Json::Str(name)), Some(Json::Str(ty)), Some(Json::Arr(items))) =
            (m.remove("name"), m.remove("type"), m.remove("choices"))
        else {
            return Err(corrupt());
        };
        let choices = items
            .into_iter()
            .map(|j| match j {
                Json::Str(s) => Ok(s),
                _ => Err(corrupt()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(FieldDefinition {
            id,
            kind,
            name,
            ty,
            choices,
            version: row.get(2),
            created_by: row.get(3),
            archived: row.get(4),
        })
    }
}

/// Every definition in the organisation, archived ones included, oldest first.
/// Any member may read; the caller has already opened a tenant context.
pub async fn list(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
) -> Result<Vec<FieldDefinition>, DesignError> {
    let rows = tx
        .query(
            &format!(
                "SELECT {COLUMNS} FROM field_definitions WHERE organisation_id = $1 \
                 ORDER BY created_at, id"
            ),
            &[&auth.ctx.tenant().to_string()],
        )
        .await?;
    let mut opener = Opener {
        auth,
        keys: BTreeMap::new(),
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        out.push(opener.open(tx, row).await?);
    }
    Ok(out)
}

/// Create a definition. Any member may.
pub async fn create(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    kind: &str,
    name: &str,
    ty: &str,
    choices: &[String],
) -> Result<FieldDefinition, DesignError> {
    if !KINDS.contains(&kind) {
        return Err(bad("kind is one of device, rack, cable, port, network"));
    }
    if !TYPES.contains(&ty) {
        return Err(bad("type is one of text, number, date, choice, url"));
    }
    let name = clean_name(name)?;
    let choices = clean_choices(choices)?;
    if (ty == "choice") == choices.is_empty() {
        return Err(bad("a choice field needs choices; other types take none"));
    }

    let tenant = auth.ctx.tenant().to_string();
    let count: i64 = tx
        .query_one(
            "SELECT count(*) FROM field_definitions WHERE organisation_id = $1",
            &[&tenant],
        )
        .await?
        .get(0);
    if count >= MAX_DEFINITIONS {
        return Err(bad(
            "this organisation has reached its limit of field definitions",
        ));
    }

    let id = crate::ids::new_ulid().to_string();
    let sealed = seal_body(tx, auth, &id, kind, &name, ty, &choices).await?;
    let actor = auth.ctx.actor().to_string();
    tx.execute(
        "INSERT INTO field_definitions \
         (organisation_id, id, kind, created_by, ciphertext, nonce, key_epoch) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
        &[
            &tenant,
            &id,
            &kind,
            &actor,
            &sealed.ciphertext,
            &sealed.nonce,
            &sealed.epoch,
        ],
    )
    .await?;
    Ok(FieldDefinition {
        id,
        kind: kind.to_string(),
        name,
        ty: ty.to_string(),
        choices,
        version: 1,
        created_by: actor,
        archived: false,
    })
}

/// Lock the row, then decide. A caller who is neither the creator nor an
/// organisation admin is refused the same way whether the row exists or not, so
/// the answer never says which ids are real; only an admin, who can list them
/// all anyway, is told "no such field".
async fn lock_and_authorise(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
) -> Result<tokio_postgres::Row, DesignError> {
    let row = tx
        .query_opt(
            &format!(
                "SELECT {COLUMNS} FROM field_definitions \
                 WHERE organisation_id = $1 AND id = $2 FOR UPDATE"
            ),
            &[&auth.ctx.tenant().to_string(), &id],
        )
        .await?;
    let admin = auth.ctx.role() == Role::Admin;
    let creator = row
        .as_ref()
        .is_some_and(|r| r.get::<_, String>(3) == auth.ctx.actor().to_string());
    if !admin && !creator {
        return Err(DesignError::Authority(AuthorityError::NotAuthorised));
    }
    row.ok_or(DesignError::NoSuchFieldDefinition)
}

fn check_version(row: &tokio_postgres::Row, if_version: i64) -> Result<(), DesignError> {
    let current: i64 = row.get(2);
    if current != if_version {
        return Err(DesignError::FieldDefinitionConflict { current });
    }
    Ok(())
}

/// Rename and/or replace the choices. Creator or organisation admin only.
pub async fn update(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
    if_version: i64,
    name: Option<&str>,
    choices: Option<&[String]>,
) -> Result<FieldDefinition, DesignError> {
    let name = name.map(clean_name).transpose()?;
    let choices = choices.map(clean_choices).transpose()?;
    if name.is_none() && choices.is_none() {
        return Err(bad("nothing to change: send name or choices"));
    }
    let row = lock_and_authorise(tx, auth, id).await?;
    check_version(&row, if_version)?;
    let mut opener = Opener {
        auth,
        keys: BTreeMap::new(),
    };
    let mut def = opener.open(tx, &row).await?;
    if def.archived {
        return Err(bad("that field is archived"));
    }
    if let Some(n) = name {
        def.name = n;
    }
    if let Some(c) = choices {
        if (def.ty == "choice") == c.is_empty() {
            return Err(bad("a choice field needs choices; other types take none"));
        }
        def.choices = c;
    }
    let sealed = seal_body(tx, auth, id, &def.kind, &def.name, &def.ty, &def.choices).await?;
    tx.execute(
        "UPDATE field_definitions SET ciphertext = $3, nonce = $4, key_epoch = $5, \
         version = version + 1 WHERE organisation_id = $1 AND id = $2",
        &[
            &auth.ctx.tenant().to_string(),
            &id,
            &sealed.ciphertext,
            &sealed.nonce,
            &sealed.epoch,
        ],
    )
    .await?;
    def.version += 1;
    Ok(def)
}

/// Archive (the replacement for delete). Creator or organisation admin only.
pub async fn archive(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
    if_version: i64,
) -> Result<FieldDefinition, DesignError> {
    let row = lock_and_authorise(tx, auth, id).await?;
    check_version(&row, if_version)?;
    let mut opener = Opener {
        auth,
        keys: BTreeMap::new(),
    };
    let mut def = opener.open(tx, &row).await?;
    if def.archived {
        return Err(bad("that field is already archived"));
    }
    tx.execute(
        "UPDATE field_definitions SET archived = true, version = version + 1 \
         WHERE organisation_id = $1 AND id = $2",
        &[&auth.ctx.tenant().to_string(), &id],
    )
    .await?;
    def.archived = true;
    def.version += 1;
    Ok(def)
}
