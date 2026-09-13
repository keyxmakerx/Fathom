# 11 — The intermediate representation

> **Status:** Proposed

This document specifies the typed graph. §5.1 of the owner's brief calls it *"the entire
bet of the project"*, and it is: `render`, `emit`, `lint`, `explain`, `verify` and `table`
are all projections of this one structure. If the graph is wrong, six features are wrong
and the fix is a rewrite, not a patch.

Everything here is written to be built from. Where I am uncertain about a vendor detail I
have marked it inline rather than guessed.

---

## 0. Contents

| § | |
|---|---|
| 1 | The forces the schema has to survive |
| 2 | Batfish — what I took and what I rejected |
| 3 | Nodes, edges, fields: the shape decision |
| 4 | The semantic scalar types |
| 5 | Presence: the four-state field |
| 6 | The node kind taxonomy |
| 7 | The edge taxonomy |
| 8 | Provenance |
| 9 | Partiality, validity and holes |
| 10 | Identity, stability and re-identification |
| 11 | Schema evolution and migration |
| 12 | Multi-vendor pressure and the extension bag |
| 13 | Core Rust definitions |
| 14 | Storage, size and complexity |
| 15 | Worked example — SRX side 1, end to end |
| 16 | What this design costs |
| 17 | Open decisions |
| 18 | Deviations from §5.1 of the brief |
| 19 | Disagreements |

---

## 1. The forces the schema has to survive

A schema is the sum of the things it is not allowed to break under. These are Fathom's,
in the order they constrain the design.

| # | Force | Where it comes from | What it forces |
|---|---|---|---|
| F1 | The graph is almost always incomplete | §6.4 — inventory and intent are one schema, partially populated | A field must distinguish *unset* from *unknown*. Four-state `Presence` (§5). |
| F2 | Everything must round-trip back out as config | §1 — `config = emit(graph, vendor)` | No lossy normalisation. Vendor-syntactic values keep their raw form (§4.6). |
| F3 | Every value must be able to say where it came from | §5.1, §5.3, §6.5 | Provenance per field, not per node (§8). |
| F4 | Renaming must not invalidate anything | Invariant 7 | Opaque ULID identity; names are ordinary fields (§10). |
| F5 | The same workspace opens in a build years newer | §6.4 — a document the user owns | Versioned schema, total migrations, unknown-data preservation (§11). |
| F6 | Rules are data, one engine, `platforms` predicate | Invariant 5 | Kinds and fields must be addressable declaratively from YAML, so the schema is itself data (§11.5). |
| F7 | Byte-identical output for the same input | Invariant 9 | Deterministic iteration order, deterministic conflict resolution, no hash-map ordering leaking into emit (§14.3). |
| F8 | No credential ever enters the application | Invariant 3 | A scalar type that structurally cannot hold a secret (§4.5). |
| F9 | It runs in WASM in a browser tab | §8 | Memory budget is real. Provenance is the thing that blows it (§14.2). |
| F10 | A `reth` is not a LAG | §2.1 | Vendor-neutral does not mean lowest-common-denominator. Separate kinds where behaviour differs (§12.1). |

F1 and F3 are the two that make this schema different from every other network model I
looked at. Everything else is engineering.

---

## 2. Batfish — what I took and what I rejected

§3.1 of the brief instructs that Batfish's vendor-independent model *"is the single best
reference available for the Fathom IR and should be studied closely before the schema is
written."* Here is the result of doing that, stated explicitly so a reviewer can check my
work.

### 2.1 Taken

| Taken | Batfish form | Why |
|---|---|---|
| The crypto object chain decomposition | `IkePhase1Proposal` / `IkePhase1Policy` / `IkePhase1Key`; `IpsecPhase2Proposal` / `IpsecPhase2Policy`; `IpsecPeerConfig` | Batfish arrived at almost exactly the Junos six-object chain on side 1 of the field card, *from the Cisco and PAN side as well*. That is independent evidence the chain is the correct decomposition of IPsec and not a Juniper accident. Fathom's `IkeProposal → IkePolicy → IkeGateway → IpsecProposal → IpsecPolicy → IpsecVpn` is the same decomposition under the owner's names. |
| Default actions as modelled fields | node properties `Default_Cross_Zone_Action`, `Default_Inbound_Action` | The implicit deny at the end of a Junos zone pair is a *fact about the policy set*, and a rule needs to read it. Fathom models it on `PolicySet.default_action`, never as an emitter assumption. |
| Interface property vocabulary | `Access_VLAN`, `Admin_Up`, `All_Prefixes`, `Bandwidth`, `Channel_Group`, `Description`, `Incoming_Filter_Name`, `MTU`, `Outgoing_Filter_Name`, `Primary_Address`, `VRF`, `Zone_Name` | Field names that already survived multi-vendor contact. Reusing them costs nothing and makes a future Batfish importer a mapping table rather than a design exercise. |
| Device-level service lists | `DNS_Servers`, `NTP_Servers`, `TACACS_Servers`, `SNMP_Trap_Servers` | Side 4 of the field card: *"Clock skew kills certificates. Check NTP before re-issuing anything."* NTP is in the IPsec failure domain, so it is in the schema. |
| The static session-status idea | `IPSec Session Status` returns one of `IPSEC_SESSION_ESTABLISHED`, `IKE_PHASE1_FAILED`, `IKE_PHASE1_KEY_MISMATCH`, `IPSEC_PHASE2_FAILED`, `MISSING_END_POINT` | Proof that "would these two configured ends actually negotiate" is answerable statically. Fathom computes the same class of answer as an **inferred** node/finding when both sides of a `Tunnel` are modelled — not as device state, because Fathom never touches a device. |

### 2.2 Rejected

| Rejected | Why | What it costs to reject |
|---|---|---|
| Keying objects by name within a device (`Map<String, IpAccessList>`) | Invariant 7. A rename must not invalidate a rule, a suppression or a diagram element. A name-keyed map makes rename a delete-plus-create. | Every lookup that a vendor writes as a name becomes an ID lookup through an index (§3.3). Emitters get more verbose. |
| No provenance | Batfish derives the model from config text and keeps parse warnings, not lineage. Fathom's teaching pillar requires the originating line to be attached to the value (§5.3 of the brief). | 2–5× storage over the data itself (§14.2). |
| The total-population assumption | A Batfish `Configuration` is built from a complete config. A half-populated one is not a thing it reasons about. Fathom's is partial by construction (§6.4). | Four-state `Presence`, four-outcome rule evaluation, and an emitter that has to report blockers. This is the single largest structural divergence in this document. |
| Control-plane and data-plane simulation | Batfish reconstructs RIBs, FIBs and forwarding. That is a large, permanently-maintained surface and it does not fit a WASM client budget. | Fathom cannot answer "where does this packet go". It can answer "is there a route configured at `st0.0` for the remote prefix", which is failure mode #4 on side 1 of the field card and covers most of the value. `LearnedRoute` exists only to hold inferred resolution facts, never a simulated RIB. |
| A separate vendor-specific representation layer (`representation.cisco.CiscoConfiguration` → VI `Configuration`) | Batfish is one-directional: config in, model out. Fathom is bidirectional. Two parallel hierarchies means emit is a second translation and the two drift. | One model must absorb vendor-specific knobs that do not generalise. That is what §12.4's extension bag is for, and it is the riskiest thing in this document. |
| Question-per-analysis API surface | Invariant 5: findings are data, one engine. | Nothing. |

---

## 3. Nodes, edges, fields: the shape decision

### 3.1 The question

Three shapes were candidates.

| Shape | Relations live in | Example |
|---|---|---|
| A. Reified | Nodes. Every relation is a node with two endpoint references. | `ZoneBinding` node pointing at `Zone` and `LogicalUnit` |
| B. Field references | Node fields holding `NodeId`. | `IpsecVpn.ike_gateway: NodeId` |
| C. First-class typed edges | A separate typed, identified, provenanced edge collection. | `IpsecVpn --UsesIkeGateway--> IkeGateway` |

The owner's §5.1 tree is ambiguous between A and B — it shows `ZoneBinding` and
`Membership` as tree nodes, but shows `Binding → LogicalUnit` as an arrow.

### 3.2 DECISION — first-class typed edges (C), and node fields never hold a `NodeId`

Reasoning, in the order the arguments actually bit:

1. **A relation needs its own provenance.** *"The parser saw `set security zones
   security-zone WAN interfaces reth0.0 host-inbound-traffic system-services ike` on
   2026-03-14"* is a fact about the binding, not about the zone and not about the unit.
   Under shape B that provenance has to be squeezed onto whichever side happens to hold
   the field, which then means the *direction of the reference* determines where lineage
   lives. That is arbitrary and it breaks the moment the reverse direction is what the
   parser saw.
2. **A relation needs its own fields.** Piece #3 of the five plumbing pieces is
   `host-inbound-traffic system-services ike`, and in Junos that is configured *per
   interface within the zone*. It belongs to the binding. Shape B has nowhere to put it
   without inventing shape A anyway.
3. **A relation needs its own ID.** Invariant 7 says every edge carries a stable opaque
   ID. Rule `zone.host-inbound.ike-missing` produces a finding that has to attach to
   *something*, and the honest target is the binding, not the zone.
4. **Uniform traversal.** Rules, the diagram, the explainer and the emitter all want the
   same primitive: "give me everything related to this element, typed". Under B, half the
   relations are field reads and half are reverse-index scans, and every consumer needs
   both code paths.

Shape A gets 1–3 right and fails on ergonomics: every traversal becomes two hops, the
node kind enum doubles in size with things that are not concepts an engineer recognises,
and `Device → Interface` containment becomes a node, which is absurd.

**So: edges are first-class. They have a kind, a ULID, a from, a to, optional typed
fields, and provenance. Node bodies contain scalars only.**

### 3.3 The cost, stated

- Emitters lose `vpn.ike_gateway` and gain `g.out_one(vpn, EdgeKind::UsesIkeGateway)?`,
  which is fallible where a field read was not. Mitigation: codegen typed accessors from
  the schema with cardinality baked into the return type — `Rel1<IkeGateway>` for `1`,
  `RelOpt` for `0..1`, `RelMany` for `0..n` — so the fallibility appears exactly where
  the schema says the relation is optional and nowhere else.
- The graph must maintain forward and reverse adjacency indexes keyed by
  `(node, edge_kind)`. That is roughly 24 bytes per edge per direction on top of the edge
  itself, and it must be rebuilt or incrementally maintained on every mutation.
- Serialised workspaces are larger and less human-readable than a nested document, because
  the containment tree is exploded into an edge list. Mitigation is a *rendering* concern,
  not a storage one: the workspace inspector re-nests containment for display (§14.4).

### 3.4 Three classes of edge

Every edge kind is declared in exactly one class, and the class determines lifecycle.

| Class | Meaning | Direction | Lifecycle | Emitted? |
|---|---|---|---|---|
| **Containment** | The target cannot exist without the owner. `Device` owns `Interface`; `Interface` owns `LogicalUnit`. | Parent → child, always | Deleting the owner deletes the target. Exactly one containment in-edge per node (the containment edges form a forest). | Implicitly — containment is what produces the config hierarchy |
| **Reference** | Two independently-existing nodes are related. `IpsecVpn` uses `IkeGateway`. In Junos this is a name; in the graph it is an ID. | **Dependent → dependency**, always, regardless of which way the vendor writes it | Deleting the dependency leaves a dangling reference, which is an L0 validity error; the store converts it to a `Broken` marker rather than silently dropping it | Yes — as the vendor's name-reference syntax |
| **Derived** | Produced by an inference rule, never by a human or a parser. `StaticRoute --ResolvesVia--> LogicalUnit`. | Whatever the inference declares | Recomputed; never merged, never synced, never edited. Deleted and rebuilt when inputs change. | **Never** |

Two rules follow, and they are the ones that stop the graph turning into soup:

> **Edge direction follows the semantic dependency, never the vendor's syntax.**
> Junos writes `set security ipsec vpn VPN-B bind-interface st0.0`; IOS writes
> `tunnel protection ipsec profile P` on the interface. Both produce
> `IpsecVpn --BindsInterface--> LogicalUnit`. The emitter reverses it where the vendor
> does. This is a graph decision made once, not per platform.

> **An edge may carry fields but may never be an endpoint.** The moment a third thing
> needs to reference a relation, that relation is promoted to a node and its old edge
> becomes two containment edges. `Tunnel` is the worked example of this: a tunnel started
> life as an edge between two `IpsecVpn`s and had to be promoted because
> `TrafficSelector`, the diagram overlay layer and findings all need to address it.

### 3.5 Derived edges and elements are not part of the document

**DECISION — derived nodes and edges live in a separate arena and are never serialised.**
They carry `Origin::Inferred` provenance, they are recomputed on load, and they are
excluded from the workspace ciphertext. Reasons: they are a pure function of the asserted
graph plus the corpus version, so storing them means storing a cache that can disagree
with its inputs; and they would otherwise participate in merges, where they generate
conflicts that are meaningless.

Cost: opening a workspace pays the inference pass every time. For the inference rules
listed in §9.5 that is a linear scan plus a few index lookups, but it puts a hard ceiling
on how expensive an inference rule is allowed to be, and that ceiling will be hit.

---

## 4. The semantic scalar types

### 4.1 The rule

**No field in this schema has type `String` unless the thing it holds is genuinely free
prose** (a description, a note, a site address). Everything else gets a semantic scalar:
a type that knows how to parse itself from vendor text, validate itself, and emit itself
back as vendor text.

The reason is not tidiness. It is that a raw string defers every question to the emitter,
and there are `N` emitters. `dh-group` as a string means the Junos emitter, the PAN
emitter and the IOS emitter each carry their own opinion of what `group14` means, and a
rule that wants to say "DH group 5 is legacy" has to string-match three spellings. As a
`DhGroup` enum with an IANA number, the rule reads a number and each emitter owns exactly
one token table.

### 4.2 The round-trip contract

Every semantic scalar `S` implements:

```rust
pub trait Scalar: Sized + Clone + Eq + Ord + core::fmt::Display {
    /// Vendor text -> value. `plat` selects the token table.
    fn parse(text: &str, plat: PlatformId) -> Result<Self, ParseError>;

    /// Value -> vendor text. Returns `Unsupported` when the platform has no
    /// spelling for this value at all (e.g. `DhGroup::Ecp521` on a box that
    /// does not implement it) rather than emitting something plausible.
    fn emit(&self, plat: PlatformId) -> Result<CompactString, EmitError>;

    /// Platform-independent canonical form, used for equality across
    /// platforms, for diffing, and for the deterministic ordering in
    /// invariant 9.
    fn canonical(&self) -> CompactString;

    /// Semantic constraints that are not type errors: ranges, reserved
    /// values, deprecations. Never a hard failure — returns findings-shaped
    /// violations that the rule engine may or may not surface.
    fn validate(&self, ctx: &ValidateCtx) -> SmallVec<[Violation; 0]>;
}
```

Three laws, all property-tested with `proptest`, all enforced in CI:

| Law | Statement | Why it matters |
|---|---|---|
| **L1 — parse ∘ emit = id** | For all `x: S` and all `p` where `emit` succeeds: `S::parse(x.emit(p)?, p)? == x` | Without this, a graph that is emitted and re-parsed drifts. That is exactly the workflow in §6.3 (paste in, edit, emit out). |
| **L2 — emit ∘ parse = normalise** | For all vendor text `t` that parses: `S::parse(t,p)?.emit(p)?` differs from `t` only by the platform's declared normalisation (case folding, `group14` vs `14`, leading-zero trimming) | Any other difference is a lossy parse and must be caught before it reaches a user's config. |
| **L3 — canonical agreement** | `a.canonical() == b.canonical()` iff `a == b` | Cross-platform comparison ("both ends must agree — every value, exactly", side 2 of the field card) depends on this. |

There is a fourth test that is not a property test and is more valuable than all three:
**every command and config line in the corpus, including all four sides of the field card,
is a fixture.** Each line is parsed, the resulting values are emitted, and the result must
match the source line byte-for-byte after the declared normalisation. When a parser regresses,
the field card breaks the build.

### 4.3 The scalar catalogue

| Scalar | Rust representation | Canonical form | Notes and traps |
|---|---|---|---|
| `Ip4Addr`, `Ip6Addr`, `IpAddr` | `std::net::*` | dotted-quad / RFC 5952 lowercase compressed | IPv6 text has many spellings; canonicalise on parse or comparison breaks |
| `IpPrefix` | `ipnet::IpNet` | network address with **host bits zeroed** + `/len` | `10.2.0.0/16`. Setting host bits is a parse error |
| `InterfaceAddress` | `{ addr: IpAddr, len: u8 }` | host address + `/len`, **host bits preserved** | `10.255.0.1/30` on side 1 piece #1. This is a *different type* from `IpPrefix` and conflating them is the most common modelling bug in this domain. A `StaticRoute.destination` is an `IpPrefix`; an `Address.value` is an `InterfaceAddress` |
| `IpRange` | `{ lo: IpAddr, hi: IpAddr }` | `lo-hi` | PAN address objects; Junos `address-range` |
| `MacAddress` | `[u8; 6]` | `aa:bb:cc:dd:ee:ff` lowercase | Junos writes `aa:bb:cc:dd:ee:ff`, Cisco `aabb.ccdd.eeff` |
| `IpProtocol` | `u8` + name table | numeric | ESP is 50. AH is 51. Keep the number as truth, the name as display |
| `L4Port`, `PortRange` | `u16`, `{lo,hi}` | numeric | IKE 500, NAT-T 4500 |
| `VlanId` | `u16` newtype, 1..=4094 | numeric | 0 and 4095 reserved; some platforms reserve more |
| `Asn` | `u32` | asplain | asdot accepted on parse, asplain on canonical |
| `Mtu` | `u16` newtype | numeric | See §4.4 — the value is meaningless without knowing which layer it measures |
| `Seconds` | `u32` newtype | numeric | `lifetime-seconds`; per-field range constraints live in the schema, not the type (`180..=86400` for Junos IKE/IPsec lifetimes, side 2) |
| `Kilobytes` | `u64` newtype | numeric | `lifetime-kilobytes`. Side 2: *"a busy tunnel rekeys far more often than the clock suggests"* |
| `DhGroup` | enum with IANA transform-type-4 numbers | the number | `Modp2048 = 14`, `Ecp256 = 19`, `Ecp384 = 20`, `Modp1536 = 5`, `Modp1024 = 2`. Junos spells them `group14`; PAN `group14`; IOS `group 14`. One enum, three token tables |
| `EncryptionAlgorithm` | `{ family, key_bits, mode, aead: bool }` | `aes-256-gcm` style | The `aead` flag is load-bearing: side 1 says *"GCM is AEAD, so there is no separate authentication-algorithm"*. That is a schema constraint (§6.7), not emitter trivia |
| `IntegrityAlgorithm` | enum | `hmac-sha-256-128` style | Must be `Absent` when the encryption algorithm is AEAD |
| `AuthMethod` | enum `{PreSharedKeys, RsaSignatures, EcdsaSignatures}` | token | |
| `IkeVersion` | enum `{V1Only, V2Only, V1OrV2}` | token | Junos `version v2-only`. Side 2: `mode` is silently ignored under v2-only |
| `IkeId` | enum `{ Inet(IpAddr), Fqdn(Fqdn), UserFqdn(Emailish), Der(OpaqueDn), KeyId(Bytes) }` | tagged | `local-identity inet 198.51.100.5`, `dynamic hostname site-b.example.net` |
| `Identifier` | `CompactString` + per-platform charset and length rules | as written | Object names: `IKE-P1`, `VPN-B`. Validated, never normalised — case is significant on some platforms |
| `InterfaceName` | See §4.6 | see §4.6 | The hard one |
| `OsVersion` | See §4.7 | see §4.7 | Required by §5.2's `versions` predicate |
| `Timestamp` | `u64` ms since epoch | RFC 3339 UTC, ms precision | Same epoch and precision as ULID, deliberately |
| `Fqdn` | validated label list | lowercase, no trailing dot | |
| `RouteDistinguisher` | `{ admin, assigned }` | `65000:100` / `198.51.100.1:100` | Type 0 and type 1 forms |
| `SecretPlaceholder` | See §4.5 | `<LABEL>` | Cannot hold a secret. Structural, not policy |
| `Text` | `String` | as written | The only free-string type. Descriptions and notes only. Never parsed, never emitted into a position where syntax matters without escaping |

### 4.4 `Mtu` is not a number

Side 4 of the field card:

> *"On SRX the physical MTU includes L2 overhead; the logical-unit MTU is the IP MTU.
> Different numbers for the same link — confirm which layer you are reading before
> comparing against a peer."*

So `Mtu` alone is a bug factory. The schema carries the layer with the value:

```rust
pub struct Mtu { pub bytes: u16, pub layer: MtuLayer }
pub enum MtuLayer { L2Frame, L3Payload }
```

`Interface.mtu` is `Mtu<L2Frame>`-shaped by schema constraint; `LogicalUnit.family_mtu`
is `L3Payload`. A rule comparing two MTUs across a link must compare same-layer values or
it returns `Unevaluable` (§9.3), not a wrong answer. This single distinction is worth more
than most of the rest of the catalogue, because it is the one that produces confident
wrong findings rather than obvious errors.

### 4.5 `SecretPlaceholder` — invariant 3 in the type system

Invariant 3 says the application never accepts a credential. That is normally enforced by
discipline, which fails. Here it is enforced by the type:

```rust
/// A field that is *designed* to be a hole. Constructing one from
/// arbitrary text is not possible — the only constructors take a label
/// and optional non-recoverable metadata.
pub struct SecretPlaceholder {
    label: SecretLabel,          // Psk | CertKey | SnmpCommunity | TacacsKey | Password
    hint: Option<SecretHint>,    // where the human keeps it: "vault: net/ipsec/site-b"
}

