# 71 — Roadmap: what to build, in what order, and why

> **Status:** Proposed — **superseded as a plan** (see the banner below); retained as an effort model

> **This document's phase scheme no longer decides what ships.** ADR-0031 (Proposed) retires phases
> as a scoping device after the owner's *"All features must be included in V1"* (`70` §4). The live
> build order is `76` §7.2's S-slices as refined by `docs/70-ops/79-work-orders/00-INDEX.md`, under
> `78`. Two parts of this document are **not** superseded and remain in force: §13.1's thirteen
> permanent product boundaries (*"a permanent decision, not a phase-N limitation"*), and §13.2's
> reproducible-build row, which `71` itself calls *"the one deferral here with a hard deadline"*.
> Deliberately not repaired sentence by sentence: the unit of organisation is the thing that
> changed, and ADR-0006's six ordered edits are to a plan being replaced (`88` §5.10, ADR-0031 §5).

Companion documents: `docs/10-core/16-command-finder.md` (phase 0's machine),
`docs/60-content/61-command-corpus-spec.md` and `docs/10-core/15-explainer-corpus.md`
(phase 0's content and the only credible authoring-rate estimates in the corpus),
`docs/10-core/11-ir-schema.md` (the bet phase 1 places and phase 7 settles),
`docs/10-core/13-emitters-and-provenance.md` §8 (the vendor-divergence evidence behind
phase 7's platform choice), `docs/20-ai/21-ai-layer-architecture.md` §7 (the tiers phase 6
walks), `docs/40-stack/43-deployment-modes.md` (what each phase's artifact actually is),
`docs/40-stack/44-performance-budgets.md` (every numeric exit criterion below is one of B1–B19),
`docs/40-stack/45-testing-strategy.md` (what "proved" means in each exit criterion).

This document sequences the work. It does not re-specify anything. Where a phase names a
mechanism, the mechanism is specified elsewhere and cited; where a phase names a number, the
number comes from a budget or a stated assumption and is labelled as one.

---

## 0. Contents

| § | |
|---|---|
| 1 | How to read this, and what a phase is |
| 2 | The whole plan on one page |
| 3 | Phase 0 — the wedge |
| 4 | Phase 1 — the graph, one platform, one task |
| 5 | Phase 2 — paste and inventory |
| 6 | Phase 3 — findings, diff, verify, rollback |
| 7 | Phase 4 — the diagram |
| 8 | Phase 5 — encryption, workspaces, sync |
| 9 | Phase 6 — the AI layer, tier by tier |
| 10 | Phase 7 — the second platform, and the mid-life crisis |
| 11 | The dependency graph |
| 12 | Kill points |
| 13 | Deferred, and never built |
| 14 | Estimate methodology, and what would move every number |
| 15 | Staffing, the critical path, and the corpus track |
| 16 | Open decisions |
| 17 | Sources consulted |
| 18 | Disagreements |

---

## 1. How to read this, and what a phase is

*margin tab: read this first*

> **A PHASE ENDS WHEN A RISK IS RETIRED, NOT WHEN A FEATURE IS DONE**

### 1.1 The unit of sequencing

Feature roadmaps sequence by what is visible. That produces an order where the impressive
things come first and the load-bearing things are discovered late, which is the failure mode
brief §11.2 gestures at: several well-funded teams have built *pieces* of this.

This roadmap sequences by **architectural risk retired per unit of effort**. Each phase names:

| Field | Means |
|---|---|
| **Deliverable** | What exists in the repository at the end. Crates, corpus, artifact. |
| **User-visible outcome** | What a network engineer can do that they could not do before. |
| **Exit criteria** | Falsifiable, mechanically checkable where possible. A phase is not "done" by consensus. |
| **Risk retired** | An `R-` identifier from the register in §1.4. This is the actual product of the phase. |
| **Risk explicitly *not* retired** | Named, so nobody mistakes a green phase for a proven architecture. |
| **Effort** | A range, for one person and for a three-person team, with the decomposition that produced it. |

Note the third column of the risk register carefully. Phase 0 retires nothing about the
schema. Phase 4 retires nothing about the crypto. A phase that passes every exit criterion
and retires no risk is the roadmap equivalent of side 1's warning: *"the tunnel reads UP while
passing zero packets."*

### 1.2 The five ordering principles

| # | Principle | Consequence in this plan |
|---|---|---|
| **O1** | **Zero-trust features first.** A feature that requires the user to give you something (data, a passphrase, a key, a network path) is adopted later than one that requires nothing. | Phase 0 requires nothing. Phase 5 requires a passphrase and a server, and it is fifth. |
| **O2** | **Retire the cheapest expensive risk first.** Order by (risk severity ÷ cost to test), not by risk severity. | The schema bet (brief §11.1) is the most severe risk in the project, and phase 7 is where it is settled — because settling it earlier costs a second platform's entire content programme. |
| **O3** | **Build the shape before the substance.** Where a subsystem is expensive to retrofit but cheap to stub, land the shape early with a narrow implementation. | The envelope framing lands in phase 1 with one AEAD and a hardcoded KDF; key hierarchy, rotation and sharing land in phase 5 (§8.2). The AI boundary lands in phase 6a before any model exists (§9.2). |
| **O4** | **Never ship a capability without its brake.** | Emitters ship with provenance (invariant 6) or not at all. Rules ship with `acceptable_when` (invariant 8) or not at all. `constraint.negotiator` never ships without `adversary.redteam` (§9.4). |
| **O5** | **The corpus is a parallel track with its own calendar, not a task inside a phase.** | §15.3. It is the largest line item in the project and the only one that cannot be accelerated by better engineering. |

### 1.3 What the estimates mean

Full methodology in §14. In brief:

- A **person-week** is five days of focused work by someone who has read the specification
  and is not also doing support, hiring or sales.
- **One person** means calendar weeks for a solo builder, serial.
- **Small team** means three people: **E1** core Rust, **E2** UI + build + boundary,
  **D1** domain author at 0.6 FTE (a network engineer writing corpus, reviewing entries, and
  running the conformance lab). Team estimates are not solo ÷ 3 — see §14.3.
- Ranges are **P50 to P80**, not best-case to worst-case. There is no line below that assumes
  nothing goes wrong.

### 1.4 The risk register this roadmap exists to burn down

| ID | Risk | Severity if unretired | Retired in |
|---|---|---|---|
| **R-CORPUS** | Nobody can author this content at this voice at a sustainable rate. The corpus is the product; if the median entry costs 60 minutes rather than 35, v1 slips from 6–7 person-weeks to ~11 (`15` §12.6) and every later phase's content estimate doubles with it. | Fatal, slow | Phase 0 (measured), then continuously |
| **R-VOCAB** | Concept-mediated ranking does not actually close the vocabulary gap; users still cannot find the command. This is brief §2.1, which is the reason the product exists. | Fatal | Phase 0 |
| **R-DETERM** | Byte-identical output across WASM and native cannot be held in practice (invariant 9). | High — it is the claim that makes results shareable and diffs reviewable | Phase 0 for the finder; phase 1 for emit; phase 3 for diff |
| **R-SIZE** | The single-file artifact cannot be built, or is too large to be a plausible download. | High | Phase 0 |
| **R-SCHEMA** | The IR is a Junos model with a `platform` field. "One graph, six views" is false. | **Fatal, and the most expensive to discover late** | Phase 7 |
| **R-PROVENANCE** | `(line, provenance)` pairs are not maintainable at emitter scale and the emitters drift into string builders. | High — it is the mechanism that makes teaching structural rather than additive | Phase 1 |
| **R-RULES-DATA** | Rules-as-data is not expressive enough and platform logic leaks into engine code. | High | Phase 1, re-tested in phase 7 |
| **R-ONRAMP** | Paste does not work well enough to avoid the empty form, and the tool inherits the documentation-rot failure of brief §2.2. | High | Phase 2 |
| **R-RESIDUE** | Real configurations from estates we did not write are too messy to bind, and the residue rate makes the graph untrustworthy. | High | Phase 2 |
| **R-LEGIBLE** | The output does not survive contact with a change-management process, so it never gets used on a production box. | Medium, adoption-fatal | Phase 3 |
| **R-VIEW** | The diagram stops being a view and starts being state, which is brief §4.1's forbidden outcome. | Medium, architecture-corrupting | Phase 4 |
| **R-ZK** | Zero-knowledge does not survive an adversarial review. The headline claim fails. | Fatal to the enterprise story | Phase 5 |
| **R-CRDT** | A hand-rolled op-based CRDT over a typed graph (1,500–2,500 lines, `41` §9.2) does not converge, or converges to something a network engineer would call wrong. | High | Phase 5 |
| **R-AI-BOUND** | The supervisor cannot be reconciled with invariant 9 and the offline single file — the owner's explicit new requirement collides with the security posture. | High | Phase 6a |
| **R-AI-VALUE** | The subagents do not earn their place; they re-implement rules with worse citations. | Medium — mitigated by admission criteria A1–A5, but only measurement settles it | Phase 6b–6c |

---

## 2. The whole plan on one page

*margin tab: the whole document in one table*

| Phase | Name | Artifact | Retires | One person | Team of 3 |
|---|---|---|---|---|---|
| **0** | The wedge | `fathom-<ver>.html` (D1) + `fathom find` (D4) | R-VOCAB, R-DETERM(find), R-SIZE, R-CORPUS(first measurement) | 12–18 wk | 6–9 wk |
| **1** | Graph, one platform, one task | + walkthrough, emitter, rules | R-PROVENANCE, R-RULES-DATA, R-DETERM(emit) | 24–34 wk | 12–17 wk |
| **2** | Paste and inventory | + parser, residue ledger, inventory | R-ONRAMP, R-RESIDUE | 14–20 wk | 7–10 wk |
| **3** | Findings, diff, verify, rollback | + change ticket | R-LEGIBLE, R-DETERM(diff) | 8–12 wk | 4–6 wk |
| **4** | The diagram | + layered diagram view | R-VIEW | 6–10 wk | 3–5 wk |
| **5** | Encryption, workspaces, sync | + D2, D3; multi-user | R-ZK, R-CRDT | 16–24 wk | 8–12 wk |
| **6** | The AI layer | + `fathom-ai`, tiers 0→3 | R-AI-BOUND, R-AI-VALUE | 14–22 wk | 7–11 wk |
| **7** | The second platform | + `panos` | **R-SCHEMA** | 12–18 wk | 6–9 wk |
| | **Total** | | | **106–158 wk** | **53–79 wk** |

**Read the totals before reading anything else.** Solo, this is a two-to-three-year project
and the corpus does not finish at the end of it. With three people it is fourteen to twenty
months to phase 7, and the corpus still does not finish. Any plan that reports a smaller
number has either cut the corpus, cut the second platform, or cut the security posture, and
each of those is a different product.

The one honest shortening available is **stopping**. Phases 0, 0+1, and 0+1+2+3 are each a
coherent product that can be shipped and left alone. §12 says what evidence should make you
take one of those exits.

---

## 3. Phase 0 — the wedge

*margin tab: zero setup, zero trust*

> **THE SHELL IS DAYS. THE RANKING IS MONTHS. DO NOT CONFUSE THEM**

### 3.1 The brief's claim, and the part of it that is true

> *"Build this first. It is a few days of work on top of a corpus that already exists, and it
> is the feature people open ten times a day."* — brief §6.1

The strategic claim is right and this roadmap is built on it. Nobody adopts a network
modelling platform on a Tuesday afternoon; everybody uses a fast command finder immediately.
Phase 0 needs none of the crypto, none of the server, none of the graph, none of the parsers,
none of the rule engine and none of the AI layer. It is the only phase in this document that
can be shipped to a stranger without asking them for anything at all.

The *estimate* is wrong, and `16` already says why:

> *"'A few days of work' is true of the shell and false of the ranking, because the ranking is
> where the vocabulary gap gets closed and the vocabulary gap is the reason the product
> exists."* — `16` §intro

"A few days" holds if all three of the following are true, and each one is exactly the thing
that makes the finder the wedge:

| The days-estimate assumes | Reality |
|---|---|
| The corpus already exists | 98 seed entries exist in `corpus/commands/junos-srx-ipsec.yaml` (91 from the card, plus the seven R09 chassis-cluster entries), authored from the field card, **none of them run on a box**, all carrying `reviewed_by: <named human>` which the build is required to reject. The corpus does not exist; a proof that the format works exists. |
| Substring search is good enough | For the brief's own flagship query, `check if a tunnel is up`, token overlap with the correct entry's `answers` field (`Is Phase 2 installed and passing traffic?`) is **zero** (`16` §2). Substring search returns nothing. |
| The artifact does not have to be verifiable | "Zero trust required" is only true if the thing is offline, deterministic and hash-checkable by a stranger, which is the whole of `35` and a large part of `43` §3. |

So the honest framing: **phase 0 is a small amount of code over a large amount of authored
structure, plus a build that a stranger can verify.** That is three to four months solo.

### 3.2 RECOMMENDATION — spend two weeks proving the content before building the machine

Before phase 0, build a throwaway: one static HTML page, the 98 seed entries inline, dumb
substring matching over `cmd` + `answers` + `aka`, no index, no WASM, no build system, no
tests. Two weeks including cleanup.

It answers the only question that can kill the project at zero cost: **is the content the
value?** Put it in front of eight engineers for two weeks and watch whether they keep the tab
open. If the content is not the value, no amount of BM25F rescues it, and you have learned
that for the price of a fortnight rather than a quarter.

It is a throwaway. Name it `spike/`, put a banner on it, delete it at the end of phase 0. A
spike that survives becomes the architecture, and this one must not.

### 3.3 What is genuinely in phase 0

**Crates.**

| Crate | Scope at phase 0 | Approx. lines |
|---|---|---|
| `fathom-id` | ULID, `CommandId`, `ConceptId`, Crockford base32. Node IDs defined but unused. | 150 |
| `fathom-corpus` | YAML loader for command entries, concepts, explainers and static ladders; validation gates; the `finder.idx` builder; the `fathom-corpus` authoring CLI (`new`, `split`, `build`, `lint`). | 1,400–2,000 |
| `fathom-find` | Normaliser, FST command trie, postings, BM25F, the three matchers, fusion, cutoff, ordering. `16` in full. | 2,000–2,800 |
| `fathom-core` | The façade, at phase-0 scope: `open_corpus`, `query`, `explain`. | 250 |
| `fathom-wasm` | The ABI (`41` §3.7). The only `unsafe` in the workspace. | 300 |
| `fathom-cli` | `fathom find`, `fathom explain`, `fathom golden`. | 400 |
| `xtask` | `gen-types`, `ui-build`, `assemble` (D1 single file, CSP hashes over final bytes), `check-deps`. | 600 |
| `ui/` | Boundary (`wasm.ts`, `corpus.ts`, `tt.ts`), render layer + keyed reconciler, virtualised list, the `Ctrl+K` overlay, the result row, the explainer panel at three depths, the design tokens. | 2,000–2,600 TS + CSS |

**Corpus (the D1 track, §15.3).**

| Content | Count | Source |
|---|---|---|
| Command entries, `junos-srx`, IPsec domain | 98 seed → ~120 after expert review and gap-filling | The four-side field card, then verified on a box |
| Concepts, IPsec + general diagnostic | ~120 | `16` §3.6: harvested from `aka:` lists, vendor doc section titles, and the miss log. Not invented at a desk. |
| Explainers, classes `command` + `output` + `error` | ~83 | `15` §12.5 phase P1 — *"the corpus that makes the wedge shippable"* |
| Explainer reference set (the voice spec) | 50 | `15` §12.5 P0. **Nothing else starts until this exists.** |
| Static ladders | 3 | The card's `BRING-UP ORDER` (side 1), `THE VERIFY LADDER` (side 3), and the MTU binary search (side 4) |
| Error decoder entries | 8 | Side 3's `ERROR DECODER` table, one entry per log string |
| Golden query set | ~120 queries | `16` §9.6 |

**The artifact.** Two of them, and the second is not optional:

1. `fathom-<ver>.html` — D1, one file, `connect-src 'none'`, inline script pinned by its own
   SHA-256, index embedded base64. Target ≤ 2.5 MB at phase 0 (B17's 4.5 MB hard fail is for
   the full product; a finder-only artifact that approaches it has a problem).
2. `fathom-<ver>-<triple>` — D4, the CLI, one static binary.

**DECISION — the CLI ships in phase 0, not later.** It costs about a week and it is the only
way to discharge R-DETERM. Invariant 9 says the same corpus produces identical finder ranking
on every build; you cannot test "identical across targets" with one target. `fathom golden`
runs the 120-query set natively in under a second, and CI asserts the WASM build produces the
same 120 ranked lists. Without the CLI that assertion has no second party, and the first time
anyone notices a divergence is when two engineers paste different top hits into the same
ticket.

### 3.4 What is deliberately not in phase 0

This is the scope boundary. Each row is a thing a reasonable person will ask for during
phase 0 and each answer is "no, and here is where it lands".

| Not in phase 0 | Why | Lands in |
|---|---|---|
| **Context awareness** (brief §6.1: `...vpn-name VPN-DC-EAST detail`) | It interpolates values from an open workspace. A workspace is a graph inside an encrypted container. That is phases 1 and 5. `16` §16.6 already requires context to be an upgrade and never a precondition, so the finder is built with the slot machinery present and unbound. | 1 (bound), 5 (synced) |
| **Rosetta beyond one target pair** | The `rosetta:` field is authored per entry and points at platforms whose corpus does not exist yet. Ship the field, ship the *link*, ship a stub target page that says "PAN-OS corpus not written". Do not ship a mapping to content that is not there. | 7 |
| **Generated ladders** — `verify(diff(graph))` | Requires a graph and a diff. Phase 0 renders **authored** ladders from the corpus, which is what the card's `BRING-UP ORDER` is. | 3 |
| **The reverse query at line granularity** | Paste a whole config and get an annotated walkthrough needs the parser. Phase 0's reverse query is *paste one command, get its entry*, which is the explainer corpus read backwards and is genuinely nearly free. | 2 |
| **Any rule, any finding** | `next_if_bad: [ipsec.inactive-tunnels]` in the brief's seed entry points at a **command**, not a rule, and that is the phase-0 semantics. Rules need the graph. | 1 |
| **Suppression, workspace, settings persistence** | No workspace exists. Phase-0 settings (depth toggle, platform filter) live in memory and reset on reload. **Not in `localStorage`** — D1 stores nothing in browser storage (`43` §2.1). | 5 |
| **Any AI** | Tier 0 is the default and `fathom-ai` is not linked (`21` §7.1). Phase 0 does not even have the under-determination surface's findings row, because there are no findings. | 6 |
| **Full reproducible-build attestation** | See §3.7. Phase 0 ships a locked toolchain, `SOURCE_DATE_EPOCH`, a deterministic index and a published artifact hash. Independent-rebuild attestation by a second machine is phase 0.1, gated before the first public download. | 0.1 |
| **Distance-2 fuzzy matching** | `16` §6.3: available, off by default, because at distance 2 over ~1,200 keys the result set stops being precise. The flag exists so it can be measured. It is not measured in phase 0. | — |

### 3.5 The user-visible outcome

One keystroke, anywhere, from a file on disk with no network:

```
┌─────────────────────────────────────────────────────────────────────────┐
  check if a tunnel is up                                    junos-srx ▾
─────────────────────────────────────────────────────────────────────────
  READ-ONLY — SAFE ON PRODUCTION   CHANGES CONFIG   DISRUPTIVE
─────────────────────────────────────────────────────────────────────────

  ▌ BRING-UP ORDER                                        stop at the first failure

    show security ike security-associations                       READ-ONLY
      P1 up?   Index stable = it did not rebuild.  Role: always
      Responder means your side never initiates.

    show security ipsec security-associations                     READ-ONLY
      P2 installed?   State wants Installed. Anything else is not
      passing traffic.

    show security ipsec inactive-tunnels                          READ-ONLY
      if not, why.  Prints a Tunnel Down Reason, which is often the
      whole answer.

  ▌ Installed proves crypto, not reachability. The tunnel reads UP while
    passing zero packets when st0 has no zone, no policy, or nothing
    routed at it.

    show interfaces st0.0 terse                                   READ-ONLY
    show route 10.2.0.0/16                                        READ-ONLY

    clear security ike security-associations <peer-ip>            DISRUPTIVE
      Tears down every child SA under P1 — on a hub that is every
      spoke at once. Always scope by peer or index.

─────────────────────────────────────────────────────────────────────────
  ↑↓ move   ⏎ copy   ⇧⏎ copy with context   ? why this ranked here
```

Everything on that screen comes from the corpus. The anti-synonym note between the two groups
is `concept:p2.installed`'s `not_the_same_as` entry, which is a verbatim compression of the
card's side 4. The `DISRUPTIVE` row is at the bottom rather than the top because of the risk
prior in `16` §8.3, which is a safety control and not a relevance signal.

### 3.6 Exit criteria

Mechanically checkable unless marked otherwise.

| # | Criterion | Gate |
|---|---|---|
| X0.1 | B2: cold load → `Ctrl+K` armed, P95 ≤ 350 ms on REF-1 | wall-clock, nightly |
| X0.2 | B5: keystroke → re-ranked results painted, P95 ≤ 16.7 ms | work counters every PR, wall-clock nightly |
| X0.3 | Artifact ≤ 2.5 MB; WASM core ≤ 500 KB uncompressed at this scope (B18's 900 KB is the whole product) | size gate, every PR |
| X0.4 | Two builds of the same corpus tree produce **byte-identical** `finder.idx` | CI |
| X0.5 | `fathom golden` native and the WASM build produce **identical ranked lists** for all 120 golden queries | CI |
| X0.6 | Every golden query's expected top-3 is met, or the deviation is signed off by a reviewer with a written reason (`16` §9.6 — a diff here is a review item, never a build failure) | review |
| X0.7 | Zero entries carrying the literal string `<named human>`; every entry has a real `reviewed_by` | corpus lint, build failure |
| X0.8 | CSP of the shipped artifact contains `connect-src 'none'`, asserted against the final bytes, not the template | `xtask assemble` |
| X0.9 | No network request is issued in a 30-minute scripted session. Verified by a proxy that fails the test on any connection attempt | e2e, nightly |
| X0.10 | The 84→~120 entry corpus has been **run on a real SRX** by its reviewer, and `output_fields` labels match the box's actual case and spacing | conformance lab, manual, per release |
| X0.11 | Measured median authoring time per entry, published, and `15` §12.6's table rewritten with real numbers | manual — **this is R-CORPUS's only instrument** |

X0.10 deserves its own sentence. The seed file says it plainly: *"NOTHING IN THIS FILE HAS
BEEN RUN ON A BOX BY ITS AUTHOR."* A finder whose `read_field` says `State — want Installed`
when the box prints something with different spacing is a finder that teaches people to look
for the wrong string. The card's author has an SRX. This gate is why phase 0 needs D1 and not
only engineers.

### 3.7 How you know it worked, and the instrument you do not have

**You cannot measure adoption.** Invariant 1 forbids telemetry, analytics and error
reporting, structurally and permanently. There is no funnel, no DAU, no retention curve, and
there never will be. This is a real cost of the security posture and it should be stated in
the same breath as the benefit.

What you have instead, in descending order of usefulness:

| Instrument | What it tells you | What it cannot tell you |
|---|---|---|
| **A named pilot group** — 8 to 12 engineers, at least 3 outside the project | Whether they open it unprompted in week 3. Ask; do not infer. | Anything about people who tried it once and closed it |
| **The local miss log** (`16` §3.6) | The queries the corpus could not answer, in the user's own words. **Never transmitted**; exported by an explicit menu action into a file the user reads before sending. | How many people had the miss and did not export |
| **Gap-file rate** | Whether people care enough to file. A silent tool with no gap files is either perfect or unused, and it is not perfect. | Which |
| **Corpus contribution** | The strongest signal available: someone outside the project writing an entry. | Nothing about read-only users |

**RECOMMENDATION — write down, before phase 0 starts, what week-3 unprompted usage by the
pilot group would have to look like for phase 1 to be worth starting.** A number chosen after
the fact is not evidence. §12.1 proposes one.

### 3.8 Risk retired, and not

| Retired | How |
|---|---|
| **R-VOCAB** | The golden set is the test. If concept-mediated ranking cannot put the bring-up ladder at the top of `check if a tunnel is up`, the central mechanism does not work and §12.1 applies. |
| **R-DETERM** (finder) | X0.4, X0.5. |
| **R-SIZE** | X0.3, plus the `assemble` path proving a single-file build exists at all. |
| **R-CORPUS** (first measurement) | X0.11. Not retired — *instrumented*. R-CORPUS is retired continuously or never. |

| **Not** retired | Why it matters |
|---|---|
| **R-SCHEMA** | Phase 0 does not touch the graph. Every architectural question the brief calls "the entire bet" is untouched by a green phase 0. |
| **R-PROVENANCE**, **R-RULES-DATA** | No emitters, no rules. |
| **R-ZK** | No crypto ships in phase 0 because nothing is stored. That is not the same as the crypto being proven. |

### 3.9 Effort

**Solo, serial:**

| Work | Weeks |
|---|---|
| `fathom-find` per `16` (three matchers, fusion, index, determinism traps) | 3–4 |
| `fathom-corpus` loader, gates, index builder, authoring CLI | 2–3 |
| `fathom-id`, slab codec, `fathom-core` façade, `fathom-wasm` ABI, `gen-types` | 1.5–2 |
| UI: render layer, keyed reconciler, virtualised list, overlay, result row, explainer panel, tokens | 2.5–3.5 |
| `xtask assemble`, D1 single file, CSP hashing, locked toolchain, deterministic index | 1–1.5 |
| `fathom-cli` + `fathom golden` | 0.5–1 |
| Corpus authoring and expert review (§3.3) — same person, so serial | 3.5–4.5 |
| Golden query set, pilot round, rework from what the pilot says | 1–2 |
| **Total** | **12–18** |

**Team of three:** **6–9 weeks.** Not 4–6. The finder crate is one person's critical path and
does not decompose: E1 writes `fathom-find` and `fathom-corpus` back to back for 5–7 weeks
while E2 builds the UI, the boundary and the build in parallel, and D1 authors the corpus in
parallel. The floor is E1's serial chain plus integration, and integration between a WASM
core and a hand-written render layer is not free. The team saves the corpus track and the UI
track entirely; it saves almost nothing on the core.

**What would blow this estimate**, in order of likelihood: the corpus median lands at 45–60
minutes per entry instead of 25–35 (`15` §12.6 flags this itself); the pure-Rust zstd
question in `41` §10 open decision 1 resolves badly and `TEXT` block compression has to be
rethought; the concept layer needs a second authoring pass because the first set of surfaces
was invented rather than harvested.

---

## 4. Phase 1 — the graph, one platform, one task

*margin tab: the entire bet*

> **ONE TASK, ALL THE WAY THROUGH, OR NOTHING IS PROVEN**

### 4.1 The argument for depth over breadth

The temptation after phase 0 is breadth: three platforms' worth of finder corpus, a bit of
IPsec, a bit of BGP, a bit of interfaces. Resist it, for a reason that is specific to this
architecture rather than general project hygiene.

**"One graph, six views" is a claim about composition, and composition is only testable end to
end.** The claim is:

```
diagram   = render(graph)
config    = emit(graph, vendor)
findings  = lint(graph)
lesson    = explain(node, depth)
runbook   = verify(diff(graph))
inventory = table(graph)
```

Half of `emit` plus half of `lint` plus half of `explain` tests none of the arrows. It tests
three functions in isolation, which was never in doubt. What is in doubt is whether the *same
node* can serve the emitter and the explainer, whether a rule written by a network engineer
can reach the field the emitter reads, and whether provenance survives from a walkthrough
answer through the graph to a rendered line. Those are properties of the composition and they
fail at the joins.

Junos SRX site-to-site IPsec is the correct single task for four reasons, and the fourth is
the one that matters:

1. It exercises every node kind in the illustrative schema of brief §5.1 except
   `RoutingInstance`: `Site`, `Device`, `Interface`, `LogicalUnit`, `Address`, `Zone`,
   `Policy`, `Route`, `Tunnel`, `IkeGateway`, `IkeProposal`, `IpsecVpn`, `IpsecProposal`,
   `TrafficSelector`, `Binding`.
2. It has genuine ordering constraints, cross-object references, and an absence that means
   something (`GCM is AEAD, so there is no separate authentication-algorithm`).
3. It has a rich, already-authored failure taxonomy — the `ERROR DECODER` and
   `FLAP PATTERN → CAUSE` tables give rules their `symptom_if_mismatched` fields directly.
4. **There is a four-side expert reference card for it, written by the project owner, whose
   `set` lines the emitter must reproduce byte for byte.** That is an external, independent,
   unarguable oracle. No other domain in the project has one.

### 4.2 Deliverable

| Crate | Scope at phase 1 | Approx. lines |
|---|---|---|
| `fathom-graph` | Node kinds, edge taxonomy, semantic scalars, the four-state `Presence`, provenance, stable IDs, L0 invariants. `11` in full for the IPsec slice + the interface/zone/route slice it needs. | 2,500–3,500 |
| `fathom-rules` | Condition language, selectors, static read-set extraction, incremental evaluation, findings identity and lifecycle, conflict and supersession. `12`. | 1,800–2,500 |
| `fathom-emit` | `EmittedLine`, `StatementPath`, blocks, ordering, the `JunosSet` and `JunosBrace` flavours, placeholders, wrapping, clipboard. `13`. | 1,800–2,400 |
| `fathom-cbor`, `fathom-wire` | Canonical CBOR subset; record framing; envelope header. **Shape now, primitives narrow** — see §8.2. | 900 |
| `fathom-crypto` | One AEAD, one KDF, hardcoded parameters, no key hierarchy, no sharing, no rotation. Enough that no workspace is ever written in plaintext. | 400 |
| `ui/` | The walkthrough: question flow, inline findings, the emitted-config pane with per-line risk, click-a-line-to-explain, the depth toggle. | 2,000–2,800 TS |

Corpus for phase 1 (D1 track): the statement dictionary slice for `junos-srx` security-ike /
security-ipsec / interfaces-st0 / zones / routing-options (~250 of `14` §6.5's ~2,000
per-platform entries); **40–60 rules** with `acceptable_when` on every one; explainer classes
`line` + `placeholder` + `block` (~85) and `field` + `kind` (66), which is `15` §12.5's P2 and
P3.

### 4.3 User-visible outcome

Pick "site-to-site IPsec, SRX, route-based". Answer questions. Findings appear **as you go**,
not at the end (brief §6.2). Get:

- the six-object chain, in the card's order, as `set` lines;
- the five plumbing pieces, generated from the same graph rather than pasted from a template;
- `pre-shared-key ascii-text "<PSK:SITE-B>"` and nothing else where the secret goes;
- every line clickable, at three depths, with the explainer and the emitter reading the same
  node.

The finding that must fire on the default path, because the brief seeds it and the card
argues it for half a side:

```
  ▌ ipsec.pfs.absent                                          high
    Perfect Forward Secrecy is not configured

    Without PFS, Phase 2 keys derive from Phase 1 key material. One
    compromised IKE SA secret unlocks every data key derived under it,
    including previously recorded traffic.

    If mismatched   PFS on one side and absent on the other fails Phase 2
                    while Phase 1 stays up — "IKE looks fine but the tunnel
                    keeps dropping."

    Fix             set security ipsec policy IPSEC-POL \
                      perfect-forward-secrecy keys group14      CHANGES CONFIG

    Acceptable when Interoperating with a peer that cannot support it.
                    Document the exception and compensate with shorter
                    Phase 2 lifetimes.

    Sources         RFC 7296 §1.3.2
                    srx-ipsec card, side 2, PERFECT FORWARD SECRECY

    [ suppress with a reason ]
```

### 4.4 Exit criteria — what proves the architecture correct

These are the sharpest exit criteria in the document, because phase 1 is where the design is
either right or expensively wrong.

| # | Criterion | Why it proves something |
|---|---|---|
| **X1.1** | **The emitter reproduces sides 1 and 2 of the field card, byte for byte, from a graph built through the walkthrough.** Golden fixture, diffed in CI. | An external oracle written by a domain expert before the tool existed. If the emitter needs a special case to match it, the schema does not model what the expert modelled. `13` §8.3(a) is already the target text. |
| **X1.2** | `EmittedLine.source_node` and `source_fields` are non-empty for **100%** of emitted lines. Not 99%. | Invariant 6. One line without provenance is a line the explainer cannot reach, and the exception becomes the rule within two releases. |
| **X1.3** | Gate CG1 is on: **a new emitter statement cannot ship without an explainer** (`15` §12.4). Waivers exist, have an owner and an expiry, and expire into a build failure. | This is the teaching pillar becoming structural rather than aspirational. It is also the gate someone will try to bypass under deadline, which is why the bypass is designed rather than improvised. |
| **X1.4** | `fathom-rules` contains **zero** platform identifiers. A grep gate over the crate for `junos`, `srx`, `panos`, `ios`, `fortios` fails the build. | Invariant 5, mechanically. The moment a `match platform` appears in the engine, `N × M` growth has started and nobody will notice for a year. |
| **X1.5** | At least **20 of the 40–60 rules were authored by a network engineer with no help from a programmer**, from the spec alone, and they pass their own fixtures. | R-RULES-DATA. Rules-as-data that only programmers can write is code with extra steps. |
| **X1.6** | Every rule has a non-empty `acceptable_when`. A rule that can never be acceptable says so explicitly. | Invariant 8. Enforced at pack build. |
| **X1.7** | ≥2 fixtures per rule, one firing and one passing (`45` §6). ≥500 rule fixtures is the v1 target; phase 1's slice is ~120. | A rule with no negative fixture fires on everything and nobody finds out until it is muted. |
| **X1.8** | B10 (emit one full device ≈ 4,000 lines) P95 ≤ 30 ms; B11 (re-emit after one field change) P95 ≤ 4 ms | Re-emit latency is what makes findings-as-you-go possible. If B11 fails, the walkthrough becomes batch. |
| **X1.9** | B7 (field commit → findings on the edited node) P95 ≤ 16.7 ms | Same reason. `12` §6's incremental evaluation exists for this number. |
| **X1.10** | Two builds emit byte-identical config for the same workspace. No `HashMap` iteration in any output path (clippy lint + grep gate, `41` §8.2). | R-DETERM for emit. |
| **X1.11** | The five plumbing pieces of side 1 are emitted from graph structure, not from a per-task template. Verified by deleting the zone binding in the graph and confirming `#2` and `#5` disappear and a finding fires. | The difference between a model and a form with a Jinja file behind it. This is the test that separates Fathom from Nautobot Golden Config. |
| **X1.12** | No credential of any kind can be entered anywhere in the UI. Asserted by an e2e test that types a PSK into every field and confirms it is rejected or placeholdered. | Invariant 3. |

**X1.1 and X1.11 together are the phase.** Everything else is hygiene. If the emitter
reproduces the expert's own reference text from a graph, and the plumbing falls out of graph
structure rather than a template, then `config = emit(graph, vendor)` is real for one platform
and one task, and the architecture has earned the right to be extended.

### 4.5 What phase 1 does *not* prove

**It does not prove the schema is vendor-neutral.** A schema co-designed with one platform by
people who know that platform will fit that platform. That is R-SCHEMA and it is settled in
phase 7, not here. Phase 1's job is to prove the schema is *sufficient* and *composable*;
phase 7's job is to prove it is *neutral*.

There is a cheap partial hedge and it should be taken: **write the PAN-OS and IOS-XE columns
of `13` §8.4's divergence table during phase 1, on paper, without implementing them.** It
costs D1 about three days and it flags object-decomposition mismatches while the schema is
still soft. It is not a substitute for phase 7. It is a smoke detector.

### 4.6 Risk retired

| Retired | Not retired |
|---|---|
| R-PROVENANCE (X1.2, X1.3) | R-SCHEMA — untouched |
| R-RULES-DATA (X1.4, X1.5) | R-RESIDUE — no parser yet, so every graph so far was built by us |
| R-DETERM for emit (X1.10) | R-ZK — one AEAD, no key hierarchy, no adversarial review |

### 4.7 Effort

**Solo:**

| Work | Weeks |
|---|---|
| `fathom-graph` — kinds, edges, scalars, `Presence`, provenance, invariants | 5–7 |
| `fathom-rules` — condition language, selectors, read-set extraction, incremental eval, findings lifecycle | 4–6 |
| `fathom-emit` — paths, blocks, ordering, two flavours, placeholders, wrapping | 3–5 |
| `fathom-cbor` / `fathom-wire` / narrow `fathom-crypto` (§8.2's shape-first decision) | 2–2.5 |
| Walkthrough UI, inline findings, emitted-config pane, line-level explanation, depth toggle | 3–4.5 |
| Corpus: statement dictionary slice, 40–60 rules + fixtures, explainers P2–P3 | 5–7 |
| Integration, golden fixtures, the card-byte-identity fight | 2–3 |
| **Total** | **24–34** |

**Team of three: 12–17 weeks.** Better parallelism than phase 0 because `fathom-emit` and the
walkthrough UI can proceed against a frozen graph API once `fathom-graph` lands, and the rule
corpus is entirely D1's. E1 remains the critical path on graph → rules.

"The card-byte-identity fight" is a real line item, not padding. Reproducing an expert's
formatting — continuation backslashes, argument order, which statements they chose to write
out and which they left to defaults — surfaces a dozen small schema questions, each of which
is a half-day argument and one of which will be a redesign.

---

## 5. Phase 2 — paste and inventory

*margin tab: never an empty form*

> **THE FIRST TIME THE SCHEMA MEETS A CONFIG WE DID NOT WRITE**

### 5.1 Why here

Brief §6.3 is unambiguous:

> *"**Paste is the primary on-ramp for inventory.** `show configuration | display set` in,
> populated graph out, diagram drawn, findings listed. Never an empty form (§2.2)."*

Brief §2.2 is the reason: source-of-truth deployments fail on data-entry discipline, with
documentation accuracy reported falling to roughly 15–30% without automated synchronisation.
Any design that begins with "now model your estate in these forms" inherits that failure. So
paste is not a convenience feature; it is the mitigation for the single most reliable way this
category of tool dies.

It comes second rather than first because a parser needs a target. `14`'s bind stage produces
IR fragments, and until phase 1 there is no IR to produce fragments of. Building the parser
first means designing the schema through the parser's eyes, which optimises for what
configurations happen to contain rather than for what the emitter and the rules need.

### 5.2 Deliverable

| Crate | Scope | Approx. lines |
|---|---|---|
| `fathom-parse` | Frame → lex → shape → bind, for `junos-srx` in both `display set` and brace forms. The statement dictionary (~2,000 entries per platform, of which phase 1 authored ~250). Error recovery, residue, the line ledger. The redaction gate. Identity resolution on re-parse. `14` in full for one platform. | 3,000–4,000 |
| `ui/` | Paste surface, the line ledger view, the residue panel, the inventory table (virtualised), reverse explanation as an annotated walkthrough | 1,800–2,400 TS |

Reverse explanation is close to free once the parser and the explainer corpus both exist —
`21` §5.4 rejects a `config.explainer` subagent for exactly this reason: *"this is the parser
plus the explainer corpus pointed backwards."* Budget a week for the presentation, not a
month for the capability.

### 5.3 The three things paste must never do

| Must not | Mechanism |
|---|---|
| **Silently drop a line** | Every input line is in the ledger with one of: bound, defaulted, residue, redacted. `14` §8. A line that vanishes is a graph that lies, and the user cannot tell. |
| **Ingest a credential** | The redaction gate (`14` §9) runs **before** anything is stored, and it is a gate rather than a filter: a PSK in pasted text is replaced at the frame stage and the user is told. Invariant 3 has no exception for pasted material. |
| **Claim more than it knows** | Every node gets `provenance: Parsed{ source, when }`. Brief §6.5: nodes populated by parsing are marked as such and show their age. This is what stops the diagram from becoming a source of truth by accident. |

### 5.4 The inventory has opinions

Brief §6.4's payoff needs no new machinery, which is the point:

> *"Add a second SRX and it observes that these two look like a cluster candidate, and here is
> what RG0 and RG1 would need. Facts that argue back."*

The rule engine from phase 1 runs against parsed nodes the moment they exist. The cluster
observation is a rule with a selector over two `Device` nodes, an `acceptable_when` ("two
standalone SRXs at one site is a legitimate design if they serve different functions"), and a
remediation that is emitted config. Zero new subsystems, which is `views compose for free`
being true rather than asserted.

### 5.5 Exit criteria

| # | Criterion |
|---|---|
| **X2.1** | **Round-trip law**: for every golden emit fixture, `parse(emit(g))` produces a graph that is `≅ g` under `11` §10's identity rules. Property-tested, not spot-checked. |
| **X2.2** | The card's own side-1 configuration, **damaged** in the six ways `14` §14 enumerates (truncation mid-stanza, a wrapped line, an unknown statement, a redacted secret, mixed forms, a stray prompt), parses with every damaged line ledgered and none silently dropped. |
| **X2.3** | On ≥ 3 real SRX configurations from ≥ 2 estates we did not write, ≥ 95% of security-ike/security-ipsec/interfaces/zones/routing-options lines bind, and **100% of the remainder is in the residue ledger with a reason**. |
| **X2.4** | B9: parse 5,000 `set` lines → graph fragment, P95 ≤ 90 ms. |
| **X2.5** | Five fuzz targets run 30 minutes each with no crash, no panic, no unbounded allocation (`45` §8). `fathom-parse` is the hostile-input crate and is fuzzed as such. |
| **X2.6** | Re-parsing the same config twice produces the same node IDs (identity resolution, `14` §10). A device that gets new IDs on every paste destroys every suppression and every rule reference. |
| **X2.7** | No credential reaches the graph: an e2e test pastes a config containing a PSK, a certificate, an SNMP community and a TACACS key, and asserts none appears in the workspace bytes. |
| **X2.8** | Reverse explanation renders an inherited config as an annotated walkthrough at all three depths, with `Parsed` provenance and age shown on every node. |

X2.3 is the one that can fail. 95% is a stated target, not a measured one, and the honest
position is that we do not know what the number will be until we have configs from estates we
did not write. §12.3 makes it a kill point.

### 5.6 Risk retired

| Retired | Not retired |
|---|---|
| R-ONRAMP (X2.3, X2.8) | R-SCHEMA — parsing Junos into a Junos-shaped schema proves the parser, not the schema |
| R-RESIDUE (X2.2, X2.3, X2.5) | R-ZK, R-CRDT, R-VIEW, R-AI-* |

### 5.7 Effort

**Solo 14–20 weeks; team of three 7–10 weeks.**

| Work | Weeks (solo) |
|---|---|
| Frame + lex + shape for two Junos forms | 3–4 |
| Bind, the statement dictionary machinery, defaults resolution | 3–4 |
| Error recovery, residue, line ledger | 2–3 |
| Redaction gate + its test corpus | 1.5–2 |
| Identity resolution on re-parse | 1.5–2 |
| Paste UI, ledger view, inventory table, reverse explanation | 2.5–3.5 |
| Dictionary authoring beyond phase 1's slice (~1,750 entries) | **runs on the D1 track, 6–9 weeks of domain time, overlapping** |
| Fuzzing, real-config acquisition, the 95% fight | 1.5–2 |

The dictionary is the thing to watch. `14` §15 states it plainly: *"the dictionary is a
content programme — 400–2,500 entries per platform, human-reviewed. Coverage is the product's
real limit, and no amount of parser engineering moves it."* At 2,000 entries and even 10
minutes each with review, that is over 300 hours. It parallelises across authors better than
explainers do, because dictionary entries are mechanical, but it does not disappear.

---

## 6. Phase 3 — findings, diff, verify, rollback

*margin tab: legible to change management*

### 6.1 Why here, and why it is small

Most of this exists already. Continuous lint shipped in phase 1; suppressions need a
workspace, which exists from phase 1 in narrow form. What phase 3 adds is the *composition*
the brief calls free:

> *"'Show me the verification commands for the change I just made' is `verify(diff(graph))`.
> It requires no new subsystem."* — brief §4.2

That is true of the concept and not quite true of the code: graph diff, config diff, ladder
selection and rollback generation are four real pieces of work (`18` §§2, 3, 4, 5). But they
are four pieces of work over structures that already exist, which is why this is the shortest
phase in the document.

It comes after paste because rollback is only trustworthy when the tool knows the *current*
state, and the reliable way to know the current state is to have parsed it.

### 6.2 Deliverable

Graph diff; config diff (`18` §3, and it is the hard part — the same graph change can produce
different statement sets depending on what is already on the box); the verify ladder as a
directed graph with `next_if_bad` edges, generated per-change rather than generic; rollback
generation; the change ticket.

Suppressions become first-class here: stored in the workspace, carrying a reason, visible to a
reviewer. Brief §6.6 requires the reviewer to be able to see *what was waived and why*, which
means a suppression is a record with an author and a rationale, not a boolean.

### 6.3 User-visible outcome

The worked example is `18` §7: adding PFS to a live tunnel. The tool knows what it just
built, so it emits:

```
  ▌ CHANGE                             CHG-…  ·  1 device  ·  1 tunnel

    set security ipsec policy IPSEC-POL \
      perfect-forward-secrecy keys group14              CHANGES CONFIG

  ▌ BEFORE YOU COMMIT
    Both ends must agree — every value, exactly. PFS on one side and
    absent on the other fails Phase 2 while Phase 1 stays up.

  ▌ VERIFY                                              stop at the first failure
    1  commit confirmed 5                               CHANGES CONFIG
    2  show security ike security-associations           READ-ONLY
    3  show security ipsec security-associations         READ-ONLY
    4  show security ipsec inactive-tunnels              READ-ONLY
    …

  ▌ ROLLBACK
    delete security ipsec policy IPSEC-POL \
      perfect-forward-secrecy                            DISRUPTIVE
    Removing PFS renegotiates Phase 2. The tunnel drops and rebuilds.
```

Note that the rollback is `Disruptive` while the change is `ChangesConfig`. That asymmetry is
real — adding PFS takes effect at the next Phase 2 rekey, removing it forces one — and it is
exactly the kind of thing a generic runbook gets wrong.

### 6.4 Exit criteria

| # | Criterion |
|---|---|
| **X3.1** | **Rollback is an inverse.** For every change in the golden set, applying the generated rollback to the post-change graph yields a graph `≅` the pre-change graph. Property-tested. A rollback that is merely plausible is worse than none. |
| **X3.2** | No emitted line classified `Disruptive` appears in a change set without a corresponding rollback line. Build gate. |
| **X3.3** | Every generated ladder step is a corpus entry with a `read_field` and, where the corpus has one, a `next_if_bad` edge. The ladder is *selected* from the corpus, never synthesised (`16` §1.1). |
| **X3.4** | The change ticket is reproducible: same workspace + same corpus version + same build ⇒ byte-identical ticket, including ordering. |
| **X3.5** | Config diff is correct in the three-way case: intended graph, parsed current state, and the statement set that takes one to the other, with `Retract` handled explicitly (`13` §8.3 — brace flavour cannot express retraction and must refuse rather than silently omit). |
| **X3.6** | A suppression records author, timestamp, rule ID, node ID and a free-text reason, and a reviewer can list every suppression in a workspace with its reason. Empty reasons are rejected. |
| **X3.7** | ≥1 real change, generated by the tool, passes through a real organisation's change-management process with no manual rewriting of the ticket. **Manual criterion, and it is the phase's actual purpose.** |

### 6.5 Risk retired

R-LEGIBLE (X3.7) and R-DETERM for diff (X3.4). Not retired: everything about the schema, the
crypto and the AI layer.

X3.7 is worth defending as an exit criterion despite being unmeasurable and dependent on
someone else's organisation. Brief §6.7 says it directly: *"this is a small feature that makes
the tool legible to change-management processes, which matters more for adoption than it
sounds."* A tool whose output has to be retyped into a ticket is a tool used for learning and
not for work.

### 6.6 Effort

**Solo 8–12 weeks; team 4–6.** Graph diff 1.5–2; config diff 2.5–4 (the hard part); ladder
generation and selection 1–1.5; rollback generation 1.5–2; change ticket and its
reproducibility 1–1.5; suppression lifecycle and review view 1–1.5.

---

## 7. Phase 4 — the diagram

*margin tab: a view, not the data*

### 7.1 Why fourth, and why not first

Every instinct says draw the picture early. The brief forbids it, with the sharpest reasoning
in the document:

> *"**The diagram cannot be the data structure.** A line between two boxes does not say whether
> it is an L2 trunk, an L3 point-to-point, an LACP member link or a tunnel. Build diagram-first
> and you will bolt properties onto edges until you have an accidental, undocumented data
> model."* — brief §4.1

Building the diagram fourth is how that stays true rather than aspirational. By phase 4 the
graph has survived a walkthrough, an emitter, a rule engine and a parser. There is no room
left for the diagram to invent state, because every property it would invent already has a
home with a stable ID and a provenance record.

There is a real cost and it should be named: **for four phases the product has no picture, and
a network tool with no picture is a hard demo.** Buyers, managers and conference audiences
respond to diagrams. Phases 0–3 are demoed to engineers with a keyboard, and that narrows the
audience for the first year. That is the price of not building an accidental data model, and
it is worth paying, but pretending it is free is how the decision gets reversed under pressure
in phase 2.

### 7.2 Deliverable

`fathom-layout` (deterministic layered layout with authored rank constraints, 800–1,500
lines — `41` §9.2, and `21` §5.4 rejects a model-driven layouter precisely because the change
ticket embeds the diagram and must be reproducible); the layer model (physical / L2 / L3 /
security / overlay, toggled independently); the Outline and its bijection with the canvas;
staleness rendering **without a fourth colour**; export.

### 7.3 Exit criteria

| # | Criterion |
|---|---|
| **X4.1** | **Layout is deterministic**: same graph + same build ⇒ byte-identical SVG. No `HashMap` iteration, no wall-clock, no randomised seeds. |
| **X4.2** | Every visual element resolves to a node or edge ID. Nothing on the canvas exists that is not in the graph. Asserted by walking the rendered tree and checking every element's `data-id` against the graph. |
| **X4.3** | The diagram stores **no state of its own** except viewport and layer toggles, both of which are settings and neither of which is graph data. A manual position override is a node field with provenance `Manual`, not a diagram-private table. |
| **X4.4** | B12: first render, 500 nodes, P95 ≤ 160 ms. B13: pan frame, P95 ≤ 8 ms with ≤1% dropped frames over a 5 s scripted pan. |
| **X4.5** | Staleness is rendered without introducing a fourth colour. The risk enum stays exactly three values and its colours are used for nothing else (`51`, conventions §risk enum). |
| **X4.6** | Nodes with `Parsed` provenance display their age; nodes entered by hand do not claim to be observed (brief §6.5). |
| **X4.7** | The exported diagram embeds in the phase-3 change ticket and is byte-identical across builds. |

### 7.4 Risk retired

R-VIEW, and only R-VIEW. X4.2 and X4.3 are the whole test: if the diagram needs its own
state, `diagram = render(graph)` is false and the architecture has a second data model in it.

### 7.5 Effort

**Solo 6–10 weeks; team 3–5.** Layout 2.5–4; layer model and rendering 1.5–2.5; interaction
(select, drag, connect, the Outline bijection) 1.5–2.5; staleness, export, performance work
0.5–1.

`41` §10 open decision 5 offers a scope reduction: ship drag-only positioning first and add
layered auto-layout later. Take it if phase 4 is running long. The exit criteria that matter
(X4.1–X4.3) hold for a drag-only diagram, and auto-layout is the part users forgive being
absent.

---

## 8. Phase 5 — encryption, workspaces, sync

*margin tab: the headline feature, deliberately fifth*

> **EVERYTHING BEFORE THIS WORKS ON A LOCAL, UNSYNCED WORKSPACE**

### 8.1 The argument for lateness

Zero-knowledge is the headline claim. It is in the executive summary, it is the reason the
tool can serve air-gapped, defence, OT and regulated customers, and it is the thing an
enterprise review will spend its time on. Building it fifth looks like a mistake.

It is not, and the reason is one sentence: **every phase before this one delivers full value
on a single machine with a single user and no server.** The finder needs no workspace at all.
The walkthrough, the emitter, the rule engine, the parser, the inventory, the diff and the
diagram all operate on one workspace, opened by one person, on one device. Nothing in phases
0–4 needs multi-device, multi-user, sharing, rotation, revocation or a sync service, and those
are what phase 5 actually is.

The phase-5 scope is therefore not "add encryption". It is:

| In phase 5 | Not in phase 5 (landed earlier) |
|---|---|
| Key hierarchy, workspace keys, per-record keys | The AEAD itself, the envelope header, the record framing |
| Passphrase KDF with tuned parameters and the TTU budget | A hardcoded dev-parameter KDF |
| Sharing, HPKE, member add/remove, revocation | — |
| Rotation | — |
| The Axum sync service, the `Store` trait, redb + Postgres | — |
| The op-based CRDT and merge | The op set (`fathom-ops`, phase 1, applied locally and linearly) |
| Git transport and the merge driver | — |
| D2 and D3 deployment, operational runbooks | D1 and D4 |
| Adversarial zero-knowledge review | — |

### 8.2 DECISION — the envelope ships in phase 1, narrow; the hierarchy ships in phase 5

Deferring crypto wholesale is genuinely dangerous, because the failure mode is discovering in
month fourteen that the storage format cannot accommodate the envelope. Principle O3 applies:
land the shape early, the substance late.

Concretely, from phase 1 onward:

- `fathom-wire`'s record framing and envelope header are final. Frames are content-addressed,
  append-only and sealed.
- `fathom-crypto` implements **one** AEAD and **one** KDF, with parameters hardcoded and a
  single workspace key derived from a passphrase.
- **There is no plaintext workspace mode and no null cipher.** Not behind a feature flag, not
  behind an environment variable, not in dev builds. `41` §8.3 forbids features that change
  observable behaviour, and "dev mode writes plaintext" is the single most likely way a
  plaintext workspace reaches a user's disk.
- Phase 1–4 workspaces are encrypted with real primitives and a real passphrase. They simply
  cannot be shared, rotated or synced.

The cost of this decision: phase 1 carries ~2 weeks of crypto work it would rather not, and
the phase-1 workspace format has to be migratable when the key hierarchy arrives. `17` §11's
schema-evolution machinery covers the migration and it exists anyway. That is a good trade
against the alternative, which is a phase-5 discovery that frames need a different header.

### 8.3 Deliverable

`fathom-crypto` in full (`32`); `fathom-ops` CRDT and merge (`33` §4.3); `fathom-store` with
the `Store` trait and both backends plus the ~60-test conformance suite; `fathom-sync` (Axum,
and it must never depend on `fathom-graph`, `-rules`, `-emit` or `-parse` — `41` §5.5,
enforced by `xtask check-deps`); the git merge driver; D2's compose file and D3's Helm chart;
the operational runbooks.

### 8.4 Exit criteria

| # | Criterion |
|---|---|
| **X5.1** | **The adversarial test**: dump the server's entire store (object store + database + logs) and hand it to a reviewer who is told to recover one plaintext device name. They cannot. This is R-ZK and it is a red-team exercise, not a unit test. |
| **X5.2** | The service crates do not link the graph, rules, emit or parse crates. Symbol-table assertion on the built binary, not only a `cargo metadata` check. |
| **X5.3** | B14: time to unlock ≤ KDF + 150 ms P95. The KDF term is a policy choice and is stated as a formula, not a number (`44` §4.8). |
| **X5.4** | CRDT convergence: property tests over randomised concurrent op sequences from up to 8 replicas converge to the same graph, and the converged graph satisfies every L0 invariant. A CRDT that converges to an invalid graph is worse than a conflict. |
| **X5.5** | Both `Store` implementations pass all ~60 conformance tests identically. |
| **X5.6** | Restore from backup is verified **by a client with a key**, never by the operator (`43` §5.7). The operator cannot confirm their own backup is good, and the runbook says so. |
| **X5.7** | Crypto test vectors: 12 files, ~600 cases, run every PR (`45` §12). |
| **X5.8** | An external cryptographic review has been commissioned and its findings resolved or documented as accepted risk. **Not a self-assessment.** |
| **X5.9** | D2 and D3 deploy from the published artifacts with the documented runbooks, by someone who did not write them. |

### 8.5 Risk retired

R-ZK (X5.1, X5.8) and R-CRDT (X5.4, X5.5). This is the phase that makes the enterprise
conversation possible, and it is also the phase most likely to need outside expertise.

### 8.6 Effort

**Solo 16–24 weeks; team 8–12.**

| Work | Weeks (solo) |
|---|---|
| Key hierarchy, KDF tuning, sharing, HPKE, rotation, revocation | 4–6 |
| CRDT + merge over the typed graph | 4–6 |
| `Store` trait, redb, Postgres, conformance suite | 2.5–3.5 |
| `fathom-sync` service, auth, rate limits, watermarks | 3–4 |
| Git transport and merge driver | 1–1.5 |
| D2 compose, D3 Helm, NetworkPolicy, runbooks | 1.5–2.5 |
| External review and rework | **2–4 weeks elapsed, mostly waiting, plus rework** |

The CRDT is the line item most likely to be wrong. `41` §9.2 budgets it at 1,500–2,500 lines
and `33` §4.2 names the exit — adopt Automerge or Loro if the hand-rolled version is not
converging. **Take that exit early rather than late.** A hand-rolled CRDT that mostly works is
the worst possible state for a tool whose output people paste into routers.

---

## 9. Phase 6 — the AI layer, tier by tier

*margin tab: build the cage first*

### 9.1 The constraint this phase exists inside

The owner's requirement is explicit and it is new relative to the architecture document:

> *"There needs to be a supervisor AI and sub agents."*

And the owner's own §6.1 is equally explicit: the finder is *"deterministic — fuzzy matching
plus a synonym map, no model at runtime."* Plus invariant 1 (no egress), invariant 9
(determinism where observable) and the offline single file. Reconciling those is not an add-on;
`21` treats it as a first-class architectural problem and this phase implements the answer.

The answer, in one line: **the AI layer is never in the artifact path.** It proposes; the
deterministic core disposes. `21` §7.0's last row is the whole thing — reproducibility of
artifacts is *identical at every tier*, because the model cannot emit a line of config, fire a
finding, or change a ranking.

### 9.2 6a — the boundary, before any model exists

**Build the cage before the animal.** Phase 6a ships with no model at any tier and is
therefore entirely testable.

| Deliverable | Note |
|---|---|
| The `resolve()` dispatch with the second arm unreachable, and the compiler proving it | `21` §3.2: the resolver runs first and the supervisor runs *only if it declines* |
| The **under-determination surface** (`21` §7.1) | The tier-0 answer to the four `Underdetermined` cases. It is a good product on its own: the disambiguation list, the relevant findings, and a gap-filing affordance |
| `Proposal`, the three verbs, the accept/reject/amend contract, the shadow graph | The types, with no producer |
| The tool broker, capability grants, the audit record | `21` §6.6 — enforcement lives in the broker, not in prompts |
| `fathom-audit` and `fathom-verify` | `fathom-verify` **never links `fathom-ai`**, asserted in the built binary's symbol table |
| `xtask check-deps` edge: nothing depends on `fathom-ai` | The cheapest architectural control in the repository |

**Exit 6a:** the tier-0 acceptance suite is green; `fathom-verify` reproduces every artifact
in a workspace with `fathom-ai` absent from the binary; the under-determination surface is
rated by the pilot group as an improvement on "no results".

### 9.3 6b — tier 2b first, not tier 1

**DECISION — the first tier with a model is 2b (loopback sidecar), not 1 (BYOK hosted).**

The obvious order is tier 1 first, because it needs no local hardware and gives the strongest
models. Take tier 2b first anyway, for three reasons:

1. **It keeps every invariant.** `connect-src` is `http://127.0.0.1:<port>`; nothing leaves
   the machine. So 6b can ship before the consent UI, the redaction profiles, the pre-flight,
   the armed-state indicator and the egress log exist — and those are most of tier 1's work
   and none of them are model work.
2. **Grammar-constrained decoding.** A llama.cpp-class sidecar supports GBNF, which removes an
   entire failure class (`21` §6.6). Building the broker against a client that cannot emit
   malformed tool calls means the broker's rejection paths are tested deliberately rather than
   discovered.
3. `21` §7.3: *"Tier 2 is the tier this product should want people on."* Building it first
   makes it the reference implementation rather than the fallback.

Cost, stated: tier 2b requires the user to install a process, and CORS plus the moving state
of Private Network Access preflighting are real frictions (`21` §7.3, which already carries a
VERIFY on the second one). A tier that requires a local install will have a fraction of tier
1's reach.

Subagents in 6b, in order: `intent.router` (a closed enum, works at 3 B), `corpus.scout`
(chooses among candidates the resolver already retrieved), `finding.narrator` (ordering only,
cannot propose).

### 9.4 6c–6e — the rest of the tiers

| Step | Contents | Why this position |
|---|---|---|
| **6c — tier 1, BYOK** | The pre-flight, redaction profiles, consent scope per workspace per purpose class, the armed-state indicator, the egress log with every request body retained, the enumerated-origin CSP | This is where the headline security claim gets a documented hole in it. The work is UI, policy and copy, not inference. `21` §8.7 states the hole without softening and that text ships as-is. |
| | `config.triage` becomes reachable (residue-only scope, may propose) | Requires phase 2's residue ledger |
| | `symptom.correlator` (wide scope, cannot propose) | A4 |
| **6d — tier 2a, in-page WebGPU** | Weights from a local file the user selects, never fetched. `constraint.negotiator` **off by default** at this tier | Last of the model tiers because a 3 B model is unreliable at the interesting subagents and the first-load experience is bad by construction |
| **6e — tier 3, enterprise** | The operator policy file, signed and distributed like a rule pack, that can **tighten but never loosen** client defaults. A client receiving a loosening policy rejects it | Needs a customer. Building it without one produces a policy schema nobody wanted |

**`constraint.negotiator` and `adversary.redteam` ship together or not at all** (principle O4).
The negotiator is the subagent that explores mutually exclusive configurations and produces
confident, well-cited, wrong proposals; the red team is the only mechanism that catches the
mechanical subclass of that error, and its output type permits only objections. Shipping the
negotiator alone is shipping the failure mode without the brake.

### 9.5 Exit criteria

| # | Criterion |
|---|---|
| **X6.1** | **The reproducibility check** (`21` §9.5): open a workspace with AI disabled, regenerate every artifact, and get byte-identical output to the AI-assisted session. If this fails, the model is in the artifact path and the phase has failed regardless of how good the output is. |
| **X6.2** | `shadow_rule_rate` below its threshold: no subagent is routinely producing output a rule could produce. Build gate (`21` §3.4). If it trips, either the subagent narrows or the rule gets written. |
| **X6.3** | Admission criteria A1–A5 enforced at review. The default answer to "should this be a subagent" is "no, it should be a rule". |
| **X6.4** | Tier 0 remains the development default and the full acceptance suite runs against the tier-0 artifact. Any feature whose acceptance test requires a model is rejected (`21` §7.1). |
| **X6.5** | Every AI-produced element in the UI is labelled as such, and the workspace records `ModelPin`, prompt version, and the proposal's accept/reject/amend outcome, readable six months later by someone who was not there (`21` §9.4). |
| **X6.6** | The egress pre-flight shows the **literal payload** before it is sent, at every tier that sends anything, including tier 3. |
| **X6.7** | The offline single file at tier 0 and tier 2a still carries `connect-src 'none'` in its final bytes. |

X6.4 is the one that rots. `21` §7.1 says it directly: *"the moment tier 1 becomes the
development default, tier 0 rots."* Put it in the definition of done for every subsequent PR,
not only in this phase's exit criteria.

### 9.6 Effort

**Solo 14–22 weeks; team 7–11.** 6a (boundary, broker, audit, verify, under-determination
surface) 4–6; 6b (sidecar transport, GBNF grammars, three subagents, eval sets) 3–5; 6c
(redaction, pre-flight, consent, egress log, two subagents) 4–6; 6d (WebGPU runtime
integration, weights-from-file) 2–3; 6e (operator policy) 1–2.

Add the evaluation programme: `25` budgets roughly 20 rater-hours per release and 28 on the
first. That is a standing cost from 6b onward, not a phase cost.

---

## 10. Phase 7 — the second platform, and the mid-life crisis

*margin tab: the entire bet, settled*

> **IF THE SCHEMA IS JUNOS-SHAPED, THIS IS WHERE YOU FIND OUT, AND IT IS ALREADY EXPENSIVE**

### 10.1 Why this is a crisis and not a feature

Everything to this point was co-designed with one platform, by people who know that platform,
against a reference card written by an expert in that platform. That is the right way to build
depth and it is also the perfect conditions for a schema that fits Junos and calls itself
vendor-neutral.

Brief §5.1 does not hedge: *"This schema is the entire bet of the project."* Phase 7 is where
the bet settles. It has three possible outcomes:

| Outcome | Evidence | What happens |
|---|---|---|
| **The schema holds** | PAN-OS IPsec needs zero new node kinds; divergence is confined to emitter statement tables and the extension bag carries only genuinely platform-local fields | The product is what it claims to be. Platform three is a content programme, not an architecture programme. |
| **The schema bends** | A handful of new kinds, some fields move between kinds, the extension bag grows | Survivable. Migrate (`11` §11), pay a few weeks, write down what was learned. |
| **The schema breaks** | PAN-OS needs a parallel object model, or rules acquire platform-specific conditions, or `if platform ==` appears outside the emitter | **The mid-life crisis.** Either the IR is redesigned with two platforms in view, which is most of phase 1 again, or the product becomes a single-platform tool and the marketing changes. Both are legitimate. Pretending it did not happen is not. |

### 10.2 DECISION — the second platform is PAN-OS

Candidates, judged on **how fast they tell you the schema is wrong**, not on market size:

| Platform | Architectural information it yields | Verdict |
|---|---|---|
| **`panos`** | **Structural divergence, not lexical.** Junos decomposes a VPN into six named objects; PAN-OS folds `ipsec proposal` and `ipsec policy` into one `ipsec-crypto-profiles` object, so two graph nodes map to one platform object and the two emitters must agree on a derived name (`13` §8.3(c)). PFS lives on a different object entirely. And the absence-encoding trap: on Junos "no PFS" is the *absence* of a statement, while PAN-OS requires the explicit `no-pfs` selection, documented by Palo Alto as making the firewall reuse the phase 1 key for the IPsec SA negotiation. | **Second.** It is the platform that most directly attacks the schema's shape. |
| **`ios-xe`** | Tests **ordering** hard — `set transform-set IPSEC-P2` is rejected unless `crypto ipsec transform-set IPSEC-P2` was entered first, an ordering constraint that on Junos does not exist (`13` §8.3(d)). Also tests selectors: a VTI's IPsec SA traffic selector is always `IP any any` and VTIs do not support narrowing, so the graph's many `TrafficSelector` nodes have no representation at all. | **Third.** A real test, but of the emitter's ordering machinery more than of the schema's shape. Its selector story is a representability problem, which `13` §9 already has machinery for. |
| **`fortios`** | Largest commercial pull of the three in the mid-market. Config is a regular `config / edit / set / next / end` tree, which is the *easiest* of the four to parse. | **Later.** Highest demand, lowest architectural information. Choosing it second optimises for sales and learns the least. |

**The counter-argument, stated fairly:** if the goal is adoption rather than architecture, IOS
and IOS-XE have the larger installed base and would be the commercial choice for platform two.
This roadmap chooses the platform that tells us fastest whether the schema is wrong, because
discovering R-SCHEMA in year three is fatal and discovering it in month eighteen is expensive.
If the project's constraint is revenue rather than correctness, invert this decision knowingly
and write down that you did.

### 10.3 The falsifiable claim

**PAN-OS site-to-site IPsec requires zero new node kinds.**

That is the phase's thesis and it is testable. Fields may move, edges may be added, the
extension bag may take genuinely platform-local values (`11` §12). But a *new kind* means the
graph did not model a concept that both platforms have, which means the schema was describing
Junos objects rather than networking concepts.

The four specific things to watch, each an early symptom rather than a verdict:

| Symptom | What it means |
|---|---|
| `if platform == Panos` outside `fathom-emit`'s statement tables | Per-vendor logic leaking. Invariant 5 is failing quietly. |
| A rule acquiring a platform-specific *condition* rather than a `platforms` predicate | Same failure, in the corpus rather than the code. |
| The extension bag carrying a field that both platforms have | The field belongs in the schema and the bag is being used as an escape hatch. |
| `Representability::Composed` on more than ~10% of emitted lines | The mapping is not a mapping; it is a translation with judgement in it, and the user is being shown output whose relationship to their graph they cannot follow. |

### 10.4 Deliverable

The `panos` statement dictionary and emitter tables; the PAN-OS parser front end (`14` §5's
fourth CST); the PAN-OS command corpus for IPsec plus the Rosetta mappings that phase 0
deliberately stubbed; `platforms:` predicates added to the existing rule set; the per-platform
default table that the `Default(v)` row of `13` §8.5 requires and that cannot be shared.

### 10.5 Exit criteria

| # | Criterion |
|---|---|
| **X7.1** | **Zero new node kinds** for PAN-OS site-to-site IPsec. If new kinds are required, the phase has produced its most valuable output and §12.8 applies. |
| **X7.2** | One graph emits both `junos-srx` and `panos`, and the PAN-OS output is validated by a PAN-OS engineer against a real firewall. |
| **X7.3** | Absence is emittable: a graph whose `IpsecPolicy.perfect_forward_secrecy` is `Absent` emits **nothing** on Junos and **`dh-group no-pfs`** on PAN-OS, and the report records `Representability::Composed` with the note that the source expressed this by omission. |
| **X7.4** | Cross-platform emission never drops silently. Every unrepresentable element appears in the report with a classification (`13` §9). |
| **X7.5** | A PAN-OS configuration parses into the same schema with ≥95% bind rate, same as X2.3. |
| **X7.6** | Cross-vendor finder queries work: *"Junos version of `show crypto ipsec sa`"* resolves through the Rosetta layer, which now has a real target on both sides. |
| **X7.7** | `fathom-rules` still contains zero platform identifiers (X1.4, re-run). |
| **X7.8** | No rule required a platform-specific condition; every platform difference is expressed as a `platforms` or `versions` predicate. |

### 10.6 Effort

**Solo 12–18 weeks; team 6–9**, plus the corpus programme, which is the larger number and runs
on its own track: `15` §12.6 estimates ~1,700 explainer entries for three platforms × three
domains at roughly six person-months. PAN-OS IPsec alone is perhaps 6–8 person-weeks of D1
time for explainers, plus dictionary entries, plus command corpus, plus the conformance lab on
a real firewall.

**Budget an explicit contingency of 4–8 weeks for schema repair.** Not as padding — as a named
line item with a decision attached. If the repair is bigger than 8 weeks, it is not a repair
and §12.8 applies.

---

## 11. The dependency graph

*margin tab: what can run in parallel*

```
                                  CORPUS TRACK  (D1, continuous, never "done")
  ┌───────────────────────────────────────────────────────────────────────────────┐
  │ P0 ref set (50) → cmd+output+error (83) → line+block (85) → field+kind (66)    │
  │        → concept+symptom (40) → value+step+absence (116) → panos (~500)        │
  │ dictionary: junos-srx slice (250) ─────────→ junos-srx full (2,000) → panos    │
  │ rules: ipsec core (40–60) ───────────────────────────────→ + platforms preds   │
  └───────────────────────────────────────────────────────────────────────────────┘
        ║              ║                 ║               ║                ║
        ▼              ▼                 ▼               ▼                ▼
  ┌───────────┐
  │  SPIKE    │  2 wk, throwaway, answers "is the content the value?"
  └─────┬─────┘
        │
  ┌─────▼──────────────┐
  │ PHASE 0  the wedge │  fathom-id · -corpus · -find · -wasm · -cli · ui · xtask
  │ D1 + D4 artifacts  │  RETIRES  R-VOCAB  R-DETERM(find)  R-SIZE
  └─────┬──────────────┘
        │
  ┌─────▼──────────────────────────┐
  │ PHASE 1  graph · emit · rules  │  fathom-graph · -rules · -emit · -wire · -crypto(narrow)
  │ walkthrough, one task, one     │  RETIRES  R-PROVENANCE  R-RULES-DATA  R-DETERM(emit)
  │ platform, end to end           │
  └──┬───────────┬─────────────┬───┘
     │           │             │
     │           │             └──────────────────────────────┐
     │           │                                            │
  ┌──▼────────┐  │                              ┌─────────────▼──────────────┐
  │ PHASE 2   │  │                              │ PHASE 5  crypto·workspaces │
  │ paste +   │  │                              │          ·sync             │
  │ inventory │  │                              │ D2 + D3 artifacts          │
  │ R-ONRAMP  │  │                              │ RETIRES  R-ZK  R-CRDT      │
  │ R-RESIDUE │  │                              └─────────────┬──────────────┘
  └──┬────┬───┘  │                                            │
     │    │      │                                            │
     │    │  ┌───▼────────────────┐                           │
     │    └──► PHASE 3  findings  │                           │
     │        │  diff·verify·     │                           │
     │        │  rollback         │                           │
     │        │ RETIRES R-LEGIBLE │                           │
     │        └───┬───────────┬───┘                           │
     │            │           │                               │
     │        ┌───▼────────┐  │                               │
     │        │ PHASE 4    │  │                               │
     │        │ the diagram│  │                               │
     │        │ R-VIEW     │  │                               │
     │        └────────────┘  │                               │
     │                        │                               │
     └────────────┬───────────┘                               │
                  │                                           │
          ┌───────▼───────────────────────────────────────────▼──────┐
          │ PHASE 6  the AI layer                                    │
          │  6a boundary (no model) → 6b tier 2b → 6c tier 1         │
          │                        → 6d tier 2a → 6e tier 3          │
          │ RETIRES  R-AI-BOUND  R-AI-VALUE                          │
          └──────────────────────────┬───────────────────────────────┘
                                     │
                          ┌──────────▼──────────────┐
                          │ PHASE 7  second platform│
                          │  panos                  │
                          │ RETIRES  R-SCHEMA       │
                          └─────────────────────────┘
```

### 11.1 The edges, and why each one exists

| Edge | Why it is real |
|---|---|
| P0 → P1 | Not technical. P0 has no code P1 needs beyond `fathom-id` and the build. The edge is **evidential**: P0 is what tells you the corpus can be authored and the vocabulary gap can be closed. Start P1 before P0's pilot reports and you are betting on R-VOCAB and R-CORPUS with a quarter of engineering already spent. |
| P1 → P2 | Hard. The parser binds to an IR that must exist. |
| P1 → P5 | Hard. The workspace format, the op set and the envelope framing all come from P1. |
| P2 → P3 | Hard for rollback and config diff, which need the parsed current state to be trustworthy. |
| P1 → P3 | The graph diff and the ladder need only the graph. This is why P3 can start on graph diff before P2 finishes. |
| P3 → P4 | Soft. The diagram overlays findings and embeds in the change ticket. A diagram without them is possible; it is just worth less. |
| P2 → P6 | Hard for `config.triage`, whose entire scope is the parse residue. |
| P3 + P5 → P6 | Soft. The AI layer's audit trail and consent model assume a workspace with sharing semantics. 6a can start before P5 lands. |
| P6 → P7 | **Soft, and reversible.** See §11.3. |

### 11.2 What runs in parallel

| Concurrent | Condition |
|---|---|
| **The corpus track and every engineering phase** | Always. This is the single biggest scheduling lever in the project and the reason a three-person team beats a solo builder by more than 2× on wall clock. |
| **P5 and P2/P3/P4** | P5 depends only on P1. With a team, P5 (crypto + sync) is the natural second work stream from the moment `fathom-wire` is stable. |
| **P3's graph diff and P2's parser** | Different crates, one shared type. |
| **P4 and P6a** | Fully independent. |
| **The conformance lab and everything** | Running configs on a real SRX is D1 work with its own cadence, per release. |

### 11.3 The one reorder worth considering

**Phase 7 before phase 6.** The AI layer is the owner's explicit requirement and it is a large,
visible piece of work. R-SCHEMA is the project's most severe unretired risk.

The argument for 7-before-6: settling R-SCHEMA earlier is worth more than an AI layer, because
a schema repair after the AI layer exists means repairing the AI layer's tool contracts, its
graph projections and its eval sets as well.

The argument for 6-before-7 as written: `config.triage` and `symptom.correlator` are most
useful precisely when a config is unfamiliar, which is the state a second platform creates;
and the AI layer's admission criteria (A1–A5) act as a discipline that keeps platform-specific
logic out of the model layer during phase 7.

**RECOMMENDATION — swap them if phase 2's real-config bind rate comes in near the bottom of
its range, or if anything in phase 1–3 required a platform-specific escape hatch.** Both are
early signals that R-SCHEMA is worse than assumed, and both argue for settling it before
building more on top.

---

## 12. Kill points

*margin tab: what would say stop*

> **A PHASE THAT PASSES ITS EXIT CRITERIA AND RETIRES NO RISK IS A TUNNEL THAT READS UP AND PASSES ZERO PACKETS**

Each kill point is stated as evidence rather than as a feeling, and each names the action. "Stop"
does not always mean abandon; it usually means ship what exists and stop investing.

### 12.1 After phase 0

| Evidence | Action |
|---|---|
| Fewer than **half** the pilot group open the finder unprompted in week 3, with no better explanation than "I forgot it existed" | **Stop.** The wedge is the adoption thesis. If the thing that costs nothing and requires no trust is not used, nothing downstream will be. |
| The golden query set cannot be driven to ≥80% top-3 accuracy without hand-tuning individual queries | **Stop or redesign.** Per-query tuning is overfitting; it does not generalise to platform two. R-VOCAB has not been retired. |
| Measured corpus authoring median exceeds **60 minutes per entry** | **Re-plan, do not stop.** Every content estimate in this document roughly doubles; v1 explainers go from 6–7 to ~12 person-weeks. Decide whether to cut scope (one domain, not three) or cut depth (Tier A only) — and decide it now rather than in phase 5. |
| The single-file artifact cannot be built under ~4 MB with the index in it | **Re-scope, do not stop.** D1 becomes a smaller corpus slice, or the index moves to a lazily-fetched asset in D2 and D1 ships a reduced corpus. Both are ugly and both are survivable. |

### 12.2 After phase 1

| Evidence | Action |
|---|---|
| The emitter cannot reproduce the card's own `set` lines without per-case escape hatches | **Stop and redesign the schema.** The expert's model and our model disagree, and the expert is right by definition here. |
| Provenance coverage cannot reach 100% and an exception list is proposed | **Stop.** Invariant 6 with exceptions is invariant 6 gone within two releases, and the teaching pillar goes with it. |
| No network engineer can author a rule from the spec without a programmer, after two attempts and a spec revision | **Stop and reconsider the condition language.** Rules-as-data that only programmers write is code that pretends to be data, and the corpus economics collapse. |
| B11 (re-emit after one field change) cannot get under ~12 ms | **Re-scope.** Findings-as-you-go becomes findings-on-commit, which is a materially worse product but not a dead one. |

### 12.3 After phase 2

| Evidence | Action |
|---|---|
| Bind rate on real configs from estates we did not write stays below **85%**, with residue that is not obviously dictionary gaps | **Stop.** Paste is the on-ramp; an on-ramp that drops one line in seven produces a graph nobody trusts, and brief §2.2's rot arrives by a different road. |
| Residue is concentrated in *structures* rather than *statements* — configs organised in ways the schema has no shape for | **This is R-SCHEMA arriving early.** Jump to §11.3's reorder and do phase 7 next. |
| Identity resolution cannot hold node IDs stable across re-parses of an evolving config | **Stop.** Unstable IDs invalidate suppressions and rule references on every ingest, which makes findings unusable at exactly the scale where they matter. |

### 12.4 After phase 3

| Evidence | Action |
|---|---|
| No pilot organisation will accept a generated change ticket without rewriting it | **Ship and stop investing.** The tool is a good learning and design instrument and will not be used on production changes. That is a smaller product and it is honest to call it one. |
| Rollback cannot be proven inverse for a meaningful fraction of changes | **Remove the feature.** A rollback that is sometimes wrong is worse than no rollback, because people will paste it during an outage. |

### 12.5 After phase 4

| Evidence | Action |
|---|---|
| Layout cannot be made deterministic without abandoning quality | **Ship drag-only.** `41` §10 open decision 5 already leans this way. Never ship a non-deterministic layout that a change ticket embeds. |
| The diagram is accumulating its own state to be usable | **Stop and re-read brief §4.1.** Either the state belongs in the graph (add it, with provenance) or the feature is out of scope. |

### 12.6 After phase 5

| Evidence | Action |
|---|---|
| The external cryptographic review finds a structural flaw in the zero-knowledge claim, not a fixable bug | **Stop the sync programme.** D1 and D4 remain honest products. A weakened zero-knowledge claim is worse than no sync at all, because the claim is the reason the regulated market is reachable. |
| The CRDT does not converge and no library fits the typed graph either | **Ship single-writer sync with explicit locking.** Multi-writer convergence is a nice-to-have; a wrong merge of a firewall policy is not. |
| B14's TTU can only be met by weakening the KDF | **Accept the slower unlock.** Unlock happens once a session. This is not a real trade. |

### 12.7 After phase 6

| Evidence | Action |
|---|---|
| X6.1 fails — artifacts differ between AI-on and AI-off sessions | **Stop and fix the boundary.** Everything else in this phase is worthless if the model can touch the artifact path. |
| `shadow_rule_rate` shows subagents routinely producing rule-shaped output | **Narrow the subagents or write the rules.** This is A1 working as designed; treat it as information, not as a failure. |
| Tier 0's acceptance suite has been quietly weakened to accommodate an AI-dependent feature | **Revert the feature.** `21` §7.1's rot has started. |
| After a full release cycle, no pilot user can point to a decision the AI layer improved | **Ship tier 0 and stop.** The AI layer is the most expensive optional part of the system and the owner's requirement is satisfied by an architecture that *supports* it, which will exist either way. |

### 12.8 After phase 7 — the real one

| Evidence | Action |
|---|---|
| PAN-OS requires **new node kinds** for site-to-site IPsec | **The schema was Junos-shaped.** Two honest options: (a) redesign the IR with two platforms in view, which is 60–70% of phase 1 repeated, and only worth it if the product's premise is multi-vendor; or (b) reposition as a Junos tool that reads other platforms, and rewrite the marketing to match. Choose deliberately, in writing, with a date. |
| `Representability::Composed` exceeds ~10% of emitted lines | The mapping has judgement in it that the user cannot follow. Either narrow the claim ("Fathom emits Junos; it *reads* PAN-OS") or invest in making composition explicable. |
| Platform-specific conditions appear in rules and the review process keeps approving them | Invariant 5 has failed socially rather than technically. That is harder to fix than a code problem and it needs an owner, not a lint. |

### 12.9 The two global kill points

| Evidence | Action |
|---|---|
| **Corpus rot outruns corpus authoring.** `15` §13.1 estimates re-verification of ~60% of entries per vendor major release. If the team spends more time re-verifying than writing, coverage has stopped growing and the tool ages into being 90% right — which `15` §13 correctly identifies as the worst state, because 90% right is indistinguishable from right until it costs somebody an outage. | Cut platform or domain breadth until authoring outruns rot again. This is a permanent operating constraint, not a one-time decision. |
| **Somebody ships this.** A guided, single-task, client-side configuration builder with inline security reasoning and explanations, open source, actively maintained. | Read their code, contribute, and stop. The gap is the reason to build (brief §3.5). If the gap closes, so does the reason. |

---

## 13. Deferred, and never built

*margin tab: the no-list*

A roadmap without a no-list is a wish. These two tables are as load-bearing as §2.

### 13.1 Never built — permanent product boundaries

Each row is a permanent decision, not a phase-N limitation. If a future document proposes one
of these, it is proposing a different product and should say so.

| Never | Why | Source |
|---|---|---|
| **Any connection to a network device.** No SSH, no NETCONF, no gNMI, no vendor API, no read-only "just to fetch the running config". | Invariant 2. The moment the tool can reach a device it needs device credentials, and invariant 3 goes with it. Copy-paste is the product boundary. | Invariant 2, brief §1 |
| **Storing or accepting any credential** — PSKs, private keys, SNMP communities, TACACS keys, device passwords, enable secrets. | Invariant 3. This removes the highest-value secret from the application entirely and shrinks the threat model more than any cryptographic control (brief §6.2). | Invariant 3 |
| **Telemetry, analytics, crash reporting, font CDNs, update pings.** | Invariant 1. `connect-src` is `'none'` or exactly one configured origin. This is why §3.7 has no adoption metric, and that cost is accepted. | Invariant 1 |
| **A server that can read a workspace.** No server-side lint, no server-side emit, no server-side search. | Invariant 4, `41` §5.5. `fathom-sync` never links the graph, rules, emit or parse crates, and the linker enforces it. | Invariant 4 |
| **Per-vendor rule engines.** | Invariant 5. One engine, rules carry `platforms`. N × M grows linearly or the corpus becomes unmaintainable. | Invariant 5 |
| **A fourth risk value.** | Three: `ReadOnly`, `ChangesConfig`, `Disruptive`. The card holds this line across four sides and it is the single most disciplined thing in the design language. | Conventions, design language |
| **Personalised or learned ranking.** | `16` §1.1. Two engineers on the same corpus version must get the same list, which is what makes a result shareable in a change ticket. Per-user ranking is a silent violation of invariant 9. | `16` §1.1 |
| **Model output in the corpus without a named human reviewer.** | Invariant 10. The build fails on the literal string `<named human>`. | Invariant 10 |
| **"Apply this fix for me."** | Follows from invariant 2. The tool produces text; a human decides and pastes. There is no auto-remediation and no push. | Invariant 2 |
| **A plugin system that executes third-party code in the application.** | It would defeat the CSP, the supply-chain story and the reproducibility claim in one move. Rule packs and corpus entries are **data**, signed and versioned; that is the extension mechanism. | `35`, invariant 5 |
| **The diagram as a source of truth.** | Brief §6.5. Claiming it records what exists invites the rot of §2.2. It is a design tool and a view. | Brief §6.5 |
| **Replay of AI sessions.** | `21` §9.6. Replay implies a reproducibility guarantee the layer does not have and should not claim. | `21` §9.6 |
| **A hosted multi-tenant SaaS that holds plaintext.** | It is the product the security posture exists to not be. | Brief §1, §7 |

### 13.2 Deferred — with the trigger that un-defers it

| Deferred | Trigger to reconsider |
|---|---|
| **Domains beyond IPsec** (BGP, OSPF, QoS, NAT, high availability, switching) | After phase 7. Domain two on two platforms is a better next investment than platform three on one domain, because it tests the schema on a second axis. |
| **Platforms three and four** (`ios-xe`, then `fortios`) | After phase 7's exit criteria pass. IOS-XE third for its ordering constraints; FortiOS fourth on commercial demand. |
| **Fleet-scale storage** (Postgres-backed inventory, server-side querying) | Brief §6.4 states the trade honestly: the document model loses fleet-scale querying and native multi-writer concurrency. Trigger: a real workspace exceeding ~2,000 devices with genuine concurrent editing. Below that, `17` §13's budgets hold and the trade is good. |
| **Multi-writer beyond 32 members per workspace** | `43` §2.1's current ceiling. Trigger: an actual team that hits it. |
| **Mobile / tablet** | The interaction model is a keyboard and a clipboard. Trigger: evidence that the finder specifically is wanted on a phone during an incident, which is plausible and would be a *separate*, read-only artifact. |
| **Real-time collaborative editing** (live cursors, presence) | The CRDT makes it possible; nothing in the workflow asks for it. Trigger: users reporting merge friction that async sync does not solve. |
| **A rule-pack marketplace** | Trigger: third parties actually writing packs. Signing and distribution already exist (`12` §13); a marketplace is a governance problem, not a technical one, and it should not be solved speculatively. |
| **SNMP/LLDP discovery** | Would require touching the network. Permanently blocked by invariant 2 in-product; the only legitimate form is a **separate** tool that emits a paste-able file. Trigger: someone building that tool, not us. |
| **Automatic corpus generation from vendor documentation** | Invariant 10 permits it only with a named human reviewer per entry, which removes most of the saving. Trigger: a measured demonstration that review-only is materially faster than author-plus-review. |
| **Full independent-rebuild attestation** (phase 0.1) | Gated *before* the first public download, not after. Deferred within phase 0 only, and it is the one deferral here with a hard deadline. |
| **Distance-2 fuzzy matching in the finder** | `16` §6.3. Trigger: measurement showing precision holds at distance 2 on a real corpus. |

---

## 14. Estimate methodology, and what would move every number

*margin tab: approx*

> **EVERY NUMBER BELOW IS A PLANNING ASSUMPTION, NOT A MEASUREMENT**

### 14.1 The assumptions

| Assumption | Value | Confidence |
|---|---|---|
| Tested, specified systems Rust, including its tests and its review | **150–250 lines/day** | Low. This is the assumption the whole document rests on. <!-- VERIFY: measure the actual rate over phase 0's first four weeks and rewrite every effort table in this document with the real figure. Do not re-argue the estimate; replace the input. --> |
| TypeScript UI without a framework, including the render layer | 200–350 lines/day | Low, same reason |
| Corpus entry, Tier A explainer: author + technical review + voice review | 35 min | `15` §12.6's own assumption, itself marked VERIFY |
| Command corpus entry | 30–45 min | `61` §20 |
| Statement dictionary entry | ~10 min including review | Derived from `14` §6.5's scale, not measured |
| Rule with two fixtures | 60–90 min | Derived from `12` §15 |
| Integration and rework overhead across a phase boundary | +15–20% | Judgement |

### 14.2 What is excluded from every number

Hiring, onboarding, sales, support, marketing, legal, packaging for distribution channels,
writing documentation beyond this corpus, community management, and the conformance lab's
hardware. Also excluded: the standing AI evaluation programme from phase 6b onward (~20
rater-hours per release, `25`).

### 14.3 Why "team of three" is not "solo ÷ 3"

| Factor | Effect |
|---|---|
| The corpus track is a **different person** | Large positive. It is 25–40% of most phases and it fully parallelises. This is where most of the team's advantage comes from, not from splitting the code. |
| The core crate chain is serial | `fathom-graph` → `fathom-rules` → `fathom-emit` is one person's critical path in phase 1. A second engineer on it slows it down. |
| The WASM/TS boundary is a real integration surface | Two languages, two test harnesses, one boundary (`41` §9.1). Costs 10–15% of a team phase that a solo builder does not pay. |
| Review is a cost and a benefit | Slower per-PR, materially fewer redesigns. Net roughly neutral on schedule and strongly positive on the exit criteria that matter. |
| Bus factor | `41` §9.1 names it: a small hiring intersection and a real bus factor, permanently. Three people is the minimum that survives one person leaving. |

Empirically the ratio lands near **1.9–2.1×**, not 3×, which is what §2's totals reflect.

### 14.4 The three things most likely to make every number wrong

1. **The corpus median.** It appears in every phase, it is the largest single line item, and
   `15` §12.6 flags its own uncertainty. If 25 minutes is really 45, the project is ~20%
   longer overall and the content-heavy phases are ~60% longer.
2. **Real configurations.** Phase 2's 95% bind rate is a target derived from nothing. The
   first three real configs will move it in one direction or the other by a lot.
3. **The schema.** Phase 7's contingency is 4–8 weeks. If it is 6 months, §12.8 applies and
   the totals in §2 are not the relevant numbers any more.

---

## 15. Staffing, the critical path, and the corpus track

### 15.1 The three roles

| Role | Does | Cannot be shared |
|---|---|---|
| **E1 — core** | `fathom-graph`, `-rules`, `-emit`, `-parse`, `-find`, `-ops`. The serial critical path through phases 0–2. | The graph → rules → emit chain |
| **E2 — boundary** | UI, the render layer, `xtask`, the build, the WASM ABI, deployment. | The build's reproducibility work |
| **D1 — domain, 0.6 FTE** | Corpus authoring and review, rule authoring, the conformance lab, the pilot relationship. | Anything requiring a real SRX in front of them |

**D1 is the scarcest resource and the least substitutable.** A senior network engineer who can
write in the field card's voice, has hardware, and is willing to spend hours on YAML is rare.
Every phase's content estimate assumes D1 exists and is not also doing three other jobs. If
D1 is 0.2 FTE rather than 0.6, the content-bound phases (0, 1, 2, 7) roughly double and no
amount of engineering changes that.

Phase 5 additionally requires **bought-in cryptographic review** — 2–4 weeks elapsed, mostly
waiting, plus rework. Budget it as a calendar item, not a staffing item.

### 15.2 The critical path

```
P0 fathom-find ──► P1 fathom-graph ──► P1 fathom-rules ──► P2 fathom-parse
                                   └──► P1 fathom-emit ──► P3 config diff
                                                        └► P7 panos emitter
```

Everything on that line is E1. Everything off it can be parallelised or bought. The single
highest-leverage scheduling decision in the project is **whether E1 ever gets pulled off that
path** to do UI work, deployment work or corpus work. They should not be.

### 15.3 The corpus track is not a phase

`15` §12.5's P0 reference set — 50 entries by the voice owner, spanning all 13 classes,
one week of one person doing nothing else — **must exist before any other corpus work
starts.** It is the specification that prose cannot be. Skipping it produces 400 entries in
five voices that then have to be rewritten.

After that the track runs continuously and never finishes. Its cadence is set by rot (`15`
§13.1) as much as by growth, and §12.9's first global kill point is the moment rot wins.

---

## 16. Open decisions

| # | Question | Current lean | Blocked on |
|---|---|---|---|
| 1 | Does the two-week spike (§3.2) happen, and who sees it? | Yes, 8–12 engineers, at least 3 outside the project | The owner's willingness to show something deliberately crude |
| 2 | Phase 6 before phase 7, or after? | Before, as written, but §11.3's swap is live | Phase 2's real bind rate and whether phases 1–3 needed any platform escape hatch |
| 3 | Does the CLI really ship in phase 0? | Yes — R-DETERM has no other instrument | Nothing. This is a scoping call and it is made in §3.3 |
| 4 | Full reproducible-build attestation before or after the first public download? | Before. Phase 0.1, hard gate | Capacity |
| 5 | Is phase 4's diagram drag-only at first? | Yes if phase 4 is running long; `41` §10 open decision 5 already leans this way | Phase 4's start date |
| 6 | Does phase 5's CRDT stay hand-rolled? | Decide at week 4 of phase 5 against `33` §4.2's exit criterion, not at week 12 | Measurement |
| 7 | Is there a phase 8 (second domain) or does the project stabilise at one domain × two platforms? | Second domain, two platforms, because it tests the schema on the other axis | Phase 7's outcome |
| 8 | What is the first public release — phase 0, or phase 0 + 1? | Phase 0 alone. It is the only artifact that requires nothing of the user | The owner's appetite for shipping something small |

---

## 17. Sources consulted

| Claim | Source |
|---|---|
| Corpus authoring rates, phasing, and the rot model | `docs/10-core/15-explainer-corpus.md` §§12.5, 12.6, 13.1 |
| Command entry authoring cost (~30–45 min) | `docs/60-content/61-command-corpus-spec.md` §20 |
| Dictionary scale (~2,000 entries per platform) | `docs/10-core/14-parsers-and-ingest.md` §§6.5, 15 |
| First-party line counts (finder, rules, CRDT, layout, parsers) | `docs/40-stack/41-technology-choices.md` §9.2 |
| All B-numbered latency and size budgets | `docs/40-stack/44-performance-budgets.md` §3 |
| Test counts and CI wall clock | `docs/40-stack/45-testing-strategy.md` §2 |
| Deployment artifacts D1–D4 and their properties | `docs/40-stack/43-deployment-modes.md` §2.1 |
| AI tiers, subagent catalogue, admission criteria A1–A5, reproducibility check | `docs/20-ai/21-ai-layer-architecture.md` §§5, 7, 9.5 |
| Vendor divergence, the absence-encoding trap, the four renderings | `docs/10-core/13-emitters-and-provenance.md` §8 |
| PAN-OS `no-pfs` reuses the phase 1 key for IPsec SA negotiation | [Palo Alto Networks, *Define IPSec Crypto Profiles*](https://docs.paloaltonetworks.com/network-security/ipsec-vpn/administration/set-up-site-to-site-vpn/define-cryptographic-profiles/define-ipsec-crypto-profiles) |
| IOS-XE VTI traffic selector is always `IP any any`; VTIs do not support narrowing | [Cisco, *IPsec Virtual Tunnel Interfaces*, IOS XE 17.x](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/sec-vpn/b-security-vpn/m_sec-ipsec-virt-tunnl-0.html) |
| Every command, failure mode, and worked example in the phase mock-ups | `.context/field-card-srx-ipsec.txt`, sides 1–4 |
| PFS rationale, the "IKE looks fine but the tunnel keeps dropping" symptom | Field card side 2, *PERFECT FORWARD SECRECY*; RFC 7296 §1.3.2 as cited in brief §5.2 |

<!-- VERIFY: the field card's own `set` lines are the phase-1 golden fixture (X1.1). Before that
     fixture is frozen, the card's author should confirm each line against a current Junos release,
     because the fixture becomes the oracle and an error in it becomes an error the emitter is
     required to reproduce. -->

---

## 18. Disagreements

**1. "A few days of work" (brief §6.1).**

The convention is to obey the brief and state the objection here. The brief's *strategic*
claim about the finder is adopted wholesale and is the spine of this roadmap: it is the wedge,
it requires no crypto, no server and no graph, and it is what people open ten times a day. The
*effort* claim is not adopted. Phase 0 is estimated at 12–18 weeks solo and 6–9 with a team,
with the decomposition in §3.9.

The disagreement is narrow and it is with the estimate only. "A few days" is achievable for a
version with substring matching, no index, no determinism guarantee, no verifiable build and
the existing unreviewed seed corpus — and §3.2 recommends building exactly that, as a
deliberate two-week throwaway, because it answers the content question at negligible cost.
What it does not do is close the vocabulary gap, which is the reason the feature exists.

**2. Terminology.** The assignment brief for this document says "a second vendor". The binding
convention reserves **platform** for a vendor+family target and notes that a vendor has many
platforms. This document therefore says *the second platform* (`panos`) throughout. No
substantive disagreement; recording the substitution so it is not read as drift.

**3. No disagreement with any hard invariant or with the risk enum.** §13.1 enumerates the
invariants as permanent product boundaries rather than as constraints to be managed, which is
how they are treated throughout.
