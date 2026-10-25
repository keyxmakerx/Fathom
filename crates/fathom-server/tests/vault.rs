//! The password vault, Mode A — `src/vault.rs` and `migrations/0041_vault.sql` — against a
//! real PostgreSQL.
//!
//! The server never holds a key that opens a password, so these tests do not need one either:
//! every "wrap" here is shaped like a real one (a point on the curve, a 12-byte nonce, a 48-byte
//! ciphertext) and every signature is a real ES256 signature by a real enrolled account key,
//! because those are the two things the server checks. What the browser does with them is
//! `client/src/vault/*.test.ts`'s job, and the byte vectors at the bottom are shared with it.
//!
//! **Each test's name is its claim** (CLAUDE.md rule 2).

mod support;

use std::sync::Arc;

use deadpool_postgres::{Pool, Transaction};

use fathom_server::authority::{self, Capability, GrantFacts, SoftwareKey};
use fathom_server::crypto::{self, Key32};
use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant, GrantRequest};
use fathom_server::keys::{self, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId};
use fathom_server::vault::{self, Enrolment, Meta, ShareIn, VaultError, WrapIn};

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
    /// Stands in for the person's vault key: any point on the curve will do for the server.
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
    let salt = [0x5bu8; 16];
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

/// A member with an account key and, when asked, a capability over the whole organisation.
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

fn person_enrolment(org: OrganisationId, p: &Person, vault_key: &SoftwareKey) -> Enrolment {
    let at = now_unix();
    let public = vault_key.public_key().to_vec();
    let signer = p.key.fingerprint().to_vec();
    let bytes = vault::person_key_bytes(
        &org.to_string(),
        &p.account.to_string(),
        &public,
        &signer,
        at as u64,
    );
    Enrolment {
        kind: "person".into(),
        public_key: public,
        sealed_private: vec![7; 160],
        sealed_nonce: vec![1; 12],
        kdf: Some((vec![2; 16], 19_456, 2, 1)),
        signer_key_fpr: signer,
        enrolled_at: at,
        signature: p.key.sign(&bytes).to_vec(),
        succession_sig: None,
    }
}

async fn enrol_vault(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    p: &Person,
) -> Result<vault::KeyView, VaultError> {
    let e = person_enrolment(org, p, &p.vault);
    with_auth(pool, ring, org, p.account, |tx, auth| {
        Box::pin(vault::enrol_key(tx, auth, e))
    })
    .await
}

async fn enrol_recovery(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    p: &Person,
    sheet: &SoftwareKey,
) -> Result<vault::KeyView, VaultError> {
    let at = now_unix();
    let public = sheet.public_key().to_vec();
    let signer = p.key.fingerprint().to_vec();
    let bytes = vault::recovery_key_bytes(
        &org.to_string(),
        &public,
        &p.account.to_string(),
        &signer,
        at as u64,
    );
    let e = Enrolment {
        kind: "recovery".into(),
        public_key: public,
        sealed_private: vec![9; 160],
        sealed_nonce: vec![3; 12],
        kdf: None,
        signer_key_fpr: signer,
        enrolled_at: at,
        signature: p.key.sign(&bytes).to_vec(),
        succession_sig: None,
    };
    with_auth(pool, ring, org, p.account, |tx, auth| {
        Box::pin(vault::enrol_key(tx, auth, e))
    })
    .await
}

/// A wrap the server accepts: a fresh point, a nonce, 48 bytes of "ciphertext".
fn a_wrap(seed: u8) -> Vec<u8> {
    let eph = SoftwareKey::random().unwrap().public_key();
    let mut w = Vec::new();
    crypto::lp(&mut w, &eph);
    crypto::lp(&mut w, &[seed; 12]);
    crypto::lp(&mut w, &[seed; 48]);
    w
}

