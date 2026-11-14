//! Orders (ADR-0084 piece 2) against a real PostgreSQL: order types saved by a Steward with
//! their teams matched, orders opened by any member, each action decided by the engine from the
//! caller's standing on the order's teams, every word sealed, and the history the only record.

mod support;

use std::collections::BTreeMap;

use deadpool_postgres::Pool;
use fathom_canon::Json;

use fathom_orders::engine::{Action, Actor};
use fathom_server::authority::{Capability, SoftwareKey};
use fathom_server::crypto::{now_unix, Key32};
use fathom_server::grants::{self, Authority, AuthorityError, EpochWatch};
use fathom_server::keys::{self, DataKey, KeyRing};
use fathom_server::orders::{self, OrderError, OrderType, OrderView, TypeRequest};
use fathom_server::repo::{self, AccountId, OrganisationId};
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

async fn a_team(pool: &Pool, ring: &KeyRing, org: &Org, slug: &str) -> String {
    act(
        pool,
        ring,
        org,
        &org.stewards[0],
        &request(None, teams::ACT_CREATE, teams::BY_STEWARD),
        Some(&NewTeam {
            slug: slug.to_string(),
            name: slug.replace('-', " "),
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

async fn make_lead(pool: &Pool, ring: &KeyRing, org: &Org, team: &str, who: AccountId) -> String {
    let mut r = request(Some(team), teams::ACT_ROLE_SET, teams::BY_STEWARD);
    r.subject = Some(who.to_string());
    r.role = Some(teams::ROLE_LEAD.to_string());
    act(pool, ring, org, &org.stewards[0], &r, None)
        .await
        .expect("a root steward appoints a lead")
        .1
}

// ---------------------------------------------------------------------------
// Orders, as the routes call them
// ---------------------------------------------------------------------------

const DIA: &str = include_str!("../../../corpus/orders/dia.yaml");
const CUSTOMER: &str = include_str!("../../../corpus/orders/field-sets/customer-details.yaml");
const SLUGS: [&str; 5] = [
    "order-desk",
    "ip-design",
    "network-design",
    "provisioning",
    "field",
];

fn dia(id: Option<&str>) -> TypeRequest {
    TypeRequest {
        id: id.map(str::to_string),
        source: DIA.to_string(),
        field_sets: vec![CUSTOMER.to_string()],
        teams: BTreeMap::new(),
    }
}

/// Run `f` as `who`, committing only when it succeeds.
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
        if out.is_ok() {
            $tx.commit().await.unwrap();
        } else {
            $tx.rollback().await.unwrap();
        }
        out
    }};
}

async fn save(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: AccountId,
    req: TypeRequest,
) -> Result<OrderType, OrderError> {
    as_who!(pool, ring, org, who, |tx, auth| orders::save_type(
        &tx, &auth, req
    )
    .await)
}

fn answers(bandwidth: &str) -> BTreeMap<String, Json> {
    [
        ("customer", "Riverside Council"),
        ("contact_name", "J. Okafor"),
        ("site", "site:riverside"),
        ("bandwidth", bandwidth),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), Json::Str(v.to_string())))
    .collect()
}

async fn open(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: AccountId,
    type_id: &str,
    a: BTreeMap<String, Json>,
) -> Result<OrderView, OrderError> {
    as_who!(pool, ring, org, who, |tx, auth| orders::open_order(
        &tx, &auth, type_id, a
    )
    .await)
}

async fn doing(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: AccountId,
    order: &str,
    word: &str,
    keys: &[(&str, Json)],
) -> Result<OrderView, OrderError> {
    let body: BTreeMap<String, Json> = keys
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect();
    as_who!(pool, ring, org, who, |tx, auth| orders::act(
        &tx, &auth, order, word, body
    )
    .await)
}

async fn get(pool: &Pool, ring: &KeyRing, org: &Org, who: AccountId, order: &str) -> OrderView {
    as_who!(pool, ring, org, who, |tx, auth| orders::get_order(
        &tx, &auth, order
    )
    .await)
    .expect("reads")
}

