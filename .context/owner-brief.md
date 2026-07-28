# Owner brief — verbatim source document

This is the project owner's own architecture note, reproduced as supplied. It is the
authority. Where anything produced by this project contradicts it, this document wins
unless the contradiction is called out explicitly as a **proposed change** with reasoning.

> **Transmission note:** the supplied text terminates mid-sentence inside §7.1
> ("Compromised browser | Defensive code runs i…"). Sections 7.2–14 were referenced by
> the document's own table of contents ("Section 7 is the security architecture…
> Section 8 is the stack… Sections 11–14 are the honest assessment") but were not
> received. Those sections are **reconstructed** by this project and are marked as such.

---

# Project Fathom — Architecture & Vision

**Status:** Planning. No code written. Nothing here is committed.
**Working codename:** *Fathom* — a depth measurement, and also "to understand." Placeholder; rename freely.
**Audience:** the project owner, and Claude Code as an implementation agent.
**Last revised:** July 2026

## How to read this document

Sections 1–6 are the product. Section 7 is the security architecture and is the section most likely to be argued with in an enterprise review — it is written defensively on purpose. Section 8 is the stack, including an explicit answer to the "no Node.js at runtime" constraint. Sections 11–14 are the honest assessment: what's likely to go wrong, and what to decide before writing code.

Anything marked **DECISION** is a fork that needs an answer before implementation and is expensive to change later. Anything marked **RECOMMENDATION** is my opinion and you should feel free to overrule it.

## 1. Executive summary

Fathom is a **security-first, client-side network engineering tool** built on a single idea:

> **One graph, six views.**

A typed graph models the network — devices, interfaces, links, zones, tunnels, policies, routes. Everything the product does is a projection of that one structure:

```
diagram   = render(graph)
config    = emit(graph, vendor)
findings  = lint(graph)
lesson    = explain(node, depth)
runbook   = verify(diff(graph))
inventory = table(graph)
```

Six features, one data structure. This is not an inventory tool bolted to a config generator bolted to a diagram editor. It is one model with six renderers, which is what makes the teaching pillar possible: the explainer and the emitter read the same node, so every generated line of config already knows what produced it.

**Three pillars, equally weighted:**

1. **Validate** — build a config correctly, with security findings inline as you go.
2. **Map** — model the estate; the diagram is a view over the model, not the model itself.
3. **Teach** — the user should finish knowing *why*, not just *what*. This is a first-class constraint, not a documentation afterthought.

**Security posture:** zero-knowledge. The server stores ciphertext and metadata and never holds a key. The application never touches a network device — output is copy-paste, always. Deployable as a single offline file, a Docker single-node, or a load-balanced enterprise cluster, from one codebase.

**Stack:** Rust core compiled to WASM for the browser and native for a CLI; thin TypeScript UI; Rust (Axum) sync service. Node.js appears in the build pipeline only, and can be eliminated entirely if desired (§8.6).

## 2. Problem statement

### 2.1 The vocabulary gap

The hardest part of operating a multi-vendor network is not that the commands are difficult. It is that *you cannot search for something when you do not know what it is called*. "How do I check if the tunnel is up" contains none of the words in `show security ipsec security-associations`. Vendor documentation is organised by command, not by question, so it only helps people who already know the answer.

This compounds across vendors. The same concept has four names (`ae` / `port-channel` / `bond` / LAG), and things that look alike are not alike — a Juniper `reth` sits next to a LAG in interface listings and is not aggregation at all.

### 2.2 Documentation rots

Source-of-truth systems fail on data entry discipline rather than on tooling. Published analysis of source-of-truth deployments reports documentation accuracy falling to roughly 15–30% without automated synchronisation, with data quality problems implicated in about 22% of automation projects. Any design that begins with "now model your entire estate in these forms" inherits that failure mode.

### 2.3 Tools exist, but none teach

There is good tooling in adjacent spaces (§3). None of it explains itself. Batfish will tell you a configuration is wrong; it will not tell you why the correct version is correct. Nautobot will generate a config; it assumes you already knew what you wanted. Nothing in the open-source landscape treats *understanding* as the deliverable.

### 2.4 The confidentiality problem

Network configurations are among the most sensitive artifacts an organisation holds — topology, addressing, trust boundaries, credentials. Engineers routinely paste them into web tools with no defined data handling. A tool that is genuinely trustworthy with this material, verifiably, has a market that SaaS competitors structurally cannot serve (air-gapped, defence, OT, regulated).

## 3. Prior art

Researched July 2026. This section exists so the project can honestly answer "why not just use X."

### 3.1 Batfish

