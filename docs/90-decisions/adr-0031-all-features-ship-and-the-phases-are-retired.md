# ADR-0031 — All features ship, and the phase scheme is retired as a scoping device

> **Status:** **Accepted** — ratified by the owner 2026-08-08 (*"yes to all 3"*). Binding under
> `CLAUDE.md` rule 2; reopenable on merit under `75` §2, never on sunk cost.
> **Date:** 2026-08-06
> **Register entry:** `73` §3 (D02), `76` §8 Q11; `88` §4.4
> **Reversal cost:** R4 — reinstating a reduced first release after the queue has been re-cut costs the re-cut, not the code
> **Supersedes:** ADR-0006 (items 1, 3, 4, 5, 7 — the scoping items only)

## Context

ADR-0006 (Accepted, R5) decided *"**v1 = the finder.** … **Nothing about a graph.**"* and made
phases 0–3 the product. The work-order queue does not build that. Six of its eight orders are graph
work, and two say so in their own words — WO-02 calls itself *"`76` §7.2's S3 slice"*, WO-08
*"S4 slice, part one"*. `88` §4.4 filed the divergence as a BLOCKER: the tree asserts two
incompatible answers to *"what is v1"*, and the register that exists to prevent exactly that was
bypassed rather than used.

Asked to resolve it, the owner answered (`70` §4, verbatim):

> *"All features must be included in V1, how you wish to plan that out is your discretion."*

ADR-0006 anticipated this. Its own Negative consequences read: *"This is a decision to ship
substantially less than the brief describes, and the brief is the authority. One graph, six views
is the owner's thesis; v1 has one view and no graph. That gap has to be stated to the owner as a
proposed change, not discovered by them at the download page."* That is what happened, and the
owner overruled.

**No revisit trigger fired.** ADR-0006's four triggers are a pilot engineer opening a workspace
twice, an authoring median at or below 25 minutes, a second full-time person joining, and pilots
reporting the finder is useful only with a workspace open. None has occurred; `58` §4.4 records
deliberately that *"'The owner names inventory and diagramming as a goal' is not among them."* This
is a reversal **on merit**, which `CLAUDE.md` rule 2 and `75` §2 expressly permit — *sunk cost never
argues for keeping a decision*. Saying so plainly matters: a superseding record that claimed a
trigger fired would be a false record.

## Decision

**1. The feature set of the first release is the whole product.** There is no reduced v1. Every
capability the corpus specifies is in scope for the first release: the graph, the six views, the
finder, ingest, emitters, findings, the workspace, the diagram, the inventory and service layer.

**2. The phase scheme is retired as a *scoping* device.** `71`'s eight phases no longer determine
what ships. They remain readable as history and as an effort model, under the banner item 5
requires.

**3. Sequencing is delegated to planning.** The owner's *"how you wish to plan that out is your
discretion"* makes the build order a planning artifact. `76` §7.2's S-slices and
`docs/70-ops/79-work-orders/` continue to govern it, under `78` §8. Re-cutting the queue stays
planning work; nothing here changes `78`.

**4. Nothing in `71` §13.1 moves.** Its thirteen rows are permanent product boundaries, not
deferrals, and its own preamble says so: *"Each row is a permanent decision, not a phase-N
limitation. If a future document proposes one of these, it is proposing a different product and
should say so."* Retiring phases retires phase-*limitations* only. Invariants 1–10 are untouched.
Two rows are worth naming because this ADR could be misread as reaching them: row 10 forbids *"a
plugin system that executes third-party code in the application"* — which constrains ADR-0032 and
is not loosened by it — and the SNMP/LLDP row in §13.2 forbids Fathom *gathering* neighbour data,
while `03` §4.5 permits the user pasting it. Both stand exactly as written.

**5. Four documents are re-anchored.** These are the smallest honest edits, not a rewrite:

| Document | Edit |
|---|---|
| ADR-0006 | A `Superseded by ADR-0031` line on its scoping items, once this ADR is Accepted. Items 2 and 6 are not scoping and survive on their own merits |
| `71-roadmap.md` | A two-line banner under its status line: superseded as a plan by this ADR, retained as an effort model, with the live build order at `76` §7.2. **Do not repair `71` sentence by sentence** — its unit of organisation is the thing that changed, and five of ADR-0006's six ordered edits are to a plan being replaced |
| `73-open-decisions.md` | Ranks C–F are denominated in phases (*"before phase 1 exits"*, *"phases 4 and 5"*, *"phase 6"*, *"phase 7"*) and Rank D's margin tab reads *"what v1 does not need"*, which this ADR falsifies outright. Re-anchor the ranking to **events** — what blocks what — as Ranks A and B already are. Planning work, and it is real work: the ranking does not merely go stale, it inverts |
| `75-capability-register.md` | Twelve entries carry a *"not before phase N"* floor. The floors are void; the entries are not. Each keeps its dependencies |

