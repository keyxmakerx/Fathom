#!/bin/sh
# The OSV.dev advisory gate — closing the gap in docs/PHASE-2-STORAGE-DESIGN.md §12.5.
#
# WHY. `cargo deny advisories` and `cargo audit` both read RustSec, and only RustSec.
# Two real, filed advisories were absent from it when they mattered:
#
#   * CVE-2026-50185 / GHSA-3rjw-m598-pq24 — `cmov` on aarch64 can produce wrong results
#     when high register bits are set, fixed in 0.5.4. `cmov` sits on this workspace's
#     chain-MAC path (`digest` -> `ctutils::CtEq` -> `cmov`), so its own tag comparison
#     inherits whatever the crate does.
#   * GHSA-22w3-693w-x895 — `webauthn-rs`, named in §12.6 as an arrival still to come.
#
# Neither is a weakness in RustSec; GitHub reviews and files advisories RustSec never
# receives, and vice versa. "Filed advisories" has quietly meant "filed at RustSec".
# This script adds the other database as a gate input, so "nothing found" means nothing
# found in EITHER, not just the one `cargo audit` already reads.
#
# WHAT IT QUERIES. OSV.dev aggregates GitHub-reviewed advisories and RustSec for every
# ecosystem it indexes, `crates.io` among them, and its own batch endpoint is built for
# exactly this shape of check — one request against every (name, version) pair a
# lockfile pins. `POST /v1/querybatch` returns only `id` and `modified` per match, by
# design (it is meant to be cheap against a whole dependency graph); a second call to
# `GET /v1/vulns/{id}` per DISTINCT id found gets the summary this gate prints.
#
# THE BATCH LIMIT. OSV's own Go client bindings name it explicitly:
# `MaxQueriesPerQueryBatchRequest = 1000`. Read from the API's published documentation
# and corroborated by the maintained client bindings, 2026-09-12 — this project's own
# lockfile is nowhere near that, but the split is written so it is not the first project
# to reach it.
#
# WHAT THIS DOES NOT DO, stated rather than implied. It does not replace `cargo deny` or
# `cargo audit` — RustSec's own advisories carry Rust-specific detail (patched version
# ranges expressed the way `cargo audit` consumes them) that this gate does not
# reproduce, and RustSec advisories arrive at OSV.dev with a delay in the worst case, not
# instantly. It is an addition, run alongside the other four layers, not instead of any
# of them. It also does not catch an advisory that has not been filed ANYWHERE yet —
# nothing does.
#
# HOW IT FAILS. Closed. If OSV.dev cannot be reached, this exits non-zero and says so.
# A dependency-vulnerability gate that passes because it could not check is exactly the
# failure this gate exists to not repeat — §12.5 is the gap left by a database silently
# not being asked.
#
# THE ALLOW-LIST. `deps/osv-allow.txt`, one line per accepted finding:
#
#     <advisory-id> | <YYYY-MM-DD> | <reason>
#
# Every finding OSV.dev returns that is not listed there fails the build. The file
# starts empty. Unlike the cooldown's exceptions, an entry here does not expire on its
# own — an advisory does not stop applying with the passage of time — so a row is
# removed only when the dependency is fixed, replaced, or the finding is a documented
# false positive, and the reason says which.
#
# Usage:
#   ./scripts/osv-gate.sh                        check every external package in Cargo.lock
#   OSV_GATE_LOCK=path/to/Cargo.lock ./scripts/osv-gate.sh
#
# The OSV_GATE_* variables below exist for tests, which drive this script against a
# local HTTP fixture rather than the real API; leave them unset for the real gate.

set -eu

LOCK="${OSV_GATE_LOCK:-Cargo.lock}"
ALLOW="${OSV_GATE_ALLOW:-deps/osv-allow.txt}"
QUERYBATCH_URL="${OSV_GATE_QUERYBATCH_URL:-https://api.osv.dev/v1/querybatch}"
VULN_URL_TMPL="${OSV_GATE_VULN_URL_TMPL:-https://api.osv.dev/v1/vulns/%s}"
BATCH_LIMIT="${OSV_GATE_BATCH_LIMIT:-1000}"
TIMEOUT="${OSV_GATE_TIMEOUT:-30}"

[ -f "$LOCK" ] || { echo "osv-gate: no $LOCK"; exit 1; }

