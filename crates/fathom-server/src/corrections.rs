//! Cable corrections from the floor.
//!
//! Someone with `read` on a design's place sends one of three corrections about a cable:
//! `traced` (I walked it and it is right), `label` (the label should read X) or `not_here`
//! (it is actually here). Someone with `draw` there accepts or dismisses each. A correction
//! is never a graph node and never changes the record: accepting is an ordinary edit the
//! accepter makes in the client, which then marks the correction here.
//!
//! What enforces what, by function:
//! - [`authorise`]: the grant check, on the design's own scope, or on the organisation when
//!   the design does not exist, so a caller without the capability gets the identical
//!   `NotAuthorised` for a real and an invented design. Every public function starts here.
//! - [`create`]: `read`; typed text cleaned and credential-checked; per-cable, per-sender
//!   and per-design caps counted under an advisory lock; body sealed.
//! - [`list`]: `draw` sees every open correction on the design; `read` sees only its own.
//! - [`decide`]: `draw`; the row is locked, must be `open` and at the caller's version.
//! - [`aad`], [`Opener::open`]: the sealed text is bound to tenant, id, design, cable, kind,
//!   sender and key epoch, so moving it to another row fails to open.

use std::collections::BTreeMap;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::authority::Capability;
use crate::crypto;
use crate::designs::DesignError;
use crate::field_defs::is_unsafe_char;
use crate::grants::{self, Authority, AuthorityError};
use crate::keys;
use crate::repo::{DesignId, ScopeId};

const AAD_CORRECTION: &[u8] = b"fathom/cable-correction/v1";

pub const KINDS: [&str; 3] = ["traced", "label", "not_here"];
pub const MAX_LABEL_CHARS: usize = 200;
pub const MAX_WHERE_CHARS: usize = 500;
/// Open corrections one sender may have on one cable, on one design, and open on one design.
pub const MAX_OPEN_PER_SENDER_PER_CABLE: i64 = 5;
pub const MAX_OPEN_PER_SENDER_PER_DESIGN: i64 = 20;
pub const MAX_OPEN_PER_DESIGN: i64 = 200;
/// A Read sender's own list is the newest of these.
const MAX_OWN_LISTED: i64 = 200;
/// A Draw list also carries this many recently decided ones, for the cable's history.
const MAX_DECIDED_LISTED: i64 = 100;

/// One correction as the API returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Correction {
    pub id: String,
    pub design: String,
    pub cable: String,
    pub kind: String,
    pub text: String,
    pub sender: String,
    pub sender_name: String,
    pub created_ms: i64,
    pub state: String,
    pub decided_by: Option<String>,
    pub decided_ms: Option<i64>,
    pub version: i64,
}

impl Correction {
    pub fn to_json(&self) -> Json {
        let mut m = BTreeMap::new();
        let s = |v: &str| Json::Str(v.to_string());
        m.insert("id".to_string(), s(&self.id));
        m.insert("designId".to_string(), s(&self.design));
        m.insert("cable".to_string(), s(&self.cable));
        m.insert("kind".to_string(), s(&self.kind));
        m.insert("text".to_string(), s(&self.text));
        m.insert("sender".to_string(), s(&self.sender));
        m.insert("senderName".to_string(), s(&self.sender_name));
        m.insert("createdAt".to_string(), Json::Int(self.created_ms));
        m.insert("state".to_string(), s(&self.state));
        m.insert(
            "decidedBy".to_string(),
            self.decided_by.as_deref().map_or(Json::Null, s),
        );
        m.insert(
            "decidedAt".to_string(),
            self.decided_ms.map_or(Json::Null, Json::Int),
        );
        m.insert("version".to_string(), Json::Int(self.version));
        Json::Obj(m)
    }
}

fn bad(why: &'static str) -> DesignError {
    DesignError::InvalidCorrection(why)
}

/// A cable element id as the client writes it: `cable:` and a ULID, in its canonical form.
pub fn clean_cable(raw: &str) -> Result<String, DesignError> {
    let ok = raw
        .strip_prefix("cable:")
        .is_some_and(|u| fathom_id::Ulid::decode(u).is_ok_and(|id| id.to_string() == u));
    if ok {
        Ok(raw.to_string())
    } else {
        Err(bad("that is not a cable id (cable: and a ULID)"))
    }
}

