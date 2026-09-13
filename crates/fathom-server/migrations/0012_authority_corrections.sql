-- 0012 -- authority corrections: the genesis fence, the delay on a
-- single-steward weakening act, and the keyring seal that was scoped to the
-- wrong thing.
--
-- `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §§3.2, 3.4, 3.5, 6.1, 8.4;
-- `docs/PHASE-2-STORAGE-DESIGN.md` §12.2; `.context/conventions.md`
-- invariant 11.
--
-- **`0011` is not edited.** An applied migration's bytes are under a checksum
-- gate, so everything schema-side lands here, and the corrections to `0011`'s
-- own comments are written out below rather than made in place.
--
-- ---------------------------------------------------------------------------
-- A. WHAT `0011` SAYS THAT IS WRONG, QUOTED SO THE CORRECTION IS FINDABLE
-- ---------------------------------------------------------------------------
--
-- 1. `0011` lines 339-341, on `fathom_genesis_is_creation_only`:
--
--        `SECURITY DEFINER` with `search_path` pinned, because it reads a
--        table behind `FORCE ROW LEVEL SECURITY` -- §2's named trap: *"a
--        trigger function that reads a row-level-security-protected table must
--        be SECURITY DEFINER with a pinned search_path, or it runs as the
--        invoker, sees nothing, and passes vacuously."*
--
--    **This is backwards, and the trigger it describes enforced nothing.**
--    `SECURITY DEFINER` makes the function run as its OWNER. The owner of
--    `organisation_auth_head` is that same role, and `0011` puts
--    `FORCE ROW LEVEL SECURITY` on the table -- which exists precisely to make
--    the owner subject to the policies too. The `SELECT` policy compares
--    `organisation_id` against `current_setting('app.tenant_id', true)`, which
--    is NULL when no tenant context is set. So the `EXISTS` was false in
--    exactly the session a second genesis would be written from, and the
--    trigger returned `NEW`.
--
--    Demonstrated on a migrated database before this file was written: as the
--    bootstrap superuser, no tenant context, against an organisation whose
--    head stood at `auth_epoch = 2`, a second `is_genesis` row inserted
--    cleanly. `SECURITY DEFINER` is not a way to escape row security; only
--    `BYPASSRLS`, superuser, or not forcing RLS is, and none of those is what
--    this deployment wants on that table.
--
--    The trigger and its function are dropped below. What replaces them is in
--    section B.
--
-- 2. `0011` line 214's `account_keys` block, and `src/grants.rs`, sealed
--    keyring rows under the ORGANISATION row key. `account_keys` is keyed on
--    an account, and an account may be a member of two organisations, so the
--    row verified in whichever organisation enrolled it and nowhere else --
--    surfacing in the second as `Unverifiable`, an integrity alarm for a
--    forgery that had not happened. Section D is the correction.
--
-- ---------------------------------------------------------------------------
-- B. GENESIS IS CREATION-ONLY -- WHERE THAT IS ACTUALLY ENFORCED
-- ---------------------------------------------------------------------------
--
-- **No `CHECK` can read another table**, so no constraint in this database can
-- express *"there is no genesis grant after the organisation was created"*. A
-- constraint can only say what a genesis row must look like in isolation. That
-- is worth having and it is not the fence:
--
--   * `CHECK (NOT is_genesis OR auth_epoch = 1)` -- below. Epoch 1 happens once
--     per organisation, because `fathom_auth_head_only_advances` refuses a head
--     that does not advance. Belt-and-braces, binding at every privilege level
--     including `psql` as superuser, and cheap.
--
-- **The fence is the organisation's own chain.** `grants::bootstrap_organisation`
-- now mints each genesis grant's id, names it -- with its subject and subject
-- key fingerprint -- in the `org_genesis` entry's metadata, and seals that
-- entry BEFORE writing a single grant row. `grants::verify_genesis_set` runs
-- inside every `authorise_account` and refuses an organisation whose set of
-- `is_genesis` rows differs from what `org_genesis` names: missing, extra, or
-- a different subject.
--
-- So a genesis row written later is **unusable**, not merely late. It cannot be
-- named by an entry that was sealed before it existed, and re-sealing that
-- entry needs the organisation content key -- wrapped under the tenant key,
-- wrapped under the master key, which lives on a volume PostgreSQL cannot
-- read.
--
-- **The row still inserts.** Nothing here is unconstructible at the SQL level
-- and this file does not claim otherwise. What the attacker gets for the
-- insert is an organisation that authorises nobody at all, which is a louder
-- failure than the one they were aiming for.
--
-- `scope_grants_genesis_pair` from `0011` -- unique on
-- `(organisation_id, subject_id) WHERE is_genesis` -- **stays**. §6.1 signs
-- *"one or two genesis steward grants"*, so genesis is not capped at one row
-- per organisation; it is capped at one per subject.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS scope_grants_genesis_creation_only ON scope_grants;
DROP FUNCTION IF EXISTS fathom_genesis_is_creation_only();

ALTER TABLE scope_grants
    DROP CONSTRAINT IF EXISTS scope_grants_genesis_is_epoch_one;
ALTER TABLE scope_grants
    ADD CONSTRAINT scope_grants_genesis_is_epoch_one
    CHECK (NOT is_genesis OR auth_epoch = 1);

-- ---------------------------------------------------------------------------
-- C. PRE-RELEASE GUARD
--
-- Sections D and E change what a sealed row covers: `account_keys` moves to a
-- site-scoped row key, and both `grant_revocations` and `grant_suspensions`
-- gain a column the seal covers. Every authority row already written therefore
-- stops verifying, and there is no migration that could fix that -- the seals
-- are keyed, and recomputing them here would mean this migration forging the
-- statements it is supposed to be preserving.
--
-- Nothing has shipped, so the honest answer is to refuse rather than to
-- pretend. **A pre-release database with enrolled keys must be recreated.**
-- `account_keys` is the probe because it is the table the whole authority
-- rests on: no keyring row, no verifiable grant, no organisation. An empty
-- keyring means there is nothing to lose.
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
    -- `account_keys` is behind FORCE ROW LEVEL SECURITY and this migration
    -- runs with no tenant context, so a plain SELECT would return zero rows
    -- SILENTLY and this guard would pass vacuously -- which is invariant 11's
    -- failure shape, and is the same mistake section A quotes `0011` making.
    -- The NO FORCE / FORCE pair is LOAD-BEARING. Do not tidy it away.
    ALTER TABLE account_keys NO FORCE ROW LEVEL SECURITY;

    IF EXISTS (SELECT 1 FROM account_keys) THEN
        ALTER TABLE account_keys FORCE ROW LEVEL SECURITY;
        RAISE EXCEPTION
            'migration 0012 changes what an authority row seal covers: account_keys moves to a '
            'site-scoped row key, and grant_revocations and grant_suspensions gain a sealed '
            'takes_effect_at. Every row already sealed would stop verifying, and no migration '
            'can re-seal them without forging the statements it is meant to preserve. This '
            'database has enrolled keys. Nothing has shipped, so the answer is to RECREATE this '
            'pre-release database rather than migrate it.';
    END IF;

    ALTER TABLE account_keys FORCE ROW LEVEL SECURITY;
END
$guard$;

-- ---------------------------------------------------------------------------
-- D. THE KEYRING SEAL IS SITE-SCOPED
--
-- No DDL: the change is which key `src/grants.rs` derives the seal under.
-- Recorded here because the schema's meaning changed even though its shape did
-- not, and because section C's guard exists for this as much as for section E.
--
--     K_row_site = HKDF-Expand(site chain key, "fathom/chain/kdf/row/v1", 32)
--
-- **The label does not change and needs no new entry in storage §12.2.** A KDF
-- label separates USES of one key; what separates these two subkeys is the
-- input key, and the site chain key and an organisation chain key are already
-- independently derived from the chain master. A second label would suggest
-- they come from the same secret, which they do not.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- E. A SINGLE-STEWARD ACT THAT WEAKENS A STEWARD WAITS
--
-- §3.5's sole-steward appointment already waits 24 hours. Its mirror image did
-- not, and that asymmetry was a route to a steward nobody seconded:
--
--     one steward suspends the other -> the organisation now looks
--     single-stewarded -> the survivor appoints a third ALONE, as a
--     "sole steward" appointment -> the survivor lifts the suspension.
--
-- Two closures, and both are wanted. `AuthorityState::steward_count` counts a
-- SUSPENDED steward, so the count never falls to one in the first place. And
-- an act that removes or weakens another steward on one signature now takes
-- effect only after the same 24 hours, is marked `single_steward_act` in its
-- organisation-chain entry, and closes the sole-steward path while it is
-- pending.
--
-- `takes_effect_at` is NOT inside the signed `revoke_bytes` / `suspend_bytes`.
-- It is chosen by the server after the client has signed, and binding a
-- server-chosen value into bytes a client already signed is precisely the
-- defect that made the one-step `sign_grant` flaky. It is covered by the ROW
-- SEAL instead, which is the server's own statement and is verified at use.
--
-- Immediate, because none of these weakens anyone else: acting on a `read` or
-- `draw` grant, acting on your own grant, and lifting a suspension. The
-- `DEFAULT now()` therefore matches the common case, and the column is
-- NOT NULL so that "no delay" is a value rather than an absence.
-- ---------------------------------------------------------------------------
ALTER TABLE grant_revocations
    ADD COLUMN IF NOT EXISTS takes_effect_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE grant_suspensions
    ADD COLUMN IF NOT EXISTS takes_effect_at timestamptz NOT NULL DEFAULT now();

-- An act may not take effect before it was made.
ALTER TABLE grant_revocations
    DROP CONSTRAINT IF EXISTS grant_revocations_takes_effect_not_before;
ALTER TABLE grant_revocations
    ADD CONSTRAINT grant_revocations_takes_effect_not_before
    CHECK (takes_effect_at >= revoked_at);

ALTER TABLE grant_suspensions
    DROP CONSTRAINT IF EXISTS grant_suspensions_takes_effect_not_before;
ALTER TABLE grant_suspensions
    ADD CONSTRAINT grant_suspensions_takes_effect_not_before
    CHECK (takes_effect_at >= at);

-- Lifting a suspension is never delayed: it restores authority rather than
-- removing it, and a delayed unsuspend would be a second way to keep a steward
-- out of the count.
ALTER TABLE grant_suspensions
    DROP CONSTRAINT IF EXISTS grant_suspensions_unsuspend_is_immediate;
ALTER TABLE grant_suspensions
    ADD CONSTRAINT grant_suspensions_unsuspend_is_immediate
    CHECK (action <> 'unsuspend' OR takes_effect_at = at);

-- The runtime role writes these rows on the append-only path and must not be
-- able to rewrite the delay afterwards. `0011` already revoked UPDATE and
-- DELETE on both tables from `fathom_app`; a new column inherits nothing, so
-- there is nothing to re-revoke. Stated here so the next reader does not have
-- to go and check.