pub struct SecretHint(String);   // a pointer, never a value. Length-capped at 120.
```

There is no `SecretPlaceholder::from_value`. There is no `Deserialize` impl that accepts
a string in the value position; the serialised form is
`{ "label": "psk", "hint": "vault: net/ipsec/site-b" }` and anything else is a
deserialisation error. The parser, on seeing
`set security ike policy IKE-POL pre-shared-key ascii-text "SomeRealSecret"`, must
construct `SecretPlaceholder { label: Psk, hint: None }` and **must not** retain the
matched text in the raw-line provenance either — the parser redacts the token span before
the capture blob is stored (§8.4). That redaction is the single most security-relevant
line of code in the parser and it gets its own test.

Emits as `pre-shared-key ascii-text "<PSK>"`. That emitted line is a *correct* emit, not a
blocked one (§9.4).

The `hint` field is a compromise and I want to name it: it is a free string the user
controls, it will end up containing something sensitive eventually, and the only defences
are the length cap and a UI that says so. The alternative — no hint at all — means the
engineer has no record of *which* PSK, which is a worse failure in practice.

### 4.6 `InterfaceName` — the vendor-syntactic one

An interface name is simultaneously an opaque vendor token that must round-trip exactly,
and a structured thing that cross-vendor rules need to reason about ("is this a WAN-facing
physical port", "is `st0.0` bound to a zone").

**DECISION — a lens, not a choice.** Keep both, with a stated precedence.

```rust
pub struct InterfaceName {
    /// Exactly as written by the vendor / the user. Wins on emit, always.
    raw: CompactString,
    /// Best-effort structure. `None` when the platform's grammar did not match.
    parsed: Option<StructuredIfName>,
    plat: PlatformId,
}

pub struct StructuredIfName {
    pub family: IfFamily,     // Ge Xe Et Ae Reth St Lo Irb Fxp Vlan Tunnel PortChannel Ethernet Bond Vti ...
    pub location: IfLocation, // Junos { fpc, pic, port }; Cisco { slot, subslot, port }; Index(u32)
    pub sub: Option<u32>,     // the unit / sub-interface, when the token carries it
}
```

Rules:

| | |
|---|---|
| `raw` wins on emit | Byte-for-byte, always. A structured re-render is never emitted. |
| `parsed` wins on comparison | Two names are the same interface iff their `parsed` forms are equal *and* they belong to the same `Device`. Where either side is `None`, comparison returns unknown, not false. |
| Disagreement is a validity error | If `parsed` is `Some` and re-rendering it does not reproduce `raw` modulo declared normalisation, that is an L0 error caught at write time. |
| `parsed: None` degrades to `Unevaluable` | Any rule that needs structure returns `Unevaluable(Gap::UnparsedName)` rather than guessing. This is the correct behaviour for a name from a platform whose grammar Fathom does not yet know. |

Cost: two sources of truth for one value, and a precedence rule that every author has to
remember. I accept it because the alternative — canonicalising the name — silently
rewrites a user's config, and the alternative to *that* — keeping only `raw` — means the
§2.1 vocabulary problem (`ae` / `port-channel` / `bond` / `reth`) is unsolvable in rules.

Note that `LogicalUnit` does **not** store `st0.0`. It stores unit index `0` and is
contained by a `TunnelInterface` named `st0`. The token `st0.0` is *rendered* by the
emitter from the pair. Storing the joined form would put the same fact in two places, and
they would diverge.

### 4.7 `OsVersion` — required by rule version predicates

§5.2 of the brief: *"Version predicates are not optional. Junos syntax differs meaningfully
between 15.x, 21.x and 23.x. A rule that is correct on one and wrong on another is worse
than no rule."*

Junos versions are not semver. Neither are IOS-XE's or PAN-OS's. So:

```rust
pub struct OsVersion {
    plat_family: PlatformFamily,   // selects the comparator
    raw: CompactString,            // "21.4R3-S4.9"
    parts: SmallVec<[VersionPart; 6]>,
}
pub enum VersionPart { Num(u32), Alpha(CompactString) }
```

Ordering is **per-family**, implemented as a comparator selected by `plat_family`, not as a
single `Ord` impl. A `VersionRange` in a rule is a set of half-open intervals over that
family's order, and a rule whose `versions` predicate names a family that does not match
the node's platform is `NotApplicable`, never `Passed`.

**Comparing two `OsVersion`s from different families is a compile-time-impossible
operation**, not a runtime one: the comparator is obtained from the family, and there is
no `PartialOrd` impl on `OsVersion` itself.

<!-- VERIFY: the exact ordering rules for Junos service releases (R3-S4.9 vs R4) and for
     PAN-OS maintenance releases. These need a written comparator spec per family with
     test vectors taken from vendor release notes before any version-predicated rule ships. -->

---

## 5. `Presence` — the four-state field

### 5.1 Why `Option<T>` is wrong here

The brief's own example rule is `condition: "perfect_forward_secrecy == null"`. Under
`Option<T>`, `None` means both of these:

- *We parsed the whole `security ipsec policy IPSEC-POL` stanza and there is no
  `perfect-forward-secrecy` line.* → the rule should fire. This is the classic failure on
  side 2: *"PFS on one side, absent on the other → Phase 2 fails while Phase 1 stays up."*
- *The user typed a device hostname into a form and nothing else.* → the rule must say
  nothing. Firing here is how a linter gets muted in a week.

These are opposite outcomes from the same value. `Option` cannot carry the difference, and
F1 says the second case is the *normal* case in this product.

There is a third distinction the field card forces:

- *`establish-tunnels` is `on-traffic` because that is the Junos default and nobody
  configured it* (side 3: *"on-traffic — Default. Negotiates only when a packet is routed
  at st0 — an idle backup cycles in the log by design"*)

versus

- *someone explicitly chose `on-traffic`.*

A rule wants to treat those differently — the first is a probable oversight on a backup
tunnel, the second is a decision. And the emitter must not emit a value it knows is the
default, or every generated config is twice as long as it needs to be and diffs against
the running config are unreadable.

### 5.2 DECISION — four states

```rust
pub enum Presence<T> {
    /// Someone or something asserted this value.
    Set(T),
    /// Nothing was configured; this is the platform's documented default,
    /// carried so rules can read it and emitters can skip it.
    Default(T),
    /// Asserted to be absent. Only constructible from a closed-world
    /// observation or an explicit human assertion (§8.5).
    Absent,
    /// Never asserted either way. The normal state of most of the graph.
    Unknown,
}
```

| State | A rule reading it sees | The emitter does | The UI shows |
|---|---|---|---|
| `Set(v)` | `v` | emits the line | the value, in mono |
| `Default(v)` | `v`, plus `is_default() == true` | emits nothing, unless `--explicit-defaults` | the value in muted, with a margin tab `platform default` |
| `Absent` | a definite negative | emits nothing (or the vendor's explicit-negation form where one exists, e.g. `delete`/`no`) | an em-dash |
| `Unknown` | **stops evaluation** → `Unevaluable` | blocks if the field is required for emit; skips otherwise | an empty slot with the field name, clickable to fill |

The most common bug this schema will produce is an author writing `if pfs.is_none()` and
catching `Unknown` along with `Absent`. Mitigation: `Presence<T>` has **no** `is_none`,
**no** `unwrap`, and **no** `Into<Option<T>>`. The only ways out are
`fn asserted(&self) -> Option<&T>` (`Set` only), `fn effective(&self) -> Option<&T>`
(`Set` or `Default`), and an exhaustive `match`. Rule condition expressions in YAML compile
to a three-valued logic (§9.3), so a rule author cannot accidentally collapse the states
either.

### 5.3 `Default` is a claim about a platform version, and it must be sourced

A `Default(v)` value is only true for a platform and a version range. `Presence::Default`
therefore always carries `Origin::Defaulted { plat, version_range, citation }` provenance
(§8.2). Defaults are authored in the corpus, not hardcoded in Rust:

```yaml
# corpus/defaults/junos-srx.yaml
- kind: IpsecVpn
  field: establish_tunnels
  versions: "*"
  value: on-traffic
  citation: "field card side 3 — 'on-traffic  Default.'"
  reviewed_by: <named human>          # invariant 10
- kind: IkeGateway
  field: dpd.interval
  versions: "*"
  value: 10
  citation: "field card side 2 — 'Junos defaults to 10 × 5 = 50 s'"
  reviewed_by: <named human>
- kind: IkeGateway
  field: dpd.threshold
  versions: "*"
  value: 5
  citation: "field card side 2"
  reviewed_by: <named human>
- kind: IpsecProposal
  field: lifetime_seconds
  versions: "*"
  value: 3600
  citation: "field card side 2 — 'P1 28800, P2 3600. Both default to 3600.'"
  reviewed_by: <named human>
```

Note the last one carefully: **3600 is the default for both phases; 28800 is a
recommendation for Phase 1.** A default table that records 28800 as the P1 default would
be wrong, and would suppress the finding that matters — an unset P1 lifetime silently
running at 3600. The field card is precise about this and the corpus must be too.

Defaults are applied lazily, at read time, from the corpus table keyed by
`(kind, field, platform, version)` — never materialised into the stored graph. A workspace
must not bake in a default that a later corpus release corrects.

### 5.4 Conflict is not a fifth state

Two actors can assert different values for the same field (§8.6). That is not a property of
the value, it is a property of the field, so it lives one level up:

```rust
pub enum Field<T> {
    Resolved  { value: Presence<T>, prov: ProvenanceId },
    Conflicted{ candidates: SmallVec<[Candidate<T>; 2]> },
}
pub struct Candidate<T> { pub value: Presence<T>, pub prov: ProvenanceId }
```

A `Conflicted` field reads as `Unevaluable(Gap::Conflict)` to every rule, blocks emit, and
renders as both values side by side with their provenance. It is never auto-resolved into
a value the user did not choose — see §8.6 for the one exception, which is deterministic
ordering for the *display* order of candidates, not for picking a winner.

---

## 6. The node kind taxonomy

### 6.1 When something earns a kind

Adding a kind is cheap on day one and expensive on day 400 — it touches the enum, every
exhaustive match, the codegen, the schema JSON, the diagram legend and the explainer
corpus. So there is a test:

> **A concept earns its own kind only when it has a distinct required-field set, a
> distinct edge signature, or a distinct lifecycle.** Otherwise it is a discriminant field
> on an existing kind.

Worked both ways: `RethInterface` earns a kind because it has a required edge to a
`RedundancyGroup` that no other interface has and because its members live on different
chassis (§12.1). A loopback does **not** earn a kind — it has the same fields and the same
edges as a physical interface and differs only in that it has no media, so it is
`Interface { form: Loopback }`.

### 6.2 Notation used in the tables

| Column | Meaning |
|---|---|
| **Card.** | `1` exactly one, `0..1` optional, `0..n` list, `1..n` non-empty list |
| **Emit** | `R` required for a valid emit on every platform that supports the kind; `R*` required only on the platforms noted; `O` optional; `—` never emitted (annotation, inference or inventory only) |

Every kind additionally carries, implicitly and not repeated in each table:
`id: NodeId`, `prov: NodeProvenance`, `ext: [VendorExt]`, `aka: [FormerName]`,
`unknown: RawMap`, `notes: [Text]`.

All field types below are wrapped in `Field<Presence<T>>`; the tables give `T`.

### 6.3 Organisational and device kinds

#### `Site`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Text` | 1 | — | Display name |
| `code` | `Identifier` | 0..1 | — | Short code used in generated object names |
| `address` | `Text` | 0..1 | — | Free prose |
| `timezone` | `TzName` | 0..1 | O | Feeds NTP/logging emit |
| `criticality` | `enum {Core, Branch, Lab, Dc}` | 0..1 | — | Used by rule severity weighting, not by emit |

Sites contain `Device` and `ExternalPeer`. A `Tunnel` may span sites and is contained by
the workspace root, not by a site.

#### `Device`

The unit that a configuration file is a configuration file *of*. An SRX chassis cluster is
**one** `Device` with two `Chassis`, because it has one config.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `hostname` | `Identifier` | 1 | R | |
| `platform` | `PlatformId` | 1 | R | `junos-srx`, `panos`, `ios-xe`. Not "vendor" |
| `os_version` | `OsVersion` | 0..1 | — | Drives every rule `versions` predicate (§4.7). `Unknown` here makes every version-predicated rule `Unevaluable` — which is correct and is the single strongest argument for asking the user for it |
| `role` | `enum {Firewall, Router, Switch, LoadBalancer, Other}` | 0..1 | — | |
| `domain_name` | `Fqdn` | 0..1 | O | Batfish `Domain_Name` |
| `management_address` | `IpAddr` | 0..1 | — | Inventory only. Never used to reach the device (invariant 2) |
| `cluster_id` | `u16` | 0..1 | R* | `junos-srx` chassis cluster only |
| `default_cross_zone_action` | `PolicyAction` | 0..1 | — | Batfish. Almost always `Default(Deny)` |
| `default_inbound_action` | `PolicyAction` | 0..1 | — | Batfish |

#### `Chassis`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `member_index` | `u8` | 1 | R* | Junos `node0`/`node1`; VC member id |
| `model` | `Identifier` | 0..1 | — | `SRX345` |
| `serial` | `Identifier` | 0..1 | — | Inventory. Sensitive-ish; never leaves the workspace |
| `slots` | `u8` | 0..1 | — | FPC count, for interface-name validation |

`Device --HasChassis--> Chassis`, cardinality `1..n`. Standalone boxes have one.

#### `RedundancyGroup`

Owned by `Device`, matching the owner's §5.1 tree — and the tree is right, because in a
Junos chassis cluster both nodes share one configuration, so the RG is a property of the
config, not of a box.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `number` | `u8` | 1 | R | RG0 is the routing-engine group; RG1+ carry interfaces |
| `node_priority` | `[(member_index, u8)]` | 0..n | R* | |
| `preempt` | `bool` | 0..1 | O | |
| `hold_down_interval` | `Seconds` | 0..1 | O | |
| `gratuitous_arp_count` | `u8` | 0..1 | O | |

Edges: `RedundancyGroup --MonitorsInterface--> Interface` (with a `weight` field on the
edge), `RethInterface --InRedundancyGroup--> RedundancyGroup`.

<!-- VERIFY: exact Junos statement names and default values for hold-down-interval and
     gratuitous-arp-count on current SRX releases. -->

#### `ExternalPeer`

The far end you do not model. Required by partiality: a `Tunnel` with one modelled side is
the normal case, not an error.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `label` | `Text` | 1 | — | "Site B", "AWS eu-west-1 VGW" |
| `address` | `IpAddr` | 0..1 | — | The peer address as *we* see it |
| `organisation` | `Text` | 0..1 | — | |
| `contact` | `Text` | 0..1 | — | |
| `platform_guess` | `PlatformId` | 0..1 | — | `Origin::Inferred` from IKE behaviour or from what the user said. Drives interop rules and nothing else |

### 6.4 Interface kinds

Four kinds share the `InterfaceLike` class: they may own `LogicalUnit` children, they may
carry `description`, `admin_up` and `mtu`, and edges declared against `InterfaceLike`
accept any of them.

#### `Interface` — a physical port

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `InterfaceName` | 1 | R | `ge-0/0/0` |
| `form` | `enum {Ethernet, Serial, Loopback, Management, Irb}` | 1 | — | Discriminant, not a kind (§6.1) |
| `description` | `Text` | 0..1 | O | |
| `admin_up` | `bool` | 0..1 | O | Junos emits the *negative* (`disable`); the emitter owns that inversion |
| `mtu` | `Mtu<L2Frame>` | 0..1 | O | §4.4 |
| `speed` | `Bandwidth` | 0..1 | O | |
| `duplex` | `enum {Full, Half, Auto}` | 0..1 | O | |
| `flow_control` | `bool` | 0..1 | O | |
| `vlan_tagging` | `bool` | 0..1 | R* | Required on Junos before a unit may carry a VLAN id |

Edges out: `HasUnit → LogicalUnit (0..n)`, `MemberOfAggregate → AggregateInterface (0..1)`,
`MemberOfReth → RethInterface (0..1)` (with a `chassis` field on the edge),
`Cabled → Interface (0..1)` (the `Link` edge, §7.4).

#### `AggregateInterface` — LAG

`ae` on Junos, `port-channel` on IOS, `bond` on Linux, `Ethernet-Channel` elsewhere. The
§2.1 vocabulary problem lives here, and the answer is one kind with per-platform naming.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `InterfaceName` | 1 | R | |
| `lacp_mode` | `enum {Active, Passive, Off}` | 0..1 | O | |
| `lacp_periodic` | `enum {Fast, Slow}` | 0..1 | O | |
| `minimum_links` | `u8` | 0..1 | O | |
| `link_speed` | `Bandwidth` | 0..1 | R* | Junos `aggregated-ether-options link-speed` |
| `description`, `admin_up`, `mtu` | as `Interface` | | | |

Requires `Device.aggregate_device_count` to be set for a Junos emit
(`set chassis aggregated-devices ethernet device-count N`) — a required *sibling* value,
which the emitter reports as a blocker naming a field on a different node. That is a
normal and expected shape (§9.4).

#### `RethInterface` — Junos chassis-cluster redundant Ethernet

Separate kind. §2.1: *"a Juniper `reth` sits next to a LAG in interface listings and is
not aggregation at all."* Members are on different chassis and only one is forwarding at a
time; a LACP rule applied to a reth would be wrong.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `InterfaceName` | 1 | R | `reth0` |
| `minimum_links` | `u8` | 0..1 | O | |
| `lacp_mode` | `enum {Active, Passive, Off}` | 0..1 | O | reth **can** run LACP across the cluster on supported releases; this is the exception that proves the kinds are still distinct |
| `description`, `admin_up`, `mtu` | as `Interface` | | | |

Required edge: `InRedundancyGroup → RedundancyGroup (1)`. That required edge is what
earns the kind.

#### `TunnelInterface`

`st0` on SRX, `Tunnel0` on IOS, `tunnel.1` on PAN-OS.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `InterfaceName` | 1 | R | `st0` |
| `technology` | `enum {IpsecVti, Gre, GreOverIpsec, Vxlan, Other}` | 1 | — | Determines which rules apply |
| `description`, `admin_up` | as `Interface` | | | |

No `speed`, no `duplex`, no `media`. That absence is the reason it is a kind.

#### `LogicalUnit`

The Junos unit / the Cisco sub-interface. Contained by any `InterfaceLike`.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `index` | `u32` | 1 | R | `0` in `st0.0`. The joined token is rendered, never stored (§4.6) |
| `description` | `Text` | 0..1 | O | |
| `vlan_id` | `VlanId` | 0..1 | R* | Junos `vlan-id` on a tagged unit |
| `families` | `set{Inet, Inet6, Iso, Mpls, EthernetSwitching}` | 0..n | R | At least one family is required for the unit to carry an address |
| `family_mtu` | `map<Family, Mtu<L3Payload>>` | 0..n | O | `set interfaces st0 unit 0 family inet mtu 1400` — side 4 |
| `encapsulation` | `Identifier` | 0..1 | O | |
| `admin_up` | `bool` | 0..1 | O | |

