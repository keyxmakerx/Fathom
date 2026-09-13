//! `migrations/0005_planes.sql`, proved against a real PostgreSQL.
//!
//! Two claims, and both are behaviour claims that CLAUDE.md rule 1 forbids
//! asserting from memory:
//!
//! 1. **A withheld `GRANT` is a stronger fence than any policy, because
//!    PostgreSQL checks table privileges before it evaluates row security.**
//!    `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §0 rests the operator plane's
//!    sightlessness on that ordering. It is driven here, not recited.
//! 2. **A `FOR SELECT` policy is not reused as a write check, and a `FOR ALL`
//!    one is.** That is `migrations/0003_write_side_isolation.sql`'s bug, and
//!    §11.1 names the operator plane as the place it would reappear. The test
//!    below removes the privilege fence inside a transaction it rolls back,
//!    so that what it observes is the POLICY layer underneath -- and carries
//!    the positive control showing the same INSERT succeeding once a `FOR
//!    ALL` policy is present.
//!
//! Nothing here connects AS `fathom_operator` over the network: the role is
//! `NOLOGIN` and has no password until the read-only admin pool lands (§1.3).
//! `SET LOCAL ROLE` from a superuser session is how the tests act as it, and
//! it is the honest way round -- after `SET ROLE` the session's user is
//! `fathom_operator`, which is not a superuser, so row security binds. The
//! first test below checks exactly that, because a `SET ROLE` that silently
//! kept superuser status would make every other test in this file vacuous.

mod support;

use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, Transaction};

/// The role `migrations/0005_planes.sql` creates.
const OPERATOR_ROLE: &str = "fathom_operator";

/// Exactly what the operator plane may read, and nothing else.
///
/// **This is the fence, written down.** §1.3's sightlessness rests on the
/// absence of a privilege, not on a policy -- so this list is checked against
/// every table in the live schema, not against the ones someone remembered.
/// A design payload table added next year is granted nothing by PostgreSQL
/// when it is created, so it fails this test the day it appears unless
/// somebody deliberately adds it here and defends it.
/// `chain_entries` joined with `migrations/0009_chains_at_three_levels.sql`
/// and it is the one addition that has to be argued rather than noted. An
/// operator who cannot read the audit trail cannot do the job the audit trail
/// exists for -- §1.3's sightlessness is about design DATA. A chain entry is
/// MAC tags, a sequence number and an entry type, plus a `metadata` column
/// that on the organisation and site chains is ciphertext this role holds no
/// key for. §11.2 keys `content_hash` precisely so that holding one is not a
/// confirmation oracle against a guessed payload.
///
/// **The five authority tables joined with `migrations/0011_authority.sql`,
/// and they are §1.1's first verb made reachable**: *"list organisations,
/// their scope tree shape, members, GRANTS AND CAPABILITY MAP"*. §1.3's own
/// `GRANT` list names `scope_grants` and `grant_revocations` explicitly;
/// secondings, suspensions and the head are the same map in three more rows,
/// and an operator who may suspend a grant (§1.1) but cannot see whether it is
/// suspended has been given a verb with no way to check it.
///
/// **`account_keys` is NOT here and must not be**: §1.3 revokes it by name.
/// Neither is `organisation_roots`, which no §1.1 verb needs and which is the
/// one table binding an organisation's identity to a key.
const OPERATOR_MAY_SELECT: &[&str] = &[
    "organisations",
    "scopes",
    "memberships",
    "accounts",
    "operators",
    "chain_entries",
    "scope_grants",
    "grant_secondings",
    "grant_suspensions",
    "grant_revocations",
    "organisation_auth_head",
];

/// Every privilege that is not `SELECT`. The operator plane holds none of
/// these on any table: §1.3, "No INSERT, UPDATE or DELETE on anything, for
/// any table, ever."
const WRITE_PRIVILEGES: &[&str] = &["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES"];

/// The server's own message for a failed statement.
///
/// `tokio_postgres::Error` renders as the bare string "db error"; which LAYER
/// refused a statement is only legible in the `DbError` underneath, and these
/// tests turn on exactly that distinction.
fn database_message(err: &tokio_postgres::Error) -> String {
    err.as_db_error()
        .map(|e| e.message().to_string())
        .unwrap_or_else(|| format!("{err}"))
}

