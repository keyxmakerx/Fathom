-- 0043 -- breach checks for stored logins (ADR-0071 part three; owner's round-32 answers: breach
-- A with a weekly re-check, "make sure the checks can be per org, or even like per type of
-- passwords", 25 October).
--
-- The check runs in a browser that holds the login: it sends the first five hex characters of
-- the password's SHA-1 to the Have I Been Pwned range API, with padding, and compares the rest
-- itself. The password and the rest of its hash never leave that browser. What the server keeps
-- is the policy and, per login and epoch, the answer: found in a breach or not, and when.
--
-- The policy has three levels, the most specific winning:
--   1. a login marked critical: checked, re-checked every 7 days, a breached password refused;
--   2. a kind of login (device login, SNMP, Wi-Fi, API key, other), when the organisation set one;
--   3. the organisation: on or off, how often to re-check, warn or refuse.
-- No row at any level means off. The levels are resolved in one place on each side
-- (`src/vault_breach.rs`'s `effective`, `client/src/vault/breach.ts`'s `effectivePolicy`).
--
-- **A refusal is the browser's.** The server never sees the password, so it cannot check one; it
-- records what a holder's browser found. The interface and OPERATING.md say so.
--
-- As in 0041: no default privileges, every table granted by name, tenant-pinned row security,
-- no DELETE.

-- ---------------------------------------------------------------------------
-- A. THE POLICY -- the organisation's row (kind = '*') and one row per kind it has ever set
--
-- A kind that goes back to "same as the organisation" keeps its row with `inherit` true: there is
-- no DELETE. The organisation's own row never inherits; no row at all means off.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.breach_policy (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    kind            text        NOT NULL CHECK (kind IN ('*', 'login', 'snmp', 'wifi', 'api', 'other')),
    enabled         boolean     NOT NULL,
    interval_days   integer     NOT NULL CHECK (interval_days BETWEEN 1 AND 365),
    action          text        NOT NULL CHECK (action IN ('warn', 'refuse')),
    inherit         boolean     NOT NULL DEFAULT false,
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,
    updated_by      text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, kind),
    CHECK (kind <> '*' OR NOT inherit),
    FOREIGN KEY (updated_by, principal_kind) REFERENCES principals (id, kind)
);

-- ---------------------------------------------------------------------------
-- B. A LOGIN MARKED CRITICAL -- the owner or an admin marks it; not secret, and not in the
-- sealed metadata, because the policy is resolved from it.
-- ---------------------------------------------------------------------------
ALTER TABLE vault.entries ADD COLUMN IF NOT EXISTS critical boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- C. THE ANSWERS -- one row per login and epoch: a new epoch (a changed password) starts unchecked
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.breach_results (
    organisation_id text        NOT NULL,
    entry_id        text        NOT NULL,
    epoch           integer     NOT NULL CHECK (epoch >= 1),
    found           boolean     NOT NULL,
    checked_by      text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,
    checked_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, entry_id, epoch),
    FOREIGN KEY (organisation_id, entry_id) REFERENCES vault.entries (organisation_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (checked_by, principal_kind) REFERENCES principals (id, kind)
);

-- ---------------------------------------------------------------------------
-- D. GRANTS AND ROW SECURITY
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON vault.breach_policy, vault.breach_results TO fathom_app;
GRANT UPDATE (enabled, interval_days, action, inherit, updated_by, updated_at)
    ON vault.breach_policy TO fathom_app;
GRANT UPDATE (found, checked_by, checked_at) ON vault.breach_results TO fathom_app;
GRANT UPDATE (critical) ON vault.entries TO fathom_app;

ALTER TABLE vault.breach_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.breach_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE vault.breach_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.breach_results FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vault_breach_policy_readable ON vault.breach_policy;
CREATE POLICY vault_breach_policy_readable ON vault.breach_policy
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_breach_policy_insertable ON vault.breach_policy;
CREATE POLICY vault_breach_policy_insertable ON vault.breach_policy
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND updated_by = current_setting('app.account_id', true));
DROP POLICY IF EXISTS vault_breach_policy_updatable ON vault.breach_policy;
CREATE POLICY vault_breach_policy_updatable ON vault.breach_policy
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND updated_by = current_setting('app.account_id', true));

DROP POLICY IF EXISTS vault_breach_results_readable ON vault.breach_results;
CREATE POLICY vault_breach_results_readable ON vault.breach_results
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_breach_results_insertable ON vault.breach_results;
CREATE POLICY vault_breach_results_insertable ON vault.breach_results
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND checked_by = current_setting('app.account_id', true));
DROP POLICY IF EXISTS vault_breach_results_updatable ON vault.breach_results;
CREATE POLICY vault_breach_results_updatable ON vault.breach_results
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND checked_by = current_setting('app.account_id', true));

-- ---------------------------------------------------------------------------
-- E. ONE MORE ORGANISATION-CHAIN ENTRY TYPE
--
-- `vault_breach_policy_set`: an admin changed the policy, or someone marked a login critical or
-- not. Turning checks off is an act on the organisation's history like any other setting. The
-- answers themselves are not chain entries: there is one per login per week. The list below is
-- 0042's, plus this. Mirrored by `EntryType::kinds()` in `src/chain.rs`.
-- ---------------------------------------------------------------------------
ALTER TABLE chain_entries NO FORCE ROW LEVEL SECURITY;

ALTER TABLE chain_entries
    DROP CONSTRAINT IF EXISTS chain_entries_type_belongs_to_kind;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_type_belongs_to_kind
    CHECK (
        (chain_kind = 'design'
             AND entry_type IN ('create', 'update', 'reencrypt', 'change'))
     OR (chain_kind = 'site'
             AND entry_type IN ('deployment_started', 'shipper_gap',
                                'spool_pressure', 'rewrap',
                                'account_signin', 'account_signin_failed',
                                'account_signed_out',
                                'operator_signin', 'operator_signin_failed',
                                'operator_signed_out',
                                'account_disabled', 'account_enabled',
                                'account_created',
                                'operator_bootstrapped', 'operator_created',
                                'operator_seconded', 'operator_enrolled',
                                'operator_disabled', 'operator_read',
                                'enrolment_token_issued', 'enrolment_token_redeemed',
                                'enrolment_token_expired',
                                'authenticator_registered',
                                'org_shell_created',
                                'setting_requested', 'setting_seconded',
                                'setting_applied', 'setting_cancelled',
                                'setting_unresolvable', 'single_operator_mode',
                                'grant_suspended',
                                'password_set', 'totp_enrolled',
                                'reset_requested', 'reset_spent',
                                'backup_code_used',
                                'operator_recovered_from_host',
                                'console_placement_requested',
                                'console_placement_confirmed',
                                'console_placement_reverted',
                                'operator_key_enrolled',
                                'operator_seat_hold_cleared',
                                'operator_adopted'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced',
                                'firmware_staged', 'firmware_fetch_issued',
                                'firmware_fetch_redeemed',
                                'invitation_issued', 'invitation_closed',
                                'firmware_models_changed',
                                -- 0041.
                                'vault_key_enrolled', 'vault_key_superseded',
                                'vault_entry_created', 'vault_shared',
                                'vault_share_revoked', 'vault_entry_deleted',
                                'vault_recovery_used',
                                -- 0042.
                                'vault_mode_changed', 'vault_read',
                                -- 0043.
                                'vault_breach_policy_set'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
