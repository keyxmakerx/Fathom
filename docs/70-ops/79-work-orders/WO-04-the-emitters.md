# WO-04 — `fathom-emit`: graph to junos-srx commands with provenance

> **Status:** BLOCKED on the fragment-to-store weld order, which does not exist (G8, the round-trip
> gate, cannot arm; all other gates green). WO-03 was the other half of this block and completed
> 2026-08-08 — corrected here under `78` §8 as a factual correction, not a re-scope.

The reverse face of ingest — from graph state to copy-pasteable configuration lines, each line
carrying the provenance that produced it. This is the notepad's engine: `53` §6's copy machinery
is specified against `EmittedLine.text`, and this work order is where `EmittedLine` first exists
in code.

Depends on: **WO-01** (the `Scalar` trait — `canonical()`, `SecretLabel`,
`SecretPlaceholder::placeholder()`) and **WO-02** (`fathom-graph` — the store this reads), both
DONE before this work order is taken. §6 G8, the flagship round-trip, additionally needs
**WO-03** (junos-srx ingest — on disk, BLOCKED on WO-01/WO-02 at revision time) **and** the
fragment-to-store weld work order WO-03 §4.8 defers (*"constructing the store's provenance
records, minting node ULIDs (`fathom-id` from caller-supplied parts only), and reconciliation
are the weld WO's work"*) — a work order that does not exist yet. G8 gates nothing else in this
document; §5 steps 12–13 state the machine-followable rule for finishing every other gate first,
and §10 item 7 holds the round-trip preconditions planning must resolve before step 13 can run.

Execution protocol: `docs/70-ops/78-execution-protocol.md` governs this work order. Every
constraint in `78` §2 is inherited and not restated — invariants 1–3 and 9, ADR-0008, zero
external dependencies (the root manifest's own comment: *"That is a position, not an accident"*),
the 1.94.1 toolchain pin, `#![forbid(unsafe_code)]`, the three-value risk enum with reserved
colours (ADR-0011), severity labels exactly BLOCKER / MAJOR / MINOR, house style. `78` §4's
escalation rule applies to every trigger in §7 below.

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

When this work order is DONE, `crates/fathom-emit` exists and is green under the workspace floor:
given a `fathom-graph` store and an `IpsecVpn` emit unit (`11` §9.2), it produces the ordered
sequence of junos-srx `set` statements the field card's side 1 teaches — one logical line per
statement, every line carrying its provenance (invariant 6: *"Emitters return `(line,
provenance)` pairs, never strings."*), its risk band, its idempotency class and its explain key —
together with an `EmitReport` no caller can take the lines without: blockers for every required
field the graph cannot answer, a gap ledger for every field this emitter does not yet express, a
substitution manifest for every credential placeholder, and conflicts for any duplicated
statement path. Emission is deterministic to the byte (invariant 9): same graph, same build,
byte-identical output, proven by tests that build the same graph in two insertion orders. The
covered kinds are exactly the six-object chain plus `TrafficSelector`; everything else the seven
kinds declare and this crate does not emit is a named entry in the gap ledger, never a silent
drop (`13` §9: *"Representability, and never dropping silently"*). The crate-side half of gate
`schema.emit.unread` (`62` §10.3) becomes checkable for these seven kinds, by a coverage test
that reads `schema/` back and refuses any field that is neither read nor gapped.

## 2. Binding sources

| Source | What it binds | The line that binds |
|---|---|---|
| `.context/conventions.md` invariant 6 | The output shape | *"Emitters return `(line, provenance)` pairs, never strings."* |
| `13` §1 | What an emitter is | *"An **emitter** is a total function from a graph subset plus a platform to an ordered sequence of `EmittedLine` values and an `EmitReport`. It is pure, deterministic, allocates bounded memory, and reads nothing outside the graph, the schema and the corpus."* |
| `13` §2.2 | The provenance spec this crate implements | `source_node`: *"The node whose stanza this is. For `set security ipsec vpn VPN-B ike gateway GW-B` that is the `IpsecVpn`, not the `IkeGateway`."* `source_fields`: *"Every (node, field) that contributed a token to `text`, in token order."* |
| `13` §1.1 | The three outcomes per statement | Block when *"a required field is `Unknown`, or the field is `Conflicted` (schema §5.4)"*; Skip is *"the only silent case"* |
| `13` §3 | `StatementPath`, properties P1–P3 | P1 total order; P2 *"No two lines in one `EmitOutput` share a path"*; §3.2's `EmitConflict` on violation |
| `13` §4.1–4.2 | The block table and its authorship | *"RECOMMENDATION — the block table is corpus data with a named reviewer, not a function of the graph."* |
| `13` §5.3 | Ordering policy | *"DECISION — order everywhere anyway, and say why honestly"* |
| `13` §5.6 | Ordering determinism — the binding this WO discharges | *"For a fixed set of lines and a fixed dependency relation, `order` produces one unique sequence, on every machine, in every build."* |
| `13` §7.2 | The report is inseparable from the lines | *"The ONLY accessor. There is no `fn lines(&self)`."* |
| `13` §9.1, §9.4 | The gap ledger — the emit-side residue | `GapKind::NotYetBuilt`: *"Fathom has not built the emitter for it yet."* §9.4: *"There is no `Omit`."* |
| `13` §10.1, §10.3 | Placeholders | *"We never offer substitution in the application."* |
| `13` §11.1 | The round-trip property, stated correctly | *"`parse(emit(g)) ≠ g`, always, and correctly"* — E1: *"the first emit may lose things; the second must lose nothing further."* |
| `13` §13.3 | One logical line | *"`EmittedLine.text` is one logical line with no newlines and no backslashes. Wrapping is applied by the renderer."* |
| `11` §9.1 (L2 row) | What blocks an emit | *"For a chosen emit unit: every field marked `R`/`R*` for that platform is `Set` or `Default`, every required edge is present, every cross-field constraint holds, no field is `Conflicted`, and every scalar `emit()` succeeds on that platform"* — *"Returns the exact blocker list, never a partial config with a hole in it"* |
| `11` §9.2 | The emit unit and its closure | *"An emit never runs over 'the graph'. It runs over an **emit unit**: a root node plus the closure of the edges the platform's emitter declares as 'I will follow this'."* The `IpsecVpn` closure tree is drawn there and §4.5 transcribes it |
| `62` §10.1 | `emit:` marker semantics | `R`: *"Required for a valid emit on **every** platform that supports the kind. A missing `R` field makes the emit unit incomplete (`11` §9.2)"*; `R*` per `emit_required_when`; `O`: *"Emitted when `Set`, legal to omit"*; `—`: *"Never emitted"* |
| `62` §4 field-key table; `crates/fathom-schema/src/gates.rs` | Emit on inert kinds is a schema failure, already enforced | *"Forced to `—` on `emits: false` kinds and on `derived` fields; declaring otherwise is `schema.emit.on-inert`"* — the gate is live in `gates.rs` and prints `` `{Kind}.{field}` declares emit `{marker}` on {an emits: false kind / a derived field} `` |
| `62` §10.3 | The coverage obligation this WO makes checkable | *"every field of `k` with `emit: R` — and every `R*` field whose platform set includes `p` — must appear in `KindEmitter::reads()` for `(k, p)` **or** in a `DeclaredGap` carrying a reason string"* |
| `62` §19.4 | Determinism and secrecy gates the dictionary will later enforce; this WO's tests are their crate-side twins | `dict.order.duplicate`: *"emission order must be total for determinism"*; `dict.secret.interpolated`: *"the template must render the placeholder (`<PSK>`), never `$value`"* |
| `53` §6.3, §6.3.1 | The notepad/copy contract the output shape serves | Copy of one line is *"The **unwrapped logical line** — one `set` statement on one line, no gutter number, no risk dot, no display wrapping"*; multi-select copies *"in emit order, not click order"*; *"the clipboard is built from `EmittedLine.text`, and `EmittedLine.text` holds one statement."* |
| `.context/field-card-srx-ipsec.txt` side 1 | Every statement shape this WO emits | `set security ike gateway GW-B external-interface reth0.0` and the rest of the PHASE 1 / PHASE 2 blocks |
| `schema/schema.yaml` (kinds `IkeProposal` … `TrafficSelector`) | The `emit:` markers, transcribed row for row in §4.6 | e.g. `IkeProposal.authentication_algorithm`: `emit: "R*"`, `emit_required_when: { platforms: [], when: "encryption_algorithm.aead == false" }` |
| `78` §2 | Everything inherited | (whole table) |

## 3. Prior state

Every claim verified against the working tree on 2026-08-02 (`cargo test --workspace`: 80 passed,
0 failed; `fathom-schema-check`: exit 0, `0 failure(s), 2 warning(s)`,
`48 kinds · 89 edges · 61 scalars · 10 enums · 14 files parsed`). A divergence found during
execution is handled by `78` §8's correction test, nothing else.

- **Workspace.** Six crates: `fathom-corpus`, `fathom-find`, `fathom-id`, `fathom-ir`,
  `fathom-schema`, `fathom-schemagen`. No `fathom-graph` and no `fathom-emit` — WO-02 creates the
  former; this WO consumes it as specified in WO-02 §4.2 and creates the latter. No hash
  implementation exists anywhere in the workspace (relevant to `13` §2.3's `LineId`; §10 item 1).
- **The schema-check gate report** lists `schema.emit.unread` and `schema.emit.attr-read` under
  *"not yet checkable (11 gates)"* — they *"need emitter read sets"* (`gates.rs` header). The
  `schema.emit.on-inert` gate is implemented and green (`crates/fathom-schema/src/gates.rs`,
  the `// ---- schema.emit.on-inert ----` section).
- **`schema/schema.yaml`.** The seven covered kinds all carry `emits: true`; their fields carry
  the `emit:` markers transcribed in §4.6. The chain edges exist with these declarations, all
  `class: reference`, `symmetric: false`, `reverse_index: true`: `UsesIkePolicy`
  (`IkeGateway → IkePolicy`, out `"1"`), `UsesProposal` (`[IkePolicy, IpsecPolicy] →
  [IkeProposal, IpsecProposal]`, out `"1..n"`, edge field `ordinal: u8` with `emit: "—"`),
  `ExternalInterface` (`IkeGateway → LogicalUnit`, out `"1"`, and the tree's only non-null
  `emit_dict:` — `junos-srx/security.ike.gateway.external-interface`), `UsesIkeGateway` and
  `UsesIpsecPolicy` (`IpsecVpn → …`, out `"1"`), `BindsInterface` (`IpsecVpn → LogicalUnit`, out
  `"0..1"`, doc: *"Required when mode == RouteBased, forbidden when PolicyBased"*). Containment:
  `HasTrafficSelector` (`IpsecVpn → TrafficSelector`, out `"0..n"`), `HasUnit`
  (`InterfaceLike → LogicalUnit`). `classes:` declares
  `InterfaceLike: [Interface, AggregateInterface, RethInterface, TunnelInterface]`.
  `LogicalUnit`'s doc: *"st0.0 is rendered from (TunnelInterface st0, index 0), never stored
  joined (11 §4.6)."*
- **No statement dictionary.** `corpus/` holds `commands/`, `explainers/`, `rules/` only — no
  `dict/` directory; every `emit_dict:` is `null` except the one hook above. The `dict.*` gates
  (`62` §19.4) are consequently not checkable and nothing in this WO builds them (§8; §10 item 2).
- **`crates/fathom-ir/src/generated/ir_types.rs`.** `NodeKind` and `EdgeKind` carry every kind
  and edge named above; `UsesProposalField::Ordinal` exists with `key()`. Generated enums this WO
  reads: `EstablishTunnels { Immediately, OnTraffic, ResponderOnly, ResponderOnlyNoRekey,
  Unknown(String) }`, `VpnMode { RouteBased, PolicyBased, Unknown(String) }`,
  `IpsecProposalProtocol { Esp, Ah, Unknown(String) }`.
- **`crates/fathom-ir/src/generated/accessors.rs`.** Header: *"Edge-field reads land with the
  emitter work (13)."* — edge fields are read through `fathom_ir::bag::typed` with the generated
  field enums' `key()`; no edge accessor fns exist and none are added here. Node accessors this
  WO uses, verified present: `ike_proposal::{name, authentication_method, dh_group,
  encryption_algorithm, authentication_algorithm, lifetime_seconds}`, `ike_policy::{name,
  pre_shared_key}`, `ike_gateway::{name, peer, version}`, `ipsec_proposal::{name, protocol,
  encryption_algorithm, authentication_algorithm, lifetime_seconds}`, `ipsec_policy::{name,
  perfect_forward_secrecy}`, `ipsec_vpn::{name, mode, establish_tunnels}`,
  `traffic_selector::{name, local_ip, remote_ip}`, `logical_unit::index`, and `name` on all four
  `InterfaceLike` modules (`interface`, `aggregate_interface`, `reth_interface`,
  `tunnel_interface`), each returning `&crate::scalar::InterfaceName`.
- **`crates/fathom-ir/src/value.rs`.** `PeerSpec { Address(scalar::IpAddr), Dynamic(IkeId) }` is
  real; `Dpd` and `IkeId` are empty structs — *"Shape stated nowhere read"*. Consequence: the
  card's `dead-peer-detection` line and any `Dynamic` peer are not emittable from graph data;
  §4.6 turns the former into a gap entry and the latter into a blocker.
- **WO-01 (`Scalar`), depended on as specified.** This WO consumes `Scalar::canonical()`,
  `ScalarParseError` not at all, and the `SecretPlaceholder` API of WO-01 §4.4:
  `placeholder() -> String` rendering `<PSK>`, `label()`, `hint() -> Option<&SecretHint>`,
  `SecretHint::as_str()`. The junos token tables in §4.7 are the per-platform half WO-01 §8
  explicitly deferred *"with the platform registry and the emitters"*.
- **WO-02 (`fathom-graph`), depended on as specified.** This WO consumes, per WO-02 §4.2:
  composite `NodeId { kind, ulid }` / `EdgeId` / `ElementId`; `Graph::{node, nodes_of_kind, out,
  inn, owner, presence, history, provenance}`; `Node`/`Edge` implementing
  `fathom_ir::bag::FieldBag` (*"return the slot only when `Set`"*); `StoredPresence { Set,
  Absent, Unknown }` and `FieldInfo`. The store never holds `Default` or `Conflicted` — WO-02
  §4.2's decision (*"the store holds exactly three presence states"*) — so `11` §9.1 L2's
  "`Set` or `Default`" clause and `13` §1.1's `Conflicted` outcome are vacuous here; §4.4 states
  the reduced discipline.
- **The queue.** `docs/70-ops/79-work-orders/` holds WO-01 through WO-08 plus `00-INDEX.md`,
  first shipped in the same planning PR that landed this queue.
  Status lines at revision time: WO-01, WO-02, WO-06 and WO-07 `OPEN`; WO-03 `BLOCKED` on
  WO-01 and WO-02; WO-05 `BLOCKED` on WO-02; WO-08 `BLOCKED` on WO-01, WO-02 and WO-07.
  (The original authoring claimed no WO-03 file existed; that was false — §12 item 7.) WO-03
  is the junos-srx ingest WO this document's G8 story reads: its §4.7 ships the parse-direction
  statement dictionary as corpus data under `corpus/dict/junos-srx/` with the `emit`/`explain`
  halves deliberately omitted (its §12 item 1, deferred to *"the emitter and explainer WOs"* —
  its §10 item 7); its §4.8 pins the fragment shape and defers the fragment-to-store weld to a
  separate, not-yet-written work order.
- **The field card.** `.context/field-card-srx-ipsec.txt` side 1 carries every statement §4.6
  emits, in the order §4.9's golden reproduces.

## 4. Deliverables

Exactly these files change: the new crate under `crates/fathom-emit/`, one member line in the
root `Cargo.toml`, and the `Cargo.lock` hunk cargo generates for the new member. Nothing under
`schema/`, nothing under `crates/fathom-ir/`, nothing in `fathom-schema` or `fathom-schemagen`.
Every public name this work order creates is listed in §4.2–§4.3; a step that needs a public
name not on the list stops under §7. Module-private items are the execution session's to name.

### 4.1 The crate and the workspace edit

`crates/fathom-emit/Cargo.toml`, verbatim:

```toml
[package]
name = "fathom-emit"
version = "0.1.0"
edition.workspace = true
license.workspace = true
publish.workspace = true
description = "The junos-srx emitters: graph to (line, provenance) pairs, ordered, blocked and reported, never strings (13; conventions invariant 6)"

[dependencies]
fathom-id = { path = "../fathom-id" }
fathom-ir = { path = "../fathom-ir" }
fathom-graph = { path = "../fathom-graph" }

[dev-dependencies]
# The coverage test reads schema/schema.yaml's emit: markers back through the
# subset parser — the crate-side half of schema.emit.unread (62 §10.3).
fathom-schema = { path = "../fathom-schema" }
```

Root `Cargo.toml` members list gains one line, after `"crates/fathom-corpus"`:

```toml
    "crates/fathom-emit",
```

`crates/fathom-emit/src/lib.rs` — `#![forbid(unsafe_code)]`, modules `risk`, `path`, `line`,
`block`, `report`, `plan`, `order`, `junos`, `output`, re-exporting every public item below at
the crate root. The module doc states: junos-srx only; assert-only; the `13` narrowings recorded
in §12 of this work order, by item number.

### 4.2 Public types

`src/risk.rs` — the risk enum enters the codebase here, exactly as conventions pin it:

```rust
/// Conventions: exactly three values, ordered. Colours and captions are the
/// UI's; this crate stores the band only. Never extended, never reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Risk { ReadOnly, ChangesConfig, Disruptive }
```

`src/path.rs` — `13` §3, cut to one platform (§12 item 1):

```rust
/// 13 §3's addressing scheme. This crate emits one platform (junos-srx), so
/// the `plat` field is not carried; `PLATFORM` names it for reports and for
/// the future multi-platform widening.
pub const PLATFORM: &str = "junos-srx";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StatementPath { pub tokens: Vec<PathToken> }

/// Derived Ord breaks discriminant ties first: Kw < Name < Index < Member
/// (13 §3.1 P1). `Member` marks the identity-bearing value of an
/// accumulating statement — `… proposals IKE-P1` and `… proposals IKE-P2`
/// are two statements, not one with two values (13 §3).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PathToken { Kw(&'static str), Name(String), Index(u32), Member(String) }
```

The path of a statement is every token of the rendered line after `set `, up to but excluding
its value tokens; `proposals` rows additionally carry `Member(<proposal name>)`. Worked:
`set security ike proposal IKE-P1 dh-group group14` → `[Kw("security"), Kw("ike"),
Kw("proposal"), Name("IKE-P1"), Kw("dh-group")]`; `set security ike policy IKE-POL proposals
IKE-P1` → `[…, Name("IKE-POL"), Kw("proposals"), Member("IKE-P1")]`.

`src/line.rs` — invariant 6 made a type. The field set is `13` §2.2 narrowed to the consumers
that exist (§12 item 1 records every cut):

```rust
/// Instance-level field reference (13 §2.2). The rule engine's static
/// (kind, field) pair of the same name is 12 §5.1's; 13 §16 OD-1 owns the
/// rename and this crate does not wait for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldRef {
    pub node: fathom_graph::NodeId,
    pub field: fathom_ir::bag::FieldKey,
    pub role: FieldRole,
}

/// 13 §2.2's four roles, complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldRole { Value, Subject, Referenced, Conditioning }

/// 13 §2.5's four classes, complete. Declared per statement row in §4.6,
/// never inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Idempotency { Idempotent, Accumulating, Replacing, NonIdempotent }

/// A credential placeholder span within `text` (13 §10.3). `hint` is never
/// rendered into `text` — it appears only in the substitution manifest.
#[derive(Debug, Clone)]
pub struct PlaceholderSpan {
    pub start: u32,                          // byte offset into `text`
    pub end: u32,
    pub label: fathom_ir::scalar::SecretLabel,
    pub site: FieldRef,
}

/// One logical junos-srx statement with everything needed to explain it,
/// order it and copy it (53 §6.3.1: the clipboard is built from `text`,
/// and `text` holds one statement).
#[derive(Debug, Clone)]
pub struct EmittedLine {
    /// One logical line. No newlines, no continuation backslashes, no
    /// leading indent (13 §13.3).
    pub text: String,
    pub path: StatementPath,
    /// The node whose stanza this is (13 §2.2).
    pub source_node: fathom_graph::NodeId,
    /// Every (node, field) that contributed a token, in token order
    /// (13 §2.2). Never empty: a line without provenance does not exist
    /// in this crate.
    pub source_fields: Vec<FieldRef>,
    pub risk: Risk,
    pub idempotency: Idempotency,
    pub block: BlockId,
    /// node ordinal × 1000 + statement row (§4.5). Within-emit tiebreak;
    /// `path` breaks any residual tie (13 §5.6's key).
    pub order_hint: u32,
    /// Corpus entry point, stamped not resolved (13 §12). Forms:
    /// `explain:field:<Kind>.<snake>` (conventions § Identifiers) and
    /// `explain:kind:<Kind>` (13 §12.2 ladder row 3).
    pub explain: String,
    pub placeholders: Vec<PlaceholderSpan>,
}
```

`src/block.rs` — `13` §4.1's table, the two ranks this slice populates:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockId(pub u16);

#[derive(Debug, Clone, Copy)]
pub struct Block { pub id: BlockId, pub title: &'static str, pub rank: u16 }

/// 13 §4.1 ranks 20 and 30, verbatim titles. The block table is authored
/// data (13 §4.2), fixed here; extending it is a follow-on emitter WO.
pub const BLOCKS: &[Block] = &[
    Block { id: BlockId(20), title: "PHASE 1 — PROPOSAL, POLICY, GATEWAY", rank: 20 },
    Block { id: BlockId(30), title: "PHASE 2 — PROPOSAL, POLICY, VPN",     rank: 30 },
];
```

`src/report.rs` — the ledgers. Nothing here is suppressible and nothing has an `Omit`
(`13` §9.4):

```rust
/// Why a statement could not be emitted, in the position it would have
/// occupied (11 §9.1 L2: "Returns the exact blocker list, never a partial
/// config with a hole in it"). Closed; a case outside this list is a §7
/// trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockReason {
    /// An emit-R (or satisfied-R*) field is `Unknown` (13 §1.1).
    RequiredUnknown,
    /// An emit-R (or satisfied-R*) field is asserted `Absent` — the emit
    /// unit is incomplete (62 §10.1; 11 §9.1 L2's "Set or Default").
    RequiredAbsent,
    /// The value is Set but the closed junos token table (§4.7) has no row
    /// for it. The value's canonical text is carried; a guess is never.
    TokenUnmapped { value: String },
    /// A generated enum's `Unknown(String)` arm — unvalidated foreign text
    /// is never rendered into a statement.
    EnumUnknownArm,
    /// AEAD encryption with `authentication_algorithm` Set — the schema's
    /// own doc: "Must be Absent when the encryption algorithm is AEAD".
    /// Refused loudly rather than dropped silently (13 §9).
    AeadExcludesAuth,
    /// `PeerSpec::Dynamic` — `IkeId` is an empty stub (§3); not emittable.
    DynamicPeerNotCovered,
    /// `VpnMode::PolicyBased` — policy-based emission is not built
    /// (card: "then permit tunnel ipsec-vpn NAME", a SecurityPolicy form).
    PolicyBasedNotCovered,
    /// A reference edge the statement needs is missing: UsesIkePolicy,
    /// ExternalInterface, UsesIkeGateway, UsesIpsecPolicy (all out "1"),
    /// UsesProposal (out "1..n"), or BindsInterface under RouteBased
    /// (11 §9.1 L2: "every required edge is present").
    MissingRequiredEdge { edge: fathom_ir::generated::ir_types::EdgeKind },
    /// TrafficSelector.protocol / local_ports / remote_ports Set — the
    /// schema field doc: "Not expressible on every platform; blocks emit
    /// where not."
    SelectorTermUnsupported,
}

#[derive(Debug, Clone)]
pub struct Blocker {
    pub node: fathom_graph::NodeId,
    pub field: Option<fathom_ir::bag::FieldKey>,
    pub block: BlockId,
    /// The order_hint the line would have carried — position, kept.
    pub order_hint: u32,
    pub reason: BlockReason,
}

/// The emit-side residue ledger (13 §9.1, GapKind::NotYetBuilt only in this
/// slice — every entry is our backlog, not a vendor fact). One entry per
/// covered-kind node whose gap field is Set or explicitly Absent.
#[derive(Debug, Clone)]
pub struct GapEntry {
    pub node: fathom_graph::NodeId,
    pub field: fathom_ir::bag::FieldKey,
    /// The static reason string from the kind's GAPS table (§4.6).
    pub tracking: &'static str,
}

/// One row of the substitution manifest (13 §10.4).
#[derive(Debug, Clone)]
pub struct Substitution {
    /// Index into the emitted line sequence.
    pub line: u32,
    /// The rendered token, e.g. "<PSK>".
    pub token: String,
    pub site: FieldRef,
    /// SecretHint text — manifest only, never in any `text` (13 §10.1).
    pub hint: Option<String>,
}

/// Two lines, one path (13 §3.2). Always fatal to rendering.
#[derive(Debug, Clone)]
pub struct EmitConflict { pub path: StatementPath }

#[derive(Debug, Clone, Default)]
pub struct EmitReport {
    pub blockers: Vec<Blocker>,
    pub gaps: Vec<GapEntry>,
    pub substitutions: Vec<Substitution>,
    pub conflicts: Vec<EmitConflict>,
}
```

### 4.3 The emitter API

`src/output.rs` and the crate root:

```rust
/// The emit unit selector (11 §9.2). One variant in this slice.
#[derive(Debug, Clone, Copy)]
pub enum EmitScope { IpsecVpn(fathom_graph::NodeId) }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmitError {
    UnknownNode { node: fathom_graph::NodeId },
    NotAnIpsecVpn { node: fathom_graph::NodeId },
    /// Kahn terminated early (13 §5.7 makes this unreachable for this
    /// closure; returned rather than panicked if it ever is not).
    OrderingCycle,
}

pub struct EmitOutput { /* private: lines, blocks, report */ }

impl EmitOutput {
    /// The ONLY accessor (13 §7.2: "There is no `fn lines(&self)`."). The
    /// caller cannot take the lines without the report.
    pub fn parts(&self) -> (&[EmittedLine], &[Block], &EmitReport);

    /// The paste payload: `text` per line, `\n`-joined, one trailing
    /// newline, no blank lines, no comments, no headers — the parseable
    /// form G8 round-trips and 53 §6.3's copy rules require. Refuses while
    /// the report carries blockers or conflicts.
    pub fn render_config(&self) -> Result<String, RenderRefused>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderRefused {
    Conflicts { count: usize },
    Blockers { count: usize },   // checked after conflicts
}

/// The emitter (13 §1's total function, junos-srx). Pure: reads the graph
/// and its own const tables; no clock, no RNG, no I/O (invariant 9).
pub fn emit(graph: &fathom_graph::Graph, scope: EmitScope)
    -> Result<EmitOutput, EmitError>;
```

**DECISION — no public `KindEmitter` trait, no registry, no typestate builder in this slice.**
`13` §6.2 specifies a `Platform` + `KindEmitter` trait pair behind a `&'static dyn` registry, and
§6.3 a typestate `LineBuilder` so a provenance-free line cannot compile. With one platform, seven
kinds and every emitter in-crate, that surface has no external consumer; per WO-01's precedent
(its §12 item 1: ship the half with a consumer, extend later without changing it), the kind
emitters are private functions dispatched by an exhaustive `match` on `NodeKind`, the read/gap
declarations are per-kind `const` tables (§4.6) consumed by the coverage test, and the
no-line-without-provenance rule is enforced by a private constructor that takes `source_fields`
as a non-optional argument plus the test `every_line_carries_provenance`. The trait shape
arrives with the second platform. §12 item 1 records this against `13` §6; if it is wrong, the
correction lands in `13`, not silently here.

### 4.4 The read discipline

Private helpers over WO-02's API; stated here because every §4.6 row cites them. The store holds
three presence states, so `13` §6.5's four-state table reduces to:

| Helper | `Set` | `Absent` | `Unknown` |
|---|---|---|---|
| `need` (rows marked R, and R* rows whose condition holds) | the value, via the generated accessor | `Blocker(RequiredAbsent)` | `Blocker(RequiredUnknown)` |
| `opt` (rows marked O) | `Some(value)` | `None` — skip, silently; *"the only silent case"* (13 §1.1) | `None` — skip |

Presence comes from `Graph::presence`; values come from the generated accessors over the
`FieldBag` impl (which serves `Set` slots only — WO-02 §4.2). There is no `unwrap_or_default`
anywhere in this crate: a default supplied by the emitter is a value the user never chose
(`13` §6.5). A blocker never aborts the emit: the pipeline records it in position and continues
with the next statement (`13` §1.1's Block outcome), so one emit returns the *exact* blocker
list (`11` §9.1 L2).

The two declarable `R*` conditions are hard-coded in the owning kind emitter — branching lives
in Rust, never in data (`13` §6.1):

| Field | Condition (schema, verbatim) | Behaviour |
|---|---|---|
| `IkeProposal.authentication_algorithm`, `IpsecProposal.authentication_algorithm` | `encryption_algorithm.aead == false` | encryption AEAD (`aead == true`): field must not emit; if it is `Set`, `Blocker(AeadExcludesAuth)`; if `Absent`/`Unknown`, nothing — and the encryption field joins that nothing's provenance story as `FieldRole::Conditioning` on the encryption line. Encryption CBC: `need` |
| `IpsecProposal.encryption_algorithm` | `protocol == Esp` | protocol `Esp`: `need`. Protocol `Ah`: the protocol row itself blocks first (`TokenUnmapped`, §4.7), so no second decision arises |

The `R*` rows whose `emit_required_when` is `{ platforms: [] }` — the schema's own VERIFY
comments record their predicates as not yet declarable — are handled per §4.6: `pre_shared_key`
is emitted when `Set` and skipped otherwise; `mode` (IkePolicy) and `certificate_id` are gap
entries. No predicate evaluator is built (§8).

### 4.5 The plan stage: unit, ordinals, blocks

`emit` refuses a scope node that does not exist (`UnknownNode`) or is not `NodeKind::IpsecVpn`
(`NotAnIpsecVpn`). The closure is `11` §9.2's `IpsecVpn` tree, walked over exactly these edges
in exactly this child order (targets of a `0..n` edge in `NodeId` order; `UsesProposal` targets
in `(ordinal, EdgeId)` order, `ordinal` read from the edge via
`fathom_ir::bag::typed::<u8, _>(edge, UsesProposalField::Ordinal.key())` — the second type
parameter is the bag, inferred (`bag.rs`: `typed<T: Any, B: FieldBag + ?Sized>`) —
`Unknown`/`Absent` ordinal sorting after every `Set` ordinal):

```
IpsecVpn
 ├─ UsesIkeGateway   → IkeGateway
 │   ├─ UsesIkePolicy → IkePolicy
 │   │   └─ UsesProposal → IkeProposal
 │   └─ ExternalInterface → LogicalUnit   (naming read only)
 ├─ UsesIpsecPolicy  → IpsecPolicy
 │   └─ UsesProposal → IpsecProposal
 ├─ HasTrafficSelector → TrafficSelector  (rows ride the IpsecVpn ordinal)
 └─ BindsInterface   → LogicalUnit        (naming read only)
```

**DECISION — node ordinals are the depth-first *post-order* of this walk.** Post-order yields
`IkeProposal(0), IkePolicy(1), IkeGateway(3), IpsecProposal(4), IpsecPolicy(5), IpsecVpn(8)`
(units and selectors take ordinals but produce no own-numbered lines), which is exactly the
object-chain order the card teaches — referenced object before the object that names it.
`11` §9.2 says "pre-order"; pre-order puts the root's lines first and cannot reproduce the card
order that same sentence promises; content wins over the traversal word, and §12 item 2 files
the disagreement. `order_hint = ordinal × 1000 + statement row` (rows per §4.6; TrafficSelector
rows are `500 + i` on the `IpsecVpn` ordinal, `i` the selector's position in `NodeId` order).

Block assignment is by source kind: `BlockId(20)` for `IkeProposal`/`IkePolicy`/`IkeGateway`
lines and their blockers; `BlockId(30)` for `IpsecProposal`/`IpsecPolicy`/`IpsecVpn`/
`TrafficSelector`. A kind outside the seven cannot enter the walk, so `13` §4.2's
`MISCELLANEOUS` fallback is unreachable and not built.

**Rendered unit names.** The `external-interface` and `bind-interface` values are rendered, not
stored (`LogicalUnit`'s doc: *"st0.0 is rendered from (TunnelInterface st0, index 0), never
stored joined"*): `need` the unit's `index`, walk `Graph::owner` to the containing
`InterfaceLike` node, `need` its `name` (matching on the four kinds; `InterfaceName`'s raw form
wins — `11` §4.6 via the schema doc), and join with `.`. A blocker from either read is
attributed to the node and field that failed, positioned at the statement's row.

### 4.6 The junos-srx statement tables

The heart of this work order: every `emit:` marker of the seven covered kinds, decided. "Row" is
the statement-row component of `order_hint`. Provenance lists `source_fields` in token order.
Every asserted line carries `risk: ChangesConfig` (a `set` statement needs a commit; ADR-0011 —
no line in this slice interrupts an established flow at paste time) and, unless the row says
otherwise, `idempotency: Idempotent` (scalar leaf). Values render through §4.7's token tables;
an unmapped `Set` value is `Blocker(TokenUnmapped)`, an `Unknown(String)` enum arm is
`Blocker(EnumUnknownArm)`, always positioned at the row.

**`IkeProposal`** — subject token from `name` (`need`, `FieldRole::Subject` on every row).

| Row | Statement | Marker | Reads beyond `name` | Explain key |
|---|---|---|---|---|
| 10 | `set security ike proposal <name> authentication-method <v>` | R | `authentication_method` (Value) | `explain:field:IkeProposal.authentication_method` |
| 20 | `set security ike proposal <name> dh-group <v>` | R | `dh_group` (Value) | `explain:field:IkeProposal.dh_group` |
| 30 | `set security ike proposal <name> authentication-algorithm <v>` | R* (§4.4) | `authentication_algorithm` (Value), `encryption_algorithm` (Conditioning) | `explain:field:IkeProposal.authentication_algorithm` |
| 40 | `set security ike proposal <name> encryption-algorithm <v>` | R | `encryption_algorithm` (Value) | `explain:field:IkeProposal.encryption_algorithm` |
| 50 | `set security ike proposal <name> lifetime-seconds <v>` | O | `lifetime_seconds` (Value) | `explain:field:IkeProposal.lifetime_seconds` |

Gaps: none — every declared field is read.

**`IkePolicy`** — subject from `name` (`need`).

| Row | Statement | Marker | Reads / notes | Explain key |
|---|---|---|---|---|
| 10 | `set security ike policy <name> proposals <proposal>` | edge `UsesProposal`, out `1..n` | one line per edge in `(ordinal, EdgeId)` order; path carries `Member(<proposal>)`; `idempotency: Accumulating` (13 §2.5); reads: own `name` (Subject), proposal's `name` (`need`, Referenced). No edge → `Blocker(MissingRequiredEdge)` | `explain:field:IkePolicy.uses_proposal` |
| 20 | `set security ike policy <name> pre-shared-key ascii-text "<PSK>"` | R* (`platforms: []`) | `pre_shared_key` (Value): `Set` → emit with the placeholder span covering `<PSK>` (WO-01 §4.4's `placeholder()`; the schema doc: *"Emits pre-shared-key ascii-text \"<PSK>\" — a correct emit, not a blocked one"*); `Absent`/`Unknown` → skip. The hint goes to the manifest only | `explain:field:IkePolicy.pre_shared_key` |

Gaps (`GAPS_IKE_POLICY`): `mode` (*"R* predicate undeclarable; no card set-line; junos statement
not yet built"*), `certificate_id` (*"rsa-signatures flow not yet built"*), `description`
(*"Text quoting rules not yet decided"*).

**`IkeGateway`** — subject from `name` (`need`).

| Row | Statement | Marker | Reads / notes | Explain key |
|---|---|---|---|---|
| 10 | `set security ike gateway <name> ike-policy <policy>` | edge `UsesIkePolicy`, out `1` | own `name` (Subject), policy `name` (`need`, Referenced); missing edge → `Blocker(MissingRequiredEdge)` | `explain:field:IkeGateway.uses_ike_policy` |
| 20 | `set security ike gateway <name> address <ip>` | R (`peer`) | `peer` (Value): `Set(Address(ip))` → the ip's `canonical()`; `Set(Dynamic(_))` → `Blocker(DynamicPeerNotCovered)`; `Absent`/`Unknown` → `need`'s blockers | `explain:field:IkeGateway.peer` |
| 30 | `set security ike gateway <name> external-interface <unit>` | edge `ExternalInterface`, out `1` | own `name` (Subject), unit `index` (Referenced) and owner interface `name` (Referenced) per §4.5's renderer; missing edge → `Blocker(MissingRequiredEdge)` | `explain:field:IkeGateway.external_interface` |
| 40 | `set security ike gateway <name> version <v>` | O | `version` (Value) | `explain:field:IkeGateway.version` |

Gaps (`GAPS_IKE_GATEWAY`): `local_identity`, `remote_identity` (*"IkeId is an empty stub —
value shape undecided"*), `dpd` (*"Dpd is an empty stub — value shape undecided; card line
dead-peer-detection always-send interval 10 threshold 3 waits on it"*), `nat_keepalive`,
`no_nat_traversal` (*"no corpus-grounded junos statement recorded yet"*), `description` (as
IkePolicy).

**`IpsecProposal`** — subject from `name` (`need`).

| Row | Statement | Marker | Reads / notes | Explain key |
|---|---|---|---|---|
| 10 | `set security ipsec proposal <name> protocol <v>` | R | `protocol` (Value) | `explain:field:IpsecProposal.protocol` |
| 20 | `set security ipsec proposal <name> encryption-algorithm <v>` | R* (§4.4) | `encryption_algorithm` (Value) | `explain:field:IpsecProposal.encryption_algorithm` |
| 30 | `set security ipsec proposal <name> authentication-algorithm <v>` | R* (§4.4) | `authentication_algorithm` (Value), `encryption_algorithm` (Conditioning). The P2 token table is empty (§4.7), so a required occurrence blocks — honest refusal, never a guessed token | `explain:field:IpsecProposal.authentication_algorithm` |
| 40 | `set security ipsec proposal <name> lifetime-seconds <v>` | O | `lifetime_seconds` (Value) | `explain:field:IpsecProposal.lifetime_seconds` |

Gaps (`GAPS_IPSEC_PROPOSAL`): `lifetime_kilobytes` (*"statement path not corpus-grounded yet;
the card names the knob, not the line"*).

**`IpsecPolicy`** — subject from `name` (`need`).

| Row | Statement | Marker | Reads / notes | Explain key |
|---|---|---|---|---|
| 10 | `set security ipsec policy <name> perfect-forward-secrecy keys <v>` | O | `perfect_forward_secrecy` (Value). `Absent` emits nothing — on Junos "no PFS" is the absence of the statement (13 §8.5) | `explain:field:IpsecPolicy.perfect_forward_secrecy` |
| 20 | `set security ipsec policy <name> proposals <proposal>` | edge `UsesProposal` | exactly as the IkePolicy row 10, `Accumulating` | `explain:field:IpsecPolicy.uses_proposal` |

Gaps (`GAPS_IPSEC_POLICY`): `description`.

**`IpsecVpn`** — subject from `name` (`need`). `mode` is `need`-read first,
`FieldRole::Conditioning`: `RouteBased` → `BindsInterface` is required (missing →
`Blocker(MissingRequiredEdge)`); `PolicyBased` → `Blocker(PolicyBasedNotCovered)`;
`Unknown(String)` arm → `Blocker(EnumUnknownArm)`. `mode` produces no statement of its own —
on Junos the mode is structural, and the Conditioning role is exactly `13` §2.2's *"did not
appear in the text but determined that the line exists at all"*.

| Row | Statement | Marker | Reads / notes | Explain key |
|---|---|---|---|---|
| 10 | `set security ipsec vpn <name> ike gateway <gw>` | edge `UsesIkeGateway`, out `1` | own `name` (Subject), gateway `name` (`need`, Referenced) | `explain:field:IpsecVpn.uses_ike_gateway` |
| 20 | `set security ipsec vpn <name> ike ipsec-policy <policy>` | edge `UsesIpsecPolicy`, out `1` | own `name` (Subject), policy `name` (`need`, Referenced) | `explain:field:IpsecVpn.uses_ipsec_policy` |
| 30 | `set security ipsec vpn <name> bind-interface <unit>` | edge `BindsInterface` (required iff `RouteBased`) | own `name` (Subject), unit naming reads per §4.5 (Referenced) | `explain:field:IpsecVpn.binds_interface` |
| 40 | `set security ipsec vpn <name> establish-tunnels <v>` | O | `establish_tunnels` (Value) | `explain:field:IpsecVpn.establish_tunnels` |
| 500+i | `set security ipsec vpn <name> traffic-selector <ts> local-ip <p> remote-ip <p>` | R×3 on the selector | `source_node` = the `TrafficSelector`; reads: vpn `name` (Referenced), ts `name` (`need`, Subject), `local_ip` (`need`, Value), `remote_ip` (`need`, Value); `idempotency: Replacing` (13 §2.5). `protocol`/`local_ports`/`remote_ports` `Set` → `Blocker(SelectorTermUnsupported)` <!-- VERIFY: the schema doc asserts non-expressibility per platform; the junos-srx half is unconfirmed against a box --> | `explain:kind:TrafficSelector` |

Gaps (`GAPS_IPSEC_VPN`): `df_bit`, `vpn_monitor` (*"VpnMonitor stub has no shape"*),
`idle_time`, `description` (*"no corpus-grounded junos statement recorded yet"*).

Each kind's `const` tables — `READS_<KIND>: &[FieldKey]` (every field the emitter reads,
including Conditioning reads) and `GAPS_<KIND>: &[(FieldKey, &'static str)]` — are public within
the crate for the coverage test. Together they must partition the kind's declared field set:
`reads ∪ gaps == fields`, `reads ∩ gaps == ∅` (§4.10's coverage tests; the crate-side half of
`schema.emit.unread`, `62` §10.3). The kind emitters and every `READS_*`/`GAPS_*` table live in
`src/junos.rs` — G9 greps exactly that file, so placing them elsewhere fails the gate
mechanically.

### 4.7 The closed junos-srx token tables

The per-platform render half WO-01 deferred to the emitters. **Every table is closed and carries
exactly the rows the corpus attests.** A `Set` value outside a table is `Blocker(TokenUnmapped)`
— refusal, never a guess; extension is a planning change with sources (WO-01 §7 trigger 5's
pattern). Sources: field card side 1 unless noted.

| Type (position) | Value → token | Everything else |
|---|---|---|
| `AuthMethod` | `PreSharedKeys` → `pre-shared-keys` | unmapped |
| `EncryptionAlgorithm` (P1 and P2) | canonical `aes-256-cbc` → `aes-256-cbc`; canonical `aes-256-gcm` → `aes-256-gcm` | unmapped |
| `IntegrityAlgorithm` (P1, `ike proposal`) | `HmacSha256_128` → `sha-256` | unmapped |
| `IntegrityAlgorithm` (P2, `ipsec proposal`) | *(no rows)* | unmapped <!-- VERIFY: the junos-srx P2 spelling is believed to be the hmac-sha-256-128 style; ship no row until a source is recorded --> |
| `DhGroup` (dh-group and PFS positions) | `14` → `group14` | unmapped <!-- VERIFY: the group<N> pattern is uniform on Junos; only 14 is card-attested, so only 14 ships --> |
| `IkeVersion` | `V2Only` → `v2-only` | unmapped |
| `IpsecProposalProtocol` | `Esp` → `esp` | unmapped |
| `EstablishTunnels` | `Immediately` → `immediately`; `OnTraffic` → `on-traffic` (card side 3, quoted in the generated enum's doc comment) | unmapped |
| `Identifier` | as written — *"validated, never normalised"* (`11` §4.3); the charset is ASCII-graphic, so no quoting arises | — |
| `IpAddr`, `IpPrefix`, `Seconds` | `Scalar::canonical()` (WO-01) | — |
| `InterfaceName` + unit | §4.5's renderer (`<raw name>.<index>`) | — |
| `SecretPlaceholder` | `placeholder()` inside double quotes: `"<PSK>"` | the hint, never (`62` §19.4 `dict.secret.interpolated`: *"the template must render the placeholder (`<PSK>`), never `$value`"*) |

The discriminator form `<PSK:SITE-B>` (`13` §10.1) is deliberately not rendered — WO-01 §4.4
ships `placeholder()` without a discriminator, and the derivation rule is undecided (§10 item 4).

### 4.8 Finalise and order

After every kind emitter has run (stage order irrelevant by construction — `13` §7's stage 2):

1. **Dedupe / conflict (P2, `13` §3.2).** Sort by `path`; equal-path runs with byte-equal `text`
   merge (union of `source_fields`, min `order_hint`); equal-path runs with differing `text`
   append an `EmitConflict` and drop neither line from `parts()` — rendering is what refuses.
2. **Dependencies (`13` §5.7, two producers only).** For each `FieldRole::Referenced` entry on a
   line whose referenced node produces lines: first line of the referenced node → this line. For
   each `TrafficSelector` line: first `IpsecVpn` line → it (containment). Nothing else may add
   an edge; `E ≤ 2V`.
3. **Order (`13` §5.6).** Kahn's algorithm, ready set in a binary min-heap over the key
   `(block rank, order_hint, &path)` — `Phase` is not carried (assert-only slice, §12 item 1),
   and the key is strict because P2 holds after step 1. The determinism claim discharged is
   `13` §5.6's, quoted in §2. `|out| < |lines|` → `Err(EmitError::OrderingCycle)`.

No `HashMap` or `HashSet` anywhere in the crate — iteration order is a property of `BTreeMap`,
`Vec` and the sort, never of a hasher seed (invariant 9; WO-02's precedent; gate G7).

### 4.9 The golden

The worked-example graph (§4.10, `tests/worked_example.rs`) is the card's side-1 chain: `Device`
`srx-a` containing the six objects (`IKE-P1`, `IKE-POL`, `GW-B` with peer `203.0.113.10` and
version `v2-only`, `IPSEC-P2` with ESP + `aes-256-gcm`, `IPSEC-POL` with PFS group 14, `VPN-B`
route-based, establish-tunnels immediately), `RethInterface reth0`/unit 0 and
`TunnelInterface st0`/unit 0, `TrafficSelector TS1` `10.1.0.0/16 ↔ 10.2.0.0/16`, and the six
chain edges. `IKE-P1` is CBC (`aes-256-cbc`) with `authentication_algorithm hmac-sha-256-128`
and `lifetime_seconds 28800`; `IPSEC-P2` carries `lifetime_seconds 3600`;
`IKE-POL.pre_shared_key` is `SecretPlaceholder::with_hint(Psk, hint("vault: net/ipsec/site-b"))`.
`GW-B` additionally carries `dpd` `Set` (the stub `Dpd` value), mirroring the card's
`dead-peer-detection` line — which is what makes the `GW-B.dpd` gap entry of the report clause
below exist at all (§4.2's rule: a gap entry needs `Set` or explicit `Absent`; every other gap
field is left `Unknown`).

`render_config` over that graph must produce **exactly** these bytes (21 lines, one trailing
newline). This block is the specification; regenerating it from a failing run is gate
laundering (`78` §5.5):

```
set security ike proposal IKE-P1 authentication-method pre-shared-keys
set security ike proposal IKE-P1 dh-group group14
set security ike proposal IKE-P1 authentication-algorithm sha-256
set security ike proposal IKE-P1 encryption-algorithm aes-256-cbc
set security ike proposal IKE-P1 lifetime-seconds 28800
set security ike policy IKE-POL proposals IKE-P1
set security ike policy IKE-POL pre-shared-key ascii-text "<PSK>"
set security ike gateway GW-B ike-policy IKE-POL
set security ike gateway GW-B address 203.0.113.10
set security ike gateway GW-B external-interface reth0.0
set security ike gateway GW-B version v2-only
set security ipsec proposal IPSEC-P2 protocol esp
set security ipsec proposal IPSEC-P2 encryption-algorithm aes-256-gcm
set security ipsec proposal IPSEC-P2 lifetime-seconds 3600
set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14
set security ipsec policy IPSEC-POL proposals IPSEC-P2
set security ipsec vpn VPN-B ike gateway GW-B
set security ipsec vpn VPN-B ike ipsec-policy IPSEC-POL
set security ipsec vpn VPN-B bind-interface st0.0
set security ipsec vpn VPN-B establish-tunnels immediately
set security ipsec vpn VPN-B traffic-selector TS1 local-ip 10.1.0.0/16 remote-ip 10.2.0.0/16
```

This is the field card's own text with two declared differences: no `dead-peer-detection` line
(`Dpd` is an empty stub — the gap ledger for `GW-B` must contain the `dpd` entry instead) and
`"<PSK>"` where the card prints `"<psk>"` (WO-01 §4.4's renderer; `11` §4.5's own rendering).
The report must further contain: zero blockers, zero conflicts, one substitution
(`token: "<PSK>"`, line 6 counting from 0, hint `vault: net/ipsec/site-b`), and no gap entry
other than `GW-B.dpd` (every other gap field is left `Unknown` in the fixture, and an `Unknown`
gap field reports nothing).

### 4.10 Tests

Exactly these files and test names (bodies are the session's to write, to the assertions stated
here and in §4.9):

| File | Tests |
|---|---|
| `tests/worked_example.rs` | `side1_chain_emits_the_golden_bytes` (§4.9, byte-exact incl. trailing newline); `report_matches_the_golden_contract` (§4.9's report clause); `blocks_are_phase1_then_phase2` (two blocks, ranks 20/30, titles verbatim); `every_line_carries_provenance` (`source_fields` non-empty on all 21, and line 9 — `external-interface` — carries the unit `index` and interface `name` refs with `FieldRole::Referenced`); `line_text_is_one_logical_line` (no `\n`, no `\\` in any `text`); `risk_is_changes_config_on_every_line`; `proposals_line_is_accumulating_with_member_path` |
| `tests/determinism.rs` | `same_graph_two_emits_byte_identical` (one process, two `emit` calls, `render_config` bytes equal); `insertion_order_does_not_change_emission` (build the §4.9 graph in a second, materially different insertion order; bytes equal); `value_edit_changes_no_ordering` (change `IKE-P1.lifetime_seconds` to another `Set` value; assert the path sequence of the emission is unchanged and only line 4's text differs — `13` §11.1 E4's spirit) |
| `tests/blockers.rs` | `required_unknown_blocks_in_position` (omit `IKE-P1.dh_group`; blocker carries the field key, `BlockId(20)`, `order_hint` 20 at ordinal 0); `required_absent_blocks` (`assert_absent` on the same field); `cbc_with_auth_unknown_blocks`; `aead_with_auth_set_blocks` (`AeadExcludesAuth`); `dynamic_peer_blocks`; `policy_based_mode_blocks`; `enum_unknown_arm_blocks` (`EstablishTunnels::Unknown`); `token_unmapped_blocks_with_value` (`AuthMethod::RsaSignatures`; the blocker carries the canonical text); `missing_uses_ike_policy_edge_blocks`; `route_based_without_binds_interface_blocks`; `selector_port_term_blocks`; `render_config_refuses_with_blockers` (and `parts()` still serves everything); `duplicate_path_conflict_blocks_render` (two proposals both named `IKE-P1` with different `dh_group` under one policy → one `EmitConflict`, `render_config` → `Conflicts`) |
| `tests/secret.rs` | `psk_renders_the_placeholder_never_the_hint` (the hint string appears in no `text`, and appears in the manifest); `substitution_manifest_names_line_and_site` (line index, `FieldRef` site, label `Psk`); `placeholder_span_covers_the_token` (the byte range slices `text` to exactly `<PSK>`) |
| `tests/report.rs` | `set_value_on_gap_field_is_reported` (`set_field` a `Dpd` on `GW-B` → one `GapEntry` with the §4.6 tracking string); `unknown_gap_field_reports_nothing` |
| `tests/coverage.rs` | `covered_kinds_partition_reads_and_gaps` (load `SchemaTree` from `schema/`; for each of the seven kinds: `reads ∪ gaps ==` declared fields, `reads ∩ gaps == ∅`); `every_emit_r_field_is_read_or_gapped` (the `62` §10.3 clause, over `emit: R` and `R*` rows); `gap_tracking_strings_are_nonempty` |
| `tests/round_trip.rs` | **Step 13 only** (§5): `e1_second_emit_loses_nothing_further` — run §4.9's golden through WO-03's `ingest` and the weld WO's apply step into a fresh `fathom-graph` store, `emit` that graph, and assert `render_config` equals the golden bytes plus G8's report clause exactly: the second report carries zero blockers, zero conflicts, one substitution agreeing with §4.9's on token (`"<PSK>"`), line index and label but with `hint: None` (parse constructs placeholders hintless — WO-03 §4.8; `11` §4.5), and zero gap entries — an empty set, a strict subset of the first report's one (`GW-B.dpd` names a field the golden text cannot carry). §12 item 6 files this against `13` §11.1 E1's literal agreement clause. Written only when step 12's three preconditions hold; see §5 steps 12–13, §6 G8 and §10 item 7 |

## 5. The plan

Each step ends with `cargo build --workspace` clean and, once tests exist, `cargo test -p
fathom-emit` green, unless the step says otherwise. No reordering, no merging (`78` §3.6).

1. **Skeleton.** Create `crates/fathom-emit` with §4.1's manifest verbatim, the members line,
   and `lib.rs` with empty modules. Builds.
2. **Types.** `risk.rs`, `path.rs`, `line.rs`, `block.rs`, `report.rs`, `output.rs` per
   §4.2–§4.3. In-module unit tests: `PathToken` discriminant order is `Kw < Name < Index <
   Member`; `Risk` ordering.
3. **Token tables.** `junos.rs`: the §4.7 tables as private `fn`s returning
   `Result<String, BlockReason>`. In-module tests per table row plus one unmapped case each.
4. **Read discipline.** The private `need`/`opt` helpers over `Graph::presence` + generated
   accessors (§4.4), returning value-or-`BlockReason`.
5. **Plan stage.** `plan.rs`: scope validation, the §4.5 walk, ordinal assignment, block
   assignment. Unit test the ordinal sequence over a hand-built chain.
6. **Kind emitters, in §4.6 order.** `IkeProposal` first; then `IkePolicy`, `IkeGateway` (with
   the unit-name renderer), `IpsecProposal`, `IpsecPolicy`, `IpsecVpn` + `TrafficSelector`.
   All of it lands in `src/junos.rs`, the `READS_*`/`GAPS_*` tables with each kind (§4.6's
   placement rule; G9 greps that file). After each kind, its `tests/blockers.rs` cases
   that need only the kinds built so far may be written and run.
7. **Finalise + order.** `order.rs` per §4.8: dedupe/conflict, the two dependency producers,
   Kahn over the stated key.
8. **Output.** `EmitOutput`, `parts`, `render_config` with the refusal order
   (conflicts, then blockers).
9. **Integration tests** per §4.10, file order: `worked_example`, `determinism`, `blockers`,
   `secret`, `report`, `coverage`.
10. **Floor.** Run §6's G1–G7 and G9 in order. Fix only defects in this WO's own new code;
    anything else is §7.
11. **Bookkeeping.** Commit per `78` §3.9 (subject naming the deliverable, e.g. *"Build the
    junos-srx emitters: fathom-emit with provenance, ordering and the emit report"*), push, open
    the PR listing every gate's output verbatim. Do not merge.
12. **Status.** Step 13 has three preconditions, checked in this order against the documents on
    disk: (a) WO-03's status line is DONE; (b) a fragment-to-store weld work order exists in
    this directory with status DONE, whose Deliverables name a public entry point taking
    WO-03's `IngestOutput` (or junos-srx set-statement text) to a `fathom-graph` store; (c)
    §10 item 7 records — in that item, or in a planning document it names — resolved decisions
    for both of its open questions (the weld entry point; the source of `IpsecVpn.mode` in a
    re-parsed graph). If all three hold: continue to step 13. Otherwise: set this work order's
    status line to `BLOCKED on WO-03 + the weld WO (G8, the round-trip gate, outstanding; all
    other gates green)`, mirror the index row if `00-INDEX.md` exists, and end. At revision
    time all three preconditions are known-false (WO-03 is itself BLOCKED, the weld WO is
    unwritten, §10 item 7 is open), so ending here is this work order's expected terminal
    state, not a failure.
13. **Round-trip (all three step-12 preconditions hold).** Write `tests/round_trip.rs` per
    §4.10 against the weld WO's exact entry-point name, run G8, and on green set the status
    line to `DONE`. If the entry point's shape differs from what the weld WO's Deliverables
    state, or WO-03's parser refuses any line of the §4.9 golden, stop and escalate under §7 —
    do not adapt, wrap, or approximate.

## 6. Acceptance gates

Run from the repository root, in this order, locally, before push (`78` §6). Expected results
are exact; anything else is a red gate and §7 applies.

| # | Command | Expected |
|---|---|---|
| G1 | `cargo fmt --all --check` | No output, exit 0 |
| G2 | `cargo clippy --all-targets -- -D warnings` | Builds clean, exit 0 |
| G3 | `cargo test -p fathom-emit` | Every §4.10 test listed (except `round_trip` before step 13), all `ok`, 0 failed |
| G4 | `cargo test --workspace` | Every suite `ok`, zero failures; no pre-existing test deleted, loosened or ignored (`78` §5.5). Green is the gate, not a count (`78` §12 item 3) |
| G5 | `git diff --exit-code -- schema/ crates/fathom-ir crates/fathom-schema crates/fathom-schemagen` | No output, exit 0 — this WO touches none of them |
| G6 | `cargo run -q -p fathom-schema --bin fathom-schema-check` | Exit 0; `48 kinds · 89 edges · 61 scalars · 10 enums · 14 files parsed`; `0 failure(s), 2 warning(s)` — the pinned baseline, unchanged |
| G7 | `grep -rn "HashMap\|HashSet\|SystemTime\|Instant\|random" crates/fathom-emit/src crates/fathom-emit/tests` | No matches, exit 1 (invariant 9; §4.8) |
| G8 | **The flagship round-trip** (step 13; runnable only when step 12's three preconditions hold): `cargo test -p fathom-emit --test round_trip` | `e1_second_emit_loses_nothing_further` `ok`. The criterion is `13` §11.1 E1's fixed point — parse the §4.9 golden, re-emit, byte-equal rendering (*"the first emit may lose things; the second must lose nothing further."*) — with the agreement clause stated to what the ledgers can carry: substitutions agree on token, line index and label, with `hint: None` on the second (parse constructs placeholders hintless — WO-03 §4.8; `11` §4.5); the second report's gap set is empty, a strict subset of the first's, whose one entry (`GW-B.dpd`) names a field the golden text cannot carry. §12 item 6 files the narrowing against E1's literal wording. Graph equality is deliberately **not** the criterion (§12 item 3) |
| G9 | `grep -c "GAPS_" crates/fathom-emit/src/junos.rs` | A non-zero count — the gap tables exist; their content is pinned by G3's coverage tests |

## 7. Stop-and-escalate triggers

The general rule is `78` §4; escalating is success. Specific to this work order, stop and
escalate when:

1. Any step appears to need an edit under `schema/`, `crates/fathom-ir/` (including generated
   files), `fathom-schema`, or `fathom-schemagen` — this WO reads them and changes nothing.
2. A public name, file, error variant, blocker reason, gap entry, statement row, or token-table
   row not listed in §4 is needed. The token tables and statement tables are closed; a real
   config that needs a row this document does not carry (a ninth encryption token, `group5`, a
   P2 authentication spelling, `v1-only`, a `dead-peer-detection` line) is extended by planning
   with sources, never here.
3. WO-01's or WO-02's merged deliverables diverge from what §3 cites (an accessor name, the
   `SecretPlaceholder` API, `Graph::presence`'s shape, `StoredPresence`'s states) in a way that
   changes a decision in §4. A pure spelling divergence proven by the code is a `78` §8
   correction; anything touching a decision is this trigger.
4. The §4.9 golden cannot be produced without deviating from a §4.6 or §4.7 row — the golden
   and the tables are one specification; a contradiction between them is a planning defect,
   not a choice.
5. `EmitError::OrderingCycle` is ever returned by a test — §4.8 argues it unreachable; evidence
   otherwise means the dependency producers are wrong.
6. Step 13 finds the weld WO's entry point differing from what its Deliverables state, or
   WO-03's parser refuses any line of the §4.9 golden. (That WO-03 itself names no text-to-graph
   entry point is already known — its §4.8 defers the weld — and is priced into step 12's
   preconditions; rediscovering it is not an escalation.)
7. Anything seems to need a `Phase`/`LineForm`/retract machinery, a wrapping renderer, a
   clipboard, an explain resolver, a `fex` or predicate evaluator, a dictionary file, or a hash
   implementation — all deliberately absent (§8, §10).
8. Any change to the schema checker's two-warning baseline (G6), for any reason.

## 8. Non-goals

Deliberately not in this work order; citing a non-goal to justify extra work is the §9 row-1
failure.

1. **No UI, no clipboard, no wrapping.** `53` §6's copy layers and `13` §13's `WrapPolicy` are
   consumers of `EmittedLine.text`; this crate only guarantees the text they need (one unwrapped
   logical statement per line).
2. **No diff, verify, rollback or change sets** — doc `18`'s territory, later. Hence no
   `LineForm` (`Retract`/`Deactivate`/`Reorder`), no `Phase`, no `Reversibility`, no guard /
   commit / verify blocks (`13` §4.1 ranks 10, 90, 95).
3. **No second platform and no `SyntaxFlavour`** beyond junos set-statements — no PAN-OS, no
   IOS, no brace rendering (ADR-0030's second platform lands with the trait shape, §12 item 1).
4. **No statement dictionary and no template engine.** `13` §6.1's rejection of templates
   stands; the `14` §6.4 / `62` §19 dictionary reconciliation is §10 item 2, planning-owned.
5. **No plumbing statements** — the card's five pieces (`st0` family/address, zones,
   host-inbound, static route, security policy) and the `Device`-scope emit unit are the next
   emitter WO; `LogicalUnit`, `Zone`, `StaticRoute`, `SecurityPolicy` emitters do not exist here
   (`LogicalUnit` is read for naming only).
6. **No rule-engine wiring** (`12` §10.5's `RemediationInstance` consumes `EmittedLine` later;
   `rules_applied` is not carried this slice — §12 item 1).
7. **No `LineId`** (`13` §2.3 requires a blake3-128; no hash exists and no dependency may —
   §10 item 1).
8. **No defaults subsystem** — the store never holds `Default` (WO-02), and this emitter never
   invents one (§4.4).
9. **No schema changes of any kind.**

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | A schema fact hand-copied into the crate (an emit marker, a field list) drifts from `schema.yaml` | The coverage tests load `SchemaTree` from `schema/` on every run; a marker change turns G3 red |
| 2 | A token is guessed for an unmapped value and a wrong line lands in a firewall | §4.7's tables are closed with `TokenUnmapped` as the only other outcome; `token_unmapped_blocks_with_value` pins it |
| 3 | A `Set` value is silently not emitted | Every non-emitted `Set` outcome in §4.4/§4.6 is a named `Blocker` or `GapEntry`; `parts()` is the only accessor (13 §7.2); `render_config` refuses over blockers |
| 4 | A hasher seed or clock leaks into output order | G7's grep; the determinism test pair; `BTreeMap`/`Vec`/sort only (§4.8) |
| 5 | The `SecretHint` reaches emitted text, a ticket, or a paste | `psk_renders_the_placeholder_never_the_hint` — the crate-side twin of `dict.secret.interpolated` (62 §19.4) |
| 6 | The golden is regenerated from a failing run instead of fixed | §4.9 names this gate laundering; `78` §5.5 forbids it; the golden bytes live in this document, not only in the test |
| 7 | The round-trip gate is weakened to graph equality — which `13` §11.1 proves impossible — and then "passes" vacuously or fails misleadingly | G8 states E1's fixed point as the criterion; §12 items 3 and 6 record the narrowings and why |
| 8 | The execution session "helpfully" builds the trait, the dictionary, a predicate evaluator or a plumbing emitter | §7 triggers 2 and 7; `78` §9.1's obedient-improviser control — any public name outside §4 fails PR review |

## 10. Open decisions

Deliberately not decided here; owner or planning session only (`78` §7). This section doubles as
the escalation inbox under `78` §4 step 2.

1. **`LineId`.** `13` §2.3 specifies blake3-128 over (platform, path, form); no hash exists in
   the workspace and the zero-dependency position excludes the crate. A first-party hash, a
   different stable-id scheme, or deferral until the UI needs line identity — planning, with
   `13` §2.3 on the table.
2. **The dictionary reconciliation.** `13` §6.1 decides a typed emitter (*"a template with a
   conditional in it is a template with an untested branch"*); `14` §6.4 decides *"parsing and
   emission share one table"*; `62` §19 gives that table its content spec, and `13` §16 OD-3
   sketches the synthesis (dictionary rows compiled into the same machinery, branches stay in
   Rust). WO-03 §4.7 has since pinned the parse half: the statement dictionary ships as corpus
   data under `corpus/dict/junos-srx/`, with the `emit`/`explain` halves deliberately omitted
   (its §12 item 1) and their landing deferred to *"the emitter and explainer WOs"* (its §10
   item 7). The open question is therefore concrete: whether and when §4.6's crate-const emit
   tables migrate into that same dictionary — one shared table per `14` §6.4, or two
   co-verified halves — before a second platform duplicates the knowledge. The one live
   `emit_dict:` hook (`ExternalInterface`, whose dictionary id WO-03's entry 19 must match
   exactly) and the not-yet-checkable `dict.*` gates wait on the same decision. Planning, with
   WO-03 §4.7 and this document's §4.6 open side by side.
3. **Token-table and statement-table extension**, with sources: the remaining P1/P2 algorithm
   spellings, `v1-only`, `group<N>` beyond 14, `ah`, `responder-only`, `lifetime-kilobytes`,
   `description` quoting, and the `Dpd`/`IkeId`/`VpnMonitor` value shapes (which are store/
   planning decisions before their statements can exist).
4. **The placeholder discriminator** (`<PSK:SITE-B>`, `13` §10.1): the derivation rule and where
   it lands (WO-01's `SecretPlaceholder` API, or this crate's rendering). Until decided, `<PSK>`.
5. **The next emitter slice**: `Device`-scope emit units, the plumbing blocks (ranks 40–44
   and 50; the guard block, rank 10, is `18`'s territory with commit/verify — §8 item 2),
   `Zone`/`StaticRoute`/`SecurityPolicy` coverage, and the `KindEmitter` trait shape for the
   second platform.
6. **Where `Risk` lives long-term.** Defined in `fathom-emit` this slice; the rule engine takes
   risk *"from the emitter"* (`12` §10.5), so a shared home may be wanted when `12` is built.
7. **The round-trip preconditions (G8).** Two facts, both verified against the documents on
   disk, keep step 13 unrunnable until planning acts; step 12 (c) checks this item for the
   record of their resolution and nothing else.
   (a) *No text-to-store entry point exists or is specified anywhere.* WO-03 delivers
   `ingest(paste: &[u8], dict: &dict::Dictionary) -> Result<IngestOutput, IngestRefusal>`
   producing a fragment; the fragment-to-store weld — provenance records, ULID minting,
   reconciliation — *"are the weld WO's work"* (WO-03 §4.8), and that work order is unwritten.
   Planning must author it before step 13 has anything to call.
   (b) *Nothing sets `IpsecVpn.mode` in a re-parsed graph.* The schema declares `mode`
   `card: "1"`, `emit: R`; §4.6 reads it `need`-first and emits no statement for it; WO-03's
   dictionary entry 30 binds only the `BindsInterface` edge, and no entry binds `mode`. So
   `parse(golden)` leaves `mode` `Unknown`, the second emit blocks with `RequiredUnknown`, and
   `render_config` refuses — G8 cannot go green until something makes `mode` `Set`. Candidate
   resolutions — a weld-time or dictionary-level rule deriving `RouteBased` from a
   `bind-interface` statement, or a new `mode`-bearing statement row — belong to WO-03, the
   weld WO or planning, never to this crate: an emitter-side inference would invent a value
   the user never chose (§4.4).

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants 1–3, 6, 7, 9; the risk enum and ADR-0011 amendment; terminology; explainer-ID forms; document conventions |
| `CLAUDE.md`; `docs/70-ops/78-execution-protocol.md` (whole) | Session rules; the inherited-constraint table; escalation; the floor; the WO shape |
| `docs/10-core/13-emitters-and-provenance.md` (whole) | The emitter definition; `EmittedLine`/provenance spec; `StatementPath` P1–P3 and §3.2; blocks §4; ordering §5.3–§5.7; architecture §6; pipeline §7; representability §9; placeholders §10; round-trip §11; wrapping §13; OD-1/OD-3 |
| `docs/10-core/11-ir-schema.md` §9.1–§9.2 (and §4.6 via the schema doc) | L2's blocker clause; the emit unit and the `IpsecVpn` closure; raw-wins interface naming |
| `docs/10-core/12-rule-engine.md` §10.3, §10.5 | `Finding.remediation` consumes `EmittedLine`; `aggregate_risk` *"takes it from the emitter"* — shaped for, not wired |
| `docs/10-core/14-parsers-and-ingest.md` §6.4 | The shared-table decision and the emit-only data (ordering, defaults suppression, blockers) — quoted for §10 item 2 |
| `docs/60-content/62-schema-spec.md` §3.1–§3.2, §10, §12.3, §19 | `emit:` semantics; `emit_required_when`; `DeclaredGap` and `schema.emit.unread`; the dictionary content spec and `dict.*` gates |
| `docs/50-design/53-interaction-and-keyboard.md` §6 | The copy contract: unwrapped logical lines, emit order, `EmittedLine.text` holds one statement |
| `docs/70-ops/79-work-orders/WO-01-the-scalar-trait.md` §4, §8, §12 | `canonical()`; the `SecretPlaceholder` API; the deferred per-platform halves; the narrowing precedent |
| `docs/70-ops/79-work-orders/WO-02-the-graph-store.md` §4.2 | The store API consumed; three presence states; `FieldBag` serves `Set` only |
| `docs/70-ops/79-work-orders/WO-03-ingest-junos-srx.md` §§1, 4.7, 4.8, 10, 12 | `ingest`'s signature and `IngestOutput`; the 38-entry parse dictionary (rows 15, 19, 30; the deliberate dpd exclusion); the weld deferral quoted in the dependency line and §10 item 7; the emit-half deferral cited in §10 item 2 |
| `.context/field-card-srx-ipsec.txt` side 1 | Every statement shape and the golden's order |
| `schema/schema.yaml` (kinds at lines ~551–676; edges at ~1486–1566, ~1280–1301; `classes:` at ~100) | Every `emit:` marker, edge bound, class expansion and doc line cited in §3–§4.6 |
| `crates/fathom-schema/src/gates.rs`; `src/model.rs` | The live `schema.emit.on-inert` gate and its message; `FieldDecl.emit` / `KindDecl.emits` for the coverage test |
| `crates/fathom-ir/src/generated/{ir_types.rs,accessors.rs}`; `src/{value.rs,bag.rs}` | Enum variants incl. `Unknown(String)` arms; `UsesProposalField::Ordinal`; every accessor named in §3; `PeerSpec`/`Dpd`/`IkeId` shapes; `typed` |
| Root `Cargo.toml`, `rust-toolchain.toml` | The zero-dependency comment; the 1.94.1 pin; the members list |
| `cargo test --workspace`; `fathom-schema-check` (run 2026-08-02) | 80 passed / 0 failed; exit 0, `0 failure(s), 2 warning(s)`; `schema.emit.unread` in the not-yet-checkable list |

## 12. Disagreements

1. **Against `13` §2.2/§2.4/§5.4/§6.2–§6.4's shapes as written.** The specced types use
   `CompactString`, `SmallVec`, a `LineId`, `LineForm`, `Phase`, `Reversibility`,
   `rules_applied`, an `ExplainKey` type, a `Platform`/`KindEmitter` trait registry and a
   typestate builder. This WO ships `String`/`Vec`, no `LineId` (§10 item 1), assert-only lines
   (no forms, no phases — nothing retracts before `18` exists), no `Reversibility`, no
   `rules_applied` (no rule engine), explain keys as strings, and private kind-emitter functions
   (§4.3's DECISION). Reasons: the zero-dependency position removes the container crates
   outright, and every cut item's only consumer is a subsystem that does not exist yet. The
   observable contracts — provenance on every line, the report inseparable from the lines,
   deterministic total order, one logical statement per `text` — are all kept and tested. The
   platform halves extend these types later without changing them; if the split is wrong, the
   correction lands in `13`, not silently here. The same narrowing covers placement: `13` §2.5,
   §4.2 and §9.1 put the idempotency classes, the block table and the gap declarations in the
   corpus, each with a citation and a named reviewer (invariant 10); this slice ships all three
   as crate consts with no `reviewed_by` — content sourced from `13`'s own text and the card —
   and their migration into reviewed corpus data is §10 item 2's question.
2. **Against `11` §9.2's "depth-first pre-order".** Pre-order of the `IpsecVpn` closure puts the
   root's own lines first, which contradicts the same sentence's claim that the traversal
   *"reproduces the object-chain ordering the card teaches"* — the card puts the proposal first
   and the vpn last. §4.5 uses post-order, which does reproduce the card; the sentence's content
   wins over its traversal word. Worth a one-word correction in `11` when it is next opened.
3. **Against this work order's own brief-level phrasing "graphs must be equal".** `13` §11.1 is
   explicit: *"`parse(emit(g)) ≠ g`, always, and correctly"* — provenance origin, defaults
   collapsed to `Absent`, `Unknown` collapsed to `Absent`, fresh ULIDs. The flagship gate G8 is
   therefore E1, the text fixed-point plus report agreement (as narrowed in item 6), which is
   the property `13` §11.1 states and the one a test can honestly hold.
4. **The `FieldRef` name collision** (`12` §5.1's static pair vs `13` §2.2's instance triple) is
   inherited knowingly: this crate ships the instance-level type under the name `13` gives it,
   and the rename of the rule engine's is `13` §16 OD-1's business, not this session's.
5. **`53` §6.3.1 / `13` §13.3 wrapping.** No `WrapPolicy` machinery ships at all — with no
   renderer and no clipboard in scope, `EmittedLine.text` being unwrapped satisfies the
   clipboard half of the contract trivially, and the display half lands with the UI.
6. **Against `13` §11.1 E1's agreement clause as literally written.** E1 requires *"the two
   `EmitReport`s agree on gaps and substitutions"*. This crate's gap ledger is
   presence-dependent (§4.2: an entry exists only when the gap field is `Set` or explicitly
   `Absent`), and the golden text cannot carry `dpd` (no statement exists for it — the very
   reason it is a gap; WO-03 classes `dead-peer-detection` lines as `Unmapped` residue) or a
   `SecretHint` (the binder constructs `SecretPlaceholder::new(Psk)` hintless — WO-03 §4.8;
   `11` §4.5). Literal agreement is therefore provably unsatisfiable: the first report carries
   the `GW-B.dpd` gap and the vault hint, the second cannot. G8 states the honest form —
   byte-equal rendering; substitutions agreeing on token, line index and label with
   `hint: None` on the second; the second gap set empty and a strict subset of the first's.
   If `13` wants a different agreement semantics for presence-dependent ledgers, the
   correction lands there, not silently here.
7. **Correction of this document's own prior state (this revision).** The original authoring
   claimed the queue held only WO-01 and WO-02 and *"no WO-03 file"*, and framed G8 against a
   WO-03 imagined to deliver a text-to-graph entry point. Both claims were false when written:
   `WO-03-ingest-junos-srx.md` was on disk before this file (file times 00:34 vs 00:42,
   2026-08-02), as were WO-05 through WO-08, and the WO-03 on disk delivers a fragment and
   defers the store weld to a separate work order. §3's queue bullet, the dependency
   paragraph, §5 steps 12–13, §6 G8, §7 trigger 6, §10 items 2 and 7 and §4.10's round-trip
   row are rewritten in this revision against the WO-03 actually on disk. No decision in §4's
   tables or types changed; this revision's only other §4 edits are the compile-correct
   `typed::<u8, _>` spelling (§4.5 — `bag.rs` takes two type parameters), the explicit
   `src/junos.rs` placement G9 already pinned mechanically (§4.6, §5 step 6), and §4.9's
   explicit statement that the fixture's `GW-B` carries `dpd` `Set` — a fact the report
   clause's `GW-B.dpd` gap entry already required implicitly.
8. **Correction (`78` §8) — the conflict fixture differs in `lifetime_seconds`, not
   `dh_group`.** §4.10's `duplicate_path_conflict_blocks_render` row sketches the fixture as
   *"two proposals both named `IKE-P1` with different `dh_group` under one policy → one
   `EmitConflict`"*. The code proves that setup cannot produce a conflict: §4.7's `DhGroup`
   table ships exactly one row (`14`), so of two differing `dh_group` values at most one
   renders and the other is `Blocker(TokenUnmapped)` — one `dh-group` line, no shared path, no
   `EmitConflict`, and `render_config` refusing with `Blockers` rather than the stated
   `Conflicts`. The shipped fixture keeps everything else in the row — two `IkeProposal` nodes
   both named `IKE-P1` under one `IkePolicy`, one `EmitConflict`, `render_config` →
   `Conflicts` — and differs them on `lifetime_seconds` (28800 vs 3600), the one emitted field
   whose values both render through §4.7 (`Scalar::canonical()`, no closed table). No decision
   in §4 changes: §4.7's table is honoured exactly, and the assertions §4.10 states are the
   ones the test makes. Proving paths: `crates/fathom-emit/src/junos.rs` (`token_dh_group`),
   `crates/fathom-emit/tests/blockers.rs` (`duplicate_path_conflict_blocks_render`).
9. **Correction (`78` §8) — the `READS_*` / `GAPS_*` tables are `pub`, not crate-private.**
   §4.6 says they are *"public within the crate for the coverage test"*, and §4.10 puts that
   test in `tests/coverage.rs` — an integration test, which is a separate crate and cannot see
   `pub(crate)`. The two cannot both hold, so the tables ship `pub` inside the `junos` module
   §4.1 already names, reached as `fathom_emit::junos::READS_IKE_PROPOSAL` and so on. No name
   outside §4.6's own list is created, the placement G9 greps is unchanged
   (`crates/fathom-emit/src/junos.rs`), and no decision moves. Proving path:
   `crates/fathom-emit/tests/coverage.rs`.
10. **Correction (`78` §8) — §3's workspace and queue facts have moved on.** §3 records six
    crates and no `fathom-graph`; the tree now holds nine — WO-02 landed `fathom-graph`
    (consumed here exactly as §3 cites), WO-03 landed `fathom-ingest`, WO-07 landed
    `fathom-wasm`. §3 also records WO-03 as `BLOCKED`; its status line reads `DONE`
    (`docs/70-ops/79-work-orders/WO-03-ingest-junos-srx.md`). Neither changes a decision here:
    of §5 step 12's three preconditions, (a) now holds, and (b) — a fragment-to-store weld work
    order with status `DONE` — and (c) — §10 item 7 recording resolved decisions — both still
    fail, so the step-12 terminal state is unchanged. `00-INDEX.md`'s own banner names the weld
    order as the one in the critical path that does not exist yet.
