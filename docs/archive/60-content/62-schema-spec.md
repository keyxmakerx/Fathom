# 62 — The schema

> **Status:** Proposed

Companion documents: `docs/10-core/11-ir-schema.md` (the IR's design and reasoning — what the
kinds, fields and edges *mean*) and `docs/10-core/19-service-and-physical-model.md` §7 (the schema
mechanism, the closed metamodel, and the requirements sheet this document is written against).
`docs/60-content/61-command-corpus-spec.md` and `docs/60-content/63-rulepack-spec.md` are the two
sibling corpus formats; this document sits beside them and specifies the third authored artifact:
**`schema.yaml`, the file the whole product is generated from.** ADR-0008 is discharged here.

The reader this format is written for is different from `61`'s and `63`'s. Their reader is a
network engineer who has never written a parser. This document's reader is the engineer writing
the `schema.yaml` parser, the codegen, and the validator — and, second, the maintainer adding a
kind in month nine who needs to know exactly which declarations, gates and bumps that touches.

> **ADR-0008, property 1, which governs everything below:** *"The schema is data, and the code is
> generated from it. A field that exists in prose and not in `schema.yaml` does not exist."*

---

## 0. Contents

The skeleton is `19` §7.4's contents list, section for section. `19` §7.4 row 21 is a composite
("Open decisions and Disagreements"); it is carried here as four tail sections (§§21–24) per the
house convention that Failure modes and Sources consulted travel with them.

| § | |
|---|---|
| 1 | What this document owns, and precedence |
| 2 | The file — accepted YAML subset, ordering, comments |
| 3 | Scalars — the catalogue as declarations, the five new ones, the known holes |
| 4 | Kinds — the declaration shape |
| 5 | Classes — named kind sets |
| 6 | Edges |
| 7 | Enums |
| 8 | Identity |
| 9 | Matching, `CaptureScope` and `ImportScope` |
| 10 | Emission |
| 11 | Derived fields and derived edges |
| 12 | Constraints |
| 13 | Extension surfaces, and the closed metamodel |
| 14 | The platform registry |
| 15 | The `Policy` record grammar |
| 16 | Versioning |
| 17 | Generated artifacts |
| 18 | Validation — the gates |
| 19 | The statement dictionary content spec |
| 20 | Worked examples |
| 21 | Failure modes |
| 22 | Open decisions |
| 23 | Sources consulted |
| 24 | Disagreements |

**The milestone split, restated from `19` §7.4 so it is not lost.** §§4, 5, 6, 7 and 16 plus the
codegen (§17) are what the *store* needs. §§3, 8, 9, 11 and 12 are what `19`'s layers need. §15 is
what naming (`19` §8) needs. §19 is the largest section and the least coupled to anything else —
holding the rest of this document's implementation hostage to the statement dictionary is the
sequencing error `19` §7.4 names, and it must not happen.

**Scope.** Per `19` §7.4.1's DECISION, this document is written to the **full** scope in one pass —
config, physical and service layers, ten new kinds and twenty-one new edges included. What is
sliced is the build, not the specification.

---

## 1. What this document owns, and precedence

`11` owns the IR's *design and reasoning*: why a field exists, what it means, when a concept earns
a kind (`11` §6.1). `19` owns the same for the physical and service layers. **This document owns
the *file*: its language, its layout, its validator, its version discipline and its generated
outputs.** ADR-0008's decision line says `schema.yaml` is *"a first-class build input owned by
`11-ir-schema.md`"*; `19` §7.4 row 1 says `62` owns the file. The reconciliation, stated once:
**content ownership is `11`'s (and `19`'s for its layers); form ownership is `62`'s.** A kind is
added by editing `11` or `19` *and* `schema.yaml` together; the shape of the edit to `schema.yaml`
is governed here.

> **Precedence:** `62` wins on form, `11` wins on intent, and a disagreement between them is a
> defect in one of them — file it, do not interpret around it. (`19` §7.4 row 1.)

The same rule `61` §1.1 applies to its JSON Schema applies here between this prose and the
validator: the validator is normative for machines, this document for humans, and where they
disagree one of them is a bug and both get fixed.

What this document does **not** own: the rule pack format (`63`), the command corpus (`61`), the
explainer file format (`15`'s design; the file format is a sibling concern flagged by ADR-0008
property 2 and is not folded in here), and the workspace container (`17`). The statement
dictionary's *content spec* is here (§19, ADR-0008 property 3); its runtime — trie, walker,
budgets — stays in `14` §6.

---

## 2. The file — accepted YAML subset, ordering, comments

### 2.1 Layout on disk

```
schema/
├── schema.yaml            # scalars bindings, classes, kinds, edges, derived edges,
│                          #   constraints, emission, matching, scopes, naming_eligible
├── platforms.yaml         # the platform registry and the vendors block (§14)
├── enums/                 # one file per named enum (§7)
│   ├── establish_tunnels.yaml
│   └── ...
└── released/              # checked-in schema.json snapshot per released version (§16.4)
    └── 3.2.json
```

The content hash (§16.3) covers the generated `schema.json`, which is derived from the whole
`schema/` tree, so a change anywhere in the tree changes the hash. The statement dictionary lives
in the corpus (`corpus/dict/`, §19), not under `schema/` — it is authored content validated
*against* the schema, not part of it. The same is true of `corpus/extensions.yaml` (`11` §12.4)
and the shipped service-type declarations (`corpus/service-types/`, §20.4).

### 2.2 The YAML subset

The parser accepts a deliberate subset of YAML 1.2. Everything outside it is a build failure with
a stable error code (§18), not a warning.

| Accepted | Refused |
|---|---|
| Block-style maps and sequences | Anchors (`&`), aliases (`*`), merge keys (`<<`) |
| Flow-style maps/sequences on a single line only | Custom tags (`!`, `!!`) |
| Plain and double-quoted scalars; `|` block scalars for `doc:` | Single-quoted scalars (one quoting style, not two) |
| `true` / `false`, decimal integers, `null` spelled `null` | `yes/no/on/off`, octal, sexagesimal, `~` |
| One document per file | Multi-document streams (`---` separators) |

The subset exists so that the file has exactly one spelling for every construct: `18` §3 makes
declaration order diff order, and a format with two spellings for one value produces diffs that
lie.

### 2.3 Ordering

- **Top-level key order in `schema.yaml` is fixed** and validated: `schema`, `scalars`, `classes`,
  `kinds`, `edges`, `derived_edges`, `constraints`, `emission`, `matching`, `scopes`,
  `naming_eligible`.
- **Declaration order within a block is significant.** It is the diff order (`18` §3), the order
  of generated enum variants, and therefore the deterministic iteration order invariant 9 relies
  on (`EnumMap<NodeKind, _>`, `11` §13's Graph struct and §14's sorted indexes).
- **Order is never load-bearing for the wire format.** Field keys come from the generated
  field-key registry (§17), which is append-only: a field's integer key is assigned once and never
  reused, so reordering declarations changes presentation and generated iteration, not stored
  bytes. New declarations are appended to their block; inserting mid-block is a lint (§18,
  `schema.order.inserted`) because it renumbers nothing but rewrites the diff context for every
  later declaration.

### 2.4 Comments and documentation

`#` comments are for the file's own maintenance and are **not** extracted. Carried documentation
uses the `doc:` key, present on every kind, field, edge, enum and constraint declaration; codegen
copies it verbatim into the generated Rust and TypeScript doc comments and into `schema.json`, so
the UI's column picker and the pack lint's error messages can show it. `doc:` is mandatory on
kinds and edges, optional on fields (a field whose name plus type is self-describing may omit it;
the reviewer decides, not a gate).

---

## 3. Scalars

### 3.1 Three type families, and which this file declares

| Family | What it is | Declared where |
|---|---|---|
| **Semantic scalar** | Rust implementing `11` §4.2's `Scalar` trait — `parse`/`emit`/`canonical`/`validate`, three property-tested laws | In code. `schema.yaml`'s `scalars:` block **binds** a name to a registered implementation; it cannot define one |
| **Plain primitive** | `bool`, `u8`, `u16`, `u32`, `u64`, `i32`, `i64` | Nowhere — usable directly as a field type. Not semantic scalars; no token tables, no `canonical()` beyond the number |
| **Structured value type** | A Rust struct/enum with payload — `PeerSpec`, `Dpd`, `Mtu`, `IkeId`, `PostalAddress`, `AttrValue`, `NameConformance` | In code, bound by name in `scalars:` with `structured: true`. Stored, rendered, diffed; no vendor `parse`/`emit` obligation |

The distinction the third row carries is `19` §7.4 row 3's: `PostalAddress` is not a `Scalar`
because there is no vendor text it round-trips with — it is user-typed structure. A structured
value type still has a canonical serialisation (CBOR, `11` §14.1) and a total order where the UI
sorts it, but it owes no L1/L2 laws.

**Users can define none of these, permanently** (`19` §7.1). A scalar is Rust with property-tested
laws; there is no declaration a user could write that discharges them.

### 3.2 The binding declaration

```yaml
scalars:
  - { name: IpPrefix,         impl: fathom_ir::scalar::IpPrefix }
  - { name: InterfaceAddress, impl: fathom_ir::scalar::InterfaceAddress }
  - { name: Identifier,       impl: fathom_ir::scalar::Identifier }
  # ...one row per 11 §4.3 catalogue entry...
  - { name: PostalAddress,    impl: fathom_ir::value::PostalAddress, structured: true }
```

Codegen fails if a bound `impl` path does not exist or does not implement the required trait
(§18, `schema.scalar.unbound`). The full catalogue is `11` §4.3's, transcribed row for row; the
catalogue's meanings are `11`'s and are not restated here.

**Per-field constraints live in the schema, not the type** (`11` §4.3, `Seconds` row). A field
declaration may carry:

```yaml
constraints:
  range: { min: 180, max: 86400, platforms: ["junos-*"] }   # e.g. Junos IKE/IPsec
                                                            # lifetimes, 11 §4.3
```

A range constraint is checked at write time (L0) when `platforms` is empty, and at emit time (L2,
`block_emit`) when it is platform-scoped — a value legal on one platform and out of range on
another is not a write error, it is an emit blocker on the platform that refuses it.

### 3.3 The five new scalars (`19` §1.1)

These are *defined* here because `19` §7.4 row 3 says `62` §3 must define rather than bind them.
§24 Disagreement 1 argues the definitions should migrate into `11` §4.3's catalogue at that
document's next edit.

| Scalar | Representation | Canonical form | Rules and traps |
|---|---|---|---|
| `Date` | `{ year: u16, month: u8, day: u8 }`, proleptic Gregorian | RFC 3339 `full-date`, `YYYY-MM-DD` | A calendar date, no timezone, no time. **Not** a `Timestamp` (`11` §4.3: a millisecond instant) and never convertible to one implicitly. Totally ordered; sortable; exported. **Never compared against a clock at render** — `75` §3.8's table row 3 is the prohibition, and `75` §4.4 / `19` §13 open decision 3 hold comparison of stored dates at *no, for now* |
| `LatLon` | `{ lat_e7: i32, lon_e7: i32 }` — degrees × 10⁷ | `lat_e7/lon_e7` as signed integers | Fixed-point, ~1 cm resolution, exactly representable, byte-identical across platforms (`19` §4.3). Range-checked on parse (±90°, ±180°). Stored, rendered, exported, **never computed with** — no distance function ships |
| `Clli` | `CompactString`, charset `A–Z0–9` | as written, upper case | Charset and length check only — no registry validation, the workspace is offline. <!-- VERIFY: accepted lengths. The 8-character site prefix and the 11-character full code are the forms `19` §8.2's `take: prefix(8)` assumes; confirm both, and whether 8 alone should be accepted, before this ships --> |
| `PostalAddress` | struct of `Text` lines: `{ lines: [Text], locality: Text?, region: Text?, postcode: Text?, country: Text? }` | CBOR canonical | Structured value type, not a `Scalar` (§3.1). Free text inside — `37` §2.2's personal-data channel applies and the field is in that document's review scope |
| `AttrValue` | tagged union over `AttrType` (§13.2) | per-variant, delegating to the underlying type | The value slot of `Service.attributes` and `ServiceEndpoint.attributes`. Carries its `AttrType` tag in serialisation so a stored value survives its declaration being withdrawn (`19` §4.3) |

