//! Migrations: the machinery for changing the schema, and no schema.
//!
//! **This order applies exactly one migration and it creates the migrations
//! table** (WO-11 §6 G8). See `migrations/0001_migrations_table.sql` for why
//! that is a gate rather than an oversight.
//!
//! # Why the files are embedded rather than read from disk
//!
//! `43` §5.4's container runs with a read-only filesystem. A migration runner
//! that reads a directory at startup either needs that directory mounted — one
//! more thing to get wrong in a deployment — or silently applies nothing when
//! the mount is missing, which is the worst of the three outcomes. `include_str!`
//! makes the migrations part of the binary, so the binary and its schema cannot
//! disagree.

use std::fmt;

use tokio_postgres::Client;

/// One migration, embedded at compile time.
pub struct Migration {
    pub version: i32,
    pub name: &'static str,
    pub sql: &'static str,
}

/// Every migration, in order. **Adding one here is the only way to add one.**
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "0001_migrations_table.sql",
    sql: include_str!("../migrations/0001_migrations_table.sql"),
}];

/// A cheap checksum over a migration's bytes.
///
/// **Not a security control and not claimed as one.** It exists to notice an
/// already-applied migration having been edited, which is a mistake people make
/// and which silently produces two databases with different schemas. A real
/// digest would mean a cryptographic dependency in a crate that has no other
/// use for one; `deps/decisions/` would carry a record whose stated job was
/// "detect a typo".
pub fn checksum(sql: &str) -> i64 {
    // FNV-1a, 64-bit, taken to i64 because Postgres has no unsigned types.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in sql.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash as i64
}

/// What went wrong applying migrations.
#[derive(Debug)]
pub enum MigrateError {
    /// The database refused something.
    Database(tokio_postgres::Error),
    /// A migration already recorded as applied does not match the file that is
    /// embedded now.
    Changed {
        version: i32,
        recorded_len: i32,
        embedded_len: i32,
    },
}

impl fmt::Display for MigrateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(e) => write!(f, "the database refused a migration: {e}"),
            Self::Changed {
                version,
                recorded_len,
                embedded_len,
            } => write!(
                f,
                "migration {version} was applied from a file of {recorded_len} bytes and the \
                 embedded one is {embedded_len}. An applied migration has been edited. Fix it \
                 forward with a new migration; do not edit this one back."
            ),
        }
    }
}

impl std::error::Error for MigrateError {}

impl From<tokio_postgres::Error> for MigrateError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Database(e)
    }
}

/// Apply every migration that has not been applied, in order.
///
/// Migration 1 is special and has to be: it creates the table the others are
/// recorded in, so it runs before the table can be read.
pub async fn run(client: &mut Client) -> Result<u32, MigrateError> {
    let mut applied = 0;

    for m in MIGRATIONS {
        // Each migration and its bookkeeping in ONE transaction. Without this a
        // crash between the two leaves a migration applied and unrecorded,
        // which the next start would apply again.
        let tx = client.transaction().await?;

        if m.version > 1 {
            let existing = tx
                .query_opt(
                    "SELECT byte_len FROM _fathom_migrations WHERE version = $1",
                    &[&m.version],
                )
                .await?;
            if let Some(row) = existing {
                let recorded: i32 = row.get(0);
                let embedded = i32::try_from(m.sql.len()).unwrap_or(i32::MAX);
                if recorded != embedded {
                    return Err(MigrateError::Changed {
                        version: m.version,
                        recorded_len: recorded,
                        embedded_len: embedded,
                    });
                }
                tx.commit().await?;
                continue;
            }
        }

        tx.batch_execute(m.sql).await?;
        let len = i32::try_from(m.sql.len()).unwrap_or(i32::MAX);
        tx.execute(
            "INSERT INTO _fathom_migrations (version, name, byte_len, checksum) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (version) DO NOTHING",
            &[&m.version, &m.name, &len, &checksum(m.sql)],
        )
        .await?;
        tx.commit().await?;
        applied += 1;
    }

    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_unique_and_ascending() {
        let mut last = 0;
        for m in MIGRATIONS {
            assert!(m.version > last, "{} is not after {last}", m.version);
            last = m.version;
        }
    }

    #[test]
    fn the_first_migration_is_the_migrations_table() {
        assert_eq!(MIGRATIONS[0].version, 1);
        assert!(MIGRATIONS[0].sql.contains("_fathom_migrations"));
    }

    #[test]
    fn the_checksum_notices_an_edit() {
        assert_ne!(
            checksum("CREATE TABLE a ();"),
            checksum("CREATE TABLE b ();")
        );
        // ...including a whitespace-only one, which is the shape of the edit
        // someone makes without thinking it counts.
        assert_ne!(checksum("SELECT 1"), checksum("SELECT  1"));
    }
}
