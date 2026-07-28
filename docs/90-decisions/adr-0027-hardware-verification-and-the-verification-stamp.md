# ADR-0027 — Two physical boxes, and the verification stamp is required UI chrome

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §4.1 (D09); extended by `84` §5.4 and D7
> **Reversal cost:** R2 to fix; **R5 in reputation** if unverified content ships as reference
> **Supersedes:** —

## Context

`71` §3.1 records the current state without softening: 84 seed command entries exist and **none of
them has been run on a box.** `61` §20 concedes that hardware for platforms two, three and four
*"is not currently satisfied by anyone named in this project"*. Every entry carries `reviewed_by`
as a placeholder, so the corpus breaches invariant 10 today and says so in a YAML comment (`83` P12).

`84` §5 asks the hardest question in the corpus — is the teaching pillar defensible against a general
model — and finds one answer that holds:

> **The defensible claim is not "our explanations are better". It is: a named human ran this command
> on a real box on a stated date, and the entry says so, and it says when it is no longer sure.**

That is a claim about *verification*, and no model can make it — not because models are inaccurate,
but because the claim is about a person and a box and a date, which is a fact about the world rather
than a property of an answer. `84` §11.1 is right that it is cheap to make, expensive to fake, and it
gets **more** valuable as generated answers get more fluent, not less.

Two things must be true for it to matter, and only one is specified:

| # | Must be true | Status |
|---|---|---|
| 1 | Every entry has been run on real hardware, as a gate | Specified (`71` X0.10, `61` §20). **Not satisfied today** |
| 2 | `verified_against` and `Staleness` are **shown on every result**, not merely stored | Specified as a *field* (`15` §13.2). **Nowhere specified as required chrome** |

`84` D7 states the consequence plainly: **the product's only unforgeable differentiator currently
lives in a YAML field.**

## Decision

**The conformance lab exists — two physical boxes with a path between them, run by the domain author
— and the verification stamp is required UI chrome on every surface that renders corpus content.**

1. **Two physical boxes, not a simulator.** The reasoning is the field card's own structure: every
   failure mode on all four sides is about two ends disagreeing, and a single box or an emulator
   cannot produce `NO_PROPOSAL_CHOSEN`, a PFS mismatch that installs and fails at the first child
   rekey, or an `INVALID_KE_PAYLOAD` retry. The lab is where `82`'s open `VERIFY` markers get closed:
   commit-time SA behaviour, whether DPD runs implicitly on an IKEv2 gateway, whether
   `show security ipsec security-associations` has a `State` column in summary output, and whether
   `| match -i` is accepted.

2. **No entry is published as reference material until it has been run.** An entry that has not been
   run ships with `verified_against: null` and renders as **unverified** in the UI, in the margin-tab
   register, on every result. It is not withheld — withholding is worse — it is labelled.

3. **The stamp is chrome, not metadata.** Every finder row, every explainer header and every emitted
   line's explainer carries, in muted mono at the margin-tab weight:

   ```
   junos-srx 21.4R3 · verified 2026-05-12 · K. Okafor
   ```

   This is added to `16` §17.1's result-row specification and `52` §3.2's surfaces, and it is exempt
   from ADR-0025's three-tabs-per-region budget because it is not a tab — it is the row's own
   provenance line, which is the card's device for per-row facts.

4. **`Staleness` is derived and shown**, per `15` §13.2: an entry verified against a train two majors
   behind the workspace's platform version says so, at the point of use, not in a report.

5. **`71` tracks the placeholder `reviewed_by` as a release blocker**, not only as a YAML comment.
   `35` §9.3's gate already fails on the literal placeholder string; the roadmap must show it.

## Consequences

### Positive

- The one differentiator no competitor can copy becomes visible at the moment of use rather than
  discoverable in a file. `84` §5.4 is right that if the verification is stored and not displayed,
  Fathom is *"a slower model with narrower coverage and a better tone"*.
- The corpus stops breaching invariant 10 silently and starts breaching it visibly, per entry, which
  is the only honest interim state.
- `82`'s eight unresolved vendor-behaviour questions get an owner and a mechanism. Several of them
  currently decide whether an engineer schedules a change window.
- A labelled-unverified entry is more useful than a withheld one and more honest than a confident
  one, which is the same trade `acceptable_when` makes for rules.

### Negative

- **The lab is real money and real time in a project with neither.** Two SRX-class boxes, power, a
  path between them, and the hours to run 91 entries at 30–50 hours of lab time for the seed corpus
  alone (`72` §4.2). Under ADR-0003 there is no budget line; this comes out of the same pocket as
  everything else.
- **It gates the corpus, which is the schedule.** Every entry now needs bench time before it is fully
  publishable, so authoring throughput is bounded by lab access rather than by writing speed. `72`
  §4.4's three-to-four platform-domain-units-by-year-three estimate gets worse, not better.
- **Platforms two through four have no hardware and no plan for it.** `61` §20 says so. Under
  ADR-0030 PAN-OS is next, and a PAN-OS corpus with no PAN-OS box either ships unverified — which
  undermines the entire claim by precedent — or does not ship.
- **The stamp costs a line of chrome on every result row**, on surfaces ADR-0025 has just spent six
  changes making denser. Three facts in muted mono under every finder result is real vertical space
  in the product's most-used view.
- **A visible stamp invites the question "what about the ones without it"**, and for a while the
  answer is "most of them". Making the gap visible is correct and it makes the product look thinner
  than a competitor that shows nothing.
- **Verification decays.** A date and a train are true when written and drift immediately; the
  `Staleness` derivation means entries start reading as stale on their own, which is honest and
  demoralising.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Emulated or simulated boxes (vSRX, containerlab)** | Cheap, scriptable, always available, and CI could run the verification on every commit — which is strictly better for regression | It cannot produce the failures the corpus exists to teach. Two-ended negotiation failures, timing behaviour at rekey, and vendor output formats are exactly where an emulator diverges, and those are the corpus's content. Useful as a regression harness; not sufficient as the verification claim |
| **Verify against vendor documentation only** | Free, fast, and vendor docs are the authority for syntax | `82` §9 is the refutation: the corpus already asserts commit-time SA behaviour that no cited source supports, invented by an author who could not verify it and wrote it as fact. Documentation is the authority for syntax and not for what the box does |
| **Ship unverified and mark nothing** | Fastest path to coverage, and most of it is right | *"90% right is indistinguishable from right until it costs somebody an outage"* (`72` §4.9). It also forfeits the only claim that survives a general model |
| **Store the verification but do not display it** (status quo) | No chrome cost, and the data is there for anyone who looks | Nobody looks. The differentiator is only a differentiator at the moment of use, and `15` §13.2's field has no surface requiring it |
| **Community-run verification** | Solves the hardware problem — practitioners have boxes | A verification claim is only as good as the identity behind it, and ADR-0028 already limits contribution for exactly this reason. Worth revisiting for a small named practitioner set with real hardware |

## Revisit if

- A named practitioner set with real hardware forms and can attest entries under their own names —
  that changes the lab from a bottleneck into a network, and it is the only route that scales past
  one platform.
- The stamp is measured to cost more scanning time than it buys trust, in which case it collapses to
  a single `verified` / `unverified` mark with the detail on hover — noting that ADR-0025 forbids
  hover-only content, so it would have to collapse to the inspector instead.
- ADR-0030's PAN-OS phase arrives with no hardware. That is the trigger to either fund it, find a
  practitioner with a box, or ship PAN-OS labelled unverified and accept the precedent knowingly —
  and the third option should require an explicit decision, not a default.
