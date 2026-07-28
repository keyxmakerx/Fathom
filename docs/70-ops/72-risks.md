# 72 — The honest assessment: what is most likely to kill this

> **Status:** Reconstructed

The owner's brief carried a table of contents that promised *"Sections 11–14 are the honest
assessment: what's likely to go wrong."* The transmission ended inside §7.1 and §11 never
arrived. Two things about §11 are known from the surviving text:

> *"**This schema is the entire bet of the project.** See §11.1."* — brief §5.1
>
> *"**The gap is also a warning.** Several well-funded teams have built pieces of this. The
> reason nobody has built the whole thing is not that nobody thought of it — it is §11.2."*
> — brief §3.5
>
> *"Version predicates are not optional… A rule that is correct on one and wrong on another
> is worse than no rule. See §11.3."* — brief §5.2

So §11.1 is the schema bet, §11.2 is whatever explains why funded teams stop, and §11.3 is
version drift. This document reconstructs those three and adds the six the brief did not get
to name. It is not a re-specification of anything: where a mechanism appears here it is
specified elsewhere and cited.

Companion documents: `71` (the risk register this burns down, and the kill points),
`11` §§11–12 (schema evolution, the extension bag), `15` §§12–13 (corpus scale, the rot
model), `61` §§18, 20 (what the command entry format costs), `63` §18 (the authoring
backlog), `14` §§6.5, 15 (the statement dictionary as a content programme), `21` §§7–9 (the
AI boundary and what it costs), `35` §12 (bus factor, and what we will not claim),
`36` Q59 (the regulatory question, marked for counsel), `37` (privacy and compliance, which
is a different subject from the liability question in §6 here).

---

## 0. Contents

| § | |
|---|---|
| 1 | How to read this, and the scales |
| 2 | The register on one page |
| 3 | **11.1** — The schema is the bet |
| 4 | **11.2** — The content problem, which is almost certainly the real answer |
| 5 | **11.3** — Version drift |
| 6 | Correctness liability |
| 7 | Adoption, and whether the wedge converts |
| 8 | The zero-knowledge cost |
| 9 | The AI tension |
| 10 | Bus factor and burnout |
| 11 | Competitive response |
| 12 | The pre-mortem |
| 13 | What is not on this list |
| 14 | The decisions this document asks for |
| 15 | Sources consulted |
| 16 | Disagreements |

---

## 1. How to read this, and the scales

*margin tab: read this first*

> **A RISK WITH NO LEADING INDICATOR IS A FEELING, NOT A RISK**

### 1.1 The shape of an entry

Every risk below carries the same six fields, in the same order, because the ones people skip
are the ones that matter.

| Field | What it must contain |
|---|---|
| **Likelihood** | One of the three values in §1.2, with the condition that would move it |
| **Impact** | One of the three values in §1.2, stated as what specifically stops working |
| **Leading indicators** | Things observable *before* the risk fires, with a threshold where one exists. No indicator means the risk is not managed, it is merely described |
| **Mitigation** | What is actually built or done. Not "be careful" |
| **Residual** | What remains after the mitigation. This field is the point of the document |
| **Kill condition** | Where `71` §12 already names one, it is cited rather than restated |

### 1.2 The scales, and the enum they are not

**These are project-risk scales. They are not the `Risk` enum.** The `Risk` enum has exactly
three values — `ReadOnly`, `ChangesConfig`, `Disruptive` — it describes what a *command or
emitted line* does to a box, and its three colours are reserved for that and nothing else
(conventions § *the risk enum*; `51`). Project risk is a different axis and it is rendered in
neutrals, with weight and rules, exactly as finding severity is.

| Likelihood | Means |
|---|---|
| **Unlikely** | Requires a specific thing to go wrong that we have a control for |
| **Likely** | The default trajectory produces this unless something is done |
| **Near-certain** | This happens. The only question is when, and what state we are in when it does |

| Impact | Means |
|---|---|
| **Recoverable** | Costs weeks. The product that emerges is the product that was planned |
| **Expensive** | Costs months, or a phase repeated. The product survives, smaller or later |
| **Fatal** | The premise is falsified. The honest response is to change what the product claims to be, or to stop |

Three values each, deliberately, for the same reason the card holds three risk levels across
four sides: a fourth value is where the hard cases go to be avoided.

### 1.3 Relationship to the roadmap's register

`71` §1.4 carries an engineering risk register (`R-SCHEMA`, `R-CORPUS`, …) whose purpose is
*sequencing*: which risk is retired by which phase. This document's purpose is *survival*:
which risks are not retired by any phase, because no amount of building retires them.

| `71` register | This document | Why they are not the same thing |
|---|---|---|
| `R-SCHEMA` | §3 | `71` retires it in phase 7 by testing it. §3 is about what happens when the test comes back badly, with real workspaces in the wild |
| `R-CORPUS` | §4 | `71` measures the authoring median in phase 0. §4 is about the fact that the median is the smallest part of the problem |
| — | §5 | Version drift is retired by no phase. It is a standing operating cost |
| — | §6 | Correctness liability has no phase. It arrives the first time someone pastes output into a production box |
| `R-VOCAB`, `R-ONRAMP` | §7 | Those are mechanism risks. §7 is about whether the mechanism working is sufficient |
| — | §8 | Not a risk that can fire. A permanent, accepted cost that should be enumerated once, honestly |
| `R-AI-BOUND`, `R-AI-VALUE` | §9 | Those are technical. §9 is about credibility, which is not technical |
| — | §10, §11 | Neither is an engineering risk and both outrank most of the engineering ones |

---

## 2. The register on one page

*margin tab: the whole document in one table*

| § | Risk | Likelihood | Impact | The single leading indicator to watch |
|---|---|---|---|---|
| 4 | **The corpus does not get written, or stops being written** | Near-certain (in some degree) | Fatal | D1's authoring hours per month, plotted against the maintenance hours per month. The month those lines cross is the month coverage stops growing |
| 3 | **The schema is Junos-shaped** | Likely | Expensive → Fatal | `Representability::Composed` rate, and any `if platform ==` outside `fathom-emit`'s statement tables (`71` §10.3) |
| 7 | **The wedge does not convert** | Likely | Expensive | Whether any pilot engineer opens a *workspace* — not the finder — unprompted, twice, in a quarter |
| 5 | **Version drift outruns re-verification** | Near-certain | Expensive | The ratio of entries at `Staleness::Aging` or worse to entries at `Current`, per platform (`15` §13.2) |
| 11 | **A general assistant is good enough at the wedge** | Near-certain (it already partly is) | Expensive | Pilot engineers answering "where did you look that up" with anything other than Fathom |
| 10 | **The maintainer stops** | Likely over a 3-year horizon | Fatal, without preparation | Corpus commits per month, and whether the 50-entry reference set (`15` §12.5 P0) has ever been used by a second author |
| 6 | **A wrong emitted line causes an outage** | Unlikely per change, near-certain over the product's life | Expensive, and reputationally worse than it is operationally | Provenance coverage below 100% (X1.2); any rollback that is not proven inverse (X3.1) |
| 9 | **The AI layer becomes the credibility problem** | Likely | Expensive | Whether tier 0 is still the development default six months after 6b ships (X6.4) |
| 11 | **A source-of-truth vendor ships an AI-mediated explanation layer** | Near-certain | Expensive | Already partly happened. See §11.3 |
| 8 | **The zero-knowledge posture costs a decision we needed data for** | Near-certain | Recoverable | Not observable. That is the cost |

Read that table with §1.2's definitions in front of you. Four rows are `Near-certain` and none
of them is an engineering problem.

---

## 3. §11.1 — The schema is the bet

*margin tab: the entire bet*

> **A SCHEMA CO-DESIGNED WITH ONE PLATFORM WILL FIT THAT PLATFORM. THAT IS NOT EVIDENCE**

### 3.1 What is actually being bet

The brief states the bet without qualification: *"This schema is the entire bet of the
project."* It is worth being precise about what rides on it, because "the schema is wrong" is
usually heard as "some fields need renaming."

Everything in the product addresses the graph by kind, field or stable ID:

| Consumer | Addresses the schema by | Count at v1 | Breaks how |
|---|---|---|---|
| Rules | `applies_to: { kind }`, field paths in `condition`, `uses_ext` keys | 40–60 rules (`71` §4.2) | Loader validates every path against `schema.json` at load (`11` §11.6). A removed field is a pack that **fails to load**, loudly |
| Emitters | `StatementPath` tables keyed on kind + field | ~72 statement path templates (`15` §12.2) | Emitter no longer compiles, or emits nothing for a field that moved |
| Explainers | `explain:field:*`, `explain:kind:*` IDs mirror the thing they explain (conventions § *Identifiers*) | 66 `field` + `kind` entries at Tier A (`15` §12.5 P3) | The IDs are now wrong. CG4 and CG5 fail the build |
| The parser's bind stage | Dictionary entries name a target kind and field | ~2,000 per platform (`14` §6.5) | Bind rate collapses; residue spikes |
| Diagram elements | Node and edge IDs, kind-driven layer assignment | every element (X4.2) | Elements disappear or land on the wrong layer |
| Suppressions | `(rule_id, node_id)` | user data, in the workspace | A suppression survives a rename (invariant 7) but not a kind that ceased to exist |
| Workspaces | `schema_version` in the envelope header | every file any user owns | `11` §11.4: a higher major refuses to open for editing |

The last row is why this is a bet and not a refactor. **Four of the seven rows are our
problem and one of them is the user's.**

### 3.2 How vendor abstractions historically fail

This is the research the brief asked for. The OpenConfig and YANG experience is the closest
available analogue: an operator-driven attempt at exactly the thing Fathom is attempting — a
vendor-neutral schema over configuration that several vendors implement — with a decade of
public evidence about how it goes.

OpenConfig was started by technical contributors from Google, AT&T, British Telecom and
Microsoft to develop vendor-neutral schemas *"based on the needs and practices of network
operators"* ([OpenConfig FAQ](https://www.openconfig.net/docs/faqs/faq/)). It is the
best-resourced version of this bet that has ever been placed. Four failure mechanisms show up
in the record, and all four are available to Fathom.

#### 3.2.1 The escape hatch becomes the interface

YANG has two mechanisms for a vendor whose box does not match the neutral schema:
`deviation` and `augment`. RFC 7950 defines a *server deviation* as
*"a failure of the server to implement a module faithfully"* (§3, Terminology), gives the
statement in §7.20.3, and states the consequence in §5.6.3:

