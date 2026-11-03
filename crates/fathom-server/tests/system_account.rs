//! The system account (`migrations/0074_system_account.sql`), proved against a
//! real PostgreSQL as the bootstrap superuser: the refusals are triggers, so
//! they hold for every role, and a handler that forgets cannot grant it
//! anything (sign-off r107).

mod support;

use fathom_server::system_account::{SYSTEM_ACCOUNT_ID, SYSTEM_ACCOUNT_NAME};
use tokio_postgres::error::SqlState;
use tokio_postgres::Client;

async fn migrated_then_superuser() -> Client {
    let _pool = support::migrated_pool().await;
    support::superuser_client_on_test_database().await
}

/// Run `sql` with the system id as `$1` inside a transaction that is always
/// rolled back, and hand back the refusal.
async fn refused(client: &mut Client, sql: &str) -> tokio_postgres::Error {
    let tx = client.transaction().await.expect("begin");
    let err = tx.execute(sql, &[&SYSTEM_ACCOUNT_ID]).await.expect_err(sql);
    tx.rollback().await.ok();
    err
}

#[tokio::test]
async fn the_system_account_exists_once_as_a_steward_principal_with_no_credential() {
    let client = migrated_then_superuser().await;
    let row = client
        .query_one(
            "SELECT a.display_name, p.kind, a.password_hash IS NULL, a.totp_secret_ct IS NULL \
               FROM accounts a JOIN principals p ON p.id = a.id WHERE a.id = $1",
            &[&SYSTEM_ACCOUNT_ID],
        )
        .await
        .expect("the row 0074 made");
    assert_eq!(row.get::<_, String>(0), SYSTEM_ACCOUNT_NAME);
    assert_eq!(row.get::<_, String>(1), "steward");
    assert!(row.get::<_, bool>(2), "no password");
    assert!(row.get::<_, bool>(3), "no second factor");
}

#[tokio::test]
async fn the_system_accounts_rows_are_never_deleted_changed_or_made_again() {
    let mut client = migrated_then_superuser().await;
    for sql in [
        "DELETE FROM accounts WHERE id = $1",
        "DELETE FROM principals WHERE id = $1",
        "UPDATE accounts SET password_hash = 'x' WHERE id = $1",
        "UPDATE accounts SET display_name = 'Someone' WHERE id = $1",
        "UPDATE accounts SET email = 'me@example.org' WHERE id = $1",
        "UPDATE principals SET kind = 'operator' WHERE id = $1",
        "INSERT INTO principals (id, kind) VALUES ($1, 'steward')",
        "INSERT INTO accounts (id, email, display_name) VALUES ($1, 'again@example.org', 'Again')",
    ] {
        let err = refused(&mut client, sql).await;
        assert_eq!(err.code(), Some(&SqlState::CHECK_VIOLATION), "{sql}: {err}");
        assert!(
            format!("{err:?}").contains("the system account"),
            "{sql}: refused by 0074's trigger, got {err:?}"
        );
    }
}

/// Every column 0074 names. A row naming the system account there is refused
/// by the BEFORE trigger, ahead of every NOT NULL, CHECK and foreign key, so a
/// one-column INSERT is enough to reach it; the UPDATE half is the same
/// trigger, and `each_refusal_also_fires_on_update` reads it off the catalogue.
const REFUSED: &[(&str, &str)] = &[
    ("sessions", "principal_id"),
    ("session_nonces", "principal_id"),
    ("memberships", "account_id"),
    ("organisation_invitations", "account_id"),
    ("organisation_invitations", "issued_by"),
    ("organisation_invitations", "closed_by"),
    ("account_keys", "account_id"),
    ("scope_grants", "subject_id"),
    ("scope_grants", "granted_by"),
    ("grant_secondings", "seconded_by"),
    ("grant_suspensions", "actor_id"),
    ("grant_revocations", "revoked_by"),
    ("team_acts", "subject_id"),
    ("team_acts", "signed_by"),
    ("team_role_defs", "signed_by"),
    ("plan_rules", "signed_by"),
    ("backup_codes", "account_id"),
    ("password_reset_tokens", "account_id"),
    ("enrolment_tokens", "account_id"),
    ("operator_account_bindings", "account_id"),
    ("ai_keys", "owner"),
    ("member_termix", "account_id"),
    ("vault.keys", "account_id"),
    ("vault.keys", "created_by"),
    ("vault.entries", "owner"),
    ("vault.entries", "created_by"),
    ("vault.outside_connections", "owner"),
];

#[tokio::test]
async fn no_row_may_name_the_system_account_as_holder_signer_or_grantee() {
    let mut client = migrated_then_superuser().await;
    for (table, col) in REFUSED {
        let short = table.rsplit('.').next().unwrap();
        let sql = format!("INSERT INTO {table} ({col}) VALUES ($1)");
        let err = refused(&mut client, &sql).await;
        let wanted = format!("the system account cannot be in {short}.{col}");
        assert!(
            format!("{err:?}").contains(&wanted),
            "{sql}: expected 0074's refusal, got {err:?}"
        );
        assert_eq!(err.code(), Some(&SqlState::CHECK_VIOLATION), "{sql}");
    }
}

#[tokio::test]
async fn each_refusal_also_fires_on_update() {
    let client = migrated_then_superuser().await;
    for (table, _) in REFUSED {
        let (schema, name) = table.split_once('.').unwrap_or(("public", table));
        let events: i64 = client
            .query_one(
                "SELECT count(*) FROM information_schema.triggers \
                  WHERE event_object_schema = $1 AND event_object_table = $2 \
                    AND trigger_name = $3 AND action_timing = 'BEFORE' \
                    AND event_manipulation IN ('INSERT', 'UPDATE')",
                &[&schema, &name, &format!("{name}_refuse_system_account")],
            )
            .await
            .expect("catalogue")
            .get(0);
        assert_eq!(events, 2, "{table}: BEFORE INSERT and BEFORE UPDATE");
    }
}
