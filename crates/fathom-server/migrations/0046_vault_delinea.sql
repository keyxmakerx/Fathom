-- 0046 -- Delinea Secret Server as a second kind of outside vault (ADR-0071 part four, Delinea).
--
-- Nothing new is stored. A Secret Server connection keeps the same row as a Vaultwarden one: the
-- application account's user name and password are sealed under vault.key in `secret_ct`, its
-- one folder's id is `collection_id` (and `outside_org_id`, Secret Server having no
-- organisations), and the folder's name, which Secret Server shows in the clear, is
-- `collection_name`. Only the provider list widens.

ALTER TABLE vault.outside_connections
    DROP CONSTRAINT IF EXISTS outside_connections_provider_check;
ALTER TABLE vault.outside_connections
    ADD CONSTRAINT outside_connections_provider_check
    CHECK (provider IN ('vaultwarden', 'delinea'));
