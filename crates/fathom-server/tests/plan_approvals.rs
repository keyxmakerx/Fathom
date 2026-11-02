//! Plans a folder asks to be approved before they start (migration 0072) against a real
//! PostgreSQL. The helpers are `team_roles.rs`'s; each name is the claim, and every rule and
//! approval goes through the real propose-sign-commit path with real keys.

mod support;

use deadpool_postgres::Pool;

use fathom_server::authority::{Capability, SoftwareKey};
use fathom_server::crypto::{now_unix, Key32};
use fathom_server::grants::{self, Authority, AuthorityError, EpochWatch};
use fathom_server::keys::{self, DataKey, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId, ScopeId};
use std::collections::BTreeSet;

use fathom_server::plan_approval::{self, PlanFacts, NEEDS_APPROVAL};
#[allow(unused_imports)]
use fathom_server::roles::{self, Power, RoleRequest};
use fathom_server::teams::{self, NewTeam, TeamActRequest};

const MASTER: [u8; 32] = [21; 32];

fn keyring(chain_master: u8) -> KeyRing {
    KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes([chain_master; 32]),
    )
}

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

struct Person {
    account: AccountId,
    key: SoftwareKey,
}

struct Org {
    id: OrganisationId,
    stewards: Vec<Person>,
}

async fn an_account(pool: &Pool, name: &str) -> AccountId {
    repo::create_account(pool, &unique(name), name)
        .await
        .expect("create account")
        .id
}

async fn acting<'a>(
    client: &'a mut deadpool_postgres::Client,
    ring: &'a KeyRing,
    organisation: OrganisationId,
    account: AccountId,
) -> (
    deadpool_postgres::Transaction<'a>,
    repo::TenantContext,
    DataKey,
) {
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, organisation, account)
        .await
        .expect("tenant context");
    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.expect("tenant key");
    (tx, ctx, tenant_key)
}

/// §6.1's genesis with `n` root stewards, each with an enrolled key.
async fn an_org(pool: &Pool, ring: &KeyRing, n: usize) -> Org {
    use fathom_server::authority::{self, GrantFacts};
    use fathom_server::grants::GenesisGrant;
    let root = SoftwareKey::random().unwrap();
    let salt = [0x5au8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());
    let mut stewards = Vec::new();
    for i in 0..n {
        stewards.push(Person {
            account: an_account(pool, &format!("steward{i}")).await,
            key: SoftwareKey::random().unwrap(),
        });
    }
    let now = now_unix();
    let requests: Vec<GenesisGrant> = stewards
        .iter()
        .map(|s| {
            let subject_key_fpr = authority::key_fingerprint(&s.key.public_key());
            let facts = GrantFacts {
                organisation: &organisation_id,
                root_pubkey_fpr: &root_fpr,
                scope: "",
                subject: &s.account.to_string(),
                subject_key_fpr: &subject_key_fpr,
                capability: Capability::Steward,
                granter: None,
                granter_key_fpr: &root_fpr,
                effective_from_unix: now,
                expires_at_unix: now + 365 * 24 * 3600,
                sole_steward_appointment: false,
                auth_epoch: 1,
            };
            GenesisGrant {
                subject: s.account,
                subject_key_fpr,
                capability: Capability::Steward,
                effective_from_unix: now,
                expires_at_unix: now + 365 * 24 * 3600,
                signature: root.sign(&authority::grant_bytes(&facts)),
            }
        })
        .collect();
    let mut client = pool.get().await.unwrap();
    let tx = client.transaction().await.unwrap();
    let genesis = grants::bootstrap_organisation(
        &tx,
        ring,
        stewards[0].account,
        &unique("Org"),
        &root.public_key(),
        &salt,
        &requests,
    )
    .await
    .expect("genesis");
    tx.commit().await.unwrap();
    for (i, s) in stewards.iter().enumerate() {
        if i > 0 {
            repo::add_member(
                pool,
                genesis.organisation,
                stewards[0].account,
                s.account,
                repo::Role::Member,
            )
            .await
            .unwrap();
        }
        enrol(pool, ring, genesis.organisation, s).await;
    }
    Org {
        id: genesis.organisation,
        stewards,
    }
}

