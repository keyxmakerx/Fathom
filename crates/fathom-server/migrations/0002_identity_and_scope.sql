-- 0002 — accounts, organisations, membership, and the scope hierarchy.
--
-- WHY THIS MAY LAND WHILE A1 IS STILL OPEN. `tests/no_key_protected_data.rs`
-- (formerly `stores_nothing.rs`) used to forbid every table but the
-- migrations table, because ADR-0040 requires a data key per tenant AND per
-- design from the first stored byte, and `docs/OPEN-QUESTIONS.md` A1 --
-- "where does the master key live" -- is still open. That gate does not lift
-- here; it narrows. Every table below carries identity or structure, never a
-- design payload, a credential, or a wrapped key -- nothing here is protected
-- by the master key A1 is deciding, so nothing here needs A1 answered first,
-- and answering A1 later will not require re-encrypting a single row this
-- migration writes. `docs/PHASE-2-STORAGE-DESIGN.md` §1 already draws this
-- line: "Identity" and "Structure" are listed there as "Low -- must be
-- queryable", separately from "Designs" and "Vault", which stay behind the
-- gate.
--
-- THE ONE COLUMN THIS REASONING DOES NOT FULLY COVER: `display_name` on
-- `organisations` and `scopes`. `docs/OPEN-QUESTIONS.md` V2 was DECIDED IN
-- PRINCIPLE 2026-09-12 -- yes, a design or scope name is to be encrypted at
-- rest -- but that same record says the column "does not exist yet and
-- cannot until A1 lands", because there is no key to encrypt it under until
-- the master-key question is answered. This migration is what creates the
-- column for the first time, so it is PLAINTEXT here, deliberately, exactly
-- as V2 anticipates. It is a plain column specifically so that later change
-- stays cheap: the path below is built entirely from opaque scope ids, never
-- from this column, so encrypting `display_name` once A1 lands is a
-- column-level change, not a structural one. Nothing in this migration is a
-- second plaintext copy of it -- V2's binding rule ("no server-side surface
-- may keep a plaintext copy" once the encrypted column exists) is about not
-- proliferating additional copies in audit rows, notifications or exports,
-- none of which this migration creates.

-- ---------------------------------------------------------------------------
-- Accounts -- a person. How an account proves who it is (password, passkey,
-- SSO) is not decided (`docs/OPEN-QUESTIONS.md` B1-B9, C2) and this task
-- writes no crypto, so there is no credential column here at all -- this
-- table is who someone IS, not how they prove it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id           text        PRIMARY KEY CHECK (char_length(id) = 26),
    email        text        NOT NULL UNIQUE,
    display_name text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Organisations -- the tenant boundary. Everything else in this file, and