Open source, Apache 2.0, originally from Microsoft Research / UCLA / USC, later maintained by Intentionet, and an AWS-managed project since that team joined AWS. It ingests device configurations and builds a vendor-independent model, then answers queries against it, requiring no access to the devices themselves. It flags structures that are referenced but undefined or defined but unreferenced, and checks settings such as MTU, AAA, NTP and logging. It can reconstruct the control plane and routing table offline so changes can be tested before deployment.

**Relationship to Fathom:** directionally inverse. Batfish is `config → model → findings`. Fathom is `intent → model → config`. Its vendor-neutral model vocabulary is the single best reference available for the Fathom IR and should be studied closely before the schema is written. It runs as a Java service in Docker and does not teach.

### 3.2 Nautobot Golden Config

The closest existing thing to intent-to-config. It aggregates source-of-truth data via GraphQL, combines it with Jinja2 templates to produce an intended configuration, and diffs intended against actual to report compliance. Newer versions add remediation planning and deployment.

**Relationship to Fathom:** overlapping output, entirely different premise. Golden Config assumes a populated source of truth, Jinja fluency, and fleet-scale intent. It is a platform for teams who have already done the modelling work. It is server-side and database-backed, and it does not explain.

### 3.3 NetBox / Nautobot / Infrahub

The source-of-truth category. NetBox is the default choice for infrastructure documentation; Nautobot forked it and added Git integration and Jobs as first-class automation primitives, plus an app suite covering config backup, intended-state generation and compliance diffing.

**Relationship to Fathom:** Fathom needs an inventory, and this is the category it lives in. The critical difference is stated in §6.4 — these systems store facts and have no opinions about them.

### 3.4 Diagram and discovery tools

A crowded, mature category: SNMP/LLDP discovery and visualisation (Netdot, OpenWISP Network Topology, various map generators), and pure drawing tools (draw.io, Dia, Networkmaps). All of them either *discover* topology from a live network or let you *draw* it. None derive configuration from it.

### 3.5 Landscape summary

| Tool | Direction | Storage | Teaches? | Runs client-side? |
|---|---|---|---|---|
| Batfish | config → findings | server, Docker | no | no |
| Nautobot Golden Config | SoT → config | server + DB | no | no |
| NetBox / Nautobot | facts, stored | server + DB | no | no |
| Netdot / discovery tools | network → diagram | server + DB | no | no |
| draw.io / Dia | human → picture | varies | no | yes |
| **Fathom** | **intent ⇄ config, with explanation** | **client, encrypted** | **yes** | **yes** |

**The gap is real.** Guided, single-task configuration construction with inline security reasoning, running entirely client-side, does not exist in open source. That is a defensible reason to build.

**The gap is also a warning.** Several well-funded teams have built pieces of this. The reason nobody has built the whole thing is not that nobody thought of it — it is §11.2.

## 4. Product thesis

### 4.1 One graph, six views

The graph is the product. Everything else is a rendering.

This has three consequences that are worth stating explicitly because they drive most of the architecture:

1. **The diagram cannot be the data structure.** A line between two boxes does not say whether it is an L2 trunk, an L3 point-to-point, an LACP member link or a tunnel. Build diagram-first and you will bolt properties onto edges until you have an accidental, undocumented data model. Build model-first and the diagram becomes one editor among several.
2. **Teaching is structural, not additive.** Because explainers and emitters read the same node, "click any line of config to learn what it does" is a consequence of the architecture rather than a feature that has to be maintained separately.
3. **Views compose for free.** "Show me the verification commands for the change I just made" is `verify(diff(graph))`. It requires no new subsystem.

### 4.2 The three pillars are non-negotiable together

A tool that only validates is a linter. A tool that only maps is NetBox. A tool that only teaches is a book. The combination is the product — and specifically, the teaching pillar is what makes the other two adoptable, because it converts every interaction into a reason to trust the output.

## 5. Core concepts

### 5.1 The graph / intermediate representation (IR)

A vendor-neutral typed graph. Nodes carry a kind, a set of typed fields, and provenance (entered by hand / parsed from config / inferred).

Illustrative, not final:

```
Site ─┬─ Device ─┬─ Interface ─┬─ LogicalUnit ─┬─ Address
      │          │             └─ Membership   └─ ZoneBinding
      │          ├─ RedundancyGroup
      │          ├─ RoutingInstance ── Route
      │          └─ Zone ── Policy ── {AddressObject, Application}
      ├─ Link (physical)
      └─ Tunnel ─┬─ IkeGateway ── IkeProposal
                 └─ IpsecVpn ─┬─ IpsecProposal
                              ├─ TrafficSelector
                              └─ Binding → LogicalUnit
```

**This schema is the entire bet of the project.** See §11.1.

**RECOMMENDATION:** every node and field carries a stable ID. Rules, explainers, emitters and diagram elements all reference IDs, never paths. Renaming a device must not invalidate a rule.

