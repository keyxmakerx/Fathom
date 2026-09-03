#!/bin/sh
# The look-alike check's own test.
#
# The first case is the August 2026 attack, reconstructed: `proc-macro1` in a
# lockfile beside `proc-macro2`. If this check is worth having, that case fails.

set -eu

CHECK="$(pwd)/scripts/lockfile-lookalikes.sh"
[ -x "$CHECK" ] || { echo "lookalikes-test: $CHECK is not executable"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

lock() {
    : > "$TMP/Cargo.lock"
    printf 'version = 4\n' >> "$TMP/Cargo.lock"
}
pkg() {
    printf '\n[[package]]\nname = "%s"\nversion = "1.0.0"\n' "$1" >> "$TMP/Cargo.lock"
    [ "${2:-}" != external ] ||
        printf 'source = "registry+https://github.com/rust-lang/crates.io-index"\n' \
            >> "$TMP/Cargo.lock"
}
allow() { cat > "$TMP/allow.md"; }

runq() {
    expect="$1"; label="$2"; needle="${3:-}"
    out=$(LOOKALIKE_LOCK="$TMP/Cargo.lock" LOOKALIKE_ALLOW="$TMP/allow.md" \
          "$CHECK" 2>&1) && rc=0 || rc=$?
    ok=1
    [ "$expect" = ok ] && [ "$rc" -ne 0 ] && ok=0
    [ "$expect" = fail ] && [ "$rc" -eq 0 ] && ok=0
    if [ -n "$needle" ]; then
        case "$out" in *"$needle"*) : ;; *) ok=0 ;; esac
    fi
    if [ "$ok" -eq 1 ]; then pass=$((pass + 1)); echo "  ok    $label"
    else
        fail=$((fail + 1)); echo "  FAIL  $label (expected $expect, exit $rc)"
        echo "$out" | sed 's/^/        /'
    fi
}

echo "lockfile-lookalikes-test"
allow </dev/null

# ---- THE AUGUST 2026 SHAPE ----
lock; pkg fathom-id; pkg proc-macro2 external; pkg proc-macro1 external
runq fail "proc-macro1 beside proc-macro2 fails" "proc-macro1"

# ...and it fails when the squat arrives beside a FIRST-PARTY name too.
lock; pkg fathom-id; pkg fathom-ld external
runq fail "an external squat of a first-party name fails" "fathom-ld"

# ---- what must NOT fail ----
lock; pkg fathom-id; pkg fathom-ir
runq ok "two first-party crates one edit apart are not a pair"

lock; pkg tokio external; pkg tokio-util external; pkg axum external; pkg tracing external
runq ok "an ordinary graph with no one-edit pair passes"

# One edit apart is one edit: two is not a pair.
lock; pkg bytes external; pkg byteorder external
runq ok "two edits apart is not reported"

# ---- the three edit kinds ----
lock; pkg serde external; pkg serdes external        # insertion
runq fail "an inserted character is one edit" "serdes"
lock; pkg futures external; pkg future external      # deletion
runq fail "a deleted character is one edit" "future"
lock; pkg log external; pkg l0g external             # substitution
runq fail "a substituted character is one edit" "l0g"

# ---- an accepted pair ----
lock; pkg proc-macro2 external; pkg proc-macro1 external
allow <<'EOF'
<!-- lookalikes:accepted -->
| a | b | why |
|---|---|---|
| `proc-macro1` | `proc-macro2` | fixture only |
<!-- lookalikes:end -->
EOF
runq ok "an accepted pair passes"

# ...and only inside the markers.
allow <<'EOF'
| `proc-macro1` | `proc-macro2` | this row is outside the markers |
EOF
runq fail "an accepted row outside the markers admits nothing" "proc-macro1"

echo
echo "lockfile-lookalikes-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
