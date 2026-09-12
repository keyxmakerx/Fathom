//! The key hierarchy and encrypted design storage, against a real
//! PostgreSQL.
//!
//! **These tests are written against the claim, not against the code.** The
//! one that matters most is
//! [`a_marker_written_through_the_real_path_appears_in_no_stored_byte`]: it
//! writes a design containing a distinctive marker and then reads the **raw
//! bytes of the stored column**, asserting the marker is absent. That tests
//! that the payload is actually encrypted. A test that asserted "the encrypt
//! function was called" would pass against a build that stored the plaintext
//! beside the ciphertext.
//!
//! The others are the same shape: tamper with an entry and prove verification
//! says *broken at N* with everything before N still verified; configure the
//! wrong master key and prove the failure names two key ids rather than
//! looking like corruption.

use deadpool_postgres::Pool;

use fathom_server::chain::{BreakReason, ContentState, Depth, EntryType, Outcome};
use fathom_server::crypto::Key32;
use fathom_server::designs::{self, DesignError};
use fathom_server::keys::{self, KeyRing, KeyStoreError};
use fathom_server::repo::{self, AccountId, DesignId, OrganisationId, Role, ScopeKind};

mod support;

/// **One master key for the whole test database, and that is the design
/// showing through rather than a convenience.** ADR-0043 §4 stamps the
/// configured key's id into `master_keys` and refuses a second one: a database
/// is encrypted under one master key at a time, so tests sharing a database
/// share a master key. The one test that uses a different one is
/// [`the_wrong_master_key_reports_a_key_id_mismatch_and_not_corruption`], and
/// the refusal is what it asserts.
const MASTER: [u8; 32] = [21; 32];

/// A key ring on the shared master key, with a chain master of the caller's
/// choosing — the chain key is per design and per deployment, and nothing in
/// the database pins which one a verifier holds.
fn keyring(chain: u8) -> KeyRing {
    KeyRing::from_keys(Key32::from_bytes(MASTER), Key32::from_bytes([chain; 32]))
}

/// A distinctive marker: the thing a real design payload would carry and the
/// thing a database dump must not.
const MARKER: &str = "MARKER-10.1.1.0/24-core-fw-01-MARKER";

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

/// An account, an organisation it administers, and a rack to hang designs on.
async fn a_tenant(pool: &Pool) -> (AccountId, OrganisationId, repo::Scope) {
    let account = repo::create_account(pool, &unique("someone@example.test"), "Someone")
        .await
        .expect("create account");
    let org = repo::create_organisation(pool, account.id, &unique("Org"))
        .await
        .expect("create organisation");
    let network = repo::create_scope(pool, org.id, account.id, None, ScopeKind::Network, "net")
        .await
        .expect("network");
    let building = repo::create_scope(
        pool,
        org.id,
        account.id,
        Some(network.id),
        ScopeKind::Building,
        "building",
    )
    .await
    .expect("building");
    let rack = repo::create_scope(
        pool,
        org.id,
        account.id,
        Some(building.id),
        ScopeKind::Rack,
        "rack",
    )
    .await
    .expect("rack");
    (account.id, org.id, rack)
}

async fn a_design(pool: &Pool) -> (AccountId, OrganisationId, DesignId) {
    let (account, org, rack) = a_tenant(pool).await;
    let design = designs::create_design(pool, org, account, rack.id)
        .await
        .expect("create design");
    (account, org, design)
}

