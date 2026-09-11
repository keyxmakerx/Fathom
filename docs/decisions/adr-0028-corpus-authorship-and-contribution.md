# ADR-0028 — Corpus authorship, contribution split by genre, and first-party rule packs only

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §4.2 (D10), §4.3 (D11), §4.6 (D14); amended by `84` D4
> **Reversal cost:** R5 for accepted contributions; R4 for the voice; R3 for the trust store
> **Supersedes:** `72` §4.6's generalised rejection of community contribution

## Context

Three questions, one subject: who writes the corpus, who may add to it, and who may sign a rule pack.

**The voice (D14).** `73` §4.6 calls this the most likely single point of failure and it is not in
any sibling document as a decision. `design-language.md`'s voice section is the specification for the
`Teaching` depth — *"states the failure mode, not the feature"*, *"names the misdiagnosis it
prevents"*, *"ends sections with a rule of thumb, not a summary"* — and it is achievable by a human
writing YAML and not reliably achievable by a model improvising. `72` §10.3's second-author test —
can a second person write in this voice from the reference set alone — is *"the single cheapest
existential test in the corpus"* and is unimplemented.

**Contribution (D10).** `72` §4.6 computes a 1.3× review multiplier for community contributions and
concludes that community contribution is not the answer. `84` D4 shows the conclusion is
over-generalised: **the multiplier is computed for Tier A *explainer* entries**, where voice is the
product and the review gate is the bottleneck, and it is then applied to the whole corpus.
tldr-pages — thousands of contributors, tens of thousands of short command entries, sustained for a
decade — is the counter-example, and command entries are precisely the mechanical genre it succeeds
at. `61` even notes dictionary entries *"parallelise across authors better than explainers do"*.

This matters more than it sounds, because ADR-0006 unbundled Rosetta from phase 7 on the grounds that
the finder's corpus can be wide while the graph's corpus is narrow — and a wide finder corpus is
exactly the genre that crowdsources.

**Rule packs (D11).** A pack is a *stronger* channel than a corpus entry, because its `remediation`
templates emit lines the tool puts into a change ticket with provenance attached, which makes them
look **more** authoritative, not less. The maintainer-only fields in D10 are exactly the fields a
pack is made of.

## Decision

**One named voice owner with a 50-entry reference set that is the specification. Contribution is open
by genre, not by policy. First-party rule packs only in v1.**

**1. The voice.** One named owner. `15` §12.5's 50-entry reference set **is** the specification — not
a style guide describing it, the entries themselves. Plus one addition: **the second-author test runs
before entry 51 is authored.** A second person writes five entries from the reference set alone; if
the voice does not transmit, the reference set is the thing to fix, and finding that out at entry 51
costs five entries rather than five hundred. A written rule states what may ship without the voice
owner's review: mechanical genres (below) may; explainers may not.

**2. Contribution, split by genre** — this is the amendment to `72` §4.6:

| Genre | Contribution | Why |
|---|---|---|
| **Explainers** | Gap reports, correction reports and `misdiagnosed_as` sentences only. Full entry PRs from a small named practitioner set. **Never open** | Voice is the product; review costs more than authoring |
| **Command entries** | **Open, with review** | Mechanical, high-volume, verifiable against a box, and the genre tldr-pages proves crowdsources |
| **`rosetta` mappings** | **Open, with review** | 30–45 minutes each, no schema, no dictionary, no rule, no parser, no emitter. This is Priya's actual problem (`84` §6.1) |
| **Statement dictionary entries** | **Open, with review** | `61`'s own note: they parallelise better than explainers. 1,750 entries is not a solo job |
| **Rules and remediation templates** | **Never open.** First-party only | A remediation line is pasted into a production firewall |

Every contributed entry still carries `reviewed_by` naming the **project's** reviewer, not the
contributor, and ADR-0027's hardware gate applies unchanged. Contribution changes who *drafts*; it
does not change who is responsible.

**3. Rule packs: first-party only in v1**; a pinned-publisher trust store when a second organisation
actually asks. The trust store lives in the workspace (`32` §6.3, `Settings`), which makes changing
it R3, so the envelope must be frozen with a publisher field even while only one publisher exists.
Per `74`, a `community` tier may exist, unsigned, off by default, and never included in a release
artifact.

**4. Model-drafted content is labelled** (`83` §8, invariant 10). ADR-0022 ships S5 and S2-B as
build-time drafting tools. `63` gains a `drafted_by` field alongside `reviewed_by`, required whenever
`drafts/` was the origin. Invariant 10 governs what text ships; it does not currently govern what
gets *written*, and the drafting origin is a fact a reviewer should have.