Edges out: `HasAddress → Address (0..n)`, `InRoutingInstance → RoutingInstance (0..1)`,
`VlanMember → Vlan (0..n)` (the owner's `Membership`).
Edges in: `ZoneMember` from `Zone`; `BindsInterface` from `IpsecVpn`;
`ExternalInterface` from `IkeGateway`.

#### `Address`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `value` | `InterfaceAddress` | 1 | R | `10.255.0.1/30` — host bits preserved (§4.3) |
| `family` | `enum {Inet, Inet6}` | 1 | R | Derivable from `value`; stored because a `Presence::Unknown` value still has a known family |
| `is_primary` | `bool` | 0..1 | O | |
| `is_preferred` | `bool` | 0..1 | O | Junos distinguishes these; most platforms do not |
| `vrrp_group` | `u8` | 0..1 | O | Batfish `VRRP_Groups` |

#### `Vlan`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `vlan_id` | `VlanId` | 1 | R | |
| `name` | `Identifier` | 0..1 | R* | Junos names VLANs; IOS numbers them |
| `description` | `Text` | 0..1 | O | |

Edge: `Vlan --L3Interface--> LogicalUnit (0..1)` (the IRB/SVI).

### 6.5 Routing kinds

#### `RoutingInstance`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `inet.0` / the default instance is modelled explicitly, not as `None` |
| `isolation` | `enum {RoutingTableOnly, L3Vpn, L2Bridge, Forwarding, NonForwarding}` | 1 | R | The neutral core of Junos `instance-type` / Cisco `vrf` / PAN virtual router — see §12.3 |
| `router_id` | `Ip4Addr` | 0..1 | O | |
| `route_distinguisher` | `RouteDistinguisher` | 0..1 | R* | `L3Vpn` only |
| `vrf_import` | `[Identifier]` | 0..n | R* | Policy names, resolved to `RoutingPolicy` nodes when those exist |
| `vrf_export` | `[Identifier]` | 0..n | R* | |
| `vrf_target` | `[RouteTarget]` | 0..n | O | |

#### `StaticRoute`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `destination` | `IpPrefix` | 1 | R | `10.2.0.0/16` — host bits zeroed (§4.3) |
| `next_hop` | `NextHop` | 1..n | R | See below |
| `preference` | `u16` | 0..1 | O | Junos `preference`; Cisco calls this administrative distance |
| `metric` | `u32` | 0..1 | O | |
| `resolve` | `bool` | 0..1 | O | |
| `no_readvertise` | `bool` | 0..1 | O | |
| `qualified` | `[(NextHop, preference, metric)]` | 0..n | O | Junos `qualified-next-hop` |

```rust
pub enum NextHop {
    Address(IpAddr),
    Interface(NodeId),   // -> LogicalUnit. Side 1 piece #4: next-hop st0.0
    Discard,
    Reject,
    NextTable(NodeId),   // -> RoutingInstance
}
```

`NextHop::Interface` is the one place a `NodeId` appears inside a scalar, and it is a
deliberate exception to §3.2 — the alternative is an edge whose *kind* has to encode which
element of a `1..n` list it belongs to, which is worse. The exception is registered in the
schema as `contains_reference: true` so the referential-integrity pass knows to walk it.

#### `LearnedRoute`

Never emitted. Never hand-entered. Produced by inference only — see §9.5.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `destination` | `IpPrefix` | 1 | — | |
| `via` | `NodeId` | 1 | — | The `LogicalUnit` or `RoutingProtocol` it resolves through |
| `basis` | `InferenceRuleId` | 1 | — | Which heuristic produced it |

#### `RoutingProtocol` and `ProtocolAdjacency`

| `RoutingProtocol` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `protocol` | `enum {Ospf, OspfV3, Bgp, Isis, Rip, Ldp}` | 1 | R | |
| `router_id` | `Ip4Addr` | 0..1 | O | |
| `local_as` | `Asn` | 0..1 | R* | BGP |
| `reference_bandwidth` | `Bandwidth` | 0..1 | O | Batfish OSPF property |
| `areas` | `[OspfArea]` | 0..n | R* | OSPF |

| `ProtocolAdjacency` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `peer_address` | `IpAddr` | 0..1 | R* | BGP neighbour |
| `peer_as` | `Asn` | 0..1 | R* | BGP |
| `local_address` | `IpAddr` | 0..1 | O | |
| `area` | `OspfAreaId` | 0..1 | R* | OSPF interface adjacency |
| `cost` | `u32` | 0..1 | O | Batfish `OSPF_Cost` |
| `network_type` | `enum {Broadcast, PointToPoint, NonBroadcast, P2mp}` | 0..1 | O | Batfish `OSPF_Network_Type` |
| `import_policy`, `export_policy` | `[Identifier]` | 0..n | O | |
| `route_reflector_client` | `bool` | 0..1 | O | |
| `passive` | `bool` | 0..1 | O | |

An OSPF adjacency over `st0.0` is the reason side 3's `establish-tunnels immediately`
advice exists — *"Use for anything monitored, carrying an adjacency, or where failover
time matters."* The rule that connects those two facts needs both kinds to exist.

### 6.6 Security-policy kinds

#### `Zone`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `WAN`, `VPN`, `TRUST` |
| `description` | `Text` | 0..1 | O | |
| `host_inbound_system_services` | `set{HostService}` | 0..n | O | Zone-wide. The *per-interface* form lives on the edge (§7.5) |
| `host_inbound_protocols` | `set{HostProtocol}` | 0..n | O | `ospf`, `bgp`, `bfd` |
| `screen` | `Identifier` | 0..1 | O | Reference to a screen profile, unmodelled for now (§12.4 bag) |
| `application_tracking` | `bool` | 0..1 | O | |
| `tcp_rst` | `bool` | 0..1 | O | |

#### `PolicySet`

The kind that absorbs the deepest cross-vendor break (§12.2). It is an ordered container.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `scope` | `PolicyScope` | 1 | R | `ZonePair{from,to}` / `InterfaceDirection{unit,dir}` / `Global` / `Vsys(Identifier)` |
| `evaluation` | `enum {FirstMatch, FirstMatchGlobal}` | 1 | — | Junos: first match within the pair. PAN: first match across one global list |
| `default_action` | `PolicyAction` | 0..1 | — | Batfish's `Default_Cross_Zone_Action`, per set |

`scope` is a scalar carrying `NodeId`s for the zones/units, registered
`contains_reference: true` like `NextHop`.

#### `SecurityPolicy`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `TO-B` |
| `ordinal` | `u32` | 1 | R | Position within the `PolicySet`. Gaps are legal and deliberate — renumbering a policy must not be a graph-wide operation |
| `action` | `PolicyAction {Permit, Deny, Reject}` | 1 | R | |
| `match_any_source` / `match_any_destination` | `bool` | 0..1 | R | `Set(true)` means the vendor's `any` keyword — semantically distinct from "an address set containing everything", and a rule needs the difference |
| `log_init`, `log_close` | `bool` | 0..1 | O | |
| `count` | `bool` | 0..1 | O | |
| `scheduler` | `Identifier` | 0..1 | O | |
| `description` | `Text` | 0..1 | O | |
| `enabled` | `bool` | 0..1 | O | Junos `deactivate` / PAN disabled |

Edges out: `MatchSource → {AddressObject, AddressSet} (0..n)`,
`MatchDestination → … (0..n)`, `MatchApplication → {Application, ApplicationSet} (0..n)`,
`TunnelsVia → IpsecVpn (0..1)` (policy-based VPN — side 1's
`then permit tunnel ipsec-vpn NAME`, which the card correctly calls legacy),
`InPolicySet → PolicySet (1)`.

#### `AddressObject`, `AddressSet`

| `AddressObject` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | |
| `value` | `AddressValue` | 1 | R | `Prefix(IpPrefix)` / `Range(IpRange)` / `Dns(Fqdn)` / `Wildcard{addr,mask}` |
| `description` | `Text` | 0..1 | O | |
| `zone` | — | | | Junos scopes address books to zones on older releases; **not** a field — modelled as an edge `InAddressBook → Zone (0..1)` so the global-address-book case is simply the absence of the edge |

| `AddressSet` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | |
| `description` | `Text` | 0..1 | O | |

Edge: `AddressSet --Contains--> {AddressObject, AddressSet} (0..n)`. Nesting is legal;
cycles are an L0 validity error checked on write with a union-find, `O(α(n))` amortised.

#### `Application`, `ApplicationSet`

| `Application` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | |
| `l4` | `L4Spec` | 0..1 | R* | `{protocol: IpProtocol, source_ports: [PortRange], destination_ports: [PortRange]}` |
| `app_id` | `Identifier` | 0..1 | R* | PAN-OS App-ID. **No Junos equivalent** — §12.2 |
| `inactivity_timeout` | `Seconds` | 0..1 | O | |
| `alg` | `Identifier` | 0..1 | O | |

An `Application` with `app_id` set and `l4` `Unknown` is emittable on `panos` and
**blocked** on `junos-srx` with blocker `NoL4Equivalent`. The emitter does not invent a
port range. This is the honest boundary and §12.2 argues it at length.

#### `NatRuleSet`, `NatRule`

Side 4 names source NAT as a top-tier tunnel failure: *"The interface NAT rule for
internet-bound traffic also grabs packets routed at st0. The far end sees the wrong source
and rejects the selector."* A rule cannot detect that without modelling NAT.

| `NatRuleSet` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | |
| `nat_type` | `enum {Source, Destination, Static}` | 1 | R | |
| `from` | `NatScope` | 1 | R | `Zone(NodeId)` / `Interface(NodeId)` / `RoutingInstance(NodeId)` |
| `to` | `NatScope` | 0..1 | R* | Source NAT only |

| `NatRule` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | |
| `ordinal` | `u32` | 1 | R | |
| `match_source` | `[IpPrefix]` | 0..n | O | |
| `match_destination` | `[IpPrefix]` | 0..n | O | |
| `then` | `NatAction` | 1 | R | `Interface` / `Pool(Identifier)` / `Off` / `Static(IpPrefix)` |

`NatAction::Off` is the explicit no-NAT rule the field card says you need above the
internet rule. A rule (`nat.source.eats-tunnel`) fires when a source-NAT rule set with
`then: Interface` matches a prefix that also appears as a `TrafficSelector.local_ip` and
no higher-ordinal `Off` rule covers it. That is a real, computable finding and it exists
only because NAT is in the schema.

### 6.7 Crypto and VPN kinds

These are the field card's six named objects plus the pieces that bind them.

#### `IkeProposal`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `IKE-P1` |
| `authentication_method` | `AuthMethod` | 0..1 | R | |
| `dh_group` | `DhGroup` | 0..1 | R | |
| `encryption_algorithm` | `EncryptionAlgorithm` | 0..1 | R | |
| `authentication_algorithm` | `IntegrityAlgorithm` | 0..1 | R* | **Must be `Absent` when `encryption_algorithm.aead` is true.** Side 1: *"GCM is AEAD, so there is no separate authentication-algorithm. With CBC you must set both — a missing hash is a silent proposal mismatch"* |
| `lifetime_seconds` | `Seconds` | 0..1 | O | Default 3600; 28800 is the recommendation, not the default (§5.3). Junos range 180–86400 |

The AEAD constraint is a **cross-field schema constraint**, declared in the schema as data
so both the validator and the rule engine read the same statement:

```yaml
constraints:
  - id: ike-proposal.aead-excludes-hash
    kind: IkeProposal
    when: "encryption_algorithm.aead == true"
    require: "authentication_algorithm is Absent or Unknown"
    on_violation: block_emit
```

#### `IkePolicy`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `IKE-POL` |
| `mode` | `enum {Main, Aggressive}` | 0..1 | R* | IKEv1 only. Side 2: *"`mode` is silently ignored under `v2-only`. Seeing `mode aggressive` in a v2 config means nothing — do not chase it."* A rule that flags aggressive mode on a v2-only gateway is therefore a **false positive by construction**, and the schema records the dependency so the rule engine can suppress it |
| `pre_shared_key` | `SecretPlaceholder` | 0..1 | R* | §4.5. Emits `pre-shared-key ascii-text "<PSK>"` |
| `certificate_id` | `Identifier` | 0..1 | R* | `rsa-signatures` |
| `description` | `Text` | 0..1 | O | |

Edge: `UsesProposal → IkeProposal (1..n)`.

#### `IkeGateway`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `GW-B` |
| `peer` | `PeerSpec` | 0..1 | R | `Address(IpAddr)` or `Dynamic(IkeId)`. Side 2: *"`dynamic` replaces `address` for peers with no fixed IP"* — so these are one field with two shapes, not two fields |
| `version` | `IkeVersion` | 0..1 | O | `v2-only` |
| `local_identity` | `IkeId` | 0..1 | O | |
| `remote_identity` | `IkeId` | 0..1 | O | |
| `dpd` | `Dpd` | 0..1 | O | `{mode: Optimized\|ProbeIdleTunnel\|AlwaysSend, interval: Seconds, threshold: u8}`. Default `10 × 5` per side 2 |
| `nat_keepalive` | `Seconds` | 0..1 | O | |
| `no_nat_traversal` | `bool` | 0..1 | O | |
| `description` | `Text` | 0..1 | O | |

Edges: `UsesIkePolicy → IkePolicy (1)`, `ExternalInterface → LogicalUnit (1)`,
`InRoutingInstance → RoutingInstance (0..1)`, `PeerIs → ExternalPeer (0..1)`.

`ExternalInterface` is a required edge to a `LogicalUnit`, not a name field, and this is
the single most valuable typing decision in the crypto section. Side 1:

> *"`external-interface` is the WAN unit the IKE packets leave by, not `st0`. Wrong on a
> multi-homed box means Phase 1 sources from an address the peer has never heard of."*

Because it is an edge to an actual unit, a rule can walk `ExternalInterface → LogicalUnit
→ Address` and compare against `local_identity`, and can check that the target is not the
same unit as `IpsecVpn.BindsInterface`. As a string field, neither check is possible.

#### `IpsecProposal`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `IPSEC-P2` |
| `protocol` | `enum {Esp, Ah}` | 0..1 | R | Side 2: *"AH is integrity-only and breaks through NAT"* |
| `encryption_algorithm` | `EncryptionAlgorithm` | 0..1 | R* | ESP only |
| `authentication_algorithm` | `IntegrityAlgorithm` | 0..1 | R* | Same AEAD constraint as `IkeProposal` |
| `lifetime_seconds` | `Seconds` | 0..1 | O | Default 3600 |
| `lifetime_kilobytes` | `Kilobytes` | 0..1 | O | Side 2: *"If flaps track throughput rather than time, check `lifetime-kilobytes` first"* |

#### `IpsecPolicy`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `IPSEC-POL` |
| `perfect_forward_secrecy` | `DhGroup` | 0..1 | O | The brief's flagship rule `ipsec.pfs.absent` reads exactly this field, and requires it to be `Absent`, not `Unknown`, to fire |
| `description` | `Text` | 0..1 | O | |

Edge: `UsesProposal → IpsecProposal (1..n)`.

#### `IpsecVpn`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `VPN-B` |
| `establish_tunnels` | `enum {Immediately, OnTraffic, ResponderOnly}` | 0..1 | O | Default `OnTraffic`. Side 3's *"Both ends `on-traffic`, or both `responder-only`. Nobody initiates"* is a two-sided rule that needs this field on both `IpsecVpn`s under one `Tunnel` |
| `df_bit` | `enum {Copy, Clear, Set}` | 0..1 | O | Default `Copy` (side 4) |
| `vpn_monitor` | `VpnMonitor` | 0..1 | O | `{enabled, source_interface: NodeId, destination_ip: IpAddr, optimized: bool}` |
| `idle_time` | `Seconds` | 0..1 | O | |
| `mode` | `enum {RouteBased, PolicyBased}` | 1 | R | Determines whether `BindsInterface` is required (route-based) or forbidden (policy-based) — side 1's route-based vs policy-based table, as a schema constraint |
| `description` | `Text` | 0..1 | O | |

Edges: `UsesIkeGateway → IkeGateway (1)`, `UsesIpsecPolicy → IpsecPolicy (1)`,
`BindsInterface → LogicalUnit (0..1, required when mode == RouteBased)`,
`HasTrafficSelector → TrafficSelector (0..n)` (containment),
`EndpointOf → Tunnel (0..1)`.

#### `TrafficSelector`

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Identifier` | 1 | R | `TS1` |
| `local_ip` | `IpPrefix` | 1 | R | `10.1.0.0/16` |
| `remote_ip` | `IpPrefix` | 1 | R | `10.2.0.0/16` |
| `protocol` | `IpProtocol` | 0..1 | O | |
| `local_ports`, `remote_ports` | `[PortRange]` | 0..n | O | Not expressible on every platform; blocks emit where not |

Zero traffic selectors is not the same as one `0.0.0.0/0 ↔ 0.0.0.0/0` selector *in the
graph*, even though the SRX behaves as the latter. Side 4: *"With no `traffic-selector`
configured the SRX proposes any-to-any. Peers that build one SA per subnet pair reject it
outright."* So the absence is modelled as absence, and the implied any-to-any is an
**inferred** `TrafficSelector` node with `Origin::Inferred` — visible, explainable, and
distinguishable from one the user wrote.

#### `Tunnel`

The cross-device abstraction. Promoted from an edge (§3.4) because `TrafficSelector`
symmetry checks, the diagram's overlay layer, and two-sided findings all need to address it.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `name` | `Text` | 1 | — | Never emitted; this node has no vendor representation |
| `mode` | `enum {RouteBased, PolicyBased}` | 0..1 | — | Must agree with both endpoints |
| `intended_state` | `enum {Up, Standby, Decommissioned}` | 0..1 | — | Drives severity: a flapping standby is not a flapping primary |
| `overlay_prefix` | `IpPrefix` | 0..1 | — | `10.255.0.0/30` — the `st0` transit link, when both sides are modelled |

Edges: `TunnelEndpoint → IpsecVpn (0..2)` and `TunnelPeer → ExternalPeer (0..1)`.
Exactly one of the two shapes must hold: two `IpsecVpn` endpoints (both sides modelled) or
one `IpsecVpn` plus one `ExternalPeer`. Zero `IpsecVpn` endpoints is a planned tunnel and
is legal.

The **two-sided rules** — every one of side 2's *"BOTH ENDS MUST AGREE — EVERY VALUE,
EXACTLY"* checks — are rules whose `applies_to` is `{kind: Tunnel}` and which return
`Unevaluable(Gap::OneSidedTunnel)` when only one endpoint is an `IpsecVpn`. That is the
correct answer, and it is the answer a `Presence`-less schema cannot give.

### 6.8 Device-level settings kinds

#### `SecurityFlowSettings` (one per `Device`)

Exists because conventions names the rule `mtu.mss-clamp.absent`, and that rule needs
somewhere to look.

| Field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `tcp_mss_all_tcp` | `u16` | 0..1 | O | Side 4: *"`all-tcp` hits everything through the box, a far bigger blast radius than most people intend"* |
| `tcp_mss_ipsec_vpn` | `u16` | 0..1 | O | *"clamps only tunnel traffic — the clean fix"* |
| `tcp_mss_gre_in`, `tcp_mss_gre_out` | `u16` | 0..1 | O | |
| `force_ip_reassembly` | `bool` | 0..1 | O | |

#### `SystemSettings` (one per `Device`), `NtpServer`, `SyslogTarget`

| `SystemSettings` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `time_zone` | `TzName` | 0..1 | O | |
| `root_authentication_set` | `bool` | 0..1 | — | A *fact about* whether a credential exists. Never the credential (invariant 3) |
| `name_servers` | `[IpAddr]` | 0..n | O | Batfish `DNS_Servers` |

`NtpServer { address: IpAddr, prefer: bool, key_id: u32 }`,
`SyslogTarget { host: IpAddr|Fqdn, facility, severity, structured_data: bool }`.

NTP is in this schema for one reason, stated on side 4: *"Clock skew kills certificates.
Check NTP before re-issuing anything."* A workspace with certificate-authenticated IKE
and no `NtpServer` is a finding.

### 6.9 What is deliberately not a kind

| Not modelled | Why |
|---|---|
| Security associations, SA indexes, SPIs, tunnel up/down state | Invariant 2. Fathom never touches a device, so it has no honest way to hold runtime state. Side 3 is entirely about reading this state *on the box*; the tool's job is to tell you which command to run and what to read, not to pretend it knows |
| RIB / FIB / computed forwarding | §2.2 — rejected from Batfish. `LearnedRoute` is inference output, not simulation |
| Users, accounts, credentials of any kind | Invariant 3 |
| Interface counters, CPU, storage | §6.7 of the brief is verification *commands*; the answers stay on the box |
| Rule packs, suppressions, corpus entries | These are workspace siblings, not graph nodes. Suppressions reference `ElementId`s but are not part of the graph, so a graph merge cannot manufacture one |

---

## 7. The edge taxonomy

### 7.1 The declaration shape

An edge kind is declared, in schema data, as:

```yaml
- kind: ExternalInterface
  class: reference
  from: [IkeGateway]
  to:   [LogicalUnit]
  card: { out: "1", in: "0..n" }      # one per gateway; a unit may serve many gateways
  fields: []
  emit: junos-srx:"external-interface {{to.render_name}}"
  explain: explain:edge:ExternalInterface
```

`card.out` bounds edges leaving a `from` node; `card.in` bounds edges arriving at a `to`
node. Both bounds are enforced: the upper bound at write time (L0), the lower bound at
emit and validity check time (L1/L2).

`from` and `to` are **sets of kinds**, not single kinds, which is how the `InterfaceLike`
class is expressed without an inheritance mechanism.

### 7.2 Containment edges

Exactly one containment in-edge per node. Together they form a forest rooted at the
workspace.

| Edge kind | From | To | out | in |
|---|---|---|---|---|
| `HasDevice` | `Site` | `Device` | 0..n | 1 |
| `HasChassis` | `Device` | `Chassis` | 1..n | 1 |
| `HasRedundancyGroup` | `Device` | `RedundancyGroup` | 0..n | 1 |
| `HasInterface` | `Device` | `Interface`, `AggregateInterface`, `RethInterface`, `TunnelInterface` | 0..n | 1 |
| `HasUnit` | *InterfaceLike* | `LogicalUnit` | 0..n | 1 |
| `HasAddress` | `LogicalUnit` | `Address` | 0..n | 1 |
| `HasVlan` | `Device` | `Vlan` | 0..n | 1 |
| `HasRoutingInstance` | `Device` | `RoutingInstance` | 0..n | 1 |
| `HasStaticRoute` | `RoutingInstance` | `StaticRoute` | 0..n | 1 |
| `HasRoutingProtocol` | `RoutingInstance` | `RoutingProtocol` | 0..n | 1 |
| `HasAdjacency` | `RoutingProtocol` | `ProtocolAdjacency` | 0..n | 1 |
| `HasZone` | `Device` | `Zone` | 0..n | 1 |
| `HasPolicySet` | `Device` | `PolicySet` | 0..n | 1 |
| `HasPolicy` | `PolicySet` | `SecurityPolicy` | 0..n | 1 |
| `HasAddressObject` | `Device` | `AddressObject`, `AddressSet` | 0..n | 1 |
| `HasApplication` | `Device` | `Application`, `ApplicationSet` | 0..n | 1 |
| `HasNatRuleSet` | `Device` | `NatRuleSet` | 0..n | 1 |
| `HasNatRule` | `NatRuleSet` | `NatRule` | 0..n | 1 |
| `HasIkeProposal` … `HasIpsecVpn` | `Device` | each crypto kind | 0..n | 1 |
| `HasTrafficSelector` | `IpsecVpn` | `TrafficSelector` | 0..n | 1 |
| `HasFlowSettings` | `Device` | `SecurityFlowSettings` | 0..1 | 1 |
| `HasSystemSettings` | `Device` | `SystemSettings` | 0..1 | 1 |
| `HasNtpServer` | `SystemSettings` | `NtpServer` | 0..n | 1 |
| `HasSyslogTarget` | `SystemSettings` | `SyslogTarget` | 0..n | 1 |
| `HasExternalPeer` | `Site` | `ExternalPeer` | 0..n | 1 |
| `HasTunnel` | *root* | `Tunnel` | 0..n | 1 |

Note that all crypto objects hang off `Device`, not off each other. Junos writes them as
siblings under `security ike` / `security ipsec` and they are independently deletable, so
the containment tree matches the config tree. The chain between them is *reference*, which
is exactly what the field card means by *"six named objects, each referencing the one
before it by name."*

### 7.3 Reference edges

| Edge kind | From | To | out | in | Fields | Vendor form |
|---|---|---|---|---|---|---|
| `UsesIkePolicy` | `IkeGateway` | `IkePolicy` | 1 | 0..n | — | `ike gateway GW-B ike-policy IKE-POL` |
| `UsesProposal` | `IkePolicy` | `IkeProposal` | 1..n | 0..n | `ordinal: u8` | `ike policy IKE-POL proposals IKE-P1` |
| `ExternalInterface` | `IkeGateway` | `LogicalUnit` | 1 | 0..n | — | `external-interface reth0.0` |
| `UsesIkeGateway` | `IpsecVpn` | `IkeGateway` | 1 | 0..n | — | `ipsec vpn VPN-B ike gateway GW-B` |
| `UsesIpsecPolicy` | `IpsecVpn` | `IpsecPolicy` | 1 | 0..n | — | `ipsec vpn VPN-B ike ipsec-policy IPSEC-POL` |
| `UsesProposal` (P2) | `IpsecPolicy` | `IpsecProposal` | 1..n | 0..n | `ordinal: u8` | `ipsec policy IPSEC-POL proposals IPSEC-P2` |
| `BindsInterface` | `IpsecVpn` | `LogicalUnit` | 0..1 | 0..1 | — | `bind-interface st0.0`. `in: 0..1` — two VPNs on one `st0` unit is a validity error |
| `MonitorSource` | `IpsecVpn` | `LogicalUnit` | 0..1 | 0..n | — | `vpn-monitor source-interface reth1.0` |
| `PeerIs` | `IkeGateway` | `ExternalPeer` | 0..1 | 0..n | — | none — inventory linkage |
| `TunnelEndpoint` | `Tunnel` | `IpsecVpn` | 0..2 | 0..1 | `side: A\|B` | none |
| `TunnelPeer` | `Tunnel` | `ExternalPeer` | 0..1 | 0..n | — | none |
| `ZoneMember` | `Zone` | `LogicalUnit` | 0..n | 0..1 | see §7.5 | `zones security-zone VPN interfaces st0.0` |
| `InPolicySet` | `SecurityPolicy` | `PolicySet` | 1 | 0..n | — | implicit in `from-zone X to-zone Y` |
| `MatchSource` / `MatchDestination` | `SecurityPolicy` | `AddressObject`, `AddressSet` | 0..n | 0..n | — | `match source-address NAME` |
| `MatchApplication` | `SecurityPolicy` | `Application`, `ApplicationSet` | 0..n | 0..n | — | `match application NAME` |
| `TunnelsVia` | `SecurityPolicy` | `IpsecVpn` | 0..1 | 0..n | — | `then permit tunnel ipsec-vpn NAME` (policy-based, legacy) |
| `Contains` | `AddressSet` | `AddressObject`, `AddressSet` | 0..n | 0..n | — | `address-set NAME address MEMBER` |
| `ContainsApp` | `ApplicationSet` | `Application`, `ApplicationSet` | 0..n | 0..n | — | |
| `InAddressBook` | `AddressObject`, `AddressSet` | `Zone` | 0..1 | 0..n | — | zone address books |
| `InRoutingInstance` | `LogicalUnit`, `IkeGateway` | `RoutingInstance` | 0..1 | 0..n | — | `routing-instances NAME interface st0.0` |
| `MemberOfAggregate` | `Interface` | `AggregateInterface` | 0..1 | 0..n | — | `ether-options 802.3ad ae0` |
| `MemberOfReth` | `Interface` | `RethInterface` | 0..1 | 0..n | `chassis: NodeId`, `weight: u8` | `gigether-options redundant-parent reth0` |
| `InRedundancyGroup` | `RethInterface` | `RedundancyGroup` | 1 | 0..n | — | `redundant-ether-options redundancy-group 1` |
| `MonitorsInterface` | `RedundancyGroup` | `Interface` | 0..n | 0..n | `weight: u8` | `interface-monitor ge-0/0/0 weight 255` |
| `VlanMember` | `LogicalUnit` | `Vlan` | 0..n | 0..n | `mode: Access\|Trunk` | the owner's `Membership` |
| `L3Interface` | `Vlan` | `LogicalUnit` | 0..1 | 0..1 | — | IRB / SVI |
| `Link` | `Interface` | `Interface` | 0..1 | 0..1 | see §7.4 | none — physical cabling |
| `PeersWith` | `Device` | `Device` | 0..n | 0..n | `redundancy: Vpc\|Mlag\|Vrrp\|Other` | out of day-one scope; the edge exists so there is a home |

### 7.4 `Link` is an edge, not a node

The owner's §5.1 tree shows `Link (physical)` as a child of `Site`. This document makes it
an edge, and here is the reasoning, offered as a **proposed change** per the brief's rule.

A `Link` has exactly two endpoints, always, and both are `Interface` nodes. It carries
fields (`media`, `length_m`, `label`, `provider_circuit`), which edges support. Nothing
references a link. Under §3.4's promotion rule it stays an edge.

The case that would force promotion is a WAN circuit: a provider service with a contract,
a bandwidth, a maintenance window and an ID, which *other things reference* (a finding, a
cost model, a diagram annotation). That is a different concept and should get its own
`Circuit` **node** when it is needed, with `Link --OverCircuit--> Circuit`. Modelling
circuits today, before there is a feature that needs them, is speculative.

| `Link` field | T | Notes |
|---|---|---|
| `media` | `enum {Copper, Fibre, Dac, Virtual, Unknown}` | |
| `length_m` | `u32` | |
| `label` | `Text` | Patch panel reference |
| `provider_circuit` | `Text` | Free prose until `Circuit` exists |

Direction on a `Link` is meaningless. **DECISION —** the store normalises it: on write,
the endpoint with the lexicographically smaller `NodeId` becomes `from`. That makes the
edge canonical, makes deduplication trivial, and satisfies invariant 9's determinism
requirement for anything that iterates links. Consumers must never read meaning into the
direction of an edge whose class declares `symmetric: true`.

### 7.5 `ZoneBinding` is an edge with fields

The owner's tree shows `ZoneBinding` as a node under `LogicalUnit`. This document makes it
the `ZoneMember` edge, also as a **proposed change**.

It is a pure two-party relation and nothing references it. But it is not fieldless, because
piece #3 of the five plumbing pieces configures host-inbound traffic *per interface within
the zone*:

```
set security zones security-zone WAN \
  interfaces reth0.0 host-inbound-traffic \
  system-services ike
```

| `ZoneMember` field | T | Card. | Emit | Notes |
|---|---|---|---|---|
| `host_inbound_system_services` | `set{HostService}` | 0..n | O | `ike`, `ssh`, `ping`, `https`, `dhcp`, `all` |
| `host_inbound_protocols` | `set{HostProtocol}` | 0..n | O | `ospf`, `bgp`, `bfd`, `all` |

The rule named in the conventions, `zone.host-inbound.ike-missing`, therefore fires against
a `ZoneMember` **edge**, not against a `Zone`. Its condition is:

> the edge's `to` unit is the `ExternalInterface` of some `IkeGateway`, **and** neither the
> edge's `host_inbound_system_services` nor the zone's zone-wide set contains `ike` or
> `all`.

Every term in that condition is a graph traversal, which is why this schema is shaped the
way it is. The finding's `why` writes itself from side 1:

> *"Miss #3 and Phase 1 times out with nothing useful in the log — the box drops the peer's
> IKE before processing it."*

`Absent` versus `Unknown` matters here more than anywhere: if the parse covered the whole
`security zones` stanza, an absent `ike` service is a real finding. If a user drew a zone
in the diagram and never touched host-inbound, it is `Unknown` and the rule is
`Unevaluable` with a gap that the completeness prompt can offer to fill.

### 7.6 Derived edges

| Edge kind | From | To | Produced by |
|---|---|---|---|
| `ResolvesVia` | `StaticRoute` | `LogicalUnit` | `infer.route.next-hop-interface` — matches `NextHop::Interface`, or matches `NextHop::Address` against a connected `Address` prefix |
| `SelectorCovers` | `TrafficSelector` | `StaticRoute` | `infer.ts.route-coverage` — the selector's `remote_ip` is covered by a route pointing at the bound `st0` unit |
| `NatOverlaps` | `NatRule` | `TrafficSelector` | `infer.nat.tunnel-overlap` — side 4's source-NAT trap |
| `WouldNegotiate` | `IpsecVpn` | `IpsecVpn` | `infer.tunnel.compat` — the Batfish-shaped static compatibility check (§2.1), only when both sides are modelled |
| `SharesFate` | `LogicalUnit` | `RedundancyGroup` | `infer.reth.fate` — a unit on a reth inherits the RG's failover |

Derived edges are rebuilt on load and after every mutation batch, are never serialised
(§3.5), and are always rendered in the UI with a distinct treatment — per the design
language, a hairline rather than a solid rule, and a margin tab reading `inferred`.

---

## 8. Provenance

### 8.1 Granularity

**DECISION — provenance attaches to a field value, not to a node.**

A node is a mixture. A `Device` may have a hostname parsed from a config on 2025-11-02, an
`os_version` typed by a human last week, a `role` inferred from the presence of security
zones, and a `criticality` that has never been set. Node-level provenance would have to
pick one of those, and every one of the six views would then be lying.

Three provenance carriers:

| Carrier | Attaches to | Answers |
|---|---|---|
| `NodeProvenance.existence` | the node | "why does this node exist at all" |
| `Field<T>.prov` | a field value | "where did this value come from" |
| `Edge.prov` | an edge | "how do we know these two are related" |

### 8.2 The record

```rust
pub struct ProvenanceRecord {
    pub id: ProvenanceId,          // ULID; content of the record is immutable
    pub origin: Origin,
    pub asserted_at: Timestamp,    // ms, UTC
    pub asserted_by: Actor,
    pub confidence: Confidence,
    pub supersedes: Option<ProvenanceId>,
}

pub enum Origin {
    /// A human typed it, optionally through a walkthrough step.
    Hand { step: Option<WalkthroughStepId> },

    /// A parser read it out of pasted or imported configuration text.
    Parsed {
        capture: CaptureId,        // -> the capture blob (§8.4)
        span: ByteSpan,            // exact bytes within the capture
        stanza: ConfigPath,        // e.g. security/ike/gateway/GW-B/external-interface
        parser: ParserId,
        parser_version: CorpusVersion,
    },

    /// An inference rule produced it.
    Inferred {
        rule: InferenceRuleId,
        inputs: SmallVec<[ElementRef; 4]>,   // exactly what it read
        explain: ExplainerId,
    },

    /// Came in from another tool's export. No config line to cite.
    Imported {
        format: ImportFormat,      // NetBox | Nautobot | Csv | FathomExport | Batfish
        document_digest: Blake3,
        locator: CompactString,    // row 412 / /dcim/devices/57/
    },

    /// The platform default applies because nothing was configured (§5.3).
    Defaulted {
        plat: PlatformId,
        versions: VersionRange,
        citation: Option<DocRef>,
        corpus: CorpusVersion,
    },

    /// A schema migration wrote this value (§11).
    Migrated {
        from: SchemaVersion,
        migration: MigrationId,
        prior: Box<ProvenanceRecord>,
    },
}

pub enum Actor {
    User(UserId),                  // workspace-local, opaque, never transmitted
    Parser(ParserId),
    Inference(InferenceRuleId),
    Supervisor { session: AiSessionId, subagent: Option<SubagentId> },
    Migration(MigrationId),
}

pub enum Confidence { Asserted, Derived, Heuristic }
```

Three extensions beyond the brief's *"entered by hand / parsed from config / inferred"*,
each stated as an extension and not a contradiction:

| Added | Why it cannot be folded into one of the three |
|---|---|
| `Imported` | An import has a document digest and a row locator, not a config line and a stanza path. Calling it `Parsed` means `span` and `stanza` are `Option`, which weakens the type for the case that matters |
| `Defaulted` | Required by `Presence::Default` (§5.3). It is neither a human assertion nor a parse — it is a claim from the corpus about a platform version, and it must carry the corpus version so a corpus correction invalidates it |
| `Migrated` | Required by §11. It nests the prior record so migration never destroys lineage |

`Actor::Supervisor` exists because the owner's accompanying message adds a supervisor/
subagent AI layer. Anything an AI layer writes into the graph must be attributable to a
session and labelled in the UI (invariant 9: *"Anything non-deterministic is quarantined
behind the AI layer's boundary and labelled as such"*). The provenance record is where
that label lives. A value with `Actor::Supervisor` and `Confidence::Heuristic` renders with
a margin tab `suggested` and is excluded from emit until a human converts it to
`Origin::Hand` by accepting it.

### 8.3 Confidence has three values and no number

**DECISION — `Confidence` is a three-value enum, not a 0–1 score.**

| Value | Means | Example |
|---|---|---|
| `Asserted` | Someone or something observed it directly | a parsed line; a human typing a value |
| `Derived` | Follows necessarily from asserted facts | `st0.0`'s family is `inet` because it has an `inet` address |
| `Heuristic` | A guess with a stated basis that could be wrong | this device is probably an SRX because the config contains `security zones` |

A float invites fake precision. Nobody can defend the difference between 0.7 and 0.8, the
number becomes a knob, and then a threshold gets tuned and the meaning is gone. Three
values also matches the register of the rest of the product — three risk levels, three
explainer depths.

The cost is real: you cannot rank two heuristics against each other. When two `Heuristic`
values conflict, the tie-break falls through to timestamp and then to ID (§8.6), which is
arbitrary. The mitigation is that a `Heuristic` value never wins over an `Asserted` one and
never reaches emit unaccepted, so an arbitrary tie-break between two guesses cannot produce
a wrong config — only a wrong suggestion.

### 8.4 Capture blobs, and why the raw line is not in the record

The naive design stores `raw_line: String` in every `Parsed` record. A device with 4 000
config lines produces roughly 12 000 field assertions, and copying an average 60-byte line
into each is ~700 KB of duplicated text per device.

Instead:

```rust
pub struct Capture {
    pub id: CaptureId,
    pub taken_at: Timestamp,
    pub device: NodeId,
    pub scope: CaptureScope,       // §10.5 — closed vs open world
    pub platform: PlatformId,
    pub command: Option<CompactString>,   // "show configuration | display set"
    pub text: Arc<str>,            // the whole capture, once, redacted
    pub digest: Blake3,
}
```

Provenance stores `(CaptureId, ByteSpan)`. The raw line is `&capture.text[span]`, resolved
on demand. Per-assertion cost drops from ~60 bytes to 8.

**Redaction happens before the capture is stored, not on display.** The parser emits a
redaction list — byte spans of every token that matched a secret-bearing production
(`pre-shared-key ascii-text …`, `authentication-key …`, `snmp community …`,
`secret …`) — and the capture text is written with those spans replaced by
`<REDACTED:psk>` of the same span length, so all other offsets are preserved. The
unredacted text never reaches the store and never reaches the encryptor. This is the
mechanism behind invariant 3 for the paste path, and it must be fuzzed: any parser change
that adds a secret-bearing production without adding a redaction is a security
regression, and CI checks that the set of secret-bearing productions and the set of
redaction rules are identical.

Capture blobs are compressible and cold. **DECISION —** they live in a separate section of
the workspace document, encrypted with the same key but stored as separately-addressable
chunks, so opening a workspace does not require decompressing every config ever pasted.

### 8.5 What may assert `Absent`

Only two things:

1. A parser whose capture `scope` is closed-world over the stanza in question. A
   `show configuration | display set` of the whole box is closed-world for every stanza; a
   pasted fragment of `security ike` is closed-world for `security/ike/**` and says nothing
   about `security/ipsec/**`.
2. A human explicitly asserting absence — the UI affordance is a distinct control
   ("there is none") rather than clearing a field, because clearing a field must produce
   `Unknown`, not `Absent`.

Nothing else. An inference rule may not conclude `Absent`; the strongest it may say is
`Unknown` with an attached finding.

This is the rule that makes `ipsec.pfs.absent` trustworthy. The rule fires only on
`Presence::Absent`, and `Absent` only exists where somebody actually looked.

### 8.6 Surviving edits, merges and sync

**Edits never overwrite.** A new assertion produces a new `ProvenanceRecord` with
`supersedes` pointing at the old one and becomes the field's `prov`. The superseded record
stays in the provenance store; the *value* history lives in a side table:

```rust
// Side table, keyed by FieldRef. Not inline in the node — see §14.1.
pub struct FieldHistory<T> {
    entries: Vec<(Presence<T>, ProvenanceId)>,   // newest last
}
```

**History is bounded.** Retention: the most recent 16 entries, **plus** the earliest entry
from each distinct `Origin` discriminant, always. That keeps "this was originally parsed
from the box on 2025-11-02" even after 400 hand edits, which is the fact people actually
want. Anything beyond the retention set is dropped and a `HistoryTruncated { count }`
marker replaces it, so the UI never claims a complete history it does not have. Naming the
truncation is the point — silent truncation is how a provenance feature becomes a lie.

**Merges are set-union plus a resolution.** Provenance records are immutable and identified
by ULID, so merging two divergent copies of a workspace is a union of the provenance store
with no conflicts possible there. The only conflict is which value is *current*:

| Step | Rule | Deterministic? |
|---|---|---|
| 1 | Higher `Confidence` wins: `Asserted` > `Derived` > `Heuristic` | yes |
| 2 | Then `Origin` precedence: `Hand` > `Parsed` > `Imported` > `Inferred` > `Defaulted`. `Migrated` takes the precedence of its nested `prior` | yes |
| 3 | Then later `asserted_at` wins | yes, to ms |
| 4 | If still tied — same confidence, same origin class, same millisecond, different values — the field becomes `Field::Conflicted` | yes |

Steps 1–3 never *silently* pick between two human assertions of different values: two
`Hand` assertions in the same millisecond is the only way to reach step 4 from two humans,
and in a CRDT sync that is exactly the concurrent-edit case. Two `Hand` assertions at
different times do resolve by recency, which is last-writer-wins and is the standard,
lossy, understood answer — the loser is still in the history and the UI shows it.

Candidates inside a `Conflicted` field are ordered by `ProvenanceId` (ULID, hence by
creation time then randomly but stably). That ordering is for display and for invariant 9's
byte-identical output requirement. It is **not** a winner.

### 8.7 Showing "this fact is 14 months old"

Age is computed per node as
`max(asserted_at)` over all fields whose `Origin` is `Parsed` or `Imported`. Hand-entered
and inferred values are not aged — a human assertion does not decay, it is either still
true or it is wrong, and the tool has no basis for guessing which.

Following the design language: no badges, no progress bars, no colour. Colour means risk
and only risk. Staleness is rendered as a **margin tab** — lowercase, unpunctuated, muted
`#5C6772`, top-right of the block, exactly like the field card's `read this first` and
`most-missed`.

| Band | Age of newest observation | Treatment |
|---|---|---|
| Fresh | < 30 d | no marking |
| Ageing | 30 d – 6 mo | margin tab `parsed 4 months ago` |
| Stale | 6 mo – 18 mo | margin tab `parsed 11 months ago` + a `#D2D7DD` hairline under the node header |
| Unverified | > 18 mo | margin tab `last parsed 2025-03-11` + hairline, and every finding derived from that node carries an added one-line imperative |

That imperative is the field card's own device — a disclaimer that is also the most useful
sentence on the page:

```
RE-PARSE BEFORE ACTING — THIS EVIDENCE IS 14 MONTHS OLD
```

**A stale finding still fires.** It is not downgraded, not hidden, not softened. Configs
change rarely and a two-year-old parse is usually still correct; suppressing on age would
hide real problems. What changes is that the finding carries `evidence_age` and the
verification ladder for it is promoted — the remediation block leads with
`show configuration | display set | match <stanza>` before it leads with the fix.

Hovering any value shows the full provenance in the same register:

```
perfect-forward-secrecy keys group14
  parsed  2026-03-14 09:12 UTC  from  show configuration | display set
  line    set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14
  before  unknown  (until 2026-03-14)
```

No icons. No modal. Mono for the line, sans for the labels, muted for the labels — the
card's mono-in-prose texture.

---

## 9. Partiality, validity and holes

### 9.1 "Valid" is not one thing

§6.4 says inventory and intent are the same schema, partially populated. So a graph with
one `Device` holding only a hostname is a **correct** graph, and any definition of validity
that calls it invalid has made the product's central premise unrepresentable.

Four levels, checked at different times by different consumers.

| Level | Name | Definition | Enforced |
|---|---|---|---|
| **L0** | Well-formed | Every node's kind is known or quarantined; every field value type-checks against the schema; every edge's endpoints exist and are in the declared kind sets; every edge kind's **upper** cardinality bound holds; containment forms a forest (one containment in-edge, no cycles); no `AddressSet`/`ApplicationSet` cycles; `InterfaceName.raw`/`parsed` agree | **At write time.** The store refuses a mutation that breaks L0. There is no such thing as an L0-invalid graph in memory |
| **L1** | Referentially closed | All **lower** cardinality bounds hold: every `IpsecVpn` has an `IkeGateway`, every route-based VPN has a `BindsInterface` | Computed on demand. Never enforced. Holes are the normal state and the UI lists them |
| **L2** | Emittable(platform, unit) | For a chosen emit unit: every field marked `R`/`R*` for that platform is `Set` or `Default`, every required edge is present, every cross-field constraint holds, no field is `Conflicted`, and every scalar `emit()` succeeds on that platform | Computed per emit. Returns the exact blocker list, never a partial config with a hole in it |
| **L3** | Complete(profile) | Every field a named profile declares mandatory is `Set` | Never enforced by anything. It is a progress meter for the walkthrough, and profiles are corpus data |

L0 is the only one that is an error. L1–L3 are measurements.

### 9.2 The emit unit

An emit never runs over "the graph". It runs over an **emit unit**: a root node plus the
closure of the edges the platform's emitter declares as *"I will follow this"*. For
`junos-srx` the units are `Device` (whole config), `IpsecVpn` (a tunnel and everything it
needs), `SecurityPolicy`, `Interface`, and `Tunnel` (both sides, when modelled).

The closure for `IpsecVpn` on `junos-srx`, which is exactly the field card's side 1:

```
IpsecVpn VPN-B
 ├─ UsesIkeGateway   -> IkeGateway GW-B
 │   ├─ UsesIkePolicy -> IkePolicy IKE-POL
 │   │   └─ UsesProposal -> IkeProposal IKE-P1
 │   └─ ExternalInterface -> LogicalUnit reth0.0
 │       └─ (up) HasUnit -> RethInterface reth0
 ├─ UsesIpsecPolicy  -> IpsecPolicy IPSEC-POL
 │   └─ UsesProposal -> IpsecProposal IPSEC-P2
 ├─ HasTrafficSelector -> TrafficSelector TS1
 └─ BindsInterface   -> LogicalUnit st0.0
     ├─ HasAddress   -> Address 10.255.0.1/30
     └─ (in) ZoneMember from Zone VPN
```

plus, from the traffic selector and the plumbing rules: the `StaticRoute` for
`TS1.remote_ip`, the `ZoneMember` for `reth0.0` carrying `ike`, and the `PolicySet`
`TRUST → VPN`. The emitter's `order_hint` is the depth-first pre-order of this closure,
which reproduces the object-chain ordering the card teaches, without anyone hand-writing an
ordering table.

### 9.3 Rule evaluation is four-valued

```rust
pub enum Eval {
    /// The rule matched and the graph is fine.
    Passed,
    /// The rule matched and fired.
    Fired(Finding),
    /// The predicate did not match: wrong kind, wrong platform, wrong version.
    /// Not an answer about the network, an answer about the rule.
    NotApplicable(NotApplicableReason),
    /// The predicate matched, but an input needed to decide is missing.
    Unevaluable(Gap),
}

pub enum Gap {
    UnknownField   { element: ElementId, field: FieldKey },
    MissingEdge    { from: ElementId, edge: EdgeKind },
    Conflict       { element: ElementId, field: FieldKey },
    UnknownVersion { device: NodeId },
    UnparsedName   { element: ElementId },
    OneSidedTunnel { tunnel: NodeId },
    MtuLayerMismatch { a: ElementId, b: ElementId },
}
```

`NotApplicable` and `Unevaluable` are the two the brief's §5.2 rule format does not have
and cannot do without. The distinction:

| | `NotApplicable` | `Unevaluable` |
|---|---|---|
| Means | this rule has nothing to say here | this rule has something to say and cannot say it yet |
| Counts toward "checks run" | no | no |
| Surfaced to the user | no | yes, as a **completeness prompt**, never as a finding |
| Actionable | no | yes — filling the gap runs the rule |

The completeness prompt is the product feature that falls out of this design, and it is
worth stating because it inverts the §2.2 documentation-rot problem. Instead of "model your
entire estate in these forms", the UI can say:

```
  fields that matter

  answer 3 things and 11 more checks can run

  Device srx-a-01  os_version              — 6 checks blocked
  SecurityFlowSettings  tcp_mss_ipsec_vpn  — 3 checks blocked
  IpsecPolicy IPSEC-POL  perfect_forward_secrecy is Unknown, not Absent
                                           — 2 checks blocked
```

Data entry that pays out immediately, ranked by payout, in the card's own margin-tab voice.

**Rule condition expressions compile to three-valued logic.** The condition language's
comparison operators return `True | False | Unknown`, and `Unknown` propagates: `a AND
Unknown` is `Unknown` unless `a` is `False`; `a OR Unknown` is `Unknown` unless `a` is
`True`. This is Kleene logic and it is the reason a rule author cannot accidentally collapse
`Unknown` into `False`. A condition that evaluates to `Unknown` yields `Unevaluable` with
the gap named by whichever term first produced `Unknown`.

Rules may opt into gap-tolerance explicitly:

```yaml
id: ipsec.pfs.absent
applies_to: { kind: IpsecPolicy }
condition: "perfect_forward_secrecy is Absent"     # Absent, not null. Unknown -> Unevaluable
```

versus a rule that genuinely wants either:

```yaml
id: ipsec.pfs.not-confirmed
severity: low
condition: "perfect_forward_secrecy is Absent or perfect_forward_secrecy is Unknown"
```

Both are expressible; neither is the default; the author has to choose. That is the whole
point.

### 9.4 Emitters against holes

**DECISION — an emitter never invents a value, never emits a placeholder for a missing
field, and never emits a partial config.** It returns a stream in which a blocker is a
first-class item:

```rust
pub enum EmitItem {
    Line(EmittedLine),
    /// A required input is missing. Names the element and field so the UI
    /// can link straight to the hole.
    Blocked(Blocker),
    /// A *designed* hole: a SecretPlaceholder. This is correct output.
    Placeholder(EmittedLine),
    /// A structural comment the emitter chose to add (bring-up order
    /// headers, the object-chain markers from side 1).
    Comment(EmittedLine),
}

pub struct Blocker {
    pub element: ElementId,
    pub field: Option<FieldKey>,
    pub edge: Option<EdgeKind>,
    pub reason: BlockReason,
    pub explain: ExplainerId,
    pub order_hint: u32,          // where the missing line would have gone
}

pub enum BlockReason {
    Required,                  // R / R* and Unknown
    Conflicted,
    Unsupported { plat: PlatformId },   // scalar has no spelling here
    ConstraintViolated { id: ConstraintId },
    MissingRelation { edge: EdgeKind },
}
```

`Placeholder` versus `Blocked` is the distinction that keeps invariant 3 from looking like
a defect. `pre-shared-key ascii-text "<PSK>"` is not a hole in the output; it is the
output. It carries `risk: ChangesConfig` and an explainer that says so.

The UI renders a blocked emit as the config it *can* produce with the blockers in place, in
order, in the card's note style — 4px left accent bar, wash, no box, no icon:

```
set security ike proposal IKE-P1 authentication-method pre-shared-keys
set security ike proposal IKE-P1 dh-group group14
▌ IkeProposal IKE-P1 · encryption_algorithm is unknown
▌ required before this config can be committed
set security ike proposal IKE-P1 lifetime-seconds 28800
```

The accent colour for a blocker is `#A8571B` on `#FBF3EA` — **not** because a blocker is
"caution", but because the emitted artefact as a whole is a config change and the legend
must stay honest. <!-- VERIFY: check this against the finding-severity treatment in the
design docs before implementing; conventions forbid reusing the risk colours for severity,
and a blocker is arguably severity, not risk. If so, blockers render in neutrals with a
weight treatment and the accent bar is dropped. -->

### 9.5 Inference rules

Inference is a separate, small, declarative pass that runs before the rule engine and
produces `Origin::Inferred` values, derived nodes and derived edges. It is deliberately not
the same engine as findings: findings *observe*, inference *asserts*, and mixing them
produces a system where a finding can change the graph it is evaluating.

| Inference rule | Produces | Confidence |
|---|---|---|
| `infer.route.next-hop-interface` | `ResolvesVia` edge | `Derived` |
| `infer.ts.implicit-any` | a `TrafficSelector` `0.0.0.0/0 ↔ 0.0.0.0/0` on an SRX route-based VPN with none configured (side 4) | `Derived` |
| `infer.ts.route-coverage` | `SelectorCovers` edge | `Derived` |
| `infer.nat.tunnel-overlap` | `NatOverlaps` edge | `Derived` |
| `infer.tunnel.pair` | a `Tunnel` node when two modelled `IpsecVpn`s name each other's addresses | `Heuristic` |
| `infer.tunnel.compat` | `WouldNegotiate` edge + a compatibility verdict | `Derived` |
| `infer.device.platform` | `Device.platform` from config syntax | `Heuristic` |
| `infer.cluster.candidate` | a suggestion, not a graph change — §6.4's *"these two look like a cluster candidate"* | `Heuristic` |
| `infer.reth.fate` | `SharesFate` edge | `Derived` |

Constraints on an inference rule, enforced by the loader:

1. It may read only asserted values, never other inferred ones. **The inference pass is
   one level deep and is not a fixpoint.** This is a hard cap chosen to keep load-time
   bounded and to make the pass trivially deterministic. It will be uncomfortable at some
   point and the cost is that some genuinely useful two-step inferences are simply not
   available.
2. It may not write `Absent` (§8.5).
3. It must name its `inputs` in the provenance so the UI can show *"inferred from these
   three facts"* and so invalidation is a graph query rather than a full recompute.
4. `Heuristic` output never reaches emit without human acceptance.

---

## 10. Identity, stability and re-identification

### 10.1 IDs

Per conventions, as amended by ADR-0005 (no product name in any identifier):
`<kind-lower>:<ulid>`. ULID because it is 128 bits, lexicographically
sortable, carries a 48-bit millisecond timestamp and 80 bits of randomness, and needs no
coordinator — which matters because the client is offline by default and there is no server
to allocate from.

Edges use the same format with their own kind (`fathom:zone-member:01J…`). Conventions
say node IDs are `<kind-lower>:<ulid>` and invariant 7 requires edges to carry stable
opaque IDs; reading edge kinds as kinds satisfies both without inventing a second format.

In memory the ID is 17 bytes, not a string:

```rust
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId { pub kind: NodeKind, pub ulid: Ulid }
```

Embedding the kind makes IDs self-describing: a dangling reference is detectable without a
lookup, an edge's endpoint kinds are checkable without touching the nodes, and every
`NodeId` in a debug dump is readable. The cost is that **a node can never change kind**. An
`Interface` that turns out to be a `TunnelInterface` is a delete and a create, and anything
that referenced it must be re-pointed. I accept that: kind changes are rare, and the
alternative (kind as a mutable field) makes every edge-endpoint check a graph lookup.

**IDs never leave the workspace.** A ULID leaks its creation millisecond, and in a
zero-knowledge design the ciphertext hides it, but an ID pasted into a bug report or
embedded in an exported rule pack would not. Rule packs, corpus entries and any shared
artefact reference *kinds and field keys*, never instance IDs.

### 10.2 Names are ordinary fields

`IkeGateway.name` is a field like any other. It has provenance, it has history, it can be
`Unknown`. Renaming is a normal field edit. No rule, suppression, diagram element,
explainer binding or emitted-line back-reference contains a name.

Every node also carries:

```rust
pub struct FormerName { pub name: Identifier, pub until: Timestamp, pub prov: ProvenanceId }
```

populated by the re-identification algorithm when it detects a rename (§10.4 tier 2). The
UI shows `was GW-B until 2026-07-28` as a margin tab, which is what makes a renamed object
findable by the name the engineer still has in their head — a small thing that closes part
of the §2.1 vocabulary gap for free.

### 10.3 Identity tuples

Each kind declares an **ordered** list of identity tuples in schema data, most specific
first. A tuple is a list of field paths and/or edge targets, all of which must be `Set` for
the tuple to be usable on a given node.

```yaml
- kind: IkeGateway
  identity:
    - [ owner(Device), name ]                          # tier 1 — the strong key
    - [ owner(Device), peer.address, edge(ExternalInterface) ]   # tier 2 — survives rename
    - [ edge_in(TunnelEndpoint via IpsecVpn), side ]   # tier 3 — survives readdressing
- kind: LogicalUnit
  identity:
    - [ owner(InterfaceLike), index ]
- kind: Interface
  identity:
    - [ owner(Device), name.parsed ]
    - [ owner(Device), name.raw ]
- kind: SecurityPolicy
  identity:
    - [ owner(PolicySet), name ]
    - [ owner(PolicySet), ordinal ]
- kind: TrafficSelector
  identity:
    - [ owner(IpsecVpn), name ]
    - [ owner(IpsecVpn), local_ip, remote_ip ]
- kind: Address
  identity:
    - [ owner(LogicalUnit), value ]
```

Identity tuples are **only** used by re-identification. They are never used for lookup,
never used by rules, never persisted as a key. A tuple may not include a `VendorExt` key
(§12.4 rule 5) and may not include an inferred value.

### 10.4 The re-identification algorithm

Runs on every re-parse of a config for a device already in the graph. Goal: map freshly
parsed nodes onto existing ones so a re-parse updates rather than duplicates.

**Input:** existing graph `G`; freshly parsed graph `P` (every node with a brand-new ULID);
capture `C` with `device: D` and `scope: S`.
**Output:** a mapping `M: P.nodes → G.nodes ∪ {new}`, a set of absent-in-capture G-nodes,
and a rename list.

```
1  SCOPE
   Gs := { n ∈ G : owner_device(n) = D
                 ∧ config_path(kind(n)) ⊆ covered_paths(S) }
   Nodes outside the capture's covered paths are untouched. A fragment paste
   of `security ike` can never affect `security policies`.

2  BUCKET
   Partition Gs and P by kind. Identity resolution never crosses kinds
   (a NodeId carries its kind, §10.1, so a cross-kind match is unrepresentable).

3  RESOLVE, in topological order of the containment forest
   (Device -> InterfaceLike -> LogicalUnit -> Address; Device -> PolicySet ->
    SecurityPolicy; Device -> IpsecVpn -> TrafficSelector)

   for each kind K in topo order:
     for tier t = 1 .. T(K):
       build hash map H over unmatched Gs[K] keyed by tuple_t
         (computable because owners are already mapped by topo order)
       for each unmatched p ∈ P[K]:
         if tuple_t(p) is fully Set and H contains it and the bucket is
         unambiguous (exactly one candidate):
            M[p] := that node
            if t > 1: record a rename candidate

4  RESIDUE — similarity, guarded
   for each kind K:
     rG := unmatched Gs[K];  rP := unmatched P[K]
     if |rG| * |rP| > 4096: skip entirely (leave unmatched)
     else:
       score(g,p) := weighted Jaccard over scalar fields
                     + 0.3 * edge-signature overlap
                     (weights declared per kind in the schema)
       accept (g,p) iff best(p) ≥ 0.75  AND  best(p) − second(p) ≥ 0.15
       greedy in descending score order, one-to-one

5  NEW
   Unmatched p ∈ P  ->  fresh NodeId, Origin::Parsed, existence provenance
   from C.

6  ABSENT
   Unmatched g ∈ Gs  ->  see §10.5. Never a silent delete.

7  MERGE VALUES
   For every matched pair, each parsed field value is asserted onto the
   existing node through the normal provenance path (§8.6). A parsed value
   that equals the existing value still writes a new ProvenanceRecord —
   that is how "still true as of today" is recorded, and it is what makes
   the staleness band in §8.7 mean something.
```

**Complexity.** Steps 1–3 are hash joins: `O(n)` per tier with `T(K) ≤ 3`, so
`O(3n)` overall where `n = |Gs| + |P|`. Step 4 is `O(r_G · r_P · f)` bounded by the 4096
guard times the field count `f`, per kind. Step 7 is `O(m)` in the number of asserted
values. Total `O(n + f · 4096 · |kinds|)` worst case, linear in practice.

For a mid-size SRX — say 48 interfaces, ~120 units, ~200 address objects, ~150 policies —
`n` is a few thousand and the residue is almost always empty because tier 1 matches
everything that did not change. <!-- VERIFY: measure this in WASM once the store exists.
The complexity is sound; the constant is not knowable from here, and the 4096 guard is a
guess that should be replaced with a measured number. -->

**The 0.75 / 0.15 thresholds are arbitrary.** They are chosen so that a near-tie never
auto-matches, because a wrong match is far worse than a duplicate: a wrong match silently
rewrites the history of an object that is not the one you are looking at. When step 4
declines to match, the user gets an explicit "is this the same gateway?" prompt with both
sides shown. That prompt is the honest answer and it should stay in the product.

### 10.5 Absence is not deletion

Whether a node missing from a re-parse should be deleted depends entirely on whether the
capture could have contained it.

```rust
pub enum CaptureScope {
    /// A whole-device dump. Closed-world for everything.
    Whole,
    /// Complete for the listed config paths, silent about all others.
    Section(SmallVec<[ConfigPath; 4]>),
    /// A snippet. Open-world everywhere. Says nothing about absence.
    Fragment,
}
```

| Capture scope | Node parsed with `Origin::Parsed`, now missing | Node with `Origin::Hand`, now missing |
|---|---|---|
| `Fragment` | nothing happens | nothing happens |
| `Section` covering its path | **tombstone**: mark `absent_since = C.taken_at`, keep the node, keep its history, exclude from emit | **divergence**: mark `Divergent { since }`, keep it, raise a finding |
| `Whole` | same as `Section` | same as `Section` |

A tombstoned node is not deleted. It renders muted with a margin tab
`absent since 2026-07-28`, and it is deleted only by a human. Reason: a parser bug that
fails to recognise a stanza would otherwise silently destroy a user's data, and there is no
undo across an encrypted-document save.

The `Divergent` case is worth naming, because it is Nautobot Golden Config's compliance
diff obtained as a side effect of one schema (§6.4's *"inventory and the intent model are
the same schema"*). A hand-entered `IkeGateway` that is not on the box after a whole-device
parse is precisely "intended but not deployed", and it costs no new subsystem — it is a
consequence of provenance plus capture scope.

The converse is also free: a parsed node with no hand-entered counterpart in a workspace
where intent was modelled first is "deployed but not intended".

### 10.6 What survives a rename, and what does not

| Thing | Survives? | Why |
|---|---|---|
| Rules bound to the node | yes | rules bind by kind and evaluate against IDs |
| Suppressions | yes | keyed by `(rule_id, ElementId)` |
| Diagram position and layout | yes | keyed by `NodeId` |
| Emitted-line back-references | yes | `EmittedLine.source_node` is a `NodeId` |
| Provenance and history | yes | attached to the node |
| **Cross-device name references in a config Fathom has not parsed** | **no** | If a peer device's config references `GW-B` by name and that config is not in the workspace, renaming here breaks the far end and Fathom cannot know. The tool can warn when a `Tunnel` has a modelled peer; it cannot warn otherwise. Stated because it is a real limitation, not a hypothetical |

---

## 11. Schema evolution and migration

### 11.1 The situation

A workspace is an encrypted document the user owns (§6.4). It is on their disk, in their
git repo, on a USB stick in an air-gapped facility. It will be opened by a build that did
not exist when it was written, and — this is the case everyone forgets — by a build
*older* than the one that wrote it, because the offline single-file deployment means
different people in one team are running different versions and mailing each other files.

Both directions have to work, and one of them cannot be made to work fully. Say which.

### 11.2 Versioning

Three independent version numbers, all in the workspace envelope:

| Version | Governs | Form |
|---|---|---|
| `format_version` | The container: envelope layout, KDF parameters, AEAD construction, chunking | integer, monotonic |
| `schema_version` | The graph schema: kinds, fields, edge kinds, constraints | `major.minor` |
| `corpus_version` | Rules, explainers, commands, defaults | semver + content hash |

`schema_version` is `major.minor` with no patch. A patch level would only ever mean "no
observable change", and a version number that never means anything is a version number
people stop checking.

`format_version` and `schema_version` live in the envelope **header, outside the
ciphertext**, and are included in the AEAD associated data so they are authenticated
without being confidential. The alternative — versions inside the ciphertext — means a
client must run the KDF (deliberately expensive) and decrypt before it can discover it
cannot read the file. Leaking "this workspace was written by a Fathom using schema 3.2" is
a negligible disclosure against a server that already knows the file exists and its size.
Naming it as a disclosure anyway, because the zero-knowledge claim in §7.3 should be
precise about what metadata the server sees.

### 11.3 What each bump means

| Change | Bump | Old client can read? |
|---|---|---|
| New node kind | minor | yes, as `Kind::Unknown` |
| New edge kind | minor | yes, preserved opaquely |
| New optional field | minor | yes, preserved in `unknown` |
| New enum variant | minor | yes, as `Variant::Unknown(token)` — every schema enum has an unknown arm, generated, not hand-written |
| Relaxed constraint / widened cardinality upper bound | minor | yes |
| New identity tuple appended | minor | yes |
| Field removed or renamed | **major** | no |
| Field type changed | **major** | no |
| Cardinality **lower** bound raised | **major** | no |
| Constraint tightened | **major** | no |
| Identity tuple removed or reordered | **major** | no |
| Containment restructured (a kind's owner changes) | **major** | no |

### 11.4 Forward compatibility: an old client opening a newer workspace

Every client preserves what it does not understand. This is the protobuf/YANG lesson and
there is no substitute for it.

```rust
pub struct RawNode {
    pub id: NodeId,
    pub kind_token: CompactString,     // may not be a known NodeKind
    pub fields: BTreeMap<CompactString, RawValue>,
    pub prov: BTreeMap<CompactString, ProvenanceId>,
}
```

`RawValue` is a CBOR-shaped tagged value that round-trips byte-for-byte. Every `Node`
carries an `unknown: RawMap` populated from fields the build's schema did not recognise,
and writes them back out unchanged. Unknown *kinds* become `Kind::Unknown(token)` nodes
which participate in nothing — no rules, no emit, no diagram — but are serialised back
exactly.

**DECISION — a higher `schema_version.minor` puts the client in preserve mode.**

| Preserve mode | |
|---|---|
| Read | full. Everything the build understands is live |
| Edit | permitted **only** on elements with no unknown fields and no unknown incident edges. Editing an element the build cannot fully see is refused, with a message naming the version that can |
| Emit | permitted, and every emit is stamped: `# Fathom 3.1.4 · schema 3.2 read at 3.1 · 14 elements not understood and not considered` |
| Findings | computed and shown, marked `partial` |
| Suppressions | **not written back.** A suppression recorded by a build that could not see the whole graph is a waiver of something it did not read |
| Sync / merge | permitted; unknown data merges as opaque last-writer-wins per field |

The banner comment on emit is the important one. A partial emit that does not say it is
partial is the worst possible artefact — it looks authoritative and it is not.

**A higher `major`: refuse to open for editing.** Open read-only in a degraded inspector
that shows the raw node/edge tables and provenance, and nothing else — no diagram, no
findings, no emit. Do not guess at semantics across a major.

The cost is severe and specific: **an air-gapped user on an old single-file build cannot
open a workspace a colleague saved with a newer major, and they may have no path to update.**
That is not hypothetical for the defence and OT users §2.4 targets. Three mitigations, none
of which make it go away:

1. Majors are rare, announced, and require a written migration note.
2. The **export format** is major-stable: a flat, self-describing, schema-tagged JSON dump
   that any build can read into the degraded inspector regardless of major. Exporting is
   always available, including from preserve mode.
3. The single-file build embeds its `schema_version` in its filename and in the UI header,
   so "which build wrote this" is answerable without opening anything.

### 11.5 Backward compatibility: a new client opening an older workspace

Migrations are pure, total, deterministic functions:

```rust
pub trait Migration {
    fn id(&self) -> MigrationId;
    fn from(&self) -> SchemaVersion;
    fn to(&self) -> SchemaVersion;
    /// Total. Must not fail. If a value cannot be converted, the migration
    /// writes Presence::Unknown and a Note, never an error and never a guess.
    fn apply(&self, g: &mut Graph, log: &mut MigrationLog);
}
```

Rules:

| | |
|---|---|
| **Chained** | 1.0 → 1.1 → … → current. No skipping, no direct 1.0 → 4.0 path to maintain |
| **Total** | A migration may not fail. Unconvertible values become `Unknown` with a `Note` explaining what was lost, and a finding so the user sees it |
| **Provenanced** | Every value a migration writes gets `Origin::Migrated` with the prior record nested. Lineage is never destroyed |
| **In memory only** | Migrations run on open. The workspace file is **not** rewritten until the user saves. Opening a workspace with a newer build must never silently mutate the user's file — that breaks git-diffability, which §6.4 sells as a feature |
| **Never deleted** | The chain from 1.0 must always be complete. Deleting an old migration orphans every workspace older than it |
| **Golden-tested** | A checked-in fixture per historical schema version, each containing the §15 worked example, must open, migrate, and emit **byte-identically** to the current build's output for that example. This is the test that catches the migration nobody thought about |

The migration log is surfaced, not hidden:

```
  what changed

  opened at schema 1.4, migrated to 3.2 — 6 migrations
  m-0009  IkeGateway.dpd_interval + dpd_threshold  ->  dpd { }
  m-0014  IpsecVpn.bind_interface (name)           ->  BindsInterface edge
          2 values could not be resolved to a unit and are now unknown
  saved?  not yet — this file is unchanged on disk
```

### 11.6 The schema is data

The Rust types are **generated** from `schema.yaml`, not hand-written. One authoring source
produces:

| Output | Consumer |
|---|---|
| `ir_types.rs` — the typed `Node`/`Edge` enums and structs | the core |
| `schema.json` — kinds, fields, types, cardinalities, constraints, identity tuples, content-hashed | rule packs, the finder, the UI |
| `ir_types.ts` — UI-boundary types only | the TypeScript UI |
| `migrations/manifest.toml` — the declared chain, checked for completeness | CI |
| the field-key registry — stable integer keys per field | wire format, §14.1 |

This is what makes invariant 5 possible. A rule pack declares
`requires_schema: ">=3.2 <4.0"` and the loader validates every `applies_to` and every field
path in every condition against `schema.json` **at load time**, not at evaluation time. A
rule pack that references a field that does not exist fails to load with a precise error
instead of silently never firing — which is the failure mode that makes people stop
trusting a rule engine.

Cost, stated plainly: adding a kind or a field is now a codegen run and a rebuild, not a
five-minute edit. That is a real tax during the first six months when the schema changes
weekly, and it is exactly when you least want it. I still think it is right, because the
alternative is three hand-maintained copies of the schema that drift, and the drift shows
up as rules that silently do nothing.

---

## 12. Multi-vendor pressure and the extension bag

A vendor-neutral IR is a bet that the concepts generalise. Here is where that bet is
wrong, specifically, with what this schema does about each.

### 12.1 `reth` versus a LAG

§2.1 of the brief names this: *"a Juniper `reth` sits next to a LAG in interface listings
and is not aggregation at all."*

| | `ae` (LAG) | `reth` |
|---|---|---|
| Members | on one chassis | one per chassis, across a cluster |
| Simultaneously forwarding | all active members | one, determined by the redundancy group |
| Failure semantics | lose bandwidth | fail over |
| Governed by | LACP | the RG's priority and interface-monitor weights |
| Config | `chassis aggregated-devices ethernet device-count`, `ether-options 802.3ad ae0` | `chassis cluster reth-count`, `gigether-options redundant-parent reth0`, `reth0 redundant-ether-options redundancy-group 1` |

**Resolution: two kinds.** A single `AggregateInterface { mode: Lag | Redundant }` would
make every LACP rule wrong on a reth by default, and "wrong by default" is how a rule
engine loses trust.

Cross-vendor rules address the shared *class*, not the kind:
`applies_to: { class: MultiMemberInterface }` matches both, plus `port-channel` and `bond`.
Classes are declared in `schema.yaml` as named kind sets and are the only inheritance-like
mechanism in this design. There is deliberately no subtyping — a class is a set, not a
supertype, and a field declared on a class is a field declared identically on each member
kind.

### 12.2 Zones versus ACLs versus PAN security rules — the deepest break

| | Junos SRX | PAN-OS | IOS / IOS-XE |
|---|---|---|---|
| Container | one policy list **per zone pair** | one flat ordered list per vsys | an ACL bound to an interface + direction |
| Zones | required, first-class | required, first-class | absent (unless ZBFW) |
| Evaluation | first match within the pair, then the pair's default | first match across the whole list | first match within the ACL |
| Match on L7 | no | App-ID, first-class and often the *only* match term | no |
| Address grouping | address book, optionally zone-scoped | address objects/groups, global or device-group | object-groups |

What genuinely generalises is thin: **an ordered list of (match → action) rules with a
scope**. That is `PolicySet` + `SecurityPolicy` + `PolicyScope` (§6.6), and it holds for all
three.

What does not generalise, and what this schema does:

| Break | Decision |
|---|---|
| PAN App-ID has no Junos equivalent | `Application` carries both `l4` and `app_id`, both optional. A policy matching an `app_id`-only application is emittable on `panos` and `Blocked { NoL4Equivalent }` on `junos-srx`. **The emitter does not translate.** There is no App-ID → port mapping that is correct, and one that is 90% correct is worse than a refusal |
| Junos zone-pair ordering vs PAN global ordering | `PolicySet.evaluation` records which. Converting between them changes the *meaning* of every rule's position, so cross-platform policy conversion is not offered |
| IOS ACLs have no zones | `PolicyScope::InterfaceDirection`. A Junos policy set cannot be emitted to a scope-less platform without a zone→interface expansion that multiplies rules and changes semantics |

**Stated plainly: cross-vendor emit of a security policy is not a supported operation and
probably never will be.** The IR models all three faithfully. It does not pretend they are
convertible. That is a product decision as much as a schema one and it should be in the
docs the user reads, not buried here. The thing Fathom *can* do across vendors is
`explain` — read a PAN rule set and a Junos rule set and describe both in the same
vocabulary — and that is the actual value of the neutral model, not translation.

### 12.3 `routing-instance` versus VRF versus virtual router

Junos `instance-type` spans `virtual-router`, `vrf`, `forwarding`, `virtual-switch`,
`mac-vrf`, `no-forwarding` and others. Only `vrf` carries route-distinguisher and
route-target semantics; `virtual-router` is a routing table with no L3VPN machinery. Cisco
`vrf definition` is closest to Junos `vrf`. PAN-OS virtual routers (logical routers under
advanced routing) have no RD/RT at all.

**Resolution:** `RoutingInstance.isolation ∈ {RoutingTableOnly, L3Vpn, L2Bridge, Forwarding,
NonForwarding}` as the neutral discriminant, with `route_distinguisher` / `vrf_import` /
`vrf_export` / `vrf_target` required only under `L3Vpn`. Emitting an `L3Vpn` instance to a
platform with no L3VPN support is `Blocked { Unsupported }`.

<!-- VERIFY: the full current Junos instance-type list and the exact mapping of
     `mac-vrf` and `evpn` variants onto `isolation`. The five-value discriminant may need
     a sixth for EVPN before that domain is modelled at all. -->

### 12.4 The extension bag

Everything above is a break the schema absorbs. What absorbs the breaks nobody has thought
of yet?

**DECISION — a typed, registered, namespaced extension bag, with rules that have teeth.**

```rust
pub struct VendorExt {
    pub namespace: PlatformId,   // exactly one platform. Never a vendor, never a family
    pub key: ExtKey,             // must exist in the registry
    pub value: ScalarValue,      // a semantic scalar from §4. Never a blob
    pub prov: ProvenanceId,
}
```

Registry entry:

```yaml
# corpus/extensions.yaml
- key: junos-srx/ike-gateway/general-ikeid
  platform: junos-srx
  attaches_to: [IkeGateway]
  value_type: bool
  meaning: >
    Allows a gateway to accept connections from peers whose IKE ID does not
    match the configured remote-identity, used for multi-tenant hub designs.
  emit: 'set security ike gateway {{node.name}} general-ikeid'
  since_schema: "3.0"
  owner: <named human>
  promotion_review: 2027-01-01
  reviewed_by: <named human>
```

<!-- VERIFY: `general-ikeid` is a real Junos SRX ike-gateway statement, but confirm the
     exact spelling, the releases it exists in, and its precise semantics against Juniper
     documentation before this entry ships. It is used here as a shape example. -->

#### The rules

| # | Rule | Enforced by |
|---|---|---|
| 1 | **Registered, not free-form.** An `ExtKey` not in `extensions.yaml` fails schema validation on write. There is no "just stash it in the bag for now" | the store, at write time |
| 2 | **Typed values only.** `value` is a semantic scalar. No JSON, no strings that are secretly structured, no comma-separated lists | the type |
| 3 | **One platform per key.** A key names exactly one `PlatformId`. If two platforms want the same key, that is proof it is a core concept and it must be promoted | schema validation |
| 4 | **Not a rule input by default.** A rule may read a `VendorExt` only if it declares `platforms:` containing that key's platform **and** declares `uses_ext: [key]`. Rules cannot drift into depending on the bag by accident | the rule loader |
| 5 | **Never load-bearing for identity.** Identity tuples (§10.3) may not reference extension keys | schema validation |
| 6 | **Three strikes → promote.** When a key attaches to ≥3 kinds, or ≥3 rules declare `uses_ext` for it, or its `promotion_review` date passes, CI fails until it is either promoted to a real field (a minor bump) or re-dated with a written reason recorded in the registry | CI |
| 7 | **A budget.** Extension keys may not exceed **15%** of the total field count of the kinds they attach to. When the cap trips, the build fails and somebody has to do modelling work | CI |
| 8 | **Never a secret.** `value_type` may not be `SecretPlaceholder` and may not be `Text`. The bag is not a back door around invariant 3, and `Text` is how it would become one | schema validation |

#### The honest part

The bag is where the model goes to die. Every one of those eight rules is a tax on the
person in a hurry, and the person in a hurry is you at 23:00 trying to ship the PAN
emitter. Rules 6 and 7 exist because good intentions do not survive a deadline, and they
are deliberately implemented as **build failures** rather than warnings, because a warning
in CI is a thing people learn to scroll past.

The 15% number is arbitrary and I will say so. The point of a number is not that 15% is
correct — it is that when the build breaks, a human has to have the conversation about
whether the concept belongs in the model. Any number forces that conversation. No number
never does.

The thing that will actually go wrong: rule 3 (one platform per key) will get worked
around by defining `junos-srx/x` and `junos-mx/x` as separate keys with identical meanings,
which technically satisfies the rule and defeats it entirely. The only defence is that the
registry requires a `meaning:` and a named `owner:`, and CI can flag duplicate `meaning:`
strings across platforms. That check will be gamed too. At some point a person has to read
the registry, which is why `promotion_review` is a date and not a boolean.

---

## 13. Core Rust definitions

Illustrative of the shape, not the whole schema — the per-kind bodies are generated
(§11.6). Types shown are what an implementer needs to get the core right.

```rust
// ---------------------------------------------------------------- identity

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Ulid(pub u128);

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId { pub kind: NodeKind, pub ulid: Ulid }

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EdgeId { pub kind: EdgeKind, pub ulid: Ulid }

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ElementId { Node(NodeId), Edge(EdgeId) }

/// Stable, schema-assigned. Not a ULID — see §19.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FieldKey(pub u16);

#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FieldRef { pub element: ElementId, pub field: FieldKey }

// ---------------------------------------------------------------- presence

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Presence<T> { Set(T), Default(T), Absent, Unknown }

impl<T> Presence<T> {
    /// Only `Set`. The value somebody actually chose.
    pub fn asserted(&self) -> Option<&T> {
        match self { Presence::Set(v) => Some(v), _ => None }
    }
    /// `Set` or `Default`. What the box will actually do.
    pub fn effective(&self) -> Option<&T> {
        match self { Presence::Set(v) | Presence::Default(v) => Some(v), _ => None }
    }
    pub fn is_unknown(&self) -> bool { matches!(self, Presence::Unknown) }
    pub fn is_absent(&self)  -> bool { matches!(self, Presence::Absent) }
    pub fn is_default(&self) -> bool { matches!(self, Presence::Default(_)) }
    // Deliberately absent: is_none, unwrap, Into<Option<T>>, Default impl.
}

#[derive(Clone)]
pub enum Field<T> {
    Resolved   { value: Presence<T>, prov: ProvenanceId },
    Conflicted { candidates: SmallVec<[Candidate<T>; 2]> },
}

#[derive(Clone)]
pub struct Candidate<T> { pub value: Presence<T>, pub prov: ProvenanceId }

// ---------------------------------------------------------------- elements

pub struct Node {
    pub id: NodeId,
    pub body: NodeBody,                    // one variant per kind, generated
    pub existence: ProvenanceId,
    pub ext: SmallVec<[VendorExt; 0]>,     // zero inline: the common case is none
    pub aka: SmallVec<[FormerName; 0]>,
    pub absent_since: Option<Timestamp>,   // §10.5 tombstone
    pub unknown: RawMap,                   // forward-compat carrier; empty at same version
}

pub struct Edge {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub body: EdgeBody,                    // fields, if the kind has any
    pub prov: ProvenanceId,
    pub unknown: RawMap,
}

// ---------------------------------------------------------------- one kind

/// Generated. Shown by hand here so the shape is concrete.
pub struct IkeGatewayBody {
    pub name:            Field<Identifier>,
    pub peer:            Field<PeerSpec>,
    pub version:         Field<IkeVersion>,
    pub local_identity:  Field<IkeId>,
    pub remote_identity: Field<IkeId>,
    pub dpd:             Field<Dpd>,
    pub nat_keepalive:   Field<Seconds>,
    pub no_nat_traversal:Field<bool>,
    pub description:     Field<Text>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum PeerSpec { Address(IpAddr), Dynamic(IkeId) }

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Dpd {
    pub mode: DpdMode,          // Optimized | ProbeIdleTunnel | AlwaysSend
    pub interval: Seconds,      // default 10
    pub threshold: u8,          // default 5  -> 50 s, side 2
}

// ---------------------------------------------------------------- the graph

pub struct Graph {
    nodes:   SlotMap<NodeIdx, Node>,
    edges:   SlotMap<EdgeIdx, Edge>,
    by_id:   HashMap<NodeId, NodeIdx>,
    /// Forward and reverse adjacency, bucketed by edge kind.
    out:     HashMap<(NodeIdx, EdgeKind), SmallVec<[EdgeIdx; 2]>>,
    inn:     HashMap<(NodeIdx, EdgeKind), SmallVec<[EdgeIdx; 2]>>,
    /// Deterministic iteration for invariant 9: sorted by NodeId, maintained
    /// incrementally, never derived from HashMap order.
    by_kind: EnumMap<NodeKind, Vec<NodeIdx>>,
    prov:     ProvenanceStore,
    history:  FieldHistoryStore,     // side table, §8.6
    captures: CaptureStore,          // §8.4
    derived:  DerivedArena,          // §3.5, not serialised
    schema:  &'static Schema,
}

/// Cardinality-typed relation accessors, generated per edge kind.
pub struct Rel1<'g, K>(&'g Node, PhantomData<K>);    // exactly one
pub struct RelOpt<'g, K>(Option<&'g Node>, PhantomData<K>);
pub struct RelMany<'g, K>(SmallVec<[&'g Node; 4]>, PhantomData<K>);

impl Graph {
    /// Generated: `1` cardinality, so a missing edge is an L1 hole, and the
    /// caller gets a Blocker rather than an Option to forget about.
    pub fn ike_gateway(&self, vpn: NodeId) -> Result<&Node, Blocker> { /* … */ }

    pub fn out(&self, n: NodeId, k: EdgeKind) -> impl Iterator<Item = &Edge> { /* … */ }
    pub fn inn(&self, n: NodeId, k: EdgeKind) -> impl Iterator<Item = &Edge> { /* … */ }
    pub fn owner(&self, n: NodeId) -> Option<&Node> { /* the containment parent */ }
    pub fn device_of(&self, n: NodeId) -> Option<&Node> { /* walk containment up */ }
}