// ---------------------------------------------------------------------------
// The claim: it is encrypted at rest
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_marker_written_through_the_real_path_appears_in_no_stored_byte() {
    let pool = support::migrated_pool().await;
    let ring = keyring(12);
    let (account, org, design) = a_design(&pool).await;

    let payload = format!(r#"{{"devices":[{{"name":"{MARKER}"}}]}}"#);
    designs::write_version(&pool, &ring, org, account, design, payload.as_bytes(), 1)
        .await
        .expect("write");

    // THE RAW COLUMN, read as bytes, with no decryption anywhere in sight.
    let client = pool.get().await.expect("connection");
    let rows = client
        .query(
            "SELECT set_config('app.tenant_id', $1, false), \
                    set_config('app.design_capability', 'yes', false)",
            &[&org.to_string()],
        )
        .await;
    assert!(rows.is_ok(), "{rows:?}");
    let row = client
        .query_one(
            "SELECT ciphertext FROM design_payload WHERE design_id = $1",
            &[&design.to_string()],
        )
        .await
        .expect("read the stored bytes");
    let stored: Vec<u8> = row.get(0);

    assert!(!stored.is_empty(), "nothing was stored at all");
    assert!(
        !contains(&stored, MARKER.as_bytes()),
        "the marker is present in the stored ciphertext -- this payload is NOT encrypted at rest"
    );
    // ...and not by some encoding either: neither the whole payload nor a
    // recognisable fragment of it survives.
    assert!(!contains(&stored, b"devices"), "a plaintext key survived");
    assert!(
        !contains(&stored, b"10.1.1.0/24"),
        "a plaintext address survived"
    );

    // The ciphertext is the plaintext's length plus the Poly1305 tag, which
    // is the other half of "whole-payload encryption": nothing was left out.
    assert_eq!(stored.len(), payload.len() + 16);

    // And it really is the design: it reads back.
    let back = designs::read_version(&pool, &ring, org, account, design, None)
        .await
        .expect("read back");
    assert_eq!(back.payload, payload.as_bytes());
}

#[tokio::test]
async fn every_version_round_trips_and_versions_are_sequential() {
    let pool = support::migrated_pool().await;
    let ring = keyring(14);
    let (account, org, design) = a_design(&pool).await;

    assert_eq!(
        designs::write_version(&pool, &ring, org, account, design, b"one", 1)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        designs::write_version(&pool, &ring, org, account, design, b"two", 1)
            .await
            .unwrap(),
        2
    );

    let first = designs::read_version(&pool, &ring, org, account, design, Some(1))
        .await
        .unwrap();
    assert_eq!(first.payload, b"one");
    let latest = designs::read_version(&pool, &ring, org, account, design, None)
        .await
        .unwrap();
    assert_eq!(latest.version, 2);
    assert_eq!(latest.payload, b"two");
}

#[tokio::test]
async fn two_writes_of_identical_content_produce_different_ciphertext() {
    // Fresh random nonce per operation (§12.3). Identical plaintext under the
    // same key must not produce identical bytes, or a dump tells an attacker
    // which versions are unchanged.
    let pool = support::migrated_pool().await;
    let ring = keyring(16);
    let (account, org, design) = a_design(&pool).await;

    designs::write_version(&pool, &ring, org, account, design, b"same", 1)
        .await
        .unwrap();
    designs::write_version(&pool, &ring, org, account, design, b"same", 1)
        .await
        .unwrap();

    let client = pool.get().await.unwrap();
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false), \
                    set_config('app.design_capability', 'yes', false)",
            &[&org.to_string()],
        )
        .await
        .unwrap();
    let rows = client
        .query(
            "SELECT ciphertext, nonce FROM design_payload WHERE design_id = $1 \
             ORDER BY design_version",
            &[&design.to_string()],
        )
        .await
        .unwrap();
    let a: Vec<u8> = rows[0].get(0);
    let b: Vec<u8> = rows[1].get(0);
    let na: Vec<u8> = rows[0].get(1);
    let nb: Vec<u8> = rows[1].get(1);
    assert_ne!(a, b, "identical plaintext produced identical ciphertext");
    assert_ne!(na, nb, "the nonce repeated");
}

// ---------------------------------------------------------------------------
// The wrong master key
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_wrong_master_key_reports_a_key_id_mismatch_and_not_corruption() {
    let pool = support::migrated_pool().await;
    let right = keyring(22);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &right, org, account, design, b"payload", 1)
        .await
        .expect("write");

    // A different master key, same database. ADR-0043 §4: this must NOT
    // surface as an AEAD tag failure.
    let wrong = KeyRing::from_keys(Key32::from_bytes([99; 32]), Key32::from_bytes([22; 32]));
    let err = designs::read_version(&pool, &wrong, org, account, design, None)
        .await
        .expect_err("reading under the wrong master key must fail");

    let message = err.to_string();
    assert!(
        matches!(
            err,
            DesignError::Keys(KeyStoreError::MasterKey(
                keys::MasterKeyError::Mismatch { .. }
            ))
        ),
        "expected a master-key mismatch, got: {err:?} ({message})"
    );
    assert!(
        message.contains("this database was encrypted under master key"),
        "{message}"
    );
    assert!(
        message.contains(&Key32::from_bytes(MASTER).id().to_string()),
        "{message}"
    );
    assert!(
        message.contains(&Key32::from_bytes([99; 32]).id().to_string()),
        "{message}"
    );
    assert!(
        message.contains("not corruption"),
        "the message must not read like corruption: {message}"
    );
    // And it must not be the generic decryption refusal.
    assert!(!matches!(err, DesignError::Refused), "{message}");
}

#[tokio::test]
async fn the_master_key_id_is_stamped_once_and_retired_rows_are_never_deleted() {
    let pool = support::migrated_pool().await;
    let ring = keyring(24);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"x", 1)
        .await
        .unwrap();

    let client = pool.get().await.unwrap();
    let row = client
        .query_one(
            "SELECT key_id, status FROM master_keys WHERE status = 'active'",
            &[],
        )
        .await
        .expect("an active master key row");
    let stored: String = row.get(0);
    assert_eq!(stored, ring.master_key_id().to_string());

    // Re-registering the same key is a no-op, not a second row.
    keys::register_master_key(&client, &ring)
        .await
        .expect("idempotent");
    let count: i64 = client
        .query_one("SELECT count(*) FROM master_keys", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 1);
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_written_design_verifies_and_a_links_only_run_says_what_it_did_not_check() {
    let pool = support::migrated_pool().await;
    let ring = keyring(32);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"one", 1)
        .await
        .unwrap();
    designs::write_version(&pool, &ring, org, account, design, b"two", 1)
        .await
        .unwrap();

    let links = designs::verify_design(&pool, &ring, org, account, design, false)
        .await
        .unwrap();
    assert_eq!(links.outcome, Outcome::Verified { entries: 2 });
    assert_eq!(links.depth, Depth::Links);
    assert_eq!(links.content, ContentState::NotRebound);
    assert!(links.summary().contains("CONTENT NOT RE-BOUND"), "{links}");

    let deep = designs::verify_design(&pool, &ring, org, account, design, true)
        .await
        .unwrap();
    assert_eq!(deep.outcome, Outcome::Verified { entries: 2 });
    assert_eq!(deep.content, ContentState::Rebound);
    assert_ne!(
        links.summary(),
        deep.summary(),
        "a links-only run and a deep run must not read the same"
    );
}

