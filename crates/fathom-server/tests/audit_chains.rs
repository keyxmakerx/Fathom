//! Chains at three levels, the re-wrap that needed them, and the shipper —
//! against a real PostgreSQL and a real TCP socket.
//!
//! **Every test here is written against a claim, not against the code.** The
//! three that matter most:
//!
//! - Tamper with a *site* entry and prove *broken at N* with everything before
//!   it still verified — the site chain gets the same verifier the design chain
//!   got, not a second one that happens to agree.
//! - A re-wrap writes its sealed entry, **and the old master key still opens
//!   the data afterwards**. That second half is the fact §12.6 exists to make
//!   visible, so it is demonstrated rather than asserted around: the test takes
//!   a copy of the key rows before the switch, re-wraps, and then decrypts the
//!   payload with the old master and that copy.
//! - Kill the syslog destination mid-run: the act still applies, the entry
//!   spools, and the spool drains **in order** when the destination returns.
//!
//! # Why the re-wrap tests run inside a transaction they roll back
//!
//! ADR-0043 §4 allows one active master key per *database*, and these tests
//! share one. A committed re-wrap would therefore change which key every other
//! test in the suite has to configure, and the first one to run would decide
//! for the rest. Rolling back keeps each test's fixture its own — and costs
//! nothing, because everything being asserted is readable inside the
//! transaction that performed it.

mod support;

use std::collections::BTreeMap;

use deadpool_postgres::Pool;

use fathom_server::audit::{self, SyslogTarget};
use fathom_server::chain::{
    BreakReason, ChainRef, ContentState, EntryMetadata, EntryType, Outcome,
};
use fathom_server::chains;
use fathom_server::crypto::Key32;
use fathom_server::keys::{
    self, ExposureAcknowledged, KeyOperation, KeyRing, KeyStoreError, REWRAP_EXPOSURE_STATEMENT,
};
use fathom_server::repo::{self, AccountId, DesignId, OrganisationId, ScopeKind};
use fathom_server::{chain, designs};

/// The one master key this test database is encrypted under, matching
/// `design_storage.rs`. See that file's own note: ADR-0043 §4 stamps the
/// configured key's id and refuses a second, so tests sharing a database share
/// a master key.
const MASTER: [u8; 32] = [21; 32];

/// A key ring for the **site chain**, which is one per database and therefore
/// shared by every suite. See `support::SITE_CHAIN_MASTER`.
fn site_keyring() -> KeyRing {
    KeyRing::from_keys(
        Key32::from_bytes(MASTER),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    )
}

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

async fn a_tenant(pool: &Pool) -> (AccountId, OrganisationId) {
    let account = repo::create_account(pool, &unique("someone@example.test"), "Someone")
        .await
        .expect("create account");
    let org = repo::create_organisation(pool, account.id, &unique("Org"))
        .await
        .expect("create organisation");
    (account.id, org.id)
}

async fn a_design(pool: &Pool) -> (AccountId, OrganisationId, DesignId) {
    let (account, org) = a_tenant(pool).await;
    let network = repo::create_scope(pool, org, account, None, ScopeKind::Network, "net")
        .await
        .expect("network");
    let design = designs::create_design(pool, org, account, network.id)
        .await
        .expect("design");
    (account, org, design)
}

fn metadata(entry_type: EntryType, note: &str) -> Vec<u8> {
    let mut map = BTreeMap::new();
    map.insert(
        "entry_type".to_string(),
        fathom_canon::Json::Str(entry_type.as_str().to_string()),
    );
    map.insert(
        "note".to_string(),
        fathom_canon::Json::Str(note.to_string()),
    );
    fathom_canon::Json::Obj(map).to_canonical_bytes()
}

