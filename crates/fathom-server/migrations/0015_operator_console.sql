-- 0015 -- the operator console, the enrolment path an invitation travels, and
-- the execution interlock the settings path stands on.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.1 (the verbs), §1.3 (two
-- database roles), §4.5 (the operator surface has no password path at all),
-- §5.1, §5.3, §5.4, §5.5, §6.2, §6.3, §7.2 (entry types), §15.0 (the role is
-- `fathom_operator`); `docs/OPEN-QUESTIONS.md` B5 (invite only, nobody
-- self-registers); `.context/conventions.md` invariant 11.
--
-- **0013 and 0014 are not edited and must never be.** Both have shipped and
-- are under the checksum gate in `src/migrate.rs`, so what they SAY that this
-- file makes untrue is corrected in section 0 below, and what they DO is
-- changed only by statements in this file.
--
-- ---------------------------------------------------------------------------
-- 0. WHAT 0013's HEADER SAYS THAT THIS FILE MAKES UNTRUE
-- ---------------------------------------------------------------------------
--
-- 0013's "WHAT IS NOT BUILT HERE" says, correctly for its own day:
--
--   * *"**No operator keyring.** An operator session is `A1` or it does not
--     exist (§4.5), and there is no table an operator's key could be enrolled
--     in -- `account_keys` is account-scoped by foreign key. So
--     `principal_kind = 'operator'` is representable here and unreachable
--     today; `src/sessions.rs` refuses the operator branch with a typed error
--     naming §4.5."*
--
--     Section B of this file is that table. The operator branch of
--     `src/sessions.rs` now resolves a key from it and refuses on exactly the
--     same terms an account is refused on. **What has NOT changed is §4.5:
--     there is still no password path on any surface, no reset link, no
--     "forgot" flow, and no field in any message this server parses that a
--     password could arrive in.** An operator session is `A1` or it does not
--     exist, and the factor is a signature by a key enrolled in section B.
--
--   * *"**No `sealed_seq` interlock (§5.4)** and no admin surface."* Sections
--     F and G are the interlock; `src/admin.rs` is the surface.
--
-- 0013 §G said `operator_signin` was *"deliberately ABSENT: nothing can write
-- it until an operator key can be enrolled, and an entry type nothing emits is
-- a name in a `CHECK` constraint pretending to be a control."* An operator key
-- can now be enrolled, so section J adds it, and every other type this file's
-- acts write. The rule that added it is the rule that kept it out.
--
-- ---------------------------------------------------------------------------
-- THE LINE THIS FILE DOES NOT CROSS
-- ---------------------------------------------------------------------------
--
-- **An operator cannot grant capability inside an organisation.** Nothing
-- below gives `fathom_app` or `fathom_operator` a new way to write
-- `memberships`, `scope_grants` or `grant_secondings`, and nothing below
-- weakens `0004`'s composite foreign keys, which make an operator principal
-- unrepresentable in any of them at every privilege level including superuser.
-- The operator verbs this file makes reachable are exactly §1.1's: create an
-- account shell, issue and expire an enrolment token, create an organisation
-- shell and its claim, suspend a scope grant (never lift one -- `0011`'s own
-- `CHECK` refuses that for an operator principal), disable an operator, and
-- administer site settings behind §5.4's interlock.
--
-- ---------------------------------------------------------------------------
-- A. THE OPERATOR REGISTER GAINS THE FIVE COLUMNS §5.5 AND §1.1 NEED
--
-- `0004` created `operators` deliberately almost empty and said the paths that
-- write it *"land with their own migrations and bring their own rules with
-- them"*. This is that migration.
--
--   * `created_by`  -- §5.5: the admin page shows *"created by X, never
--                     independently signed in"* beside every operator until
--                     that stops being true. NULL for the bootstrap operator
--                     of §6.3, who was created by the key volume and by no
--                     one.
--   * `created_seq` -- the site-chain entry that created this operator. §5.4's
--                     interlock applied to the register itself: a row whose
--                     entry does not verify is an operator who cannot sign in,
--                     so minting one directly in PostgreSQL buys nothing.
--   * `first_independent_signin_at` -- §5.5's second condition for seconding.
--   * `disabled_at` -- §1.1's suspend verb, for the operator plane itself. A
--                     disabled operator's live sessions stop at their next
--                     request, exactly as a disabled account's do (`0013` §A).
--   * `row_version` / `row_seal` -- the row is sealed under the site-scoped
--                     row key with `authority::row_seal`, so an operator row
--                     minted or edited by whoever holds the database does not
--                     verify and cannot sign in. **A NULL seal is refused for
--                     the same reason a wrong one is**: the columns are
--                     nullable only because `ALTER TABLE ... ADD COLUMN NOT
--                     NULL` cannot be written against a table that might hold
--                     rows, and `src/operators.rs` treats NULL as
--                     unverifiable.
-- ---------------------------------------------------------------------------
ALTER TABLE operators ADD COLUMN IF NOT EXISTS created_by text REFERENCES operators(id);
ALTER TABLE operators ADD COLUMN IF NOT EXISTS created_seq bigint;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS first_independent_signin_at timestamptz;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;
ALTER TABLE operators ADD COLUMN IF NOT EXISTS row_seal bytea;

ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_row_seal_is_thirty_two_bytes;
ALTER TABLE operators
    ADD CONSTRAINT operators_row_seal_is_thirty_two_bytes
    CHECK (row_seal IS NULL OR octet_length(row_seal) = 32);

ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_are_not_their_own_creator;
ALTER TABLE operators
    ADD CONSTRAINT operators_are_not_their_own_creator
    CHECK (created_by IS NULL OR created_by <> id);

