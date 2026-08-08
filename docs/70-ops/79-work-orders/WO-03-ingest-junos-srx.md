# WO-03 — Ingest, one platform: the junos-srx lexer, shaper, and bind

> **Status:** OPEN

Depends on: WO-01 (bind's stage-5 scalar dispatch needs `Scalar::parse` and the real
`SecretPlaceholder`), WO-02 (the store this fragment is designed to apply onto must exist so the
weld that follows this WO has both sides — §4.8 pins the contract; this WO calls nothing in it).

Execution protocol: `docs/70-ops/78-execution-protocol.md` governs this work order. Every
constraint in `78` §2 is inherited and not restated here; `78` §4's escalation rule applies to
every trigger in §7 below. Severity labels in any verification context are exactly
BLOCKER / MAJOR / MINOR (`78` §2).

The governing rule for everything below is `14`'s preamble register line (stated in the card's
register before §1 opens), quoted once and binding on every step:
*"NOTHING PARSED IS SILENTLY LOST, AND NOTHING SECRET IS EVER KEPT"*.

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

When this work order is done, `crates/fathom-ingest` exists and one call —
`ingest(paste, &dict)` — turns set-style junos-srx configuration text into an `IngestOutput`
holding: a typed graph fragment (nodes with `NodeKind`, edges with `EdgeKind`, field assertions
keyed by the schema's wire `FieldKey`s, values parsed through WO-01's `Scalar::parse`); a
redacted capture whose text no credential survives into; a drop manifest naming every redaction;
and a line ledger in which every byte of the input is accounted for — bound, understood-but-not-
modelled, unreadable, noise, or quarantined — with `14` §4.6's tiling invariant checked on every
run. The statement dictionary that drives binding and redaction ships as reviewable corpus data
under `corpus/dict/junos-srx/`, gated by its own build-time checks. This is the first half of the
on-ramp: paste in, typed fragment out. The second half — device identification, reconciliation
onto an existing graph, and the fragment-to-store weld — is deliberately not here (§8).

## 2. Binding sources

| Source | What it binds | The line that binds |
|---|---|---|
| `.context/conventions.md` invariants 1–3 | Permanent boundaries: the paste path is the only input path and it holds no credential | *"The application never accepts a credential."* |
| ADR-0002 §Decision (invariant 3, amended text) | The redaction gate is where the amended invariant is true — quoted here because every redaction decision below serves it | *"A pasted capture may *contain* a credential; it is redacted at the ingest gate and the unredacted text never reaches the encryptor (`14` §9.9)."* |
| `.context/conventions.md` invariant 9 | Deterministic ingest: same paste + same dictionary ⇒ identical output | *"Determinism where it is observable."* |
| `.context/conventions.md` invariant 10 | Dictionary entries are corpus content and carry `reviewed_by` | *"No model output ships in the corpus without a named human reviewer"* |
| `14`, preamble | The register rule every stage serves (the register line sits before §1's heading) | *"NOTHING PARSED IS SILENTLY LOST, AND NOTHING SECRET IS EVER KEPT"* |
| `14` §2.2 | What is per-platform and what it is made of | *"The only per-platform Rust is the lexer table and the shaper."*; stage 5's per-platform cell: *"**the statement dictionary** — corpus data, not code"* |
| `14` §3.7 | The parsing approach, decided | *"hand-written, line-oriented framer and lexer; a small hand-written shaper per platform producing one shared CST; and a corpus-authored statement dictionary that drives binding, redaction, emission and explanation from one table."* |
| `14` §4.6 | The accounting invariant the ledger must prove | *"the ledger's spans, plus the single-byte separators between them, tile `[0, capture_len)` exactly — no gaps, no overlaps."* |
| `14` §5.1 | The `display set` grammar and the shaper's one law | *"every token becomes a path segment and `args` is empty for `display set`."* |
| `14` §5.5 | The lexer table is data | Lexer token table row: *"Data + a few lines"* |
| `14` §6.3 | Trie lookup semantics and budget | *"Literal always wins."*; the 64-visit budget with the ≤ 8 CI assertion |
| `14` §7.1 | Bind: only terminals; failure granularity | *"A scalar parse failure does not fail the line."* |
| `14` §8.2 | Totality | *"Recovery is not a fallback path. It is the main path with fewer outcomes."* |
| `14` §8.5 | Residue is a first-class output | *"The residue is not a log. It is workspace content."*; *"It is never auto-deleted."* |
| `14` §9.1; §2.1 | The gate's position and the four structural properties (§9.1); the literal sits in §2.1's stage-4 box | *"NOTHING PASSES UNGATED."* |
| `14` §9.4, §9.6, §9.7 | The value-shape detectors, the user's own redactions, quarantine | §9.7: *"A line that trips any detector is `Quarantined`: its text is destroyed and replaced by a shape sketch."* |
| `14` §9.11 | The two CI proofs this WO must ship in-slice form | Gate 2: *"the set of `secret:` dictionary entries is the redaction catalogue by construction"* plus the last-literal-segment assertion |
| `14` §11.4, §11.6 | The refusal caps and the bounded-depth rules | *"refuse before processing"*; depth capped at 64; no recursion on user-controlled depth |
| `61` §6.4 | Fixture addressing discipline | Documentation ranges only: RFC 5737 `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`; hostnames under `.example`/`.example.net` |
| WO-01 §4.1, §4.2, §4.4 | The exact scalar API this WO consumes: `Scalar::parse`/`canonical`, `ScalarParseError`, `SecretPlaceholder::new(label)`, the five `SecretLabel` variants | *"There is no `SecretPlaceholder::from_value`."* (WO-01 §2, quoting `11` §4.5) |
| `CLAUDE.md` (Next actions, owner-only) | The S0 fixture exports are owner-blocked; the synthetic fixture is the stand-in | *"the S0 fixture exports (`76` §7 …)"* |
| `.context/field-card-srx-ipsec.txt` sides 1–2 | The vendor lines the dictionary and fixture transcribe | `set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14` |
| `schema/schema.yaml` (kinds/edges cited per row in §4.7) | What is declarable; `emit_dict` already names one dictionary id this WO must match | `ExternalInterface` edge: `emit_dict: junos-srx/security.ike.gateway.external-interface` |
| `78` §2 | Everything inherited: invariants, zero dependencies, pinned 1.94.1 toolchain, `forbid(unsafe_code)`, the risk enum, severity labels, house style | (whole table) |

## 3. Prior state

All verified against the working tree at authoring time (2026-08-02; `cargo test --workspace`
80 passed, 0 failed; `fathom-schema-check` exit 0, `0 failure(s), 2 warning(s)`, summary
`48 kinds · 89 edges · 61 scalars · 10 enums · 14 files parsed`).

- `crates/` holds six crates (`fathom-corpus`, `fathom-find`, `fathom-id`, `fathom-ir`,
  `fathom-schema`, `fathom-schemagen`). There is no `fathom-ingest` and no `fathom-graph`;
  WO-02 delivers the latter. `corpus/` holds `commands/`, `explainers/`, `rules/` — no `dict/`.
- `crates/fathom-schema/src/subset.rs`: the one YAML parser, `parse_profile` with
  `Profile::{Schema, Corpus}`. Its header: *"This is not a general YAML implementation and must
  never become one."* `Profile::Corpus` carries exactly three extensions (folded `>` scalars,
  same-indent sequences, multi-line flow). `crates/fathom-corpus/src/load.rs` is the precedent
  consumer (`use fathom_schema::subset::{parse_profile, Profile};`).
- `crates/fathom-schema/src/model.rs`: `SchemaTree::load(root)` exposes `kinds: Vec<KindDecl>`
  (each with `fields: Vec<FieldDecl>` carrying `name` and `ty`), `edges: Vec<EdgeDecl>`, and
  `field_keys: Option<FieldKeys>` whose `entries: Vec<(String, i64, usize)>` are the
  `Kind.field → wire key` rows of `schema/field-keys.yaml` (e.g. `Device.hostname: 6`,
  `IkeProposal.dh_group: 149`, `UsesProposal.ordinal: 281`, `ZoneMember.host_inbound_system_services: 283`).
- `crates/fathom-ir/src/generated/ir_types.rs`: `NodeKind` (48 variants, `from_name`, `name`),
  `EdgeKind` (81, `from_name`), and generated enums each with `from_token(&str)` over **neutral
  tokens** (underscored: `EstablishTunnels::DECLARED` holds `"on_traffic"`, `"responder_only"`)
  and an `Unknown(String)` arm. Enums this WO binds: `IkePolicyMode`, `IpsecProposalProtocol`,
  `EstablishTunnels`, `IpsecVpnDfBit`, `Family`, `AddressFamily`, `HostService`.
- `crates/fathom-ir/src/bag.rs`: `FieldKey(pub u32)` — the stable wire key the fragment's field
  assertions use.
- `crates/fathom-ir/src/value.rs`: structured stubs. Shapes that exist and are consumed here:
  `PeerSpec { Address(scalar::IpAddr), Dynamic(IkeId) }`. Shapes that are empty structs and
  therefore **not bindable** (each drives a §4.7 exclusion): `IkeId`, `Dpd`, `VpnMonitor`,
  `PolicyScope`, `AddressValue`, `L4Spec`, `NatScope`, `NatAction`, `OspfArea`.
- `crates/fathom-ir/src/scalar.rs` is the stub file today; **WO-01 rewrites it**. This WO
  consumes exactly WO-01 §4.1's API (`Scalar::parse(text) -> Result<Self, ScalarParseError>`,
  `canonical()`) and §4.4's `SecretPlaceholder::new(label)` with the five-variant `SecretLabel`
  (`Psk`, `CertKey`, `SnmpCommunity`, `TacacsKey`, `Password`).
- `crates/fathom-id/src/lib.rs`: *"There is deliberately no `new()` that reads a clock or an
  RNG"*. Consequence adopted in §4.8: the fragment mints **no** ULIDs; nodes are dense indices.
- `corpus/commands/junos-srx-ipsec.yaml`: 49 `mode: configuration` entries, of which 45 are
  `set` statements — the fixture's raw material (grep `cmd: "set ` for those; the other four
  are `commit` forms the fixture does not use; the exact lines used are transcribed in §4.9).
- `Cargo.toml` (workspace): six members, `[workspace.dependencies]` empty on purpose.
  `rust-toolchain.toml`: `channel = "1.94.1"`.
- The schema checker's standing baseline is two `schema.identity.unexercised` warnings against
  `Site` (`78` §6). Nothing in this WO may change the warning set.

**Execution-start checklist** (before plan step 1; a failure of any item is a §7 trigger):

