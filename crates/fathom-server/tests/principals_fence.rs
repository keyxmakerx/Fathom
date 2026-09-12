//! `migrations/0004_principals.sql`, proved against a real PostgreSQL as the
//! most privileged role the environment has.
//!
//! **This is the fence the owner asked for**, in his words: *"we don't want
//! an admin to be able to take over the site type situation."*
//! `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §15.6 puts it first in the build
//! order and says why: on its own it delivers that sentence.
//!
//! It is a CONSTRAINT, not a policy, and the whole point of the distinction is
//! the privilege level it survives. §2: PostgreSQL exempts superusers from row
//! security, but not from referential integrity. A claim like that is a
//! behaviour claim, and CLAUDE.md rule 1 forbids asserting one from memory --
//! so every test below connects as the bootstrap superuser, on the test
//! database, and reads the answer off the run.
//!
//! What these tests deliberately do NOT claim: that the fence survives a
//! tier-3 attacker. §2's own correction is blunt about it -- a schema owner
//! can `DROP CONSTRAINT`, which is detected by a later schema fingerprint and
//! not prevented here. The design rates this fence at tier 2 for that reason
//! and so does this file.

mod support;

use tokio_postgres::error::SqlState;
use tokio_postgres::Client;

/// A fresh 26-character id, the same shape every `CHECK (char_length(id) =
/// 26)` in the schema expects.
fn id() -> String {
    fathom_server::ids::new_ulid().to_string()
}

/// Migrate first (through the restricted role, exactly as the server does),
/// then hand back a superuser connection to the same database.
async fn migrated_then_superuser() -> Client {
    let _pool = support::migrated_pool().await;
    support::superuser_client_on_test_database().await
}

/// An operator principal, and an organisation for it to fail to join.
async fn an_operator_and_an_organisation(client: &Client) -> (String, String) {
    let operator = id();
    client
        .execute(
            "INSERT INTO principals (id, kind) VALUES ($1, 'operator')",
            &[&operator],
        )
        .await
        .expect("a superuser may create an operator principal -- that is not what is fenced");
    client
        .execute(
            "INSERT INTO operators (id, display_name) VALUES ($1, 'Ops')",
            &[&operator],
        )
        .await
        .expect("and may register it as an operator");

    let org = id();
    client
        .execute(
            "INSERT INTO organisations (id, display_name) VALUES ($1, 'Fenced Ltd')",
            &[&org],
        )
        .await
        .expect("insert organisation");
    (operator, org)
}

#[tokio::test]
async fn a_superuser_cannot_put_an_operator_principal_in_a_membership() {
    let client = migrated_then_superuser().await;
    let (operator, org) = an_operator_and_an_organisation(&client).await;

    let err = client
        .execute(
            "INSERT INTO memberships (account_id, organisation_id, role) \
             VALUES ($1, $2, 'admin')",
            &[&operator, &org],
        )
        .await
        .expect_err(
            "an operator principal in a membership row is the takeover this design exists to \
             refuse, and the database must refuse it for EVERY role",
        );
    assert_eq!(
        err.code(),
        Some(&SqlState::FOREIGN_KEY_VIOLATION),
        "expected referential integrity to refuse it, got: {err}"
    );
}

#[tokio::test]
async fn a_superuser_cannot_make_an_operator_principal_an_account_either() {
    // `memberships.account_id` also references `accounts(id)`, so the refusal
    // above could in principle have come from that older key alone. This is
    // the other half: the operator cannot become an account in the first
    // place, so there is no route to a membership through one.
    let client = migrated_then_superuser().await;
    let (operator, _org) = an_operator_and_an_organisation(&client).await;

    let err = client
        .execute(
            "INSERT INTO accounts (id, email, display_name) VALUES ($1, $2, 'Ops')",
            &[&operator, &format!("{operator}@example.test")],
        )
        .await
        .expect_err("an account is a steward principal and an operator may not become one");
    assert_eq!(
        err.code(),
        Some(&SqlState::FOREIGN_KEY_VIOLATION),
        "got: {err}"
    );
}

