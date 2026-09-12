//! The gate that notices an applied migration having been edited, and the
//! bookkeeping that says whether anything was applied at all.
//!
//! Both are about `src/migrate.rs`'s record of what it already did, which is
//! why they live in one file and in one test: this test deliberately corrupts
//! that record and puts it back, so nothing else may be migrating the same
//! database while it does. It holds `migrate::MIGRATION_LOCK_KEY` -- the lock
//! `migrate::run` itself takes -- on the very connection it then calls `run`
//! with. `pg_advisory_lock` is session-level and re-entrant, so `run`'s own
//! acquisition on that same session succeeds immediately while every OTHER
//! session's waits, which is exactly the serialisation this needs.

mod support;

use fathom_server::migrate::{self, MigrateError};

#[tokio::test]
async fn an_edited_migration_is_refused_and_an_unedited_one_applies_nothing() {
    let pool = support::migrated_pool().await;
    let mut client = pool.get().await.expect("connection");

    client
        .execute(
            "SELECT pg_advisory_lock($1)",
            &[&migrate::MIGRATION_LOCK_KEY],
        )
        .await
        .expect("take the migration lock for the duration of this test");

    // 1. An already-migrated database applies NOTHING. Migration 1 used to be
    //    re-executed and re-counted on every call, so this was never `Ok(0)`
    //    and the server logged "migrations applied" on every start.
    let already_current = migrate::run(&mut client).await;

    // 2. Now the edit. Corrupting the RECORDED checksum while leaving
    //    `byte_len` alone is precisely an edit to the migration file that
    //    preserved its length -- the case a length-only comparison cannot
    //    see, and the reason the checksum column exists.
    let row = client
        .query_one(
            "SELECT byte_len, checksum FROM _fathom_migrations WHERE version = 2",
            &[],
        )
        .await
        .expect("migration 2 must be recorded as applied");
    let original_len: i32 = row.get(0);
    let original_checksum: i64 = row.get(1);
    client
        .execute(
            "UPDATE _fathom_migrations SET checksum = $1 WHERE version = 2",
            &[&original_checksum.wrapping_add(1)],
        )
        .await
        .expect("corrupt the recorded checksum");

    let after_edit = migrate::run(&mut client).await;
    let len_after_edit: i32 = client
        .query_one(
            "SELECT byte_len FROM _fathom_migrations WHERE version = 2",
            &[],
        )
        .await
        .expect("read byte_len back")
        .get(0);

    // Put it back BEFORE asserting anything, so a failing assertion leaves a
    // usable database behind rather than one every later run refuses.
    client
        .execute(
            "UPDATE _fathom_migrations SET checksum = $1 WHERE version = 2",
            &[&original_checksum],
        )
        .await
        .expect("restore the recorded checksum");
    let after_restore = migrate::run(&mut client).await;

    client
        .execute(
            "SELECT pg_advisory_unlock($1)",
            &[&migrate::MIGRATION_LOCK_KEY],
        )
        .await
        .expect("release the migration lock");

    assert!(
        matches!(already_current, Ok(0)),
        "an already-migrated database must apply nothing: {already_current:?}"
    );

    assert_eq!(
        len_after_edit, original_len,
        "this test's own premise: the length must be unchanged, so that only the checksum can \
         be what detects the edit"
    );
    match after_edit {
        Err(MigrateError::Changed {
            version,
            recorded_len,
            embedded_len,
            recorded_checksum,
            embedded_checksum,
        }) => {
            assert_eq!(version, 2);
            assert_eq!(
                recorded_len, embedded_len,
                "the lengths agree -- the checksum is what caught it"
            );
            assert_ne!(recorded_checksum, embedded_checksum);
        }
        other => panic!("an edited migration must be refused, got: {other:?}"),
    }

    assert!(
        matches!(after_restore, Ok(0)),
        "with the record restored, migrations must apply nothing again: {after_restore:?}"
    );
}
