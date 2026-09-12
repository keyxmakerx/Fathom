-- 0008 -- four fences 0007 claimed and did not have.
--
-- Every one of these was found by an adversarial review of 0007 on
-- 2026-09-12 and reproduced against the committed schema. None of them is a
-- new feature; each closes the gap between what 0007's own header claims and
-- what the database actually enforces.
--
--   A. A SEALED HISTORY THAT ONE `DELETE` ERASES IS NOT TAMPER-EVIDENT.
--      `designs_deletable` plus `ON DELETE CASCADE` let the runtime role
--      erase a design's entire sealed history, its payloads and its keys with
--      one `DELETE FROM designs` -- through three tables that have no DELETE
--      policy of their own, because referential actions are not subject to
--      row-level security. `DELETE FROM organisations` did the same one level
--      up.
--   B. The chain master had no stamped key id, so a lost chain key file
--      reported the history as FORGED rather than as the wrong key.
--   C. `master_keys` has no row-level security -- deliberately, it is not
--      tenant data -- and 0006's default privileges therefore handed the
--      runtime role UPDATE and DELETE on it with no fence of any kind.
--   D. `designs.scope_id` was the only cross-table reference in 0007 that was
--      not tenant-bound.
--
-- ---------------------------------------------------------------------------
-- INVARIANT 11 -- AND HERE IT DOES BITE
-- ---------------------------------------------------------------------------
--
-- `.context/conventions.md` invariant 11: a migration that READS an existing
-- table must handle forced row-level security, because a migration runs with
-- no tenant context. This migration adds constraints to `designs` and
-- `scopes`, and PostgreSQL validates a new constraint against the rows
-- already there. `FORCE ROW LEVEL SECURITY` binds for the table's owner, and
-- this migration runs as the owner. The `NO FORCE` / `FORCE` pairs below are
-- LOAD-BEARING and must not be tidied away: without them a validating scan
-- can see zero rows on a database with data and report success over rows it
-- never looked at -- and on an empty database, which is where migrations get
-- tested, the difference is invisible.

