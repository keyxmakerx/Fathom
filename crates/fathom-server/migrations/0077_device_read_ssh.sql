-- 0077 -- reading a device over SSH (ADR-0082 §4.1 and §4.4; r87-reader-packages, the owner,
-- 2 November 2026). Written as 0076; renumbered 0077 when combined (0075 is orders, 0076 templates).
--
-- A. HOST KEYS beside ENGINE IDS. An SSH server's host key is confirmed before any login exactly
--   as an SNMPv3 agent's engine id is (0073 A): typed last 8 characters for one device, or a
--   Steward's batch for a range; a changed key stops every read until it is confirmed on its
--   own. They share `device_read_engines`, with a `protocol` so the Steward's list can say which
--   is which. An SSH row's `address_mac` is an HMAC of `ssh|<address>` under the same key, so it
--   never collides with the SNMP row for the same address and the primary key stands. Every row
--   already here is SNMP.
--
-- B. A CONFIGURATION READING. `device_readings.kind` gains `config`: the platform's fixed
--   commands' output, through the gate in the reader and checked again on the server, sealed as
--   0073 B seals the rest and kept as the newest ten.
--
-- No new entry type: a host key's approval files `device_read_engine_approved` with
-- `protocol: "ssh"`, and an SSH read files `device_read_done` with kind `config`.

ALTER TABLE device_read_engines
    ADD COLUMN IF NOT EXISTS protocol text NOT NULL DEFAULT 'snmp'
        CHECK (protocol IN ('snmp', 'ssh'));

ALTER TABLE device_readings
    DROP CONSTRAINT IF EXISTS device_readings_kind_check;

ALTER TABLE device_readings
    ADD CONSTRAINT device_readings_kind_check CHECK (kind IN ('device', 'macarp', 'config'));
