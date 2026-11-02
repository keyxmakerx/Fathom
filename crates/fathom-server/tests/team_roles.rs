//! Team roles with a title and powers (migration 0071) against a real PostgreSQL.
//!
//! As in `teams.rs`, whose helpers these are, each name is the claim and every act goes
//! through the real propose-sign-commit path with real keys.

mod support;

use deadpool_postgres::Pool;

use fathom_server::authority::{Capability, SoftwareKey};
use fathom_server::crypto::{now_unix, Key32};
use fathom_server::grants::{self, Authority, AuthorityError, EpochWatch};
use fathom_server::keys::{self, DataKey, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId, ScopeId};
use std::collections::BTreeSet;

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

#[tokio::test]
async fn three_roles_come_ready_made_and_a_root_steward_can_change_them() {
    let pool = support::migrated_pool().await;
    let ring = keyring(211);
    let org = an_org(&pool, &ring, 1).await;
    let steward = &org.stewards[0];
    let before = roles_now(&pool, &ring, &org, steward.account).await;
    assert_eq!(
        before,
        vec![
            (
                "lead".to_string(),
                "Lead".to_string(),
                vec![
                    "assign",
                    "due_dates",
                    "approve_plans",
                    "members",
                    "history",
                    "emergency_start"
                ],
                false
            ),
            (
                "overseer".to_string(),
                "Supervisor".to_string(),
                vec!["assign", "due_dates", "approve_plans", "history"],
                false
            ),
            (
                "tech".to_string(),
                "Maintenance tech".to_string(),
                vec!["emergency_start"],
                false
            ),
        ]
    );

    define(
        &pool,
        &ring,
        &org,
        steward,
        Some("tech"),
        "Field engineer",
        &[Power::EmergencyStart, Power::History],
        false,
    )
    .await
    .expect("a root steward renames a ready-made role and changes its powers");
    let night = define(
        &pool,
        &ring,
        &org,
        steward,
        None,
        "Night desk",
        &[Power::Assign],
        false,
    )
    .await
    .expect("a root steward adds a role");
    let after = roles_now(&pool, &ring, &org, steward.account).await;
    assert_eq!(after[2].1, "Field engineer");
    assert_eq!(after[2].2, vec!["history", "emergency_start"]);
    assert_eq!(after[3].0, night);
    assert_eq!(after[3].1, "Night desk");

    // Two roles never read the same, whatever the case.
    let clash = define(&pool, &ring, &org, steward, None, "night DESK", &[], false).await;
    assert!(
        matches!(clash, Err(AuthorityError::NotAuthorised)),
        "{clash:?}"
    );
    // A ready-made role is changed, never retired.
    let retire_lead = define(&pool, &ring, &org, steward, Some("lead"), "Lead", &[], true).await;
    assert!(
        matches!(retire_lead, Err(AuthorityError::NotAuthorised)),
        "{retire_lead:?}"
    );
}