async fn enrol(pool: &Pool, ring: &KeyRing, organisation: OrganisationId, who: &Person) {
    let mut client = pool.get().await.unwrap();
    let (tx, ctx, tenant_key) = acting(&mut client, ring, organisation, who.account).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    grants::enrol_software_key(&tx, &auth, &who.key.public_key())
        .await
        .expect("enrol");
    tx.commit().await.unwrap();
}

/// A member of the organisation, with a key, holding no grant.
async fn a_member(pool: &Pool, ring: &KeyRing, org: &Org, name: &str) -> Person {
    let person = Person {
        account: an_account(pool, name).await,
        key: SoftwareKey::random().unwrap(),
    };
    repo::add_member(
        pool,
        org.id,
        org.stewards[0].account,
        person.account,
        repo::Role::Member,
    )
    .await
    .unwrap();
    enrol(pool, ring, org.id, &person).await;
    person
}

fn request(team: Option<&str>, act: &str, by: &str) -> TeamActRequest {
    TeamActRequest {
        team: team.map(str::to_string),
        act: act.to_string(),
        subject: None,
        role: None,
        scope: None,
        capability: None,
        undoes: None,
        signer_authority: by.to_string(),
    }
}

/// Propose, sign with `who`'s key, commit: the browser's round trip.
async fn act(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: &Person,
    req: &TeamActRequest,
    new_team: Option<&NewTeam>,
) -> Result<(String, String), AuthorityError> {
    let mut client = pool.get().await.unwrap();
    let (tx, ctx, tenant_key) = acting(&mut client, ring, org.id, who.account).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let fpr = fathom_server::authority::key_fingerprint(&who.key.public_key());
    let proposal = teams::propose_act(&tx, &auth, req, new_team, &fpr).await?;
    let signature = who.key.sign(&proposal.bytes);
    let id = teams::commit_act(&tx, &auth, &proposal, new_team, &signature).await?;
    tx.commit().await.unwrap();
    Ok((proposal.team, id))
}

#[allow(dead_code)]
async fn may(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: AccountId,
    scope: Option<ScopeId>,
    needed: Capability,
) -> Result<bool, AuthorityError> {
    let mut client = pool.get().await.unwrap();
    let (tx, ctx, tenant_key) = acting(&mut client, ring, org.id, who).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let answer = grants::authorise_account(&tx, &auth, scope, needed).await;
    tx.rollback().await.unwrap();
    match answer {
        Ok(_) => Ok(true),
        Err(AuthorityError::NotAuthorised) => Ok(false),
        Err(e) => Err(e),
    }
}

async fn a_team(pool: &Pool, ring: &KeyRing, org: &Org, slug: &str) -> String {
    act(
        pool,
        ring,
        org,
        &org.stewards[0],
        &request(None, teams::ACT_CREATE, teams::BY_STEWARD),
        Some(&NewTeam {
            slug: slug.to_string(),
            name: "Network Design".to_string(),
        }),
    )
    .await
    .expect("a root steward creates a team")
    .0
}

async fn add(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    by: &Person,
    as_: &str,
    team: &str,
    who: AccountId,
) -> Result<String, AuthorityError> {
    let mut r = request(Some(team), teams::ACT_MEMBER_ADD, as_);
    r.subject = Some(who.to_string());
    act(pool, ring, org, by, &r, None).await.map(|(_, id)| id)
}

#[allow(dead_code)]
async fn grant(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    by: &Person,
    team: &str,
    scope: Option<ScopeId>,
    capability: Capability,
) -> Result<String, AuthorityError> {
    let mut r = request(Some(team), teams::ACT_GRANT, teams::BY_STEWARD);
    r.scope = scope.map(|s| s.to_string());
    r.capability = Some(capability);
    act(pool, ring, org, by, &r, None).await.map(|(_, id)| id)
}

