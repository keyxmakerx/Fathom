# 76 — Scope expansion: what the new requirements do to the architecture and the plan

> **Status:** Proposed

Companion documents: `docs/70-ops/77-service-model-requirements.md` (the capture this analyses;
it records and decides nothing, this one argues sequence and cost), `docs/70-ops/71-roadmap.md`
(the plan these requirements disturb, and the source of every person-week unit below),
`docs/70-ops/75-capability-register.md` (the register these become candidates for, and the place
the source-of-truth question was already raised and never answered),
`docs/10-core/11-ir-schema.md` (the graph they have to live in),
`docs/00-vision/03-non-goals-and-scope.md` (the boundaries two of them cross),
`docs/40-stack/44-performance-budgets.md` §7 (the scaling analysis R3 collides with),
`docs/10-core/15-explainer-corpus.md` §12 (the only credible corpus-cost method in the repository),
`docs/50-design/56-diagram-view.md` §6 (the cabling gesture R6 asks for, already specified),
`docs/90-decisions/adr-0008-the-schema-is-a-specified-artifact.md` (the prerequisite nobody scheduled).

This document does three things `77` deliberately does not: it prices the requirements, it ranks
the collisions, and it proposes a build order. It resolves no collision — the owner reopens
decisions. Where it recommends, the recommendation is marked and the thing lost is named.

---

## 0. Contents

| § | |
|---|---|
| 1 | How to read this, and what changed since `77` |
| 2 | The seven requirements, restated, and what each is really asking for |
| 3 | The fork — teaching tool, or source of truth |
| 4 | Requirement by requirement: what exists, what is missing, what it costs |
| 5 | The collisions, ranked |
| 6 | The domain question — a second corpus, costed |
| 7 | The revised build order |
| 8 | What must be decided before slice one starts |
| 9 | Failure modes of this analysis |
| 10 | Open decisions |
| 11 | Sources consulted |
| 12 | Disagreements |

---

## 1. How to read this, and what changed since `77`

*margin tab: three corrections first*

> **THE CHEAPEST THING IN THIS DOCUMENT IS THE THING THAT SETTLES THE MOST EXPENSIVE RISK**

### 1.1 The unit

Every size in this document is in `71` §1.3's unit: a **person-week** is five days of focused work
by someone who has read the specification and is not also doing support or hiring. Solo figures are
calendar weeks, serial. Where a number is derived from a method in another document rather than
stated by one, it is labelled **derived** and the method is named. Where no number can be honestly
produced, the section says *not estimable* and says what would make it estimable. `71` §2's totals
— **106–158 solo weeks to phase 7** — are the backdrop against which every figure here should be
read, together with its warning: *"Any plan that reports a smaller number has either cut the corpus,
cut the second platform, or cut the security posture, and each of those is a different product."*

### 1.2 Three corrections to `77`

`77` is a capture written fast and it is honest about being one. Three of its claims are wrong or
unfounded, and each was going to cost real money if left standing.

| `77` says | The corpus says | Consequence of the correction |
|---|---|---|
| §11 `C7`: *"The IR models logical interfaces, not front-panel ports"*, and *"everything in §5 and §8 depends on this landing first"* | `11` §6.4 heads a kind **`Interface` — a physical port**, with `form`, `speed`, `duplex`, `flow_control`, distinct from `LogicalUnit`, `AggregateInterface` and `TunnelInterface`. `11` §7.3 gives `Link \| Interface \| Interface \| 0..1 \| 0..1`, with `media`, `length_m`, `label` (*"Patch panel reference"*) and `provider_circuit` in §7.4 | **C7 is not a blocker.** R1 and R2 sit on a modelled physical port and a modelled cable that both already exist in specification. The real gap is narrower and stated in §4.1 |
| §8 and §11 `C6`: *"The wheel may already be allocated to zoom in `56` §6"* | The string `wheel` occurs nowhere in `docs/` or `.context/` outside `77` itself. `53` §3.4 binds `z` to zoom-to-fit; `55` §5.5 allocates *"a scroll gesture"* to **pan**, not zoom | The wheel is free of zoom and taken by pan. That is a smaller collision with a cheaper fix (§5, X10) |
| §8: *"'Multiple modes' needs testing against `53`/ADR-0024's position on modes"* | `53` §2.2 principle 5 is not a position awaiting a test. It is a numbered decision — *"**No modes. No mode indicator. No mode errors.**"* — with a written arithmetic defence | R6's "multiple modes" is a real collision with a decided position, and it needs an amendment or a reframing, not a test (§5, X8) |

### 1.3 What this document adds

`77` names seven collisions. It misses the largest one entirely: **R3 versus `44` §7.1**. Nowhere in
`77` is "hundreds to thousands of networks" multiplied by `77` §2.2's own devices-per-network range
and checked against a scaling analysis whose first five breakage points are at 20, 50, 50–80, ~100
and ~100 devices. That multiplication is §5's X1 and it is the single most expensive thing here.

---

## 2. The seven requirements, restated, and what each is really asking for

*margin tab: the ask, minus the wording*

| # | As stated | What it is really asking for | Category |
|---|---|---|---|
| **R1** | *"a perr equipment page with all the info and ports, kinda like netbox but netbox is way to granular, whereas this be everything for that equipment as needed"* | A per-node detail surface for one `Device`, carrying its fields, its port list, and the findings against it. The qualifier "as needed" is a rejection of NetBox's field count, not of its scope | UI over existing schema |
| **R2** | *"you can click on a port which goes to other equipment"* | Traversal of the `Cabled` edge from a selection, and a port row whose peer cell is a navigation target | UI over an existing edge |
| **R3** | *"we have many networks, hundreds to thousands, so how do we account for that?"* | An estate two to three orders of magnitude larger than the workspace format was designed for — or a redefinition of "network" under which it is not. Nobody knows which | Storage architecture |
| **R4** | *"a way to validate equipment name? like that should be customizable, like external would be {ST}{CLLI}{TYPE}{Incremental}… where type is the brand"* | Per-operator, per-workspace, private naming policy, expressed as a template over declared segments, checked against the graph rather than against a regex | New subsystem |
| **R5** | *"With incremental should be a number but could also be a letter (because we did letter if there is multiple per address) which addresses will be important as well"* | Addresses as a structured, comparable, join-capable thing, because the letter increment is a **uniqueness constraint scoped to an address** and prose cannot carry one | Schema change |
| **R6** | *"the visualizer needs to be essentially as easy as jira… With multiple modes too, like… clicking to drag one piece of equipment, then using the mouse wheel to select the port, going to another equipment, and mouse wheel that equipment to get the port"* | A diagram you cable in, with the wheel as a port picker, and more than one such tool | UI over an existing gesture, plus a decided-against mode concept |
| **R7** | *"There's also the engines needed, etc"* | Per-platform modularity for a platform family the corpus has never seen | Domain programme |

Two of these are much smaller than they sound and two are much larger.

**R1 and R2 are the small ones.** The kind exists (`11` §6.4), the edge exists (`11` §7.3–7.4), the
detail surface exists in specification (`54` §18's inspector, with field, provenance, findings and
emitted-config blocks), and the inventory's primary object is already *"the row set — a kind plus a
filter"* with a **generated** column picker (`52` §3.7). "The ports of SRX-A" is literally a kind
plus a filter.

**R3 and R7 are the large ones.** R3 is a storage-layer question that reopens ADR-0013, `03`
`N-D-2` and every budget in `44` §7. R7 is a second domain, which `71` §16 open decision 7 leans
toward and explicitly blocks on phase 7's outcome — a phase that does not exist, behind six phases
that do not exist either.

**R6 is almost free and looks expensive.** `56` §6.4.1 already specifies the gesture, including
the port picker, the unlinked-only filter, the `+ new interface` escape hatch, the media capture
and the one-op-one-undo contract. What R6 adds is a third input driver for that widget. What it
collides with is `53` §2.2, not the diagram.

---

## 3. The fork — teaching tool, or source of truth

*margin tab: the decision under the requirements*

> **THIS IS A FORK, NOT A FEATURE REQUEST, AND IT SHOULD BE TAKEN AS ONE**

### 3.1 The plain answer

**Yes. R1–R6, taken together and combined with the owner's separate answer that Fathom is "where
the estate lives" (`77` §10), turn Fathom into a source of truth for a physical estate.** A
per-equipment page with a port list, navigable cabling, structured addresses, enforced naming and a
canvas you cable in is the feature set of a DCIM. It is not *most of the way* to one. It is one.

This is not a criticism. It is a fork, and the corpus's own reviewer already saw it coming and
asked for it to be taken deliberately. `75` §16 disagreement 6, written against the register rather
than for it:

> *"the C-01/C-02/C-03 cluster is a request for Fathom to become a CMDB. Lifecycle state, ticket
> references, maintenance windows and bulk editing across an estate are, together, the feature set
> of a system of record… `03` §4.2 `N-R-2` refuses the record-keeping outright, with `Reopens if:
> Never`."*

That question has never been answered. R1–R6 are the same question arriving again, larger, and with
the owner having already answered the underlying one in the affirmative.

### 3.2 What the two products are