fn job(id: &str) -> (&'static str, Json) {
    ("job", Json::Str(id.to_string()))
}

/// Tick every step of `job`, then finish it, as `who`.
async fn finish(pool: &Pool, ring: &KeyRing, org: &Org, who: AccountId, order: &str, j: &str) {
    let view = get(pool, ring, org, who, order).await;
    let steps = view
        .order
        .definition()
        .jobs()
        .find(|x| x.id == j)
        .unwrap()
        .steps
        .len();
    for step in 0..steps {
        doing(
            pool,
            ring,
            org,
            who,
            order,
            "tick",
            &[
                job(j),
                ("step", Json::Int(step as i64)),
                ("done", Json::Bool(true)),
            ],
        )
        .await
        .unwrap_or_else(|e| panic!("tick {j}: {e:?}"));
    }
    doing(pool, ring, org, who, order, "finish", &[job(j)])
        .await
        .unwrap_or_else(|e| panic!("finish {j}: {e:?}"));
}

fn refused(r: Result<OrderView, OrderError>) -> String {
    match r {
        Err(OrderError::Refused(m)) => m,
        Err(e) => panic!("refused for another reason: {e:?}"),
        Ok(_) => panic!("should have been refused"),
    }
}

struct Estate {
    org: Org,
    /// slug → team id
    teams: BTreeMap<String, String>,
    /// slug → a member of that team
    members: BTreeMap<String, Person>,
}

/// An organisation with DIA's five teams, one member on each.
async fn an_estate(pool: &Pool, ring: &KeyRing) -> Estate {
    let org = an_org(pool, ring, 1).await;
    let mut teams_by_slug = BTreeMap::new();
    let mut members = BTreeMap::new();
    for slug in SLUGS {
        let team = a_team(pool, ring, &org, slug).await;
        let who = a_member(pool, ring, &org, slug).await;
        add(
            pool,
            ring,
            &org,
            &org.stewards[0],
            teams::BY_STEWARD,
            &team,
            who.account,
        )
        .await
        .expect("a steward adds a member");
        teams_by_slug.insert(slug.to_string(), team);
        members.insert(slug.to_string(), who);
    }
    Estate {
        org,
        teams: teams_by_slug,
        members,
    }
}

