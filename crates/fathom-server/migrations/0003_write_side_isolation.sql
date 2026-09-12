-- 0003 -- the WRITE side of tenant isolation, and row-level security on
-- `accounts`.
--
-- Creates no table. Every statement below is an access rule.
--
-- WHY THIS IS A NEW FILE AND NOT AN EDIT TO 0002. 0002 is applied in dev
-- databases, and `src/migrate.rs` refuses to start against a database whose
-- recorded migration does not match the embedded one. Fixing an applied
-- migration forward is the rule that gate exists to enforce.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
--
-- A `CREATE POLICY` with `USING` and no `WITH CHECK` is `FOR ALL` by default,
-- and PostgreSQL then REUSES the `USING` expression as the `WITH CHECK` for
-- every write. `memberships_isolation`'s `USING` carries
--
--     OR account_id = current_setting('app.account_id', true)
--
-- which is there so "list the organisations I belong to" can run before a
-- tenant has been picked at all -- a READ. As a write check it said: any
-- transaction may insert a membership granting its own account any role in
-- ANY organisation. Reproduced end to end on 2026-09-12, scoped entirely to
-- tenant B: `INSERT INTO memberships (account_id, organisation_id, role)
-- VALUES (<account B>, <organisation A>, 'admin')` succeeded and committed.
-- The foreign key does not stop it: PostgreSQL runs referential-integrity
-- checks with row security bypassed.
--
-- It defeated BOTH layers at once, which is the part that matters.
-- `repo::require_membership` is a plain `SELECT 1 FROM memberships`, so the
-- forged row satisfied the application check too, and `add_member`,
-- `list_members`, `create_scope`, `list_subtree` and `move_subtree` all then
-- accepted that account for the other tenant.
--
-- A `WITH CHECK (organisation_id = current_setting('app.tenant_id', true))`
-- on the existing `FOR ALL` policy WOULD HAVE BEEN NOT ENOUGH, and this is
-- the reason the policy is split by command below. It closes the INSERT and
-- leaves the UPDATE open: the `account_id` branch still makes the acting
-- account's OWN membership row -- in whatever organisation it is really in --
-- visible to `USING`, so
--
--     UPDATE memberships SET organisation_id = <tenant B>, role = 'admin'
--      WHERE account_id = <the acting account>
--
-- passes a tenant-equality `WITH CHECK` (the NEW row's organisation IS the
-- transaction's tenant) and moves the attacker into tenant B as an admin.
-- Also reproduced, 2026-09-12, before this migration: `UPDATE 1`, and the row
-- read back as admin of an organisation the account had never belonged to.
--
-- So: the `account_id` branch is a READ rule, and it is now `FOR SELECT`
-- only. Every write path -- insert, update, delete -- is tenant equality and
-- nothing else, on both sides.

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS memberships_isolation ON memberships;

-- Read: the tenant's own rows, plus the acting account's own rows in any
-- organisation, which is what `repo::list_organisations_for_account` needs
-- before any tenant has been chosen.
CREATE POLICY memberships_readable ON memberships
    FOR SELECT
    USING (
        organisation_id = current_setting('app.tenant_id', true)
        OR account_id = current_setting('app.account_id', true)
    );

-- Write: this transaction's tenant, and only it. `WITH CHECK` governs the
-- row as it will be; `USING` governs which rows an UPDATE or DELETE may
-- reach at all. Both are needed, and both are tenant equality: an UPDATE
-- with a tenant-equal `WITH CHECK` and an account-branch `USING` is exactly
-- the escalation described above.
CREATE POLICY memberships_insertable ON memberships
    FOR INSERT
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY memberships_updatable ON memberships
    FOR UPDATE
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY memberships_deletable ON memberships
    FOR DELETE
    USING (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- organisations
--
-- The reuse here was already harmless -- the `EXISTS` branch cannot be
-- satisfied for an organisation id that does not exist yet, because a
-- membership row for a non-existent organisation cannot exist, so the only
-- insertable id was the caller's own tenant setting. Confirmed rather than
-- assumed (`tests/repo.rs`, cross-tenant INSERT case 3), and then written
-- out anyway: a policy whose write rule is implicit is one nobody can check
-- by reading it.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS organisations_isolation ON organisations;

CREATE POLICY organisations_readable ON organisations
    FOR SELECT
    USING (
        id = current_setting('app.tenant_id', true)
        OR EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.organisation_id = organisations.id
              AND m.account_id = current_setting('app.account_id', true)
        )
    );

CREATE POLICY organisations_insertable ON organisations
    FOR INSERT
    WITH CHECK (id = current_setting('app.tenant_id', true));

CREATE POLICY organisations_updatable ON organisations
    FOR UPDATE
    USING (id = current_setting('app.tenant_id', true))
    WITH CHECK (id = current_setting('app.tenant_id', true));

CREATE POLICY organisations_deletable ON organisations
    FOR DELETE
    USING (id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- scopes
--
-- Genuinely harmless before this migration: the reused expression is already
-- tenant equality, so read and write said the same thing. Restated with an
-- explicit `WITH CHECK` for the same reason as `organisations` -- so the
-- write rule is readable, and so a later edit to the `USING` half cannot
-- silently change what a write is allowed to do.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS scopes_isolation ON scopes;

CREATE POLICY scopes_isolation ON scopes
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- accounts
--
-- 0002 left this table with row-level security neither enabled nor forced,
-- on the argument that nothing lets a transaction discover an account id it
-- is not already entitled to. THE EXPOSURE DOES NOT NEED ID DISCOVERY:
-- `SELECT email FROM accounts` returns every email address in the estate to
-- any tenant's transaction. That is the whole table, read by anyone.
--
-- An account is still not owned by one organisation, so the rule cannot be
-- `organisation_id = ...`. It is: the acting account itself, plus anyone who
-- shares the transaction's tenant with it. The `EXISTS` reads `memberships`,
-- which is itself row-level-security protected, and correctly so -- the
-- subquery sees only membership rows this transaction may see, which for a
-- tenant-scoped transaction is that tenant's own. `memberships` has no
-- policy referring back to `accounts`, so there is no recursion.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY accounts_readable ON accounts
    FOR SELECT
    USING (
        id = current_setting('app.account_id', true)
        OR EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.account_id = accounts.id
              AND m.organisation_id = current_setting('app.tenant_id', true)
        )
    );

-- **THIS IS NOT A CONTROL AND IS NOT CLAIMED AS ONE.** Creating an account
-- is registration: it happens before any tenant or account context exists,
-- so there is no stored fact to check the row against, and every condition
-- that could be written here is one the inserting caller chooses for itself.
-- Saying `true` out loud is more honest than a condition that looks like a
-- rule and is not. THERE IS NO AUTHENTICATION LAYER YET
-- (`docs/OPEN-QUESTIONS.md` B1-B9, C2); when there is, this policy is where
-- it binds, and that is the diff to look for.
CREATE POLICY accounts_insertable ON accounts
    FOR INSERT
    WITH CHECK (true);

-- No UPDATE or DELETE policy, deliberately: with row security forced and no
-- policy for a command, that command reaches no rows at all. Nothing in the
-- repository layer updates or deletes an account today, so the safe thing is
-- for the database to refuse until something does and a rule is written for
-- it in the same diff.
