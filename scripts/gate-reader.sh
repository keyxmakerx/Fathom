#!/bin/sh
# The dependency gates over the device reader's own lockfile (ADR-0082 §4.3; owner's answers
# 2026-11-02, r76-device-reading question 1 A and r87-reader-packages A, A and all three ticks).
#
# The reader is its own workspace (`helpers/reader/`) so that its SNMP and SSH packages never
# enter Fathom's lockfile. That is only safe if its lockfile passes the same gates Fathom's does,
# with its own records: this script runs each of them with the reader's lock, decisions and
# deny.toml. No advisory is ignored yet; the rsa one the owner accepted arrives with russh.
#
# POSIX sh. Run from the repository root, with cargo-deny and cargo-audit on PATH (CI fetches
# them pinned and checksummed, `scripts/ci/fetch-audit-tools.sh`).

set -eu

H=helpers/reader
LOCK=$H/Cargo.lock

echo "== gate-zero"
GATE_ZERO_LOCK=$LOCK GATE_ZERO_DECISIONS=$H/deps/decisions GATE_ZERO_MANIFESTS=$H/Cargo.toml \
    ./scripts/gate-zero.sh

echo "== look-alike names"
LOOKALIKE_LOCK=$LOCK LOOKALIKE_ALLOW=$H/deps/decisions/00-LOOKALIKES.md \
    ./scripts/lockfile-lookalikes.sh

echo "== lockfile consistent"
cargo fetch --locked --manifest-path $H/Cargo.toml
cargo metadata --locked --offline --format-version 1 --manifest-path $H/Cargo.toml > /dev/null

echo "== cargo-deny (finds helpers/reader/deny.toml beside the manifest)"
cargo-deny --manifest-path $H/Cargo.toml --locked check

echo "== cargo-audit"
cargo-audit audit --file $LOCK

echo "== cooldown"
COOLDOWN_LOCK=$LOCK COOLDOWN_EXCEPTIONS=$H/deps/decisions/00-COOLDOWN-EXCEPTIONS.md \
    ./scripts/crate-cooldown.sh

echo "== OSV"
OSV_GATE_LOCK=$LOCK OSV_GATE_ALLOW=$H/deps/osv-allow.txt ./scripts/osv-gate.sh
