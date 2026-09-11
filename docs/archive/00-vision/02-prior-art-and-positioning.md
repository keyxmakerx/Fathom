# 02 — Prior art and positioning

> **Status:** Proposed

This document extends and, in four places, corrects §3 of the owner's brief. Where it
contradicts the brief it says so explicitly and gives the evidence, per the rule in
`.context/owner-brief.md`'s preamble.

Companion documents: `docs/00-vision/03-non-goals-and-scope.md` (the boundary this survey
justifies), `docs/10-core/11-ir-schema.md` §2 (what was taken from Batfish's model vocabulary
and what was rejected), `docs/10-core/16-command-finder.md` (the wedge this survey argues is
undefended), `docs/20-ai/21-ai-layer-architecture.md` §§5, 7–9 (the boundary that answers §9
below), `docs/70-ops/72-risks.md` §§4, 11 (the content problem, and competitive response),
`docs/70-ops/71-roadmap.md` §12 (the kill points several entries here feed),
`docs/70-ops/74-governance-and-licensing.md` §5.2 (what a permissive licence hands a
competitor).

---

## 0. Contents

| § | |
|---|---|
| 1 | How to read this, and the method |
| 2 | Corrections to the brief |
| 3 | The rubric — nine axes, applied to everything |
| 4 | Verification and analysis |
| 5 | Source of truth |
| 6 | Intent-to-config, open source |
| 7 | Vendor-native tooling |
| 8 | The model-driven ecosystem |
| 9 | The LLM-assisted wave — the direct threat |
| 10 | Teaching, labs and reference |
| 11 | The landscape table, rebuilt |
| 12 | "Why not just use X" — the four answers that must survive contact |
| 13 | Where Fathom is worse |
| 14 | The positioning statement |
| 15 | What would falsify this |
| 16 | Sources consulted |
| 17 | Disagreements |

---

## 1. How to read this, and the method

*margin tab: read this first*

> **A COMPETITOR YOU HAVE NOT INSTALLED IS A RUMOUR**

### 1.1 What "verified" means in this document

Every factual claim about a third-party tool carries one of three confidence levels, marked
inline where it is not obvious from the citation:

| Level | Means |
|---|---|
| **Cited** | Checked against the vendor's or project's own current material, linked in §16 |
| **Structural** | A claim about the *category* rather than a specific product — "server-side," "requires device access" — that follows from how the product must work |
| `<!-- VERIFY -->` | Believed true, not checked this pass. Do not repeat it in public material until it is |

The rule exists because competitive surveys rot faster than any other document in a repository
and they rot in the most damaging direction: the claim "nobody does X" ages into a lie without
anybody editing it. §15 sets the re-check cadence.

### 1.2 The honesty rule

A prior-art section written to justify a decision already taken is worthless. This one is
written to try to kill the project, and it fails to — but only narrowly, and §13 is where the
narrowness is recorded. If a reader finishes §13 thinking Fathom obviously wins, §13 is not
doing its job.

---

## 2. Corrections to the brief

*margin tab: most-missed*

The brief's §3 is accurate on everything it covers. It is incomplete in three ways and carries
one number that should not be repeated.

### 2.1 Correction 1 — Batfish's premise is right, one qualification is missing

The brief says Batfish "requires no access to the devices themselves." That is true of Batfish
and it is the right characterisation of the *tool*. It is misleading about the *workflow*: you
still need a configuration snapshot, and in practice a snapshot comes from device access, a
backup system, or a source-of-truth repository. The engineer who has none of those has nothing
to feed Batfish.

This matters because it is the same qualification that applies to Fathom's own config-paste
on-ramp (brief §6.3), and the project should not claim an advantage it does not have. The real
difference is granularity: Batfish's unit of work is a snapshot of a network; Fathom's is one
pasted device, or none at all.

Everything else the brief says about Batfish checks out. It is Apache-2.0, it is an AWS-managed
open-source project since the Intentionet team joined AWS, and its research lineage was
recognised with the 2025 ACM SIGCOMM Networking Systems Award.

### 2.2 Correction 2 — the brief omits the lab-and-topology category, which *does* derive config

Brief §3.4 says of diagram and discovery tools: *"All of them either discover topology from a
live network or let you draw it. None derive configuration from it."*

That is true of the tools named. It is not true of the category the brief did not survey.
**Topology-to-config generation exists in open source and is mature.** `netlab` takes a
declarative topology file and generates working device configurations across many network
operating systems, and containerlab builds the virtual wiring and runs the containerised network
OS images those configurations land on — containerlab is a single binary requiring only Docker,
and it supports Nokia SR Linux and SR OS, Cisco XRd/XRv/CSR1000v/Nexus 9000v, Juniper
cRPD/cSRX/vMX/vQFX, Arista, SONiC, Cumulus, VyOS and FRR among others.

<!-- VERIFY: netlab's exact supported-platform list and its current maintainer/licence. The capability claim (topology file in, device configs out, multi-NOS) is confident; the specifics are not checked this pass. -->

This is a genuine correction and it changes one of the brief's claims. The honest revision:

> Topology-to-config exists. What does not exist is topology-to-config for **production security
> configuration**, with findings, with explanation, running client-side. The lab tools generate
> *working* configuration for a *lab*; the difference between that and a production SRX IPsec
> tunnel is precisely the material on all four sides of the field card — host-inbound traffic,
> DPD tuning, MSS clamping, NAT-T, traffic-selector shape, and what fails when each is wrong.

That is a narrower claim than the brief's and a defensible one. It also identifies netlab as the
project whose topology schema is worth reading before `11`'s is finalised, in the same way the
brief nominates Batfish's model vocabulary.

### 2.3 Correction 3 — the brief has no vendor-native category, and that is the biggest omission

Brief §3 surveys open-source tooling and drawing tools. It does not mention Juniper Apstra,
Cisco NSO, Juniper Routing Director, Palo Alto Panorama or Cisco Catalyst Center. For a product
whose thesis is *intent → model → config*, this is a serious gap, because **Apstra is that thesis,
shipped, with a graph database at the centre of it.**

Apstra's operator defines intent through a GUI; that intent becomes the single source of truth
held in a graph database; Apstra generates the device configuration and then continuously
validates the live network against the original design. Blueprints abstract the fabric so the
operator is not configuring box by box, and the abstraction spans vendors.

That is architecturally closer to Fathom than anything in the brief's survey. §7 handles it
properly. The short version of why Fathom still exists after reading Apstra's datasheet: Apstra
is a data-centre fabric product, it costs money, it manages devices, and it does not explain
itself.

