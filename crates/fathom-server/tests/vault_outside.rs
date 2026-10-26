//! Outside vaults — the vault's Mode C, `src/vault_outside/` and
//! `migrations/0045_vault_outside.sql` — against a real PostgreSQL and a stand-in Vaultwarden.
//!
//! ADR-0071 part four is the rule: a member connects their own outside vault, and what is
//! pulled through it is theirs; every admin sees every connection, disconnects any, and removes
//! any pulled login, and an admin's removal is the one its owner cannot undo. Every read checks
//! the account again (role User, exactly the one collection, nothing personal), a failed check
//! stops the connection on the organisation's history, and Fathom reads a password only for a
//! device the login is marked on, for someone who may draw there, after filing the read.
//!
//! The stand-in answers the two calls Fathom makes with values sealed exactly as Bitwarden
//! clients seal them (`bitwarden::seal_type2`, pinned to the SDK's own vector).
//!
//! **Each test's name is its claim** (CLAUDE.md rule 2).

mod support;

use std::sync::{Arc, Mutex};

use deadpool_postgres::{Pool, Transaction};

use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::crypto::Key32;
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant, GrantRequest};
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId, ScopeKind};
use fathom_server::vault::VaultError;
use fathom_server::vault_fathom::FathomKey;
use fathom_server::vault_outside::bitwarden::{seal_type2, BwKey};
use fathom_server::vault_outside::vaultwarden::SyncAnswer;
use fathom_server::vault_outside::{
    self as outside, ConnectIn, HttpAnswer, HttpRequest, Net, NetFuture, Outside, OutsideUrl, Why,
};

const MASTER: [u8; 32] = [21; 32];

fn ring() -> Arc<KeyRing> {
    Arc::new(KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    ))
}

fn fathom_key() -> Arc<FathomKey> {
    Arc::new(FathomKey::from_key(Key32::from_bytes([31; 32])))
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
    let salt = [0x6cu8; 16];
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

async fn a_design(pool: &Pool, estate: &Estate) -> String {
    let scope = repo::create_scope(
        pool,
        estate.organisation,
        estate.steward.account,
        None,
        ScopeKind::Network,
        "net",
    )
    .await
    .expect("scope");
    fathom_server::designs::create_design(
        pool,
        estate.organisation,
        estate.steward.account,
        scope.id,
    )
    .await
    .expect("design")
    .to_string()
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
// A stand-in Vaultwarden
// ---------------------------------------------------------------------------

const CLIENT_ID: &str = "user.6f1c2a8e-4b1d-4c8e-9a51-2f0e7d3b9c10";
const SECRET: &str = "Zq8wR2mT5vK1xN7pL4sH9dF3gJ6bC0";
const COLLECTION: &str = "fathom-lab";
const ORG_KEY: [u8; 64] = [5; 64];
const ITEM_KEY: [u8; 64] = [8; 64];

fn org_key() -> BwKey {
    BwKey::from_slice(&ORG_KEY).unwrap()
}

fn seal(text: &str, key: &[u8; 64], iv: u8) -> String {
    seal_type2(text.as_bytes(), &BwKey::from_slice(key).unwrap(), &[iv; 16])
}

/// What the stand-in account looks like; a test changes it between rounds.
struct Account {
    role: i64,
    extra_collection: bool,
    personal_item: bool,
    refuse_key: bool,
    hide_password: bool,
}

impl Account {
    fn sound() -> Self {
        Self {
            role: 2,
            extra_collection: false,
            personal_item: false,
            refuse_key: false,
            hide_password: false,
        }
    }

    fn sync(&self) -> String {
        let mut collections = vec![format!(
            r#"{{"id":"col1","organizationId":"org1","name":"{}"}}"#,
            seal(COLLECTION, &ORG_KEY, 1)
        )];
        if self.extra_collection {
            collections.push(format!(
                r#"{{"id":"col2","organizationId":"org1","name":"{}"}}"#,
                seal("everything", &ORG_KEY, 2)
            ));
        }
        let mut ciphers = vec![
            // Fields sealed under the organisation key.
            format!(
                r#"{{"id":"c1","type":1,"organizationId":"org1","collectionIds":["col1"],"key":null,
                    "name":"{}","deletedDate":null,"viewPassword":{},
                    "login":{{"username":"{}","password":"{}","uris":[]}}}}"#,
                seal("core-sw1 admin", &ORG_KEY, 3),
                !self.hide_password,
                seal("admin", &ORG_KEY, 4),
                seal("s3cret!", &ORG_KEY, 5)
            ),
            // An item with its own key, sealed under the organisation key.
            format!(
                r#"{{"id":"c2","type":1,"organizationId":"org1","collectionIds":["col1"],
                    "key":"{}","name":"{}","deletedDate":null,"viewPassword":true,
                    "login":{{"username":"{}","password":"{}","uris":[]}}}}"#,
                seal_type2(&ITEM_KEY, &org_key(), &[6; 16]),
                seal("edge-fw1 admin", &ITEM_KEY, 7),
                seal("netops", &ITEM_KEY, 8),
                seal("k3y-own", &ITEM_KEY, 9)
            ),
        ];
        if self.personal_item {
            ciphers.push(
                r#"{"id":"p1","type":1,"organizationId":null,"collectionIds":[],"key":null,
                    "name":"2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                    "deletedDate":"2026-10-01T00:00:00Z","login":null}"#
                    .to_string(),
            );
        }
        format!(
            r#"{{"object":"sync","profile":{{"organizations":[{{"id":"org1","name":"Lab","type":{},"status":2,"key":"4.AAAA"}}]}},
               "collections":[{}],"ciphers":[{}],"folders":[],"sends":[]}}"#,
            self.role,
            collections.join(","),
            ciphers.join(",")
        )
    }
}

