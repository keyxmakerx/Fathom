#!/bin/sh
# The dependency gates over the Passbolt helper's own lockfile (ADR-0071 part four, Passbolt;
# owner's answers 2026-10-26, r34-passbolt v2 B and r34-passbolt-crates A).
#
# The helper is its own workspace (`helpers/passbolt/`) so that rpgp's packages never enter
# Fathom's lockfile. That is only safe if its lockfile passes the same gates Fathom's does, with
# its own records: this script runs each of them with the helper's lock, decisions and deny.toml.
# The two advisory ignores are the two the owner was shown; anything else fails.
#
# POSIX sh. Run from the repository root, with cargo-deny and cargo-audit on PATH (CI fetches
# them pinned and checksummed, `scripts/ci/fetch-audit-tools.sh`).

set -eu

H=helpers/passbolt
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

echo "== cargo-deny (finds helpers/passbolt/deny.toml beside the manifest)"
cargo-deny --manifest-path $H/Cargo.toml --locked check

echo "== cargo-audit"
# The same two as deny.toml's [advisories] ignore, whose reasons are written there.
cargo-audit audit --file $LOCK \
    --ignore RUSTSEC-2023-0071 \
    --ignore RUSTSEC-2026-0387

echo "== cooldown"
COOLDOWN_LOCK=$LOCK COOLDOWN_EXCEPTIONS=$H/deps/decisions/00-COOLDOWN-EXCEPTIONS.md \
    ./scripts/crate-cooldown.sh

echo "== OSV"
OSV_GATE_LOCK=$LOCK OSV_GATE_ALLOW=$H/deps/osv-allow.txt ./scripts/osv-gate.sh
