-- 0025 -- the seal over the credential columns of `accounts`.
--
-- ADR-0055 (`docs/decisions/adr-0055-one-person-two-custodies.md`, accepted
-- 2026-09-21) decision 10 made a password and an app code the way into a
-- session. `0018` put those columns on `accounts` and left them the only
-- authority facts in this schema with no integrity cover: `backup_codes`,
-- `password_reset_tokens`, `operators`, `operator_keys`, `account_keys`,
-- `operator_account_bindings`, `sessions` and `session_revocations` all carry
-- a seal or a MAC, and the five columns a sign-in actually decides on did not.
--
-- **What the gap was, read off the merged build on 2026-09-21** (the checker's
-- reproduction is in the review note this migration answers). A writer holding
-- any PostgreSQL credential -- tier 2, the boundary
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §0 says the Seal fence is exactly
-- what binds -- ran
--
--     UPDATE accounts SET totp_secret_ct = NULL, totp_secret_nonce = NULL,
--            totp_secret_key_epoch = NULL, totp_enrolled_at = NULL,
--            totp_last_step = NULL
--
-- on the account holding the operator custody, and the next sign-in was
-- password-only with no alarm anywhere: `CredentialRow::totp_confirmed` reads
-- `totp_last_step`, which is not in `accounts_totp_secret_is_whole` and was in
-- no seal. Copying `password_hash` and the four secret columns onto a fresh
-- account did the same. Before ADR-0055 a sign-in needed a signature by a key
-- in the sealed `account_keys` ring, so these columns were not authentication
-- material; decision 10 made them authentication material, and this file gives
-- them the cover the rows beside them have had since `0011`.
--
-- This is not a claim that a database holder is locked out of anything. It is
-- the same claim `0015` §E makes for a guarded flag and `0018` §D restates for
-- a spent token: a row changed outside this server does not verify, and the
-- act it would have authorised is refused as `Unverifiable` rather than
-- performed. See ADR-0043 §2 for what the host holds.
--
-- ---------------------------------------------------------------------------
-- A. THREE COLUMNS
--
-- `credential_seal` is `authority::row_seal` under `grants::site_row_key` --
-- the SITE-scoped row key, because an account's credential is account-scoped
-- and not organisation-scoped, the same key `account_keys`, `backup_codes` and
-- `password_reset_tokens` are sealed under. `src/credentials.rs`'s
-- `credential_seal` function is the one place the sealed state is spelled, and
-- it covers, from ADR-0055's own list of what a sign-in decides on:
--
--   * the account id (as the seal's `row_id`, so a credential lifted onto
--     another row does not verify -- the second half of the AAD's own rule in
--     `0018` §B);
--   * `password_hash`, whole;
--   * `totp_secret_ct`, `totp_secret_nonce`, `totp_secret_key_epoch`;
--   * `totp_enrolled_at`;
--   * **whether `totp_last_step` is set, not its value** -- being set is what
--     `totp_confirmed()` means and is therefore the authority fact; the value
--     moves on every sign-in and sealing it would mean a new seal per sign-in
--     for no gain. The replay rule the value carries is enforced by the
--     guarded `UPDATE` in `sessions::check_second_factor`, which is a
--     concurrency control and not an integrity one;
--   * `operator_key_hold_until` (`0021`), whose own header argued it did not
--     need sealing because the key row it gates is sealed. That argument still
--     holds and this covers it anyway: the hold is now inside one seal with the
--     columns it stands beside, so clearing it outside this server is the same
--     kind of unverifiable as clearing the app code;
--   * `credential_row_version` and `credential_seq`, below.
--
-- `credential_row_version` counts the credential changes, so replacing today's
-- row state with a previous one leaves the version it was sealed at behind.
-- `credential_seq` is the `chain_entries.seq` of the sealed site-chain entry
-- that last changed these columns (`password_set`, `totp_enrolled`,
-- `reset_spent`) -- §0's "stopping the log stops the act" for the credential:
-- a credential state whose entry was never appended has no seq to name.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credential_seal bytea;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credential_row_version integer NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credential_seq bigint;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_credential_seal_is_32_bytes;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_credential_seal_is_32_bytes
    CHECK (credential_seal IS NULL OR octet_length(credential_seal) = 32);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_credential_row_version_is_positive;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_credential_row_version_is_positive
    CHECK (credential_row_version >= 1);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_credential_seq_is_positive;
