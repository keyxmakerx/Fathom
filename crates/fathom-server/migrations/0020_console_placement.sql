-- 0020 -- ADR-0055 decisions 9 and 11: the console lives on its own host, set
-- from the console itself, guarded by confirm-or-revert rather than by the
-- delay §5.3 gives every other setting. Stream (c) of
-- docs/archive/2026-09-21-adr-0055-build-contracts.md. SMTP itself needs no
-- new table -- `site_settings_versions` (`0015` §F) already holds an
-- arbitrary sealed value under a key, and `smtp` is one more `key`. Said here
-- so nobody goes looking for a table that was never going to exist.
--
-- `docs/decisions/adr-0055-one-person-two-custodies.md` decision 11;
-- `.context/conventions.md` invariant 11.
--
-- **0013 through 0019 are not edited and must never be.**
--
-- ---------------------------------------------------------------------------
-- WHY PLACEMENT IS ITS OWN TABLE AND NOT A `site_settings_versions` ROW
-- ---------------------------------------------------------------------------
--
-- §5.3's interlock (`0015` §F/§G) makes a change wait: two operators (or one,
-- in single-operator mode, with the delay kept), 24 hours, the old value
-- stays live throughout. Decision 11 says placement's risk runs the other
-- way -- "tightening it gains an attacker nothing and loosening it already
-- needs an operator session" -- so placement APPLIES AT ONCE and is guarded
-- by **confirm or revert** instead: sealed immediately, then either an
-- operator signs in on the new host inside a window, or the placement reverts
-- itself. `site_settings_versions.sealed_seq` is nullable because a request
-- there is not yet a fact; here it is `NOT NULL` from the row's first moment,
-- because a placement change is a fact the instant it is written -- the
-- window that follows decides whether it STAYS a fact, not whether it BECOMES
-- one. Reusing one table for two different shapes of interlock would mean a
-- reader has to know which shape a row is before reading it.
--
-- ---------------------------------------------------------------------------
-- A. THE PLACEMENT ROW
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS console_placements (
    id             text        PRIMARY KEY CHECK (char_length(id) = 26),

    -- Comma-separated host names / CIDR sources, in `config::admin_hosts` and
    -- `admin_sources`'s own parsed forms -- this table stores what the
    -- operator typed, and `admin_exposure::AdminExposure` parses it exactly
    -- as it parses the environment variables today, so one parser serves
    -- both origins.
    hosts          text        NOT NULL CHECK (char_length(hosts) BETWEEN 1 AND 2000),
    sources        text        NOT NULL CHECK (char_length(sources) BETWEEN 1 AND 2000),

    -- The window this change was made under, captured on the row so a
    -- historical placement shows what applied to IT, even after the site
    -- setting `console_placement_window_seconds` (an ordinary
    -- `site_settings_versions` key, first-version-applies-immediately, later
    -- changes take §5.3's own delay and quorum) is later changed. Decision 11:
    -- default 5 minutes, 1 to 60, and it cannot be turned off -- the `CHECK`
    -- states the bound the setting's own validation must also enforce, so a
    -- row cannot exist outside it even if the application-layer check is ever
    -- wrong.
    window_seconds integer     NOT NULL CHECK (window_seconds BETWEEN 60 AND 3600),

    requested_by   text        NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
    request_sig    bytea       NOT NULL CHECK (octet_length(request_sig) = 64),
    requested_seq  bigint      NOT NULL CHECK (requested_seq >= 1),
    requested_at   timestamptz NOT NULL DEFAULT now(),

    confirm_by     timestamptz NOT NULL,
    confirmed_by   text        REFERENCES operators(id) ON DELETE RESTRICT,
    confirmed_at   timestamptz,
    confirmed_seq  bigint,

    reverted_at    timestamptz,
    reverted_seq   bigint,
    -- Set by `fathom-server console-placement --reset` (decision 11's last
    -- sentence) as well as by the window's own expiry sweep -- both write
    -- this column, and `reason` says which. The CLI path runs on the host,
    -- holds the site chain key directly (it is the same binary `main.rs`
    -- is), and needs no operator session; the sweep runs inside the server
    -- under `app.operator_custody`-shaped access. Both are reported to the
    -- lead as needing their own privilege story in the contracts document --
    -- this migration does not choose which role the CLI connects as.
    revert_reason  text        CHECK (revert_reason IS NULL
                                       OR revert_reason IN ('window_expired', 'host_reset')),

    -- **Applies at once, per decision 11**, so `sealed_seq` is `NOT NULL`
    -- from the first `INSERT` -- unlike `site_settings_versions`, where it is
    -- the interlock a PENDING row waits to gain.
    sealed_seq     bigint      NOT NULL,

    row_version    integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal       bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    CHECK ((confirmed_at IS NULL) = (confirmed_seq IS NULL)),
    CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
    CHECK ((reverted_at IS NULL) = (reverted_seq IS NULL)),
    CHECK ((reverted_at IS NULL) = (revert_reason IS NULL)),
    -- Confirmed and reverted are exclusive: a placement that was confirmed
    -- did not then also time out, and a reverted one was never confirmed --
    -- either is a contradiction, the same shape `0015` §F gives applied vs
    -- cancelled.
    CHECK (confirmed_at IS NULL OR reverted_at IS NULL),
    CHECK (confirm_by > requested_at)
);

CREATE INDEX IF NOT EXISTS console_placements_confirm_by_idx
    ON console_placements (confirm_by) WHERE confirmed_at IS NULL AND reverted_at IS NULL;

-- ---------------------------------------------------------------------------
-- B. ROW-LEVEL SECURITY
--
-- `app.operator_custody` only. There is no redemption path onto this table
-- (placement is never set by an unauthenticated caller) and no session-custody
-- branch (placement is not resolved during sign-in the way an operator row
-- is) -- the narrowest of the three custodies `0015` §H names, because this
-- table has exactly one legitimate writer.
-- ---------------------------------------------------------------------------
ALTER TABLE console_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_placements FORCE  ROW LEVEL SECURITY;

CREATE POLICY console_placements_readable ON console_placements
    FOR SELECT USING (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY console_placements_insertable ON console_placements
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY console_placements_updatable ON console_placements
    FOR UPDATE USING (current_setting('app.operator_custody', true) = 'yes')
            WITH CHECK (current_setting('app.operator_custody', true) = 'yes');

-- **The console-host flag itself must be readable with NO custody at all.**
-- Decision 9: the server tells the client whether the host it was served on
-- is a console host, on every host, including the ones with no operator
-- session and no operator anywhere near them -- the opposite shape from
-- `admin_exposure`, which 404s everywhere BUT the console host (the scout's
-- CONFIRMED finding: a flag placed under `/admin` is 404 exactly where the
-- answer "no" is needed). A live, uncustodied `SELECT hosts, sources FROM
-- console_placements WHERE confirmed_at IS NOT NULL OR (reverted_at IS NULL
-- AND confirmed_at IS NULL) ORDER BY requested_at DESC LIMIT 1` cannot be
-- satisfied by ANY policy above, so this file gives the unauthenticated flag
-- route ITS OWN capability rather than punching a hole in operator custody.
CREATE POLICY console_placements_readable_for_the_flag ON console_placements
    FOR SELECT USING (current_setting('app.placement_flag', true) = 'yes');

REVOKE UPDATE, DELETE ON console_placements FROM fathom_app;
GRANT UPDATE (confirmed_by, confirmed_at, confirmed_seq,
              reverted_at, reverted_seq, revert_reason,
              row_version, row_seal)
    ON console_placements TO fathom_app;

-- ---------------------------------------------------------------------------
-- C. THREE NEW SITE ENTRY TYPES
--
-- `console_placement_requested`, `console_placement_confirmed`,
-- `console_placement_reverted` -- decision 11 names all three by their entry
-- names in prose; this is the schema for them. Extended by `DROP CONSTRAINT`
-- then `ADD CONSTRAINT`, wrapped in the invariant-11 `NO FORCE` / `FORCE`
-- pair, on top of `0019`'s version.
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
                                -- ADR-0055, this file's section C.
                                'console_placement_requested',
                                'console_placement_confirmed',
                                'console_placement_reverted'))
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