/// The typed text, whitespace collapsed. `traced` carries none; the other two need some.
/// Refuses control and invisible characters, and any text the redaction gate's BARE check
/// reads as a credential: a secret word (key, secret, password, psk, community...) within two
/// words before a value, as device syntax writes it (`enable secret cisco123`), or a crypt, hex
/// or base64 shape. Ordinary prose with those words in it may be refused too; that is the
/// direction of error chosen. A pasted correction has already been through the client gate.
pub fn clean_text(kind: &str, raw: &str) -> Result<String, DesignError> {
    if !KINDS.contains(&kind) {
        return Err(bad("kind is one of traced, label, not_here"));
    }
    // Line breaks and tabs are just spaces here; any other control or invisible character is not.
    if raw
        .chars()
        .any(|c| !matches!(c, '\n' | '\r' | '\t') && is_unsafe_char(c))
    {
        return Err(bad("text must not contain control or invisible characters"));
    }
    let t = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let max = match kind {
        "traced" => 0,
        "label" => MAX_LABEL_CHARS,
        _ => MAX_WHERE_CHARS,
    };
    if kind == "traced" {
        if !t.is_empty() {
            return Err(bad("a traced stamp carries no text"));
        }
        return Ok(t);
    }
    if t.is_empty() || t.chars().count() > max {
        return Err(bad(if kind == "label" {
            "a proposed label is 1 to 200 characters"
        } else {
            "where it actually is takes 1 to 500 characters"
        }));
    }
    if fathom_ingest::redact::looks_like_credential_bare(&t) {
        return Err(DesignError::CorrectionLooksSecret);
    }
    Ok(t)
}

fn aad(
    tenant: &str,
    id: &str,
    design: &str,
    cable: &str,
    kind: &str,
    sender: &str,
    epoch: i32,
) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, AAD_CORRECTION);
    crypto::lp(&mut a, tenant.as_bytes());
    crypto::lp(&mut a, id.as_bytes());
    crypto::lp(&mut a, design.as_bytes());
    crypto::lp(&mut a, cable.as_bytes());
    crypto::lp(&mut a, kind.as_bytes());
    crypto::lp(&mut a, sender.as_bytes());
    crypto::u32_le(&mut a, epoch as u32);
    a
}

const COLUMNS: &str = "c.id, c.design_id, c.cable, c.kind, c.sender, c.state, c.decided_by, \
     c.version, c.ciphertext, c.nonce, c.key_epoch, \
     (extract(epoch from c.created_at) * 1000)::bigint, \
     (extract(epoch from c.decided_at) * 1000)::bigint, \
     (SELECT a.display_name FROM accounts a WHERE a.id = c.sender)";

/// Opens correction rows, fetching each key epoch once per request.
struct Opener<'a> {
    auth: &'a Authority<'a>,
    keys: BTreeMap<i32, crypto::Key32>,
}

impl Opener<'_> {
    async fn open(
        &mut self,
        tx: &Transaction<'_>,
        row: &tokio_postgres::Row,
    ) -> Result<Correction, DesignError> {
        let id: String = row.get(0);
        let design: String = row.get(1);
        let cable: String = row.get(2);
        let kind: String = row.get(3);
        let sender: String = row.get(4);
        let epoch: i32 = row.get(10);
        if !self.keys.contains_key(&epoch) {
            let key =
                keys::org_content_key_at_epoch(tx, self.auth.ctx, self.auth.tenant_key, epoch)
                    .await?;
            self.keys.insert(epoch, key);
        }
        let nonce: [u8; crypto::NONCE_LEN] = row
            .get::<_, Vec<u8>>(9)
            .try_into()
            .map_err(|_| DesignError::Corrupt("correction nonce"))?;
        let tenant = self.auth.ctx.tenant().to_string();
        let plain = crypto::open(
            &self.keys[&epoch],
            &nonce,
            &row.get::<_, Vec<u8>>(8),
            &aad(&tenant, &id, &design, &cable, &kind, &sender, epoch),
        )
        .map_err(|_| DesignError::Refused)?;
        let Ok(Json::Obj(mut m)) = Json::parse_canonical(&plain) else {
            return Err(DesignError::Corrupt("correction"));
        };
        let Some(Json::Str(text)) = m.remove("text") else {
            return Err(DesignError::Corrupt("correction"));
        };
        Ok(Correction {
            id,
            design,
            cable,
            kind,
            text,
            sender,
            sender_name: row.get::<_, Option<String>>(13).unwrap_or_default(),
            created_ms: row.get(11),
            state: row.get(5),
            decided_by: row.get(6),
            decided_ms: row.get(12),
            version: row.get(7),
        })
    }
}

/// Authorise `needed` on the design's own scope; on the organisation when there is no such
/// design, so both failures are the identical `NotAuthorised`.
async fn authorise(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    needed: Capability,
) -> Result<(), DesignError> {
    let scope = design_scope(tx, auth, design).await?;
    grants::authorise_account(tx, auth, scope, needed)
        .await
        .map(|_| ())
        .map_err(DesignError::Authority)
}

