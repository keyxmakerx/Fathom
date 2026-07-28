# 75 — Capability register: intent recorded, nothing decided

> **Status:** Proposed

Companion documents: this register decides nothing and specifies nothing. It sits between
`docs/70-ops/71-roadmap.md`, which sequences work that has been scoped, and
`docs/70-ops/73-open-decisions.md`, which holds forks that are ready to be answered. Every entry
below names the documents that would carry its detail if it were ever built. The ones named most
often are `docs/10-core/11-ir-schema.md`, `docs/10-core/12-rule-engine.md`,
`docs/10-core/13-emitters-and-provenance.md`, `docs/10-core/18-diff-verify-rollback.md`,
`docs/50-design/52-information-architecture.md`, `docs/50-design/53-interaction-and-keyboard.md`,
`docs/30-security/33-sync-protocol.md` and `docs/00-vision/03-non-goals-and-scope.md`. Two
decision records govern how entries leave: `docs/90-decisions/adr-0008-the-schema-is-a-specified-artifact.md`
blocks every field-shaped entry here, and `docs/90-decisions/adr-0010-identity-reparse-and-suppression-survival.md`
supplies most of C-01's machinery.

---

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | What this register is, the gap it fills, and the line it does not cross | *read this first* |
| 2 | The standing priority instruction — prior work does not constrain future quality | *governance* |
| 3 | C-01 — element lifecycle state | *decommission, maintenance, etc* |
| 4 | C-02 — ticket reference and date annotation | *(a) is free, (b) is refused* |
| 5 | C-03 — multi-select and bulk action as first-class | *you select in order to act* |
| 6 | C-04 — integration hooks, deferred on security grounds | **NOT APPROVED** |
| 7 | Second-order consequences | *what each entry drags in* |
| 8 | What the owner must decide — candidates for `73` | *the questions nobody asked* |
| 9 | Nearly free versus large | *the cost is in the state model, not the feature* |
| 10 | Failure modes of this register | *how a register rots* |
| 11 | Open decisions this register raises and does not answer | |
| 12 | Sources consulted | |
| 13 | Disagreements | |

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

### 1.3 The entry lifecycle — how an entry leaves

An entry that never leaves is a wish. There are exactly four exits.

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

**Review cadence.** At phase boundaries, with `73`. `73` §10.4's argument transfers: *"A register
reviewed continuously becomes a discussion; a register reviewed at phase boundaries becomes a
checklist."* Two questions per entry — has anything upstream unblocked it, and is it still wanted.

### 1.4 The shape of every entry

| Field | What it says |
|---|---|
| **What is wanted** | In the owner's terms, not in implementation terms |
| **What already exists** | The parts of the corpus that already do some of it. Usually more than expected |
| **Options** | Presented as options. Never resolved here |
| **Where it would attach** | Document and section, with what would change |
| **What it drags in** | The second-order consequences, honestly, including the ones that make it expensive |
| **What must be decided first** | The upstream blockers, in order. An entry with an unmet blocker cannot be scheduled, only forked |
| **Earliest possible arrival** | Against ADR-0006's phase model, so nothing here reads as near-term |

### 1.5 The register

| # | Capability | Status | Earliest possible arrival | Hard blocker | § |
|---|---|---|---|---|---|
| **C-01** | Element lifecycle state — decommission, maintenance, and an open "etc" | Intent recorded | Phase 2 at the earliest; the emit half is phase 3 | `62-schema-spec.md` does not exist (ADR-0008); `03` §4.3 `N-R-3`'s test as written | §3 |
| **C-02a** | Ticket reference and dates as inert workspace data | Intent recorded | Phase 2 | Same schema blocker. No invariant blocker found | §4 |
| **C-02b** | Live ticketing integration — fetch, post back, validate, sync a window | **NOT APPROVED — see C-04** | — | Invariants 1 and 3 | §4.1, §6 |
| **C-03** | Multi-select and bulk action as a first-class verb class | Intent recorded | Phase 2 | `52` §12 D3 currently leans the other way; `53` §7.2's `TxSource` cannot express it | §5 |
| **C-04** | Integration hooks to ticketing and change management | **DEFERRED, AND CURRENTLY REFUSED BY `03` §4.3** | Not on any plan | Two invariants, three ship gates, two permanent boundaries | §6 |

**Read the C-04 row before reading anything else.** The owner deferred it for security reasons and
was right to. What the owner may not know is that it is not merely deferred: `03` §4.3 `N-R-3`
refuses it, and that refusal's *"Reopens if"* cell reads **Never**. §6 records that honestly.
§4 records the part of the request that is available today and touches nothing.

### 1.6 Scope reality check

Stated up front so this register is not misread as a near-term plan. ADR-0006: **v1 is the finder
— phase 0, "Nothing about a graph."** The inventory is phase 2. Findings, diff and the change
ticket are phase 3. Sync is phase 5, and ADR-0016 makes git the sync with no multi-writer CRDT
until a pilot team works around the lock.

Nothing in this register is v1. The merge-semantics problems raised in §3 and §7 are not phase-2
problems at all — they only become live if ADR-0016 is reversed.

---

## 2. The standing priority instruction

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

