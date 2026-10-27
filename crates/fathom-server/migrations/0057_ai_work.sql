-- 0057 -- What an AI may do, by kind of work (ADR-0077 amendment; sign-off card r47-ai-controls,
-- approved 2026-10-27). An AI never changes a design itself: for each of four kinds of work
-- (design, plans, issues, doing) a place says off, ideas or propose, and the strictest wins.
--
-- - `ai_site_switch.work`: the admin's ceiling for every organisation.
-- - `ai_policies.work`: the organisation's, within the ceiling, with folder rules, a list of
--   the only kinds and fields, and limits a Steward may lower.
-- - `ai_keys.work`: the connection's, within the organisation's.
--
-- Each `work` is four `kind:level` entries in that order, or empty for a row written before
-- this migration (read from its may_change tick). The row seals cover each new column only
-- when it differs from its default, so rows written before this migration still verify.

CREATE OR REPLACE FUNCTION fathom_ai_work_ok(work text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $fn$
    SELECT work IS NOT NULL
       AND coalesce(array_ndims(work), 1) = 1
       AND (cardinality(work) = 0
            OR (cardinality(work) = 4
                AND work[1] IN ('design:off', 'design:ideas', 'design:propose')
                AND work[2] IN ('plans:off', 'plans:ideas', 'plans:propose')
                AND work[3] IN ('issues:off', 'issues:ideas', 'issues:propose')
                AND work[4] IN ('doing:off', 'doing:ideas', 'doing:propose')))
$fn$;

CREATE OR REPLACE FUNCTION fathom_ai_only_ok(only_kinds text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $fn$
    SELECT only_kinds IS NOT NULL
       AND coalesce(array_ndims(only_kinds), 1) = 1
       AND cardinality(only_kinds) <= 100
       AND NOT EXISTS (SELECT 1 FROM unnest(only_kinds) AS o
                        WHERE o IS NULL OR o !~ '^[A-Za-z]{1,64}(\.[a-z0-9_]{1,64})?$')
       AND (SELECT count(DISTINCT o) FROM unnest(only_kinds) AS o) = cardinality(only_kinds)
$fn$;

ALTER TABLE ai_site_switch
    ADD COLUMN IF NOT EXISTS work text[] NOT NULL DEFAULT '{}' CHECK (fathom_ai_work_ok(work));

ALTER TABLE ai_policies
    ADD COLUMN IF NOT EXISTS work text[] NOT NULL DEFAULT '{}' CHECK (fathom_ai_work_ok(work)),
    ADD COLUMN IF NOT EXISTS ideas_only_scopes text[] NOT NULL DEFAULT '{}'
        CHECK (fathom_ai_ids_ok(ideas_only_scopes, 200)),
    ADD COLUMN IF NOT EXISTS no_ai_scopes text[] NOT NULL DEFAULT '{}'
        CHECK (fathom_ai_ids_ok(no_ai_scopes, 200)),
    ADD COLUMN IF NOT EXISTS only_kinds text[] NOT NULL DEFAULT '{}'
        CHECK (fathom_ai_only_ok(only_kinds)),
    ADD COLUMN IF NOT EXISTS per_minute integer NOT NULL DEFAULT 10 CHECK (per_minute BETWEEN 1 AND 10),
    ADD COLUMN IF NOT EXISTS per_day integer NOT NULL DEFAULT 300 CHECK (per_day BETWEEN 1 AND 300),
    ADD COLUMN IF NOT EXISTS max_removals integer NOT NULL DEFAULT 20 CHECK (max_removals BETWEEN 0 AND 20);

ALTER TABLE ai_keys
    ADD COLUMN IF NOT EXISTS work text[] NOT NULL DEFAULT '{}' CHECK (fathom_ai_work_ok(work));

-- The app may narrow a connection's levels, so it may write the column (0046's column grant).
GRANT UPDATE (work) ON ai_keys TO fathom_app;

CREATE OR REPLACE FUNCTION fathom_ai_key_moves() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    -- 0057: as 0054, and the connection's levels are a permission like the others.
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
                              OR NEW.may_change <> OLD.may_change
                              OR NEW.work <> OLD.work) THEN
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
                AND NEW.may_change = OLD.may_change
                AND NEW.work = OLD.work) THEN
            RAISE EXCEPTION 'an operator may only disable an AI key';
        END IF;
    END IF;
    RETURN NEW;
END
$fn$;
