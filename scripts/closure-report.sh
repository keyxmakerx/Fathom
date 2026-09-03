#!/bin/sh
# Generate the closure table for deps/decisions/ from TOOLING OUTPUT.
#
# WO-11 §6 G4: "the closure document's contents were generated from tooling
# output" -- not typed from memory. This is that tool. Its output is pasted into
# a closure document between the gate-zero:closure markers, where
# scripts/gate-zero.sh reads the first column.
#
# WHAT EACH COLUMN IS MEASURED FROM, so a reader can check the measurement
# rather than inherit it:
#
#   crate, version   `cargo metadata` resolve nodes, filtered to registry
#                    sources (a path member has no source, same test gate-zero
#                    uses)
#   licence          the package's own `license` field
#   direct           whether a workspace member names it in a manifest
#   build.rs         whether the fetched source tree contains a build.rs, read
#                    from ~/.cargo/registry/src. THIS IS THE COLUMN THE AUGUST
#                    2026 ATTACK WAS ABOUT: `proc-macro1`'s build script
#                    downloaded and executed a payload, so merely compiling was
#                    enough.
#   proc-macro       whether any of its targets has kind proc-macro. A proc
#                    macro runs at compile time too, with the same privileges.
#   published        the Last-Modified of its .crate file on static.crates.io,
#                    the same figure scripts/crate-cooldown.sh gates on
#
# WHAT IT CANNOT MEASURE, stated rather than faked: the PUBLISHER. Neither
# `cargo metadata` nor the sparse index carries crates.io ownership; only the
# JSON API does. The `repository` field is printed instead and it is a proxy,
# not the answer -- a repository URL is written by the crate's author and proves
# nothing about who holds the publish token. Fill the publisher in by hand where
# it matters, and say where you looked.
#
# Usage: ./scripts/closure-report.sh [--no-dates]

set -eu

DATES=1
[ "${1:-}" = "--no-dates" ] && DATES=0

cargo metadata --format-version 1 --all-features 2>/dev/null |
    DATES="$DATES" python3 -c '
import json, os, subprocess, sys, glob

md = json.load(sys.stdin)
want_dates = os.environ.get("DATES") == "1"

pkgs = {p["id"]: p for p in md["packages"]}
members = set(md["workspace_members"])

# Direct = named in a manifest by a workspace member, and not a path dependency.
direct = set()
for mid in members:
    for d in pkgs[mid]["dependencies"]:
        if d.get("path") is None:
            direct.add(d["name"])

registry = {}
for pid, p in pkgs.items():
    if p.get("source") and p["source"].startswith("registry+"):
        registry[(p["name"], p["version"])] = p

def has_build_rs(name, version):
    for root in glob.glob(os.path.expanduser(
            f"~/.cargo/registry/src/*/{name}-{version}")):
        return "yes" if os.path.exists(os.path.join(root, "build.rs")) else "no"
    return "not fetched"

def published(name, version):
    if not want_dates:
        return ""
    url = f"https://static.crates.io/crates/{name}/{name}-{version}.crate"
    out = subprocess.run(["curl", "-fsSI", "--max-time", "30", url],
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        if line.lower().startswith("last-modified:"):
            return line.split(":", 1)[1].strip()
    return "unknown"

rows = []
for (name, version), p in sorted(registry.items()):
    is_pm = any("proc-macro" in t["kind"] for t in p.get("targets", []))
    rows.append({
        "crate": name,
        "version": version,
        "licence": p.get("license") or "(none declared)",
        "direct": "DIRECT" if name in direct else "transitive",
        "build.rs": has_build_rs(name, version),
        "proc-macro": "yes" if is_pm else "no",
        "repository": p.get("repository") or "",
        "published": published(name, version),
    })

cols = ["crate", "version", "licence", "direct", "build.rs", "proc-macro", "published", "repository"]
print("| " + " | ".join(cols) + " |")
print("|" + "|".join("---" for _ in cols) + "|")
for r in rows:
    cells = []
    for c in cols:
        v = r[c]
        cells.append(f"`{v}`" if c in ("crate", "version") and v else v)
    print("| " + " | ".join(cells) + " |")

n = len(rows)
d = sum(1 for r in rows if r["direct"] == "DIRECT")
b = sum(1 for r in rows if r["build.rs"] == "yes")
m = sum(1 for r in rows if r["proc-macro"] == "yes")
print()
print(f"<!-- measured: {n} external crates, {d} direct, {b} with a build.rs, {m} proc-macros -->")
print(f"**{n} external crates**, of which **{d} direct**. "
      f"**{b} carry a `build.rs`** and **{m} are proc-macros** — "
      f"{b + m} of {n} run code at compile time. "
      f"Against `35` §5.1: ≤ 30 direct ({d}), ≤ 160 in the closure ({n}).")
'
