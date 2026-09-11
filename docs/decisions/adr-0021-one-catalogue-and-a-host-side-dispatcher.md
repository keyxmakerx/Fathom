# ADR-0021 — One subagent catalogue, and the supervisor is a host-side dispatcher

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — resolves `83` F3 and `85` F8, F2, F11
> **Reversal cost:** R2 — types and documents, before anything is built
> **Supersedes:** `21` §5 and §6; `22` §19 D1; `25` §1.2's mapping table

## Context

`21` and `22` are two AI architectures wearing one section number (`85` F8). They were authored
independently and neither yields:

| | `21` | `22` |
|---|---|---|
| Catalogue | 8 named subagents | 10 numbered specs S1–S10, plus 4 refused |
| Proposal type | `Proposal` — `ops`, `Rationale{Basis, citations, witness, note}`, `PredictedEffect`, `caveats` | `Proposal<T>` — `payload`, `ProposalConfidence`, `evidence`, `GateReport`, `ToolTraceHash`, `ModelProvenance` |
| Confidence | `Basis { Cited, SanctionedException, Judgement }` | `ProposalConfidence { Grounded, Inferred, Speculative }` |
| Capability enum | `Caps: u16`, 9 flags | `ToolGrant: u32`, 23 flags |
| Tool surface | 11 tools | *"There are nineteen. This list is exhaustive by design"* |
| Gates | none by that name | G1–G11, *"the deliverable"* |
| Supervisor | plans, adjudicates, may retry a plan | *"a router, not a planner"* (§15.1) |
| Egress consent | per (workspace, purpose), expiring | **per invocation** |
| Cross-reference | points at `22-subagent-catalogue.md` | the file is `22-agent-catalog.md` |

`22` contains not one occurrence of any of `21`'s eight identifiers, and it argues two of `21`'s
eight out of existence — `symptom.correlator` (*"never, as a reasoner"*) and `corpus.scout`
(*"never… the resolution problem is already solved, totally"*) — while `21`'s per-tier degradation
table and **both worked scenarios** are driven by those two. `25` §1.2 documents the collision, calls
it *"DECISION NEEDED — one catalogue, one set of ids"*, keys itself to `22`, states its mapping table
*"is not authoritative"*, and correctly leaves the decision unmade.

Underneath that sits a second finding that nobody has said out loud (`85` F2). `21` opens by taking
*"there needs to be a supervisor AI"* seriously and then, correctly and step by step, removes every
reason for the supervisor to call a model: `resolve()` is pure and deterministic; `CLASSIFY` is a
~40-pattern grammar and `21` §14 says do not ship the classifier at tier 1; `DECOMPOSE` is overridden
by `22` §15.1 (*"the supervisor is a router, not a planner"*); plan legality, dispatch, adjudication
and budget are all host-held. Both worked scenarios confirm it: **the supervisor makes zero model
calls.**

`22` §1.1 says the quiet part: *"a subagent in Fathom is not a persona. It is a tool grant, an input
type, an output type, a context ceiling and a deterministic gate, bound together and named."* That is
an accurate description of a capability-scoped tool-call protocol, not of a multi-agent system.

## Decision

**One catalogue: `22`'s types, `21`'s boundary. And the architecture is renamed to what it is, in one
sentence, so the owner can overrule it.**

1. **`21` §5 and §6 are deleted** and replaced by two paragraphs and a pointer. `22` owns the
   catalogue, the gates, `SubagentSpec` and `ToolGrant`; `21` owns the boundary, the verbs, the
   tiers, the egress machinery and `PredictedEffect`.
2. **`22` §2.2's `Proposal<T>` absorbs `21` §2.3's `PredictedEffect`, `Basis` and `caveats`.**
   `Basis` and `ProposalConfidence` are the same three-value idea and **must not both exist**.
3. **Consent reconciles toward `21`**: per-(workspace, purpose) grants with a 90-day cap, re-firing
   on payload-shape change. `22` §1.3's per-invocation disclosure becomes **a diff against the last
   consented shape** — new field classes, new node kinds, first `EmitDetail::Lines`, first
   `CAPTURE_READ` — with the bytes one keystroke away. At `21` §10.5's assumed twenty requests a day
   with up to four spawns each, per-invocation means up to eighty raw-JSON disclosures per engineer
   per day, which is not consent; it is a rubber stamp with a keyboard shortcut, and it trains users
   to dismiss the *first* pre-flight, which is the only one `21` says has value.
4. **`21`'s tier table stays**; `22` §1.4's five shapes are re-expressed against it.
5. **The file is renamed `22-subagent-catalogue.md`**, per ADR-0002's terminology amendment — the
   current filename breaks the conventions' own ban on unqualified "agent", and `21`'s only pointer
   to its companion document does not resolve.
6. **`25` §1.2's mapping table is deleted** once (1) lands, because it will be wrong.
7. **`22` §19 D1 is deleted** (`85` F11). It proposes a schema change `11` §8.2 already ships —
   `Actor::Supervisor { session, subagent }` and `ProvenanceRecord::supersedes` — and blocks on it as
   an open decision. `21` §2.5.1 gets this right and says so. Two-line edit; removes a blocking
   decision.
