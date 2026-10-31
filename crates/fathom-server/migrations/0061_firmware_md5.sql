-- 0061 -- an MD5 of each staged image, beside the SHA-256 and SHA-512 (sign-off
-- r62, "SHA-512 and MD5 at upload"; the `md-5` crate approved on r70,
-- 2026-10-31; record `deps/decisions/md-5.md`).
--
-- **MD5 is broken and this column protects nothing.** It is shown so a person
-- can compare it with a vendor page that publishes no better hash, and the page
-- says beside it that a match only rules out a damaged download, not a
-- deliberate swap. Every check Fathom makes (the upload, the weekly re-check,
-- the re-hash before each download) is against `computed_sha256`.
--
-- Worked out by the server from the bytes, like the other two: at upload for a
-- new image, and at the first weekly re-check for an older one, only once its
-- SHA-256 has matched. Nothing declared by a person is ever written into it.

ALTER TABLE firmware_images
    ADD COLUMN IF NOT EXISTS computed_md5 bytea
        CHECK (computed_md5 IS NULL OR octet_length(computed_md5) = 16);

GRANT UPDATE (computed_md5) ON firmware_images TO fathom_app;