struct StandIn(Arc<Mutex<Account>>);

impl Net for StandIn {
    fn send(&self, req: HttpRequest) -> NetFuture<'_> {
        let a = self.0.lock().unwrap();
        let answer = match (req.method, req.path.as_str()) {
            ("POST", "/identity/connect/token") => {
                let body = String::from_utf8(req.body).unwrap();
                let ok = !a.refuse_key
                    && body.contains("grant_type=client_credentials")
                    && body.contains(&format!("client_secret={SECRET}"));
                if ok {
                    HttpAnswer {
                        status: 200,
                        body: br#"{"access_token":"tok","token_type":"Bearer","Key":"2.a|b|c","PrivateKey":"2.a|b|c","Kdf":0,"KdfIterations":600000}"#.to_vec(),
                    }
                } else {
                    HttpAnswer {
                        status: 400,
                        body: br#"{"error":"invalid_client"}"#.to_vec(),
                    }
                }
            }
            ("GET", "/api/sync?excludeDomains=true") => HttpAnswer {
                status: if req
                    .headers
                    .iter()
                    .any(|(k, v)| *k == "Authorization" && v == "Bearer tok")
                {
                    200
                } else {
                    401
                },
                body: a.sync().into_bytes(),
            },
            _ => HttpAnswer {
                status: 404,
                body: Vec::new(),
            },
        };
        Box::pin(async move { Ok(answer) })
    }
}

struct Vault {
    account: Arc<Mutex<Account>>,
    outside: Arc<Outside>,
    url: OutsideUrl,
}

fn a_vault() -> Vault {
    let account = Arc::new(Mutex::new(Account::sound()));
    Vault {
        outside: Arc::new(Outside {
            net: Box::new(StandIn(account.clone())),
            allowed_hosts: None,
        }),
        account,
        url: OutsideUrl::parse("https://vault.example.test").unwrap(),
    }
}

impl Vault {
    fn set(&self, f: impl FnOnce(&mut Account)) {
        f(&mut self.account.lock().unwrap());
    }

