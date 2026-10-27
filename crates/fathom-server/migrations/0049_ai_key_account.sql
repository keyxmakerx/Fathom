-- 0049 -- Which AI account a connection uses, as its owner gave it (ADR-0072 decision 24; owner's
-- note on sign-off card r42-ai-account, 2026-10-27: "Can the users email be displayed to the org
-- managers and admins?").
--
-- Fathom cannot see which account an AI app is signed in to (decision 23), so the person says
-- which, when they press Allow or Make key, and Stewards and admins see it beside the
-- connection. It is what the person typed, never checked, and every screen says so. Rows made
-- before this migration have none; their seal does not cover the column while it is empty, so
-- they still verify.

ALTER TABLE ai_keys ADD COLUMN IF NOT EXISTS ai_account text
    CHECK (ai_account IS NULL
           OR (char_length(ai_account) BETWEEN 3 AND 254
               AND ai_account ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'));