async fn chain_types(org: OrganisationId) -> Vec<String> {
    let su = support::superuser_client_on_test_database().await;
    su.query(
        "SELECT entry_type FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1 ORDER BY seq",
        &[&org.to_string()],
    )
    .await
    .expect("chain")
    .iter()
    .map(|r| r.get(0))
    .collect()
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_steward_saves_an_order_type_matched_to_standing_teams_and_nobody_else_can() {
    let pool = support::migrated_pool().await;
    let ring = keyring(41);
    let org = an_org(&pool, &ring, 1).await;
    let steward = org.stewards[0].account;
    let mut ids = BTreeMap::new();
    for slug in &SLUGS[..4] {
        ids.insert(slug.to_string(), a_team(&pool, &ring, &org, slug).await);
    }

    // A member who is not a Steward saves nothing.
    let member = a_member(&pool, &ring, &org, "member").await;
    assert!(matches!(
        save(&pool, &ring, &org, member.account, dia(None)).await,
        Err(OrderError::Authority(AuthorityError::NotAuthorised))
    ));

    // Every slug must match a team that stands (decision 8): `field` has none yet.
    match save(&pool, &ring, &org, steward, dia(None)).await {
        Err(OrderError::Unmatched(slugs)) => assert_eq!(slugs, vec!["field".to_string()]),
        other => panic!("{:?}", other.map(|t| t.id)),
    }
    // A slug matched by hand to something that is not a team is refused the same way.
    let mut by_hand = dia(None);
    by_hand
        .teams
        .insert("field".into(), "01ARZ3NDEKTSV4RRFFQ69G5FAV".into());
    assert!(matches!(
        save(&pool, &ring, &org, steward, by_hand).await,
        Err(OrderError::Unmatched(_))
    ));
    // Matched by hand to a team with another slug, it saves.
    let mut by_hand = dia(None);
    by_hand
        .teams
        .insert("field".into(), ids["provisioning"].clone());
    let saved = save(&pool, &ring, &org, steward, by_hand)
        .await
        .expect("saves");
    assert_eq!(saved.version, 1);
    assert_eq!(saved.teams["field"], ids["provisioning"]);
    let handoff = saved.definition.jobs().find(|j| j.id == "handoff").unwrap();
    assert_eq!(handoff.team, ids["provisioning"], "installed with team ids");

    // A file the reader refuses comes back as its problems, with lines.
    let mut broken = dia(None);
    broken.source = DIA.replace("kind: choice", "kind: chioce");
    match save(&pool, &ring, &org, steward, broken).await {
        Err(OrderError::Problems(p)) => assert!(p.iter().any(|p| p.message.contains("chioce"))),
        other => panic!("{:?}", other.map(|t| t.id)),
    }
    // A shared set left out is a problem too.
    let mut no_set = dia(None);
    no_set.field_sets.clear();
    assert!(matches!(
        save(&pool, &ring, &org, steward, no_set).await,
        Err(OrderError::Problems(_))
    ));

    // A text that reads like a credential never arrives (CLAUDE.md rule 4), at a length a real
    // device takes: 12 characters, inside the 25 IOS keeps for an enable secret (Cisco
    // Community, "IOS router fails silently with passwords greater than 25", looked up
    // 2026-11-03).
    let mut secret = dia(None);
    secret.source = DIA.replace(
        "steps: [Port with a free 10G optic chosen]",
        "steps: [enable secret Rv3rside2026]",
    );
    match save(&pool, &ring, &org, steward, secret).await {
        Err(OrderError::Problems(p)) => {
            assert!(
                p.iter().any(|p| p.message.contains("password or key")),
                "{p:?}"
            )
        }
        other => panic!("{:?}", other.map(|t| t.id)),
    }

    // Saving again is a new version; the old one stays.
    let v2 = save(&pool, &ring, &org, steward, {
        let mut r = dia(Some(&saved.id));
        r.teams.insert("field".into(), ids["provisioning"].clone());
        r.source = DIA.replace("name: Dedicated Internet Access", "name: DIA circuit");
        r
    })
    .await
    .expect("a new version");
    assert_eq!((v2.id.as_str(), v2.version), (saved.id.as_str(), 2));
    let listed = as_who!(&pool, &ring, &org, member.account, |tx, auth| {
        orders::list_types(&tx, &auth).await
    })
    .expect("any member lists");
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].version, listed[0].definition.name.as_str()),
        (2, "DIA circuit")
    );

    // A version of a type that does not exist is not made.
    assert!(matches!(
        save(&pool, &ring, &org, steward, {
            let mut r = dia(Some("01ARZ3NDEKTSV4RRFFQ69G5FAV"));
            r.teams.insert("field".into(), ids["provisioning"].clone());
            r
        })
        .await,
        Err(OrderError::NotFound)
    ));

    let types = chain_types(org.id).await;
    assert_eq!(types.iter().filter(|t| *t == "order_type_saved").count(), 2);
}

