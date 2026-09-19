# npm dependency approval records

`scripts/gate-npm.sh` mirrors `scripts/gate-zero.sh` for `client/package.json` and
`client/package-lock.json`: it fails if any package `client/package.json` names directly — in
`dependencies` or `devDependencies` — has no `deps/decisions/npm/<name>.md`, and separately fails if
any package actually resolved in `client/package-lock.json` is not `"resolved"` from
`https://registry.npmjs.org/` or lacks an `"integrity"` field. ADR-0032 §5 says what a record must
contain and that the approval is **an owner act**; this directory adapts that shape to npm.

**Scoped packages.** `@scope/name` is not a valid filename — `/` is a path separator. Convention:
`deps/decisions/npm/@scope__name.md`, two underscores standing in for the slash. `gate-npm.sh`
applies this mechanically; it is written here so a reader does not have to infer it from the gate's
source.

| Package | Job | Approved | Audited |
|---|---|---|---|
| `react` | The client's UI component model | 2026-09-11 (stack decision) | 0 vulnerabilities, 2026-09-16 |
| `react-dom` | Renders React's tree to the browser DOM | 2026-09-11 (stack decision) | 0 vulnerabilities, 2026-09-16 |
| `vite` | Dev server and production bundler | 2026-09-11 (stack decision) | 0 vulnerabilities, 2026-09-16 |
| `typescript` | Type checking and project-reference compilation | 2026-09-11 (stack decision) | 0 vulnerabilities, 2026-09-16 |
| `vitest` | The client's test runner | 2026-09-11 (stack decision, in use) | 0 vulnerabilities, 2026-09-16 |
| `@vitejs/plugin-react` | JSX/TSX transform and Fast Refresh for Vite | 2026-09-11 (stack decision) | 0 vulnerabilities, 2026-09-16 |
| `@types/node` | Node API type declarations, for config files | 2026-09-11 (stack decision, consequence) | 0 vulnerabilities, 2026-09-16 |
| `@types/react` | Type declarations for `react` | 2026-09-11 (stack decision, consequence) | 0 vulnerabilities, 2026-09-16 |
| `@types/react-dom` | Type declarations for `react-dom` | 2026-09-11 (stack decision, consequence) | 0 vulnerabilities, 2026-09-16 |
| `@xyflow/react` | The diagram surface (React Flow) | 2026-09-11 (`CLAUDE.md` "The stack"; `docs/REBUILD-PLAN.md`) | 0 vulnerabilities, 2026-09-16 |

**The nine records above were written 2026-09-16, after their packages had already been in
`client/package.json` since the client was scaffolded, with no record and no gate reading
`package-lock.json` at all.** Same situation `deps/decisions/00-INDEX.md` names for four of the Rust
records: nothing was admitted that should not have been — `npm audit` found nothing against any of
them — but a reader could not previously see that anyone had reviewed the choice. `@xyflow/react` is
the first package recorded **before** it was added, per this task's brief.

**Transitive packages are not recorded individually.** A package only `client/package-lock.json`
names — never `client/package.json` — arrived because of a direct choice already recorded above, the
same direct/transitive split `deps/decisions/00-INDEX.md` describes for Cargo's closure documents.
Unlike the Rust side, there is no npm closure-document allowance yet (no `gate-npm:closure` marker
equivalent): the client's transitive graph is currently 92–112 packages, entirely build/test tooling
plus React Flow's own small dependency closure (see `@xyflow__react.md`'s table), and a closure
document is not owed until reviewing each transitive package individually by hand becomes the
bottleneck the Rust side's `00-CLOSURE.md` was written to relieve.

## What this gate does not do, and why

`scripts/gate-npm.sh` does not run a Rust-style five-layer regime — no npm-side `cargo-deny`
equivalent (licence/bans/duplicate-version policy), no `cargo-vet` equivalent (a named human having
read the code, as opposed to having read the registry metadata about it), and deliberately **no
version cooldown**: `docs/REBUILD-PLAN.md` "Version policy" (owner decision, 2026-09-11) explicitly
took the latest stable release of everything for web packages, overruling a recommendation to apply
the Rust workspace's seven-day cooldown here, "because nothing is in production, no data exists
anywhere, and versions pinned at the start of a rebuild are stale by the time it ships." A cooldown
gate for npm would contradict that recorded decision rather than extend it.

What the gate does enforce, and what every record above states with a source and a date: a human
wrote the record before the package was reviewed as admitted, the package ships or is tooling-only,
whether installing it runs a script, and what `npm audit` said. `docs/REBUILD-PLAN.md` also names
`npm ci --ignore-scripts` as the standing install-time control — the danger in a fresh package is
code that runs during installation, "which is how the August 2026 attack worked." `@xyflow/react`
was installed with `--ignore-scripts`, recorded in `@xyflow__react.md`.

## An open tension, named rather than resolved here

ADR-0032 §3 ("The four layers, adopted in full") lists eight caps carried over from `35` §5.1,
including **"C6 = 0 npm"**, and ADR-0019 (2026-07-28, "Vanilla TypeScript over a first-party render
layer") states outright: *"No npm package is installed or executed in any stage that can influence
an artifact byte."* Neither ADR carries a `Supersedes` line naming the other, and ADR-0032 itself
says explicitly it *"amends nothing in ADR-0019."* Both predate the 2026-09-11 stack decision by
five and seven weeks. `CLAUDE.md` "The stack" and `docs/REBUILD-PLAN.md` (status: **Draft**) are the
only records of that later decision found here, and neither is a ratified ADR superseding ADR-0019
or ADR-0032 §3's C6. This record does not resolve that gap — it names it, per rule 1: this is a fact
about the document set, not a security fact answered from memory, and it is not this task's brief to
write the missing ADR. The task that added these packages and this gate was itself instructed
against the stack decision as settled; a formal supersession record is unwritten work, not a
disagreement with the outcome.
