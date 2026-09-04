#!/bin/sh
# Gate zero — ADR-0032 §6 item 4 row 1, extended by WO-11 §5 step 1.
#
# Fail if Cargo.lock holds a package that is neither first-party, nor carries an
# approval record in deps/decisions/, nor is named inside an APPROVED closure
# document there.
#
# WHY THIS IS THE CHEAPEST CONTROL THIS PROJECT WILL EVER HAVE. The workspace
# has zero external dependencies today, so the set this gate must recognise is
# empty and the gate is short. Every crate admitted later makes it harder to
# write and easier to argue with. ADR-0032 says it lands BEFORE the first
# dependency, and it did; WO-11 extends it BEFORE the first server dependency,
# for the same reason -- a gate written against an empty set cannot be shaped to
# fit what already arrived.
#
# THE CLOSURE PROVISION, AND WHY IT IS NOT A WEAKENING (WO-11 Disagreements 1).
# A working server is about 109 crates. ADR-0032 §5 makes each approval an owner
# act, and 109 owner approvals would be a WEAKER control than one, because the
# only way one person finishes 109 is by skimming, and a rubber stamp on 109
# files is indistinguishable from no review while looking like thorough review.
# deps/decisions/00-CLOSURE.md set the better shape on 2026-08-15: one approved
# document covering the twenty-two transitive crates, with individual records for
# the two crates the project actually CHOSE. This gate now knows that shape, and
# holds the line that makes it honest:
#
#   * a DIRECT dependency -- one this workspace names in a manifest -- always
#     needs its own record. Fathom chose it; Fathom reasons about it in writing.
#   * a TRANSITIVE crate may be carried by a closure document, which must name
#     it inside the machine-readable markers and must carry a real approver.
#
# What it does NOT do, stated so nobody mistakes it for more: it checks that a
# human wrote a record, not that the record is true, and not that the crate is
# safe. It is a tripwire against a crate arriving with nobody noticing, which
# ADR-0032 item 8 names as the realistic vector -- "a planning session writing a
# crate name into a work order, which the next session then types in faithfully
# and correctly, with no human in between". It is layer 1 of the five in WO-11
# §5 step 0; cargo-deny, cargo-audit, the reviewed lockfile diff and the version
# cooldown are the other four, and none of the five subsumes another.
#
# CLOSURE DOCUMENT FORMAT. Inside deps/decisions/, any file may carry:
#
#     <!-- gate-zero:closure approved-by="<who>" date="<YYYY-MM-DD>" -->
#     | crate | version | ... |
#     |---|---|---|
#     | `some-crate` | 1.2.3 | ... |
#     <!-- gate-zero:end -->
#
# The first column of every table row between the markers is a crate name.
# Anything outside the markers is prose and admits nothing. An approved-by of
# TODO, UNAPPROVED, or empty admits nothing either -- a session may WRITE the
# document; only a filled-in approver turns it into a gate entry.
#
# POSIX sh, no dependencies of its own. Run from the workspace root. The three
# GATE_ZERO_* variables exist for scripts/tests/gate-zero-test.sh, which drives
# this script over fixture trees; leave them unset for the real one.

set -eu

LOCK="${GATE_ZERO_LOCK:-Cargo.lock}"
DECISIONS="${GATE_ZERO_DECISIONS:-deps/decisions}"
MANIFESTS="${GATE_ZERO_MANIFESTS:-Cargo.toml crates/*/Cargo.toml}"

[ -f "$LOCK" ] || { echo "gate-zero: no $LOCK"; exit 1; }

