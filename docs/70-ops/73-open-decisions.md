# 73 — Open decisions: every fork that must be answered before code is written

> **Status:** Proposed — **§§5–8's ranking is stale**; see the banner below

> **The ranking is denominated in phases, and the phases are being retired.** Ranks A and B are
> event-denominated and stand. Ranks C–F (*"before phase 1 exits"*, *"phases 4 and 5"*, *"phase 6"*,
> *"phase 7"*) are not, and §6's margin tab *"what v1 does not need"* is falsified outright by
> ADR-0031 (Proposed). The ranking does not merely go stale — it **inverts**: ranks C–F existed to
> say *"these can safely wait"*, and their contents now move toward Rank A. Re-anchoring them onto
> events is planning work, named in ADR-0031 §5, and it needs an ordering principle this document
> does not yet have. Until then, treat every rank below B as unranked rather than as deferred.

Companion documents: this register does not re-specify anything. Every decision below names the
document that carries its detail. The ones that carry the most are
`docs/10-core/11-ir-schema.md` (D05), `docs/10-core/12-rule-engine.md` (D06),
`docs/40-stack/43-deployment-modes.md` (D07), `docs/40-stack/41-technology-choices.md` (D08),
`docs/30-security/32-cryptography.md` (D15), `docs/30-security/33-sync-protocol.md` (D18–D19),
`docs/20-ai/21-ai-layer-architecture.md` and `docs/20-ai/24-ai-determinism-and-offline.md`
(D21–D22), `docs/70-ops/71-roadmap.md` (D02, D23), and
`docs/10-core/15-explainer-corpus.md` §13.5 (D10).

---

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | How to read this, and the two scales it uses | *read this first* |
| 2 | The register — every open fork, ranked by when it must be answered | *the whole document in one table* |
| 3 | Rank A — before the first commit (D01–D08) | *the expensive eight* |
| 4 | Rank B — before the corpus track scales (D09–D14) | *content is the long pole* |
| 5 | Rank C — before phase 1 exits (D15–D16) | *the format is a promise* |
| 6 | Rank D — phases 4 and 5 (D17–D20) | *what v1 does not need* |
| 7 | Rank E — phase 6 (D21–D22) | *build the cage first* |
| 8 | Rank F — phase 7 (D23) | *the entire bet* |
| 9 | Closed — decisions this register does not reopen | *the no-list* |
| 10 | How to answer one, and where the answer lives | *the record* |
| 11 | The decisions that are secretly one decision | *coupling* |
| 12 | Sources | |
| 13 | Disagreements | |
| 14 | Escalations from execution sessions | *the inbox (`78` §4)* |

---

## 1. How to read this, and the two scales it uses

*margin tab: read this first*

> **A DECISION NOT WRITTEN DOWN IS A DECISION MADE BY WHOEVER TYPES FIRST**

### 1.1 The owner's convention, applied strictly

Brief §"How to read this document":

> *"Anything marked **DECISION** is a fork that needs an answer before implementation and is
> expensive to change later. Anything marked **RECOMMENDATION** is my opinion and you should feel
> free to overrule it."*

This document is the complete register of both. Where a sibling document has already argued a fork
to a conclusion, that conclusion appears here as the **current lean**, with a pointer, and the fork
is still presented as a fork — because a decision recorded only as a conclusion inside a 3,000-line
specification is not a decision anyone can revisit. The whole point of a register is that the
options survive alongside the answer.

Nothing here is binding until it is recorded per §10. A lean is not an answer.

### 1.2 Scale one — the reversal cost, R0 to R5

Every fork below carries an `R` value. This is the only number in the document that is not an
estimate of effort; it is a statement of *what kind of thing* the reversal is.

| | Reversal is | Concretely | Who has to agree |
|---|---|---|---|
| **R0** | a setting | Change a default, ship it | Nobody |
| **R1** | a change in one crate | Under a week, no data touched, no corpus touched | The author |
| **R2** | a change across crates | 2–6 weeks, no data migration, some corpus re-review | The team |
| **R3** | a **data migration** | Every workspace a user already holds must be rewritten by a migration path that has to be correct on the first attempt, because the input is the only copy | Every user, implicitly, by running the migration |
| **R4** | a **rewrite** | Two or more crates redesigned, a data migration, and corpus re-authoring measured in hundreds of hours | The team, plus whoever authored the corpus |
| **R5** | **not reversible without other people's consent** | Contributors' copyright, published bytes, a name a customer has in a procurement record, a promise in a contract | People who are not in the room |

R5 is the one that catches projects out. Three of the eight Rank A decisions are R5, and none of
them are technical.

### 1.3 Scale two — the latest responsible moment

Each fork names the last point at which it can be deferred without paying more than its stated `R`.
This is a *trigger*, not a date: "before `fathom-graph`'s first commit", "before the repository is
public", "before a workspace exists that a user would be upset to lose".

Deferring past the trigger is allowed. It is just no longer the same decision — it becomes the
decision plus its migration.

### 1.4 The shape of every section below

| Field | What it says |
|---|---|
| **The fork** | The question, stated so that a yes/no or a pick-one answers it |
| **Why it is expensive to reverse** | The mechanism, not the feeling |
| **Options** | A table with the real trade-off, including the cost of the option being recommended |
| **Lean** | Marked `DECISION —` or `RECOMMENDATION —` per the owner's convention |
| **Evidence that would change it** | Written before the fact, so it counts when it arrives |
| **Latest responsible moment** | The trigger |
| **Blast radius if reversed later** | What breaks, named by crate, document, artifact or person |

Side 4 of the field card, on how to debug a tunnel: *"Correlate before you theorise."* The same
applies here. Every "evidence that would change it" row is a correlation to look for, written down
in advance so that finding it is a fact rather than an argument.

---

## 2. The register

*margin tab: the whole document in one table*

Ranked by the latest responsible moment. Within a rank, ordered by reversal cost, highest first.

| # | Fork | Kind | R | Latest responsible moment | Current lean | Detail in |
|---|---|---|---|---|---|---|
| **D01** | Is this a business or a tool? | DECISION | R5 | Before D03 is answered | Tool first, licensed so a business stays possible | §3.1 |
| **D02** | What is v1? | DECISION | R5 | Before anything is published under the name | Phase 0 alone | §3.2, `71` §2 |
| **D03** | The licence — core, corpus, sync service, rule packs | DECISION | R5 | The first public commit | Apache-2.0 core / AGPL-3.0 sync / CC BY-SA 4.0 corpus | §3.3, `36` Q50 |
| **D04** | The name, and the identifier namespace it enters | DECISION | R3 (R5 once published) | Before the ID prefix is written into a file format | Rename; decouple the ID namespace from the name today | §3.4 |
| **D05** | IR shape: property graph, typed document tree, or relational-in-memory — and are edges first-class? | DECISION | R4 | `fathom-graph`'s first commit | Property graph, first-class typed edges | §3.5, `11` §3.2 |
| **D06** | The rule condition language, under the sandboxing constraint | DECISION | R4 | Before the rule-pack format is signed and published | `fex` — an owned subset of CEL's syntax | §3.6, `12` §3 |
| **D07** | Offline mode: single HTML file, static directory, or desktop app | DECISION | R2 | Phase 0's artifact definition | Single file **and** served directory; no desktop app in v1 | §3.7, `43` §3 |
| **D08** | Does TypeScript exist at all? | DECISION | R2 | Before the UI is more than ~500 lines | Yes, vanilla TS over a first-party render layer | §3.8, `41` §4 |
| **D09** | Does the conformance lab exist, and who runs it? | DECISION | R2 | Before the first corpus entry is published as reference | Yes — two physical boxes, not a simulator | §4.1 |
| **D10** | Community corpus contributions: accepted, and in what form? | DECISION | R5 | Before the repository is public | Gap reports, corrections, `misdiagnosed_as`; never open entry PRs | §4.2, `15` §13.5 |
| **D11** | Third-party rule packs, and the trust root | DECISION | R3 | Before the pack signature envelope is frozen | First-party only in v1; pinned publishers later | §4.3 |
| **D12** | Is development in the open from day one? | DECISION | R5 | The first push | Public at phase 0's release, with full history | §4.4 |
| **D13** | Does the CLI ship in phase 0? | RECOMMENDATION | R1 | Phase 0 scoping | Yes | §4.5, `71` §3.3 |
| **D14** | Who owns the corpus voice, and what happens when they leave? | DECISION | R4 | Before entry 51 is authored | One named owner, a 50-entry reference set that is the spec | §4.6, `15` §12.5 |
| **D15** | Encryption granularity: whole-workspace, per-record, per-op, or sharded | DECISION | R3 | Before a workspace exists that a user would be upset to lose | Sharded, `S_nodes = 64` | §5.1, `32` §6.2 |
| **D16** | When does the workspace format become a compatibility promise? | DECISION | R5 | The release that first writes a workspace users keep | At phase 1's release, with a written migration policy | §5.2 |
| **D17** | Is the diagram in v1? | RECOMMENDATION | R1 | Phase 4's start | No, and its absence costs almost nothing | §6.1, `56` §3.4 |
| **D18** | Does v1 have multi-writer sync at all? | DECISION | R2 | Phase 5's start | No. File plus git. Single-writer with a lock in v2 | §6.2 |
| **D19** | The CRDT: hand-rolled, Automerge, Yjs, or Loro | DECISION | R3 | Week 4 of phase 5 | Hand-rolled, with Loro as the named fallback | §6.3, `33` §4.3 |
| **D20** | Do we operate a hosted sync service? | DECISION | R5 | Before the first customer conversation about hosting | No. Self-host only | §6.4 |
| **D21** | Does the AI layer ship in v1, and which tier is default? | DECISION | R2 | Phase 6a's start | The boundary ships; no model ships; tier 0 is default forever | §7.1, `21` §7 |
| **D22** | Is the localhost inference sidecar permitted, and in which shape? | DECISION | R2 | Phase 6b's start | Not in v1; native shell (shape C) when it is | §7.2, `24` §3.7 |
| **D23** | The second platform, and when | DECISION | R4 | Before phase 6 starts | PAN-OS, with a read-only ingest spike pulled forward into phase 2 | §8.1, `71` §10.2 |

**Read the R column before reading anything else.** Four decisions are R5 — irreversible without
somebody else's agreement — and all four (D01, D02, D03, D10, D12, D16, D20; seven, counting the
later ones) are non-technical. The engineering forks are R2 to R4 and every one of them has a named
migration. The forks that can actually trap this project are about licence, name, publication and
promises.

---

## 3. Rank A — before the first commit

*margin tab: the expensive eight*

> **THESE EIGHT ARE ANSWERED BY DEFAULT ON THE DAY THE FIRST FILE IS WRITTEN. ANSWER THEM ON PURPOSE INSTEAD**

### 3.1 D01 — Is this a business or a tool?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R5 — it constrains D03, and D03 needs other people's consent to undo |
| **Latest responsible moment** | Before D03. The licence is the mechanism by which this decision becomes irreversible |
| **Current lean** | Tool first, licensed so that a business remains possible |
| **Detail in** | `36` Q50, Q51; `37` §4–§5; `71` §10.2's commercial counter-argument |

**The fork.** Is Fathom a thing the owner builds because it should exist, or a thing that has to
generate revenue? The two produce different roadmaps, different second platforms, different default
AI tiers and different licences.

**Why it is expensive to reverse.** Not because the code differs — because the *licence* differs,
and a licence with third-party contributions in it cannot be changed without every contributor's
consent. Going from "tool" to "business" later is possible only if the licensing was set up for it
on day one. Going from "business" to "tool" is easy and loses money already spent.

**The constraint that makes this fork unusual, and it should be read before the options table:**

> **The architecture makes a usage-metered business impossible, permanently.** Invariant 1 forbids
> egress. `36` Q51 states, as a selling point, that there is *"no licence check, no activation, no
> phone-home, and no server in the read path"*, and calls the resulting property *"no hostage-taking
> is possible by construction"*. Every one of those sentences is also a sentence about revenue.
> There is no seat count we can observe, no usage we can meter, no feature we can remotely disable,
> and no way to tell a paying customer from a non-paying one. Any commercial model here is
> **contractual, not technical** — support, hosting, an operator policy file, an indemnity, a
> signature on a questionnaire.

That is not a reason to reject a business. It is a reason to reject three of the five obvious ones.

**Options.**

| | Shape | What it can charge for | What it costs | Roadmap consequence |
|---|---|---|---|---|
| **A** | **Tool.** No revenue, no support obligation, no roadmap promise | Nothing | The corpus is unfunded, and the corpus is 25–40% of every phase (`71` §14.3). `D1`-the-domain-engineer works for free or does not work | `71` as written: PAN-OS second, R-SCHEMA first, AI last |
| **B** | **Sponsored.** Donations, GitHub Sponsors, a grant | Nothing, formally | Sponsorship at this scale funds hosting, not a person. Realistically the same as A with a small offset | Same as A |
| **C** | **Open core.** Free client, paid sync/enterprise | Sync (D2/D3), the tier-3 operator policy file, SSO, audit export | **The client is the product and it is free and offline.** What is left to withhold is the part nobody wants until they have twenty engineers. Open core here is a business built on the least valuable 10% of the system | Phase 5 moves ahead of phases 2–4; the diagram moves earlier (it demos); tier 1 AI moves earlier (it demos) |
| **D** | **Dual licence.** AGPL-3.0 plus a commercial exception | The exception, to anyone who wants to ship a modified client or service without reciprocity | Requires a CLA or copyright assignment, which reduces contribution. Works for services; the client is offline, so AGPL's teeth are §13's network clause and there is no network | Same as C, plus the CLA overhead from commit one |
| **E** | **Services.** Fully open product, paid work around it | Training, corpus authoring for a customer's own platforms, the enterprise review (`36`), security questionnaires, deployment | Non-scaling. It is consulting with a good business card. It is also the only model on this list that the architecture does not fight | Roughly A's order, with `36`-shaped work pulled forward whenever a customer appears |
| **F** | **Source-available product.** BUSL-1.1 or similar | The product | Costs the credibility the entire security posture is built on. See D03 | Irrelevant — F changes the project's premise, not its order |

**RECOMMENDATION — A now, structured so that D or E stays available.**

Three reasons, in the order they decided it:

1. **The wedge is free by construction.** Phase 0 is a command finder that requires nothing of the
   user — no account, no data, no trust (`71` §3.1). There is no version of that which is also a
   paid product, and it is the only artifact in the plan that reaches a stranger.
2. **C is the model the architecture is worst at.** Everything valuable runs on the user's machine
   and is designed to keep working when we disappear. That is the pitch. Charging for the residue is
   a business that argues with its own product page.
3. **E is compatible with everything and requires no decision now.** Consulting around an open tool
   needs no licence change, no CLA and no roadmap change. It is the option that stays open for free.

**The one thing to do now, whichever way this lands:** decide the **contribution instrument**. A DCO
(sign-off, contributor keeps copyright) makes D impossible later without re-collecting consent. A
CLA (contributor grants the project the right to relicense) makes D possible and measurably reduces
drive-by contributions. Given D10's recommendation — that the project does not want drive-by content
contributions anyway — the CLA's cost here is lower than usual.

**Evidence that would change this.**

