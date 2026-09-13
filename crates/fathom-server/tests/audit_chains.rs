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
use tokio_postgres::error::SqlState;

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
                Some(chain::StoredEntryType::Known(EntryType::DeploymentStarted)),
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
// Re-wrap — §12.6, and it is deployment-wide
// ---------------------------------------------------------------------------

/// The new master key a re-wrap moves custody to.
const NEW_MASTER: [u8; 32] = [188; 32];

/// Who ran it. An account id is a `principals` row, which is what
/// `tenant_keys.rewrapped_by` references; when the administrative surface
/// exists the actor is an operator principal and nothing else about this
/// changes.
async fn a_deployment(tag: &str) -> (Pool, String) {
    let pool = support::isolated_deployment(tag).await;
    let client = pool.get().await.expect("connection");
    let deployment = chains::register_deployment(&**client)
        .await
        .expect("stamp the deployment id, exactly as main.rs does at startup");
    (pool.clone(), deployment)
}

#[tokio::test]
async fn a_rewrap_moves_every_tenant_and_not_just_the_one_named() {
    // **The worst defect this file exists to keep closed.** `rewrap_tenant_keys`
    // took an organisation id, retired the DEPLOYMENT's active master key, and
    // then re-wrapped one tenant's rows. Every other tenant was left sealed
    // under a master key the database had marked retired, which the new key
    // does not open: openable under neither. Total, silent data loss for every
    // tenant but one, performed by the operation whose whole promise is that
    // it changes nothing but custody.
    //
    // Two tenants, because one tenant cannot show it.
    let (pool, deployment) = a_deployment("rewrap_every_tenant").await;
    let ring = keyring(95);
    let new_master = Key32::from_bytes(NEW_MASTER);

    let (account_a, org_a, design_a) = a_design(&pool).await;
    let (account_b, org_b, design_b) = a_design(&pool).await;
    designs::write_version(
        &pool,
        &ring,
        org_a,
        account_a,
        design_a,
        b"tenant A estate",
        1,
    )
    .await
    .expect("write A");
    designs::write_version(
        &pool,
        &ring,
        org_b,
        account_b,
        design_b,
        b"tenant B estate",
        1,
    )
    .await
    .expect("write B");

    let report = keys::rewrap_master_key(
        &pool,
        &ring,
        &new_master,
        KeyOperation::Rewrap,
        &account_a.to_string(),
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).expect("acknowledge"),
    )
    .await
    .expect("re-wrap");

    // §12.6's required report, field by field, and the counts are
    // deployment-wide.
    assert_eq!(report.operation, KeyOperation::Rewrap);
    assert_eq!(report.from_master_key_id, ring.master_key_id());
    assert_eq!(report.to_master_key_id, new_master.id());
    assert_eq!(
        report.tenants_rewrapped, 2,
        "both tenants must move, not the one somebody named: {report}"
    );
    assert_eq!(report.tenant_key_rows_rewrapped, 2);
    assert_eq!(
        report.payload_versions_reencrypted, 0,
        "a re-wrap re-encrypts nothing, and the report says so as a COUNT"
    );
    assert_eq!(report.subordinate_key_rows_rewrapped, 0);
    assert_eq!(report.exposure_statement(), REWRAP_EXPOSURE_STATEMENT);
    let rendered = report.to_string();
    assert!(rendered.starts_with("rewrap:"), "{rendered}");
    assert!(rendered.contains(REWRAP_EXPOSURE_STATEMENT), "{rendered}");

    // ---- Both tenants open under the NEW key ------------------------------
    let after = keyring_with_master(NEW_MASTER, 95);
    for (account, org, design, expected) in [
        (account_a, org_a, design_a, b"tenant A estate".as_slice()),
        (account_b, org_b, design_b, b"tenant B estate".as_slice()),
    ] {
        let version = designs::read_version(&pool, &after, org, account, design, None)
            .await
            .expect("every tenant must open under the new master key");
        assert_eq!(version.payload, expected);
    }

    // ---- And neither under the OLD one ------------------------------------
    //
    // Cryptographically, not by the stamp: the rows as they are NOW, against
    // the key that used to open them.
    let su = support::superuser_on_isolated("rewrap_every_tenant").await;
    for org in [org_a, org_b] {
        let row = su
            .query_one(
                "SELECT key_epoch, wrapped_key, wrap_nonce FROM tenant_keys \
                 WHERE organisation_id = $1 AND status = 'active'",
                &[&org.to_string()],
            )
            .await
            .expect("the tenant key row");
        let epoch: i32 = row.get(0);
        let wrapped: Vec<u8> = row.get(1);
        let nonce: Vec<u8> = row.get(2);
        assert!(
            keys::unwrap_tenant_key_snapshot(
                &Key32::from_bytes(MASTER),
                &org.to_string(),
                epoch,
                &wrapped,
                &nonce,
            )
            .is_err(),
            "custody moved: the old master key must not open the rows as they are now"
        );
        assert_eq!(
            epoch, 1,
            "§12.6: a re-wrap MUST NOT move key_epoch -- that is rotation's column"
        );
    }

    // ---- Every chain verifies, and each says what happened ---------------
    let mut client = pool.get().await.expect("connection");
    for (account, org) in [(account_a, org_a), (account_b, org_b)] {
        let tx = client.transaction().await.expect("begin");
        let ctx = repo::open_tenant_context(&tx, org, account)
            .await
            .expect("tenant context");
        let verified = chains::verify_org(&tx, &after, &ctx, true)
            .await
            .expect("verify");
        assert!(
            matches!(verified.outcome, Outcome::Verified { .. }),
            "{org}: {verified}"
        );
        assert_eq!(verified.content, ContentState::Rebound);

        let entries = chains::read_entries(
            &tx,
            ChainRef::Org {
                organisation: &org.to_string(),
            },
        )
        .await
        .expect("read");
        assert_eq!(
            entries.last().map(|e| e.entry_type.clone()),
            Some(chain::StoredEntryType::Known(EntryType::Rewrap)),
            "every re-wrapped tenant gets its own sealed entry: {org}"
        );
        let tenant = report
            .tenant(&org.to_string())
            .expect("the report names every tenant it moved");
        assert_eq!(tenant.key_epochs_rewrapped, vec![1]);
        assert_eq!(tenant.chain_entry_seq, entries.last().unwrap().seq);
        tx.rollback().await.expect("rollback");
    }

    // ---- And the deployment-wide summary, on the one deployment-wide chain
    let tx = client.transaction().await.expect("begin");
    let site = chains::read_entries(
        &tx,
        ChainRef::Site {
            deployment: &deployment,
        },
    )
    .await
    .expect("read the site chain");
    let summary = site
        .iter()
        .find(|e| e.entry_type == chain::StoredEntryType::Known(EntryType::Rewrap))
        .expect("the operator's act is deployment-wide and the site chain records it");
    assert_eq!(summary.seq, report.site_chain_entry_seq);
    let verified = chains::verify_site(&tx, &after, true)
        .await
        .expect("verify");
    assert!(
        matches!(verified.outcome, Outcome::Verified { .. }),
        "{verified}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn a_failure_part_way_through_leaves_every_tenant_openable_under_the_old_key() {
    // The other half of "it owns its transaction": no key change without its
    // entries, and no entry without its key change. The injection is a key row
    // that will not open -- a tier-2 attacker's edit, or a byte of corruption
    // -- on the LAST tenant, so the two before it have already been re-wrapped
    // in this transaction when the failure lands.
    let tag = "rewrap_rolls_back";
    let (pool, _deployment) = a_deployment(tag).await;
    let ring = keyring(94);

    let (account_a, org_a, design_a) = a_design(&pool).await;
    let (account_b, org_b, design_b) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org_a, account_a, design_a, b"A", 1)
        .await
        .expect("write A");
    designs::write_version(&pool, &ring, org_b, account_b, design_b, b"B", 1)
        .await
        .expect("write B");

    // The third tenant sorts last by id (ULIDs are monotonic in time), so the
    // re-wrap reaches it after the other two.
    let (account_c, org_c) = a_tenant(&pool).await;
    {
        let mut client = pool.get().await.expect("connection");
        let tx = client.transaction().await.expect("begin");
        let ctx = repo::open_tenant_context(&tx, org_c, account_c)
            .await
            .expect("tenant context");
        keys::tenant_key(&tx, &ring, &ctx)
            .await
            .expect("mint a tenant key for C");
        tx.commit().await.expect("commit");
    }
    assert!(
        org_c.to_string() > org_a.to_string() && org_c.to_string() > org_b.to_string(),
        "the injected failure must come last"
    );

    let su = support::superuser_on_isolated(tag).await;
    su.execute(
        "UPDATE tenant_keys SET wrapped_key = $2 WHERE organisation_id = $1",
        &[&org_c.to_string(), &vec![7u8; 60]],
    )
    .await
    .expect("inject a key row that will not unwrap");

    let err = keys::rewrap_master_key(
        &pool,
        &ring,
        &Key32::from_bytes(NEW_MASTER),
        KeyOperation::Rewrap,
        &account_a.to_string(),
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).unwrap(),
    )
    .await
    .expect_err("a key row that will not open must fail the whole re-wrap");
    assert!(
        matches!(err, KeyStoreError::Unwrap { .. }),
        "the failure must be the unwrap, not something incidental: {err:?}"
    );

    // ---- Nothing moved ----------------------------------------------------
    let active: String = su
        .query_one(
            "SELECT key_id FROM master_keys WHERE status = 'active'",
            &[],
        )
        .await
        .expect("one active master key")
        .get(0);
    assert_eq!(
        active,
        ring.master_key_id().to_string(),
        "the master key row must be exactly as it was: a retired old key with no re-wrap to \
         match it is every tenant unopenable"
    );

    let rewrap_entries: i64 = su
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE entry_type = 'rewrap'",
            &[],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(
        rewrap_entries, 0,
        "no entry without its key change -- not on any chain, at any level"
    );

    // ---- And both intact tenants still open, under the ORIGINAL key -------
    for (account, org, design, expected) in [
        (account_a, org_a, design_a, b"A".as_slice()),
        (account_b, org_b, design_b, b"B".as_slice()),
    ] {
        let version = designs::read_version(&pool, &ring, org, account, design, None)
            .await
            .expect("a rolled-back re-wrap leaves every tenant exactly as it was");
        assert_eq!(version.payload, expected);
    }
}

