//! Successor to `stores_nothing.rs`, and **its premise changed with
//! `migrations/0007_key_hierarchy_and_designs.sql`.**
//!
//! # What this gate used to say, and why that sentence is now false
//!
//! `tests/stores_nothing.rs` forbade any table but the migrations table,
//! because ADR-0040 requires a data key per tenant **and** per design from the
//! first stored byte and `docs/OPEN-QUESTIONS.md` A1 -- where the master key
//! lives -- was open. This file then narrowed that to an allowlist of tables
//! that carry identity and structure, each claiming to hold **no design
//! payload, no device credential and no wrapped key**.
//!
//! ADR-0043 answered A1. `0007` creates the first tables that DO hold
//! key-protected material: wrapped keys, and the ciphertext of every design.
//! So the old claim -- "nothing here is protected by a key" -- cannot be made
//! about this schema any more, and **adding those tables to the old allowlist
//! would have been a lie in a list that exists to be true.**
//!
//! # What it says now, and why this is the stronger gate
//!
//! Three claims, in ascending order of how hard they are to fake:
//!
//! 1. **Every table is declared, and declares its kind.** A table is either
//!    plaintext-by-design, with a stated reason it carries nothing
//!    key-protected, or key-protected, naming the columns that hold the
//!    protected material and the key that protects them. A new table cannot
//!    appear without someone answering that question in the same diff.
//! 2. **A declared ciphertext column is `bytea`.** Checked against the live
//!    schema. Ciphertext in a `text` column means an encoding, and an encoding
//!    is where a plaintext copy gets kept "temporarily".
//! 3. **THE ONE THAT ACTUALLY TESTS THE CLAIM.** A design containing a
//!    distinctive marker is written through the real write path, and then
//!    every column of every row of every table in the database is swept --
//!    with row-level security bypassed, so nothing is hidden -- for that
//!    marker, as text and as the hex a `bytea` renders to. It must appear
//!    **nowhere**. That is a database-wide version of the old "stores
//!    nothing": the payload may be stored, and it may only be stored
//!    encrypted, including in any audit, metadata or diagnostic column
//!    anybody adds later.
//!
//!    It carries a **positive control**: a value that is deliberately in the
//!    clear -- an organisation's display name -- must be FOUND by the same
//!    sweep. Without that, a sweep that silently scanned nothing would pass.
//!
//! # What this gate does not claim
//!
//! It does not claim Fathom cannot read a design.
//! `docs/PHASE-2-STORAGE-DESIGN.md` §2a: the server encrypts, and the server
//! decrypts, because it has to serve designs. This gate is about what a
//! database dump discloses, which is the boundary ADR-0043 §5 draws.
//!
//! `display_name` on `organisations` and `scopes` is still plaintext:
//! `docs/OPEN-QUESTIONS.md` V2 decided in principle that it should be
//! encrypted, and §11.3 cost 3 is why it has not happened yet -- every
//! server-side surface that names a design or a scope loses the name, and a
//! plaintext copy kept in an audit row is the leak returning through a side
//! door. `designs` has no name column at all for exactly that reason.

use std::collections::BTreeSet;
use std::path::Path;

mod support;

/// How a table relates to the key hierarchy. Every table in the schema is one
/// or the other, and saying which is the whole control.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Protection {
    /// Carries no design payload, no device credential and no wrapped key.
    /// **This is a claim about the table, not a hope.**
    NoKeyProtectedMaterial,
    /// Holds key-protected material in the named columns.
    KeyProtected {
        /// The columns that hold it. Checked against the live schema: each
        /// must exist and must be `bytea`.
        columns: &'static [&'static str],
        /// Which key protects them, in one phrase.
        under: &'static str,
    },
}

struct TableClaim {
    name: &'static str,
    protection: Protection,
    /// Why the claim above is true. **Adding a table here is a claim, not a
    /// formality.**
    why: &'static str,
}

