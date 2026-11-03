//! Logins Fathom itself can use — the vault's Mode B, `src/vault_fathom.rs` and
//! `migrations/0043_vault_fathom.sql` — against a real PostgreSQL.
//!
//! Storage design §13.4 and §13.5 are the rules: only the owner, holding it, consents to A→B
//! by a signature over the exact statement; a login shared with other people waits for another
//! admin's countersignature; B→A is the owner's or any admin's; every use by Fathom is filed on
//! the organisation chain before the copy is opened, and only for a device it is marked on.
//!
//! **Each test's name is its claim** (CLAUDE.md rule 2).

mod support;

use std::sync::Arc;

use deadpool_postgres::{Pool, Transaction};

use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::crypto::{self, Key32};
use fathom_server::device_reading::{self, Protocol};
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant, GrantRequest};
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId, ScopeKind};
use fathom_server::vault::{self, Enrolment, Meta, ShareIn, VaultError, WrapIn};
use fathom_server::vault_fathom::{self, Consent, FathomKey};

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
    vault: SoftwareKey,
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
        vault: SoftwareKey::random().unwrap(),
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

async fn enrol_vault(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    p: &Person,
) -> vault::KeyView {
    let at = now_unix();
    let public = p.vault.public_key().to_vec();
    let signer = p.key.fingerprint().to_vec();
    let bytes = vault::person_key_bytes(
        &org.to_string(),
        &p.account.to_string(),
        &public,
        &signer,
        at as u64,
    );
    let e = Enrolment {
        kind: "person".into(),
        public_key: public,
        sealed_private: vec![7; 160],
        sealed_nonce: vec![1; 12],
        kdf: Some((vec![2; 16], 19_456, 2, 1)),
        signer_key_fpr: signer,
        enrolled_at: at,
        signature: p.key.sign(&bytes).to_vec(),
        succession_sig: None,
    };
    with_auth(pool, ring, org, p.account, |tx, auth| {
        Box::pin(vault::enrol_key(tx, auth, e))
    })
    .await
    .expect("vault key")
}

fn a_wrap(seed: u8) -> Vec<u8> {
    let eph = SoftwareKey::random().unwrap().public_key();
    let mut w = Vec::new();
    crypto::lp(&mut w, &eph);
    crypto::lp(&mut w, &[seed; 12]);
    crypto::lp(&mut w, &[seed; 48]);
    w
}

fn a_share(
    org: OrganisationId,
    credential: &str,
    epoch: u32,
    sharer: &Person,
    holders: &[(&vault::KeyView, String)],
) -> ShareIn {
    let at = now_unix();
    let wraps: Vec<WrapIn> = holders
        .iter()
        .enumerate()
        .map(|(i, (k, _))| WrapIn {
            key_id: k.id.clone(),
            wrap: a_wrap(i as u8 + 1),
        })
        .collect();
    let recipients: Vec<vault::Recipient> = holders
        .iter()
        .zip(&wraps)
        .map(|((k, who), w)| vault::Recipient {
            who: who.clone(),
            key_fpr: k.fpr.clone().try_into().unwrap(),
            digest: vault::wrap_digest(&w.wrap),
        })
        .collect();
    let bytes = vault::share_bytes(
        &org.to_string(),
        credential,
        epoch,
        &recipients,
        &sharer.account.to_string(),
        &sharer.key.fingerprint(),
        at as u64,
    );
    ShareIn {
        at,
        sharer_key_fpr: sharer.key.fingerprint().to_vec(),
        signature: sharer.key.sign(&bytes).to_vec(),
        wraps,
        via_recovery: false,
    }
}

/// A design in the organisation, with one device element named on logins below.
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

/// A login stored by `owner`, used on `(design, "dev-1")`, held by `holders`, then shared once
/// more (epoch 2) so A→B has a fresh key to consent to.
async fn a_login(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    owner: &Person,
    design: &str,
    holders: &[(&vault::KeyView, String)],
) -> vault::EntryView {
    let meta = Meta::clean(
        "core-sw admin",
        "login",
        vec![(design.to_string(), "dev-1".to_string())],
    )
    .unwrap();
    a_login_with(pool, ring, estate, owner, meta, holders).await
}

/// [`a_login`] with the metadata given.
async fn a_login_with(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    owner: &Person,
    meta: Meta,
    holders: &[(&vault::KeyView, String)],
) -> vault::EntryView {
    let org = estate.organisation;
    let id = format!("cred_{}", fathom_server::ids::new_ulid());
    let share = a_share(org, &id, 1, owner, holders);
    let id2 = id.clone();
    let made = with_auth(pool, ring, org, owner.account, |tx, auth| {
        Box::pin(async move {
            vault::create_entry(tx, auth, &id2, meta, vec![5; 64], vec![6; 12], share).await
        })
    })
    .await
    .expect("created");
    rotate(pool, ring, org, owner, &made, holders, "rotated").await
}

async fn rotate(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    who: &Person,
    entry: &vault::EntryView,
    holders: &[(&vault::KeyView, String)],
    reason: &'static str,
) -> vault::EntryView {
    let share = a_share(org, &entry.id, entry.epoch as u32 + 1, who, holders);
    let (id, version) = (entry.id.clone(), entry.version);
    with_auth(pool, ring, org, who.account, |tx, auth| {
        Box::pin(async move {
            vault::new_epoch(
                tx,
                auth,
                &id,
                version,
                vec![9; 64],
                vec![6; 12],
                share,
                reason,
            )
            .await
        })
    })
    .await
    .expect("new epoch")
}

