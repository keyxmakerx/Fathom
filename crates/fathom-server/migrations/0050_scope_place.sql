-- 0050 -- A folder says what kind of place it is, and whether it is a hub (ADR-0074 §1 and §2;
-- owner's answers 2026-10-26, sign-off card r37-estate v2).
--
-- The building, site and estate stops draw the Site › Building › Closet folders this table
-- already holds, so the places live here and nowhere else. Two optional words are added:
--
-- * `place_form`: what the place is. A site or a building takes the schema's `Premises.form`
--   words that name a place a person walks into (`schema/schema.yaml`); a closet folder takes
--   the kinds of room ADR-0074's "How" names. Pole and handhole are not folders: they are
--   things in a design.
-- * `place_role`: Hub, Branch, Customer or Other, set by hand (§2: Fathom never works it out
--   from links). Only a site or a building carries one: a closet is not a hub.
--
-- PLAINTEXT, like `display_name` beside it, and for the same reason (`docs/OPEN-QUESTIONS.md`
-- V2): it is the shape of the tree, read by the same queries. Both columns are NULL until a
-- steward sets them, so every existing folder is unchanged.

ALTER TABLE scopes ADD COLUMN IF NOT EXISTS place_form text;
ALTER TABLE scopes ADD COLUMN IF NOT EXISTS place_role text;

ALTER TABLE scopes DROP CONSTRAINT IF EXISTS scopes_place_form_check;
ALTER TABLE scopes ADD CONSTRAINT scopes_place_form_check CHECK (
    place_form IS NULL
    OR (kind IN ('network', 'building') AND place_form IN (
        'central_office', 'data_centre', 'hut', 'cabinet', 'headend', 'customer_premises', 'other'))
    OR (kind = 'rack' AND place_form IN (
        'closet', 'data_hall', 'ups_room', 'meet_me_room', 'other'))
);

ALTER TABLE scopes DROP CONSTRAINT IF EXISTS scopes_place_role_check;
ALTER TABLE scopes ADD CONSTRAINT scopes_place_role_check CHECK (
    place_role IS NULL
    OR (kind IN ('network', 'building') AND place_role IN ('hub', 'branch', 'customer', 'other'))
);