| It does | It does not |
|---|---|
| Make every `Accepted` ADR reopenable **on merit** | Make any ADR less binding until it is reopened by the process that created it |
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
| **`52` §14's request that `44` §3 adopt budgets S1–S5** | `52` §5.6.3, §14 vs `44` §3 | `52` asked; `44` never took it. C-03 adds a bulk *write* across a selection, which has no budget at all. See §7 |

In each case the earlier answer may still be best. ADR-0010 in particular looks best on the
merits and not merely first (§3.5). That should be re-established, not assumed.

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

Either lifecycle subsumes tombstone, or the two are explicitly reconciled. Shipping both without
reconciling them gives one question two answers, which is how a data model acquires a state
nobody can explain.

### 3.3 The state vocabulary — options, not a decision

Two structural questions come before any list of words.

**Question A — one axis or two.** `Decommissioned` is a destination: it is where an element ends
up. `Maintenance` is a temporary overlay on an element that is otherwise live. Folding them into
one enum means an element in maintenance cannot also be scheduled for decommission, which is a
common real combination. Two orthogonal fields — a lifecycle stage plus a transient operational
state — cost one more field now and avoid a shape change later. **Not decided here.** §9 notes
that a shape change after phase 1 is a major schema bump (`11` §11.3), and `11` §11.4 states what
a major bump does to an air-gapped user.

**Question B — candidate states.** Each of the following needs an explicit yes or no, because each
one is a row in every emit-behaviour table and every merge matrix that C-01 eventually touches.

| Candidate | What it would assert | The obvious objection |
|---|---|---|
| `Planned` | Modelled, not yet built | `11` §10.5's `Divergent { since }` already means this, derived rather than asserted |
| `Live` | Normal operation | A default state that is also a value is a state you have to migrate into |
| `Maintenance` | Temporarily out of service, expected back | Wants `deactivate` semantics from the emitter, not `delete` — `13` §2.4 |
| `Decommissioning` | Deletes generated, not yet applied | This is a *process* state, and `03` §4.3's test forbids exactly that. See §3.6 |
| `Decommissioned` | Gone from the box | Collides with `absent_since` (§3.2) |
| `Retained` | Physically present, deliberately unmanaged | Arguably the most useful one in a real estate, and the one nobody asks for first |

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
| `11` | §11.3 | A new optional field is a **minor** bump that old clients preserve. Changing its shape later is a **major** bump |
| `12` | §3.6, §5 | Only touched if rules may *read* lifecycle. If they may, it enters the `fex` name environment, the static read-set extractor, the dependency keys and the invalidation algorithm. If they may not, `12` is untouched and lifecycle is inert |
| `13` | §2.4 | The emit half, and the most valuable thing in the request. See §7 row 4 |
| `17` | §4.2 | As a node field it lands in the `Nodes` shards for free — no new class byte, no new merge path. As a workspace sibling alongside `Suppressions` `0x20` it needs a class byte and §9.2's leak argument applies |
| `18` | §2.5, §6.2 | Free if it is a schema field — the diff walks the schema in declaration order, so a lifecycle change becomes a `FieldDelta` automatically. `DeltaClass` is a separate question (§8) |
| `33` | §6.4 | A row must be added to the A/N/B/C/D/E class table, and none of the six fits a single-valued register. See §7 row 11. **Only live if ADR-0016 is reversed** |
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
| 5 | **The node-attribute versus schema-field fork must be taken** (§3.4 row 1) | It decides rule visibility, inventory column generation, merge class and diff behaviour in one move. See §8 |
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

The claim that a stored ticket string touches no invariant is checkable, and it checks out three
ways.

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

**The one new obligation** is a row in `37` §2.2's inventory with a verdict, because that table is
the one handed to a DPO and it is complete by construction.

### 4.3 Where C-02a would attach

| Document | Section | What would change |
|---|---|---|
| `11` | §4.3 | A `TicketRef` semantic scalar rather than `Text`. §4.3 marks `Text` as the free-string type for *"descriptions and notes only"*, and §12.4 bans `Text` from the extension bag because it is how the bag becomes a back door. The same reasoning argues for a pattern-constrained scalar over another free-text field |
| `12` | §11.1 | **Nothing needs to change for suppressions to carry a ticket today.** `54` §14 already quotes one inside `reason` |
| `17` | §15.2, §15.5 | A structured field would appear in `csv`, `fathom-json` and `review` exports. `review` is *"the most dangerous artifact"* (`17` §15.5), so a lifecycle-plus-ticket column joins that artefact |
| `18` | §6.2 | Would appear in the change ticket. Note the resulting shape: a populated *what changes* section and an **empty** config section, because the field emits nothing. That is honest and it is a new ticket shape |
| `34` | §6.3 | Nothing. The ticket string is already a first-class part of the clipboard payload |
| `37` | §2.2 | One row, with a verdict |

