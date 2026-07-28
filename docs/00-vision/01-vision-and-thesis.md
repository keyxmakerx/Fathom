# 01 — Vision and thesis

> **Status:** Accepted.
> §§1–6 complete the owner's §§1–4 and preserve his words where they still hold.
> §§7–12 are **Reconstructed** — they replace §§11–14 of a source document that terminated
> mid-sentence inside §7.1, and they incorporate the six adversarial critiques in
> `docs/80-review/` and the eighteen decisions in `docs/90-decisions/`.

*margin tab: read this first*

> **THIS DOCUMENT IS THE FRONT DOOR. EVERY NUMBER IN IT IS EITHER CITED OR MARKED UNMEASURED.**

Companion documents, in the order a reader should reach for them:
`docs/00-vision/02-prior-art-and-positioning.md` (the survey §5 compresses),
`docs/00-vision/03-non-goals-and-scope.md` (§10 in enforceable form),
`.context/conventions.md` (the invariants),
`.context/design-language.md` (the voice and the three-colour legend),
`docs/80-review/80-reconciliation.md` (the defect register that produced §§7–12),
`docs/90-decisions/` (ADR-0001 … ADR-0018, which are binding).

> **Numbering note.** ADR-0001 instructs that the ownership register be written to
> `docs/00-vision/01-ownership.md`. This document now occupies `01`. The register needs a free
> number in `00-vision/`; that is a one-line correction to ADR-0001, recorded here so it is
> found by reading rather than by collision.

---

## 0. Contents

| § | |
|---|---|
| 1 | What Fathom is |
| 2 | One graph, six views — and its three consequences |
| 3 | The three pillars, and why they are non-negotiable together |
| 4 | The problem |
| 5 | Positioning, and the landscape table corrected |
| 6 | The security posture, in one page |
| 7 | Where the AI layer sits, in one page |
| 8 | The honest assessment — five risks |
| 9 | The pre-mortem's conclusion |
| 10 | What is explicitly not being built |
| 11 | The roadmap, in one table |
| 12 | The decisions that must be made before code |

---

## 1. What Fathom is

*margin tab: the whole thing in one paragraph*

Fathom is a **security-first, client-side network engineering tool** for the engineer who has to
build, understand or defend one configuration, on a machine that must not send it anywhere. A
typed graph models the network — devices, interfaces, links, zones, tunnels, policies, routes —
and everything the product does is a projection of that one structure: the diagram, the emitted
configuration, the findings, the explanation, the verification ladder, the inventory. It never
touches a device, never accepts a credential, and never opens a connection the user did not
configure. Its output is deterministic and every emitted line carries the node and the fields
that produced it, which is what makes it reviewable a quarter later. Its explanations are
human-authored, reviewed, and stamped with the person and the box and the date on which they
were checked — which is a claim about the world, not about an answer, and it is the one thing in
this product that nothing else can copy.

---

## 2. One graph, six views — and its three consequences

*margin tab: the thesis*

The owner's formulation, preserved:

```
diagram   = render(graph)
config    = emit(graph, vendor)
findings  = lint(graph)
lesson    = explain(node, depth)
runbook   = verify(diff(graph))
inventory = table(graph)
```

Six features, one data structure. This is not an inventory tool bolted to a config generator
bolted to a diagram editor. It is one model with six renderers, and it drives most of the
architecture through three consequences.

**1. The diagram cannot be the data structure.** A line between two boxes does not say whether it
is an L2 trunk, an L3 point-to-point, an LACP member link or a tunnel. Build diagram-first and
you will bolt properties onto edges until you have an accidental, undocumented data model. Build
model-first and the diagram becomes one editor among several.

**2. Teaching is structural, not additive.** Because explainers and emitters read the same node,
"click any line of config to learn what it does" is a consequence of the architecture rather than
a feature that has to be maintained separately.

**3. Views compose.** *"Show me the verification commands for the change I just made"* is
`verify(diff(graph))`. It requires no new subsystem.

### 2.1 Three corrections the corpus made to its own slogan

Stated here rather than buried, because the slogan is what a reader carries away.

| Correction | Source | What it changes |
|---|---|---|
| **"Six views" is a count of projections, not of screens.** The information architecture resolves to four renderers, one controller, one corpus surface, and one layer that opens inside all of them | `52` §1.1 | `explain` is a layer, not a view; `verify(diff)` is a mode of the config view. Do not use the count as an architecture claim |
| **Composition is free in concept and not in code.** Graph diff, config diff, ladder selection and rollback generation are four real pieces of work | `71` §6.1 | 8–12 solo weeks, and that is the *shortest* rung in the plan |
| **`emit` does not generalise across platforms in every domain.** Cross-vendor emit of a security policy is not a supported operation and probably never will be | `11` §12.2 | The honest bet is narrower: the graph is neutral enough that `explain`, `lint` and `render` work across platforms **even where `emit` does not** |

**The demotion, and it is deliberate.** *One graph, six views* is a **consistency** claim, not a
capability claim. What the graph buys is that a rename propagates everywhere, a finding points at
the same node the emitter read, and provenance survives from a walkthrough answer to a rendered
line. What it does not buy is cheap views: the marginal cost of each view is dominated by its own
UI and by the corpus behind it, and the graph reduces neither. `84` §4.3 argues that four of the
six views exist because the slogan has six, and the argument is not refutable from inside the
corpus. The instrument that settles it is a pilot engineer who does not work on the project.

**Rule of thumb: the slogan is how the code is organised. It is not how the product is sold.**
Public material leads with what the tool does with no setup, no account and no network. The graph
is the second sentence at most (`84` D3).

