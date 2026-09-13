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

    // A deployment of its own, not the shared `migrated_pool` database:
    // `ALTER TABLE org_content_keys DROP/ADD CONSTRAINT` below takes `ACCESS
    // EXCLUSIVE` on the whole table, and `org_content_keys` is written on
    // every organisation-chain append (`tests/audit_chains.rs`'s
    // `the_organisation_content_keys_write_counter_actually_counts` is proof
    // it is shared, deployment-wide bookkeeping, not a fixture of this test's
    // own). Nothing takes a lock before writing to it, so on the shared
    // database this DDL stalls -- for as long as its constraint validation
    // takes -- any other test binary's concurrent append to ANY
    // organisation's chain, this test's own included.
    let pool = support::isolated_deployment("org_chain_erase_fence").await;
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

    let su = support::superuser_on_isolated("org_chain_erase_fence").await;

    // ---- The constraint itself, off the catalogue -------------------------
    //
    // **Asserting the SQLSTATE alone proved nothing.** Deleting the whole
    // `chain_entries_organisation_fkey` block from `0009` left this test
    // passing: the refusal it saw came from `org_content_keys`'s own reference
    // to `organisations`, which `append_org` creates on the way past, and an
    // organisation chain was left with no parent fence at all. So the
    // constraint is named, and so is its referential action -- a fence with
    // `ON DELETE CASCADE` is not a fence, it is the erasure this test exists
    // to refuse.
    let fence = su
        .query_opt(
            "SELECT c.confdeltype::text \
               FROM pg_constraint c \
              WHERE c.conname = 'chain_entries_organisation_fkey' \
                AND c.conrelid = 'chain_entries'::regclass \
                AND c.confrelid = 'organisations'::regclass \
                AND c.contype = 'f'",
            &[],
        )
        .await
        .expect("read pg_constraint")
        .map(|row| row.get::<_, String>(0));
    assert_eq!(
        fence.as_deref(),
        Some("r"),
        "`chain_entries.organisation_id` must carry its OWN reference to `organisations` with \
         ON DELETE RESTRICT ('r'). Without it an organisation chain has no parent fence: a \
         cascade is subject to no policy and no privilege check at any level, and the refusal \
         this test sees would be coming from some other table that happens to exist."
    );

    // ---- And it is the constraint that actually refuses -------------------
    //
    // Which foreign key fires first is PostgreSQL's business: the referential
    // triggers run in creation order, and `org_content_keys`' own RESTRICT on
    // `organisations` was created earlier in `0009` than this one -- which is
    // exactly why asserting the SQLSTATE proved nothing. So the earlier one is
    // lifted for the length of one statement, leaving `chain_entries` as the
    // only thing between a `DELETE` and a sealed history, and then put back.
    //
    // Dropping a constraint needs ownership -- the same tier-3 move
    // `support::tamper` makes visible for the append-only trigger. It is
    // restored before anything is asserted, so a failure here cannot leave the
    // schema short of a fence.
    su.batch_execute(
        "ALTER TABLE org_content_keys DROP CONSTRAINT org_content_keys_organisation_id_fkey",
    )
    .await
    .expect("lift the earlier RESTRICT for one statement");

    let err = su
        .execute(
            "DELETE FROM organisations WHERE id = $1",
            &[&org.id.to_string()],
        )
        .await;

    su.batch_execute(
        "ALTER TABLE org_content_keys ADD CONSTRAINT org_content_keys_organisation_id_fkey \
         FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE RESTRICT",
    )
    .await
    .expect("put it back");

    let err = err.expect_err(
        "deleting an organisation that has a sealed chain must be refused -- a cascade \
         bypasses row-level security entirely and would have erased the history",
    );
    assert_eq!(
        err.code(),
        Some(&SqlState::FOREIGN_KEY_VIOLATION),
        "expected referential integrity to refuse it, got: {err}"
    );
    assert_eq!(
        err.as_db_error().and_then(|e| e.constraint()),
        Some("chain_entries_organisation_fkey"),
        "the refusal must come from the chain's OWN parent fence. Before 2026-09-12 this test \
         asserted only the SQLSTATE, and deleting the whole \
         `chain_entries_organisation_fkey` block from `0009` left it green: the refusal it saw \
         came from `org_content_keys_organisation_id_fkey`, and an organisation chain had no \
         parent fence at all. Got: {err}"
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

// ---------------------------------------------------------------------------
// `0011` section G — the same fence on the five AUTHORITY tables
//
// A checker dropped all five of these triggers and **the whole suite stayed
// green**. Every test that cared about tampering reached for
// `support::tamper`, which disables triggers itself, so nothing anywhere
// asserted the triggers were there in the first place. A fence nobody tests is
// a fence that gets tidied away.
//
// One test per table, driven as the bootstrap superuser, because the claim
// `0011` makes is *"refused at every privilege level"* — a row-level trigger
// fires for whoever is connected, where a policy is not evaluated for a
// superuser at all.
//
// `TRUNCATE` gets its own assertion on every table: it fires no row-level
// trigger, so without the statement-level one a single statement erases the
// authority of every tenant and the UPDATE/DELETE tests would still pass.
// ---------------------------------------------------------------------------

/// Rebuild a stored `draw` grant's signed bytes, the way the server does at
/// use — needed because a seconding, a suspension and a revocation all sign
/// over `H(grant_bytes)`.
async fn draw_grant_bytes(
    tx: &deadpool_postgres::Transaction<'_>,
    organisation: &str,
    root_fpr: &[u8; 32],
    subject: &str,
    grant_id: &str,
) -> Vec<u8> {
    use fathom_server::authority::{self, Capability, GrantFacts};

    let row = tx
        .query_one(
            "SELECT subject_key_fpr, granter_key_fpr, granted_by, auth_epoch, \
                    EXTRACT(EPOCH FROM effective_from)::bigint, \
                    COALESCE(EXTRACT(EPOCH FROM expires_at)::bigint, 0) \
               FROM scope_grants WHERE id = $1",
            &[&grant_id],
        )
        .await
        .expect("the grant");
    let subject_fpr: Vec<u8> = row.get(0);
    let granter_fpr: Vec<u8> = row.get(1);
    let granted_by: Option<String> = row.get(2);
    authority::grant_bytes(&GrantFacts {
        organisation,
        root_pubkey_fpr: root_fpr,
        scope: "",
        subject,
        subject_key_fpr: &subject_fpr.try_into().expect("32 bytes"),
        capability: Capability::Draw,
        granter: granted_by.as_deref(),
        granter_key_fpr: &granter_fpr.try_into().expect("32 bytes"),
        effective_from_unix: row.get(4),
        expires_at_unix: row.get(5),
        // A `draw` grant never takes §3.5's sole-steward path.
        sole_steward_appointment: false,
        auth_epoch: row.get(3),
    })
}

/// One bootstrapped organisation with a row in each of the five authority
/// tables, written through the real signing paths so that what these tests
/// fail to delete is genuinely sealed.
///
/// Returns the organisation id and the two grant ids the acts were made
/// against.
async fn an_authority_with_every_row_class() -> (String, String) {
    use fathom_server::authority::{self, Capability, SoftwareKey};
    use fathom_server::crypto::Key32;
    use fathom_server::grants::{self, Authority, EpochWatch, GenesisGrant, GrantRequest};
    use fathom_server::keys::{self, KeyRing};
    use fathom_server::repo;

    let pool = support::migrated_pool().await;
    let ring = KeyRing::from_keys(Key32::from_bytes([21; 32]), Key32::from_bytes([92; 32]));

    let stamp = id();
    let root = SoftwareKey::random().expect("root key");
    let salt = [0x5au8; 16];
    let organisation_id = authority::derive_organisation_id(&root.public_key(), &salt);
    let root_fpr = authority::key_fingerprint(&root.public_key());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    // Two genesis stewards, so a seconding is possible at all.
    let mut stewards = Vec::new();
    for n in 0..2 {
        let account = repo::create_account(
            &pool,
            &format!("fence-{stamp}-{n}@example.test"),
            &format!("Fence {n}"),
        )
        .await
        .expect("account")
        .id;
        stewards.push((account, SoftwareKey::random().expect("key")));
    }

    let requests: Vec<GenesisGrant> = stewards
        .iter()
        .map(|(account, key)| {
            let subject_key_fpr = authority::key_fingerprint(&key.public_key());
            let facts = fathom_server::authority::GrantFacts {
                organisation: &organisation_id,
                root_pubkey_fpr: &root_fpr,
                scope: "",
                subject: &account.to_string(),
                subject_key_fpr: &subject_key_fpr,
                capability: Capability::Steward,
                granter: None,
                granter_key_fpr: &root_fpr,
                effective_from_unix: now,
                expires_at_unix: now + 365 * 24 * 3600,
                sole_steward_appointment: false,
                auth_epoch: 1,
            };
            GenesisGrant {
                subject: *account,
                subject_key_fpr,
                capability: Capability::Steward,
                effective_from_unix: now,
                expires_at_unix: now + 365 * 24 * 3600,
                signature: root.sign(&authority::grant_bytes(&facts)),
            }
        })
        .collect();

    let mut conn = pool.get().await.expect("connection");
    let tx = conn.transaction().await.expect("begin");
    let genesis = grants::bootstrap_organisation(
        &tx,
        &ring,
        stewards[0].0,
        &format!("Fence Org {stamp}"),
        &root.public_key(),
        &salt,
        &requests,
    )
    .await
    .expect("genesis");
    tx.commit().await.expect("commit");

    // Enrol both stewards' keys, and a subject's.
    let subject = repo::create_account(
        &pool,
        &format!("fence-{stamp}-subject@example.test"),
        "Fence Subject",
    )
    .await
    .expect("account")
    .id;
    let subject_key = SoftwareKey::random().expect("key");

    for (account, key) in stewards
        .iter()
        .map(|(a, k)| (*a, k))
        .chain(std::iter::once((subject, &subject_key)))
    {
        if account != stewards[0].0 {
            repo::add_member(
                &pool,
                genesis.organisation,
                stewards[0].0,
                account,
                repo::Role::Member,
            )
            .await
            .expect("membership");
        }
        let tx = conn.transaction().await.expect("begin");
        let ctx = repo::open_tenant_context(&tx, genesis.organisation, account)
            .await
            .expect("context");
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
        grants::enrol_software_key(&tx, &auth, &key.public_key())
            .await
            .expect("enrol");
        tx.commit().await.expect("commit");
    }

    // Two draw grants: one to second and suspend, one to revoke.
    let mut written = Vec::new();
    for _ in 0..2 {
        let tx = conn.transaction().await.expect("begin");
        let ctx = repo::open_tenant_context(&tx, genesis.organisation, stewards[0].0)
            .await
            .expect("context");
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
        let proposal = grants::propose_grant(
            &tx,
            &auth,
            &GrantRequest {
                scope: None,
                subject,
                capability: Capability::Draw,
                expires_at_unix: now + 3600,
            },
        )
        .await
        .expect("propose");
        let signature = stewards[0].1.sign(&proposal.bytes);
        written.push(
            grants::sign_grant(&tx, &auth, &proposal, &signature)
                .await
                .expect("sign"),
        );
        tx.commit().await.expect("commit");
    }

    // A seconding and a suspension on the first, a revocation on the second.
    {
        let tx = conn.transaction().await.expect("begin");
        let ctx = repo::open_tenant_context(&tx, genesis.organisation, stewards[1].0)
            .await
            .expect("context");
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
        let bytes = draw_grant_bytes(
            &tx,
            &organisation_id,
            &root_fpr,
            &subject.to_string(),
            &written[0],
        )
        .await;
        let granter_fpr = authority::key_fingerprint(&stewards[0].1.public_key());
        let signature = stewards[1]
            .1
            .sign(&authority::second_bytes(&bytes, &granter_fpr));
        grants::second_grant(&tx, &auth, &written[0], &signature)
            .await
            .expect("second");
        tx.commit().await.expect("commit");
    }

    {
        let tx = conn.transaction().await.expect("begin");
        let ctx = repo::open_tenant_context(&tx, genesis.organisation, stewards[0].0)
            .await
            .expect("context");
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
        let bytes = draw_grant_bytes(
            &tx,
            &organisation_id,
            &root_fpr,
            &subject.to_string(),
            &written[0],
        )
        .await;
        let signature = stewards[0].1.sign(&authority::suspend_bytes(
            &organisation_id,
            &written[0],
            &bytes,
            now,
        ));
        grants::set_suspension(&tx, &auth, &written[0], true, &signature, now)
            .await
            .expect("suspend");

        let bytes = draw_grant_bytes(
            &tx,
            &organisation_id,
            &root_fpr,
            &subject.to_string(),
            &written[1],
        )
        .await;
        let signature = stewards[0].1.sign(&authority::revoke_bytes(
            &organisation_id,
            &written[1],
            &bytes,
            now,
        ));
        grants::revoke_grant(&tx, &auth, &written[1], &signature, now)
            .await
            .expect("revoke");
        tx.commit().await.expect("commit");
    }

    (organisation_id, written[0].clone())
}

/// Every authority table, every route, as the superuser.
///
/// One test rather than fifteen: the fixture is expensive and the assertion is
/// identical, so splitting it would buy nothing but runtime. Each failure
/// names its table and its verb.
#[tokio::test]
async fn a_superuser_cannot_rewrite_erase_or_truncate_any_authority_table() {
    let (organisation, grant) = an_authority_with_every_row_class().await;
    let client = support::superuser_client_on_test_database().await;

    // Positive control first: every table really does hold a row, so a refusal
    // below cannot be a row-level trigger simply never firing.
    for table in [
        "organisation_roots",
        "scope_grants",
        "grant_secondings",
        "grant_suspensions",
        "grant_revocations",
    ] {
        let count: i64 = client
            .query_one(
                &format!("SELECT count(*) FROM {table} WHERE organisation_id = $1"),
                &[&organisation],
            )
            .await
            .expect("count")
            .get(0);
        assert!(
            count >= 1,
            "{table} must hold a row for this fence to be under test at all -- a \
             BEFORE ... FOR EACH ROW trigger on an empty table refuses nothing and looks \
             identical"
        );
    }

    // UPDATE and DELETE, per table. The column written is one the seal covers,
    // so this is the attack rather than a no-op.
    for (table, update) in [
        (
            "organisation_roots",
            "UPDATE organisation_roots SET row_seal = $2 WHERE organisation_id = $1",
        ),
        (
            "scope_grants",
            "UPDATE scope_grants SET capability = 'steward' WHERE organisation_id = $1",
        ),
        (
            "grant_secondings",
            "UPDATE grant_secondings SET row_seal = $2 WHERE organisation_id = $1",
        ),
        (
            "grant_suspensions",
            "UPDATE grant_suspensions SET action = 'unsuspend' WHERE organisation_id = $1",
        ),
        (
            "grant_revocations",
            "UPDATE grant_revocations SET row_seal = $2 WHERE organisation_id = $1",
        ),
    ] {
        let err = if update.contains("$2") {
            client
                .execute(update, &[&organisation, &vec![0u8; 32]])
                .await
        } else {
            client.execute(update, &[&organisation]).await
        }
        .expect_err(&format!(
            "{table}: rewriting a sealed authority row must be refused for EVERY role -- a \
             policy is not evaluated for this one at all"
        ));
        assert_refused_by_the_trigger(&err, &format!("UPDATE {table}"));

        let err = client
            .execute(
                &format!("DELETE FROM {table} WHERE organisation_id = $1"),
                &[&organisation],
            )
            .await
            .expect_err(&format!(
                "{table}: deleting a sealed authority row must be refused for every role"
            ));
        assert_refused_by_the_trigger(&err, &format!("DELETE {table}"));

        // TRUNCATE -- the route a row-level trigger does not cover at all.
        let err = client
            .batch_execute(&format!("TRUNCATE {table} CASCADE"))
            .await
            .expect_err(&format!(
                "{table}: TRUNCATE fires no row-level trigger, so without its own \
                 statement-level trigger one statement erases the authority of every tenant"
            ));
        assert_refused_by_the_trigger(&err, &format!("TRUNCATE {table}"));
    }

    // And the keyring, whose trigger says something narrower: UPDATE is
    // allowed for supersession and retirement only, DELETE and TRUNCATE never.
    let err = client
        .execute(
            "UPDATE account_keys SET public_key = $1 WHERE id IN \
                 (SELECT id FROM account_keys LIMIT 1)",
            &[&vec![4u8; 65]],
        )
        .await
        .expect_err("swapping a keyring public key is the attack the keyring exists to refuse");
    assert_eq!(
        err.code(),
        Some(&SqlState::RAISE_EXCEPTION),
        "the keyring's own trigger must raise: {err}"
    );

    let err = client
        .execute("DELETE FROM account_keys", &[])
        .await
        .expect_err("the keyring is append-only");
    assert_eq!(err.code(), Some(&SqlState::RAISE_EXCEPTION), "{err}");

    let err = client
        .batch_execute("TRUNCATE account_keys CASCADE")
        .await
        .expect_err("the keyring is append-only");
    assert_refused_by_the_trigger(&err, "TRUNCATE account_keys");

    // The positive control at the end: the rows are all still there.
    let count: i64 = client
        .query_one(
            "SELECT count(*) FROM scope_grants WHERE organisation_id = $1",
            &[&organisation],
        )
        .await
        .expect("count")
        .get(0);
    assert!(count >= 3, "grant {grant}: the authority survived intact");
}
