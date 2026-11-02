-- 0065 -- The IP plan store (ADR-0083 decisions 1, 3 and 5).
--
-- Aggregates, prefixes, ranges, addresses, reservations, VRFs, route targets, VLAN groups and
-- VLANs, ASN ranges and ASNs, kept per organisation beside the designs (`src/ipam.rs`). Every
-- field is declared in `schema/schema.yaml`'s `plan` layer (schema 0.36).
--
-- **Nothing readable is stored.** `ipam_records.sealed` is one record's fields, encrypted under a
-- key derived from the tenant key with the store's own label. In the clear: the record's id, its
-- kind, its folder (a scope id, as `designs.scope_id` is), a version counter and the tenant key
-- epoch it was sealed under.
--
-- **The database refuses a clash.** `ipam_unique.space` is a keyed hash of a record's VRF and
-- network, written for a record in a VRF that enforces unique space and for anything handed out
-- by next free; its primary key makes a duplicate impossible even if two servers race
-- (decision 5). The database learns which records share a network, the cost ADR-0079 accepted for
-- search.
--
-- **Asking twice gives the same answer.** `ipam_allocations.key` is a keyed hash of what asked for
-- a block (`W-1042/wan`), with the record it was given and the parent it came from.
--
-- 0064 is the Work tab's (sign-off r74); this follows it.

CREATE TABLE IF NOT EXISTS ipam_records (
    organisation_id text        NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
    id              text        NOT NULL CHECK (char_length(id) = 26),
    kind            text        NOT NULL CHECK (kind IN ('vrf', 'route_target', 'aggregate',
                                                         'prefix', 'range', 'address',
                                                         'reservation', 'vlan_group', 'vlan',
                                                         'asn_range', 'asn')),
    folder_id       text        NULL,
    version         bigint      NOT NULL CHECK (version >= 1),
    key_epoch       integer     NOT NULL CHECK (key_epoch >= 1),
    sealed          bytea       NOT NULL,
    nonce           bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    created_at      timestamptz NOT NULL DEFAULT now(),
    changed_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, id)
);

CREATE INDEX IF NOT EXISTS ipam_records_folder_idx
    ON ipam_records (organisation_id, folder_id);

CREATE TABLE IF NOT EXISTS ipam_unique (
    organisation_id text    NOT NULL,
    space           bytea   NOT NULL CHECK (octet_length(space) = 32),
    record_id       text    NOT NULL,
    PRIMARY KEY (organisation_id, space),
    FOREIGN KEY (organisation_id, record_id)
        REFERENCES ipam_records (organisation_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ipam_unique_record_idx
    ON ipam_unique (organisation_id, record_id);

CREATE TABLE IF NOT EXISTS ipam_allocations (
    organisation_id text    NOT NULL,
    key             bytea   NOT NULL CHECK (octet_length(key) = 32),
    record_id       text    NOT NULL,
    parent_id       text    NOT NULL,
    PRIMARY KEY (organisation_id, key),
    FOREIGN KEY (organisation_id, record_id)
        REFERENCES ipam_records (organisation_id, id) ON DELETE CASCADE
);

ALTER TABLE ipam_records     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ipam_records     FORCE  ROW LEVEL SECURITY;
ALTER TABLE ipam_unique      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ipam_unique      FORCE  ROW LEVEL SECURITY;
ALTER TABLE ipam_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ipam_allocations FORCE  ROW LEVEL SECURITY;

-- A hash or an allocation is written and deleted, never changed.
REVOKE TRUNCATE ON ipam_records FROM fathom_app;
REVOKE UPDATE, TRUNCATE ON ipam_unique FROM fathom_app;
REVOKE UPDATE, TRUNCATE ON ipam_allocations FROM fathom_app;

CREATE POLICY ipam_records_select ON ipam_records FOR SELECT
    USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ipam_records_insert ON ipam_records FOR INSERT
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ipam_records_update ON ipam_records FOR UPDATE
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ipam_records_delete ON ipam_records FOR DELETE
    USING (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY ipam_unique_select ON ipam_unique FOR SELECT
    USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ipam_unique_insert ON ipam_unique FOR INSERT
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ipam_unique_delete ON ipam_unique FOR DELETE
    USING (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY ipam_allocations_select ON ipam_allocations FOR SELECT
    USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ipam_allocations_insert ON ipam_allocations FOR INSERT
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ipam_allocations_delete ON ipam_allocations FOR DELETE
    USING (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- ENTRY TYPES: `ipam_record_created`, `ipam_record_changed` and `ipam_record_deleted` on the
-- organisation's chain. The list is 0062's plus these; mirrored by `EntryType::kinds()` in
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
                                -- This file.
                                'ipam_record_created', 'ipam_record_changed',
                                'ipam_record_deleted'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