---

## 3. The three pillars, and why they are non-negotiable together

| Pillar | The statement |
|---|---|
| **Validate** | Build a config correctly, with security findings inline as you go — not at the end |
| **Map** | Model the estate; the diagram is a view over the model, not the model itself |
| **Teach** | The user should finish knowing *why*, not just *what*. A first-class constraint, not a documentation afterthought |

A tool that only validates is a linter. A tool that only maps is NetBox. A tool that only teaches
is a book. The combination is the product, and specifically the teaching pillar is what makes the
other two adoptable, because it converts every interaction into a reason to trust the output.

**The objection, which is real and unanswered.** `84` §2.3 puts it sharply: the three pillars have
three different buyers. Validate is bought by security and compliance, annually. Map is bought by
operations, annually. **Teach has never had a line item.** The pillar that differentiates is the
one nobody has ever purchased, and the two with budgets are already served by incumbents that
`02` §13 concedes are better at them, eleven times over. That is not a marketing gap; it is the
independent answer to *"why has nobody built the whole thing"*, and §8 carries it as a
Near-certain / Fatal risk rather than as an aside.

---

## 4. The problem

### 4.1 The vocabulary gap

The hardest part of operating a multi-vendor network is not that the commands are difficult. It
is that *you cannot search for something when you do not know what it is called*. "How do I check
if the tunnel is up" contains none of the words in `show security ipsec security-associations`.
Vendor documentation is organised by command, not by question, so it only helps people who
already know the answer.

This compounds across vendors. The same concept has four names (`ae` / `port-channel` / `bond` /
LAG), and things that look alike are not alike — a Juniper `reth` sits next to a LAG in interface
listings and is not aggregation at all.

### 4.2 Documentation rots

Source-of-truth systems fail on data-entry discipline rather than on tooling. Documentation that
must be maintained by hand is not maintained, and any design that begins *"now model your entire
estate in these forms"* inherits that failure mode.

> **Correction to the owner's §2.2, applied.** The brief attached two figures to this argument —
> accuracy falling to roughly 15–30%, data quality implicated in about 22% of automation projects
> — and neither has a traceable primary source. `02` §2.4 recommends removal; this document takes
> it. **The figures do not appear in this corpus or in any public material.** The argument is one
> every network engineer accepts from experience; attaching an unsourceable statistic converts a
> credible claim into a checkable one that fails the check, and this project's entire posture is
> that its claims survive checking.

### 4.3 Tools exist, and one of them now teaches

There is good tooling in adjacent spaces. Batfish will tell you a configuration is wrong; it will
not tell you why the correct version is correct. Nautobot Golden Config will generate a config;
it assumes you already knew what you wanted. Apstra and NSO put a graph at the centre and project
from it — the same architecture, shipped, funded — and their abstraction exists precisely so that
you do not have to know what it generated.

> **Correction to the owner's §2.3, applied.** *"Nothing in the open-source landscape treats
> understanding as the deliverable"* was true when the brief was written. It is not true now. An
> engineer with a general assistant in a browser tab can paste a config and get a readable
> explanation, ask "how do I check if the tunnel is up" and get the right command, and ask for the
> Junos equivalent of `show crypto ipsec sa` and get a correct answer — free, installed, and
> already habitual. **The command finder's wedge is not undefended.** §5.3 states what survives
> that and what does not.

### 4.4 The confidentiality problem

Network configurations are among the most sensitive artifacts an organisation holds — topology,
addressing, trust boundaries, credentials. Engineers routinely paste them into web tools with no
defined data handling. A tool that is genuinely trustworthy with this material, verifiably, has a
market that SaaS competitors structurally cannot serve: air-gapped, defence, OT, regulated.

**And the honest qualification.** That market is real and it is the hardest one in the world to
reach. `84` §6.2 walks the persona: procurement wants a vendor, an accredited estate does not run
a single HTML file an engineer downloaded, ingress to an air-gapped network is a controlled
process, and an air-gapped user on an old build cannot be told their build has a vulnerability —
which is unmitigable and is the first question their security officer asks. **Technical fit is not
procurement fit, and the corpus has only ever demonstrated the first.**

---

## 5. Positioning, and the landscape table corrected

### 5.1 The table

`∼` means partially, with the qualification in `02`'s referenced section. Rows in **bold** are
categories the owner's §3.5 did not survey and which `02` added: vendor-native tooling, the lab
and topology tools that *do* derive configuration, and the assistant wave.