### 2.4 Correction 4 — do not repeat brief §2.2's numbers

Brief §2.2 states: *"Published analysis of source-of-truth deployments reports documentation
accuracy falling to roughly 15–30% without automated synchronisation, with data quality problems
implicated in about 22% of automation projects."*

The *argument* is right and it is the foundation of `03`'s non-goal on source of truth: manual
inventory rots, and any design beginning "now model your estate in these forms" inherits that
failure. The *numbers* have the shape of vendor-blog statistics — a wide range with no named
study, and a suspiciously precise percentage attached to a vague population ("automation
projects").

<!-- VERIFY: locate the primary source for both figures. If none exists, they must be removed from all public material and the argument restated qualitatively. -->

**RECOMMENDATION — the project makes the argument without the numbers until a primary source
exists.** "Documentation that must be maintained by hand is not maintained" is an assertion every
network engineer will accept from experience. Attaching an unsourceable statistic to it converts
a credible claim into a checkable one that fails the check, and this project's entire posture is
that its claims survive checking.

---

## 3. The rubric — nine axes, applied to everything

Every entry below is scored on the same axes. The axes are chosen so that Fathom's position is
*legible*, not so that it wins: axes 1, 2, 3 and 8 are where Fathom differs, and axes 4, 5, 6, 7
and 9 are mostly where it loses.

| # | Axis | Values |
|---|---|---|
| A1 | **Direction** | `config→findings`, `intent→config`, `facts stored`, `network→picture`, `question→answer` |
| A2 | **Where it runs** | client / server / SaaS / device |
| A3 | **Data custody** | user holds it / vendor holds it / your server holds it |
| A4 | **Touches devices** | yes / no |
| A5 | **Needs a populated source of truth first** | yes / no |
| A6 | **Deterministic** | same input ⇒ same output, byte for byte |
| A7 | **Explains** | teaches *why*, at more than one depth |
| A8 | **Cost floor** | free / paid / enterprise-negotiated |
| A9 | **Works offline / air-gapped** | yes / no |

A6 needs a word, because it is the axis most readers will skim and it is the one that decides
§9. "Deterministic" here means the conventions' invariant 9: same workspace, same corpus version,
same build ⇒ byte-identical emitted config and byte-identical findings. It is not a
sophistication claim. It is what makes a diff between two runs meaningful, and it is what a
change-approval process implicitly assumes about every tool it trusts.

---

## 4. Verification and analysis

Direction `config→findings`. This is the category Batfish defines.

### 4.1 Batfish

| Axis | |
|---|---|
| A1 | `config→findings` |
| A2 | server, Java, Docker; driven from a Python client |
| A3 | your server |
| A4 | no |
| A5 | no, but needs a config snapshot (§2.1) |
| A6 | yes |
| A7 | **no** |
| A8 | free, Apache-2.0 |
| A9 | yes, if you can run Docker |

**Does:** ingests multi-vendor device configurations, builds a vendor-independent model, and
answers queries against it. Flags referenced-but-undefined and defined-but-unreferenced
structures. Checks settings such as MTU, AAA, NTP and logging. Reconstructs the control plane and
routing table offline so a change can be tested before it is deployed.

**Does not:** tell you what the correct configuration is, or why. It is an oracle for a
configuration you already wrote.

**Why not just use this:** because Batfish answers "is this wrong," and the engineer who does not
know the vocabulary cannot ask it a question. It is also the wrong direction: an engineer
building a first IPsec tunnel has no configuration to feed it. Fathom's relationship is
directionally inverse and the brief has this exactly right. `11` §2 records what was taken from
Batfish's model vocabulary and what was rejected.

**Where Batfish is better than Fathom will ever be:** control-plane simulation. Batfish computes
the resulting RIB and FIB. Fathom does not simulate routing and `03` refuses to.

### 4.2 Forward Networks

| Axis | |
|---|---|
| A1 | `config→findings`, plus `question→answer` over a modelled network |
| A2 | server / SaaS |
| A3 | vendor or your server |
| A4 | collects from devices |
| A5 | no |
| A6 | for the model, yes; the AI layer's answers, no |
| A7 | **no** |
| A8 | enterprise-negotiated |
| A9 | no |

**Does:** builds what it calls a mathematically accurate digital twin of every device, path and
policy across a hybrid network, supports 30+ vendors including the cloud providers, and offers
path search across it. Forward AI sits on the twin and lets users ask questions about network
behaviour and validate changes.

**Does not:** teach, run client-side, or work without collection from the estate.

**Why not just use this:** if you can buy it, and your problem is "what does my existing network
actually do," you should. It is a better answer to that question than Fathom will ever be. It is
not an answer to "I have never built one of these and I need to build one correctly this
afternoon," and it is not available to the engineer whose budget is zero.

### 4.3 IP Fabric, NetBrain, and the rest of the assurance category

Commercial network-assurance platforms in the same broad shape: collect from the estate, model
it, verify intent, visualise paths, produce compliance reports.

<!-- VERIFY: current capability claims for IP Fabric and NetBrain. Not checked this pass. Do not put specifics in public material without checking. -->

**Structural claim, safe to make:** every product in this category requires device access to
collect, runs server-side, and is priced per device or per site. Those three properties define
the category and none of them is negotiable, because the product's value comes from observing the
real estate. They therefore all fail A2, A3, A4 and A8 for Fathom's target user, who is one
engineer with no purchasing authority and a config in a text editor.

### 4.4 The honest summary of §4

**The verification category is well served, well funded, and correct.** Fathom does not compete
with it and should never claim to. What the category does not do — because it is not what it is
for — is help somebody who does not yet have a configuration, and none of it explains its
findings to a reader who does not already understand them.

---

## 5. Source of truth

Direction `facts stored`.

### 5.1 NetBox, Nautobot, Infrahub

| Axis | NetBox | Nautobot | Infrahub |
|---|---|---|---|
| A1 | facts stored | facts stored, + Jobs | facts stored, versioned |
| A2 | server + DB | server + DB | server + DB |
| A3 | your server | your server | your server |
| A4 | no (integrations do) | via Jobs | via integrations |
| A5 | it *is* the source of truth | same | same |
| A6 | yes | yes | yes |
| A7 | no | no | no |
| A8 | free / cloud tiers | free / commercial | free / commercial |
| A9 | yes, self-hosted | yes | yes |

**Does:** NetBox is the default choice for infrastructure documentation. Nautobot forked it and
added Git integration and Jobs as first-class automation primitives, with an app suite covering
config backup, intended-state generation and compliance diffing. Infrahub adds version control
over the data itself, renders configuration from its data via Jinja2 or Python, and now ships an
MCP server so agents can query it.

**Does not:** have opinions. The brief's §6.4 says this exactly right and it is the sharpest
sentence in the brief: these systems store facts and have no view about them. Adding a second SRX
to NetBox produces a second row. It does not produce the observation that these two look like a
cluster candidate and here is what RG0 and RG1 would need.

**Why not just use this:** because the on-ramp is a wall. A source of truth is worth exactly what
was put into it, and putting things into it is the work. §2.4's argument stands even with the
numbers removed. Fathom's answer to the empty-form problem is `config-paste-first` (brief §6.3),
which is a different bet: populate by parsing, not by typing.

**Where they are better:** everything at fleet scale. Multi-writer concurrency, RBAC, API
integration, a plugin ecosystem, and an installed base that means your colleagues already know
it. Brief §6.4 states this trade honestly and `03` §4.2 makes it a permanent non-goal.

**The relationship worth naming:** Fathom should read NetBox, not replace it. An importer that
reads a NetBox export into the graph is a small piece of work with a large payoff, and it
converts the most likely objection — "we already have a source of truth" — into an on-ramp.
`03` §9 records this as in-scope.

---

## 6. Intent-to-config, open source

Direction `intent→config`. This is Fathom's own direction and therefore the category that must
be surveyed hardest.

### 6.1 Nautobot Golden Config

**Does:** aggregates source-of-truth data via GraphQL, combines it with Jinja2 templates to
produce an intended configuration, diffs intended against actual to report compliance, and in
newer versions plans remediation and deploys it.

**Does not:** explain, run client-side, or work without a populated source of truth and Jinja
fluency.

**Why not just use this:** the brief's answer is right — overlapping output, entirely different
premise. Golden Config is a platform for a team who has already done the modelling. It assumes
fleet-scale intent, which is the opposite of the single-task walkthrough in brief §6.2. It is
also the strongest argument against Fathom for any organisation that has already made that
investment, and `03` §8 counts that as forgone revenue rather than pretending it away.

### 6.2 netlab and the lab-topology tools

**Does:** topology file in, working multi-platform device configuration out, wired up and running
under containerlab or a hypervisor. This is the correction in §2.2 and it is the closest existing
thing to "describe what you want, get config."

**Does not:** produce production security configuration, raise security findings, explain, or
model the things that break in production rather than in a lab.

**Why not just use this:** because the generated configuration is deliberately minimal — it is
there to make the lab converge, not to survive a security review. Nothing in a lab topology tool
knows that `host-inbound-traffic system-services ike` is the omission that makes Phase 1 time out
with nothing useful in the log, because in a lab the zone policy is permissive and the failure
never happens.

**Where it is better:** it produces a *running network*. Fathom produces text you paste. For
learning routing protocols, netlab plus containerlab is a better teacher than Fathom will be, and
`03` §4.6 makes not-a-lab a permanent non-goal partly because of it.

### 6.3 The automation libraries — Ansible, Nornir, NAPALM, Netmiko

**Does:** connect to devices and push configuration, with varying degrees of abstraction. Jinja2
templating turns variables into config text; the transport layer delivers it.

**Does not:** decide what the configuration should be, or check that it is safe, or explain it.

**Why not just use this:** they are the transport, not the intent. They also all fail invariant 2
by design — they exist to touch devices. Fathom's relationship to them is deliberate and stated
in `03` §9: emitting an Ansible task file or a Terraform resource block **as text the user
copies** is in scope, because it is an emitter; running it is permanently out of scope.

### 6.4 The config-manipulation libraries — hier_config, ciscoconfparse, netutils

**Does:** parse hierarchical configuration into a tree, diff intended against running, compute
remediation lines, normalise vendor-specific values.

<!-- VERIFY: current maintainers and capability details for hier_config and ciscoconfparse. The category claim is confident; specifics are not checked this pass. -->

**Why they matter to Fathom:** these are the closest prior art to `14`'s parser layer, they are
proven at exactly the job `14` has to do, and they are Python. Reading their handling of
vendor-specific hierarchy quirks before writing the Rust parsers is cheaper than rediscovering
it.

**Why not just use this:** they operate on text and produce text. There is no vendor-neutral
graph in the middle, which means no explainer can attach to them and no cross-vendor question can
be asked. That middle is the entire product.

---

## 7. Vendor-native tooling

*margin tab: why it exists*

The brief has no entry for this category (§2.3). It is the category with the most money in it and
the most architectural overlap.

### 7.1 Juniper Apstra

| Axis | |
|---|---|
| A1 | **`intent→config`, and back** |
| A2 | server |
| A3 | your server |
| A4 | **yes** |
| A5 | it builds one, from the blueprint |
| A6 | yes |
| A7 | **no** |
| A8 | paid, per-device |
| A9 | no |

**Does:** the operator expresses design intent through a GUI; that intent becomes the single
source of truth in Apstra's graph database; Apstra generates the device configuration; and it
then continuously validates the running network against the original intent and reports
deviation. Blueprints abstract the fabric so the work is not box-by-box, and the abstraction
covers multiple vendors.

**Does not:** teach. Cover anything outside the data-centre fabric domain. Run client-side. Work
without device access. Cost nothing.

**Why not just use this:** three reasons, in order of how much they matter.

1. **Domain.** Apstra is a data-centre fabric product. Site-to-site IPsec on a branch SRX pair —
   the field card's entire subject — is not its problem. The two products' domains barely
   intersect.
2. **Premise.** Apstra owns the network. It generates config *and deploys it* and *holds the
   intent*. That is the right design for a fabric you are building from scratch with a budget.
   It is unusable for an engineer with one config, one afternoon, and no purchasing authority.
3. **It does not explain.** The blueprint abstraction is the *opposite* of teaching: it exists so
   that you do not have to know what it generated. Fathom's third pillar is that you finish
   knowing why.

**The architectural lesson to steal:** Apstra put a graph database at the centre and projected
from it, which is brief §4.1 with a different implementation. That a funded product converged on
the same structure is evidence for the bet in `11`, and it is worth citing when the bet is
questioned.

### 7.2 Cisco NSO

**Does:** model-driven service orchestration. YANG gives a declarative, structured way to define
network configuration and operational data; a device abstraction layer uses Network Element
Drivers to mediate access to Cisco infrastructure and over 1,000 third-party device types,
controllers and cloud services; changes commit database-style with pre-implementation checks and
rollback; FASTMAP means a service developer writes only the creation logic and NSO computes the
required changes.

**Does not:** teach, run client-side, or exist outside an enterprise licence.

**Why not just use this:** NSO is the most complete answer in the industry to "turn service
intent into multi-vendor device configuration, transactionally." If your organisation has NSO and
somebody who can write service models, Fathom has nothing to offer that layer. What it does not
touch is the person who has to *understand* the resulting configuration, which is the population
brief §2.1 is about — and NSO's abstraction, like Apstra's, deliberately removes the need to,
which is a virtue for operations and a problem for competence.

**The honest comparative:** NSO is a strictly more capable config-generation engine than Fathom
will ever be. Fathom's claim against it is not capability; it is that NSO is server-side, it
touches devices, it costs money, it requires modelling skill, and it does not explain a single
line it emits.

### 7.3 Juniper Routing Director (formerly Paragon Automation)

**Correction of record:** Paragon Automation has been renamed Routing Director. Any project
material referring to Paragon should be updated.

**Does:** device onboarding with automated validation, imaging, configuration and provisioning;
continuous assurance that validates network performance against objectives and locates and fixes
issues; orchestration that translates intent into services; and continuous trust and compliance
monitoring. AI/ML anomaly detection sits across it.

**Does not:** address the branch-firewall configuration domain, teach, or run without device
access.

**Why not just use this:** it is a WAN service-provider automation platform. Same structural
answer as §7.1 and §7.2: right product, different job, different buyer, no explanation.

### 7.4 Palo Alto Panorama

**Does:** centralised configuration, management and monitoring of Palo Alto firewalls; device
groups and templates for consistent network and device setup; aggregated logging across managed
firewalls for investigation and reporting; role-based delegation of global and local
administration.

**Does not:** cover other vendors. Teach. Run client-side.

**Why not just use this:** Panorama is the correct tool for managing a fleet of PAN-OS firewalls
and it is not optional if you have one. It is single-vendor by construction, which makes it
orthogonal to the cross-vendor vocabulary problem in brief §2.1 — the engineer who knows Panorama
still cannot answer "what is the Junos version of `show vpn ipsec-sa`," and Panorama will never
tell them.

### 7.5 What the vendor-native category proves

Two things, and they point in opposite directions.

| Finding | Direction |
|---|---|
| The `intent → graph → config` architecture is not speculative. Apstra ships it, NSO ships a model-driven variant of it, and both are commercially successful | **For** the bet in `11` |
| Four well-resourced products in this category, and not one of them explains itself | **For** the third pillar being a real gap |
| Every one of them is server-side, device-touching, per-vendor or per-domain, and priced for an enterprise | **For** Fathom's positioning |
| Every one of them is *strictly more capable* within its domain than Fathom will be | **Against** any claim of competition. `03` §4 turns this into refusals |

---

## 8. The model-driven ecosystem

OpenConfig, YANG, gNMI, and the Terraform providers. This is the category where Fathom is doing
a worse version of something that already exists, and saying so plainly is more useful than
justifying it.

### 8.1 What exists

| Thing | What it is |
|---|---|
| **YANG** (RFC 7950) | The data modelling language. Also defines `deviation`, by which a server declares it does not implement a model faithfully |
| **OpenConfig** | Operator-driven, vendor-neutral models, founded by contributors from Google, AT&T, BT and Microsoft. Versioned with a stated semver policy: non-backward-compatible changes require a major bump, and deprecation for at least one minor first |
| **gNMI** | The streaming telemetry and configuration transport over gRPC |
| **Vendor native models** | Still necessary for platform-specific features and for features that ship before the neutral schema catches up — Cisco says so in its own developer material |
| **Terraform providers** | Declarative resource management for Junos, PAN-OS and others, with plan/apply semantics <!-- VERIFY: current provider names, maintainers and coverage. Not checked this pass. --> |

### 8.2 The honest comparison

**Fathom's IR is a worse OpenConfig.** It is authored by one project rather than by an operator
consortium, it covers less, it has no tooling ecosystem, and it will have every one of
OpenConfig's schema-evolution problems with none of its governance. `72` §5 already documents the
deviation problem this inherits.

Three reasons the project does it anyway, and only the third is strong:

1. OpenConfig's coverage is weakest exactly where Fathom starts. Security policy, zones, IPsec
   and firewall semantics are the parts of a network that neutral models model least well and
   that vendors deviate on most. <!-- VERIFY: current OpenConfig coverage for IPsec and security policy specifically. State no specifics publicly without checking. -->
2. YANG is a modelling language for *machine configuration exchange*. Fathom's graph carries
   provenance, explainer bindings and rule attachment points on every node — data that exists to
   serve a human reader, which is not what YANG is for and not something it should be bent to do.
3. **The explainer binding is the reason.** Invariant 7 requires every node, edge and field to
   carry a stable opaque ID that rules, explainers, emitters and diagram elements reference. That
   is a schema decision made for the teaching pillar, and no configuration-exchange model has it,
   because no configuration-exchange model has a teaching pillar.

**RECOMMENDATION — say this in public material rather than avoiding it.** "We built a narrower,
opinionated model because we needed to hang explanations off it, and OpenConfig is not for that"
is a defensible answer. "We built our own model" with no acknowledgement of OpenConfig reads as
ignorance to precisely the audience whose approval matters most.

### 8.3 Why not just use this

Because YANG models describe *what a box can be configured to be*. They do not describe what you
should configure it to be, why, what breaks if you get it wrong, or what to type to check. An
engineer handed the OpenConfig IPsec model and told to build a tunnel is in exactly the position
brief §2.1 describes: all the words are there and none of them is the word they would have
searched for.

---

## 9. The LLM-assisted wave — the direct threat

*margin tab: read this first*

> **THE COMPETITOR THAT ALREADY EXPLAINS THINGS IS ALREADY INSTALLED**

The brief's survey has no entry for this and it is the most consequential omission. `72` §11
treats competitive response as a risk; this section names the specific competitor.

### 9.1 The four shapes it takes

| Shape | Example | Threat level to Fathom |
|---|---|---|
| **(a) A general assistant, used ad hoc** | An engineer pastes a config into a chat window and asks what it does | **Highest.** Free, installed, already habitual, and it explains |
| **(b) MCP servers against live devices** | `Juniper/junos-mcp-server` — Apache-2.0, connects over SSH with password or key auth including via a jumphost, exposes tools to run operational commands, fetch config, show diffs, gather facts, and `load_and_commit_config` to load and commit configuration | Low as a competitor, **high as a contrast** — see §9.4 |
| **(c) MCP servers against a source of truth** | The NetBox MCP server ecosystem, which grew from an experiment in early 2025 into multiple implementations, one with over 140 tools; and the Nautobot MCP server, which translates natural language into operations on a Nautobot instance | Medium. It solves the query half of the vocabulary problem for teams who have an SoT |
| **(d) Vendor AI assistants** | Cisco AI Canvas, in early access from August 2025, with a conversational AI Assistant over a "Cisco Deep Network Model"; Juniper Mist's Marvis, a conversational assistant over telemetry across wired, wireless, WAN and data centre | Medium. Locked to the vendor's estate and telemetry |

### 9.2 Shape (a) is the actual competitor, and it beats Fathom on day one

State this without flinching, because pretending otherwise makes every downstream decision worse.

An engineer with a general assistant in a browser tab can, today, for free:

- paste `show configuration | display set` and get a readable explanation of it;
- ask "how do I check if the tunnel is up" and get `show security ipsec security-associations`;
- ask "what's the Junos version of `show crypto ipsec sa`" and get a correct answer;
- ask why Phase 2 is failing while Phase 1 is up and get PFS mismatch as a candidate.

That is brief §6.1's four query shapes and most of §6.3, available now, with zero setup. **The
command finder's wedge is not undefended.** `16` should be read with this in mind, and `71`'s
phase 0 exit criteria should be read as "is this better than a chat window," not "does this
work."

### 9.3 The three things it does not do — and none of them is intelligence

Fathom's answer cannot be "our answers are better." It probably will not be, on average. The
answer has to be structural, and there are exactly three structural differences:

| # | Difference | Why it matters, concretely |
|---|---|---|
| **1** | **Determinism.** Invariant 9: same workspace, same corpus version, same build ⇒ byte-identical output | You cannot diff two model answers. You cannot review a change whose generation is not reproducible. You cannot put "the assistant said so" in a change record and have it mean anything at the post-incident review. A change-approval process implicitly assumes that the artifact under review is the artifact that will be applied |
| **2** | **Confidentiality.** No egress by default; the config never leaves the machine | Brief §2.4. A network configuration is topology, addressing, trust boundaries and — if the engineer is careless — credentials. The `junos-mcp-server` README says it directly: ensure "your company's policy allows sending data of Junos devices to LLM services." That sentence is Fathom's market |
| **3** | **Provenance.** Invariant 6: emitters return `(line, provenance)` pairs, so every emitted line names the node, the fields and the rules that produced it | When a rule turns out to be wrong, a provenance-carrying tool can answer "which of my configs came from that rule" offline. `74` §10.5 makes that the `DETECTION` line of a security advisory. A chat transcript cannot answer it at all |

**Add a fourth that is weaker but real:** version-specific correctness. Junos syntax differs
meaningfully between 15.x, 21.x and 23.x, and brief §5.2 makes version predicates mandatory for
exactly that reason. A general assistant produces a plausible answer for an unstated release.
This is a weaker argument than the other three because model accuracy is improving and this
project should not bet on a competitor staying wrong.

### 9.4 Shape (b) is the anti-Fathom, and that is useful

`junos-mcp-server` is Apache-2.0, Juniper-maintained, and does exactly what Fathom's invariants
forbid: it authenticates to production devices, it runs operational commands, and
`load_and_commit_config` loads and commits configuration generated by a model. Its own
documentation carries the mitigation as a warning to the human — always review the configuration
the LLM generated and only allow tool execution if it is correct — plus a `block.cfg` pattern
blocklist.

That is a coherent product and it is genuinely useful. It is also the clearest available
statement of the boundary Fathom draws:

| | `junos-mcp-server` | Fathom |
|---|---|---|
| Touches devices | yes, SSH | never (invariant 2) |
| Accepts credentials | yes, passwords and keys | never (invariant 3) |
| Commits configuration | yes | never — output is copy-paste |
| Output reproducible | no | yes (invariant 9) |
| Blast radius of a wrong answer | a committed change on a production box | a wrong paragraph the user reads before pasting |

**The positioning line that falls out of this table:** *the risk of a model being wrong is bounded
by what the tool is allowed to do.* Fathom's AI layer is allowed to do nothing to a device,
because there is no path from the application to a device at all. That is a much stronger safety
argument than any guardrail, and it is available only because of a product decision made before
the AI layer existed. `21` §§7–9 specifies it.

### 9.5 What happens when the models get good enough

The honest scenario, and the one `71` §12 should carry as a kill point.

Assume a model that answers network questions correctly 99% of the time, with an MCP server that
can read a config from a device and hand it back explained. What survives?

| Fathom property | Survives? | Why |
|---|---|---|
| Determinism | **yes** | Not an accuracy property. A 100%-accurate non-deterministic tool still cannot be diffed or reviewed |
| Confidentiality | **yes** | Not an accuracy property either. Air-gapped, defence, OT and regulated environments do not gain a network connection because the model improved |
| Provenance | **yes** | Structural |
| Explanation quality | **at risk** | This is the property most exposed. `design-language.md` argues the card's voice "is not reliably achievable by a language model improvising at runtime," and that argument has a shelf life |
| The command finder wedge | **at serious risk** | §9.2 |
| Version-specific correctness | **at risk** | §9.3, footnote |

Two of six at serious risk, and one of those two is the wedge that `71` phase 0 depends on. The
1% is the counter-argument and it must be stated in the form that survives scrutiny: **the 1% is
not evenly distributed.** It concentrates on the unusual, the version-specific and the
security-relevant — which is precisely the population of changes where being wrong is
`Disruptive` rather than annoying. The field card's own catalogue of things that bite is a list
of exactly this population: a missing `host-inbound-traffic system-services ike` that times out
Phase 1 with no local clue; a source-NAT rule that quietly eats tunnel traffic; a default
selector of `0.0.0.0/0` that a peer building one SA per subnet pair rejects outright. These are
not obscure. They are common, they are silent, and they are the residue an averagely-good answer
leaves behind.

**But that argument is a hypothesis, not a defence.** `25` (AI evaluation) is where it becomes
measurable, and if it cannot be measured it should not be repeated.

---

## 10. Teaching, labs and reference

The third pillar's competitive set, which the brief does not survey at all.

| Thing | Does | Does not | Why not just use this |
|---|---|---|---|
| **Vendor certification tracks** (JNCIA/JNCIS, CCNA/CCNP, PCNSE) | Teach a curriculum, thoroughly, with a credential | Help at 2am with a specific tunnel. Curriculum order is not troubleshooting order | Fathom is a reference used *during* work, not a course taken before it. `03` §4.7 makes not-a-trainer a non-goal |
| **Training video and lab courses** | Teach well, and are how most engineers actually learn | Are not searchable at the moment of need, and are not a reference | Same |
| **GNS3, EVE-NG, Cisco Packet Tracer, containerlab** | Give a running network to break, which is the best teacher there is | Explain a specific production configuration, or generate one that survives a security review | §6.2. Genuinely better for learning protocol behaviour |
| **ipSpace and similar practitioner writing** | Explain *why*, at depth, in a voice close to the field card's | Are prose, not a tool. Cannot interpolate your VPN name into a command | The closest thing to Fathom's Teaching depth that exists, and the best available quality bar |
| **explainshell** | Paste a shell command, get per-token explanation from the manual pages | Cover network device CLIs, or anything beyond a single command line | **The closest UX analogue to brief §6.3's reverse explanation.** Worth studying for interaction design specifically <!-- VERIFY: explainshell's current status and licence. --> |
| **Vendor documentation** | Is authoritative, complete, and free | Is organised by command rather than by question, which brief §2.1 identifies as the whole problem | This is the gap the product exists to close |
| **Printed field cards, including the owner's** | Dense, glanceable, present at the desk, and legible with no power | Do not interpolate context, cannot be searched, and go stale silently | Fathom is the card, made searchable and context-aware — and `design-language.md` makes the card the design constraint rather than the inspiration |

**The last row is the project's real origin and it should be said in public material.** The field
card already works. The product is the argument that it should work for more than one vendor, one
domain and one printing.

---

## 11. The landscape table, rebuilt

The brief's §3.5 table with the missing categories added and the rubric applied. `∼` means
partially, with the qualification in the referenced section.

| Tool | Direction | Runs | Custody | Touches devices | Needs SoT | Deterministic | Teaches | Cost floor | Offline |
|---|---|---|---|---|---|---|---|---|---|
| Batfish | config → findings | server | yours | no | no | yes | no | free | yes |
| Forward Networks | config → findings, query | server/SaaS | vendor/yours | collects | no | ∼ §4.2 | no | enterprise | no |
| IP Fabric / NetBrain | config → findings | server | yours | collects | no | ∼ | no | enterprise | no |
| NetBox / Nautobot | facts stored | server+DB | yours | no | it is one | yes | no | free | yes |
| Infrahub | facts stored, versioned | server+DB | yours | no | it is one | yes | no | free | yes |
| Nautobot Golden Config | SoT → config | server+DB | yours | via Jobs | **yes** | yes | no | free | yes |
| netlab + containerlab | topology → lab config | local | yours | builds them | no | yes | ∼ §6.2 | free | yes |
| Ansible / Nornir / NAPALM | intent → device | local/server | yours | **yes** | no | ∼ | no | free | yes |
| hier_config / ciscoconfparse | config → config | local | yours | no | no | yes | no | free | yes |
| **Juniper Apstra** | **intent → config → validate** | server | yours | **yes** | builds one | yes | **no** | paid | no |
| **Cisco NSO** | **service intent → config** | server | yours | **yes** | models it | yes | **no** | enterprise | no |
| **Juniper Routing Director** | intent → services, assurance | server | yours | **yes** | no | ∼ | no | enterprise | no |
| **Palo Alto Panorama** | central policy → firewalls | server | yours | **yes** | no | yes | no | paid | no |
| **OpenConfig / YANG / gNMI** | schema + transport | n/a | n/a | transport does | n/a | yes | no | free | yes |
| **General LLM assistant** | question → answer | SaaS | **vendor** | no | no | **no** | **∼ yes** | free | **no** |
| **`junos-mcp-server`** | intent → committed config | local + device | yours | **yes** | no | **no** | no | free | ∼ |
| **NetBox / Nautobot MCP** | question → SoT answer | local + server | yours | no | **yes** | **no** | no | free | ∼ |
| **Cisco AI Canvas, Marvis** | question → answer over telemetry | SaaS | vendor | collects | no | **no** | ∼ | enterprise | no |
| draw.io / Dia | human → picture | client | yours | no | no | yes | no | free | yes |
| Certification and lab courses | curriculum → competence | n/a | n/a | no | no | n/a | **yes** | varies | ∼ |
| **Fathom** | **intent ⇄ config, explained** | **client** | **user, encrypted** | **never** | **no** | **yes** | **yes** | **free** | **yes** |

**Read the Fathom row as a set of refusals, not features.** Six of its ten cells are things it
does *not* do, and `03` is the document that makes each of them testable.

### 11.1 The gap, restated more narrowly than the brief states it

The brief says: *"Guided, single-task configuration construction with inline security reasoning,
running entirely client-side, does not exist in open source."*

After this survey that claim survives, with two qualifications that make it weaker and true:

1. **"in open source" is doing real work.** Apstra and NSO do guided intent-to-config with
   validation. They are commercial, server-side, device-touching and domain-specific, and they do
   not explain — but a reader who hears "does not exist" and then sees an Apstra demo will
   conclude the survey was dishonest.
2. **"with explanation" is the load-bearing clause, and it is now contested.** A general LLM
   assistant explains. It does so non-deterministically, without provenance, and by sending the
   configuration to a third party — which is why the gap is still real — but the sentence
   "nothing explains" was true when the brief was written and is not true now.

**The revised claim, which the project should use:** *deterministic, provenance-carrying,
offline, single-task security configuration construction with inline findings and layered
explanation does not exist anywhere, at any price.* Longer, uglier, and it holds.

---

## 12. "Why not just use X" — the four answers that must survive contact

These are the four objections a real evaluator raises. Each answer is written to be said out
loud, and each names what the objector gets by ignoring it.

### 12.1 "Why not just ask an LLM?"

*Because you cannot diff its answer, you cannot reproduce it, you cannot tell it what your
configuration says without telling somebody else, and when a recommendation turns out to be wrong
you cannot find out which of your devices got it.* Fathom is worse than an LLM at answering an
unfamiliar question the first time, and better at every subsequent step: reproducing, reviewing,
recording and retracting.

**What you give up by ignoring this:** flexibility at the edges. The LLM will answer questions
Fathom's corpus has never heard of, and Fathom will say it does not know. See `16`'s `NoHit`
behaviour, which is designed to say so rather than to guess.

### 12.2 "Why not just use Batfish?"

*Because Batfish tells you a configuration is wrong and Fathom tells you what right looks like
and why.* They are opposite directions and both are worth having. The correct answer is often
"use both": Fathom to build it, Batfish to verify the snapshot afterwards.

**What you give up:** control-plane simulation, which Fathom does not do and refuses to (`03`).

### 12.3 "We already have NetBox / Nautobot / a source of truth."

*Then keep it, and import from it.* Fathom is not competing for the system-of-record role and
`03` §4.2 makes that a permanent non-goal. What Fathom adds to an organisation that already has a
populated source of truth is the part that source of truth structurally does not do: have an
opinion, explain a line, and produce the verification ladder for a specific change.

**What you give up:** nothing, which is why this is the objection that converts best.

### 12.4 "We have Apstra / NSO / Panorama."

*Then you have a better config generator than this project will build, for the domain it covers.*
Fathom's claim is orthogonal: it covers the domains those products do not, it costs nothing to
try, it runs on the laptop of an engineer with no licence, and it explains what it produces to
somebody who has to defend it in a change review.

**What you give up:** deployment. Those products push config; Fathom hands you text. If your
problem is scale of application rather than correctness of design, Fathom is the wrong tool and
`03` §4.4 says so permanently.

---

## 13. Where Fathom is worse

*margin tab: read this first*

The section that makes the rest credible.

| Compared with | Fathom is worse at | By how much |
|---|---|---|
| Batfish | Control-plane and data-plane simulation; whole-network reachability reasoning | Categorically. Fathom does not do it at all |
| Forward Networks | Knowing what the network actually is right now | Categorically. Fathom never looks |
| NetBox / Nautobot | Fleet-scale storage, multi-writer concurrency, RBAC, integrations, ecosystem | Brief §6.4 states the trade. Above a few thousand devices it stops being a good trade |
| Nautobot Golden Config | Compliance diffing at fleet scale, and deployment | Categorically |
| Apstra / NSO | Depth of config generation within their domain; transactional deploy with rollback on the box | Substantially. They have had years and teams |
| netlab + containerlab | Producing a *running* network to learn on | Categorically |
| Ansible / Nornir | Actually applying anything | By design, permanently |
| A general LLM assistant | Answering a question the corpus has never seen; breadth; day-one usefulness with zero content investment | Substantially, and this is the uncomfortable one |
| Vendor documentation | Completeness and authority | Categorically. Fathom will cover a fraction of a fraction |
| A certification course | Building foundational competence from nothing | Categorically |
| Every commercial product listed | Support, SLA, indemnity, a procurement path, and somebody to shout at | Categorically, and this blocks enterprise purchase entirely — `36` |

**The pattern.** Fathom is worse than every incumbent at the thing that incumbent exists to do.
Its position depends entirely on the claim that the *combination* — client-side, explained,
deterministic, no device contact, free — is worth more to a specific user than any single
incumbent's depth. The brief's §4.2 asserts that the three pillars are non-negotiable together,
and this table is the reason: any two of them without the third is a product that already exists
and is better funded.

---

## 14. The positioning statement

### 14.1 Long form, for this repository

Fathom is a client-side network engineering tool for the engineer who has to build, understand
or defend one configuration, on a machine that must not send it anywhere. It projects a single
typed graph into a diagram, a configuration, a set of findings, an explanation, a verification
ladder and an inventory. It never touches a device, never accepts a credential and never opens a
connection the user did not configure. Its output is deterministic and carries provenance from
the graph node that produced it, which is what makes it reviewable. Its explanations are
human-authored and reviewed, which is what makes them trustworthy at a depth a runtime model
cannot commit to.

### 14.2 Short form — the three sentences allowed in public material

> One graph, six views: diagram, config, findings, explanation, verification, inventory.
>
> It runs in your browser, it never touches a device, and nothing leaves the machine.
>
> Every line it emits knows which rule produced it and can tell you why.

Nothing else. No adjectives, no comparatives, no "powerful," no "seamless." The
`design-language.md` voice rules apply to marketing copy with no exemption, and the third
sentence is the only differentiator that no competitor in §11 can claim.

### 14.3 What must never be claimed

| Never say | Because |
|---|---|
| "The first tool to do X" | §2.3 and §7 |
| "Nothing else explains network configuration" | §9.2. It was true in July 2026 and it is not true now |
| "Replaces your source of truth" | `03` §4.2, and it is the fastest way to lose an evaluation |
| "AI-powered" | The AI layer is quarantined behind a boundary and labelled in the UI (invariant 9). Leading with it inverts the product's actual claim |
| "Secure" as an adjective | `36`. Claims are specific, testable and enumerated, or they are not made |
| Any figure from brief §2.2 | §2.4 |

---

## 15. What would falsify this

Leading indicators, per `72` §1.1's rule that a risk with no leading indicator is a feeling.

| # | If this happens | The positioning that dies | Watch |
|---|---|---|---|
| F1 | Apstra, NSO or a successor ships a per-line explainer with depth levels | The teaching gap in §7.5 | Vendor release notes, annually |
| F2 | A general assistant plus a local model achieves reproducible, provenance-carrying config generation that a change process accepts | §9.3's differences 1 and 3, which are the load-bearing ones | Continuous. This is the one to actually watch |
| F3 | An open-source project ships client-side, offline, guided security-config construction | §11.1 entirely | Quarterly search |
| F4 | Vendor documentation reorganises around questions rather than commands | Brief §2.1, the founding premise | Unlikely, high impact |
| F5 | A vendor asserts copyright over corpus-style explanation of their syntax | The corpus's viability — `74` §7 | On first contact |
| F6 | Enterprise policy normalises sending configurations to model providers | §9.3's difference 2, and with it brief §2.4's structural market | Watch regulated sectors specifically; they will be last |

**F2 is the one that matters** and it is not a distant scenario. `71` §12 should carry it as an
explicit kill point with a named review date rather than as a background worry.

### 15.1 Re-check cadence

**DECISION — this document is re-verified every six months, and every `<!-- VERIFY -->` marker is
either resolved or the claim is deleted.** A survey nobody re-runs becomes the project's most
confidently wrong document within a year, and it is the document most likely to be quoted
outward.

---

## 16. Sources consulted

| Claim | Source |
|---|---|
| Batfish: Apache-2.0, AWS-managed since the Intentionet team joined AWS; finds bugs in planned or current configurations; research lineage recognised with the 2025 ACM SIGCOMM Networking Systems Award | [batfish/batfish on GitHub](https://github.com/batfish/batfish); [UCLA CS, *Millstein and collaborators win 2025 ACM SIGCOMM Networking Systems Award*](https://www.cs.ucla.edu/professor-todd-millstein-and-collaborators-win-2025-acm-sigcomm-networking-systems-award-for-batfish/) |
| Forward Networks: digital twin of every device, path and policy; 30+ vendors including AWS, Azure and Google Cloud; path search; Forward AI over the twin | [forwardnetworks.com](https://www.forwardnetworks.com/) |
| Juniper Apstra: intent defined through a GUI becomes the single source of truth in a graph database; blueprints abstract the fabric rather than box-by-box config; continuous validation against intent; multivendor | [Juniper, *Apstra architecture* white paper](https://www.juniper.net/content/dam/www/assets/white-papers/us/en/2023/juniper-apstra-architecture.pdf); [Juniper Apstra 4.0 blog](https://blogs.juniper.net/en-us/enterprise-cloud-and-transformation/juniper-apstra-4-0-the-next-level-of-open-intent-based-networking-for-everyday-data-center-automation) |
| Cisco NSO: model-based approach using YANG; NED device abstraction over 1,000+ third-party device types, controllers and cloud services; database-style commit with pre-checks and rollback; FASTMAP | [Cisco NSO data sheet](https://www.cisco.com/c/en/us/products/collateral/cloud-systems-management/network-services-orchestrator/datasheet-c78-734576.html) |
| Juniper Paragon Automation renamed Routing Director; onboarding, assurance, orchestration, trust and compliance; AI/ML anomaly detection | [Juniper Routing Director product page](https://www.juniper.net/us/en/products/network-automation/paragon-automation.html) |
| Panorama: centralised configuration, management and monitoring of Palo Alto firewalls; templates and device groups; aggregated logging; RBAC delegation | [Palo Alto Networks, *About Panorama*](https://docs.paloaltonetworks.com/panorama/11-1/panorama-admin/panorama-overview/about-panorama) |
| `junos-mcp-server`: Apache-2.0, Juniper-maintained; SSH with password or key auth including ProxyCommand; tools for operational commands, config retrieval, diffs, facts, `add_device`, and `load_and_commit_config`; `block.cfg` blocklist; the review-before-execute warning and the company-policy caution | [Juniper/junos-mcp-server](https://github.com/Juniper/junos-mcp-server) |
| NetBox MCP server ecosystem grew from an early-2025 experiment to multiple implementations, one with 140+ tools; Nautobot MCP server translates natural language into Nautobot operations; NetBox and Nautobot APIs have diverged so servers are not interchangeable | [NetBox Labs, *NetBox MCP Server*](https://netboxlabs.com/blog/netbox-mcp-server-tools-context-management-ecosystem/); [Nautobot MCP Server docs](https://docs.nautobot.com/projects/nautobot-mcp-server/en/stable/) |
| Cisco AI Canvas: conversational AI Assistant over a Cisco Deep Network Model; early access from August 2025 | [WWT, *Cisco AI Canvas*](https://www.wwt.com/blog/cisco-ai-canvas-transforming-it-operations-with-generative-ai-and-agenticops); [Cisco newsroom, June 2025](https://newsroom.cisco.com/c/r/newsroom/en/us/a/y2025/m06/cisco-powers-secure-infrastructure-for-the-ai-era.html) |
| Marvis: conversational AI assistant analysing telemetry across wired, wireless, WAN and data centre | [Juniper, *Marvis AI Assistant datasheet*](https://www.juniper.net/us/en/products/cloud-services/marvis-ai-assistant-datasheet.html) |
| containerlab: single binary, requires Docker, builds virtual wiring between containerised NOS images; supported images across Nokia, Cisco, Juniper, Arista, SONiC, Cumulus, VyOS, FRR | [containerlab.dev](https://containerlab.dev/) |
| YANG, `deviation`, and the model-versioning discipline; OpenConfig's operator-driven origin and semver policy; vendors' continued need for native models | [RFC 7950](https://www.rfc-editor.org/rfc/rfc7950.html); [OpenConfig FAQ](https://www.openconfig.net/docs/faqs/faq/); [OpenConfig versioning guide](https://www.openconfig.net/docs/guides/semver/); [Cisco, *Why so many YANG models?*](https://blogs.cisco.com/developer/which-yang-model-to-use) |
| Infrahub ships an MCP server; renders configuration from its data via Jinja2 or Python | [opsmill/infrahub](https://github.com/opsmill/infrahub) |
| Every failure mode, command and worked example used to argue §9.5 and §10 | `.context/field-card-srx-ipsec.txt`, sides 1–4 |
| The brief's §3 survey, the landscape table it extends, and §§2.1–2.4 | `.context/owner-brief.md` |
| Hard invariants 2, 3, 6, 7, 9; the `Risk` enum; terminology | `.context/conventions.md` |
| What was taken from and rejected of Batfish's model vocabulary | `docs/10-core/11-ir-schema.md` §2 |
| The AI boundary, the egress statement, and what the boundary costs | `docs/20-ai/21-ai-layer-architecture.md` §§5, 7–9 |
| The content problem; competitive response | `docs/70-ops/72-risks.md` §§4, 11 |
| What a permissive licence hands a competitor, and what blunts it | `docs/70-ops/74-governance-and-licensing.md` §5.2 |

---

## 17. Disagreements

**1. No hard invariant, terminology entry, or the risk enum is disputed.** The `Risk` enum appears
only in §9.5, describing what a wrong answer does to a box.

**2. A proposed correction to the brief, §2.2 above.** Brief §3.4 states that no tool in the
diagram-and-discovery category derives configuration from topology. Topology-to-config generation
exists and is mature in the lab-tooling category, which the brief does not survey. The claim
should be narrowed to production security configuration with findings and explanation, and
netlab's topology schema should join Batfish's model vocabulary on the list of prior art to read
before `11` is finalised.

**3. A proposed correction to the brief, §2.3 above.** Brief §3 has no vendor-native category.
Apstra in particular is architecturally the closest existing product to Fathom's own thesis — a
graph at the centre, projections out of it — and its absence from the survey is the kind of gap
that costs credibility in an evaluation. §7 supplies the category; the brief's §3 should adopt
it.

**4. A proposed deletion from the brief, §2.4 above.** Brief §2.2's "15–30%" and "about 22%"
figures have no traceable primary source in this pass. The conventions forbid fabricating a
benchmark or a statistic, and repeating an unsourced one in public material is the same failure
one step removed. The argument should be made qualitatively until a source is found.

**5. A proposed weakening of a claim in the brief, §11.1 above.** Brief §3.5 concludes "the gap is
real" on the basis that nothing client-side explains. Since the brief was written, general
assistants explain network configuration adequately and are free and already installed. The gap
survives, but only when stated as *deterministic, provenance-carrying, offline* construction with
layered explanation. The shorter claim is now false and should not be used.