async fn set_role(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    team: &str,
    who: AccountId,
    role: &str,
) -> Result<String, AuthorityError> {
    let mut r = request(Some(team), teams::ACT_ROLE_SET, teams::BY_STEWARD);
    r.subject = Some(who.to_string());
    r.role = Some(role.to_string());
    act(pool, ring, org, &org.stewards[0], &r, None)
        .await
        .map(|(_, id)| id)
}

/// Propose, sign and commit a role definition as `who`.
#[allow(clippy::too_many_arguments)]
#[allow(dead_code)]
async fn define(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: &Person,
    role: Option<&str>,
    title: &str,
    powers: &[Power],
    retired: bool,
) -> Result<String, AuthorityError> {
    let mut client = pool.get().await.unwrap();
    let (tx, ctx, tenant_key) = acting(&mut client, ring, org.id, who.account).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let fpr = fathom_server::authority::key_fingerprint(&who.key.public_key());
    let req = RoleRequest {
        role: role.map(str::to_string),
        title: title.to_string(),
        powers: powers.iter().copied().collect::<BTreeSet<_>>(),
        retired,
    };
    let proposal = roles::propose(&tx, &auth, &req, &fpr).await?;
    let signature = who.key.sign(&proposal.bytes);
    let role = roles::commit(&tx, &auth, &proposal, &signature).await?;
    tx.commit().await.unwrap();
    Ok(role)
}

/// The roles as the list shows them to `who`: (role, title, powers, retired).
#[allow(dead_code)]
async fn roles_now(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: AccountId,
) -> Vec<(String, String, Vec<&'static str>, bool)> {
    let mut client = pool.get().await.unwrap();
    let (tx, ctx, tenant_key) = acting(&mut client, ring, org.id, who).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let (_, _, defs) = teams::list_with_roles(&tx, &auth).await.expect("list");
    tx.rollback().await.unwrap();
    defs.into_iter()
        .map(|d| {
            let powers = Power::ALL
                .into_iter()
                .filter(|p| d.powers.contains(p))
                .map(Power::as_str)
                .collect();
            (d.role, d.title, powers, d.retired)
        })
        .collect()
}

#[allow(dead_code)]
async fn make_lead(pool: &Pool, ring: &KeyRing, org: &Org, team: &str, who: AccountId) -> String {
    let mut r = request(Some(team), teams::ACT_ROLE_SET, teams::BY_STEWARD);
    r.subject = Some(who.to_string());
    r.role = Some(teams::ROLE_LEAD.to_string());
    act(pool, ring, org, &org.stewards[0], &r, None)
        .await
        .expect("a root steward appoints a lead")
        .1
}

const DESIGN: &str = "01JQZ0000000000000000000RR";

/// A plan as the head would report it: made by `made_by`, assigned to `assigned`, owned by
/// `team`, reading `words` (its digest stands in for everything the plan says).
fn plan(made_by: AccountId, assigned: &str, team: &str, words: u8) -> PlanFacts {
    PlanFacts {
        plan: "01JQZ0000000000000000000SS".to_string(),
        title: "Readdress core-1".to_string(),
        stage: "planned".to_string(),
        team: team.to_string(),
        made_by: made_by.to_string(),
        assigned_to: assigned.to_string(),
        digest: [words; 32],
    }
}

