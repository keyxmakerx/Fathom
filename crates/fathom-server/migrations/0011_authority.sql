-- 0011 -- authority: the organisation root key, the account keyring, scope
-- grants and their secondings, suspensions and revocations, and the sealed
-- head that says which of them are live.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §§2, 3.2, 3.3, 3.4, 3.5, 6.1, 7.2
-- and §15 (§15.0's naming and privilege calls, §15.1's software keys, §15.3's
-- ES256, §15.6 item 3); `docs/PHASE-2-STORAGE-DESIGN.md` §§11.2, 12.2;
-- `.context/conventions.md` invariant 11.
--
-- **The design numbers this file `0005_authority.sql` and that number was taken
-- long before the design was written.** Its numbering is ignored here, exactly
-- as `0009`'s header says and for the same reason; this is the next free
-- number. What is taken from the design is the content of §3, not its file
-- names.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR, IN THE OWNER'S WORDS
-- ---------------------------------------------------------------------------
--
-- *"we don't want an admin to be able to take over the site type situation."*
-- `0004` built the first half: an operator principal cannot appear in a
-- membership, because the database's own referential integrity refuses it.
-- This file builds the half that matters more, because §3.1 moves design
-- visibility off `memberships.role` and onto scope grants: **every row that
-- expresses data authority references `principals (id, kind)` with the kind
-- pinned to a literal**, so an operator id in a grant, a seconding or a
-- revocation is refused in every session, at every privilege level, through
-- every interface, including `psql` as superuser.
--
-- §15.6 item 3: *"take the tables and the signature columns NOW, fill them
-- with software keys. §11.5 is right that retrofitting means invalidating
-- every grant or accepting a permanently unsigned tail."* That is this file.
-- What is deferred is the FACTOR (§15.1: hardware authenticators are not
-- required for v1), never the schema.
--
-- ---------------------------------------------------------------------------
-- FOUR PLACES THIS FILE DEPARTS FROM §3.2's SQL, EACH WITH ITS REASON
-- ---------------------------------------------------------------------------
--
-- 1. **`principals.kind` is `steward` here, not `account`.** §3.2 writes
--    `subject_kind text NOT NULL GENERATED ALWAYS AS ('account') STORED` and
--    then references `principals (id, kind)`. `0004` created that table with
--    `CHECK (kind IN ('steward', 'operator'))`, so a literal `'account'` would
--    make every insert fail the foreign key. The design's own vocabulary (§0:
--    *"stewards hold the data"*) is what `0004` implemented. `steward` it is.
--
-- 2. **Seconding and suspension are their own append-only tables**, not
--    columns on `scope_grants` that a later statement fills in. §3.2 has
--    `seconded_by`/`seconder_sig`/`suspended_at` on the grant row, which means
--    a grant row is rewritten after it is signed -- and §3.2's own comment on
--    `grant_revocations` gives the argument against exactly that: *"revocation
--    is a positive, append-only fact. There is no nullable column whose
--    absence means 'live'."* The same sentence is true of a seconding (a
--    second signature is a second act, by a second person, at a second time)
--    and of a suspension. So `scope_grants` is INSERT-ONLY, enforced by a
--    trigger that binds a superuser, and nothing a grant says can be edited
--    after it is signed. §3.2's cross-row `CHECK (seconded_by IS NULL OR
--    (seconded_by <> granted_by AND seconded_by <> subject_id))` survives the
--    move intact -- see `grant_secondings` below, where a three-column foreign
--    key pins the pair to the grant's own values and a plain `CHECK` then binds
--    the rule.
--
-- 3. **`grant_revocations` gains `revoker_key_fpr`.** §3.2 stores
--    `revoked_sig` and no statement of which key must verify it. §3.3 argues
--    at length for `granter_key_fpr` on the grant -- *"without it, a granter's
--    key rotation leaves no statement of which key should have verified the
--    grants they signed"* -- and a revocation signature has the identical
--    problem. The design is silent rather than wrong; this is the silence
--    filled.
--
-- 4. **`alg` is not a COSE identifier in this build.** §3.2 comments both
--    `root_alg` and `alg` as *"COSE algorithm id"*. The COSE Algorithms
--    registry could not be read -- `www.iana.org` is refused by this session's
--    proxy (403), 2026-09-12 -- and CLAUDE.md rule 1 forbids writing a
--    remembered number into a stored column. So both columns carry Fathom's
--    own id `1` = ES256 (`src/authority.rs`'s `ALG_ES256`) with a `CHECK` that
--    admits nothing else. Whoever lands WebAuthn either establishes the COSE
--    value and migrates these two columns, or keeps a Fathom id and maps at
--    the boundary. A column that says "COSE" and holds something else would be
--    worse than either.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT BUILT HERE, AND IS ABSENT RATHER THAN STUBBED
-- ---------------------------------------------------------------------------
--
--   * **`recovery_holders` (§8).** §15.2 reconsiders the whole shape -- Shamir
--     is staged last and may be replaced by wrapping the root key to each named
--     holder's account key -- so the table's columns are not decided. A table
--     built against a shape under reconsideration is a migration to undo.
--   * **`sessions` and the per-request proof (§4).** §15.6 item 4, its own
--     order.
--   * **The execution interlock's `sealed_seq` (§5.4)** and the administrative
--     surface it gates.
--   * **Groups (§3.7).** The design says in terms that the schema is not
--     touched until the group design has had its own attack round.
--   * **`move_bytes` / `reparent_bytes` (§3.6).** The bytes are specified and
--     `repo::move_subtree` is not yet gated on them; the label is listed in
--     `src/authority.rs` and nothing writes it. Adding a column for a
--     signature no code produces would be a name pretending to be a control.

-- ---------------------------------------------------------------------------
-- A. THE ORGANISATION ROOT KEY, AND THE ID DERIVED FROM IT
--
-- §6.1. The organisation id is `b32(H(LP("fathom/org/id/v1") || LP(root_pubkey)
-- || LP(id_salt)))` -- see `src/authority.rs::derive_organisation_id` for the
-- one departure (26 Crockford characters carry 130 bits and this repository's
-- ids are ULIDs, so the first 128 bits are taken and encoded, rather than the
-- first 26 characters of a base32 rendering, three quarters of which would not
-- decode as an id at all).
--
-- **This is what makes a second genesis unconstructible rather than merely
-- detected** (§6.1). Without it, the genesis grant is the one signature
-- anybody can produce, because it is self-signed, and the only things making
-- it authoritative are a boolean column and a partial unique index -- both
-- owned by a tier-2 attacker. With the id bound to the root key, a re-minted
-- genesis under a different key yields a DIFFERENT organisation id and matches
-- no existing row.
--
-- `ON DELETE RESTRICT`, not `CASCADE` as §3.2 writes it, and for `0009`'s
-- reason: a referential action is not subject to row-level security at any
-- privilege level, so a cascade is a way to remove the statement that binds an
-- id to a key by deleting something else. `chain_entries` already restricts
-- the same parent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organisation_roots (
    organisation_id text        PRIMARY KEY
                                REFERENCES organisations(id) ON DELETE RESTRICT,

    -- SEC1 uncompressed point: 0x04 || X || Y, 65 bytes for P-256. Checked
    -- here as well as in `src/authority.rs` so that a row nobody's code wrote
    -- is still the right shape.
    root_pubkey     bytea       NOT NULL CHECK (octet_length(root_pubkey) = 65
                                                AND get_byte(root_pubkey, 0) = 4),
    root_alg        smallint    NOT NULL CHECK (root_alg = 1),
    id_salt         bytea       NOT NULL CHECK (octet_length(id_salt) = 16),

    -- The `org_genesis` entry this root was announced in. §7.2.
    created_seq     bigint      NOT NULL CHECK (created_seq >= 1),
    created_at      timestamptz NOT NULL DEFAULT now(),

    row_seal        bytea       NOT NULL CHECK (octet_length(row_seal) = 32)
);

-- ---------------------------------------------------------------------------
-- B. THE KEYRING
--
-- §3.2's *"append-only, sealed keyring. One row per registered authenticator
-- or successor key. Never updated in place except to record supersession."*
-- The trigger in section G is what makes the second half of that sentence
-- true for every role rather than for well-behaved code.
--
-- **`key_source` is new and §15.1 is why.** The design was written for
-- hardware authenticators and §15.1 downgraded v1 to software keys
-- deliberately -- *"a design that opens with 'buy two security keys per person
-- before you can create your first rack' does not get evaluated on a Friday
-- afternoon"*. Which kind a key is has to be a stored fact, or
-- `FATHOM_REQUIRE_HARDWARE_STEWARD` (§15.1's shipped flag, not built here) has
-- nothing to read, and the audit trail cannot say which kind of key signed. It
-- also carries `credential_id`'s nullability honestly: a WebAuthn credential
-- id exists for an authenticator and does not exist for a software key, and a
-- `NOT NULL` column filled with a placeholder is a lie the schema tells about
-- itself.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_keys (
    id              text        PRIMARY KEY CHECK (char_length(id) = 26),

    -- Two fences, not one, exactly as `0004` put two on `memberships`: the
    -- account must exist, AND the principal it names must be a steward. The
    -- second is the one that binds if a later migration ever relaxes the
    -- first.
    account_id      text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    principal_kind  text        GENERATED ALWAYS AS ('steward') STORED,

    key_source      text        NOT NULL CHECK (key_source IN ('software', 'authenticator')),
    credential_id   bytea       UNIQUE,
    public_key      bytea       NOT NULL,
    alg             smallint    NOT NULL CHECK (alg = 1),

    -- `H(LP("fathom/key/fpr/v1") || LP(public_key))`. The one name a grant
    -- uses for a key: §3.3 puts `subject_key_fpr` and `granter_key_fpr` inside
    -- the signed bytes, so the fingerprint is what the signature commits to
    -- and the row is what resolves it.
    fpr             bytea       NOT NULL UNIQUE CHECK (octet_length(fpr) = 32),

    enrolled_seq    bigint      NOT NULL CHECK (enrolled_seq >= 1),
    enrolled_at     timestamptz NOT NULL DEFAULT now(),

    -- §8.4's succession: the old key signs the new one, so a key rotation
    -- carries grants forward without a re-signing campaign.
    superseded_by   text        REFERENCES account_keys(id),
    succession_sig  bytea       CHECK (succession_sig IS NULL
                                       OR octet_length(succession_sig) = 64),
    retired_at      timestamptz,

    -- §11.2's row seal covers `row_version`, so a supersession that rewrites
    -- the row must bump it or the seal it recomputes is the seal it replaced.
    -- §3.2 gives `scope_grants` this column and not `account_keys`; the
    -- omission is a gap, because this is the one keyring row that is ever
    -- updated at all.
    row_version     integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal        bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    CHECK ((key_source = 'authenticator') = (credential_id IS NOT NULL)),
    -- A software ES256 key is a SEC1 uncompressed point. An authenticator's is
    -- a COSE_Key, whose shape this build does not parse and does not pretend
    -- to (§15.4).
    CHECK (key_source <> 'software'
           OR (octet_length(public_key) = 65 AND get_byte(public_key, 0) = 4)),
    CHECK (superseded_by IS NULL OR superseded_by <> id),
    CHECK ((superseded_by IS NULL) = (succession_sig IS NULL)),

    FOREIGN KEY (account_id, principal_kind) REFERENCES principals (id, kind)
);

CREATE INDEX IF NOT EXISTS account_keys_account_idx ON account_keys (account_id);

-- ---------------------------------------------------------------------------
-- C. GRANTS
--
-- §3.1: `read` opens designs at or below this scope, `draw` edits them,
-- `steward` grants, seconds, suspends and revokes within this subtree.
-- Stewardship is the only grant-granting power in the product and it lives
-- INSIDE the scope; there is no path from any operator verb to it.
--
-- **Every signature column is fixed-size `r || s`, 64 bytes, never DER.** §3's
-- correction at the head of the section: ECDSA signatures are malleable two
-- ways at once, so one authority can produce several byte-distinct signatures
-- over one message. A `CHECK` on the length is the cheapest possible statement
-- that this database stores one encoding.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scope_grants (
    id                text        PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id   text        NOT NULL
                                  REFERENCES organisations(id) ON DELETE RESTRICT,

    -- **NULL means the organisation itself**, and §3.2 writes this column
    -- `NOT NULL`. It cannot be, in this schema: `0002` makes `organisations`
    -- the ROOT of the scope tree and `scopes` hold only the three levels
    -- beneath it (`network -> building -> rack`), so there is no row for the
    -- organisation to point at -- and §6.1's genesis grant, §1.1's *"any
    -- steward of that organisation"* and §3.5's *"live distinct stewards of the
    -- organisation"* are all statements about authority at that root. A
    -- genesis grant would otherwise have to name a network that does not exist
    -- until after genesis.
    --
    -- It is a NULL rather than a sentinel string because a sentinel is a value
    -- a later scope could collide with, and because the foreign key then does
    -- its job unchanged for every non-NULL row (MATCH SIMPLE is not enforced
    -- when the column is NULL). In the signed bytes it is the EMPTY STRING,
    -- length-prefixed like every other field (§3.3's `LP(scope_id)`), so
    -- "the organisation" has exactly one encoding.
    scope_id          text        REFERENCES scopes(id) ON DELETE RESTRICT,

    subject_id        text        NOT NULL,
    subject_kind      text        GENERATED ALWAYS AS ('steward') STORED,
    -- §3.3: *"without this, an administrator swaps the subject's public key for
    -- one they hold and replays a year-old legitimate grant."*
    subject_key_fpr   bytea       NOT NULL CHECK (octet_length(subject_key_fpr) = 32),

    capability        text        NOT NULL CHECK (capability IN ('read', 'draw', 'steward')),

    granter_kind      text        NOT NULL CHECK (granter_kind IN ('account', 'org_root')),
    granted_by        text,
    granter_principal_kind text    GENERATED ALWAYS AS
                                   (CASE WHEN granted_by IS NULL THEN NULL ELSE 'steward' END)
                                   STORED,
    granter_key_fpr   bytea       NOT NULL CHECK (octet_length(granter_key_fpr) = 32),
    granter_sig       bytea       NOT NULL CHECK (octet_length(granter_sig) = 64),

    is_genesis        boolean     NOT NULL DEFAULT false,
    is_recovery       boolean     NOT NULL DEFAULT false,

    -- §3.5's sole-steward path, recorded on the row rather than inferred.
    --
    -- *"A sole steward may appoint a second alone, with a 24-hour delay, an
    -- undismissable in-product banner, a mailed notice, and a cancel button
    -- for the appointer."* So a `steward` grant is usable either because a
    -- second steward seconded it, or because it was made under this rule and
    -- the delay has passed -- and a verifier at use has to be able to tell
    -- which, without re-deriving how many stewards there were on the day. The
    -- alternative, counting live stewards at verification time, gives a
    -- different answer as the organisation grows and would make a grant stop
    -- verifying because somebody else was appointed.
    --
    -- **The banner, the mailed notice and the cancel button are NOT built.**
    -- They need a surface that does not exist. What is built is the delay and
    -- the record, so that when the surface arrives it has a fact to render
    -- rather than an inference to make.
    sole_steward_appointment boolean NOT NULL DEFAULT false,
    auth_epoch        integer     NOT NULL CHECK (auth_epoch >= 1),
    effective_from    timestamptz NOT NULL,
    expires_at        timestamptz,

    chain_seq         bigint      NOT NULL CHECK (chain_seq >= 1),
    row_version       integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal          bytea       NOT NULL CHECK (octet_length(row_seal) = 32),
    created_at        timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (subject_id, subject_kind)           REFERENCES principals (id, kind),
    FOREIGN KEY (granted_by, granter_principal_kind) REFERENCES principals (id, kind),

    -- Genesis and recovery grants are signed by the organisation root key,
    -- which is not a principal, so the self-grant question does not arise for
    -- them (§3.2).
    CHECK (granter_kind = 'org_root' OR subject_id <> granted_by),
    CHECK ((granter_kind = 'org_root') = (granted_by IS NULL)),
    CHECK (capability <> 'steward' OR expires_at IS NOT NULL),
    CHECK (NOT is_recovery OR (capability = 'steward' AND expires_at IS NOT NULL)),
    CHECK (expires_at IS NULL OR expires_at > effective_from),
    -- The sole-steward path is §3.5's answer to a deadlock in appointing a
    -- STEWARD, by an account. It has no meaning for `read`, for `draw`, or for
    -- a root-signed genesis or recovery grant, and a flag that can be set
    -- where it means nothing is a flag a reader has to interpret.
    CHECK (NOT sole_steward_appointment
           OR (capability = 'steward' AND granter_kind = 'account'
               AND NOT is_genesis AND NOT is_recovery)),

    -- Referenced by `grant_secondings`' three-column foreign key below. `id`
    -- is already unique on its own; this states the triple so that a seconding
    -- cannot name a grant and a DIFFERENT grant's subject or granter.
    UNIQUE (id, subject_id, granted_by)
);

CREATE UNIQUE INDEX IF NOT EXISTS scope_grants_genesis_pair
    ON scope_grants (organisation_id, subject_id) WHERE is_genesis;
CREATE INDEX IF NOT EXISTS scope_grants_subject_idx
    ON scope_grants (organisation_id, subject_id, scope_id);

-- §3.2's trigger, unchanged in substance. Genesis grants may only be written
-- while the organisation's authority is still at epoch 0 -- i.e. in the
-- transaction that creates it. Afterwards the root key signs ONLY
-- `is_recovery` grants, which are time-boxed, announced before they issue and
-- bannered for their duration (§8.2). Without this, a reassembled root key
-- could write an unbounded, unannounced "genesis" steward at any later date,
-- which is break-glass with none of break-glass's controls.
--
-- `SECURITY DEFINER` with `search_path` pinned, because it reads a table
-- behind `FORCE ROW LEVEL SECURITY` -- §2's named trap: *"a trigger function
-- that reads a row-level-security-protected table must be SECURITY DEFINER
-- with a pinned search_path, or it runs as the invoker, sees nothing, and
-- passes vacuously."*
CREATE OR REPLACE FUNCTION fathom_genesis_is_creation_only() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
    IF NEW.is_genesis AND EXISTS (
        SELECT 1 FROM organisation_auth_head h
         WHERE h.organisation_id = NEW.organisation_id
           AND h.auth_epoch > 0
    ) THEN
        RAISE EXCEPTION
            'genesis grants are creation-only; use a recovery grant (admin design 3.2, 6.1)';
    END IF;
    RETURN NEW;
END
$fn$;

-- ---------------------------------------------------------------------------
-- D. SECONDINGS
--
-- §3.5: granting `steward` needs `min(2, live distinct stewards of the
-- organisation)` signatures. The second one lands here.
--
-- **The cross-row rule §3.2 wrote as a `CHECK` is kept as a constraint, not
-- moved into application code.** A `CHECK` cannot read another table, so the
-- two facts it needs -- who the grant's subject is, and who signed it -- are
-- carried on this row and PINNED to the grant's own values by a three-column
-- foreign key onto the `UNIQUE (id, subject_id, granted_by)` above. A row
-- claiming a different subject than the grant has does not reference anything
-- and is refused. With the pair pinned, a plain `CHECK` binds the rule: a
-- seconder may be neither the subject nor the granter.
--
-- `grant_granter_id` is `NOT NULL`, so a grant signed by the organisation root
-- key cannot be seconded -- deliberately. A genesis or recovery grant is
-- root-signed and §3.5's quorum is about stewards seconding stewards; a root
-- signature has its own controls in §8.2.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grant_secondings (
    id                text        PRIMARY KEY CHECK (char_length(id) = 26),
    grant_id          text        NOT NULL REFERENCES scope_grants(id) ON DELETE RESTRICT,
    organisation_id   text        NOT NULL
                                  REFERENCES organisations(id) ON DELETE RESTRICT,

    grant_subject_id  text        NOT NULL,
    grant_granter_id  text        NOT NULL,

    seconded_by       text        NOT NULL,
    seconder_kind     text        GENERATED ALWAYS AS ('steward') STORED,
    seconder_key_fpr  bytea       NOT NULL CHECK (octet_length(seconder_key_fpr) = 32),
    seconder_sig      bytea       NOT NULL CHECK (octet_length(seconder_sig) = 64),

    chain_seq         bigint      NOT NULL CHECK (chain_seq >= 1),
    seconded_at       timestamptz NOT NULL DEFAULT now(),
    row_seal          bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    FOREIGN KEY (seconded_by, seconder_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (grant_id, grant_subject_id, grant_granter_id)
        REFERENCES scope_grants (id, subject_id, granted_by),

    CHECK (seconded_by <> grant_subject_id AND seconded_by <> grant_granter_id),
    UNIQUE (grant_id, seconded_by)
);

-- ---------------------------------------------------------------------------
-- E. SUSPENSION AND REVOCATION
--
-- §1.1 gives an operator exactly one verb that touches authority: **suspend**,
-- immediately, with any steward of that organisation able to lift it. So this
-- is the one table in this file where an operator principal may legitimately
-- appear, and the schema says which half of the act they may perform: the
-- `CHECK` below refuses `unsuspend` for an operator. An operator who suspends
-- a grant cannot restore it, and therefore cannot use suspend-and-restore as a
-- quiet way to test what a grant controls.
--
-- `actor_kind` is a real column and not a generated literal precisely because
-- it varies -- and the composite foreign key still binds it: the kind named
-- here must be the kind `principals` records for that id.
--
-- **Append-only, and the state is the latest row.** §3.2's argument for
-- revocations applies unchanged: a `suspended_at` column whose absence means
-- live is a column a tier-2 attacker clears. `seq` is an identity column, so
-- ordering does not depend on a clock anybody can set.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grant_suspensions (
    seq             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    grant_id        text        NOT NULL REFERENCES scope_grants(id) ON DELETE RESTRICT,
    organisation_id text        NOT NULL
                                REFERENCES organisations(id) ON DELETE RESTRICT,

    action          text        NOT NULL CHECK (action IN ('suspend', 'unsuspend')),

    actor_kind      text        NOT NULL CHECK (actor_kind IN ('steward', 'operator')),
    actor_id        text        NOT NULL,
    actor_key_fpr   bytea       CHECK (actor_key_fpr IS NULL
                                       OR octet_length(actor_key_fpr) = 32),
    actor_sig       bytea       CHECK (actor_sig IS NULL OR octet_length(actor_sig) = 64),

    at              timestamptz NOT NULL DEFAULT now(),
    chain_seq       bigint      NOT NULL CHECK (chain_seq >= 1),
    row_seal        bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    FOREIGN KEY (actor_id, actor_kind) REFERENCES principals (id, kind),

    -- A steward signs; an operator does not, because §4.5 gives the operator
    -- surface no signing key of this kind at all and §1.1 gates the verb on an
    -- operator SESSION instead. Stating it here means a future signature
    -- column filled with anything for an operator row fails rather than
    -- quietly verifying against nothing.
    CHECK ((actor_kind = 'steward') = (actor_sig IS NOT NULL)),
    CHECK ((actor_sig IS NULL) = (actor_key_fpr IS NULL)),
    CHECK (actor_kind <> 'operator' OR action = 'suspend')
);

CREATE INDEX IF NOT EXISTS grant_suspensions_grant_idx
    ON grant_suspensions (grant_id, seq DESC);

-- §3.2, unchanged except for `revoker_key_fpr` -- see the header's departure 3.
CREATE TABLE IF NOT EXISTS grant_revocations (
    grant_id        text        PRIMARY KEY REFERENCES scope_grants(id) ON DELETE RESTRICT,
    organisation_id text        NOT NULL
                                REFERENCES organisations(id) ON DELETE RESTRICT,
    revoked_at      timestamptz NOT NULL DEFAULT now(),

    revoked_by      text        NOT NULL,
    revoker_kind    text        GENERATED ALWAYS AS ('steward') STORED,
    revoker_key_fpr bytea       NOT NULL CHECK (octet_length(revoker_key_fpr) = 32),
    revoked_sig     bytea       NOT NULL CHECK (octet_length(revoked_sig) = 64),

    chain_seq       bigint      NOT NULL CHECK (chain_seq >= 1),
    row_seal        bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    FOREIGN KEY (revoked_by, revoker_kind) REFERENCES principals (id, kind)
);

-- ---------------------------------------------------------------------------
-- F. THE HEAD
--
-- §3.4: *"every grant lifecycle event increments `auth_epoch`, writes a chain
-- entry, and rewrites the head in the same transaction. So the current state
-- of the SET is authenticated, not merely the author of each row. That is the
-- gap every earlier draft left: signatures proved who wrote a row and nothing
-- proved what the rows currently say or which of them are still there."*
--
-- One row per organisation, and the only row in this file that is UPDATEd.
-- The trigger in section G refuses an update that does not advance it, which
-- is the in-database half of §3.4 step 3's rollback check. **The other half --
-- an in-process high-water mark per organisation, so that restoring last
-- month's table is caught across a restart -- is NOT built here**, because it
-- belongs with §7.6's anchors and startup quarantine, which `0009` deferred
-- for the same reason. A database-local monotonicity check does not detect a
-- whole-database rollback and must not be described as if it did.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organisation_auth_head (
    organisation_id text        PRIMARY KEY
                                REFERENCES organisations(id) ON DELETE RESTRICT,
    auth_epoch      integer     NOT NULL CHECK (auth_epoch >= 1),
    chain_seq       bigint      NOT NULL CHECK (chain_seq >= 1),
    live_count      integer     NOT NULL CHECK (live_count >= 0),
    live_digest     bytea       NOT NULL CHECK (octet_length(live_digest) = 32),
    head_seal       bytea       NOT NULL CHECK (octet_length(head_seal) = 32),
    advanced_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- G. THE APPEND-ONLY FENCES, BY TRIGGER, SO THEY BIND A SUPERUSER TOO
--
-- `0009` §D's argument, applied to six more tables: a policy is evaluated for
-- the role that issued the statement and is not evaluated at all for a
-- superuser; a `BEFORE ... FOR EACH ROW` trigger fires whoever is connected.
-- `TRUNCATE` fires no row-level trigger at all, so it gets its own
-- statement-level one -- without it, one statement erases the whole authority
-- of every tenant.
--
-- WHAT THIS DOES NOT CLAIM, written down so nobody reads it as more: the
-- trigger is disabled by `ALTER TABLE ... DISABLE TRIGGER USER`, which needs
-- ownership. That is the tier-3 move `0009`'s header names, and the row seals
-- plus the head seal are what catch it afterwards.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fathom_authority_is_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION
        'authority rows are append-only: % on % is refused at every privilege level',
        TG_OP, TG_TABLE_NAME;
END
$fn$;

DROP TRIGGER IF EXISTS organisation_roots_append_only ON organisation_roots;
CREATE TRIGGER organisation_roots_append_only
    BEFORE UPDATE OR DELETE ON organisation_roots
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
DROP TRIGGER IF EXISTS organisation_roots_no_truncate ON organisation_roots;
CREATE TRIGGER organisation_roots_no_truncate
    BEFORE TRUNCATE ON organisation_roots
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

DROP TRIGGER IF EXISTS scope_grants_append_only ON scope_grants;
CREATE TRIGGER scope_grants_append_only
    BEFORE UPDATE OR DELETE ON scope_grants
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
DROP TRIGGER IF EXISTS scope_grants_no_truncate ON scope_grants;
CREATE TRIGGER scope_grants_no_truncate
    BEFORE TRUNCATE ON scope_grants
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

DROP TRIGGER IF EXISTS grant_secondings_append_only ON grant_secondings;
CREATE TRIGGER grant_secondings_append_only
    BEFORE UPDATE OR DELETE ON grant_secondings
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
DROP TRIGGER IF EXISTS grant_secondings_no_truncate ON grant_secondings;
CREATE TRIGGER grant_secondings_no_truncate
    BEFORE TRUNCATE ON grant_secondings
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

DROP TRIGGER IF EXISTS grant_suspensions_append_only ON grant_suspensions;
CREATE TRIGGER grant_suspensions_append_only
    BEFORE UPDATE OR DELETE ON grant_suspensions
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
DROP TRIGGER IF EXISTS grant_suspensions_no_truncate ON grant_suspensions;
CREATE TRIGGER grant_suspensions_no_truncate
    BEFORE TRUNCATE ON grant_suspensions
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

DROP TRIGGER IF EXISTS grant_revocations_append_only ON grant_revocations;
CREATE TRIGGER grant_revocations_append_only
    BEFORE UPDATE OR DELETE ON grant_revocations
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
DROP TRIGGER IF EXISTS grant_revocations_no_truncate ON grant_revocations;
CREATE TRIGGER grant_revocations_no_truncate
    BEFORE TRUNCATE ON grant_revocations
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

-- `account_keys`: DELETE and TRUNCATE refused outright; UPDATE allowed only
-- for the five columns a supersession touches. §3.2: *"never updated in place
-- except to record supersession."* Anything else -- a swapped `public_key`, a
-- moved `account_id`, a rewritten `fpr` -- is the attack this keyring exists to
-- make impossible, so it is refused by name rather than by privilege, and
-- therefore refused for a superuser too.
--
-- **Re-supersession is refused as well.** A key that already names a successor
-- has had its one update; pointing it at a second successor is a fork in the
-- succession chain with no statement of which branch is real.
CREATE OR REPLACE FUNCTION fathom_account_key_supersession_only() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'the account keyring is append-only: DELETE is refused at every privilege level';
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.account_id <> OLD.account_id
       OR NEW.key_source <> OLD.key_source
       OR NEW.public_key <> OLD.public_key
       OR NEW.alg <> OLD.alg
       OR NEW.fpr <> OLD.fpr
       OR NEW.enrolled_seq <> OLD.enrolled_seq
       OR NEW.enrolled_at <> OLD.enrolled_at
       OR NEW.credential_id IS DISTINCT FROM OLD.credential_id THEN
        RAISE EXCEPTION
            'an account key may only be updated to record supersession or retirement '
            '(admin design 3.2, 8.4)';
    END IF;
    IF OLD.superseded_by IS NOT NULL
       AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
        RAISE EXCEPTION 'this key already names a successor; succession does not fork';
    END IF;
    IF NEW.row_version <= OLD.row_version THEN
        RAISE EXCEPTION
            'an update to an account key must bump row_version, which the row seal covers';
    END IF;
    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS account_keys_supersession_only ON account_keys;
CREATE TRIGGER account_keys_supersession_only
    BEFORE UPDATE OR DELETE ON account_keys
    FOR EACH ROW EXECUTE FUNCTION fathom_account_key_supersession_only();
DROP TRIGGER IF EXISTS account_keys_no_truncate ON account_keys;
CREATE TRIGGER account_keys_no_truncate
    BEFORE TRUNCATE ON account_keys
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

-- The head: DELETE and TRUNCATE refused; UPDATE must ADVANCE. §3.4 step 3
-- reads a head whose epoch is lower than one already seen as a rollback and
-- fails closed; this is the same statement made where a transaction cannot get
-- past it.
CREATE OR REPLACE FUNCTION fathom_auth_head_only_advances() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'the authority head is the statement of what is live: DELETE is refused at every '
            'privilege level';
    END IF;
    IF NEW.organisation_id <> OLD.organisation_id THEN
        RAISE EXCEPTION 'the authority head does not move between organisations';
    END IF;
    IF NEW.auth_epoch <= OLD.auth_epoch THEN
        RAISE EXCEPTION
            'the authority head only advances: epoch % does not follow % (admin design 3.4)',
            NEW.auth_epoch, OLD.auth_epoch;
    END IF;
    IF NEW.chain_seq < OLD.chain_seq THEN
        RAISE EXCEPTION
            'the authority head only advances: chain_seq % is behind % (admin design 3.4)',
            NEW.chain_seq, OLD.chain_seq;
    END IF;
    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS organisation_auth_head_only_advances ON organisation_auth_head;
CREATE TRIGGER organisation_auth_head_only_advances
    BEFORE UPDATE OR DELETE ON organisation_auth_head
    FOR EACH ROW EXECUTE FUNCTION fathom_auth_head_only_advances();
DROP TRIGGER IF EXISTS organisation_auth_head_no_truncate ON organisation_auth_head;
CREATE TRIGGER organisation_auth_head_no_truncate
    BEFORE TRUNCATE ON organisation_auth_head
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

-- The genesis trigger is created last, because it names
-- `organisation_auth_head`, which is created in section F.
DROP TRIGGER IF EXISTS scope_grants_genesis_creation_only ON scope_grants;
CREATE TRIGGER scope_grants_genesis_creation_only
    BEFORE INSERT ON scope_grants
    FOR EACH ROW EXECUTE FUNCTION fathom_genesis_is_creation_only();

-- ---------------------------------------------------------------------------
-- H. ROW-LEVEL SECURITY
--
-- Forced on every table. **Every policy names its command and none is
-- `FOR ALL`** -- `0003`'s bug, restated on every migration that writes a
-- policy because it is the one that got through: a `FOR ALL` policy's `USING`
-- expression is silently reused by PostgreSQL as the `WITH CHECK` for every
-- write.
--
-- **No UPDATE policy and no DELETE policy on the five append-only tables.**
-- With row security forced and no policy for a command, that command reaches
-- no rows at all -- so the policy layer and the trigger layer say the same
-- thing in two independent mechanisms, and the privilege layer below says it a
-- third time.
-- ---------------------------------------------------------------------------
ALTER TABLE organisation_roots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_roots      FORCE  ROW LEVEL SECURITY;
ALTER TABLE account_keys            ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_keys            FORCE  ROW LEVEL SECURITY;
ALTER TABLE scope_grants            ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_grants            FORCE  ROW LEVEL SECURITY;
ALTER TABLE grant_secondings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_secondings        FORCE  ROW LEVEL SECURITY;
ALTER TABLE grant_suspensions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_suspensions       FORCE  ROW LEVEL SECURITY;
ALTER TABLE grant_revocations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE grant_revocations       FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation_auth_head  ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_auth_head  FORCE  ROW LEVEL SECURITY;

CREATE POLICY organisation_roots_readable ON organisation_roots
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY organisation_roots_insertable ON organisation_roots
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- `account_keys` is keyed on an ACCOUNT, not on a tenant, so it gets
-- `principals_readable`'s shape rather than the tenant one: the acting account
-- itself, plus anyone who shares the transaction's tenant with it. A steward
-- signing a grant has to resolve the subject's key, and the subject is a
-- member of the same organisation by construction (§6.4: *"a steward signs a
-- grant naming a subject who ALREADY has a registered key"*).
--
-- Enrolment is the key holder's own act and so is supersession -- §8.4's old
-- key signs the new one, which nobody else can do. Hence `account_id =
-- app.account_id` on both write policies. There is still no authentication
-- layer (`docs/OPEN-QUESTIONS.md` B1-B9), so this is not a defence against a
-- caller that lies about who is acting; it is the shape that will bind when
-- there is one, written now so the diff to look for is small.
CREATE POLICY account_keys_readable ON account_keys
    FOR SELECT USING (
        account_id = current_setting('app.account_id', true)
        OR EXISTS (
            SELECT 1 FROM memberships m
             WHERE m.account_id = account_keys.account_id
               AND m.organisation_id = current_setting('app.tenant_id', true)
        )
    );
CREATE POLICY account_keys_insertable ON account_keys
    FOR INSERT WITH CHECK (account_id = current_setting('app.account_id', true));
CREATE POLICY account_keys_updatable ON account_keys
    FOR UPDATE USING (account_id = current_setting('app.account_id', true))
            WITH CHECK (account_id = current_setting('app.account_id', true));

CREATE POLICY scope_grants_readable ON scope_grants
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY scope_grants_insertable ON scope_grants
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY grant_secondings_readable ON grant_secondings
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY grant_secondings_insertable ON grant_secondings
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY grant_suspensions_readable ON grant_suspensions
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY grant_suspensions_insertable ON grant_suspensions
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY grant_revocations_readable ON grant_revocations
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY grant_revocations_insertable ON grant_revocations
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

CREATE POLICY organisation_auth_head_readable ON organisation_auth_head
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY organisation_auth_head_insertable ON organisation_auth_head
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY organisation_auth_head_updatable ON organisation_auth_head
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- I. PRIVILEGES -- WHAT THE RUNTIME ROLE DOES NOT GET
--
-- `0006` set default privileges that hand `fathom_app` all four verbs on every
-- table this file creates. Two of them are not earned, and a privilege
-- withheld is checked BEFORE row security and before any trigger runs -- §0's
-- fence table puts `Grant` above `Constraint` for exactly this reason.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON organisation_roots     FROM fathom_app;
REVOKE UPDATE, DELETE ON scope_grants           FROM fathom_app;
REVOKE UPDATE, DELETE ON grant_secondings       FROM fathom_app;
REVOKE UPDATE, DELETE ON grant_suspensions      FROM fathom_app;
REVOKE UPDATE, DELETE ON grant_revocations      FROM fathom_app;
REVOKE DELETE           ON account_keys         FROM fathom_app;
REVOKE DELETE           ON organisation_auth_head FROM fathom_app;

-- A COLUMN-LEVEL grant for the one legitimate update to a keyring row, the
-- same shape `0009` §E used for retiring a master key: `public_key`, `fpr`,
-- `account_id` and `alg` stay un-rewritable at the privilege layer, so the
-- trigger above is the second statement of that rule rather than the only one.
REVOKE UPDATE ON account_keys FROM fathom_app;
GRANT UPDATE (superseded_by, succession_sig, retired_at, row_version, row_seal)
    ON account_keys TO fathom_app;

-- ---------------------------------------------------------------------------
-- J. THE OPERATOR PLANE
--
-- §1.1's first verb: *"list organisations, their scope tree shape, members,
-- grants and capability map"*. §1.3's list grants `scope_grants` and
-- `grant_revocations` to the operator plane and **revokes `account_keys`** --
-- both are honoured exactly. Secondings, suspensions and the head are granted
-- on the same argument as `scope_grants`: they ARE the capability map, and an
-- operator who can suspend a grant (§1.1) but cannot see whether it is
-- suspended has been given a verb with no way to check it.
--
-- **`organisation_roots` is NOT granted.** It is not covered by §1.3's list,
-- it answers no verb in §1.1, and it is the one table whose contents bind an
-- organisation's identity to a key. A grant nobody needs is a policy nobody
-- needs.
--
-- `FOR SELECT`, never `FOR ALL`, and role-targeted with the `current_user`
-- guard `0005` explains in full: policy applicability follows `INHERIT`, and
-- the guard removes the dependency on which PostgreSQL major is running.
-- `tests/planes.rs` checks the `FOR SELECT` half off `pg_policies` for every
-- operator-plane policy on every run.
-- ---------------------------------------------------------------------------
GRANT SELECT ON scope_grants, grant_secondings, grant_suspensions,
                grant_revocations, organisation_auth_head
    TO fathom_operator;

CREATE POLICY scope_grants_readable_by_operator_plane ON scope_grants
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');
CREATE POLICY grant_secondings_readable_by_operator_plane ON grant_secondings
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');
CREATE POLICY grant_suspensions_readable_by_operator_plane ON grant_suspensions
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');
CREATE POLICY grant_revocations_readable_by_operator_plane ON grant_revocations
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');
CREATE POLICY organisation_auth_head_readable_by_operator_plane ON organisation_auth_head
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');

-- ---------------------------------------------------------------------------
-- K. THE ENTRY TYPES THIS FILE'S ACTS WRITE (§7.2)
--
-- Extended by `DROP CONSTRAINT` then `ADD CONSTRAINT`, wrapped in the
-- invariant-11 `NO FORCE` / `FORCE` pair -- the path `0010` §C documents,
-- followed rather than re-invented. `ADD CONSTRAINT ... CHECK` re-validates
-- every row already in `chain_entries`, and that validating scan is a read of
-- a table behind `FORCE ROW LEVEL SECURITY`, which with no tenant context
-- returns zero rows SILENTLY. **On an empty database the difference is
-- invisible**, which is how `0009` shipped a foreign key with the same bug.
-- The pair is LOAD-BEARING and must not be tidied away.
--
-- The nine new types are §7.2's organisation-chain list for this file's acts.
-- Every one of them is written by `src/grants.rs`; §7.2's remaining names
-- (`scope_moved`, `devices_reparented`, `recovery_holders_set`,
-- `break_glass_*`, `member_added|removed`, `authority_rollback`) arrive with
-- the surfaces that cause them, because an entry type nothing emits is a name
-- in a `CHECK` constraint pretending to be a control.
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
                                'spool_pressure', 'rewrap'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
