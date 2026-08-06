# WO-08 — The inventory face: the artifact, the estate as a table, and the per-equipment page

> **Status:** BLOCKED on WO-01 (the `Scalar` trait), WO-02 (the graph store), WO-07 (the WASM module)

The first product surface a user sees — `76` §7.2's S4 slice, part one: *"The virtualised table,
the kind-plus-filter row set, the generated column picker, the nested device→interface rows, the
inspector, the `Cabled peer` navigation cell"* — the row `76` marks **"The first user-visible
thing in the plan"**. This work order delivers the browser artifact itself (WO-07 §1: *"The HTML
artifact around the module, and the CSP gate X0.8 that runs against its final bytes, are
WO-08's"*), the inventory view, the inspector, and the per-equipment page with cabled-peer
navigation, over a deterministic demo estate constructed in code. The rest of S4 — the generated
column picker as a UI, nested rows inside the inventory table, in-cell editing, sorting — is
deliberately deferred (§8).

Depends on: **WO-01** (`Scalar::canonical()` — every scalar-typed cell renders through it),
**WO-02** (`fathom-graph` — the store every projection reads), and **WO-07**
(`crates/fathom-wasm` — the module, the `(ptr, len)` ABI and the byte protocol this work order
extends; the release profile, the wasm32 target and the artifact-gate tests that re-run over the
module as this WO leaves it). WO-07 deliberately ships **no HTML, no CSP, no byte of JS or TS,
no furniture and no fixture entry point** (WO-07 §1, §8: *"No HTML is assembled, no CSP is
written, no byte of JS or TS is produced"*) — the artifact, its furniture, its boot path and gate
X0.8 are therefore **this work order's deliverables, not its assumptions** (§4.4–§4.5). This work
order is taken only when all three are DONE, and §3.2's stated contracts are re-verified against
the merged tree first (`78` §3 step 5; a divergence is recorded under `78` §8 or escalated under
`78` §4, nothing else). **WO-05 is not a dependency**: the estate this face renders is built in
memory by checked-in code; loading a user's saved workspace into this face arrives with WO-05 and
is a non-goal here (§8).

Execution protocol: `docs/70-ops/78-execution-protocol.md` governs this work order. Every
constraint in `78` §2 is inherited and not restated here — invariants 1–3 and 9, ADR-0008, zero
external dependencies (*"That is a position, not an accident"*), the 1.94.1 toolchain pin and
`#![forbid(unsafe_code)]`, the risk enum, house style. `78` §4's escalation rule applies to every
trigger in §7 below. Severity labels in any verification context are exactly
BLOCKER / MAJOR / MINOR (`78` §2).

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

When this work order is DONE, `cargo run -p fathom-artifact` assembles
`target/artifact/fathom-dev.html` — one HTML file: a hand-authored shell source plus two
deterministic splices, `design/tokens.css` and the base64 `fathom-wasm` module (`42` §8.2's
mode-A mechanism: *"base64 WASM → instantiated from a Uint8Array, never fetched"*), carrying
`43` §3.7's CSP with `connect-src 'none'` asserted against the **final bytes** (X0.8, `71` §3.6).
Opening that file from disk with zero network and pressing `⌥6` renders the demo estate as a
table: a kind strip (`Device` · `PhysicalPort` · `Premises`), columns drawn from
`schema/schema.yaml`'s field names, hairline row rules and no vertical rules, and the opinions
column present at the right edge, sticky, and honestly empty — because no rule engine is in the
build, and the column is structural (`52` §3.7.1), so it stays. Selecting any row posts it to the
inspector column: the field/value/provenance table of `54` §18, with the node ID shown in full
and never truncated, and `unset` distinguished from `absent`. Switching the inspector to its
equipment face turns the selection's device into the per-equipment page: the identity fields,
then **Ports** — every physical port, named by its silkscreen, with the cabled peer as a
navigation cell — then **Interfaces** — every configuration object and its units. Ports and
interfaces are never conflated: *"A PORT EXISTS BECAUSE HARDWARE EXISTS. AN INTERFACE EXISTS
BECAUSE CONFIGURATION EXISTS. NEITHER MAY BE THE OTHER'S IDENTITY."* (`19` §3.2). Clicking a
cabled peer lands on the far equipment's page — `76` §4.2: *"A 'go to cabled peer' action is one
graph hop and one selection construction."*

Everything renders from a `fathom-graph` workspace held **inside the WASM module**, one boundary
crossing per user intention (ADR-0019): this work order extends WO-07's byte protocol with four
opcodes and one record kind (§4.4), all decided here down to the offset. The projections — row
sets, column values, the equipment page, the element page — are Rust, in a new crate, natively
tested by `cargo test` against the checked-in deterministic demo estate; the JS in the artifact
renders reply strings into the prototype's markup and never computes a join. The rendered face is
verified by a documented manual checklist (§6 G10), because the e2e harness `45` §9.1 specifies
is built on external crates the tree does not have and may not gain (§10).

## 2. Binding sources

| Source | What it binds | The line that binds |
|---|---|---|
| `76` §7.2 (S4 row) | This slice's scope and its place in the order | *"The virtualised table, the kind-plus-filter row set, the generated column picker, the nested device→interface rows, the inspector, the `Cabled peer` navigation cell"* — *"The first user-visible thing in the plan"* |
| `76` §4.2 | The peer traversal's size and shape | *"A 'go to cabled peer' action is one graph hop and one selection construction."* |
| WO-07 §1, §8 | What WO-07 ships, and what it hands here | *"The HTML artifact around the module, and the CSP gate X0.8 that runs against its final bytes, are WO-08's"*; *"No HTML is assembled, no CSP is written, no byte of JS or TS is produced"*; the eight unimplemented opcodes *"are refused by number"* |
| WO-07 §4.3–§4.5 | The ABI, the reply skeleton, the error codes 1–5, and the reference reader this WO's JS mirrors | `fathom_alloc` / `fathom_free` / `fathom_call`; `decode_reply` is *"the reference reader — the decoder tests parity against, and the byte-level specification WO-08's TypeScript reader mirrors"* |
| `41` §3.7 | The opcode table this WO extends, and the extension rule | *"Opcodes. Stable forever; a new call is a new opcode, never a changed one."* — `OP_INIT` 1 … `OP_STATS` 10; the face opcodes take 11–14 (§12 item 8) |
| `41` §3.3 | The T2 reply skeleton and the taken record kinds | record_kind *"1=Finding 2=EmittedLine 3=FinderRow 4=Point"* — kind 5 is the first free number and is the face's (§4.4) |
| `41` §3.4 | The read model the JS reader obeys | *"zero-copy in, decode-lazily out"*; one `TextDecoder.decode` of the string blob per reply |
| `41` §3.10 | The rule for the artifact's one `S` object | *"the shadow holds only what is rendered, is rebuilt from the delta stream, and is never written to"* |
| `43` §3.7 | The D1 CSP the artifact carries — two scaffolding substitutions, stated in §4.5 and §12 item 7 | the fenced `<meta http-equiv="Content-Security-Policy" …>` block, `connect-src 'none'` |
| `71` §3.6 X0.8 | The ship gate this WO makes real | *"CSP of the shipped artifact contains `connect-src 'none'`, asserted against the final bytes, not the template"* |
| `42` §8.2 | The embedding mechanism | *"base64 WASM → instantiated from a Uint8Array, never fetched"*; *"Nothing in that file is fetched."* |
| `45` §9.1 | The fixture entry point's shape | *"Fixture loading is one URL parameter"* — `?fixture=…`, *"dev-build only"* |
| `52` §3.7 | What the inventory is | *"The estate as a table — and the thing NetBox structurally cannot do: **the inventory has opinions**"*; *"The row set — a kind plus a filter. Default kind is `Device`"*; *"Columns are kind-dependent and chosen from the schema (`11` §11.6 makes the schema data, so the column picker is generated, not hand-written)"* |
| `52` §3.7.1 | The opinions column is structural | *"The rightmost column of every inventory table is not a field. It is the per-row finding aggregate, rendered as text: `3 high · 1 med`, or `—`."* |
| `52` §2.3 (ADR-0025 amendment) | The inspector is the second column, not a panel | *"The pinned pane and `54` §18's inspector are **the same surface**: there is one second column, at 62/38."* |
| `52` §9.5 | Why the equipment page is a face, never a view | *"Six views fit. If a seventh is ever added, this design has a real problem and an overflow menu would be hiding it"* |
| `52` §3.8 (governing rules) | Selection across view switches | *"A view switch never changes the selection."* / *"A view switch never scrolls the previous view."* |
| `54` §18 (Inspector) | The field table's shape and the ID rule | field/value/provenance as *"a real `<table>` with `<th scope=\"row\">`"*; per-row provenance is *"a plain `<td>` in `--muted`, not a margin tab"* (R48/ADR-0025); *"The node ID is shown, in full, and never truncated"* |
| `53` §3.1 | The view keys | `⌥1` … `⌥6` → *"finder · walkthrough · config · findings · diagram · inventory"*; `⌥←`/`⌥→` *"Does not wrap"* |
| `53` §3.7 | What `Esc` does here | *"`Esc` unwinds exactly one level"* — rungs 6–8: multi-selection → anchor; selection → clear; *"`Esc` on an empty state does not navigate anywhere"* |
| `53` §8.3 | The list contract | *"Every list — finder results, config lines, findings, inventory rows, walkthrough steps, ladder steps — is **one tab stop**."* |
| `19` §3.2 | The identity law this page renders | *"A PORT EXISTS BECAUSE HARDWARE EXISTS. AN INTERFACE EXISTS BECAUSE CONFIGURATION EXISTS. NEITHER MAY BE THE OTHER'S IDENTITY."* |
| `19` §3.3 | What the port's `label` is | *"The silkscreen: `1`, `PON 0/1`. **Not** the interface name"*; `speed_max` v `Interface.speed`: *"two numbers about the same link measuring different things"* |
| `19` §3.7 | Which kinds reach hardware | *"`from` is `[Interface]` only"* — *"`reth0` and `ae0` reach hardware through their **members** … `st0` reaches nothing"* |
| `schema/schema.yaml` `LogicalUnit` doc | Unit naming is a rendering | *"st0.0 is rendered from (TunnelInterface st0, index 0), never stored joined (11 §4.6)."* |
| `44` §4.7.4 | Why this face exists at scale | *"an engineer who wants to see their whole 200-device estate on one screen cannot, and will say so. The answer is the inventory table (brief §6.4), which is virtualised, sortable and actually usable at that scale."* |
| `44` §4.3 (B5) | The only virtualised-row numbers `44` has | *"6–9 ms for rendering 25 virtualised rows"*; counter `dom_nodes_created` = *"25 rows × 9 nodes = 225 — virtualised list, no more than one rebuild"* (the finder's budget; `44` sets **no** per-row inventory budget — see §8 item 8) |
| `42` §1.2 | The no-Node position this face lives under | Z2: *"No npm package is installed or executed in any build stage that can influence an artifact byte"*; Z5: *"A developer can build, run and test the product on a machine with no Node installed"* |
| `42` §2.1 (quoting `35` §6.2) | Why no bundler is needed | *"a single-file artifact has a trivial bundling problem — the 'bundle' is a concatenation in a fixed order."* — `fathom-artifact` is that concatenation, first-party |
| ADR-0019 §Decision | The UI's architecture | *"Vanilla TypeScript over a first-party render layer capped at 800 lines. No UI framework. No Rust-native UI."*; *"one WASM crossing per user intention"*; *"Views are pure functions of typed data."* (see §12 item 1 on the language) |
| `45` §9.1 | The e2e harness — specified, absent | *"`fantoccini`/`thirtyfour` over WebDriver, plus `chromiumoxide` over CDP … driven from `cargo test`. No Node, no Playwright."* — external crates; not in the tree; a dependency is *"an escalation, always"* (`78` §5 item 2) |
| `51` §10, §11, §12 | The design law the face inherits | radius: *"--radius: 0"*, auditable by grep; elevation: *"There are no floating panels … A tooltip does not exist"*; motion: *"**The product has no animation** (amended per M34)"* |
| `design/tokens.css` (transcribing `51` §14) | The token law | *"Everything else in the product references these names and declares no hex, no px font sizes and no durations of its own. (51 §14, opening sentence.)"* |
| `55` §1.4 | No content behind hover | *"There are no tooltips and no popovers. `51` §11: disclosure is inline and pushes content down"* |
| `design/prototype/fathom-app.html` | The fidelity bar for everything visual | §3 below itemises what it demonstrates; its inventory and equipment regions are the spec for look and behaviour |
| RFC 4648 §4, §10 | The base64 encoding `fathom-artifact` hand-rolls, and its test vectors | `"foobar"` → `"Zm9vYmFy"` |
| `.context/conventions.md` invariant 7 | Rows reference IDs | *"Every node, edge and field carries a stable opaque ID. Rules, explainers, emitters and diagram elements reference IDs, never paths or names."* |

## 3. Prior state

Verified against the working tree on 2026-08-02 (`cargo test --workspace`: 80 passed, 0 failed;
`fathom-schema-check`: exit 0, `0 failure(s), 2 warning(s)`, the standing `Site` baseline).
Because this work order is BLOCKED on three others, §3 splits into what is **in the tree now**
and what is **contracted by the blocking work orders**; the executing session re-verifies both.

### 3.1 In the tree now

- **Workspace.** Six crates (`fathom-corpus`, `-find`, `-id`, `-ir`, `-schema`, `-schemagen`);
  `[workspace.dependencies]` empty on purpose; no UI code, no WASM target, no e2e harness, no
  rule engine, no derived-field engine, no explainer surface anywhere in `crates/`.
- **`crates/fathom-id/src/lib.rs`.** `Ulid::from_parts(timestamp_ms, random)` (no clock, no RNG);
  `Ulid::encode() -> String` — the *"26-character Crockford encoding, always uppercase"* (its own
  doc line) — and `Ulid::decode(&str) -> Result<Self, DecodeError>`, which refuses any length
  other than 26 (`DecodeError::Length`). This WO's `parse_display_id` uses that round-trip;
  nothing new is hand-rolled. A display id `fathom:device:<ulid>` is therefore exactly
  14 + 26 = **40 characters** — the number §4.7's id test pins.
- **`crates/fathom-ir/src/generated/ir_types.rs`.** `NodeKind` (48) with `name()`; generated
  value enums (`ConformanceState`, `InterfaceForm`, `DeviceRole`, the `PhysicalPort` connector
  and service enums, …) each with `token(&self) -> &str` returning the schema token
  (`central_office`, `sfp_plus`, …). `FIELD_KEYS: [(&str, u32); 299]` maps wire names to keys.
- **`crates/fathom-ir/src/{scalar,value}.rs`.** Stub scalars (`Identifier(pub String)`,
  `Text`, `Clli`, `Bandwidth(pub u64)`, `InterfaceName`, `OsVersion`, `PlatformId`, …);
  value types `PostalAddress { lines, locality, region, postcode, country }` (all
  `scalar::Text`), `NameConformance { state, reason }`; `PortPosition` and `Transceiver` are
  **payload-less unit stubs** (*"Shape stated nowhere read"*) — the demo estate therefore never
  sets `position` or `transceiver`.
- **`schema/schema.yaml`** (all verified by reading the declarations): `Device` fields
  `hostname` (Identifier, 1), `platform` (PlatformId, 1), `os_version`, `role`
  (enum incl. `firewall`, `router`), `cluster_id` (u16), `name_conformance` (derived, card 1);
  `Chassis` fields `member_index` (u8, 1), `model`, `serial`, `slots`; `PhysicalPort` fields
  `label` (Text, 1), `position`, `connector`, `service`, `speed_max` (Bandwidth), `transceiver`,
  `notes`, `occupied` (derived — doc: *"True iff at least one Interface Occupies this port"*;
  see §10 item 3); `Premises` fields `label` (1), `street` (PostalAddress), `clli` (Clli),
  `form` (enum incl. `central_office`, `hut`, `customer_premises`), `region`, `coordinates`,
  `notes`; `Site` fields `name` (Text, 1), `code`, `address`, `timezone`, `criticality`;
  `Cable` fields `label`, `assembly`, `media` (enum incl. `cat6a`, `twinax`), `length_m` (u32),
  …; `Interface` fields `name` (InterfaceName, 1), `form` (enum, 1), …; `RethInterface.name`,
  `TunnelInterface.{name, technology}` (`technology` card 1, enum incl. `ipsec_vti`);
  `LogicalUnit.index` (u32, 1). Edges: `HasDevice` Site→Device, `HasChassis` Device→Chassis,
  `HasPort` {Chassis, PassiveNode}→PhysicalPort, `HasInterface` Device→{Interface,
  AggregateInterface, RethInterface, TunnelInterface}, `HasUnit` InterfaceLike→LogicalUnit —
  all containment, `in: "1"`; `AtPremises` Site→Premises reference `out: "0..1"`, `in: "0..n"`
  (*"'several units at this address' becomes a count of in-edges, not a population scan"*);
  `Terminates` Cable→{PhysicalPort, ExternalPeer} `out: "0..2"` with field `end` (enum a|b);
  `Occupies` Interface→PhysicalPort with optional `lane`. `HasPremises` and `HasCable` are
  root containment — under WO-02, `Premises`, `Cable` and `Site` are forest roots with
  `owner() == None`.
- **`schema/platforms.yaml`.** Platform ids include `junos-srx` and `junos-mx`. There is **no
  Calix or Nokia platform id** (the vendors exist in the `vendors:` block only), so the demo
  estate uses `junos-srx` and `junos-mx` devices — no platform id is invented.
- **`design/tokens.css`.** The canonical tokens: `--radius: 0`, `--shadow: none`,
  `--motion-state: 0ms` (`--motion-disclosure` deleted per M34), the three risk pairs reserved,
  the spacing/type scales the prototype consumes. Font faces are a held `<!-- VERIFY -->` — the
  file renders from fallback stacks; nothing in this WO touches that. This file is one of
  `fathom-artifact`'s two splice inputs (§4.5): the artifact inlines it, never links it.
- **`design/prototype/fathom-app.html`** — 3,134 lines, one file, one subresource
  (`../tokens.css`), CSP meta `connect-src 'none'`, script header: *"Vanilla, no framework, no
  build step, and — check by grep — no fetch, no XMLHttpRequest, no WebSocket, no EventSource,
  no sendBeacon, no import(), no script src."* What it demonstrates, and what this WO therefore
  reproduces over real data rather than redesigns:
  - **The shell**: masthead (title/sub/ribbon/imperative), the always-visible risk legend, the
    view band driven by one registry array of six views (`finder` `⌥1` … `inventory` `⌥6`), a
    footer naming the current view (`View n of 6`) and its neighbours.
  - **The keyboard**: `Ctrl+K` toggles the finder overlay *"from anywhere, including inside a
    text field"*; `⌥` *"owns view management. Bounded, never wrapping (53)"* — digits via
    `e.code` `Digit1`–`Digit6`, `⌥←`/`⌥→` stop at the ends; one document-level `Escape` handler
    with a stated priority ladder (hover chip → finder → expanded groups → selection); the
    roving contract — *"a list is ONE tab stop; arrows, Home and End move within it"* — as one
    shared `data-rove`/`data-rove-item` implementation.
  - **The inventory view (region 12)**: a kind strip (`KINDS = ['Device', 'PhysicalPort',
    'Service', 'Tenant', 'Premises']`, label *"kind — a row set is a kind plus a filter"*);
    per-kind column sets (`KCOLS`) with the note *"Columns are generated from schema.yaml's
    field names (M7)"*; an `.inv` table with uppercase micro headers, hairline row rules, mono
    cells, `tr[data-tier]` selection tinting; the opinions column as a **sticky** rightmost
    column (*"The opinions column is not a field — it must never scroll out of view"*); cell
    elision at word boundaries via a per-column `clip()` (*"the full sentence lives in the
    meaning column when the row posts … never a mid-word clip"* — not transcribed here, §4.6);
    notes below the table in the 4px-accent idiom, including the fixture honesty note
    (*"Fixture · not corpus data"*).
  - **The inspector (meaning column)**: three faces — meaning · equipment · transcript; posting
    an element renders a `.kv` field table headed *"Fields — generated from schema.yaml"*.
  - **The equipment face (region 8)**: *"The per-equipment page is the INSPECTOR GROWN (52 §2.3
    as amended by R35/ADR-0025: the pinned pane IS the inspector, one second column). It is NOT
    a seventh view — 52 §9.5."* Header, identity `.kv` rows, then *"Ports — every one, named.
    The picture states the count; the column states the names (59 §3.8)"* as a four-column
    table whose `cables to` cell is a button carrying `data-far`; activating it sets the face
    to equipment, posts the far device, and the footer reads `followed the cable to <name>`;
    the same-device case renders `itself · <port>`.
  - **The 1.4.13 hover surface (region 16)**: *"dismissible with Escape, hoverable, persistent,
    and opens on focus as well as hover"* — the decided pattern, used by the **config** view's
    buffer lines only. Note `55` §1.4 and `51` §11 forbid hover-only content generally, and
    neither cites SC 1.4.13 by number; the pattern lives in the prototype and
    `design/walkthrough/st0-notepad.html`. **This face ships zero hover surfaces** (§4.6).
  - **State**: one `S` object — *"The views are renderings of one selection over one graph — a
    view that holds state the others cannot see has become a second application (52, governing
    rule)"*; *"a view switch never changes the selection"*; *"a view switch never scrolls the
    view you left"*.
  - **Code idiom, not carried**: the prototype builds DOM through `innerHTML` (45 occurrences,
    grep run 2026-08-02). The artifact does not (§4.5): `43` §3.7's
    `require-trusted-types-for 'script'` ships and must hold, so the shell source builds DOM
    with `createElement`/`textContent` only. The prototype is the fidelity bar for look and
    behaviour, not for code idiom.

### 3.2 Contracted by the blocking work orders (re-verify at execution)

- **WO-01** delivers `fathom_ir::Scalar` with `fn canonical(&self) -> String` implemented by
  **35 of the 36 `fathom_ir::scalar::*` binding targets** — not all 61 schema scalars:
  `SecretPlaceholder` is the one registered exemption, and the 25 `structured: true` bindings in
  `fathom_ir::value` are untouched (WO-01 §1: *"its canonical serialisation and total order land
  with the store, not here"*; 61 = 36 + 25, per `fathom-schema-check`'s `61 scalars` line).
  §4.3's member-wise rendering rules for `PostalAddress` and `NameConformance` exist precisely
  because those structured types carry no `canonical()` yet. Every scalar type the demo estate
  renders is in the 35, and every **literal** cell §4.8 pins is `Identifier`, `Text`, `Clli` or
  `PlatformId` — WO-01 §4.2 rows 20, 27, 30 and 33, whose canonical forms all read *"as
  written"* (`Clli`: *"as written, upper case"* — §4.8's clli literals are already upper case).
  `Bandwidth` and `OsVersion` canonical forms are WO-01's; this WO's tests bind to them **by
  calling `canonical()`**, never by restating the format (§4.3).
- **WO-02** delivers `crates/fathom-graph`: `Graph`, composite `NodeId { kind, ulid }` /
  `EdgeId` / `ElementId` with `Display` rendering `<kind-lower>:<ulid>` (no product-name prefix —
  ADR-0005; the ULID's
  26-character Crockford encoding); `begin_batch`/`end_batch`; `insert_node`/`insert_edge`/
  `set_field`/`assert_absent`; `nodes_of_kind`, `out`, `inn`, `owner`, `device_of`, `presence`,
  `provenance`, `resolve_ref`; `FieldBag` on `Node`/`Edge` serving `Set` slots only;
  `StoredPresence { Set, Absent, Unknown }`; generated `NodeKind::fields()`, `EdgeKind`
  endpoint/bound tables, and `slot_type(key) -> Option<(TypeId, &'static str)>`. Iteration is
  NodeId order — kind declaration order, then ULID — and is the row order this WO inherits.
- **WO-07** delivers `crates/fathom-wasm` (crate-type `cdylib` + `rlib`, so this WO's protocol
  additions are natively testable) and nothing artifact-side:
  - The extern ABI: `fathom_alloc` / `fathom_free` / `fathom_call` with the packed
    `(ptr << 32) | len` reply handle; the reply arena valid until the next `fathom_call`; no
    exceptions cross the boundary (`41` §3.9).
  - `OP_INIT = 1` and `OP_QUERY = 4` implemented; **every other opcode refused by number** with
    `ERR_UNKNOWN_OP` — which is exactly the dispatch this WO's four opcodes extend (§4.4).
  - `protocol.rs`: `REPLY_MAGIC` `FDLT`, `REPLY_VERSION = 1`, `KIND_ERROR = 0` /
    `KIND_FINDER_ROW = 3`, error codes 1–5 (`ERR_UNKNOWN_OP`, `ERR_NOT_INITIALISED`,
    `ERR_CORPUS_LOAD`, `ERR_BAD_FRAME`, `ERR_BAD_UTF8`), `encode_error`, and `decode_reply` —
    *"the reference reader"* whose refusal shapes this WO's kind-5 arm and JS reader mirror.
    Little-endian throughout; string refs are `(u32 offset, u32 len)` into one trailing blob;
    `(0, 0)` encodes the empty string; emission order fixed, no de-duplication (invariant 9).
  - `wasmbin.rs` (`IMPORT_ALLOWLIST` empty, `import_entries`, `export_entries`) and
    `tests/artifact_gates.rs`, which **re-runs against the module as this WO leaves it**: import
    section empty, exports exactly `{fathom_alloc, fathom_call, fathom_free}` + `memory` +
    `{__data_end, __heap_base}`, size ≤ 900 000 bytes. This WO adds no export and no import —
    `demo_estate()` reads no clock and no RNG — so the audits must stay green (§7 trigger 6).
  - The manifest state this WO inherits: `rust-toolchain.toml` `targets =
    ["wasm32-unknown-unknown"]`; the `[profile.release]` block (`opt-level "z"`, `lto "fat"`,
    `panic "abort"`, `strip "symbols"`, `overflow-checks true`); `#![deny(unsafe_code)]` plus
    three per-item allows in `fathom-wasm` only (WO-07 §12 item 2's recorded narrowing).
  - Also delivered but **not consumed here**: `fathom-corpus`'s `load_corpus_sources` /
    `from_sources` and the `OP_INIT` corpus frame — the finder is not wired into the artifact in
    this slice (§8 item 11; WO-07 §10 item 6's corpus-packing question stays open).
  - **Not delivered, by WO-07's own text**: the HTML artifact, the CSP, gate X0.8, any JS or TS,
    the furniture, the fixture entry point, X0.9's instruments, the worker topology, Trusted
    Types (WO-07 §1, §8). All of that is §4.5's, or a named non-goal (§8).

## 4. Deliverables

Every public name this work order creates is listed here (`78` §9 failure 1). Exactly these
files change:

| File | Change |
|---|---|
| `crates/fathom-inventory/**` | New crate: projections, demo estate, tests (§4.1–§4.3, §4.6–§4.8) |
| `crates/fathom-wasm/Cargo.toml` | Two dependency lines (§4.1) |
| `crates/fathom-wasm/src/lib.rs` | Four opcode consts (§4.4) |
| `crates/fathom-wasm/src/shell.rs` | The estate slot and the four dispatch arms (§4.4) |
| `crates/fathom-wasm/src/protocol.rs` | Kind 5: consts, views, encoders, the decode arm (§4.4) |
| `crates/fathom-wasm/tests/face.rs` | New: two-path parity, errors, determinism (§4.7) |
| `crates/fathom-artifact/**` | New crate: the shell source, the assembler, the artifact tests (§4.5, §4.7) |
| Root `Cargo.toml` | Two members lines (§4.1) plus the `Cargo.lock` hunk cargo generates |
| This file | Status line |
| `00-INDEX.md` | One row, if that index exists by then |

Nothing under `schema/`, nothing under `crates/fathom-ir`, `-graph`, `-corpus`, `-find`, `-id`,
`-schema`, `-schemagen`; WO-07's existing tests are not edited — `artifact_gates` re-runs
unmodified over the grown module and its going red is §7 trigger 6, never a constant to adjust.

### 4.1 The crates and the manifest edits

`crates/fathom-inventory/Cargo.toml`, verbatim:

```toml
[package]
name = "fathom-inventory"
version = "0.1.0"
edition.workspace = true
license.workspace = true
publish.workspace = true
description = "The inventory face's projections: row sets, the element page, the per-equipment page, and the demo estate (76 §7.2 S4, part one)"

[dependencies]
fathom-id = { path = "../fathom-id" }
fathom-ir = { path = "../fathom-ir" }
fathom-graph = { path = "../fathom-graph" }
```

`crates/fathom-artifact/Cargo.toml`, verbatim (no dependencies: the assembler is file plumbing
plus one `std::process::Command`, the same nested-cargo pattern WO-07's `artifact_gates` uses):

```toml
[package]
name = "fathom-artifact"
version = "0.1.0"
edition.workspace = true
license.workspace = true
publish.workspace = true
description = "Assembles the dev browser artifact: shell source + design/tokens.css + base64 fathom-wasm, spliced deterministically (42 §2.1's concatenation in a fixed order)"
```

Root `Cargo.toml` members list gains two lines, keeping the list alphabetical:
`"crates/fathom-artifact",` immediately before `"crates/fathom-corpus"`, and
`"crates/fathom-inventory",` immediately after `"crates/fathom-id"`.

`crates/fathom-wasm/Cargo.toml` `[dependencies]` gains two lines, after `fathom-find`
(alphabetical):

```toml
fathom-graph = { path = "../fathom-graph" }
fathom-inventory = { path = "../fathom-inventory" }
```

`fathom-inventory`'s `src/lib.rs` — `#![forbid(unsafe_code)]`; modules `render`, `demo`,
`inventory`, `element`, `equipment`; every public item below re-exported at the crate root.
`fathom-artifact`'s `src/lib.rs` — `#![forbid(unsafe_code)]`; the §4.5 items only.

### 4.2 The public API — projections are Rust, the DOM renders strings

**DECISION — every join, walk and count happens in this crate; the JS in the artifact renders
returned strings into the prototype's markup and computes nothing.** This is ADR-0019's *"Views
are pure functions of typed data"* made mechanically checkable: the projections run under native
`cargo test` with no browser, and the boundary stays one crossing per intention. (No cell elides
in this slice — §4.6 states the fact and §8 item 8 names the work order that changes it.)

```rust
/// The slice-one kind strip. Service and Tenant join with the service-layer
/// work order; Cable rows are §8 item 6.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvKind { Device, PhysicalPort, Premises }
impl InvKind {
    pub fn label(self) -> &'static str;               // "Device" | "PhysicalPort" | "Premises"
    pub const ALL: [InvKind; 3];
}

/// One inventory row. `id` is the element's full display id
/// (`<kind-lower>:<ulid>`, ADR-0005) — rows reference IDs, never names
/// (invariant 7). `opinions` is "—" in this build: no rule engine exists,
/// and the column is structural (52 §3.7.1), so it renders empty rather
/// than being dropped.
pub struct Row { pub id: String, pub cells: Vec<String>, pub opinions: &'static str }

pub fn columns(kind: InvKind) -> &'static [&'static str];
pub fn rows(g: &fathom_graph::Graph, kind: InvKind) -> Vec<Row>;   // NodeId order

/// One field row of the inspector table (54 §18): name, rendered value,
/// and the provenance cell ("hand · 2026-07-31" | "unset" |
/// "absent — asserted · hand · 2026-07-31").
pub struct FieldRow { pub name: &'static str, pub value: String, pub provenance: String }
pub struct ElementPage {
    pub kind_word: &'static str,        // NodeKind::name()
    pub name: String,                   // §4.6's display-name rule
    pub id: String,                     // full display id, never truncated (54 §18)
    pub context: Option<String>,        // §4.6's context line, e.g. "device srx-a · chassis 0"
    pub fields: Vec<FieldRow>,          // the kind's schema fields, declaration order
}
pub fn element_page(g: &fathom_graph::Graph, id: fathom_graph::NodeId) -> Option<ElementPage>;

pub struct CabledPeer { pub text: String, pub far_device: String }  // far_device: display id
pub struct PortRow {
    pub id: String,                     // the port's display id
    pub label: String,                  // the silkscreen (19 §3.3), verbatim
    pub chassis: String,                // owning Chassis' member_index, decimal
    pub connector: String, pub service: String,
    pub cabled: Option<CabledPeer>,     // None renders "—"
}
pub struct IfaceRow {
    pub id: String, pub name: String,   // "reth0", "st0.0" — units rendered, never stored joined
    pub kind_word: &'static str,        // "Interface" | "RethInterface" | … | "LogicalUnit"
    pub ports: String,                  // via Occupies: "0/3 · chassis 0"; "—" where none can exist
}
pub struct EquipmentPage {
    pub element: ElementPage,           // the device's own inspector rows
    pub ports: Vec<PortRow>,
    pub interfaces: Vec<IfaceRow>,
}
pub fn equipment_page(g: &fathom_graph::Graph, anchor: fathom_graph::NodeId)
    -> Option<EquipmentPage>;

/// Split on the last ':', `Ulid::decode` the tail, `Graph::resolve_ref`,
/// and cross-check the kind prefix against the resolved element's kebab
/// kind; any mismatch is None. No new decoder is written (fathom-id owns
/// Crockford).
pub fn parse_display_id(g: &fathom_graph::Graph, s: &str) -> Option<fathom_graph::ElementId>;

pub fn demo_estate() -> fathom_graph::Graph;          // §4.8; deterministic, no clock, no RNG
```

**DECISION — the equipment-page anchor rule** (the prototype's `equipTarget`, made exact):
`Device` → itself; any node with `device_of(anchor) == Some(d)` → `d`; `Site` → its first
`HasDevice` target in NodeId order; `Premises` → the first Device, in NodeId order, reached by
any `AtPremises` in-edge's Site's `HasDevice` targets; anything else → `None`, and the face
renders the empty state (§4.6). No other rule; a kind this table does not cover renders the
empty state, never a guess.

### 4.3 Value rendering — one closed table

Module `render` (private helpers; listed here because their behaviour is pinned by tests):

| Slot state / type | Renders as |
|---|---|
| `Unknown` (missing slot) | `—` |
| `Absent` (asserted) | `absent` |
| Any WO-01 `Scalar` type | `Scalar::canonical()` — the format is WO-01's, bound by calling it, never restated here |
| Generated value enum | `token()` — `central_office`, `sfp_plus`, `firewall`, … |
| `bool` | `true` / `false` |
| `u8` / `u16` / `u32` / `u64` | decimal |
| `PostalAddress` | every `Set` member in declaration order (`lines` each, then `locality`, `region`, `postcode`, `country`), joined `, ` — a member-wise rule because the structured value types carry no `canonical()` (§3.2) |
| `NameConformance` | `state.token()`, then ` — ` + reason text when `Some` — same reason |
| Any other `TypeId` | unreachable over the demo estate; reaching one is §7 trigger 5 |

Dispatch is a match on `slot_type(key)`'s `TypeId` over the erased `FieldBag` slot. The
provenance cell: `Set` → `hand · YYYY-MM-DD` from the field's `ProvenanceRecord.asserted_at`;
`Unknown` → `unset` (54 §18's word); `Absent` → `absent — asserted · hand · YYYY-MM-DD`. The
date is the **stored** timestamp rendered by a module-private `ymd(ms: u64) -> String` — pure
integer civil-from-days arithmetic, no clock, unit-tested against pinned vectors
(`0 → 1970-01-01`, `951_782_400_000 → 2000-02-29`, `1_785_456_000_000 → 2026-07-31`). Rendering
a stored date is invariant 9's "stored and rendered, never evaluated" — nothing here computes
an age (that is `19` §3.9's declined territory).

### 4.4 The boundary — four opcodes and the FaceRow record, decided to the offset

WO-07's protocol carries the finder; the face needs the graph. WO-07 §4.4 names a protocol
extension — *"new opcode or new record kind"* — planning work, and this planning document is
where it is decided (§12 item 8). Four opcodes and one record kind, everything else reused
unchanged from WO-07 §4.3–§4.5: little-endian, the FDLT skeleton, the string-blob rules, the
error record, `encode_error`, the arena lifetime, no exceptions across the boundary.

New public names in `crates/fathom-wasm`, the complete set:

```rust
// src/lib.rs, next to OP_INIT / OP_QUERY. 41 §3.7's table holds 1–10;
// these take the next free numbers. A new call is a new opcode, never a
// changed one — 2, 3 and 5–10 stay refused by number (WO-07 §8).
pub const OP_ESTATE_DEMO: u32 = 11;
pub const OP_INV_ROWS: u32 = 12;
pub const OP_ELEMENT: u32 = 13;
pub const OP_EQUIPMENT: u32 = 14;

// src/protocol.rs. Record kinds 0–4 are taken (41 §3.3; WO-07 implements
// 0 and 3); 5 is the face's.
pub const KIND_FACE_ROW: u16 = 5;
pub const FACE_ROW_STRIDE: u32 = 72;
pub const FACE_HEADER: u8 = 0;      // role byte values
pub const FACE_INV: u8 = 1;
pub const FACE_FIELD: u8 = 2;
pub const FACE_PORT: u8 = 3;
pub const FACE_IFACE: u8 = 4;
pub const ERR_NO_ELEMENT: u16 = 6;  // codes 1–5 are WO-07's

pub struct FaceRowView { pub role: u8, pub slot_count: u32, pub strings: [String; 8] }
// ReplyView (WO-07 §4.5) gains one variant: FaceRows(Vec<FaceRowView>).
// decode_reply gains the kind-5 arm, refusing with the same message shapes.

pub fn encode_inv_reply(
    kind_label: &str,
    columns: &[&str],
    rows: &[fathom_inventory::Row],
) -> Vec<u8>;
pub fn encode_element_reply(page: &fathom_inventory::ElementPage) -> Vec<u8>;
pub fn encode_equipment_reply(page: Option<&fathom_inventory::EquipmentPage>) -> Vec<u8>;
```

`Shell` (src/shell.rs) gains a second private field, `estate: Option<fathom_graph::Graph>`, and
four dispatch arms. No public name changes there. The encoders copy the §4.2 projections'
strings verbatim; nothing is recomputed — the two-path parity tests (§4.7) hold that line.

**The FaceRow record, stride 72:**

```text
offset  size  field
0       1     role         0 header · 1 inventory row · 2 field row · 3 port row · 4 interface row
1       3     zero
4       4     slot_count (u32)   how many of s0–s7 are meaningful for this record
8       64    eight (u32 off, u32 len) string refs into the blob, s0–s7; (0, 0) = empty string
```

String-blob emission per WO-07 §4.4's rule: records in order, each record's slots s0–s7 in
order, empty slots contribute nothing, no de-duplication — the encoding is a pure function of
its content (invariant 9).

**Slot assignment, exactly:**

| Reply | Role | Slots |
|---|---|---|
| `OP_INV_ROWS`, record 0 | 0 header | s0 kind label (`Device` …); s1–s6 the §4.6 column names in order; s7 `opinions`. `slot_count` = 2 + column count |
| `OP_INV_ROWS`, records 1… | 1 inventory row | s0 display id; s1–s6 the cells, aligned under the header's columns; s7 the opinions cell (`—`). `slot_count` = the header's |
| `OP_ELEMENT` / `OP_EQUIPMENT`, record 0 | 0 header | s0 `kind_word`; s1 name; s2 full display id; s3 context, empty = none. `slot_count` 4 |
| `OP_ELEMENT` / `OP_EQUIPMENT` | 2 field row | s0 field name; s1 rendered value; s2 provenance cell. `slot_count` 3 |
| `OP_EQUIPMENT` | 3 port row | s0 port display id; s1 label; s2 chassis; s3 connector; s4 service; s5 the cables-to text, `—` when uncabled; s6 the far device's display id, empty when the cell is text-only. `slot_count` 7 |
| `OP_EQUIPMENT` | 4 interface row | s0 display id; s1 name; s2 `kind_word`; s3 ports cell. `slot_count` 4 |

Record order: `OP_ELEMENT` = one header, then field rows in declaration order. `OP_EQUIPMENT` =
one header, the device's field rows, then port rows then interface rows in §4.6's orders. The
anchor rule yielding `None` is **not an error**: the reply is kind 5 with `record_count = 0` —
the §4.6 empty state.

**Requests and refusals:**

| Request | Bytes in | Refusals |
|---|---|---|
| `OP_ESTATE_DEMO` | none — `req_len` must be 0 | nonzero length → `ERR_BAD_FRAME`. Success: `estate = Some(fathom_inventory::demo_estate())`, replacing any held estate (re-init permitted, mirroring `OP_INIT`); the empty reply |
| `OP_INV_ROWS` | exactly 1 byte: 0 `Device` · 1 `PhysicalPort` · 2 `Premises` (`InvKind::ALL` order) | other length or byte → `ERR_BAD_FRAME`; no estate → `ERR_NOT_INITIALISED`, detail `no estate loaded` |
| `OP_ELEMENT` / `OP_EQUIPMENT` | the raw UTF-8 display id, no framing | not UTF-8 → `ERR_BAD_UTF8`; no estate → `ERR_NOT_INITIALISED`; `parse_display_id` → `None`, or an edge id → `ERR_NO_ELEMENT` with the request text as `detail` |

### 4.5 The artifact — the shell source, the assembler, and gate X0.8

**Files.** `crates/fathom-artifact/html/fathom-dev.src.html` (the hand-authored shell source),
`src/lib.rs`, `src/main.rs`, `tests/artifact.rs`. The assembled output is
`target/artifact/fathom-dev.html` and is **not checked in** — the same posture as the `.wasm`
itself, which WO-07 builds inside a gate and never commits. Determinism: the source and
`design/tokens.css` are checked in, and the module rebuild is byte-identical (WO-07 G7), so the
artifact is byte-identical too (§4.7 pins it).

**The assembler**, public API exactly:

```rust
#![forbid(unsafe_code)]

/// Workspace-relative paths and the two splice tokens. The names carry
/// `dev` on purpose: this is 45 §9.1's dev build, not `fathom-<ver>.html`
/// (43 §3.5) — versioned assembly is §10 item 7.
pub const SHELL_SOURCE: &str = "crates/fathom-artifact/html/fathom-dev.src.html";
pub const TOKENS_SOURCE: &str = "design/tokens.css";
pub const ARTIFACT_OUT: &str = "target/artifact/fathom-dev.html";
pub const TOKEN_TOKENS_CSS: &str = "@FATHOM_TOKENS_CSS@";
pub const TOKEN_WASM_B64: &str = "@FATHOM_WASM_B64@";

/// RFC 4648 §4 base64: standard alphabet, padded. First-party, ~20 lines;
/// fathom-id's Crockford encoder is the house precedent for hand-rolling
/// an encoding rather than adding a dependency.
pub fn base64(bytes: &[u8]) -> String;

/// Build fathom-wasm (`cargo build --release --target wasm32-unknown-unknown
/// -p fathom-wasm --target-dir target/artifact-wasm` — WO-07 §4.6's nested
/// command, its own target dir so it never contends with `artifact_gates`'s),
/// read the module, read SHELL_SOURCE and TOKENS_SOURCE, splice each token
/// (each must occur exactly once in the source, else Err), return the final
/// artifact bytes.
pub fn assemble(workspace_root: &std::path::Path) -> Result<Vec<u8>, String>;
```

`src/main.rs`: resolve the workspace root (`CARGO_MANIFEST_DIR` + `../..`), `assemble`, create
`target/artifact/`, write `ARTIFACT_OUT`, print `target/artifact/fathom-dev.html · <n> bytes`.

**The CSP, verbatim in the shell source.** `43` §3.7's D1 block with exactly two substitutions:
the `'sha256-REPLACED_AT_BUILD'` slots in `script-src` and `style-src` become `'unsafe-inline'`,
because computing the hashes needs a sha256 the tree does not have and hand-rolling crypto is
refused — the scaffolding posture the prototype already takes, recorded in §12 item 7 and owned
by §10 item 7. Every other directive is `43` §3.7's, unmodified:

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'unsafe-inline' 'wasm-unsafe-eval';
  style-src 'unsafe-inline';
  img-src data:;
  font-src data:;
  connect-src 'none';
  worker-src blob:;
  child-src 'none';
  frame-src 'none';
  form-action 'none';
  base-uri 'none';
  object-src 'none';
  media-src 'none';
  manifest-src 'none';
  require-trusted-types-for 'script';
  trusted-types fathom-dom fathom-worker;
">
<meta name="referrer" content="no-referrer">
```

X0.8 (`71` §3.6) is asserted **against the final bytes**: a `fathom-artifact` test assembles and
checks the artifact bytes carry this block with `connect-src 'none'` (§4.7), and G8 greps the
assembled file. `require-trusted-types-for 'script'` is real, not decorative: the shell source
uses **no HTML-string sink** — no `innerHTML`, `outerHTML`, `insertAdjacentHTML` or
`document.write`, DOM built with `createElement`/`textContent` only — so the directive holds
with no policy created, and G8 pins the absence by grep. (The prototype's idiom is `innerHTML`;
§3.1 records the divergence. No Worker is created in this slice, so `worker-src blob:` and the
`fathom-worker` policy name ride along unused.)

**The shell source's contents**, in the fixed order the file is authored:

1. The CSP meta above, `<meta charset="utf-8">`, `<title>`.
2. One `<style>` whose first line is `@FATHOM_TOKENS_CSS@` (the tokens, inlined — the artifact
   has **zero subresources**), followed by the shell and face CSS transcribed from the
   prototype's selectors (§4.6's list), declaring no hex, no px font sizes, no durations,
   `border-radius`/`box-shadow` only as `var(--radius)`/`var(--shadow)` (`51` §10, §14).
3. The static furniture markup, transcribed from the prototype: masthead
   (title/sub/ribbon/imperative), the always-visible risk legend, the view band (`<nav
   class="band" data-rove="h">`) carrying all six views, the two-column content region
   (view area + inspector at 62/38, `52` §2.3), the footer.
4. One `<script>` containing, in order:
   - `const FATHOM_WASM_B64 = "@FATHOM_WASM_B64@";`
   - The boundary: `bytes = Uint8Array.from(atob(FATHOM_WASM_B64), c => c.charCodeAt(0))`;
     `WebAssembly.instantiate(bytes, {})` — the empty import object is correct because the
     module's import section is empty (WO-07 §4.5); permitted by `'wasm-unsafe-eval'`; *"never
     fetched"* (`42` §8.2). A `call(op, req)` function mirroring `41` §3.7's `Core.call` in
     hand-authored JS: `fathom_alloc`, one `view.set`, `fathom_call`, split the BigInt handle
     (`ptr = Number(h >> 32n)`, `len = Number(h & 0xFFFFFFFFn)`, `0n` = empty reply), fresh
     views after the call, decode fully before returning — no view outlives the crossing (the
     arena is valid only until the next `fathom_call`).
   - The reader: mirrors `protocol.rs`'s `decode_reply` for kinds 0 and 5 **only** — magic
     `FDLT`, version 1, kind/count/stride, one `TextDecoder.decode` of the blob (`41` §3.4),
     then per-record `DataView` reads at the §4.4 offsets, `littleEndian = true`. Any other
     magic, version or kind renders the refusal text in the `.unposted` idiom — a visible
     refusal, never a guess and never an uncaught exception.
   - The furniture behaviour, transcribed from the prototype: the view registry array; `⌥1`–`⌥6`
     via `e.code`, `⌥←`/`⌥→` bounded, never wrapping; `Ctrl+K` toggling the finder overlay;
     the document-level Escape ladder (finder overlay → selection → nothing; *"`Esc` on an
     empty state does not navigate anywhere"*); the shared `data-rove`/`data-rove-item` roving
     implementation; the theme toggle.
   - The face renderers (§4.6) and one `S` object holding only what is rendered — the current
     view, kind, selection id, inspector face, and the last replies — rebuilt from replies,
     never written to (`41` §3.10).
5. Boot, on `load`: instantiate; if `new URLSearchParams(location.search).get('fixture') ===
   'demo-estate'`, `call(OP_ESTATE_DEMO)` (45 §9.1's *"one URL parameter"*, dev-build only —
   this artifact is the dev build by name); then select the inventory view and render. Without
   the parameter the inventory face renders the no-workspace state, verbatim copy:
   `.unposted` label `inventory`, body *"no workspace loaded — this dev artifact loads the demo
   estate with ?fixture=demo-estate"*. An instantiate failure or an error reply at boot renders
   the failure text in the same idiom, verbatim. Boot is the only async step; nothing animates
   (`51` §12).

The five views this slice does not build — finder, walkthrough, config, findings, diagram —
register in the band and render one shared `.unposted` body, verbatim copy: *"unposted — this
view arrives with a later work order; the inventory face (⌥6) is live in this build"*. The
`Ctrl+K` finder overlay opens with the same body. Honest, present, empty — the opinions-column
posture applied to whole views.

**Header-comment rule** (learned from the prototype, whose own header contains the literal
`import()` and would trip a grep): the shell source's header comment must not name any G8
pattern in gate-matchable form — write "no fetch, no dynamic import" without parentheses.

### 4.6 The face — columns, tables, pages, exactly

**The kind strip.** Three buttons — `Device` · `PhysicalPort` · `Premises` — with the
prototype's `.strip` markup and its label *"kind — a row set is a kind plus a filter"*. Default
kind `Device` (`52` §3.7). The prototype's `Service` and `Tenant` buttons are **not** rendered:
the service layer is a non-goal (§8), and a button that renders nothing would be a lie.
Activating a kind is one crossing: `call(OP_INV_ROWS, [k])`; the reply's header record carries
the column names the `<th>` row renders.

**Column sets** (`columns()`), each column named for the schema field it renders or marked
*(traversal)* — a traversal column is a projection this WO defines, not a field, and adding one
that pretends to be a field is §7 trigger 5:

| Kind | Columns |
|---|---|
| `Device` | `hostname` · `platform` · `os_version` · `role` · `premises` *(traversal: `owner` Site → `AtPremises` → Premises `label`; `—` when the walk fails)* · `name_conformance` *(the derived field's stored slot — `Unknown` in this build, renders `—`; no derive engine exists and none is faked)* |
| `PhysicalPort` | `label` · `owner` *(traversal: `owner` Chassis → `owner` Device `hostname`)* · `connector` · `service` · `speed_max` · `cables to` *(traversal, §below)* |
| `Premises` | `label` · `clli` · `form` · `street` · `devices` *(traversal: over `AtPremises` in-edges, the sum of each Site's `HasDevice` out-degree, decimal)* |

**The `cables to` cell and the cabled-peer walk**, exactly: for port `p`, the `Terminates`
in-edges at `p` name the cable(s); for each cable (the demo estate has at most one per port),
its other `Terminates` out-edge names the far port `q`; the cell renders
`<far hostname> · <q.label> · <cable label>`, with `<far hostname>` replaced by `itself` when
`device_of(q) == device_of(p)`; a cable with no second `Terminates` renders
`<cable label> · far end unmodelled`; no cable renders `—`. The inventory cell is text; the
**equipment page's** `cables to` cell is the navigation affordance (slot s6's far-device id),
per the prototype's `data-far` behaviour: activating it calls `OP_EQUIPMENT` with the far id —
one crossing — switches the inspector to the equipment face, and writes
`followed the cable to <hostname>` to the footer. The schema's derived `occupied` field is
**not read and not shown** — its definition is contested (§10 item 3) and the cable walk states
the fact the column actually means.

**The inventory table.** The prototype's `.inv` markup verbatim: `<th>` per column plus the
sticky `opcol` header `opinions`; one `<tr data-tier>` per row; every cell a `<button
data-eid="<display id>" data-post="el:<display id>">`; the first cell is the row's rove item;
rows in the reply's order (NodeId order — deterministic, insertion-independent). Opinions
cells render `—` as a non-interactive `.cell` (there is no findings view to jump to). Below the
table, two notes in the prototype's `.note` idiom, verbatim copy:

> **Demo estate · not corpus data** — No inventory ships in the corpus. This estate is
> constructed by checked-in code (`fathom-inventory::demo_estate()`), consistent with
> `schema/schema.yaml`, and labelled as a demo everywhere it appears.

> **The rightmost column is not a field** — It is the per-row finding aggregate (52 §3.7.1).
> No rule engine is in this build, so every cell reads `—`. The column stays: you cannot look
> at the inventory without seeing what the rule engine thinks of each row, including that it
> is not here yet.

**The inspector (meaning face), posting an element.** One crossing (`OP_ELEMENT` with the row's
id), then `54` §18's shape in the prototype's `.kv` markup: eyebrow = header s0, name = s1, the
full display id (s2) in mono at `--t-micro`, selectable, never truncated; then the field table —
every schema field of the kind, declaration order (`NodeKind::fields()`), name / rendered value
/ provenance cell from the role-2 records. The prototype's *"What the rule engine thinks"*
section is **not rendered** (no engine — §12 item 2). Display names (computed in `element.rs`,
never in JS): `Device` → `hostname`; `PhysicalPort` → `label`; `Premises` → `label`;
`Site` → `name`; `Cable` → `label`, or `(unlabelled)` when unset; `Interface` /
`AggregateInterface` / `RethInterface` / `TunnelInterface` → `name`; `LogicalUnit` →
`<owner display name>.<index>` (rendered, never stored joined); `Chassis` →
`chassis <member_index>`. Context lines: `PhysicalPort` → `device <hostname> · chassis
<member_index>`; `Chassis`, InterfaceLike, `LogicalUnit` → `device <hostname>`; `Device` →
`site <name> · premises <label>` (elide the missing half); roots → none.

**The equipment face.** The inspector grown (`52` §2.3 as amended; *"NOT a seventh view — 52
§9.5"*). One crossing (`OP_EQUIPMENT` with the selection id). A zero-record reply is the empty
state, in the prototype's `.unposted` idiom: *"No equipment selected — select a device, a port
or a premises anywhere on the left and this face becomes its per-equipment page."* Otherwise:
the header and role-2 records render as header + `.kv` rows, then:

- **`Ports — every one, named`** (the prototype's heading, without the `59` §3.8 diagram
  clause — no diagram exists in this build): columns `label` · `chassis` · `connector` ·
  `service` · `cables to`. One role-3 record per `PhysicalPort` under any `HasChassis` target
  of the device, chassis in NodeId order then ports in NodeId order. The `label` cell is a
  button posting the port's element page; the `cables to` cell is the `data-far` navigation
  button when s6 is non-empty. The `chassis` column exists because two chassis of one Device
  may carry identical silkscreens (the demo estate's `0/3` twins) — the silkscreen is
  per-faceplate, not per-device (`19` §3.3's identity tuples are `owner`-scoped).
- **`Interfaces — configuration objects`** (new heading; the law demands the second table):
  columns `name` · `kind` · `ports`. One role-4 record per `HasInterface` target in NodeId
  order — which is kind declaration order (`Interface`, then `AggregateInterface`,
  `RethInterface`, `TunnelInterface`), then ULID — each followed by its `HasUnit` targets in
  `index` order (`reth0.0`, kind `LogicalUnit`, ports `—`). A row whose `kind` string is
  `LogicalUnit` renders indented under its owner — presentation keyed off a returned string,
  not a join. The `ports` cell renders the `Occupies` targets as `<label> · chassis
  <member_index>` joined ` · `, and `—` for kinds that cannot occupy (`19` §3.7: reth/ae reach
  hardware through members; st0 reaches nothing).

**The two tables are the identity law rendered.** The ports table never contains an interface
name; the interfaces table never contains a silkscreen except inside its `ports` join column;
the only bridge between them is `Occupies`. The law is quoted in a code comment at the top of
`equipment.rs` and pinned by tests (§4.7).

**Findings sections.** The prototype's *"Findings anchored here"* renders as the `.unposted`
honesty device: label `Findings anchored here`, body *"unposted — no rule engine in this
build"*. Not `—` (which would claim the engine ran and found nothing), and not omitted (which
would hide the surface's shape).

**No hover surfaces, and no elision.** Nothing in this face reveals content on hover (`55`
§1.4, `51` §11). **No cell elides in this slice** — a stated fact, not an omission: the longest
cell any §4.8 expectation renders is 26 characters (`hub-a · 0/1/0 · RVSD-FW-01`), under any
plausible clip width, so the prototype's per-column `clip()` widths are deliberately not
transcribed and no elision rule ships. Elision — its widths, and the prototype's resolution
rule (*"the full sentence lives in the meaning column when the row posts … never a mid-word
clip"*) — lands with the windowed renderer (§8 item 8) and is specified by that work order; a
session that finds itself wanting `clip()` here is inside §7 trigger 5. Any future hover
surface follows the prototype's 1.4.13 pattern (dismissible with Escape, hoverable, persistent,
opens on focus); none ships here.

**Keyboard, this face's additions only** (the furniture — §4.5 — owns the band, `Ctrl+K`, `⌥`
handling, the Escape ladder, and the roving implementation): the inventory `<tbody>` is
`data-rove="v"` with the first cell of each row the rove item (one tab stop — `53` §8.3); the
ports and interfaces tables likewise; `Enter` activates the focused button (native semantics —
posting the row; see §12 item 3 on `53` §3.5's "expand child rows"); `Esc` behaviour is the
furniture's ladder — the face adds no Escape handling of its own.

**Markup and style.** All face CSS reuses the prototype's selectors (`.strip`, `.inv`,
`.invwrap`, `.opcol`, `.kv`, `.sh`, `.note`, `.unposted`, `.faces`, `.act`, `.cell`) verbatim,
carried in the shell source §4.5 authors. Zero new colours, radii, shadows, durations, hex
literals or px font sizes (tokens.css law, `51` §14); `border-radius`/`box-shadow` appear only
as `var(--radius)`/`var(--shadow)` (`51` §10's grep discipline — G8 asserts it). The language
question (ADR-0019's TypeScript v the hand-authored JS this artifact ships) is §12 item 1 and
§10 item 2 — not this session's to resolve.

### 4.7 Tests

#### 4.7.1 `crates/fathom-inventory`

Unit tests in `render.rs` and `demo.rs`, integration tests in `tests/projection.rs`. Exactly
these names; bodies are the session's, to the assertions stated:

| Test | Asserts |
|---|---|
| `ymd_pins_the_civil_conversion` (unit) | the three §4.3 vectors, exactly |
| `postal_address_joins_set_members_in_order` (unit) | the §4.3 `PostalAddress` rule on a two-member value |
| `demo_estate_builds_with_zero_refusals` (unit) | `demo_estate()` returns; every insert succeeded (the builder `unwrap`s, so success is the function returning); one committed batch labelled `demo estate — WO-08` |
| `demo_estate_counts_are_pinned` (unit) | 25 nodes, 27 edges, per kind exactly as §4.8's tables |
| `device_rows_render_the_pinned_cells` | `rows(g, Device)` == the §4.8 Device expectation, literal strings except `os_version`, asserted equal to `OsVersion("21.4R3").canonical()` |
| `physicalport_rows_resolve_the_cabled_peer` | the six §4.8 PhysicalPort rows; `0/3`-on-chassis-0's cell is `hub-a · 0/1/0 · RVSD-FW-01`; `fab` rows read `itself · fab · FAB-0`; uncabled rows read `—`; `speed_max` cells equal `canonical()` of the pinned `Bandwidth` values |
| `premises_rows_count_devices_via_atpremises` | the three §4.8 Premises rows; `clli` reads `absent` on Bramble (asserted), never `—` |
| `opinions_cells_are_all_em_dash` | every `Row.opinions == "—"`, all three kinds |
| `rows_are_insertion_independent` | build the estate twice with node/edge insertion orders interleaved differently (same batch structure); every projection (`rows` ×3, `equipment_page` ×2, `element_page` on every node) renders byte-identically |
| `equipment_page_ports_never_name_an_interface` | on `srx-a`: four `PortRow`s, in the §4.8 order; no `PortRow` field contains any of `ge-0/0/3`, `ge-5/0/3`, `reth0`, `st0` |
| `equipment_page_interfaces_join_only_through_occupies` | on `srx-a`: six `IfaceRow`s (`ge-0/0/3`, `ge-5/0/3`, `reth0`, `reth0.0`, `st0`, `st0.0`); `ports` cells are `0/3 · chassis 0`, `0/3 · chassis 1`, `—`, `—`, `—`, `—` |
| `far_end_navigation_crosses_devices` | `hub-a`'s port `0/1/0` carries `CabledPeer { text: "srx-a · 0/3 · RVSD-FW-01", far_device: <srx-a's display id> }` |
| `element_page_distinguishes_unset_from_asserted_absent` | Bramble's page: `clli` provenance is `absent — asserted · hand · 2026-07-31`; `region` provenance is `unset`; `label` provenance is `hand · 2026-07-31` |
| `element_page_shows_the_full_id_and_declared_fields` | on `srx-a`: `id` is **exactly 40 characters** — `fathom:device:` (14) + the ULID's 26-character Crockford encoding (§3.1, fathom-id) — starts `fathom:device:`, and round-trips through `Ulid::decode`; `fields` names equal `NodeKind::Device.fields()`'s wire names in order |
| `display_id_round_trips` | `parse_display_id(g, &row.id)` resolves every inventory row to its element; a wrong kind prefix and a truncated ULID both return `None` |

#### 4.7.2 `crates/fathom-wasm/tests/face.rs`

All native (the rlib half), mirroring WO-07 §4.6's two-path pattern — one process, the shell
path against the directly-called crate:

| Test | Asserts |
|---|---|
| `estate_demo_then_inventory_rows_mirror_the_crate` | `Shell::new`; `handle(OP_ESTATE_DEMO, &[])` → empty reply. For each `InvKind`: `handle(OP_INV_ROWS, &[k])`, `decode_reply` → `FaceRows`; the header record equals `label()` + `columns()` + `opinions`; the row records equal `rows(&demo_estate(), kind)` slot for slot (id, every cell, opinions) |
| `element_and_equipment_replies_mirror_the_crate` | for every row id of all three kinds: the `OP_ELEMENT` reply's header and role-2 records equal `element_page`'s fields verbatim. `OP_EQUIPMENT` on `srx-a`'s id equals `equipment_page` slot for slot (header, fields, 4 ports incl. s6 far ids, 6 interfaces); on Bramble's id → kind 5, `record_count == 0` |
| `face_error_replies_are_typed` | `OP_INV_ROWS` before `OP_ESTATE_DEMO` → `ERR_NOT_INITIALISED`; kind byte 3 → `ERR_BAD_FRAME`; `OP_ESTATE_DEMO` with a nonempty request → `ERR_BAD_FRAME`; `OP_ELEMENT` with a well-formed id whose ULID is not in the estate → `ERR_NO_ELEMENT`; `OP_ELEMENT` with invalid UTF-8 → `ERR_BAD_UTF8` |
| `face_reply_encoding_is_deterministic` | two independently constructed `Shell`s produce byte-identical replies for every §4.4 opcode over the demo estate (invariant 9) |

#### 4.7.3 `crates/fathom-artifact/tests/artifact.rs`

| Test | Asserts |
|---|---|
| `base64_matches_rfc4648_vectors` | the seven RFC 4648 §10 vectors: `""`→`""`, `"f"`→`"Zg=="`, `"fo"`→`"Zm8="`, `"foo"`→`"Zm9v"`, `"foob"`→`"Zm9vYg=="`, `"fooba"`→`"Zm9vYmE="`, `"foobar"`→`"Zm9vYmFy"` |
| `assembled_artifact_pins_x08` | `assemble()` succeeds; the final bytes contain the §4.5 CSP meta block including `connect-src 'none'` (X0.8, against final bytes); neither splice token survives in the output |
| `shell_source_carries_no_egress_and_no_sinks` | the checked-in source contains none of the G8 pattern strings (byte search over the same literals) |
| `artifact_is_deterministic` | two `assemble()` runs return byte-identical artifacts (the module half is WO-07 G7's measured property; this pins the splice) |

### 4.8 The demo estate, exactly

**DECISION — the estate is constructed in code, in one batch, with every ULID and timestamp
pinned.** No clock, no RNG (invariant 9). `TS0 = 1_785_456_000_000` (2026-07-31T00:00:00Z — a
stored value, rendered as stored). Every node/edge ULID is `Ulid::from_parts(TS0, k)` with `k`
from the tables below; the one `ProvenanceRecord` is `{ id: from_parts(TS0, 9001),
origin: Hand, asserted_at: Timestamp(TS0), asserted_by: User(from_parts(TS0, 9000)),
confidence: Asserted, supersedes: None }`, re-interned byte-equal on every write (WO-02 permits
this); the batch id is `from_parts(TS0, 9002)`, label `demo estate — WO-08`.

Nodes (fields not listed are left `Unknown`; **A** marks an asserted `Absent`):

| k | id | Kind | Fields |
|---|---|---|---|
| 1 | P1 | Premises | label `Riverside CO` · clli `RVSDTX01` · form `central_office` · street lines `["101 Riverside Dr"]` |
| 2 | P2 | Premises | label `Midtown hut` · clli `MDTNTX01` · form `hut` · street lines `["88 Frontage Rd"]` |
| 3 | P3 | Premises | label `Bramble Logistics HQ` · clli **A** · form `customer_premises` · street lines `["1200 Commerce Pkwy"]` |
| 4 | S1 | Site | name `Riverside` |
| 5 | S2 | Site | name `Midtown` |
| 6 | D1 | Device | hostname `srx-a` · platform `junos-srx` · os_version `21.4R3` · role `firewall` · cluster_id `1` |
| 7 | D2 | Device | hostname `hub-a` · platform `junos-mx` · os_version `21.4R3` · role `router` |
| 8 | C1 | Chassis | member_index `0` · model `SRX345` |
| 9 | C2 | Chassis | member_index `1` · model `SRX345` |
| 10 | C3 | Chassis | member_index `0` · model `MX204` |
| 11 | PT1 | PhysicalPort | label `0/3` · connector `rj45` · service `ethernet` · speed_max `Bandwidth(1_000_000_000)` |
| 12 | PT2 | PhysicalPort | label `fab` · connector `sfp` · service `ethernet` |
| 13 | PT3 | PhysicalPort | label `0/3` · connector `rj45` · service `ethernet` · speed_max `Bandwidth(1_000_000_000)` |
| 14 | PT4 | PhysicalPort | label `fab` · connector `sfp` · service `ethernet` |
| 15 | PT5 | PhysicalPort | label `0/1/0` · connector `sfp_plus` · service `ethernet` · speed_max `Bandwidth(10_000_000_000)` |
| 16 | PT6 | PhysicalPort | label `0/1/1` · connector `sfp_plus` · service `ethernet` · speed_max `Bandwidth(10_000_000_000)` |
| 17 | K1 | Cable | label `RVSD-FW-01` · media `cat6a` · length_m `12` |
| 18 | K2 | Cable | label `FAB-0` · media `twinax` · length_m `1` |
| 19 | I1 | Interface | name `ge-0/0/3` · form `ethernet` |
| 20 | I2 | Interface | name `ge-5/0/3` · form `ethernet` |
| 21 | R1 | RethInterface | name `reth0` |
| 22 | U1 | LogicalUnit | index `0` |
| 23 | T1 | TunnelInterface | name `st0` · technology `ipsec_vti` |
| 24 | U2 | LogicalUnit | index `0` |
| 25 | I3 | Interface | name `xe-0/1/0` · form `ethernet` |

Edges (`end` values on `Terminates` in brackets):

| k | Edge | From → To |
|---|---|---|
| 26–27 | HasDevice | S1→D1, S2→D2 |
| 28–29 | AtPremises | S1→P1, S2→P2 |
| 30–32 | HasChassis | D1→C1, D1→C2, D2→C3 |
| 33–38 | HasPort | C1→PT1, C1→PT2, C2→PT3, C2→PT4, C3→PT5, C3→PT6 |
| 39–40 | Terminates | K1→PT1 [a], K1→PT5 [b] |
| 41–42 | Terminates | K2→PT2 [a], K2→PT4 [b] |
| 43–47 | HasInterface | D1→I1, D1→I2, D1→R1, D1→T1, D2→I3 |
| 48–49 | HasUnit | R1→U1, T1→U2 |
| 50–52 | Occupies | I1→PT1, I2→PT3, I3→PT5 |

`P3` has no Site and no Device — it exercises the `devices` count of `0` and the Premises →
equipment empty state. `Site`, `Premises` and `Cable` nodes are inserted with no containment
edge (forest roots — WO-02 refuses the root-containment edge kinds). No `RedundancyGroup` is
modelled: L0 enforces upper bounds only, and the reth's required-edge lint is L1, which does
not exist yet. No derived field is written, ever.

Expected projections, pinned (the tests in §4.7 assert these verbatim; `⟨B⟩` means the value is
asserted via `canonical()` rather than as a literal):

`rows(g, Device)` — 2 rows:

```text
srx-a | junos-srx | ⟨21.4R3⟩ | firewall | Riverside CO | —   ‖ opinions —
hub-a | junos-mx  | ⟨21.4R3⟩ | router   | Midtown hut  | —   ‖ opinions —
```

`rows(g, PhysicalPort)` — 6 rows, NodeId order PT1…PT6:

```text
0/3   | srx-a | rj45     | ethernet | ⟨1_000_000_000⟩  | hub-a · 0/1/0 · RVSD-FW-01
fab   | srx-a | sfp      | ethernet | —                | itself · fab · FAB-0
0/3   | srx-a | rj45     | ethernet | ⟨1_000_000_000⟩  | —
fab   | srx-a | sfp      | ethernet | —                | itself · fab · FAB-0
0/1/0 | hub-a | sfp_plus | ethernet | ⟨10_000_000_000⟩ | srx-a · 0/3 · RVSD-FW-01
0/1/1 | hub-a | sfp_plus | ethernet | ⟨10_000_000_000⟩ | —
```

(Note PT3 — chassis 1's `0/3` — is uncabled: K2 joins the two `fab` ports. The inventory's
`owner` column names the device; the chassis distinction appears on the equipment page.)

`rows(g, Premises)` — 3 rows:

```text
Riverside CO         | RVSDTX01 | central_office     | 101 Riverside Dr  | 1
Midtown hut          | MDTNTX01 | hut                | 88 Frontage Rd    | 1
Bramble Logistics HQ | absent   | customer_premises  | 1200 Commerce Pkwy| 0
```

`equipment_page(g, D1)` — ports, in order (label · chassis · connector · service · cables to):

```text
0/3 · 0 · rj45 · ethernet · hub-a · 0/1/0 · RVSD-FW-01
fab · 0 · sfp  · ethernet · itself · fab · FAB-0
0/3 · 1 · rj45 · ethernet · —
fab · 1 · sfp  · ethernet · itself · fab · FAB-0
```

— interfaces, in order (name · kind · ports): `ge-0/0/3 · Interface · 0/3 · chassis 0`,
`ge-5/0/3 · Interface · 0/3 · chassis 1`, `reth0 · RethInterface · —`,
`reth0.0 · LogicalUnit · —`, `st0 · TunnelInterface · —`, `st0.0 · LogicalUnit · —`.

## 5. The plan

Each step ends with `cargo build --workspace` compiling and `cargo test --workspace` green
unless stated. No reordering, no merging (`78` §3.6).

1. **Re-verify.** Check §3.2's contract record against the merged tree: WO-01's trait and row
   forms; the `fathom-graph` API items §4.2 calls; WO-07's crate as merged — the ABI names, the
   opcode and error consts, the reply skeleton, `decode_reply`'s refusal shapes, the
   `artifact_gates` suite, the manifest state. A divergence that changes no decision here is
   recorded old → new in §12 (`78` §8); one that does is §4 escalation. Record the outcome
   either way.
2. **Skeleton.** Create `fathom-inventory` with the verbatim manifest and its members line;
   empty modules; builds.
3. **`render`** — the §4.3 table, `ymd`, the provenance-cell renderer; the two unit tests.
4. **`demo`** — the §4.8 builder, exactly the tabled nodes, fields, edges, ids; the two unit
   tests.
5. **`inventory`, `element`, `equipment`, `parse_display_id`** — §4.2's API to §4.6's rules;
   then `tests/projection.rs`, all eleven integration tests, asserting §4.8's pinned
   expectations. `cargo test -p fathom-inventory` green.
6. **The boundary.** The two `fathom-wasm` dependency lines; the four opcode consts; the kind-5
   consts, views, encoders and decode arm in `protocol.rs`; the estate slot and four dispatch
   arms in `shell.rs`; `tests/face.rs`, all four tests. `cargo test -p fathom-wasm` green —
   including `artifact_gates` re-measuring the grown module; red there is §7 trigger 6, stop.
7. **The artifact.** Create `fathom-artifact` with the verbatim manifest and its members line;
   `base64`, `assemble`, the bin; then the shell source — the §4.5 CSP and file order, the
   furniture and reader transcriptions, the §4.6 face renderers; `tests/artifact.rs`, all four
   tests. JS renders reply strings; any join logic appearing in JS is a defect (§9 item 3).
8. **Hygiene.** Run G8's block; fix every hit — all greps run on files this WO authors, so
   every hit is this WO's to fix.
9. **Gates.** Run §6 G1–G9 in order, then the `78` §6 floor. All green or stop under §7.
10. **The checklist.** Run G10 if a browser is available to the session; otherwise mark each
    row NOT RUN. Record every row's result verbatim in the PR body either way — an unrecorded
    checklist is a red gate.
11. **Bookkeeping.** Status line → DONE; index row if the index exists; commit per `78` §3.9;
    push; open the PR listing every gate's output verbatim. Do not merge.

## 6. Acceptance gates

Run from the repository root, in this order. Expected output is exact; anything else is a red
gate and §7 applies.

| # | Command | Expected |
|---|---|---|
| G1 | `cargo fmt --all --check` | No output, exit 0 |
| G2 | `cargo clippy --all-targets -- -D warnings` | Builds clean, exit 0 |
| G3 | `cargo test -p fathom-inventory` | Every §4.7.1 test listed by name, all `ok`, 0 failed |
| G4 | `cargo test -p fathom-wasm` | WO-07's suites plus §4.7.2's four face tests, all `ok`, 0 failed; `artifact_gates` re-runs against the module as this WO leaves it and its printed size (≤ 900 000), empty import list and unchanged export set go in the PR body — red here is §7 trigger 6 |
| G5 | `cargo test --workspace` | Every suite `ok`, zero failures; no pre-existing test edited, loosened or ignored (`78` §5.5). No total is pinned — WO-01/02/07 land between this document and execution; green is the gate (`78` §12 item 3's precedent) |
| G6 | `cargo run -p fathom-schema --bin fathom-schema-check` | Exit 0; `0 failure(s), 2 warning(s)` — the standing `Site` baseline, unchanged |
| G7 | `cargo run -p fathom-artifact` | Exit 0; prints `target/artifact/fathom-dev.html · <n> bytes`; the file exists |
| G8 | The hygiene block below, verbatim | Each command prints exactly the count in its trailing comment. (`grep -c` exits nonzero when the count is 0 — the printed number is the gate, not the exit status.) |
| G9 | `git diff --name-only` against the branch point | Exactly §4's file list |
| G10 | **The manual checklist** — below | Every row PASS, or NOT RUN with the reason `no browser available to this session`; results verbatim in the PR body |

G8, in a fenced block so the alternation bars survive copying (a markdown-table `\|` becomes a
literal pipe and turns the gate into a vacuous pass — the defect this block exists to prevent):

```bash
# X0.8 against the final bytes (71 §3.6), on the artifact G7 assembled:
grep -c "connect-src 'none'" target/artifact/fathom-dev.html                  # 1
# No egress token in the hand-authored source (invariant 1). The base64 blob
# cannot encode these — '(' and ' ' are outside the RFC 4648 alphabet:
grep -cE 'new WebSocket|new EventSource|new XMLHttpRequest|navigator\.sendBeacon\(|fetch\(|import\(' \
  crates/fathom-artifact/html/fathom-dev.src.html                             # 0
# No HTML-string sink — the trusted-types directives must hold (§4.5):
grep -cE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write' \
  crates/fathom-artifact/html/fathom-dev.src.html                             # 0
# The token law (51 §10, §14) on the source; design/tokens.css is the one
# hex source and is spliced, never authored, here:
grep -E 'border-radius' crates/fathom-artifact/html/fathom-dev.src.html | grep -vc 'var(--radius)'   # 0
grep -E 'box-shadow' crates/fathom-artifact/html/fathom-dev.src.html | grep -vc 'var(--shadow)'      # 0
grep -cE 'transition:|animation:|@keyframes' crates/fathom-artifact/html/fathom-dev.src.html         # 0
grep -cE '#[0-9a-fA-F]{6}([^0-9a-zA-Z]|$)' crates/fathom-artifact/html/fathom-dev.src.html           # 0
```

All four token-law patterns and the five original egress patterns were verified `0` on
`design/prototype/fathom-app.html` (run 2026-08-02) — the discipline is demonstrated. Two
patterns were **not** zero there: the sink pattern (45 hits — the prototype's `innerHTML`
idiom, §3.1) and `import\(` (1 hit — the prototype's own header comment names it, line 538,
which is why §4.5's header-comment rule exists). Both are reasons these greps bind the new
source, authored under §4.5's rules, and not the prototype.

G10, honestly manual: `45` §9.1's harness is specified over external crates the tree does not
have; no headless render gate can exist until §10 item 1 is decided. The checklist is therefore
a gate a human runs — the executing session if it has a browser, otherwise the owner at merge
review. Steps: run G7, then open `target/artifact/fathom-dev.html?fixture=demo-estate` from
disk (`file://`), with the network disconnected if possible.

| # | Do | Expect |
|---|---|---|
| M1 | Open the file; check the browser's network tooling | Zero requests beyond the file itself — the artifact has no subresource; no console error |
| M2 | Press `⌥6` (or observe the boot view) | The inventory view; masthead, risk legend and band present; footer names the view |
| M3 | Read the kind strip | `Device` · `PhysicalPort` · `Premises`, `Device` pressed |
| M4 | Read the Device table | 2 rows, `srx-a` then `hub-a`, cells per §4.8; rightmost header `opinions`, both cells `—` |
| M5 | Narrow the window until the table scrolls horizontally | The opinions column stays visible (sticky); the page body never scrolls horizontally |
| M6 | Click `PhysicalPort`, then `Premises` | 6 rows then 3 rows, per §4.8; Bramble's `clli` cell reads `absent` |
| M7 | Click the `srx-a` row | The inspector posts it: eyebrow `Device`, name `srx-a`, the full 40-character `fathom:device:…` id, field table with `unset` provenance on unwritten fields |
| M8 | Switch the inspector to the equipment face | The per-equipment page: identity rows, 4 ports (per §4.8, chassis column present), 6 interface rows; the findings block reads `unposted — no rule engine in this build` |
| M9 | In the ports table, activate `hub-a · 0/1/0 · RVSD-FW-01` | The equipment page becomes `hub-a`'s; footer reads `followed the cable to hub-a` |
| M10 | Press `⌥6`, click a `Premises` row (Bramble), open the equipment face | The empty state (`.unposted`), no guess |
| M11 | Keyboard only: `Tab` to the table, `↓` `↓` `Home` `End`, `Enter` | One tab stop; arrows move the rove; `Enter` posts the focused row; focus visible throughout |
| M12 | Press `Esc` | Selection clears (the furniture's ladder); a second `Esc` does nothing and navigates nowhere |
| M13 | Press `⌥1`–`⌥5` in turn; `⌥←` at view 1, `⌥→` at view 6 | Each of the five other views renders §4.5's shared `.unposted` body; masthead and footer unmoved; the arrows do not wrap |
| M14 | Press `Ctrl+K`; then `Esc` | The finder overlay opens with its unposted body; `Esc` closes it (the ladder's first rung) |
| M15 | Re-open the artifact **without** `?fixture=demo-estate` | The inventory face renders the no-workspace state naming the fixture parameter (§4.5's copy); no estate, no error |
| M16 | Toggle the theme control | The face follows the token dark set; no colour outside the tokens appears |

## 7. Stop-and-escalate triggers

Any of these stops the session under `78` §4. Escalating is success.

1. Any step appears to need a dependency — a crate, an npm package, a tool download, a
   WebDriver client, a transform toolchain not already in the tree (`78` §5 item 2).
2. WO-07's crate as merged diverges from §3.2's record in a way §4.4 builds on — a missing
   export or const, a different reply skeleton or handle packing, a `decode_reply` shape the
   kind-5 arm cannot extend, or the `artifact_gates` suite absent.
3. WO-01's `canonical()` or WO-02's API diverges from §3.2 in a way that changes a §4 decision
   (a missing method, a different presence model, a different iteration order).
4. Any step appears to need: the rule engine, findings, sorting, filtering, in-cell editing,
   the column-picker UI, nested inventory rows, a derived-field evaluation, a hover surface, or
   a `Service`/`Tenant` row set. All deliberately absent (§8).
5. A projection needs a column, a public name, a rendered `TypeId`, a traversal, or an elision
   rule that §4 does not list — including any temptation to read the `occupied` derived field
   or to transcribe the prototype's `clip()`.
6. `artifact_gates` goes red after step 6's dependency link: the module exceeds 900 000 bytes,
   the import section is non-empty, or the export set changes in any direction. Report the
   measured size and the dumped sets verbatim; never edit the ceiling, `IMPORT_ALLOWLIST`, or
   WO-07's tests (WO-07 §7 items 2–4's posture).
7. The demo estate hits a `WriteError` on any §4.8 insert — the estate was checked against the
   schema's bounds at authoring; a refusal means the schema or the store moved.
8. Any step appears to need a hash or any crypto primitive (the `43` §3.7 `sha256` slots), a
   Trusted Types policy, a Worker, or any CSP directive beyond §4.5's block. The two recorded
   substitutions are the entire grant.
9. A fifth face role, a ninth string slot, a new record kind, or a fifteenth opcode appears
   necessary — §4.4's extension is closed; growing it again is planning's.
10. `docs/70-ops/79-work-orders/00-INDEX.md` or `73` §14 handling diverges from `78` §4's
    procedure at escalation time.

## 8. Non-goals

1. **No editing writes.** In-cell editing (`52` §3.7 "Lets you change"), bulk edit, the
   observation actions — all arrive after the face can be trusted read-only. This WO writes the
   graph only inside `demo_estate()`.
2. **No sorting and no `⌘F` in-view filter.** Row order is NodeId order, deterministic. The
   opinions sort (`52` §3.7.1: worst severity then count) is meaningless with no findings.
3. **No column-picker UI.** The column sets are this WO's pinned defaults; the generated picker
   over `NodeKind::fields()` is S4's remainder.
4. **No nested rows inside the inventory table** (`52` §5.5's indented `st0.0`-under-`st0`
   shape, `76` S4's "nested device→interface rows"). The equipment face's interfaces table
   carries the nesting in this slice; the in-table form is a follow-on work order.
5. **No findings, no opinions content, no suppressions** — the rule engine does not exist; the
   surfaces state that instead of faking it (§4.6).
6. **No `Service`, `Tenant`, `ServicePath`, warp, or Cable row set** — the service layer is its
   own modelling domain (`76` §7.2's deliberate omission); `Cable` rows wait for it or for a
   planning re-cut.
7. **No diagram, no finder UI, no walkthrough, no config view** — other slices; the five views
   render §4.5's unposted body and nothing else. The finder core exists crate-side and is
   untouched.
8. **No virtualised windowing in the renderer.** The demo estate is 25 nodes; `44` has no
   per-row inventory budget (§2), and building a window manager with nothing to scroll is
   speculation. The projections return rows in a stable order so a windowed renderer can slice
   without re-sorting; the windowing — and the elision rule §4.6 defers — lands with the first
   real estate (WO-05 + ingest weld), before which `44` §4.7.4's *"virtualised, sortable and
   actually usable at that scale"* is not yet a testable claim.
9. **No loading of saved estates** — WO-05's territory; the demo estate is the only workspace
   this face ever holds.
10. **No provenance disclosure beyond the cell** (54 §17's expansion), no explainer surface, no
    depth toggle content — the corpus has no explainers for these kinds yet (invariant 10).
11. **No finder wiring and no corpus embedding.** `OP_INIT`/`OP_QUERY` are in the module but
    the artifact never calls them in this slice; where the corpus blob is packed at
    artifact-build time stays open (WO-07 §10 item 6). The finder view's arrival is its own
    work order.
12. **No Workers and no X0.9 run.** The worker topology (`41` §3.8's three-instance table;
    WO-07 §8 hands it *"WO-08 or later"* — it is later: nothing here parses or seals) and
    X0.9's proxied 30-minute session (`71` §3.6 — needs the absent e2e harness) both remain
    specified, not run. X0.8 alone becomes real here.
13. **No hash-pinned CSP and no `fathom-<ver>.html`.** The versioned, hash-pinned assembly is
    `xtask assemble`'s (`42` §8.2), which does not exist; §10 item 7.

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **Conflation creep** — an interface name leaks into the ports table, or hardware identity keys off configuration | The `19` §3.2 law quoted at the code; `equipment_page_ports_never_name_an_interface`; the `Occupies` join confined to one named column |
| 2 | **The empty opinions column gets "cleaned up"** by a later session because it renders nothing | `opinions_cells_are_all_em_dash` pins the header and cells; the below-table note states the reason in the UI itself |
| 3 | **Logic migrates into the DOM layer** — a JS join here, a count there, until the projections stop being the truth | §4.2's decision; the reply carries every rendered string (§4.4), so JS has nothing to join; PR review compares the JS diff against "renders strings" — any graph traversal in JS fails review; the native tests only protect the Rust side, which is why the review control is named |
| 4 | **The demo estate fossilises as fixture theatre** — expectations hand-edited to match drifted rendering instead of the projection being fixed | `⟨B⟩` cells bind to `canonical()` so WO-01's format is never restated; literal cells are confined to `Identifier`/`Text`/`Clli`/`PlatformId`, whose WO-01 §4.2 rows (20/27/30/33) all give canonical as *"as written"* (§3.2) |
| 5 | **A second visual dialect** — the face invents a colour, a radius, a shadow, a duration | G8's greps; tokens.css is the only source of values and is spliced, never re-authored |
| 6 | **The manual gate silently rots** — G10 marked NOT RUN forever, nobody ever opens the file | G10's results are mandatory PR content either way; the owner merges (`78` §3.10), and a PR whose checklist is all NOT RUN is visible at the only merge gate the project has |
| 7 | **Contract drift** — a blocking WO lands differently and this WO is executed against §3.2's record instead of the tree | Step 1 is the re-verification, before any code; §7 triggers 2–3 |
| 8 | **The scaffolding CSP fossilises as the product CSP** — `'unsafe-inline'` ships in `fathom-<ver>.html` because nobody re-pins it | §12 item 7 records the substitution as scaffolding with its reason; §10 item 7 owns the re-pinning; X0.8's `connect-src` half is gated now (G8, §4.7.3), so the honest half is already load-bearing |
| 9 | **The JS reader drifts from the protocol** — a hand-edited offset, and the face renders garbage on a valid reply | `decode_reply` is the reference (WO-07 §4.5); `face.rs` pins every reply byte the reader will see; the reader handles kinds 0 and 5 only and renders any other reply as a visible refusal, never a guess |

## 10. Open decisions

Deliberately not decided here; owner or planning session only (`78` §7).

1. **The e2e harness fork.** `45` §9.1 specifies `fantoccini`/`thirtyfour`/`chromiumoxide`
   from `cargo test`; all are external crates against the zero-dependency position
   (`Cargo.toml`; `78` §5 item 2). Options are mechanically enumerable: an owner exception
   admitting the harness crates as dev-dependencies; a first-party WebDriver client; or the
   manual checklist as the standing gate. Until decided, G10 is the gate and every UI work
   order inherits it.
2. **The UI language.** ADR-0019 decides vanilla TypeScript with the `oxc` transform and a
   type gate; the tree has no transform toolchain and the prototype's demonstrated form is
   hand-authored JS. Whether the artifact adopts the ADR-0019 toolchain (an owner exception on
   dependencies) or the ADR is amended to match the zero-dependency reality is planning's.
   This WO ships the artifact in hand-authored JS and records the strain (§12 item 1).
3. **`PhysicalPort.occupied`'s definition.** The schema doc derives it from `Occupies`
   (*"True iff at least one Interface Occupies this port"*); `19` §3.2 derives occupancy from
   the presence of a `Cable` (*"Occupancy is derived from the presence of a Cable"*). Two
   different facts — an empty cage can be cabled to a dark run, and an occupied cage can be
   uncabled. This WO renders neither and walks cables explicitly; the reconciliation is a
   schema/`19` planning pass.
4. **When sorting, filtering, the column picker, in-cell editing and nested rows land** — the
   S4 remainder's own work order(s), after this face exists to hang them on.
5. **When `Service` and `Tenant` join the kind strip** — with the service-layer slice; the
   prototype already demonstrates their row sets and the strip is built to take them.
6. **The virtualisation trigger** — §8 item 8: which work order builds the windowed renderer
   (and with it the elision widths §4.6 defers), and whether `44` gains an inventory row
   budget when it does.
7. **When `xtask assemble` and the versioned artifact arrive** — `42` §8.2's stage-10 assembly
   with CSP hashes *"computed over the FINAL bytes"*, replacing §4.5's two `'unsafe-inline'`
   substitutions and the `fathom-dev` name with `43` §3.5's `fathom-<ver>.html`. Needs a
   sha256 in-tree, which arrives with the crypto slice — planning, with the finder-wiring and
   corpus-packing question (WO-07 §10 item 6).
8. **When the finder is wired into the artifact** — the `OP_INIT` boot sequence, the corpus
   blob's packing, and whether `OP_INIT` gains a stats reply (WO-07 §10 items 4 and 6).

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants 1–3, 7, 9, 10; terminology; ID forms; document conventions |
| `CLAUDE.md`; `docs/70-ops/78-execution-protocol.md` (whole) | The inherited constraint table; the loop, escalation rule, floor, queue rules; "green is the gate, not a number" |
| `docs/70-ops/79-work-orders/WO-07-the-wasm-shell.md` (whole) | The module contract transcribed in §3.2; the ABI, opcodes, error codes, reply skeleton and reference reader §4.4 extends; the nested-build/target-dir pattern §4.5 reuses; the §1/§8 hand-off quotes; the artifact-gates re-run posture |
| `docs/70-ops/76-scope-expansion-analysis.md` §§4.1, 4.2, 7.1–7.3, 8 | The S4 row quoted; R1/R2's exists/missing analysis; S0's owner inputs; Q4/Q5 |
| `docs/70-ops/71-roadmap.md` §3.6 (X0.8, X0.9 rows) | The two ship-gate wordings; X0.8 quoted in §2 and made real in §4.5/§4.7.3 |
| `docs/50-design/52-information-architecture.md` §§2.3–2.5, 3.7, 3.7.1, 3.8, 5.5, 9.5 | The inspector amendment; the inventory contract; the opinions column; the connection-matrix governing rules; the nested-row shape deferred; the six-view rule |
| `docs/50-design/53-interaction-and-keyboard.md` §§3 (head), 3.1–3.5, 3.7, 8.3–8.5 | The keymap ownership (ADR-0024); `⌥1–6`; Enter by context; the Esc ladder; roving; focus rules |
| `docs/50-design/54-component-catalog.md` §§2.5 (via §23's survivors), 6 (placement rule), 8.10, 9, 18, 23, 24 | The legend rule; the 400-line virtualisation precedent; the hairline table; the inspector's anatomy, states, keyboard, ID rule; the two surviving keymap rules; the a11y contract |
| `docs/50-design/51-design-tokens.md` §§10–12 | Radius zero and its grep; elevation none; M34 no-animation |
| `docs/50-design/55-accessibility.md` §1.4 (line 121 region), §3 headings | The no-tooltip row; colour independence context; verified by grep that `55` nowhere cites SC 1.4.13 by number |
| `design/tokens.css` (whole) | The token law transcription; the font `<!-- VERIFY -->`; the values the prototype consumes; §4.5's first splice input |
| `design/prototype/fathom-app.html` (whole, at the cited regions) | Every §3.1 behaviour claim: the CSP meta, script header, view registry, inventory region 12, equipment region 8, hover region 16, roving region 14, keyboard handler, notes and copy quoted in §4.6; the `innerHTML` count (45) and the header's literal `import()` (line 538), both grep-verified 2026-08-02 |
| `docs/10-core/19-service-and-physical-model.md` §§3.2, 3.3, 3.7 | The identity law; `label`/`speed_max` semantics; `Occupies`' shape and its from-set; the occupancy sentence in §10 item 3 |
| `schema/schema.yaml` (the §3.1 declarations); `schema/platforms.yaml` | Every field, cardinality, enum token and edge this WO's estate and columns use; the platform id set |
| `crates/fathom-ir/src/{scalar,value}.rs`; `crates/fathom-ir/src/generated/ir_types.rs`; `crates/fathom-id/src/lib.rs` | Stub shapes incl. the unit-stub `PortPosition`/`Transceiver`; `token()`/`name()`/`FIELD_KEYS`; `Ulid::{from_parts, encode, decode}`; the *"26-character Crockford encoding"* doc line and `DecodeError::Length` behind §4.7.1's 40-character pin |
| `docs/70-ops/79-work-orders/WO-01-the-scalar-trait.md` §1, §4.2 (rows 20, 27, 30, 33) | `Scalar::canonical`'s real scope — 35 of the 36 scalar bindings, `SecretPlaceholder` exempt, the 25 structured bindings untouched; Identifier/Text/Clli/PlatformId "as written" |
| `docs/70-ops/79-work-orders/WO-02-the-graph-store.md` §§1–4, 8 | The store API contract in §3.2; the `Display` form and its 26-character ULID; root-forest handling; the worked-example precedent for estate tables |
| `docs/40-stack/41-technology-choices.md` §§3.3, 3.4, 3.7, 3.8, 3.10 | The T2 skeleton and the taken record kinds 1–4; the read model (one `TextDecoder.decode`); opcodes 1–10, the extension rule, `Core.call`'s shape; the worker topology deferred in §8 item 12; the shadow-copy rule |
| `docs/40-stack/42-no-node-runtime.md` §§1.2, 2, 2.1, 3.1, 8.2 | Z2/Z5; the sixteen jobs; the trivial-bundle observation; mode A's inline order and *"never fetched"* |
| `docs/40-stack/43-deployment-modes.md` §§1.3–1.5, 3.5, 3.7 | What may differ between modes; the anti-fork list this face must not touch; `fathom-<ver>.html`; the D1 CSP block §4.5 carries |
| `docs/40-stack/44-performance-budgets.md` §§3, 4.3, 4.7.4, 7.1 | The budget table; B5's 25-row numbers; the inventory-at-scale sentence; the order of breakage (no inventory row) |
| `docs/40-stack/45-testing-strategy.md` §§9.1–9.3 | The specified-but-absent harness; the keyboard-first flows G10's checklist mirrors; the fixture-URL row behind §4.5's boot |
| `docs/90-decisions/adr-0019-…` (whole) | The Decision quoted; the negative consequences §12 item 1 leans on |
| RFC 4648 §4, §10 | The base64 alphabet, padding, and the seven test vectors §4.7.3 pins |
| `cargo test --workspace`; `fathom-schema-check`; the G8 greps on the prototype (all run 2026-08-02) | 80 passed / 0 failed; exit 0, `0 failure(s), 2 warning(s)`; the egress/token patterns `0`, the sink pattern 45, the one `import()` header hit |

## 12. Disagreements

1. **ADR-0019 says TypeScript; this WO's artifact ships hand-authored JS.** The ADR's toolchain
   (`oxc` transform, Go-native type check) is built from external crates and pinned binaries
   that the workspace's zero-dependency position forbids an execution session to add (`78` §5
   item 2). The prototype — the corpus's own fidelity bar — is vanilla JS with no build step,
   and ADR-0019 itself rejected "Plain JavaScript, no types" because the **WASM ABI seam**
   would be unchecked. This WO narrows that exposure rather than resolving it: the seam carries
   only the flat string records of §4.4, every one produced by code under native `cargo test`,
   and the JS reader mirrors a Rust reference decoder that is itself parity-tested. The fork is
   filed as §10 item 2, not decided here, and not silently absorbed.
2. **The prototype renders "What the rule engine thinks" on every element; this WO drops the
   section and renders the equipment face's findings block as `unposted`.** The prototype had a
   fixture rule set to show; this build has no engine, and `—` under a "what the engine thinks"
   heading would claim a run that never happened. The `unposted` idiom is the prototype's own
   honesty device (*"the body reads UNPOSTED instead of improvising one"*), applied one surface
   further.
3. **`53` §3.5 says `Enter` on an inventory row means "Expand child rows"; this WO makes it
   post the row.** There are no child rows in this slice (§8 item 4) and no in-cell editing, so
   `53`'s binding has no referent yet; the prototype's demonstrated behaviour (click/Enter posts
   the element) is what ships. When nested rows land, their work order restores `53`'s meaning
   and moves posting to the cell level — recorded so that session knows the deviation was
   deliberate, not ignorance of `53`.
4. **The equipment ports table gains a `chassis` column the prototype does not have.** The
   prototype's SRX fixture used globally-unique port labels (`ge-0/0/3`, `fab0`); the schema's
   `label` is the per-faceplate silkscreen with `owner`-scoped identity (`19` §3.3), so a
   two-chassis device can and does carry duplicate silkscreens (`0/3` on node0 and node1), and
   a table that cannot distinguish them misstates the hardware. The column renders
   `Chassis.member_index` — a schema fact, not an invention.
5. **`59` §3.8's clause is cut from the ports heading.** The prototype's heading reads *"The
   picture states the count; the column states the names (59 §3.8)"* — a claim about the
   diagram, which is not in this build (§8 item 7). The heading here is `Ports — every one,
   named`; the clause returns with S7.
6. **Corrections applied in repair, against this document's original claims.** The original
   §3.2 assumed WO-07 would deliver the artifact, its furniture, a reusable marshalling
   mechanism and a fixture entry point, and claimed WO-07 was *"not yet present in
   `docs/70-ops/79-work-orders/`"* — false on every count: `WO-07-the-wasm-shell.md` sits in
   this directory, and its §1 and §8 assign the artifact, the CSP, X0.8 and all JS/TS to WO-08
   while refusing every unimplemented opcode by number. §3.2, §4, §5, §6 and §7 were re-cut
   against the real WO-07; the artifact assembly (§4.5), the protocol extension (§4.4) and
   gate X0.8 (§4.7.3, G8) are now this WO's own deliverables. Also corrected: the original
   claimed WO-01 delivers `canonical()` *"for all 61 scalars"* — WO-01 §1 delivers 35 of the
   36 scalar bindings, with the 25 structured bindings untouched (§3.2); the srx-a display id
   was asserted as *"42+ chars"* — it is exactly 40 (§3.1, §4.7.1); §9 item 4 claimed literal
   cells were *"Text/Identifier only"* — the estate also pins `Clli` and `PlatformId` literals
   (rows 30/33); G6's grep alternations carried markdown pipe-escapes that made the gate
   vacuously pass — now fenced (G8); and two `occupied` cross-references pointed at §12 item 3
   instead of §10 item 3.
7. **Against `43` §3.7's hash-pinned `script-src`/`style-src`, this artifact ships
   `'unsafe-inline'` in both.** Computing `'sha256-…'` over the final inline bytes needs a
   sha256 the tree does not have; hand-rolling a crypto primitive in an assembler is refused
   outright (`32` owns crypto; §7 trigger 8). The prototype's CSP takes the same scaffolding
   posture, and WO-07 §3 already marks it *"prototype scaffolding; the product policy is `43`
   §3.7's"*. Every other directive ships verbatim — including `connect-src 'none'` (X0.8, now
   gated against final bytes) and `require-trusted-types-for 'script'`, which §4.5's
   no-sink rule makes real. The re-pinning is §10 item 7, with `xtask assemble`.
8. **Against `41` §3.7's table as a closed set of ten.** This WO adds opcodes 11–14 and record
   kind 5. `41` §3.7's own rule anticipates growth — *"a new call is a new opcode, never a
   changed one"* — and WO-07 §4.4 explicitly routes any face-driven extension to planning:
   *"a protocol extension (new opcode or new record kind), which is planning work"*. This
   planning document is where that extension is decided; the numbers 1–10 keep their `41`
   §3.7 meanings, opcodes 2, 3 and 5–10 stay refused by number (WO-07 §8), and the execution
   session may not add a fifteenth (§7 trigger 9).
