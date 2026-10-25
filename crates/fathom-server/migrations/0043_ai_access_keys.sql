-- 0043 -- AI access keys (ADR-0072).
--
-- A person's AI app reads a design AS that person and sends recommendations a
-- person accepts. It never saves. The tables:
--
--   ai_policies          one row per organisation, written by a Steward: is AI
--                        allowed here, who may make keys, the most a key may see,
--                        the longest a key may last, which folders need a second
--                        person to accept an idea. No row = AI off.
--   ai_keys              one row per key: the public half of an ES256 pair the
--                        person's own computer made, what it may see, until when,
--                        and whether it is on. Sealed: a row widened in the
--                        database without a reseal does not verify and is refused.
--   ai_key_directory     key id -> organisation, so a request that names only its
--                        key can find its tenant. Ids and nothing else.
--   ai_request_nonces    every nonce a key has spent, until it could no longer be
--                        replayed anyway.
--   ai_key_use           last used, from where, and a count per day. Not sealed:
--                        it decides nothing.
--   ai_site_switch       the operator's "No AI on this server". No row = allowed.
--   ai_recommendations   an AI's idea for one design, sealed like a cable
--                        correction (0036). Never a graph node.
--   ai_oauth_clients     apps that registered themselves for the connector
--                        sign-in (RFC 7591). Not an organisation's: a name and
--                        the redirects it may use, nothing it can sign in with.
--   ai_oauth_codes       a one-minute, single-use sign-in result, by hash.
--   ai_oauth_tokens      a connector's access and refresh tokens, by hash.
--
-- A key is one of two kinds. `helper`: the public half of a pair the person's
-- computer made, and every request signed (ADR-0072 decisions 3 and 4).
-- `connector`: made when the person signs an AI app in (decisions 13 to 17),
-- bound to that app's client id, used through opaque tokens Fathom keeps only
-- the hashes of. Every other rule is the same row and the same checks.
--
-- `app.ai_custody` is set by `src/ai.rs` and by nothing else, and only while a
-- request that names an AI key is being verified: it unlocks the directory, the
-- nonces and the site switch, never a key row, a policy or a design.
-- `app.design_capability` stays at its refusal until the key's owner has been
-- turned into a tenant context by `repo::open_tenant_context`, the same function
-- a browser request goes through.

-- ---------------------------------------------------------------------------
-- A. THE ORGANISATION'S POLICY
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fathom_ai_sees_ok(sees text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $fn$
    SELECT sees IS NOT NULL
       AND coalesce(array_ndims(sees), 1) = 1
       AND 'layout' = ANY (sees)
       AND NOT EXISTS (SELECT 1 FROM unnest(sees) AS s
                        WHERE s IS NULL OR s NOT IN ('layout', 'addresses', 'notes'))
       AND (SELECT count(DISTINCT s) FROM unnest(sees) AS s) = cardinality(sees)
$fn$;

CREATE OR REPLACE FUNCTION fathom_ai_ids_ok(ids text[], most integer) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $fn$
    SELECT ids IS NOT NULL
       AND coalesce(array_ndims(ids), 1) = 1
       AND cardinality(ids) <= most
       AND NOT EXISTS (SELECT 1 FROM unnest(ids) AS i
                        WHERE i IS NULL OR char_length(i) <> 26)
       AND (SELECT count(DISTINCT i) FROM unnest(ids) AS i) = cardinality(ids)
$fn$;

CREATE OR REPLACE FUNCTION fathom_ai_apps_ok(apps text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE AS $fn$
    SELECT apps IS NOT NULL
       AND coalesce(array_ndims(apps), 1) = 1
       AND NOT EXISTS (SELECT 1 FROM unnest(apps) AS a
                        WHERE a IS NULL OR a NOT IN ('claude', 'claude-code', 'other'))
       AND (SELECT count(DISTINCT a) FROM unnest(apps) AS a) = cardinality(apps)
$fn$;

CREATE TABLE IF NOT EXISTS ai_policies (
    organisation_id      text        PRIMARY KEY REFERENCES organisations(id) ON DELETE RESTRICT,
    allowed              boolean     NOT NULL,
    makers               text[]      NOT NULL CHECK (fathom_ai_ids_ok(makers, 500)),
    ceiling              text[]      NOT NULL CHECK (fathom_ai_sees_ok(ceiling)),
    max_days             integer     NOT NULL CHECK (max_days IN (30, 90, 365)),
    second_person_scopes text[]      NOT NULL CHECK (fathom_ai_ids_ok(second_person_scopes, 200)),
    -- Which apps may connect through the sign-in (decision 16).
    apps                 text[]      NOT NULL CHECK (fathom_ai_apps_ok(apps)),
    changed_by           text        NOT NULL REFERENCES accounts(id),
    changed_at           timestamptz NOT NULL DEFAULT now(),
    changed_seq          bigint      NOT NULL CHECK (changed_seq >= 1),
    row_version          integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal             bytea       NOT NULL CHECK (octet_length(row_seal) = 32)
);

ALTER TABLE ai_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_policies FORCE  ROW LEVEL SECURITY;

CREATE POLICY ai_policies_readable ON ai_policies
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ai_policies_insertable ON ai_policies
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND changed_by = current_setting('app.account_id', true));
CREATE POLICY ai_policies_updatable ON ai_policies
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND changed_by = current_setting('app.account_id', true));

