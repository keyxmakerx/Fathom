//! The IP plan store (ADR-0083, `src/ipam.rs` and `migrations/0065_ipam.sql`) against a real
//! PostgreSQL.
//!
//! **Each test's name is its claim** (CLAUDE.md rule 2): two allocations of the same size from
//! one parent at the same moment get different blocks; the same allocation key gives the same
//! block back and is refused from another parent; a VRF that enforces unique space refuses a
//! duplicate in the database; who may see, plan and release follows the folder grants; and
//! nothing readable reaches the table.

mod support;

use std::sync::Arc;

use deadpool_postgres::{Pool, Transaction};
use fathom_canon::Json;

use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::crypto::Key32;
use fathom_server::grants::{
    self, Authority, AuthorityError, EpochWatch, GenesisGrant, GrantRequest,
};
use fathom_server::ipam::{self, Answer, Ask, Fields, IpamError, IpamKeys, Kind, Record, Want};
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId};

const MASTER: [u8; 32] = [21; 32];

fn ring() -> Arc<KeyRing> {
    Arc::new(KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    ))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
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

struct Estate {
    organisation: OrganisationId,
    steward: Person,
}

async fn an_account(pool: &Pool, name: &str) -> Person {
    let account = repo::create_account(pool, &unique(name), name)
        .await
        .expect("create account")
        .id;
    Person {
        account,
        key: SoftwareKey::random().unwrap(),
    }
}

async fn with_auth<T, F>(
    pool: &Pool,
    ring: &KeyRing,
    organisation: OrganisationId,
    who: AccountId,
    f: F,
) -> T
where
    F: for<'a> FnOnce(
        &'a Transaction<'a>,
        &'a Authority<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = T> + 'a>>,
{
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, organisation, who)
        .await
        .expect("tenant context");
    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.expect("tenant key");
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let out = f(&tx, &auth).await;
    tx.commit().await.expect("commit");
    out
}

async fn bootstrap(pool: &Pool, ring: &KeyRing) -> Estate {
    let root = SoftwareKey::random().unwrap();
    let salt = [0x7du8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());
    let steward = an_account(pool, "steward").await;
    let now = now_unix();
    let subject_key_fpr = authority::key_fingerprint(&steward.key.public_key());
    let facts = GrantFacts {
        organisation: &organisation_id,
        root_pubkey_fpr: &root_fpr,
        scope: "",
        subject: &steward.account.to_string(),
        subject_key_fpr: &subject_key_fpr,
        capability: Capability::Steward,
        granter: None,
        granter_key_fpr: &root_fpr,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        sole_steward_appointment: false,
        auth_epoch: 1,
    };
    let request = GenesisGrant {
        subject: steward.account,
        subject_key_fpr,
        capability: Capability::Steward,
        effective_from_unix: now,
        expires_at_unix: now + 365 * 24 * 3600,
        signature: root.sign(&authority::grant_bytes(&facts)),
    };
    let mut client = pool.get().await.unwrap();
    let tx = client.transaction().await.unwrap();
    let genesis = grants::bootstrap_organisation(
        &tx,
        ring,
        steward.account,
        &unique("Org"),
        &root.public_key(),
        &salt,
        &[request],
    )
    .await
    .expect("genesis");
    tx.commit().await.unwrap();
    enrol_account_key(pool, ring, genesis.organisation, &steward).await;
    Estate {
        organisation: genesis.organisation,
        steward,
    }
}

async fn enrol_account_key(pool: &Pool, ring: &KeyRing, organisation: OrganisationId, p: &Person) {
    let public = p.key.public_key();
    with_auth(pool, ring, organisation, p.account, |tx, auth| {
        Box::pin(async move {
            grants::enrol_software_key(tx, auth, &public)
                .await
                .expect("enrol");
        })
    })
    .await;
}

