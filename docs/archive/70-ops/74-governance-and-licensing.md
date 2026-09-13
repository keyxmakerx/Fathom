# 74 — Governance and licensing

> **Status:** Proposed

Companion documents: `docs/30-security/35-supply-chain-and-builds.md` (reproducible builds,
signing, the bus-factor controls this document extends), `docs/30-security/36-enterprise-review-qa.md`
(the questions a legal and security review actually asks), `docs/30-security/37-privacy-and-compliance.md`
(a different subject: what data exists, not who owns it), `docs/60-content/61-command-corpus-spec.md`
and `docs/60-content/63-rulepack-spec.md` (the artifacts §4 and §5 licence),
`docs/10-core/15-explainer-corpus.md` §§12–13 (the corpus as a programme, and its rot model),
`docs/70-ops/72-risks.md` §§4, 6, 10 (the content problem, correctness liability, bus factor),
`docs/00-vision/02-prior-art-and-positioning.md` (who the licence is defending against),
`docs/00-vision/03-non-goals-and-scope.md` (what a governance body is not allowed to expand into).

This document decides who owns what, under which terms, who may change it, and what happens
when nobody is left to answer. It does not re-specify any mechanism: where signing, builds or
key rotation appear here, they are specified in `35` and cited.

---

## 0. Contents

| § | |
|---|---|
| 1 | How to read this, and the governing rule |
| 2 | What governance has to buy |
| 3 | The artifacts, because they are not one thing |
| 4 | Code licence analysis — five candidates |
| 5 | **RECOMMENDATION** — the code licence, and what it costs |
| 6 | The corpus is content, not code |
| 7 | The vendor-documentation problem |
| 8 | Contribution model |
| 9 | Review, merge rights and the named-expert rule |
| 10 | Security governance |
| 11 | Project continuity |
| 12 | Trademark and naming |
| 13 | Governance structure, honestly |
| 14 | What all of this costs |
| 15 | Decisions this document asks for |
| 16 | Sources consulted |
| 17 | Disagreements |

---

## 1. How to read this, and the governing rule

*margin tab: read this first*

> **A LICENCE IS THE ONLY PART OF THE TRUST STORY THAT SURVIVES THE AUTHOR**

Every other claim this project makes about trustworthiness — zero-knowledge storage, no egress,
reproducible builds, a reviewed corpus — is a claim about behaviour, and behaviour is a promise
by whoever is currently running the project. The licence and the governance rules are the only
part that continues to bind after the current maintainer stops caring, sells, or dies. That is
why this document sits in `70-ops` and not in an appendix.

A second framing, which drives §§4–5. Fathom's differentiator is that a security-conscious
organisation can *check* it rather than trust it: read the source, reproduce the build, compare
the hash, run it offline with the network cable out. Every licence choice below is scored first
on whether it preserves that check, and only second on whether it protects a business.

### 1.1 Not legal advice

Nothing here is legal advice and none of it has been reviewed by a lawyer. Every item marked
**DECISION** in §15 needs counsel before it is executed. The analysis is written so counsel can
be given a specific question rather than an open one, which is the only way to get a cheap
answer.

---

## 2. What governance has to buy

Governance documents fail when they are written as ceremony. This one has five jobs, and any
rule below that does not serve one of them should be deleted.

| # | Job | Failure if unmet |
|---|---|---|
| G1 | An enterprise reviewer can approve Fathom without a bespoke legal opinion | The tool never gets installed on a corporate laptop, which is the only place it is useful |
| G2 | The corpus cannot become a copyright liability | A single vendor takedown removes the product's whole differentiator overnight |
| G3 | A contributor can contribute without signing anything they need a lawyer to read | The corpus never scales past one author, which `72` §4 identifies as the most likely cause of death |
| G4 | A vulnerability has a defined path from reporter to fixed release | Researchers publish to social media instead, and the first the users hear is a screenshot |
| G5 | Users' data outlives the project | The zero-knowledge posture becomes a liability rather than an advantage — see §11.4 |

G5 is the one most projects skip and the one Fathom is unusually well placed on. Say it out
loud: because the server never holds a key and the workspace is a file the user already has,
the "what if you shut down" question has a genuinely good answer here, and it should be written
into the governance documents rather than left as an architectural implication.

---

## 3. The artifacts, because they are not one thing

"What licence is Fathom under" is the wrong question. There are six distinguishable artifacts
with different economics, different contributor populations and different infringement risks.
Licensing them identically is a decision, not a default, and it is the wrong one.

| # | Artifact | What it is | Who contributes | Copy risk | Replacement cost if lost |
|---|---|---|---|---|---|
| A1 | **Core** | Rust: graph, rule engine, emitters, parsers, finder index | Small number of systems engineers | Low | Months |
| A2 | **UI** | TypeScript at the WASM boundary, plus the design tokens | Front-end contributors | Low | Weeks |
| A3 | **Sync service** | Axum. Stores ciphertext and metadata. Holds no key | Almost nobody | Nil | Days |
| A4 | **Corpus** | Authored YAML: command entries, explainers, rules | Network engineers, not programmers | **High — §7** | Years |
| A5 | **Specs and schemas** | The workspace format, the corpus schema, the rule-pack schema | Maintainers | Low | Weeks |
| A6 | **Name and marks** | "Fathom", the wordmark, the domain, the package names | Nobody | n/a | Not replaceable |

Three observations that decide everything downstream.

**A4 is where the value is.** `72` §4 concludes that the content problem is almost certainly why
well-funded teams have built pieces of this and not the whole thing. The corpus is the moat, it
is the slowest thing to rebuild, and it is the only artifact carrying a real third-party
copyright hazard. It should not inherit a licence chosen for A1.

**A3 is worth nothing.** A zero-knowledge sync service is deliberately stupid: authenticate,
store bytes, return bytes, resolve a version vector. Copylefting it protects nothing, and this
observation is what collapses the AGPL argument in §4.2.

**A5 wants the opposite treatment from A4.** A workspace format that a third party is nervous
about implementing is a format users cannot escape from, which breaks G5. Specs want to be as
close to public domain as the law allows.

---

## 4. Code licence analysis — five candidates

Each candidate is assessed on the same six axes. "Hosted offering" means: what the licence does
if the project, or somebody else, later runs Fathom as a paid service.

### 4.1 Apache-2.0

| Axis | Assessment |
|---|---|
| **Permits** | Use, modify, distribute, sublicense, commercialise, close the derivative. Express patent grant from every contributor (Apache-2.0 §3) |
| **Prevents** | Almost nothing. Requires the NOTICE file, the licence text, and a statement of changes (§4). Terminates the patent grant of anyone who sues over patents in the work (§3) |
| **Hosted offering** | No obstacle in either direction. A competitor may host it closed. So may we |
| **Enterprise legal reaction** | The most boring answer available. It is on essentially every corporate allowlist; the explicit patent grant is the reason legal teams prefer it to MIT/BSD; §6 explicitly declines to grant trademark rights, which is what makes §12 workable |
| **Contribution effect** | Lowest friction. A contributor's employer's OSPO approves it without a ticket |
| **Cost** | Gives away the only legal mechanism that could compel a hosted competitor to publish improvements |

### 4.2 AGPL-3.0 — and the client-side problem, stated plainly

AGPL-3.0 is GPLv3 plus §13, which requires that if you *modify* the Program and users interact
with the modified version *remotely through a computer network*, you must offer those users the
Corresponding Source from a network server. Both conditions matter: the obligation attaches to
modification, and to remote interaction.

**For Fathom, §13 is largely inoperative, and the project should say so rather than let a
reader assume otherwise.**

The reasoning, in order:

1. **The Program runs on the user's machine.** Fathom is Rust compiled to WASM executing in the
   user's browser, or a native CLI. A user running Fathom is not "interacting with it remotely
   through a computer network" in the sense §13 is aimed at. They fetched a bundle and then ran
   it locally.
2. **Serving the bundle is conveying, which GPLv3 already covers.** A host that ships a modified
   WASM bundle to a browser is distributing object code, and GPLv3 §§5–6 already require the
   Corresponding Source on those terms. Whatever protection exists against a modified-and-hosted
   Fathom comes from plain GPLv3, not from §13.
3. **The only component §13 unambiguously reaches is A3, the sync service** — and per §3, A3 is
   worth nothing. Compelling a competitor to publish their fork of a ciphertext blob store is
   not a strategic win.
4. **The corpus is not code and the code licence does not reach it.** A hosted competitor's real
   theft target is A4, and a code copyleft has no grip on YAML the code merely reads. §6 handles
   this with a different instrument, and that instrument works over the network where this one
   does not.

