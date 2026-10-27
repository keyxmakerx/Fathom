#!/usr/bin/env bash
# Run the workspace's test binaries side by side instead of one after another
# (`cargo test` runs them in sequence). Each binary runs from its own crate
# directory, as `cargo test` would; its output is printed when it finishes.
# Doc tests run after, through cargo. Usage: parallel-tests.sh [jobs]
#
# Each fathom-server test binary gets a database of its own, made fresh here as
# the superuser and owned by the migration role. Most server tests hold the site
# chain lock for their whole length, and an advisory lock spans every process on
# one database: with one shared database the three largest binaries (design_api,
# invitations, firmware) ran one test at a time between them, about eight of the
# ten minutes CI spent on tests (run 40368433792, 2026-10-26). The lock is per
# database, so it now serialises a binary against itself only. The runtime role
# is cluster-wide and its login is provisioned with a retry for exactly this
# race (`db::provision_runtime_login`); docs/NEXT.md rule 3 runs the same way.
# With no superuser to be had, every binary shares the one database as before.
set -euo pipefail

jobs="${1:-$(nproc)}"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

cargo test --workspace --locked --no-run --message-format=json \
  | jq -r 'select(.reason == "compiler-artifact" and .profile.test and .executable != null)
           | "\(.manifest_path)\t\(.executable)"' > "$out/bins"

su_url="${SUPERUSER_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/postgres}"
migrate_url="${FATHOM_MIGRATE_DATABASE_URL:-postgres://fathom_test:fathom_test_pw@127.0.0.1:5432/fathom_test}"
# The same URL naming another database; query parameters are kept.
with_db() { sed -E "s#/[^/?]*(\?.*)?\$#/$2\1#" <<< "$1"; }
own_db=false
if command -v psql > /dev/null && psql "$su_url" -qAtc 'SELECT 1' > /dev/null 2>&1; then
  own_db=true
  shared_db="$(sed -E 's#^.*/([^/?]*)(\?.*)?$#\1#' <<< "$migrate_url")"
  owner="$(sed -E 's#^[a-z]+://([^:@/]*).*#\1#' <<< "$migrate_url")"
else
  echo "no superuser at SUPERUSER_DATABASE_URL: every test binary shares one database"
fi
export su_url migrate_url own_db shared_db owner
export -f with_db

run_one() {
  local manifest="$1" exe="$2" log
  log="$3/$(basename "$exe").log"
  local start=$SECONDS
  if [ "$own_db" = true ] && [[ "$manifest" == */crates/fathom-server/Cargo.toml ]]; then
    local stem db
    stem="$(basename "$exe")"; stem="${stem%-*}"
    db="${shared_db}_${stem}"; db="${db:0:63}"
    psql "$su_url" -qAt -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" \
      -c "CREATE DATABASE \"$db\" OWNER \"$owner\"" > /dev/null
    export FATHOM_MIGRATE_DATABASE_URL
    FATHOM_MIGRATE_DATABASE_URL="$(with_db "$migrate_url" "$db")"
    # Unset, the tests derive it from the migration URL.
    [ -z "${DATABASE_URL:-}" ] || export DATABASE_URL="$(with_db "$DATABASE_URL" "$db")"
  fi
  if (cd "$(dirname "$manifest")" && CARGO_MANIFEST_DIR="$(dirname "$manifest")" "$exe") > "$log" 2>&1; then
    echo "ok    $((SECONDS - start))s  $(basename "$exe")"
  else
    echo "FAIL  $((SECONDS - start))s  $(basename "$exe")"
    cat "$log"
    touch "$3/failed"
  fi
}
export -f run_one

# Largest binary first: a rough stand-in for slowest first.
while IFS=$'\t' read -r manifest exe; do
  printf '%s\t%s\t%s\n' "$(stat -c %s "$exe")" "$manifest" "$exe"
done < "$out/bins" | sort -rn | cut -f2- \
  | xargs -P "$jobs" -d '\n' -I{} bash -c 'IFS=$'"'"'\t'"'"' read -r m e <<< "$1"; run_one "$m" "$e" "$2"' _ {} "$out"

test ! -e "$out/failed" || { echo "test binaries failed"; exit 1; }
cargo test --workspace --locked --doc
