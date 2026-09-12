-- 0009 -- chains at three levels, encrypted organisation metadata, the
-- append-only fence made real, and the spool that gets sealed entries off the
-- box.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §§7.1, 7.2, 7.3, 7.7, 9 and 15.6;
-- `docs/PHASE-2-STORAGE-DESIGN.md` §§11.2, 12.2, 12.6.
--
-- **The admin design numbers its own migrations 0004-0009 and four of those
-- numbers were taken before it was written.** Its numbering is ignored here,
-- deliberately and on instruction; this is simply the next free number. What
-- is taken from it is the content of §7, not its file names.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR, IN ONE SENTENCE
-- ---------------------------------------------------------------------------
--
-- **Stopping the log must stop the act.** 0007 and 0008 built a per-design
-- sealed history. `keys::rotate_design_key`'s own doc records what could not
-- be finished with only that: §12.6 requires a re-wrap -- the operation that
-- changes who can decrypt everything -- to write a sealed entry on a
-- TENANT-LEVEL chain, and no such chain existed. A re-wrap with no audit
-- trail would have been the one security-relevant key operation leaving no
-- trace, in a system whose integrity story is an append-only sealed log. This
-- migration is what that was waiting for.
--
-- ---------------------------------------------------------------------------
-- ONE INTEGRITY MECHANISM, NOT TWO
-- ---------------------------------------------------------------------------
--
-- §7.1: *"reuse, not reinvention"*. `prev_seal`, `chain_key_epoch` on every
-- entry, retired chain keys kept forever, length-prefixing everywhere and the
-- verifier's ordering rules from §12.6a are unchanged. What is per level is
-- the chain key's derivation label, so entries cannot be spliced between
-- levels:
--
--   site_chain_key_e = HKDF-Expand(chain_master,
--       info = LP("fathom/chain/key/site/v1") || LP(deployment_id) || u32(epoch), 32)
--   org_chain_key_e  = HKDF-Expand(chain_master,
--       info = LP("fathom/chain/key/org/v1")  || LP(organisation_id) || u32(epoch), 32)
--   chain_key_epoch_e = HKDF-Expand(chain_master,      -- the per-design one, unchanged
--       info = LP("fathom/chain/key/v1") || LP(tenant_id) || LP(design_id) || u32(epoch), 32)
--
-- Those labels are owned by `docs/PHASE-2-STORAGE-DESIGN.md` §12.2 and land in
-- its table rather than existing only in code.
--
-- **The `read` label is NOT built here.** §7.2's per-design read chain
-- (`payload_decrypted`) carries an open volume question and §15.6 does not put
-- it in this stage. The label is reserved in §12.2's table; nothing writes it.
--
-- ---------------------------------------------------------------------------
-- THE SEAL INPUT CHANGED. READ THIS BEFORE ANYTHING ELSE IN THIS FILE.
-- ---------------------------------------------------------------------------
--
-- §11.2's seal ended `... || LP(entry_type) || LP(canon(metadata))`. It now
-- ends:
--
--   metadata_binding = MAC(K_content,
--       LP("fathom/chain/metadata/v1") || LP(canon(metadata)))
--
--   seal_n = MAC(K_seal, LP("fathom/chain/seal/v1")
--       || u32(chain_key_epoch) || u64(seq_n) || LP(chain_identity_1)
--       || LP(chain_identity_2) || LP(seal_{n-1}) || LP(content_hash_n)
--       || LP(entry_type) || LP(metadata_stored_n) || LP(metadata_binding_n))
--
-- where `metadata_stored` is THE BYTES IN THE COLUMN -- canonical plaintext on
-- a design or site chain, the AEAD blob on an organisation chain.
--
-- **This is the payload's own two-tier shape applied to metadata**: the seal
-- covers what is on disk, the keyed binding covers what it means. It is the
-- same reasoning §11.2 already uses for `storage_binding` and
-- `plaintext_binding`, and it is what makes encrypted metadata compatible with
-- §11.2's routine check -- links plus bindings, no decryption, runnable by an
-- operator holding only the chain key. A swapped or corrupted organisation
-- ciphertext breaks the SEAL, with no key but the chain key. Binding only the
-- plaintext would have left the ciphertext bound by nothing on the one run
-- §11.2 calls routine.
--
-- **EVERY SEAL WRITTEN BEFORE THIS MIGRATION IS INVALIDATED.** An entry
-- written by 0007 or 0008 reports BROKEN and that is correct: it was sealed
-- under a construction that no longer exists. This is acceptable exactly once,
-- because nothing has shipped and there is no production data, and it is
-- recorded here so that it is never done again after first release. The
-- backfill below puts 32 zero bytes in `metadata_binding` for those rows
-- rather than inventing a value; no key could produce the real one.
--
-- ---------------------------------------------------------------------------
-- WHICH CHAIN'S METADATA IS ENCRYPTED, AND WHICH IS NOT
-- ---------------------------------------------------------------------------
--
-- **Organisation chain: AEAD ciphertext.** §7.3, and the sharp case is the
-- vault: an organisation entry will carry recipient sets, mode changes and
-- which credential was shared for which device in which rack. In the clear
-- that is an access map for anyone holding a dump and no key -- §11.3 cost 3
-- exactly, *"a plaintext copy in the audit log is the leak returning through a
-- side door."*
--
-- **Site chain: AEAD ciphertext too, under a key derived from the chain
-- master.** §7.3: *"under a site metadata key derived from `chain_master`"*.
-- The site chain exists precisely where no organisation does, so there is no
-- tenant key to reach for:
--
--   site_metadata_key_e = HKDF-Expand(chain_master,
--       info = LP("fathom/chain/key/site-metadata/v1") || LP(deployment_id)
--              || u32(chain_key_epoch), 32)
--
-- Per epoch, so retired epochs stay readable -- an append-only row cannot be
-- re-encrypted, so the key that opens it must never stop existing. The entry
-- already carries `chain_key_epoch`, so decryption needs no extra column:
-- `metadata_key_epoch` stays NULL on a site row and the constraint below says
-- so.
--
-- **CONSEQUENCE, STATED RATHER THAN DISCOVERED: a routine verifier holding
-- `chain_master` CAN read site metadata.** That is acceptable because the site
-- chain holds no tenant data -- it records deployment-level acts. It is
-- deliberately NOT true of the organisation chain, whose content key that
-- verifier does not hold and cannot derive. Handing someone the ability to
-- verify a history must not hand them a tenant's access map; it may hand them
-- the fact that this deployment started at 03:14.
--
-- **Design chain: plaintext canonical bytes, unchanged from 0007.** The
-- metadata is an actor, an entry type, a version number and a schema version.
-- The design's contents are in `design_payload` and are encrypted there.
--
-- WHAT A DUMP WITH NO KEY STILL DISCLOSES, ON EVERY CHAIN INCLUDING THE
-- ORGANISATION ONE. This is a known disclosure, written down rather than
-- discovered: `seq`, `entry_type`, `chain_kind`, `chain_id`, the organisation
-- and design ids, every timestamp, `chain_key_epoch`, `metadata_key_epoch` and
-- the seal. So a dump reveals THAT an entry of a given type happened for a
-- given id at a given time. It does not reveal what the entry says.
--
-- ---------------------------------------------------------------------------
-- INVARIANT 11 -- AND IT BITES
-- ---------------------------------------------------------------------------
--
-- `.context/conventions.md` invariant 11: a migration that READS an existing
-- table must handle forced row-level security, because a migration runs with
-- no tenant context and a read behind `FORCE ROW LEVEL SECURITY` returns zero
-- rows SILENTLY. This migration backfills four columns over every row 0007
-- already wrote, and adds constraints PostgreSQL validates against the rows
-- already there. **On an empty database -- which is where migrations are
-- tested -- a missing `NO FORCE` is invisible**, and the first deployment with
-- history would get a backfill that reported success and copied nothing,
-- leaving `chain_kind` NULL and the `SET NOT NULL` below failing at exactly
-- the wrong moment. The `NO FORCE` / `FORCE` pair around section B is
-- LOAD-BEARING and must not be tidied away.
--
-- Note also that `chain_entries` has no `UPDATE` policy at all and never will,
-- so with `FORCE` in effect the backfill would reach zero rows even as the
-- table's owner.
--
-- ---------------------------------------------------------------------------
-- EXTENDING `entry_type` LATER -- THE PATH, SO NOBODY HAS TO GUESS IT
-- ---------------------------------------------------------------------------
--
-- `chain_entries_type_belongs_to_kind` pairs each entry type with the one
-- chain kind it may be filed on. The vault order will add
-- `vault_key_enrolled`, `vault_shared`, `vault_read`, `vault_mode_changed` and
-- others to the organisation branch, and §7.2 lists thirty more for the site
-- chain. **A later migration extends this by DROP CONSTRAINT then ADD
-- CONSTRAINT, wrapped in the invariant-11 `NO FORCE` / `FORCE` pair** -- the
-- `ADD` re-validates the existing rows, which is a read, and no row is
-- rewritten. A lookup table was considered and rejected: it would be a second
-- place for the type-to-kind pairing to drift from `EntryType::chain_kind()`
-- in `src/chain.rs`, and a `CHECK` is the half that binds a statement this
-- code never issued.