There is genuine legal uncertainty in point 1 — the "remote interaction" question for a
downloaded client has not, as far as this document's author can establish, been settled by a
court in any jurisdiction relevant to this project.
<!-- VERIFY: ask counsel whether any decided case addresses AGPL §13 as applied to a client-executed WASM/JS payload. If one exists, this subsection changes. -->
That uncertainty argues *against* AGPL rather than for it: a licence whose central benefit
depends on an untested reading, and whose central cost is certain, is a bad trade.

The certain cost:

| Axis | Assessment |
|---|---|
| **Permits** | Everything GPLv3 permits |
| **Prevents** | Proprietary derivatives; combination with incompatible code. §13 adds a source obligation for modified network-facing deployments |
| **Hosted offering** | We could host freely; a competitor hosting a modified sync service would owe source. For the client bundle, §13 adds little beyond GPLv3 |
| **Enterprise legal reaction** | The worst of the five. Google's public policy states that "Code licensed under the GNU Affero General Public License (AGPL) MUST NOT be used at Google," extending to installing AGPL programs on issued laptops without OSPO authorisation. Google is not the market, but its policy is widely copied, and Fathom's target user is an engineer on a corporate laptop |
| **Contribution effect** | Contributors employed by companies with AGPL bans cannot contribute during work hours, which for a network-engineering corpus is when the expertise exists |
| **Cost** | Buys a protection that mostly does not apply, at a price paid by exactly the users the product needs |

**This is the single clearest licence conclusion in the document. Do not use AGPL for a
client-side application and then describe it as protection. It is not.**

### 4.3 MPL-2.0

File-level copyleft. Modifications to MPL-covered files stay MPL; new files containing no
MPL-licensed code are not Modifications and need not be MPL. The combined product is a "Larger
Work" and may carry other terms.

| Axis | Assessment |
|---|---|
| **Permits** | Combination with proprietary code in a Larger Work; commercial distribution; closed additions in separate files |
| **Prevents** | Silently privatising fixes to *existing* files. A competitor who patches the rule engine must publish that patch |
| **Hosted offering** | No network clause. A hosted competitor who edits core files owes those files on distribution — and a WASM bundle is a distribution, so unlike AGPL §13 this one does bite on the client build |
| **Enterprise legal reaction** | Good. MPL is on most allowlists; it is the licence a legal team reads as "we can use it, we just cannot hide edits to their files." Includes a patent grant |
| **Contribution effect** | Slightly higher friction than Apache, materially lower than AGPL |
| **Cost** | The file boundary is a weak boundary. A determined competitor reimplements the file. It also complicates the single-file offline build, where the corpus, UI and core are fused into one artifact and the file-level argument gets murky |

MPL is the most defensible *middle*. It is a real answer, not a compromise, and §5 explains why
it still loses.

### 4.4 BSL-1.1 (Business Source License)

Source-available, not open source. The licensor names a Change Date no more than four years out,
at which point that version converts to a nominated Change License. Production use before the
Change Date is prohibited except as permitted by an Additional Use Grant, which the licensor
writes freely — MariaDB's, for instance, permits commercial use with fewer than three production
server instances.

| Axis | Assessment |
|---|---|
| **Permits** | Reading, modifying, non-production use, and whatever the Additional Use Grant says |
| **Prevents** | Competing hosted offerings, and — depending on the grant's wording — ordinary internal production use |
| **Hosted offering** | Directly protects one. This is what the licence is for |
| **Enterprise legal reaction** | Poor, and worse than its reputation. Procurement processes that require OSI-approved licences reject it outright. Worse for Fathom specifically: the grant's wording is bespoke per project, so every enterprise reviewer must actually read it, which is exactly the bespoke legal opinion G1 exists to avoid |
| **Contribution effect** | Corrosive. A contributor is donating labour to a commercial monopoly with no reciprocity, and network engineers writing corpus entries in their own time will notice |
| **Cost** | Loses Linux distribution packaging, loses inclusion in security-tool collections, loses the fork half of the continuity story in §11 |

### 4.5 FSL-1.1 (Functional Source License)

Authored by Sentry in November 2023 as a response to BSL's four-year default and its per-project
Additional Use Grant. FSL permits everything except competing with the producer, and each version
converts to Apache-2.0 or MIT — the variant is named in the licence identifier,
`FSL-1.1-Apache-2.0` or `FSL-1.1-MIT` — two years after that version is made available. It is a
"fair source" licence, not an OSI-approved open-source licence.

| Axis | Assessment |
|---|---|
| **Permits** | Nearly all use, study, modification, redistribution of changes |
| **Prevents** | Building a competing product or service during the two-year window |
| **Hosted offering** | Protects one for two years per version, which is a more honest window than BSL's four |
| **Enterprise legal reaction** | Better than BSL because the terms are standardised rather than per-project, so a reviewer can reuse an earlier opinion. Still fails an OSI-approved-only procurement rule |
| **Contribution effect** | Same objection as BSL, halved in duration. The objection is qualitative, not quantitative, so halving it does not remove it |
| **Cost** | Same as BSL: the fork guarantee in §11.4 becomes "you may fork this, but not for two years, and not if the maintainer thinks you compete" |

### 4.6 The comparison on one page

| | Apache-2.0 | AGPL-3.0 | MPL-2.0 | BSL-1.1 | FSL-1.1 |
|---|---|---|---|---|---|
| OSI-approved | yes | yes | yes | **no** | **no** |
| Express patent grant | yes | yes | yes | via Change License, later | via Change License, later |
| Explicit trademark carve-out | yes (§6) | no explicit section | no explicit section | n/a | n/a |
| Protects against a hosted competitor | no | **not for a client-side app — §4.2** | partially, on the files touched | yes | yes, for two years |
| Corporate allowlist, typical | pass | **frequent hard block** | pass | case-by-case | case-by-case |
| Distro / security-collection packaging | yes | yes | yes | no | no |
| Contributor friction | lowest | high | low | high | high |
| Preserves "fork it if we die" | yes | yes | yes | **no** | after two years |
| Reaches the corpus (A4) | no | no | no | contractually, yes | contractually, yes |

The last row is the one that decides it. Every licence that meaningfully protects the moat does
so by contract terms that break G1, G3 and §11.4 — and the licence family that *does* reach A4
without breaking anything is not a software licence at all. That is §6.

---

## 5. RECOMMENDATION — the code licence, and what it costs

**RECOMMENDATION — Apache-2.0 for A1, A2 and A3. CC0-1.0 for A5. A4 is licensed separately
under §6. The name is reserved under §12.**

`SPDX-License-Identifier: Apache-2.0` in every source file. `LICENSE`, `NOTICE`, and a
`LICENSES/` directory carrying the corpus and spec licences alongside.

### 5.1 Why

| Reason | |
|---|---|
| R1 | The product's claim is auditability. Apache-2.0 is the licence that costs a reviewer the least time to clear, and reviewer time is the adoption bottleneck, not feature parity |
| R2 | The patent grant in §3 is worth more than it looks for a tool that emits vendor configuration syntax. It also disarms the contributor whose employer later discovers a patent |
| R3 | §6's explicit refusal to grant trademark rights is the hook §12 hangs on. Apache is the only candidate that says this in the licence rather than in a policy file |
| R4 | The copyleft options protect an asset (A1) that is not the asset worth protecting (A4), at a real cost to the contributor population that produces A4 |
| R5 | The single-file offline build fuses core, UI and corpus into one artifact. A file-level or work-level copyleft on the code makes that artifact's licensing analysis harder for every downstream redistributor — including the air-gapped and defence users §2.4 of the brief names as the structurally under-served market |

### 5.2 What it costs, stated plainly

**A funded competitor can take everything and host it closed.** They can take the Rust core, the
emitters, the parsers, the finder index, the design tokens, wrap it in a SaaS, add SSO, sell it
to enterprises, and contribute nothing back. Apache-2.0 permits this completely. There is no
mechanism in this recommendation that stops it.

Three things blunt it, and none of them is the licence:

| Blunt | Force |
|---|---|
| The corpus is CC-BY-SA (§6), so improved explainer prose served over the web is share-alike | Real, and it is the strongest of the three — see §6.3 |
| The name and marks are reserved (§12), so the fork cannot be called Fathom | Real but narrow. It costs a competitor a rebrand, not a rebuild |
| Fathom's posture is architecturally hostile to hosting: no egress, no credentials, no server-side key | Real. A hosted fork must break the zero-knowledge property to add the features a SaaS buyer wants, at which point it is a different product competing on different ground |

That last row is the honest strategic answer and it should not be over-claimed. It says a
competitor cannot take Fathom's *trust position* with the code, not that they cannot take the
code. If a competitor is content to be an ordinary SaaS, Apache-2.0 hands them a head start and
this recommendation accepts that.

