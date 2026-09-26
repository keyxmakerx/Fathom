-- ADR-0057 decision 8: `browser_label`, derived once at sign-in by
-- `browser_label::label` from `User-Agent`, which is never itself stored.
-- Unset stays out of the row state, so an older row still verifies, and it
-- sits inside the row MAC like `bound_address_class` does.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS browser_label text;
