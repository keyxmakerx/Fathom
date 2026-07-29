# 77 — The service model: requirements as stated

> **Status:** Proposed · a capture, not a specification. Records what the owner asked for and
> what it collides with. Decides nothing.

Companion documents: `docs/70-ops/75-capability-register.md` (the register this feeds; entries
here are candidates for it), `docs/70-ops/76-scope-expansion-analysis.md` (the architectural
analysis of these requirements), `docs/70-ops/71-roadmap.md` (the sequence these requirements
disturb), `docs/10-core/11-ir-schema.md` (the graph they would have to live in),
`docs/50-design/52-information-architecture.md` §3.7 (the inventory view they land on),
`docs/50-design/56-diagram-view.md` (the picture they would be drawn in), `.context/conventions.md`
(the invariants they are tested against).

---

## 0. Contents

| § | |
|---|---|
| 1 | What this document is, and the line it does not cross |
| 2 | The unit of the model — estate, tenant, CID |
| 3 | Services, and the types named |
| 4 | Internal versus external, and where modelling stops |
| 5 | Path, elision, and the warp |
| 6 | Equipment, ports and the per-equipment page |
| 7 | Naming, addresses, and the increment |
| 8 | The visualiser |
| 9 | Engines — the question asked, and the answer the corpus already gives |
| 10 | Source of truth — the answer given, and what it costs |
| 11 | What collides with a decided position |
| 12 | What must be decided before any of this is built |
| 13 | Failure modes of this capture |
| 14 | Open decisions |
| 15 | Sources consulted |
| 16 | Disagreements |

---

## 1. What this document is, and the line it does not cross

*margin tab: recorded, not decided*

> **THIS RECORDS. IT DOES NOT DESIGN, DECIDE OR SCHEDULE**

The owner supplied a large body of requirements in conversation and asked, in terms, that it be
written down: *"PLEASE make sure all this gets documented in the upcoming PR please! It was alot
of info lol."* This is that record.

It follows the discipline `75` sets for itself. Where the owner stated something, it is quoted or
reproduced faithfully. Where a requirement implies a decision, the decision is **named and left
open**. Where a requirement collides with something already decided, the collision is stated at
full strength and **not resolved** — the owner reopens decisions, this document does not.

Terms are the owner's. Where a term has a standard industry meaning that the owner did not state,
it is marked `<!-- VERIFY -->` rather than assumed, because a wrong expansion here would propagate
into a schema.

---

## 2. The unit of the model — estate, tenant, CID

### 2.1 What was said

> *"I think an Estate or Tenant with the CID connected to it, though internal networks don't have
> CIDs so, does that make sense?"*

And on size:

> *"we can have huge diagrams but small tiny things as well, especially since internally it could
> be dozens of virtual interlinks, which we should account for, yet a calix DIA for a customer
> would have like 5 pieces of equipment in a single line."*

### 2.2 What it implies

The organising unit is **not** "a network". It is a **tenant** owning **services**, where a
service is identified by a **CID** (circuit identifier) and rides on **shared physical
infrastructure**.

That is a three-layer model, and the corpus currently has one layer:

| Layer | Holds | In the IR today? |
|---|---|---|
| **Tenant / customer** | Who a service belongs to | No |
| **Service** | CID, type, endpoints, state | No |
| **Physical** | Equipment, ports, cables, sites | Partially — logical interfaces, not physical ports (`76`) |

**The size range is a requirement, not a footnote.** A five-element DIA in a straight line and an
internal core with dozens of virtual interlinks are both first-class, and they are three orders of
magnitude apart. Any layout, storage or rendering decision that is tuned for one will be wrong for
the other, and the diagram study's aggregation rule (`59` §3) already exists precisely because a
picture that is correct at five is a texture at forty.

### 2.3 What is not yet answered

- Is a tenant a container (services live inside it) or a label (services reference it)? These
  differ in how sharing works when one physical device carries services for many tenants — which
  is the normal case, not the exception.
- Does a workspace hold one tenant, many tenants, or one estate across all tenants? ADR-0012 is
  titled *"one workspace container"*; none of these three readings is obviously what it decided.
- Internal infrastructure has no CID. What identifies it, and is "has no CID" a distinct
  modelled state or simply an absent field? The two behave differently under a lint.

---

## 3. Services, and the types named

### 3.1 The types the owner named