### 5.3 The alternative if §5.2 becomes unacceptable

If the owner decides the hosted-competitor risk is intolerable, the correct move is **not** BSL or
FSL. It is:

1. **MPL-2.0 on A1 only** (the Rust core), Apache-2.0 on A2 and A3. This keeps the allowlist pass
   and forces published patches to the engine.
2. Keep A4 under CC-BY-SA regardless. It is doing more work than the code licence in every
   scenario.

That combination is the strongest defensible position that still satisfies G1, G3 and §11.4. It
is offered as the fallback, not the default, because the file-level boundary in a Rust workspace
that will be aggressively refactored is a boundary that erodes without anyone deciding to erode
it.

### 5.4 What we will not do

| Refused | Why |
|---|---|
| Dual-licence Apache + a commercial licence | Requires a CLA with copyright assignment (§8), which costs G3 |
| Open-core: free client, paid server features | The server has no features. Zero-knowledge means there is nothing to put behind a paywall except sync capacity, and a capacity paywall is a hosting business, not a licence |
| Relicense later | §8.4. The DCO recommendation makes this practically impossible, and that is the point |
| "Source-visible" with no licence file | The worst of every option. It fails G1 outright |

---

## 6. The corpus is content, not code

*margin tab: fields that matter*

A4 is authored English prose plus structured YAML about vendor behaviour. Applying a software
licence to it is a category error that Creative Commons themselves warn about from the other
direction: their FAQ states plainly, "We recommend against using Creative Commons licenses for
software," on the grounds that CC licences do not address source-code distribution or patent
rights. The inverse warning is equally true — Apache-2.0's vocabulary of "Source form," "Object
form," "compiled," and NOTICE files has no meaning applied to an explainer entry, and a
downstream user asking "what is the Object form of a YAML rule" gets no answer from the text.

### 6.1 The three candidates

| | CC0-1.0 | CC-BY-4.0 | CC-BY-SA-4.0 |
|---|---|---|---|
| Attribution required | no | yes | yes |
| Share-alike on adaptations | no | no | **yes** |
| Compatible with commercial reuse | yes | yes | yes |
| Patent rights addressed | no — CC licences generally do not grant patent rights | no | no |
| Becomes an industry-standard vocabulary | most likely | likely | least likely |
| Protects against silent absorption by a SaaS | no | attribution only | **partially — §6.3** |
| One-way convertible to GPLv3 | n/a | n/a | yes, since 2015, for the niche case of content melded with code |

### 6.2 RECOMMENDATION

**RECOMMENDATION — A4 (the corpus) under CC-BY-SA-4.0. A5 (schemas and format specs) under
CC0-1.0.**

The split is deliberate and the reasoning is symmetric:

- **The formats want maximum adoption and zero friction.** If a third party wants to write an
  independent decoder for the workspace format — and §11.4 says they must be able to — the
  format specification must carry no obligations at all. CC0 also sidesteps the CC-for-software
  objection, since Creative Commons themselves note that CC0 is GPL-compatible and acceptable
  for software, which covers the reference decoder that ships alongside the spec.
- **The content wants share-alike**, because share-alike is the only reciprocity mechanism in
  this whole document that actually reaches a hosted competitor.

### 6.3 Why share-alike works on content where copyleft fails on code — the asymmetry

This is the non-obvious result and it is worth stating carefully, because it is the reason §4.2
does not leave the project defenceless.

CC BY-SA 4.0 defines *Share* to include making material available to the public in ways that let
members of the public access it from a place and at a time they choose. That definition is
written to cover web serving. The ShareAlike condition attaches when a licensee **Shares Adapted
Material**.

So:

| Scenario | Code under Apache-2.0 | Corpus under CC-BY-SA-4.0 |
|---|---|---|
| Competitor hosts it unmodified | nothing owed | attribution owed |
| Competitor modifies and hosts, no binary shipped to users | nothing owed | **adapted corpus must be offered under CC-BY-SA** |
| Competitor modifies and ships a client bundle | nothing owed | attribution + share-alike on adaptations |

The middle row is exactly the case AGPL §13 was invented for and, per §4.2, exactly the case
where it does not reliably reach a client-side application. Content share-alike reaches it
because "Share" is defined by the making-available right rather than by distribution of a copy.

**The honest limits, four of them:**

1. It bites only on **Adapted Material**. A competitor who uses the corpus verbatim and writes
   their own UI owes attribution and nothing more. That is the most likely competitor behaviour.
2. Facts are not copyrightable. A competitor may read every entry, extract the *facts* — which
   command answers which question, which parameter must match — and re-express them in their own
   prose with no obligation. The share-alike protects the writing, not the knowledge. Given that
   §7 requires the project to do exactly this to vendor documentation, the project is in no
   position to complain when it happens in the other direction.
3. There is no patent grant, which is fine for prose and is a reason A5 is CC0 and any code in
   the spec repository is Apache-2.0.
4. Enforcement requires someone willing to enforce. §12 and §13 name who that is; for a
   single-maintainer project the honest answer is "probably nobody," and a licence nobody will
   enforce is a deterrent, not a control.

### 6.4 The boundary problem: where does A1 stop and A4 start

The offline single-file build embeds the corpus in the shipped artifact. That makes the artifact
a combined distribution of Apache-2.0 code and CC-BY-SA-4.0 content, which is fine — they are
separate works aggregated, not a derivative of one another — but it imposes three build-time
obligations that must be automated or they will be forgotten:

| Obligation | Mechanism |
|---|---|
| Attribution for the corpus must travel with the binary | Build embeds `ATTRIBUTION.txt`, generated from every entry's `authors` and `reviewed_by`, and the UI exposes it from the about panel with no network fetch |
| The licence of each embedded artifact must be discoverable | An SPDX SBOM covering both code and content, produced by the reproducible build (`35`) and published with the release hashes |
| A downstream redistributor must be able to separate them | The corpus ships as a separately-downloadable, separately-hashed bundle as well as embedded. This is required anyway for offline rule-pack updates |

**DECISION — the corpus is a distinct top-level directory with its own `LICENSE`, and no
generated file ever mixes corpus prose into a `.rs` file.** Codegen may produce an index, an
identifier table, or a perfect-hash lookup from corpus IDs, but not prose. If prose ends up in a
Rust source file, the boundary is gone and the SBOM is a fiction.

---

## 7. The vendor-documentation problem

*margin tab: read this first*

> **NOTHING IN THE CORPUS IS PARAPHRASED FROM A VENDOR MANUAL — IF YOU CANNOT SAY WHERE IT CAME FROM, IT DOES NOT SHIP**

This is the largest legal risk in the project and it is not a licence question. It is a copyright
question about how the corpus is written.

### 7.1 The risk, precisely

Vendor documentation — Juniper's TechLibrary, Cisco's configuration guides, Palo Alto's docs — is
copyrighted, all rights reserved, and the vendors employ people who look for reproduction of it.
A corpus of thousands of entries explaining vendor behaviour is, on its face, exactly the shape
of a derivative work of that documentation, whether or not it is one.

The exposure is asymmetric in the worst way: the cost of being wrong is a takedown of the entire
corpus, which per §3 is a multi-year asset, and the cost of being right but having to prove it is
a discovery process a solo maintainer cannot fund.

### 7.2 What is and is not protectable — the working model

This is the project's operating assumption, not a legal conclusion, and §15 asks counsel to
confirm it.

| Material | Treatment | Reasoning as understood |
|---|---|---|
| Command syntax — `show security ipsec security-associations` | **Free to reproduce** | A command string is a functional interface. There is no expressive choice in writing the command you must type |
| Configuration statement paths — `set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14` | **Free to reproduce** | Same. It is the syntax the box accepts |
| Enumerated values — `group14`, `aes-256-gcm`, `v2-only`, `always-send` | **Free** | Facts about an interface |
| Log and error identifiers — `NO_PROPOSAL_CHOSEN`, `TS_UNACCEPTABLE`, `INVALID_KE_PAYLOAD`, `AUTHENTICATION_FAILED` | **Free**, as short functional identifiers | These are strings the box emits; reproducing them is how a user matches what they saw |
| Default values and ranges — "Junos defaults DPD to 10 × 5", "lifetime range 180–86400" | **Free as facts**, but must be verified on hardware or in a lab, not lifted | Facts are not copyrightable. But an unverified "fact" copied from a manual is both a copy and possibly wrong |
| Vendor **explanatory prose** | **Never reproduced, never paraphrased** | This is where the expression is, and this is where the exposure is |
| Vendor **tables, diagrams, screenshots, topology art** | **Never** | Selection and arrangement are protectable, and diagrams obviously so |
| Vendor **example configurations** from a guide | **Never copied as a block** | Even where each line is functional, the selection and ordering of a worked example is the expressive part |
| Vendor **trademarks** — Junos, SRX, PAN-OS, IOS-XE | Nominative use only (§12.3) | Naming what a tool supports is not infringement; implying endorsement is |

