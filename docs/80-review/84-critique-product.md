# 84 — Adversarial critique: the product

> **Status:** Contested

A hostile read of `00-vision/02`, `00-vision/03`, `70-ops/71`, `70-ops/72`, `10-core/16`,
`10-core/15`, `50-design/52`, `20-ai/21` and `70-ops/74`, from the position of somebody who has
watched developer tools with better funding and clearer markets than this one die quietly.

**The calibration first, because the rest is unkind.** `72` is the best risk document I have read
in a planning corpus. It computes the corpus cost from six different denominators and adds them
up (§4.2), it names the frequency problem that most wedge arguments hide (§7.2), it concedes that
the first-interaction comparison against a general assistant "is lost and cannot be won" (§11.4),
and its pre-mortem is not decorative. `03` §8 contains the truest sentence in the repository:
*"The sum of this table is that Fathom has no obvious business model."* `02` §13 lists eleven
categories where the product is worse and does not soften one of them.

That is the problem. **The corpus has already written down most of the reasons this fails, and
then produced a roadmap that assumes none of them.** `72` §4.4 concludes that the v2 target "is
not a plan, it is an aspiration, and it should be re-cut before phase 1." `71` was not re-cut.
`72` §7.5 predicts that the wedge is adopted and rung 3 is not. `71` sequences seven phases past
rung 3. Every finding below is either a claim the corpus makes that does not survive checking, or
a conclusion the corpus reached and then did not act on.

**The governing rule of this document:**

> **A RISK YOU HAVE WRITTEN DOWN AND NOT PRICED INTO THE PLAN IS A RISK YOU HAVE DECORATED**

---

## 0. Contents

| § | |
|---|---|
| 1 | The three findings that matter |
| 2 | §11.2 answered independently — why nobody has built the whole thing |
| 3 | The wedge, and what happened to its comparables |
| 4 | One graph, six views — the negative case |
| 5 | The teaching pillar against a general model |
| 6 | Who the user actually is — three personas, and the missing fourth |
| 7 | The minimum genuinely useful thing |
| 8 | Is the scope survivable |
| 9 | What I would cut |
| 10 | Smaller defects, each specific |
| 11 | The strongest reason to build this anyway |
| 12 | What would falsify this critique |
| 13 | Sources consulted |
| 14 | Disagreements |

---

## 1. The three findings that matter

