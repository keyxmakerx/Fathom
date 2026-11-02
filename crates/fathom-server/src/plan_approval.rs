//! Plans a folder asks to be approved before they start (migration 0072, sign-off
//! r102-plan-approval version 2).
//!
//! Three parts, each with its own table:
//!
//! - **A folder's rule** (`plan_rules`). A Steward of a folder signs whether plans there, and in
//!   the folders inside it, must be approved before they start. Authority rows: in the head's
//!   digest, judged at their chain position like a grant.
//! - **An approval** (`plan_approvals`). `before` says the plan as it reads now may start;
//!   `emergency` starts it now on a holder of the emergency start power's word, with a reason;
//!   `after` accepts an emergency start after the fact. Each is over [`plan_digest`], so any
//!   change to what the plan says leaves an earlier approval behind (the owner's pick, "any
//!   change"). Who may sign is checked when it is signed; the row is signed and sealed, and the
//!   gate re-verifies both before it lets a plan start.
//! - **Asking** (`plan_approval_asks`). Who asked and who sent a plan back, with a note.
//!   Workflow: the only thing decided from it is that the asker may not approve.
//!
//! The gate is [`refuse_unapproved_starts`]: a change that moves a plan from `planned` (or from
//! not existing) to `doing` or `recorded`, in a folder whose rule asks, is refused unless the
//! plan as the change leaves it carries a counting `before` or `emergency` approval.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use deadpool_postgres::Transaction;
use fathom_canon::Json;
use fathom_graph::{Graph, NodeId};
use fathom_ir::bag::FieldKey;
use fathom_ir::generated::ir_types::{EdgeKind, MaintenancePlanField, NodeKind, PlanStepField};

use crate::authority::{self, PlanApprovalFacts, PlanRuleFacts, RowFacts};
use crate::chain::EntryType;
use crate::chains;
use crate::crypto::{self, hex, now_unix, Key32};
use crate::grants::{
    self, as_32, entry_metadata, AuthorityError, AuthorityState, QuorumPass, PROPOSAL_SKEW_SECONDS,
};
use crate::ids;
use crate::keys::{self, KeyRing};
use crate::roles::Power;

// ---------------------------------------------------------------------------
// What a plan says
// ---------------------------------------------------------------------------

/// One plan as the gate and the approval screens need it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanFacts {
    /// The plan's ULID inside the design.
    pub plan: String,
    pub title: String,
    pub stage: String,
    /// The owning team's server id, or `""`.
    pub team: String,
    /// The account that made the plan, from its provenance, or `""`.
    pub made_by: String,
    /// The account the work is assigned to, or `""`.
    pub assigned_to: String,
    pub digest: [u8; 32],
}

