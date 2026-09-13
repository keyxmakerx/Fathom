-- 0004 -- principals, and the composite foreign keys that make an operator
-- principal unrepresentable in any row that expresses authority.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §11.1 item 0004, ordered first by
-- §15.6: "Pure schema, no crate, and the strongest fence in this document. On
-- its own it delivers 'an administrator cannot take over the site.'"
--
-- WHAT THIS IS FOR, IN THE OWNER'S WORDS. "we don't want an admin to be able
-- to take over the site type situation." §0 splits custody in two: OPERATORS
-- hold the machine (accounts, mail, settings, backups); STEWARDS hold the
-- data (who may open which rack). The fence built here is that those are
-- different KINDS of principal, and the database's own referential integrity
-- refuses an operator id in a membership -- today's only authority row -- and
-- will refuse it in scope grants and recovery-holder rows when those land.
--
-- WHY A CONSTRAINT AND NOT A POLICY. §0's fence table: a constraint binds at
-- EVERY privilege level, including `psql` as the schema owner and including a
-- superuser, because PostgreSQL exempts superusers from row security but not
-- from referential integrity. `tests/principals_fence.rs` proves exactly that
-- by connecting as the most privileged role the test environment has and
-- failing to insert an operator into `memberships`. What a constraint does
-- NOT survive is `DROP CONSTRAINT` by the schema owner -- §2's own correction
-- -- which is detection (a later schema fingerprint), not prevention, and is
-- why §2 rates this fence at tier 2 rather than tier 3. Do not restate it as
-- stronger than that anywhere.
--
-- WHY A NEW FILE AND NOT AN EDIT TO 0002. Same reason 0003 is a new file:
-- 0002 is applied in dev databases and `src/migrate.rs` refuses to start
-- against a database whose recorded migration does not match the embedded
-- one. Fix forward.
--
-- WHY THIS MAY LAND WHILE `docs/OPEN-QUESTIONS.md` A1 IS OPEN. Same argument
-- 0002's header makes and `tests/no_key_protected_data.rs` enforces: every
-- table below carries identity and structure -- opaque ids, a kind
-- discriminant, a display name for an operator -- and never a design payload,
-- a device credential or a wrapped key. Nothing here is protected by the
-- master key A1 is deciding, so answering A1 later re-encrypts nothing this
-- migration writes.

-- ---------------------------------------------------------------------------
-- principals -- the one table every authority row points at.
--
-- A principal is an id and a KIND. `steward` is a person who may hold data
-- authority; `operator` is a machine-side administrator. The kind lives here,
-- once, so that there is exactly one place the answer comes from.
--
-- `UNIQUE (id, kind)` is the load-bearing line and it is not redundant with
-- the primary key. PostgreSQL requires a referenced column list to be covered
-- by a unique constraint, so without this the composite foreign keys below
-- cannot be written at all. With it, a referencing table that fixes its own
-- `kind` column to a literal can only ever match principals of that kind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS principals (
    id         text        PRIMARY KEY CHECK (char_length(id) = 26),
    kind       text        NOT NULL CHECK (kind IN ('steward', 'operator')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, kind)
);

-- Every account that already exists becomes a steward principal. There is no
-- other kind it could be: `operators` does not exist until further down this
-- file, so nothing before now could have been one. This runs before the
-- foreign key below is added, because that key would otherwise reject every
-- existing row.
--
-- THE `NO FORCE` IS NOT COSMETIC AND MUST NOT BE DELETED. 0003 put
-- `accounts` behind `FORCE ROW LEVEL SECURITY` and gave it a read policy that
-- needs `app.account_id` or `app.tenant_id`. A migration sets neither, and
-- `FORCE` is precisely the flag that stops the owning role being exempt from
-- its own policies -- so `SELECT id FROM accounts` here would return ZERO
-- rows, migrate nothing, and then fail confusingly at the foreign key below.
-- (Or, on an empty database, succeed and hide the bug until the first
-- deployment with real accounts.) The DDL either side takes an ACCESS
-- EXCLUSIVE lock on the table and the whole file runs in one transaction, so
-- no other session can read `accounts` while the force bit is off.
ALTER TABLE accounts NO FORCE ROW LEVEL SECURITY;

