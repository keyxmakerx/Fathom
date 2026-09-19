#!/bin/sh
# Gate npm's own test, in the style of scripts/tests/gate-zero-test.sh —
# "a gate nobody has watched fail is not known to work."
#
# This drives scripts/gate-npm.sh against fixture trees built in a temporary
# directory and asserts the VERDICT, not the wording: a direct package with
# no record must fail by name, a scoped package must resolve to the
# double-underscore filename, and a lockfile entry pinned to a registry other
# than registry.npmjs.org — or missing its integrity hash — must fail.
#
# The fixtures are package.json / package-lock.json files written here, never
# the real client's, so this test says nothing about whether client/ currently
# passes — that is gate-npm's own job, run separately.
#
# POSIX sh. Run from the workspace root: ./scripts/tests/gate-npm-test.sh

set -eu

GATE="$(pwd)/scripts/gate-npm.sh"
[ -x "$GATE" ] || { echo "gate-npm-test: $GATE is not executable"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

pass=0
fail=0

# runq <expect: ok|fail> <label> [needle]
last_out=""
runq() {
    expect="$1"
    label="$2"
    needle="${3:-}"
    last_out=$(GATE_NPM_PKG="$TMP/case/package.json" \
               GATE_NPM_LOCK="$TMP/case/package-lock.json" \
               GATE_NPM_DECISIONS="$TMP/case/deps/decisions/npm" \
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
    mkdir -p "$TMP/case/deps/decisions/npm"
}

# pkg_entry <name> <resolved> <integrity> -- appends one packages[] entry.
# Pass empty string for resolved or integrity to omit that field.
pkg_entry() {
    name="$1"; resolved="$2"; integrity="$3"
    {
        printf '    "node_modules/%s": {\n' "$name"
        printf '      "version": "1.0.0",\n'
        [ -n "$resolved" ] && printf '      "resolved": "%s",\n' "$resolved"
        [ -n "$integrity" ] && printf '      "integrity": "%s",\n' "$integrity"
        printf '      "license": "MIT"\n'
        printf '    },\n'
    } >> "$TMP/case/package-lock.json"
}

echo "gate-npm-test"

# ---------------------------------------------------------------- 1
# The floor: a package.json with recorded direct deps and a clean, fully
# pinned lockfile passes.
reset_case
cat > "$TMP/case/package.json" <<'EOF'
{
  "name": "fixture",
  "dependencies": {
    "react": "^19.0.0"
  },
  "devDependencies": {
    "vite": "^8.0.0"
  }
}
EOF
: > "$TMP/case/package-lock.json"
printf '{\n  "packages": {\n' > "$TMP/case/package-lock.json"
pkg_entry react "https://registry.npmjs.org/react/-/react-19.0.0.tgz" "sha512-aaaa"
pkg_entry vite "https://registry.npmjs.org/vite/-/vite-8.0.0.tgz" "sha512-bbbb"
printf '  }\n}\n' >> "$TMP/case/package-lock.json"
echo "# react" > "$TMP/case/deps/decisions/npm/react.md"
echo "# vite" > "$TMP/case/deps/decisions/npm/vite.md"
runq ok "recorded direct deps, clean lockfile passes"

# ---------------------------------------------------------------- 2
# THE FAILING CASE, WRITTEN FIRST. A direct dependency with no record fails,
# by name.
reset_case
cat > "$TMP/case/package.json" <<'EOF'
{
  "name": "fixture",
  "dependencies": {
    "left-pad-clone": "^1.0.0"
  },
  "devDependencies": {}
}
EOF
printf '{\n  "packages": {\n' > "$TMP/case/package-lock.json"
pkg_entry left-pad-clone "https://registry.npmjs.org/left-pad-clone/-/left-pad-clone-1.0.0.tgz" "sha512-cccc"
printf '  }\n}\n' >> "$TMP/case/package-lock.json"
runq fail "an unrecorded direct dependency fails, by name" "left-pad-clone"

# ---------------------------------------------------------------- 3
# A record admits it.
echo "# left-pad-clone" > "$TMP/case/deps/decisions/npm/left-pad-clone.md"
runq ok "a record admits the direct dependency"

# ---------------------------------------------------------------- 4
# SCOPED PACKAGES resolve to the @scope__name.md convention, and fail until
# that exact file exists.
reset_case
cat > "$TMP/case/package.json" <<'EOF'
{
  "name": "fixture",
  "dependencies": {
    "@xyflow/react": "^12.0.0"
  },
  "devDependencies": {}
}
EOF
printf '{\n  "packages": {\n' > "$TMP/case/package-lock.json"
pkg_entry "@xyflow/react" "https://registry.npmjs.org/@xyflow/react/-/react-12.0.0.tgz" "sha512-dddd"
printf '  }\n}\n' >> "$TMP/case/package-lock.json"
runq fail "a scoped package with no record fails, naming the __ filename" "@xyflow__react.md"
echo "# @xyflow/react" > "$TMP/case/deps/decisions/npm/@xyflow__react.md"
runq ok "the scoped package's record at the __ filename admits it"

# ---------------------------------------------------------------- 5
# A transitive package (not named in package.json) needs no record of its
# own -- this project's direct/closure split, mirrored from gate-zero.sh.
reset_case
cat > "$TMP/case/package.json" <<'EOF'
{
  "name": "fixture",
  "dependencies": {
    "react": "^19.0.0"
  },
  "devDependencies": {}
}
EOF
printf '{\n  "packages": {\n' > "$TMP/case/package-lock.json"
pkg_entry react "https://registry.npmjs.org/react/-/react-19.0.0.tgz" "sha512-aaaa"
pkg_entry loose-envify "https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz" "sha512-eeee"
printf '  }\n}\n' >> "$TMP/case/package-lock.json"
echo "# react" > "$TMP/case/deps/decisions/npm/react.md"
runq ok "a transitive package needs no record of its own"

# ---------------------------------------------------------------- 6
# THE LOCKFILE-PINNING HALF: an entry resolved from a registry other than
# registry.npmjs.org fails, by name -- a package.json-only supply-chain
# check would miss a lockfile quietly repointed at a different host.
reset_case
cat > "$TMP/case/package.json" <<'EOF'
{
  "name": "fixture",
  "dependencies": {
    "react": "^19.0.0"
  },
  "devDependencies": {}
}
EOF
printf '{\n  "packages": {\n' > "$TMP/case/package-lock.json"
pkg_entry react "https://attacker.example/react/-/react-19.0.0.tgz" "sha512-aaaa"
printf '  }\n}\n' >> "$TMP/case/package-lock.json"
echo "# react" > "$TMP/case/deps/decisions/npm/react.md"
runq fail "a lockfile entry from another registry fails, by name" "react"

# ---------------------------------------------------------------- 7
# ...and the same for a transitive entry: the pinning check covers the whole
# installed graph, not only what package.json names.
reset_case
cat > "$TMP/case/package.json" <<'EOF'
{
  "name": "fixture",
  "dependencies": {
    "react": "^19.0.0"
  },
  "devDependencies": {}
}
EOF
printf '{\n  "packages": {\n' > "$TMP/case/package-lock.json"
pkg_entry react "https://registry.npmjs.org/react/-/react-19.0.0.tgz" "sha512-aaaa"
pkg_entry loose-envify "https://attacker.example/loose-envify/-/loose-envify-1.4.0.tgz" "sha512-eeee"
printf '  }\n}\n' >> "$TMP/case/package-lock.json"
echo "# react" > "$TMP/case/deps/decisions/npm/react.md"
runq fail "a TRANSITIVE lockfile entry from another registry also fails" "loose-envify"

# ---------------------------------------------------------------- 8
# A lockfile entry with no integrity field fails, by name.
reset_case
cat > "$TMP/case/package.json" <<'EOF'
{
  "name": "fixture",
  "dependencies": {
    "react": "^19.0.0"
  },
  "devDependencies": {}
}
EOF
printf '{\n  "packages": {\n' > "$TMP/case/package-lock.json"
pkg_entry react "https://registry.npmjs.org/react/-/react-19.0.0.tgz" ""
printf '  }\n}\n' >> "$TMP/case/package-lock.json"
echo "# react" > "$TMP/case/deps/decisions/npm/react.md"
runq fail "a lockfile entry with no integrity hash fails, by name" "react"

# ---------------------------------------------------------------- 9
# Missing package-lock.json fails outright, distinct from a missing record.
reset_case
cat > "$TMP/case/package.json" <<'EOF'
{
  "name": "fixture",
  "dependencies": {},
  "devDependencies": {}
}
EOF
runq fail "a missing package-lock.json fails outright" "no $TMP/case/package-lock.json"

echo
echo "gate-npm-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