/// A share signed by `sharer` over exactly the recipients given.
fn a_share(
    org: OrganisationId,
    credential: &str,
    epoch: u32,
    sharer: &Person,
    holders: &[(&vault::KeyView, &str)],
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
            who: who.to_string(),
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

fn a_credential() -> String {
    format!("cred_{}", fathom_server::ids::new_ulid())
}

fn meta(name: &str) -> Meta {
    Meta::clean(name, "login", vec![]).unwrap()
}

async fn create(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    who: &Person,
    credential: &str,
    name: &str,
    share: ShareIn,
) -> Result<vault::EntryView, VaultError> {
    let (credential, m) = (credential.to_string(), meta(name));
    with_auth(pool, ring, org, who.account, |tx, auth| {
        Box::pin(async move {
            vault::create_entry(tx, auth, &credential, m, vec![5; 64], vec![6; 12], share).await
        })
    })
    .await
}

async fn overview(
    pool: &Pool,
    ring: &KeyRing,
    org: OrganisationId,
    who: &Person,
) -> vault::Overview {
    with_auth(pool, ring, org, who.account, |tx, auth| {
        Box::pin(vault::overview(tx, auth))
    })
    .await
    .expect("overview")
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_person_enrols_a_vault_key_signed_by_their_own_account_key_and_a_forged_one_is_refused() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let alice = a_member(&pool, &ring, &estate, "alice", None).await;

    // Signed by somebody else's account key: refused.
    let mut forged = person_enrolment(estate.organisation, &alice, &alice.vault);
    let bytes = vault::person_key_bytes(
        &estate.organisation.to_string(),
        &alice.account.to_string(),
        &forged.public_key,
        &estate.steward.key.fingerprint(),
        forged.enrolled_at as u64,
    );
    forged.signer_key_fpr = estate.steward.key.fingerprint().to_vec();
    forged.signature = estate.steward.key.sign(&bytes).to_vec();
    let refused = with_auth(
        &pool,
        &ring,
        estate.organisation,
        alice.account,
        |tx, auth| Box::pin(vault::enrol_key(tx, auth, forged)),
    )
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );

    // A signature over different bytes: refused.
    let mut tampered = person_enrolment(estate.organisation, &alice, &alice.vault);
    tampered.public_key = SoftwareKey::random().unwrap().public_key().to_vec();
    let refused = with_auth(
        &pool,
        &ring,
        estate.organisation,
        alice.account,
        |tx, auth| Box::pin(vault::enrol_key(tx, auth, tampered)),
    )
    .await;
    assert!(
        matches!(refused, Err(VaultError::Authority(_))),
        "{refused:?}"
    );

    let key = enrol_vault(&pool, &ring, estate.organisation, &alice)
        .await
        .expect("enrolled");
    assert_eq!(key.fpr, vault::key_fpr(&alice.vault.public_key()).to_vec());
    assert!(
        key.own.is_some(),
        "the owner gets back what unlocking needs"
    );

    // A second key without a signed replacement: refused.
    let again = enrol_vault(&pool, &ring, estate.organisation, &alice).await;
    assert!(matches!(again, Err(VaultError::NotAllowed(_))), "{again:?}");

    // The steward sees Alice's key but not its sealed private half.
    let seen = overview(&pool, &ring, estate.organisation, &estate.steward).await;
    let listed = seen
        .people
        .iter()
        .find(|p| p.account == alice.account.to_string())
        .and_then(|p| p.key.clone())
        .expect("alice listed with her key");
    assert!(listed.own.is_none());
    assert_eq!(listed.signer_public_key, alice.key.public_key().to_vec());
}

#[tokio::test]
async fn a_reset_vault_needs_an_account_key_signature_over_both_fingerprints() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let alice = a_member(&pool, &ring, &estate, "alice", None).await;
    let old = enrol_vault(&pool, &ring, estate.organisation, &alice)
        .await
        .unwrap();

    let fresh_key = SoftwareKey::random().unwrap();
    let mut e = person_enrolment(estate.organisation, &alice, &fresh_key);
    let replace = vault::supersede_bytes(
        &estate.organisation.to_string(),
        "person",
        &alice.account.to_string(),
        &old.fpr,
        &vault::key_fpr(&fresh_key.public_key()),
        e.enrolled_at as u64,
    );
    e.succession_sig = Some(alice.key.sign(&replace).to_vec());
    let new = with_auth(
        &pool,
        &ring,
        estate.organisation,
        alice.account,
        |tx, auth| Box::pin(vault::enrol_key(tx, auth, e)),
    )
    .await
    .expect("replaced");
    assert_eq!(new.supersedes.as_ref().unwrap().old_fpr, old.fpr);

    // The old key is no longer anybody's recipient.
    let seen = overview(&pool, &ring, estate.organisation, &alice).await;
    assert_eq!(seen.my_key.unwrap().id, new.id);
}

