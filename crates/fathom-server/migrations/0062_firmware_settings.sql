-- 0062 -- firmware's limits set on the Admin and Steward pages, not only in the server's
-- settings file (sign-off r71, 2026-10-31; the owner: "make that env variables for the firmware
-- thing admin controlled or even like dynamic ... the org steward would need to control but admins
-- need to have say and especially control over much of that ... both need auditing").
--
-- Three rows, three writers:
--
--   firmware_server_settings  one row, the admin's (the operator plane). Each column NULL means
--                             "the server's settings file says": FATHOM_FIRMWARE_* gives the
--                             starting values (r71 "file", A), and a saved value wins. The
--                             largest image, the server's total, the default ceiling for every
--                             organisation, uploads at once (server and organisation), the stall
--                             time and the address devices download from.
--   firmware_org_ceilings     one row per organisation the admin has set apart: a ceiling of its
--                             own, and a lock that stops its Stewards changing their total, with a
--                             reason they see.
--   firmware_org_settings     one row per organisation, its Stewards': their own total, which can
--                             only be under the ceiling, and the address THEIR devices download
--                             from when it differs from the server's (the owner's note on r71: a
--                             Steward "on the fly" names the address their network reaches).
--                             Read and written in the tenant's own context, as `0056`'s Termix
--                             switch is. The admin's lock stops both.
--
-- **Audited three ways.** Every change is sealed on a chain with who made it and the old and new
-- values: the admin's server settings on the site chain (`firmware_server_settings_changed`), an
-- admin's ceiling or lock on BOTH the site chain and the organisation's
-- (`firmware_ceiling_changed`, as `ai_key_disabled` is filed on both), so the organisation's
-- Stewards see it, and a Steward's own total on the organisation's chain
-- (`firmware_org_settings_changed`). The two admin rows also carry a row seal under the site row
-- key, bound to the chain entry that wrote them, so a value edited in PostgreSQL directly does not
-- verify and the server refuses to use it.
--
-- No row reads as "everything from the settings file". The app role never deletes a row.

CREATE TABLE IF NOT EXISTS firmware_server_settings (
    id                        text        PRIMARY KEY CHECK (id = 'site'),
    max_image_bytes           bigint      CHECK (max_image_bytes IS NULL OR max_image_bytes >= 1),
    total_max_bytes           bigint      CHECK (total_max_bytes IS NULL OR total_max_bytes >= 1),
    organisation_max_bytes    bigint      CHECK (organisation_max_bytes IS NULL OR organisation_max_bytes >= 1),
    uploads_per_server        integer     CHECK (uploads_per_server IS NULL OR uploads_per_server BETWEEN 1 AND 64),
    uploads_per_organisation  integer     CHECK (uploads_per_organisation IS NULL OR uploads_per_organisation BETWEEN 1 AND 64),
    upload_idle_seconds       integer     CHECK (upload_idle_seconds IS NULL OR upload_idle_seconds BETWEEN 10 AND 3600),
    fetch_base_url            text        CHECK (fetch_base_url IS NULL OR char_length(fetch_base_url) BETWEEN 8 AND 300),
    changed_by                text        NOT NULL,
    changed_at                timestamptz NOT NULL DEFAULT now(),
    changed_seq               bigint      NOT NULL CHECK (changed_seq >= 1),
    row_version               integer     NOT NULL CHECK (row_version >= 1),
    row_seal                  bytea       NOT NULL CHECK (octet_length(row_seal) = 32)
);

CREATE TABLE IF NOT EXISTS firmware_org_ceilings (
    organisation_id  text        PRIMARY KEY,
    ceiling_bytes    bigint      CHECK (ceiling_bytes IS NULL OR ceiling_bytes >= 1),
    locked           boolean     NOT NULL,
    lock_reason      text        CHECK (lock_reason IS NULL OR char_length(lock_reason) BETWEEN 1 AND 300),
    changed_by       text        NOT NULL,
    changed_at       timestamptz NOT NULL DEFAULT now(),
    changed_seq      bigint      NOT NULL CHECK (changed_seq >= 1),
    row_version      integer     NOT NULL CHECK (row_version >= 1),
    row_seal         bytea       NOT NULL CHECK (octet_length(row_seal) = 32)
);

