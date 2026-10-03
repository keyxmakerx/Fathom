-- Cable corrections from the floor. Someone with READ on a design sends "traced", "label
-- wrong" or "not here" about one cable; someone with DRAW accepts or dismisses it. A
-- correction is NOT a graph node and never changes the record by itself: acceptance is an
-- ordinary edit the accepter makes in the client, then marks here.
--
-- The text a sender typed is ONE JSON blob sealed under the organisation content key
-- (tenant, id, design, cable, kind, sender and epoch in the associated data); there is no
-- plaintext copy. The plain columns are the ones the server decides on: who sent it, which
-- cable, what state it is in. Nothing is deleted: the app role has no DELETE, and may change
-- only the decision columns and the sealed body (a dismissal re-seals it as empty text, so
-- what was typed is not kept). The sender of a row is the session's account on INSERT, and
-- whoever decided it is the session's account on UPDATE (the `account_keys` pattern, 0011).
CREATE TABLE IF NOT EXISTS cable_corrections (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id              text        NOT NULL CHECK (char_length(id) = 26),
    design_id       text        NOT NULL,
    cable           text        NOT NULL CHECK (char_length(cable) BETWEEN 1 AND 64),
    kind            text        NOT NULL CHECK (kind IN ('traced', 'label', 'not_here')),
    sender          text        NOT NULL REFERENCES accounts(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    state           text        NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'accepted', 'dismissed')),
    decided_by      text        REFERENCES accounts(id),
    decided_at      timestamptz,
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    ciphertext      bytea       NOT NULL,
    nonce           bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    key_epoch       integer     NOT NULL CHECK (key_epoch >= 1),
    PRIMARY KEY (organisation_id, id),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE RESTRICT,
    CHECK ((state = 'open') = (decided_by IS NULL AND decided_at IS NULL))
);

CREATE INDEX IF NOT EXISTS cable_corrections_design_idx
    ON cable_corrections (organisation_id, design_id, state, created_at);

ALTER TABLE cable_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cable_corrections FORCE ROW LEVEL SECURITY;

REVOKE DELETE, UPDATE ON cable_corrections FROM fathom_app;
GRANT UPDATE (state, decided_by, decided_at, version, ciphertext, nonce, key_epoch) ON cable_corrections TO fathom_app;

CREATE POLICY cable_corrections_readable ON cable_corrections
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY cable_corrections_insertable ON cable_corrections
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND sender = current_setting('app.account_id', true));
CREATE POLICY cable_corrections_updatable ON cable_corrections
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND (decided_by IS NULL
                         OR decided_by = current_setting('app.account_id', true)));