/// Run `f` as `who` in a transaction that commits.
macro_rules! as_who {
    ($pool:expr, $ring:expr, $org:expr, $who:expr, |$tx:ident, $auth:ident| $body:expr) => {{
        let mut client = $pool.get().await.unwrap();
        let ($tx, ctx, tenant_key) = acting(&mut client, $ring, $org.id, $who).await;
        let watch = EpochWatch::new();
        let $auth = Authority {
            ring: $ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let out = $body;
        $tx.commit().await.unwrap();
        out
    }};
}

async fn set_rule(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: &Person,
    required: bool,
) -> Result<String, AuthorityError> {
    let fpr = fathom_server::authority::key_fingerprint(&who.key.public_key());
    as_who!(pool, ring, org, who.account, |tx, auth| {
        match plan_approval::propose_rule(&tx, &auth, None, required, &fpr).await {
            Ok(p) => {
                let signature = who.key.sign(&p.bytes);
                plan_approval::commit_rule(&tx, &auth, &p, &signature).await
            }
            Err(e) => Err(e),
        }
    })
}

async fn approve(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: &Person,
    facts: &PlanFacts,
    kind: &str,
    reason: &str,
) -> Result<String, AuthorityError> {
    let fpr = fathom_server::authority::key_fingerprint(&who.key.public_key());
    as_who!(pool, ring, org, who.account, |tx, auth| {
        match plan_approval::propose_approval(&tx, &auth, DESIGN, None, facts, kind, reason, &fpr)
            .await
        {
            Ok(p) => {
                let signature = who.key.sign(&p.bytes);
                plan_approval::commit_approval(&tx, &auth, None, facts, &p, &signature).await
            }
            Err(e) => Err(e),
        }
    })
}

/// What the gate says about starting `facts`, as `who`.
async fn gate(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: AccountId,
    facts: &PlanFacts,
) -> Option<&'static str> {
    as_who!(pool, ring, org, who, |tx, auth| {
        plan_approval::refuse_unapproved_starts(
            &tx,
            &auth,
            DESIGN,
            None,
            std::slice::from_ref(facts),
        )
        .await
        .expect("the gate answers")
    })
}

/// A team with access to the whole organisation, and its people in their roles.
struct Crew {
    team: String,
    writer: Person,
    supervisor: Person,
    tech: Person,
    outsider: Person,
}

async fn a_crew(pool: &Pool, ring: &KeyRing, org: &Org) -> Crew {
    let team = a_team(pool, ring, org, &unique("ops")).await;
    let writer = a_member(pool, ring, org, "writer").await;
    let supervisor = a_member(pool, ring, org, "supervisor").await;
    let tech = a_member(pool, ring, org, "tech").await;
    let outsider = a_member(pool, ring, org, "outsider").await;
    let steward = &org.stewards[0];
    for p in [&writer, &supervisor, &tech] {
        add(
            pool,
            ring,
            org,
            steward,
            teams::BY_STEWARD,
            &team,
            p.account,
        )
        .await
        .expect("staffed");
    }
    set_role(
        pool,
        ring,
        org,
        &team,
        supervisor.account,
        teams::ROLE_OVERSEER,
    )
    .await
    .expect("a supervisor");
    set_role(pool, ring, org, &team, tech.account, teams::ROLE_TECH)
        .await
        .expect("a maintenance tech");
    grant(pool, ring, org, steward, &team, None, Capability::Draw)
        .await
        .expect("the team may draw");
    Crew {
        team,
        writer,
        supervisor,
        tech,
        outsider,
    }
}

#[tokio::test]
async fn with_no_rule_a_plan_starts_without_approval() {
    let pool = support::migrated_pool().await;
    let ring = keyring(216);
    let org = an_org(&pool, &ring, 1).await;
    let crew = a_crew(&pool, &ring, &org).await;
    let facts = plan(crew.writer.account, "", &crew.team, 1);
    assert_eq!(
        gate(&pool, &ring, &org, crew.writer.account, &facts).await,
        None
    );
}

