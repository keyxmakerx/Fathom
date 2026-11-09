//! Faceplate templates, one shared list per organisation (migration `0076`, sign-off r111).
//!
//! A template is a saved set of hand-typed ports (a 24-port keystone panel, say) to start a new
//! box from. It is never a design field: adding one to a box is an ordinary design edit made in
//! the browser. The name, the box's role and the ports are one JSON blob sealed under the
//! organisation content key, with tenant, template id, maker and key epoch in the associated
//! data. There is no plaintext copy and no chain entry (r111 pick A).
//!
//! Anyone holding `draw` somewhere in the organisation may save one; its maker (while they still
//! draw) or a Steward may remove it. A template is never edited: saving under a name that is
//! already taken sends the old one's id as `replaces`, and both happen in one transaction.

use std::collections::BTreeMap;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::crypto;
use crate::designs::DesignError;
use crate::field_defs::{is_unsafe_char, require_draw};
use crate::grants::{self, Authority, AuthorityError};
use crate::keys;

const AAD_TEMPLATE: &[u8] = b"fathom/faceplate-template/v1";

/// Per organisation, so a loop of saves cannot grow the list.
pub const MAX_TEMPLATES: i64 = 200;
/// `client/src/document/plate.ts`'s `MAX_PORTS_PER_BATCH`: a template adds its ports in one batch.
pub const MAX_PORTS: usize = 256;
pub const MAX_NAME_CHARS: usize = 100;
pub const MAX_ROLE_CHARS: usize = 64;
pub const MAX_LABEL_CHARS: usize = 200;
const MAX_TOKEN_CHARS: usize = 32;
/// `client/src/document/plate.ts`'s `PLATE_SPAN`.
const PLATE_SPAN: i64 = 1000;

/// One port as a template carries it, in the shape `client/src/document/plate.ts`'s
/// `TemplatePort` has. The connector, service and face words are checked as words here and
/// against the engine's lists in the browser, which drops a port it does not know.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplatePort {
    pub label: String,
    pub connector: String,
    pub service: Option<String>,
    pub face: String,
    pub plate: Option<(i64, i64)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaceplateTemplate {
    pub id: String,
    pub name: String,
    pub role: Option<String>,
    pub ports: Vec<TemplatePort>,
    pub created_by: String,
}

fn bad(why: &'static str) -> DesignError {
    DesignError::InvalidTemplate(why)
}

impl TemplatePort {
    fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("label".to_string(), Json::Str(self.label.clone()));
        m.insert("connector".to_string(), Json::Str(self.connector.clone()));
        if let Some(s) = &self.service {
            m.insert("service".to_string(), Json::Str(s.clone()));
        }
        m.insert("face".to_string(), Json::Str(self.face.clone()));
        if let Some((x, y)) = self.plate {
            let mut at = BTreeMap::new();
            at.insert("x".to_string(), Json::Int(x));
            at.insert("y".to_string(), Json::Int(y));
            m.insert("plate".to_string(), Json::Obj(at));
        }
        Json::Obj(m)
    }

    /// One port from the request or from a sealed body. Refuses anything it does not expect.
    fn from_json(j: Json) -> Result<Self, DesignError> {
        const WHY: &str = "a template port is {label, connector, face, service?, plate?}: a label of \
                           1 to 200 characters, words of 1 to 32 lower-case letters, digits, - or _, \
                           and a plate place of two whole numbers from 0 to 1000";
        let Json::Obj(mut m) = j else {
            return Err(bad(WHY));
        };
        if !m
            .keys()
            .all(|k| ["label", "connector", "service", "face", "plate"].contains(&k.as_str()))
        {
            return Err(bad(WHY));
        }
        let label = match m.remove("label") {
            Some(Json::Str(s)) => clean_text(&s, MAX_LABEL_CHARS, WHY)?,
            _ => return Err(bad(WHY)),
        };
        let connector = match m.remove("connector") {
            Some(Json::Str(s)) if is_word(&s) => s,
            _ => return Err(bad(WHY)),
        };
        let face = match m.remove("face") {
            Some(Json::Str(s)) if is_word(&s) => s,
            _ => return Err(bad(WHY)),
        };
        let service = match m.remove("service") {
            None => None,
            Some(Json::Str(s)) if is_word(&s) => Some(s),
            _ => return Err(bad(WHY)),
        };
        let plate = match m.remove("plate") {
            None => None,
            Some(Json::Obj(mut at)) if at.len() == 2 => match (at.remove("x"), at.remove("y")) {
                (Some(Json::Int(x)), Some(Json::Int(y)))
                    if (0..=PLATE_SPAN).contains(&x) && (0..=PLATE_SPAN).contains(&y) =>
                {
                    Some((x, y))
                }
                _ => return Err(bad(WHY)),
            },
            _ => return Err(bad(WHY)),
        };
        Ok(Self {
            label,
            connector,
            service,
            face,
            plate,
        })
    }
}

