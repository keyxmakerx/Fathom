# 78 — The execution protocol

> **Status:** Proposed

The protocol an **execution session** follows to do engineering work on Fathom. An execution
session runs a smaller model: good at following instructions, bad at judgment. This document is
built on that fact rather than around it — every decision a work order does not make is a decision
the execution session is **forbidden** to make. It stops and escalates instead. `73` §1's banner
reads *"A DECISION NOT WRITTEN DOWN IS A DECISION MADE BY WHOEVER TYPES FIRST"*; this protocol
exists so that under execution, a decision not written down is made by nobody until it is escalated.
Until the owner contests this document, execution sessions follow it as written; treating its
`Proposed` status as licence to improvise is itself a violation of §4.

## 0. Contents

| § | |
|---|---|
| 1 | The three roles |
| 2 | What every work order inherits |
| 3 | The session loop |
| 4 | The escalation rule |
| 5 | What an execution session never does |
| 6 | The verification floor |
| 7 | Execution-shaped versus judgment-shaped work |
| 8 | How the queue is maintained |
| 9 | Failure modes |
| 10 | Open decisions |
| 11 | Sources consulted |
| 12 | Disagreements |

---

## 1. The three roles

Sessions are named by role, never by product or model name.

| Role | Does | Does not |
|---|---|---|
| **Execution session** | Executes one work order exactly; runs gates; commits; escalates | Decide anything a work order leaves open |
| **Planning session** | Authors work orders, this protocol, ADR drafts; triages escalations | Execute the queue it authors in the same session |
| **Owner** | Answers escalations and open decisions; merges PRs; supplies the blocking items | — |

Decisions land where `73` §10 puts them: one file per answered decision in `docs/90-decisions/`,
named for the register ID. `73` §10 is stale on the ground — it still calls the directory empty,
and in practice it holds `adr-0001` through `adr-0030` and nothing D-named (Disagreements 4);
whether escalation answers land as D-files per `73` §10.1 or as ADRs is triaged under this
protocol's §10. Either way, an execution session never writes there. The owner-only blocking items
are listed in `CLAUDE.md` (the S0 fixture exports per `76` §7, the four forks in `19` §10, the
named expert review of `corpus/` under invariant 10) and no session waits on them silently — a
work order blocked on one says so in its status line.

## 2. What every work order inherits

Stated once, here. Work orders cite this section instead of re-deriving it.

| Constraint | Source | The line that binds |
|---|---|---|
| No egress, never touches a device, never accepts a credential — permanent | `.context/conventions.md` invariants 1–3 | *"No egress by default."* / *"The application never touches a network device."* / *"The application never accepts a credential."* |
| Determinism where observable: no clock or RNG in constructors; dates are stored values, rendered as stored, never evaluated at render time; deterministic maths | `.context/conventions.md` invariant 9; `crates/fathom-id/src/lib.rs` (*"There is deliberately no `new()` that reads a clock or an RNG"*); `crates/fathom-corpus/src/detln.rs` (the atanh-series `ln` over IEEE basic operations — the worked example) | *"Determinism where it is observable."* |
| A field not in `schema/` does not exist; schema changes go through `62`'s grammar and `cargo test` stays green | ADR-0008 §Decision; `CLAUDE.md` rule 3 | *"A field that exists in prose and not in `schema.yaml` does not exist."* |
| No external dependencies today, and none ever added by an execution session; adding one is `35` §5.3's reviewed process — judgment-shaped, never execution work | `Cargo.toml` (workspace comment); `35` §5.1 (the budget is C1 ≤ 30 direct, not zero), §5.3 (the process) | *"No external dependencies anywhere in the workspace yet. That is a position, not an accident"* |
| Toolchain pinned; no unsafe | `rust-toolchain.toml` (`channel = "1.94.1"`); `#![forbid(unsafe_code)]` in all six crates' `lib.rs` | — |
| The risk enum is exactly `ReadOnly` / `ChangesConfig` / `Disruptive`, colours reserved | `.context/conventions.md`; ADR-0011 | *"Do not add a fourth. Do not reuse these colours for anything else"* |
| Severity in any verification context is exactly the three-label scale BLOCKER / MAJOR / MINOR | `80` §0.1 | — |
| House style on every document | `CLAUDE.md` rule 4; `.context/conventions.md` § *Document conventions* | Never invent a number or a citation; mark the unproven `<!-- VERIFY: ... -->` |

## 3. The session loop

One work order per session. A finished session ends; the next session re-reads the queue fresh.