### 7.3 The rule that follows

**DECISION — every corpus entry's prose is written from one of exactly three origins, recorded
in the entry, and no fourth origin is permitted:**

```yaml
origin:
  kind: observed          # observed | standard | reasoned
  detail: "Junos 21.4R3-S4 on SRX345, lab, 2026-05-12"
```

| `kind` | Means | Evidence the reviewer requires |
|---|---|---|
| `observed` | The author ran it on a box or in a lab and wrote down what happened | Platform, release, date. A capture or transcript in the PR, not in the shipped entry |
| `standard` | Derived from an RFC or IEEE document, cited by number and section | The citation, and a check that the section says what the entry claims |
| `reasoned` | Follows from other corpus entries or from stated protocol mechanics | The chain, named. Reviewer must be able to reconstruct it |

There is deliberately no `kind: documented`. A vendor manual may be consulted to know *what to go
and test*, and may be cited in `sources` as further reading, but it may never be the origin of a
sentence. A sentence whose only support is "the manual says so" is either a fact the author can
verify, or it does not ship.

### 7.4 Worked example — the same fact, three ways

Take the field card's own material on perfect forward secrecy. The card writes:

> *"Without PFS, the Phase 2 keys are derived from the Phase 1 key material. One compromised IKE
> SA secret unlocks every data key derived under it — including traffic somebody recorded off
> the wire months ago."*

That is safe and it is the model, for three reasons: it states a protocol mechanic that follows
from IKEv2's key derivation (`kind: reasoned`, chained to RFC 7296); it is written in the
project's own voice; and its value is the failure-mode framing, which is a thing vendor
documentation characteristically does not do — which is both why the corpus is worth writing and
why it does not resemble the source it might be accused of copying.

Contrast three entries for the same knob:

| Version | Verdict |
|---|---|
| "Perfect Forward Secrecy ensures that a compromise of long-term keys does not compromise past session keys, providing an additional layer of security." | **Reject.** Generic marketing-shaped prose, indistinguishable from a hundred vendor pages, and says nothing an engineer can act on. It is also the exact register `design-language.md` forbids |
| "PFS on one side and absent on the other fails Phase 2 while Phase 1 stays up — the classic 'IKE looks fine but the tunnel keeps dropping.'" | **Accept.** A failure mode, a misdiagnosis it prevents, written from observed behaviour |
| "Under IKEv2 the first child SA is always keyed from the IKE SA regardless; PFS applies to later child rekeys. A capture of the initial bring-up showing no DH is not a misconfiguration." | **Accept with `kind: standard`,** cited to RFC 7296, and the reviewer checks the cited section actually says it |

The middle and last are also strictly more useful than the first, which is the point worth
internalising: **the writing rule that protects the project legally is the same writing rule that
makes the corpus good.** `design-language.md`'s "states the failure mode, not the feature" is a
copyright control as well as a style rule.

### 7.5 Model-drafted corpus is the acute case

The conventions already require a named human reviewer on every corpus entry (invariant 10). This
section explains why that invariant is load-bearing rather than fussy: **a language model asked
to explain a vendor knob is drawing on vendor documentation it was trained on, and its most
fluent output is the output closest to that documentation.** Model-drafted prose is the single
most likely route by which paraphrased vendor text enters the corpus, and it arrives looking
polished.

Consequences, all mandatory:

| Control | |
|---|---|
| C1 | Model-drafted entries are marked in the PR, not just in the entry, so the reviewer knows to read for register drift |
| C2 | The reviewer's attestation (§9.3) explicitly covers origin, not just correctness |
| C3 | An entry that reads like documentation is rejected on style grounds *and* re-examined on origin grounds. The two failures correlate |
| C4 | No entry may cite a vendor URL as its `origin`. `sources` and `origin` are different fields and only `sources` may point at vendor material |

### 7.6 The takedown runbook

If a vendor asserts infringement:

| Step | Action | Owner |
|---|---|---|
| 1 | Acknowledge within 5 working days. Do not argue in the first reply | Maintainer |
| 2 | Identify every entry named, plus every entry by the same author in the same domain | Maintainer |
| 3 | Pull the named entries from the *next* release; do not retroactively rewrite published releases, because reproducible-build hashes are published and rewriting history breaks §11 | Maintainer |
| 4 | Produce the `origin` record and the PR evidence for each entry | Automatic — this is what §7.3 exists for |
| 5 | Where origin is `observed` or `standard` with evidence, respond with it. Where evidence is missing, the entry is deleted and rewritten from scratch by a different author | Maintainer + reviewer |
| 6 | Publish the outcome in the advisory stream (§10.5) whether or not we were right | Maintainer |

Step 4 is the whole reason §7.3 exists. **The `origin` field is not documentation hygiene. It is
the evidence file, pre-assembled, for a dispute the project should assume will eventually
happen.**

---

## 8. Contribution model

### 8.1 DCO, not CLA

**RECOMMENDATION — Developer Certificate of Origin 1.1, enforced by a required `Signed-off-by`
trailer on every commit. No CLA.**

| | DCO | CLA |
|---|---|---|
| What it is | A per-commit attestation by the author that they have the right to submit | A signed agreement, usually granting the project a broad licence or copyright assignment |
| Standardised | Yes — one text, unchanged since 2004, that a contributor can read in ninety seconds | No. Every project's is different, so every one must be read by counsel |
| Who can sign | The author, always | Often an employer on behalf of employees |
| Enables relicensing | No | Usually yes, which is normally the actual reason for having one |
| Friction | A `git commit -s` | A form, a legal review, sometimes an employer's signature, and a week |

For a project whose scarce contributor is a network engineer writing a corpus entry in the
evening, the CLA's friction is disqualifying. G3 says so directly.

### 8.2 What the DCO does not buy, said honestly

A DCO is an attestation, not a licence grant. It does not give the project the right to relicense
contributions, and it provides weaker evidence than a signed agreement if provenance is ever
litigated. Projects with institutional backing use CLAs for exactly these reasons and they are
not being silly.

Fathom accepts the weaker instrument because the thing a CLA buys — the option to relicense — is
a thing this project has decided not to want. See §8.4.

### 8.3 Corpus contributions and the DCO

The DCO's text is written about code. It refers to submitting a "contribution" under the
project's open-source licence. For A4 the inbound licence is CC-BY-SA-4.0, not the code licence,
so the `CONTRIBUTING.md` must state the mapping explicitly rather than leave it to inference:

> Contributions under `corpus/` are offered under CC-BY-SA-4.0. Contributions elsewhere are
> offered under Apache-2.0. `Signed-off-by` certifies the DCO against whichever licence covers
> the path you touched.

<!-- VERIFY: counsel to confirm the DCO's wording is workable as written for a CC-BY-SA inbound path, or supply a two-line variant. -->

### 8.4 The no-relicensing commitment

**DECISION — the project publishes a standing commitment never to relicense A1–A3 to a
non-OSI-approved licence, and the DCO is the enforcement mechanism.**

This is the direct answer to the "they'll pull a HashiCorp on us" objection, which every
evaluator of a new infrastructure tool now raises and which is the reason §4.4 and §4.5 were
analysed at all. The commitment is credible precisely *because* there is no CLA: without
copyright assignment, a relicense requires the agreement of every contributor who still holds
copyright in surviving code, which becomes impossible within a few dozen contributors.

The cost is symmetrical and should be stated: **if this project ever genuinely needs to
relicense — for example because a licence proves incompatible with a dependency the project
cannot replace — it will not be able to.** That is accepted. The scenario is rarer than the
scenario where a relicensing option gets used badly.

### 8.5 The contribution ladder

| Path | Requirement | Typical turnaround |
|---|---|---|
| Typo, broken link, formatting | DCO. One maintainer approval | Same week |
| Code change, no new dependency | DCO. One maintainer approval. Tests | Same week |
| Code change adding a runtime dependency | DCO. Two maintainer approvals, one of whom reviews the dependency against `35` | Two weeks, and often "no" |
| New command corpus entry | DCO. **Named expert reviewer (§9.3).** `origin` populated | Bounded by reviewer availability, not by maintainer time |
| New rule | DCO. Named expert reviewer. `acceptable_when` present. Version predicate present | As above |
| New explainer at Teaching depth | DCO. Named expert reviewer **plus** a voice review against `design-language.md` | Slowest path in the project. See §14 |
| New platform | Not a contribution. A roadmap decision — `71` §10 | n/a |

---

