# WO-05 — The workspace file: canonical serialisation, and the crypto boundary

> **Status:** DONE — executed 2026-08-08. All nine acceptance gates green; §4.4's pinned vector
> matched the constructed bytes exactly, so §7 trigger 3 did not fire. `fathom-canon` and
> `fathom-workspace` exist; `fathom-ir` carries `canon` and the generated dispatch; `fathom-graph`
> carries id parsing and the snapshot pair. Sealing remains not started and owner-gated (§2.1).
> The two 2026-08-08 escalations were answered by planning before execution began; §4.2's wire
> table is cut against the `Scalar` trait (rules 3/4/5/7 retired, 13 and 14 added) and §4.4's
> pinned vector carries no `fathom:` prefix. Read §10.6 and §10.7 before §4.

Depends on: WO-02 (the store — `Graph` is the thing serialised, and this work order extends it
with a snapshot pair). WO-01 is deliberately **not** a dependency, but if it lands first the slot
types at `fathom_ir::scalar` / `fathom_ir::value` change shape underneath §4.2's wire table —
§7 trigger 4 governs that case.

Execution protocol: `docs/70-ops/78-execution-protocol.md` governs this work order. Every
constraint in `78` §2 is inherited and not restated here; `78` §4's escalation rule applies to
every trigger in §7 below. Severity labels in any verification context are exactly
BLOCKER / MAJOR / MINOR (`78` §2).

The governing rule for everything below, from `docs/10-core/17-workspace-format.md` §15.5,
quoted once and binding on every byte this work order writes to disk:

> **THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.**

That sentence is not commentary; it is a deliverable. It is line two of every file this work
order's code produces, byte for byte, and a test proves it (§6 G7).

## 0. Contents

| § | |
|---|---|
| 1 | Objective |
| 2 | Binding sources — including the crypto boundary, drawn honestly |
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

When this work order is DONE, the estate the store holds can leave memory and come back, byte
for byte, with no cryptography anywhere in the path and no pretence that there is any. Concretely:
`crates/fathom-canon` exists and owns the canonical JSON byte contract (`62` §17.1) as one
emitter and one strict parser shared by `fathom-schemagen` and the new code; every bound slot
type in `fathom-ir` carries a canonical wire form with a round-trip law; `fathom-graph` gains a
complete, ordered, plain-data `Snapshot` of everything it holds — nodes, edges, field slots,
provenance, history, tombstones, the op log — and a `from_snapshot` that re-enforces every L0
refusal on the way back in; and `crates/fathom-workspace` writes and reads the **plaintext dev
face**: a four-line versioned header followed by one line of canonical JSON — five lines in
all — whose second line is the plaintext warning verbatim, whose extension is never `.fathom`,
and whose round trip is byte-identical (serialise → parse → re-serialise, `cmp` equal). The
sealed container — records, envelopes, keys, filenames, the manifest — is **not started**, and
§2.1 records, with verbatim quotes, why no execution session may start it.

### 1.1 The boundary, stated before anything else

This work order's buildable scope ends where key material would begin. What is buildable now:
the canonical byte format, the round-trip serialisation of the graph, a versioned envelope in
the sense of `17` §2.2 (versions readable before anything else, so an old build refuses cleanly),
and a plaintext face that refuses to masquerade as secure. What is not buildable now, by anyone,
under any current document: encryption. Not because it is unspecified — `32` specifies it to the
byte — but because its **implementation route is an undecided owner question** (§2.1), and both
of the possible routes are closed to an execution session: hand-rolling primitives is forbidden
by `32` §15 and by this work order absolutely, and adding the vetted crates `32` §15.1 names is
a dependency addition, which `78` §5 item 2 forbids an execution session *"always"*. The
plaintext-face work beneath that boundary is fully executable and is the whole of §4.

## 2. Binding sources

Constraints every work order inherits — invariants 1–3 and 9, ADR-0008, zero external
dependencies, the pinned toolchain and `#![forbid(unsafe_code)]`, the risk enum, the
BLOCKER / MAJOR / MINOR severity scale, house style — are stated once in `78` §2 with their
citations and are not re-derived here. The sources specific to this work order:

| Source | What it binds | The line that binds |
|---|---|---|
| `docs/10-core/17-workspace-format.md` §2.1 | The sealed container's names — which the plain face must therefore never use | Both container forms *"are named `.fathom`"* |
| `17` §2.2 | Versions readable before anything expensive or refusable | *"An old build must know it cannot read a file **before** spending Argon2id on it"* |
| `17` §12.2 | The sealed extensions the plain face must refuse to wear | `*.frec`, `*.fcap`, `*.fm` (and `.fathom` per §2.1) |
| `17` §15.1–15.2 | Plaintext output is a distinct, named, dangerous artifact class; `fathom-json` is its dump format | *"Flat, self-describing, schema-tagged dump of nodes, edges, provenance. **Major-stable**"* |
| `17` §15.5 | The warning every plaintext artifact carries | *"THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE."* |
| `docs/30-security/32-cryptography.md` §7.5 | What the **sealed** interior will be — and therefore what this JSON face is not | *"The bytes inside an envelope are **canonical CBOR**, RFC 8949 §4.2.1 deterministic encoding"* |
| `32` §7.1 | The sealed magic, which `read_plain` must refuse by name | `"FTHM\x1fREC"` = `46 54 48 4D 1F 52 45 43` |
| `32` §15 | Primitives are never hand-rolled | §15.2: *"**This list is where the vulnerabilities will be.**"* — and the list is first-party framing, not primitives |
| `docs/30-security/35-supply-chain-and-builds.md` §5.1 C7, C8 | No C/C++ in any closure; one implementation per job — the reason the canonical emitter is shared, not duplicated | *"no C or C++ in the shipped closure"* / *"one implementation per job"* |
| `35` §5.2–5.3 | The dependency question is priced, procedured — and not yet exercised | quoted in full in §2.1 |
| `docs/40-stack/46-workspace-persistence-and-identity.md` §1 | The file lives where the user chose, never a default — this crate therefore never touches a path | `43` §2.1 D1 row, quoted there verbatim: *"Workspace storage — the user's chosen file only."* |
| `46` §5.2 | The unlock identity is part of the sealed face's format and travels with the crypto decision | *"the username is presented at every unlock like the passphrase … and stored nowhere in any form"* |
| `docs/60-content/62-schema-spec.md` §17.1 | The canonical JSON contract this work order extracts and reuses; the integer field-key registry is the **sealed** wire, not this face's | *"Canonical JSON: sorted keys, no insignificant whitespace, LF, UTF-8"* / registry: *"Stable integer keys per field, append-only, keys never reused"* |
| `62` §17.2 | Generated files are checked in and pinned | *"Generated files are checked in. CI regenerates and fails on any diff"* |
| `docs/30-security/33-sync-protocol.md` §5.1 | The sync op envelope this face deliberately does not implement | `SetField { field: FieldRef, value: PresenceRepr, prov: ProvenanceId, class: FieldClass }` |
| `docs/90-decisions/adr-0012-one-workspace-container.md` §Decision | Ownership: `17` the container, `32` the cryptography — this work order builds inside `17`'s plaintext territory only | *"Neither may specify the other's half."* |
| `docs/90-decisions/adr-0013-record-granularity-frames-and-the-manifest.md` §Decision | The sealed record model this work order must not pre-build | *"Fixed hash shards, whole-record rewrite, a committed manifest"* |
| `docs/70-ops/79-work-orders/WO-02-the-graph-store.md` §4 | The store's public API this work order consumes and extends; every name quoted in §3 below | the Deliverables tables of that document |
| `.context/conventions.md` § *Identifiers*, § *Terminology* | The rendered id form; and the fact that a **workspace** is by definition encrypted — so nothing plaintext is ever called one | *"Node IDs: `<kind-lower>:<ulid>`"* (ADR-0005: no product name in any identifier) / workspace: *"one encrypted document"* |
| `schema/schema.yaml` line 7 | The schema version the face header carries | `version: "0.1"` |

### 2.1 The crypto boundary — what `32` and `35` actually decide, verbatim

This subsection exists so no future session re-derives it, mis-derives it, or infers approval
that was never given. Read it as the record of a search performed on 2026-08-02.

**What `32` decides.** The primitives and parameters are fully specified: Argon2id v1.3 per
RFC 9106 with a calibrated-per-workspace policy floored at `m = 64 MiB, t = 3, p = 1` (`32` D1,
D2, §4.2); ChaCha20-Poly1305 per RFC 8439 with a per-record HKDF-derived subkey and a constant
zero nonce (`32` D3, D4, §5.3–5.4); a 128-bit key-commitment tag (`32` D5, §5.6); HPKE per
RFC 9180 for member wraps (`32` D9); the 112-byte envelope byte-for-byte (`32` §7.1). And the
implementation is specified as **not ours to write**: `32` §15 is titled *"What is deliberately
not rolled by hand"*, and §15.1 pins a crate table — `argon2 0.5.3`, `chacha20poly1305 0.11.0`,
`hkdf 0.13.0`, `sha2 0.11.0`, `hpke 0.14.0`, the dalek crates, `blake3 1.8.5`, `getrandom`,
`zeroize`, `secrecy`, `subtle` — *"Pinned in `Cargo.lock`, which is committed"*. Nearly every
row's review-status cell is a `<!-- VERIFY -->`; the document's own words on that column:
*"this table will say 'audited' only next to a report with a name and a date on it. Until then
the honest word is 'widely used'."* The `argon2` row adds: *"A `0.6.0-rc.8` exists; do not ship
an rc in a file format."*

**What `35` decides.** A dependency policy exists, with caps (C1–C8), a primary metric
(publisher count), and an addition procedure: *"Every addition is a reviewed change with a
recorded decision. The record lives in `deps/decisions/<crate>.md`"* — nine questions, the
ninth an `acceptable_when` with an expiry (`35` §5.3). Its §5.2 publisher table already counts
RustCrypto, dalek-cryptography, the BLAKE3 team and the `hpke` author as the realistic set, and
its honest statement prices the whole question: *"a cap of 100 is not achievable without either
hand-rolling cryptography (which `32` §15 correctly refuses) or dropping HPKE (which the sync
design needs)."* And its own `<!-- VERIFY -->` on that table states the standing condition:
*"It has not been generated from a real `Cargo.lock`, because there is no code yet."* That
VERIFY is stale in its premise — the tree now has code and a committed `Cargo.lock`
(`version = 4`, six workspace crates) — but its condition survives in a narrower form: the lock
contains zero external entries, so there is still nothing to generate the table from.

**What neither document does — and this is the finding.** Neither `32` nor `35` *authorises the
first external dependency into this workspace's manifest*. Both are `Status: Proposed`. No ADR
in `docs/90-decisions/` (0001–0030, titles reviewed 2026-08-02) adopts a dependency exception.
The manifest's own standing position is the opposite and is deliberate — the root `Cargo.toml`
comment, in full: *"No external dependencies anywhere in the workspace yet. That is a position,
not an accident (35-supply-chain-and-builds.md): the schema toolchain parses a deliberate YAML
subset (62 §2.2) precisely so it does not need a general YAML implementation, and fathom-id
needs nothing but core."* And the protocol closes both routes to an execution session
regardless: `78` §5 item 2 — *"**Never adds a dependency**: no crate, no npm package, no
GitHub Action, no tool download, no vendored source. … A work order that seems to need one is
an escalation, always"* — and `78` §7 classes *"Cryptography choices (`32`)"* as
judgment-shaped, owner or planning session only.