    async fn read(&self, device: &str) -> Result<SyncAnswer, VaultError> {
        outside::vw_read(&self.outside, &self.url, CLIENT_ID, SECRET, device)
            .await
            .map(|(_, s)| s)
    }
}

// ---------------------------------------------------------------------------
// The acts, each in its own transaction as the routes run them
// ---------------------------------------------------------------------------

struct World {
    pool: Pool,
    ring: Arc<KeyRing>,
    fk: Arc<FathomKey>,
    org: OrganisationId,
}

impl World {
    async fn connect(
        &self,
        v: &Vault,
        who: AccountId,
        key: [u8; 64],
        name: &str,
    ) -> Result<outside::ConnectionView, VaultError> {
        let device = outside::new_device_id().unwrap();
        let sync = v.read(&device).await?;
        let fk = self.fk.clone();
        let input = ConnectIn {
            url: v.url.clone(),
            client_id: CLIENT_ID.to_string(),
            client_secret: SECRET.to_string(),
            device_id: device,
            collection_id: "col1".to_string(),
            collection_name: name.to_string(),
            org_key: BwKey::from_slice(&key).unwrap(),
        };
        with_auth(&self.pool, &self.ring, self.org, who, move |tx, auth| {
            Box::pin(async move { outside::connect(tx, auth, &fk, input, &sync).await })
        })
        .await
    }

    async fn plan(
        &self,
        who: AccountId,
        connection: &str,
        why: Why,
    ) -> Result<outside::Plan, VaultError> {
        let fk = self.fk.clone();
        let c = connection.to_string();
        with_auth(&self.pool, &self.ring, self.org, who, move |tx, auth| {
            Box::pin(async move { outside::plan(tx, auth, &fk, &c, why).await })
        })
        .await
    }

    /// "Check now": plan, the network round, then the outcome, committed either way.
    async fn check(
        &self,
        v: &Vault,
        who: AccountId,
        connection: &str,
    ) -> Result<Result<outside::Checked, VaultError>, VaultError> {
        let plan = self.plan(who, connection, Why::Check).await?;
        let read = v.read(&plan.device_id).await;
        let fk = self.fk.clone();
        with_auth(&self.pool, &self.ring, self.org, who, move |tx, auth| {
            Box::pin(async move { outside::after_check(tx, auth, &fk, &plan, read).await })
        })
        .await
    }

    async fn pull(
        &self,
        v: &Vault,
        who: AccountId,
        connection: &str,
        cipher: &str,
        used_on: Vec<(String, String)>,
    ) -> Result<Result<outside::ConnectionView, VaultError>, VaultError> {
        let plan = self.plan(who, connection, Why::Pull).await?;
        let sync = v.read(&plan.device_id).await?;
        let fk = self.fk.clone();
        let cipher = cipher.to_string();
        with_auth(&self.pool, &self.ring, self.org, who, move |tx, auth| {
            Box::pin(async move {
                outside::pull(tx, auth, &fk, &plan, &sync, &cipher, "login", used_on).await
            })
        })
        .await
    }

    async fn item_act(
        &self,
        who: AccountId,
        act: &'static str,
        id: &str,
    ) -> Result<outside::ConnectionView, VaultError> {
        let fk = self.fk.clone();
        let id = id.to_string();
        with_auth(&self.pool, &self.ring, self.org, who, move |tx, auth| {
            Box::pin(async move {
                match act {
                    "remove" => outside::remove(tx, auth, &fk, &id).await,
                    "restore" => outside::restore(tx, auth, &fk, &id).await,
                    "disconnect" => outside::disconnect(tx, auth, &fk, &id).await,
                    _ => unreachable!(),
                }
            })
        })
        .await
    }

    async fn state_of(&self, who: AccountId, connection: &str) -> String {
        let l = self.list(who).await;
        l.into_iter().find(|x| x.id == connection).unwrap().state
    }