#[tokio::test]
async fn a_holder_gets_the_ciphertext_an_admin_sees_only_the_name_and_a_stranger_sees_nothing() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let alice = a_member(&pool, &ring, &estate, "alice", None).await;
    let bob = a_member(&pool, &ring, &estate, "bob", None).await;
    let a = enrol_vault(&pool, &ring, estate.organisation, &alice)
        .await
        .unwrap();
    enrol_vault(&pool, &ring, estate.organisation, &bob)
        .await
        .unwrap();
    enrol_vault(&pool, &ring, estate.organisation, &estate.steward)
        .await
        .unwrap();
    let sheet = SoftwareKey::random().unwrap();
    let r = enrol_recovery(&pool, &ring, estate.organisation, &estate.steward, &sheet)
        .await
        .unwrap();

    let id = a_credential();
    let share = a_share(
        estate.organisation,
        &id,
        1,
        &alice,
        &[(&a, &alice.account.to_string()), (&r, "recovery")],
    );
    let made = create(
        &pool,
        &ring,
        estate.organisation,
        &alice,
        &id,
        "core-sw-01 admin",
        share,
    )
    .await
    .expect("stored");
    assert_eq!(made.holders.len(), 2);
    assert!(made.opening.is_some());

    let mine = overview(&pool, &ring, estate.organisation, &alice).await;
    let entry = mine
        .entries
        .iter()
        .find(|e| e.id == id)
        .expect("alice sees it");
    let opening = entry.opening.as_ref().expect("and can open it");
    assert_eq!(opening.secret_ct, vec![5; 64]);
    assert_eq!(opening.sharer_public_key, alice.key.public_key().to_vec());

    let admin = overview(&pool, &ring, estate.organisation, &estate.steward).await;
    assert!(admin.steward);
    let entry = admin
        .entries
        .iter()
        .find(|e| e.id == id)
        .expect("the admin sees it exists");
    assert_eq!(entry.meta.name, "core-sw-01 admin");
    assert!(entry.opening.is_none(), "but is served no ciphertext");

    let stranger = overview(&pool, &ring, estate.organisation, &bob).await;
    assert!(
        stranger.entries.iter().all(|e| e.id != id),
        "bob is not told it exists"
    );
}

#[tokio::test]
async fn a_share_whose_signature_covers_other_recipients_or_whose_wrap_is_off_the_curve_is_refused()
{
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let alice = a_member(&pool, &ring, &estate, "alice", None).await;
    let bob = a_member(&pool, &ring, &estate, "bob", None).await;
    let a = enrol_vault(&pool, &ring, estate.organisation, &alice)
        .await
        .unwrap();
    let b = enrol_vault(&pool, &ring, estate.organisation, &bob)
        .await
        .unwrap();

    // Signed for Alice alone, then the server (or anyone) adds Bob's wrap: refused.
    let id = a_credential();
    let mut share = a_share(
        estate.organisation,
        &id,
        1,
        &alice,
        &[(&a, &alice.account.to_string())],
    );
    share.wraps.push(WrapIn {
        key_id: b.id.clone(),
        wrap: a_wrap(9),
    });
    let refused = create(&pool, &ring, estate.organisation, &alice, &id, "x", share).await;
    assert!(
        matches!(refused, Err(VaultError::Authority(_))),
        "{refused:?}"
    );

    // A wrap whose ephemeral key is not on the curve.
    let id = a_credential();
    let mut share = a_share(
        estate.organisation,
        &id,
        1,
        &alice,
        &[(&a, &alice.account.to_string())],
    );
    let mut eph = alice.vault.public_key();
    eph[64] ^= 1;
    let mut w = Vec::new();
    crypto::lp(&mut w, &eph);
    crypto::lp(&mut w, &[1; 12]);
    crypto::lp(&mut w, &[1; 48]);
    share.wraps[0].wrap = w;
    let refused = create(&pool, &ring, estate.organisation, &alice, &id, "x", share).await;
    assert!(
        matches!(refused, Err(VaultError::Malformed(_))),
        "{refused:?}"
    );

    // A login its creator does not hold.
    let id = a_credential();
    let share = a_share(
        estate.organisation,
        &id,
        1,
        &alice,
        &[(&b, &bob.account.to_string())],
    );
    let refused = create(&pool, &ring, estate.organisation, &alice, &id, "x", share).await;
    assert!(
        matches!(refused, Err(VaultError::Malformed(_))),
        "{refused:?}"
    );

    // A name that carries the password itself.
    let refused = Meta::clean("enable secret cisco123", "login", vec![]);
    assert!(matches!(refused, Err(VaultError::NotAllowed(_))));
}

