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
    bootstrap_with_starts(pool, ring, &vec![0i64; steward_count]).await
}

/// As [`bootstrap`], with each genesis steward's `effective_from` offset from
/// now by the matching entry in `starts`.
///
/// **One test needs a steward who becomes live while it watches**, and there
/// is no other way to arrange it: every grant this layer writes is live at
/// once or a day later, the clock is the server's, and a genesis grant is the
/// only one whose `effective_from` the caller chooses (§6.1 — the root key
/// signs it before the server sees it). A second steward arriving between a
/// proposal and its commit is exactly what §3.5's sole-steward determination
/// has to notice.
async fn bootstrap_with_starts(pool: &Pool, ring: &KeyRing, starts: &[i64]) -> Estate {
    let steward_count = starts.len();
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
        .zip(starts)
        .map(|(s, start)| {
            let now = now + start;
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
                // Genesis is root-signed and needs no seconding for a reason
                // of its own (§6.1); it is not §3.5's sole-steward path.
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
        sole_steward_appointment: false,
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
        matches!(
            refused,
            Err(AuthorityError::Unverifiable("authority state"))
        ),
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
        matches!(
            refused,
            Err(AuthorityError::Unverifiable("authority state"))
        ),
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
        let proposal = grants::propose_grant(
            &tx,
            &auth,
            &GrantRequest {
                scope: Some(network.id),
                subject,
                capability: Capability::Read,
                expires_at_unix: 0,
            },
        )
        .await
        .expect("proposed on one network");
        let signature = estate.stewards[0].key.sign(&proposal.bytes);
        grants::sign_grant(&tx, &auth, &proposal, &signature)
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

/// The epoch the next act in this organisation will claim.
///
/// **No longer used to build a signature**, which is the point: the fixture
/// used to compute this so it could guess what `sign_grant` was about to
/// choose. `propose_grant` now returns the epoch inside the bytes it issues.
/// Kept because it reads the head without going through the code under test.
#[allow(dead_code)]
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
                    COALESCE(EXTRACT(EPOCH FROM expires_at)::bigint, 0), \
                    sole_steward_appointment \
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
        // v2 of `grant_bytes` carries the flag, so a recomputation that
        // guessed it would produce bytes no stored signature verifies over.
        sole_steward_appointment: row.get(10),
        auth_epoch: row.get(7),
    })
}

/// Propose a grant, sign the bytes the server issued, and submit them.
///
/// **The fixture no longer predicts anything.** It used to recompute the
/// epoch, the wall-clock `now`, the sole-steward flag and the 24-hour offset,
/// because `sign_grant` chose all four AFTER the signature was made and the
/// test had to guess them to produce a signature that would verify. It guessed
/// wrong whenever the clock ticked between the two, which is how this suite
/// came to flake with `DoesNotVerify` on a correct signature.
///
/// With the two-step split there is nothing to guess: `propose_grant` returns
/// the bytes, and those exact bytes are what gets signed.
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
    let _ = subject_key;
    let proposal = grants::propose_grant(
        tx,
        auth,
        &GrantRequest {
            scope: None,
            subject,
            capability,
            expires_at_unix,
        },
    )
    .await
    .expect("the grant is proposed");
    let signature = estate.stewards[granter_index].key.sign(&proposal.bytes);
    grants::sign_grant(tx, auth, &proposal, &signature)
        .await
        .expect("the grant is signed")
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

// ---------------------------------------------------------------------------
// The defects a checker found in the signed authority layer, each with the
// reproduction that failed before the fix and passes after it.
// ---------------------------------------------------------------------------

/// Enrol a software key for an account, through the real path.
async fn enrol(
    pool: &Pool,
    ring: &KeyRing,
    organisation: OrganisationId,
    who: AccountId,
    key: &SoftwareKey,
) {
    let mut client = pool.get().await.expect("connection");
    let (tx, ctx, tenant_key) = acting(&mut client, ring, organisation, who).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    grants::enrol_software_key(&tx, &auth, &key.public_key())
        .await
        .expect("enrol");
    tx.commit().await.expect("commit");
}

/// A member of the organisation who holds no grant at all.
async fn a_bystander(
    pool: &Pool,
    ring: &KeyRing,
    estate: &Estate,
    name: &str,
) -> (AccountId, SoftwareKey) {
    let account = an_account(pool, name).await;
    repo::add_member(
        pool,
        estate.organisation,
        estate.stewards[0].account,
        account,
        repo::Role::Member,
    )
    .await
    .expect("membership");
    let key = SoftwareKey::random().unwrap();
    enrol(pool, ring, estate.organisation, account, &key).await;
    (account, key)
}