impl FaceplateTemplate {
    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        m.insert("id".to_string(), Json::Str(self.id.clone()));
        m.insert("name".to_string(), Json::Str(self.name.clone()));
        m.insert(
            "role".to_string(),
            self.role.clone().map(Json::Str).unwrap_or(Json::Null),
        );
        m.insert(
            "ports".to_string(),
            Json::Arr(self.ports.iter().map(TemplatePort::to_json).collect()),
        );
        m.insert("createdBy".to_string(), Json::Str(self.created_by.clone()));
        Json::Obj(m)
    }
}

/// A connector, service or face word: what the engine's own lists hold.
fn is_word(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_TOKEN_CHARS
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// Control and invisible characters refused; runs of white space become one space.
fn clean_text(raw: &str, max: usize, why: &'static str) -> Result<String, DesignError> {
    if raw.chars().any(is_unsafe_char) {
        return Err(bad(why));
    }
    let t = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() || t.chars().count() > max {
        return Err(bad(why));
    }
    Ok(t)
}

pub fn clean_name(raw: &str) -> Result<String, DesignError> {
    clean_text(
        raw,
        MAX_NAME_CHARS,
        "a template name is 1 to 100 characters, without control or invisible characters",
    )
}

pub fn clean_role(raw: Option<&str>) -> Result<Option<String>, DesignError> {
    match raw {
        None => Ok(None),
        Some(r) if r.trim().is_empty() => Ok(None),
        Some(r) => clean_text(
            r,
            MAX_ROLE_CHARS,
            "a template role is at most 64 characters, without control or invisible characters",
        )
        .map(Some),
    }
}

/// The ports from a request body's array.
pub fn ports_from_json(items: Vec<Json>) -> Result<Vec<TemplatePort>, DesignError> {
    if items.len() > MAX_PORTS {
        return Err(bad("a template holds at most 256 ports"));
    }
    items.into_iter().map(TemplatePort::from_json).collect()
}

fn aad(tenant: &str, id: &str, created_by: &str, epoch: i32) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, AAD_TEMPLATE);
    crypto::lp(&mut a, tenant.as_bytes());
    crypto::lp(&mut a, id.as_bytes());
    crypto::lp(&mut a, created_by.as_bytes());
    crypto::u32_le(&mut a, epoch as u32);
    a
}

fn body_bytes(name: &str, role: Option<&str>, ports: &[TemplatePort]) -> Vec<u8> {
    let mut body = BTreeMap::new();
    body.insert("name".to_string(), Json::Str(name.to_string()));
    body.insert(
        "role".to_string(),
        role.map(|r| Json::Str(r.to_string())).unwrap_or(Json::Null),
    );
    body.insert(
        "ports".to_string(),
        Json::Arr(ports.iter().map(TemplatePort::to_json).collect()),
    );
    Json::Obj(body).to_canonical_bytes()
}

fn open_body(plain: &[u8]) -> Result<(String, Option<String>, Vec<TemplatePort>), DesignError> {
    let corrupt = || DesignError::Corrupt("faceplate template");
    let Ok(Json::Obj(mut m)) = Json::parse_canonical(plain) else {
        return Err(corrupt());
    };
    let name = match m.remove("name") {
        Some(Json::Str(s)) => s,
        _ => return Err(corrupt()),
    };
    let role = match m.remove("role") {
        Some(Json::Str(s)) => Some(s),
        Some(Json::Null) => None,
        _ => return Err(corrupt()),
    };
    let ports = match m.remove("ports") {
        Some(Json::Arr(items)) => items
            .into_iter()
            .map(TemplatePort::from_json)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| corrupt())?,
        _ => return Err(corrupt()),
    };
    Ok((name, role, ports))
}