#[tokio::test]
async fn only_a_holder_starts_a_new_epoch_and_the_owner_cannot_be_left_out() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let alice = a_member(&pool, &ring, &estate, "alice", None).await;
    let bob = a_member(&pool, &ring, &estate, "bob", None).await;
    let a = enrol_vault(&pool, &ring, estate.organisation, &alice)
        .await
        .unwrap();
    let b = enrol_vault(&pool, &ring, estate.organisation, &bob)
        .await
        .unwrap();
    let id = a_credential();
    let share = a_share(
        estate.organisation,
        &id,
        1,
        &alice,
        &[(&a, &alice.account.to_string())],
    );
    let made = create(&pool, &ring, estate.organisation, &alice, &id, "x", share)
        .await
        .unwrap();

    // Bob does not hold it, so Bob cannot share it to himself.
    let bob_share = a_share(
        estate.organisation,
        &id,
        2,
        &bob,
        &[
            (&a, &alice.account.to_string()),
            (&b, &bob.account.to_string()),
        ],
    );
    let id2 = id.clone();
    let refused = with_auth(
        &pool,
        &ring,
        estate.organisation,
        bob.account,
        |tx, auth| {
            Box::pin(async move {
                vault::new_epoch(
                    tx,
                    auth,
                    &id2,
                    made.version,
                    vec![5; 64],
                    vec![6; 12],
                    bob_share,
                    "shared",
                )
                .await
            })
        },
    )
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );

    // Alice shares it with Bob: epoch 2, both hold it.
    let share = a_share(
        estate.organisation,
        &id,
        2,
        &alice,
        &[
            (&a, &alice.account.to_string()),
            (&b, &bob.account.to_string()),
        ],
    );
    let id2 = id.clone();
    let shared = with_auth(
        &pool,
        &ring,
        estate.organisation,
        alice.account,
        |tx, auth| {
            Box::pin(async move {
                vault::new_epoch(
                    tx,
                    auth,
                    &id2,
                    made.version,
                    vec![8; 64],
                    vec![6; 12],
                    share,
                    "shared",
                )
                .await
            })
        },
    )
    .await
    .expect("shared");
    assert_eq!(shared.epoch, 2);
    let seen = overview(&pool, &ring, estate.organisation, &bob).await;
    assert!(seen
        .entries
        .iter()
        .any(|e| e.id == id && e.opening.is_some()));

    // Bob now holds it, but cannot drop Alice, who stored it.
    let share = a_share(
        estate.organisation,
        &id,
        3,
        &bob,
        &[(&b, &bob.account.to_string())],
    );
    let id2 = id.clone();
    let refused = with_auth(
        &pool,
        &ring,
        estate.organisation,
        bob.account,
        |tx, auth| {
            Box::pin(async move {
                vault::new_epoch(
                    tx,
                    auth,
                    &id2,
                    shared.version,
                    vec![8; 64],
                    vec![6; 12],
                    share,
                    "changed",
                )
                .await
            })
        },
    )
    .await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );

    // A stale version is a conflict.
    let share = a_share(
        estate.organisation,
        &id,
        3,
        &alice,
        &[(&a, &alice.account.to_string())],
    );
    let id2 = id.clone();
    let stale = with_auth(
        &pool,
        &ring,
        estate.organisation,
        alice.account,
        |tx, auth| {
            Box::pin(async move {
                vault::new_epoch(
                    tx,
                    auth,
                    &id2,
                    1,
                    vec![8; 64],
                    vec![6; 12],
                    share,
                    "changed",
                )
                .await
            })
        },
    )
    .await;
    assert!(
        matches!(stale, Err(VaultError::Conflict { .. })),
        "{stale:?}"
    );
}