### 5.2 Rule packs

Findings are **data, not code**. A rule is a declarative document with a platform predicate, a version predicate, a severity, an explanation, a remediation, sources, and — critically — a *when this is acceptable* field.

```yaml
id: ipsec.pfs.absent
severity: high
applies_to: { kind: IpsecPolicy }
platforms: [junos-srx, panos, ios]
versions: "*"
condition: "perfect_forward_secrecy == null"
title: "Perfect Forward Secrecy is not configured"
why: >
  Without PFS, Phase 2 keys derive from Phase 1 key material. One
  compromised IKE SA secret unlocks every data key derived under it,
  including previously recorded traffic.
symptom_if_mismatched: >
  PFS on one side and absent on the other fails Phase 2 while Phase 1
  stays up — "IKE looks fine but the tunnel keeps dropping."
remediation:
  junos-srx: "set security ipsec policy {{policy}} perfect-forward-secrecy keys group14"
acceptable_when: >
  Interoperating with a peer that cannot support it. Document the
  exception and compensate with shorter Phase 2 lifetimes.
sources: [ "RFC 7296 §1.3.2" ]
```

**RECOMMENDATION — the `acceptable_when` field is mandatory on every rule.** Tools that flag everything as critical are muted within a week. This one field is the difference between a linter engineers trust and one they disable.

**RECOMMENDATION — no per-vendor engines.** There is no "Palo security engine." There is one rule engine and rules carry a `platforms` predicate. `N` vendors × `M` domains grows linearly, not quadratically.

**Version predicates are not optional.** Junos syntax differs meaningfully between 15.x, 21.x and 23.x. A rule that is correct on one and wrong on another is worse than no rule. See §11.3.

### 5.3 Emitters and provenance

**DECISION — emitters return `(line, provenance)` pairs, never strings.** Every generated line carries the IR node and field that produced it, plus any rule that touched it.

```rust
struct EmittedLine {
    text: String,
    source_node: NodeId,
    source_fields: Vec<FieldRef>,
    rules_applied: Vec<RuleId>,
    risk: Risk,          // ReadOnly | ChangesConfig | Disruptive
    order_hint: u32,
}
```

If emitters return strings, explanation gets bolted on afterwards and the emitters get rewritten. This costs almost nothing on day one and is expensive to retrofit.

`risk` maps to the same three-colour legend used in the existing printed field cards. Consistency between paper reference and tool is worth more than it appears.

### 5.4 Explainers and depth

Three depths, user-toggled globally and per-block:

| Depth | Audience | Content |
|---|---|---|
| **Terse** | knows the platform | commands only, findings as one-line flags |
| **Explained** | knows networking, new to this vendor | why each block exists, what to read in output |
| **Teaching** | ramping in | analogies, background, failure modes, counterfactuals |

Same corpus, three densities. This is what lets one tool serve both the senior engineer and the new hire — and it is the difference between something a team adopts and something only juniors open.

## 6. The features

### 6.1 Command finder — the wedge

**Build this first.** It is a few days of work on top of a corpus that already exists, and it is the feature people open ten times a day.

Four query shapes, all needed:

| Query | Example | Mechanism |
|---|---|---|
| Intent → command | "check if a tunnel is up" | match against `answers` field |
| Half-remembered syntax | "show security ike... something" | fuzzy/prefix match on command tree |
| Cross-vendor | "Junos version of `show crypto ipsec sa`" | Rosetta mapping |
| Reverse | paste a command, what does it do | explainer corpus, backwards |

Each entry:

```yaml
cmd: show security ipsec security-associations
vendor: junos-srx
phase: ipsec
intent: [tunnel-up, phase2-state, verify-vpn]
answers: "Is Phase 2 installed and passing traffic?"
risk: read-only
read_field: "State — want Installed"
next_if_bad: [ipsec.inactive-tunnels]
related: [ipsec.statistics, ike.sa]
rosetta: { panos: "show vpn ipsec-sa", ios: "show crypto ipsec sa" }
```

**The `answers` field is the one that matters.** Matching against the question a command answers, rather than the command text, is what closes the vocabulary gap.

**Two upgrades nothing else offers:**

- **Context awareness.** With a workspace open, results interpolate real values — `...vpn-name VPN-DC-EAST detail`, paste-ready. The difference between a lookup and an answer.
- **Answer-shaped results.** Return the command, *plus what to read in the output*, *plus the next command if it's bad*. The verify ladder is already a directed graph of "if this, then that."

Must be a single keystroke (`Ctrl+K`) from anywhere. If it is slower than opening a browser tab, it will not be used.

Deterministic — fuzzy matching plus a synonym map, no model at runtime. Works offline, identical every run, diffable between releases.