> *"Deviations from the model can reduce the utility of the model and increase the fragility
> of applications that use it."*
> — [RFC 7950 §5.6.3](https://www.rfc-editor.org/rfc/rfc7950.html)

That sentence was written into the standard *before* the deviations existed. It did not stop
them. Vendors ship deviation and augmentation files alongside their OpenConfig
implementations as standard practice — Nokia documents shipping both, with deviations for
*"implementations that are not supported, added, or replaced, granularity mismatches, and
different ranges"* and augments for *"configuration for OpenConfig that is required by the
Nokia application in order to function as expected"*
([Nokia SR OS system management guide](https://infocenter.nokia.com/public/7750SR222R1A/topic/com.nokia.System_Mgmt_Guide/deviating_and_a-d402e1369.html)).

The mechanism is not the failure. The mechanism is *correct* — a neutral schema without an
escape hatch is a schema that vendors cannot implement at all. The failure is that once the
escape hatch exists, the marginal cost of using it is always lower than the marginal cost of
changing the neutral schema, so it accumulates monotonically, and an application that wanted
one interface ends up handling N.

**Fathom's version of this is `VendorExt`** (`11` §12.4). The eight rules on it — registered
keys only, typed scalars only, one platform per key, not a rule input by default, never
load-bearing for identity, three-strikes promotion, a 15% budget, never a secret — are an
unusually disciplined version of the same escape hatch. `11` §12.4 says the honest part
itself: *"The bag is where the model goes to die."* And it names the specific way rule 3 gets
defeated: define `junos-srx/x` and `junos-mx/x` as separate keys with identical meanings.

#### 3.2.2 The native schema never goes away

The stated purpose of a neutral schema is that applications stop needing the vendor-specific
one. In practice both are shipped and both are used, because
*"native models will be the only place you'll likely find support for networking features
that are specific to a vendor or platform, and may also provide access to features and data
before the IETF and OpenConfig models are updated to support new things"*
([Cisco, *Native, IETF, OpenConfig… Why so many YANG models?*](https://blogs.cisco.com/developer/which-yang-model-to-use)).

The second half of that sentence is the important one: the neutral schema is structurally
behind, because it can only model a feature after both the vendor has shipped it and the
neutral schema has been revised. **Fathom pays this in a specific form: any feature a vendor
ships between our schema majors is unmodellable, and lands in the extension bag by
construction.**

#### 3.2.3 Syntax generalises; semantics does not

The interesting divergences are not lexical. `11` §12.2 already documents the deepest one —
Junos policy lists per zone pair, PAN-OS one flat ordered list per vsys, IOS ACLs bound to an
interface and direction — and reaches the right conclusion:

> *"cross-vendor emit of a security policy is not a supported operation and probably never
> will be."*

That is the honest form of the finding, and it is worth noticing what it means: the schema is
already conceding that one of the six views (`config = emit(graph, vendor)`) does not
generalise across vendors for one of the domains the product must eventually cover. The bet
is not "the schema is neutral". The bet is **"the schema is neutral enough that `explain`,
`lint` and `render` work across platforms even where `emit` does not."** That is a weaker and
much more defensible claim, and it should be the claim the product makes.

#### 3.2.4 The union/intersection dilemma has no good answer

A neutral schema is either the intersection of what platforms do — in which case it cannot
express most real configurations — or the union, in which case every consumer must handle
fields that are meaningless on the platform in front of it. OpenConfig sits nearer the
intersection and pays with deviations. Batfish sits nearer the union and pays by maintaining
a separate vendor-specific representation layer, which `11` §2.2 explicitly rejects for
Fathom on the grounds that *"two parallel hierarchies means emit is a second translation and
the two drift."*

Fathom's answer is: union-ish core, plus `Presence` four-state so that "this platform has no
such concept" is representable, plus `Representability` classification on emit so a
cross-platform emit reports what it could not carry (`13` §9). That is a third position and
it is a reasonable one. It is also untested — nobody in this repository has run it against a
second platform, which is exactly what `71` phase 7 exists to do.

#### 3.2.5 The older precedent, for calibration

SNMP solved the same problem in 1991 by declaring defeat structurally: MIB-II standardises
the common objects, and everything else lives under the private enterprise arc
(`1.3.6.1.4.1.<vendor>`). Thirty-five years later the enterprise arc is where all the
interesting data is and the standard MIBs answer roughly "is the interface up". That is what
an unbudgeted extension bag looks like at maturity, and it is precisely why `11` §12.4's rule
7 puts a hard numeric cap on the bag with a build failure attached. The 15% figure is
arbitrary and `11` says so; the point of a number is to force the conversation, not to be
correct.

### 3.3 Leading indicators

In order of how early they fire.

| # | Indicator | Threshold | Where it is measured | What it means |
|---|---|---|---|---|
| S1 | Extension keys as a share of total field count on the kinds they attach to | 15% (`11` §12.4 rule 7) | CI, build-failing | The bag is absorbing modelling work |
| S2 | Duplicate `meaning:` strings across platforms in `extensions.yaml` | any | CI warning (`11` §12.4) | Rule 3 is being routed around |
| S3 | `if platform ==` outside `fathom-emit`'s statement tables | any occurrence | grep gate (X1.4, X7.7) | Invariant 5 failing in code |
| S4 | A rule acquiring a platform-specific *condition* rather than a `platforms` predicate | any | pack review (X7.8) | Invariant 5 failing in the corpus, which is harder to fix |
| S5 | `Representability::Composed` share of emitted lines | ~10% (`71` §10.3) | emit report | The mapping has judgement in it the user cannot follow |
| S6 | Parse residue concentrated in *structures* rather than *statements* | qualitative | phase 2 residue ledger | `71` §12.3 already calls this "R-SCHEMA arriving early" |
| S7 | The paper divergence table for PAN-OS and IOS-XE, written in phase 1 (`71` §4.5) | any object-decomposition mismatch | three days of D1 time | The cheapest smoke detector available |

**S7 is the one to actually do.** `71` §4.5 budgets it at three days during phase 1 and calls
it a smoke detector rather than a substitute for phase 7. Three days against a phase-7
contingency of 4–8 weeks is the best-value line item in the project.

**S6 deserves a note.** It is the only indicator that fires from *user data* rather than from
our own code, and it is therefore the only one that cannot be gamed by discipline. When real
configurations from estates we did not write leave residue that is structural rather than
lexical, the schema has met a shape it does not have, and no dictionary entry fixes that.

### 3.4 Recovery: a breaking change in year two, with workspaces in the wild

This is the scenario the assignment asks for and it is worth walking end to end, because the
honest version is not "we bump the major".

**The situation.** Month 20. Phase 7 has come back with the third outcome in `71` §10.1: PAN-OS
needs new kinds, or a containment relationship has to change — say `TrafficSelector` moves
from being owned by `IpsecVpn` to being owned by a new `SelectorSet` because PAN-OS proxy IDs
and IOS-XE VTI `any any` selectors cannot both hang off the VPN. Per `11` §11.3, containment
restructuring is a **major** bump. There are perhaps a few hundred workspaces in existence,
some of them on air-gapped networks, some in git repositories with two years of history.

**What breaks, precisely.**

| Thing | Breaks | Cost |
|---|---|---|
| Rule packs | Every `applies_to` and field path referencing the moved kind fails `schema.json` validation at load (`11` §11.6). **Loud, immediate, correct behaviour** | Re-author ~8–15 of 50 rules. 3–5 hours |
| Emitter statement tables | Compile failure or empty emit for the affected paths | 1–2 days |
| `explain:kind:` / `explain:field:` IDs | The IDs mirror the thing they explain, so they are now wrong. CG4/CG5 fail | ~20 of 66 Tier A entries re-addressed. Mostly renames: 3–4 hours. The ones that are genuinely different concepts must be rewritten: 5–8 entries × 35 min |
| Statement dictionary bind targets | Every entry naming the moved kind rebinds | ~40–150 of 250 domain-slice entries × 3 min = 2–8 hours. **At full platform scope (~2,000 entries) this is the expensive one** |
| Golden emit fixtures | All of them, including X1.1's byte-identity fixture against the field card | Re-baseline: 1 day, plus the argument about whether a diff is a regression or the intended change |
| Existing workspaces | Migration required. `11` §11.5's chain, total and provenanced | 1–2 weeks to author and golden-test the migration |
| Old builds opening new workspaces | **Refuse to open for editing.** Degraded inspector only (`11` §11.4) | Not fixable. See below |
| Suppressions | A suppression against a kind that no longer exists is not migratable in general | Must be surfaced, not silently dropped |

Engineering total: **3–6 weeks.** Corpus total at one-platform scope: **1–2 weeks of D1 time.**
Corpus total at two-platform, full-dictionary scope: **4–7 weeks of D1 time**, and D1 is the
scarcest resource in the project (`71` §15.1). That asymmetry is the finding: **a schema major
costs more in content than in code, and it costs more the later it happens, superlinearly in
corpus size.**

**The user-facing part, which is the part that is not recoverable.** `11` §11.4 states it
without softening:

> *"an air-gapped user on an old single-file build cannot open a workspace a colleague saved
> with a newer major, and they may have no path to update."*

Three mitigations exist and none removes it: majors are rare and announced; the export format
is major-stable; the build's `schema_version` is in its filename and header. To those, this
document adds two more that belong in the recovery procedure rather than in the schema doc:

**RECOMMENDATION — a dual-write window.** For one minor release before the major lands, the
new build writes workspaces at the *old* major by default, with an explicit opt-in to the new
one, and a banner that says which. The point is not technical; it is that the team with one
air-gapped member gets a quarter to plan, rather than discovering the split when somebody
mails a file.

**RECOMMENDATION — `fathom migrate` in the CLI (D4), offline, single static binary.** The
degraded inspector (`11` §11.4) is a read path. The air-gapped user needs a *write* path that
does not require the new UI build, and D4 is already a single binary with no dependencies
that can be carried in on media. This costs a day and it is the difference between "you are
stuck" and "run this."

**The policy that matters more than either.**

**DECISION — at most one `schema_version` major per 24 months, and the window is announced
before phase 7 starts.** The cost of one major is measured above and it is survivable. The
cost of two inside eighteen months is not a doubled cost — it is the end of the claim that a
workspace is a document you own, because a document format that breaks twice is a format
nobody commits to a git repository. If phase 7 produces a second major less than 24 months
after the first, the correct response is not to ship it. It is to conclude that the schema is
still being designed, and to stop shipping workspaces as a durable format until it is not.

### 3.5 The other recovery, which is legitimate and will feel like defeat

`71` §12.8 offers option (b): *"reposition as a Junos tool that reads other platforms, and
rewrite the marketing to match."* This deserves more than a clause, because it is probably
the right answer more often than the redesign is.

| | Redesign the schema with two platforms in view | Narrow the claim to one platform |
|---|---|---|
| Cost | 60–70% of phase 1 repeated (`71` §12.8) plus the corpus cost in §3.4 | Weeks. Mostly documentation and positioning |
| What survives | The multi-platform premise | Everything that already works, at full depth |
| What dies | 4–6 months | The Rosetta feature (§6.1 of the brief), and the cross-vendor market |
| Honest read of the market | The vocabulary gap the brief opens with (§2.1) is *worst* across vendors, so narrowing attacks the founding problem | But one platform taught properly is a product; three platforms half-taught is vendor documentation with better search (`15` §13.6 point 4, which already says this about depth) |

The asymmetry to notice: **`explain` and `lint` still work across platforms after narrowing.**
`11` §12.2 already concluded that reading a PAN rule set and a Junos rule set and describing
both in the same vocabulary *"is the actual value of the neutral model, not translation."* A
narrowed Fathom is "emits Junos, reads and explains four platforms," which is a coherent and
honest product and loses far less than it sounds.

### 3.6 Assessment

| | |
|---|---|
| **Likelihood** | **Likely** that the schema *bends* (new fields, fields moving between kinds, extension bag growth). **Unlikely** that it holds unchanged. Roughly even odds that it *breaks* on the second platform, and the odds get worse on the second *domain*, which is the axis nobody is testing |
| **Impact** | **Expensive** if caught in phase 7 as planned. **Fatal** if caught in year three with two platforms of dictionary and several hundred workspaces, because at that scale the corpus re-addressing cost exceeds the appetite to pay it and the escape hatch wins by default |
| **Leading indicators** | S1–S7 in §3.3. S7 is three days and should be spent in phase 1 |
| **Mitigation** | The extension bag's eight rules with build failures rather than warnings (`11` §12.4); schema-as-data with load-time validation so a broken rule pack fails loudly (`11` §11.6); total, provenanced, golden-tested migrations (`11` §11.5); the major-stable export format; §3.4's dual-write window, `fathom migrate`, and the 24-month major cadence |
| **Residual** | **The air-gapped user on an old build cannot open a colleague's newer-major workspace, and no mechanism in this design removes that.** It is mitigated to "annoying and planned-for" and it will still cost somebody a bad afternoon. Separately: every control above is a control on *our* discipline, and §3.2.1's whole lesson is that discipline loses to the marginal-cost gradient over a long enough period. The 15% cap is the only control that does not depend on anybody caring on the day |
| **Kill condition** | `71` §12.8 |

---

## 4. §11.2 — The content problem, which is almost certainly the real answer

*margin tab: why funded teams stop*

> **THE CORPUS IS THE PRODUCT. EVERY OTHER LINE IN THIS DOCUMENT IS SECONDARY TO THIS ONE**

### 4.1 Reconstructing what §11.2 said

The brief's §3.5 sentence is the strongest clue in the surviving text:

> *"Several well-funded teams have built pieces of this. The reason nobody has built the whole
> thing is not that nobody thought of it — it is §11.2."*

The landscape table in §3.5 shows what those teams built. Batfish built a vendor-independent
model and a query engine. Nautobot built intent-to-config with Jinja2 and compliance diffing.
NetBox built the source-of-truth category. Every one of those is an *engine*. Not one of them
ships explanatory content, and §2.3 of the brief is the observation that follows:
*"Nothing in the open-source landscape treats understanding as the deliverable."*

The reason is not that explanation is hard to conceive. It is that explanation is not
software. An engine is written once, tested, and then improved; a corpus is written once per
subject, per platform, per version, forever, by somebody who has personally seen the failure
being described. Engineering effort compounds. Editorial effort does not — it accrues a
maintenance liability proportional to its own size. A funded team optimising for
demonstrable progress will always build the engine, because the engine demos and the corpus
does not.

**So §11.2 said: the content is the moat and the content is the reason to give up.** This
section quantifies both halves.

### 4.2 What "credible coverage of one platform and one domain" actually costs

The unit is `junos-srx` × site-to-site IPsec, including the plumbing the field card covers.
It is the right unit because it is the one the project is actually planning to build, and
because the content already exists on paper, which removes "nobody knows what to write" from
the estimate.

Every count below is sourced. Every rate is labelled as a measurement or an assumption.

| Artefact | Count | Source of the count | Minutes each | Rate source | Hours |
|---|---|---|---|---|---|
| Explainer entries, all 13 classes | 430 | `15` §12.2, machine-counted denominators | 35 | `15` §12.6 (assumption, self-flagged) | 251 |
| Command corpus entries | 120 | `71` §3.3 (84 seed → ~120 after review) | 37 | `61` §18 (30–45, assumption) | 74 |
| Finder concepts — retrieval surfaces, **not** `concept` explainers | 120 | `71` §3.3, from `16` §3.6 | 10 | assumption | 20 |
| Statement dictionary, domain slice | 250 | `71` §4.2 | 10 | `71` §14.1 (derived, not measured) | 42 |
| Rules, each with ≥2 fixtures | 50 | `71` §4.2 (40–60) | 75 | `71` §14.1 (60–90) | 63 |
| Golden query set | 120 | `71` §3.3 | 5 | assumption | 10 |
| Ladders, error decoder rows, release calendar | ~20 | card sides 1, 3, 4 | 20 | assumption | 7 |
| **Conformance lab** — run every command and statement on a real SRX, record actual output field labels, case and spacing | 120 commands + 47 statements | X0.10, `15` §12.1 | — | assumption | 30–50 |
| **Total** | **~1,110 authored items** | | | | **~500–520 h** |

At `71` §1.3's person-week (five days of focused work, ~38 usable hours), that is
**12–15 person-weeks for one platform × one domain.**

Two things to notice.

**First, this is roughly double what any single sibling document implies.** `15` §12.6 puts
v1 at 6–7 person-weeks, and it is right — for explainers. Explainers are 251 of the ~510
hours. The other half is commands, concepts, dictionary, rules, golden queries and lab time,
each of which lives in a different document and none of which is small. **Nobody is
underestimating the corpus in this repository; the estimate is simply spread across six
files and has never been added up.** It is added up here.

**Second, the count of prose pieces is larger than the count of entries.** `15` §12.2 works
it out: 430 entries × 3 depths + 430 × 2 counterfactual fields ≈ 2,100 pieces of writing.
Command entries also carry three depths (`61` §11.1), adding ~360. So the unit is
**roughly 2,500 individual pieces of prose**, each of which has to be true, in one voice, and
worth reading. That is a book. It is a book about one VPN topology on one platform.

### 4.3 Extrapolation

Not everything multiplies. `15` §12.2 works out the sharing model and it is the single most
important structural fact in this section:

| Class | Shares across platforms? | Shares across domains? |
|---|---|---|
| `kind`, `field`, `value`, `concept`, `symptom` explainers (~45%) | **yes** | partly |
| `line`, `block`, `command`, `output`, `error`, `step` explainers (~55%) | no | no |
| Command corpus entries | no | no |
| Statement dictionary | no | no |
| Rules — body, `why`, `acceptable_when`, `sources` | **yes** | no |
| Rules — `remediation` per platform, `platforms` predicate | no | no |
| Conformance lab | no (needs the hardware) | partly (same box, more commands) |

Marginal costs that follow:

| Increment | Content | Hours | Person-weeks |
|---|---|---|---|
| The first unit (`junos-srx` × IPsec) | everything | ~510 | **12–15** |
| **+1 platform, same domain** | ~240 platform-specific explainers, 120 commands, 250 dictionary, 50 remediations, lab | ~310 | **8** |
| **+1 domain, same platform** | full structure again minus some shared `concept`/`symptom` | ~420 | **10–13** |
| 3 platforms × 3 domains, from nothing | 1 + 2×8 + 2×11 + 4×8 | ~3,100 | **~83, ≈ 19 person-months** |

That last figure is consistent with `15` §12.6's independent estimate of ~6 person-months for
the v2 *explainer* corpus alone, since explainers are about 40% of the total. Two estimates
built from different denominators landing in the same place is the strongest evidence
available that the number is roughly right.

**The +1 platform row has a footnote that is larger than the row.** `61` §20 states it
plainly: the format assumes the author can run the command, and for PAN-OS, IOS-XE and
FortiOS *"it is not currently satisfied by anyone named in this project."* Entries authored
without hardware ship as `status: draft`, visibly thinner, with no `output_fields`. So the
8-person-week marginal cost for platform two assumes access to a PAN-OS firewall that does
not currently exist in the project. Without it, the marginal cost is lower and the marginal
*value* is much lower — a corpus of draft entries with no observed output.

### 4.4 The term nobody budgets: rot

Authoring is a one-time cost per subject. Re-verification is a standing one, and it grows with
the size of the thing already written. This is the arithmetic that decides whether the project
is alive in year four.

**The model.** From `15` §13.1, the corpus splits into a fast half that rots with vendor
releases (`line`, `command`, `output`, `error`, `block`, `value`, `absence`, `step` — about
55% of explainers, plus all command entries and the whole statement dictionary) and a slow
half that rots with RFCs, physics, and our own schedule.

| Input | Value | Confidence |
|---|---|---|
| Fast-half half-life | 3 years (`15` §13.1 gives 2–4) | Judgement, self-flagged as such in `15` |
| ⇒ fraction of fast artefacts needing an edit per year | `1 − 0.5^(1/3)` = **20.6%** | Arithmetic on the above |
| Re-verification cost, blended across dictionary / command / explainer | 10 min | Assumption <!-- VERIFY: measure separately for dictionary entries (likely 5–8 min, mechanical), command entries (likely 12–20 min, needs a box), and explainer prose (likely 15–25 min). The blended figure is the least reliable input in this section. --> |
| Triage cost — deciding *which* artefacts a release touched | 1 min per fast artefact per year | Assumption. This is the cost that has no floor without tooling |
| Vendor majors per platform per year | ~2–3 | <!-- VERIFY: get the real Junos, PAN-OS and IOS-XE major-release cadences from vendor release calendars and put them in `corpus/platforms/*/releases.yaml`, which `15` §13.3 already requires and already marks VERIFY. The rot arithmetic below is only as good as this number. --> |

**At 3 platforms × 3 domains:**

| Term | Count | Hours/year |
|---|---|---|
| Fast explainers | 0.55 × ~1,700 = 935 | 935 × 0.206 × 10 min = 32 |
| Command entries (all fast) | 3 × 3 × 120 = 1,080 | 1,080 × 0.206 × 10 min = 37 |
| Statement dictionary (all fast) | 3 × 3 × 250 = 2,250 | 2,250 × 0.206 × 10 min = 77 |
| Triage across all fast artefacts | 4,265 | 4,265 × 1 min = 71 |
| Conformance lab, per platform per major | 3 platforms × 2 majors | ~50 |
| **Total** | | **~270 h/year ≈ 7 person-weeks/year** |

Which scales at roughly **0.8 person-weeks per year per platform-domain unit**.

**Now the capacity side.** `71` §15.1 staffs D1 at 0.6 FTE. At 46 working weeks that is ~28
person-weeks a year, of which authoring is not all: D1 also owns the pilot relationship, gap
triage, conformance lab scheduling, rule review, and review of any external contribution.
Call it 60% on authoring: **~17 person-weeks a year of actual corpus production.**

| Year | Capacity | Maintenance | Available for growth | Units built (13 wk first, 8 wk per platform, 11 wk per domain) | Cumulative units |
|---|---|---|---|---|---|
| 1 | 17 | 0.0 | 17 | unit 1 (13) | 1 |
| 2 | 17 | 0.8 | 16.2 | platform 2 (8) + start platform 3 | ~2 |
| 3 | 17 | 1.6 | 15.4 | platform 3 (8) + start domain 2 | ~3 |
| 4 | 17 | 2.4 | 14.6 | domain 2 on platform 1 (11) | ~4 |

**At the staffing this project plans for, three to four platform-domain units by year three,
and nine is not reachable in any year.** Maintenance does not become the binding constraint
until roughly year eight; **the binding constraint is that authoring is slow, not that
maintenance is heavy.** That is a different conclusion from the one `71` §12.9 anticipates
("corpus rot outruns corpus authoring") and it changes what you do about it: rot is not the
enemy at this scale, *scope is*.

The corollary matters more than the table: **the roadmap's v2 target of three platforms × three
domains is not a plan, it is an aspiration, and it should be re-cut before phase 1 rather
than discovered in phase 7.**

### 4.5 Mitigation 1 — narrow the scope, deliberately, in writing

The cheapest mitigation and the one nobody likes.

`15` §13.6 point 4 already states the principle: *"Cut scope on platforms, never on depth. If
capacity halves, ship one platform at full Teaching depth rather than three at Explained. A
tool that teaches Junos properly is a product; a tool that half-teaches three platforms is
vendor documentation with better search."*

The arithmetic in §4.4 turns that from a preference into a schedule. Four units is the
realistic three-year envelope. Four units can be spent as:

| Shape | Units | What it is | What it gives up |
|---|---|---|---|
| 1 platform × 4 domains | 4 | "The SRX tool." IPsec, zones/policy, interfaces/HA, routing | The cross-vendor vocabulary gap, which brief §2.1 says is the worst part of the problem |
| 2 platforms × 2 domains | 4 | The multi-vendor premise, tested on both axes | Depth. Two domains is thin for either platform |
| 4 platforms × 1 domain | 4 | Rosetta at full width for IPsec only | Any claim to model an estate. But it makes the *finder* — the wedge — genuinely cross-vendor, which is the feature people open ten times a day |

**RECOMMENDATION — 1 platform × 4 domains for the modelling product, and 4 platforms × 1
domain for the finder corpus, treated as separate content programmes with separate budgets.**
This is not a compromise between the rows; it follows from the fact that the finder needs
command entries and concepts only (~1,400 minutes per platform, not 510 hours), while the
walkthrough needs the full stack. The finder's marginal platform is cheap. The graph's is not.
They should not be scheduled together, and today they are.

### 4.6 Mitigation 2 — community contribution with review

`15` §13.5 already rejects the naive form and gives the two structural reasons: the review
gate does not scale with contributions, and the voice is the product. Both are correct. The
arithmetic underneath them is worth making explicit, because "we'll open it up" is the
mitigation everyone reaches for first.

**The review gate is the bottleneck, and it is a hard one.** A Tier A entry costs 25 minutes
to author, 7 to technically review, 3 to voice-review (`15` §12.6). Community contribution
removes the 25 and keeps the 10 — but only if the contribution is good. A contribution that
needs rework costs the reviewer more than authoring would have, because they must read it,
diagnose it, write the feedback, and read it again. Assume half of external contributions
land within one round:

| Scenario | Reviewer minutes per shipped entry | Effective multiplier on reviewer capacity |
|---|---|---|
| Authored in-house | 35 (author + review, same person or two) | 1.0× |
| External, lands first time | 10 | 3.5× |
| External, needs one round | 10 + 12 (feedback) + 10 = 32 | 1.1× |
| External, needs two rounds or is abandoned | ~45, output 0 | **negative** |
| Blended at 50 / 35 / 15 | ~27 | ~1.3× |

**A 1.3× multiplier is not nothing and it is not the answer either.** It does not change the
shape of §4.4's table. And it comes with a cost `15` §13.5 names and that deserves emphasis:
the queue is *visible* to contributors, and a visible queue that moves slowly is worse for a
project's reputation than no contribution channel at all.

What actually works, per `15` §13.5, and why:

| Mechanism | Reviewer cost | Value | Why it fits |
|---|---|---|---|
| **Gap reports** | ~0 | Highest signal in the system | It tells you which of the 430 to write next. Costs the user nothing and the reviewer nothing |
| **`misdiagnosed_as` contributions** | ~90 seconds | High | The one field where a stranger's experience beats the maintainer's, and it is one sentence |
| **Correction reports against a specific claim** | routes to re-verification, not review | High | "This is wrong on 24.2, here is the output" is a bug report against a fact |
| **Full entries from a small named set of practitioners** | 10–32 min | Medium | Works only because the set is small enough to develop shared voice |

**The one addition this document makes.** The `misdiagnosed_as` and correction channels
attack the *rot* term in §4.4, not the authoring term — a correction report is exactly the
triage that costs 1 minute per fast artefact per year, done by somebody else, for free, and
targeted at the artefacts people actually read. At 3×3 the triage term is 71 of 270 hours a
year. **Community correction is not a way to write the corpus. It is the only credible way to
keep it current, and it should be built and promoted as a maintenance mechanism rather than
as a contribution mechanism.** That reframing is free and it changes what gets built: a
one-click "this is wrong on my box" affordance on every entry, producing a file the user reads
and chooses to send (invariant 1 forbids anything automatic), beats a `CONTRIBUTING.md`.

### 4.7 Mitigation 3 — AI-assisted authoring with human gates

The tempting one, and the one with the sharpest downside.

**What invariant 10 permits.** *"The corpus is human-authored and reviewed. No model output
ships in the corpus without a named human reviewer recorded in the entry's `reviewed_by`."*
So drafting is permitted. `15` §14.2 is more specific about where a model earns its place —
build-time synonym expansion shipped as reviewed data, and selection among already-retrieved
entries — and `71` §13.2 defers automatic generation from vendor documentation with the
trigger *"a measured demonstration that review-only is materially faster than
author-plus-review."*

**The honest saving.** The fantasy is that drafting is free and the corpus cost collapses.
The arithmetic says otherwise:

| Step | Human-authored | Model-drafted, human-gated |
|---|---|---|
| Draft the three depths and two counterfactual fields | 25 min | 0 |
| Edit the draft to the voice in `.context/design-language.md` | — | 12 min (assumption; editing to a specific voice is frequently slower than writing) |
| Technical review | 7 min | 7 min |
| Voice review, batched | 3 min | 3 min |
| **Per entry** | **35 min** | **22 min** |
| **Saving on explainers** | | **37%** |
| **Saving on the unit's ~510 hours** | | **~18%**, because the conformance lab, `output_fields` from real output, and `misdiagnosed_as` do not compress at all |

**12–15 person-weeks becomes 10–12.** That is a real saving. It is not a category change, and
budgeting it as one is how this mitigation causes harm.

**The specific risk, which is that the mitigation destroys the thing it was accelerating.**
`.context/design-language.md` says it directly about the voice:

> *"It is achievable by a human writing YAML. It is not reliably achievable by a language
> model improvising."*

The failure is not that a model writes something false — technical review catches most of
that. The failure is that a model writes something **true, fluent, and generic**, and the
reviewer, under time pressure, approves it because there is nothing wrong with it. The card's
voice is defined by what it refuses to do: it states the failure mode instead of the feature,
names the misdiagnosis it prevents, and ends on a rule of thumb rather than a summary. Those
are *omissions and specificities* that a reviewer does not notice the absence of. Over two
hundred entries the corpus converges on competent vendor documentation, which is precisely
what brief §2.3 says already exists and does not help.

**The discipline that prevents it, and it must be measured rather than intended:**

| # | Control | Mechanism |
|---|---|---|
| G1 | The 50-entry reference set (`15` §12.5 P0) is the acceptance standard, not the style guide prose | It exists already and is the only artefact that transmits voice |
| G2 | **A sampled voice audit, published.** Each release, a second reviewer grades 20 random entries against the reference set, pass/fail, and the pass rate ships in the release notes | New. Costs ~2 hours per release |
| G3 | The audit is stratified by origin: human-authored vs model-drafted. If model-drafted entries pass at a materially lower rate, the mitigation is withdrawn | New. The only way to know |
| G4 | `misdiagnosed_as` and `breaks_if_wrong` may not be model-drafted at all | These require having seen the failure. A model produces plausible ones, which is worse than none |
| G5 | The `reviewed_by` name is the person who would be named in a post-incident review | Invariant 10 with the social consequence made explicit |

**G3 is the whole mitigation.** Without it, "AI-assisted authoring with human gates" is a
claim about a process rather than a measured property, and the gate erodes silently. `71`
§13.2's deferral trigger — *a measured demonstration* — is the right posture and G2/G3 are
what "measured" means.

### 4.8 Mitigation 4 — be deliberately narrow forever

The option the assignment asks to be considered honestly, and it is stronger than it sounds.

A product that covers `junos-srx` across four domains, at full Teaching depth, verified on
real hardware, kept current within one vendor major, is:

- inside the four-unit envelope §4.4 computes;
- sustainable at 0.6 FTE D1, with maintenance at ~3 person-weeks a year;
- the only thing in the landscape table of brief §3.5 that teaches;
- and honest, because the alternative is a wide corpus with a visible draft fraction.

What it gives up: the Rosetta feature, which is one of the four query shapes in brief §6.1 and
is the direct answer to the cross-vendor half of the vocabulary gap. That is a real loss and
it is the reason not to take this option lightly.

The mitigation to the mitigation is §4.5's split: **the finder's corpus can be wide while the
graph's is narrow.** A command entry with `rosetta:` mappings costs 30–45 minutes and needs no
schema, no dictionary, no rules and no emitter. Four platforms of IPsec command corpus is
about 8 person-weeks total — one unit's worth — and it delivers the cross-vendor lookup that
brief §2.1 opens with. The expensive thing is not breadth. The expensive thing is breadth *of
the modelling stack*.

**RECOMMENDATION — decide, before phase 1, whether the product is "one platform modelled, four
platforms looked up" or "three platforms modelled".** The first is reachable. The second is
not, at this staffing, and every schedule in `71` that assumes it is optimistic by a factor of
two on the content track.

### 4.9 Assessment

| | |
|---|---|
| **Likelihood** | **Near-certain** in some degree. The question is not whether the corpus falls short of the plan; §4.4 shows the plan is out of reach at planned staffing. The question is whether it falls short *deliberately and visibly* or *silently* |
| **Impact** | **Fatal** in the silent form. `15` §13 already identifies the worst state precisely: *"every entry is 90% right — which is the worst possible state, because 90% right is indistinguishable from right until it costs somebody an outage"* |
| **Leading indicators** | (a) D1 authoring hours per month vs maintenance hours per month, plotted, monthly. (b) The gap between `coverage` and `teaching_coverage` (`15` §12.3) — *"the most honest single number about this project's third pillar."* (c) Draft fraction of the command corpus. (d) `Aging`+`Stale` share per platform. (e) G2's voice-audit pass rate, stratified by origin. (f) Waivers open past their expiry (`15` §12.4) |
| **Mitigation** | Narrow scope deliberately (§4.5) and split the finder corpus from the graph corpus; community *correction* rather than community *contribution* (§4.6); model-drafted, human-gated authoring with a published stratified voice audit (§4.7); publish coverage and staleness in the product (`15` §13.6 point 1); the Tier A coverage gate that can veto a feature (`15` §12.4, X1.3) |
| **Residual** | Every mitigation above buys 20–40%. None of them changes the shape. **The residual is that this product needs one committed domain expert writing for years, and no engineering decision substitutes for that.** `71` §15.1 already says D1 is the scarcest and least substitutable resource; this section is the arithmetic proving it. If D1 is 0.2 FTE rather than 0.6, the three-year envelope is one unit, and the correct product is a Junos SRX IPsec tool that is very good and says so |
| **Kill condition** | `71` §12.1 (authoring median > 60 min) and `71` §12.9 (rot outruns authoring). §4.4 adds a third: **if two consecutive quarters produce no net new subjects at Tier A coverage, the scope is wrong, not the effort** |

---

## 5. §11.3 — Version drift

*margin tab: worse than no rule*

> **A RULE CORRECT ON JUNOS 21 AND WRONG ON JUNOS 23 IS WORSE THAN NO RULE — THE BRIEF SAYS SO**

### 5.1 Four classes of drift, and the loud ones are the cheap ones

The brief treats version drift as a property of syntax. It is four different problems with
very different detection stories, and the ordering is counter-intuitive: **the drift that
breaks loudly costs almost nothing, and the drift that changes nothing visible costs the
most.**

| Class | Example | Detected by | Cost when missed |
|---|---|---|---|
| **Syntax rename** — a statement path changes | any `set security …` path moving | Parse residue spike on real configs; emitter golden fixtures; and ultimately *the box rejects the commit* | Loud, immediate, cheap. The user knows within seconds |
| **Default change** — the value a platform assumes when a statement is absent | Card side 2: *"P1 28800, P2 3600. Both default to 3600"*; DPD *"Junos defaults to 10 × 5 = 50 s"* | **Nothing automatic** | Silent and structural. `11` §5.3 makes `Presence::Default(v)` *a claim about a platform version that must be sourced*. A changed default means the graph itself now holds a false value, not merely a false sentence |
| **Semantic change** — same syntax, different meaning | Card side 2: *"`mode` is silently ignored under `v2-only`"* — a fact that is true of a version range | **Nothing automatic** | Silent. A rule fires or fails to fire wrongly, and `acceptable_when` does not save it because the rule is not wrong-in-principle, it is wrong-here |
| **Behaviour change** — same syntax, same semantics, different operational behaviour | Card side 2 on rekey: *"Soft is hard minus a random jitter — which is why rekeys drift and never land on the same second twice"* | **Nothing** | Silent, and it lands in the teaching text, which is the material the product's third pillar rests on |

The `Presence::Default(v)` row is the sharpest finding in this section and it is specific to
Fathom's design. Most tools that get a default wrong produce a wrong sentence. Fathom's
schema deliberately treats a default as a *modelled, sourced claim about a platform version*,
which is the right decision (`11` §5.3) and which means a stale default is a wrong value in
the graph that rules read, emitters consider, and explainers describe. It propagates.

### 5.2 The version predicate is only as good as the release calendar

`5.2` of the brief makes version predicates mandatory. `63` and `12` implement them. The
weakness is upstream of both: a `versions:` predicate is evaluated against a release calendar
that, per invariant 1, **cannot be fetched** — the build has no network. `15` §13.3 makes it
data in the repository, updated by a human in a pull request, and then does the only thing
that works:

| Check | Level |
|---|---|
| Newest known release > 9 months older than the build date | Warning — "the calendar has probably not been updated" |
| Newest known release > 15 months older than the build date | **Build failure** — staleness computation is no longer meaningful and must not be presented as if it were |

The 15-month build failure is the single most important maintenance control in the project,
because it converts "we stopped maintaining this" from a silent condition into something a
human has to act on. It is also the control most likely to be defeated by the person who
encounters it at 23:00 before a release. **RECOMMENDATION — the 15-month failure may be
waived only by a dated entry in the same waiver file as `15` §12.4's coverage waivers, with an
owner and an expiry, and the waiver is listed in the release notes.** A control that can be
silenced with a one-line commit is not a control.

### 5.3 What the card already tells us about version sensitivity

The field card is a useful calibration instrument here because it was written by an expert
who was careful about this, and it still carries claims that are version-bound:

| Card claim | Version sensitivity | Class |
|---|---|---|
| *"`proposal-set standard` … still leads with DH group 2"* | The contents of a named proposal set are a platform decision that can change | Semantic |
| *"Junos defaults to 10 × 5 = 50 s of blackhole"* | A default | Default |
| *"`mode` is silently ignored under `v2-only`"* | Behaviour under a version selector | Semantic |
| *"Under IKEv2 the first child SA is always keyed from the IKE SA regardless"* | Protocol, RFC 7296 | Slow half — decades |
| *"GCM is AEAD, so there is no separate `authentication-algorithm`"* | Cryptographic construction | Slow half — decades |
| *"`tcp-mss ipsec-vpn` clamps only tunnel traffic"* | Statement semantics | Semantic |
| The MTU overhead table, marked *"OVERHEAD FIGURES APPROXIMATE — CIPHER-DEPENDENT"* | Already self-hedged by the author | The right pattern |

That last row is the model. **The card's own governing device — one all-caps line per side
that states the limit of what the side claims — is the correct response to version
uncertainty**, and it should be a first-class corpus field rather than prose. `15` §13.2's
`Staleness` enum and its margin tab (`unverified since 21.4`) is that mechanism, and the
design language's margin tab is the right rendering for it: lowercase, unpunctuated, almost
apologetic, telling you how to weight the section without taking a heading.

### 5.4 When you cannot keep up — and you cannot

`15` §13.4 already specifies the triage ladder and its four tiers, ending in the brutal one:
the Tier A coverage gate forces a choice between writing the entry and **not shipping the
emitter statement, rule or command that it explains.** That is the teaching pillar acting as a
constraint on what ships, which is what the brief asked for.

Two rules govern the whole thing and both are in `15` §13.2:

> **Missing beats wrong.** A `Stale` entry loses its spine position automatically. When a
> maintainer is unsure whether an entry is still true, the correct action is `status:
> withdrawn` and a gap, not an edit that guesses.

> **Staleness is always visible.** Never hidden, never rounded away.

And `15` §13.6 point 5 is the promise-keeping one, which is unpopular and correct: if Teaching
coverage falls below 50% of Tier A for two consecutive releases, drop the teaching claim from
the product description until it recovers.

**What this document adds is the version-predicate default.** A rule authored against one
observed platform version should not claim `versions: "*"`. The card's own hedging discipline
suggests the safer authoring rule:

**RECOMMENDATION — `versions:` defaults to the closed range the author actually verified, and
widening it is an explicit act with a source.** The cost is that a rule stops firing on a
release nobody has checked, which looks like a coverage regression and is in fact an honest
one. The alternative is a rule that fires confidently on a release nobody has checked, which
is the thing brief §5.2 says is worse than no rule.

### 5.5 Assessment

| | |
|---|---|
| **Likelihood** | **Near-certain.** Vendors ship majors on their own calendar and the corpus is verified against a snapshot |
| **Impact** | **Expensive.** Not fatal on its own — it becomes fatal only through §4, when re-verification consumes the capacity that would have grown coverage |
| **Leading indicators** | (a) `Aging` + `Stale` share per platform, published in-product (`15` §13.6 point 1). (b) The 9-month and 15-month calendar checks (`15` §13.3). (c) Correction reports per release — a *rising* count is health, a falling count with rising staleness is abandonment. (d) Rules carrying `versions: "*"` as a share of the pack |
| **Mitigation** | Version predicates on every rule (brief §5.2); the fast/slow corpus split versioned independently so the resolution ladder degrades gracefully (`15` §13.1); `Staleness` computed from data, never hand-set; withdraw before you guess; the 15-month build failure, now waivable only with an owner and an expiry (§5.2); closed-range `versions:` by default (§5.4) |
| **Residual** | **Default changes and silent semantic changes have no automatic detector and never will**, because detecting them requires running the platform. The conformance lab is the only instrument and it costs 30–50 hours per platform per pass (§4.2). The residual is therefore proportional to how many platforms you support divided by how many you can put hands on — which is another argument for §4.5's narrow scope, arrived at from a completely different direction |

---

## 6. Correctness liability

*margin tab: someone pastes this into a firewall*

> **THE TOOL PRODUCES TEXT. A HUMAN DECIDES AND PASTES. THAT IS THE BOUNDARY AND IT IS NOT A DISCLAIMER**

### 6.1 The failure, concretely

Invariant 2 means Fathom never touches a device: all output is copy-paste. That removes an
entire class of risk and it does not remove this one. The realistic story is small.

An engineer builds an MTU fix through the walkthrough. The emitter produces
`set security flow tcp-mss all-tcp mss 1350` where the graph meant `tcp-mss ipsec-vpn`,
because a field moved between kinds in a refactor and the statement table was updated for one
path and not the other. The card names the consequence exactly: *"`all-tcp` hits everything
through the box, a far bigger blast radius than most people intend."* The line is
`ChangesConfig`, not `Disruptive`, because clamping MSS does not drop traffic — it degrades a
class of it, on a firewall carrying everything, in a way that presents as an application
problem days later. `commit confirmed 5` does not save the user, because the change looked
fine at minute five.

That is the shape of the real incident: **not a dramatic outage, but a plausible line that is
wrong in a way the verification ladder does not test.** A wrong line that drops the tunnel is
caught in step 2 of the bring-up order. A wrong line that works is not caught at all.

The second shape is worse and it is specific to this product: a rollback that is not an
inverse. `71` §12.4 already names it — *"a rollback that is sometimes wrong is worse than no
rollback, because people will paste it during an outage."*

### 6.2 Technical mitigations, and what each actually catches

| Mitigation | Where | Catches | Does not catch |
|---|---|---|---|
| **The card as an external oracle** (X1.1) — emitter reproduces sides 1 and 2 byte for byte from a graph built through the walkthrough | `71` §4.4 | Divergence from an expert's own text, written before the tool existed | Anything the card does not cover |
| **Round-trip law** (X2.1) — `parse(emit(g)) ≅ g`, property-tested | `71` §5.5 | Emitters that produce config meaning something other than the graph | Config that round-trips and is still operationally wrong |
| **Rollback is an inverse** (X3.1) — property-tested over the golden change set | `71` §6.4 | The `all-tcp` class of asymmetry, if the fixture exists | Changes outside the fixture set |
| **Provenance on 100% of lines** (X1.2, invariant 6) | `13` | Lines nobody can explain — which is the reliable smell of a line nobody checked | A line with correct provenance and wrong content |
| **≥2 fixtures per rule, one firing and one passing** (X1.7) | `45` §6 | Rules that fire on everything | Rules that are right about the wrong version (§5) |
| **Determinism** (invariant 9, X1.10) | `41` §8.2 | Two engineers getting different output from the same workspace, which is how a diff review becomes worthless | A deterministically wrong answer |
| **Emit blocks rather than guesses** — `Representability::Blocked`, `Presence::Unknown` handled explicitly (`11` §9.4, `13` §9) | | Silent omission, which is the worst emitter failure | |
| **No credentials, ever** (invariant 3, X1.12, X2.7) | | The highest-consequence class of leak by removing the data | |

The pattern across that table: **every technical control catches a category of wrongness and
none of them catches "plausible and wrong."** That is not a gap that more testing closes. It
is why the next section exists.

### 6.3 Interface mitigations — the ones that assume we are wrong

These are the controls designed on the assumption that the output is incorrect.

**The risk enum.** Exactly three values, on every line, every command, every ladder step,
identical to the printed card's legend, which appears unchanged on all four sides. Its job is
not decoration; it is that a reader who does not read anything else reads the colour. `51` and
the conventions forbid a fourth value and forbid reusing the colours for anything else — a
discipline that exists so the signal never dilutes.

**`commit confirmed 5` as step 1 of every ladder.** The card puts it first in the bring-up
order — *"always, remotely"* — and `71` §6.3's change ticket reproduces it. It is the single
most valuable line the product emits, because it makes a wrong emitted line self-reverting
for the class of errors that break connectivity immediately.

**And here is the honest limit, which is a platform fact rather than a design choice.**

| Platform | Confirmed-commit brake | Form |
|---|---|---|
| `junos-srx` | Yes, first-class | `commit confirmed <minutes>`, per the card |
| `ios-xe` | Yes | Configuration Rollback Confirmed Change: `configure terminal revert timer <minutes>`, then `configure confirm` within the window or the running configuration is automatically restored ([Cisco IOS XE 17.x system management guide](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/syst-mgmt/b-system-management/m_cm-config-rollback-confirmed-change.html)) |
| `panos` | **Not in the same form.** Candidate/running configuration with commit versions and manual revert; the automatic mechanisms — commit recovery on loss of Panorama connectivity — are scoped to Panorama-managed connectivity rather than being a general per-commit timer ([Palo Alto Networks, *Revert Firewall Configuration Changes*](https://docs.paloaltonetworks.com/ngfw/administration/firewall-administration/manage-configuration-backups/revert-firewall-configuration-changes)) <!-- VERIFY: confirm against current PAN-OS whether any general per-commit auto-revert timer exists on a standalone firewall, independent of Panorama. If one does, the ladder should use it. --> |

**This matters more than it looks.** The verification ladder's first step is a safety control,
and it is not portable. When the second platform lands, either the ladder's step 1 changes
per platform — which it must, since ladders are selected from the corpus and never synthesised
(X3.3) — or the product silently offers a weaker brake on one platform than another. The
correct behaviour is the card's own: **state the limit in the imperative line.** A PAN-OS
change ticket should say, at the top, in caps, that there is no timed auto-revert and that the
rollback block must be staged before the change block is pasted.

**The verification ladder as a graph, not a list.** Every step carries `read_field` (what to
look at) and `next_if_bad` (where to go). The card's own ordering instruction — *"Stop at the
first failure"* — plus its diagnostic split — *"Steps 5–8 failing while 2–4 are clean is
plumbing, not crypto"* — is what turns a wrong output into a caught wrong output.

**The rollback asymmetry, stated.** `71` §6.3's worked example has the change as
`ChangesConfig` and the rollback as `Disruptive`, because adding PFS takes effect at the next
Phase 2 rekey while removing it forces one. A generic runbook gets that backwards. Rendering
it correctly is a small feature that is worth an unreasonable amount of care, because it is
the moment the user is most likely to paste without reading.

**Placeholders.** `pre-shared-key ascii-text "<PSK>"` means the most dangerous line in the
output cannot be pasted without a human editing it. That is a correctness control disguised as
a security control.

### 6.4 The licensing and warranty position

**What the licence does.** The dependency licence allowlist in `35` §5.5 is Apache-2.0, MIT,
BSD-2/3-Clause, ISC, Unicode-3.0, Zlib and CC0-1.0, and copyleft is denied because A1 is a
single file that inlines everything. Whichever permissive licence the project itself takes,
Apache-2.0 §7 (*Disclaimer of Warranty*) and §8 (*Limitation of Liability*) — or the MIT
"AS IS" paragraph — disclaim warranties and limit liability between the licensor and the
recipient of the software.

**What the licence does not do**, and this is the part that gets assumed rather than checked:

| Assumption | Reality |
|---|---|
| "The disclaimer means we cannot be liable" | It governs the contractual relationship with the recipient. It is not a defence against every regime, and consumer and product-safety regimes commonly limit what a supplier can disclaim |
| "Open source is out of scope of product regulation" | Directive (EU) 2024/2853 (the new Product Liability Directive) brings software within the definition of a product, and its own carve-out is for free and open-source software *developed or supplied outside the course of a commercial activity* — which a paid hosted sync service is not obviously outside of. Member states transpose by **9 December 2026**, and it applies to products placed on the market after that date ([EUR-Lex](https://eur-lex.europa.eu/eli/dir/2024/2853/oj/eng)) |
| "The CRA is years away" | Regulation (EU) 2024/2847 entered into force **10 December 2024**; reporting obligations apply from **11 September 2026** and the main obligations from **11 December 2027** ([European Commission](https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act)). The CRA also creates an "open-source software steward" category with lighter obligations — a security policy, cooperation with market surveillance, and vulnerability reporting — for entities supporting in-scope open-source products for commercial purposes |

`36` Q59 already marks the CRA question for counsel and carries a VERIFY. This document adds
the PLD to the same list and does not attempt to answer either.

<!-- VERIFY: get counsel on (a) whether an unmonetised open-source distribution of Fathom
     falls inside CRA scope as a manufacturer, as an open-source steward, or outside; (b)
     whether offering a paid hosted sync service changes that classification for the client
     artifact as well as for the service; (c) whether Directive (EU) 2024/2853's exclusion of
     FOSS "developed or supplied outside the course of a commercial activity" survives the
     existence of any paid offering; (d) what a support-period commitment must look like.
     Do not answer any of these from a blog post, including this one. -->

**What we will say, and it should be written once and reused.** `35` §12.6 already keeps a
list of claims the project will not make. The correctness equivalent belongs beside it:

| We will not say | Because |
|---|---|
| "Validated configuration" | The rules validated it against the corpus we shipped. That is a much narrower claim and it is the true one |
| "Production-ready output" | The output is a proposal for a human to review. Calling it ready invites not reviewing it |
| "Correct for your platform" | Correct for the platform versions in `versions:`, verified on the release in `verified_against`. Say that instead |
| "Safe to paste" | Nothing is safe to paste. That is why the risk enum is on every line |

And the affirmative statement that should appear in the product, in the README, and in the
enterprise pack, in these words or words no softer:

> **Fathom generates text. It does not configure anything.** Every line it produces is
> labelled with what it does to a running box, carries the graph node and field that produced
> it, and is accompanied by the commands to prove it worked and the commands to back it out.
> It has been checked against the corpus version shown in the footer and against the platform
> versions that corpus was verified on. It has not been checked against your box. Run
> `commit confirmed` where your platform has it, verify before you confirm, and read the
> rollback before you paste the change.

### 6.5 A tool that teaches owes more than a tool that stores

This is the asymmetry the assignment names and it is real.

NetBox stores a fact. If the fact is wrong, the user's own knowledge is the check — they read
"MTU 1500" and think "that's not right." The tool has not spent any effort making the user
believe it.

Fathom's third pillar is explicitly designed to make the user believe it. Teaching depth gives
*"analogies, background, failure modes, counterfactuals"* and the design language requires
every explainer to name the misdiagnosis it prevents. The card's voice works precisely because
it is confident and specific: *"Check identity before you re-type the PSK."* An engineer who
has read three of those and found them right is an engineer who has stopped checking the
fourth. **The teaching pillar systematically reduces the user's independent verification,
which is exactly what makes it valuable and exactly what raises the cost of being wrong.**

Three consequences that should be treated as design constraints rather than sentiments:

| # | Constraint | Mechanism that already exists |
|---|---|---|
| 1 | Confidence must be visibly bounded | `Staleness` margin tabs; `verified_against`; the draft fraction published; the card's own one-line caps imperative per section |
| 2 | The teaching text must never be more confident than its source | `sources:` mandatory; `15` §13.2 rule 3 — *withdraw before you guess* |
| 3 | The verification ladder is not optional UI | It is the mechanism by which a taught user re-acquires the check that being taught removed. It should never be collapsed behind a disclosure control |

Constraint 3 is the one that will get argued about, because a ladder is long and a designer
will want to fold it. Do not fold it.

### 6.6 Assessment

| | |
|---|---|
| **Likelihood** | **Unlikely** per change, given X1.1, X2.1, X3.1 and 100% provenance. **Near-certain** across the life of the product, because the denominator is every change every user ever pastes |
| **Impact** | **Expensive**, and asymmetric: the operational cost of one bad line is usually hours, and the reputational cost is the whole security-and-correctness position, which is the market position (brief §2.4) |
| **Leading indicators** | (a) Provenance coverage below 100% or an exception list being proposed — `71` §12.2 already makes this a stop. (b) Any golden fixture diff signed off without a written reason. (c) Rollback fixtures growing slower than change fixtures. (d) Correction reports about *emitted config* rather than about corpus prose — a different and much more serious class |
| **Mitigation** | §6.2's technical table, §6.3's interface table, §6.4's language discipline. The strongest single control is `commit confirmed` as ladder step 1, and it is not portable across platforms |
| **Residual** | Three, all irreducible. **(1)** No control catches "plausible and wrong"; the adversarial red-team subagent (`21` §5.2.4) catches the mechanical subclass and misses the shared-world-model subclass, and `21` says so. **(2)** The confirmed-commit brake does not exist in the same form on every platform, so the safety floor is platform-dependent and must be stated per platform rather than assumed. **(3)** The teaching pillar reduces user verification by design. There is no version of this product that both teaches well and leaves the user as sceptical as they started |

---

## 7. Adoption, and whether the wedge converts

*margin tab: zero setup, then what*

> **THE FINDER DOES NOT CONVERT ANYBODY. IT KEEPS YOU INSTALLED UNTIL THE RARE OCCASION ARRIVES**

### 7.1 The cliff, measured in what each step asks of the user

The wedge strategy is right and `71` builds the whole plan on it. The question the assignment
asks is whether the on-ramp genuinely leads anywhere. The way to see it is to write down what
each rung asks, because adoption failures are almost always a step-change in *ask*, not a
step-change in value.

| Rung | Feature | Asks the user for | Trust required | Occasion frequency |
|---|---|---|---|---|
| 1 | Command finder | A download. Nothing else — no account, no data, no passphrase, no network | **None.** It is read-only reference content and it works offline | Ten times a day (brief §6.1) |
| 2 | Reverse explanation — paste an inherited config, get an annotated walkthrough | **A production configuration, pasted into a tool** | **Large.** This is the single biggest trust step in the product | Whenever you inherit something you did not write — which brief §6.3 says is *"eventually everyone"* |
| 3 | Guided walkthrough — build one change | A design decision, a passphrase, and enough trust to paste the output at a firewall | Large, and of a different kind: trust in correctness rather than in confidentiality | A handful of times a year, per engineer |
| 4 | Inventory / model the estate | Repeated, disciplined data entry over time | Institutional, not personal | Continuous, and it is a habit rather than an occasion |

**The cliff is not between 1 and 4. It is between 1 and 2**, and it is a trust cliff, not an
effort cliff. Rung 2 costs the user almost no work; it costs them the decision to paste a
configuration into something. Brief §2.4 says engineers *"routinely paste them into web tools
with no defined data handling"*, which cuts both ways: the behaviour exists, so the barrier is
not absolute — but the tool that wants to be the trustworthy one has to earn what the careless
ones get for free.

### 7.2 The frequency problem, which is the real answer

Here is the thing the wedge argument does not address. The finder is used ten times a day. The
walkthrough is used when you build a tunnel. Most network engineers build a new site-to-site
IPsec tunnel a handful of times a year.

**So even a user who is completely converted in disposition converts in behaviour only when a
rare occasion arrives.** The conversion event is not something the product can cause; it is
something the product can only be present for.

That reframes what "does the wedge convert" means, and it changes the design implications:

| Naive reading | What §7.2 implies instead |
|---|---|
| The finder should nudge users toward the walkthrough | The finder should be *good*, and the link into the walkthrough should exist and never nag. A nag at rung 1 spends the trust that rung 2 needs |
| Measure conversion rate | Measure *presence at the occasion*: is the artifact still on the engineer's disk, still current, still one keystroke away, six months later |
| Optimise the funnel | There is no funnel; there is a waiting game. Optimise for zero cost of waiting — which means no account, no expiry, no update nag, no network requirement |

Every one of the right-hand behaviours is something the architecture already gives for free.
The single-file offline artifact with `connect-src 'none'` is not only a security posture; it
is the correct *adoption* posture for a product whose conversion event is rare. That is a
genuinely fortunate alignment and it is worth naming, because it means the security decision
does not have an adoption cost here — it has an adoption benefit.

### 7.3 The rung that is missing from the narrative

`71` builds reverse explanation in phase 2 and files it under "paste and inventory". That is
right for the engineering dependency graph and wrong for the adoption story.

Reverse explanation — paste an inherited configuration, get an annotated walkthrough at three
depths — is:

- zero data entry;
- immediately valuable to the largest possible audience, because everyone eventually inherits
  equipment and documentation they did not write (brief §6.3);
- frequent, unlike rung 3;
- and it produces a populated graph as a *side effect*, which is precisely brief §6.3's
  "never an empty form."

**RECOMMENDATION — position reverse explanation as rung 2 of the product narrative, ahead of
both the walkthrough and the inventory.** No roadmap change: it is already phase 2. The change
is to how the product is described and demoed, and to what the finder links to. A finder result
that links to *"here is what this looks like in a real config"* is a smaller step than one that
links to *"build this properly."*

### 7.4 Leading indicators, with no telemetry

`71` §3.7 already says the uncomfortable part: there is no funnel, no DAU, no retention curve,
and there never will be. What remains, in descending order of usefulness, plus what this
section adds:

| Instrument | Tells you | Cannot tell you |
|---|---|---|
| A named pilot group of 8–12, at least 3 outside the project, **asked** rather than measured | Whether they open the finder unprompted in week 3 (`71` §12.1's kill point) | Anything about people who tried it once |
| **Whether any pilot engineer has ever opened a workspace twice** | Whether rung 2 or 3 was crossed at all. This is the conversion question, and it is a yes/no per person, not a rate | Why not |
| The local miss log, exported by explicit user action (`16` §3.6) | The queries the corpus could not answer, in the user's own words | How many people had the miss and did not export |
| Gap-file rate | Whether people care enough to file. A silent tool with no gap files is either perfect or unused, and it is not perfect | Which |
| **Correction reports about emitted config** | That somebody pasted something. It is the only unambiguous evidence rung 3 was crossed | Frequency |
| Corpus contribution from outside | The strongest signal available | Nothing about read-only users |

**RECOMMENDATION — write down, before phase 1 starts, the number of pilot engineers who must
have opened a workspace twice in a quarter for phase 2 to be worth starting.** `71` §3.7 makes
the same recommendation about the finder and is right; the same discipline applied one rung up
is what tests the wedge thesis rather than the finder.

### 7.5 Assessment

| | |
|---|---|
| **Likelihood** | **Likely** that the finder is adopted and rung 3 is not, within the first two years, for the frequency reason in §7.2 rather than for any failure of the walkthrough |
| **Impact** | **Expensive** rather than fatal. `71` §12.1 already treats "ship phase 0 and stop" as a coherent outcome, and it is: a fast, offline, deterministic, risk-labelled, cross-vendor command finder with explanations is a real product that nothing else in the landscape table is |
| **Leading indicators** | §7.4's table, and specifically the workspace-opened-twice count |
| **Mitigation** | Reverse explanation as rung 2 in the narrative (§7.3); never nag from rung 1; zero cost of waiting — no account, no expiry, no update requirement; make the change ticket legible to change management (X3.7), because a tool whose output must be retyped into a ticket is a tool used for learning and not for work |
| **Residual** | **The conversion event is rare and cannot be manufactured.** The honest position is that the product's payoff is measured in years and its instrumentation is a handful of conversations. If that is unacceptable, the answer is not better analytics — invariant 1 forecloses those permanently — it is to accept a smaller product |

---

## 8. The zero-knowledge cost

*margin tab: what it buys, and what it costs*

> **THESE ARE NOT RISKS. THEY ARE PRICES, AND THEY ARE PAID EVERY DAY**

The security posture is not a risk to be managed; it is a set of accepted, permanent costs.
They belong in an honest assessment because they are usually discussed only as benefits, and
because several of them show up disguised as other problems later.

### 8.1 The enumeration

| # | What is given up | Consequence | What is done instead | What the substitute cannot do |
|---|---|---|---|---|
| 1 | **Server-side search** | The whole corpus index must fit in the download. This is why `44`'s B17/B18 size budgets exist | Deterministic, compact index built at compile time; virtualised rendering; corpus split so unused slices are not shipped | It puts a **hard ceiling on corpus size that is set by download size, not by authoring capacity** — §8.2 |
| 2 | **Analytics, funnels, retention** | No adoption measurement, ever (`71` §3.7) | A named pilot group, asked directly | Anything about the people who left |
| 3 | **Crash and error reporting** | A defect affecting 5% of users is invisible until one of them writes to you | Determinism, so a reported symptom reproduces exactly from workspace + corpus version + build; a locally-generated diagnostic bundle the user reads before choosing to send | Finding the defect nobody reports |
| 4 | **Support reproduction** | Even if the user mails their workspace, the server operator cannot read it and neither can we | See §8.3 | Nothing removes the fact that we cannot see the data |
| 5 | **Session replay / "show me what you did"** | Cannot debug an interaction problem | Deterministic ranking, published golden query set, the miss log | Interaction issues that do not appear in the miss log |
| 6 | **Roadmap signal from usage** | You build what the loudest pilot asks for | Gap files, corpus contribution, reachability-weighted coverage (`15` §12.3) as a static proxy for what people will click | Distinguishing "nobody needs this" from "nobody found this" |
| 7 | **Cohort feature flags and staged rollout** | Every release ships to everyone at once | The pilot group runs pre-release builds; `41` §8.3 forbids features that change observable behaviour behind flags anyway | Reducing blast radius of a bad release |
| 8 | **A/B testing of ranking** | The golden query set is the only ranking instrument, and it encodes the authors' expectations | Golden set reviewed as a review item, never a build failure (`16` §9.6); miss log | Escaping the circularity: we measure agreement with ourselves |
| 9 | **Licence telemetry / usage-based pricing** | The commercial model is constrained to support, hosting D3, and paid content | — | See §10.4 — this is a burnout risk wearing a business-model costume |
| 10 | **A push channel for security advisories** | **An air-gapped user on an old build cannot be told their build has a vulnerability** | Build version in the filename and UI header; published advisory feed the user must check; corpus `expires` staleness banner at build date + 400 days (`15` §13.3) | Reaching a machine that has no network. This is the worst item on the list |
| 11 | **Abuse or misuse detection** | Cannot detect the product being used in ways that indicate a defect | — | — |
| 12 | **Knowing which of the 430 entries anybody reads** | Corpus prioritisation is guesswork with a static proxy | Reachability-weighted coverage; gap files | Actual reading behaviour |

### 8.2 The coupling nobody names

Item 1 is not just an engineering constraint. **No server-side search means every entry ever
authored must fit inside the artifact the user downloads.** That connects the security posture
directly to §4: the corpus has a size ceiling set by `44`'s budgets, and that ceiling is
independent of — and may be tighter than — the ceiling set by authoring capacity.

`71` §12.1 already anticipates it: if the single-file artifact cannot be built under ~4 MB with
the index in it, the response is to ship a reduced corpus in D1 and move the index to a lazily
fetched asset in D2 — *"Both are ugly and both are survivable."* They are also a two-tier
product where the offline user, who is the user the security posture exists for, gets less
content. That is the exact opposite of the intended trade and it should be recognised now
rather than discovered at 5 MB.

**RECOMMENDATION — set the corpus size budget in entries, not in megabytes, and set it before
phase 1.** Work backwards from B17 to a maximum entry count at the measured bytes-per-entry,
publish it, and treat it as a scope constraint alongside §4.4's capacity constraint. Two
independent ceilings on corpus size, discovered at different times, is how a content programme
gets cancelled halfway.

### 8.3 The substitute for support reproduction, specified

Item 4 is the cost most likely to be met with an improvised answer under pressure, and an
improvised answer here means somebody asking a user to mail an unencrypted export.

**RECOMMENDATION — a shape export.** A user-triggered, locally-generated file containing the
graph's *structure* with all values removed: kinds, edge kinds, cardinalities, field presence
states (`Set` / `Absent` / `Unknown` / `Default`), provenance origins, rule IDs that fired,
corpus version, build hash. No names, no addresses, no interface identifiers, no free text.
The user opens it, reads it — it is short and it is legible — and chooses whether to send it.

That is enough to reproduce most defects in the rule engine, the emitter's blocking behaviour
and the finder's ranking, and it contains nothing the security posture promises to protect.
What it cannot do: reproduce anything that depends on the actual values, which includes the
whole parser residue class. For those, the honest answer to a user is *"we cannot debug this
without something we have promised not to ask you for; here is what to look at yourself"* —
and the diagnostic must therefore be legible to the user, which is a real design constraint on
the residue ledger and the emit report.

### 8.4 Assessment

| | |
|---|---|
| **Likelihood** | Not applicable. These are certainties |
| **Impact** | **Recoverable**, individually. Collectively they mean the project is flown on instruments that mostly do not exist, which compounds §7's measurement problem and §4's prioritisation problem |
| **Leading indicators** | The absence of indicators *is* the cost. The one thing to watch: any proposal to relax invariant 1 "just for errors" or "just for anonymous counts" — that is the shape this cost takes when it becomes unbearable |
| **Mitigation** | §8.1's substitute column; the shape export (§8.3); the entry-count corpus budget (§8.2) |
| **Residual** | **Item 10 is unmitigable and it is the one that should worry a security-first project the most.** A product built for air-gapped, defence and OT users cannot notify those users of a vulnerability in the thing they are running. The only honest response is to make the build's identity trivially visible, publish advisories in a form an organisation can subscribe to out-of-band, and state in the documentation that update notification is the operator's responsibility. Say it in the enterprise pack rather than waiting to be asked |

---

## 9. The AI tension

*margin tab: the credibility problem*

> **THE RISK IS NOT THAT THE MODEL IS WRONG. IT IS THAT THE LAYER MAKES THE OTHER CLAIMS UNBELIEVABLE**

### 9.1 The tension, stated

The product's two structural differentiators are determinism (invariant 9) and no egress
(invariant 1). The owner's explicit new requirement is a supervisor and subagents. `21`
reconciles them architecturally and the reconciliation is sound: the AI layer is never in the
artifact path, reproducibility is identical at every tier, and tier 0 links no model at all.

The risk is not architectural. **It is that a reviewer reads "supervisor AI and subagents" and
stops reading.** The enterprise conversation that `36` exists to win is a conversation with
people whose job is to find the hole; the AI layer hands them a heading to open with. And
tier 1 gives them a real one — `21` §8.7 says it without softening: *"A user who enables tier 1
has made a different trust decision from a user who has not… no amount of redaction makes it
true."*

The second-order risk is worse and it is about positioning rather than security. A product
described as "an AI network assistant" is evaluated against AI assistants, where it will lose
on breadth and win on nothing a demo shows. A product described as "a deterministic,
offline, client-side network engineering tool that can optionally consult a model you control"
is evaluated against the landscape table in brief §3.5, where it is the only row that teaches.
**Those are the same product and only one of them survives first contact with a buyer.**

### 9.2 The discipline that prevents it

Every control below already exists in `21` or `71` except D7 and D8. What this section adds is
the observation that they are one system and that removing any of them makes the rest
decorative.

| # | Discipline | Mechanism | Fails how |
|---|---|---|---|
| D1 | **Tier 0 is the default and the development default** | X6.4; the full acceptance suite runs against the tier-0 artifact; any feature whose acceptance test requires a model is rejected | `21` §7.1 names it: *"the moment tier 1 becomes the development default, tier 0 rots"* |
| D2 | **`fathom-ai` is not linked in the offline build** | `xtask check-deps`; symbol-table assertion on the built binary, not a `cargo metadata` check | A transitive dependency creeps in and nobody looks at the symbol table |
| D3 | **The reproducibility check** — regenerate every artifact with AI disabled and get byte-identical output | X6.1 | It gets run once at 6a and not every release |
| D4 | **A1: the default answer is "it should be a rule"** | `21` §5.3; has already killed five candidates, listed in `21` §5.4 | A reviewer who wants the feature writes a rule that cannot express it and declares victory |
| D5 | **`shadow_rule_rate` as a build gate** | `21` §3.4 | The threshold gets raised instead of the subagent narrowed |
| D6 | **The egress pre-flight shows literal bytes at every tier that sends anything** | X6.6 | It becomes a dialog people click through. Mitigated by `21` §8.5's armed-state indicator being persistent rather than modal |
| D7 | **Positioning discipline: the AI layer is never above the fold** | New. A review rule: no public screenshot, README paragraph or demo opens with model output as the primary answer. The demo opens with `Ctrl+K` | Nothing enforces it but a person. It is still worth writing down, because the first time it is broken will be for a conference |
| D8 | **The golden query set must contain `NoHit` queries** | New. See §9.3 | Without it, the one path where the supervisor is reachable is the one path the determinism test does not cover |

### 9.3 How it goes wrong anyway, specifically

The realistic failure is not a rogue subagent. It is this:

The AI layer ships. `config.triage` turns out to be genuinely good at parse residue, which is
the one place `21` §5.1 gives a subagent both the propose capability and a narrow scope.
Confidence builds. Two releases later somebody notices that the finder's `NoHit` path — the
under-determination surface — is the weakest screen in the product, because by construction it
fires exactly when the corpus has nothing. Wiring it to the supervisor makes those queries
better. It ships.

Now the finder is non-deterministic on precisely the queries that matter most — the misses —
and invariant 9 is broken for the wedge, which is the feature people open ten times a day and
the one whose results get pasted into change tickets. Nobody notices, because the golden query
set contains queries that *hit*.

The defence is one line of scope in the golden set: **every golden query set must include
queries with no correct corpus answer, whose expected result is a specific under-determination
surface**, and the CLI/WASM identity assertion (X0.5) must cover them. That is D8, it costs
almost nothing, and without it D1 and D3 both have a blind spot shaped exactly like the place
the supervisor lives.

### 9.4 Assessment

| | |
|---|---|
| **Likelihood** | **Likely** that the AI layer becomes the dominant thing people ask about, regardless of how it is built. **Unlikely** that it breaks determinism, given D1–D3, provided D8 is added |
| **Impact** | **Expensive.** Not because of what the layer does but because of what it costs to explain, in every enterprise review, forever |
| **Leading indicators** | (a) Whether tier 0 is still the development default six months after 6b. (b) `shadow_rule_rate` trending up, or its threshold being raised. (c) Any acceptance test that requires a model. (d) Any public material where model output is the first thing shown. (e) After a full release cycle, whether any pilot user can name a decision the AI layer improved — `71` §12.7 makes this a stop condition |
| **Mitigation** | D1–D8 |
| **Residual** | **Tier 1's hole is real and permanent** and `21` §8.7's statement ships unsoftened. Beyond that: an adversarial subagent built on the same model as the proposer shares its blind spots, and `21` §5.2.4 already says so — it catches the mechanical subclass of confident wrongness and misses the shared-world-model subclass. That residual is not closable with more subagents |

---

## 10. Bus factor and burnout

*margin tab: two to three years*

> **THE PROJECT DOES NOT FAIL WHEN SOMEBODY QUITS. IT FAILS WHEN SOMEBODY QUIETLY LOWERS THE BAR**

### 10.1 The arithmetic

`71` §2: 106–158 person-weeks solo to phase 7, 53–79 with three people. Solo, that is a
two-to-three-year project **and the corpus does not finish at the end of it.** §4.4 adds that
the corpus is 12–15 person-weeks per platform-domain unit with ~0.8 person-weeks/year of
standing maintenance per unit thereafter, on top.

`35` §12.4 records the current state: one person with commit access, named in the repository.
`71` §14.3 records the conclusion: *"Three people is the minimum that survives one person
leaving."*

### 10.2 What burnout looks like here, specifically

Not quitting. Quitting is visible and recoverable. The failure mode for a project with this
shape is the bar moving, one reasonable decision at a time:

| Symptom | Looks like | Detected by |
|---|---|---|
| Three depths become three lengths of the same sentence | Teaching depth stops containing counterfactuals and failure modes | `teaching_coverage` diverging from `coverage` (`15` §12.3). This is the canary |
| `acceptable_when` becomes boilerplate | "Rarely" appears in more than one rule | Pack review; a lint for duplicate `acceptable_when` strings across rules would catch it mechanically and does not exist |
| `misdiagnosed_as` gets filled from documentation rather than experience | Entries that name a plausible misdiagnosis nobody has actually made | G2's sampled voice audit (§4.7) |
| Fixture count per rule sits at exactly 2 | The minimum is being met rather than the intent | Trivially countable; nobody counts it |
| `reviewed_by` is the author | Invariant 10 satisfied in letter | Countable; the build already rejects the literal placeholder but not self-review |
| Coverage waivers accumulate past their expiry | The teaching gate has become advisory | `15` §12.4 makes expiry a build failure. Watch the *count* of live waivers, not just the expired ones |

**RECOMMENDATION — publish those six numbers in the release notes every release.** Not to a
dashboard, not to anybody outside; to the release notes, where the person writing them has to
look at them. A metric that nobody has to write down is a metric that moves without anybody
noticing, which is the entire mechanism of this failure.

### 10.3 The two bus factors, and only one of them is covered

`35` §12.5 covers the engineering bus factor and covers it well: public source under a
permissive licence so someone can fork and continue; reproducible builds from a public
container so a third party can actually *build*, which is what a fork needs; no first-party
code in the build container; the rule-pack trust root rebuildable by a fork with its own key;
and — the one that makes the honest answer to *"what if you disappear"* something other than a
shrug — a documented workspace format with published test vectors, so a future client written
by someone who never spoke to us can open the same file.

**Nothing covers the D1 bus factor.** The domain expert who has an SRX, can write in the
card's voice, and is willing to spend hours on YAML is, per `71` §15.1, *"the scarcest resource
and the least substitutable."* If they stop, the code survives and the corpus does not — and
the corpus is the product.

The only artefact that transmits the voice is the 50-entry reference set (`15` §12.5 P0), one
week of one person doing nothing else, which must exist before any other corpus work starts
because *"skipping it produces 400 entries in five voices that then have to be rewritten."*

**RECOMMENDATION — treat the reference set as a succession document, not only as a
specification.** Two consequences: (a) it is written to be read by a stranger, with a short
prose preface explaining *why* each entry is shaped as it is, not only what it contains;
(b) a second author writes ten entries against it inside the first six months and their pass
rate is published. If a second person cannot reach the voice from the reference set, the voice
is not transmissible and the project has a single point of failure it does not know about.

### 10.4 The funding shape, which is a burnout risk

Item 9 of §8.1: no telemetry means no usage-based pricing, no seat counting, no licence
enforcement. The available commercial shapes are support contracts, hosted D3 for customers who
want it operated, paid conformance work, and possibly signed rule packs. Each requires
somebody to do sales and delivery, and `71` §14.2 explicitly excludes sales, support and
marketing from every estimate in the roadmap.

So the honest position is: **the project's cost structure is dominated by an activity
(authoring) that cannot be accelerated, and its revenue structure is dominated by an activity
(services) that consumes the same person's time.** That is the classic shape of a project that
runs for three years on one person's evenings and then stops. Naming it does not solve it. Not
naming it is how the pre-mortem's first story happens.

### 10.5 Assessment

| | |
|---|---|
| **Likelihood** | **Likely** over a three-year horizon at one to two people |
| **Impact** | **Fatal** without the §10.3 preparation; **Recoverable** with it, in the narrow sense that the users' data and a fork survive even if the project does not |
| **Leading indicators** | §10.2's six numbers; corpus commits per month; whether the reference set has ever been used by a second author; whether any month passes with zero conformance-lab time |
| **Mitigation** | `35` §12.5's fork-ability controls for code; the reference set as succession document and the second-author test for voice (§10.3); publishing the six numbers (§10.2); §4.5's scope narrowing, which is also the primary burnout control because it is the only thing that makes the finish line reachable |
| **Residual** | **One person cannot do this at the scope currently written down.** Every mitigation in this section makes failure survivable rather than less likely. The only thing that makes it less likely is a smaller product, which is §4.5, which is why that recommendation appears in three sections of this document arrived at from three different directions |

---

## 11. Competitive response

*margin tab: if somebody ships it*

> **THE GLOBAL RULE IS ALREADY WRITTEN: READ THEIR CODE, CONTRIBUTE, AND STOP**

`71` §12.9 sets the policy: if somebody ships a guided, single-task, client-side configuration
builder with inline security reasoning and explanations, open source and actively maintained,
then *"the gap is the reason to build. If the gap closes, so does the reason."* That is the
right posture. This section is about the forms the gap can close in, most of which are not
that one.

### 11.1 Who could ship the teaching layer, and what it would cost them

| Actor | Has | Would have to acquire | Most likely form | Threat |
|---|---|---|---|---|
| **NetBox / NetBox Labs** | The inventory category and the distribution | The entire corpus, and a reason to care about explanation when the premise is storing facts | Documentation links from field help. Not explanation | Low to the teaching pillar; high to any Fathom inventory ambition, which brief §6.4 already positions against rather than at |
| **Nautobot / Network to Code** | Golden Config, Jobs, a services business that could fund authoring, and engineers who have seen the failures | Editorial discipline and a reason to make the content a product rather than a per-customer deliverable | Per-customer golden templates with commentary — content that exists and is not a product | Medium, and it converts to high if they ever productise it |
| **Infrahub / OpsMill** | A graph-based platform with version control and CI, generators and transforms — and, already shipped, *"An MCP server and Infrahub Skills [that] make Infrahub's validated, relationship-rich data directly usable to Claude, Cursor, and other AI agents"* ([opsmill/infrahub](https://github.com/opsmill/infrahub)) | Nothing, for the *appearance* of a teaching layer | **AI-mediated explanation over their own structured data** | **Highest of the platform vendors.** See §11.2 |
| **Batfish / AWS** | A vendor-independent model and a query engine that already answers whether two configured ends would negotiate | The explanatory corpus, and a client-side story it does not have | Better findings text | Low. Directionally inverse (`config → findings`), server-side, Java in Docker, does not teach |
| **A platform vendor** (Juniper, Palo Alto, Cisco) | Authority, hardware access, unlimited domain expertise, the ability to be right by definition | Nothing except the will | A single-platform, free, authoritative, online, account-gated teaching tool | **High against the Junos-first position specifically**, and structurally unable to be cross-vendor or to serve the air-gapped market of brief §2.4 |

### 11.2 The AI-mediated version, which is the one that arrives first

The Infrahub row is the important one and it deserves stating plainly, because it is already
real rather than hypothetical.

A source-of-truth platform that exposes its structured data to a general assistant gets
something that *looks like* the teaching layer for approximately zero editorial cost. Ask it
why a configuration is shaped a certain way and it will produce a fluent, mostly-correct
answer grounded in the customer's own data. It will not have `acceptable_when`. It will not
have `symptom_if_mismatched`. It will not name the misdiagnosis it prevents. It will not be
the same answer twice, it will not be citable in a change ticket, and it will not work on an
air-gapped network.

**Every one of those distinctions is real and none of them is visible in a demo.**

That is the competitive fact this project has to plan around: the differentiators are all
properties of the *third* interaction, not the first. Fathom's answer is the same the second
and the tenth time, it cites a corpus entry with a version it was verified against, and it
tells you when it is unsure. A competitor's answer is better-looking the first time. The
strategy that follows is not to compete on the first interaction — it is to make the
properties legible: the corpus version in the footer, `verified_against` on the entry, the
staleness margin tab, the citation into the field card, the risk label on every line. Those
are already specified. **They should be treated as the competitive position rather than as
hygiene.**

### 11.3 The scenario that eats the wedge

The uncomfortable one. "What's the Junos command to check if a tunnel is up" is a question a
general assistant answers instantly and adequately. That is precisely brief §6.1's flagship
query and precisely the vocabulary gap the finder exists to close.

The finder's advantages over that answer are:

| Advantage | Matters when |
|---|---|
| Works offline, no network | On a jump host, in a facility, on a bastion with no egress |
| Deterministic — same list every time | Pasting a result into a change ticket somebody else will review |
| Cites a corpus entry with a verified-on version | Somebody asks "how do you know" |
| Risk-labelled on every entry | The command is `clear security ike security-associations` on a hub |
| Verified on a real box, with real `output_fields` | Reading the output, not just running the command |
| No egress of the question itself | The question contains a customer's VPN name |

**Read that column honestly: it describes an engineer at 03:00 on a restricted network, and
not the same engineer at their desk on a Tuesday.** Most engineers are at their desk most of
the time. So the wedge is weakest exactly where the volume is, and strongest exactly where the
market of brief §2.4 is — air-gapped, defence, OT, regulated.

That is not a reason to abandon the wedge; it is a reason to be precise about who it is for.
It also strengthens §4.5's recommendation from an unexpected direction: if the finder's
durable advantage is offline determinism and citation rather than raw answer quality, then
**breadth of platform coverage in the finder matters more than depth**, because the offline
engineer needs the command for whatever box is in front of them, and Rosetta is the feature no
general assistant can do with citations.

### 11.4 Assessment

| | |
|---|---|
| **Likelihood** | **Near-certain** for §11.2 (already happening) and §11.3 (already true). **Unlikely** for a direct clone of the whole product, for exactly the reason §4 gives: the content is the barrier and it is unglamorous |
| **Impact** | **Expensive.** The wedge gets harder to win and the teaching pillar gets harder to differentiate in a demo |
| **Leading indicators** | (a) Pilot engineers answering "where did you look that up" with anything other than Fathom. (b) Any source-of-truth platform shipping authored explanatory content rather than model-mediated access. (c) A platform vendor shipping a teaching tool for the platform we chose first |
| **Mitigation** | Make the durable properties legible rather than assumed (§11.2); breadth in the finder corpus, narrowness in the graph corpus (§4.5, §11.3); and `71` §12.9's rule — if somebody genuinely ships it, contribute and stop |
| **Residual** | **The first-interaction comparison is lost and cannot be won.** A product whose value appears on the third interaction has to survive long enough to get one, which puts it back on §7.2's waiting game and §10's endurance problem |

---

## 12. The pre-mortem

*margin tab: three years later*

> **IT IS 2029. THE PROJECT IS DEAD. HERE IS WHAT HAPPENED, IN ORDER OF HOW LIKELY IT IS**

These are written in the first person because that is the only register in which a pre-mortem
is useful. They are ordered by probability, not by drama, and the most likely one is the
dullest.

### Story 1 — The corpus stopped, and nothing announced it

Phase 0 shipped and it was good. A hundred and twenty command entries, all of them run on a
real SRX, the ranking closed the vocabulary gap on the golden set, eight engineers kept the
tab open. I was right about the wedge.

Then I did phase 1, because phase 1 is the interesting part. The graph, the rule engine, the
emitter that reproduced my own card byte for byte — that took eight months and every one of
them was satisfying. The corpus track was supposed to run in parallel. It ran for the first
six weeks and then it did not, because when there are two things to do and one of them
compiles, you do the one that compiles.

By month fourteen the corpus was at 180 entries against a v1 target of 430. Junos moved twice.
The staleness tabs started appearing — `unverified since 21.4` — and they were honest and they
were awful to look at. In month nineteen the fifteen-month release-calendar check turned into
a build failure exactly as designed, and I put a waiver in `corpus.toml` with an expiry three
months out and told myself I would get to it. I did not get to it. I re-dated it twice.

Nothing failed. There was no bad day. The tool got quietly less true, one release at a time,
and the pilot group stopped opening it in about month twenty-two, and when I asked them why
the answer was that they were not sure it was current any more. Which was correct.

**First visible:** month three, when the corpus track's weekly commit count first went to zero
and I did not treat it as a schedule slip because no phase exit criterion depended on it that
week.
**The instrument that would have caught it:** `71` X0.11 and §10.2's six numbers, published in
every release note. Authoring hours per month is a number you cannot look at for six months
without acting on it.

### Story 2 — I built the engine and never the content

The other version of story 1, and the more embarrassing one, because I would have done it
deliberately.

Every architectural decision in this repository is correct. Emitters return `(line,
provenance)` pairs, so teaching is structural. Rules are data with one engine and a `platforms`
predicate, so N × M grows linearly. The schema is generated from `schema.yaml` so three copies
cannot drift. `fathom-verify` never links `fathom-ai` and the symbol table proves it. It was
genuinely a pleasure to build and it demoed beautifully to other engineers, who all said the
same thing, which was some version of "that's a nice architecture."

The corpus stayed at the 84 seed entries from the field card. I kept meaning to expand it, and
every time I sat down to write forty entries I found an emitter bug instead, and the emitter
bug was real, and fixing it was progress by any measure I was keeping.

Somebody asked me at a meetup what the tool knew about BGP. Nothing. What did it know about
zones and policies? The five plumbing pieces from side 1, and only in the context of an IPsec
tunnel. It could explain thirty commands extremely well.

I had built a very good engine for a corpus that did not exist, which is precisely the thing
brief §3.5 warned about — *"several well-funded teams have built pieces of this"* — and I had
managed to do it alone, on evenings, having read the warning and written a document about it.

**First visible:** the first time a phase exit criterion passed while the corpus row of that
phase's deliverable table was unstarted. Phase 1's exit criteria are engineering criteria;
only X1.5 and X1.6 touch the corpus, and both are satisfiable with fifty rules.
**The instrument that would have caught it:** a phase gate that fails on content, not only on
code. `15` §12.4's CG1 is exactly that — a new emitter statement cannot ship without an
explainer — and it only bites if it is turned on in phase 1 rather than deferred to P3.

### Story 3 — The schema was Junos-shaped and I found out in month twenty

Phase 7. PAN-OS. I had told myself for eighteen months that the schema was vendor-neutral
because it was designed with vendor-neutral names and because Batfish had reached almost the
same six-object decomposition from the Cisco side, which I had written down as independent
evidence and which was independent evidence, of the crypto chain and nothing else.

It was not the crypto chain that broke. The crypto chain was fine — PAN-OS folds proposal and
policy into one `ipsec-crypto-profiles` object and two graph nodes mapping to one platform
object is exactly what the emitter's statement tables are for. It was the policy model. Junos
gives you an ordered list per zone pair. PAN-OS gives you one flat ordered list per vsys where
position means something different. I had written in `11` §12.2 that cross-vendor emit of a
security policy is not a supported operation and probably never will be, and I had meant it as
a scoping decision, and it turned out to be the load-bearing admission in the document.

What I actually did was worse than a redesign. I put `if platform == Panos` in three places in
the ordering logic, told myself it was contained because it was outside the rule engine and
the grep gate still passed, and shipped. Six months later there were eleven of them, four of
them in code the grep gate did not cover, and the extension bag was at 22% of field count with
a re-dated `promotion_review` on nine keys.

The mid-life crisis in `71` §10.1 is written as a decision point with three outcomes. It is
not. It is a slope, and the third outcome does not announce itself — it accumulates in the
places you decided were exceptions.

**First visible:** phase 1, when I chose not to spend the three days writing the PAN-OS and
IOS-XE columns of the divergence table on paper because there was no PAN-OS work in phase 1.
**The instrument that would have caught it:** S7 in §3.3. Three days of D1 time against a
4–8 week contingency, and I skipped it because it produced no artifact.

### Story 4 — Nobody crossed the cliff

This one has no villain and it is the one I would find hardest to accept.

The finder was loved. Genuinely loved — people had it pinned, people sent it to new hires,
somebody in a defence contractor put it on an air-gapped build server and told me it was the
only tool they had ever been allowed to install in one afternoon. The gap files came in. The
corpus grew, slowly but it grew, and the correction reports told me what was stale before I
found out from a customer.

Nobody ever opened a workspace.

Not "few people". In three years, of the engineers I could actually ask, four had opened a
workspace, three of those had done it once out of curiosity, and one had used it for a real
change and said it was excellent and then did not build another tunnel for eleven months.

The walkthrough was not bad. It was correct, it was fast, the findings fired as you went, the
change ticket passed a real change process the first time it was tried. It was simply that the
occasion for using it arrives a handful of times a year per engineer, and by the time it
arrived people reached for what they had done last time, which was the config from the last
site with the addresses changed.

Three years of engineering served a feature that was finished in month four. And the honest
epilogue: that feature is a good product, `71` §12.1 said I could ship it and stop, and I did
not take the exit because I had already built the graph.

**First visible:** the end of phase 2, when I could have counted how many pilot engineers had
opened a workspace twice and instead counted how many were using the finder.
**The instrument that would have caught it:** §7.4's workspace-opened-twice count, with a
threshold written down before phase 1 rather than interpreted after phase 4.

### Story 5 — One line was wrong, and the teaching pillar made it worse

The change was an MSS clamp on an SRX carrying a data centre's north-south traffic. The graph
said clamp tunnel traffic. The emitter produced `set security flow tcp-mss all-tcp mss 1350`,
because a field had moved between kinds in the schema refactor eleven months earlier and one
statement path had been updated and the other had not, and the golden fixture covered the
tunnel path and not the all-tcp path because nobody writes a fixture for the line they did not
mean to emit.

It committed cleanly. `commit confirmed 5` came and went and everything was fine, because
clamping MSS does not drop a tunnel — it degrades a class of traffic on a box carrying
everything, and it presents four days later as an application team complaining about large
transfers.

Here is the part I keep coming back to. The engineer had clicked the line. They had read the
Teaching-depth explainer, which was mine, and which was right: it explained MSS clamping, it
explained why clamping beats lowering the MTU, it named the misdiagnosis it prevents. It was
some of the best writing in the corpus. And having read it and found it clear and correct,
they did not read the line as carefully as they would have read a line from a Jinja template
they did not trust.

I had spent three years building something whose whole purpose was to make people confident,
and it worked, and then it was wrong once.

The post-incident write-up used the phrase "the tool said". The tool did not say; a human
pasted. That distinction is correct, it is in the licence, it is in the documentation, and it
is worth exactly nothing in the room.

**First visible:** the month the schema refactor landed and the golden fixture set was
re-baselined with a diff that somebody approved without writing down why.
**The instrument that would have caught it:** X3.1's inverse property test extended to
representability — every statement path the emitter can produce must appear in at least one
fixture, firing or not. A fixture set that covers the paths we meant to emit is not a fixture
set; it is a regression suite for our intentions.

### The sixth story, which is not a failure

It is 2029. Fathom is one HTML file, 2.4 MB, that a few thousand network engineers keep on
their laptops. It knows Junos SRX IPsec better than anything else in the world, plus the
command corpus for four platforms, plus enough zone and interface material to explain the
plumbing. It has never touched a network device, never accepted a credential, never made a
network request. The corpus is 94% Tier A, 71% Tier B, and the staleness page is on the front
screen where anybody can see it.

It never modelled anybody's estate. The graph exists, the walkthrough works, and most people
never open it.

I stopped at phase 3. That was the right call and it took me a year to be able to say so.

---

## 13. What is not on this list

*margin tab: the risks people will raise*

An honest assessment is also honest about what it thinks is *not* the risk. Each of these will
be raised in review; each is a real concern; none of them is in the register above and here is
why.

| Raised | Why it is not in the register |
|---|---|
| **"Rust/WASM is a niche stack and hiring is hard"** | True, and `41` §9.1 names it. It is a bus-factor input (§10) rather than a risk of its own. The alternative stacks lose determinism, single-file deployment, or the CLI, each of which is load-bearing |
| **"A browser tab cannot hold a real estate"** | Sized rather than feared. `17` §13's budgets and `44`'s numbers cover it, and `71` §13.2 sets the un-defer trigger at ~2,000 devices with genuine concurrent editing |
| **"The CRDT will be wrong"** | It might be, and `71` §12.6 has the exit: ship single-writer sync with explicit locking. A wrong merge of a firewall policy is unacceptable; a missing merge is merely annoying. The exit is cheap and named, so the risk is managed |
| **"Zero-knowledge will not survive review"** | It is a phase exit criterion with a red-team exercise and a commissioned external review (X5.1, X5.8), and a kill point if it fails structurally (`71` §12.6). It is the best-defended claim in the project |
| **"Users will demand the tool push config to devices"** | They will, and the answer is permanent (invariant 2, `71` §13.1). It is a product-boundary conversation, not a risk. The moment it can reach a device it needs credentials, and invariant 3 goes with it |
| **"Somebody will fork it"** | That is the plan. `35` §12.5 makes forking work on purpose, because a fork is what survives §10 |
| **"The three-value risk enum is too coarse"** | It is coarse deliberately and the card holds it across four sides. A fourth value is where the hard cases go to be avoided. This is a design argument that has been had (`51`, conventions) |
| **"AI will make the corpus obsolete"** | Possibly, for the first interaction, and §11.3 treats that seriously. It does not make *verified, citable, deterministic, offline* content obsolete, and those are the properties the market of brief §2.4 buys |

---

## 14. The decisions this document asks for

| # | Decision | Recommended answer | Why it cannot wait |
|---|---|---|---|
| 1 | Is the product "one platform modelled, four platforms looked up", or "three platforms modelled"? (§4.5, §4.8) | **The first.** Split the finder corpus from the graph corpus and budget them separately | Every content estimate in `71` assumes the second, and §4.4 shows it is out of reach at planned staffing. Deciding in phase 7 costs a year |
| 2 | Is the corpus size budget stated in **entries**, derived from B17? (§8.2) | Yes, before phase 1 | Two independent ceilings on corpus size discovered at different times is how a content programme gets cancelled halfway |
| 3 | Does the three-day paper divergence table for PAN-OS and IOS-XE get written in phase 1? (§3.3 S7) | Yes | It is the cheapest schema smoke detector available and it produces no artifact, which is exactly why it gets skipped |
| 4 | Is one `schema_version` major per 24 months a stated policy? (§3.4) | Yes, announced before phase 7 | A format that breaks twice is a format nobody commits to git, and the workspace-as-owned-document claim goes with it |
| 5 | Does the golden query set include `NoHit` queries with expected under-determination surfaces? (§9.3 D8) | Yes, from phase 0 | Without it, the determinism guarantee has a blind spot shaped exactly like the place the supervisor lives |
| 6 | Is model-drafted corpus authoring gated by a **published, stratified** voice audit? (§4.7 G2/G3) | Yes, or the mitigation is not taken at all | An unmeasured quality gate erodes silently, and it erodes the thing that differentiates the product |
| 7 | Does the 15-month release-calendar build failure become waiver-only, with an owner and an expiry? (§5.2) | Yes | A control that can be silenced with a one-line commit is not a control |
| 8 | Is there a shape export for support, specified before the first support request? (§8.3) | Yes | Otherwise the answer gets improvised under pressure, and the improvised answer is "email us your workspace" |
| 9 | Is the second-author test on the 50-entry reference set run inside six months? (§10.3) | Yes | If the voice is not transmissible, the project has a single point of failure it does not know about |
| 10 | Does a per-platform statement of the confirmed-commit brake ship with every change ticket? (§6.3) | Yes, from the second platform | The safety floor is platform-dependent and silently assuming otherwise is a correctness liability |

---

## 15. Sources consulted

| Claim | Source |
|---|---|
| YANG "server deviation" definition; deviations reduce model utility and increase application fragility; the `deviation` statement | [RFC 7950 §3, §5.6.3, §7.20.3](https://www.rfc-editor.org/rfc/rfc7950.html) |
| Vendors ship deviation and augment files alongside OpenConfig implementations, for unsupported nodes, granularity mismatches and different ranges | [Nokia, *Deviating and augmenting*, 7750 SR system management guide](https://infocenter.nokia.com/public/7750SR222R1A/topic/com.nokia.System_Mgmt_Guide/deviating_and_a-d402e1369.html) |
| OpenConfig founded by contributors from Google, AT&T, BT and Microsoft; operator-driven, vendor-neutral | [OpenConfig FAQ](https://www.openconfig.net/docs/faqs/faq/) |
| Native models remain necessary for platform-specific features and for features that ship before the neutral schema is updated | [Cisco, *Native, IETF, OpenConfig… Why so many YANG models?*](https://blogs.cisco.com/developer/which-yang-model-to-use) |
| OpenConfig model versioning: non-backward-compatible changes require a major bump; deprecate for at least one minor first | [OpenConfig, *Versioning Individual OpenConfig models*](https://www.openconfig.net/docs/guides/semver/) |
| IOS-XE Configuration Rollback Confirmed Change — `configure terminal revert timer`, `configure confirm`, automatic reversion if unconfirmed | [Cisco IOS XE 17.x system management guide](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/syst-mgmt/b-system-management/m_cm-config-rollback-confirmed-change.html) |
| PAN-OS candidate/running configuration, commit versions, and reverting configuration changes | [Palo Alto Networks, *Revert Firewall Configuration Changes*](https://docs.paloaltonetworks.com/ngfw/administration/firewall-administration/manage-configuration-backups/revert-firewall-configuration-changes) |
| CRA entered into force 10 December 2024; reporting obligations from 11 September 2026; main obligations from 11 December 2027 | [European Commission, *Cyber Resilience Act*](https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act) |
| New Product Liability Directive brings software within "product"; excludes FOSS developed or supplied outside a commercial activity; transposition by 9 December 2026 | [Directive (EU) 2024/2853, EUR-Lex](https://eur-lex.europa.eu/eli/dir/2024/2853/oj/eng) |
| Infrahub ships an MCP server and Infrahub Skills making its data usable to AI agents; renders configurations from its data via Jinja2 or Python | [opsmill/infrahub README](https://github.com/opsmill/infrahub) |
| Corpus counts, tiers, coverage metrics, rot model, staleness, triage ladder, community contribution analysis | `docs/10-core/15-explainer-corpus.md` §§12, 13 |
| Command entry authoring cost, the format's costs, the hardware-access assumption | `docs/60-content/61-command-corpus-spec.md` §§18, 20 |
| Statement dictionary scale as a content programme | `docs/10-core/14-parsers-and-ingest.md` §§6.5, 15 |
| Schema evolution, preserve mode, migrations, the extension bag's eight rules and the honest part | `docs/10-core/11-ir-schema.md` §§11, 12 |
| Batfish taken/rejected, and the total-population divergence | `docs/10-core/11-ir-schema.md` §2 |
| Phase structure, exit criteria, kill points, effort methodology, staffing, the corpus track | `docs/70-ops/71-roadmap.md` |
| AI tiers, admission criteria, the egress statement, what the boundary costs | `docs/20-ai/21-ai-layer-architecture.md` §§5, 7, 8 |
| Bus factor controls, what we will not claim, the one-maintainer position | `docs/30-security/35-supply-chain-and-builds.md` §12 |
| The CRA question already marked for counsel | `docs/30-security/36-enterprise-review-qa.md` Q59 |
| Every failure mode, command, symptom and worked example used above | `.context/field-card-srx-ipsec.txt`, sides 1–4 |

---

## 16. Disagreements

**1. No hard invariant, terminology entry, or the risk enum is disputed.** The `Risk` enum is
used only for what a command or emitted line does to a box, and the project-risk scales in
§1.2 are named differently and explicitly forbidden from borrowing its colours.

**2. Recording a scale the conventions do not define.** `.context/conventions.md` pins the
`Risk` enum and notes that finding severity is a separate scale rendered in neutrals. It does
not define a scale for *project* risk, and this document needs one. §1.2 defines
`Unlikely / Likely / Near-certain` and `Recoverable / Expensive / Fatal` and states that they
are not the `Risk` enum. This is recorded here so a second document that needs the same scale
adopts these values rather than inventing a parallel set. If the conventions are ever revised,
these belong in them.

**3. A proposed change to `71` §2's totals, stated as a proposed change rather than a silent
deviation.** `71`'s phase table gives engineering effort and treats the corpus as a parallel
track with its own calendar (principle O5), which is correct. §4.2 and §4.4 of this document
compute that track for the first time as a single figure — 12–15 person-weeks per
platform-domain unit plus ~0.8 person-weeks/year of standing maintenance — and conclude that
the roadmap's v2 scope of three platforms × three domains is not reachable at the staffing
`71` §15.1 assumes. That is not a disagreement with any decision in `71`; it is an arithmetic
result `71` does not carry, and it argues for re-cutting scope before phase 1 rather than
discovering it at phase 7. `71` §12.1 and §12.9 already provide the machinery for exactly that
decision.

**4. A narrowing of a claim in the brief, offered for the owner's judgement.** Brief §1 states
`config = emit(graph, vendor)` as one of six views over one graph. `11` §12.2 already concludes
that cross-vendor emit of a security policy is not a supported operation and probably never
will be. §3.2.3 of this document takes that one step further and proposes that the defensible
form of the bet is: **the schema is neutral enough that `explain`, `lint` and `render` work
across platforms even where `emit` does not.** That is a weaker claim than the brief's and a
much more likely one to survive phase 7. It is offered as a proposed change to the product's
external claim, not as a change to the architecture, which already behaves this way.
