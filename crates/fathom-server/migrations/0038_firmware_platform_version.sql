-- 0038 -- a firmware image may say which platform it is for and which release it is.
--
-- Both optional: an image declared before this migration, or without them, keeps
-- the old behaviour (Junos commands, no label). They are labels for an operator and
-- for choosing which vendor's upgrade steps `src/firmware.rs` renders. Neither is
-- ever joined to a path or a device: nothing here holds a device credential
-- (ADR-0045 §4), and the declared hash is still only a claim.
--
-- `platform` is a short slug (`junos`, `junos-evo`, `ios-xe`, `nx-os`, `eos`, ...).
-- `version` is the release string as the vendor writes it (`21.4R3-S5.5`,
-- `17.09.04a`, `10.3(4a)`, `4.32.2F`), kept to a charset that cannot become a
-- second command in a line an operator pastes into a switch.
--
-- The app role may INSERT these (table-level INSERT is unchanged) and may not
-- UPDATE them: `0017` grants UPDATE on named columns only, and these are not named.
-- (`models`, below, is the exception.)

ALTER TABLE firmware_images
    ADD COLUMN IF NOT EXISTS platform text
        CHECK (platform ~ '^[a-z0-9-]{1,32}$'),
    ADD COLUMN IF NOT EXISTS version text
        CHECK (char_length(version) BETWEEN 1 AND 64
               AND version ~ '^[A-Za-z0-9.()_-]+$');

-- ---------------------------------------------------------------------------
-- MODELS: which catalogue models an image is for (one image can cover several,
-- e.g. EX2300-24P and EX2300-48P). Up to 16 ids, each 1 to 64 characters of
-- letters, digits and `- _ . / +`, no duplicates. A function because a CHECK
-- cannot hold a subquery. Unlike platform and version, models may be REPLACED
-- later by a steward, so UPDATE on this one column is granted and the change is
-- sealed as `firmware_models_changed` (section below).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION firmware_models_ok(models text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $fn$
    SELECT models IS NOT NULL
       AND coalesce(array_ndims(models), 1) = 1
       AND cardinality(models) <= 16
       AND NOT EXISTS (SELECT 1 FROM unnest(models) AS m
                        WHERE m IS NULL OR m !~ '^[A-Za-z0-9._/+-]{1,64}$')
       AND (SELECT count(DISTINCT m) FROM unnest(models) AS m) = cardinality(models)
$fn$;

ALTER TABLE firmware_images
    ADD COLUMN IF NOT EXISTS models text[] NOT NULL DEFAULT '{}'
        CHECK (firmware_models_ok(models));

GRANT UPDATE (models) ON firmware_images TO fathom_app;

-- ---------------------------------------------------------------------------
-- ENTRY TYPE: `firmware_models_changed`, on the organisation chain. The list is
-- 0037's plus this one; mirrored by `EntryType::kinds()` in `src/chain.rs`.
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
                                'firmware_models_changed'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
