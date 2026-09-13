#!/bin/sh
# Layer 6's positive control — WO-11 §6, extended by docs/PHASE-2-STORAGE-DESIGN.md §12.5.
#
# "A gate nobody has watched fail is not known to work." scripts/osv-gate.sh queries a
# live external API, so its own test cannot depend on that API being reachable — this
# session's own proxy blocks api.osv.dev, which is exactly the shape of environment this
# test must still work in. It stands up a local stand-in instead: a python3
# http.server on an ephemeral 127.0.0.1 port, serving OSV.dev's own documented
# querybatch and vulns/{id} response shapes, filled with the REAL GHSA-3rjw-m598-pq24
# record (fetched 2026-09-12 from github/advisory-database's github-reviewed feed,
# corroborated by osv.dev's own page for the same id), range-gated on `cmov`'s actual
# affected range (introduced 0.1.1, fixed 0.5.4) so the fixture is version-sensitive
# rather than a fixed canned answer.
#
# Four assertions, and the second one is the one that keeps the first one honest:
#
#   1. `cmov 0.3.1` (inside the affected range), empty allow-list -- FAILS, and the
#      output names GHSA-3rjw-m598-pq24.
#   2. `cmov 0.5.4` (the fixed version) -- PASSES. Without this half, #1 would prove
#      nothing: a gate that fails every input looks identical to a gate that works.
#   3. `cmov 0.3.1` with the id listed in the allow file -- PASSES.
#   4. An endpoint nothing is listening on -- FAILS, because a gate that reports clean
#      when it could not check the network is the exact failure §12.5 describes.
#
# No network needed anywhere in this file, so it runs wherever gate-zero-test.sh does.

set -eu

GATE="$(pwd)/scripts/osv-gate.sh"
[ -x "$GATE" ] || { echo "osv-gate-test: $GATE is not executable"; exit 1; }

TMP=$(mktemp -d)
SERVER_PID=""
cleanup() {
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

pass=0
fail=0

check() {
    # check <expect: ok|fail> <label> <needle-or-empty> -- runs the REST of the
    # arguments as a command and asserts its exit status, plus that its combined
    # output contains <needle> when one is given.
    expect="$1"; label="$2"; needle="$3"; shift 3
    out=$("$@" 2>&1) && rc=0 || rc=$?
    ok=1
    if [ "$expect" = ok ] && [ "$rc" -ne 0 ]; then ok=0; fi
    if [ "$expect" = fail ] && [ "$rc" -eq 0 ]; then ok=0; fi
    if [ -n "$needle" ]; then
        case "$out" in *"$needle"*) : ;; *) ok=0 ;; esac
    fi
    if [ "$ok" -eq 1 ]; then
        pass=$((pass + 1)); echo "  ok    $label"
    else
        fail=$((fail + 1))
        echo "  FAIL  $label  (expected $expect, exit $rc, needle '$needle')"
        echo "$out" | sed 's/^/        /'
    fi
}

echo "osv-gate-test"

# ---------------------------------------------------------------------------
# The fixture server: OSV.dev's documented shapes, filled with the real
# GHSA-3rjw-m598-pq24 record, range-gated on cmov's actual affected versions.
# ---------------------------------------------------------------------------
cat > "$TMP/fixture_server.py" <<'PY'
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

# https://github.com/google/osv.dev/blob/master/docs/api/post-v1-querybatch.md
# Batch results carry only id + modified; a separate GET fills in the rest.
VULN_ID = "GHSA-3rjw-m598-pq24"
QUERYBATCH_HIT = {"vulns": [{"id": VULN_ID, "modified": "2026-07-02T17:18:11Z"}]}

# The real record, fetched 2026-09-12 from
# raw.githubusercontent.com/github/advisory-database (github-reviewed feed),
# trimmed to what scripts/osv-gate.sh reads.
VULN_DETAIL = {
    "schema_version": "1.4.0",
    "id": VULN_ID,
    "modified": "2026-07-02T17:18:11Z",
    "published": "2026-07-02T17:18:11Z",
    "aliases": ["CVE-2026-50185"],
    "summary": "Cmov/CmovEq on aarch64 can produce wrong results if high-bits of registers are set ",
    "affected": [
        {
            "package": {"ecosystem": "crates.io", "name": "cmov"},
            "ranges": [
                {
                    "type": "ECOSYSTEM",
                    "events": [{"introduced": "0.1.1"}, {"fixed": "0.5.4"}],
                }
            ],
        }
    ],
}


