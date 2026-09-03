#!/bin/sh
# The version cooldown — WO-11 §5 step 0, layer 5 of five.
#
# Fail if Cargo.lock pins a crate version published less than COOLDOWN_DAYS ago.
#
# WHY. On 2026-08-20 the Rust Security Response Team published "Supply chain
# attack on arrayref": poisoned versions of `arrayref`, `internment` and
# `append-only-vec` each pulled in `proc-macro1`, a typosquat of `proc-macro2`,
# whose build script downloaded and executed a payload during compilation. The
# poisoned releases were DELETED 86 to 107 minutes after publication rather than
# yanked with an advisory -- so there is nothing in any advisory database to
# match, and `cargo audit` returns clean for anyone who built in that window.
# Every advisory-keyed tool is defeated by construction by publish, wait, delete.
#
# A cooldown is not defeated by it. A release that lives ninety minutes is never
# old enough to be pinned.
#
# WHAT IT DOES NOT CATCH, stated plainly: a patient attacker. Someone who
# publishes a poisoned version and waits out the window walks straight through
# this. It is layer 5 of five for that reason, and the layer that would actually
# have caught August is layer 4 -- a human reading the lockfile diff and seeing
# a name one character from a name they know (scripts/lockfile-lookalikes.sh
# does the mechanical half).
#
# WHERE THE DATE COMES FROM, and why not the crates.io API. The publication time
# is read as the `Last-Modified` header of the `.crate` file on
# static.crates.io -- the same CDN cargo itself downloads from, with one HEAD
# request per package, no API key and no rate limit. crates.io's JSON API would
# also answer, and asks for about one request per second, which is two minutes
# of CI for a hundred-crate graph.
#
# The honest caveat: `Last-Modified` is the object's last write, not a field
# labelled "published". Crate files are immutable once published, so in practice
# they are the same instant -- and if one ever were rewritten, the date would
# move FORWARD and this gate would fail rather than pass. The imprecision leans
# safe.
#
# THE WINDOW IS A JUDGEMENT, NOT A CITATION. Seven days is two orders of
# magnitude longer than the 107-minute window above and short enough that a real
# security patch is not held back for long. Override it deliberately, in the
# pull request, with the reason written down -- never by editing the default.
#
# HOW IT FAILS. It fails CLOSED. If the CDN cannot be reached, this script exits
# non-zero and says so, because a gate that passes when it could not check is
# decoration. Set COOLDOWN_ALLOW_UNREACHABLE=1 only in an environment that
# genuinely has no egress, and know that you have turned the layer off.
#
# Usage:
#   ./scripts/crate-cooldown.sh                     check every external package
#   COOLDOWN_DAYS=14 ./scripts/crate-cooldown.sh
#   ./scripts/crate-cooldown.sh --age "<HTTP-date>" print the age in days, and
#                                                   exit non-zero if it is under
#                                                   the window (the arithmetic,
#                                                   testable with no network)

set -eu

LOCK="${COOLDOWN_LOCK:-Cargo.lock}"
DAYS="${COOLDOWN_DAYS:-7}"
CDN="${COOLDOWN_CDN:-https://static.crates.io/crates}"

# age_days <HTTP-date> -> prints the whole days since it, or nothing on failure
age_days() {
    then=$(date -u -d "$1" +%s 2>/dev/null) || return 1
    now=$(date -u +%s)
    [ -n "$then" ] || return 1
    echo $(((now - then) / 86400))
}

if [ "${1:-}" = "--age" ]; then
    [ -n "${2:-}" ] || { echo "cooldown: --age needs an HTTP date"; exit 2; }
    age=$(age_days "$2") || { echo "cooldown: unreadable date '$2'"; exit 2; }
    if [ "$age" -lt "$DAYS" ]; then
        echo "cooldown: $2 is $age day(s) old, under the $DAYS-day window"
        exit 1
    fi
    echo "cooldown: $2 is $age day(s) old, at or over the $DAYS-day window"
    exit 0
fi

[ -f "$LOCK" ] || { echo "cooldown: no $LOCK"; exit 1; }

# The same first-party test gate-zero uses: cargo writes a `source` line for
# everything it fetched and nothing for a path member.
pkgs=$(awk '
    /^\[\[package\]\]/ { name = ""; ver = ""; src = 0; next }
    /^name = / { name = $0; sub(/^name = "/, "", name); sub(/"$/, "", name); next }
    /^version = / { if (ver == "") { ver = $0; sub(/^version = "/, "", ver); sub(/"$/, "", ver) } next }
    /^source = / { src = 1; next }
    /^[ \t]*$/ { if (name != "" && src) print name " " ver; name = ""; ver = ""; src = 0; next }
    END { if (name != "" && src) print name " " ver }
' "$LOCK")

if [ -z "$pkgs" ]; then
    echo "cooldown: OK  no external packages in $LOCK"
    exit 0
fi

young=0
unreachable=0
checked=0
oldest=""

# A here-doc rather than a pipe: a pipe would run the loop in a subshell and
# the counters below would all read zero at the end.
while IFS=' ' read -r name ver; do
    [ -n "$name" ] || continue
    when=$(curl -fsSI --max-time 30 --retry 2 "$CDN/$name/$name-$ver.crate" </dev/null 2>/dev/null |
           awk 'tolower($1) == "last-modified:" { sub(/^[^:]*:[ \t]*/, ""); sub(/\r$/, ""); print; exit }')
    if [ -z "$when" ]; then
        echo "cooldown: UNREACHABLE  no publication date for $name $ver"
        unreachable=$((unreachable + 1))
        continue
    fi
    age=$(age_days "$when") || {
        echo "cooldown: UNREACHABLE  unreadable date for $name $ver: $when"
        unreachable=$((unreachable + 1))
        continue
    }
    checked=$((checked + 1))
    if [ -z "$oldest" ] || [ "$age" -lt "$oldest" ]; then oldest=$age; fi
    if [ "$age" -lt "$DAYS" ]; then
        echo "cooldown: FAIL  $name $ver was published $age day(s) ago ($when), under the $DAYS-day window"
        young=$((young + 1))
    fi
done <<PKGS
$pkgs
PKGS

if [ "$unreachable" -gt 0 ] && [ "${COOLDOWN_ALLOW_UNREACHABLE:-0}" != "1" ]; then
    echo
    echo "cooldown: FAIL  $unreachable package(s) could not be checked."
    echo "This gate fails closed on purpose: a gate that passes when it could not"
    echo "check is decoration. Set COOLDOWN_ALLOW_UNREACHABLE=1 only if you mean"
    echo "to turn this layer off, and know that you have."
    exit 1
fi

if [ "$young" -gt 0 ]; then
    echo
    echo "A crate version younger than $DAYS days is pinned. The August 2026"
    echo "crates.io attack's poisoned releases lived 86 to 107 minutes; a"
    echo "cooldown is the layer that catches that shape, because it does not"
    echo "depend on anyone having filed an advisory."
    echo
    echo "Wait for the window, or override it in the pull request with the reason"
    echo "written down: COOLDOWN_DAYS=<n> with an explanation beside it."
    exit 1
fi

echo "cooldown: OK  $checked external package(s) checked, youngest is $oldest day(s) old (window $DAYS)"
