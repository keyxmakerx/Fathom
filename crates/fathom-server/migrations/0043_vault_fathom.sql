-- 0043 -- logins Fathom itself can use: the vault's Mode B (ADR-0042 §3, storage design §5 and
-- §13.4 to §13.5, ADR-0071 part two).
--
-- A Mode A login opens only in the browser of someone who holds it. A Mode B login ALSO has a
-- copy Fathom can open, so that Fathom can use it itself (Auto-populate signing in to a device
-- to read its configuration). The copy is sealed by the server (ChaCha20-Poly1305) under a key
-- derived from `vault.key`, a root key file of its own beside `master.key` and `chain.key`. It
-- protects against a stolen database or backup. **It does not protect against someone who has
-- taken over the running server**, and the interface says so at the moment of choosing.
--
-- The people who held the login keep holding it exactly as before: Mode B adds a copy, it does
-- not replace the browser-sealed one. Losing `vault.key` loses only Fathom's copies; whoever
-- holds a login can make the copy again.
--
-- Who may change a mode (storage §13.5):
--   R1  only someone who can currently open it (they must hand Fathom the secret);
--   R2  of those, only its owner may consent to A -> B, by an account-key signature over the
--       exact statement (`src/vault_fathom.rs`'s `mode_change_bytes`); when it is shared with
--       anyone besides the owner, another admin countersigns before Fathom may use it;
--   R3  B -> A is the cheap direction: the owner or any admin, no consent.
--
-- Every opening by Fathom is a `vault_read` entry on the organisation chain, filed BEFORE the
-- secret is opened, and a row in `fathom_reads` for the login's card.
--
-- As in 0042: no default privileges, every table granted by name, tenant-pinned row security,
-- no DELETE. Turning Mode B off empties the copy and keeps the row.

-- ---------------------------------------------------------------------------
-- A. FATHOM'S COPY -- one row per login that has ever been in Mode B
--
-- `state`: 'waiting' (consented, a steward's countersignature still needed; Fathom will not
-- use it), 'on', or 'off' (copy emptied). `copy_epoch` is the login's epoch the copy was made
-- at: a later epoch (a changed password) leaves the copy out of date until a holder refreshes
-- it, and an out-of-date copy is never used. `server_key_id` names the `vault.key` the copy is
-- sealed under, so a restore with the wrong key file says which key it needs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.fathom_copies (
    organisation_id      text        NOT NULL,
    entry_id             text        NOT NULL,
    state                text        NOT NULL CHECK (state IN ('waiting', 'on', 'off')),
    principal_kind       text        GENERATED ALWAYS AS ('steward') STORED,
    consented_by         text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    consent_bytes        bytea       NOT NULL CHECK (octet_length(consent_bytes) <= 65536),
    consent_key_fpr      bytea       NOT NULL CHECK (octet_length(consent_key_fpr) = 32),
    consent_sig          bytea       NOT NULL CHECK (octet_length(consent_sig) = 64),
    consent_at_unix      bigint      NOT NULL,
    countersign_needed   boolean     NOT NULL,
    countersigned_by     text        REFERENCES accounts(id) ON DELETE RESTRICT,
    countersign_key_fpr  bytea       CHECK (octet_length(countersign_key_fpr) = 32),
    countersign_sig      bytea       CHECK (octet_length(countersign_sig) = 64),
    countersigned_at_unix bigint,
    copy_epoch           integer     NOT NULL CHECK (copy_epoch >= 1),
    server_key_id        text        NOT NULL CHECK (server_key_id ~ '^[0-9a-f]{16}$'),
    copy_nonce           bytea       NOT NULL CHECK (octet_length(copy_nonce) = 12),
    copy_ct              bytea       NOT NULL CHECK (octet_length(copy_ct) <= 8208),
    updated_by           text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organisation_id, entry_id),
    FOREIGN KEY (organisation_id, entry_id) REFERENCES vault.entries (organisation_id, id)
        ON DELETE RESTRICT,
    FOREIGN KEY (consented_by, principal_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (countersigned_by, principal_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (updated_by, principal_kind) REFERENCES principals (id, kind),
    -- Off keeps no copy.
    CHECK (state <> 'off' OR octet_length(copy_ct) = 0),
    CHECK (state = 'off' OR octet_length(copy_ct) >= 17),
    -- A countersignature is all or nothing, and only where one was needed.
    CHECK ((countersigned_by IS NULL) = (countersign_sig IS NULL)
       AND (countersigned_by IS NULL) = (countersign_key_fpr IS NULL)
       AND (countersigned_by IS NULL) = (countersigned_at_unix IS NULL)),
    CHECK (countersigned_by IS NULL OR countersign_needed),
    CHECK (countersigned_by IS NULL OR countersigned_by <> consented_by),
    CHECK (state <> 'waiting' OR (countersign_needed AND countersigned_by IS NULL))
);

-- ---------------------------------------------------------------------------
-- B. FATHOM'S READS -- every time Fathom opened a copy, for the login's card
--
-- The sealed `vault_read` chain entry is the record; this row is what the card reads.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.fathom_reads (
    organisation_id text        NOT NULL,
    id              text        NOT NULL CHECK (char_length(id) = 26),
    entry_id        text        NOT NULL,
    epoch           integer     NOT NULL CHECK (epoch >= 1),
    purpose         text        NOT NULL CHECK (purpose ~ '^[a-z][a-z-]{0,39}$'),
    design_id       text        NOT NULL,
    element_id      text        NOT NULL CHECK (char_length(element_id) BETWEEN 1 AND 64),
    asked_by        text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,
    read_at         timestamptz NOT NULL DEFAULT now(),
    chain_seq       bigint      NOT NULL CHECK (chain_seq >= 1),
    PRIMARY KEY (organisation_id, id),
    FOREIGN KEY (organisation_id, entry_id) REFERENCES vault.fathom_copies (organisation_id, entry_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (asked_by, principal_kind) REFERENCES principals (id, kind)
);

CREATE INDEX IF NOT EXISTS vault_fathom_reads_by_entry
    ON vault.fathom_reads (organisation_id, entry_id, read_at DESC);

-- ---------------------------------------------------------------------------
-- C. GRANTS AND ROW SECURITY
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON vault.fathom_copies, vault.fathom_reads TO fathom_app;
GRANT UPDATE (state, consented_by, consent_bytes, consent_key_fpr, consent_sig, consent_at_unix,
              countersign_needed, countersigned_by, countersign_key_fpr, countersign_sig,
              countersigned_at_unix, copy_epoch, server_key_id, copy_nonce, copy_ct,
              updated_by, updated_at)
    ON vault.fathom_copies TO fathom_app;

ALTER TABLE vault.fathom_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.fathom_copies FORCE ROW LEVEL SECURITY;
ALTER TABLE vault.fathom_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault.fathom_reads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vault_fathom_copies_readable ON vault.fathom_copies;
CREATE POLICY vault_fathom_copies_readable ON vault.fathom_copies
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_fathom_copies_insertable ON vault.fathom_copies;
CREATE POLICY vault_fathom_copies_insertable ON vault.fathom_copies
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND consented_by = current_setting('app.account_id', true)
                       AND updated_by = current_setting('app.account_id', true));
DROP POLICY IF EXISTS vault_fathom_copies_updatable ON vault.fathom_copies;
CREATE POLICY vault_fathom_copies_updatable ON vault.fathom_copies
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND updated_by = current_setting('app.account_id', true));

DROP POLICY IF EXISTS vault_fathom_reads_readable ON vault.fathom_reads;
CREATE POLICY vault_fathom_reads_readable ON vault.fathom_reads
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS vault_fathom_reads_insertable ON vault.fathom_reads;
CREATE POLICY vault_fathom_reads_insertable ON vault.fathom_reads
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND asked_by = current_setting('app.account_id', true));

-- ---------------------------------------------------------------------------
-- D. TWO MORE ORGANISATION-CHAIN ENTRY TYPES (§13.4)
--
-- `vault_mode_changed` and `vault_read` (Mode B only). The list below is 0042's, plus these.
-- Mirrored by `EntryType::kinds()` in `src/chain.rs`.
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
                                'vault_mode_changed', 'vault_read'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
