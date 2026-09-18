#!/usr/bin/env bash
# Build fathom-wasm for the browser and stage it where the client loads it
# from (ADR-0052 §1): "the module ships as a file, never a package."
#
# The artefact is NEVER checked in — client/public/engine/ is gitignored, the
# same way the retired page's own spliced-in module never was either. This
# script is the only thing that produces it; `client/src/engine/wasm.ts`
# fetches it at a fixed URL and `client/src/engine/engine.test.ts` fails
# loudly, not silently, when this has not been run first.
#
# A digest travels beside the module (fathom_wasm.wasm.sha256, `sha256sum`'s
# own output format) so a future artefact gate can assert the shipped bytes
# match the source build, mirroring `crates/fathom-artifact`'s own base64
# splice.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> cargo build --release --locked -p fathom-wasm --target wasm32-unknown-unknown"
cargo build --release --locked -p fathom-wasm --target wasm32-unknown-unknown

SRC="target/wasm32-unknown-unknown/release/fathom_wasm.wasm"
DEST_DIR="client/public/engine"
DEST="$DEST_DIR/fathom_wasm.wasm"

[ -f "$SRC" ] || { echo "build-wasm: $SRC was not produced by the build" >&2; exit 1; }

mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST"

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$DEST_DIR" && sha256sum fathom_wasm.wasm > fathom_wasm.wasm.sha256 )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "$DEST_DIR" && shasum -a 256 fathom_wasm.wasm > fathom_wasm.wasm.sha256 )
else
  echo "build-wasm: neither sha256sum nor shasum is on PATH; cannot write the digest" >&2
  exit 1
fi

bytes=$(wc -c < "$DEST" | tr -d '[:space:]')
echo "build-wasm: wrote $DEST ($bytes bytes) and $DEST.sha256"
