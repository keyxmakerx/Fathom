//! `migrations/0009_chains_at_three_levels.sql` section D, proved against a
//! real PostgreSQL **as the bootstrap superuser**.
//!
//! This is `tests/principals_fence.rs`'s shape applied to the audit trail, and
//! for the same reason. `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §7.7 asks for
//! an append-only fence *"enforced by trigger, not by policy, so it binds a
//! superuser too"* — and a claim about what binds a superuser is a behaviour
//! claim, which CLAUDE.md rule 1 forbids asserting from memory. So every test
//! below connects as the most privileged role the environment has and reads
//! the answer off the run.
//!
//! # The four routes, and why each needs its own test
//!
//! 1. `UPDATE` — the row-level trigger.
//! 2. `DELETE` — the same trigger.
//! 3. `TRUNCATE` — **a different trigger, and the gap that makes it worth
//!    writing down.** `TRUNCATE` fires no row-level trigger at all, so a
//!    `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger on its own leaves one
//!    statement that erases the entire history of every tenant at once.
//! 4. A `DELETE` **cascading through a parent** — which is subject to no policy
//!    and no privilege check, at any level. `0008` closed that for designs;
//!    §11.1's claim is only true for the site and organisation chains if it is
//!    closed for them too, and nothing but a referential constraint does it.
//!
//! # What these tests deliberately do not claim
//!
//! That the fence survives a tier-3 attacker. `ALTER TABLE ... DISABLE TRIGGER
//! USER` needs ownership and turns all of this off; the migration's own header
//! says so, and `tests/support::tamper` uses exactly that route so the cost is
//! visible in the tests that depend on it. §7.7's answer — moving these tables
//! to a `fathom_audit` role with no login — is not built, and this file claims
//! nothing about it.

mod support;

use tokio_postgres::error::SqlState;
use tokio_postgres::Client;

/// Migrate through the restricted role, exactly as the server does, then hand
/// back a superuser connection to the same database.
async fn migrated_then_superuser() -> Client {
    let _pool = support::migrated_pool().await;
    support::superuser_client_on_test_database().await
}

fn id() -> String {
    fathom_server::ids::new_ulid().to_string()
}

/// The refusal must come from the trigger, not from a privilege or a policy —
/// those are different fences with different reach, and a test that accepted
/// any error would pass against a schema where the trigger had been dropped.
fn assert_refused_by_the_trigger(err: &tokio_postgres::Error, what: &str) {
    assert_eq!(
        err.code(),
        Some(&SqlState::RAISE_EXCEPTION),
        "{what}: expected the append-only trigger to raise, got: {err}"
    );
    let message = err
        .as_db_error()
        .map(|e| e.message().to_string())
        .unwrap_or_else(|| format!("{err}"));
    assert!(
        message.contains("append-only"),
        "{what}: the refusal came from somewhere other than the append-only trigger: {message}"
    );
}

/// A site-chain entry exists to be attacked. Written through the real append
/// path rather than by an `INSERT` here, so what these tests fail to delete is
/// a genuinely sealed row.
async fn a_site_entry(client: &Client) -> (String, i64) {
    use fathom_server::crypto::Key32;
    use fathom_server::keys::KeyRing;

    let pool = support::migrated_pool().await;
    let ring = KeyRing::from_keys(
        Key32::from_bytes([21; 32]),
        Key32::from_bytes(support::SITE_CHAIN_MASTER),
    );
    let mut conn = pool.get().await.expect("connection");
    let deployment = fathom_server::chains::register_deployment(&**conn)
        .await
        .expect("register the deployment");
    let tx = conn.transaction().await.expect("begin");
    let appended = fathom_server::chains::record_deployment_started(&tx, &ring, &deployment, 9)
        .await
        .expect("append to the site chain");
    tx.commit().await.expect("commit");

    let rows = client
        .query(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'site'",
            &[],
        )
        .await
        .expect("count site entries");
    assert!(
        rows[0].get::<_, i64>(0) >= 1,
        "there must be a site entry to attack"
    );
    (deployment, appended.seq)
}

#[tokio::test]
async fn a_superuser_cannot_update_a_chain_entry() {
    let client = migrated_then_superuser().await;
    let (deployment, seq) = a_site_entry(&client).await;

    let err = client
        .execute(
            "UPDATE chain_entries SET seal = $3 \
             WHERE chain_kind = 'site' AND chain_id = $1 AND seq = $2",
            &[&deployment, &seq, &vec![0u8; 32]],
        )
        .await
        .expect_err(
            "rewriting a sealed entry is the act this fence exists to refuse, and it must be \
             refused for EVERY role -- a policy would not be evaluated for this one at all",
        );
    assert_refused_by_the_trigger(&err, "UPDATE");
}

#[tokio::test]
async fn a_superuser_cannot_delete_a_chain_entry() {
    let client = migrated_then_superuser().await;
    let (deployment, seq) = a_site_entry(&client).await;

    let err = client
        .execute(
            "DELETE FROM chain_entries WHERE chain_kind = 'site' AND chain_id = $1 AND seq = $2",
            &[&deployment, &seq],
        )
        .await
        .expect_err("deleting a sealed entry must be refused for every role");
    assert_refused_by_the_trigger(&err, "DELETE");
}

