//! Team roles with a title and powers (migration 0071; ADR-0081's "Later" item 3, brought
//! forward by sign-off card r102 version 2).
//!
//! A role is a name for a set of powers from one fixed list ([`Power`]). Three come ready-made
//! with fixed ids: `lead` (Lead), `overseer` (Supervisor; `.context/conventions.md` reserves the
//! other word for the AI layer) and `tech` (Maintenance tech). A root Steward may change any
//! role's title or powers, add a role (its id a ULID) or retire one they added. Every change is
//! a signed, append-only row in `team_role_defs`, sealed and in the authority head's digest, so
//! a deleted row (which would bring back an older definition, possibly with a power since taken
//! away) refuses the organisation's authority.
//!
//! **A role never reaches a folder.** Access comes only from grants, to people and to teams;
//! no power below is about seeing anything (ADR-0081 §3.7 constraint 3). A role is held on one
//! team by a `role_set` act in `team_acts`, which only a root Steward signs.
//!
//! **Which definition counts** for a use at chain position `p` is the latest *counting*
//! definition of that role before `p`: its seal recomputes, its signature verifies under the
//! signer's key at the time, and the signer held `steward` at the organisation's root at the
//! row's chain position. With no counting definition, a ready-made role has its preset and a
//! role a Steward made does not exist. A retired role gives no powers.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use deadpool_postgres::Transaction;
use fathom_canon::Json;

use crate::authority::{self, RowFacts, TeamRoleFacts};
use crate::chain::EntryType;
use crate::chains;
use crate::crypto::{hex, now_unix, Key32};
use crate::grants::{
    self, as_32, entry_metadata, AuthorityError, AuthorityState, QuorumPass, PROPOSAL_SKEW_SECONDS,
};
use crate::ids;
use crate::keys::KeyRing;

/// The fixed list of powers, in the order the canonical text and the screens use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Power {
    /// Assign and reassign the team's work.
    Assign,
    /// Set due dates on the team's work.
    DueDates,
    /// Approve the team's plans where a folder asks for approval (migration 0072).
    ApprovePlans,
    /// Add and remove the team's members, from people already in the organisation (ADR-0081
    /// decision 4). The only power that signs a team act.
    Members,
    /// See the team's history.
    History,
    /// Start a plan without approval, giving a reason, to be approved afterwards.
    EmergencyStart,
}

impl Power {
    pub const ALL: [Power; 6] = [
        Power::Assign,
        Power::DueDates,
        Power::ApprovePlans,
        Power::Members,
        Power::History,
        Power::EmergencyStart,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Power::Assign => "assign",
            Power::DueDates => "due_dates",
            Power::ApprovePlans => "approve_plans",
            Power::Members => "members",
            Power::History => "history",
            Power::EmergencyStart => "emergency_start",
        }
    }

    pub fn parse(text: &str) -> Option<Power> {
        Power::ALL.into_iter().find(|p| p.as_str() == text)
    }
}

/// The canonical text of a set of powers: comma-separated, in [`Power::ALL`]'s order.
pub fn powers_text(powers: &BTreeSet<Power>) -> String {
    Power::ALL
        .into_iter()
        .filter(|p| powers.contains(p))
        .map(Power::as_str)
        .collect::<Vec<_>>()
        .join(",")
}

/// Parse canonical powers text; anything not in canonical form (unknown, repeated, out of
/// order) is `None`, so one set has one encoding under the signature.
pub fn parse_powers(text: &str) -> Option<BTreeSet<Power>> {
    let set: BTreeSet<Power> = if text.is_empty() {
        BTreeSet::new()
    } else {
        text.split(',')
            .map(Power::parse)
            .collect::<Option<BTreeSet<Power>>>()?
    };
    (powers_text(&set) == text).then_some(set)
}

pub const ROLE_LEAD: &str = "lead";
pub const ROLE_OVERSEER: &str = "overseer";
pub const ROLE_TECH: &str = "tech";