### 3.4 The known holes, closed here

`19` §7.4 row 3 names the scalars and the field that are *used* by `11` and absent from its
catalogue. Each is closed below; each is a transcription candidate for `11` (§24 Disagreement 1).

| Hole | Used by | Definition |
|---|---|---|
| `Bandwidth` | `Interface.speed`, `AggregateInterface.link_speed`, `RoutingProtocol.reference_bandwidth` (`11` §6.4–6.5); `AttrType::Bandwidth` (`19` §4.3) | `u64` newtype, **bits per second**. Canonical: the integer. Parse accepts the platform's token table (suffixed forms); emit renders the platform's spelling; both are per-platform tables owned by the scalar impl, exactly as `DhGroup` (`11` §4.3). Never a float — `19` §4.3 deleted `Decimal` for exactly this reason |
| `TzName` | `Site.timezone`, `SystemSettings.time_zone` (`11` §6.3, §6.8) | IANA tz identifier (`Australia/Brisbane` shape). Validated for **membership** against a pinned tzdb name list shipped with the build; stored as written; case-sensitive. Never evaluated against a clock — it feeds NTP/logging *emit*, nothing else |
| `PlatformId` | Everything — `VendorExt.namespace`, `Scalar::parse`, rule `platforms:` predicates | An `Identifier` that is a **foreign key into `schema/platforms.yaml`** (§14). Constructing a `PlatformId` from a token not in the registry is a validation error at the layer doing the constructing (parser, pack lint, dictionary lint) |
| `PolicyAction` | `SecurityPolicy.action`, `PolicySet.default_action`, `Device.default_*_action` (`11` §6.3, §6.6) | Schema enum, variants `{ permit, deny, reject }`, generated unknown arm (§7). `11` §6.3's *"almost always `Default(Deny)`"* is `Presence::Default` carrying `deny` — a provenance state, not a fourth variant |
| `HostService` | `Zone.host_inbound_system_services`, `ZoneBinding` (`11` §6.6, §7.5) | Schema enum. Shipped variants: `{ ike, ssh, ping, https, dhcp, all }` (`11` §7.5's list), generated unknown arm. <!-- VERIFY: the full Junos host-inbound-traffic system-services list before the SRX dictionary ships; the unknown arm makes the gap survivable, not invisible --> |
| `InferenceRuleId` | `LearnedRoute.basis`, provenance `Origin::Inference` (`11` §6.5, §8.2) | Dotted identifier in the closed first-party `infer.*` namespace. Validated at **build** against the registered inference-pass list — an `InferenceRuleId` naming a pass that does not exist is `schema.infer.unknown` (§18). Users cannot add passes (`11` §9.5) |
| `RouteTarget` | `RoutingInstance.vrf_target` / `vrf_import` / `vrf_export` (`11` §6.5) | `{ admin, assigned }`, same shape as `RouteDistinguisher` (`11` §4.3). Canonical `65000:100`; parse accepts the `target:` prefix and strips it. Extended-community semantics per RFC 4360 are the *meaning*; the scalar stores the pair and nothing else |
| `Device.aggregate_device_count` | `AggregateInterface`'s Junos emit note (`11` §6.4); `82` §15 | **A field, not a scalar.** Declared in §20.1's sibling table and in `emission:` (§10.3): `u16`, `0..1`, Emit `R*` on `junos-*`, required when the device owns ≥1 `AggregateInterface` |
| `Device.reth_count` | `82` §15's first hard stop (`set chassis cluster reth-count N`) | Same shape: `u16`, `0..1`, Emit `R*` on `junos-srx`, required when the device owns ≥1 `RethInterface`. `82` §15's fix names both fields together and they land together |

---

## 4. Kinds

### 4.1 The declaration shape

```yaml
kinds:
  - kind: PhysicalPort
    layer: physical            # config | physical | service   (19 §2.2)
    emits: false               # excluded from every emit unit and coverage report
    doc: |
      A hole in a panel. 19 §3.3.
    fields:
      - { name: position,  type: Identifier, card: "1",    emit: "—" }
      # ...
    identity:
      - [ owner(PortHost), position ]
    similarity: { position: 4 }          # §9.2; illustrative weight
```

### 4.2 Kind-level keys

| Key | Required | Values | Meaning |
|---|---|---|---|
| `kind` | yes | UpperCamelCase, unique | The `NodeKind` variant name. Stable forever |
| `layer` | yes | `config` \| `physical` \| `service` | Drives emit exclusion, the re-identification scope filter, the diagram layer mask and the inventory kind lists — four consumers, mechanically, nothing ad hoc (`19` §2.2) |
| `emits` | yes | bool | `false` excludes the kind from every emit unit on every platform and from `13` §9.5's coverage report. All ten `19` kinds carry `false`; `Site` stays `layer: config` / `emits: true` because `Site.timezone` is Emit `O` |
| `doc` | yes | block scalar | §2.4 |
| `fields` | yes | list | §4.3 |
| `identity` | yes (may be `[]` only with a `doc:` saying why) | ordered tuple list | §8 |
| `similarity` | no | map field → weight | §9.2 |

Every kind additionally carries, implicitly and never declared per kind (`11` §6.2): `id: NodeId`,
`prov: NodeProvenance`, `ext: [VendorExt]`, `aka: [FormerName]`, `unknown: RawMap`, and the
node-level attributes `11` §13 declares (`absent_since` among them). The `notes` contradiction
between `11` §6.2 and §13 is `11`'s to resolve (`75` §3.6 blocker 4); this file declares neither
until it is.

### 4.3 Field-level keys

All field types are wrapped in `Field<Presence<T>>` (`11` §6.2); the declaration gives `T`.

| Key | Required | Values | Meaning |
|---|---|---|---|
| `name` | yes | snake_case, unique within the kind | Stable forever. Renaming is a **major** bump (§16.2) |
| `type` | yes | a `scalars:` name, a plain primitive, `enum(<name>)`, `map(K, V)`, `set{<enum>}` | `map` keys are `Identifier`; the only shipped map values are `AttrValue` and `Mtu` (`LogicalUnit.family_mtu`) |
| `card` | yes | `"1"`, `"0..1"`, `"0..n"`, `"1..n"` | `11` §6.2's column |
| `emit` | yes | `R`, `R*`, `O`, `—` | §10.1. Forced to `—` on `emits: false` kinds and on `derived` fields; declaring otherwise is `schema.emit.on-inert` |
| `emit_required_when` | iff `emit: R*` | `{ platforms: [...], when: <predicate §12.3> }` | The generalised `R*` predicate (`19` §7.3 iii) |
| `required_when` | no | `<predicate §12.3>` | Conditional requiredness at **L1** — a hole, never a refusal (e.g. `PathSegment.boundary_reason`: `"kind == Boundary"`) |
| `validated_against` | no | `edge(<EdgeKind>)` | §12.2's cross-node clause. The field may not be written while that edge is absent |
| `fold` | no, default `none` | `none` \| `ascii_case` | §9.1 |
| `comparator` | no, default `canonical` | `canonical` \| `parsed_then_raw` \| registered name | Which equality the matcher uses. `Interface.name` declares `parsed_then_raw` (`11` §4.6); `OsVersion` fields resolve their comparator per family in code |
| `merge_class` | no | `33` §6.4 class letter | **Dormant under ADR-0016.** Recorded now so sync's return is a data edit, not a schema pass. Absent means "unclassified"; the CRDT work assigns classes when it wakes |
| `derived` | no | `{ fn, depends_on }` | §11.2 |
| `constraints` | no | map | §3.2 |
| `doc` | no | block scalar | §2.4 |

---

## 5. Classes — named kind sets

A class is a **set, not a supertype** (`11` §12.1). There is no subtyping anywhere in this design.
A field declared on a class is a field declared identically on each member kind — codegen expands
it per member; there is no shared struct. Rules address classes in `applies_to`; edge `from`/`to`
sets may name them (§6).

```yaml
classes:
  - class: InterfaceLike
    members: [Interface, AggregateInterface, RethInterface, TunnelInterface]
    doc: Anything a LogicalUnit can be contained by and an endpoint can attach to.
  - class: MultiMemberInterface
    members: [AggregateInterface, RethInterface]
    doc: |
      Cross-vendor rules address this, never the kinds — 11 §12.1's reth/LAG split.
  - class: PortHost
    members: [Chassis, PassiveNode]
    doc: The two owners of PhysicalPort. 19 §3.3, carried per 19 §7.4 row 5.
```

Gates: every member exists (`schema.class.unknown-member`); classes may not contain classes
(`schema.class.nested`); two classes may share members (that is the point); a class with one
member is a lint (`schema.class.singleton`) because it is a rename waiting to happen.

**Why classes are not inheritance, restated normatively because someone will ask for it:** a
supertype invites fields "on the supertype" whose semantics quietly diverge per subtype, and it
invites dispatch. A set does neither — membership is the only fact it states, and the pack lint
can check membership with set arithmetic.

---

## 6. Edges

### 6.1 The declaration shape

```yaml
edges:
  - edge: Terminates
    class: reference           # containment | reference   (derived edges: §11.4)
    from: [Cable]
    to: [PhysicalPort, ExternalPeer]
    out: "0..2"                # bound at the from end; bare range = enforced at L0
    in:  "0..n"                # bound at the to end
    reverse_index: true        # 12's reverse-indexing requirement
    symmetric: false
    fields:
      - { name: end,  type: enum(cable_end), card: "1",    emit: "—",
          doc: Which end of the cable this termination is. A or B. }
      - { name: lane, type: u8,              card: "0..1", emit: "—" }
    emit_dict: null            # §6.3
    doc: |
      A cable end lands on a port, or on an external peer at the modelling
      horizon. 19 §5.1. A breakout is four cables sharing a near-end port,
      never a four-ended cable — hyperedges are unrepresentable, deliberately.
```

### 6.2 Keys, and which level enforces each bound

| Key | Meaning |
|---|---|
| `edge` | The `EdgeKind` variant name. Unique across the whole file — `19` §5.3's `WarpResolvesVia` collision is the precedent, and `schema.edge.duplicate` is the gate that would have caught it |
| `class` | `containment` builds the forest (`11` §7.2, one owner, R-L1's blast-radius rule); `reference` never deletes its target |
| `from` / `to` | Kind **sets**; class names admitted and expanded at codegen. Widening a set is minor; narrowing is major (§16.2) |
| `out` / `in` | Cardinality at each end. A bare range is enforced at **L0** — the store refuses the violating write. The two-level form declares different bounds per validity level: |

```yaml
    out: { l0: "0..n", l1: "0..1" }    # EntersAt / ExitsAt (19 §5.2): merge
                                       # convergence needs 0..n at the store;
                                       # a rule reports the excess as a hole
```

The two-level form exists for exactly one reason and it is `19` §5.2's: a concurrent write of two
values for a conceptually-single edge must converge rather than conflict, so the store bound
relaxes and an L1 rule (`service.path.segment.multiple-entry`) owns the judgement. **Every
two-level bound must name the rule that patrols the L1 bound in its `doc:`** — a relaxed bound
with no patrolling rule is a hole nobody sees, and `schema.edge.l1-unpatrolled` (§18) checks the
named rule exists in the first-party pack.

| Key | Meaning |
|---|---|
| `reverse_index` | `true` obliges the store to maintain the `to → from` adjacency incrementally; `12`'s dependency keys (`DepKey::Adjacency`) and `19` §8.3's increment scope both require it. Declaring `false` on an edge a shipped rule traverses backwards is `schema.edge.reverse-unindexed` |
| `symmetric` | `true` means `(a,b)` and `(b,a)` are the same edge (one stored instance, canonical order by `NodeId`). `PassThrough` is the shipped example |
| `fields` | Same grammar as kind fields (§4.3). `ZoneBinding` (`11` §7.5) and `Terminates` are the precedents |
| `emit_dict` | §6.3 |

### 6.3 The emit template hook is a reference, not a template

`19` §7.4 row 6 asks for an "emit template hook". `14` §6.4 already states that *the statement
dictionary is the emitter's table, read backwards* — the template for an edge-bearing statement
(`ExternalInterface`'s `set security ike gateway … external-interface …`) lives in the dictionary
entry that binds it. Declaring a second template on the edge would be the same fact in two places,
and they would diverge.

So `emit_dict` is a **reference**: the dictionary entry id (or list of ids, one per platform) that
emits this edge, or `null` for a never-emitted edge. The gate runs in the other direction too:
a dictionary entry with `binds.edge.kind: K` requires `K.emit_dict` to name it
(`dict.edge.unhooked`, §19.4). See §24 Disagreement 3.

---

## 7. Enums

One file per named enum under `schema/enums/`:

```yaml
# schema/enums/establish_tunnels.yaml
variants: [immediately, on_traffic, responder_only, responder_only_no_rekey]
default_by_platform:
  junos-srx: on_traffic
platform_spellings:
  junos-srx:
    immediately:    "immediately"
    on_traffic:     "on-traffic"
    responder_only: "responder-only"
doc: |
  Neutral variants; per-platform surface strings. 63 §5.3's platform enum
  map lives here per ADR-0008 — 63 references it and no longer carries it.
```

Rules:

1. **Variant names are neutral** — no vendor spelling is ever a variant name. The spellings map
   is where vendor text lives, per platform, and it is the only place.
2. **The unknown arm is generated, never declared.** Every schema enum gets
   `Variant::Unknown(token)` (`11` §11.3) from codegen. Declaring a variant named `unknown` is
   `schema.enum.reserved-variant`. This is what makes "new enum variant" a minor bump an old
   client survives.
3. **`default_by_platform` must be sourced.** Each entry requires a citation in `doc:` per `11`
   §5.3's rule that a `Default` is a claim about a platform version; the corpus defaults file
   (`corpus/defaults/`) carries the sourced claim and this map must agree with it
   (`schema.enum.default-unsourced`).
4. **Inline enums** (`type: enum { a, b }` written directly on a field) are permitted for
   single-use, platform-invariant enums only — `Service.reach`, `ServiceEndpoint.role`. Codegen
   names them `<Kind><Field>`. The moment one needs a spelling map or a second use, it moves to a
   file; an inline enum with `platform_spellings` is a parse error.
5. **Per-`AttributeDecl` enums are not schema enums.** `AttrType::Enum` variants come from
   `AttributeDecl.enum_values` — workspace data, `EnumId` allocated per declaration (`19` §4.3).
   They get no file, no spellings, no unknown arm, and no row here.

---

## 8. Identity

### 8.1 The declaration and the term grammar

Each kind declares an **ordered** list of identity tuples, most specific first (`11` §10.3). A
tuple is usable on a node only when every term is `Set`.

```yaml
identity:
  - [ owner(Device), name ]                                   # tier 1
  - [ owner(Device), peer.address, edge(ExternalInterface) ]  # tier 2
  - [ edge_in(TunnelEndpoint via IpsecVpn), side ]            # tier 3
```

| Term | Meaning |
|---|---|
| `<field_path>` | Dotted path into the kind's own fields, may descend into a structured value (`peer.address`, `name.parsed`) |
| `owner(K)` | The containment parent's identity, where `K` is a kind or class the parent must belong to |
| `edge(E)` | The identity of the node this node's out-edge `E` targets |
| `edge_in(E via K)` | The identity of the `K`-kind node whose out-edge `E` targets this node |

### 8.2 The prohibitions, all machine-checked (§18)

| Prohibition | Source | Gate |
|---|---|---|
| No `VendorExt` key in any tuple | `11` §12.4 rule 5 | `schema.identity.ext-term` |
| No `Service.attributes` / `ServiceEndpoint.attributes` key | `19` §7.2 | `schema.identity.attr-term` |
| No inferred value, no derived field, no derived edge | `11` §10.3, §11 here | `schema.identity.derived-term` |
| No term through a two-level-bound edge's relaxed range | this document — a tuple through an edge that can legally be multiple is not a tuple | `schema.identity.ambiguous-edge` |

### 8.3 The tier-1 hash

ADR-0010 permits a hash of the tier-1 tuple as a **recovery** key — re-binding an orphaned
annotation after a re-parse minted fresh ULIDs — and nothing else. Normatively: the hash appears
in `FindingKey` / suppression anchors and in `fsck --repair`'s candidate search; it is never a
graph reference, never persisted as a node key, never consulted by rules. `schema.json` carries,
per kind, which tuple is tier 1, so the hash's inputs are data rather than convention.

### 8.4 Import-exercised identity

`Premises`, `PhysicalPort`, `Cable`, `ServiceType` and `Tenant` are never parsed; their tuples are
exercised by **import** (`19` §9.3), under §9.5's `ImportScope` declarations. A kind whose `layer`
is not `config` and which no `ImportScope` covers is not thereby defective: its records are
hand-entered, and hand-entered records exercise their tuples through **merge** — `fathom merge
--resolve` matches by natural key per `11` §8.6, which is the same tuple walk an import performs.
Seven of the ten `19` kinds (`Cable`, `PassiveNode`, `Tenant`, `Service`, `ServiceEndpoint`,
`ServicePath`, `PathSegment`) ship in exactly this state, so this cannot be a defect without the
spec failing its own gate on day one. `schema.identity.unexercised` therefore fires only for a
kind that some `ImportScope` **claims** to cover while matching none of its declared tiers — a
scope/identity mismatch, which genuinely is an error — and it is a **warning** (§18.2), not a
build failure, for the merge-exercised case.

---

## 9. Matching, `CaptureScope` and `ImportScope`

### 9.1 Per-field case-folding

`fold: ascii_case` declares that the matcher and the indexes compare this field case-folded. The
key of `Graph.by_cid` / `by_uni` (`19` §4.5) is the field's `canonical()` form under this
declaration. Shipped `ascii_case` fields: `Service.cid`, `ServiceEndpoint.uni_id` (`19` §7.4
row 9). `Identifier` fields default `none` — case is significant on some platforms (`11` §4.3) and
folding an object name is how two different objects merge.

### 9.2 Per-kind similarity weights

```yaml
similarity: { name: 4, peer.address: 3, edge(ExternalInterface): 2 }
```

Integer weights over tuple-eligible terms, consumed by `11` §10.4's residue matcher. The shipped
weights are engineering estimates until the matcher is tuned against fixtures; each carries
`# illustrative` until `45`'s re-identification fixture suite pins it. A weight on a term the kind
does not declare is `schema.similarity.unknown-term`.

### 9.3 The residue guard constants are schema data

```yaml
matching:
  residue_guard:
    accept: 0.75        # minimum similarity for a residue match to bind
    margin: 0.15        # best must beat runner-up by this, else ambiguous → no bind
    max_residue: 4096   # when |unmatched G| × |unmatched P| exceeds this, per kind
                        # (11 §10.4 step 4), the matcher does not attempt residue
                        # matching at all; everything orphans explicitly
```

The three constants are `11` §10.4's, ordered as `19` §7.4 row 9 lists them (0.75 / 0.15 / 4096);
the key names are this document's. They are schema data rather than code constants so that a
retune is a visible, versioned, hash-changing edit — a silently retuned matcher re-identifies
differently on two builds and invariant 9's tuple would not say why.

### 9.4 `CaptureScope`, transcribed with `19` §7.3's three amendments

`CaptureScope` is `11`'s concept; this block **transcribes** it as data and must carry all three
amendments `19` §7.3 makes to `11` — transcribing it unamended is how `19` §9.1's defect gets
re-introduced by someone reading only this file (`19` §9.3):

```yaml
scopes:
  capture:
    layer_filter: config      # 19 §9.1 A1: re-identification step 1 gains the
                              # positive conjunct layer(kind(n)) == config
    absence_origin_columns:
      imported: nothing       # 19 §9.1 A2: Origin::Imported under Section/Whole
                              # scope → nothing happens. Catalogue ports do not
                              # tombstone because a config re-parse omitted them
    staleness_bands: config_only  # 19 §7.3 A3 / §3.9: 11 §8.7's wall-clock
                              # staleness bands apply only where layer == config.
                              # Without this, a catalogue port renders differently
                              # on two days and 19 §6.10's determinism argument
                              # is false
```

### 9.5 `ImportScope` — new, owned here outright

Per `19` §9.3's demand: every import format declares which kinds it may create or re-identify,
which identity tiers it may match against, and what an absence in the imported document means.

```yaml
  import:
    - format: Corpus              # builtin service types, 19 §4.3.1
      kinds: [ServiceType]
      tiers: [1]                  # builtin_id only — a corpus refresh may never
                                  # re-identify a user type by code
      absence: nothing
    - format: HardwareCatalogue   # 19 §3.9
      kinds: [PhysicalPort]
      tiers: [1]
      absence: nothing
    - format: SiteList
      kinds: [Premises, Site]
      tiers: [1, 2]
      absence: nothing
    - format: TypeSet             # 19 §4.3.2's export/import
      kinds: [ServiceType]
      tiers: [1, 2]               # builtin_id, then code
      absence: nothing
```

`absence ∈ { nothing, unknown, absent }`.

> **DECISION — this document, filling the gap `19` §9.3 left open: no shipped import scope
> asserts `absent` in v1.** An import describes what it contains, not what the world lacks; a
> re-imported site list missing a premises leaves the premises untouched. The `absent` value
> exists in the grammar because `11` §8.5's who-may-assert-`Absent` rule will eventually need an
> importer answer for a genuinely closed-world source, and when it does, the declaration point
> already exists. Until then, declaring `absence: absent` is `schema.scope.absent-unshipped`
> (§18). Marked plainly: this is a `62` decision in `19`'s spirit, not a `19` decision.

Re-importing under a declared scope runs `11` §10.4 restricted to the scope's kinds and tiers —
which is what makes a second import of the same site list an update rather than a duplication.

---

## 10. Emission

### 10.1 `emit` semantics

| Value | Meaning |
|---|---|
| `R` | Required for a valid emit on **every** platform that supports the kind. A missing `R` field makes the emit unit incomplete (`11` §9.2) |
| `R*` | Required only where `emit_required_when` matches — a platform set plus an optional predicate over the emit unit (`19` §7.3 iii generalises the column from "platforms noted" to an expression) |
| `O` | Emitted when `Set`, legal to omit |
| `—` | Never emitted. Forced on `emits: false` kinds and on derived fields |

### 10.2 Required-sibling declarations

The `reth_count` class of blocker (`82` §15): a field that is emittable on its own but whose emit
is meaningless — or refused by the device — without a sibling being set.

```yaml
emission:
  requires_for_emit:
    - id: emit.junos.aggregate-device-count
      platforms: ["junos-*"]
      when: "exists(AggregateInterface within Device)"
      requires: [Device.aggregate_device_count]
      on_violation: block_emit
    - id: emit.junos-srx.reth-count
      platforms: [junos-srx]
      when: "exists(RethInterface within Device)"
      requires: [Device.reth_count]
      on_violation: block_emit
```

`when` uses §12.3's closed predicate grammar, evaluated over the emit unit at L2. `block_emit`
surfaces as `13`'s blocked-emit outcome with the declaration's `id` in the reason — a named,
suppressible-nowhere refusal, not a silent omission.

### 10.3 `DeclaredGap`, and the coverage gate

An emitter that cannot emit a field it should must say so in code:
`KindEmitter::gaps() -> &'static [DeclaredGap]` (`13`). The schema side of the contract is the
gate:

> **Gate `schema.emit.unread` (build failure).** For every platform `p` claiming kind `k` (a
> platform claims a kind when its statement dictionary binds it, §19), every field of `k` with
> `emit: R` — and every `R*` field whose platform set includes `p` — must appear in
> `KindEmitter::reads()` for `(k, p)` **or** in a `DeclaredGap` carrying a reason string.
> `emits: false` kinds are excluded wholesale. (`19` §7.4 row 10.)

This is `82` §15's class of defect converted from a review finding into a CI failure, which is
ADR-0008's stated positive consequence, verbatim.

---

## 11. Derived fields and derived edges

### 11.1 One contract, two shapes

`11` §3.5 established the contract for derived *edges*: rebuilt on load and after every mutation
batch, separate arena, never serialised, never merged, never edited. `19` §7.3 (i) generalises the
identical contract to *fields*. Nothing about the contract changes with the shape.

### 11.2 Derived field declaration

```yaml
- name: occupied
  type: bool
  card: "1"
  emit: "—"                          # forced; declaring anything else is an error
  derived:
    fn: derive.physicalport.occupied
    depends_on:
      - adjacency(self, Occupies, In)
  doc: True iff at least one Interface Occupies this port.
```

| Rule | Enforcement |
|---|---|
| `fn` is a registered first-party function in the `derive.*` namespace — a pure function of the values read: no side effects, no ambient state, no clock (`12` §6.6's soundness wording, verbatim) | Build: `schema.derive.unknown-fn`; purity by review plus the determinism suite |
| `depends_on` is the declared **static read set**: field paths, `adjacency(...)` keys, edge terms | Build: terms must exist. Runtime: the recording evaluator asserts `actual ⊆ static` on every fixture — `12` §15.3 gate 5a applies to derive functions unchanged |
| Never serialised. The store refuses to write a derived field into a record; a serialised derived value in an incoming file lands in `unknown` and is dropped on recompute | Store, write time |
| Never emitted, never an identity term, never a similarity term | §8.2, §10.1 |
| Readable by rules and by the inventory column picker. A rule reading a derived field acquires the field's `depends_on` (transitively) into its own static read set — that is what keeps `12` §6.6's incrementality proof true | Pack compile |

The four shipped derived fields (`19` §7.3): `PathSegment.resolution` and
`PathSegment.corroboration` (declarations per `19` §6), `Device.name_conformance`
(`type: NameConformance`, a structured value `{ state: enum(conformance_state), reason: Text? }`
per `19` §8.3), `PhysicalPort.occupied` (above).

### 11.3 Recompute discipline

Derived fields recompute on load and after every mutation batch whose delta intersects their
`depends_on` — the same invalidation machinery `12` §6.3–6.5 runs for rules, keyed identically.
`EnumMap` iteration order makes the recompute order deterministic (invariant 9).

### 11.4 Derived edge declaration

```yaml
derived_edges:
  - edge: CarriedBy
    from: [Service]
    to: [Device, PassiveNode]
    produced_by: infer.service.carried-by
    fields: []
    doc: |
      Asserted EntersAt/ExitsAt/AttachesTo only — never through a resolved
      warp; one level deep per 11 §9.5 constraint 1. Under-reports across
      warps and its explainer must say so (19 §5.3).
```

Derived edges have no `class:` — they are neither containment nor reference; they live in the
separate arena and the **store must refuse to serialise them** (`19` §5.3's guard, and §21 F2's
failure mode). `produced_by` is an `InferenceRuleId` (§3.4).

---

## 12. Constraints

### 12.1 Levels and the `on_violation` vocabulary

| Level | Checked | `on_violation` | Meaning |
|---|---|---|---|
| **L0** | Write time, by the store | `reject_write` | A type error. The write does not happen; the error names the violated declaration |
| **L1** | Validity computation | `report_hole` | A hole (`11` §9.1). Partiality is the normal state; nothing is refused |
| **L2** | Emit time | `block_emit` | The emit unit is refused with a named reason (`11` §6.7's usage, named at last — `19` §7.3 ii) |

`reject_write` = L0 and `block_emit` = L2 are `19` §7.3's pairing; `report_hole` as L1's value is
this document's completion of the vocabulary, in `19`'s spirit (its L1 behaviour was specified —
*"reported … never refused"* — and only the token was missing). A constraint declares exactly one
level; wanting two levels means writing two constraints, so each has one id and one behaviour.

### 12.2 Cross-node clauses

```yaml
constraints:
  - id: service.attributes.typed-by-oftype
    kind: Service
    field: attributes
    level: L0
    validated_against: edge(OfType)
    on_violation: reject_write
    doc: |
      19 §4.3: unknown keys and wrong-typed values are refused against the
      ServiceType reached through OfType. The field may not be written while
      that edge is absent; the error names the missing edge.
  - id: passthrough.same-owner
    edge: PassThrough
    level: L0
    require: "owner(from) == owner(to)"
    on_violation: reject_write
  - id: service.cid.required-when-external
    kind: Service
    level: L1
    require: "reach == External implies cid is Set"
    on_violation: report_hole
```

`validated_against: edge(E)` is the one declarative cross-node L0 clause (`19` §4.3's demand):
the referenced node supplies the validation context, and writing the field while `E` is absent is
itself the refusal. `19` §8 reuses the identical shape against a naming scheme.

### 12.3 The predicate grammar — closed, and deliberately weaker than `fex`

```
constraint := term | term "implies" term
term       := clause { "and" clause }
clause     := path cmp value
            | path "is" ("Set" | "Absent" | "Unknown")
            | "exists" "(" Kind "within" anchor ")"
cmp        := "==" | "!=" | "in"
path       := ["edge(" EdgeKind ")."] field_path        # ≤ 3 hops total
value      := literal | "[" literal { "," literal } "]"
anchor     := "Device" | "self" | Kind
```

No disjunction, no negation, no arithmetic, no string operations, no user extension. If a
condition needs more than this grammar, it is a **rule**, not a schema constraint — rules are
findings-shaped, suppressible, and evaluated by an engine built for it; constraints are structural
and must be statically read-set-extractable by construction, which this grammar guarantees (every
`path` is literal). `edge(...)` paths admit exactly one edge hop, which is how
`emit_required_when` reaches a referenced node's value (`ServiceType.requires_cid`, `19` §7.3 iii)
without becoming a traversal language.

---

## 13. Extension surfaces, and the closed metamodel

### 13.1 The refusal, written normatively (`19` §7.1)

> **The product loads exactly one schema: the one shipped with the build.** There is no user
> schema, no third-party schema, no schema merge, no runtime schema loading. Node kinds, edge
> kinds, semantic scalars, and fields on shipped kinds are **not extensible by a user,
> permanently.** The extensibility surface is **values, never types**: `ServiceType` nodes under
> the closed metamodel (`19` §4.3), keys of the one declared attributes map typed by the closed
> `AttrType` enum, and `Policy` record content under the closed segment grammar (§15).

The reasons are `19` §7.1's and are cited, not reargued: `NodeId` embeds a `Copy` `NodeKind`;
`EnumMap` needs a compile-time enum for invariant 9; emitter dispatch is exhaustive;
`Kind::Unknown(token)` is already spent on forward compatibility, so a user kind would collapse
preserve mode. ADR-0028's trust root closes the third-party-schema door; this section is where
the closure is written down as a property of the file format.

### 13.2 The two surfaces, side by side

| | `VendorExt` (`11` §12.4) | `ServiceType.attributes` / `endpoint_attributes` (`19` §4.3) |
|---|---|---|
| Who extends | The **corpus** — first-party, reviewed, registered in `corpus/extensions.yaml` | The **user** — per workspace, unreviewed |
| Namespace | Exactly one `PlatformId` per key | Per `ServiceType` node |
| Value types | Any semantic scalar except `SecretPlaceholder` and `Text` (rule 8) | The closed `AttrType` enum — `Text` admitted with compensating controls |
| Rule access | `uses_ext: [key]` declared, else refused at pack load | `uses_attr: [key]` declared, else `NotApplicable` |
| Identity | Never (rule 5) | Never (`19` §7.2) |
| Emit | Per-registry `emit:` template | **Structurally never** — the grammar has no emit key |
| Escape pressure | Rules 6–7: three-strikes promotion, 15% budget, both CI failures | `withdrawn`, never deleted; no promotion path — an attribute that wants to be a field is a `19` §4.3 modelling conversation |

The divergences are deliberate and each carries its reasoning in the cited sections; the one that
looks inconsistent — `Text` refused in the bag, admitted in attributes — is resolved in `19` §4.3
on its own terms: the bag's rule 8 hazard (a human typing a PSK into a free-text slot) is fully
present in attributes too, and the controls are the §18 secret-shaped-key lint plus a `37` §2.2
verdict, not a denial of the hazard.

### 13.3 `AttrType`, and its bindings — transcribed from `19` §4.3

```rust
pub enum AttrType {
    Bool, Integer, Text, Enum,
    Bandwidth, VlanId, IpPrefix, InterfaceAddress, Identifier, Date,
}
```

| Variant | `11` §4.3 / §3 scalar | `12` §3.5 `Value` a rule sees | Note |
|---|---|---|---|
| `Bool` | plain primitive | `Bool` | |
| `Integer` | plain primitive (`i64`, checked) | `Int` | |
| `Text` | `Text` | `Str` | The only free-string type; §18's secret-shaped lint applies |
| `Enum` | none — variants from `AttributeDecl.enum_values` | `Enum(EnumId, VariantId)` | `EnumId` per declaration, not per platform |
| `Bandwidth` | §3.4 (new) | `Int` | Bits per second |
| `VlanId` | `VlanId` | `Int` | |
| `IpPrefix` | `IpPrefix` | `Prefix` | Host bits zeroed |
| `InterfaceAddress` | `InterfaceAddress` | **none — not rule-readable** | Mapping onto `Prefix` is refused: `11` §4.3 calls the conflation *"the most common modelling bug in this domain"* |
| `Identifier` | `Identifier` | `Str` | Validated, never normalised |
| `Date` | §3.3 (new) | **none — not rule-readable** | `attr()` on either unreadable type → `NotApplicable`, reusing the undeclared-key outcome; no new `Value` variant, no `12` change |

`Decimal` does not exist and may not be added: floats are structurally excluded (`12` §3.4,
`11` §14.1), and `19` §4.3 deleted the variant with the arithmetic that shows nothing needs it.

There is **no** `AttrType::SecretPlaceholder`, and no path to one.

### 13.4 The closure table, restated as testable properties

Each row of `19` §7.2's closure table maps to a gate in §18; the mapping is given here so the
property and its test are read together.

| Property | Mechanism | Gate(s) |
|---|---|---|
| A user cannot add a field to `Service` | The type-set grammar is **closed**: any unknown key refuses the whole file, never best-effort | `typeset.grammar.unknown-key` |
| An attribute cannot have an unknown type | `AttrType` is a closed Rust enum; declaration import type-checks against it | `typeset.attr.unknown-type`; build gate `schema.attrtype.drift` (this table vs the generated enum) |
| An attribute cannot be emitted | The grammar has no `emit:` key — *"a stronger guarantee than a prohibition a hurried person can argue with"* (`19` §7.2) | `typeset.grammar.unknown-key`; plus `schema.emit.attr-read` asserts no `KindEmitter::reads()` set includes an attributes map |
| An attribute cannot be identity | §8.2 | `schema.identity.attr-term` |
| An attribute cannot hold a secret **structurally** — weakest row, said plainly | No `SecretPlaceholder` variant; but `Text` is a variant, so the control is a declaration-time lint plus `37` §2.2 review, not the type system | `typeset.attr.secret-shaped` |
| A rule reads an attribute only by declaration | `uses_attr: [key]`; undeclared read → `NotApplicable`, never `Passed` | `pack.attr.undeclared` (rule loader, `63`) |
| A service type cannot change path semantics | The grammar has no segment, warp, or resolution keys | `typeset.grammar.unknown-key`; engine test `warp.reads-no-attrs` asserts `resolve_warp` performs no attribute reads |

---

## 14. The platform registry

`schema/platforms.yaml` — already the source of platform ids for rule predicates (`63` §5.1) —
gains the `vendors:` block `19` §8.2 requires, and `vendor:` becomes a foreign key into it.

```yaml
# schema/platforms.yaml
vendors:
  juniper:   {}
  palo-alto: {}
  cisco:     {}
  arista:    {}
  fortinet:  {}
  calix:     {}          # hardware-catalogue vendors are the same namespace —
  nokia:     {}          # 19 §3.9's catalogue vendor: is a FK into this block,
  adtran:    {}          # which is what makes 76 X11's cross-check possible

platforms:
  junos-srx: { vendor: juniper,   family: junos,   version_scheme: junos }
  junos-mx:  { vendor: juniper,   family: junos,   version_scheme: junos }
  junos-ex:  { vendor: juniper,   family: junos,   version_scheme: junos }
  panos:     { vendor: palo-alto, family: panos,   version_scheme: panos }
  ios-xe:    { vendor: cisco,     family: ios,     version_scheme: iosxe }
  nx-os:     { vendor: cisco,     family: nxos,    version_scheme: nxos }
  eos:       { vendor: arista,    family: eos,     version_scheme: eos }
  fortios:   { vendor: fortinet,  family: fortios, version_scheme: fortios }
```

Rules, each a §18 gate:

1. Every `platforms.*.vendor` and every hardware-catalogue `vendor:` names a `vendors:` key
   (`schema.platform.unknown-vendor`).
2. **Vendor ids are schema; token spellings are policy.** A vendor list two workspaces disagree
   about makes `Device.platform` unreadable, so the ids live here; `NOK` versus `NOKIA` genuinely
   is per-operator, so the tokens live in `Policy.vendor_tokens` (§15) keyed by these ids
   (`19` §8.2).
3. A `Policy.vendor_tokens` key naming a vendor not in this block quarantines the scheme at
   workspace load (`policy.vendor.unknown`), never the whole policy.
4. Platform ids are the *only* spelling of a platform anywhere in the product — `PlatformId`
   (§3.4) is a FK into this file, and free-text platform strings are a build error wherever they
   appear.

---

## 15. The `Policy` record grammar

The `Policy` record (`RecordKind::Policy`, class byte `0x23`, `19` §8.1) is workspace data, not
corpus — but its *grammar* is schema, because the segment roles are engine-owned and closed. This
section is what `19` §8 needs from `62` (`19` §7.4 row 15).

### 15.1 The document shape

```yaml
# fathom policy show — canonical round-trip form (19 §8.1)
policy_version: 7          # monotonic claim; content_hash is the fact
naming:
  - id: external-access    # operator-chosen, STABLE, cited by every finding witness
    label: "External access equipment"
    enforcement: enforced  # off | advisory | enforced   (19 §8.4)
    adopted_on: 2026-08-14 # stored, rendered, NEVER evaluated
    applies_to:
      kind: Device
      field: hostname
      match:               # closed conjunctive terms, ANDed. Not fex
        - { path: Device.role, op: in, value: [Router, Switch] }
    segments:
      - { id: st,   role: field,     path: "site.premises.region",  width: 2, case: upper }
      - { id: clli, role: field,     path: "site.premises.clli", take: prefix(8), case: upper }
      - { id: type, role: vendor,    case: upper }
      - { id: inc,  role: increment, style: alpha_when_shared, width: 2, scope: premises }
vendor_tokens: { calix: CLX, nokia: NOK, adtran: ADT }
rule_overrides: []         # 63 §16's overrides documents, rehomed (19 §8.1)
```

### 15.2 The segment role vocabulary — closed, five values, no user regex anywhere

| Role | Reads | Forwards (generate) | Backwards (validate) |
|---|---|---|---|
| `literal` | nothing | the text | exact match |
| `field { path, take }` | one path from `naming_eligible` (§15.3), ≤3 hops from the anchor | the canonical token, optionally a prefix | must equal the graph's value |
| `vendor` | `Device.platform` → `platforms.yaml` `vendor:` → `vendor_tokens`; or `Chassis.model` → hardware catalogue → `vendor` | the token | must be a declared token **and** this device's vendor's token |
| `increment { style, width, scope }` | the sibling set in scope (`scope ∈ {premises, site}`, default `premises`) | the lowest free value | legal and consistent with the sibling set (`19` §8.3: `alpha_when_shared` — numeric when alone, letters when shared) |
| `free { charset, min, max }` | nothing | **cannot generate** | charset and length only |

Every segment carries `case ∈ {upper, lower, as_written}`, `optional: bool`, and a stable `id`
cited in finding witnesses. Separators are `literal` segments — no second concept. A regex role is
refused for `19` §8.2's four reasons, the decisive one being that a regex cannot be run forwards.

### 15.3 `naming_eligible` — the allow-list is schema

```yaml
naming_eligible:
  - Device.hostname                    # the anchor field a scheme may select
  - site.premises.region               # paths a `field` segment may read,
  - site.premises.clli                 # each ≤ 3 hops from the anchor kind
  - site.name
```

The list ships in `schema.yaml` because a scheme reading an arbitrary path is a scheme whose read
set the engine cannot bound. A scheme naming an ineligible path **quarantines that scheme** at
workspace load — never the whole policy — and it surfaces in `12` §8.4's *"could not evaluate"*
band with the path named (`policy.path.ineligible`).

### 15.4 Load-time rules

| Rule | Code |
|---|---|
| Policy compiles at workspace load; compile failures quarantine per scheme | `policy.compile.quarantined` |
| `applies_to.match` uses §12.3's clause grammar (paths, `==`/`!=`/`in`, literals) — not `fex` | `policy.match.grammar` |
| A `vendor` segment with a vendor present in the estate and no token declared quarantines the scheme | `policy.vendor.untokened` |
| `scheme.id` is stable; changing it orphans suppressions keyed on its findings, and `fathom policy set` warns | `policy.scheme.id-changed` (warning at CLI, not a refusal) |
| Merge: per-scheme on `scheme_id`, then per-field via `11` §8.6's ladder (`19` §8.1) — no CRDT | — |

The enforcement ladder (`off` / `advisory` / `enforced`), the baseline mechanism and the
generator's propose-only rule are `19` §8.4–8.5's and are consumed here unchanged: the grammar
above is everything `62` owns.

---

## 16. Versioning

### 16.1 The version block

```yaml
schema:
  version: "3.2"      # major.minor, no patch (11 §11.2). Illustrative number —
                      # the real one is assigned when the file first ships.
```

`schema_version` lives in the workspace envelope header, outside the ciphertext, inside the AEAD
associated data (`11` §11.2). The determinism tuple of invariant 9 includes it via the build —
same build implies same schema — and ADR-0008 makes that explicit.

### 16.2 The bump table, restated normatively

`11` §11.3's table, restated as the **normative rule for edits to this file**. The bump checker
(§16.4) enforces it mechanically.

| Change to `schema/` | Bump | Old client |
|---|---|---|
| New node kind | minor | reads as `Kind::Unknown`, preserve mode |
| New edge kind | minor | preserved opaquely |
| New optional field | minor | preserved in `unknown` |
| New enum variant | minor | `Variant::Unknown(token)` — the generated arm |
| Relaxed constraint / widened cardinality upper bound / widened `from`/`to` set | minor | yes |
| New identity tuple appended | minor | yes |
| Field removed or renamed | **major** | no |
| Field type changed | **major** | no |
| Cardinality **lower** bound raised | **major** | no |
| Constraint tightened | **major** | no |
| Identity tuple removed or reordered | **major** | no |
| Containment restructured (a kind's owner changes) | **major** | no |

Worked against this table, `19` §7.5 prices the entire service and physical model as **one minor
bump**: ten kinds, twenty-one edges, two widened kind sets, zero removals, zero retypes, zero
reordered tuples. That arithmetic is the model for how every future change is priced — against
this table, item by item, in writing.

### 16.3 The content hash

`schema_hash` is the BLAKE3 hash of the generated `schema.json`'s canonical bytes (§17). It is
published beside `schema_version` in the release, recorded by the workspace manifest (ADR-0013)
and by `Pins` alongside the corpus version, and stamped into `schema.json` consumers' error
messages. Version is a claim; the hash is the fact — the same split `17` §8.1 uses.

### 16.4 The bump checker

`schema/released/` holds one checked-in `schema.json` snapshot per released schema version. CI
diffs the current generated `schema.json` against the latest snapshot, classifies every difference
per §16.2's table, and fails (`schema.version.bump-too-small`) if the declared `schema.version`
bump is smaller than the required one. A major bump additionally requires: a written migration
note, a `Migration` impl registered in the chain, and a golden fixture for the outgoing version
(`11` §11.5) — each its own gate (§18). This is this document's mechanism, added in `19`'s
spirit: the bump table existed; nothing checked it.

---

## 17. Generated artifacts

### 17.1 The exact list

| Output | Consumer | Notes |
|---|---|---|
| `ir_types.rs` | the core | Typed `Node`/`Edge` enums and per-kind structs; `EnumMap`-compatible kind enum; generated unknown arms |
| `accessors.rs` | emitters (`13`) | Typed fallible field accessors per (kind, field) — ADR-0007's stated mitigation for fallible field reads, made checkable |
| `schema.json` | rule packs (`63`'s lint kind/field universe), the `fex` type environment (`12`), the finder, the UI column picker (`52` §3.7), the statement dictionary lint (§19), the bump checker (§16.4) | Canonical JSON: sorted keys, no insignificant whitespace, LF, UTF-8. The content-hashed artifact |
| `ir_types.ts` | the TypeScript UI boundary only | Never the wire format |
| `migrations/manifest.toml` | CI | The declared chain, checked complete from 1.0 (`11` §11.5) |
| the field-key registry | wire format (`11` §14.1) | Stable integer keys per field, append-only, keys never reused. Emitted as a Rust table inside `ir_types.rs` and mirrored in `schema.json` |

The `fex` name environment and the pack lint's kind universe are *readings of* `schema.json`, not
separate artifacts — one file, many consumers, which is the whole point of ADR-0008.

### 17.2 Reproducibility, without a Node runtime

The generator is `fathom-schemagen`: a first-party Rust binary in this repository, built by the
pinned toolchain `35`'s attestation programme already covers. No Node (ADR-0019), no external
schema tooling (ADR-0008's alternatives table rejected them). Determinism requirements, each
tested:

1. Output depends only on the `schema/` tree bytes — no timestamps, no environment, no absolute
   paths, no map-iteration order (BTreeMap everywhere).
2. **Generated files are checked in.** CI regenerates and fails on any diff
   (`schema.codegen.stale`), so the build consumes checked-in files (`43` §1.3's build input) and
   the generator's correctness is verified rather than trusted.
3. CI runs the generator twice and byte-compares (`schema.codegen.nondeterministic`).

The cost ADR-0008 names is accepted and restated: adding a field is a codegen run and a rebuild,
not a five-minute edit. The alternative is three hand-maintained schema copies that drift, and the
drift shows up as rules that silently do nothing.

---

## 18. Validation — the gates

Every check has a stable dotted error code, stable forever — tooling and CI baselines key on
them, so renumbering codes is itself a breaking change (§21 F9). Namespaces: `schema.*` build
gates on the `schema/` tree and generated outputs; `typeset.*` workspace-side gates on service
type declarations and imports; `policy.*` workspace-load gates on the `Policy` record; `dict.*`
build gates on the statement dictionary (§19.4); `pack.*` is `63`'s and only cited here.

### 18.1 Build failures (first-party artifacts; CI, before anything ships)

| Code | Check |
|---|---|
| `schema.yaml.subset` | File violates §2.2's YAML subset |
| `schema.order.toplevel` | §2.3 ordering |
| `schema.scalar.unbound` | `scalars:` names an `impl` that does not exist or lacks the trait |
| `schema.kind.duplicate` / `schema.edge.duplicate` | Name collision anywhere in the file — the `WarpResolvesVia` precedent (`19` §5.3) |
| `schema.class.unknown-member` / `schema.class.nested` | §5 |
| `schema.enum.reserved-variant` / `schema.enum.default-unsourced` | §7 |
| `schema.identity.ext-term` / `.attr-term` / `.derived-term` / `.ambiguous-edge` | §8.2, §8.4 |
| `schema.similarity.unknown-term` | §9.2 |
| `schema.scope.absent-unshipped` | §9.5's decision |
| `schema.emit.on-inert` | `emit` other than `—` on an `emits: false` kind or a derived field |
| `schema.emit.unread` | §10.3's coverage gate — `R`/`R*` field neither read nor a `DeclaredGap` |
| `schema.emit.attr-read` | Any `reads()` set includes an attributes map (§13.4) |
| `schema.derive.unknown-fn` / `schema.infer.unknown` | §11.2, §3.4 |
| `schema.edge.l1-unpatrolled` / `schema.edge.reverse-unindexed` | §6.2 |
| `schema.platform.unknown-vendor` | §14 |
| `schema.attrtype.drift` | §13.3's table disagrees with the generated `AttrType` enum |
| `schema.version.bump-too-small` | §16.4 |
| `schema.migration.chain-broken` / `schema.migration.golden-failed` | `11` §11.5's chain completeness and byte-identical golden fixtures |
| `schema.codegen.stale` / `schema.codegen.nondeterministic` | §17.2 |
| `ext.budget.exceeded` / `ext.promotion.due` | `11` §12.4 rules 6–7, deliberately build failures, not warnings |

### 18.2 Warnings (CI-reported, never build-failing)

The word "lint" in this document means this band and only this band. A warning renders in CI
output and in `fathom schema lint`; it never fails a build, because each one flags a smell whose
legitimate cases are enumerated beside it.

| Code | Check | Legitimate case that keeps it a warning |
|---|---|---|
| `schema.identity.unexercised` | An `ImportScope` claims a kind and matches none of its declared tiers (§8.4) | Merge-exercised hand-entered kinds are exempt by rule, not by warning |
| `schema.order.inserted` | A field inserted mid-block rather than appended (§2.3) | Renumbers nothing; rewrites diff context only |
| `schema.class.singleton` | A class with one member (§5) | A rename waiting to happen, not yet wrong |

### 18.3 Workspace-side failures (load or write time; quarantine or refusal, never data loss)

| Code | Stage | Check |
|---|---|---|
| `typeset.grammar.unknown-key` | type-set import / edit | The closed grammar — any unknown key refuses the file (§13.4) |
| `typeset.attr.unknown-type` | import / write | `value_type` outside `AttrType` |
| `typeset.attr.secret-shaped` | declaration time | `value_type: Text` whose `key` or `label` matches the token list `psk`, `secret`, `key`, `password`, `passphrase`, `credential` — refused with this code (`19` §4.3). Declaration time is the only point at which it is catchable; the value is user data and cannot be inspected |
| `typeset.attr.key-reused` | import / edit | A withdrawn key redeclared with a different `value_type` — keys are stable forever, withdrawn, never deleted |
| `store.attr.unknown-key` / `store.attr.wrong-type` | write (L0) | `Service.attributes` against the `OfType` type — `19` §4.3's L0 half; missing `required` keys are L1 holes, never refusals |
| `store.constraint.<id>` | write (L0) | Any §12 `reject_write` clause; the error carries the constraint id |
| `store.derived.serialised` | write | Incoming record carries a derived field/edge — dropped to `unknown`, recomputed, reported |
| `policy.*` | workspace load | §15.4's table — always per-scheme quarantine |

**Which is which, as a rule:** anything first-party is a build failure — a shipped defect is
CI's to stop. Anything user-authored (type sets, attributes, policy) fails at load or write, is
scoped as narrowly as possible (one scheme, one file, one write), and never destroys data —
quarantine and refusal, not deletion. That is `12` §14.3's principle: from the user's position, a
thing that could not run and a thing that could not compile are the same thing, and both need the
reason named.

---

## 19. The statement dictionary content spec

ADR-0008 property 3: the statement dictionary gets its content spec in this document, because
`71` §5.7 budgets ~1,750 entries and 6–9 weeks of domain time for an artifact that otherwise has
no schema, no ID convention and no review discipline — M1's failure mode on the largest content
asset after the explainers. The runtime — trie compilation, walker budgets, backtracking — is
`14` §6.3's and is not restated.

### 19.1 What an entry is

One document binding **one vendor statement shape** to the kinds, fields and edges it asserts,
and — read backwards (`14` §6.4) — the template that emits it. The dictionary is the single
binding between vendor text and the graph: the parser's Bind layer reads it forwards, the emitter
reads it backwards, and a statement in neither direction does not exist.

### 19.2 Layout, IDs, lifecycle

- Files: `corpus/dict/<platform>/<area>.yaml` (`corpus/dict/junos-srx/security-ike.yaml`).
- IDs: `<platform>/<dotted-path>` — `junos-srx/security.ike.gateway.external-interface` —
  matching the command-corpus convention, stable forever.
- A platform renames a statement: the old entry gains `deprecated_by:` pointing at the successor
  and is never deleted while any supported `versions` range matches it.
- Entries are corpus: invariant 10 applies, `reviewed_by` is a named human, and release travels
  with `corpus_version` + content hash, not with the schema version.

### 19.3 The entry schema

`14` §6.2's field table is the normative entry schema and is incorporated by reference: `id`,
`path` (ordered segments, `$name` captures), `secret`, `binds.kind` / `binds.owner` / `binds.key`
/ `binds.field(s)` / `binds.edge` / `binds.presence`, `emit` (template, order, `Risk`), `explain`,
`versions`, `deprecated_by`, `reviewed_by`. What this section adds is the validation binding to
the schema, which `14` could not specify because this document did not exist.

### 19.4 The schema-binding gates (build failures, `dict.*`)

| Code | Check |
|---|---|
| `dict.kind.unknown` | `binds.kind` (and `binds.owner.kind`, `binds.edge.to.kind`) exists in `schema.json` |
| `dict.field.unknown` | Every bound field exists on the kind |
| `dict.field.scalar-mismatch` | The entry's declared `scalar:` equals the field's schema type |
| `dict.key.not-identity` | `binds.key`'s captures cover a declared identity tuple of the kind within its owner (`14` §6.2: the key *"feeds IR §10.3 identity"*) |
| `dict.edge.unknown` / `dict.edge.to-violation` | The edge kind exists; the resolved target kind is in its `to` set |
| `dict.edge.unhooked` | An edge-binding entry not named by the edge's `emit_dict` (§6.3), or vice versa |
| `dict.emit.placeholder` | Every `{{…}}` in the template is a declared capture, a bound field, or an owner path |
| `dict.secret.interpolated` | A `secret:`-flagged entry's template interpolates the captured value — the template must render the placeholder (`<PSK>`), never `$value`. This gate is the emit-side twin of the parser's redaction test (`11` §4.5) |
| `dict.risk.enum` | `emit.risk` is one of the three risk values, exactly (conventions) |
| `dict.explain.unknown` | The `explain:` id exists in the explainer corpus |
| `dict.layer.violation` | `binds.kind` has `layer: config` — a dictionary entry may never create a physical- or service-layer node (R-L2, `19` §2.3) |
| `dict.order.duplicate` | Two entries on one platform share an `emit.order` and a hierarchy position — emission order must be total for determinism |

Plus the fixture rule inherited from `11` §4.2: **every statement in the dictionary is a
round-trip fixture** — parsed, emitted, byte-compared modulo declared normalisation, the field
card included. A dictionary regression breaks the build, not a user's config.

### 19.5 Coverage, budget, sequencing

- **Coverage ledger, not a gate:** per platform, the ratio of statements bound to statements
  observed in the corpus's own sample configs, reported by CI on every PR. A gate would set the
  wrong incentive (deleting samples); a visible number sets the right one.
- Budget: ~1,750 entries across shipped platforms, 400–2,500 per platform (`71` §5.7 via
  ADR-0008; `14` §5). 6–9 weeks of domain time, already priced.
- **Sequencing, binding:** this section is the largest and least coupled part of `62`
  (`19` §7.4). The store needs §§4–7, 16 and the codegen; it does not need one dictionary entry.
  Ship the schema and the generated types first; grow the dictionary per platform behind the
  coverage ledger.

---

## 20. Worked examples

Everything in this section is concrete YAML in the grammar of §§4–15. Examples 20.6–20.8 carry an
explicit status marker; nothing else in this section is hypothetical.

### 20.1 `IkeGateway` — a config kind, end to end

```yaml
kinds:
  - kind: IkeGateway
    layer: config
    emits: true
    doc: |
      IKE phase-1 gateway (11 §6.7). One per peer relationship.
    fields:
      - { name: name,            type: Identifier, card: "1",    emit: R }
      - { name: peer,            type: PeerSpec,   card: "0..1", emit: R,
          doc: Address(IpAddr) or Dynamic(IkeId) — one field with two shapes. }
      - { name: version,         type: IkeVersion, card: "0..1", emit: O }
      - { name: local_identity,  type: IkeId,      card: "0..1", emit: O }
      - { name: remote_identity, type: IkeId,      card: "0..1", emit: O }
      - { name: dpd,             type: Dpd,        card: "0..1", emit: O }
      - { name: nat_keepalive,   type: Seconds,    card: "0..1", emit: O }
      - { name: no_nat_traversal, type: bool,      card: "0..1", emit: O }
      - { name: description,     type: Text,       card: "0..1", emit: O }
    identity:
      - [ owner(Device), name ]                                    # tier 1
      - [ owner(Device), peer.address, edge(ExternalInterface) ]   # tier 2 —
                                                                   # survives rename
      - [ edge_in(TunnelEndpoint via IpsecVpn), side ]             # tier 3 —
                                                                   # survives readdressing
    similarity: { name: 4, peer.address: 3, edge(ExternalInterface): 2 }  # illustrative

edges:
  - edge: ExternalInterface
    class: reference
    from: [IkeGateway]
    to: [LogicalUnit]
    out: "1"
    in: "0..n"
    reverse_index: true
    symmetric: false
    fields: []
    emit_dict: junos-srx/security.ike.gateway.external-interface   # §6.3's hook
    doc: |
      The WAN unit IKE packets leave by — an edge to a unit, never a name
      field (11 §6.7's "single most valuable typing decision").
```

The dictionary entry `junos-srx/security.ike.gateway.external-interface` (`14` §6.1) binds the
statement both ways; `dict.edge.unhooked` holds the pair together.

### 20.2 `Service` — a service kind, emits nothing, attribute-extended

```yaml
kinds:
  - kind: Service
    layer: service
    emits: false
    doc: One sold or internal service (19 §4.2). The type is the OfType edge.
    fields:
      - { name: cid,   type: Identifier, card: "0..1", emit: "—", fold: ascii_case,
          required_when: "edge(OfType).requires_cid == true",     # L1 hole, never
          doc: The carrier identifier. A name, never identity. }  #   a refusal
      - { name: reach, type: "enum { external, internal }", card: "1", emit: "—" }
      - { name: label, type: Text, card: "0..1", emit: "—" }
      - { name: in_service_on,  type: Date, card: "0..1", emit: "—",
          doc: Stored, rendered, never evaluated (75 §3.8). }
      - { name: ceased_on,      type: Date, card: "0..1", emit: "—" }
      - { name: last_confirmed, type: Date, card: "0..1", emit: "—",
          doc: Origin::Hand only. Stored, sorted, exported, never compared. }
      - { name: attributes, type: "map(Identifier, AttrValue)", card: "0..n",
          emit: "—", validated_against: edge(OfType) }
      - { name: description, type: Text, card: "0..1", emit: "—" }
    identity:
      - [ owner(Tenant), cid ]
      - [ owner(Tenant), label ]
```

`emits: false` forces every Emit cell to `—`; the `requires_cid` conditional lands as L1
requiredness through one edge hop (§12.3), which is `19` §4.6's constraint expressed in the field
declaration.

### 20.3 `Terminates` — an edge with fields

The full declaration is §6.1's example, verbatim — it was chosen as this document's edge exemplar
for exactly the reason `19` §7.4 row 20 names it: two fields (`end`, `lane`), a two-kind `to`
set, a bounded `out`, and a physical-layer meaning that exercises `emits: false` end to end.

### 20.4 The four shipped `ServiceType` declarations

```yaml
# corpus/service-types/builtin.yaml — materialised into the graph at workspace
# creation with Origin::Imported { format: Corpus } (19 §4.3.1). One mechanism,
# seeded; a user's edit is an ordinary Origin::Hand assertion and wins on merge.
service_types:
  - builtin_id: dia
    code: dia
    name: "Dedicated Internet Access"
    endpoint_cardinality: { min: 1, max: 1 }     # 1..1, not 1..2 — the provider
    endpoint_identifier_required: false          # side is where the PATH ends,
    uni_scope: global                            # not a second endpoint
    requires_cid: true
    attributes: []
    endpoint_attributes: []
    completeness: []          # the cid-when-external check is §12.2's L1
                              # constraint, not a per-type profile — no duplicate
  - builtin_id: eline
    code: eline
    name: "E-Line"
    endpoint_cardinality: { min: 2, max: 2 }
    endpoint_identifier_required: false          # operator's choice (19 §4.3.1);
    uni_scope: global                            # edit the node, Hand wins
    requires_cid: true
    attributes: []
    endpoint_attributes: []
    completeness: []
  - builtin_id: elan
    code: elan
    name: "E-LAN"
    endpoint_cardinality: { min: 2, max: null }
    endpoint_identifier_required: true           # the load-bearing detail —
    uni_scope: global                            # a UNI ID per location (77 §3.1)
    requires_cid: true
    attributes: []
    endpoint_attributes: []
    completeness: []
  - builtin_id: internal-interlink
    code: internal-interlink
    name: "Internal interlink"
    endpoint_cardinality: { min: 2, max: 2 }
    endpoint_identifier_required: false
    uni_scope: global
    requires_cid: false                          # internal services have no CID
    attributes: []                               # (19 §4.6): cid is Absent,
    endpoint_attributes: []                      # asserted, and not a hole
    completeness: []
```

### 20.5 One `Policy` document

§15.1's example is the worked policy document — it is `19` §8.2's, transcribed into the canonical
round-trip form `fathom policy show` writes, and it exercises all five segment roles' rules: two
`field` segments (one with `take: prefix(8)`), a `vendor` segment resolved through §14's
registry, and an `increment` with `alpha_when_shared` scoped to the premises.

### 20.6 Lifecycle state — a declarability demonstration

> **STATUS: NOT SHIPPED, AND NOT PROPOSED HERE.** `75` C-01 owns lifecycle state and it is
> blocked — on `03` §4.3 `N-R-3` (blocker 2), on the `11` §6.2/§13 `notes` fork (blocker 4), on
> the node-attribute-versus-schema-field fork (blocker 5), and on the tombstone reconciliation
> (`75` §3.2). The first blocker in `75` §3.6's list was *this document does not exist*; that one
> is now discharged, and the purpose of this example is to prove it: **when C-01 is decided,
> the schema-field branch of `75` §3.4's fork is declarable with the mechanisms of §§4, 7 and
> 12, with no change to this specification.** The enumeration below is the owner's two named
> states and nothing more — the list is open ("etc") and this document must not close it.

```yaml
# ILLUSTRATIVE — do not ship. A minor bump when it lands (new optional field,
# new enum: 11 §11.3 rows 3–4).
# schema/enums/lifecycle_stage.yaml
variants: [decommissioned, maintenance]     # owner-named; the enumeration is
                                            # 75 C-01 Q3's to complete
doc: |
  Unknown arm generated (§7 rule 2): a later minor adds states and old
  clients preserve them — which is what an open enumeration needs.

# in kinds: — shown on Device; the per-kind vs node-level fork is 75's
- name: lifecycle
  type: enum(lifecycle_stage)
  card: "0..1"
  emit: "—"                     # never emitted; the emit half of C-01 (13 §2.4,
                                # deactivate semantics) is a 13 change, not a
                                # schema cell
  doc: |
    Origin::Hand only; a parser may never write it. Transitions are driven
    by an explicit user action that stamps a date (75 §3.8) — a stored
    value, one clock read at the moment of the action, invariant 9 untouched.
- name: lifecycle_set_on
  type: Date
  card: "0..1"
  emit: "—"
  doc: Stamped by the transition action. Stored, rendered, never evaluated.
```

What the demonstration establishes, mechanism by mechanism: the enum with a generated unknown arm
handles the open enumeration; `emit: —` on an `emits: true` kind handles inertness; `Field<T>`
wrapping gives it provenance, history and the `11` §8.6 merge ladder for free; `52` §3.7's
generated column picker shows it with zero UI work — which is precisely the argument `75` §3.4
row `52` makes for the schema-field branch. What it deliberately does not touch: the
`absent_since` reconciliation, rule visibility (`12` §3.6), and the emit behaviour — those are
C-01's decisions, not declarations.

### 20.7 A ticket reference — a declarability demonstration

> **STATUS: NOT SHIPPED — same gate** (`75` C-02a, intent recorded; C-02b is refused outright
> and nothing here goes near it). Inert data only: typed, displayed, searched, exported; never
> fetched, never validated against anything, no egress (invariants 1 and 3 untouched, `75` §4.2).

```yaml
# ILLUSTRATIVE — do not ship. A minor bump when it lands.
- name: tickets
  type: Identifier
  card: "0..n"
  emit: "—"
  fold: ascii_case            # CHG0041234 finds chg0041234 in the finder
  doc: |
    Inert reference strings (75 C-02a). A typed home for the reference the
    corpus already tells users to write — "CKT-44812, see CMDB" (37 §2's own
    remediation) — and a privacy improvement over free-text description
    fields (37 §2.2 row 8).
```

Declarable on any kind, or on a class (§5) if C-02 decides every kind carries it. The
node-attribute branch of `75` §3.4's fork — a carrier beside `absent_since`, outside
`schema.yaml` — is *not* a `62` declaration at all, and choosing between the branches is `75`'s
open question, not this document's.

### 20.8 A user-defined E-LAN with per-location UNI IDs — inside the closed metamodel

The requirement (`77` §3.2: *"defining my own types is a must"*) met without one new type in the
schema: everything below is **values** — a `ServiceType` node and its `AttributeDecl` rows.

```yaml
# elan-metro.yaml — written by `fathom types export`, imported elsewhere with a
# reviewed diff. Copied, never referenced: no URL, no registry, no fetch
# (19 §4.3.2). The grammar is closed: any key not shown below refuses the file
# (typeset.grammar.unknown-key) — which is rows 1, 3 and 7 of §13.4's closure
# table arriving as one mechanism.
service_types:
  - code: elan-metro                       # user type: no builtin_id; identity
    name: "Metro E-LAN (jumbo)"            #   falls to tier 2, [code]
    endpoint_cardinality: { min: 2, max: null }
    endpoint_identifier_required: true     # every location gets a UNI ID
    uni_scope: global                      # the duplicate rule's scope — an
    requires_cid: true                     #   operator convention, so it is data
    attributes:
      - { key: vpls_id,      label: "VPLS ID",      value_type: Integer, required: true }
      - { key: jumbo_frames, label: "Jumbo frames", value_type: Bool,    required: false }
      - { key: cos_profile,  label: "CoS profile",  value_type: Enum,    required: false,
          enum_values: [bronze, silver, gold] }
    endpoint_attributes:
      - { key: uni_speed, label: "UNI speed",  value_type: Bandwidth, required: true }
      - { key: uni_vlan,  label: "UNI S-VLAN", value_type: VlanId,    required: false }
    completeness: [cid, in_service_on]
```

What the instance graph looks like once the operator uses it — instance data, shown to close the
loop on `77` §3.1's load-bearing detail:

```yaml
# Sketch of the resulting nodes and edges (instance data, not schema):
Service  { cid: "CID-30412", reach: external,
           attributes: { vpls_id: 30412, jumbo_frames: true } }
  --OfType-->      ServiceType[elan-metro]
  --HasEndpoint--> ServiceEndpoint { uni_id: "UNI-BNE-001", role: uni, ordinal: 1,
                                     attributes: { uni_speed: 1000000000 } }
                     --AtLocation--> Premises[...]
                     --AttachesTo--> LogicalUnit[...]
  --HasEndpoint--> ServiceEndpoint { uni_id: "UNI-TSV-004", role: uni, ordinal: 2,
                                     attributes: { uni_speed: 1000000000 } }
  --HasEndpoint--> ServiceEndpoint { uni_id: "UNI-CNS-002", role: uni, ordinal: 3,
                                     attributes: { uni_speed: 10000000000 } }
```

Every closure property is visible in the example: the per-location identifier is the built-in
`ServiceEndpoint.uni_id` field switched on by `endpoint_identifier_required` — not a user field;
`uni_speed` is a key in one declared map, typed by a closed enum variant, `NotApplicable` to any
rule that has not declared `uses_attr: [uni_speed]`; a missing required `vpls_id` is an L1 hole,
never a write refusal; and there is nowhere in the file to put an emit template, a path mode, or
a secret — an `AttributeDecl` keyed `psk_hint` with `value_type: Text` would be refused at
declaration time with `typeset.attr.secret-shaped`.

---

## 21. Failure modes

| # | Failure | Consequence | Countermeasure |
|---|---|---|---|
| F1 | A field is added in `11`/`19` prose and not here | The ADR-0008 defect this document exists to end — the field does not exist, and six subsystems disagree about it | Not CI-checkable (prose is not parseable). Review rule, binding: a PR touching a field table in `11` or `19` must touch `schema.yaml` or say why not. The `82` §15 pair (§3.4) is the standing example |
| F2 | A derived field or edge gets serialised | Two sources of truth for one value; a stale derivation survives in a record and diverges from recompute | The store refuses (§11.2, `store.derived.serialised`); `19` §12 row 1's guard, generalised to fields |
| F3 | Codegen output drifts from `schema.yaml` in a way the build does not catch | ADR-0008's own revisit trigger — the codegen is not the mechanism it claims to be | `schema.codegen.stale` + double-build comparison (§17.2). If it fires persistently, ADR-0008 says the Rust types become the source, and that is the honest exit |
| F4 | The bump checker is bypassed (a change lands with a hand-declared version) | An old client opens a workspace it cannot safely read, believing it can — `11` §11.4's preserve-mode contract silently voided | `schema/released/` snapshots are append-only in CI; `schema.version.bump-too-small` runs on every PR, no override label exists |
| F5 | An `AttributeDecl` is deleted rather than withdrawn (by hand-editing an export file and re-importing) | Stored values orphaned; a taxonomy silently drops data | Import treats a missing previously-known key as `withdrawn: true`, never as deletion; `typeset.attr.key-reused` blocks re-use with a new type |
| F6 | A quarantined naming scheme is read as a disabled one | The operator believes a scheme is enforcing and it is not compiling | Quarantine surfaces in `12` §8.4's "could not evaluate" band with the reason and path named — never silent, never whole-policy (§15.4) |
| F7 | The statement dictionary and an emitter disagree (dictionary edited, `reads()` not regenerated) | An emit template renders a field the emitter never reads, or vice versa | `schema.emit.unread` and `dict.edge.unhooked` triangulate; the round-trip fixtures catch the byte-level residue (§19.4) |
| F8 | The two unreadable `AttrType`s (`InterfaceAddress`, `Date`) get "temporarily" mapped onto `Value` variants to unblock a rule | `11` §4.3's *"most common modelling bug in this domain"* committed permanently inside the extension mechanism | The refusal is in §13.3's table with its reasoning; the gate `schema.attrtype.drift` fails on the enum change; the rule author's path is `NotApplicable` plus a feature request against `12`, not a mapping |
| F9 | Error codes are renamed or renumbered during a refactor | Every CI baseline, suppression of a lint, and support document keyed on the old code breaks silently | Codes are stable forever (§18 preamble). A wrong code gets a successor and a `deprecated_by`, the same discipline as dictionary IDs |
| F10 | §19 holds the rest hostage — the schema does not ship until the dictionary is "done" | The store, the type checker and the pack lint stay blocked on 1,750 entries of domain time | The sequencing rule is normative (§19.5, `19` §7.4), and the coverage ledger exists so "done" is a number, not a feeling |

---

## 22. Open decisions

| # | Decision | Owner | Note |
|---|---|---|---|
| 1 | `Clli` accepted lengths and validation depth | `62` §3.3 | Marked `<!-- VERIFY -->`; charset-only until confirmed |
| 2 | The full `HostService` variant list | `62` §3.4 with `11` | The unknown arm makes the gap survivable; the SRX dictionary work will surface the list |
| 3 | Comparing stored `Date`s in rules | `19` §13 od 3 | *No, for now* — `Date` is not rule-readable (§13.3). Reopens if a completeness profile genuinely needs "installed before" |
| 4 | §2.2's single-line flow rule contradicts real declarations | `62` §2.2 vs the shipped tree | Writing `schema/` exposed it: field declarations with docs do not fit one line, and §20's own worked examples strain the rule. Either §2.2 permits bounded multi-line flows or the layout moves to block style. Found by the first instance of this grammar; must be settled before the parser is written |
| 5 | `Link.media`'s `Unknown` variant collides with the generated-arm rule | `11` §7.4 vs `62` §7 | `11` declares `media {Copper, Fibre, Dac, Virtual, Unknown}`; `62` §7 generates unknown arms and forbids declaring them. One of the two must yield — probably `11`, whose `Unknown` predates the generation rule. Filed here because the tree had to pick a side to parse at all |
| 4 | Whether per-kind similarity weights need per-platform variation | `12`, when the matcher is tuned | The grammar admits it (a weights map per platform) but nothing declares it until a fixture demands it |
| 5 | The lifecycle enumeration, its shape (one axis or two), and its home | `75` C-01, gated on `03` §4.3 `N-R-3` | §20.6 demonstrates declarability only. This document must not close the list |
| 6 | The ticket-reference fork: per-kind field, class-wide field, or node-level attribute | `75` C-02a / `11` | §20.7 shows the field branch; the node-attribute branch bypasses this file entirely |
| 7 | The `notes` contradiction (`11` §6.2 vs §13) | `11` | Until resolved, this file declares neither (§4.2) |
| 8 | An importer asserting `Absent` for a genuinely closed-world source | `62` §9.5 with `11` §8.5 | The grammar value exists, gated off. Reopens with the first source that is honestly closed-world |
| 9 | The explainer *file format*'s home | ADR-0008 property 2 names the move next to `61`/`63`; the document is unwritten | Not this file's content; recorded so the gap `83` M2 names is not re-lost |
| 10 | The ADR that takes `76` X3 option (a) or (b) | The owner, before `19` lands | `19` §7.5: until it exists, ADR-0030's trigger has fired at ten kinds and the contradiction is live. This document declares the kinds anyway per `19` §7.4.1's DECISION — specification is not the same act as landing the bump, and the bump checker (§16.4) is where the block physically engages |

---

## 23. Sources consulted

| Source | Used for |
|---|---|
| ADR-0008 | The mandate, the six consumers, the three properties, the negative consequences §17.2 and §21 F3 answer |
| `19` §7 (all), §1.1–1.3, §2.2–2.3, §4.2–4.6, §5, §8, §9.3 | The requirements sheet: §7.4's contents list, the closed metamodel, the three mechanisms, the five scalars, the Policy grammar, ImportScope |
| `11` §4, §5.3, §6.1–6.2, §6.7, §7.1–7.5, §8.5–8.6, §9.1–9.5, §10.1–10.5, §11 (all), §12.1, §12.4, §13, §14.1 | The scalar catalogue and trait, Presence, the kind test, identity, the bump table, schema-as-data, classes, the extension bag |
| `12` §3.4–3.7, §5.3–5.4, §6.3–6.6, §8.4, §11, §15.3 | Value lattice, read sets, invalidation, gates 5a/5b/6, suppressions |
| `13` (DeclaredGap, `reads()`, ADR-0007's mitigation) | §10.3, §17.1 |
| `14` §5, §6 | The statement dictionary entry schema and runtime, §19 |
| `17` §4.2, §5.8, §8.1, §12.3–12.4 | The Policy record class, version-claim/hash-fact, merge |
| `18` §3 | Declaration order is diff order |
| `33` §6.4, ADR-0016 | `merge_class`, dormant |
| `35`, ADR-0017, ADR-0019 | Reproducibility and the no-Node constraint on §17 |
| `37` §2.2 | The free-text/personal-data review obligation on attributes and `PostalAddress` |
| `43` §1.3 | The schema as build input |
| `52` §3.7, §6.2 | The generated column picker; the `RunState` precedent cited in §20.6's sources |
| `61` (structure), `63` §5.1–5.3, §16 | The sibling formats; the platform registry and enum map rehomed here; overrides rehomed to Policy |
| `71` §5.7 | The statement dictionary budget |
| `75` §3 (C-01), §4 (C-02) | §20.6–20.7's gates and their honesty |
| `76` §4.4, §7.3, X3, X5, X11 | Naming, the vendor cross-check, the ADR-0030 response |
| `77` §2–§3, §7 | The owner's requirements the service half serves |
| `82` §15 | `aggregate_device_count` / `reth_count`, and the class of defect §10.3 converts to CI |
| `83` §10 M1–M3 | Why this document exists and what it must contain |
| ADR-0007, ADR-0010, ADR-0013, ADR-0028, ADR-0030 | Edges, identity recovery, the manifest, the trust root, the break trigger |
| RFC 3339, RFC 4360, RFC 5952 | `Date` canonical form; `RouteTarget` semantics; IPv6 canonical text |

---

## 24. Disagreements

**Disagreement 1 — the five new scalars are defined in the wrong document, and `19` §7.4 told me
to do it.** `19` §7.4 row 3 instructs `62` §3 to *define* `Date`, `LatLon`, `Clli`,
`PostalAddress`, `AttrValue`, `Bandwidth` and `TzName` rather than bind them, because `11` §4.3
does not carry them. I complied (§3.3–3.4), and the result strains this document's own precedence
rule: scalar *design* is intent, and intent is `11`'s. Two documents now hold catalogue rows.
Proposed replacement: at `11`'s next edit, its §4.3 catalogue absorbs §3.3's and §3.4's rows
verbatim, and `62` §3 reverts to a pure binding table. Until then, §3.3–3.4 are marked as
transcription candidates and any conflict resolves in `11`'s favour per §1.

**Disagreement 2 — the residue guard constants as schema data buys determinism and sells tuning
agility, and the price should be named.** `19` §7.4 row 9 puts 0.75 / 0.15 / 4096 in the schema
so a retune is versioned and hash-visible. Agreed, and specified that way (§9.3). The cost row 9
does not state: every matcher retune is now a schema edit — a minor bump, a regenerated artifact
set, and a released snapshot — for three numbers that will be tuned repeatedly while the fixture
suite matures. I keep the design and log the objection rather than adding a side channel: a
constants file outside the hash would be exactly the invisible retune the row exists to prevent.

**Disagreement 3 — `19` §7.4 row 6's "emit template hook" on edges is one drift away from being a
defect, and this document narrows it.** Read literally, row 6 invites an emit template *in* the
edge declaration, which duplicates the statement dictionary (`14` §6.4: the dictionary is the
emitter's table, read backwards). §6.3 therefore specifies the hook as a cross-checked
*reference* (`emit_dict`), not a template, with `dict.edge.unhooked` holding both sides together.
If `19`'s author intended an inline template, that intent is refused here and this entry is where
to argue it.