-- ---------------------------------------------------------------------------
-- B. THE KEYS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_keys (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id               text        NOT NULL UNIQUE CHECK (char_length(id) = 26),
    owner            text        NOT NULL REFERENCES accounts(id),
    kind             text        NOT NULL CHECK (kind IN ('helper', 'connector')),
    -- A helper key: SEC1 uncompressed P-256, 0x04 and two 32-byte coordinates.
    public_key       bytea       UNIQUE CHECK (public_key IS NULL OR octet_length(public_key) = 65),
    -- A connector: the app's client id, as the sign-in named it.
    client_id        text        CHECK (client_id IS NULL OR char_length(client_id) BETWEEN 1 AND 300),
    label            text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
    -- Empty means every folder the owner can read.
    scopes           text[]      NOT NULL CHECK (fathom_ai_ids_ok(scopes, 50)),
    sees             text[]      NOT NULL CHECK (fathom_ai_sees_ok(sees)),
    may_recommend    boolean     NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    created_seq      bigint      NOT NULL CHECK (created_seq >= 1),
    expires_at       timestamptz NOT NULL,
    state            text        NOT NULL CHECK (state IN ('on', 'disabled', 'deleted')),
    changed_seq      bigint      NOT NULL CHECK (changed_seq >= 1),
    disabled_at      timestamptz,
    disabled_by      text,
    disabled_by_kind text        CHECK (disabled_by_kind IN ('owner', 'steward', 'operator')),
    disabled_reason  text        CHECK (disabled_reason IS NULL
                                        OR char_length(disabled_reason) BETWEEN 1 AND 300),
    row_version      integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal         bytea       NOT NULL CHECK (octet_length(row_seal) = 32),
    PRIMARY KEY (organisation_id, id),
    CHECK (expires_at > created_at),
    CHECK (expires_at <= created_at + interval '366 days'),
    CHECK ((state = 'on') = (disabled_at IS NULL)),
    CHECK ((kind = 'helper') = (public_key IS NOT NULL)),
    CHECK ((kind = 'connector') = (client_id IS NOT NULL)),
    CHECK ((disabled_at IS NULL) = (disabled_by IS NULL)
       AND (disabled_by IS NULL) = (disabled_by_kind IS NULL))
);

CREATE INDEX IF NOT EXISTS ai_keys_owner_idx ON ai_keys (organisation_id, owner);

ALTER TABLE ai_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_keys FORCE  ROW LEVEL SECURITY;

-- Row security cannot tell an owner from a Steward; `src/ai.rs` authorises
-- before it reads and filters what it returns.
CREATE POLICY ai_keys_readable ON ai_keys
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true)
                   OR current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY ai_keys_insertable ON ai_keys
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND owner = current_setting('app.account_id', true)
                       AND state = 'on');
CREATE POLICY ai_keys_updatable ON ai_keys
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true)
                   OR current_setting('app.operator_custody', true) = 'yes')
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                     OR current_setting('app.operator_custody', true) = 'yes');
-- No DELETE policy: a deleted key is a state, and its history stays.

CREATE OR REPLACE FUNCTION fathom_ai_key_moves() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
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
                              OR NEW.expires_at <> OLD.expires_at) THEN
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
                AND NEW.expires_at = OLD.expires_at) THEN
            RAISE EXCEPTION 'an operator may only disable an AI key';
        END IF;
    END IF;
    RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS ai_keys_moves ON ai_keys;
CREATE TRIGGER ai_keys_moves
    BEFORE UPDATE OR DELETE ON ai_keys
    FOR EACH ROW EXECUTE FUNCTION fathom_ai_key_moves();
DROP TRIGGER IF EXISTS ai_keys_no_truncate ON ai_keys;
CREATE TRIGGER ai_keys_no_truncate
    BEFORE TRUNCATE ON ai_keys
    FOR EACH STATEMENT EXECUTE FUNCTION fathom_authority_is_append_only();