-- ---------------------------------------------------------------------------
-- A. THE DEPLOYMENT'S OWN IDENTITY
--
-- §7.1's site chain key is derived over a `deployment_id`, so there has to be
-- one. One row, stamped at first start, never changed and never removed: it is
-- the name the site chain is sealed under, so rewriting it would orphan every
-- site entry ever written, and deleting it would remove the site chain's only
-- anchor.
--
-- NO ROW-LEVEL SECURITY, deliberately, for the same reason `master_keys` has
-- none: this is not tenant data. It holds an opaque id and a timestamp. The
-- fences that matter for it are the grants below and the append-only trigger
-- in section D.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deployments (
    id         text        PRIMARY KEY CHECK (char_length(id) = 26),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one deployment identity per database. A second would make "which
-- deployment is this" ambiguous, which is the one question this table exists
-- to answer, and would silently fork the site chain in two.
CREATE UNIQUE INDEX IF NOT EXISTS deployments_one_row_idx
    ON deployments ((true));

-- ---------------------------------------------------------------------------
-- B. THE ORGANISATION CONTENT KEY
--
-- What encrypts organisation-chain metadata. **Deliberately none of the three
-- keys that already exist**, and each exclusion is a reason rather than a
-- preference:
--
--   * NOT the chain key. An operator running §11.2's routine verification
--     holds it. If it also opened organisation metadata, handing someone the
--     ability to verify a history would hand them the access map the
--     encryption exists to hide -- which is §6's B5 separation collapsing one
--     level down.
--   * NOT the tenant key directly. `keys::count_write_under_tenant_key` exists
--     because §12.3's birthday bound is per key and the tenant key already
--     seals a wrap every time a design key is minted. Adding an AEAD message
--     per audit entry to that same key is the thing that counter was written
--     to forbid.
--   * NOT a derived key. Chain entries are append-only, so a rotation cannot
--     re-encrypt them. A key that covers rows nobody may rewrite needs
--     EPOCHS, kept forever, with each row recording the epoch it was written
--     under -- which is a wrapped key with a table, not a derivation.
--
-- So: the same shape as `design_keys`, one level across instead of one level
-- down. A random data key, wrapped under the TENANT key, bound by
-- `LP(aad_bytes) || key` as the wrapped plaintext with the AEAD's associated
-- data channel empty -- §4's B1 fix, unchanged, at the one path
-- `crypto::unwrap_key`, which is what keeps `Misbound` a different word from
-- `Refused`.
--
-- **Wrapped under the tenant key is what makes re-wrap cover it for free**
-- (§12.6): a re-wrap changes the wrapping of the tenant key and nothing
-- beneath it moves at all. That is the two-level hierarchy §4 chose, paying
-- off for a table §4 had not imagined.
--
-- `ON DELETE RESTRICT` to `organisations`, not CASCADE: deleting an
-- organisation must not make its sealed audit metadata unreadable, and 0008's
-- finding was exactly that a referential action is not subject to row-level
-- security at any privilege level.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_content_keys (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    -- Monotonic per organisation, never overwritten. Retired epochs are kept
    -- forever, or every organisation entry written under them becomes
    -- unreadable -- and they cannot be re-encrypted, because the table they
    -- live in is append-only.
    key_epoch        int         NOT NULL CHECK (key_epoch >= 1),

    key_id           text        NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),

    wrapped_key      bytea       NOT NULL,
    wrap_nonce       bytea       NOT NULL CHECK (octet_length(wrap_nonce) = 12),
    tenant_key_epoch int         NOT NULL CHECK (tenant_key_epoch >= 1),
    wrap_version     int         NOT NULL CHECK (wrap_version >= 1),
    aead_alg_id      smallint    NOT NULL CHECK (aead_alg_id >= 1),

    status           text        NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'retired', 'compromised')),

    -- A DETECTOR, NEVER THE NONCE SOURCE (§12.3), exactly as on the two key
    -- tables 0007 created. Nothing in the write path consults this to build a
    -- nonce and nothing may be added that does.
    writes_under_key bigint      NOT NULL DEFAULT 0 CHECK (writes_under_key >= 0),

    created_at       timestamptz NOT NULL DEFAULT now(),
    retired_at       timestamptz,
    retired_reason   text,

    -- Re-wrap's columns, and only re-wrap's (§12.6). Re-wrap changes custody:
    -- it touches the wrapping and MUST NOT touch `key_epoch`.
    rewrapped_at     timestamptz,
    rewrapped_by     text        REFERENCES principals(id),

    PRIMARY KEY (organisation_id, key_epoch),
    FOREIGN KEY (organisation_id, tenant_key_epoch)
        REFERENCES tenant_keys (organisation_id, key_epoch),
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS org_content_keys_one_active_idx
    ON org_content_keys (organisation_id) WHERE status = 'active';

