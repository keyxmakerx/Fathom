# ADR-0030 — PAN-OS is the second platform, with a read-only ingest spike pulled into phase 2

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §8.1 (D23); `73` §13 disagreement 4; `71` §10.2, §11.3
> **Reversal cost:** R4 if the schema breaks; R2 if it merely bends
> **Supersedes:** `71`'s sequencing of the second platform behind phase 7

## Context

Brief §5.1: *"This schema is the entire bet of the project."* Phase 7 is where the bet is settled,
and `71` §1.4 rates R-SCHEMA *"fatal, and the most expensive to discover late"* — then retires it at
week 106–158.

`84` §8's second observation is the objection: **the first architectural bet is settled last.** The
justification (order by risk ÷ cost-to-test) is sound in principle, but `72` §3.6 puts *"roughly even
odds that it breaks on the second platform"* — a coin flip, resolved in year three, whose bad outcome
costs 60–70% of phase 1 repeated. A project that cannot survive that outcome should not be sequencing
it last.

Between the candidates, the deciding question is not demand but **information per week**:

| Candidate | Information about the schema | Note |
|---|---|---|
| **PAN-OS** | **Highest.** A genuinely different object model — security policies as ordered rulebases, address and service objects as first-class, zones without Junos's logical-unit indirection, and PFS expressed as `dh-group` on the IPsec crypto profile rather than as a separate statement | `13` §8.3(c) already emits it and `82` §16 finds the one real defect: the graph has two DH values and PAN-OS has two objects to carry them, and the emitter does not say which lands where |
| **IOS-XE** | Moderate. Closer to Junos in shape than PAN-OS is; confirms less | |
| **FortiOS** | **Lowest, and highest demand.** `71` §10.2's own words: *"highest demand, lowest architectural information"* | Deliberately chosen last |

`73` §13 disagreement 4 proposes the sequencing fix: pull a **read-only ingest spike** into phase 2 —
2–3 solo weeks against a 12–18 week phase — on the grounds that **the schema breaks on ingest before
it breaks on emit**. Parsing a real PAN-OS configuration and attempting to land it in the IR surfaces
missing kinds, missing edges and impossible cardinalities without building an emitter, a corpus or a
walkthrough for it.

## Decision

**PAN-OS is the second platform. A read-only ingest spike is pulled forward into phase 2. The full
second-platform corpus stays where `71` puts it.**

1. **PAN-OS, on information grounds**, and the choice is recorded as an engineering decision. If
   ADR-0003 is ever reversed toward a business, this inverts on commercial grounds — and `73` §8.1 is
   right that the inversion must then be **written down as a commercial choice**, knowingly, rather
   than argued as an engineering one.
2. **The spike is phase 2, 2–3 solo weeks, read-only.** Parse two or three real PAN-OS
   configurations into the IR. No emitter, no rules, no explainers, no walkthrough. Its single
   deliverable is a list: **which node kinds, edge kinds and fields the IR lacks.** That list is the
   R-SCHEMA measurement, eighteen months earlier than `71` schedules it.
3. **Its exit criterion is stated in advance**, per `73` §1.3's rule that evidence written before the
   fact counts: **zero new node kinds** means the schema generalises and phase 7 is a corpus problem;
   **one to three** means it bends and the cost is bounded; **more than three, or any new edge
   *shape*** means it breaks, and the response is `72` §3.5's narrowing — restate the bet as *"neutral
   enough that `explain`, `lint` and `render` work across platforms even where `emit` does not"* —
   rather than the redesign.
4. **`11` §12.2's concession is carried into the public positioning**: cross-vendor emit of a
   security policy is not a supported operation and probably never will be. `72` §3.2.3 already
   restates the bet correctly and `02` §14.2 does not.
5. **Rosetta command mappings are not gated on this** (ADR-0006). A `rosetta:` entry needs no schema,
   parser or emitter, and the finder's cross-vendor coverage runs on its own track.
6. **`13` §8.3(c)'s PAN-OS example gains its provenance annotation.** As written, a reader cannot
   tell whether `dh-group group14` on line 11 came from `IkeProposal.dh_group` or from
   `IpsecPolicy.perfect_forward_secrecy`, in a document whose entire premise is that every line knows
   what produced it.