**6. Deferrals made for reasons other than scope survive, and must be re-stated as such.**
`71` §3.4's nine-row *"deliberately not in phase 0"* table is void as a set of deferrals, with two
exceptions that were never about phase: distance-2 fuzzy matching, refused on measured precision
grounds (`16` §6.3 — *"at distance 2 over ~1,200 keys the result set stops being precise"*), and
full reproducible-build attestation, which `71` §13.2 calls *"the one deferral here with a hard
deadline"* — a gate before first public download, not a phase item.

## Consequences

### Positive

- The tree stops asserting two answers to *"what is v1"*. `88` §4.4's blocker is discharged.
- The queue becomes legible: it was already building the graph product, and now the decision record
  says so instead of contradicting it.
- `71` §3.4's eight genuine deferrals come back into scope, including the ones closest to the
  owner's stated priorities — context awareness, findings, and workspace persistence.
- ADR-0016 (git is the sync **for v1**), ADR-0020 (no model **in v1**) and ADR-0023 keep their
  substance: each was argued on evidence or security, not on release scoping. Their *"for v1"*
  phrasing now needs re-reading as *"until the stated trigger fires"*, which is what each already
  says in its own Revisit-if section. **This ADR does not reopen them.**

### Negative

- **The near-term decision load rises, and this is the real cost.** `73`'s Ranks C–F existed to say
  *"these can safely wait"*. With no phases, their contents move toward Rank A. Decisions the
  project had permission to defer — the sync protocol, multi-writer convergence, the AI boundary's
  runtime shape — now need an ordering principle that does not exist yet.
- **It collides with ADR-0003, and the collision is not resolved here.** ADR-0003 (Accepted,
  unreversed) decides nobody funds this and records that under that assumption *"the honest scope is
  one platform, one domain, forever, and ADR-0006's cuts are not optional."* This ADR removes the
  cuts and leaves the funding assumption untouched. Both can be true — the product ships whole and
  takes as long as one person takes — but *"all features"* plus *"one person, unfunded"* is a
  schedule nobody has drawn. `70` §11 item 2 states the tension; it is listed below as a revisit
  trigger rather than papered over.
- **`71` becomes a document with a banner rather than a plan.** Until someone re-cuts it, the
  project's answer to *"what are you building and in what order"* is a work-order queue plus an
  analysis section, which is less legible to a newcomer than eight named phases were.
- The ADR review cadence loses its clock. `90-decisions/README.md` reviews the register *"at every
  phase boundary, and at those points only"*. With no phase boundaries there is no cadence at all —
  which `88` §6.12 independently found to be broken for a different reason. Both are fixed by the
  same one-sentence change, and it is now urgent rather than cheap.

## Alternatives considered

| Option | Why not |
|---|---|
| **Keep ADR-0006; re-cut the queue back to the finder** | Directly contradicts the owner's answer. It is also the more expensive reading: six of eight queued orders would be withdrawn |
| **Leave both Accepted and let the queue speak** | The status quo, and the defect `88` §4.4 names. A register that records a decision the tree contradicts is worse than no register |
| **Retire phases *and* rewrite `71` into a phase-free plan now** | Rejected on sequencing, not on merit. `71` is 1,400+ lines organised around the thing that changed; rewriting it blocks nothing and would delay this record. Banner now, re-cut when someone has a plan worth writing |
| **Declare "all features" but keep phases as a delivery order** | Considered seriously. Rejected because `71`'s phases carry exit criteria, kill points and a risk-retirement column — they are a scoping instrument, not a sequence, and keeping them would preserve exactly the ambiguity this ADR exists to remove |

## Revisit if

- The owner reverses on funding — a second full-time person, or any funded time. That changes
  ADR-0003's premise, which is the one this ADR leaves in tension.
- A re-cut `71` (or its replacement) is written and Accepted; this ADR's item 5 is then discharged
  and should say so.
- The `73` re-anchoring (item 5) proves impossible without an ordering principle, in which case the
  principle itself needs an ADR before the re-anchoring proceeds.
- Elapsed time makes *"all features"* demonstrably unreachable — the honest trigger being a year of
  work without a shippable artifact, which is what ADR-0006 was originally written to prevent.