/// Every template in the organisation, oldest first. Any member may read; the caller has
/// already opened a tenant context.
pub async fn list(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
) -> Result<Vec<FaceplateTemplate>, DesignError> {
    let tenant = auth.ctx.tenant().to_string();
    let rows = tx
        .query(
            "SELECT id, created_by, key_epoch, ciphertext, nonce FROM faceplate_templates \
             WHERE organisation_id = $1 ORDER BY created_at, id",
            &[&tenant],
        )
        .await?;
    let mut keys_by_epoch: BTreeMap<i32, crypto::Key32> = BTreeMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: String = row.get(0);
        let created_by: String = row.get(1);
        let epoch: i32 = row.get(2);
        if let std::collections::btree_map::Entry::Vacant(slot) = keys_by_epoch.entry(epoch) {
            slot.insert(
                keys::org_content_key_at_epoch(tx, auth.ctx, auth.tenant_key, epoch).await?,
            );
        }
        let nonce: [u8; crypto::NONCE_LEN] = row
            .get::<_, Vec<u8>>(4)
            .try_into()
            .map_err(|_| DesignError::Corrupt("faceplate template nonce"))?;
        let plain = crypto::open(
            &keys_by_epoch[&epoch],
            &nonce,
            &row.get::<_, Vec<u8>>(3),
            &aad(&tenant, &id, &created_by, epoch),
        )
        .map_err(|_| DesignError::Refused)?;
        let (name, role, ports) = open_body(&plain)?;
        out.push(FaceplateTemplate {
            id,
            name,
            role,
            ports,
            created_by,
        });
    }
    Ok(out)
}

/// The organisation's template list is changed one transaction at a time. A row lock is not an
/// option: `FOR UPDATE` needs an UPDATE grant, which the app role does not hold on this table.
async fn lock_list(tx: &Transaction<'_>, tenant: &str) -> Result<(), DesignError> {
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        &[&format!("faceplate_templates:{tenant}")],
    )
    .await?;
    Ok(())
}

/// May the caller remove this template? The caller holds [`lock_list`]. Its maker while they still hold `draw`, or a Steward.
/// Refused the same way whether the row exists or not, so the answer never says which ids are
/// real; a Steward, who can list them all anyway, is told "no such template".
async fn lock_for_removal(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
) -> Result<(), DesignError> {
    let row = tx
        .query_opt(
            "SELECT created_by FROM faceplate_templates \
             WHERE organisation_id = $1 AND id = $2",
            &[&auth.ctx.tenant().to_string(), &id],
        )
        .await?;
    let steward = grants::is_steward(tx, auth)
        .await
        .map_err(DesignError::Authority)?;
    let maker = row
        .as_ref()
        .is_some_and(|r| r.get::<_, String>(0) == auth.ctx.actor().to_string());
    if !steward && !maker {
        return Err(DesignError::Authority(AuthorityError::NotAuthorised));
    }
    if !steward {
        require_draw(tx, auth).await?;
    }
    row.map(|_| ()).ok_or(DesignError::NoSuchTemplate)
}

/// Save a template, removing `replaces` in the same transaction when it is given. Needs `draw`
/// somewhere in the organisation, and the right to remove `replaces`.
pub async fn create(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    name: &str,
    role: Option<&str>,
    ports: Vec<TemplatePort>,
    replaces: Option<&str>,
) -> Result<FaceplateTemplate, DesignError> {
    require_draw(tx, auth).await?;
    let name = clean_name(name)?;
    let role = clean_role(role)?;
    if ports.len() > MAX_PORTS {
        return Err(bad("a template holds at most 256 ports"));
    }

    let tenant = auth.ctx.tenant().to_string();
    lock_list(tx, &tenant).await?;
    if let Some(old) = replaces {
        lock_for_removal(tx, auth, old).await?;
        tx.execute(
            "DELETE FROM faceplate_templates WHERE organisation_id = $1 AND id = $2",
            &[&tenant, &old],
        )
        .await?;
    }
    let count: i64 = tx
        .query_one(
            "SELECT count(*) FROM faceplate_templates WHERE organisation_id = $1",
            &[&tenant],
        )
        .await?
        .get(0);
    if count >= MAX_TEMPLATES {
        return Err(bad(
            "this organisation has reached its limit of 200 faceplate templates; remove one first",
        ));
    }

    let id = crate::ids::new_ulid().to_string();
    let actor = auth.ctx.actor().to_string();
    let key = keys::org_content_key(tx, auth.ctx, auth.tenant_key).await?;
    let nonce = crypto::random_nonce()?;
    let ciphertext = crypto::seal(
        &key.key,
        &nonce,
        &body_bytes(&name, role.as_deref(), &ports),
        &aad(&tenant, &id, &actor, key.epoch),
    )?;
    keys::count_write_under_org_content_key(tx, &tenant, key.epoch).await?;
    tx.execute(
        "INSERT INTO faceplate_templates \
         (organisation_id, id, created_by, key_epoch, ciphertext, nonce) \
         VALUES ($1, $2, $3, $4, $5, $6)",
        &[
            &tenant,
            &id,
            &actor,
            &key.epoch,
            &ciphertext,
            &nonce.to_vec(),
        ],
    )
    .await?;
    Ok(FaceplateTemplate {
        id,
        name,
        role,
        ports,
        created_by: actor,
    })
}

