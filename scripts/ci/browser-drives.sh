#!/usr/bin/env bash
# Run the browser drives CI keeps green: the core paths a new person walks, each driven in a real
# Chromium. Sequential, because the real-server drives each start a server of their own on a fixed port.
# Every drive runs even if an earlier one fails, so one run says everything that is broken; the
# exit status is non-zero if any failed. Usage: scripts/ci/browser-drives.sh [name ...]
#
# Needs what the drives themselves need (see each file's header): PostgreSQL on 127.0.0.1:5432 with the
# fathom_test role, `cargo build -p fathom-server --locked`, `bash scripts/build-wasm.sh`, a built client
# (`cd client && npm ci --ignore-scripts && npm run build`), and PW_PLAYWRIGHT / PW_CHROMIUM.
#
# Two kinds. The REAL-SERVER drives start the built fathom-server on a database they create and
# drop, and drive the built client through it: first run, sign-in, an organisation, a site, a design, a
# saved device, two browsers on one design. The HARNESS drives mount the real client over a scene with
# the network answered in the page (scripts/drive-lib/harness.tsx), the way the client's own tests do:
# the sample, Inventory, opening a device, a paste through the redaction gate, a maintenance plan.
#
# Flaky drives are fixed, never dropped from this list. Add a drive here only after it has passed twice
# in a row on a loaded machine (scripts/drive-lib/cpuThrottle.mjs slows the browser for that).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

DRIVES=(
  sample            # the sample opens, a trace crosses two switches, the first steps tick
  inventory         # the table, an edit, a bulk tag, print
  open-device       # a double-click opens a device; Inside, Config, a paste through the card
  config-drawer     # a paste: every credential destroyed at the gate, none on the page or in a request
  plans             # a maintenance plan from planning to recorded
  fresh-install     # first run to a saved device: setup password, organisation, site, design
  signed-in-browsers # sign-in on a second browser, and the signed-in list
  first-design      # a saved design, two browsers editing it live
  add-equipment     # opening the sample and the equipment list against the real server
  two-custodies     # one person with two custodies: account and operator sign-ins
)
[ "$#" -gt 0 ] && DRIVES=("$@")

failed=()
total_start=$(date +%s)
for d in "${DRIVES[@]}"; do
  echo "::group::drive-$d"
  start=$(date +%s)
  if node "scripts/drive-$d.mjs"; then result=passed; else result=FAILED; failed+=("$d"); fi
  echo "::endgroup::"
  echo "drive-$d $result in $(( $(date +%s) - start ))s"
done
echo "all drives took $(( $(date +%s) - total_start ))s"
if [ "${#failed[@]}" -gt 0 ]; then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