-- **The one transaction-local capability this file adds**, in the exact shape
-- of `app.account_custody` (`0013` §A) and `app.key_custody` (`0010` §F):
-- `app.operator_custody` is set by `src/operators.rs` and by nothing else, for
-- the length of one transaction that does operator work. Every other
-- transaction in this server -- every design read, every authority act, every
-- repository call -- reaches zero rows in the tables below.
--
-- **It is not a defence against the application lying about which operator is
-- acting.** Nothing at the policy layer could be. That defence is the row
-- seal, the session row's MAC and the request signature, and none of them is
-- gated by this setting.
--
-- `operators` keeps `0005`'s `FOR SELECT TO fathom_operator` policy untouched:
-- the read-only operator pool is how the console reads the register, and these
-- policies are how the application plane writes it.
DROP POLICY IF EXISTS operators_readable_by_application ON operators;
CREATE POLICY operators_readable_by_application ON operators
    FOR SELECT
    USING (
        current_setting('app.operator_custody', true) = 'yes'
        -- Sign-in resolves an operator before any operator context exists, in
        -- the session-custody transaction `0013` §E defines. Same branch, same
        -- argument as `accounts_readable` gained in `0013` §A.
        OR current_setting('app.session_custody', true) = 'yes'
        -- And REDEMPTION, which has no session at all: an operator redeeming
        -- their first enrolment token has to be checked against their own row
        -- -- a disabled operator does not enrol a key, and a token issued
        -- before the disabling must not outlive it. It is a read of one row
        -- the caller already named by holding its token.
        OR current_setting('app.enrolment_custody', true) = 'yes'
    );

DROP POLICY IF EXISTS operators_insertable_by_application ON operators;
CREATE POLICY operators_insertable_by_application ON operators
    FOR INSERT
    WITH CHECK (current_setting('app.operator_custody', true) = 'yes');

DROP POLICY IF EXISTS operators_updatable_by_application ON operators;
CREATE POLICY operators_updatable_by_application ON operators
    FOR UPDATE
    USING (
        current_setting('app.operator_custody', true) = 'yes'
        OR current_setting('app.session_custody', true) = 'yes'
    )
    WITH CHECK (
        current_setting('app.operator_custody', true) = 'yes'
        OR current_setting('app.session_custody', true) = 'yes'
    );