> *"we have multiple types of services, Point to Point ELINEs, ELANs where it is multi points with
> each location having a Unique CID called UNI ids, we also have voices"*

and later:

> *"We also have things like LTE for instance, and the editor should be able to account for all
> these."*

| Type as named | Shape | Identifier |
|---|---|---|
| **DIA** | Single customer site to the provider network | CID |
| **E-Line** | Point to point, two endpoints | CID |
| **E-LAN** | Multipoint, many locations | CID for the service, **a UNI ID per location** |
| **Voice** | Not further described | `<!-- VERIFY: shape and endpoints unstated -->` |
| **LTE** | Named as an example of "all these" | `<!-- VERIFY: shape unstated; may be a backup/failover access method rather than a service type -->` |

**The E-LAN identifier structure is the load-bearing detail.** One service, many locations, each
location separately identified. That makes a service's endpoint set a first-class collection with
its own identity per member — not a pair of foreign keys. A model that assumes two endpoints will
not extend to E-LAN by adding a third.

### 3.2 The builder — answered

Asked whether service types should be built in, user-defined, or both, the owner answered:

> *"Build many in, but defining my own types is a must."*

So: **a shipped catalogue of types, plus user-defined types, plus an editor for both.** The stated
motivation is repeatability — *"This would allow it to be easier to do again, while also kinda
being a click and go."*

This is the single most consequential requirement in this document, because a user-definable
service type is a **user-definable schema**, and ADR-0008 holds that *"a field that exists in prose
and not in `schema.yaml` does not exist."* Either user-defined types are constrained to a fixed
metamodel, or the product acquires a runtime schema — see §11.

### 3.3 What is not yet answered

- What does a type definition contain? Endpoints and their cardinality, required fields, permitted
  equipment kinds, naming rules, a diagram treatment — each is a separate decision.
- Are user-defined types shareable between workspaces, or private to one?
- Voice and LTE need their shapes stated before either can be modelled.

---

## 4. Internal versus external, and where modelling stops

> *"for external customers aka outside the internal network, like a enterprise DIA, we would
> probably only go back to a primary network router and then stop."*

Two consequences worth recording, because both are unusual and both are correct:

1. **Modelling has a deliberate horizon.** The customer's own equipment beyond the demarcation is
   explicitly out of scope. That is a modelled fact — "this is where we stop" — not missing data,
   and it must render as such or every completeness check will report a false gap forever.
2. **Internal and external estates behave differently.** Internal has no CID and full depth;
   external has a CID and stops at the primary router. A single completeness rule cannot serve
   both, so the distinction is structural rather than cosmetic.

This pairs with the existing `Absent` / `Unknown` distinction in `11` §8.5 — the corpus already
knows the difference between "we looked and it is not there" and "we did not look". "Out of scope
by policy" is a third state and it does not exist yet.

---

## 5. Path, elision, and the warp

### 5.1 What was asked for, in full

> *"Basic full path, we have layer 2 P2Ps between our internal equipment so we can essentially
> warp the traffic to account for that, though the diagram should reference that we are ommitting
> equipment. If the model accounts for that with the other equipment, it probably should natively
> include that if you click the L2/warp whatever you decide icon. Like for instance Hub A to Hub C,
> however later we include Hub B which interlinks those together. Then the original CID which still
> had the warp/L2P2P connection if you click it would now include Hub B and it's interlinks and
> hookups. Otherwise it'll give a basic, out of scope error."*

### 5.2 What it describes

A service path is recorded at **whatever depth the model currently supports**, with an explicit
abstraction edge — a **warp** — standing in for a layer-2 point-to-point whose intermediate
equipment is either not modelled or not worth drawing.

The behaviour is **lazy resolution**:

| State of the model | What the warp does when activated |
|---|---|
| Intermediate equipment **is** modelled | Expands to show it — Hub B, its interlinks, its hookups |
| Intermediate equipment **is not** modelled | Reports out of scope, plainly, and stays collapsed |

And critically: **a path recorded before Hub B existed gains Hub B automatically once Hub B is
modelled.** The path stores the abstraction, not a frozen list of hops. That is what makes it
maintainable, and it is the difference between this and every hand-maintained circuit record that
goes stale the day the network changes.

### 5.3 Why this is cheaper than it sounds

