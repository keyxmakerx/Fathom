-- 0048 -- Passbolt as a third kind of outside vault (ADR-0071 part four, Passbolt; owner's
-- answers 2026-10-26, r34-passbolt v2 B and r34-passbolt-crates A).
--
-- A Passbolt connection keeps the same row as the others: the account's user id and Fathom's own
-- private key for it, armored, with the server key's fingerprint and (once bound) the shared
-- metadata key's, are sealed under vault.key in `secret_ct`; `outside_org_id` is the account's
-- user id.
--
-- What is new is **waiting**. Fathom finishes the invited account's setup with its own key
-- before anyone in Passbolt has shared a folder with it, so for a while the connection has no
-- folder. It is `waiting`, with no `collection_id`, until the first check that passes binds the
-- one folder it sees; only then is it `on`. A waiting connection uses nothing and pulls nothing.

ALTER TABLE vault.outside_connections
    DROP CONSTRAINT IF EXISTS outside_connections_provider_check;
ALTER TABLE vault.outside_connections
    ADD CONSTRAINT outside_connections_provider_check
    CHECK (provider IN ('vaultwarden', 'delinea', 'passbolt'));

ALTER TABLE vault.outside_connections
    DROP CONSTRAINT IF EXISTS outside_connections_state_check;
ALTER TABLE vault.outside_connections
    ADD CONSTRAINT outside_connections_state_check
    CHECK (state IN ('waiting', 'on', 'stopped', 'disconnected'));

ALTER TABLE vault.outside_connections ALTER COLUMN collection_id DROP NOT NULL;

-- Only a Passbolt connection waits, and only a waiting one (or one disconnected while it
-- waited) has no folder.
ALTER TABLE vault.outside_connections
    DROP CONSTRAINT IF EXISTS outside_connections_waiting_check;
ALTER TABLE vault.outside_connections
    ADD CONSTRAINT outside_connections_waiting_check
    CHECK ((state <> 'waiting' OR (provider = 'passbolt' AND collection_id IS NULL))
       AND (collection_id IS NOT NULL OR state IN ('waiting', 'disconnected')));

-- Binding sets the folder.
GRANT UPDATE (collection_id) ON vault.outside_connections TO fathom_app;