-- ---------------------------------------------------------------------------
-- A. THE APPEND-ONLY FENCE, MADE REAL
--
-- 0007's `chain_entries` comment says: *"with row security forced and no
-- policy for a command, that command reaches no rows at all -- so an
-- append-only history is what the runtime role can express, whatever a later
-- query says."* That was true of a statement naming `chain_entries`. It was
-- not true of a CASCADE arriving from `designs`: **referential integrity
-- actions bypass row-level security entirely**, at every privilege level. So
-- the append-only claim rested on a policy that the delete path never
-- consulted.
--
-- THE DECISION, and the alternative that was considered. The reviewer offered
-- two: drop the cascade and make deletion a sealed tombstone entry, or stop
-- `designs` being deletable by the runtime role. **Both are taken**, because
-- they fence different attackers and the cheaper one alone is not enough:
--
--   * `RESTRICT` on all three child tables is the fence that binds for
--     EVERYONE -- the runtime role, the table owner, a superuser, and any
--     cascade arriving from `organisations` above. Referential integrity is
--     the one rule in this database that a superuser does not bypass. A
--     design with a sealed history, a stored version or a key cannot be
--     deleted at all, by anybody, in one statement or ten.
--   * Dropping `designs_deletable` is the fence that says what the runtime
--     role is FOR. Nothing in this server deletes a design. When deletion
--     lands it will be a sealed tombstone entry -- an append, not a removal --
--     and it gets its own policy in the same diff, which is 0003's rule for
--     `accounts`.
--
-- What this does NOT claim: the history is still not append-only against
-- someone who can `ALTER TABLE` (the migration role, a superuser). That is
-- what the seal is for, and what
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`'s `0008 chains` migration
-- (append-only triggers, a separate `fathom_audit` owner) is for. This
-- migration does not build those.
-- ---------------------------------------------------------------------------

-- The three constraints 0007 created unnamed, dropped by what they ARE rather
-- than by the name PostgreSQL happened to generate for them -- a name this
-- file would otherwise have to guess correctly on every deployment.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.conrelid::regclass::text AS table_name, c.conname
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.confrelid = 'designs'::regclass
          AND c.confdeltype = 'c'                     -- ON DELETE CASCADE
          AND c.conrelid IN ('design_keys'::regclass,
                             'design_payload'::regclass,
                             'chain_entries'::regclass)
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.table_name, r.conname);
    END LOOP;
END
$$;

ALTER TABLE design_keys
    ADD CONSTRAINT design_keys_design_fkey
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
    ON DELETE RESTRICT;

ALTER TABLE design_payload
    ADD CONSTRAINT design_payload_design_fkey
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
    ON DELETE RESTRICT;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_design_fkey
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
    ON DELETE RESTRICT;

-- The runtime role's own DELETE path on `designs`, removed. See the header:
-- nothing in this server deletes a design, and when something does it will
-- append a sealed tombstone rather than remove a row.
DROP POLICY IF EXISTS designs_deletable ON designs;

-- ---------------------------------------------------------------------------
-- B. THE CHAIN MASTER'S KEY ID -- ADR-0043 §4, APPLIED WHERE IT WAS MISSED
--
-- ADR-0043 §4 required a non-secret key id stamped into the database so that
-- *"a restore with the wrong key must report 'this database was encrypted
-- under master key a41f...; the configured key is 9c02...' rather than
-- surfacing as an AEAD tag failure that reads like corruption."* 0007 applied
-- that to the master key and not to the chain master, which has the same
-- failure mode and a worse symptom: `src/main.rs` creates a missing key file
-- at startup, so a lost `chain.key` came back as 32 fresh random bytes and
-- every history in the database then reported **BROKEN AT ENTRY 1** -- a
-- forgery alarm for an operator error.
--
-- Same shape as `master_keys`, and for the same reasons: the id is
-- `HMAC-SHA-256(chain master, "fathom/key/id/v1")` truncated to 8 bytes --
-- a keyed one-way function of the key, so publishing it discloses nothing --
-- and retired rows are kept forever because a retired chain key is what an
-- old chain still verifies under.
--
-- NO ROW-LEVEL SECURITY, deliberately, exactly as `master_keys` has none:
-- this is not tenant data. It holds no key and no tenant identifier.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chain_master_keys (
    -- 8 bytes as 16 hex characters. NOT the key, and there is no column here
    -- that could hold one.
    key_id         text        PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{16}$'),
    status         text        NOT NULL CHECK (status IN ('active', 'retired')),
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    retired_at     timestamptz,
    retired_reason text,
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS chain_master_keys_one_active_idx
    ON chain_master_keys ((true)) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- C. THE TWO VERBS THE RUNTIME ROLE NEVER EARNED
--
-- `master_keys` and `chain_master_keys` have no row-level security, because
-- neither is tenant data -- so for these two tables the GRANT is the only
-- fence there is. 0006's `ALTER DEFAULT PRIVILEGES` hands every new table
-- SELECT, INSERT, UPDATE and DELETE, which is right for tenant tables behind
-- a policy and wrong here.
--
-- SELECT and INSERT are earned: `keys::register_master_key` reads the active
-- row and stamps one on first start, and that is the whole of the runtime
-- role's business with either table. UPDATE and DELETE are not earned by any
-- code path. A DELETE here is every backup written under that key becoming
-- indistinguishable from corruption; an UPDATE is the wrong-key check
-- rewritten to agree with whatever key is now configured, which turns
-- ADR-0043 §4's control off silently.
--
-- Retiring a key (`status`, `retired_at`) is an UPDATE. Nothing implements
-- retirement yet; when it does it is an administrative path, not a request
-- path, and it gets its privilege in the same diff.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON master_keys FROM fathom_app;
REVOKE UPDATE, DELETE ON chain_master_keys FROM fathom_app;

-- ---------------------------------------------------------------------------
-- D. THE ONE CROSS-TABLE REFERENCE 0007 LEFT UNBOUND
--
-- 0007's own header argues the composite-foreign-key pattern -- *"a payload
-- row or a chain entry cannot name a tenant other than its design's, because
-- the reference would not resolve -- and referential integrity binds at every
-- privilege level, including for a superuser, which row-level security does
-- not"* -- and then does not apply it to `designs.scope_id`, which was the
-- only reference in the file naming a row in another table without naming the
-- tenant beside it.
--
-- `designs::create_design` checks the scope's tenant in its `WHERE EXISTS`,
-- and that check is application code. This makes it a schema fact.
--
-- The existing single-column `designs_scope_id_fkey` is left in place: it
-- carries the `ON DELETE RESTRICT` that stops deleting a rack silently
-- deleting the designs filed under it, and a second constraint costs one
-- index probe on insert.
-- ---------------------------------------------------------------------------
ALTER TABLE scopes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE designs NO FORCE ROW LEVEL SECURITY;

-- What the composite reference needs on the other side. `scopes` already has
-- `UNIQUE (organisation_id, path)`; this is the pair the foreign key names.
ALTER TABLE scopes
    ADD CONSTRAINT scopes_id_organisation_key UNIQUE (id, organisation_id);

ALTER TABLE designs
    ADD CONSTRAINT designs_scope_in_same_organisation_fkey
    FOREIGN KEY (scope_id, organisation_id) REFERENCES scopes (id, organisation_id)
    ON DELETE RESTRICT;

ALTER TABLE designs FORCE ROW LEVEL SECURITY;
ALTER TABLE scopes FORCE ROW LEVEL SECURITY;
