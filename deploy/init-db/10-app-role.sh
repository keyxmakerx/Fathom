#!/bin/sh
# Creates the role and database `fathom-server` actually connects as.
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
set -eu

: "${FATHOM_DB_PASSWORD:?FATHOM_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE ROLE fathom LOGIN PASSWORD '$FATHOM_DB_PASSWORD'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE DATABASE fathom OWNER fathom;
EOSQL