/// The owner's consent, signed over exactly what the server rebuilds.
fn consent(
    org: OrganisationId,
    entry: &vault::EntryView,
    owner: &Person,
    server_key_id: &str,
    epoch_before: i32,
) -> Consent {
    let at = now_unix();
    let recipients: Vec<vault::Recipient> = entry
        .holders
        .iter()
        .map(|h| vault::Recipient {
            who: h
                .account
                .clone()
                .unwrap_or_else(|| vault::RECOVERY_RECIPIENT.to_string()),
            key_fpr: h.fpr.clone().try_into().unwrap(),
            digest: h.digest.clone().try_into().unwrap(),
        })
        .collect();
    let bytes = vault_fathom::mode_change_bytes(
        &org.to_string(),
        &entry.id,
        "A",
        "B",
        epoch_before as u32,
        entry.epoch as u32,
        &owner.account.to_string(),
        &owner.key.fingerprint(),
        &recipients,
        server_key_id,
        at as u64,
        entry.share_seq as u64,
    );
    Consent {
        at,
        key_fpr: owner.key.fingerprint().to_vec(),
        signature: owner.key.sign(&bytes).to_vec(),
        epoch_before,
    }
}

fn the_login(password: &str) -> Vec<u8> {
    format!("{{\"n\":\"rack 4\",\"p\":\"{password}\",\"u\":\"admin\"}}\n").into_bytes()
}

#[allow(clippy::too_many_arguments)]
async fn turn_on(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    who: &Person,
    fk: &Arc<FathomKey>,
    entry: &vault::EntryView,
    c: Consent,
    password: &str,
) -> Result<vault_fathom::FathomView, VaultError> {
    turn_on_with(pool, ring, org, who, fk, entry, c, the_login(password)).await
}

#[allow(clippy::too_many_arguments)]
async fn turn_on_with(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    who: &Person,
    fk: &Arc<FathomKey>,
    entry: &vault::EntryView,
    c: Consent,
    copy: Vec<u8>,
) -> Result<vault_fathom::FathomView, VaultError> {
    let (id, version) = (entry.id.clone(), entry.version);
    let fk = Arc::clone(fk);
    with_auth(pool, ring, org, who.account, |tx, auth| {
        Box::pin(async move { vault_fathom::turn_on(tx, auth, &fk, &id, version, c, copy).await })
    })
    .await
}