**Strategically this is the on-ramp.** Nobody adopts a network modelling platform on a Tuesday afternoon. Everybody uses a fast command finder immediately — zero setup, zero data entry, zero trust required, because it is read-only reference content needing none of the crypto, none of the server, none of the graph. Every result then carries a link into the guidebook ("why does this work") and into the walkthrough ("build this properly").

### 6.2 Guided walkthroughs

The flagship interaction. Pick a task (site-to-site IPsec on SRX), answer questions, get validated config with findings raised inline as you go — not at the end.

**RECOMMENDATION — never accept credentials.** There is no reason a config builder needs the actual pre-shared key. Emit `pre-shared-key ascii-text "<PSK>"` and let the engineer paste the real value into their terminal. Same for certificates, SNMP communities, TACACS keys. This removes the highest-value secret from the application entirely and shrinks the threat model more than any cryptographic control.

### 6.3 Config paste and reverse explanation

**Paste is the primary on-ramp for inventory.** `show configuration | display set` in, populated graph out, diagram drawn, findings listed. Never an empty form (§2.2).

The same machinery pointed backwards gives "explain a config someone else wrote" — paste an inherited configuration, get an annotated walkthrough. Nearly free once parsers and explainers exist, and it is the highest-value feature for anyone inheriting equipment and documentation they did not write. Which is eventually everyone.

### 6.4 Inventory

**DECISION — inventory and the intent model are the same schema.** Not an inventory database plus a config model with a mapping layer. One model, partially populated. A device you have entered is an intent model with most fields empty, and the engines run against it the moment it exists.

That yields the thing NetBox structurally cannot do: **the inventory has opinions.** Add a second SRX and it observes that these two look like a cluster candidate, and here is what RG0 and RG1 would need. Facts that argue back.

**DECISION — inventory as a document, not a database.** Given everything is client-side and encrypted, it is an encrypted file you own: git-versionable, diffable, portable. No Postgres, no migrations, no ORM.

*Trade-off, stated honestly:* you lose fleet-scale querying and native multi-writer concurrency. For team-sized deployments this is a good trade and git provides collaboration. At several thousand devices it stops being one, and §7.6 (CRDTs) becomes load-bearing.

### 6.5 Diagram

A view over the graph and a manipulation surface for it. Physical ports, logical links, tunnels, zones. Layered: physical / L2 / L3 / security / overlay, toggled independently.

**Scope it as a design tool, not a source of truth.** Drawing what you are about to build, and getting validated configuration out, works. Claiming it records what exists invites the rot described in §2.2. Where the graph was populated by parsing real configs, mark those nodes as such and show their age.

### 6.6 Findings

Continuous lint over the graph, not a batch report. Severity, `acceptable_when`, remediation, sources. Suppressions are first-class, carry a reason, and are stored in the workspace so a reviewer can see what was waived and why.

### 6.7 Verification and rollback generation

Because the tool knows what it just built, it can emit the verification ladder *and* the rollback for that specific change — the exact commands to prove it worked, and the exact commands to back it out. This is the existing Bring-Up Order block, generated per-change rather than generic, and paste-ready into a change ticket.

This is a small feature that makes the tool legible to change-management processes, which matters more for adoption than it sounds.

## 7. Security architecture

### 7.1 Threat model — explicit

**In scope:**

| Threat | Mitigation |
|---|---|
| Server compromise | Zero-knowledge; server holds ciphertext only (§7.3) |
| Server operator (insider) | Same |
| Network interception | TLS + payload already encrypted |
| Lost/stolen endpoint | Nothing sensitive persisted in plaintext (§7.4) |
| Malicious image substitution | Signed images, reproducible builds, published hashes (§7.7) |
| Supply chain (runtime deps) | Minimal runtime dependency surface (§8.4) |
| Data exfiltration by the app | No egress; `connect-src` restricted to the sync origin or `'none'` |

**Explicitly out of scope — and this must be documented, not hidden:**

| Threat | Why it cannot be mitigated |
|---|---|
| **Compromised browser** | Defensive code runs i— *[TRANSMISSION ENDS HERE]*

---

## Additional owner direction (from the accompanying message)

- *"Put an almost unreasonable amount of effort into the idea of this project — from
  all angles."*
- *"There needs to be a supervisor AI and sub agents."* — an explicit new requirement
  not present in the document above. Reconciling a supervisor/subagent AI layer with
  §6.1's "no model at runtime", with the zero-knowledge posture of §7, and with
  offline single-file deployment, is a first-class architectural problem for this
  project, not an add-on.
- *"I'm going to provide the style I want, though it's very bare bones there's
  something I love about it."* — the attached SRX IPsec field card. See
  `.context/design-language.md`. The bare-bones quality is the requirement.
- *"Down to security and etc."*
- *"I recommend a large scale workflow with no limits."*
