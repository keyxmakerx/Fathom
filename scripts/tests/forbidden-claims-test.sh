#!/bin/sh
# The forbidden-claims check's own test — ADR-0040 §6.
#
# A gate nobody has watched fail is not known to work. This drives the check
# over fixture surfaces and asserts BOTH directions, because for this particular
# gate the false-positive direction is the one that gets it switched off: the
# corpus legitimately discusses a zero-knowledge deployment mode (ADR-0040 §4
# keeps invariant 4 binding on "the client artifact and any future zero-knowledge
# deployment"), and a check that fired on all of that would last a week.

set -eu

CHECK="$(pwd)/scripts/forbidden-claims.sh"
[ -x "$CHECK" ] || { echo "forbidden-claims-test: $CHECK is not executable"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

runq() {
    expect="$1"; label="$2"; needle="${3:-}"
    out=$(CLAIMS_SURFACES="$TMP/surface.md" CLAIMS_ALLOW="" "$CHECK" 2>&1) && rc=0 || rc=$?
    ok=1
    [ "$expect" = ok ] && [ "$rc" -ne 0 ] && ok=0
    [ "$expect" = fail ] && [ "$rc" -eq 0 ] && ok=0
    if [ -n "$needle" ]; then
        case "$out" in *"$needle"*) : ;; *) ok=0 ;; esac
    fi
    if [ "$ok" -eq 1 ]; then pass=$((pass + 1)); echo "  ok    $label"
    else
        fail=$((fail + 1)); echo "  FAIL  $label (expected $expect, exit $rc)"
        echo "$out" | sed 's/^/        /' | head -5
    fi
}

echo "forbidden-claims-test"

# ---- each of the four, on its own ----
for claim in \
    "Fathom is zero knowledge." \
    "Your designs are end-to-end encrypted." \
    "We cannot read your data." \
    "Only you hold the key."
do
    printf '%s\n' "$claim" > "$TMP/surface.md"
    runq fail "refuses: $claim"
done

# ...including the hyphenated and spaced spellings, because a marketing page
# will not use the same punctuation as an ADR.
for claim in "zero-knowledge architecture" "we can not read your data" "only you have the key"; do
    printf '%s\n' "$claim" > "$TMP/surface.md"
    runq fail "refuses a spelling variant: $claim"
done

# ---- what must NOT fire ----
cat > "$TMP/surface.md" <<'EOF'
Fathom never touches your devices, and it destroys every password before it
stores anything. There is no credential to steal.

This is an end-to-end test of the paste path, run end to end.
EOF
runq ok "the TRUE sentence passes, and an ordinary 'end-to-end' is not the claim"

# ---- the escape hatch: cite the record ----
cat > "$TMP/surface.md" <<'EOF'
ADR-0040 §6 forbids four sentences until customer-managed keys are live:
zero-knowledge, end-to-end encrypted, we cannot read your data, only you hold
the key.
EOF
runq ok "a paragraph citing ADR-0040 may name the phrases"

# ...and the citation must be in the SAME paragraph, not merely in the file.
cat > "$TMP/surface.md" <<'EOF'
ADR-0040 is a record about key custody.

Fathom is zero-knowledge.
EOF
runq fail "a citation in a DIFFERENT paragraph does not exempt the claim" "zero-knowledge"

# ...and the paragraph hatch must survive a line wrap, which is what broke the
# first cut of this check against the README.
cat > "$TMP/surface.md" <<'EOF'
Until that is true for a real customer, ADR-0040 §6 forbids four sentences in
writing — zero-knowledge, end-to-end encrypted, we cannot read your data, only
you hold the key — because they are false.
EOF
runq ok "the hatch survives a wrapped paragraph"

echo
echo "forbidden-claims-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
