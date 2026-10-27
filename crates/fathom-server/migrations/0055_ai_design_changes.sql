-- 0051 -- Which changes to a design an AI connection made (ADR-0077 decisions 5, 7 and 8).
--
-- One row per change an AI connection made through `change_design`: the design, the batch,
-- the version it became, how many operations it held, and when. The change itself is the
-- design's own sealed change row, authored by the connection's owner like any change; this
-- row is the mark that an AI made it through that connection, which History reads, and the
-- count the limits are checked against (10 a minute, 300 a day). A browser cannot write one:
-- only the AI route does, in the transaction that stores the change.
--
-- No text: the summary the AI gave is the batch's label, inside the sealed change.

CREATE TABLE IF NOT EXISTS ai_design_changes (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    design_id       text        NOT NULL,
    batch_id        text        NOT NULL CHECK (char_length(batch_id) = 26),
    key_id          text        NOT NULL REFERENCES ai_keys(id) ON DELETE RESTRICT,
    owner           text        NOT NULL REFERENCES accounts(id),
    design_version  bigint      NOT NULL CHECK (design_version >= 2),
    operations      integer     NOT NULL CHECK (operations BETWEEN 1 AND 200),
    made_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, design_id, batch_id),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS ai_design_changes_key_idx
    ON ai_design_changes (key_id, made_at);

ALTER TABLE ai_design_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_design_changes FORCE  ROW LEVEL SECURITY;

-- Written once, never changed or removed.
REVOKE UPDATE, DELETE, TRUNCATE ON ai_design_changes FROM fathom_app;

CREATE POLICY ai_design_changes_readable ON ai_design_changes
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ai_design_changes_insertable ON ai_design_changes
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND owner = current_setting('app.account_id', true));

DROP TRIGGER IF EXISTS ai_design_changes_no_truncate ON ai_design_changes;
CREATE TRIGGER ai_design_changes_no_truncate
    BEFORE TRUNCATE ON ai_design_changes
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();