async fn design_scope(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
) -> Result<Option<ScopeId>, DesignError> {
    let row = tx
        .query_opt(
            "SELECT scope_id FROM designs WHERE id = $1 AND organisation_id = $2",
            &[&design.to_string(), &auth.ctx.tenant().to_string()],
        )
        .await?;
    match row {
        None => Ok(None),
        Some(r) => {
            let text: String = r.get(0);
            Ok(Some(
                text.parse()
                    .map_err(|_| DesignError::Corrupt("design scope id"))?,
            ))
        }
    }
}

/// A caller who cleared `read` is told when the design is not there; one who did not never
/// reaches this.
async fn require_design(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
) -> Result<(), DesignError> {
    let row = tx
        .query_opt(
            "SELECT 1 FROM designs WHERE id = $1 AND organisation_id = $2",
            &[&design.to_string(), &auth.ctx.tenant().to_string()],
        )
        .await?;
    row.map(|_| ()).ok_or(DesignError::NoSuchDesign)
}

/// Seal `{text}` under the CURRENT organisation content key, bound to this row's identity.
/// Returns (ciphertext, nonce) and the key epoch used.
#[allow(clippy::too_many_arguments)]
async fn seal(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    tenant: &str,
    id: &str,
    design: &str,
    cable: &str,
    kind: &str,
    sender: &str,
    text: &str,
) -> Result<((Vec<u8>, [u8; crypto::NONCE_LEN]), i32), DesignError> {
    let mut body = BTreeMap::new();
    body.insert("text".to_string(), Json::Str(text.to_string()));
    let plain = Json::Obj(body).to_canonical_bytes();
    let key = keys::org_content_key(tx, auth.ctx, auth.tenant_key).await?;
    let nonce = crypto::random_nonce()?;
    let ciphertext = crypto::seal(
        &key.key,
        &nonce,
        &plain,
        &aad(tenant, id, design, cable, kind, sender, key.epoch),
    )?;
    keys::count_write_under_org_content_key(tx, tenant, key.epoch).await?;
    Ok(((ciphertext, nonce), key.epoch))
}

/// Send a correction. Needs `read` on the design's place.
pub async fn create(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    cable: &str,
    kind: &str,
    text: &str,
) -> Result<Correction, DesignError> {
    authorise(tx, auth, design, Capability::Read).await?;
    require_design(tx, auth, design).await?;
    let cable = clean_cable(cable)?;
    let text = clean_text(kind, text)?;

    let tenant = auth.ctx.tenant().to_string();
    let design_text = design.to_string();
    let sender = auth.ctx.actor().to_string();
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        &[&format!("cable_corrections:{tenant}:{design_text}")],
    )
    .await?;
    let counts = tx
        .query_one(
            "SELECT count(*), \
                    count(*) FILTER (WHERE sender = $3), \
                    count(*) FILTER (WHERE sender = $3 AND cable = $4) \
             FROM cable_corrections \
             WHERE organisation_id = $1 AND design_id = $2 AND state = 'open'",
            &[&tenant, &design_text, &sender, &cable],
        )
        .await?;
    let (open, mine, mine_here): (i64, i64, i64) = (counts.get(0), counts.get(1), counts.get(2));
    if open >= MAX_OPEN_PER_DESIGN {
        return Err(DesignError::CorrectionCap(
            "this design has as many corrections waiting as it takes; they need deciding first",
        ));
    }
    if mine >= MAX_OPEN_PER_SENDER_PER_DESIGN {
        return Err(DesignError::CorrectionCap(
            "you already have 20 corrections waiting on this design",
        ));
    }
    if mine_here >= MAX_OPEN_PER_SENDER_PER_CABLE {
        return Err(DesignError::CorrectionCap(
            "you already have 5 corrections waiting on this cable",
        ));
    }

    let id = crate::ids::new_ulid().to_string();
    let (ciphertext, nonce, epoch) = {
        let (sealed, epoch) = seal(
            tx,
            auth,
            &tenant,
            &id,
            &design_text,
            &cable,
            kind,
            &sender,
            &text,
        )
        .await?;
        (sealed.0, sealed.1, epoch)
    };
    tx.execute(
        "INSERT INTO cable_corrections \
         (organisation_id, id, design_id, cable, kind, sender, ciphertext, nonce, key_epoch) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        &[
            &tenant,
            &id,
            &design_text,
            &cable,
            &kind,
            &sender,
            &ciphertext,
            &nonce.to_vec(),
            &epoch,
        ],
    )
    .await?;
    let row = tx
        .query_one(
            &format!(
                "SELECT {COLUMNS} FROM cable_corrections c WHERE c.organisation_id = $1 AND c.id = $2"
            ),
            &[&tenant, &id],
        )
        .await?;
    Opener {
        auth,
        keys: BTreeMap::new(),
    }
    .open(tx, &row)
    .await
}