**5. The authoring queue is ranked by deterministic demand** (`85` §5.3). The finder's miss log,
`Unprovable` counts and the coverage join order the queue; AI-derived signals (`cache/corpus/`
recurrence, `report_gap` clusters) may only **break ties**, and the ordering signal is recorded per
ticket. Otherwise a model-shaped recurrence signal decides which explainers a human writes next,
which is a leak from the non-deterministic side into the corpus's *priorities* — the thing the whole
architecture protects.

## Consequences

### Positive

- The wide-finder-corpus programme becomes affordable. Four platforms of IPsec command corpus at
  ~eight person-weeks is the difference between serving Priya and shipping her a stub.
- The second-author test converts the corpus's largest existential risk from an assumption into a
  cheap experiment with a date.
- The bus factor on the voice is measured rather than hoped about, and if the voice does not transmit
  the project learns it while the fix is small.
- The distinction between drafting and responsibility is stated, so an open genre does not dilute
  invariant 10.
- `drafted_by` closes the gap where a model-drafted entry is indistinguishable from a hand-authored
  one after review.

### Negative

- **Open genres import a review burden onto the one person who cannot spare it.** `72` §4.6's 1.3×
  multiplier was computed for explainers and it is not 1.0 for command entries either. Every
  contributed entry is read, checked against a box (ADR-0027) and attributed — and under ADR-0003
  there is no second reviewer.
- **A contributed command entry is a safety artifact.** A wrong `risk` label or a wrong `read_field`
  in a `Disruptive` entry is exactly the defect ADR-0011 exists to prevent, arriving from someone
  the project has no relationship with. Review is the only control and review is the bottleneck.
- **Splitting contribution by genre is a policy contributors will find arbitrary.** "You take my
  command entries but not my explainers" reads as gatekeeping, and the honest reason — your prose is
  not in the voice and the voice is the product — is not a thing most people enjoy hearing.
- **First-party-only packs foreclose the ecosystem that would make the rule engine valuable.** One
  engine, `platforms` predicates, signed data packs — that architecture exists to let other people
  write rules, and v1 does not let them. The trust store's R3 rating means the envelope must be
  designed for publishers who are not permitted yet, which is work with no user.
- **A named voice owner is a single point of failure by design**, rated R4 because losing them means
  re-authoring rather than re-hiring. The reference set mitigates it and does not remove it.
- **Ranking the authoring queue deterministically may rank badly.** The miss log is a lagging
  indicator and the coverage join finds absence, not hollowness — which is exactly what `85` §11.1
  says only S9 can find. Restricting AI signals to tie-breaks is the safe choice and it discards a
  real signal.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Closed corpus, all genres (`73` D10 as written)** | One voice, one reviewer, no dilution, and the review cost stays where it is. `72` §4.6's multiplier is real | It applies explainer economics to genres with different economics, and it puts the wide finder corpus — the product's actual wedge — behind a solo author. tldr-pages is the counter-example and it is not a small one |
| **Fully open, all genres** | Maximum coverage, and coverage is the constraint | The voice is the product for explainers and a remediation template is pasted into a firewall. Both failures are unrecoverable and neither is caught by volume |
| **Open with automated review only** | Scales without the bottleneck | `12` §15.3's fourteen gates per rule check structure, not truth. A syntactically perfect entry with a wrong `read_field` passes every gate |
| **Third-party packs from day one with a pinned-publisher store** | The architecture is built for it, and it is the only route to N platforms without N authors | No second organisation has asked. Freezing a trust root before there is a publisher means designing for an imagined one, and the store is R3 once workspaces exist |
| **Let the AI-derived signals rank the authoring queue** | They are the freshest demand signal available and `21` §14 calls gap reporting the AI layer's largest long-run value | `22` §11.7 already rates *"gap-driven over-authoring — the corpus grows to satisfy a report rather than a reader"* as **Real**, mitigated only by editorial judgement. Tie-breaks keep the signal and bound the failure |

## Revisit if

- The second-author test fails. That is the highest-value negative result available: the voice does
  not transmit, the reference set is the artifact to fix, and if it cannot be fixed the teaching
  pillar rests on one person permanently and the scope must shrink to match.
- Command-entry contribution arrives at a rate the reviewer cannot sustain — the answer is a named
  practitioner set with commit rights and hardware, not closing the genre.
- A second organisation asks to publish a rule pack. That is D11's stated trigger and it should be
  answered with a pinned-publisher store, not with an open one.
- A contributed entry causes a real incident. That reopens the genre split with evidence rather than
  with economics, and the answer may be that command entries need the same review as explainers.