#[tokio::test]
async fn only_a_root_steward_defines_a_role() {
    let pool = support::migrated_pool().await;
    let ring = keyring(212);
    let org = an_org(&pool, &ring, 1).await;
    let lead = a_member(&pool, &ring, &org, "lead").await;
    let team = a_team(&pool, &ring, &org, "core").await;
    set_role(&pool, &ring, &org, &team, lead.account, "lead")
        .await
        .unwrap();
    // A lead holds every power, and still cannot touch what a role is.
    let refused = define(
        &pool,
        &ring,
        &org,
        &lead,
        Some("tech"),
        "Maintenance tech",
        &Power::ALL,
        false,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
}

#[tokio::test]
async fn the_members_power_comes_from_the_role_at_the_acts_position() {
    let pool = support::migrated_pool().await;
    let ring = keyring(213);
    let org = an_org(&pool, &ring, 1).await;
    let steward = &org.stewards[0];
    let desk = a_member(&pool, &ring, &org, "desk").await;
    let first = a_member(&pool, &ring, &org, "first").await;
    let second = a_member(&pool, &ring, &org, "second").await;
    let team = a_team(&pool, &ring, &org, "service-desk").await;
    grant(&pool, &ring, &org, steward, &team, None, Capability::Read)
        .await
        .unwrap();
    let staffer = define(
        &pool,
        &ring,
        &org,
        steward,
        None,
        "Staffer",
        &[Power::Members],
        false,
    )
    .await
    .unwrap();
    set_role(&pool, &ring, &org, &team, desk.account, &staffer)
        .await
        .unwrap();

    // A Steward's own role with the members power staffs the team, as a lead does.
    add(
        &pool,
        &ring,
        &org,
        &desk,
        teams::BY_LEAD,
        &team,
        first.account,
    )
    .await
    .expect("the members power lets them add");
    assert!(
        may(&pool, &ring, &org, first.account, None, Capability::Read)
            .await
            .unwrap()
    );
    // Never themselves (T2), whatever the role.
    let own = add(
        &pool,
        &ring,
        &org,
        &desk,
        teams::BY_LEAD,
        &team,
        desk.account,
    )
    .await;
    assert!(matches!(own, Err(AuthorityError::NotAuthorised)), "{own:?}");

    // The power taken away: the earlier add still stands (T3), and no more can be made.
    define(
        &pool,
        &ring,
        &org,
        steward,
        Some(&staffer),
        "Staffer",
        &[],
        false,
    )
    .await
    .unwrap();
    assert!(
        may(&pool, &ring, &org, first.account, None, Capability::Read)
            .await
            .unwrap()
    );
    let refused = add(
        &pool,
        &ring,
        &org,
        &desk,
        teams::BY_LEAD,
        &team,
        second.account,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );

    // Maintenance tech has no members power out of the box.
    let tech = a_member(&pool, &ring, &org, "tech").await;
    set_role(&pool, &ring, &org, &team, tech.account, "tech")
        .await
        .unwrap();
    let refused = add(
        &pool,
        &ring,
        &org,
        &tech,
        teams::BY_LEAD,
        &team,
        second.account,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
}

#[tokio::test]
async fn a_retired_role_cannot_be_given_and_gives_nothing() {
    let pool = support::migrated_pool().await;
    let ring = keyring(214);
    let org = an_org(&pool, &ring, 1).await;
    let steward = &org.stewards[0];
    let holder = a_member(&pool, &ring, &org, "holder").await;
    let newcomer = a_member(&pool, &ring, &org, "newcomer").await;
    let other = a_member(&pool, &ring, &org, "other").await;
    let team = a_team(&pool, &ring, &org, "noc").await;
    let deputy = define(
        &pool,
        &ring,
        &org,
        steward,
        None,
        "Deputy",
        &[Power::Members],
        false,
    )
    .await
    .unwrap();
    set_role(&pool, &ring, &org, &team, holder.account, &deputy)
        .await
        .unwrap();
    define(
        &pool,
        &ring,
        &org,
        steward,
        Some(&deputy),
        "Deputy",
        &[Power::Members],
        true,
    )
    .await
    .expect("a Steward's role can be retired");

    let given = set_role(&pool, &ring, &org, &team, newcomer.account, &deputy).await;
    assert!(
        matches!(given, Err(AuthorityError::NotAuthorised)),
        "{given:?}"
    );
    let refused = add(
        &pool,
        &ring,
        &org,
        &holder,
        teams::BY_LEAD,
        &team,
        other.account,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
    // Retired stays retired.
    let back = define(
        &pool,
        &ring,
        &org,
        steward,
        Some(&deputy),
        "Deputy",
        &[],
        false,
    )
    .await;
    assert!(
        matches!(back, Err(AuthorityError::NotAuthorised)),
        "{back:?}"
    );
    // A role id nobody defined is no role.
    let unknown = set_role(
        &pool,
        &ring,
        &org,
        &team,
        newcomer.account,
        "01JQZ0000000000000000000NN",
    )
    .await;
    assert!(
        matches!(unknown, Err(AuthorityError::NotAuthorised)),
        "{unknown:?}"
    );
}

#[tokio::test]
async fn deleting_the_definition_that_took_a_power_away_fails_closed() {
    let pool = support::migrated_pool().await;
    let ring = keyring(215);
    let org = an_org(&pool, &ring, 1).await;
    let steward = &org.stewards[0];
    let member = a_member(&pool, &ring, &org, "member").await;
    let team = a_team(&pool, &ring, &org, "core").await;
    grant(&pool, &ring, &org, steward, &team, None, Capability::Read)
        .await
        .unwrap();
    add(
        &pool,
        &ring,
        &org,
        steward,
        teams::BY_STEWARD,
        &team,
        member.account,
    )
    .await
    .unwrap();
    define(
        &pool,
        &ring,
        &org,
        steward,
        Some("lead"),
        "Lead",
        &[Power::Assign],
        false,
    )
    .await
    .unwrap();
    let su = support::superuser_client_on_test_database().await;
    let deleted = support::tamper(
        &su,
        "team_role_defs",
        "DELETE FROM team_role_defs WHERE organisation_id = $1",
        &[&org.id.to_string()],
    )
    .await;
    assert_eq!(deleted, 1);
    let answer = may(&pool, &ring, &org, member.account, None, Capability::Read).await;
    assert!(
        matches!(answer, Err(AuthorityError::Unverifiable("authority state"))),
        "bringing back a power by deleting the definition that removed it must fail closed: \
         {answer:?}"
    );
}
