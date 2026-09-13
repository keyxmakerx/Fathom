-- 0005 -- two database roles: the application plane and the operator plane.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.3 and §11.1's `planes`
-- migration, ordered second by §15.6: "two roles, withheld grants, read-only
-- admin pool. Closes tier-2 crudeness. No friction."
--
-- NUMBERED 0005, NOT 0009. §11.1 numbered this file 0009 on the assumption
-- that `authority`, `sessions`, `admin_surface` and `chains` would land
-- first. None of them exist. §15.6 reorders the build so that this one comes
-- second, and a migration's number is its position in the chain, not a
-- reservation. The design's `0005 authority` is a later number now.
--
-- ---------------------------------------------------------------------------
-- THE FENCE IS THE WITHHELD GRANT, NOT A POLICY
-- ---------------------------------------------------------------------------
--
-- §0's fence table rates `Grant` above `Constraint` for this job for one
-- reason: **PostgreSQL checks table privileges before it evaluates row
-- security**, so a privilege the role does not hold cannot be reasoned around
-- by any policy expression anyone writes later. That ordering is a behaviour
-- claim, and under CLAUDE.md rule 1 it is not asserted from memory here --
-- `tests/planes.rs` drives it against a real PostgreSQL and reads the answer
-- off the run.
--
-- So the operator plane's protection against reading a design is that it has
-- **no `SELECT` privilege on any table holding design data**, and PostgreSQL
-- grants nothing on a newly created table to anybody. A design table added
-- next year is therefore born unreadable by this role without anyone
-- remembering to come back here, and `tests/planes.rs` enumerates the live
-- schema rather than a hand-kept list so that the claim is checked table by
-- table on every run.
--
-- NOT IN SCOPE, BECAUSE THE TABLE DOES NOT EXIST YET: §11.1's third fence,
-- the `app.design_capability` policy on `design_payload`. It lands in the
-- same migration as `design_payload` itself -- a policy cannot be written
-- against a table that does not exist, and writing it later, separately, is
-- how a payload table ships for a week without one.
--
-- ---------------------------------------------------------------------------
-- EVERY POLICY BELOW IS `FOR SELECT`. NONE IS `FOR ALL`. THIS IS THE RULE
-- THAT 0003 WAS WRITTEN TO FIX AND IT IS NOT NEGOTIABLE.
-- ---------------------------------------------------------------------------
--
-- `CREATE POLICY ... USING (...)` with no `FOR` clause is `FOR ALL`, and
-- PostgreSQL then REUSES the `USING` expression as the `WITH CHECK` for every
-- write. Read `migrations/0003_write_side_isolation.sql`'s header: that is
-- exactly how `memberships_isolation`'s read branch became "any transaction
-- may insert a membership granting its own account any role in any
-- organisation", reproduced end to end on 2026-09-12.
--
-- The same defect with a new name would be an operator-plane policy written
-- `FOR ALL`: read as a write check, `USING (true)` says *"any operator
-- transaction may insert any membership row it likes"* -- which is the
-- takeover this whole design exists to refuse. `tests/planes.rs` asserts two
-- things about it: that every policy added here has `cmd = 'SELECT'` in
-- `pg_policies`, and, behaviourally, that an INSERT into `memberships` from
-- an operator transaction is refused. That second test grants the missing
-- privilege inside a transaction it then rolls back, so that the refusal it
-- observes comes from the POLICY layer underneath rather than from the
-- privilege layer above it -- and it carries a positive control showing that
-- with a `FOR ALL` policy in place the same INSERT succeeds.
--
-- ---------------------------------------------------------------------------
-- WHY THE MIGRATION NEEDS `CREATEROLE`, AND WHAT THAT COSTS
-- ---------------------------------------------------------------------------
--
-- `CREATE ROLE` needs the `CREATEROLE` attribute, and the role that runs
-- these migrations -- `fathom` in `deploy/init-db/10-app-role.sh`,
-- `fathom_test` in `.github/workflows/ci.yml` -- deliberately has almost
-- nothing else. It is granted `CREATEROLE` there, and the honest accounting
-- is this: that role already OWNS every table in this database, so it can
-- already `DROP POLICY`, `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` and
-- read every row. `CREATEROLE` adds the ability to create further roles --
-- persistence for an attacker who already holds the credential, not an
-- escalation of what that credential can read. Set against it: the roles and
-- their grants stay IN the migration chain, so "run the chain from an empty
-- database" produces the whole fence, and a future migration can add a grant
-- for a new table in the same file that creates it.
--
-- The alternative -- provisioning the role out of band in the init script --
-- splits the fence across two artifacts, one of which only ever runs against
-- a freshly created data directory.
--
-- `fathom_operator` is created `NOLOGIN` and with no password. Nothing can
-- connect as it until a deployment deliberately gives it one, which happens
-- when the read-only admin pool lands (§1.3). Creating it now is what lets
-- the grants and the policies be written, tested and held to a rule before
-- anything depends on them.
--
-- THE NAME. §1.3 writes this role `fathom_admin`. It is `fathom_operator`
-- here because `memberships.role` already has the value `admin`, and an
-- `admin` there is a STEWARD -- the exact confusion §0 spends a page
-- separating. `.context/conventions.md` binds terminology to identifiers, and
-- the design's own word for this principal kind is `operator`.