    async fn list(&self, who: AccountId) -> Vec<outside::ConnectionView> {
        let fk = self.fk.clone();
        with_auth(&self.pool, &self.ring, self.org, who, move |tx, auth| {
            Box::pin(async move { outside::list(tx, auth, &fk).await.expect("list") })
        })
        .await
    }

    /// Fathom using a pulled login: plan, the network round, then file the read and open it.
    async fn use_it(
        &self,
        v: &Vault,
        who: AccountId,
        item: &str,
        design: &str,
        element: &str,
    ) -> Result<(String, String), VaultError> {
        let fk = self.fk.clone();
        let (i, d, e) = (item.to_string(), design.to_string(), element.to_string());
        let up = with_auth(&self.pool, &self.ring, self.org, who, move |tx, auth| {
            Box::pin(
                async move { outside::use_plan(tx, auth, &fk, &i, &d, &e, "autopopulate").await },
            )
        })
        .await?;
        let read = v.read(&up.plan.device_id).await;
        let fk = self.fk.clone();
        let used = with_auth(&self.pool, &self.ring, self.org, who, move |tx, auth| {
            Box::pin(async move { outside::use_finish(tx, auth, &fk, &up, read).await })
        })
        .await??;
        Ok((used.user.clone(), used.password.clone()))
    }
}

async fn a_world() -> (World, Estate) {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    (
        World {
            pool,
            ring,
            fk: fathom_key(),
            org: estate.organisation,
        },
        estate,
    )
}

fn on(design: &str, element: &str) -> Vec<(String, String)> {
    vec![(design.to_string(), element.to_string())]
}