/// One organisation, two genesis stewards, and a pending `steward` grant to a
/// third account that has not been seconded. The shape every seconding attack
/// starts from.
async fn a_pending_steward_grant(
    pool: &Pool,
    ring: &KeyRing,
    chain_master: u8,
) -> (Estate, AccountId, SoftwareKey, String) {
    let _ = chain_master;
    let estate = bootstrap(pool, ring, 2).await;
    let subject = an_account(pool, "candidate").await;
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
    enrol(pool, ring, estate.organisation, subject, &subject_key).await;

    let mut client = pool.get().await.expect("connection");
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
    let grant_id = sign_a_grant(
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
    (estate, subject, subject_key, grant_id)
}

#[tokio::test]
async fn a_bystander_cannot_second_a_steward_grant_into_life() {
    // **The worst of the eight.** `live_set` covered grants only, so the
    // head's digest did not move when a seconding appeared; the seconding
    // row's own seal was written and verified nowhere; and the only check at
    // use was the seconder's signature over `second_bytes` -- whose every
    // input (`H(grant_bytes)`, `granter_key_fpr`) any member of the
    // organisation can recompute from columns they are allowed to read.
    //
    // So a bystander holding no grant at all could insert a row through the
    // application role, with a garbage seal, and flip a pending steward grant
    // live. This is that reproduction.
    let pool = support::migrated_pool().await;
    let ring = keyring(78);
    let (estate, subject, _subject_key, grant_id) = a_pending_steward_grant(&pool, &ring, 78).await;
    let (bystander, bystander_key) = a_bystander(&pool, &ring, &estate, "bystander").await;

    let mut client = pool.get().await.expect("connection");

    // The bystander forges a seconding. The SIGNATURE is genuine -- they hold
    // a real enrolled key and sign the real bytes -- and the seal is garbage,
    // because they cannot compute one without the chain key.
    {
        let (tx, ctx, tenant_key) =
            acting(&mut client, &ring, estate.organisation, bystander).await;
        let _ = (&ctx, &tenant_key);
        let grant_bytes = grant_bytes_for(&tx, &ring, &grant_id).await;
        let granter_fpr = authority::key_fingerprint(&estate.stewards[0].key.public_key());
        let signature = bystander_key.sign(&authority::second_bytes(&grant_bytes, &granter_fpr));

        tx.execute(
            "INSERT INTO grant_secondings \
                 (id, grant_id, organisation_id, grant_subject_id, grant_granter_id, \
                  seconded_by, seconder_key_fpr, seconder_sig, chain_seq, row_seal) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
            &[
                &fathom_server::ids::new_ulid().to_string(),
                &grant_id,
                &estate.organisation.to_string(),
                &subject.to_string(),
                &estate.stewards[0].account.to_string(),
                &bystander.to_string(),
                &authority::key_fingerprint(&bystander_key.public_key()).to_vec(),
                &signature.to_vec(),
                &1i64,
                &vec![0u8; 32],
            ],
        )
        .await
        .expect(
            "the application role can still WRITE this row -- the fence is at use, and a test \
             that could not insert would be proving the wrong thing",
        );
        tx.commit().await.expect("commit");
    }

    // And it grants nothing.
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
        "a seconding the head does not cover must fail CLOSED, not as a permission error \
         and certainly not as a steward: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_seconding_with_a_good_signature_and_a_forged_seal_is_refused() {
    // The other half of the seconding fix, and the one the head's digest
    // alone does NOT catch: the digest carries the RECOMPUTED seal, so a row
    // whose content is untouched and whose stored seal has been rewritten
    // produces an identical digest and sails through the head comparison.
    //
    // So this seconding is entirely genuine -- made by a real second steward,
    // through the real path, with a real signature -- and only its stored seal
    // is then overwritten.
    let pool = support::migrated_pool().await;
    let ring = keyring(79);
    let (estate, subject, _subject_key, grant_id) = a_pending_steward_grant(&pool, &ring, 79).await;
    let mut client = pool.get().await.expect("connection");

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
            .expect("a real seconding by a real steward");
        tx.commit().await.expect("commit");
    }

    // It works, before the tamper.
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::authorise_account(&tx, &auth, None, Capability::Steward)
            .await
            .expect("seconded, and usable");
        tx.rollback().await.expect("rollback");
    }

    // `grant_secondings` is append-only behind a trigger that binds a
    // superuser, so rewriting the seal takes the tier-3 route the fence's own
    // header names.
    let superuser = support::superuser_client_on_test_database().await;
    let tamper_gate = support::hold_the_tamper_lock().await;
    superuser
        .batch_execute("ALTER TABLE grant_secondings DISABLE TRIGGER USER")
        .await
        .expect("tier 3 owns the table");
    superuser
        .execute(
            "UPDATE grant_secondings SET row_seal = $1 WHERE grant_id = $2",
            &[&vec![0xABu8; 32], &grant_id],
        )
        .await
        .expect("forge the stored seal");
    superuser
        .batch_execute("ALTER TABLE grant_secondings ENABLE TRIGGER USER")
        .await
        .expect("put it back");
    tamper_gate.release().await;

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
        "a seconding whose stored seal was forged must be refused even though its signature \
         is genuine and the head's digest still matches: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_late_genesis_row_is_unusable_even_though_it_inserts() {
    // `0011`'s genesis trigger was `SECURITY DEFINER` reading a table behind
    // `FORCE ROW LEVEL SECURITY`, so with no tenant context it saw zero rows
    // and returned NEW. It refused nothing.
    //
    // `0012` drops it, adds `CHECK (NOT is_genesis OR auth_epoch = 1)` as
    // belt-and-braces, and puts the real fence on the chain: `org_genesis`
    // names the genesis grants, and a row that entry does not name is refused
    // at use.
    //
    // **The row still inserts.** That is stated in `0012`'s header and it is
    // asserted here, so nobody reads this as an SQL-level impossibility.
    let pool = support::migrated_pool().await;
    let ring = keyring(80);
    let estate = bootstrap(&pool, &ring, 2).await;
    let (newcomer, newcomer_key) = a_bystander(&pool, &ring, &estate, "newcomer").await;
    let mut client = pool.get().await.expect("connection");

    // Both genesis stewards authorise, before anything is touched.
    for steward in &estate.stewards {
        let (tx, ctx, tenant_key) =
            acting(&mut client, &ring, estate.organisation, steward.account).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let caps = grants::authorise_account(&tx, &auth, None, Capability::Steward)
            .await
            .expect("a real two-steward genesis authorises both of them");
        assert_eq!(caps.capability, Capability::Steward);
        tx.rollback().await.expect("rollback");
    }

    // A second genesis, for a fresh subject, at `auth_epoch = 1` so the new
    // CHECK is satisfied, inserted as superuser with the append-only triggers
    // disabled -- every fence 0011 and 0012 put in the database, walked past.
    let superuser = support::superuser_client_on_test_database().await;
    let tamper_gate = support::hold_the_tamper_lock().await;
    superuser
        .batch_execute("ALTER TABLE scope_grants DISABLE TRIGGER USER")
        .await
        .expect("tier 3 owns the table");
    superuser
        .execute(
            "INSERT INTO scope_grants \
                 (id, organisation_id, scope_id, subject_id, subject_key_fpr, capability, \
                  granter_kind, granted_by, granter_key_fpr, granter_sig, is_genesis, \
                  auth_epoch, effective_from, expires_at, chain_seq, row_version, row_seal) \
             VALUES ($1, $2, NULL, $3, $4, 'steward', 'org_root', NULL, $5, $6, true, 1, \
                     now(), now() + interval '365 days', 1, 1, $7)",
            &[
                &fathom_server::ids::new_ulid().to_string(),
                &estate.organisation.to_string(),
                &newcomer.to_string(),
                &authority::key_fingerprint(&newcomer_key.public_key()).to_vec(),
                &authority::key_fingerprint(&estate.root.public_key()).to_vec(),
                &vec![0u8; 64],
                &vec![0u8; 32],
            ],
        )
        .await
        .expect(
            "a second genesis row INSERTS -- no CHECK can read another table, so nothing at the \
             SQL level can refuse this, and 0012 does not claim otherwise",
        );
    superuser
        .batch_execute("ALTER TABLE scope_grants ENABLE TRIGGER USER")
        .await
        .expect("put it back");
    tamper_gate.release().await;

    // And the organisation now authorises nobody, including the newcomer and
    // the genuine stewards: the sealed `org_genesis` entry names two genesis
    // grants and the table holds three.
    for who in [
        newcomer,
        estate.stewards[0].account,
        estate.stewards[1].account,
    ] {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, who).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        let refused = grants::authorise_account(&tx, &auth, None, Capability::Steward).await;
        assert!(
            matches!(refused, Err(AuthorityError::Unverifiable(_)))
                || matches!(refused, Err(AuthorityError::GenesisSetMismatch)),
            "a genesis row the sealed org_genesis entry does not name must make the authority \
             unusable, not merely be recorded: {refused:?}"
        );
        tx.rollback().await.expect("rollback");
    }
}

#[tokio::test]
async fn the_check_refuses_a_genesis_grant_at_any_epoch_but_one() {
    // 0012's belt-and-braces half, which binds at every privilege level
    // including `psql` as superuser, with the append-only triggers disabled.
    let pool = support::migrated_pool().await;
    let ring = keyring(81);
    let estate = bootstrap(&pool, &ring, 1).await;
    let (newcomer, newcomer_key) = a_bystander(&pool, &ring, &estate, "newcomer").await;

    let superuser = support::superuser_client_on_test_database().await;
    let tamper_gate = support::hold_the_tamper_lock().await;
    superuser
        .batch_execute("ALTER TABLE scope_grants DISABLE TRIGGER USER")
        .await
        .expect("tier 3 owns the table");
    let err = superuser
        .execute(
            "INSERT INTO scope_grants \
                 (id, organisation_id, scope_id, subject_id, subject_key_fpr, capability, \
                  granter_kind, granted_by, granter_key_fpr, granter_sig, is_genesis, \
                  auth_epoch, effective_from, expires_at, chain_seq, row_version, row_seal) \
             VALUES ($1, $2, NULL, $3, $4, 'steward', 'org_root', NULL, $5, $6, true, 7, \
                     now(), now() + interval '365 days', 1, 1, $7)",
            &[
                &fathom_server::ids::new_ulid().to_string(),
                &estate.organisation.to_string(),
                &newcomer.to_string(),
                &authority::key_fingerprint(&newcomer_key.public_key()).to_vec(),
                &authority::key_fingerprint(&estate.root.public_key()).to_vec(),
                &vec![0u8; 64],
                &vec![0u8; 32],
            ],
        )
        .await
        .expect_err("a genesis grant at epoch 7 must be refused by the constraint");
    superuser
        .batch_execute("ALTER TABLE scope_grants ENABLE TRIGGER USER")
        .await
        .expect("put it back");
    tamper_gate.release().await;

    assert_eq!(
        err.code(),
        Some(&SqlState::CHECK_VIOLATION),
        "the refusal must come from the CHECK, which row security cannot filter and a \
         superuser cannot bypass: {err}"
    );
}

