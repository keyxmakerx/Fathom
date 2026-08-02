# WO-02 — `fathom-graph`: the typed store

> **Status:** OPEN

The in-memory typed graph store — `76` §7.2's S3 slice: *"The store: kinds, edges, scalars,
`Presence`, provenance, L0 enforcement at write time, ops and undo batches."* This work order is
written for an execution session under `78`'s protocol: every decision it does not make is a
decision that session is forbidden to make (`78` §4). Read `CLAUDE.md`, then
`.context/conventions.md`, then `78`, then this document, then the cited §§ — in that order.

---

## 0. Contents

| § | |
|---|---|
| 1 | Objective |
| 2 | Binding sources |
| 3 | Prior state |
| 4 | Deliverables |
| 5 | The plan |
| 6 | Acceptance gates |
| 7 | Stop-and-escalate triggers |
| 8 | Non-goals |
| 9 | Failure modes |
| 10 | Open decisions |
| 11 | Sources consulted |
| 12 | Disagreements |

---

## 1. Objective

When this work order is DONE, `crates/fathom-graph` exists and is green under the workspace floor:
an in-memory property graph over the generated IR types, holding nodes and edges keyed by
kind-embedded ULID ids, refusing every L0-invalid mutation at write time with a typed error that
names the violated declaration, serving typed field reads through the existing `FieldBag`
accessors and typed field writes checked against the schema's declared slot types, carrying a
provenance record on every write, iterating in an order that is a pure function of content, and
recording every mutation into an op log grouped into labelled batches. To give the store its
static endpoint and cardinality tables, `fathom-schemagen` is extended to emit them from
`schema/` — no hand-maintained copy of any schema fact exists anywhere in the new crate
(ADR-0008). Nothing in this work order serialises, renders, evaluates rules, applies undo, or
parses configuration.

## 2. Binding sources

Constraints every work order inherits — invariants 1–3 and 9, ADR-0008, zero external
dependencies, the pinned toolchain and `#![forbid(unsafe_code)]`, the risk enum, the
BLOCKER / MAJOR / MINOR severity scale, house style — are stated once in `78` §2 with their
citations and are not re-derived here. The sources specific to this work order:

| Source | What it binds | The line that binds |
|---|---|---|
| `docs/90-decisions/adr-0007-…` §Decision | The store's shape | *"A property graph. Edges are first-class: they carry a stable ID, a kind, and typed fields. Node fields never hold a `NodeId`."* |
| `docs/10-core/11-ir-schema.md` §3.2 | What a node body holds | *"Node bodies contain scalars only."* |
| `11` §3.4 | Edge classes and lifecycle | Containment: *"Deleting the owner deletes the target."* Reference: *"Deleting the dependency leaves a dangling reference, which is an L0 validity error"* |
| `11` §9.1 | The L0 definition — the scope of this store's refusals, first and last clauses elided | *"… every field value type-checks against the schema; every edge's endpoints exist and are in the declared kind sets; every edge kind's **upper** cardinality bound holds; containment forms a forest (one containment in-edge, no cycles); no `AddressSet`/`ApplicationSet` cycles …"* — *"**At write time.** The store refuses a mutation that breaks L0"*. Elided: kind quarantine and `InterfaceName.raw`/`parsed` agreement, both deferred (non-goals 1 and 4) |
| `11` §7.1 | Which bound is L0's | *"Both bounds are enforced: the upper bound at write time (L0), the lower bound at emit and validity check time (L1/L2)."* |
| `11` §7.2 | The containment forest | *"Exactly one containment in-edge per node."* |
| `11` §7.4 | Symmetric-edge canonicalisation | *"on write, the endpoint with the lexicographically smaller `NodeId` becomes `from`"* |
| `11` §6.6 (`AddressSet`) | Set-nesting acyclicity is store-side L0 | *"Nesting is legal; cycles are an L0 validity error checked on write"* |
| `11` §5.2, §5.3 | Presence; why `Default` never enters the store | *"Defaults are applied lazily, at read time, from the corpus table keyed by `(kind, field, platform, version)` — never materialised into the stored graph."* |
| `11` §8.2, §8.3 | The provenance record and the three-value confidence | `ProvenanceRecord { id, origin, asserted_at, asserted_by, confidence, supersedes }` |
| `11` §8.5 | Who may assert `Absent`; what clearing means | *"clearing a field must produce `Unknown`, not `Absent`"* |
| `11` §8.6 | Edit semantics and history retention | *"**Edits never overwrite.**"* / *"the most recent 16 entries, **plus** the earliest entry from each distinct `Origin` discriminant, always"* |
| `11` §10.3 | What identity tuples are for — and are not | *"Identity tuples are **only** used by re-identification. They are never used for lookup, never used by rules, never persisted as a key."* |
| `11` §10.5 | Tombstones, not deletes | *"A tombstoned node is not deleted."* / *"there is no undo across an encrypted-document save"* |
| `11` §13 | The core type shapes — explicitly non-normative internals | *"Illustrative of the shape, not the whole schema"*; the `Graph` comment: *"Deterministic iteration for invariant 9: sorted by NodeId, maintained incrementally, never derived from HashMap order."* |
| `11` §7.6 | The one thing `11` says about mutation batches | *"Derived edges are rebuilt on load and after every mutation batch, are never serialised"* |
| `docs/60-content/62-schema-spec.md` §6.2 | Bound and symmetric key semantics | *"A bare range is enforced at **L0** — the store refuses the violating write."* / symmetric *"`true` means `(a,b)` and `(b,a)` are the same edge (one stored instance, canonical order by `NodeId`)"* / reverse_index *"obliges the store to maintain the `to → from` adjacency incrementally"* |
| `62` §12.1 | The L0 vocabulary | *"A type error. The write does not happen; the error names the violated declaration"* |
| `62` §17.1–17.2 | Generated artifacts; codegen determinism and the stale gate | *"Generated files are checked in. CI regenerates and fails on any diff"* |
| `docs/30-security/33-sync-protocol.md` §5.1 | The op vocabulary this store's log is shaped after | `AddNode` / `AddEdge` / `SetField` / `Tombstone` (/ `Purge`, human-only, not in this WO) |
| `docs/50-design/53-interaction-and-keyboard.md` §7.2 | The batch is the undo unit; its label | *"The undo unit. Groups the ops one user intention produced."* — `label: BoundedText<60>` |
| `docs/90-decisions/adr-0010-…` §Decision | Why the store checks no identity tuple | *"a rename produces a candidate, never a binding"* — re-identification is ingest-time work, not store work |
| `docs/10-core/19-service-and-physical-model.md` §3.2 | The identity law behind the port kinds this store holds | *"A PORT EXISTS BECAUSE HARDWARE EXISTS. AN INTERFACE EXISTS BECAUSE CONFIGURATION EXISTS. NEITHER MAY BE THE OTHER'S IDENTITY."* |
| `docs/70-ops/76-scope-expansion-analysis.md` §7.2 | This slice's scope row (S3) | quoted at the head of this document |
| `docs/70-ops/78-execution-protocol.md` §§2–6, §8 | The protocol; the verification floor; the two pinned warnings | *"The schema checker's standing baseline is two warnings, both `schema.identity.unexercised` against `Site`"* |

