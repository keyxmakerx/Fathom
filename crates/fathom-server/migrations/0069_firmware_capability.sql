-- 0069 -- the Firmware capability (sign-off r95; the owner's picks, 2 November 2026: who may upload
-- firmware is B, "a Firmware permission a Steward grants to a person or a team", and its shape is
-- A, "a step between Draw and Steward: Firmware includes Draw").
--
-- `src/authority.rs` orders the capabilities read < draw < firmware < steward. Firmware lets a
-- person or a team stage an image, issue a device's one-time download link, set an image's models
-- and retire it (`src/firmware.rs`). It grants no access and changes no setting: those stay
-- Steward. A grant of it is the same signed grant as Read and Draw (`fathom/grant/v2` covers the
-- capability's text), so it is on the organisation chain like every other grant.
--
-- This migration only widens three CHECKs to accept the new word. Nothing that is stored changes:
-- every existing row is read, draw or steward and stays so. **A team still never holds Steward**
-- (ADR-0081 T4): `team_acts` gains 'firmware' and nothing else.
--
-- The constraints were declared inline, so they carry Postgres's default names
-- (`<table>_<column>_check`). DROP ... IF EXISTS then ADD keeps a re-run harmless.

ALTER TABLE scope_grants DROP CONSTRAINT IF EXISTS scope_grants_capability_check;
ALTER TABLE scope_grants ADD CONSTRAINT scope_grants_capability_check
    CHECK (capability IN ('read', 'draw', 'firmware', 'steward'));

ALTER TABLE organisation_invitations DROP CONSTRAINT IF EXISTS organisation_invitations_capability_asked_check;
ALTER TABLE organisation_invitations ADD CONSTRAINT organisation_invitations_capability_asked_check
    CHECK (capability_asked IN ('read', 'draw', 'firmware', 'steward'));

ALTER TABLE team_acts DROP CONSTRAINT IF EXISTS team_acts_capability_check;
ALTER TABLE team_acts ADD CONSTRAINT team_acts_capability_check
    CHECK (capability IN ('read', 'draw', 'firmware'));