// ---------------------------------------------------------------------------
// The site chain
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_site_chain_verifies_and_says_what_it_did_not_check() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = site_keyring();
    let mut client = pool.get().await.expect("connection");
    let deployment = chains::register_deployment(&**client)
        .await
        .expect("deployment id");

    for _ in 0..3 {
        let tx = client.transaction().await.expect("begin");
        chains::record_deployment_started(&tx, &ring, &deployment, 9)
            .await
            .expect("append");
        tx.commit().await.expect("commit");
    }

    let tx = client.transaction().await.expect("begin");
    let report = chains::verify_site(&tx, &ring, false)
        .await
        .expect("verify");
    assert!(
        matches!(report.outcome, Outcome::Verified { entries } if entries >= 3),
        "{report}"
    );
    // §11.2's fourth sub-state, one tier down: a links-only run on a chain
    // whose metadata is encrypted has not re-bound anything.
    assert_eq!(report.content, ContentState::NotRebound);
    assert!(
        report.summary().contains("CONTENT NOT RE-BOUND"),
        "{report}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_deep_site_run_decrypts_the_metadata_and_says_so() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = site_keyring();
    let mut client = pool.get().await.expect("connection");
    let deployment = chains::register_deployment(&**client)
        .await
        .expect("deployment id");
    let tx = client.transaction().await.expect("begin");
    chains::record_deployment_started(&tx, &ring, &deployment, 9)
        .await
        .expect("append");
    tx.commit().await.expect("commit");

    let tx = client.transaction().await.expect("begin");
    let report = chains::verify_site(&tx, &ring, true).await.expect("verify");
    assert!(
        matches!(report.outcome, Outcome::Verified { .. }),
        "{report}"
    );
    assert_eq!(
        report.content,
        ContentState::Rebound,
        "a deep run must decrypt every entry's metadata and recompute its binding: {report}"
    );
    assert!(report.summary().contains("links and content"), "{report}");
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn tampering_with_a_site_entry_breaks_at_it_and_not_before_it() {
    let _site = support::lock_the_site_chain().await;
    // **The claim this file exists for, at the new level.** The attacker is
    // someone with write access to the database and no chain key -- and they
    // need more than that here, because `0009`'s trigger refuses an UPDATE for
    // every role, so `support::tamper` disables it first. That is the tier-3
    // move the migration header names, made visible.
    let pool = support::migrated_pool().await;
    let ring = site_keyring();
    let mut client = pool.get().await.expect("connection");
    let deployment = chains::register_deployment(&**client)
        .await
        .expect("deployment id");

    // A chain of its own, so other tests appending to the shared site chain
    // cannot move the sequence number under this one.
    let tx = client.transaction().await.expect("begin");
    for n in 1..=3 {
        chains::record_deployment_started(&tx, &ring, &deployment, n)
            .await
            .expect("append");
    }
    // The TIP, not a row count: other suites append to this same site chain,
    // so the two are only equal by luck.
    let before: i64 = tx
        .query_one(
            "SELECT max(seq) FROM chain_entries WHERE chain_kind = 'site' AND chain_id = $1",
            &[&deployment],
        )
        .await
        .expect("tip")
        .get(0);
    tx.commit().await.expect("commit");

    // Rewrite the metadata ciphertext of the LAST entry. The seal covers the
    // stored bytes, so this is caught with the chain key alone -- no
    // decryption, which is exactly what §11.2 calls the routine check and what
    // binding only the plaintext would have left uncovered.
    let su = support::superuser_client_on_test_database().await;
    let original: Vec<u8> = su
        .query_one(
            "SELECT metadata FROM chain_entries \
             WHERE chain_kind = 'site' AND chain_id = $1 AND seq = $2",
            &[&deployment, &before],
        )
        .await
        .expect("the entry to tamper with")
        .get(0);
    let changed = support::tamper(
        &su,
        "chain_entries",
        "UPDATE chain_entries SET metadata = $3 \
         WHERE chain_kind = 'site' AND chain_id = $1 AND seq = $2",
        &[&deployment, &before, &b"not what was sealed".to_vec()],
    )
    .await;
    assert_eq!(changed, 1);

    let tx = client.transaction().await.expect("begin");
    let report = chains::verify_site(&tx, &ring, false)
        .await
        .expect("verify");
    match &report.outcome {
        Outcome::BrokenAt {
            seq,
            reason,
            verified_before,
            entry_type,
            ..
        } => {
            assert_eq!(*seq, before);
            assert_eq!(*reason, BreakReason::SealDoesNotRecompute);
            assert_eq!(
                *verified_before,
                (before - 1) as usize,
                "everything before the tampered entry must still be reported verified: {report}"
            );
            assert_eq!(
                *entry_type,
                Some(EntryType::DeploymentStarted),
                "the entry type is in the clear and must be named even on an encrypted chain"
            );
        }
        other => panic!("expected broken at {before}, got {other:?}"),
    }
    assert!(
        report
            .summary()
            .contains(&format!("BROKEN AT ENTRY {before}")),
        "{report}"
    );
    tx.rollback().await.expect("rollback");

    // Put it back. There is one site chain per database and every other test
    // reads it; leaving a break behind would make them all fail for a reason
    // that has nothing to do with what they check.
    support::tamper(
        &su,
        "chain_entries",
        "UPDATE chain_entries SET metadata = $3 \
         WHERE chain_kind = 'site' AND chain_id = $1 AND seq = $2",
        &[&deployment, &before, &original],
    )
    .await;
    let tx = client.transaction().await.expect("begin");
    let healed = chains::verify_site(&tx, &ring, false)
        .await
        .expect("verify");
    assert!(
        matches!(healed.outcome, Outcome::Verified { .. }),
        "restoring the original bytes must make the chain verify again, which is also the proof \
         that the break above was caused by the tamper and by nothing else: {healed}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_break_on_an_encrypted_chain_reports_ciphertext_as_ciphertext() {
    let _site = support::lock_the_site_chain().await;
    // §7.3's metadata is a blob on a links-only run, and a report that handed
    // an operator a blob where they expected canonical JSON is a report they
    // stop reading. The type makes the caller match rather than print.
    let pool = support::migrated_pool().await;
    let ring = site_keyring();
    let mut client = pool.get().await.expect("connection");
    let deployment = chains::register_deployment(&**client)
        .await
        .expect("deployment id");
    let tx = client.transaction().await.expect("begin");
    chains::record_deployment_started(&tx, &ring, &deployment, 9)
        .await
        .expect("append");
    let seq: i64 = tx
        .query_one(
            "SELECT max(seq) FROM chain_entries WHERE chain_kind = 'site' AND chain_id = $1",
            &[&deployment],
        )
        .await
        .expect("tip")
        .get(0);
    tx.commit().await.expect("commit");

    let su = support::superuser_client_on_test_database().await;
    let original: Vec<u8> = su
        .query_one(
            "SELECT seal FROM chain_entries \
             WHERE chain_kind = 'site' AND chain_id = $1 AND seq = $2",
            &[&deployment, &seq],
        )
        .await
        .expect("the entry to tamper with")
        .get(0);
    support::tamper(
        &su,
        "chain_entries",
        "UPDATE chain_entries SET seal = $3 \
         WHERE chain_kind = 'site' AND chain_id = $1 AND seq = $2",
        &[&deployment, &seq, &vec![0u8; 32]],
    )
    .await;

    let tx = client.transaction().await.expect("begin");
    let report = chains::verify_site(&tx, &ring, false)
        .await
        .expect("verify");
    match &report.outcome {
        Outcome::BrokenAt { metadata, .. } => {
            assert!(
                matches!(metadata, EntryMetadata::Ciphertext(_)),
                "a links-only run holds ciphertext and must say so, not hand it over as text: \
                 {metadata:?}"
            );
            assert!(
                metadata.plaintext().is_none(),
                "plaintext() must refuse to produce readable bytes it does not have"
            );
        }
        other => panic!("expected a break, got {other:?}"),
    }
    tx.rollback().await.expect("rollback");

    // Put it back -- one site chain per database, as above.
    support::tamper(
        &su,
        "chain_entries",
        "UPDATE chain_entries SET seal = $3 \
         WHERE chain_kind = 'site' AND chain_id = $1 AND seq = $2",
        &[&deployment, &seq, &original],
    )
    .await;
}

#[tokio::test]
async fn a_design_chain_and_a_site_chain_do_not_verify_as_one_another() {
    let _site = support::lock_the_site_chain().await;
    // §7.1's domain separation, driven rather than recited. The labels are
    // three literals; a copy-paste between them would be invisible in review
    // and would let entries be spliced between levels.
    let pool = support::migrated_pool().await;
    let ring = site_keyring();
    let mut client = pool.get().await.expect("connection");
    let deployment = chains::register_deployment(&**client)
        .await
        .expect("deployment id");
    let tx = client.transaction().await.expect("begin");
    chains::record_deployment_started(&tx, &ring, &deployment, 9)
        .await
        .expect("append");
    let entries = chains::read_entries(
        &tx,
        ChainRef::Site {
            deployment: &deployment,
        },
    )
    .await
    .expect("read");
    tx.rollback().await.expect("rollback");

    // The same entries, verified as if they were an organisation chain of the
    // same name.
    let as_org = ChainRef::Org {
        organisation: &deployment,
    };
    let ck = chain::chain_key(
        &Key32::from_bytes([94; 32]),
        as_org,
        chains::CHAIN_KEY_EPOCH,
    );
    let keys =
        chain::AvailableKeys::new(vec![(chains::CHAIN_KEY_EPOCH, chain::Subkeys::derive(&ck))]);
    let report = chain::verify(as_org, &entries, &[], &keys, None);
    assert!(
        matches!(report.outcome, Outcome::BrokenAt { seq: 1, .. }),
        "site entries must not verify as an organisation chain: {report}"
    );
}

// ---------------------------------------------------------------------------
// Re-wrap — §12.6
// ---------------------------------------------------------------------------

/// The new master key a re-wrap moves custody to. Never committed: see the
/// file header on why these tests roll back.
const NEW_MASTER: [u8; 32] = [188; 32];

#[tokio::test]
async fn a_rewrap_writes_a_sealed_entry_naming_both_master_keys() {
    let pool = support::migrated_pool().await;
    let ring = keyring(95);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"the estate", 1)
        .await
        .expect("write a version");

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");

    let report = keys::rewrap_tenant_keys(
        &tx,
        &ring,
        &ctx,
        &Key32::from_bytes(NEW_MASTER),
        KeyOperation::Rewrap,
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).expect("acknowledge"),
    )
    .await
    .expect("re-wrap");

    // §12.6's required report, field by field.
    assert_eq!(report.operation, KeyOperation::Rewrap);
    assert_eq!(report.from_master_key_id, ring.master_key_id());
    assert_eq!(
        report.to_master_key_id,
        Key32::from_bytes(NEW_MASTER).id(),
        "the report must name both master identities"
    );
    assert_eq!(
        report.tenant_key_rows_rewrapped, 1,
        "counts rather than a boolean"
    );
    assert_eq!(report.key_epochs_rewrapped, vec![1]);
    assert_eq!(
        report.payload_versions_reencrypted, 0,
        "a re-wrap re-encrypts nothing, and the report says so as a COUNT"
    );
    assert_eq!(report.subordinate_key_rows_rewrapped, 0);
    assert_eq!(
        report.exposure_statement(),
        REWRAP_EXPOSURE_STATEMENT,
        "the exposure sentence is required verbatim"
    );

    // The rendered report carries the sentence, not a paraphrase of it.
    let rendered = report.to_string();
    assert!(rendered.starts_with("rewrap:"), "{rendered}");
    assert!(rendered.contains(REWRAP_EXPOSURE_STATEMENT), "{rendered}");
    assert!(
        rendered.contains("To revoke that access, run a rotation."),
        "{rendered}"
    );

    // The sealed entry. `org_genesis` first, then the re-wrap.
    let chain = ChainRef::Org {
        organisation: &org.to_string(),
    };
    let entries = chains::read_entries(&tx, chain).await.expect("read");
    assert_eq!(entries.len(), 2, "org_genesis then rewrap");
    assert_eq!(entries[0].entry_type, EntryType::OrgGenesis);
    assert_eq!(entries[1].entry_type, EntryType::Rewrap);
    assert_eq!(entries[1].seq, report.chain_entry_seq);

    // And it verifies, deeply -- which means the metadata decrypted under the
    // organisation content key and matched its binding.
    // **Under the NEW master.** The re-wrap moved custody, so reading the
    // organisation content key -- which is wrapped under the tenant key, which
    // is wrapped under the master -- now goes through the key that is in force.
    // A verifier handed the old ring here gets ADR-0043 §4's two-key-ids
    // message, which is the correct answer and not this test's subject.
    let after_ring = keyring_with_master(NEW_MASTER, 95);
    let verified = chains::verify_org(&tx, &after_ring, &ctx, true)
        .await
        .expect("verify");
    assert_eq!(
        verified.outcome,
        Outcome::Verified { entries: 2 },
        "{verified}"
    );
    assert_eq!(verified.content, ContentState::Rebound);

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn the_rewrap_entry_states_that_no_payload_was_reencrypted() {
    // §12.6 asks for that fact **inside the entry**, not only in the interface
    // that reported it. A reader of this chain in two years is asking whether
    // the estate was ever exposed to a key somebody else holds, and the answer
    // has to be in the sealed record rather than inferred from documentation.
    let pool = support::migrated_pool().await;
    let ring = keyring(96);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"x", 1)
        .await
        .expect("write");

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");
    keys::rewrap_tenant_keys(
        &tx,
        &ring,
        &ctx,
        &Key32::from_bytes(NEW_MASTER),
        KeyOperation::Rewrap,
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).unwrap(),
    )
    .await
    .expect("re-wrap");

    // Read it back the way an auditor would: decrypt the entry's metadata.
    let tenant_key = keys::tenant_key(&tx, &keyring_with_master(NEW_MASTER, 96), &ctx)
        .await
        .expect("tenant key under the new master");
    let chain = ChainRef::Org {
        organisation: &org.to_string(),
    };
    let row = tx
        .query_one(
            "SELECT seq, metadata_key_epoch, metadata_nonce, metadata FROM chain_entries \
             WHERE chain_kind = 'org' AND chain_id = $1 AND entry_type = 'rewrap'",
            &[&org.to_string()],
        )
        .await
        .expect("the rewrap entry");
    let seq: i64 = row.get(0);
    let key_epoch: i32 = row.get(1);
    let nonce: Vec<u8> = row.get(2);
    let ciphertext: Vec<u8> = row.get(3);

    let content = keys::org_content_key_at_epoch(&tx, &ctx, &tenant_key, key_epoch)
        .await
        .expect("organisation content key");
    let aad = chain::metadata_aad(chain, seq, key_epoch);
    let nonce: [u8; 12] = nonce.as_slice().try_into().unwrap();
    let plaintext = fathom_server::crypto::open(&content, &nonce, &ciphertext, &aad)
        .expect("the entry's metadata must decrypt");
    let text = String::from_utf8(plaintext).expect("canonical JSON is UTF-8");

    for expected in [
        "\"operation\":\"rewrap\"",
        "\"payload_reencrypted\":false",
        "\"payload_versions_reencrypted\":0",
        "\"tenant_key_rows_rewrapped\":1",
    ] {
        assert!(text.contains(expected), "{expected} missing from {text}");
    }
    assert!(
        text.contains(&ring.master_key_id().to_string()),
        "the old master identity must be in the entry: {text}"
    );
    assert!(
        text.contains(&Key32::from_bytes(NEW_MASTER).id().to_string()),
        "the new master identity must be in the entry: {text}"
    );
    assert!(
        text.contains("This changed custody, not exposure."),
        "the exposure statement belongs in the sealed record: {text}"
    );

    tx.rollback().await.expect("rollback");
}

