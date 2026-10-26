-- 0042 -- the password vault, Mode A (ADR-0042, ADR-0043 §6, storage design §5 and §13,
-- ADR-0071).
--
-- A password is sealed IN THE BROWSER under its own random content key. That content key is
-- wrapped once per recipient (ECDH P-256 + HKDF-SHA256 + AES-256-GCM, storage §13.7) to each
-- recipient's vault public key, and the set of recipients is signed by whoever shared it, with
-- their account key (§13.3). The server stores public keys, wraps, signatures and ciphertext.
-- It holds no key that opens a password, so a stolen copy of these tables, or a backup of
-- them, yields nothing readable. A running server that someone has taken over is a different
-- risk: it serves the JavaScript (§13.6), and nothing in this file defends against that.
--
-- ---------------------------------------------------------------------------
-- ITS OWN SCHEMA, AND WHY
-- ---------------------------------------------------------------------------
--
-- ADR-0042 §4 item 4: vault rows do not share a table with design data, "and ideally not a
-- schema". The backup work asked for the same thing so the vault can be dumped, restored and
-- left out on its own (`pg_dump -n vault`). So: schema `vault`, in the same database.
--
-- **No default privileges.** `0006` gives `fathom_app` every future table in `public` by
-- default; nothing does that here. Each table below is granted by name, so a table added to
-- this schema next year is unreadable until someone writes the grant in the same diff (§13.5
-- R4's "explicit read allowlist"). The operator plane is given no USAGE on the schema at all:
-- it cannot name a vault table, let alone read one.
--
-- **No column is named for a password.** `tests/operators.rs` allows exactly one such column
-- in the whole catalogue (`accounts.password_hash`); the ciphertext here is `secret_ct`.
--
-- ---------------------------------------------------------------------------
-- WHO ROW SECURITY LETS DO WHAT
-- ---------------------------------------------------------------------------
--
-- Every table is tenant-pinned through `app.tenant_id`, as `cable_corrections` is (0036).
-- Inserts are pinned to the session's account through `app.account_id`, so an account cannot
-- file a key, an entry or a share in somebody else's name. There is no DELETE anywhere: an
-- entry is deleted by tombstone, its ciphertext overwritten; a key is superseded, never
-- removed. Updates are column grants. Whether a person may do an act is decided in
-- `src/vault.rs`, under these fences, never instead of them.
CREATE SCHEMA IF NOT EXISTS vault;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
GRANT USAGE ON SCHEMA vault TO fathom_app;

-- ---------------------------------------------------------------------------
-- A. VAULT KEYS -- one live per person per organisation, and the recovery sheet
--
-- `kind = 'person'`: generated in the person's browser. Its private half is sealed (AES-GCM)
-- under a key derived with Argon2id from their passphrase AND the 128-bit vault key Fathom
-- showed them once (ADR-0043 §6: two secrets combined, not two doors). The `kdf_*` columns
-- are the salt and costs, not secrets.
--
-- `kind = 'recovery'`: the organisation's recovery sheet. Generated in a steward's browser;
-- its private half is sealed under a key derived (HKDF-SHA256) from a 128-bit secret printed
-- on the sheet and never sent. One live per organisation.
--
-- `signature` is an ES256 signature, by an account key of `created_by` named by
-- `signer_key_fpr`, over the length-prefixed bytes `src/vault.rs` documents (§13.2's
-- `vault_key_bytes`). The server cannot fabricate a recipient key: a fabricated one has no
-- signature from a real account key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.keys (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id               text        NOT NULL CHECK (char_length(id) = 26),
    kind             text        NOT NULL CHECK (kind IN ('person', 'recovery')),
    account_id       text        REFERENCES accounts(id) ON DELETE RESTRICT,
    created_by       text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_kind   text        GENERATED ALWAYS AS ('steward') STORED,
    public_key       bytea       NOT NULL
                     CHECK (octet_length(public_key) = 65 AND get_byte(public_key, 0) = 4),
    fpr              bytea       NOT NULL UNIQUE CHECK (octet_length(fpr) = 32),
    alg              smallint    NOT NULL CHECK (alg = 1),
    kdf_salt         bytea       CHECK (kdf_salt IS NULL OR octet_length(kdf_salt) = 16),
    kdf_m_kib        integer     CHECK (kdf_m_kib IS NULL OR kdf_m_kib BETWEEN 19456 AND 262144),
    kdf_t            integer     CHECK (kdf_t IS NULL OR kdf_t BETWEEN 2 AND 10),
    kdf_p            integer     CHECK (kdf_p IS NULL OR kdf_p BETWEEN 1 AND 4),
    sealed_private   bytea       NOT NULL CHECK (octet_length(sealed_private) BETWEEN 16 AND 512),
    sealed_nonce     bytea       NOT NULL CHECK (octet_length(sealed_nonce) = 12),
    signer_key_fpr   bytea       NOT NULL CHECK (octet_length(signer_key_fpr) = 32),
    enrolled_at_unix bigint      NOT NULL,
    signature        bytea       NOT NULL CHECK (octet_length(signature) = 64),
    created_at       timestamptz NOT NULL DEFAULT now(),
    chain_seq        bigint      NOT NULL CHECK (chain_seq >= 1),
    superseded_by    text,
    superseded_at    timestamptz,
    succession_sig   bytea       CHECK (succession_sig IS NULL OR octet_length(succession_sig) = 64),
    PRIMARY KEY (organisation_id, id),
    CHECK ((kind = 'person') = (account_id IS NOT NULL)),
    CHECK (kind <> 'person' OR account_id = created_by),
    CHECK ((kind = 'person') = (kdf_salt IS NOT NULL AND kdf_m_kib IS NOT NULL
                                AND kdf_t IS NOT NULL AND kdf_p IS NOT NULL)),
    CHECK ((superseded_by IS NULL) = (superseded_at IS NULL)),
    CHECK (superseded_by IS NULL OR superseded_by <> id),
    -- §13.5 R4: every account column is a principal of kind 'steward', in the migration that
    -- creates the table, so an operator can never be an owner, recipient or signer.
    FOREIGN KEY (created_by, principal_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (account_id, principal_kind) REFERENCES principals (id, kind)
);

CREATE UNIQUE INDEX IF NOT EXISTS vault_keys_one_live_person
    ON vault.keys (organisation_id, account_id) WHERE kind = 'person' AND superseded_by IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vault_keys_one_live_recovery
    ON vault.keys (organisation_id) WHERE kind = 'recovery' AND superseded_by IS NULL;

-- ---------------------------------------------------------------------------
-- B. ENTRIES -- one stored login
--
-- `meta_ct` is sealed BY THE SERVER under the organisation content key (as 0036's corrections
-- are): the name, what kind of login it is, and which devices it is used on. Stewards see
-- those, so the server must be able to open them; a dump does not.
--
-- `secret_ct` is sealed BY THE BROWSER under the entry's content key at `epoch`: user name,
-- the password itself, and a note. The server cannot open it. Every change of the secret or
-- of who holds it is a new epoch with a fresh content key, so a removed recipient's old wrap
-- opens nothing current.
--
-- `needs_rotation`: a steward took someone's access away without being able to re-encrypt
-- (they cannot read it). The next recipient to unlock is asked to rotate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.entries (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id              text        NOT NULL CHECK (id ~ '^cred_[0-9A-HJKMNP-TV-Z]{26}$'),
    owner           text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    created_by      text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,
    created_at      timestamptz NOT NULL DEFAULT now(),
    meta_ct         bytea       NOT NULL,
    meta_nonce      bytea       NOT NULL CHECK (octet_length(meta_nonce) = 12),
    meta_key_epoch  integer     NOT NULL CHECK (meta_key_epoch >= 1),
    epoch           integer     NOT NULL CHECK (epoch >= 1),
    secret_ct       bytea       NOT NULL CHECK (octet_length(secret_ct) <= 8192),
    secret_nonce    bytea       NOT NULL CHECK (octet_length(secret_nonce) = 12),
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    needs_rotation  boolean     NOT NULL DEFAULT false,
    deleted_at      timestamptz,
    deleted_by      text        REFERENCES accounts(id) ON DELETE RESTRICT,
    PRIMARY KEY (organisation_id, id),
    CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
    -- A deleted entry keeps no ciphertext: the tombstone is all that remains.
    CHECK (deleted_at IS NULL OR octet_length(secret_ct) = 0),
    FOREIGN KEY (owner, principal_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (created_by, principal_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (updated_by, principal_kind) REFERENCES principals (id, kind)
);

-- ---------------------------------------------------------------------------
-- C. WRAPS -- the entry's content key at one epoch, for one recipient key
--
-- `wrap = LP(eph_pub) ‖ LP(nonce) ‖ LP(ciphertext)`, §13.7. `wrap_digest` is what the signed
-- recipient set binds, so wraps cannot be swapped between recipients. A wrap no `shares` row
-- covers is not a recipient: the read path refuses to serve it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.wraps (
    organisation_id  text        NOT NULL,
    entry_id         text        NOT NULL,
    epoch            integer     NOT NULL CHECK (epoch >= 1),
    recipient_key_id text        NOT NULL,
    wrap             bytea       NOT NULL CHECK (octet_length(wrap) BETWEEN 100 AND 200),
    wrap_digest      bytea       NOT NULL CHECK (octet_length(wrap_digest) = 32),
    revoked_at       timestamptz,
    revoked_by       text        REFERENCES accounts(id) ON DELETE RESTRICT,
    PRIMARY KEY (organisation_id, entry_id, epoch, recipient_key_id),
    FOREIGN KEY (organisation_id, entry_id) REFERENCES vault.entries (organisation_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (organisation_id, recipient_key_id) REFERENCES vault.keys (organisation_id, id)
        ON DELETE RESTRICT,
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- ---------------------------------------------------------------------------
-- D. SHARES -- the signed recipient set of one epoch (§13.3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.shares (
    organisation_id text        NOT NULL,
    entry_id        text        NOT NULL,
    epoch           integer     NOT NULL CHECK (epoch >= 1),
    sharer          text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,
    sharer_key_fpr  bytea       NOT NULL CHECK (octet_length(sharer_key_fpr) = 32),
    share_bytes     bytea       NOT NULL CHECK (octet_length(share_bytes) <= 65536),
    signature       bytea       NOT NULL CHECK (octet_length(signature) = 64),
    via_recovery    boolean     NOT NULL DEFAULT false,
    at_unix         bigint      NOT NULL,
    chain_seq       bigint      NOT NULL CHECK (chain_seq >= 1),
    PRIMARY KEY (organisation_id, entry_id, epoch),
    FOREIGN KEY (organisation_id, entry_id) REFERENCES vault.entries (organisation_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (sharer, principal_kind) REFERENCES principals (id, kind)
);

-- ---------------------------------------------------------------------------
-- E. RECOVERY USES -- every opening of the recovery sheet, for the standing banner
--
-- The sealed `vault_recovery_used` chain entry is the record; this row is what the admin
-- page reads to say so to every steward, without opening the chain.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.recovery_uses (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id              text        NOT NULL CHECK (char_length(id) = 26),
    recovery_key_id text        NOT NULL,
    used_by         text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,
    used_at         timestamptz NOT NULL DEFAULT now(),
    chain_seq       bigint      NOT NULL CHECK (chain_seq >= 1),
    PRIMARY KEY (organisation_id, id),
    FOREIGN KEY (organisation_id, recovery_key_id) REFERENCES vault.keys (organisation_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (used_by, principal_kind) REFERENCES principals (id, kind)
);

-- ---------------------------------------------------------------------------
-- F. GRANTS AND ROW SECURITY
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON vault.keys, vault.entries, vault.wraps, vault.shares,
    vault.recovery_uses TO fathom_app;
GRANT UPDATE (superseded_by, superseded_at, succession_sig) ON vault.keys TO fathom_app;
GRANT UPDATE (meta_ct, meta_nonce, meta_key_epoch, epoch, secret_ct, secret_nonce, version,
              updated_at, updated_by, needs_rotation, deleted_at, deleted_by)
    ON vault.entries TO fathom_app;
GRANT UPDATE (revoked_at, revoked_by) ON vault.wraps TO fathom_app;

ALTER TABLE vault.keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.keys FORCE ROW LEVEL SECURITY;
ALTER TABLE vault.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.entries FORCE ROW LEVEL SECURITY;
ALTER TABLE vault.wraps ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.wraps FORCE ROW LEVEL SECURITY;
ALTER TABLE vault.shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.shares FORCE ROW LEVEL SECURITY;
ALTER TABLE vault.recovery_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.recovery_uses FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vault_keys_readable ON vault.keys;
CREATE POLICY vault_keys_readable ON vault.keys
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_keys_insertable ON vault.keys;
CREATE POLICY vault_keys_insertable ON vault.keys
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND created_by = current_setting('app.account_id', true));
DROP POLICY IF EXISTS vault_keys_updatable ON vault.keys;
CREATE POLICY vault_keys_updatable ON vault.keys
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS vault_entries_readable ON vault.entries;
CREATE POLICY vault_entries_readable ON vault.entries
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_entries_insertable ON vault.entries;
CREATE POLICY vault_entries_insertable ON vault.entries
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND created_by = current_setting('app.account_id', true)
                       AND owner = current_setting('app.account_id', true)
                       AND updated_by = current_setting('app.account_id', true));
DROP POLICY IF EXISTS vault_entries_updatable ON vault.entries;
CREATE POLICY vault_entries_updatable ON vault.entries
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND updated_by = current_setting('app.account_id', true)
                    AND (deleted_by IS NULL
                         OR deleted_by = current_setting('app.account_id', true)));

DROP POLICY IF EXISTS vault_wraps_readable ON vault.wraps;
CREATE POLICY vault_wraps_readable ON vault.wraps
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_wraps_insertable ON vault.wraps;
CREATE POLICY vault_wraps_insertable ON vault.wraps
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND revoked_at IS NULL);
DROP POLICY IF EXISTS vault_wraps_updatable ON vault.wraps;
CREATE POLICY vault_wraps_updatable ON vault.wraps
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND revoked_by = current_setting('app.account_id', true));

DROP POLICY IF EXISTS vault_shares_readable ON vault.shares;
CREATE POLICY vault_shares_readable ON vault.shares
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_shares_insertable ON vault.shares;
CREATE POLICY vault_shares_insertable ON vault.shares
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND sharer = current_setting('app.account_id', true));

DROP POLICY IF EXISTS vault_recovery_uses_readable ON vault.recovery_uses;
CREATE POLICY vault_recovery_uses_readable ON vault.recovery_uses
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_recovery_uses_insertable ON vault.recovery_uses;
CREATE POLICY vault_recovery_uses_insertable ON vault.recovery_uses
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND used_by = current_setting('app.account_id', true));

-- ---------------------------------------------------------------------------
-- G. SEVEN ORGANISATION-CHAIN ENTRY TYPES (§13.4)
--
-- `vault_key_enrolled` (a person's key or the recovery sheet; `kind` is in the metadata),
-- `vault_key_superseded` (a person reset their vault), `vault_entry_created`, `vault_shared`
-- (every epoch: created, changed, shared, rotated), `vault_share_revoked`,
-- `vault_entry_deleted`, `vault_recovery_used`. **No `vault_read`**: a Mode A read is the
-- browser fetching ciphertext it may fetch, and an entry saying "Alice read this" would be a
-- false statement in an audit trail (§13.4). The list below is 0038's, plus these. Mirrored
-- by `EntryType::kinds()` in `src/chain.rs`.
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
                                'vault_recovery_used'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