#[tokio::test]
async fn the_rewrap_entry_states_that_no_payload_was_reencrypted() {
    // §12.6 asks for that fact **inside the entry**, not only in the interface
    // that reported it. A reader of this chain in two years is asking whether
    // the estate was ever exposed to a key somebody else holds, and the answer
    // has to be in the sealed record rather than inferred from documentation.
    let tag = "rewrap_entry_says_so";
    let (pool, deployment) = a_deployment(tag).await;
    let ring = keyring(96);
    let (account, org, design) = a_design(&pool).await;
    designs::write_version(&pool, &ring, org, account, design, b"x", 1)
        .await
        .expect("write");

    keys::rewrap_master_key(
        &pool,
        &ring,
        &Key32::from_bytes(NEW_MASTER),
        KeyOperation::Rewrap,
        &account.to_string(),
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).unwrap(),
    )
    .await
    .expect("re-wrap");

    let after = keyring_with_master(NEW_MASTER, 96);
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");

    // Read it back the way an auditor would: decrypt the entry's metadata.
    let tenant_key = keys::tenant_key(&tx, &after, &ctx)
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
        "\"key_epochs_rewrapped\":[1]",
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

    // And the site chain's summary says the deployment-wide part: how many
    // tenants, and both identities. Its metadata key is derived from the chain
    // master, which a re-wrap does not touch.
    let site_row = tx
        .query_one(
            "SELECT seq, metadata_nonce, metadata, chain_key_epoch FROM chain_entries \
             WHERE chain_kind = 'site' AND chain_id = $1 AND entry_type = 'rewrap'",
            &[&deployment],
        )
        .await
        .expect("the site summary entry");
    let site_seq: i64 = site_row.get(0);
    let site_nonce: Vec<u8> = site_row.get(1);
    let site_ciphertext: Vec<u8> = site_row.get(2);
    let site_epoch: i32 = site_row.get(3);
    // The chain master this test's ring was built from -- a re-wrap does not
    // touch it, which is the point: the site entry describing the master key's
    // replacement is sealed and encrypted under a root that did not move.
    let site_key = chain::site_metadata_key(&Key32::from_bytes([96; 32]), &deployment, site_epoch);
    let site_aad = chain::metadata_aad(
        ChainRef::Site {
            deployment: &deployment,
        },
        site_seq,
        site_epoch,
    );
    let site_nonce: [u8; 12] = site_nonce.as_slice().try_into().unwrap();
    let site_text = String::from_utf8(
        fathom_server::crypto::open(&site_key, &site_nonce, &site_ciphertext, &site_aad)
            .expect("the site entry's metadata must decrypt"),
    )
    .expect("canonical JSON is UTF-8");
    assert!(site_text.contains("\"tenants_rewrapped\":1"), "{site_text}");
    assert!(
        site_text.contains("\"payload_reencrypted\":false"),
        "{site_text}"
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
    let tag = "rewrap_old_key_still_opens";
    let (pool, _deployment) = a_deployment(tag).await;
    let ring = keyring(97);
    let (account, org, design) = a_design(&pool).await;
    let payload = b"core-fw-01 10.1.1.0/24 the estate map".to_vec();
    designs::write_version(&pool, &ring, org, account, design, &payload, 1)
        .await
        .expect("write a version");

    let su = support::superuser_on_isolated(tag).await;

    // The copy §12.6 names: the key rows as they were BEFORE the switch.
    let snapshot = su
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
    let stored = su
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

    keys::rewrap_master_key(
        &pool,
        &ring,
        &Key32::from_bytes(NEW_MASTER),
        KeyOperation::Rewrap,
        &account.to_string(),
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).unwrap(),
    )
    .await
    .expect("re-wrap");

    // ---- Custody changed --------------------------------------------------
    let after = su
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
    let unchanged = su
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
    let design_entries: i64 = su
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
    let design_key_row = su
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
}