#[tokio::test]
async fn an_admin_takes_access_away_and_the_login_is_marked_for_rotation_and_deletion_keeps_no_ciphertext(
) {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let alice = a_member(&pool, &ring, &estate, "alice", None).await;
    let bob = a_member(&pool, &ring, &estate, "bob", None).await;
    let a = enrol_vault(&pool, &ring, estate.organisation, &alice)
        .await
        .unwrap();
    let b = enrol_vault(&pool, &ring, estate.organisation, &bob)
        .await
        .unwrap();
    let id = a_credential();
    let share = a_share(
        estate.organisation,
        &id,
        1,
        &alice,
        &[
            (&a, &alice.account.to_string()),
            (&b, &bob.account.to_string()),
        ],
    );
    let made = create(&pool, &ring, estate.organisation, &alice, &id, "x", share)
        .await
        .unwrap();

    // Bob may not take Alice's own access away; nor may anyone remove the owner.
    let (id2, aid) = (id.clone(), a.id.clone());
    let refused = with_auth(
        &pool,
        &ring,
        estate.organisation,
        bob.account,
        |tx, auth| {
            Box::pin(async move { vault::revoke_wrap(tx, auth, &id2, made.version, &aid).await })
        },
    )
    .await;
    assert!(matches!(refused, Err(VaultError::NotAllowed(_))));
    let (id2, aid) = (id.clone(), a.id.clone());
    let refused = with_auth(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        |tx, auth| {
            Box::pin(async move { vault::revoke_wrap(tx, auth, &id2, made.version, &aid).await })
        },
    )
    .await;
    assert!(matches!(refused, Err(VaultError::NotAllowed(_))));

    // The admin removes Bob.
    let (id2, bid) = (id.clone(), b.id.clone());
    let revoked = with_auth(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        |tx, auth| {
            Box::pin(async move { vault::revoke_wrap(tx, auth, &id2, made.version, &bid).await })
        },
    )
    .await
    .expect("revoked");
    assert!(revoked.needs_rotation);
    let seen = overview(&pool, &ring, estate.organisation, &bob).await;
    assert!(
        seen.entries.iter().all(|e| e.id != id),
        "bob is no longer served it"
    );

    // Deleted: the tombstone remains, the ciphertext does not.
    let id2 = id.clone();
    with_auth(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        |tx, auth| {
            Box::pin(async move { vault::delete_entry(tx, auth, &id2, revoked.version).await })
        },
    )
    .await
    .expect("deleted");
    let su = support::superuser_client_on_test_database().await;
    let row = su
        .query_one(
            "SELECT octet_length(secret_ct), deleted_at IS NOT NULL FROM vault.entries WHERE id = $1",
            &[&id],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, i32>(0), 0);
    assert!(row.get::<_, bool>(1));
}

#[tokio::test]
async fn only_an_admin_makes_the_recovery_sheet_and_every_opening_is_recorded_before_it_is_served()
{
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let alice = a_member(&pool, &ring, &estate, "alice", None).await;
    let a = enrol_vault(&pool, &ring, estate.organisation, &alice)
        .await
        .unwrap();
    let sheet = SoftwareKey::random().unwrap();

    let refused = enrol_recovery(&pool, &ring, estate.organisation, &alice, &sheet).await;
    assert!(
        matches!(refused, Err(VaultError::NotAllowed(_))),
        "{refused:?}"
    );
    let r = enrol_recovery(&pool, &ring, estate.organisation, &estate.steward, &sheet)
        .await
        .expect("the admin makes it");

    let id = a_credential();
    let share = a_share(
        estate.organisation,
        &id,
        1,
        &alice,
        &[(&a, &alice.account.to_string()), (&r, "recovery")],
    );
    create(&pool, &ring, estate.organisation, &alice, &id, "x", share)
        .await
        .unwrap();

    let refused = with_auth(
        &pool,
        &ring,
        estate.organisation,
        alice.account,
        |tx, auth| Box::pin(vault::open_recovery(tx, auth)),
    )
    .await;
    assert!(matches!(refused, Err(VaultError::NotAllowed(_))));

    let opened = with_auth(
        &pool,
        &ring,
        estate.organisation,
        estate.steward.account,
        |tx, auth| Box::pin(vault::open_recovery(tx, auth)),
    )
    .await
    .expect("opened");
    assert_eq!(opened.sealed_private, vec![9; 160]);
    assert!(opened
        .entries
        .iter()
        .any(|e| e.id == id && e.opening.is_some()));
    let seen = overview(&pool, &ring, estate.organisation, &alice).await;
    assert_eq!(
        seen.recovery_uses.len(),
        1,
        "everyone sees the sheet was opened"
    );
    assert_eq!(seen.recovery_uses[0].by, estate.steward.account.to_string());
}