#[allow(clippy::too_many_arguments)]
async fn use_it(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    who: &Person,
    fk: &Arc<FathomKey>,
    credential: &str,
    design: &str,
    element: &str,
) -> Result<(String, String), VaultError> {
    let (id, d, e) = (
        credential.to_string(),
        design.to_string(),
        element.to_string(),
    );
    let fk = Arc::clone(fk);
    with_auth(pool, ring, org, who.account, |tx, auth| {
        Box::pin(async move {
            vault_fathom::use_login(tx, auth, &fk, &id, &d, &e, "autopopulate")
                .await
                .map(|l| (l.user.clone(), l.password.clone()))
        })
    })
    .await
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
async fn only_the_owner_holding_it_consents_and_fathom_then_uses_it_only_where_it_is_marked() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let fk = fathom_key();
    let fk_id = fk.id().to_string();
    let estate = bootstrap(&pool, &ring).await;
    let org = estate.organisation;
    let alice = a_member(&pool, &ring, &estate, "alice", Some(Capability::Draw)).await;
    let bob = a_member(&pool, &ring, &estate, "bob", None).await;
    let a = enrol_vault(&pool, &ring, org, &alice).await;
    enrol_vault(&pool, &ring, org, &bob).await;
    let design = a_design(&pool, &estate).await;
    let login = a_login(
        &pool,
        &ring,
        &estate,
        &alice,
        &design,
        &[(&a, alice.account.to_string())],
    )
    .await;
    assert_eq!(login.epoch, 2);

    // Not the owner: refused, however well signed.
    let c = consent(org, &login, &bob, &fk_id, 1);
    let refused = turn_on(&pool, &ring, org, &bob, &fk, &login, c, "S3cret-Pass!").await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );

    // The owner, but consenting to a different server key: the signature does not verify.
    let c = consent(org, &login, &alice, "0000000000000000", 1);
    let refused = turn_on(&pool, &ring, org, &alice, &fk, &login, c, "S3cret-Pass!").await;
    assert!(
        matches!(refused, Err(VaultError::Authority(_))),
        "{refused:?}"
    );

    // No fresh key since: epoch_before must be an earlier epoch.
    let c = consent(org, &login, &alice, &fk_id, 2);
    let refused = turn_on(&pool, &ring, org, &alice, &fk, &login, c, "S3cret-Pass!").await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );

    // Properly: held only by Alice, so it is in force at once.
    let c = consent(org, &login, &alice, &fk_id, 1);
    let on = turn_on(&pool, &ring, org, &alice, &fk, &login, c, "S3cret-Pass!")
        .await
        .expect("on");
    assert_eq!(on.state, "on");
    assert!(!on.countersign_needed);
    assert_eq!(on.server_key_id, fk_id);

    // Fathom uses it, on the device it is marked on, for Alice who can draw there.
    let used = use_it(&pool, &ring, org, &alice, &fk, &login.id, &design, "dev-1")
        .await
        .expect("used");
    assert_eq!(used, ("admin".to_string(), "S3cret-Pass!".to_string()));
    // Not on another device; not for Bob, who cannot draw on the design.
    let refused = use_it(&pool, &ring, org, &alice, &fk, &login.id, &design, "dev-2").await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let refused = use_it(&pool, &ring, org, &bob, &fk, &login.id, &design, "dev-1").await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    // Not under another vault.key: named, not a tag failure.
    let other = Arc::new(FathomKey::from_key(Key32::from_bytes([32; 32])));
    let refused = use_it(
        &pool, &ring, org, &alice, &other, &login.id, &design, "dev-1",
    )
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );

    // One read, filed on the chain after the mode change.
    let types = chain_types(org).await;
    let changed = types
        .iter()
        .position(|t| t == "vault_mode_changed")
        .expect("mode entry");
    let read = types
        .iter()
        .position(|t| t == "vault_read")
        .expect("read entry");
    assert!(changed < read);
    assert_eq!(types.iter().filter(|t| *t == "vault_read").count(), 1);
    let view = with_auth(&pool, &ring, org, alice.account, |tx, auth| {
        Box::pin(vault::overview(tx, auth))
    })
    .await
    .unwrap();
    let f = view
        .entries
        .iter()
        .find(|e| e.id == login.id)
        .unwrap()
        .fathom
        .clone()
        .unwrap();
    assert_eq!((f.state.as_str(), f.reads), ("on", 1));
    assert_eq!(f.last_purpose.as_deref(), Some("autopopulate"));

    // The password changes: Fathom's copy is out of date and is not used until a holder hands
    // it the new one.
    let changed = rotate(
        &pool,
        &ring,
        org,
        &alice,
        &login,
        &[(&a, alice.account.to_string())],
        "changed",
    )
    .await;
    let refused = use_it(&pool, &ring, org, &alice, &fk, &login.id, &design, "dev-1").await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let id = changed.id.clone();
    let fk2 = Arc::clone(&fk);
    with_auth(&pool, &ring, org, alice.account, |tx, auth| {
        Box::pin(
            async move { vault_fathom::refresh(tx, auth, &fk2, &id, the_login("N3w-Pass!")).await },
        )
    })
    .await
    .expect("refreshed");
    let used = use_it(&pool, &ring, org, &alice, &fk, &login.id, &design, "dev-1")
        .await
        .expect("used again");
    assert_eq!(used.1, "N3w-Pass!");

    // An admin turns it off: Fathom's copy is emptied and never used again.
    let id = login.id.clone();
    let off = with_auth(&pool, &ring, org, estate.steward.account, |tx, auth| {
        Box::pin(async move { vault_fathom::turn_off(tx, auth, &id).await })
    })
    .await
    .expect("off");
    assert_eq!(off.state, "off");
    let refused = use_it(&pool, &ring, org, &alice, &fk, &login.id, &design, "dev-1").await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let su = support::superuser_client_on_test_database().await;
    let len: i32 = su
        .query_one(
            "SELECT octet_length(copy_ct) FROM vault.fathom_copies WHERE organisation_id = $1 AND entry_id = $2",
            &[&org.to_string(), &login.id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(len, 0, "off keeps no copy");
}

#[tokio::test]
async fn a_login_shared_with_other_people_waits_for_another_admin_to_countersign() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let fk = fathom_key();
    let fk_id = fk.id().to_string();
    let estate = bootstrap(&pool, &ring).await;
    let org = estate.organisation;
    let alice = a_member(&pool, &ring, &estate, "alice", Some(Capability::Draw)).await;
    let bob = a_member(&pool, &ring, &estate, "bob", None).await;
    let a = enrol_vault(&pool, &ring, org, &alice).await;
    let b = enrol_vault(&pool, &ring, org, &bob).await;
    let design = a_design(&pool, &estate).await;
    let login = a_login(
        &pool,
        &ring,
        &estate,
        &alice,
        &design,
        &[
            (&a, alice.account.to_string()),
            (&b, bob.account.to_string()),
        ],
    )
    .await;

    let c = consent(org, &login, &alice, &fk_id, 1);
    let waiting = turn_on(&pool, &ring, org, &alice, &fk, &login, c, "S3cret-Pass!")
        .await
        .expect("asked");
    assert_eq!(waiting.state, "waiting");
    assert!(waiting.countersign_needed);
    let refused = use_it(&pool, &ring, org, &alice, &fk, &login.id, &design, "dev-1").await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "waiting is not in force: {refused:?}"
    );
    // Nor is a waiting copy refreshed: the admin countersigns the holders the owner named.
    let (id, fk2) = (login.id.clone(), Arc::clone(&fk));
    let refused = with_auth(&pool, &ring, org, alice.account, |tx, auth| {
        Box::pin(
            async move { vault_fathom::refresh(tx, auth, &fk2, &id, the_login("Other!")).await },
        )
    })
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "a waiting copy is not refreshed: {refused:?}"
    );

    // Bob holds it but is no admin: they cannot countersign.
    let at = now_unix();
    let (id, bytes) = (login.id.clone(), waiting.consent_bytes.clone());
    let (fpr, sig) = (
        bob.key.fingerprint().to_vec(),
        bob.key.sign(&bytes).to_vec(),
    );
    let refused = with_auth(&pool, &ring, org, bob.account, |tx, auth| {
        Box::pin(async move { vault_fathom::countersign(tx, auth, &id, fpr, sig, at).await })
    })
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );

    // The steward signs the same statement: in force.
    let (id, fpr, sig) = (
        login.id.clone(),
        estate.steward.key.fingerprint().to_vec(),
        estate.steward.key.sign(&bytes).to_vec(),
    );
    let on = with_auth(&pool, &ring, org, estate.steward.account, |tx, auth| {
        Box::pin(async move { vault_fathom::countersign(tx, auth, &id, fpr, sig, at).await })
    })
    .await
    .expect("countersigned");
    assert_eq!(on.state, "on");
    assert_eq!(
        on.countersigned_by.as_deref(),
        Some(estate.steward.account.to_string().as_str())
    );
    let used = use_it(&pool, &ring, org, &alice, &fk, &login.id, &design, "dev-1")
        .await
        .expect("used");
    assert_eq!(used.1, "S3cret-Pass!");
    let types = chain_types(org).await;
    assert_eq!(
        types.iter().filter(|t| *t == "vault_mode_changed").count(),
        2,
        "consent and countersignature"
    );
}