def vulnerable(version):
    def key(v):
        return tuple(int(p) for p in v.split(".")[:3])
    try:
        return key("0.1.1") <= key(version) < key("0.5.4")
    except ValueError:
        return False


class Handler(BaseHTTPRequestHandler):
    def _send(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        if self.path == "/v1/querybatch":
            req = json.loads(body.decode("utf-8"))
            results = []
            for q in req.get("queries", []):
                name = q.get("package", {}).get("name")
                version = q.get("version", "")
                if name == "cmov" and vulnerable(version):
                    results.append(QUERYBATCH_HIT)
                else:
                    results.append({})
            self._send({"results": results})
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        if self.path == "/v1/vulns/" + VULN_ID:
            self._send(VULN_DETAIL)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 0), Handler)
    print(server.server_port, flush=True)
    server.serve_forever()
PY

python3 "$TMP/fixture_server.py" > "$TMP/server.port" 2>"$TMP/server.log" &
SERVER_PID=$!

port=""
i=0
while [ "$i" -lt 50 ]; do
    port=$(cat "$TMP/server.port" 2>/dev/null || true)
    [ -n "$port" ] && break
    i=$((i + 1))
    sleep 0.1
done
if [ -z "$port" ]; then
    echo "osv-gate-test: FAIL  fixture server never printed a port"
    echo "$TMP/server.log:"; sed 's/^/        /' "$TMP/server.log" 2>/dev/null || true
    exit 1
fi

BASE="http://127.0.0.1:$port"

write_lock() {
    cat > "$TMP/Cargo.lock" <<EOF
version = 4

[[package]]
name = "fathom-id"
version = "0.1.0"

[[package]]
name = "cmov"
version = "$1"
source = "registry+https://github.com/rust-lang/crates.io-index"
EOF
}

run_gate() {
    OSV_GATE_LOCK="$TMP/Cargo.lock" \
    OSV_GATE_ALLOW="$1" \
    OSV_GATE_QUERYBATCH_URL="$BASE/v1/querybatch" \
    OSV_GATE_VULN_URL_TMPL="$BASE/v1/vulns/%s" \
    OSV_GATE_TIMEOUT=5 \
    "$GATE"
}

: > "$TMP/empty-allow.txt"
cat > "$TMP/filled-allow.txt" <<'EOF'
GHSA-3rjw-m598-pq24 | 2026-09-12 | test fixture row
EOF

# ---- 1. vulnerable pin, empty allow-list -> FAIL, naming the advisory ----
write_lock 0.3.1
check fail "cmov 0.3.1 fails and names GHSA-3rjw-m598-pq24" "GHSA-3rjw-m598-pq24" \
    run_gate "$TMP/empty-allow.txt"

# ---- 2. patched pin -> PASS, so #1 is not a blanket refusal ----
write_lock 0.5.4
check ok "cmov 0.5.4 (patched) passes" "" \
    run_gate "$TMP/empty-allow.txt"

# ---- 3. vulnerable pin, allow-listed -> PASS ----
write_lock 0.3.1
check ok "cmov 0.3.1, allow-listed, passes" "allowed" \
    run_gate "$TMP/filled-allow.txt"

# ---- 4. nothing listening -> FAIL closed ----
check fail "an unreachable endpoint fails closed" "fails CLOSED" \
    env OSV_GATE_LOCK="$TMP/Cargo.lock" OSV_GATE_ALLOW="$TMP/empty-allow.txt" \
        OSV_GATE_QUERYBATCH_URL="http://127.0.0.1:1/v1/querybatch" \
        OSV_GATE_VULN_URL_TMPL="http://127.0.0.1:1/v1/vulns/%s" \
        OSV_GATE_TIMEOUT=3 "$GATE"

echo
echo "osv-gate-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
