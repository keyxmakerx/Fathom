-- 0007 -- the key hierarchy, the encrypted design payload, and the
-- tamper-evident history.
--
-- `docs/PHASE-2-STORAGE-DESIGN.md` §§4, 6, 7, 11.2 and 12, plus ADR-0043.
-- This is the first migration in this chain whose tables hold material
-- protected by a key, and `tests/no_key_protected_data.rs` changes shape in
-- the same commit because of it: from "no table holds key-protected data" to
-- "every table that does declares which column holds it, and a marker written
-- through the real write path appears in NO stored byte of ANY table".
--
-- ---------------------------------------------------------------------------
-- WHAT IS ENCRYPTED, AND BY WHOM. READ THIS BEFORE CHANGING ANYTHING HERE.
-- ---------------------------------------------------------------------------
--
-- §2a: **design data is encrypted by the SERVER.** The client sends plaintext
-- over TLS; the server encrypts, seals and stores. Plaintext designs exist in
-- the server process on every read and write. Encryption protects the
-- database, the backups and the disk -- not the running process, and nothing
-- customer-facing may describe design data as unreadable by Fathom.
--
-- What a dump without the key still discloses is §11.3's list and it is not
-- short: tenant identity, the whole organisation -> network -> building ->
-- rack tree, authorship, timestamps, activity volumes, and the size of every
-- version. *"Treat a backup as disclosing the estate's map legend, not its
-- map."*
--
-- ---------------------------------------------------------------------------
-- INVARIANT 11 -- STATED BECAUSE IT MUST BE, NOT BECAUSE IT BITES
-- ---------------------------------------------------------------------------
--
-- `.context/conventions.md` invariant 11: a migration that READS an existing
-- table must handle forced row-level security, because a migration runs with
-- no tenant context and a `SELECT` behind `FORCE ROW LEVEL SECURITY` returns
-- zero rows silently. **This migration reads no existing table.** It creates
-- new ones, adds no backfill, and copies nothing -- so there is no read to
-- wrap in a `NO FORCE`/`FORCE` pair. Any later edit that adds one must add
-- the pair with it; see `0004_principals.sql` for the shape.
--
-- ---------------------------------------------------------------------------
-- GRANTS: 0006 ALREADY DID IT
-- ---------------------------------------------------------------------------
--
-- `0006_runtime_role.sql` set `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER
-- IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
-- fathom_app`, resolved to whichever role applies this chain. Every table
-- below is created by that same role in that same schema, so `fathom_app`
-- arrives with exactly the four verbs and nothing else -- no ownership, no
-- DDL. Verified by `tests/runtime_role_split.rs` and by the live-schema sweep
-- in `tests/planes.rs`, not assumed here.
--
-- `fathom_operator` is granted NOTHING, and that is the fence rather than an
-- omission: `0005_planes.sql`'s header says it in advance -- *"a design table
-- added next year is therefore born unreadable by this role without anyone
-- remembering to come back here"*, because PostgreSQL grants nothing on a new
-- table to anybody and 0006's default privileges name only `fathom_app`.
-- `tests/planes.rs` enumerates the live schema table by table, so this claim
-- is checked on every run rather than written down once.

