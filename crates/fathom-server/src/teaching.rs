//! "Type it yourself" (sign-off card r30-nocopy, migration `0040`).
//!
//! A teaching setting for one member of one organisation. While it is on, the
//! client shows commands to be typed by hand: no copy buttons on them, the
//! command text not selectable, each command broken into labelled parts. Links
//! and hashes still copy.
//!
//! **It is a teaching aid, not a control.** Anyone can still read a page's text
//! another way, so nothing here, in the client or in the docs may say it
//! prevents copying. It changes what the client draws and never what the server
//! allows, which is why it is a plain row and not a grant.
//!
//! Who may set it: a steward of any folder in the organisation, either way, for
//! any member; a member, on, for themselves. A member cannot switch it off for
//! themselves: a learner who chose it, or had it chosen for them, asks a
//! steward. Every change is sealed on the organisation chain as
//! `type_it_yourself_set`, naming who set it for whom.

use std::collections::{BTreeMap, BTreeSet};

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::chain::EntryType;
use crate::chains;
use crate::grants::{self, Authority, AuthorityError, StewardCheck};
use crate::invitations::InviteError;
use crate::repo::AccountId;

/// The organisations where `account` has it on. The caller has set
/// `app.account_id` (as `repo::list_organisations_for_account_in` does), so
/// this reads the account's own rows and nobody else's.
pub(crate) async fn on_for_account(
    tx: &Transaction<'_>,
    account: AccountId,
) -> Result<BTreeSet<String>, tokio_postgres::Error> {
    let rows = tx
        .query(
            "SELECT organisation_id FROM member_teaching \
              WHERE account_id = $1 AND type_it_yourself",
            &[&account.to_string()],
        )
        .await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// The members of `organisation` who have it on. The caller has opened a
/// tenant context for it.
pub(crate) async fn on_in_organisation(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<BTreeSet<String>, tokio_postgres::Error> {
    let rows = tx
        .query(
            "SELECT account_id FROM member_teaching \
              WHERE organisation_id = $1 AND type_it_yourself",
            &[&organisation],
        )
        .await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// Set it for `account`. Answers `{"account", "type_it_yourself", "changed",
/// "changed_seq"}`; setting it to what it already is seals nothing.
pub async fn set(
    tx: &Transaction<'_>,
    auth: &Authority<'_>,
    account: &str,
    on: bool,
) -> Result<Json, InviteError> {
    let organisation = auth.ctx.tenant().to_string();
    let actor = auth.ctx.actor().to_string();

    // Switching it on for yourself needs nothing more than being a member,
    // which the tenant context already proved. Anything else needs a steward,
    // asked before any row is read so a member cannot probe who is in.
    if !(on && account == actor) {
        let verified = grants::verify_authority_state(tx, auth).await?;
        let mut check = StewardCheck::new();
        if grants::steward_anchors(tx, auth, &verified, &mut check)
            .await?
            .is_empty()
        {
            return Err(InviteError::Authority(AuthorityError::NotAuthorised));
        }
    }

    let member = tx
        .query_opt(
            "SELECT 1 FROM memberships WHERE organisation_id = $1 AND account_id = $2",
            &[&organisation, &account],
        )
        .await?;
    if member.is_none() {
        return Err(InviteError::Malformed(
            "no such person in this organisation",
        ));
    }

    let current: bool = tx
        .query_opt(
            "SELECT type_it_yourself FROM member_teaching \
              WHERE organisation_id = $1 AND account_id = $2 FOR UPDATE",
            &[&organisation, &account],
        )
        .await?
        .is_some_and(|r| r.get(0));

    let mut answer = BTreeMap::new();
    answer.insert("account".to_string(), Json::Str(account.to_string()));
    answer.insert("type_it_yourself".to_string(), Json::Bool(on));
    if current == on {
        answer.insert("changed".to_string(), Json::Bool(false));
        answer.insert("changed_seq".to_string(), Json::Null);
        return Ok(Json::Obj(answer));
    }

    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::TypeItYourselfSet,
        &metadata(&organisation, &actor, account, on),
    )
    .await?;
    tx.execute(
        "INSERT INTO member_teaching (organisation_id, account_id, type_it_yourself, set_by) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (organisation_id, account_id) DO UPDATE \
         SET type_it_yourself = EXCLUDED.type_it_yourself, \
             set_by = EXCLUDED.set_by, set_at = now()",
        &[&organisation, &account, &on, &actor],
    )
    .await?;

    answer.insert("changed".to_string(), Json::Bool(true));
    answer.insert("changed_seq".to_string(), Json::Int(appended.seq));
    Ok(Json::Obj(answer))
}

fn metadata(organisation: &str, actor: &str, account: &str, on: bool) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("account".to_string(), Json::Str(account.to_string()));
    map.insert("actor".to_string(), Json::Str(actor.to_string()));
    map.insert(
        "entry_type".to_string(),
        Json::Str(EntryType::TypeItYourselfSet.as_str().to_string()),
    );
    map.insert("on".to_string(), Json::Bool(on));
    map.insert(
        "organisation".to_string(),
        Json::Str(organisation.to_string()),
    );
    Json::Obj(map).to_canonical_bytes()
}
