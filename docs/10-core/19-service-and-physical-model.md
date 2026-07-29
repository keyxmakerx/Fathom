# 19 — The service and physical model

> **Status:** Proposed — **blocked on four preconditions in §13.1**, three of which are edits this
> document requires in `11` and one of which is an ADR that does not exist. None is a matter of taste
> and none can be enacted here.

This document extends `11-ir-schema.md`. It does not replace it, does not re-decide anything `11`
decided, and does not touch a single existing field. It adds two layers to the one graph `11`
specifies: a **physical layer** — front-panel ports, cables, street addresses, passive plant — and a
**service layer** — tenants, services, CIDs, endpoints, paths and the warp. Everything below is
written against `11`'s own mechanisms, and where a mechanism did not exist I have said so and named
what `62-schema-spec.md` must add.

`77` captured the requirements and decided nothing. `76` priced them and resolved nothing. This
document decides. Where a choice is engineering judgement I have made it and given the reason in a
sentence. Where a choice depends on how the owner works, what they will maintain, or what they are
willing to enter by hand, it is a **fork** in §10 with a recommendation. There are four forks and
roughly sixty decisions, and that ratio is deliberate.

Companion documents: `docs/10-core/11-ir-schema.md` (the graph this extends — read it first),
`docs/70-ops/77-service-model-requirements.md` (the brief), `docs/70-ops/76-scope-expansion-analysis.md`
(the analysis and the build order), `docs/60-content/62-schema-spec.md` (the file this document's
declarations must land in; it does not exist yet, and ADR-0008 makes it the gate),
`docs/30-security/33-sync-protocol.md` §6.4 (the merge classes §9.4 extends),
`docs/10-core/17-workspace-format.md` §4.2 (the record taxonomy §8.1 adds to),
`docs/50-design/59-diagram-aggregation-and-colour.md` §3 (the transform §6.8 gains a second producer
for), `docs/50-design/56-diagram-view.md` §4.1 (the projection table §3.10 extends),
`.context/conventions.md` (invariants 1, 2, 3, 5, 7, 9 and 10, all of which bind here).

---

## 0. Contents

| § | |
|---|---|
| 1 | What this adds, and what it does not touch |
| 2 | The layer model, and the same-graph decision |
| 3 | The physical layer |
| 4 | The service layer |
| 5 | The edge taxonomy |
| 6 | The path and the warp |
| 7 | The schema mechanism, and what `62` must contain |
| 8 | Naming policy, and where private per-workspace policy lives |
| 9 | Re-parse, merge and survival |
| 10 | What the owner must decide |
| 11 | Sizing |
| 12 | Failure modes |
| 13 | Open decisions, and the preconditions (§13.1) |
| 14 | Sources consulted |
| 15 | Disagreements |

---

## 1. What this adds, and what it does not touch

### 1.1 The additions

| | Count | |
|---|---|---|
| New node kinds | **10** | `PhysicalPort`, `Cable`, `Premises`, `PassiveNode`, `Tenant`, `Service`, `ServiceType`, `ServiceEndpoint`, `ServicePath`, `PathSegment` |
| New asserted edge kinds | **21** | §5.1 and §5.2 |
| New derived edge kinds | **2** | `WarpResolvesVia`, `CarriedBy` (§5.3). `Cabled` is **not** new: `11` §6.4 already declares `Cabled → Interface (0..1)` as the `Interface`-side name of `Link`, and §3.8 re-classes that existing name from asserted to derived |
| New semantic scalars | **5** | `Clli`, `PostalAddress`, `Date`, `LatLon`, `AttrValue` (§7.3) |
| New workspace record class | **1** | `Policy` `0x23` (§8.1) |
| New per-kind schema attribute | **1** | `layer` (§2.2) |
| Kinds amended | **2** | `Site` gains one out-edge (`AtPremises`); `Interface` gains one out-edge (`Occupies`). **Neither gains a field.** Earlier drafts of this table claimed two new `Interface` fields and never named them; that claim is withdrawn, because ADR-0008 property 1 makes a field that exists in prose and not in `schema.yaml` a field that does not exist, and this document may not commit the defect it cites `82` §15's `Device.aggregate_device_count` for |
| **Amendments this document requires in `11`** | **3** | `11` §10.4 step 1's scope filter and `11` §10.5's absence table (both §9.1), and `11` §8.7's staleness bands scoped to `layer == config` (§3.9). All three are edits to `11`, not declarations in `62`, and none is optional |
| Edge kinds superseded | **1** | `Link` (§3.8) |
| Existing fields removed or retyped | **0** | — |
| Containment relations restructured | **0** | — |

### 1.2 What is deliberately not here

| Not built | Why, and where it belongs |
|---|---|
| **A lifecycle enum** | `75` C-01 owns it and it is blocked on `03` §4.3 `N-R-3`, whose `Reopens if` cell reads **Never**. `Service` and `ServiceEndpoint` carry `in_service_on` and `ceased_on` as stored dates instead, which are facts about the estate rather than positions in a workflow, and which answer "is this live" as a computation. When C-01 lands, its enum attaches to these kinds as it does to every other, and nothing here has to move |
| **Ticket references** | `75` C-02a, same gate |
| **A `Rack`, rack unit, face or height** | §3.10. Adding `Chassis --MountedIn--> Rack` later is one kind plus one reference edge — a minor bump under `11` §11.3. Nothing in `77` traverses a rack |
| **Power topology** | §3.10. A disjoint second graph sharing no edge with a service path. Entirely additive later, and the loss is named |
| **Fibre strands, splices, closures** | §3.10, and refused in writing rather than deferred, so it is not re-litigated three entries at a time |
| **`Circuit`** | `11` §7.4 pre-designed it and declined to build it speculatively. §3.4 writes the promotion trigger down instead |
| **A service-wide VLAN or IPAM registry** | `11` already has `Address`, `Vlan` and `IpPrefix` scoped to devices. A cross-service registry guesses at a model nobody has stated |
| **`Tenant → Tenant` hierarchy** | `11` §7.4's rule against speculative modelling. A minor bump when a feature needs it |
| **Voice and LTE built-in service types** | `77` §3.1 marks both `<!-- VERIFY -->`. §10 F3 |
| **User-definable kinds, fields, scalars or edge kinds** | §7.1. This is refused permanently and the refusal is the load-bearing part of §7 |

### 1.3 What `11` decided that this document does not re-decide

Cited and built on, never re-argued: first-class typed edges and the three edge classes (`11` §3.4,
ADR-0007); the derived arena and its non-serialisation (`11` §3.5); the semantic-scalar rule and the
round-trip contract (`11` §4.1–4.2); four-state `Presence` and who may assert `Absent` (`11` §5.2,
§8.5); the kind-earning test (`11` §6.1); `from`/`to` as kind sets (`11` §7.1); the containment
forest (`11` §7.2); per-field provenance (`11` §8.1); the merge ladder (`11` §8.6); the L0–L3
validity levels (`11` §9.1); four-valued rule evaluation (`11` §9.3); the four inference constraints
(`11` §9.5); identity tuples and re-identification (`11` §10.3–10.4, ADR-0010); the bump table
(`11` §11.3); the extension bag and its eight rules (`11` §12.4).

---

## 2. The layer model, and the same-graph decision

*margin tab: settle this first*

> **ONE GRAPH. TWO NEW LAYERS. A LAYER IS A DECLARED ATTRIBUTE, NEVER A SEPARATE STORE.**

### 2.1 DECISION — one graph

The service and physical layers are node kinds and edge kinds in the graph ADR-0007 already decided.
They do not get their own store, their own index, their own provenance table, their own
re-identification algorithm, their own merge ladder or their own record class.

Four arguments, in the order they bite.

1. **Every load-bearing query is a join from one layer to another.** *"Which CIDs ride port
   `xe-0/0/3`?"* *"What breaks if SRX-A is decommissioned?"* *"Show every service whose path
   traverses Hub B."* In one graph each of those is a reverse-adjacency walk, priced by `11` §14.3
   at `O(1) + O(deg)`. Across two graphs each is a full scan or a hand-maintained cross-graph index,
   which is `11` §3.2's rejected shape B with no referential-integrity pass behind it.
2. **A second graph is a second everything.** Invariant 5 says one rule engine; a rule engine whose
   name environment spans two graphs *is* one graph with a partition in front of it. The same is
   true of `fex`'s read-set extraction (ADR-0009), of the L0 write-time check, of `fsck`, and of
   ADR-0013's record classes.
3. **The corpus has already built this shape once.** `Tunnel` (`11` §6.7) is a cross-device
   abstraction node, contained by the workspace root rather than by a `Site`, promoted from an edge
   because findings and the diagram overlay need to address it. `Service` is `Tunnel` generalised.
   `Site` and `ExternalPeer` are likewise never parsed and never emitted, and live in the graph
   without incident.
