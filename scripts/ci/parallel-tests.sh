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
#
# A binary against itself was still the floor: `sessions` alone took 275 s and
# `credentials` 159 s, one test at a time, while the rest of the suite had long
# finished (run 41542851161, 2026-11-02). So a server binary's tests are now cut
# into chunks of CHUNK (default 8), each chunk run by name (`--exact`) against a
# database of its own. That is the same isolation two binaries already had from
# each other, and the lock still serialises every test that shares a database.
#
# TEST_SHARD=i/n (default 1/1) runs only the i-th of n even shares of those
# units, so CI can spread one suite over several runners. Every share lists the
# same units in the same order and deals them out the same way (largest first,
# to the lightest share), so the n shares together run every test exactly once.
# Doc tests run in share 1 only. PLAN_ONLY=1 prints the dealing and runs nothing.
set -euo pipefail

jobs="${1:-$(nproc)}"
chunk="${CHUNK:-8}"
shard="${TEST_SHARD:-1/1}"
shard_i="${shard%/*}"
shard_n="${shard#*/}"
if ! [[ "$shard_i" =~ ^[0-9]+$ && "$shard_n" =~ ^[0-9]+$ ]] \
  || [ "$shard_i" -lt 1 ] || [ "$shard_i" -gt "$shard_n" ]; then
  echo "TEST_SHARD must be i/n with 1 <= i <= n, not '$shard'" >&2
  exit 2
fi
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
if [ "${PLAN_ONLY:-0}" = 1 ] \
  || { command -v psql > /dev/null && psql "$su_url" -qAtc 'SELECT 1' > /dev/null 2>&1; }; then
  own_db=true
  shared_db="$(sed -E 's#^.*/([^/?]*)(\?.*)?$#\1#' <<< "$migrate_url")"
  owner="$(sed -E 's#^[a-z]+://([^:@/]*).*#\1#' <<< "$migrate_url")"
else
  echo "no superuser at SUPERUSER_DATABASE_URL: every test binary shares one database"
fi
export su_url migrate_url own_db shared_db owner
export -f with_db

# The units: one per binary, except a server binary with databases of its own,
# which is one unit per chunk of its tests. Each unit is a line of
#   weight <TAB> name <TAB> manifest <TAB> exe <TAB> file of test names (or -)
# The weight is the number of server tests in it (a server test is seconds, the
# rest milliseconds), and one for any other binary.
: > "$out/units"
while IFS=$'\t' read -r manifest exe; do
  stem="$(basename "$exe")"; stem="${stem%-*}"
  if [ "$own_db" = true ] && [[ "$manifest" == */crates/fathom-server/Cargo.toml ]]; then
    (cd "$(dirname "$manifest")" && "$exe" --list --format=terse) \
      | sed -n 's/: test$//p' | LC_ALL=C sort > "$out/$stem.$(basename "$exe").tests"
    total="$(wc -l < "$out/$stem.$(basename "$exe").tests")"
    [ "$total" -gt 0 ] || continue
    split -l "$chunk" -d -a 3 "$out/$stem.$(basename "$exe").tests" "$out/$(basename "$exe").chunk."
    for f in "$out/$(basename "$exe").chunk."*; do
      k="${f##*.}"
      printf '%s\t%s\t%s\t%s\t%s\n' "$(wc -l < "$f")" "$stem.$k" "$manifest" "$exe" "$f"
    done >> "$out/units"
  else
    printf '1\t%s\t%s\t%s\t-\n' "$stem" "$manifest" "$exe" >> "$out/units"
  fi
done < "$out/bins"

# Deal the units out: heaviest first, each to the lightest share so far, ties to
# the lowest share. The order is fixed by weight and name, never by the order
# cargo happened to report the binaries in, so every share computes the same
# dealing. (Two binaries can share a stem; their names then tie, and the
# executable path, unique and the same on every runner, breaks it.)
LC_ALL=C sort -t $'\t' -k1,1nr -k2,2 -k4,4 "$out/units" \
  | awk -F'\t' -v n="$shard_n" -v OFS='\t' '
      { best = 1
        for (s = 2; s <= n; s++) if (load[s] < load[best]) best = s
        load[best] += $1
        print best, $0 }
      END { for (s = 1; s <= n; s++) printf "share %d of %d: weight %d\n", s, n, load[s] > "/dev/stderr" }' \
  > "$out/dealt"
awk -F'\t' -v i="$shard_i" -v OFS='\t' '$1 == i { print $3, $4, $5, $6 }' "$out/dealt" > "$out/mine"
echo "share $shard: $(wc -l < "$out/mine") of $(wc -l < "$out/dealt") units, $jobs at a time"

if [ "${PLAN_ONLY:-0}" = 1 ]; then
  cut -f1,3 "$out/dealt"
  exit 0
fi

run_one() {
  local name="$1" manifest="$2" exe="$3" tests="$4" log
  log="$5/$name.log"
  local start=$SECONDS
  local -a args=()
  if [ "$tests" != - ]; then
    mapfile -t args < "$tests"
    args=(--exact "${args[@]}")
  fi
  if [ "$own_db" = true ] && [[ "$manifest" == */crates/fathom-server/Cargo.toml ]]; then
    local db
    db="${shared_db}_${name//./_}"; db="${db:0:63}"
    psql "$su_url" -qAt -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" \
      -c "CREATE DATABASE \"$db\" OWNER \"$owner\"" > /dev/null
    export FATHOM_MIGRATE_DATABASE_URL
    FATHOM_MIGRATE_DATABASE_URL="$(with_db "$migrate_url" "$db")"
    # Unset, the tests derive it from the migration URL.
    [ -z "${DATABASE_URL:-}" ] || export DATABASE_URL="$(with_db "$DATABASE_URL" "$db")"
  fi
  if (cd "$(dirname "$manifest")" && CARGO_MANIFEST_DIR="$(dirname "$manifest")" "$exe" "${args[@]}") > "$log" 2>&1; then
    echo "ok    $((SECONDS - start))s  $name  $(grep -Eo '[0-9]+ passed' "$log" | awk '{ n += $1 } END { print n + 0 }') passed"
  else
    echo "FAIL  $((SECONDS - start))s  $name"
    cat "$log"
    touch "$5/failed"
  fi
}
export -f run_one

# Heaviest first, so the long units are not the last to start.
xargs -P "$jobs" -d '\n' -I{} \
  bash -c 'IFS=$'"'"'\t'"'"' read -r n m e t <<< "$1"; run_one "$n" "$m" "$e" "$t" "$2"' _ {} "$out" \
  < "$out/mine"

test ! -e "$out/failed" || { echo "test binaries failed"; exit 1; }
if [ "$shard_i" = 1 ]; then
  cargo test --workspace --locked --doc
fi
