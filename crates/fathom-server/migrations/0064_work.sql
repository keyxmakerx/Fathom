-- 0064 -- the Work tab (sign-off r74, 2026-11-02; ADR-0081).
--
-- Two changes to the estate index (0058), so one list can show the work going on across every
-- design: maintenance plans and "It's down" issues become rows of their own, and each piece of
-- work gets a Fathom number. 0063 is left for the Termix branch that is landing beside this one.
--
-- **Plans and issues join the index.** A row's contents stay sealed under the estate index key
-- (`src/estate.rs`); what is new in the clear is two more values of `kind`. Open work is found by
-- a keyed-hash term, as everything else in the index is, so the database learns which rows are
-- open work and nothing about what they say.
--
-- **Fathom numbers.** `work_numbers` gives each piece of work (a plan, an issue, a spare on order,
-- away or lent) one number in its organisation, the first time the server indexes it, and never
-- gives that number again: there is no update, and a row goes only when its design does. A
-- number is an id and a counter; nothing in it is readable. It is not a field of the design,
-- because two designs cannot agree on a counter between them.

ALTER TABLE estate_rows DROP CONSTRAINT IF EXISTS estate_rows_kind_check;
ALTER TABLE estate_rows ADD CONSTRAINT estate_rows_kind_check
    CHECK (kind IN ('device', 'card', 'optic', 'power_supply', 'spare', 'plan', 'issue'));

CREATE TABLE IF NOT EXISTS work_numbers (
    organisation_id text    NOT NULL,
    design_id       text    NOT NULL,
    element_id      text    NOT NULL,
    number          bigint  NOT NULL CHECK (number >= 1),
    PRIMARY KEY (organisation_id, design_id, element_id),
    UNIQUE (organisation_id, number),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE CASCADE
);

ALTER TABLE work_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_numbers FORCE  ROW LEVEL SECURITY;

-- Given once, never changed, never taken back by the app.
REVOKE UPDATE, DELETE, TRUNCATE ON work_numbers FROM fathom_app;

CREATE POLICY work_numbers_select ON work_numbers FOR SELECT
    USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY work_numbers_insert ON work_numbers FOR INSERT
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
