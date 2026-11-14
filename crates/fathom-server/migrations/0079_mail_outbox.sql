-- 0079 -- the mail outbox (ADR-0085 decision 7; the owner ticked Mail on the alpha card, v2,
-- 14 November 2026).
--
-- A mail is written here in the same transaction as the act that causes it, and a worker sends
-- it later, so sending never slows a request. Retries at 1, 5 and 30 minutes, then 2 and 12
-- hours; after the sixth try it is marked failed.
--
-- Two sealed values, both under a subkey of the site chain key (`fathom/mail/outbox/v1`, never
-- in PostgreSQL):
--   `summary_ct`  the recipient's address and a few words of what the mail is ("Invitation for
--                 Sam Lee"). Kept, so Admin › Mail can say what was sent to whom.
--   `body_ct`     the whole message, which may carry a reset or invitation link. Removed the
--                 moment the mail is sent or fails, so a dump never holds a link that was used.
-- `last_reply` is the relay's own answer, never the body. `organisation_id` is null for mail
-- that belongs to no organisation (a password reset).
--
-- One capability, `app.mail_custody`, opens the table: the act that writes a mail, the worker,
-- and a Steward's read of their own organisation's rows (which the route filters by
-- organisation after checking the Steward). Deleting is allowed only for the worker's 90-day
-- clear-out.

CREATE TABLE IF NOT EXISTS mail_outbox (
    id               text        PRIMARY KEY CHECK (id ~ '^mail_[0-9A-HJKMNP-TV-Z]{26}$'),
    organisation_id  text        NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    kind             text        NOT NULL CHECK (kind IN ('reset', 'invitation')),
    state            text        NOT NULL CHECK (state IN ('queued', 'sent', 'failed')),
    summary_ct       bytea       NOT NULL,
    summary_nonce    bytea       NOT NULL CHECK (octet_length(summary_nonce) = 12),
    body_ct          bytea       NULL,
    body_nonce       bytea       NULL CHECK (body_nonce IS NULL OR octet_length(body_nonce) = 12),
    attempts         integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
    created_at       timestamptz NOT NULL DEFAULT now(),
    next_attempt_at  timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    finished_at      timestamptz NULL,
    last_reply       text        NULL CHECK (last_reply IS NULL OR char_length(last_reply) <= 400),
    -- A queued mail has its body and no end; a sent or failed one has an end and no body.
    CHECK ((state = 'queued') = (body_ct IS NOT NULL AND body_nonce IS NOT NULL)),
    CHECK ((state = 'queued') = (finished_at IS NULL))
);

CREATE INDEX IF NOT EXISTS mail_outbox_due_idx ON mail_outbox (next_attempt_at) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS mail_outbox_org_idx ON mail_outbox (organisation_id, created_at DESC);

ALTER TABLE mail_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_outbox FORCE ROW LEVEL SECURITY;
REVOKE TRUNCATE ON mail_outbox FROM fathom_app;

CREATE POLICY mail_outbox_custody ON mail_outbox
    USING (current_setting('app.mail_custody', true) = 'yes')
    WITH CHECK (current_setting('app.mail_custody', true) = 'yes');