## 9. Review, merge rights and the named-expert rule

### 9.1 Roles

| Role | May | Appointed by | Removed by |
|---|---|---|---|
| **Contributor** | Open PRs | n/a | n/a |
| **Reviewer** | Approve in a named area. Cannot merge | Maintainers, by consensus | Maintainers, or 12 months' inactivity |
| **Corpus expert** | Serve as the named reviewer for a platform+domain (§9.3) | Maintainers, against §9.4 criteria | Same |
| **Maintainer** | Merge. Cut releases. Approve dependencies | Maintainers, by consensus, no objection | Voluntary, or unanimous vote of the others |
| **Release signer** | Hold a share of the signing key (§11.2) | Maintainers | Key rotation (`35`) |
| **Security contact** | Receive embargoed reports, set embargo terms | Maintainers | Same |

Roles are recorded in a single machine-readable `GOVERNANCE.yaml` in the repository root, because
a governance file that disagrees with reality is worse than none. Reviewer expiry is enforced by
CI: a reviewer with no activity in twelve months moves to `emeritus` automatically and their
approvals stop counting.

### 9.2 Review requirements

| Change class | Approvals | Extra gate |
|---|---|---|
| Documentation | 1 maintainer | — |
| Core code | 1 maintainer, not the author | Tests, and determinism check (`45`) |
| Emitter or parser | 1 maintainer + 1 reviewer for that platform | Golden-output diff reviewed line by line |
| Cryptography, workspace format, sync protocol | **2 maintainers**, neither the author | An entry in `90-decisions/` |
| Runtime dependency added or bumped major | 2 maintainers | Supply-chain review per `35` |
| CSP, egress, or anything touching invariants 1–4 | **2 maintainers + an explicit statement in the PR body naming the invariant** | The invariant test suite must be shown passing, and the PR template refuses to submit without it |
| Corpus entry | 1 maintainer **+ named expert (§9.3)** | `origin` present, style review |
| Rule | 1 maintainer + named expert | `acceptable_when` present; version predicate present; a fixture that fires and one that does not |

**Nobody merges their own change.** For a project that may run with one maintainer for a long
period, this rule needs an escape hatch that does not quietly become the default: a solo
maintainer may self-merge only changes in the Documentation class, and every self-merge is
recorded in the release notes. Everything else waits. §11.1 explains why waiting is the correct
behaviour rather than a bottleneck to engineer around.

### 9.3 The named-expert rule

**DECISION — no corpus entry, rule or explainer merges without a named human expert reviewer
recorded in the entry itself.** This restates conventions invariant 10 and specifies it.

The reviewer is recorded in the entry, not only in the git history, because the entry travels
independently of the repository — it is served offline, inside a signed rule pack, to a user who
will never see the PR:

```yaml
reviewed_by:
  - name: "A. Reviewer"
    platform_scope: junos-srx
    domain_scope: ipsec
    date: 2026-06-04
    attests:
      - behaviour_verified      # ran it, or read the RFC section cited
      - origin_is_not_vendor_prose
      - risk_enum_correct
      - acceptable_when_present  # rules only
      - style_matches_voice
```

**What the reviewer is attesting to, in words:** *I have either run this on the platform and
release named in `origin`, or I have read the standard section cited and it says this. The prose
is not paraphrased from vendor documentation. The `risk` value is right — and specifically, I
have asked whether this command can drop live traffic on somebody else's Tuesday.*

That last clause is deliberately concrete. The field card supplies the canonical case for it:

> *"Clearing P1 tears down every child SA under it — on a hub that is every spoke at once. Always
> scope by peer or index."*

`clear security ike security-associations` is `Disruptive`, not `ChangesConfig`, and it is
`Disruptive` for a reason that only shows up when you think about the hub. An entry that got that
wrong would be a security-relevant defect (§10.3), not a typo — which is why the reviewer signs
for it by name.

### 9.4 What makes someone an expert, and what happens when there isn't one

| Criterion | |
|---|---|
| Has operated the platform in production, or in a lab with the release in question | Required |
| Is not the entry's author | Required |
| Is named publicly, with their consent, in `GOVERNANCE.yaml` | Required |
| Is not an employee of the vendor whose platform they review | **Not** required, but it is disclosed in `GOVERNANCE.yaml` |

The vendor-employee point deserves the honest treatment. Vendor engineers are often the best
available reviewers and excluding them would cost the corpus more than it gains. What is
forbidden is undisclosed affiliation, and what is required is that a vendor-affiliated reviewer
may not be the *only* reviewer for a rule that recommends that vendor's product over another's —
a rule shape the project should be suspicious of anyway.

**When no expert exists for a platform+domain**, which will be the normal condition early:

| Option | Verdict |
|---|---|
| Ship it unreviewed with a warning banner | **No.** It breaks invariant 10 and it trains users to ignore banners |
| Ship it in a separate `community` rule pack, unsigned, opt-in, off by default | **Yes.** This is the pressure valve. The pack is clearly a different artifact, it is not in the default build, and enabling it is a deliberate act |
| Hold it in the PR queue indefinitely | Acceptable, and honest, but it loses contributors |

**DECISION — a `community` tier exists, is unsigned, is off by default, and is never included in
the offline single-file build.** The single-file build is the artifact an air-gapped user cannot
audit against a network, so it carries only reviewed, signed content.

---

## 10. Security governance

*margin tab: what the log means*

> **A REPORT WITH NO ACKNOWLEDGED DEADLINE IS A DISCLOSURE WAITING TO HAPPEN**

### 10.1 The contact

| | |
|---|---|
| Address | `security@<project-domain>` — a role address, never a person's |
| Key | An OpenPGP key published at `/.well-known/security.txt` and in the repository, fingerprint printed in every release note |
| `security.txt` | Per RFC 9116, served at `/.well-known/security.txt` with `Contact`, `Encryption`, `Preferred-Languages`, `Policy` and `Expires` |
| Fallback | GitHub private vulnerability reporting, enabled on the repository |
| Acknowledgement SLA | 3 working days. This is a commitment, and if it cannot be met by one person it must be reduced in writing rather than missed |

An `Expires` field that has lapsed is itself a finding an external scanner will report, so
renewing it is a release-checklist item, not a calendar reminder.

### 10.2 Scope — what is a vulnerability here

A client-side, zero-knowledge, no-egress tool has an unusual boundary and it must be published,
or the inbox fills with reports that are architecture, not bugs.

**In scope:**

| Class | Example |
|---|---|
| Any path by which workspace plaintext reaches the network | A `fetch` introduced by a dependency; a CSP regression |
| Any weakening of workspace encryption | KDF parameters lowered; nonce reuse; a downgrade path in the format version |
| The server learning anything it should not | A metadata field that leaks graph size, device names, or edit timing beyond what `33` documents |
| Cross-workspace contamination | Content from workspace A reachable while workspace B is open |
| Injection through untrusted input | A pasted configuration that achieves script execution, or that steers the AI layer (`23`) |
| Supply-chain integrity | A published artifact that does not reproduce from the tagged source |
| **An emitted line that is unsafe and not labelled as such** | See §10.3 |
| A `risk` enum value that under-states what a command does | See §10.3 |

**Out of scope, and stated so nobody spends a weekend on them:**

| Class | Why |
|---|---|
| "I can read my own workspace in devtools" | The user holds the key. This is the design |
| "A compromised browser can read everything" | Explicitly out of scope in the brief's §7.1 and in `31` |
| "There is no rate limiting on the sync service" | There is; but availability of an optional sync service is not in the same class as confidentiality, and `33` states the position |
| "The passphrase can be brute-forced if it is weak" | True of every passphrase. Report a *KDF parameter* weakness instead, which is in scope |
| Missing security headers on the marketing site | Report it, but it is not a product vulnerability and it is not embargoed |
| Findings from an automated scanner with no demonstrated impact | Not rejected, but triaged behind everything above |

### 10.3 The unusual class: a wrong rule is a security issue

**DECISION — a defect in emitted configuration or in a `risk` label is handled by the security
process, not the bug process, when it meets either test:**

| Test | Example drawn from the field card |
|---|---|
| **T1 — the output is less safe than the user would reasonably read it to be** | An emitter or rule that produced `set security ike policy IKE-POL proposals proposal-set standard`. The card's own note is the reason: `proposal-set standard` "still leads with DH group 2, and you cannot see what it offered without the docs." Config that silently offers a weak group is a security defect in Fathom's output, even though every line is valid Junos |
| **T2 — a `risk` value understates blast radius** | Labelling `clear security ike security-associations` as `ChangesConfig`. On a hub it drops every spoke. A user who trusted the green label ran a `Disruptive` command in a change window sized for a safe one |

