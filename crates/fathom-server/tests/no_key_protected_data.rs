//! Successor to `stores_nothing.rs`, retired here.
//!
//! **The gate this file replaces narrowed. It did not lift.**
//! `tests/stores_nothing.rs` forbade any table but the migrations table,
//! because ADR-0040 requires a data key per tenant **and** per design from
//! the first stored byte, and `docs/OPEN-QUESTIONS.md` A1 -- where the
//! master key lives -- was open. **A1 is still open.** What changed is
//! `docs/PHASE-2-STORAGE-DESIGN.md` §1, which names two things that were
//! never behind that key at all: "Identity" (accounts, organisations,
//! membership) and "Structure" (the scope hierarchy), both "Low -- must be
//! queryable", as distinct from "Designs" and "Vault", which stay gated.
//! Neither carries a design payload, a credential, or a wrapped key -- so
//! neither needs A1 answered first, and answering A1 later will not require
//! re-encrypting a single row either one holds.
//!
//! So the rule this test enforces is narrower than "no table but the
//! migrations table", but it is exactly as real: **the set of tables that
//! exist matches an explicit allowlist below, and every entry on it must
//! carry no key-protected material.** A table cannot appear without someone
//! editing [`ALLOWED_TABLES`] and answering that question in the same diff.
//!
//! The one column this reasoning does not fully cover is `display_name` on
//! `organisations` and `scopes`. `docs/OPEN-QUESTIONS.md` V2 decided in
//! principle that it should end up encrypted, and the same record says the
//! column "does not exist yet and cannot until A1 lands" -- so it stays
//! plaintext here, exactly as that decision anticipates, and is a
//! column-level change once A1 lands, precisely because the scope path is
//! built from opaque ids and never from this column. See
//! `migrations/0002_identity_and_scope.sql`'s header.

use std::collections::BTreeSet;
use std::path::Path;

mod support;

/// Every table this crate's migrations may create, and why each one is safe
/// to create while `docs/OPEN-QUESTIONS.md` A1 is still open. **Adding a
/// table here is a claim, not a formality: it must carry no design payload,
/// no device credential, and no wrapped key.**
const ALLOWED_TABLES: &[(&str, &str)] = &[
    (
        "_fathom_migrations",
        "migration bookkeeping -- version numbers, filenames, byte lengths, checksums. \
         Never carries anything about a tenant, a design or a credential.",
    ),
    (
        "accounts",
        "identity: id, email, display_name. `docs/PHASE-2-STORAGE-DESIGN.md` §1 lists identity \
         as \"Low -- must be queryable\", separate from Designs and Vault. Carries no \
         authentication secret at all -- how an account proves who it is is undecided \
         (`docs/OPEN-QUESTIONS.md` B1-B9, C2) and this task writes no crypto.",
    ),
    (
        "organisations",
        "the tenant boundary: id and a plaintext display_name (see the file header on \
         `docs/OPEN-QUESTIONS.md` V2). No design payload, credential or key ever lands here.",
    ),
    (
        "memberships",
        "an account's role inside one organisation -- account_id, organisation_id, role. \
         Structure, not a secret.",
    ),
    (
        "scopes",
        "the organisation -> network -> building -> rack hierarchy. Carries only opaque ids, \
         a kind, a materialised path built from those ids, and a plaintext display_name (see \
         the file header on `docs/OPEN-QUESTIONS.md` V2). No design payload lives on a scope; \
         designs attach to a scope in a later, still-gated table.",
    ),
    (
        "principals",
        "identity, and the narrowest form of it: an opaque 26-character id, a `kind` that is \
         either `steward` or `operator`, and a creation time. It exists so that every row \
         expressing authority can reference `principals (id, kind)` with its own `kind` column \
         generated and fixed -- see `migrations/0004_principals.sql`. Nothing is stored here \
         that a design, a credential or a key could be hidden in: there is no free-text column \
         at all.",
    ),
    (
        "operators",
        "the machine-side principals -- an opaque id, a display name, a creation time. Carries \
         no authentication secret: `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4.5 gives the \
         operator surface no password path, so there is nothing to hold, and this task writes \
         no crypto. An operator is by construction sightless -- §1.3 withholds every privilege \
         on design data from its database role -- so no design payload or wrapped key can \
         reach this table either.",
    ),
];

/// Object kinds a migration may create that are not themselves a place to
/// store row data: an index accelerates reads of an already-allowed table,
/// and a row-level-security policy is an access rule, not a place to put
/// rows. Both are still read off the SQL by [`created_objects`] and reported
/// by name, so a `CREATE INDEX`/`CREATE POLICY` on a table that is not on
/// [`ALLOWED_TABLES`] is still visible in a diff, just not failed here --
/// there would be no table for it to index or govern in the first place.
///
/// `role` joined the list with `migrations/0005_planes.sql`: a database role
/// is a principal a connection authenticates as, not a relation, and it holds
/// no rows at all. Which roles exist and what they may read is checked by
/// `tests/planes.rs`, table by table, off the live schema.
const NON_STORAGE_KINDS: &[&str] = &["index", "policy", "role"];