| Tool | Direction | Runs | Custody | Touches devices | Needs SoT | Deterministic | Teaches | Cost floor | Offline |
|---|---|---|---|---|---|---|---|---|---|
| Batfish | config → findings | server | yours | no | no | yes | no | free | yes |
| Forward Networks | config → findings, query | server/SaaS | vendor/yours | collects | no | ∼ | no | enterprise | no |
| IP Fabric / NetBrain | config → findings | server | yours | collects | no | ∼ | no | enterprise | no |
| NetBox / Nautobot | facts stored | server+DB | yours | no | it is one | yes | no | free | yes |
| Infrahub | facts stored, versioned | server+DB | yours | no | it is one | yes | no | free | yes |
| Nautobot Golden Config | SoT → config | server+DB | yours | via Jobs | **yes** | yes | no | free | yes |
| **netlab + containerlab** | **topology → lab config** | local | yours | builds them | no | yes | ∼ | free | yes |
| Ansible / Nornir / NAPALM | intent → device | local/server | yours | **yes** | no | ∼ | no | free | yes |
| hier_config / ciscoconfparse | config → config | local | yours | no | no | yes | no | free | yes |
| **Juniper Apstra** | **intent → config → validate** | server | yours | **yes** | builds one | yes | **no** | paid | no |
| **Cisco NSO** | **service intent → config** | server | yours | **yes** | models it | yes | **no** | enterprise | no |
| **Juniper Routing Director** | intent → services, assurance | server | yours | **yes** | no | ∼ | no | enterprise | no |
| **Palo Alto Panorama** | central policy → firewalls | server | yours | **yes** | no | yes | no | paid | no |
| **OpenConfig / YANG / gNMI** | schema + transport | n/a | n/a | transport does | n/a | yes | no | free | yes |
| **Hosted assistant** | question → answer | SaaS | **vendor** | no | no | **no** | **yes** | free | **no** |
| **Local assistant** (llama.cpp-class) | question → answer | **client** | **user** | no | no | **no** | **yes** | free | **yes** |
| **`junos-mcp-server`** | intent → committed config | local + device | yours | **yes** | no | **no** | no | free | ∼ |
| **NetBox / Nautobot MCP** | question → SoT answer | local + server | yours | no | **yes** | **no** | no | free | ∼ |
| **Cisco AI Canvas, Marvis** | question → answer over telemetry | SaaS | vendor | collects | no | **no** | ∼ | enterprise | no |
| draw.io / Dia | human → picture | client | yours | no | no | yes | no | free | yes |
| Certification and lab courses | curriculum → competence | n/a | n/a | no | no | n/a | **yes** | varies | ∼ |
| **Fathom** | **intent ⇄ config, explained** | **client** | **user, encrypted** | **never** | **no** | **yes** | **yes** | **free** | **yes** |

Two rows are corrected against `02` §11 on `84` D2's finding, and the correction matters more than
it looks: the brief's single "general LLM assistant" row scored `Offline: no` and `Teaches: ∼`.
**Local inference is offline, and it teaches well.** The competitor that beats Fathom on
confidentiality *and* explanation runs on the same laptop, and it did not appear in the table at
all until now.

**Read the Fathom row as a set of refusals, not features.** Six of its ten cells are things it does
*not* do, and `03` is the document that makes each of them testable.

### 5.2 The gap, restated so that it holds

The brief said: *"Guided, single-task configuration construction with inline security reasoning,
running entirely client-side, does not exist in open source."* That survives with two
qualifications that make it weaker and true — "in open source" is doing real work, because Apstra
and NSO do guided intent-to-config commercially; and "with explanation" is now contested, because
assistants explain.

**The claim the project uses:**

> *Deterministic, provenance-carrying, offline, single-task security configuration construction
> with inline findings and layered explanation does not exist anywhere, at any price.*

Longer, uglier, and it holds.

### 5.3 The three structural differences, priced honestly

Fathom's answer to an assistant cannot be *"our answers are better."* On average they will not be.
The answer has to be structural, and one of the three the brief and `02` §9.3 relied on is
overstated, one is eroding, and one survives.

| # | Difference | Verdict |
|---|---|---|
| **1** | **Determinism.** Same workspace + same corpus version + same rule-pack set + same build ⇒ byte-identical config, findings and ranking | **Narrowed.** `02` §9.3's *"you cannot review a change whose generation is not reproducible"* is false and an evaluator will catch it in the room: a change process reviews the artifact, not the generator. What determinism actually buys is **regeneration** (the same workspace produces the same ticket next quarter, against a corrected corpus), **recall**, and **shareability**. Claim those three; delete the review claim (`84` §5.1) |
| **2** | **Confidentiality.** The configuration never leaves the machine | **Eroding, by our own hand.** A local model keeps every invariant too. The differentiator is not *offline* — local inference is offline — it is **no model at all**, which is a narrower claim that narrows further every year. `84` §5.2 is right that the corpus rests its market case on configs not being sendable to a model while planning a rung around a model on the same laptop |
| **3** | **Provenance.** Emitters return `(line, provenance)` pairs, so every emitted line names the node, the fields and the rules that produced it | **Survives completely.** When a rule turns out to be wrong, a provenance-carrying tool can answer *"which of my configs came from that rule"* offline, forever. A transcript cannot answer it at all. It is a property of the data structure and not of anybody's accuracy |

### 5.4 The differentiator that is not on that list, and is the strongest one

**A named human ran this command on a real box on a stated date, and the entry says so, and it
says when it is no longer sure.**

That is a claim about a person, a box and a date. No model can make it — not because models are
inaccurate, but because the claim is about the world rather than about an answer. It is cheap to
make, expensive to fake, and it gets *more* valuable as generated answers get more fluent.

Two things must be true for it to matter, and one of them is currently a YAML field:

1. Every entry has actually been run on hardware, as a gate rather than an aspiration. `71` §3.3
   admits *"none of them run on a box"* today; `61` §20 admits the hardware for platforms two,
   three and four is not satisfied by anyone named in this project.
2. `verified_against` and `Staleness` are **rendered on every result**, not merely stored.
   `84` D7 makes this required chrome on every finder row, every explainer header and every
   emitted line's explainer, in muted mono at the margin-tab weight:
   `junos-srx 21.4R3 · verified 2026-05-12 · K. Okafor`.

**Rule of thumb: if the verification stamp is not on the screen, the product's only unforgeable
differentiator is not shipping.**

### 5.5 Where Fathom is worse

