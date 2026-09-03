#!/bin/sh
# Gate zero's own test — WO-11 §5 step 1, G2.
#
# "A gate nobody has watched fail is not known to work." This drives
# scripts/gate-zero.sh against fixture trees built in a temporary directory and
# asserts the VERDICT, not the wording: a crate with no record must fail by
# name, a crate carried by an approved closure document must pass, and a DIRECT
# dependency must fail even when the closure lists it.
#
# The fixtures are lockfiles and manifests written here, never the real ones, so
# this test says nothing about whether the workspace currently passes -- that is
# gate-zero's own job, run separately.
#
# POSIX sh. Run from the workspace root: ./scripts/tests/gate-zero-test.sh

set -eu

GATE="$(pwd)/scripts/gate-zero.sh"
[ -x "$GATE" ] || { echo "gate-zero-test: $GATE is not executable"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

# runq <expect: ok|fail> <label> [needle] -- runs the gate over the fixture in
# $TMP/case and asserts the exit status, plus that the output named <needle>.
last_out=""
runq() {
    expect="$1"
    label="$2"
    needle="${3:-}"
    last_out=$(GATE_ZERO_LOCK="$TMP/case/Cargo.lock" \
               GATE_ZERO_DECISIONS="$TMP/case/deps/decisions" \
               GATE_ZERO_MANIFESTS="$TMP/case/Cargo.toml" \
               "$GATE" 2>&1) && rc=0 || rc=$?
    ok=1
    if [ "$expect" = ok ] && [ "$rc" -ne 0 ]; then ok=0; fi
    if [ "$expect" = fail ] && [ "$rc" -eq 0 ]; then ok=0; fi
    if [ -n "$needle" ]; then
        case "$last_out" in *"$needle"*) : ;; *) ok=0 ;; esac
    fi
    if [ "$ok" -eq 1 ]; then
        pass=$((pass + 1)); echo "  ok    $label"
    else
        fail=$((fail + 1))
        echo "  FAIL  $label  (expected $expect, exit $rc, needle '${needle}')"
        echo "$last_out" | sed 's/^/        /'
    fi
}

reset_case() {
    rm -rf "$TMP/case"
    mkdir -p "$TMP/case/deps/decisions"
    cat > "$TMP/case/Cargo.toml" <<'EOF'
[package]
name = "fixture"

[dependencies]
EOF
}

# lock_pkg <name> [external]
lock_pkg() {
    printf '\n[[package]]\nname = "%s"\nversion = "1.0.0"\n' "$1" >> "$TMP/case/Cargo.lock"
    if [ "${2:-}" = external ]; then
        printf 'source = "registry+https://github.com/rust-lang/crates.io-index"\n' \
            >> "$TMP/case/Cargo.lock"
    fi
}

echo "gate-zero-test"

# ---------------------------------------------------------------- 1
# The floor: first-party only. This is today's workspace shape.
reset_case
printf 'version = 4\n' > "$TMP/case/Cargo.lock"
lock_pkg fathom-id
lock_pkg fathom-ir
runq ok "first-party only passes"

# ---------------------------------------------------------------- 2
# THE FAILING CASE, WRITTEN FIRST. An external crate with no record and no
# closure entry must fail, and must name the crate.
reset_case
printf 'version = 4\n' > "$TMP/case/Cargo.lock"
lock_pkg fathom-id
lock_pkg proc-macro1 external
runq fail "an unapproved external crate fails, by name" "proc-macro1"

# ---------------------------------------------------------------- 3
# An individual record admits it. This is the pre-existing behaviour and it
# must not have regressed.
echo "# a record" > "$TMP/case/deps/decisions/proc-macro1.md"
runq ok "an individual record admits it"

# ---------------------------------------------------------------- 4
# THE NEW BEHAVIOUR: a transitive crate carried by an approved closure
# document passes with no record of its own.
reset_case
printf 'version = 4\n' > "$TMP/case/Cargo.lock"
lock_pkg fathom-id
lock_pkg bytes external
cat > "$TMP/case/deps/decisions/00-CLOSURE-FIXTURE.md" <<'EOF'
# A fixture closure

