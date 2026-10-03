-- Files attached to a doc (ADR-0061 round 10, r10-files A). The bytes live here, sealed under
-- the design key like a payload; the design's graph holds the name, size, what the redaction
-- gate did and the SHA-256 of the stored bytes, so the chained payload covers which bytes
-- belong to which doc. One row per file. No UPDATE-by-content: the only update is rotation
-- re-sealing under a new key epoch. No DELETE policy: removing a file from a doc removes it
-- from the graph only (undo must be able to bring it back); the sealed copy stays.
-- Reads need the design capability like design_payload, and the row key is bound in the AEAD
-- associated data so a row moved to another file id or design fails to open.
CREATE TABLE IF NOT EXISTS design_files (
    design_id       text        NOT NULL,
    organisation_id text        NOT NULL,
    file_id         text        NOT NULL CHECK (file_id ~ '^[0-9a-f]{32}$'),

    ciphertext      bytea       NOT NULL,
    nonce           bytea       NOT NULL CHECK (octet_length(nonce) = 12),

    key_epoch       int         NOT NULL CHECK (key_epoch >= 1),
    wrap_version    int         NOT NULL CHECK (wrap_version >= 1),
    aead_alg_id     smallint    NOT NULL CHECK (aead_alg_id >= 1),

    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      text        NOT NULL REFERENCES accounts(id),

    PRIMARY KEY (design_id, file_id),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (design_id, key_epoch) REFERENCES design_keys (design_id, key_epoch)
);

ALTER TABLE design_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_files FORCE ROW LEVEL SECURITY;

CREATE POLICY design_files_readable ON design_files
    FOR SELECT USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
CREATE POLICY design_files_insertable ON design_files
    FOR INSERT WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
CREATE POLICY design_files_updatable ON design_files
    FOR UPDATE USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes')
            WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
