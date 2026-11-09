//! A person's Cables list for one design (migration `0076`, sign-off r114).
//!
//! The Cables list is a way of looking: which VLAN, tag, type and device groups a person has,
//! which are ticked, None, and the cables they hid one at a time
//! (`client/src/components/drawing/cableGroups.ts`'s `StoredCableGroupsState`). It is each
//! person's own (r114 pick A), so a colleague's untick never hides a cable on your screen. It is
//! never a design fact and writes no chain entry.
//!
//! The whole state is one canonical JSON object sealed under the organisation content key, with
//! tenant, account, design and key epoch in the associated data. The server checks its shape and
//! size before sealing, so a row always opens to something the browser can read; what the ids
//! inside it mean is the browser's business, which drops any that no longer resolve.

use std::collections::BTreeMap;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::authority::Capability;
use crate::crypto;
use crate::designs::DesignError;
use crate::field_defs::is_unsafe_char;
use crate::grants::{self, Authority};
use crate::keys;
use crate::repo::{DesignId, ScopeId};

const AAD_CABLE_VIEW: &[u8] = b"fathom/member-cable-view/v1";

/// The sealed body's ceiling, in canonical bytes.
pub const MAX_BYTES: usize = 65_536;
const MAX_GROUPS: usize = 1_000;
const MAX_IDS: usize = 10_000;
const MAX_ID_CHARS: usize = 128;
/// A VXLAN VNI is 24 bits; an 802.1Q VLAN fits well inside it.
const MAX_VLAN_ID: i64 = 16_777_215;
const TYPES: [&str; 4] = ["copper", "fibre", "dac", "power"];

const WHY: &str = "a Cables list is {groups, none, hiddenCableIds}: at most 1000 groups, each \
                   {ref, on} with a vlan, tag, type or device ref, and at most 10000 ids of up to \
                   128 characters, 64 KB in all";

fn bad() -> DesignError {
    DesignError::InvalidCableView(WHY)
}

fn is_id(j: &Json) -> bool {
    matches!(j, Json::Str(s) if !s.is_empty()
        && s.chars().count() <= MAX_ID_CHARS
        && !s.chars().any(|c| is_unsafe_char(c) || c.is_whitespace()))
}

fn ids(j: Option<&Json>, max: usize) -> bool {
    matches!(j, Some(Json::Arr(items)) if items.len() <= max && items.iter().all(is_id))
}

fn keys_are(m: &BTreeMap<String, Json>, allowed: &[&str]) -> bool {
    m.len() == allowed.len() && allowed.iter().all(|k| m.contains_key(*k))
}

fn is_ref(j: &Json) -> bool {
    let Json::Obj(m) = j else { return false };
    match m.get("kind") {
        Some(Json::Str(k)) if k == "vlan" => {
            keys_are(m, &["kind", "vlanId", "nodeIds"])
                && matches!(m.get("vlanId"), Some(Json::Int(v)) if (0..=MAX_VLAN_ID).contains(v))
                && ids(m.get("nodeIds"), MAX_GROUPS)
        }
        Some(Json::Str(k)) if k == "tag" || k == "device" => {
            keys_are(m, &["kind", "nodeId"]) && m.get("nodeId").is_some_and(is_id)
        }
        Some(Json::Str(k)) if k == "type" => {
            keys_are(m, &["kind", "type"])
                && matches!(m.get("type"), Some(Json::Str(t)) if TYPES.contains(&t.as_str()))
        }
        _ => false,
    }
}

fn is_group(j: &Json) -> bool {
    let Json::Obj(m) = j else { return false };
    keys_are(m, &["ref", "on"])
        && matches!(m.get("on"), Some(Json::Bool(_)))
        && m.get("ref").is_some_and(is_ref)
}

/// The state as the browser sent it, checked for shape and size. Returns its canonical bytes.
pub fn check(view: &Json) -> Result<Vec<u8>, DesignError> {
    let Json::Obj(m) = view else {
        return Err(bad());
    };
    let ok = keys_are(m, &["groups", "none", "hiddenCableIds"])
        && matches!(m.get("none"), Some(Json::Bool(_)))
        && matches!(m.get("groups"), Some(Json::Arr(g)) if g.len() <= MAX_GROUPS && g.iter().all(is_group))
        && ids(m.get("hiddenCableIds"), MAX_IDS);
    if !ok {
        return Err(bad());
    }
    let bytes = view.to_canonical_bytes();
    if bytes.len() > MAX_BYTES {
        return Err(bad());
    }
    Ok(bytes)
}

fn aad(tenant: &str, account: &str, design: &str, epoch: i32) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, AAD_CABLE_VIEW);
    crypto::lp(&mut a, tenant.as_bytes());
    crypto::lp(&mut a, account.as_bytes());
    crypto::lp(&mut a, design.as_bytes());
    crypto::u32_le(&mut a, epoch as u32);
    a
}

/// The caller must hold `read` on the design's place; a design that is not there reads as
/// "no such design" only to a caller who cleared that.
async fn require_read(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
) -> Result<(), DesignError> {
    let row = tx
        .query_opt(
            "SELECT scope_id FROM designs WHERE id = $1 AND organisation_id = $2",
            &[&design.to_string(), &auth.ctx.tenant().to_string()],
        )
        .await?;
    let scope: Option<ScopeId> = match &row {
        None => None,
        Some(r) => Some(
            r.get::<_, String>(0)
                .parse()
                .map_err(|_| DesignError::Corrupt("design scope id"))?,
        ),
    };
    let verified = grants::verify_authority_state(tx, auth)
        .await
        .map_err(DesignError::Authority)?;
    grants::authorise_in_verified_state(tx, auth, &verified, scope, Capability::Read)
        .await
        .map_err(DesignError::Authority)?;
    row.map(|_| ()).ok_or(DesignError::NoSuchDesign)
}

