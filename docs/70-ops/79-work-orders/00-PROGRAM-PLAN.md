# The program plan — from today to "most features working without bugs"

> **Status:** Proposed — a planning artifact under `78` §7. It decides sequencing and nothing else.
> It does not re-specify any mechanism, does not reopen any Accepted ADR, and does not answer any
> question this document lists as owner-only.

The owner's bar is stated in their own words at `70` §9: *"I need most features present otherwise
this project won't get off the ground. It needs to be useable and have most features working
without bugs."* Combined with `70` §4 — *"All features must be included in V1, how you wish to plan
that out is your discretion"* — the shape of this document is fixed by the owner and not by
planning: **planning chooses the order, not the cut** (`70` §9). This is that order.

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | How to read this, and what a stage is | *read this first* |
| 2 | What binds this plan | *inherited, not restated* |
| 3 | The spine — eleven stages on one page | *the whole document in one table* |
| 4 | Stage A — the queue becomes runnable | |
| 5 | Stage B — the substrate | |
| 6 | Stage C — the estate becomes visible | *first user-visible thing* |
| 7 | Stage D — text in, text out | *the round trip* |
| 8 | Stage E — the graph has opinions | |
| 9 | Stage F — teaching, change, and the last two views | *six views complete* |
| 10 | Stage G — the picture | |
| 11 | Stage H — the sealed workspace and the hosted shapes | *rank-1 priority* |
| 12 | Stage I — breadth: six platforms and the content behind them | *the long pole* |
| 13 | Stage J — dynamic ability | *the owner's §6* |
| 14 | Stage K — the bar that lets it ship | |
| 15 | What is deliberately not in the spine | |
| 16 | Every owner decision this plan waits on | *the batch to answer* |
| 17 | Branch points — what changes if an answer goes the other way | |
| 18 | The new work orders this plan calls for | |
| 19 | How this plan is maintained | |
| 20 | Standing authorisation — what proceeds without asking | *the owner asked for this* |
| | Failure modes | |
| | Open decisions | |
| | Sources consulted | |
| | Disagreements | |

---

## 1. How to read this, and what a stage is

*margin tab: read this first*

> **A STAGE IS A DEPENDENCY FRONTIER, NOT A RELEASE**

### 1.1 Why stages and not phases

ADR-0031 (Proposed) retires the phase scheme *as a scoping device*: phases decided **what ships**,
and the owner has decided that everything ships. `71`'s eight phases survive as history and as an
effort model under the banner `71` now carries, and `71` §13.1's thirteen permanent product
boundaries are untouched by any of this (ADR-0031 §Decision item 4).

A **stage** here carries none of that weight. It is a set of work that shares a dependency
frontier: everything in a stage can be built once the stage before it exists, and nothing in a
later stage can be built until it does. Stages are **not** releases — `70` §9 forbids an
intermediate release — and they are **not** exit gates on scope. They are the answer to *"what can
be worked on now, and what is the checkable statement that it is finished."*

`70` §9's own recommendation is the reading to hold: *"internal checkpoints, not releases."*

### 1.2 What each stage states

| Field | Means |
|---|---|
| **What exists at the end** | One line. Something true after the stage that was false before it |
| **Work orders consumed** | Existing rows in `docs/70-ops/79-work-orders/00-INDEX.md`, by number |
| **New work orders** | Named and one-lined. This document does not write them; authoring is a separate planning act (`78` §8) |
| **Owner-blocked** | The specific question, cited to `70` §11 / `70` §13, `76` §8, `19` §10 or `88` §8 |
| **Exit condition** | Checkable. A command, a gate, or a named artifact on disk |

### 1.3 What this document deliberately does not contain

**No durations.** `78` §8 is explicit: *"Work orders carry no duration estimates; a duration in a
work order is a defect."* This plan extends the same rule to itself, because a duration here would
be copied into the orders it schedules. The project's own figures already exist and are not
restated per stage: `71` §2 puts the full product at **106–158 solo weeks**, and `83` §12.5 refuted
that as optimistic at **170–240** (both quoted at `70` §9). `70` §9 also states why they cannot
improve: *"No intermediate release means no measurement until most of the product exists."* `72`
names the corpus authoring rate as the variable that moves them most.

**No re-specification.** Where a stage names a mechanism, the mechanism is specified elsewhere and
cited to the section that owns it.

**No decisions the corpus reserves.** Everything in §16 stays in §16.

### 1.4 The ordering principle, unchanged

`76` §7.1's principle governs and this plan does not replace it: **retire the cheapest expensive
risk first** — order by risk severity ÷ cost to test, which is `71` §1.2's O2. Two of the owner's
standing priorities (`70` §2) modify it at the margins rather than replacing it:

- **Rank 1, security.** Where a stage could be moved earlier only by shipping a capability without
  its brake, it is not moved (`71` §1.2's O4 — *"Never ship a capability without its brake"*).
  ADR-0032 §6's *"gate zero comes first"* is the same rule applied to the dependency question, and
  it is why Stage A precedes everything.
- **Rank 2b, usability for the maintainer.** `70` §2 flags this as *"the one most likely to be
  quietly traded away."* In this plan it shows up as Stage A existing at all: closing `88`'s
  blockers before building on them is entirely rank-2b work.

---

## 2. What binds this plan

Stated once. No stage restates it.

| Constraint | Source |
|---|---|
| Invariants 1–10; the risk enum is exactly three values with reserved colours | `.context/conventions.md`; `78` §2 |
| `71` §13.1's thirteen permanent product boundaries are refusals, not deferrals, and no stage reaches them | `71` §13.1; ADR-0031 §Decision item 4 |
| A field not in `schema/` does not exist; schema changes go through `62`'s grammar | ADR-0008; `CLAUDE.md` rule 3 |
| Every stage's work reaches the tree as work orders executed under `78`; planning never executes the queue it authors in the same session | `78` §1, §7 |
| The verification floor runs on every PR in every stage | `78` §6 |
| No dependency is admitted until ADR-0032 §6's gate zero and the `--locked` fix are in CI, and every crate carries an owner-approved `deps/decisions/<crate>.md` | ADR-0032 §4 item 1, §5, §6 |
| Corpus content is not content until a named human is against it | invariant 10; ADR-0028 |

---

## 3. The spine — eleven stages on one page

*margin tab: the whole document in one table*

| Stage | Name | What exists at the end that did not exist at the start | Consumes | Owner-blocked on |
|---|---|---|---|---|
| **A** | The queue becomes runnable | A queue whose topmost row an execution session can actually execute; CI that notices a new dependency | — | §16 rows 1–4 |
| **B** | The substrate | A typed graph store with provenance and an op log; real scalars; the finder in WASM | WO-06, WO-01, WO-02, WO-07 | — |
| **C** | The estate becomes visible | A browser artifact showing an estate as a table and a per-equipment page; a workspace file that round-trips | WO-08, WO-05 | §16 rows 2, 7 |
| **D** | Text in, text out | A pasted junos-srx config becomes graph, and the graph becomes those lines again | WO-03, WO-04 | §16 row 8 |
| **E** | The graph has opinions | Findings render on real nodes from rules-as-data, each with `acceptable_when` | — | §16 rows 6, 12 |
| **F** | Teaching, change, and the last two views | All six views exist; a change set is a copyable ticket with a verification ladder | — | §16 row 12 |
| **G** | The picture | A layered diagram over the graph, legible at fan-out, with motion that carries meaning | — | §16 rows 27, 28 |
| **H** | The sealed workspace and the hosted shapes | A workspace file the server cannot read, and D2/D3 deployments over it | — | §16 rows 5, 15 |
| **I** | Breadth — six platforms and the content behind them | Five more platforms with dictionaries, emitters and reviewed corpus; version predicates narrowed | — | §16 rows 12, 13, 14, 25 |
| **J** | Dynamic ability | Separately-pasted configs correlate into one estate, proposals not assertions; the service layer | — | §16 rows 8, 9, 10, 16–24, 26 |
| **K** | The bar that lets it ship | The gate set `45` §19 specifies, running; the reproducible-build attestation `71` §13.2 puts before first download | — | §16 rows 11, 12, 29, 30 |

**Two properties of this ordering worth stating before the detail.**

Stages A–D are strictly serial: each is the dependency frontier of the next, and `00-INDEX.md`
already encodes most of it. **Stages E–K are not.** Once D is done, E, G and H have no dependency
on each other, and I and J run as their own tracks — `71` §1.2's O5 already says the corpus is *"a
parallel track with its own calendar, not a task inside a phase"*, and stage I is that track made
explicit. A single builder serialises them; the plan does not require it.

**The corpus track starts before stage A and never stops.** It is not a stage. It is drawn as `76`
§7.2's bottom row and it is the only line item that cannot be accelerated by better engineering.

---

## 4. Stage A — the queue becomes runnable

**What exists at the end:** an execution session can take the topmost OPEN row of `00-INDEX.md` and
run it to a green floor without escalating on a defect that was already known.

**Work orders consumed:** none. Every item here is planning or owner work under `78` §7, and three
of them are edits `78` §5 item 7 bars an execution session from making at all.

**New work orders:** none. This stage is deliberately outside the queue — its whole content is the
class of edit the queue may not contain.

**The content**, which is `88` §9 steps 1–7 with nothing added:

| Item | Source | Who |
|---|---|---|
| Ratify ADR-0031, ADR-0032, ADR-0033 | `88` §8 row "New" | Owner |
| `.context/conventions.md`'s ID form → `<kind-lower>:<ulid>` (ADR-0005's unexecuted action 1), then correct the five citations in WO-02, WO-05, WO-08 | `88` §4.2 | Owner (one line), then planning |
| `rust-toolchain.toml`'s target line, made outside the queue; then rewrite WO-07 §4 / §4.1 / §5 step 1 so the order does not instruct a forbidden edit | `88` §4.1 | Owner, then planning |
| ADR-0002's five replacement invariant texts, the residual scale and ADR-0001's precedence paragraph into `.context/conventions.md` — at minimum invariant 3, *"the one that is false as written"* | `88` §4.3, §8 Q5 | Owner or planning |
| Gate zero in `ci.yml` (fail if `Cargo.lock` gains a non-first-party package with no approval record) and `--locked` on every cargo invocation | ADR-0032 §4 item 1 and item 2, §6 | Planning (`78` §5 item 7 bars execution) |
| The queue-hygiene pass: WO-01/WO-07's missing `Cargo.lock` clause, WO-05's unscoped G3, WO-06's WO-07→WO-08 correction | `88` §5.1, §5.2, §6.5 | Planning |
| The factual pass: `88` §6.1–§6.5, §6.11, §6.12 — including the ADR review cadence gaining a trigger for *"the owner changed the requirements"*, which `88` §6.12 calls *"the cheapest guard in this document"* | `88` §6 | Planning |
| The licence files ADR-0004 decided and the tree does not have | `88` §5.8, §8 Q6 | Owner |
| Name the fragment-to-store weld order in `00-INDEX.md` and `CLAUDE.md` so it stops being invisible | `88` §5.3 | Planning |
| Re-anchor `73`'s Ranks C–F from phases onto events | ADR-0031 §Decision item 5 | Planning |
| Void the twelve *"not before phase N"* floors in `75`, keeping each entry's dependencies | ADR-0031 §Decision item 5 | Planning |

