//! Teams (ADR-0081): a team is a principal of the organisation, given Read or Draw on folders
//! the way a person is, with members, leads and supervisors (`overseer` here, because
//! `.context/conventions.md` reserves *supervisor* for the AI layer).
//!
//! `docs/TEAMS-ATTACK-ROUND.md` is the reasoning; each rule below names its finding.
//! `migrations/0066_teams.sql` is the schema; `authority::team_act_bytes` the signed bytes.
//!
//! # The shape
//!
//! Every change to a team is one **signed, append-only row** in `team_acts` (T7): creating or
//! deleting the team, adding or removing a member, setting or clearing a role, granting or
//! revoking the team's access to a folder. A removal is a new row naming the row it undoes.
//! The rows are part of the authority state (`grants::AuthorityState`), so the head's digest
//! covers them and every authorisation checks them, in the same transaction, with nothing
//! cached (T9).
//!
//! # What makes a row count
//!
//! A row **counts** when its stored seal recomputes, its signature verifies under the key its
//! signer held at the time, the person it names is bound to their key if it names one (T6), the
//! row it undoes is the right kind of row in the same team, and its signer held the authority
//! it claims **at the row's chain position** (T3):
//!
//! - `steward`: a verified live `steward` grant at the organisation's root for staffing acts
//!   (T1), or covering the folder for `grant` and `grant_revoke`;
//! - `lead`: a counting `role_set` of `lead` on this team, not cleared before the row, and only
//!   for `member_add` or `member_remove` of somebody else (T1, T2).
//!
//! A row that does not count is passed over, as a seconding that does not qualify is
//! (`grants::seconding_qualifies`): a forged seal is refused for the whole organisation by the
//! stored-seal check, and what remains is a question about one row's standing.
//!
//! # What a team gives
//!
//! A person's access is their own grants plus, for each team they are a counting member of, the
//! team's counting, unrevoked grants: `read` or `draw`, never `steward` (T4). Leads and
//! supervisors get nothing from the role (T12).
//!
//! # Not here yet
//!
//! The operator's suspend verb on a membership or role (ADR-0081 decision 7), approvals
//! (decision 6), and work assignment (the Work tab) come in later changes.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::authority::{self, Capability, RowFacts, TeamActFacts};
use crate::chain::EntryType;
use crate::chains;
use crate::crypto::{hex, now_unix, Key32};
use crate::grants::{
    self, as_32, entry_metadata, AuthorityError, AuthorityState, QuorumPass, NO_SUBJECT_KEY,
    PROPOSAL_SKEW_SECONDS,
};
use crate::ids;
use crate::keys::KeyRing;

/// The acts, by the name the bytes and the table use.
pub const ACT_CREATE: &str = "create";
pub const ACT_DELETE: &str = "delete";
pub const ACT_MEMBER_ADD: &str = "member_add";
pub const ACT_MEMBER_REMOVE: &str = "member_remove";
pub const ACT_ROLE_SET: &str = "role_set";
pub const ACT_ROLE_CLEAR: &str = "role_clear";
pub const ACT_GRANT: &str = "grant";
pub const ACT_GRANT_REVOKE: &str = "grant_revoke";

pub const ROLE_LEAD: &str = "lead";
/// The interface says *Supervisor*; see the module header.
pub const ROLE_OVERSEER: &str = "overseer";

pub const BY_STEWARD: &str = "steward";
pub const BY_LEAD: &str = "lead";