ALTER TABLE org_content_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_content_keys FORCE ROW LEVEL SECURITY;

-- EVERY POLICY NAMES ITS COMMAND. NONE IS `FOR ALL`. 0003's bug -- a `FOR ALL`
-- policy whose `USING` expression PostgreSQL silently reuses as the
-- `WITH CHECK` for every write -- is restated on every migration that writes a
-- policy, because it is the one that got through.
CREATE POLICY org_content_keys_readable ON org_content_keys
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY org_content_keys_insertable ON org_content_keys
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY org_content_keys_updatable ON org_content_keys
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
-- No DELETE policy, deliberately, exactly as on `tenant_keys`: a deleted key
-- row is every entry ever written under it, unreadable forever. Retirement is
-- a `status` change.

-- ---------------------------------------------------------------------------
-- C. `chain_entries` AT THREE LEVELS, WITH THE METADATA TIER
--
-- **Reused, not duplicated.** A second table would be a second integrity
-- mechanism by the back door: two verifiers, two append paths, two places for
-- §12.6a's ordering rules to drift apart. One table with an explicit
-- discriminator keeps `src/chain.rs` the only thing that decides what
-- verifies.
--
--   chain_kind = 'site'   -- one per deployment. organisation_id IS NULL,
--                            design_id IS NULL, chain_id = deployments.id.
--   chain_kind = 'org'    -- one per tenant. organisation_id NOT NULL,
--                            design_id IS NULL, chain_id = organisation_id.
--   chain_kind = 'design' -- 0007's, unchanged. chain_id = design_id.
--
-- `design_version` and both CONTENT bindings only mean something on a design
-- chain: a site or organisation entry records an act, not a payload. The
-- bindings are still present and still 32 bytes -- they carry
-- `MAC(K_content, LP("fathom/chain/nocontent/v1"))` on both sides, so
-- `content_hash` is computed by the same function over the same shape and the
-- seal input does not branch. That is the difference between reusing a
-- construction and forking it.
-- ---------------------------------------------------------------------------