/// Every migration file on disk, read from the directory rather than from
/// the `MIGRATIONS` constant -- so a file added and not yet wired in is
/// still checked.
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

/// Strip `--` line comments and `/* */` blocks, so a table named only inside
/// a comment is not counted -- and, more importantly, so a real
/// `CREATE TABLE` cannot be hidden from this test by putting a decoy in a
/// comment.
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
/// allows between `CREATE` and the object kind, and takes the next
/// identifier. A blunt reader that over-reports is the right failure
/// direction here -- a false positive is one line in this file explaining
/// why an object is fine; a false negative is a table nobody noticed.
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

fn allowed_table_names() -> BTreeSet<String> {
    ALLOWED_TABLES
        .iter()
        .map(|(name, _)| name.to_string())
        .collect()
}

#[test]
fn every_table_the_migrations_create_is_on_the_allowlist() {
    let allowed = allowed_table_names();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (name, sql) in migration_files() {
        for (kind, ident) in created_objects(&sql) {
            if kind != "table" {
                continue;
            }
            assert!(
                allowed.contains(&ident),
                "{name} creates a table called `{ident}`, which is not in this test's \
                 `ALLOWED_TABLES`. That list is the whole control: adding a table here means \
                 adding it there, with a stated reason it carries no design payload, no device \
                 credential and no wrapped key -- `docs/OPEN-QUESTIONS.md` A1 is still open."
            );
            seen.insert(ident);
        }
    }
    assert_eq!(
        seen, allowed,
        "the migrations must create every table on the allowlist, and nothing this test has not \
         been told about"
    );
}

#[test]
fn the_migrations_create_no_view_sequence_or_other_undeclared_place_to_put_rows() {
    // A view, materialised view or sequence is still a place data could end
    // up; an index or a row-level-security policy is not. G8's original
    // point ("this order stores NOTHING") is preserved for every OTHER kind
    // of object -- it just no longer covers `table` itself, which has its
    // own allowlist above.
    for (name, sql) in migration_files() {
        for (kind, ident) in created_objects(&sql) {
            assert!(
                kind == "table" || NON_STORAGE_KINDS.contains(&kind.as_str()),
                "{name} creates a {kind} called `{ident}`, which is neither an allowlisted table \
                 nor one of {NON_STORAGE_KINDS:?}. Anything else is an undeclared place to put \
                 rows."
            );
        }
    }
}

#[test]
fn the_checker_itself_detects_what_it_is_looking_for() {
    // A test that only ever passes is not evidence. Drive the reader over
    // SQL it MUST flag, so a change that broke it would be caught here
    // rather than by the absence of an error.
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

    // A view is reported as a view, not silently ignored -- and not
    // mistaken for one of the non-storage kinds this test allows.
    let view = "CREATE MATERIALIZED VIEW estate AS SELECT 1;";
    assert!(created_objects(view).iter().any(|(k, _)| k == "view"));
    assert!(!NON_STORAGE_KINDS.contains(&"view"));

    // A policy and an index must both be recognised as their own kinds
    // (never silently folded into "table"), which is what lets the other
    // test above tell them apart from an undeclared storage object.
    let policy = "CREATE POLICY p ON scopes USING (true);";
    assert!(created_objects(policy)
        .iter()
        .any(|(k, n)| k == "policy" && n == "p"));
    let index = "CREATE INDEX idx ON scopes (path);";
    assert!(created_objects(index)
        .iter()
        .any(|(k, n)| k == "index" && n == "idx"));
    // ...and a role, which `migrations/0005_planes.sql` creates inside a
    // `DO $$ ... $$` block. If the reader stopped seeing it, a `CREATE TABLE`
    // in the same block would stop being seen too.
    let role = "DO $$ BEGIN CREATE ROLE fathom_operator NOLOGIN; END $$;";
    assert!(created_objects(role)
        .iter()
        .any(|(k, n)| k == "role" && n == "fathom_operator"));
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

/// The static SQL scan above proves what the migration *text* declares. This
/// proves what a real, migrated database actually contains -- the two could
/// disagree if, say, a table were created by something other than a
/// `CREATE TABLE` this reader recognises.
#[tokio::test]
async fn the_real_database_holds_exactly_the_allowed_tables() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");
    let rows = client
        .query(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
            &[],
        )
        .await
        .expect("list tables");
    let actual: BTreeSet<String> = rows.iter().map(|r| r.get::<_, String>(0)).collect();

    assert_eq!(
        actual,
        allowed_table_names(),
        "the real database's tables must match ALLOWED_TABLES exactly -- if this fails, \
         something is creating (or has stopped creating) a table that the static SQL scan above \
         did not catch"
    );
}
