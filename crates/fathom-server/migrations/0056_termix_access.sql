-- 0056 -- Termix, switched off by a steward (ADR-0078 decision 6; the owner, 27 October 2026:
-- "termix would also be per user, but disallowable per admin or the steward").
--
-- Termix is already per person: each person pastes their own Termix API key, and Fathom's server
-- never holds one. The operator turns it off for the whole deployment by leaving
-- FATHOM_TERMIX_URL unset. These two tables let a steward turn it off inside one organisation:
-- for everyone in it (`organisation_termix`), or for one person (`member_termix`).
--
-- It is a product switch, not a security boundary. While it is off the client hides "Open in
-- Termix" and "Send to Termix" and the server does not give out the address, but a person who
-- knows the address can still open Termix in another tab with their own key. Taking someone's
-- Termix away is done in Termix, by its admin revoking their key (`src/termix.rs` says so too).
--
-- No row reads as allowed. Removing the membership removes the person's row. The app role never
-- deletes a row, and may change only the switch and who set it when. Read and written in the
-- tenant's own context only.

CREATE TABLE IF NOT EXISTS organisation_termix (
    organisation_id  text        PRIMARY KEY,
    termix_off       boolean     NOT NULL,
    set_by           text        NOT NULL REFERENCES accounts(id),
    set_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS member_termix (
    organisation_id  text        NOT NULL,
    account_id       text        NOT NULL,
    termix_off       boolean     NOT NULL,
    set_by           text        NOT NULL REFERENCES accounts(id),
    set_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, account_id),
    FOREIGN KEY (account_id, organisation_id)
        REFERENCES memberships (account_id, organisation_id) ON DELETE CASCADE
);

ALTER TABLE organisation_termix ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_termix FORCE ROW LEVEL SECURITY;
ALTER TABLE member_termix ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_termix FORCE ROW LEVEL SECURITY;

REVOKE DELETE, UPDATE ON organisation_termix FROM fathom_app;
REVOKE DELETE, UPDATE ON member_termix FROM fathom_app;
GRANT UPDATE (termix_off, set_by, set_at) ON organisation_termix TO fathom_app;
GRANT UPDATE (termix_off, set_by, set_at) ON member_termix TO fathom_app;

CREATE POLICY organisation_termix_tenant ON organisation_termix
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY member_termix_tenant ON member_termix
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- ENTRY TYPE: `termix_access_set`, on the organisation chain: who switched Termix off or on, for
-- everyone or for whom. The list is 0051's plus this one; mirrored by `EntryType::kinds()` in
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
                                'account_renamed'))
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
                                -- This file.
                                'termix_access_set'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
