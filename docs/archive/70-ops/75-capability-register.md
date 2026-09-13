# 75 — Capability register: intent recorded, nothing decided

> **Status:** Proposed

Companion documents: this register decides nothing and specifies nothing. It sits between
`docs/70-ops/71-roadmap.md`, which sequences work that has been scoped, and
`docs/70-ops/73-open-decisions.md`, which holds forks that are ready to be answered. Every entry
below names the documents that would carry its detail if it were ever built. The ones named most
often are `docs/10-core/11-ir-schema.md`, `docs/10-core/12-rule-engine.md`,
`docs/10-core/13-emitters-and-provenance.md`, `docs/10-core/18-diff-verify-rollback.md`,
`docs/50-design/52-information-architecture.md`, `docs/50-design/53-interaction-and-keyboard.md`,
`docs/30-security/33-sync-protocol.md` and `docs/00-vision/03-non-goals-and-scope.md`. **C-05 and
C-06 add four more to that list** — `docs/10-core/14-parsers-and-ingest.md`,
`docs/10-core/15-explainer-corpus.md`, `docs/50-design/54-component-catalog.md` and
`docs/60-content/61-command-corpus-spec.md` — and they move `docs/10-core/17-workspace-format.md`
from an occasional citation to a load-bearing one. **C-07, C-08 and C-09 widen the list again**, into
the design half of the corpus — `docs/50-design/51-design-tokens.md`,
`docs/50-design/55-accessibility.md`, `docs/50-design/56-diagram-view.md` and
`docs/50-design/59-diagram-aggregation-and-colour.md` — plus `docs/10-core/19-service-and-physical-model.md`,
and C-08 is the first entry to cite `schema/schema.yaml` directly rather than through a document
about it. Two decision records govern how entries leave:
`docs/90-decisions/adr-0008-the-schema-is-a-specified-artifact.md` blocks every field-shaped entry
here, and `docs/90-decisions/adr-0010-identity-reparse-and-suppression-survival.md` supplies most of
C-01's machinery. **C-05's blocker is not a decision record at all**: it is a `Refused` boundary,
`03` §4.10 `N-R-10`, and §7.2 is where that is stated.

---

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | What this register is, the gap it fills, and the line it does not cross | *read this first* |
| 2 | The standing instructions — sunk cost is not an argument; the real-time groundwork | *governance* |
| 3 | C-01 — element lifecycle state | *decommission, maintenance, etc* |
| 4 | C-02 — ticket reference and date annotation | *(a) is free, (b) is refused* |
| 5 | C-03 — multi-select and bulk action as first-class | *you select in order to act* |
| 6 | C-04 — integration hooks, deferred on security grounds | **NOT APPROVED** |
| 7 | C-05 — config backup and restore | *copy paste, copy and paste* |
| 8 | C-06 — teaching-off posture and operational procedures | *the other half of the product* |
| 9 | C-07 — freeform annotation, and the planning overlay modes | *drawn on the glass, never in the model* |
| 10 | C-08 — typed stencils: "router", "switch", and the etc | *a typed node, not clip art* |
| 11 | C-09 — the pocket | *click in, work small, leave everything intact* |
| 12 | The corpus is lopsided toward teaching | *an observation, not an entry* |
| 13 | Second-order consequences | *what each entry drags in* |
| 14 | What the owner must decide — candidates for `73` | *the questions nobody asked* |
| 15 | Nearly free versus large | *the cost is in the state model, not the feature* |
| 16 | Failure modes of this register | *how a register rots* |
| 17 | Open decisions this register raises and does not answer | |
| 18 | Sources consulted | |
| 19 | Disagreements | |

---

## 1. What this register is, the gap it fills, and the line it does not cross

*margin tab: read this first*

> **A REGISTER NOTHING EVER LEAVES IS A WISH LIST**

### 1.1 The gap

The corpus has three homes for future work and none of them fits "we intend to do this, we have
not decided how, and it is not scheduled".

| Home | Holds | Admission test |
|---|---|---|
| `71` | Work that is sequenced into a phase, with effort in person-weeks and an exit criterion | It has a shape and a place in the order |
| `73` | Forks stated so that a yes/no or a pick-one answers them, each with an `R` value and a latest responsible moment | The question is well-formed enough to be answered |
| `90-decisions/` | Answers, with the rejected option's strongest argument in its own words | Somebody decided |

An intention that is none of those three has, until now, had two possible fates: it goes into
`71` §13.2 as a deferral with a trigger — which is the right home only if the thing is genuinely
*deferred*, meaning it was once scoped — or it is lost. `71` §13.2 is a good table and it is not
this table: every row in it is a thing whose shape is known and whose timing is not. The entries
here have unknown shape.

**This document is where an intention lives before it is well-formed enough to be a `73` fork.**

### 1.2 The line

> **THIS REGISTER RECORDS INTENT. IT DOES NOT DECIDE, SPECIFY OR SCHEDULE.**

**Where that rule comes from, and it is the owner's.** The four requests below (§3.1, §5.1, §6.1)
arrived together with an instruction that they were being recorded as future intent and were **not
to be acted on** — no decision was asked for, and none is given here. That instruction is this
document's entire licence to exist. Without it, four capability requests carrying this much
second-order consequence would belong in `73` as forks, or nowhere at all.

**The instruction was restated when four clarifications arrived after this register was first
written** — the two that answer the date question (§3.8, §4.4) and the two that open C-05 (§7) and
C-06 (§8). That restatement **is** preserved, in the owner's words:

> *"these are just plans btw don't act on the new stuff atm"*

*"The new stuff"* is those four clarifications, so that sentence governs C-05, C-06 and both halves
of the date answer directly. The four clarifications themselves are likewise preserved verbatim, at
§3.8, §4.4, §7.1 and §8.1, and §18 records each.

**A fifth batch arrived after that restatement** — the standing constraint in §2.4 and the three
entries C-07, C-08 and C-09 — and no restatement of the instruction accompanied it. §9.1 states its
status once, for all three entries: recorded under the original instruction's licence, quoted
verbatim, acted on by nobody.

> **The wording of the *original* instruction — the one that arrived with the four capability
> requests in §3.1, §5.1 and §6.1 — is still not preserved here, and it should be.** §2.1 states the
> reason it matters — *"paraphrasing a governance instruction is how it decays"* — and the opening
> paragraph of this subsection is a paraphrase of it. Whoever next touches this register with access
> to that exchange should replace that paraphrase with the owner's words. Recorded as a live defect
> in §16 row 7 rather than papered over: a reconstructed quotation would be worse than an admitted
> gap, because it would read as evidence. **The restatement quoted above is not a substitute**, because
> it was said of different material.

Every entry states what is wanted, where it would attach, what it drags in, and what must be
decided first — and then stops. Concretely, and these are the failure conditions a reviewer
should check this document against:

| Not in this document | Because |
|---|---|
| A schema fragment, a `Rust` type, a YAML shape | That is `11` and `62`'s job, and `62` does not exist yet (ADR-0008) |
| A component contract, a keymap entry, a token | That is `53` and `54`'s job, and ADR-0024 gives `53` the keymap |
| A chosen enumeration presented as settled | The owner said "etc". An open enumeration is data about the request, not a gap to fill |
| An ADR | Writing one would be deciding. The owner asked for intent recorded, not a fork answered |
| An effort estimate below `71`'s person-week granularity | `71` §14 says every number in it is a planning assumption. Inventing a smaller one here would be worse |

Options are recorded. Picking one is not — unless the corpus already picked it, in which case
the entry cites the document that did and moves on.

`73` §1.1 states the discipline this register inherits: *"Nothing here is binding until it is
recorded per §10. A lean is not an answer."* The same applies with more force here, because these
entries are not even leans.

### 1.3 The entry lifecycle — proposed, not enacted

An entry that never leaves is a wish. **Everything in this subsection is a proposal about how this
document should be governed, and this document cannot enact it.** ADR-0001 gives every settled
question one owning document, and §19 item 1 records that `75` is not named anywhere and owns
nothing settled — so a register cannot legislate its own review process from inside itself. The
exits, the cadence and the disposal rule below are offered to whoever makes the `73` §10 edit
proposed in §19 item 1. Until that edit exists, they bind nobody, including this document.

Four exits are proposed.

| Exit | Where it goes | The trigger |
|---|---|---|
| **Scheduled** | A phase in `71`, with effort and an exit criterion | Somebody scoped it. The register row is struck through and points at the phase |
| **Forked** | A `Dnn` row in `73` §2, with an `R` value and a latest responsible moment | The question became well-formed. This is the most common exit and the one to aim for |
| **Decided** | An ADR in `90-decisions/` | Somebody answered it. Usually via `73`, occasionally directly |
| **Killed** | Struck through here, with the reason and the date | It was wrong, or it collided with a boundary in `03` §4 that nobody wants to move |

**Struck through, never deleted.** `03` §10.1 step 5 gives the reason for non-goals and it applies
identically here: *"the history of what a project refused is the most useful part of a non-goals
document to a reader two years later."* An intention that was recorded and then abandoned is
evidence about the project's judgement; an intention that silently vanished is evidence about
nothing.

**Review cadence, proposed.** At phase boundaries, with `73`. `73` §10.4's argument transfers:
*"A register reviewed continuously becomes a discussion; a register reviewed at phase boundaries
becomes a checklist."* Two questions per entry — has anything upstream unblocked it, and is it
still wanted. Whether that is the right cadence is for `73` §10 to say, not for this document.

### 1.4 The shape of every entry

| Field | What it says |
|---|---|
| **What is wanted** | In the owner's terms, not in implementation terms |
| **What already exists** | The parts of the corpus that already do some of it. Usually more than expected |
| **Options** | Presented as options. Never resolved here |
| **Where it would attach** | Document and section, with what would change |
| **What it drags in** | The second-order consequences, honestly, including the ones that make it expensive |
| **What must be decided first** | The upstream blockers, in order. An entry with an unmet blocker cannot be scheduled, only forked |
| **Not before** | The earliest phase whose prerequisites exist, against ADR-0006's phase model. **A floor, never an assignment** — see §1.5 |

### 1.5 The register

**How to read the "Not before" column.** It is a *lower bound derived from prerequisites*, not a
phase assignment. It says: the machinery this entry needs does not exist until here, so it cannot
land earlier. It does not say it lands there, or that it lands at all. **Scheduling is `71`'s to
do and this register does not own `71`**; Q22 (§14) leaves the actual phase open, and §14 Q22's own
note is that deciding this as one feature and scheduling it as one feature will not survive contact
with `71`'s phase boundaries. The column exists so that nothing here reads as near-term.

| # | Capability | Status | Not before | Hard blocker | § |
|---|---|---|---|---|---|
| **C-01** | Element lifecycle state — decommission, maintenance, and an open "etc" | Intent recorded | Not before phase 2; the emit half not before phase 3 | `62-schema-spec.md` does not exist (ADR-0008); `03` §4.3 `N-R-3`'s test as written | §3 |
| **C-02a** | Ticket reference and dates as inert workspace data | Intent recorded | Not before phase 2 | Same schema blocker. No invariant blocker found **on the tests run in §4.2** — that is a result, not a clean bill; §4.2 records which tests were run and against what | §4 |
| **C-02b** | Live ticketing integration — fetch, post back, validate, sync a window | **NOT APPROVED — see C-04** | — | Invariants 1 and 3 | §4.1, §6 |
| **C-03** | Multi-select and bulk action as a first-class verb class | Intent recorded | Not before phase 2 | `52` §12 D3 currently leans the other way; `53` §7.2's `TxSource` cannot express it | §5 |
| **C-04** | Integration hooks to ticketing and change management | **DEFERRED, AND CURRENTLY REFUSED BY `03` §4.3** | Not on any plan | Two invariants, three ship gates, two permanent boundaries | §6 |
| **C-05a** | Config backup and restore — the *cheap* half: teach the backup verb, teach the platform's own restore verb | Intent recorded | Corpus authoring is not phase-blocked; the entries could be written today | `03` §4.10 `N-R-10` refuses the capability **by name**, `Reopens if` names one door and it is `03` §10.1 | §7 |
| **C-05b** | Config backup and restore — the *expensive* half: store a snapshot series, diff it, generate restore lines | Intent recorded | Not before phase 3; `18` §5's generator is phase-3 machinery | Same `N-R-10` refusal, plus `18` OD-1, plus conventions.md still carrying the pre-ADR-0002 invariant 3 | §7 |
| **C-06a** | Teaching-off as a **copy payload** — the bare command, not the command plus its context | Intent recorded | **Already in phase 0**, on two keys | None found. `53` §6.3 already specifies both payloads and `71` §3.5 renders the legend | §8 |
| **C-06b** | Teaching-off as a **product-wide posture**, plus an authored operational procedure for a planned change | Intent recorded | Not before phase 3 for the procedure; the posture is not gated by the graph at all | No third program type exists (`52` §6.2 versus `18` §4.2); `15` §6.3 forbids a fourth `Depth` **by name**; `54` §8.7 rule 4 refuses the pointer affordance the owner asked for | §8 |
| **C-07** | Freeform annotation layer, plus planning overlay modes with customisable colour categories | Intent recorded | Not before phase 4 — both halves land on the diagram | `59` §4.1's **DECISION — no colour** stands, with its own written gate (`59` §4.7) and its own pre-written reversal shape; the reserved risk trio bounds any palette (`51` §1 R1, §3.3) | §9 |
| **C-08** | Typed stencils — quick-create for hand-origin nodes: `Device` with `role: router`, `switch`, … | **Partly decided** (2026-08-15, §10.7) | Not before phase 1; the canvas half needed a place to store a position and now has one | None structural found — `Device.role` is a declared schema field and `Origin::Hand` is a first-class origin. The design language refuses the pictorial *form*, not the capability. **ADR-0035 closes the "and then where does it sit" hole**: a hand-placed position is graph data (`LayoutPin`), so a stencil dropped on the canvas can stay where it is dropped | §10, §10.7 |
| **C-09** | The pocket — a named working set that scopes canvas, inventory and findings to itself | Intent recorded | Not before phase 2; on the canvas not before phase 4 | `52` §5.7 makes selection deliberately un-persisted and un-synced. A pocket is what selection is not, so it cannot ride selection's type and needs its own record answer | §11 |

**Read the C-04 row before reading anything else.** The owner deferred it for security reasons and
was right to. What the owner may not know is that it is not merely deferred: `03` §4.3 `N-R-3`
refuses it, and that refusal's *"Reopens if"* cell reads **Never**. §6 records that honestly.
§4 records the part of the request that is available today and touches nothing.

### 1.6 Scope reality check

Stated up front so this register is not misread as a near-term plan. ADR-0006: **v1 is the finder
— phase 0, "Nothing about a graph."** The inventory is phase 2. Findings, diff and the change
ticket are phase 3. Sync is phase 5, and ADR-0016 makes git the sync with no multi-writer CRDT
until a pilot team works around the lock.

Nothing in this register is v1, **with one recorded exception that is not a capability so much as a
finding**: C-06a — teaching-off as a clipboard payload — is already specified and already in phase 0.
`53` §6.3 gives `⌘C`/`c` *"the rendered command, interpolated, one line, no risk label"* and `y` the
same command plus `RISK LABEL`, `ANSWERS`, `READ` and `IF BAD →`; `71` §3.5's phase-0 mock renders
the split as a footer legend, `⏎ copy   ⇧⏎ copy with context`. §8.4 records what follows from that,
which is that a large part of what the owner asked for in clarification (4) exists on two keys and
does not exist as a posture.

**The merge-semantics problems raised in §3 and §13 split in two,
and only one half is dormant.** An earlier draft of this section claimed both halves were dormant
until ADR-0016 was reversed. That was wrong, and ADR-0016's own text is what refutes it.

| Half | Live from | Why |
|---|---|---|
| **`33` §6.4's field-class question** — which of A/N/B/C/D/E a lifecycle register is (§13 row 11), and the HLC/actor machinery behind it | **Dormant.** Only if ADR-0016 is reversed | ADR-0016 defers the multi-writer CRDT entirely: *"No multi-writer convergence."* `33` remains *"the specification for when one is built. It is deferred, not deleted"* |
| **`11` §8.6's resolution question** — what happens when two copies of a workspace assert different values for the same field | **Live from the first git merge**, which is phase 0 | ADR-0016 ships *"a workspace file plus git"* for v1 and phases 0–3, and its own "not this" table reads: *"A git merge conflict on a record is opened in the application with the passphrase and merged on plaintext by `11` §8.6."* `17` §12.4 specifies the mechanism — `fathom merge --resolve` reads the three index stages, opens them under an explicit unlock, and *"merges values per `11-ir-schema.md` §8.6"* |

`11` §8.6's ladder is four deterministic steps — higher `Confidence`, then `Origin` precedence,
then later `asserted_at`, then `Field::Conflicted` — and step 3 is last-writer-wins by its own
admission: *"Two `Hand` assertions at different times do resolve by recency, which is
last-writer-wins."* A lifecycle state set by two people on two clones of a git-synced workspace
resolves by that ladder, in phase 2, with no CRDT anywhere near it. So does D3's *"bad bulk edit
across a sync merge"* (§5.4).

**The consequence for this register:** every entry that touches merge must say which half it is in.
§3.4, §5.4 and §13 row 11 now do.

---

## 2. The standing instructions

*margin tab: governance*

> **PRIOR WORK DOES NOT CONSTRAIN FUTURE QUALITY. SUNK COST IS NOT AN ARGUMENT**

### 2.1 The instruction

Recorded verbatim from the owner, because paraphrasing a governance instruction is how it decays:

> *"i would rather us plan out and spend a bunch of usage to make it as best we can vs sticking to
> what we've already done"*

The operative reading: **where an earlier decision is the best answer, it is kept because it is
best, never because it is already written.** A decision's age is not evidence for it. A document's
existence is not evidence that its conclusion survives contact with a requirement that arrived
afterwards.

### 2.2 What this changes, and what it does not

**A reading, not a ruling.** The table below is this register's reading of the owner's instruction
in §2.1, offered so that the instruction is not silently widened into a licence. It is not a
governance rule this document is entitled to make — `73` §10 and ADR-0002 own that — and where
the reading is wrong, the instruction wins and this table should be corrected.

| The reading | What it does not extend to |
|---|---|
| Every `Accepted` ADR is reopenable **on merit** | Any ADR becoming less binding until it is reopened by the process that created it |
| Make "we already argued this" an insufficient reason to close a question | Make "we already argued this" irrelevant — the earlier argument is evidence, it is just not authority |
| Put the burden on the *new* requirement to show the old answer no longer fits | Invite re-litigation without new information |

**The mechanism already exists and does not need inventing.** Thirty of the thirty-one files in
`90-decisions/` carry a `## Revisit if` section — a trigger written before the decision was taken,
precisely so that arriving evidence counts rather than being argued away. `73` §10.3 states why:
*"'What would make this wrong' is written before the decision is taken. Otherwise it is written
after the evidence arrives, and it will be written to exclude it."*

Reopening an ADR on merit means one of two things: its `Revisit if` trigger fired, or a new
requirement landed on it that its author did not have. This register's entries are the second
kind. That is the whole reason it exists.

### 2.3 What this register reopens, flagged and not pursued

Three places where the entries below land on an existing answer. **None is reopened here.** Each
is recorded so that whoever acts on this next re-establishes the answer rather than inheriting it.

| Reopened | Where | Why the new requirement lands on it |
|---|---|---|
| **D3 — is inventory bulk-edit in v1 at all** | `52` §12 | D3 leans *defer* and its argument was made when bulk edit was a convenience. C-03 makes it a primary application path. See §5.4 |
| **`11` §17 #4 — should suppressions live in the graph as nodes** | `11` §17 | The identical fork returns one level up for a second kind of user-attached annotation, and one of its two stated reasons does not carry over. See §3.6 |
| **`52` §14's request that `44` §3 adopt budgets S1–S5** | `52` §5.6.3, §14 vs `44` §3 | `52` asked; `44` never took it. C-03 adds a bulk *write* across a selection, which has no budget at all. See §13 |

In each case the earlier answer may still be best. ADR-0010 in particular looks best on the
merits and not merely first (§3.5). That should be re-established, not assumed.

### 2.4 A second standing instruction — the real-time groundwork

Recorded verbatim from the owner, for §2.1's reason — paraphrasing a governance instruction is how
it decays. The sentence arrived opening the fifth batch, and it is quoted again in §9.1 because the
two halves are read by different people:

> *"As long as the groundwork is there for the real time stuff, that'll be important eventually,
> but we should probably do freeform stuff, even if it's temporary or permanent doesn't matter."*

**The first clause is not a capability request and it gets no entry.** It is a standing constraint:
**nothing built now may foreclose live multi-writer collaboration later.** The corpus already holds
almost all of it, which is why this subsection is short — the constraint is recorded so that it
binds this register's own entries rather than being re-derived per entry:

| Where the groundwork already is | What it holds |
|---|---|
| `33` | The multi-writer sync protocol, specified in full — the op model, the §6.4 field classes, the convergence machinery. ADR-0016's own row: *"`33` remains the specification for when one is built. It is deferred, not deleted"* |
| `73` D18 | *"Does v1 have multi-writer sync at all?"* — decided as a deferral with a reopening condition, not a closure: *"No. File plus git for v1. Single-writer sync with an advisory lock next. Multi-writer only on evidence"*, and `73` §6.2's own text records that *"the op log stays either way"* |
| `73` D19 | The CRDT choice, pre-argued and parked: hand-rolled with Loro as the named fallback, live only if D18 reopens |
| `38` §5.3, §5.8 | The capability ladder prices the server rung — E1, *"shared synced database, load balancing, HA, DR"* — including, per D-38.6, *"the one exposure that never reverses"* |

**What the constraint does inside this register.** Two things, both already this document's
discipline and now stated as owed to an instruction rather than to taste:

1. Every entry that adds user-visible state must say which merge half it lands in (§1.6), and must
   say whether that state rides `33` §5.1's op model or is deliberately session-local. The op log
   is what a future CRDT converges; state written beside it instead of through it is state that
   multi-writer collaboration can never carry. `52` §6.2's run state is the precedent — *"Written
   as ordinary ops (`33` §5.1), so it syncs and merges"* — and C-07 and C-09 are the first entries
   whose state has no answer yet (§14 Q36, Q40).
2. The constraint does not reverse anything. `52` §5.7's refusal stands in its own words — *"Shared
   cursors are a collaboration feature this product has not earned and they leak what a colleague
   is looking at"* — and the owner's sentence asks for groundwork, not for cursors. A reader taking
   "the real time stuff" as approval of live presence has misread both.

---

## 3. C-01 — Element lifecycle state

*margin tab: decommission, maintenance, etc*

> **THE FEATURE IS CHEAP. THE STATE MODEL IS EXPENSIVE. THE STATE MODEL IS ALL OF IT**

### 3.1 What is wanted

From the owner:

> *"if we need to decommission, maintenance, etc and attaching ticket and dates to them as well."*

Graph elements need a human-set state describing where they sit in their operational life.
Two states are named. The enumeration is explicitly open — "etc" — so this register proposes
candidates rather than assuming the owner's list is complete.

### 3.2 What already exists — four state machines, under four names

Before any enumeration is proposed, this is the list it must be reconciled against. **The corpus
already models four lifecycle-ish things, none of them called lifecycle.**

| Existing | Where | What it means | Shape |
|---|---|---|---|
| `absent_since: Option<Timestamp>` | `11` §10.5, and `Node` in `11` §13 | Tombstone. Parsed before, not in the latest capture. Excluded from emit, rendered muted with a margin tab `absent since 2026-07-28`, deleted only by a human | A bare `Option<Timestamp>` on `Node`, **outside** the `Field<T>` / provenance system |
| `Divergent { since }` | `11` §10.5 | Intended but not deployed — an `Origin::Hand` node missing from a `Section` or `Whole` re-parse. Raises a finding | A per-node state produced by the re-parse path |
| "Deployed but not intended" | `11` §10.5, named as the free converse | A parsed node with no hand-entered counterpart where intent was modelled first | Not materialised; a consequence of provenance plus capture scope |
| `ReviewState { Fresh, Acknowledged, Orphaned }` | `12` §11.1 | The lifecycle of a *suppression*, not of an element | An enum on the `Suppression` record |

`absent_since` is the closest precedent in the corpus and also the sharpest collision. It is
lifecycle state in the IR today, for exactly one state, and `33` §6.6's worked merge example is
literally *"B removes `GW-B` because the peer was decommissioned"*, resolved as a tombstone.

> **Today, decommission *is* tombstone.** An explicit `Decommissioned` state creates a second,
> independent absence concept on the same element, with its own merge rule, its own emit
> behaviour and its own rendering — and a four-cell matrix of which three cells are nonsense
> (tombstoned-but-live, decommissioned-but-present-in-config, both). `Op::Purge` (`33` §5.1,
> `53` §3.8 `⇧P`) sits on tombstone only.

Two framings are visible from here — lifecycle subsumes tombstone, or the two are reconciled as
distinct concepts with the four-cell matrix given meaning. **This register does not claim those are
the only two**, and Q12 is open. What it does claim, and this part is a constraint rather than a
decision: shipping both *without* reconciling them gives one question two answers, which is how a
data model acquires a state nobody can explain. Any third framing has to discharge that same
obligation.

### 3.3 The state vocabulary — options, not a decision

Two structural questions come before any list of words.

**Question A — one axis or two.** `Decommissioned` is a destination: it is where an element ends
up. `Maintenance` is a temporary overlay on an element that is otherwise live. Folding them into
one enum means an element in maintenance cannot also be scheduled for decommission, which is a
common real combination. Two orthogonal fields — a lifecycle stage plus a transient operational
state — cost one more field now and avoid a shape change later. **Not decided here.** §15 notes
that a shape change after phase 1 is a major schema bump (`11` §11.3), and `11` §11.4 states what
a major bump does to an air-gapped user.

**Question B — the enumeration is open, and this register must not close it.**

> **THE OWNER SAID "ETC". THE LIST BELOW IS NOT A SHORTLIST AND MUST NOT BE READ AS ONE.**

§1.2 forbids *"a chosen enumeration presented as settled"*, on the grounds that an open enumeration
is data about the request rather than a gap to fill. The owner named **two** states —
`Decommissioned` and `Maintenance` — and left the rest open. Everything else in the table below is
**this register's invention, added to show what the "etc" drags in, not to propose what fills it.**

The table's purpose is the right-hand column. Each row demonstrates that a state word is never just
a word: it is a row in every emit-behaviour table and every merge matrix C-01 touches, and several
of the obvious candidates collide with machinery that already exists. That is the finding. The
words themselves are worked examples and carry no standing.

| Candidate | Provenance | What it would assert | The collision it demonstrates |
|---|---|---|---|
| `Maintenance` | **Owner** | Temporarily out of service, expected back | Wants `deactivate` semantics from the emitter, not `delete` — `13` §2.4 — and `13` §9.2 already has `deactivate` unrepresentable on two of three platforms |
| `Decommissioned` | **Owner** | Gone from the box | Collides with `absent_since` (§3.2): today, decommission *is* tombstone |
| `Planned` | *Register's invention* | Modelled, not yet built | `11` §10.5's `Divergent { since }` already means this, derived rather than asserted. A demonstration that some of the "etc" may already exist under another name |
| `Live` | *Register's invention* | Normal operation | A default state that is also a value is a state you have to migrate into |
| `Decommissioning` | *Register's invention* | Deletes generated, not yet applied | The sharpest one: this is a *process* state, and `03` §4.3 `N-R-3`'s test forbids exactly that. See §3.6 blocker 2 |
| `Retained` | *Register's invention* | Physically present, deliberately unmanaged | Included to show the enumeration cannot be closed by intuition — this is arguably the most useful state in a real estate and it is the one nobody asks for first |

