-- 0018 -- ADR-0055 decision 10: a password and an app code, for the account
-- plane only. Stream (a) of the build contracts at
-- docs/archive/2026-09-21-adr-0055-build-contracts.md.
--
-- `docs/decisions/adr-0055-one-person-two-custodies.md` decisions 6, 7, 8, 10;
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4.3 (assurance is a signature, not
-- a boolean), §5.1 (reset); CLAUDE.md rule 4 (a device credential is never in
-- scope here -- this is the PERSON's credential, a different thing entirely);
-- `.context/conventions.md` invariant 11.
--
-- **0013, 0014, 0015 and 0017 are not edited and must never be.** They have
-- shipped and are under the checksum gate in `src/migrate.rs`. 0016 does not
-- exist on disk -- see `src/migrate.rs`'s header for why this file is 0018 and
-- not the number the ADR uses in prose.
--
-- ---------------------------------------------------------------------------
-- THE LINE THIS FILE DOES NOT CROSS
-- ---------------------------------------------------------------------------
--
-- **This reopens `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4.5 by the owner's
-- own decision (ADR-0055's header), and nowhere else.** §4.5 said the operator
-- surface has no password path; ADR-0055 decision 10 puts one there, guarded
-- by a second factor the server cannot mail and cannot re-issue (the TOTP
-- secret, sealed, never re-displayed) and by decision 7's rule that a mailed
-- reset never restores the operator custody by itself. Every other password
-- rule in this codebase is unchanged: a NETWORK DEVICE credential still never
-- arrives (CLAUDE.md rule 4, ADR-0045's own line, untouched by this file) --
-- what is added here is the credential a PERSON uses to open their own
-- session, which is a different noun the redaction gate was never about.
--
-- ---------------------------------------------------------------------------
-- A. THE PASSWORD -- ONE COLUMN, PHC-ENCODED, NULLABLE
--
-- `password_hash` holds the whole encoded Argon2id string (algorithm,
-- version, parameters, salt and hash in one field) -- the OWASP Password
-- Storage Cheat Sheet's own shape, and the reason it is one text column and
-- not three: the parameters travel with the hash, so a future change to the
-- work factor does not strand every row hashed under the old one. It is
-- NULLABLE because an operator-only account created before this file, or an
-- account that only ever holds a design-plane key, may have none; `NULL` is
-- "no password set", checked by the sign-in path exactly as a `NULL`
-- `evidence_key_id` is checked today.
--
-- **Not sealed.** A password hash is already the one-way, salted, memory-hard
-- function ADR-0055's "What others do" table and its NIST/OWASP citations
-- describe; wrapping it in this server's own AEAD would add a second key an
-- attacker who has the database already does not need, and would suggest a
-- property (recoverability) a password hash must never have.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_hash text;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_password_hash_is_bounded;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_password_hash_is_bounded
    CHECK (password_hash IS NULL OR char_length(password_hash) BETWEEN 1 AND 255);

-- ---------------------------------------------------------------------------
-- B. THE APP CODE -- TOTP, RFC 6238, SEALED UNDER THE SITE CHAIN KEY
--
-- Four columns, correlated by one `CHECK`: a secret is enrolled or it is not,
-- and there is no state in between. The sealing key is derived from the SITE
-- chain key by the same construction `operators.rs`'s `settings_key` uses for
-- an SMTP value (`0015` §F) -- a new HKDF `info` label rather than a new key
-- source, because `0013`'s departure 2 already gives the argument: a label
-- separates USES of one key, and sealing one more site-scoped secret is not a
-- new use. `value_key_epoch` is `chains::CHAIN_KEY_EPOCH` today, carried so a
-- future rotation can tell which epoch opens an old row, exactly as
-- `site_settings_versions.value_key_epoch` does.
--
-- **Never re-shown after enrolment** (decision 10) is an application rule,
-- not a schema one -- nothing here can stop a row being read twice. What the
-- schema buys is that the plaintext is never AT REST: only ciphertext is
-- ever written.
--
-- `totp_last_step` is decision 10's replay refusal: RFC 6238's 30-second step
-- counter (`unix_time / 30`) of the last code this account's sign-in
-- accepted. A code for a step at or below this value is refused even if it
-- verifies, which is what makes "accepted once" true across a request that
-- crashed after verifying but before advancing -- the column is inside the
-- sign-in transaction's own `UPDATE`, not a separate one that could be lost.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_secret_ct bytea;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_secret_nonce bytea;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_secret_key_epoch integer;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_enrolled_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS totp_last_step bigint;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_totp_secret_nonce_is_twelve_bytes;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_totp_secret_nonce_is_twelve_bytes
    CHECK (totp_secret_nonce IS NULL OR octet_length(totp_secret_nonce) = 12);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_totp_secret_key_epoch_is_positive;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_totp_secret_key_epoch_is_positive
    CHECK (totp_secret_key_epoch IS NULL OR totp_secret_key_epoch >= 1);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_totp_last_step_is_not_negative;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_totp_last_step_is_not_negative
    CHECK (totp_last_step IS NULL OR totp_last_step >= 0);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_totp_secret_is_whole;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_totp_secret_is_whole
    CHECK (
        (totp_secret_ct IS NULL) = (totp_secret_nonce IS NULL)
        AND (totp_secret_ct IS NULL) = (totp_secret_key_epoch IS NULL)
        AND (totp_secret_ct IS NULL) = (totp_enrolled_at IS NULL)
    );

-- ---------------------------------------------------------------------------
-- B2. A THIRD ASSURANCE VALUE -- PASSWORD PLUS APP CODE, NO LONG-TERM KEY
--
-- `0013`'s `sessions.assurance CHECK (assurance IN ('A0','A1'))` encodes a
-- binary the design doc drew before a password existed: `A1` is "a long-term
-- key signed the bind challenge" (`evidence_sig`/`evidence_key_id` set),
-- `A0` is "nothing did". A password-plus-TOTP sign-in is neither --
-- decision 10 requires the app code for every operator-custody account
-- precisely because it is NOT nothing -- so filing it as `A0` would let a
-- reader mistake a two-factor sign-in for the unauthenticated placeholder
-- `A0` names today, and filing it as `A1` would claim a long-term-key
-- attestation that never happened.
--
-- `A0T` -- "`A0`, plus a verified TOTP code" -- is the third value.
-- `evidence_sig`, `evidence_key_id` and `evidence_operator_key_id` stay NULL
-- for it, exactly as for `A0`: the fact that a code was checked lives in the
-- assurance value itself and not in a new column, because the code is
-- single-use and there is nothing left to store once it has been checked.
-- `0013`'s own `CHECK ((assurance = 'A1') = (evidence_sig IS NOT NULL))` is
-- untouched and still holds: `A0T` is not `A1`, so the right-hand side is
-- still required NULL.
--
-- **What an `A0T` session may DO is a `src/sessions.rs` authorisation
-- decision, not a schema one, and is not made by this file.** The contracts
-- document's open-issues section carries it forward rather than deciding it
-- here.
-- ---------------------------------------------------------------------------
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_assurance_check;
ALTER TABLE sessions
    ADD CONSTRAINT sessions_assurance_check
    CHECK (assurance IN ('A0', 'A1', 'A0T'));

-- ---------------------------------------------------------------------------
-- C. BACKUP CODES -- TEN, HASHED, SINGLE USE
--
-- Hashed the same way an enrolment token is (`operators::token_hash`'s
-- shape): `H(LP(tag) ‖ LP(code))`, tag `fathom/credentials/backup/code/v1`, so
-- a database read hands an attacker a hash and nothing redeemable. Ten rows
-- per enrolment, minted inside the same transaction as `totp_enrolled_at` is
-- set, so there is no window where TOTP is enrolled and no lost-phone path
-- exists yet.
--
-- **No `issued_seq` and no per-issue chain entry.** The batch of ten is part
-- of the ONE `totp_enrolled` entry (section E) -- an entry per code would let
-- the sealed audit grow by ten for one human action, the amplifier argument
-- `0015` §F's `operator_read_samples` and `0014` §B's anonymous-entry latch
-- both make. Spending one, singly, writes `backup_code_used` and does carry
-- its own `chain_seq`, because a lost-phone recovery is the act worth an
-- individual record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backup_codes (
    id           text        PRIMARY KEY CHECK (char_length(id) = 26),
    account_id   text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,

    code_hash    bytea       NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),

    issued_at    timestamptz NOT NULL DEFAULT now(),

    used_at      timestamptz,
    used_seq     bigint,

    row_version  integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal     bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    CHECK ((used_at IS NULL) = (used_seq IS NULL))
);

CREATE INDEX IF NOT EXISTS backup_codes_account_idx ON backup_codes (account_id, used_at);

-- ---------------------------------------------------------------------------
-- D. PASSWORD RESET TOKENS -- DECISION 7, "RESET BY MAIL, FOR THE PASSWORD
--    ONLY"
--
-- `enrolment_tokens`' shape (`0015` §E), one purpose, no operator issuer: a
-- reset token is self-service, requested by whoever types an address into the
-- forgot-password form, so there is no `issued_by REFERENCES operators` here
-- -- the row that would otherwise carry that FK carries `source` instead,
-- which is where the request came from for the rate-limit and incident
-- record decision 7 asks for.
--
-- **`source` and no new rate-limit table.** §13 item 7's fixed-window bucket
-- (`sign_in_attempts`, `0013` §D) is reused rather than duplicated: a reset
-- request is counted under `bucket_kind='account'`/`'source'` with
-- `bucket_key` prefixed `reset:`, so it shares the mechanism and not the
-- counts -- a build decision recorded in the contracts document, not a schema
-- change, because the table's shape already fits.
--
-- **Single use is a guarded `UPDATE`, in the exact shape `0015` §E argues
-- for**: `UPDATE ... WHERE spent_at IS NULL RETURNING`, with `spent_at` inside
-- the row seal so clearing it to re-open a spent token leaves an unverifiable
-- row rather than a usable one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id           text        PRIMARY KEY CHECK (char_length(id) = 26),
    account_id   text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,

    -- `H(LP("fathom/credentials/reset/token/v1") ‖ LP(token))`. The token is
    -- at least 128 bits from the OS CSPRNG (decision 7) and is returned once,
    -- in the mailed link, and never stored.
    token_hash   bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),

    -- The source address of the HTTP request that asked for the reset, for
    -- the incident record. Never the destination -- the destination is always
    -- `accounts.email`, per decision 7's "no override field, no
    -- operator-supplied destination" (design doc §5.1).
    source       text        NOT NULL CHECK (char_length(source) BETWEEN 1 AND 128),

    issued_seq   bigint      NOT NULL CHECK (issued_seq >= 1),
    issued_at    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,

    spent_at     timestamptz,
    spent_seq    bigint,

    row_version  integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal     bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    CHECK ((spent_at IS NULL) = (spent_seq IS NULL)),
    CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_account_idx ON password_reset_tokens (account_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx ON password_reset_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- E. ROW-LEVEL SECURITY AND THE TWO NEW CUSTODIES
--
-- **`app.credential_custody`** -- an authenticated session doing its OWN
-- credential work: set or change a password, enrol TOTP, view or spend a
-- backup code. Set by a new `src/credentials.rs`, for one transaction, after
-- `sessions::verify_request` has named the acting account -- the same shape
-- `0011`'s `account_keys` policy wants (`account_id = app.account_id`) but
-- expressed as a capability rather than a value comparison, because a
-- capability the caller cannot forge is what `repo.rs`'s own rule asks a
-- policy to be.
--
-- **`app.reset_custody`** -- the UNAUTHENTICATED forgot/reset pair. No session
-- exists yet (forgot) or ever will for this act alone (reset spends a token
-- and produces no session of its own -- decision 7's password change is
-- immediate, the sign-in that follows it is a fresh one). Same shape as
-- `app.enrolment_custody` (`0015` §H) and deliberately a SEPARATE capability
-- from it: enrolment_custody's write surface is tokens, operators and
-- organisation shells; reset_custody's is `accounts.password_hash` and
-- `password_reset_tokens` only, and sharing one capability between "redeem an
-- operator enrolment" and "change my own password" would let a bug in either
-- path reach the other's tables.
--
-- **`app.session_custody`** (existing, `0013` §E) keeps its meaning
-- unchanged and gains one job: `sessions::attempt_sign_in` reads
-- `password_hash`, the four TOTP columns and `totp_last_step` inside the same
-- verification transaction it already runs in, and advances
-- `totp_last_step` there rather than in a second transaction a crash could
-- lose.
-- ---------------------------------------------------------------------------
ALTER TABLE backup_codes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_codes           FORCE  ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens  ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens  FORCE  ROW LEVEL SECURITY;

-- `accounts_readable` (`0002`, widened `0013` §A) gains the two new
-- custodies: `reset_custody` has to resolve an address to an account id
-- anonymously, on the same anti-enumeration argument `0013` gives
-- `session_custody`, and `credential_custody` has to find its own row to
-- satisfy the `UPDATE` policy below (the same reason `0013` gives
-- `account_custody`).
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
        OR current_setting('app.account_custody', true) = 'yes'
        OR current_setting('app.credential_custody', true) = 'yes'
        OR current_setting('app.reset_custody', true) = 'yes'
    );

-- A second, separate `UPDATE` policy rather than widening `accounts_disablable`
-- -- that policy's job is §1.1's suspend verb and stays operator-only; this
-- one is the credential columns and is never reachable under
-- `app.account_custody`. Two policies name two different acts, the same
-- discipline `0015` §H states for `operator_custody` vs `enrolment_custody`.
CREATE POLICY accounts_credential_writable ON accounts
    FOR UPDATE
    USING (
        current_setting('app.session_custody', true) = 'yes'
        OR current_setting('app.credential_custody', true) = 'yes'
        OR current_setting('app.reset_custody', true) = 'yes'
    )
    WITH CHECK (
        current_setting('app.session_custody', true) = 'yes'
        OR current_setting('app.credential_custody', true) = 'yes'
        OR current_setting('app.reset_custody', true) = 'yes'
    );

REVOKE UPDATE ON accounts FROM fathom_app;
GRANT UPDATE (disabled_at) ON accounts TO fathom_app;
GRANT UPDATE (password_hash, totp_secret_ct, totp_secret_nonce, totp_secret_key_epoch,
              totp_enrolled_at, totp_last_step)
    ON accounts TO fathom_app;

CREATE POLICY backup_codes_readable ON backup_codes
    FOR SELECT USING (current_setting('app.credential_custody', true) = 'yes'
                      OR current_setting('app.session_custody', true) = 'yes');
CREATE POLICY backup_codes_insertable ON backup_codes
    FOR INSERT WITH CHECK (current_setting('app.credential_custody', true) = 'yes');
CREATE POLICY backup_codes_updatable ON backup_codes
    FOR UPDATE USING (current_setting('app.credential_custody', true) = 'yes'
                      OR current_setting('app.session_custody', true) = 'yes')
            WITH CHECK (current_setting('app.credential_custody', true) = 'yes'
                      OR current_setting('app.session_custody', true) = 'yes');

-- A backup code is spendable AT sign-in (no session exists yet, so it is
-- verified inside `session_custody`, in the same transaction as the TOTP
-- check it stands in for) and viewable/re-issuable from an existing session
-- (`credential_custody`). Neither branch may delete -- a spent code stays as
-- the record that it was spent.
REVOKE DELETE ON backup_codes FROM fathom_app;
REVOKE UPDATE ON backup_codes FROM fathom_app;
GRANT UPDATE (used_at, used_seq, row_version, row_seal) ON backup_codes TO fathom_app;

CREATE POLICY password_reset_tokens_readable ON password_reset_tokens
    FOR SELECT USING (current_setting('app.reset_custody', true) = 'yes');
CREATE POLICY password_reset_tokens_insertable ON password_reset_tokens
    FOR INSERT WITH CHECK (current_setting('app.reset_custody', true) = 'yes');
CREATE POLICY password_reset_tokens_updatable ON password_reset_tokens
    FOR UPDATE USING (current_setting('app.reset_custody', true) = 'yes')
            WITH CHECK (current_setting('app.reset_custody', true) = 'yes');

REVOKE DELETE ON password_reset_tokens FROM fathom_app;
REVOKE UPDATE ON password_reset_tokens FROM fathom_app;
GRANT UPDATE (spent_at, spent_seq, row_version, row_seal) ON password_reset_tokens TO fathom_app;

-- ---------------------------------------------------------------------------
-- F. THE ENTRY TYPES THIS FILE'S ACTS WRITE (§7.2's list, extended)
--
-- Five, all filed on the SITE chain -- the same home `account_signin` and
-- `account_disabled` have, because a credential act is an act of the account
-- plane and not of any one organisation.
--
--   * `password_set`     -- a password was set or changed (first set and
--                            every later change are the same type; "first" is
--                            recoverable from whether a prior entry exists).
--   * `totp_enrolled`     -- the app code was enrolled, together with the ten
--                            backup codes in the same transaction.
--   * `reset_requested`   -- a reset token was issued.
--   * `reset_spent`       -- a reset token was redeemed and the password
--                            changed. Carries no evidence the OLD password is
--                            gone beyond the column being overwritten; that is
--                            the same property `account_key_retired` has.
--   * `backup_code_used`  -- one code was spent.
--
-- Extended by `DROP CONSTRAINT` then `ADD CONSTRAINT`, wrapped in the
-- invariant-11 `NO FORCE` / `FORCE` pair every migration since `0010` uses for
-- exactly the reason stated there: `ADD CONSTRAINT ... CHECK` re-validates
-- every existing `chain_entries` row, which is a read behind `FORCE ROW LEVEL
-- SECURITY` and returns zero rows SILENTLY with no tenant context.
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
                                'grant_suspended',
                                -- ADR-0055, this file's section F.
                                'password_set', 'totp_enrolled',
                                'reset_requested', 'reset_spent',
                                'backup_code_used'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced',
                                'firmware_staged', 'firmware_fetch_issued',
                                'firmware_fetch_redeemed'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