# ---------------------------------------------------------------------------
# 1. Every EXTERNAL package in the lockfile.
#
# A first-party package is one whose source the lockfile omits. cargo writes a
# `source = "registry+..."` line for everything it fetched and nothing for a
# path member, so absence of `source` IS the first-party test -- no name list to
# keep in step with the workspace.
# ---------------------------------------------------------------------------
externals=$(awk '
    /^\[\[package\]\]/ { name = ""; src = 0; next }
    /^name = / { name = $0; sub(/^name = "/, "", name); sub(/"$/, "", name); next }
    /^source = / { src = 1; next }
    /^[ \t]*$/ { if (name != "" && src) print name; name = ""; src = 0; next }
    END { if (name != "" && src) print name }
' "$LOCK")

# ---------------------------------------------------------------------------
# 2. Every DIRECT dependency this workspace names, that is not a path member.
#
# Both manifest forms are read: the `[dependencies]` table, where a dependency
# is a key whose value may span lines, and the `[dependencies.<name>]` section.
# `workspace.`, `target.<cfg>.`, `dev-` and `build-` prefixes all count -- a
# build-dependency's build script runs on this machine, which is precisely the
# vector ADR-0032 item 2 is about.
#
# Known limit, stated rather than hidden: a target section whose cfg predicate
# itself contains a literal `.` inside quotes would confuse the segment split.
# No such section exists in this workspace, and the failure mode is a dependency
# read as transitive rather than direct -- the closure would still have to name
# it, so it cannot arrive unseen.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2086
direct=$(cat $MANIFESTS 2>/dev/null | awk '
    function flush() {
        if (pending != "" && pending_path == 0) print pending
        pending = ""; pending_path = 0
    }
    {
        line = $0
        sub(/^[ \t]+/, "", line)
        sub(/[ \t]*#.*$/, "", line)
        sub(/[ \t]+$/, "", line)
    }
    line ~ /^\[/ {
        flush(); buf = ""
        hdr = line
        sub(/^\[+/, "", hdr); sub(/\]+.*$/, "", hdr)
        k = split(hdr, seg, ".")
        last = seg[k]
        prev = (k > 1) ? seg[k - 1] : ""
        if (last ~ /^(dev-|build-)?dependencies$/) { mode = 1 }
        else if (prev ~ /^(dev-|build-)?dependencies$/) { mode = 2; pending = last }
        else { mode = 0 }
        next
    }
    mode == 2 && line ~ /^path[ \t]*=/ { pending_path = 1; next }
    mode == 1 {
        if (buf != "") { buf = buf " " line }
        else if (line ~ /^[A-Za-z0-9_-]+[ \t]*=/) {
            curname = line; sub(/[ \t]*=.*$/, "", curname); buf = line
        } else { next }
        # A dependency value is complete when its brackets balance.
        if (gsub(/\{/, "{", buf) == gsub(/\}/, "}", buf) &&
            gsub(/\[/, "[", buf) == gsub(/\]/, "]", buf)) {
            if (buf !~ /path[ \t]*=/) print curname
            buf = ""
        }
        next
    }
    END { flush() }
' | sort -u)

# ---------------------------------------------------------------------------
# 3. Every crate named inside an APPROVED closure document.
#
# An unapproved marker is not silently ignored: it is reported, because a
# closure document written and never approved is exactly the state a reviewer
# needs to see rather than one the gate should hide.
# ---------------------------------------------------------------------------
closure=""
unapproved=""
if [ -d "$DECISIONS" ]; then
    for doc in "$DECISIONS"/*.md; do
        [ -f "$doc" ] || continue
        out=$(awk -v doc="$doc" '
            /<!--[ \t]*gate-zero:closure/ {
                approver = $0
                if (match(approver, /approved-by="[^"]*"/)) {
                    approver = substr(approver, RSTART + 13, RLENGTH - 14)
                } else { approver = "" }
                if (approver == "" || approver == "TODO" || approver == "UNAPPROVED") {
                    print "UNAPPROVED " doc
                    inblk = 0
                } else { inblk = 1 }
                next
            }
            /<!--[ \t]*gate-zero:end/ { inblk = 0; next }
            inblk && /^[ \t]*\|/ {
                row = $0
                sub(/^[ \t]*\|/, "", row)
                sub(/\|.*$/, "", row)
                gsub(/[ \t`]/, "", row)
                if (row == "" || row ~ /^[-:]+$/) next
                if (tolower(row) == "crate" || tolower(row) == "name") next
                print "CRATE " row
            }
        ' "$doc")
        closure="$closure
$(printf '%s\n' "$out" | sed -n 's/^CRATE //p')"
        unapproved="$unapproved
$(printf '%s\n' "$out" | sed -n 's/^UNAPPROVED //p')"
    done
fi

in_list() {
    printf '%s\n' "$2" | grep -qx -- "$1"
}

# ---------------------------------------------------------------------------
# 4. The verdict.
# ---------------------------------------------------------------------------
missing=0
for name in $externals; do
    [ -n "$name" ] || continue
    if [ -f "$DECISIONS/$name.md" ]; then
        continue
    fi
    if in_list "$name" "$direct"; then
        echo "gate-zero: FAIL  $name is a DIRECT dependency of this workspace with no $DECISIONS/$name.md"
        echo "                 a closure document does not cover a crate the project chose"
        missing=$((missing + 1))
        continue
    fi
    if in_list "$name" "$closure"; then
        continue
    fi
    echo "gate-zero: FAIL  $name is in $LOCK with no $DECISIONS/$name.md and no closure entry"
    missing=$((missing + 1))
done

for doc in $unapproved; do
    [ -n "$doc" ] || continue
    echo "gate-zero: note  $doc carries a closure block that is not approved; it admits nothing"
done

if [ "$missing" -gt 0 ]; then
    cat <<'EOF'

Every third-party crate needs an approval record before it may appear in
Cargo.lock. ADR-0032 §5: the record names the job it does, why it is not
first-party, its publisher, its licence, whether it ships or is build/test-only,
its build.rs and proc-macro status, and its determinism criterion -- and the
approval is an OWNER act that may not be delegated.

A crate this workspace NAMES in a manifest always needs its own record. A crate
that arrives only because of one of those choices may instead be listed inside
the gate-zero:closure markers of an approved document in deps/decisions/ -- see
00-CLOSURE.md for the shape, and the header of scripts/gate-zero.sh for why.

Write deps/decisions/<crate>.md, add the crate to an approved closure document,
or remove the dependency.
EOF
    exit 1
fi

count=$(printf '%s\n' "$externals" | grep -c . || true)
echo "gate-zero: OK  $count external package(s) in $LOCK, every one recorded or in an approved closure"
