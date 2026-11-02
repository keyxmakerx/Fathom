-- 0071 -- team roles with a title and powers a root Steward sets (ADR-0081 "Later" item 3,
-- brought forward by sign-off card r102-plan-approval version 2, from the owner's note of
-- 2 November 2026: "they should be able to set the title and permissions of the role, we are
-- just adding it by default").
--
-- Number 0071, claimed through the layout thread; 0068 to 0070 are held by other pull requests
-- and none of them re-lists the entry types. Whichever merges after this must carry
-- `team_role_defined` forward in its list.
--
-- A. A ROLE IS A NAME FOR A SET OF POWERS. Three come ready-made, with fixed ids:
--   `lead` (shown as Lead), `overseer` (Supervisor; `.context/conventions.md` reserves the other
--   word) and `tech` (Maintenance tech). A root Steward may add a role, whose id is a ULID, and
--   may change any role's title or powers, ready-made ones included, or retire it. Powers come
--   from one fixed list (`src/roles.rs`): assign, due_dates, approve_plans, members, history,
--   emergency_start. No power reaches a folder: access still comes only from grants, so a role
--   never widens what anyone can see (ADR-0081 §3.7 constraint 3).
--
-- B. `team_role_defs` is the log of definitions, append-only at three levels exactly as
--   `team_acts` is: no UPDATE/DELETE privilege, the append-only trigger, and the row seal plus
--   the authority head's digest. Each row is the whole definition at that point; the latest
--   counting row for a role is its definition from that chain position on. Deleting a row would
--   bring back an older definition, possibly with a power since taken away, so the rows are in
--   the head's digest and a missing row refuses the organisation's authority.
--
-- C. `team_acts.role` now takes any role id, not only `lead` and `overseer`. Whether the role
--   exists and is not retired is checked by the server at the act's chain position.
--   `signer_authority = 'lead'` keeps its name and now means "by a role on this team that has
--   the members power"; the CHECKs that limit it to member acts on someone else stand.
--
-- D. Entry types: 0067's list plus `team_role_defined`.

-- ---------------------------------------------------------------------------
-- A, B. team_role_defs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_role_defs (
    id               text        PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    role             text        NOT NULL
                                 CHECK (role IN ('lead', 'overseer', 'tech')
                                        OR role ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    title            text        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 40),
    -- The powers, comma-separated, in the fixed list's order, each at most once. The server
    -- writes and checks the canonical form; this states the alphabet.
    powers           text        NOT NULL
                                 CHECK (powers ~ '^((assign|due_dates|approve_plans|members|history|emergency_start)(,(assign|due_dates|approve_plans|members|history|emergency_start))*)?$'),
    retired          boolean     NOT NULL,

    signed_by        text        NOT NULL,
    signer_kind      text        GENERATED ALWAYS AS ('steward') STORED,
    signer_key_fpr   bytea       NOT NULL CHECK (octet_length(signer_key_fpr) = 32),
    signature        bytea       NOT NULL CHECK (octet_length(signature) = 64),
    at_unix          bigint      NOT NULL,
    auth_epoch       integer     NOT NULL CHECK (auth_epoch >= 1),

    chain_seq        bigint      NOT NULL CHECK (chain_seq >= 1),
    row_seal         bytea       NOT NULL CHECK (octet_length(row_seal) = 32),
    created_at       timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (signed_by, signer_kind) REFERENCES principals (id, kind),
    -- A ready-made role can be changed but never retired.
    CHECK (NOT retired OR role NOT IN ('lead', 'overseer', 'tech'))
);
CREATE INDEX IF NOT EXISTS team_role_defs_organisation_idx
    ON team_role_defs (organisation_id, chain_seq);

CREATE TRIGGER team_role_defs_append_only
    BEFORE UPDATE OR DELETE ON team_role_defs
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
CREATE TRIGGER team_role_defs_no_truncate
    BEFORE TRUNCATE ON team_role_defs
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

ALTER TABLE team_role_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_role_defs FORCE  ROW LEVEL SECURITY;
CREATE POLICY team_role_defs_readable ON team_role_defs
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY team_role_defs_insertable ON team_role_defs
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
REVOKE UPDATE, DELETE ON team_role_defs FROM fathom_app;

GRANT SELECT ON team_role_defs TO fathom_operator;
CREATE POLICY team_role_defs_readable_by_operator_plane ON team_role_defs
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');

-- ---------------------------------------------------------------------------
-- C. Any role id on a team act.
-- ---------------------------------------------------------------------------
ALTER TABLE team_acts DROP CONSTRAINT team_acts_role_check;
ALTER TABLE team_acts
    ADD CONSTRAINT team_acts_role_check
    CHECK (role IN ('lead', 'overseer', 'tech') OR role ~ '^[0-9A-HJKMNP-TV-Z]{26}$');

-- ---------------------------------------------------------------------------
-- D. Entry types.
-- ---------------------------------------------------------------------------
ALTER TABLE chain_entries NO FORCE ROW LEVEL SECURITY;

ALTER TABLE chain_entries
    DROP CONSTRAINT IF EXISTS chain_entries_type_belongs_to_kind;

ALTER TABLE chain_entries
    ADD CONSTRAINT chain_entries_type_belongs_to_kind
    CHECK (
        (chain_kind = 'design'
             AND entry_type IN ('create', 'update', 'reencrypt', 'change'))
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
                                'operator_adopted',
                                -- 0046.
                                'ai_switch_changed', 'ai_key_disabled',
                                -- 0049.
                                'account_renamed',
                                -- 0062.
                                'firmware_server_settings_changed',
                                'firmware_ceiling_changed'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced',
                                'firmware_staged', 'firmware_fetch_issued',
                                'firmware_fetch_redeemed',
                                'invitation_issued', 'invitation_closed',
                                'firmware_models_changed',
                                -- 0041.
                                'type_it_yourself_set',
                                -- 0042.
                                'vault_key_enrolled', 'vault_key_superseded',
                                'vault_entry_created', 'vault_shared',
                                'vault_share_revoked', 'vault_entry_deleted',
                                'vault_recovery_used',
                                -- 0043.
                                'vault_mode_changed', 'vault_read',
                                -- 0044.
                                'vault_breach_policy_set',
                                -- 0045.
                                'vault_outside_changed', 'vault_outside_read',
                                -- 0046.
                                'ai_policy_changed', 'ai_key_made', 'ai_key_changed',
                                'ai_key_disabled', 'ai_recommendation_decided',
                                -- 0051.
                                'design_moved',
                                -- 0056.
                                'termix_access_set',
                                -- 0060.
                                'firmware_retired',
                                -- 0062.
                                'firmware_ceiling_changed',
                                'firmware_org_settings_changed',
                                -- 0065.
                                'ipam_record_created', 'ipam_record_changed',
                                'ipam_record_deleted',
                                -- 0066.
                                'team_created', 'team_renamed', 'team_deleted',
                                'team_member_added', 'team_member_removed',
                                'team_role_set', 'team_role_cleared',
                                'team_grant_signed', 'team_grant_revoked',
                                -- 0067.
                                'device_read_set',
                                -- This file.
                                'team_role_defined'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