#[tokio::test]
async fn rotate_is_refused_as_a_synonym_for_rewrap() {
    // §12.6's one refusal. A setting that silently re-wrapped when an operator
    // asked to rotate would leave them believing they had revoked something.
    //
    // The shared pool is safe here: the refusal is decided before a connection
    // is taken, let alone a transaction, which is itself part of the claim.
    let pool = support::migrated_pool().await;
    let ring = keyring(98);
    let (account, _org) = a_tenant(&pool).await;

    let err = keys::rewrap_master_key(
        &pool,
        &ring,
        &Key32::from_bytes(NEW_MASTER),
        KeyOperation::Rotate,
        &account.to_string(),
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

    // And nothing moved, which is what "decided before a connection is taken"
    // means in the database.
    let client = pool.get().await.expect("connection");
    let active: i64 = client
        .query_one(
            "SELECT count(*) FROM master_keys WHERE key_id = $1",
            &[&Key32::from_bytes(NEW_MASTER).id().to_string()],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(active, 0);
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
    // Refused before a connection is taken, like the synonym refusal above.
    let pool = support::migrated_pool().await;
    let ring = keyring(99);
    let (account, _org) = a_tenant(&pool).await;

    let err = keys::rewrap_master_key(
        &pool,
        &ring,
        &Key32::from_bytes(MASTER),
        KeyOperation::Rewrap,
        &account.to_string(),
        ExposureAcknowledged::of(REWRAP_EXPOSURE_STATEMENT).unwrap(),
    )
    .await
    .expect_err("re-wrapping to the key already in use must be refused");
    assert!(
        matches!(err, KeyStoreError::RewrapToTheSameMasterKey),
        "{err:?}"
    );
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

// ---------------------------------------------------------------------------
// The entry-type constraint — §7.2, and 0010
// ---------------------------------------------------------------------------

/// An organisation chain with `appends` sealed entries on it, through the real
/// append path. Returns the tenant and how many entries ended up there
/// (`org_genesis` is written first, so it is one more than asked for).
async fn an_org_chain(pool: &Pool, ring: &KeyRing, appends: usize) -> (AccountId, OrganisationId) {
    let (account, org) = a_tenant(pool).await;
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");
    let tenant_key = keys::tenant_key(&tx, ring, &ctx).await.expect("tenant key");
    for n in 0..appends {
        chains::append_org(
            &tx,
            ring,
            &ctx,
            &tenant_key,
            EntryType::Rewrap,
            &metadata(EntryType::Rewrap, &format!("entry {n}")),
        )
        .await
        .expect("append");
    }
    tx.commit().await.expect("commit");
    (account, org)
}

/// Copy an existing entry into a new row at `seq + 100`, with one column
/// changed. The runtime role's own privileges and policies, and nothing else.
const CLONE_ENTRY_SQL: &str = "INSERT INTO chain_entries \
        (chain_kind, chain_id, organisation_id, seq, entry_type, chain_key_epoch, prev_seal, \
         plaintext_binding, storage_binding, content_hash, seal, metadata, metadata_binding, \
         metadata_key_epoch, metadata_nonce, metadata_aead_alg_id) \
     SELECT chain_kind, chain_id, organisation_id, seq + 100, $2, chain_key_epoch, prev_seal, \
            plaintext_binding, storage_binding, content_hash, seal, metadata, metadata_binding, \
            metadata_key_epoch, metadata_nonce, metadata_aead_alg_id \
       FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1 ORDER BY seq DESC LIMIT 1";

#[tokio::test]
async fn the_runtime_role_cannot_file_an_unknown_type_or_a_type_on_the_wrong_chain() {
    // **0009 dropped 0007's `CHECK (entry_type IN (...))` and never added the
    // replacement its own header claimed.** So until 0010 this INSERT
    // succeeded, through the ordinary policy, with no privilege the runtime
    // role did not already hold -- and `read_entries` then returned `Err` for
    // that chain for ever. Both halves are tested: this one is the constraint.
    let pool = support::migrated_pool().await;
    let ring = keyring(71);
    let (account, org) = an_org_chain(&pool, &ring, 1).await;
    let mut client = pool.get().await.expect("connection");

    for (entry_type, why) in [
        ("junk_type", "a type nothing in this build parses"),
        ("creat", "a typo of a real one"),
        ("create", "a design type filed on an organisation chain"),
        (
            "deployment_started",
            "a site type filed on an organisation chain",
        ),
        ("", "the empty string"),
    ] {
        let tx = client.transaction().await.expect("begin");
        repo::open_tenant_context(&tx, org, account)
            .await
            .expect("tenant context");
        let err = tx
            .execute(CLONE_ENTRY_SQL, &[&org.to_string(), &entry_type])
            .await
            .expect_err(&format!("{entry_type:?} must be refused: {why}"));
        assert_eq!(
            err.code(),
            Some(&SqlState::CHECK_VIOLATION),
            "{entry_type:?} ({why}) was refused by something other than a CHECK: {err}"
        );
        assert_eq!(
            err.as_db_error().and_then(|e| e.constraint()),
            Some("chain_entries_type_belongs_to_kind"),
            "the refusal must come from the pairing constraint and not from something \
             incidental: {err}"
        );
        tx.rollback().await.expect("rollback");
    }

    // The positive control: a type that DOES belong on this chain goes in.
    // Without it the five refusals above would be satisfied by a table nothing
    // can write to at all.
    let tx = client.transaction().await.expect("begin");
    repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");
    let inserted = tx
        .execute(CLONE_ENTRY_SQL, &[&org.to_string(), &"rewrap"])
        .await
        .expect("`rewrap` belongs on an organisation chain");
    assert_eq!(inserted, 1);
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn the_constraint_pairs_rewrap_with_both_chains_it_is_filed_on() {
    // A re-wrap is deployment-wide, so it is recorded twice: the tenant-level
    // record §12.6 requires, and the site-level summary of the operator's act.
    // Read off the catalogue rather than off a comment, because the catalogue
    // is what binds a statement this code never issued.
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");
    let definition: String = client
        .query_one(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c \
             WHERE c.conrelid = 'chain_entries'::regclass \
               AND c.conname = 'chain_entries_type_belongs_to_kind'",
            &[],
        )
        .await
        .expect(
            "0009's header said this constraint existed and it did not. It is 0010's, and it \
             must be in the catalogue.",
        )
        .get(0);

    for (kind, entry_type) in [
        ("design", "create"),
        ("design", "update"),
        ("design", "reencrypt"),
        ("site", "deployment_started"),
        ("site", "shipper_gap"),
        ("site", "spool_pressure"),
        ("site", "rewrap"),
        ("org", "org_genesis"),
        ("org", "rewrap"),
    ] {
        // Every pair `EntryType::kinds()` allows must be in the constraint,
        // or the code can write a row the schema refuses.
        let kind_clause = definition
            .split("OR")
            .find(|clause| clause.contains(&format!("'{kind}'::text")))
            .unwrap_or_else(|| panic!("no branch for {kind} in {definition}"));
        assert!(
            kind_clause.contains(&format!("'{entry_type}'::text")),
            "{entry_type} is not allowed on {kind} by the constraint: {definition}"
        );
    }
}

#[tokio::test]
async fn an_entry_type_nothing_parses_reads_as_broken_at_and_not_as_an_error() {
    // §11.2 gives verification three outcomes and "this chain cannot be read"
    // is not one of them. Before 2026-09-12 `read_entries` returned `Err` for
    // an unparseable `entry_type`, so one junk value -- insertable by the
    // runtime role, since the constraint 0009 claimed did not exist -- silenced
    // a whole chain for ever. That is a denial of the control, not a detection
    // of it.
    //
    // Getting the row in now costs dropping a constraint, which is a tier-3
    // move and is performed in the open, exactly as `support::tamper` performs
    // the trigger's.
    let pool = support::migrated_pool().await;
    let ring = keyring(72);
    let (account, org) = an_org_chain(&pool, &ring, 2).await;
    let su = support::superuser_client_on_test_database().await;

    let tip: i64 = su
        .query_one(
            "SELECT max(seq) FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1",
            &[&org.to_string()],
        )
        .await
        .expect("tip")
        .get(0);

    // **The definition is read back before it is dropped, and restored from
    // what was read.** It was hard-coded here until 2026-09-13, and the moment
    // `0011` extended the constraint with the authority layer's nine entry
    // types this test put 0010's shorter version back -- silently, on every
    // run, leaving the database with a constraint that refuses rows the server
    // legitimately writes. Restoring what was actually there costs nothing and
    // cannot go stale.
    let definition: String = su
        .query_one(
            "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c \
             WHERE c.conrelid = 'chain_entries'::regclass \
               AND c.conname = 'chain_entries_type_belongs_to_kind'",
            &[],
        )
        .await
        .expect("the pairing constraint must exist before this test drops it")
        .get(0);

    su.batch_execute(
        "ALTER TABLE chain_entries DROP CONSTRAINT chain_entries_type_belongs_to_kind",
    )
    .await
    .expect("dropping a constraint needs ownership -- a tier-3 move, which is the point");
    let forced = su
        .execute(
            "INSERT INTO chain_entries \
                 (chain_kind, chain_id, organisation_id, seq, entry_type, chain_key_epoch, \
                  prev_seal, plaintext_binding, storage_binding, content_hash, seal, metadata, \
                  metadata_binding, metadata_key_epoch, metadata_nonce, metadata_aead_alg_id) \
             SELECT chain_kind, chain_id, organisation_id, seq + 1, 'a_type_from_the_future', \
                    chain_key_epoch, seal, plaintext_binding, storage_binding, content_hash, \
                    seal, metadata, metadata_binding, metadata_key_epoch, metadata_nonce, \
                    metadata_aead_alg_id \
               FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1 AND seq = $2",
            &[&org.to_string(), &tip],
        )
        .await
        .expect("force the row in");
    assert_eq!(forced, 1);

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");
    let report = chains::verify_org(&tx, &ring, &ctx, false).await;
    tx.rollback().await.expect("rollback");

    // Put the schema back before asserting anything, so a failure here does
    // not leave the whole database without the constraint.
    support::tamper(
        &su,
        "chain_entries",
        "DELETE FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1 AND seq = $2",
        &[&org.to_string(), &(tip + 1)],
    )
    .await;
    su.batch_execute(&format!(
        "ALTER TABLE chain_entries ADD CONSTRAINT chain_entries_type_belongs_to_kind {definition}"
    ))
    .await
    .expect("restore the constraint exactly as it was");

    let report = report.expect(
        "an entry type this build cannot parse must be an OUTCOME, never an Err: an Err says \
         nothing about the entries before it, which is the one claim a sealed history exists \
         to make",
    );
    match &report.outcome {
        Outcome::BrokenAt {
            seq,
            reason,
            verified_before,
            entry_type,
            ..
        } => {
            assert_eq!(*seq, tip + 1);
            assert_eq!(*reason, BreakReason::EntryTypeNotRecognised);
            assert_eq!(
                *verified_before, tip as usize,
                "everything before the forced row must still be reported verified: {report}"
            );
            assert_eq!(
                *entry_type,
                Some(chain::StoredEntryType::Unparsed(
                    "a_type_from_the_future".to_string()
                )),
                "the report must name what was actually in the column"
            );
        }
        other => panic!("expected broken at {}, got {other:?}", tip + 1),
    }
    assert!(
        report.summary().contains("a_type_from_the_future"),
        "the operator is told the text, not just that there was one: {report}"
    );
}

// ---------------------------------------------------------------------------
// The two constructions that no test held — §11.2's seal, §12.2's AAD
// ---------------------------------------------------------------------------

#[tokio::test]
async fn changing_only_the_metadata_binding_breaks_the_seal_on_a_links_only_run() {
    // **The seal correction of 2026-09-12 was pinned by nothing.** Deleting
    // `LP(metadata_binding)` from `chain::seal_message` left every test in this
    // workspace green, which means the corrected construction was resting on a
    // comment.
    //
    // An ORGANISATION chain and a LINKS-ONLY run, deliberately: on a design
    // chain the metadata is plaintext beside the row, so the binding is
    // recomputed and compared whatever the seal covers, and the test would
    // pass with the seal input gutted. Here nothing decrypts, so the ONLY
    // thing that can notice this edit is the seal.
    let pool = support::migrated_pool().await;
    let ring = keyring(73);
    let (account, org) = an_org_chain(&pool, &ring, 2).await;
    let su = support::superuser_client_on_test_database().await;

    let tip: i64 = su
        .query_one(
            "SELECT max(seq) FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1",
            &[&org.to_string()],
        )
        .await
        .expect("tip")
        .get(0);

    // One column, 32 bytes, nothing else touched: not the metadata, not the
    // seal, not the sequence.
    support::tamper(
        &su,
        "chain_entries",
        "UPDATE chain_entries SET metadata_binding = $3 \
         WHERE chain_kind = 'org' AND chain_id = $1 AND seq = $2",
        &[&org.to_string(), &tip, &vec![0x5au8; 32]],
    )
    .await;

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");
    let report = chains::verify_org(&tx, &ring, &ctx, false)
        .await
        .expect("verify");
    match &report.outcome {
        Outcome::BrokenAt { seq, reason, .. } => {
            assert_eq!(*seq, tip);
            assert_eq!(
                *reason,
                BreakReason::SealDoesNotRecompute,
                "the seal covers `LP(metadata_binding)`; if it stops covering it, this edit is \
                 invisible to the routine check: {report}"
            );
        }
        other => panic!("expected a break at {tip}, got {other:?}"),
    }
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn moving_a_metadata_ciphertext_to_another_seq_is_caught_by_the_associated_data() {
    // **The metadata AAD was pinned by nothing either.** Making
    // `chain::metadata_aad` return an empty vector left every test green.
    //
    // The attacker here is tier 2 with the chain key: they hold `psql` and can
    // recompute any seal, which is exactly the case §7.5 says the seal alone
    // does not survive. They move one entry's metadata ciphertext, its nonce
    // and its (clear, 32-byte) `metadata_binding` onto another entry of the
    // same chain, and recompute that row's seal over what is now stored. Every
    // links-only check then passes -- correctly, because every stored column is
    // internally consistent.
    //
    // What stops it is that the AEAD's associated data names the row: the blob
    // does not open at a `seq` it was not sealed at, so a deep run breaks. With
    // the associated data empty it would open, the copied binding would match,
    // and a deep run would report VERIFIED over a moved record.
    let pool = support::migrated_pool().await;
    let ring = keyring(74);
    let (account, org) = an_org_chain(&pool, &ring, 2).await;
    let organisation = org.to_string();
    let chain = ChainRef::Org {
        organisation: &organisation,
    };
    let su = support::superuser_client_on_test_database().await;

    let rows = su
        .query(
            "SELECT seq, entry_type, chain_key_epoch, prev_seal, content_hash, metadata, \
                    metadata_binding, metadata_nonce \
             FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1 ORDER BY seq",
            &[&organisation],
        )
        .await
        .expect("the chain");
    assert!(rows.len() >= 3, "need a source and a destination entry");
    let source = &rows[rows.len() - 2];
    let target = &rows[rows.len() - 1];

    let target_seq: i64 = target.get(0);
    let target_type: String = target.get(1);
    let epoch: i32 = target.get(2);
    let prev_seal: Vec<u8> = target.get(3);
    let content_hash: Vec<u8> = target.get(4);
    let moved_metadata: Vec<u8> = source.get(5);
    let moved_binding: Vec<u8> = source.get(6);
    let moved_nonce: Vec<u8> = source.get(7);

    // The attacker's own seal, over the row as it will be stored. This is the
    // part that needs the chain key and nothing else.
    let chain_key = chain::chain_key(&Key32::from_bytes([74; 32]), chain, epoch);
    let subkeys = chain::Subkeys::derive(&chain_key);
    let forged = chain::seal(
        &subkeys.seal,
        &chain::SealFacts {
            chain_key_epoch: epoch,
            seq: target_seq,
            chain,
            prev_seal: &prev_seal,
            content_hash: &content_hash,
            entry_type: EntryType::parse(&target_type).expect("a known type"),
            metadata_stored: &moved_metadata,
            metadata_binding: &moved_binding,
        },
    );

    support::tamper(
        &su,
        "chain_entries",
        "UPDATE chain_entries SET metadata = $3, metadata_nonce = $4, metadata_binding = $5, \
                seal = $6 \
         WHERE chain_kind = 'org' AND chain_id = $1 AND seq = $2",
        &[
            &organisation,
            &target_seq,
            &moved_metadata,
            &moved_nonce,
            &moved_binding,
            &forged.to_vec(),
        ],
    )
    .await;

    let mut client = pool.get().await.expect("connection");

    // ---- Links only: it passes, and that is the honest answer -------------
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");
    let links = chains::verify_org(&tx, &ring, &ctx, false)
        .await
        .expect("verify");
    assert!(
        matches!(links.outcome, Outcome::Verified { .. }),
        "a links-only run holds only the chain key, and every stored column is consistent -- if \
         this ever breaks, the test below is no longer testing the associated data: {links}"
    );
    assert_eq!(links.content, ContentState::NotRebound);
    tx.rollback().await.expect("rollback");

    // ---- Deep: the blob does not open where it now sits --------------------
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");
    let deep = chains::verify_org(&tx, &ring, &ctx, true)
        .await
        .expect("verify");
    match &deep.outcome {
        Outcome::BrokenAt { seq, reason, .. } => {
            assert_eq!(*seq, target_seq);
            assert_eq!(
                *reason,
                BreakReason::MetadataDoesNotOpenUnderItsOwnAad,
                "a moved ciphertext must be named as a moved ciphertext, distinctly from a \
                 binding that disagrees with a plaintext that did come back: {deep}"
            );
        }
        other => panic!("expected a break at {target_seq}, got {other:?}"),
    }
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// The counter that never counted — §12.3
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_organisation_content_keys_write_counter_actually_counts() {
    // `org_content_keys.writes_under_key` existed from 0009 with a comment
    // calling it "a detector, never the nonce source, exactly as on the two key
    // tables 0007 created" -- and nothing ever incremented it. A counter that
    // cannot count is worse than no column: it reads as evidence that the key
    // is unused, which is the opposite of what §12.3's birthday bound needs to
    // know. One AEAD message per organisation append, so the column is the
    // number of entries on that chain.
    let pool = support::migrated_pool().await;
    let ring = keyring(75);
    let (account, org) = an_org_chain(&pool, &ring, 3).await;

    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    repo::open_tenant_context(&tx, org, account)
        .await
        .expect("tenant context");

    let entries: i64 = tx
        .query_one(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1",
            &[&org.to_string()],
        )
        .await
        .expect("count the entries")
        .get(0);
    assert_eq!(entries, 4, "org_genesis plus three appends");

    let writes: i64 = tx
        .query_one(
            "SELECT writes_under_key FROM org_content_keys \
             WHERE organisation_id = $1 AND key_epoch = 1",
            &[&org.to_string()],
        )
        .await
        .expect("the organisation content key row")
        .get(0);
    assert_eq!(
        writes, entries,
        "every organisation entry seals its metadata under this key with a fresh random nonce, \
         so the counter is the entry count -- it read 0 for ever before 2026-09-12"
    );
    tx.rollback().await.expect("rollback");
}

// ---------------------------------------------------------------------------
// The spool's bounds — §9
// ---------------------------------------------------------------------------

/// Queue a spool row that is `age_seconds` old, inside this transaction only.
///
/// Every bound test runs in a transaction it rolls back: the spool is one
/// queue per deployment and these tests make it look like a deployment in
/// trouble, which no other test should ever see.
async fn a_spooled_entry(tx: &deadpool_postgres::Transaction<'_>, tag: &str, age_seconds: i64) {
    tx.execute(
        "INSERT INTO audit_spool \
             (chain_kind, chain_id, seq, entry_type, chain_key_epoch, seal, occurred_at, \
              queued_at) \
         VALUES ('site', $1, 1, 'deployment_started', 1, $2, \
                 now() - make_interval(secs => $3::double precision), \
                 now() - make_interval(secs => $3::double precision))",
        &[&tag, &vec![9u8; 32], &(age_seconds as f64)],
    )
    .await
    .expect("queue a spool row");
}

#[tokio::test]
async fn the_age_bound_trips_and_says_so_on_the_site_chain() {
    // §9: *"bounded by time first, size second. Default 72 hours or 1 GiB,
    // whichever comes first. Banners to operators from the first hour and to
    // stewards from the sixth, escalating; `shipper_gap` and `spool_pressure`
    // entries at each threshold."* None of that existed: the spool had no
    // bound at all, so a deployment whose SIEM went away in March was still
    // accepting writes in June with an unbounded queue of unwitnessed history.
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = site_keyring();
    let mut client = pool.get().await.expect("connection");
    let deployment = chains::register_deployment(&**client)
        .await
        .expect("deployment id");

    let tx = client.transaction().await.expect("begin");
    a_spooled_entry(&tx, &unique("gap"), 7 * 60 * 60).await;

    // Seven hours, under the default 72-hour bound: both of §9's escalation
    // points, and no bound passed.
    let defaults = audit::SpoolBounds::defaults();
    let state = audit::spool_state(&*tx, &defaults).await.expect("state");
    assert!(state.oldest.as_secs() >= 7 * 60 * 60, "{state:?}");
    assert_eq!(
        state.beyond(&defaults),
        None,
        "seven hours is inside a seventy-two hour bound"
    );

    let mut seen = audit::ThresholdsSeen::new();
    let written = audit::record_spool_thresholds(&tx, &ring, &deployment, &defaults, &mut seen)
        .await
        .expect("record");
    assert_eq!(
        written,
        vec![
            audit::Threshold::GapFirstHour,
            audit::Threshold::GapSixthHour
        ],
        "the operator's threshold and the steward's, in order"
    );
    assert!(
        written
            .iter()
            .all(|t| t.entry_type() == EntryType::ShipperGap),
        "a gap is a `shipper_gap`; `spool_pressure` is for a bound"
    );

    // Recorded once, not once per drain attempt.
    let again = audit::record_spool_thresholds(&tx, &ring, &deployment, &defaults, &mut seen)
        .await
        .expect("record");
    assert!(again.is_empty(), "{again:?}");

    // Now the bound itself, for a deployment that configured a tighter one.
    let tight = audit::SpoolBounds {
        max_age: std::time::Duration::from_secs(60 * 60),
        max_bytes: audit::SpoolBounds::DEFAULT_MAX_BYTES,
    };
    assert_eq!(
        state.beyond(&tight),
        Some(audit::Bound::Age),
        "past a configured age bound, whatever the size says"
    );
    let mut seen = audit::ThresholdsSeen::new();
    let written = audit::record_spool_thresholds(&tx, &ring, &deployment, &tight, &mut seen)
        .await
        .expect("record");
    assert!(
        written.contains(&audit::Threshold::PastAgeBound),
        "{written:?}"
    );
    assert!(
        !written.contains(&audit::Threshold::GapSixthHour),
        "a six-hour banner is unreachable under a one-hour bound and must not be announced: \
         {written:?}"
    );
    assert_eq!(
        audit::Threshold::PastAgeBound.entry_type(),
        EntryType::SpoolPressure
    );

    // The entries are real sealed entries, not a log line with ambitions.
    let report = chains::verify_site(&tx, &ring, false)
        .await
        .expect("verify");
    assert!(
        matches!(report.outcome, Outcome::Verified { .. }),
        "the threshold entries must seal like any other: {report}"
    );

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn the_size_bound_trips_independently_of_the_age_one() {
    let _site = support::lock_the_site_chain().await;
    let pool = support::migrated_pool().await;
    let ring = site_keyring();
    let mut client = pool.get().await.expect("connection");
    let deployment = chains::register_deployment(&**client)
        .await
        .expect("deployment id");

    let tx = client.transaction().await.expect("begin");
    a_spooled_entry(&tx, &unique("pressure"), 0).await;

    // A fresh row: no age threshold can have been crossed, so whatever this
    // reports comes from the size bound alone.
    let bounds = audit::SpoolBounds {
        max_age: audit::SpoolBounds::DEFAULT_MAX_AGE,
        max_bytes: 1,
    };
    let state = audit::spool_state(&*tx, &bounds).await.expect("state");
    assert!(state.bytes > 1, "{state:?}");
    assert_eq!(state.beyond(&bounds), Some(audit::Bound::Size));

    let mut seen = audit::ThresholdsSeen::new();
    let written = audit::record_spool_thresholds(&tx, &ring, &deployment, &bounds, &mut seen)
        .await
        .expect("record");
    assert_eq!(
        written,
        vec![audit::Threshold::PastSizeBound],
        "{written:?}"
    );

    let report = chains::verify_site(&tx, &ring, false)
        .await
        .expect("verify");
    assert!(
        matches!(report.outcome, Outcome::Verified { .. }),
        "{report}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn past_the_bound_a_design_write_is_refused_and_a_read_still_succeeds() {
    // §9's degrade table, third row: *"beyond bounds -- design **writes** stop;
    // design **reads** continue and keep spooling."* The principle §9 rejects
    // is the stronger one: a documentation tool that refuses to show the rack
    // diagram during somebody else's SIEM outage is the control that gets
    // removed from the compose file.
    let pool = support::migrated_pool().await;
    let ring = keyring(76);
    let (account, org, design) = a_design(&pool).await;

    // The positive control first, under §9's real defaults: this write is
    // allowed, and it also guarantees the spool is not empty for the refusal
    // below.
    let version = designs::write_version_under(
        &pool,
        &ring,
        org,
        account,
        design,
        b"the estate, saved while the trail was flowing",
        1,
        audit::SpoolBounds::defaults(),
    )
    .await
    .expect("a write inside the bounds must apply");
    assert_eq!(version, 1);

    let beyond = audit::SpoolBounds {
        max_age: audit::SpoolBounds::DEFAULT_MAX_AGE,
        max_bytes: 1,
    };
    let err = designs::write_version_under(
        &pool,
        &ring,
        org,
        account,
        design,
        b"the estate, saved while the trail was stuck",
        1,
        beyond,
    )
    .await
    .expect_err("past the bound a design write must stop");
    match err {
        designs::DesignError::AuditSpoolBeyondBounds { bound, entries, .. } => {
            assert_eq!(bound, audit::Bound::Size);
            assert!(entries > 0);
        }
        other => panic!("expected the typed refusal a surface can render, got {other:?}"),
    }
    let rendered = err.to_string();
    assert!(
        rendered.contains("Reading designs still works"),
        "the refusal must say what still works, or it reads as data loss: {rendered}"
    );
    assert!(rendered.contains("nothing has been lost"), "{rendered}");

    // Nothing was written: the refusal is before the payload, not after it.
    let latest = designs::read_version(&pool, &ring, org, account, design, None)
        .await
        .expect("reads continue past the bound -- that is the whole of the degrade rule");
    assert_eq!(latest.version, 1);
    assert_eq!(
        latest.payload,
        b"the estate, saved while the trail was flowing"
    );
}

#[tokio::test]
async fn past_the_bound_a_rotation_is_refused_and_drains_to_succeed() {
    // The same row of §9's degrade table as the write above, but for
    // `rotate_design`: a rotation re-encrypts every version and appends one
    // `reencrypt` entry per version, so it grows the unshipped backlog the
    // bound exists to cap -- a thousand-version design adds a thousand at
    // once, where a plain write adds one. §9 draws no line between the two.
    let pool = support::migrated_pool().await;
    let su = support::superuser_client_on_test_database().await;
    let ring = keyring(77);
    let (account, org, design) = a_design(&pool).await;

    designs::write_version_under(
        &pool,
        &ring,
        org,
        account,
        design,
        b"version one, saved while the trail was flowing",
        1,
        audit::SpoolBounds::defaults(),
    )
    .await
    .expect("a write inside the bounds must apply");
    designs::write_version_under(
        &pool,
        &ring,
        org,
        account,
        design,
        b"version two, saved while the trail was flowing",
        1,
        audit::SpoolBounds::defaults(),
    )
    .await
    .expect("a write inside the bounds must apply");

    let before: Vec<(i64, Vec<u8>)> = su
        .query(
            "SELECT design_version, ciphertext FROM design_payload WHERE design_id = $1 \
             ORDER BY design_version",
            &[&design.to_string()],
        )
        .await
        .expect("ciphertexts before")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    let reencrypt_before: i64 = su
        .query_one(
            "SELECT count(*) FROM chain_entries \
             WHERE chain_kind = 'design' AND chain_id = $1 AND entry_type = 'reencrypt'",
            &[&design.to_string()],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(reencrypt_before, 0);

    // Past the bound: the same tight `max_bytes` the write-side test above
    // uses, tripped by the same real spool rows the two writes just queued.
    let beyond = audit::SpoolBounds {
        max_age: audit::SpoolBounds::DEFAULT_MAX_AGE,
        max_bytes: 1,
    };
    let err = designs::rotate_design_under(&pool, &ring, org, account, design, "test", beyond)
        .await
        .expect_err("past the bound a rotation must be refused");
    match err {
        designs::DesignError::AuditSpoolBeyondBounds { bound, entries, .. } => {
            assert_eq!(bound, audit::Bound::Size);
            assert!(entries > 0);
        }
        other => panic!("expected the typed refusal a surface can render, got {other:?}"),
    }

    // Nothing moved: no ciphertext changed and no `reencrypt` entry landed.
    let after: Vec<(i64, Vec<u8>)> = su
        .query(
            "SELECT design_version, ciphertext FROM design_payload WHERE design_id = $1 \
             ORDER BY design_version",
            &[&design.to_string()],
        )
        .await
        .expect("ciphertexts after the refusal")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(
        before, after,
        "a refused rotation must not touch a single stored ciphertext"
    );
    let reencrypt_after: i64 = su
        .query_one(
            "SELECT count(*) FROM chain_entries \
             WHERE chain_kind = 'design' AND chain_id = $1 AND entry_type = 'reencrypt'",
            &[&design.to_string()],
        )
        .await
        .expect("count")
        .get(0);
    assert_eq!(
        reencrypt_after, 0,
        "a refused rotation must append no reencrypt entry"
    );

    // The spool drains -- modelled here, as the write-side test models it, by
    // the bound relaxing back to §9's real defaults -- and the same rotation
    // then succeeds.
    let report = designs::rotate_design_under(
        &pool,
        &ring,
        org,
        account,
        design,
        "test",
        audit::SpoolBounds::defaults(),
    )
    .await
    .expect("once the spool is within bounds the rotation must apply");
    assert_eq!(report.versions_reencrypted, 2);
    assert_eq!(report.chain_entries_written, 2);
}
