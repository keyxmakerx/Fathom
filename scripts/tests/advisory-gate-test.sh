#!/bin/sh
# G3's positive control — WO-11 §6.
#
# "A gate nobody has watched fail is not known to work." `cargo audit` in CI is
# worth nothing until someone has seen it reject something, so this script hands
# it a lockfile pinning a version with a real, filed advisory and asserts that
# it fails and names the advisory. Then it hands it the same lockfile with the
# patched version and asserts that it passes.
#
# The fixture is a KNOWN advisory with a KNOWN patched version, so the assertion
# does not decay: RUSTSEC-2025-0055 (2025-08-29, CVE-2025-58160), ANSI escape
# sequences in logged user input, affecting tracing-subscriber before 0.3.20.
# Read from the RustSec advisory database on 2026-09-03.
#
# It needs `cargo audit` on PATH and network access to the advisory database.
# Both exist in CI. If cargo-audit is absent this script says so and exits
# non-zero rather than quietly reporting success.

set -eu

command -v cargo-audit > /dev/null 2>&1 || cargo audit --version > /dev/null 2>&1 || {
    echo "advisory-gate-test: cargo audit is not installed"
    echo "  cargo install cargo-audit --locked"
    exit 1
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

write_lock() {
    cat > "$TMP/Cargo.lock" <<EOF
version = 4

[[package]]
name = "fathom-id"
version = "0.1.0"

[[package]]
name = "tracing-subscriber"
version = "$1"
source = "registry+https://github.com/rust-lang/crates.io-index"
EOF
}

echo "advisory-gate-test"

# ---- the vulnerable pin must FAIL, and must name the advisory ----
write_lock 0.3.19
out=$(cargo audit --file "$TMP/Cargo.lock" 2>&1) && rc=0 || rc=$?
named=0
case "$out" in *RUSTSEC-2025-0055*) named=1 ;; esac
if [ "$rc" -ne 0 ] && [ "$named" -eq 1 ]; then
    pass=$((pass + 1))
    echo "  ok    an advisory-bearing version fails, and RUSTSEC-2025-0055 is named"
else
    fail=$((fail + 1))
    echo "  FAIL  an advisory-bearing version fails (exit $rc, named=$named)"
    echo "$out" | sed 's/^/        /'
fi

# ---- the patched pin must PASS ----
# If this one failed too, the check above would prove nothing: a gate that
# rejects everything is not a gate.
write_lock 0.3.23
out=$(cargo audit --file "$TMP/Cargo.lock" 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
    pass=$((pass + 1))
    echo "  ok    the patched version passes, so the gate is not simply refusing"
else
    fail=$((fail + 1))
    echo "  FAIL  the patched version passes (exit $rc)"
    echo "$out" | sed 's/^/        /'
fi

# ---- and the real lockfile is clean ----
out=$(cargo audit --file Cargo.lock 2>&1) && rc=0 || rc=$?
if [ "$rc" -eq 0 ]; then
    pass=$((pass + 1)); echo "  ok    this workspace's own Cargo.lock is clean"
else
    fail=$((fail + 1)); echo "  FAIL  this workspace's own Cargo.lock is clean (exit $rc)"
    echo "$out" | sed 's/^/        /'
fi

echo
echo "advisory-gate-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