-- ---------------------------------------------------------------------------
-- master_keys -- ADR-0043 §4, the two things it forces.
--
-- **A NON-SECRET KEY ID, STAMPED SO A RESTORE WITH THE WRONG KEY SAYS SO.**
-- `key_id` is `HMAC-SHA-256(master key, "fathom/key/id/v1")` truncated to 8
-- bytes and rendered as hex (`src/crypto.rs`). It is a keyed one-way function
-- of the key: publishing it discloses nothing about 32 random bytes, and a
-- different key gives a different id. Without it, the most common operator
-- error -- restoring a database beside the wrong key file -- surfaces as an
-- AEAD tag failure, which reads exactly like corruption. With it,
-- `keys::register_master_key` reports *"this database was encrypted under
-- master key a41f...; the configured key is 9c02..."* and stops.
--
-- **RETIRED MASTER KEYS ARE KEPT FOREVER.** OWASP, quoted in ADR-0043 §4:
-- *"old keys should generally be stored for a certain period after they have
-- been retired, in case old backups of copies of the data need to be
-- decrypted."* A rotation that deletes the old key silently destroys every
-- existing backup. There is no `DELETE` path to this table anywhere in the
-- server, and rows are retired by setting `status`, never removed.
--
-- NO ROW-LEVEL SECURITY, DELIBERATELY: this table is not tenant data. It
-- holds no key and no tenant identifier -- only which key ids this database
-- has ever been encrypted under. The fence that matters for it is the one
-- above: `fathom_operator` holds no privilege on it at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_keys (
    -- 8 bytes as 16 hex characters. NOT the key, and there is no column here
    -- that could hold one.
    key_id        text        PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{16}$'),
    status        text        NOT NULL CHECK (status IN ('active', 'retired')),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    retired_at    timestamptz,
    retired_reason text,
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

-- One active master key at a time. A second would make "which key was this
-- database encrypted under" ambiguous, which is the question this table
-- exists to answer.
CREATE UNIQUE INDEX IF NOT EXISTS master_keys_one_active_idx
    ON master_keys ((true)) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- tenant_keys -- one per organisation, random, wrapped under the master key.
--
-- §4: **data keys are random and WRAPPED, never derived.** Derivation would
-- bind identity for free and destroy the byte-identical re-wrap requirement
-- in the same section; the two readings were mutually exclusive and this is
-- the one that was chosen. Identity binds instead by sealing
-- `LP(aad_bytes) || key` as the wrapped plaintext with the AEAD's own
-- associated-data channel EMPTY, so an unwrap RECOVERS the identity and
-- compares it at exactly one code path (`crypto::unwrap_key`) -- which is
-- what makes `Misbound` a different word from `Refused`.
--
-- **AND THE BINDING IS NOT WHAT PRESERVES TENANT SEPARATION.** §4 again: the
-- tenant key is pinned from the authenticated request context for the
-- request's lifetime and NEVER taken from the row being read
-- (`repo::TenantContext`, which only `repo::open_tenant_context` can build).
-- The AAD binding buys distinguishable errors and catches a design-id
-- substitution within a tenant. §7's claim that layer 2 "has no such failure
-- mode" is true only because of that pinning.
--
-- RE-WRAP AND ROTATION ARE DIFFERENT OPERATIONS AND THE COLUMNS SAY SO
-- (§12.6). Re-wrap changes custody: the data key is unchanged, only its
-- wrapping changes, so ciphertext, nonce, `content_hash` and
-- `storage_binding` stay byte-identical and it touches ONLY
-- `wrapped_key`, `wrap_nonce`, `master_key_id`, `master_key_epoch`,
-- `wrap_version`, `rewrapped_at`, `rewrapped_by`. **It must not touch
-- `key_epoch` or the payload table at all** -- if a re-wrap moves
-- `key_epoch`, the two operations are conflated in the schema and no
-- interface can separate them afterwards. Rotation re-encrypts: new key, new
-- `key_epoch` (monotonic, never overwritten), new ciphertext, new
-- `storage_binding`, a `reencrypt` chain entry per version, and the old row
-- kept forever with `status = 'retired'`.
--
-- `status = 'compromised'` is what tells an operator a re-wrap was not
-- enough. §12.6: *"anyone who holds the previous master key and a copy of the
-- key rows taken before this switch can still decrypt all data, including
-- data written after it. This changed custody, not exposure. To revoke that
-- access, run a rotation."*
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_keys (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    -- Monotonic per organisation, never overwritten. ROTATION advances this;
    -- RE-WRAP MUST NOT.
    key_epoch        int         NOT NULL CHECK (key_epoch >= 1),

    -- The data key's own non-secret id, so a verifier can name which key a
    -- row was written under without unwrapping anything.
    key_id           text        NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),

    -- The key, sealed under the master key. Not a key in the clear, and the
    -- master key it is sealed under is never in this database (ADR-0043 §1).
    wrapped_key      bytea       NOT NULL,
    wrap_nonce       bytea       NOT NULL CHECK (octet_length(wrap_nonce) = 12),
    master_key_id    text        NOT NULL REFERENCES master_keys(key_id),
    master_key_epoch int         NOT NULL DEFAULT 1 CHECK (master_key_epoch >= 1),
    wrap_version     int         NOT NULL CHECK (wrap_version >= 1),
    aead_alg_id      smallint    NOT NULL CHECK (aead_alg_id >= 1),

    status           text        NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'retired', 'compromised')),

    -- A DETECTOR, NEVER THE NONCE SOURCE (§12.3). It alarms if a key
    -- approaches the birthday budget; it does not feed a nonce. See the
    -- comment on `design_keys.writes_under_key` for why that distinction is
    -- the whole safety argument.
    writes_under_key bigint      NOT NULL DEFAULT 0 CHECK (writes_under_key >= 0),

    created_at       timestamptz NOT NULL DEFAULT now(),
    retired_at       timestamptz,
    retired_reason   text,

    -- RE-WRAP'S columns, and only re-wrap's. Present from the first
    -- migration even though this order implements rotation and not re-wrap:
    -- §12.6 asks for both sets now, because a schema that conflated them
    -- could not be separated by any interface afterwards.
    rewrapped_at     timestamptz,
    rewrapped_by     text        REFERENCES principals(id),

    PRIMARY KEY (organisation_id, key_epoch),
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_keys_one_active_idx
    ON tenant_keys (organisation_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- designs -- the thing a payload is a version of.
--
-- NO NAME COLUMN, AND THAT IS DELIBERATE. `docs/OPEN-QUESTIONS.md` V2 and
-- §11.3 decided in principle that a design's name is encrypted; §11.3 cost 3
-- is the half that is actually expensive -- *"every server-side surface that
-- names a design loses the name ... and a plaintext copy in the audit log is
-- the leak returning through a side door."* A plaintext `display_name` here
-- would be that copy, created by this order and inherited by everything
-- after it. A design is addressed by its opaque id until the encrypted-name
-- column lands with the surfaces that render it.
--
-- `UNIQUE (id, organisation_id)` exists for the composite foreign keys below:
-- it is `0004_principals.sql`'s fence in a second place. A payload row or a
-- chain entry cannot name a tenant other than its design's, because the
-- reference would not resolve -- and referential integrity binds at every
-- privilege level, including for a superuser, which row-level security does
-- not.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS designs (
    id              text        PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    -- Where in the estate this design hangs. `RESTRICT`, not `CASCADE`:
    -- deleting a rack must not silently delete the designs filed under it.
    scope_id        text        NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      text        NOT NULL REFERENCES accounts(id),
    UNIQUE (id, organisation_id)
);

CREATE INDEX IF NOT EXISTS designs_org_scope_idx ON designs (organisation_id, scope_id);

-- ---------------------------------------------------------------------------
-- design_keys -- one per design. MANDATORY, NOT PREFERRED, AND HERE IS WHY.
--
-- §12.3, and this comment is the one that section asks to be written here so
-- nobody relaxes it later:
--
--   Nonces are **fresh random 96 bits** per operation. The implementer
--   documentation reachable on 2026-09-12 does not list "random" among the
--   safe nonce choices for ChaCha20-Poly1305-IETF, and the CFRG's usage-limits
--   draft encourages counters. Counters were rejected on an OPERATIONAL
--   ground: a counter is safe only while the key never moves backwards, and
--   **restoring a backup moves it backwards**. A self-hosted product shipped
--   as Docker containers to network engineers will have its database restored
--   from a snapshot; that is routine. A restore resets the counter while the
--   key stays the same, and the next writes reuse nonces already spent --
--   silent, catastrophic, and triggered by the most normal operation an
--   operator performs.
--
--   Random nonces have no such failure mode. Their cost is the birthday bound
--   on 96 bits -- 2^32 messages under one key is about 2^-33, 2^24 about
--   2^-49 -- and a collision is not gradual: two messages under one
--   (key, nonce) leak the XOR of the plaintexts AND the Poly1305 one-time
--   key, so it is forgery too.
--
--   **PER-DESIGN KEYS ARE WHAT MAKES THAT BOUND IRRELEVANT**, because 2^24
--   writes is 16.7 million versions OF ONE DESIGN. They may not be relaxed to
--   per-tenant without revisiting §12.3. If they ever are, the fallback is
--   XChaCha20-Poly1305 (192-bit nonce), which the same crate already ships at
--   no extra dependency -- that is what `aead_alg_id` is for.
--
-- Wrapped under the TENANT key, not the master key: §4's two-level hierarchy,
-- so custody changes by re-wrapping tenant keys rather than by re-encrypting
-- every design.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_keys (
    design_id        text        NOT NULL,
    organisation_id  text        NOT NULL,
    key_epoch        int         NOT NULL CHECK (key_epoch >= 1),

    key_id           text        NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),

    wrapped_key      bytea       NOT NULL,
    wrap_nonce       bytea       NOT NULL CHECK (octet_length(wrap_nonce) = 12),
    -- Which tenant key epoch wraps this one. The tenant-key equivalent of
    -- `tenant_keys.master_key_id`.
    tenant_key_epoch int         NOT NULL CHECK (tenant_key_epoch >= 1),
    wrap_version     int         NOT NULL CHECK (wrap_version >= 1),
    aead_alg_id      smallint    NOT NULL CHECK (aead_alg_id >= 1),

    status           text        NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'retired', 'compromised')),

    -- See the header: a detector, never the nonce source.
    writes_under_key bigint      NOT NULL DEFAULT 0 CHECK (writes_under_key >= 0),

    created_at       timestamptz NOT NULL DEFAULT now(),
    retired_at       timestamptz,
    retired_reason   text,
    rewrapped_at     timestamptz,
    rewrapped_by     text        REFERENCES principals(id),

    PRIMARY KEY (design_id, key_epoch),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE CASCADE,
    FOREIGN KEY (organisation_id, tenant_key_epoch) REFERENCES tenant_keys (organisation_id, key_epoch),
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS design_keys_one_active_idx
    ON design_keys (design_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- design_payload -- the ciphertext. One row per version.
--
-- §3: **the payload is encrypted as a whole.** Partial encryption leaks
-- structure -- encrypt the device names and leave link counts, node counts
-- and edge types in the clear and an attacker with the database learns the
-- estate's shape without decrypting anything. *"The map IS the secret;
-- encrypting it piecemeal protects the labels and gives away the drawing."*
-- What that costs, stated rather than discovered: no server-side search, no
-- server-side rendering ever, and no cross-design queries without a
-- separately built index.
--
-- `key_epoch` IS STORED HERE AND NOT ONLY FED INTO THE MAC (§12.6), so a
-- verifier can find the key a row was written under without trial-decrypting
-- against every epoch.
--
-- No `byte_len` column: `octet_length(ciphertext)` already answers it, and
-- §10's open item notes per-version size is a device-count oracle. A second
-- copy of a disclosure is still a disclosure, and this one would have been
-- free to avoid.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS design_payload (
    design_id              text        NOT NULL,
    organisation_id        text        NOT NULL,
    design_version         bigint      NOT NULL CHECK (design_version >= 1),

    -- THE ONLY PLACE A DESIGN'S CONTENTS EXIST AT REST. Tag included; the
    -- AEAD appends it.
    ciphertext             bytea       NOT NULL,
    nonce                  bytea       NOT NULL CHECK (octet_length(nonce) = 12),

    key_epoch              int         NOT NULL CHECK (key_epoch >= 1),
    wrap_version           int         NOT NULL CHECK (wrap_version >= 1),
    aead_alg_id            smallint    NOT NULL CHECK (aead_alg_id >= 1),
    payload_schema_version int         NOT NULL CHECK (payload_schema_version >= 1),

    created_at             timestamptz NOT NULL DEFAULT now(),
    created_by             text        NOT NULL REFERENCES accounts(id),

    PRIMARY KEY (design_id, design_version),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE CASCADE,
    FOREIGN KEY (design_id, key_epoch) REFERENCES design_keys (design_id, key_epoch)
);

-- ---------------------------------------------------------------------------
-- chain_entries -- the tamper-evident history, §11.2 exactly.
--
--   plaintext_binding = MAC(K_content, LP("fathom/chain/plaintext/v1")
--       || LP(tenant_id) || LP(design_id) || u64(design_version)
--       || u32(payload_schema_version) || LP(plaintext_payload_bytes))
--   storage_binding   = MAC(K_content, LP("fathom/chain/storage/v1")
--       || LP(key_id) || u32(key_epoch) || u32(wrap_version) || u16(aead_alg_id)
--       || LP(nonce) || LP(ciphertext_including_tag))
--   content_hash      = MAC(K_content, LP("fathom/chain/content/v1")
--       || LP(plaintext_binding) || LP(storage_binding))
--   seal_n            = MAC(K_seal, LP("fathom/chain/seal/v1")
--       || u32(chain_key_epoch) || u64(seq_n) || LP(tenant_id) || LP(design_id)
--       || LP(seal_{n-1}) || LP(content_hash_n) || LP(entry_type)
--       || LP(canon(metadata_n)))
--
-- **BOTH BINDINGS, KEPT SEPARABLE** -- that is what dissolves the dilemma
-- §10 major 4 stated. The plaintext binding is rotation-invariant, so a key
-- upgrade does not invalidate it; the storage binding pins the actual bytes,
-- so a swapped blob is caught without decrypting anything.
--
-- **`content_hash` IS KEYED AND THAT IS NOT DECORATION.** An unkeyed hash of
-- plaintext is a confirmation oracle for anyone holding a dump: they can test
-- whether two versions are identical, whether two tenants hold the same
-- design, or whether a guessed payload is the real one -- with no key.
-- Keying costs nothing, because every verifier already holds the chain key.
--
-- **THE MAC IS HMAC-SHA-256 AND POLY1305 MAY NEVER REPLACE IT** (§11.2,
-- §12.1). RustCrypto's own source: *"Poly1305 is not a traditional MAC and is
-- single-use only (a.k.a. 'one-time authenticator')."* It is sound inside
-- ChaCha20-Poly1305, which gives it a fresh one-time key per message.
--
-- `chain_key_epoch` IS ON EVERY ENTRY and retired chain keys are kept
-- forever: without it, verification cannot tell "a key I do not have" from
-- "broken", and those are different answers (§11.2's third outcome).
--
-- WHAT THIS DOES NOT DO, kept here because a log mistaken for a control is
-- worse than no log (§6's B4 and B5 fixes):
--   * Each seal binds BACKWARDS only, so deleting the last three entries
--     leaves the survivors verifying end to end. Nothing inside the database
--     detects truncation or a wholesale rollback to last month's tables. The
--     fix is an ANCHOR OUTSIDE THE DEPLOYMENT -- a periodic tip digest
--     exported where the database administrator cannot reach it. That is the
--     baseline, it is not built here, and `seq` does not substitute for it.
--   * It detects a database-only attacker. It does not constrain anyone who
--     can run code on the server, because the chain key is live in that
--     process on every write.
--   * Per-design chains do not prove the SET of designs is complete.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chain_entries (
    design_id         text        NOT NULL,
    organisation_id   text        NOT NULL,
    -- Contiguous from 1. In the MAC input, and it does NOT detect tail
    -- truncation -- recorded so nobody mistakes it for the fix.
    seq               bigint      NOT NULL CHECK (seq >= 1),

    entry_type        text        NOT NULL
                                  CHECK (entry_type IN ('create', 'update', 'reencrypt')),
    chain_key_epoch   int         NOT NULL CHECK (chain_key_epoch >= 1),
    design_version    bigint      NOT NULL CHECK (design_version >= 1),

    prev_seal         bytea       NOT NULL CHECK (octet_length(prev_seal) = 32),
    plaintext_binding bytea       NOT NULL CHECK (octet_length(plaintext_binding) = 32),
    storage_binding   bytea       NOT NULL CHECK (octet_length(storage_binding) = 32),
    content_hash      bytea       NOT NULL CHECK (octet_length(content_hash) = 32),
    seal              bytea       NOT NULL CHECK (octet_length(seal) = 32),

    -- `fathom-canon`'s canonical bytes, stored exactly as they entered the
    -- seal. Stored rather than rebuilt, because a verifier must MAC the bytes
    -- that were sealed, not the bytes a later version of a serialiser would
    -- produce.
    metadata          bytea       NOT NULL,

    created_at        timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (design_id, seq),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chain_entries_design_version_idx
    ON chain_entries (design_id, design_version);

-- ---------------------------------------------------------------------------
-- Tenant isolation, §7, in exactly the shape 0003 and 0005 fixed.
--
-- EVERY POLICY BELOW NAMES ITS COMMAND. NONE IS `FOR ALL`. A `CREATE POLICY`
-- with `USING` and no `FOR` is `FOR ALL`, and PostgreSQL then REUSES the
-- `USING` expression as the `WITH CHECK` for every write -- which is exactly
-- how `memberships_isolation` became "any transaction may insert a membership
-- granting its own account any role in any organisation", reproduced end to
-- end on 2026-09-12 (`0003_write_side_isolation.sql`'s header).
--
-- Layer 1 (this) fails open when a policy is wrong; layer 2 (a different
-- tenant's rows are under a different key) does not. Neither alone, and the
-- repository layer names the tenant in every WHERE clause as well.
-- ---------------------------------------------------------------------------

ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_keys_readable ON tenant_keys
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_keys_insertable ON tenant_keys
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY tenant_keys_updatable ON tenant_keys
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
-- No DELETE policy, deliberately: a deleted key row is every version ever
-- written under it, unreadable forever. Retirement is a `status` change.

ALTER TABLE designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE designs FORCE ROW LEVEL SECURITY;

CREATE POLICY designs_readable ON designs
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY designs_insertable ON designs
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY designs_updatable ON designs
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY designs_deletable ON designs
    FOR DELETE USING (organisation_id = current_setting('app.tenant_id', true));

ALTER TABLE design_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY design_keys_readable ON design_keys
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY design_keys_insertable ON design_keys
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY design_keys_updatable ON design_keys
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- design_payload gets the THIRD fence as well as the tenant one:
-- `app.design_capability`, which `0005_planes.sql`'s header deferred to
-- exactly this migration -- *"a policy cannot be written against a table that
-- does not exist, and writing it later, separately, is how a payload table
-- ships for a week without one."*
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §11.1: the setting is written from
-- a verified authorisation and nothing else. `repo::open_tenant_context` sets
-- it to `no` BEFORE it examines anything, and only a membership read back
-- through `memberships_readable` turns it into `yes`. Absence -- the empty
-- string -- is already a refusal, so a code path that forgets to set it fails
-- CLOSED. An operator transaction has no argument from which it could set
-- `app.tenant_id` at all, so it reads zero rows here twice over.
--
-- The capability gate is on the WRITE commands too, not only `SELECT`. A
-- fence that let an unauthorised transaction write a payload it could not
-- read would be a strange fence.
-- ---------------------------------------------------------------------------
ALTER TABLE design_payload ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_payload FORCE ROW LEVEL SECURITY;

CREATE POLICY design_payload_readable ON design_payload
    FOR SELECT USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
CREATE POLICY design_payload_insertable ON design_payload
    FOR INSERT WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
CREATE POLICY design_payload_updatable ON design_payload
    FOR UPDATE USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes')
            WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.design_capability', true) = 'yes');
-- No DELETE policy: nothing in this server deletes a version, and the
-- database refuses until something does and a rule is written for it in the
-- same diff (0003's rule for `accounts`).

ALTER TABLE chain_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY chain_entries_readable ON chain_entries
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY chain_entries_insertable ON chain_entries
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
-- NO UPDATE AND NO DELETE POLICY, AND THIS IS THE ONE TABLE WHERE THAT IS THE
-- POINT. With row security forced and no policy for a command, that command
-- reaches no rows at all -- so an append-only history is what the runtime
-- role can express, whatever a later query says. It is NOT append-only
-- against the table's owner or a superuser; that is what the seal is for, and
-- what `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md`'s `0008 chains` migration
-- (append-only triggers, a separate `fathom_audit` owner role) is for. This
-- migration does not build those.
