//! Breach checks for stored logins (ADR-0071 part three, migration `0043_vault_breach.sql`).
//!
//! The check itself runs in a browser that holds the login (`client/src/vault/breach.ts`): five
//! hex characters of the password's SHA-1 go to the Have I Been Pwned range API, with padding,
//! and the browser compares the rest. This module keeps what the server may know: the policy, a
//! login's "critical" mark, and per login and epoch whether a holder's browser found it in a
//! breach, and when.
//!
//! **The policy, most specific first.** A login marked critical is checked, re-checked every
//! [`CRITICAL_INTERVAL_DAYS`] days, and a breached password refused. Otherwise its kind's row, if
//! the organisation set one; otherwise the organisation's row; otherwise off. [`effective`] is
//! the one place this is resolved on the server; `breach.ts`'s `effectivePolicy` mirrors it.
//!
//! **A refusal is the browser's.** The server never sees a password and so cannot check one. A
//! holder's browser refuses to save a breached password where the policy says refuse; a browser
//! that does not is one that could also have kept the password for itself. The record of what was
//! found is what the server can stand behind.

use std::collections::BTreeMap;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::chain::EntryType;
use crate::chains;
use crate::grants::Authority;
use crate::vault::{
    current_wrap, entry_metadata, is_steward, live_person_key, lock_entry, require_steward,
    VaultError, KINDS,
};

/// How often a critical login is re-checked, and the organisation's default (owner, round 32:
/// "breach A with a weekly re-check").
pub const CRITICAL_INTERVAL_DAYS: i32 = 7;
pub const DEFAULT_INTERVAL_DAYS: i32 = 7;

/// The organisation's own row in `vault.breach_policy`.
pub const ORGANISATION: &str = "*";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Level {
    pub enabled: bool,
    pub interval_days: i32,
    /// `warn` or `refuse`.
    pub action: String,
}

impl Level {
    fn to_json(&self) -> Json {
        Json::Obj(
            [
                ("enabled", Json::Bool(self.enabled)),
                ("intervalDays", Json::Int(self.interval_days as i64)),
                ("action", Json::Str(self.action.clone())),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        )
    }
}

/// The organisation's level and the kinds it overrides.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    pub organisation: Option<Level>,
    pub kinds: BTreeMap<String, Level>,
}

impl Policy {
    pub fn to_json(&self) -> Json {
        Json::Obj(
            [
                (
                    "organisation",
                    self.organisation
                        .as_ref()
                        .map_or(Json::Null, Level::to_json),
                ),
                (
                    "kinds",
                    Json::Obj(
                        self.kinds
                            .iter()
                            .map(|(k, l)| (k.clone(), l.to_json()))
                            .collect(),
                    ),
                ),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        )
    }
}

/// Which level decided, for the card's words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum From {
    Critical,
    Kind,
    Organisation,
    Off,
}

/// The policy one login is under: critical, then its kind, then the organisation, then off.
pub fn effective(policy: &Policy, kind: &str, critical: bool) -> (Level, From) {
    if critical {
        return (
            Level {
                enabled: true,
                interval_days: CRITICAL_INTERVAL_DAYS,
                action: "refuse".into(),
            },
            From::Critical,
        );
    }
    if let Some(l) = policy.kinds.get(kind) {
        return (l.clone(), From::Kind);
    }
    if let Some(l) = &policy.organisation {
        return (l.clone(), From::Organisation);
    }
    (off_level(), From::Off)
}

fn off_level() -> Level {
    Level {
        enabled: false,
        interval_days: DEFAULT_INTERVAL_DAYS,
        action: "warn".into(),
    }
}

/// What a holder's browser last found for a login at its current epoch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Result_ {
    pub found: bool,
    pub checked_ms: i64,
}