**Q3 asks for the full enumeration and this register has not narrowed it.** A reader treating the
six rows above as the candidate set has misread the section: two are the owner's, four are
illustrations, and the owner's "etc" may contain states none of the six anticipate. The finding to
carry forward is the *shape* of the problem — that each state costs a row in several matrices, and
that at least one obvious candidate is refused outright by `03` §4.3.

**Whatever set is proposed must be checked against `11` §6.1's earn-a-kind test**, whose criterion
is *"a distinct required-field set, a distinct edge signature, or a distinct **lifecycle**"*. That
sentence will be quoted in both directions: it is the reason a lifecycle enumeration matters, and
it is the reason somebody will argue a lifecycle state should have been a kind.

### 3.4 Where it would attach

| Document | Section | What would change |
|---|---|---|
| `11` | §6.2 and §13 | **The fork that decides everything else.** §6.2 says every kind implicitly carries `id, prov, ext, aka, unknown, notes: [Text]`. §13's `Node` struct carries `id, body, existence, ext, aka, absent_since, unknown` — no `notes`. Two normative statements in one document already disagree about whether a free-text user carrier exists. A node-level `lifecycle` sits beside `absent_since`; a per-kind `lifecycle` sits in `NodeBody`. That fork decides whether lifecycle is a `Field<T>` with provenance and history or a bare marker |
| `11` | §10.5 | An **edit to a decided table**. Today an `Origin::Hand` node missing from a `Section`/`Whole` re-parse becomes `Divergent { since }` and raises a finding. If a human has set `Decommissioned`, that absence is confirmation, not divergence, and the table has no cell for it |
| `11` | §6.3 | If lifecycle is a body field, this is the per-kind table it enters. §6.3 already carries annotation-only fields with Emit `—`: `Site.criticality` is marked *"Used by rule severity weighting, not by emit"* |
| `11` | **§8.6** | **Live from phase 0, not deferred with the CRDT (§1.6).** §8.6 is the resolution ladder every git merge runs through `fathom merge --resolve`: higher `Confidence`, then `Origin` precedence, then later `asserted_at`, then `Field::Conflicted`. A lifecycle state is `Origin::Hand` on both sides of a two-clone merge, so steps 1 and 2 tie and step 3 decides — *"which is last-writer-wins"*, by §8.6's own words. Whether that is acceptable for a state that gates emit is a question this register does not answer, and it is due in phase 2, not phase 5 |
| `17` | **§12.3–12.4** | The mechanism behind the row above, and the reason it is not theoretical. §12.3 removed the custom merge driver entirely, so records carry `merge=binary` and git leaves a conflicted path. §12.4's `fathom merge --resolve` then reads the three index stages, opens them under an explicit unlock, and *"merges values per `11-ir-schema.md` §8.6"*. A lifecycle field acquires whatever §8.6 gives it, automatically, with no work and no decision |
| `11` | §11.3 | A new optional field is a **minor** bump that old clients preserve. Changing its shape later is a **major** bump |
| `12` | §3.6, §5 | Only touched if rules may *read* lifecycle. If they may, it enters the `fex` name environment, the static read-set extractor, the dependency keys and the invalidation algorithm. If they may not, `12` is untouched and lifecycle is inert |
| `13` | §2.4 | The emit half, and the most valuable thing in the request. See §13 row 4 |
| `17` | §4.2 | As a node field it lands in the `Nodes` shards for free — no new class byte, no new merge path. As a workspace sibling alongside `Suppressions` `0x20` it needs a class byte and §9.2's leak argument applies |
| `18` | §2.5, §6.2 | Free if it is a schema field — the diff walks the schema in declaration order, so a lifecycle change becomes a `FieldDelta` automatically. `DeltaClass` is a separate question (§14) |
| `33` | §6.4 | A row must be added to the A/N/B/C/D/E class table. See §13 row 11 for which classes are candidates and why the choice is contested. **This row alone is dormant under ADR-0016** — the field classes are CRDT machinery, and `33` is *"deferred, not deleted"*. It does **not** carry the `11` §8.6 row above with it (§1.6) |
| `52` | §3.7 | Inventory is the named home: *"the one view where bulk editing is appropriate"*, with columns *"chosen from the schema (`11` §11.6 makes the schema data, so the column picker is generated, not hand-written)"*. A lifecycle column is generated rather than written — **but only if lifecycle is a schema field.** A node-level attribute like `absent_since` is not in `schema.yaml` and would need a hand-written exception |
| `54` | §14 | Either a sibling component or a generalisation of the suppression record |

### 3.5 The ADR-0010 precedent, and exactly how far it carries

The central judgement this entry needs. **Half of C-01 is the same problem ADR-0010 already
solved. Half is a resemblance that will mislead whoever acts on this next.**