-- ---------------------------------------------------------------------------
-- The application plane is unchanged.
--
-- `fathom` (in tests, `fathom_test`) owns every table in this database and
-- therefore already holds every privilege on all of them; §1.3's explicit
-- `GRANT ... TO fathom_app` list describes a deployment where the application
-- role is NOT the owner, which is a change to `deploy/init-db/` and to how
-- migrations are run, not a change to this file. Restating those grants here
-- would add a list that drifts from the table set and controls nothing.
-- `src/rls.rs` already refuses to start if that role is a superuser or
-- carries BYPASSRLS, which is what makes every policy in 0002-0004 bind for
-- it despite the ownership.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The operator plane.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fathom_operator') THEN
        -- NOLOGIN: see the header. NOINHERIT: this role inherits nothing from
        -- anything later granted to it, so a future `GRANT some_role TO
        -- fathom_operator` cannot silently widen it.
        CREATE ROLE fathom_operator NOLOGIN NOINHERIT;
    END IF;
END
$$;

-- A role is a cluster-wide object and privileges are per-database, so a
-- cluster where this migration has already run for another database arrives
-- here with the role present and no grants. Start from nothing, explicitly,
-- rather than assuming the starting point.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fathom_operator;
REVOKE ALL ON SCHEMA public FROM fathom_operator;

GRANT USAGE ON SCHEMA public TO fathom_operator;

-- `SELECT` ONLY, AND ON EXACTLY FIVE TABLES. §1.3: "The admin pool is
-- read-only. Every administrative WRITE goes through an application endpoint
-- on the application role, which writes the row and its chain entry in one
-- transaction." An earlier draft of that section granted `INSERT` to the
-- admin role and thereby handed a tier-2 attacker every two-operator control
-- in the document. There is no `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` or
-- `REFERENCES` below, for any table, and `tests/planes.rs` fails if one
-- appears.
--
-- Each grant is here because a verb in §1.1 needs it:
--   organisations -- "list organisations"; §1.2 keeps organisation display
--                    names readable because support and billing need to know
--                    which customer they are looking at.
--   scopes        -- "their scope tree shape". §1.2: opaque ids and shape,
--                    never a readable name, once V2's encryption lands.
--   memberships   -- "members ... the permission map". Read, never written:
--                    §1.1 is explicit that granting is not an operator verb.
--   accounts      -- "create an account shell", "send a reset link to an
--                    account's ADDRESS OF RECORD", "disable / re-enable an
--                    account". All three need to see the account.
--   operators     -- the operator register itself.
--
-- `principals` is deliberately NOT granted: `accounts`, `operators` and
-- `memberships` already answer every question the admin surface asks, and a
-- grant nobody needs is a policy nobody needs, which is one fewer place for
-- the 0003 failure mode to live.
GRANT SELECT ON organisations, scopes, memberships, accounts, operators
    TO fathom_operator;

-- ---------------------------------------------------------------------------
-- Five policies, one per granted table, all `FOR SELECT`, all role-targeted.
--
-- WHY A POLICY IS NEEDED AT ALL. §11.2: `authorise_operator` sets
-- `app.operator_id` and has NO argument from which it could set
-- `app.tenant_id`. Because that setting stays empty, every policy in 0002 and
-- 0003 evaluates to zero rows for an operator transaction -- so an operator
-- plane with grants and no policies reads nothing whatsoever. These policies
-- are how the admin pages get their rows. They are not the fence; the
-- withheld grant above is.
--
-- WHY `TO fathom_operator` AND NOT A `current_setting` BRANCH. A policy keyed
-- on a transaction-local setting is one the application plane can also
-- satisfy by setting it. A role-targeted policy cannot be reached by the
-- application plane at all, because policy applicability is decided by role
-- membership, not by a value the session chooses.
--
-- WHY THE `current_user` GUARD AS WELL. Role applicability is evaluated with
-- `has_privs_of_role`, which follows INHERIT. On PostgreSQL 16 a role created
-- by a `CREATEROLE` role is granted back to its creator with
-- `inherit_option = false` -- verified on 16.13, 2026-09-12, by reading
-- `pg_auth_members` and by confirming the owning role reads zero rows through
-- one of these policies. On earlier majors that option does not exist and the
-- member role's own `rolinherit` decides, which would make these policies
-- apply to the application plane and hand it `USING (true)` over every
-- tenant. The guard removes the dependency on which major is running: the
-- policy adds rows only when the transaction is actually ACTING as the
-- operator role.
--
-- `USING (true)` beyond that guard is honest rather than lazy. §1.1's first
-- verb is "list organisations, their scope tree shape, members, grants and
-- capability map" across the whole estate; there is no narrower true
-- statement to write. What keeps this from being a hole is that the role
-- holds `SELECT` on five tables and nothing else.
-- ---------------------------------------------------------------------------
CREATE POLICY organisations_readable_by_operator_plane ON organisations
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');

CREATE POLICY scopes_readable_by_operator_plane ON scopes
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');

CREATE POLICY memberships_readable_by_operator_plane ON memberships
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');

CREATE POLICY accounts_readable_by_operator_plane ON accounts
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');

-- `operators` had no policy at all after 0004 -- see that file's closing
-- comment. This is the one it gets, and it is the same shape as the other
-- four: the operator register is readable by the operator plane and by
-- nothing else, and is still writable by nobody.
CREATE POLICY operators_readable_by_operator_plane ON operators
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');