**It is the aggregation rule already decided in `59` §3, applied to a different axis.** That
decision collapses more than six like-kind siblings into one affordance that states what it hides
and how many, expands on activation, and never drops anything silently. The warp is the same
shape: a collapsed representation, an honest statement of what is behind it, expansion when the
data exists, and an explicit refusal when it does not.

`59` §3.1 also settled that aggregation is *"a transform on the model, run before layout"* rather
than a special case inside the renderer — which is exactly where warp resolution would have to
happen.

> **RECOMMENDATION — treat the warp as an instance of the aggregation transform rather than as a
> new mechanism.** One transform with two triggers is a smaller product than two transforms, and
> the honesty properties are already argued and already verified.

### 5.4 What is not yet answered

- Is the warp a **modelled edge** (an L2 P2P object that exists in its own right, which the owner's
  wording suggests) or a **rendering of an unresolved path segment**? The first is data, the second
  is a view state, and `52` §1's view/state boundary makes that a real distinction.
- What happens when the expansion is **ambiguous** — two possible paths between Hub A and Hub C?
  Silence is not an option; the corpus's habit would be to show both and say so.
- Does the "out of scope error" distinguish *not modelled yet* from *deliberately out of scope*
  (§4)? They look identical to a user and mean opposite things.

---

## 6. Equipment, ports and the per-equipment page

> *"we should probably have a perr equipment page with all the info and ports, kinda like netbox
> but netbox is way to granular, whereas this be everything for that equipment as needed, you can
> click on a port which goes to other equipment."*

Three requirements:

1. **A per-equipment page** carrying everything about one device — the owner's qualifier is
   *"as needed"*, explicitly less granular than NetBox.
2. **Ports are modelled objects**, listed on that page.
3. **A port is navigable** — clicking it travels to the equipment at the far end, which requires a
   cable or link to be a first-class edge between two ports.

`52` §3.7 currently positions the inventory *against* NetBox — its stated distinction is that
*"the inventory has opinions"* — so "like NetBox but less granular" is a change of position, not an
extension of one. Whether the per-equipment page is a seventh view is a live question: `52` §9.5
warns that six views fit and *"if a seventh is ever added, this design has a real problem."*

---

## 7. Naming, addresses, and the increment

> *"Do we have a way to validate equipment name? like that should be customizable, like external
> would be {ST}{CLLI}{TYPE}{Incremental} or something, where type is the brand, like calix, nokia,
> etc. With incremental should be a number but could also be a letter (because we did letter if
> there is multiple per address) which addresses will be important as well."*

| Component | Meaning as stated | Note |
|---|---|---|
| `{ST}` | `<!-- VERIFY: state, or site type. Unstated. -->` | |
| `{CLLI}` | The telco location code | Ties naming to **address**, not to topology |
| `{TYPE}` | The brand — Calix, Nokia | A vendor enumeration the product would have to hold |
| `{Incremental}` | A number, **or a letter** | Letters used *"if there is multiple per address"* |

Three things follow.

**The scheme is per-operator, not per-corpus.** A rule pack is shared, versioned content
(`63`); a naming convention is private policy. The product has no home for per-workspace private
policy today — see §11.

**The increment is derived, not arbitrary.** A letter means *"there is more than one of these at
this address"*. That is a fact about the address relation, which the model would already know. A
naming validator that merely pattern-matches would accept `...A` where no second unit exists and
reject a correct `...B`. The honest form checks the name **against the graph**, not against a
regular expression.

**Addresses become structural.** They are not a `Text` field on a site — CLLI participates in the
name, and "multiple per address" is a relation the validator depends on. Note that any temptation
to geocode is closed: invariant 1 forbids the network call outright.

---

## 8. The visualiser

> *"the visualizer needs to be essentially as easy as jira is btw. With multiple modes too, like
> one mode i can see is like clicking to drag one piece of equipment, then using the mouse wheel
> to select the port, going to another equipment, and mouse wheel that equipment to get the port
> of that as well."*

The named mode is a **cabling gesture**: drag equipment, wheel to choose its port, move to the
second equipment, wheel to choose its port — and the two are cabled.

Recorded observations, not objections:

- This is an **editor**, and `52` §1 classes the diagram as a view — `render(graph)` — with the
  walkthrough as *"the only controller in the product"*. Editing the graph *through* a view is not
  necessarily the same as the view holding state, and `76` examines where the line falls.