#[tokio::test]
async fn the_positive_control_a_steward_may_hold_a_membership() {
    // Without this, every assertion above would pass equally well against a
    // schema where nothing could be inserted at all.
    let client = migrated_then_superuser().await;
    let (_operator, org) = an_operator_and_an_organisation(&client).await;

    let steward = id();
    client
        .execute(
            "INSERT INTO principals (id, kind) VALUES ($1, 'steward')",
            &[&steward],
        )
        .await
        .expect("insert steward principal");
    client
        .execute(
            "INSERT INTO accounts (id, email, display_name) VALUES ($1, $2, 'A Person')",
            &[&steward, &format!("{steward}@example.test")],
        )
        .await
        .expect("insert account");
    client
        .execute(
            "INSERT INTO memberships (account_id, organisation_id, role) \
             VALUES ($1, $2, 'admin')",
            &[&steward, &org],
        )
        .await
        .expect("a steward principal holds authority -- that is the whole point of the kind");
}

#[tokio::test]
async fn the_kind_column_on_an_authority_row_cannot_be_written_at_all() {
    // The fence would be worth nothing if the referencing table's `kind` half
    // were a value a caller could choose. It is `GENERATED ALWAYS AS
    // ('steward') STORED`, so PostgreSQL refuses the statement outright
    // rather than checking the value -- for a superuser too.
    let client = migrated_then_superuser().await;
    let (operator, org) = an_operator_and_an_organisation(&client).await;

    for statement in [
        "INSERT INTO memberships (account_id, organisation_id, role, principal_kind) \
         VALUES ($1, $2, 'admin', 'operator')",
        "INSERT INTO memberships (account_id, organisation_id, role, principal_kind) \
         VALUES ($1, $2, 'admin', 'steward')",
    ] {
        let err = client
            .execute(statement, &[&operator, &org])
            .await
            .expect_err("a generated column may not be written, whatever the value");
        assert_eq!(
            err.code(),
            Some(&SqlState::GENERATED_ALWAYS),
            "expected a generated-column refusal for `{statement}`, got: {err}"
        );
    }
}

#[tokio::test]
async fn a_steward_holding_authority_cannot_be_turned_into_an_operator() {
    // The other direction, and the one a takeover would actually try: leave
    // the membership alone and change what the principal IS. The composite
    // key is referential integrity on `principals (id, kind)`, so the update
    // that would strand it is refused from the referenced side.
    let client = migrated_then_superuser().await;
    let (_operator, org) = an_operator_and_an_organisation(&client).await;

    let steward = id();
    client
        .execute(
            "INSERT INTO principals (id, kind) VALUES ($1, 'steward')",
            &[&steward],
        )
        .await
        .expect("insert steward principal");
    client
        .execute(
            "INSERT INTO accounts (id, email, display_name) VALUES ($1, $2, 'A Person')",
            &[&steward, &format!("{steward}@example.test")],
        )
        .await
        .expect("insert account");
    client
        .execute(
            "INSERT INTO memberships (account_id, organisation_id, role) \
             VALUES ($1, $2, 'admin')",
            &[&steward, &org],
        )
        .await
        .expect("insert membership");

    for statement in [
        "UPDATE principals SET kind = 'operator' WHERE id = $1",
        "DELETE FROM principals WHERE id = $1",
    ] {
        let err = client
            .execute(statement, &[&steward])
            .await
            .expect_err("this statement would strand an authority row and must be refused");
        assert_eq!(
            err.code(),
            Some(&SqlState::FOREIGN_KEY_VIOLATION),
            "expected referential integrity to refuse `{statement}`, got: {err}"
        );
    }
}