Fathom is worse than every incumbent at the thing that incumbent exists to do: Batfish at
control-plane simulation, Forward at knowing what the network is right now, NetBox at fleet scale,
Golden Config at compliance diffing, Apstra and NSO at depth of generation within their domains,
netlab at producing a running network, Ansible at applying anything, vendor documentation at
completeness, a certification course at building competence from nothing, an assistant at breadth
and at day-one usefulness with zero content investment, and every commercial product at support,
SLA, indemnity and a procurement path. The last one blocks enterprise purchase outright,
independently of everything else.

**The position depends entirely on the claim that the combination is worth more to a specific user
than any single incumbent's depth — and that is an assertion with no evidence behind it.** Nobody
has ever opened a tool because of a combination. They open it for one view. The combination is
what keeps them, if they are already there.

---

## 6. The security posture, in one page

*margin tab: written to be argued with*

> **THE SECURITY CORPUS IS ONLY AS TRUE AS THE DOCUMENT A CUSTOMER READS.**

**Zero-knowledge.** The server stores ciphertext and metadata and never holds secret key material.
The workspace is one encrypted document the user owns: git-versionable, diffable, portable. No
Postgres, no migrations, no ORM.

**The four permanent boundaries** (`conventions.md` invariants 1–4, made testable in `03` §3):

| # | Boundary | The refused adjacent that tests it |
|---|---|---|
| 1 | **No egress by default.** `connect-src` is `'none'` offline and exactly one origin in the sync build. No telemetry, no analytics, no font CDN, no error reporting | *"An anonymous usage ping, off by default"* |
| 2 | **Never touches a network device.** No SSH, no NETCONF, no gNMI, no API, no serial. Output is copy-paste, always | *"Just read-only `show` commands"* — which needs a credential, needs egress, and is unenforceable from the client side, because `clear security ipsec statistics` differs from `show` by one word |
| 3 | **Never accepts a credential.** No PSKs, no private keys, no SNMP communities, no TACACS keys. Emitted config uses placeholders. Amended by ADR-0002 to enumerate the workspace secrets and the transient-paste case honestly, rather than to keep a sentence that four documents had to work around | *"An optional plugin, off by default"* — an invariant with an opt-out is not an invariant |
| 4 | **The server never holds a *secret* key.** Amended by ADR-0002: the member log holds *public* X25519/Ed25519 keys, which is a different thing, and the invariant should say which thing it means | — |

**In scope, with mitigations:** server compromise and the server operator (zero-knowledge);
network interception (TLS over already-encrypted payload); lost or stolen endpoint (nothing
sensitive persisted in plaintext); malicious image substitution (signed images, reproducible
builds, published hashes); runtime supply chain (a minimal dependency surface); exfiltration by
the application (no egress).

**Out of scope, and the owner's truncated sentence completed** (`31` §6):

| Threat | Why it cannot be mitigated |
|---|---|
| **Compromised browser** | Defensive code runs in the same context as the attacker. Hostile code in our origin reads the decrypted graph out of WASM linear memory as a plain `Uint8Array` and calls any exported core function, including `seal`/`open`. Every detection we could write is code the attacker rewrote first |
| **Malicious extension** | The platform grants extensions the page's DOM and, with a debugger attach, its whole JS context. There is no origin-level control that revokes it |
| **Compromised endpoint OS, keyloggers** | Encryption at rest protects against a thief, not against something running as you |
| **Shoulder-surfing, screen capture** | Displaying network configuration is the feature |
| **The user pasting output elsewhere** | The clipboard is the delivery mechanism, by invariant 2 |
| **Coercion** | No cryptography survives compulsion. Deniability is not offered, and `31` §6.6 says why |
| **Traffic analysis at the sync server** | Zero-knowledge protects contents. It cannot hide that a workspace exists, how big it is and when it changes. In scope with a `material` residual, not filed under "given up on" |

**Every residual is tagged on one pinned scale: `none | bounded | material | total`** (ADR-0002).

### 6.1 Four claims that were made and are now withdrawn

This is the part of the security posture that earns the rest of it. All four were found by `81`
and are closed by ADR-0015.

| Claim as written | Replacement |
|---|---|
| *"Rotating the root key renders every prior ciphertext undecryptable by anyone, including the customer"* | **False.** `RK_e` is recoverable from any surviving keyholder record, and every backup of a workspace contains one. What is available is deletion of the replica, plus the honest statement that the original is on your endpoints and in your repository |
| *"Workspace encryption is symmetric and not broken by a quantum adversary"* | True of the single-user path. **False of every shared workspace**, which wraps the root key under X25519 and is harvest-now-decrypt-later exposed until suite `0x02` ships |
| *"Nothing withheld — ten metadata channels enumerated"* | **Twelve.** The record kind in the clear to the sync server makes the suppressions record individually trackable; and under the rejected frame model, per-frame wall-clock timestamps and actor pseudonyms would have been a pseudonymous per-writer edit-activity map in every git object, forever. ADR-0013 removes the second by removing frames |
| *"Redaction on ingest catches secrets"* | Recall is < 1.0 and the ingest report must say so: `we catch what we know and what looks like a secret. we do not catch everything.` Redaction is a **retention** control, not a confidentiality control |

**The rule that follows, and it is the whole discipline:** a claim about the product may not appear
in a customer-facing document unless the owning document makes it in the same terms.

---

## 7. Where the AI layer sits, in one page

*margin tab: reconstructed*

> **THE AI LAYER IS NEVER IN THE PATH THAT PRODUCES AN ARTIFACT.**

The owner's additional direction was explicit: *"there needs to be a supervisor AI and sub
agents."* Reconciling that with a determinism guarantee, a zero-knowledge posture and an offline
single file is a first-class architectural problem, and this is the resolution.