#[tokio::test]
async fn fathoms_copy_is_never_stored_in_the_clear() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let fk = fathom_key();
    let estate = bootstrap(&pool, &ring).await;
    let org = estate.organisation;
    let alice = a_member(&pool, &ring, &estate, "alice", Some(Capability::Draw)).await;
    let a = enrol_vault(&pool, &ring, org, &alice).await;
    let design = a_design(&pool, &estate).await;
    let login = a_login(
        &pool,
        &ring,
        &estate,
        &alice,
        &design,
        &[(&a, alice.account.to_string())],
    )
    .await;
    let marker = format!("Mk-{}", fathom_server::ids::new_ulid());
    let c = consent(org, &login, &alice, &fk.id().to_string(), 1);
    turn_on(&pool, &ring, org, &alice, &fk, &login, c, &marker)
        .await
        .expect("on");
    let su = support::superuser_client_on_test_database().await;
    let hits: i64 = su
        .query_one(
            "SELECT count(*) FROM vault.fathom_copies \
             WHERE position(convert_to($1, 'UTF8') in copy_ct) > 0 \
                OR position(convert_to($1, 'UTF8') in consent_bytes) > 0",
            &[&marker],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(hits, 0);
}

// ---------------------------------------------------------------------------
// Breach checks (ADR-0071 part three, `vault_breach.rs`). Here beside Mode B because they share
// every fixture above.
// ---------------------------------------------------------------------------

use fathom_server::vault_breach::{self, Level, Policy};

fn level(enabled: bool, days: i32, action: &str) -> Level {
    Level {
        enabled,
        interval_days: days,
        action: action.into(),
    }
}

#[tokio::test]
async fn admins_set_the_policy_owners_mark_critical_and_only_holders_record_a_check() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let org = estate.organisation;
    let alice = a_member(&pool, &ring, &estate, "alice", Some(Capability::Draw)).await;
    let bob = a_member(&pool, &ring, &estate, "bob", None).await;
    let carol = a_member(&pool, &ring, &estate, "carol", None).await;
    let a = enrol_vault(&pool, &ring, org, &alice).await;
    let b = enrol_vault(&pool, &ring, org, &bob).await;
    enrol_vault(&pool, &ring, org, &carol).await;
    let design = a_design(&pool, &estate).await;
    let holders = [
        (&a, alice.account.to_string()),
        (&b, bob.account.to_string()),
    ];
    let login = a_login(&pool, &ring, &estate, &alice, &design, &holders).await;

    // The policy is an admin's.
    let mut policy = Policy {
        organisation: Some(level(true, 30, "warn")),
        ..Policy::default()
    };
    policy.kinds.insert("snmp".into(), level(false, 30, "warn"));
    let p = policy.clone();
    let refused = with_auth(&pool, &ring, org, alice.account, |tx, auth| {
        Box::pin(async move { vault_breach::set_policy(tx, auth, p).await })
    })
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let p = policy.clone();
    let saved = with_auth(&pool, &ring, org, estate.steward.account, |tx, auth| {
        Box::pin(async move { vault_breach::set_policy(tx, auth, p).await })
    })
    .await
    .expect("an admin sets it");
    assert_eq!(saved, policy);
    // A nonsense interval is refused before anything is written.
    let mut bad = policy.clone();
    bad.organisation = Some(level(true, 0, "warn"));
    let refused = with_auth(&pool, &ring, org, estate.steward.account, |tx, auth| {
        Box::pin(async move { vault_breach::set_policy(tx, auth, bad).await })
    })
    .await;
    assert!(
        matches!(refused, Err(VaultError::Malformed(_))),
        "{refused:?}"
    );
    // Dropping the SNMP override goes back to the organisation's level; nothing is deleted.
    let p = Policy {
        organisation: policy.organisation.clone(),
        ..Policy::default()
    };
    let saved = with_auth(&pool, &ring, org, estate.steward.account, |tx, auth| {
        Box::pin(async move { vault_breach::set_policy(tx, auth, p).await })
    })
    .await
    .expect("override dropped");
    assert!(saved.kinds.is_empty());
    assert_eq!(
        vault_breach::effective(&saved, "snmp", false).1,
        vault_breach::From::Organisation
    );

    // Critical is the owner's or an admin's to mark.
    let id = login.id.clone();
    let refused = with_auth(&pool, &ring, org, bob.account, |tx, auth| {
        Box::pin(async move { vault_breach::set_critical(tx, auth, &id, true).await })
    })
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let id = login.id.clone();
    with_auth(&pool, &ring, org, alice.account, |tx, auth| {
        Box::pin(async move { vault_breach::set_critical(tx, auth, &id, true).await })
    })
    .await
    .expect("the owner marks it");

    // A check is recorded only by someone holding it, at its current epoch.
    let (id, epoch) = (login.id.clone(), login.epoch);
    let refused = with_auth(&pool, &ring, org, carol.account, |tx, auth| {
        Box::pin(async move { vault_breach::record(tx, auth, &id, epoch, true).await })
    })
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let id = login.id.clone();
    let refused = with_auth(&pool, &ring, org, bob.account, |tx, auth| {
        Box::pin(async move { vault_breach::record(tx, auth, &id, epoch - 1, true).await })
    })
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let id = login.id.clone();
    let found = with_auth(&pool, &ring, org, bob.account, |tx, auth| {
        Box::pin(async move { vault_breach::record(tx, auth, &id, epoch, true).await })
    })
    .await
    .expect("a holder records it");
    assert!(found.found);

    let view = with_auth(&pool, &ring, org, alice.account, |tx, auth| {
        Box::pin(vault::overview(tx, auth))
    })
    .await
    .unwrap();
    let e = view.entries.iter().find(|e| e.id == login.id).unwrap();
    assert!(e.critical);
    assert_eq!(e.breach.as_ref().map(|r| r.found), Some(true));
    assert_eq!(view.breach_policy, saved);

    // A changed password starts unchecked.
    let changed = rotate(&pool, &ring, org, &alice, &login, &holders, "changed").await;
    assert!(changed.breach.is_none());

    // Each change of policy and mark is on the organisation's history.
    let types = chain_types(org).await;
    assert_eq!(
        types
            .iter()
            .filter(|t| *t == "vault_breach_policy_set")
            .count(),
        3
    );
}

