-- 0040 -- "type it yourself" (sign-off card r30-nocopy, approved 25 October 2026).
--
-- A teaching setting for one person in one organisation. While it is on, the
-- client shows commands to be typed by hand: no copy buttons on them, the command
-- text not selectable, and each command broken into labelled parts. Links and
-- hashes still copy. It is a teaching aid, not a control: anyone can still read a
-- page's text another way, and nothing here claims otherwise.
--
-- It is not a capability, so it is not a grant (`grants.rs`): it changes what the
-- client draws, never what the server allows. A steward of any folder in the
-- organisation sets it either way for anyone in it; a person may switch it on for
-- themselves, never off (`src/teaching.rs` decides; the table only holds it).
--
-- One row per member once anyone has set it; no row reads as off. Removing the
-- membership removes the row. The app role never deletes one, and may change
-- only the setting and who set it when.

CREATE TABLE IF NOT EXISTS member_teaching (
    organisation_id  text        NOT NULL,
    account_id       text        NOT NULL,
    type_it_yourself boolean     NOT NULL,
    set_by           text        NOT NULL REFERENCES accounts(id),
    set_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, account_id),
    FOREIGN KEY (account_id, organisation_id)
        REFERENCES memberships (account_id, organisation_id) ON DELETE CASCADE
);

ALTER TABLE member_teaching ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_teaching FORCE ROW LEVEL SECURITY;

REVOKE DELETE, UPDATE ON member_teaching FROM fathom_app;
GRANT UPDATE (type_it_yourself, set_by, set_at) ON member_teaching TO fathom_app;

-- Read: the tenant's rows, plus the acting account's own row in any organisation,
-- which `GET /organisations` reads before any tenant is chosen (as `memberships`).
CREATE POLICY member_teaching_readable ON member_teaching
    FOR SELECT USING (
        organisation_id = current_setting('app.tenant_id', true)
        OR account_id = current_setting('app.account_id', true)
    );
CREATE POLICY member_teaching_insertable ON member_teaching
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY member_teaching_updatable ON member_teaching
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- ENTRY TYPE: `type_it_yourself_set`, on the organisation chain: who set it for
-- whom, on or off. The list is 0038's plus this one; mirrored by
-- `EntryType::kinds()` in `src/chain.rs`.
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
                                -- This file's section F.
                                'invitation_issued', 'invitation_closed',
                                -- 0038.
                                'firmware_models_changed',
                                -- This file.
                                'type_it_yourself_set'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