#[tokio::test]
async fn tampering_with_entry_two_reports_broken_at_two_with_entry_one_still_verified() {
    let pool = support::migrated_pool().await;
    let ring = keyring(34);
    let (account, org, design) = a_design(&pool).await;
    for n in 1..=3 {
        designs::write_version(
            &pool,
            &ring,
            org,
            account,
            design,
            format!("v{n}").as_bytes(),
            1,
        )
        .await
        .unwrap();
    }

    // The attacker here is someone with write access to the database and no
    // chain key -- exactly the attacker §6 says the seal detects. The
    // superuser connection is how a test gets that reach: the runtime role
    // has no UPDATE policy on `chain_entries` at all.
    let su = support::superuser_client_on_test_database().await;
    let changed = su
        .execute(
            "UPDATE chain_entries SET metadata = $2 WHERE design_id = $1 AND seq = 2",
            &[
                &design.to_string(),
                &br#"{"actor":"someone else"}"#.to_vec(),
            ],
        )
        .await
        .expect("tamper");
    assert_eq!(changed, 1);

    let report = designs::verify_design(&pool, &ring, org, account, design, false)
        .await
        .unwrap();
    match report.outcome {
        Outcome::BrokenAt {
            seq,
            reason,
            verified_before,
            ..
        } => {
            assert_eq!(seq, 2);
            assert_eq!(reason, BreakReason::SealDoesNotRecompute);
            assert_eq!(
                verified_before, 1,
                "entry 1 must still be reported verified"
            );
        }
        other => panic!("expected broken at 2, got {other:?}"),
    }
    assert!(report.summary().contains("BROKEN AT ENTRY 2"), "{report}");
}

#[tokio::test]
async fn swapping_one_designs_stored_bytes_for_another_is_caught_without_decrypting() {
    let pool = support::migrated_pool().await;
    let ring = keyring(36);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"the real payload", 1)
        .await
        .unwrap();

    let su = support::superuser_client_on_test_database().await;
    su.execute(
        "UPDATE design_payload SET ciphertext = $2 WHERE design_id = $1",
        &[
            &design.to_string(),
            &b"not the real payload at all".to_vec(),
        ],
    )
    .await
    .expect("swap the blob");

    // Links only: no decryption, and it still catches it.
    let report = designs::verify_design(&pool, &ring, org, account, design, false)
        .await
        .unwrap();
    assert!(
        matches!(
            report.outcome,
            Outcome::BrokenAt {
                reason: BreakReason::StorageBindingMismatchUnexplained,
                ..
            }
        ),
        "{report}"
    );
}

#[tokio::test]
async fn a_chain_entry_deleted_from_the_middle_breaks_the_links() {
    let pool = support::migrated_pool().await;
    let ring = keyring(38);
    let (account, org, design) = a_design(&pool).await;
    for n in 1..=3 {
        designs::write_version(
            &pool,
            &ring,
            org,
            account,
            design,
            format!("v{n}").as_bytes(),
            1,
        )
        .await
        .unwrap();
    }

    let su = support::superuser_client_on_test_database().await;
    su.execute(
        "DELETE FROM chain_entries WHERE design_id = $1 AND seq = 2",
        &[&design.to_string()],
    )
    .await
    .expect("delete");

    let report = designs::verify_design(&pool, &ring, org, account, design, false)
        .await
        .unwrap();
    assert!(
        matches!(
            report.outcome,
            Outcome::BrokenAt {
                seq: 3,
                reason: BreakReason::SequenceSkippedOrRepeated,
                ..
            }
        ),
        "{report}"
    );
}

#[tokio::test]
async fn a_chain_does_not_verify_under_a_different_chain_master() {
    let pool = support::migrated_pool().await;
    let ring = keyring(40);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"payload", 1)
        .await
        .unwrap();

    // Same master key (so the payload still decrypts), different chain
    // master: the seal is what fails, and it fails at the first entry.
    let other_chain = keyring(41);
    let report = designs::verify_design(&pool, &other_chain, org, account, design, false)
        .await
        .unwrap();
    assert!(
        matches!(report.outcome, Outcome::BrokenAt { seq: 1, .. }),
        "{report}"
    );
}

