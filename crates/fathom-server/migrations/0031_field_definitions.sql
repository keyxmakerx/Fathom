-- Custom-field definitions, one set per organisation (ADR-0062). Values stay in
-- the design payload. Name, type and choices are ONE JSON blob sealed under the
-- organisation content key (tenant, id, kind and epoch in the associated data);
-- there is no plaintext copy. Archive replaces delete, so there is no DELETE
-- policy. `version` is the optimistic-concurrency counter.
CREATE TABLE IF NOT EXISTS field_definitions (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    id              text        NOT NULL CHECK (char_length(id) = 26),
    kind            text        NOT NULL
                    CHECK (kind IN ('device', 'rack', 'cable', 'port', 'network')),
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by      text        NOT NULL REFERENCES accounts(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    archived        boolean     NOT NULL DEFAULT false,
    ciphertext      bytea       NOT NULL,
    nonce           bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    key_epoch       integer     NOT NULL CHECK (key_epoch >= 1),
    PRIMARY KEY (organisation_id, id)
);

ALTER TABLE field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_definitions FORCE ROW LEVEL SECURITY;

CREATE POLICY field_definitions_readable ON field_definitions
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY field_definitions_insertable ON field_definitions
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY field_definitions_updatable ON field_definitions
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