-- No DELETE policy and no DELETE privilege: an operator register that can be
-- emptied is an audit trail with a hole where the actor used to be. Disabling
-- is `disabled_at`, and it is append-only in effect because nothing un-sets it
-- (§4.5: an operator who loses their authenticators is re-enrolled through
-- §5.4's machinery, not re-enabled by a form).
REVOKE UPDATE, DELETE ON operators FROM fathom_app;
GRANT UPDATE (created_by, created_seq, first_independent_signin_at, disabled_at,
              row_version, row_seal) ON operators TO fathom_app;

-- ---------------------------------------------------------------------------
-- B. THE OPERATOR KEYRING -- §4.5's FACTOR, AND THE TABLE 0013 SAID DID NOT
--    EXIST
--
-- `account_keys`' shape (`0011` §B), with `operator` where `steward` was. The
-- two fences are the same two: the operator must exist, AND the principal it
-- names must be an operator. The second is the one that binds if a later
-- migration ever relaxes the first -- and it is what makes "an account key and
-- an operator key are different things" true in the schema rather than in a
-- comment.
--
-- **Why a second table rather than a column on `account_keys`.** A shared
-- table would need its `principal_kind` fence relaxed to admit both kinds, and
-- that fence is what stops an operator id appearing where a steward's belongs.
-- §0's whole vocabulary exists to keep the two custodies apart; the keyring is
-- where a mix-up would be worth the most to an attacker.
--
-- `retired_at` is here and nothing writes it yet: it is inside the row seal,
-- so adding it later would mean re-sealing every row. Supersession (§8.4) is
-- NOT here -- `superseded_by` and `succession_sig` are absent rather than
-- stubbed, because no path signs a succession for an operator key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operator_keys (
    id             text        PRIMARY KEY CHECK (char_length(id) = 26),

    operator_id    text        NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
    principal_kind text        GENERATED ALWAYS AS ('operator') STORED,

    key_source     text        NOT NULL CHECK (key_source IN ('software', 'authenticator')),
    credential_id  bytea       UNIQUE,
    public_key     bytea       NOT NULL,
    alg            smallint    NOT NULL CHECK (alg = 1),
    fpr            bytea       NOT NULL UNIQUE CHECK (octet_length(fpr) = 32),

    enrolled_seq   bigint      NOT NULL CHECK (enrolled_seq >= 1),
    enrolled_at    timestamptz NOT NULL DEFAULT now(),
    retired_at     timestamptz,

    row_version    integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal       bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    CHECK ((key_source = 'authenticator') = (credential_id IS NOT NULL)),
    -- A software ES256 key is a SEC1 uncompressed point. An authenticator's is
    -- a COSE_Key, whose shape this build does not parse and does not pretend
    -- to (§15.4).
    CHECK (key_source <> 'software'
           OR (octet_length(public_key) = 65 AND get_byte(public_key, 0) = 4)),

    FOREIGN KEY (operator_id, principal_kind) REFERENCES principals (id, kind)
);

CREATE INDEX IF NOT EXISTS operator_keys_operator_idx ON operator_keys (operator_id);

-- ---------------------------------------------------------------------------
-- B2. THE ONE CORRECTION THIS FILE MAKES TO 0013's SCHEMA
--
-- **This section was rewritten on 2026-09-14, editing this file in place after
-- it had already been applied.** That is not licence to edit an applied
-- migration, and the checksum gate still refuses one: the exception holds only
-- because `0015` was written the same day, has never shipped, and existed only
-- in databases `cargo test` creates and drops. A file that has run anywhere
-- real is immutable, and the next correction to this one is `0016`.
--
-- # What was wrong
--
-- `0013` gave `sessions.evidence_key_id` a foreign key to `account_keys(id)`,
-- which was exactly right on the day it was written: the only keyring in the
-- schema was the account one, and §4.5 meant an operator session could not
-- exist. Section B adds a second keyring, so that foreign key started refusing
-- a legitimate insert -- an operator's session names the key that proved it,
-- and that key is in `operator_keys`.
--
-- The first attempt dropped the foreign key and replaced it with a
-- `SECURITY DEFINER` trigger that looked the id up in whichever keyring the
-- row's `principal_kind` named. **That trigger was not an integrity constraint,
-- and this paragraph is kept so that nobody rebuilds it.** `SECURITY DEFINER`
-- runs the body as the function's OWNER, and the owner here is the migration
-- role, which is deliberately `NOSUPERUSER` and therefore subject to the
-- `FORCE ROW LEVEL SECURITY` on both keyrings. So the body asked *"is this key
-- visible to me in this transaction"* and not *"does this key exist"*, and the
-- answer moved with whichever GUCs the writing transaction happened to hold.
--
-- Three tests in `tests/sessions.rs` failed on it, all of them writing a
-- session row as the bootstrap superuser -- who bypasses row security, but
-- whose privileges the definer's body does not run with. Those failures were
-- the visible half. The invisible half was worse: the trigger fired
-- `BEFORE INSERT OR UPDATE`, so every request-counter advance and every sweep
-- re-ran the check, and any of them running outside a custody transaction
-- would have been refused in production for a reason having nothing to do with
-- the data.
--
-- # What replaces it, and why it is absolute
--
-- Two columns, each with a real foreign key, and a `CHECK` tying each to the
-- principal kind that may use it. **Referential integrity is enforced by the
-- system and does not go through row security**, so the answer is the same for
-- every caller whatever GUCs are set -- which is the property the trigger lost
-- and the whole reason a foreign key is worth restructuring a column for.
--
-- That property was measured on this PostgreSQL rather than taken from memory
-- (CLAUDE.md rule 1). As the non-superuser owner, against a `FORCE ROW LEVEL
-- SECURITY` table whose policy made every row invisible to it:
--
--     rows visible to the owner                                 0
--     INSERT naming a row that exists but is invisible    ACCEPTED
--     INSERT naming a row that does not exist              REFUSED
--
-- `0013`'s foreign key is therefore NOT dropped; a second one is added beside
-- it. The application still reads and writes ONE value -- `SessionRow`'s
-- `evidence_key_id` is unchanged, and so is `session_row_state`, so the MAC
-- covers exactly the bytes it did before and `tests/session_vectors.rs` pins
-- the same vectors. What changed is which column that one value rests in.
--
-- # What it costs
--
--   * A wider row: one text column that is `NULL` for every session on the
--     other plane. `sessions` is small and short-lived.
--   * `read_session` coalesces the two columns, so a reader has to know that.
--     The `CHECK`s below are what make the coalesce unambiguous: at most one is
--     ever set, because a row has exactly one `principal_kind`.
--   * A polymorphic reference cannot be a single foreign key, so anything that
--     later wants "the evidence key, whichever plane it is on" as one joinable
--     column wants a view over these two and not a third column.
--
-- What is GAINED over both the trigger and the original foreign key: an
-- operator session's evidence key is under referential integrity too, which it
-- never was -- the trigger only approximated it, and `0013` could not express
-- it at all.
-- ---------------------------------------------------------------------------

-- The failed attempt, removed.
--
-- **A database that applied the draft cannot reach this line**: the checksum
-- gate sees a file whose bytes have changed and refuses to go on, which is
-- exactly what it is for. Such a database is dropped and rebuilt, and only
-- disposable test databases ever held one. The guards here are therefore not a
-- repair path -- they are what makes every statement in this section safe to
-- run in any order against a database arriving from `0014`, where the trigger
-- never existed and the foreign key still does.
DROP TRIGGER IF EXISTS sessions_evidence_key_exists ON sessions;
DROP FUNCTION IF EXISTS fathom_session_evidence_key_exists();

-- `0013`'s foreign key, under the name PostgreSQL generated for it. The guard
-- finds it already present on a database arriving from `0014` and does nothing.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'sessions'::regclass
           AND contype = 'f'
           AND conname = 'sessions_evidence_key_id_fkey'
    ) THEN
        ALTER TABLE sessions
            ADD CONSTRAINT sessions_evidence_key_id_fkey
            FOREIGN KEY (evidence_key_id) REFERENCES account_keys(id) ON DELETE RESTRICT;
    END IF;
END
$$;

-- The operator plane's half of the same fact.
ALTER TABLE sessions
    ADD COLUMN evidence_operator_key_id text
        REFERENCES operator_keys(id) ON DELETE RESTRICT;

-- **One row, one plane, one evidence column.** Without these a session row
-- could name a key in each keyring at once and `read_session`'s coalesce would
-- pick one arbitrarily; with them, the column that is set is the one the row's
-- own `principal_kind` allows and the other is `NULL`.
ALTER TABLE sessions
    ADD CONSTRAINT sessions_account_evidence_is_a_steward_session
        CHECK (evidence_key_id IS NULL OR principal_kind = 'steward'),
    ADD CONSTRAINT sessions_operator_evidence_is_an_operator_session
        CHECK (evidence_operator_key_id IS NULL OR principal_kind = 'operator');

-- No new grant is needed and none is given: `0006` grants `INSERT` on the table
-- rather than per column, so the new column is writable on insert -- and
-- `0013`'s `REVOKE UPDATE ON sessions` with
-- `GRANT UPDATE (last_seen_at, request_counter)` still means `fathom_app` can
-- never rewrite either evidence column after the insert. Both foreign keys are
-- therefore checked exactly once, when the session is created, and no
-- request-time statement can touch them.