| Signal | Move to |
|---|---|
| Someone offers money before phase 3 ends, for something other than support | E, then possibly C |
| The corpus track stalls because the domain engineer cannot spend 0.6 FTE unpaid (`71` §15.1 names them the scarcest resource) | Whichever model funds that one person. This is the single most likely cause of the project failing, and it is a funding problem, not an engineering one |
| A regulated customer requires a support contract with an SLA before they can deploy anything | E |
| A third party ships a hosted, modified Fathom and contributes nothing | D, if the licence permitted the move; otherwise nothing, which is the point of deciding now |

**Blast radius if reversed later.** Relicensing needs every contributor's written consent, or the
removal and rewrite of their contributions. If the corpus took outside entries under D10, it needs
those authors' consent too — and prose contributors are harder to reach two years later than code
contributors, because there is no commit email discipline in a YAML PR from a network engineer.

---

### 3.2 D02 — What is v1?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R5 — a published version number and a product description are a promise |
| **Latest responsible moment** | Before anything is published under the project's name |
| **Current lean** | Phase 0 alone |
| **Detail in** | `71` §2, §12.1 |

**The fork.** "In v1" appears in five other decisions in this register (D17, D18, D20, D21, D22),
and none of them can be answered until "v1" means something. `71` §2 gives five coherent stopping
points:

| v1 = | Solo | Team of 3 | What a user can do | What the product description may claim |
|---|---|---|---|---|
| **Phase 0** | 12–18 wk | 6–9 wk | Find the command they cannot name, offline, deterministically, with what to read in the output and what to run next if it is bad | A command reference that closes the vocabulary gap. **Nothing about a graph** |
| **0+1** | 36–52 wk | 18–26 wk | The above, plus build a site-to-site IPsec tunnel through a guided walkthrough and get validated config with provenance | Two pillars: validate and teach |
| **0+1+2+3** | 58–84 wk | 29–43 wk | The above, plus paste a real config, get a populated graph, findings, a diff, a verify ladder and a rollback | All three pillars. This is the brief's product |
| **through 5** | 74–108 wk | 37–55 wk | The above, plus an encrypted workspace and team sync | The brief's product plus the security posture |
| **everything** | 106–158 wk | 53–79 wk | The above, plus the AI layer and PAN-OS | The brief |

**Why it is expensive to reverse.** A version number is a claim about completeness. Shipping "v1"
against a product description that promises six views and delivering one is the specific failure
that makes the teaching pillar unbelievable — and the teaching pillar is what `71` §4.2 identifies
as the thing that makes the other two adoptable. You cannot re-earn that with a v1.1.

**RECOMMENDATION — v1 is phase 0 alone, published under its own honest description, and the number
does not matter.**

Reasoning:

1. `71` §12.1's first kill point tests the entire adoption thesis on phase 0 alone. If fewer than
   half a pilot group open the finder unprompted in week 3, nothing downstream matters. Shipping it
   as v1 is how that test runs.
2. Every later decision in this register gets cheaper when v1 is small. "Is the diagram in v1" and
   "does v1 have multi-writer sync" both answer themselves.
3. Phase 0 is the only artifact in the plan that requires nothing of the user (`71` §3.1, principle
   O1). Its release is not a product launch; it is a piece of reference material that happens to be
   software.

**The trap to avoid, stated plainly:** do not call phase 0 "v1 of Fathom, a network engineering
platform". Call it what it is. `71` §12.1's honest framing survives contact with users; a roadmap on
the download page does not.

**Evidence that would change this.** If phase 0's pilot reports come back saying the finder is
useful *only* when a workspace is open — that is, the context-awareness upgrade in brief §6.1 is
the whole value and the standalone lookup is not — then v1 is 0+1 and the standalone release is a
beta.

**Blast radius if reversed later.** Almost none technically. Entirely reputational, and asymmetric:
shipping less than promised is expensive, shipping more than promised is free.

---

### 3.3 D03 — The licence

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R5 |
| **Latest responsible moment** | The first public commit. After that, every contributor is a veto |
| **Current lean** | Apache-2.0 core and CLI; AGPL-3.0 sync service; CC BY-SA 4.0 corpus; first-party rule packs under the corpus licence |
| **Detail in** | `36` Q50, Q51, Q64; `35` §1.1's rebuild claim |

**The fork.** This is genuinely load-bearing rather than administrative, for one reason: the
product's entire security argument is *"you can rebuild this yourself and get the same bytes"*
(`35` §1.1) and *"you can fork it if we disappear"* (`36` Q64). Both are licence properties, not
engineering properties. A licence that permits reading but not continuing turns a verifiable
artifact into a demonstrable one, which is a weaker word than it looks.

It is four decisions, not one, and they have different answers.

**Part 1 — the core (`fathom-core`, the crates, the WASM, the UI, the CLI).**

| Licence | Auditable? | Forkable if we vanish? | Patent grant | Enterprise procurement | What it prevents |
|---|---|---|---|---|---|
| **MIT** | yes | yes | **no express grant** | universally accepted | Nothing. A vendor may take the client, close it, and sell it |
| **Apache-2.0** | yes | yes | **yes, §3, with termination on patent litigation** | universally accepted | Same as MIT, plus patent aggression is self-terminating |
| **MPL-2.0** | yes | yes | yes | accepted | File-level copyleft. A proprietary product may embed it; modifications to our files come back |
| **GPL-3.0** | yes | yes | yes, §11 | mixed; blocks embedding in proprietary products | Proprietary forks of the client |
| **AGPL-3.0** | yes | yes | yes, §11 | **contested — several large organisations publish policies prohibiting AGPL dependencies** <!-- VERIFY: confirm the current text of Google's open source policy on AGPL, and check whether the AGPL entries on other published corporate policy lists still stand, before this row is used in an argument with a customer's legal team. --> | Proprietary forks, **and** hosted proprietary services — §13 requires Corresponding Source be offered to remote users |
| **BUSL-1.1** | yes, source-available | **no, until the Change Date** — typically 3–4 years, after which it converts to a stated open licence | per the converted licence | treated as proprietary; excluded from most distributions' packaging policies | Competing commercial use during the term |
| **FSL / PolyForm / Elastic-2.0** | yes, source-available | **no** | varies | treated as proprietary | Competing commercial use |

Two observations decide it.

**Observation one: copyleft has almost nothing to bite on here.** AGPL-3.0 §13's network clause is
about software a user interacts with *remotely*. The Fathom client runs on the user's machine, in
their browser, with `connect-src 'none'`. There is no remote interaction to trigger §13. AGPL on the
client is therefore approximately GPL-3.0 with extra procurement friction — it buys protection
against a proprietary fork of the client, and it pays for that with the deny-lists.

**Observation two: the security posture argues for the widest possible re-use of the core.** `35`'s
reproducible-build programme wants third-party rebuilders. `36` Q64 wants a credible fork story for
a customer's risk register. `31`'s threat model is public on purpose. A licence that makes an
independent implementation of the workspace format awkward works against every one of those. Note
that `36` Q51 already promises *"the CLI reads it, and so would any independent implementation of
the spec"* — that sentence is a licence commitment written in a security document.

**Part 2 — the sync service (`fathom-sync`).** This is where §13 has teeth, because it is a service
by definition. `41` §5.5 already establishes that `fathom-sync` never links the graph, rules, emit
or parse crates, so a different licence on it is architecturally clean rather than a boundary we
would have to invent. Apache-2.0 is one-way compatible into AGPL-3.0, which is exactly the direction
needed: core flows into the service, never the reverse.

**Part 3 — the corpus.** It is authored prose with a named human reviewer per entry (invariant 10),
not code. Applying a software licence to it is a category error that shows up the first time someone
asks whether `acceptable_when` is "source".

| Corpus licence | Effect |
|---|---|
| Same as code | Legally workable, semantically wrong, and it makes a mixed repository's licence header story confusing |
| **CC BY 4.0** | Anyone may repackage the corpus, in any voice, in any product, with attribution |
| **CC BY-SA 4.0** | Repackaging is permitted; derived corpora must carry the same licence. Attribution required. One-way compatible with GPL-3.0 for combined works |
| Proprietary corpus, open code | The honest open-core split — the engine is free, the knowledge is not. It is also the split that most directly contradicts the teaching pillar |

**Part 4 — rule packs.** First-party packs are corpus. Third-party packs need no licence from us at
all, because a pack is data consumed by an interpreter (`12` §3.3). That is worth stating explicitly
in the licence file, because the first question a third-party publisher asks is whether writing a
pack makes their pack a derivative work.

**RECOMMENDATION — Apache-2.0 for the core, the UI and the CLI; AGPL-3.0 for `fathom-sync`;
CC BY-SA 4.0 for `corpus/`; an explicit statement that rule packs and workspaces are not derivative
works.** This matches `36` Q50's existing recommendation, which was written from the enterprise
review's side and arrives at the same place from a different direction.

The reasoning that decided it, rather than the reasoning that supports it:

1. **Apache-2.0's patent grant is worth more here than copyleft's protection.** The buyers this
   product is aimed at — defence, OT, regulated — read licences with a patent lens. `36`'s whole
   register is about being easy to say yes to.
2. **The thing worth protecting from repackaging is the corpus, not the code.** The code is
   ~11,000–13,000 lines of first-party infrastructure (`41` §9.2) that nobody wants in isolation.
   The corpus is the product and it is the part a competitor would actually lift. Share-alike belongs
   on the corpus, and CC BY-SA puts it there.
3. **AGPL on the service costs nothing** because we do not intend to operate one (D20) and because
   `41` §5.5 already isolated it.

**The cost, stated.** Apache-2.0 on the core means a vendor may take the client, close it, add a
telemetry endpoint, and sell it as their own — and users of that fork get a product that violates
every invariant in `conventions.md` while carrying our lineage. There is no licence remedy for that
and the trademark (D04) is the only lever. If that outcome is unacceptable, the answer is AGPL-3.0
on the core and the procurement friction that comes with it; there is no third option that gets
both.

**Evidence that would change this.**

| Signal | Move to |
|---|---|
| A named customer's licence policy prohibits Apache-2.0 dependencies (rare) or requires copyleft (rarer) | Whatever they need. `36` Q50 already says: raise it before the first release |
| D01 lands on "business, dual-licensed" | AGPL-3.0 core plus a commercial exception, and a CLA from commit one |
| A proprietary fork appears and takes users | Nothing retroactive is possible. This is the cost, priced in advance |
| Contributors refuse the CLA and the project needs contributors more than it needs the relicensing option | DCO, and D01 option D closes permanently |

**Blast radius if reversed later.** Every contributor whose code remains in the tree must consent, in
writing, or their contribution must be removed and rewritten by someone who has not read it. Corpus
contributors are worse: prose is harder to excise than a function, and `15`'s voice requirements mean
a rewrite is not a rewrite of the words but of the entry. Add: any third party who published a rule
pack or built on the format under the old terms.

---

### 3.4 D04 — The name, and the identifier namespace it enters

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R3 today; R5 the day a public artifact carries it |
| **Latest responsible moment** | Before the ID prefix is written into a file format that a user keeps |
| **Current lean** | Rename. And decouple the identifier namespace from the product name **now**, which drops the cost of any future rename from R3 to R1 |
| **Detail in** | `conventions.md` § *Identifiers*; `32` §7; `17` §2.1 |

**The fork.** The brief calls *Fathom* a working codename — *"a depth measurement, and also 'to
understand.' Placeholder; rename freely."* The double meaning is exactly right for the product: the
tool measures depth and produces understanding, and §2.1's vocabulary gap is a comprehension problem
before it is a search problem. The name is a good idea. It is a bad identifier.

**What is already using it.**

| Who | What | Why it matters |
|---|---|---|
| **Fathom5** (Austin, TX) | Industrial technology; maritime **cybersecurity**; cyber-physical testbeds; US Navy programs; states 17 patents across cybersecurity and actuator technology | The most dangerous collision on this list. Same word, same adjacent field, defence buyers in common, and a patent portfolio |
| **Fathom Analytics** | Privacy-focused web analytics, bootstrapped, well known in the developer audience this project would launch into | Owns the developer-audience association with the word, and `usefathom/fathom` on GitHub |
| **Fathom** (fathom.video, moving to fathom.ai) | AI meeting notetaker; states 300k+ companies | Owns the AI-tool association with the word, which is the association a project with a supervisor/subagent layer would collide with |
| **AFT Fathom / Fathom by Datacor** | Pipe-flow and fluid-dynamics simulation, commercially released 1994 | Established engineering-tool usage. Long history, and a trademark strategy documented by its own vendor |
| **Applied Global Technologies** | A `FATHOM` trademark registration covering computer networking hardware for evaluating network conferencing capability | A registration in the networking class <!-- VERIFY: pull the live status, class and goods description for this and every other FATHOM registration from USPTO TSDR and from EUIPO before any name is adopted. A Justia summary is a pointer, not a clearance. --> |
| Others | Fathom Technologies (assistive reading software), Fathom Holdings (real estate), Fathom Digital Manufacturing | Noise, but each one is a search result that is not us |

**Why this is a product problem and not a branding problem.** The wedge feature is search. The
adoption path in brief §6.1 is a person typing a half-remembered thing into a box. A project whose
name returns an analytics company, an AI notetaker and a pipe-flow simulator before it returns the
project has broken its own discovery channel. Add: a security tool whose name collides with a
defence cybersecurity contractor will be confused with them in exactly the procurement conversations
`36` exists to win.

**Why it is expensive to reverse — and the part that is fixable for free today.**

The rename cost is not the README. It is `conventions.md`:

```
Node IDs: fathom:<kind-lower>:<ulid>
Explainer IDs: explain:rule:ipsec.pfs.absent
```

Every node ID in every workspace ever written contains the literal string `fathom:`. So does every
suppression that references one, every provenance record, every AI audit entry, every emitted line's
`source_node`. Renaming after workspaces exist is a **data migration over the whole ID space**, and
IDs are the one thing invariant 7 says must be stable forever.

> **RECOMMENDATION — take the product name out of the identifier namespace today.** Two changes, both
> free before the first line of `fathom-id`:
>
> 1. **Drop the prefix.** A node ID is a `(kind, ulid)` pair. The kind is already there; the
>    namespace prefix carries no information a parser uses. `IkeGateway:01J9...` is shorter, sorts
>    the same, and contains no brand.
> 2. **If a prefix is wanted for pasteability, make it a fixed non-word.** `fm:` or a 2-byte format
>    magic derived from the format version, not the product name.
>
> With that done, a rename costs: the crate names, the CLI binary name, the file extension, the
> domain, the docs, and nothing that a user's file contains. **R3 becomes R1.** This is the highest
> value-per-minute recommendation in this document.

The same applies to `fex`, which is currently *Fathom EXpression*. Name it for what it does.

**Alternatives, held to the same double meaning: a measurement of depth, and an act of
understanding.**