async fn a_member(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    name: &str,
    capability: Option<Capability>,
) -> Person {
    let person = an_account(pool, name).await;
    repo::add_member(
        pool,
        estate.organisation,
        estate.steward.account,
        person.account,
        repo::Role::Member,
    )
    .await
    .expect("membership");
    enrol_account_key(pool, ring, estate.organisation, &person).await;
    if let Some(capability) = capability {
        let subject = person.account;
        let mut client = pool.get().await.unwrap();
        let tx = client.transaction().await.unwrap();
        let ctx = repo::open_tenant_context(&tx, estate.organisation, estate.steward.account)
            .await
            .unwrap();
        let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.unwrap();
        let watch = EpochWatch::new();
        let auth = Authority {
            ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let proposal = grants::propose_grant(
            &tx,
            &auth,
            &GrantRequest {
                scope: None,
                subject,
                capability,
                expires_at_unix: now_unix() + 30 * 24 * 3600,
            },
        )
        .await
        .expect("proposed");
        let signature = estate.steward.key.sign(&proposal.bytes);
        grants::sign_grant(&tx, &auth, &proposal, &signature)
            .await
            .expect("signed");
        tx.commit().await.unwrap();
    }
    person
}

fn s(v: &str) -> Json {
    Json::Str(v.into())
}

fn fields(pairs: &[(&str, Json)]) -> Fields {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

async fn as_who<T, F>(
    pool: &Pool,
    ring: &KeyRing,
    organisation: OrganisationId,
    who: AccountId,
    act: F,
) -> T
where
    F: for<'a> FnOnce(
        &'a Transaction<'a>,
        &'a Authority<'a>,
        &'a IpamKeys,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = T> + 'a>>,
{
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, organisation, who)
        .await
        .expect("tenant context");
    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.expect("tenant key");
    let keys = IpamKeys::derive(&tenant_key, &organisation.to_string());
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let out = act(&tx, &auth, &keys).await;
    tx.commit().await.expect("commit");
    out
}

async fn make(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    who: AccountId,
    kind: Kind,
    f: Fields,
) -> Result<Record, IpamError> {
    as_who(
        pool,
        ring,
        estate.organisation,
        who,
        move |tx, auth, keys| {
            Box::pin(async move { ipam::create(tx, auth, keys, kind, &f, &ipam::today()).await })
        },
    )
    .await
}

async fn take(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    who: AccountId,
    parent: &str,
    want: Want,
    key: &str,
) -> Result<Answer, IpamError> {
    let ask = Ask {
        parent: parent.to_string(),
        want,
        key: Some(key.to_string()),
        hold: fields(&[
            ("reason", s("WAN for the new branch")),
            ("work", s("W-1042")),
        ]),
    };
    as_who(
        pool,
        ring,
        estate.organisation,
        who,
        move |tx, auth, keys| {
            Box::pin(
                async move { ipam::allocate(tx, auth, keys, &ask, true, &ipam::today()).await },
            )
        },
    )
    .await
}

fn prefix_fields(prefix: &str, vrf: Option<&str>) -> Fields {
    let mut f = fields(&[
        ("prefix", s(prefix)),
        ("status", s("container")),
        ("is_pool", Json::Bool(false)),
        ("mark_utilised", Json::Bool(false)),
    ]);
    if let Some(v) = vrf {
        f.insert("vrf".into(), s(v));
    }
    f
}

fn taken_prefix(answer: &Answer) -> (String, bool) {
    match answer {
        Answer::Taken { record, again } => match record.fields.get("prefix") {
            Some(Json::Str(p)) => (p.clone(), *again),
            other => panic!("no prefix on the reservation: {other:?}"),
        },
        Answer::Free(_) => panic!("a take answered a look"),
    }
}

#[tokio::test]
async fn two_allocations_at_once_get_different_blocks_and_a_repeated_key_gets_the_same_one() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let steward = estate.steward.account;
    let parent = make(
        &pool,
        &ring,
        &estate,
        steward,
        Kind::Prefix,
        prefix_fields("192.0.2.0/24", None),
    )
    .await
    .expect("the parent");

    // Two at the same moment, each on its own connection and transaction.
    let (a, b) = tokio::join!(
        take(
            &pool,
            &ring,
            &estate,
            steward,
            &parent.id,
            Want::Prefix(29),
            "W-1/wan"
        ),
        take(
            &pool,
            &ring,
            &estate,
            steward,
            &parent.id,
            Want::Prefix(29),
            "W-2/wan"
        ),
    );
    let (a, again_a) = taken_prefix(&a.expect("first"));
    let (b, again_b) = taken_prefix(&b.expect("second"));
    assert!(!again_a && !again_b);
    assert_ne!(a, b, "two requests at once were handed the same block");
    let mut both = [a.clone(), b.clone()];
    both.sort();
    assert_eq!(
        both,
        ["192.0.2.0/29".to_string(), "192.0.2.8/29".to_string()]
    );

    // The same key again: the same block, marked as given before.
    let again = take(
        &pool,
        &ring,
        &estate,
        steward,
        &parent.id,
        Want::Prefix(29),
        "W-1/wan",
    )
    .await
    .expect("repeat");
    assert_eq!(taken_prefix(&again), (a.clone(), true));

    // The same key from another parent: refused.
    let other = make(
        &pool,
        &ring,
        &estate,
        steward,
        Kind::Prefix,
        prefix_fields("198.51.100.0/24", None),
    )
    .await
    .expect("another parent");
    let elsewhere = take(
        &pool,
        &ring,
        &estate,
        steward,
        &other.id,
        Want::Prefix(29),
        "W-1/wan",
    )
    .await;
    assert!(
        matches!(elsewhere, Err(IpamError::KeyUsedElsewhere)),
        "{elsewhere:?}"
    );

    // An address next: the first usable one, not the network address, and not inside a held /29.
    let address = take(
        &pool,
        &ring,
        &estate,
        steward,
        &parent.id,
        Want::Address,
        "W-3/lo0",
    )
    .await
    .expect("an address");
    match address {
        Answer::Taken { record, .. } => {
            assert_eq!(record.fields.get("address"), Some(&s("192.0.2.16")));
            assert_eq!(record.fields.get("parent"), Some(&s(&parent.id)));
            assert_eq!(record.fields.get("work"), Some(&s("W-1042")));
            assert!(
                record.fields.contains_key("ends"),
                "a default end is filled in"
            );
        }
        Answer::Free(_) => panic!("a take answered a look"),
    }
}

