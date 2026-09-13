//! The authority layer against a real PostgreSQL: the fences, the signatures
//! and the head.
//!
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §§2, 3.2–3.5 and §6.1.
//!
//! **Every test here is written against a claim, and its name is the claim.**
//! CLAUDE.md rule 2: a gate is tested against what a real attacker can do, not
//! against what the check needs. So:
//!
//! - the operator fence is driven **as the bootstrap superuser**, because the
//!   claim is *"including `psql` as superuser"* and a test that used the
//!   restricted runtime role would have proved something weaker while looking
//!   identical;
//! - the unsigned grant is **inserted through the real write path with a
//!   correct row seal and a head advanced over it**, so that it survives every
//!   check but the signature — proving the refusal happens at USE, rather than
//!   proving that an insert path nobody attacks refuses it;
//! - the high-`s` signature is a **real, valid ECDSA signature** over the real
//!   message under the real key, produced by negating `s`, not a corrupted
//!   blob that any check would reject.

mod support;

use std::collections::BTreeMap;

use deadpool_postgres::Pool;
use fathom_canon::Json;
use tokio_postgres::error::SqlState;

use fathom_server::authority::{
    self, Capability, GrantFacts, SignatureRefused, SoftwareKey, ALG_ES256,
};
use fathom_server::chain::{ChainRef, EntryType, Outcome};
use fathom_server::chains;
use fathom_server::crypto::Key32;
use fathom_server::grants::{
    self, Authority, AuthorityError, EpochWatch, GenesisGrant, GrantRequest,
};
use fathom_server::keys::{self, DataKey, KeyRing};
use fathom_server::repo::{self, AccountId, OrganisationId, ScopeKind};

/// The one master key this test database is encrypted under — the same value
/// `design_storage.rs` and `audit_chains.rs` use, because ADR-0043 §4 stamps
/// the configured key's id per database and refuses a second.
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

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

async fn an_account(pool: &Pool, name: &str) -> AccountId {
    repo::create_account(pool, &unique(name), name)
        .await
        .expect("create account")
        .id
}

/// A software key for an account, enrolled through the real path.
struct Signer {
    account: AccountId,
    key: SoftwareKey,
}

/// One bootstrapped organisation with `stewards.len()` genesis stewards.
struct Estate {
    organisation: OrganisationId,
    root: SoftwareKey,
    stewards: Vec<Signer>,
}

