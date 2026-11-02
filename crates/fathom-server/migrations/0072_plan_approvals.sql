-- 0072 -- plans a folder asks to be approved before they start (sign-off r102-plan-approval,
-- version 2, the owner's picks of 2 November 2026). Number 0072, claimed through the layout
-- thread after 0071 (team roles). Whichever migration merges after this must carry the two new
-- entry types forward in its list.
--
-- A. A FOLDER'S RULE. A Steward of a folder (or of the whole organisation) signs whether plans
--   in that folder, and the folders inside it, must be approved before they start. Each row is
--   the whole rule at that point; the latest counting row for a folder is its rule. The rows are
--   in the authority head's digest, as role definitions are: deleting one would quietly turn
--   approval off.
--
-- B. AN APPROVAL. A person signs one of three things about one plan in one design:
--   `before`    the plan as it reads now (its `plan_digest`) may start. Any change to what
--               the plan says changes the digest, so the approval no longer matches.
--   `emergency` a holder of the emergency start power starts it now, with a reason.
--   `after`     an approver accepts an emergency start after the fact; until then the plan is
--               flagged.
--   Who may sign is the server's check at the time: a Steward of the folder, or a holder of the
--   approve plans power on the plan's team (or, when the plan names no team, on any team with
--   access to the folder); never the plan's author, the person it is assigned to, or the person
--   who asked. Each row is signed and sealed. They are not in the head's digest: removing one
--   only ever makes a plan less approved. An emergency start's reason is encrypted under the
--   organisation content key (it is about the network, as the design is).
--
-- C. ASKING. `plan_approval_asks` records who asked for an approval and who sent a plan back,
--   with a note, encrypted like a reason. Workflow, not authority: nothing is decided from it
--   except that the asker may not approve.
--
-- D. Entry types: 0071's list plus `plan_rule_set` and `plan_approval_signed`.

-- ---------------------------------------------------------------------------
-- A. plan_rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_rules (
    id               text        PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    -- The folder, or NULL for the whole organisation.
    scope_id         text        NULL,
    required         boolean     NOT NULL,

    signed_by        text        NOT NULL,
    signer_kind      text        GENERATED ALWAYS AS ('steward') STORED,
    signer_key_fpr   bytea       NOT NULL CHECK (octet_length(signer_key_fpr) = 32),
    signature        bytea       NOT NULL CHECK (octet_length(signature) = 64),
    at_unix          bigint      NOT NULL,
    auth_epoch       integer     NOT NULL CHECK (auth_epoch >= 1),

    chain_seq        bigint      NOT NULL CHECK (chain_seq >= 1),
    row_seal         bytea       NOT NULL CHECK (octet_length(row_seal) = 32),
    created_at       timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (signed_by, signer_kind) REFERENCES principals (id, kind)
);
CREATE INDEX IF NOT EXISTS plan_rules_organisation_idx
    ON plan_rules (organisation_id, chain_seq);

CREATE TRIGGER plan_rules_append_only
    BEFORE UPDATE OR DELETE ON plan_rules
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
CREATE TRIGGER plan_rules_no_truncate
    BEFORE TRUNCATE ON plan_rules
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

ALTER TABLE plan_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_rules FORCE  ROW LEVEL SECURITY;
CREATE POLICY plan_rules_readable ON plan_rules
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY plan_rules_insertable ON plan_rules
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
REVOKE UPDATE, DELETE ON plan_rules FROM fathom_app;

GRANT SELECT ON plan_rules TO fathom_operator;
CREATE POLICY plan_rules_readable_by_operator_plane ON plan_rules
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');

-- ---------------------------------------------------------------------------
-- B. plan_approvals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_approvals (
    id               text        PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    design_id        text        NOT NULL,
    plan_id          text        NOT NULL CHECK (plan_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    plan_digest      bytea       NOT NULL CHECK (octet_length(plan_digest) = 32),
    kind             text        NOT NULL CHECK (kind IN ('before', 'emergency', 'after')),
    -- The team the signer acted through; NULL for a folder's Steward.
    team_id          text        NULL,
    -- An emergency start says why; nothing else carries a reason. The reason is the
    -- person's words about the network, so it is stored as the design's own words are: under
    -- the organisation content key, never in the clear. The signature covers the words.
    reason_ct        bytea       NOT NULL,
    reason_nonce     bytea       NOT NULL CHECK (octet_length(reason_nonce) = 12),
    key_epoch        integer     NOT NULL CHECK (key_epoch >= 1),

    signed_by        text        NOT NULL,
    signer_key_fpr   bytea       NOT NULL CHECK (octet_length(signer_key_fpr) = 32),
    signature        bytea       NOT NULL CHECK (octet_length(signature) = 64),
    at_unix          bigint      NOT NULL,
    auth_epoch       integer     NOT NULL CHECK (auth_epoch >= 1),

    chain_seq        bigint      NOT NULL CHECK (chain_seq >= 1),
    row_seal         bytea       NOT NULL CHECK (octet_length(row_seal) = 32),
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_approvals_plan_idx
    ON plan_approvals (organisation_id, design_id, plan_id, chain_seq);

CREATE TRIGGER plan_approvals_append_only
    BEFORE UPDATE OR DELETE ON plan_approvals
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();
CREATE TRIGGER plan_approvals_no_truncate
    BEFORE TRUNCATE ON plan_approvals
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

ALTER TABLE plan_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_approvals FORCE  ROW LEVEL SECURITY;
CREATE POLICY plan_approvals_readable ON plan_approvals
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY plan_approvals_insertable ON plan_approvals
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
REVOKE UPDATE, DELETE ON plan_approvals FROM fathom_app;

GRANT SELECT ON plan_approvals TO fathom_operator;
CREATE POLICY plan_approvals_readable_by_operator_plane ON plan_approvals
    FOR SELECT TO fathom_operator USING (current_user = 'fathom_operator');

-- ---------------------------------------------------------------------------
-- C. plan_approval_asks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_approval_asks (
    id               text        PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    design_id        text        NOT NULL,
    plan_id          text        NOT NULL CHECK (plan_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
    plan_digest      bytea       NOT NULL CHECK (octet_length(plan_digest) = 32),
    kind             text        NOT NULL CHECK (kind IN ('ask', 'send_back')),
    account_id       text        NOT NULL,
    -- The note, under the organisation content key like an approval's reason.
    note_ct          bytea       NOT NULL,
    note_nonce       bytea       NOT NULL CHECK (octet_length(note_nonce) = 12),
    key_epoch        integer     NOT NULL CHECK (key_epoch >= 1),
    at_unix          bigint      NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plan_approval_asks_plan_idx
    ON plan_approval_asks (organisation_id, design_id, plan_id, at_unix);

CREATE TRIGGER plan_approval_asks_append_only
    BEFORE UPDATE OR DELETE ON plan_approval_asks
    FOR EACH ROW EXECUTE FUNCTION fathom_authority_is_append_only();

ALTER TABLE plan_approval_asks ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_approval_asks FORCE  ROW LEVEL SECURITY;
CREATE POLICY plan_approval_asks_readable ON plan_approval_asks
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY plan_approval_asks_insertable ON plan_approval_asks
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
REVOKE UPDATE, DELETE ON plan_approval_asks FROM fathom_app;

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
                                -- 0071.
                                'team_role_defined',
                                -- This file.
                                'plan_rule_set', 'plan_approval_signed'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