**One thing that is already decided and should not be rediscovered:** a ticket reference cannot be
a link. `34` §9.4 is unambiguous — *"the application renders no clickable external link, in any
surface, ever"* — because a navigation is not a fetch and therefore survives `connect-src`
(`34` §9.4 reason 2, citing `23` §6.3's channel C3). `CHG-2026-0211` in an inventory cell is a
string you copy. Some users will read it as a broken link. That is the cost, and `34` §9.4 already
paid it deliberately for citations.

### 4.4 The date and determinism problem

*This is the sharpest hidden issue in the whole request, and none of it is about tickets.*

> **THE RULE ENGINE HAS NO CLOCK. THAT IS A SHIP GATE, NOT A STYLE CHOICE**

**What exists and is correct.** `12` §3.4 excludes timestamps and `now` from `fex` outright —
*"Non-deterministic by construction. Invariant 9"* — and routes time through `workspace.as_of`, a
workspace constant in the `fex` name environment (`12` §3.6 item 4). `18` §6.4 records `as_of` in
the change ticket. `12` §7.1 already lists *"suppression expiry rollover"* as a Tier C sweep
trigger. The machinery for offline, deterministic, date-sensitive evaluation is complete.

**Problem one — `workspace.as_of` has no home.** It is referenced by `12`, `18` and the suppression
expiry ladder. It appears **nowhere** in `17` §10.1's `Settings` struct, nowhere in `17` §4.2's
record taxonomy, and nowhere in `11`'s schema. Nothing says who sets it, whether it is stored,
whether it merges, or what field class it is. **Every date feature the owner is asking for lands
on a constant with no defined provenance.** Twelve lines of struct; large in consequence.

**Problem two — an expiring state breaks `12` §6.6's soundness argument.** That proof rests on
step 2: *"The result is a pure function of the values read (§3: no side effects, no ambient state,
no clock)."* A lifecycle state *derived* from `(window_end, today)` is not such a function. If it
changes because time passed, no graph delta is produced, no dependency key is invalidated, and the
affected rule instances are never re-evaluated. Concretely: an element stays in maintenance
forever, and the only thing that ever fixes it is an unrelated edit to that node. If the derivation
instead reads `workspace.as_of`, invalidation is correct — at the cost of a Tier C full sweep
(`12` §7.1's budget: 1.5 s at 20,000 nodes) every time `as_of` moves.

**Problem three — there is already unrouted wall-clock in the product, and it is in the diagram.**
`11` §8.7 computes node age as `max(asserted_at)` over parsed and imported fields, and bands it
Fresh / Ageing / Stale / Unverified. `56` §8.1 renders those bands as the G1 boundary-tone channel
and a second label line. **Neither document says what `max(asserted_at)` is compared against.** If
it is the system clock, then an untouched workspace silently flips a node's boundary from `--ink`
to `--muted` and changes `parsed 4 months ago` to `parsed 11 months ago` as the calendar advances
— and `71` X4.1 requires *"same graph + same build ⇒ byte-identical SVG. No `HashMap` iteration,
no wall-clock, no randomised seeds"*, with X4.7 requiring the exported diagram to be byte-identical
across builds inside the change ticket. Those cannot both be true today. Maintenance windows do not
create this problem. They make it impossible to keep ignoring.

**Problem four — invariant 1 means there is no scheduler.** "What does an expired maintenance
window do when the file is opened six months later?" has exactly three answers.

| | Answer | What it costs |
|---|---|---|
| **(a)** | Nothing, until `as_of` moves | Determinism is perfect and the tool shows a window that ended in March as still active. The tool is lying |
| **(b)** | `as_of` auto-advances to the system clock on open | The tool is right, and opening the same untouched workspace on two days produces different findings, a different change ticket and a different SVG. Invariant 9 survives on a technicality; the user's expectation that an unchanged file reproduces does not |
| **(c)** | Dates are inert annotation; the state is only ever what a human set. *"N elements are past their stated end date, as of `<as_of>`"* is an ordinary finding | No scheduler, no clock, no invariant amendment. Reuses machinery that ships anyway |

**Not decided here.** Recorded: (c) needs nothing new; (a) and (b) eventually need ADR-0002's
amendment process, whose own text treats invariant 9's carve-out as a door to be kept shut.

### 4.5 What must be decided first

1. `62-schema-spec.md` (ADR-0008), same as C-01.
2. Where `workspace.as_of` lives, who sets it, whether it merges, and whether it advances on open.
   **This is upstream of every other date decision in the register.**
3. Whether `11` §8.7 and `56` §8.1's age bands compare against `as_of` or against the system clock.
4. Whether dates are asserted or derived — §4.4 problem four.
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

- The merge half of D3's risk **is substantially defused for phases 0–3** by ADR-0016: git is the
  sync, with no multi-writer CRDT until a pilot team works around the lock. Bulk annotation would
  land in phase 2, which is before that.
- D3's other half — that `53` §7's undo cannot fully repair a bad bulk edit — survives intact and
  is §5.5.

**This register does not answer D3.** It records that the request is direct evidence against the
current lean, and that D3 is now load-bearing rather than academic.

### 5.5 The undo problem, honestly

`53` §7.5's staleness rule: *"An undo whose target has changed since the transaction is not
applied. It is reported and skipped."* Partial undo is permitted and reported.

Applied to a bulk decommission across a merge, that leaves the estate in a mixed state: some
elements restored, some still decommissioned. `53` §7.4 makes undo an *edit* — it appends
compensating ops and shows up in provenance, the diff and a colleague's sync — so a partially
undone bulk decommission is a permanent, visible, half-finished record. And if lifecycle drives
emit (§7 row 4), the next change set generates deletes for the elements that were not restored.

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

### 6.4 The export/import path — the honest alternative, and it may need nothing

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

**This appears to be the buildable answer to the hook request, and under `03` §5.1 it needs no new
capability verb.** It is recorded as an observation, not a proposal. Nobody should build it from
this document.

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

## 7. Second-order consequences

*margin tab: what each entry drags in*

Severity is the cost of getting it wrong, not the effort of doing it.

| # | Area | What it drags in | Sev | Source |
|---|---|---|---|---|
| 1 | **Rule visibility** | `absent_since` is a `Node` field, not a `Field<T>` in the generated body, and `fex`'s name environment resolves only selector bindings, anchor fields, closed builtins and `workspace.` constants. So a tombstoned node lints exactly like a live one and no rule author can express otherwise. A lifecycle attribute placed beside `absent_since` inherits that verbatim; the only fix is a new builtin, and `12` §3.7 says adding one is *"an engine release, not a pack release"*. As a schema field, rules read it for free. **Hard cost asymmetry, and the fork must be taken before `schema.yaml` is written** | high | `12` §3.6, §3.7; `11` §10.5, §13 |
| 2 | **Do decommissioned elements still lint** | Every available answer is wrong somewhere. Clearing the finding makes the panel lie. Routing it through `FindingState::Suppressed` requires a `SuppressionId` with a mandatory reason, author and expiry — the product would be manufacturing suppressions nobody wrote. A per-rule declaration is a new rule-pack field, so it is a `63` change and a re-review of every existing rule | high | `12` §11.1–11.3; `63` |
| 3 | **Lifecycle that quiets findings is a shape the corpus has refused twice** | `12` §17 D-6 (per-rule `enabled`): *"disabling a rule is a workspace-scoped suppression and needs a reason. One mechanism, one audit surface."* D-2 (`workspace.strictness`): *"a global dial is a suppression with no reason and no record."* A `Decommissioned` dropdown that stops findings firing bypasses `12` §11.2's mandatory 20-character reason and §11.3's mandatory expiry on `high` and `medium`. **Either lifecycle is inert with respect to the rule engine, or it routes through `Suppression`.** There is no third option that survives D-6 | high | `12` §17 D-2, D-6; §11.2–11.3 |
| 4 | **The delete feature hiding inside C-01** | Fathom today has no way to say "remove this from the box". `13` §2.4 already defines `LineForm::Retract` with a `RetractScope` of `Leaf` or `Subtree`, plus `Deactivate` and `Activate`; `18` §3.3 computes removals as a `StatementPath` map difference; `18` §3.5 minimises them with `subsume`; `18` §5 generates rollbacks. All of it exists and nothing drives it, because the only producer of an absent statement today is a re-parse tombstone that excludes from emit silently. Wiring "decommissioned ⇒ excluded from emit" would make the existing config diff generate ordered, subsumed, risk-labelled delete lines with a rollback — a decommission runbook — out of machinery already specified. **This is the highest value-per-line item in the whole request** | high | `13` §2.4–2.6; `18` §3.3, §3.5, §5; `11` §10.5 |
| 5 | **But "exclude from emit" is the wrong default for maintenance** | `13` §2.4: *"For a maintenance window the first [`deactivate`] is almost always what you want, because reactivating is one command and re-typing an object is a change ticket."* Decommission and maintenance want different line forms from the same mechanism, so the choice is per-state, not per-element | high | `13` §2.4 |
| 6 | **And the vendors disagree** | `13` §9.2's gap table already records `deactivate` as `Unrepresentable { NoFeature }` on **both** `panos` and `ios-xe`. A maintenance state emitting `deactivate` on Junos surfaces as a `NOT EMITTED` block on every PAN-OS device, forever — and ADR-0030 makes PAN-OS the second platform. That is honest and it looks like a defect | high | `13` §2.4, §9.2, §9.3; ADR-0030 |
| 7 | **Rollback of a decommission** | `18` §5 generates a rollback from a diff, and only `NodeDelta::Removed { snapshot }` knows what was there. If decommission is a field change, the rollback is "paste the whole object back", and `13` §2.6's `NoInverse::ExternalEffect` is the case it lands in — *"The configuration inverts; the world does not. Dropped sessions, external references to a renamed object."* And `13` §2.5's `retract_needs_value` bites — for an accumulating statement, `delete … proposals` removes all of them, so an emitter reaching for subtree deletes without consulting `Platform::supports_subtree_retract()` writes a change set bigger than the thing being retired | high | `18` §5, §2.3; `13` §2.4–2.6 |
| 8 | **The diagram's channel budget is full, and the collision is semantic** | `56` §5.2 is explicit: *"one channel, one meaning, and nothing may be added to it without taking something away."* G1 is freshness, G2 is AI-proposed product-wide and *"unavailable to this document"*, G3 is selection, G4–G9 are edge and band vocabulary. Worse, `56` §8.2 already concedes that a `--muted` boundary *"reads, at a glance, as de-emphasised — as if the node were disabled or filtered out. It is not; it is old."* A decommissioned node genuinely is disabled. Putting lifecycle on G1 makes one channel mean both | high | `56` §5.2, §8.2 |
| 9 | **…and `56` §12 already answered it for an identical problem** | `56` §12 handles concurrent layout edits and the export CSP as open items in exactly this idiom, and G10 — the view-band margin tab — is the named release valve in both `56` §5.2 and `52` §9.3. `diagram · 12 nodes · L3 · 4 decommissioned` costs nothing. **But `52` §9.3 rule 3 caps a band tab at two facts**, so a third fact means dropping one | medium | `56` §5.2, §12; `52` §9.3 |
| 10 | **The inventory column picker will not show a node-level attribute** | `52` §3.7: columns are *"chosen from the schema (`11` §11.6 makes the schema data, so the column picker is generated, not hand-written)"*. A node attribute like `absent_since` is not in `schema.yaml`, so it would never appear as a sortable, filterable column without hand-writing an exception into a generated picker. As a schema field it becomes a column, a sort key, a filter and a `Facet::Field` target for free | high | `52` §3.7; `11` §11.6 |
| 11 | **No `33` §6.4 merge class fits a single-valued lifecycle register** | A is security-material and resolves to `Conflicted`, which **blocks emit** — wrong for a field that emits nothing. B is descriptive LWW, and `33` §6.5's own argument kills it: recency encodes nothing but clock skew under concurrency, so two engineers setting `Maintenance` and `Decommissioned` converge on whoever's laptop was 40 seconds ahead. C is append-only, D is structural add-wins, E is set-valued. **None is a register.** Note `53` §16 already calls `absent_since` *"a last-writer-wins boolean… field class B under `33` §6.4"*, and nobody has checked whether that is right | high | `33` §6.3–6.6; `53` §16 |
| 12 | **Two orthogonal words for "not really here"** | `33` §6.6's worked example resolves *"B removes `GW-B` because the peer was decommissioned"* as a tombstone. Adding an explicit `Decommissioned` state creates a second absence concept with its own merge rule, emit behaviour and rendering, and a four-cell matrix of which three are nonsense. `Op::Purge` sits on tombstone only | high | `33` §5.1, §6.6; `11` §10.5; `53` §3.8 |
| 13 | **`workspace.as_of` is referenced by three documents and defined by none** | Not in `17` §10.1's `Settings`, not in `17` §4.2's record taxonomy, not in `11`. Who sets it, whether it is stored, whether it merges, what class it is — all undefined. Every date feature lands on it | high | `12` §3.4, §3.6; `18` §6.4; `17` §10.1 |
| 14 | **Unrouted wall-clock in the diagram, today** | `11` §8.7's age bands and `56` §8.1's rendering compare `max(asserted_at)` against something neither document names. `71` X4.1 forbids wall-clock in the SVG and X4.7 requires the exported diagram to be byte-identical across builds. Both cannot hold | high | `11` §8.7; `56` §8.1; `71` §7.3 X4.1, X4.7 |
| 15 | **A time-derived state breaks `12` §6.6's incrementality proof** | The proof's step 2 requires the result to be a pure function of the values read, *"no ambient state, no clock"*. A state that changes because time passed produces no delta, invalidates no dependency key, and is never re-evaluated. Deriving it from `workspace.as_of` fixes it, at the cost of a Tier C sweep every time `as_of` moves | high | `12` §6.2, §6.6, §7.1 |
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

---

## 8. What the owner must decide

*margin tab: the questions nobody asked*

Each row is a candidate `Dnn` for `73`. **None is answered here**, and each is stated so that a
yes/no or a pick-one answers it, which is `73` §1.1's admission test.

| # | Question | Why it must be answered before anything is built |
|---|---|---|
| **Q1** | Is lifecycle a **schema field** — in `schema.yaml`, generated into the node body, readable by `fex`, present in `FieldDelta`, in the generated column picker, with a `FieldClass` — or a **node-level attribute** like `absent_since`? | Everything else depends on it, and it must be taken before `62-schema-spec.md` is written. §7 rows 1 and 10 |
| **Q2** | One axis or two? A lifecycle stage and a transient operational state are different things | Folding them means an element in maintenance cannot also be scheduled for decommission, which is the most common real combination. Fixing it later is a major bump (§7 row 23) |
| **Q3** | What is the full enumeration? The owner named two and said "etc" | Each state is a row in every emit-behaviour table and every merge matrix. §3.3 lists candidates |
| **Q4** | Does a decommissioned element still emit — nothing, `delete` lines, or `deactivate` lines? Per-state or per-element? | `13` §2.4 makes the answer per-state, which means the emitter needs a per-state line form rather than a boolean |
| **Q5** | What happens on PAN-OS and IOS-XE, where `deactivate` is already `Unrepresentable { NoFeature }`? | A permanent `NOT EMITTED` block on the second platform is honest and looks like a defect |
| **Q6** | Does a decommissioned element still lint? If findings are withheld, is that a `Suppression` or a new mechanism? | If it is a new mechanism, what stops it becoming the unaudited suppression path `12` §17 D-6 exists to prevent |
| **Q7** | Is lifecycle a per-rule concern or a global engine policy? | Per-rule means every rule needs a position and an `acceptable_when` that accounts for it (invariant 8 makes `acceptable_when` mandatory). Global means one policy plus a `63` override |
| **Q8** | **Who sets `workspace.as_of`, where is it stored, does it merge, and does it advance on open?** | Referenced by `12`, `18` and the suppression ladder; defined nowhere. If it advances from the system clock, an untouched workspace stops reproducing its own change ticket |
| **Q9** | Does a maintenance window expire by itself, or is "past its stated end date" a finding computed against `as_of`? | The second needs no scheduler, no clock and no invariant amendment. The first needs all three |
| **Q10** | Do `11` §8.7 and `56` §8.1's age bands compare against `as_of` or the system clock? | Already ambiguous, already in tension with `71` X4.1 and X4.7 |
| **Q11** | Which `33` §6.4 class is lifecycle — and is `absent_since`'s current class B actually right? | None of the six fits a register. §7 row 11. Only live if ADR-0016 is reversed |
| **Q12** | Is "decommissioned" the same thing as "tombstoned", or a second independent absence? If both, what do the four combinations mean? | §7 row 12 |
| **Q13** | Can **edges** carry lifecycle, or only nodes? | `Node` has `absent_since`; `Edge` does not. "Decommission this link" and "this tunnel is in a maintenance window" are both things people will want |
| **Q14** | Is the ticket reference free text or a validated pattern, and one per element or many? | Many means a set-valued field, `33` §6.4 class E, and the `merge.set.widened` finding |
| **Q15** | Do the ticket reference and the maintenance window appear in the change ticket (`18` §6) and the plaintext export (`17` §15)? | Those artefacts leave the encrypted workspace. If yes, `17` §15.3's gate and `31` §7.2's channel list both need a line |
| **Q16** | Is `52` §12 **D3** now decided in favour of bulk edit? If yes: what does the confirm say when part of the selection is filtered out, and does it refuse outright when the selection spans a class A conflicted field? | `33` §7.4 makes the refusal path structural |
| **Q17** | What is the undo story for a bulk lifecycle change across a merge, given `53` §7.5's report-and-skip rule? Is partial undo permitted here, or must it be all-or-nothing? | §5.5 |
| **Q18** | Which key, and which gate? `⇧D` and `⇧P` are the two nearest neighbours and both are taken | And is the lifecycle verb excluded from `.` repeat (`53` §3.6)? |
| **Q19** | What happens to a decommissioned element's suppressions, findings, diagram position, provenance and layout pin? | `11` §10.6 answers this for renames. There is no equivalent table for retirement |
| **Q20** | Does the CLI get an `--as-of` flag? | `fathom lint` in CI reading a clock is a test that fails once a year |
| **Q21** | Should preserve mode still permit emit once lifecycle exists? | §7 row 24. Preserve mode already refuses to write back suppressions for the same reason |
| **Q22** | Which phase does this land in? | It touches `11`, `12`, `13`, `17`, `18`, `52`, `53` and `56`. Schema and emitter are phases 1–3; inventory and bulk are 2–3; merge semantics are 5. **Deciding it is one feature and scheduling it as one feature will not survive contact with `71`'s phase boundaries** |

---

## 9. Nearly free versus large

*margin tab: the cost is in the state model, not the feature*

> **THE FEATURE IS CHEAP. THE STATE MODEL IS EXPENSIVE. ALMOST ALL OF THE COST IS IN THREE DECISIONS**

`71` §14 states that every number in it is a planning assumption rather than a measurement, and its
smallest unit is the person-week. Nothing below is priced more finely than that, and where the
corpus gives no figure this section says so rather than inventing one.

### 9.1 Nearly free, because the corpus already built it

| Item | Why it is nearly free | Unit, where one exists |
|---|---|---|
| **The removal emitter** | `LineForm::Retract`, `Deactivate`/`Activate`, `Idempotency`, `retract_needs_value` and `Reversibility` all exist in `13` §2.4–2.6. `18` §3.3 computes removals; §3.5 minimises them with `subsume`; §5 generates rollbacks. Exclusion-from-emit already exists for tombstones | None in the corpus. It is wiring, not a subsystem |
| **Dates, if they are annotation rather than derivation** | `workspace.as_of` is already a `fex` constant with a dependency key and a delta; `12` §7.1 already lists suppression expiry rollover as a Tier C trigger; `18` §6.4 already records `as_of` in the ticket header. *"N elements are past their stated end date as of `<date>`"* is an ordinary finding | Rides on machinery that ships anyway |
| **Rule visibility** | Free if lifecycle is a schema field. A new builtin plus an engine release if it is not (`12` §3.7) | — |
| **The schema field itself** | A new optional field is a minor bump old clients preserve (`11` §11.3), and no user workspace exists yet. **It will never be cheaper than it is today** | — |
| **The diagram** | `56` §12 already reaches the answer for structurally identical problems, and G10 plus a filter costs nothing | — |
| **Multi-select gestures** | `52` §5.4 already specifies them, including the deliberate refusal of cross-view range select | Already specified |
| **The safety furniture for an invisible selection** | `52` §5.8 row 5 and §9.4 already specify `3 of 11 selected are filtered out` and the full-count confirm requirement | Already specified |
| **Undo granularity for a bulk edit** | `53` §7.2 already specifies one transaction and the label grammar (`dpd on 11 gateways`) | Already specified |
| **The ticket string in the clipboard** | `34` §6.3 already carries `# Fathom — change block for CHG-2026-0211` | Ships |
| **The privacy inventory row** | One row in `37` §2.2, plus optionally one rule in the shape `37` §2 already drafts | Below `71`'s granularity |

### 9.2 Large, and mostly not where it looks

| Item | Why it is large |
|---|---|
| **`62-schema-spec.md`** | ADR-0008's own figure: *"two to three weeks of specification plus the codegen"*, already on the critical path for phases 1–3 and **absent from `71`'s phase table**. Every field-shaped entry in this register queues behind it |
| **Giving `workspace.as_of` a home** | Twelve lines of struct. It decides whether an unchanged workspace reproduces its own change ticket, its own findings and its own SVG. Small in code, large in consequence, upstream of every date decision |
| **Bulk action as a first-class verb** | Not the loop. The confirm surface that counts from `set` rather than from what is rendered; the refusal path when the selection spans a class A field (`33` §7.4); partial-undo semantics across a merge (`53` §7.5); the announcement without spending the product's one `alert` role (`55` §4.6); and flipping `52` §12 D3. **This is the expensive half of the request, and the owner correctly identified it as load-bearing** |
| **Per-state, per-platform emit behaviour** | Every combination needs a `Representability` classification with a citation and a named reviewer, and `13` §9.2 already records `deactivate` as unrepresentable on both other platforms — so the second platform gets a permanent gap block |
| **Reconciling decommission with tombstone** | Two absence concepts, two merge rules, one `Purge` path covering one of them, and a four-cell matrix. Cheapest if lifecycle subsumes tombstone; that is a bigger edit and a better outcome |
| **Per-rule lifecycle policy** | A global engine policy is one field. Per-rule is a re-review of every rule's `acceptable_when` and grows with the corpus, which `71` identifies as the project's longest pole |
| **Anything that makes a state time-derived rather than human-asserted** | It reopens invariant 9, requires ADR-0002's amendment process, and `12` §6.6's incrementality proof has to be re-argued. **If exactly one thing off this list should stay cheap, it is this one** |
| **The lifecycle annotation surface as a component** | Comparable, not an estimate: `71` §6.6 prices *"suppression lifecycle and review view"* at 1–1.5 solo weeks. `54` §14 is the same component family, and its three non-negotiables transfer intact — the mandatory `unverified — workspace-local text, not an identity` tab, the reason quoted in full and never `line-clamp`ed, and expiry rendered as a countdown |

### 9.3 The asymmetry worth stating

**The feature is cheap. The state model is expensive.** Almost all of the cost sits in three
decisions — Q1 (schema field versus node attribute), Q2 (one axis or two) and Q9 (asserted versus
derived dates). None of them is a line of code. All three are nearly free to get right today and a
major schema bump to correct after phase 1 (`73` D16), aimed squarely at the air-gapped users
`11` §11.4 says have no update path.

---

## 10. Failure modes of this register

*margin tab: how a register rots*

| # | Failure | Symptom | Control |
|---|---|---|---|
| 1 | **It becomes a wish list** | Entries accumulate and none leaves. Nobody reads it, because a document with no exits carries no information about what is actually going to happen | §1.3's four exits, checked at every phase boundary. An entry that has not moved through two consecutive reviews is a candidate for the *killed* exit, not for a third review |
| 2 | **It becomes a specification by accretion** | An entry gains a type, then a component contract, then an enum, and a future reader treats the register as authority. This is the most likely failure, because writing the specification is more satisfying than writing the constraint | §1.2's table, and one review question: *does any entry contain a thing another document owns?* ADR-0001 makes ownership checkable |
| 3 | **It is read as approval** | Somebody finds C-04 and reads "planned" where the document says "refused". This is the failure with the largest consequence, because it is the one that would end with a network request in the artifact | §6's heading, the `NOT APPROVED` margin tab, and the register table in §1.5 naming the boundary and the three ship gates before any detail |
| 4 | **It duplicates `73`** | An entry becomes a well-formed fork and stays here anyway, so the same question has two homes and they drift | The *forked* exit is the intended one. When an entry becomes answerable, it moves and this row is struck through with a pointer |
| 5 | **Its cost claims rot** | The "nearly free" column ages badly: `18` §5's rollback generator changes shape and §9.1 still says the emitter is free | Every §9 claim names the document and section it rests on, so the claim breaks visibly when that section changes |
| 6 | **The standing priority instruction is read as licence to re-litigate** | Every settled decision gets reopened because "sunk cost is not an argument", and the project stops converging | §2.2's second column, and the rule that a reopening needs either a fired `Revisit if` trigger or a new requirement — not a new opinion |

---

## 11. Open decisions this register raises and does not answer

These are the forks this document surfaces. They belong in `73` §2 with an `R` value and a latest
responsible moment, and **this document does not put them there** — that is an edit to `73`, which
is not this document's to make.

| Raised | Where it lands | Note |
|---|---|---|
| Q1–Q22 (§8) | `73` §2, as `Dnn` rows | Q1, Q2, Q8 and Q9 are the four that gate the others |
| Whether `03` §4.3 `N-R-3`'s test permits an estate-state field | `03` §10.1's retirement process, or a clarification that it was never in scope | The `Reopens if: Never` cell means this is a boundary conversation, not a feature conversation |
| Whether `03` §4.2 `N-R-2` is already bent by `absent_since` and `Divergent` | Same | The parsed-versus-asserted distinction is the thing to test |
| Whether `52` §12 D3 flips | `52` §12, and then `73` if it needs an `R` | §5.4 |
| Whether `44` §3 adopts S1–S5, and what a bulk-write budget measures | `44` §3 | `52` §14 asked once and nothing happened |
| Whether `11` §17 #4's answer differs for a second kind of annotation | `11` §17 | §3.6 blocker 6 |
| Whether `11` §6.2's implicit `notes: [Text]` exists | `11` — a straight contradiction with §13, needing an edit either way | §3.4 row 1 |
| Whether `absent_since` is really `33` §6.4 class B | `33` §6.4, or `53` §16's proposed change | `53` §16 asserted it in passing and nobody checked |

---

## 12. Sources consulted

| Claim | Source |
|---|---|
| The owner's four requests, verbatim, and the instruction not to act on them | Owner, in conversation, recorded in §2.1, §3.1, §5.1 and §6.1 |
| The register/roadmap/ADR division of labour, and the entry-shape conventions this document copies | `docs/70-ops/73-open-decisions.md` §1.1, §1.4, §10.1–10.4 |
| "Retired boundaries are struck through, not deleted", and the two retirement routes | `docs/00-vision/03-non-goals-and-scope.md` §10.1–10.3 |
| `N-R-2`, `N-R-3`, `N-P-2`, the scope rule and its capability closure, and the twelve refusals table | `docs/00-vision/03-non-goals-and-scope.md` §3.2, §4.2, §4.3, §5.1, §5.2 |
| `absent_since`, `Divergent { since }`, the capture-scope table, annotation-only fields, the earn-a-kind test, the implicit carrier list, the `Node` struct, the age bands, schema bumps and preserve mode | `docs/10-core/11-ir-schema.md` §6.1–6.3, §8.7, §10.5–10.6, §11.3–11.4, §13, §17 |
| `fex`'s name environment and its four resolutions; the exclusion of clocks; `workspace.as_of`; the closed builtin table; the suppression record, its reason and expiry ladder; the tier budgets; the short-circuit soundness argument; D-2, D-5 and D-6 | `docs/10-core/12-rule-engine.md` §3.4, §3.6, §3.7, §6.6, §7.1, §11.1–11.4, §17 |
| `LineForm::Retract`, `Deactivate` versus `Retract`, `retract_needs_value`, `supports_subtree_retract`, the gap table and where a gap surfaces | `docs/10-core/13-emitters-and-provenance.md` §2.4–2.6, §9.2–9.3 |
| The miss log — local, never transmitted, exported by an explicit menu action | `docs/10-core/16-command-finder.md` §3.6 |
| The record taxonomy, the `Settings` struct, the plaintext gate's seven steps, the export header and the `review` warning | `docs/10-core/17-workspace-format.md` §4.2, §10.1, §15.3–15.5 |
| Removal computation, `subsume`, rollback generation, the change ticket, the YAML sidecar and `content_hash`, `DeltaClass`, OD-2 and OD-3 | `docs/10-core/18-diff-verify-rollback.md` §2.3–2.4, §3.3, §3.5, §5, §6.2–6.4, §10 |
| Metadata channel M5 and the change-window correlation | `docs/30-security/31-threat-model.md` §7.2 |
| The six field classes, the LWW argument, the tombstone worked case, the OR-Set finding, and the bulk-action constraint | `docs/30-security/33-sync-protocol.md` §5.1, §6.3–6.8, §7.4 |
| The no-links decision and its five reasons; the clipboard payload and its header; the WASM import allowlist and H39 | `docs/30-security/34-browser-hardening.md` §6.3, §7.5, §9.4, §10 |
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
| v1 is the finder; the product is phases 0–3; "Nothing about a graph" | `docs/90-decisions/adr-0006-v1-is-the-finder-and-the-product-is-phases-0-to-3.md` |
| `11` owns re-identification; a rename produces a candidate, never a binding; the recovery-key narrowing | `docs/90-decisions/adr-0010-identity-reparse-and-suppression-survival.md` |
| Git is the sync; no multi-writer CRDT until a pilot team works around the lock | `docs/90-decisions/adr-0016-git-is-the-sync-for-v1.md` |
| `53` owns the keymap | `docs/90-decisions/adr-0024-53-owns-the-keymap.md` |
| PAN-OS is the second platform | `docs/90-decisions/adr-0030-pan-os-is-the-second-platform.md` |
| Invariant amendments and the residual scale | `docs/90-decisions/adr-0002-invariant-amendments-and-the-residual-scale.md` |
| The ten hard invariants, the terminology table, and the depth requirement | `.context/conventions.md` |

---

## 13. Disagreements

No disagreement with any hard invariant, with the risk enum, or with the terminology table.

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
