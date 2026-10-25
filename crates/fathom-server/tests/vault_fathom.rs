//! Logins Fathom itself can use — the vault's Mode B, `src/vault_fathom.rs` and
//! `migrations/0042_vault_fathom.sql` — against a real PostgreSQL.
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
    let org = estate.organisation;
    let id = format!("cred_{}", fathom_server::ids::new_ulid());
    let meta = Meta::clean(
        "core-sw admin",
        "login",
        vec![(design.to_string(), "dev-1".to_string())],
    )
    .unwrap();
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
    let (id, version, copy) = (entry.id.clone(), entry.version, the_login(password));
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