fn count(types: &[String], t: &str) -> usize {
    types.iter().filter(|x| *x == t).count()
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_member_connects_their_own_vault_and_fathom_reads_a_login_only_where_it_is_marked() {
    let (w, estate) = a_world().await;
    let alice = a_member(&w.pool, &w.ring, &estate, "alice", Some(Capability::Draw)).await;
    let bob = a_member(&w.pool, &w.ring, &estate, "bob", None).await;
    let design = a_design(&w.pool, &estate).await;
    let v = a_vault();

    let c = w
        .connect(&v, alice.account, ORG_KEY, COLLECTION)
        .await
        .expect("connects");
    assert_eq!(
        (c.state.as_str(), c.owner.as_str()),
        ("on", alice.account.to_string().as_str())
    );
    assert_eq!(c.collection_name, COLLECTION);

    // Per person: bob sees nothing of it and can neither check nor pull; every admin sees it.
    assert!(w.list(bob.account).await.is_empty());
    assert_eq!(w.list(estate.steward.account).await.len(), 1);
    assert!(matches!(
        w.plan(bob.account, &c.id, Why::Check).await,
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        w.plan(bob.account, &c.id, Why::Pull).await,
        Err(VaultError::NotAllowed(_))
    ));
    assert!(
        matches!(
            w.plan(estate.steward.account, &c.id, Why::Pull).await,
            Err(VaultError::NotAllowed(_))
        ),
        "an admin checks and removes; only the owner pulls"
    );

    let view = w
        .pull(&v, alice.account, &c.id, "c1", on(&design, "dev-1"))
        .await
        .unwrap()
        .expect("pulled");
    let item = view.items[0].clone();
    assert_eq!(
        (item.name.as_str(), item.state.as_str()),
        ("core-sw1 admin", "on")
    );
    let view = w
        .pull(&v, alice.account, &c.id, "c2", on(&design, "dev-2"))
        .await
        .unwrap()
        .expect("pulled");
    let own_key = view
        .items
        .iter()
        .find(|i| i.cipher_id == "c2")
        .unwrap()
        .id
        .clone();

    let before = chain_types(w.org).await;
    assert_eq!(
        w.use_it(&v, alice.account, &item.id, &design, "dev-1")
            .await
            .expect("used"),
        ("admin".to_string(), "s3cret!".to_string())
    );
    assert_eq!(
        w.use_it(&v, alice.account, &own_key, &design, "dev-2")
            .await
            .expect("an item with its own key"),
        ("netops".to_string(), "k3y-own".to_string())
    );
    let after = chain_types(w.org).await;
    assert_eq!(
        count(&after, "vault_outside_read") - count(&before, "vault_outside_read"),
        2
    );

    // Not where it is not marked, and not for someone who may not draw there.
    assert!(matches!(
        w.use_it(&v, alice.account, &item.id, &design, "dev-2")
            .await,
        Err(VaultError::NotAllowed(_))
    ));
    assert!(matches!(
        w.use_it(&v, bob.account, &item.id, &design, "dev-1").await,
        Err(VaultError::NotAllowed(_))
    ));
    // A password the outside vault hides from this account is not read.
    v.set(|a| a.hide_password = true);
    assert!(matches!(
        w.use_it(&v, alice.account, &item.id, &design, "dev-1")
            .await,
        Err(VaultError::NotAllowed(_))
    ));
    assert_eq!(
        count(&chain_types(w.org).await, "vault_outside_read"),
        count(&after, "vault_outside_read")
    );
}

#[tokio::test]
async fn a_failed_check_stops_the_connection_on_the_record_and_a_passing_one_resumes_it() {
    let (w, estate) = a_world().await;
    let alice = a_member(&w.pool, &w.ring, &estate, "alice", Some(Capability::Draw)).await;
    let design = a_design(&w.pool, &estate).await;
    let v = a_vault();
    let c = w
        .connect(&v, alice.account, ORG_KEY, COLLECTION)
        .await
        .unwrap();
    let item = w
        .pull(&v, alice.account, &c.id, "c1", on(&design, "dev-1"))
        .await
        .unwrap()
        .unwrap()
        .items[0]
        .id
        .clone();

    for (what, breaks) in [
        (
            "an admin role",
            Box::new(|a: &mut Account| a.role = 1) as Box<dyn Fn(&mut Account)>,
        ),
        (
            "a second collection",
            Box::new(|a: &mut Account| a.extra_collection = true),
        ),
        (
            "a personal item in the trash",
            Box::new(|a: &mut Account| a.personal_item = true),
        ),
        (
            "a refused API key",
            Box::new(|a: &mut Account| a.refuse_key = true),
        ),
    ] {
        v.set(|a| breaks(a));
        match w.check(&v, estate.steward.account, &c.id).await {
            Ok(Err(VaultError::OutsideRefused(_))) => {}
            other => panic!("{what}: {:?}", other.map(|r| r.map(|_| ()))),
        }
        assert_eq!(w.state_of(alice.account, &c.id).await, "stopped", "{what}");
        assert!(
            matches!(
                w.plan(alice.account, &c.id, Why::Pull).await,
                Err(VaultError::NotAllowed(_))
            ),
            "{what}"
        );
        assert!(
            matches!(
                w.use_it(&v, alice.account, &item, &design, "dev-1").await,
                Err(VaultError::NotAllowed(_))
            ),
            "{what}: nothing is read through a stopped connection"
        );
        v.set(|a| *a = Account::sound());
        w.check(&v, alice.account, &c.id)
            .await
            .unwrap()
            .expect("a sound account passes");
        assert_eq!(w.state_of(alice.account, &c.id).await, "on", "{what}");
    }
    // connected, four stops, four resumes, the pull.
    assert_eq!(
        count(&chain_types(w.org).await, "vault_outside_changed"),
        10
    );
}

#[tokio::test]
async fn an_admins_removal_is_the_one_its_owner_cannot_undo_and_any_admin_disconnects() {
    let (w, estate) = a_world().await;
    let alice = a_member(&w.pool, &w.ring, &estate, "alice", Some(Capability::Draw)).await;
    let bob = a_member(&w.pool, &w.ring, &estate, "bob", None).await;
    let design = a_design(&w.pool, &estate).await;
    let admin = estate.steward.account;
    let v = a_vault();
    let c = w
        .connect(&v, alice.account, ORG_KEY, COLLECTION)
        .await
        .unwrap();
    let item = w
        .pull(&v, alice.account, &c.id, "c1", on(&design, "dev-1"))
        .await
        .unwrap()
        .unwrap()
        .items[0]
        .id
        .clone();

    assert!(matches!(
        w.item_act(bob.account, "remove", &item).await,
        Err(VaultError::NotFound)
    ));
    let view = w
        .item_act(admin, "remove", &item)
        .await
        .expect("an admin removes");
    assert_eq!(
        view.items[0].removed_by.as_deref(),
        Some(admin.to_string().as_str())
    );
    assert!(matches!(
        w.item_act(alice.account, "restore", &item).await,
        Err(VaultError::NotAllowed(_))
    ));
    assert!(
        matches!(
            w.pull(&v, alice.account, &c.id, "c1", on(&design, "dev-1"))
                .await,
            Ok(Err(VaultError::NotAllowed(_)))
        ),
        "pulling it again does not undo an admin's removal"
    );
    assert!(matches!(
        w.use_it(&v, alice.account, &item, &design, "dev-1").await,
        Err(VaultError::NotAllowed(_))
    ));
    w.item_act(admin, "restore", &item)
        .await
        .expect("an admin restores");

    w.item_act(alice.account, "remove", &item)
        .await
        .expect("its owner removes");
    w.item_act(alice.account, "restore", &item)
        .await
        .expect("and puts back their own removal");

    let view = w
        .item_act(admin, "disconnect", &c.id)
        .await
        .expect("an admin disconnects");
    assert_eq!(view.state, "disconnected");
    let su = support::superuser_client_on_test_database().await;
    let sealed: Vec<u8> = su
        .query_one(
            "SELECT secret_ct FROM vault.outside_connections WHERE id = $1",
            &[&c.id],
        )
        .await
        .unwrap()
        .get(0);
    assert!(
        sealed.is_empty(),
        "the sealed API key and organisation key are gone"
    );
    assert!(matches!(
        w.plan(alice.account, &c.id, Why::Check).await,
        Err(VaultError::NotAllowed(_))
    ));
    assert!(matches!(
        w.use_it(&v, alice.account, &item, &design, "dev-1").await,
        Err(VaultError::NotAllowed(_))
    ));
}

#[tokio::test]
async fn a_key_that_does_not_open_the_collection_or_a_host_not_allowed_never_connects() {
    let (w, estate) = a_world().await;
    let alice = a_member(&w.pool, &w.ring, &estate, "alice", None).await;
    let v = a_vault();
    assert!(matches!(
        w.connect(&v, alice.account, [6; 64], COLLECTION).await,
        Err(VaultError::OutsideRefused(_))
    ));
    assert!(matches!(
        w.connect(&v, alice.account, ORG_KEY, "another-name").await,
        Err(VaultError::OutsideRefused(_))
    ));
    v.set(|a| a.role = 0);
    assert!(
        matches!(
            w.connect(&v, alice.account, ORG_KEY, COLLECTION).await,
            Err(VaultError::OutsideRefused(_))
        ),
        "an owner of the outside organisation sees every collection"
    );
    let fenced = Outside {
        net: Box::new(StandIn(v.account.clone())),
        allowed_hosts: Some(vec!["vault.internal.test".to_string()]),
    };
    assert!(matches!(
        outside::vw_read(
            &fenced,
            &v.url,
            CLIENT_ID,
            SECRET,
            &outside::new_device_id().unwrap()
        )
        .await,
        Err(VaultError::NotAllowed(_))
    ));
    assert!(w.list(estate.steward.account).await.is_empty());
    assert_eq!(count(&chain_types(w.org).await, "vault_outside_changed"), 0);
}