/// The caller's own Cables list for this design, or `None` when they have not saved one.
pub async fn get(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
) -> Result<Option<Json>, DesignError> {
    require_read(tx, auth, design).await?;
    let tenant = auth.ctx.tenant().to_string();
    let account = auth.ctx.actor().to_string();
    let design_text = design.to_string();
    let Some(row) = tx
        .query_opt(
            "SELECT key_epoch, ciphertext, nonce FROM member_cable_views \
             WHERE organisation_id = $1 AND account_id = $2 AND design_id = $3",
            &[&tenant, &account, &design_text],
        )
        .await?
    else {
        return Ok(None);
    };
    let epoch: i32 = row.get(0);
    let key = keys::org_content_key_at_epoch(tx, auth.ctx, auth.tenant_key, epoch).await?;
    let nonce: [u8; crypto::NONCE_LEN] = row
        .get::<_, Vec<u8>>(2)
        .try_into()
        .map_err(|_| DesignError::Corrupt("cable view nonce"))?;
    let plain = crypto::open(
        &key,
        &nonce,
        &row.get::<_, Vec<u8>>(1),
        &aad(&tenant, &account, &design_text, epoch),
    )
    .map_err(|_| DesignError::Refused)?;
    Json::parse_canonical(&plain)
        .map(Some)
        .map_err(|_| DesignError::Corrupt("cable view"))
}

/// Replace the caller's own Cables list for this design. Last write wins: it is one person's
/// way of looking, and the browser writes its latest whole state.
pub async fn put(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    design: DesignId,
    view: &Json,
) -> Result<(), DesignError> {
    let plain = check(view)?;
    require_read(tx, auth, design).await?;
    let tenant = auth.ctx.tenant().to_string();
    let account = auth.ctx.actor().to_string();
    let design_text = design.to_string();
    let key = keys::org_content_key(tx, auth.ctx, auth.tenant_key).await?;
    let nonce = crypto::random_nonce()?;
    let ciphertext = crypto::seal(
        &key.key,
        &nonce,
        &plain,
        &aad(&tenant, &account, &design_text, key.epoch),
    )?;
    keys::count_write_under_org_content_key(tx, &tenant, key.epoch).await?;
    tx.execute(
        "INSERT INTO member_cable_views \
         (organisation_id, account_id, design_id, key_epoch, ciphertext, nonce) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (organisation_id, account_id, design_id) DO UPDATE SET \
         key_epoch = EXCLUDED.key_epoch, ciphertext = EXCLUDED.ciphertext, \
         nonce = EXCLUDED.nonce, updated_at = now()",
        &[
            &tenant,
            &account,
            &design_text,
            &key.epoch,
            &ciphertext,
            &nonce.to_vec(),
        ],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Json {
        Json::parse_canonical(format!("{s}\n").as_bytes()).unwrap()
    }

    #[test]
    fn every_kind_of_group_is_accepted() {
        let v = parse(concat!(
            r#"{"groups":[{"on":true,"ref":{"kind":"type","type":"fibre"}},"#,
            r#"{"on":false,"ref":{"kind":"vlan","nodeIds":["Vlan:a","Vlan:b"],"vlanId":10}},"#,
            r#"{"on":true,"ref":{"kind":"tag","nodeId":"Tag:x"}},"#,
            r#"{"on":true,"ref":{"kind":"device","nodeId":"Chassis:y"}}],"#,
            r#""hiddenCableIds":["Cable:1"],"none":false}"#
        ));
        assert!(check(&v).is_ok());
    }

    #[test]
    fn a_wrong_shape_is_refused() {
        for bad in [
            r#"{"groups":[],"hiddenCableIds":[]}"#,
            r#"{"extra":1,"groups":[],"hiddenCableIds":[],"none":true}"#,
            r#"{"groups":[{"on":true,"ref":{"kind":"type","type":"laser"}}],"hiddenCableIds":[],"none":true}"#,
            r#"{"groups":[{"on":true,"ref":{"kind":"tag","nodeId":""}}],"hiddenCableIds":[],"none":true}"#,
            r#"{"groups":[{"on":true,"ref":{"kind":"vlan","nodeIds":[],"vlanId":-1}}],"hiddenCableIds":[],"none":true}"#,
            r#"{"groups":[],"hiddenCableIds":["a b"],"none":true}"#,
            r#"[]"#,
        ] {
            assert!(check(&parse(bad)).is_err(), "{bad}");
        }
        let bidi = parse(&format!(
            r#"{{"groups":[],"hiddenCableIds":["a{}b"],"none":true}}"#,
            '\u{202E}'
        ));
        assert!(check(&bidi).is_err());
    }

    #[test]
    fn more_than_64_kb_is_refused() {
        let ids: Vec<String> = (0..2_000).map(|i| format!("\"Cable:{i:0>40}\"")).collect();
        let v = parse(&format!(
            r#"{{"groups":[],"hiddenCableIds":[{}],"none":false}}"#,
            ids.join(",")
        ));
        assert!(check(&v).is_err());
    }
}
