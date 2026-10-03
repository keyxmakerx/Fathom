-- 0037 -- steward-issued invitations, "Waiting for you" and batch confirm.
--
-- Until now an account shell and its enrolment token were an operator's act
-- (`create_account_shell`). A steward could grant only to someone already in the
-- organisation. This file lets a steward invite a person the organisation has
-- never seen, and keeps every control the operator path has:
--
--   * the invitation is a REQUEST. Redeeming the link creates a key and nothing
--     else: no membership, no grant. A steward signs a grant naming that key
--     afterwards (admin design §6.4), and the membership is written in the same
--     transaction as that signature.
--   * the shell account is created by the server inside the issuing transaction
--     and is never an existing account: an extra key on an existing account would
--     get everything the account holds (the authorisation walk matches the
--     account, not the key).
--   * the sign-in name is chosen by the server and has no "@". The email a
--     steward types is a contact note on the invitation row and is never used to
--     sign in or reset anything.
--
-- A new custody setting, `app.invitation_custody`, opens ONLY this table and the
-- steward half of `enrolment_tokens`. It is never `app.operator_custody` or
-- `app.enrolment_custody`, which open the operator tables.
--
-- **No SECURITY DEFINER anywhere.** FORCE ROW LEVEL SECURITY binds the owner, so
-- a definer function adds nothing (0012's lesson).

-- ---------------------------------------------------------------------------
-- A. THE INVITATION
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organisation_invitations (
    id               text        PRIMARY KEY CHECK (char_length(id) = 26),
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    -- NULL means the organisation itself, as in `scope_grants` (0011).
    scope_id         text        REFERENCES scopes(id) ON DELETE RESTRICT,
    -- One invitation per shell. The shell is created with the invitation.
    account_id       text        NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
    capability_asked text        NOT NULL CHECK (capability_asked IN ('read', 'draw', 'steward')),
    -- What the steward typed. Not attested by the person.
    display_name     text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
    contact_email    text        CHECK (contact_email IS NULL OR char_length(contact_email) BETWEEN 1 AND 254),
    sign_in_name     text        NOT NULL CHECK (char_length(sign_in_name) BETWEEN 1 AND 100),

    issued_by        text        NOT NULL,
    issuer_kind      text        GENERATED ALWAYS AS ('steward') STORED,
    issued_seq       bigint      NOT NULL CHECK (issued_seq >= 1),
    issued_at        timestamptz NOT NULL DEFAULT now(),
    -- The link's own expiry: equal to the token's.
    asked_expires_at timestamptz NOT NULL,

    state            text        NOT NULL
                                 CHECK (state IN ('asked', 'joined', 'confirmed', 'refused', 'cancelled')),

    -- Set when the link is redeemed: the person's first key and its fingerprint,
    -- and the site-chain entry that records it.
    joined_at        timestamptz,
    joined_seq       bigint      CHECK (joined_seq IS NULL OR joined_seq >= 1),
    enrolled_key_id  text        REFERENCES account_keys(id) ON DELETE RESTRICT,
    enrolled_key_fpr bytea       CHECK (enrolled_key_fpr IS NULL OR octet_length(enrolled_key_fpr) = 32),

    -- Set when a steward closes it.
    closed_at        timestamptz,
    closed_seq       bigint      CHECK (closed_seq IS NULL OR closed_seq >= 1),
    closed_by        text,
    closed_by_kind   text        GENERATED ALWAYS AS
                                 (CASE WHEN closed_by IS NULL THEN NULL ELSE 'steward' END) STORED,
    grant_id         text        UNIQUE REFERENCES scope_grants(id) ON DELETE RESTRICT,

    row_version      integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal         bytea       NOT NULL CHECK (octet_length(row_seal) = 32),

    FOREIGN KEY (issued_by, issuer_kind)    REFERENCES principals (id, kind),
    FOREIGN KEY (closed_by, closed_by_kind) REFERENCES principals (id, kind),

    CHECK (asked_expires_at > issued_at),
    -- The four join columns are all set or all null.
    CHECK ((joined_at IS NULL) = (joined_seq IS NULL)
       AND (joined_seq IS NULL) = (enrolled_key_id IS NULL)
       AND (enrolled_key_id IS NULL) = (enrolled_key_fpr IS NULL)),
    -- Joined exactly when the state says the link was used. A cancelled row may
    -- or may not have been joined.
    CHECK (state <> 'asked' OR joined_at IS NULL),
    CHECK (state NOT IN ('joined', 'confirmed', 'refused') OR joined_at IS NOT NULL),
    -- The close columns are all set or all null, and set exactly when closed.
    CHECK ((closed_at IS NULL) = (closed_seq IS NULL)
       AND (closed_seq IS NULL) = (closed_by IS NULL)),
    CHECK ((state IN ('confirmed', 'refused', 'cancelled')) = (closed_at IS NOT NULL)),
    CHECK ((state = 'confirmed') = (grant_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS organisation_invitations_open_idx
    ON organisation_invitations (organisation_id) WHERE state IN ('asked', 'joined');
CREATE INDEX IF NOT EXISTS organisation_invitations_issuer_idx
    ON organisation_invitations (issued_by, issued_at);

-- ---------------------------------------------------------------------------
-- B. ROW-LEVEL SECURITY. Every policy names its command; none is FOR ALL.
--
-- Row security cannot tell a steward from a member (the tenant policy is the
-- same for both), so every route that reads this table authorises Steward
-- before it queries and filters rows to the scopes the caller stewards.
-- ---------------------------------------------------------------------------
ALTER TABLE organisation_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_invitations FORCE  ROW LEVEL SECURITY;

CREATE POLICY organisation_invitations_readable ON organisation_invitations
    FOR SELECT USING (
        organisation_id = current_setting('app.tenant_id', true)
        OR current_setting('app.enrolment_custody', true) = 'yes');
CREATE POLICY organisation_invitations_insertable ON organisation_invitations
    FOR INSERT WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.invitation_custody', true) = 'yes');
CREATE POLICY organisation_invitations_updatable_by_steward ON organisation_invitations
    FOR UPDATE USING (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.invitation_custody', true) = 'yes')
            WITH CHECK (
        organisation_id = current_setting('app.tenant_id', true)
        AND current_setting('app.invitation_custody', true) = 'yes');
-- Redemption has no tenant. The trigger below lets it make one move only.
CREATE POLICY organisation_invitations_updatable_by_redemption ON organisation_invitations
    FOR UPDATE USING (current_setting('app.enrolment_custody', true) = 'yes')
            WITH CHECK (current_setting('app.enrolment_custody', true) = 'yes');
-- No DELETE policy.

-- ---------------------------------------------------------------------------
-- C. WHICH MOVES ARE LEGAL. A trigger that reads only OLD, NEW and the custody
-- settings, so it cannot hit the row-security trap 0012 describes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fathom_invitation_moves() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'an invitation is never deleted: it is closed, and its history stays';
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.organisation_id <> OLD.organisation_id
       OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
       OR NEW.account_id <> OLD.account_id
       OR NEW.capability_asked <> OLD.capability_asked
       OR NEW.display_name <> OLD.display_name
       OR NEW.contact_email IS DISTINCT FROM OLD.contact_email
       OR NEW.sign_in_name <> OLD.sign_in_name
       OR NEW.issued_by <> OLD.issued_by
       OR NEW.issued_seq <> OLD.issued_seq
       OR NEW.issued_at <> OLD.issued_at
       OR NEW.asked_expires_at <> OLD.asked_expires_at THEN
        RAISE EXCEPTION 'an invitation''s identity and request never change';
    END IF;
    IF NEW.row_version <> OLD.row_version + 1 THEN
        RAISE EXCEPTION
            'an update to an invitation must bump row_version by one, which the row seal covers';
    END IF;
    IF NOT ((OLD.state = 'asked'  AND NEW.state IN ('joined', 'cancelled'))
         OR (OLD.state = 'joined' AND NEW.state IN ('confirmed', 'refused', 'cancelled'))) THEN
        RAISE EXCEPTION 'an invitation may not move from % to %', OLD.state, NEW.state;
    END IF;
    IF OLD.state = 'asked' AND NEW.state = 'joined' THEN
        -- Redeeming the link: the person's own act, with no tenant.
        IF current_setting('app.enrolment_custody', true) IS DISTINCT FROM 'yes' THEN
            RAISE EXCEPTION 'only a redemption may mark an invitation joined';
        END IF;
    ELSE
        IF current_setting('app.invitation_custody', true) IS DISTINCT FROM 'yes' THEN
            RAISE EXCEPTION 'only a steward act may close an invitation';
        END IF;
        IF NEW.joined_at IS DISTINCT FROM OLD.joined_at
           OR NEW.joined_seq IS DISTINCT FROM OLD.joined_seq
           OR NEW.enrolled_key_id IS DISTINCT FROM OLD.enrolled_key_id
           OR NEW.enrolled_key_fpr IS DISTINCT FROM OLD.enrolled_key_fpr THEN
            RAISE EXCEPTION 'closing an invitation does not change how it was joined';
        END IF;
    END IF;
    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS organisation_invitations_moves ON organisation_invitations;
CREATE TRIGGER organisation_invitations_moves
    BEFORE UPDATE OR DELETE ON organisation_invitations
    FOR EACH ROW EXECUTE FUNCTION fathom_invitation_moves();
DROP TRIGGER IF EXISTS organisation_invitations_no_truncate ON organisation_invitations;
CREATE TRIGGER organisation_invitations_no_truncate
    BEFORE TRUNCATE ON organisation_invitations
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

-- ---------------------------------------------------------------------------
-- D. PRIVILEGES. Nothing to `fathom_operator`: the operator plane reads no
-- invitation (tests/planes.rs).
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON organisation_invitations FROM fathom_app;
GRANT UPDATE (state, joined_at, joined_seq, enrolled_key_id, enrolled_key_fpr,
              closed_at, closed_seq, closed_by, grant_id, row_version, row_seal)
    ON organisation_invitations TO fathom_app;

-- ---------------------------------------------------------------------------
-- E. ENROLMENT TOKENS ISSUED BY A STEWARD
--
-- `issued_by` named an operator and was NOT NULL (0015). A steward-issued token
-- names the steward's account instead and its invitation. Exactly one issuer;
-- an invitation token is always an `account` token. The UPDATE policy and
-- column grants are unchanged: a steward transaction never holds
-- `app.enrolment_custody`, so it can neither spend nor retire a token.
-- ---------------------------------------------------------------------------
ALTER TABLE enrolment_tokens ALTER COLUMN issued_by DROP NOT NULL;
ALTER TABLE enrolment_tokens
    ADD COLUMN IF NOT EXISTS issued_by_account text REFERENCES accounts(id) ON DELETE RESTRICT;
ALTER TABLE enrolment_tokens
    ADD COLUMN IF NOT EXISTS invitation_id text UNIQUE
        REFERENCES organisation_invitations(id) ON DELETE RESTRICT;

ALTER TABLE enrolment_tokens
    ADD CONSTRAINT enrolment_tokens_one_issuer
    CHECK ((issued_by IS NULL) <> (issued_by_account IS NULL));
ALTER TABLE enrolment_tokens
    ADD CONSTRAINT enrolment_tokens_invitation_has_a_steward
    CHECK ((invitation_id IS NOT NULL) = (issued_by_account IS NOT NULL));
ALTER TABLE enrolment_tokens
    ADD CONSTRAINT enrolment_tokens_invitation_is_an_account_token
    CHECK (invitation_id IS NULL OR purpose = 'account');

CREATE POLICY enrolment_tokens_insertable_by_steward ON enrolment_tokens
    FOR INSERT WITH CHECK (
        current_setting('app.invitation_custody', true) = 'yes'
        AND purpose = 'account'
        AND issued_by IS NULL
        AND issued_by_account = current_setting('app.account_id', true)
        AND invitation_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- F. TWO ORGANISATION-CHAIN ENTRY TYPES
--
-- `invitation_issued` and `invitation_closed` (the reason, one of confirmed,
-- refused or cancelled, is in the sealed metadata). "Joined" needs no new type:
-- redemption has no tenant, so it files the existing site entry
-- `enrolment_token_redeemed` with an `invitation` key. Mirrored by
-- `EntryType::kinds()` in `src/chain.rs`. The list below is 0034's, plus these.
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
                                'operator_adopted'))
     OR (chain_kind = 'org'
             AND entry_type IN ('org_genesis', 'rewrap',
                                'account_key_enrolled', 'account_key_superseded',
                                'account_key_retired',
                                'grant_signed', 'grant_seconded',
                                'grant_suspended', 'grant_unsuspended',
                                'grant_revoked', 'auth_head_advanced',
                                'firmware_staged', 'firmware_fetch_issued',
                                'firmware_fetch_redeemed',
                                -- This file's section F.
                                'invitation_issued', 'invitation_closed'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
