#!/bin/sh
# The licence check's own test (ADR-0060 decision 12). A gate nobody has watched
# fail is not known to work, so this drives it over fixture lockfiles and asserts
# both directions.

set -eu

CHECK="$(pwd)/scripts/licences-npm.mjs"
[ -f "$CHECK" ] || { echo "licences-npm-test: $CHECK is missing"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$TMP/modules"

pass=0
fail=0

# lock <licence of the shipped package> <licence of the build tool>
lock() {
    cat > "$TMP/lock.json" <<JSON
{ "lockfileVersion": 3, "packages": {
  "": { "name": "client" },
  "node_modules/shipped": { "version": "1.0.0", "license": "$1" },
  "node_modules/tool": { "version": "2.0.0", "license": "$2", "dev": true }
} }
JSON
}

run() {
    LICENCES_LOCK="$TMP/lock.json" LICENCES_OUT="$TMP/out.json" LICENCES_MODULES="$TMP/modules" node "$CHECK" "$@" 2>&1
}

expect() {
    want="$1"; label="$2"; needle="${3:-}"
    out=$(run) && rc=0 || rc=$?
    ok=1
    [ "$want" = ok ] && [ "$rc" -ne 0 ] && ok=0
    [ "$want" = fail ] && [ "$rc" -eq 0 ] && ok=0
    if [ -n "$needle" ]; then
        case "$out" in *"$needle"*) : ;; *) ok=0 ;; esac
    fi
    if [ "$ok" -eq 1 ]; then pass=$((pass + 1)); echo "  ok    $label"
    else
        fail=$((fail + 1)); echo "  FAIL  $label (expected $want, exit $rc)"
        echo "$out" | sed 's/^/        /' | head -5
    fi
}

# write <shipped licence> <tool licence>: a lockfile and its matching About list
write() { lock "$1" "$2"; run --write > /dev/null 2>&1 || true; }

echo "licences-npm-test"

write MIT MIT
expect ok "a shipped MIT package and an MIT build tool pass"

write MIT MPL-2.0
expect ok "MPL-2.0 is allowed for a build tool"

write MPL-2.0 MIT
expect fail "MPL-2.0 is refused for a shipped package" '"MPL-2.0" is not on the shipped list'

write GPL-3.0-only MIT
expect fail "GPL is refused for a shipped package" "GPL-3.0-only"

write MIT GPL-3.0-only
expect fail "GPL is refused for a build tool too" "build-tool list"

write "SEE LICENSE IN LICENSE.txt" MIT
expect fail "a proprietary licence file is refused" "SEE LICENSE IN"

write "(MIT OR GPL-3.0-only)" MIT
expect ok "OR needs only one allowed side"

write "MIT AND GPL-3.0-only" MIT
expect fail "AND needs both sides allowed" "MIT AND GPL-3.0-only"

write "Apache-2.0 WITH LLVM-exception" MIT
expect ok "an allowed licence with its exception passes"

write "(MIT" MIT
expect fail "a malformed expression is refused" "(MIT"

write "" MIT
expect fail "a package with no licence is refused" "no licence recorded"

write MIT MIT
lock BSD-3-Clause MIT
expect fail "an About list that no longer matches the lockfile fails" "--write"

rm -f "$TMP/out.json"
expect fail "a missing About list fails" "--write"

echo "licences-npm-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