REVOKE UPDATE, DELETE ON ai_keys FROM fathom_app;
GRANT UPDATE (label, scopes, sees, may_recommend, expires_at, state, changed_seq,
              disabled_at, disabled_by, disabled_by_kind, disabled_reason,
              row_version, row_seal)
    ON ai_keys TO fathom_app;

-- ---------------------------------------------------------------------------
-- C. THE DIRECTORY, THE NONCES, THE USE COUNTS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_key_directory (
    key_id          text NOT NULL PRIMARY KEY REFERENCES ai_keys(id) ON DELETE RESTRICT,
    organisation_id text NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT
);

ALTER TABLE ai_key_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_key_directory FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_key_directory_readable ON ai_key_directory
    FOR SELECT USING (current_setting('app.ai_custody', true) = 'yes'
                   OR organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ai_key_directory_insertable ON ai_key_directory
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
REVOKE UPDATE, DELETE ON ai_key_directory FROM fathom_app;

CREATE TABLE IF NOT EXISTS ai_request_nonces (
    key_id     text        NOT NULL REFERENCES ai_keys(id) ON DELETE RESTRICT,
    nonce_hash bytea       NOT NULL CHECK (octet_length(nonce_hash) = 32),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (key_id, nonce_hash)
);
CREATE INDEX IF NOT EXISTS ai_request_nonces_expiry_idx ON ai_request_nonces (expires_at);

ALTER TABLE ai_request_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_request_nonces FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_request_nonces_readable ON ai_request_nonces
    FOR SELECT USING (current_setting('app.ai_custody', true) = 'yes');
CREATE POLICY ai_request_nonces_insertable ON ai_request_nonces
    FOR INSERT WITH CHECK (current_setting('app.ai_custody', true) = 'yes');
-- Only rows that can no longer be replayed anyway go; the sweep runs on the
-- write path (no scheduler, 0014 section C).
CREATE POLICY ai_request_nonces_sweepable ON ai_request_nonces
    FOR DELETE USING (current_setting('app.ai_custody', true) = 'yes'
                      AND expires_at < now());
REVOKE UPDATE ON ai_request_nonces FROM fathom_app;

CREATE TABLE IF NOT EXISTS ai_key_use (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    key_id          text        NOT NULL REFERENCES ai_keys(id) ON DELETE RESTRICT,
    day             date        NOT NULL,
    requests        integer     NOT NULL CHECK (requests >= 0),
    last_at         timestamptz NOT NULL,
    last_from       text        CHECK (last_from IS NULL OR char_length(last_from) <= 64),
    PRIMARY KEY (key_id, day)
);

ALTER TABLE ai_key_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_key_use FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_key_use_readable ON ai_key_use
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true)
                   OR current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY ai_key_use_insertable ON ai_key_use
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ai_key_use_updatable ON ai_key_use
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
REVOKE DELETE ON ai_key_use FROM fathom_app;

-- ---------------------------------------------------------------------------
-- D. THE OPERATOR'S SWITCH
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_site_switch (
    id          text        PRIMARY KEY CHECK (id = 'site'),
    allowed     boolean     NOT NULL,
    reason      text        CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 300),
    changed_by  text        NOT NULL,
    changed_at  timestamptz NOT NULL DEFAULT now(),
    changed_seq bigint      NOT NULL CHECK (changed_seq >= 1),
    row_version integer     NOT NULL DEFAULT 1 CHECK (row_version >= 1),
    row_seal    bytea       NOT NULL CHECK (octet_length(row_seal) = 32)
);

ALTER TABLE ai_site_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_site_switch FORCE  ROW LEVEL SECURITY;
-- Whether AI is allowed on this server is no secret: every plane reads it.
CREATE POLICY ai_site_switch_readable ON ai_site_switch FOR SELECT USING (true);
CREATE POLICY ai_site_switch_insertable ON ai_site_switch
    FOR INSERT WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
CREATE POLICY ai_site_switch_updatable ON ai_site_switch
    FOR UPDATE USING (current_setting('app.operator_custody', true) = 'yes')
            WITH CHECK (current_setting('app.operator_custody', true) = 'yes');
REVOKE DELETE ON ai_site_switch FROM fathom_app;

