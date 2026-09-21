-- 0019 -- ADR-0055 decisions 1-5, 8: the address is the identity, the operator
-- custody is a fact an account holds, quorum floors at one live operator, and
-- a first-operator setup token replaces browser-key enrolment for the
-- bootstrap seat. Stream (b) of
-- docs/archive/2026-09-21-adr-0055-build-contracts.md.
--
-- `docs/decisions/adr-0055-one-person-two-custodies.md` decisions 1-5, 8, 10
-- (the setup screen); `crates/fathom-server/migrations/0015_operator_console.sql`
-- for the shape this file extends; `.context/conventions.md` invariant 11.
--
-- **0013, 0014, 0015, 0017 and 0018 are not edited and must never be.**
--
-- ---------------------------------------------------------------------------
-- REPORTED DEPARTURE FROM THE ADR'S LITERAL TEXT
-- ---------------------------------------------------------------------------
--
-- ADR-0055 decision 1 says "`operators.account_id`". **This file does not add
-- that column.** `operators.row_seal` covers five fields today
-- (`operators.rs::operator_row_seal`: id, display_name, created_by,
-- created_seq, disabled_at) and is computed under a key not in PostgreSQL. A
-- column added OUTSIDE that seal is a column whoever holds the database can
-- rewrite with nothing to catch it -- exactly the takeover the seal exists to
-- close, and exactly what an operator's own identity binding must never be.
-- A column added INSIDE the seal needs every existing operator row re-sealed,
-- and a migration cannot do that: the row key is derived from the chain
-- master, which the migration role does not hold (by design -- the same
-- argument `0015` §B2 makes for why a trigger could not stand in for a
-- foreign key). Re-sealing has to be an application act, in a transaction
-- that holds the key, which a `.sql` file run by `migrate.rs` is not.
--
-- **What is built instead** carries the same property without re-touching the
-- sealed five: a SEPARATE, append-only, independently sealed table naming the
-- fact "operator X is bound to account Y", written once, at the moment the
-- binding is created, and never updated. It is a smaller `site_install`
-- (`0015` §C) with a seal instead of a trigger doing the real work -- the
-- trigger below is defence in depth, stated exactly as `0015` §C states it
-- twice, but the seal is what a tier-3 attacker cannot forge.
--
-- ---------------------------------------------------------------------------
-- A. THE BINDING
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operator_account_bindings (
    operator_id  text        PRIMARY KEY REFERENCES operators(id) ON DELETE RESTRICT,
    -- One account holds at most one operator custody at a time (decision 1:
    -- "the session carries both principals when the account holds the
    -- operator custody"). Handoff (decision 5) never rewrites a binding: the
    -- successor gets a NEW operator row and a NEW binding, and the
    -- predecessor's operator row is disabled. A binding therefore never
    -- needs an `UPDATE`, which is why it can be append-only rather than
    -- merely audited.
    account_id   text        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT UNIQUE,

    bound_seq    bigint      NOT NULL CHECK (bound_seq >= 1),
    bound_at     timestamptz NOT NULL DEFAULT now(),

    row_version  integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal     bytea       NOT NULL CHECK (octet_length(row_seal) = 32)
);

CREATE OR REPLACE FUNCTION fathom_operator_account_binding_is_immutable() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    RAISE EXCEPTION
        'an operator-account binding is written once and never changed: % on % is refused '
        '(ADR-0055 decision 1)', TG_OP, TG_TABLE_NAME;
END
$fn$;

DROP TRIGGER IF EXISTS operator_account_bindings_immutable ON operator_account_bindings;
CREATE TRIGGER operator_account_bindings_immutable
    BEFORE UPDATE OR DELETE ON operator_account_bindings
    FOR EACH ROW EXECUTE FUNCTION fathom_operator_account_binding_is_immutable();

DROP TRIGGER IF EXISTS operator_account_bindings_no_truncate ON operator_account_bindings;
CREATE TRIGGER operator_account_bindings_no_truncate
    BEFORE TRUNCATE ON operator_account_bindings
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_operator_account_binding_is_immutable();

ALTER TABLE operator_account_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_account_bindings FORCE  ROW LEVEL SECURITY;

-- Read wherever an operator's identity is resolved (console, sign-in); written
-- only under operator custody, at bootstrap or at `operator_enrolled`-adjacent
-- creation, never under redemption -- redemption enrols a KEY, not an
-- account binding, so `app.enrolment_custody` gets no policy here at all.
CREATE POLICY operator_account_bindings_readable ON operator_account_bindings
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes'
                      OR current_setting('app.session_custody', true) = 'yes');
CREATE POLICY operator_account_bindings_insertable ON operator_account_bindings
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');

REVOKE UPDATE, DELETE ON operator_account_bindings FROM fathom_app;