CREATE TABLE IF NOT EXISTS firmware_org_settings (
    organisation_id  text        PRIMARY KEY,
    max_bytes        bigint      CHECK (max_bytes IS NULL OR max_bytes >= 1),
    fetch_base_url   text        CHECK (fetch_base_url IS NULL OR char_length(fetch_base_url) BETWEEN 8 AND 300),
    set_by           text        NOT NULL REFERENCES accounts(id),
    set_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE firmware_server_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmware_server_settings FORCE  ROW LEVEL SECURITY;
ALTER TABLE firmware_org_ceilings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmware_org_ceilings    FORCE  ROW LEVEL SECURITY;
ALTER TABLE firmware_org_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmware_org_settings    FORCE  ROW LEVEL SECURITY;

-- The server's limits are no secret: an upload in any organisation reads them.
CREATE POLICY firmware_server_settings_readable ON firmware_server_settings
    FOR SELECT USING (true);
CREATE POLICY firmware_server_settings_insertable ON firmware_server_settings
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY firmware_server_settings_updatable ON firmware_server_settings
    FOR UPDATE USING (current_setting('app.operator_custody', true) = 'yes')
            WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
REVOKE DELETE ON firmware_server_settings FROM fathom_app;

-- An organisation reads its own ceiling; the operator plane reads and writes every one.
CREATE POLICY firmware_org_ceilings_readable ON firmware_org_ceilings
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true)
                      OR current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY firmware_org_ceilings_insertable ON firmware_org_ceilings
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY firmware_org_ceilings_updatable ON firmware_org_ceilings
    FOR UPDATE USING (current_setting('app.operator_custody', true) = 'yes')
            WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
REVOKE DELETE ON firmware_org_ceilings FROM fathom_app;

-- The Stewards' own row: the tenant's context only, and the operator plane may read it to show
-- the admin what each organisation chose.
REVOKE DELETE, UPDATE ON firmware_org_settings FROM fathom_app;
GRANT UPDATE (max_bytes, fetch_base_url, set_by, set_at) ON firmware_org_settings TO fathom_app;
CREATE POLICY firmware_org_settings_tenant ON firmware_org_settings
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY firmware_org_settings_operator_reads ON firmware_org_settings
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes');

-- ---------------------------------------------------------------------------
-- ENTRY TYPES: `firmware_server_settings_changed` on the site chain, `firmware_ceiling_changed`
-- on the site chain and the organisation's, and `firmware_org_settings_changed` on the
-- organisation's. The list is 0060's plus these; mirrored by `EntryType::kinds()` in
-- `src/chain.rs`.
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
                                'operator_adopted',
                                -- 0046.
                                'ai_switch_changed', 'ai_key_disabled',
                                -- 0049.
                                'account_renamed',
                                -- 0062.
                                'firmware_server_settings_changed',
                                'firmware_ceiling_changed'))
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
                                'type_it_yourself_set',
                                -- 0042.
                                'vault_key_enrolled', 'vault_key_superseded',
                                'vault_entry_created', 'vault_shared',
                                'vault_share_revoked', 'vault_entry_deleted',
                                'vault_recovery_used',
                                -- 0043.
                                'vault_mode_changed', 'vault_read',
                                -- 0044.
                                'vault_breach_policy_set',
                                -- 0045.
                                'vault_outside_changed', 'vault_outside_read',
                                -- 0046.
                                'ai_policy_changed', 'ai_key_made', 'ai_key_changed',
                                'ai_key_disabled', 'ai_recommendation_decided',
                                -- 0051.
                                'design_moved',
                                -- 0056.
                                'termix_access_set',
                                -- 0060.
                                'firmware_retired',
                                -- This file.
                                'firmware_ceiling_changed',
                                'firmware_org_settings_changed'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