#[tokio::test]
async fn every_authority_table_carries_a_composite_key_onto_principals() {
    // Read off the catalogue rather than off the migration text, and phrased
    // as a rule rather than as a list of two: the day `scope_grants` or
    // `recovery_holders` lands, this is the assertion that says whether it
    // was built the same way.
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");

    const AUTHORITY_TABLES: &[&str] = &["accounts", "memberships"];

    for table in AUTHORITY_TABLES {
        let rows = client
            .query(
                "SELECT c.conname, \
                        (SELECT array_agg(a.attname ORDER BY k.ord) \
                           FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) \
                           JOIN pg_attribute a \
                             ON a.attrelid = c.conrelid AND a.attnum = k.attnum) \
                 FROM pg_constraint c \
                 WHERE c.contype = 'f' \
                   AND c.conrelid = to_regclass($1) \
                   AND c.confrelid = 'principals'::regclass",
                &[table],
            )
            .await
            .expect("read pg_constraint");
        assert_eq!(
            rows.len(),
            1,
            "{table} must have exactly one foreign key onto `principals`"
        );
        let columns: Vec<String> = rows[0].get(1);
        assert_eq!(
            columns.len(),
            2,
            "{table}'s key onto `principals` is not composite, so it does not pin the kind: \
             {columns:?}"
        );
        assert!(
            columns.iter().any(|c| c == "principal_kind"),
            "{table}'s key onto `principals` does not include the generated kind column: \
             {columns:?}"
        );
    }
}

#[tokio::test]
async fn the_kind_columns_really_are_generated_and_really_are_constant() {
    // `GENERATED ALWAYS ... STORED` is what makes the column unwritable, and
    // the literal is what makes it mean `steward`. A later migration that
    // "tidied" either into a `DEFAULT` would leave every test above passing
    // for the wrong reason -- a superuser could then write the column and
    // pick its own kind.
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");

    for (table, expected) in [
        ("accounts", "steward"),
        ("memberships", "steward"),
        ("operators", "operator"),
    ] {
        let row = client
            .query_one(
                "SELECT a.attgenerated, pg_get_expr(d.adbin, d.adrelid) \
                 FROM pg_attribute a \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE a.attrelid = to_regclass($1) AND a.attname = 'principal_kind'",
                &[&table],
            )
            .await
            .unwrap_or_else(|e| panic!("{table} has no `principal_kind` column: {e}"));
        let generated: i8 = row.get(0);
        assert_eq!(
            generated, b's' as i8,
            "{table}.principal_kind is not a STORED generated column"
        );
        let expression: String = row.get(1);
        assert!(
            expression.contains(expected),
            "{table}.principal_kind is generated as `{expression}`, which does not pin it to \
             `{expected}`"
        );
    }
}

#[tokio::test]
async fn the_new_tables_have_row_security_enabled_and_forced() {
    // Every new table needs this considered explicitly.
    // `migrations/0004_principals.sql` states the reasoning for both;
    // this is the part of it the database can be asked about. Without
    // `FORCE`, the owning role -- which is the role the server connects as --
    // is exempt from its own policies.
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");

    for table in ["principals", "operators"] {
        let row = client
            .query_one(
                "SELECT relrowsecurity, relforcerowsecurity FROM pg_class \
                 WHERE relname = $1 AND relnamespace = 'public'::regnamespace",
                &[&table],
            )
            .await
            .expect("read pg_class");
        assert!(row.get::<_, bool>(0), "{table} does not have RLS enabled");
        assert!(row.get::<_, bool>(1), "{table} does not FORCE RLS");
    }
}

#[tokio::test]
async fn the_operator_register_is_writable_by_nobody_on_the_application_plane() {
    // `operators` is created with row security forced and no policy at all,
    // which is the strongest available default: no rows out, no rows in, for
    // every non-superuser role including the one that owns the table. The
    // paths that read and write it land with their own migrations.
    let pool = support::migrated_pool().await;
    let client = pool.get().await.expect("connection");

    let err = client
        .execute(
            "INSERT INTO operators (id, display_name) VALUES ($1, 'Ops')",
            &[&id()],
        )
        .await
        .expect_err("the application plane has no rule permitting it to mint an operator");
    assert_eq!(
        err.code(),
        Some(&SqlState::INSUFFICIENT_PRIVILEGE),
        "got: {err}"
    );

    let rows = client
        .query("SELECT id FROM operators", &[])
        .await
        .expect("a SELECT with no policy returns no rows rather than failing");
    assert!(
        rows.is_empty(),
        "the application plane read {} operator rows through a table with no read policy",
        rows.len()
    );
}