/// The ready-made roles: id, title, powers. A Steward may change the title and powers; the id
/// stays, and a ready-made role is never retired.
pub fn presets() -> [(&'static str, &'static str, BTreeSet<Power>); 3] {
    [
        (ROLE_LEAD, "Lead", Power::ALL.into_iter().collect()),
        (
            ROLE_OVERSEER,
            "Supervisor",
            BTreeSet::from([
                Power::Assign,
                Power::DueDates,
                Power::ApprovePlans,
                Power::History,
            ]),
        ),
        (
            ROLE_TECH,
            "Maintenance tech",
            BTreeSet::from([Power::EmergencyStart]),
        ),
    ]
}

pub fn is_preset(role: &str) -> bool {
    matches!(role, ROLE_LEAD | ROLE_OVERSEER | ROLE_TECH)
}

/// A role id: a ready-made one, or a ULID in Crockford's alphabet, as the table's CHECK says.
pub fn valid_role_id(role: &str) -> bool {
    is_preset(role)
        || (role.len() == 26
            && role
                .chars()
                .all(|c| c.is_ascii_digit() || (c.is_ascii_uppercase() && !"ILOU".contains(c))))
}

pub fn valid_title(title: &str) -> bool {
    let n = title.trim().chars().count();
    (1..=40).contains(&n) && title.trim() == title && !title.chars().any(char::is_control)
}

/// What a role is at some chain position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Definition {
    pub role: String,
    pub title: String,
    pub powers: BTreeSet<Power>,
    pub retired: bool,
    /// The definition row, or `None` for a ready-made role nobody has changed.
    pub def_id: Option<String>,
}

impl Definition {
    pub fn has(&self, power: Power) -> bool {
        !self.retired && self.powers.contains(&power)
    }
}

fn preset_definition(role: &str) -> Option<Definition> {
    presets()
        .into_iter()
        .find(|(id, _, _)| *id == role)
        .map(|(id, title, powers)| Definition {
            role: id.to_string(),
            title: title.to_string(),
            powers,
            retired: false,
            def_id: None,
        })
}

/// One signed definition, as stored.
#[derive(Clone, Debug)]
pub struct RoleDef {
    pub id: String,
    pub organisation_id: String,
    pub role: String,
    pub title: String,
    pub powers: String,
    pub retired: bool,
    pub signed_by: String,
    pub signer_key_fpr: [u8; 32],
    pub signature: Vec<u8>,
    pub at_unix: i64,
    pub auth_epoch: i32,
    pub chain_seq: i64,
    pub row_seal: Vec<u8>,
}

const DEF_COLUMNS: &str = "id, organisation_id, role, title, powers, retired, signed_by, \
     signer_key_fpr, signature, at_unix, auth_epoch, chain_seq, row_seal";

/// Every role definition of one organisation, in chain order.
pub(crate) async fn read_defs(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<Vec<RoleDef>, AuthorityError> {
    let rows = tx
        .query(
            &format!(
                "SELECT {DEF_COLUMNS} FROM team_role_defs \
                  WHERE organisation_id = $1 ORDER BY chain_seq, id"
            ),
            &[&organisation],
        )
        .await?;
    rows.iter()
        .map(|row| {
            let fpr: Vec<u8> = row.get(7);
            Ok(RoleDef {
                id: row.get(0),
                organisation_id: row.get(1),
                role: row.get(2),
                title: row.get(3),
                powers: row.get(4),
                retired: row.get(5),
                signed_by: row.get(6),
                signer_key_fpr: as_32(&fpr, "role definition signer key fingerprint")?,
                signature: row.get(8),
                at_unix: row.get(9),
                auth_epoch: row.get(10),
                chain_seq: row.get(11),
                row_seal: row.get(12),
            })
        })
        .collect()
}

/// The canonical state of a definition, for its seal. One function on write and on read.
fn row_state(d: &RoleDef) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("at".to_string(), Json::Int(d.at_unix));
    map.insert("auth_epoch".to_string(), Json::Int(i64::from(d.auth_epoch)));
    map.insert(
        "organisation_id".to_string(),
        Json::Str(d.organisation_id.clone()),
    );
    map.insert("powers".to_string(), Json::Str(d.powers.clone()));
    map.insert("retired".to_string(), Json::Bool(d.retired));
    map.insert("role".to_string(), Json::Str(d.role.clone()));
    map.insert("signature".to_string(), Json::Str(hex(&d.signature)));
    map.insert("signed_by".to_string(), Json::Str(d.signed_by.clone()));
    map.insert(
        "signer_key_fpr".to_string(),
        Json::Str(hex(&d.signer_key_fpr)),
    );
    map.insert("title".to_string(), Json::Str(d.title.clone()));
    Json::Obj(map).to_canonical_bytes()
}