**Owner-blocked on:** §16 rows 1 (ratification), 2 (ID form), 3 (toolchain line), 4 (invariant
texts) — and row 11 (licences) for the licence item only.

**Exit condition:**

1. `88` §4's five blockers each read closed, with the closing commit named.
2. The retired identifier form is gone from the binding files. Checked with
   `grep -rln "fathom:<kind-lower>" .context/ docs/70-ops/79-work-orders/ | grep -v 00-PROGRAM-PLAN`
   — the exclusion is required because **this file contains the search string in this very line**,
   so the unqualified grep can never return nothing. (Verified clean 2026-08-08; the historical
   uses in ADR-0005's own Context and `73`'s D04 are the record of the state the decision replaced
   and are correctly left alone.)
3. `ci.yml` fails a PR that adds a package to `Cargo.lock` without a `deps/decisions/` record, demonstrated once against a throwaway branch.
4. Every cargo invocation in `ci.yml` carries `--locked`.
5. `LICENSE`, `corpus/LICENSE`, `NOTICE`, `CONTRIBUTING.md` exist and `Cargo.toml`'s `license` is no longer `UNLICENSED`.
6. The verification floor (`78` §6) is green.

---

## 5. Stage B — the substrate

**What exists at the end:** a typed graph store that enforces L0 at write time, carries provenance,
and logs batched ops; real scalars behind the `Scalar` trait; and the finder running as a WASM
module with its import, export, size and determinism audits green.

**Work orders consumed:** **WO-06** (finder completion — the shakedown order, `00-INDEX.md`'s
stated reason for leading with it), **WO-01** (the `Scalar` trait), **WO-02** (`fathom-graph`),
**WO-07** (`fathom-wasm`).

**New work orders:**

| Proposed name | One line |
|---|---|
| *The workspace lints* | `[workspace.lints.rust] unsafe_code = "forbid"` plus per-crate `[lints] workspace = true`, closing the three binaries that sit outside the six `lib.rs` attributes (`88` §6.9) |
| *The `acceptable_when` gate* | Parse and check the field in `fathom-corpus` so invariant 8 has a mechanical enforcement point instead of discipline (`88` §5.4) |

Both are small, both are execution-shaped once written, and both are rank-1 (security) or rank-2b
(maintainer) work under `70` §2.

**Owner-blocked on:** nothing, once Stage A's rows 2 and 3 are done. This is the stage that proves
Stage A was worth doing.

**Exit condition:**

1. WO-01, WO-02, WO-06, WO-07 all read `DONE` in their own status lines and in `00-INDEX.md`.
2. `cargo test --workspace --locked` green; `cargo run -p fathom-schema --bin fathom-schema-check` exit 0 with the standing two-warning baseline unchanged.
3. WO-07's import-allowlist audit passes — the check ADR-0032 §4 item 4 calls *"the single most likely way an automated session breaks invariant 1 while following the documents."*
4. `rg "unsafe" crates/ --glob '!**/generated/**'` produces nothing the workspace lint does not already forbid.

---

## 6. Stage C — the estate becomes visible

**What exists at the end:** a browser artifact a person can open from disk with no network, showing
an estate as a table, with an inspector and a per-equipment page whose cabled-peer cell navigates —
and a workspace file that serialises that estate and reads it back byte-identically.

**Work orders consumed:** **WO-08** (the inventory face — `76` §7.2's S4 slice, part one, and
`76`'s own *"first user-visible thing in the plan"*), **WO-05** (the workspace file, plaintext face
only; sealing stays owner-gated by its own §2).

**New work orders:**

| Proposed name | One line |
|---|---|
| *The S4 remainder* | Sorting, the `⌘F` in-view filter, the generated column picker over `NodeKind::fields()`, nested device→interface rows, in-cell editing — WO-08 §8 items 1–4 and its §10 item 4 |
| *`xtask assemble`* | The versioned artifact with CSP hashes computed over the final bytes, replacing WO-08's two `'unsafe-inline'` scaffolding substitutions and the `fathom-dev` name (`42` §8.2; WO-08 §10 item 7, §9 failure 8) |
| *The finder view* | The finder wired into the artifact — the `OP_INIT` boot sequence and where the corpus blob is packed (WO-07 §10 items 4 and 6; WO-08 §8 item 11, §10 item 8) |
| *The virtualised renderer* | The windowed inventory and the elision rule WO-08 §4.6 defers, landing with the first estate large enough to make `44` §4.7.4's claim testable (WO-08 §8 item 8, §10 item 6) |