// ---------------------------------------------------------------- emit

pub struct EmittedLine {
    pub text: String,
    pub source_node: NodeId,
    pub source_fields: Vec<FieldRef>,
    pub rules_applied: Vec<RuleId>,
    pub risk: Risk,               // ReadOnly | ChangesConfig | Disruptive
    pub order_hint: u32,
    /// Continuation-backslash wrapping, preserved as the field card does it.
    pub wrap: WrapStyle,
}

pub enum Risk { ReadOnly, ChangesConfig, Disruptive }
```

`EmittedLine` is the owner's §5.3 struct with two additions: `wrap`, because the design
language requires continuation backslashes to wrap the way a terminal wraps
(`set security ike proposal IKE-P1 \`), and that is a property of the emitted line, not of
the renderer.

---

## 14. Storage, size and complexity

### 14.1 Wire format

| Layer | Choice | Why |
|---|---|---|
| Encoding | CBOR, canonical form (RFC 8949 deterministic encoding) | Self-describing enough for `RawValue` round-tripping, compact, no floats needed anywhere in this schema, and a deterministic profile exists — which invariant 9 requires |
| Field keys on the wire | `FieldKey(u16)` from the generated registry, not names | Halves the document and makes a rename a registry alias rather than a rewrite |
| Sections | `header` (plaintext, AEAD-authenticated) · `graph` · `provenance` · `history` · `captures[]` · `suppressions` · `settings` | Captures are cold and large (§8.4); history is cold; the graph is hot. Opening a workspace decrypts `header` + `graph` + `provenance` only |
| Compression | per-section, before encryption | Captures compress ~5–10× as text. Compressing before encryption leaks length information about the plaintext, which for a config dump is a weak but real side channel. <!-- VERIFY: decide this against the threat model in the security docs. If compression-before-encryption is ruled out, capture storage roughly quintuples and §14.2's numbers move. --> |
| Ordering | every map and array serialised in `NodeId` / `FieldKey` order | Byte-identical output for identical content, which makes the document git-diffable (§6.4) |

### 14.2 Size, as arithmetic

Not a benchmark. Arithmetic over the declared struct sizes, with the assumptions visible so
they can be argued with.

Per-element, in memory:

| Thing | Bytes | Made of |
|---|---|---|
| `NodeId` | 17 | kind `u8` + ULID 16 |
| `ProvenanceId` | 16 | ULID |
| `Field<T>` overhead | ~24 | discriminant + `ProvenanceId` + `Presence` tag, before `T` |
| `ProvenanceRecord` | ~72 | id 16 + origin tag + capture 16 + span 8 + timestamp 8 + actor 16 + flags |
| `Edge` | ~64 | id 17 + from 17 + to 17 + prov 16, plus body |
| Adjacency entry | ~24 | key `(NodeIdx, EdgeKind)` + `EdgeIdx`, per direction |

A modest firewall, parsed whole:

| Kind | Count | Fields each | Node bytes | Prov bytes |
|---|---|---|---|---|
| `Device`, `Chassis`, settings | 5 | 8 | 2 K | 3 K |
| `Interface` | 48 | 8 | 20 K | 28 K |
| `LogicalUnit` | 120 | 6 | 40 K | 52 K |
| `Address` | 130 | 4 | 30 K | 37 K |
| `Zone` | 8 | 5 | 3 K | 3 K |
| `AddressObject` / `AddressSet` | 220 | 3 | 45 K | 48 K |
| `Application` / sets | 60 | 4 | 14 K | 17 K |
| `PolicySet` / `SecurityPolicy` | 165 | 7 | 55 K | 83 K |
| `StaticRoute` | 40 | 4 | 10 K | 12 K |
| crypto kinds | 30 | 6 | 9 K | 13 K |
| **Nodes** | **~830** | | **~230 K** | **~300 K** |
| Edges + both adjacency directions | ~1 900 | | ~210 K | ~140 K |
| Capture text (4 000 lines × 55 B) | | | ~220 K | |
| **Per device, total** | | | **≈ 1.1 MB** | |

So: **roughly 1 MB of resident memory per fully-parsed mid-size firewall**, of which
provenance is ~40%. A 200-device estate is ~220 MB, which is above what is comfortable in a
browser tab and well within a native CLI.

Consequences, stated rather than wished away:

1. **The browser cannot hold a large estate fully resident.** Above roughly 50–80 devices,
   the client needs lazy section loading: decrypt `graph` for all devices, but load
   `provenance`, `history` and `captures` per device on demand. That is a real subsystem
   and it should be designed in from the start, not retrofitted.
2. **Provenance is the thing that blows the budget**, exactly as F9 predicted. The
   capture-span design (§8.4) already saved ~5× over inline raw lines; the remaining cost
   is irreducible if per-field provenance is kept, and per-field provenance is F3.
3. §6.4's honest note — *"At several thousand devices it stops being one"* — is confirmed
   by this arithmetic, not contradicted by it.

<!-- VERIFY: every number above is arithmetic over assumed struct layouts and an assumed
     config size. Measure against a real `show configuration | display set` from an SRX345
     before any capacity claim is made in user-facing material. -->

### 14.3 Complexity of the operations that matter

| Operation | Complexity | Note |
|---|---|---|
| Node by `NodeId` | `O(1)` | hash |
| Out-edges of one kind | `O(1) + O(deg)` | bucketed adjacency |
| All nodes of a kind | `O(\|K\|)` | maintained sorted by `NodeId` for determinism |
| Containment parent | `O(1)` | one containment in-edge, cached |
| `device_of(n)` | `O(depth)`, depth ≤ 5 | Site→Device→Interface→Unit→Address is the deepest chain |
| L0 check on a mutation | `O(1)` amortised for field writes; `O(deg)` for edge writes; `O(α(n))` for set-cycle checks | union-find for `AddressSet` nesting |
| Full rule pass | `O(R · \|K_R\|· t)` | `R` rules, each over its `applies_to` kind bucket, `t` = traversal cost of its condition. Not `O(R · N)` — the kind bucket is the index |
| Emit unit closure | `O(V + E)` in the closure | DFS |
| Re-identification | `O(n + f · 4096 · \|kinds\|)` | §10.4 |
| Inference pass | `O(N + E)` | one level deep by construction (§9.5) |
| Merge of two workspaces | `O(P₁ + P₂ + F)` | provenance union + per-field resolution over changed fields only |

The `applies_to`-as-index point is the one that makes continuous lint (§6.6) viable: rules
never scan the graph, they scan a kind bucket. A rule pack with 400 rules over a graph with
830 nodes touches a few thousand nodes total, not 332 000.

### 14.4 Re-nesting for display

Containment as edges makes the serialised document flat, which is worse for a human reading
a git diff. The workspace inspector re-nests containment for display, producing exactly the
shape of the owner's §5.1 tree. That is a rendering concern with no storage cost, and it is
the right place to solve it — the alternative (nesting in storage) makes every edge write a
tree mutation.

---

## 15. Worked example — SRX side 1, end to end

The complete graph for the site-to-site tunnel on side 1 of the field card, including all
five plumbing pieces, in a readable dump. ULIDs are abbreviated to their last five
characters for legibility; in the real document they are full 26-character Crockford
base32.

Two provenance shapes are shown deliberately: a **parsed** workspace (the §6.3 paste
on-ramp — someone pasted `show configuration | display set` from the box) with a few
hand-entered and defaulted values mixed in, because that mixture is the realistic case and
it is what the four-state `Presence` exists for.

### 15.1 Provenance and captures referenced below

```yaml
captures:
  cap-A1B2C:
    taken_at: 2026-07-14T08:41:07Z
    device:   fathom:device:7QK4M
    scope:    Whole                       # a full display-set dump: closed-world
    platform: junos-srx
    command:  "show configuration | display set"
    digest:   blake3:9f2c…                # of the redacted text
    text:     <4,102 lines, PSK token redacted in place>