-- everything the vault and design tables will hold later, hangs off an
-- `organisation_id`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organisations (
    id           text        PRIMARY KEY CHECK (char_length(id) = 26),
    -- PLAINTEXT ON PURPOSE, FOR NOW -- see the file header and
    -- `docs/OPEN-QUESTIONS.md` V2. Not this task's call.
    display_name text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Memberships -- an account's role inside one organisation. Roles are
-- deliberately minimal (brief: "enough to distinguish who may administer an
-- organisation from who may use it; the full permission model is not this
-- task").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memberships (
    account_id      text        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    role            text        NOT NULL CHECK (role IN ('admin', 'member')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, organisation_id)
);

CREATE INDEX IF NOT EXISTS memberships_organisation_idx ON memberships (organisation_id);
CREATE INDEX IF NOT EXISTS memberships_account_idx ON memberships (account_id);

-- ---------------------------------------------------------------------------
-- Scopes -- the hierarchy: organisation -> network -> building -> rack
-- (`docs/PHASE-2-STORAGE-DESIGN.md` §2). `organisations` is the root; this
-- table holds the three levels beneath it, each row one node.
--
-- THE PATH IS MADE OF OPAQUE IDS, NEVER NAMES (§11.3). `path` is a
-- dot-separated chain of this table's own `id` values, root-first, ending in
-- the row's own id -- e.g. a rack's path is
-- `<network id>.<building id>.<rack id>`. A prefix match on `path` answers
-- both questions presence and permission ask ("who else is at this exact
-- node", "does this transaction have rights at or above this node") in one
-- indexed comparison, per §2. Nothing human-readable is ever concatenated
-- into it: that is what lets a subtree move (which rewrites every
-- descendant's path -- §2's stated cost) stay a rewrite of opaque tokens,
-- never a rewrite that also touches a name.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scopes (
    id              text        PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    parent_scope_id text        REFERENCES scopes(id) ON DELETE CASCADE,
    kind            text        NOT NULL CHECK (kind IN ('network', 'building', 'rack')),
    -- PLAINTEXT ON PURPOSE, FOR NOW -- see the file header and
    -- `docs/OPEN-QUESTIONS.md` V2.
    display_name    text        NOT NULL,
    path            text        NOT NULL,
    depth           smallint    NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- A network is the root of its own tree; buildings and racks are not.
    CHECK ((kind = 'network') = (parent_scope_id IS NULL)),
    -- depth and kind move together: 1/network, 2/building, 3/rack. Enforced
    -- here as well as in the repository layer, which is what actually
    -- computes both -- this is the belt to that braces.
    CHECK (
        (kind = 'network' AND depth = 1) OR
        (kind = 'building' AND depth = 2) OR
        (kind = 'rack' AND depth = 3)
    ),
    UNIQUE (organisation_id, path)
);

-- `text_pattern_ops` so `path LIKE $1 || '.%'` (subtree listing, presence and
-- permission prefix checks) uses the index regardless of locale.
CREATE INDEX IF NOT EXISTS scopes_org_path_idx
    ON scopes (organisation_id, path text_pattern_ops);
CREATE INDEX IF NOT EXISTS scopes_parent_idx ON scopes (parent_scope_id);

-- ---------------------------------------------------------------------------
-- Tenant isolation, per `docs/PHASE-2-STORAGE-DESIGN.md` §7: row-level
-- security IN ADDITION TO application filtering, never instead of it.
--
-- THE TRAP THIS AVOIDS, NAMED IN `src/db.rs`: "a pool hands out whichever
-- connection is free, so nothing may depend on which one." A session-level
-- `SET` would set a tenant on a connection and leave it there for whichever
-- request the pool hands that connection to next. Every policy below reads
-- `current_setting('app.tenant_id', true)` -- and the repository layer sets
-- it with `SELECT set_config('app.tenant_id', $1, true)`, where the third
-- argument, `true`, is `is_local` -- i.e. `SET LOCAL`, scoped to the
-- transaction that calls it and gone the instant that transaction ends,
-- commit or rollback, never carried by the connection afterwards.
--
-- `FORCE ROW LEVEL SECURITY`: without it, a table's OWNER is exempt from its
-- own policies, and the role migrations run as is that owner. This makes the
-- policies bind for that role too. It still does **not** bind for an actual
-- Postgres superuser -- Postgres exempts superusers from row security
-- unconditionally, `FORCE` or not. The role this server connects as must not
-- be a superuser for any of this to mean anything; see the repository
-- layer's tests for how the test database's role is provisioned deliberately
-- non-superuser, and see the work reported back for the deployment-role
-- question this raises for `deploy/compose.yaml`, which this task does not
-- touch.
-- ---------------------------------------------------------------------------

ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisations FORCE ROW LEVEL SECURITY;

-- An organisation is visible in a transaction scoped to it (`app.tenant_id`),
-- or to any transaction acting as an account that is a member of it
-- (`app.account_id`) -- the second branch is what lets "list the
-- organisations I belong to" run before a tenant has been picked at all.
CREATE POLICY organisations_isolation ON organisations
    USING (
        id = current_setting('app.tenant_id', true)
        OR EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.organisation_id = organisations.id
              AND m.account_id = current_setting('app.account_id', true)
        )
    );

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY memberships_isolation ON memberships
    USING (
        organisation_id = current_setting('app.tenant_id', true)
        OR account_id = current_setting('app.account_id', true)
    );

ALTER TABLE scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopes FORCE ROW LEVEL SECURITY;

-- Scopes carry no membership of their own to bootstrap from, so this is the
-- plain case: visible only inside a transaction scoped to the owning tenant.
CREATE POLICY scopes_isolation ON scopes
    USING (organisation_id = current_setting('app.tenant_id', true));

-- `accounts` deliberately carries no RLS policy. An account is not owned by
-- one organisation -- it can belong to several -- so it is not tenant data in
-- the sense §7 means, and there is no single `organisation_id` to filter it
-- by. What protects it is `memberships`: nothing above lets a transaction
-- discover an account id it does not already have except through a
-- membership row it is already entitled to see.