#[tokio::test]
async fn an_order_moves_by_who_stands_on_its_teams_and_replays_from_its_sealed_history() {
    let pool = support::migrated_pool().await;
    let ring = keyring(42);
    let e = an_estate(&pool, &ring).await;
    let org = &e.org;
    let steward = org.stewards[0].account;
    let ty = save(&pool, &ring, org, steward, dia(None))
        .await
        .expect("saves");
    let m = |slug: &str| e.members[slug].account;

    // Any member opens one; the answers are checked by the engine.
    let outsider = a_member(&pool, &ring, org, "outsider").await;
    let mut missing = answers("10G");
    missing.remove("customer");
    assert!(
        refused(open(&pool, &ring, org, outsider.account, &ty.id, missing).await)
            .contains("Customer")
    );
    let view = open(&pool, &ring, org, m("order-desk"), &ty.id, answers("10G"))
        .await
        .expect("opens");
    let order = view.id.clone();
    assert!(view.number >= 1);
    // The W- number is the shared counter's, so no plan ever gets the same one.
    let again = open(&pool, &ring, org, outsider.account, &ty.id, answers("1G"))
        .await
        .expect("opens");
    assert_eq!(again.number, view.number + 1);

    // Someone not on the order desk can't take its job.
    let e1 = refused(
        doing(
            &pool,
            &ring,
            org,
            outsider.account,
            &order,
            "pick_up",
            &[job("check")],
        )
        .await,
    );
    assert!(!e1.is_empty());
    doing(
        &pool,
        &ring,
        org,
        m("order-desk"),
        &order,
        "pick_up",
        &[job("check")],
    )
    .await
    .expect("the desk picks it up");
    finish(&pool, &ring, org, m("order-desk"), &order, "check").await;

    // A credential typed into an answer never arrives.
    let leak = doing(
        &pool,
        &ring,
        org,
        m("network-design"),
        &order,
        "answer",
        &[
            ("field", Json::Str("circuit".into())),
            (
                "value",
                Json::Str("snmp-server community Rv3rside2026 RO".into()),
            ),
        ],
    )
    .await;
    assert!(
        matches!(leak, Err(OrderError::LooksSecret(_))),
        "{:?}",
        leak.err()
    );

    // Design: the port job asks for the edge port, and holds it.
    doing(
        &pool,
        &ring,
        org,
        m("network-design"),
        &order,
        "answer",
        &[
            ("field", Json::Str("edge_port".into())),
            (
                "value",
                Json::Obj(
                    [
                        ("design".to_string(), Json::Str("design:edge".into())),
                        ("device".to_string(), Json::Str("device:pe1".into())),
                        ("port".to_string(), Json::Str("Et49".into())),
                    ]
                    .into_iter()
                    .collect(),
                ),
            ),
        ],
    )
    .await
    .expect("network design answers its field");
    finish(&pool, &ring, org, m("network-design"), &order, "port").await;
    finish(&pool, &ring, org, m("ip-design"), &order, "addresses").await;

    // The sign-off needs approve_plans on one of the stage's teams: a plain member has none.
    let e2 = refused(
        doing(
            &pool,
            &ring,
            org,
            outsider.account,
            &order,
            "approve",
            &[("stage", Json::Str("design".into()))],
        )
        .await,
    );
    assert!(e2.contains("approve_plans"), "{e2}");
    let lead = a_member(&pool, &ring, org, "lead").await;
    make_lead(&pool, &ring, org, &e.teams["ip-design"], lead.account).await;
    doing(
        &pool,
        &ring,
        org,
        lead.account,
        &order,
        "approve",
        &[("stage", Json::Str("design".into()))],
    )
    .await
    .expect("a lead of ip-design signs it off");

    // What is stored replays to what was returned.
    let view = get(&pool, &ring, org, outsider.account, &order).await;
    let json = view.to_json().to_canonical_bytes();
    let text = String::from_utf8(json).unwrap();
    assert!(text.contains("\"status\":\"open\""), "{text}");
    assert_eq!(view.order.holds().len(), 1);
    assert_eq!(view.order.holds()[0].what.port.as_deref(), Some("Et49"));
    assert_eq!(
        view.order.job("configure").unwrap().status,
        fathom_orders::engine::JobStatus::Ready
    );

    // Cancelling the whole order is a lead's or a Steward's.
    let e3 = refused(
        doing(
            &pool,
            &ring,
            org,
            m("field"),
            &order,
            "cancel_order",
            &[("reason", Json::Str("customer withdrew".into()))],
        )
        .await,
    );
    assert!(!e3.is_empty());
    let done = doing(
        &pool,
        &ring,
        org,
        steward,
        &order,
        "cancel_order",
        &[("reason", Json::Str("customer withdrew".into()))],
    )
    .await
    .expect("a steward cancels it");
    assert_eq!(
        done.order.status(),
        fathom_orders::engine::OrderStatus::Cancelled
    );
    assert!(
        done.order.holds().is_empty(),
        "a closed order holds nothing"
    );
    let closed = as_who!(&pool, &ring, org, steward, |tx, auth| orders::list_orders(
        &tx, &auth, true, 50
    )
    .await)
    .expect("lists");
    assert_eq!(
        closed.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
        vec![order.as_str()]
    );
    assert!(matches!(
        doing(
            &pool,
            &ring,
            org,
            steward,
            &order,
            "pick_up",
            &[job("configure")]
        )
        .await,
        Err(OrderError::Refused(_))
    ));

    // Nothing anyone typed is in the clear, and each event is on the chain by its word only.
    let su = support::superuser_client_on_test_database().await;
    for (table, column) in [
        ("order_types", "ciphertext"),
        ("order_events", "ciphertext"),
    ] {
        for row in su
            .query(
                &format!("SELECT {column} FROM {table} WHERE organisation_id = $1"),
                &[&org.id.to_string()],
            )
            .await
            .unwrap()
        {
            let bytes: Vec<u8> = row.get(0);
            let lossy = String::from_utf8_lossy(&bytes);
            for marker in [
                "Riverside",
                "Okafor",
                "Et49",
                "customer withdrew",
                "Dedicated",
            ] {
                assert!(!lossy.contains(marker), "{table}: {marker}");
            }
        }
    }
    let meta: Vec<String> = su
        .query(
            "SELECT metadata FROM chain_entries \
             WHERE chain_kind = 'org' AND chain_id = $1 AND entry_type = 'order_event'",
            &[&org.id.to_string()],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| String::from_utf8_lossy(&r.get::<_, Vec<u8>>(0)).into_owned())
        .collect();
    assert!(!meta.is_empty());
    for m in &meta {
        for marker in ["Riverside", "Okafor", "Et49", "withdrew"] {
            assert!(!m.contains(marker), "chain metadata: {m}");
        }
    }

    // The history is append-only, and an order is never deleted or reopened.
    for sql in [
        "UPDATE order_events SET at = at + 1 WHERE organisation_id = $1",
        "DELETE FROM order_events WHERE organisation_id = $1",
        "DELETE FROM orders WHERE organisation_id = $1",
        "UPDATE orders SET status = 'open' WHERE organisation_id = $1",
        "UPDATE order_types SET version = version + 10 WHERE organisation_id = $1",
    ] {
        assert!(
            su.execute(sql, &[&org.id.to_string()]).await.is_err(),
            "{sql}"
        );
    }
}