const TABLES: &[TableClaim] = &[
    TableClaim {
        name: "_fathom_migrations",
        protection: Protection::NoKeyProtectedMaterial,
        why: "migration bookkeeping -- version numbers, filenames, byte lengths, checksums. \
              Never carries anything about a tenant, a design or a credential.",
    },
    TableClaim {
        name: "accounts",
        protection: Protection::NoKeyProtectedMaterial,
        why: "identity: id, email, display_name. `docs/PHASE-2-STORAGE-DESIGN.md` §1 lists \
              identity as \"Low -- must be queryable\". Carries no authentication secret at \
              all -- how an account proves who it is is undecided (`docs/OPEN-QUESTIONS.md` \
              B1-B9, C2).",
    },
    TableClaim {
        name: "organisations",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the tenant boundary: id and a plaintext display_name (see the file header on \
              `docs/OPEN-QUESTIONS.md` V2). No design payload, credential or key lands here.",
    },
    TableClaim {
        name: "memberships",
        protection: Protection::NoKeyProtectedMaterial,
        why: "an account's role inside one organisation. Structure, not a secret.",
    },
    TableClaim {
        name: "scopes",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the organisation -> network -> building -> rack hierarchy: opaque ids, a kind, a \
              materialised path built from those ids, and a plaintext display_name.",
    },
    TableClaim {
        name: "principals",
        protection: Protection::NoKeyProtectedMaterial,
        why: "an opaque id, a `kind` of `steward` or `operator`, and a creation time. There is \
              no free-text column at all, so there is nothing a payload could hide in.",
    },
    TableClaim {
        name: "operators",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the machine-side principals -- an opaque id, a display name, a creation time. No \
              authentication secret: `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4.5 gives the \
              operator surface no password path.",
    },
    TableClaim {
        name: "master_keys",
        protection: Protection::NoKeyProtectedMaterial,
        why: "ADR-0043 §4's stamp, and it holds NO KEY: a `key_id` is \
              HMAC-SHA-256(master key, \"fathom/key/id/v1\") truncated to 8 bytes -- a keyed \
              one-way function of the key, published so that a restore with the wrong key says \
              which two ids differ instead of failing like corruption. Retired rows are kept \
              forever and nothing deletes from this table.",
    },
    TableClaim {
        name: "designs",
        protection: Protection::NoKeyProtectedMaterial,
        why: "a design's id, its tenant, its scope, who created it and when. Deliberately NO \
              name column -- §11.3 cost 3 -- so there is no plaintext design name here to \
              leak. The contents live in `design_payload`.",
    },
    TableClaim {
        name: "tenant_keys",
        protection: Protection::KeyProtected {
            columns: &["wrapped_key"],
            under: "the master key, which lives in a file PostgreSQL cannot read (ADR-0043 §1)",
        },
        why: "one random data key per organisation, sealed with `LP(aad_bytes) || key` as the \
              wrapped plaintext (§4's B1 fix). The key itself is never in this database in the \
              clear, and the master key that opens it is never in this database at all.",
    },
    TableClaim {
        name: "design_keys",
        protection: Protection::KeyProtected {
            columns: &["wrapped_key"],
            under: "the tenant key, which is itself wrapped under the master key",
        },
        why: "one random data key per design -- MANDATORY, not preferred (§12.3): random \
              96-bit nonces are safe only because one key covers one design's versions.",
    },
    TableClaim {
        name: "design_payload",
        protection: Protection::KeyProtected {
            columns: &["ciphertext"],
            under: "the design key, wrapped under the tenant key, wrapped under the master key",
        },
        why: "THE DESIGNS THEMSELVES, encrypted whole (§3) -- partial encryption would leak the \
              estate's shape while protecting only the labels. This is the table the sweep \
              below exists for.",
    },
    TableClaim {
        name: "chain_entries",
        protection: Protection::NoKeyProtectedMaterial,
        why: "the tamper-evident history: MAC tags, a sequence number, an entry type and \
              canonical metadata. A binding is a KEYED MAC over content, never the content -- \
              §11.2 keys `content_hash` precisely so that a dump holder cannot use it as a \
              confirmation oracle against a guessed payload. No ciphertext and no key is \
              stored here.",
    },
];

/// Object kinds a migration may create that are not themselves a place to
/// store row data: an index accelerates reads of an already-allowed table,
/// and a row-level-security policy is an access rule, not a place to put
/// rows. Both are still read off the SQL by [`created_objects`] and reported
/// by name, so a `CREATE INDEX`/`CREATE POLICY` on a table that is not on
/// [`TABLES`] is still visible in a diff, just not failed here --
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
/// Replace every single-quoted SQL string literal with a space, and return
/// the literals alongside.
///
/// **Why this was needed, and what it costs.** `0007` writes
/// `CHECK (entry_type IN ('create', 'update', 'reencrypt'))`, and the blunt
/// reader below saw `create` followed by `update` and reported that the
/// migration creates "an update called reencrypt". A word inside a string
/// literal is data, not DDL.
///
/// The cost is that DDL hidden inside a literal -- `EXECUTE 'CREATE TABLE
/// ...'` -- would stop being seen, so
/// [`no_migration_hides_ddl_inside_a_string_literal`] checks the literals
/// themselves. Two narrow checks beat one blunt one that has to be argued
/// with every time a constraint mentions a verb.
fn strip_string_literals(sql: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(sql.len());
    let mut literals = Vec::new();
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '\'' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        i += 1;
        let mut literal = String::new();
        while i < chars.len() {
            if chars[i] == '\'' {
                // '' is an escaped quote inside a literal, not the end of one.
                if chars.get(i + 1) == Some(&'\'') {
                    literal.push('\'');
                    i += 2;
                    continue;
                }
                i += 1;
                break;
            }
            literal.push(chars[i]);
            i += 1;
        }
        literals.push(literal);
        out.push(' ');
    }
    (out, literals)
}

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
    let (cleaned, _literals) = strip_string_literals(&strip_comments(sql));
    let cleaned = cleaned.to_ascii_lowercase();
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
    TABLES.iter().map(|t| t.name.to_string()).collect()
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
                 `TABLES`. That list is the whole control: a table must be declared there as \
                 either carrying no key-protected material, with a stated reason, or as \
                 key-protected, naming the columns and the key that protects them."
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
        "the real database's tables must match `TABLES` exactly -- if this fails, \
         something is creating (or has stopped creating) a table that the static SQL scan above \
         did not catch"
    );
}

