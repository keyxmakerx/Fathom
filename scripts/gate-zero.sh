#!/bin/sh
# Gate zero — ADR-0032 §6, item 4 row 1.
#
# Fail if Cargo.lock holds a package that is neither first-party nor carries an
# approval record in deps/decisions/.
#
# WHY THIS IS THE CHEAPEST CONTROL THIS PROJECT WILL EVER HAVE. The workspace
# has zero external dependencies today, so the set this gate must recognise is
# empty and the gate is a dozen lines. Every crate admitted later makes it
# harder to write and easier to argue with. ADR-0032 says it lands BEFORE the
# first dependency, and it does.
#
# What it does NOT do, stated so nobody mistakes it for more: it checks that a
# human wrote a record, not that the record is true, and not that the crate is
# safe. It is a tripwire against a crate arriving with nobody noticing, which
# ADR-0032 item 8 names as the realistic vector -- "a planning session writing a
# crate name into a work order, which the next session then types in faithfully
# and correctly, with no human in between".
#
# POSIX sh, no dependencies of its own. Run from the workspace root.

set -eu

LOCK="Cargo.lock"
DECISIONS="deps/decisions"

[ -f "$LOCK" ] || { echo "gate-zero: no $LOCK"; exit 1; }

# A first-party package is one whose source the lockfile omits. cargo writes a
# `source = "registry+..."` line for everything it fetched and nothing for a
# path member, so absence of `source` IS the first-party test -- no name list to
# keep in step with the workspace.
missing=0
name=""
src=""

# Read the lockfile as a stream of [[package]] blocks. A blank line ends one.
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        '[[package]]')
            name=""
            src=""
            ;;
        'name = '*)
            name=$(printf '%s' "$line" | sed 's/^name = "//; s/"$//')
            ;;
        'source = '*)
            src="external"
            ;;
        '')
            if [ -n "$name" ] && [ -n "$src" ]; then
                if [ ! -f "$DECISIONS/$name.md" ]; then
                    echo "gate-zero: FAIL  $name is in $LOCK with no $DECISIONS/$name.md"
                    missing=$((missing + 1))
                fi
            fi
            name=""
            src=""
            ;;
    esac
done < "$LOCK"

# The final block may not be followed by a blank line.
if [ -n "$name" ] && [ -n "$src" ] && [ ! -f "$DECISIONS/$name.md" ]; then
    echo "gate-zero: FAIL  $name is in $LOCK with no $DECISIONS/$name.md"
    missing=$((missing + 1))
fi

if [ "$missing" -gt 0 ]; then
    cat <<'EOF'

Every third-party crate needs an approval record before it may appear in
Cargo.lock. ADR-0032 §5: the record names the job it does, why it is not
first-party, its publisher, its licence, whether it ships or is build/test-only,
its build.rs and proc-macro status, and its determinism criterion -- and the
approval is an OWNER act that may not be delegated.

Write deps/decisions/<crate>.md, or remove the dependency.
EOF
    exit 1
fi

echo "gate-zero: OK  every external package in $LOCK has an approval record"