**Two rules define the cut** (`21` §2.1):

> **R1 — The AI layer is never in the path that produces an artifact.** `emit`, `lint`, `verify`,
> `diff`, `table` and the finder call nothing in it. `fathom-core` does not depend on `fathom-ai`,
> and CI fails on a reversed edge. It is the cheapest and most reliable control in the design.
>
> **R2 — Every AI-originated change arrives as a reviewable proposed diff, never as a direct
> write.** There is no `Graph::apply_from_supervisor`. The only write path takes a `HumanReview`
> that cannot be constructed except by the UI accept handler.

**Five verbs, and no sixth.** A subagent may **Select** corpus entries, **Propose** a graph
mutation, **Order** results, **Ask** the human a question, or **Abstain**. It may not write the
graph, emit config, author findings, rank the finder, or reach the filesystem, the network or a
shell at runtime.

**The determinism claim is untouched, and here is precisely why.** Everything the user takes away
— configuration, findings, ladders, tickets, exports — is produced by the deterministic core and
only there. Selection changes *which authored text is shown*, never what it says. A proposal
becomes a value only after a human accepts it, at which point the value is human-authored and
recorded as such. **The reproducibility guarantee is identical at every tier.** Determinism is a
property of emitted artifacts; the AI session log and the egress log are quarantined records —
inside the workspace, never inputs to an emitter, excluded from every determinism assertion
(ADR-0002).

**Tier 0 is the default and ships forever.** No model is linked. All six views work. The four
under-determined cases fall through to a *deterministic under-determination surface* — closest
corpus entries, related findings, and a gap-report affordance — which is a genuine improvement on
`NoHit` and is the best product idea in the AI documents. Tier 1 (bring-your-own-key to a hosted
provider) is an explicit per-workspace opt-in and **breaks the headline confidentiality claim for
what is sent**; `21` §8.7 says so without softening, and crypto parameters are now `withheld` by
default rather than `sent` (ADR-0015). Tiers 2 and 3 keep egress local or inside the customer
boundary.

### 7.1 What the critique found, and what the honest picture is

| Finding | Resolution |
|---|---|
| **Every worked example cited corpus that does not exist.** Eleven of eleven rule IDs and four of four corpus IDs did not resolve; the one labelled *"the most important deterministic win in this scenario"* was invented | Rewrite every example against the shipped corpus by ID; add the CI grep that fails on any unresolvable ID; file the three genuinely missing rules as corpus tickets. **Do not re-run the scenarios until they land — the rewritten ones will show the model contributing less than the current text implies, and the corpus should publish that** |
| **The supervisor makes zero model calls in every documented interaction.** It is a host-side Rust dispatcher | That is the right engineering and it is the strongest thing in the AI corpus. What is wrong is that no document says it. One sentence in `21` §4.1, and then the owner rules on whether a capability-scoped Rust broker satisfies *"there needs to be a supervisor AI"*. Only the owner can rule on that |
| **`ask_human` was the boundary leak.** Up to 760 characters of uncited model prose, whose answer re-entered the graph tagged with human authority — laundering a model-framed question into a human-signed waiver of a `high` finding | `because` becomes a corpus reference, not prose, which alone kills the payload; question and choices go through the existing deterministic detectors; free text defaults off and marks dependent ops as judgement |
| **The pre-flight's copy was false.** *"NOTHING ELSE WILL BE SENT"*, shown above the first of up to twelve turns each a superset of the last | Replace with this-request / this-session / field-classes, and make the running byte counter the control that closes the loop |
| **The layer's net effect on the corpus is negative for eight of ten catalogue entries, by the catalogue's own accounting**, and evaluating it properly costs more than seventeen engineers running it | Recorded, not decided. The scope call is the owner's. ADR-0006 ships **6a only** — the boundary, the broker, the audit types and the under-determination surface — at 4–6 weeks of the 14–22 |

**Rule of thumb: the risk of a model being wrong is bounded by what the tool is allowed to do.**
Fathom's AI layer can do nothing to a device, because there is no path from the application to a
device at all. That is a stronger safety argument than any guardrail, and it was available only
because of a product decision taken before the AI layer existed.

---

## 8. The honest assessment — five risks

*margin tab: reconstructed*

> **A RISK YOU HAVE WRITTEN DOWN AND NOT PRICED INTO THE PLAN IS A RISK YOU HAVE DECORATED.**

Four of the ten rows in `72` §2's register are `Near-certain`, and none of them is an engineering
problem. These are the five that decide whether the project exists in three years.