| # | Finding | Where | Consequence |
|---|---|---|---|
| **P1** | **The corpus's answer to §11.2 is half the answer, and the missing half is demand, not supply.** `72` §4 concludes that funded teams stop because explanation is editorial rather than engineering work and does not compound. Correct, and well argued. But the record says something sharper: this artifact class reaches large usage and no revenue, then decays for want of a maintainer. Kite shut down with 500k developers and wrote *"individual developers do not pay for tools"* and that a measured 18% productivity gain *"did not resonate strongly enough"* with the managers who could pay. DevDocs — offline, keyboard-driven, instant search over a curated multi-source corpus, which is structurally the finder — has 40k+ stars, was donated to a nonprofit, and its README currently reads *"We are currently searching for maintainers."* `72` §10.4 reaches the same place from the burnout direction and files it under staffing. It is not a staffing risk. It is the answer to §11.2. | `72` §4.1, §4.9, §10.4; `03` §8 | §4.5's mitigation (narrow the scope) manages supply. Nothing in the corpus manages demand, and there is no row in `72` §2's register for "the project has no funding shape" |
| **P2** | **The wedge's best comparable did not convert; it was absorbed by the thing the corpus is competing with.** Brief §6.1 and the whole of `71` rest on "everybody uses a fast command finder immediately, and every result carries a link into the guidebook." The best-executed instance of that product for engineers — Fig, terminal autocompletion over an authored, community-maintained spec corpus for hundreds of CLIs — is now **Amazon Q Developer CLI**, an assistant, with the completion corpus as a feature inside it. Dash, the durable paid analogue (offline docsets, fuzzy search, keyboard-first, one developer, a decade of shipping), responded to the same pressure by shipping **MCP integration so assistants can query its docsets**. Two of the three healthiest products in this exact genre concluded that the corpus is the asset and the search box is not the destination. `02` §15's falsifier list has no entry for "the wedge is right and the destination is wrong." | Brief §6.1; `71` §3; `02` §15 | The project spends 12–18 solo weeks building a destination UI for a corpus whose highest-value delivery surface may be somewhere else, and has no instrument that would tell it |
| **P3** | **The AI section considers every way to put a model inside Fathom and no way to put Fathom inside a model.** `21` specifies four tiers, a supervisor, subagents, a broker, redaction profiles and an egress log — 14–22 solo weeks (`71` §9.6) — all of which import non-determinism into a product whose case rests on not having any. Nowhere does the corpus evaluate the inverse: a **local, read-only MCP server over the corpus**, shipped in D4, the static binary that already exists at phase 0. Check it against the invariants: loopback origin the user configured (1, satisfied exactly as `21` §7.3's tier-2b sidecar is); never touches a device (2); never accepts a credential (3); no server (4); retrieval is deterministic and the prose is the user's own assistant, outside our artifact path (9). `03` §4.8 refuses a chatbot **as the primary interface** — this is not one. Cost: days. Value: it puts an entry carrying `acceptable_when`, a risk label, `verified_against` and a named reviewer inside the tool the engineer already has open, which is `72` §11.2's own strategy — *"make the durable properties legible"* — delivered at the first interaction instead of the third. | `21` §§5, 7; `03` §4.8; `72` §11.2 | The corpus concedes the first interaction is lost (`72` §11.4) and then declines the one channel where being the citation is a win |

Everything below is smaller than these three.

---

## 2. §11.2 answered independently — why nobody has built the whole thing

*margin tab: read this first*

> **THE REASON IS NOT THAT IT IS HARD. IT IS THAT THE THREE PILLARS HAVE THREE DIFFERENT BUYERS**

The brief poses the question and `72` §4 answers it with content economics. I was asked to answer
it independently. I reach three reasons, in order of force, and the corpus has one of them.

### 2.1 Reason one — content economics. The corpus is right about this

`72` §4.1's formulation is correct and I cannot improve it: *"an engine is written once, tested,
and then improved; a corpus is written once per subject, per platform, per version, forever, by
somebody who has personally seen the failure being described. Engineering effort compounds.
Editorial effort does not."* §4.2's arithmetic — ~1,110 authored items, ~500 hours, 12–15
person-weeks for one platform × one domain — is built from six independent denominators and is
the most credible number in the repository. Accepted without qualification.

### 2.2 Reason two — nobody buys explanation as a product

The corpus does not make this argument and it is the stronger one.

Explanation at scale in this industry has always been funded as a **feature of something else
that sells**. Juniper and Cisco fund documentation and training because they sell boxes.
INE, CBT and the certification tracks fund curriculum because they sell courses. Network to Code
funds golden templates with commentary because it sells services — `72` §11.1 spots this exactly
and calls it *"content that exists and is not a product."* There is no standalone editorial
network-tooling business, and there is no standalone editorial developer-tooling business either.

Two data points from adjacent markets, both checked:

| Product | Shape | Outcome |
|---|---|---|
| **Kite** | ML code completion, 500k developers, a measured productivity claim | Shut down. Their own words: *"Our 500k developers would not pay to use it"*; *"individual developers do not pay for tools"*; an 18% productivity boost *"did not resonate strongly enough"* with engineering managers |
| **DevDocs** | Offline, keyboard-first, instant search over a curated multi-source documentation corpus — the finder's structural twin, in the largest developer market there is | 40k+ stars, donated to freeCodeCamp, MPL-2.0, README: *"We are currently searching for maintainers"* |

Against those, the one survivor in the genre is **Dash**: paid, one developer, a decade of
shipping, and it survived by charging money for a thing that has no free equivalent of equal
quality on macOS. That is the only sustainable shape found in this genre, and `74` §5's
Apache-2.0 recommendation plus invariant 1's ban on any usage measurement forecloses it.

**So the independent answer to §11.2 is not only that the content is slow. It is that the content
has no buyer, and every organisation that could afford to write it already monetises it through
something Fathom refuses to be** — a vendor, a trainer, or a services business.

### 2.3 Reason three — the three pillars have three different buyers

This is the sharpest form of the answer and no document in the corpus states it.

| Pillar | Who has the budget | Buying frequency | What they buy today |
|---|---|---|---|
| **Validate** | Security, compliance, audit | Annual, budgeted | Batfish (free), an assurance platform (`02` §4.3), an auditor |
| **Map** | Operations, network architecture | Annual, budgeted | NetBox, Nautobot, Infrahub, an assurance platform |
| **Teach** | **Nobody.** It is an individual good consumed by the person who does not hold the budget | Never | A free assistant, a book, a certification their employer reimburses |

Brief §4.2 says the three pillars are *"non-negotiable together"* and that the teaching pillar is
*"what makes the other two adoptable."* As a product argument that is coherent. As a
go-to-market it is a description of a thing with no buyer: the combination has no purchaser
because the two pillars with budgets are already served by incumbents that are better at them
(`02` §13 concedes exactly this, eleven times), and the pillar that differentiates is the one
that has never had a line item.

**That is why funded teams stop.** They do not stop at the corpus. They stop when the person
writing the funding case cannot name whose budget it comes out of, which happens well before the
corpus is large enough to hurt. `03` §8 has the enumeration and calls it "refusals that cost
money"; `72` §10.4 has the consequence and calls it burnout. Neither joins them into the answer.

**RECOMMENDATION — `72` gets a §4.10, "who pays for the corpus", with three named candidates and
a decision before phase 1:** (a) an employer funds D1 because Fathom is internal enablement for
their own engineers, which is the only shape where the content has a buyer and the buyer is the
same person as the user; (b) a vendor or training business funds it, which trades independence
for survival; (c) nobody funds it, in which case the correct and honest scope is one platform,
one domain, forever, and §9's cuts are not optional.

---

## 3. The wedge, and what happened to its comparables

*margin tab: does the bookmark convert*

### 3.1 The claim under test

> *"Strategically this is the on-ramp. Nobody adopts a network modelling platform on a Tuesday
> afternoon. Everybody uses a fast command finder immediately… Every result then carries a link
> into the guidebook and into the walkthrough."* — brief §6.1

`72` §7 interrogates this honestly and lands somewhere important: §7.2 concludes the conversion
event is rare and cannot be manufactured, and that the right posture is *presence at the
occasion*. That is correct and it is the best thinking in the corpus about adoption. What §7 does
not do is look at what happened to the comparables.

### 3.2 The comparables, and what happened to each

| Product | The wedge | What happened | What it tells this project |
|---|---|---|---|
| **Fig** | Fast, authored, community-maintained completion corpus for hundreds of CLIs. Keyboard-first. Beloved. The closest existing thing to "a fast command finder engineers open ten times a day" | Acquired by AWS. Now **Amazon Q Developer CLI** — an assistant, with the corpus inside it | The wedge worked as a wedge and converted into somebody else's assistant, not into its own platform. The corpus was the asset; the surface was not |
| **Dash** | Offline docsets, fuzzy search, one keystroke, paid, solo-maintained, a decade old | Alive, and now ships **MCP integration** so assistants can query its docsets | The one durable product in the genre responded to models by becoming a **source for** them. See P3 |
| **DevDocs** | Same shape as the finder, in a market 100× larger | Donated to a nonprofit, seeking maintainers | Enormous usage, zero conversion, no revenue, and it still decayed |
| **explainshell** | Paste a command, get per-token explanation from the manual pages. `02` §10 already nominates it as the closest UX analogue to reverse explanation | 14k+ stars, still up, essentially feature-frozen for years <!-- VERIFY: last substantive commit date and whether the public instance is maintained. Not checked this pass --> | A perfect wedge that never converted to anything, because there was nothing on the other side of it that the same user wanted |
| **tldr-pages** | Community-written, terse command examples | 63k+ stars, thousands of contributors, thriving as content and monetised by nobody | Command-shaped content **does** crowdsource. See §10, defect D4 |

**The pattern, stated plainly: in this genre the wedge converts to a bookmark or to an
acquisition, and never to a platform on the wedge-owner's terms.** Not one of the five became the
platform it was the on-ramp to. Fathom's roadmap is seven phases of platform behind a wedge whose
five nearest relatives all stopped at the wedge.

### 3.3 What that does and does not prove

It does not prove the wedge is wrong. `72` §7.2's reframing survives this entirely: if the
strategy is *presence at a rare occasion* rather than *conversion*, then a wedge that stays a
bookmark for two years and is still installed on the afternoon somebody builds a tunnel has done
its job. That is a coherent strategy and the architecture (no account, no expiry, no update nag,
no network) is unusually well suited to it.

What it proves is that **the roadmap is not built on that strategy.** A plan whose conversion
thesis is "presence at a rare occasion" does not spend 106–158 person-weeks building the thing
the user will be present for. It spends a quarter building the thing they keep, and then spends
years making the content better, and it waits. `71` and `72` §7.2 describe two different
companies.

### 3.4 The falsifier the corpus is missing

`02` §15 lists six falsifiers, all of which are about competitors. None is about the project's own
shape. Add:

| # | If this happens | The positioning that dies | Watch |
|---|---|---|---|
| **F7** | Pilot engineers keep the finder for six months, never open a workspace, and say the finder would be more useful inside the tool they already use | The destination thesis, and with it phases 1–7 as sequenced | Ask, at the six-month pilot review. `72` §7.4's "has anybody opened a workspace twice" is the same question one rung lower and it is already the right instrument |

---

## 4. One graph, six views — the negative case

*margin tab: elegant, and not the reason*

### 4.1 The claim, and the three places the corpus has already qualified it

Brief §1 and §4.1: six features, one data structure; *"views compose for free… it requires no new
subsystem."*

The corpus has already had to qualify this three times, in three separate documents, without
anybody retracting the headline:

| Qualification | Where | What it concedes |
|---|---|---|
| The six views are not the six projections. They are *"four renderers, one controller, one corpus surface, and one layer that opens inside all of them"* | `52` §1.1 | Two of the six projections have no view of their own. `explain` is a layer and `verify(diff)` is a mode of the config view. The slogan's count survives only by renaming things |
| *"That is true of the concept and not quite true of the code: graph diff, config diff, ladder selection and rollback generation are four real pieces of work"* | `71` §6.1 | The "free" composition costs 8–12 solo weeks, and it is the **shortest** phase in the document |
| *"cross-vendor emit of a security policy is not a supported operation and probably never will be"* | `11` §12.2, quoted in `72` §3.2.3 | One of the six projections does not generalise across platforms in one of the domains the product must cover. `72` restates the bet as *"neutral enough that `explain`, `lint` and `render` work across platforms even where `emit` does not"*, which is a different and smaller claim than brief §1 |

### 4.2 What the graph actually buys, and what it does not

It buys **consistency**, and consistency is worth a lot: a rename propagates everywhere
(invariant 7); a finding points at the same node the emitter read, which is what makes
click-a-line-to-explain structural rather than maintained (brief §4.1 consequence 2); provenance
survives from a walkthrough answer to a rendered line. That is real and it is the honest core of
the thesis. `02` §7.1 is right that Apstra converging on the same structure is evidence for it.

It does not buy **views**. Look at the roadmap's own prices: the diagram is 6–10 solo weeks
(`71` §7.5), the parser 14–20 (§5.7), findings/diff/verify 8–12 (§6.6), the walkthrough and
emitter 24–34 (§4.7). The marginal cost of each view is dominated by its own UI and by the corpus
behind it, neither of which the graph reduces. **The graph makes six views consistent. It does not
make them cheap, and the corpus repeatedly argues as if it did.**

### 4.3 The negative case, argued seriously

A single model with six thin renderers is precisely the mechanism that produces six features that
are each fourth-best in their category. Check each against `02` §13's own admissions:

| View | Competes with | Fathom's realistic position at one platform, one domain |
|---|---|---|
| finder | A general assistant, vendor docs, a browser tab | Better offline, better cited, worse coverage. **Defensible** |
| walkthrough | Nothing directly | The genuine gap. **Defensible** |
| config | NSO, Apstra, Golden Config, netlab | *"Strictly more capable"* incumbents (`02` §7.5). Defensible only for the single-task case |
| findings | Batfish | Categorically worse: no control plane, no reachability (`02` §13) |
| diagram | draw.io, netlab, every discovery tool | Fourth at best, and `03` §4.2 forbids the property (source of truth) that would make it valuable |
| inventory | NetBox, Nautobot, Infrahub | A refusal (`03` §4.2) rendered as a table. `02` §5 concedes everything at fleet scale |

Four of the six views exist because the slogan has six. The corpus's defence is `02` §13's closing
paragraph: the position *"depends entirely on the claim that the combination… is worth more to a
specific user than any single incumbent's depth."* That is an assertion with no evidence behind
it, and its falsifier is easy to state and impossible to satisfy from inside the corpus: **no user
has ever opened a tool because of a combination.** They open it for one view. The combination is
what keeps them, if they are already there.

### 4.4 The fix

Demote the slogan from an architecture claim to a consistency claim, and make the public sentence
describe rung 1 rather than the data structure. `02` §14.2's permitted three sentences currently
open with *"One graph, six views"* — an internal architecture note offered to a reader who does not
have a graph and is not going to build one this afternoon. Then cut two views (§9).

---

## 5. The teaching pillar against a general model

*margin tab: the hardest question*

The corpus does not dodge this. `02` §9 is a serious, unflinching treatment — §9.2's list of four
things an engineer can do today, free, in a browser tab, is the right list, and §9.5's table of
what survives when models get good is the right exercise. `72` §11.3 goes further and admits the
finder's advantages describe *"an engineer at 03:00 on a restricted network, and not the same
engineer at their desk on a Tuesday."*

So the question is not whether the corpus answered. It is whether the answer holds. `02` §9.3
names three structural differences. **One of them is overstated, one is already eroding by the
project's own hand, and one survives.**

### 5.1 Determinism — the argument as written is wrong

> *"You cannot diff two model answers. You cannot review a change whose generation is not
> reproducible."* — `02` §9.3, difference 1

The second sentence is false, and an evaluator will catch it in the room. **A change-approval
process reviews the artifact, not the generator.** The thing in the ticket is a block of `set`
lines. A block produced by a chat window is exactly as diffable, reviewable, re-readable and
pasteable as a block produced by an emitter. Nobody in a CAB meeting has ever asked whether the
text was reproducible from its inputs; they ask what it does and what backs it out.

What determinism genuinely buys is narrower and still worth having:

| Real benefit | Why it matters | Frequency |
|---|---|---|
| **Regeneration** — the same workspace produces the same ticket next quarter | Change fixtures, golden output, and the ability to re-run a change against a corrected corpus | Occasional |
| **Recall** — provenance answers "which of my configs came from that rule" when a rule turns out to be wrong | `74` §10.5's `DETECTION` line. A transcript cannot do this at all | Rare, and load-bearing when it happens |
| **Shareability** — two engineers on the same corpus version get the same ranked list (`16` §1.1) | A result is citable | Whenever a result is quoted |

Those are recall properties, not review properties. **Fix:** rewrite `02` §9.3 difference 1 to
claim regeneration and recall, and delete the review claim. The overclaim is the fastest way to
lose credibility with exactly the audience — change managers — the argument is aimed at.

### 5.2 Confidentiality — already eroding, and the corpus is planning to depend on the erosion

`02` §9.3 difference 2 is the strongest-sounding argument: the configuration never leaves the
machine. It is also the one the project undermines itself.

`21` §7.3 makes tier 2b — a llama.cpp-class **local sidecar** — the first tier with a model, and
`71` §9.3 calls it *"the tier this product should want people on."* The reasoning is that a local
model keeps every invariant because nothing leaves the machine.

That reasoning applies identically to the engineer, without Fathom. **If a local model is good
enough to run Fathom's own subagents, it is good enough for the engineer to ask directly, offline,
with no egress at all.** The confidentiality differentiator is not "offline" — local inference is
offline — it is "no model at all", which is a much narrower claim and one that gets narrower every
year the local-model quality curve moves. The corpus is simultaneously (a) resting its market case
on configurations not being sendable to a model and (b) planning a phase around configurations
being handed to a model that runs on the same laptop.

`02` §15's F2 catches half of this and frames it as a reproducibility risk. It is a
**confidentiality** risk, and it is the one that removes the structural market of brief §2.4 for
the desk case, leaving only the genuinely air-gapped case, which is §6's persona 2 and the hardest
user in the world to reach.

### 5.3 Provenance — survives, and it is the only one

`02` §9.3 difference 3 holds completely. A transcript cannot tell you which of your devices got a
recommendation that later turned out to be wrong. An emitted line carrying `(node, fields, rules)`
can, offline, forever. Nothing on the horizon changes that, because it is a property of the data
structure and not of anybody's accuracy.

### 5.4 So: is the teaching pillar defensible? Yes, on one claim, and the corpus states the wrong one

**The defensible claim is not "our explanations are better." It is: a named human ran this command
on a real box on a stated date, and the entry says so, and it says when it is no longer sure.**
That is a claim about *verification*, and no model can make it — not because models are
inaccurate, but because the claim is about a person and a box and a date, which is a fact about
the world rather than a property of an answer.

**What must be true for that to matter:**

| # | Must be true | Where it is specified | Status |
|---|---|---|---|
| 1 | Every entry has actually been run on real hardware, and this is a gate, not an aspiration | `71` X0.10; `61` §20 | Specified. `71` §3.3 admits *"none of them run on a box"* today, and `61` §20 admits the hardware for platforms two, three and four *"is not currently satisfied by anyone named in this project"* |
| 2 | `verified_against` and `Staleness` are **shown on every result**, not merely stored | `15` §13.2's margin tab | Specified as a field. Not, anywhere I can find, specified as required chrome on a finder row |
| 3 | The voice transmits to a second author | `72` §10.3's second-author test | New in `72`, unimplemented, and it is the single cheapest existential test in the corpus |
| 4 | The corpus is large enough to hit on a real question | `72` §4.4 | Three to four platform-domain units by year three, against a competitor with no coverage limit |

If 1 and 2 hold, the teaching pillar is defensible and durable. If they slip — if entries ship
unverified, or the verification is stored and not displayed — then Fathom is a slower model with
narrower coverage and a better tone, and `72` §4.9's *"90% right is indistinguishable from right
until it costs somebody an outage"* is the outcome.

**RECOMMENDATION — make the verification stamp non-optional UI, not corpus metadata.** Every finder
row, every explainer, every emitted line's explainer carries `junos-srx 21.4R3 · verified
2026-05-12 · K. Okafor` in muted mono, at the margin-tab weight. It is the product's only
unforgeable differentiator and it currently lives in a YAML field.

---

## 6. Who the user actually is — three personas, and the missing fourth

*margin tab: nobody here has a budget*

### 6.1 Priya — MSP network engineer, six years, forty customers

Junos SRX, FortiGate and PAN-OS in the same week. Builds tunnels regularly because her customers
keep buying new sites. Has no purchasing authority, a laptop she controls, and a strong habit of
keeping a browser tab of half-remembered commands.

| | |
|---|---|
| **Adopts the finder?** | **Yes**, week one, and this is the persona brief §6.1 is written for |
| **Crosses to rung 2 or 3?** | **No.** The walkthrough covers `junos-srx` only until phase 7 at the earliest (`71` §10.2), and FortiOS is fourth in the queue and explicitly chosen last (`71` §10.2: *"highest demand, lowest architectural information"*). Two of her three platforms are never modelled |
| **What stops her** | The Rosetta targets — the exact feature that serves her cross-vendor problem — are **stubbed** in phase 0: *"ship a stub target page that says PAN-OS corpus not written"* (`71` §3.4). Her headline query gets a stub |
| **Verdict** | She is the corpus's implied user and the corpus's own forecast (`72` §7.5) is that she never converts. Nobody has written down that those are the same person |

### 6.2 Marcus — defence integrator, twenty-two years, air-gapped estate

The user brief §2.4 identifies as structurally unservable by SaaS competitors. Every invariant in
`conventions.md` is written for him.

| | |
|---|---|
| **Adopts?** | He is the only persona for whom the entire security posture pays out |
| **What stops him** | Three things, and none is technical. **(a) Procurement.** `03` §8 concedes that no support, SLA or indemnity *"blocks enterprise procurement outright, independently of everything above."* An accredited estate does not run a single HTML file an engineer downloaded; it runs what was approved, and the approval process wants a vendor. **(b) Ingress.** Getting an artifact onto an air-gapped network is a controlled process, and `03` §3.3 refuses the update check that would let him know his build is stale. **(c) Notification.** `72` §8.1 item 10 — *"an air-gapped user on an old build cannot be told their build has a vulnerability"* — is unmitigable and is exactly the question his security officer asks first |
| **Verdict** | He is the market and he is the hardest single user in the world to reach. The corpus treats him as the easy case because the technology fits. **Technical fit is not procurement fit**, and there is no document in the repository about how an artifact gets into his estate |

### 6.3 Dan — first network job, one SRX pair, one year in

The persona the teaching pillar is written for. Ramping in. Has a general assistant open in
another tab and no scepticism about it yet.

| | |
|---|---|
| **Adopts?** | If a senior tells him to. Not otherwise, and the project cannot reach him — invariant 1 forecloses every discovery channel that involves the product |
| **What stops him** | Nothing stops him and nothing compels him. His alternative answers at his level, instantly, on any topic, and `72` §11.4 concedes it wins the first interaction. Fathom's advantage appears on the third |
| **The structural problem** | Dan is the persona whose **employer** would pay — enablement and onboarding are a budget line that exists. `03` §4.7 refuses every artifact that budget buys: no curriculum, no progress tracking, no completion record, no quizzes, no exam mapping. The refusals are individually well argued and collectively remove the only form in which the teaching pillar has ever been purchased |
| **Verdict** | Uses it as a reference if it is put in front of him. Cannot be reached, and cannot be sold around |

### 6.4 The missing fourth persona

**There is no persona in this corpus with a budget.** Every user described is an individual
engineer with no purchasing authority, using a free tool on a machine they control. `03` §8's
table of forgone revenue is eight rows long and every row removes a buyer; `72` §10.4 concludes
that the revenue shapes available all consume D1's time, which is the same time the corpus needs.

This is not a marketing gap. It is the §11.2 answer arriving from a third direction, and it should
be written down as a persona — the person who signs — with an honest note that the project has not
identified one and that §2.3 explains why.

---

## 7. The minimum genuinely useful thing

*margin tab: smaller than phase 0*

### 7.1 It is smaller, and the roadmap requires it to be destroyed

`71` §3.2 is nearly right. It specifies a two-week throwaway — one static page, the seed entries
inline, substring matching, no index, no WASM, no build system — to answer *"is the content the
value?"* Then: *"It is a throwaway. Name it `spike/`, put a banner on it, delete it at the end of
phase 0. A spike that survives becomes the architecture, and this one must not."*

For an engineering artifact that instruction is correct. For a **content** artifact it is
backwards, and this is a content product by the corpus's own repeated insistence (`72` §4:
*"the corpus is the product"*).

The minimum genuinely useful thing is:

| Component | Source | Cost |
|---|---|---|
| ~120 command entries, **run on a real SRX**, with `read_field`, `risk`, `blast_radius`, `next_if_bad` | `71` §3.3's corpus track and X0.10 | Already on the critical path. 74 h authoring + 30–50 h lab (`72` §4.2) |
| The three authored ladders and the eight error-decoder rows | Card sides 1, 3, 4 | ~7 h (`72` §4.2) |
| One static page, `Ctrl+K`, substring + prefix match over `cmd`, `answers`, `aka` | `71` §3.2's spike | 2 weeks |
| The three-value risk legend, rendered as the card renders it | `design-language.md` | Included above |

That is the field card, searchable, offline, one file, verified on hardware. **It is genuinely
useful on day one, to every persona in §6, and it is roughly a third of phase 0.**

### 7.2 What the other two-thirds of phase 0 buys, and when the payoff lands

| Phase-0 work | Buys | When the payoff lands |
|---|---|---|
| The concept layer, BM25F, FST trie, fusion, breadth resolution (`16`) | Ranking quality on paraphrased queries. **This is R-VOCAB and it is real** — `16` §2's demonstration that token overlap with the flagship query is zero is the best argument in the corpus | Immediately, on every query the user phrases in their own words |
| The CLI, `fathom golden`, byte-identical index across WASM and native (X0.4, X0.5) | Determinism, hence citability and diffability | **Rung 3.** `72` §7.2: a handful of times a year, per engineer |
| Reproducible-build attestation, CSP-over-final-bytes, single-file assembly (`35`, `43`) | Verifiability by a stranger | At an enterprise review, which §6.2 says is blocked for other reasons anyway |

The first row is worth building and should be built. **The second and third rows spend roughly a
third of phase 0 on properties whose payoff arrives at the rarest rung, before there is any
evidence that anybody wants the content at all.** That is the wrong order for a project whose own
kill point (`71` §12.1) is *"fewer than half the pilot group open the finder unprompted in week 3."*

### 7.3 The fix

**Invert `71` §3.2.** Ship the spike under the real name, with a version number, a published hash
and a `Staleness` banner. Let phase 0 replace it in place. The stated risk — a spike becoming the
architecture — is a risk about a code spike; a corpus rendered by four hundred lines of JavaScript
has no architecture to become, and the corpus is the only thing that carries forward regardless.

The gain: `71` §12.1's kill signal arrives three months earlier for a fortnight's work, and
`72` §4.2's R-CORPUS measurement (X0.11 — the median authoring time, *"R-CORPUS's only
instrument"*) starts running immediately rather than at the end of a quarter of engineering.

---

## 8. Is the scope survivable

*margin tab: blunt*

**No, as written. Yes, at about 40% of it.**

The corpus contains the arithmetic that proves this and does not apply it:

| Document | Says |
|---|---|
| `71` §2 | 106–158 person-weeks solo to phase 7; 53–79 with three people; *"the corpus does not finish at the end of it"* |
| `72` §4.4 | 12–15 person-weeks per platform-domain unit, +0.8/yr maintenance; at 0.6 FTE D1, **three to four units by year three**; and: *"the roadmap's v2 target of three platforms × three domains is not a plan, it is an aspiration, and it should be re-cut before phase 1 rather than discovered in phase 7"* |
| `71` §13.2, §16 decision 7 | Still defers platforms three and four with triggers; still leans *"second domain, two platforms"* |

**`72` §4.4 is an instruction to re-cut `71`, and `71` was not re-cut.** Two documents in the same
directory, one containing the refutation of the other's plan, and no reconciliation in either
`Disagreements` section. That is the single most consequential composition failure in the corpus,
and it is worse than any individual overclaim because it means the plan of record is one the
project has already disproved.

Three further observations, each blunt:

1. **The headline effort number excludes the largest line item.** `71` §2's table has columns for
   one person and a team of three, and no column for the corpus, because §15.3 says the corpus is
   not a phase. So the number a reader takes away — 106–158 weeks — omits the 12–15 person-weeks
   per unit that `72` §4.2 computes. Fix: add a corpus column to §2's table, or the table is
   misleading in the one place everybody looks.
2. **The first architectural bet is settled last.** R-SCHEMA is rated *"Fatal, and the most
   expensive to discover late"* (`71` §1.4) and is retired in phase 7, at 106–158 weeks. The
   justification (O2: order by risk ÷ cost-to-test) is sound in principle, but `72` §3.6 puts
   *"roughly even odds that it breaks on the second platform"* — a coin flip, resolved in year
   three, whose bad outcome costs 60–70% of phase 1 repeated. A project that cannot survive that
   outcome should not be sequencing it last; it should be **narrowing the claim now** so that the
   outcome does not matter. `72` §3.5 already describes that narrowing and calls it *"probably the
   right answer more often than the redesign is."*
3. **Solo, the project reaches its first falsification of its central bet at roughly the same time
   as the free alternative has had three years of improvement.** That is the real scope problem and
   no amount of parallelism inside the plan touches it.

---

## 9. What I would cut

*margin tab: the no-list, applied*

Cuts are named with what is lost, per the corpus's own convention. Total: **~40–60 solo weeks**,
none of it corpus.

### 9.1 Cut phases 6b–6e — the model tiers. Keep 6a

| | |
|---|---|
| **Saves** | 10–16 solo weeks of `71` §9.6's 14–22, plus ~20 rater-hours per release forever (`25`), plus the standing cost `72` §9 prices in credibility: *"what it costs to explain, in every enterprise review, forever"* |
| **Why** | `71` §12.7 already contains its own kill line: *"after a full release cycle, no pilot user can point to a decision the AI layer improved → ship tier 0 and stop."* Tier 0 links no model. The corpus has therefore already written down the condition under which the model tiers should not exist, and has scheduled 14–22 weeks of work before testing it. 6a — the boundary, the broker, the audit types, the **under-determination surface** — is 4–6 weeks and is genuinely good product: `21` §7.1 is right that the `NoHit` screen is the finder's weakest surface and that a deterministic disambiguation list is a real improvement on "no results" |
| **What is lost** | The owner's requirement in its literal form. **Mitigation:** 6a plus P3's local MCP server satisfies *"there needs to be a supervisor AI and sub agents"* more honestly than tiers 1–3 do — the supervisor is the assistant the engineer already runs, the subagent is Fathom, the boundary is a process boundary rather than a prompt, and invariant 9 is untouched because retrieval is deterministic and the prose was never ours |

### 9.2 Cut phase 4 — the diagram — to an export

| | |
|---|---|
| **Saves** | 5–9 of 6–10 solo weeks |
| **Why** | `03` §4.2 already refuses the property that makes a diagram valuable (recording what exists). `71` §7.1 concedes the cost of not having one is demo-ability — and §6.4 establishes there is no buyer to demo to. At one platform and one domain the graph is a handful of nodes; the user can see it in the inventory table. A layered, deterministic, layout-engine diagram (`fathom-layout`, 800–1,500 lines) for a workspace of twelve nodes is the clearest case in the plan of a view existing because the slogan has six |
| **What is lost** | Demos, and X4.7's change-ticket embed. `71` §7.5 already offers drag-only as the reduced form; this goes one step further to SVG export from the existing structure |

### 9.3 Cut multi-writer sync — take `71` §12.6's fallback now

| | |
|---|---|
| **Saves** | 8–12 of phase 5's 16–24 solo weeks (the CRDT is 4–6 alone, plus the `Store` conformance suite and the sync service) |
| **Why** | `71` §8.1's own argument is that every phase before five delivers full value on one machine, one user, no server. `03` §4.13 defers fleet scale. The workspace is a git-versionable document by design (brief §6.4). **Git is the sync**, and `71` §12.6 already names the exit: *"ship single-writer sync with explicit locking."* Taking a decision at week 4 that you have already written down as the likely outcome is not caution, it is scheduling. And `81` F3 reports that the merge driver as specified violates a `32` invariant, which is a second, independent reason not to build it |
| **What is lost** | Concurrent multi-writer teams. The 32-member ceiling was never the target user anyway |

### 9.4 Do not cut, but re-schedule: Rosetta and the finder corpus

`72` §4.8 already has this right and `71` has not absorbed it: **the finder's corpus can be wide
while the graph's corpus is narrow.** A command entry with `rosetta:` mappings costs 30–45 minutes
and needs no schema, no dictionary, no rule, no parser and no emitter. Four platforms of IPsec
command corpus is about eight person-weeks and it delivers the cross-vendor half of brief §2.1 —
Priya's actual problem (§6.1) — without touching phase 7.

`71` §3.4 currently ties Rosetta to phase 7 and ships a stub. That sequencing subordinates the
wedge's best feature to the modelling programme, which is exactly the inversion `72` §4.5 warns
against. **This is a cut of a dependency, not of a feature, and it is free.**

### 9.5 What survives the cuts

Phases 0, 1, 2, 3 on one platform and one domain, with a wide finder corpus and a narrow graph
corpus: **58–84 solo weeks, 29–42 with a team**, delivering the finder, the walkthrough, paste and
reverse explanation, findings, and the change ticket — which is `71` §2's own third coherent exit
(*"0+1+2+3 is a coherent product that can be shipped and left alone"*). Everything I have cut is
something the corpus already identifies as optional, deferred, or subject to a kill condition it
has not yet tested.

---

## 10. Smaller defects, each specific

| # | Defect | Where | Fix |
|---|---|---|---|
| **D1** | **The seed corpus count is wrong.** `71` §3.3 and `72` §4.2 both build on "84 seed entries." `corpus/commands/junos-srx-ipsec.yaml` holds **91** (`82` counts the same). Every downstream hour figure inherits the error | `71` §3.3; `72` §4.2 | Re-count and propagate. It is small, and it is exactly the class of unchecked number `02` §2.4 tells the project not to carry |
| **D2** | **`02` §11's landscape table is wrong in the row the positioning turns on.** "General LLM assistant" is scored `Offline: no`. Local inference is offline today, and `21` §7.3 depends on that fact for tier 2b. The same row scores `Teaches: ∼ yes`, which understates it | `02` §11 | Split the row into "hosted assistant" and "local assistant" and score them separately. The second row is the actual competitor and it does not appear in the table at all |
| **D3** | **`02` §14.2's public sentences open with an architecture slogan.** *"One graph, six views: diagram, config, findings, explanation, verification, inventory"* is the first thing a reader is offered, and it describes a data structure to somebody who has no workspace. `52` §1.1 has already shown the count is a rename away from being wrong | `02` §14.2 | Lead with rung 1: what it does with no setup, no account and no network. The graph is the second sentence at most |
| **D4** | **`72` §4.6 dismisses community contribution using explainer economics, then applies the conclusion to the whole corpus.** The 1.3× multiplier is computed for Tier A **explainer** entries, where voice is the product and the review gate is the bottleneck. It is then used to conclude that community contribution is not the answer generally. tldr-pages — thousands of contributors, tens of thousands of short command entries, sustained for a decade — is the counter-example, and command entries are precisely the mechanical genre it succeeds at. `61` even notes dictionary entries *"parallelise across authors better than explainers do"* | `72` §4.6; `71` §5.7 | Split the conclusion: community contribution is rejected **for explainers** and is the right mechanism **for command entries, dictionary entries and `rosetta` mappings**, which is also §9.4's wide-finder-corpus programme. This is a material change to the content plan |
| **D5** | **There is no risk register row for "the project has no funding shape."** `72` §2's one-page register has ten rows. `03` §8 states the problem, `72` §10.4 argues it, and neither surfaces it where a reader looks | `72` §2 | Add the row: likelihood **Near-certain**, impact **Fatal**, leading indicator *"whether D1's time is funded by anything other than goodwill in month twelve"* |
| **D6** | **`71` §2's totals omit the corpus and are the only number most readers will retain** | `71` §2 | Add a corpus column, or a footnote in the same table |
| **D7** | **The verification stamp is corpus metadata, not UI.** §5.4 above. `15` §13.2 specifies `Staleness` and the margin tab; no document requires `verified_against` on a finder result row | `16` §17.1; `52` §3.2 | Make it required chrome on every result row and every explainer header |

---

## 11. The strongest reason to build this anyway

*margin tab: why it exists*

I have argued that the market is absent, the wedge historically stops at a bookmark, the scope is
roughly 2.5× what the staffing supports, and two of the three differentiators are weaker than
claimed. The case for building it survives all of that, and it is this.

**The artifact already exists and it already works.** The four-side field card is not a
hypothesis. It was written by one expert, it is used, and every failure mode in this review is a
failure of *scale* — of platforms, of domains, of funding, of audience. Not one is a failure of
the card. A searchable, offline, risk-labelled, hardware-verified rendering of that card, for one
platform and one domain, with `acceptable_when` on every finding and a named human and a date on
every entry, does not exist anywhere at any price, and `02` §11.1's revised claim survives the
whole of this critique.

Three things make it worth doing even at the reduced scope:

1. **The one differentiator that no competitor can copy is not intelligence — it is a person, a
   box, and a date.** A model cannot claim that somebody ran the command on hardware in May and
   wrote down what the output actually said, because that claim is about the world. It is cheap to
   make, expensive to fake, and it gets more valuable as generated answers get more fluent, not
   less. §5.4 is the whole product in one sentence.
2. **The security posture and the adoption posture are the same posture, and that is rare.**
   `72` §7.2 spots it and it deserves more weight than it gets: for a product whose conversion
   event is rare, no account, no expiry, no network requirement and no update nag mean the *cost of
   waiting is zero*. The project can be small for years and still be present on the afternoon it
   matters. Almost nothing else in software gets to be dormant without decaying. This one does,
   because it is a file.
3. **The failure mode is survivable in a way most projects' are not.** If everything in §8 comes
   true, what remains is a corpus of verified entries in a documented format under a permissive
   licence, and a single HTML file that still opens in ten years with no network. `74` §11.4 and
   `35` §12.5 make that outcome real rather than rhetorical. A project whose worst case is "a very
   good reference for one platform that somebody else can fork" is a project worth starting.

**The honest framing, which is smaller than the brief's and which I believe:** build the card,
searchable, for one platform and one domain, verified on hardware, and let the graph earn its way
in behind it. That is `71`'s phases 0–1 with §9's cuts, it is roughly a year of one person's
serious effort rather than three, and it is the version of this project where every claim it makes
is one it can keep.

---

## 12. What would falsify this critique

Per `72` §1.1's own rule. I would be wrong if:

| # | If this happens | Which finding dies |
|---|---|---|
| C1 | A pilot engineer who does not work on the project opens a workspace twice in a quarter, unprompted, within six months of phase 1 | §3, §6 — the wedge converts and the persona analysis is too pessimistic |
| C2 | An employer funds D1's time on the grounds that Fathom is internal enablement | §2.3 and D5 — a buyer exists and it is the user's own employer |
| C3 | A defence or OT integrator completes an accreditation of the offline artifact without a support contract | §6.2 — procurement fit follows technical fit after all, and the structural market is reachable |
| C4 | The measured authoring median comes in at or below 25 minutes and stays there across 200 entries | §8 — the scope is 40% cheaper than `72` §4.4 computes and four units become seven |
| C5 | Phase 7 comes back with zero new node kinds | §4 and §8's second observation — the schema bet pays and the six-view thesis is stronger than I have allowed |

C1 is the one to actually watch, and `72` §7.4 already specifies the instrument.

---

## 13. Sources consulted

| Claim | Source |
|---|---|
| Kite shut down; *"our 500k developers would not pay to use it"*; *"individual developers do not pay for tools"*; an 18% productivity boost *"did not resonate strongly enough"* with engineering managers | [Kite, *Kite is saying farewell*](https://www.kite.com/blog/product/kite-is-saying-farewell/) |
| Fig is now Amazon Q Developer CLI following the AWS acquisition; the completion-spec corpus continues inside it | [withfig/autocomplete on GitHub](https://github.com/withfig/autocomplete) — *"Amazon Q Developer CLI, formerly known as Fig, is open source"* |
| Dash: offline docsets, instant fuzzy search, solo-maintained, and now ships MCP integration for AI assistants | [kapeli.com/dash](https://kapeli.com/dash) |
| DevDocs: offline, keyboard-driven, curated multi-source documentation browser; operated by freeCodeCamp; MPL-2.0; *"We are currently searching for maintainers"* | [freeCodeCamp/devdocs on GitHub](https://github.com/freeCodeCamp/devdocs) |
| explainshell: matches command-line arguments to their help text; 14k+ stars | [idank/explainshell on GitHub](https://github.com/idank/explainshell) |
| tldr-pages: community-authored terse command examples at large scale, with governance and PR review; 63k+ stars | [tldr-pages/tldr on GitHub](https://github.com/tldr-pages/tldr) |
| NetBox MCP server: released early 2025, hundreds of monthly downloads, native field filtering, plus NetBox Copilot and NetBox Operator; framed as structured context for agents | [NetBox Labs, *NetBox MCP Server*](https://netboxlabs.com/blog/netbox-mcp-server-tools-context-management-ecosystem/) |
| The wedge claim, the three pillars, the six projections, `answers`, the schema bet | `.context/owner-brief.md` §§1, 2.1, 2.4, 3.5, 4.1, 4.2, 5.1, 6.1–6.7 |
| The invariants, the risk enum, terminology | `.context/conventions.md` |
| The card's voice, the three-colour legend, the margin tab, what the card never does | `.context/design-language.md` |
| Prior art, the LLM wave, the landscape table, the falsifiers, the permitted public sentences | `docs/00-vision/02-prior-art-and-positioning.md` §§9, 11, 13, 14, 15 |
| The refused adjacents, the capability rule, the refusals that cost money | `docs/00-vision/03-non-goals-and-scope.md` §§3, 4.2, 4.7, 4.8, 4.13, 8 |
| Phase costs, exit criteria, kill points, the spike, the corpus track, staffing | `docs/70-ops/71-roadmap.md` §§2, 3, 4.5, 5.7, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16 |
| Corpus arithmetic, rot, community contribution, adoption rungs, the AI tension, competitive response, bus factor | `docs/70-ops/72-risks.md` §§3.5, 4.2–4.9, 7, 8.1, 9, 10.3, 10.4, 11 |
| The vocabulary gap demonstration, ranking determinism, what the finder is not | `docs/10-core/16-command-finder.md` §§1, 2, 17 |
| Corpus phasing, authoring rates, the rot model, staleness as a field | `docs/10-core/15-explainer-corpus.md` §§12.5, 12.6, 13.1, 13.2 |
| Six views restated as four renderers, one controller, one corpus surface, one layer | `docs/50-design/52-information-architecture.md` §1.1 |
| The AI tiers, the local sidecar, the under-determination surface | `docs/20-ai/21-ai-layer-architecture.md` §§5, 7.1, 7.3 |
| Apache-2.0, forkability, continuity | `docs/70-ops/74-governance-and-licensing.md` §§5, 11.4 |
| The seed corpus's actual entry count and its `reviewed_by` placeholders | `corpus/commands/junos-srx-ipsec.yaml` |
| The merge driver's conflict with `32`'s invariant | `docs/80-review/81-critique-security.md` F3 |

---

## 14. Disagreements

**1. No hard invariant, terminology entry, or the risk enum is disputed.** The `Risk` enum appears
in §7.1 only, as content the minimum artifact must render.

**2. A proposed correction to `71` §3.2 — ship the spike, do not delete it.** §7.3. The
instruction to destroy the only shippable artifact in phase 0 is correct for a code spike and
wrong for a content product. Recorded as a disagreement rather than assumed, because it
contradicts a stated decision.

**3. A proposed reconciliation between `72` §4.4 and `71`.** §8. `72` instructs that the roadmap be
re-cut before phase 1 and `71` was not re-cut. One of the two must change and this document argues
it is `71`. Neither document's `Disagreements` section mentions the other.

**4. A proposed addition to `21` and `03` §4.8 — a local, read-only corpus MCP server in D4.** P3.
This is an addition, not a deviation: it violates no invariant, and `03` §4.8's refusal is of a
chatbot as the primary interface, which this is not. It needs an explicit decision because it
changes what the AI layer is *for* — from consuming a model to being consumed by one.

**5. A proposed weakening of `02` §9.3, difference 1.** §5.1. The claim *"you cannot review a
change whose generation is not reproducible"* is false as written; change control reviews the
artifact, not the generator. The defensible claims are regeneration and recall, and they should
replace it before the sentence is said to an evaluator.

**6. A proposed split of `72` §4.6's conclusion.** D4. Community contribution is correctly rejected
for explainers and incorrectly generalised to command and dictionary entries, where the evidence
from comparable projects points the other way.

**7. A note on tone, not a disagreement.** This document is more negative than `02` §13 or `72`
§12, and it should be read alongside §11, which I believe. The corpus's own self-criticism is
better than most projects' external reviews; the objection is not that it is soft, it is that the
plan of record does not reflect what the corpus has already concluded.
