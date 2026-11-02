-- 0066 -- teams: a team is a principal, and every act on it is a signed, append-only row
-- inside the authority head (ADR-0081, attacked in `docs/TEAMS-ATTACK-ROUND.md`).
--
-- Number 0066, claimed through the layout ledger: 0064 (the Work tab) and 0065 (the IP plan)
-- are held by other pull requests. Gaps and order are fine for `migrate::run`; the ONE hazard is
-- section D, which re-lists the entry types: whichever of 0064/0065/0066 merges second must carry
-- the other's types forward in its list, or its `ADD CONSTRAINT` refuses the rows already there.
--
-- A. PRINCIPALS GAIN A THIRD KIND, `team`. A team is not an account and cannot sign, so it is
-- neither of the two kinds `0004` drew. Every authority table that names a person fixes its kind
-- column to `'steward'`, so a team id can never reach `scope_grants`, `memberships` or the keyring
-- (attack round T4); the only tables that take a team id fix theirs to `'team'`. Principals keep
-- `0004`'s posture: no UPDATE or DELETE policy, so a team's id is never freed for reuse (T11).
--
-- B. `teams` is the team's display record: id, organisation, slug, name, and whether it is
-- deleted. None of it is authority. Who is in a team, who leads it and what it may see are in
-- `team_acts`; a row here that says "not deleted" while the acts say it was deleted grants nothing,
-- because resolution reads the acts. Slug and name are plain text under the tenant policy, as
-- `accounts.display_name` is.
--
-- C. `team_acts` is the log of signed acts, append-only at three levels as `0011`'s authority
-- tables are: no UPDATE/DELETE privilege, the `fathom_authority_is_append_only` trigger, and the
-- row seal plus the head digest that catch a tier-2 edit anyway (T7). A removal, revocation or
-- clearance is a NEW row naming the row it undoes (`undoes`), never a change to it. The `CHECK`s
-- state what each act must carry; the two that are attack-round decisions are named:
--   * only `member_add`/`member_remove` may be signed on a lead's authority (T1: everything else
--     is a root steward's, or for `grant`/`grant_revoke` a steward of the scope);
--   * a lead never adds or removes themselves (T2).
-- Capability is `read` or `draw`, never `steward` (§3.7 constraint 3, T4).
--
-- D. ENTRY TYPES, organisation chain: `team_created`, `team_renamed`, `team_deleted`,
-- `team_member_added`, `team_member_removed`, `team_role_set`, `team_role_cleared`,
-- `team_grant_signed`, `team_grant_revoked`. The list is 0062's plus these; mirrored by
-- `EntryType::kinds()` in `src/chain.rs`.

-- ---------------------------------------------------------------------------
-- A. The third kind.
-- ---------------------------------------------------------------------------
ALTER TABLE principals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE principals DROP CONSTRAINT principals_kind_check;
ALTER TABLE principals
    ADD CONSTRAINT principals_kind_check CHECK (kind IN ('steward', 'operator', 'team'));
ALTER TABLE principals FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- B. teams
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
    id              text        PRIMARY KEY CHECK (char_length(id) = 26),
    principal_kind  text        GENERATED ALWAYS AS ('team') STORED,
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    slug            text        NOT NULL
                                CHECK (char_length(slug) BETWEEN 1 AND 48
                                       AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    deleted         boolean     NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (id, principal_kind) REFERENCES principals (id, kind),
    UNIQUE (id, organisation_id)
);
-- One live team per slug in an organisation; a deleted team's slug may be used again (T11).
CREATE UNIQUE INDEX IF NOT EXISTS teams_live_slug
    ON teams (organisation_id, slug) WHERE NOT deleted;

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE  ROW LEVEL SECURITY;
CREATE POLICY teams_tenant ON teams
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
REVOKE DELETE, UPDATE ON teams FROM fathom_app;
GRANT UPDATE (slug, name, deleted) ON teams TO fathom_app;