Both get: an embargo, a coordinated fix, and an advisory. Neither gets an issue in the public
tracker before the fix ships, because the advisory itself tells an attacker which deployed
configurations to look for.

This is a deliberately expansive scope and it has a cost: it puts corpus content into the
security process, where the volume is potentially large and the maintainer capacity is small.
`72` §6 already identifies correctness liability as a standing risk; this is the governance
half of that risk's mitigation, and §14 counts what it costs.

### 10.4 Embargo

| Stage | Timing | |
|---|---|---|
| Acknowledge | ≤ 3 working days | Confirm receipt, assign an internal ID, state the disclosure clock |
| Triage | ≤ 10 working days | Severity via CVSS v4.0, plus a plain-English impact sentence that does not use the score |
| Fix and release | Target 90 days from report | The default deadline. Stated up front so it is a schedule, not a negotiation |
| Public advisory | On release, or at 90 days, whichever is first | **The clock does not stop because the fix is hard** |
| Reporter publication | Encouraged, at or after the advisory | The project never asks a reporter to stay quiet past 90 days |

Deviations, both directions:

- **Actively exploited, or the fix is trivial:** ship immediately, advisory same day. Do not hold
  a one-line CSP fix for a coordination calendar.
- **Fix requires a workspace-format change:** the deadline extends only by explicit agreement
  with the reporter, in writing, with a new date. Silence is not agreement.
- **Reporter wants to publish early:** they may. The project will publish its advisory to match
  rather than argue, because arguing is how projects acquire a reputation for suppression.

**Safe harbour**, published in `SECURITY.md`: good-faith research within the scope in §10.2,
against the reporter's own instance or workspace, will not be pursued legally, and the project
will state that publicly if a third party asks. Two carve-outs: no testing against another user's
data, and no testing against a hosted instance that is not ours.

**No bug bounty.** Stated with the reason: an unfunded project that advertises a bounty and then
haggles does more reputational harm than one that never offered. What is offered instead is
credit in the advisory, a named entry in `SECURITY-THANKS.md`, and a fast, honest process. That
is the whole of it.

### 10.5 Advisory format

Advisories are published in three places from one source of truth:

| Channel | Format | Why |
|---|---|---|
| Repository | OSV JSON (`osv.dev` schema) in `advisories/`, committed | Machine-readable, and it is the format the Rust and npm ecosystems' scanners consume |
| GitHub | GHSA, created from the same content | Where reporters and dependabot look |
| CVE | Requested for anything with a CVSS v4.0 base ≥ 4.0 or any confidentiality impact, regardless of score | Enterprise vulnerability management works on CVE IDs. A finding without one does not enter a customer's process |

The human-readable body follows the same shape as everything else this project writes, and the
order is not negotiable because readers stop after the second heading:

```
FATHOM-ADV-2026-0003
────────────────────────────────────────────────
WHAT BREAKS      One sentence. What an attacker gets, not what the code does.
AFFECTED         Component, version range, and the exact artifact hashes.
NOT AFFECTED     Say this. It is the most-read line and it is usually omitted.
RISK             CVSS v4.0 vector, and a plain sentence that does not cite it.
WORKAROUND       What to do before upgrading, or "none".
FIX              Version, release date, artifact hashes.
DETECTION        How a user checks whether they were affected — offline.
CREDIT           Reporter, with their preferred name.
TIMELINE         Reported / acknowledged / fixed / published, four dates.
```

`DETECTION` must be answerable without contacting us, because a user who trusted a no-egress
tool will not accept "log in and check your account" as an answer. For an emitted-config defect
(§10.3) the detection step is a corpus query the user can run locally against their own
workspace: which of my emitted lines came from rule `X`, at version `Y`. That is precisely the
provenance data invariant 6 requires emitters to carry, and this is the first place it pays for
itself outside the UI.

### 10.6 Dependency CVEs and VEX

A Rust and WASM project accumulates transitive advisories that do not affect it. Left
unaddressed, an enterprise scanner reports them and the tool fails a procurement gate for a
vulnerability in a code path that is not compiled in.

**DECISION — every release publishes a VEX document alongside the SBOM**, stating for each known
advisory in the dependency graph one of: `not_affected` with a justification code,
`affected`, `fixed`, or `under_investigation`. `not_affected` requires a written reason, and
"vulnerable code not present in the WASM build" is the most common one and must be verifiable
from the build manifest rather than asserted. `35` specifies the build that produces it.

---

## 11. Project continuity

### 11.1 The bus factor, without flinching

The bus factor is one. `72` §10 says so and `35` §12 says the project will not claim otherwise.
This section does not solve it — one person cannot be made into three by a document — it reduces
what is lost when the one person stops.

| Asset | If the maintainer disappears tomorrow | Control that makes it survivable |
|---|---|---|
| Source | Public, Apache-2.0, forkable | The licence. This is §5's R4 paying out |
| Corpus | Public, CC-BY-SA-4.0, forkable | Same, plus the entry-level `reviewed_by` and `origin` records mean a fork knows what it is inheriting |
| Build reproducibility | At risk: reproduction needs a pinned toolchain | The build container digest and `Cargo.lock` are in the repository and the release notes; a third party can reproduce without asking anyone (`35`) |
| Signing keys | **At risk. This is the real single point of failure** | §11.2 |
| Domain and package names | At risk: they lapse silently | §11.3 |
| Users' workspaces | **Not at risk. See §11.4** | Zero-knowledge, plus a published format and a reference decoder |
| Security inbox | At risk: reports go into a dead mailbox | The `Expires` field in `security.txt` becomes the tell. §11.3 |

### 11.2 Key custody

The signing key is the asset a fork cannot recreate and a successor cannot do without: users
verify releases against it, and rule packs are signed with a key chained to it.

**RECOMMENDATION — a three-layer arrangement, sized for one to three people:**

| Layer | Held how | Rotation | If lost |
|---|---|---|---|
| **Root key** | Offline, on two hardware tokens in two physical locations. Never on a networked machine. Signs only release keys | Every 3 years, or on compromise | Trust anchor must be republished and re-attested. Painful, recoverable |
| **Release key** | Hardware token, used at release time. Signs artifacts | Annually, or on maintainer change | Root re-issues. A day's work |
| **Rule-pack key** | Separate from the release key, so corpus publishing does not require the release token | Annually | As above |

**Recovery when the holder is gone.** Shamir splitting of the root key backup, 3-of-5, with
shares held by people who are not all in the same organisation or the same country, and — the
part projects get wrong — **an annual rehearsal in which three shareholders reconstruct a test
secret.** An unrehearsed split is a story about recovery, not a recovery.

**DECISION — the shareholders are named in `GOVERNANCE.yaml`, but which share is where is not
published.** Naming them is what makes the arrangement checkable by an enterprise reviewer;
locating the shares is what would make it attackable.

**The alternative worth considering:** keyless signing via Sigstore, where the trust anchor is a
transparency log and an OIDC identity rather than a key the project must guard. It removes the
custody problem entirely and replaces it with a dependency on a public service. For a project
whose flagship artifact is an *offline single file*, verifiable by an air-gapped user with no
network, that dependency is a poor fit: an offline verifier cannot check a transparency log.
**RECOMMENDATION — do both.** Sigstore for the convenience path, a long-lived offline-verifiable
key for the air-gapped path, and the release notes state which is which. `35` specifies the
mechanics.

### 11.3 The dead-hand controls

Continuity fails quietly. Three controls make it fail loudly instead:

| Control | Mechanism | What it prevents |
|---|---|---|
| **Expiring `security.txt`** | `Expires` set 12 months out, renewed at each release | A security inbox that has been dead for two years while `SECURITY.md` still promises 3 days |
| **Annual liveness release** | If no release has been cut in 12 months, cut one that changes only a `STATUS.md` line stating the project's condition honestly — maintained, minimal maintenance, or unmaintained | The worst outcome for a security tool: a repository that looks maintained and is not |
| **Custody of names** | Domain and package registrations held with multi-year renewal, and the registrar credentials in the same 3-of-5 escrow as the root key | A lapsed domain reissued to somebody who serves a modified WASM bundle from the URL in every old release note. For a tool distributed as a single file people bookmark, this is the highest-impact continuity failure there is |

The third one is the one that should worry the project most, and it is not usually on continuity
checklists. A dead project is inert. A dead project's *domain*, in someone else's hands, is a
supply-chain attack with a queue of trusting users already pointed at it.

### 11.4 What happens to users' workspaces — the good answer

*margin tab: why it exists*

This is where the architecture pays a dividend that most tools cannot pay, and it should be
written into the public governance page rather than left implicit.

**A user's workspace is already theirs.** It is an encrypted file on their disk. The server, if
they used one, never held the key and cannot have a copy of anything readable. If this project
stops tomorrow:

