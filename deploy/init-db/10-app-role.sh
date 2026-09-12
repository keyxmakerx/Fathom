#!/bin/sh
# Creates the MIGRATION role and database `fathom-server` uses to apply
# migrations, and generates two passwords into the key volume rather than
# taking either from the environment -- its own, and the RUNTIME role's.
#
# `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §15.0, decided 2026-09-12: **the
# migration role and the runtime role are separated.** Until this, one role
# owned every table, ran the migrations, held `CREATEROLE` -- AND served
# every request. This script now provisions only the MIGRATION half of that
# split; the RUNTIME role (`fathom_app`) is created by
# `crates/fathom-server/migrations/0006_runtime_role.sql`, inside the
# migration chain, `NOLOGIN` -- and `fathom-server` itself, holding this
# script's migration role's connection, turns it into a connectable one at
# every startup (`src/db.rs::provision_runtime_login`, called from
# `src/main.rs`). See that migration's header for the fuller accounting of
# why the role is created there and not here.
#
# `docs/REBUILD-PLAN.md` Phase 2 §"Operational foundations" item 4: the
# postgres image's bootstrap role (`POSTGRES_USER` above, in this compose
# file `fathom_bootstrap`) is ALWAYS created a superuser, regardless of the
# name given it, and a superuser bypasses row-level security unconditionally
# -- `FORCE ROW LEVEL SECURITY` or not
# (`crates/fathom-server/migrations/0002_identity_and_scope.sql`). So the
# server must never connect as it, for EITHER role. This script runs exactly
# once, the first time this volume is initialised
# (`docker-entrypoint-initdb.d` only runs against an empty data directory),
# as that bootstrap superuser, and its job is to create the migration role --
# not one -- and hand it its own database -- the same shape
# `.github/workflows/ci.yml` already provisions for the test suite
# (`fathom_test`), so the same kind of role runs the tests and the
# deployment.
#
# THE OWNER CLAUSE IS THE PART THAT MATTERS. Since PostgreSQL 15, a freshly
# created database's `public` schema is owned by the pseudo-role
# `pg_database_owner`, which always resolves to whichever role owns the
# *current* database -- so `OWNER fathom` below is what lets `fathom` (and so
# `fathom-server`'s own migration runner, which connects as it)
# `CREATE TABLE`, `ALTER TABLE ... FORCE ROW LEVEL SECURITY` and
# `CREATE POLICY` without being granted anything else. Confirmed 2026-09-12
# against a real PostgreSQL 16: a NOSUPERUSER role that owns its database
# this way runs every statement in migration 0002, and its own `pg_roles` row
# afterwards reads `rolsuper = f`, `rolbypassrls = f` -- which is exactly what
# `fathom_server::rls::assert_rls_binds` checks at startup before it will run
# a migration at all, and now checks against BOTH roles (`src/main.rs`).
#
# CREATEROLE, ADDED 2026-09-12 (before the two-role split), KEPT NOW BECAUSE
# THE SPLIT NEEDS IT MORE, NOT LESS.
# `crates/fathom-server/migrations/0005_planes.sql` creates the operator
# plane and `0006_runtime_role.sql` creates the runtime role, both inside the
# migration chain rather than in a script that only ever runs against an
# empty data directory, and both need `CREATEROLE` to do it. What that costs:
# `fathom` already OWNS every table in its database, so it can already `DROP
# POLICY`, `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` and read every row;
# `CREATEROLE` lets it additionally create further roles, which is
# persistence for an attacker who already holds this credential rather than
# an escalation of what that credential can read. On PostgreSQL 16 and later
# a `CREATEROLE` role may only manage roles it created, and may not create a
# superuser. `assert_rls_binds` still refuses to start if this role ever
# becomes a superuser or gains BYPASSRLS -- and, since the split, refuses
# just the same for the runtime role it provisions.
#
# NEITHER PASSWORD IS TYPED INTO compose.yaml.
# `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §0.1: in a Docker deployment
# whoever writes the compose file holds the Docker socket and is therefore a
# host-level attacker, so a password typed there proves nothing. §1.4 draws
# the consequence: the application's own database password must never appear
# in the compose file or the environment; it is generated at first start into
# the key volume, beside where the master key will live once
# `docs/OPEN-QUESTIONS.md` A1 is answered. Without this, "the runtime role
# cannot reach a design's data outside its own tenant" is a claim about a
# role the attacker does not have to use. This script now generates TWO such
# passwords -- one per role -- for the same reason it generated one before.
#
# WHY THIS SCRIPT GENERATES THE RUNTIME PASSWORD TOO, EVEN THOUGH THE RUNTIME
# ROLE DOES NOT EXIST YET WHEN IT RUNS. `fathom_app` is created by
# `0006_runtime_role.sql`, which only runs once `fathom-server` starts and
# migrates -- after this script has already finished. A password does not
# need its role to exist yet: this script writes `db_app.pw` into the key
# volume exactly as it writes `db_migrate.pw`, and `fathom-server` reads it
# back (`FATHOM_DB_PASSWORD_FILE`) once it holds a `CREATEROLE` connection as
# the migration role, to `ALTER ROLE fathom_app LOGIN PASSWORD` it. That is
# `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §1.4's own mechanism, word for
# word -- see `crates/fathom-server/src/db.rs::provision_runtime_login` for
# the one place it still deviates from §1.4 as written (the SERVER does not
# generate the password itself, because its filesystem is read-only; this
# script does, for the same reason it already generated the migration
# password).
#
# THE FILE MODE IS 0444 AND THAT IS DELIBERATE, not an oversight of §1.4's
# 0400. The postgres image runs its init scripts as the `postgres` user and
# the server container runs as uid 65532; there is no shared uid to own a
# 0400 file, and inventing a shared gid to get one would be a moving part
# that hides rather than removes the exposure. The fence §1.4 actually claims
# is the VOLUME, not the mode: anything that can read this volume is tier 3
# and already has -- or will have -- the master key sitting next to it. The
# operator's register gains one line: "the migration role's and the
# application role's database passwords are both generated at first start
# into the key volume; if you copy that volume off the machine, you have
# copied them too."
set -eu