-- ---------------------------------------------------------------------------
-- C. THE INSTALL RECORD -- §6.2's ADDRESS NO ROLE CAN REWRITE
--
-- §6.2: an organisation shell's enrolment claim is *"pinned to an install-time
-- `notice_address` recorded in `site_install` at first start, which no role can
-- `UPDATE` -- the column has no `UPDATE` privilege for any role and a trigger
-- raises on any attempt. This is the one piece taken from a competing design's
-- weakest point rather than its strongest: that design let an operator reseat
-- an organisation using a channel and a PIN both inside the operator plane."*
--
-- Both halves are here: no `UPDATE` privilege for any role, and a trigger that
-- refuses `UPDATE`, `DELETE` and `TRUNCATE` at every privilege level a trigger
-- can reach. One row, enforced by a primary key with one legal value.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_install (
    id             text        PRIMARY KEY CHECK (id = 'install'),
    notice_address text        NOT NULL CHECK (char_length(notice_address) BETWEEN 3 AND 320),
    installed_seq  bigint      NOT NULL CHECK (installed_seq >= 1),
    installed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION fathom_site_install_is_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION
        'the install record is written once and never changed: % on % is refused (admin design 6.2)',
        TG_OP, TG_TABLE_NAME;
END
$fn$;

DROP TRIGGER IF EXISTS site_install_immutable ON site_install;
CREATE TRIGGER site_install_immutable
    BEFORE UPDATE OR DELETE ON site_install
    FOR EACH ROW EXECUTE FUNCTION fathom_site_install_is_immutable();

DROP TRIGGER IF EXISTS site_install_no_truncate ON site_install;
CREATE TRIGGER site_install_no_truncate
    BEFORE TRUNCATE ON site_install
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_site_install_is_immutable();

-- ---------------------------------------------------------------------------
-- D. ORGANISATION SHELLS -- §6.2
--
-- **A shell is NOT a row in `organisations`, and that is a decision the design
-- does not make for us.** §6.2 calls a shell *"a row with a name, no genesis,
-- and an enrolment claim"*, while §6.1 derives the organisation's id from its
-- root public key -- which does not exist until the claim is redeemed in a
-- browser. A shell row in `organisations` would therefore have to carry an id
-- that the genesis it is waiting for cannot produce, and the choice at
-- redemption would be to rewrite the id (breaking every foreign key and the
-- derivation) or to keep it (breaking §3.4 step 5, which recomputes the id
-- from the root key at every authorisation).
--
-- So the shell is its own row, and redeeming its claim runs §6.1's genesis
-- unchanged: a NEW organisation with the derived id, created by the account
-- that redeemed. The shell then names it, permanently, which is what makes
-- §6.2's *"this organisation was bootstrapped by operator X on date D"*
-- renderable for ever.
--
-- **The residual §6.2 names is unchanged and is not closed by any of this:**
-- an operator who controls the notice channel for a shell they created can
-- redeem it themselves and become its genesis steward. The organisation is
-- empty; it gives them nothing anywhere else, because every existing
-- organisation's genesis is bound to a key that already exists and an id
-- already derived from it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organisation_shells (
    id              text        PRIMARY KEY CHECK (char_length(id) = 26),
    display_name    text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),

    created_by      text        NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
    created_seq     bigint      NOT NULL CHECK (created_seq >= 1),
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- The organisation genesis produced, once the claim was redeemed.
    organisation_id text        REFERENCES organisations(id) ON DELETE RESTRICT,
    redeemed_at     timestamptz,
    redeemed_seq    bigint,

    row_version     integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal        bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    CHECK ((organisation_id IS NULL) = (redeemed_at IS NULL)),
    CHECK ((redeemed_at IS NULL) = (redeemed_seq IS NULL))
);

-- ---------------------------------------------------------------------------
-- E. ENROLMENT TOKENS -- §1.1, §5.1, §6.2, §6.3, §7.2
--
-- One table, three purposes, distinguished by a column rather than by three
-- tables, because the lifecycle is identical and `session_nonces` already
-- establishes the shape:
--
--   * `account`      -- §1.1's *"initiate an authenticator-enrolment token"*
--                       and §5.1's reset, **which are the same path**: there
--                       is no password, so "reset" is "enrol a key again".
--   * `operator`     -- §5.5's *"a first sign-in that must register an
--                       authenticator"*, for an operator the interlock created.
--   * `organisation` -- §6.2's enrolment claim, pinned to `site_install`.
--
-- **Single use is a guarded UPDATE inside the row seal, not a DELETE and not a
-- bare flag.** `session_nonces` spends a nonce with `DELETE ... RETURNING` and
-- `0013` §C gives the argument: a flag is one `UPDATE` from being false. That
-- argument is answered here rather than ignored:
--
--   * `UPDATE ... WHERE redeemed_at IS NULL RETURNING` is atomic against a
--     concurrent second redemption in exactly the way the DELETE is -- the row
--     is locked by the first writer and the second sees no row.
--   * `redeemed_at` is **inside the row seal**, which is recomputed under a
--     key that is not in PostgreSQL. Clearing the flag to re-open a spent
--     token leaves a row whose seal does not verify, and an unverifiable token
--     is refused. That is strictly stronger than a delete, which leaves
--     nothing to verify and no record that the token ever existed.
--
-- **No address column.** An account token resolves its address through
-- `accounts.email`, and an organisation claim through `site_install`. Storing
-- a second copy would mean a second place for the two to disagree, and the
-- rule that a token for one address cannot enrol a key for another is
-- enforced against the row that owns the address rather than against a copy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrolment_tokens (
    id           text        PRIMARY KEY CHECK (char_length(id) = 26),
    purpose      text        NOT NULL CHECK (purpose IN ('account', 'operator', 'organisation')),

    -- `H(LP("fathom/enrolment/token/v1") || LP(token))`. The token itself is
    -- returned once and never stored: a database read hands an attacker the
    -- hash and nothing they can redeem.
    token_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),

    account_id   text        REFERENCES accounts(id) ON DELETE RESTRICT,
    operator_id  text        REFERENCES operators(id) ON DELETE RESTRICT,
    shell_id     text        REFERENCES organisation_shells(id) ON DELETE RESTRICT,

    issued_by    text        NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
    issued_seq   bigint      NOT NULL CHECK (issued_seq >= 1),
    issued_at    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,

    redeemed_at  timestamptz,
    redeemed_seq bigint,
    expired_at   timestamptz,
    expired_seq  bigint,

    row_version  integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal     bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    CHECK ((purpose = 'account')      = (account_id  IS NOT NULL)),
    CHECK ((purpose = 'operator')     = (operator_id IS NOT NULL)),
    CHECK ((purpose = 'organisation') = (shell_id    IS NOT NULL)),
    CHECK ((redeemed_at IS NULL) = (redeemed_seq IS NULL)),
    CHECK ((expired_at  IS NULL) = (expired_seq  IS NULL)),
    CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS enrolment_tokens_expiry_idx ON enrolment_tokens (expires_at);