| Question | Answer |
|---|---|
| Can I still open my workspace? | Yes. The last released offline build is a single file; keep it and it keeps working. It has no egress, so nothing it depends on can be switched off |
| Will it stop working when a server goes away? | No. Sync is optional and the offline build has `connect-src 'none'` |
| Will it stop working when a licence server expires? | There isn't one. There is no phone-home of any kind, and this is checkable by a reviewer with a packet capture rather than takeable on trust |
| Can I get my data out without your software? | Yes. The format is specified and CC0, and §11.5 requires a reference decoder |
| What about the corpus I paid attention to? | CC-BY-SA-4.0, published, forkable, with per-entry provenance and reviewer records |

**Compare the alternative honestly.** A SaaS competitor's shutdown notice gives users 30 or 90
days to export, in a format the vendor chooses, from a service the vendor is winding down. Fathom
users need no notice and no export window, because there was never a moment when the data was
somewhere else.

**And state the corresponding cost, because §14 is not optional.** The same property means the
project can offer no recovery. A forgotten passphrase is unrecoverable. A deleted workspace file
with no backup is gone. There is no support path that ends in "we restored it for you," ever, and
the onboarding must say so before the first workspace is created rather than in a FAQ afterwards.

### 11.5 The cold-start guarantee

**DECISION — every release publishes a `fathom-coldstart` tarball containing everything needed to
rebuild and read the project from scratch with no access to us:**

| Contents | Why |
|---|---|
| Full source at the tag | Fork material |
| `Cargo.lock`, the vendored crate sources, the pinned toolchain version and the build container digest | Reproduction without a live registry |
| The workspace format specification (CC0) | Independent implementation |
| **A reference decoder, standalone, under 500 lines, with no dependency on the rest of the codebase** | The escape hatch that makes §11.4 true rather than aspirational. It must be small enough that a stranger can read it in an afternoon and reimplement it in another language |
| The corpus, and its schema | The asset |
| The public keys and the trust-anchor statement | Verification of older artifacts after the project is gone |
| `GOVERNANCE.yaml` at that tag | Who was responsible for what, at that moment |

The 500-line ceiling on the decoder is a real engineering constraint on `17`, not a wish. If the
workspace format cannot be decoded in 500 lines, the format is too complicated to be a format a
user owns, and the constraint is the forcing function that keeps it honest.

---

## 12. Trademark and naming

Apache-2.0 §6 declines to grant trademark rights, and that is deliberate: the mark is the one
thing a permissive licence leaves the project to hold. Under §5.2 it is one of only three things
that constrains a fork at all.

### 12.1 What is claimed

| Asset | Claim | Registration |
|---|---|---|
| The word mark | Common-law use from first public release. Registration in the owner's primary jurisdiction once there is anything worth defending | Deferred — §15 D8 |
| The wordmark's rendering | Copyright in the specific artwork, if any is ever made. The design language (`51`) has no logo, which makes this nearly moot and is one more argument for keeping it that way | n/a |
| Domain, package names, repository namespace | Held per §11.3 | Immediate |

The working codename is *Fathom* and the brief calls it a placeholder. **RECOMMENDATION — settle
the name before the first public release, not after.** A rename after the first release breaks
every published artifact hash reference, every bookmark, and the domain-custody control in
§11.3, and the cost rises monotonically from that day.
<!-- VERIFY: a trademark clearance search for "Fathom" in the relevant classes. The word is common and is in use in other software categories; assume it is contested until searched. -->

### 12.2 The policy

Short enough that people read it, which is the whole design goal of a trademark policy:

| You may, without asking | You may not, without written permission |
|---|---|
| Say your tool works with Fathom, imports Fathom workspaces, or extends Fathom | Name your fork or product "Fathom", or anything confusable |
| Say "based on Fathom" or "a fork of Fathom", clearly, in prose | Use the name as the primary identity of a distribution or hosted service |
| Redistribute unmodified official builds under the name | Redistribute **modified** builds under the name. This is the operative rule and the reason the policy exists |
| Use the name in talks, articles, courses and books | Imply endorsement, certification, or an official relationship |
| Publish a package that plainly names Fathom in the description | Register a package named `fathom-*` in a public registry as though it were official |

The modified-build rule is the one that matters for a security tool. A user who downloads
something called Fathom and verifies a hash against the project's published hashes must be
getting the project's build; if a third party may ship modified binaries under the name, the
reproducible-build story in `35` is decorative.

### 12.3 Vendor marks

Junos, SRX, PAN-OS, IOS-XE, Cisco, Juniper, Palo Alto Networks and every other vendor mark used
in the corpus, in `platform` identifiers, and in the UI, are the property of their owners and are
used nominatively — to identify the platform an entry is about. Concretely:

| Rule | |
|---|---|
| Use the mark only as much as needed to identify the platform | `junos-srx`, not a Juniper logo |
| No vendor logos, ever | Aligns with `design-language.md`'s "no logos" anyway |
| No styling that mimics vendor branding | Same |
| A `TRADEMARKS.md` listing every third-party mark used and its owner | The file an enterprise reviewer looks for |
| Never state or imply that a vendor tested, endorsed, certified or approved anything | Including in release notes, and including as a joke |

### 12.4 What we will and will not enforce

Honest, because an unenforced policy is a claim the project cannot back:

| Situation | Response |
|---|---|
| A fork using the name | A polite request. Then a registry/hosting takedown request. Then nothing, realistically |
| A hosted service using the name | Same escalation, pursued harder, because it directly endangers users who think they are using ours |
| Someone shipping a modified binary as Fathom | The one case the project will spend money on, because it is a user-safety issue, not a branding one |
| A course, book or blog using the name | Encouraged. No action, ever |

---

## 13. Governance structure, honestly

### 13.1 Now

One maintainer, benevolent-dictator model, with the review rules in §9.2 constraining what that
one person may merge alone. Not a foundation. Not a steering committee. Not a code of conduct
committee of one, which is a fiction that harms the person it is supposed to protect.

What is *not* deferred, because these are cheap now and expensive to retrofit:

| Now | Why not later |
|---|---|
| `GOVERNANCE.yaml` with roles, even if it has one row | The file's existence sets the expectation that roles are recorded, not remembered |
| A code of conduct with a named external contact | A CoC whose only reporting route is the person a report might be about is not a CoC |
| `SECURITY.md`, `CONTRIBUTING.md`, `TRADEMARKS.md`, `LICENSES/` | These are the files a reviewer greps for. Their absence is read as a signal about everything else |
| The no-relicensing commitment (§8.4) | Its credibility comes from being made before there was anything to gain by breaking it |
| Decision records in `90-decisions/` | The only defence against "why is it like this" once the person who knows has left |

### 13.2 Later, and the trigger

| Trigger | Move |
|---|---|
| A second maintainer with merge rights | Write down how disagreements resolve. Two people with no tiebreak is the worst count |
| Three or more organisations with contributors who depend on it | A published decision process, and a public roadmap discussion |
| Anyone offers money, or a company wants to pay for development | A legal entity, before the money arrives, not after |
| A vendor asks for a formal relationship | Counsel, and a published statement of what the relationship is and is not |

**Not a foundation, and the reason is specific rather than ideological:** foundation overhead is
real, sustained, and paid in the same hours that would otherwise write the corpus — which `72` §4
identifies as the binding constraint. A foundation is the right answer for a project with
multiple corporate contributors who need neutral ground. It is the wrong answer for a project
whose survival depends on one person's remaining attention.

### 13.3 What a governance body may not do

Recorded here so that a future, larger governance structure cannot quietly expand the product
into the things `03-non-goals-and-scope.md` refuses:

**No governance process may authorise a release that touches a network device, accepts a
credential, opens an unconfigured connection, or places a key on a server.** Those are the four
hard invariants. Changing one is not a feature decision made by whoever holds merge rights in the
year it comes up; it is a decision to build a different product, and it requires renaming it
(§12) so that users who trusted the old guarantee are not silently moved onto the new one.

---

## 14. What all of this costs

*margin tab: approx*

