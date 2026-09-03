#!/bin/sh
# The cooldown's own test — WO-11 §5 step 0 layer 5.
#
# Two halves. The ARITHMETIC is driven offline against dates computed relative
# to now, so the fixture never goes stale and starts passing for the wrong
# reason. The LOOKUP is driven against static.crates.io with a real crate whose
# publication date is years old, so a green result means the header was actually
# read rather than defaulted.
#
# And the fail-closed behaviour is driven with a curl that cannot succeed,
# because "it fails when the network is down" is the property that decides
# whether this is a gate or a decoration, and it is not one to assume.

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

ago() { date -u -R -d "-$1 days"; }

echo "crate-cooldown-test"

# ---- the arithmetic, at and around the boundary ----
check ok   "400 days old passes a 7-day window"  "$COOLDOWN" --age "$(ago 400)"
check ok   "30 days old passes"                  "$COOLDOWN" --age "$(ago 30)"
check ok   "8 days old passes"                   "$COOLDOWN" --age "$(ago 8)"
check fail "6 days old fails"                    "$COOLDOWN" --age "$(ago 6)"
check fail "published today fails"               "$COOLDOWN" --age "$(date -u -R)"

# ---- the window moves, in both directions ----
check ok   "a 1-day window admits the 6-day-old release" \
      env COOLDOWN_DAYS=1 "$COOLDOWN" --age "$(ago 6)"
check fail "a 60-day window rejects the 30-day-old one" \
      env COOLDOWN_DAYS=60 "$COOLDOWN" --age "$(ago 30)"

# ---- a first-party-only lockfile is a pass, not a vacuous skip ----
printf 'version = 4\n\n[[package]]\nname = "fathom-id"\nversion = "0.1.0"\n' > "$TMP/first-party.lock"
check ok "a first-party-only lockfile passes" \
      env COOLDOWN_LOCK="$TMP/first-party.lock" "$COOLDOWN"

# ---- THE REAL LOOKUP. A version published years ago must be read and pass. ----
# If the header were not being read, this would land in the UNREACHABLE path and
# fail, so a green here means static.crates.io actually answered.
cat > "$TMP/old.lock" <<'EOF'
version = 4

[[package]]
name = "fathom-id"
version = "0.1.0"

[[package]]
name = "cfg-if"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
EOF
out=$(COOLDOWN_LOCK="$TMP/old.lock" "$COOLDOWN" 2>&1) && rc=0 || rc=$?
case "$out" in
    *"1 external package(s) checked"*) read_it=1 ;;
    *) read_it=0 ;;
esac
if [ "$rc" -eq 0 ] && [ "$read_it" -eq 1 ]; then
    pass=$((pass + 1)); echo "  ok    a real, long-published crate is read from the CDN and passes"
else
    fail=$((fail + 1)); echo "  FAIL  a real, long-published crate is read from the CDN and passes (exit $rc)"
    echo "$out" | sed 's/^/        /'
fi

# ...and the same crate against a window wider than its whole life must FAIL,
# which proves the date read above is a real date and not a constant.
out=$(COOLDOWN_LOCK="$TMP/old.lock" COOLDOWN_DAYS=99999 "$COOLDOWN" 2>&1) && rc=0 || rc=$?
if [ "$rc" -ne 0 ]; then
    pass=$((pass + 1)); echo "  ok    the date read from the CDN is a real date, not a constant"
else
    fail=$((fail + 1)); echo "  FAIL  the date read from the CDN is a real date, not a constant"
    echo "$out" | sed 's/^/        /'
fi

# ---- fail closed ----
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexit 7\n' > "$TMP/bin/curl"
chmod +x "$TMP/bin/curl"

out=$(PATH="$TMP/bin:$PATH" COOLDOWN_LOCK="$TMP/old.lock" "$COOLDOWN" 2>&1) && rc=0 || rc=$?
case "$out" in *UNREACHABLE*) said=1 ;; *) said=0 ;; esac
if [ "$rc" -ne 0 ] && [ "$said" -eq 1 ]; then
    pass=$((pass + 1)); echo "  ok    an unreachable CDN FAILS rather than passes"
else
    fail=$((fail + 1)); echo "  FAIL  an unreachable CDN FAILS rather than passes (exit $rc)"
    echo "$out" | sed 's/^/        /'
fi

out=$(PATH="$TMP/bin:$PATH" COOLDOWN_LOCK="$TMP/old.lock" \
      COOLDOWN_ALLOW_UNREACHABLE=1 "$COOLDOWN" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
    pass=$((pass + 1)); echo "  ok    COOLDOWN_ALLOW_UNREACHABLE=1 turns the layer off"
else
    fail=$((fail + 1)); echo "  FAIL  COOLDOWN_ALLOW_UNREACHABLE=1 turns the layer off (exit $rc)"
    echo "$out" | sed 's/^/        /'
fi

echo
echo "crate-cooldown-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
