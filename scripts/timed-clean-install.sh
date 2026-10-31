#!/usr/bin/env bash
# A clean install, timed: the Docker Compose steps `docs/RUNNING-IT.md` gives
# a newcomer, run in order from a fresh checkout, with the wall clock read at
# each one. One of the Alpha items (Sign-offs page, r28-alpha, 2026-10-25).
#
# What it times, and what a person does at each point:
#
#   1. .env            cp .env.example .env, set the two lines with no default
#   2. pull            `docker compose pull`: the published images, from cold
#   3. healthy         `docker compose up -d --wait`: keys, PostgreSQL,
#                      migrations, catalogue, until the server's own
#                      healthcheck passes
#   4. answering       GET /health and the client on the published port
#   5. first sign-in   the setup password redeemed, a password and an
#                      authenticator set, and a signed request answered, over
#                      HTTP with the browser client's own bytes
#                      (scripts/ci/first-operator-signin.mjs; needs Node 22+)
#
# Step 5 stands in for the five screens a person clicks through. It times the
# server's half; the person's reading, typing and phone-scanning is theirs and
# is not counted. scripts/drive-fresh-install.mjs clicks the same screens in a
# real browser, against a server built from source.
#
# Usage, from the root of a fresh checkout on a machine with Docker:
#
#   ./scripts/timed-clean-install.sh you@example.com
#
# It refuses to run over an existing `.env` or existing `fathom_` volumes,
# because then it is not a clean install. It leaves the stack running, a real
# install with a real first operator; the setup password it generated is in
# `.env`, and the password and authenticator secret step 5 chose are the CI
# script's fixed ones, so for anything but a timing run, take it down after:
# `docker compose down -v`. `--down` does that at the end.
#
# Times are whole seconds from `date +%s`, which macOS's date also has.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ADDRESS=""
DOWN=0
for arg in "$@"; do
  case "$arg" in
    --down) DOWN=1 ;;
    -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
    *) ADDRESS="$arg" ;;
  esac
done
[ -n "$ADDRESS" ] || { echo "usage: $0 <operator notice address> [--down]" >&2; exit 2; }

PORT="${FATHOM_PORT:-8080}"
BASE="http://localhost:${PORT}"

[ ! -e .env ] || { echo "timed-clean-install: .env exists, so this is not a clean install" >&2; exit 1; }
if [ -n "$(docker volume ls -q --filter name=fathom_)" ]; then
  echo "timed-clean-install: fathom_ volumes exist, so this is not a clean install:" >&2
  docker volume ls -q --filter name=fathom_ >&2
  exit 1
fi
command -v node > /dev/null || { echo "timed-clean-install: step 5 needs Node 22 or newer" >&2; exit 1; }

STEPS=()
start=$(date +%s)
last=$start
mark() {
  local now
  now=$(date +%s)
  STEPS+=("$(printf '%-16s %5ss   %5ss' "$1" "$((now - last))" "$((now - start))")")
  echo "==> $1 done, $((now - last))s"
  last=$now
}

# 1. .env, as the page says: the address, and a setup password generated
#    rather than typed, in single quotes.
echo "==> 1. .env"
SETUP_PASSWORD="$(openssl rand -base64 24)"
cp .env.example .env
sed -i.bak \
  -e "s|^FATHOM_OPERATOR_NOTICE_ADDRESS=\$|FATHOM_OPERATOR_NOTICE_ADDRESS=${ADDRESS}|" \
  -e "s|^FATHOM_SETUP_PASSWORD=\$|FATHOM_SETUP_PASSWORD='${SETUP_PASSWORD}'|" \
  .env
rm -f .env.bak
grep -q "^FATHOM_SETUP_PASSWORD='" .env || { echo "timed-clean-install: .env.example has changed shape" >&2; exit 1; }
mark ".env"

echo "==> 2. docker compose pull"
docker compose pull --quiet
mark "pull"

echo "==> 3. docker compose up -d --wait"
docker compose up --detach --wait --wait-timeout 300
mark "healthy"

echo "==> 4. GET /health and the client on ${BASE}"
for i in $(seq 1 30); do
  curl -fs "${BASE}/health" > /dev/null && break
  [ "$i" -lt 30 ] || { echo "timed-clean-install: /health never answered" >&2; exit 1; }
  sleep 1
done
curl -fs "${BASE}/" | grep -q "<title>" || { echo "timed-clean-install: the client is not served" >&2; exit 1; }
mark "answering"

echo "==> 5. first sign-in"
FATHOM_SETUP_PASSWORD="$SETUP_PASSWORD" FATHOM_OPERATOR_NOTICE_ADDRESS="$ADDRESS" \
  node scripts/ci/first-operator-signin.mjs "$BASE" > first-signin.log 2>&1 \
  || { cat first-signin.log >&2; echo "timed-clean-install: first sign-in failed" >&2; exit 1; }
rm -f first-signin.log
mark "first sign-in"

digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$(docker compose images -q server | head -1)" 2>/dev/null || echo unknown)"

{
  echo
  echo "Clean install, $(date -u +%Y-%m-%dT%H:%MZ), on $(uname -sm)"
  echo "server image   ${digest}"
  echo
  echo "step               took      at"
  printf '%s\n' "${STEPS[@]}"
  echo
  echo "total            $((last - start))s"
}

if [ "$DOWN" -eq 1 ]; then
  docker compose down -v
  rm -f .env
fi