CREATE INDEX IF NOT EXISTS enrolment_tokens_account_idx ON enrolment_tokens (account_id);

-- ---------------------------------------------------------------------------
-- F. SITE SETTINGS -- §5.3, AND THE INTERLOCK IN §5.4
--
-- §5.3's table, with three departures, each stated:
--
--   1. **`effective_receipt_id` is absent rather than stubbed.** §5.3 gives it
--      `REFERENCES chain_receipts(id)` and §5.4 step 4 checks it. There is no
--      `chain_receipts` table in this schema -- `0009`'s own header says
--      receipts and the witness *"are absent from this migration and absent on
--      purpose"* -- so the column would reference nothing and the check would
--      be a line that always passes. **§5.4 step 4 is therefore NOT enforced
--      by this build**, which is a real gap and is reported as one rather than
--      papered over: the delay is measured against this server's clock, not
--      against a party the delay protects.
--   2. **The ciphertext's framing is three columns, not one.** `value_ct` is
--      an AEAD blob and needs its nonce and its key epoch beside it to be
--      openable at all; §5.3's single column presumes framing it does not
--      describe. `value_digest` is `H(value_ct)` exactly as §5.4 step 2 wants,
--      and is what the sealed entry carries.
--   3. **`single_operator` is a column on the row, not only a startup entry.**
--      §5.3 puts `single_operator_mode` on the site chain at every startup;
--      that says what the deployment claimed, and this says what THIS change
--      was decided under. Without it, a reader of the table cannot tell a
--      change that had two operators behind it from one that did not.
--
-- `sealed_seq` is the interlock. **No administrative change takes effect while
-- it is NULL, and nothing reachable from the operator surface can stamp it**:
-- it is written by `src/operators.rs` in the same transaction that appends the
-- `setting_applied` entry, using a chain key the operator plane has no path to
-- and that is not in PostgreSQL at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_settings_versions (
    id              text        PRIMARY KEY CHECK (char_length(id) = 26),
    key             text        NOT NULL CHECK (char_length(key) BETWEEN 1 AND 64),

    value_ct        bytea       NOT NULL,
    value_nonce     bytea       NOT NULL CHECK (octet_length(value_nonce) = 12),
    value_key_epoch integer     NOT NULL CHECK (value_key_epoch >= 1),
    value_digest    bytea       NOT NULL CHECK (octet_length(value_digest) = 32),

    requested_by    text        NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
    request_sig     bytea       NOT NULL CHECK (octet_length(request_sig) = 64),
    requested_seq   bigint      NOT NULL CHECK (requested_seq >= 1),
    requested_at    timestamptz NOT NULL DEFAULT now(),

    seconded_by     text        REFERENCES operators(id) ON DELETE RESTRICT,
    second_sig      bytea       CHECK (second_sig IS NULL OR octet_length(second_sig) = 64),
    seconded_seq    bigint,

    single_operator boolean     NOT NULL DEFAULT false,

    effective_at    timestamptz NOT NULL,
    cancelled_at    timestamptz,
    cancelled_seq   bigint,
    applied_at      timestamptz,
    sealed_seq      bigint,

    -- §5.4 step 5: a candidate that fails a check is **not** silently skipped
    -- — it raises `setting_unresolvable` as an incident. This pair is the
    -- latch that makes that once per row rather than once per read, on
    -- `0014` §B's argument: an entry appended on every read is an amplifier.
    --
    -- **Deliberately NOT inside the row seal.** It is a marker ABOUT the row
    -- made by a later reader, not a claim BY the row, and re-sealing a row
    -- whose seal has just failed to verify would be the store agreeing with
    -- itself about an alarm.
    unresolvable_at  timestamptz,
    unresolvable_seq bigint,

    row_version     integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal        bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    CHECK ((unresolvable_at IS NULL) = (unresolvable_seq IS NULL)),

    -- §5.5: this tests that two ids differ, not that two humans acted. The
    -- trigger in section G is the rest of the rule.
    CHECK (seconded_by IS NULL OR seconded_by <> requested_by),
    CHECK ((seconded_by IS NULL) = (second_sig IS NULL)),
    CHECK ((seconded_by IS NULL) = (seconded_seq IS NULL)),
    CHECK ((cancelled_at IS NULL) = (cancelled_seq IS NULL)),
    -- The interlock, stated in the schema as well as in the code: applied and
    -- unsealed is not a state this table can hold.
    CHECK ((applied_at IS NULL) = (sealed_seq IS NULL)),
    -- A change that was cancelled was never applied. Both at once is not a
    -- history, it is a contradiction.
    CHECK (cancelled_at IS NULL OR applied_at IS NULL),
    -- Single-operator mode removes the second signature and KEEPS the delay
    -- (§5.3). A row that claims both a seconder and single-operator mode is
    -- claiming two different reasons for the same change.
    CHECK (NOT single_operator OR seconded_by IS NULL)
);

CREATE INDEX IF NOT EXISTS site_settings_versions_key_idx
    ON site_settings_versions (key, applied_at);