**Owner-blocked on:** §16 row 2 (the ID form — WO-08's inventory row type carries it) and row 7
(the `Site` identity rule, `88` §8 Q7 / §6.13 — two schema warnings and duplicate-free re-import
both wait on one sentence). Row 29 (the e2e harness fork) is not blocking here: WO-08's G10 manual
checklist is the standing gate until it is answered.

**Exit condition:**

1. WO-08's G1–G10 pass with G10's checklist filled in, not `NOT RUN`.
2. WO-05's byte-identical round-trip gate green.
3. `fathom-<ver>.html` exists as a named file with a hash-pinned CSP, and `'unsafe-inline'` appears nowhere in it.
4. The artifact opens from `file://` and the `42` §9.4 egress string-scan passes — with `88` §6.7's amendment applied first, or the check fails on a correct artifact.

---

## 7. Stage D — text in, text out

**What exists at the end:** a real junos-srx configuration pasted as text becomes nodes and edges
in the store, and the store emits those lines back, each carrying the provenance that produced it.
This is the round trip, and it is the single most load-bearing demonstration in the whole plan.

**Work orders consumed:** **WO-03** (ingest — framer, lexer, shaper, the non-optional redaction
gate, the statement dictionary, the typed fragment with its residue ledger), **WO-04**
(`fathom-emit`).

**New work orders:**

| Proposed name | One line |
|---|---|
| *The fragment-to-store weld* | **Authored 2026-08-08 as WO-09**, and now a queue row rather than a proposal: provenance records, ULID minting, the containment materialisation (WO-03 §4.8; WO-04 §10 item 7(a)). Reconciliation is **not** in it — `Device` declares `identity: []` and no identity-tuple evaluator exists (WO-09 §10 item 1), so a re-parse order is still to be authored |
| *`IpsecVpn.mode` resolution* | Whatever makes `mode` `Set` on a re-parsed graph — a weld-time or dictionary-level derivation, or a new statement row; WO-04 §10 item 7(b) rules out an emitter-side inference because it *"would invent a value the user never chose"* |
| *The dictionary reconciliation* | Whether and when WO-04 §4.6's crate-const emit tables migrate into `corpus/dict/junos-srx/` — one shared table per `14` §6.4, or two co-verified halves — decided **before a second platform duplicates the knowledge** (WO-04 §10 item 2; WO-03 §10 item 7) |
| *The paste surface* | The paste-while-looking-at-a-device flow and its warning prompt, and the reverse explanation — the user-facing half of `76` §7.2's S6 |

**Owner-blocked on:** §16 row 8 (the S0 fixture exports). WO-03 §10 item 8 already schedules the
follow-up: when the owner's exports land, a work order *"replaces or augments the synthetic fixture
with real captures, re-pins §6.1 with a Disagreements entry, and revisits every VERIFY this file
carries."* The stage can complete on the synthetic fixture; **R-ONRAMP and R-RESIDUE are not
retired until it runs on a real config the project did not write.**

**Exit condition:**

1. WO-04's **G8**, the round-trip gate, green. It is the proof Fathom can read a config and write it back, and it is unrunnable until **three** things land: the weld order (WO-09), the `mode` resolution, and a fix for the golden's undeclared interface references — WO-04 §4.9 cites `reth0.0` and `st0.0` while declaring no interface, so under `14` §7.3 both stay `Pending` and neither edge exists in the re-parsed graph (WO-09 §10 item 2).
2. WO-03's redaction gate demonstrably non-optional — a fixture containing a secret refuses.
3. The residue ledger reports a rate on a real config, and that number is written down. It is the honest measure of R-RESIDUE and it does not exist yet.
4. Every emitted line carries provenance (invariant 6), checked by gate rather than by review.

---

## 8. Stage E — the graph has opinions

**What exists at the end:** the findings view renders real findings, produced by rules-as-data
evaluated against a real graph, each rule carrying `acceptable_when` and a `versions` predicate.

**Work orders consumed:** none existing. This stage is entirely new orders — the rule engine is
specified (`12`, ADR-0009, `63`) and has no queue row.

**New work orders:**

| Proposed name | One line |
|---|---|
| *The `fex` evaluator* | ADR-0009's condition language as a deterministic evaluator over the store, with its own golden corpus |
| *The rule engine* | `12`'s engine: bind anchors, evaluate, produce `Instance { rule, anchor }`, carry suppressions through re-parse per ADR-0010 |
| *The findings view* | `lint(graph)` as a view — the fourth renderer in `52` §1.1's honest count |
| *The rule-pack distribution layer* | `pack.toml`, hashing, signing, fixtures — `88` §5.6 records that the whole layer is prose only while 37 rules sit in the tree, and quotes the corpus file's own admission: *"Until those exist these are specifications of rules, not rules"* |
| *The `63` domain-enum reconciliation* | `63` §4.1's eight domains reject two of `63`'s own worked rules and two shipped rules; `61` §3.3 has a maintained thirteen-domain enum. Gate V1 is error-level. `88` §5.5 says do it **before the pack ships, because rule ids are stable forever** |

**Owner-blocked on:** §16 row 6 — *may a rule anchor on an edge at all?* This is `88` §4.5, and it
is the highest-value rule in the pack (`zone.host-inbound.ike-missing`) anchoring on `ZoneMember`,
which is declared as an edge and not a kind. `70` §11.2 re-asks it in the owner's own terms —
should the warning sit on the interface or on the zone — and states the security consequence
first: moving it to the zone widens the one-click fix to every interface in that zone, which is
*"the exact regression `87` R03 was written to prevent."* Also row 12 (the named corpus reviewer):
a rule with a placeholder reviewer is not a rule under invariant 10.

**Exit condition:**

1. The engine binds every rule in `corpus/rules/ipsec-junos-srx.yaml` without an unresolvable anchor, and `zone.host-inbound.ike-missing` binds under whichever answer row 6 gives.
2. `cargo test` fails if any rule lacks `acceptable_when` or has one under 40 characters (Stage B's gate, now with something to check).
3. `63` gates V1–V4 run in code, not in prose.
4. A finding rendered in the findings view traces to its rule id, its anchor node, and its `acceptable_when` text, in the UI, without a developer present.

---

## 9. Stage F — teaching, change, and the last two views

**What exists at the end:** all six views exist — finder, walkthrough, config, findings, diagram
(Stage G), inventory — and a change set is a copyable ticket with a verification ladder and a
rollback, which is `18`'s whole subject.

`52` §1.1 is the map and this stage completes it: the four renderers plus the controller plus the
corpus surface, with the explainer as *"a layer that opens inside all six views and owns no screen
of its own."*

**Work orders consumed:** none existing.

**New work orders:**

| Proposed name | One line |
|---|---|
| *The explainer surface* | `explain(node, depth)` as the layer it is, with the depth toggle and the provenance expansion WO-08 §8 item 10 defers |
| *The config view* | `emit(graph, vendor)` as a view, mode `Full` — the reading surface over Stage D's emitter |
| *Diff, verify, rollback* | `18`: the `GraphDiff`, the verification ladder, the rollback, rendered as config view mode `ChangeSet` per `52` §1.1's DECISION, and the change ticket they are copied into |
| *The walkthrough controller* | `drive(graph, task)` — the only controller in the product, an authored program that asks questions and **writes** to the graph. Every other view reads |
| *Walkthrough authoring* | The content format and the first authored walkthrough, on the corpus track and gated by invariant 10 |

**Owner-blocked on:** §16 row 12 (the named corpus reviewer — walkthroughs and explainers are
corpus content). Not blocked on anything else; `52` §1.1's decisions are already taken.

**Exit condition:**

1. All six views reachable from the shell, each rendering real content from the demo estate and from a pasted config.
2. `verify(diff(graph))` renders as a config-view mode, not as a seventh view — the check is that the shell has six tabs.
3. A change ticket copies to the clipboard with its verification ladder and its rollback, in one action, from one sitting (`18` §6).
4. The explainer opens inside all six views and owns no tab.

---

## 10. Stage G — the picture

**What exists at the end:** a layered diagram over the graph — five layers toggled independently
(`56` §4) — that stays legible at real fan-out, and whose motion passes ADR-0033's three tests.

**Work orders consumed:** none existing.

**New work orders:**

| Proposed name | One line |
|---|---|
| *The diagram canvas* | `render(graph)` — `56` §1's one canvas, the five layers, the cabling-first physical layer `76` §7.2's S7 leads with |
| *Aggregation and colour* | `59` §3's six-like-kind-sibling rule, the expandable group, and the fix for `59` §6.2's defect — the band stops printing *how many* labels it suppressed at exactly the scale where that matters, violating `56` §5.5's *"a diagram tool that silently drops labels is a diagram tool that lies about what it drew"* |
| *Cabling gestures* | `56` §6.4's connect disclosure — one gesture, one op, one undo step — plus drag as sugar and the wheel as a third driver inside the pointer-capture window |
| *Motion under ADR-0033* | Each motion in the product carries a written answer to the three tests `70` §5 states: purpose, direction, legibility |

**Owner-blocked on:** §16 rows 27 and 28, and **both are deliberately deferred to this stage rather
than asked now.** `70` §10.2's recommendation is explicit: do not decide diagram partitioning on
paper — *"put it to them when the diagram face is real enough to show two sites."* Row 28 (were the
ten links alike or mixed?) can be answered any time and is close to a one-word answer; row 27
(per-`Site` views and how they relate) should be answered against something running. `56` §12 owns
it.

**Exit condition:**

1. A forty-spoke hub renders legibly under `59` §3's rule, and the view band states the number of suppressed labels.
2. Layer toggles are independent and the diagram is a **view** — no diagram-only state exists in the workspace file. This is R-VIEW, and `71` §1.4 calls its failure *"architecture-corrupting."*
3. Every animation in the product has a one-line written justification under ADR-0033's three tests, and a reviewer can read them in one place.
4. Row 27 has been **asked**, against a running two-site diagram. Answering it is not this stage's exit; asking it is.

---

## 11. Stage H — the sealed workspace and the hosted shapes

**What exists at the end:** a workspace file that a server storing it cannot read, and the D2/D3
deployment shapes over it. This is rank-1 work under `70` §2 and it is the stage the whole security
posture exists for.

**Work orders consumed:** none existing. WO-05 delivered the plaintext face in Stage C and left
sealing owner-gated by its own §2.

**New work orders:**

| Proposed name | One line |
|---|---|
| *The sealed container* | ADR-0012's one container, ADR-0013's record granularity and manifest, `32`'s envelope, canonical CBOR per `32` §7.5 with `62` §17.1's integer field keys — all gated on §16 row 5 |
| *The key hierarchy* | ADR-0014's envelope and KDF corrections, key rotation and sharing, and `46` §9 Q1's username-in-KDF fork, which WO-05 §10 item 1 records as *"not separable"* from the crypto route because *"deciding after ship costs a `format_version`"* |
| *The vector tree* | `32` §16's test vectors, which WO-05 §10 item 1 quotes as *"part of the format, not part of the test suite"* |
| *The wire* | `33` — the sync protocol, whose §1 states *"The server stores ciphertext and never holds a key"* and whose §12 states the compromise outcome. Owner-triggered per §16 row 15 |
| *D2 and D3* | `43`'s single-node and cluster shapes, and the load-balancing property `70` §8 records as already compatible: `41` §5.5 has `fathom-sync` never linking the graph, rules, emit or parse crates, *and the linker enforces it* |

**Owner-blocked on:** §16 row 5 (the crypto route — adopt `32` §15.1's crate set as the
repository's first external dependencies, or something else; WO-05 §10 item 1 states that *"until
answered, WO-06-and-later work orders that presuppose sealing are unwritable"*) and row 15 (when
`33` is picked up — `70` §13 item 5 calls it *"the clearest single instance of the re-ranking
ADR-0031 §5 hands to `73`"*).

**Exit condition:**

1. A sealed workspace file exists on disk and no tool in the tree can read its interior without the passphrase.
2. `32` §16's vectors ship as part of the format and a second implementation could pass them.
3. A D2 node serves a workspace it cannot decrypt, demonstrated.
4. The linker enforcement `41` §5.5 specifies is checked by a gate, not asserted — a `fathom-sync` that links `fathom-graph` fails to build.
5. `deps/decisions/` holds an owner-approved record for every crate in the closure, `cargo-vet` records an audit for each, and vendored source is committed (ADR-0032 §2).

---

## 12. Stage I — breadth: six platforms and the content behind them

**What exists at the end:** the owner's six platforms are capabilities rather than names, and the
version predicates behind them mean something.

`70` §7.2 states the position precisely and it is the whole reason this stage is large: **five of
the six are already registered, and only `junos-srx` has any content behind it.** *"A registered
platform with no dictionary, no emitter and no corpus is a name, not a capability."*

| Owner's words (`70` §7) | Platform id | State per `70` §7.2 |
|---|---|---|
| Juniper SRX | `junos-srx` | 98 commands, 37 rules, 42 explainers |
| Juniper MX | `junos-mx` | Registered · no corpus, no dictionary |
| Juniper EX | `junos-ex` | Registered · no corpus, no dictionary |
| Cisco Nexus | `nx-os` | Registered · no corpus, no dictionary |
| Palo Alto | `panos` | Registered · no corpus; ADR-0030 makes it the second platform |
| Meraki | — | **Absent** — §16 row 13 decides whether it can be a platform at all |

`70` §7.1 settles what is per-platform and it is narrower than it looks: **a parser, a statement
dictionary, an emitter, and corpus content.** There are no per-vendor engines and `71` §13.1
forbids them; a rule is written once and carries a `platforms` predicate (invariant 5).

**Work orders consumed:** none existing. ADR-0030 makes `panos` the second platform and `70` §7
vindicates that choice — Palo Alto is on the owner's own list.

**New work orders:** one set per platform, four orders each, plus two cross-cutting:

| Proposed name | One line |
|---|---|
| *Platform bring-up: `panos`* | Parser, statement dictionary, emitter, corpus — the second platform, and the settlement of **R-SCHEMA**, which `71` §1.4 calls *"Fatal, and the most expensive to discover late"* |
| *Platform bring-up: `junos-mx`, `junos-ex`, `nx-os`* | The same four pieces each. The Juniper pair should be cheapest — same vendor, same family, different statement set — and that expectation is itself the schema test |
| *Platform bring-up: Meraki* | Conditional on §16 row 13. If the answer is *"no pasteable text"* this is not a work order at all but a boundary finding for `03` (`70` §7.3) |
| *Version-predicate narrowing* | Replace `versions: "*"` on all 37 rules and every command entry with real trains. `70` §7.4 quotes the corpus indicting itself: *"`versions: "*"` is used on all 37 rules and that is not a virtue … `"*"` here means 'unverified across trains'."* **No schema change and no new decision** — this is authoring work against a mechanism that already exists, and `70` §7.4 calls it *"the larger correctness win"* |
| *The known-defect advisory kind* | A genuine schema extension, and `70` §7.4 says the hard part is not the schema but the sourcing. **Gated on §16 row 14** — *"No field should be designed before this is answered"* (`70` §13 item 7) |
| *Platform visibility* | What a user selecting a registered platform with no content actually sees. `70` §13 item 10: *"A user selecting `junos-ex` today would get an empty product with no explanation."* `52` and `54` own the surface |

**Owner-blocked on:** §16 rows 12 (the named reviewer — this stage is almost entirely corpus
content and invariant 10 binds all of it), 13 (Meraki), 14 (advisory sourcing and staleness) and 25
(hardware and the named public reviewer, `76` §8 Q12 — *"the fact that most changes the corpus
estimate"*).

**Exit condition:**

1. Each of the five non-Meraki platforms ingests a real config, emits it back, and renders findings — the same three gates `junos-srx` passes in Stages D and E.
2. **R-SCHEMA is settled**: the second platform landed without a schema break, or the break is written down as an ADR with its cost. `71` §1.4's row for R-SCHEMA reads *"The IR is a Junos model with a `platform` field"* — this stage is where that is proved false or true.
3. `rg 'versions: "\*"' corpus/` returns nothing, or returns only entries whose `"*"` a named reviewer has affirmed.
4. Every corpus entry carries a real name in `reviewed_by`, not a placeholder.
5. Row 13 is answered and its consequence recorded — a platform row, or a boundary line in `03`.

---

## 13. Stage J — dynamic ability

**What exists at the end:** two configs pasted separately connect to each other, as **proposals a
person accepts**, never as edges written silently. And the service layer exists, so the estate is
recorded and not just configured.

This is `70` §6, which `70` §6 itself calls *"the largest requirement in the corpus with no
mechanism behind it"*, and `70` §15 item 3 warns against reading it as small: *"It reads like a
feature and it is closer to a subsystem."*

**No decision has to be won for it.** `03` §4.5 already draws the line where the owner wants it,
and says of pasted `show lldp neighbors` output: *"**This one is *in scope*, and stating that is
the point**: it is text the user gathered, not a network the tool probed. The refused version is
Fathom gathering it."* `71` §13.2's SNMP/LLDP row forbids Fathom *gathering* it and nothing else
(ADR-0031 §Decision item 4 restates this).

**Work orders consumed:** none existing.

**New work orders:**

| Proposed name | One line |
|---|---|
| *The correlation design document* | **Not code — a document, and it must come first.** `70` §6.1: *"It needs a design document before any code, and that document is planning work not yet scheduled."* It owes an evidence model, a confidence model, a conflict-resolution rule, an accept/reject UI and a provenance story for every edge it creates (`70` §15 item 3). Where it lives — a new `10-core` document or a section in `14` — is `70` §13 item 2 |
| *LLDP/CDP neighbour paste* | `70` §6.1's named cheapest high-value start: *"the one input that states adjacency directly rather than implying it"* |
| *Correlation signals beyond LLDP* | Matching interface descriptions, a shared subnet, a common /30, shared VLAN IDs, a hostname defined in one config and referenced in another, LAG peering — `70` §6.1 records that **none of these exists at all today** |
| *The proposal surface* | Accept/reject, with the evidence shown. `19` §3.7's rule is the template `70` §6.1 says to copy rather than reinvent: *propose, never assert; refuse when ambiguous; show the evidence* |
| *The service layer* | `77`'s tenants, CIDs, UNIs, service types, paths and the warp — `76` §7.2 omits it deliberately because S0's output is what makes costing it possible |
| *Naming and addresses* | `76` §7.2's S5: the `NamingScheme` settings record, the closed template grammar, compile-at-load, generation on create, the conformance audit, the address model |
| *Planning and maintenance state* | `70` §6.2's *"planning mode or maintenance mode etc"* — the capability `75` records as C-07, delivered as a mode, a per-record state or a filter. `53` refuses modes outright (*"No modes. No mode indicator. No mode errors."*) and `70` §13 item 1 records that the refusal **constrains but does not answer** the question |
| *Scale* | `76` §7.2's S8, unestimable until §16 row 9 lands |

**Owner-blocked on:** §16 rows 8 (S0 exports), 9 and 10 (`76` §8 Q1/Q2 — what a network is, and
whether cables cross network boundaries; Q2 is the one that can kill one-workspace-per-network
outright), 16–24 (the `19` §10 forks and `76` §8's naming and physical-plant questions — note
`76` §8 Q6 says *"Must be settled before any cable data is entered"*), and 26 (what `77`'s estate
is relative to `70` §7's platform list — `70` §13 item 6 asks for **one sentence**).

**Exit condition:**

1. Two configs pasted in separate actions produce at least one proposed cross-device edge, with its evidence shown, which the user accepts or rejects — and **nothing is written to the graph until they do.**
2. A refusal case is demonstrated: an ambiguous match proposes nothing and says why.
3. `rg -ci lldp corpus/` returns something. It returns nothing today (`70` §6.1).
4. One real service record from §16 row 8 is recorded end to end — CID, type, endpoints, equipment and ports traversed — and the warp resolves over it.
5. A generated equipment name conforms to the owner's scheme, and the conformance audit reports a number for the inherited estate.

---

## 14. Stage K — the bar that lets it ship

**What exists at the end:** the evidence that *"most features working without bugs"* is true rather
than asserted.

`70` §9 is precise about what this stage is: *"'without bugs' is a quality bar, not a feature. It
ratifies the verification floor (`78` §6) and argues for extending it — which is exactly what
ADR-0032 unblocks, since property testing and fuzzing the config parser are both currently blocked
on the dependency question."*

**Work orders consumed:** none existing.

**New work orders:**

| Proposed name | One line |
|---|---|
| *The gate set* | `45` §19's T1–T32 wired as they become checkable. `78` §6 records that today's floor is *"T1 plus the format, lint and schema gates, which predate the T-numbering"*, and `78` §10 makes each gate's arrival a per-work-order planning decision |
| *Property tests and fuzzing* | `proptest` for the scalars (WO-01's deferral), cargo-fuzz for the parser (`14` §13's targets, WO-03 §10 item 6) — both admitted only through ADR-0032 §5's per-crate owner approval |
| *The e2e harness* | Whichever of WO-08 §10 item 1's three mechanically enumerable options §16 row 29 picks: an owner exception for the harness crates, a first-party WebDriver client, or the manual checklist as the standing gate |
| *Reproducible-build attestation* | `71` §13.2's *"one deferral here with a hard deadline"* — gated **before** the first public download, not after. ADR-0032 §2 makes it checkable by making the build hermetic |
| *Supply-chain hardening* | `35` §11.3's action pinning (`88` §6.6 — `actions/checkout@v4` is a mutable tag and the project has already written a rule against exactly that), the hermetic build container, `deps/build-scripts.md` per `35` §5.7 |
| *Accessibility and contrast* | ADR-0026's three conditions actually gating the dark theme, which `88` §5.11 records `design/tokens.css` shipping unconditionally, plus `55`'s claims made checkable |
| *The determinism surface* | Whatever makes invariant 9's claim testable end to end. `88` §4.4 notes there is no CLI crate and therefore *"the determinism claim (invariant 9) has no testing surface"*; §16 row 31 decides whether that surface is a CLI |

**Owner-blocked on:** §16 rows 11 (licences, if not already done in Stage A — public download
needs them), 12 (named reviewer across all of `corpus/`), 29 (e2e harness), 30 (UI language —
ADR-0019's TypeScript toolchain versus the hand-authored JS the tree actually has, WO-08 §10 item
2).

**Exit condition:**

1. Every gate in `45` §19 that has a subsystem to gate is running, and the ones that are not are listed with the subsystem they wait on.
2. The four floor commands plus the arming gates pass on a clean checkout with no network, `--locked` throughout.
3. An independent rebuild of `fathom-<ver>.html` produces identical bytes, verified by someone who did not build it.
4. `corpus/` has zero `<named reviewer>` placeholders.
5. `38` §2.4's audit of invariant 2 no longer reads *"Not met"* — `03` §3.5's T-P1-a denylist runs against the **resolved** dependency graph, closing the `std::net` route ADR-0032 §4 item 5 describes.

---

## 15. What is deliberately not in the spine

Naming these prevents a later session reading their absence as an oversight.

| Not a stage | Why, with the citation |
|---|---|
| **The AI layer** (`21`–`25`, ADR-0020 through ADR-0023) | ADR-0031 §Decision item 1 enumerates what "all features" covers — *"the graph, the six views, the finder, ingest, emitters, findings, the workspace, the diagram, the inventory and service layer"* — and the AI layer is not in that list. ADR-0031 §Consequences separately records that ADR-0020 *"keeps its substance"* and that **this ADR does not reopen it**. So the boundary work (ADR-0020's premise: the AI layer is a boundary) stays specified and unbuilt until `73` D21/D22 are answered. Listed as §16 row 32 <!-- VERIFY: whether the owner reads "all features" as including the AI layer. ADR-0031's enumeration omits it; the owner's words did not enumerate anything. --> |
| **`71` §13.1's thirteen permanent product boundaries** | Refusals, not deferrals. ADR-0031 §Decision item 4: *"Retiring phases retires phase-limitations only."* |
| **Fleet-scale storage and server-side querying** | `71` §13.2 defers the first with a ~2,000-device trigger; `70` §8 records the second as **never** — it requires plaintext on the server, which invariant 4 exists to prevent |
| **Real-time collaborative editing** | `71` §13.2 defers it with a trigger. `75` §2.4 separately requires that new state must never foreclose it, which is a constraint on every stage rather than a stage |
| **Distance-2 fuzzy matching** | ADR-0031 §Decision item 6 preserves this deferral explicitly, because it was refused on measured precision grounds (`16` §6.3) and not on scope |
| **Platforms three and four** (`ios-xe`, `fortios`) and **domains beyond IPsec** | `71` §13.2's triggers. Stage I builds the owner's six and stops |

---

## 16. Every owner decision this plan waits on

*margin tab: the batch to answer*

> **THIRTY-FOUR ROWS. THE FIRST FIVE UNBLOCK MORE THAN THE OTHER TWENTY-NINE COMBINED**

Ordered by how much each unblocks, not by how hard it is. Tier 1 rows each unblock multiple stages;
tier 4 rows are best answered against something running and are listed so they are not forgotten,
not so they are answered today.

### Tier 1 — answer these first; they unblock whole stages

| # | The decision | Stated at | Unblocks |
|---|---|---|---|
| 1 | **Ratify ADR-0031, ADR-0032, ADR-0033.** They record decisions already made in substance; ratification makes them binding under `CLAUDE.md` rule 2 | `88` §8 row "New" | Everything. ADR-0032 alone closes the question five work orders each defer separately (`88` §5.7) |
| 2 | **Change `.context/conventions.md`'s ID form** to drop the product name (ADR-0005's action 1, never executed) | `88` §4.2 | WO-02 — the queue's main unblocker — plus WO-05 and WO-08. One line |
| 3 | **Add the wasm target line to `rust-toolchain.toml`**, outside the queue | `88` §4.1 | WO-07, and through it WO-08. One line. Nobody can execute WO-07 as written today |
| 4 | **Paste ADR-0002's invariant texts into `conventions.md`** — or at minimum invariant 3, *"the one that is false as written"* | `88` §4.3, §8 Q5 | Every session's first read. WO-03 builds against invariant 3 |
| 5 | **The crypto route:** adopt `32` §15.1's crate set as the repository's first external dependencies, or something else. Travels with `46` §9 Q1's username-in-KDF fork and `32` §16's vector tree | WO-05 §10 item 1; `70` §13 item 4 | All of Stage H. *"Until answered, WO-06-and-later work orders that presuppose sealing are unwritable"* |

### Tier 2 — each blocks a named stage

| # | The decision | Stated at | Unblocks |
|---|---|---|---|
| 6 | **When Fathom flags the missing IKE permission, should the warning sit on the interface or on the zone?** The security consequence is stated before the question: moving the fix to the zone widens it to every interface in that zone | `70` §11.2; `88` §4.5 | Stage E. Also decides whether `87` §3's RESOLVED stands |
| 7 | **When you re-import your site list, what makes a row the same site** — the site code, the name, the CLLI, something else, and in what order? | `88` §8 Q7, §6.13 | Stage C. The two standing schema warnings, and duplicate-free re-import. **Needs no exports** — two or three lines in `schema.yaml` |
| 8 | **The S0 fixture exports:** one Calix config, one Nokia config, one DIA-terminating config, one real service record end to end, one site list with CLLIs | `76` §7.3 | Stages D and J. It is the input every other estimate is missing |
| 9 | **What is a "network", and how many devices are in one?** | `76` §8 Q1 | Stage J's scale slice; every sizing answer in `76` |
| 10 | **Do cables cross network boundaries?** | `76` §8 Q2 | Stage J. If yes, one-workspace-per-network is dead on arrival — edges are `NodeId → NodeId` inside one graph and no edge spans two sealed containers |
| 11 | **Is the repository going public under Apache-2.0 / CC BY-SA 4.0** as ADR-0004 decided? The licence files want writing before the DCO retrofit gets more expensive | `88` §8 Q6, §5.8 | Stages A and K. A cost that grows per commit |
| 12 | **Who is the named expert reviewer of `corpus/`?** Invariant 10 is not satisfied until a named human replaces every placeholder | `CLAUDE.md`; WO-03 §10 item 9 | Stages E, F, I. Nothing in `corpus/` is content until this is answered |

### Tier 3 — needed before the stage that consumes them starts

| # | The decision | Stated at | Unblocks |
|---|---|---|---|
| 13 | **Is Meraki configured by text you can select and copy?** If no, Meraki cannot be a platform under invariant 2 and this is a boundary finding for `03`, not a scheduling one | `70` §11.3 | Stage I |
| 14 | **Sourcing and staleness for known-defect advisories:** where the data comes from, who is named against it, what the product says when an advisory is old | `70` §13 item 7 | Stage I. *"No field should be designed before this is answered"* |
| 15 | **When is `33` (the wire) picked up?** ADR-0016 deferred it as *"git is the sync for v1"*; ADR-0031 retires v1 as a scoping device, and `70` §8's load-balancing requirement lands squarely on `33` | `70` §13 item 5 | Stage H |
| 16 | **F1 — are subscriber endpoints modelled, and at what depth?** The node-count question | `19` §10 F1 | Stage J |
| 17 | **F2 — what is `{ST}`**, a state code or a site type? (Same as `76` §8 Q7) | `19` §10 F2; `76` §8 Q7 | Stage J. Blocks the first generated name |
| 18 | **F3 — what are Voice and LTE structurally, and is LTE a service type at all?** | `19` §10 F3 | Stage J |
| 19 | **F4 — is `03` §4.2's `N-R-2` amended, clarified, or held?** (Same as `76` §8 Q3) | `19` §10 F4; `76` §8 Q3 | Stage J. `76` §8 calls it *"the fork"* |
| 20 | **Does the existing estate already live in a source of truth that can be exported?** An importer is dramatically cheaper than modelling | `76` §8 Q4 | Stage J |
| 21 | **Does the inventory need to show ports that are not configured** — empty cages, dark fibre, spare positions? | `76` §8 Q5 | Stage J |
| 22 | **Does the physical plant include passive splits, breakouts or patch panels you traverse *through*?** **`76` §8 says this must be settled before any cable data is entered** | `76` §8 Q6 | Stages G and J |
| 23 | **What does `{TYPE}` resolve to** — a new vendor field, `platforms.yaml`'s `vendor:` attribute, or the scheme's own token list? | `76` §8 Q8 | Stage J |
| 24 | **Is the naming feature a validator, a generator, or both?** They are two work items, not one | `76` §8 Q9 | Stage J |
| 25 | **Do you have Calix and Nokia hardware, and will you be the named public reviewer?** *"The fact that most changes the corpus estimate"* | `76` §8 Q12 | Stage I |
| 26 | **What is `77`'s Calix/Nokia/DIA estate, relative to `70` §7's platform list** — the same job from two angles, or two jobs? **One sentence** | `70` §13 item 6 | Stages I and J. It decides whether the access layer needs its own platforms and corpus |

### Tier 4 — answer against something running, or when the stage arrives

| # | The decision | Stated at | Unblocks |
|---|---|---|---|
| 27 | **Does the diagram partition per `Site`, and how do two sites relate?** `70` §10.2's recommendation is explicit: **do not decide this on paper** | `70` §13 item 8; `56` §12 | Stage G, asked at Stage G |
| ~~28~~ | ~~**The bridge with ten links — were they ten of the same thing, or a mix?**~~ **ANSWERED 2026-08-08 — neither.** Two nodes joined by ten **standalone** links: one neighbour, ten parallel edges. Both offered answers assumed many neighbours. `59` §3's levels count nodes and none counts edges, so nothing fires; `59` §3.13 records the finding and `59` §3.14 proposes a sixth level. **The mixed-neighbour case was never the owner's example and is still open** — `70` §13 item 10 | `70` §10.1, §11.4 | Stage G |
| 28a | **Is `59` §3.14's sixth aggregation level adopted** — parallel edges between one pair of nodes collapse to one drawn edge with a visible count, keyed on the channel budget? Three sub-forks travel with it: the threshold, the three-rail gap (a `56` §5.3 token nobody has measured), and whether a `Cable` is drawn at all | `59` §9; `70` §13 item 11 | Stage G. `56` owns the diagram and therefore owns the answer |
| 28b | **`group` and `tag` — schema questions before design questions.** The owner named both. `GroupId` occurs once in the tree with no definition, no `schema/` entry and a keybinding that collides with `53`; `tag` does not exist at all; and node position is not in `schema/` either, so `move` is unbuilt too | `70` §10.3; `70` §13 items 12–13 | Stage G, and the schema work precedes it |
| 29 | **The e2e harness fork:** an owner exception for the harness crates, a first-party WebDriver client, or the manual checklist as the standing gate | WO-08 §10 item 1 | Stage K. Until answered, WO-08's G10 is the gate every UI order inherits |
| 30 | **The UI language:** adopt ADR-0019's TypeScript toolchain (an owner exception on dependencies), or amend the ADR to match the hand-authored JS the tree has | WO-08 §10 item 2 | Stage K |
| 31 | **Does the CLI ship?** `88` §4.4 records that without one the determinism claim has no testing surface | `73` §4.5 (D13) | Stage K |
| 32 | **Does the AI layer ship at all, and at which tier?** Plus whether the localhost inference sidecar is permitted | `73` §7.1 (D21), §7.2 (D22) | §15's first row |
| 33 | **Third-party rule packs and the trust root** | `73` §4.3 (D11) | Stage E's distribution layer |
| 34 | **Does the conformance lab exist, and who runs it?** | `73` §4.1 (D09) | Stage I; ADR-0027's verification stamp |

**One property of this list is worth the owner's attention.** `88` §8 said of its own seven
questions: *"they fit in one sitting."* Tier 1 here is five rows, three of which are single-line
file edits, and it is the difference between a queue that runs and a queue that stalls at its
topmost row.

---

## 17. Branch points — what changes if an answer goes the other way

Only the answers that move the plan. Everything else changes work, not order.

### 17.1 Row 5 — the crypto route

| If | Then |
|---|---|
| The `32` §15.1 crate set is adopted | Stage H proceeds as written. ADR-0032 §6's gate zero must be in CI **first**; ADR-0032 §5's per-crate approval becomes a recurring owner act, not a one-off |
| The owner prefers something else, or first-party crypto | Stage H grows a design track that does not exist anywhere in the corpus, and `32` §15's own framing — *"What is deliberately not rolled by hand"* — is reversed. ADR-0032 §1 states the position bluntly: *"Writing that code in-house is the genuinely dangerous option."* This is the single most expensive way this plan can change |
| The dependency policy is refused outright | Stages K and E lose property testing, fuzzing and the e2e harness; WO-06's `finder.idx` never exists; Stage C's UI stays hand-authored JS against ADR-0019. Five work orders' deferrals become permanent (`88` §5.7) |

### 17.2 Row 10 — do cables cross network boundaries?

If **yes**, one-workspace-per-network is dead: `76` §8 Q2 states that *"no edge can span two sealed
containers under different keys."* That reaches Stage H's container design, not just Stage J's
sizing — so the answer is wanted **before** Stage H's format is fixed, even though the question
looks like a Stage J question.

### 17.3 Row 13 — Meraki

If **no pasteable text**, Meraki is not a platform. `70` §7.3 is explicit that the only remaining
ways in are a file export — *"a different input shape … which no parser targets today"* — or an API
call the product will never make. Stage I loses a bring-up and `03` gains a nineteenth boundary.
This is the one row in §16 whose "no" makes the plan **smaller**, and it should be read that way
rather than as a setback.

### 17.4 Row 6 — the IKE anchor

| If | Then |
|---|---|
| **Interface** | Stage E proceeds; ADR-0029 correction 1's re-anchor is repaired editorially (`88` §4.5 option (a) — read the per-interface set *across* the `ZoneMember` edge as a binding) |
| **Zone** | Either the same editorial repair with a zone anchor, or `88` §4.5 option (b): extend `12` §4 and `63` §7 so an edge can be an anchor — *"which means findings attach to edge ids and is a real engine change."* Option (b) reshapes Stage E's engine work order before it is written |

### 17.5 Row 27 — does the diagram partition?

If **yes**, Stage G grows a navigation model that does not exist: `70` §10.2 records that the
corpus has *"one canvas over the whole graph"*, that neither a per-`Site` view nor an inter-site
relationship exists, and that *"'one canvas, aggregate when it gets big' is a rendering policy, not
a navigation model."* This is why the row is deliberately asked late, against a running two-site
diagram, rather than early on paper.

### 17.6 Row 32 — the AI layer

If the owner reads *"all features"* as including it, §15's first row becomes a twelfth stage
sitting after Stage F, and `71` §1.2's O4 binds it hard: *"`constraint.negotiator` never ships
without `adversary.redteam`."* Nothing earlier in the plan moves; ADR-0020's boundary is designed
to be landed before any model exists.

### 17.7 The standing tension nobody has resolved

ADR-0031 §Consequences states it and this plan inherits it unchanged: ADR-0003 (Accepted,
unreversed) records that nobody funds this and that *"the honest scope is one platform, one domain,
forever."* ADR-0031 removes the cuts and leaves the funding assumption untouched. *"'All features'
plus 'one person, unfunded' is a schedule nobody has drawn."* This plan draws an **order**, not a
schedule, and that is the most it can honestly do. ADR-0031's own revisit trigger — *"a year of
work without a shippable artifact"* — is the check on it.

---

## 18. The new work orders this plan calls for

Names are proposed; `00-INDEX.md` assigns numbers at authoring time (`78` §8). Nothing here is
authored by this document.

| Stage | Order | Shape |
|---|---|---|
| B | The workspace lints | Execution |
| B | The `acceptable_when` gate | Execution |
| C | The S4 remainder | Execution |
| C | `xtask assemble` | Execution |
| C | The finder view | Execution |
| C | The virtualised renderer | Execution |
| D | The fragment-to-store weld | Execution — **authored 2026-08-08 as WO-09**, closing `88` §5.3. Reconciliation is not in it (WO-09 §10 item 1) |
| D | `IpsecVpn.mode` resolution | Planning decision, then execution |
| D | The dictionary reconciliation | Planning decision (WO-04 §10 item 2), then execution |
| D | The paste surface | Execution |
| E | The `fex` evaluator | Execution |
| E | The rule engine | Execution |
| E | The findings view | Execution |
| E | The rule-pack distribution layer | Execution |
| E | The `63` domain-enum reconciliation | Planning (`88` §5.5) |
| F | The explainer surface | Execution |
| F | The config view | Execution |
| F | Diff, verify, rollback | Execution |
| F | The walkthrough controller | Execution |
| F | Walkthrough authoring | Corpus track |
| G | The diagram canvas | Execution |
| G | Aggregation and colour | Execution |
| G | Cabling gestures | Execution |
| G | Motion under ADR-0033 | Design, then execution |
| H | The sealed container | Execution, gated on §16 row 5 |
| H | The key hierarchy | Execution, gated on §16 row 5 |
| H | The vector tree | Execution, gated on §16 row 5 |
| H | The wire (`33`) | Execution, gated on §16 row 15 |
| H | D2 and D3 | Execution |
| I | Platform bring-up ×4 or ×5 | Execution + corpus track |
| I | Version-predicate narrowing | Corpus track |
| I | The known-defect advisory kind | Schema design, gated on §16 row 14 |
| I | Platform visibility | Design (`52`/`54`), then execution |
| J | The correlation design document | **Planning, and it precedes all Stage J code** |
| J | LLDP/CDP neighbour paste | Execution |
| J | Correlation signals beyond LLDP | Execution |
| J | The proposal surface | Execution |
| J | The service layer | Schema design, then execution |
| J | Naming and addresses | Execution |
| J | Planning and maintenance state | Design (`53` constrains), then execution |
| J | Scale | Unestimable until §16 row 9 |
| K | The gate set | Execution, incremental |
| K | Property tests and fuzzing | Execution, gated on §16 row 5 |
| K | The e2e harness | Gated on §16 row 29 |
| K | Reproducible-build attestation | Execution, **hard deadline: before first public download** (`71` §13.2) |
| K | Supply-chain hardening | Planning (`.github/` is `78` §5 item 7 territory) |
| K | Accessibility and contrast | Execution |
| K | The determinism surface | Gated on §16 row 31 |

Three of these are **not** work orders and should not be written as one: the correlation design
document, the `63` domain-enum reconciliation, and the dictionary reconciliation. `78` §7's test
applies — *"if two reasonable people could do it differently and both be defensible, it is
judgment-shaped."*

---

## 19. How this plan is maintained

This document will go stale. Saying how it is refreshed is the difference between a plan and a
snapshot.

**Ownership.** Planning sessions only (`78` §7). An execution session never edits this document,
for the same reason it never edits `71` or `73`.

**The single source of truth for *what is next* is `00-INDEX.md`, not this document.** Where the
two disagree, the index wins and this document is corrected — the same rule `78` §8 applies between
a work order's status line and its index row. This plan is the *why* and the *shape*; the index is
the *what*.

**Refresh triggers**, each of which makes some part of this document false the moment it fires:

| Trigger | What is refreshed |
|---|---|
| A stage's exit condition is met | The stage's row in §3 records the closing commit; the next stage's owner-blocked list is re-checked against §16 |
| An owner answers a §16 row | The row is struck through with the date and the answer's location, exactly as `88` §8 struck its Q1–Q3 and `70` §11.1 struck itself. **Never deleted** — a struck row records that the question was real |
| A new work order is authored | §18's row gains its assigned WO number |
| An ADR is ratified or reopened | Every stage citing it is re-read. `88` §6.12 asks for a review trigger on *"the owner changed the requirements or the scope"*, and this document is one of the things that review should touch |
| A branch point in §17 resolves | The losing branch is deleted and the winning one folded into the stage |

**The scheduled review.** ADR-0031 §Consequences records that the ADR cadence *"loses its clock"*
with phases retired, and `88` §6.12 independently finds the same cadence broken. Both are fixed by
the same one-sentence change, and this document should be reviewed on the same trigger the register
gains: **whenever the owner changes the requirements or the scope**, with one question per stage —
*does this stage still rest on a premise that is still true?*

**What a refresh must not do.** It must not add durations (§1.3), must not silently re-order stages
without saying which risk moved, and must not quietly drop a §16 row because it became
inconvenient. `70` §12 item 1's rule applies by analogy: a record that has been tidied has stopped
being a record.

---

## 20. Standing authorisation — what proceeds without asking

*margin tab: the owner asked for this*

> **Status of this section: PROPOSED.** It governs how much latitude planning takes, so it is the
> owner's to grant. Nothing in it is in force until they say so.

The owner's request, verbatim: *"maybe we make one and that way i can just keep saying "yes" and let
you run with all of this and only get back to me if you need decisions i can answer like ux,
animations, what about this, etc etc."*

That is a reasonable ask and this plan is most of the answer — §16's rows are precisely
the set of things that need them — thirty-five open as of 2026-08-08, one struck (row 28). What follows is the rule for everything else.

### 20.1 The three buckets

| Bucket | What is in it | What happens |
|---|---|---|
| **Proceed** | Sequencing and re-cutting the queue; authoring work orders; schema extensions through `62`'s grammar; code, tests and CI; correcting a factual error in any document; filling a gap where the corpus already implies the answer | Done, and recorded in the artifact itself. No message |
| **Proceed and report** | Reversing an Accepted ADR on merit (`75` §2 expressly permits it); changing a number the corpus states; anything that moves a row in §16 | Done, with the reasoning written down where the decision lives, and named in the next report |
| **Stop and ask** | The four cases in §20.2 | Nothing proceeds on a guess |

### 20.2 The four things that always stop

These are not a matter of confidence. They stop even when the answer seems obvious, because being
wrong is either unrecoverable or invisible until it is expensive.

1. **Anything that touches invariants 1–4.** The no-egress, no-device, no-credential and
   no-readable-server guarantees. `71` §13.1's thirteen boundaries are refusals, not deferrals, and
   `38` prices every future exception. Rank 1 in the owner's own priority order.
2. **Visual, interaction and motion judgment.** What something looks like, how it feels, what an
   animation means. The owner named these as exactly the questions they want. `51`, `52`, `53` and
   ADR-0033 hold the ground rules; the taste is theirs.
3. **A claim about vendor behaviour with no primary source in the tree.** Meraki's configuration
   model (§16 row 13) is the live example. Guessing here fabricates the one kind of content the
   product exists to be trusted on, and conventions forbid it outright.
4. **Anything that makes a correctness claim to a user that nobody has reviewed.** Invariant 10's
   named-reviewer requirement, and by extension every rule, explainer and defect advisory.

### 20.3 What this does not do

It does not reduce §16. Those rows still need answering — the authorisation governs the
space *between* them, which is most of the work. And it does not licence proceeding through a
`78` §5 stop-and-escalate condition: an execution session's escalation rules are stricter than this
section and are unaffected by it.

**RECOMMENDATION —** grant it for the Proceed and Proceed-and-report buckets, and treat §20.2 as
fixed. The failure mode this guards against is not moving too slowly; it is a hundred small
defensible calls compounding into a product the owner did not ask for and cannot see the seams in.

## Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **The stages are read as phases** and someone infers a reduced first release from them | §1.1 states the difference; every stage says it is a dependency frontier. ADR-0031 §Decision item 1 and `70` §9 both refuse a thin release, and §3's table has no "ship" column |
| 2 | **A stage boundary becomes a scope boundary** — work is cut to make a stage "finish" | Exit conditions are checkable facts, never judgments of completeness. A stage that cannot meet its exit condition is not finished; it is blocked, and the blocker gets named |
| 3 | **§16 is answered piecemeal** and the owner is bothered repeatedly, which is the thing they asked not to happen | The tiering exists so tiers 1 and 2 are one sitting. Tier 4 is explicitly *not* for today, and §16's preamble says so |
| 4 | **This document becomes a second queue** and diverges from `00-INDEX.md` | §19's precedence rule: the index wins, always. This document names orders; it never sequences within a stage |
| 5 | **Stage I is under-weighted because it looks like content rather than engineering** | `71` §1.2's O5 (*"the corpus is a parallel track with its own calendar"*), `76` §7.2's bottom row, `70` §9 (*"`72` names the corpus authoring rate as the variable that moves them most"*). Five platforms with no content are five names |
| 6 | **Stage J is scheduled as a feature** | `70` §15 item 3 warns it is *"closer to a subsystem"*, and Stage J's first order is a design document with no code in it |
| 7 | **A dependency lands before ADR-0032 §6's gate zero** | Stage A precedes every other stage for exactly this reason. ADR-0032 §4 item 1: *"Because the answer today is exactly zero, this is three lines now and expensive later"* |
| 8 | **Durations get added** because someone wants a date | §1.3; `78` §8's ban on durations in work orders, extended here to their plan. The corpus's own figures (`71` §2, `83` §12.5) are cited once, attributed, and not per stage |

## Open decisions

Planning-owned, not owner-owned, and not decided here:

1. **Whether Stages E, G and H are genuinely parallel for a solo builder**, or whether the plan should state a serial order among them. §3 asserts they have no mutual dependency; it does not assert that working them concurrently is wise.
2. **Where the correlation design document lives** — a new `10-core` document or a section in `14` (`70` §13 item 2). Planning decides; it precedes any Stage J code.
3. **Whether LLDP/CDP paste needs its own corpus format** or reuses the command-output shape (`70` §13 item 3). Unowned today.
4. **Heterogeneous high-degree nodes** — a rule for the mixed-fan-out case, once §16 row 28 is answered (`70` §13 item 9). `59` §3's rule is like-kind only.
5. **Whether `73` §14** (the escalation inbox `78` §4 step 3 creates on first use) **is triaged into D-numbered register entries or answered as ADRs** (`78` §10, §12 item 4).
6. **Whether an `IN PROGRESS` status is added** to `00-INDEX.md` once execution sessions run concurrently (`78` §10).
7. **When each `45` §19 gate T2–T32 joins `78` §6's floor** — planning decides per work order (`78` §10), and Stage K only names the set.
8. **Whether this document supersedes `71` as the project's plan of record**, or sits beside it. `71` currently carries a banner pointing at `76` §7.2 and `00-INDEX.md`; ADR-0031's revisit trigger anticipates *"a re-cut `71` (or its replacement)"* being Accepted, at which point ADR-0031 item 5 is discharged. This document is a candidate for that and does not claim it.

## Sources consulted

| Source | Taken |
|---|---|
| `CLAUDE.md` (whole) | Current state; the five session rules; the owner-blocking list; the verification floor's shape |
| `docs/70-ops/70-owner-answers-and-standing-priorities.md` (whole) | §2's priority order; §4 (all features, sequencing delegated); §5 (motion); §6.1/§6.2 (correlation, and *"the largest requirement with no mechanism"*); §7–§7.4 (the six platforms, the platform-not-vendor rule, the registry table, version predicates and advisories); §8 (hosting, and what is and is not refused); §9 (no thin release, the estimates, internal checkpoints); §10.1/§10.2 (the six-sibling rule and the partitioning gap); §11.2/§11.3/§11.4 (the three open owner questions); §12 item 1; §13 items 1–10; §15 item 3 |
| `docs/70-ops/79-work-orders/00-INDEX.md` | The eight rows, their statuses, dependencies and deliverables; the queue-order rationale; the owner-blocking paragraph |
| `docs/70-ops/78-execution-protocol.md` (whole) | §1 the three roles; §2 inherited constraints; §3 the loop; §4 escalation; §5 items 2, 4, 7; §6 the floor and its CI backstop; §7 the execution/judgment test; §8 the queue and the **ban on durations**; §10 the four open decisions; §12 items 4, 5 |
| `docs/70-ops/71-roadmap.md` §§1–2, §13.1, §13.2 | The superseded-as-a-plan banner; §1.2's five ordering principles (O2, O4, O5); §1.4's risk register (R-SCHEMA, R-VIEW, R-ONRAMP, R-RESIDUE, R-CORPUS); §2's 106–158-week total; §13.1's permanent boundaries; §13.2's deferrals and the reproducible-build hard deadline |
| `docs/70-ops/76-scope-expansion-analysis.md` §7, §8 | §7.1's starting position and the O2 principle; §7.2's S0–S8 slices and the corpus track row; §7.3's S0 inputs and exit criterion; §8's Q1–Q12 |
| `docs/80-review/88-state-review-and-recommendations.md` §§4–9 | §4.1–§4.5's five blockers; §5.1–§5.11's eleven majors; §6.1–§6.13's minors (esp. 6.5, 6.6, 6.7, 6.9, 6.11, 6.12, 6.13); §8's owner questions; §9's recommended order |
| `docs/90-decisions/adr-0031-…` (whole) | Decision items 1–6; the four re-anchored documents; the ADR-0003 collision; the revisit triggers; the enumeration of what "all features" covers |
| `docs/90-decisions/adr-0032-…` §§1–6 | The three dependency tiers; the four layers; C1–C9; the eight routes an automated session would miss; the admission process; §6's *"gate zero comes first"* |
| `docs/70-ops/79-work-orders/WO-01…WO-08` — headers, §1, §8, §10 | Each order's objective, dependencies, non-goals and standing open decisions; the queued planning work each defers |
| `docs/50-design/52-information-architecture.md` §1.1 | The six projections versus the six views; *"four renderers, one controller, one corpus surface, and one layer"*; the `verify(diff)`-is-a-mode decision |
| `docs/10-core/19-service-and-physical-model.md` §10 | The four owner forks F1–F4 and their headings |
| `docs/70-ops/73-open-decisions.md` §§3–8, §13 | The register's Rank A–F structure and D01–D23; D09, D11, D13, D21, D22 by heading; §13's five proposed changes |
| `ls crates/`, `ls docs/*/`, `ls docs/90-decisions/` (run 2026-08-07) | Six crates on disk; the document set; ADRs 0001–0033 |

## Disagreements

1. **Against calling `71` "stale" without qualification.** The prompt for this document described
   `71`'s phase structure as stale. That is right about the *scoping* half and wrong about two
   parts `71` itself flags as surviving: §13.1's thirteen permanent boundaries and §13.2's
   reproducible-build deadline, both of which ADR-0031 §Decision items 4 and 6 preserve explicitly.
   This plan carries both forward (§2, §14, §15) rather than treating `71` as discarded. `71` §1.4's
   risk register is also live — every stage exit condition here is denominated in it.

2. **Against putting Stage I (platforms) later than Stage E or G.** A defensible alternative order
   puts the second platform immediately after Stage D, because `71` §1.4 rates **R-SCHEMA** as *"the
   most severe risk in the project"* and `73` §13 item 4 already proposes pulling a read-only PAN-OS
   ingest spike far earlier — *"2–3 solo weeks against a 12–18 week phase, to get most of the
   R-SCHEMA signal eighteen months earlier, on the grounds that the schema breaks on ingest before
   it breaks on emit."* This plan does not adopt that as the spine, because the owner's rank 2a
   (usability for the user) argues for the views existing before the estate is broadened, and
   because Stage I's content cost is corpus-rate-bound and cannot be compressed by starting earlier.
   **But the spike is cheap and the argument is good**, and a planning session should consider
   inserting a read-only `panos` ingest spike between Stages D and E as a `73` §13 item 4 discharge.
   Recorded here rather than decided.

3. **Against the confidence of §3's parallelism claim.** §3 asserts Stages E, G and H have no mutual
   dependency. That is true on the documents; it is not verified against code that does not exist
   yet. The diagram consumes the store's iteration order and the rule engine consumes its anchors,
   and either could turn out to want a store change the other has already fixed. Logged as Open
   decision 1 rather than asserted as fact. <!-- VERIFY: cross-stage store dependencies, once WO-02 lands -->

4. **Against the tidiness of §16's ordering.** The rows are ordered by how much each unblocks, which
   is a judgment. Rows 9 and 10 in particular could sit in tier 1: `76` §8 says *"Q1, Q2 and Q10
   gate S0's inputs"*, and Q10 has since been answered (`70` §7). If the owner intends to supply the
   S0 exports soon, rows 8–10 rise to tier 1 and rows 2–4 do not fall — the tiering is about
   consequence, not about difficulty, and the first four rows are all one-line edits regardless.

5. **Against reading §15's AI row as settled.** ADR-0031 §Decision item 1 enumerates the feature set
   and omits the AI layer; the owner's words (`70` §4) enumerated nothing. Treating the ADR's
   enumeration as exhaustive is the reading this plan takes, and it is an inference. It is listed as
   §16 row 32 so the owner can overturn it in one word, and §17.6 states exactly what changes if
   they do.