1. Read `CLAUDE.md`, then `.context/conventions.md`, then this protocol. In that order, every
   session, no exceptions for having "seen them before" — a session has no before.
2. Open `docs/70-ops/79-work-orders/00-INDEX.md`.
3. Take the **topmost OPEN work order whose listed dependencies are all DONE**. If no work order
   qualifies, the queue is empty or blocked: end, reporting that state. Do not invent work.
4. Confirm the checkout is not `main`. Work happens on the working branch the session finds
   checked out; if the session starts on `main`, create `wo-nn-<slug>` before the first edit.
   Nothing is ever committed to `main` directly (the repository's own history is PRs into `main`).
5. Read the work order in full, then every § its Binding sources table cites — those sections,
   not their whole documents. Verify every claim in its Prior state section against the code at
   the stated paths. A mismatch is either a §8 factual correction or a §4 escalation; decide
   which by §8's test, and nothing else.
6. Execute the plan steps in order. Each step is small enough to verify; verify it before the
   next. No step reordering, no step merging, no "while I'm here" edits.
7. Run the verification floor (§6) top to bottom, ending with the work order's acceptance gates,
   in §6's order and exactly as written. Expected output is stated in the work order; anything
   else is a red gate.
8. Edit the work order's status line to `DONE` and its row in `00-INDEX.md` to match.
9. Commit. Subject: one line, imperative, no trailing full stop, naming the work order's
   deliverable (the pattern of the existing history, e.g. *"Build the finder core: fathom-corpus
   and fathom-find over the real seed"*). Body: plain prose — what exists now, what was deferred
   and where that is recorded. The status-line and index edits ride this same commit or, at
   minimum, the same PR.
10. Push the branch. If the branch has no open PR, open one against `main`; the PR body lists
    every gate run and its result, verbatim. The session **never merges** — `74` §9.2: *"Nobody
    merges their own change."* Merging is the owner's act.
11. End.

## 4. The escalation rule

**Escalating is success. Deciding is the defect.** An execution session that ends early with a
well-formed escalation has done its job; one that ships a guess has failed even if the guess is
right, because a guess in the tree is a decision made by whoever typed first.

**Triggers.** Any of the following stops the session at the current step:

- A step needs a public name — API item, module, file, field, CLI flag, gate code — that the
  work order's Deliverables section does not list.
- A step needs a schema declaration, in any form, that the work order does not spell out verbatim.
- A step appears to need a dependency of any kind (§5 item 2).
- Following the work order would deviate from a § it cites, or two cited §§ contradict each other.
- An acceptance gate or floor check is red and the fix is not stated in the work order's own
  text. A red gate is evidence, never an obstacle.
- The work order is malformed under §8, or its Prior state diverges from the code in a way that
  changes what the work order decides.
- `00-INDEX.md` is absent, malformed under §8, or disagrees with the work-order files in a way
  §8's status rule does not resolve. Queue order is defined by the index; it is never inferred
  from filenames.

**Procedure.**

1. Stop. If the tree fails the floor at that moment, revert to the last floor-green state.
2. Write the question into the work order's **Open decisions** section: the step reached; what
   the work order says, quoted; what was found, quoted (path, output); the smallest decision that
   unblocks. Options may be listed only where they are mechanically enumerable. No lean, no
   recommendation — leaning is planning work.
3. Mirror it into `docs/70-ops/73-open-decisions.md`: append a row — date, work order, the
   question in one line, "detail in WO-nn § Open decisions" — to a table under
   `## 14. Escalations from execution sessions` at the end of the file, creating the section (and
   its contents-table row) on first use. Do not touch `73`'s register; D-numbers are planning work.
4. Set the work order's status line to `BLOCKED on <the decision, one line>`; mirror the index row.
5. Commit (subject: `WO-nn: escalate <one line>`), including only the edits above plus any
   completed steps that pass the floor. Push, open or update the PR, and end.

## 5. What an execution session never does

1. **Never extends or reuses the risk enum**, or its colours, for anything (§2).
2. **Never adds a dependency**: no crate, no npm package, no GitHub Action, no tool download, no
   vendored source. `[workspace.dependencies]` is empty on purpose. A work order that seems to
   need one is an escalation, always.
3. **Never touches `schema/`** except to add the exact declarations a work order spells out, in
   `62`'s grammar, with `cargo test` green after.
4. **Never reopens, amends, or knowingly contradicts an ADR.** Reopening on merit exists
   (`CLAUDE.md` rule 2) and belongs to the owner and planning sessions.
5. **Never weakens a test to make it pass**: no deleted or loosened assertion, no `#[ignore]`, no
   widened tolerance, no bulk-accepted goldens (`45` §20 names *"Golden files regenerated in
   bulk"* as a thing that bites), no re-running a flaky gate until green.
6. **Never hand-edits generated files** and never commits generated output differing from what
   the checked-in generator produces. `crates/fathom-ir/src/generated/{ir_types.rs,accessors.rs}`
   are `fathom-schemagen`'s output; the `schema.codegen.stale` and `schema.codegen.nondeterministic`
   gates are wired as cargo tests and stay green.
7. **Never touches** `.github/workflows/`, `rust-toolchain.toml`, `Cargo.toml`, `Cargo.lock`,
   `.context/`, `CLAUDE.md`, this protocol, or `docs/90-decisions/`. One exception, scoped to the
   manifests only: a work order may give the exact `Cargo.toml` edit verbatim (a new crate's
   manifest lines, a new workspace member) together with the `Cargo.lock` change that edit
   produces. `.context/`, `CLAUDE.md`, this protocol, `docs/90-decisions/`,
   `rust-toolchain.toml` and `.github/workflows/` admit no work-order exception — a work order
   instructing such an edit is malformed under §8: escalate it, do not execute it.
8. **Never invents a number, a citation, or a vendor behaviour** (`.context/conventions.md`
   § *Document conventions*); the unproven is marked `<!-- VERIFY: ... -->` or not written.
9. **Never merges its own PR** (§3 step 10).
10. **Never performs the work it just escalated.** Escalate-then-do is deciding with a receipt.

## 6. The verification floor

Every PR, before push, in this order, locally — CI is a backstop for every row but the last,
never the first run:

| Command | Expected |
|---|---|
| `./scripts/gate-zero.sh` | `gate-zero: OK`, exit 0 |
| `./scripts/lockfile-lookalikes.sh` | `lookalikes: OK`, exit 0 |
| `./scripts/tests/gate-zero-test.sh` | 10 passed, 0 failed |
| `./scripts/tests/lockfile-lookalikes-test.sh` | 10 passed, 0 failed |
| `./scripts/tests/crate-cooldown-test.sh` | 18 passed, 0 failed |
| `cargo deny check` | `advisories ok, bans ok, licenses ok, sources ok` |
| `cargo audit --file Cargo.lock` | exit 0, no vulnerability |
| `./scripts/tests/advisory-gate-test.sh` | 3 passed, 0 failed |
| `./scripts/crate-cooldown.sh` | `cooldown: OK`, exit 0 |
| `cargo fmt --all --check` | No output, exit 0 |
| `cargo clippy --all-targets -- -D warnings` | Builds clean, exit 0 |
| `cargo test --workspace --locked` | Every suite `ok`, zero failures |
| `cargo run -p fathom-schema --bin fathom-schema-check` | Exit 0, `0 failure(s)` |
| The work order's own acceptance gates | Exactly the output the work order states |

**The first nine rows are new on 2026-09-03 (WO-11 §5 steps 0–2) and they run BEFORE anything
compiles.** That ordering is the control and not a preference: a crate's `build.rs` executes on
the machine before any gate that runs after compilation can produce a result, so every check
that can be made without compiling is made first. `gate-zero`, the look-alike check and the three
shell tests need no toolchain at all; `cargo deny` and `cargo audit` read `cargo metadata` and the
lockfile and never invoke a build script.

The counts in the *Expected* column are the current ones, and **green is the gate, not the
number** — a test added to one of those scripts moves its count and that is not a failure. A
count going DOWN is.

`cargo deny` and `cargo audit` are pinned, checksummed release binaries fetched by
`scripts/ci/fetch-audit-tools.sh`, not `cargo install` builds: compiling either from source runs
roughly two hundred crates' build scripts, which is the hazard they exist to gate.

The schema checker's standing baseline is **no warnings at all**, since 2026-08-09. It was two
`schema.identity.unexercised` against `Site` for the whole of the tree's life before that; `Site`
and `Device` now declare identity tuples and the mismatch is gone rather than suppressed
(`70` §16.3). Any change to the warning set that the work order does not predict is a red gate —
which is now a sharper instrument than it was, because the baseline it is measured against is
empty and `crates/fathom-schema/tests/shipped_tree.rs` pins it there. CI (`.github/workflows/ci.yml`, the `gates` job)
enforces every row above except the last mechanically on every PR and every push to `main`, so
for those a session's model tier never decides whether the gates ran. The last row has no CI
backstop and cannot have one — acceptance gates vary per work order. It runs locally only, and
it is re-verified in PR review against the work order's Acceptance gates section; that is why §3
step 10 requires the PR body to list every gate run and its result, verbatim. Where the four
commands here and `ci.yml` diverge, the stricter side binds; a divergence is an escalation (§5
item 7 bars execution sessions from editing workflows, so the fix is always planning work). As
shipped, the commands above and `ci.yml`'s gate steps match verbatim.

**One divergence is recorded rather than hidden: §5 item 7 bars an EXECUTION session from
editing a workflow, and `ci.yml` was edited on 2026-09-03 by the session executing WO-11.** The
authority is the owner's own instruction that day — *"idk how we want to manage this if we can
have git have some sort of security checker"* — which is planning-layer direction, not an
execution session deciding for itself. The bar in §5 item 7 stands unchanged for every other
case; this is an exception with a named source, not a precedent. `45` §19 specifies the
full eventual gate set (T1–T32); the floor above is T1 plus the format, lint and schema gates,
which predate the T-numbering.

## 7. Execution-shaped versus judgment-shaped work

| Execution-shaped — take from the queue | Judgment-shaped — owner or planning session only |
|---|---|
| Implementing a work order's listed deliverables | Authoring or re-scoping work orders |
| Writing the tests a work order specifies | Authoring ADRs; reopening decisions |
| Mechanical refactors a work order orders, step by step | Schema design: new kinds, edges, scalars, identity tuples |
| Running gates; recording their output | Cryptography choices (`32`) |
| §8 factual corrections to the executing work order | Anything in `75`'s capability register — *"Adding to it is cheap; deciding in it is a defect"* (`CLAUDE.md` rule 5) |
| Status-line and index bookkeeping | The owner-blocking items (§1); licence and governance (`74`); naming anything a work order did not name |

The test, when a task resists classification: if two reasonable people could do it differently
and both be defensible, it is judgment-shaped. Escalate it.

## 8. How the queue is maintained

The queue is `docs/70-ops/79-work-orders/`: one file per work order, `WO-nn-<slug>.md`, plus
`00-INDEX.md` — a table of work order, file, status, dependencies, and one-line deliverable, in
queue order. The order refines `76` §7.2's build order (S-slices, ordered by `76` §7.1's principle:
*"retire the cheapest expensive risk first"*); re-cutting it is planning work.

**Authoring.** Work orders are authored by planning sessions, under house style, with these parts:
the status line (`OPEN` | `BLOCKED on <WO-nn / owner item>` | `DONE`), a contents table, then
1 Objective, 2 Binding sources, 3 Prior state, 4 Deliverables, 5 The plan, 6 Acceptance gates,
7 Stop-and-escalate triggers, 8 Non-goals, and the four house-style closers. A work order missing
any of these, or whose gates a session cannot run, is **malformed**: escalate it, do not execute
it. Work orders carry no duration estimates; a duration in a work order is a defect.

**Correction.** An execution session may correct a factual defect in the work order it is
executing — a wrong path, a wrong count, a wrong function name — when the code proves the
correction and the correction changes no decision the work order makes. It records old → new,
with the proving path, in the work order's **Disagreements** section, in the same PR. Anything
touching a decision — an API name, a gate, the deliverable set — is not a correction; it is §4.

**Status.** Each work order's own status line is the truth; the index mirrors it. On divergence,
the status line wins and the mismatch is a correction under this section. Status edits ride the
PR of the work that caused them, so two sessions taking the same work order collide as a merge
conflict rather than as silent double work.

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **The obedient improviser** — a session "fills a small gap" instead of escalating; the tell is a public name in the diff absent from the work order's Deliverables | §4's trigger list; PR review against the Deliverables table |
| 2 | **Escalate-then-do** — the record is written and the guess ships anyway | §5 item 10; the escalation commit ends the session |
| 3 | **Gate laundering** — a red gate turned green by weakening the test rather than fixing the code | §5 item 5; CI re-runs the floor's four commands; the acceptance gates are re-checked in PR review against the verbatim results §3 step 10 puts in the PR body; `45` §19's gates block merge, not push |
| 4 | **Queue collision** — two sessions execute one work order concurrently | §8: the status edit rides the work's own PR, so the second PR conflicts |
| 5 | **Floor drift** — §6 and `ci.yml` diverge and sessions follow the looser one | §6: stricter side binds; any divergence is itself an escalation (as shipped, the two match) |
| 6 | **A malformed work order executed anyway** — vague verbs read as permission | §8's malformed rule; "handle", "appropriately", "as needed" in a plan step are defects to escalate, not instructions to interpret |
| 7 | **Protocol staleness** — the repo outgrows this document and sessions follow stale text | Planning sessions own the refresh; `CLAUDE.md` points here |

## 10. Open decisions

- Whether an `IN PROGRESS` status is added once execution sessions run concurrently, or the
  merge-conflict control (§8) stays sufficient. Planning decides.
- When each not-yet-checkable `45` §19 gate (T2–T32) joins §6's floor, as the subsystem it gates
  comes into existence. Planning decides per work order.
- Whether `73` §14 escalations are triaged into D-numbered register entries or answered in place.
  Planning decides at triage; this protocol only defines the inbox.
- Who merges while the owner is the sole maintainer — `74` §9.2's escape hatch covers the
  Documentation class only. Owner decides.

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants 1–3, 9; the risk enum and its amendment; document conventions |
| `CLAUDE.md`; `README.md` | The five session rules; state; the owner-blocking items |
| `docs/70-ops/73-open-decisions.md` §§1–2, 10–11 | The banner; the register's shape; where answers live |
| `docs/70-ops/74-governance-and-licensing.md` §9 | Roles, review classes, *"Nobody merges their own change"* |
| `docs/30-security/35-supply-chain-and-builds.md` §§5.1–5.3 | The dependency caps (C1 ≤ 30 direct, ~26–28 estimated); the add-a-dependency process |
| `docs/40-stack/45-testing-strategy.md` §§0–1, 19–20 | The CI gate set T1–T32 (T1 is `cargo test --workspace --locked`); the things that bite |
| `docs/70-ops/76-scope-expansion-analysis.md` §§7–9 | The build order this queue refines; S0; the ordering principle |
| `docs/80-review/80-reconciliation.md` §0.1 | The three-label severity scale |
| `docs/90-decisions/adr-0008-…` §Decision | The schema-is-the-source rule, quoted |
| `Cargo.toml`, `rust-toolchain.toml`, `.github/workflows/ci.yml` | The dependency position; the pin; the mechanical floor |
| `crates/*/src/lib.rs`, `crates/fathom-id/src/lib.rs`, `crates/fathom-corpus/src/detln.rs`, `crates/fathom-ir/src/generated/` | `forbid(unsafe_code)` ×6; the determinism worked examples; the generated pair |
| `cargo test --workspace --locked`; `fathom-schema-check` (runs 2026-08-01, `--locked` re-run 2026-08-02) | 80 tests, zero failures, exit 0 with `--locked`; exit 0, `0 failure(s), 2 warning(s)` |

## 12. Disagreements

1. **Severity case.** `80` §0.1 renders the scale `Blocker` / `Major` / `Minor`; this protocol
   writes BLOCKER / MAJOR / MINOR. The label *set* is what binds; the case is presentation. If
   that is wrong, the correction is one line in §2's table.
2. **`73` was not built for an inbox.** DECISION — escalations are appended to `73` as
   `## 14. Escalations from execution sessions` (§4 step 3) rather than kept in a separate file,
   because a register of open decisions that is not consulted when decisions are opened stops
   being the register. §4 step 3 therefore appends a section to a ranked register that
   deliberately ends at §13. Planning sessions must triage §14 at the `73` §10.4 cadence or this
   becomes a second, worse register.
3. **Closed — `CLAUDE.md`'s test count.** An earlier draft recorded it as stale at 36. The same
   commit that shipped this protocol (`5733121`) corrected it to 80; the number 36 appears nowhere
   in `CLAUDE.md` today. The rule this item argued for stands and is unchanged: §6's floor states no
   counts, because green is the gate, not a number.
4. **`73` §10 describes a directory that no longer matches it.** §10 says *"`docs/90-decisions/`
   exists and is empty"* and files answers as D-named files (its example is
   `docs/90-decisions/D05-ir-shape.md`); the directory actually holds `README.md` plus
   `adr-0001` through `adr-0030` and nothing D-named. §1 cites `73` §10 for where answers live
   and carries this note; whether escalation answers land as D-files per `73` §10.1 or as ADRs
   is triaged under this protocol's §10. Refreshing `73` §10 is planning work.
5. **An earlier draft of this protocol cited `35` as backing "zero external dependencies".**
   `35` says otherwise: §5.1 caps direct runtime dependencies at C1 ≤ 30 and §5.2 estimates
   ~26–28 in practice, and §5.3 defines the reviewed process for adding one. The zero is
   `Cargo.toml`'s current state, and its own comment says *"yet"*. §2's row now states both
   halves; the execution-facing rule (§5 item 2: a dependency is an escalation, always) was and
   is unchanged.