#[tokio::test]
async fn a_login_name_is_never_stored_in_the_clear() {
    let pool = support::migrated_pool().await;
    let ring = ring();
    let estate = bootstrap(&pool, &ring).await;
    let alice = a_member(&pool, &ring, &estate, "alice", None).await;
    let a = enrol_vault(&pool, &ring, estate.organisation, &alice)
        .await
        .unwrap();
    let marker = format!("vault-marker-{}", std::process::id());
    let id = a_credential();
    let share = a_share(
        estate.organisation,
        &id,
        1,
        &alice,
        &[(&a, &alice.account.to_string())],
    );
    create(
        &pool,
        &ring,
        estate.organisation,
        &alice,
        &id,
        &marker,
        share,
    )
    .await
    .unwrap();
    let su = support::superuser_client_on_test_database().await;
    for table in ["keys", "entries", "wraps", "shares", "recovery_uses"] {
        let found: i64 = su
            .query_one(
                &format!(
                    "SELECT count(*) FROM vault.{table} t WHERE t::text ILIKE '%' || $1 || '%'"
                ),
                &[&marker],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(found, 0, "the name is in the clear in vault.{table}");
    }
    // Positive control: the id is in the clear, and the same sweep finds it.
    let found: i64 = su
        .query_one(
            "SELECT count(*) FROM vault.entries t WHERE t::text ILIKE '%' || $1 || '%'",
            &[&id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(found, 1);
}

#[tokio::test]
async fn the_operator_plane_cannot_see_the_vault_schema_at_all() {
    let _pool = support::migrated_pool().await;
    let su = support::superuser_client_on_test_database().await;
    let row = su
        .query_one(
            "SELECT has_schema_privilege('fathom_operator', 'vault', 'USAGE'), \
                    has_schema_privilege('fathom_app', 'vault', 'USAGE')",
            &[],
        )
        .await
        .unwrap();
    assert!(
        !row.get::<_, bool>(0),
        "the operator plane can name vault tables"
    );
    assert!(row.get::<_, bool>(1));
    // No DELETE for the app on any vault table.
    for table in ["keys", "entries", "wraps", "shares", "recovery_uses"] {
        let can: bool = su
            .query_one(
                "SELECT has_table_privilege('fathom_app', $1, 'DELETE')",
                &[&format!("vault.{table}")],
            )
            .await
            .unwrap()
            .get(0);
        assert!(!can, "fathom_app may DELETE from vault.{table}");
    }
}

// ---------------------------------------------------------------------------
// Byte vectors shared with `client/src/vault/bytes.test.ts`. Fixed inputs; the SHA-256 of
// each byte string is pinned on both sides, so the two builders cannot drift apart.
// ---------------------------------------------------------------------------

fn sha(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    vault::hex(&Sha256::digest(bytes))
}

#[test]
fn the_signed_byte_strings_match_the_clients() {
    let org = "01JORG0000000000000000000A";
    let account = "01JACC0000000000000000000B";
    let public = [4u8; 65];
    let signer = [0x11u8; 32];
    let person = vault::person_key_bytes(org, account, &public, &signer, 1_761_400_000);
    let recovery = vault::recovery_key_bytes(org, &public, account, &signer, 1_761_400_000);
    let supersede =
        vault::supersede_bytes(org, "person", account, &[1; 32], &[2; 32], 1_761_400_000);
    let share = vault::share_bytes(
        org,
        "cred_01JCRED000000000000000000",
        2,
        &[
            vault::Recipient {
                who: "recovery".into(),
                key_fpr: [3; 32],
                digest: [4; 32],
            },
            vault::Recipient {
                who: account.into(),
                key_fpr: [5; 32],
                digest: [6; 32],
            },
        ],
        account,
        &signer,
        1_761_400_000,
    );
    let printed = [
        ("person", sha(&person)),
        ("recovery", sha(&recovery)),
        ("supersede", sha(&supersede)),
        ("share", sha(&share)),
        ("fpr", vault::hex(&vault::key_fpr(&public))),
        ("digest", vault::hex(&vault::wrap_digest(&[7; 137]))),
    ];
    let pinned = [
        (
            "person",
            "eb716eb9954df8c5a3eb6bbf998dd3c7b66381f19b7bf86995bf355adbfc49b3",
        ),
        (
            "recovery",
            "1d179ca1b47ccab474b62c416b2b02b601f25930596af12e7e016643e241e8fa",
        ),
        (
            "supersede",
            "14688e920cf26338b5f773b5030d87d196022a0f4f985fed73508730208c9dd8",
        ),
        (
            "share",
            "d857a8c2a17c0458ab354c3f27a0e6ef1c8e1ef6b6bc0c6a99f51ee062b47d16",
        ),
        (
            "fpr",
            "df20fa2559b3e586ccfc19b3bae30ee60a22ef6cd236d45a8eb8a823680b9bec",
        ),
        (
            "digest",
            "b31a268762219208e5f71191e9338a8b711799df3f7d1f8d80ca30048832ba2a",
        ),
    ];
    for ((name, got), (pinned_name, want)) in printed.iter().zip(pinned) {
        assert_eq!(*name, pinned_name);
        assert_eq!(
            got, want,
            "{name} bytes changed: the client's builder must change with it"
        );
    }
}