8. **`21` §4.1 says what the supervisor is**, in one sentence:

   > *"A host-side dispatcher. It holds the budget, enforces the plan invariants and adjudicates
   > results, and at tiers 0–3 it does this without calling a model. Every model call in this layer
   > is made by a worker, under a named grant."*

   And `21` §5.2's four arguments for decomposition are re-stated honestly: the egress saving comes
   from **not accumulating tool results in one context**, which a stateless, per-call-scoped protocol
   achieves without any notion of an agent. The real value of the design is (a) per-worker capability
   grants, which a single agent cannot have without holding their union, and (b) per-worker context
   ceilings, which bound tier-1 egress. Both are host properties. The document should say why it did
   not take the single-agent-with-a-broker route, because it does not.

## Consequences

### Positive

- An eval report can be matched to a spec, which is `25`'s own stated blocker and it is correct.
- One proposal type, one confidence enum, one capability enum, one tool surface. The gates — `22`'s
  actual deliverable — apply to a roster that exists.
- The owner is told, in one sentence, that they are getting a Rust dispatcher and a set of prompts.
  That may well be the right answer; they should be the ones to say so.
- The latency and failure modes multi-agent designs are notorious for are genuinely **not** incurred
  here — depth ≤ 2, no subagent spawns a subagent, one card per session, host-held budget. That is
  good news the corpus does not currently claim.
- Deleting a blocking open decision (`22` D1) costs two lines.

### Negative

- **`21` §5 and §6 are deleted, and `21` is the document that carries the argument.** The catalogue
  in §5.1 is a sketch that predates `22`'s 3,782 lines of argued admission decisions, but the tier
  degradation table and both worked scenarios are keyed to it, so the deletion cascades into
  §7.6 and §13 — and ADR-0029 shows those scenarios have to be rewritten anyway.
- **Scenario B is driven by `symptom.correlator`, which `22` §5 declines to build.** Either the
  scenario is wrong or `22` §5 is; the scenario is the more persuasive artifact and the weaker
  argument, so it loses. Losing the most persuasive artifact in the AI corpus is a real cost to
  anyone trying to understand the design.
- **Saying "the supervisor is not an AI" out loud risks the owner concluding the requirement was
  not met.** It was met in the way that is architecturally defensible and not in the way the phrase
  conjures. That conversation is now unavoidable, which is the point and is still a risk.
- **Reconciling consent toward `21` weakens `22`'s strongest privacy claim** — *"not a summary, the
  bytes. A privacy claim you cannot check is a marketing claim."* A shape-diff is checkable in
  principle and less checkable in practice, and `22` §16.2 already concedes nobody reads the preview.
- **`22` has no analogue for `finding.narrator` as a separate worker, and `21` has none for S7 or
  S10**, so the merge is not mechanical: three specs have to be re-homed by hand and one of them
  (S3 vs `symptom.correlator`) reaches *"compatible conclusions, incompatible surfaces"*.
- **A rename touches every cross-reference to `22`** and there are many.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **`21` owns everything** | It carries the security argument, the boundary, the tiers and the egress design — the parts that make the layer defensible to a reviewer | It does not carry the types an implementer needs. `SubagentSpec`, `ToolGrant`, the eleven gates and the eval contract are all in `22`, and the gates are the mechanism by which the whole design is trustworthy |
| **`22` owns everything** | 3,782 lines of argued admission decisions, and its refusals are the clearest statements of the product's identity in the corpus | Its consent model is per-invocation, which is a dark pattern by accident, and it has no tier model, no CSP story and no egress machinery. `21` §8 is the best AI-security section in the corpus and would be lost |
| **Keep both and write a mapping table** | `25` already drafted one and it costs nothing | `25` itself says the table *"is not authoritative"*, and a mapping between two live specifications is a third thing to keep in sync. `85` is right that this is the most expensive finding to fix and the cheapest to state |
| **Make the supervisor actually call a model** | It would satisfy the owner's requirement literally, and a planning model can compose subagents in ways a dispatch table cannot | Every step it would take is one `21` has already given a deterministic answer to, and each model call is latency, egress and a failure mode. `22` §15.1's *"router, not a planner"* is the right design; the honest move is to name it, not to reverse it |
| **Rename the concept away entirely — call them "tools", not subagents** | Most accurate. `22` §1.1's own definition is a tool grant | The owner used the word. Renaming their requirement out of existence is worse than delivering it precisely and saying what it is |

## Revisit if

- The owner reads `21` §4.1's new sentence and says a dispatcher does not satisfy the requirement —
  then the decision is theirs and this ADR is superseded, not amended.
- A subagent is proposed that genuinely needs plan-level composition (a chain the host cannot
  topologically sort in advance). That would be evidence the dispatcher model is too weak, and it has
  not appeared in eighteen candidates.
- The shape-diff consent surface is measured and users still do not read it, which would mean the
  consent design should stop optimising for readability and optimise for scope instead — fewer
  grants, narrower purposes.