ALTER TABLE chain_entries NO FORCE ROW LEVEL SECURITY;

ALTER TABLE chain_entries ADD COLUMN IF NOT EXISTS chain_kind text;
ALTER TABLE chain_entries ADD COLUMN IF NOT EXISTS chain_id   text;

-- The keyed binding over the metadata's MEANING. Clear, 32 bytes, in the seal
-- input -- see the header. On a design or site chain the plaintext is in
-- `metadata` beside it, so this is checkable with the chain key alone; on an
-- organisation chain it is what a deep run re-derives after decrypting.
ALTER TABLE chain_entries ADD COLUMN IF NOT EXISTS metadata_binding bytea;

-- What decryption needs. Same framing as `design_payload`: the ciphertext
-- (tag included) lives in the `metadata` column, the nonce lives beside it,
-- and the algorithm id is stored rather than assumed so §12.3's
-- XChaCha20-Poly1305 fallback is a column value and not a migration.
--
-- `metadata_key_epoch` is for the ORGANISATION chain only -- it names a row in
-- `org_content_keys`. A site entry's metadata key is derived from
-- `chain_master` at the entry's own `chain_key_epoch`, which is already on the
-- row, so this column stays NULL there rather than duplicating it.
ALTER TABLE chain_entries ADD COLUMN IF NOT EXISTS metadata_key_epoch   int;
ALTER TABLE chain_entries ADD COLUMN IF NOT EXISTS metadata_nonce       bytea;
ALTER TABLE chain_entries ADD COLUMN IF NOT EXISTS metadata_aead_alg_id smallint;

-- The backfill. Every row 0007 wrote is a design-chain row by construction --
-- it was the only kind that existed -- and its seal is invalidated by the new
-- seal input whatever is put here, so 32 zero bytes is the honest value: no
-- key could produce the real one. See the header. This is possible exactly
-- once, before first release.
UPDATE chain_entries
   SET chain_kind       = 'design',
       chain_id         = design_id,
       metadata_binding = '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea
 WHERE chain_kind IS NULL;

ALTER TABLE chain_entries ALTER COLUMN chain_kind       SET NOT NULL;
ALTER TABLE chain_entries ALTER COLUMN chain_id         SET NOT NULL;
ALTER TABLE chain_entries ALTER COLUMN metadata_binding SET NOT NULL;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_metadata_binding_len
    CHECK (octet_length(metadata_binding) = 32);

