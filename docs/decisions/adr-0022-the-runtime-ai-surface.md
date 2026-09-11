# ADR-0022 — The runtime AI surface: one worker, one transcriber, three build-time tools

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `85` §4, §5, §7, §8, §10, §12
> **Reversal cost:** R1 per subagent — none of them is built yet
> **Supersedes:** `21` §14's ship list; `22`'s v1/v2 tiering for S2-A, S3, S4, S7, S8

## Context

`85` §4 applies `21`'s own admission criterion A1 — *"write the rule; if you can, the subagent is
rejected"* — to all eighteen candidates named across `21` §5.1, §5.4 and `22` §§3–13, without
deference. The result:

| Verdict | Candidates |
|---|---|
| **Ship, runtime** | S1 (intake) — the one place a model does something the corpus structurally cannot |
| **Ship, runtime, conditional** | S6 (interop advisor), as a transcriber only, after the typed form |
| **Ship, build time** | S5 (rule-authoring), S9 (gap finder), S2-B (dictionary drafting) |
| **Cut** | `intent.router`, `corpus.scout`, `constraint.negotiator`, `config.triage`/S2-A at runtime, `symptom.correlator`/S3, S3F, `finding.narrator`/S4, S7, `adversary.redteam`/S8, S10, and the nine both documents already refuse |

Three cuts are argued against the corpus's own preference and each has a document arguing the other
way with itself:

**`constraint.negotiator`** is `21` §14's **first "Ship"**, so it gets built first — and `21` §10.4,
in the same document, rates its non-AI fallback *"fully sufficient. The model shortens the
interaction; it does not enable it."* Both sentences cannot be true. `21` §12.8's own honest scoring
awards the model *"ordering and the decision to check"*, and notes its one substantive contribution
(picking 1800) was wrong, uncited and overridden. It is also unevaluable under `25` — `iBenefit` is
structurally zero when both arms reach the same answer — and it violates admission criterion A4 on
any ordinary reading of "wide", which cannot be checked because `wide()` is never defined anywhere
in `20-ai/`.

**`config.triage`/S2-A** holds `GATE_CHECK` so it can run gate G5 on its own candidate and iterate.
`22` §2.3 celebrates this. `85` §4.2 shows why it is backwards: **that is a search whose objective
function is G5**, so the output set is `{correct bindings} ∪ {G5's blind spot}` — and G5's stated
blind spot is *"a semantically wrong capture that renders identically"*. Under guessing that is a
rare tail; under search it is the **attractor**. `22` §7.8 sees this exact dynamic for the build-time
rule author and installs a mechanical backstop; no equivalent exists at runtime.

**`adversary.redteam`/S8**: `22` §10.4's own table shows the reviewer is redundant on exactly the
classes where it is trustworthy (G1, G2, G3, G6, G10) and is the sole detector on exactly the classes
where its judgement is unverifiable. `24` §2.7 adds the hard rule: *"an adversary weaker than the
producer produces false assurance, which is worse than no adversary."* Four documents independently
arrive at "probably worthless and getting more so", and `21` §14 still says Ship — with the reason
*"its cost is bounded by proposal volume"*, which argues it is cheap rather than that it works.

Two boundary defects apply to whatever survives. **`ask_human` is the leak** (`85` F3): up to 760
characters of model-authored prose rendered to the user, exempt from the citation obligation, the
paraphrase detector, the command-shape detector and IL-1 — and the human's answer re-enters the
session as **trusted**, grounding a proposal that `21` §2.5.1 then records as `Actor::User`. `85`
§6.1 demonstrates the payload: a `description` field in a parsed config that induces a leading
question, producing *"a human-authored, human-signed, permanently recorded waiver of a `high`
security finding, with a citation that verifies."* Nothing in the pipeline fires.

And **`blind_accept_rate` cannot be collected** (`85` F5). It is the kill criterion `21` §14 says
*"predicts whether this product harms anyone"*, gated at K4 as an immediate kill above 0.30, and it
is computed on the user's client, which invariant 1 forbids from transmitting anything. Five other
metrics have the same problem and two of them are listed as build-blocking.

