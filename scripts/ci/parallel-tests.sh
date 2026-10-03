#!/usr/bin/env bash
# Run the workspace's test binaries side by side instead of one after another
# (`cargo test` runs them in sequence). Each binary runs from its own crate
# directory, as `cargo test` would; its output is printed when it finishes.
# Doc tests run after, through cargo. Usage: parallel-tests.sh [jobs]
set -euo pipefail

jobs="${1:-$(nproc)}"
# Most of a server test's wall time is waiting (a one-time code's next step, a delay), not
# computing, so each binary runs more test threads than there are cores. The default is the
# core count. Needs the database's max_connections raised (ci.yml does).
export RUST_TEST_THREADS="${RUST_TEST_THREADS:-16}"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

cargo test --workspace --locked --no-run --message-format=json \
  | jq -r 'select(.reason == "compiler-artifact" and .profile.test and .executable != null)
           | "\(.manifest_path)\t\(.executable)"' > "$out/bins"

run_one() {
  local manifest="$1" exe="$2" log
  log="$3/$(basename "$exe").log"
  local start=$SECONDS
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
