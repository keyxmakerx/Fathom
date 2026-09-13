//! Proves the migration/runtime role split actually binds, against a real
//! PostgreSQL -- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §15.0, deliverable
//! 3: *"a split that is only a naming convention is worth nothing."*
//!
//! `support::migrated_pool()` now hands back a pool connected as the RUNTIME
//! role -- `fathom_app`, the same name in this crate's tests and in the
//! shipped deployment; only the migration role's name differs between them
//! (see `tests/support/mod.rs`'s own header). Every
//! assertion below runs on that connection, unmodified, exactly as
//! `src/db.rs::pool` builds it for the running server. There is no `SET
//! ROLE`, no probe policy and no rolled-back grant here, unlike
//! `tests/planes.rs`'s treatment of `fathom_operator` -- `fathom_app` is a
//! real, connectable, `LOGIN` role by the time this file runs, so what is
//! proved is exactly what a request handler would see.

mod support;

use tokio_postgres::error::SqlState;

/// The server's own message for a failed statement, the same helper
/// `tests/planes.rs` uses and for the same reason: `tokio_postgres::Error`'s
/// own `Display` is just "db error", and the text that distinguishes a
/// privilege refusal from anything else lives on the `DbError` underneath.
fn database_message(err: &tokio_postgres::Error) -> String {
    err.as_db_error()
        .map(|e| e.message().to_string())
        .unwrap_or_else(|| format!("{err}"))
}

/// **The wording differs by refusal shape, and that is worth checking, not
/// papering over.** PostgreSQL refuses `CREATE TABLE` on a schema without
/// `CREATE`, and `CREATE ROLE` without `CREATEROLE`, with "permission
/// denied"; it refuses `ALTER TABLE`/`DROP TABLE` on a relation this role
/// does not own with "must be owner of ..." instead -- same `SQLSTATE`
/// (`42501`, `INSUFFICIENT_PRIVILEGE`), different sentence. Asserting the
/// SQLSTATE alone would pass even if the statement failed for some unrelated
/// reason with the same code; asserting the exact wording this connection
/// actually gets back is what makes each test check the refusal it claims to.
fn assert_insufficient_privilege(err: &tokio_postgres::Error, expect_substring: &str, what: &str) {
    assert_eq!(
        err.code(),
        Some(&SqlState::INSUFFICIENT_PRIVILEGE),
        "{what}: expected INSUFFICIENT_PRIVILEGE, got: {err}"
    );
    let message = database_message(err);
    assert!(
        message.contains(expect_substring),
        "{what}: expected {expect_substring:?} in the refusal, got: {message}"
    );
}

#[tokio::test]
async fn the_runtime_role_cannot_create_a_table() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");
    let err = client
        .batch_execute("CREATE TABLE runtime_role_split_probe (id text)")
        .await
        .expect_err(
            "the runtime role holds USAGE on schema public, not CREATE -- a table it could \
             create is a schema it could reshape",
        );
    assert_insufficient_privilege(&err, "permission denied", "CREATE TABLE");
}

#[tokio::test]
async fn the_runtime_role_cannot_drop_a_table() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");
    let err = client
        .batch_execute("DROP TABLE organisations")
        .await
        .expect_err(
            "the runtime role does not own any table -- the migration role does -- so it holds \
             no DROP privilege on one",
        );
    assert_insufficient_privilege(&err, "must be owner", "DROP TABLE");
}

#[tokio::test]
async fn the_runtime_role_cannot_alter_a_table() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");
    let err = client
        .batch_execute("ALTER TABLE organisations ADD COLUMN runtime_role_split_probe text")
        .await
        .expect_err(
            "ALTER TABLE needs ownership (or an explicit grant this role never receives), \
             exactly like DROP TABLE",
        );
    assert_insufficient_privilege(&err, "must be owner", "ALTER TABLE");
}

#[tokio::test]
async fn the_runtime_role_cannot_create_a_role() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");
    let err = client
        .batch_execute("CREATE ROLE runtime_role_split_probe")
        .await
        .expect_err(
            "CREATEROLE stays on the migration role only -- an injection at runtime must not be \
             able to mint a role",
        );
    assert_insufficient_privilege(&err, "permission denied", "CREATE ROLE");
}

/// A positive control: a test file that only ever refuses is not evidence
/// that it is testing the right connection. The runtime role really can do
/// the data-plane work it exists for.
#[tokio::test]
async fn the_positive_control_the_runtime_role_can_still_read_its_own_tables() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");
    client
        .query("SELECT id FROM organisations", &[])
        .await
        .expect("the runtime role must still be able to SELECT from an application table");
}

/// The other positive control: the MIGRATION role -- the one this file's
/// refusals are contrasted against -- really does still hold every privilege
/// the runtime role above was refused, so the refusals are about the
/// connecting ROLE, not about the statements being malformed.
#[tokio::test]
async fn the_positive_control_the_migration_role_can_still_do_all_four() {
    let _runtime_pool = support::migrated_pool().await;
    let pool = support::migration_pool().await;
    let mut client = pool.get().await.expect("connection");

    let tx = client.transaction().await.expect("begin");
    tx.batch_execute("CREATE TABLE runtime_role_split_migration_probe (id text)")
        .await
        .expect("the migration role owns this database and may CREATE TABLE");
    tx.batch_execute("ALTER TABLE runtime_role_split_migration_probe ADD COLUMN extra text")
        .await
        .expect("and may ALTER TABLE what it just created");
    tx.batch_execute("DROP TABLE runtime_role_split_migration_probe")
        .await
        .expect("and may DROP TABLE it again");
    tx.batch_execute("CREATE ROLE runtime_role_split_probe NOLOGIN")
        .await
        .expect("and holds CREATEROLE, so it may CREATE ROLE");
    // `CREATE ROLE` is transactional in PostgreSQL like the table DDL above,
    // so rolling back undoes all four -- nothing this test created outlives
    // it.
    tx.rollback().await.expect("rollback");
}