// ---------------------------------------------------------------------------
// Rotation — the reencrypt path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rotation_re_encrypts_every_version_and_verification_stays_verified() {
    let pool = support::migrated_pool().await;
    let ring = keyring(42);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"one", 1)
        .await
        .unwrap();
    designs::write_version(&pool, &ring, org, account, design, b"two", 1)
        .await
        .unwrap();

    let before: Vec<Vec<u8>> = stored_ciphertexts(&pool, org, design).await;

    let report = designs::rotate_design(&pool, &ring, org, account, design, "test rotation")
        .await
        .expect("rotate");
    assert_eq!(report.from_key_epoch, 1);
    assert_eq!(report.to_key_epoch, 2);
    assert_eq!(report.versions_reencrypted, 2);
    assert_eq!(report.chain_entries_written, 2);
    // §12.6: the interface names the operation, and never shares a verb with
    // re-wrap.
    assert!(report.to_string().starts_with("rotate:"), "{report}");
    assert!(
        report.to_string().contains("revokes the previous key"),
        "{report}"
    );

    // The bytes changed...
    let after = stored_ciphertexts(&pool, org, design).await;
    assert_ne!(before, after, "rotation did not change the stored bytes");

    // ...the content did not...
    assert_eq!(
        designs::read_version(&pool, &ring, org, account, design, Some(1))
            .await
            .unwrap()
            .payload,
        b"one"
    );
    assert_eq!(
        designs::read_version(&pool, &ring, org, account, design, None)
            .await
            .unwrap()
            .payload,
        b"two"
    );

    // ...and the chain says so rather than alarming: two `reencrypt` entries
    // account for the new storage bindings, and the plaintext bindings are
    // carried across unchanged, which a deep run proves.
    let client = pool.get().await.unwrap();
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false)",
            &[&org.to_string()],
        )
        .await
        .unwrap();
    let rows = client
        .query(
            "SELECT entry_type, plaintext_binding FROM chain_entries \
             WHERE design_id = $1 ORDER BY seq",
            &[&design.to_string()],
        )
        .await
        .unwrap();
    let types: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
    assert_eq!(
        types,
        vec![
            EntryType::Create.as_str(),
            EntryType::Update.as_str(),
            EntryType::Reencrypt.as_str(),
            EntryType::Reencrypt.as_str()
        ]
    );
    let first_v1: Vec<u8> = rows[0].get(1);
    let reencrypt_v1: Vec<u8> = rows[2].get(1);
    assert_eq!(
        first_v1, reencrypt_v1,
        "a reencrypt entry must carry plaintext_binding across UNCHANGED -- that is the proof \
         the content did not change when the bytes did"
    );

    let deep = designs::verify_design(&pool, &ring, org, account, design, true)
        .await
        .unwrap();
    assert_eq!(deep.outcome, Outcome::Verified { entries: 4 });
    assert_eq!(deep.content, ContentState::Rebound);
}

#[tokio::test]
async fn a_retired_design_key_is_kept_and_the_new_one_is_a_different_key() {
    let pool = support::migrated_pool().await;
    let ring = keyring(44);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"one", 1)
        .await
        .unwrap();
    designs::rotate_design(&pool, &ring, org, account, design, "test")
        .await
        .unwrap();

    let client = pool.get().await.unwrap();
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false)",
            &[&org.to_string()],
        )
        .await
        .unwrap();
    let rows = client
        .query(
            "SELECT key_epoch, key_id, status, retired_reason FROM design_keys \
             WHERE design_id = $1 ORDER BY key_epoch",
            &[&design.to_string()],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 2, "the retired key must be kept forever");
    let old_id: String = rows[0].get(1);
    let new_id: String = rows[1].get(1);
    assert_ne!(old_id, new_id, "rotation must mint a NEW key");
    assert_eq!(rows[0].get::<_, String>(2), "retired");
    assert_eq!(rows[1].get::<_, String>(2), "active");
    assert_eq!(rows[0].get::<_, Option<String>>(3).as_deref(), Some("test"));
}

// ---------------------------------------------------------------------------
// Tenant separation and the B1 binding
// ---------------------------------------------------------------------------

#[tokio::test]
async fn another_tenants_account_cannot_read_a_design_at_all() {
    let pool = support::migrated_pool().await;
    let ring = keyring(52);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"secret", 1)
        .await
        .unwrap();

    let (other_account, other_org, _) = a_tenant(&pool).await;

    // Naming the right tenant with the wrong account: no membership row, so
    // no tenant context is ever opened.
    let err = designs::read_version(&pool, &ring, org, other_account, design, None)
        .await
        .expect_err("must not read");
    assert!(
        matches!(err, DesignError::Repo(repo::RepoError::NotAMember)),
        "{err:?}"
    );

    // Naming their own tenant and someone else's design id: indistinguishable
    // from a design that never existed.
    let err = designs::read_version(&pool, &ring, other_org, other_account, design, None)
        .await
        .expect_err("must not read");
    assert!(matches!(err, DesignError::NoSuchVersion), "{err:?}");
}

#[tokio::test]
async fn a_design_key_row_moved_to_another_design_is_misbound_not_refused() {
    // §4's B1 fix, end to end: the tag verifies (same tenant key), so this is
    // not a corrupted row -- it is a row that was moved, and the two must be
    // different errors.
    let pool = support::migrated_pool().await;
    let ring = keyring(54);
    let (account, org, rack) = a_tenant(&pool).await;
    let one = designs::create_design(&pool, org, account, rack.id)
        .await
        .unwrap();
    let two = designs::create_design(&pool, org, account, rack.id)
        .await
        .unwrap();
    designs::write_version(&pool, &ring, org, account, one, b"one", 1)
        .await
        .unwrap();
    designs::write_version(&pool, &ring, org, account, two, b"two", 1)
        .await
        .unwrap();

    let su = support::superuser_client_on_test_database().await;
    // Give design two the wrapped key row that belongs to design one.
    let row = su
        .query_one(
            "SELECT wrapped_key, wrap_nonce, key_id FROM design_keys WHERE design_id = $1",
            &[&one.to_string()],
        )
        .await
        .unwrap();
    let wrapped: Vec<u8> = row.get(0);
    let nonce: Vec<u8> = row.get(1);
    let key_id: String = row.get(2);
    su.execute(
        "UPDATE design_keys SET wrapped_key = $2, wrap_nonce = $3, key_id = $4 \
         WHERE design_id = $1",
        &[&two.to_string(), &wrapped, &nonce, &key_id],
    )
    .await
    .unwrap();

    let err = designs::read_version(&pool, &ring, org, account, two, None)
        .await
        .expect_err("a moved key row must not open");
    match err {
        DesignError::Keys(KeyStoreError::Unwrap { why, .. }) => assert_eq!(
            why,
            fathom_server::crypto::UnwrapError::Misbound,
            "a moved key row must be Misbound, never Refused"
        ),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn without_the_design_capability_the_payload_table_yields_nothing() {
    // `app.design_capability` is the third fence
    // (`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §11.1): absence is already a
    // refusal, so a query written later that forgets it fails CLOSED.
    let pool = support::migrated_pool().await;
    let ring = keyring(56);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"payload", 1)
        .await
        .unwrap();

    let client = pool.get().await.unwrap();
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false)",
            &[&org.to_string()],
        )
        .await
        .unwrap();

    // Right tenant, no capability: zero rows.
    let rows = client
        .query(
            "SELECT 1 FROM design_payload WHERE design_id = $1",
            &[&design.to_string()],
        )
        .await
        .unwrap();
    assert!(
        rows.is_empty(),
        "the payload was readable with no capability set"
    );

    // The positive control: with it, the row is there. Without this, the
    // assertion above would pass against a table that is simply empty.
    client
        .execute(
            "SELECT set_config('app.design_capability', 'yes', false)",
            &[],
        )
        .await
        .unwrap();
    let rows = client
        .query(
            "SELECT 1 FROM design_payload WHERE design_id = $1",
            &[&design.to_string()],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
}