INSERT INTO principals (id, kind)
SELECT id, 'steward' FROM accounts
ON CONFLICT (id) DO NOTHING;

ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- accounts -- an account is a steward principal, and cannot be anything else.
--
-- `GENERATED ALWAYS AS ('steward') STORED` is a constant on purpose. The
-- column exists only to be the second half of the composite key; making it
-- generated means PostgreSQL refuses an INSERT or UPDATE that names it at all
-- ("cannot insert a non-DEFAULT value into column ... it is a generated
-- column"), so there is no value anyone -- application, `psql`, superuser --
-- can put there. A `DEFAULT` with a `CHECK` would have been weaker: a
-- superuser could still write the column and then drop the check.
--
-- Verified against PostgreSQL 16.13 on 2026-09-12: a constant generation
-- expression is accepted, the composite key binds, and an operator id is
-- refused in `accounts` for the bootstrap superuser.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS principal_kind text
        GENERATED ALWAYS AS ('steward') STORED;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_are_steward_principals
    FOREIGN KEY (id, principal_kind) REFERENCES principals (id, kind);

-- ---------------------------------------------------------------------------
-- memberships -- the only authority row that exists today.
--
-- `memberships.account_id` already references `accounts(id)`, and `accounts`
-- is now fenced to stewards, so this second key is belt to that braces. It is
-- here anyway, and it is not decoration: §2's row reads "appear in a
-- MEMBERSHIP, A SCOPE GRANT, OR A RECOVERY-HOLDER ROW", and the rule the
-- design states is that EVERY place authority is expressed references
-- `principals (id, kind)` directly rather than inheriting the property from a
-- neighbour. `scope_grants` and `recovery_holders` (migration 0005 in the
-- design's numbering, not yet written) will not reference `accounts` at all,
-- so the pattern has to be the one that works for them. Writing it here too
-- means the pattern is established, tested and copied rather than invented
-- under pressure later.
--
-- It also independently survives a change to `accounts`: if a later migration
-- ever relaxed the account fence, this row would still refuse an operator.
-- ---------------------------------------------------------------------------
ALTER TABLE memberships
    ADD COLUMN IF NOT EXISTS principal_kind text
        GENERATED ALWAYS AS ('steward') STORED;

ALTER TABLE memberships
    ADD CONSTRAINT memberships_are_held_by_steward_principals
    FOREIGN KEY (account_id, principal_kind) REFERENCES principals (id, kind);

-- ---------------------------------------------------------------------------
-- operators -- the machine-side principals.
--
-- Deliberately almost empty. §1.1's verbs, §4.5's "the operator surface has
-- no password path at all" and §1.3's read-only admin pool all describe
-- columns and behaviour that belong to migrations this task does not write
-- (`sessions`, `admin_surface`). What is needed NOW is that the kind exists
-- and is a principal, so that the fences above have something to refuse.
--
-- There is no email column: §4.5 says the operator surface has no password
-- path, so there is no reset address to hold, and a column added "for later"
-- is a column nobody can justify today.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operators (
    id             text        PRIMARY KEY CHECK (char_length(id) = 26),
    display_name   text        NOT NULL,
    principal_kind text        GENERATED ALWAYS AS ('operator') STORED,
    created_at     timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (id, principal_kind) REFERENCES principals (id, kind)
);

-- ---------------------------------------------------------------------------
-- Row-level security. Stated explicitly for both new tables, per the rule
-- that every new table has it considered out loud.
-- ---------------------------------------------------------------------------

-- principals: RLS ON.
--
-- The table is a list of every principal id in the estate. 0003's header
-- settled the equivalent question for `accounts` -- "the exposure does not
-- need id discovery: `SELECT email FROM accounts` returns every email address
-- in the estate to any tenant's transaction" -- and the same shape applies
-- here with ids and kinds in place of addresses, plus one thing `accounts`
-- does not leak: which ids are OPERATORS. A tenant transaction has no
-- business enumerating the site's administrators.
--
-- The read rule is `accounts_readable`'s, deliberately identical: the acting
-- account itself, plus anyone who shares the transaction's tenant with it.
-- The `EXISTS` reads `memberships`, which is itself protected, and
-- `memberships` has no policy referring back here, so there is no recursion.
-- Operator principals match neither branch, which is the point.
ALTER TABLE principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE principals FORCE ROW LEVEL SECURITY;

CREATE POLICY principals_readable ON principals
    FOR SELECT
    USING (
        id = current_setting('app.account_id', true)
        OR EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.account_id = principals.id
              AND m.organisation_id = current_setting('app.tenant_id', true)
        )
    );

-- **THIS IS NOT A CONTROL AND IS NOT CLAIMED AS ONE**, for exactly the reason
-- `accounts_insertable` says `true` out loud: minting a principal happens at
-- registration, before any tenant or account context exists, so every
-- condition that could be written here is one the inserting caller chooses
-- for itself. There is no authentication layer yet
-- (`docs/OPEN-QUESTIONS.md` B1-B9, C2); when there is, this is where it
-- binds, and that is the diff to look for.
--
-- Note what this policy does NOT weaken: a caller who inserts
-- `(id, 'operator')` here has created an operator principal and has gained
-- nothing, because the generated columns above mean that id can never reach
-- `accounts` or `memberships`. The fence is the foreign key, not this.
CREATE POLICY principals_insertable ON principals
    FOR INSERT
    WITH CHECK (true);

-- No UPDATE and no DELETE policy, deliberately. With row security forced and
-- no policy for a command, that command reaches no rows at all -- so a
-- principal's kind cannot be flipped, and a principal cannot be removed, from
-- the application plane at any time. Nothing in the repository layer needs
-- either today, and "the database refuses until someone writes the rule in
-- the same diff as the code" is 0003's rule for `accounts` applied here.

-- operators: RLS ON, and NO POLICY AT ALL in this migration.
--
-- That is not an oversight and it is the strongest available default: with
-- row security enabled and forced, a table with no policy returns no rows and
-- accepts no writes for ANY non-superuser role, including the role that owns
-- it and runs these migrations. The operator register is created here so the
-- kind exists and the fences above have something to refuse; the paths that
-- read it (the admin surface) and write it (genesis, §6.3) land with their
-- own migrations and bring their own rules with them. Migration 0005 adds one
-- `FOR SELECT` policy for the operator database role and nothing else.
ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators FORCE ROW LEVEL SECURITY;
