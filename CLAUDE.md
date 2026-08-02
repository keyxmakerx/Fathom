# Fathom — session pickup

One page for a fresh session. `README.md` has the full map; this is the state, the rules,
and the next actions.

## What this is

A security-first, client-side network tool: one typed graph, six views over it, teaching
and estate-of-record as co-equal goals. **It never connects to anything** — no device
access, no credentials, no telemetry, permanently (invariants 1–3,
`.context/conventions.md`; every future exception is priced in
`docs/30-security/38-the-egress-question.md` and none is approved).

## Which kind of session is this?

`docs/70-ops/78-execution-protocol.md` defines three roles. **If you are here to build,
you are an execution session**: read `78` in full, open
`docs/70-ops/79-work-orders/00-INDEX.md`, take the topmost OPEN order whose dependencies
are DONE, and execute it exactly — escalating instead of deciding anything the order
leaves open. Planning sessions (authoring orders, ADRs, schema design) and the owner's
items are listed in `78` §7; when in doubt, `78` §7's test decides.

## State (as of the plan-layer merge)

- **Specification: complete.** The foundational corpus (docs 00–74, ADRs 0001–0030) plus
  the post-redefinition set: `77` (owner requirements verbatim) → `76` (analysis + build
  order) → `19` (the IR extension) → `62` (the schema grammar).
- **Schema: instantiated and gated.** `schema/` is real (48 kinds / 89 edges / 61
  scalars); `crates/fathom-schema` parses and checks it; `cargo test` pins zero failures.
- **Design: decided and demonstrated.** `design/prototype/fathom-app.html` is the whole
  product as one interactive file — the fidelity bar for anything built.
- **Code: the schema toolchain and the finder core are complete** (`fathom-id`,
  `fathom-schema`, `fathom-schemagen`, `fathom-ir` with checked-in generated types,
  `fathom-corpus`, `fathom-find`; 80 tests). The flagship query answers correctly,
  deterministically, safety-ordered, from real code.
- **The plan layer is live.** `78` (the execution protocol), `79-work-orders/` (eight
  orders, adversarially verified), and CI (`.github/workflows/ci.yml`) enforcing the
  verification floor on every PR.

## Rules that bind every session

1. Read `.context/conventions.md` before writing anything — the ten invariants and the
   vocabulary are binding, and the risk enum (three values, reserved colours) is never
   extended or reused.
2. `docs/90-decisions/` ADRs are binding once Accepted — but reopenable **on merit**:
   the owner has instructed that sunk cost never argues for keeping a decision (`75` §2).
   Real-time collaboration must never be foreclosed by new state (`75` §2.4). Reopening
   is owner/planning work, never an execution session's (`78` §5).
3. A field that is not in `schema/` does not exist (ADR-0008). Extend the schema via
   `62`'s grammar; `cargo test` must stay green.
4. House style for documents: status line, contents table, numbered sections, Failure
   modes / Open decisions / Sources consulted / Disagreements. Never invent a number or a
   citation; mark the unproven with `<!-- VERIFY: ... -->`.
5. The capability register (`75`) records intent without deciding. Adding to it is cheap;
   deciding in it is a defect.

## Next actions

- **Engineering:** the queue. `docs/70-ops/79-work-orders/00-INDEX.md` — WO-06 (finder
  completion, the shakedown order) leads; WO-01 (the `Scalar` trait) and WO-02 (the graph
  store) unblock everything downstream. Every order carries its own plan, gates, and
  stop-and-escalate list; `78` governs.
- **Planning-only, queued in the orders' §10 lists:** the crypto route for the workspace
  file (WO-05 §2 — never execution work), the dictionary reconciliation (WO-04 §10.2),
  the `73` §14 escalation triage as it fills.
- **Owner-only, blocking:** the S0 fixture exports (`76` §7: Calix/Nokia/DIA configs, one
  service record end-to-end, the site list — which also settles the `Site` identity
  warning the checker surfaces on every run); the four forks in `19` §10; the named
  expert review of `corpus/` (invariant 10 — every entry still carries
  `reviewed_by: <named human>`).

## Verify before you trust

The verification floor (`78` §6), in order — CI runs the first four on every PR:

- `cargo fmt --all --check` — no output.
- `cargo clippy --all-targets -- -D warnings` — clean.
- `cargo test --workspace --locked` — 80 tests as of the plan-layer merge; green is the
  gate, not the number.
- `cargo run -p fathom-schema --bin fathom-schema-check` — exit 0; the standing baseline
  is two `schema.identity.unexercised` warnings against `Site`, deliberate and
  owner-blocked.
- The executing work order's own acceptance gates, exactly as written.

Interactive artifacts open from disk with zero network; the transcript face in
`fathom-app.html` reads its own CSP from the live page.