| # | Risk | Likelihood / Impact | The single leading indicator |
|---|---|---|---|
| **1** | **The corpus does not get written, or stops being written.** An engine is written once, tested, then improved; a corpus is written once per subject, per platform, per version, forever, by somebody who has personally seen the failure being described. Engineering effort compounds. Editorial effort does not. One platform × one domain is ~1,110 authored items and 12–15 person-weeks, plus ~0.8 person-weeks per year of rot | Near-certain / **Fatal** | Authoring hours per month plotted against maintenance hours per month. The month those lines cross is the month coverage stops growing |
| **2** | **The project has no funding shape.** Every persona in the corpus is an individual engineer with no purchasing authority. Kite shut down with 500k developers and wrote *"individual developers do not pay for tools"*. DevDocs — structurally this product's finder, in a market a hundred times larger — has 40k stars and a README asking for maintainers. The one durable product in the genre survived by charging money, which ADR-0003 and ADR-0004 together foreclose | Near-certain / **Fatal** | Whether the corpus author's time is funded by anything other than goodwill in month twelve |
| **3** | **The maintainer stops.** Two bus factors exist and only one is covered: the code is documented well enough for a successor, and the *voice* is one person's output until a second author has been shown to reproduce it | Likely over three years / **Fatal without preparation** | Corpus commits per month, and whether the 50-entry reference set has ever been used by a second author. `72` §10.3's second-author test is the cheapest existential test in the corpus and it is unimplemented |
| **4** | **The schema is Junos-shaped.** A schema co-designed with one platform will fit that platform; that is not evidence. The bad outcome is not a redesign — it is eleven `if platform == Panos` branches accumulating in the places you decided were exceptions | Likely / Expensive → **Fatal** | The composed-representability rate, and any `if platform ==` outside the emitter's statement tables. The cheapest smoke detector is three days writing the PAN-OS and IOS-XE divergence columns on paper, in rung 1, and it will get skipped because it produces no artifact |
| **5** | **The wedge does not convert.** The five nearest relatives of a fast command finder — Fig, Dash, DevDocs, explainshell, tldr-pages — all stopped at the wedge or were absorbed into an assistant. Not one became the platform it was the on-ramp to | Likely / Expensive | Whether any pilot engineer opens a *workspace* — not the finder — unprompted, twice, in a quarter |

**Two standing costs that are not risks because they cannot be retired.** Version drift outruns
re-verification (Near-certain / Expensive; watch the ratio of aging to current entries per
platform), and a general assistant is already partly good enough at the wedge (Near-certain /
Expensive; watch pilot engineers answering *"where did you look that up"* with anything other than
Fathom).

**And one that is worse than it reads.** A wrong emitted line is unlikely per change and
near-certain over the product's life. The pre-mortem's fifth story is the one to hold: the
engineer had clicked the line, read the Teaching explainer, found it clear and correct — and
having found it clear and correct, did not read the emitted line as carefully as they would have
read a line from a template they did not trust. **A tool whose purpose is to make people confident
owes more than a tool that stores.**

---

## 9. The pre-mortem's conclusion

*margin tab: three years later*

The pre-mortem writes five ways this dies and one way it does not, and the sixth is the one the
project should aim at rather than fall back to:

> It is 2029. Fathom is one HTML file, 2.4 MB, that a few thousand network engineers keep on their
> laptops. It knows Junos SRX IPsec better than anything else in the world, plus the command
> corpus for four platforms, plus enough zone and interface material to explain the plumbing. It
> has never touched a network device, never accepted a credential, never made a network request.
> The staleness page is on the front screen where anybody can see it.
>
> It never modelled anybody's estate. The graph exists, the walkthrough works, and most people
> never open it.
>
> I stopped at phase 3. That was the right call and it took me a year to be able to say so.

**ADR-0006 takes that exit at the start rather than at the end.** Phases 0–3 are named as the
product; phases 4, 5 and 6 become funded expansions rather than sequence. The reasoning is not
pessimism — it is that the corpus already contained the arithmetic disproving its own plan, in the
same directory, and neither document mentioned the other.

**Three reasons to build it anyway, and they survive everything above.**

1. **The artifact already exists and it already works.** The four-side field card is not a
   hypothesis. Every failure mode in the critiques is a failure of *scale* — of platforms, of
   domains, of funding, of audience. Not one is a failure of the card.
2. **The security posture and the adoption posture are the same posture, which is rare.** For a
   product whose conversion event is rare, no account, no expiry, no network requirement and no
   update nag mean the cost of waiting is zero. It can be small for years and still be present on
   the afternoon it matters. Almost nothing in software gets to be dormant without decaying. This
   one does, because it is a file.
3. **The failure mode is survivable.** The worst case is a corpus of verified entries in a
   documented format under a permissive licence, and a single HTML file that still opens in ten
   years with no network. A project whose worst case is *"a very good reference for one platform
   that somebody else can fork"* is a project worth starting.

---

## 10. What is explicitly not being built

*margin tab: the no-list*

> **A SCOPE BOUNDARY YOU CANNOT TEST IS A PREFERENCE.**

`03` gives each of these a refused-adjacent and a CI or review test. This is the register.

| Class | Boundary |
|---|---|
| **Permanent** | Never touches a network device · never accepts a credential · no egress by default · the server never holds a secret key |
| **Refused** | Not a monitoring tool · not a source of truth of record · not a ticketing system · not an orchestrator · not a discovery tool · not a lab or simulator · not a certification trainer · not a chatbot · not a packet analyser · not a config backup or archive · not a compliance attestation product · not a write-once-deploy-anywhere abstraction |
| **Deferred** | Multi-tenant hosted service · fleet-scale workspace (thousands of devices) |

**And four things cut or deferred by the ADRs, named here so they are not rediscovered as gaps:**

| Cut | By | What is lost |
|---|---|---|
| **The interactive diagram** — reduced to an SVG export from the existing structure | ADR-0006 | Demos, and the change-ticket embed. At one platform and one domain the graph is a handful of nodes and the inventory table shows them |
| **Multi-writer sync and the CRDT** — git is the sync for v1; single-writer with an advisory lock is the next step, multi-writer only on evidence | ADR-0016 | Concurrent multi-writer teams. The 32-member ceiling was never the target user |
| **AI tiers 1–3** — only 6a (the boundary, the broker, the audit types, the under-determination surface) is in the plan | ADR-0006 | The owner's requirement in its literal form. §7 states what remains and what the owner must rule on |
| **A hosted service, accounts, plan tiers** | ADR-0003 | The only revenue shapes the genre has ever sustained. This is a decision to remain a tool |

