#!/bin/sh
# Gate npm — ADR-0032 §5's record-before-admission process, extended to the
# browser client's package.json / package-lock.json.
#
# WHY. ADR-0032 §6 item 4 row 1 and scripts/gate-zero.sh gate Cargo.lock only.
# gate-zero.sh's own header still reads "the workspace has zero external
# dependencies today" — true of Cargo.lock, never true of npm. client/
# package.json has carried react, react-dom, vite, typescript, vitest,
# @vitejs/plugin-react and three @types/* packages since the client was
# scaffolded, with no record beside any of them and no gate reading
# package-lock.json at all. This closes that gap the same way gate-zero
# closed it for Cargo: every DIRECT package.json names needs a written
# approval record before it may appear there, and the lockfile entry for
# every package actually resolved must be pinned to the real registry with a
# content hash — the "gated at the build boundary" half of ADR-0032 §2's
# layer 1, mirrored for npm because Cargo's --locked has no npm equivalent
# that any CI step here enforces on its own.
#
# SCOPE, STATED RATHER THAN IMPLIED. This does not attempt ADR-0032's full
# five/six-layer Rust regime for npm — no cargo-deny equivalent, no
# cargo-vet equivalent, no version cooldown. docs/REBUILD-PLAN.md's "Version
# policy" (2026-09-11) explicitly took the latest stable release of
# everything for web packages, overruling a recommendation to apply the Rust
# cooldown here, so a cooldown gate would contradict a recorded owner
# decision rather than extend one. What this DOES enforce is the two things
# ADR-0032 §5 makes non-negotiable for any third-party code: a human wrote a
# record before the package arrived, and the lockfile pins exactly what was
# reviewed, from the registry it claims to be from.
#
# WHAT COUNTS AS DIRECT. Every key in package.json's "dependencies" and
# "devDependencies" objects. A transitive package — one only the lockfile
# names — needs no record of its own; ADR-0032 §5's approval is for what the
# project CHOSE, the same direct/closure reasoning gate-zero.sh uses for
# Cargo.lock. There is no closure-document allowance here: the client's
# transitive graph is small (currently under 100 packages, all dev-time
# tooling) and inventing the npm equivalent of 00-CLOSURE.md is not owed
# until it earns its keep.
#
# SCOPED PACKAGES. `@scope/name` cannot be a filename as written — `/` is a
# path separator. Convention, recorded here and in
# deps/decisions/npm/00-INDEX.md: `deps/decisions/npm/@scope__name.md`, two
# underscores standing in for the slash.
#
# THE LOCKFILE-PINNING HALF. Every package.json entry — not only direct
# ones — must resolve, in package-lock.json, from
# https://registry.npmjs.org/ and must carry an "integrity" field. This
# checks the whole installed graph rather than only direct entries: the
# build boundary is what actually gets installed, not just what package.json
# names, and a substituted registry or a missing hash is exactly as
# dangerous three levels down the tree as at the top. Checking everything
# costs nothing extra an awk pass over the same file was not already paying
# for.
#
# WHAT THIS DOES NOT DO. It does not run `npm audit`, verify licences, check
# for install scripts, or look at what a package's own dependencies pull in —
# those are read and recorded by hand in each deps/decisions/npm/<name>.md,
# same as ADR-0032 §5 makes them a written, dated, sourced claim rather than
# a mechanical one. It is a tripwire against a package arriving with nobody
# noticing, not a policy engine.
#
# POSIX sh and awk, no dependencies of its own — same discipline as
# scripts/gate-zero.sh, for the same reason: a dependency gate should not
# itself depend on anything ungated. Run from the workspace root. The
# GATE_NPM_* variables exist for scripts/tests/gate-npm-test.sh, which drives
# this script over fixture trees; leave them unset for the real one.

set -eu

PKG="${GATE_NPM_PKG:-client/package.json}"
LOCK="${GATE_NPM_LOCK:-client/package-lock.json}"
DECISIONS="${GATE_NPM_DECISIONS:-deps/decisions/npm}"

[ -f "$PKG" ] || { echo "gate-npm: no $PKG"; exit 1; }
[ -f "$LOCK" ] || { echo "gate-npm: no $LOCK"; exit 1; }