-- The primary key moves from (design_id, seq) to (chain_kind, chain_id, seq),
-- because a site chain has no design. Dropped BY WHAT IT IS rather than by the
-- name PostgreSQL happened to generate, which is 0008's rule and exists so
-- this file does not have to guess correctly on every deployment.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.contype = 'p' AND c.conrelid = 'chain_entries'::regclass
    LOOP
        EXECUTE format('ALTER TABLE chain_entries DROP CONSTRAINT %I', r.conname);
    END LOOP;
END
$$;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_pkey PRIMARY KEY (chain_kind, chain_id, seq);

-- Now the three columns only a design chain fills may be NULL. The composite
-- foreign key 0008 named `chain_entries_design_fkey` is MATCH SIMPLE, so it is
-- simply not enforced for a row whose `design_id` is NULL -- and still binds,
-- with `ON DELETE RESTRICT`, for every row where it is not.
ALTER TABLE chain_entries ALTER COLUMN design_id       DROP NOT NULL;
ALTER TABLE chain_entries ALTER COLUMN organisation_id DROP NOT NULL;
ALTER TABLE chain_entries ALTER COLUMN design_version  DROP NOT NULL;

-- 0007 wrote `CHECK (entry_type IN ('create','update','reencrypt'))` inline
-- and unnamed. Replaced, not loosened: the new constraint pairs each entry
-- type with the ONE chain kind it may appear on, so a `create` cannot be filed
-- on the site chain and a `rewrap` cannot be filed on a design's.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.contype = 'c'
          AND c.conrelid = 'chain_entries'::regclass
          AND pg_get_constraintdef(c.oid) LIKE '%entry_type%'
    LOOP
        EXECUTE format('ALTER TABLE chain_entries DROP CONSTRAINT %I', r.conname);
    END LOOP;
END
$$;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_kind_is_known
    CHECK (chain_kind IN ('site', 'org', 'design'));

-- Which columns each kind carries, as a schema fact rather than as a rule in
-- application code. `chain_id` is pinned to the column it duplicates for the
-- two kinds that have one, so the discriminator can never disagree with the
-- foreign keys underneath it.
ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_shape_matches_kind
    CHECK (
        (chain_kind = 'site'
             AND organisation_id IS NULL
             AND design_id IS NULL
             AND design_version IS NULL)
     OR (chain_kind = 'org'
             AND organisation_id IS NOT NULL
             AND design_id IS NULL
             AND design_version IS NULL
             AND chain_id = organisation_id)
     OR (chain_kind = 'design'
             AND organisation_id IS NOT NULL
             AND design_id IS NOT NULL
             AND design_version IS NOT NULL
             AND chain_id = design_id)
    );

-- See the header. The site and organisation chains store AEAD ciphertext in
-- `metadata` and carry what opens it; the design chain stores canonical
-- plaintext and carries none of it. The two encrypted kinds differ in one
-- column and only one: an organisation entry names a row in
-- `org_content_keys`, a site entry's key is derived from `chain_master` at the
-- `chain_key_epoch` already on the row.
--
-- Stated as a constraint so that "is this column ciphertext, and what opens
-- it" is answerable from the row rather than from a convention somebody has to
-- remember.
ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_metadata_framing_matches_kind
    CHECK (
        (chain_kind = 'design'
             AND metadata_key_epoch IS NULL
             AND metadata_nonce IS NULL
             AND metadata_aead_alg_id IS NULL)
     OR (chain_kind = 'site'
             AND metadata_key_epoch IS NULL
             AND metadata_nonce IS NOT NULL
             AND octet_length(metadata_nonce) = 12
             AND metadata_aead_alg_id IS NOT NULL)
     OR (chain_kind = 'org'
             AND metadata_key_epoch IS NOT NULL
             AND metadata_nonce IS NOT NULL
             AND octet_length(metadata_nonce) = 12
             AND metadata_aead_alg_id IS NOT NULL)
    );

-- INVARIANT 11, AND IT BIT HERE. `ADD CONSTRAINT` on a foreign key validates
-- the existing rows, and that validation READS THE REFERENCED TABLE. Both
-- `organisations` and `org_content_keys` are behind `FORCE ROW LEVEL
-- SECURITY`, so with no tenant context the scan sees ZERO ROWS -- even as the
-- table's owner -- and PostgreSQL reports
--
--   ERROR: insert or update on table "chain_entries" violates foreign key
--          constraint "chain_entries_organisation_fkey"
--   DETAIL: Key (organisation_id)=(...) is not present in table "organisations".
--
-- for a key that is plainly present. **On an empty database this is
-- invisible**, because there is nothing to validate -- so it would have passed
-- every test here and failed on the first deployment that had a single chain
-- entry. Reproduced against a database seeded to 0008 with one row, which is
-- the only way to see it.
--
-- `0008` wrapped both sides of its constraints for exactly this reason. These
-- pairs are LOAD-BEARING and must not be tidied away.
ALTER TABLE organisations    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE org_content_keys NO FORCE ROW LEVEL SECURITY;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_metadata_key_fkey
    FOREIGN KEY (organisation_id, metadata_key_epoch)
    REFERENCES org_content_keys (organisation_id, key_epoch);

