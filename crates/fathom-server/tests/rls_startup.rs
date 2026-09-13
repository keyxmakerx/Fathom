//! Proves `src/rls.rs`'s startup gate against a real PostgreSQL, both ways:
//! it must refuse a superuser connection, and it must accept the restricted
//! role every other real-database test in this crate already uses.
//!
//! Found 2026-09-12: `deploy/compose.yaml` connected as PostgreSQL's
//! bootstrap role, which the official image always makes a superuser
//! regardless of the name given it, and a superuser bypasses row-level
//! security unconditionally -- `FORCE` or not. So the tenant isolation
//! `migrations/0002_identity_and_scope.sql` builds was inert in the shipped
//! deployment while these tests, which run against a deliberately
//! non-superuser role (`tests/support`), kept passing. This file is what
//! stops that regressing silently: it drives `rls::assert_rls_binds` against
//! both shapes of connection rather than trusting either from memory.

mod support;

use fathom_server::rls::{assert_rls_binds, RlsError};

#[tokio::test]
async fn the_restricted_role_every_other_test_uses_is_accepted() {
    // The same pool `tests/repo.rs` and `tests/no_key_protected_data.rs` run
    // their isolation assertions against. If this role could not pass this
    // check, every isolation assertion those files make would be running
    // against a role that cannot bind RLS either, and this crate's own
    // tests would be lying about what they prove.
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("a connection from the pool");
    assert_eq!(assert_rls_binds(&client).await, Ok(()));
}

#[tokio::test]
async fn a_superuser_connection_is_refused() {
    // `.github/workflows/ci.yml`'s bootstrap `postgres` role, or a local
    // developer's own -- see `tests/support::superuser_database_url`. This is
    // exactly the shape of connection `deploy/compose.yaml` handed the
    // server before this fix: a role a real device -- or a real deployment
    // -- actually starts with, not a contrived one.
    let client = support::superuser_client().await;
    let err = assert_rls_binds(&client)
        .await
        .expect_err("a superuser connection must be refused, not accepted");
    assert_eq!(err, RlsError::Superuser);
}

#[tokio::test]
async fn the_refusal_names_the_reason_without_naming_a_credential() {
    let client = support::superuser_client().await;
    let err = assert_rls_binds(&client).await.unwrap_err();
    let rendered = err.to_string();
    assert!(rendered.contains("superuser"), "{rendered}");
    assert!(!rendered.contains("://"), "{rendered}");
    assert!(!rendered.contains('@'), "{rendered}");
}
