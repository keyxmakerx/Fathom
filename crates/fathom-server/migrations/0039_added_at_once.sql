-- 0039 -- a steward adds a person and they are in at once (ADR-0065).
--
-- The owner, 2026-10-12: "if i want to add another user, then i just can." Until
-- now an invitation was a request: the person joined, read a key-check code to a
-- steward, and the steward confirmed by signing a grant naming that key
-- (`0037`). That ceremony goes for read and draw. The steward's browser signs the
-- grant at the moment they press Add, before the person has any key, so the grant
-- names the ACCOUNT and carries an all-zero subject key fingerprint
-- (`grants.rs`'s `NO_SUBJECT_KEY`). The person then redeems the link as before,
-- and their first key lands on an account that is already a member.
--
-- One new state, `added`: signed and a member, link not yet used. It is closed by
-- the steward act (`closed_*` and `grant_id` set, as `confirmed` is) and not yet
-- joined (`joined_*` null, as `asked` is). Redemption moves it to `confirmed`,
-- filling `joined_*` and leaving everything the steward wrote alone.
--
-- Steward invitations still go through `joined` and a confirm, one at a time:
-- appointing a steward needs seconding or the sole-steward delay, and that stays.

ALTER TABLE organisation_invitations
    DROP CONSTRAINT IF EXISTS organisation_invitations_state_check;
ALTER TABLE organisation_invitations
    ADD CONSTRAINT organisation_invitations_state_check
    CHECK (state IN ('asked', 'added', 'joined', 'confirmed', 'refused', 'cancelled'));

-- `0037`'s unnamed table CHECKs, replaced by name. Postgres named them
-- `organisation_invitations_check{,1,2,...}` in declaration order; they are found
-- by their text rather than by a guessed name, so an install whose numbering
-- differs is still corrected.
DO $do$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT conname, pg_get_constraintdef(oid) AS def
          FROM pg_constraint
         WHERE conrelid = 'organisation_invitations'::regclass
           AND contype = 'c'
    LOOP
        IF c.def LIKE '%state = ANY%confirmed%refused%cancelled%closed_at IS NOT NULL%'
           OR c.def LIKE '%state = ''confirmed''%grant_id IS NOT NULL%' THEN
            EXECUTE format('ALTER TABLE organisation_invitations DROP CONSTRAINT %I',
                           c.conname);
        END IF;
    END LOOP;
END
$do$;

-- Closed by a steward act: `added` is one, as the three end states are.
ALTER TABLE organisation_invitations
    DROP CONSTRAINT IF EXISTS organisation_invitations_closed_states;
ALTER TABLE organisation_invitations
    ADD CONSTRAINT organisation_invitations_closed_states
    CHECK ((state IN ('added', 'confirmed', 'refused', 'cancelled')) = (closed_at IS NOT NULL));

-- A grant exactly when the person is in, or added and on their way in.
ALTER TABLE organisation_invitations
    DROP CONSTRAINT IF EXISTS organisation_invitations_grant_states;
ALTER TABLE organisation_invitations
    ADD CONSTRAINT organisation_invitations_grant_states
    CHECK ((state IN ('added', 'confirmed')) = (grant_id IS NOT NULL));

-- Not yet joined.
ALTER TABLE organisation_invitations
    DROP CONSTRAINT IF EXISTS organisation_invitations_added_not_joined;
ALTER TABLE organisation_invitations
    ADD CONSTRAINT organisation_invitations_added_not_joined
    CHECK (state <> 'added' OR joined_at IS NULL);

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
    IF NOT ((OLD.state = 'asked'  AND NEW.state IN ('joined', 'added', 'cancelled'))
         OR (OLD.state = 'added'  AND NEW.state = 'confirmed')
         OR (OLD.state = 'joined' AND NEW.state IN ('confirmed', 'refused', 'cancelled'))) THEN
        RAISE EXCEPTION 'an invitation may not move from % to %', OLD.state, NEW.state;
    END IF;
    IF (OLD.state = 'asked' AND NEW.state = 'joined')
       OR (OLD.state = 'added' AND NEW.state = 'confirmed') THEN
        IF current_setting('app.enrolment_custody', true) IS DISTINCT FROM 'yes' THEN
            RAISE EXCEPTION 'only a redemption may mark an invitation joined';
        END IF;
        -- A redemption records how it was joined and nothing else: what the
        -- steward signed when they added the person stays as they signed it.
        IF NEW.closed_at IS DISTINCT FROM OLD.closed_at
           OR NEW.closed_seq IS DISTINCT FROM OLD.closed_seq
           OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
           OR NEW.grant_id IS DISTINCT FROM OLD.grant_id THEN
            RAISE EXCEPTION 'joining an invitation does not change how it was closed';
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