-- ---------------------------------------------------------------------------
-- E. RECOMMENDATIONS
--
-- What the AI wrote (title, reason, steps) is ONE JSON blob sealed under the
-- organisation content key, bound to tenant, id, design, key, owner and epoch.
-- The plain columns are the ones the server decides on. A dismissal re-seals
-- the body as empty, so what the AI wrote is not kept once nobody wants it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_recommendations (
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    id              text        NOT NULL CHECK (char_length(id) = 26),
    design_id       text        NOT NULL,
    key_id          text        NOT NULL REFERENCES ai_keys(id) ON DELETE RESTRICT,
    owner           text        NOT NULL REFERENCES accounts(id),
    step_count      integer     NOT NULL CHECK (step_count BETWEEN 1 AND 20),
    created_at      timestamptz NOT NULL DEFAULT now(),
    state           text        NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'accepted', 'dismissed')),
    decided_by      text        REFERENCES accounts(id),
    decided_at      timestamptz,
    version         bigint      NOT NULL DEFAULT 1 CHECK (version >= 1),
    ciphertext      bytea       NOT NULL,
    nonce           bytea       NOT NULL CHECK (octet_length(nonce) = 12),
    key_epoch       integer     NOT NULL CHECK (key_epoch >= 1),
    PRIMARY KEY (organisation_id, id),
    FOREIGN KEY (design_id, organisation_id) REFERENCES designs (id, organisation_id)
        ON DELETE RESTRICT,
    CHECK ((state = 'open') = (decided_by IS NULL AND decided_at IS NULL))
);

CREATE INDEX IF NOT EXISTS ai_recommendations_design_idx
    ON ai_recommendations (organisation_id, design_id, state, created_at);

ALTER TABLE ai_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_recommendations FORCE  ROW LEVEL SECURITY;

REVOKE DELETE, UPDATE ON ai_recommendations FROM fathom_app;
GRANT UPDATE (state, decided_by, decided_at, version, ciphertext, nonce, key_epoch)
    ON ai_recommendations TO fathom_app;

CREATE POLICY ai_recommendations_readable ON ai_recommendations
    FOR SELECT USING (organisation_id = current_setting('app.tenant_id', true));
CREATE POLICY ai_recommendations_insertable ON ai_recommendations
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND owner = current_setting('app.account_id', true));
CREATE POLICY ai_recommendations_updatable ON ai_recommendations
    FOR UPDATE USING (organisation_id = current_setting('app.tenant_id', true))
            WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                    AND (decided_by IS NULL
                         OR decided_by = current_setting('app.account_id', true)));

-- ---------------------------------------------------------------------------
-- G. THE CONNECTOR SIGN-IN (ADR-0072 decisions 13 to 17)
--
-- Read and written with `app.ai_custody` = 'yes', which `src/oauth.rs` sets
-- only while it is registering an app, redeeming a code or a refresh token, or
-- turning a bearer token into a verified request, exactly as `src/ai.rs` does
-- for a signed one. A code is written by the browser's signed consent, in the
-- organisation's own context. Nothing here is a secret: codes and tokens are
-- hashed with a labelled SHA-256, and a hash cannot be presented.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_oauth_clients (
    id            text        PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 64),
    client_name   text        NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
    redirect_uris text[]      NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
    created_at    timestamptz NOT NULL DEFAULT now(),
    used          boolean     NOT NULL DEFAULT false
);

ALTER TABLE ai_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_oauth_clients FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_oauth_clients_readable ON ai_oauth_clients
    FOR SELECT USING (current_setting('app.ai_custody', true) = 'yes');
CREATE POLICY ai_oauth_clients_insertable ON ai_oauth_clients
    FOR INSERT WITH CHECK (current_setting('app.ai_custody', true) = 'yes');
CREATE POLICY ai_oauth_clients_markable ON ai_oauth_clients
    FOR UPDATE USING (current_setting('app.ai_custody', true) = 'yes')
            WITH CHECK (current_setting('app.ai_custody', true) = 'yes');
-- A registration nobody signed in with is swept after an hour, on the write path.
CREATE POLICY ai_oauth_clients_sweepable ON ai_oauth_clients
    FOR DELETE USING (current_setting('app.ai_custody', true) = 'yes'
                      AND NOT used AND created_at < now() - interval '1 hour');
REVOKE UPDATE ON ai_oauth_clients FROM fathom_app;
GRANT UPDATE (used) ON ai_oauth_clients TO fathom_app;

CREATE TABLE IF NOT EXISTS ai_oauth_codes (
    code_hash       bytea       PRIMARY KEY CHECK (octet_length(code_hash) = 32),
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    key_id          text        NOT NULL REFERENCES ai_keys(id) ON DELETE RESTRICT,
    client_id       text        NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 300),
    redirect_uri    text        NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 500),
    code_challenge  text        NOT NULL CHECK (char_length(code_challenge) = 43),
    expires_at      timestamptz NOT NULL,
    used_at         timestamptz
);