-- §5.5: **operator creation is itself routed through this machinery** -- two
-- existing operator assertions, the delay, sealed, and a first sign-in that
-- must register an authenticator. The same shape as a setting change, because
-- it is the same control; a separate table rather than a `kind` column on the
-- one above, because the two carry different payloads and a nullable column
-- per payload is how a schema stops saying what it means.
--
-- The earlier draft's `GRANT INSERT ON operators TO fathom_admin` made minting
-- a colleague a form submission that looked exactly like onboarding. There is
-- no such grant anywhere in this schema: `operators` is written by the
-- application plane, under `app.operator_custody`, and only after a row here
-- has been applied and sealed.
CREATE TABLE IF NOT EXISTS operator_requests (
    id              text        PRIMARY KEY CHECK (char_length(id) = 26),
    display_name    text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),

    requested_by    text        NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
    request_sig     bytea       NOT NULL CHECK (octet_length(request_sig) = 64),
    requested_seq   bigint      NOT NULL CHECK (requested_seq >= 1),
    requested_at    timestamptz NOT NULL DEFAULT now(),

    seconded_by     text        REFERENCES operators(id) ON DELETE RESTRICT,
    second_sig      bytea       CHECK (second_sig IS NULL OR octet_length(second_sig) = 64),
    seconded_seq    bigint,

    single_operator boolean     NOT NULL DEFAULT false,

    effective_at    timestamptz NOT NULL,
    cancelled_at    timestamptz,
    cancelled_seq   bigint,
    applied_at      timestamptz,
    sealed_seq      bigint,
    created_operator_id text    REFERENCES operators(id) ON DELETE RESTRICT,

    row_version     integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal        bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    CHECK (seconded_by IS NULL OR seconded_by <> requested_by),
    CHECK ((seconded_by IS NULL) = (second_sig IS NULL)),
    CHECK ((seconded_by IS NULL) = (seconded_seq IS NULL)),
    CHECK ((cancelled_at IS NULL) = (cancelled_seq IS NULL)),
    CHECK ((applied_at IS NULL) = (sealed_seq IS NULL)),
    CHECK ((applied_at IS NULL) = (created_operator_id IS NULL)),
    CHECK (cancelled_at IS NULL OR applied_at IS NULL),
    CHECK (NOT single_operator OR seconded_by IS NULL)
);

-- §1.1's first verb writes `operator_read` *"sampled: one entry per session per
-- surface"*. This table is that sample's latch, in the shape `0014` §B uses
-- for the anonymous sign-in latch and for the same reason: without it, a
-- caller chooses how fast this deployment's sealed audit grows.
--
-- **The latch is taken BEFORE the entry is appended**, which is why it carries
-- no `chain_seq`: `INSERT ... ON CONFLICT DO NOTHING RETURNING` is what decides
-- whether this is the read that records itself, and it has to decide before
-- there is a sequence number to record. Both are in one transaction, so a
-- handler that fails leaves neither.
CREATE TABLE IF NOT EXISTS operator_read_samples (
    session_id text        NOT NULL CHECK (char_length(session_id) = 26),
    surface    text        NOT NULL CHECK (char_length(surface) BETWEEN 1 AND 64),
    at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, surface)
);

-- ---------------------------------------------------------------------------
-- G. WHO MAY SECOND -- §5.5, AS A TRIGGER AND NOT AS A COMMENT
--
-- §5.5: *"`CHECK (seconded_by <> requested_by)` tests that two ids differ, not
-- that two humans acted. A `SECURITY DEFINER` trigger (owned by the audit
-- role, `search_path` pinned, because a plain trigger function runs as the
-- invoker and would read `operators` through row security and pass vacuously)
-- enforces the rest."*
--
-- Three of §5.5's four conditions are here, because they are facts about rows:
--
--   * the seconder was not created by the requester;
--   * the seconder has an independent sign-in on record;
--   * that sign-in is older than the longest delay window in force.
--
-- The fourth -- *"the seconder's `second_sig` is a fresh assertion over
-- H(change digest)"* -- is a signature and is verified in `src/operators.rs`
-- before the row is written. A trigger cannot verify ES256 without a
-- cryptographic extension this deployment does not have, and pretending
-- otherwise would be worse than saying where the check lives.
--
-- **`SECURITY DEFINER` with the search path pinned**, on `0011` §2's named
-- trap: a trigger function that reads a row-level-security-protected table
-- must be `SECURITY DEFINER` with a pinned `search_path`, or it runs as the
-- invoker, sees nothing, and passes vacuously. `operators` is behind `FORCE
-- ROW LEVEL SECURITY` and its read policies are capability-gated, so a plain
-- trigger would read zero rows and admit every seconder.
--
-- Seven days is §5.5's stated default for "the longest delay window in force".
-- It is a literal here rather than a setting, because a settable independence
-- window is a setting an operator could change through the very machinery this
-- rule protects.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fathom_seconder_is_independent() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
    seconder_created_by text;
    seconder_first_signin timestamptz;
    seconder_disabled timestamptz;
BEGIN
    IF NEW.seconded_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT created_by, first_independent_signin_at, disabled_at
      INTO seconder_created_by, seconder_first_signin, seconder_disabled
      FROM operators WHERE id = NEW.seconded_by;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'the seconder is not an operator (admin design 5.5)';
    END IF;

    IF seconder_disabled IS NOT NULL THEN
        RAISE EXCEPTION 'a disabled operator cannot second (admin design 5.5)';
    END IF;

    IF seconder_created_by IS NOT NULL AND seconder_created_by = NEW.requested_by THEN
        RAISE EXCEPTION
            'the seconder was created by the requester, so two ids are not two humans '
            '(admin design 5.5)';
    END IF;

    IF seconder_first_signin IS NULL THEN
        RAISE EXCEPTION
            'the seconder has no independent sign-in on record (admin design 5.5)';
    END IF;

    IF seconder_first_signin > now() - interval '7 days' THEN
        RAISE EXCEPTION
            'the seconder''s first independent sign-in is newer than the longest delay window '
            'in force (admin design 5.5)';
    END IF;

    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS site_settings_versions_seconder ON site_settings_versions;