#[tokio::test]
async fn another_organisation_sees_no_order_and_no_order_type() {
    let pool = support::migrated_pool().await;
    let ring = keyring(43);
    let e = an_estate(&pool, &ring).await;
    let ty = save(&pool, &ring, &e.org, e.org.stewards[0].account, dia(None))
        .await
        .expect("saves");
    let order = open(
        &pool,
        &ring,
        &e.org,
        e.members["order-desk"].account,
        &ty.id,
        answers("1G"),
    )
    .await
    .expect("opens");

    let other = an_org(&pool, &ring, 1).await;
    let them = other.stewards[0].account;
    assert!(matches!(
        as_who!(&pool, &ring, &other, them, |tx, auth| orders::get_type(
            &tx, &auth, &ty.id, None
        )
        .await),
        Err(OrderError::NotFound)
    ));
    assert!(matches!(
        as_who!(&pool, &ring, &other, them, |tx, auth| orders::get_order(
            &tx, &auth, &order.id
        )
        .await),
        Err(OrderError::NotFound)
    ));
    assert!(matches!(
        doing(
            &pool,
            &ring,
            &other,
            them,
            &order.id,
            "cancel_order",
            &[("reason", Json::Str("x".into()))]
        )
        .await,
        Err(OrderError::NotFound)
    ));
    let none = as_who!(&pool, &ring, &other, them, |tx, auth| orders::list_orders(
        &tx, &auth, false, 50
    )
    .await)
    .expect("lists");
    assert!(none.is_empty());
}

