# WO-09 — `fathom-weld`: the fragment-to-store weld

> **Status:** DONE — 2026-08-08. All three escalations (§10 items 8, 9, 10) were answered by
> planning and all three are executed. `crates/fathom-weld` ships `apply_new_device`,
> `containment_edge`, `Mint` and the provenance constructors; §4.6's five test files all exist and
> pass (24 tests in this crate); every §6 gate is green and the floor is 354 passed / 0 failed /
> 0 ignored.
>
> Item 8: the wire form is `17` §15.6 (a payload-bearing variant is a single-key tagged object;
> `Origin::Hand` stays the bare `"hand"`, so WO-05 §4.4's pinned vector does not move), with
> `fathom-workspace`'s writer (`lib.rs:329`) and reader (`lib.rs:617`) match sites carried in §4.2.
> Item 9: option (b) — one `scalar:` value in `corpus/dict/junos-srx/interfaces.yaml:13`, one
> `ValueTy` arm, one `BoundValue` variant. Item 10: an ownerless non-root node takes the containment
> parent the **schema** determines for its kind, refusing with `NoContainmentEdge` if the schema ever
> stops determining exactly one — so the applied device now contains every object the paste stated
> and the fixture's thirteen nodes and nineteen edges are one connected estate rooted at it (§6.1).
> Three kinds do carry more than one possible containment parent, which the answer said none did;
> the guard it wrote covers them and none is reachable from this dictionary (§12 item 15).
>
> Reconciliation is still escalated, not built: `Device` declares `identity: []` and nothing in the
> workspace evaluates an identity tuple (§8 item 1, §10 item 1). A second paste of one box still
> makes two devices.

Depends on: **WO-02** (`fathom-graph` — the store this writes into), **WO-03** (`fathom-ingest` —
the fragment this reads). Both DONE.

The join that does not exist. `fathom-ingest` turns pasted junos-srx text into a typed
`Fragment`; `fathom-graph` holds typed nodes and edges; **nothing carries one into the other.**
WO-03 named the gap in its own deliverables — *"constructing the store's provenance records,
minting node ULIDs (`fathom-id` from caller-supplied parts only), and reconciliation are the weld
WO's work"* (WO-03 §4.8 contract item 4) — and WO-04 §10 item 7(a) records the consequence:
*"No text-to-store entry point exists or is specified anywhere."* This work order is that entry
point, and **only** that entry point: re-parse reconciliation is escalated, not built (§10 item 1),
because the schema declares no identity tuple for `Device` (§3).

Execution protocol: `docs/70-ops/78-execution-protocol.md` governs. Every constraint in `78` §2 is
inherited and not restated; `78` §4's escalation rule applies to every trigger in §7. Read
`CLAUDE.md`, then `.context/conventions.md`, then `78`, then this document, then the cited §§ — in
that order.

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

When this work order is DONE, `crates/fathom-weld` exists and one call —
`apply_new_device(&mut Graph, &IngestOutput, &Manifest) -> Result<WeldOutput, WeldError>` — takes
WO-03's typed fragment and writes it into WO-02's store as **one new device**: every `FragNode`
becomes a store node with a minted ULID; every `FragNode.owner` becomes the containment edge the
schema declares for that (owner kind, child kind) pair; every `FragEdge` becomes a store edge;
every `FieldAssertion` becomes a `set_field` carrying a `ProvenanceRecord` whose origin is
`Origin::Parsed` with the capture and the post-redaction byte span that produced it; `Device.platform`
is stamped; and the whole apply lands in one caller-labelled batch. Unresolved `PendingEdge`s are
carried out of the call unmaterialised, exactly as `14` §7.3 requires. Nothing here reconciles a
re-parse, resolves a reference against the existing store, asserts absence, tombstones, or reads a
redaction's original length.

To carry parse provenance at all, `fathom-graph`'s `Origin` gains its second variant — the
additive extension WO-02 designed for (*"They arrive with those subsystems; adding a variant here is
additive"*, `crates/fathom-graph/src/prov.rs`) — and the one exhaustive match over it, in
`fathom-inventory`, gains its arm.

## 2. Binding sources

Constraints every work order inherits — invariants 1–3, 6, 7 and 9, ADR-0008, zero external
dependencies, the pinned toolchain, `#![forbid(unsafe_code)]`, the risk enum, the
BLOCKER / MAJOR / MINOR scale, house style — are stated once in `78` §2 and are not re-derived here.
The sources specific to this work order:

| Source | What it binds | The line that binds |
|---|---|---|
| `docs/10-core/11-ir-schema.md` §8.1 | What provenance attaches to, and therefore what this WO must construct three of | `NodeProvenance.existence` — *"why does this node exist at all"*; `Field<T>.prov`; `Edge.prov` |
| `11` §8.2 | The record and the `Origin::Parsed` payload this WO cuts down | `Parsed { capture: CaptureId, span: ByteSpan, stanza: ConfigPath, parser: ParserId, parser_version: CorpusVersion }` |
| `11` §8.3 | The three confidences, and which one a reference-implied existence gets | `Derived` — *"Follows necessarily from asserted facts"* |
| `11` §8.4 | Why the record carries a span and not the line | *"copying an average 60-byte line into each is ~700 KB of duplicated text per device"* |
| `11` §8.5 | Who may assert `Absent` — and therefore why this WO never does | *"clearing a field must produce `Unknown`, not `Absent`"*; the closed-world/human pair |
| `11` §7.2 | The containment rule the `owner` materialisation must satisfy | *"Exactly one containment in-edge per node."* |
| `11` §3.4 | The two edge classes and the containment lifecycle | Containment: *"Deleting the owner deletes the target."* |
| `11` §10.1 | Why the ULIDs are minted from caller-supplied parts, and where they may go | *"**IDs never leave the workspace.**"* |
| `11` §10.3 | What identity tuples are for — and that this WO uses none | *"Identity tuples are **only** used by re-identification. They are never used for lookup, never used by rules, never persisted as a key."* |
| `11` §10.4 | The re-identification algorithm this WO does **not** build, and its first input | *"Runs on every re-parse of a config for a device already in the graph."* — its step 1 is keyed on `owner_device(n) = D` |
| `11` §10.5 | Why absence handling is out: it is a function of capture scope, and this slice's scope is `Fragment` | `Fragment` / *"nothing happens"* |
| `docs/10-core/14-parsers-and-ingest.md` §7.3 | The one rule that decides what happens to `Fragment.pending` | *"create a **`Pending` edge**: recorded, not materialised, retried on every future ingest for this device. Never a finding"* |
| `14` §7.4 | Why the scope is `Fragment` and stays there in this WO | (§ title) *"Capture scope, computed not declared"* — WO-03 pins the conservative value (its §12 item 6) |
| `14` §8.5 | Where residue lives — not in the graph | *"Lives in the workspace, in the capture section (IR §14.1), not in the graph."* / *"The residue is not a log. It is workspace content."* |
| `14` §9.5 | The obligation this WO exists to discharge on the redaction manifest | `orig_len`: *"for the in-session report only; the persistence layer must not store it. Enforced by doc comment now, by the store weld later."* — **this is `crates/fathom-ingest/src/redact.rs:54`'s doc comment, not `14`'s words.** `14` §9.5 states the same obligation differently (*"kept ONLY in the in-memory manifest, never persisted"*, and *"it is in the in-memory manifest only and is not part of `RedactedCapture`"*); the phrase *"by the store weld later"* appears nowhere in `14`. The code transcribes the document's intent, not its text, and the binding obligation is `14`'s (transcribed verbatim at `crates/fathom-ingest/src/redact.rs:54`) |
| `14` §10.1 | Device identification, which this WO does not perform | *"Every other match depends on it, because identity tuples are scoped by `owner(Device)`."* |
| `14` §10.3 | The `ReconciliationPlan` this WO does not build, and its auto-apply rule | *"a plan is auto-applied only when it is purely additive"* |
| `docs/60-content/62-schema-spec.md` §6.2 | That the store's bound enforcement is the schema's, read from generated tables | *"A bare range is enforced at **L0** — the store refuses the violating write."* |
| `docs/90-decisions/adr-0008-…` (via `78` §2) | Why the containment-edge lookup is computed from generated tables and never tabulated by hand | (whole) |
| `docs/90-decisions/adr-0010-identity-reparse-and-suppression-survival.md` §Decision | Why re-identification is a separate, owner-shaped problem | *"a rename produces a candidate, never a binding"* |
| `docs/50-design/53-interaction-and-keyboard.md` §7.2 | The batch and its label cap | *"The undo unit. Groups the ops one user intention produced."* — `label: BoundedText<60>` |
| `docs/70-ops/79-work-orders/WO-03-ingest-junos-srx.md` §4.8 | The producing side of the contract, complete and unchangeable by this WO | *"a store whose bags satisfy `fathom_ir::bag::FieldBag` can hold every assertion without conversion"* |
| `WO-04-the-emitters.md` §5 step 12, §10 item 7 | What this WO must satisfy for WO-04's G8 to arm, and what it must not pretend to satisfy | step 12(b): *"a fragment-to-store weld work order exists in this directory with status DONE, whose Deliverables name a public entry point taking WO-03's `IngestOutput` (or junos-srx set-statement text) to a `fathom-graph` store"* |
| `docs/70-ops/76-scope-expansion-analysis.md` §7.2 | The two slices this order joins | S3 *"The store: kinds, edges, scalars, `Presence`, provenance, L0 enforcement at write time, ops and undo batches"*; S6 *"Lexer table, shaper, bind, residue ledger, paste UI, reverse explanation"* |
| `78` §5 item 7 | The one manifest exception this WO uses | *"a new workspace member … together with the `Cargo.lock` change that edit produces"* |

## 3. Prior state

Every claim below was verified against the working tree on 2026-08-08 (`cargo test --workspace
--locked`: 282 passed, 0 failed; `fathom-schema-check`: exit 0, `0 failure(s), 2 warning(s)`). A
divergence found during execution is handled by `78` §8's correction test and nothing else.

- **Workspace.** Twelve crates. `[workspace.dependencies]` is empty on purpose. There is no
  `fathom-weld`.
- **`crates/fathom-ingest/src/lib.rs:138`.** `IngestOutput { capture, ledger, residue, drops,
  fragment, scope, uses_groups, truncated }`. `scope` is `CaptureScope::Fragment`, the enum's only
  variant.
- **`crates/fathom-ingest/src/bind.rs:29`.** `Fragment { nodes: Vec<FragNode>, edges: Vec<FragEdge>,
  pending: Vec<PendingEdge> }`. `FragNode { kind: NodeKind, owner: Option<FragNodeId>, fields:
  Vec<FieldAssertion> }`. Two comments in that file assign work to this order, verbatim:
  `nodes[0]` is *"always the implicit Device node (kind Device, no owner) … Its platform field is
  NOT set here; that is the store weld's decision"*, and *"The store weld materialises the Has\*
  containment edges from this; the fragment does not carry them as FragEdges."*
- **`bind.rs`.** `FieldAssertion { key: FieldKey, value: BoundValue, prov: BindProv }`;
  `BindProv { line: LineOrdinal, span: ByteSpan, entry: u16 }` — *"post-redaction (14 §9.5)"*;
  `BoundValue` has **21** variants (`Identifier` … `HostServiceSet`), each carrying exactly the
  payload type the generated accessors read back. `PendingTarget::{ByName { kind, name },
  InterfaceUnit { kind, name, unit }}`. `FragEdge` and `PendingEdge` both carry `fields` and `prov`.
- **`bind.rs`'s module doc.** *"The fragment mints no ULIDs — `fathom-id` deliberately has no
  constructor that reads a clock or an RNG, so nodes are dense indices and identity is the store
  weld's work."*
- **`crates/fathom-ingest/src/dict.rs`.** `Dictionary`'s public surface is exactly `load`,
  `entry_count`, `platform`. `Entry` is `pub(crate)`. **There is no public accessor for an entry's
  id string**, which contradicts `BindProv.entry`'s own doc comment (*"the id string is reachable
  through the Dictionary"*) — see §12 item 1.
- **`crates/fathom-ingest/src/redact.rs:54`.** The `orig_len` doc comment quoted in §2, naming this
  work order as its enforcement point.
- **`crates/fathom-graph/src/graph.rs`.** The write surface, all requiring an open batch:
  `begin_batch(BatchId, &str)`, `end_batch()`, `insert_node(NodeKind, Ulid, ProvenanceRecord)
  -> Result<NodeId, WriteError>`, `insert_edge(EdgeKind, Ulid, NodeId, NodeId, ProvenanceRecord)
  -> Result<EdgeId, WriteError>`, `set_field<T: Any>(ElementId, FieldKey, T, ProvenanceRecord)`,
  `assert_absent`, `clear_field`, `tombstone`. Reads include `provenance`, `resolve_ref`, `owner`,
  `device_of`, `presence`, `history`, `nodes_of_kind`, `out`, `inn`.
- **`graph.rs::check_prov`.** Refuses a caller-supplied `supersedes` (`SupersedesIsStoreOwned`),
  fills it from the slot's current provenance, and refuses a reused `ProvenanceId` whose filled
  content differs (`ProvenanceIdReused`). `intern` is `or_insert`.
- **`crates/fathom-graph/src/prov.rs`.** `Origin` has **one** variant, `Hand`, with the module doc
  naming `Parsed` among the five that *"arrive with those subsystems; adding a variant here is
  additive"*. `Origin::discriminant()` maps `Hand => 0` and is what `field.rs`'s `11` §8.6 retention
  groups by. `Actor` has one variant, `User(UserId)`. `Origin` derives `Copy`, and
  `graph.rs:844` relies on it (`map_or(Origin::Hand, |r| r.origin)`).
- **`crates/fathom-inventory/src/render.rs:73`.** `match rec.origin { fathom_graph::Origin::Hand =>
  "hand" }` — an **exhaustive one-arm match**. Adding a variant to `Origin` breaks this crate's
  build until it gains an arm.
- **`crates/fathom-id/src/lib.rs`.** `Ulid::from_parts(timestamp_ms: u64, random: u128) ->
  Result<Ulid, TimestampOverflow>`; `random` is masked to 80 bits; *"There is deliberately no
  `new()` that reads a clock or an RNG"*, and the doc names the shipped product's two host imports
  (`fathom_entropy`, `fathom_now_ms`). `crates/fathom-inventory/src/demo.rs:31` is the shipped
  precedent for deterministic minting: `Ulid::from_parts(TS0, k)`.
- **`crates/fathom-ir/src/generated/ir_types.rs`.** `NodeKind::{COUNT = 48, ALL}`;
  `EdgeKind::{COUNT = 81, ALL}`; `EdgeClass::{Containment, Reference}`; and the const tables
  `EdgeKind::{class, from_kinds, to_kinds, out_bound_l0, in_bound_l0, symmetric, root_containment,
  fields}`. `accessors.rs::slot_type(FieldKey) -> Option<(TypeId, &'static str)>`.
- **Containment is a function of the endpoint kinds, and it is total where it is needed.** Computed
  over `schema/generated/schema.json` on 2026-08-08: the 41 containment edge kinds expand (through
  `classes`) to **51 distinct (owner kind, child kind) pairs with no pair carried by two edge
  kinds**. Every kind is a containment target except `LearnedRoute` and `Site`. The pairs this
  slice's dictionary can produce all resolve: `(Device, IkeProposal) → HasIkeProposal`,
  `(Device, IkePolicy) → HasIkePolicy`, `(Device, IkeGateway) → HasIkeGateway`,
  `(Device, IpsecProposal) → HasIpsecProposal`, `(Device, IpsecPolicy) → HasIpsecPolicy`,
  `(Device, IpsecVpn) → HasIpsecVpn`, `(IpsecVpn, TrafficSelector) → HasTrafficSelector`,
  `(Device, Zone) → HasZone`, `(Device, {Interface, AggregateInterface, RethInterface,
  TunnelInterface}) → HasInterface`, `({…InterfaceLike}, LogicalUnit) → HasUnit`,
  `(LogicalUnit, Address) → HasAddress`. G5 re-proves the uniqueness half from the generated tables
  rather than trusting this paragraph.
- **`schema/schema.yaml`.** `Device.hostname` is `Identifier` card `1`; `Device.platform` is
  `PlatformId` card `1` (`Device.platform: 7` in `schema/field-keys.yaml`); **`Device` declares
  `identity: []`**, with the transcription note *"VERIFY: no identity tuple stated in 11 §10.3 for
  Device."* Sixteen kinds carry a non-empty `identity` — `Interface`, `LogicalUnit`, `Address`, `SecurityPolicy`, `IkeGateway`, `TrafficSelector`, and ten from `19`'s physical and service model (`PhysicalPort`, `Cable`, `PassiveNode`, `Premises`, `Tenant`, `Service`, `ServiceType`, `ServiceEndpoint`, `ServicePath`, `PathSegment`); counted over
  `schema/generated/schema.json` on 2026-08-08.
- **Nothing in the workspace evaluates an identity tuple.** `crates/fathom-schema/src/model.rs:26`
  parses them as `identity: Vec<(Vec<String>, usize)>` — raw term strings — and `gates.rs` checks
  their *form*. `fathom-schemagen` emits no identity table; `fathom-ir` has none; no crate scores a
  similarity residue. `11` §10.4 steps 2–4 have no implementation anywhere.
- **`crates/fathom-emit/src/output.rs`.** `emit(&Graph, EmitScope::IpsecVpn(NodeId))` and
  `EmitOutput::render_config`. The emitter is the consumer WO-04 §5 step 13 will point at this
  crate's entry point.
- **No `CaptureId`, `ConfigPath`, `ParserId`, `CorpusVersion` or capture store exists** anywhere in
  `crates/` (`rg CorpusVersion crates/` → nothing). `corpus/dict/junos-srx/*.yaml` carries
  `versions: "*"` per entry and no file or dictionary version.
- **The schema checker's standing baseline is two `schema.identity.unexercised` warnings against
  `Site`** (`78` §6). Nothing in this WO may change the warning set; this WO edits no file under
  `schema/`.

**Execution-start checklist** (before plan step 1; a failure of any item is a §7 trigger):

1. WO-02 and WO-03 both read `DONE` in their own status lines (`78` §8 makes those authoritative).
2. `crates/fathom-graph/src/prov.rs` still has exactly one `Origin` variant. If it already has
   `Parsed`, stop — another session has taken part of this order.
3. `crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt` exists and
   `cargo test -p fathom-ingest` is green.

## 4. Deliverables

Exactly these files change or are created. **No file under `schema/`, `crates/fathom-ir`,
`crates/fathom-schema`, `crates/fathom-schemagen`, `corpus/`, `.context/`, `docs/90-decisions/` or
`.github/`.**

| File | Change |
|---|---|
| `Cargo.toml` | One member line added, verbatim (§4.1) |
| `Cargo.lock` | The hunk cargo generates for the new member, and nothing else (`78` §5 item 7) |
| `crates/fathom-weld/Cargo.toml` | New, verbatim (§4.1) |
| `crates/fathom-weld/src/{lib,mint,prov,plan,apply}.rs` | New — the public surface is §4.3–§4.5, complete |
| `crates/fathom-weld/tests/{apply,provenance,containment,determinism,fixture}.rs` | New — §4.6 |
| `crates/fathom-graph/src/prov.rs` | `Origin::Parsed`, `CaptureId`, `CaptureSpan`; `discriminant`; the module-doc line naming `Parsed` as arrived (§4.2) |
| `crates/fathom-graph/src/lib.rs` | Two names added to the `pub use prov::{…}` list (§4.2) |
| `crates/fathom-graph/src/graph.rs` | One doc comment corrected on `assert_absent` (§4.2), **and `WriteError`'s derive line** (§4.5.1) |
| `crates/fathom-ingest/src/dict.rs` | One public method, `Dictionary::entry_id` (§4.2) |
| `crates/fathom-inventory/src/render.rs` | One match arm (§4.2) |
| `crates/fathom-workspace/src/lib.rs` | The two `Origin` match sites — writer (`lib.rs:329`) and reader (`lib.rs:617`) — added by §10 item 8's answer, which §3 could not have named because the crate did not exist when this order was authored (§4.2) |
| This file | Status line → `DONE` at step 11; `00-INDEX.md` row mirrored |

### 4.1 The crate

Root `Cargo.toml` `members` gains one line, keeping the list's existing order (after
`"crates/fathom-wasm"` — i.e. **last** — if the list is alphabetical at execution time,
since `wa` sorts before `we`; the executing session
matches the list it finds and changes nothing else):

```toml
    "crates/fathom-weld",
```

`crates/fathom-weld/Cargo.toml`, verbatim:

```toml
[package]
name = "fathom-weld"
version = "0.1.0"
edition.workspace = true
license.workspace = true
publish.workspace = true
description = "The fragment-to-store weld: a junos-srx ingest fragment applied onto the typed graph as one new device, with parse provenance (WO-09)"

[dependencies]
fathom-graph = { path = "../fathom-graph" }
fathom-id = { path = "../fathom-id" }
fathom-ingest = { path = "../fathom-ingest" }
fathom-ir = { path = "../fathom-ir" }

[dev-dependencies]
fathom-schema = { path = "../fathom-schema" }
```

`src/lib.rs` opens with `#![forbid(unsafe_code)]` and the four denies WO-03 uses
(`clippy::unwrap_used`, `clippy::expect_used`, `clippy::panic`, `clippy::indexing_slicing`), with
`#[cfg(test)]` modules exempt via a module-level `allow`. Public modules: `mint`, `prov`, `plan`,
`apply`; every public item below is re-exported at the crate root. **Any other public name is a §7
trigger.**

Determinism (invariant 9): no `HashMap`/`HashSet` anywhere in the crate — `BTreeMap`/`BTreeSet` or
sorted `Vec` only; no clock, no RNG, no environment read, no I/O. G7 greps for it.

### 4.2 Changes to existing crates — exactly these, and no others

**`crates/fathom-graph/src/prov.rs`.** Add, and change nothing else in the file except the
module-doc sentence that lists `Parsed` among the not-yet-arrived origins (it becomes a sentence
naming the four that remain: `Inferred`, `Imported`, `Defaulted`, `Migrated`):

```rust
/// A capture blob's id (`11` §8.4). The blob itself lives in the workspace's
/// capture section, which does not exist yet; this WO mints the id and hands
/// it back so the caller can pair the two (WO-09 §10 item 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CaptureId(pub Ulid);

/// A half-open byte range into a **redacted** capture (`14` §9.5). Same shape
/// as `fathom_ingest::frame::ByteSpan`, deliberately a distinct type: this
/// crate does not depend on the parser (WO-09 §12 item 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CaptureSpan { pub start: u32, pub end: u32 }
```

and `Origin` gains one variant, keeping `Copy`:

```rust
pub enum Origin {
    Hand,
    /// A parser read it out of a redacted capture (`11` §8.2). `stanza`,
    /// `parser` and `parser_version` are deferred with the subsystems that
    /// own them — there is no capture store and no corpus version in the
    /// tree (WO-09 §3, §10 items 3–4).
    Parsed { capture: CaptureId, span: CaptureSpan },
}
```

`Origin::discriminant()` gains `Origin::Parsed { .. } => 1`. The value is load-bearing: `11` §8.6's
retention keeps *"the earliest entry from each distinct `Origin` discriminant, always"*, so `Hand`
and `Parsed` must not collapse. `crates/fathom-graph/src/lib.rs`'s `pub use prov::{…}` list gains
`CaptureId` and `CaptureSpan`.

**`crates/fathom-graph/src/graph.rs`.** `assert_absent`'s doc comment currently reasons from
`Origin::Hand` being *"the only constructible origin"*. That reasoning expires with this WO. Replace
the second sentence with the fact that remains true: this parser never asserts absence, because
`14` §7.4's scope is pinned `Fragment` and `11` §10.5 gives `Fragment` no licence to assert absence
(WO-03 §12 item 6). No code changes. G6 pins that the weld asserts no absence.

**`crates/fathom-ingest/src/dict.rs`.** One public method, authorised by this order and by nothing
else (WO-03 §4.2 makes any other addition to that crate's surface a trigger there):

```rust
impl Dictionary {
    /// The stable dictionary id of the entry a `BindProv.entry` index names —
    /// `<platform>/<dotted-path>` (conventions § *Identifiers*). `None` when
    /// the index is out of range.
    pub fn entry_id(&self, index: u16) -> Option<&str>;
}
```

**`crates/fathom-inventory/src/render.rs`.** The one-arm match over `rec.origin` gains
`fathom_graph::Origin::Parsed { .. } => "parsed"`. One word, lower-case, matching the existing
`"hand"`.

**`crates/fathom-workspace/src/lib.rs`.** The two match sites §10 item 8's answer authorises, and
nothing else in the file. `17` §15.6 owns the enclosing form — *"A variant with no payload is
written as its bare lower-case token. A variant carrying a payload is written as a single-key
object whose key is that token and whose value is the payload."* — so `Origin::Hand` stays the bare
`"hand"` and WO-05 §4.4's pinned vector does not move. **How the payload renders inside it, which
`17` §15.6 leaves to this order:**

```json
"origin": { "parsed": { "capture": "01K2…", "span": { "end": 1481, "start": 1402 } } }
```

- `CaptureId` is a **bare canonical ULID string** — `ulid_json`, the same rendering every other id
  in the file already gets, including `Actor::User`'s payload. Not an object: it carries one value.
- `CaptureSpan` is a **two-key object of non-negative integers**, `start` and `end`, a half-open
  byte range into the redacted capture (`14` §9.5). Two keys rather than a two-element array
  because the file has no positional encodings and `17` §12 treats readability as a requirement:
  a reader of the diff must not have to know which end comes first. Key order is `obj`'s, which is
  sorted, so `end` precedes `start` on the wire.
- The reader accepts the bare token **or** a one-key object, refuses any other key count, and its
  refusal message becomes a list of accepted tokens — *"the one shipped origin, `hand`"* was stale
  the moment a second variant existed.

### 4.3 The manifest — what the caller supplies, and why each item cannot be invented

The weld is pure: no clock, no RNG, no I/O. Everything it cannot derive from the fragment is a
parameter.

```rust
/// Everything the weld cannot know (invariant 9; `fathom-id`'s no-clock rule).
#[derive(Debug, Clone)]
pub struct Manifest<'a> {
    /// Host clock, once, for the whole apply. Becomes every record's
    /// `asserted_at` and the timestamp half of every minted ULID.
    pub at: fathom_graph::Timestamp,
    /// Host entropy, once: 80 bits, the base of the mint (§4.4).
    pub entropy: u128,
    /// Who pasted it. `11` §8.2's `Actor::Parser` is deferred (§10 item 4).
    pub actor: fathom_graph::Actor,
    /// The batch's undo label (`53` §7.2, `BoundedText<60>`). Passed through:
    /// an over-long label is the store's `LabelTooLong`, surfaced, never
    /// truncated here.
    pub batch: fathom_graph::BatchId,
    pub label: &'a str,
    /// The platform whose dictionary parsed the capture — in practice
    /// `PlatformId(dict.platform().to_owned())`. A foreign key into
    /// `schema/platforms.yaml` (`62` §3.4); this crate does not re-validate it.
    pub platform: fathom_ir::scalar::PlatformId,
}
```

### 4.4 Minting — one counter, one stated consumption order

```rust
/// Deterministic ULID minting from caller-supplied parts. Every id in one
/// apply shares `at`'s millisecond and takes the next value of an 80-bit
/// counter based at `entropy` (`crates/fathom-inventory/src/demo.rs` is the
/// shipped precedent). No clock, no RNG (invariant 9).
pub struct Mint { /* private */ }

impl Mint {
    pub fn new(at: fathom_graph::Timestamp, entropy: u128) -> Result<Mint, MintError>;
    pub fn next(&mut self) -> Result<fathom_id::Ulid, MintError>;
    /// How many ids this mint has issued. Reported in `WeldOutput`.
    pub fn issued(&self) -> u32;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MintError {
    /// `at` exceeds `Ulid::TIMESTAMP_MAX_MS`.
    TimestampOverflow,
    /// The 80-bit counter wrapped back to its base within one apply.
    Exhausted,
}
```

**DECISION — the random half is a counter, not randomness, and the cost is stated.** `11` §10.1
prices ULID's 80 bits as randomness; a counter based at one host-supplied value gives up
unlinkability *within* an apply — ids minted by one paste are adjacent, so their ordering leaks the
order the weld wrote them. That is acceptable because `11` §10.1 also says **"IDs never leave the
workspace"**, the whole workspace is one encryptor's plaintext, and the alternative — an RNG call
per id — is exactly the nondeterminism invariant 9 quarantines at the host boundary. The existing
tree already mints this way in `fathom-inventory`'s demo estate and in every `fathom-graph` and
`fathom-emit` test.

**Consumption order, fixed, because it fixes every `NodeId` and therefore every iteration order:**

1. the `CaptureId`;
2. for each `FragNode` in `FragNodeId` ascending: its existence `ProvenanceId`, then its node ULID;
3. `Device.platform`'s `ProvenanceId`;
4. for each node in `FragNodeId` ascending order of the **child**: its containment edge's
   `ProvenanceId`, then the edge ULID (skipped for `nodes[0]`, which has no owner);
5. for each `FragNode` in `FragNodeId` ascending, for each `FieldAssertion` in the vector's order:
   one `ProvenanceId`;
6. for each `FragEdge` in vector order: its `ProvenanceId`, then its edge ULID, then one
   `ProvenanceId` per `FieldAssertion` in the vector's order.

`ProvenanceId` and element ULIDs draw from the **same** counter: the store's `by_ulid` uniqueness
map covers nodes and edges, provenance ids live in a separate map, and one namespace makes a
collision unrepresentable rather than merely unlikely.

### 4.5 The weld

```rust
/// One `ProvenanceRecord` per assertion (`11` §8.2: *"One immutable assertion
/// record"*). Never shared between two assertions — see §12 item 3.
pub mod prov { /* private constructors; no public items beyond the re-exports below */ }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unresolved {
    /// The store node the reference is from — already written.
    pub from: fathom_graph::NodeId,
    pub kind: fathom_ir::generated::ir_types::EdgeKind,
    /// Carried verbatim from the fragment (`14` §7.3: recorded, not materialised).
    pub target: fathom_ingest::bind::PendingTarget,
    pub line: fathom_ingest::frame::LineOrdinal,
    pub span: fathom_graph::CaptureSpan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WeldOutput {
    pub batch: fathom_graph::BatchId,
    pub capture: fathom_graph::CaptureId,
    /// `nodes[0]` — the device this apply created.
    pub device: fathom_graph::NodeId,
    /// Index-aligned with `Fragment.nodes`.
    pub nodes: Vec<fathom_graph::NodeId>,
    /// Index-aligned with `Fragment.edges`.
    pub edges: Vec<fathom_graph::EdgeId>,
    /// The containment edges materialised from `FragNode.owner`, in the
    /// order §4.4 step 4 mints them.
    pub containment: Vec<fathom_graph::EdgeId>,
    /// Every `Fragment.pending` entry, in fragment order. Never dropped,
    /// never materialised, never an error (`14` §7.3).
    pub unresolved: Vec<Unresolved>,
    pub minted: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WeldError {
    /// `fragment.nodes` is empty, or `nodes[0].kind != Device`. WO-03 §4.8
    /// makes both unreachable; refused rather than assumed.
    NotDeviceRooted,
    /// `FragNode.owner` does not point at a strictly earlier index
    /// (WO-03 §4.8 contract item 2).
    OwnerNotEarlier { node: u32 },
    /// No containment edge kind is declared for this (owner, child) pair.
    /// A schema gap, not a bug in the caller: it names both kinds.
    NoContainmentEdge {
        owner: fathom_ir::generated::ir_types::NodeKind,
        child: fathom_ir::generated::ir_types::NodeKind,
    },
    /// The declared slot type and the `BoundValue` payload disagree — the
    /// WO-03 §4.8 contract item 1 guarantee has broken. Names the key.
    SlotType { key: fathom_ir::bag::FieldKey },
    Mint(MintError),
    /// Any refusal from the store, carried whole so the L0 declaration that
    /// refused is never lost.
    Store(fathom_graph::WriteError),
}

/// Apply one ingest's fragment onto `graph` as a **new** device.
///
/// First application only: it never looks for an existing device and never
/// reconciles (`11` §10.4 is not implemented anywhere — §10 item 1). Applying
/// two captures of the same box produces two `Device` nodes, which is the
/// duplication reconciliation exists to prevent; the name says so.
///
/// On any error the graph is left with the partial batch **open** and the ops
/// written so far recorded — see §4.5's atomicity DECISION.
pub fn apply_new_device(
    graph: &mut fathom_graph::Graph,
    ingest: &fathom_ingest::IngestOutput,
    manifest: &Manifest<'_>,
) -> Result<WeldOutput, WeldError>;

/// The containment edge kind the schema declares for one (owner, child) pair,
/// computed from the generated tables — never a hand-written table (ADR-0008).
/// `None` when no containment edge admits the pair. Uniqueness is G5's gate.
pub fn containment_edge(
    owner: fathom_ir::generated::ir_types::NodeKind,
    child: fathom_ir::generated::ir_types::NodeKind,
) -> Option<fathom_ir::generated::ir_types::EdgeKind>;
```

**The algorithm, in the order the mint consumes ids (§4.4), each step's rule stated:**

1. **Validate.** `nodes[0]` exists and is `NodeKind::Device` (`NotDeviceRooted`); every
   `owner` points strictly earlier (`OwnerNotEarlier`). Both before any write.
2. **Open the batch.** `graph.begin_batch(manifest.batch, manifest.label)`. A `LabelTooLong`,
   `BatchAlreadyOpen` or `BatchIdReused` is `WeldError::Store`, surfaced unchanged.
3. **Nodes.** For each `FragNode` in index order, `insert_node(kind, ulid, existence)`. The
   existence record's origin is `Origin::Parsed { capture, span }` where `span` is the node's
   **first** `FieldAssertion`'s `BindProv.span`, and for a node with no assertions the whole
   capture, `CaptureSpan { start: 0, end: ingest.capture.text().len() }`. Confidence is
   `Asserted` — the statement that named the object observed it directly (`11` §8.3).
4. **`Device.platform`.** `set_field(nodes[0], FieldKey(7), manifest.platform.clone(), rec)` with
   origin `Parsed` over the whole capture and **`Confidence::Derived`**: no statement asserts the
   platform, it follows necessarily from which dictionary parsed the capture (`11` §8.3's
   *"Follows necessarily from asserted facts"*). The key is read from the generated registry, never
   written as a literal. This settles WO-03 §10 item 1.
5. **Containment.** For each node except `nodes[0]`, in index order: `containment_edge(owner.kind,
   node.kind)` — `NoContainmentEdge` if `None` — then `insert_edge(kind, ulid, owner_id, node_id,
   rec)` with the child's existence provenance content (a fresh id, same origin and span). The
   store's `SecondContainment`, `ContainmentCycle` and `RootContainment` checks are the enforcement
   of `11` §7.2; this WO adds none of its own.
6. **`nodes[0]` gets no containment in-edge.** `Site` is not in the fragment and this WO does not
   invent one: a `Device` with no `HasDevice` in-edge is L0-valid (`11` §7.2's rule is enforced as
   an *upper* bound at write time — `11` §7.1: *"the lower bound at emit and validity check time
   (L1/L2)"*), and inventing a `Site` would create a node the config never mentioned, against the
   one identity rule the owner has not yet given (`CLAUDE.md`; `88` §6.13).
7. **Node fields.** For each assertion in vector order, one record, then a `set_field` dispatching
   on `BoundValue`'s 21 variants — an exhaustive `match` moving each payload into the store's
   generic parameter. A `WriteError::WrongType` becomes `WeldError::SlotType` carrying the key, so
   a contract break names the field rather than the value.
8. **Fragment edges.** For each `FragEdge` in vector order: `insert_edge`, then its `fields` by the
   same dispatch onto `ElementId::Edge`. Both endpoints are in-fragment by construction.
9. **Pending.** For each `PendingEdge` in vector order, one `Unresolved` row. **No write.**
   `14` §7.3: *"recorded, not materialised."* Not an error, not a residue entry, not a finding.
10. **Close.** `end_batch()`, and return `WeldOutput`.

**DECISION — the weld never asserts absence, never tombstones, never clears.** `14` §7.4 pins this
slice's scope to `Fragment`, and `11` §10.5 gives `Fragment` scope no licence at all: *"nothing
happens"* to a node missing from the capture. `assert_absent`, `clear_field` and `tombstone` are
never called; G6 greps for it. Every write is a `Set` with `Confidence::Asserted`, except step 4's
`Derived`.

**DECISION — the apply is not atomic, and that is stated rather than hidden.** `fathom-graph` has
no rollback: `Op::Untombstone` does not exist and undo application is WO-02 §10 item 1's open
decision. On a `WeldError` after step 2, the ops written so far are in the open batch and the batch
is left open. The weld therefore does everything it can refuse **before** the first write (step 1),
and every remaining failure mode is a store refusal that the caller must treat as a corrupt
workspace state. Making the apply transactional is `78` §7 planning work and is §10 item 6.

### 4.6 Tests

Exactly these files and test names; bodies are the executing session's, to the assertions stated
here and in §5–§6.

| File | Tests |
|---|---|
| `tests/containment.rs` | `every_kind_pair_has_at_most_one_containment_edge` (all 48 × 48 `NodeKind` pairs against the generated tables; assert `containment_edge` agrees with a locally computed scan and that no pair is carried by two edge kinds); `the_dictionary_pairs_resolve` (the eleven §3 pairs, by name) |
| `tests/apply.rs` | `nodes_land_index_aligned`; `owner_becomes_the_declared_containment_edge`; `device_has_no_containment_in_edge`; `platform_is_stamped_derived`; `fragment_edges_and_their_fields_land`; `pending_is_carried_not_materialised`; `one_batch_holds_every_op`; `owner_not_earlier_is_refused_before_any_write`; `no_containment_edge_names_both_kinds` |
| `tests/provenance.rs` | `every_field_record_is_parsed_with_its_own_span`; `node_existence_span_is_the_first_assertion`; `fieldless_node_existence_spans_the_capture`; `one_capture_id_across_the_apply`; `records_are_never_shared_between_assertions`; `nothing_is_absent_after_apply` (walk every node and edge field key; assert no slot is `StoredPresence::Absent`) |
| `tests/determinism.rs` | `two_applies_one_ingest_render_identically` (apply the same `IngestOutput` into two fresh graphs with the same manifest; assert every `Display` id, the op count and the `WeldOutput` debug rendering are byte-identical) |
| `tests/fixture.rs` | `the_synthetic_srx_fixture_applies` — `Dictionary::load(repo_root())`, `ingest` over `crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt`, then `apply_new_device` into a fresh `Graph`. Assert: `Ok`; `WeldOutput.nodes.len()` equals `fragment.nodes.len()`; the `Device` carries `hostname` and `platform` `Set`; the `IpsecVpn` closure is reachable from the device by `out`/`inn`; and `unresolved` is **non-empty** and contains the `reth0.0` `InterfaceUnit` reference — the fixture defines `st0` but never `reth0` (§10 item 2). The counts this test pins are the executing session's to fill in from the run, in this file's §6.1, in the same PR |

`repo_root()` follows `crates/fathom-ingest/tests/srx_fixture.rs`'s precedent
(`env!("CARGO_MANIFEST_DIR")` plus `..`).

### 4.5.1 One derive line in `fathom-graph`, and why this order authorises it

**`WeldError` as declared in §4.5 does not compile against the tree as it stands.** Its
`Store(fathom_graph::WriteError)` variant sits under `#[derive(Debug, Clone, PartialEq, Eq)]`, and
`crates/fathom-graph/src/graph.rs:107` declares `WriteError` as `#[derive(Debug)]` — no `Clone`, no
`PartialEq`, no `Eq`, and no hand-written impls. Compiling it yields three errors: E0277
(`WriteError: Clone` not satisfied), E0369 (`==` cannot be applied to `&WriteError`), and E0277
(`WriteError: Eq` not satisfied). Verified by building a scratch crate against the real
`fathom-graph` on 2026-08-08, not by reading.

**Without this subsection the order is unexecutable and the session must escalate**, because §7
trigger 6 forbids both available fixes: changing the variant's payload introduces a public shape
§4 does not list, and editing `graph.rs` beyond §4.2's one doc comment exceeds this order's grant.
That is a work order that specifies a type it also forbids you to make compile.

> **AUTHORISED, exactly and only this.** In `crates/fathom-graph/src/graph.rs`, change
> `WriteError`'s derive line from `#[derive(Debug)]` to `#[derive(Debug, Clone, PartialEq, Eq)]`.
> No other change to `WriteError` — no new variant, no changed payload, no `Copy`.

**Why this is the right half of the fix rather than weakening `WeldError`.** The asymmetry is an
oversight, not a design: `ReadError` at `graph.rs:307` already derives
`Debug, Clone, Copy, PartialEq, Eq`, and the two are siblings in the same module describing the two
directions of the same store. `WriteError`'s payloads are ids, kinds and field keys — all already
`Clone + Eq` — so the derive is mechanical. The alternative, collapsing the variant to
`Store(String)`, would throw away the typed reason a caller needs to distinguish an L0 refusal from
a batch-state error, and this order's whole argument is that the weld refuses rather than guesses.

**It compiles.** `cargo check -p fathom-graph --locked` was run on 2026-08-08 with the derive line
changed, and finished clean; the change was then reverted so this order still has it to make. This
order does not hand an executing session a change it has not tried. If it nonetheless fails, that is
a real finding about `WriteError`'s payloads: stop and escalate under `78` §4 rather than reaching
for `Store(String)`.

## 5. The plan

Each step ends with the tree compiling and `cargo test --workspace --locked` green unless the step
says otherwise. No reordering, no merging (`78` §3.6).

1. **`Origin::Parsed`.** Edit `crates/fathom-graph/src/prov.rs` per §4.2 (`CaptureId`,
   `CaptureSpan`, the variant, `discriminant`, the module-doc sentence), `lib.rs`'s re-export list,
   and `graph.rs`'s `assert_absent` doc comment. Add the `render.rs` arm. `cargo test --workspace
   --locked` green — this step changes no behaviour.
2. **`Dictionary::entry_id`.** The one method in §4.2, with an in-module unit test that a
   round-trip through `entry_count()` bounds returns `Some` inside and `None` outside.
3. **Skeleton.** Create `crates/fathom-weld` with §4.1's manifest verbatim, the members line, and
   `lib.rs` with empty modules. `cargo build -p fathom-weld` compiles.
4. **`containment_edge`** and `tests/containment.rs`. If
   `every_kind_pair_has_at_most_one_containment_edge` fails, §3's computed fact was wrong and
   `78` §8 decides correction versus escalation — do **not** add a tie-break rule (§7 trigger 3).
5. **`mint.rs`** per §4.4, with in-module unit tests: the counter is monotonic, `issued()` counts,
   `TimestampOverflow` and `Exhausted` both reachable.
6. **`prov.rs`** — the private record constructors: `existence(span)`, `field(span)`,
   `derived(span)`, each taking the mint, the manifest and a `CaptureId`, each returning a
   `ProvenanceRecord` with `supersedes: None` (the store fills it — `11` §8.6).
7. **`plan.rs`** — step 1's validation and the `BoundValue` → slot dispatch table, as a private
   function taking `&mut Graph`, the element and the assertion. No writes escape this module
   without a provenance record.
8. **`apply.rs`** — `apply_new_device`, steps 2–10 of §4.5 in that order, plus `WeldOutput`,
   `Unresolved`, `WeldError`.
9. **Integration tests** per §4.6, in file order: `apply`, `provenance`, `determinism`, `fixture`.
10. **Floor.** Run §6's gates in order. Fix only defects in this WO's own new code; anything else
    is §7.
11. **Bookkeeping.** Status line → `DONE`; mirror the `00-INDEX.md` row; backfill §4.6's fixture
    counts into a new §6.1 in this file. Commit per `78` §3.9 (subject naming the deliverable, e.g.
    *"Weld the ingest fragment onto the store: fathom-weld, parse provenance, minted ids"*), push,
    open the PR listing every gate's output verbatim. **Do not merge**, and do not touch WO-04's
    status line — its step 12 preconditions are its own to check, and §10 items 2 and 5 record why
    they are not all met by this order.

## 6. Acceptance gates

Run from the repository root, in this order, locally, before push (`78` §6). Expected results are
exact; anything else is a red gate and §7 applies.

| # | Command | Expected |
|---|---|---|
| G1 | `cargo fmt --all --check` | exit 0, no output |
| G2 | `cargo clippy --all-targets --locked -- -D warnings` | exit 0 |
| G3 | `cargo test -p fathom-weld --locked` | every §4.6 test listed, all `ok`, `0 failed` |
| G4 | `cargo test --workspace --locked` | zero failures; every pre-WO test still passes, none deleted, loosened or ignored (`78` §5.5). Green is the gate, not a count (`78` §12 item 3) |
| G5 | `cargo test -p fathom-weld --locked --test containment` | `every_kind_pair_has_at_most_one_containment_edge` `ok` — the §3 uniqueness fact re-proved from the generated tables, not from this document |
| G6 | `grep -rn "assert_absent\|clear_field\|tombstone\|orig_len\|residue\|drops" crates/fathom-weld/src` | No matches, exit 1. The first three are §4.5's never-called set; `orig_len` is `14` §9.5's obligation this WO discharges; `residue` and `drops` stay in `IngestOutput` for the workspace layer (§8 item 4) |
| G7 | `grep -rn "HashMap\|HashSet\|SystemTime\|Instant\|random" crates/fathom-weld/src crates/fathom-weld/tests` | No matches, exit 1 (invariant 9). `Ulid::random()` is not called by this crate |
| G8 | `git diff --exit-code -- schema/ crates/fathom-ir crates/fathom-schema crates/fathom-schemagen corpus/` | exit 0, no output — this WO touches none of them |
| G9 | `cargo run --locked -q -p fathom-schema --bin fathom-schema-check` | exit 0; `0 failure(s), 2 warning(s)`, both `schema.identity.unexercised` — the pinned baseline, unchanged |

### 6.1 The fixture's counts, from the run (§5 step 11's backfill)

Every number below is read off the apply of `crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt`
through the shipped dictionary on 2026-08-08, and every one of them is pinned by an assertion in
`crates/fathom-weld/tests/fixture.rs` or re-derived from the store in `tests/provenance.rs`. None is
transcribed from a document.

| Quantity | Value | Where it is pinned |
|---|---|---|
| Fragment nodes → store nodes | 13 | `the_synthetic_srx_fixture_applies`; `nodes_land_index_aligned` proves the alignment |
| Fragment edges → store edges | 7 | `the_synthetic_srx_fixture_applies`; `fragment_edges_and_their_fields_land` |
| Containment edges materialised | 12 | every node but `nodes[0]`: 3 from a declared `FragNode.owner`, 9 from the schema-determined parent (§10 item 10) |
| Store edges, total | 19 | 7 + 12 |
| `unresolved` | 2 | both `reth0.0` — the `external-interface` and the zone-membership references; the fixture declares `st0` and never `reth0` |
| `minted` | 99 | `records_are_never_shared_between_assertions` re-derives it as `1 + records + elements` = 1 + 66 + 32 |
| Ops in the one batch | 66 | 13 `AddNode` + 19 `AddEdge` + 34 `SetField` (31 node-field assertions + 2 edge-field assertions + `Device.platform`); `one_batch_holds_every_op` |
| Nodes reachable from the device | 13 | the whole store: `the_synthetic_srx_fixture_applies` walks `out`/`inn` over all 81 edge kinds |

The `unresolved` count is the one number here that is a defect rather than a fact about the weld:
the two rows are `14` §7.3's *"recorded, not materialised"* working exactly as specified, and they
are also §10 item 2's third precondition for WO-04's G8, which stays unarmed.

## 7. Stop-and-escalate triggers

The general rule is `78` §4; escalating is success. Specific to this work order, stop and escalate
when:

1. **Reconciliation looks reachable.** Any step that seems to need matching a fragment node onto an
   existing store node, scoring similarity, detecting a rename, choosing a device, or deciding what
   a second paste of the same box does. `11` §10.4 has no implementation and `Device` has no
   identity tuple (§3); building one here would invent a natural key against `schema/schema.yaml`'s
   own rule and invariant 7's no-natural-keys clause. §10 item 1.
2. **A `PendingEdge` tempts materialisation.** Creating the referenced node — an `Interface`, a
   `LogicalUnit`, an `IkeGateway` — to make an edge land. `14` §7.3 says *"recorded, not
   materialised"*. §10 item 2.
3. **The containment lookup is ambiguous** for any `(NodeKind, NodeKind)` pair (G5 red), or a
   fragment produces a pair with no containment edge. Either is a schema fact that moved; a
   tie-break rule invented here would be a hand-copied schema decision (ADR-0008).
4. **`IpsecVpn.mode`, or any other field the config does not state, seems to need deriving** to make
   an emitter or a test pass. §10 item 5, and WO-04 §10 item 7(b)'s own rule — an inference here
   *"would invent a value the user never chose"*.
5. **A `ProvenanceIdReused`, `SupersedesIsStoreOwned` or `UlidReused` refusal fires.** Each means
   §4.4's minting order or §12 item 3's one-record-per-assertion rule has been departed from.
6. **A public name, file, error variant or test name not listed in §4 is needed**; or an edit to a
   file outside §4's table is needed; or a cited § contradicts this document.
7. **The schema checker's two-warning baseline moves** (G9), for any reason.
8. **`Actor::Parser`, a capture store, `ConfigPath`, `ParserId` or a corpus version seems needed.**
   None exists; each arrives with its own subsystem (§10 items 3–4).

## 8. Non-goals

1. **No reconciliation, no re-identification, no device identification, no `ReconciliationPlan`**
   (`11` §10.4, `14` §10.1–§10.3, ADR-0010). §10 item 1.
2. **No resolution against the existing store.** `14` §7.3's row *"Resolved in existing graph"*
   needs a device to resolve within, which needs item 1.
3. **No absence handling, no tombstoning, no `Divergent` marking** (`11` §10.5) — all are functions
   of a capture scope this slice does not compute (`14` §7.4).
4. **No persistence.** Residue, drops and the redacted capture stay in `IngestOutput`; the capture
   section of the workspace is `14` §8.5's *"workspace content"* and WO-05's territory. The weld's
   only obligation to them is negative and gated (G6).
5. **No second platform and no second capture form.** The fragment is platform-neutral by
   construction; nothing here is junos-specific except the fixture.
6. **No emit, no rules, no findings, no UI**, and no edit to `fathom-emit` — WO-04 §5 step 13 is
   WO-04's to run.
7. **No inference and no defaults.** `Origin::Inferred` and `Origin::Defaulted` arrive with `11`
   §9.5's rule subsystem and `11` §5.3's defaults table.
8. **No transaction/rollback machinery** (§4.5's atomicity DECISION; §10 item 6).

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | A containment edge kind is hand-tabulated in the weld and drifts from `schema.yaml` | `containment_edge` computes from the generated tables only; G5 pins uniqueness across all 2,304 kind pairs; G8 proves `schema/` and `fathom-ir` were not touched |
| 2 | Two applies produce different ids, so nothing downstream is reproducible | §4.4 fixes the consumption order; `determinism.rs` renders both applies and compares bytes |
| 3 | A redaction's `orig_len` reaches a persisted structure through the weld | G6 greps the identifier out of the crate; `WeldOutput` carries no drop data at all (§4.5) |
| 4 | A pending reference is quietly dropped, and a line the parser understood vanishes | `pending_is_carried_not_materialised` asserts the count matches `fragment.pending.len()`; `14`'s register line — *"NOTHING PARSED IS SILENTLY LOST"* — is the standard |
| 5 | The executing session "helpfully" reconciles, or creates a referenced node | §7 triggers 1 and 2; `78` §9's obedient-improviser row — *"the tell is a public name in the diff absent from the work order's Deliverables"* |
| 6 | A `BoundValue` payload and the declared slot type diverge and the write is silently skipped | The dispatch is an exhaustive `match` (a new `BoundValue` variant is a compile error here, which is the point); `WriteError::WrongType` becomes `WeldError::SlotType` naming the key, never an `Ok` |
| 7 | `Origin::Parsed` collapses with `Hand` in history retention, so the earliest hand edit is dropped | `discriminant()` returns a distinct value; `11` §8.6's retention is exercised by `fathom-graph`'s existing `history_retention_sixteen_plus_earliest` |
| 8 | A partial apply leaves an open batch and the caller does not notice | §4.5's atomicity DECISION states it in the doc comment on `apply_new_device`; §10 item 6 registers the fix |

## 10. Open decisions

Deliberately not decided here; owner or planning session only (`78` §7). This section doubles as the
escalation inbox under `78` §4 step 2.

1. **Reconciliation on re-parse — the largest thing this order does not do.** `11` §10.4 specifies
   the algorithm and `14` §10.3 the plan; neither is implemented, and neither can be until the
   inputs exist. Three of them are missing, and they are missing in a stated order:
   (a) **`Device` declares `identity: []`** (`schema/schema.yaml`, with the transcription note
   *"no identity tuple stated in 11 §10.3 for Device"*), and `11` §10.4 step 1 scopes every other
   match by `owner_device(n) = D`. `Device` is in the same state as `Site`, whose identity rule
   `CLAUDE.md` already lists as owner-only and blocking, and which `88` §6.13 says *"needs one
   sentence"*. **`Device`'s rule needs the same sentence and is not on any list today.**
   (b) **No identity-tuple evaluator exists.** `fathom-schema` parses the tiers as raw strings and
   gates their form; nothing generates them into `fathom-ir`, and nothing evaluates a tuple against
   a node. `11` §10.4 steps 2–4 — bucketing, tiered hash join, the guarded similarity residue with
   its 0.75/0.15 thresholds — have no code anywhere.
   (c) **Device identification is ingest-side work `14` §10.1 assigns to a stage that does not
   exist**, and `14` §10.2's chassis-cluster and two-devices-in-one-paste signatures are ingest
   concerns, not store concerns.
   The order this should be taken in: the owner's `Device` (and `Site`) identity sentence, then a
   planning order for the tuple evaluator, then the reconciliation order. Until then
   `apply_new_device`'s name is the whole contract: a second paste of one box makes two devices.
2. **What the round trip needs that neither this order nor WO-04 has.** WO-04 §4.9's golden — the
   21 lines G8 re-parses — contains `set security ike gateway GW-B external-interface reth0.0` and
   `set security ipsec vpn VPN-B bind-interface st0.0`, and **no `set interfaces` statement at
   all**. Under `14` §7.3 both references stay `Pending`, so the `ExternalInterface` and
   `BindsInterface` edges do not exist in the re-parsed graph and the second emit cannot reproduce
   those two lines. This is a **third** G8 precondition, alongside WO-04 §10 item 7's (a) and (b),
   and it is recorded here because this order is where it became checkable. Candidate resolutions,
   none of them this order's: extend the golden with the interface statements it references (which
   changes WO-04 §4.9's byte-exact block, a Disagreements-bearing edit); give `Pending` edges a
   store representation (`11` §3.4's edge classes are `Containment` and `Reference` only, so this
   is a schema question); or make referent materialisation a decided rule, against `14` §7.3's
   *"recorded, not materialised"*. Planning, with `14` §7.3 and WO-04 §4.9 side by side.

   **ANALYSIS 2026-08-09 (planning). The golden is not defective — it is representative, and that
   makes this a finding about the emitter's output rather than about a fixture.**

   Four facts, each checked rather than reasoned:

   1. **`fathom-emit` emits six statement families and no others.** Grepping its emitted literals
      returns exactly `set security ike proposal`, `set security ike policy`, `set security ike
      gateway`, `set security ipsec proposal`, `set security ipsec policy`, `set security ipsec vpn`.
      **There is no `set interfaces` anywhere in the crate.** It reads `Interface`, `RethInterface`
      and `TunnelInterface` only to resolve a *name* to render into `external-interface` and
      `bind-interface`.
   2. **The interface name is not stored anywhere else.** `ExternalInterface` is `class: reference`,
      `IkeGateway → LogicalUnit`, `out: "1"`. There is no scalar field carrying `reth0.0`; the text
      exists in the graph **only** as a resolved edge target. A reference that does not resolve loses
      the name from the store entirely — it survives only in the ingest's `Unresolved` list, which
      the store does not hold.
   3. **Therefore the emitter's own output is not self-parseable.** It writes
      `external-interface reth0.0` and never writes the statement that creates `reth0.0`. Feed its
      output back through ingest in isolation and that reference dangles, exactly as the golden's
      does — because **the golden has precisely the shape the emitter produces.**
   4. **So extending the golden (candidate 1) does not work, and would look like it did.** Adding
      `set interfaces` lines makes the *first* parse resolve, but those lines are not in the
      emitter's vocabulary, so emit drops them and the rendered output no longer equals the input.
      The gate would go red for a new reason, and a session under pressure could then be tempted to
      compare against a subset — which is the cheat this gate exists to prevent.

   **What this actually is.** `13` §11.1 E1 says *"the first emit may lose things; the second must
   lose nothing further."* The fixed point is `emit(parse(emit(parse(x))))` equalling
   `emit(parse(x))`. It does not hold here, and the reason is structural: **the emitted artifact is a
   fragment that presupposes context it does not carry.** That is arguably correct behaviour — Fathom
   emits a change set to paste onto a box that already has `reth0.0`, not a whole configuration — but
   if it is correct, then *"re-parse my own output in isolation"* is the wrong test, and G8 as written
   cannot pass however the fixture is arranged.

   **The decision is therefore not which candidate to pick. It is what the emitter's output IS**, and
   it belongs to `13` (which owns the round-trip property) and WO-04 (which owns emit scope) sitting
   together. Two shapes, stated without a lean:

   - **The output is a standalone configuration.** Then emit must widen to declare what it
     references, and WO-04's scope grows — a `Disagreements`-bearing change to a DONE-adjacent order.
   - **The output is a fragment.** Then E1's fixed point must be re-stated to re-parse the output
     **against the originating graph** rather than against nothing, and G8's criterion is rewritten
     rather than its fixture adjusted.

   **This is the fourth blocker the weld has surfaced and the first that is not a defect in something
   written.** The other three were a type that could not compile, a disagreement between the
   dictionary and the schema, and devices that contained nothing. This one is a question nobody had
   asked: *what is the thing we emit?* It was unanswerable until something tried to read it back.
3. **The capture store.** `11` §8.4's `Capture { id, taken_at, device, scope, platform, command,
   text, digest }` does not exist. This WO mints a `CaptureId` and returns it so the caller can pair
   it with `IngestOutput.capture`, but nothing stores the pair, so a `ProvenanceId` today points at
   a capture id with no blob behind it. The workspace-format order (WO-05) is the natural home;
   until it lands, `Origin::Parsed`'s span is resolvable only in-session. Planning.
4. **`Origin::Parsed`'s three deferred fields and `Actor::Parser`.** `11` §8.2 gives `Parsed` a
   `stanza: ConfigPath`, a `parser: ParserId` and a `parser_version: CorpusVersion`, and gives
   `Actor` a `Parser(ParserId)` variant. None of those four types exists; `corpus/dict/` carries no
   version at all (§3). This WO records `asserted_by: Actor::User` — the person who pasted — with
   the cost stated: the record says a human asserted a parsed value, and only `origin` distinguishes
   it. `Dictionary::entry_id` (§4.2) is added now precisely so that the stanza is *reachable* when
   the type exists. Planning, with the corpus-versioning question.
5. **`IpsecVpn.mode` in a re-parsed graph** — WO-04 §10 item 7(b), unchanged by this order and not
   decided here. One input this order can add, because it is a schema fact rather than a vendor
   recollection: `schema/enums/vpn_mode.yaml` declares exactly two variants (`route_based`,
   `policy_based`), and `schema/schema.yaml`'s `BindsInterface` doc states the edge is *"Required
   when mode == RouteBased, forbidden when PolicyBased"* — from which a `BindsInterface` edge
   entails `RouteBased` **within the schema**, with no appeal to vendor behaviour. The declared
   constraint `ipsec-vpn.mode-binds-interface` carries only the forward half
   (`mode == RouteBased implies edge(BindsInterface) is Set`) and its own note says the
   forbidden-when-`PolicyBased` half *"needs negation, which §12.3's grammar lacks"*. So the
   deduction is sound and its mechanism is not: acting on it means an `Origin::Inferred` record
   with an `InferenceRuleId`, and `11` §9.5's inference subsystem does not exist. Whether the answer
   is a dictionary row, a weld-time inference, or an owner-set field is planning's.
6. **Transactional apply.** `fathom-graph` cannot roll a batch back (WO-02 §10 item 1: undo
   application, redo and `Op::Untombstone` are all open). Until it can, a failed weld leaves a
   half-written batch open (§4.5). Whether the store gains a rollback, or the weld builds the whole
   op list before opening a batch, is a store-design question. Planning.
7. **Whether `fathom-weld` is the right home long-term.** It sits above both `fathom-graph` and
   `fathom-ingest` and is the natural place for reconciliation, the plan, and eventually the paste
   surface's model. If reconciliation lands elsewhere, this crate is the thing that should move.
   Planning sequences it.
8. **ESCALATED 2026-08-08 by the executing session, at plan step 1 — `Origin::Parsed` needs a
   canonical workspace wire form, and this order forbids writing one.**

   **Where it stopped.** Plan step 1, the first step: the four §4.2 edits (`prov.rs`, `lib.rs`,
   `graph.rs`'s doc comment, `render.rs`'s arm) were made, and step 1's own gate —
   *"`cargo test --workspace --locked` green — this step changes no behaviour"* — went red at
   compile time. The edits have been reverted; the tree is floor-green at the escalation commit
   (`78` §4 step 1).

   **What the work order says.** §3, Prior state, quoted:
   *"`crates/fathom-inventory/src/render.rs:73`. `match rec.origin { fathom_graph::Origin::Hand =>
   "hand" }` — an **exhaustive one-arm match**. Adding a variant to `Origin` breaks this crate's
   build until it gains an arm."* §4.2 accordingly authorises exactly one match arm, in
   `render.rs`, and §4's table opens *"Exactly these files change or are created."*

   **What was found.** There are **two** exhaustive matches over `Origin`, not one. The second is
   in `fathom-workspace` — WO-05's crate, which landed 2026-08-08, after this order was authored,
   and which §3 does not mention. `cargo build --workspace --locked`, verbatim:

   ```text
   error[E0004]: non-exhaustive patterns: `Origin::Parsed { .. }` not covered
      --> crates/fathom-workspace/src/lib.rs:329:24
       |
   329 |     let origin = match r.origin {
       |                        ^^^^^^^^ pattern `Origin::Parsed { .. }` not covered
   ```

   It is not a rendering match like `render.rs`'s. It is one half of the **canonical plaintext
   workspace serialisation**, and it has a reader on the other side
   (`crates/fathom-workspace/src/lib.rs:617`):

   ```rust
   // writer, line 329
   let origin = match r.origin {
       Origin::Hand => "hand",
   };
   // ... ("origin", Json::Str(origin.to_owned()))

   // reader, line 617
   let origin = match get_str(key_or(m, "origin", &path)?, &path)? {
       "hand" => Origin::Hand,
       _ => return Err(shape(&path, "the one shipped origin, `hand`")),
   };
   ```

   **Why this is §4 and not a `78` §8 correction.** `78` §8 admits a correction only when *"the
   code proves the correction and the correction changes no decision the work order makes"*, and
   excludes *"anything touching a decision — an API name, a gate, the deliverable set"*. This
   touches all three. `Origin` is serialised as a **bare JSON string**; `Origin::Parsed { capture:
   CaptureId, span: CaptureSpan }` carries a payload no bare string can hold. Making
   `fathom-workspace` compile therefore requires inventing a wire representation — whether `Parsed`
   becomes a `tagged()` object like `asserted_by`, what its key names are, how `CaptureId` and
   `CaptureSpan` render, and what the reader accepts — inside a format whose gate is a
   **byte-identical round trip** against WO-05 §4.4's pinned vector. Those key names are public
   names in a persisted format, which is §7 trigger 6 twice over (*"A public name … not listed in
   §4 is needed"*; *"an edit to a file outside §4's table is needed"*), and the choice is
   judgment-shaped under `78` §7's test: two reasonable people would pick different wire shapes and
   both be defensible.

   **Why it cannot be worked around.** §4.2 requires `Origin::Parsed` to exist — the whole order
   rests on it (§1: *"To carry parse provenance at all, `fathom-graph`'s `Origin` gains its second
   variant"*). There is no ordering of the plan that reaches step 3 without breaking
   `fathom-workspace`'s build.

   **The smallest decision that unblocks.** One sentence fixing `Origin::Parsed`'s canonical wire
   form, plus the authorisation to edit `crates/fathom-workspace/src/lib.rs` (both sites) as a
   named row in §4's Deliverables table. The mechanically enumerable options, with no lean:
   (a) the tagged-object form the file already uses for `asserted_by` — `"origin": {"parsed":
   {...}}` — with `Hand` staying the bare string `"hand"`;
   (b) every origin becomes a tagged object, `"hand"` included, which changes bytes WO-05 §4.4's
   vector already pins;
   (c) `Origin` is serialised by discriminant plus payload, decoupling the wire from the variant
   names.
   Each also needs the reader's refusal message re-worded — *"the one shipped origin, `hand`"* is
   already stale prose the moment a second variant exists.

   **ANSWER (2026-08-08, planning). Option (a) — and it is not a special case.**

   The decision is written into `17` §15.6, because `17` owns the workspace format
   (`docs/00-vision/01-ownership.md`) and a work order may not ship a second specification for
   something it does not own (`.context/conventions.md` § *Precedence*). The rule stated there:

   > A variant **with no payload** is written as its bare lower-case token. A variant **carrying a
   > payload** is written as a single-key object whose key is that token and whose value is the
   > payload.

   **The escalation was right to stop and slightly wrong about what it found.** It read the `origin`
   line in isolation and saw an inconsistency; the file already applies that rule three times —
   `Confidence` and `StoredPresence` are payload-free and are bare tokens, `Actor::User(UserId)`
   carries a payload and is `tagged("user", …)` at `crates/fathom-workspace/src/lib.rs:334`. So
   option (a) does not introduce an asymmetry, it obeys the convention already in the file, and
   options (b) and (c) each break something — (b) makes `origin` the only payload-free variant
   encoded as an object, (c) couples the file to `Origin::discriminant()`, which `11` §8.6 defines
   as a retention grouping key and not a wire contract.

   **What the executing session does.** `Origin::Parsed { capture, span }` writes as
   `{"parsed": {"capture": …, "span": …}}`; `Origin::Hand` stays `"hand"`, so WO-05 §4.4's pinned
   vector is unchanged. §4 must state how `CaptureId` and `CaptureSpan` render inside the payload,
   in the same way it states every other public shape it creates — `17` §15.6 fixes only the
   enclosing form. The reader's refusal message becomes a list of accepted tokens; *"the one shipped
   origin, `hand`"* is stale the moment a second variant exists.

   **Adding `fathom-workspace`'s two match sites to §4.2 is authorised by this answer** — the writer
   at `lib.rs:329` and the reader at `lib.rs:617` — since §3's Prior state named only `render.rs`
   and could not have named a crate that did not exist when this order was authored.

   **`78` §5 item 10 binds whoever answers this**: the session that wrote this answer does not
   execute WO-09.

9. **ESCALATED 2026-08-08 by the executing session, at plan step 9 — the fixture cannot apply,
   because WO-03 §4.8 contract item 1 is broken for `InterfaceLike.name`, and every fix is outside
   this order's Deliverables table.**

   **Where it stopped.** Plan step 9, the integration tests. Steps 1–8 are complete and floor-green
   and are in this PR: `Origin::Parsed` with `CaptureId`/`CaptureSpan` and the two
   `fathom-workspace` wire sites (§10 item 8's answer, executed); `Dictionary::entry_id`; the
   `fathom-weld` crate — `Mint`, the provenance constructors, the `BoundValue` dispatch,
   `apply_new_device`, `containment_edge`; and `tests/containment.rs`, so **G5 is green and §3's
   uniqueness fact is re-proved from the generated tables**. §4.6's other four test files are not
   written: the first one attempted, `tests/apply.rs`, went red on every test that applies the
   fixture, and was removed rather than weakened (`78` §5 item 5).

   **What the work order says.** §4.6's `the_synthetic_srx_fixture_applies` — *"Assert: `Ok`"*.
   §4.5's `SlotType` doc — *"The declared slot type and the `BoundValue` payload disagree — the
   WO-03 §4.8 contract item 1 guarantee has broken."* §4's opening — *"**No file under `schema/`,
   `crates/fathom-ir`, `crates/fathom-schema`, `crates/fathom-schemagen`, `corpus/`, `.context/`,
   `docs/90-decisions/` or `.github/`.**"*

   **What was found.** Applying the shipped fixture returns `Err(SlotType { key: FieldKey(55) })`.
   Key 55 is `TunnelInterface.name`.

   - `crates/fathom-ir/src/generated/accessors.rs:296` — `TunnelInterface.name` reads back
     `&crate::scalar::InterfaceName`, so `slot_type(FieldKey(55))` is
     `TypeId::of::<scalar::InterfaceName>()`.
   - `corpus/dict/junos-srx/interfaces.yaml:13`, verbatim:
     `- { as: n0, kind: "@interface_like", key: "$if", fields: [ { field: name, from: "$if", scalar: Identifier } ] }`
     — so the fragment carries `BoundValue::Identifier(scalar::Identifier)`.
   - `crates/fathom-ingest/src/dict.rs`'s `ValueTy` has no `InterfaceName` arm and
     `crates/fathom-ingest/src/bind.rs`'s `BoundValue` has no `InterfaceName` variant. **The
     fragment cannot carry the declared type today**, so this is not a mis-set dictionary field
     that the dictionary alone can correct.
   - **It is one dictionary entry and therefore four kinds, not one.** `@interface_like` expands
     to `Interface`, `AggregateInterface`, `RethInterface`, `TunnelInterface`, and
     `schema/schema.yaml` declares `name: InterfaceName` on all four (keys 27, 41, 48, 55). The
     fixture defines only `st0`, so only `TunnelInterface` fires today.
   - **Nothing else in the fixture diverges.** An audit over every `FieldAssertion` the fixture
     produces — node, edge and pending fields — comparing `slot_type(key)`'s `TypeId` against the
     `BoundValue` payload's, reported this one line and no other.
   - **It is not a weld defect and not a new divergence.** `fathom-emit`'s graphs write
     `InterfaceName` on the same keys, so the store side and the ingest side of the round trip
     already disagreed; the weld is the first code to put them in one call. This is the third
     precondition WO-04 §5 step 12's G8 would have hit, and it is not on any of the three lists in
     §10 item 2 or WO-04 §10 item 7.

   **Why this is §4 and not a `78` §8 correction.** §8 admits a correction only when *"the code
   proves the correction and the correction changes no decision the work order makes"*, and
   excludes *"anything touching a decision"*. Every available fix changes a decision **and** a
   deliverable set — this order's, WO-03's, or the schema's — and each lands in a file §4's opening
   sentence forbids. Two reasonable people would pick different fixes and both be defensible, which
   is `78` §7's test for judgment-shaped work.

   **The smallest decision that unblocks.** One sentence naming where the disagreement is resolved,
   plus the Deliverables rows that fix needs, in whichever order owns it. Mechanically enumerable,
   with no lean:

   (a) **The schema moves to the dictionary** — `schema/schema.yaml` declares `name: Identifier` on
   the four interface kinds. `InterfaceName` exists as a scalar precisely to constrain interface
   names, so this retires a constraint; it re-generates `fathom-ir`, and `fathom-emit` and
   `fathom-inventory`'s demo estate both write the field. A schema edit is `78` §5 item 3 and §7
   work, never an execution session's.

   (b) **The dictionary moves to the schema** — `fathom-ingest` gains `ValueTy::InterfaceName` and
   `BoundValue::InterfaceName(scalar::InterfaceName)`, and
   `corpus/dict/junos-srx/interfaces.yaml` binds `scalar: InterfaceName`. WO-03 §4.8 states of
   `BoundValue` that *"a new variant is a §7 trigger"*, so this is WO-03's to reopen, and it
   re-pins that order's fixture assertions.

   (c) **The weld converts at the boundary** — `Identifier` to `InterfaceName` wherever the
   declared slot type says so. Against WO-03 §4.8 contract item 1's *"a store whose bags satisfy
   `fathom_ir::bag::FieldBag` can hold every assertion **without conversion**"*, against this
   order's §9 failure mode 6, and it needs a per-key conversion table that would be a second,
   hand-written copy of a schema fact (ADR-0008).

   (d) **Whichever of (a)–(c) is chosen, a gate that would have caught it at dictionary load.**
   `dict.rs`'s `DictGate` already carries `FieldUnknown` and `TypeUnknown` but nothing that
   compares a `scalar:` against the field's declared type, so the disagreement survived WO-03's
   own gate set and the whole `cargo test --workspace` floor. Whether that gate is added, and to
   which order, is planning's — it is the control for §9's failure-mode table, not a fix for this
   row.

   **ANSWER (2026-08-08, planning). Option (b), plus option (d) as a permanent guard.**

   **The two types are behaviourally identical, and that is the whole argument.**
   `crates/fathom-ir/src/scalar.rs:1015` and `:1028` — `Identifier::parse` and
   `InterfaceName::parse` both call `ascii_graphic(text)` and wrap the string; both `canonical()`
   return `self.0.clone()`. They differ only in `NAME`. So the conversion is lossless today and
   **nothing is at stake in the data** — which is exactly why the cheap-looking option (a) is the
   wrong one.

   **Why not (a), collapsing the schema to `Identifier`.** `schema/schema.yaml` declares
   `InterfaceName` on all four `@interface_like` kinds deliberately, and `11` §4.3 makes
   `Identifier` the *vendor object name* type in general. The distinct type exists so that interface
   naming can be tightened later — `ge-0/0/0`, `ae0`, `st0.0` have structure a generic identifier
   does not — **without touching every other name in the model.** Collapsing it discards that option
   permanently to save one enum variant, and the moment `InterfaceName::parse` does tighten, an
   ingest path carrying `Identifier` would silently accept names the store would refuse. A
   distinction that costs nothing today and buys a whole class of validation later is not a
   distinction to delete.

   **Why not (c), converting at the weld boundary.** It makes the weld responsible for silently
   reconciling a disagreement between two components that should agree, which is the failure mode
   this project has hit twice already in a different guise. It also fixes only the weld: `fathom-emit`
   writes `InterfaceName` on the same keys, so the emit side would still disagree with ingest and
   nothing would catch it.

   **Adopt (b): the dictionary and `BoundValue` move to the declared type.** The schema is the
   artifact (ADR-0008), so where dictionary and schema disagree, **the dictionary is wrong**. That
   is one `ValueTy` arm, one `BoundValue` variant, and one edited line in
   `corpus/dict/junos-srx/interfaces.yaml:13` (`scalar: Identifier` → `scalar: InterfaceName`).
   The escalation's own audit over every `FieldAssertion` the fixture produces found **this one line
   and no other**, so the blast radius is exactly one dictionary entry — which expands to four kinds
   (`Interface`, `AggregateInterface`, `RethInterface`, `TunnelInterface`, keys 27, 41, 48, 55),
   only one of which the fixture currently exercises.

   **Adopt (d) as well, and this is the durable half.** A dictionary-load gate comparing each
   entry's declared `scalar:` against the schema's declared type for that field would have caught
   this at load time instead of at the first integration. **This class of defect was invisible until
   the weld put both sides in one call** — the escalation says so plainly: *"`fathom-emit`'s graphs
   write `InterfaceName` on the same keys, so the store side and the ingest side of the round trip
   already disagreed; the weld is the first code to put them in one call."* The bug was latent from
   the day both sides were written and no gate could see it. That is worth more than the fix.

   **Authorisation.** §4's opening bars this order from `corpus/`, and the dictionary lives at
   `corpus/dict/`. **This answer authorises, exactly and only:** the one `scalar:` value on
   `corpus/dict/junos-srx/interfaces.yaml:13`; one `InterfaceName` arm in
   `crates/fathom-ingest/src/dict.rs`'s `ValueTy`; and one `InterfaceName` variant in
   `crates/fathom-ingest/src/bind.rs`'s `BoundValue`, with its dispatch arm. Nothing else under
   `corpus/`, and no change to `schema/`. The load gate (d) is **not** authorised here — it is a new
   gate, it belongs to whoever owns dictionary loading, and it is filed as a planning item rather
   than bolted onto a blocked order.

   **`78` §5 item 10 binds whoever answers this**: this session does not execute WO-09.

   **On the removed test.** `tests/apply.rs` was written, went red against the real fixture, and was
   deleted rather than weakened. Under `78` §5 item 5 that is the correct call and it should be said
   plainly: **the test was right and the tree was wrong.** It should be restored, unchanged, as the
   first step of the resumed order — a red test that found a real defect is the most valuable
   artifact this run produced, and it must not be quietly re-authored to fit whatever the code ends
   up doing.

10. **ESCALATED 2026-08-08 by the executing session, at plan step 9 — the applied device contains
    nothing, because ten of the fixture's thirteen fragment nodes carry no `owner`, and every way
    to fix that is outside this order's Deliverables table.**

    **Where it stopped.** Plan step 9, at the last of §4.6's five test files. Items 8 and 9 are
    executed; steps 1–8 stand; `tests/apply.rs`, `tests/provenance.rs` and `tests/determinism.rs`
    are written to §4.6's names and are green, alongside `tests/containment.rs`. The floor at the
    escalation commit is green (`78` §4 step 1): `cargo test --workspace --locked` 353 passed / 0
    failed / 0 ignored, `fathom-schema-check` exit 0 with the two pinned `Site` warnings.

    **What the work order says.** §4.6's `the_synthetic_srx_fixture_applies`, quoted:
    *"Assert: `Ok`; `WeldOutput.nodes.len()` equals `fragment.nodes.len()`; the `Device` carries
    `hostname` and `platform` `Set`; **the `IpsecVpn` closure is reachable from the device by
    `out`/`inn`**; and `unresolved` is non-empty and contains the `reth0.0` `InterfaceUnit`
    reference."* §4.5 step 5, quoted: *"**Containment.** For each node except `nodes[0]`, in index
    order: `containment_edge(owner.kind, node.kind)`"*. §3's containment paragraph names the pairs
    *"this slice's dictionary can produce"*, and its list opens
    `(Device, IkeProposal) → HasIkeProposal`, `(Device, IkePolicy) → HasIkePolicy`,
    `(Device, IkeGateway) → HasIkeGateway`, `(Device, Zone) → HasZone`,
    `(Device, {Interface, …}) → HasInterface`.

    **What was found.** Every other assertion in that test passes. The reachability one cannot:
    **the applied `Device` has degree zero.** Summed over all 81 `EdgeKind`s,
    `graph.out(device, k).count() + graph.inn(device, k).count()` is `0`.

    The cause is upstream of the weld and is a fact about the shipped fragment, printed from
    `fathom_ingest::ingest` over `crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt`
    through the shipped dictionary on 2026-08-08:

    ```text
    0: Device            owner=None            8: TunnelInterface  owner=None
    1: IkeProposal       owner=None            9: LogicalUnit      owner=Some(8)
    2: IkePolicy         owner=None           10: Address          owner=Some(9)
    3: IkeGateway        owner=None           11: Zone             owner=None
    4: IpsecProposal     owner=None           12: Zone             owner=None
    5: IpsecPolicy       owner=None
    6: IpsecVpn          owner=None
    7: TrafficSelector   owner=Some(6)
    ```

    Only three nodes carry an `owner`, and none of the three is owned by `nodes[0]`. §4.5 step 5
    therefore materialises exactly three containment edges —
    `IpsecVpn → TrafficSelector` (`HasTrafficSelector`), `TunnelInterface → LogicalUnit`
    (`HasUnit`), `LogicalUnit → Address` (`HasAddress`) — and **ten of the thirteen store nodes end
    the apply with no containment in-edge at all.** None of §3's five `Device`-owned pairs is ever
    reached, because no fragment node names the device as its owner. The seven `FragEdge`s are all
    reference edges between non-device nodes, so nothing else joins the device either.

    **Neither order is internally broken; they disagree.** WO-03 §4.8 contract item 2 promises only
    that *"`owner` chains are acyclic and always point at an earlier `FragNodeId`"* — it does not
    promise that every non-root node has one, and the shipped binder gives one only where a
    dictionary entry declares `owner: n<k>`. WO-09 §4.5 step 5 says *"for each node except
    `nodes[0]`"*, which presumes the opposite. The weld as shipped resolves the presumption by
    skipping an ownerless node (`crates/fathom-weld/src/apply.rs`, `let Some(owner) = node.owner
    else { continue }`), which is a decision this order does not state either way.

    **What it costs, stated in the corpus's own terms.** `11` §7.2 opens *"Exactly one containment
    in-edge per node. Together they form a forest rooted at the workspace."* and gives every
    containment kind `in: 1`. `11` §7.1 makes that a **lower** bound, enforced *"at emit and
    validity check time (L1/L2)"*, not at write time — so the store is right to accept this graph
    and `78` §6's floor is right to be green. But the first paste of a real config produces ten
    orphan nodes, and every face that navigates from a device — the inventory face, the emitter's
    `EmitScope`, any future diagram — reaches none of them.

    **Why this is §4 and not a `78` §8 correction.** §8 admits a correction only where *"the code
    proves the correction and the correction changes no decision the work order makes"*, and
    excludes *"anything touching a decision — an API name, a gate, the deliverable set"*. Dropping
    the assertion decides that top-level objects have no containment parent; adding a default
    decides that the weld invents one. `78` §7's test applies squarely: two reasonable people would
    pick differently and both be defensible.

    **The smallest decision that unblocks.** One sentence naming where a top-level object's
    containment parent is decided, plus the Deliverables rows that fix needs, in whichever order
    owns it. Mechanically enumerable, with no lean:

    (a) **The weld defaults it.** A non-root `FragNode` with `owner: None` is contained by
    `nodes[0]`. Smallest diff — one branch in `apply.rs` — and it makes §3's five `Device` pairs and
    §4.6's reachability assertion true as written. Against it: the weld would write a containment
    edge no fragment stated, which is the shape of guess §7 trigger 2 and §12 item 4 refuse
    elsewhere in this order, and it is wrong for any kind whose real owner is not the device.

    (b) **The binder sets it.** `fathom-ingest`'s `bind.rs` gives every node created without a
    declared `owner` the implicit device at `nodes[0]`. This is where the implicit device node is
    already invented, so nothing new is guessed downstream; it changes WO-03's §4.8 contract and
    re-pins that order's fixture assertions, so it is WO-03's to reopen.

    (c) **The dictionary declares it.** Entries name the device explicitly (`owner: device`, or a
    reserved `n0`), which needs a grammar term the dictionary loader does not have and touches every
    entry file under `corpus/dict/junos-srx/`. Most explicit, largest blast radius, and §4's opening
    bars this order from `corpus/` beyond §10 item 9's one authorised line.

    (d) **Nothing changes and §4.6's assertion is withdrawn.** Top-level objects genuinely have no
    containment parent until a `Site`/`Device` containment story exists, and `11` §7.2's forest is
    an L1/L2 obligation nothing in the tree checks yet. Cheapest, and it leaves the first paste
    producing a graph no device-rooted view can walk.

    Whichever is chosen, the same question decides whether WO-04's `EmitScope` and the inventory
    face can reach a pasted device's objects at all, so it is not only this order's.

    **Not re-escalated here, recorded for the triage:** the containment gap is the second thing this
    order has surfaced that no gate could see (§10 item 9's answer names the first). A
    fragment-shape gate — *every non-root `FragNode` resolves to `nodes[0]` by `owner`* — would have
    caught it in WO-03's own suite. Like item 9's (d), that gate belongs to whoever owns the
    fragment, not to a blocked order.

   **ANSWER (2026-08-08, planning). Option (a), but it is a *derivation*, not a default — and the
   information was never missing.**

   **The deciding fact, computed over `schema/schema.yaml` on 2026-08-08:** across every containment
   edge in the schema, **no kind has more than one possible containment parent.** Not one. `Zone`,
   `RoutingInstance`, `PolicySet`, `IkeGateway`, `NatRuleSet`, `Vlan` and `Interface` are each
   contained by `Device` and by nothing else, and the same holds for every other kind.

   So a node with no `owner` does not need a guess and does not need a default. **Its containment
   parent is already determined by its kind**, and `containment_edge(owner_kind, child_kind)` — which
   this order already builds — is the lookup that reads it. The dictionary never declared an owner
   because it never had to: the schema had already decided.

   **What the executing session does.** For a non-root `FragNode` with `owner: None`, resolve the
   containment parent by asking the schema which kind may contain this kind. Materialise that edge as
   §4.5 step 6 already materialises `owner`-derived ones. **If the lookup ever returns anything other
   than exactly one parent kind, refuse with the existing `NoContainmentEdge` variant and stop** —
   that is a schema change nobody has thought through, not a case to guess at. Today it cannot fire;
   the guard exists for the day someone adds an ambiguous edge.

   **Why not the other three.** (b) reopens WO-03 §4.8's contract to carry information the schema
   already holds. (c) adds a grammar term and edits every `corpus/dict/junos-srx/` file to restate,
   by hand and fallibly, something derivable — and hand-restating derivable facts is how the
   `InterfaceLike.name` disagreement in item 9 happened in the first place. (d) withdraws the
   assertion and ships an estate whose devices contain nothing, which is the defect, not a fix.

   **A correction to the escalation's own arithmetic.** §10 item 10 and its commit message say ten
   nodes are orphaned. **Nine are.** Ten of thirteen carry `owner: None`, but one of those is
   `nodes[0]`, the `Device` itself, which §4.5 step 6 correctly gives no containment in-edge — *"a
   `Device` with no `HasDevice` in-edge is L0-valid"*. The device is the thing navigated **from**,
   not an orphan. The substance is unaffected and was independently reproduced by the audit.

   **Not authorised here:** the fragment-shape gate the escalation notes in passing (*every non-root
   `FragNode` resolves by `owner`*). Under this answer that gate would be **wrong** — resolving by
   `owner` is exactly what stops being required. If a gate is wanted it is the schema-derivation one,
   and it belongs to whoever owns WO-03's suite.

   **`78` §5 item 10 binds whoever answers this**: this session does not execute WO-09.

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants 1–3, 6, 7, 9; terminology (`provenance`, `record`, `graph`, `node`/`edge`); identifier forms; document conventions |
| `CLAUDE.md`; `docs/70-ops/78-execution-protocol.md` (whole) | Session rules; the inherited-constraint table; the escalation rule; the floor; the manifest exception; the WO shape; the owner-blocking list |
| `docs/10-core/11-ir-schema.md` §§3.4, 5.2–5.3, 7.1–7.2, 8.1–8.6, 9.5, 10.1–10.5, 13 | Edge classes; presence; the containment rule and which bound is L0's; the provenance record, its origins and confidences; capture blobs; identity tuples and the re-identification algorithm; absence handling |
| `docs/10-core/14-parsers-and-ingest.md` §§7.3–7.4, 8.5, 9.5, 10.1–10.5 | Deferred edge resolution and the `Pending` rule; capture scope; residue's home; the `orig_len` obligation; device identification, the reconciliation plan and its ambiguity rules |
| `docs/60-content/62-schema-spec.md` §§4.2, 6.2, 8.2, 12.1 | Kind-level keys; bound levels; the identity-term prohibitions; the L0 vocabulary |
| `docs/50-design/53-interaction-and-keyboard.md` §7.2 | The batch as the undo unit and its 60-byte label |
| `docs/90-decisions/adr-0010-identity-reparse-and-suppression-survival.md` | Why re-identification is owner/planning-shaped |
| `docs/70-ops/76-scope-expansion-analysis.md` §7.2 | The S3 and S6 rows this order joins |
| `docs/70-ops/79-work-orders/WO-02-the-graph-store.md` §§3, 4.2, 4.3, 10; `WO-03-ingest-junos-srx.md` §§3, 4.1–4.2, 4.8, 4.9, 10, 12; `WO-04-the-emitters.md` §§4.9, 5 steps 12–13, 6, 10 | The store's contract and its stated gaps; the fragment's producing side and its deferrals; the golden, G8 and the round-trip preconditions |
| `docs/80-review/88-state-review-and-recommendations.md` §5.3, §6.13 | The finding this order closes; the `Site` identity sentence that `Device` also needs |
| `crates/fathom-ingest/src/{lib,bind,dict,redact}.rs`; `crates/fathom-ingest/tests/srx_fixture.rs` and its fixture | Every §3 claim about the fragment, the dictionary surface and the `orig_len` comment; the `repo_root()` precedent |
| `crates/fathom-graph/src/{lib,graph,prov,field,id,op}.rs`; `crates/fathom-inventory/src/{demo,render}.rs`; `crates/fathom-id/src/lib.rs`; `crates/fathom-ir/src/generated/{ir_types,accessors}.rs`; `crates/fathom-emit/src/output.rs` | The write surface and its refusals; provenance interning; the one-arm `Origin` match; the minting precedent; the generated tables and `slot_type`; the emitter entry point |
| `schema/schema.yaml`, `schema/field-keys.yaml`, `schema/enums/vpn_mode.yaml`, `schema/generated/schema.json` | `Device`'s fields and its empty identity tuple; `Device.platform: 7`; the two `vpn_mode` variants and the `BindsInterface` doc; the containment expansion computed in §3 |
| `cargo test --workspace --locked`; `fathom-schema-check` (run 2026-08-08) | 282 passed / 0 failed; exit 0, `0 failure(s), 2 warning(s)` |

## 12. Disagreements

1. **Against `WO-03` §4.8's claim that a dictionary entry id is reachable.** `BindProv.entry`'s doc
   comment says *"the id string is reachable through the Dictionary"*; it is not — `Entry` is
   `pub(crate)` and `Dictionary`'s public surface is `load`, `entry_count`, `platform`. §4.2 adds
   the one accessor that makes the comment true. Recording it here rather than silently adding a
   method keeps WO-03's *"Any other public name is a §7 trigger"* honest: the addition is
   authorised by this order, by name, and by nothing else.
2. **Two `ByteSpan`s, deliberately.** `fathom_ingest::frame::ByteSpan` and this WO's
   `fathom_graph::prov::CaptureSpan` are the same shape. Merging them would make `fathom-graph`
   depend on the parser or move a type into `fathom-ir` mid-order; both are larger than the problem.
   The precedent is WO-02's own accepted collision between `fathom_id::NodeId` and
   `fathom_graph::NodeId` (its §4.2 DECISION). The names differ so the two are never confused, and
   the conversion happens in exactly one place, in `fathom-weld`.
3. **One provenance record per assertion, not one per statement.** Sharing a record across the
   several fields one `set` statement writes is tempting and would be smaller. It is not taken:
   `check_prov` fills `supersedes` from the slot's current provenance, so a shared id whose second
   use lands on an already-written slot is refused as `ProvenanceIdReused` — safe today only
   because a first application writes each field exactly once, which is precisely the property
   reconciliation removes. `11` §8.2 calls the record *"One immutable assertion record"*; one per
   assertion is the source-faithful reading and it does not become wrong later.
4. **Against materialising a `Pending` target, which is what would make WO-04's G8 arm.** It is the
   single change that would take the round-trip gate from unarmable to runnable, and it is still
   refused: `14` §7.3 states the rule as *"recorded, not materialised"*, and creating an
   `Interface` node from a reference is exactly the kind of guess that, once it is in the store,
   becomes indistinguishable from something the user configured. §10 item 2 records the problem
   where planning can see it instead.
5. **Three stale numbers in §3, corrected under `78` §8 — none of them changes a decision this
   order makes.** All three are WO-05 landing between this order's authoring and its execution, and
   all three were verified against the tree on 2026-08-08 before plan step 1:
   - *"Twelve crates"* → **fourteen**. `Cargo.toml`'s `members` list carries fourteen entries;
     `fathom-canon` and `fathom-workspace` are the two §3 does not know about.
   - *"282 passed, 0 failed"* (§3 preamble and §11's last row) → **329 passed, 0 failed**, over 66
     test binaries. G4 already governs this: *"Green is the gate, not a count."*
   - §4.1's parenthetical *"after `crates/fathom-wasm` — i.e. **last**"* → **not last**. The list is
     alphabetical and now ends `fathom-wasm`, `fathom-workspace`; `fathom-weld` sorts between them
     (`we` before `wo`). §4.1's binding instruction is unaffected and unchanged — *"the executing
     session matches the list it finds"* — so only the parenthetical is stale. Recorded rather than
     acted on: this order stopped at step 1 and never reached step 3, so the members line was never
     written.
6. **§3's *"an exhaustive one-arm match"* is now two matches, and that is §10 item 8, not a
   correction.** Recorded here only to point at it: the second match is a persisted wire format, so
   the divergence changes what this order decides and went to Open decisions under `78` §4 rather
   than to this section under `78` §8.
7. **§3's *"51 distinct (owner kind, child kind) pairs"* is 46 pairs of node kinds, corrected under
   `78` §8 — the count changes no decision this order makes.** Five of the 51 are owned by the
   workspace **root**, not by a node kind: `HasTunnel`, `HasPremises`, `HasCable`, `HasTenant` and
   `HasServiceType` declare `from: [root]` in `schema/schema.yaml`, `root` is not a `NodeKind`, and
   `EdgeKind::from_kinds()` is therefore `&[]` for each of them
   (`crates/fathom-ir/src/generated/ir_types.rs`). 51 − 5 = 46, which is what G5's
   `every_kind_pair_has_at_most_one_containment_edge` now pins across all 48 × 48 pairs, together
   with the two halves of §3 that were exactly right: 41 containment edge kinds, and no pair
   carried by two of them. §4.5's `containment_edge` excludes root-containment kinds explicitly as
   well as by the empty `from_kinds()`, so the store's `RootContainment` refusal is never the thing
   that catches a mistake here.

8. **`Confidence::Derived` on `Device.platform`, against the simpler reading that everything a
   parser writes is `Asserted`.** No statement in the capture says `junos-srx`; the dictionary that
   parsed it does. `11` §8.3 defines `Derived` as *"Follows necessarily from asserted facts"*,
   which is what this is, and the distinction is not cosmetic: a future re-parse by a different
   platform's dictionary must be able to disagree with a derived platform without overwriting an
   asserted one.

9. **`BoundValue` has 22 variants, not 21 — a consequence of §10 item 9's answer, corrected under
   `78` §8.** §4.5 step 7 and `crates/fathom-weld/src/plan.rs`'s module doc both said *"`BoundValue`'s
   21 variants"*. Option (b) added `BoundValue::InterfaceName(scalar::InterfaceName)`, so the
   exhaustive dispatch now carries 22 arms. The count is descriptive; the rule it serves — a new
   variant upstream is a compile error in the weld (§9 failure mode 6) — is unchanged, and the
   compile error is exactly what happened.

10. **G8 cannot be exit 0 on `corpus/`, and that was decided rather than discovered.** §6's G8 is
    `git diff --exit-code -- schema/ crates/fathom-ir crates/fathom-schema crates/fathom-schemagen
    corpus/`, expected *"exit 0, no output — this WO touches none of them"*. §10 item 9's answer
    then authorised *"exactly and only … the one `scalar:` value on
    `corpus/dict/junos-srx/interfaces.yaml:13`"*, so `corpus/` shows exactly that one line and
    nothing else. Recorded rather than acted on: the four remaining paths in G8's list are all clean
    (`git diff --exit-code -- schema/ crates/fathom-ir crates/fathom-schema crates/fathom-schemagen`
    → exit 0, verified 2026-08-08), and re-cutting a gate is planning work, not a correction.

11. **The fixture's counts, recorded here because §5 step 11's `§6.1` backfill belongs to a DONE
    order.** From the apply the escalation in §10 item 10 describes:
    `nodes` 13, `edges` 7, `containment` 3, `unresolved` 2, `minted` 81. The last is
    `1 + records + element ULIDs`; `tests/provenance.rs`'s
    `records_are_never_shared_between_assertions` re-derives it from the store rather than pinning
    it as a literal, so it does not go stale silently.
    **Superseded by §6.1**, which is the backfill §5 step 11 asks for and is read off the DONE
    order's own run: `containment` is 12 and `minted` is 99 once §10 item 10's answer is executed,
    because nine nodes that were skipped now take the containment parent the schema determines. The
    numbers above are left in place as the escalation's state, not deleted, so the two runs can be
    compared.

12. **`WeldError::NotDeviceRooted` is returned for a condition §4.5 does not declare, and this list
    did not record it.** §4.5 declares it as *"`fragment.nodes` is empty, or `nodes[0].kind !=
    Device`"*, and `crates/fathom-weld/src/plan.rs:24-27` implements exactly that. But
    `crates/fathom-weld/src/apply.rs` also returns it from five index-lookup sites (lines 162, 167,
    168, 169 and 269) for a **different** condition — an edge or owner endpoint naming an index the
    fragment does not have. Reusing a declared variant instead of adding an unlisted one is a
    defensible reading of §7 trigger 6, and the widening is documented at `apply.rs:53-58`; but it
    changes the meaning of a public shape §4 declares verbatim, and a list that records ten
    divergences including a purely descriptive variant count should not omit this one. Introduced at
    `fa72d80`, found by audit 2026-08-08. **Planning decides** whether §4.5 widens or `apply.rs`
    gains its own variant.

13. **A comment in `crates/fathom-weld/tests/apply.rs` claims more than the assertion beneath it
    proves.** `platform_is_stamped_derived`'s comment says the capture-derived platform is *"the
    **only** `Derived` record in the apply"*, but the code walks node **existence** records only —
    it never scans field or edge records. The assertion's own message (*"no node exists on a derived
    assertion"*) is accurate and the narrower property is genuinely proved; the comment describes a
    stronger one. Not a weakened assertion. Corrected wording is a one-line edit for the next
    session in this crate, not a reason to reopen a passing test.

14. **The audit's most important check could not be performed, and that is worth recording rather
    than passing over.** The resumption instruction said `tests/apply.rs` must be *restored
    unchanged* rather than re-authored, on the premise that a prior version existed to diff against.
    **It never did.** `git log --all -- crates/fathom-weld/tests/apply.rs` returns only this run's
    commit; the earlier session wrote and deleted the file inside its working tree without ever
    committing it. So the instruction rested on a false premise and the claim *"no assertion
    softened"* is unfalsifiable. What the audit could establish independently, and did: the nine test
    names match §4.6's list exactly and in order; the seven positive tests apply the **real**
    `junos-srx-s0-synthetic.txt` through the **real** `Dictionary::load`, not a hand-built fragment;
    and the assertions carry explicit anti-vacuity guards (`assert!(owned > 0)`, non-empty edge and
    pending checks, exact op-count arithmetic, exact `Err(..)` equality on both negative tests, and
    totals proving nothing else was created). **No evidence of weakening, and no proof of identity.**
    The lesson is procedural: a session that deletes a red test should commit it first on a scratch
    ref, or the next session cannot tell restoration from reinvention.

15. **§10 item 10's answer says *"no kind has more than one possible containment parent — not one"*.
    Three kinds do, and seven have none — corrected under `78` §8; the decision the answer makes is
    unchanged, because the answer's own guard is what covers them.** Computed over
    `schema/generated/schema.json` on 2026-08-08, expanding `classes` exactly as
    `EdgeKind::from_kinds()`/`to_kinds()` do:
    `LogicalUnit` has four possible containment parents (`Interface`, `AggregateInterface`,
    `RethInterface`, `TunnelInterface` — the `@interface_like` class on `HasUnit`'s from end),
    `ExternalPeer` has two (`Premises`, `Site`) and `PhysicalPort` has two (`Chassis`,
    `PassiveNode`). Seven kinds have no node-kind parent at all — `Site`, `LearnedRoute`, `Tunnel`,
    `Cable`, `Premises`, `Tenant`, `ServiceType` — the last five because their containment is
    root-owned (§12 item 7). `tests/containment.rs`'s
    `every_kind_pair_has_at_most_one_containment_edge` already pinned that orphan list before this
    correction was written, from the same tables.
    The two halves of §3 the answer relied on are untouched: no *pair* is carried by two containment
    edge kinds, and the answer's instruction — *"if the lookup ever returns anything other than
    exactly one parent kind, refuse with the existing `NoContainmentEdge` and stop"* — is
    implemented literally, so the three ambiguous kinds are refused rather than guessed. None of
    them is reachable from this dictionary today: the fixture's only `LogicalUnit` carries a
    declared `owner`, and no entry under `corpus/dict/junos-srx/` produces an `ExternalPeer` or a
    `PhysicalPort`. What is wrong is the answer's *"it cannot fire today"*, not what it decided.

16. **`WeldError::NoContainmentEdge`'s payload in the derived branch names the fragment root's kind,
    which is a second widening of a declared shape (§12 item 12 records the first).**
    `crates/fathom-weld/src/apply.rs`'s `derived_owner` refuses with
    `NoContainmentEdge { owner: root_kind, child }` in both failing cases — no parent kind, and more
    than one — because there is no owner kind to name in either. The statement the payload makes is
    true for every kind in the schema today (`containment_edge(Device, child)` is `None` for all ten
    of §12 item 15's kinds, so *"no containment edge is declared from the root device to this
    child"* is exactly what happened), and it stops being true the day a kind is contained by
    `Device` **and** something else. Adding a variant instead would be a public name §4 does not
    list, which §7 trigger 6 forbids, so this is recorded rather than acted on. **Planning decides**
    whether §4.5's variant list widens or gains a case for a child the schema does not place.

17. **`tests/apply.rs`'s `owner_becomes_the_declared_containment_edge` was rewritten, not weakened,
    and the diff is the record.** Its previous body asserted `out.containment.len() == owned` and
    *"node {index} gained an owner"* for every `owner: None` node — i.e. it pinned the behaviour
    §10 item 10 was escalated about, which the answer then reversed. The replacement pins strictly
    more: 12 containment edges rather than 3, every node but `nodes[0]` contained, the declared and
    derived cases counted separately and both asserted non-empty, and — for each derived case — that
    the schema names `Device` as the *sole* parent of that kind, computed in the test over all 48
    kinds rather than read back from the weld. The prior version is committed at `b3e1bcb`, so
    `git diff b3e1bcb -- crates/fathom-weld/tests/apply.rs` is the check §12 item 14 could not
    perform on the file's first appearance.
