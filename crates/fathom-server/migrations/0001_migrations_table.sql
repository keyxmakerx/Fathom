-- 0001 — the migrations table, and nothing else.
--
-- WO-11 §6 G8: this order stores NOTHING. No tenant table, no user table, no
-- graph table. `crates/fathom-server/tests/stores_nothing.rs` reads every file
-- in this directory and fails if any of them creates another table.
--
-- WHY THAT IS A GATE AND NOT AN OVERSIGHT. ADR-0040 decided that the server
-- holds a data key per tenant AND per design **from the first stored byte**,
-- and ADR-0040 §9 items 1 and 2 leave the key-management service undecided —
-- including for self-hosted deployments with no cloud KMS. WO-11 §7 trigger 2
-- puts it plainly: the first row written before custody is decided is exactly
-- the retrofit ADR-0040 exists to prevent. So the schema this order ships is
-- the machinery for changing the schema, and no schema.

CREATE TABLE IF NOT EXISTS _fathom_migrations (
    -- The migration's number, taken from its filename. Not a serial: the
    -- identity of a migration is what the file is called, so that two people
    -- adding a migration at the same time collide in git rather than silently
    -- both applying.
    version     integer     PRIMARY KEY,

    -- The filename, so a mismatch between the recorded name and the file on
    -- disk is visible rather than inferred.
    name        text        NOT NULL,

    -- SHA-256 is not available without a dependency here, so this records the
    -- length and a simple checksum of the file's bytes. It is enough to notice
    -- an APPLIED MIGRATION HAVING BEEN EDITED, which is the failure it exists
    -- for, and it is not a security control and is not claimed as one.
    byte_len    integer     NOT NULL,
    checksum    bigint      NOT NULL,

    applied_at  timestamptz NOT NULL DEFAULT now()
);
