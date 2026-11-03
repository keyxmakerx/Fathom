//! The system account (migration `0074`, sign-off r107): the one honest actor
//! for a change the server makes itself, never the account of whoever caused it.
//!
//! It is an `accounts` row only because history names accounts. It is never a
//! principal, holds no credential, and the database refuses it everywhere a
//! session, grant, team seat, role, signature or credential would name it.
//! These functions are the same refusal said again in the server, by name, on
//! every sign-in, token and AI-connection path, so neither layer is the only one.

use std::str::FromStr;

use crate::repo::AccountId;

/// The reserved id, as `0074` inserts it.
pub const SYSTEM_ACCOUNT_ID: &str = "0000000000000000000000SYST";

/// The name history shows for it, as `0074` inserts it.
pub const SYSTEM_ACCOUNT_NAME: &str = "Fathom (system change)";

/// The system account's id.
pub fn system_account() -> AccountId {
    AccountId::from_str(SYSTEM_ACCOUNT_ID).expect("the reserved id is a ULID")
}

/// Whether `id` (an account id as text) is the system account.
pub fn is_system(id: &str) -> bool {
    id == SYSTEM_ACCOUNT_ID
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reserved_id_parses_and_matches_the_migration() {
        assert_eq!(system_account().to_string(), SYSTEM_ACCOUNT_ID);
        let sql = include_str!("../migrations/0074_system_account.sql");
        assert!(sql.contains(&format!("'{SYSTEM_ACCOUNT_ID}'")));
        assert!(sql.contains(&format!("'{SYSTEM_ACCOUNT_NAME}'")));
    }
}