-- ---------------------------------------------------------------------------
-- B. THE FIRST-OPERATOR SETUP TOKEN -- DECISION 10's LAST BULLET
--
-- `enrolment_tokens.purpose` (`0015` §E) gains a fourth value, `setup`,
-- sharing `operator_id` with `purpose = 'operator'` rather than adding a
-- column: both name the operator the token is FOR, and the two purposes
-- differ only in what redeeming does -- `operator` enrols a browser key
-- (§4.5's now-narrower remaining case, kept for the passkey step NEXT.md item
-- 4 still holds open), `setup` opens the screen that sets a password, enrols
-- TOTP and shows the ten backup codes (decision 10). `bootstrap_first_operator`
-- issues `setup`, not `operator`, from this migration forward -- a code
-- change, named in the contracts document, not a schema one.
-- ---------------------------------------------------------------------------
ALTER TABLE enrolment_tokens DROP CONSTRAINT IF EXISTS enrolment_tokens_purpose_check;
ALTER TABLE enrolment_tokens
    ADD CONSTRAINT enrolment_tokens_purpose_check
    CHECK (purpose IN ('account', 'operator', 'organisation', 'setup'));

ALTER TABLE enrolment_tokens DROP CONSTRAINT IF EXISTS enrolment_tokens_operator_id_check;
ALTER TABLE enrolment_tokens
    ADD CONSTRAINT enrolment_tokens_operator_id_check
    CHECK ((purpose IN ('operator', 'setup')) = (operator_id IS NOT NULL));

-- ---------------------------------------------------------------------------
-- C. THE QUORUM FLOOR -- THE SCOUT'S "NOTHING BUT A BANNER" RISK, CLOSED AT
--    THE SCHEMA LAYER
--
-- Decision 4: two operators is the standing expectation, and the server warns
-- rather than blocks. Decision 3 retires `FATHOM_SINGLE_OPERATOR` into a
-- count over live (`disabled_at IS NULL`) operators -- a query, not a column
-- (`operators.rs`'s `steward_count`-shaped read, `grants.rs:2767`'s pattern
-- carried over), so this file adds NO column for it.
--
-- What it does add: `disable_operator` (`operators.rs:1765`) checks only that
-- an operator is not disabling themselves. Nothing stops two live operators
-- disabling each other down to zero, one call at a time, with only a banner
-- noticing after the fact. A `CHECK` cannot see other rows; a trigger can.
-- **`SECURITY DEFINER`, search path pinned**, for the same reason
-- `fathom_seconder_is_independent` needs it (`0015` §G): `operators` sits
-- behind `FORCE ROW LEVEL SECURITY`, so a plain trigger counting rows would
-- see none and refuse nothing.
--
-- This is a floor of ONE, not of two: decision 4 is a standing expectation,
-- not a requirement, and the design already accepts a sole operator as a real
-- and supported shape (decision 3, the whole `min(2, live)` argument).
-- Refusing the drop to ZERO is the one case that is not a policy choice --
-- it is a lockout with no recovery route this file's stream leaves open
-- (recovery is `fathom-server recover-operator`, decision 8, cost/order
-- session 2, out of this migration's scope: a host command, not a schema
-- change).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fathom_operator_floor() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
    live_count bigint;
BEGIN
    IF NEW.disabled_at IS NULL OR OLD.disabled_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT count(*) INTO live_count FROM operators WHERE disabled_at IS NULL;

    IF live_count <= 1 THEN
        RAISE EXCEPTION
            'disabling the last live operator is refused: the deployment would have none '
            '(ADR-0055 decision 4; recover with `fathom-server recover-operator`)';
    END IF;

    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS operators_floor ON operators;
CREATE TRIGGER operators_floor
    BEFORE UPDATE ON operators
    FOR EACH ROW EXECUTE FUNCTION fathom_operator_floor();

-- ---------------------------------------------------------------------------
-- D. ONE NEW SITE ENTRY TYPE -- DECISION 8's BREAK-GLASS RECORD
--
-- `operator_recovered_from_host`: `fathom-server recover-operator` runs where
-- the key volume is mounted and folds `reissue-bootstrap-token` into it
-- (decision 8). Added now, with the rest of this stream's entry types, so the
-- CLI's own build (session 2, not this migration) has the row to write
-- against rather than needing a THIRD credentials migration for one type.
--
-- Extended by `DROP CONSTRAINT` then `ADD CONSTRAINT`, wrapped in the
-- invariant-11 `NO FORCE` / `FORCE` pair, on top of `0018`'s version of the
-- constraint (this file runs after it).
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
                                'password_set', 'totp_enrolled',
                                'reset_requested', 'reset_spent',
                                'backup_code_used',
                                -- ADR-0055, this file's section D.
                                'operator_recovered_from_host'))
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
