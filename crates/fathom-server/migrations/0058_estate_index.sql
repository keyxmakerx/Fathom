-- 0058 -- The estate index (ADR-0079 decisions 2 to 4).
--
-- Search and Inventory across every design in an organisation. The server rebuilds a design's
-- rows from its own copy of the design after each accepted save or change; nothing here is
-- written by a browser.
--
-- **Nothing readable is stored.** `estate_rows.sealed` is one thing's name, model, serial,
-- addresses and place, encrypted under a key derived from the tenant key for this index
-- (`src/estate.rs`). `estate_terms.term` is a keyed hash of one normalised search term: a whole
-- word, or a prefix of three characters or more. What the database can learn is which rows share a
-- term and how often a term occurs, and the kind of each row (device, card, optic, power supply,
-- spare), which is in the clear so Inventory can filter by it.
--
-- Who may see a row is not stored here: a search filters by the person's Read on each design's
-- folder when it is asked (decision 4). A design's rows are replaced whole, so the app role may
-- insert and delete and never update.

CREATE TABLE IF NOT EXISTS estate_rows (
    organisation_id text    NOT NULL,
    design_id       text    NOT NULL,
    element_id      text    NOT NULL,
    kind            text    NOT NULL CHECK (kind IN ('device', 'card', 'optic', 'power_supply', 'spare')),
    design_version  bigint  NOT NULL CHECK (design_version >= 1),
    sealed          bytea   NOT NULL,
    nonce           bytea   NOT NULL CHECK (octet_length(nonce) = 12),
    PRIMARY KEY (organisation_id, design_id, element_id),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS estate_rows_kind_idx
    ON estate_rows (organisation_id, kind, design_id, element_id);

CREATE TABLE IF NOT EXISTS estate_terms (
    organisation_id text    NOT NULL,
    term            bytea   NOT NULL CHECK (octet_length(term) = 32),
    design_id       text    NOT NULL,
    element_id      text    NOT NULL,
    PRIMARY KEY (organisation_id, term, design_id, element_id),
    FOREIGN KEY (organisation_id, design_id, element_id)
        REFERENCES estate_rows (organisation_id, design_id, element_id) ON DELETE CASCADE
);

-- Which version of each design the rows were built from, so a search can say which designs are
-- still being brought up to date.
CREATE TABLE IF NOT EXISTS estate_built (
    organisation_id text    NOT NULL,
    design_id       text    NOT NULL,
    design_version  bigint  NOT NULL CHECK (design_version >= 1),
    PRIMARY KEY (organisation_id, design_id),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE CASCADE
);

ALTER TABLE estate_rows  ENABLE ROW LEVEL SECURITY;
ALTER TABLE estate_rows  FORCE  ROW LEVEL SECURITY;
ALTER TABLE estate_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE estate_terms FORCE  ROW LEVEL SECURITY;
ALTER TABLE estate_built ENABLE ROW LEVEL SECURITY;
ALTER TABLE estate_built FORCE  ROW LEVEL SECURITY;

REVOKE UPDATE, TRUNCATE ON estate_rows  FROM fathom_app;
REVOKE UPDATE, TRUNCATE ON estate_terms FROM fathom_app;
REVOKE TRUNCATE ON estate_built FROM fathom_app;

CREATE POLICY estate_rows_select ON estate_rows FOR SELECT
    USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY estate_rows_insert ON estate_rows FOR INSERT
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY estate_rows_delete ON estate_rows FOR DELETE
    USING (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY estate_terms_select ON estate_terms FOR SELECT
    USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY estate_terms_insert ON estate_terms FOR INSERT
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY estate_terms_delete ON estate_terms FOR DELETE
    USING (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY estate_built_select ON estate_built FOR SELECT
    USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY estate_built_insert ON estate_built FOR INSERT
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY estate_built_update ON estate_built FOR UPDATE
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY estate_built_delete ON estate_built FOR DELETE
    USING (organisation_id = current_setting('app.tenant_id', true));