-- §11.1's claim, applied to the two new levels: a sealed history that a
-- `DELETE` on some parent erases is not tamper-evident. 0008 closed that for
-- designs with `ON DELETE RESTRICT`; an organisation chain needs the same, and
-- it needs it as a REFERENTIAL constraint rather than a policy, because
-- referential integrity is the one rule in this database a superuser does not
-- bypass and a cascade is not subject to row-level security at all.
--
-- `chain_entries.organisation_id` carried no direct reference before this:
-- 0007 bound it only through the composite key onto `designs`, which is not
-- enforced at all for a row whose `design_id` is NULL. So an organisation
-- chain would have had no parent fence whatsoever.
--
-- The site chain has no parent to cascade from -- both id columns are NULL --
-- and its anchor row in `deployments` is protected by the trigger in section D.
ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_organisation_fkey
    FOREIGN KEY (organisation_id) REFERENCES organisations (id)
    ON DELETE RESTRICT;

ALTER TABLE org_content_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE organisations    FORCE ROW LEVEL SECURITY;
ALTER TABLE chain_entries    FORCE ROW LEVEL SECURITY;

-- The tip lookup and the verifier both read one chain in `seq` order, which
-- the new primary key already serves. 0007's design/version index stays: it
-- answers `last_entry_for_version`, which the new key does not.

-- ---------------------------------------------------------------------------
-- Row-level security, rewritten for three kinds.
--
-- **The site branch lets any transaction read and append site entries,
-- including one with no tenant context.** That is deliberate and stated rather
-- than hidden: a site entry is written at startup, before any tenant exists,
-- and the site chain is deployment-wide by definition, so a policy keyed on
-- `app.tenant_id` would refuse every site append. What stops a forged site
-- entry is not this policy -- it is the seal, whose key lives in a file
-- PostgreSQL cannot read (ADR-0043 §1). A tier-2 attacker who inserts a row
-- here produces a chain that reports BROKEN AT ENTRY N, which is the failure
-- mode this whole construction is for.
--
-- STILL NO `UPDATE` AND NO `DELETE` POLICY, for any kind. With row security
-- forced and no policy for a command, that command reaches no rows at all. The
-- trigger in section D is what makes that true for the table's owner and for a
-- superuser as well.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS chain_entries_readable   ON chain_entries;
DROP POLICY IF EXISTS chain_entries_insertable ON chain_entries;