**No governance body may repeal the permanent four.** Changing one produces a different product
with a different trust story and requires a rename.

---

## 11. The roadmap, in one table

*margin tab: reconstructed*

Per ADR-0006. Effort is solo weeks from `71`, which is the plan of record; `83` §12 re-costs the
same enumeration at 170–240 solo weeks to rung 7 against `71`'s 106–158, and **the register
declines to adopt either number until the measured authoring median has run for a quarter.**

| Rung | Name | Artifact | Retires | Solo | Status after ADR-0006 |
|---|---|---|---|---|---|
| **0** | The wedge — the finder | `fathom-<ver>.html` (D1) + the CLI | vocabulary, determinism of ranking, size, first corpus measurement | 12–18 wk | **This is v1**, published under its own honest description. *Not* "v1 of a network engineering platform" |
| **1** | Graph, one platform, one task | + walkthrough, emitter, rules, a single-keyholder passphrase-sealed workspace | provenance, rules-as-data, determinism of emit | 24–34 wk | Product |
| **2** | Paste and inventory | + parser, residue ledger, inventory | the on-ramp, residue | 14–20 wk | Product |
| **3** | Findings, diff, verify, rollback | + the change ticket | legibility to change management | 8–12 wk | Product |
| | **Rungs 0–3 — the product** | The finder, the walkthrough, paste and reverse explanation, findings, diff, verify, rollback, on one platform and one domain | | **58–84 wk** | **The default plan, not a fallback** |
| 4 | The diagram | Cut to an SVG export | — | ~1 wk of 6–10 | Cut |
| 5 | Encryption, workspaces, sync | Key hierarchy, keyholders, D2/D3 | zero-knowledge at full strength | 16–24 wk as planned; 48–69 as enumerated | Funded expansion. Unbundled: the CRDT moves out entirely |
| 6 | The AI layer | 6a only — boundary, broker, audit types, under-determination surface | the AI boundary | 4–6 wk of 14–22 | 6a only |
| 7 | The second platform (PAN-OS) | + `panos` | **the schema bet** | 12–18 wk | Funded expansion |

**Four things that change the shape of this table and are part of the decision:**

- **The corpus is a column, not a footnote.** `71` §2's headline omits 12–15 person-weeks per
  platform-domain unit and 20–30 person-weeks of expert domain time on the critical path. A
  headline effort number that omits the largest line item is misleading in the one place everybody
  looks.
- **The spike ships under the real name**, with a version number, a published hash and a staleness
  banner — reversing the instruction to delete it. The instruction is right for a code spike and
  wrong for a content product, and shipping it starts the kill signal and the authoring-rate
  measurement three months earlier.
- **Rosetta is unbundled from rung 7.** A command entry with `rosetta:` mappings costs 30–45
  minutes and needs no schema, dictionary, rule, parser or emitter. **The finder's corpus may be
  wide while the graph's corpus is narrow.** Four platforms of IPsec command corpus is about eight
  person-weeks, and it delivers the cross-vendor half of §4.1 without touching the modelling
  programme. This is a cut of a dependency, not of a feature, and it is free.
- **The corpus breaches its own invariant today.** 37 rules, 91 commands and 41 explainers all
  carry a placeholder reviewer, and there are no fixtures. That is a **release blocker on rung 0**,
  not a comment in a YAML header — and the flagship rule false-firing on the field card's own
  syntax is the concrete cost of having had no fixtures.

---

## 12. The decisions that must be made before code

*margin tab: reconstructed*

Anything marked **DECISION** in the owner's brief is a fork that is expensive to change later.
Twenty-nine forks are now answered in `docs/90-decisions/` (ADR-0001 … ADR-0030, with ADR-0023
still Proposed); the table below lists the first eighteen, and ADRs 0019–0030 cover the render
layer, the AI layer's shipping shape (0020–0022), the keymap, density, contrast and
verification chrome (0024–0027), corpus authorship (0028–0029) and the second platform (0030).
Six questions are not answered, and every one of the six is blocked on a measurement or on the
owner rather than on an argument.