- **`53` and `55` require keyboard operation of everything.** A wheel-driven port picker has no
  stated keyboard analogue. The gesture can stay; it needs a twin.
- **The wheel may already be allocated to zoom** in `56` §6. If so, the cabling mode either takes a
  modifier or the mode owns the wheel while active.
- "Multiple modes" needs testing against `53`/ADR-0024's position on modes.
- **"As easy as Jira" is the actual bar** and it is a usability target, not a feature. It should be
  written as an acceptance criterion someone can fail, not as an adjective.

---

## 9. Engines — the question asked, and the answer the corpus already gives

> *"Shouldn't these be Engine based? wasn't that the goal, that there would be engines for each
> device type, so that we would have some modularity and upgradability?"*

The instinct is right and the corpus already delivers it — at a **smaller unit than an engine**:

| Layer | Per platform? | Where |
|---|---|---|
| Command entries, rules, explainers | **Data**, carrying `platforms` and `versions` predicates | `61`, `63`, `15` |
| Lexer token table and shaper | **Code**, ~200–600 lines each | `14` §—: *"The only per-platform Rust is the lexer table and the shaper"* |
| Emitter | **Code** — a `Platform` trait impl plus a template per kind | `13` §— (`pub trait Platform`, `pub trait KindEmitter`) |
| Rule engine, finder, diff, IR, render layer | **Shared, one copy** | invariant 5 |

Invariant 5 states it as a prohibition: *"Findings are data, not code. One rule engine. Rules carry
`platforms` and `versions` predicates. **No per-vendor engines.**"*

So adding Calix is a lexer table, a shaper, an emitter implementation — and then all remaining
content is data that a domain expert can author without touching Rust. That is the modularity and
upgradability asked for. The one correction: rules deliberately are **not** per-vendor engines,
because vendor logic in code cannot be reviewed, versioned or contributed the way a rule pack can.

---

## 10. Source of truth — the answer given, and what it costs

Asked directly whether Fathom becomes the system of record for the estate, the owner answered:
**"Yes — it's where the estate lives."**

That is a decision with consequences that belong on the record now rather than later:

| | |
|---|---|
| **Staleness becomes a defect, not a gap** | A modelling tool that is out of date is merely unhelpful. A source of truth that is out of date is **wrong**, and people act on it. The product needs a visible answer to "how current is this", and it cannot poll for one — invariant 2 is permanent |
| **The threat model changes** | An authoritative estate record is a higher-value target than a design sketch. `31` was written for the latter |
| **Loss becomes severe** | Losing a design costs an afternoon. Losing the system of record costs the estate. Backup, export and recovery move from convenience to requirement |
| **`52` §3.7 must be rewritten** | It currently positions the inventory *against* NetBox rather than as a replacement |

---

## 11. What collides with a decided position

Ranked by how expensive each is to discover late. None is resolved here.

| # | Requirement | Collides with | Why it matters |
|---|---|---|---|
| **C1** | User-defined service types (§3.2) | ADR-0008 — *"a field that exists in prose and not in `schema.yaml` does not exist"*, and `62-schema-spec.md` does not exist yet | Either user types are constrained to a fixed metamodel, or the product needs a runtime schema. That is a different product |
| **C2** | Source of truth (§10) | `52` §3.7 positions the inventory against NetBox; `31`'s threat model assumes design data | Changes what "wrong" costs, permanently |
| **C3** | Tenant / service / physical layering (§2) | The IR has one layer; ADR-0012 *"one workspace container"* | Decides the storage and crypto model. Hardest to change later |
| **C4** | A diagram that edits (§8) | `52` §1 (the diagram is a view); `71` R-VIEW names view-becomes-state as *"brief §4.1's forbidden outcome"* | Cheap if editing writes through to the graph; corrupting if the picture starts holding truth |
| **C5** | Naming validated against the graph (§7) | No home exists for per-workspace private policy; `63` rule packs are shared content | A small requirement that reveals a missing concept |
| **C6** | Wheel-driven cabling (§8) | `53`/`55` keyboard obligations; `56` §6 may already own the wheel | Needs a keyboard twin before it ships, not after |
| **C7** | Physical ports and cables (§6) | The IR models logical interfaces, not front-panel ports | Everything in §5 and §8 depends on this landing first |

---

