-- 0017 -- firmware staging: Fathom holds an image, proves it is whole, and
-- serves it once to a device that comes and fetches it.
--
-- `docs/decisions/adr-0045-firmware-moves-by-the-device-pulling-not-fathom-pushing.md`
-- §4 (the decision), §6 (the traps), §8 (the consequence this file is);
-- `docs/UPGRADING-A-JUNIPER.md` traps 2 and 4; `.context/conventions.md`
-- invariant 11 (the `NO FORCE` / `FORCE` pair in section E).
--
-- **0013, 0014, 0015 and 0016 are not edited and must never be.** They have
-- shipped and are under the checksum gate in `src/migrate.rs`.
--
-- ---------------------------------------------------------------------------
-- THE LINE THIS FILE DOES NOT CROSS
-- ---------------------------------------------------------------------------
--
-- ADR-0045 §4: **Fathom holds no device credential**, opens no connection to a
-- device, runs no upgrade, and changes no device's configuration. Nothing below
-- stores a password, a private key, a host key or an address for any network
-- device. There is no column here a device credential could arrive in, which is
-- the same shape CLAUDE.md rule 4 gives every other surface: the credential is
-- protected by never arriving.
--
-- What IS here is a file on Fathom's own disk, its length, the SHA-256 Fathom
-- computed over the bytes it holds, and the hash of a one-time token a switch
-- presents to collect it.
--
-- ---------------------------------------------------------------------------
-- A. WHY THE IMAGE IS NOT IN POSTGRESQL
--
-- A Junos image is one to two gigabytes. A `bytea` column is read and written
-- whole through the protocol, and `TOAST` would slice every image into two
-- kilobyte chunks in a table every backup then carries. The bytes go to a
-- directory the deployment mounts, and this table is the record ABOUT them.
--
-- The consequence is stated rather than hidden: **a row here and a file on disk
-- can disagree**, because they are not in one transaction. The states below are
-- written so that every disagreement is safe in one direction:
--
--   * `declared` -- a row exists, a file may or may not; nothing serves.
--   * `staged`   -- the file was written whole, its hash was computed over the
--                   bytes on disk, and it matched what was declared.
--   * `failed`   -- the upload did not produce the declared bytes. The file is
--                   deleted before this state is written; the row stays as the
--                   record that somebody tried.
--
-- Only `staged` serves, so a missing file is a refusal and never a short read
-- presented as an image.
--
-- ---------------------------------------------------------------------------
-- B. THE ON-DISK NAME IS NOT IN THIS TABLE, AND THAT IS THE POINT
--
-- There is no `path`, no `storage_name` and no `directory` column. The file's
-- name is DERIVED from `id`, which is a ULID and is constrained below to
-- Crockford base32 -- twenty-six characters from `0123456789ABCDEFGHJKMNP-TV-Z`
-- and nothing else. So there is no column in this schema whose contents become
-- a filesystem path, and a `..` or a `/` cannot be stored in one to begin with.
--
-- `filename` is the operator's own label for the image. It is metadata: it is
-- rendered back to an operator and it is never joined to a directory.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS firmware_images (
    -- Crockford base32, which is what `fathom_id::Ulid` encodes to: the digits
    -- and the capital letters minus I, L, O and U. **This CHECK is half of
    -- section B's control** -- the other half is `firmware::storage_name`,
    -- which re-validates the same alphabet before it touches the filesystem.
    id               text        PRIMARY KEY
                                 CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    -- Which part of the estate this image is staged for. `RESTRICT`, as
    -- `designs.scope_id` is: deleting a rack must not silently delete the
    -- record of what was staged under it.
    scope_id         text        NOT NULL REFERENCES scopes(id) ON DELETE RESTRICT,

    -- The operator's own name for the file. Metadata only -- section B.
    filename         text        NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),

    -- What the declaration said. Both are the CLAIM, never the answer:
    -- `computed_sha256` below is the only hash this server reports.
    byte_length      bigint      NOT NULL CHECK (byte_length > 0),
    declared_sha256  bytea       NOT NULL CHECK (octet_length(declared_sha256) = 32),

    -- **Computed over the bytes on disk, as they were written.** NULL until
    -- the upload completed and matched. `src/firmware.rs` never copies
    -- `declared_sha256` into this column; the CHECK below cannot express that,
    -- so `tests/firmware.rs` proves it with a declaration that lies.
    computed_sha256  bytea       CHECK (octet_length(computed_sha256) = 32),

    state            text        NOT NULL
                                 CHECK (state IN ('declared', 'staged', 'failed')),
    failed_reason    text        CHECK (failed_reason IN ('hash_mismatch',
                                                          'length_mismatch',
                                                          'write_failed')),

    created_by       text        NOT NULL REFERENCES accounts(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    staged_at        timestamptz,
    -- The organisation-chain entry that recorded the staging. A row whose entry
    -- does not verify is an image nobody should serve, which is `0015` §F's
    -- interlock applied to this table.
    staged_seq       bigint      CHECK (staged_seq >= 1),

    -- For the composite foreign keys below: `0004`'s fence in a third place. A
    -- token cannot name a tenant other than its image's, because the reference
    -- would not resolve -- and referential integrity binds at every privilege
    -- level, which row-level security does not.
    UNIQUE (id, organisation_id),

    CHECK ((state = 'staged') = (computed_sha256 IS NOT NULL)),
    CHECK ((state = 'staged') = (staged_at IS NOT NULL)),
    CHECK ((state = 'staged') = (staged_seq IS NOT NULL)),
    CHECK ((state = 'failed') = (failed_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS firmware_images_org_scope_idx
    ON firmware_images (organisation_id, scope_id);

-- ---------------------------------------------------------------------------
-- C. TWO TOKENS, AND WHY THEY ARE TWO TABLES
--
-- **The upload token** exists because a signed request covers a digest of its
-- body, and computing that digest over a two-gigabyte image means buffering a
-- two-gigabyte image before the signature that would have refused it is even
-- checked. So the declaration is signed and small, and it hands back a
-- single-use token that the bytes travel under. What that token can do is
-- exactly one thing: fill in an image its own organisation already declared,
-- at the length and hash that declaration named.
--
-- **The fetch token is the credential**, and it is the only one in this
-- schema. A switch cannot sign a request, so the URL it is given IS the
-- authorisation: long, random, single-use, short-lived and bound to one image.
-- The row carries `H(LP(tag) || LP(token))` and never the token, exactly as
-- `enrolment_tokens` and `sessions.token_hash` do -- a database read hands an
-- attacker a hash, and a hash cannot be fetched with.
--
-- **Single use is a guarded UPDATE inside one statement, not a flag two
-- statements apart.** `UPDATE ... WHERE redeemed_at IS NULL AND expires_at >
-- now() RETURNING` locks the row for the first caller and returns nothing to
-- the second, which is the same atomicity `session_nonces` gets from `DELETE
-- ... RETURNING`. It is an UPDATE rather than a DELETE because a deleted
-- fetch token is bytes that left this server with nothing left to say so.
--
-- **No row seal here, and it is named rather than implied.** `enrolment_tokens`
-- seals its row so that clearing `redeemed_at` in PostgreSQL leaves a row that
-- does not verify. These two are not sealed, so a tier-2 attacker holding
-- `psql` and the UPDATE privilege could re-open a spent fetch token. What they
-- gain is one more copy of a public vendor image; what they cannot do is hide
-- it, because `firmware_fetch_redeemed` is already on the organisation's chain
-- under a key that is not in this database, and the second redemption appends
-- another. That is the trade, stated: the seal is on the AUDIT, not on the
-- token.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS firmware_upload_tokens (
    -- One outstanding upload token per image: the declaration mints it and
    -- nothing re-mints it. A second declaration is a second image.
    image_id        text        PRIMARY KEY,
    organisation_id text        NOT NULL,

    token_hash      bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),

    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    redeemed_at     timestamptz,

    CHECK (expires_at > issued_at),

    FOREIGN KEY (image_id, organisation_id)
        REFERENCES firmware_images (id, organisation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS firmware_fetch_tokens (
    id              text        PRIMARY KEY
                                CHECK (id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    image_id        text        NOT NULL,
    organisation_id text        NOT NULL,

    token_hash      bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),

    issued_by       text        NOT NULL REFERENCES accounts(id),
    -- The organisation-chain entry that recorded the issue. ADR-0045 §8: this
    -- is Fathom's first outward-facing artefact, so issuing one is an act with
    -- a sealed record, not a read.
    issued_seq      bigint      NOT NULL CHECK (issued_seq >= 1),
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,

    redeemed_at     timestamptz,
    redeemed_seq    bigint      CHECK (redeemed_seq >= 1),
    -- Where the bytes went, as far as this server can tell: the peer address,
    -- or whatever the configured trusted forwarding header carried. Kept
    -- because "the bytes went somewhere" is the claim the redemption entry
    -- makes and an address is the only part of it this server observes.
    redeemed_from   text        CHECK (char_length(redeemed_from) <= 255),

    CHECK (expires_at > issued_at),
    -- **One-directional, and the direction is the point.** A `redeemed_seq`
    -- with no `redeemed_at` would be an entry about a redemption that never
    -- happened, and is refused. The reverse is a real, momentary state INSIDE
    -- one transaction: the token is spent first (which is what names the
    -- tenant, which is what makes the chain key reachable at all), the entry
    -- is appended second, and the seq is written third. A biconditional here
    -- would refuse the only order this act can be performed in, and a
    -- DEFERRABLE CHECK does not exist in PostgreSQL. Nothing observes the
    -- intermediate state: all three statements are in one transaction, so a
    -- reader sees both columns set or neither.
    CHECK (redeemed_seq IS NULL OR redeemed_at IS NOT NULL),

    FOREIGN KEY (image_id, organisation_id)
        REFERENCES firmware_images (id, organisation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS firmware_fetch_tokens_image_idx
    ON firmware_fetch_tokens (organisation_id, image_id);
CREATE INDEX IF NOT EXISTS firmware_fetch_tokens_expiry_idx
    ON firmware_fetch_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- D. TENANT ISOLATION, AND THE ONE UNAUTHENTICATED DOOR
--
-- Two of these tables are ordinary tenant tables and are behind
-- `organisation_id = app.tenant_id`, exactly as `designs` is.
--
-- `firmware_fetch_tokens` has one caller that holds no session at all: the
-- switch. It presents a token and nothing else, so there is no tenant to set
-- BEFORE the row is read -- the row is what names the tenant. That is
-- `app.enrolment_custody`'s shape (`0015` §H) and it gets its own capability
-- for the same reason: an unauthenticated caller must reach exactly one table
-- and no more.
--
--   `app.firmware_fetch_custody` = 'yes' reaches `firmware_fetch_tokens`, and
--   NOTHING else in this schema names that setting.
--
-- What happens next is the part that matters: `src/firmware.rs` reads the
-- token row, takes `organisation_id` OFF THAT ROW, and only then sets
-- `app.tenant_id` from it (`repo::set_custody_tenant`). The tenant is never
-- taken from the caller. A fetch token from another organisation therefore
-- reads that organisation's image -- which is correct, because the token is
-- that organisation's own act -- and a caller who guesses a token id learns
-- nothing, because the lookup is by the hash of a 256-bit token and not by id.
--
-- EVERY POLICY NAMES ITS COMMAND. None is `FOR ALL` -- `0003`'s defect.
-- ---------------------------------------------------------------------------

ALTER TABLE firmware_images        ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmware_images        FORCE  ROW LEVEL SECURITY;
ALTER TABLE firmware_upload_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmware_upload_tokens FORCE  ROW LEVEL SECURITY;
ALTER TABLE firmware_fetch_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE firmware_fetch_tokens  FORCE  ROW LEVEL SECURITY;

CREATE POLICY firmware_images_readable ON firmware_images
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY firmware_images_insertable ON firmware_images
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY firmware_images_updatable ON firmware_images
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- The upload has a token and no session either, for the reason in section C:
-- a signature covers a digest of the body, and this body is two gigabytes. So
-- it gets a capability of ITS OWN rather than sharing the fetch one -- two
-- unauthenticated doors that each reach one table are two doors; one
-- capability opening both would be a door into either from whichever token
-- leaked.
CREATE POLICY firmware_upload_tokens_readable ON firmware_upload_tokens
    FOR SELECT USING (
        current_setting('app.firmware_upload_custody', true) = 'yes'
        OR organisation_id = current_setting('app.tenant_id', true));
-- Minting one is the steward's declaration, inside a tenant. The upload
-- capability does not appear here: a caller holding a token can spend one and
-- can mint none.
CREATE POLICY firmware_upload_tokens_insertable ON firmware_upload_tokens
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY firmware_upload_tokens_updatable ON firmware_upload_tokens
    FOR UPDATE USING (
        current_setting('app.firmware_upload_custody', true) = 'yes'
        OR organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (
        current_setting('app.firmware_upload_custody', true) = 'yes'
        OR organisation_id = current_setting('app.tenant_id', true));

-- The device's door, and the steward's, on one table. The steward's half is
-- the ordinary tenant predicate; the device's half is the capability, which is
-- set by exactly one function in the server.
CREATE POLICY firmware_fetch_tokens_readable ON firmware_fetch_tokens
    FOR SELECT USING (
        current_setting('app.firmware_fetch_custody', true) = 'yes'
        OR organisation_id = current_setting('app.tenant_id', true));
-- Issuing is a steward act inside a tenant. **The fetch capability does not
-- appear here**: a caller holding only a token can spend one and can mint none.
CREATE POLICY firmware_fetch_tokens_insertable ON firmware_fetch_tokens
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY firmware_fetch_tokens_updatable ON firmware_fetch_tokens
    FOR UPDATE USING (
        current_setting('app.firmware_fetch_custody', true) = 'yes'
        OR organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (
        current_setting('app.firmware_fetch_custody', true) = 'yes'
        OR organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- PRIVILEGES -- narrowed at the layer that is checked before any policy
-- expression anyone could get wrong.
--
-- `0006`'s default privileges hand `fathom_app` all four verbs on every table
-- the migration role creates. Three of those are not earned here.
--
-- **`fathom_operator` is granted nothing on any table in this file**, and no
-- default privilege gives it any (`0005`). §1.3 keeps the operator plane out
-- of tenant data, and a staged image is tenant data: which releases an estate
-- is moving to is exactly the kind of fact §1.3 keeps on the tenant's side of
-- the line. `tests/planes.rs` asserts the operator plane's readable set off the
-- live database on every run, so a grant added here fails that test.
-- ---------------------------------------------------------------------------

-- Nothing deletes an image row. A deleted row is a file on disk nobody can
-- account for, and the state machine in section A is what retires one.
REVOKE UPDATE, DELETE ON firmware_images FROM fathom_app;
GRANT UPDATE (computed_sha256, state, staged_at, staged_seq, failed_reason)
    ON firmware_images TO fathom_app;

-- A token is issued once and then spent. Nothing else about it may change.
REVOKE UPDATE, DELETE ON firmware_upload_tokens FROM fathom_app;
GRANT UPDATE (redeemed_at) ON firmware_upload_tokens TO fathom_app;

REVOKE UPDATE, DELETE ON firmware_fetch_tokens FROM fathom_app;
GRANT UPDATE (redeemed_at, redeemed_seq, redeemed_from)
    ON firmware_fetch_tokens TO fathom_app;

-- ---------------------------------------------------------------------------
-- E. THE THREE ENTRY TYPES THIS FILE'S ACTS WRITE (§7.2's shape)
--
-- Extended by `DROP CONSTRAINT` then `ADD CONSTRAINT`, wrapped in the
-- invariant-11 `NO FORCE` / `FORCE` pair -- the path `0010` §C documents and
-- `0011` §K, `0013` §G, `0014` §E and `0015` §J follow. `ADD CONSTRAINT ...
-- CHECK` re-validates every row already in `chain_entries`, and that
-- validating scan is a read of a table behind `FORCE ROW LEVEL SECURITY`,
-- which with no tenant context returns zero rows SILENTLY. **On an empty
-- database the difference is invisible.** The pair is LOAD-BEARING and must
-- not be tidied away.
--
-- All three are ORGANISATION-chain types. None of them is in §7.2's list,
-- because §7.2 was written before ADR-0045 existed; that gap is reported to the
-- lead rather than quietly filled, exactly as `0013` §G and `0015` §J reported
-- theirs.
--
--   * `firmware_staged`          -- an image arrived whole and its hash matched
--                                   what was declared. The entry names the
--                                   image, its length and the hash Fathom
--                                   computed.
--   * `firmware_fetch_issued`    -- a one-time URL was minted. ADR-0045 §8: this
--                                   publishes bytes to anything that can reach
--                                   this server with the token, so it is an act
--                                   and it is sealed. **The entry carries the
--                                   token's id and never the token.**
--   * `firmware_fetch_redeemed`  -- the bytes went somewhere. Written BEFORE the
--                                   body is served and committed with the
--                                   redemption, so a transfer that dies half
--                                   way still leaves the record that it started.
--
-- A failed upload writes no entry: nothing was staged, and an entry type that
-- fires on every truncated transfer would let an unauthenticated caller choose
-- how fast the sealed audit grows -- the argument `0015` §J makes for sampling
-- `operator_read`.
--
-- Mirrored by `EntryType::kinds()` in `src/chain.rs`.
-- ---------------------------------------------------------------------------
ALTER TABLE chain_entries NO FORCE ROW LEVEL SECURITY;

ALTER TABLE chain_entries
    DROP CONSTRAINT IF EXISTS chain_entries_type_belongs_to_kind;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_type_belongs_to_kind
    CHECK (
        (chain_kind = 'design'
             AND entry_type IN ('create', 'update', 'reencrypt'))
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
                                'grant_suspended'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced',
                                -- ADR-0045, this file's section E.
                                'firmware_staged', 'firmware_fetch_issued',
                                'firmware_fetch_redeemed'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
