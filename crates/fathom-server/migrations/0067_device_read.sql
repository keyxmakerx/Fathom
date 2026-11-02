-- 0067 -- device reading switched on by a Steward, and the management ranges it may reach
-- (ADR-0082 §4.4; card r76-device-reading, questions 2 and 3, A; the owner, 2 November 2026).
--
-- Reading is off twice by default. The server operator allows it with FATHOM_DEVICE_READ=on
-- (`src/config.rs`); without that no organisation can turn it on. Then a Steward turns it on for
-- their organisation here, and lists the management ranges a read may go to, such as
-- 10.20.0.0/24, each with the SNMP and SSH ports to use there. A read goes only to a device's
-- management address inside a listed range; loopback, link-local, multicast and unspecified
-- addresses are refused whatever is listed (`src/device_read.rs`). Without the list anyone with
-- Draw could type any address on a device and have the server reach it.
--
-- One row per organisation. `ranges` is the canonical JSON array `src/device_read.rs` writes and
-- checks again when it reads, at most 64 entries. No row reads as off with no ranges. The app
-- role never deletes a row and may change only the switch, the ranges and who set them when. Read
-- and written in the tenant's own context only, as `0056`'s Termix switch is.
--
-- **Audited.** Every change is sealed on the organisation chain as `device_read_set`, with the
-- switch and the whole list after it, and who made it.
--
-- Number 0067, claimed through the layout ledger after 0064 (Work), 0065 (IP plan) and 0066
-- (teams). Section B re-lists the entry types from 0066's list plus 0065's, so whichever lands
-- in which order, none is dropped.

CREATE TABLE IF NOT EXISTS organisation_device_read (
    organisation_id  text        PRIMARY KEY,
    reading_on       boolean     NOT NULL,
    ranges           text        NOT NULL CHECK (char_length(ranges) BETWEEN 2 AND 16384),
    set_by           text        NOT NULL REFERENCES accounts(id),
    set_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organisation_device_read ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_device_read FORCE ROW LEVEL SECURITY;

REVOKE DELETE, UPDATE ON organisation_device_read FROM fathom_app;
GRANT UPDATE (reading_on, ranges, set_by, set_at) ON organisation_device_read TO fathom_app;

CREATE POLICY organisation_device_read_tenant ON organisation_device_read
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- B. ENTRY TYPE: `device_read_set` on the organisation chain. The list is 0066's plus 0065's
-- plus this one; mirrored by `EntryType::kinds()` in `src/chain.rs`.
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
                                -- 0062.
                                'firmware_ceiling_changed',
                                'firmware_org_settings_changed',
                                -- 0065.
                                'ipam_record_created', 'ipam_record_changed',
                                'ipam_record_deleted',
                                -- 0066.
                                'team_created', 'team_renamed', 'team_deleted',
                                'team_member_added', 'team_member_removed',
                                'team_role_set', 'team_role_cleared',
                                'team_grant_signed', 'team_grant_revoked',
                                -- This file.
                                'device_read_set'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