#[tokio::test]
async fn a_vrf_that_enforces_unique_space_refuses_a_duplicate_and_the_global_table_does_not() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let steward = estate.steward.account;
    let vrf = make(
        &pool,
        &ring,
        &estate,
        steward,
        Kind::Vrf,
        fields(&[
            ("name", s("CUSTOMER-A")),
            ("enforce_unique", Json::Bool(true)),
        ]),
    )
    .await
    .expect("vrf");
    make(
        &pool,
        &ring,
        &estate,
        steward,
        Kind::Prefix,
        prefix_fields("10.1.0.0/16", Some(&vrf.id)),
    )
    .await
    .expect("first");
    let second = make(
        &pool,
        &ring,
        &estate,
        steward,
        Kind::Prefix,
        prefix_fields("10.1.0.0/16", Some(&vrf.id)),
    )
    .await;
    assert!(matches!(second, Err(IpamError::Clash)), "{second:?}");

    // The global table keeps NetBox's default: duplicates are allowed.
    make(
        &pool,
        &ring,
        &estate,
        steward,
        Kind::Prefix,
        prefix_fields("10.1.0.0/16", None),
    )
    .await
    .expect("global one");
    make(
        &pool,
        &ring,
        &estate,
        steward,
        Kind::Prefix,
        prefix_fields("10.1.0.0/16", None),
    )
    .await
    .expect("global two");

    // Two VRFs with the same name: refused.
    let twin = make(
        &pool,
        &ring,
        &estate,
        steward,
        Kind::Vrf,
        fields(&[
            ("name", s("CUSTOMER-A")),
            ("enforce_unique", Json::Bool(false)),
        ]),
    )
    .await;
    assert!(matches!(twin, Err(IpamError::Invalid(_))), "{twin:?}");

    // A VRF its prefixes still name cannot be deleted.
    let gone = as_who(&pool, &ring, estate.organisation, steward, {
        let id = vrf.id.clone();
        move |tx, auth, keys| Box::pin(async move { ipam::delete(tx, auth, keys, &id).await })
    })
    .await;
    assert!(matches!(gone, Err(IpamError::InUse(_))), "{gone:?}");
}