| Candidate | The measurement | The understanding | Collisions and honest problems |
|---|---|---|---|
| **Plumb** | A plumb line is the oldest depth-and-vertical measure there is; a sounding lead is a plumb | *"to plumb the depths"* is literally to understand something fully | **And a third meaning the domain already uses:** side 1 of the field card is headed `THE FIVE PLUMBING PIECES`, and its closing line — *"Steps 5–8 failing while 2–4 are clean is plumbing, not crypto"* — is the single most useful diagnostic sentence on the card. A network engineer already says "plumbing" for exactly this. Problem: sanitation association, and it is a common English word, so search is mediocre |
| **Sounding** / **Soundings** | A sounding *is* the depth measurement; the lead line's whole purpose | *"to sound someone out"*; *"that sounds right"* | Audio-domain collision is significant and permanent. `soundings` plural reads as a chart annotation, which is on-message |
| **Bearing** | A bearing is a navigational measurement | *"to get your bearings"* — which is precisely §2.1's problem: the engineer has lost their bearings in a vocabulary they do not have | Mechanical bearings; heavy general-word usage. Weak as a search term |
| **Leadline** | The instrument itself: a marked line with a lead weight, cast to measure depth | Weak — the understanding sense is inherited rather than direct | Probably clear, which is worth a lot. Obscure enough that it needs explaining once |
| **Gauge** | To gauge is to measure precisely | To gauge is also to judge or estimate | Real collisions in software tooling, including a well-known test framework. Rejected on that |
| **Sonar** | Echo sounding is how depth is measured now | Weak | **Rejected outright:** the closest software neighbour is a static-analysis and linting platform. A linting tool called Sonar-something is the one collision this project cannot have |
| **Ken** | Nautical range of sight | *"beyond my ken"* — to know | Too short to search, and a common given name |
| **Reckon** | Dead reckoning is position-finding by measurement | *"I reckon"* — to judge; *"a reckoning"* — a computation | Collides with an established accounting software company |

**RECOMMENDATION — Plumb, with Leadline as the fallback if clearance fails.**

Reasoning: Plumb is the only candidate whose third meaning is *already in the source material*. The
field card uses "plumbing" as a technical category — the five pieces that make a tunnel carry
traffic once the crypto is right — and that category is one of the six views (`emit`). A name the
domain already uses for the thing the tool does is worth more than a name that is merely available.
Leadline is the safety option: obscure, almost certainly clear, and it explains itself in one
sentence to a network engineer who has never heard it.

**This is a RECOMMENDATION and the owner should overrule it freely.** Names are the one decision in
this document where the owner's taste beats the analysis, and the analysis here is only good for two
things: showing that *Fathom* is occupied, and showing what "the same double meaning" costs to keep.

**Evidence that would change this.**

| Signal | Action |
|---|---|
| A clearance search comes back clean for `Fathom` in the relevant classes and the domain is obtainable | Keep it. The double meaning is the best of any candidate and the search-collision problem is survivable if the project owns `<name>.dev` and a distinctive GitHub org |
| Clearance fails for the recommendation | Move down the table. Do not invent a new word — a made-up name has no double meaning, which is the entire criterion |
| The project is going to be a business (D01) | Weight clearance far higher and treat this as a legal decision with an engineering input, not the reverse |

**Blast radius if reversed later.** With the identifier decoupling above: crate names, binary name,
file extension, domain, docs, and any published rule-pack or corpus IDs that embedded it. Without
it: all of that plus a migration over every ID in every workspace, which is R3 and which invariant 7
was written specifically to prevent.

---

### 3.5 D05 — The IR shape, and whether edges are first-class

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R4 — the most expensive reversal in the document |
| **Latest responsible moment** | `fathom-graph`'s first commit; in practice, before the rule-pack name environment is frozen, because rules are authored against it |
| **Current lean** | Property graph with first-class typed edges; node fields never hold a `NodeId` |
| **Detail in** | `11` §3.1–§3.5 |

**The fork.** Brief §5.1's tree is ambiguous — it draws `ZoneBinding` and `Membership` as tree nodes
and `Binding → LogicalUnit` as an arrow — and the brief says of the schema: *"This schema is the
entire bet of the project."* Three shapes are genuinely available.

| | Shape | Relations live in | Reads like | Serialises like |
|---|---|---|---|---|
| **A** | **Typed document tree** | Nesting, plus fields holding IDs | `vpn.ike_gateway` — an infallible field read | A nested document a human can read |
| **B** | **Relational-in-memory** | Join tables and indices; an ECS-shaped arena | `edges.by_kind(UsesIkeGateway).from(vpn)` | Columnar arrays |
| **C** | **Property graph, first-class typed edges** | A separate typed, identified, provenanced edge collection | `g.out_one(vpn, EdgeKind::UsesIkeGateway)?` — fallible | An exploded edge list |

**The reframe that narrows this fork, and it should be stated before the arguments:** B is not
really an alternative to C, it is C's *implementation*. A property graph backed by
`Vec<Node>` plus `HashMap<(NodeId, EdgeKind), SmallVec<[EdgeId; 2]>>` adjacency is a
relational-in-memory model with a graph-shaped API. And A is not really an alternative either — it is
C's *rendering*, which `11` §14.4 already assigns to the workspace inspector, which re-nests
containment for display. The genuine, irreversible fork is narrower and sharper:

> **Can an edge carry its own ID, its own fields and its own provenance?**

Everything else is API taste and can be changed in an afternoon. That one property cannot.

**Why it is expensive to reverse.** Three consumers depend on edges being addressable:

