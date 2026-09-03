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
# a name one character from a name they know.
#
# THE WINDOW IS A JUDGEMENT, NOT A CITATION. Seven days is two orders of
# magnitude longer than the 107-minute window above and short enough that a real
# security patch is not held back for long. Override it deliberately, in the
# pull request, with the reason written down -- never by editing the default.
#
# HOW IT FAILS. It fails CLOSED. If the registry cannot be reached, this script
# exits non-zero and says so, because a gate that passes when it could not check
# is decoration. Set COOLDOWN_ALLOW_UNREACHABLE=1 only in an environment that
# genuinely has no egress, and know that you have turned the layer off.
#
# Usage:
#   ./scripts/crate-cooldown.sh                 check every external package
#   COOLDOWN_DAYS=14 ./scripts/crate-cooldown.sh
#   ./scripts/crate-cooldown.sh --fixture F     check the arithmetic against a
#                                               saved API response, no network

set -eu

LOCK="${COOLDOWN_LOCK:-Cargo.lock}"
DAYS="${COOLDOWN_DAYS:-7}"
UA="fathom-crate-cooldown (https://github.com/keyxmakerx/fathom)"

if [ "${1:-}" = "--fixture" ]; then
    [ -n "${2:-}" ] || { echo "cooldown: --fixture needs a file"; exit 2; }
    exec python3 - "$2" "$DAYS" "${3:-}" <<'PYEOF'
import json, sys, datetime
doc = json.load(open(sys.argv[1]))
days = int(sys.argv[2])
want = sys.argv[3] or None
now = datetime.datetime.now(datetime.timezone.utc)
bad = 0
for v in doc.get("versions", []):
    if want and v["num"] != want:
        continue
    ts = datetime.datetime.fromisoformat(v["created_at"].replace("Z", "+00:00"))
    age = (now - ts).days
    verdict = "TOO YOUNG" if age < days else "ok"
    if age < days:
        bad += 1
    print(f"cooldown: {doc['crate']['name']} {v['num']}  published {ts.date()}  age {age}d  {verdict}")
sys.exit(1 if bad else 0)
PYEOF
fi

[ -f "$LOCK" ] || { echo "cooldown: no $LOCK"; exit 1; }

# The same first-party test gate-zero uses: cargo writes a `source` line for
# everything it fetched and nothing for a path member.
pkgs=$(awk '
    /^\[\[package\]\]/ { name = ""; ver = ""; src = 0; next }
    /^name = / { name = $0; sub(/^name = "/, "", name); sub(/"$/, "", name); next }
    /^version = / { ver = $0; sub(/^version = "/, "", ver); sub(/"$/, "", ver); next }
    /^source = / { src = 1; next }
    /^[ \t]*$/ { if (name != "" && src) print name "@" ver; name = ""; ver = ""; src = 0; next }
    END { if (name != "" && src) print name "@" ver }
' "$LOCK")

if [ -z "$pkgs" ]; then
    echo "cooldown: OK  no external packages in $LOCK"
    exit 0
fi

young=0
unreachable=0
for pv in $pkgs; do
    name=${pv%@*}
    ver=${pv##*@}
    body=$(curl -sS --max-time 30 -A "$UA" \
        "https://crates.io/api/v1/crates/$name/$ver" 2>/dev/null) || body=""
    if [ -z "$body" ]; then
        echo "cooldown: UNREACHABLE  could not read crates.io for $name $ver"
        unreachable=$((unreachable + 1))
        continue
    fi
    verdict=$(printf '%s' "$body" | python3 -c '
import json, sys, datetime
try:
    v = json.load(sys.stdin)["version"]
except Exception:
    print("UNREADABLE"); raise SystemExit(0)
ts = datetime.datetime.fromisoformat(v["created_at"].replace("Z", "+00:00"))
age = (datetime.datetime.now(datetime.timezone.utc) - ts).days
print(f"{age} {ts.date()}")
')
    case "$verdict" in
        UNREADABLE)
            echo "cooldown: UNREACHABLE  crates.io returned something unreadable for $name $ver"
            unreachable=$((unreachable + 1))
            continue
            ;;
    esac
    age=${verdict%% *}
    when=${verdict##* }
    if [ "$age" -lt "$DAYS" ]; then
        echo "cooldown: FAIL  $name $ver was published $when, $age day(s) ago, under the $DAYS-day window"
        young=$((young + 1))
    fi
    # crates.io asks for about one request per second.
    sleep 1
done

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

echo "cooldown: OK  every external package in $LOCK is at least $DAYS days old"