impl Result_ {
    pub fn to_json(&self) -> Json {
        Json::Obj(
            [
                ("found", Json::Bool(self.found)),
                ("checkedAt", Json::Int(self.checked_ms)),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect(),
        )
    }
}

pub async fn load_policy(tx: &Transaction<'_>, tenant: &str) -> Result<Policy, VaultError> {
    let mut policy = Policy::default();
    for r in tx
        .query(
            "SELECT kind, enabled, interval_days, action FROM vault.breach_policy \
             WHERE organisation_id = $1 AND NOT inherit",
            &[&tenant],
        )
        .await?
    {
        let kind: String = r.get(0);
        let level = Level {
            enabled: r.get(1),
            interval_days: r.get(2),
            action: r.get(3),
        };
        if kind == ORGANISATION {
            policy.organisation = Some(level);
        } else {
            policy.kinds.insert(kind, level);
        }
    }
    Ok(policy)
}

/// The login's critical mark and its answer at `epoch`, for its card.
pub async fn entry_facts(
    tx: &Transaction<'_>,
    tenant: &str,
    credential: &str,
    epoch: i32,
) -> Result<(bool, Option<Result_>), VaultError> {
    let critical: bool = tx
        .query_one(
            "SELECT critical FROM vault.entries WHERE organisation_id = $1 AND id = $2",
            &[&tenant, &credential],
        )
        .await?
        .get(0);
    let result = tx
        .query_opt(
            "SELECT found, (extract(epoch from checked_at) * 1000)::bigint FROM vault.breach_results \
             WHERE organisation_id = $1 AND entry_id = $2 AND epoch = $3",
            &[&tenant, &credential, &epoch],
        )
        .await?
        .map(|r| Result_ {
            found: r.get(0),
            checked_ms: r.get(1),
        });
    Ok((critical, result))
}

fn clean_level(level: &Level) -> Result<(), VaultError> {
    if !(1..=365).contains(&level.interval_days) {
        return Err(VaultError::Malformed("re-check every 1 to 365 days"));
    }
    if level.action != "warn" && level.action != "refuse" {
        return Err(VaultError::Malformed(
            "a breached password is warned of or refused",
        ));
    }
    Ok(())
}

/// An admin sets the whole policy: the organisation's level (or none, which is off) and the kinds
/// it overrides. Kinds left out stop overriding. Written to the organisation's history.
pub async fn set_policy(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    policy: Policy,
) -> Result<Policy, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    require_steward(tx, auth).await?;
    for (kind, level) in &policy.kinds {
        if !KINDS.contains(&kind.as_str()) {
            return Err(VaultError::Malformed("kind of login"));
        }
        clean_level(level)?;
    }
    if let Some(l) = &policy.organisation {
        clean_level(l)?;
    }
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultBreachPolicySet,
        &entry_metadata(
            EntryType::VaultBreachPolicySet,
            &[("by", Json::Str(me.clone())), ("policy", policy.to_json())],
        ),
    )
    .await?;
    // No DELETE is granted: a kind no longer set keeps its row, marked to inherit. The
    // organisation's own row, once written, is turned off rather than removed.
    let mut all: Vec<(String, Level, bool)> = Vec::new();
    match &policy.organisation {
        Some(l) => all.push((ORGANISATION.into(), l.clone(), false)),
        None => all.push((ORGANISATION.into(), off_level(), false)),
    }
    for k in KINDS.iter().copied() {
        match policy.kinds.get(k) {
            Some(l) => all.push((k.to_string(), l.clone(), false)),
            None => all.push((k.to_string(), off_level(), true)),
        }
    }
    let had_organisation =
        load_policy(tx, &tenant).await?.organisation.is_some() || policy.organisation.is_some();
    for (kind, l, inherit) in all {
        if kind == ORGANISATION && !had_organisation {
            continue;
        }
        tx.execute(
            "INSERT INTO vault.breach_policy (organisation_id, kind, enabled, interval_days, \
                 action, inherit, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7) \
             ON CONFLICT (organisation_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, \
                 interval_days = EXCLUDED.interval_days, action = EXCLUDED.action, \
                 inherit = EXCLUDED.inherit, updated_by = EXCLUDED.updated_by, updated_at = now()",
            &[
                &tenant,
                &kind,
                &l.enabled,
                &l.interval_days,
                &l.action,
                &inherit,
                &me,
            ],
        )
        .await?;
    }
    load_policy(tx, &tenant).await
}

/// The owner or an admin marks a login critical, or not. Written to the organisation's history.
pub async fn set_critical(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    critical: bool,
) -> Result<bool, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let row = lock_entry(tx, &tenant, credential).await?;
    let owner: String = row.get(2);
    if owner != me && !is_steward(tx, auth).await? {
        return Err(VaultError::NotAllowed(
            "only the login's owner or an admin can mark it critical",
        ));
    }
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::VaultBreachPolicySet,
        &entry_metadata(
            EntryType::VaultBreachPolicySet,
            &[
                ("by", Json::Str(me)),
                ("credential", Json::Str(credential.to_string())),
                ("critical", Json::Bool(critical)),
            ],
        ),
    )
    .await?;
    tx.execute(
        "UPDATE vault.entries SET critical = $3 WHERE organisation_id = $1 AND id = $2",
        &[&tenant, &credential, &critical],
    )
    .await?;
    Ok(critical)
}

/// A holder's browser records what it found for the login at its current epoch. Only someone
/// holding it now: anyone else never saw the password.
pub async fn record(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    credential: &str,
    epoch: i32,
    found: bool,
) -> Result<Result_, VaultError> {
    let tenant = auth.ctx.tenant().to_string();
    let me = auth.ctx.actor().to_string();
    let row = lock_entry(tx, &tenant, credential).await?;
    let current: i32 = row.get(1);
    if epoch != current {
        return Err(VaultError::NotAllowed(
            "this login changed since it was checked; check it again",
        ));
    }
    let mine = live_person_key(tx, &tenant, &me)
        .await?
        .ok_or(VaultError::NoVaultKey)?;
    if current_wrap(tx, &tenant, credential, epoch, Some(&mine))
        .await?
        .is_none()
    {
        return Err(VaultError::NotAllowed(
            "only someone who holds this login can record a check of it",
        ));
    }
    tx.execute(
        "INSERT INTO vault.breach_results (organisation_id, entry_id, epoch, found, checked_by) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (organisation_id, entry_id, epoch) DO UPDATE SET found = EXCLUDED.found, \
             checked_by = EXCLUDED.checked_by, checked_at = now()",
        &[&tenant, &credential, &epoch, &found, &me],
    )
    .await?;
    entry_facts(tx, &tenant, credential, epoch)
        .await?
        .1
        .ok_or(VaultError::Corrupt("the answer just written"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(enabled: bool, days: i32, action: &str) -> Level {
        Level {
            enabled,
            interval_days: days,
            action: action.into(),
        }
    }

    #[test]
    fn the_most_specific_level_wins() {
        let mut p = Policy::default();
        assert_eq!(effective(&p, "snmp", false).1, From::Off);
        assert!(!effective(&p, "snmp", false).0.enabled);
        p.organisation = Some(level(true, 30, "warn"));
        assert_eq!(
            effective(&p, "snmp", false),
            (level(true, 30, "warn"), From::Organisation)
        );
        p.kinds.insert("snmp".into(), level(false, 30, "warn"));
        assert_eq!(
            effective(&p, "snmp", false),
            (level(false, 30, "warn"), From::Kind)
        );
        assert_eq!(effective(&p, "login", false).1, From::Organisation);
        assert_eq!(
            effective(&p, "snmp", true),
            (level(true, 7, "refuse"), From::Critical)
        );
    }
}