// ---------------------------------------------------------------------------
// Device reading (ADR-0082 §4.1; migration 0073)
// ---------------------------------------------------------------------------

/// An SNMP login, ticked read-only or not, naming SHA-256, marked on `dev-1`, in force for
/// Fathom with its own privacy password.
#[allow(clippy::too_many_arguments)]
async fn an_snmp_login(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    owner: &Person,
    held: &vault::KeyView,
    fk: &Arc<FathomKey>,
    design: &str,
    read_only: bool,
) -> vault::EntryView {
    let org = estate.organisation;
    let meta = Meta::clean(
        "core-ro",
        "snmp",
        vec![(design.to_string(), "dev-1".to_string())],
    )
    .unwrap()
    .with_read_only(read_only)
    .with_snmp_auth(Some("sha256"))
    .unwrap();
    let login = a_login_with(
        pool,
        ring,
        estate,
        owner,
        meta,
        &[(held, owner.account.to_string())],
    )
    .await;
    let c = consent(org, &login, owner, &fk.id().to_string(), 1);
    let copy =
        b"{\"n\":\"\",\"p\":\"authpassword256\",\"u\":\"fathom256\",\"x\":\"privpassword256\"}\n"
            .to_vec();
    turn_on_with(pool, ring, org, owner, fk, &login, c, copy)
        .await
        .expect("on");
    login
}

#[allow(clippy::too_many_arguments)]
async fn use_to_read(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    who: &Person,
    fk: &Arc<FathomKey>,
    credential: &str,
    design: &str,
    element: &str,
    by_range: bool,
) -> Result<(String, String, Option<String>, String), VaultError> {
    let (id, d, e) = (
        credential.to_string(),
        design.to_string(),
        element.to_string(),
    );
    let fk = Arc::clone(fk);
    with_auth(pool, ring, org, who.account, |tx, auth| {
        Box::pin(async move {
            vault_fathom::use_login_to_read(tx, auth, &fk, &id, &d, &e, by_range, Protocol::Snmp)
                .await
                .map(|(l, a)| {
                    (
                        l.user.clone(),
                        l.password.clone(),
                        l.privacy.clone(),
                        a.unwrap_or_default(),
                    )
                })
        })
    })
    .await
}

