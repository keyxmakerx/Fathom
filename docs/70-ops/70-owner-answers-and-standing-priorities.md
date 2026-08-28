# 70 — Owner answers and standing priorities

> **Status:** Accepted — this document records the owner's words. The decisions they imply are
> drafted as ADR-0031, ADR-0032 and ADR-0033 and are `Proposed` until the owner ratifies them.

The companion to `77`. Where `77` records the owner's service-model requirements verbatim, this
records the owner's answers to questions put to them, verbatim, plus the standing priority order
they stated. It decides nothing. Quoting is exact, including where the phrasing is informal — the
whole value of a verbatim record is that a later reader can see what was actually said rather than
what a planning session made of it.

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | How to use this | *read this first* |
| 2 | The standing priority order | *the tie-breaker* |
| 3 | Third-party code — the answer, verbatim | *→ ADR-0032* |
| 4 | Scope — the answer, verbatim | *→ ADR-0031* |
| 5 | Motion — the answer, verbatim | *→ ADR-0033* |
| 6 | The dynamic-correlation goal, verbatim | *the largest unspecified requirement* |
| 7 | The platforms — the equipment the owner works on | *answers §11.1* |
| 8 | Hosting, load balancing and stored state | *not the collision it looks like* |
| 9 | What "off the ground" means | *there is no thin first release* |
| 10 | The graph and the diagram — owner observations | *three observations, then the structure of the picture* |
| 11 | Questions still outstanding | *re-asked in plain language* |
| 16 | Incomplete paths, devices, and engines as separate files | *three answers, 2026-08-09/10* |
| 12 | Failure modes |  |
| 13 | Open decisions |  |
| 14 | Sources consulted |  |
| 15 | Disagreements |  |

---

## 1. How to use this

Three of the answers below are decisions and are drafted as ADRs; §6 is a requirement with no
mechanism behind it anywhere in the corpus and is therefore not an ADR but a named gap. §2 is
neither — it is a **tie-breaker**, to be applied when two defensible options conflict and no
document ranks them.

An execution session never reads this document for work. It is planning input (`78` §7).

## 2. The standing priority order

Stated by the owner on 2026-08-06, in answer to a question about where a warning should surface:

> *"the first priority is security, second priority is a combination os usability, so think UiUx
> design, animations, but also useability from your perspective that it is easy to edit add and
> understand how it all works. the second part to that second priority is dynamic ability."*

Read as a ranked list:

| Rank | Priority | What it means when it decides a tie |
|---|---|---|
| 1 | **Security** | Where a usability gain costs a security guarantee, the guarantee wins. This is consistent with invariants 1–4 and with `71` §13.1's thirteen permanent boundaries, and it is now stated as a general rule rather than inferred from them |
| 2a | **Usability — for the user** | Interface and interaction quality, including motion (§5) |
| 2b | **Usability — for the maintainer** | *"easy to edit add and understand how it all works"*. This is a first-class requirement, not a nicety: the corpus is authored by hand and its authoring rate is `72`'s named long pole |
| 2c | **Dynamic ability** | §6. Ranked by the owner as *"the second part to that second priority"* |

**RECOMMENDATION —** rank 2b is the one most likely to be quietly traded away, because its cost
lands on a future session rather than on a user. `62`'s grammar, the schema-as-artifact rule
(ADR-0008) and the corpus's provenance headers are existing expressions of it; new work should be
held to the same standard.

## 3. Third-party code — the answer, verbatim

The question put: may the project use third-party libraries, or does it stay at zero?

> *"I don't know what dependencies your referring to. however as long as they are bundled and are
> not a security risk vector I'm for it. i suppose they don't have to be bundled but I'm just
> concerned the implications here. my recommendations is look at what other enterprise solutions
> use here, and how might AI miss things and preemptively try to shore up those concerns."*

Three separable instructions:

1. **Third-party code is permitted in principle.** This settles the question five work orders each
   defer separately (`88` §5.7).