provenance:
  p-0001: { origin: Parsed{cap-A1B2C, span, stanza}, at: 2026-07-14T08:41:07Z,
            by: Parser(junos-set/2.3.0), confidence: Asserted }
  p-0042: { origin: Hand{step: wizard.ipsec.site.identify}, at: 2026-07-14T09:02:11Z,
            by: User(u-01), confidence: Asserted }
  p-0071: { origin: Defaulted{junos-srx, "*", "field card side 4", corpus 1.4.0},
            at: <read time>, by: Migration(none), confidence: Derived }
  p-0088: { origin: Inferred{rule: infer.tunnel.pair, inputs: [...],
            explain: explain:infer:tunnel.pair}, at: 2026-07-14T08:41:09Z,
            by: Inference(infer.tunnel.pair), confidence: Heuristic }
```

### 15.2 Site, device, chassis

```yaml
- id: fathom:site:3Y8QW
  kind: Site
  fields:
    name:        Set("Site A")            prov: p-0042
    code:        Set("SITEA")             prov: p-0042
    criticality: Unknown

- id: fathom:device:7QK4M
  kind: Device
  fields:
    hostname:   Set("srx-a-01")           prov: p-0001   # set system host-name
    platform:   Set(junos-srx)            prov: p-0001
    os_version: Set(21.4R3-S4.9)          prov: p-0001   # from `show version` paste
    role:       Set(Firewall)             prov: p-0042
    cluster_id: Set(1)                    prov: p-0001   # set chassis cluster cluster-id 1
    default_cross_zone_action: Default(Deny)  prov: p-0071
  edges_in:
    HasDevice from fathom:site:3Y8QW

