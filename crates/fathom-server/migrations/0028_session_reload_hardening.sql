-- 0028 -- ADR-0057 decisions 4, 6 and 7. As `0027` before it: new keys stay
-- out of their canonical map when unset, so a row sealed before this
-- migration still verifies.
--
-- ---------------------------------------------------------------------------
-- A. Decision 6: `grace_token_hash`, inside the row MAC for the same reason
--    `totp_verified_at` is -- a database-only attacker must not plant a hash
--    their chosen token then matches. Written once at sign-in; never
--    rewritten.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS grace_token_hash bytea;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_grace_token_hash_is_32_bytes;
ALTER TABLE sessions
    ADD CONSTRAINT sessions_grace_token_hash_is_32_bytes
    CHECK (grace_token_hash IS NULL OR octet_length(grace_token_hash) = 32);

-- ---------------------------------------------------------------------------
-- B. Decision 7: `bound_address_class`, inside the row MAC for the same
--    reason -- rewriting it is exactly how a database-only attacker would
--    defeat the check it exists for. Written once at sign-in, from
--    `client_address::address_class`.
--
--    `address_changed_at` is the opposite: the one legitimately rewritten
--    column, so it sits OUTSIDE the MAC beside `last_seen_at` and
--    `request_counter` (`0013` §F's third exception). Set once, when a
--    request's address first stops matching `bound_address_class`; never
--    cleared.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS bound_address_class text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS address_changed_at timestamptz;

GRANT UPDATE (address_changed_at) ON sessions TO fathom_app;