#[tokio::test]
async fn a_device_is_read_only_with_a_read_only_snmp_login_marked_on_it_or_set_for_its_range() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let fk = fathom_key();
    let estate = bootstrap(&pool, &ring).await;
    let org = estate.organisation;
    let alice = a_member(&pool, &ring, &estate, "alice", Some(Capability::Draw)).await;
    let a = enrol_vault(&pool, &ring, org, &alice).await;
    let design = a_design(&pool, &estate).await;

    let ro = an_snmp_login(&pool, &ring, &estate, &alice, &a, &fk, &design, true).await;
    let used = use_to_read(
        &pool, &ring, org, &alice, &fk, &ro.id, &design, "dev-1", false,
    )
    .await
    .expect("read-only, marked");
    assert_eq!(
        used,
        (
            "fathom256".to_string(),
            "authpassword256".to_string(),
            Some("privpassword256".to_string()),
            "sha256".to_string()
        )
    );
    // Not marked on dev-2, unless it is the login the Steward set for the range.
    let refused = use_to_read(
        &pool, &ring, org, &alice, &fk, &ro.id, &design, "dev-2", false,
    )
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    use_to_read(
        &pool, &ring, org, &alice, &fk, &ro.id, &design, "dev-2", true,
    )
    .await
    .expect("the range's login");

    // Without the read-only tick it is never used to read, and nothing is filed for it.
    let before = chain_types(org).await.len();
    let rw = an_snmp_login(&pool, &ring, &estate, &alice, &a, &fk, &design, false).await;
    let after_made = chain_types(org).await.len();
    let refused = use_to_read(
        &pool, &ring, org, &alice, &fk, &rw.id, &design, "dev-1", false,
    )
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    assert!(after_made > before);
    assert_eq!(
        chain_types(org).await.len(),
        after_made,
        "a refusal files nothing"
    );

    // An ordinary login is not an SNMP one.
    let plain = a_login(
        &pool,
        &ring,
        &estate,
        &alice,
        &design,
        &[(&a, alice.account.to_string())],
    )
    .await;
    let c = consent(org, &plain, &alice, &fk.id().to_string(), 1);
    turn_on(&pool, &ring, org, &alice, &fk, &plain, c, "S3cret-Pass!")
        .await
        .expect("on");
    let refused = use_to_read(
        &pool, &ring, org, &alice, &fk, &plain.id, &design, "dev-1", true,
    )
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );

    // Over SSH it is the other way round: a login, ticked read-only, and never an SNMP one.
    let ssh_meta = Meta::clean(
        "srx-ro",
        "login",
        vec![(design.to_string(), "dev-1".to_string())],
    )
    .unwrap()
    .with_read_only(true);
    let ssh = a_login_with(
        &pool,
        &ring,
        &estate,
        &alice,
        ssh_meta,
        &[(&a, alice.account.to_string())],
    )
    .await;
    let c = consent(org, &ssh, &alice, &fk.id().to_string(), 1);
    turn_on(&pool, &ring, org, &alice, &fk, &ssh, c, "read-only-pw-7Qx")
        .await
        .expect("on");
    let over_ssh = |credential: String| {
        let fk = Arc::clone(&fk);
        let d = design.clone();
        with_auth(&pool, &ring, org, alice.account, move |tx, auth| {
            Box::pin(async move {
                vault_fathom::use_login_to_read(
                    tx,
                    auth,
                    &fk,
                    &credential,
                    &d,
                    "dev-1",
                    false,
                    Protocol::Ssh,
                )
                .await
                .map(|(l, a)| (l.password.clone(), a))
            })
        })
    };
    let (password, auth_name) = over_ssh(ssh.id.clone()).await.expect("an SSH login");
    assert_eq!(password, "read-only-pw-7Qx");
    assert_eq!(auth_name, None, "an SSH login names no SNMP authentication");
    let refused = over_ssh(ro.id.clone()).await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "an SNMP login is not an SSH one: {refused:?}"
    );
    let refused = over_ssh(plain.id.clone()).await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "a login without the read-only tick is never used: {refused:?}"
    );

    // MD5 has no spelling; a non-SNMP login names no SNMP authentication.
    let m = Meta::clean("x", "snmp", vec![]).unwrap();
    assert!(m.clone().with_snmp_auth(Some("md5")).is_err());
    assert!(Meta::clean("x", "login", vec![])
        .unwrap()
        .with_snmp_auth(Some("sha256"))
        .is_err());
}

fn target(design: &str, address: &str) -> device_reading::Target {
    device_reading::Target {
        design: design.to_string(),
        element: "dev-1".to_string(),
        address: address.parse().unwrap(),
        range: fathom_server::device_read::Range::parse("10.20.0.0/24", None, None).unwrap(),
        platform: Some("junos-srx".to_string()),
    }
}

async fn as_who<T: 'static, F>(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    who: &Person,
    f: F,
) -> T
where
    F: for<'a> FnOnce(
            &'a Transaction<'a>,
            &'a Authority<'a>,
            device_reading::ReadingKeys,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = T> + 'a>>
        + 'static,
{
    with_auth(pool, ring, org, who.account, |tx, auth| {
        let keys =
            device_reading::ReadingKeys::derive(auth.tenant_key, &auth.ctx.tenant().to_string());
        f(tx, auth, keys)
    })
    .await
}

fn parse(text: &str) -> fathom_canon::Json {
    fathom_canon::Json::parse_canonical(
        &fathom_server::foreign_json::parse(text.as_bytes())
            .unwrap()
            .to_canonical_bytes(),
    )
    .unwrap()
}

