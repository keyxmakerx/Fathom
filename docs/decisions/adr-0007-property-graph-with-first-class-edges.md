# ADR-0007 — The IR is a property graph with first-class typed edges

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §3.5 (D05); `11` §§3.1–3.5
> **Reversal cost:** R4 — a rewrite plus a data migration plus corpus re-authoring in hundreds of hours
> **Supersedes:** —

## Context

Brief §5.1: *"This schema is the entire bet of the project."* Everything the product does is a
projection of one structure, so the structure's shape decides what every projection can express.

Three candidate shapes, and one sub-question that is the real fork: are edges first-class objects
with their own IDs, kinds and fields, or are they node fields holding a `NodeId`?

The deciding evidence is in the domain, not in the engineering. `82` §3 examines the flagship rule
`zone.host-inbound.ike-missing` and finds that Junos `host-inbound-traffic` exists in **two places**
— zone-wide on `Zone.host_inbound_system_services`, and **per interface on the `ZoneMember` edge**.
The card's own plumbing piece #3, the statement the whole rule exists to enforce, is the
per-interface form. A schema in which that edge cannot carry a field cannot express the correct
condition, and `11` §7.5 already writes the correct condition against the edge.

That is not an isolated case. `82` §15 shows the same requirement for LAG membership
(`redundant-parent`), and the diagram's layered views (`56`) are edge-kind filters by construction.

`73` §11's coupling table is also binding: edges being first-class defines `fex`'s name environment;
the name environment is what rules are authored against; rules and edges are what the record model
shards. **Do not freeze `fex`'s name environment before this is answered.** Rules cost 60–90 minutes
each including fixtures. Code written against the wrong graph shape is rewritten in a week; two
hundred rules authored against the wrong name environment is a season.

## Decision

**A property graph. Edges are first-class: they carry a stable ID, a kind, and typed fields. Node
fields never hold a `NodeId`.**

Consequences that follow immediately and are part of the decision:

- Rules traverse by edge kind and may read edge fields, which is what makes
  `zone.host-inbound.ike-missing` writable correctly (ADR-0029 fixes the rule as shipped).
- Every edge is addressable by a suppression, an explainer and a diagram element, per invariant 7.
- The CRDT op set (if ADR-0016's evidence ever arrives) has edge add/remove as primitives rather
  than as field mutations.
- `Edges` is its own record class in the container (ADR-0013).

## Consequences

### Positive

- The domain's own structure is representable. The corpus's highest-value rule is expressible; under
  a tree it is not, and under node-field references it requires a reverse index the rule author must
  maintain by hand.
- Layered diagram views are a filter over edge kinds rather than six parallel traversals.
- Renaming a device invalidates nothing, because every reference is an ID (invariant 7).
- `12`'s read-set extraction stays total: a traversal is a typed edge walk with a known arity, which
  is what lets `fex` compute a read set statically (ADR-0009 depends on this).

### Negative

- **Emitter field reads become fallible.** In a typed document tree, `gateway.external_interface`
  is infallible by construction — the type system guarantees the parent exists. In a property graph
  it is a traversal that can return zero or many, so every emitter accessor carries an error path,
  and `13`'s emitters gain a class of `Unprovable` outcomes that a tree would not have. This is the
  rejected option's strongest argument and it is real. The mitigation is codegen from the schema
  (ADR-0008), which is a mitigation and not a refutation.
- **A graph permits states the domain forbids.** Nothing structurally prevents an `IkeGateway` with
  two `external_interface` edges. Cardinality becomes a validation rule rather than a type, which
  means it is checked at runtime, in a rule, that somebody has to author — and `82` §15 shows the
  schema is already missing constraints it needs (`reth_count`, fabric interfaces).
- **Two hundred rules will be authored against this name environment.** The R4 rating is not
  theoretical: reversing it re-authors the corpus, and the corpus is the schedule (ADR-0006).
- **Edge IDs double the ID surface.** Every edge is a ULID in a record, referenced by suppressions
  and diagram layout. The workspace grows, the sharding (ADR-0013) needs an `Edges` class, and
  `fsck` has twice as many referential integrity checks to run.
- Debugging a property graph by reading a record is harder than reading a tree. Provenance and
  `fathom show --plain` carry that cost forever.

## Alternatives considered

| Option | Strongest argument for it, in its own terms | Why rejected |
|---|---|---|
| **Typed document tree, edges as node fields** | *Emitter field reads are infallible.* A `Device` owns its `Interface`s owns its `LogicalUnit`s; the emitter walks a struct and cannot fail. This removes an entire error class from the component that produces the product's output, and it makes the Rust types self-documenting | The domain is not a tree. A `LogicalUnit` belongs to an `Interface` *and* to a `Zone` *and* to a `RoutingInstance` *and* to an `IpsecVpn` binding. Modelling it as a tree forces three of those four to become `NodeId` fields, which is a property graph with worse ergonomics and no reverse index. And it cannot carry a field on the zone-membership relation, which is where the flagship rule lives |
| **Relational-in-memory (tables + joins)** | Rules become queries, and query planning is a solved problem with fifty years of literature | The read-set extraction requirement (`12` §3) needs static analysis of what a condition touches. A general query language makes that undecidable, which is exactly why `fex` exists. It also imports a query engine into the trusted path |
| **Property graph, edges as untyped links** | Simpler: an edge is a pair of IDs and a kind string, no fields | Loses the per-interface `host-inbound-traffic` case, and pushes edge attributes onto synthetic nodes — which is a first-class edge with extra steps and worse names |
| **Adopt Batfish's vendor-independent model wholesale** | The brief §3.1 says it is *"the single best reference available"* and it is battle-tested across many platforms | It is a `config → model` structure built for analysis, not an intent model built for emission. It has no notion of provenance, partial population or user intent, which are three of Fathom's four requirements. Study it; do not adopt it |

## Revisit if

- The first 40 authored rules turn out to be node-local. They are not — `zone.host-inbound.ike-missing`,
  `ipsec.traffic-selector.not-mirrored`, `nat.source-nat-eats-tunnel` and
  `route.remote-prefix.no-next-hop-st0` are all relational — but if the next 160 are, the tree's
  ergonomics win.
- Phase 2's residue analysis shows the parser routinely producing structures the graph cannot hold
  without synthetic nodes.
- Phase 7 (ADR-0030) comes back from PAN-OS requiring more than a handful of new edge kinds, which
  would mean the edge taxonomy is platform-shaped rather than domain-shaped.