1. **Provenance.** *"The parser saw `set security zones security-zone WAN interfaces reth0.0
   host-inbound-traffic system-services ike` on 2026-03-14"* is a fact about a **binding**, not about
   the zone and not about the unit. Under shape A that lineage has to live on whichever side happens
   to hold the field, so the *direction the vendor wrote it* decides where the truth lives.
2. **Edge-owned fields.** Piece #3 of the field card's five plumbing pieces —
   `host-inbound-traffic system-services ike` — is configured *per interface within the zone* in
   Junos. It belongs to the binding and nowhere else. Shape A has to invent an intermediate node to
   hold it, which is shape C with a worse name.
3. **Finding attachment.** Rule `zone.host-inbound.ike-missing` fires against something. The honest
   target is the binding. Side 1 of the card is unambiguous about why this rule matters: *"Miss #3
   and Phase 1 times out with nothing useful in the log — the box drops the peer's IKE before
   processing it."* A finding that cannot point at the exact binding points at a zone, and the user
   has to work out which interface.

**Options, with their real costs.**

| | Gains | Costs |
|---|---|---|
| **A — typed document tree** | Emitters read fields infallibly. Serialisation is human-readable. No adjacency indices, no reverse-index maintenance, smaller memory | Relation provenance is homeless. Edge fields force reified nodes anyway. Every reverse traversal is an index scan the store must maintain regardless, so half the saving is imaginary. Rename-safety (invariant 7) requires ID-keyed maps, which is most of the ergonomic loss of C without the gains |
| **B — relational-in-memory, exposed as such** | Best cache behaviour; the natural home for the incremental rule engine's read-sets; bulk operations are trivial | The API is the wrong shape for four of the six views. Rules, the diagram, the explainer and the emitter all want *"give me everything related to this element, typed"*, and expressing that as joins pushes graph logic into every consumer |
| **C — property graph, edges first-class** | Uniform traversal for all consumers; provenance and fields have a home; findings attach precisely; edge direction can follow semantic dependency rather than vendor syntax, which is decided once instead of per platform | Emitter accessors become fallible. Roughly 24 bytes per edge per direction of adjacency index, maintained on every mutation. Serialised workspaces are larger and less readable. The `Tunnel` promotion problem is real: `11` §3.4 records that `Tunnel` began as an edge and had to be promoted to a node once `TrafficSelector`, the diagram overlay and findings all needed to address it |

**DECISION — C, first-class typed edges, per `11` §3.2.** The register records it rather than
re-argues it. Two mitigations belong in the decision record because they are what make the cost
tolerable:

- **Codegen typed accessors from the schema, with cardinality in the return type** — `Rel1<IkeGateway>`
  for exactly one, `RelOpt` for `0..1`, `RelMany` for `0..n` — so fallibility appears exactly where
  the schema says the relation is optional and nowhere else.
- **Derived edges are never serialised** (`11` §3.5). They are recomputed on load, carry
  `Origin::Inferred`, and stay out of merges where they would generate meaningless conflicts. The
  cost is an inference pass on every open, and a hard ceiling on how expensive an inference rule may
  be — a ceiling that will be hit.

**Evidence that would change this.**

| Signal | Reading |
|---|---|
| The first 40 authored rules are all node-local predicates, with no relational condition | The edge machinery is overbuilt. Check honestly: `zone.host-inbound.ike-missing` is relational, and so is any rule that compares the two ends of a `Tunnel`, which is the entire "both ends must agree — every value, exactly" family from side 2 of the card. The evidence currently points the other way |
| Adjacency index maintenance dominates the B11 re-emit budget (~12 ms after a one-field change) | Not a shape problem; an index problem. Fix the index |
| Phase 2's residue is concentrated in *structures* rather than statements | This is R-SCHEMA arriving early (`71` §12.3), and it is a question about the schema's kinds, not about whether edges are first-class |

**Latest responsible moment.** The day `fathom-graph` gets its first type. But there is an earlier,
softer trigger that matters more: the rule condition language's name environment (D06) is defined
over nodes *and edges*, and rules are authored content at 60–90 minutes each. Freezing the name
environment before this decision is settled means re-authoring rules, not just re-writing code.

**Blast radius if reversed later.** By phase 3, this is the full R4: `fathom-graph`'s public API,
every emitter accessor, `fex`'s name environment and therefore every authored rule, the CRDT's op
set (`AddEdge`, and the OR-Set that governs edge existence), the workspace record taxonomy's
`Edges` shard class (`32` §6.3), every suppression that references an edge ID, and the diagram's
entire hit-testing model. Plus a data migration, because edge IDs are in user files.

---

### 3.6 D06 — The rule condition language

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R4 — the reversal is measured in re-authored rules, not in code |
| **Latest responsible moment** | Before the rule-pack format is signed and published |
| **Current lean** | `fex` — a purpose-built language whose concrete syntax is a strict subset of CEL's, entirely owned |
| **Detail in** | `12` §3 |

**The fork.** Invariant 5 says findings are data, not code. Brief §5.2 shows a rule with
`condition: "perfect_forward_secrecy == null"`. Something has to evaluate that string, and the
sandboxing constraint is not a preference — a pack format that can call out, allocate unboundedly or
reach the DOM makes the product's central claim false.

Four requirements rank the candidates, and the second one is the one that eliminates most of them:

1. A downloaded pack must not be able to execute anything.
2. **Read-set extraction must be total.** Given a rule and *without running it*, the engine must be
   able to name every `(node, field)` and every edge it could read. A language where this is
   sometimes impossible produces an engine that is sometimes `O(all rules)`, which is the same as
   never being incremental, because keystroke latency is set by the worst case.
3. Determinism (invariant 9).
4. Authorable by a network engineer who is not a programmer. The people who know that
   `mode aggressive` is silently ignored under `v2-only` are not going to write Starlark.

**Options.**

| Option | Sandbox | Total read-set | Determinism | WASM cost | Authorability | Verdict |
|---|---|---|---|---|---|---|
| **Rhai** | needs configured limits; Turing-complete by design | **impossible** in general | good if the non-deterministic corners are avoided | non-trivial | programmer-familiar | Reject on (2) |
| **Starlark** | hermetic, no I/O, deterministic by design | hard — name binding, function definitions, dynamic attribute access | strong; it exists for reproducible builds | large; a Python-shaped frontend | better than most, still a programming language | Reject on (2) and (4) |
| **CEL via a crate** | excellent — not Turing-complete, side-effect-free, designed for containment of untrusted expressions | **good** — no user functions, no assignment; comprehension macros are the only binding forms | strong | unmeasured for the Rust implementations <!-- VERIFY: build a Rust CEL interpreter for wasm32-unknown-unknown at opt-level=z, lto=fat, and measure the delta over an empty cdylib before quoting any size figure. --> | C-like; `pfs_group == null` reads fine | Strong, and rejected only on ownership |
| **JSONLogic** | excellent — data over a fixed operator table | trivial | strong | small | `{"==": [{"var":"perfect_forward_secrecy"}, null]}` is not a thing a network engineer will write or review | Reject as an authoring surface; viable as a compiled form |
| **Fixed combinator vocabulary** (structured YAML predicates) | perfect — nothing is parsed as an expression | perfect | perfect | zero | fine for 200 rules, then authors nest `all_of`/`any_of`/`not` five deep and have written Lisp in YAML | Reject — it does not survive relational rules |
| **Datalog** (`crepe`, `ascent`) | excellent — no I/O, terminating on the safe fragment | **perfect, and better than perfect**: the read-set is the rule body, and semi-naive evaluation gives incrementality for free rather than as a hand-rolled invalidation pass | strong with a fixed evaluation order | mid | **the honest problem**: a network engineer writes `pfs_absent(V) :- ipsec_policy(V), not has_pfs(V).` about as readily as they write Starlark | See below |
| **`fex` — owned subset of CEL syntax** | perfect — 28-opcode VM, step budget, no host-language execution | total by construction | strong | ours, and small | CEL-shaped, so it reads like the brief's own example | **Lean** |

**Datalog deserves the paragraph the existing corpus does not give it.** Relational rules over a
typed graph is Datalog's home ground, and `12` §6's *"hand-rolled forward invalidation with exact
recorded dependencies"* is a hand-built approximation of what a Datalog engine does natively.
Choosing Datalog would trade roughly 2,000–2,500 lines of `fex` frontend and VM against a smaller
frontend plus an evaluation strategy that already solves incrementality. It is rejected on
requirement (4) alone, and requirement (4) is the one `71` §12.2 makes a kill point out of:
*"No network engineer can author a rule from the spec without a programmer → stop and reconsider the
condition language."* Datalog fails that test before it is written. It should still be recorded as
the strongest technical alternative, because if `fex` ends up needing recursion or transitive
closure, this is where the conversation goes.

**DECISION — `fex`, per `12` §3.3, with a named reversal trigger.**

The cost, restated so the decision is not read as free: roughly 2,000–2,500 lines of lexer, parser,
type checker, compiler and VM, plus a conformance suite, plus a permanent stream of requests for
"can I just have regex lookahead". What it buys is a sentence that survives an enterprise review —
*the rule pack is parsed, type-checked and compiled to a 28-opcode VM with a step budget; nothing in
it is executed by a host language* — and a read-set extractor that is total by construction rather
than by our correct enumeration of somebody else's grammar.

> **Reversal trigger, written before starting:** if, after 100 authored rules, more than 15% require
> a construct `fex` lacks, **widen toward CEL's grammar** rather than adding ad-hoc builtins. The
> subset direction was chosen so that widening invalidates no authored rule. Adding builtins one at
> a time is how a small language becomes an undocumented large one.

**Evidence that would change this.**

| Signal | Action |
|---|---|
| A network engineer cannot author a rule from the spec after two attempts and one spec revision | `71` §12.2's kill point. Reconsider, and Datalog is *not* the answer — the answer is a guided rule-authoring form over `fex`, or fewer expressible rules |
| Rules start needing transitive closure ("is this zone reachable from that one") | Datalog's argument gets strong. Note this is a rule-scope question first: `11` §3.5's derived-edge arena is where transitive facts are supposed to live |
| The `fex` VM turns out to dominate the ~12 ms re-emit budget | An engine problem, not a language problem |

**Blast radius if reversed later.** Every authored rule, at 60–90 minutes each including two
fixtures. At 200 rules that is 200–300 hours of re-authoring plus re-review, plus a pack format
version bump, plus every third-party pack broken, plus the suppressions in every workspace that
reference rule IDs whose semantics moved.

---

### 3.7 D07 — The offline artifact shape

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R2 |
| **Latest responsible moment** | Phase 0's artifact definition — week 1 |
| **Current lean** | Single HTML file **and** a served static directory, from one build. No desktop app in v1 |
| **Detail in** | `43` §3, §7.8; `34` §3.3, §3.5 |

**The fork.** Brief §1 says *"deployable as a single offline file, a Docker single-node, or a
load-balanced enterprise cluster, from one codebase"*. The single offline file is the one with
choices in it.

| | **A — one HTML file** | **B — static directory, served over loopback** | **C — desktop app (Tauri/Electron-class)** |
|---|---|---|---|
| How it arrives | A file. Email it, USB it, put it on a share | An archive plus a binary (`fathom serve`) | A signed installer per OS |
| Verifiable by a stranger | **Yes, trivially.** One SHA-256 against a published hash | Yes, over an archive | Yes in principle; notarisation and per-OS signing make the chain longer |
| Air-gapped jump host | **Yes.** This is the deployment `31`'s flagship threat model exists for | Yes, if they may run a binary. Many cannot | Usually no — installing software is the thing that is controlled |
| Policy delivery | `<meta>` CSP only. No `frame-ancestors`, no `sandbox`, no violation reporting (`43` §3.4) | **Real response headers**, full set | The shell's own policy, and `connect-src 'none'` survives even with a sidecar |
| COOP/COEP, WASM threads, `SharedArrayBuffer` | **No** | **Yes** | Yes |
| Browser storage | **None, by decision** (`43` §3.5). No OPFS, no IndexedDB, no service worker | OPFS cache available, and it is the crash-recovery mitigation | Filesystem |
| Crash recovery | **None.** A discarded tab loses everything since the last save. This is the largest cost of A and `43` §3.12 prices it | Yes | Yes |
| Save quality | Good in Chromium via the File System Access API; a plain download elsewhere (`43` §3.8) | Good | Native |
| Post-XSS exfiltration | Two extra channels versus B, because `sandbox` and `frame-ancestors` cannot be delivered | Fewer | Fewest |
| Supply chain we own | One artifact | Two | **Three OS artifacts, two notarisation paths and an update channel** — larger than the product |
| Auto-update | None. `31` §7 forbids silent auto-update in any build | None | The pressure to add one is constant, and the answer is still no |

**DECISION — A and B, both, from one build. C is not built for v1 and is coupled to D22.**

Reasoning:

1. **A is the only shape that reaches the audience the security posture was built for.** An engineer
   on an air-gapped jump host cannot install a binary. `43` §3.5 already extended A from a
   reference-only lookup to a complete single-session product for exactly this reason, and that
   extension is the difference between a marketing claim and a usable tool.
2. **B costs almost nothing given A exists.** It is the same bytes with real headers, produced by
   `fathom serve`, and the CLI is shipping anyway (D13).
3. **C's cost is not the code.** Three signed artifacts and an update channel is a supply chain
   larger than the product, for a project whose entire security argument is that one reproducible
   build can be checked by a stranger.

**The live contradiction this decision has to resolve, and it should not be left buried:**

> `43` §3.5 recommends **rejecting** the signed desktop bundle. `24` §3.7 **decides** that the
> primary answer for the inference sidecar is *"a native shell that owns the sidecar as a child
> process (shape C)"* — which is a desktop app. Both documents are internally reasoned and they
> cannot both hold.

The resolution proposed here: **the desktop shell is not the offline mode; it is the AI transport.**
It exists if and only if D22 says the sidecar exists, it is a *fourth* artifact rather than a
replacement for A or B, and it is out of scope entirely while D21 keeps the model out of v1. Recorded
in §11 as a coupling and in §13 as a proposed amendment to both documents.

**Evidence that would change this.**

| Signal | Action |
|---|---|
| Measurable loss of user work through A's save path | `34` §3.5's own revisit trigger. Consider C, or make B the recommended shape and A the reference shape |
| A customer requires "no browser extensions in the same process as our configurations" | The other named revisit trigger. C becomes the enterprise answer |
| The single-file artifact cannot be built under ~4 MB with the index in it | `71` §12.1: re-scope A to a smaller corpus slice. Do not drop A |

**Blast radius if reversed later.** `xtask assemble`, the CSP delivery mechanism (`<meta>` versus
headers), `43`'s entire §3, and every claim in `35` about what a stranger can verify. R2, and the
work is concentrated in the build rather than the product.

---

### 3.8 D08 — Does TypeScript exist at all?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R2 |
| **Latest responsible moment** | Before the UI passes roughly 500 lines |
| **Current lean** | Yes. Vanilla TypeScript over a ~600-line first-party render layer; no framework; no Rust-native UI |
| **Detail in** | `41` §4.2–§4.5; `42` §3, §7 |

**The fork.** Brief §8 says *"thin TypeScript UI"* and *"Node.js appears in the build pipeline only,
and can be eliminated entirely if desired"*. Two questions hide inside that. Is there a second
language at all? And if there is, what checks it?

| | Option | Boundary shape | Build | Honest cost |
|---|---|---|---|---|
| **A** | **TS + first-party render layer** | Coarse: one WASM crossing per user intention | `oxc` transform (a Rust crate), plus the Go-native TypeScript compiler at `--noEmit` for the type gate | Two languages, two test harnesses, one boundary, forever. A hand-rolled render layer accretes into an undocumented framework with one contributor who understands it |
| **B** | **TS + a framework** (Preact, Lit, Svelte, Solid) | Coarse | Svelte and Solid are **Node compilers**, which `42`'s Z2 gate forbids outright. Lit needs a Trusted Types policy whose `createHTML` is `(s) => s`, which destroys `34` §2.9's argument | Every framework here fails a gate that exists for a reason. Preact is the closest survivor |
| **C** | **Rust-native UI** (Dioxus, Leptos, Sycamore) | **Fine-grained, and that is the problem**: one boundary crossing per element, per attribute, per event listener. `41` §3.2's traffic census has 16 entries; a Rust UI has thousands per frame | One language, no generated boundary types, no drift, and `42` shrinks to CSS and fonts | `web-sys` in the shipped closure kills the "two imports" property. Text input, IME, selection and accessibility are the hard parts and they are exactly where reimplementing browser behaviour hurts. Recompile on every label change |
| **D** | **Plain JavaScript, no types** | Coarse | Simplest possible: no transform, no type gate, no generated types | The WASM ABI seam is the highest-risk surface in the product and it would be unchecked. `41` §2.5 names boundary-type drift as the main integration risk; D removes the only control against it |
| **E** | **JS + JSDoc types** | Coarse | Checked by the same TypeScript compiler | All of A's tooling, worse ergonomics, no advantage |

**The question that decides between A and D, and it is worth stating because it is easy to get
wrong:** does "TypeScript exists" force npm into the build? **No.** `42` §3 already routes around it:
the TS → JS transform is `oxc`, a Rust library crate pinned by `Cargo.lock`, and the type check is
the Go-native TypeScript compiler, a native binary pinned by SHA-256, run `--noEmit`, producing no
artifact byte. So the honest statement is: **TypeScript exists, is type-checked, and no npm package
is installed or executed in any stage that can influence an artifact byte.**

That is a stronger sentence than "no Node in the build", and it is the true one. Anyone repeating
the shorter version in public material is overstating it, and `42` §2 says so directly.

**DECISION — A, per `41` §4.4.** The deciding argument against C is the boundary shape: the design's
central performance property is a coarse WASM boundary, and a Rust UI framework is a fine-grained
boundary by construction. Adopting one means paying the WASM module's costs to get the boundary shape
we specifically chose against.

Two conditions attach to the decision:

- **`RECOMMENDATION` — cap the render layer at 800 lines and fail CI above it.** Not because 800 is
  magic, but because the failure mode is gradual and a number is the only thing that makes it
  visible. The 801st line becomes a design conversation, which is the point.
- **The exit is named.** `41` §4.3 records that C is re-openable precisely because the views are pure
  functions of typed data and the render layer is small. If the UI reaches 3,000 lines and boundary
  types are the main source of bugs, reopen it. Almost nothing else in this stack has that property.

**Evidence that would change this.**

| Signal | Action |
|---|---|
| The UI exceeds ~3,000 lines and boundary types dominate the bug list | Reopen C. It is the one big stack decision that is not one-way |
| The Go-native TypeScript compiler regresses or becomes unavailable | `42` §11 already handles it: the gate emits nothing, so a release can proceed with the gate red and a recorded exception. That is worse, not fatal |
| `oxc`'s minifier miscompiles the UI | Ship unminified. The single-file artifact is dominated by base64 WASM anyway |

**Blast radius if reversed later.** Rewriting the UI in Rust is the whole UI plus the diagram's
hit-testing plus the virtualised table, and it deletes the generated boundary types rather than
migrating them. R2 at 800 lines, R4 at 3,000.

---

## 4. Rank B — before the corpus track scales

*margin tab: content is the long pole*

> **THE CORPUS IS 25–40% OF EVERY PHASE AND IT IS THE ONLY LINE ITEM BETTER ENGINEERING CANNOT ACCELERATE**

### 4.1 D09 — Does the conformance lab exist, and who runs it?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R2 to fix; R5 in reputation if unverified content is published as reference |
| **Latest responsible moment** | Before the first corpus entry is published as reference material |
| **Current lean** | Yes. Two physical boxes with a path between them, run by the domain author |
| **Detail in** | `71` §3.1, §15.1; `45` |

**The fork.** `71` §3.1 records the current state without softening: 91 seed command entries exist,
authored from the field card, **none of them run on a box**, all carrying `reviewed_by: <named
human>` which the build is required to reject. The corpus does not exist yet; a proof that the format
works exists.

The whole product is a reference that people paste into production equipment. Side 1 of the card
carries its own answer to this, in caps, on every side:
`VERIFY AGAINST YOUR OWN BOX BEFORE ACTING`. The tool inherits that disclaimer, and it inherits the
obligation behind it.

**Options.**

| | Shape | Cost | What it can verify |
|---|---|---|---|
| **A** | No lab. Entries carry a "not verified on hardware" marker | Zero | Nothing. And the marker will be read as noise within two releases |
| **B** | A single vSRX instance | Licensing <!-- VERIFY: current vSRX evaluation terms, licence duration and feature limits — in particular whether IPsec and NAT-T behaviour is complete on an evaluation licence. --> plus a host | Syntax, commit acceptance, `show` output shapes. **Not** the interesting half |
| **C** | **Two boxes with a routed path between them** — virtual or physical | Two instances plus a router or a NAT device in the middle | Everything the card is actually about: NAT-T moving to 4500, PFS mismatch failing P2 while P1 stays up, DPD interval × threshold blackhole timing, MTU and the DF-bit story, flap patterns, `inactive-tunnels` reasons, and the `NO_PROPOSAL_CHOSEN` error decoder |
| **D** | Borrow someone else's lab | Nearly free, intermittent | The same as C, at the cadence of somebody else's goodwill, which is not a cadence |

**DECISION — C.** The reasoning is the field card's own structure. Every failure mode on all four
sides is a *two-ended* failure. *"PFS on one side, absent on the other → Phase 2 fails while Phase 1
stays up"* cannot be observed on one box. Neither can *"Both ends `on-traffic`, or both
`responder-only`. Nobody initiates, nothing is misconfigured, tunnel never comes up."* A single-box
lab verifies that commands are spelled correctly, which is the part the card is least about.

**The specific thing this buys, and it is the one that justifies the cost:** `15` §13's rot model
estimates re-verification of roughly 60% of entries per vendor major release. Without a lab, rot is
undetectable, and `71` §12.9's first global kill point — *corpus rot outruns corpus authoring* —
cannot be measured, only suspected. A lab turns the project's most dangerous failure mode from
invisible into a scheduled task.

**Evidence that would change this.** If the first 50 entries verify at above ~95% against a single
vSRX and the residual 5% are all two-ended behaviours that the card already documents from
experience, then B plus documented experience is defensible for phase 0 and C becomes a phase-1
purchase. That is a measurement, not an assumption.

**Blast radius if deferred past the trigger.** Publishing unverified commands as reference is the
single failure this product cannot survive, because the product's claim is that it is more
trustworthy than the vendor documentation it exists to replace. Recovery is a re-verification pass
over everything published, plus a public correction.

---

### 4.2 D10 — Community corpus contributions

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R5 — an accepted contribution cannot be un-accepted without the contributor, and licensing follows it |
| **Latest responsible moment** | Before the repository is public (D12) |
| **Current lean** | Gap reports, correction reports and `misdiagnosed_as` sentences. Full entry PRs only from a small named practitioner set. Never open |
| **Detail in** | `15` §13.5 |

**The fork.** A corpus of this size is the obvious candidate for opening up. `15` §13.5 already
argues against it on two structural grounds, and the assignment for this document names a third that
deserves to be first.

**The supply-chain argument, stated properly, because it is the one that decides it.**

> **Community corpus content is a code-execution-equivalent channel that does not look like code.**

Three concrete attacks, none of which require malice — carelessness produces all three:

| Vector | The contribution | What the user is told | Consequence |
|---|---|---|---|
| **Remediation** | A `remediation:` template for a rule | The tool emits that line, with provenance, into a change ticket | The user pastes it into a production firewall. `13`'s provenance chain makes it *look* more authoritative, not less |
| **`acceptable_when`** | Adding *"when the peer is on the same trusted WAN"* to `ipsec.pfs.absent` | The finding acquires a socially sanctioned waiver | Invariant 8's most valuable field becomes the attack surface. The rule still fires; the user now has our permission to ignore it. Nothing in the system flags this, because it is exactly what the field is for |
| **`risk`** | A command entry whose `risk` is `ReadOnly` when the command changes configuration | The three-colour legend — the card's single most disciplined move — is wrong for that entry | A user runs it on production expecting no commit. The legend is trusted precisely because it is never wrong |

The third one has a worked example already in the corpus. Side 3 of the field card:
`clear security ike security-associations <peer-ip>` — and its note: *"Clearing P1 tears down every
child SA under it — on a hub that is every spoke at once."* That entry is `Disruptive`. An entry that
mislabels it as `ReadOnly` takes down every tunnel on a hub, and the person who ran it did so because
the tool said it was safe on production.

**Options.**

| | Shape | Review burden | Supply-chain exposure | Voice |
|---|---|---|---|---|
| **A** | Closed. No outside contributions of any kind | Zero | None | Preserved |
| **B** | **Gap reports only** — "I wanted X and found nothing" | Near zero. A gap costs a user nothing and costs review nothing | None. A gap is a request, not content | Preserved |
| **C** | **Correction reports** — "this is wrong on 24.2, here is the output" | Low. It routes to re-verification against the lab, not to prose review | None. It is a bug report against a fact | Preserved |
| **D** | **`misdiagnosed_as` sentences only** | ~90 seconds per contribution | Low — one prose sentence, no emitted text, no risk value | The one field where a stranger's experience beats the maintainer's |
| **E** | **Full entry PRs from a named practitioner set** | High per entry, bounded by the size of the set | Managed by knowing the people | Achievable, because a small set develops shared voice |
| **F** | Open entry PRs | **Unbounded, and it exceeds review capacity by construction.** The queue becomes the bottleneck, visibly, which demoralises the contributors it was meant to attract | Full, per the table above | Lost. `15` §13.5: *"An open corpus in mixed voices is vendor documentation with a different licence"* — which is §2.3's complaint, restated |

**DECISION — B, C and D always; E by invitation; F never.** Plus one control that is new here and
belongs in the contribution policy verbatim:

> **No contributed content may set a `risk` value, a `remediation` template, or an `acceptable_when`
> clause.** These three fields are maintainer-only, forever, regardless of who the contributor is or
> how good the contribution is. A contribution may *propose* them in prose; a maintainer with lab
> access writes them. This is mechanically checkable in CI by diffing the three field paths against
> the contributor allowlist.

Reasoning: those three fields are the ones where wrong content causes an outage rather than
confusion. Everything else in an entry is explanation, and wrong explanation is caught by a reader.

**Evidence that would change this.**

| Signal | Action |
|---|---|
| Gap reports arrive at a useful rate and correction reports find real errors | The model is working. Do not widen it |
| Nobody files anything | The mechanism is too obscure. Fix the affordance in-product (`21` §7.1's under-determination surface already has a `file this as a gap` control), not the policy |
| A named practitioner writes five entries that pass voice review unchanged | Widen E's set by one. Widen it one person at a time, forever |
| Review capacity genuinely exceeds inbound | It will not. `71` §15.1 puts the domain author at 0.6 FTE and calls them the least substitutable resource |

**Blast radius if reversed later.** Opening then closing is worse than never opening: contributors
who were accepted and then excluded are a reputational cost, and every entry already merged carries
its author's licence terms and their name in `reviewed_by`. Going the other way — closed to open — is
free at any time, which is why the conservative answer is the cheap one.

---

### 4.3 D11 — Third-party rule packs, and the trust root

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R3 — the trust store is in the workspace (`32` §6.3, `Settings`) |
| **Latest responsible moment** | Before the pack signature envelope is frozen (phase 1 exit) |
| **Current lean** | First-party packs only in v1; a pinned-publisher trust store when a second organisation asks |
| **Detail in** | `12` §13; `35` §—'s advisory distribution; `71` §13.2 |

**The fork.** `12` establishes rule packs as signed, versioned bundles. Who may sign one?

| | Model | What it needs | Risk |
|---|---|---|---|
| **A** | **First-party only.** One key, ours | A key, a rotation story, nothing else | None beyond our own | 
| **B** | **Pinned publishers.** A trust store the user edits, seeded empty | A trust-store UI, a revocation path, key rotation for publishers who are not us, and a policy for what happens when a pinned publisher is compromised | Bounded by the user's own choices, and the user can see the list |
| **C** | **Trust on first use** | Less UI | The first pack a user installs defines their trust root, silently, forever |
| **D** | **A marketplace** | Publishing infrastructure, moderation, ratings, and an answer to "who is responsible when a pack's remediation causes an outage" | It is a governance problem wearing a technical costume |

**DECISION — A for v1, B when a second organisation actually asks.** `71` §13.2 already defers the
marketplace with the correct trigger: *"third parties actually writing packs"*. The register adds
only that B's cost is not the signature verification — that is already built — but the **revocation
and rotation story**, which is a UI, a distribution channel and a policy, and none of those should be
designed speculatively.

Note the asymmetry with D10: a rule pack is a *stronger* channel than a corpus entry, because a pack
carries conditions, remediations and severities as a unit and installs without review. The three
maintainer-only fields in D10 are exactly the fields a pack is made of.

**Evidence that would change this.** A customer with an internal security standard that they want
expressed as rules — which is the legitimate demand, and it argues for B scoped to *their own* key in
*their own* deployment, not for a public ecosystem.

**Blast radius if reversed later.** Adding B is additive and cheap. Removing it after publishers
exist breaks their users. Do not ship C at all: TOFU is the one that cannot be walked back, because
by then every workspace has a trust root nobody chose deliberately.

---

### 4.4 D12 — Is development in the open from day one?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R5 — published history cannot be unpublished |
| **Latest responsible moment** | The first push to a public remote |
| **Current lean** | Public at phase 0's release, with the full history, not before |
| **Detail in** | `35` §1.1; `15` §13.6 |

**The fork.** Public from commit one, public at first release with history, or source-available
snapshots per release.

| | Shape | Buys | Costs |
|---|---|---|---|
| **A** | Public from commit one | Maximum credibility for the rebuild claim. Contributors could appear early | Every unreviewed seed entry is quotable. A half-authored security rule with a wrong `acceptable_when` is *worse than absent*, and it will be found by search before it is finished |
| **B** | **Public at phase 0's release, full history** | The same credibility, arriving with content that has passed review. The history is there for anyone who wants to audit how it was built | A period of building in private, which some audiences read as unserious |
| **C** | Snapshots per release, no history | Least exposure | Undermines `35`'s whole programme: a rebuilder wants the tree, and an auditor wants to see what changed |

**DECISION — B.** The deciding argument is D10's third row: an incomplete corpus entry is
indistinguishable from a complete one to a reader, and this project's entire value proposition is
that its content can be trusted more than the vendor documentation. Publishing entries mid-authoring
is the failure mode `15` §13 identifies as the worst state — *90% right is indistinguishable from
right until it costs somebody an outage*.

Attach the control from `15` §13.6 point 1 at the same moment: **publish coverage and staleness in
the product from the first public release.** A visible "SRX: 100% Tier A, 71% Tier B, 14 entries
aging" is survivable. A hidden 71% is not, once discovered.

**Blast radius if reversed later.** One-way in both directions and for different reasons. Private →
public loses nothing and is always available. Public → private is impossible for anything already
mirrored, and reads as a licence retreat even when it is not.

---

### 4.5 D13 — Does the CLI ship in phase 0?

| | |
|---|---|
| **Kind** | RECOMMENDATION |
| **R** | R1 |
| **Latest responsible moment** | Phase 0 scoping |
| **Current lean** | Yes |
| **Detail in** | `71` §3.3, open decision 3; `43` §7 |

**The fork.** Roughly a week of work, and it is the only instrument that can measure R-DETERM — the
risk that byte-identical output across WASM and native cannot be held in practice. `43` §1.4's
cross-host test compares native, wasm-node and wasm-browser-headless against one expectation file;
without the CLI there is no native host to compare against.

**RECOMMENDATION — yes, and it is not really a scoping call.** A determinism invariant with no
instrument is a hope. The CLI also produces `fathom serve`, which is D07's option B, so its cost is
shared across two decisions.

**Evidence that would change this.** None available. If phase 0 is running badly over, cut corpus
breadth first — the CLI is a week and the corpus is months.

---

### 4.6 D14 — Who owns the corpus voice, and what happens when they leave?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R4 — losing it means re-authoring, not re-hiring |
| **Latest responsible moment** | Before entry 51 is authored |
| **Current lean** | One named voice owner; a 50-entry reference set that *is* the specification; a written rule about what ships without their review |
| **Detail in** | `15` §12.5; `71` §15.1 |

**The fork.** This is not in any sibling document as a decision, and it is the most likely single
point of failure in the project. `71` §15.1 is direct about it:

> *"D1 is the scarcest resource and the least substitutable. A senior network engineer who can write
> in the field card's voice, has hardware, and is willing to spend hours on YAML is rare."*

The design language document is equally direct that the voice is not reproducible by a model:
*"It is achievable by a human writing YAML. It is not reliably achievable by a language model
improvising at runtime."*

So: one person's voice is a load-bearing structural component, and there is no decision anywhere
about what happens when they are unavailable for six weeks, or permanently.

**Options.**

| | Shape | Consistency | Bus factor |
|---|---|---|---|
| **A** | One voice owner, no written specification of the voice | Highest while they are present | **1.** The project stops |
| **B** | **One voice owner, plus the 50-entry reference set as the specification** | Highest, and recoverable | 1 for authoring, but the specification survives them. A successor has 50 worked examples rather than an adjective list |
| **C** | Two co-owners who review each other | Slightly lower — two voices converge but never merge | 2, at roughly 1.6× the cost |
| **D** | A rotating panel with a style guide | Lowest. `15` §13.5's own complaint about mixed voices applies internally as well as externally | High |

**DECISION — B, with one addition.** `15` §12.5 already specifies the reference set: 50 entries by
the voice owner, spanning all 13 classes, one week of one person doing nothing else, and it *"must
exist before any other corpus work starts"*. This register makes that a decision rather than a
schedule note, and adds the rule that makes it enforceable:

> **An entry the voice owner has not reviewed may ship at `Explained` depth. It may not ship at
> `Teaching` depth.** Teaching depth is where the analogies, counterfactuals and failure-mode
> framing live — it is the depth the design language document is describing — and it is the depth
> that cannot be written from a style guide. Everything else degrades gracefully.

That rule turns the voice owner's absence from a stoppage into a documented, visible reduction in
depth, which the coverage display from D12 already shows the user.

**Evidence that would change this.** If a second author's entries pass blind voice review against
the reference set at a useful rate, C becomes affordable and the bus factor improves. Test it
deliberately rather than waiting to find out.

**Blast radius.** If the voice owner leaves without the reference set existing, every entry authored
after them is either in a new voice or a guess at the old one, and `15` §13.4's tier-4 triage
("write the entry, or stop shipping the thing it explains") starts firing across the corpus.

---

## 5. Rank C — before phase 1 exits

*margin tab: the format is a promise*

### 5.1 D15 — Encryption granularity: whole-workspace, per-record, per-op, or sharded

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R3 — the shard count is fixed at workspace creation; changing it rewrites everything |
| **Latest responsible moment** | Before a workspace exists that a user would be upset to lose |
| **Current lean** | Sharded, `S_nodes = 64`, `S_edges = 16`, fixed in the manifest at creation |
| **Detail in** | `32` §6 |

**The fork.** The brief's §6.4 decision — inventory as a document, git-versionable and diffable —
collides with §7's zero-knowledge posture in one specific place: **the filename set of an encrypted
directory is metadata that no amount of encryption hides.**

| Granularity | Git diffs | Partial sync | Write amplification per one-field edit | What it leaks |
|---|---|---|---|---|
| **Whole workspace** | No — one binary blob changes wholesale | No | 100% | One size, one change event. Least of any option |
| **Per node** | Yes, beautifully | Yes | ~1 node | **The node count, exactly**, and per-kind counts if the kind is in the filename. Node count ≈ estate size; `Device` count ≈ how many boxes you run. Visible in the commit that adds the file, permanently, to anyone with repository read access |
| **Per operation** | Append-only, clean history | Yes, cheaply | ~1 op | **The edit count and edit timing at full resolution, forever.** An encrypted op log still shows a burst of writes in one class at 22:40 on a Tuesday, which is a change window and a reconnaissance signal |
| **Whole workspace + separate op log** | Partly | Partly | 100% of the state blob | Same timing leak as per-op, without per-op's benefits |
| **Sharded, fixed `S`** | Yes, **and the file set never changes** | Yes, at 1/S | 1/S | Total size only. Not the node count, not the device count, not which node changed — only which of `S` buckets changed |

**DECISION — sharded, per `32` §6.2.** The register records the trade rather than re-deriving it,
and states the price without softening: a one-field change rewrites ~25 KiB instead of ~2 KiB on a
1.6 MiB graph, so a busy workspace's git history is roughly an order of magnitude larger than
per-node records would produce, and git's delta compression will not help because the bytes are
ciphertext. That is the price of not publishing the device count in the filename set.

Two things belong in the decision record because they are creation-time and therefore R3:

- **`S` is a creation-time question with the trade stated, not a preference.** Offer `S = 8` for a
  small workspace and `S = 256` for a large one. A twenty-node workspace at `S = 64` is 64 near-empty
  shards each padded up to its Padmé bucket, which is pure overhead.
- **`Suppressions` is deliberately one record and stays one record.** Splitting it leaks the
  suppression count, and a suppression list is a list of known-unfixed weaknesses each with a written
  reason they will not be fixed. The count alone is a signal.

**Evidence that would change this.** If real workspaces turn out to be edited in large batches rather
than field-by-field, whole-workspace becomes competitive and leaks less. Measure the save pattern in
phase 2, not in phase 5.

**Blast radius if reversed later.** Every existing workspace must be rewritten by a migration that
has to be correct first time, because the input is the only copy. Plus: the manifest layout, the
sync protocol's partial-sync unit, the git history size characteristics customers may already be
budgeting for, and `17`'s directory form.

---

### 5.2 D16 — When does the workspace format become a compatibility promise?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R5 — a compatibility promise is a promise to people |
| **Latest responsible moment** | The release that first writes a workspace users keep |
| **Current lean** | At phase 1's release, with a written migration policy and published test vectors |
| **Detail in** | `36` Q51; `32` §7, §16; `11` §11 |

**The fork.** `36` Q51 answers "what happens to our data if you shut down" with a set of properties:
the format is specified byte by byte with published test vectors including negative vectors, the CLI
reads it, any independent implementation of the spec would, there is a plaintext export path, and
there is no licence check or phone-home. It concludes: *"No hostage-taking is possible by
construction."*

Every one of those sentences is only true if the format is stable enough to specify. So the fork is:
when does the specification stop being a description and start being a commitment?

| | Shape | Cost |
|---|---|---|
| **A** | Promise from the first written workspace | Locks in decisions made under phase-1 knowledge, before the CRDT (D19) and the record model have met a real workspace |
| **B** | **Promise at phase 1's release, with an explicit migration policy** | Requires writing the migration machinery in phase 1 rather than discovering it in phase 5. `11` §11 and the `schema_version.minor` preserve-mode rule already exist for this |
| **C** | No promise; each release migrates | Contradicts `36` Q51, which is a published security answer. A format that migrates every release is one an independent implementation cannot chase |

**DECISION — B**, and the promise has a specific shape rather than being a sentiment:

| Guaranteed | Not guaranteed |
|---|---|
| A workspace written by version *n* opens in version *n+k* for all *k* ≥ 0 | That version *n* opens a workspace written by *n+k*. `11` §11's rule is that a higher `schema_version.minor` puts the client in **preserve mode**: it opens, it does not lose unknown data, it refuses to write |
| Published test vectors, including negative vectors, for every format version | That the *bytes* are stable — re-sealing produces different ciphertext by construction |
| A plaintext export path with a deterministic output format, in every version | That the plaintext export is a re-import path at full fidelity <!-- VERIFY: confirm against `17` §15 whether the plaintext export round-trips into an identical graph, or is lossy on provenance. The answer changes what may be claimed in `36` Q51. --> |

**Evidence that would change this.** If phase 2's real configurations force new node kinds at a rate
that keeps moving the record layout, the promise slips to phase 2's release and `36` Q51's answer
needs a "from version X" qualifier until then. Say so rather than promising early.

**Blast radius.** Breaking a stated format promise costs more than the migration: `36` Q51 is the
answer given to a customer's procurement risk register, and a broken format promise turns that
answer into a liability in exactly the conversation it was written for.

---

## 6. Rank D — phases 4 and 5

*margin tab: what v1 does not need*

### 6.1 D17 — Is the diagram in v1?

| | |
|---|---|
| **Kind** | RECOMMENDATION |
| **R** | R1 |
| **Latest responsible moment** | Phase 4's start |
| **Current lean** | No, and its absence costs almost nothing — which is evidence the architecture is right |
| **Detail in** | `56` §3.2, §3.4; `41` §10 open decision 5; `71` §12.5 |

**The fork.** Three shapes, and one of them is not really about the diagram.

| | Shape | Effort | What it buys | What it risks |
|---|---|---|---|---|
| **A** | Not in v1 | Zero | Phase 4's 6–10 solo weeks go elsewhere | The product demos worse. This matters if D01 lands on "business" and not otherwise |
| **B** | **Drag-only**: grid placement, orthogonal routing, manual positions, no automatic layout | The smaller half of phase 4 | A manipulation surface over the graph, layered by physical / L2 / L3 / security / overlay | Nothing structural |
| **C** | Full layered layout (Sugiyama-class, semantic ranking, manual positions as constraints) | 800–1,500 lines of first-party layout (`41` §9.2), because both mature layout libraries are JS and `34` §8.2 permits vendoring only what returns coordinates and never touches the DOM | A diagram that is useful above ~40 nodes | **Determinism.** A change ticket may embed an SVG, and invariant 9 says the same workspace produces the same bytes. A layout with any non-determinism in it makes an embedded diagram undiffable |

**RECOMMENDATION — A if v1 is phase 0 (D02); B when phase 4 runs; C only when a user asks for a
diagram of a topology large enough to need it.**

The interesting part of this decision is how *cheap* it is, and that deserves to be said, because it
is the only place in this register where the architecture pays an obvious dividend. Brief §4.1:
*"The diagram cannot be the data structure."* Because the diagram is a projection —
`diagram = render(graph)` — deferring it removes a view and changes nothing else. Compare D05, where
a reversal touches five crates and every user's file. The diagram's blast radius being near zero is
the test that `one graph, six views` is true rather than aspirational.

**The one thing that must not be deferred**, because it is architecture rather than diagram: layout
positions are a class B last-write-wins field in `33` §6.4, and `52` §12 D5 records the open
question of what happens when a colleague moves your boxes. The answer — LWW, with per-user layout
overlays only if the complaint actually arrives — costs nothing to decide now and is awkward to
retrofit into the CRDT's field classes later.

**Evidence that would change this.** `71` §12.5's kill point, inverted: if layout cannot be made
deterministic without abandoning quality, ship drag-only permanently and never ship a
non-deterministic layout that a change ticket embeds.

---

### 6.2 D18 — Does v1 have multi-writer sync at all?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R2 |
| **Latest responsible moment** | Phase 5's start |
| **Current lean** | No. File plus git for v1. Single-writer sync with an advisory lock next. Multi-writer only on evidence |
| **Detail in** | `33`; `71` §12.6; brief §6.4 |

**The fork.** The brief already states the trade in §6.4 — inventory as a document loses fleet-scale
querying and native multi-writer concurrency, *"for team-sized deployments this is a good trade and
git provides collaboration"* — and then adds that at several thousand devices *"§7.6 (CRDTs) becomes
load-bearing"*. The question is when that threshold arrives, and whether v1 pays for it in advance.

| | Shape | Cost | Failure mode |
|---|---|---|---|
| **A** | **No sync.** A file, and git if the team wants it | Zero beyond the format | Merge conflicts are git's problem and a human resolves them by looking at ciphertext, which they cannot. **This is the real cost of A and it should not be glossed**: an encrypted workspace does not merge in git, it collides |
| **B** | **Single-writer sync with an advisory lock** | Small: the server holds a lock token; the client shows who holds it | Someone holds the lock and goes on holiday. Needs a break-lock path with a recorded reason |
| **C** | **Multi-writer CRDT** | 1,500–2,500 lines plus the property-test apparatus a library would have shipped with, plus a permanent correctness obligation | **R-CRDT: two clients disagreeing permanently about the same workspace, silently.** `33` §4.4 names it: *"A convergence bug is a data-loss bug."* On a firewall policy that is not an inconvenience |

**DECISION — B for the first sync release, not C. And record what "no CRDT in v1" does *not* mean.**

The distinction that makes this deferral cheap, and which is easy to get wrong:

> **The op log stays either way.** `33` §5.1's `SetField` op carries the whole value and a
> provenance ID; `11` §8's provenance model and `18`'s diff both read that history. The op log is how
> provenance, undo and diff work — it is not a sync feature. What is optional in v1 is the
> **concurrent-merge semantics**: the multi-value register, the add-wins OR-Set's observed-remove
> bookkeeping, and §6's per-class resolution ladder. Those are the 1,500–2,500 lines and the risk.
> Deferring them leaves the op log, the format and the record model untouched.

That is why this is R2 rather than R3: the data does not change shape, only the merge does.

**Evidence that would change this.**

| Signal | Action |
|---|---|
| A real team reports friction that a lock does not solve — two people needing to edit different devices in one workspace at the same time, repeatedly | Build C. This is the honest trigger and it is the same shape as `71` §13.2's trigger for real-time collaboration |
| A workspace exceeds ~2,000 devices with genuine concurrent editing | `71` §13.2's own threshold for fleet-scale storage. Both triggers fire together in practice |
| The lock is broken more than once a month | The lock is the wrong granularity. Consider per-record locks before considering a CRDT |

**Blast radius if reversed later.** Adding C after B is additive: the op log is already there, the
field classes are already declared (`33` §6.4), and the work is the resolution ladder and its tests.
Removing C after shipping it is the expensive direction, because users will have relied on merges
that then stop happening.

**This is a proposed change to `71` phase 5**, which currently bundles the CRDT with the crypto.
Recorded in §13.

---

### 6.3 D19 — The CRDT: hand-rolled, Automerge, Yjs, or Loro

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R3 — the op encoding is in the file |
| **Latest responsible moment** | Week 4 of phase 5, against `33` §4.6's property tests. Not week 12 |
| **Current lean** | Hand-rolled over the typed graph, with Loro as the named fallback |
| **Detail in** | `33` §4.2–§4.6; `71` open decision 6 |

**The fork.** Only live if D18 says multi-writer exists.

| | Automerge 3 | Yjs / `yrs` | Loro | **Hand-rolled over the typed graph** |
|---|---|---|---|---|
| Data-model fit | untyped Map/List/Text; the typed graph is projected in and back out on every read | same | same, plus a movable tree | **exact** — ops are typed against the schema and checked by the compiler |
| Per-class resolution (`33` §6.4) | must be layered on top of its own resolution | not possible without abandoning its registers | same as Automerge | native |
| Concurrent values representable | **yes**, exposed via `conflicts()` | no — pure LWW, the loser is discarded | LWW registers | native: `Field::Conflicted` *is* the register state |
| History growth | monotonic | tombstones retained | **best off-the-shelf** — shallow snapshots trim history before a frontier, with the stated limitation that peers can only sync if they hold versions after that point | ours |
| Encrypted transport | Beelay is building exactly this, and is pre-alpha and unaudited by its own README | none | none | by construction |
| Battle-testing | **highest** | highest by deployment count | growing | **none. This is the only column that argues against, and it argues loudly** |
| Sequence CRDT | good | good | best | **not needed** |

**The decisive observation, and it is worth repeating because it is counter-intuitive:** the hardest
and largest part of every CRDT library is correct sequence interleaving, and Fathom has no long
ordered text. `proposals` on an IKE policy is a handful of names; address-set members are unordered;
`order_hint` on emitted lines is derived, not stored. We would import the expensive part and never
call it.

**DECISION — hand-rolled, four convergent types and no more:** grow-only set, add-wins observed-remove
set, multi-value register, last-writer-wins register. No sequence type, no counter, no text type, no
move operation.

**The cost, without softening:** we own the correctness argument, a convergence bug is a silent
data-loss bug, we own the performance work, interop is zero, and we must build the test apparatus a
library would have shipped with.

> **Reversal trigger, per `33` §4.5:** if the property tests cannot be made to pass within one
> milestone, **adopt Loro**, layer the per-class resolution on top of its registers, and accept the
> projection cost. Loro rather than Automerge because shallow snapshots are the one requirement a
> library must satisfy that we would otherwise have to build.

The cheapest confidence purchase in the whole programme is `33` §4.6's differential test: for the
subset where our semantics coincide with Automerge's — grow-only sets and LWW registers — run the
same op sequence through both and compare. It catches the class of bug where our concurrency
detection is subtly wrong, which is the class that ships.

---

### 6.4 D20 — Do we operate a hosted sync service?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R5 — customers come to depend on it |
| **Latest responsible moment** | Before the first customer conversation about hosting |
| **Current lean** | No. Self-host only (D2 and D3) |
| **Detail in** | `36` Q49; `37` §4–§5; `43` §5–§6 |

**The fork.**

| | Shape | Our legal position | Our operational position |
|---|---|---|---|
| **A** | **Self-host only.** We ship an image; the customer runs it | **Not a processor.** `36` Q49: "You operate the service; we supply software." A DPA here would be a fiction | Zero. No uptime, no on-call, no incident duty |
| **B** | **We host, ciphertext only** | **Processor**, of ciphertext plus metadata. GDPR Article 28 DPA, with the honest clauses in `37` §5 — including the ones where the answer to "assist the controller with data subject requests" is *"we cannot, because we cannot read it"* | Permanent. On-call for a service we cannot debug by looking at the data, because we cannot look at the data |
| **C** | A partner hosts | Depends entirely on the contract | We own the reputation and not the operations, which is the worst pairing |

**DECISION — A.** Two reasons, and the second one is the interesting one:

1. D01's lean is "tool", and hosting is the one activity that converts a tool into an organisation
   with obligations that do not stop.
2. **Zero-knowledge makes operations harder, not easier.** Every support conversation about a hosted
   Fathom is a conversation where the operator cannot see the thing being discussed. That is the
   posture working correctly, and it is also a support burden nobody has priced.

**Evidence that would change this.** A customer who wants sync, cannot self-host, and will pay for
it. That is a real market and D01 option E covers most of it via deployment services rather than
operations.

**Blast radius.** Adding hosting later is contractual and organisational, not architectural — the
protocol is identical. Removing it after customers depend on it is a migration for them, which is
the direction that costs.

---

## 7. Rank E — phase 6

*margin tab: build the cage first*

> **THE AI LAYER IS NEVER IN THE ARTIFACT PATH. IT PROPOSES; THE DETERMINISTIC CORE DISPOSES**

### 7.1 D21 — Does the AI layer ship in v1, and which tier is default?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R2 for the boundary; R5 for the default, because a default is a claim in a security review |
| **Latest responsible moment** | Phase 6a's start |
| **Current lean** | The boundary ships. No model ships in v1. Tier 0 is the default forever and the development default forever |
| **Detail in** | `21` §7; `71` §9 |

**The fork.** The owner's requirement is explicit and new relative to the architecture document:
*"There needs to be a supervisor AI and sub agents."* It has to be reconciled with brief §6.1's
*"deterministic — fuzzy matching plus a synonym map, no model at runtime"*, with invariant 1, with
invariant 9, and with a single offline file.

There are two separable questions and conflating them is how this goes wrong.

**Question one: does the *boundary* ship?** The boundary is phase 6a: the `resolve()` dispatch with
the model arm unreachable and the compiler proving it, the `Proposal` type and its three verbs, the
tool broker and capability grants, the audit record, `fathom-verify` which never links `fathom-ai`,
and the `xtask check-deps` edge asserting nothing depends on `fathom-ai`. Plus the
under-determination surface, which is the deterministic answer to the four `Underdetermined` cases
and is a good product on its own.

| | Boundary in v1 | Not in v1 |
|---|---|---|
| Cost | 4–6 solo weeks | Zero |
| Buys | The owner's requirement is architecturally satisfied and testable *without a model existing*. Ordering principle O3: land the shape early, narrow | Nothing |
| Costs later | — | **Retrofitting a boundary around a model that already ships is how the model ends up in the artifact path.** That is the one failure mode X6.1 exists to catch |

**Question two: does a *model* ship, and at which tier?**

| Tier | Egress | Zero-knowledge | Offline | Single file | Default? |
|---|---|---|---|---|---|
| **0 — no AI** | none | intact | yes | yes | **yes** |
| **1 — BYOK hosted** | one configured origin | **broken for what is sent** | no | no | no — explicit per-workspace opt-in |
| **2a — in-page WebGPU** | none | intact | yes | yes | no — requires the user to supply weights from a local file |
| **2b — loopback sidecar** | none | intact | yes | no | no — requires a process install |
| **3 — enterprise self-hosted** | one operator origin | intact w.r.t. third parties | no | no | no — operator-provisioned |

**DECISION — the boundary ships; no model ships in v1; tier 0 is the default and stays the default.**

Three reasons:

1. **The reproducibility guarantee is identical at every tier**, because the model cannot emit a line
   of config, fire a finding, or change a ranking. That means shipping the boundary without a model
   loses nothing a user can observe, and shipping a model without the boundary loses everything.
2. **Tier 0 must stay the build the team develops against day to day.** `21` §7.1 states the rot
   mechanism precisely: the moment tier 1 becomes the development default, the under-determination
   surface stops being tuned, someone puts a feature behind an AI call, and the offline single file
   becomes a demo. `71`'s X6.4 makes it an exit criterion; it belongs in the definition of done for
   every PR after phase 6, not only in that phase.
3. **The first tier with a model should be 2b, not 1** — because 2b keeps every invariant, so it can
   ship before the consent UI, the redaction profiles, the pre-flight, the armed-state indicator and
   the egress log exist, and those are most of tier 1's work and none of them are model work. Also
   because a llama.cpp-class sidecar supports grammar-constrained decoding, which removes an entire
   failure class, and building the broker against a client that *cannot* emit malformed tool calls
   means the broker's rejection paths get tested deliberately rather than discovered.

**The honest cost of tier 2b first:** a tier that requires a local install will have a fraction of
tier 1's reach. That is accepted.

**Evidence that would change this.**

| Signal | Action |
|---|---|
| After a full release cycle, no pilot user can point to a decision the AI layer improved | `71` §12.7: ship tier 0 and stop. The owner's requirement is satisfied by an architecture that *supports* the layer, which exists either way |
| `shadow_rule_rate` shows subagents routinely producing rule-shaped output | Narrow the subagent or write the rule. This is admission criterion A1 working, not failing |
| X6.1 fails — artifacts differ between AI-on and AI-off sessions | Stop and fix the boundary. Everything else in the phase is worthless if the model can touch the artifact path |
| Tier 0's acceptance suite has been quietly weakened to accommodate an AI-dependent feature | Revert the feature. The rot has started |

**Blast radius if reversed later.** Shipping tier 1 as a default is the expensive reversal: the
security documentation changes, `31`'s threat model gains a section, the consent and pre-flight UI
becomes mandatory, the CSP gains an origin in the shipped build, and `36`'s enterprise answers change
in the specific place they are strongest. Removing tier 1 after shipping it is a feature removal from
users who adopted it.

---

### 7.2 D22 — Is the localhost inference sidecar permitted, and in which shape?

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R2, plus a new distributable, which is R5-adjacent once shipped |
| **Latest responsible moment** | Phase 6b's start |
| **Current lean** | Not in v1. When it exists, shape C — a native shell that owns the sidecar as a child process |
| **Detail in** | `24` §3.5–§3.7; `21` §7.3 |

**The fork.** A sidecar means a model process on the user's machine reached over loopback. Four
shapes, plus "no".

| | **A · hosted page → user's sidecar** | **B · browser extension** | **C · native shell** | **D · loopback-only build flavour** | **E · not permitted** |
|---|---|---|---|---|---|
| `connect-src 'none'` survives | no | no | **yes — the webview never makes the request** | no | yes |
| Local Network Access prompt | **yes, and denial is sticky** | different handling <!-- VERIFY: confirm LNA's treatment of extension-origin requests to loopback in current Chromium. --> | not applicable | probably not | n/a |
| CORS config the user must do | must add our remote origin; the path of least resistance is `*` | Ollama documents `chrome-extension://*`, which allows **every** extension | **none — we own the process** | must add our loopback origin | none |
| DNS rebinding exposure | full, **and we caused the sidecar to exist** | full | **none** | full, against a sidecar the user chose | none |
| Model identity | `Advertised` | `Advertised` | **`Verified` — we hash the weights we hand it** | `Advertised` | n/a |
| New distributable | none | one per store, per browser | **one per OS, signed and notarised** | one archive | none |
| Update channel | ours | **store review** | ours | ours | n/a |

