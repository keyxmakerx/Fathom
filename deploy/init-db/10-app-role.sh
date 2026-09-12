#!/bin/sh
# Creates the role and database `fathom-server` actually connects as, and
# generates that role's password into the key volume rather than taking it
# from the environment.
#
# `docs/REBUILD-PLAN.md` Phase 2 §"Operational foundations" item 4: the
# postgres image's bootstrap role (`POSTGRES_USER` above, in this compose
# file `fathom_bootstrap`) is ALWAYS created a superuser, regardless of the
# name given it, and a superuser bypasses row-level security unconditionally
# -- `FORCE ROW LEVEL SECURITY` or not
# (`crates/fathom-server/migrations/0002_identity_and_scope.sql`). So the
# server must never connect as it. This script runs exactly once, the first
# time this volume is initialised (`docker-entrypoint-initdb.d` only runs
# against an empty data directory), as that bootstrap superuser, and its only
# job is to create a role that is NOT one and hand it its own database --
# the same shape `.github/workflows/ci.yml` already provisions for the test
# suite (`fathom_test`), so the same kind of role runs the tests and the
# deployment.
#
# THE OWNER CLAUSE IS THE PART THAT MATTERS. Since PostgreSQL 15, a freshly
# created database's `public` schema is owned by the pseudo-role
# `pg_database_owner`, which always resolves to whichever role owns the
# *current* database -- so `OWNER fathom` below is what lets `fathom` (and so
# `fathom-server`'s own migration runner, which uses this same connection)
# `CREATE TABLE`, `ALTER TABLE ... FORCE ROW LEVEL SECURITY` and
# `CREATE POLICY` without being granted anything else. Confirmed 2026-09-12
# against a real PostgreSQL 16: a NOSUPERUSER role that owns its database
# this way runs every statement in migration 0002, and its own `pg_roles` row
# afterwards reads `rolsuper = f`, `rolbypassrls = f` -- which is exactly what
# `fathom_server::rls::assert_rls_binds` checks at startup before it will run
# a migration at all.
#
# ONE ROLE FOR BOTH MIGRATIONS AND THE RUNTIME SERVER, DELIBERATELY. The
# alternative -- a separate, more privileged role that owns the tables and
# runs migrations, with the server connecting as a lesser-privileged reader
# -- is a real option, but it is a second role to provision, rotate and keep
# in sync with every future migration's privilege needs, for no isolation
# benefit here: `assert_rls_binds` refuses BYPASSRLS and superuser, and
# `fathom` is neither. The single-role shape is what CI already validates
# (`fathom_test` runs the migrations in `tests/support::migrated_pool` and
# every repository-layer assertion after it), so this is the same shape
# proven twice rather than two similar shapes each proven once.
#
# CREATEROLE, ADDED 2026-09-12, AND THE HONEST ACCOUNTING FOR IT.
# `crates/fathom-server/migrations/0005_planes.sql` creates the second
# database role -- the sightless operator plane -- so that the roles and
# their grants live in the migration chain rather than in a script that only
# ever runs against an empty data directory. `CREATE ROLE` needs the
# `CREATEROLE` attribute. What that costs: `fathom` already OWNS every table
# in its database, so it can already `DROP POLICY`, `ALTER TABLE ... NO FORCE
# ROW LEVEL SECURITY` and read every row; `CREATEROLE` lets it additionally
# create further roles, which is persistence for an attacker who already
# holds this credential rather than an escalation of what that credential can
# read. On PostgreSQL 16 and later a `CREATEROLE` role may only manage roles
# it created, and may not create a superuser. `assert_rls_binds` still
# refuses to start if this role ever becomes a superuser or gains BYPASSRLS.
#
# THE PASSWORD IS GENERATED HERE, NOT TYPED INTO compose.yaml.
# `docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §0.1: in a Docker deployment
# whoever writes the compose file holds the Docker socket and is therefore a
# host-level attacker, so a password typed there proves nothing. §1.4 draws
# the consequence: the application's own database password must never appear
# in the compose file or the environment; it is generated at first start into
# the key volume, beside where the master key will live once
# `docs/OPEN-QUESTIONS.md` A1 is answered. Without this, "the operator role
# cannot read design data" is a claim about a role the attacker does not have
# to use.
#
# WHERE §1.4 IS NOT FOLLOWED TO THE LETTER, AND WHY. §1.4 has the SERVER
# generate the password and `ALTER ROLE` it. That cannot work as written:
# the server has to authenticate before it can issue `ALTER ROLE`, so the
# password must already exist. This script is the first thing that runs, has
# the privilege to set it, and runs exactly once -- so it is the generator.
# The server only reads the file (`FATHOM_DB_PASSWORD_FILE`).
#
# THE FILE MODE IS 0444 AND THAT IS DELIBERATE, not an oversight of §1.4's
# 0400. The postgres image runs its init scripts as the `postgres` user and
# the server container runs as uid 65532; there is no shared uid to own a
# 0400 file, and inventing a shared gid to get one would be a moving part
# that hides rather than removes the exposure. The fence §1.4 actually claims
# is the VOLUME, not the mode: anything that can read this volume is tier 3
# and already has -- or will have -- the master key sitting next to it. The
# operator's register gains one line: "the application's own database
# password is generated at first start into the key volume; if you copy that
# volume off the machine, you have copied it too."
set -eu

KEY_DIR=/var/lib/fathom/keys
PW_FILE="$KEY_DIR/db_app.pw"

mkdir -p "$KEY_DIR"

# "If it does not exist" -- §1.4's own wording. A data directory recreated
# against a key volume that still holds a password must reuse it, or the
# server would be handed a credential the database does not have.
if [ ! -s "$PW_FILE" ]; then
    # The kernel CSPRNG, read as a file. No `openssl`, no `pwgen`: this is a
    # POSIX shell in a database image, and `crates/fathom-server/src/ids.rs`
    # already establishes /dev/urandom as this project's entropy source on
    # the Linux containers it ships as. 32 bytes, hex-encoded.
    head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n' > "$PW_FILE"
    printf '\n' >> "$PW_FILE"
fi
chmod 0444 "$PW_FILE"

FATHOM_DB_PASSWORD="$(tr -d '\n' < "$PW_FILE")"

# `psql -v` and a `:'variable'` placeholder, never shell interpolation into
# the SQL text: the password is 64 hex characters today, and a future change
# to how it is generated must not be able to turn this into an injection.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
     -v app_password="$FATHOM_DB_PASSWORD" <<-'EOSQL'
    CREATE ROLE fathom LOGIN PASSWORD :'app_password'
        NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE DATABASE fathom OWNER fathom;
EOSQL
