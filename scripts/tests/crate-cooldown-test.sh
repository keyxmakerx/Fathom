#!/bin/sh
# The cooldown's own test — WO-11 §5 step 0 layer 5.
#
# THE HONEST LIMIT OF THIS TEST, stated first. It proves the ARITHMETIC and the
# fail-closed behaviour. It does not prove the live fetch, because the session
# this was written in cannot reach crates.io's API: the egress policy answers
# 403 for crates.io while allowing index.crates.io, and the README for that
# proxy says not to route around a policy denial. The live path runs in CI,
# where there is no such policy, and the first CI run is its first proof.
#
# What IS proved here, offline and repeatably: a version published today fails,
# a version published years ago passes, the window is respected at its boundary,
# and an unreachable registry fails rather than passes.

set -eu

COOLDOWN="$(pwd)/scripts/crate-cooldown.sh"
[ -x "$COOLDOWN" ] || { echo "cooldown-test: $COOLDOWN is not executable"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

check() {
    expect="$1"; label="$2"; shift 2
    out=$("$@" 2>&1) && rc=0 || rc=$?
    if { [ "$expect" = ok ] && [ "$rc" -eq 0 ]; } ||
       { [ "$expect" = fail ] && [ "$rc" -ne 0 ]; }; then
        pass=$((pass + 1)); echo "  ok    $label"
    else
        fail=$((fail + 1)); echo "  FAIL  $label (expected $expect, exit $rc)"
        echo "$out" | sed 's/^/        /'
    fi
}

# A saved API response shape, with dates computed relative to now so the fixture
# never goes stale and starts passing for the wrong reason.
python3 - "$TMP" <<'PY'
import json, sys, datetime, os
tmp = sys.argv[1]
now = datetime.datetime.now(datetime.timezone.utc)
def iso(days):
    return (now - datetime.timedelta(days=days)).isoformat().replace("+00:00", "Z")
doc = {
    "crate": {"name": "fixture-crate"},
    "versions": [
        {"num": "1.0.0", "created_at": iso(400), "yanked": False},
        {"num": "1.1.0", "created_at": iso(30),  "yanked": False},
        {"num": "1.2.0", "created_at": iso(8),   "yanked": False},
        {"num": "1.2.1", "created_at": iso(6),   "yanked": False},
        {"num": "1.3.0", "created_at": iso(0),   "yanked": False},
    ],
}
json.dump(doc, open(os.path.join(tmp, "fixture.json"), "w"))
PY

echo "crate-cooldown-test"

# ---- the arithmetic ----
check ok   "a version published 400 days ago passes"  \
      "$COOLDOWN" --fixture "$TMP/fixture.json" 1.0.0
check ok   "a version published 30 days ago passes"   \
      "$COOLDOWN" --fixture "$TMP/fixture.json" 1.1.0
check ok   "8 days old passes a 7-day window"         \
      "$COOLDOWN" --fixture "$TMP/fixture.json" 1.2.0
check fail "6 days old fails a 7-day window"          \
      "$COOLDOWN" --fixture "$TMP/fixture.json" 1.2.1
check fail "published today fails"                    \
      "$COOLDOWN" --fixture "$TMP/fixture.json" 1.3.0
check fail "one young version fails the whole set"    \
      "$COOLDOWN" --fixture "$TMP/fixture.json"

# ---- the window moves ----
check ok   "a 1-day window admits the 6-day-old version" \
      env COOLDOWN_DAYS=1 "$COOLDOWN" --fixture "$TMP/fixture.json" 1.2.1
check fail "a 60-day window rejects the 30-day-old one" \
      env COOLDOWN_DAYS=60 "$COOLDOWN" --fixture "$TMP/fixture.json" 1.1.0

# ---- fail closed ----
# An external package with a registry that cannot answer. PATH is emptied of
# curl by pointing the script at a lockfile and a host that resolves nowhere;
# simplest reliable form is a curl that cannot succeed.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'EOF'
#!/bin/sh
exit 7
EOF
chmod +x "$TMP/bin/curl"
printf 'version = 4\n\n[[package]]\nname = "unreachable-crate"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n' > "$TMP/Cargo.lock"

out=$(PATH="$TMP/bin:$PATH" COOLDOWN_LOCK="$TMP/Cargo.lock" "$COOLDOWN" 2>&1) && rc=0 || rc=$?
case "$out" in
    *UNREACHABLE*) reached=1 ;;
    *) reached=0 ;;
esac
if [ "$rc" -ne 0 ] && [ "$reached" -eq 1 ]; then
    pass=$((pass + 1)); echo "  ok    an unreachable registry FAILS rather than passes"
else
    fail=$((fail + 1)); echo "  FAIL  an unreachable registry FAILS rather than passes (exit $rc)"
    echo "$out" | sed 's/^/        /'
fi

# ...and the override turns the layer off, loudly.
out=$(PATH="$TMP/bin:$PATH" COOLDOWN_LOCK="$TMP/Cargo.lock" \
      COOLDOWN_ALLOW_UNREACHABLE=1 "$COOLDOWN" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
    pass=$((pass + 1)); echo "  ok    COOLDOWN_ALLOW_UNREACHABLE=1 turns the layer off"
else
    fail=$((fail + 1)); echo "  FAIL  COOLDOWN_ALLOW_UNREACHABLE=1 turns the layer off (exit $rc)"
    echo "$out" | sed 's/^/        /'
fi

# ---- an empty lockfile is a pass, not a vacuous skip ----
printf 'version = 4\n\n[[package]]\nname = "fathom-id"\nversion = "0.1.0"\n' > "$TMP/first-party.lock"
check ok "a first-party-only lockfile passes" \
      env COOLDOWN_LOCK="$TMP/first-party.lock" "$COOLDOWN"

echo
echo "crate-cooldown-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