fn seal_of(row_key: &Key32, d: &RoleDef) -> [u8; 32] {
    authority::row_seal(
        row_key,
        &RowFacts {
            table: "team_role_defs",
            row_id: &d.id,
            chain_seq: d.chain_seq,
            row_version: 1,
            row_state: &row_state(d),
        },
    )
}

/// The head's digest entries for role definitions: every row, recomputed.
pub(crate) fn digest_entries(defs: &[RoleDef], row_key: &Key32) -> Vec<(String, [u8; 32])> {
    defs.iter()
        .map(|d| (format!("team_role_defs/{}", d.id), seal_of(row_key, d)))
        .collect()
}

/// Every definition's stored seal recomputes.
pub(crate) fn verify_stored_seals(defs: &[RoleDef], row_key: &Key32) -> Result<(), AuthorityError> {
    for d in defs {
        if d.row_seal != seal_of(row_key, d) {
            return Err(AuthorityError::Unverifiable("role definition row seal"));
        }
    }
    Ok(())
}

fn bytes_of(organisation: &str, root_fpr: &[u8; 32], d: &RoleDef) -> Vec<u8> {
    authority::team_role_bytes(&TeamRoleFacts {
        organisation,
        root_pubkey_fpr: root_fpr,
        def_id: &d.id,
        role: &d.role,
        title: &d.title,
        powers: &d.powers,
        retired: d.retired,
        signer: &d.signed_by,
        signer_key_fpr: &d.signer_key_fpr,
        at_unix: d.at_unix,
        auth_epoch: d.auth_epoch,
    })
}

fn is_a_disqualification(error: &AuthorityError) -> bool {
    matches!(
        error,
        AuthorityError::Unverifiable(_)
            | AuthorityError::Signature(_)
            | AuthorityError::NoSigningKey
    )
}

const POISON: &str = "the role walk's lock is never held across an await";

/// One authorisation's look at role definitions: which count, and what a role is at a chain
/// position. A memo within one use, dropped with it, never a stored verdict.
pub(crate) struct Roles<'a> {
    pub(crate) tx: &'a Transaction<'a>,
    pub(crate) ring: &'a KeyRing,
    pub(crate) state: &'a AuthorityState,
    pub(crate) root_fpr: &'a [u8; 32],
    pub(crate) pass: &'a Mutex<QuorumPass>,
    settled: Mutex<BTreeMap<String, bool>>,
}

impl<'a> Roles<'a> {
    pub(crate) fn new(
        tx: &'a Transaction<'a>,
        ring: &'a KeyRing,
        state: &'a AuthorityState,
        root_fpr: &'a [u8; 32],
        pass: &'a Mutex<QuorumPass>,
    ) -> Self {
        Roles {
            tx,
            ring,
            state,
            root_fpr,
            pass,
            settled: Mutex::new(BTreeMap::new()),
        }
    }

    /// Does this definition count: seal, shape, signature, and a root steward at its position?
    async fn counts(&self, d: &RoleDef) -> Result<bool, AuthorityError> {
        if let Some(v) = self.settled.lock().expect(POISON).get(&d.id).copied() {
            return Ok(v);
        }
        let verdict = self.check(d).await?;
        self.settled
            .lock()
            .expect(POISON)
            .insert(d.id.clone(), verdict);
        Ok(verdict)
    }