/// `draw`: every open correction on the design, oldest first, and the 100 most recently decided. `read` only: the caller's own,
/// any state, newest 200. Neither: refused as for a design that is not there.
pub async fn list(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
) -> Result<Vec<Correction>, DesignError> {
    let scope = design_scope(tx, auth, design).await?;
    let verified = grants::verify_authority_state(tx, auth)
        .await
        .map_err(DesignError::Authority)?;
    let draws =
        match grants::authorise_in_verified_state(tx, auth, &verified, scope, Capability::Draw)
            .await
        {
            Ok(_) => true,
            Err(AuthorityError::NotAuthorised) | Err(AuthorityError::QuorumNotMet { .. }) => {
                grants::authorise_in_verified_state(tx, auth, &verified, scope, Capability::Read)
                    .await
                    .map_err(DesignError::Authority)?;
                false
            }
            Err(other) => return Err(DesignError::Authority(other)),
        };
    require_design(tx, auth, design).await?;

    let tenant = auth.ctx.tenant().to_string();
    let design_text = design.to_string();
    let rows = if draws {
        tx.query(
            &format!(
                "SELECT {COLUMNS} FROM cable_corrections c \
                 WHERE c.organisation_id = $1 AND c.design_id = $2 AND (c.state = 'open' \
                   OR c.id IN (SELECT d.id FROM cable_corrections d \
                               WHERE d.organisation_id = $1 AND d.design_id = $2 \
                                 AND d.state <> 'open' \
                               ORDER BY d.decided_at DESC, d.id DESC LIMIT $3)) \
                 ORDER BY c.created_at, c.id"
            ),
            &[&tenant, &design_text, &MAX_DECIDED_LISTED],
        )
        .await?
    } else {
        let me = auth.ctx.actor().to_string();
        let mut rows = tx
            .query(
                &format!(
                    "SELECT {COLUMNS} FROM cable_corrections c \
                     WHERE c.organisation_id = $1 AND c.design_id = $2 AND c.sender = $3 \
                     ORDER BY c.created_at DESC, c.id DESC LIMIT $4"
                ),
                &[&tenant, &design_text, &me, &MAX_OWN_LISTED],
            )
            .await?;
        rows.reverse();
        rows
    };
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

/// What a decision does to a correction.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    Accept,
    Dismiss,
    /// Take an ACCEPTED correction back to open, when the edit it was accepted for failed.
    Reopen,
}