- id: fathom:chassis:9M2XV   member_index: Set(0)  model: Set("SRX345")  prov: p-0001
- id: fathom:chassis:9M2XW   member_index: Set(1)  model: Set("SRX345")  prov: p-0001

- id: fathom:redundancy-group:K4T7P
  kind: RedundancyGroup
  fields:
    number:        Set(1)                 prov: p-0001
    node_priority: Set([(0,200),(1,100)]) prov: p-0001
    preempt:       Absent                 prov: p-0001   # closed-world: not configured
```

`preempt: Absent` rather than `Unknown` is only assertable because `cap-A1B2C.scope` is
`Whole` (§8.5).

### 15.3 Interfaces — the WAN reth and the tunnel interface

```yaml
- id: fathom:reth-interface:B6R2N
  kind: RethInterface
  fields:
    name: Set(InterfaceName{ raw:"reth0", parsed: Reth/Index(0) })   prov: p-0001
    minimum_links: Unknown
    mtu:           Unknown
  edges_out:
    InRedundancyGroup -> fathom:redundancy-group:K4T7P              prov: p-0001
  edges_in:
    MemberOfReth  from fathom:interface:C1F8H  { chassis: 9M2XV }   prov: p-0001
    MemberOfReth  from fathom:interface:C1F8J  { chassis: 9M2XW }   prov: p-0001

