-- 0075 -- orders (ADR-0084 piece 2, sign-off r103 and r105). An organisation's order types, the
-- orders opened from them, and each order's history.
--
-- An order type is a Steward's YAML file (`crates/fathom-orders`), stored as written with the
-- team each of its slugs was matched to. An order is its type at one version plus everything
-- done on it: the engine replays the history to know where the order stands, so the history is
-- the record and nothing else is.
--
-- Everything people wrote is sealed under the organisation content key, as a design's own words
-- are: the file, every answer, every reason. In the clear: ids, the order's W- number, the type
-- and version it was opened from, who acted and when, the action word, a status word, and the
-- key epoch. The server decides on those; it decides on nothing it would have to read text for.
--
-- A. ORDER TYPES. One row per saved version; a new save is a new version, and an order keeps
--   the version it was opened from. Append-only.
--
-- B. ORDERS. One row per order. Only `status` and `updated_at` change, as the history moves;
--   an order is never deleted.
--
-- C. ORDER EVENTS. One row per thing done on an order, in order. Append-only, and each is
--   filed on the organisation chain (`order_event`, ids and the action word only).
--
-- D. Entry types: 0073's list plus `order_type_saved` and `order_event`. Whichever migration
--   merges after this must carry them forward.

-- ---------------------------------------------------------------------------
-- A. order_types
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_types (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id               text        NOT NULL CHECK (char_length(id) = 26),
    version          integer     NOT NULL CHECK (version >= 1),
    saved_by         text        NOT NULL REFERENCES accounts(id),
    saved_at         bigint      NOT NULL,
    chain_seq        bigint      NOT NULL CHECK (chain_seq >= 1),
    key_epoch        integer     NOT NULL CHECK (key_epoch >= 1),
    ciphertext       bytea       NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 1048576),
    nonce            bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    PRIMARY KEY (organisation_id, id, version)
);

CREATE TRIGGER order_types_append_only
    BEFORE UPDATE OR DELETE ON order_types
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
CREATE TRIGGER order_types_no_truncate
    BEFORE TRUNCATE ON order_types
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

ALTER TABLE order_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_types FORCE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE, TRUNCATE ON order_types FROM fathom_app;

CREATE POLICY order_types_tenant ON order_types
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- B. orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id               text        NOT NULL CHECK (char_length(id) = 26),
    number           bigint      NOT NULL CHECK (number >= 1),
    type_id          text        NOT NULL,
    type_version     integer     NOT NULL,
    opened_by        text        NOT NULL REFERENCES accounts(id),
    opened_at        bigint      NOT NULL,
    status           text        NOT NULL CHECK (status IN ('open', 'done', 'cancelled')),
    updated_at       bigint      NOT NULL,
    PRIMARY KEY (organisation_id, id),
    UNIQUE (organisation_id, number),
    FOREIGN KEY (organisation_id, type_id, type_version)
        REFERENCES order_types (organisation_id, id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS orders_status_idx
    ON orders (organisation_id, status, number DESC);

-- Only the status and when it last moved change; who opened it, from what, and its number never
-- do, and an order is never deleted.
CREATE OR REPLACE FUNCTION fathom_orders_only_status_moves() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP <> 'UPDATE'
       OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.number IS DISTINCT FROM OLD.number
       OR NEW.type_id IS DISTINCT FROM OLD.type_id
       OR NEW.type_version IS DISTINCT FROM OLD.type_version
       OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
       OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
       OR OLD.status <> 'open'
    THEN
        RAISE EXCEPTION 'an order only moves from open to done or cancelled'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER orders_only_status_moves
    BEFORE UPDATE OR DELETE ON orders
    FOR EACH ROW EXECUTE FUNCTION fathom_orders_only_status_moves();
CREATE TRIGGER orders_no_truncate
    BEFORE TRUNCATE ON orders
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE ON orders FROM fathom_app;

CREATE POLICY orders_tenant ON orders
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- C. order_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_events (
    organisation_id  text        NOT NULL,
    order_id         text        NOT NULL,
    seq              integer     NOT NULL CHECK (seq >= 1),
    at               bigint      NOT NULL,
    -- NULL when the engine acted on the order's behalf (a plan was recorded, a clock ran out).
    by_account       text        NULL REFERENCES accounts(id),
    action           text        NOT NULL CHECK (action IN (
                         'open', 'answer', 'pick_up', 'tick', 'link_plan', 'finish',
                         'send_back', 'cancel', 'approve', 'cancel_order')),
    chain_seq        bigint      NOT NULL CHECK (chain_seq >= 1),
    key_epoch        integer     NOT NULL CHECK (key_epoch >= 1),
    ciphertext       bytea       NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 262144),
    nonce            bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    PRIMARY KEY (organisation_id, order_id, seq),
    FOREIGN KEY (organisation_id, order_id) REFERENCES orders (organisation_id, id)
        ON DELETE RESTRICT
);

CREATE TRIGGER order_events_append_only
    BEFORE UPDATE OR DELETE ON order_events
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
CREATE TRIGGER order_events_no_truncate
    BEFORE TRUNCATE ON order_events
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events FORCE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE, TRUNCATE ON order_events FROM fathom_app;

CREATE POLICY order_events_tenant ON order_events
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- D. ENTRY TYPES. 0073's list plus this file's two; mirrored by `EntryType::kinds()` in
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
                                -- 0073.
                                'device_read_done', 'device_read_engine_approved',
                                'device_read_dismissed',
                                -- This file.
                                'order_type_saved', 'order_event'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
