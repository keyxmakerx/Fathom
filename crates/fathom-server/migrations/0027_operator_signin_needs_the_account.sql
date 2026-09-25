-- 0027 -- ADR-0057 decisions 2 and 3. New keys stay out of their canonical
-- maps when unset, so a seal made before this migration still verifies.
--
-- ---------------------------------------------------------------------------
-- A. `sessions.totp_verified_at`, inside the row MAC: outside it, deleting
--    and re-inserting a row would forge a fresh one.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS totp_verified_at timestamptz;

-- ---------------------------------------------------------------------------
-- B. A pending TOTP secret beside the live one, so an abandoned re-enrolment
--    never turns the second factor off.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_pending_secret_ct bytea;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_pending_secret_nonce bytea;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_pending_secret_key_epoch integer;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_pending_enrolled_at timestamptz;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_totp_pending_secret_nonce_is_twelve_bytes;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_totp_pending_secret_nonce_is_twelve_bytes
    CHECK (totp_pending_secret_nonce IS NULL OR octet_length(totp_pending_secret_nonce) = 12);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_totp_pending_secret_key_epoch_is_positive;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_totp_pending_secret_key_epoch_is_positive
    CHECK (totp_pending_secret_key_epoch IS NULL OR totp_pending_secret_key_epoch >= 1);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_totp_pending_secret_is_whole;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_totp_pending_secret_is_whole
    CHECK (
        (totp_pending_secret_ct IS NULL) = (totp_pending_secret_nonce IS NULL)
        AND (totp_pending_secret_ct IS NULL) = (totp_pending_secret_key_epoch IS NULL)
        AND (totp_pending_secret_ct IS NULL) = (totp_pending_enrolled_at IS NULL)
    );

-- The runtime role writes the pending slot, same as `0018` grants the live
-- one.
GRANT UPDATE (totp_pending_secret_ct, totp_pending_secret_nonce,
              totp_pending_secret_key_epoch, totp_pending_enrolled_at)
    ON accounts TO fathom_app;
