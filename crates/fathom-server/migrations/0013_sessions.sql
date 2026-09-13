-- 0013 -- sessions: one principal per session, a browser-held key the server
-- has never seen, single-use nonces, and the row MAC that makes a session row
-- unmintable from SQL alone.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §§4.1, 4.2, 4.3, 4.5, §1.3, §1.4,
-- §5.1, §7.2, §13 (items 1-4, 7, 8) and §15.6 item 4;
-- `docs/PHASE-2-STORAGE-DESIGN.md` §12.2 (the label table, which wins over
-- code); `.context/conventions.md` invariant 11.
--
-- **The design numbers this file `0006_sessions.sql`.** That number was taken
-- by the runtime role long before the design was written, exactly as `0009`
-- and `0011` record for their own numbers. This is the next free number.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS FOR, IN ONE PARAGRAPH
-- ---------------------------------------------------------------------------
--
-- §4.1: *"a session may receive design payload only if (a) its authentication
-- included a factor the server cannot re-issue, and (b) the request itself
-- carries a fresh signature by a key the session's browser holds and the
-- server has never seen."* Clause (a) alone loses to COPYING: a tier-2
-- attacker lifts a genuine assertion out of the victim's row -- or out of last
-- night's backup -- into a row whose bearer token they chose, and
-- re-verification succeeds because the assertion is authentic. Clause (b) is
-- why this table stores a PUBLIC key and why every request that reaches design
-- payload carries a signature under its private half. Replaying the row yields
-- a session whose private half the attacker does not hold.
--
-- ---------------------------------------------------------------------------
-- SIX PLACES THIS FILE DEPARTS FROM §4.3's SQL, EACH WITH ITS REASON
-- ---------------------------------------------------------------------------
--
-- 1. **`principal_kind` is `('steward','operator')`, not `('account',
--    'operator')`.** `0004` created `principals` with
--    `CHECK (kind IN ('steward','operator'))` and every composite foreign key
--    in `0011` follows it, so a literal `'account'` here would fail the
--    foreign key on every insert. `0011` records the same departure for
--    `scope_grants.subject_kind`. The design's own vocabulary (§0: *"stewards
--    hold the data"*) is what `0004` implemented.
--
-- 2. **The row MAC is `authority::row_seal` under the SITE-scoped row key**,
--    not a fresh `fathom/session/row/v1` construction under a fresh
--    `fathom/session/mac/v1` subkey. §4.3 specifies both; `0012` §D already
--    established that an account-scoped row is sealed under
--    `K_row_site = HKDF-Expand(site chain key, "fathom/chain/kdf/row/v1", 32)`
--    and a session is account-scoped in exactly the same way -- it belongs to
--    a principal, not to an organisation, and its verifier holds no tenant
--    context at all. `row_seal` already length-prefixes the table name, so a
--    session row lifted into an authority table (or the reverse) fails its MAC
--    where it lands, and it already covers `row_version`. Two labels are
--    therefore NOT introduced, which is the outcome
--    `PHASE-2-STORAGE-DESIGN.md` §12.2 prefers: a label separates USES of one
--    key, and nothing here is a new use.
--
--    The property §4.3 asks for is untouched and is the reason the column
--    exists: `K_row_site` is not in PostgreSQL, so **a tier-2 attacker cannot
--    mint a session row at all**; a tier-3 attacker can mint one and still
--    cannot sign a request.
--
-- 3. **`chain_seq` is in the row and inside the MAC.** §4.3's table has no
--    such column. `row_seal` binds one, and binding it to the `account_signin`
--    entry on the SITE chain makes §0's *"stopping the log stops the act"*
--    mechanical for sign-in too: there is no session row without its sealed
--    entry, because the entry is appended first and the MAC covers its `seq`.
--
-- 4. **`assertion_digest` has a second definition, for software keys.** §4.3
--    defines it as `H(authenticatorData || clientDataJSON || signature)`,
--    which presumes WebAuthn. §15.1 ships v1 on software keys, so the stored
--    evidence §4.2 requires -- *"a signature by the account's registered key
--    over the same session_challenge"* -- is recorded as
--    `H(LP("fathom/session/evidence/v1") || LP(session_challenge) ||
--    LP(evidence_sig))`, beside the key id and the signature themselves.
--    `credential_id` stays, unfilled, for the WebAuthn path (§15.4).
--
-- 5. **`last_seen_at`, `evidence_key_id`, `evidence_sig` and `row_version` are
--    new columns.** The first because a session that is never used should be
--    visible as such; the second because a session outlives a key rotation and
--    the verifier must re-resolve the EXACT key that proved this sign-in (a
--    retired key stops a session at its next request, and a boolean cannot say
--    that -- `0011`'s argument for `account_keys.retired_at`); the third
--    because `assertion_digest` is a digest and a digest is not evidence
--    anybody can re-verify; the fourth because `row_seal` covers it.
--
-- 6. **`token_hash` is `H(LP("fathom/session/token/v1") || LP(token))`.** §4.3
--    names the column and not the construction. The token is a bearer
--    credential and it is deliberately weak: on its own it buys exactly one
--    thing, a fresh single-use nonce, and nothing that reaches design payload
--    or vault ciphertext. Say that here so nobody later cites it as a control
--    it is not.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT BUILT HERE, AND IS ABSENT RATHER THAN STUBBED
-- ---------------------------------------------------------------------------
--
--   * **No password column, anywhere, for anyone** (§4.5, §5.1, and
--     `docs/OPEN-QUESTIONS.md` C2). The operator surface has no password path
--     at all, and the account surface has none either today: sign-in is a
--     signature by an enrolled key over a server challenge. Storage of a
--     password is not built, so `A0` -- §4.3's password-only assurance -- is a
--     value in a `CHECK` that nothing writes. It is kept because §4.3's rule
--     is uniform and the column is how a reset-issued session will be
--     recorded; it is NOT what gates design payload. The gate is the request
--     signature, which is a question an administrator cannot answer yes to by
--     editing a row.
--   * **No operator keyring.** An operator session is `A1` or it does not
--     exist (§4.5), and there is no table an operator's key could be enrolled
--     in -- `account_keys` is account-scoped by foreign key. So
--     `principal_kind = 'operator'` is representable here and unreachable
--     today; `src/sessions.rs` refuses the operator branch with a typed error
--     naming §4.5 rather than growing a second, weaker factor to fill the gap.
--   * **No `sealed_seq` interlock (§5.4)** and no admin surface.
--   * **No background expiry sweep.** An expired session is refused and
--     deleted at its next use, which is where the refusal has to happen
--     anyway; a sweeper is an optimisation on table size, not a control.

-- ---------------------------------------------------------------------------
-- A. THE ACCOUNT DISABLE FLAG, AND THE ONE TRANSACTION-LOCAL CAPABILITY THIS
--    FILE ADDS
--
-- §7.2 names `account_disabled|enabled` on the site chain and `0002` gave
-- `accounts` no column to record it, so "a disabled account's session stops
-- working at its next request" had nothing to read. This is that column.
--
-- **`accounts` has no UPDATE policy** (`0003`, deliberately: "with row
-- security forced and no policy for a command, that command reaches no rows at
-- all"). Rather than widen that to every column, this file adds a policy whose
-- predicate is a transaction-local capability -- `app.account_custody` -- in
-- the exact shape of `app.key_custody` from `0010` §F, and a COLUMN-level
-- grant so the privilege layer says the same thing first. The capability is
-- set by `sessions::set_account_disabled` and by nothing else, and
-- `set_config(..., true)` scopes it to one transaction, so it is gone at
-- commit and is never visible to whatever the pool hands the connection to
-- next.
--
-- The operator surface that will CALL that function is §5's and is not built.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

-- **`accounts_readable` gains one branch, and `0003`'s own comment predicted
-- it**: *"THERE IS NO AUTHENTICATION LAYER YET; when there is, this policy is
-- where it binds, and that is the diff to look for."* This is that diff.
--
-- Sign-in reads `accounts` to resolve an address, and it does so BEFORE any
-- account context exists — `app.account_id` is what a sign-in is trying to
-- establish, so a policy comparing against it is a policy that can never be
-- satisfied on the one path that needs it. `0003`'s two branches are kept
-- verbatim and a third is added for the session-custody transaction, which
-- does nothing but verify and lives for the length of one sign-in.
--
-- **What it widens, stated plainly:** inside that transaction the runtime role
-- can read every account row, which is how sign-in by address works at all.
-- Outside it — every design read, every authority act, every repository call —
-- the setting is absent and `0003`'s rule is unchanged.
DROP POLICY IF EXISTS accounts_readable ON accounts;
CREATE POLICY accounts_readable ON accounts
    FOR SELECT
    USING (
        id = current_setting('app.account_id', true)
        OR EXISTS (
            SELECT 1 FROM memberships m
            WHERE m.account_id = accounts.id
              AND m.organisation_id = current_setting('app.tenant_id', true)
        )
        OR current_setting('app.session_custody', true) = 'yes'
        -- And the disable path below, which must find the row it is about to
        -- update: PostgreSQL applies the SELECT policies to an `UPDATE ...
        -- WHERE`, so an UPDATE policy on its own reaches nothing.
        OR current_setting('app.account_custody', true) = 'yes'
    );

DROP POLICY IF EXISTS accounts_disablable ON accounts;
CREATE POLICY accounts_disablable ON accounts
    FOR UPDATE
    USING (current_setting('app.account_custody', true) = 'yes')
    WITH CHECK (current_setting('app.account_custody', true) = 'yes');

REVOKE UPDATE ON accounts FROM fathom_app;
GRANT UPDATE (disabled_at) ON accounts TO fathom_app;

-- ---------------------------------------------------------------------------
-- B. THE SESSION ROW
--
-- §4.3, with the six departures at the head of this file. Sessions are ROWS
-- and not memory, which is REBUILD-PLAN item 1 satisfied as a side effect
-- (§13 item 4) and means either container verifies a request without shared
-- state.
--
-- **`request_counter` is anti-replay against a network observer, not against
-- the database attacker** -- they own the column it is compared against.
-- §4.3 asks for that sentence to be written where the column is defined, and
-- here it is. The control against replay is the single-use nonce in section C,
-- which is consumed by a `DELETE ... RETURNING` in the same transaction that
-- verifies the signature; the counter is inside the signed bytes because §4.2
-- puts it there, is stored as a high-water mark, and is refused only when it
-- does not exceed the mark recorded WHEN THE NONCE WAS ISSUED. That last rule
-- is this build's, and it is what keeps concurrent requests from one browser
-- working: every nonce issued at one high-water accepts the same next value,
-- so a client with four requests in flight does not have to serialise them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id                text        PRIMARY KEY CHECK (char_length(id) = 26),

    -- §13 item 2: a session carries exactly ONE principal and its kind is
    -- recorded. The composite foreign key is `0004`'s fence: an operator id
    -- cannot appear in any authority row, and a steward id cannot be recorded
    -- here as an operator, at every privilege level including `psql` as
    -- superuser.
    principal_id      text        NOT NULL,
    principal_kind    text        NOT NULL CHECK (principal_kind IN ('steward', 'operator')),

    -- The bearer half. It buys a nonce and nothing else -- see departure 6.
    token_hash        bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),

    -- §4.2's browser-held key: generated non-extractable in `WebCrypto`,
    -- stored in IndexedDB, never exported by script. THE SERVER HOLDS THE
    -- PUBLIC HALF ONLY and that is the whole point of the table.
    session_pubkey    bytea       NOT NULL CHECK (octet_length(session_pubkey) = 65
                                                  AND get_byte(session_pubkey, 0) = 4),
    session_alg       smallint    NOT NULL CHECK (session_alg = 1),

    -- The server nonce this session's challenge was derived over, kept after
    -- the nonce row is consumed so that the binding can be recomputed.
    bound_nonce       bytea       NOT NULL CHECK (octet_length(bound_nonce) = 32),

    -- WebAuthn, §15.4. Nothing writes it yet and it is NOT NULL-able-into-a-
    -- placeholder: a `NOT NULL` column filled with a stand-in is a lie the
    -- schema tells about itself (`0011` §B's argument for `credential_id`).
    credential_id     bytea       UNIQUE,

    -- §4.2's assurance evidence, in the software-key shape (departure 4).
    evidence_key_id   text        REFERENCES account_keys(id) ON DELETE RESTRICT,
    evidence_sig      bytea       CHECK (octet_length(evidence_sig) = 64),
    assertion_digest  bytea       CHECK (octet_length(assertion_digest) = 32),

    assurance         text        NOT NULL CHECK (assurance IN ('A0', 'A1')),

    request_counter   bigint      NOT NULL DEFAULT 0 CHECK (request_counter >= 0),

    -- The `account_signin` entry on the site chain. Inside the MAC.
    chain_seq         bigint      NOT NULL CHECK (chain_seq >= 1),

    issued_at         timestamptz NOT NULL DEFAULT now(),
    last_seen_at      timestamptz NOT NULL DEFAULT now(),
    expires_at        timestamptz NOT NULL,

    row_version       integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_mac           bytea       NOT NULL CHECK (octet_length(row_mac) = 32),

    CHECK (expires_at > issued_at),
    -- Evidence is what makes a session `A1`, so the two move together. An
    -- `A1` row with no evidence would be §4.1's stored boolean wearing a
    -- different name.
    CHECK ((assurance = 'A1') = (evidence_sig IS NOT NULL)),
    CHECK ((evidence_sig IS NULL) = (assertion_digest IS NULL)),

    FOREIGN KEY (principal_id, principal_kind) REFERENCES principals (id, kind)
);

CREATE INDEX IF NOT EXISTS sessions_principal_idx ON sessions (principal_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- C. THE SINGLE-USE NONCE STORE
--
-- §4.2: *"32 random bytes, stored once, consumed at verification"*, and *"the
-- nonce is single-use and deleted at verification, so the same assertion
-- cannot bind a second public key."*
--
-- **Consumption is `DELETE ... RETURNING`, not a `consumed_at` column.** A
-- flag is a value one `UPDATE` from being false and needs a second statement
-- to check it; a delete that returns no row IS the refusal, and it is atomic
-- against a concurrent second use of the same nonce without any lock the
-- application has to remember to take.
--
-- Two purposes, one table, distinguished by a column rather than by two
-- tables, because the lifecycle and the deletion rule are identical:
--
--   * `bind`    -- §4.2's `server_nonce`, issued before sign-in. It carries the
--                  session public key the challenge will be derived over and
--                  the principal being claimed, so the same nonce cannot bind
--                  a second public key or a second account.
--   * `request` -- the per-request nonce of §4.1, issued to a live session.
--
-- **The claimed principal is nullable, and that is an anti-enumeration
-- measure.** A challenge asked for an address that belongs to no account
-- stores a row with no principal, so the response is byte-identical to the
-- one an existing account gets and only the later sign-in refuses. The
-- composite foreign key is not enforced when a column of it is NULL
-- (MATCH SIMPLE), which is exactly the behaviour wanted here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session_nonces (
    nonce          bytea       PRIMARY KEY CHECK (octet_length(nonce) = 32),
    purpose        text        NOT NULL CHECK (purpose IN ('bind', 'request')),

    -- `bind` only.
    session_pubkey bytea       CHECK (octet_length(session_pubkey) = 65
                                      AND get_byte(session_pubkey, 0) = 4),
    principal_id   text,
    principal_kind text        CHECK (principal_kind IN ('steward', 'operator')),

    -- `request` only. ON DELETE CASCADE, unlike every other referential action
    -- in this schema, and deliberately: a sign-out deletes the session, and a
    -- nonce that outlived it authorises nothing -- the `0011` argument against
    -- cascades is that a cascade can remove a STATEMENT by deleting something
    -- else, and a nonce states nothing. RESTRICT here would mean a sign-out
    -- failing because a nonce was outstanding.
    session_id     text        REFERENCES sessions(id) ON DELETE CASCADE,

    -- The session's `request_counter` when this nonce was issued. See section
    -- B on why the counter is compared against this rather than against the
    -- row's current value.
    issued_counter bigint      NOT NULL DEFAULT 0 CHECK (issued_counter >= 0),

    issued_at      timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,

    CHECK ((purpose = 'bind') = (session_pubkey IS NOT NULL)),
    CHECK ((purpose = 'request') = (session_id IS NOT NULL)),
    CHECK (expires_at > issued_at),

    FOREIGN KEY (principal_id, principal_kind) REFERENCES principals (id, kind)
);

CREATE INDEX IF NOT EXISTS session_nonces_session_idx ON session_nonces (session_id);
CREATE INDEX IF NOT EXISTS session_nonces_expiry_idx ON session_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- D. RATE LIMITING AND LOCKOUT -- §13 item 7, WHICH THE DESIGN DOES NOT SPECIFY
--
-- §13 item 7 lists *"rate limiting, lockout, and the sign-in surface itself"*
-- as things authentication must later provide *"which this design does not
-- specify"*. This is the minimal shape, chosen here and reported as a decision
-- for the documents rather than invented silently:
--
--   * **Fixed windows, not a token bucket.** One row per
--     (bucket, window start), a counter, and a limit. A fixed window admits up
--     to twice the limit across a window boundary and everybody knows it; what
--     it buys is that the whole mechanism is one `INSERT ... ON CONFLICT DO
--     UPDATE` and one comparison, with no per-request timer state and nothing
--     in memory that two containers would have to agree about.
--   * **Two buckets, both counted, either one refusing:** the account (by
--     opaque account id, never by the address that was typed) and the source
--     address. An attacker who can vary their address still cannot exhaust one
--     account's window; an attacker who sprays many accounts from one address
--     still cannot exceed the source window.
--   * **Limits and window are configurable** (`FATHOM_SIGNIN_*`), because a
--     deployment behind a single NAT is a different shape from one on the open
--     internet, and a fixed number would be wrong for one of them.
--   * **A refusal is a typed error and a sealed entry**, and the entry is
--     written ONCE per window rather than once per refused request: otherwise
--     the audit chain grows without bound at whatever rate an anonymous
--     attacker chooses, which converts a rate limit into an amplifier.
--     `locked_entry_written` is that latch.
--
-- **What this does NOT claim.** It is not a defence against a distributed
-- attacker with many addresses and many accounts; nothing at this layer is.
-- It bounds one account's exposure and one address's, and it makes both
-- visible in the sealed trail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sign_in_attempts (
    bucket_kind          text        NOT NULL CHECK (bucket_kind IN ('account', 'source')),
    bucket_key           text        NOT NULL CHECK (char_length(bucket_key) BETWEEN 1 AND 128),
    window_start         timestamptz NOT NULL,
    attempts             integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    locked_entry_written boolean     NOT NULL DEFAULT false,
    PRIMARY KEY (bucket_kind, bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS sign_in_attempts_window_idx ON sign_in_attempts (window_start);

-- ---------------------------------------------------------------------------
-- E. ROW-LEVEL SECURITY
--
-- Forced on all three tables. **Every policy names its command and none is
-- `FOR ALL`** -- `0003`'s bug, restated on every migration that writes a
-- policy because it is the one that got through: a `FOR ALL` policy's `USING`
-- expression is silently reused by PostgreSQL as the `WITH CHECK` for every
-- write.
--
-- **The predicate is a transaction-local capability, not a tenant id, and the
-- reason is structural.** A session is not organisation-scoped: it is verified
-- BEFORE any tenant context exists, and the verifier does not know whose
-- session it is until it has read the row. There is no tenant id to compare
-- against and inventing one would be a policy that reads a value the caller
-- supplied -- which is what `repo.rs`'s own module doc says a policy must
-- never be.
--
-- So `app.session_custody` is set by `src/sessions.rs` and by nothing else,
-- for the length of ONE transaction that does nothing but verify. What it
-- buys is real and bounded: every other transaction in this server -- every
-- design read, every authority act, every repository call -- reaches ZERO rows
-- in these three tables, so a query written wrong (or injected) on a tenant
-- path cannot read a token hash, a nonce or a session public key. It is the
-- same mechanism and the same argument as `app.key_custody` in `0010` §F and
-- `app.design_capability` in `0007`.
--
-- **It is not a defence against the application lying about which session is
-- acting.** Nothing at the policy layer could be. That defence is the row MAC
-- and the request signature, and both are checked in code that this setting
-- does not gate.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions          FORCE  ROW LEVEL SECURITY;
ALTER TABLE session_nonces    ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_nonces    FORCE  ROW LEVEL SECURITY;
ALTER TABLE sign_in_attempts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_in_attempts  FORCE  ROW LEVEL SECURITY;

CREATE POLICY sessions_readable ON sessions
    FOR SELECT USING (current_setting('app.session_custody', true) = 'yes');
CREATE POLICY sessions_insertable ON sessions
    FOR INSERT WITH CHECK (current_setting('app.session_custody', true) = 'yes');
CREATE POLICY sessions_updatable ON sessions
    FOR UPDATE USING (current_setting('app.session_custody', true) = 'yes')
            WITH CHECK (current_setting('app.session_custody', true) = 'yes');
CREATE POLICY sessions_deletable ON sessions
    FOR DELETE USING (current_setting('app.session_custody', true) = 'yes');

CREATE POLICY session_nonces_readable ON session_nonces
    FOR SELECT USING (current_setting('app.session_custody', true) = 'yes');
CREATE POLICY session_nonces_insertable ON session_nonces
    FOR INSERT WITH CHECK (current_setting('app.session_custody', true) = 'yes');
CREATE POLICY session_nonces_deletable ON session_nonces
    FOR DELETE USING (current_setting('app.session_custody', true) = 'yes');

CREATE POLICY sign_in_attempts_readable ON sign_in_attempts
    FOR SELECT USING (current_setting('app.session_custody', true) = 'yes');
CREATE POLICY sign_in_attempts_insertable ON sign_in_attempts
    FOR INSERT WITH CHECK (current_setting('app.session_custody', true) = 'yes');
CREATE POLICY sign_in_attempts_updatable ON sign_in_attempts
    FOR UPDATE USING (current_setting('app.session_custody', true) = 'yes')
            WITH CHECK (current_setting('app.session_custody', true) = 'yes');

-- ---------------------------------------------------------------------------
-- F. PRIVILEGES -- WHAT THE RUNTIME ROLE DOES NOT GET, AND WHAT THE OPERATOR
--    PLANE DOES NOT GET AT ALL
--
-- `0006`'s default privileges hand `fathom_app` all four verbs on every table
-- created by the migration role. Two of them are narrowed here, at the
-- privilege layer, which is checked BEFORE row security and before any policy
-- expression anyone could get wrong (§0's fence table).
--
-- `fathom_operator` is granted NOTHING on any of these tables, and no default
-- privilege gives it any: §1.3's list revokes `sessions` from the operator
-- plane by name, and `tests/planes.rs` asserts the operator's readable set off
-- the live database on every run, so a grant added here would fail that test
-- rather than pass unnoticed.
-- ---------------------------------------------------------------------------

-- Only two columns of a session row are ever legitimately rewritten, and
-- neither is inside the MAC. Everything the MAC covers is un-rewritable at the
-- privilege layer, so the MAC is the SECOND statement of that rule rather than
-- the only one -- the shape `0011` §I used for `account_keys`.
REVOKE UPDATE ON sessions FROM fathom_app;
GRANT UPDATE (last_seen_at, request_counter) ON sessions TO fathom_app;

-- A nonce is written once and deleted once. There is no legitimate update.
REVOKE UPDATE ON session_nonces FROM fathom_app;

-- An attempt row is counted up and latched; nothing deletes one, and the
-- window makes old rows harmless. (A future sweeper would need this back, and
-- taking the privilege back is a migration somebody has to write down.)
REVOKE DELETE ON sign_in_attempts FROM fathom_app;
REVOKE UPDATE ON sign_in_attempts FROM fathom_app;
GRANT UPDATE (attempts, locked_entry_written) ON sign_in_attempts TO fathom_app;

-- ---------------------------------------------------------------------------
-- G. THE ENTRY TYPES THIS FILE'S ACTS WRITE (§7.2)
--
-- Extended by `DROP CONSTRAINT` then `ADD CONSTRAINT`, wrapped in the
-- invariant-11 `NO FORCE` / `FORCE` pair -- the path `0010` §C documents and
-- `0011` §K follows. `ADD CONSTRAINT ... CHECK` re-validates every row already
-- in `chain_entries`, and that validating scan is a read of a table behind
-- `FORCE ROW LEVEL SECURITY`, which with no tenant context returns zero rows
-- SILENTLY. **On an empty database the difference is invisible.** The pair is
-- LOAD-BEARING and must not be tidied away.
--
-- Five new SITE types, and every one of them is written by `src/sessions.rs`:
--
--   * `account_signin`         -- NOT IN §7.2's list, which names
--                                 `operator_signin|signin_failed` and gives an
--                                 account sign-in no entry type at all. §4
--                                 makes the account session the main path, so
--                                 the omission is a gap in the document and is
--                                 reported as one.
--   * `account_signin_failed`  -- same gap, same answer. Carries the reason,
--                                 including a rate-limit refusal, so the
--                                 lockout of §13 item 7 has the sealed record
--                                 the brief requires without a sixth type.
--   * `operator_signin_failed` -- §7.2's name. Written on every attempt at the
--                                 operator surface, which today refuses every
--                                 one of them (§4.5: an operator session is
--                                 `A1` or it does not exist, and no operator
--                                 key can be enrolled yet).
--   * `account_disabled` / `account_enabled` -- §7.2's names, written by
--                                 `sessions::set_account_disabled`.
--
-- `operator_signin` is deliberately ABSENT: nothing can write it until an
-- operator key can be enrolled, and an entry type nothing emits is a name in a
-- `CHECK` constraint pretending to be a control.
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
                                'operator_signin_failed',
                                'account_disabled', 'account_enabled'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