<!-- gate-zero:closure approved-by="the owner" date="2026-09-03" -->

| crate | version | publisher |
|---|---|---|
| `bytes` | 1.0.0 | tokio-rs |

<!-- gate-zero:end -->
EOF
runq ok "a closure document admits a transitive crate"

# ---------------------------------------------------------------- 5
# A crate NOT in the closure still fails, so the closure is a list and not a
# blanket amnesty.
lock_pkg pin-project-lite external
runq fail "a crate absent from the closure still fails" "pin-project-lite"

# ---------------------------------------------------------------- 6
# THE CONSTRAINT THAT MAKES THE CLOSURE PATTERN HONEST: a DIRECT dependency
# needs its own record even when the closure lists it. Fathom chooses its
# direct dependencies; the closure only covers what those choices drag in.
reset_case
printf 'version = 4\n' > "$TMP/case/Cargo.lock"
lock_pkg fathom-id
lock_pkg bytes external
cat > "$TMP/case/Cargo.toml" <<'EOF'
[package]
name = "fixture"

[dependencies]
bytes = { version = "1", features = ["std"] }
fathom-id = { path = "../fathom-id" }
EOF
cat > "$TMP/case/deps/decisions/00-CLOSURE-FIXTURE.md" <<'EOF'
<!-- gate-zero:closure approved-by="the owner" date="2026-09-03" -->
| crate | version |
|---|---|
| `bytes` | 1.0.0 |
<!-- gate-zero:end -->
EOF
runq fail "a DIRECT dependency is not covered by the closure" "DIRECT dependency"

# ---------------------------------------------------------------- 7
# ...and its own record admits it.
echo "# bytes" > "$TMP/case/deps/decisions/bytes.md"
runq ok "a direct dependency with its own record passes"

# ---------------------------------------------------------------- 8
# A path dependency is not a direct EXTERNAL dependency, so the multi-line
# manifest form above must not have misread fathom-id as one.
reset_case
printf 'version = 4\n' > "$TMP/case/Cargo.lock"
lock_pkg fathom-id
cat > "$TMP/case/Cargo.toml" <<'EOF'
[package]
name = "fixture"

[dependencies]
fathom-id = { path = "../fathom-id" }

[dependencies.fathom-ir]
path = "../fathom-ir"
features = ["all"]
EOF
runq ok "path dependencies are not external"

# ---------------------------------------------------------------- 9
# AN UNAPPROVED CLOSURE ADMITS NOTHING. A session can write the document; only
# a filled-in approver makes it a gate entry.
reset_case
printf 'version = 4\n' > "$TMP/case/Cargo.lock"
lock_pkg bytes external
cat > "$TMP/case/deps/decisions/00-CLOSURE-FIXTURE.md" <<'EOF'
<!-- gate-zero:closure approved-by="TODO" date="2026-09-03" -->
| crate |
|---|
| `bytes` |
<!-- gate-zero:end -->
EOF
runq fail "an unapproved closure document admits nothing" "not approved"

# ---------------------------------------------------------------- 10
# A closure entry outside the markers is prose, not an approval. The markers
# are the machine-readable part; a crate named in the surrounding discussion
# must not be admitted by having been mentioned.
reset_case
printf 'version = 4\n' > "$TMP/case/Cargo.lock"
lock_pkg bytes external
cat > "$TMP/case/deps/decisions/00-CLOSURE-FIXTURE.md" <<'EOF'
We considered `bytes` and rejected it.

| crate | version |
|---|---|
| `bytes` | 1.0.0 |

<!-- gate-zero:closure approved-by="the owner" date="2026-09-03" -->
| crate | version |
|---|---|
| `pin-project-lite` | 0.2.0 |
<!-- gate-zero:end -->
EOF
runq fail "a crate named outside the markers is not admitted" "bytes"

echo
echo "gate-zero-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