#[tokio::test]
async fn the_runtime_role_cannot_rewrite_or_delete_a_chain_entry() {
    // Append-only as far as this role can express it: no UPDATE and no DELETE
    // policy, so both reach no rows. This is NOT append-only against the
    // table's owner or a superuser -- that is what the seal is for.
    let pool = support::migrated_pool().await;
    let ring = keyring(58);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"payload", 1)
        .await
        .unwrap();

    let client = pool.get().await.unwrap();
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false)",
            &[&org.to_string()],
        )
        .await
        .unwrap();

    let updated = client
        .execute(
            "UPDATE chain_entries SET seal = $2 WHERE design_id = $1",
            &[&design.to_string(), &vec![0u8; 32]],
        )
        .await;
    assert!(
        matches!(&updated, Ok(0) | Err(_)),
        "the runtime role rewrote a chain entry: {updated:?}"
    );
    let deleted = client
        .execute(
            "DELETE FROM chain_entries WHERE design_id = $1",
            &[&design.to_string()],
        )
        .await;
    assert!(
        matches!(&deleted, Ok(0) | Err(_)),
        "the runtime role deleted a chain entry: {deleted:?}"
    );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn stored_ciphertexts(pool: &Pool, org: OrganisationId, design: DesignId) -> Vec<Vec<u8>> {
    let client = pool.get().await.unwrap();
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false), \
                    set_config('app.design_capability', 'yes', false)",
            &[&org.to_string()],
        )
        .await
        .unwrap();
    client
        .query(
            "SELECT ciphertext FROM design_payload WHERE design_id = $1 ORDER BY design_version",
            &[&design.to_string()],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// A role check that would otherwise be dead weight in this file: every helper
/// above creates its account as the organisation's administrator, and
/// `TenantContext` carries that through. If this ever stops being true the
/// tests above would start exercising a different permission path than they
/// claim to.
#[tokio::test]
async fn the_helper_tenant_really_is_administered_by_its_account() {
    let pool = support::migrated_pool().await;
    let (account, org, _) = a_tenant(&pool).await;
    let members = repo::list_members(&pool, org, account).await.unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].role, Role::Admin);
}

#[tokio::test]
async fn a_design_cannot_be_hung_on_another_tenants_scope() {
    let pool = support::migrated_pool().await;
    let (account, org, _) = a_tenant(&pool).await;
    let (_, _, other_rack) = a_tenant(&pool).await;

    let err = designs::create_design(&pool, org, account, other_rack.id)
        .await
        .expect_err("a scope in another organisation must not accept a design");
    assert!(matches!(err, DesignError::NoSuchScope), "{err:?}");
}

// ---------------------------------------------------------------------------
// §12.6a -- the two reproductions that made verification silenceable
// ---------------------------------------------------------------------------

#[tokio::test]
async fn setting_an_unrelated_entrys_key_epoch_cannot_hide_a_forgery() {
    // Reproduced against bb04ccb: tamper with entry 1, then set entry 3's
    // `chain_key_epoch` to 2, and the report became "cannot verify under chain
    // key epoch(s) 2 ... a coverage gap, not a failure -- the 2 entries before
    // it verify", over entries nothing had examined. One UPDATE, and the
    // verifier stopped naming the tamper.
    let pool = support::migrated_pool().await;
    let ring = keyring(60);
    let (account, org, design) = a_design(&pool).await;
    for n in 1..=3 {
        designs::write_version(
            &pool,
            &ring,
            org,
            account,
            design,
            format!("v{n}").as_bytes(),
            1,
        )
        .await
        .unwrap();
    }

    let su = support::superuser_client_on_test_database().await;
    su.execute(
        "UPDATE chain_entries SET metadata = $2 WHERE design_id = $1 AND seq = 1",
        &[
            &design.to_string(),
            &br#"{"actor":"someone else"}"#.to_vec(),
        ],
    )
    .await
    .expect("forge entry 1");
    su.execute(
        "UPDATE chain_entries SET chain_key_epoch = 2 WHERE design_id = $1 AND seq = 3",
        &[&design.to_string()],
    )
    .await
    .expect("switch entry 3's epoch");

    let report = designs::verify_design(&pool, &ring, org, account, design, false)
        .await
        .unwrap();
    match report.outcome {
        Outcome::BrokenAt {
            seq,
            verified_before,
            ..
        } => {
            assert_eq!(seq, 1, "the forgery must be named: {report}");
            assert_eq!(verified_before, 0);
        }
        other => panic!("expected the forgery to be reported, got {other:?}"),
    }
    assert!(
        report.summary().starts_with("BROKEN AT ENTRY 1"),
        "{report}"
    );
}