ALTER TABLE accounts
    ADD CONSTRAINT accounts_credential_seq_is_positive
    CHECK (credential_seq IS NULL OR credential_seq >= 1);

-- ---------------------------------------------------------------------------
-- B. NO SEAL IS A STATE, AND IT IS THE STATE OF AN ACCOUNT WITH NO CREDENTIAL
--
-- An account that has never had a password or an app code -- every account
-- that existed before `0018`, and every account an operator creates today --
-- has nothing to seal. `NULL` means that, and the application reads it that
-- way. What must not exist is the third state: a credential set with no seal
-- over it, which is what a writer would produce by inserting a password hash
-- straight into the table.
--
-- Stated twice, once here and once in `src/credentials.rs`'s
-- `verify_credential_seal`, on the same "a policy layer and a privilege layer
-- failing together is less likely than either failing alone" discipline
-- `0014` §D states for `session_revocations`.
--
-- **A DEFERRED CONSTRAINT TRIGGER and not a `CHECK`, and the reason is not
-- style.** A `CHECK` is evaluated per statement and cannot be deferred, so it
-- forbids the intermediate state INSIDE an honest transaction: the act that
-- sets a first password writes the column and then the seal, and a per
-- statement rule fails between the two. Ordering the two writes the other way
-- round would work and would put a trap in every future path -- seal first or
-- be refused -- which is exactly the kind of rule that is obeyed for a year
-- and then is not. `DEFERRABLE INITIALLY DEFERRED` asks the question once, at
-- COMMIT, which is the only moment the answer means anything: a transaction
-- that ends with a credential and no seal over it is refused, however it got
-- there. `0009`'s append-only triggers are the same mechanism one table over.
--
-- It is also the rule at the point a `CHECK` could not reach: it applies to
-- every row a transaction touches from here on, including rows written before
-- this migration existed, and it needs no validating scan of the table --
-- which, behind `FORCE ROW LEVEL SECURITY`, is what conventions invariant 11
-- is about.
--
-- `operator_key_hold_until` is INSIDE the seal (section A) but is deliberately
-- NOT one of the columns that REQUIRES one: the hold is a fact about a seat,
-- it is written by a reset on accounts that may have no credential at all, and
-- an account with a hold and no password is not a credential state anybody can
-- sign in with.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_credential_seal_covers_a_credential;

CREATE OR REPLACE FUNCTION fathom_credential_seal_covers_a_credential() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.credential_seal IS NULL
       AND (NEW.password_hash IS NOT NULL
            OR NEW.totp_secret_ct IS NOT NULL
            OR NEW.totp_secret_nonce IS NOT NULL
            OR NEW.totp_secret_key_epoch IS NOT NULL
            OR NEW.totp_enrolled_at IS NOT NULL
            OR NEW.totp_last_step IS NOT NULL) THEN
        RAISE EXCEPTION
            'account % ends this transaction with a credential and no seal over it '
            '(migration 0025 section B)', NEW.id;
    END IF;
    RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS accounts_credential_seal_covers_a_credential ON accounts;
CREATE CONSTRAINT TRIGGER accounts_credential_seal_covers_a_credential
    AFTER INSERT OR UPDATE ON accounts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fathom_credential_seal_covers_a_credential();

-- ---------------------------------------------------------------------------
-- C. THE COLUMN GRANTS THE RUNTIME ROLE NEEDS
--
-- `0018` §E revoked table-wide UPDATE on `accounts` and granted the credential
-- columns one by one; these three are written by exactly the transactions that
-- write those, so they are granted the same way and no policy changes:
-- `accounts_credential_writable` (`0018` §E) already admits
-- `app.credential_custody`, `app.session_custody` and `app.reset_custody`, and
-- `accounts_disablable` (`0015`) already admits the operator-plane transaction
-- that clears a seat hold. A policy is per row; the column list is the fence
-- that says WHICH columns, and it is the only thing that has to move here.
--
-- No grant to any other role. `fathom_app` is the runtime login
-- (`0006_runtime_role.sql`), and the migration role owns the table.
-- ---------------------------------------------------------------------------
GRANT UPDATE (credential_seal, credential_row_version, credential_seq)
    ON accounts TO fathom_app;
