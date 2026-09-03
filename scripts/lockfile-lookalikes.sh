#!/bin/sh
# Look-alike crate names in Cargo.lock — WO-11 §5 step 0, making layer 4
# partly mechanical.
#
# WO-11's central finding is that no scanner would have caught the August 2026
# attack: `proc-macro1`, a typosquat of the near-universal `proc-macro2`,
# arrived transitively, its build script ran at compile time, and the poisoned
# releases were deleted 86 to 107 minutes later rather than yanked, so no
# advisory database has anything to match. The order concluded that the control
# which WOULD have caught it is a human reading the lockfile diff and noticing a
# name one character away from a name they know.
#
# That last sentence describes an operation a computer can do. This script does
# it: it reports any two packages in the lockfile whose names are within one
# edit of each other -- one insertion, one deletion, or one substitution. That
# is exactly the proc-macro1/proc-macro2 shape, and also foo-bar/foo_bar.
#
# WHAT IT DOES NOT DO, and the reason it does not replace layer 4. It compares
# the lockfile against ITSELF, so it catches a typosquat sitting beside its
# target -- which is the shape that makes a typosquat work, because the squatter
# wants the real crate's traffic. It cannot catch a squat whose target is not
# also in the graph, a name that is merely plausible rather than close, or a
# legitimate crate whose maintainer account was taken over. A person still reads
# the diff.
#
# TWO FIRST-PARTY CRATES ARE NOT A PAIR. `fathom-id` and `fathom-ir` are one
# edit apart and neither can be a squat of the other: they are path members of
# this workspace, written here. The check reports a pair only when AT LEAST ONE
# side came from a registry -- which still covers the case that matters most to
# a project with distinctive crate names, an external crate published to look
# like a first-party one.
#
# It is a REPORT plus a gate: a pair fails the build unless it is listed in
# deps/decisions/00-LOOKALIKES.md as understood, with a reason. That file starts
# empty, which is the correct state for a workspace with no dependencies.
#
# POSIX sh and awk, no dependencies of its own. Run from the workspace root.

set -eu

LOCK="${LOOKALIKE_LOCK:-Cargo.lock}"
ALLOW="${LOOKALIKE_ALLOW:-deps/decisions/00-LOOKALIKES.md}"

[ -f "$LOCK" ] || { echo "lookalikes: no $LOCK"; exit 1; }

# `<name> <first-party|external>`, one per package.
names=$(awk '
    /^\[\[package\]\]/ { name = ""; src = 0; next }
    /^name = / { name = $0; sub(/^name = "/, "", name); sub(/"$/, "", name); next }
    /^source = / { src = 1; next }
    /^[ \t]*$/ { if (name != "") print name " " (src ? "external" : "first-party"); name = ""; src = 0; next }
    END { if (name != "") print name " " (src ? "external" : "first-party") }
' "$LOCK" | sort -u)

# Accepted pairs, one per line as `a b`, read from the table in $ALLOW.
accepted=""
if [ -f "$ALLOW" ]; then
    accepted=$(awk '
        /<!--[ \t]*lookalikes:accepted/ { inblk = 1; next }
        /<!--[ \t]*lookalikes:end/ { inblk = 0; next }
        inblk && /^[ \t]*\|/ {
            row = $0
            sub(/^[ \t]*\|/, "", row)
            n = split(row, cell, "|")
            if (n < 2) next
            a = cell[1]; b = cell[2]
            gsub(/[ \t`]/, "", a); gsub(/[ \t`]/, "", b)
            if (a == "" || a ~ /^[-:]+$/) next
            if (tolower(a) == "crate" || tolower(a) == "a") next
            if (a < b) print a " " b; else print b " " a
        }
    ' "$ALLOW")
fi

pairs=$(printf '%s\n' "$names" | awk '
    # Levenshtein, capped: we only care whether the distance is 0 or 1, so the
    # comparison bails as soon as two edits are needed.
    function within_one(a, b,   la, lb, i, diff) {
        la = length(a); lb = length(b)
        if (la == lb) {
            diff = 0
            for (i = 1; i <= la; i++)
                if (substr(a, i, 1) != substr(b, i, 1)) { diff++; if (diff > 1) return 0 }
            return (diff == 1)
        }
        if (la + 1 == lb) return one_insert(a, b)
        if (lb + 1 == la) return one_insert(b, a)
        return 0
    }
    # Is `short` exactly `lng` with one character removed?
    function one_insert(short, lng,   i, j, skipped) {
        i = 1; j = 1; skipped = 0
        while (i <= length(short) && j <= length(lng)) {
            if (substr(short, i, 1) == substr(lng, j, 1)) { i++; j++ }
            else { if (skipped) return 0; skipped = 1; j++ }
        }
        return 1
    }
    { n++; nm[n] = $1; kind[n] = $2 }
    END {
        for (i = 1; i <= n; i++)
            for (j = i + 1; j <= n; j++) {
                if (kind[i] == "first-party" && kind[j] == "first-party") continue
                if (!within_one(nm[i], nm[j])) continue
                if (nm[i] < nm[j]) print nm[i] " " nm[j]
                else print nm[j] " " nm[i]
            }
    }
')

unexplained=$(printf '%s\n' "$pairs" | while IFS= read -r p; do
    [ -n "$p" ] || continue
    printf '%s\n' "$accepted" | grep -qxF -- "$p" && continue
    printf '%s\n' "$p"
done)

if [ -n "$unexplained" ]; then
    printf '%s\n' "$unexplained" | while IFS= read -r p; do
        [ -n "$p" ] || continue
        a=${p%% *}; b=${p##* }
        echo "lookalikes: FAIL  \`$a\` and \`$b\` differ by one character and are both in $LOCK"
    done
    cat <<EOF

That is the shape of the August 2026 crates.io attack: \`proc-macro1\` published
beside the near-universal \`proc-macro2\`, arriving transitively, its build
script running at compile time. RUSTSEC-2026-0260, 2026-08-20.

LOOK AT BOTH NAMES AND DECIDE. If one is a squat, remove it and report it. If
the pair is legitimate -- and legitimate one-edit pairs do exist -- add a row to
$ALLOW inside its markers, naming both crates and why the pair is real.
EOF
    exit 1
fi

count=$(printf '%s\n' "$names" | grep -c . || true)
echo "lookalikes: OK  no unexplained one-edit name pairs among $count package(s) in $LOCK"