# ---------------------------------------------------------------------------
# 1. Every DIRECT dependency package.json names, in "dependencies" and
#    "devDependencies". Both are plain string-valued objects in the shape
#    `npm install` writes them — two-space indent at the top level, four-space
#    indent per entry — so a section is bounded by its own open/close brace
#    at a known indent, the same line-based reading gate-zero.sh's TOML
#    parser uses for Cargo.toml.
#
#    Known limit, stated rather than hidden: this assumes package.json is
#    written in npm's own default style. A hand-reformatted file with
#    different indentation would read as having no dependencies at all —
#    which fails safe: gate-npm would then find nothing to check and nothing
#    to approve, not silently approve something unread.
# ---------------------------------------------------------------------------
direct=$(awk '
    /^  "(dependencies|devDependencies)":[ \t]*\{[ \t]*$/ { inblk = 1; next }
    inblk && /^  \},?[ \t]*$/ { inblk = 0; next }
    inblk && /^    "/ {
        name = $0
        sub(/^    "/, "", name)
        sub(/".*$/, "", name)
        print name
    }
' "$PKG" | sort -u)

# ---------------------------------------------------------------------------
# 2. The scoped-package filename convention: `/` becomes `__`.
# ---------------------------------------------------------------------------
record_name() {
    printf '%s\n' "$1" | sed 's#/#__#g'
}

# ---------------------------------------------------------------------------
# 3. Records. Every direct dependency needs deps/decisions/npm/<record>.md.
# ---------------------------------------------------------------------------
missing=0
for name in $direct; do
    [ -n "$name" ] || continue
    rec=$(record_name "$name")
    if [ ! -f "$DECISIONS/$rec.md" ]; then
        echo "gate-npm: FAIL  $name is a DIRECT dependency of $PKG with no $DECISIONS/$rec.md"
        missing=$((missing + 1))
    fi
done

# ---------------------------------------------------------------------------
# 4. Lockfile pinning. Every package in package-lock.json's "packages" object
#    (every key beginning "node_modules/" — the root "" entry is this project
#    itself and carries no resolved/integrity by nature) must be resolved
#    from the real registry and carry an integrity hash. The package name is
#    everything after the LAST "node_modules/" in its key, which is correct
#    for both a flat entry and a deduplicated nested one
#    ("node_modules/a/node_modules/b" is package "b").
# ---------------------------------------------------------------------------
lock_report=$(awk '
    function flush() {
        if (pkg != "") print pkg "|" resolved "|" integrity
        pkg = ""; resolved = ""; integrity = ""
    }
    /"node_modules\// {
        flush()
        line = $0
        sub(/^[ \t]*"/, "", line)
        sub(/":[ \t]*\{[ \t]*$/, "", line)
        sub(/.*node_modules\//, "", line)
        pkg = line
        next
    }
    pkg != "" && /"resolved":/ {
        r = $0
        sub(/^[ \t]*"resolved":[ \t]*"/, "", r)
        sub(/",?[ \t]*$/, "", r)
        resolved = r
        next
    }
    pkg != "" && /"integrity":/ {
        i = $0
        sub(/^[ \t]*"integrity":[ \t]*"/, "", i)
        sub(/",?[ \t]*$/, "", i)
        integrity = i
        next
    }
    END { flush() }
' "$LOCK")

bad_registry=0
bad_integrity=0
oldifs=$IFS
IFS='
'
for entry in $lock_report; do
    IFS=$oldifs
    pkgname=$(printf '%s' "$entry" | cut -d'|' -f1)
    resolved=$(printf '%s' "$entry" | cut -d'|' -f2)
    integrity=$(printf '%s' "$entry" | cut -d'|' -f3)
    [ -n "$pkgname" ] || continue
    case "$resolved" in
        https://registry.npmjs.org/*) ;;
        *)
            echo "gate-npm: FAIL  $pkgname resolves from '$resolved' in $LOCK, not https://registry.npmjs.org/"
            bad_registry=$((bad_registry + 1))
            ;;
    esac
    if [ -z "$integrity" ]; then
        echo "gate-npm: FAIL  $pkgname has no \"integrity\" field in $LOCK"
        bad_integrity=$((bad_integrity + 1))
    fi
    IFS='
'
done
IFS=$oldifs

# ---------------------------------------------------------------------------
# 5. The verdict.
# ---------------------------------------------------------------------------
total_bad=$((missing + bad_registry + bad_integrity))

if [ "$total_bad" -gt 0 ]; then
    cat <<EOF

Every third-party npm package needs an approval record before it may appear in
$PKG, mirroring ADR-0032 §5 for Cargo: the record names the job it does, why
it is not first-party, its publisher, its licence, whether it ships or is
tooling-only, its install-script status, and what "npm audit" said and when.
The approval is an OWNER act, same as ADR-0032 §5 item 2, and may not be
delegated.

A scoped package "@scope/name" records as deps/decisions/npm/@scope__name.md.

Every package actually resolved in $LOCK must come from
https://registry.npmjs.org/ and carry an "integrity" hash — that is the
lockfile half of "gated at the build boundary", and it is not satisfied by an
approval record alone.

Write deps/decisions/npm/<name>.md, fix the lockfile entry, or remove the
dependency.
EOF
    exit 1
fi

pkg_count=$(printf '%s\n' "$lock_report" | grep -c . || true)
direct_count=$(printf '%s\n' "$direct" | grep -c . || true)
echo "gate-npm: OK  $direct_count direct dependenc$( [ "$direct_count" = 1 ] && echo y || echo ies ) recorded, $pkg_count package(s) in $LOCK pinned to the real registry with an integrity hash"
