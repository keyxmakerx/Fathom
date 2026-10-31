-- 0060 -- a steward can retire a firmware image: its file is deleted and its record stays
-- (sign-off r62, ADR-0064's 2026-10-31 amendment).
--
-- Nothing has ever removed an image, on purpose (`0017`: "nothing deletes an image row"), so the
-- space firmware takes only grew. Retiring is the way out that keeps the history: the row stays,
-- with what was staged, by whom, and every fetch of it on the organisation's chain, and moves to
-- the new state `retired`. The file is deleted after the row commits, so the only disagreement a
-- crash can leave is a retired row whose file is still on disk, which serves nothing (the fetch
-- route sends `staged` images only) and is the safe one, as in `0017` §A.
--
-- A retired image is never staged again. Upload it afresh to bring it back.

ALTER TABLE firmware_images DROP CONSTRAINT IF EXISTS firmware_images_state_check;
ALTER TABLE firmware_images
    ADD CONSTRAINT firmware_images_state_check
    CHECK (state IN ('declared', 'staged', 'failed', 'retired'));

-- `0017` tied the computed hash, `staged_at` and `staged_seq` to `state = 'staged'` exactly.
-- A retired image keeps all three (they are what was staged), so the three checks become
-- "staged or retired". `0017` left them unnamed; PostgreSQL named them in order, and these are
-- those names.
ALTER TABLE firmware_images DROP CONSTRAINT IF EXISTS firmware_images_check;
ALTER TABLE firmware_images DROP CONSTRAINT IF EXISTS firmware_images_check1;
ALTER TABLE firmware_images DROP CONSTRAINT IF EXISTS firmware_images_check2;
ALTER TABLE firmware_images
    ADD CONSTRAINT firmware_images_hash_when_staged
        CHECK ((state IN ('staged', 'retired')) = (computed_sha256 IS NOT NULL)),
    ADD CONSTRAINT firmware_images_staged_at_when_staged
        CHECK ((state IN ('staged', 'retired')) = (staged_at IS NOT NULL)),
    ADD CONSTRAINT firmware_images_staged_seq_when_staged
        CHECK ((state IN ('staged', 'retired')) = (staged_seq IS NOT NULL));

ALTER TABLE firmware_images
    ADD COLUMN IF NOT EXISTS retired_at timestamptz,
    ADD COLUMN IF NOT EXISTS retired_seq bigint,
    ADD CONSTRAINT firmware_images_retired_whole
        CHECK ((state = 'retired') = (retired_at IS NOT NULL AND retired_seq IS NOT NULL));

GRANT UPDATE (retired_at, retired_seq) ON firmware_images TO fathom_app;

-- ---------------------------------------------------------------------------
-- ENTRY TYPE: `firmware_retired`, on the organisation chain. The list is 0056's plus this one;
-- mirrored by `EntryType::kinds()` in `src/chain.rs`.
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
                                -- 0056.
                                'termix_access_set',
                                -- This file.
                                'firmware_retired'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