fn field<'a>(j: &'a Json, k: &str) -> &'a Json {
    match j {
        Json::Obj(m) => m.get(k).unwrap_or_else(|| panic!("no `{k}`")),
        _ => panic!("not an object"),
    }
}

/// The Steward's File tab checks as it is typed (ADR-0084 piece 5): nothing is saved, a broken
/// file comes back as its problems with lines, a good one as the board draws it with the slugs
/// it names and the teams that stand to match them to. A member who is not a Steward checks
/// nothing.
#[tokio::test]
async fn a_steward_checks_a_file_without_saving_it() {
    let pool = support::migrated_pool().await;
    let ring = keyring(44);
    let e = an_estate(&pool, &ring).await;
    let org = &e.org;
    let steward = org.stewards[0].account;
    let good = check_as(&pool, &ring, org, steward, DIA.to_string())
        .await
        .expect("checks");
    assert_eq!(field(&good, "problems"), &Json::Arr(vec![]));
    let def = field(&good, "definition");
    assert_eq!(
        field(def, "name"),
        &Json::Str("Dedicated Internet Access".into())
    );
    let Json::Arr(lanes) = field(def, "lanes") else {
        panic!()
    };
    let Json::Arr(stages) = field(&lanes[0], "stages") else {
        panic!()
    };
    assert_eq!(field(&stages[0], "id"), &Json::Str("order".into()));
    let Json::Arr(slugs) = field(&good, "slugs") else {
        panic!()
    };
    assert_eq!(slugs.len(), SLUGS.len());
    let Json::Obj(teams) = field(&good, "teams") else {
        panic!()
    };
    assert_eq!(
        field(&teams[&e.teams["field"]], "slug"),
        &Json::Str("field".into())
    );

    let broken = check_as(
        &pool,
        &ring,
        org,
        steward,
        DIA.replace("kind: choice", "kind: chioce"),
    )
    .await
    .expect("answers with problems");
    assert_eq!(field(&broken, "definition"), &Json::Null);
    let Json::Arr(problems) = field(&broken, "problems") else {
        panic!()
    };
    assert!(problems
        .iter()
        .any(|p| matches!(field(p, "message"), Json::Str(m) if m.contains("chioce"))));
    assert!(matches!(field(&problems[0], "line"), Json::Int(n) if *n > 1));

    // Nothing was saved by either.
    let types = as_who!(&pool, &ring, org, steward, |tx, auth| orders::list_types(
        &tx, &auth
    )
    .await)
    .expect("lists");
    assert!(types.is_empty());

    let member = e.members["field"].account;
    assert!(matches!(
        check_as(&pool, &ring, org, member, DIA.to_string()).await,
        Err(OrderError::Authority(AuthorityError::NotAuthorised))
    ));
}

/// The order page is told what it needs to offer only what the engine would take: the
/// definition as asked, the caller's standing on the order's teams, and the names of the people
/// and teams in it.
#[tokio::test]
async fn the_order_page_is_told_who_may_do_what() {
    let pool = support::migrated_pool().await;
    let ring = keyring(45);
    let e = an_estate(&pool, &ring).await;
    let org = &e.org;
    let steward = org.stewards[0].account;
    let ty = save(&pool, &ring, org, steward, dia(None))
        .await
        .expect("saves");
    let desk = e.members["order-desk"].account;
    let view = open(&pool, &ring, org, desk, &ty.id, answers("10G"))
        .await
        .expect("opens");
    let as_desk = described_as(&pool, &ring, org, desk, &view.id).await;
    let you = field(&as_desk, "you");
    assert_eq!(field(you, "account"), &Json::Str(desk.to_string()));
    assert_eq!(field(you, "steward"), &Json::Bool(false));
    let Json::Obj(standing) = field(you, "teams") else {
        panic!()
    };
    assert_eq!(
        field(&standing[&e.teams["order-desk"]], "on"),
        &Json::Bool(true)
    );
    assert_eq!(
        field(&standing[&e.teams["field"]], "on"),
        &Json::Bool(false)
    );
    let Json::Obj(people) = field(&as_desk, "people") else {
        panic!()
    };
    assert_eq!(people[&desk.to_string()], Json::Str("order-desk".into()));
    let Json::Obj(teams) = field(&as_desk, "teams") else {
        panic!()
    };
    assert_eq!(
        field(&teams[&e.teams["ip-design"]], "slug"),
        &Json::Str("ip-design".into())
    );
    let Json::Arr(fields) = field(field(&as_desk, "definition"), "fields") else {
        panic!()
    };
    assert!(fields
        .iter()
        .any(|f| field(f, "key") == &Json::Str("bandwidth".into())));

    let as_steward = described_as(&pool, &ring, org, steward, &view.id).await;
    assert_eq!(
        field(field(&as_steward, "you"), "steward"),
        &Json::Bool(true)
    );
}