    async fn check(&self, d: &RoleDef) -> Result<bool, AuthorityError> {
        let row_key = grants::row_key_for(self.ring, &self.state.organisation);
        if d.row_seal != seal_of(&row_key, d)
            || d.organisation_id != self.state.organisation
            || !valid_role_id(&d.role)
            || !valid_title(&d.title)
            || parse_powers(&d.powers).is_none()
            || (d.retired && is_preset(&d.role))
        {
            return Ok(false);
        }
        let message = bytes_of(&self.state.organisation, self.root_fpr, d);
        let signer = match grants::key_by_fingerprint(
            self.tx,
            self.ring,
            &d.signer_key_fpr,
            d.at_unix,
        )
        .await
        {
            Ok(key) => key,
            Err(e) if is_a_disqualification(&e) => return Ok(false),
            Err(e) => return Err(e),
        };
        if signer.account_id != d.signed_by
            || authority::verify_es256(&signer.public_key, &message, &d.signature).is_err()
        {
            return Ok(false);
        }
        grants::steward_held_at(
            self.tx,
            self.ring,
            self.state,
            self.root_fpr,
            &d.signed_by,
            &BTreeSet::from([None]),
            d.at_unix,
            d.chain_seq,
            self.pass,
        )
        .await
    }

    /// What `role` is just before chain position `before`: the latest counting definition, or
    /// the preset, or `None` for a role nobody defined.
    pub(crate) async fn at(
        &self,
        role: &str,
        before: i64,
    ) -> Result<Option<Definition>, AuthorityError> {
        for d in self
            .state
            .role_defs
            .iter()
            .rev()
            .filter(|d| d.role == role && d.chain_seq < before)
        {
            if self.counts(d).await? {
                return Ok(Some(Definition {
                    role: d.role.clone(),
                    title: d.title.clone(),
                    powers: parse_powers(&d.powers).unwrap_or_default(),
                    retired: d.retired,
                    def_id: Some(d.id.clone()),
                }));
            }
        }
        Ok(preset_definition(role))
    }