## 12. What must be decided before any of this is built

Short, and only the owner can answer them.

1. **Is a workspace one tenant, many tenants, or one estate across all tenants?** (C3)
2. **What may a user-defined service type contain?** Fixed metamodel, or open schema? (C1)
3. **What are voice and LTE, structurally?** Neither shape was stated.
4. **Is the warp a modelled object or a rendering?** (§5.4)
5. **Does `62-schema-spec.md` get written first?** ADR-0008 makes it a prerequisite for every new
   field named in this document, and it is absent from `71`'s phase table.

---

## 13. Failure modes of this capture

- **It reads as a plan.** It is not one. Every table here is a statement of what was asked for and
  what it hits, and `76` is where sequencing is argued.
- **The `<!-- VERIFY -->` markers get silently resolved by a later reader guessing.** `{ST}`, voice
  and LTE are genuinely unstated and a confident expansion of any of them would propagate into a
  schema and be expensive to unpick.
- **The industry vocabulary lulls everyone into assuming a standard model.** E-Line and E-LAN have
  formal definitions the owner did not invoke; this document records the owner's usage, and where
  the two differ the owner's wins.

---

## 14. Open decisions

Everything in §12, plus:

- Whether the per-equipment page is a seventh view, a mode of inventory, or the inspector grown up
  (`52` §9.5 makes the first expensive).
- Whether tenants are containers or labels (§2.3).
- Whether "out of scope by policy" is a third existence state alongside `Absent` and `Unknown`
  (§4).
- Whether user-defined service types are shareable between workspaces (§3.3).

---

## 15. Sources consulted

- The owner, in conversation, across four exchanges. Quotations in §§2, 3, 4, 5, 6, 7, 8, 9 are
  verbatim, including their original spelling.
- `.context/conventions.md` — invariants 1, 2, 5.
- `docs/10-core/11-ir-schema.md` §8.5 (`Absent` versus `Unknown`), §6 (kinds).
- `docs/10-core/13-emitters-and-provenance.md` — `pub trait Platform`, `pub trait KindEmitter`.
- `docs/10-core/14-parsers-and-ingest.md` — per-platform lexer table and shaper, 200–600 lines.
- `docs/50-design/52-information-architecture.md` §1, §3.7, §9.5.
- `docs/50-design/56-diagram-view.md` §6.
- `docs/50-design/59-diagram-aggregation-and-colour.md` §3 — the aggregation transform §5.3 reuses.
- `docs/70-ops/71-roadmap.md` §1.4 (R-VIEW).
- `docs/90-decisions/adr-0008-the-schema-is-a-specified-artifact.md`,
  `adr-0012-one-workspace-container.md`, `adr-0024-53-owns-the-keymap.md`.

---

## 16. Disagreements

**1. The scope described is a different product from the one specified, and it should be named as
such.** The corpus specifies a teaching and modelling tool for network configuration, with a
command finder as v1. What §§2–8 describe is a service-provider inventory and service-design system
with a teaching layer — closer to a NetBox with opinions and a config tutor attached. Both are
coherent products. They are not the same product, and the difference is measured in years rather
than weeks. The owner has said clearly that prior work must not constrain future quality, which
settles whether the change is allowed; it does not settle whether it is wise, and nobody has argued
that part yet.

**2. Source of truth and never connecting to anything are in tension, and the tension is
permanent.** Every other system of record reconciles itself against reality automatically. Fathom
cannot — invariant 2 is a product boundary, not a phase. So the estate is only as current as the
last person who typed into it, and the honest version of this product must make that visible
continuously rather than mention it once in documentation. This is not an argument against the
decision. It is an argument that the decision has a design obligation attached, and it is not yet
written down anywhere.

**3. The service layer is a bigger addition than the diagram work that prompted it.** Tenants,
services, CIDs, UNIs, paths and user-defined types are a second modelling domain sitting on top of
the configuration graph. It is plausible that it, rather than the diagram, is the actual product —
and if so, the roadmap is not merely disturbed, it is superseded. `76` should say so if the
analysis bears it out.

**4. `62-schema-spec.md` is now blocking three separate requirement clusters and still is not
scheduled.** It was already a prerequisite for lifecycle state (`75`). It is now also a prerequisite
for service types, for ports, and for naming policy. A document that four workstreams wait on
should not be absent from the phase table.
