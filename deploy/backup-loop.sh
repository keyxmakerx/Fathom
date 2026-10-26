#!/bin/bash
# The nightly backup service (ADR-0070). Runs in `compose.yaml`'s `backup`
# container: `deploy/Dockerfile`'s `backup` stage, which is the postgres image
# (for pg_dump and pg_restore) with the fathom-server binary added.
#
# Every night at FATHOM_BACKUP_AT (UTC, default 02:00) it seals a dump of the
# `fathom` database and the staged firmware into a data file in the backups
# volume, and keeps the newest FATHOM_BACKUP_KEEP (default 14). On
# FATHOM_BACKUP_TEST_DAY (ISO weekday, 1 is Monday, default 7) it then restores
# the newest data file into a throwaway database and drops it again.
#
# It writes what happened to `status` in the same volume, as `name value`
# lines the server reads for the Backups screen. A keys file is never made
# here: the phrase has to reach a person, so that is `keys-file`, run by hand.
#
# `backup-loop.sh once` makes one backup and exits; `backup-loop.sh test` runs
# one restore test and exits.

set -u
set -o pipefail

DIR=${FATHOM_BACKUP_DIR:-/var/lib/fathom/backups}
AT=${FATHOM_BACKUP_AT:-02:00}
KEEP=${FATHOM_BACKUP_KEEP:-14}
TEST_DAY=${FATHOM_BACKUP_TEST_DAY:-7}
KEYS=${FATHOM_KEYS_DIR:-/var/lib/fathom/keys}
BIN=/usr/local/bin/fathom-server

export PGHOST=${PGHOST:-db}
export PGUSER=${PGUSER:-fathom_bootstrap}
PGPASSWORD=$(tr -d '\n' < "$KEYS/db_bootstrap.pw") || {
    echo "backup: cannot read $KEYS/db_bootstrap.pw" >&2
    exit 1
}
export PGPASSWORD

case "$KEEP" in '' | *[!0-9]*) echo "backup: FATHOM_BACKUP_KEEP must be a number" >&2; exit 2 ;; esac
case "$TEST_DAY" in [1-7]) ;; *) echo "backup: FATHOM_BACKUP_TEST_DAY must be 1 to 7" >&2; exit 2 ;; esac
case "$AT" in [0-2][0-9]:[0-5][0-9]) ;; *) echo "backup: FATHOM_BACKUP_AT must be HH:MM" >&2; exit 2 ;; esac

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One `name value` per line. Rewritten whole, through a temporary file, so the
# server never reads half of it.
set_status() {
    local name=$1 value=$2 tmp="$DIR/.status.$$"
    { [ -f "$DIR/status" ] && grep -v "^$name " "$DIR/status"; printf '%s %s\n' "$name" "$value"; } > "$tmp"
    mv "$tmp" "$DIR/status"
}

backup_once() {
    local stamp file err
    stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
    file="$DIR/fathom-$stamp.fdata"
    err=$(mktemp)
    if pg_dump -d fathom -Fc 2>>"$err" | "$BIN" backup > "$file.part" 2>>"$err"; then
        mv "$file.part" "$file"
        set_status last_backup_at "$(now)"
        set_status last_backup_file "$(basename "$file")"
        set_status last_backup_bytes "$(stat -c %s "$file")"
        set_status last_result ok
        set_status last_error -
        echo "backup: wrote $(basename "$file")"
    else
        rm -f "$file.part"
        set_status last_result failed
        set_status last_failed_at "$(now)"
        set_status last_error "$(tail -n 1 "$err" | tr -d '\r' | cut -c1-300)"
        echo "backup: FAILED" >&2
        cat "$err" >&2
    fi
    rm -f "$err"
    # Prune: keep the newest $KEEP. Names sort by time.
    ls -1 "$DIR"/fathom-*.fdata 2>/dev/null | sort | head -n "-$KEEP" | while read -r old; do
        rm -f "$old"
    done
    set_status kept "$(ls -1 "$DIR"/fathom-*.fdata 2>/dev/null | wc -l)"
}

restore_test() {
    local newest err db=fathom_restore_test start
    newest=$(ls -1 "$DIR"/fathom-*.fdata 2>/dev/null | sort | tail -n 1)
    if [ -z "$newest" ]; then
        set_status last_test_result "no backup to test"
        return
    fi
    err=$(mktemp)
    start=$(date +%s)
    dropdb --if-exists "$db" 2>>"$err"
    if createdb "$db" 2>>"$err" &&
        "$BIN" dump-from "$newest" 2>>"$err" | pg_restore -d "$db" --exit-on-error 2>>"$err"; then
        set_status last_test_result ok
        set_status last_test_seconds "$(( $(date +%s) - start ))"
        echo "backup: restore test of $(basename "$newest") passed"
    else
        set_status last_test_result failed
        set_status last_test_error "$(tail -n 1 "$err" | tr -d '\r' | cut -c1-300)"
        echo "backup: restore test of $(basename "$newest") FAILED" >&2
        cat "$err" >&2
    fi
    set_status last_test_at "$(now)"
    set_status last_test_file "$(basename "$newest")"
    dropdb --if-exists "$db" 2>/dev/null
    rm -f "$err"
}

# Seconds until the next $AT, UTC.
until_next() {
    local target nowsec
    nowsec=$(date -u +%s)
    target=$(date -u -d "today $AT" +%s)
    [ "$target" -le "$nowsec" ] && target=$(date -u -d "tomorrow $AT" +%s)
    echo $(( target - nowsec ))
}

mkdir -p "$DIR"
case "${1:-loop}" in
    once) backup_once; exit 0 ;;
    test) restore_test; exit 0 ;;
    loop) ;;
    *) echo "backup: say once, test, or nothing" >&2; exit 2 ;;
esac

set_status schedule "$AT UTC, keep $KEEP, restore test on ISO day $TEST_DAY"
echo "backup: nightly at $AT UTC, keeping $KEEP; restore test on ISO weekday $TEST_DAY"
while true; do
    wait_for=$(until_next)
    set_status next_backup_at "$(date -u -d "@$(( $(date -u +%s) + wait_for ))" +%Y-%m-%dT%H:%M:%SZ)"
    sleep "$wait_for"
    backup_once
    if [ "$(date -u +%u)" = "$TEST_DAY" ]; then
        restore_test
    fi
done