## Consequences

### Positive

- The project's central bet is measured in month six instead of year three, for 2–3 weeks of work,
  and the bad outcome becomes a scope decision rather than a rewrite.
- The measurement is taken where the schema actually breaks. An emitter can be written around a
  missing kind; a parser cannot land a structure that has nowhere to go.
- `71` §11.3's contingency reorder already exists; this makes its trigger measurable rather than
  inferred.
- PAN-OS's object model is different enough that a pass is real evidence, not a coincidence — which
  IOS-XE's proximity to Junos would not have provided.
- Rosetta's decoupling means the cross-vendor half of brief §2.1 — Priya's actual problem — is served
  regardless of what the spike finds.

### Negative

- **A read-only spike answers the ingest question and not the emit question.** A schema can accept a
  PAN-OS configuration and still be unable to produce a committable one, and `82` §15 shows exactly
  that failure already exists for Junos clusters, where the IR parses what it cannot emit. The spike
  will produce a green light that is narrower than it reads.
- **2–3 weeks inside a 12–18 week phase is a 15–25% tax on a phase that is already on the critical
  path**, taken for information rather than for a shipped capability. Under ADR-0006's re-cut, phase
  2 is part of the product; this delays it.
- **Choosing on information rather than demand chooses against the user.** `84` §6.1's persona runs
  Junos, FortiGate and PAN-OS in the same week, and FortiOS is deliberately last precisely because it
  would tell us least — which is the right engineering call and the wrong customer answer, and there
  is no third option that is both.
- **There is no PAN-OS hardware** (`61` §20, ADR-0027). The spike can parse a configuration file
  without a box; the corpus cannot be verified without one, so the second platform inherits an
  unsolved dependency that this ADR does not solve.
- **A "more than three new kinds" outcome is a decision nobody wants to take.** The specified
  response — narrow the claim — means retreating from *"one graph, six views"* to *"one graph, four
  views, and emit is per-platform"*, which is a materially smaller product than the brief describes.
  Writing the trigger down in advance is the only thing that makes it likely to be honoured.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **FortiOS second** | Highest demand by a distance, and `84` §6.1's persona needs it. It is the answer if the goal is adoption | `71` §10.2: *"highest demand, lowest architectural information."* Picking the platform that confirms least, to settle the bet the project calls fatal, is the wrong instrument. Reconsider immediately if ADR-0003 is reversed |
| **IOS-XE second** | Enormous installed base, and the CLI shape is familiar to the largest number of engineers | Structurally closer to Junos than PAN-OS is, so a pass tells us less. Moderate demand and moderate information is the worst combination for a decision whose purpose is information |
| **Full second platform in phase 7 as `71` sequences it** | The measurement is complete rather than partial, and it does not tax phase 2 | It resolves a coin flip in year three whose bad outcome costs most of phase 1 again, in a project that `84` §8 argues cannot survive that outcome |
| **A full PAN-OS vertical (parse + emit + rules) in phase 2** | Answers the emit question too, and produces a shippable capability | 6–8 person-weeks for the PAN-OS IPsec corpus alone (`71` §10.6), plus the emitter. It is a phase, not a spike, and it would consume the phase it is inside |
| **Two spikes: PAN-OS and IOS-XE** | Two data points beat one, and the second is cheap once the harness exists | Doubles the tax for a confirmatory result. If PAN-OS passes, IOS-XE almost certainly passes; if PAN-OS fails, the narrowing decision does not need a second opinion |

## Revisit if

- The spike returns **zero new node kinds** — the schema bet pays, `84` C5 fires, the six-view thesis
  is stronger than the critiques allow, and the full second platform can be scheduled with
  confidence.
- The spike returns **more than three new kinds or any new edge shape** — narrow the claim now, per
  `72` §3.5, rather than in year three. This is the trigger and it is written before the evidence
  deliberately.
- ADR-0003 is reversed toward a business, at which point the platform choice inverts on commercial
  grounds and must be recorded as such.
- A PAN-OS box becomes available, which changes the second platform from a parse-only exercise into
  something ADR-0027's verification gate can actually pass.