fn text(value: Option<Json>) -> String {
    match value {
        Some(Json::Str(s)) => s,
        Some(Json::Int(n)) => n.to_string(),
        Some(Json::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn field(graph: &Graph, id: NodeId, key: FieldKey) -> String {
    text(graph.node_field(id, key))
}

/// The facts of one live plan node.
pub fn plan_facts(graph: &Graph, id: NodeId) -> Option<PlanFacts> {
    let node = graph.node(id)?;
    if id.kind != NodeKind::MaintenancePlan || node.absent_since.is_some() {
        return None;
    }
    let made_by = graph
        .provenance(node.existence)
        .map(|p| match p.asserted_by {
            fathom_graph::prov::Actor::User(user) => user.0.encode(),
        })
        .unwrap_or_default();
    let title = field(graph, id, MaintenancePlanField::Title.key());
    let team = field(graph, id, MaintenancePlanField::Team.key());
    let head = [
        title.clone(),
        field(graph, id, MaintenancePlanField::WindowStart.key()),
        field(graph, id, MaintenancePlanField::WindowEnd.key()),
        team.clone(),
    ];
    let mut steps = Vec::new();
    for edge in graph.out(id, EdgeKind::HasStep) {
        if edge.absent_since.is_some() {
            continue;
        }
        let step = edge.to;
        if graph.node(step).is_none_or(|n| n.absent_since.is_some()) {
            continue;
        }
        let f = |key: FieldKey| field(graph, step, key);
        steps.push((
            step.ulid.encode(),
            [
                f(PlanStepField::Ordinal.key()),
                f(PlanStepField::Kind.key()),
                f(PlanStepField::Targets.key()),
                f(PlanStepField::Change.key()),
                f(PlanStepField::Before.key()),
                f(PlanStepField::After.key()),
                f(PlanStepField::Edit.key()),
                f(PlanStepField::IfWhen.key()),
                f(PlanStepField::BranchOf.key()),
            ],
        ));
    }
    let plan = id.ulid.encode();
    let digest = authority::plan_digest(&plan, [&head[0], &head[1], &head[2], &head[3]], &steps);
    Some(PlanFacts {
        plan,
        title,
        stage: field(graph, id, MaintenancePlanField::Stage.key()),
        team,
        made_by,
        assigned_to: field(graph, id, MaintenancePlanField::AssignedTo.key()),
        digest,
    })
}

/// Every live plan in a design.
pub fn plans_of(graph: &Graph) -> Vec<PlanFacts> {
    graph
        .nodes_of_kind(NodeKind::MaintenancePlan)
        .filter_map(|n| plan_facts(graph, n.id))
        .collect()
}

fn under_way(stage: &str) -> bool {
    matches!(stage, "doing" | "recorded")
}

/// The plans a change starts: under way in `after` and not in `before` (planned, called off,
/// or not there at all).
pub fn plans_starting(before: &Graph, after: &Graph) -> Vec<PlanFacts> {
    plans_of(after)
        .into_iter()
        .filter(|p| under_way(&p.stage))
        .filter(|p| {
            let was = before
                .nodes_of_kind(NodeKind::MaintenancePlan)
                .find(|n| n.id.ulid.encode() == p.plan)
                .map(|n| field(before, n.id, MaintenancePlanField::Stage.key()));
            !was.as_deref().is_some_and(under_way)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// A. A folder's rule
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct PlanRule {
    pub id: String,
    pub organisation_id: String,
    pub scope_id: Option<String>,
    pub required: bool,
    pub signed_by: String,
    pub signer_key_fpr: [u8; 32],
    pub signature: Vec<u8>,
    pub at_unix: i64,
    pub auth_epoch: i32,
    pub chain_seq: i64,
    pub row_seal: Vec<u8>,
}

const RULE_COLUMNS: &str = "id, organisation_id, scope_id, required, signed_by, signer_key_fpr, \
     signature, at_unix, auth_epoch, chain_seq, row_seal";

/// Every plan rule of one organisation, in chain order.
pub(crate) async fn read_rules(
    tx: &Transaction<'_>,
    organisation: &str,
) -> Result<Vec<PlanRule>, AuthorityError> {
    let rows = tx
        .query(
            &format!(
                "SELECT {RULE_COLUMNS} FROM plan_rules \
                  WHERE organisation_id = $1 ORDER BY chain_seq, id"
            ),
            &[&organisation],
        )
        .await?;
    rows.iter()
        .map(|row| {
            let fpr: Vec<u8> = row.get(5);
            Ok(PlanRule {
                id: row.get(0),
                organisation_id: row.get(1),
                scope_id: row.get(2),
                required: row.get(3),
                signed_by: row.get(4),
                signer_key_fpr: as_32(&fpr, "plan rule signer key fingerprint")?,
                signature: row.get(6),
                at_unix: row.get(7),
                auth_epoch: row.get(8),
                chain_seq: row.get(9),
                row_seal: row.get(10),
            })
        })
        .collect()
}

fn opt(value: &Option<String>) -> Json {
    match value {
        Some(s) => Json::Str(s.clone()),
        None => Json::Null,
    }
}

fn rule_state(r: &PlanRule) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("at".to_string(), Json::Int(r.at_unix));
    map.insert("auth_epoch".to_string(), Json::Int(i64::from(r.auth_epoch)));
    map.insert(
        "organisation_id".to_string(),
        Json::Str(r.organisation_id.clone()),
    );
    map.insert("required".to_string(), Json::Bool(r.required));
    map.insert("scope_id".to_string(), opt(&r.scope_id));
    map.insert("signature".to_string(), Json::Str(hex(&r.signature)));
    map.insert("signed_by".to_string(), Json::Str(r.signed_by.clone()));
    map.insert(
        "signer_key_fpr".to_string(),
        Json::Str(hex(&r.signer_key_fpr)),
    );
    Json::Obj(map).to_canonical_bytes()
}

fn rule_seal(row_key: &Key32, r: &PlanRule) -> [u8; 32] {
    authority::row_seal(
        row_key,
        &RowFacts {
            table: "plan_rules",
            row_id: &r.id,
            chain_seq: r.chain_seq,
            row_version: 1,
            row_state: &rule_state(r),
        },
    )
}

/// The head's digest entries for plan rules: every row, recomputed.
pub(crate) fn digest_entries(rules: &[PlanRule], row_key: &Key32) -> Vec<(String, [u8; 32])> {
    rules
        .iter()
        .map(|r| (format!("plan_rules/{}", r.id), rule_seal(row_key, r)))
        .collect()
}

/// Every rule's stored seal recomputes.
pub(crate) fn verify_stored_seals(
    rules: &[PlanRule],
    row_key: &Key32,
) -> Result<(), AuthorityError> {
    for r in rules {
        if r.row_seal != rule_seal(row_key, r) {
            return Err(AuthorityError::Unverifiable("plan rule row seal"));
        }
    }
    Ok(())
}

fn rule_bytes(organisation: &str, root_fpr: &[u8; 32], r: &PlanRule) -> Vec<u8> {
    authority::plan_rule_bytes(&PlanRuleFacts {
        organisation,
        root_pubkey_fpr: root_fpr,
        rule_id: &r.id,
        scope: r.scope_id.as_deref().unwrap_or(""),
        required: r.required,
        signer: &r.signed_by,
        signer_key_fpr: &r.signer_key_fpr,
        at_unix: r.at_unix,
        auth_epoch: r.auth_epoch,
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

/// The signature under the named key, which must be the signer's.
async fn signed_by(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    fpr: &[u8; 32],
    at_unix: i64,
    account: &str,
    message: &[u8],
    signature: &[u8],
) -> Result<bool, AuthorityError> {
    let key = match grants::key_by_fingerprint(tx, ring, fpr, at_unix).await {
        Ok(key) => key,
        Err(e) if is_a_disqualification(&e) => return Ok(false),
        Err(e) => return Err(e),
    };
    Ok(key.account_id == account
        && authority::verify_es256(&key.public_key, message, signature).is_ok())
}

/// Does this rule count: seal, signature, and a Steward of its folder at its chain position?
async fn rule_counts(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    state: &AuthorityState,
    root_fpr: &[u8; 32],
    pass: &Mutex<QuorumPass>,
    r: &PlanRule,
) -> Result<bool, AuthorityError> {
    let row_key = grants::row_key_for(ring, &state.organisation);
    if r.row_seal != rule_seal(&row_key, r) || r.organisation_id != state.organisation {
        return Ok(false);
    }
    let message = rule_bytes(&state.organisation, root_fpr, r);
    if !signed_by(
        tx,
        ring,
        &r.signer_key_fpr,
        r.at_unix,
        &r.signed_by,
        &message,
        &r.signature,
    )
    .await?
    {
        return Ok(false);
    }
    let covering = grants::covering_scopes(tx, &state.organisation, r.scope_id.as_deref()).await?;
    grants::steward_held_at(
        tx,
        ring,
        state,
        root_fpr,
        &r.signed_by,
        &covering,
        r.at_unix,
        r.chain_seq,
        pass,
    )
    .await
}

/// The rule standing on one folder exactly (not inherited): the latest counting row.
async fn rule_on(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    state: &AuthorityState,
    root_fpr: &[u8; 32],
    pass: &Mutex<QuorumPass>,
    scope: &Option<String>,
) -> Result<Option<bool>, AuthorityError> {
    for r in state
        .plan_rules
        .iter()
        .rev()
        .filter(|r| &r.scope_id == scope)
    {
        if rule_counts(tx, ring, state, root_fpr, pass, r).await? {
            return Ok(Some(r.required));
        }
    }
    Ok(None)
}

/// Must a plan in `scope` be approved before it starts? Yes when the folder or any folder
/// around it (or the whole organisation) asks.
pub(crate) async fn required_in(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    state: &AuthorityState,
    root_fpr: &[u8; 32],
    pass: &Mutex<QuorumPass>,
    scope: Option<&str>,
) -> Result<bool, AuthorityError> {
    if state.plan_rules.is_empty() {
        return Ok(false);
    }
    let covering = grants::covering_scopes(tx, &state.organisation, scope).await?;
    for s in &covering {
        if rule_on(tx, ring, state, root_fpr, pass, s).await? == Some(true) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// What a Steward asks of a folder's rule.
#[derive(Clone, Debug)]
pub struct RuleProposal {
    pub rule_id: String,
    pub scope: Option<String>,
    pub required: bool,
    pub signer: String,
    pub signer_key_fpr: [u8; 32],
    pub at_unix: i64,
    pub auth_epoch: i32,
    pub root_fpr: [u8; 32],
    pub bytes: Vec<u8>,
}

impl RuleProposal {
    fn as_rule(&self, organisation: &str) -> PlanRule {
        PlanRule {
            id: self.rule_id.clone(),
            organisation_id: organisation.to_string(),
            scope_id: self.scope.clone(),
            required: self.required,
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

async fn own_key(tx: &Transaction<'_>, actor: &str, fpr: &[u8; 32]) -> Result<(), AuthorityError> {
    if grants::live_signing_keys(tx, actor)
        .await?
        .iter()
        .any(|k| k.fpr == *fpr)
    {
        Ok(())
    } else {
        Err(AuthorityError::NoSigningKey)
    }
}

#[allow(clippy::too_many_arguments)]
async fn check_rule_now(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    state: &AuthorityState,
    root_fpr: &[u8; 32],
    pass: &Mutex<QuorumPass>,
    actor: &str,
    now: i64,
    p: &RuleProposal,
) -> Result<(), AuthorityError> {
    if p.signer != actor {
        return Err(refuse());
    }
    if let Some(scope) = &p.scope {
        let found = tx
            .query_opt(
                "SELECT 1 FROM scopes WHERE id = $1 AND organisation_id = $2",
                &[scope, &state.organisation],
            )
            .await?;
        if found.is_none() {
            return Err(refuse());
        }
    }
    let covering = grants::covering_scopes(tx, &state.organisation, p.scope.as_deref()).await?;
    if !grants::steward_held_at(
        tx,
        ring,
        state,
        root_fpr,
        actor,
        &covering,
        now,
        i64::MAX,
        pass,
    )
    .await?
    {
        return Err(refuse());
    }
    // Saying again what already stands is refused, so the log only holds changes.
    if rule_on(tx, ring, state, root_fpr, pass, &p.scope)
        .await?
        .unwrap_or(false)
        == p.required
    {
        return Err(refuse());
    }
    Ok(())
}

/// Fix the bytes for a folder's rule a Steward wants to sign.
pub async fn propose_rule(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    scope: Option<String>,
    required: bool,
    signer_key_fpr: &[u8; 32],
) -> Result<RuleProposal, AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    own_key(tx, &actor, signer_key_fpr).await?;
    let mut proposal = RuleProposal {
        rule_id: ids::new_ulid().to_string(),
        scope,
        required,
        signer: actor.clone(),
        signer_key_fpr: *signer_key_fpr,
        at_unix: now_unix(),
        auth_epoch: verified.auth_epoch,
        root_fpr: verified.root_fpr,
        bytes: Vec::new(),
    };
    let pass = Mutex::new(QuorumPass::default());
    check_rule_now(
        tx,
        auth.ring,
        &verified.state,
        &verified.root_fpr,
        &pass,
        &actor,
        proposal.at_unix,
        &proposal,
    )
    .await?;
    proposal.bytes = rule_bytes(
        &verified.organisation,
        &verified.root_fpr,
        &proposal.as_rule(&verified.organisation),
    );
    Ok(proposal)
}

/// Store a signed rule: every check again, the signature, the chain entry, the sealed row, and
/// the head advanced, in the caller's transaction.
pub async fn commit_rule(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    proposal: &RuleProposal,
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
    check_rule_now(
        tx,
        auth.ring,
        &verified.state,
        &verified.root_fpr,
        &pass,
        &actor,
        now,
        proposal,
    )
    .await?;
    let message = rule_bytes(
        &organisation,
        &verified.root_fpr,
        &proposal.as_rule(&organisation),
    );
    let key = grants::key_by_fingerprint(tx, auth.ring, &proposal.signer_key_fpr, proposal.at_unix)
        .await?;
    if key.account_id != actor {
        return Err(AuthorityError::NoSigningKey);
    }
    authority::verify_es256(&key.public_key, &message, signature)?;
    let entry_type = EntryType::PlanRuleSet;
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        entry_type,
        &entry_metadata(
            entry_type,
            &[
                ("rule", Json::Str(proposal.rule_id.clone())),
                ("scope", opt(&proposal.scope)),
                ("required", Json::Bool(proposal.required)),
                ("actor", Json::Str(actor.clone())),
                ("at", Json::Int(proposal.at_unix)),
            ],
        ),
    )
    .await?;
    let mut row = proposal.as_rule(&organisation);
    row.signature = signature.to_vec();
    row.chain_seq = appended.seq;
    let seal = rule_seal(&grants::row_key_for(auth.ring, &organisation), &row);
    tx.execute(
        "INSERT INTO plan_rules \
             (id, organisation_id, scope_id, required, signed_by, signer_key_fpr, signature, \
              at_unix, auth_epoch, chain_seq, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        &[
            &row.id,
            &organisation,
            &row.scope_id,
            &row.required,
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
    Ok(row.id)
}

/// Every folder's own rule as it stands now: `(folder, required)`, `None` for the whole
/// organisation. Folders with no counting rule are left out.
pub async fn rules_now(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
) -> Result<Vec<(Option<String>, bool)>, AuthorityError> {
    let verified = grants::verify_authority_state(tx, auth).await?;
    let pass = Mutex::new(QuorumPass::default());
    let scopes: BTreeSet<Option<String>> = verified
        .state
        .plan_rules
        .iter()
        .map(|r| r.scope_id.clone())
        .collect();
    let mut out = Vec::new();
    for scope in scopes {
        if let Some(required) = rule_on(
            tx,
            auth.ring,
            &verified.state,
            &verified.root_fpr,
            &pass,
            &scope,
        )
        .await?
        {
            out.push((scope, required));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// B. Approvals
// ---------------------------------------------------------------------------

pub const KIND_BEFORE: &str = "before";
pub const KIND_EMERGENCY: &str = "emergency";
pub const KIND_AFTER: &str = "after";

#[derive(Clone, Debug)]
pub struct Approval {
    pub id: String,
    pub organisation_id: String,
    pub design_id: String,
    pub plan_id: String,
    pub plan_digest: [u8; 32],
    pub kind: String,
    pub team_id: Option<String>,
    /// The reason in the clear, opened from `reason_ct` (or about to be sealed into it).
    pub reason: String,
    pub reason_ct: Vec<u8>,
    pub reason_nonce: [u8; crypto::NONCE_LEN],
    pub key_epoch: i32,
    pub signed_by: String,
    pub signer_key_fpr: [u8; 32],
    pub signature: Vec<u8>,
    pub at_unix: i64,
    pub auth_epoch: i32,
    pub chain_seq: i64,
    pub row_seal: Vec<u8>,
}

const APPROVAL_COLUMNS: &str = "id, organisation_id, design_id, plan_id, plan_digest, kind, \
     team_id, reason_ct, reason_nonce, key_epoch, signed_by, signer_key_fpr, signature, at_unix, \
     auth_epoch, chain_seq, row_seal";

/// The AEAD tag of a reason's or a note's encryption; the row's table and id and the key's
/// epoch go in beside it, so a ciphertext never opens on another row.
const AAD_PLAN_TEXT: &[u8] = b"fathom/plan/approval/text/v1";

fn text_aad(organisation: &str, table: &str, id: &str, epoch: i32) -> Vec<u8> {
    let mut a = Vec::new();
    crypto::lp(&mut a, AAD_PLAN_TEXT);
    crypto::lp(&mut a, organisation.as_bytes());
    crypto::lp(&mut a, table.as_bytes());
    crypto::lp(&mut a, id.as_bytes());
    crypto::u32_le(&mut a, epoch as u32);
    a
}

/// Seal a reason or a note under the organisation content key.
async fn seal_text(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    table: &str,
    id: &str,
    plain: &str,
) -> Result<(Vec<u8>, [u8; crypto::NONCE_LEN], i32), AuthorityError> {
    let organisation = auth.ctx.tenant().to_string();
    let key = keys::org_content_key(tx, auth.ctx, auth.tenant_key).await?;
    let nonce = crypto::random_nonce().map_err(|_| AuthorityError::Corrupt("randomness"))?;
    let ct = crypto::seal(
        &key.key,
        &nonce,
        plain.as_bytes(),
        &text_aad(&organisation, table, id, key.epoch),
    )
    .map_err(|_| AuthorityError::Corrupt("plan approval text"))?;
    keys::count_write_under_org_content_key(tx, &organisation, key.epoch).await?;
    Ok((ct, nonce, key.epoch))
}

/// Opens reasons and notes, one key per epoch.
struct Opener<'a> {
    auth: &'a grants::Authority<'a>,
    keys: BTreeMap<i32, Key32>,
}

impl<'a> Opener<'a> {
    fn new(auth: &'a grants::Authority<'a>) -> Self {
        Opener {
            auth,
            keys: BTreeMap::new(),
        }
    }

    async fn open(
        &mut self,
        tx: &Transaction<'_>,
        table: &str,
        id: &str,
        ct: &[u8],
        nonce: &[u8; crypto::NONCE_LEN],
        epoch: i32,
    ) -> Result<String, AuthorityError> {
        if !self.keys.contains_key(&epoch) {
            let key =
                keys::org_content_key_at_epoch(tx, self.auth.ctx, self.auth.tenant_key, epoch)
                    .await?;
            self.keys.insert(epoch, key);
        }
        let organisation = self.auth.ctx.tenant().to_string();
        let plain = crypto::open(
            &self.keys[&epoch],
            nonce,
            ct,
            &text_aad(&organisation, table, id, epoch),
        )
        .map_err(|_| AuthorityError::Unverifiable("plan approval text"))?;
        String::from_utf8(plain).map_err(|_| AuthorityError::Unverifiable("plan approval text"))
    }
}

fn nonce_of(bytes: &[u8]) -> Result<[u8; crypto::NONCE_LEN], AuthorityError> {
    bytes
        .try_into()
        .map_err(|_| AuthorityError::Corrupt("plan approval nonce"))
}

/// One design's approvals, in chain order.
pub(crate) async fn read_approvals(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    organisation: &str,
    design: &str,
) -> Result<Vec<Approval>, AuthorityError> {
    let rows = tx
        .query(
            &format!(
                "SELECT {APPROVAL_COLUMNS} FROM plan_approvals \
                  WHERE organisation_id = $1 AND design_id = $2 ORDER BY chain_seq, id"
            ),
            &[&organisation, &design],
        )
        .await?;
    let mut opener = Opener::new(auth);
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let digest: Vec<u8> = row.get(4);
        let nonce: Vec<u8> = row.get(8);
        let fpr: Vec<u8> = row.get(11);
        let id: String = row.get(0);
        let reason_ct: Vec<u8> = row.get(7);
        let reason_nonce = nonce_of(&nonce)?;
        let key_epoch: i32 = row.get(9);
        let reason = opener
            .open(
                tx,
                "plan_approvals",
                &id,
                &reason_ct,
                &reason_nonce,
                key_epoch,
            )
            .await?;
        out.push(Approval {
            id,
            organisation_id: row.get(1),
            design_id: row.get(2),
            plan_id: row.get(3),
            plan_digest: as_32(&digest, "plan digest")?,
            kind: row.get(5),
            team_id: row.get(6),
            reason,
            reason_ct,
            reason_nonce,
            key_epoch,
            signed_by: row.get(10),
            signer_key_fpr: as_32(&fpr, "plan approval signer key fingerprint")?,
            signature: row.get(12),
            at_unix: row.get(13),
            auth_epoch: row.get(14),
            chain_seq: row.get(15),
            row_seal: row.get(16),
        });
    }
    Ok(out)
}

fn approval_state(a: &Approval) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert("at".to_string(), Json::Int(a.at_unix));
    map.insert("auth_epoch".to_string(), Json::Int(i64::from(a.auth_epoch)));
    map.insert("design_id".to_string(), Json::Str(a.design_id.clone()));
    map.insert("kind".to_string(), Json::Str(a.kind.clone()));
    map.insert(
        "organisation_id".to_string(),
        Json::Str(a.organisation_id.clone()),
    );
    map.insert("plan_digest".to_string(), Json::Str(hex(&a.plan_digest)));
    map.insert("plan_id".to_string(), Json::Str(a.plan_id.clone()));
    map.insert("key_epoch".to_string(), Json::Int(i64::from(a.key_epoch)));
    map.insert("reason_ct".to_string(), Json::Str(hex(&a.reason_ct)));
    map.insert("reason_nonce".to_string(), Json::Str(hex(&a.reason_nonce)));
    map.insert("signature".to_string(), Json::Str(hex(&a.signature)));
    map.insert("signed_by".to_string(), Json::Str(a.signed_by.clone()));
    map.insert(
        "signer_key_fpr".to_string(),
        Json::Str(hex(&a.signer_key_fpr)),
    );
    map.insert("team_id".to_string(), opt(&a.team_id));
    Json::Obj(map).to_canonical_bytes()
}

fn approval_seal(row_key: &Key32, a: &Approval) -> [u8; 32] {
    authority::row_seal(
        row_key,
        &RowFacts {
            table: "plan_approvals",
            row_id: &a.id,
            chain_seq: a.chain_seq,
            row_version: 1,
            row_state: &approval_state(a),
        },
    )
}

fn approval_bytes(organisation: &str, root_fpr: &[u8; 32], a: &Approval) -> Vec<u8> {
    authority::plan_approval_bytes(&PlanApprovalFacts {
        organisation,
        root_pubkey_fpr: root_fpr,
        approval_id: &a.id,
        design: &a.design_id,
        plan: &a.plan_id,
        plan_digest: &a.plan_digest,
        kind: &a.kind,
        team: a.team_id.as_deref().unwrap_or(""),
        reason: &a.reason,
        signer: &a.signed_by,
        signer_key_fpr: &a.signer_key_fpr,
        at_unix: a.at_unix,
        auth_epoch: a.auth_epoch,
    })
}

/// Is this approval's row what the server wrote, and its signature the signer's? Who may sign
/// was checked when it was signed (the T3 rule: judged at its own position).
async fn approval_holds(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    organisation: &str,
    root_fpr: &[u8; 32],
    a: &Approval,
) -> Result<bool, AuthorityError> {
    let row_key = grants::row_key_for(ring, organisation);
    if a.row_seal != approval_seal(&row_key, a) || a.organisation_id != organisation {
        return Ok(false);
    }
    let message = approval_bytes(organisation, root_fpr, a);
    signed_by(
        tx,
        ring,
        &a.signer_key_fpr,
        a.at_unix,
        &a.signed_by,
        &message,
        &a.signature,
    )
    .await
}

/// One ask or send-back.
#[derive(Clone, Debug)]
pub struct Ask {
    pub plan_id: String,
    pub plan_digest: [u8; 32],
    pub kind: String,
    pub account: String,
    pub note: String,
    pub at_unix: i64,
}

pub(crate) async fn read_asks(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    organisation: &str,
    design: &str,
) -> Result<Vec<Ask>, AuthorityError> {
    let rows = tx
        .query(
            "SELECT id, plan_id, plan_digest, kind, account_id, note_ct, note_nonce, key_epoch, \
                    at_unix \
               FROM plan_approval_asks \
              WHERE organisation_id = $1 AND design_id = $2 ORDER BY at_unix, id",
            &[&organisation, &design],
        )
        .await?;
    let mut opener = Opener::new(auth);
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let id: String = row.get(0);
        let digest: Vec<u8> = row.get(2);
        let ct: Vec<u8> = row.get(5);
        let nonce: Vec<u8> = row.get(6);
        let note = opener
            .open(
                tx,
                "plan_approval_asks",
                &id,
                &ct,
                &nonce_of(&nonce)?,
                row.get(7),
            )
            .await?;
        out.push(Ask {
            plan_id: row.get(1),
            plan_digest: as_32(&digest, "plan digest")?,
            kind: row.get(3),
            account: row.get(4),
            note,
            at_unix: row.get(8),
        });
    }
    Ok(out)
}

/// Who may approve `plan`, as `account`, now: `Some(None)` as a Steward of the folder,
/// `Some(Some(team))` through a team's role with `power`, `None` when not at all. The plan's
/// own team when it names one; otherwise any team with access to the folder.
#[allow(clippy::too_many_arguments)]
async fn standing(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    state: &AuthorityState,
    root_fpr: &[u8; 32],
    pass: &Mutex<QuorumPass>,
    account: &str,
    scope: Option<&str>,
    plan: &PlanFacts,
    power: Power,
    steward_counts: bool,
) -> Result<Option<Option<String>>, AuthorityError> {
    let covering = grants::covering_scopes(tx, &state.organisation, scope).await?;
    if steward_counts
        && grants::steward_held_at(
            tx,
            ring,
            state,
            root_fpr,
            account,
            &covering,
            now_unix(),
            i64::MAX,
            pass,
        )
        .await?
    {
        return Ok(Some(None));
    }
    let only = (!plan.team.is_empty()).then_some(plan.team.as_str());
    Ok(crate::teams::power_through_teams(
        tx, ring, state, root_fpr, account, &covering, power, only, pass,
    )
    .await?
    .map(Some))
}

/// The people who may not approve a plan: whoever made it, whoever it is assigned to, and
/// whoever last asked for this version of it to be approved.
fn too_close(plan: &PlanFacts, asks: &[Ask], account: &str) -> bool {
    plan.made_by == account
        || plan.assigned_to == account
        || asks.iter().any(|a| {
            a.plan_id == plan.plan
                && a.kind == "ask"
                && a.plan_digest == plan.digest
                && a.account == account
        })
}

/// What one approval request is about, filled in by the server.
#[derive(Clone, Debug)]
pub struct ApprovalProposal {
    pub approval_id: String,
    pub design: String,
    pub plan: String,
    pub plan_digest: [u8; 32],
    pub kind: String,
    pub team: Option<String>,
    pub reason: String,
    pub signer: String,
    pub signer_key_fpr: [u8; 32],
    pub at_unix: i64,
    pub auth_epoch: i32,
    pub root_fpr: [u8; 32],
    pub bytes: Vec<u8>,
}

impl ApprovalProposal {
    fn as_approval(&self, organisation: &str) -> Approval {
        Approval {
            id: self.approval_id.clone(),
            organisation_id: organisation.to_string(),
            design_id: self.design.clone(),
            plan_id: self.plan.clone(),
            plan_digest: self.plan_digest,
            kind: self.kind.clone(),
            team_id: self.team.clone(),
            reason: self.reason.clone(),
            reason_ct: Vec::new(),
            reason_nonce: [0; crypto::NONCE_LEN],
            key_epoch: 0,
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

/// An emergency start's reason: one to 500 characters, one line.
pub fn valid_reason(reason: &str) -> bool {
    let n = reason.chars().count();
    (1..=500).contains(&n) && reason.trim() == reason && !reason.chars().any(char::is_control)
}

/// Everything an approval must satisfy now, at propose and again at commit. Returns the team
/// the signer acts through.
#[allow(clippy::too_many_arguments)]
async fn check_approval_now(
    tx: &Transaction<'_>,
    ring: &KeyRing,
    state: &AuthorityState,
    root_fpr: &[u8; 32],
    pass: &Mutex<QuorumPass>,
    actor: &str,
    scope: Option<&str>,
    plan: &PlanFacts,
    approvals: &[Approval],
    asks: &[Ask],
    kind: &str,
    reason: &str,
) -> Result<Option<String>, AuthorityError> {
    let mine_here = |k: &str| {
        approvals
            .iter()
            .filter(|a| a.plan_id == plan.plan && a.kind == k)
            .collect::<Vec<_>>()
    };
    match kind {
        KIND_BEFORE => {
            if plan.stage != "planned" || !reason.is_empty() || too_close(plan, asks, actor) {
                return Err(refuse());
            }
            // One approval of one version is enough; a second says nothing new.
            if mine_here(KIND_BEFORE)
                .iter()
                .any(|a| a.plan_digest == plan.digest)
            {
                return Err(refuse());
            }
            standing(
                tx,
                ring,
                state,
                root_fpr,
                pass,
                actor,
                scope,
                plan,
                Power::ApprovePlans,
                true,
            )
            .await?
            .ok_or_else(refuse)
        }
        KIND_EMERGENCY => {
            if plan.stage != "planned" || !valid_reason(reason) {
                return Err(refuse());
            }
            standing(
                tx,
                ring,
                state,
                root_fpr,
                pass,
                actor,
                scope,
                plan,
                Power::EmergencyStart,
                false,
            )
            .await?
            .ok_or_else(refuse)
        }
        KIND_AFTER => {
            let starts = mine_here(KIND_EMERGENCY);
            let Some(start) = starts.last() else {
                return Err(refuse());
            };
            if !reason.is_empty()
                || start.signed_by == actor
                || too_close(plan, asks, actor)
                || mine_here(KIND_AFTER)
                    .iter()
                    .any(|a| a.chain_seq > start.chain_seq)
            {
                return Err(refuse());
            }
            standing(
                tx,
                ring,
                state,
                root_fpr,
                pass,
                actor,
                scope,
                plan,
                Power::ApprovePlans,
                true,
            )
            .await?
            .ok_or_else(refuse)
        }
        _ => Err(refuse()),
    }
}

/// Fix the bytes for an approval `actor` wants to sign, over `plan` as the server's head
/// holds it now.
#[allow(clippy::too_many_arguments)]
pub async fn propose_approval(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    design: &str,
    scope: Option<&str>,
    plan: &PlanFacts,
    kind: &str,
    reason: &str,
    signer_key_fpr: &[u8; 32],
) -> Result<ApprovalProposal, AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    own_key(tx, &actor, signer_key_fpr).await?;
    let approvals = read_approvals(tx, auth, &verified.organisation, design).await?;
    let asks = read_asks(tx, auth, &verified.organisation, design).await?;
    let pass = Mutex::new(QuorumPass::default());
    let team = check_approval_now(
        tx,
        auth.ring,
        &verified.state,
        &verified.root_fpr,
        &pass,
        &actor,
        scope,
        plan,
        &approvals,
        &asks,
        kind,
        reason,
    )
    .await?;
    let mut proposal = ApprovalProposal {
        approval_id: ids::new_ulid().to_string(),
        design: design.to_string(),
        plan: plan.plan.clone(),
        plan_digest: plan.digest,
        kind: kind.to_string(),
        team,
        reason: reason.to_string(),
        signer: actor,
        signer_key_fpr: *signer_key_fpr,
        at_unix: now_unix(),
        auth_epoch: verified.auth_epoch,
        root_fpr: verified.root_fpr,
        bytes: Vec::new(),
    };
    proposal.bytes = approval_bytes(
        &verified.organisation,
        &verified.root_fpr,
        &proposal.as_approval(&verified.organisation),
    );
    Ok(proposal)
}

/// Store a signed approval: every check again against the plan as the head holds it now (so a
/// plan changed since the proposal is refused), the signature, the chain entry and the sealed
/// row, in the caller's transaction.
pub async fn commit_approval(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    scope: Option<&str>,
    plan: &PlanFacts,
    proposal: &ApprovalProposal,
    signature: &[u8],
) -> Result<String, AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    let organisation = verified.organisation.clone();
    if proposal.auth_epoch != verified.auth_epoch {
        return Err(AuthorityError::Stale("the authority head moved"));
    }
    if proposal.root_fpr != verified.root_fpr || proposal.signer != actor {
        return Err(refuse());
    }
    if proposal.plan != plan.plan || proposal.plan_digest != plan.digest {
        return Err(AuthorityError::Stale("the plan changed"));
    }
    let now = now_unix();
    if (now - proposal.at_unix).abs() > PROPOSAL_SKEW_SECONDS {
        return Err(AuthorityError::Stale("the proposal is too old"));
    }
    let approvals = read_approvals(tx, auth, &organisation, &proposal.design).await?;
    let asks = read_asks(tx, auth, &organisation, &proposal.design).await?;
    let pass = Mutex::new(QuorumPass::default());
    let team = check_approval_now(
        tx,
        auth.ring,
        &verified.state,
        &verified.root_fpr,
        &pass,
        &actor,
        scope,
        plan,
        &approvals,
        &asks,
        &proposal.kind,
        &proposal.reason,
    )
    .await?;
    if team != proposal.team {
        return Err(AuthorityError::Stale("the signer's standing changed"));
    }
    let message = approval_bytes(
        &organisation,
        &verified.root_fpr,
        &proposal.as_approval(&organisation),
    );
    let key = grants::key_by_fingerprint(tx, auth.ring, &proposal.signer_key_fpr, proposal.at_unix)
        .await?;
    if key.account_id != actor {
        return Err(AuthorityError::NoSigningKey);
    }
    authority::verify_es256(&key.public_key, &message, signature)?;
    let entry_type = EntryType::PlanApprovalSigned;
    let appended = chains::append_org(
        tx,
        auth.ring,
        auth.ctx,
        auth.tenant_key,
        entry_type,
        &entry_metadata(
            entry_type,
            &[
                ("approval", Json::Str(proposal.approval_id.clone())),
                ("design", Json::Str(proposal.design.clone())),
                ("plan", Json::Str(proposal.plan.clone())),
                ("kind", Json::Str(proposal.kind.clone())),
                ("actor", Json::Str(actor.clone())),
                ("at", Json::Int(proposal.at_unix)),
            ],
        ),
    )
    .await?;
    let mut row = proposal.as_approval(&organisation);
    row.signature = signature.to_vec();
    row.chain_seq = appended.seq;
    let (reason_ct, reason_nonce, key_epoch) =
        seal_text(tx, auth, "plan_approvals", &row.id, &row.reason).await?;
    row.reason_ct = reason_ct;
    row.reason_nonce = reason_nonce;
    row.key_epoch = key_epoch;
    let seal = approval_seal(&grants::row_key_for(auth.ring, &organisation), &row);
    tx.execute(
        "INSERT INTO plan_approvals \
             (id, organisation_id, design_id, plan_id, plan_digest, kind, team_id, reason_ct, \
              reason_nonce, key_epoch, signed_by, signer_key_fpr, signature, at_unix, \
              auth_epoch, chain_seq, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
        &[
            &row.id,
            &organisation,
            &row.design_id,
            &row.plan_id,
            &row.plan_digest.to_vec(),
            &row.kind,
            &row.team_id,
            &row.reason_ct,
            &row.reason_nonce.to_vec(),
            &row.key_epoch,
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
    Ok(row.id)
}

/// Ask for a plan to be approved, or send it back with a note. Anyone who may draw in the
/// design may ask; only someone who may approve it may send it back.
#[allow(clippy::too_many_arguments)]
pub async fn ask(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    design: &str,
    scope: Option<&str>,
    plan: &PlanFacts,
    kind: &str,
    note: &str,
) -> Result<(), AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    if plan.stage != "planned"
        || note.chars().count() > 1000
        || note.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err(refuse());
    }
    let verified = grants::verify_authority_state(tx, auth).await?;
    match kind {
        "ask" => {}
        "send_back" => {
            if note.trim().is_empty() {
                return Err(refuse());
            }
            let asks = read_asks(tx, auth, &verified.organisation, design).await?;
            let pass = Mutex::new(QuorumPass::default());
            if too_close(plan, &asks, &actor)
                || standing(
                    tx,
                    auth.ring,
                    &verified.state,
                    &verified.root_fpr,
                    &pass,
                    &actor,
                    scope,
                    plan,
                    Power::ApprovePlans,
                    true,
                )
                .await?
                .is_none()
            {
                return Err(refuse());
            }
        }
        _ => return Err(refuse()),
    }
    let id = ids::new_ulid().to_string();
    let (note_ct, note_nonce, key_epoch) =
        seal_text(tx, auth, "plan_approval_asks", &id, note).await?;
    tx.execute(
        "INSERT INTO plan_approval_asks \
             (id, organisation_id, design_id, plan_id, plan_digest, kind, account_id, note_ct, \
              note_nonce, key_epoch, at_unix) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        &[
            &id,
            &verified.organisation,
            &design,
            &plan.plan,
            &plan.digest.to_vec(),
            &kind,
            &actor,
            &note_ct,
            &note_nonce.to_vec(),
            &key_epoch,
            &now_unix(),
        ],
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// Why a start was refused, one sentence for the person.
pub const NEEDS_APPROVAL: &str =
    "This plan needs approval before it starts, and this version of it has none.";

/// Refuse a change that starts a plan this folder asks to be approved, unless the plan as the
/// change leaves it carries a counting `before` or `emergency` approval. `Ok(None)` lets the
/// change through; `Ok(Some(reason))` refuses it.
pub async fn refuse_unapproved_starts(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    design: &str,
    scope: Option<&str>,
    starting: &[PlanFacts],
) -> Result<Option<&'static str>, AuthorityError> {
    if starting.is_empty() {
        return Ok(None);
    }
    let verified = grants::verify_authority_state(tx, auth).await?;
    let pass = Mutex::new(QuorumPass::default());
    if !required_in(
        tx,
        auth.ring,
        &verified.state,
        &verified.root_fpr,
        &pass,
        scope,
    )
    .await?
    {
        return Ok(None);
    }
    let approvals = read_approvals(tx, auth, &verified.organisation, design).await?;
    'plans: for plan in starting {
        for a in approvals.iter().filter(|a| {
            a.plan_id == plan.plan
                && a.plan_digest == plan.digest
                && (a.kind == KIND_BEFORE || a.kind == KIND_EMERGENCY)
        }) {
            if approval_holds(tx, auth.ring, &verified.organisation, &verified.root_fpr, a).await? {
                continue 'plans;
            }
        }
        return Ok(Some(NEEDS_APPROVAL));
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// What the screens show
// ---------------------------------------------------------------------------

/// One approval as a screen shows it.
#[derive(Clone, Debug)]
pub struct ApprovalLine {
    pub kind: String,
    pub by: String,
    pub team: Option<String>,
    pub reason: String,
    pub at_unix: i64,
    /// Over the plan as it reads now.
    pub current: bool,
}

/// One plan's approval state, for the person asking.
#[derive(Clone, Debug)]
pub struct PlanStatus {
    pub plan: String,
    pub title: String,
    pub stage: String,
    pub digest: [u8; 32],
    /// Approved as it reads now (a `before` or `emergency` over this version).
    pub approved: bool,
    /// Started in an emergency and not yet approved after.
    pub flagged: bool,
    pub approvals: Vec<ApprovalLine>,
    pub asks: Vec<Ask>,
    pub may_approve: bool,
    pub may_emergency: bool,
    pub may_approve_after: bool,
    pub may_send_back: bool,
}

/// A design's plans and whether its folder asks for approval, as `auth`'s account sees them.
pub async fn status(
    tx: &Transaction<'_>,
    auth: &grants::Authority<'_>,
    design: &str,
    scope: Option<&str>,
    plans: &[PlanFacts],
) -> Result<(bool, Vec<PlanStatus>), AuthorityError> {
    let actor = auth.ctx.actor().to_string();
    let verified = grants::verify_authority_state(tx, auth).await?;
    let pass = Mutex::new(QuorumPass::default());
    let required = required_in(
        tx,
        auth.ring,
        &verified.state,
        &verified.root_fpr,
        &pass,
        scope,
    )
    .await?;
    let approvals = read_approvals(tx, auth, &verified.organisation, design).await?;
    let asks = read_asks(tx, auth, &verified.organisation, design).await?;
    let mut held = Vec::new();
    for a in &approvals {
        if approval_holds(tx, auth.ring, &verified.organisation, &verified.root_fpr, a).await? {
            held.push(a);
        }
    }
    let mut out = Vec::new();
    for plan in plans {
        let mine: Vec<&&Approval> = held.iter().filter(|a| a.plan_id == plan.plan).collect();
        let approved = mine.iter().any(|a| {
            a.plan_digest == plan.digest && (a.kind == KIND_BEFORE || a.kind == KIND_EMERGENCY)
        });
        let last_emergency = mine.iter().rev().find(|a| a.kind == KIND_EMERGENCY);
        let flagged = last_emergency.is_some_and(|e| {
            !mine
                .iter()
                .any(|a| a.kind == KIND_AFTER && a.chain_seq > e.chain_seq)
        });
        let check = |kind: &'static str, reason: &'static str| {
            check_approval_now(
                tx,
                auth.ring,
                &verified.state,
                &verified.root_fpr,
                &pass,
                &actor,
                scope,
                plan,
                &approvals,
                &asks,
                kind,
                reason,
            )
        };
        let may = |r: Result<Option<String>, AuthorityError>| match r {
            Ok(_) => Ok(true),
            Err(AuthorityError::NotAuthorised) => Ok(false),
            Err(e) => Err(e),
        };
        let may_approve = may(check(KIND_BEFORE, "").await)?;
        let may_emergency = may(check(KIND_EMERGENCY, "a reason").await)?;
        let may_approve_after = may(check(KIND_AFTER, "").await)?;
        let may_send_back = plan.stage == "planned"
            && !too_close(plan, &asks, &actor)
            && standing(
                tx,
                auth.ring,
                &verified.state,
                &verified.root_fpr,
                &pass,
                &actor,
                scope,
                plan,
                Power::ApprovePlans,
                true,
            )
            .await?
            .is_some();
        out.push(PlanStatus {
            plan: plan.plan.clone(),
            title: plan.title.clone(),
            stage: plan.stage.clone(),
            digest: plan.digest,
            approved,
            flagged,
            approvals: mine
                .iter()
                .map(|a| ApprovalLine {
                    kind: a.kind.clone(),
                    by: a.signed_by.clone(),
                    team: a.team_id.clone(),
                    reason: a.reason.clone(),
                    at_unix: a.at_unix,
                    current: a.plan_digest == plan.digest,
                })
                .collect(),
            asks: asks
                .iter()
                .filter(|a| a.plan_id == plan.plan)
                .cloned()
                .collect(),
            may_approve,
            may_emergency,
            may_approve_after,
            may_send_back,
        });
    }
    Ok((required, out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fathom_ir::generated::ir_types::{MaintenancePlanStage, PlanStepKind, PlanStepState};

    #[test]
    fn a_reason_is_one_trimmed_line() {
        assert!(valid_reason("Core switch down, site offline"));
        assert!(!valid_reason(""));
        assert!(!valid_reason(" padded"));
        assert!(!valid_reason("two\nlines"));
        assert!(!valid_reason(&"x".repeat(501)));
    }

    fn prov(seed: u128) -> fathom_graph::ProvenanceRecord {
        use fathom_graph::{
            Actor, Confidence, Origin, ProvenanceId, ProvenanceRecord, Timestamp, UserId,
        };
        ProvenanceRecord {
            id: ProvenanceId(fathom_id::Ulid(seed * 10 + 2)),
            origin: Origin::Hand,
            asserted_at: Timestamp(0),
            asserted_by: Actor::User(UserId(fathom_id::Ulid(77))),
            confidence: Confidence::Asserted,
            supersedes: None,
        }
    }

    /// A plan with one step, at `stage`, titled `title`.
    fn a_plan(stage: MaintenancePlanStage, title: &str, step_change: &str) -> Graph {
        use fathom_graph::BatchId;
        use fathom_id::Ulid;
        use fathom_ir::scalar::Text;
        let mut g = Graph::new();
        g.begin_batch(BatchId(Ulid(1)), "plan fixture").unwrap();
        let p = prov(1);
        let plan = g
            .insert_node(NodeKind::MaintenancePlan, Ulid(10), p.clone())
            .unwrap();
        g.set_field(
            plan.into(),
            MaintenancePlanField::Title.key(),
            Text(title.into()),
            p.clone(),
        )
        .unwrap();
        g.set_field(
            plan.into(),
            MaintenancePlanField::Stage.key(),
            stage,
            p.clone(),
        )
        .unwrap();
        let step = g
            .insert_node(NodeKind::PlanStep, Ulid(11), p.clone())
            .unwrap();
        g.set_field(step.into(), PlanStepField::Ordinal.key(), 1u32, p.clone())
            .unwrap();
        g.set_field(
            step.into(),
            PlanStepField::Kind.key(),
            PlanStepKind::Other,
            p.clone(),
        )
        .unwrap();
        g.set_field(
            step.into(),
            PlanStepField::Change.key(),
            Text(step_change.into()),
            p.clone(),
        )
        .unwrap();
        g.set_field(
            step.into(),
            PlanStepField::State.key(),
            PlanStepState::Planned,
            p.clone(),
        )
        .unwrap();
        g.insert_edge(EdgeKind::HasStep, Ulid(12), plan, step, p.clone())
            .unwrap();
        g.end_batch().unwrap();
        g
    }

    #[test]
    fn a_change_to_doing_starts_a_plan_and_nothing_else_does() {
        use MaintenancePlanStage as S;
        let planned = a_plan(S::Planned, "Readdress core-1", "Reboot core-1");
        let doing = a_plan(S::Doing, "Readdress core-1", "Reboot core-1");
        let recorded = a_plan(S::Recorded, "Readdress core-1", "Reboot core-1");
        let called_off = a_plan(S::CalledOff, "Readdress core-1", "Reboot core-1");
        let started = plans_starting(&planned, &doing);
        assert_eq!(started.len(), 1);
        assert_eq!(started[0].stage, "doing");
        assert_eq!(started[0].title, "Readdress core-1");
        assert_eq!(started[0].made_by, fathom_id::Ulid(77).encode());
        // Straight to recorded is a start too; a plan made already under way is one.
        assert_eq!(plans_starting(&planned, &recorded).len(), 1);
        assert_eq!(plans_starting(&Graph::new(), &doing).len(), 1);
        // Already under way, called off, or still planned: no start.
        assert!(plans_starting(&doing, &recorded).is_empty());
        assert!(plans_starting(&planned, &called_off).is_empty());
        assert!(plans_starting(&planned, &planned).is_empty());
    }

    #[test]
    fn the_digest_follows_what_the_plan_says_not_where_it_is() {
        use MaintenancePlanStage as S;
        let digest = |g: &Graph| plans_of(g)[0].digest;
        let planned = a_plan(S::Planned, "Readdress core-1", "Reboot core-1");
        // The stage is not what was approved: starting keeps the digest.
        assert_eq!(
            digest(&planned),
            digest(&a_plan(S::Doing, "Readdress core-1", "Reboot core-1"))
        );
        // Any change to the words of the plan or a step leaves an approval behind.
        assert_ne!(
            digest(&planned),
            digest(&a_plan(S::Planned, "Readdress core-2", "Reboot core-1"))
        );
        assert_ne!(
            digest(&planned),
            digest(&a_plan(S::Planned, "Readdress core-1", "Reboot core-2"))
        );
    }

    #[test]
    fn only_doing_and_recorded_are_under_way() {
        assert!(under_way("doing") && under_way("recorded"));
        assert!(!under_way("planned") && !under_way("called_off") && !under_way(""));
    }
}
