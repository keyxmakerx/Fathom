-- 0073 -- reading a device: the SNMPv3 engines people confirmed, what each read found, and the
-- differences someone dismissed (ADR-0082 §4.2 and §4.6; sign-off r90 and r100, the owner,
-- 2 November 2026). Number 0073, claimed through the layout thread after 0072 (plan approvals).
--
-- Everything a device answered, and every address, is sealed. The key is derived from the tenant
-- key by HKDF under its own label `fathom/device-reading/v1` (`src/device_reading.rs`), so it
-- opens nothing else and nothing else opens these rows. In the clear: ids, the design and element
-- a reading belongs to, who read or approved and when, a state word, and the key epoch.
--
-- A. ENGINES. Before Fathom sends a login to an SNMPv3 agent, someone confirms the agent's engine
--   id: anyone with Draw by typing its last 8 characters for one device, or a Steward for a whole
--   range at once (r90 "keys": A, bulk per range). One row per management address, found by an
--   HMAC of the address under the reading key, so the address itself is never in the clear.
--   `seen` an agent answered and nobody has confirmed it; `approved` confirmed; `changed` an
--   approved agent now answers with another id, which must be confirmed on its own and is never
--   approved with the rest of a range.
--
-- B. READINGS. One row per read of one device: `device` (system, inventory, interfaces, LLDP) or
--   `macarp` (MAC and ARP tables, read on request, r91). Kept as the latest few plus what changed
--   (r90): `src/device_reading.rs` deletes a device's older rows past the newest ten of each kind.
--   The sealed body is the reader's answer after the redaction gate's detector ran over every
--   string in it (CLAUDE.md rule 4; ADR-0082 §4.2).
--
-- C. DISMISSALS. A difference someone dismissed stays dismissed until the device's value
--   changes (r100 "dismiss": A): the field and the value read, sealed, per device.
--
-- D. Entry types: 0072's list plus `device_read_done`, `device_read_engine_approved` and
--   `device_read_dismissed`. Whichever migration merges after this must carry them forward.

-- ---------------------------------------------------------------------------
-- A. device_read_engines
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_read_engines (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    address_mac      bytea       NOT NULL CHECK (octet_length(address_mac) = 32),
    state            text        NOT NULL CHECK (state IN ('seen', 'approved', 'changed')),
    key_epoch        integer     NOT NULL,
    sealed           bytea       NOT NULL CHECK (octet_length(sealed) BETWEEN 17 AND 4096),
    nonce            bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    seen_by          text        NOT NULL REFERENCES accounts(id),
    seen_at          timestamptz NOT NULL DEFAULT now(),
    approved_by      text        NULL REFERENCES accounts(id),
    approved_at      timestamptz NULL,
    PRIMARY KEY (organisation_id, address_mac)
);

ALTER TABLE device_read_engines ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_read_engines FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE ON device_read_engines FROM fathom_app;

CREATE POLICY device_read_engines_tenant ON device_read_engines
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- B. device_readings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_readings (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id               text        NOT NULL CHECK (char_length(id) = 26),
    design_id        text        NOT NULL CHECK (char_length(design_id) = 26),
    element_id       text        NOT NULL CHECK (char_length(element_id) BETWEEN 1 AND 64),
    kind             text        NOT NULL CHECK (kind IN ('device', 'macarp')),
    read_by          text        NOT NULL REFERENCES accounts(id),
    read_at          timestamptz NOT NULL DEFAULT now(),
    chain_seq        bigint      NOT NULL,
    key_epoch        integer     NOT NULL,
    sealed           bytea       NOT NULL CHECK (octet_length(sealed) BETWEEN 17 AND 4194304),
    nonce            bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    PRIMARY KEY (organisation_id, id)
);

CREATE INDEX IF NOT EXISTS device_readings_device_idx
    ON device_readings (organisation_id, design_id, element_id, kind, read_at DESC);

ALTER TABLE device_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_readings FORCE ROW LEVEL SECURITY;
REVOKE UPDATE, TRUNCATE ON device_readings FROM fathom_app;

CREATE POLICY device_readings_tenant ON device_readings
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- C. device_read_dismissals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_read_dismissals (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    design_id        text        NOT NULL CHECK (char_length(design_id) = 26),
    element_id       text        NOT NULL CHECK (char_length(element_id) BETWEEN 1 AND 64),
    field_mac        bytea       NOT NULL CHECK (octet_length(field_mac) = 32),
    key_epoch        integer     NOT NULL,
    sealed           bytea       NOT NULL CHECK (octet_length(sealed) BETWEEN 17 AND 8192),
    nonce            bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    dismissed_by     text        NOT NULL REFERENCES accounts(id),
    dismissed_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, design_id, element_id, field_mac)
);

ALTER TABLE device_read_dismissals ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_read_dismissals FORCE ROW LEVEL SECURITY;
REVOKE TRUNCATE ON device_read_dismissals FROM fathom_app;

CREATE POLICY device_read_dismissals_tenant ON device_read_dismissals
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- D. ENTRY TYPES. 0072's list plus this file's three; mirrored by `EntryType::kinds()` in
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
                                -- 0067.
                                'device_read_set',
                                -- 0071.
                                'team_role_defined',
                                -- 0072.
                                'plan_rule_set', 'plan_approval_signed',
                                -- This file.
                                'device_read_done', 'device_read_engine_approved',
                                'device_read_dismissed'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
