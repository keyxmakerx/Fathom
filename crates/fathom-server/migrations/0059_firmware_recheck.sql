-- 0059 -- a staged image's bytes are checked again: a SHA-512 beside the SHA-256,
-- and a re-check of every stored image once a week (sign-off r62, ADR-0064's
-- 2026-10-31 amendment).
--
-- `computed_sha512` is worked out by the server from the bytes, exactly like
-- `computed_sha256`: at upload, from the same pass, for a new image; at its
-- first weekly re-check, for an image staged before this migration, and then
-- only once the file has been confirmed against its SHA-256 first. Nothing
-- declared by a person is ever written into it. Vendors such as Cisco publish a
-- SHA-512, and IOS XE's `verify /sha512` prints one, so this is the hash a
-- person compares there.
--
-- `last_checked_at` is when the stored file was last hashed and compared;
-- `changed_at` is when a re-check first found it no longer matching (or gone).
-- It is never cleared by a later re-check: a file that changed and changed back
-- is still a file that changed. A download already re-hashes the file before
-- sending it, so `changed_at` is the warning a person sees, not the gate.

ALTER TABLE firmware_images
    ADD COLUMN IF NOT EXISTS computed_sha512 bytea
        CHECK (computed_sha512 IS NULL OR octet_length(computed_sha512) = 64),
    ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
    ADD COLUMN IF NOT EXISTS changed_at timestamptz;

GRANT UPDATE (computed_sha512, last_checked_at, changed_at)
    ON firmware_images TO fathom_app;

-- ---------------------------------------------------------------------------
-- THE RE-CHECK'S DOOR. The weekly re-check runs with no session and no tenant,
-- so it needs to find which images are due across every organisation. It gets
-- a capability of its own, `app.firmware_recheck_custody`, set by exactly one
-- function in the server (`enter_recheck_custody`), and that capability READS
-- only: there is no UPDATE or INSERT policy for it. Every write the re-check
-- makes is under the image's own organisation, through the ordinary tenant
-- predicate, so a mistake in the re-check cannot write across organisations.
-- ---------------------------------------------------------------------------
CREATE POLICY firmware_images_readable_for_recheck ON firmware_images
    FOR SELECT USING (current_setting('app.firmware_recheck_custody', true) = 'yes');
