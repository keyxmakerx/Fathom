# Fathom — session pickup

One page for a fresh session. `README.md` has the full map; this is the state, the rules,
and the next actions.

## What this is

A security-first, client-side network tool: one typed graph, six views over it, teaching
and estate-of-record as co-equal goals. **It never connects to anything** — no device
access, no credentials, no telemetry, permanently (invariants 1–3,
`.context/conventions.md`; every future exception is priced in
`docs/30-security/38-the-egress-question.md` and none is approved).

## State (as of the schema-layer merge)

- **Specification: complete.** The foundational corpus (docs 00–74, ADRs 0001–0030) plus
  the post-redefinition set: `77` (owner requirements verbatim) → `76` (analysis + build
  order) → `19` (the IR extension) → `62` (the schema grammar).
- **Schema: instantiated and gated.** `schema/` is real (48 kinds / 89 edges / 61
  scalars); `crates/fathom-schema` parses and checks it; `cargo test` pins zero failures.
- **Design: decided and demonstrated.** `design/prototype/fathom-app.html` is the whole
  product as one interactive file — the fidelity bar for anything built.
- **Application code beyond the schema toolchain: none yet.**

## Rules that bind every session

1. Read `.context/conventions.md` before writing anything — the ten invariants and the
   vocabulary are binding, and the risk enum (three values, reserved colours) is never
   extended or reused.
2. `docs/90-decisions/` ADRs are binding once Accepted — but reopenable **on merit**:
   the owner has instructed that sunk cost never argues for keeping a decision (`75` §2).
   Real-time collaboration must never be foreclosed by new state (`75` §2.4).
3. A field that is not in `schema/` does not exist (ADR-0008). Extend the schema via
   `62`'s grammar; `cargo test` must stay green.
4. House style for documents: status line, contents table, numbered sections, Failure
   modes / Open decisions / Sources consulted / Disagreements. Never invent a number or a
   citation; mark the unproven with `<!-- VERIFY: ... -->`.
5. The capability register (`75`) records intent without deciding. Adding to it is cheap;
   deciding in it is a defect.

## Next actions

- **Engineering:** `fathom-schemagen` — codegen from `schema/` to Rust types +
  `schema.json` (`62` §17), which unlocks four more deferred gates in
  `fathom-schema-check`.
- **Owner-only, blocking:** the S0 fixture exports (`76` §7: Calix/Nokia/DIA configs, one
  service record end-to-end, the site list — which also settles the `Site` identity
  warning the checker surfaces on every run); the four forks in `19` §10; the named
  expert review of `corpus/` (invariant 10 — every entry still carries
  `reviewed_by: <named human>`).

## Verify before you trust

- `cargo test` — 36 tests: id vectors, the YAML-subset parser, every gate fires, the
  shipped tree conforms.
- `cargo run -p fathom-schema --bin fathom-schema-check` — the gate report, including
  the fourteen gates not yet checkable and why.
- Interactive artifacts open from disk with zero network; the transcript face in
  `fathom-app.html` reads its own CSP from the live page.