**Genuinely the same — the anchoring half.** Both are human-authored, never parsed, bound to an
`ElementId`, must survive a re-parse that mints fresh ULIDs, must orphan rather than vanish when
the anchor goes, carry dates and free text, are exported to reviewers, are never emitted to a
device, and share the unverified-author problem (`12` §11.1's comment on `author`: *"free text,
workspace-local, NOT authenticated"*). ADR-0010's machinery transfers essentially verbatim:

| ADR-0010 mechanism | Why it transfers |
|---|---|
| `11` §10.3's tier-1 tuple hash as a **recovery** key and nothing else | Same requirement: recover a binding after a ULID is gone, without becoming a graph reference |
| `ReviewState::Orphaned` retained rather than deleted | Same requirement: a lifecycle annotation whose element disappeared is information, not garbage |
| Unique-match-only re-binding | Same hazard: silently re-binding "decommissioned" to the wrong object is worse than orphaning it |
| *"a rename produces a candidate, never a binding"* | Same hazard, higher stakes |
| `fsck --repair` as a repair path with a human at the other end (`17` §16.2) | Same shape |

This is reuse, not analogy. Per §2, it is also the answer that looks best on the merits — but that
should be re-established when C-01 is scoped, not inherited from this sentence.

**Only superficially the same — the semantics half, and that is where the work is.** Four
differences, on each of which ADR-0010 is silent because it never had to speak.

| # | Difference | Consequence |
|---|---|---|
| 1 | A suppression's anchor is a `(rule_id, ElementId)` pair — a *finding* — and `Scope::Workspace` is not element-anchored at all (`12` §11.1) | Lifecycle anchors purely to the element, so it **can** be a field where a suppression structurally cannot |
| 2 | `11` §6.9 puts suppressions outside the graph on purpose. `11` §17 #4: *"putting them in the graph makes merges manufacture waivers"* | A lifecycle field is inside the graph — different record class, different merge class, different diff behaviour, and a merge **can** manufacture it |
| 3 | Cardinality. Many suppressions per element; one lifecycle state per element | A register, not a set — which is exactly why no `33` §6.4 class fits |
| 4 | **The big one.** A suppression suppresses an engine *output* and is inert by design. Lifecycle state is an engine *input* unless deliberately made inert | Every place it stops being inert — quieting findings, entering `fex`'s name environment, excluding an element from emit — is a place ADR-0010 gives no guidance and `12` §17 D-6 already has |

**Reuse ADR-0010 for anchoring with confidence. Do not let the resemblance carry into semantics.**
It runs out exactly where the decisions start.

### 3.6 What must be decided first

In order. Each blocks the ones below it.

| # | Blocker | Why it is first |
|---|---|---|
| 1 | **`docs/60-content/62-schema-spec.md` must exist.** ADR-0008: *"A field that exists in prose and not in `schema.yaml` does not exist."* `60-content/` currently holds only `61` and `63` | Nothing field-shaped in this register is declarable until it is written. ADR-0008 prices it at *"two to three weeks of specification plus the codegen"* and records that it is **not in `71`'s phase table** and is on the critical path for phases 1–3 |
| 2 | **`03` §4.3 `N-R-3`'s test must be settled.** Its review rule reads: *"no workspace field represents a human's approval or a process state."* Its *"Reopens if"* cell reads **Never** | `Decommissioned` and `Maintenance` are process states on the ordinary reading. This is not resolvable by wording. Either the enumeration is reframed as intent about the *estate* — which `11` §10.5's `Divergent` already models, and which is a defensible reading of "we intend to retire this" — or `N-R-3` is amended via `03` §10.1. **The two framings produce different fields**, so nobody should add the field before this is settled |
| 3 | **`03` §4.2 `N-R-2`'s test must be checked.** *"no field in the workspace format asserts currency or authority; provenance records how and when a value arrived, never that it is correct now."* Also `Reopens if: Never` | `Decommissioned` asserts something is currently true of the world. The honest counter is that `absent_since` and `Divergent` already do exactly this. Either the boundary is already bent and should be restated, or those two are distinguishable because they are *derived from a parse* while a lifecycle dropdown is *asserted by a human*. **That distinction is the thing to test**, and it is the difference between an amendment and a clarification |
| 4 | **`11`'s `notes` contradiction must be resolved** (§6.2 versus §13) | It decides whether a free-text user-attached carrier exists at all, and therefore what a lifecycle carrier would sit beside |
| 5 | **The node-attribute versus schema-field fork must be taken** (§3.4 row 1) | It decides rule visibility, inventory column generation, merge class and diff behaviour in one move. See §14 |
| 6 | **`11` §17 #4 must be re-answered for a second kind of annotation** | Its two stated reasons do not both carry over: *"a suppression targeting a tombstoned node has no clean lifecycle either way"* carries exactly; *"putting them in the graph makes merges manufacture waivers"* does not, because a lifecycle field is not a waiver. The answer may legitimately differ |

### 3.7 The premise that is false, and it is the useful finding

It is easy to assume the IR is a pure projection of parsed configuration and that a user-writable
layer would violate its premise. **It would not, and the corpus is unambiguous.**

- `11` §6.3 already carries `Site.criticality` (*"Used by rule severity weighting, not by emit"*),
  and the Emit `—` column exists precisely for *"annotation, inference or inventory only"*.
- `Origin::Hand` is a first-class provenance origin.
- `11` §10.5's `Divergent { since }` exists to model "intended but not deployed", and the document
  calls it a feature: *"Nautobot Golden Config's compliance diff obtained as a side effect of one
  schema."*

A user-writable, never-emitted layer exists today. The question C-01 raises is not whether such a
layer is permitted; it is whether *this particular* layer is a fact about the estate (`N-R-2`
permits it under §3.6 blocker 3's second reading) or a position in somebody's workflow (`N-R-3`
refuses it).

### 3.8 The completion action — a clarification that arrived after this entry was written

> **A STATE MACHINE DRIVEN BY A BUTTON, NOT BY A CLOCK. THE DIFFERENCE IS WHERE THE CLOCK IS READ**

From the owner, verbatim. The same sentence answers the date question in §4.4 and it is quoted
in both places rather than cross-referenced, because the two halves are read by different people:

> *"I like the decommission idea as long as it includes what I wanted and we don't need a now, we
> only need a date for when events need to happen. maybe a button to complete out that task, etc."*

**What it settles for C-01.** Lifecycle transitions are driven by an explicit user action. There is
no time-based expiry: nothing moves an element out of `Maintenance` because a window ended, and
nothing needs a scheduler to notice that it did. §4.4 problem four's fork — three answers to *"what
does an expired maintenance window do when the file is opened six months later?"* — is answered by
removing its premise. Nothing expires.

**The subtlety, and it is the whole of the finding.** A completion action stamps a date, and
stamping a date means reading a clock. That is not the thing invariant 9 forbids.

| | What is read | What it produces | Effect on invariant 9 |
|---|---|---|---|
| **A completion stamp** | The clock, **once**, at the moment of a user action | A stored value, written into the workspace as an ordinary op | **None.** The write changes the workspace, so it is a different workspace, and *"same workspace + same corpus version + same build"* is untouched |
| **A stored date compared at build** | The clock, **once per build**, against a stored date | A value baked into the built artifact | **None, and this row already ships.** Invariant 9's premise is *"same workspace + same corpus version + same **build**"*, so a value fixed at build time is constant across every render of that build. `15` §13.2's `Staleness` is exactly this shape — §4.4 works it through |
| **An expiry evaluated at render** | The clock, on **every** render | Nothing stored | **Breaks it.** One unchanged workspace renders differently on two different days |

The middle row is here because it is the shape a reader reaches for first and the two-row version of
this table had no cell for it. What the clarification rules out for lifecycle dates is the **render**-time
comparison, not date arithmetic as such.

**Checked against the corpus rather than asserted, because if the corpus forbade reading wall-clock
time anywhere the answer would be different.** It does not, and the scoping is explicit. `12` §3.4's
*"Deliberately absent"* table excludes `Timestamps / "now"` from the **`fex` grammar** — the rule
condition language — *"Non-deterministic by construction. Invariant 9. Rules that want 'this cert
expires soon' get an explicit workspace-supplied `workspace.as_of` date, which the export records."*
That is a prohibition on what a **rule may reference during evaluation**, not on what the product
may write.

**And the product already does exactly what the clarification describes, in a shipping type.**
`52` §6.2's `WalkthroughRun` carries `started_at: Timestamp`, every `AnswerRecord` carries
`at: Timestamp`, and `RunState` is `{ Active, Parked, Completed { at: Timestamp }, Abandoned }`.
**`RunState::Completed { at }` is literally a "complete out that task" state with a stamped date**,
already specified, already merged as ordinary ops (`52` §6.2's own comment: *"Written as ordinary
ops (`33` §5.1), so it syncs and merges"*).

**RECOMMENDATION — cite `RunState` as the precedent for the *shape*, and do not reach for it as the
*home*.** It is per-**run** and keyed to a `TaskId`; lifecycle is per-**element** and keyed to an
`ElementId`. The transferable part is the pattern — an explicit terminal state carrying the moment
it was entered — and §3.5's warning applies again: reuse the mechanism, do not let the resemblance
carry into semantics.

**Three things this clarification does not settle, recorded so nobody reads it as more than it is.**

| Still open | Why the clarification does not reach it |
|---|---|
| **The enumeration** | A transition mechanism is not a state list. The owner said *"etc"* in §3.1 and *"etc"* again here. §3.3's Question B stands unchanged |
| **`03` §4.3 `N-R-3`** | §3.6 blocker 2 asks whether a lifecycle value is a *process state*. A **button that completes a task** is, if anything, the more process-shaped reading of the two, not the less. This clarification makes blocker 2 harder to clear, not easier, and that should be said plainly rather than discovered during the review |
| **The inverse** | §5.5 records that `Op::Untombstone` does not exist and that `53` §16 calls it *"a required addition"*. Un-completing a completed transition is the same missing op seen from a second direction |

**One consequence that is an improvement, and it is worth recording as such.** §13 row 15 prices a
*time-derived* state against `12` §6.6's incrementality proof: such a state changes with no graph
delta, invalidates no dependency key, and is therefore never re-evaluated — *"an element stays in
maintenance forever"*. A completion **action** produces an op, an op produces a delta, and a delta
invalidates. The clarification does not weaken row 15; it removes lifecycle from the set of things
that trip it.

---

## 4. C-02 — Ticket reference and date annotation

*margin tab: (a) is free, (b) is refused*

> **MOST OF THE VALUE IS IN THE PART THAT NEEDS NO INVARIANT CHANGE**

### 4.1 The split, and why it is most of the value here

The request "attach a ticket to an element" is two entirely different features that share a
noun. Separating them is the single most useful thing this entry does.

| | **C-02a — a ticket reference as inert data** | **C-02b — a live integration** |
|---|---|---|
| What happens | The user types `CHG0041234`. It is a string in the workspace. It is displayed, searched, exported, and included in a pasted change block | Fetch ticket status, post back, validate that the ticket exists, sync a maintenance window |
| Egress | **None.** Nothing fetches anything | Required, to an origin holding an API token |
| Invariants touched | **None found.** See §4.2 | 1 and 3, simultaneously |
| Status | Intent recorded | **NOT APPROVED — §6** |

**The practical value is overwhelmingly in (a).** That may change how the deferral reads.

### 4.2 (a) verified against the documents, not asserted

The claim that a stored ticket string touches no invariant is checkable. **Four tests were run and
they are named, so that the result reads as a result rather than as a clean bill.** Tests that were
not run are listed at the end of this subsection.

**One — it passes `03` §5.1's scope rule.** The rule is:

> *"A feature is in scope if and only if it is a pure projection of the workspace and the corpus,
> and it requires no capability the application does not already have."*

with the capability closure `{ read_workspace, read_corpus, read_user_text, write_workspace,
write_clipboard, write_screen }`. A stored ticket string is a projection of `user_input`, and its
capabilities are a subset of that closure. `03` §5.2's table shows ticketing failing on *capability
(egress)* and *projection (approval is a fact about people)*. **A string does neither.**

**Two — it is already shipping, in four places nobody flagged.**

| Where | The text in the corpus today |
|---|---|
| `54` §14, the suppression record's anatomy | *"Peer is a 2015-vintage ASA that negotiates group2 only. Ticket NET-4471."* |
| `17` §15.5, the plaintext export header | `# reason "Handover pack for the DC-EAST migration review, CHG-2026-0211"` |
| `34` §6.3, the clipboard payload | `# Fathom — change block for CHG-2026-0211` |
| `37` §2, the proposed privacy rule's own remediation | `set interfaces ge-0/0/0 unit 0 description "CKT-44812 — see CMDB"` |

The last one is the interesting one: the corpus already tells users to put a reference ID where a
person's name was. Giving that string a typed home makes an existing recommendation first-class.

**Three — it is probably a privacy improvement.** `37` §2.2 row 8 names free-text `description`
fields as *"routinely yes, and this is the number one channel"* for personal data. A structured
ticket field is a place for the reference that is not a free-text field.

**Four — `03` §4.3 `N-R-3`'s review rule, run explicitly rather than skipped.** §3.6 blocker 2
applies this test to C-01, and it must be applied here too or the asymmetry is just an oversight.
The rule reads:

> *"Review rule: no workspace field represents a human's approval or a process state."*

and `N-R-3`'s *"Also refused"* row sharpens it: *"Approval state inside the workspace — 'this
change is approved by X'. That is an assertion about a human process the tool cannot verify, stored
somewhere it can be edited."*

**The result: C-02a passes, and the reasoning is the load-bearing part.** A change-ticket number is
an *identifier* — a pointer into a workflow system — not an assertion about that workflow's state.
`CHG0041234` claims that a ticket with that name exists somewhere; it does not claim the change is
approved, scheduled, or complete. `N-R-3` refuses fields that assert *"this change is approved by
X"*; a bare reference asserts nothing the tool would have to verify.

**Two things that would flip this result**, recorded because the pass is narrow:

| If C-02a gained… | It fails `N-R-3` |
|---|---|
| A **status** alongside the reference — `CHG0041234 · approved`, or any enum tracking where the ticket is in someone's workflow | That is process state verbatim, and it is what C-02b (§4.1) would fetch. The refusal of C-02b and this test are the same refusal seen from two directions |
| A **validity** claim — the field asserting the ticket exists or is open | Unverifiable without egress, so it would be an assertion the tool cannot check, stored somewhere it can be edited |

**What was not tested.** `03` §4.2 `N-R-2` (*"no field asserts currency or authority"*) is not run
here. A bare reference makes no currency claim, so it looks clean, but §3.6 blocker 3 shows the
parsed-versus-asserted distinction is contested for C-01 and the same argument has not been walked
through for C-02a. The dates half of C-02 (§4.4) is where `N-R-2` actually bites, and §4.4 treats
it there.

**One new obligation follows from the tests above**, and calling it *the* one would overclaim,
since §4.3's attach table names two more: a row in `37` §2.2's inventory with a verdict, because
that table is the one handed to a DPO and it is complete by construction.

### 4.3 Where C-02a would attach

| Document | Section | What would change |
|---|---|---|
| `11` | §4.3 | **The fork Q14 asks, and this register does not take it.** §4.3's scalar catalogue marks `Text` as the only free-string type, scoped to *"descriptions and notes only"*, and §12.4 bans `Text` from the extension bag because it is how the bag becomes a back door. So a ticket reference is either `Text` — accepting a scope `11` §4.3 words narrowly — or a new pattern-constrained scalar in the catalogue. **Neither is chosen here, and no type is named**; naming one would be `11` and `62`'s job under §1.2. The trade: a constrained scalar validates and makes the field searchable as a reference, and it hardcodes one organisation's ticket grammar into a schema shipped to everyone — `CHG0041234`, `NET-4471`, `CKT-44812` and `CHG-2026-0211` all appear in the corpus today (§4.2) and no single pattern matches all four. `Text` accepts anything, including the free-text personal data `37` §2.2 row 8 warns about, which is the improvement §4.2 test three claims |
| `12` | §11.1 | **Nothing needs to change for suppressions to carry a ticket today.** `54` §14 already quotes one inside `reason` |
| `17` | §15.2, §15.5 | A structured field would appear in `csv`, `fathom-json` and `review` exports. `review` is *"the most dangerous artifact"* (`17` §15.5), so a lifecycle-plus-ticket column joins that artefact |
| `18` | §6.2 | Would appear in the change ticket. Note the resulting shape: a populated *what changes* section and an **empty** config section, because the field emits nothing. That is honest and it is a new ticket shape |
| `34` | §6.3 | Nothing. The ticket string is already a first-class part of the clipboard payload |
| `34` | **§5.1, §5.5** | **The two places a new user-typed string actually lands, and neither is free.** §5.1's source table classes U3 — *"User-typed values — names, descriptions, suppression reasons, export reasons"* — as *"none, treated as U2"*, meaning a ticket reference is untrusted text on the same footing as a pasted config, and U3's *"Reaches"* cell already names the export header (`17` §15.5). §5.5 then governs bidi controls, zero-width characters, tag characters, homoglyphs and control characters **per path**, with three different behaviours — sentinel badges when displaying a raw capture, normalise-and-record when ingesting into the graph, and cannot-arise on emit. A ticket reference joins two paths this register's own §4.3 table names: `34` §6.3's clipboard payload and `17` §15.5's export header. Which of §5.5's three behaviours a user-typed reference gets is not obvious — it is neither a raw capture nor an emitted line — and §5.5's governing rule is *"never silently alter text the user will paste into a device"* |
| `37` | §2.2 | One row, with a verdict |

**One thing that is already decided and should not be rediscovered:** a ticket reference cannot be
a link. `34` §9.4 is unambiguous — *"the application renders no clickable external link, in any
surface, ever"* — because a navigation is not a fetch and therefore survives `connect-src`
(`34` §9.4 reason 2, citing `23` §6.3's channel C3). `CHG-2026-0211` in an inventory cell is a
string you copy. Some users will read it as a broken link. That is the cost, and `34` §9.4 already
paid it deliberately for citations.

### 4.4 The date question, answered — and the divergence that answer creates

*This was the sharpest open problem in the register. It is closed, and none of it was about tickets.*

> **THE PRODUCT NEEDS NO CONCEPT OF THE CURRENT TIME. A DATE IS A STORED VALUE**

**An earlier draft of this subsection set the date question out as an open fork with three
answers.** The owner has answered it. Verbatim, and the same sentence that supplies §3.8's
completion action:

> *"I like the decommission idea as long as it includes what I wanted and we don't need a now, we
> only need a date for when events need to happen. maybe a button to complete out that task, etc."*

**The operative reading.** A date is a stored value: written, displayed, sorted, exported. It is
never compared against a clock. Nothing computes *overdue*. There is no scheduler, no background
process, and no expiry evaluated at render time. The determinism half of invariant 9 is therefore
untouched by this whole entry: **the same workspace renders identically forever**, because nothing
about the rendering depends on when the file was opened.

**The precedent is already in the corpus and already shipping.** ADR-0027 item 3 makes the
verification stamp *"chrome, not metadata"* — every finder row, every explainer header and every
emitted line's explainer carries, in muted mono:

```
junos-srx 21.4R3 · verified 2026-05-12 · K. Okafor
```

The stamp is a stored date rendered as text, and **the rendering evaluates nothing**: no branch in
the product asks how old `2026-05-12` is before drawing it. It is exactly the shape the owner
described, and it is already on every row of the v1 product.

**The `Staleness` value shown alongside it is a different shape, it reads the same underlying date,
and an earlier draft of this subsection described it wrongly.** That draft said `Staleness` is
derived from platform versions and *"not from its date against a clock"*. It is derived from both.
ADR-0027 item 4 derives and shows `Staleness` *"per `15` §13.2"* — item 4's own text — and `15`
§13.2's definition has two **disjunctive** limbs, only one of which is about versions:

> `Aging` — *"> 18 months since verification, **or** ≥ 2 vendor majors behind."*
>
> `Stale` — *"> 36 months, **or** explicitly contradicted by a newer verification."*

The months-elapsed limb is a date comparison, it runs against `verified_against` — which `15` §6.2
types as a *"list of `{platform, version, on}`"*, so it carries a date — and it changes what is
displayed: `15` §3.4's filter table drops a `Stale` entry **from the spine** and tags an `Aging` one
with the margin tab `unverified since <ver>`. `15` §7.2's re-review triggers add a second
elapsed-date gate on the same field — *"`verified_against` newest entry > 24 months old | build
warning, then error at 36"*. So the corpus does compare a stored date against a clock, in a way that
changes output.

**What keeps that inside invariant 9 is *when* the comparison happens, not what it compares.**
`15` §13.2's own sentence is *"Computed at build from `verified_against` and the release calendar.
Never stored by hand."* Invariant 9's premise is *"same workspace + same corpus version + same
**build**"*, so a value fixed at build time is constant across every render of that build and the
same workspace opened on two different days still renders identically. **This is the third row of
§3.8's table, not a counterexample to it**, and the distinction it draws is render-time versus
build-time — not dates versus versions.

**Why that matters for C-01 and C-02 rather than being trivia.** It removes an argument nobody
should make: *the corpus already compares dates, so a lifecycle expiry may too*. `Staleness` compares
dates over **corpus** content, at build, where the result is frozen into the artifact alongside the
corpus version invariant 9 already names as a premise. A lifecycle date is **workspace** content,
which no build sees. The precedent therefore transfers to nothing in C-01 or C-02, and the owner's
answer at Q9 (§14) — dates are stored values, never compared — is not narrowed by it.

#### Two consequences, and the second is a divergence that must be recorded rather than resolved

**One — sorting and filtering survive; the overdue view does not.** A total order over stored values
is deterministic, so *sort by date ascending*, *filter to a range* and *export in date order* all
work and all reproduce. What is lost is *"show me everything overdue"*, which cannot be computed
without a now. **Sort ascending recovers most of that value and it does not lie when the file is
opened eleven months later**, which the overdue view would.

**Two — this diverges from `54` §14, deliberately, and the divergence is now on the record.**
`54` §14's third non-negotiable for the suppression record reads:

> *"**Expiry is a countdown, not a date.** `expires 2026-11-02` is a fact; `in 97 days` is the thing
> that changes behaviour. Both are shown; the countdown is the margin tab, so it reads as the
> weighting it is."*

A countdown needs a reference date to count from. `54` §14 names it precisely — *"Expired is not a
`ReviewState` in the type; it is derived from `expires` vs `workspace.as_of`"* — so the reference is
a workspace-supplied constant rather than the system clock, which is why `54` §14 is consistent with
`12` §3.4 today. Lifecycle dates under this clarification are the opposite treatment: dates, never
countdowns, with no reference value at all.

> **TWO SURFACES, TWO TREATMENTS, ON PURPOSE. THIS REGISTER DOES NOT RESOLVE IT AND PROPOSES NO
> CHANGE TO `54` §14.** A suppression's expiry changes what the tool does — an expired suppression
> has stopped suppressing, and `54` §14 says a list that looks identical before and after that
> moment *"is a trap"*. A lifecycle date changes nothing by elapsing. The surfaces differ because
> the underlying facts differ, and flattening them to one rule would be a decision this document is
> not entitled to take (§1.2).

**One thing the divergence sharpens.** §19 item 4 records that `workspace.as_of` is used by four
documents and defined by none. After this clarification, **`54` §14's countdown is the only date
surface in this register's scope that still needs it.** That makes `as_of` a smaller blocker for
C-01 and C-02 — they no longer queue behind it — and exactly the same size of defect for `12`, `18`
and `54`. It stops being this register's problem without stopping being a problem.

#### What the answer does not touch

| Standing problem | State after the clarification |
|---|---|
| **`workspace.as_of` has no home** — referenced by `12` §3.6 item 4, `12` §3.4, `18` §6.4 and `54` §14; absent from `17` §10.1's `Settings`, from `17` §4.2's record taxonomy and from `11` | **Unchanged as a defect, removed as a blocker for this entry.** §19 item 4 and Q8 stand |
| **A time-derived state would break `12` §6.6's soundness argument** — the proof's step 2 requires a pure function of the values read, *"no side effects, no ambient state, no clock"* | **Dissolved for lifecycle**, because no state is derived from `(window_end, today)` any more. See §3.8's closing note and §13 row 15. The constraint stays; lifecycle stops tripping it |
| **Unrouted wall-clock already in the product** — `11` §8.7 bands node age from `max(asserted_at)` and `56` §8.1 renders those bands into the SVG, and neither document says what the comparison is against. `71` X4.1 requires *"same graph + same build ⇒ byte-identical SVG. No `HashMap` iteration, no wall-clock, no randomised seeds"*, and X4.7 requires the same of the diagram inside a change ticket | **Completely untouched, and this is the one to guard.** It was never caused by lifecycle dates and it is not fixed by removing them. Q10 and §19 item 3 stand exactly as written. A reader who takes "the date question is answered" to mean "the clock question is answered" has misread this subsection |

**One sub-question the clarification opens and does not close, recorded rather than answered.**
*"Nothing computes overdue"* is unambiguous about the clock. It is not obviously a statement about
`workspace.as_of`, and `12` §3.4 exists precisely to license the shape *"this cert expires soon"*
against a workspace-supplied date. So: **may a rule compare a stored lifecycle date against
`workspace.as_of` and fire a finding?** That is deterministic, it needs no clock, and it is the
mechanism `12` already sanctions — and it is also the closest thing to an overdue view, which is
what the owner said is not needed. New Q23 in §14. Not answered here.

#### The machinery that was already correct and stays correct

`12` §3.4 excludes timestamps and `now` from `fex` outright —
*"Non-deterministic by construction. Invariant 9"* — and routes time through `workspace.as_of`, a
workspace constant in the `fex` name environment (`12` §3.6 item 4). `18` §6.4 records `as_of` in
the change ticket. `12` §7.1 already lists *"suppression expiry rollover"* as a Tier C sweep
trigger. The machinery for offline, deterministic, date-sensitive evaluation is complete.

**None of that is disturbed by the clarification, and none of it is needed by C-02's dates.** The
machinery stands, unused by this entry, in service of the surfaces that do need a reference date —
`54` §14's countdown, and whatever answers Q23. **The register's earlier framing of this as an open
three-way fork is superseded**, and the fork's cost has moved to §15.2's row on time-derived state,
where it is priced as a constraint rather than as a live option.

**The one line from the superseded fork worth keeping**, because it is what makes the owner's answer
the right shape rather than merely the cheap one: the option in which nothing is evaluated at render
time is the only option that does not eventually need ADR-0002's amendment process, *whose own text
treats invariant 9's carve-out as a door to be kept shut*.

### 4.5 What must be decided first

1. `62-schema-spec.md` (ADR-0008), same as C-01.
2. ~~Where `workspace.as_of` lives, who sets it, whether it merges, and whether it advances on
   open.~~ **No longer a blocker for this entry**, per §4.4: a stored date needs no reference value.
   It remains a live defect owned by `12`, `18` and `54` §14 — §19 item 4, Q8 — and it is still
   upstream of Q23, which is the only date question this entry leaves open.
3. Whether `11` §8.7 and `56` §8.1's age bands compare against `as_of` or against the system clock.
   **Unchanged, and not fixed by §4.4.** It was never a lifecycle problem.
4. ~~Whether dates are asserted or derived.~~ **Answered by the owner — asserted, and never
   derived.** §4.4.
5. Whether the ticket reference is one per element or many. An element is touched by several
   tickets over its life. One field means overwriting history; many means a set-valued field,
   which means `33` §6.4 class E, OR-Set semantics and the `merge.set.widened` finding (`33` §6.8).

---

## 5. C-03 — Multi-select and bulk action as first-class

*margin tab: you select in order to act*

> **THE SELECTION TYPE CAN ALREADY EXPRESS A SET. THE PRODUCT HAS ALMOST NO VERB THAT CONSUMES ONE**

### 5.1 The owner's insight, which is the load-bearing part

> *"I just thought of a new reason we need to be able to select things."*

The realisation is correct and it is a category change, not an increment. `52` §5 specifies
selection **for reading**: every `Facet` variant — `Element`, `Field`, `Line`, `Finding`, `Span` —
answers "what am I looking at". Selecting in order to **act** is a different job. Nobody
decommissions one interface, so lifecycle and ticket annotation are applied to sets by default,
not exceptionally.

**That makes multi-select and bulk action first-class rather than optional**, and it changes the
value side of `52` §12 D3's trade without touching the risk side.

### 5.2 What already exists — more than expected

| Already specified | Where |
|---|---|
| `Selection` carries `set: BTreeSet<ElementId>` plus a distinct `anchor`, ordered by `ElementId` so ordering never depends on click order | `52` §5.1 |
| Multi-select gestures per view, including the deliberate refusal of cross-view range select (*"a range from a config line to an inventory row is a question with no answer"*) | `52` §5.4 |
| The safety furniture for an invisible selection: `OffscreenReason::FilteredOut` rendered as `3 of 11 selected are filtered out`, and the written requirement that *"bulk edits name the full count in their confirm text"* | `52` §5.8 row 5 |
| Selection narrows implicitly and never widens implicitly — selecting a `Device` does not select its 830-node closure | `52` §5.2, §5.8 row 4 |
| Undo granularity for a bulk edit: eleven inventory rows are **1** transaction, *"and the label says `dpd on 11 gateways`"* | `53` §7.2 |
| Inventory as the named home for bulk editing | `52` §3.7 |

**The hardest UX problem in bulk action — you selected eleven and can only see eight — is already
designed.** The gap is entirely on the verb side.

### 5.3 What is missing

**A type-level gap that exists today, before any new capability is added.** `53` §7.2's granularity
table prices eleven bulk-edited rows as one transaction labelled `dpd on 11 gateways`, and §7.3
lists bulk edit as undoable. But `TxSource::Field { field: FieldRef }` names exactly one
`FieldRef`. **The type and the two tables disagree now.** A variant that can represent a bulk edit
is required before any bulk write is undoable.

**Every graph-writing verb in `53` is single-target by construction.** `⇧D` is *"Tombstone the
selected **node**"*, singular. `53` §3.6 excludes anything that writes the graph from `.` repeat,
with a stated reason — *"a repeat that mutates the graph is a repeat that mutates the wrong node
the first time somebody mis-focuses"* — which applies with more force to a set of eleven, not
less. `53` §3.8's destructive gate is `⇧P`-style type-to-confirm-the-name, which has no obvious
set form: type-to-confirm *what*, when the target is eleven things?

**`33` §7.4 constrains every bulk action in the product**, and it is a structural requirement
rather than a review note:

> *"If a bulk action is unavoidable for class B, it must be scoped to class B by construction and
> must not be reachable from a screen showing class A conflicts."*

Inventory shows every field class. A bulk lifecycle action reachable from inventory has to satisfy
that by construction.

**Selection propagation is unbudgeted.** `52` §5.6.3 proposed S1–S5 and `52` §14 formally asked
`44` §3 to adopt them. `44` §3 does not contain them. A bulk *write* across a selection has no
budget at all — no counter gate, no P95, no hard fail — and `44` §7.2 already names
`Population(kind)` invalidation as `O(N²)` over a bulk import, which is the adjacent measured
hazard.

### 5.4 `52` §12 D3 must be re-argued, and this request is the evidence

D3 reads: *"Whether inventory bulk-edit is in v1 at all"*, with the lean recorded as

> *"Leaning (b) for the first release. The failure mode of a bad bulk edit across a sync merge is
> unpleasant and `53` §7's undo cannot fully repair it."*

**That argument was made when bulk edit was a convenience** — the example in `52` §3.7 is setting
`dpd` on eleven gateways. C-01 and C-02 make it the primary application path for a whole class of
annotation. The value side of the trade changes; the risk side does not.

Two things worth recording alongside, per §2:

- **D3's merge half is not defused, and an earlier draft of this section said it was.** The claim
  was that ADR-0016 removes the risk for phases 0–3 because git is the sync and there is no CRDT.
  ADR-0016 refutes it directly: git *is* the merge, and its own "not this" table reads *"A git
  merge conflict on a record is opened in the application with the passphrase and merged on
  plaintext by `11` §8.6."* `17` §12.4 gives the mechanism, `fathom merge --resolve`, which
  *"merges values per `11-ir-schema.md` §8.6"* — **per field**. D3's stated failure mode is *"a
  bad bulk edit across a sync merge"*, and a git pull is a sync merge. What ADR-0016 removes is
  concurrent multi-writer convergence; what it leaves in place is exactly the two-clone,
  diverged-workspace case D3 names. **The risk side of D3's trade is unchanged, from phase 0.**
- D3's other half — that `53` §7's undo cannot fully repair a bad bulk edit — survives intact and
  is §5.5.

**So the change C-01 and C-02 make to D3 is one-sided.** The value side rises, because bulk
annotation becomes the primary application path rather than a convenience. The risk side does not
fall. That makes D3 harder to answer than the current lean assumes, not easier — which is the
opposite of what the earlier draft implied, and it is worth stating plainly because the earlier
draft's error pointed the reader toward flipping D3.

**This register does not answer D3.** It records that the request is direct evidence against the
current lean, and that D3 is now load-bearing rather than academic.

### 5.5 The undo problem, honestly

`53` §7.5's staleness rule: *"An undo whose target has changed since the transaction is not
applied. It is reported and skipped."* Partial undo is permitted and reported.

Applied to a bulk decommission across a merge, that leaves the estate in a mixed state: some
elements restored, some still decommissioned. `53` §7.4 makes undo an *edit* — it appends
compensating ops and shows up in provenance, the diff and a colleague's sync — so a partially
undone bulk decommission is a permanent, visible, half-finished record. And if lifecycle drives
emit (§13 row 4), the next change set generates deletes for the elements that were not restored.

Separately: **`Op::Untombstone` does not exist.** `53` §16 raises it formally as *"a required
addition"* to `33` §5.1, noting that without it *"undoing a deletion is not expressible as a
compensating op"*. Any lifecycle transition needs its inverse defined in the op model before a
bulk verb can write it.

### 5.6 What must be decided first

1. `52` §12 D3 — is bulk edit in scope at all (§5.4).
2. A `TxSource` variant that can represent a bulk edit (§5.3).
3. `Op::Untombstone`, or whatever inverse a lifecycle transition needs (`53` §16).
4. The gate: does a bulk lifecycle change get `⇧D`-style plain confirm or `⇧P`-style
   type-to-confirm-plus-reason, and what does type-to-confirm mean for a set (`53` §3.8)?
5. How `33` §7.4 is satisfied structurally from a screen that shows every field class.
6. Whether `44` §3 adopts S1–S5, and what a bulk-write budget would even be measured against.

---

## 6. C-04 — Integration hooks to ticketing and change management

*margin tab: not approved*

> **NOT APPROVED. NOT SCHEDULED. NOT DESIGNED. RECORDED HERE ONLY SO THAT THE REFUSAL IS FINDABLE**

### 6.1 What the owner said, and its exact status

> *"if you can also plan to tie in hooks for those one day, though for security reasons not today."*

The owner is right that this is a security question and right to defer it. **What this register
must add is that it is not merely deferred.** `03` §4.3 `N-R-3` refuses it, and its
*"Reopens if"* cell reads **Never**. Its *"adjacent thing we REFUSE"* row is the request almost
verbatim:

> *"Push the change record into Jira/ServiceNow when the user clicks Submit. Egress, a credential,
> and the moment Fathom writes into a workflow system it owns a workflow."*

Recording the owner's deferral honestly means recording that it currently sits behind a written
`Never`.

### 6.2 What it breaks

A ticketing integration is an outbound connection to a system that holds an API token.

| Broken | Text |
|---|---|
| **Invariant 1** | *"No egress by default. The application never opens a connection the user did not configure."* `connect-src` is `'none'` in the offline build |
| **Invariant 3** | *"The application never accepts a credential."* `03` §3.2 `N-P-2` names API tokens in its refused list explicitly |
| `03` §4.3 `N-R-3` | Refused, `Reopens if: Never` |
| `03` §5.2 | Ticketing fails the scope rule on two clauses at once: *capability (egress)* and *projection (approval is a fact about people)* |
| `73` §9's no-list | *"No egress by default; no telemetry, no analytics, no font CDN, no error reporting."* §9's preamble is the relevant sentence: *"A future document proposing any of them is proposing a different product and should say so."* |

The owner has separately and emphatically confirmed the position in conversation: Fathom *"will
not connect to anything ever."*

### 6.3 The three ship gates it defeats

This is the part that makes C-04 different in kind from an ordinary deferral. **It is not blocked
by scheduling. Its arrival requires deleting three build gates.**

| Gate | What it does | Where |
|---|---|---|
| **X0.8** | Asserts the shipped artifact's CSP contains `connect-src 'none'` — **against the final bytes, not the template** | `71` §3.6, run by `xtask assemble` |
| **X0.9** | Fails the build if any network request is issued in a 30-minute scripted session, verified by a proxy that fails the test on any connection attempt | `71` §3.6, e2e nightly |
| **H39** | Runs `wasm-objdump -x`, reads the WASM import section and asserts every entry against a committed allowlist, with the rule *"No import may be capable of originating a network request"* — the check `34` calls *"the check that makes `connect-src 'none'` an architectural property rather than a header"*, made CI by `31` §12 | `34` §7.5, §10 |

A live ticketing integration cannot coexist with any of the three.

**Two further structural facts, recorded so nobody discovers them late.** `43` §3's D1 — the
single offline file — has no origin and no server; a hook cannot exist there at all, so C-04 would
be the first capability that splits the product by deployment mode. And it would be the first
outbound path carrying graph-derived content, which puts it under `23`'s exfiltration frame and
`17` §15's plaintext gate rather than under "a feature".

### 6.4 An adjacent pattern the corpus already accepts — recorded, not proposed

> **THIS IS NOT AN ALTERNATIVE ROUTE TO C-04. NOTHING HERE IS APPROVED, AND NOTHING HERE IS A PLAN.**
> A reader who arrived at §6 looking for "what can we do instead" should stop at §6.2. This
> subsection exists for one reason: so that whoever reopens the hook question discovers, at the
> same moment they discover the refusal, that a different and already-accepted pattern exists — and
> does not mistake this section for permission to build it.

**An export the user's own tooling posts is not egress by Fathom.** The pattern is already argued
and accepted in the corpus, on data the project cared about enough to have wanted telemetry for:

> `16` §3.6, on the finder's miss log: *"Never transmitted (invariant 1). Exporting it is an
> explicit menu action producing a file the user reads before sending."*

`71` §13.2 states the general rule in the SNMP/LLDP row: the only legitimate form of a forbidden
integration is *"a **separate** tool that emits a paste-able file. Trigger: someone building that
tool, not us."*

The machinery for the ticketing case largely exists:

| Piece | Where | Status |
|---|---|---|
| A machine-readable change record that leaves the product and can come back — a YAML sidecar sharing a `content_hash` with the plain-text ticket, re-importable, re-verifiable against a later graph, diffable between revisions | `18` §6.3–6.4 | Specified; `71` §6.6 prices *"change ticket and its reproducibility"* at 1–1.5 solo weeks, already inside phase 3 |
| The clipboard as the delivery mechanism, with a ticket reference already in the header | `34` §6.3 | Ships |
| The plaintext export gate, if the artefact is more than a clipboard paste | `17` §15.3 | Specified |

**What this is and is not.** Every piece named above is already specified elsewhere — `18` §6.3–6.4,
`34` §6.3, `17` §15.3 — so this subsection invents nothing. That is precisely why it is *not* a
proposal: assembling specified pieces into a named capability is a decision, and §1.2 forbids this
document from making one.

Three things are recorded, and no more:

| Recorded | Not recorded |
|---|---|
| The pieces exist and are separately specified | That they should be assembled |
| An export the user posts is not egress by Fathom, per `16` §3.6 and `71` §13.2's SNMP/LLDP row | That this satisfies the owner's request. **The owner asked for hooks. An export is not a hook**, and calling it "the answer" would be answering on the owner's behalf |
| `71` §13.2's trigger for the legitimate form is *"someone building that tool, not us"* | Anything about who builds it, or when |

Whether the pieces should be assembled, whether that would satisfy what the owner actually wanted,
and whether `03` §5.1 clears the assembled thing rather than each piece separately, are all open.
**Nobody should build anything from this document.**

### 6.5 What would un-defer it, stated so the cost is visible

`03` §10.2 places `N-P` boundaries outside what any governance body may authorise, and §10.3 gives
the only route:

| Step | |
|---|---|
| 1 | A decision record arguing the change, with the threat-model delta explicit (`31`) |
| 2 | **A new name** (`74` §12), because users who trusted the old guarantee must not be silently moved onto a new one |
| 3 | A migration path that lets a user keep the old artifact working |
| 4 | The old artifact remains published, with its hashes, indefinitely |

`03` §10.3: *"Step 2 is the real cost and it is deliberate. A rename discards the accumulated
trust, which is exactly the price that should be paid for discarding the property that earned
it."*

**Nothing in this section is a plan. C-04 exists in this register so that the refusal is findable
by whoever asks next, and so that §6.4's alternative is found at the same time.**

---

## 7. C-05 — Config backup and restore

*margin tab: copy paste, copy and paste*

> **FATHOM NEVER FETCHES A BACKUP. THE USER RUNS THE COMMAND AND PASTES THE OUTPUT BACK.
> THE ENGINEERING IS MOSTLY BUILT. THE REFUSAL IS THE PROBLEM**

### 7.1 What is wanted

From the owner, verbatim:

> *"oh! maybe we can have config backups and such as well. of course the whole thing is to allow
> for you to learn but also copy the commands used to back it up and such and that way it's a copy
> paste copy and paste."*

**The load-bearing part is "copy paste copy and paste", not "backup".** The request is not for a
collector. It is for the existing paste loop, run twice, with teaching on both ends:

| # | Step | Who acts | Egress |
|---|---|---|---|
| 1 | Fathom teaches the backup command and why that form of it is the right one | Fathom | none |
| 2 | The user runs it on the box | the user, in their own terminal | none by Fathom — invariant 2 is untouched |
| 3 | The user pastes the output back | the user | none |
| 4 | Fathom stores it as a snapshot and diffs it against the previous one | Fathom | none |
| 5 | Fathom hands back the restore commands to copy | Fathom | none |

Every step is inside `03` §5.1's capability closure — `{ read_workspace, read_corpus,
read_user_text, write_workspace, write_clipboard, write_screen }`. **No invariant-1 or invariant-2
question arises anywhere in the loop**, which is what makes the refusal in §7.2 surprising rather
than obvious.

### 7.2 The capability is refused by name, and that is the first fact about it

> **`03` §4.10 IS TITLED *"NOT A CONFIG BACKUP OR ARCHIVE"*. IT IS `Refused` IN THE §2 REGISTER**

| `N-R-10` field | Text |
|---|---|
| **What it would look like** | *"Scheduled config collection, versioned history per device, restore"* |
| **Why refused** | *"Collection is `N-P-1`. Long-horizon storage of every device's full config makes the workspace an archive of the estate's most sensitive material, which raises the impact of an endpoint compromise well past what `31` assumes"* |
| **The adjacent thing we REFUSE** | *"Keep the original pasted config text in the workspace so we can re-parse it later. Reasonable, and refused: it converts the workspace from a graph into a config archive, multiplies its plaintext-equivalent value, and undermines the redaction in `T-P2-c` by keeping the pre-redaction text"* |
| **The test** | *"Workspace format review: no field stores raw device configuration text beyond the current parse session"* |
| **Reopens if** | *"A user-initiated, explicitly-labelled attachment is a §10 amendment, not a default"* |

Two things follow, and they point in opposite directions.

**One — the refusal's "What it would look like" row does not describe this request.** *Scheduled*
collection is `N-P-1` and nothing here is scheduled; the user runs a command by hand. Half of the
row is a description of Oxidized, which `N-R-10`'s *"Use instead"* row names.

**Two — the "adjacent thing we REFUSE" row describes it almost exactly.** *"Keep the original
pasted config text in the workspace so we can re-parse it later"* is step 4 of §7.1's loop in the
refusal's own words.

**The one door is `Reopens if`, and it is narrow but it is the owner's framing.** *"A user-initiated,
explicitly-labelled attachment"* — user-initiated is exactly what "copy paste copy and paste" means.
But that cell says a **§10 amendment**, which means `03` §10.1's procedure: an issue titled with the
boundary ID arguing why the boundary is *wrong* rather than why the feature is useful (*"usefulness
is assumed"*), a statement of which `03` §5.1 clause the proposal satisfies, two maintainers
agreeing, a record in `90-decisions/`, and the amendment landing *"in the same PR as the first line
of implementation, never later"*.

> **THIS IS A BOUNDARY CONVERSATION, NOT A FEATURE CONVERSATION.** It is not blocked by schema, by
> phase or by effort. Nothing in §7.4 can be built until `N-R-10` is retired or clarified through
> `03` §10.1, and this register cannot do either.

### 7.3 `N-R-10`'s test already contradicts four core documents, today, before this capability

**This is the most useful thing in the entry and it is not caused by the owner's request.**
`N-R-10`'s test reads *"no field stores raw device configuration text beyond the current parse
session"*. Four documents already specify a field that does.

| Document | What it specifies |
|---|---|
| `11` §8.4 | `Capture` carries `text: Arc<str>` — the comment in the corpus is *"the whole capture, once, redacted"* — alongside `taken_at`, `device`, `scope`, `platform`, `command` and `digest` |
| `17` §4.2 | Record class `0x13` is `Capture`, *"one per capture"*, *"One redacted capture blob"*, and its rewrite column reads *"Never after creation (§4.5)"* |
| `17` §4.5 | *"Captures are a different animal"* — write-once, content-addressed, never edited |
| `17` §13.1 | Budgets captures at **~38 KB sealed per device** against ~220 KB of text at ~6× compression, in a per-device table |
| `37` §2.2 row 20 | Lists *"Captures — raw pasted configuration"*, *"the text as pasted"*, in the personal-data inventory handed to a DPO |

**Two readings, and they give opposite answers for this capability.**

| Reading | What `N-R-10`'s test means | Consequence |
|---|---|---|
| **Literal** | No raw configuration text is stored at all | `11` §8.4 is already a violation and has been since it was written. C-05 makes an existing breach larger rather than creating a new one |
| **Narrow** | No **pre-redaction** raw text is stored | The refusal's own *"Why refused"* clause supports it — *"by keeping the pre-redaction text"* — and `14` §9's ingest gate already satisfies the boundary, in which case a snapshot may be in scope today |

**Nothing in the corpus picks a reading, and nobody has noticed the collision.** `N-R-10` is cited by
**no other document in this repository** — not by `11`, not by `14`, not by `17`, not by `37`, not by
any review document in `80-review/`, and by no ADR. Its only two appearances are its own row in
`03` §2 and its own subsection at `03` §4.10.

**RECOMMENDATION — settle the reading before anything else in this entry is discussed, and settle it
as a clarification to `03` if the narrow reading is right.** Under the narrow reading much of §7.4
is already licensed and the argument is about *volume and series*, not about storing text at all;
under the literal reading `11` §8.4 is a live boundary breach that a reviewer will eventually find
on their own. These are different conversations and running them together will produce a decision
about a capability when the disagreement is about a sentence.

### 7.4 What already exists — and it is nearly all of the engineering

| Part | Where | How complete |
|---|---|---|
| **Config diff** — the smallest ordered set of pasteable lines that moves a device from A to B | `18` §3: `config_diff(A, B, plat, gd)`, the `lower` op table (§3.4), `subsume` deletion minimisation (§3.5), ordered-list LCS repair (§3.6), and the D1 runtime self-check (§3.8) | Specified as an implementable algorithm, including the `Accumulating` trap in §3.4. **But it is a diff of two *emits* derived from two *graphs***, and `18` §2.1 rejects text diff outright |
| **Rollback generation, line by line** | `18` §5: `fn rollback(gd: &GraphDiff, la: &LineIndex, lb: &LineIndex, plat: &dyn Platform)`, §5.2's inverse table, §5.3's `BaseUnknown`, §5.6's per-platform `GuardPolicy` | More complete than expected. `RollbackConfidence` is the **minimum** over lines, not the average (§5.1), and `18` §6.2 makes the caveat sections unsuppressible — *"There is no brief mode that drops the caveats, because a brief mode that drops the caveats is the mode everybody would use."* |
| **The platform's own restore command, needing no graph** | `18` §5.1's `platform_fallback`, §5.6's `GuardPolicy`, and §7.5's rendered block | Ships in every Junos ticket already: *"Authoritative alternative on this platform: `rollback 1` / `commit`. The previous committed configuration is on the box. Prefer it unless other commits have landed since."* **The corpus has no `rollback` entry to look it up from** (§7.8) |
| **Whole-configuration ingest** | `11` §10.5's `CaptureScope { Whole, Section, Fragment }`; `14` §7.4 computes scope from parse evidence rather than asking the user | Whole-config ingest is the **primary** case, not an extension. `Whole` is what licenses asserting `Absent` (`11` §8.5), which is what makes a rule like `ipsec.pfs.absent` trustworthy |
| **A stored snapshot as a record class** | `11` §8.4's `Capture`; `17` §4.2 class `0x13`; §4.5's write-once content-addressed store | Complete, and `Capture.command` — worked value `"show configuration \| display set"` — is already the join between a taught backup command and its stored output. `17` §5.8 compresses capture bodies before sealing, *"yes, and it is the biggest win"*, 5–10× |
| **The size of storing several** | `17` §13.1's per-device table | ~38 KB sealed per capture against roughly half a megabyte for a fully parsed device. **Quoted with `17`'s own caveat attached**: §13 is *"arithmetic over the assumptions declared in `11-ir-schema.md` §14.2, not measurement"*, it carries an explicit `VERIFY` against a real SRX345 capture, and *"No number below may appear in user-facing material until it has been measured"* — plus a recomputation pending against ADR-0012/0013 |
| **Diffing a fresh paste against the workspace** | `18` §2.2's tier-2 natural-key matching names *"comparing the workspace against a freshly pasted `show configuration \| display set`"* as one of three reasons it exists; `14` §10.3's `ReconciliationPlan` | The machinery is there. `14` §10.3's **DECISION** is that a plan is auto-applied only when purely additive; everything else is presented as a diff and applied on confirmation. What is missing is the decision to make it a first-class mode — `18` OD-1 |
| **A pasted config containing a credential** | `14` §9's ingest gate, its path catalogue and its value-shape detectors; ADR-0002 | Handled structurally rather than by policy. See §7.6 — it is not clean |

**The honest summary: the expensive machinery for C-05 is specified and phase-3-scheduled for other
reasons.** What C-05 adds is not an engine. It is a boundary retirement (§7.2), a naming decision
(§7.9), and a block of corpus authoring (§7.8).

### 7.5 Two different features share one sentence, and they differ by an order of magnitude

*"Copy the commands used to back it up and such"* covers a restore, and there are two restores.

| | **The cheap restore** | **The expensive restore** |
|---|---|---|
| What it is | The platform's own back-out: `rollback 1` / `commit` | Generated inverse lines for exactly what changed |
| What it needs | A per-platform constant lookup — `18` §5.6's `GuardPolicy` table | Both sides parsed into graphs, then `18` §5 run over the resulting `GraphDiff` |
| Quality bound | The vendor's | **The dictionary's.** `18` OD-1: *"a diff that reports 40 spurious changes because we do not model 40 statements is worse than no diff"* |
| Governing rule | — | `18` §5.1: *"Rollback is a function of the diff, not of the change set."* `18` §2.3 makes it structural: `NodeDelta::Removed` carrying a snapshot *"is the single most important field in this type and it exists for exactly one consumer: §5"*, and §9 failure mode 6 exists to stop rollback being generated from a change set |
| Status today | Rendered in every Junos ticket; **the command it names is not in the corpus** | Specified in full; gated on `18` OD-1 and on parser coverage |

**Neither is wrong and the owner's sentence does not distinguish them.** §1.5 splits them as C-05a
and C-05b for exactly this reason.

### 7.6 The pre-shared key, and it needs its own treatment

A pasted Junos configuration contains `set security ike policy P pre-shared-key ascii-text "…"`.
Invariant 3 as quoted by any reader today says *"The application never accepts a credential. No
PSKs…"*. **That sentence is not the current invariant, and the document that carries it has not been
updated.**

| Where | Text |
|---|---|
| `.context/conventions.md` invariant 3 | *"The application never accepts a credential. No PSKs, no certificates with private keys, no SNMP communities, no TACACS keys, no device passwords."* |
| ADR-0002, **Accepted**, dated 2026-07-28 | Adopts replacement text: *"**The application stores no device credential.** … A pasted capture may **contain** a credential; it is redacted at the ingest gate and the unredacted text never reaches the encryptor (`14` §9.9)."* |

**The amendment is accepted and unapplied.** ADR-0011's amendment *was* applied to
`.context/conventions.md`; ADR-0002's was not. So the invariant a reader quotes forbids what this
capability needs, and the accepted decision that permits it is not in the document a reader quotes.
ADR-0002's own consequences section anticipates the reading problem: *"Every amended invariant is
weaker than the sentence it replaces, and the weaker sentences are the true ones."*

**Recorded as a question, not an answer**, and there are four of them:

| # | Question |
|---|---|
| 1 | Does storing a snapshot add **any** new credential exposure over what `14` §9's gate already produces on every paste? The structural argument says no — `14` §9 makes `CaptureStore::insert` take a redacted newtype, so the stored snapshot **is** the redacted capture, and it is the same artefact ingest already writes today |
| 2 | Does a **series** of snapshots change that answer? §7.7 argues it changes the threat model even if it does not change the per-artefact exposure |
| 3 | `14` §9.9's own limit — redaction is *"a retention control, not a confidentiality control"* — is stated for a transient paste. Does it read the same way for an artefact deliberately kept? |
| 4 | Junos `$9$` values are redacted at ingest because they reverse to plaintext with one command on the box. **A restore replayed from a stored snapshot therefore cannot restore any `$9$` value** — the snapshot has a placeholder where the box had a key. `18` §5.4's Credentials row already carries the right sentence for the *generated* case (*"you must have the previous key. Fathom does not and never did"*). Whether the snapshot-restore path carries the same unsuppressible caveat is specified nowhere |

**Question 4 is the one that will be discovered late if it is not written down now.** A restore that
silently omits the PSK is a restore that fails at the first Phase 1 negotiation, on a box that is
already down.

### 7.7 What is genuinely new

Four things, and none of them is the diff engine.

| New | Why nothing covers it |
|---|---|
| **A text-level diff between two stored captures** | Everything the corpus calls a diff is graph-derived: `18` §2 is the semantic graph diff, `18` §3's config diff is a map difference over two emits, and `17` §12.7's `fathom diff` *"is built on the graph"*. `18` §2.1's four objections to text diff are all about **producing a pasteable change set** — it cannot tell a value change from a delete plus an add, it cannot produce a paste, it is order-sensitive, it has no risk model. **They do not obviously apply to a plain "what changed on this box since last week" reading view**, and nothing in the corpus considers that case |
| **A snapshot *series*** | Captures already accumulate mechanically — `17` §4.5 is write-once and content-addressed, one file each, and `Capture.taken_at` exists — so the data is there by accident. **Nothing names a series, orders it, bounds it, or deletes from it.** There is no capture retention policy anywhere in `17` |
| **Restoring from a whole stored snapshot rather than from a generated inverse** | `18` §3.7's **DECISION** puts `load replace` export off by default and gates it on full-parse provenance, and the disqualifying argument is that `load replace` **from a partial graph** silently removes everything the graph never modelled (§9 failure mode 4). *That objection does not apply to replaying a stored snapshot*, because the snapshot is the full text rather than a projection of a partial graph. The corpus never considers this case. **It is arguably the most useful thing in the capability and it is the one thing nothing covers** |
| **Teaching the act of capturing configuration** | The explainer corpus explains what a statement means and what output says. Nothing explains why `\| display set` is the right capture format, what `\| display inheritance` adds, or why a capture taken in configuration mode may be uncommitted — even though `14` §4.4 already extracts that signal from the echoed prompt |

**And one that is a threat-model question rather than a feature.** `31` §2.1 ranks what a single
config exposes and `31` §2.5 places it all at *"at rest, local"*. A time series adds a dimension `31`
does not model: not what the estate looks like, but **when each thing changed, and therefore when
each window of exposure opened**. `31` §12's CI checks and `14` §9.11's canary corpus both test for
credentials, not for volume and not for temporal inference. This composes badly with §13 row 22,
which already prices maintenance dates as the highest-value metadata channel in the threat model.

### 7.8 What is only corpus authoring — and it is larger than one command

The owner is right that part of this is authoring rather than engineering, and the size is worth
stating. **`corpus/commands/junos-srx-ipsec.yaml` holds 98 entries. Three touch configuration
safety and none of them backs up or restores anything**: `junos-srx/system.commit-confirmed`
(`commit confirmed 5`), `junos-srx/system.commit` (`commit`), and `junos-srx/system.commit.show`.

| Missing | Examples |
|---|---|
| **Backup verbs** | `show configuration \| display set`; `show configuration \| display inheritance \| display set`; `show \| compare`; `show \| compare rollback N`; `save <path>`; `file copy`; `request system configuration rescue save` |
| **Restore verbs** | `rollback <n>`; `rollback rescue`; `load override`; `load replace terminal`; `load merge terminal`; `load set terminal`; `load patch terminal`; `commit check`; `commit and-quit` |

**Two of those are printed by `18` today and cannot be resolved.** `18` §5.3 prints
`show configuration security ike gateway GW-B | display set` inside a *no safe rollback* caveat, and
`18` §7.5 prints `rollback 1` as the authoritative back-out in **every** Junos ticket. The command
finder cannot explain either of them, because neither exists as an entry.

**And `61` §17 — the document whose entire stated purpose is *"so a corpus author has a work list
and so a reviewer can see what is missing rather than assuming it was considered"* — lists neither.**
`18` §11's sources table already cites Juniper documentation for `show | compare`, `load patch`,
`load replace` and `load set terminal` semantics, so the behaviours are researched and the entries
are simply not written.

**No new corpus machinery is needed for any of them.** `61` §3.7's destructive fields
(`blast_radius`, `reversible`, `commit_model`, optionally `scope_required` and `paired_teardown`)
cover a restore verb, `reversible: commit-confirmed` already exists as an enum value, and `61` §4.6's
`risk_caption_override` exists for exactly the awkward case `rollback 1` presents — a command whose
default caption *"CHANGES CONFIG — NEEDS A COMMIT"* is true of it but reads oddly. **Which risk band
each verb gets is unassigned and is a question, not a gap** (§7.10).

**One naming hazard, recorded because it will otherwise be inherited silently.** `18` §4.3's worked
ladder references command ids `junos-srx/config.commit-confirmed` and `junos-srx/config.commit`; the
shipped corpus uses `junos-srx/system.commit-confirmed` and `junos-srx/system.commit`. The corpus
file's own ID-MAP exists to reconcile exactly this class of drift and does not contain these two
rows. Any backup or restore step wired into a ladder inherits the same unreconciled naming problem.

### 7.9 Where it would attach

| Document | Section | What would change |
|---|---|---|
| `03` | **§4.10, via §10.1** | The retirement or clarification of `N-R-10`. **Everything else queues behind it.** `03` §2's register records the retirement date and the boundary is struck through, not deleted |
| `18` | **§10 OD-1** | OD-1 already states this capability and its objection. C-05 turns it from an option into a prerequisite. Deciding it adds the *statements-we-did-not-understand* count to `GraphDiff` and a refusal threshold above which the diff declines rather than reporting spurious changes |
| `61` | §17 and the `commands/junos-srx/` tree | A block of entries per §7.8, each needing `blast_radius`, `reversible` and `commit_model`, with a band assigned by effect per ADR-0011's round-up rule |
| `61` | §2's `filters/` tree, §17's *Filter entries* row, and D4 | **The single most important command in this capability may not be a command entry at all.** §2's layout puts `\| display set` under `filters/`, §17 says filters are `mode: pipe-filter` and *"explained separately from the command"*, and D4 leans *"Separate (`filters/`)"*. The seed corpus ships no `filters/` file |
| `11` | §8.4 | Nothing structural. `Capture.command` is already the link between the taught command and the stored artefact, and `14` §4.4 already recovers the command from the echoed prompt line at `Confidence::Asserted` |
| `14` | §16 D3 | D3 proposes `CaptureIntent { Observed, Intended }` and leans *"Probably yes — it makes §10.5's last row solvable and costs one enum. Needs IR §8.4 to change."* A backup snapshot is unambiguously observed; `14` §10.5 calls the confusion between the two *"a real gap"*. **C-05 makes D3 load-bearing rather than tidy** |
| `17` | §12.7 | §12.7 specifies exactly two diff mechanisms and both are graph-built — a `textconv` for `git diff` over decrypted record projections, and `fathom diff`, which *"knows the difference between a rename and a change"*. A capture-to-capture view is a new surface hanging off this section, and `17` §12.5 states that captures never merge |
| `17` | §13.1, §13.5, §13.6 | §13.1's per-device table has one captures row and assumes one capture. A series multiplies the largest per-byte class. §13.6's rule bears directly on any retention policy: compaction in a git workspace *"is not a saving, it is a purchase"* |
| `14` | §7.2 | **Nothing.** `Origin::Parsed { capture, span, stanza, parser, parser_version }` already names the capture, so *"which backup did this value come from"* is answerable today |
| `31` | §2.1, §2.5, §7.2 | The series question in §7.7. Temporal inference is not in the asset ranking |
| `37` | §2.2 | Row 20 exists and says captures *"inherit every row above"*. A series changes its volume claim, not its verdict |

### 7.10 What must be decided first

In order. Each blocks the ones below it.

1. **Which reading of `N-R-10`'s test is correct** (§7.3), and therefore whether `11` §8.4 is
   already a breach. This is a `03` conversation and it is not this register's to have.
2. **Whether `N-R-10` is retired or clarified**, through `03` §10.1's five-step procedure. Nothing
   below can be scoped until this lands.
3. **Which restore is being asked for** — §7.5's cheap one, the expensive one, or both, in which
   order.
4. **`18` OD-1**, including its unanswered sub-question: what the unrecognised-statement count is
   and what threshold makes the diff refuse.
5. **How many snapshots per device are kept, and whether anything ever deletes one.** `17` has no
   capture retention policy; captures are the largest per-device byte class; `17` §12.5 exempts
   them from compaction; and `17` §13.5 plus §12.8 mean a blob deleted from the working tree
   survives in every clone's git history permanently. **A ten-snapshot device is a permanent
   tenfold multiplication of the most sensitive artefact class.**
6. **Whether `show configuration | display set` is a command entry, a filter entry, or both**
   (`61` D4), because it decides where the authoring in §7.8 starts.
7. **`14` §16 D3** — `CaptureIntent { Observed, Intended }`.
8. **The `$9$` caveat on the snapshot-restore path** (§7.6 question 4).
9. **A risk band for every verb in §7.8's table.** `61` §4.1's rule when torn is *round up*.

---

## 8. C-06 — Teaching-off posture and operational procedures

*margin tab: the other half of the product*

> **THIS ONE NAMES A HOLE RATHER THAN AN ADDITION. THE CORPUS HAS TWO KINDS OF AUTHORED PROGRAM
> AND "UPGRADE A JUNIPER" IS NEITHER**

### 8.1 What is wanted

From the owner, verbatim, and it is the largest of the four clarifications:

> *"wait no you misunderstood, fathom is a teaching device but also make a person's life easier
> device. if we select like no teaching mode, and then say we need to upgrade a juniper, then you
> can provide all the context and commands a user would need to have and they can just click line
> by line (or block of lines if reasonable to do so) that can then paste into the device. if that
> makes sense.. so no networking at all there."*

Three separable requests: a **posture** in which the interface stops teaching; an **authored
procedure** for a planned change whose output is an ordered set of commands; and a **click-to-copy
granularity** of one line, or one block where a block is the sensible unit. The closing clause —
*"so no networking at all there"* — restates invariant 2 rather than qualifying it.

### 8.2 What the corpus has today: two authored programs, and their types say what they are for

| | **Task** — the walkthrough | **Ladder** — the verification spine |
|---|---|---|
| Where | `52` §6, and `52` §1.1 calls it *"the only **controller** in the product"* — `drive(graph, task)` | `18` §4.2 and §4.3. `61` §10 delegates explicitly: ladder documents *"are specified in `18-diff-verify-rollback.md` §4.3 and are **not redefined here**"* |
| What a step carries | `question`, `explain`, `writes`, `creates`, `input`, `default`, `skip_when`, `blocked_until`, `arms` | `cmd`, `args`, `risk`, `expect`, `on_pass`, `on_fail`, `gate`, `tab` |
| What it does | **Interviews the user and builds configuration** | **Diagnoses a fault**: run this, read that, if bad go there |
| Its output | A configuration | A place to look |
| Advance condition | The user answers a question | `Expectation { field, want, explain }` — a named field of command output compared to a wanted value |

**The decisive observation, argued from the types rather than asserted.** `52` §6.2's `Step` has
**no field anywhere in it for a command**. A Task's output is graph writes; configuration comes out
of the emitter afterwards. `18` §4.2's `Step` does carry a `cmd`, so on payload the ladder is the
right relative. **Neither carries the third thing**, which is a step the user performs and then
asserts they performed.

### 8.3 An operational procedure is a third program type, and the gaps are specific

*"Upgrade a Juniper"* is not answering questions to generate configuration, and it is not a fault
tree. It is an authored procedure for a **planned change**, whose output is an ordered set of
commands to copy and run. Four things stand in the way of expressing it as a ladder, and they are
worth naming individually because three of them are small and one is not.

| # | Gap | Evidence |
|---|---|---|
| 1 | **The advance condition is a read, not an act** | Every ladder step advances by reading a named field of command output and comparing it to `want`. *"I ran `request system software add` and waited eight minutes"* has no field and no `want`. `18` §4.2's `Goto` has four variants — `Step`, `Explain`, `Rule`, `Stop` — and none of them is *the user says they are done*. Expressing an upgrade as a ladder produces a spine every one of whose steps needs a fabricated `Expectation` |
| 2 | **There is no run record for a ladder, anywhere** | `18` §4.6 linearises a ladder into an ordered rendering and stops. Nothing stores a cursor and nothing stores which steps are done. `52` §6.2's `WalkthroughRun` is the **only** per-run state in the product and it is keyed to a `TaskId`. **This is the sharpest structural finding in the entry**, because *"click each line as you do it"* is exactly a run cursor — and because §3.8's completion action has a home in the walkthrough and no home at all in the ladder |
| 3 | **Half of `18` §4's machinery is a function of a `GraphDiff`, and an OS upgrade produces none** | `18` §4.5's `ladder_for(gd, plat)` prunes against the diff, `gate.holds(gd)` is a predicate over it, and §4.4's `ArgSource::Binding` is a dotted path over *the diff's* binding set rather than over the graph. An upgrade is not a configuration change, so there is no diff, no bindings and no gate that can hold |
| 4 | **Ladders are `ReadOnly`-dominant by design; procedures are not** | `18` §4.3's worked bring-up ladder has ten steps of which exactly two are not `ReadOnly`. `61` §10.1 states the assumption outright: *"A diagnostic query must not start with a configuration change. Without `entry_for`, 'is the tunnel up' walks a ladder whose first step is `commit confirmed 5`."* An upgrade procedure is mostly `ChangesConfig` and `Disruptive` |

**Two second-order consequences of choosing the ladder type anyway**, recorded because they are the
kind of cost that is discovered during implementation rather than during design:

- `61` §10.2's containment gate — *"If a command entry is a step in any ladder, its `next_if_bad`
  must be a subset of that ladder's `on_fail` targets. CI gate 11."* Every new operational verb's
  `next_if_bad` would be constrained by whatever procedure it appears in, and a verb appearing in
  three procedures is constrained by the intersection.
- `16` §8.3's risk prior demotes `Disruptive` entries in finder ranking as a **safety control**, not
  as a relevance signal. A mostly-`Disruptive` procedure surfaced through the finder is ranked down
  by a control that exists for good reasons.

**RECOMMENDATION — record both framings and do not pick one, because the corpus does not settle it.**
The evidence leans toward generalising `Ladder` plus a run record rather than inventing a fourth
authored artefact: `18` §4.2's `Step` already carries `cmd`, `args`, `risk` and `tab`, so the delta
is an advance-on-assertion variant, a run record, and freedom from the `GraphDiff` that §4.4 and
§4.5 assume — three changes to one existing type, against a fourth artefact with its own YAML form,
CI gates, review pipeline and version-drift story (`52` §6.9). **It also costs the clarity of
`18` §4's own title, *"The verification ladder as a directed graph"*, and drags `61` §10.2's gate
onto every operational verb.** That is a trade, not an answer, and §14 Q30 asks it.

### 8.4 There is no teaching-off mode, and the nearest thing is a different axis

**Depth is not it, and the type says so by name.** `15` §6.3: `pub enum Depth { Terse, Explained,
Teaching }   // exactly three. Never a fourth.` The cheapest-looking implementation — add `Off` —
is closed by a comment inside the type, and it is not a soft preference: `17` §10.1's
`Settings.depth` is that enum and `15` §11.3's whole resolution ladder is written over exactly three
values.

**`Terse` is close and is not the same thing.** `15` §3.3 caps Terse at *"findings only, as one-line
flags. Nothing else."*, and `15` §4.7 describes it as *"the depth a senior engineer leaves the tool
on **permanently**"*. But depth is a per-explainer, per-block setting, and `52` §4.3 keeps it
deliberately setting-free — *"There is no settings screen for it, no dropdown, no radio group, no
icon."* **The owner asked for the whole interface to change register.** That is an orthogonal axis,
and the two would then compose as posture × depth.

**How much a posture would actually have to hide is smaller than it looks, and this is the useful
finding.** The explainer layer is *already* suppressed by default. `52` §4.2's three placements are
all user-triggered — inline expansion by `Enter`/click, the margin drawer by `⌥E`, the sheet by `G`
— and `52` §4.4 is a table of four things opening one **never** does: steal focus, change the
selection, block anything, or fetch. `54` §8.3's config-block markup carries the same posture in the
DOM: each line is a button at `aria-expanded="false"` with its disclosure panel shipped `hidden`.
`15` §11.2's side rail *"has no close button — it has a width, and the width can be zero"*.
**Nothing has to be hidden in the config view, because the explainer is already closed until asked
for.** What a posture would change is the always-visible prose — the one-line imperative (`54` §5),
the margin tabs (`54` §4), the walkthrough's questions — plus whatever a procedure surface renders.

**Where a posture value would live is a fork with two precedents in one section, pointing opposite
ways.** `15` §11.3's **DECISION** — *"`user_default` lives in local settings, never in the
workspace. A workspace shared with a junior engineer must not force the senior's Terse on them"* —
and `17` §10.2's rule that per-machine state in a shared document *"means two people fight over it
on every sync, forever"* both point at local settings. `15` §11.3's own `workspace_default` points
the other way. **Not resolved here**; §14 Q33.

### 8.5 The three details the clarification names

**One — copy granularity has precedent, and half of it is a direct collision.**

`53` §6.3 already separates what is *displayed* from what lands on the **clipboard**, and §6.3.1
states the rule: *"`WrapPolicy::Display` means the display wraps and the clipboard does not."*
`54` §8.2 rule 2 says the same from the component side, and that whole `Terminal` wrap position is
R39 / ADR-0025.

| Granularity | State |
|---|---|
| **Block as a unit** | **Specified.** `53` §6.3 already gives payloads for *"A config block header → the whole block, including every continuation"*, for multi-selected lines *"in emit order, not click order, deduplicated"*, and for *"A verification ladder → the commands, numbered, one per line, `#` comments for what to read"*. `54` §8.7's affordance announces `14 lines, unwrapped, as one block` |
| **Line as a unit, by keyboard** | **Specified.** `53` §6.3's *"One config line"* row, and `54` §8.8 binds `⌘C` on the focused line |
| **Line as a unit, by pointer** | **Refused, by a stated rule with a stated reason.** `54` §8.7 rule 4: *"A per-line copy exists inside the provenance panel (§17), not on the line itself. A copy button on every line would put a control in the gutter and the gutter belongs to the line number."* `54` §17's anatomy confirms it — `[ Copy this line ]` is a control *inside* the provenance disclosure |

> **THE COLLISION, STATED PLAINLY: the owner asked for click-line-by-line, and as specified the
> only pointer route to a per-line copy is inside the disclosure that a teaching-off posture would
> suppress.** The keyboard path is unaffected. This is narrow — it is a pointer-affordance
> conflict, not an architecture conflict — and it is a direct collision with a written rule, which
> is why it is recorded rather than designed around. `54` owns the rule and ADR-0024 owns the
> keymap; neither is this document's to change.

**Two — risk marking must survive the mode change, and the corpus already says it does.** In
teaching mode a user reads the blast-radius paragraph before running a `Disruptive` command; in
teaching-off mode that command is one click from the clipboard. Three independent guarantees, none
of them routed through the teaching surface:

| Guarantee | Text |
|---|---|
| `54` §6's placement rule | *"**The legend appears on every view that renders a `Risk` value, immediately below the masthead, always in the same place, never collapsed, never behind a disclosure.** It is not a 'first-run' element and it does not get dismissed."* Its States row adds *"None. It never highlights the 'current' risk… It does not move."* **This settles the legend question as asked** |
| `54` §8.1's anatomy | The `.risk-bar` 4px accent bar is part of the mono config block's own structure, with a `.vh` sibling carrying the word. It is not part of any explainer surface, so it is safe by construction |
| `15` §3.3 | *"Depth controls **explanation**, never **warning**."* Written for depth; extending it verbatim to a posture is a one-line generalisation, not new thinking. `15` §4.7 names the enforcement mechanism — the rail category table is fixed data, not a per-depth conditional in the renderer, because *"suppressing warnings along with explanation is the most obvious possible bug in a depth system and it should be impossible to introduce"* |

**What is *not* settled is `blast_radius`.** `61` §4.2 is titled *"mandatory, and it is the whole
point"*, and `blast_radius` and `scope_required` are **prose** — which is exactly what a posture
suppresses. `15` §3.3's sentence answers it for depth and has never been asked of a posture. **This
is the most consequential unanswered question in the entry, because it is the one where getting it
wrong drops live traffic.** §14 Q32.

**One thing that may already be the answer**, recorded as an observation rather than a proposal:
`53` §6.5 puts the risk composition on the **copy path** rather than the teaching path — the footer
reads `copied · 31 lines · 6 CHANGES CONFIG · 2 DISRUPTIVE`, and §6.5's own sentence is *"**The risk
composition is the confirmation.**"* In a click-to-clipboard mode that is doing the work the
blast-radius paragraph does in teaching mode, and it lives somewhere a posture would not reach. One
thing to re-examine if it is leaned on: it clears after 1.6 s and is overwritten by the next copy,
which is a different rhythm from copying one line at a time.

**Three — it composes with the other three clarifications, and that is the strongest argument that
they arrived together rather than separately.**

| Composition | Which entry |
|---|---|
| A procedure opens with *"back up the running configuration"* — a taught command, run by the user, pasted back | C-05 (§7) |
| Each step advances by an explicit *done* action rather than by a clock or by a parsed expectation | C-01 §3.8's completion action |
| Each step stamps when it was completed, as a stored date that is never compared against anything | C-02 §4.4 |
| Each step is copy-paste in and copy-paste out | `53` §6.3 |

### 8.6 Where it would attach

| Document | Section | What would change |
|---|---|---|
| `18` | §4.2, §4.3 | The procedure type, if it generalises `Ladder`. An advance-on-assertion variant alongside `Expectation`, and a `Goto` terminal that does not exist today |
| `52` | §6.2 | The run record. `WalkthroughRun` is the only per-run state in the product; generalising it is the cheapest honest route and it drags in `17` §4.2's record taxonomy — a new `RecordKind`, or reuse of the walkthrough's |
| `52` | §1.1, §3.8, §9.5, §9.6 | **Where it appears in the shell, and §1.1's honest count has no slot for it.** It renders no graph projection, so it is not a renderer; it writes nothing, so it is not the controller. `52` §9.5: *"If a seventh is ever added, this design has a real problem and an overflow menu would be hiding it."* The likely landing is a **mode** of an existing view, by the same argument `52` §1.1 used to make `verify(diff(graph))` a mode rather than a seventh view |
| `52` | §9.6 | The scent budget — *"the furniture above the body carries at most 14 discrete facts"*, and *"Adding a fact to the header means removing one, and the review question for any addition is 'which fact does this replace'"*. A visible posture costs one of the 14; an invisible one is `53` §2.2's mode errors waiting to happen |
| `15` | §6.3, §11.3 | The posture is **not** a fourth `Depth` (§8.4). Where its value lives is §14 Q33 |
| `17` | §10.1, §10.2 | Only if the posture is a workspace setting rather than a local one. `15` §11.3's DECISION argues it should not be |
| `54` | §8.7 rule 4, §17 | The pointer-affordance collision in §8.5. `54` owns the rule |
| `53` | §6.3 | New **context rows** in the payload table: what one procedure step copies, and what a whole procedure copies. Nothing structural — the table's shape already accommodates it |
| `61` | §3, §4.2, §4.4, §4.5, §13, and `commands/junos-srx/` | Authoring for operational verbs, and a genuine field question: `request system software add`, `request system reboot` and `request system snapshot` are **mutating but not configuration** — outside `commit_model` entirely, and `reversible` and `paired_teardown` were designed for `set`/`delete` pairs and traceoptions cleanup, not for *reboot into the other partition* |
| `61` | §10.1 | Whether `concept:act.deploy` is the right hook. Today its entry point is a **verification** spine beginning at `commit confirmed 5` — the step you run *after* a change. **The corpus has a concept for deploying and no program for performing a deployment** |
| `71` | §3.3, §3.5 | Recording only. Phase 0 already ships three static ladders and the two-payload copy legend; neither is a procedure |

### 8.7 What must be decided first

1. **Is a procedure a new type or a generalisation of `Ladder` plus a run record** (§8.3)? Not
   answerable from the corpus alone.
2. **Does teaching-off change what is *rendered*, or only what is *copied*?** If the second, `53`
   §6.3's `⌘C`-versus-`y` split and `71` §3.5's `⏎ copy` / `⇧⏎ copy with context` legend already
   give the answer for free and no posture state is needed at all. The owner said the whole
   interface changes register, which is the first — and the first is a new global axis with no
   control idiom.
3. **Does teaching-off suppress `blast_radius`** (§8.5)? The one where a wrong answer drops traffic.
4. **Where the posture value lives** — local settings or workspace `Settings` (§8.4).
5. **Which of `52` §9.6's 14 facts it displaces**, if it is visible in the furniture.
6. **Does a procedure need `armed_rules`?** A Task has them and `52` §6.4 makes findings-inline-as-
   you-go the flagship behaviour. A procedure that writes nothing to the graph has nothing for a
   rule to fire against — **so the product's strongest safety mechanism is structurally absent from
   exactly the surface where commands reach the clipboard one click at a time.**
7. **What un-ticking a step means.** `52` §6.2's `AnswerRecord.tx` is *"what makes a step undoable
   as a unit"* and `53` §7.3 puts undo over graph transactions. A step that writes nothing to the
   graph produces no ops, so it has no `tx` and nothing to undo. This is the same missing-inverse
   problem as §3.8's third row and §5.5's `Op::Untombstone`, seen a third time.

---

## 9. C-07 — Freeform annotation, and the planning overlay modes

*margin tab: drawn on the glass, never in the model*

> **THE GLASS IS NOT THE GRAPH. AN ANNOTATION THE MODEL CANNOT SEE IS THE ONLY KIND THAT IS SAFE
> TO DRAW**

### 9.1 What is wanted

From the owner, verbatim. One message carries the whole fifth batch — this entry, C-08, C-09 and
§2.4's standing constraint — and each quotes its own part:

> *"As long as the groundwork is there for the real time stuff, that'll be important eventually,
> but we should probably do freeform stuff, even if it's temporary or permanent doesn't matter.
> I'm thinking having a planning mode would be good to, which would have those colors we mentioned?
> Planning, Commenting, Maintenance, etc? Each with their own customizable colors."*

**The batch instruction, stated once for all three entries.** No restatement of §1.2's
record-do-not-act instruction accompanied this batch. It is recorded under the original
instruction's licence, quoted verbatim per §16 row 7's discipline, and nothing in §§9–11 is to be
acted on.

**Two requests arrive together and they are one cluster.** The freeform layer is the surface; the
mode is what makes the surface legible. A freeform mark with no mode is an unexplained tint — the
exact thing `59` §4.3's invariant exists to forbid — and a mode with no marks is a colour looking
for a referent. They are one entry so that neither is scoped without the other's questions.

**And this is a reversal, which is the owner's to make.** The recommendation being reversed was
this project's own — the conversation that produced this batch had laid out what the diagram-tool
incumbents have and Fathom refuses, and the owner accepted every refusal except these. §2.1's
instruction covers the situation exactly: where the earlier answer is kept, it is kept because it
is best, never because it is already written. The corpus's recorded refusals in this territory are
colour (`59` §4.1, `56` §5.1) and shared cursors (`52` §5.7); the owner has reopened the first and
left the second alone (§2.4 point 2). This entry records the intent and the fixed parts of the
shape. It decides nothing.

### 9.2 The annotation layer — the safe shape, and who licensed it

The owner's *"even if it's temporary or permanent doesn't matter"* is doing more work than it
looks like: it removes the one requirement — durability inside the model — that would force
annotations into the graph. That licenses the architecturally cheap form.

**RECOMMENDATION — a scratch annotation layer: visibly annotation, never mistakable for the model,
and excluded from emit, findings, diff and completeness. Recorded as the recommended shape, decided
by nobody.** The grounds, one per exclusion:

| Property | Why it is the safe shape |
|---|---|
| **Visibly annotation** | `56` §5.2's contract is *"one channel, one meaning"*. An annotation drawn in a model channel makes one channel mean two things, which is §13 row 8's collision again. The layer needs its own register, distinguishable at a glance and in greyscale |
| **Excluded from emit** | `13`'s emitters return `(line, provenance)` pairs; a callout has neither. Nothing on the glass may ever reach a device |
| **Excluded from findings and diff** | An annotation that raises or quiets a finding is the unaudited path §13 row 3 exists to forbid, and a diff that reports scribbles is a diff nobody reads |
| **Excluded from completeness** | An annotation asserts nothing about the estate, so no completeness claim may count it — in either direction |

**What the shape protects, and it is priced.** `71` §1.4's R-VIEW — *"The diagram stops being a
view and starts being state, which is brief §4.1's forbidden outcome"* — is rated
*architecture-corrupting*, at phase 4. The failure R-VIEW names is the picture starting to hold
truth. An annotation layer the model cannot read is the one form of drawing on the picture that
cannot start holding truth, because nothing consumes it. That is why *"temporary or permanent
doesn't matter"* is the load-bearing clause: either answer is safe **only** while the layer stays
invisible to the engine.

**The nearest precedent is the suppression, and §3.5's warning transfers verbatim.** Human-authored,
never parsed, anchored to an `ElementId`, must orphan rather than vanish when a re-parse mints
fresh ULIDs — ADR-0010's anchoring machinery is reusable as-is. Its semantics are not: a
suppression is consumed by the engine and an annotation must never be. Reuse the anchoring; do not
let the resemblance carry.

### 9.3 The planning mode is a reversal path the corpus has already written

This is the unusual part and it should be said plainly: **the owner has asked for the thing whose
reversal was pre-authored.** `59` §4.1 decided no colour, and wrote, inside the decision block
itself:

> *"If this is ever reversed, it is reversed to A3's overlay architecture and never to A4's
> always-on model."*

`59` §4.7 wrote the gate; `59` §5 measured the palette and shelved it, marked at every heading as
not adopted, *"so that the decision to spend the channel is a decision and not a rebuild"*. The
owner's request is not the gate's trigger — §4.7's G1 wants *"a pilot engineer, unprompted"*,
recorded verbatim twice — and this register cannot fire a gate or reverse a DECISION. What it
records is that the intent now exists, and that if the reversal is ever taken, the shape is already
fixed:

| Fixed by | The shape |
|---|---|
| `59` §4.1, §4.7 | Overlay, never always-on. Neutral base; colour arrives with the mode and leaves with it |
| `59` §4.3, §5.7 rule 1 | The key is generated by the mode and destroyed with it. Colour is a pure function of the graph — no `node.color`, no inherited map whose colours mean whatever the last engineer chose |
| `59` §5 | The palette exists, measured: hue clearance from the reserved trio (§5.3), contrast both themes (§5.4), greyscale survival (§5.5) |

*"Planning, Commenting, Maintenance, etc"* maps onto that architecture directly: each category is
an overlay mode, each mode generates its own key. **Three guardrails are not negotiable and are
recorded as constraints, not design:**

| # | Guardrail | Source |
|---|---|---|
| 1 | **No custom colour enters the reserved risk families.** The green/amber/red trio and their washes mean one thing forever | `.context/conventions.md` §"The risk enum" — *"Do not reuse these colours for anything else"* — left untouched by ADR-0011's amendment, whose own text is that *"the ink, wash and ordering may not"* be overridden; `51` §1 R1; `51` §3.3's `tokens/reserved-colour` lint; `59` §5.3 gives the benchmark — the shelved palette's closest approach to a reserved hue, measured at 44.9° light and 42.3° dark — but no document declares a minimum clearance a user-picked value must meet, and this register does not invent one. The missing validation rule is §13 row 40 |
| 2 | **Colour is never the sole carrier** | `51` §1 R2 (WCAG 1.4.1); `55` §3.1's operational form; and A3's invariant, adopted by `59` §5.7 rule 2: *"Nothing is tinted that is not also tagged"* — enforced in the renderer, refusals counted in the view band, *"Not a guideline"* |
| 3 | **Forced-colours and greyscale survival** | `59` §5.7 rules 3, 6 and 8; `55` §3.4's monochrome test extended to the diagram; `51` §6's exactly-once rule for `forced-color-adjust: none`; and `59` §6.1's base defect — the declaration on five diagram classes that contradicts `51` §6 and `55` §7.3 — is fixed **first**, or every overlay inherits it |

**One category on the owner's list is not a new thing, and saying so now prevents a parallel
system.** *"Maintenance"* is C-01's lifecycle state wearing an overlay rendering — one underlying
datum (§3), one mode that renders it. If the category system lets a user define "Maintenance"
independently of the lifecycle field, one word acquires two homes with two update paths, which is
the same class of collision §3.2 records for decommission-versus-tombstone. §14 Q38.

### 9.4 Customisable by whom — the missing home, a third time

*"Each with their own customizable colors"* lands on the fork Q33 already holds for the teaching-off
posture — `15` §11.3's DECISION and `17` §10.2's fight-on-every-sync rule point at local settings;
a shared vocabulary points at the workspace — with one new fact Q33 did not have: **`19` §8 has
since designed the home for per-workspace private policy**, the `Policy` record class, built for
exactly the shape "our workspace's private conventions, never in the corpus". A colour *preference*
is local; a category *vocabulary* is policy. The two failure modes exclude each other — two people
fighting over a colour on every sync, versus two people reading different colours for one category
— and picking between them is §14 Q37, not this document's to take.

### 9.5 Where it would attach

| Document | Section | What would change |
|---|---|---|
| `59` | §4.1, §4.7 | The reversal, if taken, is recorded **there** — a DECISION is unmade where it was made. This register's entry then points at it and strikes through |
| `59` | §5, §5.7 | The palette leaves the shelf; the nine adoption rules become normative. Rule 6's specificity requirement (§5.6) and rule 8's monochrome-test extension are the two with CI teeth |
| `56` | §5.2 | The channel budget. An overlay while active is a channel; §13 row 39 records the accounting, and G10's view band carries the mode name so an active mode is never invisible state (`53` §2.2: no mode errors) |
| `51` | §3.3 | Both lints assume colours live in stylesheets. A user-picked colour is runtime data no stylesheet lint sees; the checks move from build time to input time. §13 row 40 |
| `55` | §3.4, §7.3 | The monochrome test and forced-colours behaviour extended to a layer that did not exist when they were written |
| `52` | §9.5, §9.6 | A mode, not a seventh view — the same argument that made `verify(diff(graph))` a mode. A visible mode indicator costs one of the 14 facts; an invisible one is forbidden. Q34's twin |
| `53` | — | Mode entry and exit, and whatever key draws or places an annotation. ADR-0024: `53` owns the keymap; nothing here names a key |
| `17` | §4.2 | Only if annotations or the category list persist as workspace records — a new record class, or a deliberate statement that they are session-local. §14 Q36, Q37 |
| `11` | §6.2 versus §13 | The `notes` contradiction (§3.4 row 1, §19 item 2) is upstream again: whether a free-text user carrier exists decides what an element-anchored annotation would sit beside |
| `34` | §5.1 | Annotation text is user-typed text — U3, *"none, treated as U2"*. It stays inside the product only if the exclusions in §9.2 hold; if annotations ever export, §5.5's per-path rules apply |

### 9.6 What must be decided first

1. **Whether `59` §4.1 is reversed** — through `59` §4.7's gate or by the owner's explicit
   decision, recorded in `59` either way. Everything colour-shaped queues behind it; the
   annotation layer does not.
2. **Annotation persistence** — session state or a workspace record class, and if a record, which
   merge half (§1.6) and which `33` §6.4 class. §14 Q36; §2.4 point 1 makes "unstated" not an
   option.
3. **Category ownership** — local preference or `19` §8-style workspace policy. §14 Q37.
4. **Whether "Maintenance" the category is C-01's lifecycle state rendered, or a free label.**
   §14 Q38. If C-01's enumeration is still open (Q3), the category list inherits that openness.
5. **The anchoring rule** — ADR-0010's machinery for annotations anchored to elements; free-floating
   annotations need a position anchor instead, and `59` §3's aggregation moves what they point at.

**Not before phase 4.** Both halves land on the diagram, and ADR-0006 puts the diagram at phase 4.
The floor is a floor, not an assignment (§1.5).

---

## 10. C-08 — Typed stencils: "router", "switch", and the etc

*margin tab: a typed node, not clip art*

> **THE QUICK BOX IS A REAL NODE, OR IT IS A LIE THE PLAN TELLS THE MODEL**

### 10.1 What is wanted

From the owner, verbatim, continuing §9.1's message:

> *"Otherwise, the rest makes sense, so long as we have generic shapes to bring over, like "router"
> or "switch" etc. Does that make sense? Like it won't be the primary thing, but it'll help in
> needing quick planning situations."*

The batch instruction in §9.1 governs this entry too.

### 10.2 What a stencil is not, and what it decodes to

**Not clip art.** The design language refuses the pictorial form by name —
`.context/design-language.md`, "What the card never does": *"No logos. No icons. No
illustrations."* — and the diagram's nodes are boxes with words. Nothing in this entry proposes an
icon library, and any implementation that reaches for one has left the design language.

**What it is instead: a quick-create for a typed hand-origin node.** The two pieces already exist,
declared, not implied:

| Piece | Where | The declared shape |
|---|---|---|
| The type | `schema/schema.yaml`, `Device` | `role`, typed `enum { firewall, router, switch, load_balancer, other }`, cardinality `0..1`, emit `—` — an annotation-only field, exactly the class `11` §6.3 built the Emit `—` column for |
| The origin | `11` | `Origin::Hand` is a first-class provenance origin; §3.7 already records that a user-writable, never-emitted layer is corpus-sanctioned |

So *"bring over a router shape"* decodes to: **create `Device { role: router }` at `Origin::Hand`,
rendered exactly as every other node is rendered.** The stencil is a creation affordance, not a
rendering. Nothing new exists structurally; it is UI over hand-origin creation.

### 10.3 The payoff, and it is structural rather than cosmetic

**The quick-planning box is already a real model element, so a plan becoming real requires no
re-drawing.** The sketch and the estate are one graph. And the corpus pays a second dividend
unprompted: `11` §10.5's `Divergent { since }` makes a hand-origin node missing from a `Section` or
`Whole` re-parse *"intended but not deployed"* — which is precisely what a planned-but-unbuilt
device is. The compliance diff the corpus calls a feature (*"Nautobot Golden Config's compliance
diff obtained as a side effect of one schema"*, §3.7) applies to quick-planning boxes for free.

**The same dividend is the entry's sharpest cost, and it is recorded rather than solved.** A
forty-node plan is forty standing `Divergent` findings on every re-parse until the plan is built.
That is the machinery doing its job and it will read as noise — and the answer is not to quiet
findings, because §13 row 3's constraint (any quieting produces a reason and an audit record)
applies here with full force. §13 row 44; the pocket (§11) is one honest framing, and it is not
decided.

### 10.4 What is missing is the affordance, not the machinery

No verb in `53` §3.4's table creates a node. The specified creation path is the walkthrough —
`w`, and `52` §6.2's `Step` carries `creates` — which `52` §6.10 makes deliberately slow, *"for
the case where you do not know the answers, which is the case where you should be slowed down"*.
A stencil is the opposite case: the user knows exactly what they are placing and wants it placed
now. That makes this the same imbalance §12 records — the corpus serves the user who needs
teaching and under-serves the one who already knows — surfacing at the creation path rather than
at the reading path.

Two open edges, neither invented here:

- **The "etc" is a closed enum today.** `role`'s five values end in `other`. Either `other`
  absorbs the owner's etc or the enum grows, and growth is a schema bump under `11` §11.3's
  discipline — cheap now, priced later. §14 Q39.
- **The affordance's home.** ADR-0024 gives `53` the keymap; `54` owns the component. A stencil
  reachable from the canvas is a diagram affordance, and the diagram is a view — creation from it
  must write through to the graph, never into the picture, or it is R-VIEW (`71` §1.4) by another
  door.

### 10.5 What must be decided first

1. **Which kinds get stencils.** `Device` roles are the owner's examples; edges, sites and
   services are not asked for and not assumed.
2. **What a stencil-created node contains** — beyond `role`, whether `platform` or a layer is
   demanded at creation or left absent. Nothing here decides a required-field policy; that is the
   schema's.
3. **§14 Q39** — does `role`'s enum grow, and by what process.
4. **The findings-volume framing** (§10.3, §13 row 44) — before a stencil ships, not after the
   first forty-node plan.

**Not before phase 1** — hand-origin creation needs the graph, and ADR-0006's phase 0 is *"Nothing
about a graph"*. **On the canvas, not before phase 4.** Floors, not assignments.

### 10.7 Status change, 2026-08-15 — the canvas half's blocker is gone

**ADR-0035 is Accepted, and this entry moves from *Intent recorded* to *Partly decided*.**

The register's job is to record intent without deciding (`CLAUDE.md` rule 6), and this note is a
status change rather than a decision made here: the decision is ADR-0035's, and its subject is
narrower than this entry.

**What the ADR settles for C-08.** *"On the canvas"* was the half of this capability with a real
structural hole under it — a stencil dropped on the diagram has to land **somewhere**, and until
2026-08-15 there was nowhere in `schema/` to record where. That is closed: a hand-placed position is
graph data, stored as a `LayoutPin` node contained by the element it places, with `Origin::Hand`
provenance, written by `OP_PLACE` and journalled like any other op. Dragging a box on the canvas and
having it stay put — through an export and an import — ships and is driven in Chromium
(`docs/80-review/evidence/2026-08-15-hand-placement-drive.mjs`).

**What it does not settle**, and these stay open exactly as §10.6 lists them: which kinds get
stencils, what a stencil-created node contains, whether `role`'s enum grows (§14 Q39), and the
findings-volume framing. Creating a node from the canvas is still creation-from-a-view and still
raises §10.5's objection. **What changed is that "and then where does it sit" is answered**; what a
stencil *is* remains the owner's.

The phase floor is also now moot in the way ADR-0031 made every phase floor moot: phases are
retired, all features ship. *"On the canvas, not before phase 4"* should be read as a dependency —
it needs the diagram — and the diagram exists.

---

## 11. C-09 — The pocket

*margin tab: click in, work small, leave everything intact*

> **A POCKET IS EVERYTHING SELECTION DELIBERATELY IS NOT. THAT IS THE ENTRY, IN ONE SENTENCE**

### 11.1 What is wanted

From the owner, verbatim, closing §9.1's message:

> *"Perhaps even having a "pocket" where you can click into and focus only on certain pieces of
> equipment, which would be great for planning and such. Especially inside a large scale network."*

The batch instruction in §9.1 governs this entry too.

### 11.2 What already exists — the through-line and the drill

| Already specified | Where |
|---|---|
| Selection as the product's through-line: `set: BTreeSet<ElementId>` plus a distinct `anchor`, per-view `resolve`, the whole §5 architecture | `52` §5.1–5.6 |
| The safety furniture for a set the screen cannot fully show: `OffscreenReason::FilteredOut`, `3 of 11 selected are filtered out`, full-count confirm text | `52` §5.8 row 5 |
| A one-key drill into a subset the picture has folded away: `OffscreenReason::Aggregated { drill_into }` | `52` §5.8 row 6 |
| Entering and leaving a machine-chosen subset with an exact round-trip: windowed expansion, and the exit criterion *"Expand → collapse restores the element count **exactly**"* | `59` §3.7, §7.2 X5 |

The composition is real: `59` §3's aggregation is the machine choosing a subset to fold; a pocket
is the user choosing a subset to inhabit. *Enter by click, leave intact* is the same round-trip
discipline `59` §7.2 X5 already demands of expansion, applied to a user-named set — and a pocket
opened from an aggregate stack is the natural long form of `52` §5.8 row 6's one-key drill.

### 11.3 What is genuinely new, and the collision that defines it

A **named, held working set** that scopes canvas, inventory and findings at once. Selection cannot
be it, and the corpus says so on purpose — `52` §5.7's anti-table makes selection **not undoable,
not synced, not persisted across a lock**, each with a stated reason. A pocket is precisely the
thing selection is forbidden to become. So the pocket is not a selection feature: it is a new
object beside selection, and selection operates normally **within** it. *Minted from the current
selection* is the obvious creation gesture, not the definition — §11.2's drill from an aggregate
stack is a second door, and a pocket whose membership is a stored query (§11.5 item 3) would be
minted from a filter, not from a selected list. The mint path is open with the membership
question, and this entry closes neither.

Two inherited hazards, named now:

- **`52` §5.7's sharpest sentence is one step away**: *"Shared cursors are a collaboration feature
  this product has not earned and they leak what a colleague is looking at."* A pocket that syncs
  is a shared viewport — what a colleague is working on, persisted. Nothing here proposes it;
  §14 Q40 asks where a pocket lives so that it is not inherited by accident.
- **A pocket is an ambient filter over every surface at once.** The lying-view hazard `52` §5.8
  row 5 solves for one selection becomes standing: a findings panel scoped to a pocket that does
  not say so is §13 row 2's lying panel; a bulk action launched inside a pocket must count what
  the pocket hides, and `33` §7.4's by-construction scoping applies unchanged. §13 row 45.

### 11.4 Where it would attach

| Document | Section | What would change |
|---|---|---|
| `52` | §5 | A new type beside `Selection` — able to consume it, never a widening of it. §5.7's anti-table is the contract that keeps them distinct |
| `52` | §3.7, §9.6 | Inventory scoped to the pocket; the furniture states the scope — `pocket · DC-EAST refresh · 14 elements` is one of the 14 facts, and it displaces one |
| `59` | §3 | Composition with aggregation: what a collapsed stack shows when only part of it is in the pocket, and whether entering a pocket is `drill_into` writ large |
| `12` | — | Nothing, if findings are filtered at render. Everything, if anyone proposes evaluating rules over only the pocket — that is a scope the engine does not have and this entry does not ask for |
| `17` | §4.2, §10.2 | Only if pockets persist. A workspace record syncs and merges (which half, §1.6; which class, `33` §6.4 — a member set is class-E-shaped, and `merge.set.widened` exists); per-machine state in a shared document is `17` §10.2's permanent fight. §14 Q40 |
| `53` | — | Enter by click; leave; where the pocket sits in the Escape ladder `59` §7.1 item 3 describes. ADR-0024: `53` owns the keys |

### 11.5 What must be decided first

1. **§14 Q40 — where a pocket persists**: session state, local settings, or a workspace record;
   and if it syncs, whether it is private. This is Q33 and Q36's fork a third time, with `52`
   §5.7's shared-viewport hazard attached.
2. **§14 Q41 — what the scoped surfaces admit**: whether findings and counts inside a pocket show
   the pocket's numbers, the estate's, or both. One of these is a lying panel; which one depends
   on the answer being stated on screen.
3. **Membership**: an explicit element list, or a stored query. A list orphans as elements go
   (ADR-0010 again); a query is a saved filter with different staleness. Not chosen here.
4. **Cardinality and nesting**: one pocket or many, and whether a pocket may contain a pocket.
   The owner's *"large scale network"* leans many; nothing is decided.

**Not before phase 2** — the pocket scopes inventory, which is phase 2. **On the canvas, not
before phase 4.** Floors, not assignments.

---

## 12. The corpus is lopsided toward teaching

*margin tab: an observation, not an entry*

> **THE OWNER HAS NAMED EXECUTION AS HALF THE PRODUCT. IT IS CURRENTLY THE THINNER HALF BY A WIDE
> MARGIN**

**This is not a capability and it does not belong in §1.5's table.** It is an observation about the
whole document set, larger than any entry, and it is recorded here because C-06 surfaced it and
because §19 item 6 shows this register already carries one register-wide observation of exactly this
class. Read the two together: item 6 says these entries push toward a system of record; this section
says the corpus as a whole under-serves the user who already knows the answer.

**The observation.** Nearly everything in the corpus serves **understanding** — explainers at three
depths, findings with mandatory `acceptable_when`, the rule packs, the concept layer — or
**building** — the walkthrough. Almost nothing serves *"I already know what I am doing, give me the
correct sequence and do not make me read."*

**The evidence, and it is structural rather than impressionistic.**

| Evidence | Where |
|---|---|
| The explainer specification alone is **2,699 lines**, and it is one of several teaching documents; `63` (rule packs), `61` §11, `52` §4 and `54` §7 all serve the same half | file lengths, and the documents themselves |
| **The only document genuinely about getting a correct string onto a device is `53` §6** — and it specifies the clipboard mechanism, not procedures | `53` §6 |
| The two mandatory-field invariants point the same way. Invariant 8 makes `acceptable_when` **mandatory on every rule**, and `61` §4.2 makes `blast_radius` mandatory and *"the whole point"* — **but both are prose that a human reads before acting.** The corpus mandates explanation at two levels and mandates no artefact anywhere whose job is to be executed | `.context/conventions.md` invariant 8; `61` §4.2 |
| The product's one ordered-procedure surface is the walkthrough, and `52` §6.10 says of it in its own words: *"**It is the slowest path to config in the product.** Fifteen questions versus a paste. It is for the case where you do not know the answers, which is the case where you should be slowed down"* | `52` §6.10 |
| The two places the corpus comes closest are both **densities of explanation**, not an absence of it: `15` §4.7's *"the depth a senior engineer leaves the tool on **permanently**"*, and `03` §4.7's *"A senior engineer and a new hire read the same entry at different weights"* | `15` §4.7; `03` §4.7 |

**Why this is an addition and not a bug report, and the distinction matters.** `52` §6.10's sentence
is a **deliberate design position**, argued and won: the walkthrough is slow on purpose, for the user
who does not know the answers. Nothing in the corpus is careless here. What the corpus has never
been asked for is the *other* user — and the owner has now asked for them by name, as *"also make a
person's life easier device"*.

**What this does and does not license.**

| Recorded | Not recorded |
|---|---|
| That the imbalance exists and is measurable | That it should be corrected. **The owner named it; nobody has decided anything** |
| That C-06 is the first request that lands on it directly | That C-06 is the right shape of correction |
| That §8.4's finding shrinks the problem — the explainer layer is already closed by default, so the imbalance is about what is *authored*, not about what is *rendered* | Any target ratio, any authoring plan, or any phase |

**RECOMMENDATION — treat this as a lens applied to future entries rather than as work.** The useful
form of this observation is a review question, not a project: *for any new corpus surface, which of
the two users does it serve, and if the answer is "the one who wants to learn" again, is that a
choice or a habit?* A project to "balance the corpus" would be a project with no exit criterion,
which §16 row 1 is the register's own warning about.

---

## 13. Second-order consequences

*margin tab: what each entry drags in*

Severity is the cost of getting it wrong, not the effort of doing it.

| # | Area | What it drags in | Sev | Source |
|---|---|---|---|---|
| 1 | **Rule visibility** | `absent_since` is a `Node` field, not a `Field<T>` in the generated body, and `fex`'s name environment resolves only selector bindings, anchor fields, closed builtins and `workspace.` constants. So a tombstoned node lints exactly like a live one and no rule author can express otherwise. A lifecycle attribute placed beside `absent_since` inherits that verbatim; the only fix is a new builtin, and `12` §3.7 says adding one is *"an engine release, not a pack release"*. As a schema field, rules read it for free. **Hard cost asymmetry, and the fork must be taken before `schema.yaml` is written** | high | `12` §3.6, §3.7; `11` §10.5, §13 |
| 2 | **Do decommissioned elements still lint** | Every available answer is wrong somewhere. Clearing the finding makes the panel lie. Routing it through `FindingState::Suppressed` requires a `SuppressionId` with a mandatory reason, author and expiry — the product would be manufacturing suppressions nobody wrote. A per-rule declaration is a new rule-pack field, so it is a `63` change and a re-review of every existing rule | high | `12` §11.1–11.3; `63` |
| 3 | **Lifecycle that quiets findings is a shape the corpus has refused twice** | `12` §17 D-6 (per-rule `enabled`): *"disabling a rule is a workspace-scoped suppression and needs a reason. One mechanism, one audit surface."* D-2 (`workspace.strictness`): *"a global dial is a suppression with no reason and no record."* A `Decommissioned` dropdown that stops findings firing bypasses `12` §11.2's mandatory 20-character reason and §11.3's mandatory expiry on `high` and `medium`. **The constraint, stated as a constraint rather than as an exhaustive list:** any option that quiets a finding must produce a reason and an audit record, because that is what D-6 is protecting — *"one mechanism, one audit surface"*. Two options obviously satisfy it — lifecycle inert with respect to the engine, or routed through `Suppression` — and Q6 asks whether there is a third. A third that carries its own reason and its own audit surface would satisfy D-6; this register has not found one, which is not the same as there being none | high | `12` §17 D-2, D-6; §11.2–11.3 |
| 4 | **The delete feature hiding inside C-01** | Fathom today has no way to say "remove this from the box". `13` §2.4 already defines `LineForm::Retract` with a `RetractScope` of `Leaf` or `Subtree`, plus `Deactivate` and `Activate`; `18` §3.3 computes removals as a `StatementPath` map difference; `18` §3.5 minimises them with `subsume`; `18` §5 generates rollbacks. All of it exists and nothing drives it, because the only producer of an absent statement today is a re-parse tombstone that excludes from emit silently. Wiring "decommissioned ⇒ excluded from emit" would make the existing config diff generate ordered, subsumed, risk-labelled delete lines with a rollback — a decommission runbook — out of machinery already specified. **This is the highest value-per-line item in the whole request** | high | `13` §2.4–2.6; `18` §3.3, §3.5, §5; `11` §10.5 |
| 5 | **But "exclude from emit" is the wrong default for maintenance** | `13` §2.4: *"For a maintenance window the first [`deactivate`] is almost always what you want, because reactivating is one command and re-typing an object is a change ticket."* Decommission and maintenance want different line forms from the same mechanism, so the choice is per-state, not per-element | high | `13` §2.4 |
| 6 | **And the vendors disagree** | `13` §9.2's gap table already records `deactivate` as `Unrepresentable { NoFeature }` on **both** `panos` and `ios-xe`. A maintenance state emitting `deactivate` on Junos surfaces as a `NOT EMITTED` block on every PAN-OS device, forever — and ADR-0030 makes PAN-OS the second platform. That is honest and it looks like a defect | high | `13` §2.4, §9.2, §9.3; ADR-0030 |
| 7 | **Rollback of a decommission** | `18` §5 generates a rollback from a diff, and only `NodeDelta::Removed { snapshot }` knows what was there. If decommission is a field change, the rollback is "paste the whole object back", and `13` §2.6's `NoInverse::ExternalEffect` is the case it lands in — *"The configuration inverts; the world does not. Dropped sessions, external references to a renamed object."* And `13` §2.5's `retract_needs_value` bites — for an accumulating statement, `delete … proposals` removes all of them, so an emitter reaching for subtree deletes without consulting `Platform::supports_subtree_retract()` writes a change set bigger than the thing being retired | high | `18` §5, §2.3; `13` §2.4–2.6 |
| 8 | **The diagram's channel budget is full, and the collision is semantic** | `56` §5.2 is explicit: *"one channel, one meaning, and nothing may be added to it without taking something away."* G1 is freshness, G2 is AI-proposed product-wide and *"unavailable to this document"*, G3 is selection, G4–G9 are edge and band vocabulary. Worse, `56` §8.2 already concedes that a `--muted` boundary *"reads, at a glance, as de-emphasised — as if the node were disabled or filtered out. It is not; it is old."* A decommissioned node genuinely is disabled. Putting lifecycle on G1 makes one channel mean both | high | `56` §5.2, §8.2 |
| 9 | **…and `56` §12 already answered it for an identical problem** | `56` §12 handles concurrent layout edits and the export CSP as open items in exactly this idiom, and G10 — the view-band margin tab — is the named release valve in both `56` §5.2 and `52` §9.3. `diagram · 12 nodes · L3 · 4 decommissioned` costs nothing. **But `52` §9.3 rule 3 caps a band tab at two facts**, so a third fact means dropping one | medium | `56` §5.2, §12; `52` §9.3 |
| 10 | **The inventory column picker will not show a node-level attribute** | `52` §3.7: columns are *"chosen from the schema (`11` §11.6 makes the schema data, so the column picker is generated, not hand-written)"*. A node attribute like `absent_since` is not in `schema.yaml`, so it would never appear as a sortable, filterable column without hand-writing an exception into a generated picker. As a schema field it becomes a column, a sort key, a filter and a `Facet::Field` target for free | high | `52` §3.7; `11` §11.6 |
| 11 | **Which `33` §6.4 class a lifecycle register belongs to is contested — and the phase-0 half of the question is not `33`'s at all** | **Two separate questions, and an earlier draft of this row ran them together.** **(i) The live one, from phase 0.** `11` §8.6's ladder resolves every git merge (`17` §12.3–12.4, ADR-0016; see §1.6). Two `Hand` assertions of different lifecycle values tie on `Confidence` and tie on `Origin`, so step 3 decides by later `asserted_at` — *"which is last-writer-wins"*, §8.6's own words. That happens in phase 2 with no CRDT present, and D3's *"bad bulk edit across a sync merge"* is the same path. **(ii) The dormant one, deferred with the CRDT.** Which of A/N/B/C/D/E the field takes. **Class B is structurally a register** — `33` §6.4 defines it as *"**LWW** by `(hlc, actor)`"* — so the earlier draft's *"none is a register"* was simply wrong, and the real question is one of suitability, not structure: is lifecycle *descriptive* enough to accept LWW? `33` §6.4's justification for B is *"losing a description costs a sentence"*, and losing a decommission may cost a device its config. **The citation the earlier draft used against B does not reach it:** `33` §6.5's worked case is `dh_group`, a class **A** field, and it closes by scoping itself — *"that is the trade and it is the right one for exactly this field"*. `33` §6.3's concurrency DECISION is likewise scoped in its own text to *"fields in class A (§6.4)"*. Class A is a genuine misfit for a different reason: it resolves to `Conflicted`, which **blocks emit** — wrong for a field that emits nothing. C is append-only, D is structural add-wins, E is set-valued. `53` §16 already assumed the answer for the nearest analogue, calling `absent_since` *"a last-writer-wins boolean… field class B under `33` §6.4"* — **without checking whether B's descriptive justification covers it.** That assumption is the thing to test, and Q11 asks it | high | `11` §8.6; `17` §12.3–12.4; `33` §6.3–6.6; `53` §16; ADR-0016 |
| 12 | **Two orthogonal words for "not really here"** | `33` §6.6's worked example resolves *"B removes `GW-B` because the peer was decommissioned"* as a tombstone. Adding an explicit `Decommissioned` state creates a second absence concept with its own merge rule, emit behaviour and rendering, and a four-cell matrix of which three are nonsense. `Op::Purge` sits on tombstone only | high | `33` §5.1, §6.6; `11` §10.5; `53` §3.8 |
| 13 | **`workspace.as_of` is referenced by four documents and defined by none** | Not in `17` §10.1's `Settings`, not in `17` §4.2's record taxonomy, not in `11`. Who sets it, whether it is stored, whether it merges, what class it is — all undefined. **Recalibrated by §4.4: lifecycle and ticket dates no longer land on it**, because a stored date needs no reference value. The surface that still does is `54` §14's suppression countdown, plus whatever answers Q23. The defect is unchanged; its blast radius inside this register is smaller | high | `12` §3.4, §3.6; `18` §6.4; `54` §14; `17` §10.1 |
| 14 | **Unrouted wall-clock in the diagram, today** | `11` §8.7's age bands and `56` §8.1's rendering compare `max(asserted_at)` against something neither document names. `71` X4.1 forbids wall-clock in the SVG and X4.7 requires the exported diagram to be byte-identical across builds. Both cannot hold. **Untouched by §4.4 and not to be read as fixed by it** — it was never caused by lifecycle dates | high | `11` §8.7; `56` §8.1; `71` §7.3 X4.1, X4.7 |
| 15 | **A time-derived state breaks `12` §6.6's incrementality proof** | The proof's step 2 requires the result to be a pure function of the values read, *"no ambient state, no clock"*. A state that changes because time passed produces no delta, invalidates no dependency key, and is never re-evaluated. **§3.8's completion action removes lifecycle from the set of things that trip this**: an explicit action produces an op, an op produces a delta, and a delta invalidates. The row stands as a constraint on anything that goes the other way | high | `12` §6.2, §6.6, §7.1; §3.8 |
| 16 | **`TxSource` cannot represent a bulk edit that `53` §7.2's own table already prices** | The table says eleven rows = one transaction labelled `dpd on 11 gateways`; the type names exactly one `FieldRef`; §7.3 lists bulk edit as undoable. **The type and the two tables disagree today** | high | `53` §7.2, §7.3 |
| 17 | **`33` §7.4 binds every bulk action structurally** | *"If a bulk action is unavoidable for class B, it must be scoped to class B by construction and must not be reachable from a screen showing class A conflicts."* Inventory shows every field class | high | `33` §7.4 |
| 18 | **`53`'s verb layer is single-target by construction** | Every graph-writing verb is singular; `⇧D` is *"Tombstone the selected **node**"*; `.` repeat excludes graph writes for a reason that applies harder to a set; `⇧P`'s type-to-confirm has no set form. ADR-0024 makes this `53`'s decision to re-run, not a build | medium | `53` §3.4, §3.6, §3.8; ADR-0024 |
| 19 | **Selection propagation is unbudgeted, and a bulk write has no budget at all** | `52` §5.6.3 proposed S1–S5 and `52` §14 asked `44` §3 to adopt them; `44` §3 does not contain them. `44` §7.2 names `O(N²)` invalidation over a bulk import as the adjacent measured hazard | medium | `52` §5.6.3, §14; `44` §3, §7.2 |
| 20 | **Bulk action collides with the live-region contract** | `55` §4.6 pins the findings panel at `polite` with a 2-second quiet window announcing only the net change, and states *"One `alert` role, product-wide"*, reserved for the egress state *"because it is the one thing that changes what leaves the machine"*. A bulk decommission clears and creates findings in bulk; the coalesced summary is correct for typing and wrong for an irreversible-feeling action. The confirm dialog is the right place for the count. `52` §9.5 forbids toasts outright, so nobody should "improve" it with one later | medium | `55` §4.6; `52` §9.5 |
| 21 | **A ticket reference cannot be a link** | `34` §9.4: *"the application renders no clickable external link, in any surface, ever"*, because a navigation is not a fetch and survives `connect-src`. **The inert form of C-02 is already the only permitted form**, which is why the owner's "not today for security reasons" is not merely scheduling | high | `34` §9.4; `23` §6.3 C3 |
| 22 | **Maintenance dates are the highest-value metadata channel in the threat model** | `31` §7.2's M5 is *"Time-of-day / day-of-week… and — the interesting one — out-of-hours activity, which correlates with change windows"*. Storing windows inside the ciphertext is fine. The exposure is in the artefacts designed to leave: `17` §15.5's `review` export header already warns *"THIS FILE IS A RANKED LIST OF THIS ESTATE'S WEAKNESSES, WITH THE SYNTAX TO FIX EACH ONE ATTACHED."* Adding scheduled decommission and maintenance dates makes it that **plus the calendar of when the network is least defended**. That deserves a line in `17` §15.3 and a row in `31` §7.2 | high | `31` §7.2; `17` §15.3, §15.5; `18` §6 |
| 23 | **Cheap now, a major bump later** | `schema.yaml` does not exist, nothing has been generated from it, and no user workspace exists yet. `11` §11.3 makes a new optional field a **minor** bump that old clients preserve. Changing its *shape* later — splitting one enum into two axes, tightening a cardinality — is a **major** bump, and `11` §11.4 states what that costs: *"an air-gapped user on an old single-file build cannot open a workspace a colleague saved with a newer major, and they may have no path to update."* The "etc" in the request is exactly the thing that will want to change shape | high | `11` §11.3, §11.4; ADR-0008; `73` D16 |
| 24 | **Preserve mode would let an old build emit a decommissioned device's full config** | `11` §11.4 puts a client reading a higher minor into preserve mode, where **emit is permitted** with a banner naming how many elements were not understood. A build predating the lifecycle field would not see it, would not exclude the element, and would produce a full change set for a device being retired — with a banner saying "14 elements not understood" rather than naming the problem. Preserve mode already refuses to write back suppressions for exactly this class of reason | high | `11` §11.1, §11.4 |
| 25 | **`DeltaClass` gains a field whose direction is arguable** | `18` §2.4 and OD-2 recommend `Unknown` by default and a label only where the direction is not arguable. Decommissioning tightens the attack surface and loosens the redundancy. Leaving it `Unknown` forever is fine and should be stated rather than discovered | medium | `18` §2.4, §10 OD-2 |
| 26 | **A bulk decommission spanning devices is a multi-device change set** | `18` §10 OD-3 marks that *"Not v1"* and notes it *"changes the ticket's shape and it changes what `aggregate_risk` means"*. C-03 lands directly on a decision already deferred for a stated structural reason | medium | `18` §10 OD-3 |
| 27 | **Third-party packs could key behaviour on a maintenance calendar** | If rules can read lifecycle, a pack can branch on it. `73` D11 keeps packs first-party in v1, so this is deferred rather than absent — but the pack signature envelope is frozen before D11 relaxes | medium | `73` D11; `63` |
| 28 | **C-05 lands on a `Refused` boundary, and the boundary's own test already contradicts four shipping documents** | `03` §4.10 `N-R-10`'s test is *"no field stores raw device configuration text beyond the current parse session"*, and `11` §8.4's `Capture.text`, `17` §4.2's class `0x13`, `17` §13.1's byte budget and `37` §2.2 row 20 all specify one that does. Two readings, opposite answers, and **`N-R-10` is cited by no other document in the repository** — nobody has noticed. This is a `03` §10.1 conversation and it gates everything else in §7 | high | `03` §4.10; `11` §8.4; `17` §4.2, §4.5, §13.1; `37` §2.2 |
| 29 | **A snapshot *series* multiplies the most sensitive artefact class, permanently** | `17` has no capture retention policy. Captures are the largest per-device byte class (`17` §13.1), `17` §12.5 exempts them from compaction and refuses to merge them, and `17` §13.5 plus §12.8 mean a blob deleted from the working tree survives in every clone's git history forever. `17` §13.6's rule applies directly: compaction in a git workspace *"is not a saving, it is a purchase"* | high | `17` §12.5, §12.8, §13.1, §13.5, §13.6 |
| 30 | **A time series is a threat-model dimension `31` does not have** | `31` §2.1 ranks what one config exposes and §2.5 places it at *"at rest, local"*. A series adds **when each thing changed**, and therefore when each window of exposure opened. `31` §12's CI checks and `14` §9.11's canary corpus both test for credentials, not for volume and not for temporal inference. It compounds with row 22 | high | `31` §2.1, §2.5, §12; `14` §9.11 |
| 31 | **A restore replayed from a stored snapshot cannot restore a `$9$` value, and nothing says so** | `14` §9 redacts Junos `$9$` at ingest because it reverses to plaintext with one command on the box, so a stored snapshot has a placeholder where the box had a key. `18` §5.4's Credentials row carries the right unsuppressible sentence for the **generated** rollback path. The snapshot-replay path is not specified, so it has no caveat at all — and a restore that silently omits the PSK fails at the first Phase 1 negotiation, on a box that is already down | high | `14` §9.4; `18` §5.4; §7.6 |
| 32 | **The invariant a reader quotes today forbids what C-05 needs, and the accepted amendment is unapplied** | ADR-0002 is `Accepted` and adopts *"A pasted capture may **contain** a credential; it is redacted at the ingest gate…"*. `.context/conventions.md` still carries *"The application never accepts a credential. No PSKs…"*. ADR-0011's amendment **was** applied to that file; ADR-0002's was not. Anyone reviewing C-05 against the conventions document will refuse it correctly and for a superseded reason | high | ADR-0002; ADR-0011; `.context/conventions.md` |
| 33 | **A procedure has no run record, because a ladder has none** | `18` §4.6 linearises a ladder to a rendering and stops — no cursor, no done-set. `52` §6.2's `WalkthroughRun` is the only per-run state in the product and it is `TaskId`-keyed. §3.8's completion button therefore has a home in the walkthrough and **no home at all in the ladder**, which is the surface a procedure would reuse | high | `18` §4.6; `52` §6.2 |
| 34 | **A procedure step writes nothing to the graph, so it has no undo unit and no armed rule** | `52` §6.2's `AnswerRecord.tx` is *"what makes a step undoable as a unit"*, and `53` §7.3 puts undo over graph transactions. Ticking off *"I ran the reboot"* produces no ops, so there is no `tx`. The same absence removes `armed_rules` — `52` §6.4's findings-inline-as-you-go is the walkthrough's flagship safety behaviour, and it is structurally unavailable on exactly the surface where `Disruptive` commands reach the clipboard one click at a time | high | `52` §6.2, §6.4; `53` §7.3 |
| 35 | **The pointer affordance the owner asked for is refused by a written rule** | `54` §8.7 rule 4: *"A per-line copy exists inside the provenance panel (§17), not on the line itself. A copy button on every line would put a control in the gutter and the gutter belongs to the line number."* So the only pointer route to a per-line copy is inside the disclosure a teaching-off posture would suppress. The keyboard path (`54` §8.8, `⌘C`) is unaffected, which makes this narrow and real rather than fatal | medium | `54` §8.7, §8.8, §17 |
| 36 | **Teaching-off cannot be a fourth `Depth`, and there is no other control idiom for it** | `15` §6.3 forbids a fourth by name in the type comment; `17` §10.1's `Settings.depth` is that enum; `15` §11.3's resolution ladder is written over exactly three values; and `52` §4.3 keeps the depth control deliberately setting-free. A posture is therefore a second, orthogonal axis with no existing home, no idiom, and no slot in `52` §9.6's 14-fact scent budget without displacing something | high | `15` §6.3, §11.3; `17` §10.1; `52` §4.3, §9.6 |
| 37 | **An operational procedure surfaced through the finder is ranked down by a safety control** | `16` §8.3's prior is `ReadOnly +0.05, ChangesConfig −0.10, Disruptive −0.25`, and the document states it is *"a safety control, not a relevance signal"*. An upgrade procedure is mostly `ChangesConfig` and `Disruptive`. Nothing here is wrong; it is a collision between two correct designs, and it is cheaper to notice now than to discover as a ranking bug | medium | `16` §8.3; `61` §10.1 |
| 38 | **Reusing the `Ladder` type drags `61` §10.2's containment gate onto every operational verb** | *"If a command entry is a step in any ladder, its `next_if_bad` must be a subset of that ladder's `on_fail` targets. CI gate 11."* A verb appearing in three procedures is constrained by the intersection of three `on_fail` sets — a real authoring cost that appears only under the reuse framing, and that the new-type framing avoids at a different price | medium | `61` §10.2 |
| 39 | **Overlay colour lands on a spent channel budget, and the accounting is already written** | `56` §5.2: *"one channel, one meaning, and nothing may be added to it without taking something away."* `59` §4.5's measurement is why the overlay form survives at all — the hue is free; the carrier that makes the hue legal is what costs — and G1 already owns tone, so any palette must stay near-isoluminant (`59` §5.7 rule 3). G10 carries the active mode's name so the mode is never invisible state, and `52` §9.3 rule 3's two-fact cap on the band tab applies to it | high | `56` §5.2; `59` §4.5, §5.3, §5.7; `52` §9.3 |
| 40 | **A user-picked colour is invisible to both of `51` §3.3's lints** | `tokens/reserved-colour` and `tokens/no-raw-hex` are build-time checks over stylesheets; a customisable category colour is runtime data no stylesheet contains. The guardrails move from build time to input time — validate at pick: clear of the reserved trio, near-isoluminant, contrast-checked both themes — and `59` §5.7 anticipates renderer-side enforcement but nothing specifies validation of arbitrary user values. `59` §5.3 measures the shelved palette's clearance (closest approach 44.9° light, 42.3° dark) and declares no minimum for a user value; what number "clear of the trio" means is part of the unwritten rule, not this register's to set | high | `51` §3.3; `59` §5.3, §5.7 |
| 41 | **The forced-colours base defect is inherited by any overlay built on it** | `59` §6.1: `forced-color-adjust: none` on five diagram classes, contradicting `51` §6's *"exactly once in the product"* and `55` §7.3's *let the UA win* — plus `59` §5.6's specificity bug, where the fallback loses to the dark override in Windows High Contrast Black, the common case. Both are cheap, both are known, and both must land before any colour mode or the mode ships broken on high-contrast desktops | medium | `59` §5.6, §6; `51` §6; `55` §7.3 |
| 42 | **"Maintenance" the category and Maintenance the lifecycle state are one datum or two systems** | If the overlay category is free-form, one word gets two homes with two update paths — the decommission-versus-tombstone collision (§3.2, row 12) re-run at the rendering layer. If it is C-01's field rendered, the category list inherits C-01's open enumeration (Q3) and its blockers | high | §3.2; §9.3; §14 Q38 |
| 43 | **Annotations and pockets meet merge from the first git merge, like everything else** | §1.6's discipline applies: as workspace records they run `11` §8.6's ladder via `fathom merge --resolve` (`17` §12.4) — `Hand` against `Hand` resolves by step-3 recency, last-writer-wins — and they need a `33` §6.4 class when the CRDT half wakes (a pocket's member set is class-E-shaped; `merge.set.widened` exists). An annotation whose anchor element is re-parsed away is ADR-0010's orphan problem a third time (§3.5) | high | `11` §8.6; `17` §12.4; `33` §6.4, §6.8; ADR-0010 |
| 44 | **A stencil-built plan is a standing wall of `Divergent` findings** | `11` §10.5 makes a `Hand` node missing from a `Whole`/`Section` re-parse `Divergent { since }`, which raises a finding — correct for one intended-but-undeployed gateway, noise at forty planned nodes. The answer is not quieting findings (row 3's constraint holds); the honest framings are a scoped view (§11) or a `Divergent`-aware rendering, and neither is chosen here | medium | `11` §10.5; §10.3; row 3 |
| 45 | **A pocket is an ambient filter, and the product's honesty machinery assumes filters are momentary** | `52` §5.8 row 5's furniture — `FilteredOut` reasons, full-count confirm text — was built for one selection against one filter. A pocket makes the mismatch standing: findings counts inside a pocket, bulk actions that reach past its edge, and `33` §7.4's by-construction scoping all need the pocket named in the surface, or the panel lies by omission (row 2's failure, ambient) | high | `52` §5.8; `33` §7.4; §11.3 |

---

## 14. What the owner must decide

*margin tab: the questions nobody asked*

Each row is a candidate `Dnn` for `73`. **None is answered here**, and each is stated so that a
yes/no or a pick-one answers it, which is `73` §1.1's admission test.

| # | Question | Why it must be answered before anything is built |
|---|---|---|
| **Q1** | Is lifecycle a **schema field** — in `schema.yaml`, generated into the node body, readable by `fex`, present in `FieldDelta`, in the generated column picker, with a `FieldClass` — or a **node-level attribute** like `absent_since`? | Everything else depends on it, and it must be taken before `62-schema-spec.md` is written. §13 rows 1 and 10 |
| **Q2** | One axis or two? A lifecycle stage and a transient operational state are different things | Folding them means an element in maintenance cannot also be scheduled for decommission, which is the most common real combination. Fixing it later is a major bump (§13 row 23) |
| **Q3** | What is the full enumeration? The owner named two and said "etc" | Each state is a row in every emit-behaviour table and every merge matrix. §3.3 lists candidates |
| **Q4** | Does a decommissioned element still emit — nothing, `delete` lines, or `deactivate` lines? Per-state or per-element? | `13` §2.4 makes the answer per-state, which means the emitter needs a per-state line form rather than a boolean |
| **Q5** | What happens on PAN-OS and IOS-XE, where `deactivate` is already `Unrepresentable { NoFeature }`? | A permanent `NOT EMITTED` block on the second platform is honest and looks like a defect |
| **Q6** | Does a decommissioned element still lint? If findings are withheld, is that a `Suppression` or a new mechanism? | If it is a new mechanism, what stops it becoming the unaudited suppression path `12` §17 D-6 exists to prevent |
| **Q7** | Is lifecycle a per-rule concern or a global engine policy? | Per-rule means every rule needs a position and an `acceptable_when` that accounts for it (invariant 8 makes `acceptable_when` mandatory). Global means one policy plus a `63` override |
| **Q8** | **Who sets `workspace.as_of`, where is it stored, does it merge, and does it advance on open?** | Referenced by `12`, `18` and `54` §14's suppression countdown; defined nowhere. If it advances from the system clock, an untouched workspace stops reproducing its own change ticket. **No longer gates C-01 or C-02** (§4.4), and still gates Q23 |
| **Q9** | ~~Does a maintenance window expire by itself, or is "past its stated end date" a finding computed against `as_of`?~~ | **ANSWERED BY THE OWNER — nothing expires by itself.** §3.8 and §4.4. Lifecycle transitions are driven by an explicit completion action; dates are stored values, never compared. The residue is Q23 |
| **Q10** | Do `11` §8.7 and `56` §8.1's age bands compare against `as_of` or the system clock? | Already ambiguous, already in tension with `71` X4.1 and X4.7 |
| **Q11** | **(a)** Is `11` §8.6's last-writer-wins step 3 acceptable for a lifecycle value when two clones of a git-synced workspace diverge? **(b)** Which `33` §6.4 class is lifecycle, and is `absent_since`'s assumed class B actually right? | **These have different due dates and must not be answered as one.** (a) is live from the first git merge — phase 0 machinery, phase 2 exposure (§1.6, §13 row 11). (b) is dormant while ADR-0016 stands. Class B *is* a register, so (b) is a suitability question — whether lifecycle is descriptive enough for LWW — not a structural one |
| **Q12** | Is "decommissioned" the same thing as "tombstoned", or a second independent absence? If both, what do the four combinations mean? | §13 row 12 |
| **Q13** | Can **edges** carry lifecycle, or only nodes? | `Node` has `absent_since`; `Edge` does not. "Decommission this link" and "this tunnel is in a maintenance window" are both things people will want |
| **Q14** | Is the ticket reference free text or a validated pattern, and one per element or many? | Many means a set-valued field, `33` §6.4 class E, and the `merge.set.widened` finding |
| **Q15** | Do the ticket reference and the maintenance window appear in the change ticket (`18` §6) and the plaintext export (`17` §15)? | Those artefacts leave the encrypted workspace. If yes, `17` §15.3's gate and `31` §7.2's channel list both need a line |
| **Q16** | Is `52` §12 **D3** now decided in favour of bulk edit? If yes: what does the confirm say when part of the selection is filtered out, and does it refuse outright when the selection spans a class A conflicted field? | `33` §7.4 makes the refusal path structural |
| **Q17** | What is the undo story for a bulk lifecycle change across a merge, given `53` §7.5's report-and-skip rule? Is partial undo permitted here, or must it be all-or-nothing? | §5.5 |
| **Q18** | Which key, and which gate? `⇧D` and `⇧P` are the two nearest neighbours and both are taken | And is the lifecycle verb excluded from `.` repeat (`53` §3.6)? |
| **Q19** | What happens to a decommissioned element's suppressions, findings, diagram position, provenance and layout pin? | `11` §10.6 answers this for renames. There is no equivalent table for retirement |
| **Q20** | Does the CLI get an `--as-of` flag? | `fathom lint` in CI reading a clock is a test that fails once a year |
| **Q21** | Should preserve mode still permit emit once lifecycle exists? | §13 row 24. Preserve mode already refuses to write back suppressions for the same reason |
| **Q22** | Which phase does this land in? | It touches `11`, `12`, `13`, `17`, `18`, `52`, `53` and `56`. Schema and emitter are phases 1–3; inventory and bulk are 2–3; merge semantics are 5. **Deciding it is one feature and scheduling it as one feature will not survive contact with `71`'s phase boundaries** |

**Questions raised by the four clarifications.** Q23 is the residue of the date answer; Q24–Q29
belong to C-05; Q30–Q35 to C-06.

| # | Question | Why it must be answered before anything is built |
|---|---|---|
| **Q23** | May a rule compare a stored lifecycle date against `workspace.as_of` and fire a finding? | §4.4. *"Nothing computes overdue"* is unambiguous about the **clock**; `12` §3.4 licenses the shape *"this cert expires soon"* against a workspace-supplied date, which needs no clock and is deterministic. These are not the same statement and the corpus does not distinguish them. Downstream of Q8 |
| **Q24** | **Is `03` §4.10 `N-R-10`'s test read as "no raw configuration text at all" or "no **pre-redaction** raw text"?** | §7.3. Under the first, `11` §8.4's `Capture.text` is already a violation; under the second, the ingest gate already satisfies the boundary and C-05 may be in scope today. **The two readings give opposite answers and nothing in the corpus picks one.** This is upstream of every other C-05 question |
| **Q25** | Is `N-R-10` retired, clarified, or left standing? | `03` §10.1's procedure: an issue arguing the boundary is *wrong* rather than the feature useful, a named `03` §5.1 clause, two maintainers, an ADR, and the amendment landing in the same PR as the first line of implementation. It is a boundary conversation, not a feature conversation |
| **Q26** | Which restore is being asked for — the platform fallback (`rollback 1`, a per-platform constant) or generated inverse lines (`18` §5, both sides parsed into graphs)? | §7.5. Two features, an order of magnitude apart in cost, and the owner's sentence covers both. The second is bounded by dictionary coverage and is gated on `18` OD-1 |
| **Q27** | **`18` OD-1**, unchanged and now load-bearing: is the diff computable against a pasted running config as a first-class mode — and what is the *statements-we-did-not-understand* count and the threshold above which it refuses? | OD-1's own objection is *"a diff that reports 40 spurious changes because we do not model 40 statements is worse than no diff"*. C-05 turns OD-1 from an option into a prerequisite |
| **Q28** | How many snapshots per device are kept, and does anything ever delete one? | §13 row 29. `17` has no capture retention policy, compaction never touches captures, and a deleted blob survives in git history in every clone forever |
| **Q29** | Does `show configuration \| display set` become a command entry, a filter entry, or both? And does the snapshot-restore path carry the `$9$` caveat? | `61` §2 puts `\| display set` under `filters/`, §17 says filters are explained separately, D4 leans *Separate*, and the seed corpus ships no `filters/` file. The `$9$` half is §13 row 31 |
| **Q30** | **Is an operational procedure a new authored type, or a generalisation of `Ladder` plus a run record?** | §8.3. Three deltas to one existing type against a fourth artefact with its own YAML form, CI gates, review pipeline and version-drift story. Not answerable from the corpus alone |
| **Q31** | Does teaching-off change what is **rendered**, or only what is **copied**? | If only copied, `53` §6.3's two payloads and `71` §3.5's legend already answer it and no posture state is needed. The owner said the whole interface changes register, which is the first — and the first has no control idiom |
| **Q32** | **Does teaching-off suppress `blast_radius`?** | `61` §4.2 calls it *"mandatory, and it is the whole point"*, and it is prose, which is what a posture suppresses. `15` §3.3's *"Depth controls explanation, never warning"* answers it for depth and has never been asked of a posture. **This is the question where a wrong answer drops live traffic** |
| **Q33** | Where does the posture value live — local per-machine settings or workspace `Settings`? | `15` §11.3 holds both precedents in one section and they point opposite ways. Its DECISION was written against exactly the failure a shared teaching-off posture would cause |
| **Q34** | Which of `52` §9.6's 14 facts does a visible posture displace? And which view is it a mode of, given `52` §9.5 forbids a seventh? | *"Adding a fact to the header means removing one."* An invisible mode is `53` §2.2's *"No mode errors"* rule waiting to be broken |
| **Q35** | Does a procedure need `armed_rules`, and what does un-ticking a step do? | §13 row 34. A step that writes nothing has no `tx`, so it has no undo unit, and there is nothing for a rule to fire against |

**Questions raised by the fifth batch.** Q36–Q38 belong to C-07; Q39 to C-08; Q40–Q41 to C-09.
§2.4's standing constraint raises no question of its own — it is an instruction, not a fork.

| # | Question | Why it must be answered before anything is built |
|---|---|---|
| **Q36** | **Where does an annotation live** — session state, or a workspace record class — and does it sync? | The owner licensed either (*"temporary or permanent doesn't matter"*), and the format cannot ship "either". A record needs a `17` §4.2 class, runs `11` §8.6's ladder on every git merge, and needs a `33` §6.4 class when the CRDT wakes (§13 row 43); session state needs §2.4 point 1's deliberate statement that it is session-local |
| **Q37** | **Who defines the colour categories, and where does the list live** — per-user local settings, or per-workspace policy in the shape `19` §8's `Policy` record designed? | Q33's fork a second time, with a new home available. A local palette means two people read different colours for one category; a workspace palette means `17` §10.2's fight on every sync unless it is policy, not preference. §9.4 |
| **Q38** | **Is "Maintenance" the category C-01's lifecycle state rendered, or a free label?** | One datum or two systems (§13 row 42). If it is the field, the mode machinery consumes Q1–Q3's answers; if it is a label, the same word diverges in two places and the register has recorded how that ends (§3.2) |
| **Q39** | **Which kinds and roles get stencils, and does `Device.role`'s enum grow?** | The owner said *"etc"* and `role` is a closed five-value enum ending in `other`. Growth is a schema bump under `11` §11.3 — cheapest today, a major-bump risk after phase 1 (§13 row 23's argument, transferred) |
| **Q40** | **Where does a pocket persist, and is it private?** | `52` §5.7 makes selection deliberately un-persisted and un-synced; a pocket that syncs is a shared viewport one step from the shared cursor `52` §5.7 refuses. Session, local settings and workspace record give three different products; §11.5 item 1 |
| **Q41** | **Inside a pocket, do findings and counts show the pocket's numbers, the estate's, or both?** | One of the answers is a lying panel and which one depends on what the surface says about its own scope (§13 row 45). The confirm-text rule for bulk actions (`52` §5.8 row 5) must name what the pocket hides |

---

## 15. Nearly free versus large

*margin tab: the cost is in the state model, not the feature*

> **THE FEATURE IS CHEAP. THE STATE MODEL IS EXPENSIVE. ALMOST ALL OF THE COST IS IN THREE DECISIONS**

`71` §14 states that every number in it is a planning assumption rather than a measurement, and its
smallest unit is the person-week. Nothing below is priced more finely than that, and where the
corpus gives no figure this section says so rather than inventing one.

### 15.1 Nearly free, because the corpus already built it

| Item | Why it is nearly free | Unit, where one exists |
|---|---|---|
| **The removal emitter** | `LineForm::Retract`, `Deactivate`/`Activate`, `Idempotency`, `retract_needs_value` and `Reversibility` all exist in `13` §2.4–2.6. `18` §3.3 computes removals; §3.5 minimises them with `subsume`; §5 generates rollbacks. Exclusion-from-emit already exists for tombstones | None in the corpus. It is wiring, not a subsystem |
| **Dates** — no longer conditional | The owner answered the fork (§4.4): a date is a stored value, never compared. That is a field, a display and a sort key. Nothing derives, nothing sweeps, nothing schedules, and `workspace.as_of` is not on the path. **The precedent is already rendered on every finder row** — ADR-0027's `verified 2026-05-12` stamp | Below `71`'s granularity |
| **The completion action** | `52` §6.2 already specifies `RunState::Completed { at: Timestamp }`, `started_at` and `AnswerRecord.at`, and `52` §6.2's own comment makes run state *"ordinary ops (`33` §5.1), so it syncs and merges"*. The pattern is written; only the anchor differs (§3.8) | Already specified for the walkthrough |
| **The platform-fallback restore** (C-05a) | `18` §5.6's `GuardPolicy` and §7.5's rendered block already print `rollback 1` / `commit` in every Junos ticket. It is a per-platform constant lookup, not a generator run | — |
| **Teaching-off as a copy payload** (C-06a) | `53` §6.3 already specifies both payloads on two keys and `71` §3.5 renders the legend in the phase-0 mock. **This one is not nearly free; it ships** | Ships |
| **Block-as-a-unit copy** | `53` §6.3's payload table already covers config blocks, multi-line selections in emit order, and ladders numbered one per line; §6.3.1 and `54` §8.2 rule 2 fix display-versus-clipboard | Already specified |
| **The risk legend surviving a posture change** | `54` §6's placement rule is unconditional — every view rendering a `Risk`, below the masthead, *"never collapsed, never behind a disclosure"* — and `54` §8.1's `.risk-bar` is part of the config block's own structure rather than of any explainer surface | Already specified |
| **Rule visibility** | Free if lifecycle is a schema field. A new builtin plus an engine release if it is not (`12` §3.7) | — |
| **The schema field itself** | A new optional field is a minor bump old clients preserve (`11` §11.3), and no user workspace exists yet. **It will never be cheaper than it is today** | — |
| **The diagram** | `56` §12 already reaches the answer for structurally identical problems, and G10 plus a filter costs nothing | — |
| **Multi-select gestures** | `52` §5.4 already specifies them, including the deliberate refusal of cross-view range select | Already specified |
| **The safety furniture for an invisible selection** | `52` §5.8 row 5 and §9.4 already specify `3 of 11 selected are filtered out` and the full-count confirm requirement | Already specified |
| **Undo granularity for a bulk edit** | `53` §7.2 already specifies one transaction and the label grammar (`dpd on 11 gateways`) | Already specified |
| **The ticket string in the clipboard** | `34` §6.3 already carries `# Fathom — change block for CHG-2026-0211` | Ships |
| **The privacy inventory row** | One row in `37` §2.2, plus optionally one rule in the shape `37` §2 already drafts | Below `71`'s granularity |

### 15.2 Large, and mostly not where it looks

| Item | Why it is large |
|---|---|
| **`62-schema-spec.md`** | ADR-0008's own figure: *"two to three weeks of specification plus the codegen"*, already on the critical path for phases 1–3 and **absent from `71`'s phase table**. Every field-shaped entry in this register queues behind it |
| **Giving `workspace.as_of` a home** | Twelve lines of struct. It decides whether an unchanged workspace reproduces its own change ticket, its own findings and its own SVG. Small in code, large in consequence, upstream of every date decision |
| **Bulk action as a first-class verb** | Not the loop. The confirm surface that counts from `set` rather than from what is rendered; the refusal path when the selection spans a class A field (`33` §7.4); partial-undo semantics across a merge (`53` §7.5); the announcement without spending the product's one `alert` role (`55` §4.6); and flipping `52` §12 D3. **This is the expensive half of the request, and the owner correctly identified it as load-bearing** |
| **Per-state, per-platform emit behaviour** | Every combination needs a `Representability` classification with a citation and a named reviewer, and `13` §9.2 already records `deactivate` as unrepresentable on both other platforms — so the second platform gets a permanent gap block |
| **Reconciling decommission with tombstone** | Two absence concepts, two merge rules, one `Purge` path covering one of them, and a four-cell matrix. The two framings §3.2 names price differently: subsuming tombstone into lifecycle is a bigger edit to `11` §10.5 and `33` §5.1 up front and leaves one absence concept; keeping them distinct is a smaller edit and leaves the four-cell matrix to be given meaning, which is Q12's cost rather than this table's. **Which is preferable is Q12 and is not answered here** |
| **Per-rule lifecycle policy** | A global engine policy is one field. Per-rule is a re-review of every rule's `acceptable_when` and grows with the corpus, which `71` identifies as the project's longest pole |
| **Anything that makes a state time-derived rather than human-asserted** | It reopens invariant 9, requires ADR-0002's amendment process, and `12` §6.6's incrementality proof has to be re-argued. **Q9 is answered and nothing in C-01 or C-02 is time-derived (§3.8, §4.4), so this row is now a constraint on future proposals rather than a price on a live option.** It is kept, not struck through, because the cheapest-looking future shortcut is exactly the thing it forbids |
| **The lifecycle annotation surface as a component** | Comparable, not an estimate: `71` §6.6 prices *"suppression lifecycle and review view"* at 1–1.5 solo weeks. `54` §14 is the same component family, and **two of its three non-negotiables transfer intact** — the mandatory `unverified — workspace-local text, not an identity` tab, and the reason quoted in full and never `line-clamp`ed. **The third does not: `54` §14 renders expiry as a countdown, and §4.4 records that lifecycle dates deliberately diverge from it.** A component built by copying `54` §14 wholesale would import the countdown and therefore import a reference date the owner said is not needed |
| **Retiring or clarifying `03` §4.10 `N-R-10`** (C-05) | Not code at all, and it gates everything in §7. `03` §10.1's procedure needs a written argument that the boundary is *wrong*, a named `03` §5.1 clause, two maintainers, an ADR and a struck-through register row. **And §7.3 says the argument has to start by settling what the boundary's own test means**, because it already contradicts `11`, `17` and `37` |
| **A snapshot series, once the boundary allows one** (C-05b) | Not the storage — `17` §4.5 gives write-once content-addressed captures for free. The cost is retention policy against a substrate that has none, in a format where deletion is not deletion (`17` §12.8, §13.5), on the largest and most sensitive per-device byte class, plus `31`'s missing temporal-inference dimension (§13 rows 29–30) |
| **Generated restore lines from two snapshots** (C-05b) | Both sides must be parsed into graphs, so the feature's quality is bounded by dictionary coverage rather than by the generator. `18` OD-1 already names the failure mode and already says it needs an unrecognised-statement count and a refusal threshold that do not exist |
| **A run record for an ordered procedure** (C-06b) | `52` §6.2's `WalkthroughRun` is the only per-run state in the product and it is `TaskId`-keyed. Generalising it is the cheapest honest route and it reaches into `17` §4.2's record taxonomy. **The genuinely expensive part is not the record — it is that a step writing nothing to the graph has no `tx`, so it has no undo unit and no armed rules** (§13 row 34) |
| **A product-wide posture** (C-06b) | Not a boolean. `15` §6.3 forbids the cheap implementation by name, `52` §4.3 kept the adjacent control deliberately setting-free, `52` §9.6's 14-fact budget means a visible posture displaces something, and `53` §2.2 forbids an invisible one. Four documents have to agree before it has a home |
| **Corpus authoring for backup, restore and upgrade verbs** | `71` identifies the corpus as the project's longest pole, and this is a block of entries in a file that currently has 98 and none of these. **No new machinery** — `61` §3.7's fields cover them — but every entry needs `blast_radius`, `reversible`, `commit_model`, a risk band assigned by effect, and a named reviewer under invariant 10 |

### 15.3 The asymmetry worth stating

**The feature is cheap. The state model is expensive.** For C-01 and C-02 the cost sat in three
decisions — Q1 (schema field versus node attribute), Q2 (one axis or two) and Q9 (asserted versus
derived dates). **The owner has now answered Q9, and answered it the cheap way**: asserted, stored,
never evaluated. Two remain. Neither is a line of code, both are nearly free to get right today, and
both are a major schema bump to correct after phase 1 (`73` D16), aimed squarely at the air-gapped
users `11` §11.4 says have no update path.

**C-05 and C-06 do not follow that shape, and saying so is the point of this subsection.**

| | Where the cost sits | Why it is a different shape |
|---|---|---|
| **C-01, C-02** | Two schema decisions | The engineering is small and the data model is the whole risk |
| **C-05** | **A refused boundary and a retention policy** | The engineering is largely built and phase-3-scheduled for other reasons (§7.4). Nothing is blocked by code. It is blocked by `03` §4.10, and by the fact that nobody has decided what `03` §4.10's own test means |
| **C-06** | **A missing program type and a missing posture axis, plus authoring** | Half of what the owner asked for already ships as a clipboard payload (§1.6). The other half needs a third kind of authored program that no document owns, and a posture that four documents have to agree on before it has a home |

**RECOMMENDATION — do not schedule these four as one programme of work.** Q22 already warns that
deciding C-01 as one feature will not survive contact with `71`'s phase boundaries; C-05 and C-06
make that worse, because their blockers are a boundary retirement, a corpus-authoring backlog and a
type that does not exist — three different kinds of thing, owned by three different documents, with
no shared critical path.

---

## 16. Failure modes of this register

*margin tab: how a register rots*

| # | Failure | Symptom | Control |
|---|---|---|---|
| 1 | **It becomes a wish list** | Entries accumulate and none leaves. Nobody reads it, because a document with no exits carries no information about what is actually going to happen | §1.3's four proposed exits, checked at every phase boundary. A disposal rule is proposed alongside them — an entry that has not moved through two consecutive reviews becomes a candidate for the *killed* exit rather than a third review — and like the rest of §1.3 it is offered to `73` §10 rather than enacted here |
| 2 | **It becomes a specification by accretion** | An entry gains a type, then a component contract, then an enum, and a future reader treats the register as authority. This is the most likely failure, because writing the specification is more satisfying than writing the constraint | §1.2's table, and one review question: *does any entry contain a thing another document owns?* ADR-0001 makes ownership checkable |
| 3 | **It is read as approval** | Somebody finds C-04 and reads "planned" where the document says "refused". This is the failure with the largest consequence, because it is the one that would end with a network request in the artifact. **C-05 adds a second and quieter instance**: `03` §4.10 `N-R-10` is `Refused` too, but it is refused on storage rather than on egress, so nothing in the build catches a breach of it | §6's heading, the `NOT APPROVED` margin tab, and the register table in §1.5. For C-05, §7.2 states the refusal before any of the engineering, and §7.3 states that the boundary's own test is already contradicted — a reader who skips to §7.4 and starts building has skipped the two subsections that exist to stop them |
| 4 | **It duplicates `73`** | An entry becomes a well-formed fork and stays here anyway, so the same question has two homes and they drift | The *forked* exit is the intended one. When an entry becomes answerable, it moves and this row is struck through with a pointer |
| 5 | **Its cost claims rot** | The "nearly free" column ages badly: `18` §5's rollback generator changes shape and §15.1 still says the emitter is free | Every §15 claim names the document and section it rests on, so the claim breaks visibly when that section changes |
| 6 | **The standing priority instruction is read as licence to re-litigate** | Every settled decision gets reopened because "sunk cost is not an argument", and the project stops converging | §2.2's second column, and the rule that a reopening needs either a fired `Revisit if` trigger or a new requirement — not a new opinion |
| 7 | **The *original* governing instruction is paraphrased, not quoted — and this one is live now, not hypothetical** | §1.2 states the owner's "record, do not act" instruction, as it arrived with the four capability requests in §3.1, §5.1 and §6.1, in this register's words rather than the owner's. §2.1 names the mechanism by which that decays: *"paraphrasing a governance instruction is how it decays"* — the paraphrase gradually becomes the instruction, and the boundary it draws moves with whoever restates it. Every other owner input in this document is quoted verbatim (§2.1, §2.4, §3.1, §3.8, §4.4, §5.1, §6.1, §7.1, §8.1, §9.1, §10.1, §11.1); the one that defines the document's licence to exist is not. **This is one statement, not two.** An earlier draft reported the defect as doubled on the ground that the restatement accompanying the four clarifications was also a paraphrase. It is not — that restatement is now quoted verbatim in §1.2, *"these are just plans btw don't act on the new stuff atm"*, and §18 carries it as a citation | Replace §1.2's remaining paraphrase with the owner's words at the next opportunity. **Do not reconstruct them** — an invented quotation would read as evidence and would be worse than the gap. The restatement does not close this row, because *"the new stuff"* names the four clarifications rather than the original four requests. Until then, §1.2 carries the admission and §18 records the original instruction's source as a paraphrase rather than a citation |

---

## 17. Open decisions this register raises and does not answer

These are the forks this document surfaces. They belong in `73` §2 with an `R` value and a latest
responsible moment, and **this document does not put them there** — that is an edit to `73`, which
is not this document's to make.

| Raised | Where it lands | Note |
|---|---|---|
| Q1–Q22 (§14) | `73` §2, as `Dnn` rows | Q1, Q2 and Q8 gate the others. **Q9 is struck through — the owner answered it** (§3.8, §4.4) |
| **Q23–Q35 (§14)** | `73` §2, as `Dnn` rows | Raised by the four clarifications. **Q24 gates all of C-05** and is a `03` conversation rather than a `73` one; **Q32 is the one where a wrong answer drops live traffic** |
| **Q36–Q41 (§14)** | `73` §2, as `Dnn` rows | Raised by the fifth batch. **Q36 and Q40 are the two that §2.4's constraint refuses to leave unstated** — new state says whether it rides the op log or is session-local; Q38 is C-01's enumeration seen from the rendering side |
| **Whether `59` §4.1's no-colour DECISION is reversed to the overlay tier** | `59`, through §4.7's gate or by the owner's explicit decision — recorded there, not here | The reversal shape is pre-written in the DECISION block itself and the palette is measured and shelved in `59` §5, so reversing costs a decision and not a rebuild. This register records the intent and cannot fire the gate. §9.3 |
| **Whether `03` §4.10 `N-R-10` is retired, clarified, or left standing** | `03` §10.1's retirement process | Its *"Reopens if"* cell names one door — *"A user-initiated, explicitly-labelled attachment is a §10 amendment, not a default"* — and the owner's loop is user-initiated. §7.2 |
| **What `N-R-10`'s test actually means, given that `11` §8.4, `17` §4.2 and `37` §2.2 row 20 already contradict its literal reading** | `03` §4.10, as a clarification — or `11`/`17`, if the test is right and they are wrong | **Not caused by this register.** `N-R-10` is cited by no other document in the repository, so nobody has had to reconcile it. §7.3, §19 item 8 |
| **`18` OD-1 — diff against a pasted running config as a first-class mode** | `18` §10, unchanged | C-05 turns it from an option into a prerequisite, and its unanswered sub-question is the unrecognised-statement count and the refusal threshold. §7.5 |
| **`14` §16 D3 — adopt `CaptureIntent { Observed, Intended }`** | `14` §16, then `11` §8.4 | Leaning *"probably yes"* already. A backup snapshot is unambiguously observed, which makes D3 load-bearing rather than tidy. §7.9 |
| **Whether an operational procedure is a new type or a generalisation of `Ladder`** | `18` §4, which owns the ladder type per `61` §10's delegation | Q30. It also decides whether `61` §10.2's containment gate lands on every operational verb |
| **Where a teaching-off posture's value lives** | `15` §11.3 and `17` §10.1–10.2 | Two precedents in one section pointing opposite ways. Q33 |
| **Whether a corpus surface's default audience is a choice or a habit** | Nowhere yet — §12 proposes it as a review question rather than as work | §12. It is a lens, not a project, and a project to "balance the corpus" would have no exit criterion |
| Whether `03` §4.3 `N-R-3`'s test permits an estate-state field | `03` §10.1's retirement process, or a clarification that it was never in scope | The `Reopens if: Never` cell means this is a boundary conversation, not a feature conversation |
| Whether `03` §4.2 `N-R-2` is already bent by `absent_since` and `Divergent` | Same | The parsed-versus-asserted distinction is the thing to test |
| Whether `52` §12 D3 flips | `52` §12, and then `73` if it needs an `R` | §5.4 |
| Whether `44` §3 adopts S1–S5, and what a bulk-write budget measures | `44` §3 | `52` §14 asked once and nothing happened |
| Whether `11` §17 #4's answer differs for a second kind of annotation | `11` §17 | §3.6 blocker 6 |
| Whether `11` §6.2's implicit `notes: [Text]` exists | `11` — a straight contradiction with §13, needing an edit either way | §3.4 row 1 |
| Whether `absent_since` is really `33` §6.4 class B | `33` §6.4, or `53` §16's proposed change | `53` §16 asserted it in passing and nobody checked. Class B *is* structurally a register, so the question is whether lifecycle-ish state is descriptive enough to accept LWW — not whether B fits mechanically. §13 row 11 |
| **Whether `11` §8.6's step-3 recency tiebreak is acceptable for a lifecycle value across a git merge** | `11` §8.6, or `33` §6.3's proposed amendment to it extended beyond class A | **Due in phase 2, not phase 5.** `17` §12.4 runs this ladder on every `fathom merge --resolve`, and ADR-0016 keeps that path in phases 0–3. `33` §6.3 already amends §8.6 for class A on exactly this ground and scopes itself there deliberately. §1.6, §13 row 11 |

---

## 18. Sources consulted

| Claim | Source |
|---|---|
| The owner's four capability requests, verbatim | Owner, in conversation. C-01 and C-02 quoted in §3.1; C-03 in §5.1; C-04 in §6.1 |
| **The owner's clarification on lifecycle dates and the completion action, verbatim** — *"I like the decommission idea as long as it includes what I wanted and we don't need a now, we only need a date for when events need to happen. maybe a button to complete out that task, etc."* | Owner, in conversation, after this register was first written. **Quoted in full twice, at §3.8 and at §4.4**, because the two halves are read by different people. It supplies clarifications (1) and (2) |
| **The owner's clarification on config backup, verbatim** — *"oh! maybe we can have config backups and such as well…"* | Owner, in conversation, after this register was first written. Quoted in full at §7.1. It supplies C-05 |
| **The owner's clarification on teaching-off and operational procedures, verbatim** — *"wait no you misunderstood, fathom is a teaching device but also make a person's life easier device…"* | Owner, in conversation, after this register was first written. Quoted in full at §8.1. It supplies C-06 and the observation in §12 |
| The standing priority instruction — prior work does not constrain future quality | Owner, in conversation, quoted verbatim in §2.1 |
| **The restatement of the "record, do not act" instruction, verbatim** — *"these are just plans btw don't act on the new stuff atm"* | Owner, in conversation, alongside the four clarifications above. **Quoted in full at §1.2.** *"The new stuff"* is those four clarifications, so this is the governing instruction for C-05, C-06 and both halves of the date answer. It is not a record of how the original instruction was worded |
| The same instruction **as it arrived with the original four capability requests** (§3.1, §5.1, §6.1) | Owner, in conversation. **Paraphrased in §1.2 — not quoted anywhere in this document.** The verbatim wording is not preserved here, and §16 row 7 records that as a live defect rather than treating the paraphrase as a citation |
| The register/roadmap/ADR division of labour, and the entry-shape conventions this document copies | `docs/70-ops/73-open-decisions.md` §1.1, §1.4, §10.1–10.4 |
| "Retired boundaries are struck through, not deleted", and the two retirement routes | `docs/00-vision/03-non-goals-and-scope.md` §10.1–10.3 |
| `N-R-2`, `N-R-3`, `N-P-2`, the scope rule and its capability closure, and the twelve refusals table | `docs/00-vision/03-non-goals-and-scope.md` §3.2, §4.2, §4.3, §5.1, §5.2 |
| `absent_since`, `Divergent { since }`, the capture-scope table, annotation-only fields, the earn-a-kind test, the implicit carrier list, the `Node` struct, the scalar catalogue and `Text`'s scope, the age bands, schema bumps and preserve mode | `docs/10-core/11-ir-schema.md` §4.3, §6.1–6.3, §8.7, §10.5–10.6, §11.3–11.4, §13, §17 |
| **The merge resolution ladder — `Confidence`, then `Origin` precedence, then later `asserted_at`, then `Field::Conflicted` — and its own admission that step 3 is last-writer-wins between two `Hand` assertions at different times** | `docs/10-core/11-ir-schema.md` **§8.6** |
| `fex`'s name environment and its four resolutions; the exclusion of clocks; `workspace.as_of`; the closed builtin table; the suppression record, its reason and expiry ladder; the tier budgets; the short-circuit soundness argument; D-2, D-5 and D-6 | `docs/10-core/12-rule-engine.md` §3.4, §3.6, §3.7, §6.6, §7.1, §11.1–11.4, §17 |
| `LineForm::Retract`, `Deactivate` versus `Retract`, `retract_needs_value`, `supports_subtree_retract`, the gap table and where a gap surfaces | `docs/10-core/13-emitters-and-provenance.md` §2.4–2.6, §9.2–9.3 |
| The miss log — local, never transmitted, exported by an explicit menu action | `docs/10-core/16-command-finder.md` §3.6 |
| The record taxonomy, the `Settings` struct, the plaintext gate's seven steps, the export header and the `review` warning | `docs/10-core/17-workspace-format.md` §4.2, §10.1, §15.3–15.5 |
| **That there is no custom merge driver, and that `fathom merge --resolve` opens the three git index stages on plaintext and merges values per `11` §8.6 — the mechanism that makes merge semantics a phase-0 concern rather than a phase-5 one** | `docs/10-core/17-workspace-format.md` **§12.3–12.4** |
| Removal computation, `subsume`, rollback generation, the change ticket, the YAML sidecar and `content_hash`, `DeltaClass`, OD-2 and OD-3 | `docs/10-core/18-diff-verify-rollback.md` §2.3–2.4, §3.3, §3.5, §5, §6.2–6.4, §10 |
| Metadata channel M5 and the change-window correlation | `docs/30-security/31-threat-model.md` §7.2 |
| The six field classes and class B's definition as LWW by `(hlc, actor)`; §6.3's concurrency DECISION and its explicit scoping to class A; §6.5's `dh_group` worked case and its closing scope — *"the right one for exactly this field"*; the tombstone worked case, the OR-Set finding, and the bulk-action constraint | `docs/30-security/33-sync-protocol.md` §5.1, §6.3–6.8, §7.4 |
| The no-links decision and its five reasons; the clipboard payload and its header; the WASM import allowlist and H39 | `docs/30-security/34-browser-hardening.md` §6.3, §7.5, §9.4, §10 |
| **The untrusted-text source table and U3's classing of user-typed values as *"none, treated as U2"*; the bidi, zero-width, tag-character and homoglyph classes; and the three per-path behaviours with the rule never to silently alter text the user will paste into a device** | `docs/30-security/34-browser-hardening.md` **§5.1, §5.5** |
| The personal-data inventory, the free-text channel, and the `CKT-44812 — see CMDB` remediation | `docs/30-security/37-privacy-and-compliance.md` §2.2, §2.4, §2.5 |
| Deployment shapes D1–D4 | `docs/40-stack/43-deployment-modes.md` §1, §3 |
| The budget table with no selection budgets; the `O(N²)` population-rule invalidation | `docs/40-stack/44-performance-budgets.md` §3, §7.2 |
| Inventory as the bulk-edit home and its generated column picker; `Selection` and `Facet`; multi-select gestures; the selection failure modes; budgets S1–S5; the view band's two-fact rule; the toast prohibition; D3 and D5 | `docs/50-design/52-information-architecture.md` §3.7, §5.1–5.8, §5.6.3, §9.3–9.5, §12, §14 |
| The single-letter and shifted verb tables; the `.` repeat whitelist; `Transaction`, `TxSource` and the granularity table; the staleness rule; the `Op::Untombstone` request | `docs/50-design/53-interaction-and-keyboard.md` §3.4, §3.6, §3.8, §7.2–7.5, §16 |
| The suppression record component and its three non-negotiables, including `Ticket NET-4471` in the wild | `docs/50-design/54-component-catalog.md` §14 |
| The live-region contract and the one `alert` role | `docs/50-design/55-accessibility.md` §4.6 |
| The channel budget G1–G10; the cost of `--muted`; the freshness rendering; the open items | `docs/50-design/56-diagram-view.md` §5.2, §8.1–8.2, §12 |
| Ship gates X0.8, X0.9, X4.1 and X4.7; the deferral table and the SNMP/LLDP row; phase 2 and phase 3 effort | `docs/70-ops/71-roadmap.md` §3.6, §5.7, §6.6, §7.3, §13.2, §14 |
| D3, D11, D16, D18, D19; the closed no-list; the coupling analysis; the record shape | `docs/70-ops/73-open-decisions.md` §2, §4.3, §5.2, §6.2–6.3, §9, §10, §11 |
| The `Revisit if` mechanism, present in all thirty decision records | `docs/90-decisions/` — every ADR carries `## Revisit if` |
| The schema is a specified artifact; "a field that exists in prose and not in `schema.yaml` does not exist"; the two-to-three-week figure and the missing phase-table entry | `docs/90-decisions/adr-0008-the-schema-is-a-specified-artifact.md` |
| v1 is the finder; the product is phases 0–3; "Nothing about a graph" | `docs/90-decisions/adr-0006-v1-is-the-finder-and-the-product-is-phases-0-to-3.md`, Decision item 1. **Note for anyone verifying this citation:** the phrase wraps a line break in the source — *"…if it is bad. **Nothing\n   about a graph.**"* — so a line-based `grep` for the whole phrase returns nothing and the citation looks false. It is not. `73` §2's phase-0 row and `58` §533 carry the same phrase on one line, which is why they are the hits a naive search finds |
| `11` owns re-identification; a rename produces a candidate, never a binding; the recovery-key narrowing | `docs/90-decisions/adr-0010-identity-reparse-and-suppression-survival.md` |
| Git is the sync; no multi-writer CRDT until a pilot team works around the lock — **and, from its own "not this" table, that a git merge conflict is opened with the passphrase and merged on plaintext by `11` §8.6, so conflict handling is present from phase 0 rather than deferred with the CRDT** | `docs/90-decisions/adr-0016-git-is-the-sync-for-v1.md` |
| `53` owns the keymap | `docs/90-decisions/adr-0024-53-owns-the-keymap.md` |
| PAN-OS is the second platform | `docs/90-decisions/adr-0030-pan-os-is-the-second-platform.md` |
| Invariant amendments and the residual scale | `docs/90-decisions/adr-0002-invariant-amendments-and-the-residual-scale.md` |
| The ten hard invariants, the terminology table, and the depth requirement — **including invariant 3 as it still reads in that file, which ADR-0002 supersedes and did not amend in place** | `.context/conventions.md` |

**Sources consulted for the four clarifications**, listed separately so that a reader checking §3.8,
§4.4, §7, §8 and §12 can see exactly what each claim rests on.

| Claim | Source |
|---|---|
| That `N-R-10` refuses config backup by name; its five cells quoted in §7.2; and its *"Reopens if"* door | `docs/00-vision/03-non-goals-and-scope.md` §2 register row, §4.10 |
| The scope rule's projection clause and its gloss *"backup (needs history we do not keep)"*; `T-freshness` as a review question; *"A senior engineer and a new hire read the same entry at different weights"* | `docs/00-vision/03-non-goals-and-scope.md` §4.7, §5.1–5.3 |
| **That `N-R-10` is cited by no other document in this repository** | A repository-wide search for the string `N-R-10`. Its only two occurrences are `03` §2's register row and `03` §4.10 itself |
| `Capture { id, taken_at, device, scope, platform, command, text, digest }` with `text` commented *"the whole capture, once, redacted"* and `command` worked as `"show configuration \| display set"`; `CaptureScope { Whole, Section, Fragment }`; what may assert `Absent` | `docs/10-core/11-ir-schema.md` §8.4, §8.5, §10.5 |
| That the `fex` grammar's *"Deliberately absent"* table excludes `Timestamps / "now"` as *"Non-deterministic by construction. Invariant 9"* and routes time through `workspace.as_of` — **and that the exclusion is scoped to the rule condition language, not to the product** | `docs/10-core/12-rule-engine.md` §3.4, §3.6 item 4 |
| The ingest gate, its value-shape detectors and its quarantine; `$9$` treated as the secret it is; redaction as *"a retention control, not a confidentiality control"*; the CI canary corpus; capture scope computed rather than declared; provenance naming the capture; `ReconciliationPlan` and the purely-additive DECISION; the intent-versus-observation gap and open decision D3 | `docs/10-core/14-parsers-and-ingest.md` §4.4, §5.1, §7.2, §7.4, §9.4, §9.9, §9.11, §10.3, §10.5, §16 |
| `pub enum Depth { Terse, Explained, Teaching }   // exactly three. Never a fourth.`; Terse capped at *"findings only, as one-line flags. Nothing else."*; *"Depth controls **explanation**, never **warning**"*; Terse as *"the depth a senior engineer leaves the tool on **permanently**"*; the three surfaces and the side rail whose width can be zero; the depth resolution ladder and the `user_default` DECISION | `docs/10-core/15-explainer-corpus.md` §3.3, §4.7, §6.3, §11.2, §11.3 |
| The finder's risk prior — `ReadOnly +0.05, ChangesConfig −0.10, Disruptive −0.25` — stated as *"a safety control, not a relevance signal"* | `docs/10-core/16-command-finder.md` §8.3 |
| Record class `0x13` `Capture`, one per capture, never rewritten; captures as *"a different animal"*, write-once and content-addressed; capture-body compression as *"the biggest win"*; the two diff mechanisms and their graph basis; that captures never merge; hooks, LFS and git-history permanence; the ~38 KB per-device capture budget and the compaction rule *"not a saving, it is a purchase"*; what is deliberately not in the workspace | `docs/10-core/17-workspace-format.md` §4.2, §4.5, §5.8, §10.2, §12.5, §12.7, §12.8, §13.1, §13.5, §13.6 |
| The rejection of text diff; tier-2 matching listing a freshly pasted `display set` as one of its three reasons; the config-diff algorithm and the `Accumulating` trap; the `load replace` DECISION and its partial-graph objection; the `Ladder`/`Step`/`Expectation`/`Branch`/`Goto` types and the authored YAML form; `ladder_for(gd, plat)` and gates as predicates over the diff; linearisation; *"Rollback is a function of the diff, not of the change set"*; `RollbackConfidence` as the minimum over lines; the credentials no-inverse row; `GuardPolicy`; the unsuppressible-caveat rule; the rendered `rollback 1` block; OD-1 | `docs/10-core/18-diff-verify-rollback.md` §2.1–2.3, §3.1–3.8, §4.2–4.6, §5.1–5.6, §6.2, §7.5, §9, §10, §11 |
| The asset ranking, asset state *"at rest, local"*, and what CI enforces | `docs/30-security/31-threat-model.md` §2.1, §2.5, §12 |
| Row 20 of the personal-data inventory — *"Captures — raw pasted configuration"*, *"the text as pasted"* | `docs/30-security/37-privacy-and-compliance.md` §2.2 |
| *"Four renderers, one controller, one corpus surface, and one layer"*; `verify(diff(graph))` as a mode rather than a seventh view; the three explainer placements and the four things opening one never does; the depth control as a margin tab with no settings screen; `Task`, `Step`, `InputSpec`, `WalkthroughRun`, `RunState { Active, Parked, Completed { at }, Abandoned }` and `AnswerRecord`; findings inline; task version drift; *"It is the slowest path to config in the product"*; the no-seventh-view rule and the 14-fact scent budget | `docs/50-design/52-information-architecture.md` §1.1, §3.8, §4.2–4.4, §6.2–6.4, §6.9, §6.10, §9.5, §9.6 |
| *"No modes. No mode indicator. No mode errors."*; the copy-payload table including the two-key split and the ladder and block rows; display-versus-clipboard; the footer confirmation and *"The risk composition is the confirmation"*; what is deliberately not copyable | `docs/50-design/53-interaction-and-keyboard.md` §2.2, §6.3, §6.3.1, §6.5, §6.6 |
| The risk-legend placement rule; the margin tab and the one-line imperative as always-visible chrome; the config block's `.risk-bar` anatomy and its HTML; the wrap rules; §8.7 rule 4 refusing a per-line copy control; `⌘C` on the focused line; the provenance disclosure and its `[ Copy this line ]`; the suppression record's three non-negotiables and the derivation of expiry from `expires` vs `workspace.as_of` | `docs/50-design/54-component-catalog.md` §4, §5, §6, §8.1–8.3, §8.7, §8.8, §14, §17 |
| The command-entry field reference and the destructive-command fields; the three risk values and the *round up* rule; `reversible`; `commit_model`; `risk_caption_override`; `entry_for` and *"A diagnostic query must not start with a configuration change"*; the ladder containment gate and CI gate 11; the authoring workflow; the work list of entries the card implies; D4 on filter entries | `docs/60-content/61-command-corpus-spec.md` §2, §3.1–3.7, §4.1–4.6, §10.1, §10.2, §13, §17, §19 D4 |
| **That the seed corpus holds 98 entries and that the only configuration-lifecycle verbs among them are `commit confirmed 5`, `commit` and `show system commit`** — no backup verb, no `rollback`, no `load`, no `request system` upgrade verb | `corpus/commands/junos-srx-ipsec.yaml`, read directly. The ids are `junos-srx/system.commit-confirmed`, `junos-srx/system.commit` and `junos-srx/system.commit.show` |
| Phase 0's authored content, including the three static ladders; the phase-0 finder mock and its `⏎ copy   ⇧⏎ copy with context` legend | `docs/70-ops/71-roadmap.md` §3.3, §3.5 |
| The amended invariant 3 — *"A pasted capture may **contain** a credential; it is redacted at the ingest gate…"* — its `Accepted` status, and its own warning that *"the weaker sentences are the true ones"* | `docs/90-decisions/adr-0002-invariant-amendments-and-the-residual-scale.md` |
| The *round up* rule quoted as the corpus's own, and that risk is assigned by effect | `docs/90-decisions/adr-0011-risk-is-a-property-of-effect.md` |
| R39 — `Terminal` as the default wrap, and the clipboard rule that follows from it | `docs/90-decisions/adr-0025-restore-the-cards-density-and-channel-budget.md`, as applied at `54` §8 (*"the visible backslash is a rendering flavour, not…"*) and recorded again at `54` §26's open decisions |
| **The verification stamp `junos-srx 21.4R3 · verified 2026-05-12 · K. Okafor` as chrome on every finder row and explainer header — a stored date, displayed, with nothing in the stamp itself evaluated** | `docs/90-decisions/adr-0027-hardware-verification-and-the-verification-stamp.md`, Decision item 3 (*"The stamp is chrome, not metadata"*) |
| **That `Staleness` has two disjunctive limbs and one of them is an elapsed-months date comparison — `Aging` *"> 18 months since verification, or ≥ 2 vendor majors behind"*, `Stale` *"> 36 months, or explicitly contradicted by a newer verification"* — that it is *"Computed at build from `verified_against` and the release calendar"*, that `verified_against` is a *"list of `{platform, version, on}`"* and so carries a date, that a `Stale` entry is dropped from the spine, and that a second elapsed-date gate warns at 24 months and errors at 36.** ADR-0027 item 4 shows one illustrative case — *"an entry verified against a train two majors behind"* — and is **not** the source for the general rule; `15` §13.2 is. An earlier draft of §4.4 cited item 4 for the claim that `Staleness` compares versions and not dates, which item 4's own referent refutes | `docs/10-core/15-explainer-corpus.md` **§13.2**, and §3.4's filter table, §6.2's field reference, §7.2's re-review triggers |

**Sources consulted for the fifth batch** (§2.4, C-07, C-08, C-09), listed separately in the same
discipline. Every section reference below was re-verified against the named file when this batch
was recorded.

| Claim | Source |
|---|---|
| **The owner's fifth batch, verbatim** — the real-time groundwork sentence, the freeform and planning-mode request with its category list, the stencil request, and the pocket — one message | Owner, in conversation. Quoted at §2.4 and §9.1 — the opening sentence appears in both, and §2.4 states why — then §10.1 and §11.1. No restatement of the record-do-not-act instruction accompanied it; §9.1 records its status |
| The no-colour DECISION and its pre-written reversal sentence — *"If this is ever reversed, it is reversed to A3's overlay architecture and never to A4's always-on model"*; the four arguments; what refusing A3 costs, including its invariant; the always-on costs and G1 owning tone; the three-trigger gate | `docs/50-design/59-diagram-aggregation-and-colour.md` §4.1–4.7 |
| The palette, measured and shelved, marked **PROPOSED — not adopted** at the margin tab; the measured clearance from the reserved trio (closest approach 44.9° light, 42.3° dark); greyscale survival; the two forced-colours bugs and their specificity cause; the nine rules any adoption must carry, rule 2 being *"Nothing is tinted that is not also tagged… Not a guideline"* | `docs/50-design/59-diagram-aggregation-and-colour.md` §5, §5.3–5.7 |
| The base defects independent of both decisions, `forced-color-adjust: none` on five diagram classes first among them | `docs/50-design/59-diagram-aggregation-and-colour.md` §6 |
| Like-kind sibling aggregation at six; windowed expansion and the measured ladders; the exact expand-collapse round trip as exit criterion X5 | `docs/50-design/59-diagram-aggregation-and-colour.md` §3, §3.7, §7.2 |
| R1 — the three risk colours reserved; R2 — no meaning in colour alone, named as WCAG 1.4.1; the two CI lints and the fact that both read stylesheets; `forced-color-adjust: none` *"exactly once in the product"* | `docs/50-design/51-design-tokens.md` §1, §3.3, §6 |
| The colour-independence rule in operational form; the monochrome test; *let the UA win* | `docs/50-design/55-accessibility.md` §3.1, §3.4, §7.3 |
| The channel budget — *"one channel, one meaning, and nothing may be added to it without taking something away"* — G1 owning tone, G10 as the view band | `docs/50-design/56-diagram-view.md` §5.2 |
| The reserved trio in conventions — *"Do not reuse these colours for anything else"* — and ADR-0011's amendment leaving *"the ink, wash and ordering"* unoverridable. **Note for anyone verifying: the reservation is not a numbered hard invariant** — `.context/conventions.md` carries exactly ten — **it lives in the risk-enum section**, restated as `51` §1 R1 and linted by `51` §3.3 | `.context/conventions.md` §"The risk enum"; `docs/90-decisions/adr-0011-risk-is-a-property-of-effect.md` |
| R-VIEW — *"The diagram stops being a view and starts being state, which is brief §4.1's forbidden outcome"* — medium, architecture-corrupting, phase 4 | `docs/70-ops/71-roadmap.md` §1.4 |
| Selection as the through-line and its type; the anti-table — not undoable, not synced, not persisted across a lock — with *"Shared cursors are a collaboration feature this product has not earned"*; `FilteredOut` and the full-count confirm; `Aggregated { drill_into }` | `docs/50-design/52-information-architecture.md` §5.1, §5.7, §5.8 |
| **`Device.role` declared as `enum { firewall, router, switch, load_balancer, other }`, cardinality `0..1`, emit `—`** | `schema/schema.yaml`, the `Device` kind's field list, read directly |
| *"No logos. No icons. No illustrations."* | `.context/design-language.md`, §"What the card never does" |
| That no verb in the single-letter table creates a node, and that the walkthrough's `Step.creates` is the specified creation path | `docs/50-design/53-interaction-and-keyboard.md` §3.4; `docs/50-design/52-information-architecture.md` §6.2 |
| The multi-writer protocol deferred, not deleted; D18 decided as *"No. File plus git for v1… Multi-writer only on evidence"* with *"the op log stays either way"*; D19 leaning hand-rolled with Loro as the named fallback, live only if D18 reopens | `docs/90-decisions/adr-0016-git-is-the-sync-for-v1.md`; `docs/70-ops/73-open-decisions.md` §2 D18–D19, §6.2, §6.3 |
| The capability ladder's ordering axis and E1 — *"shared synced database, load balancing, HA, DR"* — as the priced server rung, D-38.6 carrying *"the one exposure that never reverses"* | `docs/30-security/38-the-egress-question.md` §5.0, §5.3, §5.8, §11 D-38.6 |
| Per-workspace private policy's designed home — the `Policy` record class | `docs/10-core/19-service-and-physical-model.md` §8 |

---

## 19. Disagreements

No disagreement with any hard invariant **as amended**, with the risk enum, or with the terminology
table. One disagreement with the *text* of invariant 3 as `.context/conventions.md` currently
carries it, stated as item 10 — the objection is that the file is stale against an `Accepted` ADR,
not that the invariant is wrong.

**1. This document is a new numbering slot and needs an owner.** ADR-0001 requires that every
settled question have one owning document. `75` owns nothing settled — that is the point — but it
still needs to be named somewhere as the home for pre-fork intent, or the next person to have an
intention will invent a second one. Proposed: a line in `73` §10 pointing at `75` as the place an
intention waits until it is well-formed enough to become a `Dnn`. **This document does not make
that edit.**

**2. `11` §6.2 and `11` §13 contradict each other and the contradiction is load-bearing.** §6.2
states that every kind implicitly carries `notes: [Text]`. §13's `Node` struct does not have it.
Two normative statements in one document, and the answer decides whether a free-text
user-attached carrier exists at all. This is not caused by anything in this register; it is
surfaced by it, because C-01 and C-02 would both attach to whatever the answer is. It should be
resolved in `11` regardless of whether anything here is ever built.

**3. `11` §8.7 and `56` §8.1 specify a time comparison without naming what time is compared
against, and `71` X4.1 forbids the obvious answer.** Also not caused by this register. The age
bands are rendered into the SVG, X4.1 requires the SVG to be byte-identical for the same graph and
build with *"no wall-clock"*, and X4.7 requires the same of the diagram embedded in a change
ticket. Either the comparison is against `workspace.as_of` — in which case both documents should
say so — or the gates are already violated.

**4. `workspace.as_of` is used by four documents and defined by none.** `12` §3.6 puts it in the
`fex` name environment, `12` §3.4 makes it the answer to determinism, `18` §6.4 records it in the
ticket header, and `54` §14 derives suppression expiry from `expires` versus
`workspace.as_of`. It is absent from `17` §10.1's
`Settings`, from `17` §4.2's record taxonomy and from `11`. Proposed: `17` owns it, as a `Settings`
field with a stated class and a stated rule about whether it advances. **This document does not
make that edit either**, and it is the single highest-value unowned thing this register found.

**5. `53` §7.2's `TxSource` cannot express a transaction that `53` §7.2's own granularity table
prices and §7.3 lists as undoable.** An internal inconsistency in one section of one document,
independent of anything here.

**6. The strongest objection to this whole register, stated against it rather than for it: the
C-01/C-02/C-03 cluster is a request for Fathom to become a CMDB.** Lifecycle state, ticket
references, maintenance windows and bulk editing across an estate are, together, the feature set
of a system of record. `52` §3.7 positions the inventory explicitly against NetBox — *"the thing
NetBox structurally cannot do: the inventory has opinions"* — and the differentiator is the
opinions, not the record-keeping. `03` §4.2 `N-R-2` refuses the record-keeping outright, with
`Reopens if: Never`, and `03` §11's own cost table names the risk: *"If `N-R-1` or `N-D-1` turns
out to be the thing that would have made the product viable, this document is why it was not
built."*

A system of record is a different product with a different threat model — one where the workspace
is authoritative, where staleness is a defect rather than a rendered fact, where multi-writer
concurrency is table stakes rather than phase 5, and where `31` §7.2's metadata channels carry an
estate's operational calendar rather than an engineer's working hours. **That may be exactly what
the owner wants.** Two of the corpus's most useful properties — `11` §10.5's `Divergent` and
`52` §3.7's opinions column — already sit one step from it.

It should be a choice, made once and written down, and not a drift arrived at three entries at a
time. If the answer is yes, the honest form is an amendment to `03` §4.2 through §10.1's process,
not a series of fields that individually look harmless. If the answer is no, then C-01's
enumeration must be framed as intent about the estate rather than position in a workflow, and that
framing constrains the field before it is designed rather than after.

**7. No disagreement with the deferral of C-04.** The owner deferred it and was right to. This
register's only addition is that "deferred" understates it: `03` §4.3 refuses it, three ship gates
enforce the refusal, and `03` §10.3's route out costs the product its name.

**8. `03` §4.10 `N-R-10`'s test contradicts `11` §8.4, `17` §4.2, `17` §13.1 and `37` §2.2 row 20,
today, and nobody has noticed because nothing cites it.** The test reads *"no field stores raw
device configuration text beyond the current parse session"*. `Capture.text` is such a field, it has
a record class, it has a byte budget, and it appears in the privacy inventory as a stored asset.
Either the test means *pre-redaction* text — which the refusal's own rationale clause supports and
which would make the boundary already satisfied — or four core documents are in breach of a
`Refused` boundary. **Not caused by this register**; C-05 is only what made someone read the two
side by side. It should be resolved in `03` regardless of whether C-05 is ever built, and §17 records
where it lands.

**9. The corpus is lopsided toward teaching, and that is recorded at §12 rather than here.** It is
the same class of thing as item 6 — an observation about the whole document set rather than an
objection to a convention — and the two should be read together. Item 6 says these entries push
toward a system of record; §12 says the corpus as a whole under-serves the engineer who already knows
the answer, and that the owner has now named that engineer as half the product. Neither is a
proposal. §12 gives the evidence and the one thing it recommends is a review question, not work.

**10. `.context/conventions.md`'s invariant 3 is superseded text and the amendment was never
applied.**

| | |
|---|---|
| **The convention as written** | *"The application never accepts a credential. No PSKs, no certificates with private keys, no SNMP communities, no TACACS keys, no device passwords. Emitted config uses placeholders. The one exception is the workspace passphrase…"* |
| **The objection** | ADR-0002 is `Accepted` and adopts a replacement in full. `14` §9 already implements the replacement — the ingest gate accepts a capture containing a PSK, redacts it, and hands a redacted newtype to the store. **ADR-0011's amendment was applied to this file, under the risk enum. ADR-0002's was not.** So the sentence a reviewer quotes today forbids behaviour the product already ships and that an accepted decision already licensed |
| **The proposed replacement** | ADR-0002's own text, verbatim: *"**The application stores no device credential.** No PSK, certificate private key, SNMP community, TACACS key or device password is ever written to a workspace, a sync blob, a git object or an export. Emitted configuration uses placeholders. A pasted capture may **contain** a credential; it is redacted at the ingest gate and the unredacted text never reaches the encryptor (`14` §9.9). The secrets the application does hold are enumerated in `32` §21.3 and `33` §18.3, and that enumeration is exhaustive: adding one requires amending this invariant."* |

**This document does not make that edit** — it owns `75` and nothing else — and the edit is ADR-0002's
to have landed, not this register's to land late. It is recorded because C-05 cannot be discussed
against the stale sentence without being refused for a superseded reason (§7.6, §13 row 32).