2. **Conditioned on two things:** bundling (stated as a preference, then softened — *"they don't
   have to be bundled"*), and not being *"a security risk vector"*. The second is the binding one.
3. **Two research instructions**, both discharged in ADR-0032: survey enterprise practice, and
   adversarially anticipate what an automated session would miss.

The owner did not know what the candidate libraries were, and said so. ADR-0032 §2 therefore leads
with the inventory in plain language before it proposes any policy.

## 4. Scope — the answer, verbatim

The question put: is v1 still the command finder (ADR-0006), or the inventory face the queue
actually builds?

> *"Again I don't know what you mean? All features must be included in V1, how you wish to plan
> that out is your discretion."*

Two instructions, and the second matters as much as the first:

1. **There is no reduced first release.** The feature set is the whole product. ADR-0006's
   scoping — *"v1 = the finder … Nothing about a graph"* — is overruled on merit, which `75` §2
   and `CLAUDE.md` rule 2 expressly permit.
2. **Sequencing is delegated to planning.** *"how you wish to plan that out is your discretion."*
   The build order is therefore a planning artifact, not an owner decision, and `76` §7.2's
   S-slices and the work-order queue continue to govern it.

**What this answer does not do.** It does not reopen anything in `71` §13.1 — the thirteen
permanent product boundaries, which are refusals rather than deferrals. Invariant 2's own wording
makes the distinction: *"This is a permanent product boundary, not a phase-1 limitation."*
Removing phases removes phase-limitations only. See ADR-0031 §Decision item 4.

## 5. Motion — the answer, verbatim

The question put: the design corpus records *"the product has no animation"*; you have asked for
animations. Which stands?

> *"oh yea why wouldn't we have animations? it's just we don't want animations there for animation
> sake, it should have reason, direction, and from a humans stand point easily to have context of
> why that animation was there."*

This is a **doctrine**, and a more useful one than either "no animation" or "add animation". Read
as three tests, all of which a motion must pass:

| Test | The owner's word | What it asks |
|---|---|---|
| Purpose | *"reason"* | What does this motion tell the user that a static frame does not? |
| Direction | *"direction"* | Does it show causality — what became what, what came from where? |
| Legibility | *"easily to have context of why that animation was there"* | Can a person say why it happened, without being taught? |

Drafted as ADR-0033. The corpus's existing position turns out to be narrower than its headline
(§14, `86` §9.4), so this is largely a reconciliation rather than a reversal.

## 6. The dynamic-correlation goal, verbatim

> *"the second part to that second priority is dynamic ability. I don't know how you'll think this
> best works but if we have a switch at one location, and a we add 2 other switches, or I add
> configs of some other switch, the goal is that It is dynamic enough to connect these together if
> everything matches. I know it doesn't exactly work that way, but trying to get to that goal as
> much as possible is the hope. then I can click on equipment and paste a config and/or edit fields
> in planning mode or maintenance mode etc to add IP info and such."*

**This is the largest requirement in the corpus with no mechanism behind it.** It splits in two,
and the two halves are in very different states.

### 6.1 Half one — automatic correlation across separately-pasted configs

**Declared in scope, never designed.** `03` §4.5 draws the line exactly where the owner wants it,
and does so as a boundary statement:

> *"Multiple devices pasted, and inferred adjacency where two configs reference each other — a
> gateway whose `address` matches another device's `external-interface` address is a tunnel edge,
> and that inference is a fact about two texts, not about a network."*

and, on `show lldp neighbors` output specifically:

> *"**This one is *in scope*, and stating that is the point**: it is text the user gathered, not a
> network the tool probed. The refused version is Fathom gathering it."*

So no decision has to be won. What exists today:

| Mechanism | Crosses devices? | State |
|---|---|---|
| `infer.tunnel.pair` / `infer.tunnel.compat` — peer address in one config matches an interface address in another | Yes | IPsec only; `infer.tunnel.compat` is declared in `schema/schema.yaml`, `infer.tunnel.pair` is prose |
| `infer.port.cabled-peer` | Yes | Declared in `schema/schema.yaml` |
| `infer.port.occupies` — an interface name's slot position matched to a physical port | **No — same device only** | Specified in `19` §3.7. Emits a **suggestion, not a graph change** |
| Re-identification (`11` §10.4, ADR-0010) | **No — scoped by `owner_device`** | Specified. Answers *"is this the same gateway on the same box"*, never *"do these two boxes connect"* |
| The warp (`19` §6) | Yes, across the path | Specified in full, with six outcomes and a resolver. **Reads asserted edges only — cables and ports a human entered, never configs** |

And what does not exist at all: any correlation on LLDP or CDP neighbour output, on matching
interface descriptions, on a shared subnet or a common /30, on shared VLAN IDs, on a hostname
defined in one config and referenced in another, or on LAG peering. `rg -ci lldp corpus/` returns
nothing; the word appears in four documents, all of them scope or security discussions.

**The shape of the answer is already set, and should be copied rather than reinvented.**
`19` §3.7's rule is the template: *propose, never assert; refuse when ambiguous; show the evidence.*
Its reason for refusing to key hardware identity on interface names is the same reason
cross-device correlation must not silently write edges — doing so *"would … silently move every
cable"*.

**RECOMMENDATION —** the cheapest high-value start is LLDP/CDP neighbour paste. It is the one
input that states adjacency directly rather than implying it, the user already has it, and `03`
§4.5 has already cleared it. It needs a design document before any code, and that document is
planning work not yet scheduled.

### 6.2 Half two — click equipment, paste a config, edit fields

**Largely specified, partly prototyped, and queued.** The per-equipment page is designed and
clickable in `design/prototype/fathom-app.html`; WO-08 builds it, deliberately read-only in its
first slice. Paste-while-looking-at-a-device is specified down to its warning prompt; in-place
field editing is specified with its keyboard contract.

One collision, and it is with the owner's *word* rather than their intent. `53` refuses modes
outright — *"No modes. No mode indicator. No mode errors."* — on the grounds that a mode is a
state the user must remember they are in. The owner's *"planning mode or maintenance mode etc"*
describes the same capability `75` records as C-07, floored at phase 4 (a floor ADR-0031 removes).
Whether the capability is delivered as a mode, as a per-record state, or as a filter is a design
question that `53`'s refusal constrains but does not answer. **Not decided here.** Logged in §9.

## 7. The platforms — the equipment the owner works on

Two statements, 2026-08-06, verbatim:

> *"we need to add Cienna to the list of Juniper, Cisco, and Nokia engines we'll need to include."*

> *"as far as equipment i use, Juniper SRX, MX, EX, Meraki, Cisco Nexxus, and Palo alto are my main
> stuff we need engines for, idk if that's per Device type or Manufacturer i'll leave to you."*

**This answers §10.1. Juniper is not retired — it is primary.** ADR-0029's six SRX corrections stay
live, and ADR-0030's choice of PAN-OS as the second platform is vindicated rather than orphaned:
Palo Alto is on the owner's own list. `88` §5.9's finding is thereby narrowed, not closed — see §12.

### 7.1 "Per device type or manufacturer?" — neither, and the answer is already in the conventions

A **platform** is *"a vendor+family target (`junos-srx`, `panos`, `ios-xe`)"*, and conventions add
*"never say **vendor** — a vendor has many platforms"*. The unit is neither the box nor the brand:
it is the **configuration dialect**. That is why `junos-srx`, `junos-mx` and `junos-ex` are three
platforms and not one — same vendor, same family, but a parser must know which statement set it is
reading — and why Nexus is its own platform rather than a kind of Cisco.

This matters practically, and it is the reason invariant 5 exists: a **rule** is written once and
carries a `platforms` predicate, so *"IKE is not permitted inbound on this interface"* is authored
once and applies wherever it is true. There are no per-vendor engines and there must not be
(`71` §13.1). The word *"engines"* in the owner's message maps to **platforms**, and what is
per-platform is narrow: a parser, a statement dictionary, an emitter, and corpus content.

### 7.2 Five of the six are already registered

`schema/platforms.yaml` as it stands after the 2026-08-06 edit:

| Owner's words | Platform id | Registry state |
|---|---|---|
| Juniper SRX | `junos-srx` | Registered · the only one with corpus content (98 commands, 37 rules, 42 explainers) |
| Juniper MX | `junos-mx` | Registered · no corpus, no dictionary |
| Juniper EX | `junos-ex` | Registered · no corpus, no dictionary |
| Cisco Nexus | `nx-os` | Registered · no corpus, no dictionary |
| Palo Alto | `panos` | Registered · no corpus; ADR-0030 makes it the second platform |
| **Meraki** | — | **Absent. See §7.3** |
| Nokia | — | Vendor only, no platform |
| Ciena | — | Vendor only, added 2026-08-06 |

So the registry needed one line for Ciena and no new platform rows for the owner's list. The gap is
not registration — it is that **only `junos-srx` has any content behind it**. A registered platform
with no dictionary, no emitter and no corpus is a name, not a capability.

### 7.3 Meraki is the one that needs an answer before anything is registered

Every other platform on the list is configured by text an engineer can select and paste, which is
the entire on-ramp (`03` §4.5: *"Config paste is the primary on-ramp"*, and invariant 2 makes paste
the only on-ramp there will ever be). Meraki is Cisco's cloud-managed line, and whether it presents
a comparable pasteable device configuration is **not something this document will assert** —
conventions forbid stating a vendor behaviour without a primary source, and no Meraki artifact
exists in this tree.

**The question is in §11.3.** It is not a small one: if Meraki's configuration is not obtainable as
text the owner can copy, then Meraki cannot be a platform under invariant 2, and supporting it would
require either a different input shape (an exported file) or a connection the product will never
make. That is a boundary question, not a scheduling one.

### 7.4 Versions, known bugs, and command differences

> *"We also need to account for the fact that different versions have known bugs that should be
> avoided, and different commands too."*

This splits into two requirements that look alike and are in completely different states.

**Half one — version-gated commands and rules. The mechanism exists; the content does not.**
Every rule and every command entry in `corpus/` already carries a `versions:` predicate.
`schema/platforms.yaml` gives each platform a `version_scheme`, and `Device.os_version`
(field key 8) is documented in `schema/schema.yaml` as the field that *"drives every rule versions
predicate (11 §4.7)"*. The design anticipated this requirement in full.

What the content does is another matter, and the corpus says so about itself. From the header of
`corpus/rules/ipsec-junos-srx.yaml`, gap G6, verbatim:

> *"`versions: "*"` is used on all 37 rules and that is not a virtue. The owner brief is explicit
> that version predicates are not optional and that a rule correct on one train and wrong on
> another is worse than no rule. … `"*"` here means "unverified across trains", and the review
> that replaces `<named reviewer>` should narrow every one of them."*

So the honest position: **every rule and command in the product currently claims to apply to every
software version ever shipped, and none of that has been checked.** The owner has now asked for the
thing the corpus already knew it owed. This is authoring work against an existing mechanism, not a
schema change, and it is bounded by the same named-reviewer requirement as everything else in
`corpus/` (invariant 10).

**Half two — known-defect advisories. Not modelled anywhere.** A version predicate and a known-bug
warning are different assertions. A predicate says *"this command exists on these trains"*; an
advisory says *"this train is defective in this specific way, avoid it or work around it"*. Nothing
in the 48 kinds carries the second. A search of `schema/` and `docs/10-model/` for advisory, PSIRT,
CVE, defect or errata returns nothing relevant.

This is a genuine schema extension, and **the hard part is not the schema — it is the sourcing.**
Three problems have to be answered before a field is added, and none of them is technical:

| Problem | Why it bites |
|---|---|
| **Where does the data come from?** | Vendor defect databases are the authority, and invariant 2 means the product can never fetch one. So the data is hand-authored corpus content, at the authoring rate `72` already names as the long pole |
| **Who reviews it?** | Invariant 10 requires a named human on every corpus entry. A defect advisory is a higher-stakes claim than a command explainer: telling an engineer a train is safe when it is not is a worse failure than any this product currently risks |
| **What happens when it goes stale?** | A defect list that is out of date is worse than no defect list, because it is trusted. `56` §1.2 already refuses to let the diagram claim currency for exactly this reason, and the argument applies here with more force |

**RECOMMENDATION —** treat these as two separate pieces of work, in this order. Narrowing the
existing `versions: "*"` predicates needs no new schema and no new decision, and it is the larger
correctness win. The advisory kind needs an owner decision on sourcing and staleness first, and it
should get one before any field is designed. Logged in §13.

### 7.5 The owner's answer on versions — target one release, keep engines independent, defer

> *"Well i mean personally i'd just go with what seems to be the best case for whatever version of
> that OS. Since the engine will be something that can be added/removed/edited after the fact, as
> they should all independent, i'd say we'd do that later yea?"*

Three separable things: a **policy** on version targeting, an **architectural assumption** about
platform independence, and a **deferral request**.

**The policy — author against one named target release per platform.** This is a real decision and
it is strictly better than what the corpus does today. `versions: "*"` does not mean "works
everywhere"; the corpus's own gap G6 (quoted in §7.4) says it means *"unverified across trains"*.
Naming a target release replaces an unverifiable claim with a checkable one, and it is what makes
the named reviewer of invariant 10 able to review anything at all — a human can put their name to
*"this is correct on release X, which I ran it on"*. They cannot put their name to *"correct on
every release ever shipped"*.

**The architectural assumption — platforms are independently addable, removable and editable.**
Recorded as the owner's expectation. It is **not yet confirmed**, and it is the sort of assumption
that is cheap to hold and expensive to discover is false. `71` §13.1 permanently refuses *"a plugin
system that executes third-party code in the application"* while sanctioning the alternative in the
same breath — *"rule packs and corpus entries are **data**, signed and versioned; that is the
extension mechanism."* So the owner's expectation is compatible with the product boundary **for
anything that is data**. Whether a whole platform is data is a different question: a platform
plausibly also needs a config parser and an emitter, and those are Rust. Under investigation as of
2026-08-07; the answer belongs here when it lands.

> **ANSWERED 2026-08-10 — `65` is the answer, and the assumption was false in one direction and
> too pessimistic in the other.** Re-asked by the owner in his own words — *"if someone created a
> Linux engine it would just be plug and play and add all the features of that right?"* — and
> investigated four ways with every finding adversarially verified.
>
> **The paragraph above guessed the split wrongly.** It supposed the boundary ran between *data*
> and *"a parser and an emitter, and those are Rust"*. The real boundary runs one layer lower.
> **Adding a node kind — a new *thing* for the model to hold — needs zero hand-written Rust**,
> measured twice by two investigators who each added a container-network kind and ran the real
> toolchain: ~41 lines of YAML, one `fathom-schemagen` run, a clean `cargo check --workspace`, and
> four one-line bumps to pinned counts. ADR-0008 delivers exactly what it promised, and everything
> downstream of the parser was confirmed platform-blind in the built code, not merely in the spec.
>
> **What is Rust is narrower and harder than "a parser and an emitter": it is the *shape* of the
> text.** The vocabulary of a platform is data; the grammar is not. Junos MX, EX and PAN-OS
> set-form are largely data — after the dictionary loader is un-hardcoded, which it is not. Anything
> whose text has a different shape is a new front end, priced by `14` §5.5 at 3–10 days and 200–600
> lines, which the one built shaper's 430 production lines calibrates well.
>
> **And "plug and play" in the sense of dropping a file beside the app stays permanently refused.**
> `71` §13.1's refusal is not a preference: a runtime-loaded engine sees the paste **before** the
> redaction gate — necessarily, because parsing is what tells the gate which token is the secret —
> and every control ADR-0032 relies on is a *build-time* control. It would convert invariant 3 from
> *"the unredacted text never reaches the encryptor, provable by reading first-party code"* into
> *"we redact well against an adversary we never compiled."* Someone adding a Linux engine is a
> **contributor whose code we read and compile**, not a user installing a plug-in, and `65` §5
> gives the four conditions that make a contributed engine safe — three of which are broken today
> with only one first-party engine.

**The deferral — mostly safe, with one part that is not.** Split it:

| | Safe to defer? |
|---|---|
| Known-defect advisories (§7.4 half two) | **Yes.** Nothing is modelled, nothing depends on it, and the sourcing question wants an answer before a field is designed. Deferring costs nothing |
| The `versions:` value on entries authored **from now on** | **No.** Every entry written meanwhile carries `"*"`, and correcting it later is per-entry work by a named human. Deferring does not postpone the cost, it multiplies it by however many entries are written in the interval |

**RECOMMENDATION —** adopt the policy now and defer the work. They are different things. Naming a
target release per platform is a one-line change to the authoring convention that costs nothing
today and stops the debt growing; going back over existing entries, and the advisory kind, both wait.
The distinction matters because the corpus is about to grow from 177 entries toward the six
platforms §7.2 names, and `"*"` written 500 more times is 500 more corrections.

**Still needed for the policy to be actionable:** the target release per platform, which is a
`schema/platforms.yaml` field that does not exist. Logged in §13.

### 7.6 The dependency vulnerability check — what was queried, against what, on what date

**This section exists because ADR-0034 cited it before it existed.** The record making it law that a
security claim is never asserted from memory, and that a lookup must name its source and its date,
shipped with a forward reference to a section nobody had written. That is the same class of defect
as the nine dangling references to `73` §14, arriving inside the document written to prevent it, and
it is recorded here rather than quietly repaired because the failure is the more useful artifact:
**a rule does not enforce itself, and the author of a rule is not exempt from it.**

The lookup below is the one ADR-0034 §3 refers to. It is reproduced with its date and its sources so
that a later reader can tell how stale it is without re-deriving it.

**Queried:** 2026-08-08. **Sources:** OSV.dev (Google's open-source vulnerability database) and
RustSec (the Rust community advisory database) — two independent databases, as ADR-0034 §3 requires
for a negative result, because a failed query and a clean result are indistinguishable from one.

**Scope:** the fifteen crates `32` §15 pins by exact version, plus their transitive dependencies —
`argon2`, `chacha20poly1305`, `hkdf`, `sha2`, `blake3`, `x25519-dalek`, `ed25519-dalek`,
`curve25519-dalek`, `getrandom`, `zeroize`, `secrecy`, `subtle`, `vsss-rs`, `ml-kem`.

**Result: zero known vulnerabilities against any of them, in either database.** Both databases agree,
which is the point of using two.

**Three limits on that result, which are part of the result:**

| | |
|---|---|
| **"No known vulnerability" means nothing has been *reported*** | It is not an audit, not a maturity signal, and not evidence that no flaw exists undiscovered. It is the best available check and it is not a guarantee |
| **It is true as of the date above, and decays from that moment** | This is precisely why ADR-0034 §4 puts a dependency scan on `78` §6's floor rather than trusting a dated line in a document. A record cannot notice it has gone stale |
| **It says nothing about how the primitives are *assembled*** | Choosing sound libraries and building a sound scheme from them are different jobs. The workspace file's key hierarchy, its recovery path and what the server can infer are open design questions (`70` §13 item 4, WO-05 §2) and are not answered by this check |

**Recommendation, unchanged from the research: keep `32` §15's list as it stands.** There is no
security reason to substitute anything, and the alternative AEAD construction considered alongside it
has no advantage on this evidence. **Nothing in this section authorises a crate to land** — ADR-0032's
per-crate approval gate and its gate zero in CI both still apply, and ADR-0032 §6 requires gate zero
to exist *before* the first dependency does. As of this date the workspace still has **zero** external
dependencies, so nothing has been breached; that is also why the gate is now the last guard rather
than one of several.

## 8. Hosting, load balancing and stored state

> *"all that in a very secure format with expandability for loadbalancing and docker hosted storage
> saftely in the future."*

**This is not the collision it appears to be, and the distinction is worth stating precisely because
it is the one that keeps the security argument intact.**

`71` §13.1's permanent refusal is not "a server". It is two narrower things, quoted exactly:

> *"**A server that can read a workspace.** No server-side lint, no server-side emit, no server-side
> search."* — and — *"**A hosted multi-tenant SaaS that holds plaintext.** It is the product the
> security posture exists to not be."*

The qualifiers are load-bearing. A server that stores bytes it cannot read is not refused anywhere —
it is **already the design**. `33` §1: *"The server stores ciphertext and never holds a key."*
`33` §12 states the consequence plainly: if the server is compromised the attacker gets *"ciphertext
and metadata"*, and *"it does not yield a single plaintext byte."* `43` already specifies D2 (single
node) and D3 (cluster) as deployment shapes.

So the line the owner should hold in their head:

| Wanted | Status |
|---|---|
| Docker-hosted storage of workspaces | **Designed for.** The server holds ciphertext; `43` D2/D3 are the shapes |
| Load balancing across nodes | **Compatible.** A node that cannot read a workspace is stateless with respect to its contents; `41` §5.5 has `fathom-sync` never linking the graph, rules, emit or parse crates, *and the linker enforces it* |
| Server-side search or querying over the estate | **Never.** Invariant 4. It requires plaintext on the server, which is the thing the whole posture exists to prevent |
| Fleet-scale storage (Postgres-backed inventory) | **Deferred**, `71` §13.2, trigger: a real workspace over ~2,000 devices with genuine concurrent editing. The *"server-side querying"* half of that row is barred by invariant 4 regardless of the trigger |

**One live consequence.** ADR-0016 decides *"git is the sync **for v1**"*, and `33` (the wire) is
deferred by it. ADR-0031 retires v1 as a scoping device — so `33` comes back into scope, and with it
the multi-writer question ADR-0016 deferred on evidence rather than on schedule. That deferral was
argued on merit and this document does not disturb it; but *"expandability for load balancing"* is a
requirement that lands squarely on `33`, and somebody has to decide when it is picked up. Logged
in §12.

## 9. What "off the ground" means

> *"I need most features present otherwise this project won't get off the ground. It needs to be
> useable and have most features working without bugs."*

Put to the owner as a proposal for a thin first milestone — an openable browser artifact with an
inventory and a per-equipment page, four of the eight work orders — and **declined**. Recorded
because it closes a question rather than opens one:

- There is **no thin alpha**. The first thing anyone sees has most features working.
- *"without bugs"* is a quality bar, not a feature. It ratifies the verification floor (`78` §6)
  and argues for extending it — which is exactly what ADR-0032 unblocks, since property testing and
  fuzzing the config parser are both currently blocked on the dependency question.
- Combined with §4's *"all features must be included in V1"*, the sequencing freedom the owner
  granted is real but bounded: planning chooses the **order**, not the **cut**.

**The honest consequence, stated rather than buried.** No intermediate release means no measurement
until most of the product exists, so every estimate stays an extrapolation from specification rather
than from observed velocity. The project's own figures are `71` §2's **106–158 solo weeks** to the
full product, which `83` §12.5 refuted as optimistic at **170–240**. Those are the corpus's numbers,
not new ones. `72` names the corpus authoring rate as the variable that moves them most.

**RECOMMENDATION —** internal checkpoints, not releases. Sequence the queue so the tree is
demonstrable at intervals even though nothing ships until the bar in this section is met. That
preserves the owner's decision exactly while converting some of the estimate into measurement. It
needs no decision and no new document; it is how the queue is already ordered.

## 10. The graph and the diagram — three owner observations

> *"i came across one today that had like 10 links to a bridge device, so we will need to make sure
> we account for those situations on the graph. Also how do you have the graphics seperated, is it
> per like location or…? How will they interact with each other?"*

Asked in follow-up on 2026-08-08 what the ten links were, the owner described the device:

> *"2 boxes core and bridge with them having 10 10g pipes"*

and, asked directly whether the ten were bundled into one logical interface or were ten standalone
links, answered:

> *"they were standalone"*

In the same message:

> *"we need to account for all kinds of those situations and be dynamic about it while letting the
> user move stuff, collapse, expand, group, tag, etc as needed."*

Three observations, then. §10.1's analysis of the first was **aimed at the wrong shape and is
corrected below** rather than amended away. §10.2 is a real gap. §10.3 is a second one, and it is
larger than it looks.

### 10.1 The high-degree node — the analysis was aimed at the wrong shape

> **CORRECTION, 2026-08-08. What follows below the rule was written against *many neighbours* and
> the owner's device is *many links to one neighbour*. Those are different shapes with different
> remedies, and the difference is not a detail — it is the whole of why `59` §3's six-sibling rule
> does not fire on the estate this section was written to explain.**
>
> The original reading treated *"10 links to a bridge device"* as high-degree fan-out and pointed at
> `59` §3's like-kind sibling rule, whose Peer level collapses *"`SPOKE-01 … SPOKE-40` in the lateral
> column"* — seven or more **like-kind peers**. The owner's clarification says there is exactly
> **one** peer, the bridge, reached ten times over ten standalone links. Peer level therefore never
> fires. `59` §3.3's Port level does fire, at both ends, because ten ports on one side exceeds six —
> **so the ends of the group collapse and the ten edges between them do not.** `59` §3.13 states the
> consequence: the picture draws ten lines terminating on a stack that draws one stub.
>
> **What was right and stays right:** the legibility-ceiling finding, the `155 + 9n` measurements,
> the six-sibling threshold, and §2.3's proof that element count cannot choose a threshold. None of
> that depended on the shape. **What was wrong:** the conclusion, stated below as *"a ten-link bridge
> is handled if the ten links are like-kind siblings — six draw, four aggregate"*. It is not handled,
> in either reading. If the ten links are alike, no level counts them; if the ten neighbours are
> alike, Peer level counts those, but the owner does not have ten neighbours.
>
> **What now covers it:** `59` §3.13 (the finding, and what the model represents against what the
> diagram draws) and `59` §3.14 (a PROPOSED sixth level — parallel edges collapse to one drawn edge
> with a visible count, expandable, keyed on the channel budget so that mixed kinds split). It is
> **proposed, not decided**: `56` owns the diagram and `59` §9 carries the fork. Listed in §13.
>
> **One thing the correction does not change and the owner should know.** The proposed mark keeps
> `56` §5.2 G5's port stubs and takes three rails rather than two, because two rails already mean
> LAG-or-reth. A collapsed group of standalone links must never be drawn in the form that says
> *bundle*, and *"they were standalone"* is exactly the fact that would be destroyed by getting it
> wrong.

`59` is a whole document about this, and it found something worth repeating. The corpus's existing
ceiling — `44` §4.7.4's *"never more than 2,000 live SVG elements"* — **never fires**. A forty-spoke
hub renders in 514 elements, 26% of that ceiling, and is already unreadable. `59` §2.1's finding:
the 2,000-element rule is a PERFORMANCE ceiling, and *"the corpus has never specified the LEGIBILITY
ceiling, and the legibility ceiling is the one that bites."*

The measurements, from `59` §2.2 — element cost is exactly `155 + 9n` for `n` drawn spokes:

| spokes | fit zoom | what the view drops |
|---|---|---|
| 6 | 0.97 | 7 edge labels |
| 12 | 0.93 | 13 edge labels |
| 40 | 0.68 | 41 of 42 edge labels, LAG rails, stubs |

`59` §3 decided the answer: **no more than six like-kind siblings are drawn in one group**, counted
in siblings and never in elements, because §2.3 proved element count cannot choose the threshold —
an element rule would collapse the second sibling, *"which nobody wants and which destroys the one
fact a chassis cluster exists to show."*

~~So a ten-link bridge is handled **if the ten links are like-kind siblings**: six draw, four
aggregate into an expandable group.~~ **Superseded by the correction above, 2026-08-08.** The
sentence read the ten links as ten siblings of one kind hanging off one node. `59` §3.3's levels
count nodes, not edges, so ten edges between one pair collapse under none of them.

**The hole the owner's example may fall into — and it fell into a different one.** If ten links go
to ten *different* kinds of thing — a firewall, three access switches, a router, a couple of servers
— then they are not like-kind siblings and the rule does not fire. Ten heterogeneous neighbours is
the same legibility problem with none of the same remedy, and `59` does not cover it. **That hole is
still open and is still unowned**; `59` §3.14.6 states explicitly that its grouping key refuses to
group it. It is simply not the hole the owner's device fell into: §11.4 is answered, and the answer
was *"they were standalone"*, which is the parallel-edge shape and not the mixed-neighbour one.
Kept in §13 as its own row, because answering §11.4 did not answer it.

`59` §6.2 also files a defect worth knowing about: at the top of the range the view band stops
printing *how many* labels it suppressed, which violates `56` §5.5's own rule — *"a diagram tool
that silently drops labels is a diagram tool that lies about what it drew."* It loses the number
precisely when scale makes it matter.

### 10.2 How the graphics are separated — the honest answer is that they are not

The owner asked whether the diagram is split per location. It is not, and nothing in the corpus
splits it any other way either.

`56` §1 describes **one canvas over the whole graph**, with two mechanisms for coping with size, and
neither of them is partitioning:

- **Layers.** Five, toggled independently (`56` §4). That is separation by *concern* — physical,
  logical, security and so on — not by place.
- **Aggregation.** Above `44` §4.7.4's ceiling it *"aggregates to `Site`/`Device` level and requires
  a drill-down"*, and `56` §1.2 concedes the cost in plain terms: *"An engineer who wants their
  200-device estate on one screen cannot have it, and the answer is the inventory table."*

So the answer to *"how will they interact with each other"* is that **the question has no answer in
the corpus, because there is only ever one of them.** There is no per-site diagram, no notion of two
diagrams, and therefore no story for how one would link to another.

**This is a real gap, and the owner's question is what exposed it.** "One canvas, aggregate when it
gets big" is a rendering policy, not a navigation model. An engineer working a multi-site estate
almost certainly wants to open *a site* and see that site, with the links that leave it drawn as
edges to somewhere else — which is a per-`Site` view with an inter-site relationship, and neither
exists.

**RECOMMENDATION —** do not decide this on paper. It sits in the owner's own priority rank 2a
(usability for the user), it is exactly the kind of question they said they would answer, and it is
far easier to answer against something on screen than in prose. Put it to them when the diagram
face is real enough to show two sites. Until then it is logged, not settled. `56` §12 owns it.

### 10.3 *"move stuff, collapse, expand, group, tag"* — two of the five are specified, one is a placeholder, one does not exist

The owner named five verbs. They are not five features of one size, and the honest report is that
the list splits three ways. **Nothing is designed here** — this section names what is missing and
stops, because `56` owns the diagram and `62`'s grammar owns any schema extension.

| Verb | State | Where it is, or where it isn't |
|---|---|---|
| **move** | **Specified in design, absent from `schema/`** | `56` §3.5 gives `LayoutHint { pin, pinned_under, at }` and `Pin::{Free, At, InLayer, Grouped}`, states that positions are *"graph data, not view state"*, keys them by `NodeId` so they survive a rename, and makes unpinning an undoable op. `56` §1.3 lists *"Manual position, per node, workspace-persistent"* in scope. **But**: grepped 2026-08-08, `schema/` contains no `LayoutHint`, no `Pin` and no node position of any kind (`PortPosition` is a physical slot coordinate and unrelated). Under ADR-0008 *a field that is not in `schema/` does not exist*, so the thing `56` calls graph data is not yet in the graph |
| **collapse / expand** | **Specified** | `59` §3.7 (windowed expansion, leading and trailing residuals), §3.8 (the ARIA disclosure contract — `role="button"`, `aria-expanded`, `aria-controls`, the count in the accessible name), and `53`'s `h` / `l` aliases bound to collapse / expand. This is the best-specified verb on the list |
| **group** | **A half-drawn placeholder** | §10.3.1 |
| **tag** | **Does not exist anywhere** | §10.3.2 |

#### 10.3.1 `group` — one identifier, mentioned once, defined nowhere

`56` §3.5's `Pin` enum ends with:

```rust
/// Weakest: keep these nodes adjacent and in this relative order.
/// Produced by selecting several nodes and pressing `G`.
Grouped { group: GroupId, ordinal: u16 },
```

**`GroupId` had exactly one occurrence in the repository before this section was written** — in that line — one **definition site**, no type, no schema entry, no persistence rule.
Re-running the command now also matches the sections that discuss it, including this one
(`grep -rn "GroupId" .`,
run 2026-08-08). There is no type definition, no `schema/` entry, no identifier form, no rule for how
a group is created, named, renamed, dissolved, drawn, exported, or reconciled when two writers group
overlapping sets. Four specific holes, each of which has to be filled before anything is built:

1. **It is not in `schema/`.** ADR-0008 is unambiguous. `62`'s grammar governs adding it.
2. **It has no identifier form.** `.context/conventions.md` § *Identifiers* fixes node IDs as
   `<kind-lower>:<ulid>`. A group is not obviously a node, and if it is one it needs a kind.
3. **The keybinding collides.** *"pressing `G`"* — but `53` binds `g g` / `G` to *first / last* in any
   list, and ADR-0024 makes `53` the sole owner of the keymap. `56` may not bind `G`.
4. **It is a different thing from `56` §3.7's `Group by zone` / `Group by site` / `Group by routing
   instance`.** Those are layout **commands** computed from graph data the user did not author;
   `Pin::Grouped` is a user-authored set. The two share a word and nothing else, and shipping both
   under one name is how a picture becomes unreadable.

#### 10.3.2 `tag` — not a gap in the design, an absence from the model

There is no tag in `schema/` and none in the design documents. Grepped 2026-08-08: the seven
occurrences of the string `tag` in `schema/schema.yaml` are `Interface.vlan_tagging`, two mentions of
a **tagged union** as a value shape, three mentions of a **tagged unit** — `LogicalUnit.vlan_id`'s
emit predicate, its `VERIFY` note, and the `AttachesTo` edge's doc explaining that a UNI is
frequently one — and `Cable.label`'s prose, *"the tag on this cable"*. **None of them is a
user-applied label on a node.**

Two things must be said about it, and the second is the one that decides how it is treated.

**It is not the free-floating clutter `56` §1.3 refuses.** That row puts *"free-floating annotations,
text boxes, arrows that are not edges, clip art, background images"* out of scope, and the reason is
that those things are not statements about anything — they float over a picture and decay into
graffiti. A tag is the opposite: **a user-authored fact about a real device**, attached to a node
with a stable ID, surviving a rename because `56` §3.5's own argument for positions applies
identically. *"These four switches are the ones we are replacing in Q3"* is estate-of-record content,
which is one of this product's two co-equal goals.

**And it is therefore a schema question before it is a design question.** A tag that is real is a
kind or a field in `schema/`, with an identity rule, a provenance origin (`Origin::Hand`, which
`11` §8.7 deliberately does not age), an emit column reading `—`, and a decision about whether it is
free text or a controlled vocabulary. It is also, unavoidably, a **new plaintext channel in the
workspace**, which puts it in front of §2's rank 1 before it goes anywhere near a diagram: a tag
field is somewhere a user can type a credential, and invariant 3's ingest-gate redaction covers
pasted configuration, not typed prose.

**RECOMMENDATION —** treat `group` and `tag` as one planning item and not two, because they have the
same shape: a user-authored set or label over nodes, needing a schema entry, an identity rule, a
persistence story and a sync story before any of it is drawn. Neither is designed here. Both are
listed in §13.

### 10.4 Grouping and tagging — the recommendation, 2026-08-08

The owner asked: *"the thing is I genuinely do not know what the best way is. recommendations?"*
Researched across five lenses — what the model already expresses, what the design has decided
nearby, outside practice, this project's own constraints, and the known failure modes — with every
claim handed to a separate pass instructed to refute it. **Twelve claims held, none were refuted.**

**The finding that shrinks the question.** Most of what people reach for tags to do, the model
already does, and in some cases already forces:

| Wanted | Already expressible |
|---|---|
| *"these five are the Springfield site"* | `HasDevice` containment runs `Site → Device` with `in: 1`. Every device belongs to exactly one site and **cannot not** |
| *"which are branches"* | `Site.criticality` is already `core \| branch \| lab \| dc` |
| *"all the firewalls"*, *"all the SRXs"* | `Device.role` (`firewall \| router \| switch \| load_balancer \| other`) and `Device.platform` |
| *"everything for Acme"* | `Tenant` is a kind with customer/internal, code, account reference and contact; services hang off it |
| *"the kit at 412 Oak St"* | `Premises` covers CO, hut, cabinet, DC, customer premises, pole, handhole; a site points at one |

So the estate's organisation is **not** the open question. Three things are genuinely left over:

1. **Notes** — what the engineer knows that the config does not say. `Premises` has a notes field;
   `Service` and paths have descriptions. **`Site` and `Device` have nothing.**
2. **Cross-cutting sets** — *"the Q3 firewall refresh"*: three SRX clusters at two sites, an MX,
   two EX stacks and a customer service. It cuts across sites, tenants and kinds, so no containment
   tree can name it, and everything in the model is a containment tree.
3. **Lifecycle** — *"decommissioning in June"*, *"cold spare"*. Real, changes monthly, fits no enum
   worth freezing.

**RECOMMENDATION — build a `Group`: a named set, created deliberately, holding members by opaque ID.
Do not build free-text tags. In this order.**

1. **A notes field on `Site` and `Device`**, matching the one `Premises` already has. Nearly free,
   and it is the honest way to discover what the group names should be: write notes for two months,
   read them back, and the four or five groups actually needed are there in the owner's own words.
   Designing a tag taxonomy up front is how a vocabulary nobody uses gets built.
2. **`Group`** — a new kind (name, optional description, optional colour) and a membership edge to
   anything. It is a node like any other: it gets `group:<ulid>`, lives in the workspace, survives
   renaming everything it points at, and appears in the finder. Membership is by selection, never by
   typing a string.
3. **Then nothing, and revisit lifecycle later.** The expectation is that *"decommissioning in
   June"* becomes a group with eleven members — better than an enum, because the customer's service
   and the physical patch panel can be in it too, which no device-status field could hold.

**Why a created object rather than free text.** Two mature systems reached the same conclusion:

| Source | Read | What it says |
|---|---|---|
| NetBox v2.9 release notes | 2026-08-08 | *"Tags are no longer created automatically: A tag must be created by a user before it can be applied to any object."* — they changed this and did not reverse it |
| NetBox Tag model docs | 2026-08-08 | A Tag is a first-class registered object: name, slug, colour, weight, and a list of object types it may be applied to at all |
| AWS tagging best practices | 2026-08-08 | Free-text tags, and the guidance is manual compensation — *"decide whether to use Costcenter, costcenter, or CostCenter, and use the same convention for all tags"* |

**Why it fits this product specifically.** `53` refuses modes outright — *"No modes. No mode
indicator. No mode errors."* — and *"select things, add to group"* is one action against a
selection, where *"tagging mode"* is a mode. And it stays inside `56` §1.3's out-of-scope list: a
note is a field on a real object and a group is a view of real data, not a free-floating annotation,
text box or sticky note on the canvas.

**Failure modes, and the mitigation for each:**

| Risk | Mitigation |
|---|---|
| Near-duplicate names (*Q3-refresh*, *Q3 Refresh*) | The picker offers only groups that exist; creating one is a separate, visible action. Exactly NetBox's change |
| Dead groups accumulating | Show member count and last-changed; sort by staleness; **archive, never delete** — old work stays readable |
| A group quietly becoming a second, contradictory site model | When a proposed membership is exactly an existing site, tenant or role, say so and offer the existing one. Cheap check, kills the class |
| A credential typed into a note | Pasted config passes the ingest redaction gate; a hand-typed sentence does not. Say so once, plainly, at the field |
| Membership pointing at names | **Already closed by invariant 7** — stable opaque IDs, *"renaming a device must not invalidate anything"*. Membership stores IDs |
| Colours | Not the three reserved for risk. A green group must never read as a clean finding |

**Cost, honestly.** One kind, one edge, two notes fields — then the real work, which is that each of
the six views must know how to filter by a group and how to draw one. The diagram in particular has
to decide what a group looks like when its members are scattered, and that is a design problem, not
a coding one.

**What it forecloses.** A device in two sites (already impossible; groups would paper over it, not
fix it). Labelling in one keystroke — creating a group is deliberately a step, and on the day the
owner wants a quick label it will annoy them. And **private labels**: groups live in the workspace
file and travel with it, so anyone handed the file reads them. No per-user layer is proposed.

**The two questions only the owner can answer are at §11.5 and §11.6.**

### 10.5 The box, the bag and the zoom ladder — the owner's words, 2026-08-08

Later on 2026-08-08, in answer to §11.5's *bag or box*:

> *"I'd say that a box is better, because if someone wanted to floor plan they could, just keep in
> mind to be dynamic about it, let users rearrange as needed, or let the system dynamically allocate
> if they want. Also keep in mind floors exist, or networks that span multiple buildings and such."*

Then, unprompted, that the box is scale-free:

> *"a box could be the network layout of a single device shouldn't it? Because keep in mind this is a
> learning tool as well, so seeing how it routes inside the box is pretty good, like control vs
> dataplane and etc, and even CVEs could maybe reflect that as well in the future, we don't want to
> work on those atm."*

On whether one picture can carry all of it:

> *"I mean we need to somehow account for all of them? Maybe even different views, where it's
> physical, vs vlans, vs etc"*

And the ladder, in full:

> *"physical is per single piece of equipment and how its setup internally, accounting for if there is
> no information or little then just show what is available, of course it'd be like two sections for
> most equipment with control vs dataplanes though not everything has that separation. Then you zoom
> out to be a rack, zoom out for a floor(s) with multiple floors and connections between them and
> such with the option to upload a drawing or something as the background. Then you zoom out into
> buildings, zoom out further into i guess like map sizes essentially. But then there's vlan views,
> vpn views, etc etc?"*

The owner agreed to the resolution set out in §10.6–§10.12. **Nothing in those sections is a new
owner decision.** They are readings of the words above, plus the consequences a planning session is
obliged to state — including, at §10.10, a reversal of a written refusal, which is recorded with its
costs rather than made quietly.

**What this does to §11.5, precisely.** §11.5 asked *"do you ever need a site inside a site?"* and
offered bag and box as alternatives. The answer is **yes to the box**, and it arrives as a **place
hierarchy** rather than as nested `Site`s (§10.8). It does **not** withdraw §10.4's recommendation for
a `Group`, because a bag and a box answer different questions and the owner did not address
cross-cutting sets in these words at all. §11.5 is therefore **partly answered**; the residue — is the
`Group` still wanted alongside the place hierarchy — is §13 item 20.

### 10.6 Zoom and view are two independent axes, not one list

The ladder and the layer list are not one enumeration, and reading them as one is the mistake the
owner's last sentence — *"But then there's vlan views, vpn views, etc etc?"* — is pointing at. **Zoom
is how far out you are standing. View is which relations are drawn.** They compose.

| Axis | Values | State |
|---|---|---|
| **Zoom** | inside-a-device → rack → floor → building → map | New. §10.8 is the model half, and it is a proposal |
| **View** | physical / L2 / L3 / security / overlay | **Already decided.** `56` §4 — five layers, toggled independently, a 5-bit `LayerMask` |

Five views against five zoom stops is twenty-five pictures if they are enumerated and **two
mechanisms** if they are not. **There is no per-combination design and there must not be.** `56` §3.6
already carries the argument in its layer half, as a DECISION: layout is computed once over the union
of all layers and a toggle *filters* what is drawn, because the alternative is *"31 layouts, 31 sets
of positions to store"*. Extending the same shape along the zoom axis is proposed in `56` §13.2; it is
not decided here, and `56` owns the diagram.

**One naming collision, named because it will otherwise be inherited.** The owner's *"physical is per
single piece of equipment"* uses *physical* as the **innermost zoom stop**. `56` §4 uses *physical* as
a **view**. They are different axes wearing one word, which is precisely why the axes have to be
separated by name before anything is built.

### 10.7 Zoom is navigation; containment is structure. They are different things

You may zoom into a device. Inside a device, things do **not** nest as boxes, and the model already
says so. Verified in `schema/schema.yaml`, 2026-08-08:

| Relation | Class | Cardinality | What it says a `LogicalUnit` is |
|---|---|---|---|
| `HasUnit` — `InterfaceLike → LogicalUnit` | `containment` | `in: "1"` | in **exactly one** interface |
| `ZoneMember` — `Zone → LogicalUnit` | `reference` | `in: "0..1"` | in **at most one** zone |
| `InRoutingInstance` — `LogicalUnit → RoutingInstance` | `reference` | `out: "0..1"` | in **at most one** routing instance |
| `VlanMember` — `LogicalUnit → Vlan` | `reference` | `in: "0..n"` | in **many** VLANs at once |

So: **exactly one of a unit's memberships can be drawn as an enclosure, and every other one is an
overlay over the same positions.** A nested-box drawing of the inside of a device is expressible for
`HasUnit` and is *unrepresentable* for `VlanMember` — a thing cannot be inside two boxes — and no zoom
stop changes that. **Box = containment. Band or bracket = reference.** The model draws the line
already; the recommendation is only that the drawing match it.

**Zoom is therefore navigation, not a new containment level.** Zooming into a device must not create a
parent-child relation the graph does not have. `56` §0's governing rule is the control: *"IF A FACT
EXISTS ONLY IN THE PICTURE, THE PICTURE HAS BECOME THE DATA STRUCTURE."*

**One mismatch, named rather than fixed.** `56` §4.1 does not assign its marks by edge class today.
`Site` is a **containment** parent (`HasDevice`, `in: "1"`) drawn as a **band**; `RoutingInstance` is
reached by a **reference** edge and drawn as a **box** (`56` §4.3). The box/bracket/band choice in
`56` §4.3–§4.5 is driven by whether members are contiguous, which is a defensible basis and is not
disturbed here. The narrow rule §10.7 asks for is the one that survives both: **nothing may be drawn
as an enclosure for a relation a node can be in twice.** `56` §4.5 already obeys it — the VLAN band is
an open horizontal bracket, suppressed above six. Carried in `56` §13.3.

### 10.8 The place hierarchy nests — PROPOSED, and it needs no new concept

Verified in `schema/schema.yaml`, 2026-08-08:

- `HasPremises` is `class: containment`, `from: [root]`, `to: [Premises]`, `in: "1"` — **every
  `Premises` hangs directly off the workspace root, so places are flat.**
- `AtPremises` is `class: reference`, `Site → Premises`, `out: "0..1"`, `in: "0..n"` — a site points at
  one premises, and several sites may share one.
- A `Premises` already contains things: `HasPassiveNode` (`Premises → PassiveNode`), and
  `HasExternalPeer`, whose `from` was already widened to `[Site, Premises]` (`19` §5.1).

**The proposal: widen `HasPremises` to `from: [root, Premises]`, keeping `in: "1"`.** One line. It
keeps containment a forest, and it gives campus → building → floor → room → rack **with no new kind**,
because `Premises` already carries a `form` enum and `19` §3.5's design deliberately makes one kind
serve a central office and a customer location alike.

**Three costs, all of which must be settled before that line is written:**

1. **The `form` enum has none of those values.** It is
   `central_office, hut, cabinet, headend, data_centre, customer_premises, pole, handhole, other`.
   Campus, building, floor, room and rack are absent, and `62` §7 governs adding them.
2. **`19` §3.5's sibling query stops being two hops.** *"There is more than one of these at this
   address"* is specified as `premises_of(d) <-AtPremises-- Site --HasDevice--> Device`, at
   `O(1) + O(deg)`. Under nesting, *"at this address"* becomes ancestor-or-self and the traversal is a
   walk rather than a hop.
3. **Devices hang off `Site`, not off `Premises`.** `HasDevice` is `Site → Device`, `in: "1"`, so the
   place tree and the device tree meet only at `AtPremises`, which is a **reference**. **A rack that
   contains devices is therefore not expressible by nesting `Premises` alone** — either `HasDevice`
   widens the way `HasExternalPeer` already did, or a rack is a `Site`. Nobody has decided which, and
   it is the load-bearing question under the ladder's bottom three rungs.

**This is a proposal and nothing was executed.** No file under `schema/` was touched. `62` governs the
edit, ADR-0008's rule stands, and until it is in `schema/` a nested premises does not exist. §13
item 16.

### 10.9 *"Network"* is a bag, not a container — and this answers `76` §8 Q1

`76` §8 **Q1** asks *"What is a 'network', and how many devices are in one? Are they routing domains
inside one estate, or separate customer/market estates?"*, and marks itself as one of three questions
that gate S0's inputs. The owner's *"networks that span multiple buildings and such"* settles it:
**a network crosses places, so it cannot be a place and it cannot be a container.**

`76` §8 **Q2** asks *"Do cables cross network boundaries?"* and states the consequence in the same
breath: if they do, one-network-per-workspace is *"dead on arrival"* — `11`'s edges are
`NodeId → NodeId` inside one graph, and *"no edge can span two sealed containers under different
keys"*. **Q1's answer removes Q2's premise.** If a network is not a container there is no boundary for
a cable to cross, and the question does not arise in the form Q2 poses it. Q2 is therefore not
answered so much as **dissolved**, and that distinction is kept because a later reader may reintroduce
a container and reintroduce the problem with it.

**The operative statement: one workspace is one estate.** A *"network"* is a **bag** — a named set over
nodes that already live in the estate — which is exactly the shape §10.4 recommends for `Group`, and
whose failure modes and mitigations §10.4 has already priced. It is not a second workspace, not a
sealed compartment, and not a second graph.

**Note the two halves do not contradict.** The owner said *"a box is better"* and this section says a
network is a bag. Both hold, because they are about different things: **places** are boxes (§10.8) and
**networks** are bags. That is the same box/bag distinction §11.5 drew, applied to two different
subjects rather than forced onto one.

### 10.10 Background images — a REVERSAL, PROPOSED, with its costs stated

The owner asked for *"the option to upload a drawing or something as the background"* on the floor
view. `56` §1.3's out-of-scope column currently reads, in full:

> *"Free-floating annotations, text boxes, arrows that are not edges, clip art, background images"*

**This is a deliberate reversal of a written refusal and is recorded as one, not slipped in.**

**The argument for it.** Every other item in that row is **decoration** — a mark that is not a
statement about anything, floating over a picture and decaying into graffiti. That is the same
reasoning §10.3.2 used to rescue `tag` from the same row. A floor plan is not decoration: it is a
**spatial reference**, the thing the positions are positions *in*. It makes a coordinate mean
something, which is precisely what the rest of that row does not do.

**Four costs. None of them is small, and the fourth is the one that is unanalysed.**

| Cost | Detail |
|---|---|
| **Size — and it is the one thing in the file the product does not control** | `44` owns size budgets. Its gate (`44` §5.5) covers **build artifacts** — `A1 ≤ 4.5 MB`, WASM, finder index, rule pack — and nothing in it covers workspace *content*. `17` §13.2's derived figures put a 50-device all-hand-modelled workspace at **0.6 MB** on disk and a realistic 30 %-parsed mix at **8 MB**. An imported image's size is chosen by the user, not by the product, and it is the only thing in the workspace of which that is true. `44` §5.1's distribution row is the operative constraint: *"a 4 MB attachment goes through email; a 40 MB attachment does not"* <!-- VERIFY: the size of a real scanned or exported floor plan of a building an engineer would use, before the claim that one image can exceed the rest of a workspace is repeated as anything but a plausibility. No such figure exists anywhere in this tree. --> |
| **Opacity — it is unverifiable in a file where everything else is verifiable** | Every other value in the workspace has a provenance the product can inspect: parsed values carry their originating line and their age (`11` §8.7), typed values carry `Origin::Hand`. **Nothing can tell whether an image is current, or even of the right building.** `56` §1.2 already refuses to let the diagram claim currency — *"The view never says 'current'"* — and the argument bites harder here, because a wrong typed field usually looks wrong and a wrong floor plan does not |
| **Every export loses it** | `34` §5.6's closed SVG tag set (read 2026-08-08) bans `<image>` outright, alongside `<script>`, `<style>`, `<use>` and `<a>`, and `56` §9.3 repeats it for the export path. So the background is present in the application and **absent from every exported picture**. That asymmetry has to be stated **at the export**, not discovered afterwards — `56` §9.2 rule 1 already requires that an export contain exactly the visible set and that the header say what it dropped |
| **It puts an image decoder inside the trust boundary, and nobody has looked at that** | A user-supplied image is bytes handed to the browser's decoder. `34` has **no section on image decoding**: grepped 2026-08-08 for *decoder*, *jpeg*, *bitmap*, *raster* — **zero hits**. So this surface is **unanalysed, not analysed and cleared**. **No claim is made here about it in either direction.** ADR-0034 forbids answering that from memory, and this document does not answer it; it logs it for `34`'s owner. §13 item 19 |

**One thing this reversal does *not* cost, stated because it is the first question a security reader
asks.** It needs **no CSP change**. `34` §2.7 (read 2026-08-08) fixes `img-src` at `data:` in mode A
and `'self' data:` in modes B–D, and retains `data:` deliberately *"because the diagram export and the
risk legend need inline SVG data"*. A `data:`-URI background is inside that policy already. This is
unlike `56` §9.4's PNG-export request for `img-src 'self' blob:`, which `56` §12 correctly records as
a real widening. **The reversal asks for no widening of `34`.**

**And one adjacent channel that is not this document's to settle.** A floor plan of a customer's
building is plausibly the same class of content as `Premises.street`, which `schema/schema.yaml` marks
*"Personal-data channel — 37 §2.2"*. `37` owns that question and has not been asked it.

**Scope of the reversal, stated narrowly on purpose.** It covers **a spatial reference image behind a
place-scoped view**. It does not reopen free-floating annotations, text boxes, arrows that are not
edges, or clip art, all of which stay refused for the reason that has always been given. `56` §13.6
carries the PROPOSED form; `56` owns the diagram and therefore owns the answer. §13 items 17 and 18.

### 10.11 *"Show what is available"* is already the house rule — and the line next to it

> *"accounting for if there is no information or little then just show what is available"*

**This is existing behaviour, not a new requirement**, and saying so is the useful part: it means
nothing has to be built for it and nothing may be quietly relaxed against it.

- **The model is partial by construction.** `11` §2.2 rejects the total-population assumption and
  calls the consequence *"the single largest structural divergence in this document"*: a four-state
  `Presence`, four-outcome rule evaluation, and an emitter that reports blockers.
- **What is dropped is counted, never hidden.** `56` §5.5: *"a diagram tool that silently drops
  labels is a diagram tool that lies about what it drew."* `59` §6.2 files the one place the base
  breaks it, which is what a rule with teeth looks like.
- **A gap is never filled with a guess.** `56` §11 failure mode 15 is exactly this — a connect gesture
  that fills in a DH group so the config *"just works"* produces *"a value nobody chose, provenance
  `Hand`, and a rule that reads it as intentional"* (`56` §6.4.3, `11` §8.5).

**Control plane versus data plane is asserted by the corpus, per platform — it is not a shape the
renderer assumes.** The owner's own clause is the requirement: *"though not everything has that
separation."* A renderer that always draws two sections is asserting a fact about hardware nobody told
it. Under invariant 5 and ADR-0008 the split is per-platform **content** — a fact about a platform,
authored and reviewed by a named human under invariant 10 — and where it is absent the device draws as
one section.

**The line that sits one word away, stated so a future session does not drift across it.** `11` §2.2
permanently rejects control-plane and data-plane **simulation**, and states the consequence in the
same row: *"Fathom cannot answer 'where does this packet go'."* **Drawing that a box has a control
plane and a data plane is structure, and it is in scope. Predicting which of them a packet traverses
is simulation, and it is refused.** The two are a single word apart in ordinary speech and the corpus
has one sentence separating them.

### 10.12 CVEs — parked, by the owner

> *"even CVEs could maybe reflect that as well in the future, we don't want to work on those atm."*

**Parked on the owner's instruction**, and recorded here so it is not re-raised later as though it were
new.

It is the same question §7.4 half two already carries under a different name — **known-defect
advisories** — and §7.4's finding transfers unchanged: **the hard part is not the schema and it is not
the display, it is sourcing and staleness.** Where the data comes from (invariant 2 means the product
can never fetch a vendor defect database), who is named against it under invariant 10, and what the
product says when an advisory has gone stale. §13 item 8 already holds it; **no new row is opened**,
because opening a second row for the same question is how a corpus grows two answers to it.

## 11. Questions still outstanding

Two questions were asked in jargon and could not be answered. Re-asked here in plain language;
both remain open and both are owner-only.

### 11.1 Do you still work on Juniper SRX firewalls? — **ANSWERED 2026-08-06, see §7**

*(was: "is SRX/IPsec retired, carried, or frozen?")*

Everything Fathom knows today is about one subject: building and troubleshooting site-to-site
IPsec VPN tunnels on Juniper SRX firewalls. That is all 177 entries — 98 commands, 37 rules,
42 explainers — written from the owner's own four-side field card. `77` describes a different job:
Calix and Nokia access gear, CLLI-coded sites, DIA and E-Line and E-LAN with per-location UNI IDs.

The two do not overlap at all. A case-insensitive search of the whole of `corpus/` for `calix`,
`nokia`, `clli`, `fttx`, `gpon`, `olt`, `ont`, `pon`, `e-line`, `elan`, `dia` and `uni` returns
**zero matches**; `76` §6.5 puts the transfer at *"effectively zero — call it 0 of 177"*. Meanwhile
the data model has already moved: `schema/platforms.yaml` registers `calix`, `nokia` and `adtran`
as vendors, and the schema carries `Tenant`, `Service`, `ServicePath`, `PhysicalPort`, `Cable`,
`Premises` and `Site`. The knowledge has not followed.

**The question:** is the Juniper firewall work still what you do most weeks, occasionally, or
hardly at all any more?

What turns on it: two of the eight queued work orders (WO-03 ingest, WO-04 emitters) are written
end-to-end against Junos syntax; ADR-0029 orders six SRX corrections as a gate; ADR-0030 commits
2–3 weeks to Palo Alto chosen purely as a second *firewall*. All three were reasoned inside the
firewall world.

### 11.2 When Fathom finds this problem, what should it point at?

*(was: "may a rule anchor on an edge?")*

The problem is real and the field card calls it the most-missed step: on an SRX, the interface a
VPN runs over must be given permission to accept incoming IKE packets. If it is not, the firewall
silently drops the far end and the log says nothing.

The awkwardness is that the fault belongs to neither thing on its own. It is not a property of the
interface, and not a property of the zone — it is a property of the *pairing*: **this interface,
inside this zone, does not admit IKE.** Fathom must hang the warning off something, and that choice
decides what the user sees.

| If the warning attaches to… | The user sees | And the one-click fix… |
|---|---|---|
| **the interface** | A warning on `ge-0/0/0.0`, wherever that interface appears | opens IKE on that one interface |
| **the zone** | A warning on the `untrust` zone | opens IKE on **every interface in that zone** |

**The question:** when Fathom flags this, should the warning sit on the individual interface, or on
the zone it belongs to?

**A security note the owner should have before answering, given §2 rank 1.** The fix is currently
written to open IKE on one interface. If the warning moves to the zone and the fix moves with it,
the fix widens to every interface in that zone — which is the exact regression `87` R03 was written
to prevent. That argues for the interface, but it is the owner's call and the corpus is genuinely
split: four documents disagree today and no code catches the disagreement (`88` §4.5).

### 11.3 Is Meraki configured by text you can copy and paste?

Every other platform on the owner's list is configured by text an engineer selects from a terminal
and pastes. That is not a convenience — invariant 2 makes paste the **only** on-ramp the product
will ever have, permanently, and `03` §4.5 confirms *"config paste is the primary on-ramp"*.

Meraki is Cisco's cloud-managed line. Whether it presents a comparable pasteable device
configuration is not asserted anywhere in this tree and is not asserted here; no Meraki artifact
exists in the repository, and conventions forbid stating a vendor behaviour without a primary
source.

**The question, in the owner's terms:** when you work on a Meraki device, is there a screen or an
export that gives you its configuration **as text you can select and copy**? If yes, what does it
look like — is it a CLI-style listing, a JSON or YAML export, a downloaded backup file?

Why it is not a small question. If the answer is *"no, you configure it in a browser and there is no
text"*, then Meraki cannot be a platform under invariant 2: the only ways in would be a file export
(a different input shape, which `17` §… covers for import but which no parser targets today) or an
API call, which the product will never make. That would be a boundary finding, not a scheduling one,
and it belongs in `03` alongside the other eighteen boundaries rather than in the queue.

**The cheapest way to settle it:** one real Meraki configuration export, however small, with any
credentials removed. That is the same S0 fixture pattern `76` §7.3 already asks for.

### 11.4 The bridge with ten links — were they ten of the same thing? — **ANSWERED 2026-08-08, see §10.1**

*(was: were the ten links going to ten similar things, or to a mix?)*

The question offered two answers and the real one was a third. The owner's device is **two nodes —
core and bridge — joined by ten standalone 10G links**: one neighbour, ten parallel edges. Not ten
neighbours of one kind, and not ten neighbours of mixed kinds.

Both of the offered answers assumed *many neighbours*, which is the defect §10.1's correction
records: the question was framed from the analysis rather than from the device, and the owner
answered the device. The lesson is §15 item 1's, again — a question for the owner is phrased in terms
of what they would see.

`59` §3's six-sibling rule does **not** already handle it, in either offered reading: its five levels
count nodes and none of them counts edges. `59` §3.13 states the finding and `59` §3.14 proposes the
rule. **The mixed-neighbour case is still unanswered and still unowned** — it was never the owner's
example, so answering this question did not close it. §13 item 10.

### 11.5 When you say "group", do you mean a bag or a box? — **PARTLY ANSWERED 2026-08-08, see §10.5**

A **bag** is a set of things you point at — *the Q3 refresh*, *PCI scope*, *everything on Sunday's
window* — and one thing can be in several bags at once. A **box** is a place inside a place — a
campus containing three buildings, a region containing eleven sites — and a thing is in exactly one.

§10.4 recommends the bag. If what the owner keeps wanting is the box, that is a **different and
smaller** change — a `Site` that can sit inside another `Site` — and it is worth building the right
one rather than the recommended one.

**The question, in one sentence: do you ever need a site inside a site?**

**Answered in part.** *"a box is better … keep in mind floors exist, or networks that span multiple
buildings"* (§10.5). Yes to the box, delivered as a **place hierarchy** (§10.8) rather than as nested
`Site`s — and separately, a *network* is a **bag** (§10.9), so both shapes survive and neither wins
outright. What is **not** answered is whether §10.4's `Group` is still wanted alongside the place
hierarchy; the owner did not address cross-cutting sets in those words. §13 item 20.

### 11.6 Should your groups travel with the file?

Groups as recommended live in the workspace and go wherever the file goes, so anyone opening it
reads them — including the one called *chase this before the customer notices*. If some labels are
notes-to-self that should not travel, that is a **separate storage decision** and it is far cheaper
designed in than bolted on.

**The question, in one sentence: are your groups something you would be happy for anyone opening the
file to read?**

## 16. Incomplete paths, and telling two devices apart — 2026-08-09

Two questions were put to the owner on 2026-08-09. He rejected the framing of both, and was right
about both. His words are reproduced first because the correction is in the wording.

### 16.1 The question that was asked badly

> *"When Fathom emits a tunnel, is that output meant to be pasted onto a box that already has its
> WAN interface — or must it contain every statement needed to bring the tunnel up on a box whose
> config is blank?"*

**The answer, verbatim (2026-08-09):**

> *"What? i mean if you have a P2P ELINE or tunnel, vpn, etc, it should stil route as it should. If
> not all the info is available how it routes then there needs to be like a dotted line or something
> indicating that or something. I know we had the warp idea for physical?"*

**What was wrong with the question.** It offered two options and both were wrong, because both
assumed the only two outcomes are *emit everything* and *emit nothing*. The owner's answer names a
third that the corpus already specifies and the question did not consider: **represent the path,
and mark what is not known about it.** A tunnel whose middle is unknown is still a tunnel that
routes; refusing to draw it, or refusing to emit it, discards a fact the operator has in order to
avoid stating one they do not.

**He is right that this is already designed, and he named it correctly.** `19` §6 is *"The path and
the warp"*, and it decides exactly this:

> **DECISION — the warp is stored data (a path segment with `kind: Warp` and two named ports). Its
> expansion is derived.**

`SegmentKind` is `{ Physical, Warp, Boundary }` (`schema/enums/segment_kind.yaml`), `PathSegment`
carries `warp_technology: enum { L2Ptp, Pseudowire, Evpn, Vlan, Other }` — which is a P2P E-Line,
in the schema, by name — and `WarpResolvesVia` is a derived edge produced by
`infer.service.warp.resolve`. `19` §6.3 already separates the three states the owner's sentence
distinguishes: *"here is what it crosses today"*, *"I looked and there is nothing there"*, and *"I
have not looked"* — kept structurally apart rather than collapsed into one error.

**And the treatment he reached for is the one the design system already reserves.** `51` §9:

| Token | Value | Meaning |
|---|---|---|
| `--rule-style-proposed` | `dashed` | AI output. **Nothing deterministic in this product is ever drawn with a dashed rule** |
| `--rule-style-pending` | `dotted` | *"an unanswered question, not a defect"* |

*"There needs to be like a dotted line"* lands on `--rule-style-pending`, whose own comment is a
paraphrase of what he asked for. **Dotted, not dashed** — the distinction matters and is
load-bearing, because dashed is reserved product-wide for AI-proposed content and a warp is not a
proposal.

### 16.2 What this decides, and what it does not

**Decided.** An incompletely-known path is **drawn and recorded**, never refused. Where the
interior is unknown the segment is a `Warp`, and an unresolved warp renders `dotted`.

**Not decided by this answer, and not to be read into it: what the *emitter* does.** A picture can
say *"I am not sure about this part"*; a block of config text pasted into a live router cannot.
`13`/`52`'s emit surface has no dotted line. The owner's principle — *represent what you know, mark
what you do not* — translates to emit as **emit the statements that are known and name the
assumption**, rather than refusing the whole tunnel because one interface was never in the paste.
That is the reading this document takes forward, and it is a reading, so it is flagged rather than
executed: WO-04 is the order that must state it, and it must be put to the owner as *"here is what
Fathom would hand you, and here is what it is assuming"* rather than as a yes/no.

**A gap this answer exposed.** `56` (the diagram view) does not mention `PathSegment`, `Warp` or
`SegmentKind` anywhere — a full-text search returns nothing. The model has warps and the picture
specification does not know they exist. Found by the owner's question, not by any gate. Filed in
§13.

### 16.3 Telling two devices apart

**The answer, verbatim (2026-08-09):**

> *"I mean that's a very important thing, idk how this is a question?"*

**He is right, and the question is withdrawn.** It is not a question for the owner: it is important,
its shape is determined by what a config file actually contains, and asking a network engineer to
specify a schema tuple is the same defect §15 disagreement 1 already records — *"a question for the
owner is phrased in terms of their work and what they would see, never in terms of the data model."*
This one should never have been asked at all, in any phrasing, because the answer is derivable and
the deriving is the project's job.

**Answered instead, and executed the same day.** `schema/schema.yaml` now declares:

```yaml
- kind: Device
  identity:
    - [ hostname, platform ]              # tier 1
    - [ platform, management_address ]    # tier 2 — survives a rename
- kind: Site
  identity:
    - [ code ]                            # tier 1
    - [ name ]                            # tier 2
```

Three things make this the answer rather than a guess:

1. **`11` §10.4's re-identification algorithm was never missing an answer about the *inside* of a
   device** — it takes *"capture `C` with `device: D`"* as an input, so it already maps a re-parse
   onto existing interfaces, zones and gateways. The only thing it lacked was the root: which box a
   fresh paste belongs to. That is one tuple, not a subsystem.
2. **Tier 1 is the only pair a config always carries.** `hostname` is `card: 1` and `platform` is
   stamped from whichever dictionary read the capture. It is the pair rather than the hostname alone
   because a `core-01` SRX and a `core-01` Nexus are two boxes.
3. **Tier 2 is honest about being rarely usable.** `management_address` is `0..1` and no junos-srx
   dictionary entry populates it today. A renamed box with no recorded management address is not
   re-identifiable from its text, and the answer there is to ask the operator — never to match on
   something weaker.

**Effect, immediately: the schema checker's standing two-warning baseline is gone.** It was two
`schema.identity.unexercised` against `Site` for the whole of the tree's life, because the
`SiteList` import scope claimed tiers 1 and 2 of a kind that declared none. `fathom-schema-check`
now reports **0 failures, 0 warnings**, and `crates/fathom-schema/tests/shipped_tree.rs` pins the
empty set so the next warning of any code fails a test.

**Still open, and genuinely a UX question rather than a model one:** what Fathom does when tier 1
matches and the operator meant a different box — two real branches whose SRXs are both
`core-01`. A match is a **proposal to a human, not an automatic merge**, and what that proposal
looks like is `53`/`54` work. Filed in §13.

### 16.4 Engines as separate files — 2026-08-10

Asked which way the artifact should grow past `44` §5.2's ceiling — one bigger file, or a program
plus a knowledge file — the owner answered with a third shape:

> *"oh I was thinking engines would be their own thing (s) like each their own fine? in an engine
> folder. does that fix this?"*

**It is a better shape than either option offered, and the honest answer to *"does that fix this"*
is: it fixes the half that grows without limit, and it does not fix the half that is actually
large today.** Both halves were measured rather than estimated, on 2026-08-10.

**Measurement 1 — the vocabulary is not what is big.** Linking `fathom-ingest` and `fathom-weld`
into the module took it from 560,405 to 812,467 bytes: **252,062 bytes to teach Fathom to read
Juniper.** The Juniper vocabulary itself — all six `corpus/dict/junos-srx/*.yaml` plus
`schema/field-keys.yaml` — is **29,670 bytes**, under 12% of that. The other 88% is the machinery
that reads it: framer, lexer, shaper, redaction gate, binder, weld.

So moving engines to their own files saves roughly **30 KB per vendor, not 150 KB**. Worth doing —
vocabulary is the thing that grows forever, statement by statement, and it is exactly the thing that
should not be recompiled to add a line — but it is not the answer to the ceiling on its own.

**Measurement 2 — and this is the good news the measurement produced.** The expensive part, the
parser, is **shared across a whole vendor family**. Checked against Juniper's own documentation on
2026-08-10 rather than recalled (ADR-0034 §5): EX, M, MX, PTX, SRX and T Series *"all use the same
user interfaces and configuration mode commands in the Junos OS"*, and `show | display set` produces
the same flattened form on all of them. Juniper's own caveat travels with it and is not smoothed
away: *"CLI commands and options can vary by platform and software release."*

**Consequence for `70` §7's platform list, stated plainly: junos-mx and junos-ex are nearly free.**
They are the same parser and largely the same vocabulary as junos-srx — a set of extra statements
and a version predicate, not a new engine. The expensive engines are the genuinely different
vendors: PAN-OS, NX-OS and Meraki, each of which needs its own parser at something like today's
252 KB. Three of the six platforms cost almost nothing; three cost a parser each.

**Recommendation, and it is a recommendation rather than a decision.**

1. **Vocabulary in its own files, per engine, as the owner describes.** It is the unbounded half, it
   is corpus data rather than code, and `Dictionary::from_sources` already runs every gate on
   whatever it is handed — so a vocabulary file is checked input, not trusted input. The mechanism
   also already exists on the other side: the command corpus arrives as host-supplied `SourceFile`s
   at `OP_INIT` and only the dictionary does not use it.
2. **Parsers stay inside the one module.** There are realistically four of them (Junos, PAN-OS,
   NX-OS, Meraki), so the cost is *bounded* rather than unbounded, and — the load-bearing reason —
   **an engine file that contains code is a different security posture from one that contains
   data.** That is `38`'s territory to price, not a thing to adopt as a side effect of a size
   problem.
3. **The ceiling still has to move once, to a bounded number.** Four parsers plus persistence
   (measured +239,964) plus a rule evaluator plus a layout engine do not fit in 900,000 bytes
   wherever the vocabulary lives. Moving it once, with the four bounded costs named, is a different
   act from raising it whenever something does not fit.

**What this leaves the owner:** nothing, unless he disagrees with the recommendation. The
one-file-versus-two-files question he was asked is answered — one file, with vocabulary alongside —
and the remaining decision is `44`'s number, which is planning's under ADR-0001's precedence rule.

## 12. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **The verbatim quotes get "tidied"** into cleaner prose and the record stops being a record | §1's rule: quoting is exact, informality included. Any edit to a quote in this document is a defect |
| 2 | **§2's priority order is used to win arguments it does not settle** — it breaks ties between defensible options, it does not license overriding a written decision | §2's preamble; `78` §4 still governs anything a work order leaves open |
| 3 | **§6.1 is read as a specification** and someone builds correlation from it | §6.1 states there is no mechanism. It is a named gap; the design document does not exist |
| 4 | **The removal of phases (ADR-0031) is read as removing `71` §13.1's refusals** | §4's closing paragraph; ADR-0031 §Decision item 4 restates it |
| 5 | **§7's two questions go unanswered and the work proceeds on a guess** | Both are listed in `88` §8 and in `CLAUDE.md`'s owner-blocking list |
| 6 | **§10.8 is read as an executed schema change** and someone widens `HasPremises` | §10.8 says twice that it is a proposal and that no file under `schema/` was touched. `62` governs, ADR-0008 decides what exists. §13 item 16 |
| 7 | **§10.10's reversal is read as reopening the whole of `56` §1.3's out-of-scope row** — annotations, text boxes, arrows, clip art | §10.10's closing paragraph scopes it to a spatial reference behind a place-scoped view, and gives the reason the rest of the row stays refused |
| 8 | **§10.11's structure/simulation line is crossed** by a future session that finds *"control plane and data plane"* in scope and infers forwarding is too | §10.11's last paragraph, and `11` §2.2's own row. They are one word apart in speech and one sentence apart in the corpus |
| 9 | **§10.6's two axes are re-flattened into one list** and someone designs twenty-five pictures | §10.6's table, `56` §3.6's DECISION and its *"31 layouts"* argument, and §13 item 21 |

## 13. Open decisions

1. **Modes, or not modes** (§6.2). `53` refuses modes; the owner named two. Whether C-07 ships as a
   mode, a per-record state or a filter is a design decision nobody has taken. Planning proposes,
   `53` owns the answer under ADR-0001's precedence rule.
2. **Where cross-device correlation is specified** (§6.1) — a new `10-core` document, or a section
   in `14`. Planning decides; it should precede any code.
3. **Whether LLDP/CDP paste needs its own corpus format** or reuses the command-output shape.
   Unowned.
4. Both questions in §11, which are owner-only, plus §11.3's new one on Meraki.
5. **When `33` (the wire) is picked up.** ADR-0016 deferred it as *"git is the sync for v1"*;
   ADR-0031 retires v1 as a scoping device, so the deferral's phrasing no longer holds even though
   its evidence-based reasoning does. §8's load-balancing requirement lands on `33`. Planning
   proposes a trigger; the owner decides. This is the clearest single instance of the re-ranking
   ADR-0031 §5 hands to `73`.
6. **What `77`'s Calix/Nokia/DIA estate is, relative to §7's list.** §7 names the equipment the
   owner *configures*; `77` describes a service-provider estate of Calix and Nokia access gear with
   CLLI-coded sites and DIA/E-Line/E-LAN services. These may be the same job seen from two angles —
   the gear one configures versus the estate one records — or two jobs. Nobody has asked. It decides
   whether the access/service layer needs its own platforms and corpus, or only the inventory model
   it already has. Owner, one sentence.
7. **The target release per platform** (§7.5) — owner, one value each for `junos-srx`, `junos-mx`,
   `junos-ex`, `nx-os` and `panos`. There is no field for it in `schema/platforms.yaml` today and
   `62`'s grammar governs adding one. Cheap now; per-entry later.
8. **Sourcing and staleness for known-defect advisories** (§7.4 half two) — owner. Where the data
   comes from, who is named against it, and what the product says when an advisory is old. No field
   should be designed before this is answered.
9. **Whether the diagram partitions** (§10.2) — owner, but not yet. Per-`Site` views and how they
   relate. `56` §12 owns it; the recommendation is to decide it against a running diagram.
10. **Heterogeneous high-degree nodes** (§10.1) — planning, and **§11.4's answer did not close it**.
   The owner's example turned out to be parallel edges to one neighbour, not a mixed fan, so the
   mixed fan remains a real shape with no rule: `59` §3's Peer level is like-kind only, and `59`
   §3.14.6 states that the proposed parallel-edge key deliberately refuses to group it. Nobody owns
   it. Unblocked — it needs no owner answer, only a design pass against `56`.
11. **Whether the parallel-edge level is adopted** (§10.1's correction) — `59` §3.14 proposes a sixth
   aggregation level for many links between one pair of nodes, in `59` §9's fork form. `56` owns the
   diagram and therefore owns the answer. Three sub-forks travel with it, all in `59` §9: the
   threshold (six, imported from a derivation that was about a *vertical* stacked field and does not
   obviously transfer to a horizontal fan), the three-rail gap (a `56` §5.3 token, deliberately not
   chosen in prose because nobody has measured the render), and whether a `Cable` is drawn at all —
   which decides whether the count reads `10 links` or `10 cables`.
12. **`group` and `tag`** (§10.3) — the owner asked for both by name. `group` is one identifier
   mentioned once in the tree with no definition, no `schema/` entry, no persistence rule and a
   keybinding that collides with `53`; `tag` does not exist anywhere. Both are **schema questions
   before they are design questions** (ADR-0008), both are user-authored facts about real devices
   rather than the annotations `56` §1.3 refuses, and `tag` opens a new plaintext channel that meets
   §2 rank 1 first. Planning proposes the schema extension under `62`'s grammar; `56` and `53` own
   the surface and the keymap. **Nothing is designed in §10.3 and nothing should be built from it.**
13. **Node position is not in `schema/`** (§10.3). `56` §3.5 calls `LayoutHint` *"graph data, not view
   state"* and `56` §1.3 lists manual position as workspace-persistent, but no position field exists
   in `schema/`. Under ADR-0008 it does not exist. This blocks `move`, and `move` is the one verb on
   the owner's list that everyone assumes is already done. Planning; `62`'s grammar governs.
14. **A dictionary-load gate comparing each `scalar:` against the schema's declared type** —
    planning, and the most valuable item on this list relative to its size. On 2026-08-08 the weld
    was the **first code to put ingest and the store in one call**, and it immediately refused the
    shipped fixture: the dictionary binds `InterfaceLike.name` as `Identifier`, `schema/schema.yaml`
    declares `InterfaceName`, `fathom-emit` writes `InterfaceName` on the same keys, and **the two
    sides had disagreed since the day both were written with no gate able to see it** (WO-09 §10
    item 9). The fix is one line; the gate is what stops the next one. It belongs to whoever owns
    dictionary loading and wants a work order, not a drive-by.
15. **What the emitted artifact IS — a standalone configuration, or a fragment?** (WO-09 §10 item 2,
    analysed 2026-08-09.) `fathom-emit` writes `external-interface reth0.0` and never writes the
    statement that creates `reth0.0` — it emits six `security` statement families and no
    `set interfaces` at all. So **its own output cannot be read back in isolation**, and the
    round-trip gate cannot pass however the fixture is arranged. Either emit widens to declare what
    it references, or the round-trip property is re-stated to re-parse against the originating graph.
    **This is a product question, not a test question**, and it is the one the owner would recognise:
    *when Fathom hands you lines to paste, are they a complete config or a change set for a box that
    already exists?*

    **CORRECTED 2026-08-09. I framed this as config-or-change-set and both halves are wrong.**
    Researched across five lenses with every claim handed to a separate pass to refute: fourteen
    held, one was refuted, and the refuted one was mine.

    **It is not a change set**, decided in four independent places. `18`:370 — *"a statement whose
    text is unchanged produces nothing. That is what distinguishes a change set from a full
    config."* `config_diff` takes `emit(A)` and `emit(B)` as **inputs**, so emit's output is
    upstream of a change set and can never be one. `52` makes `Full` and `ChangeSet` two **modes of
    the config view**, `Full` the default. And WO-04 §8 non-goal 2 disowns change sets outright —
    *"doc `18`'s territory, later."*

    **It is not a standalone configuration either, unless the emit unit is `Device`.** `11`:1588 —
    *"for `junos-srx` the units are `Device` (whole config), `IpsecVpn` (a tunnel and everything it
    needs), `SecurityPolicy`, `Interface`, and `Tunnel`"*. **The parenthetical is attached to
    `Device` alone**, and the sentence had four further chances to attach it elsewhere.

    **What it actually is: a scoped assertion set** — complete for what it builds, referencing a
    device context it does not carry. `13`:63 states the working assumption the whole corpus shares
    without ever calling it a decision: *"output is text a human pastes… every design choice below
    assumes the output may be applied in part, out of order, or a week later."* And `14`:1029 treats
    *"fragment references a node the paste did not restate"* as **common, expected and resolvable**,
    not as an error.

    **So the question narrows to one thing, and it is a real one.** Must a `Full` emit of a
    non-`Device` unit be **closed under its own references**? `st0.0` is already settled in Fathom's
    favour — `80-reconciliation.md` R47 is **DECIDED** and requires the plumbing block, so the
    emitter must eventually declare the tunnel interface it creates. **`reth0.0` is the whole of the
    open question**, and no scope short of the whole device will ever contain it, because none of
    the five plumbing pieces creates a WAN interface — piece #3 only places an existing one in a
    zone.

    **The question for the owner, in one sentence:** *when Fathom emits a tunnel, is that output
    meant to be pasted onto a box that already has its WAN interface — or must it contain every
    statement needed to bring the tunnel up on a box whose config is blank?*

    **ANSWERED 2026-08-09 — and the question was still wrong.** §16.1 has the answer verbatim. The
    owner refused both options and named a third: an incompletely-known path is represented and
    **marked**, never refused. For the diagram that is settled and already specified (`19` §6's warp,
    `51` §9's `--rule-style-pending: dotted`). For **this** item — the emitter — it is a principle
    and not yet a mechanism, because a block of config text cannot carry a dotted line. **What
    remains open is narrower than what was asked:** WO-04 must state how emit *names the assumption*
    it is making about `reth0.0` in the text it hands over, rather than whether it emits at all. It
    emits. §16.2 records the reading and flags it as a reading.
16. **Whether a registered platform with no content should be visible in the product.** Five of the
   six platforms in §7.2 are registered names with no dictionary, no emitter and no corpus. A user
   selecting `junos-ex` today would get an empty product with no explanation. Design decision;
   `52` and `54` own the surface.
16. **Whether `HasPremises` widens to `from: [root, Premises]`** (§10.8) — planning proposes under
   `62` §6, and **nothing may be written to `schema/` before it is decided**. Two riders travel with
   it and neither is optional: the `form` enum needs campus/building/floor/room/rack values it does
   not have (`62` §7), and **a rack that contains devices is not expressible by nesting `Premises`
   alone**, because `HasDevice` is `Site → Device`, `in: "1"`. Either `HasDevice` widens the way
   `HasExternalPeer` already did (`19` §5.1), or a rack is a `Site`. That sub-question is the
   load-bearing one and it is unowned.
17. **Whether `56` §1.3's background-image refusal is reversed** (§10.10) — `56` owns the diagram and
   therefore owns the answer; `56` §13.6 carries the PROPOSED form with its four costs. The reversal
   is **narrow** — a spatial reference behind a place-scoped view — and must not be read as reopening
   the annotations, text boxes, arrows or clip art in the same row.
18. **Whether an imported image needs a size ceiling, and where it would be enforced** (§10.10).
   `44` owns size budgets and its gate (`44` §5.5) covers build artifacts, not workspace content.
   An imported image is the only thing in the workspace whose size the product does not choose.
   Unowned.
19. **`56` does not know warps exist** (§16.2). A full-text search of `docs/50-design/56-diagram-view.md`
   for `warp`, `PathSegment` and `SegmentKind` returns **nothing**. `19` §6 decides that a service
   path is a sequence of segments, that a `Warp` stands in for an unmodelled interior, and that its
   resolution has four distinct states — and the document that owns how the picture is drawn
   specifies none of them. `51` §9 supplies the treatment (`--rule-style-pending: dotted`, and
   **never** `dashed`, which is reserved product-wide for AI-proposed content). `56` owns the answer
   under ADR-0001's precedence rule; planning proposes. **Found by the owner asking a question, not
   by a gate**, which is worth noting on its own — nothing in the tree compares a model concept
   against the views that must render it.
20. **What a re-identification match looks like to the operator** (§16.3). `Device.identity` now
   declares its tiers, so a second paste of a box already in the workspace is *detectable*. What
   happens next is a UX question and is deliberately not decided in `schema/`: a tier-1 match is a
   **proposal to a human, not an automatic merge**, because two real branch sites may both run a
   `core-01` SRX on the same platform. `53`/`54` own the surface. *(Until it was designed, `OP_PASTE`
   replaced the held estate — the behaviour that cannot silently merge two boxes. **The surface
   was built 2026-08-21**: the paste is additive, and a tier-1 match refuses with
   `ERR_PASTE_CHOICE`, names the existing box, and offers exactly one answer — "these are
   different boxes". The merge half is still unbuilt and the refusal says so in words.)*
21. **`Chassis` still declares `identity: []`** (§16.3). Not blocking and nobody has asked, so it is
   filed rather than decided — but the two obvious tiers are `[ owner(Device), member_index ]` and
   `[ owner(Device), serial ]`, and the second is the one that survives a re-slot. It matters the
   day a chassis cluster is re-parsed.
22. **`14` §9.6's pre-redaction rule needs a length floor, and one was added ahead of the
    amendment.** Filed 2026-08-10. §9.6 says a value *"consists of ≤ 2 distinct characters"* is a
    mask the operator typed, and is therefore bound and not counted as a drop. Taken literally that
    includes **`1111`**, which is not a mask — and the shipped gate kept it in the capture verbatim
    *and* reported it back as `already_redacted`. Stored, and described to the operator as safe.

    `crates/fathom-ingest/src/redact.rs` now requires eight characters before trusting the
    two-distinct-character form. The asymmetry is the argument: **destroying a real mask costs
    nothing, because a mask carries no information; keeping a real password breaches invariant 3.**
    The angle-bracket form is unambiguous at any length and keeps no floor.

    This is a narrowing of a specified rule made by a build session, which `78` §5 would normally
    forbid — it is recorded here rather than taken silently, and the direction is the safe one.
    **Planning owns the amendment to `14` §9.6.** Two sibling leaks were fixed in the same pass and
    are not spec changes, only defects: noise lines never reached the gate at all (a prompt-prefixed
    paste, which is what copying from a terminal produces, kept its secrets), and the unshaped
    sweep's content detectors started at token 2, so a bare private-key body on its own line was
    never examined. `crates/fathom-ingest/tests/noise_gate.rs` pins all three.
23. **Routing is not a vocabulary addition, and two things stand in front of it.** Established
    2026-08-10 while adding the three cheap entries that removed `domain-name` and `description`
    from a real config's residue. `set routing-options static route <prefix> next-hop <x>` is the
    most common statement Fathom still cannot read, and it needs **both** of the following before a
    single dictionary line can be written:

    **(a) A field value that is a reference to another node.** `StaticRoute.next_hop` is typed
    `NextHop`, which `schema/schema.yaml`:70 registers as `structured: true,
    contains_reference: true` — the registered `contains_reference` exception (`11` §6.5), carrying
    a `NodeId` to a `LogicalUnit` for the `next-hop st0.0` form. `fathom-ingest`'s `BoundValue` has
    **no variant that can hold a node reference**, and its deferred-reference machinery
    (`PendingTarget`) serves **edges only**. So the binder cannot express this value at all today.
    An IP-address next hop (`NextHop::Address`) needs none of that and could land first, which is
    worth knowing: the statement splits into an easy half and a hard half.

    **(b) What the default routing instance is called.** `11` §6.5 states *"The default instance is
    modelled explicitly, not as None"*, and `RoutingInstance` requires both `name` (`card: 1`) and
    `isolation` (`card: 1`). A `set routing-options …` statement names no instance, so binding one
    means minting the default instance — and its **name is a decision nobody has taken**. It is
    load-bearing forever: every routing statement on every platform hangs off it, and two platforms
    disagreeing about the name would silently produce two default instances per device. Planning,
    not the owner, and not an execution session (`78` §5).

    Filed rather than attempted. The two `security policies` lines in the same residue are a
    separate and larger body of work — `SecurityPolicy`, `PolicySet`, `AddressObject`,
    `AddressSet`, `Application` and `ApplicationSet` all exist in `schema/` with no dictionary
    behind any of them.
19. **The image decoder as a trust surface** (§10.10). `34` has no section on image decoding —
   grepped 2026-08-08, zero hits — so the surface is unanalysed rather than cleared. A question for
   `34`'s owner. **ADR-0034 forbids answering it from memory and §10.10 does not answer it.**
20. **The residue of §11.5** (§10.5). The owner answered *box* for places. Whether §10.4's
   recommended `Group` — the bag, for cross-cutting sets like *"the Q3 refresh"* — is still wanted
   alongside the place hierarchy was not addressed and is still owner-only. §10.9 argues both shapes
   are needed, for different subjects; that is an argument, not an answer.
21. **Whether the zoom axis reuses `56` §3.6's one-scene-filtered mechanism** (§10.6). `56` §3.6
   decided it for layers with a stated reason — 31 layouts is the alternative — and `56` §13.2
   proposes the same shape for zoom. `56` owns it. Until it is decided, **no work should enumerate
   zoom-by-view combinations**, because enumerating them is the failure this item exists to prevent.

## 14. Sources consulted

| Source | Taken |
|---|---|
| The owner, in conversation, 2026-08-06 | Every quotation in §§2–6, verbatim |
| The owner, in conversation, 2026-08-08 | §10's three additional quotations, verbatim — the core-and-bridge description, *"they were standalone"*, and the five verbs |
| The owner, in conversation, 2026-08-08 (later) | §10.5's four quotations, verbatim — the box answer, the box as a single device, *"different views"*, and the zoom ladder |
| `schema/schema.yaml` — `edge: HasUnit`, `edge: ZoneMember`, `edge: InRoutingInstance`, `edge: VlanMember` (read 2026-08-08) | §10.7's table: one containment at `in: "1"`, two references at at-most-one, and `VlanMember` at `in: "0..n"` — the one that cannot be a box |
| `schema/schema.yaml` — `edge: HasPremises`, `edge: AtPremises`, `edge: HasDevice`, `edge: HasPassiveNode`, `edge: HasExternalPeer`, `kind: Premises` (read 2026-08-08) | §10.8: places are flat under `root`; `Site → Premises` is a reference; `HasDevice` is `Site → Device`; the `form` enum's nine values, none of them a floor or a rack |
| `docs/10-core/19-service-and-physical-model.md` §3.5, §5.1 | One kind for a CO and a customer location; the two-hop sibling query §10.8 cost 2 disturbs; `HasExternalPeer`'s existing `from` widening as the precedent |
| `docs/50-design/56-diagram-view.md` §0, §1.2, §1.3, §3.6, §4.1, §4.3–§4.5, §5.5, §9.2, §9.3, §11 (fm 15), §12 | The governing rule; *"The view never says 'current'"*; the out-of-scope row §10.10 reverses; one scene filtered and the 31-layout argument; the projection table and the `Site`-band / `RoutingInstance`-box mismatch; the dropped-label rule; export rule 1; no `<image>` on export; the sensible-default failure; the `img-src 'self' blob:` request |
| `docs/30-security/34-browser-hardening.md` §2.7, §5.6 (read 2026-08-08) | `img-src data:` in mode A and `'self' data:` in B–D, with `data:` retained deliberately; the closed SVG tag set and its ban on `<image>` |
| `grep -rniE "image decod\|decoder\|jpeg\|bitmap\|raster" docs/30-security/34-browser-hardening.md` (run 2026-08-08) | **Zero hits.** §10.10's fourth cost: the decoder surface is unanalysed, not cleared |
| `docs/40-stack/44-performance-budgets.md` §5.1, §5.5 | The distribution row — *"a 4 MB attachment goes through email"*; the size gate's scope, which is build artifacts and not workspace content |
| `docs/10-core/17-workspace-format.md` §13.2 | The 0.6 MB / 8 MB derived workspace figures §10.10 measures an image against, and their own pending-recomputation caveat at §13.1 |
| `docs/10-core/11-ir-schema.md` §2.2 | The rejection of the total-population assumption, and the rejection of control-plane/data-plane simulation with its consequence — *"Fathom cannot answer 'where does this packet go'"* |
| `docs/70-ops/76-scope-expansion-analysis.md` §8 Q1, Q2 | The question §10.9 answers, and the sealed-container consequence its premise removes |
| `docs/50-design/59-diagram-aggregation-and-colour.md` §3.3, §3.13, §3.14, §9 | The five levels and what they count; the parallel-edge finding; the proposed sixth level and its forks |
| `docs/50-design/56-diagram-view.md` §1.3, §3.5, §3.7, §5.2 G4/G5 | Manual position in scope; `LayoutHint`, `Pin` and `GroupId`; the regroup **commands**, which are a different thing; the two channels a parallel-edge mark may not spend |
| `docs/50-design/53-interaction-and-keyboard.md` §2.2 and its vi-alias table | `h` / `l` bound to collapse / expand; `g g` / `G` bound to first / last, which is the collision `56` §3.5's *"pressing `G`"* creates. ADR-0024 makes `53` the sole owner |
| `grep -rn "GroupId" .` (run 2026-08-08) | One hit in the whole tree — `56` §3.5's type sketch |
| `grep -rni "layouthint\|layout_hint\|pin" schema/` and `grep -rni "position\|layout" schema/schema.yaml` (run 2026-08-08) | No node position, no `LayoutHint`, no `Pin` in `schema/`. `PortPosition` is a physical slot coordinate |
| `grep -rn "tag" schema/schema.yaml schema/field-keys.yaml` (run 2026-08-08) | Seven hits, none a user-applied label — §10.3.2 enumerates them |
| `schema/schema.yaml` — `edge: Link`, `edge: MemberOfAggregate`, `kind: Cable` | Ten standalone links are ten model objects; a bundle would be one `AggregateInterface`; `Cable.assembly` is *"a query, not a key"* |
| `docs/00-vision/03-non-goals-and-scope.md` §4.5 (`N-R-5`) | Correlation and LLDP paste declared in scope; the refused adjacent |
| `docs/10-core/11-ir-schema.md` §10.4, §10.6; ADR-0010 | Re-identification is scoped by `owner_device`; the cross-device limitation row |
| `docs/10-core/19-service-and-physical-model.md` §§2.1, 3.3, 3.7, 3.9, 6.1–6.6 | *"no parser produces it"*; `infer.port.occupies` as suggestion; the warp, its resolver and its asserted-edges-only rule |
| `docs/10-core/14-parsers-and-ingest.md` §10.1 | Identity tuples scoped by `owner(Device)` |
| `docs/50-design/53-interaction-and-keyboard.md` | *"No modes. No mode indicator. No mode errors."* |
| `docs/50-design/56-diagram-view.md` §6.4 | Cables are created by a UI gesture, one op, one undo step |
| `docs/70-ops/71-roadmap.md` §13.1, §13.2 | The thirteen permanent boundaries versus the eleven deferrals |
| `docs/70-ops/75-capability-register.md` C-07 | Planning and overlay modes as recorded intent |
| `docs/70-ops/76-scope-expansion-analysis.md` §6.5, §7.2, §8 | The 0-of-177 transfer figure; the S-slices; Q10 and Q11 |
| `docs/70-ops/77-service-model-requirements.md` §§2.1, 3.1, 7 | Calix, Nokia, CLLI, DIA/E-Line/E-LAN, the naming grammar |
| `docs/80-review/86-critique-design.md` §9.4 (D-35, D-36); `80-reconciliation.md` M34 | The motion decision's actual provenance |
| `docs/80-review/88-state-review-and-recommendations.md` §§4.4, 4.5, 5.7 | The blockers these answers discharge |
| `schema/platforms.yaml`; `schema/schema.yaml`; `corpus/` (all three files) | The vendor registry; the 48 kinds; the 177 entries and their platform tags |
| `rg -ci "calix\|nokia\|clli\|fttx\|gpon\|olt\|ont\|pon\|e-line\|elan\|dia\|uni" corpus/` (run 2026-08-06) | Zero matches |
| `schema/platforms.yaml` (after the 2026-08-06 edit) | §7.2's registry table: eight vendors, eight platforms |
| `docs/30-security/33-sync-protocol.md` §1, §12 | *"The server stores ciphertext and never holds a key"*; the compromise outcome quoted in §8 |
| `docs/40-stack/41-technology-choices.md` §5.5 | `fathom-sync` never links the graph, rules, emit or parse crates, and the linker enforces it |
| `docs/40-stack/43-deployment-modes.md` §2 | D1–D4; D2 single node and D3 cluster as existing shapes |
| `docs/70-ops/71-roadmap.md` §13.1, §13.2 | The two refusals quoted in §8, with their qualifiers; the fleet-scale deferral and its ~2,000-device trigger |
| `docs/90-decisions/adr-0016-git-is-the-sync-for-v1.md` | The deferral §8 and §13 item 5 revisit |
| `corpus/rules/ipsec-junos-srx.yaml` header, gap G6 | The `versions: "*"` self-indictment quoted in §7.4 |
| `grep -rniE "psirt\|advisory\|known.bug\|cve\|errata" schema/*.yaml docs/10-model/` (run 2026-08-06) | One irrelevant hit. Known-defect advisories are not modelled |
| `docs/50-design/59-diagram-aggregation-and-colour.md` §2.1–2.3, §3, §6.2 | The legibility-ceiling finding, the `155 + 9n` measurements, the six-sibling decision, the silent-count defect |
| `docs/50-design/56-diagram-view.md` §1.1–1.3, §4 | One canvas, five layers, aggregation to `Site`/`Device`; the inventory-table concession quoted in §10.2 |

## 17. The local file is a bridge, not the destination — 2026-08-11

### 17.1 What the owner said, verbatim

> *"No it having the database be local to the server will fix it, then there is no local client
> solution. We should be building it in mind that eventually when I have a private server on the
> corps network and hardware that is secured we won't need this local database solution. This part
> is temporary only."*

Said in correction of an analysis that treated server-hosted storage as *"a different decision that
does not fix Firefox"*. **The correction is right and the analysis was wrong.** If the estate lives
in a database on his own server, the browser stores nothing, no file is written, no picker is
needed, and the Chromium-versus-Firefox split this document spent a section on **does not exist**.
It was framed as an alternative to the file; it is the destination the file is a bridge to.

### 17.2 What this changes about what to build now

Almost nothing — and that is the finding worth recording, because it is not luck.

The route already chosen (`00-ROUTE-TO-WORKABLE.md` §5b) saves **the operator's ops**, not the
expanded model. An op log is precisely what a client sends to a server: it is small, ordered,
append-only, and carries its own provenance. So the work does not become throwaway when the server
arrives — the same journal that is a 2.4 KB file today is the request body tomorrow, and the local
file becomes one *transport* for it rather than the design.

Had the snapshot route been taken instead, this correction would have invalidated it: a serialised
graph blob is a client-side storage format and nothing else.

**So: no change of plan, and one change of emphasis.** Do not over-invest in the file. It needs to
work, be encrypted, and be openable; it does not need versioning, compaction, merge, or a
sync-conflict story, because those are the server's problems and the server is coming.

### 17.3 The two things this now forces, and they are the owner's

**1. Invariant 1 has to be reopened, on merit.** *"It never connects to anything"* is invariant 1,
and a page that reads its estate from a server connects to something. This is not an objection —
`75` §2 records the owner's own instruction that **sunk cost never argues for keeping a decision**,
and `38-the-egress-question.md` exists precisely to price exceptions. But it is a founding invariant
and the change is an ADR, not an implementation detail. **Nothing here proposes to make that change
quietly.**

Worth being exact about what does and does not move: the *device* invariant is untouched. Invariant
2 — never touch a device, copy-paste is the only input — is the one that makes this product what it
is, and a server for the operator's own records does not weaken it at all. Fathom would still never
log into a router. What changes is where the operator's notes live.

**2. Whether the server can READ the estate.** This is the question that actually decides the
architecture, and the word *"database"* answers it in one direction without meaning to:

| | Server holds ciphertext it cannot read | Server holds a real database |
|---|---|---|
| Matches | `43` D2/D3 and `70` §8, already decided | The plain meaning of *"database"* |
| Server can query, index, report | **No** — it is an opaque blob store | Yes |
| Multi-user, per-user views, audit | Very hard | Natural |
| If the server is compromised | The estate is safe | The estate is taken |
| Key management | The operator holds a key and can lose it | None |

The owner's stated trust model — *"a private server on the corps network and hardware that is
secured"* — is a normal and defensible posture for an estate of record, and it points at the second
column. But the first column is what is currently written down, so the two must be reconciled
deliberately rather than by drift.

> **CORRECTED 2026-08-15 — §17.5 supersedes this table's framing.** The two columns were put as a
> dichotomy, and they are not one. Worse, the question had already been answered *by the owner
> himself* in §8 of this document on 2026-08-10, and §17.3 did not cite it. Read §17.5 before acting
> on anything above.

### 17.4 What was wrong in the analysis this corrects

Recorded so the error is not repeated: server-hosted storage was assessed against *"does it give him
a folder of his choosing"* — the requirement he had stated an hour earlier — and judged not to. He
was not asking for the folder for its own sake; he was asking for his work not to vanish. The folder
was a means. **A requirement stated once should not be treated as a fixed point when the person who
stated it is describing where they are actually going.**

### 17.5 Multiuser does not require a server that can read the estate — 2026-08-15

The owner stated the enterprise target verbatim:

> *"right now this is a single person tool, eventually when it is on the server it should have
> multiuser support, security hardening with that in mind from a programming, backend docker, and
> front end things like 2 factor perspective. need to add things like smtp for the ability of people
> to reset passwords, though keeping in mind 2 factor requirements. administrative control panel,
> etc. all that made for an enterprise environment."*

**The analysis in §17.3 read that as settling the readable-database question. It does not, and the
question was not open.** §8 of this document — *the owner's own answer, 2026-08-10* — already says:

> | Server-side search or querying over the estate | **Never.** Invariant 4. It requires plaintext on
> the server, which is the thing the whole posture exists to prevent |

and, in the same section: *"A server that stores bytes it cannot read is not refused anywhere — it is
**already the design**."* `71` §13.1 carries it as a permanent product boundary — *"A server that can
read a workspace. No server-side lint, no server-side emit, no server-side search"* — and `41` §5.5
makes it a **linker-enforced** decision: `fathom-sync` may not depend on the graph, rules, emit or
parse crates, and CI fails on the edge.

`41` §5.5 also predicted precisely how the decision would be lost, which is worth quoting because it
describes what nearly happened here:

> *"every feature request the service will receive — 'server-side search', 'validate before
> accepting', 'let the server tell me which devices changed' — is a request to link the graph into
> the service. The day it links, the service needs plaintext, and the zero-knowledge property is
> gone."*

**The false dichotomy.** §17.3 offered *"blind blob store"* against *"real database"* as though
multiuser forced the second. It does not. The whole of the owner's stated list works on a server that
cannot read an estate:

| What he asked for | Needs plaintext on the server? |
|---|---|
| Multiuser accounts | **No** |
| Two-factor authentication | **No** — a user credential, not estate content |
| SMTP password reset | **No** (but see the key-loss trap below) |
| Administrative control panel | **No**, for managing *users*, roles, sessions, invitations, audit |
| Sharing an estate between named people | **No** — the workspace key is wrapped per recipient |
| Server-side search across everyone's estates | **Yes** |
| An admin reading estate *content* | **Yes** |
| Server-generated reports over the whole database | **Yes** |

The first six are the enterprise product. The last three are the ones that cost the security
architecture, and they are the only ones §8 refuses. **This is a much smaller decision than §17.3
made it, and it is the one to put to the owner:** not *"can the server read the estate"* but *"do you
need search and reporting across other people's estates, or only shared access to them?"*

**Why the blind design is worth this much care.** `31` §5.1's top three threats are server
compromise, insider operator, and hosting provider. All three currently carry residual `bounded`
**because** the server holds no key and no plaintext — *"Service memory contains no key even under a
full hypervisor read."* Making the server readable does not degrade one control; it converts the
three highest-ranked threats in the model from bounded to total. For a product whose data is a map of
a network *including its firewall policy*, on a corporate network where the realistic attacker is
already inside, that is the wrong direction to move by default.

**The one genuinely hard problem, and it is solvable.** If the workspace key derives from the user's
password, then a password reset destroys the data — the classic zero-knowledge trap the owner half
anticipated when he wrote *"keeping in mind 2 factor requirements"*. The answer is standard and
well-proven in exactly this shape by password managers: the workspace key is random and
**wrapped**, once per authorised user, so a password change re-wraps rather than re-encrypts, and
recovery is a printed recovery key or an organisation-held escrow key that the owner decides the
policy for. That escrow decision is real and is his; it is not a reason to abandon the posture.

**What this does not change.** Invariant 2 stands untouched under every option: Fathom never logs
into a device. Nothing in the enterprise direction weakens it, and `71` §13.1 should keep saying so.

## 15. Disagreements

1. **Against the framing of the original questions.** Q3 and Q4 were put to the owner in project
   jargon and were unanswerable as asked; the owner said so twice. That is a defect in the asking,
   not in the answering. §7 is the repair, and the rule it implies is worth keeping: a question for
   the owner is phrased in terms of their work and what they would see, never in terms of the data
   model. Where a security consequence rides on the answer, it is stated before the question, as in
   §7.2.

2. **Against reading §4 as a schedule.** *"All features must be included in V1"* is a statement
   about the feature set, not about time. `ADR-0003` remains Accepted and unreversed: it decides
   nobody funds this and records that under that assumption *"the honest scope is one platform, one
   domain, forever"*. Those two can both be true — the product ships whole, and it takes as long as
   one person takes — but the tension is real and is not resolved here. ADR-0031 §Consequences
   states it as the cost it is.

3. **Against treating §6.1 as small.** It reads like a feature and it is closer to a subsystem: it
   needs an evidence model, a confidence model, a conflict-resolution rule, a UI for accepting or
   rejecting a proposal, and a provenance story for every edge it creates. `19` §3.9 already calls
   hand-entered physical data *"the single largest adoption risk in this layer"*, which is the
   strongest available argument for doing it — and is also the measure of how much rests on doing
   it correctly.