ALTER TABLE ai_oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_oauth_codes FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_oauth_codes_insertable ON ai_oauth_codes
    FOR INSERT WITH CHECK (organisation_id = current_setting('app.tenant_id', true)
                       AND used_at IS NULL);
CREATE POLICY ai_oauth_codes_readable ON ai_oauth_codes
    FOR SELECT USING (current_setting('app.ai_custody', true) = 'yes');
CREATE POLICY ai_oauth_codes_spendable ON ai_oauth_codes
    FOR UPDATE USING (current_setting('app.ai_custody', true) = 'yes' AND used_at IS NULL)
            WITH CHECK (current_setting('app.ai_custody', true) = 'yes' AND used_at IS NOT NULL);
CREATE POLICY ai_oauth_codes_sweepable ON ai_oauth_codes
    FOR DELETE USING (current_setting('app.ai_custody', true) = 'yes'
                      AND expires_at < now() - interval '1 day');
REVOKE UPDATE ON ai_oauth_codes FROM fathom_app;
GRANT UPDATE (used_at) ON ai_oauth_codes TO fathom_app;

CREATE TABLE IF NOT EXISTS ai_oauth_tokens (
    token_hash      bytea       PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    organisation_id text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    key_id          text        NOT NULL REFERENCES ai_keys(id) ON DELETE RESTRICT,
    -- One sign-in's tokens share a family; a refresh token used twice ends it.
    family          text        NOT NULL CHECK (char_length(family) = 26),
    kind            text        NOT NULL CHECK (kind IN ('access', 'refresh')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    used_at         timestamptz,
    CHECK (expires_at > created_at),
    CHECK (kind = 'refresh' OR used_at IS NULL)
);
CREATE INDEX IF NOT EXISTS ai_oauth_tokens_family_idx ON ai_oauth_tokens (family);

ALTER TABLE ai_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_oauth_tokens FORCE  ROW LEVEL SECURITY;
CREATE POLICY ai_oauth_tokens_readable ON ai_oauth_tokens
    FOR SELECT USING (current_setting('app.ai_custody', true) = 'yes');
CREATE POLICY ai_oauth_tokens_insertable ON ai_oauth_tokens
    FOR INSERT WITH CHECK (current_setting('app.ai_custody', true) = 'yes' AND used_at IS NULL);
-- Spending a refresh token, or ending a family, only ever moves expiry earlier.
CREATE POLICY ai_oauth_tokens_endable ON ai_oauth_tokens
    FOR UPDATE USING (current_setting('app.ai_custody', true) = 'yes')
            WITH CHECK (current_setting('app.ai_custody', true) = 'yes');
CREATE POLICY ai_oauth_tokens_sweepable ON ai_oauth_tokens
    FOR DELETE USING (current_setting('app.ai_custody', true) = 'yes'
                      AND expires_at < now() - interval '1 day');
REVOKE UPDATE ON ai_oauth_tokens FROM fathom_app;
GRANT UPDATE (expires_at, used_at) ON ai_oauth_tokens TO fathom_app;

CREATE OR REPLACE FUNCTION fathom_ai_token_moves() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.expires_at > OLD.expires_at THEN
        RAISE EXCEPTION 'an AI token''s end is never moved later';
    END IF;
    IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
        RAISE EXCEPTION 'a spent refresh token stays spent';
    END IF;
    RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS ai_oauth_tokens_moves ON ai_oauth_tokens;
CREATE TRIGGER ai_oauth_tokens_moves
    BEFORE UPDATE ON ai_oauth_tokens
    FOR EACH ROW EXECUTE FUNCTION fathom_ai_token_moves();

-- ---------------------------------------------------------------------------
-- F. ENTRY TYPES. Organisation chain: ai_policy_changed, ai_key_made,
-- ai_key_changed, ai_key_disabled, ai_recommendation_decided. Site chain:
-- ai_switch_changed, ai_key_disabled (an operator's disable is filed on both,
-- as grant_suspended is). The list is 0038's plus these; mirrored by
-- `EntryType::kinds()` in `src/chain.rs`.
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
                                -- 0043.
                                'ai_switch_changed', 'ai_key_disabled'))
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
                                -- 0043.
                                'ai_policy_changed', 'ai_key_made', 'ai_key_changed',
                                'ai_key_disabled', 'ai_recommendation_decided'))
    );

ALTER TABLE chain_entries FORCE ROW LEVEL SECURITY;