**DECISION — E for v1. C when D21 says a model ships. A is rejected outright.**

Why A is rejected, and it is not an engineering argument: *"this site wants to access devices on your
local network"* is a prompt a network engineer will deny, and should. Designing a core capability
behind a prompt this product's own audience is trained to refuse is designing a feature that does not
ship. Worse, A makes us the reason a user widens their sidecar's CORS — the instruction
`OLLAMA_ORIGINS=https://<our-origin>` is one copy-paste away from `OLLAMA_ORIGINS=*`, and if our
documentation is the reason an unauthenticated local model server is exposed, we own a share of that.

Why C, and why it is expensive: it is the only shape in which the security claim that took the most
work to earn does not have to be renegotiated. It also puts both DNS-rebinding defences in our hands
rather than in a documentation step the user can skip: an ephemeral loopback port, a per-launch
bearer token, and a CORS allowlist of exactly one origin.

**The cost, and it is the contradiction from D07 arriving:** C is a desktop application. Three OS
artifacts, two notarisation paths, and the standing temptation of an update channel that `31` §7
forbids — *"no silent auto-update, in any build. An auto-updater is a signed remote code execution
channel."* `43` §3.5 rejected the desktop bundle for exactly these reasons and its reasoning has not
changed. **The resolution proposed in D07 stands: the shell is the AI transport, not the offline
mode; it is a fourth artifact; and it exists only if D21 says a model ships.** If D21's answer is "no
model in v1", D22 costs nothing to answer and the desktop question disappears with it.

