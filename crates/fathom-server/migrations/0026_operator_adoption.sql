-- 0026 -- one new site entry type: the operator a pre-ADR-0055 build created,
-- adopted on the first start of a build that has decision 1.
--
-- `docs/decisions/adr-0055-one-person-two-custodies.md` decisions 1, 8 and 9.
-- Written 2026-09-21, after the shape was observed on a real deployment that
-- had done its first start under the build before ADR-0055.
--
-- **What was wrong.** Decision 1 -- *"the address is the identity"* -- made
-- the first start create an account for `FATHOM_OPERATOR_NOTICE_ADDRESS`, an
-- operator, and a sealed row in `operator_account_bindings` between them. A
-- deployment installed before that has the operator row and the `site_install`
-- row (`0015` §C) and no binding. On the new build
-- `bootstrap_first_operator` answers `AlreadyBootstrapped` and stops, so
-- nobody can sign in; and `fathom-server recover-operator <address>` resolves
-- an address THROUGH the binding (decision 8's own rule, so that a display
-- name an operator chose cannot point a recovery at a seat nobody expects), so
-- it refuses with "no operator is bound to that address" and mints nothing.
-- The deployment is shut out with no route back that is not a restore, which
-- is the lockout the whole ADR exists to remove.
--
-- **Why a type of its own, and not `operator_bootstrapped`.** No operator is
-- created by an adoption: the row already existed, and its seal and its
-- creating entry are verified before anything rests on it. An auditor reading
-- the site chain has to be able to tell "this deployment's first operator was
-- minted here" from "this deployment's existing operator was bound to an
-- address and dispossessed of what the older flow left it", and a `reason`
-- field inside one type's metadata would put that distinction behind the
-- chain key while the type itself stayed in the clear -- `0023` §C's argument
-- for `operator_key_enrolled`, and the same answer.
--
-- It is not `operator_recovered_from_host` either: that type raises decision
-- 8's seven-day banner on every operator session, and an upgrade is not a
-- break-glass.
--
-- The adoption is loud in the same way a recovery is. Its metadata carries the
-- operator, the notice address, and the counts of what it took away --
-- `retired_keys`, `ended_sessions`, `expired_tokens` -- and the entry is
-- appended BEFORE any of those writes, so a failure to record stops the act.
-- What it takes away is what ADR-0055 decision 9 says has no second factor
-- behind it: an operator key enrolled by the older flow was registered from a
-- one-shot token with no app code anywhere in the act, and decision 9 has the
-- operator key register only from the console with a confirmed app code.
--
-- **0013, 0014, 0015, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024 and 0025
-- are not edited and must never be.** The constraint below is `0023` §C's
-- version, re-created with one string added to the site list, by the same
-- `DROP CONSTRAINT` / `ADD CONSTRAINT` path that file used.
--
-- Mirrored by `EntryType::kinds()` in `src/chain.rs`.
--
-- ---------------------------------------------------------------------------
-- A. THE ENTRY-TYPE CHECK, RE-CREATED WITH `operator_adopted`
--
-- Wrapped in the invariant-11 `NO FORCE` / `FORCE` pair: a migration runs with
-- no tenant context, and `chain_entries` is behind `FORCE ROW LEVEL
-- SECURITY`. The pair is load-bearing -- an `ADD CONSTRAINT` revalidates the
-- table's existing rows, and under forced RLS it would see none of them.
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
                                'operator_key_enrolled',
                                'operator_seat_hold_cleared',
                                -- This file's section A.
                                'operator_adopted'))
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