CREATE TRIGGER site_settings_versions_seconder
    BEFORE INSERT OR UPDATE ON site_settings_versions
    FOR EACH ROW EXECUTE FUNCTION fathom_seconder_is_independent();

DROP TRIGGER IF EXISTS operator_requests_seconder ON operator_requests;
CREATE TRIGGER operator_requests_seconder
    BEFORE INSERT OR UPDATE ON operator_requests
    FOR EACH ROW EXECUTE FUNCTION fathom_seconder_is_independent();

-- ---------------------------------------------------------------------------
-- H. ROW-LEVEL SECURITY
--
-- Forced on every new table. **Every policy names its command and none is
-- `FOR ALL`** -- `0003`'s bug, restated on every migration that writes a
-- policy because it is the one that got through: a `FOR ALL` policy's `USING`
-- expression is silently reused by PostgreSQL as the `WITH CHECK` for every
-- write.
--
-- The predicate is `app.operator_custody`, for the reason `0013` §E gives for
-- `app.session_custody`: none of these tables is organisation-scoped, so there
-- is no tenant id for a policy to compare against, and a policy comparing
-- against a value the caller supplied is what `repo.rs` says a policy must
-- never be.
--
-- **Two capabilities, not one, and the split is the point.**
-- `app.operator_custody` is the console: an operator session has been verified
-- and the transaction is doing operator work. `app.enrolment_custody` is a
-- REDEMPTION: an invited person arrives holding a token and no session at all,
-- because the whole purpose of the act is to give them the key a session would
-- need. Sharing one capability between the two would mean the unauthenticated
-- redemption path could reach every table the console can write.
--
-- What redemption reaches is exactly: the token (to spend it), the shell it
-- names, the install record (to check the claim's pinned address), and the two
-- keyrings (to write the key). The fence on redemption is the token hash, the
-- expiry, the address and the seal -- never the policy, which cannot tell one
-- caller from another.
--
-- **`app.session_custody` appears on two of these tables**, and only where
-- sign-in needs it: an operator's sign-in resolves the operator row and its
-- key inside `0013` §E's verification transaction, which is the one
-- transaction shape that exists before any custody has been established.
-- ---------------------------------------------------------------------------
ALTER TABLE operator_keys           ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_keys           FORCE  ROW LEVEL SECURITY;
ALTER TABLE site_install            ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_install            FORCE  ROW LEVEL SECURITY;
ALTER TABLE organisation_shells     ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_shells     FORCE  ROW LEVEL SECURITY;
ALTER TABLE enrolment_tokens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrolment_tokens        FORCE  ROW LEVEL SECURITY;
ALTER TABLE site_settings_versions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_settings_versions  FORCE  ROW LEVEL SECURITY;
ALTER TABLE operator_requests       ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_requests       FORCE  ROW LEVEL SECURITY;
ALTER TABLE operator_read_samples   ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_read_samples   FORCE  ROW LEVEL SECURITY;

-- An operator key is read at sign-in (session custody) and written at
-- enrolment (redemption, also session custody) and by the operator console
-- (operator custody).
CREATE POLICY operator_keys_readable ON operator_keys
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes'
                      OR current_setting('app.session_custody', true) = 'yes');
CREATE POLICY operator_keys_insertable ON operator_keys
    FOR INSERT WITH CHECK (current_setting('app.enrolment_custody', true) = 'yes');

-- Read by anything that needs the notice address; written once, at install.
-- No UPDATE policy, no DELETE policy, and the trigger above as well.
CREATE POLICY site_install_readable ON site_install
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes'
                      OR current_setting('app.enrolment_custody', true) = 'yes');
-- Written by §6.3's bootstrap, which holds operator custody. **Not** by the
-- redemption path: an unauthenticated caller must not be able to write the one
-- address §6.2's whole pin rests on.
CREATE POLICY site_install_insertable ON site_install
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');

CREATE POLICY organisation_shells_readable ON organisation_shells
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes'
                      OR current_setting('app.enrolment_custody', true) = 'yes');
CREATE POLICY organisation_shells_insertable ON organisation_shells
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY organisation_shells_updatable ON organisation_shells
    FOR UPDATE USING (current_setting('app.enrolment_custody', true) = 'yes')
            WITH CHECK (current_setting('app.enrolment_custody', true) = 'yes');

CREATE POLICY enrolment_tokens_readable ON enrolment_tokens
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes'
                      OR current_setting('app.enrolment_custody', true) = 'yes');
-- **Issuing is the console's, redeeming is not.** Every token this schema ever
-- holds was written by a transaction with a verified operator session behind
-- it; the redemption path may read one and spend one and may not mint one,
-- which is `docs/OPEN-QUESTIONS.md` B5 -- nobody self-registers -- expressed at
-- the policy layer.
CREATE POLICY enrolment_tokens_insertable ON enrolment_tokens
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY enrolment_tokens_updatable ON enrolment_tokens
    FOR UPDATE USING (current_setting('app.enrolment_custody', true) = 'yes')
            WITH CHECK (current_setting('app.enrolment_custody', true) = 'yes');

CREATE POLICY site_settings_versions_readable ON site_settings_versions
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY site_settings_versions_insertable ON site_settings_versions
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY site_settings_versions_updatable ON site_settings_versions
    FOR UPDATE USING (current_setting('app.operator_custody', true) = 'yes')
            WITH CHECK (current_setting('app.operator_custody', true) = 'yes');

CREATE POLICY operator_requests_readable ON operator_requests
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY operator_requests_insertable ON operator_requests
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY operator_requests_updatable ON operator_requests
    FOR UPDATE USING (current_setting('app.operator_custody', true) = 'yes')
            WITH CHECK (current_setting('app.operator_custody', true) = 'yes');