CREATE POLICY chain_entries_readable ON chain_entries
    FOR SELECT USING (
        (chain_kind = 'site' AND organisation_id IS NULL)
        OR organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY chain_entries_insertable ON chain_entries
    FOR INSERT WITH CHECK (
        (chain_kind = 'site' AND organisation_id IS NULL)
        OR organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- D. THE APPEND-ONLY FENCE, ENFORCED BY A TRIGGER RATHER THAN BY A POLICY
--
-- §7.7. A policy is evaluated for the role that issued the statement and is
-- not evaluated at all for a superuser; a `BEFORE ... FOR EACH ROW` trigger
-- fires whoever is connected, so this binds the bootstrap superuser too.
-- `tests/append_only_fence.rs` proves that the way `tests/principals_fence.rs`
-- proves the composite key -- by connecting as that role and failing.
--
-- **`TRUNCATE` gets its own statement-level trigger and that is not
-- belt-and-braces.** `TRUNCATE` fires no row-level trigger at all, so a
-- `BEFORE UPDATE OR DELETE ... FOR EACH ROW` trigger alone would leave one
-- statement that erases the entire history of every tenant at once -- which is
-- precisely the act this fence exists to refuse.
--
-- WHAT THIS DOES NOT CLAIM, written down so nobody reads it as more. The
-- trigger is disabled by `ALTER TABLE ... DISABLE TRIGGER USER`, which needs
-- ownership. §7.7's answer is to move these tables to a `fathom_audit` role
-- with no password and no login, so that disabling the trigger is a tier-3
-- move rather than a tier-2 one. **That is NOT built here** -- it is an
-- ownership change across every existing grant and it belongs with the admin
-- surface. What is true today: the fence binds the runtime role, the operator
-- role and a superuser's ordinary statements; it does not bind someone who
-- alters the table first, and the seal plus a schema fingerprint is what
-- catches that afterwards.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fathom_audit_is_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION
        'chain entries are append-only: % on % is refused at every privilege level',
        TG_OP, TG_TABLE_NAME;
END
$fn$;

DROP TRIGGER IF EXISTS chain_entries_append_only ON chain_entries;
CREATE TRIGGER chain_entries_append_only
    BEFORE UPDATE OR DELETE ON chain_entries
    FOR EACH ROW EXECUTE FUNCTION fathom_audit_is_append_only();

DROP TRIGGER IF EXISTS chain_entries_no_truncate ON chain_entries;
CREATE TRIGGER chain_entries_no_truncate
    BEFORE TRUNCATE ON chain_entries
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_audit_is_append_only();

-- The site chain's anchor gets the same treatment. Without it, the deployment
-- id could be deleted and re-stamped, which forks the site chain under a new
-- name and leaves the old entries unreachable by any verifier that starts from
-- the current identity.
DROP TRIGGER IF EXISTS deployments_append_only ON deployments;
CREATE TRIGGER deployments_append_only
    BEFORE UPDATE OR DELETE ON deployments
    FOR EACH ROW EXECUTE FUNCTION fathom_audit_is_append_only();

DROP TRIGGER IF EXISTS deployments_no_truncate ON deployments;
CREATE TRIGGER deployments_no_truncate
    BEFORE TRUNCATE ON deployments
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_audit_is_append_only();

-- §7.7's `REVOKE` as well as the trigger. 0006's default privileges hand every
-- new table all four verbs; two of them are not earned here by any code path,
-- and a privilege withheld is checked BEFORE row security and before a trigger
-- ever runs.
REVOKE UPDATE, DELETE ON chain_entries FROM fathom_app;
REVOKE UPDATE, DELETE ON deployments   FROM fathom_app;

-- ---------------------------------------------------------------------------
-- E. RETIRING A MASTER KEY IS AN UPDATE, AND RE-WRAP IS WHAT NEEDED IT
--
-- 0008 revoked UPDATE and DELETE on `master_keys` from the runtime role and
-- said why: *"Retiring a key (status, retired_at) is an UPDATE. Nothing
-- implements retirement yet; when it does it is an administrative path, not a
-- request path, and it gets its privilege in the same diff."* This is that
-- diff. §12.6's re-wrap moves custody to a new master key, and the old one
-- must be marked retired rather than removed -- OWASP, quoted in ADR-0043 §4:
-- old keys are kept so that old backups can still be decrypted.
--
-- **A COLUMN-LEVEL GRANT, NOT A TABLE-LEVEL ONE.** `key_id` stays
-- un-rewritable, which is what preserves ADR-0043 §4's control: the stamped id
-- is how a restore beside the wrong key file reports two ids instead of
-- failing like corruption, and a role that could rewrite it could turn that
-- check off silently. DELETE is still revoked entirely -- a deleted row is
-- every backup written under that key becoming indistinguishable from
-- corruption.
-- ---------------------------------------------------------------------------
GRANT UPDATE (status, retired_at, retired_reason) ON master_keys TO fathom_app;

-- ---------------------------------------------------------------------------
-- F. THE OPERATOR PLANE READS THE CHAINS, AND WRITES NOTHING
--
-- §1.3 keeps the operator sightless with respect to design DATA. A chain entry
-- is not design data: it is MAC tags, a sequence number, an entry type, and
-- metadata that on the organisation chain is ciphertext the operator holds no
-- key for. §11.2 keys `content_hash` precisely so that holding one is not a
-- confirmation oracle against a guessed payload. An operator who cannot read
-- the audit trail cannot do the job the audit trail exists for.
--
-- `FOR SELECT`, NEVER `FOR ALL` -- §11.1, and `tests/planes.rs` checks it off
-- `pg_policies` for every operator-plane policy on every run. A `FOR ALL`
-- policy's `USING` clause is reused by PostgreSQL as the `WITH CHECK` for
-- every write, which is 0003's defect with a new name.
--
-- Nothing else is granted: not `deployments`, not `audit_spool`, not
-- `org_content_keys`, and no verb but `SELECT` on this one.
-- ---------------------------------------------------------------------------
GRANT SELECT ON chain_entries TO fathom_operator;

CREATE POLICY chain_entries_readable_by_operator_plane ON chain_entries
    FOR SELECT TO fathom_operator USING (true);

-- ---------------------------------------------------------------------------
-- G. `audit_spool` -- GETTING IT OFF THE BOX, FIRST CUT (§9)
--
-- **In PostgreSQL, not on container disk**, and §9 gives the reason in full:
-- both containers share it, neither writes a local file (REBUILD-PLAN item 1),
-- and entries do not die with a replaced container -- which is the failure
-- mode that leaves the far end a permanent unexplained gap while the
-- deployment's own tip is AHEAD, so nothing ever fires for the one case that
-- actually lost evidence.
--
-- **The row is written in the SAME TRANSACTION as the chain entry it is
-- about.** That is what makes "stopping the log stops the act" mechanical
-- rather than aspirational: an act that cannot queue its audit line does not
-- commit. And it is what lets the shipper be a background task that can never
-- block a write -- the write path does one INSERT and touches no socket.
--
-- WHAT IS IN A ROW, AND WHAT IS NOT. §7.3: entry metadata is the place a
-- plaintext copy would return through a side door, so it is NOT here -- not
-- the organisation chain's ciphertext either, which would be a second copy of
-- a thing already stored once. A spool row carries exactly what §7.3 lists as
-- in the clear: `seq`, `entry_type`, ids, timestamps, `chain_key_epoch` and
-- the seal. That is what a far end needs to notice a gap, a burst or a
-- divergence, and nothing more.
--
-- NO ROW-LEVEL SECURITY, DELIBERATELY, AND THIS ONE IS A DECISION RATHER THAN
-- AN OMISSION. The shipper is deployment-wide by construction and runs with no
-- tenant context; a policy keyed on `app.tenant_id` would hide every row from
-- it and the deployment would silently stop shipping while reporting itself
-- healthy -- the exact shape of failure §9 exists to prevent. The fence is the
-- grant: `fathom_operator` holds nothing on this table, and it holds no
-- ciphertext, no key and no metadata to hold.
--
-- DELETED ON SUCCESSFUL SHIP, and the record is the chain rather than this
-- queue. Keeping shipped rows forever would make "the spool drains" false and
-- would put a second, unbounded copy of the audit trail beside the first.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_spool (
    -- The shipping order, and the only thing that defines it. Distinct from
    -- the chain's own `seq`, which is per chain: three chains interleave here.
    spool_seq       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    chain_kind      text        NOT NULL CHECK (chain_kind IN ('site', 'org', 'design')),
    chain_id        text        NOT NULL,
    seq             bigint      NOT NULL CHECK (seq >= 1),
    entry_type      text        NOT NULL,
    chain_key_epoch int         NOT NULL CHECK (chain_key_epoch >= 1),

    -- The seal itself, so the far end holds the thing it would later be asked
    -- to attest to. Not a key and not derived from one: it is a MAC tag.
    seal            bytea       NOT NULL CHECK (octet_length(seal) = 32),

    -- When the act happened, not when the shipper got to it. A far end that
    -- alarms on cadence needs the first; a diagnostic needs the second.
    occurred_at     timestamptz NOT NULL,
    queued_at       timestamptz NOT NULL DEFAULT now(),

    attempts        int         NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error      text,

    -- One spool row per entry. A retry that re-queued would ship the same
    -- entry twice and a far end counting entries would see a burst.
    UNIQUE (chain_kind, chain_id, seq)
);

-- The drain reads in `spool_seq` order; the primary key already serves that.
-- This one answers "how far behind is the oldest unshipped entry", which is
-- what §9's time bound is measured against.
CREATE INDEX IF NOT EXISTS audit_spool_queued_at_idx ON audit_spool (queued_at);

-- ---------------------------------------------------------------------------
-- WHAT IS DEFERRED, WRITTEN HERE RATHER THAN HALF-BUILT (§15.6)
--
-- §15.6's order is `chains` early, then the admin surface and the interlock,
-- THEN receipts and witness. So, absent from this migration and absent on
-- purpose:
--
--   * `chain_receipts` (§7.4) -- a tip digest counts as anchored only when a
--     receipt comes back signed by a key the server never holds. Until that
--     exists, a shipper target is a folder and not a witness, and no
--     documentation may call it an anchor.
--   * `chain_anchors` and startup quarantine (§7.6).
--   * `heartbeat` on a cadence (§7.5). A gap is an incident AT THE WITNESS;
--     with no witness a heartbeat stream proves nothing and costs rows.
--   * The per-design read chain (§7.2's `payload_decrypted`).
--   * `sealed_seq` on administrative changes (§5.4's execution interlock).
--     `chain_entries` is the table it will name, and it is not named yet
--     because the administrative surface it gates does not exist.
--
-- Each of those is a real control. None of them is improved by a stub.
-- ---------------------------------------------------------------------------