## 3. Prior state

Every claim below was verified against the tree on 2026-08-02. A divergence found during
execution is handled by `78` §8's correction test, nothing else.

- **Workspace.** Six crates: `fathom-corpus`, `fathom-find`, `fathom-id`, `fathom-ir`,
  `fathom-schema`, `fathom-schemagen`. `[workspace.dependencies]` is empty on purpose (the
  manifest's own comment: *"That is a position, not an accident"*). `cargo test --workspace`
  passes 80 tests, zero failures. `cargo run -p fathom-schema --bin fathom-schema-check` exits 0
  with `0 failure(s), 2 warning(s)`.
- **`crates/fathom-id/src/lib.rs`.** `Ulid(pub u128)` with `from_parts(timestamp_ms, random)` as
  the only constructor — *"There is deliberately no `new()` that reads a clock or an RNG"*
  (invariant 9). `NodeId(pub Ulid)` and `EdgeId(pub Ulid)` exist as bare ULID newtypes with **no
  embedded kind**. Their doc comment says *"Defined in phase 0, unused until the graph exists"*,
  which is stale: `fathom_ir::value::NextHop::Interface(fathom_id::NodeId)` and several generated
  accessors (e.g. `learned_route::via`) already use `fathom_id::NodeId` as the registered
  field-embedded reference type (`11` §6.5's exception). See §12 Disagreement 3.
- **`crates/fathom-ir/src/bag.rs`.** `FieldKey(pub u32)`; trait
  `FieldBag { fn field(&self, key: FieldKey) -> Option<&dyn Any> }`;
  `typed<T, B>(bag, key) -> Result<&T, FieldError>` with `FieldError::{Missing, WrongType}`. Its
  comment assigns this store its job: *"The store that eventually implements this owns presence
  and provenance (`Field<Presence<T>>`, 11 §6.2); the accessors only need the slot."*
- **`crates/fathom-ir/src/generated/ir_types.rs`.** `NodeKind` (`COUNT = 48`), `EdgeKind`
  (`COUNT = 81`), `DerivedEdgeKind` (`COUNT = 8`), `Layer`, `EdgeClass`; per-kind and per-edge
  field enums each with `ALL`, `name()`, `key()`; `FIELD_KEYS: [(&str, u32); 299]`.
  `EdgeKind::class(self) -> EdgeClass` exists. **No endpoint, cardinality, or symmetric tables
  are generated today** — that is this work order's first deliverable. The `UsesProposal` doc
  comment records a known schema fact this store must not "fix": the two `11` §7.3 rows were
  merged and *"The merged from/to sets do not forbid the cross pairing IkePolicy ->
  IpsecProposal; that narrowing needs either a rename in 11 or an L0 rule. Defect to file per
  62 §1."*
- **`crates/fathom-ir/src/generated/accessors.rs`.** One read accessor per (kind, field), generic
  over `FieldBag`, returning `&T` where the slot type `T` is the scalar stub, generated enum,
  `Vec<T>`, `std::collections::BTreeSet<T>` or `std::collections::BTreeMap<K, V>` — all
  deterministic collections. Edge-field accessors do not exist (*"Edge-field reads land with the
  emitter work (13)"*), but edge field enums and wire keys do.
- **`crates/fathom-ir/src/scalar.rs`, `value.rs`.** Stub binding targets for all 61 declared
  scalars. The `Scalar` trait (`11` §4.2) does not exist yet; slots hold the stub types. The
  store stores whatever type the accessors read — when the real `Scalar` types land at the same
  paths, this crate is unaffected.
- **`crates/fathom-schema`.** `SchemaTree::load` parses the tree; `EdgeDecl` carries `from`,
  `to`, `out_bound`, `l1_out_bound` but **not** the `in:` bound or `symmetric:` (the raw keys are
  in `schema/schema.yaml` and pass through untyped into `schema/generated/schema.json`).
  `crates/fathom-schema/tests/shipped_tree.rs` pins 48 kinds / 89 edges (81 + 8 derived) / 61
  scalars / 299 field keys, and pins the warning set to exactly
  `vec!["schema.identity.unexercised", "schema.identity.unexercised"]` — the `SiteList` import
  scope claims tiers of `Site`, which declares no identity tuple. That is deliberate and
  owner-blocked (`CLAUDE.md`).
- **`crates/fathom-schemagen`.** `extract.rs` parses `schema.yaml` itself (raw `Node`), cross-
  checks against the gated model, and feeds `rust_gen.rs` / `json.rs` / `ts_gen.rs`. `EdgeGen`
  carries name, class, fields, doc — **not** from/to/bounds/symmetric. `tests/determinism.rs`
  wires `schema.codegen.stale` and `schema.codegen.nondeterministic` as cargo tests.
- **`schema/schema.yaml` facts the generated tables will encode** (verified by grep, not to be
  re-derived by hand anywhere): bound tokens used are exactly `"1"`, `"0..1"`, `"0..2"`,
  `"0..n"`, `"1..n"`; the only two-level bounds are `out: { l0: "0..n", l1: "0..1" }` on
  `EntersAt` and `ExitsAt`; `symmetric: true` on exactly `Link` and `PassThrough`; `from: [root]`
  on exactly `HasTunnel`, `HasPremises`, `HasCable`, `HasTenant`, `HasServiceType`; classes are
  `InterfaceLike`, `MultiMemberInterface`, `PortHost`.
- **`docs/70-ops/79-work-orders/`** may contain no `00-INDEX.md` yet; `78` §3's own
  `<!-- VERIFY -->` records that the queue is being authored alongside the protocol.

## 4. Deliverables

Every public name this work order creates is listed here. A step that needs a public name not on
this list stops under §7. Module-private items are the execution session's to name.

### 4.1 Generated schema tables (changes to `fathom-schemagen`, output into `fathom-ir`)

`crates/fathom-schemagen/src/extract.rs` — `EdgeGen` gains:

| Field | Type | Content |
|---|---|---|
| `from_kinds` | `Vec<String>` | The declared `from:` set with class names expanded to their members via the gated model's `classes` (62 §6.2: *"class names admitted and expanded at codegen"*). Empty exactly when the set is `[root]` |
| `to_kinds` | `Vec<String>` | As above, for `to:` |
| `out_l0` | `(u32, Option<u32>)` | (min, max) of the L0 out-bound: the bare range, or the `l0:` entry of a two-level bound. `None` max = `n` |
| `in_l0` | `(u32, Option<u32>)` | As above, for `in:` |
| `symmetric` | `bool` | The declared `symmetric:` flag |
| `root_from` | `bool` | `true` exactly when `from:` is `[root]` |

Bound grammar accepted: a bare integer `N` → `(N, Some(N))`; `A..B` with `B` an integer or `n`;
the map form `{ l0: <range>, l1: <range> }` (the `l1` value is read and discarded in this WO).
Any other token, an unknown kind or class name in `from`/`to`, `root` appearing in `to` or with
company in `from`, or a missing `in:`/`symmetric:` key on an asserted edge, is an
`ExtractError` — generation refuses, per the crate's existing "refuse rather than generate from
a divergent reading" stance. Derived edges are untouched.

`crates/fathom-schemagen/src/rust_gen.rs` — emits into `ir_types.rs`'s `body` module:

```rust
/// An L0 cardinality bound (62 §6.2). `min` is recorded for L1's later use;
/// only `max` is enforced at write time (11 §7.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeCardBound { pub min: u32, pub max: Option<u32> }

impl EdgeKind {
    pub const fn from_kinds(self) -> &'static [NodeKind];   // empty iff root_containment()
    pub const fn to_kinds(self) -> &'static [NodeKind];
    pub const fn out_bound_l0(self) -> EdgeCardBound;
    pub const fn in_bound_l0(self) -> EdgeCardBound;
    pub const fn symmetric(self) -> bool;
    pub const fn root_containment(self) -> bool;
    pub const fn fields(self) -> &'static [crate::bag::FieldKey];  // declaration order
}
impl NodeKind {
    pub const fn fields(self) -> &'static [crate::bag::FieldKey];  // declaration order
}
```

and into `accessors.rs`'s `body` module:

```rust
/// The declared slot type for a wire key: its `TypeId` and the exact type
/// path the read accessors use (e.g. "crate::scalar::Identifier"),
/// for every entry in the field-key registry, node and edge fields alike.
pub fn slot_type(key: crate::bag::FieldKey) -> Option<(core::any::TypeId, &'static str)>;
```

`schema/generated/schema.json`, `ir_types.ts` and `schema/migrations/manifest.toml` must come out
byte-identical — their inputs are untouched. `schema/` itself is not edited in this work order.

### 4.2 The crate

`crates/fathom-graph/Cargo.toml`, verbatim:

```toml
[package]
name = "fathom-graph"
version = "0.1.0"
edition.workspace = true
license.workspace = true
publish.workspace = true
description = "The in-memory typed graph store: L0 enforcement at write time, provenance on every write, deterministic iteration, ops in batches (76 §7.2 S3)"

[dependencies]
fathom-id = { path = "../fathom-id" }
fathom-ir = { path = "../fathom-ir" }
```

Root `Cargo.toml` members list gains one line, after `"crates/fathom-find"`:

```toml
    "crates/fathom-graph",
```

The `Cargo.lock` hunk cargo generates for the new member rides the same commit. No other edit to
either file is authorised.

`crates/fathom-graph/src/lib.rs` — `#![forbid(unsafe_code)]`, modules `id`, `prov`, `field`,
`op`, `graph`, re-exporting every public item below at the crate root.

**`src/id.rs`** — the store's composite ids, per `11` §13's shapes:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId { pub kind: NodeKind, pub ulid: Ulid }
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EdgeId { pub kind: EdgeKind, pub ulid: Ulid }
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ElementId { Node(NodeId), Edge(EdgeId) }
```

`Display` renders the conventions' form `fathom:<kind-lower>:<ulid>` with `<kind-lower>` the
kebab-case of the enum variant name (`IkeGateway` → `ike-gateway`) and the ULID's 26-character
Crockford encoding. `From<NodeId> for ElementId` and `From<EdgeId> for ElementId` exist.
**DECISION — the name `NodeId` collides with `fathom_id::NodeId` and the collision is accepted:**
the corpus calls both things `NodeId` (`11` §13 and `11` §6.5), the crates disambiguate, and
`Graph::resolve_ref` is the bridge. The derived `Ord` (kind declaration order, then ULID) is the
iteration order; for the two shipped symmetric edge kinds both endpoints share one kind, so this
ordering and `11` §7.4's "lexicographically smaller" rendering agree — see §7 trigger 6.

**`src/prov.rs`** — what every write carries, per `11` §8.2, cut to what exists at this stage:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(pub u64);          // ms UTC. A stored value, always caller-supplied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProvenanceId(pub Ulid);
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UserId(pub Ulid);            // workspace-local, opaque (11 §8.2)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Actor { User(UserId) }
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Confidence { Asserted, Derived, Heuristic }   // 11 §8.3, all three, closed
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin { Hand }
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProvenanceRecord {
    pub id: ProvenanceId,
    pub origin: Origin,
    pub asserted_at: Timestamp,
    pub asserted_by: Actor,
    pub confidence: Confidence,
    pub supersedes: Option<ProvenanceId>,   // store-owned; callers pass None
}
```

**DECISION — a hand-constructed graph carries `Origin::Hand` and nothing else.** `11` §8.2's
five further variants (`Parsed`, `Inferred`, `Imported`, `Defaulted`, `Migrated`) and `Hand`'s
`step` payload each name types owned by subsystems that do not exist yet (`CaptureId`,
`InferenceRuleId`, `ImportFormat`, `MigrationId`, `WalkthroughStepId`); they arrive with those
subsystems. `Actor` likewise ships `User` only. Timestamps and ULIDs are always caller-supplied
(invariant 9; `fathom-id`'s own rule) — in this WO's tests they are fixed constants. `11` §8.5's
restriction on asserting `Absent` is satisfied vacuously: with `Origin::Hand` the only
constructible origin, every `Absent` is an explicit human assertion by construction; the
closed-world-parser half becomes the parser-binding WO's obligation.

**`src/field.rs`** — the erased field slot:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredPresence { Set, Absent, Unknown }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldInfo { pub presence: StoredPresence, pub prov: Option<ProvenanceId> }
pub struct HistoryEntry {
    pub presence: StoredPresence,
    pub value: Option<Box<dyn core::any::Any>>,   // moved in, never cloned
    pub prov: ProvenanceId,
}
pub struct FieldHistory { /* private */ }
impl FieldHistory {
    pub fn entries(&self) -> &[HistoryEntry];   // oldest first
    pub fn truncated(&self) -> u32;             // 11 §8.6's HistoryTruncated count
}
```

**DECISION — the store holds exactly three presence states.** `Presence::Default` is never
stored: `11` §5.3 — *"never materialised into the stored graph"* — makes `Default` a read-time
synthesis owned by the future defaults subsystem. A missing slot **is** `Unknown` (*"The normal
state of most of the graph"*, `11` §5.2); an `Absent` slot is stored explicitly with its
provenance. `FieldBag::field` returns the value slot only in the `Set` state, so the generated
accessors see `Missing` for `Absent` and `Unknown` alike — the three-way distinction
(`Set`/`Absent`/`Unknown`) is served by `Graph::presence`, which is the API rules will read; the
fourth state, `Default`, arrives with the defaults subsystem (non-goal 8). History retention
implements `11` §8.6 verbatim: the most recent 16 entries plus the earliest entry from each
distinct `Origin` discriminant, always; everything else is dropped and counted in `truncated()`.

**`src/op.rs`** — the op log and the batch:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BatchId(pub Ulid);
#[derive(Debug)]
pub enum Op {
    AddNode   { node: NodeId, prov: ProvenanceId },
    AddEdge   { edge: EdgeId, from: NodeId, to: NodeId, prov: ProvenanceId },
    SetField  { element: ElementId, key: FieldKey, presence: StoredPresence,
                prov: ProvenanceId },
    Tombstone { element: ElementId, at: Timestamp },
}
#[derive(Debug)]
pub struct Batch { pub id: BatchId, pub label: String, pub ops: Vec<Op> }
```

**DECISION — what `11` actually specifies about ops, quoted in full, and what this WO therefore
builds.** `11` mentions the machinery exactly twice: §7.6 — *"Derived edges are rebuilt on load
and after every mutation batch, are never serialised"* — and §10.5 — *"there is no undo across an
encrypted-document save."* Everything else lives elsewhere: the op vocabulary is `33` §5.1's
(`AddNode`/`AddEdge`/`SetField`/`Tombstone`/`Purge`/set-ops/grow-only records), and the batch is
`53` §7.2's `Transaction` (*"The undo unit. Groups the ops one user intention produced."*, label
`BoundedText<60>`). This WO builds the store-side substrate only: every mutation appends one `Op`
to the batch the caller has open; the batch boundary is drawn by the caller
(`begin_batch`/`end_batch`), because the store cannot know what "one user intention" is; the
label is capped at 60 bytes per `53` §7.2. The op records the presence transition and provenance
id, not the value payload — prior values are recoverable from the history side table, and `33`
§5.1's state-carrying serialised form (`PresenceRepr`) belongs to the workspace-format WO.
**Undo application, redo, `Purge`, and `Op::Untombstone` are all out of this WO** — `53` §7.4:
*"`Op::Untombstone` does not currently exist in `33` §5.1. This is a required addition"* — that
addition is a planning/owner decision, not this session's (§10, item 1).

**`src/graph.rs`** — the store:

```rust
pub struct Graph { /* private */ }
pub struct Node {
    pub id: NodeId,
    pub existence: ProvenanceId,
    pub absent_since: Option<Timestamp>,   // 11 §10.5 tombstone
    /* fields: private */
}
pub struct Edge {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub prov: ProvenanceId,
    pub absent_since: Option<Timestamp>,
    /* fields: private */
}
impl fathom_ir::bag::FieldBag for Node { /* Set slots only */ }
impl fathom_ir::bag::FieldBag for Edge { /* Set slots only */ }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End { From, To }
#[derive(Debug)]
pub enum WriteError {
    NoOpenBatch,
    BatchAlreadyOpen { open: BatchId },
    BatchIdReused { id: BatchId },
    LabelTooLong { len: usize },
    UlidReused { ulid: Ulid },
    UnknownElement { element: ElementId },
    MissingEndpoint { edge: EdgeKind, end: End, id: NodeId },
    EndpointKind { edge: EdgeKind, from: NodeKind, to: NodeKind, end: End,
                   allowed: &'static [NodeKind] },
    RootContainment { edge: EdgeKind },
    SymmetricDuplicate { edge: EdgeKind, existing: EdgeId },
    SecondContainment { node: NodeId, existing: EdgeId },
    ContainmentCycle { edge: EdgeKind, from: NodeId, to: NodeId },
    SetCycle { edge: EdgeKind, from: NodeId, to: NodeId },
    OutBoundExceeded { edge: EdgeKind, from: NodeId, max: u32 },
    InBoundExceeded { edge: EdgeKind, to: NodeId, max: u32 },
    UndeclaredField { element: ElementId, key: FieldKey },
    WrongType { key: FieldKey, declared: &'static str },
    ProvenanceIdReused { id: ProvenanceId },
    SupersedesIsStoreOwned { id: ProvenanceId },
    AlreadyTombstoned { element: ElementId },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadError { UnknownElement { element: ElementId }, UndeclaredField { key: FieldKey } }
```

`WriteError` implements `Display`; the `EndpointKind` rendering must name the edge kind and both
endpoint kinds (this is gate G4's assertion). `Debug` is derived throughout.

```rust
impl Graph {
    pub fn new() -> Graph;                        // plus impl Default (clippy floor)

    // ---- batches -------------------------------------------------------
    pub fn begin_batch(&mut self, id: BatchId, label: &str) -> Result<(), WriteError>;
    pub fn end_batch(&mut self) -> Result<BatchId, WriteError>;
    pub fn log(&self) -> &[Batch];                // committed batches, append order

    // ---- writes (all require an open batch) ----------------------------
    pub fn insert_node(&mut self, kind: NodeKind, ulid: Ulid,
                       existence: ProvenanceRecord) -> Result<NodeId, WriteError>;
    pub fn insert_edge(&mut self, kind: EdgeKind, ulid: Ulid, from: NodeId, to: NodeId,
                       prov: ProvenanceRecord) -> Result<EdgeId, WriteError>;
    pub fn set_field<T: core::any::Any>(&mut self, element: ElementId, key: FieldKey,
                       value: T, prov: ProvenanceRecord) -> Result<(), WriteError>;
    pub fn assert_absent(&mut self, element: ElementId, key: FieldKey,
                       prov: ProvenanceRecord) -> Result<(), WriteError>;
    pub fn clear_field(&mut self, element: ElementId, key: FieldKey,
                       prov: ProvenanceRecord) -> Result<(), WriteError>;
    pub fn tombstone(&mut self, element: ElementId, at: Timestamp)
                       -> Result<(), WriteError>;

    // ---- reads ---------------------------------------------------------
    pub fn node(&self, id: NodeId) -> Option<&Node>;
    pub fn edge(&self, id: EdgeId) -> Option<&Edge>;
    pub fn resolve_ref(&self, r: fathom_id::NodeId) -> Option<ElementId>;
    pub fn nodes(&self) -> impl Iterator<Item = &Node>;              // NodeId order
    pub fn nodes_of_kind(&self, kind: NodeKind) -> impl Iterator<Item = &Node>;
    pub fn edges(&self) -> impl Iterator<Item = &Edge>;              // EdgeId order
    pub fn edges_of_kind(&self, kind: EdgeKind) -> impl Iterator<Item = &Edge>;
    pub fn out(&self, n: NodeId, k: EdgeKind) -> impl Iterator<Item = &Edge>;  // EdgeId order
    pub fn inn(&self, n: NodeId, k: EdgeKind) -> impl Iterator<Item = &Edge>;  // EdgeId order
    pub fn owner(&self, n: NodeId) -> Option<NodeId>;      // containment parent, 11 §13
    pub fn device_of(&self, n: NodeId) -> Option<NodeId>;  // walk containment up, 11 §13
    pub fn presence(&self, element: ElementId, key: FieldKey)
                       -> Result<FieldInfo, ReadError>;
    pub fn history(&self, element: ElementId, key: FieldKey) -> Option<&FieldHistory>;
    pub fn provenance(&self, id: ProvenanceId) -> Option<&ProvenanceRecord>;
}
```

**DECISION — internals are `std::collections::BTreeMap` and `Vec`, nothing else.** `11` §13's
`SlotMap`/`HashMap`/`EnumMap`/`SmallVec`/`CompactString` are external crates; `11` §13 is
*"Illustrative of the shape"* and the zero-dependency position wins. `BTreeMap` keyed by the
composite ids gives sorted-by-id iteration and by-kind range scans directly, satisfying `11`'s
own rule that order is *"never derived from HashMap order"*. No `HashMap` (its `RandomState`
seeds per process) and no sorting-at-read: order is a property of the structures. Adjacency is
maintained incrementally in both directions — `reverse_index: true` on every declared edge
obliges the reverse map (62 §6.2). The internal shape (private, session may adjust names):
`nodes`, `edges`, `by_ulid: BTreeMap<Ulid, ElementId>` (uniqueness + `resolve_ref`),
`out`/`inn: BTreeMap<(NodeId, EdgeKind), Vec<EdgeId>>` (Vecs kept sorted), `owner_edge:
BTreeMap<NodeId, EdgeId>`, `prov: BTreeMap<ProvenanceId, ProvenanceRecord>`, `history:
BTreeMap<(ElementId, FieldKey), FieldHistory>`, `log: Vec<Batch>`, `open: Option<Batch>`.

**DECISION — the write-time rules, exhaustively.** Checks run in the order listed; the first
failure is the returned error, which makes refusals deterministic:

1. **Every mutator** first requires an open batch (`NoOpenBatch`) — `76` §7.2's "ops and undo
   batches" means no mutation escapes the log. `begin_batch` refuses a second open batch, a
   reused `BatchId`, and a label over 60 bytes (`53` §7.2's `BoundedText<60>`).
2. **Provenance interning.** A write's `ProvenanceRecord` must have `supersedes: None`
   (`SupersedesIsStoreOwned`) — the store fills it from the field's current provenance on
   re-writes, implementing `11` §8.6's chain. A record id already interned with different
   content is `ProvenanceIdReused`; byte-equal re-interning is a no-op.
3. **`insert_node`:** ULID unused anywhere in the store (`UlidReused` — bare
   `fathom_id::NodeId` references resolve by ULID alone, so ULIDs are unique across the store,
   nodes and edges alike). Any `NodeKind` is insertable with no fields — a bare node is a
   correct graph (`11` §9.1).
4. **`insert_edge`, the L0 ladder:** ULID unused → `root_containment(kind)` refused
   (`RootContainment`; see §10 item 2) → both endpoints exist (`MissingEndpoint`) →
   `from.kind ∈ from_kinds(kind)` and `to.kind ∈ to_kinds(kind)` (`EndpointKind`, naming the
   edge kind, both endpoint kinds, the failing end and the allowed set) → if `symmetric(kind)`,
   normalise so the smaller `NodeId` is `from` (`11` §7.4), then refuse a second live edge of the
   same kind over the same pair (`SymmetricDuplicate` — 62 §6.2's "one stored instance") → if
   containment: the target has no live containment in-edge (`SecondContainment`, `11` §7.2) and
   walking `owner()` up from `from` never reaches `to` (`ContainmentCycle`, `11` §9.1's "no
   cycles"; unreachable under today's kind sets, kept as the forest guard) → if the kind is
   `Contains` or `ContainsApp`: `from == to` is refused outright (a self-loop is a one-edge
   cycle) and otherwise no directed path of same-kind live edges from `to` back to `from`
   (`SetCycle` either way, `11` §6.6; see §12 Disagreement 1 on the mechanism) → out/in
   **upper** bounds from `out_bound_l0`/`in_bound_l0` (`11` §7.1 — lower bounds are L1, not this
   store's to refuse), counted per stored direction — for `symmetric: true` kinds that admits
   combined degrees above the bound (§10 item 7; not this session's to tighten). Cardinality and
   duplicate checks count **effective** edges only: not tombstoned and neither endpoint
   tombstoned — otherwise tombstone-then-replace would be impossible without `Purge`, which does
   not exist here.
5. **`set_field` / `assert_absent` / `clear_field`:** element exists (`UnknownElement`) → key ∈
   the element kind's generated `fields()` (`UndeclaredField` — ADR-0008 at the write boundary;
   node and edge fields both, which is how `ZoneMember`'s per-interface `host-inbound` writes
   work) → for `set_field`, `TypeId::of::<T>()` equals the generated `slot_type(key)`
   (`WrongType`, carrying the declared type path). The replaced slot state (value moved, not
   cloned) is appended to history with its provenance; `clear_field` produces `Unknown`
   (`11` §8.5: *"clearing a field must produce `Unknown`, not `Absent`"*) by removing the slot,
   recording the clear's provenance in history and the op log. Writes to tombstoned elements are
   permitted: a tombstone marks absence, and gates views, not the store.
6. **`tombstone`:** element exists, not already tombstoned (`AlreadyTombstoned` — `33` §5.4's
   `min(existing, at)` is merge dispatch, not the local API). Tombstoning a node also tombstones
   every live node in its containment subtree (`11` §3.4: *"Deleting the owner deletes the
   target"*, applied to the absence-marking removal that exists at this stage), one `Op::
   Tombstone` per element, emitted in `NodeId` order. Incident edges are not marked; an edge
   with a tombstoned endpoint is effectively absent (rule 4) and views own its rendering.

**DECISION — identity tuples are not checked on insert, at all.** `11` §10.3:
*"Identity tuples are **only** used by re-identification. They are never used for lookup, never
used by rules, never persisted as a key."* Re-identification runs on re-parse (ADR-0010), and no
parser exists. Two nodes with identical would-be tier-1 tuples are therefore two nodes; nothing
in this crate reads `schema.yaml`'s `identity:` blocks. Consequently the schema checker's
standing baseline — exactly two `schema.identity.unexercised` warnings against `Site`, pinned by
`crates/fathom-schema/tests/shipped_tree.rs::shipped_tree_known_warnings_are_pinned`
(`assert_eq!(warnings, vec!["schema.identity.unexercised", "schema.identity.unexercised"])`) —
is untouched by this work order; any change to that warning set is a red gate (`78` §6).

### 4.3 Tests

New integration tests, exactly these files and test names (bodies are the session's to write, to
the assertions stated in §5–§6):

| File | Tests |
|---|---|
| `crates/fathom-ir/tests/edge_tables.rs` | `containment_in_bounds_are_exactly_one` (every `EdgeClass::Containment` kind except the root-containment five has `in_bound_l0() == EdgeCardBound { min: 1, max: Some(1) }`); `symmetric_is_link_and_passthrough_only`; `root_containment_is_the_five_root_edges`; `from_to_sets_nonempty_unless_root`; `slot_type_covers_every_registry_key` (all 299) |
| `crates/fathom-graph/tests/l0.rs` | `endpoint_kind_refused_names_edge_and_both_kinds`; `missing_endpoint_refused`; `out_upper_bound_refused`; `in_upper_bound_refused`; `terminates_third_end_refused`; `second_containment_refused`; `set_nesting_cycle_refused`; `symmetric_normalised_then_duplicate_refused`; `root_containment_edge_refused`; `undeclared_field_refused`; `wrong_typed_field_refused`; `ulid_reuse_refused`; `cross_pairing_uses_proposal_is_accepted_as_declared` |
| `crates/fathom-graph/tests/determinism.rs` | `iteration_order_is_insertion_independent`; `identical_sequences_render_identically` |
| `crates/fathom-graph/tests/fields.rs` | `unknown_is_a_missing_slot`; `absent_is_stored_and_distinct_from_unknown`; `accessor_reads_set_slot_and_misses_absent`; `clear_returns_unknown`; `edits_never_overwrite_supersedes_chains`; `history_retention_sixteen_plus_earliest` |
| `crates/fathom-graph/tests/batches.rs` | `write_outside_batch_refused`; `nested_begin_refused`; `label_over_sixty_bytes_refused`; `batch_id_reuse_refused`; `ops_land_in_open_batch_in_order`; `tombstone_cascades_containment_subtree`; `tombstoned_edges_leave_cardinality_counts` |
| `crates/fathom-graph/tests/worked_example.rs` | `side1_subgraph_builds_and_traverses` |

The worked example is `11` §15's side-1 slice, reduced to what this WO can hold: one `Site`, one
`Device` (`hostname` = `srx-a-01`, `platform` = `junos-srx` — `11` §15.2), `RethInterface reth0`
+ unit 0, `TunnelInterface st0` + unit 0, the two zones of `11` §15.6: `Zone` `VPN` with a
`ZoneMember` edge to `st0.0` whose `host_inbound_system_services` is asserted `Absent` (piece
#2) and `Zone` `WAN` with a `ZoneMember` edge to `reth0.0` carrying
`host_inbound_system_services = {ike}` (piece #3, the edge-field write — ike belongs on the
WAN-facing binding, the fact `zone.host-inbound.ike-missing` teaches), and the six-object chain
`IkeProposal → IkePolicy → IkeGateway → IpsecProposal → IpsecPolicy → IpsecVpn` under `Device`
with `UsesProposal`, `UsesIkePolicy`, `ExternalInterface → reth0.0`, `UsesIkeGateway`,
`UsesIpsecPolicy`, `BindsInterface → st0.0`. Assertions: every traversal in the list resolves
through `out`/`inn`; `owner` and `device_of` walk correctly from `st0.0`'s `Address`-less unit;
`presence` reports `Set` where set, `Absent` on the VPN-side `ZoneMember`'s
`host_inbound_system_services`, and `Unknown` where not; the log contains one batch whose op
count equals the mutation count.

## 5. The plan

Each step ends with the tree compiling and `cargo test --workspace` green unless the step says
otherwise. No reordering, no merging (`78` §3.6).

1. **Extract.** Extend `extract.rs` per §4.1: new `EdgeGen` fields, the bound-grammar parser,
   class expansion against the gated model's `classes`, the `root` token, the refusal cases.
   Extend `cross_check` only if a new shared fact needs agreement (none is expected).
2. **Generate.** Extend `rust_gen.rs` to emit `EdgeCardBound`, the six `EdgeKind` methods, the
   two `fields()` methods, and `slot_type` in `accessors.rs`, matching the file's existing style
   (`#[rustfmt::skip] mod body`, `pub use body::*`, doc comments citing the schema keys). Run
   `cargo run -p fathom-schemagen`; commit the step-1/step-2 `fathom-schemagen` changes together
   with the regenerated `ir_types.rs` and `accessors.rs` (never hand-edited — `78` §5.6) — G3
   diffs the generated paths against this commit. Verify `schema/generated/*` and
   `schema/migrations/manifest.toml` are byte-unchanged.
3. **Pin.** Write `crates/fathom-ir/tests/edge_tables.rs` (§4.3 row 1). These tests encode the
   §3 grep facts; if any fails, the §3 fact was wrong — `78` §8 decides correction versus
   escalation.
4. **Skeleton.** Create `crates/fathom-graph` with the verbatim manifest, the members line, and
   `lib.rs` with empty modules. `cargo build -p fathom-graph` compiles.
5. **`id.rs`** with `Display` (kebab renderer is a private fn) and unit tests in-module:
   `ike_gateway_renders_kebab` (`fathom:ike-gateway:<26 chars>`), ordering follows
   `(kind, ulid)`.
6. **`prov.rs`**, **`field.rs`**, **`op.rs`** as specified. Unit-test the history retention rule
   in-module against a synthetic sequence (16 + earliest, truncated counted).
7. **`graph.rs` — nodes and batches.** `new`/`Default`, `begin_batch`/`end_batch`/`log`,
   `insert_node`, provenance interning, `node`, `nodes`, `nodes_of_kind`, `resolve_ref`.
8. **`graph.rs` — edges.** `insert_edge` with the full §4.2 rule-4 ladder in stated order;
   adjacency maintenance; `edge`, `edges`, `edges_of_kind`, `out`, `inn`, `owner`, `device_of`.
9. **`graph.rs` — fields.** `set_field`, `assert_absent`, `clear_field`, `presence`, `history`,
   `provenance`; `FieldBag` impls for `Node` and `Edge` (return the slot only when `Set`).
10. **`graph.rs` — tombstone** with the containment cascade and effective-edge counting.
11. **Integration tests** per §4.3, in file order. For
    `endpoint_kind_refused_names_edge_and_both_kinds`, insert `ZoneMember` from a `Zone` to a
    `Device` (declared `to` is `[LogicalUnit]`) and assert the error variant's fields **and**
    that its `Display` output contains `ZoneMember`, `Zone` and `Device`. For the determinism
    pair: build the worked-example graph twice — once in §4.3's order, once with node and edge
    insertions interleaved differently under the same batch structure — render every iterator
    (`nodes`, `edges`, each `out`/`inn` bucket touched) as `Display` lines, and assert the two
    dumps are byte-identical; the second test runs one construction function twice in-process
    and asserts byte-identical dumps.
12. **Floor.** Run §6's gates. Fix only defects in this WO's own new code; anything else is §7.
13. **Bookkeeping.** Status line → `DONE`; mirror the `00-INDEX.md` row if the index exists (its
    absence is noted in §3 and is not this session's to fix). Commit per `78` §3.9, push, open
    the PR listing every gate's output verbatim. Do not merge.

## 6. Acceptance gates

Run in this order, locally, before push (`78` §6). Expected results are exact; anything else is
a red gate and §7 applies.

| # | Command | Expected |
|---|---|---|
| G1 | `cargo fmt --all --check` | exit 0, no output |
| G2 | `cargo clippy --all-targets -- -D warnings` | exit 0 |
| G3 | `cargo run -p fathom-schemagen` then `git status --porcelain -- crates/fathom-ir/src/generated schema/generated schema/migrations` | regeneration reports success; the path-scoped `git status` prints nothing — regeneration matches the step-2 commit byte for byte, and `schema/generated/schema.json`, `schema/generated/ir_types.ts`, `schema/migrations/manifest.toml` are byte-unchanged from before this WO. The unscoped tree is dirty at this step by design (the crate and the manifest edits commit in step 13); do not widen the path list |
| G4 | `cargo test -p fathom-graph` | every §4.3 `fathom-graph` test listed, all `ok`, `0 failed`. `endpoint_kind_refused_names_edge_and_both_kinds` proves the typed error names `ZoneMember`, `Zone` and `Device` |
| G5 | `cargo test -p fathom-ir` | `edge_tables.rs` suite all `ok`, existing suites unchanged |
| G6 | `cargo test --workspace` | zero failures; the 80 pre-WO tests all still pass (no test deleted, loosened or ignored — `78` §5.5) |
| G7 | `cargo run -p fathom-schema --bin fathom-schema-check` | exit 0, `0 failure(s), 2 warning(s)`, both `schema.identity.unexercised` — the pinned baseline, unchanged |

## 7. Stop-and-escalate triggers

The general rule is `78` §4; escalating is success. Specific to this work order, stop and
escalate (procedure per `78` §4) when:

1. Any step appears to need an edit to `schema/` — this WO makes none; the generator reads keys
   already present.
2. Any step appears to need undo application, redo, `Op::Untombstone`, `Purge`, or an HLC /
   actor-pseudonym on ops or batches. All deliberately absent (§10 items 1, 5).
3. A bound token, a two-level bound outside `EntersAt`/`ExitsAt`, a `symmetric: true` edge whose
   `from` and `to` sets differ, or a `root` token outside the five §3 edges appears during
   extraction. The §3 facts were verified; a divergence means the schema moved under this WO.
4. Enforcing any declared `constraints:` clause (`62` §12's clauses; the gate code
   `store.constraint.<id>` is `62` §18.3's) seems needed to make a test pass. The constraint
   engine is a follow-on WO (§8 item 4).
5. The narrowing of `UsesProposal`'s merged endpoint sets tempts. The generated tables carry the
   sets as declared; `cross_pairing_uses_proposal_is_accepted_as_declared` pins the honest
   current behaviour, and the narrowing is the filed defect's business (`62` §1 route), not this
   session's.
6. A public name, file, or error variant not listed in §4 is needed; or a cited § contradicts
   this document; or G1–G7 go red for a cause whose fix this document does not state.
7. Any change to the schema checker's two-warning baseline (G7) for any reason.

## 8. Non-goals

1. **No serialisation.** The workspace container, frames, CBOR, `PresenceRepr`, unknown-kind
   preserve mode — WO-05's territory (`17`, ADR-0012/0013).
2. **No rendering, no UI, no diagram** — S4/S7 slices (`76` §7.2).
3. **No rule engine, no L1/L2/L3 computation** (`11` §9.1: L1–L3 *"are measurements"*), no
   findings, no suppressions.
4. **No declared-constraint enforcement** (`62` §12's `reject_write` clauses) and no
   `InterfaceName.raw`/`parsed` agreement check — both need the `Scalar` trait and the constraint
   evaluator, neither of which exists (`fathom-ir`'s scalars are stubs; `CLAUDE.md` next
   actions).
5. **No derived arena, no inference** — derived elements are *"recomputed on load"* (`11` §3.5)
   by a subsystem that does not exist yet; `DerivedEdgeKind` is untouched.
6. **No re-identification, no identity-tuple evaluation, no merge, no CRDT** (ADR-0010; `33`
   §§5.2–5.5 arrive with sync).
7. **No parser and no ingest** — and therefore no `Origin::Parsed`, no captures, no redaction.
8. **No defaults table** — `Presence::Default` stays a read-time concern (`11` §5.3).

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | A schema fact hand-copied into `fathom-graph` (an endpoint list, a bound, a symmetric flag) drifts from `schema.yaml` | Everything the store checks comes from the generated tables; `edge_tables.rs` pins the tables to the §3 facts; `schema.codegen.stale` pins the tables to the tree |
| 2 | Iteration order silently depends on a `HashMap` added "just internally" | The determinism pair in §4.3 fails on any per-process ordering; review checks the crate for `HashMap`/`HashSet` imports — there must be none |
| 3 | A refusal is reordered and error codes become input-order-dependent | §4.2 rule 4 fixes the ladder order; the L0 tests assert specific variants, not just `is_err()` |
| 4 | The accessor path and the store disagree on a slot type and reads mask it | Write-time `slot_type` check plus `bag.rs`'s read-time `WrongType` — the same `TypeId`, checked at both ends |
| 5 | Tombstone counting makes replacement impossible (or dedup toothless) | `tombstoned_edges_leave_cardinality_counts` exercises tombstone-then-replace on `BindsInterface` |
| 6 | The execution session "helpfully" implements undo, identity checks, or a constraint | §7 triggers 2, 4; `78` §9.1's obedient-improviser control — any public name outside §4 fails PR review |
| 7 | History grows without bound in a long-lived store | The retention rule is implemented and tested (`history_retention_sixteen_plus_earliest`), with truncation counted, never silent (`11` §8.6) |

## 10. Open decisions

Deliberately not decided here; owner or planning session only (`78` §7):

1. **`Op::Untombstone`, undo application and redo.** `53` §7.4 names `Untombstone` *"a required
   addition"* to `33` §5.1; redo has one sentence (`53` §7.5). Whether the addition amends `33`
   or lands as an ADR, and where invert/redo run, is planning work. This WO's log and batches
   are shaped so either lands additively.
2. **Root containment's representation.** The transcription note in `schema/schema.yaml`'s
   containment section — on `62`'s grammar, which has no root token — calls the `root` token
   *"a form gap to file"*. This WO refuses insertion of the five root-containment edge kinds and
   treats their target kinds (and `Site`) as forest roots with `owner() == None`; whether a
   workspace-root pseudo-element ever exists, and how the `in: "1"` lower bound on those edges is
   measured at L1, is open.
3. **Narrowing `UsesProposal`** (`IkePolicy → IpsecProposal` is currently representable) — the
   defect the generated file says to file per `62` §1.
4. **Duplicate reference edges and self-loops on `0..n`/`0..n` kinds** (e.g. two identical
   `MatchSource` edges; a `PeersWith` from a device to itself). No source refuses them at L0;
   this WO permits them — except self-loops on `Contains`/`ContainsApp`, which rule 4 refuses as
   `SetCycle` (`11` §6.6) — and whether an L0 rule or an L1 lint owns the rest is open.
5. **When ops gain `33` §5.1's envelope** (`OpId`/HLC/actor pseudonym) and batches gain `53`
   §7.2's `TxSource` — presumably the workspace-format WO; `75` §5's `TxSource` bulk-edit defect
   is already registered there.
6. **When the declared L0 `constraints:` (62 §12) engine lands** and whether it is a
   `fathom-graph` extension or its own crate.
7. **Symmetric-edge bound counting.** Rule 4 counts upper bounds per stored direction. Under
   `11` §7.4's canonicalisation, interfaces X < Y < Z with `Link` X–Y (stored X→Y) and `Link`
   Y–Z (stored Y→Z) pass both per-direction `0..1` upper bounds while Y is cabled twice — a
   state the declared `out: "0..1"` / `in: "0..1"` (`schema.yaml`; `11` §7.3's `Link` row)
   evidently intend to refuse. Whether `symmetric: true` kinds should count combined live
   degree instead is open; the blast radius is small because `19` §3.8 supersedes `Link` with
   `Cable` + `Terminates`.

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants; terminology; ID formats; document conventions |
| `CLAUDE.md`; `docs/70-ops/78-execution-protocol.md` (whole) | Session rules; inherited constraints; the floor; the two-warning baseline; WO shape |
| `docs/10-core/11-ir-schema.md` §§1, 3, 5, 6.1–6.7, 7, 8, 9.1–9.2, 10, 13, 14.3, 15 | Every store-shape rule cited in §2; the worked example |
| `docs/10-core/19-service-and-physical-model.md` §§2.2–2.4, 3.1–3.4, 5.1 | The layer rules, the identity law, `PhysicalPort`/`Cable`/`PortHost`, root-level physical edges |
| `docs/60-content/62-schema-spec.md` §§6, 12.1–12.3, 13.1, 17, 18 | Edge keys and bound levels; L0 vocabulary; closure; generated artifacts; gate codes |
| `docs/30-security/33-sync-protocol.md` §§5.1–5.5 | The op vocabulary; what is deliberately deferred |
| `docs/50-design/53-interaction-and-keyboard.md` §7 | The transaction/batch unit; the undo gaps escalated in §10 |
| `docs/70-ops/76-scope-expansion-analysis.md` §7 | The S3 row; the build order |
| `docs/70-ops/73-open-decisions.md` (grep for op-log context) | *"The op log is how provenance, undo and diff work — it is not a sync feature"* (§6.2 region) |
| `docs/90-decisions/adr-0007`, `adr-0008` (via 78 §2), `adr-0010` | The graph shape; the schema-is-source rule; re-identification ownership |
| `crates/fathom-id/src/lib.rs`; `crates/fathom-ir/src/{lib,bag,scalar,value}.rs`; `crates/fathom-ir/src/generated/{ir_types,accessors}.rs`; `crates/fathom-schema/src/model.rs`; `crates/fathom-schema/tests/{shipped_tree,gate_fixtures}.rs`; `crates/fathom-schemagen/src/{lib,extract,rust_gen,json}.rs`; `crates/fathom-schemagen/tests/*` | Every §3 claim, read in full or grepped at the cited items |
| `schema/schema.yaml`, `schema/generated/schema.json`, root `Cargo.toml`, `rust-toolchain.toml` | Bound tokens, symmetric/root edge lists, classes; the dependency position; the pin |
| `cargo test --workspace`; `fathom-schema-check` (run 2026-08-02) | 80 tests, zero failures; exit 0, `0 failure(s), 2 warning(s)` |

## 12. Disagreements

1. **`11` §6.6's union-find over-refuses.** It names *"a union-find, `O(α(n))` amortised"* for
   `AddressSet` cycle checking, but undirected connectivity refuses the legal diamond (one
   `AddressObject` in two sets joins their components with no directed cycle). This WO specifies
   a directed reachability walk over same-kind live edges instead. The L0 outcome `11` requires
   — cycles refused at write — is unchanged; only the parenthetical mechanism is not followed.
2. **`11` §13's internals are not buildable as written** under the zero-dependency position
   (`SlotMap`, `EnumMap`, `SmallVec`, `CompactString` are external crates). Its own status line
   (*"Illustrative of the shape"*) licenses the `BTreeMap` substitution in §4.2; the observable
   contracts (typed ids, deterministic order, bucketed adjacency) are kept.
3. **`fathom-id`'s `NodeId` doc is stale.** *"Defined in phase 0, unused until the graph
   exists"* — it is used today by `fathom_ir::value::NextHop` and generated accessors as the
   field-embedded reference type. This WO does not edit `fathom-id` (out of its deliverable
   set); the store treats `fathom_id::NodeId` as the bare recovery reference and bridges via
   `resolve_ref`. The one-line doc refresh belongs to whichever WO next touches `fathom-id`.
4. **Two names, one concept.** `11` §7.6 says "mutation batch", `53` §7.2 says "transaction",
   `76` §7.2 says "undo batches". This WO writes `Batch` in code and uses "batch" throughout,
   because `Transaction` in `53` carries fields (`actor`, `at: Hlc`, `source`) this slice
   deliberately does not have; renaming later is mechanical.
5. **Corrections after adversarial verification (2026-08-02), against this document's own first
   revision.** The worked example had `hostname` = `srx-a` and put the `{ike}` host-inbound
   write on the VPN → `st0.0` `ZoneMember`; `11` §15.2 has `Set("srx-a-01")`, and `11` §15.6
   puts `Set({Ike})` on the WAN → `reth0.0` edge (piece #3) with the VPN-side edge field
   `Absent` (piece #2). §4.3 now matches the source. G3 originally ran an unscoped
   `git status --porcelain`, which cannot be clean at step 12 (the crate and the manifest edits
   commit in step 13); it is now scoped to the generated paths it actually pins.