## Decision

**Build the roster `85` §4 arrives at, in `85` §12's order, and close the two boundary defects
before any runtime worker ships.**

1. **Runtime: S1 only, behind the ask box.** Conditions: `22` §3.2's DECISION holds permanently — the
   ask box is a different control from `Ctrl+K`, never a mode of it — and K11 is expected, because
   `25` §13.2 already shows S1's margin decaying from +16 to +13 as the synonym map absorbs miss-log
   items. Plan its removal in the roadmap, not as a failure.
2. **S6 ships as a transcriber only, after the typed peer-constraint form**, and after ADR-0029's
   three missing rules land — without them the exception register it exists to produce is half-empty
   on its own worked input.
3. **Build time: S5, S9, S2-B.** Two of them *add* corpus capacity, which is the product's actual
   constraint. `22` §11.10 is right: *"if only two subagents are ever built, they should be S9 and
   S5."*
4. **Cut the rest.** `constraint.negotiator`'s one real contribution — hoisting the branch that
   matters to the front of the walkthrough — is a **walkthrough-authoring problem**: the branch is
   `IkeGateway.peer ∈ {Address, Dynamic}` and it is knowable statically from the step graph. Order
   branches by `(downstream steps pruned, then authored order)`, ship it in the walkthrough spec, and
   every user gets it offline, at tier 0, deterministically, on their first run.
5. **`ask_human` is closed**, four changes: `because` becomes a `CorpusRef`, not prose; `question`
   and `choices` pass the command-shape and paraphrase detectors; the question is logged with the
   session and rendered in the audit view beside the value it produced; `allow_free_text` defaults
   to `false` and a free-text answer marks every dependent op `Basis::Judgement`, pre-unchecked. Fix
   (1) kills `85` §6.1's payload outright, because no authored corpus entry asserts what that peer's
   appliance can do.
6. **Gate probing costs budget.** `AiBudget` gains `gate_probes: u8`, default 6, and
   probes-per-accepted-claim is reported in the eval and in `SubagentVerdict`. A subagent whose
   claims each cost four probes is searching for the gate's blind spot, and that is a number a
   reviewer can read.
7. **`blind_accept_rate` becomes a client-side control, not a release gate.** The client already
   computes it: render it in the workspace's own AI panel — *"you accepted 11 of 14 proposals without
   opening the emit preview"* — and **the client disarms the layer above 0.30**, with a one-line
   explanation and a re-arm button. `21` §3.4 gains a `Collectable where?` column with three honest
   values, and `25` §10.3's K4 is rewritten to reference the local disarm.
8. **Two smaller corrections**: `21` §14's correlator kill test (*"if it agrees more than 80% of the
   time, cut it"*) rewards disagreement — a correlator that agrees 79% and is wrong on the other 21%
   survives. Delete it and point at `25` §6.3, which measures correctness. And A1 gains a bound:
   *"expressible as at most three rules over the existing `fex` grammar, within `12` §15.3 gate 7's
   2,000-VM-step budget, without new builtins"* — falsifiable, and it would have caught
   `constraint.negotiator`.

## Consequences

### Positive

- The runtime AI layer that survives an honest A1 test is **one worker whose fallback is the shipping
  product, plus one transcriber that reads documents the product otherwise cannot read at all**.
  Everything else is build-time tooling, which is far better than what *"a supervisor AI and sub
  agents"* conjures.
- Two of the five things built increase authoring capacity rather than consuming it, against a
  product whose stated constraint is corpus coverage (`15` §12, `22` §18 point 5, all of `84`).
- The eval budget drops to roughly a quarter of `25` §11.3's — which currently costs more than
  seventeen engineers' usage, plus 0.12 FTE of senior and corpus-author attention forever.
- The safety-critical metric becomes enforceable on the user who is actually at risk, which is
  strictly stronger than a number in a build report that can never be computed.
