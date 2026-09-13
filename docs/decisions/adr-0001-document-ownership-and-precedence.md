# ADR-0001 — Every settled question has one owning document

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `81` §13.1 and `83` §15.1, §15.3, M7
> **Reversal cost:** R1
> **Supersedes:** —

## Context

Four of the six critiques converge on the same mechanism rather than on any individual error.
`83` §2.1 built the cross-document dependency graph — 43 documents, 312 cross-references — and
found that deferral edges ("X owns this, see `NN`") are almost always sound, while **nine silent
re-decisions** exist, and *all nine are contradictions*. They cluster in exactly one place:
wherever two documents were both plausibly the owner of a question and neither was told which.

The four schisms are not matters of taste:

| | Two documents, one artifact |
|---|---|
| **F1** | `17` and `32` each specify the full on-disk container, incompatibly, in full, with code |
| **F2** | `34` §3.3 and `43` §3.5 each define what the offline single file contains, at four sizes |
| **F3** | `21` §5.1 and `22` name disjoint subagent rosters with zero cross-references |
| **F4** | `11` §10.3 and `12` §11.4 each specify re-identification, and `12` persists a key `11` forbids |

`conventions.md` pinned terminology, invariants, colours and identifiers, and the instruction *"do
not redefine any of these"* was obeyed — nobody redefined a convention — and the corpus still
failed to compose. The pinned list covers vocabulary and does not cover **decisions**.

The `## Disagreements` mechanism works: every disagreement raised through it (`32` §21, `17` §§20–21,
`44` §13, `21` §18, `43` §13) is well argued and actionable. It is also insufficient, for the reason
`83` §15.2 gives: the mechanism only fires when an author *notices* a conflict, and a document that
re-decides a question in good faith has by definition not noticed.

`81` §9's O11 is the proof that the procedure alone does not close anything: four documents filed
four correct, incompatible repairs to invariant 3, and nobody adopted one. That is a governance
failure, not a documentation failure.

## Decision

**Adopt an ownership register, a precedence rule, a fifth `Status` value, and a mandatory
"building on" declaration.**

**1. `docs/00-vision/01-ownership.md` is created.** One table, one row per settled question, naming
the owning document. It is written before any other item in this ADR set is executed. Initial
ownership, adopting `81` §13.1's proposal and `83` §11's table:

| Question | Owner |
|---|---|
| Workspace container layout, record taxonomy, git behaviour | `10-core/17` |
| Cryptographic primitives, key hierarchy, key management, envelope content | `30-security/32` |
| The wire | `30-security/33` |
| The browser platform and the CSP per mode | `30-security/34` |
| Deployment shapes and their lettering | `40-stack/43` |
| Size, memory and latency budgets | `40-stack/44` |
| The IR, node kinds, identity tuples, re-identification | `10-core/11` |
| The rule engine, `fex`, suppression shape | `10-core/12` |
| The subagent catalogue, tool grants, gates | `20-ai/22` |
| The AI boundary, verbs, tiers, egress machinery | `20-ai/21` |
| The keymap | `50-design/53` |
| Design tokens, the channel budget | `50-design/51` |
| Open decisions and their register IDs | `70-ops/73` |

**2. The precedence rule is added to `conventions.md`**, verbatim from `81` §13.1:

> **Precedence.** Where two documents specify the same artifact, exactly one is the **owner** of
> that artifact and every other document references it rather than restating it. The owner is named
> in the artifact's own document header. A document that needs to change something it does not own
> raises a `## Disagreements` entry and **may not ship a second specification in the meantime.**

**3. `Status:` gains `Superseded by NN §M`**, and a document whose core decision is contradicted by
a sibling must read `Contested`, naming the sibling. Under this rule `17`, `32`, `21`, `22`, `34`,
`43` and `44` all read `Contested` today, which is the honest state and the fastest way to stop
somebody implementing from the wrong one.

**4. Every document's §1 declares what it builds on.** Per `83` §15.2: list every sibling decision
you are building on, by name and section. A document with no such list has not checked.

## Consequences

### Positive

- The four schisms become resolvable rather than arguable. Each of ADR-0012, ADR-0017, ADR-0021 and
  ADR-0010 is an ownership assignment plus a deletion, not a redesign.
- The cost of the next parallel authoring round drops sharply. `83` §2.1's finding is that deferral
  works and this corpus is very good at it; the register turns every restatement into a deferral.
- A reader who opens two documents can tell which one is wrong without reading a third.
- It costs one page and it would have prevented F1, F2, F3 and F4.

### Negative

- **The register is itself an unowned document until somebody owns it.** It has the same failure
  mode as the thing it fixes, one level up. Mitigation: the register is short enough that its
  divergence is visible, and it is reviewed at the same phase boundaries as `73`.
- **Ownership slows correction.** A document that spots a real defect in another's territory can no
  longer just fix it; it files a disagreement and waits. The corpus is already carrying five open
  disagreements that nobody closed, and this rule adds procedure to a project whose bottleneck is
  one person's attention.
- **`Contested` on seven documents is a bad look in a repository shown to an enterprise reviewer.**
  It is also true, and `36` is already quoting one side of a live fork to a customer (`81` §7.3).
  Honest and awkward beats confident and wrong, but the cost is real and is paid at the worst moment.
- **A register invites a taxonomy argument.** "Who owns the export gate" is answerable; "who owns
  redaction" is not, because it is genuinely split between `14`, `32` and `21`. Rows will be
  contested and each contest costs a conversation.
- Retrofitting the `Status` change means editing every document header in the corpus.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Keep `## Disagreements` and try harder** | `83` §15.2 refutes it structurally: the mechanism cannot fire on a conflict nobody noticed, and all four schisms were authored in good faith by people who had not read the sibling. Four correct disagreements against invariant 3 produced zero decisions |
| **A single editor merges everything by hand** | It is the right answer for a corpus one person can hold. This one is 4 MB across 43 documents and the merge is the work the register exists to avoid. It also concentrates the bus factor `72` §10.4 already rates fatal |
| **Number every claim and cross-reference mechanically** | Produces a citation graph, not an ownership graph. `83` built exactly this graph and it located the contradictions; it could not resolve one of them, because resolution needs an authority and a graph has none |
| **Let the implementer decide at build time** | `83`'s governing rule answers it: *"the implementer will build whichever one they read second."* That is the current state and it is what produced two products |
| **Merge the conflicting documents into one** | `17` + `32` is ~4,000 lines covering two genuinely different specialisms. One document nobody can review is worse than two that defer |

## Revisit if

- A row in the ownership register is contested twice by two different authors — the row is drawn in
  the wrong place and the question is genuinely shared.
- Six months pass with no document filing a `## Disagreements` entry — the register has become a
  way of suppressing objections rather than routing them.
- The corpus contracts to a single author, at which point the register is overhead and the honest
  move is to delete it and say so.
