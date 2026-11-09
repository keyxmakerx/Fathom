-- 0076 -- faceplate templates and Cables lists on the server (sign-off r111, from r110's
-- "later" list). Both used to live only in one browser's localStorage.
--
-- Neither is a design field: neither enters a design, its undo or its change history, and
-- neither writes a chain entry (r111 pick A; custom field definitions write none either).
-- Everything a person wrote or picked is sealed under the organisation content key. In the
-- clear: ids, who and when, a version, the key epoch. The server decides on nothing it would
-- have to read the sealed text for.
--
-- A. FACEPLATE TEMPLATES. One shared list per organisation (r111 pick A): a set of hand-typed
--   ports to start a box from. Anyone holding `draw` somewhere in the organisation may save
--   one; its maker or a Steward may remove it (`src/faceplate_templates.rs` decides). Sealed:
--   the name, the role and the ports. A removed template is deleted: it is a starting point,
--   not a record.
--
-- B. MEMBER CABLE VIEWS. One row per person per design (r111 pick A): that person's Cables
--   list, which groups exist and are ticked, None, and the cables hidden one at a time.
--   Sealed. Only the person reads or writes their own row. Removing the membership or the
--   design removes the row.
--
-- No entry types change, so 0075's list stands.

-- ---------------------------------------------------------------------------
-- A. faceplate_templates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS faceplate_templates (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    id              text        NOT NULL CHECK (char_length(id) = 26),
    created_by      text        NOT NULL REFERENCES accounts(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    key_epoch       integer     NOT NULL CHECK (key_epoch >= 1),
    ciphertext      bytea       NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 131072),
    nonce           bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    PRIMARY KEY (organisation_id, id)
);

ALTER TABLE faceplate_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE faceplate_templates FORCE ROW LEVEL SECURITY;

-- Saved once, never edited: a new save under the same name is a new row and the old one is
-- removed in the same transaction.
REVOKE UPDATE ON faceplate_templates FROM fathom_app;

CREATE POLICY faceplate_templates_readable ON faceplate_templates
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY faceplate_templates_insertable ON faceplate_templates
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY faceplate_templates_deletable ON faceplate_templates
    FOR DELETE USING (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- B. member_cable_views
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_cable_views (
    organisation_id text        NOT NULL,
    account_id      text        NOT NULL,
    design_id       text        NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    key_epoch       integer     NOT NULL CHECK (key_epoch >= 1),
    ciphertext      bytea       NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 65552),
    nonce           bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    PRIMARY KEY (organisation_id, account_id, design_id),
    FOREIGN KEY (account_id, organisation_id)
        REFERENCES memberships (account_id, organisation_id) ON DELETE CASCADE,
    FOREIGN KEY (design_id, organisation_id)
        REFERENCES designs (id, organisation_id) ON DELETE CASCADE
);

ALTER TABLE member_cable_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_cable_views FORCE ROW LEVEL SECURITY;

-- The app role replaces the sealed body and never deletes; the cascades above do that.
REVOKE DELETE, UPDATE ON member_cable_views FROM fathom_app;
GRANT UPDATE (updated_at, key_epoch, ciphertext, nonce) ON member_cable_views TO fathom_app;

-- A person's own row in the tenant, and nobody else's.
CREATE POLICY member_cable_views_readable ON member_cable_views
    FOR SELECT USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND account_id = current_setting('app.account_id', true)
    );
CREATE POLICY member_cable_views_insertable ON member_cable_views
    FOR INSERT WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND account_id = current_setting('app.account_id', true)
    );
CREATE POLICY member_cable_views_updatable ON member_cable_views
    FOR UPDATE USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND account_id = current_setting('app.account_id', true)
    ) WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND account_id = current_setting('app.account_id', true)
    );