| # | Fork | State | What it costs to be wrong |
|---|---|---|---|
| 1 | Every settled question has one owning document, with a precedence rule and a mandatory "building on" declaration | **ADR-0001** | Nine silent re-decisions, all nine of them contradictions, clustered wherever two documents were both plausibly the owner and neither was told which |
| 2 | The ten hard invariants are amended; the `none\|bounded\|material\|total` residual scale is pinned | **ADR-0002** | An invariant three dependents work around is not an invariant, it is a comment |
| 3 | A tool, not a business. No hosted service | **ADR-0003** | R5 — it constrains the licence, and the licence needs other people's consent to undo |
| 4 | Apache-2.0 core / AGPL-3.0 sync service / CC BY-SA 4.0 corpus; public from the rung-0 release, under a DCO | **ADR-0004** | R5 — after the first public commit every contributor is a veto |
| 5 | Rename; and remove the product name from the identifier namespace **today** | **ADR-0005** | Every ID ever minted writes the name into a file the user keeps. R3 now, R1 after one edit, R5 the day a public artifact carries a name |
| 6 | v1 is the finder; the product is rungs 0–3; the roadmap is re-cut | **ADR-0006** | The plan of record was one the project had already disproved, in the same directory |
| 7 | The IR is a property graph with first-class typed edges | **ADR-0007** | R4. A schema whose edges cannot carry fields cannot express the flagship rule correctly, and the card's own plumbing piece #3 is the per-interface form |
| 8 | `schema.yaml` is a specified, owned, versioned build input | **ADR-0008** | Six subsystems make load-bearing demands on a file no document owned. Without it the type checker, the reconciler and the pack lint cannot be built |
| 9 | `fex` is the rule condition language; no third-party evaluator in the trusted path | **ADR-0009** | R4. Total static read-set extraction is what makes the incremental engine sound; without it there is nothing to count and nothing to gate |
| 10 | `11` owns re-identification; a rename produces a candidate, never a silent re-binding | **ADR-0010** | A wrong match silently rewrites the history of an object that is not the one you are looking at |
| 11 | Risk is a property of **effect**; the caption is separable from the band; no fourth colour | **ADR-0011** | Under the shipped mapping, no `set` line in the corpus could ever be `Disruptive` — the colour that says *DROPS LIVE TRAFFIC* never appeared on the changes that drop live traffic |
| 12 | One workspace container: `17` owns the layout, `32` owns the cryptography | **ADR-0012** | Two incompatible formats, specified in full, with code, neither citing the other. Six documents specified a product that could not be built |
| 13 | Fixed hash shards, whole-record rewrite, a committed manifest | **ADR-0013** | Per-device records publish the exact device count in the file count, permanently, in every historical commit. A permanent metadata leak in immutable history is unrecoverable; an open-time regression is re-engineerable |
| 14 | Envelope and KDF corrections; `DeviceFloor::AnyDevice` is the default and the cracking table prints the floor first | **ADR-0014** | The numbers a reviewer quotes back were 5.3× too favourable for the configuration that ships |
| 15 | The claims register — every overclaim deleted or qualified before any customer-facing document is shown | **ADR-0015** | §6.1 |
| 16 | Git is the sync for v1. Multi-writer only on evidence | **ADR-0016** | 8–12 solo weeks, taken at week 4 rather than discovered at week 12 |
| 17 | The offline artifact is a complete product for one session, with **no browser storage of any kind**; `D1`–`D4` replace the letters | **ADR-0017** | With no storage there is no secret at rest behind a policy the platform will not deliver |
| 18 | Browser platform corrections — WebAuthn is possible again; non-manifest paths 404 and are not logged | **ADR-0018** | A user who enrolled a passkey got a workspace they could not open with it, and CI enforced the impossibility |

### 12.1 The six that are still open, and what closes each

| # | Question | What closes it | Cost |
|---|---|---|---|
| **O1** | **How big is the WASM core?** 700 KB or 2–3 MB, from the same component enumeration — a factor of four. It decides the artifact shape, the size gate, and whether the offline single file is viable at all | A two-day spike to build and measure it, in rung 0, before the size gate is armed | 2 days. **Nothing in `40-stack/` is safe until it is done** |
| **O2** | **Does a `sandbox` directive on a top-level document actually close the top two exfiltration channels** — and does `sandbox` without `allow-popups` block the only good save path? | A four-part measurement in a browser | One afternoon, and it is the highest-value open measurement in the corpus |
| **O3** | **What does Junos actually do to a running SA at commit?** Asserted in several corpus entries, cited to nothing, and it is the single sentence that decides whether an engineer schedules a change window | A box and a per-train answer. Until then every instance carries `VERIFY` and they consolidate into one explainer so it is corrected once | Hours, on hardware nobody named in this project currently has |
| **O4** | **Is the corpus authorable at the rate the plan assumes?** No entry has been authored and timed. The most credible number in the repository rests on an estimate | The measured authoring median, running from the day the spike ships | A quarter of data. Start it now |
| **O5** | **Is a Rust dispatcher a supervisor AI?** The design produces a host-side, capability-scoped tool broker that makes zero model calls in every documented interaction. That is the right engineering and it is not what was asked for | The owner, after `21` §4.1 says the sentence out loud. Until it does, they cannot rule | One sentence, no code |
| **O6** | **Whose budget does this come out of?** Three named candidates: an employer funding it as internal enablement; a vendor or training business funding it; nobody funding it | A decision before rung 1. The lean is *nobody* until an employer appears, because it is the only candidate requiring nobody's agreement | If it is *nobody*, the honest scope is one platform, one domain, forever, and §10's cuts are not optional |

**Rule of thumb: none of the six is blocked on thinking. Four are blocked on a measurement nobody
has taken, and two are blocked on the owner. Take the measurements first — they are eight days of
work between them, and five documents are currently derived from numbers that do not exist.**

---

## 13. Disagreements

Raised under the conventions' own procedure.

**13.1 — Against the owner's brief §2.2.** The accuracy and data-quality figures have no traceable
primary source. §4.2 removes them and makes the argument qualitatively. The conventions forbid
fabricating a benchmark; repeating an unsourced one in public material is the same failure one
step removed.

**13.2 — Against the owner's brief §3.** The survey has no vendor-native category, and Apstra is
architecturally the closest existing product to this project's own thesis. §5.1 adds it, along with
the lab-topology tools that do derive configuration and the assistant wave that does explain.

**13.3 — Against the owner's brief §1's "single offline file".** ADR-0017 keeps the workspace in
memory for one session with no browser storage of any kind, which is a narrower artifact than the
brief describes. This is raised rather than assumed.

**13.4 — Against `02` §9.3 difference 1 and `02` §14.2.** The determinism argument as written
overclaims review and the permitted public sentences open with an architecture slogan. §5.3 and
§2.1 take both corrections.

**13.5 — A numbering correction to ADR-0001.** The ownership register cannot live at
`docs/00-vision/01-ownership.md`; that number is now this document.
