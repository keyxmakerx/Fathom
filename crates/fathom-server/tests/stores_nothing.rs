//! WO-11 §6 **G8 — nothing is stored.**
//!
//! > *"`grep` the migrations for any table other than the migrations table
//! > itself; there must be none. This order writes no customer data, so
//! > ADR-0040's key boundary is not yet required — and that is why it may not
//! > store anything."*
//!
//! A `grep` in a work order is a check somebody runs once. This is the same
//! check as a test, so it runs on every push and fails the day a later session
//! adds a table here instead of behind the key boundary.
//!
//! **WO-11 §7 trigger 2 is the reason**, and it is worth having in front of
//! whoever next opens this file: ADR-0040 requires a data key per tenant AND
//! per design *from the first stored byte*, and ADR-0040 §9 items 1 and 2 leave
//! the key-management service undecided — including for self-hosted
//! deployments with no cloud KMS. **The first row written before custody is
//! decided is exactly the retrofit ADR-0040 exists to prevent.** If this test
//! is in your way, the answer is the next work order, not an edit here.

use std::collections::BTreeSet;
use std::path::Path;

/// The only table this order may create.
const ALLOWED: &str = "_fathom_migrations";

/// Every migration file on disk, read from the directory rather than from the
/// `MIGRATIONS` constant — so a file added and not yet wired in is still
/// checked.
fn migration_files() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("migrations/ must exist") {
        let path = entry.expect("readable entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("a file name")
            .to_string();
        let sql = std::fs::read_to_string(&path).expect("readable migration");
        out.push((name, sql));
    }
    out.sort();
    assert!(!out.is_empty(), "no migrations were found to check");
    out
}

/// Strip `--` line comments and `/* */` blocks, so a table named only inside a
/// comment is not counted — and, more importantly, so a real `CREATE TABLE`
/// cannot be hidden from this test by putting a decoy in a comment.
fn strip_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let bytes: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '-' && bytes.get(i + 1) == Some(&'-') {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
        } else if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
            i += 2;
            while i < bytes.len() && !(bytes[i] == '*' && bytes.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// Every identifier this SQL creates, by object kind.
///
/// Deliberately blunt: it looks for `CREATE`, skips the modifiers PostgreSQL
/// allows between `CREATE` and the object kind, and takes the next identifier.
/// A blunt reader that over-reports is the right failure direction here — a
/// false positive is one line in this file explaining why an object is fine; a
/// false negative is a table nobody noticed.
fn created_objects(sql: &str) -> Vec<(String, String)> {
    const MODIFIERS: &[&str] = &[
        "or",
        "replace",
        "unlogged",
        "temporary",
        "temp",
        "global",
        "local",
        "unique",
        "materialized",
        "recursive",
        "if",
        "not",
        "exists",
    ];
    let cleaned = strip_comments(sql).to_ascii_lowercase();
    let words: Vec<&str> = cleaned
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect();

    let mut found = Vec::new();
    let mut i = 0;
    while i < words.len() {
        if words[i] != "create" {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < words.len() && MODIFIERS.contains(&words[j]) {
            j += 1;
        }
        if j >= words.len() {
            break;
        }
        let kind = words[j].to_string();
        // Skip the modifiers that can also follow the kind: `IF NOT EXISTS`.
        let mut k = j + 1;
        while k < words.len() && MODIFIERS.contains(&words[k]) {
            k += 1;
        }
        if k < words.len() {
            found.push((kind, words[k].to_string()));
        }
        i = j + 1;
    }
    found
}

#[test]
fn the_migrations_create_exactly_one_table_and_it_is_the_migrations_table() {
    let mut tables: BTreeSet<String> = BTreeSet::new();
    for (name, sql) in migration_files() {
        for (kind, ident) in created_objects(&sql) {
            if kind == "table" {
                assert_eq!(
                    ident, ALLOWED,
                    "{name} creates a table called `{ident}`. WO-11 G8 forbids any table but \
                     `{ALLOWED}` in this order, because ADR-0040's key boundary is not yet \
                     decided and the first row written before custody is decided is exactly \
                     the retrofit ADR-0040 exists to prevent. The answer is the next work \
                     order, not an edit here."
                );
                tables.insert(ident);
            }
        }
    }
    assert_eq!(
        tables,
        BTreeSet::from([ALLOWED.to_string()]),
        "the migrations must create the migrations table and nothing else"
    );
}

#[test]
fn the_migrations_create_no_other_kind_of_object_either() {
    // A view, a materialised view or a sequence is still a place to put data,
    // and G8 is about not storing anything rather than about the word "table".
    for (name, sql) in migration_files() {
        for (kind, ident) in created_objects(&sql) {
            assert!(
                kind == "table",
                "{name} creates a {kind} called `{ident}`. This order creates the migrations \
                 table and nothing else; see G8."
            );
        }
    }
}

#[test]
fn the_checker_itself_detects_what_it_is_looking_for() {
    // A test that only ever passes is not evidence. Drive the reader over SQL
    // it MUST flag, so a change that broke it would be caught here rather than
    // by the absence of an error.
    let cases = [
        ("CREATE TABLE tenants (id uuid);", "tenants"),
        ("create unlogged table Designs (id uuid);", "designs"),
        ("CREATE TABLE IF NOT EXISTS users (id uuid);", "users"),
        ("CREATE\n  TABLE\n  nodes (id uuid);", "nodes"),
    ];
    for (sql, expected) in cases {
        let found = created_objects(sql);
        assert!(
            found.iter().any(|(k, n)| k == "table" && n == expected),
            "the reader missed `{expected}` in: {sql}\nsaw: {found:?}"
        );
    }

    // ...and it must not be fooled by a decoy in a comment.
    let decoy = "-- CREATE TABLE tenants (id uuid);\nCREATE TABLE _fathom_migrations (a int);";
    let found = created_objects(decoy);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].1, "_fathom_migrations");

    // A view is reported as a view, not silently ignored.
    let view = "CREATE MATERIALIZED VIEW estate AS SELECT 1;";
    assert!(created_objects(view).iter().any(|(k, _)| k == "view"));
}

#[test]
fn every_embedded_migration_matches_a_file_on_disk() {
    // `include_str!` means the binary carries the SQL, so a file could be
    // renamed or removed and the binary would not notice. This test is the
    // thing that notices.
    let on_disk: BTreeSet<String> = migration_files().into_iter().map(|(n, _)| n).collect();
    let embedded: BTreeSet<String> = fathom_server::migrate::MIGRATIONS
        .iter()
        .map(|m| m.name.to_string())
        .collect();
    assert_eq!(
        on_disk, embedded,
        "the migrations on disk and the ones embedded in the binary differ"
    );

    for m in fathom_server::migrate::MIGRATIONS {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("migrations")
            .join(m.name);
        let sql = std::fs::read_to_string(&path).expect("readable migration");
        assert_eq!(
            sql, m.sql,
            "{} on disk differs from the embedded copy",
            m.name
        );
    }
}
