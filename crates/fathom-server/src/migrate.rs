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
pub const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "0001_migrations_table.sql",
        sql: include_str!("../migrations/0001_migrations_table.sql"),
    },
    Migration {
        version: 2,
        name: "0002_identity_and_scope.sql",
        sql: include_str!("../migrations/0002_identity_and_scope.sql"),
    },
    Migration {
        version: 3,
        name: "0003_write_side_isolation.sql",
        sql: include_str!("../migrations/0003_write_side_isolation.sql"),
    },
    Migration {
        version: 4,
        name: "0004_principals.sql",
        sql: include_str!("../migrations/0004_principals.sql"),
    },
    Migration {
        version: 5,
        name: "0005_planes.sql",
        sql: include_str!("../migrations/0005_planes.sql"),
    },
];

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
        recorded_checksum: i64,
        embedded_checksum: i64,
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
                recorded_checksum,
                embedded_checksum,
            } => write!(
                f,
                "migration {version} was applied from a file of {recorded_len} bytes with \
                 checksum {recorded_checksum}, and the embedded one is {embedded_len} bytes with \
                 checksum {embedded_checksum}. An applied migration has been edited. Fix it \
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

/// A fixed advisory-lock key, arbitrary but stable, so two processes racing to
/// migrate a fresh database serialise instead of both attempting the same
/// `CREATE TABLE`. Only matters the first time a database is migrated: once
/// `_fathom_migrations` records a version, every later caller sees it recorded
/// and skips straight past. Spelled out because the repository layer's tests
/// are the first thing in this crate to run several process-separate test
/// binaries against one freshly created database at once.
///
/// **Public so a test can hold it.** `pg_advisory_lock` is session-level and
/// re-entrant within one session, so a test that takes this lock on the very
/// client it then passes to [`run`] serialises itself against every other
/// session's migration attempt without deadlocking against its own.
pub const MIGRATION_LOCK_KEY: i64 = 0x4641_5448_4d47_5231; // "FATHMGR1", read as bytes

/// Apply every migration that has not been applied, in order.
///
/// Migration 1 is special and has to be: it creates the table the others are
/// recorded in, so it runs before the table can be read.
pub async fn run(client: &mut Client) -> Result<u32, MigrateError> {
    client
        .execute("SELECT pg_advisory_lock($1)", &[&MIGRATION_LOCK_KEY])
        .await?;
    let result = run_locked(client).await;
    // Released whether or not migration succeeded -- an error here must not
    // wedge every other process waiting on this lock.
    let _ = client
        .execute("SELECT pg_advisory_unlock($1)", &[&MIGRATION_LOCK_KEY])
        .await;
    result
}

async fn run_locked(client: &mut Client) -> Result<u32, MigrateError> {
    let mut applied = 0;

    // Migration 1 creates the table the others are recorded in, so on a fresh
    // database there is no bookkeeping to read and it must simply run. On
    // every LATER run there is, and it is checked like any other migration.
    // Asking once, here, is what makes that distinction: version 1 used to be
    // re-executed and re-counted unconditionally, so `run` never returned
    // `Ok(0)` and a server whose schema was already current logged
    // "migrations applied" on every start, for ever.
    let bookkeeping_exists: bool = client
        .query_one("SELECT to_regclass('_fathom_migrations') IS NOT NULL", &[])
        .await?
        .get(0);

    for m in MIGRATIONS {
        // Each migration and its bookkeeping in ONE transaction. Without this a
        // crash between the two leaves a migration applied and unrecorded,
        // which the next start would apply again.
        let tx = client.transaction().await?;

        if bookkeeping_exists || m.version > 1 {
            let existing = tx
                .query_opt(
                    "SELECT byte_len, checksum FROM _fathom_migrations WHERE version = $1",
                    &[&m.version],
                )
                .await?;
            if let Some(row) = existing {
                let recorded_len: i32 = row.get(0);
                let recorded_checksum: i64 = row.get(1);
                let embedded_len = i32::try_from(m.sql.len()).unwrap_or(i32::MAX);
                let embedded_checksum = checksum(m.sql);
                // THE CHECKSUM, not only the length. The gate exists to
                // notice an applied migration having been EDITED, and an edit
                // that leaves the byte count alone -- swapping two characters,
                // changing a `<` to a `>`, renaming a column to another name
                // of the same width -- is exactly the edit a length
                // comparison cannot see. The length is kept as well only
                // because it makes the message say which of the two moved.
                if recorded_len != embedded_len || recorded_checksum != embedded_checksum {
                    return Err(MigrateError::Changed {
                        version: m.version,
                        recorded_len,
                        embedded_len,
                        recorded_checksum,
                        embedded_checksum,
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
