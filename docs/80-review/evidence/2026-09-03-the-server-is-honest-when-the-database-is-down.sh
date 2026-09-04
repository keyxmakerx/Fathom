#!/bin/sh
# WO-11 §6 G5 — /health answers only after a real database round trip, and
# reports unhealthy when PostgreSQL is stopped. Driven against a running
# PostgreSQL, not mocked.
#
# WHY THIS DRIVER EXISTS AND A UNIT TEST DOES NOT REPLACE IT. Every defect this
# project has found in a shipped surface was found in the real thing — 49 §19's
# four browser findings, the chooser's three defects on 2026-08-16, the paste
# hint that said REPLACES. A health check is the same class of surface: its
# whole job is to be wrong in a way the process itself cannot detect, so the
# only honest test stops the database and looks.
#
# WHAT IT ASSERTS, in order:
#
#   1. healthy against a real database, and the body says so
#   2. UNHEALTHY, 503, within the timeout, with PostgreSQL STOPPED -- the
#      assertion the whole order turns on
#   3. healthy again when it comes back, so the check is not merely stuck
#   4. the process survived all of it (a health check that kills the server it
#      is checking would pass 1 and 2 and be useless)
#   5. `healthcheck` as a subcommand agrees with the HTTP endpoint, both ways --
#      43 §5.4's "the binary is its own health check"
#   6. G8: the database contains the migrations table and NOTHING ELSE
#   7. G6: the canary password appears in no log line the server wrote
#
# Needs: docker, curl, and a release or debug build of fathom-server.
# Run from the workspace root.

set -eu

PG_CONTAINER="${PG_CONTAINER:-fathom-g5-pg}"
PG_PORT="${PG_PORT:-55432}"
CANARY="g5-canary-pw"
BIND="127.0.0.1:18080"
LOG=$(mktemp)
BIN="${BIN:-target/debug/fathom-server}"

pass=0
fail=0
ok()   { pass=$((pass + 1)); echo "  ok    $1"; }
bad()  { fail=$((fail + 1)); echo "  FAIL  $1"; }
check(){ if [ "$1" = 0 ]; then ok "$2"; else bad "$2"; fi; }