KEY_DIR=/var/lib/fathom/keys
MIGRATE_PW_FILE="$KEY_DIR/db_migrate.pw"
APP_PW_FILE="$KEY_DIR/db_app.pw"

mkdir -p "$KEY_DIR"

# A helper, not a function this shell dialect can rely on everywhere: read an
# existing password back, or generate and persist a fresh one. "If it does
# not exist" -- §1.4's own wording. A data directory recreated against a key
# volume that still holds a password must reuse it, or the server would be
# handed a credential the database does not have.
#
# The kernel CSPRNG, read as a file. No `openssl`, no `pwgen`: this is a
# POSIX shell in a database image, and `crates/fathom-server/src/ids.rs`
# already establishes /dev/urandom as this project's entropy source on the
# Linux containers it ships as. 32 bytes, hex-encoded.
generate_if_absent() {
    file="$1"
    if [ ! -s "$file" ]; then
        head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n' > "$file"
        printf '\n' >> "$file"
    fi
    chmod 0444 "$file"
}

generate_if_absent "$MIGRATE_PW_FILE"
generate_if_absent "$APP_PW_FILE"

FATHOM_MIGRATE_PASSWORD="$(tr -d '\n' < "$MIGRATE_PW_FILE")"

# `psql -v` and a `:'variable'` placeholder, never shell interpolation into
# the SQL text: the password is 64 hex characters today, and a future change
# to how it is generated must not be able to turn this into an injection.
# Only the MIGRATION role is created here -- see the file header for why the
# runtime role (`fathom_app`) is created inside the migration chain instead,
# and why its password file is generated above without a role to attach it to
# yet.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
     -v migrate_password="$FATHOM_MIGRATE_PASSWORD" <<-'EOSQL'
    CREATE ROLE fathom LOGIN PASSWORD :'migrate_password'
        NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE DATABASE fathom OWNER fathom;
EOSQL