- id: fathom:logical-unit:D3W9L                # reth0.0
  kind: LogicalUnit
  fields:
    index:    Set(0)                      prov: p-0001
    families: Set({Inet})                 prov: p-0001
    family_mtu: Unknown
  edges_in:
    HasUnit    from fathom:reth-interface:B6R2N
    ZoneMember from fathom:zone:F7N1K  (zone WAN)   # piece #3, see 15.6
  edges_out:
    HasAddress -> fathom:address:E5V0Z

- id: fathom:address:E5V0Z
  kind: Address
  fields:
    value:  Set(InterfaceAddress(198.51.100.5/30))  prov: p-0001
    family: Set(Inet)                                prov: p-0001

- id: fathom:tunnel-interface:G2H6D             # st0        — piece #1
  kind: TunnelInterface
  fields:
    name:       Set(InterfaceName{ raw:"st0", parsed: St/Index(0) })  prov: p-0001
    technology: Set(IpsecVti)                                          prov: p-0001

- id: fathom:logical-unit:H8J4S                 # st0.0      — piece #1
  kind: LogicalUnit
  fields:
    index:      Set(0)                    prov: p-0001
    families:   Set({Inet})               prov: p-0001
    family_mtu: Unknown                   #  <-- side 4 lives here; nobody set it
  edges_in:
    HasUnit    from fathom:tunnel-interface:G2H6D
    ZoneMember from fathom:zone:J9L3M  (zone VPN)      # piece #2
    BindsInterface from fathom:ipsec-vpn:R7T2Q
  edges_out:
    HasAddress -> fathom:address:K1P5X

- id: fathom:address:K1P5X
  kind: Address
  fields:
    value:  Set(InterfaceAddress(10.255.0.1/30))   prov: p-0001
    family: Set(Inet)                              prov: p-0001
```

Note `10.255.0.1/30` is an `InterfaceAddress` with host bits preserved, while
`10.2.0.0/16` below is an `IpPrefix` with host bits zeroed. Different types (§4.3).

### 15.4 Phase 1 — proposal, policy, gateway

```yaml
- id: fathom:ike-proposal:L4C8B
  kind: IkeProposal
  fields:
    name:                     Set("IKE-P1")             prov: p-0001
    authentication_method:    Set(PreSharedKeys)        prov: p-0001
    dh_group:                 Set(Modp2048)             prov: p-0001   # group14
    encryption_algorithm:     Set(Aes{256,Cbc,aead:false}) prov: p-0001
    authentication_algorithm: Set(HmacSha256_128)       prov: p-0001   # sha-256
    lifetime_seconds:         Set(28800)                prov: p-0001

- id: fathom:ike-policy:M6D0V
  kind: IkePolicy
  fields:
    name:            Set("IKE-POL")                             prov: p-0001
    mode:            Unknown                                    #  see 15.9
    pre_shared_key:  Set(SecretPlaceholder{ label: Psk, hint: None })  prov: p-0001
  edges_out:
    UsesProposal -> fathom:ike-proposal:L4C8B { ordinal: 0 }    prov: p-0001

- id: fathom:ike-gateway:N2F7R
  kind: IkeGateway
  fields:
    name:            Set("GW-B")                                prov: p-0001
    peer:            Set(Address(203.0.113.10))                 prov: p-0001
    version:         Set(V2Only)                                prov: p-0001
    local_identity:  Set(Inet(198.51.100.5))                    prov: p-0001
    remote_identity: Set(Inet(203.0.113.10))                    prov: p-0001
    dpd:             Set(Dpd{ AlwaysSend, interval:10, threshold:3 })  prov: p-0001
    nat_keepalive:   Absent                                     prov: p-0001
  edges_out:
    UsesIkePolicy     -> fathom:ike-policy:M6D0V                prov: p-0001
    ExternalInterface -> fathom:logical-unit:D3W9L   (reth0.0)  prov: p-0001
    PeerIs            -> fathom:external-peer:P0K9C             prov: p-0042
```

The `pre_shared_key` field holds a `SecretPlaceholder`, not a value. The parser matched
`set security ike policy IKE-POL pre-shared-key ascii-text "…"`, constructed the
placeholder, and redacted the token span in `cap-A1B2C.text` before the capture was stored
(§8.4). There is no code path by which the real key exists in the workspace.

`ExternalInterface` points at `reth0.0`, the WAN unit — not at `st0.0`. That is a graph
edge, so the rule `ike.external-interface.is-tunnel` (fires when the target's owner is a
`TunnelInterface`) is a one-hop check rather than a string comparison. Side 1: *"Wrong on a
multi-homed box means Phase 1 sources from an address the peer has never heard of."*

### 15.5 Phase 2 — proposal, policy, VPN, selector

```yaml
- id: fathom:ipsec-proposal:Q8S1T
  kind: IpsecProposal
  fields:
    name:                     Set("IPSEC-P2")               prov: p-0001
    protocol:                 Set(Esp)                      prov: p-0001
    encryption_algorithm:     Set(Aes{256,Gcm,aead:true})   prov: p-0001
    authentication_algorithm: Absent                        prov: p-0001
    lifetime_seconds:         Set(3600)                     prov: p-0001
    lifetime_kilobytes:       Absent                        prov: p-0001

- id: fathom:ipsec-policy:S3B6Y
  kind: IpsecPolicy
  fields:
    name:                    Set("IPSEC-POL")               prov: p-0001
    perfect_forward_secrecy: Set(Modp2048)                  prov: p-0001   # keys group14
  edges_out:
    UsesProposal -> fathom:ipsec-proposal:Q8S1T { ordinal: 0 }   prov: p-0001