#[tokio::test]
async fn an_epoch_this_server_never_wrote_reads_as_an_anomaly_not_a_missing_key() {
    // The server derives any epoch from the chain master, so there is no
    // "epoch I cannot check" here at all -- and it knows it has only ever
    // written epoch 1, so the operator is not sent to look for a retired key
    // that was never minted.
    let pool = support::migrated_pool().await;
    let ring = keyring(62);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"one", 1)
        .await
        .unwrap();

    let su = support::superuser_client_on_test_database().await;
    su.execute(
        "UPDATE chain_entries SET chain_key_epoch = 7 WHERE design_id = $1",
        &[&design.to_string()],
    )
    .await
    .unwrap();

    let report = designs::verify_design(&pool, &ring, org, account, design, false)
        .await
        .unwrap();
    assert!(
        matches!(
            report.outcome,
            Outcome::BrokenAt {
                reason: BreakReason::ChainKeyEpochNeverWritten,
                ..
            }
        ),
        "{report}"
    );
    assert!(!report.summary().contains("coverage gap"), "{report}");
}

#[tokio::test]
async fn an_entry_repointed_at_another_version_does_not_verify() {
    // §12.6a's first gap: the seal does not cover `design_version`, so this
    // edit leaves every seal recomputing. Against bb04ccb routine verification
    // returned `Verified { entries: 3 }` -- a version destroyed and the
    // history endorsing it.
    let pool = support::migrated_pool().await;
    let ring = keyring(64);
    let (account, org, design) = a_design(&pool).await;
    for n in 1..=3 {
        designs::write_version(
            &pool,
            &ring,
            org,
            account,
            design,
            format!("version {n}").as_bytes(),
            1,
        )
        .await
        .unwrap();
    }

    let su = support::superuser_client_on_test_database().await;
    su.execute(
        "DELETE FROM design_payload WHERE design_id = $1 AND design_version = 2",
        &[&design.to_string()],
    )
    .await
    .expect("destroy version 2");
    su.execute(
        "UPDATE chain_entries SET design_version = 3 WHERE design_id = $1 AND seq = 2",
        &[&design.to_string()],
    )
    .await
    .expect("re-point entry 2");

    let report = designs::verify_design(&pool, &ring, org, account, design, false)
        .await
        .unwrap();
    match report.outcome {
        Outcome::BrokenAt { seq, reason, .. } => {
            assert_eq!(seq, 2);
            assert_eq!(reason, BreakReason::StorageBindingMismatchUnexplained);
        }
        other => panic!("a destroyed version must not verify, got {other:?}"),
    }
}

#[tokio::test]
async fn a_payload_row_no_entry_names_is_reported_and_not_skipped() {
    // An INSERTED payload row: the entry-driven pass cannot reach it, so the
    // other direction has to be checked too. Against bb04ccb this reported
    // `Verified` -- and, carrying the highest `design_version`, it is what a
    // read of the latest version then refuses on.
    let pool = support::migrated_pool().await;
    let ring = keyring(66);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"the real one", 1)
        .await
        .unwrap();

    let su = support::superuser_client_on_test_database().await;
    su.execute(
        "INSERT INTO design_payload (design_id, organisation_id, design_version, ciphertext, \
             nonce, key_epoch, wrap_version, aead_alg_id, payload_schema_version, created_by) \
         VALUES ($1, $2, 2, $3, $4, 1, 1, 1, 1, $5)",
        &[
            &design.to_string(),
            &org.to_string(),
            &b"bytes nobody sealed".to_vec(),
            &vec![7u8; 12],
            &account.to_string(),
        ],
    )
    .await
    .expect("insert a payload row");

    let report = designs::verify_design(&pool, &ring, org, account, design, false)
        .await
        .unwrap();
    assert!(
        matches!(
            report.outcome,
            Outcome::BrokenAt {
                reason: BreakReason::PayloadNotNamedByAnyEntry,
                ..
            }
        ),
        "{report}"
    );

    // ...and the symptom that made it more than a reporting gap: the highest
    // version is the one a read with no version lands on.
    assert!(
        designs::read_version(&pool, &ring, org, account, design, None)
            .await
            .is_err(),
        "the inserted row was readable as the latest version"
    );
}

// ---------------------------------------------------------------------------
// The append-only fence, which one DELETE used to walk through
// ---------------------------------------------------------------------------