#[tokio::test]
async fn only_a_steward_turns_the_rule_on_and_then_an_unapproved_start_is_refused() {
    let pool = support::migrated_pool().await;
    let ring = keyring(216);
    let org = an_org(&pool, &ring, 1).await;
    let crew = a_crew(&pool, &ring, &org).await;
    assert!(matches!(
        set_rule(&pool, &ring, &org, &crew.supervisor, true).await,
        Err(AuthorityError::NotAuthorised)
    ));
    set_rule(&pool, &ring, &org, &org.stewards[0], true)
        .await
        .expect("a root steward asks for approval");
    // Saying it again is refused: the log only holds changes.
    assert!(set_rule(&pool, &ring, &org, &org.stewards[0], true)
        .await
        .is_err());
    let facts = plan(crew.writer.account, "", &crew.team, 1);
    assert_eq!(
        gate(&pool, &ring, &org, crew.writer.account, &facts).await,
        Some(NEEDS_APPROVAL)
    );
    set_rule(&pool, &ring, &org, &org.stewards[0], false)
        .await
        .expect("and turns it off");
    assert_eq!(
        gate(&pool, &ring, &org, crew.writer.account, &facts).await,
        None
    );
}

#[tokio::test]
async fn the_teams_supervisor_approves_and_any_change_needs_approving_again() {
    let pool = support::migrated_pool().await;
    let ring = keyring(216);
    let org = an_org(&pool, &ring, 1).await;
    let crew = a_crew(&pool, &ring, &org).await;
    set_rule(&pool, &ring, &org, &org.stewards[0], true)
        .await
        .unwrap();
    let facts = plan(crew.writer.account, "", &crew.team, 1);
    approve(&pool, &ring, &org, &crew.supervisor, &facts, "before", "")
        .await
        .expect("the plan's team's supervisor approves");
    assert_eq!(
        gate(&pool, &ring, &org, crew.writer.account, &facts).await,
        None
    );
    // The plan changed after it was approved: the approval is of the old words.
    let changed = plan(crew.writer.account, "", &crew.team, 2);
    assert_eq!(
        gate(&pool, &ring, &org, crew.writer.account, &changed).await,
        Some(NEEDS_APPROVAL)
    );
}

#[tokio::test]
async fn the_writer_the_assignee_a_tech_and_an_outsider_may_not_approve() {
    let pool = support::migrated_pool().await;
    let ring = keyring(216);
    let org = an_org(&pool, &ring, 1).await;
    let crew = a_crew(&pool, &ring, &org).await;
    set_rule(&pool, &ring, &org, &org.stewards[0], true)
        .await
        .unwrap();
    // Even a supervisor may not approve their own plan, or one assigned to them.
    let theirs = plan(crew.supervisor.account, "", &crew.team, 1);
    let assigned = plan(
        crew.writer.account,
        &crew.supervisor.account.to_string(),
        &crew.team,
        2,
    );
    let ordinary = plan(crew.writer.account, "", &crew.team, 3);
    for (who, facts) in [
        (&crew.supervisor, &theirs),
        (&crew.supervisor, &assigned),
        (&crew.tech, &ordinary),
        (&crew.outsider, &ordinary),
        (&crew.writer, &ordinary),
    ] {
        assert!(
            matches!(
                approve(&pool, &ring, &org, who, facts, "before", "").await,
                Err(AuthorityError::NotAuthorised)
            ),
            "refused"
        );
    }
    // Another team's supervisor may not approve this team's plan.
    let other = a_crew(&pool, &ring, &org).await;
    assert!(matches!(
        approve(
            &pool,
            &ring,
            &org,
            &other.supervisor,
            &ordinary,
            "before",
            ""
        )
        .await,
        Err(AuthorityError::NotAuthorised)
    ));
    // A Steward of the folder may.
    approve(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &ordinary,
        "before",
        "",
    )
    .await
    .expect("a steward approves");
}