/// Accept, dismiss or reopen one correction. Needs `draw`. The row is locked and must be in the
/// state the verb starts from (`open`, or `accepted` for a reopen) at `if_version`; the decider
/// and the time are recorded. Accepting changes nothing else here: the edit itself is the
/// accepter's, made in the client. A dismissal re-seals the body as empty text in the same
/// UPDATE, so what was typed is not kept; that is why a dismissed correction cannot be reopened.
pub async fn decide(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    id: &str,
    if_version: i64,
    verb: Verb,
) -> Result<Correction, DesignError> {
    authorise(tx, auth, design, Capability::Draw).await?;
    let tenant = auth.ctx.tenant().to_string();
    let design_text = design.to_string();
    let row = tx
        .query_opt(
            &format!(
                "SELECT {COLUMNS} FROM cable_corrections c \
                 WHERE c.organisation_id = $1 AND c.design_id = $2 AND c.id = $3 \
                 FOR UPDATE OF c"
            ),
            &[&tenant, &design_text, &id],
        )
        .await?
        .ok_or(DesignError::NoSuchCorrection)?;
    let mut opener = Opener {
        auth,
        keys: BTreeMap::new(),
    };
    let c = opener.open(tx, &row).await?;
    let from = if verb == Verb::Reopen {
        "accepted"
    } else {
        "open"
    };
    if c.state != from || c.version != if_version {
        return Err(DesignError::CorrectionConflict {
            state: c.state,
            version: c.version,
        });
    }
    let actor = auth.ctx.actor().to_string();
    let changed = match verb {
        Verb::Accept => {
            tx.execute(
                "UPDATE cable_corrections SET state = 'accepted', decided_by = $4, \
                 decided_at = now(), version = version + 1 \
                 WHERE organisation_id = $1 AND id = $2 AND version = $3 AND state = 'open'",
                &[&tenant, &id, &if_version, &actor],
            )
            .await?
        }
        Verb::Reopen => {
            tx.execute(
                "UPDATE cable_corrections SET state = 'open', decided_by = NULL, \
                 decided_at = NULL, version = version + 1 \
                 WHERE organisation_id = $1 AND id = $2 AND version = $3 AND state = 'accepted'",
                &[&tenant, &id, &if_version],
            )
            .await?
        }
        Verb::Dismiss => {
            let (sealed, epoch) = seal(
                tx,
                auth,
                &tenant,
                id,
                &design_text,
                &c.cable,
                &c.kind,
                &c.sender,
                "",
            )
            .await?;
            tx.execute(
                "UPDATE cable_corrections SET state = 'dismissed', decided_by = $4, \
                 decided_at = now(), version = version + 1, \
                 ciphertext = $5, nonce = $6, key_epoch = $7 \
                 WHERE organisation_id = $1 AND id = $2 AND version = $3 AND state = 'open'",
                &[
                    &tenant,
                    &id,
                    &if_version,
                    &actor,
                    &sealed.0,
                    &sealed.1.to_vec(),
                    &epoch,
                ],
            )
            .await?
        }
    };
    if changed != 1 {
        return Err(DesignError::Refused);
    }
    let row = tx
        .query_one(
            &format!(
                "SELECT {COLUMNS} FROM cable_corrections c WHERE c.organisation_id = $1 AND c.id = $2"
            ),
            &[&tenant, &id],
        )
        .await?;
    opener.open(tx, &row).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_cleaned_and_bounded_by_kind() {
        assert_eq!(clean_text("label", "  PP1-04 \n").unwrap(), "PP1-04");
        assert!(clean_text("label", "").is_err());
        assert!(clean_text("label", &"x".repeat(201)).is_err());
        assert!(clean_text("not_here", "Rack B3,\nU12").is_ok());
        assert!(clean_text("traced", "").is_ok());
        assert!(clean_text("traced", "hello").is_err());
        assert!(clean_text("other", "x").is_err());
        assert!(clean_text("label", "a\u{202e}b").is_err());
        assert!(clean_text("label", "a\u{0}b").is_err());
    }

    /// Forms a real device accepts, with the value and its word separated by a space only.
    const DEVICE_SECRETS: [&str; 6] = [
        "enable secret cisco123",
        "username admin password 0 Cisco123!",
        "snmp-server community s3cr3tR0 RO",
        "tacacs-server key 7 0822455D0A16",
        "crypto isakmp key Sh4redS3cret address 10.0.0.1",
        "wpa-psk Tr0ub4dor&3",
    ];

    #[test]
    fn a_secret_in_device_syntax_is_refused_for_every_kind_of_text() {
        for t in DEVICE_SECRETS {
            for kind in ["label", "not_here"] {
                assert!(
                    matches!(clean_text(kind, t), Err(DesignError::CorrectionLooksSecret)),
                    "{kind}: {t}"
                );
            }
            // Behind other words, as a person would write it.
            let wrapped = format!("it is behind the panel, switch says {t}");
            assert!(
                matches!(
                    clean_text("not_here", &wrapped),
                    Err(DesignError::CorrectionLooksSecret)
                ),
                "{wrapped}"
            );
        }
        // The delimiter forms still go.
        for t in ["password: hunter2", "psk=Tr0ub4dor"] {
            assert!(clean_text("label", t).is_err(), "{t}");
        }
    }

    #[test]
    fn ordinary_places_and_labels_pass() {
        for t in [
            "Behind the Hartwell blanking plate in B3",
            "PP1-04",
            "Rack B3, U12",
        ] {
            assert!(clean_text("not_here", t).is_ok(), "{t}");
        }
    }

    #[test]
    fn a_cable_id_is_cable_colon_and_a_ulid() {
        assert!(clean_cable("cable:01JABCDEFGHJKMNPQRSTVWXYZ0").is_ok());
        for bad in [
            "",
            "a b",
            "cable:",
            "cable:x",
            "cable:01JABCDEFGHJKMNPQRSTVWXYZ0 ",
            "cable:01jabcdefghjkmnpqrstvwxyz0",
            "port:01JABCDEFGHJKMNPQRSTVWXYZ0",
            "cable:01JABCDEFGHJKMNPQRSTVWXYZI",
            "cable:81JABCDEFGHJKMNPQRSTVWXYZ0",
            "01JABCDEFGHJKMNPQRSTVWXYZ0",
        ] {
            assert!(clean_cable(bad).is_err(), "{bad:?}");
        }
    }
}