/// §6.1's genesis, driven exactly as a browser would: derive the id from the
/// root public key and a salt, sign the genesis grants with the root private
/// key, hand the server the public half and the signatures.
async fn bootstrap(pool: &Pool, ring: &KeyRing, steward_count: usize) -> Estate {
    let root = SoftwareKey::random().expect("a root keypair");
    let salt = [0x5au8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());

    // Accounts and their keys have to exist before genesis: §6.4 —*"there is
    // no way to grant access to a phantom account"* — so a genesis grant names
    // a subject who already holds a key.
    let mut client = pool.get().await.expect("connection");
    let mut stewards = Vec::new();
    for n in 0..steward_count {
        let account = an_account(pool, &format!("steward{n}")).await;
        stewards.push(Signer {
            account,
            key: SoftwareKey::random().expect("a steward keypair"),
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

    // The keys are enrolled AFTER the organisation exists, because
    // `account_keys` is read through a policy that needs a tenant context —
    // so genesis names fingerprints, and the keyring rows that resolve them
    // land in the same story. The grants do not verify until both halves are
    // there, which is the point of `authorise_account` running at use.
    let tx = client.transaction().await.expect("begin");
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
    tx.commit().await.expect("commit");

    for (n, steward) in stewards.iter().enumerate() {
        if n > 0 {
            repo::add_member(
                pool,
                genesis.organisation,
                stewards[0].account,
                steward.account,
                repo::Role::Member,
            )
            .await
            .expect("membership");
        }
        let tx = client.transaction().await.expect("begin");
        let ctx = repo::open_tenant_context(&tx, genesis.organisation, steward.account)
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
        grants::enrol_software_key(&tx, &auth, &steward.key.public_key())
            .await
            .expect("enrol");
        tx.commit().await.expect("commit");
    }

    Estate {
        organisation: genesis.organisation,
        root,
        stewards,
    }
}

/// Open a transaction with everything an authority act needs.
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

// ---------------------------------------------------------------------------
// §6.1 — the bootstrap path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn genesis_derives_the_organisation_id_from_the_root_key_and_authorises_its_stewards() {
    let pool = support::migrated_pool().await;
    let ring = keyring(61);
    let estate = bootstrap(&pool, &ring, 1).await;

    // The id IS the derivation. §6.1: *"a re-minted genesis under a different
    // key yields a different organisation id and matches no existing row."*
    assert_eq!(
        estate.organisation.to_string(),
        authority::derive_organisation_id(&estate.root.public_key(), &[0x5au8; 16])
    );

    let mut client = pool.get().await.expect("connection");
    let (tx, ctx, _key) = acting(
        &mut client,
        &ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;
    let tenant_key = keys::tenant_key(&tx, &ring, &ctx)
        .await
        .expect("tenant key");
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };

    let capabilities = grants::authorise_account(&tx, &auth, None, Capability::Steward)
        .await
        .expect("the genesis steward is a steward");
    assert_eq!(capabilities.capability, Capability::Steward);
    assert_eq!(capabilities.auth_epoch, 1);

    // And the organisation chain carries the acts, sealed.
    let report = chains::verify_org(&tx, &ring, &ctx, true)
        .await
        .expect("verify");
    assert!(
        matches!(report.outcome, Outcome::Verified { .. }),
        "{report}"
    );

    let types: Vec<String> = tx
        .query(
            "SELECT entry_type FROM chain_entries \
              WHERE chain_kind = 'org' AND chain_id = $1 ORDER BY seq",
            &[&estate.organisation.to_string()],
        )
        .await
        .expect("entries")
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(
        types,
        vec![
            EntryType::OrgGenesis.as_str(),
            EntryType::GrantSigned.as_str(),
            EntryType::AuthHeadAdvanced.as_str(),
            EntryType::AccountKeyEnrolled.as_str(),
        ],
        "every signed act writes the sealed entry §7.2 names"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_genesis_grant_signed_by_the_wrong_key_is_refused_before_anything_is_stored() {
    let pool = support::migrated_pool().await;
    let ring = keyring(62);
    let root = SoftwareKey::random().unwrap();
    let impostor = SoftwareKey::random().unwrap();
    let salt = [0x11u8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());
    let account = an_account(&pool, "founder").await;
    let key = SoftwareKey::random().unwrap();
    let subject_key_fpr = authority::key_fingerprint(&key.public_key());
    let now = now_unix();

    let facts = GrantFacts {
        organisation: &organisation_id,
        root_pubkey_fpr: &root_fpr,
        scope: "",
        subject: &account.to_string(),
        subject_key_fpr: &subject_key_fpr,
        capability: Capability::Steward,
        granter: None,
        granter_key_fpr: &root_fpr,
        effective_from_unix: now,
        expires_at_unix: now + 3600,
        auth_epoch: 1,
    };
    // Signed by a key that is not the root: exactly the "re-mint a genesis"
    // move, one step earlier than §6.1's id derivation catches it.
    let signature = impostor.sign(&authority::grant_bytes(&facts));

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let refused = grants::bootstrap_organisation(
        &tx,
        &ring,
        account,
        "Impostor",
        &root.public_key(),
        &salt,
        &[GenesisGrant {
            subject: account,
            subject_key_fpr,
            capability: Capability::Steward,
            effective_from_unix: now,
            expires_at_unix: now + 3600,
            signature,
        }],
    )
    .await;
    assert!(
        matches!(
            refused,
            Err(AuthorityError::Signature(SignatureRefused::DoesNotVerify))
        ),
        "{refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// §2 — an operator principal is unrepresentable
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_superuser_cannot_put_an_operator_principal_in_any_authority_row() {
    let pool = support::migrated_pool().await;
    let ring = keyring(63);
    let estate = bootstrap(&pool, &ring, 1).await;
    let steward = estate.stewards[0].account.to_string();
    let organisation = estate.organisation.to_string();

    // THE MOST PRIVILEGED ROLE THE ENVIRONMENT HAS. §2's claim is *"in every
    // session, at every privilege level, through every interface, including
    // psql as superuser"*, and a superuser is exempt from row security but
    // not from referential integrity.
    let su = support::superuser_client_on_test_database().await;
    let operator = fathom_server::ids::new_ulid().to_string();
    su.execute(
        "INSERT INTO principals (id, kind) VALUES ($1, 'operator')",
        &[&operator],
    )
    .await
    .expect("an operator principal exists");
    su.execute(
        "INSERT INTO operators (id, display_name) VALUES ($1, 'An operator')",
        &[&operator],
    )
    .await
    .expect("the operator register accepts it");

    let grant_id: String = su
        .query_one(
            "SELECT id FROM scope_grants WHERE organisation_id = $1 LIMIT 1",
            &[&organisation],
        )
        .await
        .expect("the genesis grant")
        .get(0);
    let key_id: String = su
        .query_one(
            "SELECT id FROM account_keys WHERE account_id = $1",
            &[&steward],
        )
        .await
        .expect("the steward's key")
        .get(0);

    // One probe per authority row an operator must not appear in. Each is a
    // real INSERT of a real shape with the operator id in the one column
    // under test.
    let probes: Vec<(&str, &str, Vec<&(dyn tokio_postgres::types::ToSql + Sync)>)> = vec![
        (
            "scope_grants.subject_id",
            "INSERT INTO scope_grants (id, organisation_id, subject_id, subject_key_fpr, \
                 capability, granter_kind, granted_by, granter_key_fpr, granter_sig, auth_epoch, \
                 effective_from, chain_seq, row_seal) \
             SELECT $1, organisation_id, $2, subject_key_fpr, 'read', granter_kind, granted_by, \
                    granter_key_fpr, granter_sig, auth_epoch, effective_from, chain_seq, row_seal \
               FROM scope_grants WHERE id = $3",
            vec![&"01JQZ0000000000000000000ZZ", &operator, &grant_id],
        ),
        (
            "scope_grants.granted_by",
            "INSERT INTO scope_grants (id, organisation_id, subject_id, subject_key_fpr, \
                 capability, granter_kind, granted_by, granter_key_fpr, granter_sig, auth_epoch, \
                 effective_from, chain_seq, row_seal) \
             SELECT $1, organisation_id, subject_id, subject_key_fpr, 'read', 'account', $2, \
                    granter_key_fpr, granter_sig, auth_epoch, effective_from, chain_seq, row_seal \
               FROM scope_grants WHERE id = $3",
            vec![&"01JQZ0000000000000000000YY", &operator, &grant_id],
        ),
        (
            "grant_secondings.seconded_by",
            "INSERT INTO grant_secondings (id, grant_id, organisation_id, grant_subject_id, \
                 grant_granter_id, seconded_by, seconder_key_fpr, seconder_sig, chain_seq, \
                 row_seal) \
             VALUES ($1, $2, $3, $4, $4, $5, decode(repeat('11', 32), 'hex'), \
                     decode(repeat('22', 64), 'hex'), 1, decode(repeat('33', 32), 'hex'))",
            vec![
                &"01JQZ0000000000000000000XX",
                &grant_id,
                &organisation,
                &steward,
                &operator,
            ],
        ),
        (
            "grant_revocations.revoked_by",
            "INSERT INTO grant_revocations (grant_id, organisation_id, revoked_by, \
                 revoker_key_fpr, revoked_sig, chain_seq, row_seal) \
             VALUES ($1, $2, $3, decode(repeat('11', 32), 'hex'), \
                     decode(repeat('22', 64), 'hex'), 1, decode(repeat('33', 32), 'hex'))",
            vec![&grant_id, &organisation, &operator],
        ),
        (
            "account_keys.account_id",
            "INSERT INTO account_keys (id, account_id, key_source, public_key, alg, fpr, \
                 enrolled_seq, row_seal) \
             SELECT $1, $2, key_source, public_key, alg, decode(repeat('44', 32), 'hex'), \
                    enrolled_seq, row_seal FROM account_keys WHERE id = $3",
            vec![&"01JQZ0000000000000000000WW", &operator, &key_id],
        ),
    ];

    for (what, sql, params) in probes {
        let refused = su.execute(sql, &params).await;
        let error = refused.expect_err(&format!("{what} must refuse an operator principal"));
        assert_eq!(
            error.code(),
            Some(&SqlState::FOREIGN_KEY_VIOLATION),
            "{what}: {error}"
        );
    }

    // §1.1 gives an operator exactly one authority-adjacent verb — suspend —
    // and `0011` refuses the other half of it. The row shape is legal; the
    // ACT is not.
    let lifting = su
        .execute(
            "INSERT INTO grant_suspensions (grant_id, organisation_id, action, actor_kind, \
                 actor_id, at, chain_seq, row_seal) \
             VALUES ($1, $2, 'unsuspend', 'operator', $3, now(), 1, \
                     decode(repeat('33', 32), 'hex'))",
            &[&grant_id, &organisation, &operator],
        )
        .await
        .expect_err("an operator may not lift a suspension");
    assert_eq!(
        lifting.code(),
        Some(&SqlState::CHECK_VIOLATION),
        "{lifting}"
    );
}

// ---------------------------------------------------------------------------
// §3.4 — verification at use
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_grant_nobody_signed_is_stored_happily_and_grants_nothing_at_use() {
    let pool = support::migrated_pool().await;
    let ring = keyring(64);
    let estate = bootstrap(&pool, &ring, 1).await;
    let subject = an_account(&pool, "newcomer").await;
    repo::add_member(
        &pool,
        estate.organisation,
        estate.stewards[0].account,
        subject,
        repo::Role::Member,
    )
    .await
    .expect("membership");

    let subject_key = SoftwareKey::random().unwrap();
    let mut client = pool.get().await.expect("connection");
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::enrol_software_key(&tx, &auth, &subject_key.public_key())
            .await
            .expect("enrol");
        tx.commit().await.expect("commit");
    }

    // The forged row: every column right, a correct row seal (the attacker in
    // this test holds the chain key, which is generous), and a signature over
    // nothing. Then the head is advanced THROUGH THE REAL API, so the live
    // digest covers it and every check but the signature passes.
    let (tx, ctx, tenant_key) = acting(
        &mut client,
        &ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;
    let organisation = estate.organisation.to_string();
    let subject_fpr = authority::key_fingerprint(&subject_key.public_key());
    let granter_fpr = authority::key_fingerprint(&estate.stewards[0].key.public_key());
    let now = now_unix();
    let grant_id = fathom_server::ids::new_ulid().to_string();

    let row_state = {
        let mut map = BTreeMap::new();
        map.insert("auth_epoch".to_string(), Json::Int(2));
        map.insert("capability".to_string(), Json::Str("draw".to_string()));
        map.insert("effective_from".to_string(), Json::Int(now));
        map.insert("expires_at".to_string(), Json::Int(0));
        map.insert(
            "granted_by".to_string(),
            Json::Str(estate.stewards[0].account.to_string()),
        );
        map.insert("granter_key_fpr".to_string(), Json::Str(hex(&granter_fpr)));
        map.insert("granter_sig".to_string(), Json::Str(hex(&[0x77u8; 64])));
        map.insert("is_genesis".to_string(), Json::Bool(false));
        map.insert("is_recovery".to_string(), Json::Bool(false));
        map.insert(
            "organisation_id".to_string(),
            Json::Str(organisation.clone()),
        );
        map.insert("scope_id".to_string(), Json::Null);
        map.insert("sole_steward_appointment".to_string(), Json::Bool(false));
        map.insert("subject_id".to_string(), Json::Str(subject.to_string()));
        map.insert("subject_key_fpr".to_string(), Json::Str(hex(&subject_fpr)));
        Json::Obj(map).to_canonical_bytes()
    };
    // The chain master this test's ring was built with -- the test knows it,
    // because it chose it, rather than widening the crate's API to read it
    // back out of the ring.
    let chain_master = Key32::from_bytes([64u8; 32]);
    let chain_key = fathom_server::chain::chain_key(
        &chain_master,
        ChainRef::Org {
            organisation: &organisation,
        },
        chains::CHAIN_KEY_EPOCH,
    );
    let seal = authority::row_seal(
        &authority::row_key(&chain_key),
        &authority::RowFacts {
            table: "scope_grants",
            row_id: &grant_id,
            chain_seq: 1,
            row_version: 1,
            row_state: &row_state,
        },
    );

    tx.execute(
        "INSERT INTO scope_grants (id, organisation_id, subject_id, subject_key_fpr, capability, \
             granter_kind, granted_by, granter_key_fpr, granter_sig, auth_epoch, effective_from, \
             chain_seq, row_version, row_seal) \
         VALUES ($1, $2, $3, $4, 'draw', 'account', $5, $6, $7, 2, to_timestamp($8::bigint), 1, \
                 1, $9)",
        &[
            &grant_id,
            &organisation,
            &subject.to_string(),
            &subject_fpr.to_vec(),
            &estate.stewards[0].account.to_string(),
            &granter_fpr.to_vec(),
            &vec![0x77u8; 64],
            &now,
            &seal.to_vec(),
        ],
    )
    .await
    .expect("the database stores it -- nothing here is a signature check");

    // The head, advanced over the forged row by the real code.
    grants::advance_head(&tx, &ring, &ctx, &tenant_key)
        .await
        .expect("advance");
    tx.commit().await.expect("commit");

    // At use, as the subject: the row seal recomputes, the head agrees, and
    // the signature is what refuses.
    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let refused = grants::authorise_account(&tx, &auth, None, Capability::Draw).await;
    assert!(
        matches!(
            refused,
            Err(AuthorityError::Signature(SignatureRefused::DoesNotVerify))
        ),
        "a grant is checked at USE, not merely at insert: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_hand_inserted_grant_that_the_head_does_not_cover_makes_the_authority_unverifiable() {
    let pool = support::migrated_pool().await;
    let ring = keyring(65);
    let estate = bootstrap(&pool, &ring, 1).await;
    let mut client = pool.get().await.expect("connection");
    let (tx, ctx, tenant_key) = acting(
        &mut client,
        &ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;

    tx.execute(
        "INSERT INTO scope_grants (id, organisation_id, subject_id, subject_key_fpr, capability, \
             granter_kind, granted_by, granter_key_fpr, granter_sig, auth_epoch, effective_from, \
             chain_seq, row_version, row_seal) \
         SELECT $1, organisation_id, subject_id, subject_key_fpr, 'draw', granter_kind, \
                granted_by, granter_key_fpr, granter_sig, auth_epoch, effective_from, chain_seq, \
                row_version, row_seal \
           FROM scope_grants WHERE organisation_id = $2 LIMIT 1",
        &[
            &fathom_server::ids::new_ulid().to_string(),
            &estate.organisation.to_string(),
        ],
    )
    .await
    .expect("stored");

    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let refused = grants::authorise_account(&tx, &auth, None, Capability::Steward).await;
    assert!(
        matches!(refused, Err(AuthorityError::Unverifiable("live set"))),
        "an extra live row the sealed head does not cover must fail CLOSED and not as a \
         permission error: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// §3 — the malleability corrections
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_high_s_signature_over_the_right_message_is_refused() {
    // A REAL signature: the same (r, −s) pair any ECDSA implementation
    // accepts, produced from a genuine one. Not a corrupted blob — the claim
    // is that this product admits ONE encoding per act, not that it notices
    // damage.
    let key = SoftwareKey::random().unwrap();
    let message = b"fathom/grant/v1 pretend this is a grant";
    let low = key.sign(message);
    assert_eq!(
        authority::verify_es256(&key.public_key(), message, &low),
        Ok(())
    );

    let high = high_s_twin(&low);
    assert_ne!(low, high, "the twin must be a different byte string");
    assert_eq!(
        authority::verify_es256(&key.public_key(), message, &high),
        Err(SignatureRefused::HighS),
        "the malleable twin of a valid signature is a valid ECDSA signature and is refused"
    );
}

#[tokio::test]
async fn a_der_encoding_of_a_valid_signature_is_refused_by_length() {
    let key = SoftwareKey::random().unwrap();
    let message = b"fathom/grant/v1 pretend this is a grant";
    let fixed = key.sign(message);
    let parsed = p256::ecdsa::Signature::from_slice(&fixed).unwrap();
    // `to_der` exists because `p256 0.14.0`'s own manifest turns the `ecdsa`
    // crate's `der` feature on. This workspace never asks for it — which is
    // exactly what this test proves is enforced rather than merely intended.
    let der = parsed.to_der();
    let der_bytes = der.as_bytes();
    assert_ne!(der_bytes.len(), 64);
    assert_eq!(
        authority::verify_es256(&key.public_key(), message, der_bytes),
        Err(SignatureRefused::WrongLength {
            len: der_bytes.len()
        })
    );
}

#[tokio::test]
async fn a_seconding_bound_to_an_encoding_of_the_signature_does_not_verify() {
    let pool = support::migrated_pool().await;
    let ring = keyring(66);
    let estate = bootstrap(&pool, &ring, 2).await;
    let subject = an_account(&pool, "candidate").await;
    repo::add_member(
        &pool,
        estate.organisation,
        estate.stewards[0].account,
        subject,
        repo::Role::Member,
    )
    .await
    .expect("membership");
    let subject_key = SoftwareKey::random().unwrap();

    let mut client = pool.get().await.expect("connection");
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::enrol_software_key(&tx, &auth, &subject_key.public_key())
            .await
            .expect("enrol");
        tx.commit().await.expect("commit");
    }

    // A real steward grant, signed by steward 0, needing steward 1's second.
    let grant_id = {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let id = sign_a_grant(
            &tx,
            &auth,
            &estate,
            0,
            subject,
            &subject_key,
            Capability::Steward,
            now_unix() + 3600,
        )
        .await;
        tx.commit().await.expect("commit");
        id
    };

    // Steward 1 seconds — but over the SUPERSEDED construction, which bound
    // `LP(H(granter_sig))`. §3's correction is exactly that this is a
    // statement about an encoding rather than about a fact.
    let (tx, ctx, tenant_key) = acting(
        &mut client,
        &ring,
        estate.organisation,
        estate.stewards[1].account,
    )
    .await;
    let granter_sig: Vec<u8> = tx
        .query_one(
            "SELECT granter_sig FROM scope_grants WHERE id = $1",
            &[&grant_id],
        )
        .await
        .expect("the grant")
        .get(0);

    let superseded_message = {
        use sha2::{Digest, Sha256};
        let sig_hash: [u8; 32] = Sha256::digest(&granter_sig).into();
        let grant_hash: [u8; 32] =
            Sha256::digest(grant_bytes_for(&tx, &ring, &grant_id).await).into();
        let mut msg = Vec::new();
        lp(&mut msg, b"fathom/grant/second/v1");
        lp(&mut msg, &grant_hash);
        lp(&mut msg, &sig_hash);
        msg
    };
    let signature = estate.stewards[1].key.sign(&superseded_message);

    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let refused = grants::second_grant(&tx, &auth, &grant_id, &signature).await;
    assert!(
        matches!(
            refused,
            Err(AuthorityError::Signature(SignatureRefused::DoesNotVerify))
        ),
        "a seconding must bind the FACT -- LP(H(grant_bytes)) || LP(granter_key_fpr) -- and a \
         signature over the superseded, signature-bound message must not pass: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// §3.5 — quorum and the sole steward
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_second_steward_needs_a_seconding_and_is_useless_until_it_arrives() {
    let pool = support::migrated_pool().await;
    let ring = keyring(67);
    let estate = bootstrap(&pool, &ring, 2).await;
    let subject = an_account(&pool, "candidate").await;
    repo::add_member(
        &pool,
        estate.organisation,
        estate.stewards[0].account,
        subject,
        repo::Role::Member,
    )
    .await
    .expect("membership");
    let subject_key = SoftwareKey::random().unwrap();
    let mut client = pool.get().await.expect("connection");
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::enrol_software_key(&tx, &auth, &subject_key.public_key())
            .await
            .expect("enrol");
        tx.commit().await.expect("commit");
    }

    let expires = now_unix() + 3600;
    let grant_id = {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let id = sign_a_grant(
            &tx,
            &auth,
            &estate,
            0,
            subject,
            &subject_key,
            Capability::Steward,
            expires,
        )
        .await;
        tx.commit().await.expect("commit");
        id
    };

    // Two live stewards, so §3.5's quorum is 2 and one signature is not it.
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let refused = grants::authorise_account(&tx, &auth, None, Capability::Steward).await;
        assert!(
            matches!(refused, Err(AuthorityError::QuorumNotMet { .. })),
            "{refused:?}"
        );
        tx.rollback().await.expect("rollback");
    }

    // The second steward seconds, over the corrected construction.
    {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[1].account,
        )
        .await;
        let grant_bytes = grant_bytes_for(&tx, &ring, &grant_id).await;
        let granter_fpr = authority::key_fingerprint(&estate.stewards[0].key.public_key());
        let signature = estate.stewards[1]
            .key
            .sign(&authority::second_bytes(&grant_bytes, &granter_fpr));
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::second_grant(&tx, &auth, &grant_id, &signature)
            .await
            .expect("the seconding verifies");
        tx.commit().await.expect("commit");
    }

    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let capabilities = grants::authorise_account(&tx, &auth, None, Capability::Steward)
        .await
        .expect("seconded, and now usable");
    assert_eq!(capabilities.capability, Capability::Steward);
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_sole_steward_may_appoint_a_second_alone_and_it_waits_a_day() {
    // §3.5's deadlock, solved rather than declared: *"a sole steward can
    // otherwise never appoint a second, because appointing one needs two"*.
    let pool = support::migrated_pool().await;
    let ring = keyring(68);
    let estate = bootstrap(&pool, &ring, 1).await;
    let subject = an_account(&pool, "second-steward").await;
    repo::add_member(
        &pool,
        estate.organisation,
        estate.stewards[0].account,
        subject,
        repo::Role::Member,
    )
    .await
    .expect("membership");
    let subject_key = SoftwareKey::random().unwrap();
    let mut client = pool.get().await.expect("connection");
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::enrol_software_key(&tx, &auth, &subject_key.public_key())
            .await
            .expect("enrol");
        tx.commit().await.expect("commit");
    }

    let (tx, ctx, tenant_key) = acting(
        &mut client,
        &ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let grant_id = sign_a_grant(
        &tx,
        &auth,
        &estate,
        0,
        subject,
        &subject_key,
        Capability::Steward,
        now_unix() + 10 * 24 * 3600,
    )
    .await;

    let (sole, effective): (bool, i64) = {
        let row = tx
            .query_one(
                "SELECT sole_steward_appointment, EXTRACT(EPOCH FROM effective_from)::bigint \
                   FROM scope_grants WHERE id = $1",
                &[&grant_id],
            )
            .await
            .expect("the grant");
        (row.get(0), row.get(1))
    };
    assert!(sole, "a sole steward's appointment is recorded as one");
    assert!(
        effective >= now_unix() + grants::SOLE_STEWARD_DELAY_SECONDS - 5,
        "§3.5's 24-hour delay is what stands in for the second signature"
    );
    tx.commit().await.expect("commit");

    // And it is not usable yet — which is the delay being real rather than
    // decorative.
    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let refused = grants::authorise_account(&tx, &auth, None, Capability::Steward).await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// §3.4 — revocation and suspension bite at the next use
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_revoked_grant_is_refused_at_the_very_next_use() {
    let pool = support::migrated_pool().await;
    let ring = keyring(69);
    let (estate, subject, _subject_key, _grant_id) =
        an_estate_with_a_draw_grant(&pool, &ring).await;
    let mut client = pool.get().await.expect("connection");

    // It works first.
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::authorise_account(&tx, &auth, None, Capability::Draw)
            .await
            .expect("draw");
        tx.rollback().await.expect("rollback");
    }

    let grant_id = _grant_id;
    {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let at = now_unix();
        let grant_bytes = grant_bytes_for(&tx, &ring, &grant_id).await;
        let signature = estate.stewards[0].key.sign(&authority::revoke_bytes(
            &estate.organisation.to_string(),
            &grant_id,
            &grant_bytes,
            at,
        ));
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::revoke_grant(&tx, &auth, &grant_id, &signature, at)
            .await
            .expect("revoke");
        tx.commit().await.expect("commit");
    }

    // **The same process, a fresh transaction, and no cache to poison.**
    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let refused = grants::authorise_account(&tx, &auth, None, Capability::Draw).await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "{refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_suspended_grant_is_refused_and_a_lifted_one_works_again() {
    let pool = support::migrated_pool().await;
    let ring = keyring(70);
    let (estate, subject, _subject_key, grant_id) = an_estate_with_a_draw_grant(&pool, &ring).await;
    let mut client = pool.get().await.expect("connection");

    for (suspend, expectation) in [(true, false), (false, true)] {
        {
            let (tx, ctx, tenant_key) = acting(
                &mut client,
                &ring,
                estate.organisation,
                estate.stewards[0].account,
            )
            .await;
            let at = now_unix();
            let grant_bytes = grant_bytes_for(&tx, &ring, &grant_id).await;
            let organisation = estate.organisation.to_string();
            let message = if suspend {
                authority::suspend_bytes(&organisation, &grant_id, &grant_bytes, at)
            } else {
                authority::unsuspend_bytes(&organisation, &grant_id, &grant_bytes, at)
            };
            let signature = estate.stewards[0].key.sign(&message);
            let watch = EpochWatch::new();
            let auth = Authority {
                ring: &ring,
                ctx: &ctx,
                tenant_key: &tenant_key,
                watch: &watch,
            };
            grants::set_suspension(&tx, &auth, &grant_id, suspend, &signature, at)
                .await
                .expect("suspension written");
            tx.commit().await.expect("commit");
        }

        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let outcome = grants::authorise_account(&tx, &auth, None, Capability::Draw).await;
        assert_eq!(
            outcome.is_ok(),
            expectation,
            "suspend={suspend} gave {outcome:?}"
        );
        tx.rollback().await.expect("rollback");
    }
}

#[tokio::test]
async fn deleting_a_revocation_does_not_restore_the_grant() {
    let pool = support::migrated_pool().await;
    let ring = keyring(71);
    let (estate, subject, _subject_key, grant_id) = an_estate_with_a_draw_grant(&pool, &ring).await;
    let mut client = pool.get().await.expect("connection");
    {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let at = now_unix();
        let grant_bytes = grant_bytes_for(&tx, &ring, &grant_id).await;
        let signature = estate.stewards[0].key.sign(&authority::revoke_bytes(
            &estate.organisation.to_string(),
            &grant_id,
            &grant_bytes,
            at,
        ));
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::revoke_grant(&tx, &auth, &grant_id, &signature, at)
            .await
            .expect("revoke");
        tx.commit().await.expect("commit");
    }

    // The tier-3 move: disable the append-only trigger and delete the row.
    let su = support::superuser_client_on_test_database().await;
    let deleted = support::tamper(
        &su,
        "grant_revocations",
        "DELETE FROM grant_revocations WHERE grant_id = $1",
        &[&grant_id],
    )
    .await;
    assert_eq!(deleted, 1);

    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let refused = grants::authorise_account(&tx, &auth, None, Capability::Draw).await;
    assert!(
        matches!(refused, Err(AuthorityError::Unverifiable("live set"))),
        "restoring a grant by deleting its revocation must fail CLOSED: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn editing_a_live_grants_capability_grants_nothing() {
    let pool = support::migrated_pool().await;
    let ring = keyring(72);
    let (estate, subject, _subject_key, grant_id) = an_estate_with_a_draw_grant(&pool, &ring).await;

    let su = support::superuser_client_on_test_database().await;
    let changed = support::tamper(
        &su,
        "scope_grants",
        "UPDATE scope_grants SET capability = 'steward' WHERE id = $1",
        &[&grant_id],
    )
    .await;
    assert_eq!(changed, 1);

    let mut client = pool.get().await.expect("connection");
    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let refused = grants::authorise_account(&tx, &auth, None, Capability::Steward).await;
    assert!(
        matches!(refused, Err(AuthorityError::Unverifiable(_))),
        "{refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_grant_on_one_rack_does_not_open_another() {
    let pool = support::migrated_pool().await;
    let ring = keyring(73);
    let estate = bootstrap(&pool, &ring, 1).await;
    let steward = estate.stewards[0].account;
    let network = repo::create_scope(
        &pool,
        estate.organisation,
        steward,
        None,
        ScopeKind::Network,
        "net",
    )
    .await
    .expect("network");
    let other = repo::create_scope(
        &pool,
        estate.organisation,
        steward,
        None,
        ScopeKind::Network,
        "other",
    )
    .await
    .expect("other network");

    let subject = an_account(&pool, "viewer").await;
    repo::add_member(
        &pool,
        estate.organisation,
        steward,
        subject,
        repo::Role::Member,
    )
    .await
    .expect("membership");
    let subject_key = SoftwareKey::random().unwrap();
    let mut client = pool.get().await.expect("connection");
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::enrol_software_key(&tx, &auth, &subject_key.public_key())
            .await
            .expect("enrol");
        tx.commit().await.expect("commit");
    }

    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, steward).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let subject_fpr = authority::key_fingerprint(&subject_key.public_key());
        let granter_fpr = authority::key_fingerprint(&estate.stewards[0].key.public_key());
        let epoch = next_epoch(&tx, &estate.organisation.to_string()).await;
        let now = now_unix();
        let facts = GrantFacts {
            organisation: &estate.organisation.to_string(),
            root_pubkey_fpr: &authority::key_fingerprint(&estate.root.public_key()),
            scope: &network.id.to_string(),
            subject: &subject.to_string(),
            subject_key_fpr: &subject_fpr,
            capability: Capability::Read,
            granter: Some(&steward.to_string()),
            granter_key_fpr: &granter_fpr,
            effective_from_unix: now,
            expires_at_unix: 0,
            auth_epoch: epoch,
        };
        let signature = estate.stewards[0].key.sign(&authority::grant_bytes(&facts));
        grants::sign_grant(
            &tx,
            &auth,
            &GrantRequest {
                scope: Some(network.id),
                subject,
                capability: Capability::Read,
                expires_at_unix: 0,
                signature: &signature,
            },
        )
        .await
        .expect("granted on one network");
        tx.commit().await.expect("commit");
    }

    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    grants::authorise_account(&tx, &auth, Some(network.id), Capability::Read)
        .await
        .expect("the granted network opens");
    let refused = grants::authorise_account(&tx, &auth, Some(other.id), Capability::Read).await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "a grant on one network must not open another: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// Helpers that build on the API rather than reaching around it
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lp(out: &mut Vec<u8>, x: &[u8]) {
    out.extend_from_slice(&(x.len() as u32).to_le_bytes());
    out.extend_from_slice(x);
}

/// `(r, −s)` — the other member of the malleable pair, and a perfectly valid
/// ECDSA signature over the same message under the same key.
fn high_s_twin(signature: &[u8; 64]) -> [u8; 64] {
    use p256::elliptic_curve::PrimeField;
    let parsed = p256::ecdsa::Signature::from_slice(signature).expect("a valid signature");
    let (r, s) = parsed.split_scalars();
    let negated = -*s;
    let twin = p256::ecdsa::Signature::from_scalars(r.to_repr(), negated.to_repr())
        .expect("the negation of a non-zero scalar is non-zero");
    let mut out = [0u8; 64];
    out.copy_from_slice(twin.to_bytes().as_ref());
    out
}

async fn next_epoch(tx: &deadpool_postgres::Transaction<'_>, organisation: &str) -> i32 {
    let row = tx
        .query_opt(
            "SELECT auth_epoch FROM organisation_auth_head WHERE organisation_id = $1",
            &[&organisation],
        )
        .await
        .expect("head");
    match row {
        Some(row) => {
            let epoch: i32 = row.get(0);
            epoch + 1
        }
        None => 1,
    }
}

/// Recompute a stored grant's signed bytes, the way `grants.rs` does at use.
async fn grant_bytes_for(
    tx: &deadpool_postgres::Transaction<'_>,
    ring: &KeyRing,
    grant_id: &str,
) -> Vec<u8> {
    let row = tx
        .query_one(
            "SELECT organisation_id, scope_id, subject_id, subject_key_fpr, capability, \
                    granted_by, granter_key_fpr, auth_epoch, \
                    EXTRACT(EPOCH FROM effective_from)::bigint, \
                    COALESCE(EXTRACT(EPOCH FROM expires_at)::bigint, 0) \
               FROM scope_grants WHERE id = $1",
            &[&grant_id],
        )
        .await
        .expect("the grant");
    let organisation: String = row.get(0);
    let scope: Option<String> = row.get(1);
    let subject: String = row.get(2);
    let subject_fpr: Vec<u8> = row.get(3);
    let capability: String = row.get(4);
    let granted_by: Option<String> = row.get(5);
    let granter_fpr: Vec<u8> = row.get(6);

    let root_pubkey: Vec<u8> = tx
        .query_one(
            "SELECT root_pubkey FROM organisation_roots WHERE organisation_id = $1",
            &[&organisation],
        )
        .await
        .expect("the root")
        .get(0);
    let _ = ring;

    authority::grant_bytes(&GrantFacts {
        organisation: &organisation,
        root_pubkey_fpr: &authority::key_fingerprint(&root_pubkey),
        scope: scope.as_deref().unwrap_or(""),
        subject: &subject,
        subject_key_fpr: &subject_fpr.try_into().expect("32 bytes"),
        capability: Capability::parse(&capability).expect("a capability"),
        granter: granted_by.as_deref(),
        granter_key_fpr: &granter_fpr.try_into().expect("32 bytes"),
        effective_from_unix: row.get(8),
        expires_at_unix: row.get(9),
        auth_epoch: row.get(7),
    })
}

#[allow(clippy::too_many_arguments)]
async fn sign_a_grant(
    tx: &deadpool_postgres::Transaction<'_>,
    auth: &Authority<'_>,
    estate: &Estate,
    granter_index: usize,
    subject: AccountId,
    subject_key: &SoftwareKey,
    capability: Capability,
    expires_at_unix: i64,
) -> String {
    let organisation = estate.organisation.to_string();
    let granter = estate.stewards[granter_index].account.to_string();
    let epoch = next_epoch(tx, &organisation).await;
    let subject_fpr = authority::key_fingerprint(&subject_key.public_key());
    let granter_fpr = authority::key_fingerprint(&estate.stewards[granter_index].key.public_key());
    let now = now_unix();
    let sole =
        live_steward_count(tx, &organisation).await <= 1 && capability == Capability::Steward;
    let effective_from = if sole {
        now + grants::SOLE_STEWARD_DELAY_SECONDS
    } else {
        now
    };
    let facts = GrantFacts {
        organisation: &organisation,
        root_pubkey_fpr: &authority::key_fingerprint(&estate.root.public_key()),
        scope: "",
        subject: &subject.to_string(),
        subject_key_fpr: &subject_fpr,
        capability,
        granter: Some(&granter),
        granter_key_fpr: &granter_fpr,
        effective_from_unix: effective_from,
        expires_at_unix,
        auth_epoch: epoch,
    };
    let signature = estate.stewards[granter_index]
        .key
        .sign(&authority::grant_bytes(&facts));
    grants::sign_grant(
        tx,
        auth,
        &GrantRequest {
            scope: None,
            subject,
            capability,
            expires_at_unix,
            signature: &signature,
        },
    )
    .await
    .expect("the grant is signed")
}

/// How many distinct accounts hold a live steward grant — the test's own
/// count, so that the fixture can predict `sign_grant`'s effective_from
/// without asking the code under test.
async fn live_steward_count(tx: &deadpool_postgres::Transaction<'_>, organisation: &str) -> usize {
    let rows = tx
        .query(
            "SELECT DISTINCT g.subject_id FROM scope_grants g \
              WHERE g.organisation_id = $1 AND g.capability = 'steward' \
                AND NOT EXISTS (SELECT 1 FROM grant_revocations r WHERE r.grant_id = g.id)",
            &[&organisation],
        )
        .await
        .expect("stewards");
    rows.len()
}

/// One organisation, one steward, one member holding `draw` — the fixture
/// three tests share.
async fn an_estate_with_a_draw_grant(
    pool: &Pool,
    ring: &KeyRing,
) -> (Estate, AccountId, SoftwareKey, String) {
    let estate = bootstrap(pool, ring, 1).await;
    let subject = an_account(pool, "drawer").await;
    repo::add_member(
        pool,
        estate.organisation,
        estate.stewards[0].account,
        subject,
        repo::Role::Member,
    )
    .await
    .expect("membership");
    let subject_key = SoftwareKey::random().unwrap();
    let mut client = pool.get().await.expect("connection");
    {
        let (tx, ctx, tenant_key) = acting(&mut client, ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::enrol_software_key(&tx, &auth, &subject_key.public_key())
            .await
            .expect("enrol");
        tx.commit().await.expect("commit");
    }
    let grant_id = {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let id = sign_a_grant(
            &tx,
            &auth,
            &estate,
            0,
            subject,
            &subject_key,
            Capability::Draw,
            // An expiry, so that the capability-edit test can set `steward`
            // without 0011's `CHECK (capability <> 'steward' OR expires_at IS
            // NOT NULL)` refusing the tamper before the seal ever gets a say.
            now_unix() + 3600,
        )
        .await;
        tx.commit().await.expect("commit");
        id
    };
    (estate, subject, subject_key, grant_id)
}

// ---------------------------------------------------------------------------
// §8.4 — key succession
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_old_key_signs_its_successor_and_may_not_name_a_second_one() {
    let pool = support::migrated_pool().await;
    let ring = keyring(74);
    let estate = bootstrap(&pool, &ring, 1).await;
    let steward = estate.stewards[0].account;
    let successor = SoftwareKey::random().unwrap();
    let mut client = pool.get().await.expect("connection");

    // Enrol the successor, then have the OLD key sign the statement that it is
    // the successor -- §8.4's *"old key signs the new one"*, which is what
    // carries grants forward without a re-signing campaign.
    let (new_key_id, old_key_id) = {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, steward).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let new_key = grants::enrol_software_key(&tx, &auth, &successor.public_key())
            .await
            .expect("enrol the successor");
        let old_key_id: String = tx
            .query_one(
                "SELECT id FROM account_keys WHERE fpr = $1",
                &[&authority::key_fingerprint(&estate.stewards[0].key.public_key()).to_vec()],
            )
            .await
            .expect("the original key")
            .get(0);
        tx.commit().await.expect("commit");
        (new_key.id, old_key_id)
    };

    let at = now_unix();
    let old_fpr = authority::key_fingerprint(&estate.stewards[0].key.public_key());
    let new_fpr = authority::key_fingerprint(&successor.public_key());
    let signature = estate.stewards[0].key.sign(&authority::succession_bytes(
        &steward.to_string(),
        &old_fpr,
        &new_fpr,
        at,
    ));

    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, steward).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        // Signed by the NEW key rather than the old one: refused, because the
        // statement that matters is the one the key being replaced makes.
        let wrong = successor.sign(&authority::succession_bytes(
            &steward.to_string(),
            &old_fpr,
            &new_fpr,
            at,
        ));
        let refused = grants::supersede_key(&tx, &auth, &old_key_id, &new_key_id, &wrong, at).await;
        assert!(
            matches!(
                refused,
                Err(AuthorityError::Signature(SignatureRefused::DoesNotVerify))
            ),
            "{refused:?}"
        );
        tx.rollback().await.expect("rollback");
    }

    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, steward).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::supersede_key(&tx, &auth, &old_key_id, &new_key_id, &signature, at)
            .await
            .expect("the old key's own signature is accepted");
        tx.commit().await.expect("commit");
    }

    // The keyring row now records it, its row_version moved, and the account
    // signs with the successor.
    let (tx, _ctx, _tenant_key) = acting(&mut client, &ring, estate.organisation, steward).await;
    let row = tx
        .query_one(
            "SELECT superseded_by, row_version, retired_at IS NOT NULL FROM account_keys \
              WHERE id = $1",
            &[&old_key_id],
        )
        .await
        .expect("the superseded key");
    assert_eq!(row.get::<_, Option<String>>(0), Some(new_key_id.clone()));
    assert_eq!(row.get::<_, i32>(1), 2, "the row seal covers row_version");
    assert!(row.get::<_, bool>(2));
    let signing = grants::signing_key_of(&tx, &steward.to_string())
        .await
        .expect("read")
        .expect("a key");
    assert_eq!(signing.id, new_key_id);

    // **And the grants made to the old key still authorise.** §8.4: succession
    // *"carries grants forward without a re-signing campaign"*. A grant names
    // the fingerprint of the key that was live when it was signed, and that
    // keyring row is kept for ever rather than deleted -- which is why
    // `account_keys` is append-only and why retirement is a column rather than
    // a `DELETE`.
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &_ctx,
        tenant_key: &_tenant_key,
        watch: &watch,
    };
    let capabilities = grants::authorise_account(&tx, &auth, None, Capability::Steward)
        .await
        .expect("the genesis grant survives its subject's key rotation");
    assert_eq!(capabilities.capability, Capability::Steward);
    tx.rollback().await.expect("rollback");

    // **Succession does not fork.** A THIRD key, and the old key is made to
    // name it as well: `0011`'s trigger refuses that at every privilege level,
    // so this is driven as the superuser. (Re-naming the SAME successor is a
    // no-op and is not what the fence is about.)
    let third = SoftwareKey::random().unwrap();
    let third_id = {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, steward).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let key = grants::enrol_software_key(&tx, &auth, &third.public_key())
            .await
            .expect("enrol a third key");
        tx.commit().await.expect("commit");
        key.id
    };

    let su = support::superuser_client_on_test_database().await;
    let forked = su
        .execute(
            "UPDATE account_keys SET superseded_by = $1, row_version = row_version + 1 \
              WHERE id = $2",
            &[&third_id, &old_key_id],
        )
        .await
        .expect_err("a key that already names a successor may not name another");
    assert!(forked.to_string().contains("db error"), "{forked}");
    assert!(
        forked
            .as_db_error()
            .map(|e| e.message().contains("does not fork"))
            .unwrap_or(false),
        "the refusal must come from the supersession trigger: {forked}"
    );

    // And the keyring is append-only: DELETE is refused for the superuser too.
    let deleted = su
        .execute("DELETE FROM account_keys WHERE id = $1", &[&old_key_id])
        .await
        .expect_err("the keyring is append-only");
    assert!(
        deleted
            .as_db_error()
            .map(|e| e.message().contains("append-only"))
            .unwrap_or(false),
        "{deleted}"
    );
}

/// A compile-time reminder that the algorithm id is Fathom's own and not
/// COSE's — see `authority::ALG_ES256` and `0011`'s header.
#[test]
fn the_algorithm_id_is_the_one_the_migration_admits() {
    assert_eq!(ALG_ES256, 1);
}
