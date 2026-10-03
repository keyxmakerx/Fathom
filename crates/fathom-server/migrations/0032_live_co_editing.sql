-- 0032 -- live co-editing storage (ADR-0063).
--
-- `design_change` holds one accepted change per row, sealed like a payload
-- (same key, a different associated-data tag). `design_checkpoint` holds the
-- head as a full face at a version, written by the server: derived from
-- chained data, so no chain entry and not a version. A change takes the next
-- version number and has a `change` entry on the design chain; "the current
-- version" is the highest across `design_payload` and `design_change`.
--
-- Invariant 11: this migration reads no existing table, so there is no
-- backfill to wrap. The `NO FORCE` / `FORCE` pair around the `chain_entries`
-- constraint is load-bearing: `ADD CONSTRAINT` revalidates existing rows, and
-- under forced row-level security a migration would see none of them.

CREATE TABLE IF NOT EXISTS design_change (
    design_id              text        NOT NULL,
    organisation_id        text        NOT NULL,
    design_version         bigint      NOT NULL CHECK (design_version >= 2),
    batch_id               text        NOT NULL CHECK (char_length(batch_id) = 26),
    -- Keyed (chain content key) digest of the change document: an unkeyed one
    -- would let a dump holder test a guessed change. For idempotency only.
    body_digest            bytea       NOT NULL CHECK (octet_length(body_digest) = 32),
    ciphertext             bytea       NOT NULL,
    nonce                  bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    key_epoch              int         NOT NULL CHECK (key_epoch >= 1),
    wrap_version           int         NOT NULL CHECK (wrap_version >= 1),
    aead_alg_id            smallint    NOT NULL CHECK (aead_alg_id >= 1),
    payload_schema_version int         NOT NULL CHECK (payload_schema_version >= 1),
    created_at             timestamptz NOT NULL DEFAULT now(),
    created_by             text        NOT NULL REFERENCES accounts(id),

    PRIMARY KEY (design_id, design_version),
    UNIQUE (design_id, batch_id),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (design_id, key_epoch) REFERENCES design_keys (design_id, key_epoch)
);

CREATE TABLE IF NOT EXISTS design_checkpoint (
    design_id              text        NOT NULL,
    organisation_id        text        NOT NULL,
    design_version         bigint      NOT NULL CHECK (design_version >= 2),
    ciphertext             bytea       NOT NULL,
    nonce                  bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    key_epoch              int         NOT NULL CHECK (key_epoch >= 1),
    wrap_version           int         NOT NULL CHECK (wrap_version >= 1),
    aead_alg_id            smallint    NOT NULL CHECK (aead_alg_id >= 1),
    payload_schema_version int         NOT NULL CHECK (payload_schema_version >= 1),
    created_at             timestamptz NOT NULL DEFAULT now(),
    written_by             text        NOT NULL REFERENCES accounts(id),

    PRIMARY KEY (design_id, design_version),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (design_id, key_epoch) REFERENCES design_keys (design_id, key_epoch)
);

-- Row-level security exactly as `design_payload`'s: the tenant and the design
-- capability, on every command that exists. No DELETE.
ALTER TABLE design_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_change FORCE ROW LEVEL SECURITY;
CREATE POLICY design_change_readable ON design_change
    FOR SELECT USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
CREATE POLICY design_change_insertable ON design_change
    FOR INSERT WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
CREATE POLICY design_change_updatable ON design_change
    FOR UPDATE USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes')
            WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');

ALTER TABLE design_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY design_checkpoint_readable ON design_checkpoint
    FOR SELECT USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
CREATE POLICY design_checkpoint_insertable ON design_checkpoint
    FOR INSERT WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
CREATE POLICY design_checkpoint_updatable ON design_checkpoint
    FOR UPDATE USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes')
            WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');

-- The `change` entry type, on design chains only. Mirrored by
-- `EntryType::kinds()` in `src/chain.rs`.
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
                                -- This file's section A.
                                'operator_adopted'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced',
                                'firmware_staged', 'firmware_fetch_issued',
                                'firmware_fetch_redeemed'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- NOTIFY, so every process hears of a write whichever process made it.
--
-- `fathom_live` carries `design_id:version` and nothing else: a change or a
-- whole save committed. `fathom_authority` carries a scope and an id only
-- (`org:`, `session:`, `account:`) and fires on authority changes (the head
-- advancing covers grants, secondings, suspensions and revocations), a
-- member leaving, a session ending or an account being disabled. Never on a
-- session's per-request `last_seen_at`. `pg_notify` inside a trigger is
-- delivered at commit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fathom_notify_design_version() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    PERFORM pg_notify('fathom_live', NEW.design_id || ':' || NEW.design_version::text);
    RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS design_change_notify ON design_change;
CREATE TRIGGER design_change_notify
    AFTER INSERT ON design_change
    FOR EACH ROW EXECUTE FUNCTION fathom_notify_design_version();

DROP TRIGGER IF EXISTS design_payload_notify ON design_payload;
CREATE TRIGGER design_payload_notify
    AFTER INSERT ON design_payload
    FOR EACH ROW EXECUTE FUNCTION fathom_notify_design_version();

-- TG_ARGV[0] is the scope word, TG_ARGV[1] the column holding its id.
CREATE OR REPLACE FUNCTION fathom_notify_authority() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
DECLARE
    row_json jsonb;
BEGIN
    IF TG_OP = 'DELETE' THEN
        row_json := to_jsonb(OLD);
    ELSE
        row_json := to_jsonb(NEW);
    END IF;
    PERFORM pg_notify('fathom_authority', TG_ARGV[0] || ':' || (row_json ->> TG_ARGV[1]));
    RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS organisation_auth_head_notify ON organisation_auth_head;
CREATE TRIGGER organisation_auth_head_notify
    AFTER INSERT OR UPDATE ON organisation_auth_head
    FOR EACH ROW EXECUTE FUNCTION fathom_notify_authority('org', 'organisation_id');

DROP TRIGGER IF EXISTS memberships_notify ON memberships;
CREATE TRIGGER memberships_notify
    AFTER UPDATE OR DELETE ON memberships
    FOR EACH ROW EXECUTE FUNCTION fathom_notify_authority('org', 'organisation_id');

-- No trigger on `sessions` (tests/operators.rs: the evidence-key check must stay
-- a constraint). The code that ends a session sends the NOTIFY itself, in the
-- same transaction: `sessions::notify_session_ended`.

DROP TRIGGER IF EXISTS session_revocations_notify ON session_revocations;
CREATE TRIGGER session_revocations_notify
    AFTER INSERT ON session_revocations
    FOR EACH ROW EXECUTE FUNCTION fathom_notify_authority('session', 'session_id');

DROP TRIGGER IF EXISTS accounts_disabled_notify ON accounts;
CREATE TRIGGER accounts_disabled_notify
    AFTER UPDATE OF disabled_at ON accounts
    FOR EACH ROW WHEN (OLD.disabled_at IS DISTINCT FROM NEW.disabled_at)
    EXECUTE FUNCTION fathom_notify_authority('account', 'id');