| | **Teaching and modelling tool** (specified) | **Source of truth with opinions** (requested) |
|---|---|---|
| Primary object | A change you are about to make | The estate as it is |
| What the graph holds | Intent, plus whatever was parsed | Record — what exists, where, cabled to what |
| Staleness | A rendered fact (`56` §8's four-state ramp) | **A defect.** People act on it |
| The wedge | The finder — zero setup, zero trust (ADR-0006) | The inventory — which requires the estate to be entered first |
| Positioning against NetBox | `52` §3.7: *"the thing NetBox structurally cannot do: **the inventory has opinions**"* | `77` §6: *"kinda like netbox but netbox is way to granular"* |
| The refusal that governs it | `03` §4.2 `N-R-2`, `Reopens if: **Never**` | `N-R-2` amended or narrowed |
| Corpus | IPsec teaching content — the thing being taught | Naming schemes, address data, port inventories — the thing being recorded |
| What "wrong" costs | An afternoon | The estate |

### 3.3 The narrow reading that may survive unamended

`03` §4.2's headline refusal is broad. **Its stated test is narrower than its headline**, and the
distinction is worth putting on the record before anyone reaches for the amendment:

> *"**The test** — Review rule: no field in the workspace format asserts currency or authority;
> provenance records *how and when* a value arrived, never *that it is correct now*."*

A port is a fact with provenance. A cable is a fact with provenance. A street address is a fact with
provenance. None of them asserts currency, and none of them requires a reconciliation loop —
which is the thing `N-R-2` actually refuses in its adjacent-refused row (*"A workspace flag marking
it authoritative, with a scheduled reconciliation against devices"*). On that reading R1, R2 and R5
add fields and refuse authority, and `N-R-2` holds unchanged.

The reading that does **not** survive is `77` §10's — *"it's where the estate lives"* — because
that is an authority claim in plain words, and it is the sentence that makes staleness a defect.

**RECOMMENDATION — take this as one decision, in writing, before any field is added.** Not because
the answer is obvious, but because the alternative is the failure `75` §16 named: *"a drift arrived
at three entries at a time."* Three routes exist and each is defensible:

| Route | What it means | Cost |
|---|---|---|
| **A — Amend `N-R-2`** through `03` §10.1 | Fathom is the estate record. Say so | `03` §4.2, `03` §11, `52` §3.7, `31`'s threat model and `01`'s refused list are all rewritten. Staleness becomes a permanent, continuously-visible design obligation (`77` §16 disagreement 2), and nothing specifies it |
| **B — Clarify `N-R-2` along its own test** | Ports, cables and addresses are facts with provenance. No authority flag, no reconciliation, no currency assertion | One clarifying paragraph in `03` §4.2, and R1/R2/R5 proceed. `52` §3.7 keeps its position. The owner does not get to say "it's where the estate lives" |
| **C — Hold the line** | R1 scopes to "everything the graph already knows about this device". No empty-port inventory, no address model | Cheapest by far. Fails R5 outright and fails half of R4 |

The corpus's own advice, if it has one, is `02` §5.1's: *"Fathom should read NetBox, not replace it.
An importer that reads a NetBox export into the graph is a small piece of work with a large payoff,
and it converts the most likely objection — 'we already have a source of truth' — into an on-ramp."*
`03` §9.1 already puts that importer in scope. If this estate's ports, cables and addresses already
exist somewhere exportable, that is a far cheaper path to R1 and R5 than modelling them from
nothing, and it sidesteps most of route A.

---

## 4. Requirement by requirement: what exists, what is missing, what it costs

*margin tab: the honest ledger*

### 4.1 R1 — the per-equipment page

**Exists.** More than `77` credits.

| Piece | Where | State |
|---|---|---|
| The physical port kind | `11` §6.4 `Interface`, `name`/`form`/`description`/`admin_up`/`mtu`/`speed`/`duplex`/`flow_control`/`vlan_tagging` | Specified |
| The per-node detail surface | `54` §18 inspector — field/value/**provenance** table, findings anchored here, emitted config, inline editing | Specified |
| Its home in the shell | `52` §2.3 as amended by ADR-0025(3): the pinned pane and the inspector are one surface. Opening the inspector *is* opening the second column | Decided |
| The nested device → interface → unit → address row shape | `52` §5.5 (worked for `LogicalUnit st0.0`), `11` §14.4 (*"The workspace inspector re-nests containment for display… a rendering concern with no storage cost"*) | Specified |
| A kind-plus-filter primary object with a **generated** column picker | `52` §3.7, on `11` §11.6's schema-as-data | Specified |
| The differentiator | `52` §3.7.1's opinions column — per-row finding aggregate, sortable by worst severity | Specified |

**Missing.**

1. **A physical-port inventory independent of configuration.** An `Interface` node exists because a
   parser bound one (`14`) or a user drew one (`56` §6.4.1's `+ new interface`). Nothing models
   *"this chassis has 24 SFP+ cages, 6 cabled, 18 empty"*. `Chassis.slots: u8` is scoped by `11`
   §6.3 to *"FPC count, for interface-name validation"* — a validation input, not a port census. On
   a partly-configured access node, R1's "all its ports" has nothing to enumerate.
2. **Any physical-position model** — no rack unit, no faceplate coordinate, no port label distinct
   from the vendor interface name, no patch-panel entity. `Link.label` carries *"Patch panel
   reference"* as free `Text` and that is the whole of it.
3. **A named per-equipment artefact anywhere in the IA.** `52` §12's open decisions D1–D5 do not
   contemplate one.

**Collides with** `52` §9.5 (*"Six views fit. If a seventh is ever added, this design has a real
problem and an overflow menu would be hiding it"*) and `52` §9.6's scent budget (*"at most 14
discrete facts"* above the body). See §5 X9. The constraint points at the answer rather than away
from it: `52` §1.1's precedent — `verify(diff(graph))` is **a mode of the config view, not a
seventh view**, with the mode named in the view band as `config · change set · 14 lines` — makes
`inventory · SRX-A · 48 ports` a one-mode-selector change rather than a redesign.

**Size.** 1.5–3 solo weeks *on top of an inventory view that does not yet exist*: a filter preset, a
ports column set over the generated picker, the nested row rendering `52` §5.5 already specifies,
and a `Cabled peer` cell. **Add 1–2 weeks** if unconfigured ports must be enumerable, because that
needs the port-inventory model that does not exist.

### 4.2 R2 — navigable ports

**Exists, essentially complete.**

- The edge: `11` §7.3 `Link | Interface | Interface | 0..1 | 0..1`, fields in §7.4, direction
  normalised on write to the lexicographically smaller `NodeId`, with the instruction that
  *"Consumers must never read meaning into the direction of an edge whose class declares
  `symmetric: true`."*
- The accessor from the port side: `11` §6.4, `Cabled → Interface (0..1)`.
- The traversal cost: `11` §14.3 prices out-edges of one kind at `O(1) + O(deg)`.
- The rendering: `56` §5.4 draws a physical `Link` as *"one 1 px `--ink` line, orthogonal, **port
  stubs at both ends**, **port names at both ends**, zoom > 0.6"*, with an `O(1 + k)` uniform-grid
  hit test in §6.5.

**Missing.** Nothing structural. A "go to cabled peer" action is one graph hop and one selection
construction.

**Collides with** nothing — except at access-network fan-out, where `Link`'s `0..1/0..1` cannot
express a passive optical split. See §5 X7.

**Size.** ~0.5 solo weeks, given the graph and a selection model. It is the cheapest thing the owner
asked for by a wide margin.

### 4.3 R3 — hundreds to thousands of networks

**Exists.** A scaling analysis that already answers this, in the negative, with arithmetic.

`44` §7.1's order of breakage, stated in devices because *"that is the unit a user thinks in"*:

| Order | Subsystem | Breaks at | Residual |
|---|---|---|---|
| 1 | Diagram | ~20 devices unfiltered (≈2,000 elements) | You cannot see the whole estate at once |
| 2 | Incremental lint — population rules | ~50 devices, on bulk import | *"A population rule is inherently `O(N)` per insert. The fix is batching, not elimination"* |
| 3 | Graph in browser memory | 50–80 devices (`11` §14.2) | Provenance hover pays a decrypt |
| 4 | Workspace open | ~100 devices | **"Unresolved. §11"** |
| 5 | Sync write amplification | ~100 devices | Shard count leaks structure |
| 6 | Tier C full sweep | ~20,000 nodes | A pack toggle is a slow operation and should look like one |

`11` §14.2: ~1.1 MB resident per fully-parsed mid-size firewall; 200 devices ≈ 220 MB; *"**The
browser cannot hold a large estate fully resident.** Above roughly 50–80 devices, the client needs
lazy section loading."* `17` §13.3 puts the document model's own ceiling at *"> 2,000 devices — the
premise"*, with the reason: *"you now want to **query**… over data you cannot hold resident, and
that is a database question that a document answers by loading everything."*

**Missing.**

1. **Any organisational level above `Site`.** `11` §7.2's containment is root → `Site` → `Device` →
   `Interface` → `LogicalUnit` → `Address`. There is no `Site → Site` edge and no `Region`,
   `Market`, `Network` or `ServiceArea` kind. R3's networks have no home in the forest.
2. **Partial open, by construction.** `44` §4.8.6: *"Hash shards are not device-aligned, so there is
   no subset of shards that constitutes 'one device': **per-device lazy loading is impossible under
   the decided format.**"* ADR-0013 chose that knowingly — device-aligned records *"publish the
   exact device count in the file count, permanently, in every historical git commit"*.
3. **A re-shard migration.** `S` is fixed at workspace creation (ADR-0013, reversal cost R3;
   *"changing it rewrites every record"*), with the named ladder 8 / 64 / 256.
4. **Any cross-workspace surface** — no catalogue, no switcher, no cross-workspace search, no
   cross-workspace name uniqueness. And no key tier that spans workspaces: `17` §17 is explicit that
   *"Sharding by device is a **storage** boundary, not an access boundary, and calling it one would
   be a lie."*

**Collides with** everything above, and with `03` §4.13 `N-D-2` (*"Fleet-scale workspaces — several
thousand devices"*, Deferred, reopening tied to *"a phase-7 question"*). See §5 X1.

**Size. Not estimable, and the reason matters.** Nobody has defined "network", and the definition
swings the problem by two orders of magnitude:

| If a "network" is… | 1,000 networks is… | Against `44` §7.1 |
|---|---|---|
| A routing domain inside one estate of ~40 boxes | ~40 devices | A labelling requirement with no storage consequence |
| A customer service — `77` §2.2's *"a calix DIA… 5 pieces of equipment in a single line"* | ~5,000 devices | `17` §13.2's last column: ~800 MB on disk, ~1.4 GB graph-only resident, ~30 s open, ~112 s rule sweep |
| One OLT plus its aggregation | ~2,000 devices | 20× past the browser memory line, 20× past the open budget |

Under the workspace-per-network reading, R3 is perhaps 3–6 solo weeks touching `17`, `33` and the
shell (**derived**, by analogy to `71`'s phase-5 decomposition). Under the one-workspace reading it
reopens ADR-0013, all of `44` §4.8 — whose recomputation `44` §4.8.5 itself records as pending —
and `03` `N-D-2`. `71` prices the whole of phase 5 at 16–24 solo weeks for less scope than that. **I
will not put a number on it before the word is defined.**

### 4.4 R4 — customisable name validation

**Exists.**

| Piece | Where | State |
|---|---|---|
| Regex over a name, inside a rule | `12` §3.7's builtin table: `matches(s, /re/)`, *"Regex literal only, compiled at pack build. Linear-time engine, no backreferences, no lookaround"* | Specified, and used in anger in `63` §7 |
| A site-code hook described in R4's own terms | `11` §6.3 `Site.code: Identifier 0..1` — *"Short code used in generated object names"* | One table cell, no generator |
| Validation at the moment of creation, against grammar **plus** a graph fact | `56` §6.4.1's `+ new interface`: *"the name is validated against the platform's interface-name grammar and the device's `Chassis.slots`"* | The exact interaction shape R4 wants, on a different object |
| Per-workspace, operator-authored, private data the engine consumes | `12` §11's `Suppression` — mandatory reason, expiry ladder, natural-key survival across re-parse | 0% of R4's content, most of its shape |
| A sealed home for private settings | `17` §10.1 `RecordKind::Settings` | Exists; holds no policy |

**Missing.**

1. **Any path by which an organisation edits its own naming grammar inside the product.** `matches`
   is *"compiled at pack build"*; `63` makes a pack a directory with a `pack.toml`, a CHANGELOG and
   a validating build; `11` §6.9 puts packs outside the graph entirely. `73` contemplates *"a guided
   rule-authoring form over `fex`"* only as a fallback, not as a decision.
2. **String decomposition in `fex`.** `matches` returns `bool`. There is no `substr`, no capture
   accessor, and `12` §3.4 removes concatenation deliberately (*"Building strings is the template's
   job"*). So a condition cannot split `{ST}{CLLI}{TYPE}{Incremental}` into segments, and cannot
   construct the expected name to compare against the actual one. **The most obvious implementation
   of R4 is grammatically absent from the condition language.**
3. **A vendor field.** `11` §6.3 is emphatic that `Device.platform` is a `PlatformId` — *"`junos-srx`,
   `panos`, `ios-xe`. **Not "vendor"**"* — and `.context/conventions.md` forbids the word outright.
   `Chassis.model` holds `SRX345`, a model. R4's `{TYPE}` = Calix / Nokia has no field to read.
   `63` §5.1's `schema/platforms.yaml` does carry a `vendor:` attribute per platform, and nothing
   consumes it.
4. **A name-template grammar or generator** of any kind.

**Collides with** ADR-0028 (*"Rule packs: first-party only in v1"*), `12` §3.7's compile-at-pack-build
constraint, and — for the letter half — the absence of an address model, because *"letter if there is
multiple per address"* is a **uniqueness constraint scoped to an address**, not a name shape. See §5
X5.

**Size.** 3–5 solo weeks for a workspace-scoped `NamingScheme` settings object with a small closed
template grammar (ordered segments, each one of {literal, enum-from-a-user-list, field reference,
`[0-9]+`, `[A-Z]`}), compiled to a regex at workspace load and read by one `Device`-anchored rule,
plus the settings record and its sync class, plus the findings surface, plus the generator for when
a name is **produced** rather than checked. **Derived**, by analogy to `71` §4.7's per-subsystem
lines. The address-scoped letter rule is not in that number; it is blocked on R5.

One split worth taking early, because it changes the number: **generating** names is strictly
cheaper than **validating** them — no new builtin, no population rule, no estate sweep — and a
generated name cannot be non-conforming. `Site.code`'s own description (*"used in generated object
names"*) shows the corpus half-assumed generation. Validation only earns its cost for names Fathom
did not create, which is most of an inherited estate. The honest answer is probably both, with
different mechanisms, and that is two work items rather than one.

### 4.5 R5 — addresses as first-class

**Exists.** `11` §6.3 `Site.address: Text 0..1`, *"Free prose"*. And its prose-ness is deliberate:
`11` §4.1 uses it as one of exactly three legitimate uses of a raw string — *"a description, a note,
a site address"*.

**Missing.** A structured street address; any relation expressing "these N units share one address",
which is precisely the fact the letter increment encodes; and a geographic grain finer than `Site`,
since `HasDevice: Site → Device` makes `Site` the finest geographic container.

**Two hazards to record before anything is written.**

- **The noun is taken.** `11` §6.4 already has an `Address` kind, meaning an **IP** address on a
  `LogicalUnit`, with identity tuple `[owner(LogicalUnit), value]`. `11` §4.3 already warns that
  conflating `InterfaceAddress` and `IpPrefix` is *"the most common modelling bug in this domain"*.
  A postal-address kind must be called something else — `Premises`, `Location`, `ServiceAddress`.
- **Enrichment is closed, permanently.** Geocoding, map tiles, postal lookup and autocomplete all
  require egress, which invariant 1 forbids. `34` §9.4 goes further: the application renders no
  clickable external link, in any surface. A user-typed latitude/longitude pair is storable and is
  a different thing; say so explicitly so it is not re-litigated.

**Collides with** `11` §4.1's own example, and with `11` §11.3's version-bump rules if it becomes a
kind. See §5 X6.

**Size.** 1–2 solo weeks as a `PostalAddress` semantic scalar implementing `11` §4.2's `Scalar`
trait — whose `canonical()` is exactly the primitive a per-address uniqueness rule needs. 4–7 solo
weeks as a new node kind, because the version bump, the migration, the diagram projection table
(`56` §4.1) and the inventory column sets all move together. **Derived.** The choice turns on one
question: can one address hold several `Site`s, and can a device move between addresses? In an FTTx
estate the answer to the first is very often yes, which points at the kind.

### 4.6 R6 — the visualiser

**Exists, and this is the surprise of the analysis.** The named mode is already specified, port
resolution included.

`56` §6.4.1, in full:

> *"A `Link` edge is `Interface → Interface` (`11` §7.3), and a device-level gesture does not name
> ports. So the gesture does not create an edge — **it opens an inline disclosure that resolves the
> ports, and the edge is created on confirm**… Only *unlinked* interfaces are offered (`Cabled` is
> `0..1` on both ends). `+ new interface` creates one, and the name is validated against the
> platform's interface-name grammar and the device's `Chassis.slots`… On confirm: one
> `Op::AddEdge { kind: Link, from, to }` with `media`, provenance `Origin::Hand`. That is it — one
> edge, one undo step, and the picture redraws."*

And the keyboard twin `77` §8 asks for is already the **reference implementation**, not the
afterthought. `55` §5.5:

> *"**Drag from port to port to draw a link** | Select source, `L`, select target, confirm in the
> disclosure | identical — **the gesture is *already* select-then-select, and the drag is the
> shortcut, not the mechanism**"*
>
> *"**specify the two-step form first and make the drag a shortcut for it.** Drag-first designs need
> a bolted-on alternative that nobody tests; this one has the alternative as the reference
> implementation and the drag as sugar."*

**Missing.** Any wheel binding, anywhere. Any concept of a diagram tool-mode — `56` §0 enumerates
view-local state as exactly two items (the pan/zoom transform and the layer mask) and `71` §7.3
X4.3 makes that an exit criterion. And, separately and awkwardly, **any binding for continuous
zoom**: `53` §3.4 binds only `z` (zoom to fit), while `56` depends on zoom thresholds at 0.35 and
0.6 throughout. That is an unowned interaction R6 will trip over regardless of the wheel decision.

**Collides with** `53` §2.2 principle 5 (no modes), `55` §5.5 (pan owns the scroll gesture), and —
much larger — ADR-0006, which cuts the diagram to an SVG export and saves *"5–9 of 6–10 solo weeks"*.
See §5 X4 and X8.

**Size.** The diagram itself is `71` §7.5's phase 4: **solo 6–10 weeks**, decomposed as layout 2.5–4,
layer model and rendering 1.5–2.5, interaction 1.5–2.5, staleness/export/performance 0.5–1. The
wheel is days on top of that interaction line **if built as a third driver for the `56` §6.4.1
disclosure**, and a new subsystem if built as a floating port ring that commits on `pointerup`. The
second form has no keyboard analogue, no Outline row (`56` §7: *"A new decoration is not shippable
until it has an Outline row"*), and silently drops `Link.media` — which is `56` §11 failure mode 15
one field over.

**"As easy as Jira" needs a falsifiable form or it will be re-argued at every review forever.**
`44` has a budget for everything else in this product. Two notes on the phrase itself. `53` §2.1
lists **Jira** in the precedent row of the scheme Fathom already chose, so the *ceremony* reading is
compatible. The *aesthetic* reading is not: `56` §5.1 removes colour from the diagram entirely, and
`59` §4 re-decides that after building two colour models. **RECOMMENDATION — replace the adjective
with a number**: median time to cable two devices from cold, by a user who has not been shown how,
by pointer and by keyboard, with the same widget in both.

### 4.7 R7 — the engines

**Exists, and `77` §9 already answered the question correctly.** The modularity is real and it is
delivered at a smaller unit than an engine: per-platform code is a lexer token table and a shaper
(`14`, 200–600 lines each) plus a `Platform` trait impl and a `KindEmitter` per emitted kind
(`13` §6.2). Everything else — rules, commands, explainers, dictionary entries — is data carrying
`platforms` and `versions` predicates, per invariant 5's *"No per-vendor engines."*

**So the code delta for two access platforms is roughly 800–2,400 lines.** That is the small part
and it is not what R7 costs.

**Missing.** The content behind it, and the domain itself. `14` §15: *"the dictionary is a content
programme — 400–2,500 entries per platform, human-reviewed. Coverage is the product's real limit,
and no amount of parser engineering moves it."* `71` §5.7 budgets ~1,750 dictionary entries and
*"6–9 weeks of domain time"* for `junos-srx` alone. Plus version schemes: `63` §6.2 requires a
Fathom-local grammar and a total comparison function per scheme, and neither Nokia SR OS nor Calix
AXOS numbers anything like Junos.

**Size.** Not estimable before the fit test in §7. See §6 for the corpus arithmetic and §5 X3 for
why this is the project's own named fatal risk arriving from an axis nobody instrumented.

---

## 5. The collisions, ranked

*margin tab: named, not resolved*

Ranked by how expensive each is to discover late, following `77` §11's discipline. **None is
resolved here.** Options are given because a collision with no options is a complaint.

### X1 — R3 versus the entire scaling analysis

| | |
|---|---|
| **Requirement** | *"we have many networks, hundreds to thousands"* |
| **Contradicts** | `44` §7.1 rows 1–5 (breakage at 20 / 50 / 50–80 / ~100 / ~100 devices, row 4's residual literally *"Unresolved. §11"*); `11` §14.2 (*"the browser cannot hold a large estate fully resident"*, 50–80 devices); `17` §13.3 (*"> 2,000 devices — the premise"*); ADR-0013 (`S` fixed at creation, ladder tops out at 256, reversal cost R3); `44` §4.8.6 (*"per-device lazy loading is impossible under the decided format"*); `03` §4.13 `N-D-2` (deferred, reopening tied to a phase-7 question) |
| **Severity** | **Blocking, and the largest gap between what was asked for and what is designed.** An order-of-magnitude gap, not a tuning gap |

Options:

| | Option | Cost |
|---|---|---|
| a | **One workspace per network**, plus a switcher and a catalogue that never decrypts more than one at a time | Cheapest. Breaks no invariant, keeps ADR-0013 intact. Loses every cross-network query, and **kills R4's letter increment outright** if the increment is unique across an address that spans networks. Also kills R2 wherever a cable crosses a network boundary, because `11`'s edges are `NodeId → NodeId` inside one graph |
| b | **Reopen ADR-0013** for a site- or network-aligned shard | A storage-layer re-architecture on encrypted data, plus the metadata leak ADR-0013 refused. `71` prices all of phase 5 at 16–24 solo weeks for less scope |
| c | **Split the deployment claim** — native/CLI carries fleet scale, browser carries a working subset | `11` §14.2 already concedes 220 MB is *"well within a native CLI"*; `43` already specifies both shapes. But D1, the offline single file, is the artefact the whole security argument is built on, and demoting it is a positioning change that should be an ADR |
| d | **Cut per-device cost** | Means cutting per-field provenance, which is the mechanism behind the entire teaching claim. `11` §14.2: provenance is ~40% of resident size and *"the remaining cost is irreducible if per-field provenance is kept"* |

**Two facts that must precede any choice.** First, the definition of "network" (§8, Q1). Second,
that **no figure quoted above is currently citable**: `17` §13.1 carries a supersession — *"Every
record count, byte figure and overhead line in §13 must be recomputed against the fixed shard set…
The recomputation is pending"* — and `44` §4.8.5 carries the same note. ADR-0013 states the
direction of the recomputation: *"it will get worse, not better."*

### X2 — R1 + R5 + "it's where the estate lives" versus `N-R-2`

| | |
|---|---|
| **Requirement** | A per-equipment page with a port list, at a street address, in a product that is *"where the estate lives"* |
| **Contradicts** | `03` §4.2 `N-R-2`, one of a handful of entries whose `Reopens if` reads **Never** — *"This is the refusal that keeps the product honest about §2.2 of the brief."* Also `52` §3.7, which positions the inventory *against* NetBox |
| **Severity** | **High. A product-identity decision, not an engineering one** |

Options: §3.3's routes A, B and C, plus the importer `03` §9.1 already puts in scope. The corpus
already asked for this to be taken once, deliberately (`75` §16 disagreement 6), and it has never
been answered.

### X3 — R7 versus ADR-0030's break trigger and R-SCHEMA

| | |
|---|---|
| **Requirement** | Engines for a Calix / Nokia access estate |
| **Contradicts** | ADR-0030 decision item 3, which wrote the trigger down in advance so it would be honoured: *"**zero new node kinds** means the schema generalises… **one to three** means it bends and the cost is bounded; **more than three, or any new edge *shape*** means it breaks."* And `71` §1.4's R-SCHEMA — *"Fatal, and the most expensive to discover late."* And `03` §6.2's domain table, whose not-planned row reasons *"Each is a product"* |
| **Severity** | **High, and the sizing driver most likely to go unpriced because it looks like "just another platform"** |

The access domain plausibly needs `Tenant`, `Service`, `ServiceEndpoint`, `Premises`, `Circuit`,
`Splitter`/`PassiveNode` and `ServiceProfile` — seven-plus kinds and at least one new edge shape. On
ADR-0030's trigger as written, that fires immediately.

Options:

| | Option |
|---|---|
| a | **Distinguish the two axes in an ADR.** ADR-0030's trigger was written for a second **platform** in the same domain. A second **domain** adding kinds is additive, not contradictory, and does not falsify vendor-neutrality. Keep the phase-7 trigger for its intended axis |
| b | **Take `72` §3.5's narrowing voluntarily** — restate the bet as *"neutral enough that `explain`, `lint` and `render` work across platforms even where `emit` does not."* Less of a retreat than it reads: `11` §12.2 already concedes exactly that for security policy, and ADR-0030 item 4 already carries the concession into public positioning |
| c | **Conflate them and let the trigger fire**, producing a narrowing decision on evidence nobody gathered |

(c) is what happens by default if nobody writes (a) down.

### X4 — R6 versus ADR-0006

| | |
|---|---|
| **Requirement** | A visual maker, now |
| **Contradicts** | ADR-0006, **Accepted**: *"**v1 = the finder**… **Nothing about a graph**"*, and decision item 4, *"**The diagram is cut to an SVG export** (D17 + `84` §9.2), saving 5–9 of 6–10 solo weeks."* `71` §7.1 puts the diagram fourth, behind the graph, the emitter, the rule engine and the parser |
| **Severity** | **High, and it is a plan collision rather than a design one** |

`71` §7.1's argument for building the diagram fourth is worth reading before reversing it: *"There
is no room left for the diagram to invent state, because every property it would invent already has
a home with a stable ID and a provenance record."* That argument is about ordering, and it survives
a reordering only if the graph still lands first.

Options: reverse ADR-0006 on merit through the ADR process — R1 + R2 + R6 are a coherent argument
that inventory-plus-per-equipment-page is the wedge for an access estate in a way the finder is not;
or keep it and build R1/R2 first, which delivers port navigation with **no layout engine at all**
(a port row whose right-hand cell links to the `Cabled` peer), with R6 becoming a faster way to
create the edges R1's page displays. The second is the cheapest path to most of the value.

### X5 — R4 versus rules-as-signed-corpus

| | |
|---|---|
| **Requirement** | *"that should be customizable"* — per-operator, private naming policy |
| **Contradicts** | `12` §3.7 (*"Regex literal only, **compiled at pack build**"*); `11` §6.9 (*"Rule packs, suppressions, corpus entries — these are workspace siblings, not graph nodes"*); ADR-0028 decision item 3 (*"Rule packs: first-party only in v1"*); invariant 10 (*"The corpus is human-authored and reviewed"* with a named `reviewed_by`); `63`'s mandatory `acceptable_when`, `sources`, `must_fire`/`must_pass` fixtures and two-reviewer ceremony |
| **Severity** | **High for the customisation half.** The letter half is blocked on R5, not on the naming engine |

The asymmetry is the point: the ceremony that is right for *"PFS is absent"* is wrong for *"our
routers start with the state code"*. Options: a workspace-scoped `NamingScheme` settings object with
a closed template grammar (no user code loaded, so the closed-corpus supply-chain posture in `34`
and `35` is untouched, and invariant 10 never applies because the artefact is workspace data rather
than corpus); a full user-installable pack system (imports a code-loading surface, far more than R4
asked for); or one shipped pack per convention (fails the requirement outright).

### X6 — R5 versus `11` §4.1 and the `Address` name

| | |
|---|---|
| **Requirement** | Addresses structured enough to carry `{CLLI}` and to scope a uniqueness rule |
| **Contradicts** | `11` §4.1, which uses *"a site address"* as its canonical example of legitimate free prose; `11` §6.4's existing `Address` kind, which means an IP address; `11` §11.3's bump rules, which make schema changes expensive |
| **Severity** | **Medium in isolation, but it is a schema change and those are cadence-constrained** |

Options in §4.5. The upstream question is whether one address may hold several `Site`s.

### X7 — R2 versus passive plant

| | |
|---|---|
| **Requirement** | Cabling in an FTTx estate |
| **Contradicts** | `11` §7.3's `Link` cardinality `0..1` on both ends, justified in §7.4 by *"A `Link` has exactly two endpoints, always"*. And `11` §6.3's definition of `Device` as *"The unit that a configuration file is a configuration file **of**"* — under which a splitter, ODF, patch panel or handhole cannot be a `Device`, and no other kind fits |
| **Severity** | **Low today, high after data exists.** A correctness trap that gets expensive once cables are entered |

Options: a `Splitter`/`PassiveNode` kind with ordinary binary `Link`s on each leg (cheapest, matches
physical reality — there really are two cables — but needs `Device`'s config-file definition
relaxed or a sibling kind added); promote `Link` to a node (reverses `11` §7.4 and touches the
diagram, diff, emit and selection); or introduce `Circuit` now, which `11` §7.4 pre-designed and
explicitly declined to build speculatively — *"should get its own `Circuit` **node** when it is
needed, with `Link --OverCircuit--> Circuit`."*

**Decide this before any cable data is entered.** Migrating a populated `0..1` edge to a fan-out
model is the kind of change `11` §11.3 charges a major bump for.

### X8 — "multiple modes" versus `53` §2.2

| | |
|---|---|
| **Requirement** | *"With multiple modes too"* |
| **Contradicts** | `53` §2.2 principle 5: *"**No modes. No mode indicator. No mode errors.**"* With a written defence: *"A modal scheme charges two mode transitions per field — thirty transitions — and prices every missed transition as a command executed against a graph. In `vi` a missed transition costs a character; here it can cost a deletion."* And §2.1's discoverability objection: *"Modes are invisible unless you draw an indicator, and `design-language.md` has no place to draw one"* |
| **Severity** | **Medium-high as stated; smaller once read precisely** |

Read `53` §2.2 exactly: its arithmetic is about **keyboard dispatch** — a mode that changes what a
letter means. It is not a refusal of tool-modes, and the product already ships one: `⌥D` puts the
config view into `ChangeSet` mode, decided at `52` §1.1 with the cost conceded and mitigated by
naming the mode in the view band. `56` §6.4's `L`/`T` is already a mode in everything but name — a
key that puts the view into "awaiting a target" until you select one or press `Esc`.

Options: reframe modes as **tools** (armed explicitly, scoped to one canvas, always showing their
armed state, disarmed by `Esc`, never changing what a letter means) and write the distinction down;
amend principle 5 to *"no **global** modes"*; or hold the prohibition and express every mode as a
distinct verb, which is `53`-compliant today and does not scale past about six verbs.

A related, live defect that R6 would compound: `56` binds `L`, `T` and `Shift+U` and none appears in
`53` §3, despite ADR-0024 making `53` the sole keymap owner and `56`'s own preamble claiming *"this
document binds no keys"*. ADR-0024(4) mandates a CI check that would fail on the corpus as it stands.

### X9 — R1 versus `52` §9.5

| | |
|---|---|
| **Requirement** | A per-equipment page |
| **Contradicts** | `52` §9.5 (*"Six views fit. If a seventh is ever added, this design has a real problem"*) and §9.6's scent budget (*"at most 14 discrete facts"* above the body; *"Adding a fact to the header means removing one"*) |
| **Severity** | **Low-to-medium, design-local** |

Options: a **mode of inventory** on `52` §1.1's precedent, named in the view band as
`inventory · SRX-A · 48 ports`; the inspector grown up; or a seventh view, which `52` §9.5
pre-emptively calls a real problem. The one thing to resist under the first option is letting the
device page grow its own header furniture.

### X10 — the wheel versus pan

| | |
|---|---|
| **Requirement** | Mouse-wheel port selection |
| **Contradicts** | `55` §5.5: *"**One drag remains and it is exempt: pan.** Panning is `Space`-drag or a scroll gesture."* Pan is also the most heavily instrumented interaction in the product — `44` B13 budgets an 8 ms P95 pan frame, and `56` §10 gates `svg_attrs_written_per_pan_frame` at exactly 1, calling it *"the single most valuable counter in this document"* |
| **Severity** | **Low, with a clean fix** |

Options: scope the wheel to the pointer-capture window only. `56` §6.3 already does
`setPointerCapture` on `pointerdown` with `Esc` reverting and releasing. Between `pointerdown` on a
source device and `pointerup` on a target, the wheel is free by construction and pan is not in play
— a bounded window, no new state, `55` §5.5 unchanged. Outside that window the wheel stays pan. And
in the same edit, bind continuous zoom, which nothing currently does.

### X11 — `{TYPE}` versus the platform vocabulary

| | |
|---|---|
| **Requirement** | *"type is the brand, like calix, nokia"* |
| **Contradicts** | `.context/conventions.md`: *"**platform** — a vendor+family target… Never say: **vendor** (a vendor has many platforms)"*. `11` §6.3: `Device.platform` is *"Not 'vendor'"*. `63` §5.1 restates it and calls the confusion *"the most common authoring mistake in this whole format"* |
| **Severity** | **Medium, and the propagating kind** |

Calix ships AXOS, EXA and E-Series; Nokia ships SR OS, SR Linux and ISAM. A device named `…CALIX01`
tells the rule engine nothing about which platform it runs, so a naming scheme keyed on brand and a
rule set keyed on platform are two enumerations that will be assumed to be one.

Options: consume the `vendor:` attribute `63` §5.1's `schema/platforms.yaml` already declares and
nothing reads — naming keys on vendor, rules key on platform, and a validator can then check that a
device named CALIX actually carries a Calix platform id, which is a stronger check than either
alone; give the naming scheme its own declared token alphabet, decoupling R4 from ADR-0030's
platform schedule entirely; or key `{TYPE}` on the platform id and accept longer names.

### X12 — everything field-shaped versus ADR-0008

| | |
|---|---|
| **Requirement** | Ports as an inventory, addresses, naming policy, vendor, service types |
| **Contradicts** | ADR-0008: *"A field that exists in prose and not in `schema.yaml` does not exist"* — and `docs/60-content/62-schema-spec.md` **does not exist**. ADR-0008 prices it at *"two to three weeks of specification plus the codegen"* and records that it is *"not in `71`'s phase table and it is not in `83` §12's re-costing either"*, on the critical path for phases 1, 2 and 3 |
| **Severity** | **Structural. Not a collision so much as a queue** |

`75` §12 already counts this as blocking every field-shaped register entry. `77` §16 disagreement 4
counts three clusters. With ports, addresses and naming it is four. There is no option here other
than writing it, and §7 puts it in the plan.

---

## 6. The domain question — a second corpus, costed

*margin tab: the number nobody has said out loud*

### 6.1 The signal, stated plainly

CLLI codes, Calix, Nokia, multiple units per street address, hundreds to thousands of networks, and
— from `77` §3.1 — DIA, E-Line, E-LAN with per-location UNI IDs, voice and LTE. That is an access /
FTTx service-provider estate.

The corpus is not that. Measured, not asserted:

| Search | Result across `docs/`, `corpus/`, `.context/`, `design/`, `README.md` |
|---|---|
| `clli`, `calix`, `pon`, `olt`, `ont`, `fttx`, `gpon`, `splitter` | **Zero hits** outside `77` itself |
| `nokia` | Three hits, all prior art — containerlab NOS images (`02`), OpenConfig deviation practice (`72`). Never as a target platform |
| `wheel` | Zero outside `77` |

`03` §6.2's domain table lists IPsec site-to-site, zones and policy, interfaces and addressing and
reth/LAG and static routes, and MTU/MSS. Access/FTTx is not on it, and the table's not-planned row
reasons about wireless, QoS, MPLS, EVPN and SD-WAN with one sentence: *"**Each is a product**."*

### 6.2 What actually transfers, measured

The brief for this analysis says "the existing 100 entries". The real count is **177**, and the
breakdown matters:

| File | Entries | Platform tagging |
|---|---|---|
| `corpus/commands/junos-srx-ipsec.yaml` | **98** | 100% `platform: junos-srx` |
| `corpus/rules/ipsec-junos-srx.yaml` | **37** | 100% `platforms: [junos-srx]` |
| `corpus/explainers/ipsec-concepts.yaml` | **42** | 21 `platforms: ["*"]`, 21 `platforms: [junos-srx]` |
| **Total authored** | **177** | |

The 21 wildcard explainers look like transferable content and are not. They are IKE and IPsec
protocol concepts — phase split, object chain, PFS, rekey, peer identity, DPD, NAT-T, MTU overhead,
replay, MSS clamp. They are platform-neutral **within** the IPsec domain. An access estate shares
none of them.

> **Content transfer from the existing corpus to an access/FTTx domain is effectively zero — call it
> 0 of 177.** What transfers is everything around the content: the entry formats (`61`, `63`, `15`),
> the 14 command gates, the V1–V25 rule gates, the CG1–CG9 coverage gates, the linter, the
> resolution ladder, the three-depth model, the rot model, the coverage metrics and the authoring
> pipeline. None of that assumes IPsec, and it is a large amount of work already done.

### 6.3 What a second corpus costs, by `15` §12's own method

`15` §12.6's rates, which that document itself marks as planning assumptions: 25 min author + 7 min
technical review + 3 min voice review = **~35 min per entry**. `15` §12.2's v1 denominator for one
domain × one platform: **≈430 entries**, ≈250 h, **6–7 person-weeks**.

The critical structural fact is in `15` §12.2's v2 arithmetic: *"`kind`, `field`, `value`, `concept`
and `symptom` are shared across platforms; only `line`, `block`, `command`, `output`, `error` and
`step` multiply."* Those ~450 shared entries are shared **across platforms within a domain**. A new
domain shares none of them, so it pays the full ~430 for its first platform, not the ~350 marginal
rate.

**Derived**, using `15` §12.2's method and `15` §12.6's rates:

| Item | Quantity | Cost |
|---|---|---|
| Calix, full domain v1 (shared + platform-specific) | ~430 entries | ~250 h ≈ **6–7 person-weeks** |
| Nokia, platform-specific half only | ~350 entries | ~205 h ≈ **5–6 person-weeks** |
| Statement dictionaries, two platforms | 400–2,500 each (`14` §15); `71` §5.7's `junos-srx` figure is ~1,750 at 6–9 weeks of domain time | **12–18 weeks of domain time**, parallelises better than explainers |
| Rule pack for the access domain, zero reuse | 40–60 rules, by analogy to `71` §11's *"rules: ipsec core (40–60)"* | **2–4 person-weeks** <!-- VERIFY: no document publishes a rule-authoring rate; this is inferred from the explainer rate and should be replaced by measurement --> |
| **Corpus subtotal, before one line of Rust** | | **≈25–35 person-weeks of D1 time** |
| Rot, recurring | `72` risk 1: ~0.8 person-weeks/year/platform-domain × 2 | **+1.6 person-weeks/year, forever**, on top of `junos-srx`'s existing 0.8 |

At `15` §12.6's own pessimistic case — *"If the real median is 45 minutes rather than 25"* — the
explainer pair alone moves from 11–13 to **16–19 person-weeks**.

### 6.4 The binding constraint is who, not hours

`71` §15.1: *"**D1 is the scarcest resource and the least substitutable.** A senior network engineer
who can write in the field card's voice, has hardware, and is willing to spend hours on YAML is
rare… If D1 is 0.2 FTE rather than 0.6, the content-bound phases roughly double and no amount of
engineering changes that."* R-CORPUS is rated Fatal.

**And here is the argument in favour of the domain shift that nobody in the corpus has made.**
ADR-0027 requires two physical boxes and a named public expert reviewer (`74` §9.4: has operated the
platform in production, is not the entry's author, is named publicly with consent in
`GOVERNANCE.yaml`). ADR-0030's own negative consequences record that this is unsolved for the
platform it chose: *"**There is no PAN-OS hardware**… the second platform inherits an unsolved
dependency that this ADR does not solve."*

For an access domain, the owner plausibly **is** D1 and plausibly **has** the boxes. That does not
make the corpus free. It makes it possible, which for R-CORPUS is the entire question — and it is
the single strongest argument for the domain shift on the table.

### 6.5 The sequencing consequence

`71` §16 open decision 7: *"Is there a phase 8 (second domain) or does the project stabilise at one
domain × two platforms? | Current lean: **Second domain, two platforms**, because it tests the
schema on the other axis | **Blocked on: Phase 7's outcome.**"*

Phase 7 does not exist. Nor does phase 0. The owner has answered an open decision they did not know
existed, in the direction the roadmap already leaned, roughly two years earlier than the roadmap
sequenced it — and the lean's own rationale (that the second domain tests the *other* axis, i.e.
after the first is settled) now runs simultaneously with the first instead of after it.

Three shapes, and the choice is the owner's:

| | Shape | Consequence |
|---|---|---|
| a | **Invert** — access/FTTx primary, Calix primary platform; SRX/IPsec becomes the second | Puts the owner's own expertise, vocabulary and hardware on the critical path from week one, which is the largest available lever on R-CORPUS. Costs the 177-entry seed its place as the phase-0 corpus, and rewrites `71` §3.3, `03` §6.1–6.2, ADR-0029 and phase 0's exit criteria |
| b | **Run both domains** | Requires two D1s. `71` §15.1 says D1 is the one resource that cannot be doubled by hiring an engineer |
| c | **Freeze SRX/IPsec as a completed slice and add access on top** | Cheapest on paper. Leaves ~0.8 person-weeks/year of rot running on a domain nobody in this estate uses |

---

## 7. The revised build order

*margin tab: what to do on Monday*

> **NO APPLICATION CODE EXISTS. NOT ONE CRATE. THE PLAN MUST START THERE**

### 7.1 The starting position, stated without decoration

The repository contains: ~87,000 lines of specification across 84 documents, of which 30 are ADRs;
177 authored corpus entries that have never been run on hardware; and 15 static HTML design
studies. There is no Rust. There is no `Cargo.toml`. `docs/60-content/62-schema-spec.md`, which
ADR-0008 makes a
prerequisite for every field named in `77` and in this document, has not been written and is not in
`71`'s phase table.

Everything below is therefore greenfield, and the ordering principle is `71` §1.2's O2 — **retire
the cheapest expensive risk first**, ordering by risk severity ÷ cost to test.

### 7.2 The order

| # | Slice | Delivers | Depends on | Retires | Size (solo) |
|---|---|---|---|---|---|
| **S0** | **The fit test** | A list: which node kinds, edge kinds and fields the IR lacks for a Calix/Nokia access estate | Owner supplying three real configs and one site export | **R-SCHEMA for the access domain** — the register's most expensive risk, settled before a line of code | **1–2 wk, no code** |
| **S1** | **The estate census** | The number behind R3: devices per network × networks, and whether cables cross network boundaries | Owner | Nothing technical. Unblocks every other estimate in this document | **2–3 days** |
| **S2** | **`62-schema-spec.md` + `schema.yaml` + codegen** | The file six subsystems consume; Rust types, `fex` name environment, emitter accessors, pack-lint kind universe generated from one source | S0 (writing it before the fit test means writing it twice) | The four-workstream queue (`75` §12, `77` §16 disagreement 4, X12) | **3–5 wk** (ADR-0008's 2–3, plus the access kinds S0 found) |
| **S3** | **`fathom-graph`** | The store: kinds, edges, scalars, `Presence`, provenance, L0 enforcement at write time, ops and undo batches | S2 | R-PROVENANCE in part; the precondition for everything the owner asked for | **5–7 wk** (`71` §4.7's own line) |
| **S4** | **Inventory + per-equipment page + port navigation (R1, R2)** | The virtualised table, the kind-plus-filter row set, the generated column picker, the nested device→interface rows, the inspector, the `Cabled peer` navigation cell | S3 | R1 and R2 in full. **The first user-visible thing in the plan** | **3–5 wk** (`71` §5.7's inventory-table line, widened for the detail surface and the peer traversal) |
| **S5** | **Naming and addresses (R4, R5)** | `NamingScheme` settings record, closed template grammar, compile-at-load, name generation on create, conformance audit, address model | S2, S3, S4 | R4's generation half and R5 | **5–9 wk** (§4.4's 3–5 plus §4.5's 1–2 or 4–7) |
| **S6** | **Ingest — one access platform (R7, half one)** | Lexer table, shaper, bind, residue ledger, paste UI, reverse explanation | S2, S3, and the dictionary track | R-ONRAMP and R-RESIDUE for the access domain | **14–20 wk** (`71` §2's phase-2 rate) |
| **S7** | **Diagram, cabling-first (R6)** | Physical layer, ports as stubs, the `56` §6.4.1 connect disclosure, drag as sugar, wheel as a third driver inside the pointer-capture window | S3, S4 | R-VIEW | **6–10 wk** + ~1 for the wheel (`71` §7.5) |
| **S8** | **Scale (R3)** | Whichever of X1's options the owner picks | S1's answer | `N-D-2`, or a formal restatement of it | **Not estimable until S1 lands** |
| — | **The corpus track** | Access-domain explainers, rules, command entries, dictionary | S0 | R-CORPUS, continuously | **25–35 person-weeks of D1**, parallel, starting at S0 and never finishing (§6.3) |

**Two things this order does not include, and the omission is deliberate.**

It does not include the finder. ADR-0006 makes the finder v1 and phases 0–3 the product, and none of
R1–R7 touches it. Keeping ADR-0006 delays everything the owner just asked for by 12–18 solo weeks.
Reversing it is defensible on merit — R1 + R2 are a plausible wedge for an access estate in a way
the finder is not — but it is a reversal of an Accepted ADR and it must be taken explicitly, not
absorbed. **S0 and S1 are valid under either branch**, which is why they are first.

It does not include the service layer — tenants, CIDs, UNIs, service types, paths and the warp
(`77` §§2–5). That is a second modelling domain on top of the configuration graph, and `77` §16
disagreement 3 is right that it may be the actual product. It is not costed here because S0's
output is what makes costing it possible.

### 7.3 The first slice, concretely

**S0 — the fit test. This can start on Monday and needs no code, no tooling and no decisions.**

It borrows ADR-0030's pattern exactly: a read-only spike whose single deliverable is a list of what
the IR lacks, with its exit criterion written down **before** the evidence is gathered, per `73`
§1.4's rule — *"Evidence that would change it | Written before the fact, so it counts when it
arrives."*

**Inputs to collect (owner, day one):**

1. A full configuration export from **one Calix access node** — an OLT or equivalent.
2. A full configuration export from **one Nokia node** in the same estate — aggregation or access.
3. A full configuration export from **whatever terminates one real customer DIA**.
4. **One real service record**: a CID, its type, its endpoints, and the equipment and ports it
   traverses end to end. Hand-written is fine.
5. **One site list** with CLLIs, street addresses, and the equipment names at each — a CSV, a
   spreadsheet export or a NetBox export. This is also the R5 on-ramp test.

Redact freely. Nothing here needs to be shareable outside the project, and `14`'s redaction gate
does not exist yet.

**The work (1–2 weeks):**

- Walk `11` §6's 38 node kinds and mark each **Fits** / **Bends** / **Missing** against inputs 1–3.
- Walk `11` §7's edge table the same way, marking specifically any relation that is not
  binary-with-fields — the PON split being the expected one (X7).
- For input 4, write down the smallest set of kinds and edges that records that service honestly,
  and check each against `11` §6.1's kind-earning test: *"A concept earns its own kind only when it
  has a distinct required-field set, a distinct edge signature, or a distinct lifecycle."*
- For input 5, count how many addresses hold more than one site, and how many equipment names
  actually conform to `{ST}{CLLI}{TYPE}{Incremental}`. That second number is the honest measure of
  whether R4 is a validator or a generator.
- Count the distinct configuration statements in inputs 1–3 to get a first dictionary estimate
  against `14` §15's 400–2,500 range.

**The exit criterion, written now:**

| Outcome | Reading | Response |
|---|---|---|
| **Zero new node kinds** | The IR generalises across domains, which would be a stronger result than ADR-0030 hoped for on the platform axis | Proceed to S2 with the access domain as an additive schema change |
| **One to three** | It bends. The cost is bounded | Proceed to S2, land the kinds in the one schema window (`11` §11.3), and price the corpus at §6.3's figures |
| **More than three, or any new edge shape** | It breaks for this domain — which is the expected outcome, and which is fine, because it is being discovered in week two rather than year three | Take X3's option (a) or (b) as an ADR **before** S2, and re-cut §6.3's corpus estimate against the real kind count |

**Why this is first.** It costs days, it needs nobody but the owner and a reader, it produces the
one input every other estimate in this document is missing, and it settles the risk `71` §1.4 calls
*"Fatal, and the most expensive to discover late"* against the domain the owner actually operates.
Every alternative first slice — the schema spec, the graph crate, a prototype page — is work that
gets redone if S0's answer is the third row.

---

## 8. What must be decided before slice one starts

*margin tab: only the owner can answer these*

| # | Question | Why it blocks | Where it bites |
|---|---|---|---|
| **Q1** | **What is a "network", and how many devices are in one?** Are they routing domains inside one estate, or separate customer/market estates? | Every sizing answer in this document and the whole of X1 swing on it. `44` §7.1's breakage table is denominated in devices, and R3 is stated in networks. Nobody has multiplied them | §4.3, X1, S1, S8 |
| **Q2** | **Do cables cross network boundaries?** | If yes, one-network-per-workspace is dead on arrival — `11`'s edges are `NodeId → NodeId` inside one graph, and no edge can span two sealed containers under different keys | X1 option (a), R2 |
| **Q3** | **Is `N-R-2` amended, clarified, or held?** (§3.3 routes A / B / C) | It is the fork. An implicit reversal leaves `03` §4.2, `03` §11, `01`, `02` §12.3, `52` §3.7 and `31` all asserting the opposite of what the product does | §3, X2 |
| **Q4** | **Does the existing estate already live in a source of truth that can be exported?** | `03` §9.1 already puts a NetBox/Nautobot importer in scope and `02` §5.1 calls it *"a small piece of work with a large payoff"*. If ports, cables and addresses exist somewhere exportable, an importer is dramatically cheaper than modelling them, and it sidesteps most of X2 | §3.3, S4, S5 |
| **Q5** | **Does R1 need to show ports that are not configured** — empty cages, dark fibre, spare positions? | If yes, Fathom needs a physical-port inventory it does not have, and `Chassis.slots` does not provide one. If no, R1 lands at 1.5–3 weeks | §4.1, S4 |
| **Q6** | **Does the physical plant include passive splits, breakouts or patch panels you traverse *through*?** | Decides whether `Link`'s `0..1/0..1` holds, and whether `Circuit` is promoted early. **Must be settled before any cable data is entered** | X7 |
| **Q7** | **What is `{ST}`** — state, or site type? | `77` §7 marks it `<!-- VERIFY -->` and it is genuinely unstated. A wrong expansion propagates into the schema and into every generated name | §4.4, S5 |
| **Q8** | **What does `{TYPE}` resolve to** — a new vendor field, the unused `vendor:` attribute in `schema/platforms.yaml`, or the scheme's own declared token list? | R4 cannot be specified without it, and the third answer decouples R4 from ADR-0030's platform schedule entirely | X11 |
| **Q9** | **Is Fathom's naming feature a validator, a generator, or both?** | Generation is strictly cheaper and strictly more correct; validation is the only thing that helps with inherited names. They are two work items, not one | §4.4, S5 |
| **Q10** | **Is SRX/IPsec retired, carried, or frozen?** (§6.5 shapes a / b / c) | It decides whether the 177 existing entries and phase 0's exit criteria stay in the plan, and whether one D1 or two are needed | §6, S0, the corpus track |
| **Q11** | **Is ADR-0006 reversed?** | Keeping it delays R1–R7 by 12–18 solo weeks. Reversing it is defensible and must be an ADR | X4, §7.2 |
| **Q12** | **Does the owner have Calix and Nokia hardware, and will they be the named public reviewer under `74` §9.4?** | This is the fact that most changes the corpus estimate, and it is the dependency ADR-0030 records as unsolved for PAN-OS | §6.4 |

**Q1, Q2 and Q10 gate S0's inputs. The rest can be answered while S0 runs.**

---

## 9. Failure modes of this analysis

*margin tab: how this document is wrong*

| # | Failure mode | Why it is plausible | Mitigation |
|---|---|---|---|
| 1 | **The sizes are read as commitments.** Every figure derived here rests on `71`'s rates, which rest on `15` §12.6's rates, which `15` itself marks *"a planning assumption, not a measurement"* | It is the normal fate of a table of numbers | Nothing below §4 should be quoted without the word *derived* attached. `15` §12.6's own consequence applies: if the real median is 45 minutes, the phasing needs re-cutting, not the estimate re-arguing |
| 2 | **The storage numbers are quoted anyway.** `17` §13.1 and `44` §4.8.5 both carry pending recomputations against ADR-0012 and ADR-0013, and `17` §13.1's VERIFY says *"No number below may appear in user-facing material until it has been measured"* | X1 is built on those numbers, and X1 is the biggest section | Every X1 figure is order-of-magnitude context. The recomputation, plus ADR-0017's two-day WASM spike, plus `17` §13.1's three measurements, are ~2–3 solo weeks and should run alongside S2 |
| 3 | **S0's outcome is assumed to be the third row** and the schema work is scoped for a break that has not been measured | The third row is what I expect. Expecting is not measuring | S0's exit criterion is written before the evidence, per `73` §1.4, and the response differs per row |
| 4 | **The service layer (`77` §§2–5) is treated as out of scope because it is not costed here** | It is absent from §7's table | It is absent because S0 is what makes costing it possible, not because it is small. `77` §16 disagreement 3 stands: it may be the actual product |
| 5 | **The `62-schema-spec.md` estimate is taken at face value** | ADR-0008's own 2–3 weeks is for the schema as `11` describes it today | ADR-0008 says the rest itself: *"Writing it will reveal that `11` is incomplete."* `82` §15 already names four missing pieces for a chassis cluster alone. Treat 3–5 weeks as a floor |
| 6 | **This document is read as resolving the collisions.** It does not. §5 lists options and refuses to pick | §5 is the longest section and options read like recommendations | Every §5 entry names its contradiction at full strength and stops. Where this document recommends, the word **RECOMMENDATION** is present and the thing lost is named |

---

## 10. Open decisions

Everything in §8, plus:

- **Is the per-equipment page a mode of inventory, a seventh view, or the inspector grown up?**
  (`52` §9.5; `77` §14.) `52` §1.1's config/change-set precedent makes the cheap answer available
  and nobody has taken it.
- **Is "out of scope by policy" a third existence state** alongside `Absent` and `Unknown`?
  (`11` §8.5; `77` §4.) Internal and external estates behave differently under it, and it changes
  every completeness check.
- **Does `52` §12's D3 (inventory bulk edit, currently leaning defer) reopen?** A per-equipment page
  with editable port rows is bulk edit arriving through a different door.
- **Is the `Layout` record sharded?** `17` §4.2 gives it `Count: 1`, rewritten whole on every diagram
  edit, under ADR-0013's whole-record model. At estate scale that is megabytes of ciphertext re-sealed
  on every drag commit, with no git delta base. The argument that keeps `Suppressions` whole (the
  count is disclosive) does not obviously apply to positions.
- **Does the offline single file (D1) remain the flagship shape for an estate of this size?**
  `43` §2.1 already puts the CLI comfortably where `44` §6.2 marks the browser tab broken. If the
  answer is no, that is a positioning change and it should be an ADR rather than a discovery.
- **What binds continuous zoom?** `53` §3.4 binds only `z`; `56` depends on zoom thresholds
  throughout. An unowned interaction that R6 will trip over regardless of the wheel decision.
- **Is the naming scheme shareable between workspaces?** If yes it is corpus and invariant 10
  applies; if no it is settings and it does not. `77` §3.3 asks the identical question of
  user-defined service types. Answer it once, for both.

---

## 11. Sources consulted

| Claim | Source |
|---|---|
| The requirements as stated, verbatim, and the seven collisions this document re-ranks | `docs/70-ops/77-service-model-requirements.md` §§2–16 |
| `Interface` is a physical port; `Link` is an `Interface → Interface` edge with `media`, `length_m`, `label`, `provider_circuit`; direction normalised lexicographically; `Circuit` deferred by name | `docs/10-core/11-ir-schema.md` §6.4, §7.3, §7.4 |
| `Site.code` *"used in generated object names"*; `Site.address` free prose; `Device.platform` *"Not 'vendor'"*; `Device.role` enum; `Chassis.slots` for interface-name validation | `docs/10-core/11-ir-schema.md` §6.3 |
| ~1.1 MB resident per fully-parsed mid-size firewall; 200 devices ≈ 220 MB; the browser ceiling at 50–80 devices | `docs/10-core/11-ir-schema.md` §14.2 |
| L0 enforced at write time; containment forms a forest; the kind-earning test; free prose reserved for descriptions, notes and a site address | `docs/10-core/11-ir-schema.md` §9.1, §6.1, §4.1 |
| `matches(s, /re/)` — regex literal only, compiled at pack build; `via` chains at max depth 3 | `docs/10-core/12-rule-engine.md` §3.7, §4.2 |
| Per-platform Rust is a lexer table and a shaper; the dictionary is a content programme at 400–2,500 entries per platform | `docs/10-core/14-parsers-and-ingest.md` §15 |
| Corpus denominator (≈430 entries for one domain × one platform), the shared/platform-specific split, and the ~35 min/entry rate | `docs/10-core/15-explainer-corpus.md` §§12.2, 12.5, 12.6 |
| `RecordKind::Settings` and what is inside the ciphertext; the three-workspace size table; where the document model stops working; no in-workspace compartmentation; the `Index` escape hatch | `docs/10-core/17-workspace-format.md` §10.1, §13.2, §13.3, §13.4, §17 |
| `N-R-2` and its test and its `Reopens if: Never`; `N-D-2`; the NetBox/Nautobot importer in scope; the domain table | `docs/00-vision/03-non-goals-and-scope.md` §4.2, §4.13, §9.1, §6.2, §11 |
| *"Fathom should read NetBox, not replace it"* | `docs/00-vision/02-prior-art-and-positioning.md` §5.1 |
| The order of breakage; per-device lazy loading impossible under the decided format; population-rule cost | `docs/40-stack/44-performance-budgets.md` §7.1, §7.2, §4.8.6 |
| The not-invented-here ledger at ≈11,000–13,000 lines | `docs/40-stack/41-technology-choices.md` §9.2 |
| The inventory's purpose, primary object, generated column picker and opinions column; six views fit; the 14-fact scent budget; `verify(diff(graph))` is a mode, not a seventh view | `docs/50-design/52-information-architecture.md` §3.7, §3.7.1, §9.5, §9.6, §1.1 |
| No modes, and the arithmetic defence of that decision; the keymap ownership rule | `docs/50-design/53-interaction-and-keyboard.md` §2.1, §2.2; ADR-0024 |
| The drag-from-port-to-port row, the two-step-first pattern, and pan's exemption on the scroll gesture | `docs/50-design/55-accessibility.md` §5.5 |
| The connect disclosure and its one-op-one-undo contract; view-local state is the transform and the layer mask; the Outline-row gate on new decorations; the edge vocabulary | `docs/50-design/56-diagram-view.md` §6.4.1, §0, §7, §5.4 |
| The legibility ceiling finding, and aggregation as a transform on the model | `docs/50-design/59-diagram-aggregation-and-colour.md` §2.1, §3 |
| Phase totals, ordering principles, the risk register, `fathom-graph` at 5–7 weeks, phase 4 at 6–10, the dictionary track, D1's scarcity, open decision 7 | `docs/70-ops/71-roadmap.md` §§1.2, 1.4, 2, 4.7, 5.7, 7.5, 15.1, 16 |
| Corpus rot at ~0.8 person-weeks/year/platform-domain; the vendor-neutrality narrowing | `docs/70-ops/72-risks.md` risk 1, §3.5 |
| `62-schema-spec.md` blocks every field-shaped entry; the CMDB observation | `docs/70-ops/75-capability-register.md` §12, §16 disagreement 6 |
| What makes someone an expert reviewer | `docs/70-ops/74-governance-and-licensing.md` §9.4 |
| v1 is the finder; the diagram cut to an SVG export; the corpus column missing from the headline | `docs/90-decisions/adr-0006-v1-is-the-finder-and-the-product-is-phases-0-to-3.md` |
| The schema is a specified artifact; *"A field that exists in prose and not in `schema.yaml` does not exist"*; two to three weeks plus codegen; absent from the phase table | `docs/90-decisions/adr-0008-the-schema-is-a-specified-artifact.md` |
| `S` fixed at workspace creation; device-sharding rejected on metadata grounds | `docs/90-decisions/adr-0013-record-granularity-frames-and-the-manifest.md` |
| Two physical boxes; the verification stamp as required chrome | `docs/90-decisions/adr-0027-hardware-verification-and-the-verification-stamp.md` |
| Rule packs first-party only in v1 | `docs/90-decisions/adr-0028-corpus-authorship-and-contribution.md` |
| The read-only ingest spike, its exit criterion, and the absence of PAN-OS hardware | `docs/90-decisions/adr-0030-pan-os-is-the-second-platform.md` |
| Corpus entry counts (98 commands / 37 rules / 42 explainers; 21 wildcard explainers), and the absence of any access-domain vocabulary | Measured directly against `corpus/` and `docs/` for this document |

---

## 12. Disagreements

**1. The scope now described is several years of work for one person, and the number should be said
out loud rather than implied.**

`71` §2's own total is **106–158 solo weeks to phase 7** for the product as specified, with the
warning that *"the corpus does not finish at the end of it."* This document adds, on top of that:
a schema spec nobody scheduled (3–5 weeks); a second domain's corpus (25–35 person-weeks of the one
resource `71` §15.1 says cannot be substituted); an access platform's parser and dictionary
(14–20 weeks plus 12–18 weeks of domain time); a naming subsystem (5–9 weeks); an address model; a
diagram; and a storage-layer question that reopens two ADRs and every budget in `44` §7. Solo, with
no code written, that is not a year. It is closer to four, and the corpus keeps running afterwards.

That is not an argument against building it. It is an argument for `71` §2's own honest shortening:
*"The one honest shortening available is **stopping**."* Slices S0 through S4 are a coherent product
— a graph, an inventory, a per-equipment page and navigable cabling for an access estate — that can
be shipped and left alone. So are S0 through S5. The plan should name those exits before it starts,
because a plan without exits gets one anyway, chosen under pressure, in month eighteen.

**2. The product would be better served by choosing between "teaching tool" and "source of truth"
than by being both — and I think the evidence points at source of truth.**

I will argue this properly rather than gesture at it, because it is the most consequential thing in
this document.

The teaching claim is expensive and it is expensive in exactly one currency: authored content. `15`
§12.2 puts a single domain × platform at ~430 entries and ~2,100 pieces of writing. `15` §12.6 puts
that at 6–7 person-weeks and marks every rate a planning assumption. `72` risk 1 puts one
platform-domain at ~1,110 authored items, 12–15 person-weeks, and ~0.8 person-weeks per year of rot
that never stops. `71` §1.4 rates R-CORPUS **Fatal**. `71` §15.1 says D1 cannot be substituted by
engineering. And `15` §13's own opening is the honest version: *"The most likely cause of this
project failing is not a bug in the rule engine. It is that in eighteen months the corpus describes
Junos 21 and the user is running Junos 24."*

The source-of-truth claim is expensive in engineering, which is the currency the owner actually has.
Ports, cables, addresses, naming and a canvas are code and schema. They are hard, they are large,
and they are not gated on anyone's willingness to write 2,100 pieces of prose in a consistent voice
about a domain that changes underneath them.

Three further asymmetries:

- **The teaching content does not transfer to the new domain and the engineering does.** §6.2
  measures it: 0 of 177 authored entries carry over; the formats, gates, linter, metrics and
  pipeline all do. The teaching pillar is the part that has to be rebuilt from zero for an access
  estate; the machinery is the part that survives.
- **The teaching pillar's verification story has no hardware and the estate pillar's does.**
  ADR-0027 requires two physical boxes and a named public reviewer; ADR-0030 records that this is
  unsolved for the platform the project chose. For an access estate, the owner has the boxes and is
  the reviewer. That inverts which pillar is credible.
- **`52` §3.7's differentiator survives the fork.** *"The inventory has opinions"* is not a property
  of teaching content; it is a property of the rule engine running over a populated graph. A
  source-of-truth Fathom keeps it. That is the one genuinely defensible thing NetBox does not do,
  and it does not require the explainer corpus at all.

What choosing costs, stated rather than buried: the three-depth explainer model, the concept graph,
the resolution ladder and the field-card voice are the best-specified work in this repository and
some of it would go unbuilt. `01`'s thesis is a teaching thesis. Choosing the estate means rewriting
the vision document, not just the scope document.

But **being both is the option with no exit.** It means paying the corpus bill and the DCIM bill on
one person's calendar, and `71` §2 already says what happens: *"Any plan that reports a smaller
number has either cut the corpus, cut the second platform, or cut the security posture."* Being both
is the plan that cuts one of those without noticing which.

**RECOMMENDATION — choose, in writing, at Q3 and Q10, before S2 begins.** If the answer is source of
truth, then `03` §4.2 is amended, `01` is rewritten, the explainer corpus is scoped to what a
populated estate needs rather than to a teaching denominator, and the product's differentiator is
stated as *an estate record whose rows argue back* — which is a sentence NetBox cannot say and which
costs a fraction of what the teaching pillar costs.

**3. `77` §11's `C7` was wrong and it would have cost real money.**

`C7` claims the IR models logical interfaces rather than front-panel ports and that *"everything in
§5 and §8 depends on this landing first"*. `11` §6.4 heads a kind **`Interface` — a physical port**
and `11` §7.3 gives the cable its own typed edge. Had `C7` stood, the plan would have opened with a
physical-port modelling exercise that is already specified, and R1 and R2 — the two cheapest and
most immediately visible things the owner asked for — would have been sequenced behind imaginary
work. Two of `77`'s other three diagram claims (`C6` and the "multiple modes needs testing"
framing) are similarly unfounded or understated. This is not a criticism of `77`, which is explicit
about being a fast capture. It is an argument that **the next document should not be a capture**.
The corpus is now large enough that claims about it need to be checked against it, and three of the
four claims I checked in this area did not hold.

**4. The recomputation `17` §13 has been waiting for should be scheduled now, not "when needed".**

`17` §13.1 and `44` §4.8.5 both carry pending recomputations against ADR-0012 and ADR-0013.
ADR-0017's two-day WASM spike is still pending. `17` §13.1's VERIFY names three measurements that
have never been taken. All of it is cheap — call it 2–3 solo weeks including the WASM spike — and
**X1, the largest collision in this document, is currently being argued on arithmetic rather than
evidence.** The owner is being asked to choose between one workspace and a thousand on the basis of
figures the corpus itself says may not be quoted. That is the wrong basis for a decision with
reversal cost R3.
