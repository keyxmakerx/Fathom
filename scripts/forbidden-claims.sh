#!/bin/sh
# The four sentences that may never be said — ADR-0040 §6, made mechanical.
#
# ADR-0040 §6: until customer-managed keys are live for a customer, these are
# FALSE about the hosted server and may not be written:
#
#     zero-knowledge · end-to-end encrypted · we cannot read your data ·
#     only you hold the key
#
# > "These are not marketing preferences; they are false under D1, and a false
# > security sentence is worse than no sentence because it teaches the reader to
# > discount the next one."
#
# ADR-0040 §8's own failure-mode table lists "marketing says zero-knowledge
# because it sounds better" and answers it with "§6, and it is a documented
# falsehood, not a preference" -- which is a POLICY, where the two rules either
# side of it in the same table (§5's union rule, D8's dictionary rule) each got a
# CI CHECK. This closes that gap. The owner asked for security to be in the
# repository rather than in somebody's memory: "idk how we want to manage this if
# we can have git have some sort of security checker" (2026-09-03).
#
# WHAT IT CHECKS, AND WHY THAT SCOPE AND NOT A WIDER ONE.
#
# It checks USER-FACING SURFACES ONLY -- the shipped page, the README, and
# anything under a marketing directory. It deliberately does NOT check the design
# corpus, and that is not laziness:
#
#   * ADR-0040 §4 keeps invariant 4 binding on "the client artifact and any
#     future ZERO-KNOWLEDGE DEPLOYMENT". The term names a real, preserved design
#     mode. `33` (sync protocol), `32` (cryptography) and `43` (deployment modes)
#     use it correctly, about that mode.
#   * The ban is on CLAIMING it to a reader about the hosted server. A design
#     document reasoning about a zero-knowledge deployment is not that claim.
#
# A check that fired on all forty-odd of those files would be turned off within a
# week, and a check that is off is worse than one that never existed -- it leaves
# people believing they are covered.
#
# HOW TO NAME THE FORBIDDEN SENTENCES WITHOUT TRIPPING THE CHECK. The first run
# of this script failed on the README paragraph that LISTS the four sentences in
# order to forbid them -- a rule that cannot state itself. The escape hatch is
# deliberately not a magic comment: **a PARAGRAPH that cites `ADR-0040` is
# exempt.** To write one of these phrases you must, in the same paragraph, name
# the record that forbids it. That makes every exemption self-documenting and
# impossible to add by accident, and it reads as a citation rather than as a
# suppression.
#
# Paragraph, not line, and that too was found by running it: the first cut
# exempted a LINE, and the README paragraph that cites ADR-0040 and then lists
# the four phrases had wrapped between the two. A rule whose escape hatch depends
# on where a text editor happened to wrap is a rule people learn to fight.
#
# The one sentence that IS true and always available (ADR-0040 §6) is not checked
# for here, because a check cannot tell whether it was said in the right place:
#
#     "Fathom never touches your devices, and it destroys every password before
#      it stores anything. There is no credential to steal."
#
# ...with D8's caveat: fully earned on Juniper, materially weaker on the
# platforms with no dictionary. Say it about the platforms it is true of.
#
# POSIX sh and grep. Run from the workspace root.

set -eu

ALLOW="${CLAIMS_ALLOW:-docs/90-decisions/adr-0040-the-server-holds-the-keys-and-says-so.md}"

# The surfaces a reader actually sees. Add to this list when a new one appears --
# a marketing site, a landing page, a product help file.
SURFACES="${CLAIMS_SURFACES:-README.md crates/fathom-artifact/html design/prototype}"

# One pattern per forbidden sentence. Deliberately tight: `end-to-end` alone is
# an ordinary phrase ("an end-to-end test", "one service record end-to-end") and
# only `end-to-end encrypted` is the claim.
PATTERNS='zero.?knowledge
end.to.end encrypt
end.to.end.encrypt
cannot read your data
can not read your data
only you hold the key
only you have the key
we have no access to your data'

found=$(mktemp)
trap 'rm -f "$found"' EXIT INT TERM

for surface in $SURFACES; do
    [ -e "$surface" ] || continue
    printf '%s\n' "$PATTERNS" | while IFS= read -r pat; do
        [ -n "$pat" ] || continue
        # -H so a single-file surface still prints its name; the allowlist and
        # the report both need it.
        grep -rHniE -- "$pat" "$surface" 2>/dev/null || true
    done
done | sort -u > "$found"

hits=0
while IFS= read -r line; do
    [ -n "$line" ] || continue
    file=${line%%:*}

    # (a) an allowlisted file -- the record itself.
    skip=0
    for a in $ALLOW; do
        [ "$file" = "$a" ] && skip=1
    done
    [ "$skip" = 1 ] && continue

    # (b) a PARAGRAPH that CITES the record that forbids the phrase. Naming
    # ADR-0040 in the same block of prose is the whole escape hatch.
    lineno=${line#*:}
    lineno=${lineno%%:*}
    if [ -f "$file" ] && awk -v want="$lineno" '
        # Walk paragraphs (blank-line separated). Remember whether the current
        # one cites the record, and whether the wanted line is inside it.
        /^[ \t]*$/ {
            if (inpara && cited && hit) { print "exempt"; exit }
            inpara = 0; cited = 0; hit = 0; next
        }
        {
            inpara = 1
            if (index($0, "ADR-0040") > 0) cited = 1
            if (NR == want) hit = 1
        }
        END { if (inpara && cited && hit) print "exempt" }
    ' "$file" | grep -q exempt; then
        continue
    fi

    echo "forbidden-claims: FAIL  $line"
    hits=$((hits + 1))
done < "$found"

if [ "${hits:-0}" -gt 0 ]; then
    cat <<'EOF'

ADR-0040 §6: these four sentences may not be written until customer-managed keys
are live for that customer --

    zero-knowledge · end-to-end encrypted · we cannot read your data ·
    only you hold the key

They are FALSE under ADR-0040 D1: the server holds a data key per tenant and per
design from the first stored byte. A false security sentence is worse than no
sentence, because it teaches the reader to discount the next one.

What is true today, and always available:

    Fathom never touches your devices, and it destroys every password before it
    stores anything. There is no credential to steal.

...fully earned on Juniper, and materially weaker on the platforms with no
dictionary (ADR-0040 D8). Say it about the platforms it is true of.

If customer-managed keys ARE live and this is now true, that is an amendment to
ADR-0040, not an edit to this script.
EOF
    exit 1
fi

echo "forbidden-claims: OK  no user-facing surface claims what ADR-0040 §6 forbids"