**Evidence that would change this.** If Private Network Access / Local Network Access preflighting
settles somewhere that makes shape D genuinely frictionless for a locally-served origin, D becomes
the cheap answer and C becomes optional. <!-- VERIFY: this has moved repeatedly in Chromium and Safari; check the current requirement before phase 6b, because it determines whether a served origin can reach a user's sidecar at all. -->

---

## 8. Rank F — phase 7

*margin tab: the entire bet*

### 8.1 D23 — The second platform, and when

| | |
|---|---|
| **Kind** | DECISION |
| **R** | R4 if the schema breaks; R2 if it merely bends |
| **Latest responsible moment** | Before phase 6 starts, per `71` open decision 2 |
| **Current lean** | PAN-OS, and a read-only ingest spike pulled forward into phase 2 |
| **Detail in** | `71` §10; `13` §8 |

**The fork.** Brief §5.1: *"This schema is the entire bet of the project."* Phase 7 is where the bet
settles, and the choice of platform decides how fast and how honestly it settles.

**Terminology note:** the assignment for this document says "the second vendor". The binding
convention reserves **platform** for a vendor+family target and notes that a vendor has many
platforms. This section says *platform*. Recorded in §13.

| Candidate | Architectural information it yields | Commercial pull | Verdict |
|---|---|---|---|
| **`panos`** | **Structural divergence, not lexical.** Junos decomposes a VPN into six named objects; PAN-OS folds `ipsec proposal` and `ipsec policy` into one crypto profile, so two graph nodes map to one platform object and two emitters must agree on a derived name. PFS lives on a different object entirely. And the absence-encoding trap: on Junos "no PFS" is the *absence* of a statement, while PAN-OS requires an explicit no-PFS selection | mid | **Second.** It attacks the schema's shape most directly |
| **`ios-xe`** | Tests **ordering** hard — a transform-set reference is rejected unless the transform-set was entered first, a constraint Junos does not have. Also tests selectors: a VTI's IPsec SA selector is always `IP any any` and VTIs do not support narrowing, so the graph's `TrafficSelector` nodes have no representation at all | high | **Third.** A real test, but more of the emitter's ordering machinery than of the schema's shape |
| **`fortios`** | Config is a regular `config / edit / set / next / end` tree — the *easiest* of the four to parse | **highest in the mid-market** | **Later.** Choosing it second optimises for sales and learns the least |
| **A second *domain* on Junos** (BGP, NAT, HA) | Tests the schema on the **other axis**: does the IR generalise beyond IPsec? | low | Not a substitute. R-SCHEMA is specifically the risk that the IR is a Junos model with a `platform` field, and only a second platform tests that |