-- ---------------------------------------------------------------------------
-- C. team_acts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_acts (
    id               text        PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id  text        NOT NULL,
    team_id          text        NOT NULL,
    act              text        NOT NULL CHECK (act IN (
                                     'create', 'delete',
                                     'member_add', 'member_remove',
                                     'role_set', 'role_clear',
                                     'grant', 'grant_revoke')),

    -- The person a member or role act is about. Fixed to the steward kind, as every row that
    -- names a person is (`0004`).
    subject_id       text,
    subject_kind     text        GENERATED ALWAYS AS
                                 (CASE WHEN subject_id IS NULL THEN NULL ELSE 'steward' END) STORED,
    -- The subject's key when they had one at the act (T6); all zeros otherwise, as ADR-0065's
    -- grants to people added before they enrolled.
    subject_key_fpr  bytea       NOT NULL CHECK (octet_length(subject_key_fpr) = 32),
    role             text        CHECK (role IN ('lead', 'overseer')),
    -- NULL is the organisation itself, as in `scope_grants`.
    scope_id         text        REFERENCES scopes(id) ON DELETE RESTRICT,
    capability       text        CHECK (capability IN ('read', 'draw')),
    undoes           text        REFERENCES team_acts(id) ON DELETE RESTRICT,

    signed_by        text        NOT NULL,
    signer_kind      text        GENERATED ALWAYS AS ('steward') STORED,
    signer_key_fpr   bytea       NOT NULL CHECK (octet_length(signer_key_fpr) = 32),
    signer_authority text        NOT NULL CHECK (signer_authority IN ('steward', 'lead')),
    signature        bytea       NOT NULL CHECK (octet_length(signature) = 64),
    at_unix          bigint      NOT NULL,
    auth_epoch       integer     NOT NULL CHECK (auth_epoch >= 1),

    chain_seq        bigint      NOT NULL CHECK (chain_seq >= 1),
    row_seal         bytea       NOT NULL CHECK (octet_length(row_seal) = 32),
    created_at       timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (team_id, organisation_id) REFERENCES teams (id, organisation_id),
    FOREIGN KEY (subject_id, subject_kind) REFERENCES principals (id, kind),
    FOREIGN KEY (signed_by, signer_kind)   REFERENCES principals (id, kind),

    -- What each act carries, and nothing else.
    CHECK (CASE act
        WHEN 'create'        THEN subject_id IS NULL AND role IS NULL AND capability IS NULL
                                  AND scope_id IS NULL AND undoes IS NULL
        WHEN 'delete'        THEN subject_id IS NULL AND role IS NULL AND capability IS NULL
                                  AND scope_id IS NULL AND undoes IS NULL
        WHEN 'member_add'    THEN subject_id IS NOT NULL AND role IS NULL AND capability IS NULL
                                  AND scope_id IS NULL AND undoes IS NULL
        WHEN 'member_remove' THEN subject_id IS NOT NULL AND role IS NULL AND capability IS NULL
                                  AND scope_id IS NULL AND undoes IS NOT NULL
        WHEN 'role_set'      THEN subject_id IS NOT NULL AND role IS NOT NULL AND capability IS NULL
                                  AND scope_id IS NULL AND undoes IS NULL
        WHEN 'role_clear'    THEN subject_id IS NOT NULL AND role IS NOT NULL AND capability IS NULL
                                  AND scope_id IS NULL AND undoes IS NOT NULL
        WHEN 'grant'         THEN subject_id IS NULL AND role IS NULL AND capability IS NOT NULL
                                  AND undoes IS NULL
        WHEN 'grant_revoke'  THEN subject_id IS NULL AND role IS NULL AND capability IS NULL
                                  AND undoes IS NOT NULL
    END),
    -- T1: a lead's authority reaches membership and nothing else.
    CHECK (signer_authority = 'steward' OR act IN ('member_add', 'member_remove')),
    -- T2: a lead never adds or removes themselves.
    CHECK (signer_authority <> 'lead' OR subject_id <> signed_by)
);
CREATE INDEX IF NOT EXISTS team_acts_organisation_idx ON team_acts (organisation_id, chain_seq);

CREATE TRIGGER team_acts_append_only
    BEFORE UPDATE OR DELETE ON team_acts
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
CREATE TRIGGER team_acts_no_truncate
    BEFORE TRUNCATE ON team_acts
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

ALTER TABLE team_acts ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_acts FORCE  ROW LEVEL SECURITY;
CREATE POLICY team_acts_readable ON team_acts
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY team_acts_insertable ON team_acts
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
REVOKE UPDATE, DELETE ON team_acts FROM fathom_app;

-- The operator plane sees teams and their acts, as it sees grants (§1.1's first verb).
GRANT SELECT ON teams, team_acts TO fathom_operator;
CREATE POLICY teams_readable_by_operator_plane ON teams
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');
CREATE POLICY team_acts_readable_by_operator_plane ON team_acts
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');

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
                                -- This file.
                                'team_created', 'team_renamed', 'team_deleted',
                                'team_member_added', 'team_member_removed',
                                'team_role_set', 'team_role_cleared',
                                'team_grant_signed', 'team_grant_revoked'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