#[tokio::test]
async fn an_agent_is_confirmed_before_any_login_and_what_a_device_said_is_kept_sealed() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let org = estate.organisation;
    let alice = a_member(&pool, &ring, &estate, "alice", Some(Capability::Draw)).await;
    let design = a_design(&pool, &estate).await;
    let t = target(&design, "10.20.0.14");

    // Seen, then a wrong last 8, then the right ones.
    let t1 = t.clone();
    let seen = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::record_seen(
                tx,
                auth,
                &keys,
                &t1,
                Protocol::Snmp,
                "80000009030001c2b3d4e5f60a",
                None,
            )
            .await
        })
    })
    .await
    .expect("seen");
    assert_eq!(seen.state, "seen");
    let t1 = t.clone();
    let wrong = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::approve_typed(tx, auth, &keys, &t1, Protocol::Snmp, "3d4e5f6a").await
        })
    })
    .await;
    assert!(matches!(wrong, Err(VaultError::NotAllowed(_))), "{wrong:?}");
    let t1 = t.clone();
    let ok = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::approve_typed(tx, auth, &keys, &t1, Protocol::Snmp, "d4e5f60a").await
        })
    })
    .await
    .expect("typed");
    assert_eq!(ok.state, "approved");

    // The same agent again stays approved; another id is `changed`, keeping the approved one.
    let t1 = t.clone();
    let again = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::record_seen(
                tx,
                auth,
                &keys,
                &t1,
                Protocol::Snmp,
                "80000009030001c2b3d4e5f60a",
                None,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(again.state, "approved");
    let t1 = t.clone();
    let changed = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::record_seen(
                tx,
                auth,
                &keys,
                &t1,
                Protocol::Snmp,
                "8000000903000a11b2c3d4e5f6",
                None,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(changed.state, "changed");
    assert_eq!(
        changed.previous.as_deref(),
        Some("80000009030001c2b3d4e5f60a")
    );

    // A second device seen for the first time. Alice is no Steward: no list for her.
    let t2 = target(&design, "10.20.0.15");
    as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::record_seen(
                tx,
                auth,
                &keys,
                &t2,
                Protocol::Snmp,
                "80000009030001c2b3d4e57a11",
                None,
            )
            .await
        })
    })
    .await
    .unwrap();
    let refused = as_who(&pool, &ring, org, &alice, |tx, auth, keys| {
        Box::pin(async move { device_reading::waiting(tx, auth, &keys).await })
    })
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let list = as_who(&pool, &ring, org, &estate.steward, |tx, auth, keys| {
        Box::pin(async move { device_reading::waiting(tx, auth, &keys).await })
    })
    .await
    .expect("the Steward's list");
    assert_eq!(list.len(), 2);

    // The changed one never goes with the rest; on its own, it does. One entry per batch.
    let both: Vec<std::net::IpAddr> =
        vec!["10.20.0.14".parse().unwrap(), "10.20.0.15".parse().unwrap()];
    let refused = as_who(&pool, &ring, org, &estate.steward, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::approve_batch(tx, auth, &keys, Protocol::Snmp, &both).await
        })
    })
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let one: Vec<std::net::IpAddr> = vec!["10.20.0.15".parse().unwrap()];
    let n = as_who(&pool, &ring, org, &estate.steward, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::approve_batch(tx, auth, &keys, Protocol::Snmp, &one).await
        })
    })
    .await
    .unwrap();
    assert_eq!(n, 1);
    let types = chain_types(org).await;
    assert_eq!(
        types
            .iter()
            .filter(|t| *t == "device_read_engine_approved")
            .count(),
        2,
        "one typed, one batch"
    );

    // A read kept: through the gate, sealed, filed, the latest shown in full.
    let answer = parse(
        r#"{"outcome":"read","engineId":"80000009030001c2b3d4e5f60a","reader":"local","durationMs":4200,"incomplete":[],"failed":{},
            "reading":{"system":{"name":"access-sw3","descr":"Cisco IOS XE 17.12.3"},
                       "interfaces":[{"ifIndex":7,"descr":"Gi1/0/7","alias":"enable secret cisco123"},{"ifIndex":8,"descr":"Gi1/0/8","alias":"MARKER-AP-2F-east"}]}}"#,
    );
    for _ in 0..2 {
        let body = device_reading::kept(&answer, "device");
        let t1 = t.clone();
        as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
            Box::pin(async move {
                device_reading::store(tx, auth, &keys, &t1, "device", "cred_x", &body).await
            })
        })
        .await
        .expect("stored");
    }
    let mac = |macs: &str| {
        parse(&format!(
            r#"{{"outcome":"read","reading":{{"lldp":[{{"ifIndex":48,"capEnabled":["bridge"]}}],"mac":[{macs}],"arp":[]}}}}"#
        ))
    };
    for a in [
        mac(r#"{"mac":"aa","ifIndex":7},{"mac":"up","ifIndex":48}"#),
        mac(r#"{"mac":"aa","ifIndex":7},{"mac":"bb","ifIndex":9}"#),
    ] {
        let body = device_reading::kept(&a, "macarp");
        let t1 = t.clone();
        as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
            Box::pin(async move {
                device_reading::store(tx, auth, &keys, &t1, "macarp", "cred_x", &body).await
            })
        })
        .await
        .expect("stored");
    }
    let d = design.clone();
    as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::dismiss(tx, auth, &keys, &d, "dev-1", "port:7:alias", "AP-2F-east")
                .await
        })
    })
    .await
    .expect("dismissed");
    let d = design.clone();
    let panel = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move { device_reading::panel(tx, auth, &keys, &d, "dev-1").await })
    })
    .await
    .expect("panel");
    let text = String::from_utf8(panel.to_canonical_bytes()).unwrap();
    assert!(!text.contains("cisco123"), "the gate ran before storing");
    assert!(text.contains("MARKER-AP-2F-east"));
    assert!(
        text.contains(r#""macArpChanges":{"arp":{"gone":0,"new":0},"mac":{"gone":0,"new":1}}"#),
        "{text}"
    );
    assert!(
        text.contains(r#""macLeftOut":0"#),
        "the newest table's uplink row is gone already"
    );
    assert!(text.contains(r#""field":"port:7:alias""#));
    let fathom_canon::Json::Obj(p) = &panel else {
        panic!()
    };
    let fathom_canon::Json::Arr(readings) = &p["readings"] else {
        panic!()
    };
    assert_eq!(readings.len(), 2);
    let full = |r: &fathom_canon::Json| matches!(r, fathom_canon::Json::Obj(m) if m.contains_key("reading"));
    assert!(
        full(&readings[0]) && !full(&readings[1]),
        "only the latest in full"
    );

    // Nothing a device said is in the clear anywhere.
    let su = support::superuser_client_on_test_database().await;
    for table in [
        "device_readings",
        "device_read_engines",
        "device_read_dismissals",
    ] {
        let rows = su
            .query(
                &format!("SELECT t::text FROM {table} t WHERE organisation_id = $1"),
                &[&org.to_string()],
            )
            .await
            .unwrap();
        assert!(!rows.is_empty(), "{table}");
        for r in rows {
            let row: String = r.get(0);
            for marker in [
                "MARKER",
                "10.20.0.14",
                "access-sw3",
                "80000009030001c2b3d4e5f60a",
                "AP-2F-east",
            ] {
                assert!(!row.contains(marker), "{table}: {marker}");
            }
        }
    }
    let types = chain_types(org).await;
    assert_eq!(types.iter().filter(|t| *t == "device_read_done").count(), 4);
    assert_eq!(
        types
            .iter()
            .filter(|t| *t == "device_read_dismissed")
            .count(),
        1
    );
}

/// ADR-0082 §4.4: an SSH host key is confirmed like an engine id, kept apart from the SNMP agent
/// at the same address, and a changed key is never approved with the rest of a range.
#[tokio::test]
async fn a_host_key_is_confirmed_on_its_own_and_apart_from_the_snmp_agent() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let org = estate.organisation;
    let alice = a_member(&pool, &ring, &estate, "alice", Some(Capability::Draw)).await;
    let design = a_design(&pool, &estate).await;
    let t = target(&design, "10.20.0.21");
    // The reader's test server's key, as `ssh-keygen -l` printed it.
    let fp = "SHA256:/d1tvcieVX3qdA57VhyjGjMJOESBaYv/AxSs54GFg+0";

    let t1 = t.clone();
    let seen = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::record_seen(
                tx,
                auth,
                &keys,
                &t1,
                Protocol::Ssh,
                fp,
                Some("ssh-ed25519"),
            )
            .await
        })
    })
    .await
    .expect("seen");
    assert_eq!(
        (seen.state.as_str(), seen.protocol),
        ("seen", Protocol::Ssh)
    );
    assert_eq!(seen.key_type.as_deref(), Some("ssh-ed25519"));

    // The SNMP agent at the same address is a different row, still unknown.
    let t1 = t.clone();
    let snmp = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::identity_at(
                tx,
                &keys,
                &auth.ctx.tenant().to_string(),
                Protocol::Snmp,
                t1.address,
            )
            .await
        })
    })
    .await
    .unwrap();
    assert!(snmp.is_none(), "{snmp:?}");

    // Capitals count in base64.
    let t1 = t.clone();
    let wrong = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::approve_typed(tx, auth, &keys, &t1, Protocol::Ssh, "S54GFG+0").await
        })
    })
    .await;
    assert!(matches!(wrong, Err(VaultError::NotAllowed(_))), "{wrong:?}");
    let t1 = t.clone();
    let ok = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::approve_typed(tx, auth, &keys, &t1, Protocol::Ssh, "s54GFg+0").await
        })
    })
    .await
    .expect("typed");
    assert_eq!(ok.state, "approved");

    // A new key is `changed`, keeps the confirmed one, and the Steward sees it marked SSH.
    let t1 = t.clone();
    let changed = as_who(&pool, &ring, org, &alice, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::record_seen(
                tx,
                auth,
                &keys,
                &t1,
                Protocol::Ssh,
                "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                Some("ssh-ed25519"),
            )
            .await
        })
    })
    .await
    .unwrap();
    assert_eq!(changed.state, "changed");
    assert_eq!(changed.previous.as_deref(), Some(fp));
    let list = as_who(&pool, &ring, org, &estate.steward, |tx, auth, keys| {
        Box::pin(async move { device_reading::waiting(tx, auth, &keys).await })
    })
    .await
    .expect("the Steward's list");
    assert_eq!(list.len(), 1);
    let shown = String::from_utf8(list[0].to_json().to_canonical_bytes()).unwrap();
    assert!(shown.contains(r#""protocol":"ssh""#), "{shown}");
    assert!(shown.contains(r#""hostKey":"SHA256:AAAA"#), "{shown}");

    // Approving it as an SNMP agent finds nothing; as a host key, on its own, it goes.
    let one: Vec<std::net::IpAddr> = vec!["10.20.0.21".parse().unwrap()];
    let as_snmp = one.clone();
    let refused = as_who(&pool, &ring, org, &estate.steward, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::approve_batch(tx, auth, &keys, Protocol::Snmp, &as_snmp).await
        })
    })
    .await;
    assert!(matches!(refused, Err(VaultError::NotFound)), "{refused:?}");
    let n = as_who(&pool, &ring, org, &estate.steward, move |tx, auth, keys| {
        Box::pin(async move {
            device_reading::approve_batch(tx, auth, &keys, Protocol::Ssh, &one).await
        })
    })
    .await
    .unwrap();
    assert_eq!(n, 1);
}