fn keyring_with_master(master: [u8; 32], chain_master: u8) -> KeyRing {
    KeyRing::from_keys(
        Key32::from_bytes(master),
        Key32::from_bytes([chain_master; 32]),
    )
}

#[tokio::test]
async fn after_a_rewrap_the_old_master_key_still_opens_the_data() {
    // **This is the fact §12.6 exists to make visible, so it is DEMONSTRATED
    // rather than asserted around.** §12.6: *"anyone holding the old master key
    // and a copy of the key rows from before the switch still decrypts
    // everything, including data written afterwards."* If that sentence were
    // ever false, the exposure statement the interface makes an operator
    // acknowledge would be scaring them about nothing -- and if it is true,
    // which it is, an operator who believes a re-wrap revoked something is in
    // real danger. Either way it has to be driven.
    let pool = support::migrated_pool().await;
    let ring = keyring(97);
    let (account, org, design) = a_design(&pool).await;
    let payload = b"core-fw-01 10.1.1.0/24 the estate map".to_vec();
    designs::write_version(&pool, &ring, org, account, design, &payload, 1)
        .await
        .expect("write a version");

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");

    // The copy §12.6 names: the key rows as they were BEFORE the switch.
    let snapshot = tx
        .query_one(
            "SELECT key_epoch, wrapped_key, wrap_nonce FROM tenant_keys \
             WHERE organisation_id = $1 AND status = 'active'",
            &[&org.to_string()],
        )
        .await
        .expect("the tenant key row before the re-wrap");
    let snap_epoch: i32 = snapshot.get(0);
    let snap_wrapped: Vec<u8> = snapshot.get(1);
    let snap_nonce: Vec<u8> = snapshot.get(2);

    // The ciphertext, so byte-identity can be checked afterwards.
    let stored = tx
        .query_one(
            "SELECT ciphertext, nonce, key_epoch, payload_schema_version FROM design_payload \
             WHERE design_id = $1 AND design_version = 1",
            &[&design.to_string()],
        )
        .await
        .expect("the stored version");
    let ciphertext_before: Vec<u8> = stored.get(0);
    let nonce_before: Vec<u8> = stored.get(1);
    let key_epoch_before: i32 = stored.get(2);
    let schema_version: i32 = stored.get(3);

    keys::rewrap_tenant_keys(
        &tx,
        &ring,
        &ctx,
        &Key32::from_bytes(NEW_MASTER),
        KeyOperation::Rewrap,
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).unwrap(),
    )
    .await
    .expect("re-wrap");

    // ---- Custody changed --------------------------------------------------
    let after = tx
        .query_one(
            "SELECT key_epoch, master_key_id, wrapped_key, rewrapped_at, rewrapped_by \
             FROM tenant_keys WHERE organisation_id = $1 AND status = 'active'",
            &[&org.to_string()],
        )
        .await
        .expect("the tenant key row after");
    let after_epoch: i32 = after.get(0);
    let after_master: String = after.get(1);
    let after_wrapped: Vec<u8> = after.get(2);
    assert_eq!(
        after_epoch, snap_epoch,
        "§12.6: a re-wrap MUST NOT move key_epoch -- if it does, the two operations are \
         conflated in the schema and no interface can separate them afterwards"
    );
    assert_eq!(after_master, Key32::from_bytes(NEW_MASTER).id().to_string());
    assert_ne!(
        after_wrapped, snap_wrapped,
        "the wrapping must actually have changed"
    );
    assert!(
        after.get::<_, Option<std::time::SystemTime>>(3).is_some(),
        "rewrapped_at must be stamped"
    );
    assert_eq!(
        after.get::<_, Option<String>>(4),
        Some(account.to_string()),
        "the entry and the row must both name who ran it"
    );

    // ---- And exposure did not: the payload was never touched --------------
    let unchanged = tx
        .query_one(
            "SELECT ciphertext, nonce, key_epoch FROM design_payload \
             WHERE design_id = $1 AND design_version = 1",
            &[&design.to_string()],
        )
        .await
        .expect("the stored version after");
    assert_eq!(
        unchanged.get::<_, Vec<u8>>(0),
        ciphertext_before,
        "§12.6: ciphertext, nonce, content_hash and storage_binding are byte-identical"
    );
    assert_eq!(unchanged.get::<_, Vec<u8>>(1), nonce_before);
    assert_eq!(unchanged.get::<_, i32>(2), key_epoch_before);

    // No new entry on the DESIGN chain either: nothing happened to the design.
    let design_entries: i64 = tx
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'design' AND chain_id = $1",
            &[&design.to_string()],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(
        design_entries, 1,
        "a re-wrap writes nothing on a design chain -- it changed no byte of any design"
    );

    // ---- THE SENTENCE, DRIVEN ---------------------------------------------
    //
    // The OLD master key, plus the copy of the key row taken before the
    // switch. No access to anything that changed.
    let old_master = Key32::from_bytes(MASTER);
    let recovered_tenant_key = keys::unwrap_tenant_key_snapshot(
        &old_master,
        &org.to_string(),
        snap_epoch,
        &snap_wrapped,
        &snap_nonce,
    )
    .expect("the old master key still opens the key row copy");

    // Down through the hierarchy, using only rows that are still in the
    // database -- the design key was never re-wrapped, because it hangs off
    // the tenant key rather than off the master.
    let design_key_row = tx
        .query_one(
            "SELECT key_epoch, wrapped_key, wrap_nonce FROM design_keys \
             WHERE design_id = $1 AND status = 'active'",
            &[&design.to_string()],
        )
        .await
        .expect("the design key row");
    let dk_epoch: i32 = design_key_row.get(0);
    let dk_wrapped: Vec<u8> = design_key_row.get(1);
    let dk_nonce: Vec<u8> = design_key_row.get(2);

    let recovered_design_key = keys::unwrap_design_key(
        &keys::DataKey {
            key: Key32::from_bytes(*recovered_tenant_key.expose()),
            epoch: snap_epoch,
            id: recovered_tenant_key.id(),
        },
        &org.to_string(),
        &design.to_string(),
        dk_epoch,
        &dk_wrapped,
        &dk_nonce,
    )
    .expect("and so opens the design key");

    let recovered = designs::open_stored_version(
        &recovered_design_key,
        &org.to_string(),
        &design.to_string(),
        1,
        key_epoch_before,
        schema_version,
        &nonce_before,
        &ciphertext_before,
    )
    .expect("and so decrypts the payload");

    assert_eq!(
        recovered, payload,
        "§12.6's exposure statement is TRUE: the previous master key and a copy of the key rows \
         taken before the switch still decrypt everything. A re-wrap changed custody and not \
         exposure. If this assertion ever fails, the statement the interface makes an operator \
         acknowledge has become a lie and must be rewritten before anything else."
    );

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn rotate_is_refused_as_a_synonym_for_rewrap() {
    // §12.6's one refusal. A setting that silently re-wrapped when an operator
    // asked to rotate would leave them believing they had revoked something.
    let pool = support::migrated_pool().await;
    let ring = keyring(98);
    let (account, org) = a_tenant(&pool).await;

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");

    let err = keys::rewrap_tenant_keys(
        &tx,
        &ring,
        &ctx,
        &Key32::from_bytes(NEW_MASTER),
        KeyOperation::Rotate,
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).unwrap(),
    )
    .await
    .expect_err("`rotate` is not a synonym for `rewrap` and must not be accepted as one");
    assert!(
        matches!(
            err,
            KeyStoreError::NotASynonym {
                asked_for: "rotate"
            }
        ),
        "{err:?}"
    );
    let rendered = err.to_string();
    assert!(rendered.contains("not a synonym"), "{rendered}");
    assert!(
        rendered.contains("revokes nothing"),
        "the refusal must say what the difference IS, not just that there is one: {rendered}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn the_two_operations_have_no_shared_verb_and_no_aliases() {
    // The parser knows exactly two words. Nothing maps `rekey`,
    // `rotate-master`, `change-key` or `migrate` onto either, because a
    // deployment that accepted one of those would have a setting whose meaning
    // is decided by a lookup table nobody reads.
    assert_eq!(KeyOperation::parse("rewrap"), Some(KeyOperation::Rewrap));
    assert_eq!(KeyOperation::parse("rotate"), Some(KeyOperation::Rotate));
    for alias in [
        "rekey",
        "rotate-key",
        "rotate_master",
        "change-key",
        "migrate",
        "Rewrap",
        "REWRAP",
        "re-wrap",
        "",
    ] {
        assert_eq!(KeyOperation::parse(alias), None, "{alias} was accepted");
    }
    assert_ne!(KeyOperation::Rewrap.as_str(), KeyOperation::Rotate.as_str());
}