fn id() -> String {
    fathom_server::ids::new_ulid().to_string()
}

async fn migrated_then_superuser() -> Client {
    let _pool = support::migrated_pool().await;
    support::superuser_client_on_test_database().await
}

/// A steward account and an organisation, so that an attempted membership
/// INSERT fails for the reason under test rather than on a foreign key.
async fn a_steward_and_an_organisation(client: &Transaction<'_>) -> (String, String) {
    let steward = id();
    client
        .execute(
            "INSERT INTO principals (id, kind) VALUES ($1, 'steward')",
            &[&steward],
        )
        .await
        .expect("insert principal");
    client
        .execute(
            "INSERT INTO accounts (id, email, display_name) VALUES ($1, $2, 'A Person')",
            &[&steward, &format!("{steward}@example.test")],
        )
        .await
        .expect("insert account");
    let org = id();
    client
        .execute(
            "INSERT INTO organisations (id, display_name) VALUES ($1, 'Planes Ltd')",
            &[&org],
        )
        .await
        .expect("insert organisation");
    (steward, org)
}

#[tokio::test]
async fn acting_as_the_operator_role_really_does_drop_superuser_and_bind_row_security() {
    // The precondition every other test in this file depends on. If `SET
    // LOCAL ROLE` left the session exempt from row security, the refusals
    // below would still be observed -- from the privilege layer -- and the
    // policy half of this file would prove nothing.
    let mut client = migrated_then_superuser().await;
    let tx = client.transaction().await.expect("begin");
    tx.batch_execute(&format!("SET LOCAL ROLE {OPERATOR_ROLE}"))
        .await
        .expect("set role");

    let row = tx
        .query_one(
            "SELECT current_user::text, \
                    (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), \
                    (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)",
            &[],
        )
        .await
        .expect("ask the database who we are");
    assert_eq!(row.get::<_, String>(0), OPERATOR_ROLE);
    assert!(!row.get::<_, bool>(1), "the operator role is a superuser");
    assert!(
        !row.get::<_, bool>(2),
        "the operator role carries BYPASSRLS"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn the_operator_role_cannot_be_connected_to_at_all_yet() {
    // `NOLOGIN`, no password. §1.3's admin pool lands with the admin surface;
    // until then the role exists so that the grants and policies can be
    // written and held to a rule, and nothing can authenticate as it.
    let client = migrated_then_superuser().await;
    let row = client
        .query_one(
            "SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb \
             FROM pg_roles WHERE rolname = $1",
            &[&OPERATOR_ROLE],
        )
        .await
        .expect("the operator role must exist after the migrations run");
    for (index, attribute) in ["LOGIN", "SUPERUSER", "BYPASSRLS", "CREATEROLE", "CREATEDB"]
        .iter()
        .enumerate()
    {
        assert!(
            !row.get::<_, bool>(index),
            "the operator role carries {attribute}"
        );
    }
}

#[tokio::test]
async fn the_operator_plane_may_read_exactly_the_allowlist_and_write_none() {
    let client = migrated_then_superuser().await;

    let tables: Vec<String> = client
        .query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
            &[],
        )
        .await
        .expect("list tables")
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert!(!tables.is_empty(), "no tables is not a passing state");

    let mut readable = Vec::new();
    for table in &tables {
        let qualified = format!("public.{table}");
        let row = client
            .query_one(
                "SELECT has_table_privilege($1, $2, 'SELECT')",
                &[&OPERATOR_ROLE, &qualified],
            )
            .await
            .expect("ask for the SELECT privilege");
        if row.get::<_, bool>(0) {
            readable.push(table.clone());
        }

        for privilege in WRITE_PRIVILEGES {
            let row = client
                .query_one(
                    "SELECT has_table_privilege($1, $2, $3)",
                    &[&OPERATOR_ROLE, &qualified, privilege],
                )
                .await
                .expect("ask for a write privilege");
            assert!(
                !row.get::<_, bool>(0),
                "the operator plane holds {privilege} on {table}. §1.3: no INSERT, UPDATE or \
                 DELETE on anything, for any table, ever -- an earlier draft that granted one \
                 handed a tier-2 attacker every two-operator control in the design."
            );
        }
    }

    let mut expected: Vec<String> = OPERATOR_MAY_SELECT.iter().map(|s| s.to_string()).collect();
    expected.sort();
    readable.sort();
    assert_eq!(
        readable, expected,
        "the operator plane's readable set has changed. If a new table holds design payload, a \
         credential or a wrapped key, it must NOT be here -- §1.3's whole claim is that an \
         operator is sightless."
    );
}

#[tokio::test]
async fn a_privilege_the_operator_plane_lacks_is_refused_even_with_a_policy_that_would_allow_it() {
    // Claim 1: privileges are checked BEFORE row security. `principals` is
    // deliberately not granted to the operator plane. Give it a policy that
    // says `USING (true)` for that role -- inside a transaction that is then
    // rolled back -- and the read is still refused, because the policy is
    // never reached.
    let mut client = migrated_then_superuser().await;
    let tx = client.transaction().await.expect("begin");
    tx.batch_execute(&format!(
        "CREATE POLICY principals_probe ON principals FOR SELECT TO {OPERATOR_ROLE} \
         USING (true); SET LOCAL ROLE {OPERATOR_ROLE}"
    ))
    .await
    .expect("create the probe policy and become the operator role");

    let err = tx
        .query("SELECT id FROM principals", &[])
        .await
        .expect_err("no SELECT privilege on `principals` means no read, policy or not");
    assert_eq!(
        err.code(),
        Some(&SqlState::INSUFFICIENT_PRIVILEGE),
        "got: {err}"
    );
    // `tokio_postgres::Error`'s own Display is just "db error" -- the server's
    // text is on the `DbError` underneath, and that text is what distinguishes
    // the privilege layer from the policy layer.
    let message = database_message(&err);
    assert!(
        message.contains("permission denied"),
        "the refusal came from somewhere other than the privilege layer: {message}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn an_operator_transaction_cannot_insert_a_membership() {
    // Claim 2, and the test §11.1 asks for by name.
    //
    // The privilege fence alone would refuse this, which is why the test
    // REMOVES it: `GRANT INSERT` inside a transaction that is rolled back, so
    // the refusal observed can only have come from the policy layer. If
    // `memberships_readable_by_operator_plane` were ever written `FOR ALL`,
    // its `USING (true)` would be reused as the write check and this INSERT
    // would succeed -- which is exactly 0003's bug with a new name.
    let mut client = migrated_then_superuser().await;
    let tx = client.transaction().await.expect("begin");
    let (steward, org) = a_steward_and_an_organisation(&tx).await;

    tx.batch_execute(&format!(
        "GRANT INSERT ON memberships TO {OPERATOR_ROLE}; SET LOCAL ROLE {OPERATOR_ROLE}"
    ))
    .await
    .expect("grant and become the operator role");

    let err = tx
        .execute(
            "INSERT INTO memberships (account_id, organisation_id, role) \
             VALUES ($1, $2, 'admin')",
            &[&steward, &org],
        )
        .await
        .expect_err("an operator granting itself authority is the takeover this design refuses");
    assert_eq!(
        err.code(),
        Some(&SqlState::INSUFFICIENT_PRIVILEGE),
        "got: {err}"
    );
    let message = database_message(&err);
    assert!(
        message.contains("row-level security policy"),
        "the privilege was granted for this test, so the refusal had to come from the policy \
         layer; instead: {message}"
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn the_positive_control_a_for_all_policy_would_have_let_that_insert_through() {
    // A test that can only ever pass is not evidence. This drives the SAME
    // statement against the SAME schema with one difference -- a `FOR ALL`
    // policy for the operator role -- and it succeeds. That is the defect
    // `migrations/0003_write_side_isolation.sql` was written to fix,
    // reproduced here so that the test above is known to be able to fail.
    let mut client = migrated_then_superuser().await;
    let tx = client.transaction().await.expect("begin");
    let (steward, org) = a_steward_and_an_organisation(&tx).await;

    tx.batch_execute(&format!(
        "GRANT INSERT ON memberships TO {OPERATOR_ROLE}; \
         CREATE POLICY memberships_for_all_probe ON memberships TO {OPERATOR_ROLE} \
         USING (true); \
         SET LOCAL ROLE {OPERATOR_ROLE}"
    ))
    .await
    .expect("grant, add a FOR ALL policy, and become the operator role");

    tx.execute(
        "INSERT INTO memberships (account_id, organisation_id, role) VALUES ($1, $2, 'admin')",
        &[&steward, &org],
    )
    .await
    .expect(
        "with a FOR ALL policy PostgreSQL reuses USING as the write check -- if this ever fails, \
         the test above has stopped proving anything and both need rereading",
    );
    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn every_operator_plane_policy_is_for_select_and_states_no_write_rule() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");

    let rows = client
        .query(
            "SELECT tablename, policyname, cmd, roles::text[], with_check IS NOT NULL \
             FROM pg_policies \
             WHERE schemaname = 'public' AND policyname LIKE '%_by_operator_plane' \
             ORDER BY tablename",
            &[],
        )
        .await
        .expect("read pg_policies");

    let tables: Vec<String> = rows.iter().map(|r| r.get(0)).collect();
    let mut expected: Vec<String> = OPERATOR_MAY_SELECT.iter().map(|s| s.to_string()).collect();
    expected.sort();
    let mut seen = tables.clone();
    seen.sort();
    assert_eq!(
        seen, expected,
        "there must be exactly one operator-plane policy per granted table -- a granted table \
         with no policy reads nothing, and a policy with no grant is a rule nobody needed"
    );

    for row in &rows {
        let table: String = row.get(0);
        let name: String = row.get(1);
        let cmd: String = row.get(2);
        let roles: Vec<String> = row.get(3);
        let has_check: bool = row.get(4);
        assert_eq!(
            cmd, "SELECT",
            "{name} on {table} is `FOR {cmd}`. §11.1: every operator policy is FOR SELECT and \
             never FOR ALL, because a USING clause with no WITH CHECK on a FOR ALL policy is \
             reused as the write check -- 0003's bug with a new name."
        );
        assert!(
            !has_check,
            "{name} states a WITH CHECK, so it governs a write. It must not."
        );
        assert_eq!(
            roles,
            vec![OPERATOR_ROLE.to_string()],
            "{name} is not targeted at the operator role alone: {roles:?}"
        );
    }
}

#[tokio::test]
async fn the_application_plane_does_not_inherit_the_operator_plane_policies() {
    // The failure this rules out would be silent and total: if the role the
    // server connects as counted as a member of `fathom_operator` for the
    // purpose of policy matching, `USING (true)` would hand it every
    // organisation in the estate regardless of tenant context.
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");

    let row = client
        .query_one(
            "SELECT pg_has_role(current_user, $1, 'USAGE')",
            &[&OPERATOR_ROLE],
        )
        .await
        .expect("ask about role privileges");
    assert!(
        !row.get::<_, bool>(0),
        "the application role has the privileges of the operator role, so every operator-plane \
         policy applies to it as well"
    );

    // And the observable consequence, with no tenant context set: zero rows,
    // not "every organisation".
    let rows = client
        .query("SELECT id FROM organisations", &[])
        .await
        .expect("select organisations");
    assert!(
        rows.is_empty(),
        "the application plane read {} organisations with no tenant context set",
        rows.len()
    );
}

#[tokio::test]
async fn the_operator_plane_can_actually_read_what_it_was_granted() {
    // Without this, every refusal above would be satisfied by a role that can
    // do nothing at all, and the admin pages would be unbuildable for a
    // reason nobody had written down.
    let mut client = migrated_then_superuser().await;
    let tx = client.transaction().await.expect("begin");
    let (steward, org) = a_steward_and_an_organisation(&tx).await;
    tx.execute(
        "INSERT INTO memberships (account_id, organisation_id, role) VALUES ($1, $2, 'admin')",
        &[&steward, &org],
    )
    .await
    .expect("insert membership");

    tx.batch_execute(&format!("SET LOCAL ROLE {OPERATOR_ROLE}"))
        .await
        .expect("set role");

    for (table, column, value) in [
        ("organisations", "id", &org),
        ("memberships", "organisation_id", &org),
        ("accounts", "id", &steward),
    ] {
        let rows = tx
            .query(
                &format!("SELECT 1 FROM {table} WHERE {column} = $1"),
                &[value],
            )
            .await
            .unwrap_or_else(|e| panic!("the operator plane must be able to read {table}: {e}"));
        assert_eq!(
            rows.len(),
            1,
            "the operator plane read no row from {table}, so the admin pages would show nothing"
        );
    }
    tx.rollback().await.expect("rollback");
}
