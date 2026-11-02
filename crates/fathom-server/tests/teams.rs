//! Teams (ADR-0081) against a real PostgreSQL, one test per decision of
//! `docs/TEAMS-ATTACK-ROUND.md` that a database can show.
//!
//! As in `authority.rs`, each name is the claim, every act goes through the real
//! propose-sign-commit path with real keys, and every answer comes from
//! `grants::authorise_account`, the check every request runs.

mod support;

use deadpool_postgres::Pool;

use fathom_server::authority::{Capability, SoftwareKey};
use fathom_server::crypto::{now_unix, Key32};
use fathom_server::grants::{self, Authority, AuthorityError, EpochWatch, GrantRequest};
use fathom_server::keys::{self, DataKey, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId, ScopeId, ScopeKind};
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

async fn a_network(pool: &Pool, org: &Org, name: &str) -> ScopeId {
    repo::create_scope(
        pool,
        org.id,
        org.stewards[0].account,
        None,
        ScopeKind::Network,
        name,
    )
    .await
    .expect("network")
    .id
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
async fn a_team_grant_reaches_its_members_and_nobody_else_and_never_steward() {
    let pool = support::migrated_pool().await;
    let ring = keyring(201);
    let org = an_org(&pool, &ring, 1).await;
    let net = a_network(&pool, &org, "leeds").await;
    let other = a_network(&pool, &org, "york").await;
    let member = a_member(&pool, &ring, &org, "member").await;
    let outsider = a_member(&pool, &ring, &org, "outsider").await;

    let team = a_team(&pool, &ring, &org, "network-design").await;
    grant(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &team,
        Some(net),
        Capability::Draw,
    )
    .await
    .expect("a steward grants the team Draw on Leeds");
    assert!(!may(
        &pool,
        &ring,
        &org,
        member.account,
        Some(net),
        Capability::Read
    )
    .await
    .unwrap());
    add(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        teams::BY_STEWARD,
        &team,
        member.account,
    )
    .await
    .expect("a root steward adds a member");

    assert!(may(
        &pool,
        &ring,
        &org,
        member.account,
        Some(net),
        Capability::Draw
    )
    .await
    .unwrap());
    assert!(!may(
        &pool,
        &ring,
        &org,
        member.account,
        Some(other),
        Capability::Read
    )
    .await
    .unwrap());
    assert!(!may(
        &pool,
        &ring,
        &org,
        member.account,
        Some(net),
        Capability::Steward
    )
    .await
    .unwrap());
    assert!(!may(
        &pool,
        &ring,
        &org,
        outsider.account,
        Some(net),
        Capability::Read
    )
    .await
    .unwrap());

    // T4: no team grant is `steward`, refused before any signature is asked for.
    let refused = grant(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &team,
        None,
        Capability::Steward,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
}

#[tokio::test]
async fn removing_a_member_or_revoking_the_grant_bites_at_the_next_request() {
    let pool = support::migrated_pool().await;
    let ring = keyring(202);
    let org = an_org(&pool, &ring, 1).await;
    let member = a_member(&pool, &ring, &org, "member").await;
    let team = a_team(&pool, &ring, &org, "ops").await;
    let g = grant(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &team,
        None,
        Capability::Read,
    )
    .await
    .unwrap();
    let added = add(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        teams::BY_STEWARD,
        &team,
        member.account,
    )
    .await
    .unwrap();
    assert!(
        may(&pool, &ring, &org, member.account, None, Capability::Read)
            .await
            .unwrap()
    );

    let mut remove = request(Some(&team), teams::ACT_MEMBER_REMOVE, teams::BY_STEWARD);
    remove.subject = Some(member.account.to_string());
    remove.undoes = Some(added);
    act(&pool, &ring, &org, &org.stewards[0], &remove, None)
        .await
        .expect("removed");
    assert!(
        !may(&pool, &ring, &org, member.account, None, Capability::Read)
            .await
            .unwrap()
    );

    add(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        teams::BY_STEWARD,
        &team,
        member.account,
    )
    .await
    .expect("added back");
    assert!(
        may(&pool, &ring, &org, member.account, None, Capability::Read)
            .await
            .unwrap()
    );
    let mut revoke = request(Some(&team), teams::ACT_GRANT_REVOKE, teams::BY_STEWARD);
    revoke.undoes = Some(g);
    act(&pool, &ring, &org, &org.stewards[0], &revoke, None)
        .await
        .expect("revoked");
    assert!(
        !may(&pool, &ring, &org, member.account, None, Capability::Read)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn a_lead_staffs_their_team_but_never_adds_themselves_or_grants_it_anything() {
    let pool = support::migrated_pool().await;
    let ring = keyring(203);
    let org = an_org(&pool, &ring, 1).await;
    let lead = a_member(&pool, &ring, &org, "lead").await;
    let recruit = a_member(&pool, &ring, &org, "recruit").await;
    let team = a_team(&pool, &ring, &org, "installation").await;
    grant(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &team,
        None,
        Capability::Draw,
    )
    .await
    .unwrap();

    // Not a lead yet: nothing.
    let refused = add(
        &pool,
        &ring,
        &org,
        &lead,
        teams::BY_LEAD,
        &team,
        recruit.account,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );

    make_lead(&pool, &ring, &org, &team, lead.account).await;
    // T12: the role gives no folder access.
    assert!(
        !may(&pool, &ring, &org, lead.account, None, Capability::Read)
            .await
            .unwrap()
    );

    add(
        &pool,
        &ring,
        &org,
        &lead,
        teams::BY_LEAD,
        &team,
        recruit.account,
    )
    .await
    .expect("a lead adds an organisation member to their team");
    assert!(
        may(&pool, &ring, &org, recruit.account, None, Capability::Draw)
            .await
            .unwrap()
    );

    // T2: never themselves.
    let refused = add(
        &pool,
        &ring,
        &org,
        &lead,
        teams::BY_LEAD,
        &team,
        lead.account,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
    // T1: a lead's authority reaches membership and nothing else.
    let mut r = request(Some(&team), teams::ACT_GRANT, teams::BY_LEAD);
    r.capability = Some(Capability::Read);
    let refused = act(&pool, &ring, &org, &lead, &r, None).await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
    // T13: only people already in the organisation.
    let stranger = Person {
        account: an_account(&pool, "stranger").await,
        key: SoftwareKey::random().unwrap(),
    };
    let refused = add(
        &pool,
        &ring,
        &org,
        &lead,
        teams::BY_LEAD,
        &team,
        stranger.account,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
}

#[tokio::test]
async fn a_demoted_leads_adds_still_stand_and_they_can_add_no_more() {
    let pool = support::migrated_pool().await;
    let ring = keyring(204);
    let org = an_org(&pool, &ring, 1).await;
    let lead = a_member(&pool, &ring, &org, "lead").await;
    let first = a_member(&pool, &ring, &org, "first").await;
    let second = a_member(&pool, &ring, &org, "second").await;
    let team = a_team(&pool, &ring, &org, "provisioning").await;
    grant(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &team,
        None,
        Capability::Read,
    )
    .await
    .unwrap();
    let role = make_lead(&pool, &ring, &org, &team, lead.account).await;
    add(
        &pool,
        &ring,
        &org,
        &lead,
        teams::BY_LEAD,
        &team,
        first.account,
    )
    .await
    .unwrap();

    let mut clear = request(Some(&team), teams::ACT_ROLE_CLEAR, teams::BY_STEWARD);
    clear.subject = Some(lead.account.to_string());
    clear.role = Some(teams::ROLE_LEAD.to_string());
    clear.undoes = Some(role);
    act(&pool, &ring, &org, &org.stewards[0], &clear, None)
        .await
        .expect("the lead is cleared");

    // T3: judged at the row's chain position, so the earlier add still counts.
    assert!(
        may(&pool, &ring, &org, first.account, None, Capability::Read)
            .await
            .unwrap()
    );
    let refused = add(
        &pool,
        &ring,
        &org,
        &lead,
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
async fn a_steward_of_one_network_cannot_staff_a_team_or_grant_it_elsewhere() {
    let pool = support::migrated_pool().await;
    let ring = keyring(205);
    // Two root stewards, so a third can be made steward of one network with a seconding.
    let org = an_org(&pool, &ring, 2).await;
    let leeds = a_network(&pool, &org, "leeds").await;
    let york = a_network(&pool, &org, "york").await;
    let site = a_member(&pool, &ring, &org, "site-steward").await;
    {
        let mut client = pool.get().await.unwrap();
        let (tx, ctx, tenant_key) =
            acting(&mut client, &ring, org.id, org.stewards[0].account).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let proposal = grants::propose_grant(
            &tx,
            &auth,
            &GrantRequest {
                scope: Some(leeds),
                subject: site.account,
                capability: Capability::Steward,
                expires_at_unix: now_unix() + 3600,
            },
        )
        .await
        .unwrap();
        let signature = org.stewards[0].key.sign(&proposal.bytes);
        let grant_id = grants::sign_grant(&tx, &auth, &proposal, &signature)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let (tx, ctx, tenant_key) =
            acting(&mut client, &ring, org.id, org.stewards[1].account).await;
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let second = org.stewards[1]
            .key
            .sign(&fathom_server::authority::second_bytes(
                &proposal.bytes,
                &proposal.granter_key_fpr,
            ));
        grants::second_grant(&tx, &auth, &grant_id, &second)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    assert!(may(
        &pool,
        &ring,
        &org,
        site.account,
        Some(leeds),
        Capability::Steward
    )
    .await
    .unwrap());

    let team = a_team(&pool, &ring, &org, "everyone").await;
    grant(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &team,
        None,
        Capability::Draw,
    )
    .await
    .unwrap();

    // T1: the site steward may not add themselves (or anyone) to a team that sees everything.
    let refused = add(
        &pool,
        &ring,
        &org,
        &site,
        teams::BY_STEWARD,
        &team,
        site.account,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
    assert!(!may(
        &pool,
        &ring,
        &org,
        site.account,
        Some(york),
        Capability::Read
    )
    .await
    .unwrap());

    // They may grant the team access where they steward, and only there.
    grant(
        &pool,
        &ring,
        &org,
        &site,
        &team,
        Some(leeds),
        Capability::Read,
    )
    .await
    .expect("a steward of Leeds grants a team Read on Leeds");
    let refused = grant(
        &pool,
        &ring,
        &org,
        &site,
        &team,
        Some(york),
        Capability::Read,
    )
    .await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
}

#[tokio::test]
async fn deleting_the_row_that_removed_someone_fails_closed() {
    let pool = support::migrated_pool().await;
    let ring = keyring(206);
    let org = an_org(&pool, &ring, 1).await;
    let member = a_member(&pool, &ring, &org, "member").await;
    let team = a_team(&pool, &ring, &org, "noc").await;
    grant(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &team,
        None,
        Capability::Draw,
    )
    .await
    .unwrap();
    let added = add(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        teams::BY_STEWARD,
        &team,
        member.account,
    )
    .await
    .unwrap();
    let mut remove = request(Some(&team), teams::ACT_MEMBER_REMOVE, teams::BY_STEWARD);
    remove.subject = Some(member.account.to_string());
    remove.undoes = Some(added);
    let (_, removal) = act(&pool, &ring, &org, &org.stewards[0], &remove, None)
        .await
        .unwrap();

    // T7: the tier-3 move, trigger off and the removal deleted.
    let su = support::superuser_client_on_test_database().await;
    let deleted = support::tamper(
        &su,
        "team_acts",
        "DELETE FROM team_acts WHERE id = $1",
        &[&removal],
    )
    .await;
    assert_eq!(deleted, 1);
    let answer = may(&pool, &ring, &org, member.account, None, Capability::Read).await;
    assert!(
        matches!(answer, Err(AuthorityError::Unverifiable("authority state"))),
        "reinstating a member by deleting their removal must fail closed: {answer:?}"
    );
}

#[tokio::test]
async fn a_deleted_team_gives_nothing_and_an_operator_kind_never_reaches_the_table() {
    let pool = support::migrated_pool().await;
    let ring = keyring(207);
    let org = an_org(&pool, &ring, 1).await;
    let member = a_member(&pool, &ring, &org, "member").await;
    let team = a_team(&pool, &ring, &org, "gone").await;
    grant(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &team,
        None,
        Capability::Read,
    )
    .await
    .unwrap();
    add(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        teams::BY_STEWARD,
        &team,
        member.account,
    )
    .await
    .unwrap();
    assert!(
        may(&pool, &ring, &org, member.account, None, Capability::Read)
            .await
            .unwrap()
    );
    act(
        &pool,
        &ring,
        &org,
        &org.stewards[0],
        &request(Some(&team), teams::ACT_DELETE, teams::BY_STEWARD),
        None,
    )
    .await
    .expect("deleted");
    // T11.
    assert!(
        !may(&pool, &ring, &org, member.account, None, Capability::Read)
            .await
            .unwrap()
    );

    // T4/T8: a team id is never a scope grant's subject, at any privilege level.
    let su = support::superuser_client_on_test_database().await;
    let refused = su
        .execute(
            "INSERT INTO memberships (account_id, organisation_id, role) VALUES ($1, $2, 'member')",
            &[&team, &org.id.to_string()],
        )
        .await;
    assert!(refused.is_err(), "a team is not an account");
}
