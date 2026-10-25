-- 0040 -- a practice space for the person who runs the server (ADR-0069).
--
-- The owner, 2026-10-25, on the first run: "You shouldn't be forced to create an
-- org. Because admins are admins they won't be managing the orgs." The server is
-- organisation-scoped throughout, so a practice space is an ordinary organisation,
-- made by the same operator act and claimed by the same genesis as any other, and
-- marked so the app can show it as practice rather than as an organisation to run.
--
-- `organisation_shells.practice` records what the operator asked for. It is part
-- of the shell's row seal when true (`operators.rs`'s `shell_seal`), so a row
-- flipped to practice without a reseal is an integrity alarm at redemption; a row
-- sealed before this column existed reads false and its seal is unchanged.
-- `organisations.practice` is copied from the shell at redemption, in the same
-- transaction as the genesis, and is a label only: it grants nothing and nothing
-- reads it to decide authority.

ALTER TABLE organisation_shells
    ADD COLUMN IF NOT EXISTS practice boolean NOT NULL DEFAULT false;

ALTER TABLE organisations
    ADD COLUMN IF NOT EXISTS practice boolean NOT NULL DEFAULT false;