/// Remove a template. Its maker (while they draw) or a Steward.
pub async fn remove(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    id: &str,
) -> Result<(), DesignError> {
    let tenant = auth.ctx.tenant().to_string();
    lock_list(tx, &tenant).await?;
    lock_for_removal(tx, auth, id).await?;
    tx.execute(
        "DELETE FROM faceplate_templates WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &id],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(label: &str) -> Json {
        let mut m = BTreeMap::new();
        m.insert("label".to_string(), Json::Str(label.to_string()));
        m.insert("connector".to_string(), Json::Str("rj45".to_string()));
        m.insert("face".to_string(), Json::Str("front".to_string()));
        Json::Obj(m)
    }

    #[test]
    fn a_port_round_trips_through_the_sealed_body() {
        let mut p = port("1");
        if let Json::Obj(m) = &mut p {
            m.insert("service".to_string(), Json::Str("data".to_string()));
            let mut at = BTreeMap::new();
            at.insert("x".to_string(), Json::Int(0));
            at.insert("y".to_string(), Json::Int(1000));
            m.insert("plate".to_string(), Json::Obj(at));
        }
        let ports = ports_from_json(vec![p, port("2")]).unwrap();
        let bytes = body_bytes("Keystone 24", Some("patch-panel"), &ports);
        let (name, role, back) = open_body(&bytes).unwrap();
        assert_eq!(name, "Keystone 24");
        assert_eq!(role.as_deref(), Some("patch-panel"));
        assert_eq!(back, ports);
        assert_eq!(back[0].plate, Some((0, 1000)));
    }

    #[test]
    fn a_port_with_an_unknown_key_or_a_bad_word_is_refused() {
        let mut extra = port("1");
        if let Json::Obj(m) = &mut extra {
            m.insert("secret".to_string(), Json::Str("x".to_string()));
        }
        assert!(ports_from_json(vec![extra]).is_err());
        let mut upper = port("1");
        if let Json::Obj(m) = &mut upper {
            m.insert("connector".to_string(), Json::Str("RJ45".to_string()));
        }
        assert!(ports_from_json(vec![upper]).is_err());
        let mut off_plate = port("1");
        if let Json::Obj(m) = &mut off_plate {
            let mut at = BTreeMap::new();
            at.insert("x".to_string(), Json::Int(1001));
            at.insert("y".to_string(), Json::Int(0));
            m.insert("plate".to_string(), Json::Obj(at));
        }
        assert!(ports_from_json(vec![off_plate]).is_err());
    }

    #[test]
    fn labels_and_names_refuse_invisible_characters_and_overlong_text() {
        assert!(ports_from_json(vec![port("a\u{202E}b")]).is_err());
        assert!(ports_from_json(vec![port("")]).is_err());
        assert!(ports_from_json(vec![port(&"x".repeat(201))]).is_err());
        assert_eq!(
            ports_from_json(vec![port("  Gi 1/0/1  ")]).unwrap()[0].label,
            "Gi 1/0/1"
        );
        assert!(clean_name(&"n".repeat(101)).is_err());
        assert!(clean_name("a\u{200B}b").is_err());
        assert_eq!(clean_role(Some("  ")).unwrap(), None);
    }

    #[test]
    fn at_most_256_ports() {
        let many: Vec<Json> = (0..257).map(|i| port(&i.to_string())).collect();
        assert!(ports_from_json(many).is_err());
        let enough: Vec<Json> = (0..256).map(|i| port(&i.to_string())).collect();
        assert_eq!(ports_from_json(enough).unwrap().len(), 256);
    }
}
