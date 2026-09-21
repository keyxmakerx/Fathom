-- 0023 -- ADR-0055 stream (b): the quorum a sole operator can actually reach,
-- the address a colleague is invited at, and the operator key an account
-- registers with its password behind it.
--
-- `docs/decisions/adr-0055-one-person-two-custodies.md` decisions 3, 5 and 10;
-- `docs/archive/2026-09-21-adr-0055-build-contracts.md` stream (b); the lead's
-- resolutions 5, 9 and 10 of that document's open issues (2026-09-21).
--
-- **0013, 0014, 0015, 0017, 0018, 0019, 0020 and 0021 are not edited and must
-- never be.** Everything below is expressed as `DROP CONSTRAINT` /
-- `ADD CONSTRAINT` or `ADD COLUMN IF NOT EXISTS` on top of what they left.
--
-- ---------------------------------------------------------------------------
-- A. A ROW STAMPED `single_operator = true` MAY STILL BE SECONDED LATER
--
-- `0015` §E gave both `site_settings_versions` and `operator_requests` an
-- unnamed
--
--     CHECK (NOT single_operator OR seconded_by IS NULL)
--
-- on the argument that *"a row that claims both a seconder and single-operator
-- mode is claiming two different reasons for the same change"*. That was true
-- while `single_operator` was a deployment-wide switch read from the
-- environment: the two states were mutually exclusive for the life of a
-- process.
--
-- ADR-0055 decision 3 retires the switch and makes the quorum
-- `min(2, live independent operators)` -- a number that CHANGES while a row
-- sits inside its delay, because a second operator can sign in during it. The
-- old `CHECK` then has a consequence nobody chose, and
-- `tests/operators.rs::single_operator_is_re_evaluated_at_apply_not_remembered_from_the_request`
-- already reported it as a second, narrower bug on 2026-09-21: a request
-- stamped under quorum 1 that outlives the arrival of a second operator can be
-- refused for ever and never seconded, because the column that records what
-- was true at request time forbids the seconding that would satisfy what is
-- true now. The row is unreachable in both directions.
--
-- The stamp stays -- it is a sealed record of the quorum in force when the
-- request was made, and `request_seal` covers it -- and it stops being a bar
-- to the act that resolves the row. What decides whether a change applies is
-- `apply_if_due` / `apply_operator_request` re-reading the LIVE quorum, which
-- is where it already was (both functions' own comments, 2026-09-21).
--
-- The constraints are unnamed in `0015`, so they are found by what they SAY
-- rather than by a generated name -- `0009` §C's own pattern for dropping a
-- constraint it did not name.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.conrelid::regclass AS tbl, c.conname
          FROM pg_constraint c
         WHERE c.contype = 'c'
           AND c.conrelid IN ('site_settings_versions'::regclass,
                              'operator_requests'::regclass)
           AND pg_get_constraintdef(c.oid) LIKE '%single_operator%'
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- B. THE COLLEAGUE'S ADDRESS, TAKEN AT REQUEST TIME
--
-- ADR-0055 decision 5 (handoff) and the lead's resolution 5: `POST
-- /admin/operators` takes the colleague's address with the request, and at
-- apply time the account shell is created for that address, the sealed
-- binding is written, and the invitation is a purpose `setup` token. The
-- alternative -- collecting the address at the new operator's own first
-- sign-in -- would mean the invitation had nowhere to go and no address to
-- check a redemption against.
--
-- **Inside the row seal, and that is the point.** `request_seal`
-- (`operators.rs`) covers it from this migration forward. An address outside
-- the seal is an address whoever holds the database can rewrite between the
-- request and the apply -- which is the invitation being redirected to a
-- mailbox the attacker controls, for a row two operators already signed.
--
-- **Consequence, stated rather than discovered:** an `operator_requests` row
-- written BEFORE this migration has no address, and its stored seal does not
-- cover the new field, so it will not verify afterwards and reads as
-- `Unverifiable`. The register is days old (ADR-0055 is accepted 2026-09-21,
-- the same day `0019` landed), a pending request lives for 24 hours, and the
-- alternative -- a seal whose covered fields depend on when the row was
-- written -- is the kind of conditional that rots into a forgery. The
-- default is the empty string so the column can be `NOT NULL`; the
-- application refuses to write one.
-- ---------------------------------------------------------------------------
ALTER TABLE operator_requests
    ADD COLUMN IF NOT EXISTS address text NOT NULL DEFAULT '';

ALTER TABLE operator_requests DROP CONSTRAINT IF EXISTS operator_requests_address_is_bounded;
ALTER TABLE operator_requests
    ADD CONSTRAINT operator_requests_address_is_bounded
    CHECK (char_length(address) <= 320);

-- ---------------------------------------------------------------------------
-- C. ONE NEW SITE ENTRY TYPE -- THE OPERATOR KEY AN ACCOUNT REGISTERS
--
-- `operator_enrolled` (`0015` §F) records an operator redeeming an INVITATION
-- and getting their first browser key with it: the token is the authority, and
-- there is no password anywhere in that act. ADR-0055 decision 1 and the
-- lead's resolution 8 add the other way an operator key comes to exist: an
-- account that already holds the operator custody, signed in with its address,
-- its password and its app code, registering a key for the browser it is
-- sitting at (`POST /admin/operators/self/key`).
--
-- Two acts, two types, because an auditor reading the trail has to be able to
-- tell "somebody redeemed a one-shot token" from "somebody who knew the
-- password and the app code registered a key", and a `via` field inside one
-- type's metadata would put that distinction behind the chain key while the
-- type itself stayed in the clear. The metadata carries `via` as well, for the
-- reader who holds the key.
--
-- **And a second type, `operator_seat_hold_cleared`.** `0021` added
-- `accounts.operator_key_hold_until` and ADR-0055 decision 7 gives it two
-- ends: the clock, and *"another operator's confirmation"*. The clock needs
-- no record -- it is the absence of an act. The confirmation is an act by an
-- operator that shortens a control, which is precisely the class of thing
-- §7.2 wants sealed, and there was no existing type that says it: reusing
-- `operator_recovered_from_host` would raise decision 8's seven-day banner
-- for an act that is the opposite of a recovery.
--
-- Extended by `DROP CONSTRAINT` then `ADD CONSTRAINT`, wrapped in the
-- invariant-11 `NO FORCE` / `FORCE` pair, on top of `0020`'s version of the
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
                                'operator_recovered_from_host',
                                'console_placement_requested',
                                'console_placement_confirmed',
                                'console_placement_reverted',
                                -- ADR-0055 stream (b), this file's section C.
                                'operator_key_enrolled',
                                'operator_seat_hold_cleared'))
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

-- ---------------------------------------------------------------------------
-- D. A REPORTED DEFECT IN `0019` §B, CLOSED HERE BECAUSE A SHIPPED MIGRATION
--    IS NEVER EDITED
--
-- `0015` §E gave `enrolment_tokens` an UNNAMED
--
--     CHECK ((purpose = 'operator') = (operator_id IS NOT NULL))
--
-- which PostgreSQL called `enrolment_tokens_check1`. `0019` §B widened that
-- rule for the new `setup` purpose and wrote it as
-- `enrolment_tokens_operator_id_check`, preceded by
-- `DROP CONSTRAINT IF EXISTS enrolment_tokens_operator_id_check` -- a name
-- that did not exist yet, so the DROP found nothing and `0015`'s unnamed
-- original stayed. Both constraints are live, and they disagree: a `setup`
-- token names an operator, which the new one requires and the old one
-- forbids.
--
-- It was green when `0019` landed because nothing issued a `setup` token yet.
-- The first thing that does is `bootstrap_first_operator` in this same stream,
-- and it fails with `23514` on `enrolment_tokens_check1` -- found by running
-- it, 2026-09-21, not by reading it.
--
-- Dropped by what it SAYS rather than by the generated name, `0009` §C's
-- pattern and this file's own §A: a name PostgreSQL chose is a name that moves
-- if the table is ever rebuilt. `0019` is not edited.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.conname
          FROM pg_constraint c
         WHERE c.contype = 'c'
           AND c.conrelid = 'enrolment_tokens'::regclass
           AND c.conname <> 'enrolment_tokens_operator_id_check'
           AND pg_get_constraintdef(c.oid) LIKE '%operator_id IS NOT NULL%'
    LOOP
        EXECUTE format('ALTER TABLE enrolment_tokens DROP CONSTRAINT %I', r.conname);
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- E. THE HOLD IS CLEARED UNDER THE ACCOUNT CUSTODY, NOT A NEW ONE
--
-- `0021` added `accounts.operator_key_hold_until` and granted the runtime role
-- `UPDATE (operator_key_hold_until)`. Clearing it early is another operator's
-- act (`POST /admin/operators/{id}/confirm-recovery`), and that path takes
-- `app.account_custody` exactly as `set_account_disabled` does -- which is
-- what `accounts_disablable` (`0013` §A) and `accounts_readable` already
-- admit. **No new policy is written here**, deliberately: a third custody on
-- `accounts` would be a third thing to reason about for an act the second one
-- already describes, and the column grant is what keeps that custody to the
-- one column plus `disabled_at`.
--
-- Stated so that the absence is a decision and not an oversight.
-- ---------------------------------------------------------------------------
