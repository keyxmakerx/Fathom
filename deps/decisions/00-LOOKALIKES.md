# Accepted one-edit crate-name pairs

`scripts/lockfile-lookalikes.sh` fails the build when two packages in `Cargo.lock` have names
one edit apart and at least one of them came from a registry. That is the shape of the August
2026 crates.io attack — `proc-macro1` published beside the near-universal `proc-macro2`,
arriving transitively, its build script running at compile time (RUSTSEC-2026-0260,
2026-08-20).

**This list is currently empty, and that is the correct state.** The workspace has zero
external dependencies, so no pair can exist yet. A row here is a decision that a pair is real
and understood — never a way to quieten a check.

Two first-party crates are never a pair: `fathom-id` and `fathom-ir` are one edit apart and
neither can be a squat of the other, because both are path members written in this repository.
The script skips that case in code rather than needing a row here.

<!-- lookalikes:accepted -->

| a | b | why the pair is real |
|---|---|---|

<!-- lookalikes:end -->

## How to add a row

Look at both names. If one is a squat, remove it and report it to the RustSec advisory
database and to crates.io. If the pair is genuine, name both crates above with the reason —
who publishes each, and what each does — so the next reader can check the judgement rather
than inherit it.