/// Every column declared as holding key-protected material exists, and is
/// `bytea`.
///
/// **Why the type matters.** Ciphertext in a `text` column means somebody
/// chose an encoding, and an encoding is where a plaintext copy gets kept "for
/// debugging". `bytea` also means a `::text` cast renders hex rather than
/// whatever the bytes happen to spell, which is what makes the sweep below
/// able to search a whole database uniformly.
#[tokio::test]
async fn every_declared_ciphertext_column_exists_and_is_bytea() {
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");

    let mut checked = 0;
    for table in TABLES {
        let Protection::KeyProtected { columns, under } = table.protection else {
            continue;
        };
        assert!(
            !under.is_empty(),
            "{} is declared key-protected without naming the key",
            table.name
        );
        for column in columns {
            let row = client
                .query_opt(
                    "SELECT data_type FROM information_schema.columns \
                     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2",
                    &[&table.name, column],
                )
                .await
                .expect("read the column's type");
            let data_type: String = row
                .unwrap_or_else(|| {
                    panic!(
                        "{}.{column} is declared as holding key-protected material and does not \
                         exist",
                        table.name
                    )
                })
                .get(0);
            assert_eq!(
                data_type, "bytea",
                "{}.{column} holds key-protected material and is {data_type}, not bytea",
                table.name
            );
            checked += 1;
        }
    }
    assert!(
        checked >= 3,
        "only {checked} key-protected columns were checked; the key hierarchy has at least \
         three (two wrapped keys and one payload)"
    );
}