/// One signed act, as stored.
#[derive(Clone, Debug)]
pub struct TeamAct {
    pub id: String,
    pub organisation_id: String,
    pub team_id: String,
    pub act: String,
    pub subject_id: Option<String>,
    pub subject_key_fpr: [u8; 32],
    pub role: Option<String>,
    pub scope_id: Option<String>,
    pub capability: Option<Capability>,
    pub undoes: Option<String>,
    pub signed_by: String,
    pub signer_key_fpr: [u8; 32],
    pub signer_authority: String,
    pub signature: Vec<u8>,
    pub at_unix: i64,
    pub auth_epoch: i32,
    pub chain_seq: i64,
    pub row_seal: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Reading, sealing, digesting
// ---------------------------------------------------------------------------

const ACT_COLUMNS: &str = "id, organisation_id, team_id, act, subject_id, subject_key_fpr, role, \
     scope_id, capability, undoes, signed_by, signer_key_fpr, signer_authority, signature, \
     at_unix, auth_epoch, chain_seq, row_seal";

fn act_from_row(row: &tokio_postgres::Row) -> Result<TeamAct, AuthorityError> {
    let subject_fpr: Vec<u8> = row.get(5);
    let signer_fpr: Vec<u8> = row.get(11);
    let capability: Option<String> = row.get(8);
    Ok(TeamAct {
        id: row.get(0),
        organisation_id: row.get(1),
        team_id: row.get(2),
        act: row.get(3),
        subject_id: row.get(4),
        subject_key_fpr: as_32(&subject_fpr, "team act subject key fingerprint")?,
        role: row.get(6),
        scope_id: row.get(7),
        capability: match capability {
            None => None,
            Some(c) => Some(Capability::parse(&c).ok_or(AuthorityError::Corrupt("capability"))?),
        },
        undoes: row.get(9),
        signed_by: row.get(10),
        signer_key_fpr: as_32(&signer_fpr, "team act signer key fingerprint")?,
        signer_authority: row.get(12),
        signature: row.get(13),
        at_unix: row.get(14),
        auth_epoch: row.get(15),
        chain_seq: row.get(16),
        row_seal: row.get(17),
    })
}

/// Every team act of one organisation, in chain order.
pub(crate) async fn read_acts(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<Vec<TeamAct>, AuthorityError> {
    let rows = tx
        .query(
            &format!(
                "SELECT {ACT_COLUMNS} FROM team_acts \
                  WHERE organisation_id = $1 ORDER BY chain_seq, id"
            ),
            &[&organisation],
        )
        .await?;
    rows.iter().map(act_from_row).collect()
}

fn opt(value: &Option<String>) -> Json {
    match value {
        Some(v) => Json::Str(v.clone()),
        None => Json::Null,
    }
}

/// The canonical state of a team act, for its seal. One function on write and on read.
fn row_state(a: &TeamAct) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("act".to_string(), Json::Str(a.act.clone()));
    map.insert("at".to_string(), Json::Int(a.at_unix));
    map.insert("auth_epoch".to_string(), Json::Int(i64::from(a.auth_epoch)));
    map.insert(
        "capability".to_string(),
        match a.capability {
            Some(c) => Json::Str(c.as_str().to_string()),
            None => Json::Null,
        },
    );
    map.insert(
        "organisation_id".to_string(),
        Json::Str(a.organisation_id.clone()),
    );
    map.insert("role".to_string(), opt(&a.role));
    map.insert("scope_id".to_string(), opt(&a.scope_id));
    map.insert("signature".to_string(), Json::Str(hex(&a.signature)));
    map.insert("signed_by".to_string(), Json::Str(a.signed_by.clone()));
    map.insert(
        "signer_authority".to_string(),
        Json::Str(a.signer_authority.clone()),
    );
    map.insert(
        "signer_key_fpr".to_string(),
        Json::Str(hex(&a.signer_key_fpr)),
    );
    map.insert("subject_id".to_string(), opt(&a.subject_id));
    map.insert(
        "subject_key_fpr".to_string(),
        Json::Str(hex(&a.subject_key_fpr)),
    );
    map.insert("team_id".to_string(), Json::Str(a.team_id.clone()));
    map.insert("undoes".to_string(), opt(&a.undoes));
    Json::Obj(map).to_canonical_bytes()
}

fn seal_of(row_key: &Key32, a: &TeamAct) -> [u8; 32] {
    authority::row_seal(
        row_key,
        &RowFacts {
            table: "team_acts",
            row_id: &a.id,
            chain_seq: a.chain_seq,
            row_version: 1,
            row_state: &row_state(a),
        },
    )
}

/// The head's digest entries for team acts: every act, recomputed. Acts are never removed from
/// the set (a removal is another act), so deleting any row changes the digest.
pub(crate) fn digest_entries(acts: &[TeamAct], row_key: &Key32) -> Vec<(String, [u8; 32])> {
    acts.iter()
        .map(|a| (format!("team_acts/{}", a.id), seal_of(row_key, a)))
        .collect()
}

/// Every team act's stored seal recomputes (see `AuthorityState::verify_stored_seals`).
pub(crate) fn verify_stored_seals(acts: &[TeamAct], row_key: &Key32) -> Result<(), AuthorityError> {
    for a in acts {
        if a.row_seal != seal_of(row_key, a) {
            return Err(AuthorityError::Unverifiable("team act row seal"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The bytes
// ---------------------------------------------------------------------------

/// What an act's signature covers, with the row it undoes looked up in `acts`.
fn bytes_of(
    organisation: &str,
    root_fpr: &[u8; 32],
    a: &TeamAct,
    acts: &[TeamAct],
) -> Option<Vec<u8>> {
    let undone_bytes = match &a.undoes {
        None => None,
        Some(id) => {
            let undone = acts.iter().find(|u| &u.id == id)?;
            // One level: the row an undo names is never itself an undo (the shape check).
            if undone.undoes.is_some() {
                return None;
            }
            Some(bytes_of(organisation, root_fpr, undone, acts)?)
        }
    };
    Some(authority::team_act_bytes(&TeamActFacts {
        organisation,
        root_pubkey_fpr: root_fpr,
        act_id: &a.id,
        team: &a.team_id,
        act: &a.act,
        subject: a.subject_id.as_deref(),
        subject_key_fpr: &a.subject_key_fpr,
        role: a.role.as_deref(),
        scope: a.scope_id.as_deref(),
        capability: a.capability,
        undoes: a.undoes.as_deref(),
        undone_bytes: undone_bytes.as_deref(),
        signer: &a.signed_by,
        signer_key_fpr: &a.signer_key_fpr,
        signer_authority: &a.signer_authority,
        at_unix: a.at_unix,
        auth_epoch: a.auth_epoch,
    }))
}

// ---------------------------------------------------------------------------
// Which rows count — at use, every time
// ---------------------------------------------------------------------------

/// Is this the right kind of row for `a` to undo?
fn undoes_the_right_row(a: &TeamAct, undone: &TeamAct) -> bool {
    let kind = match a.act.as_str() {
        ACT_MEMBER_REMOVE => ACT_MEMBER_ADD,
        ACT_ROLE_CLEAR => ACT_ROLE_SET,
        ACT_GRANT_REVOKE => ACT_GRANT,
        _ => return false,
    };
    undone.act == kind
        && undone.team_id == a.team_id
        && undone.chain_seq < a.chain_seq
        && undone.subject_id == a.subject_id
        && undone.role == a.role
        && (a.act != ACT_GRANT_REVOKE || undone.scope_id == a.scope_id)
}

/// One authorisation's walk over the team acts. Created inside the call and dropped with it,
/// like `QuorumPass` (§3.4: a memo within one use, never a stored verdict).
struct Walk<'a> {
    tx: &'a Transaction<'a>,
    ring: &'a KeyRing,
    state: &'a AuthorityState,
    root_fpr: &'a [u8; 32],
    pass: &'a Mutex<QuorumPass>,
    /// Act id → does it count.
    settled: Mutex<BTreeMap<String, bool>>,
}

const POISON: &str = "the team walk's lock is never held across an await";

fn is_a_disqualification(error: &AuthorityError) -> bool {
    matches!(
        error,
        AuthorityError::Unverifiable(_)
            | AuthorityError::Signature(_)
            | AuthorityError::NoSigningKey
    )
}

impl<'a> Walk<'a> {
    fn acts(&self) -> &'a [TeamAct] {
        &self.state.team_acts
    }

    fn find(&self, id: &str) -> Option<&'a TeamAct> {
        self.acts().iter().find(|a| a.id == id)
    }

    /// The row says what it was signed to say: seal, shape, both key bindings, signature.
    async fn well_formed(&self, a: &TeamAct) -> Result<bool, AuthorityError> {
        let row_key = grants::row_key_for(self.ring, &self.state.organisation);
        if a.row_seal != seal_of(&row_key, a) {
            return Ok(false);
        }
        if a.organisation_id != self.state.organisation {
            return Ok(false);
        }
        if let Some(undone) = &a.undoes {
            match self.find(undone) {
                Some(u) if undoes_the_right_row(a, u) => {}
                _ => return Ok(false),
            }
        }
        // T1, T2, restated from the table's CHECKs.
        if a.signer_authority == BY_LEAD
            && (!matches!(a.act.as_str(), ACT_MEMBER_ADD | ACT_MEMBER_REMOVE)
                || a.subject_id.as_deref() == Some(a.signed_by.as_str()))
        {
            return Ok(false);
        }
        if a.signer_authority != BY_LEAD && a.signer_authority != BY_STEWARD {
            return Ok(false);
        }
        if a.capability == Some(Capability::Steward) {
            return Ok(false);
        }
        let Some(message) = bytes_of(&self.state.organisation, self.root_fpr, a, self.acts())
        else {
            return Ok(false);
        };
        let signer = match grants::key_by_fingerprint(
            self.tx,
            self.ring,
            &a.signer_key_fpr,
            a.at_unix,
        )
        .await
        {
            Ok(key) => key,
            Err(e) if is_a_disqualification(&e) => return Ok(false),
            Err(e) => return Err(e),
        };
        if signer.account_id != a.signed_by {
            return Ok(false);
        }
        if authority::verify_es256(&signer.public_key, &message, &a.signature).is_err() {
            return Ok(false);
        }
        // T6: the member's key, when the row names one, is the member's.
        if a.subject_key_fpr != NO_SUBJECT_KEY {
            let Some(subject) = &a.subject_id else {
                return Ok(false);
            };
            match grants::key_by_fingerprint(self.tx, self.ring, &a.subject_key_fpr, a.at_unix)
                .await
            {
                Ok(key) if &key.account_id == subject => {}
                Ok(_) => return Ok(false),
                Err(e) if is_a_disqualification(&e) => return Ok(false),
                Err(e) => return Err(e),
            }
        }
        Ok(true)
    }

    /// Did the signer hold `steward` where this act needs it, at its chain position?
    async fn steward_signed(&self, a: &TeamAct) -> Result<bool, AuthorityError> {
        if a.signer_authority != BY_STEWARD {
            return Ok(false);
        }
        // T1: staffing a team is a root steward's act; a team's folder access is the folder's
        // steward's, exactly as for a person.
        let covering = if matches!(a.act.as_str(), ACT_GRANT | ACT_GRANT_REVOKE) {
            grants::covering_scopes(self.tx, &self.state.organisation, a.scope_id.as_deref())
                .await?
        } else {
            BTreeSet::from([None])
        };
        grants::steward_held_at(
            self.tx,
            self.ring,
            self.state,
            self.root_fpr,
            &a.signed_by,
            &covering,
            a.at_unix,
            a.chain_seq,
            self.pass,
        )
        .await
    }

    /// A steward-signed act that counts: the only kind that may create or delete a team or set
    /// a role, so the lead check below never recurses.
    async fn counts_as_steward_act(&self, a: &TeamAct) -> Result<bool, AuthorityError> {
        Ok(self.well_formed(a).await? && self.steward_signed(a).await?)
    }

    /// Was `account` a lead of `team` at chain position `before` (exclusive)?
    async fn lead_before(
        &self,
        team: &str,
        account: &str,
        before: i64,
    ) -> Result<bool, AuthorityError> {
        for set in self.acts().iter().filter(|r| {
            r.act == ACT_ROLE_SET
                && r.team_id == team
                && r.role.as_deref() == Some(ROLE_LEAD)
                && r.subject_id.as_deref() == Some(account)
                && r.chain_seq < before
        }) {
            if !self.counts_as_steward_act(set).await? {
                continue;
            }
            let mut cleared = false;
            for clear in self.acts().iter().filter(|c| {
                c.act == ACT_ROLE_CLEAR
                    && c.undoes.as_deref() == Some(set.id.as_str())
                    && c.chain_seq < before
            }) {
                if self.counts_as_steward_act(clear).await? {
                    cleared = true;
                    break;
                }
            }
            if !cleared {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Did `team` exist, undeleted, at chain position `at` (an act at `at` itself included only
    /// when it is the create)?
    async fn team_stood_at(&self, team: &str, at: i64) -> Result<bool, AuthorityError> {
        let mut created = false;
        for c in self
            .acts()
            .iter()
            .filter(|c| c.act == ACT_CREATE && c.team_id == team && c.chain_seq <= at)
        {
            if self.counts_as_steward_act(c).await? {
                created = true;
                break;
            }
        }
        if !created {
            return Ok(false);
        }
        for d in self
            .acts()
            .iter()
            .filter(|d| d.act == ACT_DELETE && d.team_id == team && d.chain_seq < at)
        {
            if self.counts_as_steward_act(d).await? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Does this act count? Memoised for the walk.
    async fn counts(&self, a: &TeamAct) -> Result<bool, AuthorityError> {
        if let Some(v) = self.settled.lock().expect(POISON).get(&a.id).copied() {
            return Ok(v);
        }
        let verdict = self.well_formed(a).await?
            && self.team_stood_at(&a.team_id, a.chain_seq).await?
            && if a.signer_authority == BY_LEAD {
                self.lead_before(&a.team_id, &a.signed_by, a.chain_seq)
                    .await?
            } else {
                self.steward_signed(a).await?
            };
        self.settled
            .lock()
            .expect(POISON)
            .insert(a.id.clone(), verdict);
        Ok(verdict)
    }

    /// Is `a` undone by a counting row?
    async fn undone(&self, a: &TeamAct) -> Result<bool, AuthorityError> {
        for u in self
            .acts()
            .iter()
            .filter(|u| u.undoes.as_deref() == Some(a.id.as_str()))
        {
            if self.counts(u).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// A counting row of `kind` that nothing counting has undone.
    async fn live(&self, a: &TeamAct) -> Result<bool, AuthorityError> {
        Ok(self.counts(a).await? && !self.undone(a).await?)
    }

    /// Does `team` stand now?
    async fn team_live(&self, team: &str) -> Result<bool, AuthorityError> {
        self.team_stood_at(team, i64::MAX).await
    }

    /// The live `member_add` rows of `team` for `account`.
    async fn membership(
        &self,
        team: &str,
        account: &str,
    ) -> Result<Option<&'a TeamAct>, AuthorityError> {
        for a in self.acts().iter().filter(|a| {
            a.act == ACT_MEMBER_ADD && a.team_id == team && a.subject_id.as_deref() == Some(account)
        }) {
            if self.live(a).await? {
                return Ok(Some(a));
            }
        }
        Ok(None)
    }

    async fn role(
        &self,
        team: &str,
        account: &str,
        role: &str,
    ) -> Result<Option<&'a TeamAct>, AuthorityError> {
        for a in self.acts().iter().filter(|a| {
            a.act == ACT_ROLE_SET
                && a.team_id == team
                && a.subject_id.as_deref() == Some(account)
                && a.role.as_deref() == Some(role)
        }) {
            if self.live(a).await? {
                return Ok(Some(a));
            }
        }
        Ok(None)
    }
}

/// What a team gave: the folder, the capability and the act that granted it.
pub(crate) struct Through {
    pub scope: Option<String>,
    pub capability: Capability,
    pub act_id: String,
}

/// §3.4 step 6, for teams: the widest counting, unrevoked grant to a team `account` is a
/// counting member of, covering `covering` with at least `needed`. Never `steward` (T4).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn best_through_teams<'a>(
    tx: &'a Transaction<'a>,
    ring: &'a KeyRing,
    state: &'a AuthorityState,
    root_fpr: &'a [u8; 32],
    account: &str,
    covering: &BTreeSet<Option<String>>,
    needed: Capability,
    _now: i64,
    pass: &'a Mutex<QuorumPass>,
) -> Result<Option<Through>, AuthorityError> {
    if needed == Capability::Steward || state.team_acts.is_empty() {
        return Ok(None);
    }
    let walk = Walk {
        tx,
        ring,
        state,
        root_fpr,
        pass,
        settled: Mutex::new(BTreeMap::new()),
    };
    let teams: BTreeSet<&str> = state
        .team_acts
        .iter()
        .filter(|a| a.act == ACT_MEMBER_ADD && a.subject_id.as_deref() == Some(account))
        .map(|a| a.team_id.as_str())
        .collect();
    let mut best: Option<Through> = None;
    for team in teams {
        if !walk.team_live(team).await? || walk.membership(team, account).await?.is_none() {
            continue;
        }
        for g in state
            .team_acts
            .iter()
            .filter(|g| g.act == ACT_GRANT && g.team_id == team)
        {
            let Some(capability) = g.capability else {
                continue;
            };
            if capability == Capability::Steward || !capability.covers(needed) {
                continue;
            }
            if !covering.contains(&g.scope_id) {
                continue;
            }
            if !walk.live(g).await? {
                continue;
            }
            if best.as_ref().is_none_or(|b| capability > b.capability) {
                best = Some(Through {
                    scope: g.scope_id.clone(),
                    capability,
                    act_id: g.id.clone(),
                });
            }
        }
    }
    Ok(best)
}

// ---------------------------------------------------------------------------
// Proposing and committing an act
// ---------------------------------------------------------------------------

/// What a person asks to do. The server fills in the rest.
#[derive(Clone, Debug)]
pub struct TeamActRequest {
    /// `None` only for `create`, whose team id the server chooses.
    pub team: Option<String>,
    pub act: String,
    pub subject: Option<String>,
    pub role: Option<String>,
    pub scope: Option<String>,
    pub capability: Option<Capability>,
    pub undoes: Option<String>,
    /// `steward` or `lead`.
    pub signer_authority: String,
}

/// The bytes to sign and every field they cover. Sent back unchanged with the signature;
/// [`commit_act`] rebuilds the bytes from these fields and re-derives what the server chose.
#[derive(Clone, Debug)]
pub struct TeamActProposal {
    pub act_id: String,
    pub team: String,
    pub act: String,
    pub subject: Option<String>,
    pub subject_key_fpr: [u8; 32],
    pub role: Option<String>,
    pub scope: Option<String>,
    pub capability: Option<Capability>,
    pub undoes: Option<String>,
    pub signer: String,
    pub signer_key_fpr: [u8; 32],
    pub signer_authority: String,
    pub at_unix: i64,
    pub auth_epoch: i32,
    pub root_fpr: [u8; 32],
    pub bytes: Vec<u8>,
}

impl TeamActProposal {
    fn as_act(&self, organisation: &str) -> TeamAct {
        TeamAct {
            id: self.act_id.clone(),
            organisation_id: organisation.to_string(),
            team_id: self.team.clone(),
            act: self.act.clone(),
            subject_id: self.subject.clone(),
            subject_key_fpr: self.subject_key_fpr,
            role: self.role.clone(),
            scope_id: self.scope.clone(),
            capability: self.capability,
            undoes: self.undoes.clone(),
            signed_by: self.signer.clone(),
            signer_key_fpr: self.signer_key_fpr,
            signer_authority: self.signer_authority.clone(),
            signature: Vec::new(),
            at_unix: self.at_unix,
            auth_epoch: self.auth_epoch,
            chain_seq: i64::MAX,
            row_seal: Vec::new(),
        }
    }
}

/// For a new team: its slug and name, which are display data and not signed (T11).
#[derive(Clone, Debug)]
pub struct NewTeam {
    pub slug: String,
    pub name: String,
}

fn refuse() -> AuthorityError {
    AuthorityError::NotAuthorised
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 48
        && !slug.starts_with('-')
        && !slug.ends_with('-')
        && !slug.contains("--")
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn valid_name(name: &str) -> bool {
    let n = name.trim().chars().count();
    (1..=80).contains(&n) && name.trim() == name
}

/// Everything an act must satisfy **now**, asked at propose and asked again at commit. Uses
/// the same rows and the same rules as use does, so a proposal is not evidence of itself
/// (§3.5's rule, applied here).
async fn check_now<'a>(
    tx: &'a Transaction<'a>,
    walk: &Walk<'a>,
    actor: &str,
    p: &TeamActProposal,
) -> Result<(), AuthorityError> {
    let organisation = &walk.state.organisation;
    let now = now_unix();
    // The shape, as the table states it.
    let shape_ok = match p.act.as_str() {
        ACT_CREATE | ACT_DELETE => {
            p.subject.is_none()
                && p.role.is_none()
                && p.capability.is_none()
                && p.scope.is_none()
                && p.undoes.is_none()
        }
        ACT_MEMBER_ADD => {
            p.subject.is_some()
                && p.role.is_none()
                && p.capability.is_none()
                && p.scope.is_none()
                && p.undoes.is_none()
        }
        ACT_MEMBER_REMOVE => {
            p.subject.is_some()
                && p.role.is_none()
                && p.capability.is_none()
                && p.scope.is_none()
                && p.undoes.is_some()
        }
        ACT_ROLE_SET => {
            p.subject.is_some()
                && matches!(p.role.as_deref(), Some(ROLE_LEAD | ROLE_OVERSEER))
                && p.capability.is_none()
                && p.scope.is_none()
                && p.undoes.is_none()
        }
        ACT_ROLE_CLEAR => {
            p.subject.is_some()
                && p.role.is_some()
                && p.capability.is_none()
                && p.scope.is_none()
                && p.undoes.is_some()
        }
        ACT_GRANT => {
            p.subject.is_none()
                && p.role.is_none()
                && matches!(p.capability, Some(Capability::Read | Capability::Draw))
                && p.undoes.is_none()
        }
        ACT_GRANT_REVOKE => {
            p.subject.is_none() && p.role.is_none() && p.capability.is_none() && p.undoes.is_some()
        }
        _ => false,
    };
    if !shape_ok || p.signer != actor {
        return Err(refuse());
    }
    // T1, T2.
    match p.signer_authority.as_str() {
        BY_STEWARD => {}
        BY_LEAD => {
            if !matches!(p.act.as_str(), ACT_MEMBER_ADD | ACT_MEMBER_REMOVE)
                || p.subject.as_deref() == Some(actor)
            {
                return Err(refuse());
            }
        }
        _ => return Err(refuse()),
    }

    // The team.
    if p.act == ACT_CREATE {
        let taken = tx
            .query_opt("SELECT 1 FROM principals WHERE id = $1", &[&p.team])
            .await?;
        if taken.is_some() || !walk.acts().iter().all(|a| a.team_id != p.team) {
            return Err(refuse());
        }
    } else if !walk.team_live(&p.team).await? {
        return Err(refuse());
    }

    // The signer's authority, now.
    match p.signer_authority.as_str() {
        BY_STEWARD => {
            let covering = if matches!(p.act.as_str(), ACT_GRANT | ACT_GRANT_REVOKE) {
                grants::covering_scopes(tx, organisation, p.scope.as_deref()).await?
            } else {
                BTreeSet::from([None])
            };
            if !grants::steward_held_at(
                tx,
                walk.ring,
                walk.state,
                walk.root_fpr,
                actor,
                &covering,
                now,
                i64::MAX,
                walk.pass,
            )
            .await?
            {
                return Err(refuse());
            }
        }
        _ => {
            if walk.role(&p.team, actor, ROLE_LEAD).await?.is_none() {
                return Err(refuse());
            }
        }
    }

    // The person, and the row undone.
    if let Some(subject) = &p.subject {
        if matches!(p.act.as_str(), ACT_MEMBER_ADD | ACT_ROLE_SET) {
            // T13: only a member of the organisation, now.
            let member = tx
                .query_opt(
                    "SELECT 1 FROM memberships WHERE organisation_id = $1 AND account_id = $2",
                    &[organisation, subject],
                )
                .await?;
            if member.is_none() {
                return Err(refuse());
            }
        }
        // T6: bound to the person's current key, or to none if they have none yet.
        let expected = match grants::signing_key_of(tx, subject).await? {
            Some(key) => key.fpr,
            None => NO_SUBJECT_KEY,
        };
        if p.subject_key_fpr != expected {
            return Err(AuthorityError::Stale("the person's key changed"));
        }
        // Leads and supervisors sign, so they must have a key (ADR-0081 decision 3).
        if p.act == ACT_ROLE_SET && expected == NO_SUBJECT_KEY {
            return Err(AuthorityError::NoSigningKey);
        }
    } else if p.subject_key_fpr != NO_SUBJECT_KEY {
        return Err(refuse());
    }
    match p.act.as_str() {
        ACT_MEMBER_ADD => {
            let subject = p.subject.as_deref().unwrap_or_default();
            if walk.membership(&p.team, subject).await?.is_some() {
                return Err(refuse());
            }
        }
        ACT_ROLE_SET => {
            let subject = p.subject.as_deref().unwrap_or_default();
            let role = p.role.as_deref().unwrap_or_default();
            if walk.role(&p.team, subject, role).await?.is_some() {
                return Err(refuse());
            }
        }
        ACT_GRANT => {
            if let Some(scope) = &p.scope {
                let exists = tx
                    .query_opt(
                        "SELECT 1 FROM scopes WHERE id = $1 AND organisation_id = $2",
                        &[scope, organisation],
                    )
                    .await?;
                if exists.is_none() {
                    return Err(refuse());
                }
            }
            for g in walk.acts().iter().filter(|g| {
                g.act == ACT_GRANT
                    && g.team_id == p.team
                    && g.scope_id == p.scope
                    && g.capability == p.capability
            }) {
                if walk.live(g).await? {
                    return Err(refuse());
                }
            }
        }
        ACT_MEMBER_REMOVE | ACT_ROLE_CLEAR | ACT_GRANT_REVOKE => {
            let undone = p
                .undoes
                .as_deref()
                .and_then(|id| walk.find(id))
                .ok_or_else(refuse)?;
            if !undoes_the_right_row(&p.as_act(organisation), undone) || !walk.live(undone).await? {
                return Err(refuse());
            }
        }
        _ => {}
    }
    Ok(())
}

/// Bytes for `p`, with the row it undoes looked up in the verified state.
fn proposal_bytes(
    state: &AuthorityState,
    root_fpr: &[u8; 32],
    p: &TeamActProposal,
) -> Result<Vec<u8>, AuthorityError> {
    let mut acts = state.team_acts.clone();
    let me = p.as_act(&state.organisation);
    acts.push(me.clone());
    bytes_of(&state.organisation, root_fpr, &me, &acts).ok_or_else(refuse)
}

/// Fix the bytes for an act the caller wants to sign.
pub async fn propose_act(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    request: &TeamActRequest,
    new_team: Option<&NewTeam>,
    signer_key_fpr: &[u8; 32],
) -> Result<TeamActProposal, AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    // The signer's own live key, named by the browser that will sign.
    if !grants::live_signing_keys(tx, &actor)
        .await?
        .iter()
        .any(|k| k.fpr == *signer_key_fpr)
    {
        return Err(AuthorityError::NoSigningKey);
    }
    let team = match (&request.team, request.act.as_str()) {
        (None, ACT_CREATE) => ids::new_ulid().to_string(),
        (Some(team), act) if act != ACT_CREATE => team.clone(),
        _ => return Err(refuse()),
    };
    if request.act == ACT_CREATE {
        let new_team = new_team.ok_or_else(refuse)?;
        check_new_team(tx, &verified.organisation, new_team).await?;
    }
    let subject_key_fpr = match &request.subject {
        Some(subject) => match grants::signing_key_of(tx, subject).await? {
            Some(key) => key.fpr,
            None => NO_SUBJECT_KEY,
        },
        None => NO_SUBJECT_KEY,
    };
    let mut proposal = TeamActProposal {
        act_id: ids::new_ulid().to_string(),
        team,
        act: request.act.clone(),
        subject: request.subject.clone(),
        subject_key_fpr,
        role: request.role.clone(),
        scope: request.scope.clone(),
        capability: request.capability,
        undoes: request.undoes.clone(),
        signer: actor.clone(),
        signer_key_fpr: *signer_key_fpr,
        signer_authority: request.signer_authority.clone(),
        at_unix: now_unix(),
        auth_epoch: verified.auth_epoch,
        root_fpr: verified.root_fpr,
        bytes: Vec::new(),
    };
    let pass = Mutex::new(QuorumPass::default());
    let walk = Walk {
        tx,
        ring: auth.ring,
        state: &verified.state,
        root_fpr: &verified.root_fpr,
        pass: &pass,
        settled: Mutex::new(BTreeMap::new()),
    };
    check_now(tx, &walk, &actor, &proposal).await?;
    proposal.bytes = proposal_bytes(&verified.state, &verified.root_fpr, &proposal)?;
    Ok(proposal)
}

async fn check_new_team(
    tx: &Transaction<'_>,
    organisation: &str,
    new_team: &NewTeam,
) -> Result<(), AuthorityError> {
    if !valid_slug(&new_team.slug) || !valid_name(&new_team.name) {
        return Err(refuse());
    }
    let taken = tx
        .query_opt(
            "SELECT 1 FROM teams WHERE organisation_id = $1 AND slug = $2 AND NOT deleted",
            &[&organisation, &new_team.slug],
        )
        .await?;
    if taken.is_some() {
        return Err(refuse());
    }
    Ok(())
}

fn entry_type_of(act: &str) -> Option<EntryType> {
    Some(match act {
        ACT_CREATE => EntryType::TeamCreated,
        ACT_DELETE => EntryType::TeamDeleted,
        ACT_MEMBER_ADD => EntryType::TeamMemberAdded,
        ACT_MEMBER_REMOVE => EntryType::TeamMemberRemoved,
        ACT_ROLE_SET => EntryType::TeamRoleSet,
        ACT_ROLE_CLEAR => EntryType::TeamRoleCleared,
        ACT_GRANT => EntryType::TeamGrantSigned,
        ACT_GRANT_REVOKE => EntryType::TeamGrantRevoked,
        _ => return None,
    })
}

/// Store a signed act: every check again, the signature, the chain entry, the sealed row, and
/// the head advanced, in the caller's transaction.
pub async fn commit_act(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    proposal: &TeamActProposal,
    new_team: Option<&NewTeam>,
    signature: &[u8],
) -> Result<String, AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    let organisation = verified.organisation.clone();

    // The server's own choices, re-derived (§3.5: a proposal is not evidence of itself).
    if proposal.auth_epoch != verified.auth_epoch {
        return Err(AuthorityError::Stale("the authority head moved"));
    }
    if proposal.root_fpr != verified.root_fpr {
        return Err(refuse());
    }
    if (now_unix() - proposal.at_unix).abs() > PROPOSAL_SKEW_SECONDS {
        return Err(AuthorityError::Stale("the proposal is too old"));
    }
    let pass = Mutex::new(QuorumPass::default());
    let walk = Walk {
        tx,
        ring: auth.ring,
        state: &verified.state,
        root_fpr: &verified.root_fpr,
        pass: &pass,
        settled: Mutex::new(BTreeMap::new()),
    };
    check_now(tx, &walk, &actor, proposal).await?;
    let message = proposal_bytes(&verified.state, &verified.root_fpr, proposal)?;

    // The signature, under the named key, which must be the actor's and in service.
    let key = grants::key_by_fingerprint(tx, auth.ring, &proposal.signer_key_fpr, proposal.at_unix)
        .await?;
    if key.account_id != actor {
        return Err(AuthorityError::NoSigningKey);
    }
    authority::verify_es256(&key.public_key, &message, signature)?;

    // A new team's principal and display row come first: the act names them.
    if proposal.act == ACT_CREATE {
        let new_team = new_team.ok_or_else(refuse)?;
        check_new_team(tx, &organisation, new_team).await?;
        tx.execute(
            "INSERT INTO principals (id, kind) VALUES ($1, 'team')",
            &[&proposal.team],
        )
        .await?;
        tx.execute(
            "INSERT INTO teams (id, organisation_id, slug, name) VALUES ($1, $2, $3, $4)",
            &[
                &proposal.team,
                &organisation,
                &new_team.slug,
                &new_team.name,
            ],
        )
        .await?;
    }
    if proposal.act == ACT_DELETE {
        tx.execute(
            "UPDATE teams SET deleted = true WHERE id = $1 AND organisation_id = $2",
            &[&proposal.team, &organisation],
        )
        .await?;
    }

    let entry_type = entry_type_of(&proposal.act).ok_or_else(refuse)?;
    let mut fields = vec![
        ("team", Json::Str(proposal.team.clone())),
        ("act_id", Json::Str(proposal.act_id.clone())),
        ("actor", Json::Str(actor.clone())),
        ("as", Json::Str(proposal.signer_authority.clone())),
        ("at", Json::Int(proposal.at_unix)),
    ];
    if let Some(s) = &proposal.subject {
        fields.push(("account", Json::Str(s.clone())));
    }
    if let Some(r) = &proposal.role {
        fields.push(("role", Json::Str(r.clone())));
    }
    if proposal.act == ACT_GRANT || proposal.act == ACT_GRANT_REVOKE {
        fields.push(("scope", opt(&proposal.scope)));
    }
    if let Some(c) = proposal.capability {
        fields.push(("capability", Json::Str(c.as_str().to_string())));
    }
    if let Some(u) = &proposal.undoes {
        fields.push(("undoes", Json::Str(u.clone())));
    }
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        entry_type,
        &entry_metadata(entry_type, &fields),
    )
    .await?;

    let mut row = proposal.as_act(&organisation);
    row.signature = signature.to_vec();
    row.chain_seq = appended.seq;
    let seal = seal_of(&grants::row_key_for(auth.ring, &organisation), &row);
    tx.execute(
        "INSERT INTO team_acts \
             (id, organisation_id, team_id, act, subject_id, subject_key_fpr, role, scope_id, \
              capability, undoes, signed_by, signer_key_fpr, signer_authority, signature, \
              at_unix, auth_epoch, chain_seq, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
        &[
            &row.id,
            &organisation,
            &row.team_id,
            &row.act,
            &row.subject_id,
            &row.subject_key_fpr.to_vec(),
            &row.role,
            &row.scope_id,
            &row.capability.map(|c| c.as_str().to_string()),
            &row.undoes,
            &row.signed_by,
            &row.signer_key_fpr.to_vec(),
            &row.signer_authority,
            &row.signature,
            &row.at_unix,
            &row.auth_epoch,
            &row.chain_seq,
            &seal.to_vec(),
        ],
    )
    .await?;

    grants::advance_head(tx, auth.ring, auth.ctx, auth.tenant_key).await?;
    Ok(row.id)
}

/// Rename a team: display data, a root steward's act, on the chain without a key signature
/// (ADR-0081 decision 5 signs create and delete, not renames).
pub async fn rename(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    team: &str,
    new_team: &NewTeam,
) -> Result<(), AuthorityError> {
    if !grants::is_steward(tx, auth).await? {
        return Err(refuse());
    }
    let organisation = auth.ctx.tenant().to_string();
    if !valid_slug(&new_team.slug) || !valid_name(&new_team.name) {
        return Err(refuse());
    }
    let current = tx
        .query_opt(
            "SELECT slug FROM teams WHERE id = $1 AND organisation_id = $2 AND NOT deleted",
            &[&team, &organisation],
        )
        .await?
        .ok_or_else(refuse)?;
    let slug: String = current.get(0);
    if slug != new_team.slug {
        check_new_team(tx, &organisation, new_team).await?;
    }
    tx.execute(
        "UPDATE teams SET slug = $3, name = $4 WHERE id = $1 AND organisation_id = $2",
        &[&team, &organisation, &new_team.slug, &new_team.name],
    )
    .await?;
    chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        EntryType::TeamRenamed,
        &entry_metadata(
            EntryType::TeamRenamed,
            &[
                ("team", Json::Str(team.to_string())),
                ("actor", Json::Str(auth.ctx.actor().to_string())),
                ("slug", Json::Str(new_team.slug.clone())),
            ],
        ),
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading teams back, for the screens
// ---------------------------------------------------------------------------

/// One person's place in a team: the act that put them there.
#[derive(Clone, Debug)]
pub struct Seat {
    pub account: String,
    pub act_id: String,
}

/// One folder a team may open.
#[derive(Clone, Debug)]
pub struct TeamGrant {
    pub act_id: String,
    pub scope: Option<String>,
    pub capability: Capability,
}

/// A team as the screens show it. Every list is of counting, live rows only.
#[derive(Clone, Debug)]
pub struct TeamView {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub members: Vec<Seat>,
    pub leads: Vec<Seat>,
    pub overseers: Vec<Seat>,
    pub grants: Vec<TeamGrant>,
    /// May the caller add and remove members (a root steward, or this team's lead)?
    pub may_staff: bool,
}

/// One act in a team's History tab, with whether it counts.
#[derive(Clone, Debug)]
pub struct HistoryLine {
    pub act: TeamAct,
    pub counts: bool,
}

/// The teams the caller may see: every team for a steward at the organisation's root; for
/// anyone else, the teams they are in, lead or supervise.
pub async fn list(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
) -> Result<(bool, Vec<TeamView>), AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    let steward =
        grants::holds_in_verified_state(tx, auth, &verified, None, Capability::Steward).await?;
    let pass = Mutex::new(QuorumPass::default());
    let walk = Walk {
        tx,
        ring: auth.ring,
        state: &verified.state,
        root_fpr: &verified.root_fpr,
        pass: &pass,
        settled: Mutex::new(BTreeMap::new()),
    };
    let rows = tx
        .query(
            "SELECT id, slug, name FROM teams WHERE organisation_id = $1 AND NOT deleted \
              ORDER BY name, id",
            &[&verified.organisation],
        )
        .await?;
    let mut out = Vec::new();
    for row in rows {
        let id: String = row.get(0);
        if !walk.team_live(&id).await? {
            continue;
        }
        let mut view = TeamView {
            id: id.clone(),
            slug: row.get(1),
            name: row.get(2),
            members: Vec::new(),
            leads: Vec::new(),
            overseers: Vec::new(),
            grants: Vec::new(),
            may_staff: steward,
        };
        for a in walk.acts().iter().filter(|a| a.team_id == id) {
            let seat = || Seat {
                account: a.subject_id.clone().unwrap_or_default(),
                act_id: a.id.clone(),
            };
            match a.act.as_str() {
                ACT_MEMBER_ADD if walk.live(a).await? => view.members.push(seat()),
                ACT_ROLE_SET if walk.live(a).await? => match a.role.as_deref() {
                    Some(ROLE_LEAD) => view.leads.push(seat()),
                    Some(ROLE_OVERSEER) => view.overseers.push(seat()),
                    _ => {}
                },
                ACT_GRANT if walk.live(a).await? => {
                    if let Some(capability) = a.capability {
                        view.grants.push(TeamGrant {
                            act_id: a.id.clone(),
                            scope: a.scope_id.clone(),
                            capability,
                        });
                    }
                }
                _ => {}
            }
        }
        let involved = view
            .members
            .iter()
            .chain(view.leads.iter())
            .chain(view.overseers.iter())
            .any(|s| s.account == actor);
        if view.leads.iter().any(|s| s.account == actor) {
            view.may_staff = true;
        }
        if steward || involved {
            out.push(view);
        }
    }
    Ok((steward, out))
}

/// A team's History tab: every act on it, oldest first, each with whether it counts. For a
/// root steward, and for anyone the team is visible to (its members, leads and supervisors).
pub async fn history(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    team: &str,
) -> Result<Vec<HistoryLine>, AuthorityError> {
    let (_, visible) = list(tx, auth).await?;
    let verified = grants::verify_authority_state(tx, auth).await?;
    let deleted_but_steward = !visible.iter().any(|t| t.id == team)
        && grants::holds_in_verified_state(tx, auth, &verified, None, Capability::Steward).await?;
    if !visible.iter().any(|t| t.id == team) && !deleted_but_steward {
        return Err(refuse());
    }
    let pass = Mutex::new(QuorumPass::default());
    let walk = Walk {
        tx,
        ring: auth.ring,
        state: &verified.state,
        root_fpr: &verified.root_fpr,
        pass: &pass,
        settled: Mutex::new(BTreeMap::new()),
    };
    let mut out = Vec::new();
    for a in walk.acts().iter().filter(|a| a.team_id == team) {
        out.push(HistoryLine {
            act: a.clone(),
            counts: walk.counts(a).await?,
        });
    }
    if out.is_empty() {
        return Err(refuse());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_lower_case_words_joined_by_single_hyphens() {
        for good in ["network-design", "ops", "noc-2", "a"] {
            assert!(valid_slug(good), "{good}");
        }
        for bad in [
            "",
            "Network",
            "-ops",
            "ops-",
            "a--b",
            "a_b",
            "a b",
            &"x".repeat(49),
        ] {
            assert!(!valid_slug(bad), "{bad}");
        }
    }

    #[test]
    fn an_undo_names_its_own_kind_of_row_in_the_same_team() {
        let base = TeamAct {
            id: "01JQZ0000000000000000000AA".into(),
            organisation_id: "o".into(),
            team_id: "t".into(),
            act: ACT_MEMBER_ADD.into(),
            subject_id: Some("p".into()),
            subject_key_fpr: NO_SUBJECT_KEY,
            role: None,
            scope_id: None,
            capability: None,
            undoes: None,
            signed_by: "s".into(),
            signer_key_fpr: [1; 32],
            signer_authority: BY_STEWARD.into(),
            signature: Vec::new(),
            at_unix: 1,
            auth_epoch: 1,
            chain_seq: 5,
            row_seal: Vec::new(),
        };
        let remove = TeamAct {
            id: "01JQZ0000000000000000000BB".into(),
            act: ACT_MEMBER_REMOVE.into(),
            undoes: Some(base.id.clone()),
            chain_seq: 6,
            ..base.clone()
        };
        assert!(undoes_the_right_row(&remove, &base));
        // Another person, another team, the wrong kind, or an undo older than its row: no.
        let other_person = TeamAct {
            subject_id: Some("q".into()),
            ..remove.clone()
        };
        assert!(!undoes_the_right_row(&other_person, &base));
        let other_team = TeamAct {
            team_id: "u".into(),
            ..remove.clone()
        };
        assert!(!undoes_the_right_row(&other_team, &base));
        let wrong_kind = TeamAct {
            act: ACT_ROLE_CLEAR.into(),
            ..remove.clone()
        };
        assert!(!undoes_the_right_row(&wrong_kind, &base));
        let earlier = TeamAct {
            chain_seq: 4,
            ..remove
        };
        assert!(!undoes_the_right_row(&earlier, &base));
    }
}