#[tokio::test]
async fn a_tech_starts_in_an_emergency_and_it_stays_flagged_until_approved_after() {
    let pool = support::migrated_pool().await;
    let ring = keyring(216);
    let org = an_org(&pool, &ring, 1).await;
    let crew = a_crew(&pool, &ring, &org).await;
    set_rule(&pool, &ring, &org, &org.stewards[0], true)
        .await
        .unwrap();
    let facts = plan(crew.writer.account, "", &crew.team, 1);
    // No reason, no emergency start; a supervisor holds no emergency start power.
    assert!(
        approve(&pool, &ring, &org, &crew.tech, &facts, "emergency", "")
            .await
            .is_err()
    );
    assert!(approve(
        &pool,
        &ring,
        &org,
        &crew.supervisor,
        &facts,
        "emergency",
        "Core down"
    )
    .await
    .is_err());
    approve(
        &pool,
        &ring,
        &org,
        &crew.tech,
        &facts,
        "emergency",
        "Core switch down",
    )
    .await
    .expect("the maintenance tech starts it");
    assert_eq!(
        gate(&pool, &ring, &org, crew.writer.account, &facts).await,
        None
    );

    let flagged = |who: AccountId| {
        let pool = &pool;
        let ring = &ring;
        let org = &org;
        let facts = facts.clone();
        async move {
            as_who!(pool, ring, org, who, |tx, auth| {
                let (required, statuses) =
                    plan_approval::status(&tx, &auth, DESIGN, None, &[facts])
                        .await
                        .expect("status");
                assert!(required);
                let s = &statuses[0];
                assert_eq!(
                    s.approvals[0].reason, "Core switch down",
                    "the reason opens"
                );
                s.flagged
            })
        }
    };
    assert!(flagged(crew.supervisor.account).await);
    // The tech who started it may not approve it after.
    assert!(approve(&pool, &ring, &org, &crew.tech, &facts, "after", "")
        .await
        .is_err());
    approve(&pool, &ring, &org, &crew.supervisor, &facts, "after", "")
        .await
        .expect("the supervisor approves it after the fact");
    assert!(!flagged(crew.supervisor.account).await);
}

#[tokio::test]
async fn whoever_asked_may_not_approve_and_a_send_back_needs_a_note() {
    let pool = support::migrated_pool().await;
    let ring = keyring(216);
    let org = an_org(&pool, &ring, 1).await;
    let crew = a_crew(&pool, &ring, &org).await;
    set_rule(&pool, &ring, &org, &org.stewards[0], true)
        .await
        .unwrap();
    let facts = plan(crew.writer.account, "", &crew.team, 1);
    as_who!(&pool, &ring, &org, crew.supervisor.account, |tx, auth| {
        plan_approval::ask(&tx, &auth, DESIGN, None, &facts, "ask", "Tonight please")
            .await
            .expect("anyone may ask")
    });
    assert!(matches!(
        approve(&pool, &ring, &org, &crew.supervisor, &facts, "before", "").await,
        Err(AuthorityError::NotAuthorised)
    ));
    let other = a_member(&pool, &ring, &org, "second-supervisor").await;
    add(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        teams::BY_STEWARD,
        &crew.team,
        other.account,
    )
    .await
    .unwrap();
    set_role(
        &pool,
        &ring,
        &org,
        &crew.team,
        other.account,
        teams::ROLE_OVERSEER,
    )
    .await
    .unwrap();
    let mut client = pool.get().await.unwrap();
    let (tx, ctx, tenant_key) = acting(&mut client, &ring, org.id, other.account).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    assert!(
        plan_approval::ask(&tx, &auth, DESIGN, None, &facts, "send_back", "")
            .await
            .is_err(),
        "a send-back says why"
    );
    tx.rollback().await.unwrap();
    as_who!(&pool, &ring, &org, other.account, |tx, auth| {
        plan_approval::ask(
            &tx,
            &auth,
            DESIGN,
            None,
            &facts,
            "send_back",
            "Step 2 is missing",
        )
        .await
        .expect("an approver sends it back")
    });
    approve(&pool, &ring, &org, &other, &facts, "before", "")
        .await
        .expect("a second supervisor who did not ask approves");
}