    /// Every role as it stands now, ready-made first, then the rest by first definition.
    pub(crate) async fn all_now(&self) -> Result<Vec<Definition>, AuthorityError> {
        let mut ids: Vec<String> = presets().iter().map(|(id, _, _)| id.to_string()).collect();
        for d in &self.state.role_defs {
            if !ids.contains(&d.role) {
                ids.push(d.role.clone());
            }
        }
        let mut out = Vec::new();
        for id in ids {
            if let Some(def) = self.at(&id, i64::MAX).await? {
                out.push(def);
            }
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Proposing and committing a definition
// ---------------------------------------------------------------------------

/// What a root Steward asks: `role` is `None` for a new role, whose id the server chooses.
#[derive(Clone, Debug)]
pub struct RoleRequest {
    pub role: Option<String>,
    pub title: String,
    pub powers: BTreeSet<Power>,
    pub retired: bool,
}

/// The bytes to sign and every field they cover; sent back unchanged with the signature.
#[derive(Clone, Debug)]
pub struct RoleProposal {
    pub def_id: String,
    pub role: String,
    pub title: String,
    pub powers: String,
    pub retired: bool,
    pub signer: String,
    pub signer_key_fpr: [u8; 32],
    pub at_unix: i64,
    pub auth_epoch: i32,
    pub root_fpr: [u8; 32],
    pub bytes: Vec<u8>,
}

impl RoleProposal {
    fn as_def(&self, organisation: &str) -> RoleDef {
        RoleDef {
            id: self.def_id.clone(),
            organisation_id: organisation.to_string(),
            role: self.role.clone(),
            title: self.title.clone(),
            powers: self.powers.clone(),
            retired: self.retired,
            signed_by: self.signer.clone(),
            signer_key_fpr: self.signer_key_fpr,
            signature: Vec::new(),
            at_unix: self.at_unix,
            auth_epoch: self.auth_epoch,
            chain_seq: i64::MAX,
            row_seal: Vec::new(),
        }
    }
}

fn refuse() -> AuthorityError {
    AuthorityError::NotAuthorised
}

/// Everything a definition must satisfy now, at propose and again at commit.
async fn check_now(
    roles: &Roles<'_>,
    actor: &str,
    now: i64,
    p: &RoleProposal,
) -> Result<(), AuthorityError> {
    if p.signer != actor
        || !valid_role_id(&p.role)
        || !valid_title(&p.title)
        || parse_powers(&p.powers).is_none()
        || (p.retired && is_preset(&p.role))
    {
        return Err(refuse());
    }
    if !grants::steward_held_at(
        roles.tx,
        roles.ring,
        roles.state,
        roles.root_fpr,
        actor,
        &BTreeSet::from([None]),
        now,
        i64::MAX,
        roles.pass,
    )
    .await?
    {
        return Err(refuse());
    }
    let current = roles.at(&p.role, i64::MAX).await?;
    match &current {
        // A new role: its id must be unused.
        None => {
            if is_preset(&p.role)
                || roles.state.role_defs.iter().any(|d| d.role == p.role)
                || p.retired
            {
                return Err(refuse());
            }
        }
        // A retired role stays retired.
        Some(def) if def.retired => return Err(refuse()),
        Some(_) => {}
    }
    // One live title per organisation, so two roles never read the same on a screen.
    let mut seen = BTreeSet::new();
    for id in roles
        .state
        .role_defs
        .iter()
        .map(|d| d.role.clone())
        .chain(presets().iter().map(|(id, _, _)| id.to_string()))
    {
        if id == p.role || !seen.insert(id.clone()) {
            continue;
        }
        if let Some(other) = roles.at(&id, i64::MAX).await? {
            if !other.retired && other.title.eq_ignore_ascii_case(&p.title) {
                return Err(refuse());
            }
        }
    }
    Ok(())
}

/// Fix the bytes for a definition a root Steward wants to sign.
pub async fn propose(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    request: &RoleRequest,
    signer_key_fpr: &[u8; 32],
) -> Result<RoleProposal, AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    if !grants::live_signing_keys(tx, &actor)
        .await?
        .iter()
        .any(|k| k.fpr == *signer_key_fpr)
    {
        return Err(AuthorityError::NoSigningKey);
    }
    let mut proposal = RoleProposal {
        def_id: ids::new_ulid().to_string(),
        role: match &request.role {
            Some(role) => role.clone(),
            None => ids::new_ulid().to_string(),
        },
        title: request.title.clone(),
        powers: powers_text(&request.powers),
        retired: request.retired,
        signer: actor.clone(),
        signer_key_fpr: *signer_key_fpr,
        at_unix: now_unix(),
        auth_epoch: verified.auth_epoch,
        root_fpr: verified.root_fpr,
        bytes: Vec::new(),
    };
    let pass = Mutex::new(QuorumPass::default());
    let roles = Roles::new(tx, auth.ring, &verified.state, &verified.root_fpr, &pass);
    check_now(&roles, &actor, proposal.at_unix, &proposal).await?;
    proposal.bytes = bytes_of(
        &verified.organisation,
        &verified.root_fpr,
        &proposal.as_def(&verified.organisation),
    );
    Ok(proposal)
}

/// Store a signed definition: every check again, the signature, the chain entry, the sealed
/// row, and the head advanced, in the caller's transaction.
pub async fn commit(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    proposal: &RoleProposal,
    signature: &[u8],
) -> Result<String, AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    let organisation = verified.organisation.clone();
    if proposal.auth_epoch != verified.auth_epoch {
        return Err(AuthorityError::Stale("the authority head moved"));
    }
    if proposal.root_fpr != verified.root_fpr {
        return Err(refuse());
    }
    let now = now_unix();
    if (now - proposal.at_unix).abs() > PROPOSAL_SKEW_SECONDS {
        return Err(AuthorityError::Stale("the proposal is too old"));
    }
    let pass = Mutex::new(QuorumPass::default());
    let roles = Roles::new(tx, auth.ring, &verified.state, &verified.root_fpr, &pass);
    check_now(&roles, &actor, now, proposal).await?;
    let message = bytes_of(
        &organisation,
        &verified.root_fpr,
        &proposal.as_def(&organisation),
    );
    let key = grants::key_by_fingerprint(tx, auth.ring, &proposal.signer_key_fpr, proposal.at_unix)
        .await?;
    if key.account_id != actor {
        return Err(AuthorityError::NoSigningKey);
    }
    authority::verify_es256(&key.public_key, &message, signature)?;

    let entry_type = EntryType::TeamRoleDefined;
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        entry_type,
        &entry_metadata(
            entry_type,
            &[
                ("role", Json::Str(proposal.role.clone())),
                ("definition", Json::Str(proposal.def_id.clone())),
                ("powers", Json::Str(proposal.powers.clone())),
                ("retired", Json::Bool(proposal.retired)),
                ("actor", Json::Str(actor.clone())),
                ("at", Json::Int(proposal.at_unix)),
            ],
        ),
    )
    .await?;