cleanup() {
    [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
    rm -f "$LOG"
}
trap cleanup EXIT INT TERM

[ -x "$BIN" ] || { echo "no $BIN — run: cargo build -p fathom-server"; exit 1; }
docker inspect "$PG_CONTAINER" > /dev/null 2>&1 || {
    echo "no container $PG_CONTAINER. Start one with:"
    echo "  docker run -d --name $PG_CONTAINER -e POSTGRES_PASSWORD=$CANARY \\"
    echo "    -e POSTGRES_USER=fathom -e POSTGRES_DB=fathom -p $PG_PORT:5432 postgres:18-alpine"
    exit 1
}

echo "the-server-is-honest-when-the-database-is-down"

docker start "$PG_CONTAINER" > /dev/null 2>&1 || true
i=0
while [ "$i" -lt 30 ]; do
    docker exec "$PG_CONTAINER" pg_isready -U fathom > /dev/null 2>&1 && break
    i=$((i + 1)); sleep 1
done

DATABASE_URL="postgres://fathom:$CANARY@127.0.0.1:$PG_PORT/fathom" \
FATHOM_BIND="$BIND" \
FATHOM_LOG=trace \
FATHOM_HEALTH_TIMEOUT_MS=2000 \
    "$BIN" > "$LOG" 2>&1 &
SERVER_PID=$!

# Wait for the listener, not a fixed sleep.
i=0
while [ "$i" -lt 40 ]; do
    curl -s -o /dev/null "http://$BIND/health" 2>/dev/null && break
    kill -0 "$SERVER_PID" 2>/dev/null || { echo "  the server exited during startup:"; sed 's/^/      /' "$LOG"; exit 1; }
    i=$((i + 1)); sleep 0.25
done

probe() { curl -s -o /tmp/.g5body -w '%{http_code}' --max-time 10 "http://$BIND/health"; }

# ---- 1. healthy against a real database ----
code=$(probe)
[ "$code" = 200 ]; check $? "healthy against a real database (200, got $code)"
grep -q '^ok$' /tmp/.g5body; check $? "the body says ok"

# ---- 2. THE ASSERTION THE ORDER TURNS ON ----
docker stop "$PG_CONTAINER" > /dev/null 2>&1
code=$(probe)
[ "$code" = 503 ]; check $? "UNHEALTHY with PostgreSQL stopped (503, got $code)"
grep -q 'unavailable' /tmp/.g5body; check $? "the body says why"
# 503 and not 500: an orchestrator reads 503 as "do not send me traffic yet".
[ "$code" != 500 ]; check $? "503 rather than 500"

# ---- 3. healthy again, so the check is not merely stuck ----
docker start "$PG_CONTAINER" > /dev/null 2>&1
i=0
while [ "$i" -lt 30 ]; do
    docker exec "$PG_CONTAINER" pg_isready -U fathom > /dev/null 2>&1 && break
    i=$((i + 1)); sleep 1
done
i=0; code=""
while [ "$i" -lt 20 ]; do
    code=$(probe)
    [ "$code" = 200 ] && break
    i=$((i + 1)); sleep 1
done
[ "$code" = 200 ]; check $? "healthy again once the database returns (got $code)"

# ---- 4. the server survived all of it ----
kill -0 "$SERVER_PID" 2>/dev/null; check $? "the server process survived the outage"

# ---- 5. the binary is its own health check (43 §5.4) ----
"$BIN" healthcheck --addr "$BIND" > /dev/null 2>&1
check $? "the healthcheck subcommand agrees: healthy"

docker stop "$PG_CONTAINER" > /dev/null 2>&1
if "$BIN" healthcheck --addr "$BIND" > /dev/null 2>&1; then
    bad "the healthcheck subcommand agrees: unhealthy"
else
    ok "the healthcheck subcommand agrees: unhealthy"
fi
# ...and against nothing at all listening, which is the container's first
# seconds and must not read as healthy.
if "$BIN" healthcheck --addr 127.0.0.1:1 > /dev/null 2>&1; then
    bad "nothing listening is not healthy"
else
    ok "nothing listening is not healthy"
fi
docker start "$PG_CONTAINER" > /dev/null 2>&1
i=0
while [ "$i" -lt 30 ]; do
    docker exec "$PG_CONTAINER" pg_isready -U fathom > /dev/null 2>&1 && break
    i=$((i + 1)); sleep 1
done

# ---- 6. G8: the migrations table and nothing else ----
tables=$(docker exec "$PG_CONTAINER" psql -U fathom -d fathom -At -c \
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1" 2>/dev/null)
[ "$tables" = "_fathom_migrations" ]
check $? "G8: the database holds the migrations table and nothing else (saw: ${tables:-none})"

rows=$(docker exec "$PG_CONTAINER" psql -U fathom -d fathom -At -c \
    "SELECT version || ' ' || name FROM _fathom_migrations ORDER BY version" 2>/dev/null)
[ "$rows" = "1 0001_migrations_table.sql" ]
check $? "the one migration recorded itself (saw: ${rows:-none})"

# ---- 7. G6: no secret in any log line the real process wrote ----
if grep -q "$CANARY" "$LOG"; then
    bad "G6: the canary password is in the server's own log output"
    grep -n "$CANARY" "$LOG" | sed 's/^/      /'
else
    ok "G6: the canary password appears in no log line the server wrote"
fi
# ...and not clean by being empty. It must still name the host.
grep -q "127.0.0.1:$PG_PORT" "$LOG"; check $? "the log still names which database"
grep -q "redacted" "$LOG"; check $? "and says the password was redacted"

# ---- graceful shutdown ----
kill -TERM "$SERVER_PID" 2>/dev/null
i=0
while [ "$i" -lt 20 ]; do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    i=$((i + 1)); sleep 0.25
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
    bad "SIGTERM stops the server"
    kill -KILL "$SERVER_PID" 2>/dev/null || true
else
    ok "SIGTERM stops the server"
fi
grep -q "SIGTERM received" "$LOG"; check $? "and it says so on the way out"
SERVER_PID=""

echo
echo "the-server-is-honest-when-the-database-is-down: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
