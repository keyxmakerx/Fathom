#!/usr/bin/env bash
# Reproduce every measurement in docs/40-stack/47-byte-census.md §3–§5.
#
# Three builds of one crate under one profile, and a reader for the result:
#
#   SHIPPED  strip = "symbols"        — what the size gate measures, what the page loads
#   NAMED    strip = "none"           — the same profile keeping wasm-ld's `name` section
#   V0       + v0 symbol mangling     — the same again, with generic arguments encoded,
#                                       which is the only way to attribute a monomorphised
#                                       BTreeMap copy to the crate whose types caused it
#
# The census tool asserts the shipped and named builds agree function-for-function
# and prints the residual drift rather than assuming it away (47 §2.3).
#
# No external tool is downloaded and no crate is added: `twiggy` and `wasm-objdump`
# would both answer this and neither may be used here (78 §5.2, gate zero).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TOP="${TOP:-40}"
OUT="${OUT:-target/census}"
mkdir -p "$OUT"

echo "==> shipped build (strip = symbols)"
cargo build --release --locked -p fathom-wasm --target wasm32-unknown-unknown

echo "==> named build (strip = none, v0 mangling)"
CARGO_PROFILE_RELEASE_STRIP=none \
RUSTFLAGS="-C symbol-mangling-version=v0" \
cargo build --release --locked -p fathom-wasm \
  --target wasm32-unknown-unknown --target-dir target/census-named

echo "==> census tool"
rustc -O -o "$OUT/byte-census" scripts/byte-census.rs

"$OUT/byte-census" \
  target/wasm32-unknown-unknown/release/fathom_wasm.wasm \
  target/census-named/wasm32-unknown-unknown/release/fathom_wasm.wasm \
  --top "$TOP" | tee "$OUT/census.md"

echo
echo "written to $OUT/census.md"