#[tokio::test]
async fn the_exposure_statement_must_be_acknowledged_verbatim() {
    assert!(ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).is_some());
    // A paraphrase is an acknowledgement of a different statement.
    assert!(ExposureAcknowledged::of("yes").is_none());
    assert!(ExposureAcknowledged::of("").is_none());
    assert!(
        ExposureAcknowledged::of(&REWRAP_EXPOSURE_STATEMENT.to_lowercase()).is_none(),
        "close is not the same sentence"
    );
    // And the sentence itself is §12.6's, word for word.
    assert!(REWRAP_EXPOSURE_STATEMENT.contains("This changed custody, not exposure."));
    assert!(REWRAP_EXPOSURE_STATEMENT.contains("To revoke that access, run a rotation."));
}

#[tokio::test]
async fn a_rewrap_to_the_same_master_key_is_refused() {
    // It would write a `rewrap` entry claiming custody changed when nothing
    // did, which is a false sentence in the one record that must not hold any.
    let pool = support::migrated_pool().await;
    let ring = keyring(99);
    let (account, org) = a_tenant(&pool).await;

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");
    let err = keys::rewrap_tenant_keys(
        &tx,
        &ring,
        &ctx,
        &Key32::from_bytes(MASTER),
        KeyOperation::Rewrap,
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).unwrap(),
    )
    .await
    .expect_err("re-wrapping to the key already in use must be refused");
    assert!(
        matches!(err, KeyStoreError::RewrapToTheSameMasterKey),
        "{err:?}"
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// The spool and the shipper — §9
// ---------------------------------------------------------------------------

/// A syslog receiver that collects whole lines until it is dropped.
struct Receiver {
    addr: String,
    lines: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    handle: tokio::task::JoinHandle<()>,
}

impl Receiver {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a receiver");
        let addr = listener.local_addr().expect("local addr").to_string();
        let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = lines.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let sink = sink.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut buf = Vec::new();
                    let _ = socket.read_to_end(&mut buf).await;
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    let mut sink = sink.lock().unwrap();
                    for line in text.lines() {
                        if !line.is_empty() {
                            sink.push(line.to_string());
                        }
                    }
                });
            }
        });
        Self {
            addr,
            lines,
            handle,
        }
    }

    fn target(&self) -> SyslogTarget {
        SyslogTarget::parse(&self.addr).expect("a bound address is host:port")
    }

    /// Wait until at least `n` lines have arrived, or give up.
    async fn lines_at_least(&self, n: usize) -> Vec<String> {
        for _ in 0..200 {
            {
                let held = self.lines.lock().unwrap();
                if held.len() >= n {
                    return held.clone();
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        self.lines.lock().unwrap().clone()
    }

    fn stop(self) {
        self.handle.abort();
    }
}

/// An address nothing is listening on. Bound and then dropped, so the port is
/// known to be free rather than guessed.
async fn a_dead_address() -> SyslogTarget {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr").to_string();
    drop(listener);
    SyslogTarget::parse(&addr).expect("host:port")
}

/// **Every spool assertion below is scoped to ONE chain id, and that is not
/// tidiness.**
///
/// `audit_spool` is one queue per deployment -- which is the design, because
/// the shipper is deployment-wide -- so every test in every test BINARY that
/// writes a design queues into the same table, and `cargo test` runs those
/// binaries in parallel. A global `count(*)` would be measuring the rest of
/// the suite. Scoping by `chain_id` is race-free without any lock, and it is
/// also closer to the claim: what matters is that *this* act's entry queued,
/// shipped and left, not what the total happened to be.
async fn spooled_for(client: &tokio_postgres::Client, chain_id: &str) -> Vec<audit::SpooledEntry> {
    audit::peek(client, 10_000)
        .await
        .expect("peek")
        .into_iter()
        .filter(|e| e.chain_id == chain_id)
        .collect()
}

/// Drain until this chain's entries have left, or give up. More than one call
/// may be needed: the shipper takes a bounded batch, and other tests' entries
/// share the queue.
async fn drain_until_empty(client: &tokio_postgres::Client, target: &SyslogTarget, chain_id: &str) {
    for _ in 0..50 {
        if spooled_for(client, chain_id).await.is_empty() {
            return;
        }
        audit::drain_once(client, target).await.expect("drain");
    }
    panic!("the spool did not drain for {chain_id}");
}

/// The `seq` values a receiver saw, for one chain, in the order they arrived.
fn seqs_for(lines: &[String], chain_id: &str) -> Vec<i64> {
    lines
        .iter()
        .filter(|l| l.contains(&format!("chain_id={chain_id} ")))
        .map(|line| {
            line.split(' ')
                .find_map(|f| f.strip_prefix("seq="))
                .expect("every line carries its seq")
                .parse()
                .expect("seq is a number")
        })
        .collect()
}

#[tokio::test]
async fn an_entry_spools_in_the_same_transaction_as_the_act() {
    let _spool = support::lock_the_spool().await;
    // "Stopping the log stops the act", mechanically: the spool row and the
    // chain entry are one transaction, so there is no window in which the act
    // applied and the record did not.
    let pool = support::migrated_pool().await;
    let ring = keyring(100);
    let (account, org, design) = a_design(&pool).await;

    let su = support::superuser_client_on_test_database().await;
    let chain_id = design.to_string();
    assert!(
        spooled_for(&su, &chain_id).await.is_empty(),
        "a design that has never been written must have queued nothing"
    );

    designs::write_version(&pool, &ring, org, account, design, b"MARKERPAYLOAD", 1)
        .await
        .expect("write");

    let queued = spooled_for(&su, &chain_id).await;
    assert_eq!(
        queued.len(),
        1,
        "a design write must queue exactly one audit line, in the same transaction"
    );
    assert_eq!(queued[0].chain_kind, "design");
    assert_eq!(queued[0].seq, 1);
    assert_eq!(queued[0].entry_type, "create");

    // And what is queued is §7.3's in-the-clear list and nothing more.
    let line = audit::render_line(&queued[0]);
    assert!(line.contains("chain_kind=design"), "{line}");
    assert!(
        !line.contains("MARKERPAYLOAD"),
        "no payload may reach a syslog line: {line}"
    );
    assert!(
        !line.contains("metadata"),
        "§7.3: metadata is the side door a plaintext copy comes back through, and it is not \
         shipped in either form: {line}"
    );
}

#[tokio::test]
async fn the_act_applies_when_the_destination_is_dead_and_drains_in_order_when_it_returns() {
    let _spool = support::lock_the_spool().await;
    // **§9's case, and the one every deployment hits in its first week.** Three
    // claims in one test because they are one behaviour: the act applies, the
    // entry spools, and the spool drains IN ORDER on reconnect.
    let pool = support::migrated_pool().await;
    let ring = keyring(101);
    let (account, org, design) = a_design(&pool).await;

    let su = support::superuser_client_on_test_database().await;
    let chain_id = design.to_string();
    let dead = a_dead_address().await;

    // ---- The destination is down. The act still applies. ------------------
    for n in 1..=5 {
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
        .unwrap_or_else(|e| panic!("a write must not fail because a SIEM is down: {e:?}"));
    }

    // The data is really there -- "the act applied" is not "the call returned".
    let read = designs::read_version(&pool, &ring, org, account, design, None)
        .await
        .expect("read the design back");
    assert_eq!(read.version, 5);
    assert_eq!(read.payload, b"version 5");

    // ---- And the entries spooled -----------------------------------------
    assert_eq!(
        spooled_for(&su, &chain_id).await.len(),
        5,
        "nothing may be dropped while the destination is unreachable"
    );

    // A drain attempt against the dead address fails, and drops nothing.
    let err = audit::drain_once(&su, &dead)
        .await
        .expect_err("the destination is not listening");
    assert!(matches!(err, audit::ShipError::Unreachable(_)), "{err}");
    assert_eq!(
        spooled_for(&su, &chain_id).await.len(),
        5,
        "a failed attempt must leave every entry queued"
    );

    // The attempt is recorded on the rows, so an operator can see it tried.
    let attempts: i32 = su
        .query_one(
            "SELECT max(attempts) FROM audit_spool WHERE chain_id = $1",
            &[&chain_id],
        )
        .await
        .expect("attempts")
        .get(0);
    assert!(attempts >= 1, "a failed attempt must be counted");

    // ---- The destination returns -----------------------------------------
    let receiver = Receiver::start().await;
    drain_until_empty(&su, &receiver.target(), &chain_id).await;
    assert!(
        spooled_for(&su, &chain_id).await.is_empty(),
        "the spool must drain once the destination returns"
    );

    let lines = receiver.lines_at_least(5).await;
    let mine: Vec<String> = lines
        .iter()
        .filter(|l| l.contains(&format!("chain_id={chain_id} ")))
        .cloned()
        .collect();
    assert_eq!(mine.len(), 5, "{mine:#?}");

    // **In order.** Three chains interleave in one queue, so the order that
    // matters is the spool's -- and within one chain it must agree with `seq`.
    assert_eq!(
        seqs_for(&lines, &chain_id),
        vec![1, 2, 3, 4, 5],
        "the spool must drain in order, not in whatever order the rows came back"
    );

    // And each line is RFC 5424 shaped.
    for line in &mine {
        assert!(line.starts_with("<109>1 "), "{line}");
        assert!(line.contains("fathom-audit"), "{line}");
    }

    receiver.stop();
}

#[tokio::test]
async fn a_dead_destination_does_not_slow_a_write_down() {
    // §9: *"availability is not defended against the party who holds the
    // machine"*, so a fail-closed rule here would hand whoever points the
    // shipper at a black-hole host a one-click site-wide outage. The write
    // path does one INSERT and touches no socket; this is what checks that the
    // socket is genuinely not on it.
    let pool = support::migrated_pool().await;
    let ring = keyring(102);
    let (account, org, design) = a_design(&pool).await;

    let started = std::time::Instant::now();
    designs::write_version(&pool, &ring, org, account, design, b"x", 1)
        .await
        .expect("write");
    let elapsed = started.elapsed();

    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "a design write took {elapsed:?} with no audit destination configured at all. The write \
         path must touch no socket: if it ever connects, a destination that accepts and never \
         reads stalls every request in the deployment."
    );
}

#[tokio::test]
async fn every_chain_level_spools_and_ships() {
    let _site = support::lock_the_site_chain().await;
    let _spool = support::lock_the_spool().await;
    // All three levels reach the far end, not just the one that was easiest to
    // wire. A trail with a level missing is a trail nobody can reason about a
    // gap in.
    let pool = support::migrated_pool().await;
    let ring = site_keyring();
    let (account, org, design) = a_design(&pool).await;

    let su = support::superuser_client_on_test_database().await;

    let mut client = pool.get().await.expect("connection");
    let deployment = chains::register_deployment(&**client)
        .await
        .expect("deployment");

    let tx = client.transaction().await.expect("begin");
    chains::record_deployment_started(&tx, &ring, &deployment, 9)
        .await
        .expect("site append");
    tx.commit().await.expect("commit");

    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");
    let tenant_key = keys::tenant_key(&tx, &ring, &ctx)
        .await
        .expect("tenant key");
    chains::append_org(
        &tx,
        &ring,
        &ctx,
        &tenant_key,
        EntryType::OrgGenesis,
        &metadata(EntryType::OrgGenesis, "the first entry"),
    )
    .await
    .expect("org append");
    tx.commit().await.expect("commit");

    designs::write_version(&pool, &ring, org, account, design, b"x", 1)
        .await
        .expect("design write");

    let receiver = Receiver::start().await;
    drain_until_empty(&su, &receiver.target(), &design.to_string()).await;

    let lines = receiver.lines_at_least(3).await;
    // Scoped to this test's own ids, except for the site chain -- there is one
    // of those per database and any site line proves the level ships.
    for (kind, id) in [
        ("site", deployment.clone()),
        ("org", org.to_string()),
        ("design", design.to_string()),
    ] {
        assert!(
            lines
                .iter()
                .any(|l| l.contains(&format!("chain_kind={kind} "))
                    && l.contains(&format!("chain_id={id} "))),
            "no {kind} entry for {id} reached the destination: {lines:#?}"
        );
    }

    receiver.stop();
}