**DECISION — PAN-OS**, on the grounds that it tells us fastest whether the schema is wrong.
`71` §10.2 states the counter-argument fairly and it should be restated here rather than buried: if
the goal is adoption rather than architecture, IOS-XE has the larger installed base and is the
commercial choice. **If D01 lands on "business", invert this decision knowingly and write down that
you did.**

**The falsifiable claim that makes the phase a test rather than a feature:** *PAN-OS site-to-site
IPsec requires zero new node kinds.* Fields may move, edges may be added, the extension bag may take
genuinely platform-local values. A **new kind** means the graph modelled Junos objects rather than
networking concepts.

**PROPOSED CHANGE to `71` — pull a read-only PAN-OS ingest spike forward into phase 2.**

The argument: R-SCHEMA is the most severe unretired risk in the project and it is currently settled
last, because settling it properly requires a second platform's entire content programme. But most of
the signal does not require the content programme. **The schema breaks on ingest before it breaks on
emit**, because ingest is where a real configuration's structures meet the graph's kinds, and
`71` §12.3 already names the symptom: *"residue concentrated in structures rather than statements —
configs organised in ways the schema has no shape for."*

| | Full phase 7 | **A read-only ingest spike in phase 2** |
|---|---|---|
| Scope | Parser, emitter, statement tables, rules with `platforms: [panos]`, corpus, conformance | Parser and binding only. Three or four real PAN-OS IPsec configurations, bound into the graph, residue measured. No emitter, no corpus, no rules |
| Effort | 12–18 solo weeks | **2–3 solo weeks** |
| Signal | Definitive | *"Did any of these configs need a node kind we do not have?"* — which is the phase's entire thesis |
| Risk of doing it | It costs 2–3 weeks and might tell us nothing new | |

If the spike comes back clean, phase 7 proceeds as planned with materially less uncertainty. If it
comes back with new kinds, `71` §11.3's reorder — phase 7 before phase 6 — fires eighteen months
earlier than it otherwise would, and the redesign happens before the AI layer's tool contracts,
graph projections and eval sets have to be repaired along with it.

**Evidence that would change the platform choice.**

| Signal | Action |
|---|---|
| The ingest spike shows PAN-OS needs new kinds | The bet is already lost. Choose deliberately between redesigning the IR with two platforms in view (60–70% of phase 1 repeated) and repositioning as a Junos tool that reads other platforms. Both are legitimate; pretending it did not happen is not |
| Phase 2's real-config bind rate on Junos lands near the bottom of its range | `71` §11.3: swap phases 6 and 7 |
| A customer with FortiOS appears and D01 is "business" | Invert on commercial grounds, in writing |
| `Representability::Composed` exceeds ~10% of emitted lines on platform two | The mapping has judgement in it the user cannot follow. Narrow the claim or invest in making composition explicable |

---

## 9. Closed — decisions this register does not reopen

*margin tab: the no-list*

These are settled by the brief, by `conventions.md`, or by an argued decision in a sibling document.
They appear here so that the register is complete and so that nobody spends a week re-deriving one.
A future document proposing any of them is proposing a different product and should say so.

| Settled | By | The one-line reason |
|---|---|---|
| No connection to a network device, ever. No SSH, no NETCONF, no gNMI, no vendor API | Invariant 2, brief §1 | The moment the tool can reach a device it needs device credentials, and invariant 3 goes with it |
| The application never accepts a credential | Invariant 3, brief §6.2 | Removes the highest-value secret from the application entirely; shrinks the threat model more than any cryptographic control |
| No egress by default; no telemetry, no analytics, no font CDN, no error reporting | Invariant 1 | It is also why there is no adoption metric, and that cost is accepted |
| The server never holds a key | Invariant 4 | The whole zero-knowledge posture |
| Findings are data, not code; one engine; no per-vendor engines | Invariant 5, brief §5.2 | `N` platforms × `M` domains grows linearly or the corpus becomes unmaintainable |
| Emitters return `(line, provenance)` pairs, never strings | Invariant 6, brief §5.3 | Costs almost nothing on day one and is expensive to retrofit. It is the mechanism that makes teaching structural |
| Every node, edge and field carries a stable opaque ID; references are by ID, never by path or name | Invariant 7 | Renaming a device must not invalidate a rule, a suppression or a diagram element |
| `acceptable_when` is mandatory on every rule | Invariant 8, brief §5.2 | Tools that flag everything as critical are muted within a week |
| Determinism where it is observable | Invariant 9 | It is what makes a result shareable in a change ticket and a release diffable |
| The corpus is human-authored and reviewed, with a named `reviewed_by` | Invariant 10 | The build fails on the literal string `<named human>` |
| Exactly three risk values: `ReadOnly`, `ChangesConfig`, `Disruptive` | Conventions; design language | The card holds this line across four sides. It is the single most disciplined thing in the design |
| Inventory and the intent model are the same schema | Brief §6.4 | One model, partially populated. It is what lets the inventory have opinions |
| Inventory as a document, not a database | Brief §6.4 | Client-side and encrypted; git-versionable, diffable, portable. No Postgres, no migrations, no ORM |
| The diagram is a view and a design tool, never a source of truth | Brief §6.5 | Claiming it records what exists invites the rot of §2.2 |
| No plugin system that executes third-party code | `35`, invariant 5 | It would defeat the CSP, the supply chain story and the reproducibility claim in one move |
| No personalised or learned ranking | `16` §1.1 | Two engineers on the same corpus version must get the same list |
| No "apply this fix for me" | Invariant 2 | The tool produces text; a human decides and pastes |
| No silent auto-update, in any build | `31` §7 | An auto-updater is a signed remote code execution channel |
| No hosted multi-tenant SaaS holding plaintext | Brief §1, §7 | It is the product the security posture exists to not be |

---

## 10. How to answer one, and where the answer lives

*margin tab: the record*

`docs/90-decisions/` exists and is empty. It is where answers go.

### 10.1 The file

One file per answered decision, named for the register ID so that this document remains the index:

```
docs/90-decisions/D05-ir-shape.md
docs/90-decisions/D03-licence.md
```

### 10.2 The shape

```markdown
# D05 — The IR shape, and whether edges are first-class

> **Status:** Accepted
> **Decided:** 2026-08-14
> **Decided by:** <name>
> **Supersedes:** —
> **Register entry:** docs/70-ops/73-open-decisions.md §3.5

## The answer
First-class typed edges. Node fields never hold a NodeId.

## What was rejected, and the strongest argument for it
Typed document tree. Its strongest argument is that emitter field reads
are infallible, and that argument is real — see the codegen mitigation.

## What would make this wrong
The first 40 authored rules turn out to be node-local. (They are not:
zone.host-inbound.ike-missing is relational.)

## Reversal cost as decided
R4. Named consequences: fathom-graph's API, every emitter accessor,
fex's name environment and therefore every authored rule, the CRDT op
set, the Edges shard class, every suppression referencing an edge ID.

## Review trigger
Phase 2 residue analysis; phase 7's zero-new-kinds claim.
```

Five headings and a header block. Anything longer is a specification and belongs in the numbered
documents, not here.

### 10.3 Three rules about the record

| Rule | Why |
|---|---|
| **The rejected option's strongest argument is recorded, in its own words** | A decision record that only argues for the winner is advocacy. Six months later the question is always *"did we know about X?"*, and the answer has to be checkable |
| **"What would make this wrong" is written before the decision is taken** | Otherwise it is written after the evidence arrives, and it will be written to exclude it |
| **A superseding decision links backwards; the old file is never deleted** | `Status: Superseded by D05a`. The history of a fork is more useful than its current state, because the same argument returns |

### 10.4 Cadence

Review this register at every phase boundary, and at those points only. Two questions per decision:
has its trigger fired, and has its evidence arrived. Side 4 of the field card, on debugging:
*"Correlate before you theorise."* A register reviewed continuously becomes a discussion; a register
reviewed at phase boundaries becomes a checklist.

---

## 11. The decisions that are secretly one decision

*margin tab: coupling*

Four clusters. Answering one member of a cluster answers or constrains the others, and answering them
in the wrong order produces an answer that has to be redone.

| Cluster | Members | The coupling |
|---|---|---|
| **The commercial cluster** | D01 → D03 → D12 → D20, and D23's tiebreak | The licence is how "business or tool" becomes irreversible. Publication is how the licence becomes irreversible. Hosting is what a business needs and a tool does not. And if D01 is "business", D23's platform choice inverts on commercial grounds |
| **The scope cluster** | D02 → D17, D18, D21, D22 | "In v1" is meaningless until v1 is defined. If v1 is phase 0, four of these decisions answer themselves and the register shortens by a quarter |
| **The desktop cluster** | D07 ↔ D21 ↔ D22 | `43` rejects the desktop bundle; `24` requires it for the sidecar. The knot unties in one direction only: no model in v1 → no sidecar in v1 → no desktop artifact in v1. Deciding D22 before D21 ties it the wrong way |
| **The graph cluster** | D05 → D06 → D15 → D16 → D18/D19 | Edges being first-class defines `fex`'s name environment; the name environment is what rules are authored against; rules and edges are what the record model shards; the record model is what the format promise covers; the op set is what the CRDT converges. Every arrow is one-way |

The one ordering error to avoid above all others: **do not freeze `fex`'s name environment before
D05 is answered.** Rules cost 60–90 minutes each including fixtures. Code written against the wrong
graph shape is rewritten in a week; two hundred rules authored against the wrong name environment is
a season.

---

## 12. Sources

