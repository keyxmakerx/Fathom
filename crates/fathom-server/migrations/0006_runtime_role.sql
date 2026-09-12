-- 0006 -- the runtime role: data privileges only, no ownership, no DDL, no
-- CREATEROLE.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §15.0, decided 2026-09-12: **the
-- migration role and the runtime role are separated.** Until now one role
-- owned every table, ran the migrations, held `CREATEROLE` (added when 0005
-- began creating roles inside the migration chain) -- AND served every
-- request. That is the one-credential-does-everything pattern this whole
-- design exists to refuse: an injection at runtime could reshape the
-- database or mint a role. This migration is the other half of the fix --
-- the fix `0005`'s own header on `fathom`'s `CREATEROLE` grant left open --
-- taking that privilege off the role that serves requests.
--
-- ---------------------------------------------------------------------------
-- THE ROLES, NAMED
-- ---------------------------------------------------------------------------
--
-- The MIGRATION role is unchanged and is not renamed: `fathom` in
-- `deploy/init-db/10-app-role.sh`, `fathom_test` in
-- `.github/workflows/ci.yml`. It still owns every table in this database
-- (created them, by `CREATE TABLE`, in 0001-0005), still holds `CREATEROLE`
-- for the same reason 0005 needed it (a future migration may still need to
-- create a role), and is used once at startup -- `src/main.rs` -- to run
-- `migrate::run` and to provision the line below, then dropped.
--
-- The RUNTIME role is `fathom_app` -- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`
-- §1.3 and §1.4 already name it this, for the admin-surface design those
-- sections describe; this migration is what makes it exist ahead of that,
-- because the split the owner asked for in §15.0 does not want to wait on
-- the rest of that design landing first. `src/db.rs::pool` is what connects
-- as it for every request, and its own name is never hardcoded in Rust: see
-- `db::runtime_role`, which reads it out of `DATABASE_URL` instead.
--
-- ---------------------------------------------------------------------------
-- WHY `fathom_app` IS CREATED `NOLOGIN`, AND WHO ENABLES IT
-- ---------------------------------------------------------------------------
--
-- Exactly `0005`'s shape for `fathom_operator`: a role created here with no
-- way to authenticate as it, because a migration's SQL is checksum-pinned
-- (`migrate::checksum`, `MigrateError::Changed`) and a password is a secret
-- regenerated per deployment, not a schema fact a migration file can hold.
--
-- What is DIFFERENT from `fathom_operator` is that something turns this one
-- LOGIN-able immediately, rather than waiting for a later design to land:
-- `src/main.rs`, holding the migration role's connection (which has
-- `CREATEROLE` and therefore may `ALTER ROLE` a role it did not create),
-- calls `db::provision_runtime_login` right after `migrate::run` succeeds,
-- every startup that has a migration credential configured. That is
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.4's own mechanism, word for
-- word: *"the server generates a random password ... and `ALTER ROLE
-- fathom_app PASSWORD` it."* The one place this deviates from §1.4 as
-- written: the SERVER does not generate the password, because `43` §5.4's
-- read-only filesystem means the server container cannot write into the key
-- volume that would need to hold it. `deploy/init-db/10-app-role.sh`
-- generates it instead, into `db_app.pw`, exactly as it already generates
-- the migration role's own password into `db_migrate.pw` -- see that
-- script's header for the fuller accounting.
--
-- ---------------------------------------------------------------------------
-- THE GRANT STORY, AND WHY DEFAULT PRIVILEGES DO THE FUTURE'S WORK
-- ---------------------------------------------------------------------------
--
-- `fathom_app` is granted `SELECT, INSERT, UPDATE, DELETE` on every table
-- that carries application data, and `SELECT` only on `_fathom_migrations` --
-- enough for `migrate::verify_current` to answer "is the schema already
-- current" from the RUNTIME connection, on the startup path where no
-- migration credential was configured at all, and nothing more: `fathom_app`
-- must never be able to write its own bookkeeping.
--
-- `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT ...`
-- is what stops every future migration needing to repeat this list by hand.
-- `CURRENT_USER` here is resolved ONCE, when this statement runs -- to
-- whichever role is applying this migration (`fathom` in production,
-- `fathom_test` in CI) -- and fixed to that role from then on, exactly as a
-- literal role name would be, without this file needing to know that name.
-- Every table a later migration creates, while running as that same
-- migration role, arrives with `fathom_app` already able to read and write
-- it. This is deliberately broader than `fathom_operator`'s allowlist in
-- `0005`: the runtime role is the one that must serve ordinary requests
-- against whatever tables exist, gated by row-level security per tenant, not
-- by a withheld grant -- withholding grants is `fathom_operator`'s fence,
-- not this role's.
--
-- `REVOKE ALL` before granting, exactly as `0005` does for `fathom_operator`
-- and for the same reason: a role is cluster-wide and privileges are
-- per-database, so a cluster where this migration already ran against
-- another database arrives here with the role present and no grants for
-- THIS one. Start from nothing, explicitly.
--
-- ---------------------------------------------------------------------------
-- OWNERSHIP DOES NOT MOVE
-- ---------------------------------------------------------------------------
--
-- Every table in this database is still owned by the migration role, exactly
-- as before this migration. `fathom_app` is granted verbs, never `ALTER
-- TABLE`, `DROP TABLE`, `CREATE TABLE`, `CREATE POLICY` or `CREATEROLE` --
-- there is no ownership transfer anywhere in this file, and none is needed:
-- the migration role already had every DDL privilege it needs by virtue of
-- owning the tables it created, and moving ownership to a role that must
-- also serve untrusted requests is exactly the thing this migration exists
-- to undo. `tests/no_key_protected_data.rs`'s `role` reader already covers a
-- `CREATE ROLE` inside a `DO $$ ... $$` block (added for `fathom_operator`);
-- the same reader sees this one. `tests/runtime_role_split.rs` proves the
-- refusal side of this directly: connected as `fathom_app`, a `CREATE
-- TABLE`, a `DROP TABLE`, an `ALTER TABLE` and a `CREATE ROLE` are all
-- refused.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fathom_app') THEN
        CREATE ROLE fathom_app
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fathom_app;
REVOKE ALL ON SCHEMA public FROM fathom_app;

GRANT USAGE ON SCHEMA public TO fathom_app;

-- Every table that exists as of this migration except the migrations table
-- itself: full application access, gated by row-level security, not by a
-- withheld grant.
GRANT SELECT, INSERT, UPDATE, DELETE
    ON accounts, organisations, memberships, scopes, principals, operators
    TO fathom_app;

-- The migrations table: read-only, and only so that a server started with
-- no migration credential can ask whether the schema it sees is already the
-- version it expects (`migrate::verify_current`). Never written by this
-- role -- that stays the migration role's job, inside `migrate::run`.
GRANT SELECT ON _fathom_migrations TO fathom_app;

-- Every table a FUTURE migration creates, while running as whichever role
-- applies this migration chain, is granted to `fathom_app` the same way,
-- automatically -- see the header above for why `CURRENT_USER` is safe to
-- use here instead of a literal name.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fathom_app;