#[tokio::test]
async fn deleting_a_design_cannot_erase_its_sealed_history() {
    // Reproduced against bb04ccb: `designs_deletable` plus ON DELETE CASCADE
    // let the RUNTIME role erase a design's entire history, payloads and keys
    // with one statement -- through three tables that have no DELETE policy of
    // their own, because a referential action is not subject to row-level
    // security. 0008 takes both fences: no DELETE policy on `designs`, and
    // RESTRICT on all three children, which binds for the owner and a
    // superuser too.
    let pool = support::migrated_pool().await;
    let ring = keyring(68);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"payload", 1)
        .await
        .unwrap();

    let client = pool.get().await.unwrap();
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false)",
            &[&org.to_string()],
        )
        .await
        .unwrap();
    let deleted = client
        .execute("DELETE FROM designs WHERE id = $1", &[&design.to_string()])
        .await;
    assert!(
        matches!(&deleted, Ok(0) | Err(_)),
        "the runtime role deleted a design and with it its sealed history: {deleted:?}"
    );

    // And the fence that binds at every privilege level, including the one
    // row-level security never binds for.
    let su = support::superuser_client_on_test_database().await;
    assert!(
        su.execute("DELETE FROM designs WHERE id = $1", &[&design.to_string()])
            .await
            .is_err(),
        "a superuser erased a sealed history with one DELETE"
    );
    // ...and the same one level up, which is where the cascade started.
    assert!(
        su.execute(
            "DELETE FROM organisations WHERE id = $1",
            &[&org.to_string()]
        )
        .await
        .is_err(),
        "deleting the organisation cascaded through the history"
    );

    // The history is still there, and still verifies.
    let report = designs::verify_design(&pool, &ring, org, account, design, false)
        .await
        .unwrap();
    assert_eq!(report.outcome, Outcome::Verified { entries: 1 }, "{report}");
}

#[tokio::test]
async fn the_runtime_role_cannot_rewrite_or_delete_the_master_key_stamp() {
    // `master_keys` has no row-level security -- it is not tenant data -- so
    // for this table the GRANT is the only fence. 0006's default privileges
    // handed the runtime role UPDATE and DELETE on it; neither is earned by
    // any code path, and an UPDATE is ADR-0043 §4's wrong-key check rewritten
    // to agree with whatever key is now configured.
    let pool = support::migrated_pool().await;
    let ring = keyring(70);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"x", 1)
        .await
        .unwrap();

    let client = pool.get().await.unwrap();

    // **The grant itself, asked of the database.** Attempting the statements
    // is not enough and would have passed against the unfenced schema for the
    // wrong reason: `tenant_keys.master_key_id` references this table, so an
    // UPDATE or DELETE of the active row fails on referential integrity
    // whether or not the privilege was ever withheld.
    for (table, verb) in [
        ("master_keys", "UPDATE"),
        ("master_keys", "DELETE"),
        ("chain_master_keys", "UPDATE"),
        ("chain_master_keys", "DELETE"),
    ] {
        let held: bool = client
            .query_one(
                "SELECT has_table_privilege(current_user, $1, $2)",
                &[&table, &verb],
            )
            .await
            .unwrap()
            .get(0);
        assert!(!held, "the runtime role holds {verb} on {table}");
    }
    for (table, verb) in [
        ("master_keys", "SELECT"),
        ("master_keys", "INSERT"),
        ("chain_master_keys", "SELECT"),
        ("chain_master_keys", "INSERT"),
    ] {
        let held: bool = client
            .query_one(
                "SELECT has_table_privilege(current_user, $1, $2)",
                &[&table, &verb],
            )
            .await
            .unwrap()
            .get(0);
        assert!(
            held,
            "the runtime role cannot {verb} {table}, which it must"
        );
    }

    let updated = client
        .execute(
            "UPDATE master_keys SET retired_reason = 'nothing' WHERE status = 'active'",
            &[],
        )
        .await;
    assert!(
        updated.is_err(),
        "the runtime role rewrote the master key stamp: {updated:?}"
    );
    let deleted = client.execute("DELETE FROM master_keys", &[]).await;
    assert!(
        deleted.is_err(),
        "the runtime role deleted the master key stamp: {deleted:?}"
    );

    // The positive control: it can still read and stamp, which is all
    // `register_master_key` needs.
    keys::register_master_key(&client, &ring)
        .await
        .expect("reading and stamping is still allowed");
}

#[tokio::test]
async fn a_design_cannot_name_a_scope_belonging_to_another_tenant_at_all() {
    // `designs.scope_id` was the only cross-table reference in 0007 that was
    // not tenant-bound. `create_design` checked it in application code; this
    // is the schema fact, and it binds for a superuser too.
    let pool = support::migrated_pool().await;
    let (account, org, own_rack) = a_tenant(&pool).await;
    let (_, _, other_rack) = a_tenant(&pool).await;

    let design = designs::create_design(&pool, org, account, own_rack.id)
        .await
        .unwrap();

    // The application check is already tested above; this one goes round it
    // entirely, as the connection row-level security never binds for.
    let su = support::superuser_client_on_test_database().await;
    let moved = su
        .execute(
            "UPDATE designs SET scope_id = $2 WHERE id = $1",
            &[&design.to_string(), &other_rack.id.to_string()],
        )
        .await;
    assert!(
        moved.is_err(),
        "a design was filed on another organisation's scope: {moved:?}"
    );
}