#[tokio::test]
async fn an_account_in_two_organisations_is_authorisable_in_both() {
    // The keyring is account-scoped and its seal was organisation-scoped, so
    // a key enrolled in A recomputed to a different value in B -- and B
    // refused the account with `Unverifiable`, an integrity alarm for a
    // forgery that had not happened. 0012 moves the seal to a site-scoped row
    // key; this is the shape that could not work before.
    let pool = support::migrated_pool().await;
    let ring = keyring(82);

    let a = bootstrap(&pool, &ring, 1).await;
    let b = bootstrap(&pool, &ring, 1).await;

    // One person, a member of both, with ONE key -- enrolled while acting in A.
    let person = an_account(&pool, "twohats").await;
    for estate in [&a, &b] {
        repo::add_member(
            &pool,
            estate.organisation,
            estate.stewards[0].account,
            person,
            repo::Role::Member,
        )
        .await
        .expect("membership");
    }
    let person_key = SoftwareKey::random().unwrap();
    enrol(&pool, &ring, a.organisation, person, &person_key).await;

    // The grant is signed in B, by B's steward, naming that same key.
    let mut client = pool.get().await.expect("connection");
    {
        let (tx, ctx, tenant_key) =
            acting(&mut client, &ring, b.organisation, b.stewards[0].account).await;
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        sign_a_grant(
            &tx,
            &auth,
            &b,
            0,
            person,
            &person_key,
            Capability::Draw,
            now_unix() + 3600,
        )
        .await;
        tx.commit().await.expect("commit");
    }

    // And it authorises in B, where the key was never enrolled.
    let (tx, ctx, tenant_key) = acting(&mut client, &ring, b.organisation, person).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let caps = grants::authorise_account(&tx, &auth, None, Capability::Draw)
        .await
        .expect("a key enrolled in one organisation resolves in the other");
    assert_eq!(caps.capability, Capability::Draw);
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_proposal_whose_epoch_has_moved_is_refused_with_re_propose() {
    // Item 4's other half. The two-step split removed the clock race; this is
    // what replaces it -- an EXACT check, so a proposal signed against one
    // authority state cannot be committed into another.
    let pool = support::migrated_pool().await;
    let ring = keyring(83);
    let estate = bootstrap(&pool, &ring, 1).await;
    let (subject, subject_key) = a_bystander(&pool, &ring, &estate, "subject").await;
    let (other, other_key) = a_bystander(&pool, &ring, &estate, "other").await;
    let _ = (&subject_key, &other_key);

    let mut client = pool.get().await.expect("connection");
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

    let proposal = grants::propose_grant(
        &tx,
        &auth,
        &GrantRequest {
            scope: None,
            subject,
            capability: Capability::Draw,
            expires_at_unix: 0,
        },
    )
    .await
    .expect("proposed");
    let signature = estate.stewards[0].key.sign(&proposal.bytes);

    // Another grant lands first, in the same transaction, advancing the head.
    sign_a_grant(
        &tx,
        &auth,
        &estate,
        0,
        other,
        &other_key,
        Capability::Draw,
        0,
    )
    .await;

    let refused = grants::sign_grant(&tx, &auth, &proposal, &signature).await;
    assert!(
        matches!(refused, Err(AuthorityError::Stale(_))),
        "a proposal overtaken by another act must be refused with a typed error that says to \
         propose again, never quietly re-stamped with a fresh epoch the signer never saw: \
         {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn suspending_a_co_steward_does_not_manufacture_a_sole_steward() {
    // The checker's sequence, end to end:
    //
    //   one steward suspends the other -> the organisation looks
    //   single-stewarded -> the survivor appoints a third ALONE as a
    //   "sole steward" appointment -> the survivor lifts the suspension.
    //
    // Two independent closures, and this asserts the outcome rather than
    // either mechanism: no third steward appears on one signature.
    let pool = support::migrated_pool().await;
    let ring = keyring(84);
    let estate = bootstrap(&pool, &ring, 2).await;
    let (third, third_key) = a_bystander(&pool, &ring, &estate, "third").await;
    let mut client = pool.get().await.expect("connection");

    // Steward 0 suspends steward 1's genesis grant.
    let victim_grant: String = {
        let (tx, _ctx, _tk) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let id = tx
            .query_one(
                "SELECT id FROM scope_grants WHERE organisation_id = $1 AND subject_id = $2",
                &[
                    &estate.organisation.to_string(),
                    &estate.stewards[1].account.to_string(),
                ],
            )
            .await
            .expect("the co-steward's grant")
            .get(0);
        tx.rollback().await.expect("rollback");
        id
    };

    {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let at = now_unix();
        let grant_bytes = grant_bytes_for(&tx, &ring, &victim_grant).await;
        let signature = estate.stewards[0].key.sign(&authority::suspend_bytes(
            &estate.organisation.to_string(),
            &victim_grant,
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
        grants::set_suspension(&tx, &auth, &victim_grant, true, &signature, at)
            .await
            .expect("a steward may suspend");
        tx.commit().await.expect("commit");
    }

    // Now the survivor tries to appoint a third, alone.
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
    let proposal = grants::propose_grant(
        &tx,
        &auth,
        &GrantRequest {
            scope: None,
            subject: third,
            capability: Capability::Steward,
            expires_at_unix: now_unix() + 3600,
        },
    )
    .await;

    match proposal {
        // Either the path is closed outright...
        Err(AuthorityError::SoleStewardPathBlocked) => {}
        // ...or it is open and the appointment is NOT a sole one, so it needs
        // a seconding and is useless without it. Both are acceptable; a third
        // steward on one signature is not.
        Ok(proposal) => {
            assert!(
                !proposal.sole_steward_appointment,
                "a suspended co-steward still counts, so this must not be flagged as a sole \
                 appointment"
            );
            let signature = estate.stewards[0].key.sign(&proposal.bytes);
            let id = grants::sign_grant(&tx, &auth, &proposal, &signature)
                .await
                .expect("the grant is written");
            tx.commit().await.expect("commit");

            let (tx, ctx, tenant_key) =
                acting(&mut client, &ring, estate.organisation, third).await;
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
                "a third steward appointed by one signature while the co-steward is merely \
                 SUSPENDED must not be usable: grant {id}, got {refused:?}"
            );
            tx.rollback().await.expect("rollback");
        }
        Err(other) => panic!("unexpected refusal: {other:?}"),
    }
    let _ = third_key;
}

#[tokio::test]
async fn revoking_a_co_stewards_grant_alone_waits_out_the_delay() {
    // §3.5, as amended: a single-steward act that removes another steward
    // takes effect only after the same 24 hours a sole appointment does. Its
    // absence was what let the survivor of a suspension become "sole"
    // immediately.
    let pool = support::migrated_pool().await;
    let ring = keyring(85);
    let estate = bootstrap(&pool, &ring, 2).await;
    let mut client = pool.get().await.expect("connection");

    let victim_grant: String = {
        let (tx, _ctx, _tk) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let id = tx
            .query_one(
                "SELECT id FROM scope_grants WHERE organisation_id = $1 AND subject_id = $2",
                &[
                    &estate.organisation.to_string(),
                    &estate.stewards[1].account.to_string(),
                ],
            )
            .await
            .expect("the co-steward's grant")
            .get(0);
        tx.rollback().await.expect("rollback");
        id
    };

    let at = now_unix();
    {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let grant_bytes = grant_bytes_for(&tx, &ring, &victim_grant).await;
        let signature = estate.stewards[0].key.sign(&authority::revoke_bytes(
            &estate.organisation.to_string(),
            &victim_grant,
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
        grants::revoke_grant(&tx, &auth, &victim_grant, &signature, at)
            .await
            .expect("a steward may revoke");
        tx.commit().await.expect("commit");
    }

    // The row records the delay, and the co-steward still authorises.
    let (tx, ctx, tenant_key) = acting(
        &mut client,
        &ring,
        estate.organisation,
        estate.stewards[1].account,
    )
    .await;
    let delay: i64 = tx
        .query_one(
            "SELECT EXTRACT(EPOCH FROM takes_effect_at - revoked_at)::bigint \
               FROM grant_revocations WHERE grant_id = $1",
            &[&victim_grant],
        )
        .await
        .expect("the revocation")
        .get(0);
    assert_eq!(
        delay,
        grants::SOLE_STEWARD_DELAY_SECONDS,
        "removing another steward on one signature waits exactly as long as appointing one \
         does"
    );

    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let caps = grants::authorise_account(&tx, &auth, None, Capability::Steward)
        .await
        .expect("a revocation inside its delay has not yet taken effect");
    assert_eq!(caps.capability, Capability::Steward);
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn revoking_a_draw_grant_takes_effect_at_once() {
    // The other side of the same rule, so the delay is not read as blanket.
    // A `draw` grant weakens no steward, so nothing waits.
    let pool = support::migrated_pool().await;
    let ring = keyring(86);
    let (estate, subject, _key, grant_id) = an_estate_with_a_draw_grant(&pool, &ring).await;
    let mut client = pool.get().await.expect("connection");

    let at = now_unix();
    {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
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
            .expect("revoked");
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
    let refused = grants::authorise_account(&tx, &auth, None, Capability::Draw).await;
    assert!(
        matches!(refused, Err(AuthorityError::NotAuthorised)),
        "revoking a draw grant weakens no steward and must bite at once: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn an_expired_co_steward_does_not_keep_the_survivor_from_appointing() {
    // Every steward grant must carry an expiry (`0011`), and the live set
    // ignored expiry -- so once a co-steward's grant lapsed, the organisation
    // had one steward who could do nothing and one who was not "sole", and
    // could never appoint anybody again. Every organisation deadlocked
    // eventually.
    let pool = support::migrated_pool().await;
    let ring = keyring(87);
    let estate = bootstrap(&pool, &ring, 2).await;
    let (third, _third_key) = a_bystander(&pool, &ring, &estate, "third").await;
    let mut client = pool.get().await.expect("connection");

    // Expire steward 1's grant. `scope_grants` is append-only behind a trigger
    // that binds a superuser, so this is the tier-3 route -- used here only to
    // move a clock forward, which no test can otherwise do.
    let superuser = support::superuser_client_on_test_database().await;
    let tamper_gate = support::hold_the_tamper_lock().await;
    superuser
        .batch_execute("ALTER TABLE scope_grants DISABLE TRIGGER USER")
        .await
        .expect("tier 3 owns the table");
    superuser
        .execute(
            // Both ends move: `0011` has CHECK (expires_at > effective_from),
            // so an expiry in the past needs a start further in the past.
            "UPDATE scope_grants \
                SET effective_from = now() - interval '2 hours', \
                    expires_at = now() - interval '1 hour' \
              WHERE organisation_id = $1 AND subject_id = $2",
            &[
                &estate.organisation.to_string(),
                &estate.stewards[1].account.to_string(),
            ],
        )
        .await
        .expect("expire the co-steward");
    superuser
        .batch_execute("ALTER TABLE scope_grants ENABLE TRIGGER USER")
        .await
        .expect("put it back");
    tamper_gate.release().await;

    // Editing the row broke its seal, so re-seal the authority by advancing
    // the head through the real path -- the state is now genuinely "one live
    // steward, one expired".
    {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        reseal_every_grant(&tx, 87, &estate).await;
        grants::advance_head(&tx, &ring, &ctx, &tenant_key)
            .await
            .expect("advance the head over the new state");
        tx.commit().await.expect("commit");
    }

    // The expired steward is refused...
    {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[1].account,
        )
        .await;
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
            "an expired grant must stop working: {refused:?}"
        );
        tx.rollback().await.expect("rollback");
    }

    // ...and the survivor is now SOLE, so the organisation is not deadlocked.
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
    let proposal = grants::propose_grant(
        &tx,
        &auth,
        &GrantRequest {
            scope: None,
            subject: third,
            capability: Capability::Steward,
            expires_at_unix: now_unix() + 30 * 24 * 3600,
        },
    )
    .await
    .expect("the survivor can still appoint");
    assert!(
        proposal.sole_steward_appointment,
        "with the co-steward expired the survivor is the only live steward, so §3.5's sole \
         path is the one that must open"
    );
    assert!(
        proposal.effective_from_unix >= now_unix() + grants::SOLE_STEWARD_DELAY_SECONDS - 5,
        "and it waits the 24 hours"
    );

    let signature = estate.stewards[0].key.sign(&proposal.bytes);
    let id = grants::sign_grant(&tx, &auth, &proposal, &signature)
        .await
        .expect("written");
    tx.commit().await.expect("commit");

    // Not usable yet -- the delay is the control.
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, third).await;
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
            "grant {id} must wait out its delay: {refused:?}"
        );
        tx.rollback().await.expect("rollback");
    }

    // And usable once the delay has passed.
    //
    // **Standing the clock forward means re-signing, and that is the point.**
    // `effective_from` is inside `grant_bytes`, so moving it invalidates the
    // granter's signature -- there is no way to age a pending appointment into
    // life without the granter's key, which is exactly the property §3.3 is
    // built on. The test holds that key only because the test created the
    // steward, and it re-signs the moved bytes rather than pretending the old
    // signature still covers them.
    let tamper_gate = support::hold_the_tamper_lock().await;
    superuser
        .batch_execute("ALTER TABLE scope_grants DISABLE TRIGGER USER")
        .await
        .expect("tier 3");
    superuser
        .execute(
            "UPDATE scope_grants SET effective_from = now() - interval '1 minute' WHERE id = $1",
            &[&id],
        )
        .await
        .expect("wind the delay forward");
    superuser
        .batch_execute("ALTER TABLE scope_grants ENABLE TRIGGER USER")
        .await
        .expect("put it back");
    tamper_gate.release().await;

    {
        let (tx, ctx, tenant_key) = acting(
            &mut client,
            &ring,
            estate.organisation,
            estate.stewards[0].account,
        )
        .await;
        let moved = grant_bytes_for(&tx, &ring, &id).await;
        let resigned = estate.stewards[0].key.sign(&moved);
        let superuser = support::superuser_client_on_test_database().await;
        let tamper_gate = support::hold_the_tamper_lock().await;
        superuser
            .batch_execute("ALTER TABLE scope_grants DISABLE TRIGGER USER")
            .await
            .expect("tier 3");
        superuser
            .execute(
                "UPDATE scope_grants SET granter_sig = $1 WHERE id = $2",
                &[&resigned.to_vec(), &id],
            )
            .await
            .expect("re-sign the moved bytes");
        superuser
            .batch_execute("ALTER TABLE scope_grants ENABLE TRIGGER USER")
            .await
            .expect("put it back");
        tamper_gate.release().await;

        reseal_every_grant(&tx, 87, &estate).await;
        grants::advance_head(&tx, &ring, &ctx, &tenant_key)
            .await
            .expect("advance");
        tx.commit().await.expect("commit");
    }

    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, third).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let caps = grants::authorise_account(&tx, &auth, None, Capability::Steward)
        .await
        .expect("after the delay the sole appointment stands on its own");
    assert_eq!(caps.capability, Capability::Steward);
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_retired_key_stops_signing_and_keeps_verifying_what_it_signed() {
    // `account_key_retired` was in `0011`'s entry-type CHECK and `retired_at`
    // was in the keyring, and NOTHING wrote either -- a name pretending to be
    // a control. This is the act, and the two halves of §3.3's "keyring entry
    // live at effective_from".
    let pool = support::migrated_pool().await;
    let ring = keyring(88);
    let (estate, subject, _subject_key, grant_id) = {
        let (estate, subject, key, id) = an_estate_with_a_draw_grant(&pool, &ring).await;
        (estate, subject, key, id)
    };
    let mut client = pool.get().await.expect("connection");

    let key_id: String = {
        let (tx, _ctx, _tk) = acting(&mut client, &ring, estate.organisation, subject).await;
        let id = grants::signing_key_of(&tx, &subject.to_string())
            .await
            .expect("read")
            .expect("a key")
            .id;
        tx.rollback().await.expect("rollback");
        id
    };

    // The holder retires their own key, an hour from now -- so the grant,
    // whose `effective_from` is in the past, was signed while the key was in
    // service.
    let at = now_unix() + 3600;
    {
        let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;
        let key = grants::signing_key_of(&tx, &subject.to_string())
            .await
            .expect("read")
            .expect("a key");
        let signature = _subject_key.sign(&authority::retire_bytes(
            &subject.to_string(),
            &key.fpr,
            &key.fpr,
            at,
        ));
        let watch = EpochWatch::new();
        let auth = Authority {
            ring: &ring,
            ctx: &ctx,
            tenant_key: &tenant_key,
            watch: &watch,
        };
        grants::retire_key(&tx, &auth, &key_id, &signature, at)
            .await
            .expect("a holder may retire their own key");
        tx.commit().await.expect("commit");
    }

    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, subject).await;

    // The row records it, and the account has no signing key any more.
    let retired: bool = tx
        .query_one(
            "SELECT retired_at IS NOT NULL FROM account_keys WHERE id = $1",
            &[&key_id],
        )
        .await
        .expect("the key")
        .get(0);
    assert!(retired, "retirement must be written, not merely logged");
    assert!(
        grants::signing_key_of(&tx, &subject.to_string())
            .await
            .expect("read")
            .is_none(),
        "a retired key is not a signing key"
    );

    // **And the grant it was named in still authorises**, because §3.3
    // resolves the keyring entry as of `effective_from`, not as of now.
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let caps = grants::authorise_account(&tx, &auth, None, Capability::Draw)
        .await
        .unwrap_or_else(|e| panic!("grant {grant_id} must survive its key's retirement: {e:?}"));
    assert_eq!(caps.capability, Capability::Draw);
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_key_may_not_be_superseded_onto_another_account() {
    // §8.4's succession is a statement about one account's own keyring. Naming
    // somebody else's key a successor would move every grant that names the
    // old fingerprint onto an account that never asked for it.
    let pool = support::migrated_pool().await;
    let ring = keyring(89);
    let estate = bootstrap(&pool, &ring, 1).await;
    let (stranger, stranger_key) = a_bystander(&pool, &ring, &estate, "stranger").await;
    let mut client = pool.get().await.expect("connection");

    let (tx, ctx, tenant_key) = acting(
        &mut client,
        &ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;
    let mine = grants::signing_key_of(&tx, &estate.stewards[0].account.to_string())
        .await
        .expect("read")
        .expect("a key");
    let theirs = grants::signing_key_of(&tx, &stranger.to_string())
        .await
        .expect("read")
        .expect("a key");
    let at = now_unix();
    let signature = estate.stewards[0].key.sign(&authority::succession_bytes(
        &estate.stewards[0].account.to_string(),
        &mine.fpr,
        &theirs.fpr,
        at,
    ));
    let watch = EpochWatch::new();
    let auth = Authority {
        ring: &ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let refused = grants::supersede_key(&tx, &auth, &mine.id, &theirs.id, &signature, at).await;
    assert!(
        matches!(
            refused,
            Err(AuthorityError::Unverifiable(
                "key succession across accounts"
            ))
        ),
        "a succession must not move authority between accounts: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
    let _ = stranger_key;
}

#[tokio::test]
async fn no_verdict_is_cached_between_two_uses_in_one_process() {
    // §3.4: *"no verdict is ever stored"*. The mutation that proves it: a
    // successful authorisation, then the stored `granter_sig` swapped for its
    // own valid high-`s` twin, then a second authorisation in the same
    // process. A layer that remembered the first answer would give it again.
    //
    // The twin is a REAL, valid ECDSA signature over the same message under
    // the same key -- not a corrupted blob, which any check would reject.
    let pool = support::migrated_pool().await;
    let ring = keyring(90);
    let (estate, subject, _key, grant_id) = an_estate_with_a_draw_grant(&pool, &ring).await;
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
        grants::authorise_account(&tx, &auth, None, Capability::Draw)
            .await
            .expect("it works first");
        tx.rollback().await.expect("rollback");
    }

    let stored: Vec<u8> = {
        let (tx, _ctx, _tk) = acting(&mut client, &ring, estate.organisation, subject).await;
        let sig = tx
            .query_one(
                "SELECT granter_sig FROM scope_grants WHERE id = $1",
                &[&grant_id],
            )
            .await
            .expect("the grant")
            .get(0);
        tx.rollback().await.expect("rollback");
        sig
    };
    let twin = high_s_twin(&stored.clone().try_into().expect("64 bytes"));

    let superuser = support::superuser_client_on_test_database().await;
    let tamper_gate = support::hold_the_tamper_lock().await;
    superuser
        .batch_execute("ALTER TABLE scope_grants DISABLE TRIGGER USER")
        .await
        .expect("tier 3 owns the table");
    superuser
        .execute(
            "UPDATE scope_grants SET granter_sig = $1 WHERE id = $2",
            &[&twin.to_vec(), &grant_id],
        )
        .await
        .expect("swap in the malleable twin");
    superuser
        .batch_execute("ALTER TABLE scope_grants ENABLE TRIGGER USER")
        .await
        .expect("put it back");
    tamper_gate.release().await;

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
        matches!(refused, Err(AuthorityError::Unverifiable(_))),
        "the second use must re-derive everything from the stored rows, so a signature swapped \
         between the two is caught: {refused:?}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn two_transactions_signing_at_once_never_share_an_epoch() {
    // `advance_head`/`next_epoch` take `FOR UPDATE` on the head row, so two
    // concurrent signers in one organisation serialise. What must never happen
    // is two grants at one epoch, which would mean the head's statement about
    // its own state named two different states.
    let pool = support::migrated_pool().await;
    let ring = keyring(91);
    let estate = bootstrap(&pool, &ring, 1).await;
    let (one, one_key) = a_bystander(&pool, &ring, &estate, "one").await;
    let (two, two_key) = a_bystander(&pool, &ring, &estate, "two").await;
    let _ = (&one_key, &two_key);

    // Two connections, two transactions, both live at once.
    let mut client_a = pool.get().await.expect("connection a");
    let mut client_b = pool.get().await.expect("connection b");

    let (tx_a, ctx_a, key_a) = acting(
        &mut client_a,
        &ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;
    let watch_a = EpochWatch::new();
    let auth_a = Authority {
        ring: &ring,
        ctx: &ctx_a,
        tenant_key: &key_a,
        watch: &watch_a,
    };
    let proposal_a = grants::propose_grant(
        &tx_a,
        &auth_a,
        &GrantRequest {
            scope: None,
            subject: one,
            capability: Capability::Draw,
            expires_at_unix: 0,
        },
    )
    .await
    .expect("proposed a");
    let sig_a = estate.stewards[0].key.sign(&proposal_a.bytes);
    let id_a = grants::sign_grant(&tx_a, &auth_a, &proposal_a, &sig_a)
        .await
        .expect("a commits");
    tx_a.commit().await.expect("commit a");

    // B proposes only after A has committed, so B sees the advanced head.
    let (tx_b, ctx_b, key_b) = acting(
        &mut client_b,
        &ring,
        estate.organisation,
        estate.stewards[0].account,
    )
    .await;
    let watch_b = EpochWatch::new();
    let auth_b = Authority {
        ring: &ring,
        ctx: &ctx_b,
        tenant_key: &key_b,
        watch: &watch_b,
    };
    let proposal_b = grants::propose_grant(
        &tx_b,
        &auth_b,
        &GrantRequest {
            scope: None,
            subject: two,
            capability: Capability::Draw,
            expires_at_unix: 0,
        },
    )
    .await
    .expect("proposed b");
    let sig_b = estate.stewards[0].key.sign(&proposal_b.bytes);
    let id_b = grants::sign_grant(&tx_b, &auth_b, &proposal_b, &sig_b)
        .await
        .expect("b commits");
    tx_b.commit().await.expect("commit b");

    assert_ne!(
        proposal_a.auth_epoch, proposal_b.auth_epoch,
        "two grants must never claim one epoch"
    );

    let mut client = pool.get().await.expect("connection");
    let (tx, _ctx, _tk) = acting(&mut client, &ring, estate.organisation, one).await;
    let epochs: Vec<i32> = tx
        .query(
            "SELECT auth_epoch FROM scope_grants WHERE id = ANY($1) ORDER BY auth_epoch",
            &[&vec![id_a.clone(), id_b.clone()]],
        )
        .await
        .expect("the two grants")
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(epochs.len(), 2);
    assert_eq!(
        epochs[1] - epochs[0],
        1,
        "consecutive, with no epoch skipped or repeated: {epochs:?}"
    );
    tx.rollback().await.expect("rollback");
}

/// Re-seal every grant row of an organisation under the current chain key.
///
/// **A test-only tier-3 move, and it exists for one reason**: two tests need a
/// clock moved — an expiry into the past, a delay into the past — and no test
/// can wait a day or reach the server's clock. Editing the row breaks its
/// seal, so the seal has to be recomputed or the authority is `Unverifiable`
/// for a reason that has nothing to do with what is being tested.
///
/// This is not a hole in the fence: it needs the chain master, which is the
/// thing the fence rests on, and the test holds it only because the test
/// created the organisation.
async fn reseal_every_grant(
    tx: &deadpool_postgres::Transaction<'_>,
    chain_master: u8,
    estate: &Estate,
) {
    use fathom_server::authority::RowFacts;

    let organisation = estate.organisation.to_string();
    let chain_key = fathom_server::chain::chain_key(
        &Key32::from_bytes([chain_master; 32]),
        ChainRef::Org {
            organisation: &organisation,
        },
        fathom_server::chains::CHAIN_KEY_EPOCH,
    );
    let row_key = authority::row_key(&chain_key);

    let rows = tx
        .query(
            "SELECT id, scope_id, subject_id, subject_key_fpr, capability, granted_by, \
                    granter_key_fpr, granter_sig, is_genesis, is_recovery, \
                    sole_steward_appointment, auth_epoch, \
                    EXTRACT(EPOCH FROM effective_from)::bigint, \
                    COALESCE(EXTRACT(EPOCH FROM expires_at)::bigint, 0), \
                    chain_seq, row_version \
               FROM scope_grants WHERE organisation_id = $1",
            &[&organisation],
        )
        .await
        .expect("the grants");

    let superuser = support::superuser_client_on_test_database().await;
    let tamper_gate = support::hold_the_tamper_lock().await;
    superuser
        .batch_execute("ALTER TABLE scope_grants DISABLE TRIGGER USER")
        .await
        .expect("tier 3");
    for row in rows {
        let id: String = row.get(0);
        let scope_id: Option<String> = row.get(1);
        let granted_by: Option<String> = row.get(5);
        let subject_fpr: Vec<u8> = row.get(3);
        let granter_fpr: Vec<u8> = row.get(6);
        let granter_sig: Vec<u8> = row.get(7);

        // The canonical row state `grants.rs` seals, rebuilt here. Kept in
        // step with `grant_row_state` by this test failing loudly if it drifts.
        let mut map = BTreeMap::new();
        map.insert(
            "auth_epoch".to_string(),
            Json::Int(i64::from(row.get::<_, i32>(11))),
        );
        map.insert("capability".to_string(), Json::Str(row.get::<_, String>(4)));
        map.insert("effective_from".to_string(), Json::Int(row.get(12)));
        map.insert("expires_at".to_string(), Json::Int(row.get(13)));
        map.insert(
            "granted_by".to_string(),
            match &granted_by {
                Some(v) => Json::Str(v.clone()),
                None => Json::Null,
            },
        );
        map.insert("granter_key_fpr".to_string(), Json::Str(hex(&granter_fpr)));
        map.insert("granter_sig".to_string(), Json::Str(hex(&granter_sig)));
        map.insert("is_genesis".to_string(), Json::Bool(row.get(8)));
        map.insert("is_recovery".to_string(), Json::Bool(row.get(9)));
        map.insert(
            "organisation_id".to_string(),
            Json::Str(organisation.clone()),
        );
        map.insert(
            "scope_id".to_string(),
            match &scope_id {
                Some(v) => Json::Str(v.clone()),
                None => Json::Null,
            },
        );
        map.insert(
            "sole_steward_appointment".to_string(),
            Json::Bool(row.get(10)),
        );
        map.insert("subject_id".to_string(), Json::Str(row.get::<_, String>(2)));
        map.insert("subject_key_fpr".to_string(), Json::Str(hex(&subject_fpr)));
        let state = Json::Obj(map).to_canonical_bytes();

        let seal = authority::row_seal(
            &row_key,
            &RowFacts {
                table: "scope_grants",
                row_id: &id,
                chain_seq: row.get(14),
                row_version: row.get(15),
                row_state: &state,
            },
        );
        superuser
            .execute(
                "UPDATE scope_grants SET row_seal = $1 WHERE id = $2",
                &[&seal.to_vec(), &id],
            )
            .await
            .expect("re-seal");
    }
    superuser
        .batch_execute("ALTER TABLE scope_grants ENABLE TRIGGER USER")
        .await
        .expect("put it back");
    tamper_gate.release().await;
}

// ---------------------------------------------------------------------------
// The third checker round, 2026-09-13 — the sole-steward flag outside the
// signature, and the seconding walk
// ---------------------------------------------------------------------------

/// Authorise `who` for `steward` at the organisation, and hand back the raw
/// answer — these tests are about *which* refusal, not only that there is one.
async fn steward_answer(
    client: &mut deadpool_postgres::Client,
    ring: &KeyRing,
    organisation: OrganisationId,
    who: AccountId,
) -> Result<fathom_server::grants::Capabilities, AuthorityError> {
    let (tx, ctx, tenant_key) = acting(client, ring, organisation, who).await;
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    let answer = grants::authorise_account(&tx, &auth, None, Capability::Steward).await;
    tx.rollback().await.expect("rollback");
    answer
}

/// Grant `steward` to one account, signed by `estate.stewards[granter]`.
async fn appoint(
    client: &mut deadpool_postgres::Client,
    ring: &KeyRing,
    estate: &Estate,
    granter: usize,
    subject: AccountId,
    subject_key: &SoftwareKey,
) -> String {
    let (tx, ctx, tenant_key) = acting(
        client,
        ring,
        estate.organisation,
        estate.stewards[granter].account,
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
        estate,
        granter,
        subject,
        subject_key,
        Capability::Steward,
        now_unix() + 3600,
    )
    .await;
    tx.commit().await.expect("commit");
    id
}

/// Second a grant **through the ordinary API**, as `seconder`.
async fn second_as(
    client: &mut deadpool_postgres::Client,
    ring: &KeyRing,
    organisation: OrganisationId,
    grant_id: &str,
    seconder: AccountId,
    seconder_key: &SoftwareKey,
) {
    let (tx, ctx, tenant_key) = acting(client, ring, organisation, seconder).await;
    let grant_bytes = grant_bytes_for(&tx, ring, grant_id).await;
    let granter_fpr: Vec<u8> = tx
        .query_one(
            "SELECT granter_key_fpr FROM scope_grants WHERE id = $1",
            &[&grant_id],
        )
        .await
        .expect("the grant")
        .get(0);
    let signature = seconder_key.sign(&authority::second_bytes(
        &grant_bytes,
        &granter_fpr.try_into().expect("32 bytes"),
    ));
    let watch = EpochWatch::new();
    let auth = Authority {
        ring,
        ctx: &ctx,
        tenant_key: &tenant_key,
        watch: &watch,
    };
    grants::second_grant(&tx, &auth, grant_id, &signature)
        .await
        .expect("the seconding verifies");
    tx.commit().await.expect("commit");
}

#[tokio::test]
async fn a_granter_who_flips_the_sole_steward_flag_after_signing_mints_nothing() {
    // **The checker's reproduction, and the worst of the three.**
    // `GrantProposal`'s fields are all `pub`; `sole_steward_appointment` was
    // outside `grant_bytes`, so the granter signed the honest bytes, set one
    // `bool` on the struct on the way back, and `sign_grant` copied it onto
    // the row. A `steward` grant with the flag set needs no seconding and
    // waits no 24 hours -- so §3.5's entire quorum came down to a field
    // nobody had attested and nobody re-derived.
    let pool = support::migrated_pool().await;
    let ring = keyring(84);
    let estate = bootstrap(&pool, &ring, 2).await;
    let (subject, _subject_key) = a_bystander(&pool, &ring, &estate, "candidate").await;

    let mut client = pool.get().await.expect("connection");
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

    let proposal = grants::propose_grant(
        &tx,
        &auth,
        &GrantRequest {
            scope: None,
            subject,
            capability: Capability::Steward,
            expires_at_unix: now_unix() + 3600,
        },
    )
    .await
    .expect("proposed");
    assert!(
        !proposal.sole_steward_appointment,
        "two live stewards, so this is not §3.5's sole path and the fixture is wrong if it is"
    );

    // The signature is over the bytes EXACTLY as issued. Nothing about it is
    // forged, which is what makes this the attack rather than a corrupt blob.
    let signature = estate.stewards[0].key.sign(&proposal.bytes);
    let flipped = fathom_server::grants::GrantProposal {
        sole_steward_appointment: true,
        ..proposal.clone()
    };

    let refused = grants::sign_grant(&tx, &auth, &flipped, &signature).await;
    assert!(
        matches!(refused, Err(AuthorityError::Unverifiable(_))),
        "a proposal whose fields do not spell out the bytes that were signed is forged, not \
         stale, and must be refused before anything is written: {refused:?}"
    );

    // The untouched proposal still commits, so the refusal above is the flag
    // and not the path.
    let grant_id = grants::sign_grant(&tx, &auth, &proposal, &signature)
        .await
        .expect("the untouched proposal still commits");
    let sole: bool = tx
        .query_one(
            "SELECT sole_steward_appointment FROM scope_grants WHERE id = $1",
            &[&grant_id],
        )
        .await
        .expect("the grant")
        .get(0);
    assert!(!sole, "the row carries the re-derived flag");
    tx.commit().await.expect("commit");

    // And the appointment is inert until a second steward seconds it, which
    // is the control the flip went around.
    let refused = steward_answer(&mut client, &ring, estate.organisation, subject).await;
    assert!(
        matches!(refused, Err(AuthorityError::QuorumNotMet { .. })),
        "{refused:?}"
    );
}

#[tokio::test]
async fn a_proposal_whose_sole_steward_flag_no_longer_holds_is_refused_with_re_propose() {
    // The other half: the flag being signed is not enough on its own, because
    // the granter signs what the SERVER proposed. If a second steward becomes
    // live between the two steps, a one-signature appointment is no longer one
    // §3.5 allows -- so every server-chosen value is re-derived at commit and
    // any difference is the typed re-propose error.
    let pool = support::migrated_pool().await;
    let ring = keyring(85);
    // The second genesis steward is signed live from two seconds hence.
    let estate = bootstrap_with_starts(&pool, &ring, &[0, 2]).await;
    let (subject, _subject_key) = a_bystander(&pool, &ring, &estate, "candidate").await;

    let mut client = pool.get().await.expect("connection");
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

    let proposal = grants::propose_grant(
        &tx,
        &auth,
        &GrantRequest {
            scope: None,
            subject,
            capability: Capability::Steward,
            expires_at_unix: now_unix() + 30 * 24 * 3600,
        },
    )
    .await
    .expect("proposed");
    assert!(
        proposal.sole_steward_appointment,
        "the co-steward's grant is not in force yet, so the survivor is sole"
    );
    let signature = estate.stewards[0].key.sign(&proposal.bytes);

    // The co-steward becomes live while the proposal is in the signer's hands.
    // Nothing else happens, so the EPOCH is untouched -- this is the
    // sole-steward re-derivation being the check that fires, not the epoch.
    tokio::time::sleep(std::time::Duration::from_millis(3000)).await;

    let refused = grants::sign_grant(&tx, &auth, &proposal, &signature).await;
    match refused {
        Err(AuthorityError::Stale(why)) => assert!(
            why.contains("sole-steward"),
            "the refusal must name the fact that moved, so the caller knows what to propose \
             again: {why}"
        ),
        other => panic!(
            "a sole-steward appointment signed when the organisation had one steward must not \
             commit once it has two: {other:?}"
        ),
    }
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_cycle_of_secondings_does_not_brick_the_stewards_involved() {
    // **The checker's first reproduction.** Genesis A and B; C appointed by A
    // and seconded by B; D appointed by A and seconded by C; then D seconds
    // C's grant -- an ordinary, permitted act through the ordinary API,
    // available to any steward.
    //
    // Before: `grant_quorum_met` failed the whole grant if ANY seconding on it
    // failed, and walked into C -> D -> C until the depth limit, so C and D
    // both answered `Unverifiable("seconding chain depth")` from then on, for
    // ever, with no way to withdraw the seconding. One steward could brick
    // another by seconding something.
    let pool = support::migrated_pool().await;
    let ring = keyring(86);
    let estate = bootstrap(&pool, &ring, 2).await;
    let (c, c_key) = a_bystander(&pool, &ring, &estate, "third-steward").await;
    let (d, d_key) = a_bystander(&pool, &ring, &estate, "fourth-steward").await;
    let mut client = pool.get().await.expect("connection");

    let c_grant = appoint(&mut client, &ring, &estate, 0, c, &c_key).await;
    second_as(
        &mut client,
        &ring,
        estate.organisation,
        &c_grant,
        estate.stewards[1].account,
        &estate.stewards[1].key,
    )
    .await;
    let d_grant = appoint(&mut client, &ring, &estate, 0, d, &d_key).await;
    second_as(&mut client, &ring, estate.organisation, &d_grant, c, &c_key).await;

    // Both are stewards before the cycle closes.
    steward_answer(&mut client, &ring, estate.organisation, c)
        .await
        .expect("C is a steward");
    steward_answer(&mut client, &ring, estate.organisation, d)
        .await
        .expect("D is a steward");

    // D seconds C's grant. C's stewardship does not need it -- B already
    // seconded -- and D is entitled to make it.
    second_as(&mut client, &ring, estate.organisation, &c_grant, d, &d_key).await;

    let after_c = steward_answer(&mut client, &ring, estate.organisation, c).await;
    assert!(
        matches!(&after_c, Ok(capabilities) if capabilities.capability == Capability::Steward),
        "C's stewardship rests on B's seconding and cannot be undone by a second, circular \
         one: {after_c:?}"
    );
    let after_d = steward_answer(&mut client, &ring, estate.organisation, d).await;
    assert!(
        matches!(&after_d, Ok(capabilities) if capabilities.capability == Capability::Steward),
        "and D, whose grant C seconded, is unaffected: {after_d:?}"
    );
}

#[tokio::test]
async fn a_chain_of_twenty_appointments_authorises_at_every_generation() {
    // **The checker's second reproduction.** Each new steward is granted by A
    // and seconded by the previous appointee, so verifying generation n means
    // verifying n-1 behind it. `SECONDING_DEPTH_LIMIT = 8` turned generation
    // nine of an ordinary, entirely honest appointment chain into
    // `Unverifiable` -- an integrity alarm about a store that was telling the
    // truth.
    //
    // Twenty rather than nine, because nine only proves the old bound moved.
    let pool = support::migrated_pool().await;
    let ring = keyring(87);
    let estate = bootstrap(&pool, &ring, 2).await;
    let mut client = pool.get().await.expect("connection");

    let mut appointees: Vec<(AccountId, SoftwareKey)> = Vec::new();
    for generation in 1..=20 {
        let (next, next_key) =
            a_bystander(&pool, &ring, &estate, &format!("generation{generation}")).await;
        let grant = appoint(&mut client, &ring, &estate, 0, next, &next_key).await;
        // The previous appointee seconds -- or, for generation one, the second
        // genesis steward.
        let (seconder, seconder_key) = match appointees.last() {
            Some((account, key)) => (*account, key),
            None => (estate.stewards[1].account, &estate.stewards[1].key),
        };
        second_as(
            &mut client,
            &ring,
            estate.organisation,
            &grant,
            seconder,
            seconder_key,
        )
        .await;

        let answer = steward_answer(&mut client, &ring, estate.organisation, next).await;
        assert!(
            matches!(&answer, Ok(capabilities) if capabilities.capability == Capability::Steward),
            "generation {generation} of an honest appointment chain must authorise: {answer:?}"
        );
        appointees.push((next, next_key));
    }
}

#[tokio::test]
async fn a_genuine_cycle_of_secondings_makes_nobody_a_steward() {
    // The case the visited set exists for, and the one the depth limit used to
    // answer with an integrity alarm: X's only seconding is by Y, Y's only
    // seconding is by X, and neither has any other support. Neither is a
    // steward -- and that is a permission answer about a quorum that is not
    // met, not a claim that the store has been tampered with.
    //
    // It cannot be built through the API (the API asks a seconder to be a
    // steward first), so the rows go in directly WITH CORRECT SEALS and the
    // head is advanced through the real path -- otherwise the whole-state
    // check would refuse it first and this test would prove nothing about the
    // walk.
    let pool = support::migrated_pool().await;
    let ring = keyring(88);
    let estate = bootstrap(&pool, &ring, 2).await;
    let (x, x_key) = a_bystander(&pool, &ring, &estate, "x").await;
    let (y, y_key) = a_bystander(&pool, &ring, &estate, "y").await;
    let mut client = pool.get().await.expect("connection");

    let x_grant = appoint(&mut client, &ring, &estate, 0, x, &x_key).await;
    let y_grant = appoint(&mut client, &ring, &estate, 0, y, &y_key).await;

    let (tx, ctx, tenant_key) = acting(&mut client, &ring, estate.organisation, x).await;
    insert_seconding_directly(&tx, 88, &estate, &x_grant, y, &y_key).await;
    insert_seconding_directly(&tx, 88, &estate, &y_grant, x, &x_key).await;
    grants::advance_head(&tx, &ring, &ctx, &tenant_key)
        .await
        .expect("the head covers the new rows");
    tx.commit().await.expect("commit");

    for (who, name) in [(x, "X"), (y, "Y")] {
        let answer = steward_answer(&mut client, &ring, estate.organisation, who).await;
        assert!(
            matches!(answer, Err(AuthorityError::QuorumNotMet { .. })),
            "{name}'s only seconding is by somebody whose own stewardship depends on {name}, so \
             the quorum is not met -- which is a permission answer, not `Unverifiable`: {answer:?}"
        );
    }
}

/// Insert one seconding row directly, sealed correctly and signed genuinely.
///
/// The tier-2 route: the application role can write this table, so the fence
/// has to be at use. The seal is computed rather than forged because the point
/// of the test above is the WALK, and a bad seal is refused earlier by
/// `verify_stored_seals` -- which is its own test, and passes.
async fn insert_seconding_directly(
    tx: &deadpool_postgres::Transaction<'_>,
    chain_master: u8,
    estate: &Estate,
    grant_id: &str,
    seconder: AccountId,
    seconder_key: &SoftwareKey,
) {
    let organisation = estate.organisation.to_string();
    let row = tx
        .query_one(
            "SELECT subject_id, granted_by, granter_key_fpr FROM scope_grants WHERE id = $1",
            &[&grant_id],
        )
        .await
        .expect("the grant");
    let subject_id: String = row.get(0);
    let granted_by: Option<String> = row.get(1);
    let granter_fpr: Vec<u8> = row.get(2);

    let grant_bytes = grant_bytes_for(tx, &keyring(chain_master), grant_id).await;
    let signature = seconder_key.sign(&authority::second_bytes(
        &grant_bytes,
        &granter_fpr.clone().try_into().expect("32 bytes"),
    ));
    let seconder_fpr = authority::key_fingerprint(&seconder_key.public_key());
    let id = fathom_server::ids::new_ulid().to_string();

    // The head's own chain sequence: at or past every grant in the
    // organisation, so the seconding is not refused merely for predating what
    // it seconds.
    let chain_seq: i64 = tx
        .query_one(
            "SELECT chain_seq FROM organisation_auth_head WHERE organisation_id = $1",
            &[&organisation],
        )
        .await
        .expect("the head")
        .get(0);

    // `seconding_row_state`, rebuilt here. Kept in step by this test failing
    // loudly if it drifts.
    let mut map = BTreeMap::new();
    map.insert("grant_id".to_string(), Json::Str(grant_id.to_string()));
    map.insert("seconded_by".to_string(), Json::Str(seconder.to_string()));
    map.insert(
        "seconder_key_fpr".to_string(),
        Json::Str(hex(&seconder_fpr)),
    );
    map.insert("seconder_sig".to_string(), Json::Str(hex(&signature)));
    let row_state = Json::Obj(map).to_canonical_bytes();

    let chain_key = fathom_server::chain::chain_key(
        &Key32::from_bytes([chain_master; 32]),
        ChainRef::Org {
            organisation: &organisation,
        },
        chains::CHAIN_KEY_EPOCH,
    );
    let seal = authority::row_seal(
        &authority::row_key(&chain_key),
        &authority::RowFacts {
            table: "grant_secondings",
            row_id: &id,
            chain_seq,
            row_version: 1,
            row_state: &row_state,
        },
    );

    tx.execute(
        "INSERT INTO grant_secondings \
             (id, grant_id, organisation_id, grant_subject_id, grant_granter_id, seconded_by, \
              seconder_key_fpr, seconder_sig, chain_seq, row_seal) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        &[
            &id,
            &grant_id,
            &organisation,
            &subject_id,
            &granted_by,
            &seconder.to_string(),
            &seconder_fpr.to_vec(),
            &signature.to_vec(),
            &chain_seq,
            &seal.to_vec(),
        ],
    )
    .await
    .expect("the application role can write this table -- the fence is at use");
}