4. **The diagram is an edge-kind filter by construction** (ADR-0007's stated consequence). A
   service overlay is then a layer mask over an existing renderer, and `56` §4.1's projection table
   gains rows rather than a second model.

**The honest counter, and its answer.** Service and physical data is entirely `Origin::Hand` or
`Origin::Imported`, is never emitted, and no parser produces it — so a re-parse would be running
over nodes it can never match, and if it tombstoned them the one-graph decision would cost the
estate its most expensive facts on the first whole-device paste.

**The answer is a one-line amendment to `11` §10.4, not a property these kinds already have.** An
earlier draft of this section claimed the exclusion falls out of `11` §10.4 step 1's existing scope
filter, `config_path(kind(n)) ⊆ covered_paths(S)`, because the new kinds declare no `config_path`.
**That reasoning is inverted and the claim was false.** An empty `config_path` is the empty set, and
`∅ ⊆ covered_paths(S)` holds for *every* `S` — an empty config path does not exclude, it universally
admits. Nine of the ten new kinds escape anyway, but they escape on the filter's **first** conjunct,
`owner_device(n) = D`, because they are root-owned or premises-owned and have no owning device.
`PhysicalPort` does not: it is contained by `Chassis` (§5.1 `HasPort`), which `11` §7.2 contains by
`Device`, so `owner_device` resolves and both conjuncts pass. Every port on the pasted device would
enter `Gs`, match nothing in `P` (R-L2 forbids a parser creating one), fall through to step 6, and be
tombstoned under `CaptureScope::Whole`.

**So the mechanism is a positive test on `layer`, added to step 1**, and §9.1 states the amendment,
its second half (`11` §10.5's absence table has no `Origin::Imported` column and the catalogue
populates ports as `Imported`), and what `62` and `11` each have to carry. One schema property plus
one three-token edit to a published algorithm, not a second graph — but the edit is real, it is
`11`'s to accept, and this document does not get to assume it.

### 2.2 `layer` is a declared per-kind attribute

```yaml
- kind: PhysicalPort
  layer: physical          # config | physical | service
  emits: false
```

`layer` drives four things mechanically and nothing reads it ad hoc:

| Consumer | Behaviour |
|---|---|
| Emit (`11` §9.2) | A kind with `emits: false` is excluded from every emit unit on every platform, and from `13` §9.5's field-coverage report. Without this, forty estate fields are permanent false coverage holes |
| Re-identification (`11` §10.4) | `layer != config` is the **positive** out-of-scope test added to step 1 by §9.1's amendment. It does not fall out of the existing `config_path ⊆ covered_paths` clause, which admits an empty config path rather than excluding it |
| Diagram (`56` §4.1) | The layer mask is a filter over `layer` plus edge kind |
| Inventory (`52` §3.7) | The default kind list per mode |

`Site` stays `layer: config`, because `Site.timezone` carries Emit `O` and feeds NTP and logging
emit. `Premises` is `layer: physical`. All ten new kinds carry `emits: false`.

### 2.3 The two rules that keep the layers honest

> **R-L1 — a service-layer node may never be the containment owner of a physical- or config-layer
> node.** Containment stays the forest `11` §7.2 specifies, rooted at the workspace. Every
> service→physical and service→config relation is `class: reference`. Consequence: deleting a tenant
> deletes its services, endpoints, paths and segments, and touches no port, no cable and no device.
> That is the correct blast radius and it is enforced structurally rather than by care.

> **R-L2 — a parser may never create a `PhysicalPort`, a `Cable`, a `Premises`, a `PassiveNode`, or
> any service-layer node.** These come from a human, from an import, or from the hardware catalogue
> (§3.9). This one rule is what stops the hardware layer and the configuration layer re-fusing the
> first time somebody is in a hurry, and §3.1 explains why that fusion is the defect this whole
> layer exists to undo.

### 2.4 "Out of scope by policy" is not a fifth `Presence` state

`77` §4 requires *"this is where we stop"* to be a modelled fact, and `77` §14 and `76` §10 both
leave open whether it is a third existence state alongside `Absent` and `Unknown`.

**DECISION — it is not.** A fifth `Presence` variant taxes every rule author, every emitter author
and every UI author forever (`11` §16's own cost line) for a fact that applies to a handful of
elements, and it is not a property of any field's *value*. `11` §5.4 already set the precedent by
putting `Conflicted` one level up because it is a property of the field rather than of the value.
Out-of-scope is a property of a **relation** — of where a path deliberately ends and of who owns a
cable — so it lives on the relation. Concretely it is `SegmentKind::Boundary` on a path segment
(§6.3) and `Cable.ownership` on a cable (§3.4), and both are ordinary declared fields.

---

## 3. The physical layer

### 3.1 The premise `77` C7's withdrawal left standing, and why it is still half wrong

`77` §11 C7 claimed the IR models logical interfaces and not front-panel ports. `76` §1.2 withdrew
it, correctly: `11` §6.4 heads a kind **`Interface` — a physical port**, with `form`, `speed`,
`duplex`, `flow_control`; `11` §7.3 declares `Link | Interface | Interface | 0..1 | 0..1` for
physical cabling.

The withdrawal is right and it stopped one step short. **`Interface` is not a physical port. It is a
configuration object that usually describes one.** Four proofs, each of which independently breaks
something the owner asked for.

1. **Its extension includes things with no faceplate.** `form: {Ethernet, Serial, Loopback,
   Management, Irb}`, and `11` §6.1 reasons explicitly that a loopback *"does not earn a kind …
   so it is `Interface { form: Loopback }`"*. *"The ports of SRX-A"* over the `Interface` kind
   returns loopbacks and IRBs and must be filtered by a discriminant built for a different question.
2. **It has no physical location.** `Interface` is contained by `Device`, and a chassis-cluster
   `Device` has two `Chassis`. Which chassis is `ge-5/0/0` in? The only answer in the schema today is
   `MemberOfReth.chassis: NodeId` (`11` §7.3) — an **edge field**, so a port's chassis is recorded
   only when it happens to be a reth member. Physical location arrives incidentally, through a
   redundancy relation, or not at all.
3. **It has no census.** An `Interface` exists because a parser bound one or a user drew one.
   `Chassis.slots` is scoped by `11` §6.3 to *"FPC count, for interface-name validation"*. An OLT
   with 24 cages and 6 configured PON ports has six `Interface` nodes, and `77` §6's *"all the info
   and ports"* has nothing to enumerate.
4. **Its identity is a name, and a cable is not.** `Interface` identity is
   `[owner(Device), name.parsed]` then `[owner(Device), name.raw]` (`11` §10.3) — two tiers, both
   names. Swap a line card so `ge-0/0/0` becomes `xe-0/0/0`, re-parse, and under ADR-0010 no tier
   matches; the residue matcher declines or prompts. **Every cable on that device is orphaned by a
   configuration event.** The most expensive fact in the estate — the one that costs a truck roll to
   re-derive — is anchored to the cheapest and most volatile one.

Proof 4 is decisive on its own and it is decisive *because of* `77` §10. For a design tool, cabling
anchored to interface names is tolerable. For a system of record it is not.

**So the gap is real but it is not "there are no ports". It is that the configuration layer and the
hardware layer are fused into one kind, and they have different identities, different lifecycles and
different authors.** Everything below separates them. Nothing below deletes anything.

### 3.2 The governing principle

> **A PORT EXISTS BECAUSE HARDWARE EXISTS. AN INTERFACE EXISTS BECAUSE CONFIGURATION EXISTS.
> NEITHER MAY BE THE OTHER'S IDENTITY.**

Consequences taken as rules, not aspirations:

- R-L2 (§2.3): no parser creates a port.
- A `Cable` never references an `Interface`. It terminates on ports.
- No field in this layer asserts currency, status, or up/down. Invariant 2 forbids a device touch, so
  `11` §6.9's own rule applies verbatim: the tool has no honest way to hold runtime state. Occupancy
  is *derived* from the presence of a `Cable`. This is what makes the whole layer pass `03` §4.2
  `N-R-2`'s own written test — *"no field in the workspace format asserts currency or authority"* —
  which is `76` §3.3's argument.

> **The scope of that claim, because an earlier draft overstated it.** Passing `N-R-2`'s *written
> test* is not the same as being independent of `76` Q3, and the draft said the physical layer *"does
> not depend on `76` Q3 being answered route A"* as though the question were settled. It is not: §10
> F4 is an explicit fork, one of whose routes carries `Reopens if: Never`, and §15 Disagreement 4
> concedes that §6.10's header line *"is closer to route A than route B, and calling it route B is a
> convenience I should not be allowed to have unexamined."* What is true is narrower and worth having:
> **every field in §3 passes the test as written, so the physical layer does not *force* route A.** It
> does not follow that nothing here depends on the answer. Two things do — §3.9's provenance-age
> rendering, which is why that section declines `11` §8.7's bands rather than inheriting them, and
> §6.10's continuously-visible corroboration line, which §15 Disagreement 4 is about. **F4 is the fork
> under this document and it is answered nowhere in it.** Sixty decisions rest on one open question,
> and that ratio is stated here rather than discovered in §15.

### 3.3 `PhysicalPort`

A front-panel opening. Contained by whatever has a faceplate: a `Chassis` or a `PassiveNode`.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `label` | `Text` | 1 | — | The silkscreen: `1`, `PON 0/1`. **Not** the interface name |
| `position` | `PortPosition` | 0..1 | — | `{ slot: Option<u8>, subslot: Option<u8>, index: u16 }` |
| `connector` | `enum {Rj45, Sfp, SfpPlus, Sfp28, Qsfp, Qsfp28, Lc, Sc, Mpo, F, Bnc, Other}` | 0..1 | — | |
| `service` | `enum {Ethernet, Pon, Rf, Serial, Console, Management, Other}` | 0..1 | — | What the cage is for |
| `speed_max` | `Bandwidth` | 0..1 | — | The cage's ceiling. A **different fact** from `Interface.speed`, which is the configured rate |
| `transceiver` | `Transceiver` | 0..1 | — | `{ form_factor, kind, wavelength_nm: Option<u16>, serial: Option<Identifier> }` |
| `notes` | `Text` | 0..1 | — | |

```yaml
identity:
  - [ owner(PortHost), position ]    # tier 1 — a physical coordinate
  - [ owner(PortHost), label ]       # tier 2 — the silkscreen
```

**`PortHost` is a class, and it has to be**, because a tuple is usable on a node only when every term
is `Set` (`11` §10.3). Tuples written as `owner(Chassis)` are dead on every port a `PassiveNode`
owns — an ODF port, a splitter leg, a patch-panel hole — since `owner(Chassis)` is not `Set` there.
Both tiers would be unusable on exactly the ports §3.6 exists to introduce and `trace()` exists to
walk through, leaving them unaddressable by `fsck --repair` and unable to anchor a suppression. So:

> **`62` §5 declares `PortHost = { Chassis, PassiveNode }`**, following `11` §10.3's own
> `LogicalUnit → [ owner(InterfaceLike), index ]` precedent — a class in an identity tuple is
> established, not novel. It is the same kind set `HasPort` already takes (§5.1), named once.

**A `PassiveNode` port usually has no `position`, so tier 2 carries it.** An ODF has numbered
positions and behaves like a chassis; a splitter leg and a handhole termination normally have only a
silkscreen or a hand-written tag. That makes `[owner(PortHost), label]` the working tier for most
passive plant, and §9.5's *"stable"* verdict is qualified there accordingly: a tier-2 match is a
candidate needing confirmation (ADR-0010), and re-labelling a splitter leg costs a prompt.

**Earns a kind** on all three of `11` §6.1's limbs. Distinct required-field set: `position`,
`connector`, `transceiver` exist on nothing else. Distinct edge signature: contained by `Chassis` or
`PassiveNode`, endpoint of `Terminates`, target of `Occupies`. Distinct lifecycle, and this is the
one that settles it: **hardware exists without configuration; an `Interface` without configuration
is a contradiction.**

**`speed_max` versus `Interface.speed` is `11` §4.4's `Mtu` problem in a new costume:** two numbers
about the same link measuring different things. A 10G SFP+ sitting in a cage a 25G service needs is
a computable finding *because* they are separate fields. Conflated, it is undetectable.

**`transceiver` is where the four-state `Presence` earns its keep on day one.** `Absent` means we
looked and the cage is empty; `Unknown` means nobody looked. A catalogue-populated port is `Unknown`
and **may not be `Absent`** — `11` §8.5 permits `Absent` only from a closed-world parser or an
explicit human assertion, and a catalogue import is `Origin::Imported`. Somebody will want the
catalogue to say "empty". It may not.

**The rejected identity tier matters more than the accepted ones.** The tempting third tier is
`[edge(Occupies) → Interface.name]`, because it is the only tuple a parser could compute. Taking it
would make hardware identity depend on configuration, so a card swap would re-identify ports by their
new interface names and silently move every cable — which is precisely the failure ADR-0010 exists to
prevent (*"a wrong match silently rewrites the history of an object that is not the one you are
looking at"*). Both tiers are physical. Per ADR-0010 a tier-2 match produces a **candidate, not a
binding**.

### 3.4 `Cable`

A physical run between two termination points. **Promoted from `11` §7.3's `Link` edge to a node**,
which reverses `11` §17 open decision 3's stated lean of *"edge now"*.

`11` §7.4's justification for keeping `Link` an edge is one sentence: *"A `Link` has exactly two
endpoints, always."* In an access plant that premise is false three ways, and `76` X7 already flags
it as *"low today, high after data exists"* with the instruction to **decide before any cable data is
entered**.

1. **A planned cable has one end.** Fibre in the ground with the far end unlit is the normal state of
   a large fraction of an FTTx plant. An edge with one endpoint is unrepresentable; a node with one
   `Terminates` is ordinary partiality, which is `11` F1's entire premise.
2. **Breakout needs several cables at one port.** One QSFP cage, four lanes, four links. Under
   `0..1/0..1` that is illegal. The alternative is NetBox's cable-termination-position model, which
   is exactly the granularity `77` §6 rejects.
3. **A cable may terminate on something with no configuration.** An ODF port, a splitter leg, a
   handhole. `Link: Interface → Interface` cannot express it, and `76` X7 says so.

A fourth reason arrives on the lifecycle axis: **a cable outlives both its ends.** Under the edge
model, replacing a line card destroys the record of what was patched where.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `label` | `Text` | 0..1 | — | The tag on **this** cable. Unique among the cables it could be confused with, or absent. Identity tier 2 |
| `assembly` | `Text` | 0..1 | — | The grouping id **deliberately shared**: the assembly id across the four cables of a breakout, the bundle id across the strands of a multi-fibre run. **Excluded from identity** |
| `media` | `enum {Cat5e, Cat6, Cat6a, Twinax, Smf, Mmf, Coax, Power, Virtual, Other}` | 0..1 | — | Deliberately **no** `Unknown` variant — see below |
| `length_m` | `u32` | 0..1 | — | |
| `installed_on` | `Date` | 0..1 | — | Stored, rendered, never evaluated (`75` §4.4) |
| `ownership` | `enum {Ours, Provider, Customer}` | 0..1 | — | This is the field that carries the modelling horizon (§3.4.1) |
| `provider_circuit` | `Text` | 0..1 | — | Carried over from `Link`, with a promotion trigger written down |
| `notes` | `Text` | 0..1 | — | |

```yaml
identity:
  - [ edge(Terminates:A), edge(Terminates:B) ]   # tier 1 — the pair of ports IS the cable
  - [ label ]                                    # tier 2 — one-ended and planned cables
  # `assembly` is NOT an identity term. See below.
```

**`label` and `assembly` are split, and an earlier draft that conflated them made tier 2 ambiguous by
construction for exactly the cases it was added to serve.** That draft had one field carrying both the
per-cable tag *and* the breakout assembly id *and* the multi-fibre bundle id, while §3.10 instructed
the operator to *"record one `Cable` per lit strand and put the bundle ID in `label`"*. `11` §10.4
step 3 matches only *"if the bucket is unambiguous (exactly one candidate)"*, so twelve strands of
bundle `F-1204` sharing one `label` never match at tier 2 — and because tier 1 is unusable whenever an
end is missing, a **planned multi-fibre run had zero usable tiers**. Two fields cost one column and
fix it: `label` distinguishes, `assembly` groups, and grouping is a query
(`all cables where assembly == "F-1204"`) rather than a key.

**A one-ended cable with no `label` has no recovery key, and that is stated rather than papered
over.** Tier 1 needs both ends; tier 2 needs a tag somebody wrote. A planned run with neither is
identifiable only by its `NodeId`, which survives everything inside the workspace and nothing across a
re-import. The data-entry consequence is the honest one: **if you record a planned cable, label it.**
`62` §18 lints for a `Cable` with fewer than two `Terminates` and no `label`, at advisory level,
because refusing the write would make it impossible to record the ground before the tag is assigned.

`media` drops the `Unknown` variant that `Link.media` carried, because an enum variant that
duplicates a `Presence` state is exactly how `11` §5.2's `is_none` bug gets in through the type
system's back door.

`Terminates` carries `end: enum {A, B}`, normalised the way `11` §7.4 normalises `Link` direction:
**A is the endpoint with the lexicographically smaller `NodeId`.** That makes tier 1 an ordered,
deterministic tuple and satisfies invariant 9 for anything that iterates cables. Precedent for a
fielded side marker already exists at `TunnelEndpoint.side`.

Tier 2 is reached automatically for a one-ended cable, because `11` §10.3 makes a tuple unusable when
any term is not `Set`.

#### 3.4.1 The modelling horizon, without a new mechanism

`77` §4 says modelling stops at the customer's primary router and that the stop is a modelled fact.
On the physical layer that is `Cable.ownership` plus `11` §6.3's existing `ExternalPeer`:

| State | Meaning | Rule behaviour |
|---|---|---|
| Two `Terminates` | fully modelled | complete |
| One `Terminates`, `ownership: Set(Customer)` or `Set(Provider)` | **deliberately stops here** | complete, not a gap |
| One `Terminates`, `ownership: Set(Ours)` | a real gap | finding: model the far end |
| One `Terminates`, `ownership: Unknown` | nobody said | `Unevaluable` — correct |

`Terminates` takes `to: [PhysicalPort, ExternalPeer]`, so the horizon gets a modelled terminal object
with a label (*"Site B customer router"*). This is `11` §6.3's own argument one layer down —
`ExternalPeer` exists because *"a `Tunnel` with one modelled side is the normal case, not an error"* —
reused rather than reinvented.

#### 3.4.2 The `Circuit` promotion trigger, written now

`11` §7.4 pre-designed `Circuit` and declined to build it speculatively. The trigger, so it does not
drift: **when a service path must stop at a provider demarcation carrying the provider's own
identifier, `Circuit` becomes a node and `Cable --OverCircuit--> Circuit` is added.** Until then
`Cable.provider_circuit: Text` holds it. Writing the trigger down is the mitigation for the failure
mode where a leased cross-connect gets typed as a `Cable` and then queried as one.

### 3.5 `Premises`

A place with a street address. **Not called `Address`** — `11` §6.4's `Address` kind means an IP
address on a `LogicalUnit`, and `11` §4.3 already names conflating address types as *"the most common
modelling bug in this domain"*. `76` §4.5 names both hazards and both are respected: the noun is
taken, and enrichment is closed permanently. No geocoding, no map tiles, no postal lookup, no
autocomplete — invariant 1 forbids the call and `34` §9.4 forbids the clickable link. A user-typed
coordinate pair is a different thing and is storable.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `label` | `Text` | 1 | — | `Riverside CO`, `412 Oak St` |
| `street` | `PostalAddress` | 0..1 | — | A structured value type, **not** a `11` §4.2 `Scalar` — see below |
| `clli` | `Clli` | 0..1 | — | |
| `form` | `enum {CentralOffice, Hut, Cabinet, Headend, DataCentre, CustomerPremises, Pole, Handhole, Other}` | 0..1 | — | |
| `region` | `Identifier` | 0..1 | — | The `{ST}` candidate under one reading; §10 F2 |
| `coordinates` | `LatLon` | 0..1 | — | **User-typed only. Never looked up.** Stated explicitly so it is not re-litigated. **Fixed-point, never float:** `{ lat_e7: i32, lon_e7: i32 }`, degrees × 10⁷ (~1 cm), defined in `62` §3. `12` §3.4 excludes floats to buy determinism and `11` §14.1 chose canonical CBOR on the strength of *"no floats needed anywhere in this schema"*; a coordinate pair is the one field that would have falsified both, and it does not have to |
| `notes` | `Text` | 0..1 | — | |

```yaml
identity:
  - [ clli ]        # tier 1 — globally unique, machine-assigned
  - [ street ]      # tier 2 — via canonical()
  - [ label ]       # tier 3
```

**One kind serves both a central office and a customer location.** They differ in which edges point
at them and whether a CLLI is present, which `11` §6.1 makes a discriminant field rather than a kind.
That also gets the colocated-enterprise case right, which two kinds would make unsayable.

**Why this is a node and not a structured scalar on `Site`.** `77` §7 requires the naming validator to
know *"there is more than one of these at this address"*. As a field that is a population scan plus
structured-value equality — and `44` §7.1 row 2 already names population rules as the second thing
that breaks at scale, while address string equality is unreliable by construction (`St` versus
`Street`). As a node it is two reverse-adjacency hops:

```
siblings(d) := premises_of(d) <-AtPremises-- Site --HasDevice--> Device
```

`O(1) + O(deg)` each (`11` §14.3, guaranteed by ADR-0007's reverse index). And two sites at one
address are two edges to one node, so they **cannot disagree about the spelling**. That demotes
`canonical()` from a rule input to a deduplication hint at entry time — *"there is already a Premises
at this address, did you mean it?"* — which is a far weaker requirement and a far safer one.

**`PostalAddress` is a structured value type and not a `Scalar`.** `11` §4.2's trait exists so vendor
text round-trips through `N` emitters. A postal address has zero emitters, so `parse(text, plat)` and
`emit(plat)` are meaningless, and law L1 (`parse ∘ emit = id`) would become a claim about free-text
address parsing — a problem with no correct answer, sitting underneath the rule that decides
equipment names.

```rust
pub struct PostalAddress {
    pub lines:       SmallVec<[Text; 2]>,  // street lines, as entered, order significant
    pub locality:    Text,                 // city / town
    pub region:      Text,                 // state / province
    pub postal_code: Text,
    pub country:     CountryCode,          // ISO 3166-1 alpha-2, closed enum
}
// canonical(): uppercase, collapse whitespace, strip punctuation, join with 0x1F.
// Deterministic, no lookups, no libraries. It WILL produce false negatives
// ("ST" vs "STREET"). Acceptable, because it is a hint and not a rule input.
```

`Clli` is a validated newtype: uppercase alphanumeric, **length and charset only**.
<!-- VERIFY: the permitted lengths and the internal place / region / network-site / entity
     decomposition of a CLLI against the Telcordia specification before any segment-level
     validation is written. An over-tight validator rejects real codes and the product has no
     authority to define the standard. Length-and-charset validation is safe today; structural
     decomposition is not. -->

### 3.6 `PassiveNode`

A splitter, ODF, patch panel, WDM mux, media converter or enclosure — hardware with ports and no
configuration. This answers `76` X7's *"a splitter, ODF, patch panel or handhole cannot be a
`Device`, and no other kind fits."*

**`Device`'s definition is not relaxed.** *"The unit that a configuration file is a configuration file
of"* is what makes `emit(graph, platform, unit = Device)` meaningful (`11` §9.2); widening it produces
an emit unit with no config and breaks the emit contract.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `label` | `Text` | 1 | — | No hostname: nothing addresses it |
| `form` | `enum {Splitter, PatchPanel, Odf, Wdm, MediaConverter, Enclosure, Other}` | 1 | — | |
| `split_ratio` | `SplitRatio` | 0..1 | — | `{ inputs: u8, outputs: u16 }` — `1:32` |
| `model` | `Identifier` | 0..1 | — | |
| `serial` | `Identifier` | 0..1 | — | |

```yaml
identity:
  - [ owner(Premises), label ]
```

**Earns a kind** on all three limbs: distinct required fields (no platform, no os_version, no
hostname; a split ratio); distinct edge signature (`HasPort`, and none of
`HasInterface`/`HasZone`/the crypto kinds); distinct lifecycle (never parsed, never emitted, never
has a capture).

It owns `PhysicalPort`s exactly as a `Chassis` does — that is the whole trick, and it is why `HasPort`
takes a kind *set* (`11` §7.1) rather than needing a new edge shape.

**Contained by `Premises`, not by `Site`.** A passive node's defining attribute is where it physically
is; `Premises` is the location kind and `Site` is an operational grouping. A splitter in a street
handhole has no `Site`. The asymmetry with `Device` (which reaches a premises in two hops, through
its `Site`) is honest: a device belongs to an operational unit that is at a place; a splitter belongs
to nothing operational and is only somewhere. One accessor `premises_of(n)` handles both.

### 3.7 `Interface ↔ PhysicalPort` — the `Occupies` relation

Six real cases, and they do not agree:

| Case | Interfaces | Ports | Shape |
|---|---|---|---|
| SRX `ge-0/0/0` | 1 | 1 | 1:1 |
| `reth0`, `ae0` | 1 config object | 2+ front-panel ports | **not this edge** — see below |
| Breakout `xe-0/0/0:0..3` | 4 | 1 cage | 4:1, disambiguated by lane |
| Calix OLT PON port | 1 | 1 | **1:1** — the fan-out is downstream, not here |
| Empty SFP cage | 0 | 1 | 0:1 |
| `lo0`, `irb`, `st0` | 1 | 0 | 1:0 |

So the relation is many-to-many with both sides optional. That is an edge, and a field would be wrong.

```yaml
- kind: Occupies
  class: reference
  from: [Interface]                # NOT the InterfaceLike class — see below
  to:   [PhysicalPort]
  card: { out: "0..n", in: "0..n" }
  fields:
    - { name: lane, type: u8, card: "0..1" }   # breakout lane; Absent = whole port
  emit: —
```

**`from` is `[Interface]` only, and this is the existing design validating itself.** `11` §6.4 already
split interfaces four ways — `Interface`, `AggregateInterface`, `RethInterface`, `TunnelInterface` —
for reasons that had nothing to do with hardware (a reth is not a LAG; `st0` has no media). It turns
out the one kind literally headed *"a physical port"* is exactly the one with a faceplate, and the
other three are exactly the ones without. `reth0` and `ae0` reach hardware through their **members**,
which are `Interface`s, which `Occupies` ports. `st0` reaches nothing. No new mechanism is needed for
aggregation at all.

**One L0 constraint, enforced at write time:**

```yaml
constraints:
  - id: occupies.same-device
    kind: Occupies
    require: "device_of(from) == device_of(owner(to))"
    on_violation: reject_write
    # Without this, Occupies becomes a general "this config points at that hardware"
    # edge and the layer separation rots in a month.
```

`62` must define the `on_violation` vocabulary. `reject_write` is L0; `block_emit` is L2, which `11`
§6.7 uses and never names.

**The Calix PON case, stated because the naive reading is wrong.** *"A PON port serves many ONTs"* is
**not** a 1:many between port and interface. It is 1:1 at the port, and the fan-out happens in the
**passive plant**: OLT port → fibre → splitter → 32 fibres → 32 ONTs. The many-ness lives in
`Cable` / `PassThrough` / `PassiveNode`, downstream of the port. Modelling it in `Occupies` would put
outside-plant topology inside a config-to-hardware binding and make it invisible to every traversal.

**Who creates `Occupies`.** Not a parser (R-L2). But `11` §4.6's `StructuredIfName.location` —
`IfLocation { fpc, pic, port }` — has sat in the schema since it was written with no consumer. It is
the consumer now:

```
infer.port.occupies                                     (Confidence::Heuristic)
  for each Interface i on Device d with i.name.parsed.location == Some(loc):
    candidates := ports under d's Chassis whose position matches loc
    if |candidates| == 1: SUGGEST Occupies(i -> candidates[0])
    else: nothing, plus a completeness prompt
```

It produces a **suggestion, not a graph change**, following `infer.cluster.candidate`'s precedent
(`11` §9.5) rather than `infer.route.next-hop-interface`'s. The reason is breakout: four interfaces
share one position, so an auto-created derived edge would be wrong and, being derived, **uneditable**
(`11` §3.5 — derived elements are not serialised). `Occupies` must be a `reference` edge the user
owns. The rule reads only asserted values, is one level deep, never asserts `Absent`, and names its
inputs: compliant with `11` §9.5's four constraints.

**`MemberOfReth.chassis` is deprecated, not removed.** Removing an edge field is a **major** bump
(`11` §11.3) and a major strands the air-gapped users `11` §11.4 has no update path for. It stays,
marked deprecated, with an L1 consistency rule that fires when it disagrees with
`Occupies → HasPort ← Chassis`. Two sources of truth for one fact is `11` §4.6's stated cost paid
twice; one of them is now derivable and the other is legacy. (It is also the only `NodeId` in a field
body anywhere in `11`, which `11` §3.2 forbids for node fields and does not address for edge fields.
That is a defect this document notes and does not fix.)

### 3.8 `Link` is superseded; `Cabled` becomes derived

`11` §7.3's `Link` edge is superseded by `Cable` + `Terminates`. It is not silently deleted, and the
replacement is designed so that **every existing consumer keeps working unchanged**.

`11` §6.4 already names the traversal from the port side as `Cabled → Interface (0..1)`. That name is
kept, and it becomes a **derived** edge:

```yaml
- kind: Cabled
  class: derived
  from: [Interface]
  to:   [Interface, ExternalPeer]
  card: { out: "0..n", in: "0..n" }
  fields:
    - { name: via_passive, type: u8, card: 1 }   # how many PassThrough hops were walked
  produced_by: infer.port.cabled-peer
```

`infer.port.cabled-peer` runs `trace()` (§6.5) from each port an `Interface` occupies and emits one
`Cabled` edge per resolved far-end port that itself has an `Occupies`. It reads only asserted edges
(`Occupies`, `Terminates`, `PassThrough`), so `11` §9.5 constraint 1 holds; the hop cap of 16 bounds
it, which `11` §3.5 requires of any inference rule.

**`Cabled` has no inference consumer, and that is a declared property rather than an accident**
(§6.4). Under `11` §9.5 constraint 1 the pass is one level deep, so no other inference rule — in
particular not `infer.service.warp.resolve` — may read it. Its consumers are the diagram, the port
row's peer cell and the trace surface. `62` §11 records the property; a future rule that reads
`Cabled` is a two-level pass and fails the loader.

Three consequences, all of them improvements:

- `56` §5.4's edge vocabulary and `56` §4.1's `Link edge → line` row keep working, against a derived
  edge instead of an asserted one. Per `11` §7.6, derived edges render with a hairline and a margin
  tab `inferred`, which is now **correct**: the tool inferred the peer by walking a patch panel.
- `77` §6's *"click on a port which goes to other equipment"* now walks **through** an ODF rather
  than stopping at it, which is what makes this model less granular than NetBox in effect while
  being more explicit in the data.
- `56` §6.4.1's cabling gesture — *"one `Op::AddEdge { kind: Link, from, to }`, one undo step"* —
  becomes one `Op::AddNode { Cable }` plus two `Op::AddEdge { Terminates }` **in one op batch**,
  which `56` §6.4.1's own contract already supports because it is one undo step either way. The
  disclosure that resolves ports now offers `PhysicalPort`s rather than `Interface`s, and the
  unlinked-only filter becomes "ports with no `Terminates`". That is a smaller edit than it reads.

**The cost, stated.** Every document that names `Link` — `11` §7.3–7.4, `56` §4.1, §5.4, §6.4.1,
`55` §5.5 — needs a one-line edit. Because no application code exists (`76` §7.1) and no user
workspace exists (`75` §12.1: *"it will never be cheaper than it is today"*), the migration converts
zero instances and a golden fixture is all that is needed.

### 3.9 Where ports come from — the hardware-model catalogue

An OLT with 18 empty cages needs 18 rows entered by hand. That is how NetBox loses people, and it is
the single largest adoption risk in this layer.

**DECISION — a hardware-model catalogue as corpus data, not as graph kinds.**

```yaml
# corpus/hardware/calix-e7-2.yaml
model: E7-2
vendor: calix
faceplates:
  - chassis_form: Fixed
    ports:
      - { label: "1",    position: { index: 1 }, connector: Sfp,  service: Pon,      speed_max: 2.5G }
      - { label: "GE 1", position: { index: 9 }, connector: Rj45, service: Ethernet, speed_max: 1G }
reviewed_by: <named human>          # invariant 10
```

Creating a `Chassis` with a known `model` offers *"populate 24 ports"*. It is shared, versioned,
reviewed content in the `61`/`63` shape; it costs no schema; a model not in the catalogue falls back
to manual entry. Created ports carry
`Origin::Imported { format: HardwareCatalogue, document_digest, locator: "calix/e7-2#port/1" }` — a
new `ImportFormat` variant, a minor bump — which records **where each port came from and when it was
asserted**, with the catalogue's digest, so a port census is attributable and re-importable.

**It does not buy `11` §8.7's staleness bands, and an earlier draft that said it did contradicted four
other parts of this corpus at once.** §8.7's bands are computed entirely against the current date —
*Fresh < 30 d*, *Ageing 30 d – 6 mo*, *Unverified > 18 mo*, the last adding *"every finding derived
from that node carries an added one-line imperative"* — so both the chrome and the finding text change
as the calendar advances. Opting the port census in would mean the physical layer renders differently
on two days, which is what §6.10 argues against (*"a **graph function, not a clock function**… survives
`75` §4.4's 'THE PRODUCT NEEDS NO CONCEPT OF THE CURRENT TIME' untouched"*), what §12 row 7 guards
against, what §10 F4's route-B recommendation rests on (*"dates are stored and never evaluated"*), and
what `75` §4.4 states outright: *"**the same workspace renders identically forever**, because nothing
about the rendering depends on when the file was opened."*

So the position is the one the rest of the document already takes: **`asserted_at` is recorded and
rendered; it is not banded.** A port census shows `imported 2026-08-14 · calix/e7-2` in the ADR-0027
register, evaluating nothing, and *"how current is this"* is answered by §6.10's corroboration —
whether the graph can confirm the port, not how many months old the row is.

**And declining the bands is an act, not an omission, which is the part that has to be written down.**
`11` §8.7 ages a node on `max(asserted_at)` over every field whose `Origin` is `Parsed` **or
`Imported`** — so catalogue-populated ports would be banded by default, and *"the physical layer is
clock-free"* would be false on the first import unless something stops it. The carve-out is the same
attribute the rest of §2.2 uses:

> **`11` §8.7 bands apply where `layer == config`.** A `physical`- or `service`-layer node records
> `asserted_at` and renders it; it is not aged, and no finding derived from it acquires §8.7's
> imperative.

This is a third `11` amendment alongside §9.1's two, it is smaller than either, and it is the price of
the clock-freedom claim in §6.10, §10 F4 and §12 row 7 being true rather than asserted. If the owner
would rather have the bands, then those three places move together as one amendment — not one section
at a time, which is how the document ended up asserting both.

One side effect worth a sentence: the catalogue is keyed by vendor + model, so
`Chassis.model → catalogue → vendor` gives `76` X11's `{TYPE}` a second data source without adding a
`vendor` field to `Device` and without touching the platform/vendor distinction the conventions
protect. §8.2 consumes it.

### 3.10 What is deliberately not modelled

The test used throughout, and it is checkable: **omit anything whose later addition is a minor bump;
never omit anything whose later addition would be a containment change.**

| NetBox concept | Here? | Why the omission is safe, or not |
|---|---|---|
| **Rack** | No | `Chassis --MountedIn--> Rack` later is a new kind plus a reference edge = minor. Nothing in `77` traverses a rack. **Safe** |
| **Rack unit, position, height, face** | No | Same, and it is NetBox's single largest data-entry burden for zero traversal value. **Safe** |
| **Power — feeds, panels, PDUs, outlets** | No | A power topology is a disjoint second graph (*"what dies if this breaker trips"*) sharing no edge with a service path. Entirely additive later. **Safe, but name the loss:** in an access estate with battery-backed huts, "what loses power" is a real operational question this will not answer |
| **Cable termination positions (front/rear port mapping)** | **Replaced, not omitted** | NetBox's front/rear model is how it traces *through* a panel. Dropping it silently would make every trace stop at the ODF. **`PassThrough` is the cheap replacement** — one fieldless edge meaning "these two holes are the same hole", which also serves the splitter and the WDM mux. This is the one NetBox concept examined and kept |
| **Module / line card / module bay** | No | Position is three optional fields on the port. A `LineCard` kind later is minor. **Safe, loss named:** you cannot say "these 24 ports went down together because the card was pulled", and you cannot inventory spares |
| **Device bays, child devices** | No | `Chassis` already covers the cluster case; blade chassis are out of domain. **Safe** |
| **Inventory items (fans, PSUs, optics as assets)** | **Optics only** | `PhysicalPort.transceiver` is kept because it decides whether a port *can* carry a service — that is `52` §3.7.1's *"the inventory has opinions"* applied to plant, and it is the differentiator `76` §12 says survives the teaching/record fork. Fans and PSUs are asset management. **Safe** |
| **Fibre strands, splices, closures** | **Refused in writing** | A strand model needs a splice model needs a closure model — three kinds and an ordering relation, and it is a fibre-management product rather than a feature. Record one `Cable` per lit strand, put the bundle ID in `assembly` and the per-strand tag in `label` (§3.4 — they are separate fields precisely so this case has a usable identity tier). **Loss named:** *"which strand of bundle F-1204 is this"* and *"what is the loss budget on this PON leg"* are both unanswerable. Reopens only if the estate does its own splice management, in which case the honest question is not whether it is useful but whether it will be kept current |
| **IPAM (global prefixes, VLAN registry)** | No | `11` already has `Address`, `Vlan`, `IpPrefix` scoped to devices. A service-wide registry belongs to a model nobody has stated |
| **Circuits and providers** | **Deferred with a written trigger** | §3.4.2 |
| **Custom fields** | **Refused** | A runtime schema by another name. §7.1 |
| **Contacts, tenants, tags** | Tenants only, in §4 | |

---

## 4. The service layer

### 4.1 `Tenant`

`77` §2.3 poses the container-versus-label question and supplies its own deciding case: one device
normally carries services for many tenants.

**DECISION — `Tenant` is a node, it *contains* services, and it contains nothing physical.**

Container rather than label, because a tenant needs its own stable ID (invariant 7 — *"Acme Corp"* →
*"Acme Holdings"* must invalidate nothing), its own fields, and its own provenance. A `Tenant` field
on `Service` gives none of those and re-derives a name-keyed map, which `11` §2.2 rejected outright.
It contains nothing physical, which is what makes the shared-device case a non-problem: **tenancy of
infrastructure is never asserted, so it can never drift.**

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Text` | 1 | — | |
| `code` | `Identifier` | 0..1 | — | |
| `kind` | `enum {Customer, Internal}` | 1 | — | Discriminant, not a kind (`11` §6.1) |
| `account_ref` | `Identifier` | 0..1 | — | |
| `contact` | `Text` | 0..1 | — | |
| `description` | `Text` | 0..1 | — | |

```yaml
identity:
  - [ code ]
  - [ name ]
```

**The operator is a `Tenant`.** A workspace is seeded with exactly one `Tenant { kind: Internal }` at
creation. That makes containment total — every `Service` has exactly one containment in-edge, per
`11` §7.2 — with zero special cases for internal infrastructure, and it is not a hack: internal
services do belong to somebody, and that somebody is the operator.

**"Which tenants ride this port" is a query, not an edge.** The answer is
`inn(port, Terminates|Occupies) → … → PathSegment|ServiceEndpoint → owner(…) → Service → owner(Tenant)`,
run on demand. Not a derived edge, because `11` §3.5's own argument applies: a derived edge is a cache
of a pure function of the asserted graph, and a cache that can disagree with its inputs is worse than
a traversal that cannot.

**One workspace holds many tenants, and that is not a fork.** Tenant-per-workspace is *structurally
unavailable*: the moment two tenants ride one port, a service edge would have to cross two sealed
containers under different keys, which `76` Q2 establishes is impossible. What remains open is estate
*partitioning* — `76` X1 — which this document does not answer and does supply a node count for
(§11.4).

### 4.2 `Service`

`11` §6.1's test, applied to DIA / E-Line / E-LAN:

| | required fields | edge signature | lifecycle |
|---|---|---|---|
| DIA | CID, one customer endpoint | `HasEndpoint` ×1 | identical |
| E-Line | CID, two endpoints | `HasEndpoint` ×2 | identical |
| E-LAN | CID, N endpoints each with a UNI ID | `HasEndpoint` ×N | identical |

The edge *kind* is the same in all three; only its **cardinality** differs, and cardinality is
already a per-edge-kind declaration in schema data (`11` §7.1). On the test as written, none of them
earns a kind.

**But the test never gets to run**, because of a harder constraint: `77` §3.2 requires user-defined
service types, and **a user cannot define a kind.** `NodeId` embeds `NodeKind` (`11` §10.1), the kind
enum is generated (`11` §11.6), and adding one is a schema minor bump plus a rebuild (`11` §11.3). A
kind per service type makes the central requirement unbuildable.

**DECISION — one kind, `Service`, with `Service --OfType--> ServiceType (1)`.** The type is a
reference edge to a node, not an enum field and not a `NodeId` in a field body (ADR-0007 forbids the
latter).

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `cid` | `Identifier` | 0..1 | — | `R*` where `ServiceType.requires_cid`. Case-folding declared in `62`'s Matching section |
| `reach` | `enum {External, Internal}` | 1 | — | Discriminant. Internal infrastructure has no CID (§4.6) |
| `label` | `Text` | 0..1 | — | A human name where a CID is not one |
| `in_service_on` | `Date` | 0..1 | — | Stored value, rendered, **never evaluated** (`75` §4.4) |
| `ceased_on` | `Date` | 0..1 | — | Same |
| `last_confirmed` | `Date` | 0..1 | — | `Origin::Hand` only. *"A human looked at the real world and said this is still true."* Stored, rendered, sorted, exported, **never compared** |
| `attributes` | `map<Identifier, AttrValue>` | 0..n | — | Validated against `OfType` (§4.3) |
| `description` | `Text` | 0..1 | — | |

```yaml
identity:
  - [ owner(Tenant), cid ]
  - [ owner(Tenant), label ]
```

**No lifecycle enum in this pass**, deliberately (§1.2). *"Is this service live"* is computable as
`in_service_on is Set and ceased_on is Absent` — two dated facts with provenance, in the shape `75`
§3.8 already settled, colliding with nothing.

**`last_confirmed` is the answer to `77` §16 disagreement 2**, which is right that the source-of-truth
decision *"has a design obligation attached, and it is not yet written down anywhere"*. §6.10 writes
it down.

### 4.3 `ServiceType` and the closed metamodel — the C1 reconciliation

This is the collision `77` §11 C1 names: a user-definable service type looks like a user-definable
schema, and ADR-0008 holds that *"a field that exists in prose and not in `schema.yaml` does not
exist."*

**DECISION — a `ServiceType` is a node in the graph. What varies is the contents of a declared map,
not the set of declared fields.**

`Service.attributes: map<Identifier, AttrValue>` is a single field, declared once in `schema.yaml`, of
a declared type. `LogicalUnit.family_mtu: map<Family, Mtu<L3Payload>>` (`11` §6.4) is the same shape
already shipping. ADR-0008 is satisfied literally: the field exists in `schema.yaml`; its keys are
user data, exactly as a `Text` field's characters are.

| `ServiceType` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Text` | 1 | — | |
| `code` | `Identifier` | 1 | — | |
| `builtin_id` | `Identifier` | 0..1 | — | Set on shipped types; `Absent` on user types |
| `endpoint_cardinality` | `{ min: u8, max: Option<u8> }` | 1 | — | DIA `1..1`; E-Line `2..2`; E-LAN `2..n` |
| `endpoint_identifier_required` | `bool` | 1 | — | The UNI ID switch |
| `uni_scope` | `enum {Global, PerTenant, PerService}` | 1 | — | Scope of the UNI-ID uniqueness rule |
| `requires_cid` | `bool` | 1 | — | `false` for internal types |
| `attributes` | `[AttributeDecl]` | 0..n | — | The extension point, closed |
| `endpoint_attributes` | `[AttributeDecl]` | 0..n | — | Per-endpoint extension point |
| `completeness` | `[FieldPath]` | 0..n | — | The `11` §9.1 L3 profile, per type |

```yaml
identity:
  - [ builtin_id ]
  - [ code ]
```

```rust
pub struct AttributeDecl {
    pub key:         Identifier,   // stable forever, never reused
    pub label:       Text,
    pub value_type:  AttrType,
    pub required:    bool,
    pub enum_values: SmallVec<[Identifier; 0]>,   // AttrType::Enum only
    pub withdrawn:   bool,                        // never deleted — see below
}

pub enum AttrType {
    Bool, Integer, Text, Enum,
    Bandwidth, VlanId, IpPrefix, InterfaceAddress, Identifier, Date,
}
```

**`Decimal` is deleted, and it was the one variant that could not be made to work.** An earlier draft
carried it, and it introduces floating point into a product that structurally excludes it: `12` §3.4
lists floats among `fex`'s deliberately absent features — *"No field in the graph needs one… No NaN,
no `-0.0`, no locale-dependent formatting, no cross-platform rounding. **This buys determinism for
free**"* — and `11` §14.1 chose canonical CBOR partly because there are *"no floats needed anywhere in
this schema"*. A user-declarable decimal attribute would falsify both sentences from inside a map
field. Bandwidths are integers of bits per second, lengths are integers of metres, and nothing else in
`77` asks for a fraction.

**`Premises.coordinates: LatLon` is the second float carrier and it is fixed-point, not a pair of
`f64`s** (§3.5). `62` §3 defines it as `{ lat_e7: i32, lon_e7: i32 }` — degrees × 10⁷, which is the
resolution GPS hardware and every geodetic wire format already use, ~1 cm, exactly representable,
totally ordered and byte-identical across platforms. It is a user-typed value that is stored, rendered
and exported and never computed with (§3.5, §12 row 12), so no arithmetic is lost.

**An earlier draft asserted *"every `AttrType` maps onto an existing `11` §4.3 semantic scalar"*.
Seven of the eleven did not.** The sentence is replaced by the mapping, per variant, naming both the
`11` §4.3 scalar it binds to and the `12` §3.5 `Value` a rule sees:

| Variant | `11` §4.3 scalar | `12` §3.5 `Value` | Note |
|---|---|---|---|
| `Bool` | **none** — a plain primitive, not a semantic scalar | `Bool` | |
| `Integer` | **none** — a plain primitive | `Int` | `i64`, checked arithmetic |
| `Text` | `Text` | `Str` | The only free-string type |
| `Enum` | **none** — variants come from `AttributeDecl.enum_values` | `Enum(EnumId, VariantId)` | The `EnumId` is allocated per `AttributeDecl`, not per platform |
| `Bandwidth` | **missing from `11` §4.3** — §7.3 | `Int` | Bits per second. `62` §3 must define it; `11` §6.4's `Interface.speed` already uses it |
| `VlanId` | `VlanId` | `Int` | |
| `IpPrefix` | `IpPrefix` | `Prefix` | Host bits zeroed |
| `InterfaceAddress` | `InterfaceAddress` | **none** | See below |
| `Identifier` | `Identifier` | `Str` | Validated, never normalised |
| `Date` | **none** — `Timestamp` is a millisecond instant and a date is not. One of §1.1's five new scalars | **none** | See below |

**Two variants have no `Value` landing, and they are not rule-readable.** `12` §3.5's lattice is
closed at `Null | Bool | Int | Str | Enum | Dur | Addr | Prefix | List | Node`, and neither
`InterfaceAddress` nor `Date` appears. Mapping `InterfaceAddress` onto `Value::Prefix` is refused: `11`
§4.3 calls conflating the two *"the most common modelling bug in this domain"*, and committing it
inside an extension mechanism is how it becomes permanent. So both types are **stored, validated,
rendered, sorted and exported, and invisible to `fex`**: `attr(service, key)` on an attribute of
either type makes the rule `NotApplicable`, reusing §4.3's existing `uses_attr` outcome for an
undeclared key, with no new `Value` variant and no `12` change. The cost is stated plainly — *"every
LTE service must have an APN"* is expressible and *"every service installed before this date"* is not,
which is consistent with §13 open decision 3's *no, for now* on comparing stored dates.

**No new scalar families, no user-defined types, no code path of any kind** — that half of the
original claim survives, and it is the half that matters. This is `76` X5's recommended shape for a
naming scheme — *"a closed template grammar… no user code loaded, so the closed-corpus supply-chain
posture in `34` and `35` is untouched"* — applied to service types, which is what `76` §10's *"answer
it once, for both"* asked for.

**`AttrType` excludes `SecretPlaceholder`, and `Text` is admitted on its own terms rather than on a
misreading of `11`.** An earlier draft justified `Text` by claiming *"the bag's `Text` prohibition
exists to stop it becoming a back door into emitted output"*. `11` §12.4 rule 8 says the opposite and
says it in one line: *"**Never a secret.** `value_type` may not be `SecretPlaceholder` and may not be
`Text`. **The bag is not a back door around invariant 3, and `Text` is how it would become one.**"*
Emission is not mentioned. The named hazard is a human typing a PSK into a free-text slot, and that
hazard is fully present here — a service attribute is a free-text slot on an object a customer's
credentials get discussed around.

`Text` is kept anyway, because a service type genuinely needs prose an operator can label (*"handover
notes"*, *"NNI reference"*) and `Service.description` is one field for all of them. It is kept with
the compensating controls stated rather than with the hazard denied:

- **`37` §2.2 gains a row** for `Service.attributes` and `ServiceEndpoint.attributes`, with a verdict.
  That document already names free-text as its number-one personal-data channel, and this adds a
  channel whose *keys* are operator-chosen, which is worse than a fixed field, not better.
- **`62` §18 lints an `AttributeDecl { value_type: Text }`** whose `key` or `label` matches the
  secret-shaped token list (`psk`, `secret`, `key`, `password`, `passphrase`, `credential`), refusing
  the declaration with a stable error code. That is the rule-8 hazard caught at declaration time,
  which is the only point at which it is catchable — the value is user data and cannot be inspected.
- **Nothing in this layer emits** (§7.2), so invariant 3's emitted-output limb is untouched. That was
  always true; it was never the reason rule 8 exists.

**An `AttributeDecl` is never deleted, only `withdrawn`.** That is the protobuf field-number lesson,
and it is what makes merge, export and a stored value with no live declaration survivable: a
withdrawn key's values are preserved and rendered, and no new values may be written. Deleting a
declaration whose values exist somewhere is how a taxonomy silently drops data.

**Validation is L1, not L0, and the distinction matters.** `Service.attributes` is checked against
the `ServiceType` reached through `OfType`: unknown keys refused at write time (L0 — that is a type
error), wrong types refused at write time (L0), **missing `required` keys reported as L1 holes and
never refused**, because partiality is the normal state per `11` §9.1 and refusing a write until every
required attribute is present would make it impossible to create a service before you know its
bandwidth.

That cross-node check is one thing L0 does not do today, so:

> **`62` must add one declarative L0 clause:** a field carrying `validated_against: edge(OfType)` may
> not be written while that edge is absent. The error names the missing edge. This generalises —
> §8 wants the identical shape against a naming scheme.

**Rules reading attributes.** `fex` gains one accessor, `attr(service, "key") -> Presence<AttrValue>`.
The pack lint cannot validate the key against `schema.json` because the key universe is per-workspace,
so the mitigation is the mechanism already decided for the extension bag (`11` §12.4 rule 4): a rule
must declare `uses_attr: [key]`, and a rule reading an attribute the workspace's types do not declare
returns `NotApplicable` — never `Passed`. Stated cost: **attribute-reading rules are the one place in
the product where a rule can silently apply to nothing**, and the `NotApplicable` reason string is
what makes it visible.

**Required-attribute checking needs no rule-engine change.** `11` §9.1's L3 level is already
*"every field a named profile declares mandatory is `Set` … profiles are corpus data"*. Extending L3's
source to include `ServiceType.completeness` and `AttributeDecl.required` gives *"every LTE service
must have an APN"* with no engine change, and it gives `77` §4.2's *"a single completeness rule cannot
serve both"* a per-type home rather than a subsystem.

#### 4.3.1 Built-in and user-defined are the same mechanism

**DECISION — built-ins ship as corpus declarations and are materialised into the graph at workspace
creation**, carrying `Origin::Imported { format: Corpus, document_digest, locator }` and a
`builtin_id`. A corpus update can offer to refresh a shipped type by `builtin_id` without clobbering
a user's edit, because the edit is an ordinary field assertion with `Origin::Hand`, which wins on
`11` §8.6's precedence ladder.

The rejected alternative — built-ins in the corpus and only user types as nodes — makes `OfType` point
at two different things, forces every consumer to carry both paths, and makes *"tweak the shipped
E-Line"* a different operation from *"make a type"*. One mechanism, seeded.

**Ship four built-ins: DIA, E-Line, E-LAN, Internal Interlink.** Voice and LTE are not shipped,
because `77` §3.1 marks both `<!-- VERIFY -->` and `77` §13 names *"the `<!-- VERIFY -->` markers get
silently resolved by a later reader guessing"* as its own failure mode. §10 F3.

| Built-in | `endpoint_cardinality` | `endpoint_identifier_required` | `requires_cid` |
|---|---|---|---|
| `dia` | `1..1` | false | true |
| `eline` | `2..2` | operator's choice | true |
| `elan` | `2..n` | **true** | true |
| `internal-interlink` | `2..2` | false | **false** |

**DIA is `1..1`, not `1..2`.** The provider side is where the *path* terminates, not a second
endpoint. An endpoint is a customer demarcation with a UNI-class identifier; making the provider edge
an endpoint gives every DIA a phantom UNI that nobody will ever fill and every completeness check will
ask about forever.

#### 4.3.2 Sharing a type set between workspaces

`77` §3.3 and `76` §10 both ask whether user-defined types are shareable. **DECISION — a type set
exports as a plain declaration file and imports with a reviewed diff. It is copied, never referenced:
no URL, no registry, no fetch.**

That gives the owner's stated motive — *"easier to do again"* — with zero new trust machinery.
Invariant 10 does not apply, because the artefact is workspace data the user wrote, not corpus. The
ceremony that is right for *"PFS is absent"* is wrong for *"our E-LAN has a jumbo-frames flag"*, and
this is the same asymmetry `76` X5 identifies for naming. Signed type packs are refused: ADR-0028
item 3 did not open that door for the strictly stronger artefact (rule packs, whose remediation lines
get pasted into a firewall) and it should not be opened here first.

### 4.4 `ServiceEndpoint` — E-LAN first

E-LAN is the shape that breaks naive designs, so design it first: one service, N locations, **each
with its own identifier, its own location, its own attachment to physical plant, its own dates, and
its own attributes.** `77` §3.1 calls this *"the load-bearing detail"* and it is.

**Earns a kind** on all three limbs at once — distinct required-field set (`uni_id`, `role`,
`ordinal`), distinct edge signature (`AtLocation`, `AttachesTo`), distinct lifecycle (one site can be
in service while another is pending). It is also promoted by `11` §3.4's rule regardless: *"the moment
a third thing needs to reference a relation, that relation is promoted to a node"* — a path terminates
at an endpoint, a finding attaches to one, a diagram element addresses one.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `uni_id` | `Identifier` | 0..1 | — | The per-location identifier. `Absent` where the type declares none; never invented |
| `role` | `enum {Uni, Nni, Enni, Demarc}` | 1 | — | Which side of the demarcation |
| `ordinal` | `u32` | 1 | — | Stable display order; gaps legal (`SecurityPolicy.ordinal` precedent) |
| `label` | `Text` | 0..1 | — | |
| `in_service_on`, `ceased_on` | `Date` | 0..1 | — | Per-endpoint, because E-LAN sites turn up separately |
| `attributes` | `map<Identifier, AttrValue>` | 0..n | — | Validated against `ServiceType.endpoint_attributes` |

```yaml
identity:
  - [ owner(Service), uni_id ]
  - [ owner(Service), ordinal ]
  - [ owner(Service), edge(AttachesTo) ]
```

Three tiers, because a UNI ID survives a port move and a port survives a UNI renumber. Tier 3 is what
survives the common data-entry fix — correcting a mistyped UNI ID.

Edges out: `AtLocation → [Site, Premises] (0..1)`, `AttachesTo → [InterfaceLike, LogicalUnit,
PhysicalPort] (0..1)`.

`AttachesTo`'s `to` set includes the `InterfaceLike` **class** (`11` §12.1: *"classes are declared in
`schema.yaml` as named kind sets and are the only inheritance-like mechanism"*) so it admits
`Interface`, `AggregateInterface`, `RethInterface` and `TunnelInterface`; plus `LogicalUnit`, because
a UNI is frequently a tagged unit rather than a whole port; plus `PhysicalPort`, because a demarcation
may be recorded before any configuration exists. It is a reference edge, so R-L1 holds and deleting a
service never deletes a port.

**A `Demarc` endpoint with no `AttachesTo` is legal and is not a hole.** That is the customer side of
`77` §4's horizon, and §6.3 makes the path that reaches it complete by construction.

### 4.5 CID and UNI ID are fields with an index

Invariant 7 is unambiguous: names are fields and never identity. A CID is a name. **`Service.cid` is
`Field<Presence<Identifier>>`** — ordinary provenance, ordinary history, renameable, carried in
`Node.aka` as a `FormerName` when it changes (`11` §10.2), invalidating nothing.

The tension — a CID is also how a human finds a service — is resolved by an index, which is the cost
`11` §3.3 already accepted (*"Every lookup that a vendor writes as a name becomes an ID lookup through
an index"*).

**DECISION — `Graph` gains two indexes, maintained incrementally on write alongside the existing
adjacency indexes:**

```rust
by_cid: BTreeMap<CidKey, SmallVec<[NodeId; 1]>>,
by_uni: BTreeMap<UniKey, SmallVec<[NodeId; 1]>>,
```

`BTreeMap`, not `HashMap`, so iteration is deterministic per invariant 9 — the same rule `71` X4.1
states as *"no HashMap iteration, no wall-clock, no randomised seeds"*. The key is the field's
`canonical()` form under the per-field case-folding declared in `62`'s Matching section, which
ADR-0008 already reserves.

**DECISION — the index does not enforce uniqueness; a rule does.** `SmallVec`, not a single `NodeId`,
is deliberate: duplicate CIDs occur in every real estate — reused identifiers, typos, migrations. An
L0 refusal on a duplicate would make importing a real estate impossible and would silently discard the
second one. So `service.cid.duplicate` and `service.uni.duplicate` are ordinary rules, findings-shaped,
suppressible with a reason like anything else. That keeps invariant 5's line: this is a judgement
about an estate, and judgements about estates are data.

`ServiceType.uni_scope` supplies the second rule's scope, because *"unique globally / per tenant / per
service"* is an operator convention and conventions must be data. The shipped E-LAN type sets
`Global`, which is the common carrier convention and the widest useful lookup key; an operator whose
estate disagrees changes one field on one node and no migration runs.

Typing a CID into the finder or an inventory filter resolves through `by_cid` to zero, one, or several
nodes; several is rendered as several, with the tenant shown, never silently resolved to the first.
**The stored data never contains a CID as a reference** — every reference in the workspace is a
`NodeId`.

### 4.6 Internal services have no CID

`77` §2.3 asks whether *"has no CID"* is a distinct modelled state or an absent field, and notes
correctly that the two behave differently under a lint.

**DECISION — an absent field, asserted, and there is no new state.**

An internal service's `cid` is `Absent`, asserted by the human who set `reach: Internal`, which `11`
§8.5 permits explicitly (*"a human explicitly asserting absence — the UI affordance is a distinct
control"*). Better than that: with `ServiceType.requires_cid: false`, the field is not `R*` for that
type, so `Unknown` is not a hole, the completeness prompt (`11` §9.3) never asks, and the emitter is
not involved because nothing in this layer emits.

One cross-field constraint, at **L1** and not L0:

```yaml
- id: service.cid.required-when-external
  kind: Service
  level: L1
  require: "reach == External implies cid is Set"
```

L1 rather than L0 because a service must be creatable before its CID is known. It surfaces as a
completeness prompt, which is exactly the shape `11` §9.3 designed for it.

---

## 5. The edge taxonomy

Every edge below is binary, typed and optionally fielded — the same shape as the thirty `11` §7
declares. **No new edge shape is introduced**, which is the half of ADR-0030's break trigger that
actually tests whether the property graph generalises to a second domain (§7.5).

### 5.1 Physical layer

| Edge kind | Class | From | To | out | in | Fields |
|---|---|---|---|---|---|---|
| `HasPremises` | containment | *root* | `Premises` | 0..n | 1 | — |
| `HasPort` | containment | `Chassis`, `PassiveNode` | `PhysicalPort` | 0..n | 1 | — |
| `HasPassiveNode` | containment | `Premises` | `PassiveNode` | 0..n | 1 | — |
| `HasCable` | containment | *root* | `Cable` | 0..n | 1 | — |
| `AtPremises` | reference | `Site` | `Premises` | 0..1 | **0..n** | — |
| `Terminates` | reference | `Cable` | `PhysicalPort`, `ExternalPeer` | 0..2 | 0..n | `end: A\|B` (1), `lane: u8` (0..1) |
| `Occupies` | reference | `Interface` | `PhysicalPort` | 0..n | 0..n | `lane: u8` (0..1) |
| `PassThrough` | reference | `PhysicalPort` | `PhysicalPort` | 0..n | 0..n | — |

Notes that carry weight:

- **`AtPremises.in: 0..n` *is* the requirement.** *"Several units at this address"* becomes a count of
  in-edges, not a population scan. It is a reference edge, not containment, so nothing is re-parented
  and the bump stays minor.
- **`HasCable` is root-level**, beside `HasTunnel` and `HasPremises`, because a cable spans two
  premises and cannot be contained by one. Same argument `11` §7.2 makes for `Tunnel`.
- **`Terminates.out: 0..2`.** A cable has two ends. A breakout is four cables sharing a near-end port,
  not one four-ended cable — a hyperedge is unrepresentable in this graph and NetBox's alternative is
  the granularity `77` §6 rejects.
- **`PassThrough` carries no fields and means "these two holes are the same hole".** L0 constraint
  `passthrough.same-owner`: `owner(from) == owner(to)`, `on_violation: reject_write`. Its **degree**
  drives both rendering and traversal: exactly one makes the panel transparent; more than one is a
  fan-out.
- **`HasExternalPeer` is amended** from `from: [Site]` to `from: [Site, Premises]`. Widening a kind set
  is a minor bump and re-parents nothing. It is what lets a subscriber endpoint be a labelled terminal
  at a street address with no `Site` node at all — the difference between a residential estate costing
  two nodes per subscriber and four. §10 F1.

### 5.2 Service layer

| Edge kind | Class | From | To | out | in | Fields |
|---|---|---|---|---|---|---|
| `HasTenant` | containment | *root* | `Tenant` | 0..n | 1 | — |
| `HasServiceType` | containment | *root* | `ServiceType` | 0..n | 1 | — |
| `HasService` | containment | `Tenant` | `Service` | 0..n | 1 | — |
| `HasEndpoint` | containment | `Service` | `ServiceEndpoint` | 1..n | 1 | — |
| `HasPath` | containment | `Service` | `ServicePath` | 0..n | 1 | — |
| `HasSegment` | containment | `ServicePath` | `PathSegment` | 1..n | 1 | — |
| `OfType` | reference | `Service` | `ServiceType` | 1 | 0..n | — |
| `PathFrom` | reference | `ServicePath` | `ServiceEndpoint` | 1 | 0..n | — |
| `PathTo` | reference | `ServicePath` | `ServiceEndpoint`, `Device`, `ExternalPeer` | 0..1 | 0..n | — |
| `AtLocation` | reference | `ServiceEndpoint` | `Site`, `Premises` | 0..1 | 0..n | — |
| `AttachesTo` | reference | `ServiceEndpoint` | *InterfaceLike*, `LogicalUnit`, `PhysicalPort` | 0..1 | 0..n | — |
| `EntersAt` | reference | `PathSegment` | `PhysicalPort`, *InterfaceLike*, `LogicalUnit` | **0..n** | 0..n | — |
| `ExitsAt` | reference | `PathSegment` | `PhysicalPort`, *InterfaceLike*, `LogicalUnit` | **0..n** | 0..n | — |
| `MustTraverse` | reference | `PathSegment` | `Device`, `PassiveNode` | 0..n | 0..n | — |

**`EntersAt` and `ExitsAt` are `0..n` at L0 and `0..1` at L1, and the reason is merge.** A concurrent
write of two different entry ports on one segment must converge. Add-wins on a `0..1` edge is
unrepresentable (`33` §6.6 makes exactly this argument for tombstones), so the upper bound relaxes at
L0 and a rule `service.path.segment.multiple-entry` reports it. Nothing is lost, the store holds it,
and a human sees both. This is `11` §9.1's L0/L1 split used for the purpose it exists for.

**`HasEndpoint.out: 1..n`** — a service with no endpoint is not a service. The *upper* bound comes from
`ServiceType.endpoint_cardinality` and is checked at L1, per service, not hardcoded in the edge
declaration.

### 5.3 Derived edges

| Edge kind | From | To | Produced by | Fields |
|---|---|---|---|---|
| `Cabled` | `Interface` | `Interface`, `ExternalPeer` | `infer.port.cabled-peer` | `via_passive: u8` |
| `WarpResolvesVia` | `PathSegment` | `PhysicalPort` | `infer.service.warp.resolve` | `candidate: u8`, `ordinal: u16` |
| `CarriedBy` | `Service` | `Device`, `PassiveNode` | `infer.service.carried-by` | — |

**`WarpResolvesVia`, not `ResolvesVia`, and the rename is not cosmetic.** `ResolvesVia` is already
taken: `11` §7.6 declares `ResolvesVia | StaticRoute | LogicalUnit | infer.route.next-hop-interface`,
and `11` §3.4 uses it as the canonical derived-edge example. Edge kinds are a **generated enum**
(`11` §11.6) with per-kind `from`/`to` sets, so a second declaration under the same name with a
different `from`, a different `to` and a different producer is a redeclaration that fails codegen —
not an overload. An earlier draft named it `ResolvesVia` in §5.3 and `ResolvedVia` in §12 row 1, which
is the collision arriving twice and being noticed neither time. §1.3 lists derived edges among what
`11` decided and this document never re-argues, so nothing in the review path would have caught it.
`SegmentTraverses` was the alternative and was passed over only because it reads as an assertion about
the path rather than a resolution of it.

All three obey `11` §3.5: separate arena, never serialised, never merged, never edited, recomputed on
load and after every mutation batch, rendered with `11` §7.6's hairline and `inferred` margin tab.
**The store must refuse to serialise them** — that refusal is the guard against the failure mode in
§12 row 1.

`infer.service.carried-by` reads `device_of()` over **asserted** `EntersAt` / `ExitsAt` / `AttachesTo`
only — never through a resolved warp — which keeps the pass one level deep per `11` §9.5 constraint 1.
Its limitation is meaningful and must be stated in its explainer: **a warp's interior is equipment the
path does not assert it traverses**, so *"what breaks if Hub B is decommissioned"* answered from
`CarriedBy` alone under-reports. The honest answer runs `resolve_warp` and says which segments were
resolved heuristically.

---

## 6. The path and the warp

### 6.1 The split: an asserted claim, a derived resolution

`77` §5.4 asks whether the warp is a **modelled edge** or a **rendering of an unresolved path
segment**. It is neither, and both readings fail for reasons the corpus already states.

**A rendering fails `52` §1:** *"THE VIEWS ARE RENDERINGS OF ONE SELECTION OVER ONE GRAPH. A VIEW THAT
HOLDS STATE THE OTHERS CANNOT SEE HAS BECOME A SECOND APPLICATION."* If the diagram holds the fact
that a segment is elided, the inventory cannot list it, a finding cannot anchor to it, and an export
omits it. The warp carries a CID's route in a system of record; it cannot live in a picture.

**A single stored object fails `11` §3.5:** *"derived nodes and edges live in a separate arena and are
never serialised… they are a pure function of the asserted graph plus the corpus version, so storing
them means storing a cache that can disagree with its inputs."* A stored hop list **is** that cache.
It is exactly the thing that goes stale the day Hub B arrives.

> **DECISION — the warp is stored data (a path segment with `kind: Warp` and two named ports). Its
> expansion is derived.**

| Half | Class | Stored? | Author |
|---|---|---|---|
| The claim — *"traffic goes from this port to that port, and the equipment between them is not recorded here"* | asserted node + two reference edges | yes | a human, `Origin::Hand` |
| The resolution — the concrete hops that claim currently corresponds to | derived edges + a derived value | **never** | `infer.service.warp.resolve` |

**Lazy resolution is not a new mechanism. It is `11` §3.5 applied to a service path.** That is why the
whole feature costs one inference rule rather than a subsystem: derived elements live in an arena that
is rebuilt from the asserted graph rather than stored, so a path recorded before Hub B existed gains
Hub B the next time anybody looks at it, with no migration, no re-entry and no stored hop to go stale.

**"The next time anybody looks" and not "on the next open", and the difference is priced in §6.6.**
`11` §3.5 recomputes derived elements on load, and for the inference rules `11` §9.5 lists that is a
linear scan — but §3.5 is explicit that this *"puts a hard ceiling on how expensive an inference rule
is allowed to be, and that ceiling will be hit."* `resolve_warp` hits it: §11.6's census puts a
ten-thousand-service estate at ~240,000 segments, and resolving all of them eagerly on every open is
not `O(N + E)`. So resolution is **demand-driven and budgeted** (§6.6's fourth bound), which changes
nothing about the lazy property — a segment is still a pure function of the asserted graph, still
never stored, still gains Hub B without being rewritten — and changes only *when* the function is
evaluated.

### 6.2 `ServicePath` and `PathSegment`

**DECISION — a service holds ordered paths; a path holds ordered segments.** Two levels, not one.

`ServicePath` earns a kind: distinct required field (`role`), distinct edge signature (`PathFrom 1`,
`PathTo 0..1`, contains `PathSegment`), distinct lifecycle (a `Historic` path outlives the service's
current routing). For an E-LAN the natural recording is one path per site back to the aggregation
point — N paths, not N² — and the model does not force a choice: a service has as many paths as the
operator records.

| `ServicePath` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `ordinal` | `u32` | 1 | — | Stable display order within the service; gaps legal. Also the identity discriminant — see below |
| `role` | `enum {Working, Protect, Historic}` | 1 | — | |
| `label` | `Text` | 0..1 | — | |
| `last_confirmed` | `Date` | 0..1 | — | `Origin::Hand` only, never compared |
| `note` | `Text` | 0..1 | — | |

```yaml
identity:
  - [ owner(Service), ordinal ]
  - [ owner(Service), label ]
```

**`ordinal` is not decoration; without it tier 1 is degenerate in the two cases this kind exists
for.** An earlier draft used `[ owner(Service), edge(PathFrom), role ]`, which collides the moment a
service records two paths of the same role from the same endpoint — and this section invites exactly
that twice over. `Historic` paths **accumulate by definition** (line above: *"a `Historic` path
outlives the service's current routing"*), all carrying `role: Historic` and the same `PathFrom`, so
tier 1 is ambiguous after the first re-route. Diverse `Working` routing from one endpoint is the same
shape and is the normal case, not an edge case. Tier 2 does not rescue it: `label` is `0..1` and
nothing enforces that a human types a distinct one.

The cost of the collision is not a duplicate — it is silent unrepairability. §9.5 derives
`FindingKey.anchor_nk` from the tier-1 tuple, so every finding on every historic path of one service
would share an anchor, and `fsck --repair` re-binds only *"where exactly one node matches"* — never,
here. `PathSegment` and `ServiceEndpoint` both already carry an `ordinal` for precisely this reason
(§6.2, §4.4), and `SecurityPolicy.ordinal` is `11`'s own precedent. This is the third instance of one
pattern, not a new mechanism.

`PathSegment` is a node rather than an edge for two reasons, both from `11` §3.4. First, things
reference it: a finding attaches to a segment, the diagram addresses one, the resolution attaches to
one. Second and decisively, **an edge must have exactly two endpoints and a `Boundary` segment has
one.**

| `PathSegment` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `ordinal` | `u32` | 1 | — | Position along the path; gaps legal |
| `kind` | `SegmentKind` | 1 | — | The discriminant (§6.3) |
| `boundary_reason` | `enum {CustomerPremises, ThirdPartyCarrier, NotOurs, PolicyStop}` | 0..1 | — | `R*` when `kind == Boundary` |
| `warp_technology` | `enum {L2Ptp, Pseudowire, Evpn, Vlan, Other}` | 0..1 | — | `R*` when `kind == Warp` |
| `max_hops` | `u8` | 0..1 | — | Overrides the workspace default (§6.6) |
| `note` | `Text` | 0..1 | — | |

```yaml
identity:
  - [ owner(ServicePath), ordinal ]
  - [ owner(ServicePath), edge(EntersAt), edge(ExitsAt) ]
```

**Ordering the segments costs nothing and does not freeze anything, and this is the reconciliation
worth stating explicitly.** An ordinal orders the *recorded claims*, not the *resolved hops*. When Hub
B is modelled, no segment is added, removed or reordered — one `Warp` segment's derived resolution
changes from `Unresolved` to `Resolved{3}`. The lazy property is entirely intact, and the alternative
(an unordered leg set whose order is recovered by walking) buys nothing and introduces a failure mode
— a leg set that does not walk — that the ordered form does not have.

**A segment names its two ports and never the cable.** `11` §3.4 permits a node to be an edge
endpoint, so referencing a `Cable` is now legal; it is still wrong. The reason is behaviour:
**re-patch a cable and every path through it follows automatically**, which is the same lazy-resolution
property `77` §5.2 asks for, extended to physical plant for free. Cost, stated: if two ports are
un-cabled, the segment becomes unresolvable and says so — finding `service.path.segment.no-cable`,
which is correct.

### 6.3 The three states, kept structurally apart

`77` §5.4's third open question asks whether the out-of-scope error distinguishes *not modelled yet*
from *deliberately out of scope*. `77` §4 says they *"look identical to a user and mean opposite
things"*. Under this design they are **different data, not two readings of one error**:

```rust
pub enum SegmentKind {
    Physical,   // traverses modelled equipment; the hops are asserted
    Warp,       // stands in for an L2 P2P; the interior resolves lazily
    Boundary,   // the modelling horizon. This is where we stop, on purpose
}
```

| Meaning | Where it lives | Produces | Reads as |
|---|---|---|---|
| **Resolved** | `kind: Warp`, resolution `Resolved{n}` | the hops, drawn `inferred` | *"here is what it crosses today"* |
| **Not modelled yet** | `kind: Warp`, resolution `Unresolved` | an `Unprovable` (`12` §8.3) with a count in the findings footer and a *model it* target | *"I looked and there is nothing there"* |
| **Not looked at yet** | `kind: Warp`, no computed resolution (§6.6) | counted separately in the footer as *not examined* — never folded into the `Unprovable` count, which would be a number nobody paid for | *"I have not looked"* |
| **Deliberately out of scope** | `kind: Boundary` | **nothing at all** | *"there is nothing to look at"* |
| **The record is wrong** | any kind, resolution `Contradicted` | a **finding**, `service.path.contradicted` | *"what you told me disagrees with what else you told me"* |

**A path ending in a `Boundary` segment is complete by construction.** L1 and L3 read the segment kind
and stop, so no completeness check reports a false gap forever — which is `77` §4's stated requirement.
`boundary_reason` is `R*` when `kind == Boundary`, so the picture and the report can say *which* stop
it is. A `Boundary` segment sets `EntersAt` and deliberately leaves `ExitsAt` unset; the path's
`PathTo` may point at an `ExternalPeer` or a `ServiceEndpoint { role: Demarc }` so the path visibly
ends at a labelled thing rather than trailing off.

**`service.warp.unresolved` is deliberately not a rule.** It is `12` §8.3's `Unprovable`, which means
it inherits `12` §8.4's footer for free: *"14 warps have no modelled path"* sits in the same band as
*"14 checks need the far end"*, and rule 1 of that surface — the count is shown even at zero — is what
stops an estate accumulating silent gaps.

### 6.4 `port_of` — one adjacency universe, not two

A segment may name a `PhysicalPort` (plant modelled) or an `Interface`/`LogicalUnit` (only the config
modelled). Resolving over two universes would double every traversal. One function collapses them:

```rust
/// Normalise a segment or endpoint reference to a traversal vertex.
/// Total, pure, no allocation beyond the return.
fn port_of(g: &Graph, v: NodeId) -> Vertex {
    match v.kind {
        PhysicalPort => Vertex::Port(v),
        Interface    => match g.out_one(v, Occupies) {
                            Some(e) => Vertex::Port(e.to),
                            None    => Vertex::Iface(v),
                        },
        LogicalUnit  => port_of(g, g.containment_parent(v)),   // depth <= 1
        _            => Vertex::Iface(v),
    }
}
```

`Vertex::Port` walks plant — the asserted `Terminates` / `PassThrough` pair, exactly as `trace()`
does (§6.5). `Vertex::Iface` walks **device siblings only**, over asserted containment. Both are
handled by one step relation. This is the join that makes a path recorded against interfaces gain
plant detail the day the plant is entered, without the path being rewritten: the moment an
`Occupies` is asserted, `port_of` returns `Vertex::Port` for that interface and the plant limb takes
over.

> **`Vertex::Iface` does not walk `Cabled`, and an earlier draft that said it did broke `11` §9.5
> constraint 1** — *"It may read only asserted values, never other inferred ones. The inference pass
> is one level deep and is not a fixpoint."* `Cabled` is **derived**, produced by
> `infer.port.cabled-peer` (§3.8, §5.3), so `resolve_warp` reading it would put one inference rule
> downstream of another, make the pass two levels deep and order-dependent, and forfeit the exact
> constraint §6.6 claims to satisfy. §5.3 applies the rule correctly to `infer.service.carried-by`
> and the adjacent rule must not break it.

**The limb was also unreachable, which is why deleting it costs nothing.** `port_of` returns
`Vertex::Iface(i)` for an `Interface` **only** when `i` has no `Occupies`; `infer.port.cabled-peer`
emits `Cabled` **only** from a port an `Interface` occupies. An interface with no `Occupies` has no
`Cabled` out-edge, by construction. The other `Vertex::Iface` producers — `AggregateInterface`,
`RethInterface`, `TunnelInterface`, and a `LogicalUnit` under any of them — are outside `Cabled`'s
`from` set (`[Interface]`, §5.3) and outside `Occupies`' (§3.7). The limb could never fire in any
case reachable from `port_of`.

**So `Cabled` has no inference consumer at all.** It is a presentation and click-through convenience:
it keeps `56` §4.1's `Link edge → line` row working, it answers `77` §6's *"click on a port which goes
to other equipment"* from the interface side, and it renders with `11` §7.6's hairline and `inferred`
tab. Nothing in the inference pass reads it, and `62` §11 should record that as a declared property
rather than a coincidence, because re-adding a consumer is how the two-level pass comes back.

### 6.5 `trace` — clicking a port and travelling

`77` §6's *"you can click on a port which goes to other equipment"* is not one hop. It is a trace with
a stopping rule.

```
trace_step(port) -> Outcome:
  cables := in_edges(port, Terminates), sorted by EdgeId          # invariant 9
  match cables.len():
    0   -> Unterminated
    n>1 -> Ambiguous(cables)                                      # breakout; pick by lane
    1   -> let far = other_end(cables[0])
           match far.kind:
             ExternalPeer -> Horizon(far)                         # 77 §4's deliberate stop
             PhysicalPort ->
               let through = out_edges(far, PassThrough)
                             sorted by (label, NodeId)
               match through.len():
                 0 -> Arrived(far)
                 1 -> Continue(through[0].to)                     # a patch panel is TRANSPARENT
                 k -> FanOut(through)                             # a splitter is not
```

Iterated with a visited set — a miscabled ODF loop is a real data-entry error, not a hypothetical —
and a hop cap of **16**; a trace that exceeds it reports `Exceeded` rather than truncating silently.

Two behaviours worth naming:

- **A patch panel with exactly one `PassThrough` is walked through.** This is what makes the model
  less granular than NetBox *in effect* while being more explicit in the data: NetBox makes you look
  at the panel; here the panel is a waypoint in the reported path rather than a destination.
- **A fan-out is `59` §3's aggregation rule, unchanged.** A 1:32 split is 32 like-kind siblings, well
  past the threshold of six, so it collapses into one affordance that states what it hides and how
  many, expands on activation, and drops nothing silently. `59` §3.1 already established this as
  *"a transform on the model, run before layout"*.

### 6.6 `resolve_warp` — bounded, deterministic, six outcomes

One inference rule in `11` §9.5's pass, subject to its four constraints.

**The step relation.** From a vertex you may step to (a) whatever `trace()` reaches, or (b) any
sibling `Interface`/`PhysicalPort` on the same `Device`. Device-crossing adjacency is **computed
inside the search, never materialised** — materialising it is `O(ports²)` per device and buys nothing.
Both limbs read **asserted edges only** — `Terminates`, `PassThrough`, `Occupies`, containment — and
no derived edge, `Cabled` included (§6.4). That is `11` §9.5 constraint 1 and it is checkable by
reading the two limbs.

**The search.** Bidirectional BFS from `port_of(EntersAt)` and `port_of(ExitsAt)`, enumerating up to
**K = 4** distinct simple paths, and honouring every `MustTraverse` constraint on the segment.

**Three per-segment bounds, all reported, none silent — and a fourth, per open:**

1. `max_hops` — per-segment override, workspace default **8**.
2. A node-visit guard of **4096** per segment. This is `11` §10.4's existing guard constant, reused
   rather than reinvented, and it carries the same `<!-- VERIFY -->` obligation to be measured rather
   than guessed.
3. K = 4 candidates. If a fifth is found the state is `Ambiguous { candidates: 4, more: true }` and
   the label reads `4+ possible paths` — never a total that was not counted.

**A fourth bound, and it is the one an earlier draft left out.** Bounds 1–3 are per segment. The
design's whole lazy-resolution property comes from recomputing on every open (§6.1), and `11` §3.5
says what that costs: *"opening a workspace pays the inference pass every time… it puts a hard ceiling
on how expensive an inference rule is allowed to be, **and that ceiling will be hit.**"* `11` §14.3
prices the inference pass at `O(N + E)`. A bidirectional BFS enumerating up to four simple paths under
a 4096-node-visit guard is not `O(N + E)`, and the per-segment bounds do not compose into a per-open
one: §11.6's own arithmetic puts ten thousand services at ~330,000 nodes and ~240,000 segments, which
at the guard is on the order of 10⁹ node visits per open. `44` §7.1 already puts workspace open at ~100
devices with the residual recorded literally as *"Unresolved"*. Resolving every warp eagerly on every
open is therefore not viable at any estate size worth having this feature for.

> **DECISION — resolution is demand-driven and budgeted per open, not eager.**
>
> | | |
> |---|---|
> | **On open** | Nothing is resolved, and that is **not** `Resolution::Unresolved` — that variant means *the search ran and found nothing*, which is a different claim. A segment simply has no computed `Resolution` yet, which is the ordinary state of a derived field before it is demanded (`11` §3.5; §7.3(i)). It renders `not yet examined`. **The enum is unchanged and there are still six outcomes** |
> | **On demand** | A segment resolves when something asks: the path is drawn, its service is opened, a finding needs it, or an export requests it. The result lands in the derived arena (`11` §3.5), so a second ask is free |
> | **Invalidation** | A mutation batch touching any of `Terminates`, `PassThrough`, `Occupies`, `MustTraverse`, `EntersAt`, `ExitsAt` or the containment of a `Chassis`/`PassiveNode` drops the cached resolutions that read it — `12` §6.3–6.5's `ReadBy` machinery, unchanged, over the read set `resolve_warp` already names per `11` §9.5 constraint 3 |
> | **Per-open ceiling** | `RESOLVER_BUDGET` node visits across all segments resolved in one session-open, workspace default **2²⁰**. On exhaustion further segments return `BudgetExhausted { bound: Visits }` — a visible state with a control that raises it, never a silent truncation |
>
> This keeps §6.1's property exactly: a path recorded before Hub B existed gains Hub B the next time
> anybody looks at it, with no migration, no re-entry and no stored hop. What it gives up is that the
> `Unprovable` **count** in §6.3's findings footer is over segments *examined*, not over all segments,
> so the footer reads `1 warp has no modelled path · 240,000 not examined` rather than a total nobody
> paid for. That is `12` §8.4 rule 1's own discipline — never a number that was not counted — and it
> is the honest form.

**Per-open cost, as a function of the thing that drives it:** `O(S_asked × min(4096, N_reachable))`
where `S_asked` is the number of segments something actually asked about, capped by `RESOLVER_BUDGET`.
For one service on screen, `S_asked ≤ 6` and the cost is invisible. For a whole-estate export,
`S_asked` is every segment and the budget is what stops it. **The eager form's cost was
`O(S_total × 4096)` with no cap at all**, and that is the number §11 never carried.
<!-- VERIFY: RESOLVER_BUDGET's 2²⁰ is a guess of the same kind as the 4096 (§13 item 2) and must be
     measured in WASM against a real service census before it is quoted. -->

**`44` §7.1's breakage table needs a new row for this**, between its rows 4 and 6: *workspace open
with a populated service layer*, breaking at a **segment** count rather than a device count, mitigated
by demand-driven resolution, residual *"whole-estate export is a slow operation and must look like
one"*. `44` cannot write that row without §11.6's census, and this document cannot write it into `44`.

**Determinism** (invariant 9; `71` X4.1): the frontier is a sorted structure keyed by `NodeId`;
candidates are ordered by `(hop_count, lexicographic sequence of NodeIds)`. That is `11` §7.4's own
device — *"the endpoint with the lexicographically smaller `NodeId` becomes `from`"* — applied to a
sequence instead of a pair.

```rust
pub enum Resolution {
    Resolved        { hops: u8 },                    // exactly one candidate
    Ambiguous       { candidates: u8, more: bool },  // 2..=4, possibly more
    Unresolved,                                      // search completed, found nothing
    BudgetExhausted { bound: Bound },                // Hops | Visits
    Contradicted    { reason: ContradictionReason }, // the graph says something incompatible
    OutOfScope,                                      // kind == Boundary. A complete answer
}
```

**Confidence is `Heuristic`, never `Derived`, even at one candidate.** The step relation treats every
device as fully L2-transparent: it does not read VLANs, bridge domains, admin state or policy. A path
it finds is a claim that the device forwards, and per `11` §8.3 that is *"a guess with a stated basis
that could be wrong."* Per `11` §9.5 constraint 4, `Heuristic` output never reaches emit unaccepted —
which costs nothing here, because nothing in this layer emits, and which matters because an engineer
dispatched along an inferred path is the failure this label prevents.

`Contradicted` is distinguished from `Unresolved` and is a **finding**, not an `Unprovable`: a
`Physical` segment whose two ports have no cable between them, a named port that no longer exists, or
a resolution that cannot include a `MustTraverse` target is a positive statement that the record is
wrong. `Unresolved` is a statement that we could not look.

### 6.7 Ambiguity: constrain, never freeze

`77` §5.4 asks what happens when two paths exist and guesses *"the corpus's habit would be to show
both and say so."* The habit is real and it is **three-part**; the missing third part is the one that
matters.

| Source | What it says |
|---|---|
| `11` §5.4 | `Field::Conflicted` *"renders as both values side by side with their provenance… never auto-resolved into a value the user did not choose"* |
| `11` §10.4 step 3 | match only *"if the bucket is unambiguous (exactly one candidate)"* |
| ADR-0010 | *"a rename produces a candidate, never a binding"* — because the silent-wrong-match failure must be *"structurally impossible rather than threshold-dependent"* |
| `12` §8.3–8.4 | `Unprovable` is *"a third thing, with its own store, its own count, and its own surface"*, and *"'No findings' and 'no findings, and 14 things I could not look at' must never render the same"* |

So: **(a) show every candidate, (b) bind none, (c) count the undecided state on a dedicated surface.**
Without (c) an estate accumulates silent ambiguity.

**DECISION — an ambiguous warp stays collapsed, states its candidate count on the mark, expands into a
*chooser* rather than into a picture, and offers one primary action. That action is CONSTRAIN, not
SPLIT.**

> Choosing the Hub B candidate writes one `MustTraverse → Device(HUB-B)` edge: one `Op::AddEdge`, one
> undo step, `Origin::Hand` — the same contract as `56` §6.4.1's cabling gesture. **It does not write
> the hops.**

This is the load-bearing detail. Splitting the segment into A⇝B and B⇝C would record the intermediate
*ports*, and the moment Hub B is recabled internally the record is wrong. Constraining records only
*"it goes through Hub B"*, so Hub B's interlinks are still resolved lazily and still gain new
equipment — which is precisely the property `77` §5.2 calls *"the difference between this and every
hand-maintained circuit record that goes stale the day the network changes."*

`split` remains available as a secondary action, labelled as freezing, for the case where the ports
genuinely are the fact worth recording.

### 6.8 The presentation contract, and why the warp is not an instance of aggregation

`77` §5.3 recommends treating the warp as an instance of `59` §3's aggregation transform. **Half of
that recommendation is right and taking it whole would be a mistake.**

**What genuinely matches** — most of the visible behaviour. Both are a transform on the model run
before layout (`59` §3.1); both collapse to a mark that must state what it hides (`59` §3.6); both
expand on activation under the `role="button"` + `aria-expanded` + `aria-controls` disclosure contract
with the count in the accessible name (`59` §3.8); both report their state in the view band via G10
(`59` §3.9); both are bound by *never drop anything silently* (`59` §3.10).

**Four places it breaks, and none is cosmetic:**

| # | Aggregation | Warp |
|---|---|---|
| **B1** | Expansion **cannot fail**. All forty spokes are in the graph | Expansion **usually fails**, and failing is the feature `77` §5.1 asks for by name: *"Otherwise it'll give a basic, out of scope error"* |
| **B2** | Fires on **cardinality**, at six, and `59` §3.2 is explicit that six *"is a constant, not a control"* | Fires on a **human assertion**. There is no count, no threshold, and nothing a measurement could set |
| **B3** | The mark states a **cardinal**, and `59` §3.6 makes it *"the one label in the picture that may not be demoted"* | An unresolved warp **cannot state how many**. That is its entire content. It states a **predicate** |
| **B4** | Exists only in the drawn tree; no inventory row, no finding anchor, nothing in an export | Is a `PathSegment` node carrying a CID's route: an inventory row, a finding anchor, an export record, a merge participant |

> **DECISION — the warp is not an instance of the aggregation transform. It is a second producer for
> the same collapse-and-disclose presentation contract, which is the part of `59` §3 that
> generalises.**

Concretely, factor `59` §3 into the two things it currently conflates, changing neither decision:

- **The aggregation transform** — `59` §3.1–3.4, six, like-kind siblings, sibling count only — stays
  exactly as decided, warp-free. The passive-split fan-out (§6.5) is an aggregation instance and needs
  no change at all.
- **The disclosure contract** — `59` §3.5–3.10 — is lifted into a named contract that both producers
  implement.

**The product gains one new transform and zero new presentation vocabularies.** That is strictly
cheaper than `77` §5.3's version, which would force the aggregation transform to grow a failure mode,
a non-cardinal label and a persistence story: three changes to a decided design, to avoid one new
transform.

Two amendments to `59` follow, both small, both written as replacement text:

1. **`59` §3.6** — *"the count label"* becomes *"the disclosure label"*, and the never-demoted rule
   attaches to it whether its content is a cardinal (aggregation) or a predicate (warp). One sentence.
2. **`59` §3.11's heterogeneity guard transfers with full force — to a rule that does not exist yet,
   and that is the honest statement of it.** A path whose segments are `Resolved` over hops 1–3 and
   `Unresolved` at hop 4 is a heterogeneous group and may not collapse to a uniform mark. It is the
   same failure mode `59` §8 row 2 calls *"the most dangerous failure in this document."*

   Two things about this amendment are not settled and were previously written as though they were.

   **(a) The guard is unbuilt.** `59` §3.11 is titled *"the rule that is **not built**, and the fixture
   that hides it"*, calls itself *"the single largest gap in all three variants"*, and schedules
   construction as `59` §7 items 1 and 2. §12 failure-mode 6's guard therefore points at machinery
   that does not exist. **The dependency is one-directional and it is on the critical path:** the warp
   cannot inherit a guard that has not been written, so `59` §7 item 2 becomes a **precondition** of
   the warp mark shipping, not a parallel workstream. Until it lands, a partly-resolved path must not
   collapse at all — it draws its segments individually, which is correct, uglier, and cheap because a
   path is six segments and not forty spokes.

   **(b) The attribute set is being extended, and `59` has to accept the extension.** `59` §3.11's
   declared uniformity attributes are *"evidence age band (`56` §8), provenance origin, layer
   membership, and any attribute that changes a node's stroke or adds a second label line."* **Segment
   resolution state is none of those.** It is not an age band, not an origin, not a layer, and whether
   it changes a stroke is exactly the question `59` §3.11 leaves to the fixture it does not have. So
   this is an amendment to the declared set, not an application of it: `62` and `59` must add
   `PathSegment.resolution` to the set, and `59` §3.11's own instruction — *"the attribute set is data,
   in the same register as `56` §3.4's rank table"* — is what makes that a data change rather than a
   redesign. **Stated rather than performed:** §15's reconciliation of `77` §5.3 asserted this transfer
   and did not carry it out, and `59` owns the file.

**It spends no channel.** `56` §5.2's budget is full — G2 is spent product-wide on AI-proposed, G4's
`2 capped` is the tunnel conduit — and a "broken edge" treatment would be an eleventh channel. It does
not need one, because a `PathSegment` is a node and a node box is existing vocabulary.

| State | In-picture label | Activation yields |
|---|---|---|
| `Resolved{3}` | `L2 P2P · 3 hops · inferred` | the hops, with `11` §7.6's hairline and `inferred` tab |
| `Ambiguous{2}` | `L2 P2P · 2 possible paths` | the **chooser**, not a picture |
| `Unresolved` | `L2 P2P · not modelled` | a stated refusal: `no modelled path between LEAF-A ge-0/0/1 and LEAF-C ge-0/0/1 within 8 hops` |
| `BudgetExhausted` | `L2 P2P · search capped at 8 hops` | the refusal, plus the control that raises the budget |
| `Contradicted` | `L2 P2P · conflicts with cabling` | both sides, side by side, `11` §5.4's treatment |
| *no computed resolution* | `L2 P2P · not yet examined` | resolution on demand, then whichever row above applies. Distinct from `Unresolved`, which is a completed search (§6.6) |
| `Boundary` | drawn as its terminal box: `out of scope · customer premises` | **nothing. It is not a disclosure control and carries no `aria-expanded`** |

That last row is load-bearing. **A full stop that can be pressed is indistinguishable from a refusal
that can be pressed**, which is exactly the confusion `77` §5.4 asks to be eliminated.

### 6.9 The worked example, day 1 to day 150

**Day 1.** Hub A and Hub C are modelled. Hub B is not. An engineer records CID `4417`:

- `Tenant` (internal) → `Service { cid: 4417-ELINE-DFW, reach: External }` → `OfType → eline`
- two `ServiceEndpoint`s, `AttachesTo` `HUB-A ge-0/0/1` and `HUB-C ge-0/0/1`
- one `ServicePath { role: Working }`, one `PathSegment { ordinal: 1, kind: Warp,
  warp_technology: L2Ptp }`, `EntersAt` and `ExitsAt` on the two ports

Opening the service asks the resolver, which finds nothing. `Unresolved`. Picture: `L2 P2P · not
modelled`. Findings footer: `1 warp has no modelled path`. **Nothing is stored beyond the endpoints,
the segment kind and the two port references** — the resolution lives in the derived arena and is
recomputed, not saved (§6.6).

**Day 90.** Someone models Hub B and cables it. **No service record is touched.** The mutation batch
invalidates the cached resolution (§6.6); the next time anybody opens the service the resolver runs
over the changed graph and finds
`HUB-A ge-0/0/1 → HUB-B ge-0/0/3 → (device) → HUB-B ge-0/0/4 → HUB-C ge-0/0/1`. `Resolved{3}`. The
mark changes to `L2 P2P · 3 hops · inferred`; activating it draws Hub B and its interlinks with the
`inferred` tab. The `Unprovable` count drops by one. That is `77` §5.1's requirement, met without a
migration, a re-entry or a stored hop.

**Day 120.** A second interlink is cabled, giving two paths. `Ambiguous{2}`. The mark reads
`L2 P2P · 2 possible paths` and **the picture does not pick**. Activating opens the chooser; choosing
writes one `MustTraverse → HUB-B` edge in one undo step. The segment resolves to one candidate again —
and still resolves lazily *inside* Hub B, because the hops were never frozen.

**Day 150.** The customer end is beyond the demarcation. The engineer appends
`PathSegment { ordinal: 2, kind: Boundary, boundary_reason: CustomerPremises }` and points the path's
`PathTo` at an `ExternalPeer` labelled *"Site B customer router"*. The completeness check stops
reporting a gap. Nothing expands. Nothing is counted as unprovable. The picture says
`out of scope · customer premises` and means it.

### 6.10 Confidence without a clock — the source-of-truth obligation, discharged

`77` §16 disagreement 2 is right that *"source of truth and never connecting to anything are in
tension, and the tension is permanent"*, and right that the obligation *"is not yet written down
anywhere"*. Here it is.

**The problem `11` §8.7 creates.** Node age is `max(asserted_at)` over fields whose origin is `Parsed`
or `Imported`, and *"hand-entered and inferred values are not aged — a human assertion does not
decay."* A service path is entirely hand-entered. Under §8.7 it never ages, so a path recorded in 2024
renders identically to one recorded yesterday. For a design tool that rule is right. For an estate
record it is the exact failure `77` §10 names.

**The answer is not to age hand data.** It is to notice that a path has something a config field does
not: *other facts in the same graph that can corroborate it.* Confidence becomes a **graph function,
not a clock function** — which means it needs no `workspace.as_of`, survives `75` §4.4's *"THE PRODUCT
NEEDS NO CONCEPT OF THE CURRENT TIME"* untouched, and adds nothing to the unrouted-wall-clock defect
`75` §4.4 flags as *"the one to guard"*.

Per segment, derived:

| `Corroboration` | Means | Surface |
|---|---|---|
| `Corroborated` | every port the segment names exists, the cabling it implies is present, and the resolution agrees with the assertion | silent |
| `Unwitnessed` | the segment is `Warp` or `Boundary` and nothing in the graph can confirm or deny it | an `Unprovable`, counted |
| `Contradicted` | the graph now says something incompatible | a finding |

And **one asserted field**, `last_confirmed: Date`, `Origin::Hand` only, on `Service`, `ServicePath`
and `Cable`. Rendered exactly as ADR-0027's verification stamp is — muted mono,
`confirmed 2026-05-12 · K. Okafor` — where *"the rendering evaluates nothing"*. Sort-ascending
recovers the useful half of an overdue view, and `75` §4.4 has already blessed that trade: *"it does
not lie when the file is opened eleven months later."*

**The continuous-visibility obligation, discharged in one line of chrome.** The service view's header
always carries, including when every number is zero:

```
CID 4417-ELINE-DFW · 6 segments · 2 unwitnessed · 1 never confirmed
```

That is `12` §8.4 rule 1 applied to the estate rather than to the linter. **It is the only mechanism
that makes the source-of-truth decision survivable: the tool cannot know whether it is current, so it
states continuously and precisely how much of itself has never been corroborated.**

---

## 7. The schema mechanism, and what `62` must contain

*margin tab: the gate*

### 7.1 What is extensible, and what is refused permanently

ADR-0008's negative consequences name the hazard exactly: *"A data-driven schema invites runtime
schema loading, which is a plugin system with better manners."* This document takes the narrowest
possible reading of `77` §3.2's *"defining my own types is a must"*.

| | Extensible by a user? |
|---|---|
| **Node kinds** | **No, permanently.** `NodeId` embeds `NodeKind` (`11` §10.1) and it is `Copy`; `EnumMap<NodeKind, _>` needs a compile-time enum and is the one structure that exists to guarantee deterministic iteration (invariant 9); `emitter_for(kind) -> Option<&dyn KindEmitter>` is exhaustive dispatch; `56` §4.1's projection table and `52` §3.7's column sets are per-kind. And decisively: `11` §11.4 already spends `Kind::Unknown(token)` on **forward compatibility**, so a user kind and a not-understood kind become indistinguishable in an older build and preserve mode collapses |
| **Edge kinds** | **No, permanently.** Same argument; plus rule packs declare `applies_to` against a kind universe the pack lint validates at load (`11` §11.6) |
| **Semantic scalars** | **No, permanently.** A scalar is Rust implementing `11` §4.2's trait with three property-tested laws |
| **Fields on shipped kinds** | **No.** `11` §12.4's registered extension bag already covers vendor-specific fields, with eight rules and a promotion path, and it is not widened here |
| **Service types** | **Yes** — as `ServiceType` nodes under §4.3's closed metamodel |
| **Service and endpoint attributes** | **Yes** — as keys of one declared map field, typed by one closed `AttrType` enum |
| **Naming schemes** | **Yes** — as `Policy` record content under §8.2's closed segment grammar |

**The extensibility surface is values, never types.** That is the whole reconciliation of `77` C1 with
ADR-0008, and it is why this document adds no second schema language and no runtime schema loader.

The alternative that was seriously considered and rejected is recorded in §15 Disagreement 2, because
it is the strongest counter-argument in this design and the next reader should see it.

### 7.2 The metamodel is closed, and here is where the closure is checked

| Question | Answer |
|---|---|
| Can a user add a field to `Service`? | No. They can add an `AttributeDecl` to a `ServiceType`, which adds a **key** to one declared map field |
| Can an attribute have a type the product does not know? | No. `AttrType` is a closed Rust enum. §4.3's mapping table names, per variant, the `11` §4.3 scalar and the `12` §3.5 `Value` it lands on — including the three that need a scalar `11` does not have yet and the two that are not rule-readable |
| Can an attribute be emitted? | No. Nothing in this layer emits, and the grammar has no `emit:` key. That is a stronger guarantee than a prohibition a hurried person can argue with |
| Can an attribute be load-bearing for identity? | No. Identity tuples may not reference attribute keys — the same rule as `11` §12.4 rule 5 |
| Can an attribute hold a secret? | **Not structurally, and this row is weaker than the others.** `SecretPlaceholder` is not an `AttrType` variant, but `11` §12.4 rule 8's stated hazard is `Text`, not `SecretPlaceholder` — *"`Text` is how it would become one"* — and `Text` **is** a variant (§4.3). The control is a `62` §18 declaration-time lint on secret-shaped keys plus a `37` §2.2 verdict, not a type-system guarantee |
| Can a rule read an attribute? | Only with a declared `uses_attr: [key]`, returning `NotApplicable` on an undeclared key (§4.3) |
| Can a service type change path semantics? | **No.** A type declares endpoint cardinality, identifier policy, required attributes and a completeness profile. It declares nothing about segments, warps or resolution — letting a user-defined type invent path modes is `77` C1's failure mode arriving through a side door |

### 7.3 Three mechanisms `62` must add, and two amendments only `11` can make

**(i) Derived fields.** `11` §3.5 already has derived *edges*, rebuilt on load and after every
mutation batch, never serialised. `62` generalises the identical contract to fields: `derived: true`,
a declared `depends_on` read set, a pure function, never serialised, never emitted, readable by rules
and by the inventory column picker. One mechanism pays for four things at once: `PathSegment`'s
`Resolution` and `Corroboration` (§6), `Device.name_conformance` (§8.3), and `PhysicalPort.occupied`.
It satisfies `12` §6.6's soundness argument exactly — *"a pure function of the values read, no side
effects, no ambient state, no clock."*

**(ii) Cross-node write-time constraints.** §4.3's `validated_against: edge(OfType)` clause, and the
`on_violation` vocabulary (`reject_write` = L0, `block_emit` = L2) that `11` §6.7 uses and never
names.

**(iii) Conditional requiredness.** `required_when: "kind == Boundary"` on `boundary_reason`, and
`R*` driven by a value on a *referenced* node (`ServiceType.requires_cid`). `11` §6.2's Emit column
already has `R*` for *"required only on the platforms noted"*; this generalises the predicate from a
platform to an expression over the emit unit.

**Two amendments to `11`, which `62` may transcribe but may not originate.** §9.1 states both at
length; they are listed here because §7.4's §9 row is where an implementer will look for them.

| # | Amendment | Why it cannot be a `62` declaration |
|---|---|---|
| **A1** | `11` §10.4 step 1 gains a positive `layer(kind(n)) == config` conjunct — or `config_path` becomes `Option<ConfigPath>` and the filter requires `.is_some()` before the subset test | The scope filter is an algorithm in `11`, not a per-kind property. Declaring no `config_path` in `62` does not exclude a kind: `∅ ⊆ covered_paths(S)` is true for every `S` |
| **A2** | `11` §10.5's absence table gains an `Origin::Imported` column, valued **nothing happens** under `Section` and `Whole` | The table is `11`'s and it governs kinds far outside this layer. §3.9's catalogue ports are the first `Imported` nodes with a device owner, and they make an existing hole in `11` reachable |
| **A3** | `11` §8.7's staleness bands apply only where `layer == config` (§3.9) | §8.7 ages every `Parsed` or `Imported` node against the current date. Without the carve-out, catalogue ports render differently on two days and §6.10, §10 F4 and §12 row 7 are all false |

**Two scalars are already missing and this makes it visible.** `Bandwidth` and `TzName` are used by
`11` §6.3–6.4 and absent from §4.3's catalogue; `PhysicalPort.speed_max` depends on `Bandwidth`, and
so does `AttrType::Bandwidth` (§4.3). `AttrType::Date` compounds it in the other direction: it maps
onto no existing `11` §4.3 scalar at all — `Timestamp` is a millisecond instant and a `Date` is not —
so `Date` is one of §1.1's five *new* scalars and `62` §3 must define it rather than bind it. Three of
`AttrType`'s eleven variants therefore rest on scalars that do not exist today, and §4.3's mapping
table names each one. This is ADR-0008's own prediction — *"Writing it will reveal that `11` is
incomplete"* — arriving on schedule, alongside `82` §15's `Device.aggregate_device_count`.

### 7.4 What `62-schema-spec.md` must contain

| § | Contents |
|---|---|
| 1 | What this document owns. `11` owns the IR's *design and reasoning*; `62` owns the *file*, its language, its validator and its generated outputs. Discharges ADR-0008. States precedence: `62` wins on form, `11` wins on intent, and a disagreement is a defect in one of them |
| 2 | The YAML subset accepted, key ordering, doc-comment convention, and why the file is ordered (declaration order is diff order, `18` §3) |
| 3 | **Scalars.** `11` §4.3's catalogue as declarations, each binding to a Rust type and the `Scalar` trait; the five new ones in §1.1; the distinction between a `Scalar` and a plain structured value type (§3.5's `PostalAddress`); per-field constraints that live in the schema rather than the type. **The known holes go here:** `Bandwidth`, `TzName`, `PlatformId`, `PolicyAction`, `RouteTarget`, `HostService`, `InferenceRuleId`, `Device.aggregate_device_count` |
| 4 | **Kinds.** Declaration shape; per-field type, cardinality, `Presence` semantics, `emit` column (`R`/`R*`/`O`/`—`); `layer`, `emits`, `derived`, `merge_class`, `case_sensitive`, comparator |
| 5 | **Classes** — named kind sets (`11` §12.1), and why they are not inheritance. Carries the new `PortHost = {Chassis, PassiveNode}` (§3.3) alongside `InterfaceLike` and `MultiMemberInterface` |
| 6 | **Edges.** Role names, `from`/`to` kind sets, cardinality at both ends and **which level enforces each bound**, reverse-index requirement, edge fields, `symmetric`, class, emit template hook |
| 7 | **Enums.** Variants, the neutral name, the generated unknown arm (`11` §11.3), `default_by_platform`, `platform_spellings`. `63` §5.3's platform enum map moves here per ADR-0008 |
| 8 | **Identity.** Ordered tuples per kind, the term grammar (`owner()`, `edge()`, `edge_in()`, field paths), the tier-1 hash ADR-0010 permits as a *recovery* key and nothing else, and the prohibitions (no extension key, no service attribute, no inferred value) |
| 9 | **Matching.** Per-field case-insensitivity — including `Service.cid` and `ServiceEndpoint.uni_id` — per-kind similarity weights, the residue guard constants (0.75 / 0.15 / 4096) as schema data rather than code constants, and **`ImportScope` alongside `CaptureScope`** (§9.3) |
| 10 | **Emission.** `emit` semantics; required-sibling declarations; `DeclaredGap`; the CI check that every `R` field is read by some `KindEmitter::reads()` on every platform claiming the kind, with `emits: false` kinds excluded |
| 11 | **Derived fields and derived edges.** Declaration, read sets, purity, non-serialisation, and the interaction with `12` §6.6's incrementality proof and invariant 9 |
| 12 | **Constraints.** L0 cross-node clauses, `on_violation` vocabulary, conditional requiredness, and which level each is checked at |
| 13 | **Extension surfaces.** `VendorExt` (`11` §12.4) versus `ServiceType.attributes`, with §7.2's closure table and the reasoning for each divergence. And the refusal in §7.1, written normatively |
| 14 | **The platform registry** (`schema/platforms.yaml`), a new `vendors:` block, and `vendor:` as a foreign key into it (§8.2) |
| 15 | **The `Policy` record grammar** (§8.2) — the naming segment roles, the vendor-token map, the load-time rules, and the quarantine behaviour |
| 16 | **Versioning.** `schema_major`/`schema_minor` semantics, `11` §11.3's bump table restated normatively, the content hash, what `Pins` and the manifest record |
| 17 | **Generated artifacts.** The exact list, byte-reproducibility requirements, the pinned generator toolchain, and how it satisfies ADR-0017's reproducibility claim and `35`'s attestation programme without a Node runtime (ADR-0019) |
| 18 | **Validation.** Every schema-lint and policy-lint check with a stable error code; which are build failures and which are load failures |
| 19 | **The statement dictionary content spec** — ADR-0008 property 3 |
| 20 | **Worked examples.** `IkeGateway` end to end (config kind, emits, three identity tiers); `Service` end to end (service kind, emits nothing, attribute-extended); `Terminates` (an edge with fields); the four shipped `ServiceType` declarations; one `Policy` document |
| 21 | Open decisions and Disagreements |

**The milestone that matters.** §§4, 5, 6, 7 and 16 plus the codegen are what the *store* needs.
§§3, 8, 9, 11, 12 are what *this* document needs. §15 is what §8 needs. §19 is the largest section and
the least coupled to anything else, and holding the rest hostage to it is the sequencing error to
avoid.

#### 7.4.1 Which scope `62` is written against, since this document holds two positions

The outline above is the **full** scope: ten kinds, twenty-one edges, the service half included. §15
Disagreement 1 argues against building roughly half of it — ship §3 and §8, defer §4, §6 and the
service half of §9 — on the grounds that the service layer's risk is *"data entry that nobody has
costed"*, and §11.6 supplies the arithmetic that supports the objection (~330,000 nodes at ten
thousand services, against `44` §7.1 row 6's ~20,000-node sweep line and `11` §14.2's 50–80-device
residency ceiling). **Leaving both positions standing and letting `62`'s author pick is the failure
`76` §12 disagreement 1 names — a plan without exits gets one anyway, chosen under pressure.** So:

> **DECISION — `62` is written to the full scope in one pass, and the build is sliced, not the
> specification.**

Three reasons, in the order they bite.

1. **The two halves share the mechanisms, not just the file.** §7.3's three additions — derived
   fields, cross-node write-time constraints, conditional requiredness — are each demanded by both
   halves: `PhysicalPort.occupied` and `Device.name_conformance` need derived fields exactly as
   `PathSegment.Resolution` does; `boundary_reason`'s `required_when` and `Cable`'s
   ownership-conditional completeness are the same clause. Specifying them twice is how they diverge.
2. **`62` §16's version and content hash are per-file.** Landing the service kinds later is a second
   schema bump with a second generated-artifact set and a second migration fixture, for kinds that
   cost the store **zero** (§11.3 row 1). Declaring a kind nothing creates yet is free; adding one to
   a populated schema is not.
3. **§15 Disagreement 1's own exception points the same way.** It insists §3's port/interface
   separation and §3.4's `Cable` promotion must **not** be deferred, because `76` X7 rates it *"low
   today, high after data exists"*. That argument is about **entered data**, not about declared
   schema — and it applies unchanged to `ServiceEndpoint` and `PathSegment`.

**What is sliced is §11.3's core work and §11.4's surfaces, and §15 Disagreement 1's recommendation
stands there in full**: build and ship the physical layer, let the estate be entered, and decide the
service layer's entry cost against a real port census. A declared-but-unbuilt kind costs a row in
`schema.yaml` and a generated enum variant. A half-entered service estate costs `CarriedBy`
under-reporting on *"what breaks if this device is decommissioned"*, which is Disagreement 1's actual
objection and is not addressed by deferring the declaration.

### 7.5 The bump this lands as, and ADR-0030's trigger

Checked against `11` §11.3's table, item by item: ten new node kinds (minor ×10), twenty-one new edge
kinds (minor ×21), two new derived edge kinds plus one existing name re-classed (not serialised, so no
bump), two widened `from`/`to` kind sets (relaxed constraint, minor), one new `ImportFormat` variant
(minor), one new `Origin`-adjacent format token (minor), one new `Cable` field (`assembly`, §3.4;
minor). **Zero new fields on any existing kind. Zero re-parenting, zero field removals, zero
cardinality lower bounds raised, zero identity tuples removed or reordered.**

An earlier draft of this line, and of §1.1's *Kinds amended* row, priced *"two new optional fields on
`Interface`"* and named neither. **The claim is withdrawn rather than filled in**, because nothing in
this document needs an `Interface` field: §3.7 gives `Interface` one out-edge (`Occupies`) and the
hardware facts it might have carried — `position`, `connector`, `speed_max`, `transceiver` — are the
whole reason `PhysicalPort` is a separate kind (§3.1–3.3). Two unnamed fields are precisely the defect
ADR-0008 property 1 exists to stop — *"a field that exists in prose and not in `schema.yaml` does not
exist"* — and §7.4's §4 row requires `62` to carry per-field type, cardinality, `Presence` semantics
and Emit column for every field, which cannot be written from a count.

> **The entire model lands as one minor bump, which old clients preserve.**

`Link`'s supersession is the one item that is not obviously minor, because `11` §11.3 does not price
edge-kind removal. It is handled conservatively (§3.8): the kind is not removed, `Cabled` keeps its
name and its consumers, and the migration converts zero instances because no user workspace exists.
`75` §12.1's line is the reason to take it now: *"no user workspace exists yet. It will never be
cheaper than it is today."*

**ADR-0030's break trigger fires, and the correct response must be written before this lands.** The
trigger reads: *"**zero new node kinds** means the schema generalises… **one to three** means it bends
and the cost is bounded; **more than three, or any new edge *shape*** means it breaks."* Ten kinds is
over three by a factor of three.

**`76` X3 option (a) is the correct response and this design is the evidence for it.** That trigger was
written to measure whether the schema generalises across a second **platform** in one domain. This is a
second **domain**, and a domain adding kinds is additive rather than a falsification of
vendor-neutrality. The decisive evidence is the second half of the trigger: **no new edge shape.**
Every edge added is binary, typed, optionally fielded, exactly like the thirty that exist. That is the
half that actually tests the graph model, and it passes. `76` X3 warns that option (c) — conflate the
axes and let the trigger fire — *"is what happens by default if nobody writes (a) down."*

> **And nobody has written it down, so as of this document's status the contradiction is live.**
> This is not a caveat on the argument; it is a **blocking precondition** and it is recorded as one in
> §13 item 10 rather than only as §12 failure-mode 14. ADR-0030 decision item 3's *"more than three"*
> was written in advance precisely so it would be honoured, and §15 Disagreement 3 refuses to let the
> axis argument absorb the number: *"the trigger's more than three was written to be honoured, and ten
> is not three."* An argument in a design document is not an amendment to an accepted ADR. **Until an
> ADR takes `76` X3 option (a) or (b), the trigger has fired at ten kinds and the correct reading of
> the corpus is that the schema bet is in its `72` §3.5 narrowing branch** — not that this document
> reasoned it out of one. This document cannot discharge that and does not claim to.

---

## 8. Naming policy, and where private per-workspace policy lives

### 8.1 `Policy` — a new record class

`77` §7's naming requirement is small and it reveals a missing concept, which is what `77` C5 says.
The missing concept is **per-workspace private operator policy**: not corpus (invariant 10's
`reviewed_by` ceremony is right for *"PFS is absent"* and wrong for *"our routers start with the state
code"*), not a rule pack (ADR-0028 item 3: first-party only in v1), and not `Settings` (which is
rendering preferences and sync intent).

**DECISION — a new record class, `Policy` (class byte `0x23`), one record, uncompressed, sealed like
every other record.** It joins `17` §4.2's taxonomy next to `Suppressions` `0x20`, `Settings` `0x21`
and `Layout` `0x22`.

```rust
/// RecordKind::Policy (0x23). One record. Small. Uncompressed (17 §5.8).
pub struct LocalPolicy {
    /// Monotonic. Bumped on every committed edit. Appears in the review export
    /// and in every naming finding's witness.
    pub policy_version: u32,
    pub content_hash:   Blake3,

    /// Ordered. First match wins.
    pub naming:         Vec<NamingScheme>,
    /// Vendor id -> the token this operator writes. Keys are schema, not user data.
    pub vendor_tokens:  BTreeMap<VendorId, NameToken>,
    /// 63 §16's overrides documents, rehomed. They have no home in 17 §4.2 today.
    pub rule_overrides: Vec<RuleOverride>,
}
```

Not inside `Settings`, for three reasons stated once each: policy is a **team artefact a reviewer
reads** and settings are a preference; it changes on a different cadence and must be independently
diffable in git (changing your theme must not rewrite the record holding your naming policy); and the
review export must carry policy and must not carry `ai_grants` and sync origins. Uncompressed for
`17` §5.8's stated reason — small, and full of short operator-influenceable strings.

**Rehoming `63` §16's `overrides` is a defect fix, not scope creep.** `63` §16 specifies an overrides
document and `12` §12.6 puts *"workspace-local overrides"* at the top of the precedence chain, and
`17` §4.2's taxonomy has no class for them. They are the second tenant of exactly this concept —
operator-authored, unsigned, workspace-scoped, engine-consumed — and giving that concept one home is
the point.

**Editing** is a form, not a text editor: the grammar is closed precisely so a form is possible.
**Round-tripping**: `fathom policy show` writes the canonical YAML, `fathom policy set` reads it back.
That gives the workflow an operator actually wants — reviewed in a PR, copied into forty workspaces —
with zero new trust machinery, because a file the user wrote and carried themselves is not corpus.
**Versioning**: `policy_version` is a claim and `content_hash` is a fact, per `17` §8.1's own
reasoning. **Merging**: no CRDT. `fathom merge --resolve` (`17` §12.4) resolves per-scheme on
`scheme_id`, then per-field through `11` §8.6's ladder. Two people editing different schemes merge;
two editing one scheme conflict and a human picks.

**Invariant 9 needs no amendment.** Its tuple is *same workspace + same corpus version + same build*,
and policy is inside the workspace.

### 8.2 The scheme grammar

```yaml
# fathom policy show
policy_version: 7
naming:
  - id: external-access                  # operator-chosen, STABLE, cited by every finding
    label: "External access equipment"
    enforcement: enforced                # off | advisory | enforced   (§8.4)
    adopted_on: 2026-08-14               # stored, rendered, NEVER evaluated (75 §3.8)
    applies_to:
      kind: Device
      field: hostname
      match:                             # closed conjunctive terms, ANDed. Not fex
        - { path: Device.role, op: in, value: [Router, Switch] }
    segments:
      - { id: st,   role: field,     path: "site.premises.region", width: 2, case: upper }
      - { id: clli, role: field,     path: "site.premises.clli", take: prefix(8), case: upper }
      - { id: type, role: vendor,    case: upper }
      - { id: inc,  role: increment, style: alpha_when_shared, width: 2, scope: premises }
vendor_tokens: { calix: CLX, nokia: NOK, adtran: ADT }
```

**DECISION — the segment role vocabulary is closed, engine-owned and five values wide. No
user-authored regex anywhere.**

| Role | Reads | Forwards (generate) | Backwards (validate) |
|---|---|---|---|
| `literal` | nothing | the text | exact match |
| `field { path, take }` | one field path from `62`'s `naming_eligible` allow-list, ≤3 hops from the anchor | the canonical token, optionally a prefix | must equal the graph's value |
| `vendor` | `Device.platform` → `platforms.yaml`'s `vendor:` → `vendor_tokens`; **or** `Chassis.model` → the hardware catalogue → `vendor` (§3.9) | the token | must be a declared token **and** must be this device's vendor's token |
| `increment { style, width, scope }` | the sibling set in scope | the lowest free value | legal, and consistent with the sibling set |
| `free { charset, min, max }` | nothing | **cannot generate** | charset and length only |

Every segment also carries `case ∈ {upper, lower, as_written}`, `optional: bool` and a stable `id`
cited in the finding's witness. Separators are `literal` segments — no second concept.

**A regex was rejected for four reasons and the fourth is decisive:** it cannot express the derived
increment at all; it is uncheckable as untrusted input compiled at workspace load (`12` §3.7 requires
regex literals *"compiled at pack build"*, and a scheme is not known until workspace open); it is
unreadable to whoever maintains the scheme in three years; and **it cannot be run forwards**, so it
gives you a validator and never a generator. `76` §4.4 is right that generating names is strictly
cheaper and strictly more correct, because **a name Fathom produced cannot be non-conforming**.

**`{TYPE}` = vendor, and the enumeration comes from somewhere real.** `63` §5.1's
`schema/platforms.yaml` already declares a `vendor:` attribute per platform that `76` §4.4 records
*nothing reads*. `62` gains a `vendors:` block; `platforms.yaml`'s `vendor:` becomes a foreign key into
it; **vendor ids are schema** (a vendor list two workspaces disagree about makes `Device.platform`
unreadable) and **token spellings are policy** (`NOK` versus `NOKIA` genuinely is per-operator). This
also buys the check `76` X11 identifies as stronger than either half alone: a device *named*
`…CALIX02` that carries `junos-srx` is caught, because `vendor` resolves through the registry rather
than pattern-matching the string.

**`{ST}` is not resolved here.** `77` §13 names *"the `<!-- VERIFY -->` markers get silently resolved
by a later reader guessing"* as a failure mode and it applies to me. `Premises.region` is the
placeholder and the `field` role serves either reading. §10 F2.

**Why this cannot be a `fex` rule.** `matches(s, /re/)` returns `bool`; `12` §3.4 removes string
concatenation deliberately; there is no `substr` and no capture accessor. So a condition cannot
decompose `{ST}{CLLI}{TYPE}{Incremental}` into segments nor construct the expected name to compare.
**The most obvious implementation is grammatically absent from the condition language, and adding it
would mean adding string decomposition to `fex` — which `12` §5.3 says must never ship, because
computed field access makes read-set extraction non-total and the incremental engine unsound.**

**DECISION — four new builtins in `12` §3.7's closed table, no grammar change, no lattice change, no
new value type.**

| Builtin | Signature | Meaning |
|---|---|---|
| `name_check_applies(f, class)` | `field, str → bool` | a scheme selects `(node, field)` **and** its `enforcement` enables `class ∈ {selected, shape, derived, increment}` |
| `name_shape_conforms(f)` | `field → bool` | the value tokenises against the selected scheme's segment list |
| `name_derived_conflicts(f)` | `field → bool` | a segment parsed out of the name disagrees with the value the graph derives for it |
| `name_increment_duplicate(f)` | `field → bool` | another node in the increment scope claims the same increment value |

All four return `bool`; nothing is added to `Value`; `12` §3.4's absent features stay absent. Per `12`
§3.7, adding a builtin is an engine release rather than a pack release — correct here, because these
are first-party engine capabilities and not authoring surface.

**Read-set extraction stays total, and this is the load-bearing paragraph.** The *static* read set is
the union over the closed role vocabulary — a fixed, small, knowable set — plus one new
`DepKey::Workspace(WsConstId::NamingPolicy)`. The *exact* read set is recorded by construction,
because the scheme evaluator runs inside `EvalCtx` and performs every graph read through the same
recording path a `LOAD_FIELD` opcode uses. It is not a side channel. `12` §6.6's short-circuit
soundness argument is unchanged: the evaluator reads a scheme and a graph, and nothing else.

The static over-approximation exceeds the 2× bound, so **the four naming builtins are exempted from
`12` §15.3 gate 6 — read-set tightness, `|static| ≤ 2 × max(|actual|)` — and the exemption is written
into the gate rather than discovered as a CI failure.**

> **Gate 6, not gate 5, and the distinction is not pedantry.** `12` §15.3's gate **5a** is *"**Read-set
> soundness.** Instrumented evaluator records actual reads; assert `actual ⊆ static` on every
> fixture"*; gate **5b** is the phantom-dependency pair; the 2× bound is gate **6**. **5a and 5b apply
> to these builtins unchanged and must never be relaxed** — `12` §5.3 calls read-set soundness *"the
> invariant the whole incremental engine rests on"* and §5.3's own gloss on an unsound read-set is
> silent staleness. Exempting a rule from 5a would buy nothing here and would forfeit that. What makes
> 5a *satisfiable* for a builtin whose static set is deliberately loose is the recording path named in
> the paragraph above: every read the evaluator performs is recorded, so `actual ⊆ static` holds by
> construction and the over-approximation costs re-evaluation frequency, which is gate 6's subject,
> and nothing else.
>
> An earlier draft of this paragraph named gate 5, following `12` §5.4's own cross-reference — which
> reads *"(§15.3, gate 5)"* and points at the wrong gate. **That is a defect in `12` §5.4 and it is
> raised as one**, not silently worked around: §5.4's parenthetical should read *gate 6*. It is
> recorded here because propagating a sibling's numbering error into an engineering instruction is how
> a soundness gate gets switched off by someone who trusted the citation.

Editing a scheme fires one `Change::WorkspaceConst`; `ReadBy[Workspace(NamingPolicy)]` names every
live instance; the estate re-checks in Tier B. `12` §6.3–6.4 already implement this and nothing is
added.

### 8.3 The increment is a graph fact, not a pattern

`77` §7's second property, and the reason this is not a regex:

```
style: alpha_when_shared
scope: premises
```

Let `n` be the count of nodes in scope that this scheme selects, excluding tombstoned nodes
(`11` §10.5). Then `n == 1` requires the **numeric** form and `n > 1` requires a **letter**. So `…A`
where no second unit exists is rejected, and a correct `…B` is accepted. That is exactly the pair
`77` §7 names, and no pattern match produces it.

**`scope` is an enum with two values, `Premises` and `Site`, defaulting to `Premises`.** `77` §7's own
words are *"multiple per address"*, and §3.5 makes an address a node precisely so this query is a
reverse-edge count rather than a scan over prose. `Site` is retained for an operator whose sites and
addresses are one-to-one and who prefers the operational grouping.

**The check is uniqueness and legality, never density. Gaps do not fire anything.** A gap is what a
decommission leaves behind, and a tool that demands you renumber the estate every time you remove a
unit is a tool that gets switched off.

**Invalidation already works, and `12` §6.5 named it.** Instance
`(naming.increment.duplicate, device_1)` reads `DepKey::Adjacency(premises, AtPremises, In)` — the
*set*, not its members. Adding a second device at that premises invalidates that key, which `ReadBy`
maps to every device there; all of them re-evaluate and the ones whose letter is now wrong light up.
This is `12` §6.5's phantom-dependency case verbatim, and its own `RECOMMENDATION — write the
phantom-dependency test first` applies directly.

Cost: at a premises with `k` devices, adding one costs `k` re-evaluations of `O(k)` each — 144 cheap
predicate evaluations at a twelve-unit address, in Tier B. Above `k = 256` the evaluator returns
`Unprovable(IncrementScopeTooLarge)` rather than degrading; a premises with 256 devices is a data
centre and the letter convention is meaningless there.

**Name conformance is a derived field**, `Device.name_conformance: enum {Conforming, NonConforming(reason),
Unevaluable}`, with a declared `depends_on` including the traversal to `Premises`. That keeps `12`
§3.7's closed builtin table closed for the *conformance* question and means a naming-policy change
needs no engine release.

### 8.4 Day one on an inherited estate

Mass findings on day one is the answer that gets the feature switched off. Five mechanisms, four of
them existing machinery.

**(a) `enforcement` is three-position, and a new scheme defaults to `off`.**

| Value | `shape` | `derived` | `increment` | generator |
|---|---|---|---|---|
| `off` | — | — | — | **active** |
| `advisory` | — | fires | fires | active |
| `enforced` | fires | fires | fires | active |

`advisory` is not a volume knob. It fires the two checks that mean **the graph is wrong** — a name
asserting a vendor or an increment the estate contradicts — and silences the one that means **the
estate is old**. That is the split an operator actually wants, and it means a scheme is useful the day
it is written, before a single device is renamed.

**(b) The editor will not let you switch it on blind.** Before `enforcement` may leave `off`, the
editor shows how many nodes the scheme selects, how many conform, and a sample of ten that do not.
`76` §7.3 already names *"how many of those names actually conform"* as the honest measure of whether
this is a validator or a generator; this puts that number in front of the person taking the decision,
at the moment they take it.

**(c) A one-time baseline, using the existing suppression machinery.** On the transition out of `off`,
one action: `Baseline (n non-conforming names)`. It writes `n` suppressions with `Scope::Node`,
`RuleSelector::Prefix("naming.")`, one reason typed once, and — the one addition — a shared
`batch: Option<BatchId>` on `12` §11.1's `Suppression`. Without `batch`, 400 identical rows destroy the
artefact `12` §11.5 says a security reviewer reads; with it, the panel and the review export render one
expandable row. It is small, general, and any future bulk waiver needs it.

**`12` §11.3's expiry ladder does the right thing unchanged.** `low` is optional-expiry; `medium` is
mandatory 90 days. So a baseline **permanently** silences *"your old names have the wrong shape"*
(`low`) and **temporarily** silences *"your name asserts something false"* (`medium`), which returns
in 90 days as a real defect. That falls out of existing policy and is exactly what you would design
fresh.

**The baseline is offered once and never again.** A device added afterwards that violates the scheme
produces a live finding. That is the property that makes the feature worth having: it stops the
bleeding without demanding you fix the past, and the non-conforming population shrinks monotonically.

**(d) A date-based grandfather clause was considered and is rejected.** *"Exempt anything created
before `adopted_on`"* reads well and is wrong: `11` §10.4 step 7 writes a new `ProvenanceRecord` on
every re-parse **even when the value is unchanged** — that is how *"still true as of today"* is
recorded — so a date-based exemption would silently expire the first time somebody pasted a config.
`adopted_on` stays a stored, rendered, never-evaluated value.

**(e) The generator closes the loop.** `56` §6.4.1 already validates a new interface name against the
platform grammar **and** `Chassis.slots` at creation — grammar plus a graph fact, which `76` §4.4
correctly identifies as *"the exact interaction shape R4 wants, on a different object"*. The same
disclosure, for a new `Device`, pre-fills a scheme-generated name with the increment resolved from the
premises' current population.

**Compilation and quarantine.** Policy compiles at workspace load. A scheme naming a field path that
is not `naming_eligible`, or a `vendor` segment with a vendor present in the estate and no token
declared, **quarantines that scheme** — never the whole policy — and it appears in `12` §8.4's
*"could not evaluate"* band with the reason and the path named. `12` §14.3's principle applies
unchanged: from the user's position a rule that could not run and a scheme that could not compile are
the same thing.

### 8.5 Invariant 7 is confirmed, and the dangerous inversion is refused

Three checks, all passed:

1. **The scheme never becomes identity.** `11` §10.3's tuples are untouched. Nothing in `Policy`
   participates in re-identification, in `11` §10.4's algorithm, or in ADR-0010's recovery path. A
   scheme *checks* a field; it does not *define* a node.
2. **Renaming invalidates nothing beyond the rename.** A rename is a `FieldSet` delta. It invalidates
   the naming instances on that device and, through the adjacency key, its siblings at the premises.
   Everything in `11` §10.6's survival table is untouched. `FormerName` is populated as normal.
3. **The inversion, refused explicitly.** The temptation is to make the generator authoritative — *the
   name is derived from the graph, so recompute it when the graph changes.* That would rename a device
   when somebody corrects its premises' CLLI, which is the tool editing the operator's system of
   record behind their back. **DECISION — the generator proposes at creation time only and never
   rewrites an existing value.** After creation the name and the graph may diverge, and the divergence
   is a *finding*. A validator observes, a generator proposes, and neither asserts.

One honest cost, and it is ADR-0010's rather than new: `FindingKey.anchor_nk` for a `Device` derives
from `hostname`, so a suppression on a naming finding is keyed on the name that is wrong. Renaming to
fix it orphans the suppression — correct, the finding is gone. Renaming for any other reason also
orphans it, and the user gets ADR-0010's confirmation prompt. Already priced, in ADR-0010's negative
consequences.

---

## 9. Re-parse, merge and survival

*margin tab: this is ADR-0010's problem again*

### 9.1 Re-identification must be made unable to reach these kinds — two amendments to `11`

`11` §10.4 step 1 scopes re-identification:

```
Gs := { n ∈ G : owner_device(n) = D ∧ config_path(kind(n)) ⊆ covered_paths(S) }
```

**As written, this does not exclude `PhysicalPort`, and the failure is silent and total.** The
reasoning that says it does — *these kinds declare no `config_path`, so no capture's covered paths
contain them* — reads the subset relation backwards. `config_path(kind(n))` for a kind that declares
none is `∅`, and `∅ ⊆ covered_paths(S)` is **true for every `S`**. An empty config path universally
admits; it does not exclude.

Nine of the ten kinds are excluded anyway, and it is worth being precise about *which* conjunct does
it, because the ninth is not the one the argument names:

| Kind | `owner_device(n)` | Excluded by |
|---|---|---|
| `Cable`, `Premises`, `Tenant`, `ServiceType` | none — root-owned (§5.1, §5.2) | conjunct 1 |
| `PassiveNode` | none — contained by `Premises` | conjunct 1 |
| `Service`, `ServiceEndpoint`, `ServicePath`, `PathSegment` | none — under `Tenant`, under root | conjunct 1 |
| **`PhysicalPort`** | **`D`, when contained by a `Chassis`** (§5.1 `HasPort`; `11` §7.2 contains `Chassis` by `Device`) | **nothing** |

Follow it through. A whole-device paste puts every port on that device into `Gs`. Step 2 buckets by
kind. `P` contains zero `PhysicalPort`s, because R-L2 forbids a parser creating one. Steps 3 and 4
match nothing, because there is nothing to match against. Step 6 sends every one of them to `11`
§10.5, which under `CaptureScope::Whole` **tombstones** them. §9.2's table row claiming the cable is
untouched because *"it hangs off the `PhysicalPort`, which was never parsed and never re-identified"*
would then be false: after one paste every port on the device carries `absent_since`, and the argument
for §3.1–3.3 collapses with it.

> **AMENDMENT 1 to `11` §10.4 step 1 — scope on `layer`, positively.**
>
> ```
> Gs := { n ∈ G : owner_device(n) = D
>               ∧ layer(kind(n)) == config
>               ∧ config_path(kind(n)) ⊆ covered_paths(S) }
> ```
>
> The new conjunct is a positive test on the §2.2 attribute, so a kind is in scope only if it says it
> is. The equivalent formulation — make `config_path` an `Option<ConfigPath>` and require
> `config_path(kind(n)).is_some()` before the subset test — is accepted as a substitute if `11`
> prefers to keep the filter phrased in config paths. **Set inclusion alone is not, and a schema
> declaration of absence is not self-enforcing.**

> **AMENDMENT 2 to `11` §10.5 — the absence table has no `Origin::Imported` column.** Its two columns
> are `Origin::Parsed` and `Origin::Hand`. §3.9's catalogue-populated ports are
> `Origin::Imported { format: HardwareCatalogue, … }`, so even under the charitable reading of step 1
> their behaviour on absence is **undefined**, not safe. `11` §10.5 must gain a third column, and its
> value under `Section` and `Whole` must be **nothing happens** — the same as `Fragment` — because an
> import is not a closed-world observation of a device and `11` §8.5 already refuses it the authority
> to assert absence. Amendment 1 makes this unreachable for ports; the column is still required,
> because `Origin::Imported` is not confined to this layer.

With both amendments, a re-parse cannot rename, re-bind, tombstone or duplicate a port, a cable, a
premises, a passive node, a tenant, a service, a type, an endpoint, a path or a segment. **The
property is then one declared attribute read by one conjunct**, which is what §2.1's one-graph
decision needs and is cheap — but it is an edit to a published algorithm in a sibling document, and
until `11` carries it this layer is not safe to populate. §13 item 9 tracks it as a precondition.

### 9.2 The anchoring problem, which is exactly ADR-0010's

The service and physical layers are user-attached data. Some of it is anchored to **parsed** elements:
`Occupies → Interface`, `AttachesTo → InterfaceLike`, `EntersAt`/`ExitsAt → InterfaceLike`,
`CarriedBy → Device`. That is the suppression-survival problem in a second costume, and ADR-0010's
machinery transfers essentially verbatim.

**The good case.** Re-identification maps parsed `Interface` p onto existing g. The ULID is preserved,
so every reference edge into g survives automatically and nothing notices. This is the common case and
it is free.

**The hard case, worked, because it is the one this design exists for.** A line card is swapped;
`ge-0/0/0` becomes `xe-0/0/0`; the config is re-parsed.

| | Under `11` §7.3 as written (cabling on `Interface`) | Under this design |
|---|---|---|
| Tier 1 `[owner(Device), name.parsed]` | no match | no match |
| Tier 2 `[owner(Device), name.raw]` | no match | no match |
| Residue (`11` §10.4 step 4) | may decline; ADR-0010 makes any tier>1 match a candidate needing confirmation | same |
| The old `Interface` | tombstoned (`absent_since`) | tombstoned |
| **The cable** | **orphaned onto a tombstoned node** | **untouched — conditional on §9.1 amendment 1.** It hangs off the `PhysicalPort`, which is never parsed; without the amendment the port itself is tombstoned by step 6 and this row reads the same as the left-hand column |
| The `Occupies` edge | n/a | points at the tombstoned `Interface`; `infer.port.occupies` suggests a new one against the new interface's parsed location |
| The service path | orphaned | **untouched if it names ports; degraded to a suggestion if it names interfaces** |

**That table is the argument for §3.1–3.3 in one page.** The separation costs a kind and an edge and
it buys immunity from a configuration event for the estate's most expensive facts.

**What must be added, and it is new.** Per ADR-0010, a tier>1 or residue match produces a **candidate,
never a binding**, and the user is prompted. The prompt must show what is attached:

```
  is this the same port?

  ge-0/0/0                          xe-0/0/0
  parsed 2026-01-14                 parsed 2026-07-29
  ── attached ──────────────────────────────────────────
  1 cable  ODF-A/12                (unaffected either way)
  2 services  4417-ELINE-DFW, 4418-DIA-FTW
  1 path segment
```

`11` §10.4's prompt currently shows *"both sides"* and nothing about dependants. An engineer clicking
through a rename prompt with two services attached is exactly the prompt-fatigue failure ADR-0010's
own negative consequences name. **The attachment count is what makes the prompt worth reading**, and
it is a UI obligation this document creates.

Three findings carry the residue:

| Rule | Fires when |
|---|---|
| `service.attachment.tombstoned` | an `AttachesTo`, `EntersAt` or `ExitsAt` target carries `absent_since` |
| `port.occupies.tombstoned` | an `Occupies` source carries `absent_since`, with the `infer.port.occupies` suggestion attached |
| `service.path.contradicted` | a `Physical` segment's two ports have no cable, or a `MustTraverse` target no longer exists |

### 9.3 Import needs a scope, and capture scope needs a layer test

`11` §10.4 is scoped to *"every re-parse of a config"*. `Premises`, `PhysicalPort`, `Cable`,
`ServiceType` and `Tenant` are never parsed; they arrive by **import** — a site list, a NetBox export,
the hardware catalogue, a service-type declaration file. Their identity tuples are therefore exercised
by import and not by re-parse, and there is no import-side analogue of `CaptureScope`.

> **`62` §9 must declare `ImportScope` alongside `CaptureScope`**, naming which kinds and which
> identity tiers an import may match against, and whether an absence in the imported document is
> `Absent`, `Unknown` or nothing at all. Without it, re-importing a site list duplicates every
> premises, and `11` §8.5's rule on who may assert `Absent` has no answer for an importer.

> **And `62` §9 must restate `CaptureScope` itself**, carrying §9.1's two amendments as schema data
> rather than as prose in this document: the `layer` conjunct in the scope filter, and the
> `Origin::Imported` column in the absence table. `ImportScope` is a new declaration `62` owns
> outright; `CaptureScope` is an existing `11` concept `62` is transcribing, and transcribing it
> unamended is how the defect in §9.1 gets re-introduced by someone reading `62` and not `11`. The
> two requests travel together and neither is sufficient alone.

### 9.4 Merge — `33` §6.4's classes, extended

`33` §6.4 declares the class as *"a property of the field in `schema.yaml`… generated into the Rust
types, so `FieldClass` on a `SetField` op is checked rather than asserted."* Every new field therefore
needs a class. This table is the extension, and it is dormant under ADR-0016 for the CRDT half while
being **live from day one** for the `11` §8.6 half that `fathom merge --resolve` runs (`75` §3.4 makes
that distinction and it is right).

| Class | New members | Concurrent divergence resolves to |
|---|---|---|
| **A — material** | `PathSegment.kind`, `boundary_reason`, `warp_technology`; `Cable.ownership`; `ServiceType.endpoint_cardinality`, `endpoint_identifier_required`, `uni_scope`, `requires_cid`; `Service.reach` | **`Conflicted`.** Never auto-resolved |
| **N — name** | `Service.cid`, `ServiceEndpoint.uni_id`, `PhysicalPort.label`, `Cable.label`, `Premises.clli`, `Tenant.code`, `ServiceType.code` | **`Conflicted`**, both appended to `Node.aka` |
| **B — descriptive** | `label` on kinds where it is not an identity term, `description`, `notes`, `Cable.assembly`, `Cable.length_m`, `Cable.media`, `PhysicalPort.connector`, `PhysicalPort.service`, `Premises.form`, `coordinates`, all `*_on` dates | **LWW** by `(hlc, actor)`; loser in history |
| **C — append-only** | provenance, history, `AttributeDecl` list (append plus `withdrawn`) | **Union** |
| **D — structural** | existence of every new kind; every containment edge; `Terminates`, `Occupies`, `PassThrough`, `AtPremises`, `EntersAt`, `ExitsAt`, `MustTraverse` | **Add-wins**, with the L1 rules in §5.2 reporting over-cardinality |
| **E — set-valued** | `Service.attributes`, `ServiceEndpoint.attributes` | **OR-Set add-wins** |

**One proposed amendment to `33` §6.4, stated as such.** Class A today is described as
*"security-material"*. The new members are not security material; they are **routing-of-record**
material, and `33` §6.3's argument transfers exactly: *"recency is a valid tiebreak only when it
encodes 'I looked at your value and chose differently'. Under concurrency it encodes nothing but clock
skew."* A merged path nobody chose is the one an engineer follows to a site at 03:00. **Proposal:
class A is renamed *decision-material* and its test becomes "a wrong silent merge here sends somebody
somewhere or configures something".** The cost is the same cost `33` §6.3 already accepted: more
conflicts reach humans. The mitigation is the same: it applies to a small set, and a `Conflicted` field
is two named values with two named authors, not a merge marker in a text file.

**`ServiceType` deserves more than one extra sentence, because it sits inside a stated exclusion in
`11` and the compensating control is one I have already judged inadequate.**

`11` §6.9 keeps rule packs, suppressions and corpus entries out of the graph with a one-line reason:
they are *"workspace siblings, not graph nodes. Suppressions reference `ElementId`s but are not part
of the graph, **so a graph merge cannot manufacture one**."* A `ServiceType` is a type definition, it
is a graph node, and a graph merge can therefore manufacture one. **That is not an edge case of `11`
§6.9's rule; it is the case the rule was written for.** §15 Disagreement 2 concedes the point in the
counter-design's favour and this table is where the concession has to be operational rather than
rhetorical.

What is actually shipped: `ServiceType`'s vocabulary fields are class A, so a concurrent divergence
becomes `Conflicted` rather than silently merging; nothing is blocked, because nothing emits; and a
finding `servicetype.contested` names both values and every service of that type. **That is weaker
than a merge refusal, it is weaker on purpose, and the weakness is the whole of the trade** — it is
visible instead of impossible, and it costs one declared field set instead of a second schema
language (§15 Disagreement 2's cost argument).

> **The contradiction is live, not resolved, and it gets a written reopen trigger so it is not settled
> by attrition.** Reopen the node-versus-second-document decision if any one of these occurs:
> a merge produces a `ServiceType` neither side authored; `servicetype.contested` fires on a real
> workspace and the finding is judged insufficient by whoever has to act on it; or a second customer
> appears for a workspace-local vocabulary document, the absence of which is §15 Disagreement 2's
> stated deciding reason. **`11` §6.9 should carry a one-line exception naming `ServiceType`** — an
> exclusion with an unlisted exception is worse than an exclusion with a listed one, because the next
> reader applies the rule and finds the graph already breaks it.

### 9.5 Suppression survival

`FindingKey.anchor_nk` derives from the tier-1 identity tuple (ADR-0010). For the new kinds that means:

| Kind | Tier-1 tuple | A suppression on a finding here is keyed on |
|---|---|---|
| `Service` | `[owner(Tenant), cid]` | the CID |
| `ServiceEndpoint` | `[owner(Service), uni_id]` | the UNI ID |
| `PhysicalPort` (on a `Chassis` or an ODF) | `[owner(PortHost), position]` | a physical coordinate — **stable** |
| `PhysicalPort` (on a splitter, panel or handhole) | tier 1 unusable; tier 2 `[owner(PortHost), label]` | the silkscreen or the tag — **a candidate, not a binding** (ADR-0010). Re-labelling costs a prompt |
| `Cable` (two-ended) | `[edge(Terminates:A), edge(Terminates:B)]` | the port pair — **stable** |
| `Cable` (one-ended or planned) | tier 1 unusable; tier 2 `[label]` | the per-cable tag. `Absent` where no tag was recorded, in which case **there is no recovery key** (§3.4) |
| `Premises` | `[clli]` | the CLLI |

Ports and cables get the good outcome by construction, because their tier-1 tuples are physical.
Services and endpoints inherit ADR-0010's stated cost verbatim: correcting a CID orphans the
suppressions on that service's findings, and the user gets the confirmation prompt. `fsck --repair`
re-binds where exactly one node matches, which `17` §16.2 already implements.

**Declaring identity tuples for all ten kinds is therefore not optional** even though re-parse never
uses them: they are what `fsck --repair` reads. That is the narrowed reading ADR-0010 registered — the
tier-1 hash is a **recovery** key and nothing else.

---

## 10. What the owner must decide

Four forks. Everything else in this document is decided.

### F1 — Are subscriber endpoints modelled, and at what depth?

This is the node-count question, and it decides whether the physical layer is thousands of nodes or
hundreds of thousands.

| | Option | Cost per endpoint |
|---|---|---|
| a | **Enterprise and business only.** The ONT/NID at a customer site is a `Device` with a `Chassis` and ports, contained by a `Site` at a `Premises` | ~3 nodes plus ports |
| b | **Include residential as terminals.** The subscriber endpoint is an `ExternalPeer` contained directly by a `Premises`, using the widened `HasExternalPeer` kind set, with no `Site` and no ports | ~2 nodes |
| c | **Include residential, fully modelled.** A `Device`, a `Site`, a `Chassis` and ports per subscriber | 4+ nodes |

> **RECOMMENDATION — (a) for the first build, with (b) as the growth path.** (b) requires **no schema
> change** from (a) — the `HasExternalPeer` widening is already in §5.1 — so choosing (a) now does not
> close (b) later. Do not attempt (c) before `76` Q1 has a number: `44` §7.1's first breakage point is
> ~20 devices unfiltered and its fourth is ~100 with the residual recorded literally as *"Unresolved"*.

**Consequence.** `77` §4 says modelling stops at the customer's primary router, which puts an
operator-owned ONT just *inside* the line rather than outside it — so this is genuinely ambiguous from
what was said. Choosing (c) by default, one subscriber at a time, is how an estate arrives at a
workspace that cannot be opened. Choosing (a) means a residential rollout later needs a decision, not
a migration.

### F2 — What is `{ST}`?

`77` §7 marks it `<!-- VERIFY: state, or site type. Unstated. -->` and only the owner knows.

| | Option |
|---|---|
| a | A state or province code. Binds `Premises.region` (or `Premises.street.region`) |
| b | A site type. Binds `Premises.form` |
| c | Something else, which becomes a new `Premises` field |

> **RECOMMENDATION — confirm rather than let anyone guess.** The naming design is identical under (a)
> and (b) — both fields exist in §3.5 and the `field` role serves either — so this does not block the
> schema. It blocks the first *generated name*.

**Consequence.** A wrong expansion propagates into every generated name, and unpicking it after names
have been generated means renaming equipment in the real world, not just in the schema. This is the
cheapest item here to answer and the most expensive to get wrong.

### F3 — What are Voice and LTE, structurally? And is LTE a service type at all?

| | Option |
|---|---|
| a | Both are `ServiceType`s with stated endpoint cardinalities and attribute sets |
| b | **LTE is not a type but an endpoint attribute** — `access: Fibre \| Copper \| Lte \| Docsis` — describing how a UNI is reached, which is how backup/failover access is usually modelled. Voice remains a type |
| c | Both are types, shipped later once observed on a real record |

> **RECOMMENDATION — (b) for LTE, (c) for Voice.** `77` §3.1 already flags LTE as possibly *"a
> backup/failover access method rather than a service type"*. The mechanism handles either answer the
> day it is given; guessing now propagates into shipped type declarations.

**Consequence.** If LTE is modelled as a type when it is really an access method, every DIA with LTE
backup becomes two services that must be manually related, and *"which services have a backup path"*
stops being answerable from the graph.

### F4 — Is `03` §4.2 `N-R-2` amended, clarified, or held?

`76` Q3, unanswered, and it is the fork under everything here.

| Route | What it means |
|---|---|
| A — amend via `03` §10.1 | Fathom is the estate record. Say so. `03` §4.2, `03` §11, `01`, `02` §12.3, `52` §3.7 and `31`'s threat model are all rewritten |
| B — clarify along `N-R-2`'s own test | *"No field in the workspace format asserts currency or authority; provenance records how and when a value arrived, never that it is correct now."* Ports, cables, addresses, services and paths are facts with provenance |
| C — hold | Refuses `77` §5, §6 and §7 outright |

> **RECOMMENDATION — route B, with the recommendation's own weakness stated.** **Every field in this
> document passes `N-R-2`'s test as written.** There is no status field, no up/down, no authority
> flag; dates are stored and never evaluated (which is why §3.9 declines `11` §8.7's staleness bands
> rather than inheriting them — an earlier draft took them, and taking them makes this sentence
> false); occupancy is derived from a cable; and §6.10's corroboration model is a graph function
> rather than a claim of currency. Route A is only needed if the owner wants the *product* to say it
> is authoritative, which is a positioning change this design does not require.
>
> **But the recommendation is contested from inside this document and the owner should read the
> objection before taking it.** §15 Disagreement 4 argues that a product printing *"2 unwitnessed · 1
> never confirmed"* in its header is making a claim about its own currency even when the claim is a
> confession, and concludes that §6.10 *"is closer to route A than route B, and calling it route B is
> a convenience I should not be allowed to have unexamined."* I have not resolved that and I do not
> think this document can: it is a positioning question, and `76` §12 disagreement 2's
> **RECOMMENDATION — choose, in writing, at Q3 and Q10, before S2 begins** is where it belongs.
> **This document is written against route B and is not safe to read as evidence for it.**

**Consequence.** Left unanswered, this layer ships while `03` §4.2, `03` §11, `01`, `02` §12.3, `52`
§3.7 and `31`'s threat model all assert the opposite of what the product does — which is `76`'s named
failure mode of *"a drift arrived at three entries at a time"*.

---

## 11. Sizing

Every figure is in `71` §1.3's unit — a person-week is five days of focused work by someone who has
read the specification; solo figures are serial calendar weeks — and **every one is derived by analogy
to a rate stated elsewhere in the corpus, never measured.** None should be quoted without the word
*derived*.

### 11.1 What this sits on top of

Nothing below is buildable before `76` §7.2's S2 (`62-schema-spec.md` + `schema.yaml` + codegen,
3–5 wk) and S3 (`fathom-graph`, 5–7 wk). This document adds to S2 and adds rules to the pass S3
delivers; it does not move either. `76` §9 failure-mode 5 says to treat S2's 3–5 as a floor and this
document is the reason: §7.3 names three mechanisms `11` does not have and two scalars it is missing.

### 11.2 Specification

| Item | Solo weeks |
|---|---|
| `62` §§3, 4, 5, 6, 7, 16 for ten kinds, twenty-one edges, five scalars, ten identity tuple sets | +1.5–2.5 |
| `62` §§11, 12 — derived fields, cross-node constraints, conditional requiredness (§7.3) | +0.5–1 |
| `62` §9 — `ImportScope`, and `CaptureScope` restated with §9.1's two amendments (§9.3) | +0.3 |
| `62` §15 — the `Policy` grammar | +0.3–0.5 |
| **`62` total** | **5–8**, against ADR-0008's own 3–5 |

### 11.3 Implementation, on top of S3

| Item | Solo weeks | Note |
|---|---|---|
| Store support for ten kinds and twenty-one edges | **0** | Ordinary kinds over generated types. This is the one-graph decision paying out |
| `trace()`, `port_of()`, the hop cap, `infer.port.cabled-peer` | 0.5–1 | |
| `resolve_warp` — bidirectional bounded search, six outcomes, determinism, `MustTraverse`, invalidation | 1.5–2.5 | Derived by analogy to `71` §4.7's inference-pass line. **This is engineering weeks and is not a runtime budget** — §6.6's fourth bound carries that, and §11.6 is where the two meet |
| Demand-driven resolution: the per-open budget, the derived-arena cache, `ReadBy` invalidation over the resolver's read set (§6.6) | 0.5–1 | Reuses `12` §6.3–6.5 rather than adding a scheduler. Without it, §6.1's recompute-on-load property is `O(S_total × 4096)` per open and unbounded |
| `infer.port.occupies` as a suggestion producer | 0.3 | |
| Attribute validation, the L0 `validated_against` clause, `AttrValue` | 0.5–1 | |
| `by_cid` / `by_uni` indexes, incremental maintenance, two duplicate rules | 0.5 | |
| Corroboration derived value plus three attachment findings | 0.5–1 | |
| `Policy` record class, seal/load/merge path, `fathom policy show\|set` | 1–1.5 | |
| Naming: scheme compiler, four builtins, gate-6 exemption, policy lint, generator | 1.5–2.5 | Gate 5a and 5b unchanged (§8.2) |
| Hardware catalogue: format, loader, populate-from-model action | 0.5 | Entries themselves are D1 content and never finish |
| `Link → Cable` migration with a golden fixture per `11` §11.5 | 0.5 | Converts zero instances today |
| **Core subtotal** | **8–14** | |

### 11.4 Surfaces, on top of S4 and S7

Not designed here, and priced only so the number is not read as a total.

| Item | Solo weeks |
|---|---|
| Port census table, faceplate view, trace surface (fan-out affordance, horizon rendering, breakout disambiguation) — `76` §4.1's conditional *"add 1–2 weeks if unconfigured ports must be enumerable"* becomes unconditional | +1.5–2.5 on S4's 3–5 |
| Service list, service detail (endpoint table, path ladder, warp affordance, chooser) | +2–4 on S4 |
| `ServiceType` editor, built-in seeding, refresh-by-`builtin_id` | +1.5–3 |
| Naming policy editor, enforcement transition, baseline action | +1–1.5 |
| Diagram: four projection rows, the warp mark, the disclosure-contract refactor | +1.5–2.5 **inside** S7's 6–10, not beside it — `59` §7.1 item 3 is already *"port the aggregation into `A-schematic.html`"*, and this changes what that port produces |
| **Surface subtotal** | **7.5–13.5** |

### 11.5 The total, and what it excludes

**Specification 5–8 · core 8–14 · surfaces 7.5–13.5 — roughly 21–36 solo weeks, on top of S3's
5–7 and inside S4's and S7's existing lines for the surface half.**

**Every figure above is engineering time. None of them is a runtime budget**, and the one runtime
number this design actually depends on is §6.6's fourth bound — per-open resolver cost as a function
of segment count. §11.6 supplies the census that makes it alarming; §6.6 supplies the cap. A reader
who takes 1.5–2.5 weeks for `resolve_warp` as evidence that resolution is cheap has read an
implementation estimate as a performance claim, and those are the only two numbers in this document
that can be confused for each other.

Excluded deliberately, because including them would make the number a fiction: the access-domain
corpus (`76` §6.3: 25–35 person-weeks of D1 time, the one resource `71` §15.1 says cannot be
substituted); ingest for an access platform (`76` S6, 14–20 wk); the diagram itself (`76` S7, 6–10 wk);
and scale (`76` S8, explicitly not estimable before `76` Q1 has a number).

### 11.6 The sizing signal that matters more than any of the above

A service with 4 endpoints and 4 paths of 6 segments is **~33 nodes and ~60 edges**. A premises with
a 1:32 split, its ODF and its cabling is **~70 nodes**. Ten thousand services is **~330,000 nodes** —
an order of magnitude past `44` §7.1 row 6's ~20,000-node full-sweep line and far past `11` §14.2's
50–80-device browser residency ceiling.

Those are also the numbers §6.6's fourth bound exists for: ~330,000 nodes is ~240,000 segments, and a
resolver that ran over all of them on every open would put ~10⁹ node visits between the user and their
workspace. Demand-driven resolution is not an optimisation here; it is what makes §6.1's property
affordable above a demo.

> **The service layer is a scale input to `76` X1, not a passenger on it.** `76` S1's estate census
> must be restated as *"how many services, how many endpoints per service, how many hops per path,
> how many premises"* — not only *"how many devices"*. Run in devices alone, X1 gets decided against a
> number two orders of magnitude too small, and X1's reversal cost is R3: rewriting every record.

**The largest risk on these numbers is data entry, not engineering.** A port census is the cost NetBox
is disliked for, and §3.9's catalogue is the mitigation. If the estate's models are not in a catalogue
and cannot be imported (`76` Q4), the honest cost of populating one OLT's faceplate by hand is minutes
per chassis times the chassis count, and that is a number only the owner can produce.

---

## 12. Failure modes

| # | Failure | What it looks like | The guard |
|---|---|---|---|
| 1 | **Somebody caches a warp resolution "for performance"** | A path shows Hub B after Hub B is deleted | `11` §3.5. The derived arena is excluded from the ciphertext; the store must **refuse** to serialise `WarpResolvesVia` and `Cabled`, not merely omit them |
| 2 | **The chooser writes hops instead of a constraint** | Lazy resolution silently dies and the record goes stale on the next internal recable | §6.7. `MustTraverse → Device`, never a hop list. `split` is opt-in and labelled as freezing |
| 3 | **A parser is given permission to create a `PhysicalPort`** "just for the configured ones" | The layers re-fuse; port identity becomes name-derived; cabling is orphaned by a card swap again | R-L2 (§2.3), enforced in the parser-to-graph binding layer and tested by a fixture that pastes a config and asserts zero ports created |
| 4 | **`Boundary` is given an expander** | An out-of-scope terminus and an unresolved warp become indistinguishable, which is the failure `77` §4 warns about | §6.8. `Boundary` carries no `aria-expanded` and is not in the disclosure contract's producer set |
| 5 | **The resolver is trusted** | Somebody is dispatched along a path that crosses a device where the VLAN is not permitted | §6.6. `Confidence::Heuristic`, `11` §7.6's `inferred` treatment, and the label says `inferred` in the picture |
| 6 | **A partly-resolved path collapses to a uniform mark** | Three known hops and one unknown read as "3 hops" | §6.8 amendment 2 — **and the guard it names is not built.** `59` §3.11 calls itself *"the rule that is not built"* and schedules it for `59` §7. Until that lands the interim guard is *do not collapse a path at all*, and `59` §7 item 2 is a precondition of the warp mark, not a parallel track |
| 7 | **`last_confirmed` grows a countdown** | The file renders differently on two days; invariant 9 is gone | §6.10, `75` §4.4. Sort, never compare. The divergence from `54` §14 is deliberate and recorded there |
| 8 | **The search escapes its bounds** | Load time becomes a function of estate size | §6.6. **Four** bounds, all reported. Bounds 1–3 are per segment; the fourth is the per-open budget plus demand-driven resolution, which is the one that stops estate size entering load time at all. `BudgetExhausted` is a visible state, not a silent truncation |
| 8a | **Resolution is made eager again "so the footer count is accurate"** | Every open pays `O(segments × 4096)`; at §11.6's census that is ~10⁹ node visits and the workspace stops opening | §6.6. The footer counts what was examined and says so, per `12` §8.4 rule 1. An accurate total is not worth an unopenable file, and the two are genuinely exclusive here |
| 9 | **Service types are allowed to declare path semantics** | The product acquires a runtime schema through a side door | §7.2's closure table, and a `62` §18 lint |
| 10 | **An `AttributeDecl` is deleted rather than withdrawn** | Stored values with no live declaration are silently dropped on the next write | §4.3. `withdrawn: bool`, and the key is never reused |
| 11 | **The catalogue is allowed to assert `Absent` transceivers** | "The cage is empty" becomes a claim nobody made | §3.3. `11` §8.5 permits `Absent` only from a closed-world parser or an explicit human, and a catalogue is `Origin::Imported` |
| 12 | **`Premises` acquires geocoding "just for the map view"** | Invariant 1 is gone, and the offline build is no longer offline | §3.5. `coordinates` is user-typed only, stated in the schema comment so it is refused in review rather than discovered in a CSP violation |
| 13 | **The naming baseline is offered twice** | The non-conforming population stops shrinking and the feature becomes decoration | §8.4. Once, on the transition out of `off`, and never again |
| 14 | **Nobody writes `76` X3 option (a) down** | ADR-0030's trigger fires at ten kinds and produces `72` §3.5's narrowing on evidence nobody gathered | §7.5. It must be an ADR **before** this lands, not after — **and it does not exist**, so this row is a live precondition (§13.1 item 10) and not a guard |
| 15 | **`Cabled` acquires an inference consumer** | The inference pass becomes two levels deep and order-dependent, and `11` §9.5 constraint 1 is gone | §6.4, §3.8. `Cabled` is presentation and click-through only; the loader rejects an inference rule that reads a derived edge |
| 16 | **A `62` author transcribes `CaptureScope` from `11` unamended** | §9.1's defect is silently re-introduced through the file six subsystems consume | §9.3. The `CaptureScope` restatement travels with the `ImportScope` request and neither is sufficient alone |

---

## 13. Open decisions, and the preconditions

| # | Question | My position | Why it is still open |
|---|---|---|---|
| 1 | Is the hop budget a workspace setting, a per-type default, or a per-segment field? | Workspace setting default 8, per-segment override (§6.6) | `59` §3.2's *"six is a constant, not a control"* argument does not transfer — a legibility threshold changes what two engineers *see*, a hop budget changes only how far the search looks, and exhaustion is a stated state. But the real input is `76` S0's fourth artefact: how many hops a genuine internal L2 P2P actually crosses |
| 2 | Is 16 the right hop cap on `trace()`, and 4096 the right visit guard on `resolve_warp`? | Both are guesses; 4096 is `11` §10.4's guess reused rather than a second invented number | `11` §17 #2 already flags the 4096 as needing measurement. Same measurement, two consumers |
| 3 | May a rule compare a stored service date against `workspace.as_of`? | No, for now | `12` §3.4 already sanctions `workspace.as_of` as a workspace constant, so *"these services have not been confirmed since the last audit"* is buildable and deterministic. But `75` §16 item 4 records that `workspace.as_of` is referenced by four documents and defined by none, and §6.10's corroboration delivers most of the value with no reference date at all |
| 4 | Should a `PathSegment` be able to reference a `Cable` directly, for a leased circuit whose identity is the fact worth recording? | No today; §3.4.2's `Circuit` promotion is the answer when it is needed | The moment a provider demarcation carries the provider's own ID, the segment wants to name it, and `provider_circuit: Text` stops being enough |
| 5 | Is `AttachesTo` at `0..1` right for a UNI delivered over a LAG whose members are on two chassis? | Probably; the endpoint attaches to the `AggregateInterface`, which reaches hardware through its members | Not tested against a real record. `76` S0's input 4 is exactly the fixture that would settle it |
| 6 | Does the per-equipment page need a `PhysicalPort` row for a port with no `Occupies` and no `Terminates`? | Yes — that is the empty cage, and it is the point of the census | It is also `76` Q5, which is unanswered, and the answer decides whether §3.9's catalogue is essential or optional |
| 7 | Is `Corroboration` per segment, per path, or per service? | Per segment, rolled up per path and per service for the header line (§6.10) | Rolling up three states is a max over a partial order and nobody has argued which order |
| 8 | Should the `Internal` tenant be visible in the tenant list, or implicit? | Visible, because *"which services are internal"* is a real filter | An implicit tenant that appears in one view and not another is the kind of asymmetry that costs an afternoon later |

### 13.1 Preconditions — things that must land elsewhere before this does

Distinct from the table above: these are not open *questions*, they are decided things owned by other
files that this document depends on and cannot enact. Each is a blocker, not a caveat.

| # | Precondition | Owner | What breaks without it |
|---|---|---|---|
| 9 | **`11` §10.4 step 1 gains the `layer == config` conjunct; `11` §10.5 gains an `Origin::Imported` column; `11` §8.7's bands are scoped to `layer == config`** (§9.1, §3.9, §7.3 A1–A3) | `11` | One whole-device paste tombstones every port on that device, and §9.2's table — the argument for §3.1–3.3 — becomes false. **The most dangerous of the four, because it fails silently and after data exists** |
| 10 | **An ADR taking `76` X3 option (a) or (b)** (§7.5, §12 row 14, §15 Disagreement 3) | ADR process | ADR-0030's break trigger has fired at ten kinds and stays fired. `76` X3 option (c) — *"what happens by default if nobody writes (a) down"* — produces `72` §3.5's narrowing on evidence nobody gathered |
| 11 | **`59` §7 item 2 — the heterogeneity guard, built** (§6.8 amendment 2, §12 row 6) | `59` | The warp mark has no guard against a partly-resolved path collapsing to a uniform label. Interim: paths do not collapse at all |
| 12 | **`03` §4.2 `N-R-2` answered — F4** (§3.2, §10 F4, §15 Disagreement 4) | `03`, via `76` §12 disagreement 2's *choose in writing at Q3 and Q10* | Sixty decisions here rest on it. This document is written against route B and §15 Disagreement 4 argues §6.10 is closer to route A |

**Two defects in sibling documents, raised rather than worked around:** `12` §5.4's cross-reference
to the 2× read-set bound cites *"§15.3, gate 5"* and the bound is gate 6 (§8.2); and
`MemberOfReth.chassis` is a `NodeId` in an edge-field body, which `11` §3.2 forbids for node fields
and does not address for edge fields (§3.7).

---

## 14. Sources consulted

| Claim | Source |
|---|---|
| The requirements as stated, verbatim; the seven collisions; the deliberate horizon; the warp and its lazy resolution; the E-LAN UNI structure; the naming template; the source-of-truth answer | `docs/70-ops/77-service-model-requirements.md` §§2–16 |
| The correction to C7; the ranked collisions X1–X12; the build order S0–S8; Q1–Q12; the corpus arithmetic; the teaching-versus-record fork and route B's own test | `docs/70-ops/76-scope-expansion-analysis.md` §§1–12 |
| First-class typed edges; the three edge classes; the promotion rule; the derived arena | `docs/10-core/11-ir-schema.md` §§3.2–3.5; ADR-0007 |
| The semantic-scalar rule, the `Scalar` trait and its three laws, the catalogue, `Mtu`'s layer, `SecretPlaceholder`, `StructuredIfName`/`IfLocation` | `docs/10-core/11-ir-schema.md` §§4.1–4.7 |
| Four-state `Presence`; `Default` is a sourced claim; conflict is not a fifth state | `docs/10-core/11-ir-schema.md` §§5.1–5.4 |
| The kind-earning test; `Site`; `Device` as *"the unit that a configuration file is a configuration file of"*; `Chassis.slots`; `ExternalPeer`; `Interface` as a physical port and its `form` enum; the four-way interface split; `Tunnel` as a promoted cross-device node; what is deliberately not a kind | `docs/10-core/11-ir-schema.md` §§6.1–6.9 |
| The edge declaration shape; `from`/`to` as kind sets; the containment forest; the reference table; `Link` as an edge and its direction normalisation; `ZoneMember` as an edge with fields; derived edges and their rendering | `docs/10-core/11-ir-schema.md` §§7.1–7.6 |
| Per-field provenance; the `Origin` variants; three-value `Confidence`; capture blobs; who may assert `Absent`; the merge ladder; the staleness bands and *"hand-entered values are not aged"* | `docs/10-core/11-ir-schema.md` §§8.1–8.7 |
| L0–L3; the emit unit; four-valued rule evaluation and the completeness prompt; the inference pass and its four constraints | `docs/10-core/11-ir-schema.md` §§9.1–9.5 |
| `NodeId` embeds kind; names are ordinary fields; identity tuples; the re-identification algorithm and its 4096 guard; absence is not deletion; what survives a rename | `docs/10-core/11-ir-schema.md` §§10.1–10.6 |
| The bump table; preserve mode and the air-gapped cost; total provenanced migrations; the schema is data | `docs/10-core/11-ir-schema.md` §§11.3–11.6 |
| Classes as named kind sets; the extension bag and its eight rules | `docs/10-core/11-ir-schema.md` §§12.1, 12.4 |
| Size arithmetic and the browser ceiling; the complexity table | `docs/10-core/11-ir-schema.md` §§14.2–14.3 |
| `Link` as an edge versus `Circuit` as a node, left open | `docs/10-core/11-ir-schema.md` §17 #3 |
| `fex`'s grammar and its deliberately absent features; the name environment and *"the selector is the only capability"*; the closed builtin table; dependency keys and the phantom-dependency case; the incrementality proof | `docs/10-core/12-rule-engine.md` §§3.4–3.7, 6.3–6.6 |
| `Unprovable` as a third thing with its own surface; the findings-footer contract and its rule 1 | `docs/10-core/12-rule-engine.md` §§8.3–8.4 |
| `Suppression`, its scopes, the mandatory reason, the expiry ladder, and re-parse survival | `docs/10-core/12-rule-engine.md` §§11.1–11.5 |
| Workspace-local overrides at the top of the precedence chain; quarantine visibility | `docs/10-core/12-rule-engine.md` §§12.6, 14.3 |
| `emitter_for(kind) -> Option<&dyn KindEmitter>` | `docs/10-core/13-emitters-and-provenance.md` §6.2 |
| The diff walks schema declaration order | `docs/10-core/18-diff-verify-rollback.md` §3 |
| The record taxonomy and its class bytes; `Settings`' contents and why they are inside the ciphertext; the compress-small-not-large rule; `fathom merge --resolve` on opened plaintext; `fsck --repair` | `docs/10-core/17-workspace-format.md` §§4.2, 5.8, 8.1, 10.1, 12.3–12.4, 16.2 |
| The merge field classes A/N/B/C/D/E; recency does not resolve a concurrent write; the tombstone-versus-reference rule; add-wins and `merge.set.widened` | `docs/30-security/33-sync-protocol.md` §§6.2–6.10 |
| Free-text description fields as the number-one personal-data channel | `docs/30-security/37-privacy-and-compliance.md` §2.2 |
| No clickable external link, in any surface | `docs/30-security/34-browser-hardening.md` §9.4 |
| The order of breakage in devices; population rules as the second thing that breaks | `docs/40-stack/44-performance-budgets.md` §7.1 |
| The inventory's primary object, its generated column picker and its opinions column; `verify(diff(graph))` as a mode rather than a seventh view; six views fit | `docs/50-design/52-information-architecture.md` §§1.1, 3.7, 3.7.1, 9.5 |
| The projection table; the channel budget and G2/G4/G10; the edge vocabulary; the connect disclosure and its one-op-one-undo contract | `docs/50-design/56-diagram-view.md` §§4.1, 5.2, 5.4, 6.4.1 |
| Aggregation as a transform run before layout; six is a constant not a control; the mark; the affordance contract and the never-demoted label; windowed expansion; the heterogeneity guard | `docs/50-design/59-diagram-aggregation-and-colour.md` §§3.1–3.11 |
| The platform registry and its unread `vendor:` attribute; the platform-versus-vendor distinction; `overrides` documents and what is overridable | `docs/60-content/63-rulepack-spec.md` §§5.1, 16 |
| The person-week unit; D1 as the scarcest and least substitutable resource | `docs/70-ops/71-roadmap.md` §§1.3, 15.1 |
| C-01's four existing state machines; the node-attribute-versus-schema-field fork; the ADR-0010 precedent and how far it carries; the completion-action clarification; the date answer and the `54` §14 divergence; *"it will never be cheaper than it is today"* | `docs/70-ops/75-capability-register.md` §§3.2–3.8, 4.4, 12.1 |
| `N-R-2` and its test, `Reopens if: Never`; `N-R-3` and process state | `docs/00-vision/03-non-goals-and-scope.md` §§4.2–4.3 |
| The schema is a specified artifact; *"a field that exists in prose and not in `schema.yaml` does not exist"*; the runtime-schema hazard; *"writing it will reveal that `11` is incomplete"* | ADR-0008 |
| `11` §10.3–10.4 owns re-identification; a rename produces a candidate, never a binding; the tier-1 hash as a recovery key only; the prompt-fatigue cost | ADR-0010 |
| Fixed hash shards; whole-record rewrite; merging on opened plaintext; `S` fixed at creation | ADR-0013 |
| Git is the sync for v1; CRDT machinery deferred, not deleted | ADR-0016 |
| Rule packs first-party only in v1 | ADR-0028 |
| The break trigger — zero / one-to-three / more-than-three-or-any-new-edge-shape | ADR-0030 item 3 |
| The verification stamp as chrome; *"the rendering evaluates nothing"* | ADR-0027 item 3 |

---

## 15. Disagreements

### 1. This model is too large to build before anything ships, and a smaller first cut serves the owner better

I have designed what was asked for, and I do not think it should all be built at once.

`76` §12 disagreement 1 puts the honest total at closer to four years solo. §11 adds 20–35 solo weeks
on top of S2 and S3, and that is before the access corpus, before ingest, and before the diagram. The
plan `76` §7.2 gives already has exits and nobody has named them.

**The exit I would name is here, and it falls in the middle of this document.** The physical layer
(§3) plus the naming policy (§8) plus `76`'s S4 is a coherent, shippable product: an estate record of
sites, premises, equipment, ports, cables and passive plant, with a per-equipment page, port-to-port
traversal, and a naming scheme that generates conforming names and reports the ones it did not
generate. It answers `77` §6 and §7 in full. It needs **none** of §4, §6 or the service half of §9. It
is roughly a third of §11's number.

The service layer (§4, §6) is the larger and riskier half, and its risk is not engineering. **It is
data entry that nobody has costed.** A DIA with five pieces of equipment is a handful of nodes; ten
thousand services is ~330,000 (§11.6). The engineering is 4–7 weeks of core work; the entry is
unbounded and unmeasured, and a service record that is half-entered is worse than none, because
`CarriedBy` under-reports and *"what breaks if this device is decommissioned"* returns a confidently
short list.

So: **build the physical layer first, ship it, and let the estate be entered.** Then decide whether the
service layer earns its entry cost against a real port census rather than against a design document.
**§7.4.1 records what this does and does not change**: the *build* is sliced this way, and the
*specification* is not — `62` is written to the full scope in one pass, because the two halves share
§7.3's three mechanisms and because a declared-but-unbuilt kind is free where a second schema bump
against a populated file is not. This disagreement is about entered data, and deferring a declaration
does not defer entry.
`76` S0's fourth input — *"one real service record: a CID, its type, its endpoints, and the equipment
and ports it traverses end to end"* — is already on the fit-test list, and three questions should be
added to that walk: how many segments a real service needs, what fraction of them are warps, and how
many of those warps have more than one candidate in the real cabling. If the third number is high, the
chooser (§6.7) is the main feature rather than an edge case and §11.3's estimate is wrong by a factor.
If it is zero, K = 4 candidate enumeration is over-engineering and the resolver drops to a single-path
search.

The one thing that must **not** be deferred is §3's separation of ports from interfaces and §3.4's
promotion of `Cable`. `76` X7 is right that this is *"low today, high after data exists"* and that it
must be settled before any cable is entered. Deferring it means entering cabling against `Link` and
migrating a populated `0..1` edge later, which `11` §11.3 charges a major bump for and `11` §11.4 says
strands air-gapped users.

### 2. The strongest counter-design is a second schema document, and I rejected it on cost rather than on principle

§7.1 refuses user-definable kinds, fields and scalars, and puts service types in the graph. The
serious alternative — and it was seriously considered — is a **second schema document in the same
language**: workspace-local, loaded at runtime, generating no code, permitted to declare attributes on
kinds marked `extensible`, variants of enums marked `open`, service types, and naming schemes.

Its arguments are good and three of them are better than mine.

- **`11` §6.9 keeps rule packs, suppressions and corpus entries out of the graph precisely so that
  *"a graph merge cannot manufacture one"*.** A `ServiceType` node is a type definition a merge can
  manufacture. §9.4 answers this with a class-A field set and a finding, which is weaker than a merge
  refusal and I have said so.
- **A type definition inside an encrypted node shard cannot be diffed in git.** §4.3.2's export/import
  gives sharing, not diffing, and reviewing a type change in a PR is a real workflow the node form does
  not serve.
- **Provenance and `Presence` on a vocabulary decision are close to meaningless.** What is
  `Presence::Default` for *"E-LAN endpoints are 2..512"*? Nothing. The node form pays for machinery it
  cannot use.

I rejected it on **cost and blast radius**, not on principle. A second schema language means a second
grammar, validator, loader, key allocator, tombstone list, merge-refusal path, record class, version
and content hash — and it opens `open: true` and `extensible: true` across the whole schema, which is a
permanent extensibility surface with a security footprint that never closes. The node form costs one
declared map field, one declared list field, one L0 clause and one `fex` accessor: roughly a tenth of
the surface, using machinery `11` already has.

It also mattered that the second document's third customer disappeared. It was going to carry the
lifecycle enum's open *"etc"* as well, and §1.2 defers lifecycle to `75` C-01. With naming rehomed into
`Policy` (§8.1) — which is workspace data in a closed grammar with **no schema-extension powers** — the
vocabulary document is left serving one customer, and one customer does not justify a second schema
language.

**If this is reversed, reverse it before `62` is written, not after.** The two designs share nothing at
the file level.

**The first bullet is a live contradiction with `11` §6.9, not a rhetorical concession, and §9.4 now
carries it as one** — with the exception written into `11` §6.9 rather than left implicit, and with a
three-clause reopen trigger so the decision is not settled by attrition. Shipping the weaker
mechanism while knowing it is weaker is defensible; shipping it while `11` §6.9 still reads as though
nothing in the graph can manufacture a type definition is not.

### 3. Ten kinds fires ADR-0030's trigger by a factor of three, and that should be argued, not absorbed

§7.5 argues that the trigger measures the platform axis and this is the domain axis, which is `76` X3's
option (a) and which I believe is correct. But I want the size stated rather than reasoned past: the
trigger's *"more than three"* was written to be honoured, and ten is not three. The evidence that
carries the argument is not the kind count — it is that **no new edge shape** was needed, and that is
the half of the trigger that actually tests whether the property graph generalises.

`76` X3 warns that option (c) — conflate the axes and let the trigger fire — *"is what happens by
default if nobody writes (a) down."* This document is not an ADR and cannot discharge that. **Write it
before this lands.**

### 4. `03` §4.2 `N-R-2` will be reopened by this document whether or not anyone amends it

§10 F4 recommends route B and I believe route B is defensible on `N-R-2`'s own written test: every
field here is a fact with provenance and none asserts currency. But `77` §10's sentence — *"it's where
the estate lives"* — is an authority claim in plain words, and §6.10 exists precisely because that
claim creates an obligation. A product that puts *"2 unwitnessed · 1 never confirmed"* in a header is a
product making a claim about its own currency, even when the claim is a confession.

I think that is the right design and I think it is honest. I also think it is closer to route A than
route B, and calling it route B is a convenience I should not be allowed to have unexamined. The owner
should read §6.10 and decide whether that header line is a clarification of `N-R-2` or a quiet
amendment of it.

### 5. `13` and `18` are unaffected by this document and that is suspicious enough to check

Ten kinds and twenty-one edges arrive and neither the emitter layer nor the diff needs a line of
change, because `emitter_for` already returns `Option` and the diff already walks
`schema.fields(kind_of(a))` in declaration order. That is either a strong signal that `11`'s shape
generalises, or a signal that I have not looked hard enough. The one place I expect it to be wrong is
the diff: *"attribute withdrawn"* is not *"value changed"*, and rendering it as a field delta across
400 services would be a lie. `18` probably needs one new `DeltaClass`. I have not specified it here
because `18` owns it, and a document that quietly redesigns a sibling's type is the failure mode `76`
§12 disagreement 3 names.
