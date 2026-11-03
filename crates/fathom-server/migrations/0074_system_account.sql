-- 0074 -- the system account: the one honest actor for a change the server makes itself
-- (sign-off r107, 3 November 2026). First use: turning an old Link into a cable when a design
-- next opens for someone with Draw. More automatic actors are coming (ADR-0084's automatic
-- moves and escalations, scheduled readings), and they act as this same account.
--
-- It is an `accounts` row because history names accounts: `design_change.created_by` and each
-- chain entry's actor reference `accounts(id)`. Every account is a steward principal by
-- construction (`0004`'s `accounts_are_steward_principals`), so it has that row too, and
-- nothing else: it never holds a session, a sign-in nonce, a grant (given, received, seconded,
-- suspended or revoked), a team seat or act, a role or rule signature, an organisation
-- membership, an invitation, a signing key, a backup code, a reset or enrolment token, an
-- operator binding, an AI key, a Termix setting, or a vault key, entry or connection. Each of
-- those is refused here, in the database, by the trigger below on the column that would name
-- it, so a handler that forgets cannot grant it anything. The server refuses its id by name on
-- the sign-in, token and AI-connection paths as well (`src/system_account.rs`).
--
-- Never delete it once any sealed change names it: that history would stop verifying. The row
-- trigger refuses the delete and any change to the row; docs/OPERATING.md says the same.

CREATE OR REPLACE FUNCTION fathom_system_account_id() RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT '0000000000000000000000SYST'::text $$;

-- Plain INSERTs: a migration runs once, and both tables are FORCE ROW LEVEL SECURITY with no
-- SELECT policy this transaction meets, which an ON CONFLICT clause would need.
INSERT INTO principals (id, kind) VALUES ('0000000000000000000000SYST', 'steward');
INSERT INTO accounts (id, email, display_name)
VALUES ('0000000000000000000000SYST', 'system@fathom.invalid', 'Fathom (system change)');

-- The rows themselves: never changed, never given a credential, never deleted.
CREATE OR REPLACE FUNCTION fathom_system_account_row_is_fixed() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.id = fathom_system_account_id() THEN
            RAISE EXCEPTION 'the system account is never deleted: sealed history names it'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.id = fathom_system_account_id() THEN
            RAISE EXCEPTION 'the system account exists once, made by migration 0074'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.id = fathom_system_account_id() OR NEW.id = fathom_system_account_id() THEN
        IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
            RAISE EXCEPTION 'the system account cannot be changed or given a credential'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS accounts_system_row_is_fixed ON accounts;
CREATE TRIGGER accounts_system_row_is_fixed
    BEFORE INSERT OR UPDATE OR DELETE ON accounts
    FOR EACH ROW EXECUTE FUNCTION fathom_system_account_row_is_fixed();
DROP TRIGGER IF EXISTS principals_system_row_is_fixed ON principals;
CREATE TRIGGER principals_system_row_is_fixed
    BEFORE INSERT OR UPDATE OR DELETE ON principals
    FOR EACH ROW EXECUTE FUNCTION fathom_system_account_row_is_fixed();

-- Every row that would make it someone: refused when any column TG_ARGV names holds its id.
CREATE OR REPLACE FUNCTION fathom_refuse_system_account() RETURNS trigger
    LANGUAGE plpgsql AS $$
DECLARE
    col text;
BEGIN
    FOREACH col IN ARRAY TG_ARGV LOOP
        IF (to_jsonb(NEW) ->> col) = fathom_system_account_id() THEN
            RAISE EXCEPTION 'the system account cannot be in %.%', TG_TABLE_NAME, col
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
    RETURN NEW;
END $$;

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        -- Sessions and sign-in.
        ('public', 'sessions', ARRAY['principal_id']),
        ('public', 'session_nonces', ARRAY['principal_id']),
        -- Organisation role, invitations and the authority plane.
        ('public', 'memberships', ARRAY['account_id']),
        ('public', 'organisation_invitations', ARRAY['account_id', 'issued_by', 'closed_by']),
        ('public', 'account_keys', ARRAY['account_id']),
        ('public', 'scope_grants', ARRAY['subject_id', 'granted_by']),
        ('public', 'grant_secondings', ARRAY['seconded_by']),
        ('public', 'grant_suspensions', ARRAY['actor_id']),
        ('public', 'grant_revocations', ARRAY['revoked_by']),
        ('public', 'team_acts', ARRAY['subject_id', 'signed_by']),
        ('public', 'team_role_defs', ARRAY['signed_by']),
        ('public', 'plan_rules', ARRAY['signed_by']),
        -- Credentials and the paths to one.
        ('public', 'backup_codes', ARRAY['account_id']),
        ('public', 'password_reset_tokens', ARRAY['account_id']),
        ('public', 'enrolment_tokens', ARRAY['account_id']),
        ('public', 'operator_account_bindings', ARRAY['account_id']),
        ('public', 'ai_keys', ARRAY['owner']),
        ('public', 'member_termix', ARRAY['account_id']),
        ('vault', 'keys', ARRAY['account_id', 'created_by']),
        ('vault', 'entries', ARRAY['owner', 'created_by']),
        ('vault', 'outside_connections', ARRAY['owner'])
    ) AS v(schema_name, table_name, cols)
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I',
                       t.table_name || '_refuse_system_account', t.schema_name, t.table_name);
        EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I.%I '
                       'FOR EACH ROW EXECUTE FUNCTION fathom_refuse_system_account(%s)',
                       t.table_name || '_refuse_system_account', t.schema_name, t.table_name,
                       (SELECT string_agg(quote_literal(c), ', ') FROM unnest(t.cols) AS c));
    END LOOP;
END $$;
