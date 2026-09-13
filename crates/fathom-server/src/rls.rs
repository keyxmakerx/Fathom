//! Refusing to start if the server's own database role would make row-level
//! security a no-op.
//!
//! `migrations/0002_identity_and_scope.sql` enables row-level security and
//! `FORCE`s it on every tenant-scoped table, but that migration's own header
//! says plainly what `FORCE` cannot do: **it does not bind for an actual
//! PostgreSQL superuser, or for a role carrying `BYPASSRLS`** -- Postgres
//! exempts both unconditionally, `FORCE` or not. Found 2026-09-12:
//! `deploy/compose.yaml` started PostgreSQL with the image's bootstrap role,
//! which the official image always makes a superuser regardless of the name
//! given it, so every isolation policy migration 0002 defines was inert in
//! the shipped deployment while the tests -- which provision a restricted
//! role deliberately -- kept passing. A warning in a log nobody reads is how
//! that survives; refusing to start is the only shape that does not.
//!
//! So this is a startup gate with the same shape as
//! `engine::EngineState::load`'s schema gate: ask the database what role we
//! actually connected as -- never a value this process brought with it --
//! and refuse if it would bypass row-level security.

use tokio_postgres::Client;

/// Why the server refuses to start.
#[derive(Debug, PartialEq, Eq)]
pub enum RlsError {
    /// The role this connection authenticated as is a PostgreSQL superuser,
    /// which bypasses row-level security unconditionally, `FORCE` or not.
    Superuser,
    /// The role carries `BYPASSRLS`, which bypasses row-level security the
    /// same way superuser status does, without being a superuser.
    BypassRls,
    /// The check itself could not run -- a role or a permission so unusual
    /// that `pg_roles` could not be read is not a role this server should
    /// trust either.
    Query,
}

impl core::fmt::Display for RlsError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Superuser => f.write_str(
                "the database role this server connected as is a PostgreSQL superuser. A \
                 superuser bypasses row-level security unconditionally, so every tenant-isolation \
                 policy in migrations/0002_identity_and_scope.sql is inert for this connection. \
                 Connect as a non-superuser role instead -- see deploy/compose.yaml for how the \
                 shipped deployment provisions one.",
            ),
            Self::BypassRls => f.write_str(
                "the database role this server connected as carries BYPASSRLS, which bypasses \
                 row-level security exactly like superuser status does. Connect as a role \
                 without BYPASSRLS instead.",
            ),
            Self::Query => f.write_str(
                "could not ask the database whether the connected role bypasses row-level \
                 security. Refusing to start rather than assuming the answer is no.",
            ),
        }
    }
}

impl std::error::Error for RlsError {}

/// Ask the database what the connected role actually is, and refuse if it
/// would make row-level security inert.
///
/// **This does not inspect the policies themselves** -- migration 0002 owns
/// that -- it checks the one precondition that makes every policy
/// meaningless regardless of how it is written: `current_user`'s `rolsuper`
/// and `rolbypassrls` bits, read fresh from `pg_roles` on every call, never
/// assumed from configuration.
///
/// **Takes a concrete `tokio_postgres::Client`, not a generic trait bound.**
/// A pooled connection (`deadpool_postgres::Object`) derefs down to this same
/// type, so the call site coerces automatically -- exactly how
/// `migrate::run` already takes its client.
pub async fn assert_rls_binds(client: &Client) -> Result<(), RlsError> {
    let row = client
        .query_one(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
            &[],
        )
        .await
        .map_err(|_| RlsError::Query)?;

    let is_superuser: bool = row.try_get(0).map_err(|_| RlsError::Query)?;
    let bypasses_rls: bool = row.try_get(1).map_err(|_| RlsError::Query)?;

    if is_superuser {
        return Err(RlsError::Superuser);
    }
    if bypasses_rls {
        return Err(RlsError::BypassRls);
    }
    Ok(())
}