# The same first-party test every other gate in this tree uses: cargo writes a
# `source` line for everything it fetched and nothing for a path member.
pkgs=$(awk '
    /^\[\[package\]\]/ { name = ""; ver = ""; src = 0; next }
    /^name = / { name = $0; sub(/^name = "/, "", name); sub(/"$/, "", name); next }
    /^version = / { if (ver == "") { ver = $0; sub(/^version = "/, "", ver); sub(/"$/, "", ver) } next }
    /^source = / { src = 1; next }
    /^[ \t]*$/ { if (name != "" && src) print name " " ver; name = ""; ver = ""; src = 0; next }
    END { if (name != "" && src) print name " " ver }
' "$LOCK")

if [ -z "$pkgs" ]; then
    echo "osv-gate: OK  no external packages in $LOCK"
    exit 0
fi

printf '%s\n' "$pkgs" |
    ALLOW="$ALLOW" QUERYBATCH_URL="$QUERYBATCH_URL" VULN_URL_TMPL="$VULN_URL_TMPL" \
    BATCH_LIMIT="$BATCH_LIMIT" TIMEOUT="$TIMEOUT" python3 -c '
import json
import os
import sys
import urllib.error
import urllib.request

allow_path = os.environ["ALLOW"]
querybatch_url = os.environ["QUERYBATCH_URL"]
vuln_url_tmpl = os.environ["VULN_URL_TMPL"]
batch_limit = int(os.environ["BATCH_LIMIT"])
timeout = int(os.environ["TIMEOUT"])

pkgs = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    parts = line.split(None, 1)
    if len(parts) != 2:
        continue
    pkgs.append((parts[0], parts[1]))

if not pkgs:
    print("osv-gate: OK  no external packages to check")
    raise SystemExit(0)

# ---- the allow-list: "<id> | <date> | <reason>", one per line -------------
allowed = set()
if os.path.exists(allow_path):
    with open(allow_path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                continue
            fields = [f.strip() for f in stripped.split("|")]
            if len(fields) != 3 or not all(fields):
                print("osv-gate: FAIL  " + allow_path + ":" + str(lineno) +
                      " is malformed -- expected <id> | <date> | <reason>, got: " + stripped)
                raise SystemExit(1)
            allowed.add(fields[0])


def fetch_json(url, payload=None):
    data = None
    headers = {"Accept": "application/json"}
    method = "GET"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_json_retried(url, payload=None, attempts=2):
    last_exc = None
    for _ in range(attempts):
        try:
            return fetch_json(url, payload)
        except Exception as exc:  # noqa: BLE001 -- reported to the operator, not swallowed
            last_exc = exc
    raise last_exc


# ---- query OSV.dev in batches no larger than its documented limit ---------
results_by_index = {}
for start in range(0, len(pkgs), batch_limit):
    chunk = pkgs[start:start + batch_limit]
    queries = [
        {"version": ver, "package": {"name": name, "ecosystem": "crates.io"}}
        for name, ver in chunk
    ]
    try:
        resp = fetch_json_retried(querybatch_url, payload={"queries": queries})
    except Exception as exc:  # noqa: BLE001
        print("osv-gate: FAIL  could not reach " + querybatch_url + ": " + str(exc))
        print("")
        print("This gate fails CLOSED on a network problem, on purpose. A dependency")
        print("gate that reports clean when it could not check the network is exactly")
        print("the failure docs/PHASE-2-STORAGE-DESIGN.md 12.5 describes: an advisory")
        print("database quietly not being asked.")
        raise SystemExit(1)
    got = resp.get("results", [])
    if len(got) != len(chunk):
        print("osv-gate: FAIL  OSV.dev returned " + str(len(got)) +
              " result(s) for " + str(len(chunk)) + " quer(y/ies) -- response shape mismatch")
        raise SystemExit(1)
    for offset, result in enumerate(got):
        results_by_index[start + offset] = result

# ---- collect findings ------------------------------------------------------
findings = []
needed_ids = set()
for i, (name, ver) in enumerate(pkgs):
    for vuln in results_by_index.get(i, {}).get("vulns", []):
        vid = vuln.get("id")
        if not vid:
            continue
        findings.append((name, ver, vid))
        needed_ids.add(vid)

if not findings:
    print("osv-gate: OK  " + str(len(pkgs)) +
          " external package(s) checked against OSV.dev (crates.io ecosystem," +
          " RustSec and GitHub-reviewed advisories aggregated), nothing found")
    raise SystemExit(0)

# ---- a summary per distinct advisory, best-effort --------------------------
summaries = {}
for vid in sorted(needed_ids):
    url = vuln_url_tmpl % vid if "%s" in vuln_url_tmpl else vuln_url_tmpl.rstrip("/") + "/" + vid
    try:
        detail = fetch_json_retried(url)
        summary = detail.get("summary")
        if not summary:
            details = detail.get("details") or ""
            summary = details.splitlines()[0] if details else "(no summary published)"
        summaries[vid] = summary
    except Exception as exc:  # noqa: BLE001
        summaries[vid] = "(summary unavailable, detail lookup failed: " + str(exc) + ")"

# ---- report -----------------------------------------------------------------
unexplained = 0
for name, ver, vid in findings:
    summary = summaries.get(vid, "(summary unavailable)")
    if vid in allowed:
        print("osv-gate: allowed  " + name + " " + ver + "  " + vid + "  " + summary)
        continue
    unexplained += 1
    print("osv-gate: FAIL  " + name + " " + ver + "  " + vid + "  " + summary)

if unexplained:
    print("")
    print("osv-gate: " + str(unexplained) + " finding(s) from OSV.dev are not listed in " +
          allow_path + ".")
    print("cargo deny and cargo audit read RustSec only; this gate also carries")
    print("GitHub-reviewed advisories that never reach RustSec -- see")
    print("docs/PHASE-2-STORAGE-DESIGN.md 12.5.")
    print("")
    print("Fix the dependency, or add a row to " + allow_path +
          " naming the id, the date, and why it is accepted.")
    raise SystemExit(1)

print("osv-gate: OK  " + str(len(pkgs)) +
      " external package(s) checked against OSV.dev, every finding listed in " + allow_path)
'