// ---------------------------------------------------------------------------
// The chain master's stamp, and the counter that could never count
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_lost_chain_key_reports_the_wrong_key_and_not_a_forged_history() {
    // ADR-0043 §4's stamp, applied to the root 0007 missed. `main.rs` creates
    // a missing key file at startup, so a lost `chain.key` comes back as 32
    // fresh random bytes -- and without this every history in the database
    // reported BROKEN AT ENTRY 1, which is an operator error rendered as an
    // attack.
    let pool = support::migrated_pool().await;
    let client = pool.get().await.unwrap();

    // The only test that touches this table, so the id it stamps is the one
    // the whole test database carries.
    let sealed_under = keyring(77);
    keys::register_chain_master_key(&client, &sealed_under)
        .await
        .expect("first start stamps it");
    keys::register_chain_master_key(&client, &sealed_under)
        .await
        .expect("the same key again is a no-op");

    let regenerated = keyring(78);
    let err = keys::register_chain_master_key(&client, &regenerated)
        .await
        .expect_err("a different chain master must be refused");
    assert!(
        matches!(err, keys::MasterKeyError::ChainMismatch { .. }),
        "{err:?}"
    );
    let message = err.to_string();
    assert!(
        message.contains(&sealed_under.chain_key_id().to_string()),
        "{message}"
    );
    assert!(
        message.contains(&regenerated.chain_key_id().to_string()),
        "{message}"
    );
    assert!(
        message.contains("NOT a forged history"),
        "a wrong key must not read like an attack: {message}"
    );
}

#[tokio::test]
async fn the_tenant_keys_write_counter_actually_counts() {
    // §12.3's detector is per key, and the tenant key seals a wrap every time
    // a design key is minted or rotated. Nothing incremented this column, so
    // it read zero forever -- a counter that cannot count is worse than no
    // column, because it reads as evidence.
    let pool = support::migrated_pool().await;
    let ring = keyring(72);
    let (account, org, rack) = a_tenant(&pool).await;
    let one = designs::create_design(&pool, org, account, rack.id)
        .await
        .unwrap();
    let two = designs::create_design(&pool, org, account, rack.id)
        .await
        .unwrap();
    designs::write_version(&pool, &ring, org, account, one, b"one", 1)
        .await
        .unwrap();
    designs::write_version(&pool, &ring, org, account, two, b"two", 1)
        .await
        .unwrap();
    designs::rotate_design(&pool, &ring, org, account, one, "test")
        .await
        .unwrap();

    let client = pool.get().await.unwrap();
    client
        .execute(
            "SELECT set_config('app.tenant_id', $1, false)",
            &[&org.to_string()],
        )
        .await
        .unwrap();
    let count: i64 = client
        .query_one(
            "SELECT writes_under_key FROM tenant_keys WHERE organisation_id = $1",
            &[&org.to_string()],
        )
        .await
        .unwrap()
        .get(0);
    // Two design keys minted, one rotation minting a third.
    assert_eq!(count, 3, "the tenant key's write counter did not count");
}

#[tokio::test]
async fn a_rotation_waits_for_a_concurrent_write_rather_than_racing_it() {
    // `write_version` reads `max(design_version) + 1` and `max(seq) + 1`;
    // `rotate_design` retires the active key and walks every stored version.
    // Interleaved, a version can be written under a key the rotation has
    // already walked past, and is then stranded under an epoch nothing
    // re-encrypts -- which the next rotation refuses as `Corrupt`. Both paths
    // now take the design's own row first.
    //
    // Driven by holding that row from a third transaction rather than by
    // racing two calls and hoping, which is what makes this deterministic.
    let pool = support::migrated_pool().await;
    let ring = keyring(74);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"one", 1)
        .await
        .unwrap();

    let mut holder = pool.get().await.unwrap();
    let tx = holder.transaction().await.unwrap();
    tx.execute(
        "SELECT set_config('app.tenant_id', $1, false)",
        &[&org.to_string()],
    )
    .await
    .unwrap();
    // **`FOR NO KEY UPDATE`, and the weaker mode is the point.** Inserting a
    // key row or a payload row takes `FOR KEY SHARE` on this design through
    // the foreign key, all by itself -- so a holder taking `FOR UPDATE` would
    // block a write path that takes no lock of its own, and the test would
    // pass against code that has none. `FOR NO KEY UPDATE` is compatible with
    // that incidental `FOR KEY SHARE` and conflicts only with a deliberate
    // `FOR UPDATE`, which is the thing being tested.
    tx.query_one(
        "SELECT 1 FROM designs WHERE id = $1 FOR NO KEY UPDATE",
        &[&design.to_string()],
    )
    .await
    .expect("hold the design row");

    let waited = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        designs::rotate_design(&pool, &ring, org, account, design, "test"),
    )
    .await;
    assert!(
        waited.is_err(),
        "the rotation did not wait for a transaction holding the design: {waited:?}"
    );

    let waited = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        designs::write_version(&pool, &ring, org, account, design, b"two", 1),
    )
    .await;
    assert!(
        waited.is_err(),
        "the write did not wait for a transaction holding the design: {waited:?}"
    );

    // Released: both go through, and the history is intact afterwards.
    tx.rollback().await.unwrap();
    drop(holder);
    designs::write_version(&pool, &ring, org, account, design, b"two", 1)
        .await
        .expect("the write proceeds once the lock is released");
    designs::rotate_design(&pool, &ring, org, account, design, "test")
        .await
        .expect("the rotation proceeds once the lock is released");

    let report = designs::verify_design(&pool, &ring, org, account, design, true)
        .await
        .unwrap();
    assert_eq!(report.outcome, Outcome::Verified { entries: 4 }, "{report}");
}
