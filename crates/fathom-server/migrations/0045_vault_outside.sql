-- 0045 -- outside vaults: logins Fathom reads from a person's own Vaultwarden (ADR-0071 part
-- four; owner's answers on the sign-off page, 26 October: r34-vault-read A, "Make sure this is per
-- user, but the Admin can reject/pull whatever as needed", r34-vault-crates, r34-vault-ring A).
--
-- **Per person.** Any member connects an outside vault account of their own; the connection and
-- every login pulled through it are theirs. Admins see every connection, can disconnect any of
-- them, and can remove any one login pulled through one; a login an admin removed comes back
-- only when an admin restores it.
--
-- **What the server keeps, and what it never sees.** The connection's API key (client id and
-- secret) and the outside organisation's 64-byte key are sealed together under a key derived
-- from `vault.key` (as Mode B's copies are), never in the clear. The account's master password
-- never reaches the server: the person's browser opens the account's keys with it once, and
-- hands over only the organisation key that the one collection is under. A login's name and the
-- devices it is used on are sealed the same way. Its user name and password are read from the
-- outside vault each time Fathom uses it, after the checks pass again, and are not stored here.
--
-- As in 0042 to 0044: no default privileges, every table granted by name, tenant-pinned row
-- security, no DELETE.

CREATE TABLE IF NOT EXISTS vault.outside_connections (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id              text        NOT NULL CHECK (id ~ '^out_[0-9A-HJKMNP-TV-Z]{26}$'),
    owner           text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,
    provider        text        NOT NULL CHECK (provider IN ('vaultwarden')),
    base_url        text        NOT NULL CHECK (base_url ~ '^https://' AND char_length(base_url) <= 300),
    outside_org_id  text        NOT NULL CHECK (char_length(outside_org_id) BETWEEN 1 AND 64),
    collection_id   text        NOT NULL CHECK (char_length(collection_id) BETWEEN 1 AND 64),
    -- As the owner's browser read it: the outside vault seals collection names, and the
    -- server checks this one against the sealed name with the organisation key at connect.
    collection_name text        NOT NULL CHECK (char_length(collection_name) BETWEEN 1 AND 200),
    -- The device the outside vault knows this connection as, so it mails "new device" once.
    device_id       text        NOT NULL CHECK (char_length(device_id) = 36),
    state           text        NOT NULL CHECK (state IN ('on', 'stopped', 'disconnected')),
    stopped_reason  text        CHECK (char_length(stopped_reason) <= 400),
    server_key_id   text        NOT NULL CHECK (server_key_id ~ '^[0-9a-f]{16}$'),
    secret_nonce    bytea       NOT NULL CHECK (octet_length(secret_nonce) = 12),
    secret_ct       bytea       NOT NULL CHECK (octet_length(secret_ct) <= 4096),
    checked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, id),
    FOREIGN KEY (owner, principal_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (updated_by, principal_kind) REFERENCES principals (id, kind),
    CHECK (state <> 'disconnected' OR octet_length(secret_ct) = 0),
    CHECK (state = 'disconnected' OR octet_length(secret_ct) >= 17),
    CHECK ((state = 'stopped') = (stopped_reason IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS vault.outside_items (
    organisation_id text        NOT NULL,
    id              text        NOT NULL CHECK (id ~ '^oit_[0-9A-HJKMNP-TV-Z]{26}$'),
    connection_id   text        NOT NULL,
    cipher_id       text        NOT NULL CHECK (char_length(cipher_id) BETWEEN 1 AND 64),
    state           text        NOT NULL CHECK (state IN ('on', 'removed')),
    -- `{"kind":…,"name":…,"used_on":[[design, element], …]}`, canonical, sealed under vault.key.
    meta_key_id     text        NOT NULL CHECK (meta_key_id ~ '^[0-9a-f]{16}$'),
    meta_nonce      bytea       NOT NULL CHECK (octet_length(meta_nonce) = 12),
    meta_ct         bytea       NOT NULL CHECK (octet_length(meta_ct) BETWEEN 17 AND 65536),
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,
    pulled_by       text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    removed_by      text        REFERENCES accounts(id) ON DELETE RESTRICT,
    removed_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, id),
    UNIQUE (organisation_id, connection_id, cipher_id),
    FOREIGN KEY (organisation_id, connection_id)
        REFERENCES vault.outside_connections (organisation_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (pulled_by, principal_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (removed_by, principal_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (updated_by, principal_kind) REFERENCES principals (id, kind),
    CHECK ((state = 'removed') = (removed_by IS NOT NULL)),
    CHECK ((removed_by IS NULL) = (removed_at IS NULL))
);

CREATE TABLE IF NOT EXISTS vault.outside_reads (
    organisation_id text        NOT NULL,
    id              text        NOT NULL CHECK (char_length(id) = 26),
    item_id         text        NOT NULL,
    purpose         text        NOT NULL CHECK (purpose ~ '^[a-z][a-z-]{0,39}$'),
    design_id       text        NOT NULL,
    element_id      text        NOT NULL CHECK (char_length(element_id) BETWEEN 1 AND 64),
    asked_by        text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,
    read_at         timestamptz NOT NULL DEFAULT now(),
    chain_seq       bigint      NOT NULL CHECK (chain_seq >= 1),
    PRIMARY KEY (organisation_id, id),
    FOREIGN KEY (organisation_id, item_id) REFERENCES vault.outside_items (organisation_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (asked_by, principal_kind) REFERENCES principals (id, kind)
);

CREATE INDEX IF NOT EXISTS vault_outside_reads_by_item
    ON vault.outside_reads (organisation_id, item_id, read_at DESC);

GRANT SELECT, INSERT ON vault.outside_connections, vault.outside_items, vault.outside_reads
    TO fathom_app;
GRANT UPDATE (state, stopped_reason, server_key_id, secret_nonce, secret_ct, checked_at,
              updated_by, updated_at)
    ON vault.outside_connections TO fathom_app;
GRANT UPDATE (state, meta_key_id, meta_nonce, meta_ct, removed_by, removed_at, updated_by,
              updated_at)
    ON vault.outside_items TO fathom_app;

ALTER TABLE vault.outside_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.outside_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE vault.outside_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.outside_items FORCE ROW LEVEL SECURITY;
ALTER TABLE vault.outside_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.outside_reads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vault_outside_connections_readable ON vault.outside_connections;
CREATE POLICY vault_outside_connections_readable ON vault.outside_connections
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_outside_connections_insertable ON vault.outside_connections;
CREATE POLICY vault_outside_connections_insertable ON vault.outside_connections
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND owner = current_setting('app.account_id', true)
                       AND updated_by = current_setting('app.account_id', true));
DROP POLICY IF EXISTS vault_outside_connections_updatable ON vault.outside_connections;
CREATE POLICY vault_outside_connections_updatable ON vault.outside_connections
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND updated_by = current_setting('app.account_id', true));

DROP POLICY IF EXISTS vault_outside_items_readable ON vault.outside_items;
CREATE POLICY vault_outside_items_readable ON vault.outside_items
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_outside_items_insertable ON vault.outside_items;
CREATE POLICY vault_outside_items_insertable ON vault.outside_items
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND pulled_by = current_setting('app.account_id', true)
                       AND updated_by = current_setting('app.account_id', true));
DROP POLICY IF EXISTS vault_outside_items_updatable ON vault.outside_items;
CREATE POLICY vault_outside_items_updatable ON vault.outside_items
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND updated_by = current_setting('app.account_id', true));

DROP POLICY IF EXISTS vault_outside_reads_readable ON vault.outside_reads;
CREATE POLICY vault_outside_reads_readable ON vault.outside_reads
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_outside_reads_insertable ON vault.outside_reads;
CREATE POLICY vault_outside_reads_insertable ON vault.outside_reads
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND asked_by = current_setting('app.account_id', true));

-- ---------------------------------------------------------------------------
-- TWO MORE ORGANISATION-CHAIN ENTRY TYPES. `vault_outside_changed` (connected, stopped,
-- disconnected, pulled, changed, removed, restored) and `vault_outside_read`. The list below is
-- 0044's, plus these. Mirrored by `EntryType::kinds()` in `src/chain.rs`.
-- ---------------------------------------------------------------------------
ALTER TABLE chain_entries NO FORCE ROW LEVEL SECURITY;

ALTER TABLE chain_entries
    DROP CONSTRAINT IF EXISTS chain_entries_type_belongs_to_kind;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_type_belongs_to_kind
    CHECK (
        (chain_kind = 'design'
             AND entry_type IN ('create', 'update', 'reencrypt', 'change'))
     OR (chain_kind = 'site'
             AND entry_type IN ('deployment_started', 'shipper_gap',
                                'spool_pressure', 'rewrap',
                                'account_signin', 'account_signin_failed',
                                'account_signed_out',
                                'operator_signin', 'operator_signin_failed',
                                'operator_signed_out',
                                'account_disabled', 'account_enabled',
                                'account_created',
                                'operator_bootstrapped', 'operator_created',
                                'operator_seconded', 'operator_enrolled',
                                'operator_disabled', 'operator_read',
                                'enrolment_token_issued', 'enrolment_token_redeemed',
                                'enrolment_token_expired',
                                'authenticator_registered',
                                'org_shell_created',
                                'setting_requested', 'setting_seconded',
                                'setting_applied', 'setting_cancelled',
                                'setting_unresolvable', 'single_operator_mode',
                                'grant_suspended',
                                'password_set', 'totp_enrolled',
                                'reset_requested', 'reset_spent',
                                'backup_code_used',
                                'operator_recovered_from_host',
                                'console_placement_requested',
                                'console_placement_confirmed',
                                'console_placement_reverted',
                                'operator_key_enrolled',
                                'operator_seat_hold_cleared',
                                'operator_adopted'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced',
                                'firmware_staged', 'firmware_fetch_issued',
                                'firmware_fetch_redeemed',
                                'invitation_issued', 'invitation_closed',
                                'firmware_models_changed',
                                -- 0041.
                                'type_it_yourself_set',
                                -- 0042.
                                'vault_key_enrolled', 'vault_key_superseded',
                                'vault_entry_created', 'vault_shared',
                                'vault_share_revoked', 'vault_entry_deleted',
                                'vault_recovery_used',
                                -- 0043.
                                'vault_mode_changed', 'vault_read',
                                -- 0044.
                                'vault_breach_policy_set',
                                -- 0045.
                                'vault_outside_changed', 'vault_outside_read'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