**Therefore, the boundary, in three sentences.** The decision *"implement the sealed workspace
via the `32` §15.1 crate set, under `35` §5.3's procedure"* is priced in the corpus and **taken
nowhere**; taking it is owner work (an ADR, the first `deps/decisions/` files, and the first
external-dependency pins in the committed `Cargo.lock` — which exists and today pins only the
six workspace crates — under the `cargo-vet` / `cargo-deny` policy of `35` §5.4–5.5; `32`
§15.1's *"Pinned in `Cargo.lock`, which is committed"* has, as yet, nothing external pinned).
**No execution session ever implements a cryptographic primitive from scratch** — not a KDF,
not an AEAD, not a hash, not "just BLAKE3 for the digest" — under this work order, under any
future work order, under any
instruction; a work order that asks for it is malformed under `78` §8 and is escalated, not
executed. Until the owner decides, everything this work order ships is plaintext, says so on
line two, and is complete and useful on its own terms: fixtures, goldens, diffable dev estates,
and the serialisation substrate the sealed format will later consume.

## 3. Prior state

Two parts, because this work order is authored while WO-02 is OPEN. Part (a) was verified
against the tree on 2026-08-02. Part (b) is the WO-02 contract this work order builds on; at
execution time every item in it must be re-verified against the merged code, and a divergence
is handled by `78` §8's correction test or `78` §4 — nothing else.

### 3.1 (a) Verified in the tree today

- **Workspace.** Six crates (`fathom-corpus`, `fathom-find`, `fathom-id`, `fathom-ir`,
  `fathom-schema`, `fathom-schemagen`), plus `fathom-graph` once WO-02 lands.
  `[workspace.dependencies]` is empty on purpose (the comment quoted in §2.1). The workspace
  `Cargo.lock` is committed (`version = 4`) and pins exactly the six workspace crates — no
  external entry (which is why §4.1's lock hunks ride the ordinary commits).
  `cargo test --workspace`: 80 tests, zero failures. `fathom-schema-check`: exit 0,
  `0 failure(s), 2 warning(s)`, both `schema.identity.unexercised` against `Site` — the pinned
  baseline (`78` §6).
- **`crates/fathom-schemagen/src/json.rs`.** `pub enum Json { Null, Bool, Int(i64), Float(f64),
  Str, Arr, Obj(BTreeMap<String, Json>) }` with `to_canonical_bytes()` — minified, keys sorted
  by `BTreeMap`, RFC 8259-minimal escaping, non-ASCII as raw UTF-8, one trailing newline — and
  `from_node(&fathom_schema::value::Node, &str)`. Its doc comment: *"Floats are structurally
  excluded from the IR (11 §14.1, 12 §3.4)"* — the `Float` variant exists for `schema.json`'s
  `matching:` block only. Four unit tests: `objects_sort_and_minify`,
  `escaping_is_rfc_8259_minimal`, `finite_floats_carry_shortest_round_trip`,
  `non_finite_floats_refuse`. **There is no parser.**
- **`crates/fathom-id/src/lib.rs`.** `Ulid(pub u128)` with `encode()` (*"26-character Crockford
  encoding, always uppercase"*), `decode(&str) -> Result<Self, DecodeError>`, and
  `from_parts(timestamp_ms, random)` as the only constructor (invariant 9). Bare
  `NodeId(pub Ulid)` / `EdgeId(pub Ulid)` newtypes exist (the field-embedded reference type).
- **`crates/fathom-ir`.** **Superseded 2026-08-08 for `scalar.rs` only:** WO-01 landed and the
  stubs are now 35 real types implementing `fathom_ir::scalar::Scalar`, plus `SecretPlaceholder`
  as the one registered exemption. §4.2 rule 13 is cut against that trait, so an executing session
  re-verifying this bullet should read §10.6 first and expect the trait, not the shapes below.
  The rest of this bullet — `value.rs`, the generated files, the counts — was re-verified
  unchanged in the same pass (§10.6, *What did not diverge*). As authored: stub scalar types in
  `scalar.rs` (newtypes over integers, `String`,
  `core::net` types; structs `IpPrefix`, `InterfaceAddress`, `IpRange`, `PortRange`,
  `RouteDistinguisher`, `RouteTarget`, `Date`, `LatLon`; unit `SecretPlaceholder`); stub
  structured values in `value.rs` (`Mtu`, `PeerSpec`, `AttrValue`, `PostalAddress`, unit stubs
  `IkeId`, `Dpd`, …). Generated `ir_types.rs`: `NodeKind` (48, `ALL`, `name()`), `EdgeKind`
  (81, `ALL`, `name()`), schema enums with `token()` / `from_token()` and a generated
  `Unknown(String)` arm carrying the unrecognised token verbatim (e.g. `Family`, verified);
  `FIELD_KEYS: [(&str, u32); 299]` with wire names of the form `Device.os_version`. Generated
  `accessors.rs`: slot types are bare `bool` / `u8` / `u16` / `u32` (30 / 8 / 8 / 10 accessors
  respectively, counted by grep 2026-08-02), the `scalar.rs` / `value.rs` stubs,
  `fathom_id::NodeId` (once: `LearnedRoute.via`), generated enums, `Vec<T>`,
  `BTreeSet<T>`, or `BTreeMap<K, V>`; the only two `BTreeMap` key types in the registry are
  `ir_types::Family` and `scalar::Identifier` (verified by grep of `accessors.rs`).
  **`NodeKind` and `EdgeKind` variant names are disjoint sets** (checked mechanically,
  2026-08-02) — the fact that makes one rendered id namespace parseable.
- **`crates/fathom-schemagen`.** Depends on `fathom-schema` only; `extract.rs` requires
  `schema.version` (*"schema.yaml declares no schema.version (62 §16.1)"* on absence) and
  carries it as `pub version: String`. `schema/schema.yaml` declares `version: "0.1"`.
  No `SCHEMA_VERSION` constant is generated today (grep of `ir_types.rs`).
- **No cryptographic code, no dependency, no `deps/` directory, no `vectors/` tree exists
  anywhere in the repository.** The §2.1 boundary is not hypothetical; it is the tree's state.

### 3.2 (b) The WO-02 contract this work order consumes

From `WO-02-the-graph-store.md` §4, quoted by name so divergence is detectable:
`fathom-graph`'s composite `NodeId { kind, ulid }` / `EdgeId { kind, ulid }` / `ElementId` with
`Display` rendering `<kind-lower>:<ulid>` (kebab-case kind, 26-char ULID; no product-name prefix — ADR-0005); `Timestamp`,
`ProvenanceId`, `UserId`, `Actor::User`, `Confidence::{Asserted, Derived, Heuristic}`,
`Origin::Hand`, `ProvenanceRecord`; `StoredPresence::{Set, Absent, Unknown}`, `FieldInfo`,
`FieldHistory` (`entries()`, `truncated()`), `HistoryEntry { presence, value: Option<Box<dyn
Any>>, prov }`; `BatchId`, `Op::{AddNode, AddEdge, SetField, Tombstone}`, `Batch { id, label,
ops }`; `Graph` with `begin_batch` / `end_batch` / `log()`, the write API, and the read API
(`nodes`, `edges`, `presence`, `history`, `provenance`, `node`, `edge`, `out`, `inn`);
`WriteError` with the L0 refusal ladder in a fixed order; generated `EdgeKind` endpoint /
bound / symmetric tables and `slot_type(key) -> Option<(TypeId, &'static str)>` in
`accessors.rs`; internals `BTreeMap` and `Vec` only. `Op` and `Batch` derive `Debug` only —
§4.3 below adds derives.

## 4. Deliverables

Every public name this work order creates or edits is listed here. A step that needs a public
name not on this list stops under §7. Module-private items are the execution session's to name.

### 4.1 `crates/fathom-canon` — the canonical byte contract, one home

`crates/fathom-canon/Cargo.toml`, verbatim:

```toml
[package]
name = "fathom-canon"
version = "0.1.0"
edition.workspace = true
license.workspace = true
publish.workspace = true
description = "The canonical JSON byte contract (62 §17.1): one emitter, one strict parser, shared by fathom-schemagen and the workspace face"

[dependencies]
```

Root `Cargo.toml` members list gains one line before `"crates/fathom-corpus"`:
`    "crates/fathom-canon",` — and one line after `"crates/fathom-schemagen"`:
`    "crates/fathom-workspace",` (§4.4). `crates/fathom-schemagen/Cargo.toml`
`[dependencies]` gains, before the `fathom-schema` line:
`fathom-canon = { path = "../fathom-canon" }`. The `Cargo.lock` hunks cargo generates ride the
same commits. No other edit to any manifest is authorised beyond the lines this section and
§4.2–§4.4 spell out.

`crates/fathom-canon/src/lib.rs` — `#![forbid(unsafe_code)]`. Contents:

- **`Json` and the emitter, moved verbatim** from `crates/fathom-schemagen/src/json.rs`:
  the enum, `to_canonical_bytes()`, and the private `emit` / `emit_str` helpers, byte-for-byte
  semantics unchanged. `fathom-schemagen`'s `json.rs` keeps `from_node` (it needs
  `fathom_schema::value::Node`, which stays where it is) and re-exports the moved type:
  `pub use fathom_canon::Json;` — so no other schemagen file changes. The two emitter-only unit
  tests (`objects_sort_and_minify`, `escaping_is_rfc_8259_minimal`) move with the code; the two
  `from_node` float tests stay in schemagen.
- **The strict parser**, new:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError { pub offset: usize, pub reason: ParseReason }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseReason {
    UnexpectedByte,      // anything outside the canonical grammar, incl. any whitespace
    Utf8,                // invalid UTF-8 in a string
    UnsortedKey,         // object key ≤ its predecessor (byte order) — also covers duplicates
    NonShortestInt,      // leading zero, "-0", or a plus sign
    IntOutOfRange,       // integer literal outside i64 — no emitter `Int(i64)` produced it
    FloatRefused,        // a '.' or exponent in a number — the IR is float-free (§3.1)
    NonMinimalEscape,    // any escape the emitter would not produce (e.g. \u0041 spelling "A")
    RawControl,          // an unescaped byte < 0x20 inside a string
    DepthExceeded,       // nesting beyond 512
    TrailingBytes,       // any byte after the value other than the single final LF
    MissingFinalNewline, // the value is not followed by exactly one LF
}

impl Json {
    pub fn parse_canonical(bytes: &[u8]) -> Result<Json, ParseError>;
}
```

**DECISION — the parser accepts exactly the emitter's output set, nothing wider.** The law,
tested: for every `b` the parser accepts, `parse_canonical(b)?.to_canonical_bytes() == b`.
There is no lenient mode, no whitespace tolerance, no alternative escape spelling — one
spelling per value is the entire point of a canonical form, and a parser that accepts two
spellings makes byte-identity a lie. Two bounded asymmetries, both recorded in §12.3: the
emitter can emit `Float` (for `schema.json`'s `matching:` block) while the parser refuses
`FloatRefused`, because nothing this parser serves carries a float (§3.1); and the emitter
recurses without a depth limit while the parser refuses nesting beyond 512 (`DepthExceeded`) —
no schema-shaped value approaches that depth, and an unbounded recursive parser over a
hand-editable plaintext file is a stack-overflow surface this crate refuses to carry.

### 4.2 `fathom-ir` — canonical value forms, and the generated dispatch

`crates/fathom-ir/Cargo.toml` `[dependencies]` gains one line:
`fathom-canon = { path = "../fathom-canon" }`.

**`crates/fathom-ir/src/canon.rs`** — new module, exported from `lib.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonError {
    UnknownKey { key: u32 },                  // FieldKey not in the registry
    WrongType { key: u32, declared: &'static str },
    IntOutOfRange,                            // u64 value above i64::MAX on write
    NonCanonicalSpelling,                     // parse-then-re-render mismatch (rule 4/5/7/11)
    NonCanonicalOrder,                        // set members not strictly ascending (rule 12)
    UnknownVariant { token: String },         // hand-written enum: no such variant key
    Shape { expected: &'static str },         // wrong Json shape for the slot
}

pub trait CanonicalValue: Sized {
    fn to_canon(&self) -> Result<fathom_canon::Json, CanonError>;
    fn from_canon(j: &fathom_canon::Json) -> Result<Self, CanonError>;
}

/// Map keys must render as JSON object keys. Implemented for exactly the two
/// registry key types (§3.1): `scalar::Identifier` (the string itself) and
/// `generated::ir_types::Family` (its `token()`, parsed by `from_token`).
pub trait CanonKey: Sized + Ord {
    fn to_key(&self) -> Result<String, CanonError>;
    fn from_key(k: &str) -> Result<Self, CanonError>;
}
```

**DECISION — the wire family table.** These rules are format, not implementation; the execution
session implements them and may not vary them. `CanonicalValue` is implemented in `canon.rs` for
every slot type the generated dispatch (below) names — the dispatch is generated from the
registry, so a missing impl is a compile error, which makes coverage mechanical.

**Re-cut 2026-08-08 by §10.6's answer.** Membership is decided **by trait first, shape second**.
A type implementing `fathom_ir::scalar::Scalar` is rule 13 whatever its shape, and rule 13's wire
form *is* that trait's `canonical()`. Only types outside the trait are classified structurally,
and only within `value.rs`: a field-less unit struct is rule 8; a multi-field struct is rule 6; a
hand-written enum is rule 9. `SecretPlaceholder` — `scalar.rs`'s one registered `Scalar`
exemption — is rule 14 and nothing else. Rules 3, 4, 5 and 7 are **retired**: every type they
named implements `Scalar`, so rule 13 subsumes them, and their numbers are left vacant rather
than reused so every existing citation of a rule number keeps its meaning. Where a parenthetical
below carries no `…` it enumerates today's members in full (verified against `accessors.rs`,
`scalar.rs` and `value.rs`, 2026-08-08); a registry type that implements no `Scalar` and whose
*shape* matches no family is §7 trigger 4 — a name absent from an open-ended parenthetical is not.

| # | Slot type family | Wire form | Parse rule |
|---|---|---|---|
| 1 | `bool` | `true` / `false` | exact |
| 2 | **Bare** primitive integers — `62` §3's primitive row (`u8`–`u64`, `i32`, `i64`). Only `u8`, `u16` and `u32` are bound by any slot today; `accessors.rs` carries no bare `u64`, `i64` or `i32` slot (grep, 2026-08-08). Every *newtype* over an integer is rule 13 | `Int` | range-checked into the target width, `Shape` on non-int; a `u64` above `i64::MAX` refuses `IntOutOfRange` **at write time** — never wrapped, never stringified. The impl exists ahead of the first `u64` slot on purpose: the guard lands before the binding, not after |
| 3 | *(retired 2026-08-08 — every member implements `Scalar`; see rule 13)* | | |
| 4 | *(retired 2026-08-08 — see rule 13)* | | |
| 5 | *(retired 2026-08-08 — see rule 13)* | | |
| 6 | Multi-field structs in `value.rs` (`Mtu`, `PostalAddress`, `NameConformance`, `QualifiedNextHop`, `NodePriority`, `EndpointCardinality` — all six; the six that were `scalar.rs`'s are rule 13) | `Obj`, keys = the declared snake_case field idents, values per rules; `Option` fields **omitted when `None`** — omission is the one spelling of absence, `Null` never appears | every present key known, every non-`Option` key present, else `Shape` |
| 7 | *(retired 2026-08-08 — see rule 13)* | | |
| 8 | Unit stubs — every field-less struct in `value.rs`: `IkeId`, `Dpd`, `OspfArea`, `PolicyScope`, `AddressValue`, `L4Spec`, `NatScope`, `NatAction`, `VpnMonitor`, `PortPosition`, `Transceiver`, `SplitRatio`, `AttributeDecl`, `FieldPath`, `Resolution` (all fifteen) | `Obj` empty, `{}` | exact. A type with no fields has nothing to lose on the wire; the moment one grows a field it leaves this rule, which is what §10.6 caught |
| 9 | Hand-written enums in `value.rs` (`PeerSpec`, `AttrValue`, `NextHop`, `SyslogHost` — all four at slot level; `AttrType` is `AttrValue`'s tag, welded to it by an exhaustive match, and has no independent wire form) | payload-carrying variant → one-key `Obj` `{"<variant snake ident>": <payload per rules>}`; payload-free variant → bare `Str` `"<variant snake ident>"`; a multi-field payload → `Obj` of its fields per rule 6 | exactly one spelling exists per variant; unknown key/string refuses `UnknownVariant` |
| 10 | Generated schema enums (`Family`, `HostProtocol`, `CableEnd`, …) | `Str` of `token()` — for `Unknown(t)`, the carried token verbatim | `from_token` (total: undeclared tokens land in `Unknown`, which is what makes a new schema token a survivable read — `62` §16.2 via the generated doc comment). Impls are **generated**, §below |
| 11 | `fathom_id::NodeId`, `fathom_id::EdgeId` (one direct slot — `LearnedRoute.via` — plus bare references inside values) | `Str`, `Ulid::encode` (26 chars, upper case) | `Ulid::decode`, refuse on error (`Shape`); then **re-render equality**: if `encode(parsed) != input`, refuse `NonCanonicalSpelling` — `Ulid::decode` is deliberately Crockford-lenient (case-insensitive, I/L→1, O→0: `fathom-id`'s doc comment and its `ulid_crockford_aliases_decode` test), and one spelling per value is the law |
| 12 | `Vec<T>` | `Arr`, declaration order preserved (order is data) | element-wise |
|   | `BTreeSet<T>` | `Arr` in ascending `T: Ord` order | refuse a non-strictly-ascending sequence: `NonCanonicalOrder` — otherwise re-emission would silently reorder and break byte-identity |
|   | `BTreeMap<K: CanonKey, V>` | `Obj` keyed by `to_key` | keys via `from_key`; duplicate keys are impossible at the `Json` level (parser refuses) |
| 13 | **Every `fathom_ir::scalar::Scalar` implementor — all 35** (`scalar.rs`'s own section comment: *"The 35 `Scalar` implementations, in WO-01 §4.2 part A's row order"*). Newtypes, `core::net` carriers, multi-field structs and hand-written enums alike: the trait decides, not the shape | `Str` of `Scalar::canonical()` | `Scalar::parse`, then **re-render equality** — `canonical(parsed) != input` refuses `NonCanonicalSpelling`. A `parse` refusal refuses `NonCanonicalSpelling` too: in both cases the fact is that the byte string is not the canonical spelling of any value of that type. Plus the **write-side injectivity check** below |
| 14 | `SecretPlaceholder` — the one registered `Scalar` exemption (`scalar.rs`: *"It therefore implements no [`Scalar`] — the one registered exemption"*), bound at one slot, `IkePolicy.pre_shared_key` (field key 155, `accessors.rs`) | `Obj` with key `label` always present and key `hint` present iff `hint()` is `Some`: `{"label":"psk"}` / `{"hint":"vault: net/psk/site-b","label":"psk"}`. The five `label` tokens are fixed by this document as `psk`, `cert-key`, `snmp-community`, `tacacs-key`, `password` | `label` through that fixed table (unknown token → `UnknownVariant { token }`); `hint` through `SecretHint::new`, which re-enforces the 120-byte cap on read, over-length refusing `Shape { expected: "a hint of at most 120 bytes" }`; value rebuilt with `SecretPlaceholder::new` / `with_hint`, so there is still no path from arbitrary text to a secret |

**DECISION — rule 13 delegates the wire to `Scalar::canonical()`, and checks injectivity on write.**
WO-01 built, for all 35 scalars, exactly the thing a canonical wire needs: one injective text form
per value, with `parse` as its inverse, and `tests/scalar_contract.rs` already pinning the L1c
round trip. A second spelling authored here would give the product two canonical forms of the same
value — one for diffing, equality and emit, one for the file — which is `35` §5.1 C8's *"one
implementation per job"* broken inside a single crate. Rule 13 therefore has no independent
content: the wire is `canonical()`, and every future reshape of a scalar's *representation* is
invisible to the format so long as the trait still holds.

Its one addition is a **write-side check, required, not optional**: `to_canon` renders
`canonical()`, re-parses it, and refuses `NonCanonicalSpelling` unless the re-parse equals the
original value. This is not belt-and-braces. WO-01 §9 row 1 records that the laws are quantified
over parse-reachable values and that a hand-built value can sit outside them, and `scalar.rs` shows
what that costs on a wire: `EncryptionAlgorithm::canonical()` returns **the empty string** for any
value outside `ENC_TABLE`'s eight tokens, and `Fqdn::parse` case-folds, so `Fqdn("EXAMPLE.COM")`
canonicalises to text that reads back as a different value. Without the check those write as `""`
and as `"EXAMPLE.COM"` and fail on read — the file is written successfully and cannot be loaded.
**Refusing at write is the correct direction**: it fails loudly at the moment the estate is saved,
rather than quietly producing a file whose owner discovers the loss when they try to open it.

**DECISION — `SecretPlaceholder` carries its label and its hint onto the plain wire.** Rule 8's
`{}` is not implementable here and never was: `SecretPlaceholder`'s only constructors take a
label, so `from_canon` given `{}` would have to **invent** one. Four things that costs, in order of
severity. (a) `placeholder()` renders `'<' + label.token() + '>'`, so a `TacacsKey` placeholder
reloaded under an invented default emits `<PSK>` into a TACACS field — wrong configuration text
handed to an operator to paste into a device. (b) That breaks invariant 9 across a save/load
boundary: same workspace, different emitted bytes. (c) The hint is the operator's own record of
*where the real secret lives*; destroying it on first save is silent data loss in the one part of
the system that exists because credentials are handled carefully. (d) §4.5's own law
`from_canon(to_canon(v)?)? == v` cannot hold, so the rule is not implementable as written.

**The security half, stated rather than assumed.** Invariant 3 is not engaged: it bars *device
credentials* from being written, and this type holds none by construction — `scalar.rs` states the
guarantee as *"There is no `SecretPlaceholder::from_value`"*, both fields are private, and rule 14
reconstructs only through `new` / `with_hint`, so the read path cannot manufacture one either. The
`label` is a category, not a secret, and it is already rendered verbatim into emitted config as
`<PSK>`. The `hint` is user-typed free text, documented as *"A pointer to where the human keeps
the secret, never a value"* and capped at 120 bytes — but nothing in the type *enforces* that a
user did not type a secret into it. Writing it to the plain face therefore exposes it exactly as
much as the plain face exposes every other field, which is completely, by declaration, and is what
line 2 of the file says in capitals. The alternative — carrying `label` and dropping `hint` — is
strictly worse: it is silent loss of the field most likely to matter to the person recovering an
estate, and it breaks the round-trip law just as `{}` does. **Not decided here:** whether the
ingest gate or the plain face should attempt to detect a secret typed into a hint. That is a
heuristic with no mechanism anywhere in the corpus, and inventing one inside a wire table is how
a false negative gets a reassuring name.

**The `label` tokens are this document's, deliberately not `SecretLabel::token()`.** `token()` is
the *emit* rendering — the text inside the angle brackets — and four of its five values carry a
live `VERIFY` in `scalar.rs` (*"the four tokens beyond `<PSK>` are stated nowhere read; confirm
before an emitter renders them into config"*). Welding a stored file format to a string that is
expected to change would mean every existing file becomes unreadable the day that VERIFY resolves.
The five wire tokens above are fixed here, pinned by a test that asserts them literally, and a
change to `token()` must not move them.

**No row is needed for `EncFamily`, `EncMode`, `SecretLabel` or `SecretHint`** — §10.6 names them
as newly reachable. None is a registry slot type (grep of `accessors.rs`, 2026-08-08: zero
occurrences of each). `EncFamily` and `EncMode` disappear entirely inside rule 13's token;
`SecretLabel` and `SecretHint` appear only inside rule 14's two keys. They reach the wire only
through a type that has a rule, which is the correct amount of format for an interior type.

**Generated code (changes to `fathom-schemagen`).** Three additions, all emitted into the
existing checked-in generated files, matching their style (`#[rustfmt::skip] mod body`,
`pub use body::*`):

1. Into `ir_types.rs` body: `pub const SCHEMA_VERSION: &str = "0.1";` — emitted from the
   tree's `schema.version` (already extracted, §3.1), never hand-written (ADR-0008). Its one
   public path is `fathom_ir::generated::ir_types::SCHEMA_VERSION`: `fathom-ir`'s `lib.rs`
   re-exports nothing at the crate root today and this work order does not edit it.
2. Into `ir_types.rs` body: `impl crate::canon::CanonicalValue for <each schema enum>` and
   `impl crate::canon::CanonKey for Family`, generated from the enum's own token table
   (rule 10; `Family`'s `CanonKey` uses the same `token()` / `from_token`).
3. Into `accessors.rs` body, alongside `slot_type`:

```rust
/// Serialise a slot value. Refuses an unknown key, a wrong runtime type
/// (the same TypeId check as `slot_type`), or a value error per §4.2's table.
pub fn slot_to_canon(key: crate::bag::FieldKey, value: &dyn core::any::Any)
    -> Result<fathom_canon::Json, crate::canon::CanonError>;

/// Parse a slot value into the declared type, boxed for the store.
pub fn slot_from_canon(key: crate::bag::FieldKey, j: &fathom_canon::Json)
    -> Result<Box<dyn core::any::Any>, crate::canon::CanonError>;
```

Both are exhaustive matches over the registry generated from the same extraction that feeds
`slot_type` — no hand-maintained copy of any schema fact (ADR-0008). A registry type path with
no `CanonicalValue` impl fails to compile, which is the coverage gate. `schema/generated/
schema.json`, `ir_types.ts` and `schema/migrations/manifest.toml` must come out byte-identical —
their inputs are untouched.

### 4.3 `fathom-graph` — id parsing, and the snapshot pair

`crates/fathom-graph/Cargo.toml` `[dependencies]` gains one line:
`fathom-canon = { path = "../fathom-canon" }`.

Edits to existing WO-02 items, additive only: `Op` and `Batch` gain
`#[derive(Debug, Clone, PartialEq)]` (replacing bare `Debug`). Nothing else in WO-02's
deliverable set is modified, renamed, or re-specified.

**Id parsing** (in `src/id.rs`):

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdParseError {
    Shape,                                  // not <kebab>:<26 chars>
    UnknownKind { kebab: String },
    Ulid(fathom_id::DecodeError),
    NonCanonicalUlid,                       // decodes, but re-encodes differently
}
impl NodeId    { pub fn parse(s: &str) -> Result<NodeId, IdParseError>; }
impl EdgeId    { pub fn parse(s: &str) -> Result<EdgeId, IdParseError>; }
impl ElementId { pub fn parse(s: &str) -> Result<ElementId, IdParseError>; }
```

`parse` inverts `Display` exactly: the kebab segment is matched against the kebab renderings of
`NodeKind::ALL` (then, for `ElementId`, `EdgeKind::ALL` — the two name sets are disjoint, §3.1,
and a test pins it). The ULID segment goes through `Ulid::decode` **and then re-render
equality**: `Ulid::decode` alone accepts Crockford aliases (case-insensitive, I/L→1, O→0 —
`fathom-id`'s doc comment; its `ulid_crockford_aliases_decode` test exercises them), so a
decode-only `parse` would accept `device:0o000…` and silently normalise a hand-edited
file; if `encode(decoded)` differs from the input segment, `parse` refuses `NonCanonicalUlid`.
The law is two-directional: `parse(x.to_string()) == Ok(x)` for every kind, and
`parse(s)?.to_string() == s` for every accepted `s`.

**The snapshot pair** (new module `src/snap.rs`, re-exported at the crate root):

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub nodes: Vec<NodeSnap>,               // ascending NodeId
    pub edges: Vec<EdgeSnap>,               // ascending EdgeId
    pub provenance: Vec<ProvenanceRecord>,  // ascending ProvenanceId
    pub history: Vec<HistorySnap>,          // ascending (element, key)
    pub batches: Vec<Batch>,                // log order (append order is data)
}
#[derive(Debug, Clone, PartialEq)]
pub struct NodeSnap {
    pub id: NodeId,
    pub existence: ProvenanceId,
    pub absent_since: Option<Timestamp>,
    pub fields: Vec<FieldSnap>,             // ascending FieldKey
}
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeSnap {
    pub id: EdgeId,
    pub from: NodeId,
    pub to: NodeId,
    pub prov: ProvenanceId,
    pub absent_since: Option<Timestamp>,
    pub fields: Vec<FieldSnap>,             // ascending FieldKey
}
#[derive(Debug, Clone, PartialEq)]
pub struct FieldSnap {
    pub key: FieldKey,
    pub presence: StoredPresence,           // Set or Absent only — Unknown is a missing slot
    pub value: Option<fathom_canon::Json>,  // Some iff presence == Set
    pub prov: ProvenanceId,
}
#[derive(Debug, Clone, PartialEq)]
pub struct HistorySnap {
    pub element: ElementId,
    pub key: FieldKey,
    pub entries: Vec<HistoryEntrySnap>,     // oldest first, as `entries()` returns
    pub truncated: u32,
}
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryEntrySnap {
    pub presence: StoredPresence,           // all three states legal here
    pub value: Option<fathom_canon::Json>,
    pub prov: ProvenanceId,
}

#[derive(Debug)]
pub enum SnapshotError {
    OpenBatch { open: BatchId },            // serialising mid-intention is refused
    Canon(fathom_ir::canon::CanonError),
    L0(WriteError),                         // every WO-02 §4.2 rule-4 refusal, on load
    DanglingProvenance { id: ProvenanceId },
    DuplicateElement { element: ElementId },
    OutOfOrder { section: &'static str },   // a snapshot vector violates its stated order
    SymmetricNotNormalised { edge: EdgeId },
    UnknownFieldPresence { element: ElementId, key: FieldKey }, // Unknown in `fields`
    ValuePresenceMismatch { element: ElementId, key: FieldKey }, // value ⇔ Set violated
    UnknownElement { element: ElementId },  // history or an op names nothing in the snapshot
}

impl Graph {
    pub fn to_snapshot(&self) -> Result<Snapshot, SnapshotError>;
    pub fn from_snapshot(s: &Snapshot) -> Result<Graph, SnapshotError>;
}
```

**DECISION — the snapshot is complete and value-converted at the boundary.** `to_snapshot`
converts every `Set` slot and every history value through the generated `slot_to_canon`, so the
snapshot is plain, clonable, comparable data with no `dyn Any` in it; `from_snapshot` converts
back through `slot_from_canon`, which enforces the declared type by construction. `to_snapshot`
refuses while a batch is open (`OpenBatch`).

**DECISION — `from_snapshot` re-enforces L0, and installs history and the log verbatim.**
Loading is not trusting: every structural refusal in WO-02 §4.2's rule-4 ladder (endpoint
existence and kinds, symmetric-pair uniqueness, second containment, containment and set cycles,
upper bounds — counted over effective edges) applies on load and surfaces as
`SnapshotError::L0(WriteError)` naming the same violation the write path would name; the
mechanism is the session's, the refusal set is not. Additionally: every `ProvenanceId`
referenced anywhere (existence, edge, field, history entry, `SetField` op) must resolve in
`provenance` (`DanglingProvenance`); symmetric-kind edges must arrive already normalised
(`SymmetricNotNormalised` — the writer normalised them, so a denormalised pair is tampering or
a bug, and `from_snapshot` never silently fixes); every element an op or history row names must
exist (`UnknownElement`); `fields` may not carry `Unknown` (`UnknownFieldPresence`) and value
presence must match (`ValuePresenceMismatch`). History (including `truncated`) and the batch
log are installed exactly as given — they are the record, not replayable instructions
(`Op::SetField` deliberately carries no value payload, WO-02 §4.2). Batch-requirement checks
(`NoOpenBatch` etc.) do not apply on load; no ops are appended by loading. The law, tested:
`to_snapshot(&from_snapshot(&s)?)? == s` and `from_snapshot` ∘ `to_snapshot` preserves every
observable of the store (iterators, presence, history, provenance, log).

### 4.4 `crates/fathom-workspace` — the plaintext dev face

`crates/fathom-workspace/Cargo.toml`, verbatim:

```toml
[package]
name = "fathom-workspace"
version = "0.1.0"
edition.workspace = true
license.workspace = true
publish.workspace = true
description = "17's format home. Today: the plaintext dev face — versioned header, canonical JSON body, byte-identical round trip. Nothing sealed exists yet and nothing here pretends otherwise"

[dependencies]
fathom-canon = { path = "../fathom-canon" }
fathom-graph = { path = "../fathom-graph" }
fathom-id = { path = "../fathom-id" }
fathom-ir = { path = "../fathom-ir" }
```

`src/lib.rs` — `#![forbid(unsafe_code)]`. The crate is **bytes in, bytes out**: no filesystem,
no clock, no RNG, no path discovery, no default location — the file lives where the caller (one
day, the user — `46` §1) chose, and this crate never chooses. Public API, in full:

```rust
pub const PLAIN_MAGIC: &str = "fathom-plain";
pub const PLAIN_FACE_VERSION: u32 = 1;
pub const PLAIN_WARNING: &str =
    "THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.";
pub const PLAIN_EXTENSION: &str = "fplain";

pub fn write_plain(graph: &fathom_graph::Graph) -> Result<Vec<u8>, PlainError>;
pub fn read_plain(bytes: &[u8]) -> Result<fathom_graph::Graph, PlainError>;

/// The refuse-to-masquerade rule for anyone naming a file after these bytes:
/// the name must end `.fplain`, and must not contain `.fathom` anywhere, nor
/// end in any sealed extension (`.frec`, `.fcap`, `.fm` — 17 §2.1, §12.2).
pub fn check_plain_name(name: &str) -> Result<(), PlainError>;

#[derive(Debug)]
pub enum PlainError {
    NotPlainFace,                            // line 1 is not `fathom-plain <n>` — incl. sealed magic
    UnsupportedFaceVersion { found: String },
    MissingPlaintextBanner,                  // line 2 ≠ PLAIN_WARNING, byte for byte
    SchemaVersionMismatch { found: String, supported: &'static str },
    MalformedHeader { line: u32 },
    Json(fathom_canon::ParseError),
    Shape { path: String, expected: &'static str },  // body structure wrong at a named point
    Canon(fathom_ir::canon::CanonError),
    Snapshot(fathom_graph::SnapshotError),
    Id(fathom_graph::IdParseError),
    NotPlainExtension { name: String },
    MasqueradingName { name: String },
}
```

**DECISION — the file format, byte for byte.** LF line endings throughout; UTF-8; no BOM.

```text
line 1   fathom-plain 1
line 2   THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.
line 3   schema 0.1
line 4   (empty)
line 5   <the snapshot as canonical JSON, one line, ending in the file's final LF>
```

Line 1 carries the face format version (`PLAIN_FACE_VERSION`). Line 3 carries the generated
`fathom_ir::generated::ir_types::SCHEMA_VERSION` verbatim (`"0.1"` today; that full path is the
constant's only public name, §4.2 item 1). `read_plain` checks in this order,
so refusals are deterministic: line 1 magic (`NotPlainFace` — which is also what the sealed
envelope magic `46 54 48 4D 1F 52 45 43` produces, tested); face version (exact match, else
`UnsupportedFaceVersion` naming what it found — `17` §2.2's rule: know you cannot read it
before doing anything else); line 2 byte-equality with `PLAIN_WARNING`
(`MissingPlaintextBanner` — a file whose warning has been edited away is refused, not
tolerated); line 3 exact string match against `SCHEMA_VERSION` (`SchemaVersionMismatch`
carrying both — migration policy is deliberately not this work order's, §10.2); line 4 empty
(`MalformedHeader`); then the body through `Json::parse_canonical`, the pinned JSON shape, and
`Graph::from_snapshot`. `write_plain` is the exact inverse and is a pure function of the graph.

**DECISION — the snapshot's JSON shape, pinned.** Top level: an `Obj` with exactly the keys
`batches`, `edges`, `history`, `nodes`, `provenance` — all always present, empty as `[]`.
Renderings: composite ids as their `Display` form (parsed by §4.3's `parse`); `ProvenanceId`,
`UserId`, `BatchId` as bare 26-char ULID strings — parsed `Ulid::decode` **plus** the same
re-render equality as §4.3, so an aliased or lower-case spelling refuses
(`Id(IdParseError::NonCanonicalUlid)`); `Timestamp` as `Int`; `FieldKey` as the
registry wire name (`"Device.os_version"`); `StoredPresence` as `"set"` / `"absent"` /
`"unknown"`; `Origin::Hand` as `"hand"`; `Confidence` as `"asserted"` / `"derived"` /
`"heuristic"`; `Actor::User(u)` as `{"user":"<ulid>"}`; `Option` fields omitted when `None`
(`supersedes`, `absent_since`, a history entry's `value`); `null` never appears. Per entry:

| Entry | `Obj` keys (canonical order) |
|---|---|
| node | `absent_since`?, `existence`, `fields`, `id` |
| edge | `absent_since`?, `fields`, `from`, `id`, `prov`, `to` |
| `fields` | an `Obj` keyed by wire name; each value `{"presence":…, "prov":…, "value":…?}` — `value` present iff `"set"`; `unknown` never appears here |
| provenance record | `asserted_at`, `asserted_by`, `confidence`, `id`, `origin`, `supersedes`? |
| history row | `element`, `entries`, `field`, `truncated`; each entry `{"presence":…, "prov":…, "value":…?}` |
| batch | `id`, `label`, `ops` |
| op | one-key `Obj`: `{"add_node":{"node":…, "prov":…}}`, `{"add_edge":{"edge":…, "from":…, "prov":…, "to":…}}`, `{"set_field":{"element":…, "key":…, "presence":…, "prov":…}}`, `{"tombstone":{"at":…, "element":…}}` |

**The pinned first vector.** The following file is the exact output of `write_plain` for the
graph built by: `begin_batch(BatchId(Ulid(2)), "seed")`; `insert_node(NodeKind::Device,
Ulid(1), ProvenanceRecord { id: ProvenanceId(Ulid(3)), origin: Origin::Hand, asserted_at:
Timestamp(0), asserted_by: Actor::User(UserId(Ulid(4))), confidence: Confidence::Asserted,
supersedes: None })`; `end_batch()`. (`Ulid(n)` here means `Ulid(pub u128)` holding `n`; its
encoding is 25 `0`s then the digit.) Five lines; line 5 is a single line, shown here unwrapped:

```text
fathom-plain 1
THIS FILE IS PLAINTEXT. EVERY PROTECTION THE WORKSPACE HAS ENDS HERE.
schema 0.1

{"batches":[{"id":"00000000000000000000000002","label":"seed","ops":[{"add_node":{"node":"device:00000000000000000000000001","prov":"00000000000000000000000003"}}]}],"edges":[],"history":[],"nodes":[{"existence":"00000000000000000000000003","fields":{},"id":"device:00000000000000000000000001"}],"provenance":[{"asserted_at":0,"asserted_by":{"user":"00000000000000000000000004"},"confidence":"asserted","id":"00000000000000000000000003","origin":"hand"}]}
```

**Re-issued 2026-08-08 by §10.7's answer**, correcting both node-id renderings from
`fathom:device:<ulid>` to `device:<ulid>` — the form `fathom-graph`'s `Display` actually emits and
the only form `.context/conventions.md` § *Identifiers* and ADR-0005 action 1 permit. The
correction is scoped to those two strings and to §4.5's two refusal inputs; **every other byte of
this vector remains this document's unexecuted claim, and §7 trigger 3 still governs it in full**.
If the constructed bytes differ anywhere else, that is a fresh escalation, not a licence to edit.

The vector is embedded in the test as a string constant typed from this document — **never** a
regenerated golden file (`78` §5 item 5). If the constructed bytes differ from it, the session
does not adjust either side to match: it escalates under §7, quoting both, because one of the
two — the code or this document — is wrong, and deciding which is planning work.

### 4.5 Tests

New test files and names, exactly these (bodies are the session's to write, to the assertions
stated in §4 and §5):

| File | Tests |
|---|---|
| `crates/fathom-canon/tests/canonical.rs` | `emitter_vectors_survive_the_move`; `parse_emit_identity_on_accepted_vectors`; `whitespace_refused`; `unsorted_or_duplicate_keys_refused`; `nonminimal_escape_refused`; `raw_control_refused`; `nonshortest_int_refused`; `int_overflow_refused` (`"99999999999999999999"` refuses `IntOutOfRange`); `float_refused`; `trailing_bytes_refused`; `missing_final_newline_refused`; `depth_cap_refused` |
| `crates/fathom-ir/tests/canon_laws.rs` | `schema_version_is_the_trees`; `exemplar_round_trips_per_family` (one exemplar per live §4.2 table row — 1, 2, 6, 8, 9, 10, 11, 12, 14 — **and, for rule 13, one per `Scalar` implementor, all 35**, since rule 13's whole content is that the trait decides; law: `from_canon(to_canon(v)?)? == v`); `ip_noncanonical_spelling_refused` (both inputs kept: `"010.0.0.1"`, which `Ip4Addr::parse` refuses through std's leading-zero rule, and `"0:0:0:0:0:0:0:1"`, which parses and re-renders as `"::1"` — under rule 13 both surface as `NonCanonicalSpelling`); `id_noncanonical_spelling_refused` (rule 11: an `O`-aliased and a lower-case ULID spelling both refuse `NonCanonicalSpelling`); `u64_above_i64_max_refused` (rule 2, exercised against `CanonicalValue for u64` **directly** — no slot binds a bare `u64` today, so there is no slot to route it through, and the guard is tested ahead of the first binding); `non_parse_reachable_scalar_refused_at_write` (rule 13's write-side injectivity check: a hand-built `EncryptionAlgorithm` outside `ENC_TABLE`, whose `canonical()` is `""`, and a hand-built `Fqdn("EXAMPLE.COM")` both refuse `NonCanonicalSpelling` from `to_canon`); `secret_placeholder_round_trips_label_and_hint` (rule 14, both arms: `new(SecretLabel::TacacsKey)` and `with_hint`, law `from_canon(to_canon(v)?)? == v`, plus an assertion that the five wire tokens are literally `psk` / `cert-key` / `snmp-community` / `tacacs-key` / `password` so a change to `SecretLabel::token()` cannot move them); `secret_placeholder_hint_cap_reenforced_on_read` (a 121-byte `hint` in the JSON refuses `Shape`); `set_members_out_of_order_refused`; `map_keys_round_trip` (`Identifier`- and `Family`-keyed; `CanonKey for Identifier` goes through the same `Scalar` pair as rule 13, so an `Identifier`'s key spelling and value spelling cannot diverge); `enum_tokens_round_trip_including_unknown`; `dispatch_names_every_registry_key` (all 299: `slot_to_canon` with a wrong-typed value returns `WrongType`, proving an arm exists per key) |
| `crates/fathom-graph/tests/ids.rs` | `display_parse_round_trips_every_kind` (all 48 + 81, fixed ULID); `node_and_edge_kind_kebabs_are_disjoint`; `parse_refuses_unknown_kind_bad_ulid_and_wrong_shape`; `parse_refuses_noncanonical_ulid_spelling` (`"device:0000000000000000000000000I"` and `"device:o0000000000000000000000001"` both refuse `NonCanonicalUlid` — re-issued 2026-08-08 by §10.7; the earlier `fathom:`-prefixed inputs would have refused for the wrong reason, `Shape`, and proved nothing about the ULID segment) |
| `crates/fathom-graph/tests/snapshot.rs` | `worked_example_snapshot_round_trips` (WO-02 §4.3's side-1 graph, both laws of §4.3); `empty_graph_snapshot_round_trips`; `open_batch_refused`; `dangling_provenance_refused`; `endpoint_kind_still_refused_on_load` (a hand-built snapshot with a `ZoneMember` edge to a `Device` refuses `L0(EndpointKind …)`); `symmetric_not_normalised_refused`; `unknown_presence_in_fields_refused`; `tombstones_history_and_log_survive` |
| `crates/fathom-workspace/tests/plain_face.rs` | `minimal_estate_matches_the_pinned_vector`; `worked_example_round_trips_byte_identical` (write → read → write, `assert_eq!` on bytes); `empty_graph_round_trips_byte_identical`; `banner_is_line_two_verbatim` (splits output on LF, asserts line 2 `== PLAIN_WARNING`); `face_version_2_refused_by_name`; `schema_version_mismatch_refused_by_name`; `missing_banner_refused`; `sealed_magic_refused_as_not_plain` (input beginning `46 54 48 4D 1F 52 45 43`); `trailing_bytes_refused`; `noncanonical_ulid_in_body_refused` (the pinned vector with one body ULID's leading `0` respelled `O` — same value, second spelling — refuses `Id(NonCanonicalUlid)`); `masquerading_names_refused` (`"site-b.fathom"`, `"x.frec"`, `"y.fathom.fplain"` refused; `"site-b.fplain"` accepted) |

All ULIDs, timestamps and ids in tests are fixed constants (invariant 9; `fathom-id`'s own
rule — there is no clock or RNG to reach for).

## 5. The plan

Each step ends with the tree compiling and `cargo test --workspace` green unless the step says
otherwise. No reordering, no merging (`78` §3.6).

1. **Create `fathom-canon`.** The verbatim manifest, the root members line, `lib.rs` with the
   moved `Json` + emitter + the two moved tests; edit `fathom-schemagen`'s manifest and
   `json.rs` (`pub use fathom_canon::Json;`, delete the moved items). Run
   `cargo run -p fathom-schemagen`; verify `git status --porcelain` shows **no** change under
   `schema/` — the emitter's bytes moved, they did not change.
2. **The parser.** `parse_canonical` with `ParseError` / `ParseReason` as specified; the
   `canonical.rs` test file, all twelve tests.
3. **`fathom-ir` canon module.** The manifest line, `canon.rs` (`CanonError`,
   `CanonicalValue`, `CanonKey`), and impls for every type in `scalar.rs` and `value.rs` plus the
   rule-1/2/11/12 impls (`bool`, bare integers, `fathom_id` ids, collections). Rule 13's 35 impls
   are uniform by construction — a shared private helper pair over `T: Scalar`, or a local macro,
   is the session's choice; a blanket `impl<T: Scalar> CanonicalValue for T` is **not** available,
   because coherence rejects it against the rule-1/2/11/12 impls. Rule 14 and `value.rs`'s
   rules 6/8/9 are hand-written. Compilation of the dispatch in step 4 is the completeness check;
   this step's impls follow §4.2's table exactly.
4. **Codegen.** Extend `fathom-schemagen` per §4.2: `SCHEMA_VERSION`, generated enum impls,
   `slot_to_canon` / `slot_from_canon`. Run `cargo run -p fathom-schemagen`; commit the
   regenerated `ir_types.rs` and `accessors.rs` (never hand-edited — `78` §5.6); verify
   `schema/generated/schema.json`, `ir_types.ts` and `schema/migrations/manifest.toml` are
   byte-unchanged.
5. **`canon_laws.rs`** — all nine tests.
6. **`fathom-graph` ids.** The `parse` trio, `IdParseError`, and `ids.rs`'s four tests.
7. **`fathom-graph` derives + `to_snapshot`.** The `Op` / `Batch` derive edit, the manifest
   line, `snap.rs` types, `to_snapshot` (including `OpenBatch` refusal).
8. **`from_snapshot`** with the full §4.3 check list.
9. **`snapshot.rs`** — all eight tests.
10. **`fathom-workspace` crate.** Verbatim manifest, members line, constants, header
    writer/parser, the snapshot ↔ JSON mapping as module-private free functions (the orphan
    rule bars trait impls here, and no new public names exist beyond §4.4's list),
    `check_plain_name`.
11. **`plain_face.rs`** — all eleven tests, the pinned vector typed in from §4.4.
12. **Floor.** Run §6's gates in order. Fix only defects in this work order's own new code;
    anything else is §7.
13. **Bookkeeping.** Status line → `DONE`; mirror the `00-INDEX.md` row if the index exists by
    then. Commit per `78` §3.9, push, open the PR listing every gate's output verbatim. Do not
    merge.

## 6. Acceptance gates

Run in this order, locally, before push (`78` §6). Expected results are exact; anything else is
a red gate and §7 applies.

| # | Command | Expected |
|---|---|---|
| G1 | `cargo fmt --all --check` | exit 0, no output |
| G2 | `cargo clippy --all-targets -- -D warnings` | exit 0 |
| G3 | `cargo run -p fathom-schemagen` then `git status --porcelain -- crates/fathom-ir/src/generated schema/generated schema/migrations` | regeneration succeeds; the path-scoped `git status` prints nothing. The unscoped tree is dirty at this step by design — steps 5–11 create files that commit later — so do not widen the path list. (Generated Rust committed in step 4; `schema/generated/schema.json`, `ir_types.ts`, `schema/migrations/manifest.toml` byte-identical to their pre-WO state) |
| G4 | `cargo test -p fathom-canon` | every §4.5 row-1 test listed, all `ok`, `0 failed` — including `parse_emit_identity_on_accepted_vectors`, the strictness law |
| G5 | `cargo test -p fathom-ir` | `canon_laws.rs` suite all `ok`; every pre-existing suite unchanged |
| G6 | `cargo test -p fathom-graph` | `ids.rs` and `snapshot.rs` suites all `ok`; every WO-02 suite unchanged (no test deleted, loosened or ignored — `78` §5.5) |
| G7 | `cargo test -p fathom-workspace` | all eleven `plain_face.rs` tests `ok`. This gate is the work order's three headline proofs: **round-trip byte identity** (`worked_example_round_trips_byte_identical`), **version present and checked** (`face_version_2_refused_by_name`, `schema_version_mismatch_refused_by_name`), and **the plaintext face is labelled as such** (`banner_is_line_two_verbatim`, `missing_banner_refused`, `masquerading_names_refused`) |
| G8 | `cargo test --workspace` | zero failures; every pre-WO test still passes |
| G9 | `cargo run -p fathom-schema --bin fathom-schema-check` | exit 0, `0 failure(s), 2 warning(s)`, both `schema.identity.unexercised` — the pinned baseline, unchanged |

## 7. Stop-and-escalate triggers

The general rule is `78` §4; escalating is success. Specific to this work order, stop and
escalate (procedure per `78` §4) when:

1. **Anything cryptographic is tempting — the headline trigger.** Any step that appears to
   need a hash, a digest, a KDF, an AEAD, a signature, key material, a nonce, a random value,
   or "a quick BLAKE3 for integrity". §2.1 is the record: the primitives are specified (`32`),
   the implementation is deliberately not hand-rolled (`32` §15), the dependency route is
   priced and untaken (`35` §5.2–5.3, `Cargo.toml`), and both routes are closed to this
   session (`78` §5 item 2, §7). There is no integrity field in the plain face **on purpose**
   — a plaintext trailer digest would be theatre, and a keyed one is the sealed format's.
2. Any step appears to need a dependency of any kind (`78` §5 item 2 — *"an escalation,
   always"*).
3. The pinned vector in §4.4 does not match the constructed bytes, or any gate goes red for a
   cause whose fix this document does not state. Quote both sides; do not reconcile them.
4. A slot type at execution time does not match §4.2's wire table — a registry slot type that
   implements no `Scalar` and matches none of rules 1, 2, 6, 8, 9, 10, 11, 12 or 14; a type that
   has *left* the `Scalar` trait since 2026-08-08; a new `BTreeMap` key type beyond `Identifier` /
   `Family`; a second `Scalar` exemption beside `SecretPlaceholder`. The wire table is format;
   only planning changes format. This trigger fired once already and was answered — §10.6 —
   which is why rule 13 delegates to the trait rather than to a shape.
5. `SCHEMA_VERSION` at execution time is not `"0.1"`, or the face needs any version behaviour
   other than exact-match refusal (a migration, a preserve mode, a tolerance). §10.2 owns that
   policy.
6. Any step appears to need the sealed container's machinery: records, shards, envelopes,
   pseudonymous filenames, the packed `FTHMPK` form, a manifest, compression, padding, CBOR.
   All of it is §8's territory and most of it is behind trigger 1.
7. A public name, file, or error variant not listed in §4 is needed; or a cited § contradicts
   this document; or WO-02's merged code diverges from §3.2 in a way that changes a decision
   here (`78` §8 decides correction versus escalation).
8. Any change to the schema checker's two-warning baseline (G9), for any reason.

## 8. Non-goals

1. **No cryptography, no key material, no integrity primitive of any kind.** §1.1, §2.1,
   trigger 1. This includes everything in `32` and every keyed construction in `17` (§6's
   pseudonymous filenames, §4.5's content-addressed captures).
2. **No sealed container.** No records, no fixed shard set, no envelope, no manifest, no
   keyholders, no directory/packed `.fathom` forms, no `FTHMPK` archive, no atomic-write
   protocol (`17` §2–§7, §16.3; ADR-0012, ADR-0013). The plain face is one flat file of the
   whole snapshot precisely because it makes no confidentiality claim to structure around.
3. **No canonical CBOR.** The sealed interior is *"canonical CBOR, RFC 8949 §4.2.1"*
   (`32` §7.5) with the integer field-key registry as its wire (`62` §17.1); building that
   encoder now would pre-commit sealed-format bytes ahead of the crypto decision it is welded
   to. This face uses wire *names*, deliberately: it is the readable face.
4. **No export gate, no export log, no `17` §15.5 header block beyond the warning line.** The
   passphrase re-prompt, the `ExportGate`, the typed reason, the `ExportRecord` (`17` §15.3–
   15.4) all presuppose subsystems (findings, unlock, a clock) that do not exist; the block's
   metadata lines (actor, date, scope, reason) arrive with them. §12.2 records the deviation.
5. **No claim to be `fathom-json`.** `17` §15.2's export format is *"major-stable"*; this face
   refuses on any version difference. Whether it grows into `fathom-json` is §10.3.
6. **No import, no reconciliation** (`17` §14), **no git integration** (`17` §12's attributes,
   textconv, merge flow), **no fsck** (`17` §16), **no compression** (`17` §5.8).
7. **No sync shapes.** No `PresenceRepr`, no op envelope, no HLC, no `FieldClass`
   (`33` §5.1) — the op log serialises exactly WO-02's local `Op`, nothing more.
8. **No suppressions, settings, layout, AI records** — record classes for subsystems that do
   not exist (`17` §4.2's taxonomy stays on paper).
9. **No file I/O.** Bytes in, bytes out; the caller owns paths (`46` §1). `check_plain_name`
   checks a name; it opens nothing.

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **The obedient improviser adds "just a checksum"** — a plaintext digest field that reads as integrity and is not | Trigger 1 names it; PR review against §4.4's key list (`batches`/`edges`/`history`/`nodes`/`provenance`, nothing else) |
| 2 | A second canonical-JSON implementation appears (copy instead of move) and the two drift | Step 1 moves the code and G3 proves schemagen's bytes did not change; C8 (`35` §5.1) is the standing rule |
| 3 | A parser quietly accepts a second spelling (whitespace, `\u0041` for `"A"`, unsorted keys, a Crockford-aliased or lower-case ULID) and byte-identity silently becomes normalisation | `parse_emit_identity_on_accepted_vectors` plus the ten refusal tests; re-render equality on every ULID (rules 4/5/7/11, §4.3, §4.4) with its own refusal tests; the law is stated as the parser's definition, not a property of luck |
| 4 | Wire forms drift when a scalar's representation changes | Largely closed by §10.6's re-cut: rule 13 delegates the wire to `Scalar::canonical()`, so a representation change is invisible to the format while the trait holds. What remains: a type *leaving* the trait, or a new non-`Scalar` registry type. Trigger 4 still governs both; `exemplar_round_trips_per_family` covers all 35 implementors, so a departure fails to compile rather than drifting |
| 5 | `from_snapshot` trusts the file — L0 violations, dangling provenance or denormalised symmetric edges load silently | §4.3's check list, each with a named test (`endpoint_kind_still_refused_on_load`, `dangling_provenance_refused`, `symmetric_not_normalised_refused`) |
| 6 | The pinned vector is "fixed" to match buggy output (golden laundering) | The vector lives in this document, not in a regenerable file; trigger 3 forbids reconciling; `78` §5 item 5 |
| 7 | The plain face masquerades — a `.fathom` name, a stripped banner, a header someone "tidied" | `check_plain_name`, byte-exact banner check on read **and** write, and the three G7 labelling tests |
| 8 | A `u64` slot above `i64::MAX` wraps into JSON and corrupts silently | Rule 2 refuses at write (`IntOutOfRange`); `u64_above_i64_max_refused`. No slot binds a bare `u64` today, so the guard and its test are written **before** the binding that would need them, not after |
| 9 | Serialising with a batch open captures half an intention | `OpenBatch` refusal, `open_batch_refused` |
| 11 | A hand-built value outside its scalar's parse-reachable set writes to a file that then cannot be read (`EncryptionAlgorithm` outside `ENC_TABLE` canonicalises to `""`; a case-unfolded `Fqdn` reads back as a different value) | Rule 13's write-side injectivity check refuses at save, not at load; `non_parse_reachable_scalar_refused_at_write`. The failure is loud and at the moment the user acted |
| 12 | A `SecretPlaceholder` loses its label or hint on a round trip — an emitted `<PSK>` where the field is a TACACS key, and the operator's only note of where the real secret lives, gone silently | Rule 14 carries both; `secret_placeholder_round_trips_label_and_hint`, `secret_placeholder_hint_cap_reenforced_on_read`. Rule 8's `{}` — which would have done exactly this — was retired for this reason (§10.6) |
| 10 | The snapshot iterates a `HashMap` somewhere and byte-identity flakes per process | The snapshot orders are stated per vector in §4.3; `fathom-graph` remains `HashMap`-free (WO-02 §9.2's review rule extends to `snap.rs`); the byte-identity tests fail on any per-process order |

## 10. Open decisions

Deliberately not decided here; owner or planning session only (`78` §7):

1. **The crypto implementation route.** The owner question §2.1 isolates: adopt the `32` §15.1
   crate set as this repository's first external dependencies (an ADR, the `35` §5.3
   `deps/decisions/` files, `cargo-vet`/`cargo-deny` per `35` §5.4–5.5, the first external
   pins in the committed `Cargo.lock`) — or something else the owner prefers. Also travelling
   with it, not separable from it: the `46` §9 Q1 username-in-KDF fork (*"deciding after ship costs a
   `format_version`"*) and `32` §16's vector tree, which is *"part of the format, not part of
   the test suite"*. Until answered, WO-06-and-later work orders that presuppose sealing are
   unwritable.
2. **Schema-version policy for the plain face.** Exact-match refusal is this work order's
   interim rule; the real policy (minor tolerance, `11` §11.4's preserve mode, migrations) is
   format design.
3. **Whether the plain face becomes `17` §15.2's `fathom-json`** — which would oblige
   major-stability and the full §15.3 gate — or stays a dev face and `fathom-json` is a
   separate emitter. The header's `fathom-plain` magic deliberately does not claim the name.
4. **The sealed interior's encoding work** (canonical CBOR per `32` §7.5, integer field keys
   per `62` §17.1's registry row) — gated on decision 1; the `Snapshot` type is designed as
   the shared substrate either way.
5. **Whether `Snapshot` grows the sync op envelope** (`33` §5.1's `OpId`/HLC/actor) when sync
   work begins — already registered as open by WO-02 §10.5.
6. **Whether `CanonError` should carry `ScalarParseError`'s typed reason.** §4.2 rule 13 collapses
   a scalar-parse failure into `NonCanonicalSpelling`, which tells someone hand-editing a
   `.fplain` that a string is wrong but not why — *"IpPrefix: host bits set"* would be more use
   than *"non-canonical spelling"*. Adding a variant is a public name §4 does not list, so it is
   format work, not the executing session's. Registered by §10.6's answer, 2026-08-08.
7. **The product name in this crate's file magic and extension.** ADR-0005 action 2: *"The name
   may not appear in any identifier, file magic, MIME type, ID prefix or on-disk key"*; §4.4 pins
   `PLAIN_MAGIC = "fathom-plain"` and `PLAIN_EXTENSION = "fplain"`. Not blocking — action 2 fires
   *"Before anything is published"* and the same clause is outstanding against `17` §2.1's
   `.fathom`, the `fathom-workspace` crate name and the repository — but it belongs on the
   rename's list rather than being rediscovered per work order. Registered by §10.7's answer,
   2026-08-08.

### 10.6 ESCALATED 2026-08-08 — §4.2's wire table has no family for seven registry slot types, WO-01 having reshaped them

**Step reached.** `78` §3 step 5 — verifying §3's Prior state against the merged tree — before
plan step 1. Nothing in §5's plan was executed; no code was written (`78` §4 step 1, §5 item 10).

**What this work order says.** §3.1, on the tree it was authored against:

> Stub scalar types in `scalar.rs` (newtypes over integers, `String`, `core::net` types; structs
> `IpPrefix`, `InterfaceAddress`, `IpRange`, `PortRange`, `RouteDistinguisher`, `RouteTarget`,
> `Date`, `LatLon`; unit `SecretPlaceholder`)

§4.2's structural rule, which decides family membership:

> Family membership is **structural**, decided by the type's shape in `scalar.rs` / `value.rs`,
> not by its name: a field-less unit struct is rule 8; a multi-field struct is rule 6 unless
> rules 5 or 7 name it; a hand-written enum is rule 9; a newtype over an integer is rule 2 and
> over `String` is rule 3.

and the four rows that name the affected types — rule 2 (*"every newtype over one (`L4Port`, …,
`IkeVersion`, …)"*), rule 3 (*"Newtypes over `String` (`Identifier`, `Text`, `Fqdn`,
`EncryptionAlgorithm`, `IntegrityAlgorithm`, `AuthMethod`, …)"*), rule 6 (*"Multi-field structs
(`IpRange`, `PortRange`, `RouteDistinguisher`, `RouteTarget`, `Date`, `LatLon`, `Mtu`,
`PostalAddress`, `NameConformance`, `QualifiedNextHop`, `NodePriority`, `EndpointCardinality` —
all twelve …)"*), rule 8 (*"Unit stubs — every field-less struct in `scalar.rs` / `value.rs`:
`SecretPlaceholder`, `IkeId`, … (all sixteen)"* → wire form *"`Obj` empty, `{}`"*). Rule 9 is
scoped shut: *"Hand-written enums in `value.rs` (`PeerSpec`, `AttrValue`, `NextHop`, `SyslogHost`
— all four at slot level …)"*.

**What was found.** WO-01 landed (`c07d1bc`, *"Build the Scalar trait and the 35 real scalar
implementations in fathom-ir"*), which §Depends anticipated: *"if it lands first the slot types at
`fathom_ir::scalar` / `fathom_ir::value` change shape underneath §4.2's wire table — §7 trigger 4
governs that case."* Seven **registry slot types** (each confirmed present in
`crates/fathom-ir/src/generated/accessors.rs`) now have a shape no family admits:

| Type | §4.2 row that names it | Shape in the tree today |
|---|---|---|
| `EncryptionAlgorithm` | rule 3, newtype over `String` | `scalar.rs:188` — `struct { family: EncFamily, key_bits: Option<u16>, mode: EncMode, aead: bool }` |
| `IntegrityAlgorithm` | rule 3, newtype over `String` | `scalar.rs:200` — 5-variant field-less enum |
| `AuthMethod` | rule 3, newtype over `String` | `scalar.rs:211` — 3-variant field-less enum |
| `IkeVersion` | rule 2, newtype over an integer | `scalar.rs:219` — 3-variant field-less enum |
| `RouteDistinguisher` | rule 6, multi-field struct, *"all twelve"* | `scalar.rs:266` — `enum { Type0 { admin: u16, assigned: u32 }, Type1 { admin: net::Ipv4Addr, assigned: u16 } }` |
| `RouteTarget` | rule 6, multi-field struct, *"all twelve"* | `scalar.rs:424` — the same two variants |
| `SecretPlaceholder` | rule 8, field-less, *"all sixteen"*, wire `{}` | `scalar.rs:330` — `struct { label: SecretLabel, hint: Option<SecretHint> }`, **both fields private** |

Structurally, the four enums fall to rule 9, whose parenthetical carries no `…` and so *"enumerates
today's members in full"* — and is scoped to `value.rs`. `EncryptionAlgorithm` falls to rule 6,
whose parenthetical is likewise closed at *"all twelve"*. `SecretPlaceholder` matches no family: it
is neither field-less (rule 8) nor readable by field ident (rule 6 — the fields are private; the
public surface is `new` / `with_hint` / `label()` / `hint()`, `scalar.rs:335-364`).

Four further types are now reachable from the registry through those slots and have no row at all:
`EncFamily` (`scalar.rs:170`), `EncMode` (`scalar.rs:178`), `SecretLabel` (`scalar.rs:273`) and
`SecretHint` (`scalar.rs:300`, private `String`).

Executing rule 8 as written on today's `SecretPlaceholder` would emit `{}` and drop `label` and
`hint` on every round trip — silent loss that §4.5's own law (`from_canon(to_canon(v)?)? == v`)
would fail. That is a defect the table cannot be implemented around.

**What did not diverge**, checked in the same pass so the re-cut has a floor: the two `BTreeMap`
key types are still exactly `ir_types::Family` and `scalar::Identifier` (grep of `accessors.rs`);
`FIELD_KEYS` is still 299, `NodeKind::ALL` 48, `EdgeKind::ALL` 81; `schema/schema.yaml` still
declares `version: "0.1"` and no `SCHEMA_VERSION` is generated yet; `value.rs` matches §4.2 rows 6,
8 and 9 unchanged; `MacAddress` (rule 7), `Timestamp` (rule 2), `IpPrefix` / `InterfaceAddress`
(rule 5) are unchanged; WO-02's API matches §3.2 (`insert_node(kind, ulid, existence)`,
`Op` / `Batch` deriving bare `Debug`).

**Why this is not a `78` §8 correction.** §4.2 states its own status — *"These rules are format, not
implementation; the execution session implements them and may not vary them"* — and §7 trigger 4
repeats it: *"The wire table is format; only planning changes format."* §8 admits a correction only
where it *"changes no decision the work order makes"*; assigning a wire form and a parse rule to
seven slot types is deciding format.

**The smallest decision that unblocks.** Re-cut §4.2's table over the post-WO-01 `scalar.rs`: a wire
form and parse rule for `EncryptionAlgorithm`, `IntegrityAlgorithm`, `AuthMethod`, `IkeVersion`,
`RouteDistinguisher`, `RouteTarget` and `SecretPlaceholder`, plus the four reachable types above;
and whether rule 9's scope extends from `value.rs` to hand-written enums in `scalar.rs`.
`SecretPlaceholder` needs its own sentence: it is the invariant-3 marker, `{}` no longer
round-trips it, and what a redaction marker may put on a plaintext wire is a security question, not
a shape question. §4.5's `exemplar_round_trips_per_family` row count moves with the answer.

**ANSWER (2026-08-08, planning). Not the narrow patch — the table is re-cut against the trait.**
The escalation offers the smallest decision: add rows for seven types and extend rule 9's scope
from `value.rs` to `scalar.rs`. That was declined, on the evidence the escalation itself gathered.
Seven types moved between families in one work order, and the escalation's own list of what did
*not* diverge shows why: every one of the seven still round-trips through `Scalar::parse` and
`Scalar::canonical()`, because that is what WO-01 built. **The shapes moved; the canonical text did
not.** A table cut against shapes will keep tripping trigger 4 every time a representation is
refined, and each trip costs a stopped work order.

So §4.2 now decides membership **by trait first, shape second**:

| | |
|---|---|
| **New rule 13** | Every `fathom_ir::scalar::Scalar` implementor — all 35 — wires as `Str` of `canonical()`, parsed by `Scalar::parse` with re-render equality, **plus a required write-side injectivity check** |
| **New rule 14** | `SecretPlaceholder`, the one registered `Scalar` exemption, gets the one hand-authored wire form: `{"label":…}` with `"hint"` present iff set |
| **Rules 3, 4, 5, 7** | Retired — every type they named implements `Scalar`. Numbers left vacant, never reused, so existing citations keep their meaning |
| **Rule 2** | Narrows to **bare** primitive integers; every integer newtype is rule 13. `accessors.rs` binds no bare `u64` / `i64` / `i32` slot (grep, 2026-08-08), so `u64_above_i64_max_refused` is retargeted at `CanonicalValue for u64` directly and the guard now lands ahead of the first binding rather than behind it |
| **Rule 6** | Narrows from twelve to the six `value.rs` structs; `IpRange`, `PortRange`, `RouteDistinguisher`, `RouteTarget`, `Date`, `LatLon` are rule 13 |
| **Rule 8** | Narrows from sixteen to fifteen, all in `value.rs` (`SecretPlaceholder` leaves for rule 14). Verified: `value.rs` holds exactly fifteen field-less structs |
| **Rule 9** | **Scope not extended.** The escalation's explicit question — does rule 9 reach `scalar.rs`? — is answered *no*: the four `scalar.rs` enums are `Scalar` implementors and take rule 13. Rule 9 stays the four `value.rs` enums |
| **`EncFamily`, `EncMode`, `SecretLabel`, `SecretHint`** | No row. None is a registry slot type (zero occurrences each in `accessors.rs`, 2026-08-08); they reach the wire only inside rules 13 and 14 |

**The three things this answer decides that the narrow patch would not have.**

1. **The write-side injectivity check** (§4.2, rule 13's DECISION paragraph). WO-01 §9 row 1
   records that the laws hold over parse-reachable values only, and `scalar.rs` shows the cost on
   a wire: `EncryptionAlgorithm::canonical()` returns `""` for any value outside `ENC_TABLE`, and
   `Fqdn::parse` case-folds. Without the check, `write_plain` succeeds and `read_plain` fails on
   the same bytes — a file the user believes they saved. The check moves that failure to the save.
2. **`SecretPlaceholder` carries `label` and `hint`.** Rule 8's `{}` is not implementable —
   the type's only constructors take a label, so `from_canon` would have to invent one. The cost
   of inventing: `placeholder()` renders `'<' + label.token() + '>'`, so a reloaded `TacacsKey`
   placeholder emits `<PSK>` into a TACACS field, which is wrong configuration text handed to an
   operator to paste into a device; invariant 9's byte-identical-emit guarantee breaks across a
   save/load boundary; and the hint — the operator's own note of where the real secret lives — is
   destroyed silently. The slot is real and singular: `IkePolicy.pre_shared_key`, field key 155.
   The security half is argued in §4.2 rather than asserted: invariant 3 is not engaged (the type
   holds no credential by construction, and the read path reconstructs only through `new` /
   `with_hint`), the label is a category already emitted as `<PSK>`, and the hint is user text
   whose exposure on this face is total *by declaration* — which is what line 2 says in capitals.
3. **The `label` wire tokens are pinned here, not taken from `SecretLabel::token()`.** `token()`
   is the emit rendering and four of its five values carry a live `VERIFY` in `scalar.rs`. A
   stored format welded to a string expected to change would make every existing file unreadable
   the day that VERIFY resolves.

**Deliberately not decided.** Whether the ingest gate or the plain face should try to *detect* a
secret typed into a hint. There is no such mechanism anywhere in the corpus, it is a heuristic, and
inventing one inside a wire table is how a false negative acquires a reassuring name. Also not
decided: whether `CanonError` should grow a variant carrying `ScalarParseError`'s typed reason
instead of collapsing scalar-parse failures into `NonCanonicalSpelling`. It would read better for
someone hand-editing a `.fplain`, and it costs a public name §4 does not list; §7 trigger 7 is
left untripped and the diagnostic question is registered at §10 item 6.

**What this means for execution.** §4.2, §4.5's `canon_laws.rs` row, §5 step 3, §7 trigger 4 and
§9 rows 4, 8, 11 and 12 have been edited in place — there is one specification, not a table plus a
correction (`.context/conventions.md` § *Precedence*). Read §4.2 as it now stands. §3.1's
`fathom-ir` bullet carries a superseded-marker for `scalar.rs` and is otherwise re-verified.

**This escalation is resolved.** It does not by itself make WO-05 executable — see §10.7.

### 10.7 ESCALATED 2026-08-08 — §4.4's pinned vector renders ids with a `fathom:` prefix the tree, the conventions and ADR-0005 all refuse

**Step reached.** The same `78` §3 step 5 pass; nothing executed.

**What this work order says.** §4.4's pinned first vector, line 5, twice:

> `{"add_node":{"node":"fathom:device:00000000000000000000000001", …`
> `"nodes":[{"existence":…,"fields":{},"id":"fathom:device:00000000000000000000000001"}]`

and §4.5's `parse_refuses_noncanonical_ulid_spelling`, whose two inputs are
`"fathom:device:0000000000000000000000000I"` and `"fathom:device:o0000000000000000000000001"`;
and §4.3's prose, *"a decode-only `parse` would accept `fathom:device:0o000…`"*.

The same document states the opposite rule three times: §3.2 quotes WO-02's contract as *"`Display`
rendering `<kind-lower>:<ulid>` (kebab-case kind, 26-char ULID; no product-name prefix —
ADR-0005)"*; §4.3 says *"`parse` inverts `Display` exactly"*; §4.4 says *"composite ids as their
`Display` form"*. §2's Binding sources cites `.context/conventions.md` § *Identifiers* for
*"Node IDs: `<kind-lower>:<ulid>`"* and *"(ADR-0005: no product name in any identifier)"*.

**What was found.** `crates/fathom-graph/src/id.rs:75`:

```rust
impl fmt::Display for NodeId {
    /// `.context/conventions.md` § *Identifiers*: `<kind-lower>:<ulid>`, with
    /// no product-name prefix (ADR-0005 action 1).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", kebab(self.kind.name()), self.ulid)
    }
}
```

which renders `device:00000000000000000000000001`. WO-02's own test pins it —
`id.rs:107` `ike_gateway_renders_kebab` asserts `assert!(!rendered.contains("fathom"))` under the
comment *"ADR-0005 action 1: the product name is in no identifier."*

So `write_plain` on §4.4's stated construction cannot produce §4.4's stated bytes, and the two id
strings in §4.5's refusal test are unparseable by §4.3's `parse` for a reason that is not the
reason the test names.

**Why this is not a `78` §8 correction.** §4.4 forecloses it in terms: *"If the constructed bytes
differ from it, the session does not adjust either side to match: it escalates under §7, quoting
both, because one of the two — the code or this document — is wrong, and deciding which is planning
work."* §7 trigger 3 says the same.

**The smallest decision that unblocks.** Re-issue §4.4's pinned line 5 and §4.5's two
`parse_refuses_noncanonical_ulid_spelling` inputs against the rendering the tree emits — or, if the
`fathom:` segment is intended, reopen ADR-0005, which is owner work (`78` §5 item 4).

**ANSWER (2026-08-08, planning). Re-issue against the tree. ADR-0005 is not reopened.**
There is no fork here worth the owner's time. ADR-0005 is Accepted, its action 1 is *"Now, before
`fathom-id`'s first commit: decouple the identifier namespace from the product name … node IDs
change to `<kind-lower>:<ulid>`"*, it has been executed into `.context/conventions.md`
§ *Identifiers*, into `fathom-graph`'s `Display` (`id.rs:75`, with the ADR cited in the doc
comment) and into a test that asserts the absence literally (`id.rs:107`,
`assert!(!rendered.contains("fathom"))`). Three independent sites agree and one document — this
one — disagreed with itself in four places while quoting the correct rule in three others. That is
a transcription defect, not a design question, and reopening a decision on merit (`75` §2) needs a
merit argument that nobody has made.

**The corrected vector.** §4.4's line 5 now reads with `device:00000000000000000000000001` at both
occurrences, and §4.5's two refusal inputs are `"device:0000000000000000000000000I"` and
`"device:o0000000000000000000000001"` — both still 26 characters after the colon, both still
decoding under `Ulid::decode`'s Crockford aliases (`I`→1, `o`→0) to the same value as
`00000000000000000000000001`, and both therefore still refusing `NonCanonicalUlid` on re-render
equality, which is what that test exists to prove. Under the old inputs they would have refused
`Shape` on the unknown kind segment and proved nothing about the ULID at all. §4.3's prose example
is corrected in the same pass.

**The correction is scoped, and trigger 3 still stands.** Only the id renderings were wrong and
only they were changed. Every other byte of the pinned vector is still this document's claim about
code that has never been run, and §4.4's own rule — *"the session does not adjust either side to
match: it escalates"* — applies to the rest of it unchanged. A mismatch elsewhere is a new
escalation. That is why the re-issue is marked inline at §4.4 rather than silently applied.

**A separate finding, raised here because it was found here, and deliberately not decided.**
ADR-0005's action 2 also states *"The name may not appear in any identifier, file magic, MIME type,
ID prefix or on-disk key"*, and §4.4 pins `PLAIN_MAGIC = "fathom-plain"` and
`PLAIN_EXTENSION = "fplain"` — a file magic and an on-disk name carrying the product name. This is
**not** treated as blocking, for a reason on the ADR's own face: action 2 fires *"Before anything
is published"*, nothing is published, and the same clause is outstanding against `17` §2.1's
`.fathom` container, the `fathom-workspace` crate name and the repository itself. The plain face's
magic is not a new violation; it joins the rename's scope, where the whole clause is settled at
once. Registered at §10 item 7 so it is not rediscovered a third time.

**This escalation is resolved.**

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants; terminology (workspace = encrypted, record ≠ graph element); the id form; document conventions |
| `CLAUDE.md`; `docs/70-ops/78-execution-protocol.md` (whole) | Session rules; inherited constraints (§2); the never-list (§5); judgment-shaped classification (§7); WO shape (§8) |
| `docs/10-core/17-workspace-format.md` (whole) | Container forms and names; §2.2's version rationale; §4's record taxonomy (as non-goal); §6 filenames (as non-goal); §12.2's sealed extensions; §15's plaintext export kinds, gate and header; §16.3 atomic writes (as non-goal) |
| `docs/30-security/32-cryptography.md` §§1–5, 7, 13–16, 18, 21 | The decided primitives; §7.1's magic and header; §7.5's canonical-CBOR interior; §13.4's unchanged-plaintext rule (context for the sealed future); §15's not-hand-rolled table and audit honesty; §16's vectors-are-format |
| `docs/30-security/35-supply-chain-and-builds.md` §§1–6 | C1–C8; §5.2's publisher table, cap-100 sentence, and "no code yet" VERIFY; §5.3's questionnaire; §5.8's escape options |
| `docs/40-stack/46-workspace-persistence-and-identity.md` §§1, 5 | User-chosen path, never a default; the username as typed, stored-nowhere KDF context (travels with §10.1) |
| `docs/60-content/62-schema-spec.md` §§3, 17 | The plain-primitive row; the canonical JSON contract; the field-key registry; generated-files-checked-in |
| `docs/30-security/33-sync-protocol.md` §5.1 (the op vocabulary, read at the quoted lines) | `PresenceRepr` / `FieldClass` as the deliberately-absent sync shapes |
| `docs/90-decisions/adr-0012-…`, `adr-0013-…` §Context, §Decision | The ownership split; fixed shards, whole-record rewrite, committed manifest; the ADR title index (no dependency-adoption ADR exists) |
| `docs/70-ops/79-work-orders/WO-01-…` (head), `WO-02-…` (whole), `WO-03-…` (head) | The queue's status conventions; WO-02's complete contract (§3.2 here); WO-02 §8.1 assigning serialisation to this work order |
| `crates/fathom-schemagen/src/json.rs` (whole); `crates/fathom-schemagen/Cargo.toml`; `crates/fathom-schema/Cargo.toml` | The emitter moved in §4.1; current dependency edges |
| `crates/fathom-id/src/lib.rs`; `crates/fathom-ir/src/{lib,scalar,value}.rs`; `crates/fathom-ir/src/generated/{ir_types,accessors}.rs` (at the cited items); `crates/fathom-schemagen/src/extract.rs` (version handling); `schema/schema.yaml` (line 7) | Every §3.1 claim, read or grepped at the stated items; the kind-name disjointness check (mechanical, 2026-08-02) |
| Root `Cargo.toml`; `Cargo.lock`; `rust-toolchain.toml` | The zero-dependency comment, verbatim and in full; the committed lock (`version = 4`, six workspace-only entries); the 1.94.1 pin |
| `cargo test --workspace`; `fathom-schema-check` (run 2026-08-02) | 80 tests, zero failures; exit 0, `0 failure(s), 2 warning(s)` |

## 12. Disagreements

1. **The crate is named `fathom-workspace` and ships nothing that is a workspace.** The
   conventions define a workspace as *"one encrypted document"*, and this work order's output
   is deliberately not encrypted. The name is kept because the crate is `17`'s implementation
   home and the sealed format will land in it; the discipline is enforced elsewhere: no
   user-facing string, constant, file name or doc sentence in the crate calls the plain face a
   workspace — it is "the plaintext dev face" throughout, and the banner line says what it is.
   If a reviewer finds the name itself misleading, the rename is mechanical and is planning
   work.
2. **`17` §15.5 requires a header block this face cannot honestly fill.** *"Every plaintext
   export begins with the same block"* — workspace name, export id, actor, wall-clock time,
   scope, reason, corpus pin. Every one of those fields either does not exist yet (export ids,
   actors, the gate) or is forbidden here (a render-time clock, invariant 9). The face carries
   the block's one load-bearing sentence — the warning — plus the two version lines, and the
   full block belongs to the export path when the subsystems it describes exist. This is a
   stated deviation from `17` §15.5 as written, not a silent one.
3. **The parser refuses a variant the shared emitter can produce.** `fathom-canon`'s `Json`
   keeps `Float` (schemagen's `schema.json` needs it, in one place, emit-only), while
   `parse_canonical` refuses floats outright. An asymmetric contract in one crate is untidy;
   the alternatives — two `Json` types (C8 violation by another name) or float acceptance in a
   face whose IR is float-free by construction — are both worse. The depth cap is the second,
   bounded asymmetry: the emitter recurses without a limit, the parser refuses beyond 512
   (`DepthExceeded`) — refusing on read what could in principle be emitted is the safe
   direction for a hand-editable file. Both asymmetries are documented at both sites in code.
4. **The corpus's version examples do not match the tree.** `17` §3.1 and `32` §7.6 show
   `schema 3.2`; the tree declares `version: "0.1"` (`schema/schema.yaml` line 7, whose own
   comment flags the discrepancy against `62`'s examples). This work order emits and checks the
   tree's declared version and treats the prose numbers as illustrations; if they were ever
   load-bearing, ADR-0008 says the tree wins.
5. **Corrections on re-verification (2026-08-02), each contradicting this document's earlier
   draft.** (a) The draft claimed the repository *"does not yet have"* a `Cargo.lock`; the tree
   has a committed lock (`version = 4`, six workspace-only entries), and §2.1 / §10.1 now name
   what is actually missing — the first external pins and the vet policy, not the file. The
   same passage claimed the root `Cargo.toml` comment was quoted "in full" while truncating it;
   the full comment now stands. (b) Rule 11 as drafted said only *"`Ulid::decode`, refuse on
   error"*; `Ulid::decode` is deliberately Crockford-lenient (case-insensitive, I/L→1, O→0), so
   the rule as written accepted several spellings per id — contradicting the one-spelling law
   this document states — and now requires re-render equality (§4.2 rule 11, §4.3, §4.4), with
   refusal tests in `canon_laws.rs`, `ids.rs` and `plain_face.rs`. (c) Rows 6 and 8 of the wire
   table read as closed lists while seventeen registry slot types had no named row — which
   would have tripped trigger 4 on day one; membership is now structural and those rows
   enumerate every current member. §3.1's accessor sentence likewise omitted the 56
   bare-primitive slots and the `LearnedRoute.via` `fathom_id::NodeId` slot; it now counts
   them.
6. **Corrections on execution (2026-08-08), recorded under `78` §8.** (a) §4.1 places
   `crates/fathom-workspace` in the root members list *"one line after
   `"crates/fathom-schemagen"`"*. That instruction was written against the six-member list of
   2026-08-02; the list now holds twelve members in alphabetical order, and `fathom-workspace`
   sorts after `fathom-wasm`. The line was appended at the end of the list, which is that
   position. The member set is identical either way, so no decision moves. (b) §4.3 requires
   `from_snapshot` to surface *"the same violation the write path would name"* while leaving the
   mechanism to the session. Rather than write a second copy of the ladder, `insert_edge`'s L0
   sequence was lifted verbatim into a module-private `Graph::check_edge_l0`, which both the write
   path and the load path now call; `Graph`'s fields, `Node`/`Edge`'s slot maps and `Slot` became
   `pub(crate)` so `snap.rs` can build a store without a second write API. Every item is
   module-private (§4: *"Module-private items are the execution session's to name"*), no public
   name changed, and WO-02's full suite still passes unedited.
