-- 0050 -- May an AI connection change designs (ADR-0073 decision 1; owner's answer on sign-off
-- card r41-ai-write, 2026-10-27: option B, "per user and per org ... I was thinking both").
--
-- Two ticks, both off by default, both needed: the organisation's (`ai_policies.may_change`,
-- set by a Steward) and the connection's (`ai_keys.may_change`, set by its owner at Allow or
-- Make key, narrowed by its owner or a Steward). The row seals cover each only while it is
-- true, so rows written before this migration still verify.

ALTER TABLE ai_policies ADD COLUMN IF NOT EXISTS may_change boolean NOT NULL DEFAULT false;
ALTER TABLE ai_keys     ADD COLUMN IF NOT EXISTS may_change boolean NOT NULL DEFAULT false;

-- The app may narrow a connection's tick, so it may write the column (0046's column grant).
GRANT UPDATE (may_change) ON ai_keys TO fathom_app;

CREATE OR REPLACE FUNCTION fathom_ai_key_moves() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    -- 0050: as 0046, and the connection's may_change tick is a permission like the others.
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'an AI key is never deleted from the table: its state says so';
    END IF;
    IF NEW.id <> OLD.id
       OR NEW.organisation_id <> OLD.organisation_id
       OR NEW.owner <> OLD.owner
       OR NEW.kind <> OLD.kind
       OR NEW.public_key IS DISTINCT FROM OLD.public_key
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.created_at <> OLD.created_at
       OR NEW.created_seq <> OLD.created_seq THEN
        RAISE EXCEPTION 'an AI key''s identity never changes';
    END IF;
    IF NEW.row_version <> OLD.row_version + 1 THEN
        RAISE EXCEPTION 'an update to an AI key must bump row_version by one, which the seal covers';
    END IF;
    -- No way back on: a key that was stopped stays stopped.
    IF NOT ((OLD.state = 'on' AND NEW.state IN ('on', 'disabled', 'deleted'))
         OR (OLD.state = 'disabled' AND NEW.state = 'deleted')) THEN
        RAISE EXCEPTION 'an AI key may not move from % to %', OLD.state, NEW.state;
    END IF;
    IF OLD.state <> 'on' AND (NEW.scopes <> OLD.scopes OR NEW.sees <> OLD.sees
                              OR NEW.may_recommend <> OLD.may_recommend
                              OR NEW.expires_at <> OLD.expires_at
                              OR NEW.may_change <> OLD.may_change) THEN
        RAISE EXCEPTION 'a stopped AI key''s permissions do not change';
    END IF;
    IF NEW.expires_at > OLD.expires_at THEN
        RAISE EXCEPTION 'an AI key''s end is never moved later; make a new key';
    END IF;
    IF OLD.disabled_at IS NOT NULL AND (NEW.disabled_at IS DISTINCT FROM OLD.disabled_at
                                        OR NEW.disabled_by IS DISTINCT FROM OLD.disabled_by
                                        OR NEW.disabled_by_kind IS DISTINCT FROM OLD.disabled_by_kind
                                        OR NEW.disabled_reason IS DISTINCT FROM OLD.disabled_reason) THEN
        RAISE EXCEPTION 'who stopped an AI key, and why, is never rewritten';
    END IF;
    -- The operator plane may do one thing: stop a key that is on.
    IF current_setting('app.operator_custody', true) = 'yes' THEN
        IF NOT (OLD.state = 'on' AND NEW.state = 'disabled'
                AND NEW.disabled_by_kind = 'operator'
                AND NEW.scopes = OLD.scopes AND NEW.sees = OLD.sees
                AND NEW.may_recommend = OLD.may_recommend
                AND NEW.label = OLD.label
                AND NEW.expires_at = OLD.expires_at
                AND NEW.may_change = OLD.may_change) THEN
            RAISE EXCEPTION 'an operator may only disable an AI key';
        END IF;
    END IF;
    RETURN NEW;
END
$fn$;