- S9's semantic-coverage job — `85` §11.1's best AI feature — attacks the product's real constraint
  and has no deterministic alternative: the coverage join finds *absence*; nothing finds *hollowness*.

### Negative

- **This cuts the feature the corpus most wants to build.** `constraint.negotiator` is `21` §14's
  first Ship and constrained construction is a real user problem. The replacement — deterministic
  branch ordering — solves the measured part and not the imagined part, and if the imagined part was
  real, this decision does not find that out.
- **A client-side disarm is a control the project can never observe.** The honest consequence of
  moving `blind_accept_rate` local is that nobody will ever know the population rate, so K4 becomes
  unfalsifiable at the release level. This is the least bad option under invariant 1 and it is not a
  good one: the product cannot learn whether it is harming people, only individually stop.
- **Cutting S8 removes the only mechanism aimed at unverifiable failure classes.** `22` §10.4 is
  right that it is redundant where trustworthy — and where it is not redundant, nothing replaces it.
  The mitigation (build the seeded-defect corpus, do not build the reviewer) turns an unknown into a
  specification for new gates, and new gates take time nobody has budgeted.
- **`ask_human` with `because: CorpusRef` can only ask questions the corpus has already anticipated.**
  A genuinely novel situation produces no question, so the subagent abstains where it would have
  helped. That is the correct default and it narrows the layer further.
- **`gate_probes: u8` will be hit by legitimate work**, and the response will be to raise it. The
  metric (probes per accepted claim) is the real control and it is a report, not a gate.
- **Five cut subagents mean five documents' worth of specification becomes reference material**, and
  `22`'s value is largely in the specs it now does not need.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Ship `21` §14's list (two clear keeps, two narrow, two conditional)** | It is the AI architecture document's own considered verdict, and its author reasoned about each row | Its first keep is refuted by its own §10.4 and §12.8, its adversary keep is argued on cost rather than efficacy, and its correlator kill test rewards being wrong. Applying A1 without deference is `21`'s own instruction |
| **Ship `22`'s four v1 entries (S1, S2-B, S5, S9)** | Very close to this decision, and `22`'s admission analysis is the most rigorous in the corpus | It keeps S2-A's `GATE_CHECK` iteration, which `85` §4.2 shows converts a rare tail into an attractor. Otherwise this decision is `22`'s list plus S6-conditional |
| **Keep S2-A with a tighter harm gate** | `22` §4.11 already sets the tightest ceiling in the catalogue at ≤0.5% | `25` §3.2 proves that gate needs n ≥ 600 scoreable claims and the set has 400. A gate reported as under-powered in the release report is a gate that did not fire, and the report still reads green |
| **Keep `ask_human` free-form and rely on the human** | The human is the control; that is the whole review model | `23` §9.3's own rule: *"if the defence needs the model to be honest, it is not a defence, it is a hope."* The same applies to needing the human to be sceptical of a question framed for them |
| **Make `blind_accept_rate` an opt-in telemetry metric** | It would actually be collectable, and users who opt in are the ones who care | Invariant 1 forbids telemetry at any tier, and an opt-in population is not the population at risk. Reversing invariant 1 for a safety metric is a bigger decision than the metric |

## Revisit if

- S1's measured margin decays past the point where the synonym map covers the misses — that is K11
  firing and the plan already expects it. Remove S1; do not tune it.
- A branch-ordering function shipped in the walkthrough does **not** reproduce the benefit `21` §12.8
  attributes to `constraint.negotiator`, which would be evidence the negotiator was doing something
  the deterministic version cannot.
- The seeded-defect corpus shows the gates leaving ≥25% of realistic defects undetected. That is a
  specification for **new gates**, which are deterministic and testable without sampling — not an
  argument for restoring S8.
- A local disarm fires for a substantial share of pilot users, which is the strongest available
  evidence that the review UI has failed and the layer should be pulled rather than tuned.