/// **The one that tests the claim.**
///
/// Write a design carrying a distinctive marker through the real write path,
/// then sweep every column of every row of every table for it — as a
/// superuser, so row-level security hides nothing — and require that it
/// appears nowhere. Then sweep for a value that IS in the clear and require
/// that it appears, so the sweep cannot pass by scanning nothing.
#[tokio::test]
async fn a_marker_written_as_a_design_appears_in_no_column_of_any_table() {
    use fathom_server::crypto::Key32;
    use fathom_server::keys::KeyRing;
    use fathom_server::repo::ScopeKind;
    use fathom_server::{designs, repo};

    // The same master key every other test in this crate uses: ADR-0043 §4
    // allows one active master key per database, so a second one here would
    // be refused -- which is itself correct behaviour, and tested in
    // `tests/design_storage.rs`.
    let ring = KeyRing::from_keys(Key32::from_bytes([21; 32]), Key32::from_bytes([71; 32]));
    let pool = support::migrated_pool().await;

    let stamp = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    // Two values: one that must never be stored in the clear, one that is
    // deliberately in the clear and is the positive control.
    let marker = format!("SWEEPMARKER-{stamp}-10.1.1.0/24-core-fw-01");
    let in_the_clear = format!("SWEEPCONTROL-{stamp}");

    let account = repo::create_account(&pool, &format!("sweep-{stamp}@example.test"), "Sweeper")
        .await
        .expect("account");
    let org = repo::create_organisation(&pool, account.id, &in_the_clear)
        .await
        .expect("organisation");
    let network = repo::create_scope(
        &pool,
        org.id,
        account.id,
        None,
        ScopeKind::Network,
        "sweep network",
    )
    .await
    .expect("network");
    let design = designs::create_design(&pool, org.id, account.id, network.id)
        .await
        .expect("design");
    designs::write_version(
        &pool,
        &ring,
        org.id,
        account.id,
        design,
        format!(r#"{{"devices":[{{"name":"{marker}"}}]}}"#).as_bytes(),
        1,
    )
    .await
    .expect("write the design");

    let found_marker = sweep(&marker).await;
    assert!(
        found_marker.is_empty(),
        "the design's marker was found in the clear in: {found_marker:?}. A design payload may \
         be stored, and it may only be stored ENCRYPTED -- including in any audit, metadata or \
         diagnostic column."
    );

    // The positive control. If this fails, the sweep is broken, and the
    // assertion above proved nothing.
    let found_control = sweep(&in_the_clear).await;
    assert!(
        found_control.contains(&"organisations".to_string()),
        "the sweep did not find a value that IS stored in the clear ({in_the_clear}), so it \
         cannot be trusted to have looked for the marker either. Found: {found_control:?}"
    );
}

/// Every table in which `needle` appears, as text or as the hex a `bytea`
/// renders to.
///
/// Casting a whole row to `text` is what makes this uniform: every column of
/// every type arrives in one string, `bytea` included, so a column added later
/// is swept without this function being edited.
async fn sweep(needle: &str) -> Vec<String> {
    let client = support::superuser_client_on_test_database().await;
    let hex: String = needle.bytes().map(|b| format!("{b:02x}")).collect();

    let tables: Vec<(String, String)> = client
        .query(
            "SELECT tablename, quote_ident(tablename) FROM pg_tables WHERE schemaname = 'public'",
            &[],
        )
        .await
        .expect("list tables")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert!(
        !tables.is_empty(),
        "no tables to sweep is not a passing state"
    );

    let mut hits = Vec::new();
    for (name, quoted) in tables {
        let rows = client
            .query(&format!("SELECT t::text FROM public.{quoted} t"), &[])
            .await
            .unwrap_or_else(|e| panic!("sweep {name}: {e}"));
        for row in rows {
            let rendered: Option<String> = row.get(0);
            let Some(rendered) = rendered else { continue };
            if rendered.contains(needle) || rendered.to_ascii_lowercase().contains(&hex) {
                hits.push(name.clone());
                break;
            }
        }
    }
    hits
}

/// The complement to [`strip_string_literals`]: nothing may create a place to
/// put rows from inside a string literal, where the reader above no longer
/// looks.
///
/// This is the `EXECUTE format('CREATE TABLE %I ...')` shape. No migration in
/// this chain does it, and if one ever wants to, it should be an argued change
/// to this test rather than a quiet bypass of the one above.
#[test]
fn no_migration_hides_ddl_inside_a_string_literal() {
    const HIDDEN: &[&str] = &[
        "create table",
        "create unlogged table",
        "create view",
        "create materialized view",
        "create sequence",
        "create temp table",
        "create temporary table",
    ];
    for (name, sql) in migration_files() {
        let (_, literals) = strip_string_literals(&strip_comments(&sql));
        for literal in literals {
            let flat = literal.to_ascii_lowercase();
            let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
            for shape in HIDDEN {
                assert!(
                    !flat.contains(shape),
                    "{name} has `{shape}` inside a string literal. The object reader strips \
                     literals so that a CHECK constraint naming a verb is not mistaken for DDL; \
                     dynamic DDL would therefore pass unseen."
                );
            }
        }
    }
}

/// The literal stripper itself, driven over what it must and must not do.
#[test]
fn the_literal_stripper_keeps_ddl_and_drops_data() {
    let (stripped, literals) =
        strip_string_literals("CHECK (t IN ('create', 'update'));\nCREATE TABLE x (a int);");
    assert_eq!(literals, vec!["create".to_string(), "update".to_string()]);
    assert!(stripped.contains("CREATE TABLE x"), "{stripped}");
    assert!(!stripped.contains("'create'"), "{stripped}");

    // A doubled quote is an escaped quote, not the end of the literal: a
    // stripper that got this wrong would resynchronise on the wrong side and
    // could hide real DDL after it.
    let (stripped, literals) =
        strip_string_literals("SELECT 'it''s fine'; CREATE TABLE y (a int);");
    assert_eq!(literals, vec!["it's fine".to_string()]);
    assert!(stripped.contains("CREATE TABLE y"), "{stripped}");

    // And the reader, driven over the exact shape that caught this out.
    let sql = "CREATE TABLE chain_entries (entry_type text CHECK (entry_type IN ('create', \
               'update', 'reencrypt')));";
    let found = created_objects(sql);
    assert_eq!(
        found,
        vec![("table".to_string(), "chain_entries".to_string())],
        "{found:?}"
    );
}

/// Every declaration says something. A blank reason is an entry someone added
/// to make a test pass, which is the failure mode this list exists to prevent
/// — the list is only a control while each line of it is a sentence somebody
/// had to be willing to write.
#[test]
fn every_table_declares_a_reason_and_no_table_is_declared_twice() {
    let mut seen = BTreeSet::new();
    for table in TABLES {
        assert!(
            seen.insert(table.name),
            "{} is declared twice in TABLES",
            table.name
        );
        assert!(
            table.why.len() > 40,
            "{} is declared with no real reason: {:?}",
            table.name,
            table.why
        );
        if let Protection::KeyProtected { columns, under } = table.protection {
            assert!(
                !columns.is_empty(),
                "{} is declared key-protected and names no column",
                table.name
            );
            assert!(
                under.len() > 10,
                "{} is declared key-protected and does not say under which key",
                table.name
            );
        }
    }
    assert!(
        TABLES
            .iter()
            .any(|t| matches!(t.protection, Protection::KeyProtected { .. })),
        "no table is declared key-protected. Since 0007 at least three are, and a list that \
         claims otherwise is the old premise coming back."
    );
}
