#!/bin/sh
# Fetch cargo-deny and cargo-audit as PINNED, CHECKSUMMED release binaries.
#
# WHY NOT `cargo install`. Building either tool from source on the CI runner
# compiles roughly two hundred crates and RUNS THEIR BUILD SCRIPTS -- which is
# the exact hazard these two tools exist to gate. A supply-chain check whose own
# installation is an unaudited build of two hundred crates is not a control, it
# is a second attack surface wearing the badge of one. The release binaries are
# statically linked musl builds; nothing of theirs compiles here.
#
# WHAT THE CHECKSUM PROVES, AND WHAT IT DOES NOT. It proves that the bytes this
# build fetched are the bytes recorded here on 2026-09-03. It does NOT prove
# provenance: the digest below was computed from a download, and cargo-deny's
# own published .sha256 file (same origin) agrees with it. The value is
# LONGITUDINAL -- if the asset behind either URL ever changes, every build fails
# loudly instead of silently running a different binary. That is the property
# that matters, because the August 2026 attack was a change to what a name
# resolved to.
#
# Versions read from crates.io on 2026-09-03: cargo-deny 0.20.2 (latest),
# cargo-audit 0.22.2 (latest). Bump them deliberately, re-record the digest, and
# say so in the pull request -- the digest changing is the point.
#
# Usage: ./scripts/ci/fetch-audit-tools.sh [destination-dir]   (default: ./bin)

set -eu

DEST="${1:-bin}"
mkdir -p "$DEST"

DENY_VERSION=0.20.2
DENY_URL="https://github.com/EmbarkStudios/cargo-deny/releases/download/${DENY_VERSION}/cargo-deny-${DENY_VERSION}-x86_64-unknown-linux-musl.tar.gz"
DENY_SHA=9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f

AUDIT_VERSION=0.22.2
AUDIT_URL="https://github.com/rustsec/rustsec/releases/download/cargo-audit%2Fv${AUDIT_VERSION}/cargo-audit-x86_64-unknown-linux-musl-v${AUDIT_VERSION}.tgz"
AUDIT_SHA=7fb9497f8594b389e5fce5ef9b92db08432996895b2e0c5a0167a69ed445c428

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() {
    url="$1"; want="$2"; member="$3"; out="$4"
    echo "fetch-audit-tools: $out"
    curl -fsSL --retry 3 --max-time 300 -o "$TMP/archive" "$url"
    got=$(sha256sum "$TMP/archive" | cut -d' ' -f1)
    if [ "$got" != "$want" ]; then
        echo "fetch-audit-tools: FAIL  checksum mismatch for $url"
        echo "  expected $want"
        echo "  got      $got"
        echo
        echo "The bytes behind that URL are not the bytes recorded in this script."
        echo "Do not 'fix' this by updating the digest. Find out why it changed."
        exit 1
    fi
    tar xzf "$TMP/archive" -C "$TMP"
    src=$(find "$TMP" -type f -name "$member" -perm -u+x | head -1)
    [ -n "$src" ] || { echo "fetch-audit-tools: FAIL  $member not in the archive"; exit 1; }
    install -m 0755 "$src" "$DEST/$out"
    rm -rf "$TMP:?"/* 2>/dev/null || true
}

fetch "$DENY_URL"  "$DENY_SHA"  cargo-deny  cargo-deny
fetch "$AUDIT_URL" "$AUDIT_SHA" cargo-audit cargo-audit

echo "fetch-audit-tools: OK  cargo-deny $DENY_VERSION and cargo-audit $AUDIT_VERSION in $DEST"