- id: fathom:ipsec-vpn:R7T2Q
  kind: IpsecVpn
  fields:
    name:              Set("VPN-B")                         prov: p-0001
    mode:              Set(RouteBased)                      prov: p-0001
    establish_tunnels: Set(Immediately)                     prov: p-0001
    df_bit:            Default(Copy)                        prov: p-0071   # side 4
    vpn_monitor:       Absent                               prov: p-0001
    idle_time:         Unknown
  edges_out:
    UsesIkeGateway     -> fathom:ike-gateway:N2F7R          prov: p-0001
    UsesIpsecPolicy    -> fathom:ipsec-policy:S3B6Y         prov: p-0001
    BindsInterface     -> fathom:logical-unit:H8J4S (st0.0) prov: p-0001
    HasTrafficSelector -> fathom:traffic-selector:T5N8F     prov: p-0001

- id: fathom:traffic-selector:T5N8F
  kind: TrafficSelector
  fields:
    name:      Set("TS1")                 prov: p-0001
    local_ip:  Set(10.1.0.0/16)           prov: p-0001
    remote_ip: Set(10.2.0.0/16)           prov: p-0001
    protocol:  Unknown
```

`authentication_algorithm: Absent` on the IPsec proposal is *correct and required*, because
`encryption_algorithm.aead == true`. The schema constraint
`ipsec-proposal.aead-excludes-hash` checks it; a `Set` value here would block emit. Side 1:
*"GCM is AEAD, so there is no separate authentication-algorithm."*

`df_bit: Default(Copy)` is not in the config. It is read from the corpus defaults table at
read time and never written into the document (§5.3). The emitter skips it; a rule reading
`df_bit.effective()` still gets `Copy`.

### 15.6 The five plumbing pieces

```yaml
# #1  the tunnel interface  — fathom:tunnel-interface:G2H6D + logical-unit:H8J4S
#     + address:K1P5X (10.255.0.1/30), above.

# #2  st0 into a zone
- id: fathom:zone:J9L3M
  kind: Zone
  fields:
    name:                         Set("VPN")     prov: p-0001
    host_inbound_system_services: Absent         prov: p-0001
edge:
  ZoneMember  fathom:zone:J9L3M -> fathom:logical-unit:H8J4S   # st0.0
    id: fathom:zone-member:U1G4A
    fields:
      host_inbound_system_services: Absent       prov: p-0001
      host_inbound_protocols:       Absent       prov: p-0001

# #3  let IKE reach the box on the WAN zone
- id: fathom:zone:F7N1K
  kind: Zone
  fields:
    name:                         Set("WAN")     prov: p-0001
    host_inbound_system_services: Absent         prov: p-0001   # not set zone-wide
edge:
  ZoneMember  fathom:zone:F7N1K -> fathom:logical-unit:D3W9L   # reth0.0
    id: fathom:zone-member:V6E2W
    fields:
      host_inbound_system_services: Set({Ike})   prov: p-0001   # <-- piece #3
      host_inbound_protocols:       Absent       prov: p-0001

# #4  route the remote prefix at st0
- id: fathom:routing-instance:W9Z3H
  kind: RoutingInstance
  fields:
    name:      Set("inet.0")                     prov: p-0001   # the default instance
    isolation: Set(RoutingTableOnly)             prov: p-0001

- id: fathom:static-route:X2Q7E
  kind: StaticRoute
  fields:
    destination: Set(IpPrefix(10.2.0.0/16))                        prov: p-0001
    next_hop:    Set([Interface(fathom:logical-unit:H8J4S)])       prov: p-0001
    preference:  Unknown
    metric:      Unknown

# #5  policy for the zone pair
- id: fathom:zone:Y4A8U
  kind: Zone
  fields:
    name: Set("TRUST")                           prov: p-0001

- id: fathom:policy-set:Z7C1I
  kind: PolicySet
  fields:
    scope:          Set(ZonePair{ from: fathom:zone:Y4A8U, to: fathom:zone:J9L3M })
                                                 prov: p-0001
    evaluation:     Set(FirstMatch)              prov: p-0071
    default_action: Default(Deny)                prov: p-0071

- id: fathom:security-policy:A9D5O
  kind: SecurityPolicy
  fields:
    name:                    Set("TO-B")         prov: p-0001
    ordinal:                 Set(0)              prov: p-0001
    action:                  Set(Permit)         prov: p-0001
    match_any_source:        Set(true)           prov: p-0001
    match_any_destination:   Set(true)           prov: p-0001
    log_init:                Absent              prov: p-0001
    log_close:               Absent              prov: p-0001
  edges_out:
    InPolicySet      -> fathom:policy-set:Z7C1I  prov: p-0001
    MatchApplication -> (none — `application any` is match_any, not an edge)
```

`application any` is `match_any_*: Set(true)`, not an edge to an `Application` named `any`.
Modelling the vendor's `any` keyword as a real object would make "does this policy permit
everything" a set-membership question with a magic member, and a rule would eventually get
it wrong.

### 15.7 The far end, and the tunnel

```yaml
- id: fathom:external-peer:P0K9C
  kind: ExternalPeer
  fields:
    label:          Set("Site B")                prov: p-0042
    address:        Set(203.0.113.10)            prov: p-0042
    platform_guess: Unknown

- id: fathom:tunnel:B3F9N
  kind: Tunnel
  fields:
    name:           Set("Site A ⇄ Site B")       prov: p-0088   # Heuristic, inferred
    mode:           Set(RouteBased)              prov: p-0088
    intended_state: Unknown
    overlay_prefix: Set(10.255.0.0/30)           prov: p-0088
  edges_out:
    TunnelEndpoint -> fathom:ipsec-vpn:R7T2Q { side: A }   prov: p-0088
    TunnelPeer     -> fathom:external-peer:P0K9C           prov: p-0088
```

The `Tunnel` was produced by `infer.tunnel.pair` with `Confidence::Heuristic`. It renders
with a margin tab `inferred` and every field on it is excluded from emit — which costs
nothing, because `Tunnel` has no vendor representation at all.

### 15.8 Derived elements (not serialised)

```yaml
derived:
  - ResolvesVia    fathom:static-route:X2Q7E -> fathom:logical-unit:H8J4S
      basis: infer.route.next-hop-interface   confidence: Derived
  - SelectorCovers fathom:traffic-selector:T5N8F -> fathom:static-route:X2Q7E
      basis: infer.ts.route-coverage          confidence: Derived
      # 10.2.0.0/16 (TS remote) == the route destination, and the route's
      # next hop is the VPN's bound unit. Piece #4 is satisfied.
```

The absence of a `NatOverlaps` edge here is itself informative: this workspace has no
`NatRuleSet`, so `infer.nat.tunnel-overlap` produced nothing, and the rule
`nat.source.eats-tunnel` returns `Unevaluable(Gap::MissingEdge{HasNatRuleSet})` rather than
`Passed`. Side 4 names source NAT as a top-tier tunnel killer; the honest answer with no NAT
data is "I cannot tell", not "you are fine".

### 15.9 What the engines say about this graph

**Emit** — `emit(graph, junos-srx, unit = IpsecVpn VPN-B)`. First eight items of the
stream, with the `order_hint` from the closure DFS of §9.2:

| # | Item | text | `source_node` | `source_fields` | risk |
|---|---|---|---|---|---|
| 0 | Comment | `# Phase 1 — proposal, policy, gateway` | — | — | ReadOnly |
| 1 | Line | `set security ike proposal IKE-P1 authentication-method pre-shared-keys` | `ike-proposal:L4C8B` | `[name, authentication_method]` | ChangesConfig |
| 2 | Line | `set security ike proposal IKE-P1 dh-group group14` | `ike-proposal:L4C8B` | `[name, dh_group]` | ChangesConfig |
| 3 | Line | `set security ike proposal IKE-P1 authentication-algorithm sha-256` | `ike-proposal:L4C8B` | `[name, authentication_algorithm]` | ChangesConfig |
| 4 | Line | `set security ike proposal IKE-P1 encryption-algorithm aes-256-cbc` | `ike-proposal:L4C8B` | `[name, encryption_algorithm]` | ChangesConfig |
| 5 | Line | `set security ike proposal IKE-P1 lifetime-seconds 28800` | `ike-proposal:L4C8B` | `[name, lifetime_seconds]` | ChangesConfig |
| 6 | Line | `set security ike policy IKE-POL proposals IKE-P1` | `ike-policy:M6D0V` | `[name]` + edge `UsesProposal` | ChangesConfig |
| 7 | **Placeholder** | `set security ike policy IKE-POL pre-shared-key ascii-text "<PSK>"` | `ike-policy:M6D0V` | `[pre_shared_key]` | ChangesConfig |

Item 7 is a `Placeholder`, not a `Blocked` — invariant 3 made this hole on purpose and the
emitted line is correct output (§9.4).

Nothing in this closure emits a line for `df_bit`, because it is `Default(Copy)`. Nothing
emits `mode` on `IKE-POL`, because it is `Unknown` and `mode` is `R*` on IKEv1 only, and
the gateway is `V2Only`. The `R*` predicate reads the *gateway's* version through the
`UsesIkePolicy` in-edge — a cross-node condition, which is exactly why `R*` is expressed as
a schema constraint rather than a per-field boolean.

**Findings** — a representative four out of the pass:

| Rule | `Eval` | Why |
|---|---|---|
| `ipsec.pfs.absent` | `Passed` | `perfect_forward_secrecy` is `Set(Modp2048)` |
| `ike.aggressive-mode.v1` | `NotApplicable` | `IkeGateway.version` is `V2Only`; side 2: *"`mode` is silently ignored under `v2-only` … do not chase it"* |
| `mtu.mss-clamp.absent` | `Unevaluable(Gap::MissingEdge{ HasFlowSettings })` | No `SecurityFlowSettings` node exists. The pasted config contained no `security flow` stanza and the capture is closed-world for it — so this **should** in fact resolve to a node with `tcp_mss_ipsec_vpn: Absent` and the rule should fire. It does not, because the parser has no production for `security flow`. That gap is a parser bug the completeness prompt will surface as *"1 check blocked"* rather than silently passing, which is the whole argument for the four-valued `Eval` |
| `policy.match.any-any-permit` | `Fired` | `TO-B` has `match_any_source`, `match_any_destination` and no application edges, action `Permit` |

The `mtu.mss-clamp.absent` row is deliberately the uncomfortable one. A three-valued
evaluation would have reported `Passed` and the user would have shipped a tunnel with no
MSS clamp and side 4's *"Ping works. SSH connects. Then `ls` hangs"* waiting for them.

The fired finding, rendered at `Explained` depth in the design language — 4px accent bar,
wash, no box, no icon:

```
▌ policy.match.any-any-permit                                     TRUST → VPN · TO-B
▌
▌ This policy permits every source to every destination for every
▌ application. It is the widest rule expressible on the platform.
▌
▌ why           A tunnel policy usually needs to permit only the traffic
▌               inside the traffic selector. TS1 is 10.1.0.0/16 → 10.2.0.0/16,
▌               so an any/any policy permits considerably more than the
▌               tunnel can carry, and the extra is denied later and less
▌               visibly.
▌ acceptable    A transit or lab zone pair where the tunnel selector is
▌ when          already the only constraint and both ends are trusted.
▌               Record the exception.
▌ remediation   set security policies from-zone TRUST to-zone VPN policy TO-B \
▌                 match source-address SITEA-LAN destination-address SITEB-LAN
▌ evidence      parsed 14 days ago from show configuration | display set
```

**Table** — `table(graph)` over `IkeGateway` yields one row: name `GW-B`, peer
`203.0.113.10`, external interface `reth0.0`, version `v2-only`, DPD `always-send 10 × 3`,
NAT keepalive `—` (an em-dash, because it is `Absent`, distinct from an empty cell for
`Unknown`). That single rendering distinction is the four-state `Presence` reaching the UI.

**Verify** — `verify(diff(graph))` for a change that added `VPN-B` walks the closure and
emits side 1's bring-up order, scoped to what changed: `show security ike
security-associations`, then `show security ipsec security-associations vpn-name VPN-B
detail` — with `VPN-B` interpolated from `IpsecVpn.name`, which is §6.1's context awareness
falling directly out of the graph — then `show security ipsec inactive-tunnels`, `show
interfaces st0.0 terse`, `show route 10.2.0.0/16`. All `ReadOnly`. The `st0.0` and
`10.2.0.0/16` values come from the `BindsInterface` edge and the `TrafficSelector`
respectively, not from a template.

---

## 16. What this design costs

Every item here is a real cost that will be paid, not a hypothetical.

| Cost | Detail | Could it be avoided? |
|---|---|---|
| **Emitters are verbose and fallible** | Every vendor name-reference becomes an indexed edge lookup that can fail at runtime where a struct field read could not. A Junos emitter for the IPsec closure is maybe 40% longer than it would be with `NodeId` fields | Only by giving up per-edge provenance and fields (§3.2), which costs `zone.host-inbound.ike-missing` |
| **Four-state `Presence` is a permanent tax on every author** | Rule authors, emitter authors and UI authors all handle four cases. The predictable bug is treating `Default` as `Set`, or `Absent` as `Unknown`. The API removes the easy footguns; it cannot remove the thinking | No. F1 is the product |
| **Provenance is ~40% of resident memory** | §14.2. The capture-span design already saved ~5×; the rest is irreducible | Only by dropping to node-level provenance, which makes the six views lie about mixed-origin nodes |
| **The browser cannot hold a large estate** | Above roughly 50–80 fully-parsed devices the client needs lazy per-device section loading — a real subsystem | No, and §6.4 already says so |
| **Codegen slows early iteration** | Adding a kind is a schema edit + regenerate + rebuild, exactly when the schema changes weekly | Hand-writing the types costs three drifting copies and rules that silently never fire |
| **~40 kinds on day one** | Every kind is a taxonomy decision that will be regretted at least once, and each one costs an explainer entry, a diagram treatment and a slot in every exhaustive match | Fewer kinds means discriminant fields, which means rules that are wrong by default on the minority case (§12.1) |
| **A node can never change kind** | Consequence of embedding kind in `NodeId` (§10.1). A mis-kinded node is a delete-and-recreate and everything referencing it must be re-pointed | Yes, by making kind a mutable field — at the cost of every edge-endpoint check becoming a graph lookup |
| **Cross-vendor policy emit is not supported** | §12.2. The IR models Junos, PAN and IOS policy faithfully and refuses to convert between them | Not honestly |
| **Deletion is never certain from fragments** | A workspace fed only pasted fragments accumulates tombstone-ineligible stale nodes forever, because no fragment can assert absence (§10.5) | Only by guessing, which destroys user data |
| **A major schema bump strands air-gapped users** | §11.4. The export format and the degraded inspector reduce the damage; they do not remove it | No |
| **The extension bag will rot** | §12.4 names the specific workaround (per-family key duplication) that defeats its own rules. The registry, the review dates and the CI cap slow it down. They do not stop it | No. Rule 6's `promotion_review` date exists because a human eventually has to read the registry |
| **The inference pass is one level deep** | §9.5. Genuinely useful two-step inferences are simply unavailable, and this will be uncomfortable | Yes, at the cost of a fixpoint computation on every workspace open and much harder determinism |
| **`InterfaceName` has two sources of truth** | `raw` wins on emit, `parsed` wins on comparison (§4.6). Every author has to remember the precedence | Only by canonicalising, which silently rewrites the user's config |

---

## 17. Open decisions

Things a reviewer should push back on before implementation starts.

| # | Question | My position | Why it is still open |
|---|---|---|---|
| 1 | Should `Presence::Default` exist at all, or should defaults be a read-time overlay with no field state? | Keep the state. A rule needs to distinguish "chose 10×5" from "got 10×5" | It adds a fourth case to every match, and an overlay would give the same information through `prov.origin == Defaulted` at the cost of one indirection |
| 2 | Is 4096 the right guard on the similarity residue in §10.4? | It is a guess | Needs a measurement against real multi-thousand-object SRX configs |
| 3 | Should `Link` be an edge or should `Circuit` exist from day one? | Edge now, `Circuit` when a feature needs it | Adding `Circuit` later is a minor bump and a migration, so the cost of being wrong is bounded — but WAN circuits are common enough that someone will argue for it immediately |
| 4 | Should suppressions live in the graph as nodes? | No — workspace siblings (§6.9) | A suppression targeting a tombstoned node has no clean lifecycle either way, and putting them in the graph makes merges manufacture waivers |
| 5 | Is `RoutingIsolation`'s five-value discriminant enough for EVPN? | Probably not | Flagged `VERIFY` in §12.3. The EVPN domain is unmodelled, so the question is deferrable but not answerable now |
| 6 | Compression before encryption for capture blobs | Leaning yes | Length side channel on config text. Belongs to the security docs, not here, and §14.1 flags it |
| 7 | Does a blocker render with the risk accent bar or in severity neutrals? | Flagged `VERIFY` in §9.4 | Conventions forbid reusing risk colours for severity, and a blocker is arguably severity |
| 8 | Should the AI layer be permitted to write `Origin::Inferred`, or only `Actor::Supervisor` + `Confidence::Heuristic`? | The latter, per §8.2 | It is a boundary question that belongs to the AI architecture document; the schema supports either |

---

## 18. Deviations from §5.1 of the brief

Per the brief's instruction, contradictions with the owner's document are called out
explicitly as proposed changes with reasoning.

| §5.1 shows | This document says | Reasoning |
|---|---|---|
| `Link (physical)` as a node under `Site` | An **edge** between two `Interface` nodes, with fields | Two endpoints always, no third party references it, §3.4's promotion rule keeps it an edge. A `Circuit` node is the right answer when provider service becomes a feature (§7.4) |
| `ZoneBinding` as a node under `LogicalUnit` | The **`ZoneMember` edge**, carrying `host_inbound_system_services` and `host_inbound_protocols` | Pure two-party relation, nothing references it. It is not fieldless — piece #3 configures host-inbound per interface within the zone — and edges carry fields (§7.5) |
| `Membership` as a node under `LogicalUnit` | The **`VlanMember` edge**, carrying `mode: Access\|Trunk` | Same reasoning |
| `Zone ── Policy` under `Device` | `Zone` and `PolicySet` are siblings under `Device`; `SecurityPolicy` is contained by `PolicySet`, which references two `Zone`s | A Junos policy belongs to a zone *pair*, not to a zone. Hanging policies off one zone forces an arbitrary choice of which, and it does not survive PAN's global list or an IOS ACL (§12.2) |
| `Tunnel` under `Site`, owning `IkeGateway` and `IpsecVpn` | `Tunnel` is a root-level node with `TunnelEndpoint` edges to `IpsecVpn`; the crypto objects are contained by `Device` | A tunnel spans devices and often sites, so it cannot be contained by one. The six crypto objects are independently deletable siblings in the Junos config tree, so containment should match |
| Provenance is *"hand / parsed / inferred"* | Six `Origin` variants: `Hand`, `Parsed`, `Inferred`, plus `Imported`, `Defaulted`, `Migrated` | An extension, not a contradiction. Each of the three additions carries data the original three cannot hold without weakening their types (§8.2) |
| `RedundancyGroup` under `Device` | Unchanged — the brief is right | Noted because it looks wrong at first glance: a chassis cluster spans two boxes. It is right because a cluster has **one** configuration, so the RG belongs to the config domain, which is `Device` (§6.3) |

---

## 19. Disagreements

One, with a convention rather than with the brief.

**Convention:** *Hard invariant 7 — "Every node, edge and field carries a stable opaque ID."*

**Objection:** the node and edge halves are right and this document implements them exactly.
The **field** half, read literally as "every field instance carries a minted opaque ID", is
not affordable and does not buy anything. A mid-size firewall produces roughly 6 000 field
values (§14.2); minting a ULID per field instance adds 16 bytes each — about 96 KB per
device, ~19 MB across a 200-device estate — for an identifier that nothing needs. Field
values are addressed as `(ElementId, FieldKey)`; the element already has an opaque ID, and
a field is not independently renameable, movable or referenceable. A rule references
`IkeGateway.external_interface` — a *schema* path — not a particular device's instance of it.

**Proposed replacement:**

> Every node and edge carries a stable opaque ULID. Every **field** carries a stable,
> schema-assigned, opaque-to-users `FieldKey` (a `u16` from the generated registry), and a
> field value is addressed as `(ElementId, FieldKey)`. `FieldKey`s are allocated
> monotonically, never reused, and never reordered; renaming a field in `schema.yaml`
> keeps its key and records an alias, so a rename is a display change and not a migration.

This preserves everything invariant 7 is actually for — rules, explainers, emitters and
diagram elements reference IDs rather than paths or names, and renaming a device or a field
invalidates nothing — while costing 2 bytes per field reference instead of 16.

Until this is accepted, §13 implements `FieldKey(u16)` as specified above, and this section
is the record of the deviation.
