-- 0078 -- a wait after a device refuses a login (sign-off r117, finding 10; the owner ticked it
-- for this round on 12 November 2026).
--
-- Every press of Read with a wrong login is one failed login on the device, and a device that
-- locks an account after a few failures (Junos `retry-options lockout-period`, EOS `aaa
-- authentication policy lockout`) would lock the read-only account Fathom reads with. Fathom
-- never retries on its own; this stops a person pressing again and again.
--
-- One row per organisation, device address and login: how many times in a row the device
-- refused it, when last, and until when Fathom will not send it again. `address_mac` is the same
-- HMAC the host key and engine rows use (0073 A, 0077 A), so the address is never in the clear,
-- and SNMP and SSH are kept apart. `login_version` is the vault entry's version at the refusal:
-- once the login is changed in the vault the wait no longer applies. A read that succeeds
-- deletes the row, so this table only ever holds open waits and recent refusals.

CREATE TABLE IF NOT EXISTS device_read_refusals (
    organisation_id  text        NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
    address_mac      bytea       NOT NULL CHECK (octet_length(address_mac) = 32),
    login            text        NOT NULL CHECK (char_length(login) BETWEEN 1 AND 64),
    login_version    bigint      NULL,
    refusals         integer     NOT NULL CHECK (refusals >= 1),
    last_refused_at  timestamptz NOT NULL DEFAULT now(),
    wait_until       timestamptz NOT NULL,
    PRIMARY KEY (organisation_id, address_mac, login)
);

ALTER TABLE device_read_refusals ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_read_refusals FORCE ROW LEVEL SECURITY;
REVOKE TRUNCATE ON device_read_refusals FROM fathom_app;

CREATE POLICY device_read_refusals_tenant ON device_read_refusals
    USING (organisation_id = current_setting('app.tenant_id', true))
    WITH CHECK (organisation_id = current_setting('app.tenant_id', true));