| Item | Cost | Who pays |
|---|---|---|
| Apache-2.0 rather than a source-available licence | A funded competitor may host a closed fork with no reciprocity (§5.2) | The project's commercial upside |
| The named-expert rule (§9.3) | The corpus grows at reviewer speed, not author speed. This is the project's dominant throughput constraint and `72` §4 already names it | The roadmap |
| `origin` on every entry (§7.3) | Real authoring overhead per entry — a lab session, or a standards lookup, for facts that a manual would have supplied in seconds | Every corpus author, on every entry |
| Wrong-rule-as-security-issue (§10.3) | An expansive security scope on the highest-volume, least-formal artifact in the project | The maintainer's inbox |
| 90-day disclosure with a 3-day acknowledgement (§10.1, §10.4) | A commitment a solo maintainer must honour while on holiday | The maintainer, personally |
| No bug bounty | Fewer researchers look | Security assurance |
| DCO with no relicensing option (§8.4) | If a relicense is ever genuinely necessary, it is impossible | Future flexibility |
| CC-BY-SA on the corpus | Some downstream users — particularly those wanting to embed entries in proprietary internal documentation and adapt them — will find it awkward, and a few will not adopt | Corpus reach |
| 3-of-5 key escrow with an annual rehearsal (§11.2) | A recurring obligation on five people, four of whom get nothing from the project | Five volunteers |
| The 500-line decoder ceiling (§11.5) | A hard constraint on the workspace format's design, forever | `17` |

**The two that will actually hurt** are the named-expert rule and the 3-day acknowledgement. Both
are commitments made by one person about their future availability, and both fail in the same
way: not by being repudiated, but by being quietly missed until nobody believes them. The
§11.3 liveness release is the control that makes that failure visible; there is no control that
prevents it.

---

## 15. Decisions this document asks for

| # | Question | Recommendation | Consequence if deferred |
|---|---|---|---|
| D1 | Code licence for A1–A3 | **Apache-2.0** (§5) | Every contribution before the answer is under an unstated licence, and cleaning that up later requires contacting each contributor |
| D2 | Corpus licence | **CC-BY-SA-4.0** (§6.2) | Same, and worse: corpus contributors are the ones least likely to be reachable a year later |
| D3 | Spec and schema licence | **CC0-1.0** (§6.2) | Third-party implementers stay away, and §11.4's promise weakens |
| D4 | DCO or CLA | **DCO 1.1** (§8.1) | Retrofitting a DCO across existing history requires re-attestation from every author |
| D5 | Is the no-relicensing commitment published? | **Yes, before the first release** (§8.4) | Made later, it reads as a response to an accusation |
| D6 | Does counsel accept the §7.2 model of what is protectable? | Ask before the corpus passes ~200 entries | The rewrite cost scales with corpus size and it is the one cost that only grows |
| D7 | Is a wrong `risk` label a security issue? | **Yes** (§10.3) | The first occurrence gets handled ad hoc, and the ad hoc handling becomes the precedent |
| D8 | Trademark clearance and registration for the final name | Clear before first release; register when there is something to defend (§12.1) | A rename after release breaks every published hash reference and every bookmark |
| D9 | Sigstore, offline key, or both | **Both** (§11.2) | The air-gapped user — the structurally under-served market the brief names — cannot verify anything |
| D10 | Who holds the 3-of-5 shares, and when is the first rehearsal | Named at first release; rehearsal within 90 days | An unrehearsed split is not a recovery plan |

---

## 16. Sources consulted

| Claim | Source |
|---|---|
| AGPL-3.0 §13's obligation is triggered by modification and by remote network interaction; full licence text | [GNU AGPL v3.0](https://www.gnu.org/licenses/agpl-3.0.html) |
| Many unmodified, standard deployments of AGPL modules do not trigger §13; the analysis is fact-specific | [Opensource.com, *Do I need to provide access to source code under the AGPLv3 license?*](https://opensource.com/article/17/1/providing-corresponding-source-agplv3-license) |
| "Code licensed under the GNU Affero General Public License (AGPL) MUST NOT be used at Google"; extends to workstations and issued devices without OSPO authorisation | [Google Open Source, *AGPL Policy*](https://opensource.google/documentation/reference/using/agpl-policy) |
| MPL-2.0 applies file-level copyleft; new files containing no MPL code are not Modifications; the Larger Work mechanism; combination with Apache and BSD code | [Mozilla, *MPL 2.0 FAQ*](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) |
| BSL 1.1: Change Date within four years, Additional Use Grant replaces BSL 1.0's Use Limitation, not an open-source licence; MariaDB's grant is "fewer than three server instances" | [MariaDB, *Business Source License 1.1*](https://mariadb.com/bsl11/); [SPDX, BUSL-1.1](https://spdx.org/licenses/BUSL-1.1.html); [FOSSA, *Business Source License (BSL 1.1)*](https://fossa.com/blog/business-source-license-requirements-provisions-history/) |
| FSL: authored by Sentry, November 2023; converts to Apache-2.0 or MIT after two years per version; "anything with FSL software except undermine its producer"; positioned as fair source rather than open source | [fsl.software](https://fsl.software/); [The Register, *Sentry introduces Functional Source License*](https://www.theregister.com/2023/11/20/sentry_introduces_the_functional_source/) |
| "We recommend against using Creative Commons licenses for software"; CC licences do not address source distribution or patent rights; CC0 is GPL-compatible and acceptable for software | [Creative Commons FAQ](https://creativecommons.org/faq/) |
| CC BY-SA 4.0 declared one-way compatible with GPLv3, October 2015; BY-SA includes no patent licence; the mechanism is intended for the niche case of content melded with code | [Creative Commons, *CC BY-SA 4.0 now one-way compatible with GPLv3*](https://creativecommons.org/2015/10/08/cc-by-sa-4-0-now-one-way-compatible-with-gplv3/); [FSF announcement](https://www.fsf.org/blogs/licensing/creative-commons-by-sa-4-0-declared-one-way-compatible-with-gnu-gpl-version-3) |
| DCO introduced by the Linux Foundation in 2004; enforced via a `Signed-off-by` trailer on every commit; always an attestation by the author; CLAs are not standardised and may be signed by an employer | [Linux Foundation wiki, *DCO*](https://wiki.linuxfoundation.org/dco); [Opensource.com, *CLA vs. DCO*](https://opensource.com/article/18/3/cla-vs-dco-whats-difference) |
| OpenInfra Foundation projects moved from CLA to DCO on 1 July 2025, citing contributor friction | [OpenInfra Foundation, *Developer Certificate of Origin*](https://openinfra.org/dco/) |
| `security.txt` fields and location | [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116.html) |
| IKE/IPsec protocol mechanics underlying the §7.4 worked example | [RFC 7296](https://www.rfc-editor.org/rfc/rfc7296.html) |
| `proposal-set standard` leads with DH group 2 and is not visible without the docs; clearing P1 tears down every child SA, which on a hub is every spoke; the PFS failure mode and the IKEv2 first-child-SA caveat | `.context/field-card-srx-ipsec.txt`, sides 2–3 |
| Reproducible builds, signing mechanics, bus-factor position, what the project will not claim | `docs/30-security/35-supply-chain-and-builds.md` §12 |
| Corpus as a programme, rot model, community-contribution analysis | `docs/10-core/15-explainer-corpus.md` §§12–13 |
| The content problem as the most likely cause of death; correctness liability; bus factor | `docs/70-ops/72-risks.md` §§4, 6, 10 |
| Hard invariants, the `Risk` enum, the `reviewed_by` requirement | `.context/conventions.md` |
| Voice rules that double as the copyright control in §7.4 | `.context/design-language.md` § *Voice* |

---

## 17. Disagreements

**1. No hard invariant, terminology entry, or the risk enum is disputed.** The `Risk` enum is used
in §9.3 and §10.3 only for what an emitted line or command does to a box, with the three values as
pinned.

**2. A proposed addition to the conventions, not a deviation.** §7.3 introduces a mandatory
`origin` field on every corpus entry, with exactly three permitted `kind` values and no
`documented` value. `.context/conventions.md` invariant 10 requires `reviewed_by` but does not
require the entry to record where its prose came from, and `61`/`63` specify the entry formats.
This document treats `origin` as a legal control rather than a content one and therefore asks for
it here; if it is accepted it belongs in the conventions and in both corpus specs, and this
document should stop being its home.

**3. A proposed narrowing of one implication of the brief.** Brief §1 describes the security
posture as zero-knowledge and §7.1 tabulates the threat model. §11.4 of this document draws the
governance conclusion that follows — that the project can never offer any recovery path for a
lost passphrase or a deleted workspace, and that this must be stated during onboarding rather
than discovered during a support request. That is a product-surface obligation the brief does not
state and it constrains `52` and `53`. It is recorded as a proposed change rather than assumed.

**4. A disagreement with a common reading, not with a convention.** It is widely assumed that AGPL
is the defensive choice for an open-source product with a hosted future. §4.2 concludes that for a
client-executed application it is close to inoperative, and that the reciprocity the project
actually wants is available from content share-alike (§6.3) instead. This is stated as a
conclusion rather than a disagreement because no project document asserts otherwise — but it
contradicts a default that reviewers of this repository are likely to arrive with, so it is
flagged here rather than left in §4 for them to find.