async fn check_as(
    pool: &Pool,
    ring: &KeyRing,
    org: &Org,
    who: AccountId,
    source: String,
) -> Result<Json, OrderError> {
    as_who!(pool, ring, org, who, |tx, auth| orders::check_type(
        &tx,
        &auth,
        &source,
        &[CUSTOMER.to_string()]
    )
    .await)
}

async fn described_as(pool: &Pool, ring: &KeyRing, org: &Org, who: AccountId, id: &str) -> Json {
    as_who!(pool, ring, org, who, |tx, auth| async {
        let v = orders::get_order(&tx, &auth, id).await?;
        orders::describe(&tx, &auth, &v).await
    }
    .await)
    .expect("describes")
}

#[tokio::test]
async fn an_overdue_rule_is_carried_out_by_the_engine_when_the_order_is_next_looked_at() {
    let pool = support::migrated_pool().await;
    let ring = keyring(46);
    let e = an_estate(&pool, &ring).await;
    let org = &e.org;
    let steward = org.stewards[0].account;
    // DIA's "Check the order" escalates as soon as it is overdue and goes back to the queue two
    // days later. Made due at once here, both rules at once, so the test needn't wait.
    let source = DIA.replace("due: 1d", "due: 0m").replace(
        "{ after: 2d, reassign: team }",
        "{ after: 0m, reassign: team }",
    );
    assert_ne!(source, DIA);
    let req = TypeRequest {
        source,
        ..dia(None)
    };
    let ty = save(&pool, &ring, org, steward, req).await.expect("saves");
    let desk = e.members["order-desk"].account;
    let view = open(&pool, &ring, org, desk, &ty.id, answers("10G"))
        .await
        .expect("opens");
    // Opening stores only the opening; the clock is checked when the order is next read.
    assert_eq!(view.order.events().len(), 1);

    let seen = get(&pool, &ring, org, desk, &view.id).await;
    let st = seen.order.job("check").unwrap();
    assert_eq!(st.escalated.as_deref(), Some("lead"));
    assert_eq!(st.fired.iter().copied().collect::<Vec<_>>(), vec![0, 1]);
    let moves: Vec<(&Actor, &Action)> = seen
        .order
        .events()
        .iter()
        .skip(1)
        .map(|ev| (&ev.by, &ev.action))
        .collect();
    assert_eq!(
        moves,
        vec![
            (
                &Actor::Engine,
                &Action::Overdue {
                    job: "check".into(),
                    rule: 0
                }
            ),
            (
                &Actor::Engine,
                &Action::Overdue {
                    job: "check".into(),
                    rule: 1
                }
            ),
        ]
    );

    // They were stored and sealed: reading again replays them and fires nothing new.
    let again = get(&pool, &ring, org, desk, &view.id).await;
    assert_eq!(again.order.events().len(), 3);
    // And the history says them in the order's JSON.
    let Json::Obj(m) = again.to_json() else {
        panic!()
    };
    let Json::Arr(history) = &m["history"] else {
        panic!()
    };
    assert_eq!(field(&history[1], "action"), &Json::Str("overdue".into()));

    // Someone on the team still picks it up and finishes it as before.
    doing(
        &pool,
        &ring,
        org,
        desk,
        &view.id,
        "pick_up",
        &[job("check")],
    )
    .await
    .expect("picks up");
}