#[tokio::test]
async fn a_superuser_cannot_truncate_the_chain() {
    // The one a row-level trigger does not cover. Without the statement-level
    // trigger this single statement erases every chain of every tenant, and
    // the two tests above would still have passed.
    let client = migrated_then_superuser().await;
    let _ = a_site_entry(&client).await;

    let err = client
        .batch_execute("TRUNCATE chain_entries")
        .await
        .expect_err(
            "TRUNCATE fires no row-level trigger, so without its own statement-level trigger \
             one statement erases the entire audit trail",
        );
    assert_refused_by_the_trigger(&err, "TRUNCATE");
}

#[tokio::test]
async fn a_superuser_cannot_remove_or_rewrite_the_deployment_identity() {
    // The site chain is sealed under this id. Deleting it and re-stamping
    // forks the chain under a new name and leaves every existing site entry
    // unreachable from the current identity -- an erasure that leaves the
    // rows in place, which is the kind a verifier cannot report.
    let client = migrated_then_superuser().await;
    let _ = a_site_entry(&client).await;

    let err = client
        .execute("DELETE FROM deployments", &[])
        .await
        .expect_err("the site chain's anchor must not be removable");
    assert_refused_by_the_trigger(&err, "DELETE FROM deployments");

    let err = client
        .execute("UPDATE deployments SET id = $1", &[&id()])
        .await
        .expect_err("the site chain's anchor must not be rewritable");
    assert_refused_by_the_trigger(&err, "UPDATE deployments");
}

#[tokio::test]
async fn an_organisation_chain_cannot_be_erased_through_its_parent() {
    // §11.1's claim, at the level `0008` did not reach. A referential action
    // is subject to no policy and no privilege check at any level, so the only
    // thing that can close this is a constraint -- and before `0009`,
    // `chain_entries.organisation_id` carried no direct reference at all, so
    // an organisation chain had no parent fence whatsoever.
    use fathom_server::chain::EntryType;
    use fathom_server::crypto::Key32;
    use fathom_server::keys::KeyRing;
    use fathom_server::repo;

    let pool = support::migrated_pool().await;
    let ring = KeyRing::from_keys(Key32::from_bytes([21; 32]), Key32::from_bytes([84; 32]));

    let stamp = id();
    let account = repo::create_account(&pool, &format!("{stamp}@example.test"), "Someone")
        .await
        .expect("account");
    let org = repo::create_organisation(&pool, account.id, &format!("Org {stamp}"))
        .await
        .expect("organisation");

    // One sealed entry on this organisation's chain, through the real append
    // path. `org_genesis` rather than a re-wrap: a re-wrap changes which master
    // key this whole DATABASE is active under (ADR-0043 §4 allows one), and a
    // fence test has no business mutating a fixture every other test shares.
    let mut client = pool.get().await.expect("connection");
    let tx = client.transaction().await.expect("begin");
    let ctx = repo::open_tenant_context(&tx, org.id, account.id)
        .await
        .expect("tenant context");
    let tenant_key = fathom_server::keys::tenant_key(&tx, &ring, &ctx)
        .await
        .expect("tenant key");
    fathom_server::chains::append_org(
        &tx,
        &ring,
        &ctx,
        &tenant_key,
        EntryType::OrgGenesis,
        br#"{"entry_type":"org_genesis"}"#,
    )
    .await
    .expect("append to the organisation chain");
    tx.commit().await.expect("commit");

    let su = support::superuser_client_on_test_database().await;
    let err = su
        .execute(
            "DELETE FROM organisations WHERE id = $1",
            &[&org.id.to_string()],
        )
        .await
        .expect_err(
            "deleting an organisation that has a sealed chain must be refused -- a cascade \
             bypasses row-level security entirely and would have erased the history",
        );
    assert_eq!(
        err.code(),
        Some(&SqlState::FOREIGN_KEY_VIOLATION),
        "expected referential integrity to refuse it, got: {err}"
    );

    // The positive control: the history is still there.
    let rows = su
        .query(
            "SELECT count(*) FROM chain_entries WHERE chain_kind = 'org' AND chain_id = $1",
            &[&org.id.to_string()],
        )
        .await
        .expect("count");
    assert_eq!(rows[0].get::<_, i64>(0), 1);
}

#[tokio::test]
async fn the_positive_control_an_entry_can_still_be_appended() {
    // A file that only ever refuses is not evidence that the table works. If
    // this failed, every refusal above would be satisfied by a table nothing
    // can write to at all, and the audit trail would be empty rather than
    // append-only.
    let client = migrated_then_superuser().await;
    let (deployment, first) = a_site_entry(&client).await;
    let (_, second) = a_site_entry(&client).await;
    assert!(
        second > first,
        "a second deployment_started must append after the first, not replace it"
    );

    let rows = client
        .query(
            "SELECT seq FROM chain_entries WHERE chain_kind = 'site' AND chain_id = $1 \
             ORDER BY seq",
            &[&deployment],
        )
        .await
        .expect("read the site chain");
    let seqs: Vec<i64> = rows.iter().map(|r| r.get(0)).collect();
    assert!(seqs.len() >= 2, "{seqs:?}");
    for pair in seqs.windows(2) {
        assert_eq!(pair[1], pair[0] + 1, "the site chain must be contiguous");
    }
}