    let mut row = proposal.as_def(&organisation);
    row.signature = signature.to_vec();
    row.chain_seq = appended.seq;
    let seal = seal_of(&grants::row_key_for(auth.ring, &organisation), &row);
    tx.execute(
        "INSERT INTO team_role_defs \
             (id, organisation_id, role, title, powers, retired, signed_by, signer_key_fpr, \
              signature, at_unix, auth_epoch, chain_seq, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        &[
            &row.id,
            &organisation,
            &row.role,
            &row.title,
            &row.powers,
            &row.retired,
            &row.signed_by,
            &row.signer_key_fpr.to_vec(),
            &row.signature,
            &row.at_unix,
            &row.auth_epoch,
            &row.chain_seq,
            &seal.to_vec(),
        ],
    )
    .await?;
    grants::advance_head(tx, auth.ring, auth.ctx, auth.tenant_key).await?;
    Ok(row.role)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powers_have_one_encoding() {
        let set = BTreeSet::from([Power::EmergencyStart, Power::Assign]);
        assert_eq!(powers_text(&set), "assign,emergency_start");
        assert_eq!(parse_powers("assign,emergency_start"), Some(set));
        assert_eq!(parse_powers(""), Some(BTreeSet::new()));
        // Out of order, repeated, unknown or padded: refused, never normalised.
        assert_eq!(parse_powers("emergency_start,assign"), None);
        assert_eq!(parse_powers("assign,assign"), None);
        assert_eq!(parse_powers("assign,steward"), None);
        assert_eq!(parse_powers("assign, history"), None);
        assert_eq!(parse_powers(","), None);
    }

    #[test]
    fn presets_are_what_the_card_shows() {
        let lead = preset_definition(ROLE_LEAD).expect("lead");
        assert_eq!(lead.title, "Lead");
        assert!(Power::ALL.iter().all(|p| lead.has(*p)));
        let overseer = preset_definition(ROLE_OVERSEER).expect("overseer");
        assert_eq!(overseer.title, "Supervisor");
        assert!(overseer.has(Power::ApprovePlans));
        assert!(!overseer.has(Power::Members));
        assert!(!overseer.has(Power::EmergencyStart));
        let tech = preset_definition(ROLE_TECH).expect("tech");
        assert_eq!(tech.title, "Maintenance tech");
        assert_eq!(tech.powers, BTreeSet::from([Power::EmergencyStart]));
        assert!(preset_definition("01JQZ0000000000000000000NN").is_none());
    }

    #[test]
    fn role_ids_and_titles() {
        assert!(valid_role_id("lead") && valid_role_id("tech"));
        assert!(valid_role_id("01JQZ0000000000000000000NN"));
        assert!(!valid_role_id("01JQZ000000000000000000OUI"));
        assert!(!valid_role_id("steward"));
        assert!(valid_title("Night desk"));
        assert!(!valid_title(" Night desk"));
        assert!(!valid_title(""));
        assert!(!valid_title(&"x".repeat(41)));
        assert!(!valid_title("a\nb"));
    }

    #[test]
    fn a_retired_role_has_no_powers() {
        let mut def = preset_definition(ROLE_LEAD).expect("lead");
        def.retired = true;
        assert!(!def.has(Power::Members));
    }
}