#[tokio::test]
async fn reading_planning_and_releasing_follow_the_grants() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let steward = estate.steward.account;
    let reader = a_member(&pool, &ring, &estate, "reader", Some(Capability::Read)).await;
    let drawer = a_member(&pool, &ring, &estate, "drawer", Some(Capability::Draw)).await;
    let other_drawer = a_member(&pool, &ring, &estate, "other", Some(Capability::Draw)).await;
    let nobody = a_member(&pool, &ring, &estate, "nobody", None).await;

    // Aggregates are a steward's: a drawer may not make one.
    let agg = fields(&[("prefix", s("203.0.113.0/24")), ("rir", s("documentation"))]);
    let refused = make(
        &pool,
        &ring,
        &estate,
        drawer.account,
        Kind::Aggregate,
        agg.clone(),
    )
    .await;
    assert!(
        matches!(
            refused,
            Err(IpamError::Authority(AuthorityError::NotAuthorised))
        ),
        "{refused:?}"
    );
    make(&pool, &ring, &estate, steward, Kind::Aggregate, agg)
        .await
        .expect("aggregate");

    // A drawer plans a prefix; a reader may not.
    let p = prefix_fields("203.0.113.0/25", None);
    let refused = make(
        &pool,
        &ring,
        &estate,
        reader.account,
        Kind::Prefix,
        p.clone(),
    )
    .await;
    assert!(
        matches!(refused, Err(IpamError::Authority(_))),
        "{refused:?}"
    );
    let prefix = make(&pool, &ring, &estate, drawer.account, Kind::Prefix, p)
        .await
        .expect("prefix");

    // The drawer reserves an address with no work named: they hold it themselves.
    let held = make(
        &pool,
        &ring,
        &estate,
        drawer.account,
        Kind::Reservation,
        fields(&[("address", s("203.0.113.10")), ("reason", s("new printer"))]),
    )
    .await
    .expect("reservation");
    assert_eq!(
        held.fields.get("holder"),
        Some(&s(&drawer.account.to_string()))
    );

    // The reader sees all three; someone with no grant sees nothing.
    let list = |who: AccountId| {
        let pool = pool.clone();
        let ring = ring.clone();
        let org = estate.organisation;
        async move {
            as_who(&pool, &ring, org, who, |tx, auth, keys| {
                Box::pin(async move { ipam::list(tx, auth, keys, None, None).await })
            })
            .await
            .expect("list")
        }
    };
    assert_eq!(list(reader.account).await.len(), 3);
    assert!(list(nobody.account).await.is_empty());

    // Another drawer may not release it; the steward may.
    let release = |who: AccountId| {
        let pool = pool.clone();
        let ring = ring.clone();
        let org = estate.organisation;
        let id = held.id.clone();
        async move {
            as_who(&pool, &ring, org, who, move |tx, auth, keys| {
                Box::pin(async move { ipam::delete(tx, auth, keys, &id).await })
            })
            .await
        }
    };
    let refused = release(other_drawer.account).await;
    assert!(
        matches!(refused, Err(IpamError::Authority(_))),
        "{refused:?}"
    );
    release(steward).await.expect("the steward releases it");

    // A stale update is refused; the current version goes through.
    let stale = as_who(&pool, &ring, estate.organisation, drawer.account, {
        let id = prefix.id.clone();
        move |tx, auth, keys| {
            Box::pin(async move {
                let mut f = prefix_fields("203.0.113.0/25", None);
                f.insert("role".into(), s("printers"));
                ipam::update(tx, auth, keys, &id, 7, &f).await
            })
        }
    })
    .await;
    assert!(matches!(stale, Err(IpamError::Stale)), "{stale:?}");
    let changed = as_who(&pool, &ring, estate.organisation, drawer.account, {
        let id = prefix.id.clone();
        move |tx, auth, keys| {
            Box::pin(async move {
                let mut f = prefix_fields("203.0.113.0/25", None);
                f.insert("role".into(), s("printers"));
                ipam::update(tx, auth, keys, &id, 1, &f).await
            })
        }
    })
    .await
    .expect("update");
    assert_eq!(changed.version, 2);
}

#[tokio::test]
async fn nothing_readable_reaches_the_table() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let steward = estate.steward.account;
    let mut f = prefix_fields("100.64.12.0/22", None);
    f.insert("note".into(), s("Branch office uplinks"));
    let record = make(&pool, &ring, &estate, steward, Kind::Prefix, f)
        .await
        .expect("prefix");

    let sealed: Vec<u8> = with_auth(&pool, &ring, estate.organisation, steward, |tx, _| {
        let id = record.id.clone();
        Box::pin(async move {
            tx.query_one("SELECT sealed FROM ipam_records WHERE id = $1", &[&id])
                .await
                .expect("row")
                .get(0)
        })
    })
    .await;
    let as_text = String::from_utf8_lossy(&sealed);
    assert!(!as_text.contains("100.64.12.0"));
    assert!(!as_text.contains("Branch office"));
}