1. WO-01 and WO-02 are `DONE`: read `docs/70-ops/79-work-orders/00-INDEX.md` if it exists;
   if planning has not authored the index yet, read the two work orders' own status lines,
   which `78` §8 makes authoritative either way (*"Each work order's own status line is the
   truth; the index mirrors it."*).
2. `crates/fathom-ir/src/scalar.rs` contains `pub trait Scalar` and `impl Scalar for` the types
   §4.7's tables name; `SecretPlaceholder::new(SecretLabel::Psk)` compiles.
3. `crates/fathom-graph` (or whatever crate WO-02 shipped as the store) exists. Read its
   `src/lib.rs` module doc only. If it already exposes an ingest-fragment or capture type, stop
   — §7 trigger 2. This WO does not add it as a dependency (§4.8).

## 4. Deliverables

Exactly these files change or are created. No file under `schema/`, nothing under
`crates/fathom-ir/`, nothing under `corpus/commands|explainers|rules/`.

| File | Change |
|---|---|
| `Cargo.toml` | One member line added, verbatim (§4.2) |
| `crates/fathom-ingest/Cargo.toml` | New, verbatim (§4.2) |
| `crates/fathom-ingest/src/{lib,frame,lex,shape,redact,dict,bind}.rs` | New — the public API is §4.2–§4.8's listing, complete |
| `corpus/dict/junos-srx/{token-maps,system,security-ike,security-ipsec,security-zones,interfaces}.yaml` | New — the statement dictionary, §4.7 |
| `crates/fathom-ingest/tests/{dict_gates,srx_fixture,redaction_canary,determinism}.rs` | New — §4.9, §6 |
| `crates/fathom-ingest/tests/fixtures/junos-srx-s0-synthetic.txt` | New — §4.9, verbatim |
| This file | §6.1's count table backfilled by the executing session, same PR |

### 4.1 Scope — which of `14`'s syntactic families are in this slice

The slice is **set-style junos-srx text only**, and within it exactly these families. "Residue by
design" means the input is accepted, classified, preserved and counted — never silently dropped
(`14` §1) — and a later work order upgrades it to bound.

| Family (`14` §) | This slice | Disposition |
|---|---|---|
| UTF-8 decode, BOM strip, `\r\n`/`\r` → `\n`, tab → space (§4.2 steps 1–3, 6) | in | Implemented as stated |
| Windows-1252 fallback (§4.2 step 2) | out | Refuse the paste with the byte offset (`IngestRefusal::Undecodable`). Deferral recorded in §12 item 5 |
| ANSI/backspace strip, confusables, HTML entities (§4.2 steps 4, 5, 7) | out | Damage-tolerance WO. Such bytes land in `Unshaped` residue, never mis-bound |
| Noise: prompt, command echo, cluster banner, pagination, blank (§4.1, §4.4) | in | Patterns pinned in §4.3. Pagination sets `truncated: true` |
| Noise: edit markers, diff/quote markers, session timestamps, separators (§4.1) | out | Unmatched lines become `Unshaped { NotVerbInitial }` residue — the conservative direction: never guessed, always counted |
| Backslash continuation (§4.3) | in | The one **certain** join; the field card's own format |
| Hard-wrap detection and soft continuation (§4.3) | out | Damage-tolerance WO. A non-verb, non-noise line is `Unshaped { NotVerbInitial }` — `14` §4.3's own rule *"When the parser cannot tell, it says so rather than picking"* applied at slice granularity |
| Verb recogniser, all 12 config-mode verbs (§4.3) | in | Recognised so continuation is decidable |
| `set` statements: bare / quoted / bracket-list tokens (§5.1's eleven-line grammar) | in | The whole grammar |
| `deactivate` and the other ten verbs' semantics (§5.1) | out | `Unshaped { UnsupportedVerb }` residue by design. Inactive-flag semantics land with reconciliation (§10 item 3) |
| Configuration groups (§5.1 DECISION: detect, never expand) | in (detect only) | `groups`/`apply-groups` statements are `Unmapped` residue; `IngestOutput.uses_groups` is set. The completeness prompt lands with reconciliation |
| Opaque blocks (§4.5) | out | Junos set-form has none of the block forms; a PEM-armour token quarantines the line (§4.6) |
| Redaction gate: path detector, value-shape detectors, user pre-redactions, quarantine (§9.2–§9.7) | in | **Non-optional, with its own tests** (§4.6, §4.9) |
| Bind: trie, longest prefix, captures, budget, only-terminals, in-fragment upsert (§6.3, §7.1) | in | §4.8 |
| Deferred edge resolution: `ByName`, `InterfaceUnit`; unresolved → `Pending` (§7.3) | in | Scope is pinned `Fragment`, so unresolved is always `Pending`, never `Broken` |
| Capture-scope computation (§7.4) | out | `CaptureScope::Fragment`, constant. Nothing in this slice asserts absence, so pinning the conservative value loses nothing (§12 item 6) |
| Truncated-head recovery, prefix inference (§8.6) | out | `Unshaped { NotVerbInitial }` — and §4.6 quarantines it if it smells of a secret, which is `14` §9.7's own hard case |
| Device identification, reconciliation, the plan (§10) | out | The second half of the on-ramp |
| Curly-brace Junos, IOS, PAN-OS (§5.2–§5.4) | out | Later platforms/forms; the shared `StmtTree` is built so they converge on it |

### 4.2 The crate

`Cargo.toml` (workspace root) — the `members` list gains one line, keeping alphabetical order:

```toml
    "crates/fathom-ingest",
```

`crates/fathom-ingest/Cargo.toml`, verbatim:

```toml
[package]
name = "fathom-ingest"
version = "0.1.0"
edition.workspace = true
license.workspace = true
publish.workspace = true
description = "Ingest, one platform: the junos-srx framer, lexer, set-shaper, redaction gate and binder (14; WO-03)"

[dependencies]
# Workspace-internal only; the no-external-dependencies position (35, workspace
# Cargo.toml) holds. fathom-schema supplies the one YAML-subset parser
# (Profile::Corpus) for the statement dictionary; fathom-ir supplies scalars,
# generated kinds/enums and FieldKey.
fathom-ir = { path = "../fathom-ir" }
fathom-schema = { path = "../fathom-schema" }
```

`src/lib.rs` opens with:

```rust
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
```

(`14` §11.6/§13.5's panic policy; slicing goes through a checked span helper, private.)
`#[cfg(test)]` modules are exempt from the four clippy denies via a module-level `allow` — tests
may unwrap.

Public modules: `frame`, `lex`, `shape`, `redact`, `dict`, `bind`. The complete public surface is
what §4.2–§4.8 list. **Any other public name is a §7 trigger.** Private helpers are free to name.

Top level (`lib.rs`):

```rust
/// 14 §11.4's refusal caps: refuse before processing, never OOM mid-way.
pub const MAX_PASTE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PASTE_LINES: usize = 250_000;

/// Total for every input within the caps (14 §8.2). The only two refusals,
/// both decided before any stage runs (14 §11.4).
pub fn ingest(paste: &[u8], dict: &dict::Dictionary) -> Result<IngestOutput, IngestRefusal>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestRefusal {
    /// Not UTF-8; offset of the first bad byte (14 §4.2 step 2, cp1252
    /// fallback deferred — §12 item 5).
    Undecodable { offset: usize },
    TooLarge { bytes: usize, lines: usize },
}

/// 14 §7.4's computation is deferred; this slice never asserts absence, so
/// the conservative value is pinned (§12 item 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureScope { Fragment }

#[derive(Debug)]
pub struct IngestOutput {
    pub capture: redact::RedactedCapture,
    pub ledger: frame::LineLedger,
    /// Every ledger entry whose outcome is Unmapped, Unshaped or Quarantined,
    /// in ordinal order (14 §8.5). First-class: callers persist this, they do
    /// not recompute it.
    pub residue: Vec<ResidueEntry>,
    pub drops: redact::DropManifest,
    pub fragment: bind::Fragment,
    pub scope: CaptureScope,
    /// 14 §5.1's group DECISION, detect half: any statement whose first path
    /// segment is `groups` or `apply-groups`.
    pub uses_groups: bool,
    /// A pagination marker was seen (14 §4.4's last row).
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct ResidueEntry {
    pub ordinal: frame::LineOrdinal,
    pub span: frame::ByteSpan,
    pub outcome: frame::LineOutcome,
}
```

Determinism (invariant 9 via `78` §2): no `HashMap`/`HashSet` anywhere in the crate —
`BTreeMap`/`BTreeSet` or sorted `Vec` only; no clock, no RNG, no environment read; all output orderings are input
order or explicitly stated sorts. `tests/determinism.rs::ingest_twice_identical` runs the fixture
twice and asserts the two `IngestOutput`s are equal field-for-field and `format!("{:?}", …)`
byte-identical.

### 4.3 Frame

Types (`frame.rs`), all public:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ByteSpan { pub start: u32, pub end: u32 }      // capture coordinates

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct LineOrdinal(pub u32);                          // dense, from 0, input order

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JoinKind { None, Backslash }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseClass { Prompt, CommandEcho, ClusterBanner, Pagination }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineClass { Statement, Noise(NoiseClass), Blank }

#[derive(Debug, Clone)]
pub struct LogicalLine {
    pub ordinal: LineOrdinal,
    /// Physical-line spans joined to make this line; len 1 unless Backslash.
    pub pieces: Vec<ByteSpan>,
    pub join: JoinKind,
    pub class: LineClass,
}

#[derive(Debug, Clone)]
pub struct LineLedger { pub capture_len: u32, pub lines: Vec<LedgerEntry> }

#[derive(Debug, Clone)]
pub struct LedgerEntry {
    pub ordinal: LineOrdinal,
    pub span: ByteSpan,                 // post-redaction coordinates, 14 §9.5
    pub outcome: LineOutcome,
    pub diags: Vec<Diag>,
}

/// 14 §8.3's contract, transcribed with two slice notes (§12 items 3–4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineOutcome {
    Bound { node: bind::FragNodeId, fields: u16, edges: u16 },
    /// Path shaped cleanly; dictionary has no binding for it. `known_prefix`
    /// is the number of leading path segments the trie recognised.
    Unmapped { known_prefix: u8 },
    Unshaped { reason: ShapeError },
    Noise { class: NoiseClass },
    Blank,
    /// 14 §9.7 — text destroyed, sketch stored, length recorded.
    Quarantined { label: redact::RedactLabel, orig_len: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeError {
    /// First token is not one of the 12 config-mode verbs and the line is
    /// not noise. Covers clipped heads, wraps, markers — everything §4.1
    /// defers (14 §4.3's refuse-to-guess rule).
    NotVerbInitial,
    /// A recognised verb this slice does not bind (everything except `set`).
    UnsupportedVerb,
    UnterminatedQuote,
    UnterminatedBracket,
    /// Final physical line ends with an unquoted `\`.
    UnterminatedContinuation,
    /// A `binds`-key capture failed Identifier/u32 parse, or was redacted at
    /// the gate (§4.6's read-path DECISION, rule 3) — the node cannot be
    /// identified, so nothing on the line may bind.
    KeyUnparsable,
    /// More than 64 path segments (14 §11.6's depth cap at this layer).
    TooManySegments,
}

/// Per-line diagnostics that do not change the outcome class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Diag {
    /// 14 §7.1: a value failed Scalar::parse / enum from_token / token-map
    /// lookup; the rest of the statement still bound.
    ValueUnparsed { key: fathom_ir::bag::FieldKey },
}
```

Framing rules, in order (each deviation from `14` §4 is in §12, none is silent):

1. Refusals first: size caps, then strict UTF-8 (`14` §11.4, §4.2 step 2).
2. Strip one leading UTF-8 BOM; normalise `\r\n` and lone `\r` to `\n`; each tab becomes one
   space (`14` §4.2 steps 1, 3, 6).
3. Physical lines ending in an unquoted `\`: drop the `\`, drop the next line's leading
   whitespace, join with exactly one space (`14` §4.3's backslash row, verbatim). A trailing `\`
   on the final line is `Unshaped { UnterminatedContinuation }`.
4. Noise classification, exact patterns, applied to the whole trimmed physical line before verb
   testing:
   - **Prompt**: matches `^[A-Za-z0-9_.@-]+[>#]$` — a bare prompt with nothing after it.
   - **CommandEcho**: matches `^[A-Za-z0-9_.@-]+[>#] .+$` — prompt plus an echoed command. One
     class per line: `14` §14.2 marks such a line both Prompt and CommandEcho; this slice keeps
     the single-class ledger and picks CommandEcho (§12 item 4).
   - **ClusterBanner**: `{` + one or more of `[a-z0-9:-]` + `}` and nothing else — covers
     `{primary:node0}`, `{backup}` (`14` §4.4).
   - **Pagination**: trimmed line starts `---(more` and ends `)---`, or equals `--More--`
     (`14` §4.1, §8.1). Sets `truncated`.
5. Blank lines are `Blank`. Everything else is `Statement` and goes to the lexer.
6. **Invariant L** (`14` §4.6, quoted in §2): asserted after every ingest and by
   `srx_fixture.rs::fixture_ledger_tiles` — spans plus one-byte separators tile
   `[0, capture_len)` exactly.

Evidence mining from noise (hostname, cluster membership — `14` §4.4) is **not** performed: the
consumer (device identification) is a later WO, and minted-but-unused `Heuristic` evidence would
be an invented API. The classes are preserved so that WO adds mining without reframing.

### 4.4 The lexer table — data, and the junos-srx instance

`14` §2.2 makes the lexer *"shared scanner, per-platform token table"* and §5.5 prices the table
as *"Data + a few lines"*. Transcribed literally:

```rust
// lex.rs
/// The per-platform half of stage 2 (14 §2.2): data, not code.
#[derive(Debug, Clone, Copy)]
pub struct LexTable {
    pub quote: char,
    pub escape: char,
    /// Bracket-list delimiters (14 §5.1's bracket_list production).
    pub list_open: char,
    pub list_close: char,
    /// Bytes that may appear in a bare token: everything printable except
    /// space, tab, the quote and the two list delimiters (14 §5.1: bare :=
    /// [^ \t"\[\]]+ ).
    pub bare_excludes: &'static [char],
}

/// junos-srx `display set` (14 §5.1's eleven-line grammar).
pub const JUNOS_SET: LexTable = LexTable {
    quote: '"',
    escape: '\\',
    list_open: '[',
    list_close: ']',
    bare_excludes: &[' ', '\t', '"', '[', ']'],
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind { Bare, Quoted, ListOpen, ListClose }

#[derive(Debug, Clone, Copy)]
pub struct Token { pub kind: TokenKind, pub span: frame::ByteSpan }
```

The scanner is shared code, iterative, and property-tested: `lex.rs`'s unit test
`token_spans_slice_back` asserts every token's span slices back to its own text (`14` §3.8's
mitigation row). Quoted tokens keep their quotes in the span; the shaper strips them when it
interns (§4.5 — the binder reads interned segments, never spans, per §4.6's read-path). An
unterminated quote or bracket at end of line yields the corresponding `ShapeError`.

### 4.5 The shaper and the CST

`shape.rs` — the `display set` shaper only. Types:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SegId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct StmtIdx(pub u32);

#[derive(Debug)]
pub struct StmtTree {
    pub arena: Vec<StmtNode>,
    pub roots: Vec<StmtIdx>,
    /// Interned segment text, owned — quoted segments intern escape-resolved,
    /// so a segment cannot slice the capture (§12 item 10). The gate re-points
    /// redacted positions at freshly interned marker segments (§4.6 rule 1);
    /// the binder reads token text from here and nowhere else (§4.6 rule 2).
    pub segs: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct StmtNode {
    pub seg: SegId,
    pub parent: Option<StmtIdx>,
    pub children: Vec<StmtIdx>,          // ordered as read (14 §2.4)
    pub span: frame::ByteSpan,           // the whole statement
    pub line: frame::LineOrdinal,
    /// True on the deepest node of each `set` statement's path — the
    /// terminal the binder visits (14 §7.1: only terminals bind).
    pub terminal: bool,
    /// None until stage 4; the gate sets it when it redacts this node's
    /// token and re-points `seg` at a marker segment (§4.6 rule 1). The
    /// binder trusts this flag, never the segment text (§4.6 rule 2).
    pub redacted: Option<redact::RedactLabel>,
}

/// The 12 config-mode verbs (14 §4.3), for continuation decidability. Only
/// `set` shapes in this slice (§4.1; §12 item 3).
pub const VERBS: [&str; 12] = [
    "set", "deactivate", "delete", "activate", "annotate", "insert",
    "rename", "copy", "protect", "unprotect", "wildcard", "replace:",
];
```

Rules, from `14` §5.1 with the slice simplifications recorded in §12 item 3:

- Every token of a `set` line becomes a path segment; there are no args on the tree — *"the
  shaper does not decide where the path ends"* (`14` §2.4); the binder splits.
- Two lines sharing a prefix share tree nodes; child order and root order are input order and
  are never sorted.
- Quoted tokens intern with quotes stripped and escapes resolved (`\"` → `"`, `\\` → `\`).
- A bracket list `[ a b ]` after a path expands the statement into one terminal per list member,
  in list order, all sharing the line's span — the binder sees N terminals for
  `set security ike policy IKE-POL proposals [ P1 P2 ]`.
- More than 64 segments: `Unshaped { TooManySegments }` (`14` §11.6). The shaper is iterative;
  there is no recursion on input depth.

### 4.6 The redaction gate — non-optional, order-pinned

Position: after shape, before bind, exactly `14` §9.1 (the literal is §2.1's stage-4 box) —
*"NOTHING PASSES UNGATED."* The gate rewrites the capture buffer, every recorded span, and the
tree's redacted positions in one pass; every span stored anywhere afterwards is in
post-redaction coordinates (`14` §9.5). ADR-0002's amended invariant 3 is the contract, quoted
in §2: the unredacted text never reaches anything that outlives the call.

**DECISION — the post-gate read-path, pinned.** `14` carries redaction through the tree on
`Arg::Redacted` (§2.4's `ArgKind`; §9.1's third structural property: stages 5–7 read a tree
*"whose `Arg::Redacted` variant carries no text"*). This slice has no args — every token is a
path segment — so the mechanism moves onto the segment nodes, in three rules the binder and
every test are built against:

1. **The gate rewrites the tree, not just the buffer.** For every token position it redacts,
   the gate re-points that node's `seg` at a freshly interned segment holding exactly the
   marker text and sets `StmtNode.redacted = Some(label)`. It never rewrites an interned
   `String` in place: interning is shared, and a secret whose text collides with a literal
   segment used elsewhere (`set snmp community security`) would otherwise corrupt unrelated
   statements. The abandoned segment is unreachable from any node afterwards.
2. **Bind reads segment text only.** Stage 5 takes every token's text from `StmtTree.segs` —
   which is why §4.5 interns quoted tokens escape-resolved; nothing downstream re-slices the
   capture — and a detector-redacted position can never bind from pre-redaction text, because
   no stage after the gate holds any. The flag, not the marker, is the authority: WO-01 §4.2's
   `Identifier` admits any non-empty ASCII-graphic string, so `<REDACTED:unknown>` *would*
   parse as a valid `Identifier` — the binder must test `redacted`, never match text.
3. **What a redacted position does at bind.** On a `secret:`-matched entry the value capture
   binds `SecretPlaceholder::new(label)` from the entry's label (§4.8's law). A safety-net-
   redacted **value** capture on a `binds` entry is `Diag::ValueUnparsed` for that key; the
   rest of the statement still binds (`14` §7.1). A safety-net-redacted **key** capture makes
   the node unidentifiable: the line is `Unshaped { KeyUnparsable }`, and it is not
   re-quarantined — its secret position was already rewritten at the gate and its drop is
   already in the manifest. Proof: `redaction_canary.rs::redacted_key_never_binds` (§4.9).

The `StmtTree` is not a field of `IngestOutput` and does not outlive `ingest`; everything that
outlives the call reads only `RedactedCapture` and structures derived after the gate.

Types (`redact.rs`):

```rust
/// Only the gate constructs one; the text field is private (14 §9.1's
/// "CaptureStore::insert takes a RedactedCapture" property, at this slice's
/// boundary).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactedCapture { /* text: String — private */ }
impl RedactedCapture { pub fn text(&self) -> &str; }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DropManifest {
    pub entries: Vec<RedactionEntry>,
    /// 14 §9.6: user pre-redactions — bound, not counted as drops.
    pub already_redacted: Vec<frame::LineOrdinal>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactionEntry {
    pub ordinal: frame::LineOrdinal,
    pub span: frame::ByteSpan,          // of the marker, post-redaction
    pub label: RedactLabel,
    pub detectors: DetectorSet,
    /// 14 §9.5: for the in-session report only; the persistence layer must
    /// not store it. Enforced by doc comment now, by the store weld later.
    pub orig_len: u32,
}

/// Ingest-side labels. The first five mirror fathom_ir's SecretLabel
/// one-to-one; Unknown covers 14 §9.4's safety-net detections, which have no
/// graph-side label. Extending SecretLabel itself is WO-01 §7 trigger 5 —
/// owner/planning work, not this crate's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedactLabel { Psk, CertKey, SnmpCommunity, TacacsKey, Password, Unknown }
impl RedactLabel {
    pub fn to_secret_label(self) -> Option<fathom_ir::scalar::SecretLabel>;  // Unknown -> None
    /// The marker token: psk, cert-key, snmp-community, tacacs-key,
    /// password, unknown.
    pub fn token(self) -> &'static str;
}

/// Bit set over the detectors that fired (a value may be caught by several;
/// 14 §9.2: "redacted once and the manifest records both reasons").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetectorSet(pub u8);
impl DetectorSet {
    pub const PATH: u8 = 1;
    pub const CRYPT_PREFIX: u8 = 2;
    pub const PEM_ARMOUR: u8 = 4;
    pub const LONG_HEX: u8 = 8;
    pub const BASE64: u8 = 16;
    pub const LEAF_NAME: u8 = 32;
}

/// 14 §9.4's secret-word list, verbatim, case-folded, hyphens = underscores.
pub const SECRET_WORD_LIST: [&str; 24] = [
    "key", "keys", "key-string", "secret", "shared-secret", "password",
    "passwd", "plain-text-password", "encrypted-password", "psk",
    "pre-shared-key", "passphrase", "community", "snmp-community-string",
    "authentication-key", "auth-key", "md5", "hmac", "credential", "token",
    "bearer", "phash", "passhash", "private-key",
];
```

The marker written into the capture is `<REDACTED:` + `label.token()` + `>`, unquoted — `14`
§14.3: the stored capture must not be pasteable back into a box, unlike the emitter's quoted
`"<PSK>"`.

Detector rules, each with its source:

| Detector | Fires on | Rule | Source |
|---|---|---|---|
| Path | shaped `set` statements | The statement's path matches a dictionary entry carrying `secret:`; the argument capture(s) named by the entry are redacted with the entry's label | `14` §9.2, §9.3 |
| Crypt prefix | every argument token, bound or not | token (quotes stripped) matches `^\$[0-9a-z]{1,2}\$` | `14` §9.4 |
| PEM armour | every token | token begins `-----BEGIN` → the **whole line** is `Quarantined { CertKey }` (opaque-block capture is deferred; quarantine is the conservative containment) | `14` §9.4, §4.5; §12 item 7 |
| Long hex | every argument token | `^[0-9a-fA-F]{32,}$` | `14` §9.4 |
| Base64 | argument tokens on **Unmapped** statements only | `^[A-Za-z0-9+/]{24,}={0,2}$` — `14` §9.4's three-condition guard, which is what keeps fingerprints and descriptions alive | `14` §9.4 |
| Leaf name | argument tokens | walk from the argument towards the root over the **two** nearest preceding literal path segments (captures are skipped and do not consume a position; on an `Unshaped` line the walk is over the two preceding raw tokens); fires if either visited segment, case-folded with `-`/`_` equal, is in `SECRET_WORD_LIST`. `14` §9.4's strict wording names only the last literal segment, but §14.3's own worked case fires through `ascii-text` — not in the list — via the `pre-shared-key` one position behind it; the two-position walk is the rule that satisfies the worked example (§12 item 9). **Suppressed** when the statement matched an entry carrying `secret_exempt:` (§4.7); without that suppression the field card's own `perfect-forward-secrecy keys group14` loses its DH group (§12 item 2) | `14` §9.4, §14.3; field card side 1 |

"Argument tokens" for detector purposes: on a dictionary-matched statement, the tokens consumed
by that entry's captures; on an `Unmapped` statement, every token after the longest known prefix;
on an `Unshaped` line, every token after the second (`14` §9.7's maximum aggression).

**User pre-redactions** (`14` §9.6): a value consisting of ≤ 2 distinct characters, or matching
`^<[A-Za-z_ -]+>$`, or equal to `<PSK>`. On a `secret:`-matched statement it binds to
`SecretPlaceholder` exactly as a real value would, is listed in `already_redacted`, and is not a
drop.

**Quarantine** (`14` §9.7, DECISION quoted in §2): an `Unshaped` line on which any detector fires
has its capture text replaced by the shape sketch and its outcome set to
`Quarantined { label, orig_len }`. Sketch rule, from §9.7 verbatim: first two tokens kept only if
neither trips a detector and both are in the dictionary's known segment set; every other token
becomes `<word:LEN>` or `<quoted:LEN>`; no character of any token beyond the second survives.

**Structural properties** shipped now (`14` §9.1's table, slice half): the graph side cannot hold
a secret because WO-01's `SecretPlaceholder` has no text constructor; the capture text is private
to the gate's own type; stages after the gate read only `RedactedCapture` and the tree's
post-gate segments (the read-path DECISION above — redacted positions hold marker text and carry
the `redacted` flag). The canary proof is §4.9/§6 G4's `redaction_canary.rs`.

### 4.7 The statement dictionary — corpus data

Location `corpus/dict/junos-srx/`, per `14` §6.1's own path convention. Parsed with
`fathom_schema::subset::parse_profile(_, Profile::Corpus)` — the fathom-corpus precedent; if the
subset cannot express a construct below, that is §7 trigger 8, not a licence to extend the
parser.

**Grammar of this slice** (a declared subset of `14` §6.2 — the deferred fields are §12 item 1):
each file is a map with `platform: junos-srx` and `entries:`; each entry:

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | `<platform>/<dotted-path>` (conventions § Identifiers). Stable forever |
| `path` | yes | Flow list of segments; `"$name"` is a capture, anything else a literal |
| `partial` | no | `true` on an entry whose path is a strict prefix of another's (`14` §6.5 shadowing gate) |
| `secret` | no | `{ label: <RedactLabel token> }` — the path-detector row for this statement |
| `secret_exempt` | no | `{ reason: <text> }` — last literal is in `SECRET_WORD_LIST` but the argument is not a secret; suppresses the leaf-name detector for this entry (§12 item 2) |
| `binds` | no (secret-only entries omit it) | `nodes:` list and optional `edges:` list, below |
| `versions` | yes | `"*"` throughout this slice |
| `reviewed_by` | yes | `<named human>` placeholder — the same standing owner-blocked review as the seed corpus (invariant 10; `CLAUDE.md`) |

`binds.nodes[]`: `{ as: n<i>, kind: <NodeKind name or @interface_like>, owner: n<j>?, key:
"$cap", fields: [ { field: <name>, from: "$cap", scalar: <type> } | { field: <name>,
const_enum: <Enum.token> } | { field: <name>, append_enum: <Enum>, from: "$cap" } ] }`.
`binds.edges[]`: `{ kind: <EdgeKind name>, from: n<i>, to: { node: n<j> } | { by_name: { kind:
<NodeKind>, from: "$cap" } } | { interface_unit: "$cap" }, ordinal_from_position: true?,
fields: [...] }`.

Loader semantics, decided here:

- `kind`/`edge` names resolve through `NodeKind::from_name` / `EdgeKind::from_name`; field names
  resolve to wire keys through `SchemaTree::load("schema").field_keys` (`Kind.field` /
  `Edge.field` rows). Any failure is a load error, not a skip.
- `@interface_like` resolves the kind from the captured interface name: prefix before the first
  ASCII digit — `st` → `TunnelInterface`, `reth` → `RethInterface`, `ae` → `AggregateInterface`,
  anything else → `Interface`. Sources: the kinds' own docs in `schema/schema.yaml` (*"st0 on
  SRX"*, *"reth0"*, *"ae on Junos"*).
- `interface_unit` splits the capture at the **last** `.`; left part is the interface name (kind
  by the rule above), right part parses as `u32` index (`14` §7.3's `InterfaceUnit` expression:
  *"`st0.0` -> the LogicalUnit `0` of the InterfaceLike named `st0`"*). No `.` → the line's
  `Diag::ValueUnparsed` for that edge.
- Scalar values: the post-gate segment text (§4.6's read-path — never a capture slice) goes
  first through the platform token map (below), then `Scalar::parse`; generated enums map the vendor token by replacing ASCII `-` with `_` and
  calling `from_token`; a resulting `Unknown(_)` is `Diag::ValueUnparsed` — ingest never stores
  an `Unknown` enum arm (`14` §7.1's `group1444` example is the governing case; §12 item 8).

`token-maps.yaml` — the per-platform scalar token table (`14` §5.5's "Scalar token tables" row),
complete for this slice:

```yaml
platform: junos-srx
reviewed_by: <named human>
token_maps:
  DhGroup:            # field card side 2: group14 baseline; group19/group20
    group2: "2"       # ECP 256/384; group2 and group5 legacy
    group5: "5"
    group14: "14"
    group19: "19"
    group20: "20"
  IntegrityAlgorithm:
    sha-256: hmac-sha-256-128     # 14 §14.4 binds `sha-256` to HmacSha256_128
    sha-384: hmac-sha-384-192
    # VERIFY: sha-384 -> 192-bit truncation is the parallel of the sha-256
    # row, not a corpus-attested mapping; confirm before real S0 data lands.
```

Tokens absent from a map pass through unchanged (so `aes-256-cbc`, `pre-shared-keys`, `v2-only`,
`esp`, numerics parse directly — WO-01 §4.2's canonical grammars).

The token map is corpus data under invariant 10 exactly as the entries are: the file-level
`reviewed_by` above is what a named reviewer replaces (§10 item 9), the sha-384 VERIFY row is
precisely the thing that review confirms, and G8 counts this file with the other five.

**The entries — all 39, decided.** (Transcribe mechanically into the named files; three fully
worked YAML examples follow the table. `Kind(key)` means upsert node of that kind identified by
the capture, writing the key capture into `name` — `index` for `LogicalUnit` — as a field.)

| # | File / id (`junos-srx/…`) | Path | Binds / secret | Source |
|---|---|---|---|---|
| 1 | system / `system.host-name` | `[system, host-name, $h]` | Device(root).`hostname` ← $h : Identifier | `14` §10.1 |
| 2 | system / `system.root-authentication.encrypted-password` | `[system, root-authentication, encrypted-password, $v]` | secret Password, no binds | `14` §9.3 |
| 3 | system / `system.root-authentication.plain-text-password` | `[system, root-authentication, plain-text-password, $v]` | secret Password, no binds | `14` §9.3 |
| 4 | system / `system.login.user.encrypted-password` | `[system, login, user, $u, authentication, encrypted-password, $v]` | secret Password, no binds | `14` §9.3 |
| 5 | system / `system.login.user.plain-text-password` | `[system, login, user, $u, authentication, plain-text-password, $v]` | secret Password, no binds | `14` §9.3 |
| 6 | system / `system.tacplus-server.secret` | `[system, tacplus-server, $ip, secret, $v]` | secret TacacsKey, no binds | `14` §9.3 |
| 7 | system / `snmp.community` | `[snmp, community, $name]` | secret SnmpCommunity — *"the name is the secret"*; no binds | `14` §9.3 |
| 8 | security-ike / `security.ike.proposal.authentication-method` | `[security, ike, proposal, $p, authentication-method, $v]` | IkeProposal($p).`authentication_method` : AuthMethod | corpus cmd; schema `IkeProposal` |
| 9 | security-ike / `security.ike.proposal.dh-group` | `[…, $p, dh-group, $v]` | `dh_group` : DhGroup (token map) | corpus cmd |
| 10 | security-ike / `security.ike.proposal.authentication-algorithm` | `[…, $p, authentication-algorithm, $v]` | `authentication_algorithm` : IntegrityAlgorithm (token map) | corpus cmd; `14` §14.4 |
| 11 | security-ike / `security.ike.proposal.encryption-algorithm` | `[…, $p, encryption-algorithm, $v]` | `encryption_algorithm` : EncryptionAlgorithm | corpus cmd |
| 12 | security-ike / `security.ike.proposal.lifetime-seconds` | `[…, $p, lifetime-seconds, $v]` | `lifetime_seconds` : Seconds | corpus cmd |
| 13 | security-ike / `security.ike.policy.proposals` | `[security, ike, policy, $pol, proposals, $prop]` | IkePolicy($pol); edge UsesProposal → by_name IkeProposal($prop), `ordinal_from_position` | corpus cmd; schema `UsesProposal` |
| 14 | security-ike / `security.ike.policy.mode` | `[…, $pol, mode, $v]` | `mode` : enum IkePolicyMode | corpus cmd |
| 15 | security-ike / `security.ike.policy.pre-shared-key.ascii` | `[…, $pol, pre-shared-key, ascii-text, $v]` | secret Psk; `pre_shared_key` ← `SecretPlaceholder::new(Psk)` | `14` §6.1 (id verbatim), §9.3 |
| 16 | security-ike / `security.ike.policy.pre-shared-key.hex` | `[…, $pol, pre-shared-key, hexadecimal, $v]` | as 15 | `14` §9.3 |
| 17 | security-ike / `security.ike.gateway.ike-policy` | `[security, ike, gateway, $gw, ike-policy, $pol]` | IkeGateway($gw); edge UsesIkePolicy → by_name IkePolicy($pol) | corpus cmd; schema `UsesIkePolicy` |
| 18 | security-ike / `security.ike.gateway.address` | `[…, $gw, address, $v]` | `peer` ← `PeerSpec::Address(IpAddr)` | corpus cmd; `value.rs` PeerSpec |
| 19 | security-ike / `security.ike.gateway.external-interface` | `[…, $gw, external-interface, $unit]` | edge ExternalInterface → interface_unit($unit) — **id must equal the schema's `emit_dict` hook exactly** | `14` §6.1; schema `ExternalInterface` |
| 20 | security-ike / `security.ike.gateway.version` | `[…, $gw, version, $v]` | `version` : IkeVersion | corpus cmd |
| 21 | security-ike / `security.ike.gateway.nat-keepalive` | `[…, $gw, nat-keepalive, $v]` | `nat_keepalive` : Seconds | corpus cmd |
| 22 | security-ipsec / `security.ipsec.proposal.protocol` | `[security, ipsec, proposal, $p, protocol, $v]` | IpsecProposal($p).`protocol` : enum IpsecProposalProtocol | corpus cmd |
| 23 | security-ipsec / `security.ipsec.proposal.encryption-algorithm` | `[…, $p, encryption-algorithm, $v]` | `encryption_algorithm` : EncryptionAlgorithm | corpus cmd |
| 24 | security-ipsec / `security.ipsec.proposal.lifetime-seconds` | `[…, $p, lifetime-seconds, $v]` | `lifetime_seconds` : Seconds | corpus cmd |
| 25 | security-ipsec / `security.ipsec.proposal.lifetime-kilobytes` | `[…, $p, lifetime-kilobytes, $v]` | `lifetime_kilobytes` : Kilobytes | field card side 2; schema row |
| 26 | security-ipsec / `security.ipsec.policy.perfect-forward-secrecy` | `[security, ipsec, policy, $pol, perfect-forward-secrecy, keys, $v]` | IpsecPolicy($pol).`perfect_forward_secrecy` : DhGroup (token map); **`secret_exempt`** — reason: the argument is a DH group on the field card's own side-1 line | corpus cmd; field card |
| 27 | security-ipsec / `security.ipsec.policy.proposals` | `[…, $pol, proposals, $prop]` | edge UsesProposal → by_name IpsecProposal($prop), `ordinal_from_position` | corpus cmd |
| 28 | security-ipsec / `security.ipsec.vpn.ike-gateway` | `[security, ipsec, vpn, $v, ike, gateway, $gw]` | IpsecVpn($v); edge UsesIkeGateway → by_name IkeGateway($gw) | corpus cmd |
| 29 | security-ipsec / `security.ipsec.vpn.ike-ipsec-policy` | `[…, $v, ike, ipsec-policy, $pol]` | edge UsesIpsecPolicy → by_name IpsecPolicy($pol) | corpus cmd |
| 30 | security-ipsec / `security.ipsec.vpn.bind-interface` | `[…, $v, bind-interface, $unit]` | edge BindsInterface → interface_unit($unit) | corpus cmd |
| 31 | security-ipsec / `security.ipsec.vpn.establish-tunnels` | `[…, $v, establish-tunnels, $e]` | `establish_tunnels` : enum EstablishTunnels (hyphen→underscore) | corpus cmd |
| 32 | security-ipsec / `security.ipsec.vpn.df-bit` | `[…, $v, df-bit, $e]` | `df_bit` : enum IpsecVpnDfBit | corpus cmd |
| 33 | security-ipsec / `security.ipsec.vpn.traffic-selector` | `[…, $v, traffic-selector, $ts, local-ip, $l, remote-ip, $r]` | TrafficSelector($ts) owned by IpsecVpn($v); `local_ip`, `remote_ip` : IpPrefix | `14` §6.1 (id verbatim) |
| 34 | security-ipsec / `security.ipsec.vpn.manual.authentication-key` | `[…, $v, manual, authentication, key, ascii-text, $k]` | secret Psk; IpsecVpn($v) node only | `14` §9.3 |
| 35 | security-ipsec / `security.ipsec.vpn.manual.encryption-key` | `[…, $v, manual, encryption, key, ascii-text, $k]` | secret Psk; IpsecVpn($v) node only | `14` §9.3 |
| 36 | security-zones / `security.zones.security-zone.interfaces` | `[security, zones, security-zone, $z, interfaces, $unit]`, `partial: true` | Zone($z); edge ZoneMember → interface_unit($unit) | corpus cmd; schema `ZoneMember` |
| 37 | security-zones / `security.zones.security-zone.interfaces.host-inbound-services` | `[…, $z, interfaces, $unit, host-inbound-traffic, system-services, $svc]` | Zone($z); edge ZoneMember → interface_unit($unit) with `host_inbound_system_services` append_enum HostService($svc) | corpus cmd; schema `ZoneMember` fields |
| 38 | interfaces / `interfaces.unit.family-inet-address` | `[interfaces, $if, unit, $u, family, inet, address, $a]` | n0 `@interface_like`($if); n1 LogicalUnit($u) owner n0, `index` : u32, `families` append_enum Family.inet; n2 Address owner n1, `value` : InterfaceAddress ← $a, `family` const_enum AddressFamily.inet | corpus cmd; schema `LogicalUnit`/`Address` |
| 39 | system / `snmp.trap-group` | `[snmp, trap-group, $g]` | secret SnmpCommunity — *"`snmp trap-group $g ...` community references"*: the same the-name-is-the-secret shape as entry 7; no binds. Deeper trap-group tokens are the entry's remaining captures (§4.8) and stay under the safety net. `trap-group` is not in `SECRET_WORD_LIST`, so without this entry a real community here passes the gate — the reason the row exists (§12 item 13) | `14` §9.3 |

Three worked entries, verbatim (the pattern for all mechanical transcription):

```yaml
# corpus/dict/junos-srx/security-ike.yaml
platform: junos-srx
entries:
  - id: junos-srx/security.ike.proposal.dh-group
    path: [security, ike, proposal, "$p", dh-group, "$v"]
    binds:
      nodes:
        - { as: n0, kind: IkeProposal, key: "$p", fields: [ { field: name, from: "$p", scalar: Identifier }, { field: dh_group, from: "$v", scalar: DhGroup } ] }
    versions: "*"
    reviewed_by: <named human>

  - id: junos-srx/security.ike.policy.pre-shared-key.ascii
    path: [security, ike, policy, "$pol", pre-shared-key, ascii-text, "$v"]
    secret: { label: psk }
    binds:
      nodes:
        - { as: n0, kind: IkePolicy, key: "$pol", fields: [ { field: name, from: "$pol", scalar: Identifier }, { field: pre_shared_key, secret_placeholder: psk } ] }
    versions: "*"
    reviewed_by: <named human>

  - id: junos-srx/security.ike.gateway.external-interface
    path: [security, ike, gateway, "$gw", external-interface, "$unit"]
    binds:
      nodes:
        - { as: n0, kind: IkeGateway, key: "$gw", fields: [ { field: name, from: "$gw", scalar: Identifier } ] }
      edges:
        - { kind: ExternalInterface, from: n0, to: { interface_unit: "$unit" } }
    versions: "*"
    reviewed_by: <named human>
```

**What is deliberately not bindable in this slice** — enumerated so nobody "helpfully" adds an
entry (doing so is §7 trigger 4). Every one of these arrives in the fixture or in real pastes and
lands as `Unmapped` residue, preserved and counted:

| Statement family | Why not bindable today |
|---|---|
| `… gateway $gw dead-peer-detection …` | `IkeGateway.dpd` is typed `Dpd` — an empty stub, *"Shape stated nowhere read"* (`value.rs`) |
| `… gateway $gw local-identity / remote-identity / dynamic …` | `IkeId` is an empty stub |
| `… vpn $v vpn-monitor …`, `vpn-monitor-options …` | `VpnMonitor` is an empty stub |
| `security policies from-zone … to-zone … policy …` | `PolicySet.scope` is typed `PolicyScope` — empty stub; the owning `PolicySet` cannot be constructed |
| `routing-options static route …` | `NextHop` has a shape, but the owning default `RoutingInstance`'s identity (schema: *"The default instance is modelled explicitly, not as None"*) has no decided `name`/`isolation` values — §10 item 2 |
| `interfaces … family inet mtu …` | `LogicalUnit.family_mtu` is `map(Family, Mtu)`; `Mtu`'s layer discriminant is deferred to the store (`value.rs`) |
| `groups …` / `apply-groups …` | `14` §5.1's DECISION: detect, never expand. `uses_groups` is the detect half; prompts land with reconciliation |
| everything else (idp, class-of-service, syslog, …) | No kind, or outside the slice |

**The trie visit, defined** (so the budget gate below is derivable): a *visit* is one
`DictNode` inspected during lookup — the root counts one, each edge followed to a child counts
one, and a node re-inspected on backtrack counts again. A straight-line walk of an entry's own
path therefore costs exactly `path.len() + 1` visits: entry 33's ten-segment path costs eleven,
so `14` §6.3's *"no entry in any shipped dictionary requires more than 8"* cannot be a
total-visit bound — §6.3's own complexity note prices lookup at *"`O(L)` where `L` is the token
count, times a constant ≤ 8"*, and `14` §6.1's own worked entry is the ten-segment
traffic-selector path. The 8 is pinned here as the **per-entry backtracking allowance**
(§12 item 11).

**Dictionary validation gates** — the checkable subset of `14` §6.5, run as
`tests/dict_gates.rs`, all failures (`DictError` with `DictGate`):

| Test fn | Check |
|---|---|
| `dictionary_loads` | All six files parse under `Profile::Corpus`; `platform` is `junos-srx` in each |
| `entry_count_is_39` | Exactly the table above |
| `shadowing_requires_partial` | No entry's path is a strict prefix of another's unless the shorter carries `partial: true` (`14` §6.5) |
| `capture_arity_total` | Every `$name` used in `binds` appears in `path`, and every `path` capture is used or is a pure wildcard position (`14` §6.5) |
| `kinds_fields_types_resolve` | Every kind/edge resolves via `from_name`; every field name has a wire key in `SchemaTree.field_keys`; every `scalar:`/enum name is one this WO's `BoundValue` carries |
| `secret_coupling_word_list` | `14` §9.11 gate 2, widened to the detector's own rule: for every capture position in every entry's path, run §4.6's two-position leaf-name walk; a hit in `SECRET_WORD_LIST` requires the entry to carry `secret:` or `secret_exempt:` — and the reverse: every `secret:` label is a `RedactLabel` token. One rule for gate and detector, so they cannot drift (§12 item 9) |
| `lookup_budget_within_8` | Looking up each entry's own path backtracks at most 8 times: total visits ≤ `path.len() + 1 + 8` under the visit definition above (`14` §6.3's CI constant, read per §12 item 11; the runtime hard budget stays 64 visits per statement) |
| `trie_deterministic` | Building the trie twice yields byte-identical `{:?}` output |

Public API (`dict.rs`): `pub struct Dictionary` (internals private),
`Dictionary::load(root: &std::path::Path) -> Result<Dictionary, DictError>`,
`Dictionary::entry_count(&self) -> usize`, `Dictionary::platform(&self) -> &str`,
`pub struct DictError { pub file: String, pub line: usize, pub gate: DictGate, pub message: String }`,
`pub enum DictGate { Parse, Shadowing, CaptureArity, KindUnknown, FieldUnknown, TypeUnknown,
EdgeUnknown, SecretCoupling, ReviewedByMissing, TokenMapUnknown }`.

### 4.8 Bind: the fragment, and the contract with fathom-graph

Algorithm: `14` §7.1's, restricted to this slice — depth-first over terminals in input order;
longest-prefix trie lookup with *"Literal always wins."* and backtracking under the 64-visit
budget; only terminals bind; unconsumed trailing tokens after the deepest terminal are the
entry's remaining captures. Then one deferred-resolution pass (`14` §7.3): `by_name` and
`interface_unit` targets resolve **within the fragment only**; anything unresolved becomes a
`PendingEdge` — never an error, never a `Broken` marker, because scope is pinned `Fragment`
(§4.1).

Types (`bind.rs`), all public:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct FragNodeId(pub u32);          // dense index, creation order

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fragment {
    /// nodes[0] is always the implicit Device node (kind Device, no owner) —
    /// the unit a configuration file is a configuration file of (schema
    /// Device doc). Its platform field is NOT set here; that is the store
    /// weld's decision (§10 item 1).
    pub nodes: Vec<FragNode>,
    pub edges: Vec<FragEdge>,
    pub pending: Vec<PendingEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FragNode {
    pub kind: fathom_ir::generated::ir_types::NodeKind,
    /// Containment parent within the fragment. The store weld materialises
    /// the Has* containment edges from this; the fragment does not carry
    /// them as FragEdges.
    pub owner: Option<FragNodeId>,
    pub fields: Vec<FieldAssertion>,     // first-assertion order
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldAssertion {
    pub key: fathom_ir::bag::FieldKey,
    pub value: BoundValue,
    pub prov: BindProv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FragEdge {
    pub kind: fathom_ir::generated::ir_types::EdgeKind,
    pub from: FragNodeId,
    pub to: FragNodeId,
    pub fields: Vec<FieldAssertion>,
    pub prov: BindProv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingEdge {
    pub kind: fathom_ir::generated::ir_types::EdgeKind,
    pub from: FragNodeId,
    pub target: PendingTarget,
    pub fields: Vec<FieldAssertion>,
    pub prov: BindProv,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingTarget {
    ByName { kind: fathom_ir::generated::ir_types::NodeKind, name: fathom_ir::scalar::Identifier },
    InterfaceUnit { kind: fathom_ir::generated::ir_types::NodeKind, name: fathom_ir::scalar::Identifier, unit: u32 },
}

/// The slice's provenance: enough for the store weld to construct
/// Origin::Parsed later; nothing invented beyond what ingest knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BindProv {
    pub line: frame::LineOrdinal,
    pub span: frame::ByteSpan,           // post-redaction (14 §9.5)
    /// Index into the dictionary's entry list; the id string is reachable
    /// through the Dictionary.
    pub entry: u16,
}

/// Exactly the value types §4.7's tables bind — closed; a new variant is a
/// §7 trigger.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundValue {
    Identifier(fathom_ir::scalar::Identifier),
    AuthMethod(fathom_ir::scalar::AuthMethod),
    DhGroup(fathom_ir::scalar::DhGroup),
    IntegrityAlgorithm(fathom_ir::scalar::IntegrityAlgorithm),
    EncryptionAlgorithm(fathom_ir::scalar::EncryptionAlgorithm),
    Seconds(fathom_ir::scalar::Seconds),
    Kilobytes(fathom_ir::scalar::Kilobytes),
    IkeVersion(fathom_ir::scalar::IkeVersion),
    IpPrefix(fathom_ir::scalar::IpPrefix),
    InterfaceAddress(fathom_ir::scalar::InterfaceAddress),
    Secret(fathom_ir::scalar::SecretPlaceholder),
    Peer(fathom_ir::value::PeerSpec),
    U8(u8),
    U32(u32),
    IkePolicyMode(fathom_ir::generated::ir_types::IkePolicyMode),
    IpsecProposalProtocol(fathom_ir::generated::ir_types::IpsecProposalProtocol),
    EstablishTunnels(fathom_ir::generated::ir_types::EstablishTunnels),
    DfBit(fathom_ir::generated::ir_types::IpsecVpnDfBit),
    AddressFamily(fathom_ir::generated::ir_types::AddressFamily),
    FamilySet(std::collections::BTreeSet<fathom_ir::generated::ir_types::Family>),
    HostServiceSet(std::collections::BTreeSet<fathom_ir::generated::ir_types::HostService>),
}
```

Upsert and duplicate laws, decided here:

- Node identity within the fragment is `(kind, owner, key capture's segment text)` (§4.6's
  read-path), held in a private `BTreeMap`. Two statements about `GW-B` produce one node (`14` §7.1's law).
- A second assertion to an already-set `(node, field)` with an **equal** value is idempotent:
  the line is `Bound` (with `fields: 0`) and the fragment is unchanged. **DECISION —** a second
  assertion with a **different** value does not overwrite and does not invent a new outcome
  class: the line is `Bound { fields: 0 }` carrying `Diag::ValueUnparsed` for that key, and the
  first value stands. Nothing is silently replaced, the conflict is visible in the ledger, and
  node-level duplicate handling (a diff pasted with both sides, `14` §10.4's `DuplicateStatement`
  row) is reconciliation's problem, not the fragment's.
- `append_enum` set fields (`families`, `host_inbound_system_services`) accumulate into the
  variant's `BTreeSet`: duplicates coalesce and the ordering is the enum's derived `Ord` —
  deterministic (invariant 9), and the same representation the generated accessors return for
  `set{…}` fields, so the weld stores it without conversion (§12 item 12).
- Identical duplicate edges are idempotent; `ordinal_from_position` numbers `UsesProposal` edges
  from the bracket-list position (single token → 0), written to the edge's `ordinal` wire key as
  `BoundValue::U8`.
- Secret-bearing entries never read the segment or capture text of the redacted argument: the
  binder constructs `SecretPlaceholder::new(SecretLabel::Psk)` from the entry's label (WO-01
  §4.4's only path; §4.6 rule 3).

**The contract with fathom-graph, stated as the boundary this WO builds up to.** The fragment is
the input format for the store's apply step; this WO defines the producing side completely and
calls nothing on the consuming side:

1. Every `FragNode.kind` is a `NodeKind`; every `FieldAssertion.key` is the schema's wire
   `FieldKey` for a field of that kind or edge; every `BoundValue` payload is exactly the bag
   representation the store reads back. For node fields `accessors.rs` is the authority —
   including the set payloads: `LogicalUnit.families` (key 62) returns
   `&BTreeSet<Family>`, and `FamilySet` carries `BTreeSet<Family>`. Edge fields have no
   generated accessors (`accessors.rs` holds node-kind modules only), so for them the
   authority is the schema's declared type under the same representation rules:
   `ZoneMember.host_inbound_system_services` (key 283) is `set{host_service}`, held as
   `BTreeSet<HostService>` exactly as the Zone-side accessor for the same type shows
   (key 108). So a store whose bags satisfy `fathom_ir::bag::FieldBag` can hold every
   assertion without conversion.
2. `owner` chains are acyclic and always point at an earlier `FragNodeId`; the store weld derives
   the `Has*` containment edges from them.
3. All assertions are `Set` presences with `Asserted` confidence; the fragment never asserts
   absence (scope is `Fragment`; `14` §7.4's licence rule) and never carries `Unknown` enum arms
   (§4.7).
4. `BindProv` carries line, post-redaction span and dictionary-entry index — the inputs
   `Origin::Parsed` needs; constructing the store's provenance records, minting node ULIDs
   (`fathom-id` from caller-supplied parts only), and reconciliation are the weld WO's work.
5. The fragment, residue, drop manifest and capture in one `IngestOutput` are what the workspace
   persists; *"It is never auto-deleted."* (`14` §8.5) binds the consumer, and re-binding residue
   on dictionary upgrade (`14` §8.5 rule 2) is designed against this same struct.

If, at execution time, WO-02's shipped store already defines a conflicting fragment or capture
type, stop — §7 trigger 2. Designing the merge is planning work.

### 4.9 Fixtures — synthetic by declaration, upgraded by the owner's S0 exports

The owner's S0 fixture exports do not exist yet (`CLAUDE.md`, owner-only blocking items). The
fixture below is therefore **synthetic**: assembled only from `cmd:` strings of
`corpus/commands/junos-srx-ipsec.yaml` (mode: configuration); lines of
`.context/field-card-srx-ipsec.txt` side 1; `14` §14.1's framing devices; statement forms
transcribed from `14` §10.1 (`set system host-name`) and `14` §9.3's junos-srx catalogue
(`snmp community`, `snmp trap-group`, `tacplus-server … secret`,
`pre-shared-key hexadecimal`); and canary values. It uses only documentation addressing
(`61` §6.4). The file header must carry:
`# SYNTHETIC FIXTURE — assembled per WO-03 §4.9; not a capture of any real device.`
When the S0 exports land, a follow-up work order re-pins these tests on real data — that
escalation is standing (§10 item 8).

`tests/fixtures/junos-srx-s0-synthetic.txt`, verbatim (trailing newline after the last line):

```text
{primary:node0}
admin@srx-a-01> show configuration | display set
set system host-name srx-a-01
set security ike proposal IKE-P1 authentication-method pre-shared-keys
set security ike proposal IKE-P1 dh-group group14
set security ike proposal IKE-P1 authentication-algorithm sha-256
set security ike proposal IKE-P1 encryption-algorithm aes-256-cbc
set security ike proposal IKE-P1 lifetime-seconds 28800
set security ike policy IKE-POL proposals IKE-P1
set security ike policy IKE-POL pre-shared-key ascii-text "$9$FATHOMCANARY-A11111"
set security ike gateway GW-B ike-policy IKE-POL
set security ike gateway GW-B address 203.0.113.10
set security ike gateway GW-B external-interface reth0.0
set security ike gateway GW-B version v2-only
set security ike gateway GW-B dead-peer-detection \
  always-send interval 10 threshold 3
---(more 41%)---
set security ipsec proposal IPSEC-P2 protocol esp
set security ipsec proposal IPSEC-P2 encryption-algorithm aes-256-gcm
set security ipsec proposal IPSEC-P2 lifetime-seconds 3600
set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14
set security ipsec policy IPSEC-POL proposals IPSEC-P2
set security ipsec vpn VPN-B ike gateway GW-B
set security ipsec vpn VPN-B ike ipsec-policy IPSEC-POL
set security ipsec vpn VPN-B bind-interface st0.0
set security ipsec vpn VPN-B establish-tunnels immediately
set security ipsec vpn VPN-B df-bit clear
set security ipsec vpn VPN-B traffic-selector TS1 local-ip 10.1.0.0/16 remote-ip 10.2.0.0/16
set interfaces st0 unit 0 family inet address 10.255.0.1/30
set security zones security-zone VPN interfaces st0.0
set security zones security-zone WAN interfaces reth0.0 host-inbound-traffic system-services ike
set security idp idp-policy Recommended
set routing-options static route 10.2.0.0/16 next-hop st0.0
set snmp community FATHOMCANARY-B22222
set snmp trap-group FATHOMCANARY-E55555
set system tacplus-server 192.0.2.7 secret FATHOMCANARY-C33333
ecurity ike policy IKE-POL pre-shared-key ascii-text "FATHOMCANARY-D44444"
set security ike policy IKE-POL pre-shared-key hexadecimal "<REDACTED>"

{primary:node0}
admin@srx-a-01>
```

Expected outcome class per interesting line — the builder confirms these against the built
pipeline; a divergence is §7 trigger 5, never a test to adjust:

| Line(s) | Expected |
|---|---|
| `{primary:node0}` ×2, trailing prompt | `Noise(ClusterBanner)` / `Noise(Prompt)` |
| the echo line | `Noise(CommandEcho)` |
| `---(more 41%)---` | `Noise(Pagination)`; `truncated == true` |
| the 24 dictionary-covered `set` lines | `Bound` |
| `pre-shared-key ascii-text "$9$…"` | `Bound`; drop manifest entry, label Psk, detectors PATH \| CRYPT_PREFIX \| LEAF_NAME (`14` §14.3's three-detector case) |
| `dead-peer-detection \` + continuation | one logical line, `join: Backslash`, `Unmapped` (dpd not bindable, §4.7) |
| `perfect-forward-secrecy keys group14` | `Bound`; **no** drop entry (`secret_exempt`) |
| `security idp …` | `Unmapped { known_prefix: 1 }` |
| `routing-options static route …` | `Unmapped { known_prefix: 0 }` |
| `snmp community FATHOMCANARY-B22222` | `Unmapped` (secret-only entry, §4.7 rule); drop entry, label SnmpCommunity, PATH \| LEAF_NAME (`community` sits one position back on §4.6's walk) |
| `snmp trap-group FATHOMCANARY-E55555` | `Unmapped` (secret-only entry); drop entry, label SnmpCommunity, PATH only — `trap-group` is not in the word list, which is why entry 39 must exist |
| `tacplus-server … secret FATHOMCANARY-C33333` | `Unmapped`; drop entry, label TacacsKey, PATH \| LEAF_NAME |
| `ecurity ike policy …` (clipped head) | `Quarantined` — NotVerbInitial, then the leaf-name token rule fires on the canary (`14` §9.7's hard case) |
| `pre-shared-key hexadecimal "<REDACTED>"` | `Bound`; `already_redacted` lists the ordinal; **no** drop entry; the `pre_shared_key` assertion is idempotent with the ascii-text line's |
| the blank line | `Blank` |

**The pinned counts.** The author of this work order does not invent numbers. The executing
session, once `srx_fixture.rs` runs, pins as exact assertions: lines in; count per outcome class;
fragment node count and per-kind counts; resolved edge count per `EdgeKind`; pending edge count
and targets; drop-manifest entry count and label multiset; `already_redacted` length. The pinned
values are then backfilled into §6.1's table **in the same PR**, and from that point the counts
never change without a §12 Disagreements entry recording why.

`tests/redaction_canary.rs` (the `14` §9.11 canary proof, slice form) — mandatory test fns:

- `no_canary_survives_anywhere`: ingest the fixture, then assert the string `FATHOMCANARY` does
  not occur in `format!("{:?}", output)` — the Debug rendering covers capture text, ledger,
  residue, fragment and manifest in one sweep, which is §9.11's "check the whole serialised
  artefact" at this slice's boundary.
- `pre_redacted_not_counted_as_drop`: the `<REDACTED>` line is in `already_redacted`, not in
  `entries`.
- `quarantine_destroys_unshaped_secret_line`: the clipped line's capture text is the §4.6 sketch;
  its `orig_len` is recorded; no token beyond the second survives verbatim.
- `pfs_keys_group_not_redacted`: `group14` survives in the capture and binds; the `secret_exempt`
  suppression worked.
- `redacted_key_never_binds` (the §4.6 read-path proof; its own one-line paste, not the
  fixture): ingest `set security ike gateway $9$FATHOMCANARY-F66666 ike-policy IKE-POL\n` and
  assert the line's outcome is `Unshaped { KeyUnparsable }`, the fragment holds no `IkeGateway`
  node, the drop manifest holds one entry whose detectors include CRYPT_PREFIX, and
  `FATHOMCANARY` does not occur in `format!("{:?}", output)` — a bound-entry key capture that
  trips a value-shape detector never reaches the fragment from pre-redaction text.

## 5. The plan

Each step ends with `cargo build --workspace` green unless noted. No step reordering (`78` §3).

1. Run §3's execution-start checklist. Add the workspace member line and create the crate
   skeleton (§4.2's two manifests verbatim, `lib.rs` lints, empty modules). Build.
2. `frame.rs`: types, refusals, normalisation, backslash join, noise patterns, the ledger and
   Invariant L as a `debug_assert` plus unit tests (`ledger_tiles_exactly` on hand inputs
   including empty input, no-trailing-newline input, and a lone `\`). Test.
3. `lex.rs`: `LexTable`, `JUNOS_SET`, the scanner, `token_spans_slice_back`. Test.
4. `shape.rs`: `StmtTree`, the set shaper, `VERBS`, bracket-list expansion, the four shape
   errors reachable at this stage. Unit tests: shared-prefix statements share nodes; a bracket
   list yields N terminals; `deactivate …` is `UnsupportedVerb`. Test.
5. `dict.rs`: the loader (subset parser, `Profile::Corpus`), schema resolution
   (`SchemaTree::load("schema")` from the repo root, the same ancestor walk as WO-01 §4.5(a)),
   trie compilation, lookup with budget. Write `token-maps.yaml` and `security-ike.yaml` (§4.7
   worked entries plus the rest of that file's table rows). Loader unit tests green.
6. Remaining dictionary files (`system`, `security-ipsec`, `security-zones`, `interfaces`),
   transcribed from §4.7's table. `tests/dict_gates.rs` with all eight named tests. Test.
7. `redact.rs`: the gate in pipeline position, all six detectors with §4.6's rules, markers,
   pre-redaction handling, quarantine sketch, and the tree rewrite (§4.6 rule 1). Unit tests
   per detector, including the base64 guard's negative case (a bound statement's long value is
   not touched), the `secret_exempt` suppression, and the segment rewrite (a redacted
   position's segment is re-pointed at the marker and carries `redacted: Some(_)`; a benign
   statement sharing the pre-redaction segment text keeps its own text). Test.
8. `bind.rs`: fragment types, the binder, upsert and duplicate laws, deferred resolution,
   pending edges. Unit tests: `GW-B` two-statement upsert; differing duplicate leaves first
   value plus `ValueUnparsed`; `st0.0` resolves in-fragment after `interfaces st0 unit 0 …`;
   `reth0.0` goes pending; enum hyphen mapping (`responder-only` → `ResponderOnly`); unknown
   enum token → `ValueUnparsed`; a redacted key capture yields `Unshaped { KeyUnparsable }` and
   no node, and a redacted value capture yields `Diag::ValueUnparsed`, never a `BoundValue`
   from marker text (§4.6 rules 2–3). Test.
9. `lib.rs::ingest` wiring in stage order frame → lex → shape → redact → bind → resolve;
   `uses_groups` and `truncated`; `tests/determinism.rs::ingest_twice_identical`. Test.
10. Write the fixture file (§4.9 verbatim); `tests/srx_fixture.rs` (`fixture_ledger_tiles`,
    `fixture_outcome_classes` per §4.9's table, `fixture_counts_pinned`, `fixture_fragment_shape`
    — spot assertions: IKE-P1's `dh_group` canonical text is `14`; the ZoneMember edge to
    `st0.0` is resolved and WAN's is pending with the HostService field; IKE-POL's
    `pre_shared_key` is a `SecretPlaceholder` with label Psk); `tests/redaction_canary.rs`
    (§4.9's five). Pin the counts; backfill §6.1. Test.
11. Run §6's gates in order, then `78` §6's floor. All green, or stop under §7 / `78` §4.

## 6. Acceptance gates

Run from the repository root, in this order. Expected output is exact; anything else is a red
gate (`78` §3 step 7).

| # | Command | Expected |
|---|---|---|
| G1 | `cargo fmt --all --check` | No output, exit 0 |
| G2 | `cargo clippy --all-targets -- -D warnings` | Builds clean, exit 0 |
| G3 | `cargo test --workspace` | Every suite `ok`, 0 failed; every pre-existing suite's pass count unchanged from the WO-02-merged baseline |
| G4 | `cargo test -p fathom-ingest` | `ok`, 0 failed; the run lists every named test in §4.7's gate table, §4.9's two files, `ingest_twice_identical`, and the module unit tests of steps 2–8 |
| G5 | `git diff --exit-code -- crates/fathom-ir schema/ corpus/commands corpus/explainers corpus/rules` | No output, exit 0 — this WO touches none of them |
| G6 | `cargo run -q -p fathom-schema --bin fathom-schema-check` | Exit 0; summary still `48 kinds · 89 edges · 61 scalars · 10 enums · 14 files parsed`, `0 failure(s), 2 warning(s)` |
| G7 | `grep -rn "FATHOMCANARY" crates/fathom-ingest/src corpus/dict` | No matches, exit 1 — canaries exist only under `crates/fathom-ingest/tests/` |
| G8 | `grep -c "reviewed_by:" corpus/dict/junos-srx/*.yaml \| grep -c ":0$"` | `0` — all six files carry the field (per entry; file-level in `token-maps.yaml`; placeholder allowed; review is owner-blocked) |

### 6.1 The pinned fixture counts — backfilled by the executing session, same PR

| Quantity | Pinned value |
|---|---|
| Physical lines in / logical lines | ⟨builder pins⟩ |
| Bound / Unmapped / Unshaped / Quarantined / Noise / Blank | ⟨builder pins⟩ |
| Fragment nodes, total and per kind | ⟨builder pins⟩ |
| Resolved edges, per `EdgeKind` | ⟨builder pins⟩ |
| Pending edges, with targets | ⟨builder pins⟩ |
| Drop-manifest entries, label multiset | ⟨builder pins⟩ |
| `already_redacted` entries | ⟨builder pins⟩ |

Once written, these values are load-bearing: any later change to fixture, dictionary or pipeline
that moves one of them requires a §12 Disagreements entry stating old → new and why, in the PR
that moves it.

## 7. Stop-and-escalate triggers

Any of these stops the session under `78` §4. The escalation is the deliverable at that point.

1. §3's execution-start checklist fails: WO-01/WO-02 not `DONE`, or the `Scalar` /
   `SecretPlaceholder` API differs from WO-01 §4's listing in any name or signature this WO
   consumes.
2. WO-02's store already exposes a fragment, capture, residue or ingest type whose purpose
   overlaps §4.2/§4.8's — the merge design is planning work; do not duplicate and do not adapt.
3. Any step appears to need a public name — type, field, function, module, file, test file,
   const — not listed in §4. (Private helpers are free.)
4. A dictionary entry appears to need: a kind, edge, field, enum or scalar §4.7's tables do not
   name; a wire key `SchemaTree.field_keys` lacks; a vendor token absent from `token-maps.yaml`;
   a `RedactLabel` beyond the six; or an entry beyond the 39 — including any temptation to bind
   a §4.7-excluded family.
5. A fixture line's built outcome class differs from §4.9's expected table, or Invariant L fails
   on the fixture. Both are evidence of a defect in this WO's design; report, do not adapt.
6. The `Profile::Corpus` subset cannot parse a §4.7 construct as written. Extending the subset
   parser is its own decision with its own owner (`subset.rs`: *"must never become one"*).
7. The trie budget assertion fails (an entry's own-path lookup needs more than 8 backtrack
   visits beyond its straight-line walk — §4.7's visit definition), or lookup would exceed 64
   visits on the fixture.
8. Implementing a step contradicts a § cited in §2, or two cited §§ contradict each other in a
   way §12 does not already record.
9. Anything appears to need: an external dependency, `unsafe`, a change under `schema/` or
   `crates/fathom-ir/`, a schema declaration, or an edit to a file §4's deliverables table does
   not list.

## 8. Non-goals

Deliberately not in this work order; citing a non-goal to justify extra work is `78` §9 row 1's
failure.

- The second half of the on-ramp: device identification (`14` §10.1), chassis-cluster and
  two-device splitting (§10.2), reconciliation and the plan (§10.3–§10.5), applying the fragment
  to the store, ULID minting, `Origin::Parsed` materialisation, suppression rebinding.
- Every deferred syntactic family in §4.1's table: curly-brace Junos, IOS, PAN-OS, hard wrap,
  soft continuation, cp1252, confusables, ANSI/backspace, HTML entities, edit markers,
  diff/quote markers, opaque blocks, truncated-head recovery, prefix inference, mixed-platform
  splitting.
- `deactivate`/`delete`/`activate`/… semantics and the Inactive flag's graph meaning.
- Configuration-group expansion in any form, and the completeness prompt (`14` §5.1).
- Capture-scope computation (`14` §7.4), absence assertion, `Broken` markers, findings.
- The dictionary's `emit` and `explain` halves, the round-trip gate (`14` §6.4), the explainer
  coverage gate, and any `Risk` assignment — risk rides `emit.risk` (`14` §12.2) and arrives
  with the emitter WO. The risk enum is neither used nor extended here.
- Reverse explanation (`14` §12), the ingest report UI (`14` §8.7 — `IngestOutput` carries the
  data; rendering is design-layer work), residue persistence (the store owns the workspace).
- WASM/Worker architecture, memory/time budgets (`14` §11), and the fuzz harness (`14` §13 —
  cargo-fuzz and `arbitrary` are external dependencies; reconciling that with the zero-dependency
  position is §10 item 6).

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **A secret path this dictionary does not know arrives in a real paste** — recall is not 1.0 | The value-shape detectors run on every argument of every statement, bound or not, and quarantine covers unshaped lines (`14` §9.4, §9.7); the honest statement of the recall limit lives in `14` §9.10 and is not re-litigated here |
| 2 | **The leaf-name exemption gets copied onto a real secret entry** during a future dictionary edit | `secret_exempt` requires a written `reason`; `secret_coupling_word_list` forces every word-list hit to declare one of the two flags, so silence is impossible |
| 3 | **The fixture's expected classes were reasoned wrong in this WO** | §7 trigger 5 routes the divergence to planning with both readings quoted — the fixture is evidence, not a target |
| 4 | **Counts pinned once, then drift silently** | §6.1's rule: a moving count requires a Disagreements entry in the moving PR; G3 keeps the assertions executable |
| 5 | **The dictionary and the redaction catalogue diverge** — `14` §9.1's fourth property | There are not two lists: the path catalogue is the `secret:` flags, and `secret_coupling_word_list` is §9.11 gate 2 in-tree |
| 6 | **`Unknown` enum arms leak vendor typos into the graph** | §4.7's rule: `from_token` → `Unknown` is `ValueUnparsed`, never stored; unit-tested in step 8 |
| 7 | **Residue quietly recomputed or dropped by a later consumer** | `IngestOutput.residue` is a struct field, not a method; §4.8 contract item 5 states the retention rule with `14` §8.5's quote |
| 8 | **The synthetic fixture ossifies as if it were real data** | The file header says SYNTHETIC; §10 item 8 keeps the S0 upgrade escalation standing; `61` §6.4's addressing rules keep it visibly documentation-ranged |

## 10. Open decisions

This section doubles as the escalation inbox under `78` §4 step 2. Standing items, deliberately
not decided here:

1. **Device.platform on the fragment.** The fragment's root Device carries no `platform` field
   assertion (no statement asserts it; the dictionary knows the platform). Whether the store
   weld stamps it, and with what origin, is the weld WO's decision. Planning.
2. **The default `RoutingInstance`'s identity** (`name`, `isolation` values for Junos
   `routing-options`) — blocks dictionary entries for static routes. Planning, with `11`/`62`
   sources open.
3. **`deactivate` semantics** — the Inactive flag's representation on fragment and store, and
   which WO lands it. Planning.
4. **`RedactLabel`/`SecretLabel` extension** (RoutingKey, RadiusKey, PublicKey, LicenseKey as
   graph-side labels; `14` §9.3 uses them, WO-01's enum has five variants and its §7 trigger 5
   reserves extension to planning). Until decided, those paths are safety-net-only here.
5. **The sha-384 token-map row's VERIFY** (§4.7) — confirm the truncation before real data.
   Owner or planning, with a source.
6. **Fuzzing vs the zero-dependency position** — `14` §13's targets require cargo-fuzz and
   `arbitrary`; whether they run out-of-workspace, or the position gains a dev-tooling carve-out,
   is not an execution decision. Planning.
7. **The dictionary's `emit`/`explain` halves and the full `14` §6.5 gate set** — land with the
   emitter and explainer WOs; until then §12 item 1's deferral stands. Planning sequences it.
8. **The S0 fixture upgrade** — when the owner's exports land (`CLAUDE.md`), a follow-up WO
   replaces or augments the synthetic fixture with real captures, re-pins §6.1 with a
   Disagreements entry, and revisits every VERIFY this file carries. Owner, then planning.
9. **Named expert review of `corpus/dict/junos-srx/`** — every entry, and `token-maps.yaml`'s
   file-level field, ships `reviewed_by: <named human>`; invariant 10 is not satisfied until a
   named SRX-competent human replaces the placeholders. Owner. (The same standing item as the
   command corpus.)

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants 1–3, 9, 10; terminology; identifiers; document conventions |
| `CLAUDE.md`; `docs/70-ops/78-execution-protocol.md` (whole) | Inherited constraints; the escalation rule; the verification floor; the WO template; the owner-blocking items |
| `docs/10-core/14-parsers-and-ingest.md` (whole) | The pipeline, the CST, the dictionary, the ledger, the gate, the detectors, quarantine, the budgets, the worked example — every §4 decision traces to a quoted § |
| `docs/90-decisions/adr-0002-invariant-amendments-and-the-residual-scale.md` §Decision | The amended invariant 3 text quoted in §2 — the exact redaction rule this WO implements |
| `docs/60-content/61-command-corpus-spec.md` §6.4 | Fixture addressing discipline (documentation ranges); the redaction-as-build-gate posture |
| `docs/70-ops/79-work-orders/WO-01-the-scalar-trait.md` §§2, 4.1–4.5, 7, 8 | The scalar API consumed; the five `SecretLabel` variants; the extension trigger this WO must not trip |
| `.context/field-card-srx-ipsec.txt` sides 1–2 | The vendor lines behind entries 8–33 and the token maps; the PFS `keys` line that forces `secret_exempt` |
| `schema/schema.yaml` (kinds `Device`, `Interface`…`Address`, `Zone`, `IkeProposal`…`TrafficSelector`; edges `UsesIkePolicy`…`ZoneMember`; the `ExternalInterface` `emit_dict` hook) | What is declarable; field types and cards; the one dictionary id already pinned by the schema |
| `schema/field-keys.yaml` | Wire keys exist for every §4.7 field (spot-verified: `Device.hostname: 6`, `IkeProposal.dh_group: 149`, `UsesProposal.ordinal: 281`, `ZoneMember.host_inbound_system_services: 283`) |
| `corpus/commands/junos-srx-ipsec.yaml` (header; entry `junos-srx/ike.proposal.auth-method.set`; the 49 config-mode `cmd:` lines) | Fixture raw material; the `reviewed_by` placeholder precedent |
| `crates/fathom-schema/src/{subset.rs,model.rs}` | `Profile::Corpus`'s exact extension set; `SchemaTree`/`FieldKeys` shapes |
| `crates/fathom-ir/src/{bag.rs,value.rs,lib.rs}`; `src/generated/{ir_types.rs,accessors.rs}` | `FieldKey`; which structured shapes exist (PeerSpec) and which are empty stubs; `NodeKind`/`EdgeKind` `from_name`; enum `from_token` neutral tokens and `Unknown` arms; accessor return types |
| `crates/fathom-id/src/lib.rs`; `crates/fathom-corpus/src/load.rs` | The no-clock/no-RNG id posture (why the fragment carries indices); the subset-parser consumer precedent |
| `Cargo.toml`, `crates/*/Cargo.toml`, `rust-toolchain.toml` | Manifest form; the dependency position; the 1.94.1 pin |
| `cargo test --workspace`; `fathom-schema-check` (run 2026-08-02) | 80 passed / 0 failed; exit 0, `0 failure(s), 2 warning(s)`, the summary line G6 pins |

## 12. Disagreements

1. **Against `14` §6.2's required `emit` and `explain` fields.** No emitter and no field-level
   explainers exist; populating them would mean inventing emit templates, orders and explainer
   ids with no consumer and no source. This slice's dictionary grammar omits both, and the
   round-trip and explainer-coverage gates of §6.5 are deferred with them (§10 item 7). `binds`
   is additionally made optional for secret-only entries, which §6.2 does not contemplate —
   the redaction catalogue must cover stanzas Fathom does not model.
2. **Against `14` §9.4's leaf-name detector as written.** Applied unconditionally it redacts the
   field card's own `perfect-forward-secrecy keys group14` (`keys` is in the secret-word list).
   This WO adds the `secret_exempt` flag: suppression is per-entry, explicit, reasoned, and the
   coupling gate forces every word-list path to declare itself one way or the other. If `14`
   prefers a different mechanism, the correction lands there.
3. **Slice reductions of `14`'s types.** `StmtNode` drops `verb`, `args` and `flags` (set-only
   this slice, no args in `display set` per §5.1, no Inactive semantics yet); `SmallVec` becomes
   `Vec` (zero-dependency position); `Unmapped`'s `PathPrefix`+`unknown_from` becomes a segment
   count; `LineOutcome` gains `Blank` (14 §4.1 classes it, §8.3 omits it); `NoiseClass` drops
   the payloads (`hostname`, `mode`, `node`) because evidence mining is deferred with its
   consumer. Each is a narrowing a later WO widens, not a redesign.
4. **One noise class per line.** `14` §14.2 marks a prompt-plus-echo line with two classes; the
   ledger here records `CommandEcho` alone. The distinction this loses (bare prompt vs echo) is
   recoverable from the capture text when evidence mining lands.
5. **cp1252 fallback deferred** (`14` §4.2 step 2): this slice refuses non-UTF-8 input with the
   byte offset instead of retrying as Windows-1252. Refusal is the step-2 behaviour for the
   second failure anyway; the retry belongs to the damage-tolerance WO.
6. **`CaptureScope` pinned to `Fragment`** (`14` §7.4 computes it): nothing in this slice asserts
   absence, so the only consequence of `Whole` — the licence to assert `Absent` and to create
   `Broken` markers — has no consumer yet. Pinning the conservative value cannot make the graph
   wrong; computing scope lands with reconciliation.
7. **PEM armour quarantines the line rather than capturing a block** (`14` §4.5): set-form Junos
   has no framer-level block forms in scope; quarantine errs toward destruction, which is `14`
   §9.7's own stated direction of error.
8. **Generated enum `Unknown` arms are refused at ingest.** The arms exist so an old client
   survives stored data with new variants (`ir_types.rs`'s own comment); using them to accept
   unrecognised vendor tokens at parse time would store typos with `Asserted` confidence —
   exactly the `dh-groupp` failure `14` §8.7 renders as a diagnostic instead.
9. **Against `14` §9.4's leaf-name rule as literally worded.** §9.4 keys the detector on *"the
   last literal path segment before the argument"*; §14.3's own worked case fires it on the PSK
   line through `ascii-text` — not in the word list — because it is *"preceded by
   `pre-shared-key`, which is in the secret-word list"*. The strict wording and the worked
   example cannot both be the rule. This WO pins the two-position walk-back (§4.6) that
   satisfies the worked example, re-derives §4.9's expected detector sets from it (the snmp
   community row gains LEAF_NAME), and gives `secret_coupling_word_list` the same walk so gate
   and detector cannot diverge. An earlier draft of this WO said "nearest preceding literal
   path segment" — a rule under which §4.9's PSK-line and quarantine expectations were
   unsatisfiable; that text was the defect. If `14` intended strictly-last-literal, §14.3's
   example is the defect and the correction lands there.
10. **Against `14` §2.4's `SegInterner` slicing the capture — and this WO's own earlier §4.5
    comment.** Quoted segments intern with escapes resolved (§4.5), and resolved text cannot be
    a capture slice, so `segs` is owned `Vec<String>`; the earlier comment claiming the owned
    segments "slice the redacted capture" was false. The redaction-safety property that §2.4's
    slicing and §9.1's `Arg::Redacted` carried in `14` — no pre-redaction text reachable after
    stage 4 — is restored structurally by §4.6's read-path DECISION: the gate re-points
    redacted positions at marker segments and sets `StmtNode.redacted`; bind reads segments
    only. The earlier draft left the post-gate read-path undecided, which was itself the
    defect: an executor free to read either segs or spans could bind a secret from
    pre-redaction text.
11. **Against a total-visits reading of `14` §6.3's "≤ 8" CI assertion.** Entry 33's path —
    `14` §6.1's own worked traffic-selector entry — is ten segments, so a straight-line walk
    alone costs eleven visits and "≤ 8 total" is arithmetically unsatisfiable by any correct
    trie. §6.3's complexity note (*"`O(L)` where `L` is the token count, times a constant
    ≤ 8"*) prices the 8 as a per-token constant, not a total; this WO pins the checkable
    reading — straight-line walk plus at most 8 backtrack visits per entry (§4.7). The earlier
    draft pinned total visits ≤ 8, which guaranteed a red gate on a correct transcription.
12. **Correction to §4.8's set payloads and contract item 1.** The earlier draft carried
    `FamilySet(Vec<…>)`/`HostServiceSet(Vec<…>)` with first-seen order while claiming every
    payload matches the generated accessors "without conversion" — false: `accessors.rs`
    returns `&BTreeSet<Family>` for `LogicalUnit.families` (key 62). The variants now carry
    `BTreeSet`, and item 1 states the edge-field authority explicitly (`accessors.rs` has no
    edge modules; the schema's declared `set{…}` type governs). First-seen order is dropped
    and loses nothing: the schema type is an unordered set and `BTreeSet` ordering is
    deterministic (invariant 9).
13. **Correction: the catalogue had silently narrowed `14` §9.3.** The `snmp trap-group $g …`
    row (label `SnmpCommunity` — a label WO-01's enum has, unlike the four §10-item-4
    deferrals) was absent from the entry table with no record. `trap-group` is not in
    `SECRET_WORD_LIST` and no value-shape detector compensates, so a real community in a
    trap-group statement would have passed the gate unredacted as `Unmapped` residue and
    persisted. Entry 39 restores the row; the fixture carries a canary in that position.