CREATE POLICY operator_read_samples_readable ON operator_read_samples
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY operator_read_samples_insertable ON operator_read_samples
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY operator_read_samples_deletable ON operator_read_samples
    FOR DELETE USING (current_setting('app.operator_custody', true) = 'yes');

-- ---------------------------------------------------------------------------
-- I. PRIVILEGES -- WHAT THE RUNTIME ROLE DOES NOT GET, AND WHAT THE OPERATOR
--    PLANE DOES NOT GET AT ALL
--
-- `0006`'s default privileges hand `fathom_app` all four verbs on every table
-- the migration role creates. Each narrowing below is at the privilege layer,
-- which is checked BEFORE row security and before any policy expression
-- anyone could get wrong (§0's fence table).
--
-- **`fathom_operator` is granted nothing on any table in this file**, and no
-- default privilege gives it any. §1.3: *"the admin pool is read-only. Every
-- administrative write goes through an application endpoint on the application
-- role, which writes the row and its chain entry in one transaction."*
-- `tests/planes.rs` asserts the operator plane's readable set off the live
-- database on every run, so a grant added here would fail that test rather
-- than pass unnoticed.
-- ---------------------------------------------------------------------------

-- A keyring row is written once. Nothing supersedes or retires an operator key
-- yet, so nothing updates one; taking the privilege back when that lands is a
-- migration somebody has to write down (`0013` §F's rule).
REVOKE UPDATE, DELETE ON operator_keys FROM fathom_app;

-- The install record: written once, never changed, never removed. The trigger
-- says the same thing a second time.
REVOKE UPDATE, DELETE ON site_install FROM fathom_app;

-- A shell is written once and then names the organisation its claim produced.
REVOKE UPDATE, DELETE ON organisation_shells FROM fathom_app;
GRANT UPDATE (organisation_id, redeemed_at, redeemed_seq, row_version, row_seal)
    ON organisation_shells TO fathom_app;

-- A token is issued once, and then either redeemed or expired. Nothing else
-- about it may change, and nothing deletes one -- a deleted token is a
-- redemption nobody can account for.
REVOKE UPDATE, DELETE ON enrolment_tokens FROM fathom_app;
GRANT UPDATE (redeemed_at, redeemed_seq, expired_at, expired_seq, row_version, row_seal)
    ON enrolment_tokens TO fathom_app;

-- A settings version is requested once. Seconding, cancelling and applying are
-- the only transitions, and `sealed_seq` is one of the columns they write --
-- the interlock is not protected by withholding the column but by the fact
-- that stamping it requires appending a sealed entry under a key that is not
-- in this database.
REVOKE UPDATE, DELETE ON site_settings_versions FROM fathom_app;
GRANT UPDATE (seconded_by, second_sig, seconded_seq, cancelled_at, cancelled_seq,
              applied_at, sealed_seq, unresolvable_at, unresolvable_seq,
              row_version, row_seal)
    ON site_settings_versions TO fathom_app;

REVOKE UPDATE, DELETE ON operator_requests FROM fathom_app;
GRANT UPDATE (seconded_by, second_sig, seconded_seq, cancelled_at, cancelled_seq,
              applied_at, sealed_seq, created_operator_id, row_version, row_seal)
    ON operator_requests TO fathom_app;

-- The read-sample latch is per session and dies with it. DELETE stays so the
-- table pays for its own growth on the write path (`0014` §C's rule).
REVOKE UPDATE ON operator_read_samples FROM fathom_app;

-- ---------------------------------------------------------------------------
-- J. THE ENTRY TYPES THIS FILE'S ACTS WRITE (§7.2)
--
-- Extended by `DROP CONSTRAINT` then `ADD CONSTRAINT`, wrapped in the
-- invariant-11 `NO FORCE` / `FORCE` pair -- the path `0010` §C documents and
-- `0011` §K, `0013` §G and `0014` §E follow. `ADD CONSTRAINT ... CHECK`
-- re-validates every row already in `chain_entries`, and that validating scan
-- is a read of a table behind `FORCE ROW LEVEL SECURITY`, which with no tenant
-- context returns zero rows SILENTLY. **On an empty database the difference is
-- invisible.** The pair is LOAD-BEARING and must not be tidied away.
--
-- Every type below is §7.2's own, with two exceptions, both reported to the
-- lead rather than quietly added:
--
--   * `operator_signed_out` -- §7.2 names `account_signed_out` (added
--     2026-09-14) and no operator equivalent. An operator sign-out could have
--     been filed as `account_signed_out` with `principal_kind = 'operator'` in
--     its sealed metadata, and that is what `0014`'s code did; but the site
--     chain's entry TYPE is the one field a reader can group by without
--     holding the metadata key, and an operator's acts must be legible as
--     operator acts to someone holding only the chain key. §7.2 needs the row.
--   * `operator_read` -- §1.1's first verb names it and §7.2's list does not.
--     Same gap `0013` §G reported for `account_signin`: §7.2 was written
--     before §1.1's sampling rule.
--
-- `authenticator_removed`, `contact_change_*`, `backup_taken`,
-- `restore_performed`, `migration_applied`, `verification_run`,
-- `password_changed` and `reset_link_sent` are §7.2's and are deliberately
-- ABSENT: nothing in this build emits them, and an entry type nothing emits is
-- a name in a `CHECK` constraint pretending to be a control. `reset_link_sent`
-- in particular is absent because there is no password to reset -- §5.1's
-- reset IS the enrolment-token path, so it writes `enrolment_token_issued`.
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
                                -- Filed on BOTH kinds, like `rewrap`: §1.1's
                                -- operator suspend verb is an act of the
                                -- operator plane and an act inside one
                                -- organisation, and it has to be legible to
                                -- someone auditing either.
                                'grant_suspended'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