| Claim | Source |
|---|---|
| The `DECISION` / `RECOMMENDATION` convention and its meaning | Brief, *"How to read this document"* |
| "This schema is the entire bet of the project" | Brief §5.1 |
| The five stopping points and their effort ranges | `docs/70-ops/71-roadmap.md` §2 |
| Every kill point and reversal trigger quoted in §3–§8 | `docs/70-ops/71-roadmap.md` §§11.3, 12.1–12.9, 13.1–13.2, 16 |
| IR shape options and the first-class-edge argument | `docs/10-core/11-ir-schema.md` §§3.1–3.5, 14.4 |
| Condition-language candidates, the read-set requirement, `fex`'s cost | `docs/10-core/12-rule-engine.md` §3 |
| D1–D4 deployment modes; the single-file storage decision; the desktop-bundle rejection | `docs/40-stack/43-deployment-modes.md` §§1.1–1.5, 3.4–3.8 |
| UI framework comparison, the Rust-native UI analysis, the render-layer cap | `docs/40-stack/41-technology-choices.md` §§4.2–4.5, 9.2, 10 |
| The npm/Node build position, the `oxc` transform and the Go-native type-check gate | `docs/40-stack/42-no-node-runtime.md` §§2, 3, 7, 11 |
| Record-granularity trade table and the sharded decision | `docs/30-security/32-cryptography.md` §6 |
| CRDT library comparison, the four convergent types, the Loro reversal trigger | `docs/30-security/33-sync-protocol.md` §§4.1–4.6, 5.1, 6.4 |
| AI tier table, tier-0 rot argument, sidecar frictions | `docs/20-ai/21-ai-layer-architecture.md` §7 |
| Sidecar shapes A–D and the native-shell decision | `docs/20-ai/24-ai-determinism-and-offline.md` §§3.5–3.7 |
| Community contribution analysis and the corpus rot model | `docs/10-core/15-explainer-corpus.md` §§12.5, 13.1–13.6 |
| Licence position from the enterprise review's side; the no-hostage-taking argument | `docs/30-security/36-enterprise-review-qa.md` Q49, Q50, Q51 |
| Processor status per deployment shape | `docs/30-security/37-privacy-and-compliance.md` §§4–5 |
| PFS asymmetry ("Phase 2 fails while Phase 1 stays up"), the five plumbing pieces, the `clear security ike` blast radius, `inactive-tunnels`, `NO_PROPOSAL_CHOSEN`, the `on-traffic` / `responder-only` deadlock | `.context/field-card-srx-ipsec.txt`, sides 1–4 |
| "Correlate before you theorise" | Field card side 4, *BOX-LEVEL CONTEXT* |
| Fathom Analytics — privacy-focused web analytics, bootstrapped, `usefathom/fathom` | [usefathom.com](https://usefathom.com/); [github.com/usefathom/fathom](https://github.com/usefathom/fathom) |
| Fathom — AI meeting notetaker, fathom.video moving to fathom.ai | [fathom.video](https://fathom.video/) |
| Fathom5 — Austin industrial technology, maritime cybersecurity, cyber-physical testbeds, stated 17 patents across cybersecurity and actuator technology | [fathom5.com](https://www.fathom5.com/); [Fathom5 principal-scientist appointment release](https://www.prnewswire.com/news-releases/fathom5-appoints-dr-sunny-fugate-as-principal-scientist-for-cybersecurity--ai-302420612.html) |
| AFT Fathom — pipe-flow modelling, released 1994, and its own account of the naming decision | [aft.com — where the name Fathom came from](https://www.aft.com/blog/where-did-the-name-fathom-come-from); [datacor.com/products/fathom](https://www.datacor.com/products/fathom) |
| Multiple registered `FATHOM` marks, including one covering computer networking hardware | [Justia trademark listings for FATHOM](https://trademarks.justia.com/888/92/fathom-88892933.html) <!-- VERIFY: a Justia summary is a pointer. Pull live status, class and goods from USPTO TSDR and EUIPO before any name is adopted. --> |
| BUSL is source-available, not OSI-approved, and converts to an open licence at a Change Date | [Business Source License — Wikipedia](https://en.wikipedia.org/wiki/Business_Source_License); [FOSSA — BSL requirements and history](https://fossa.com/blog/business-source-license-requirements-provisions-history/) |
| Source-available licence landscape (BUSL, Elastic-2.0, PolyForm, FSL) and their non-OSI status | [FOSSA — guide to source-available licences](https://fossa.com/blog/comprehensive-guide-source-available-software-licenses/); [Goodwin — trends in source-available licensing](https://www.goodwinlaw.com/en/insights/publications/2024/09/insights-practices-moving-away-from-open-source-trends-in-licensing) |
| Elastic's relicensing history and Kibana's triple licence including AGPL | [Kibana — Wikipedia](https://en.wikipedia.org/wiki/Kibana); [Pureinsights — Elastic's journey from Apache 2.0 to AGPL 3](https://pureinsights.com/blog/2024/elastics-journey-from-apache-2-0-to-agpl-3/) |
| AGPL-3.0 / Apache-2.0 compatibility direction | [FOSSA — AGPL-3.0 vs Apache-2.0 compatibility](https://fossa.com/resources/devops-tools/license-compatibility-checker/agpl-3-0-vs-apache-2-0/) |

Licence texts are cited by name and section (Apache-2.0 §3; AGPL-3.0 §§11, 13; GPL-3.0 §11) rather
than by a link, because the canonical text is the authority and a summary is not.

---

## 13. Disagreements

**1. Terminology — "vendor" versus "platform" (D23).** The assignment for this document says "the
second vendor". `conventions.md` reserves **platform** for a vendor+family target and states that a
vendor has many platforms. This document says *platform* throughout. No substantive disagreement;
recorded so the substitution is not read as drift. `71` §18 records the identical substitution.

**2. Proposed change to `43` §3.5 and `24` §3.7 — the desktop artifact.** These two documents are in
direct conflict: `43` recommends rejecting the signed desktop bundle, and `24` decides a native shell
is the primary sidecar answer. This document proposes the reconciliation in D07 and D22 — the shell
is the AI transport, not the offline mode; it is a fourth artifact; and it exists only if a model
ships. Both documents should carry the amendment at their next edit. Neither is wrong within its own
scope, which is exactly how this kind of conflict survives review.

**3. Proposed change to `71` phase 5 — unbundle multi-writer from the crypto (D18).** `71` phase 5
delivers encryption, workspaces and sync as one phase retiring R-ZK and R-CRDT together. This
document proposes that multi-writer convergence is separable and should not be in the first sync
release: the op log, the record model and the format are unchanged either way, and R-CRDT's failure
mode is silent data loss on a firewall policy. Phase 5 becomes "encryption and workspaces, retiring
R-ZK"; R-CRDT moves to a later phase gated on the evidence in D18.

**4. Proposed change to `71` phase 7 — pull a read-only PAN-OS ingest spike into phase 2 (D23).**
2–3 solo weeks against a 12–18 week phase, to get most of the R-SCHEMA signal eighteen months
earlier, on the grounds that the schema breaks on ingest before it breaks on emit. `71` §11.3's
reorder already exists as a contingency; this makes its trigger measurable rather than inferred.

**5. Proposed change to `conventions.md` § *Identifiers* — decouple the ID namespace from the product
name (D04).** The convention specifies node IDs as `fathom:<kind-lower>:<ulid>`. Because the brief
explicitly calls the name a placeholder, and because every ID ever minted is written into files that
invariant 7 says must stay stable forever, the product name should not be in the identifier. Proposed
replacement: `<kind-lower>:<ulid>`, or a fixed non-word prefix. This is the only convention this
document proposes changing, and it costs nothing to change before `fathom-id`'s first commit.

**6. No disagreement with any hard invariant or with the risk enum.** §9 enumerates them as
permanent product boundaries rather than as constraints to be managed, which is how they are treated
throughout.

---

## 14. Escalations from execution sessions

> **Status:** Live. Seven rows. Three came from WO-06's execution on 2026-08-08: E-01 is answered in
> place, and the two `16` spec gaps are open, and open for **planning** rather than for the owner.
> Two came from WO-05's on 2026-08-08 — both format questions the work order itself classes as
> planning-only, and both stopped that session before its first plan step. **Both were answered in
> place later the same day** and WO-05 is OPEN again; the answering session did not execute the
> order it unblocked (`78` §5 item 10). **One came from WO-09's on 2026-08-08**, at its first plan
> step, and it is a third format question against the same file the two WO-05 rows are about —
> `fathom-workspace`'s canonical face is now the tree's most escalated surface, which is itself
> worth planning's attention. **That row was answered the same day (`17` §15.6) and a seventh
> arrived on 2026-08-08 from WO-09's second run**, at plan step 9: the junos-srx dictionary and the
> schema disagree about `InterfaceLike.name`'s type, which no gate in the tree compares. Four of
> seven rows answered, three open — the two `16` spec gaps and the type disagreement, all for
> planning.
>
> The two spec-gap rows carry `2026-08-02` — the date WO-06 §4.5 pre-authored them, not the date
> they were filed. §4.5 requires them verbatim, so the executing session was right not to restamp
> them. **The defect is in pre-authoring a dated row at all:** `78` §4 step 3's date is *when a
> session hit the thing*, which an order cannot know in advance. Planning to fix in §4.5's text, not
> in the rows.

*margin tab: the inbox (`78` §4)*

### 14.1 What this is, and why it is at the end of the file

The destination `78` §4 step 3 names for escalations raised by **execution sessions**: where a
session that hits something its work order does not decide stops and files, rather than deciding.
`78` §4's opening states the principle — *"Escalating is success. Deciding is the defect."* `78` §5's
ten prohibitions and §4's seven triggers are what stop a session; this is where it files.

It sits after §13 because `78` §4 step 3 says *"at the end of the file"*. That is the protocol's
instruction, not a house-style lapse, and it should not be "fixed".

**The form below is `78` §4 step 3's, verbatim, and this section previously got it wrong.** It was
created on 2026-08-07 by a planning session because nine places in the tree already routed here and
the section did not exist — two of them code comments an executing session would have written into
shipped source. That was the right problem to fix and the wrong way to fix it: the planning session
invented a five-column form with `E-nn` identifiers instead of transcribing the four columns `78`
§4 step 3 specifies, and titled the section *"The escalation register"* instead of the title the
protocol names. WO-06 §4.5 was transcribing the protocol correctly; the first session to execute a
work order stopped on the collision (§7 trigger 7) before touching a deliverable. **The protocol
was right and the drive-by fix was wrong**; the drive-by is what has been changed. Recorded here
rather than quietly corrected, because the failure — a planning session doing work the queue
already owned, in a form it invented — is the more useful artifact.

### 14.2 The inbox

`78` §4 step 3: *"append a row — date, work order, the question in one line, `"detail in WO-nn §
Open decisions"` — to a table under `## 14. Escalations from execution sessions` at the end of the
file, creating the section (and its contents-table row) on first use."*

The row is deliberately thin. The detail lives in the work order's own **Open decisions** section
and is not duplicated here, so there is one place to maintain and one place to read.

| Date | Work order | Question | Detail |
|---|---|---|---|
| 2026-08-08 | WO-06 | How §4.5's two pre-authored rows are filed, now that §14 exists in a form §4.5 does not expect | detail in WO-06 § Open decisions (§10.5) |
| 2026-08-02 | WO-06 | `16` §5.2's formula has no query-side term weight, but §4.1 step 7's 0.6 must apply to query-emitted sub-tokens or a hyphenated query token scores as three whole terms — amend §5.2 to carry the factor, or order its removal with a golden re-run | detail in WO-06 § Open decisions |
| 2026-08-02 | WO-06 | `16` §13 expects trace B's exact leaf to outrank its `detail` form on syntax, but §6.4 ties equal-cover keys and §6.2's `Ŝ_prefix` cannot fire for that query; R09's canonicality change also post-dates the trace — rewrite §13's trace to the implemented arithmetic, or spec a key-length tie-break in §6.4 under §8.5's golden-delta discipline | detail in WO-06 § Open decisions |
| 2026-08-08 | WO-05 | WO-01 reshaped seven registry slot types (`EncryptionAlgorithm`, `IntegrityAlgorithm`, `AuthMethod`, `IkeVersion`, `RouteDistinguisher`, `RouteTarget`, `SecretPlaceholder`) into shapes no row of §4.2's wire table admits, and rule 8 would now silently drop `SecretPlaceholder`'s label — re-cut the table over the post-WO-01 `scalar.rs`, deciding `SecretPlaceholder`'s plaintext wire form explicitly | detail in WO-05 § Open decisions (§10.6) |
| 2026-08-08 | WO-05 | §4.4's pinned vector and §4.5's two ULID-refusal inputs render ids as `fathom:device:<ulid>`, which `Display` in `fathom-graph/src/id.rs`, `.context/conventions.md` § *Identifiers* and ADR-0005 all refuse — re-issue the vector against the rendering the tree emits, or reopen ADR-0005 | detail in WO-05 § Open decisions (§10.7) |
| 2026-08-08 | WO-09 | `Origin` is serialised as a bare JSON string by `fathom-workspace`'s canonical plaintext face (writer `lib.rs:329`, reader `lib.rs:617`), so the payload-bearing `Origin::Parsed { capture, span }` the order requires cannot be written or read — decide `Parsed`'s wire form against WO-05 §4.4's byte-identical round trip, and add `crates/fathom-workspace/src/lib.rs` to WO-09 §4's Deliverables table | detail in WO-09 § Open decisions (§10.8) — **ANSWERED 2026-08-08**: `17` §15.6 |
| 2026-08-08 | WO-09 | `corpus/dict/junos-srx/interfaces.yaml:13` binds `InterfaceLike.name` as `scalar: Identifier` while `schema/schema.yaml` declares it `InterfaceName` on all four interface kinds, so the first call to put ingest and the store together refuses the shipped fixture with `SlotType { key: 55 }` — decide whether the schema moves, the dictionary and `BoundValue` move, or the weld converts, and whether a dictionary-load gate compares a `scalar:` against the declared type at all | detail in WO-09 § Open decisions (§10.9) — **ANSWERED 2026-08-08**: option (b) + (d) |

**Answered — both WO-05 rows, 2026-08-08, planning.** The detail is in WO-05 §10.6 and §10.7,
where the rows already point; repeating it here would be the duplication §14.2 exists to avoid.
In one line each. **The wire table:** re-cut against the `Scalar` trait rather than patched
type-by-type — a type implementing `fathom_ir::scalar::Scalar` wires as `Str` of its
`canonical()` (new rule 13, all 35), rules 3/4/5/7 retire into it, and `SecretPlaceholder`, the
one registered exemption, gets its own rule 14 carrying **both** its label and its hint, because
`{}` would have emitted `<PSK>` into a TACACS field after a save and load, and destroyed the
operator's note of where the real secret lives. **The pinned vector:** re-issued as
`device:<ulid>`, ADR-0005 **not** reopened — three sites in the tree already agree and only WO-05
disagreed with itself. WO-05's status line and its queue row are OPEN; executing it is a later
session's (`78` §5 item 10).

**Answered — E-01, 2026-08-08, planning.** Option A of the four §10.5 enumerates. `78` §4 step 3
specifies both the section title and the four columns; WO-06 §4.5 transcribes them and this section
did not. The conflicting form is replaced above rather than merged, so §4.5 executes as written.
The two rows §4.5 pre-authors land in this table in `78` §4 step 3's form when WO-06 runs. **Do not
re-open on the grounds that the thin row loses information**: that is the protocol's design, and
§14.4 records what it costs.

### 14.3 What is already known to land here

WO-06 names four filings its execution will produce, each pinned by a test comment so the
contradiction is visible in source rather than only in prose: the `78` §4 inbox-width question, the
ranking-formula gap, the tie-break contradiction, and the leaf-ordering under-specification. These
are **not** pre-filed. A register that lists escalations before the session that raises them records
what planning predicted, not what building hit.

### 14.4 Three things this section does not decide

1. **How escalations are triaged.** `78` §12 leaves open *"whether `73` §14 escalations are triaged
   into D-numbered register entries or answered in place"*, and `88` §6.11 proposes an answer — that
   they be answered as ADRs. The three answered rows above are answered **in place**, which is not
   a ruling on that question; it is the smallest thing that unblocks a stopped order — and in the
   WO-05 cases the answer edits the work order's own §4, so an ADR would have been a third copy of
   a format the order already owns (§ *Precedence*). `78` §4 step 3's *"do not touch
   `73`'s register; D-numbers are planning work"* still holds.
2. **Who answers.** `78` §7's test decides per row.
3. **Whether an escalation row needs a citable identifier.** `78` §4 step 3's four columns have
   none, so a row can only be cited by date and work order. The 2026-08-07 session invented `E-nn`
   to solve this and thereby created E-01. The need may be real; inventing a column to meet it,
   outside the protocol that specifies the table, is not how it gets solved. Amending `78` is
   planning work and nobody has proposed it.
