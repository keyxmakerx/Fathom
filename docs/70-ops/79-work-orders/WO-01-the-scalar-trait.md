# WO-01 — The `Scalar` trait and the real scalar implementations

> **Status:** OPEN

Depends on: nothing in the queue. Everything §3 describes is merged on `main`.
`docs/70-ops/79-work-orders/00-INDEX.md` may not exist when this order is taken; §3's closing
bullet, §4's scoping, §5 step 7 and §12 item 6 handle the gap — it is not a dependency and not
this session's to fix.

Execution protocol: `docs/70-ops/78-execution-protocol.md` governs this work order. Every
constraint in `78` §2 is inherited and not restated here; `78` §4's escalation rule applies to
every trigger in §7 below. Severity labels in any verification context are exactly
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

When this work order is done, `crates/fathom-ir/src/scalar.rs` is no longer a stub file: a
`Scalar` trait exists (the canonical half of `11` §4.2's contract — parse from canonical text,
render to canonical text, with the round-trip and agreement laws pinned by tests), and 35 of the
36 `fathom_ir::scalar::*` binding targets implement it with real validation
(`SecretPlaceholder` is the one registered exemption, `11` §4.5). The trait-conformance half of
gate `schema.scalar.unbound` (`62` §18.1: *"`scalars:` names an `impl` that does not exist or
lacks the trait"*) becomes checkable and checked, by a weld test that reads the schema tree back
and refuses any binding this work order does not classify. The 25 `structured: true` bindings in
`fathom_ir::value` are untouched — a structured value type owes no vendor round-trip
(`62` §3.1 row 3) and its canonical serialisation and total order land with the store, not here.
The generated code does not change by one byte.

## 2. Binding sources

| Source | What it binds | The line that binds |
|---|---|---|
| `11` §4.1 | Why scalars exist at all | *"No field in this schema has type `String` unless the thing it holds is genuinely free prose"* |
| `11` §4.2 | The trait's contract and laws (this WO ships the canonical half; §12 item 1 records the split) | L3: *"`a.canonical() == b.canonical()` iff `a == b`"* |
| `11` §4.3 | The catalogue: representation, canonical form and traps, row for row | `IpPrefix`: *"Setting host bits is a parse error"* |
| `11` §4.5 | `SecretPlaceholder` never parses from text | *"There is no `SecretPlaceholder::from_value`."* |
| `11` §4.6 | `InterfaceName`: raw is stored and wins; the parsed lens is deferred (§8) | *"`raw` wins on emit … Byte-for-byte, always."* |
| `11` §4.7 | `OsVersion`: per-family comparison is deferred (§8, §12 item 3) | *"Comparing two `OsVersion`s from different families is a compile-time-impossible operation"* |
| `62` §3.1 | Three type families; structured types owe no L1/L2 laws | *"no vendor `parse`/`emit` obligation"* |
| `62` §3.2 | The binding declaration; per-field range constraints live in the schema, not the type | *"Codegen fails if a bound `impl` path does not exist or does not implement the required trait (§18, `schema.scalar.unbound`)"* |
| `62` §3.3 | `Date`, `LatLon`, `Clli` definitions, with their own VERIFY on Clli lengths | `Date`: *"Never compared against a clock at render"* |
| `62` §3.4 | `Bandwidth`, `TzName`, `PlatformId`, `InferenceRuleId`, `RouteTarget` definitions | `RouteTarget`: *"parse accepts the `target:` prefix and strips it"* |
| `62` §13.3 | The `AttrType` weld: the seven scalar shapes `AttrValue` embeds are frozen; no floats anywhere | *"`Decimal` does not exist and may not be added"* |
| `62` §18.1 | The gate this WO completes | *"`scalars:` names an `impl` that does not exist or lacks the trait"* |
| `78` §2 | Everything inherited: invariants 1–3 and 9, zero dependencies, pinned 1.94.1 toolchain, `forbid(unsafe_code)`, the risk enum, severity labels, house style | (whole table) |
| `.context/field-card-srx-ipsec.txt` side 1 | Accepting fixtures that are real vendor lines | `encryption-algorithm aes-256-gcm`; `authentication-method pre-shared-keys`; `address 10.255.0.1/30` |

## 3. Prior state

All verified against the working tree at authoring time (2026-08-02; `cargo test` 80 passed,
0 failed; `fathom-schema-check` exit 0, `0 failure(s), 2 warning(s)`).

- `crates/fathom-ir/src/scalar.rs` (216 lines) declares 36 stub types, header: *"**These are
  stubs.** The `Scalar` trait (11 §4.2 …) does not exist yet; no type here parses or emits
  anything."* No trait, no parsing, no tests.
- `crates/fathom-ir/src/value.rs` declares the 25 structured stubs plus the welded
  `AttrType`/`AttrValue` pair — `AttrValue::attr_type` is an exhaustive `const fn` match, and
  `AttrValue`'s variants embed exactly seven scalar types: `Text`, `Bandwidth`, `VlanId`,
  `IpPrefix`, `InterfaceAddress`, `Identifier`, `Date`.
- `schema/schema.yaml` `scalars:` block: 61 rows — 36 bound to `fathom_ir::scalar::*`, 25 to
  `fathom_ir::value::*` with `structured: true` (`fathom-schema-check` prints `61 scalars`).
- Generated code references the bindings **by path only**: `crates/fathom-ir/src/generated/ir_types.rs`
  has `fn scalar_bindings_resolve()` (a `#[allow(dead_code)]` inventory of
  `core::mem::size_of::<crate::scalar::…>()` calls), and `generated/accessors.rs` uses the types
  as accessor return types. **A type's shape can change freely; its path and name cannot.**
  `crates/fathom-schemagen/src/rust_gen.rs` emits those paths from the `scalars:` rows and is not
  touched by this WO.
- `crates/fathom-ir/tests/generated_contract.rs` (7 tests) constructs `Text("…".to_owned())` and
  `TzName("…".to_owned())` — both shapes are kept by §4.2.
- `crates/fathom-schemagen/tests/`: `attrtype_drift.rs` (1 test, reads
  `fathom_ir::value::AttrType`), `determinism.rs` (8 tests: `schema.codegen.stale` /
  `schema.codegen.nondeterministic` as cargo tests).
- `crates/fathom-schema/src/model.rs`: `SchemaTree::load(root)` exposes
  `pub scalars: Vec<ScalarDecl>` where `ScalarDecl { pub name: String, pub line: usize }` — name
  only, no `structured` flag (a limitation §9 row 4 records).
- `crates/fathom-schema/src/bin/fathom-schema-check.rs`, `CHECKED_ELSEWHERE`: the
  `schema.scalar.unbound` entry currently reads *"… (trait conformance waits on the Scalar
  trait; …)"* — §4.6 gives its replacement.
- `crates/fathom-ir/Cargo.toml`: dependencies are `fathom-id` only; no `[dev-dependencies]`.
- Determinism worked examples this WO must match in kind: `crates/fathom-id/src/lib.rs`
  (*"There is deliberately no `new()` that reads a clock or an RNG"*),
  `crates/fathom-corpus/src/detln.rs` (the atanh-series `ln`).
- `docs/70-ops/79-work-orders/` holds the eight work-order files and `00-INDEX.md` — the first
  index shipped in the same planning PR that landed this queue, conforming to `78` §8's format
  as `78` §3 step 2's own `<!-- VERIFY -->` required. Maintaining the index is planning's work
  (`78` §8); this session only mirrors its own row. §5 step 7 conditions the index edit on the
  index existing (WO-02 §3 and its bookkeeping step carry the same handling — written when the
  index had not yet shipped, kept as the safe form), and §12 item 6 records the strain against
  `78` §3/§4 as literally read.

## 4. Deliverables

Exactly these files change **in the code tree the gates check**: no other code file, no file
under `schema/`, nothing under `crates/fathom-ir/src/generated/`. Outside this closure sit only
`78` §3 step 8's bookkeeping edits, which ride the same commit and are not deliverables: this
file's own status line to `DONE`, and the matching `00-INDEX.md` row (§5 step 7).

| File | Change |
|---|---|
| `crates/fathom-ir/src/scalar.rs` | Rewritten: trait + error + 35 implementations (§4.1–§4.4) |
| `crates/fathom-ir/tests/scalar_contract.rs` | New: the law harness, the weld test, the fixtures (§4.5) |
| `crates/fathom-ir/Cargo.toml` | Adds the dev-dependency, verbatim (§4.6) |
| `Cargo.lock` | The hunk cargo generates for that edit; it rides the same commit (`78` §5 item 7's manifest exception). CI runs `--locked`, which fails on a stale lockfile |
| `crates/fathom-ir/src/lib.rs` | Module-doc bullet replaced, verbatim (§4.6) |
| `crates/fathom-schema/src/bin/fathom-schema-check.rs` | One `CHECKED_ELSEWHERE` string replaced, verbatim (§4.6) |

### 4.1 The trait and its error — verbatim

Placed at the top of `scalar.rs`. These are the only new public items besides the ones §4.2
row 15 (the five `DhGroup` consts), §4.3 and §4.4 list; a step that seems to need another
public name is a §7 trigger.

```rust
/// 11 §4.2's round-trip contract, canonical half. `parse` is the
/// platform-independent direction; the per-platform methods — parse over a
/// platform's token table, `emit(plat)`, `validate(ctx)` — land with the
/// platform registry and the emitters (WO-01 §8), normalising into this core.
pub trait Scalar: Sized + Clone + Eq + Ord {
    /// The scalar's schema name, exactly as `schema/schema.yaml` spells it.
    const NAME: &'static str;

    /// Canonical text -> value. Accepts the canonical grammar (plus the
    /// row's listed alternates) in WO-01 §4.2; refuses everything else with
    /// a typed reason. Deterministic: no clock, no RNG, no locale.
    fn parse(text: &str) -> Result<Self, ScalarParseError>;

    /// Value -> canonical text — 11 §4.2's `canonical()`: the platform-
    /// independent form used for equality across platforms, for diffing,
    /// and for the deterministic ordering in invariant 9.
    fn canonical(&self) -> String;
}

/// Why canonical text failed to parse. Carries no copy of the input — the
/// caller has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ScalarParseError {
    /// `Scalar::NAME` of the refusing type.
    pub scalar: &'static str,
    pub kind: ScalarParseErrorKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScalarParseErrorKind {
    /// The text does not match the scalar's grammar; `expected` names the
    /// grammar in one static phrase.
    Syntax { expected: &'static str },
    /// The grammar matched but a component is outside its permitted range;
    /// `what` names the component. Bounds live in WO-01 §4.2's table and in
    /// the type's doc comment, not in the error.
    Range { what: &'static str },
    /// A charset-validated scalar met a byte outside its set, at this byte
    /// offset.
    Charset { offset: usize },
    /// A prefix carried set host bits — 11 §4.3: "Setting host bits is a
    /// parse error". `IpPrefix` only.
    HostBits,
}
```

**The laws, pinned by §4.5's harness.** Quantified over parse-reachable values — representation
fields stay public (the stubs' precedent, kept so nothing that types against them churns), so
unvalidated construction is possible and outside the laws; §9 row 1 records the hole.

| Law | Statement |
|---|---|
| **L1c — canonical round-trip** | For every `x` obtained from `parse`: `S::parse(&x.canonical()) == Ok(x)` |
| **L3 — canonical agreement** | `a.canonical() == b.canonical()` iff `a == b` (`11` §4.2, quoted in §2) |

`11` §4.2's L1/L2 quantify over platforms and token tables; they become dischargeable when
`emit(plat)` lands (§8) and are not claimed here.

**The numeric grammar, stated once and used by every numeric row below.** Unsigned: one or more
ASCII digits, no sign, no leading zero unless the value is exactly `0`. Signed: optional leading
`-` then the unsigned grammar; `-0` is refused (`Syntax`) so canonical stays injective. Render:
Rust's integer `Display`, which is locale-independent. There are no floating-point values
anywhere in this module — floats are structurally excluded (`62` §13.3).

**Determinism.** No constructor or method reads a clock, an RNG, an environment variable or a
locale (invariant 9 via `78` §2). `Timestamp` and `Date` render by pure integer arithmetic
(§4.2's algorithm). IPv4/IPv6 text handling delegates to `core::net`'s `FromStr`/`Display`
(already imported by `scalar.rs`); their exact behaviour on the pinned 1.94.1 toolchain is
pinned into §4.5's fixtures, so a toolchain change that shifts it turns a gate red instead of
drifting silently.

### 4.2 The catalogue — all 61 bindings, decided

Part A: the 36 `fathom_ir::scalar::*` bindings. "Repr" is the representation **after** this WO;
rows marked ⇧ change shape from the stub (§5 step 2 lists the changes as edits). Every decision
carries its source; decisions the corpus does not fully determine are marked **DECISION** and
argued in one line.

| # | Scalar | Repr after this WO | `parse` accepts (canonical grammar + alternates) | Validation on parse | Canonical render | Source |
|---|---|---|---|---|---|---|
| 1 | `Ip4Addr` | `net::Ipv4Addr` newtype (kept) | dotted-quad via `core::net` `FromStr` | four octets 0–255; leading zeros refused (toolchain behaviour, pinned by fixture) | `core::net` `Display` (dotted-quad) | `11` §4.3 |
| 2 | `Ip6Addr` | `net::Ipv6Addr` newtype (kept) | RFC 4291 text via `core::net` `FromStr`, any case | as `core::net` | `core::net` `Display` — RFC 5952 lowercase compressed, pinned by fixtures | `11` §4.3 |
| 3 | `IpAddr` | `net::IpAddr` newtype (kept) | either family via `core::net` `FromStr` | as rows 1–2 | per family, as rows 1–2 | `11` §4.3 |
| 4 | `IpPrefix` | `{ addr: net::IpAddr, len: u8 }` (kept) | `<addr>/<len>` | `len` ≤ 32 (v4) / 128 (v6) else `Range`; any set host bit → `HostBits` | canonical addr + `/` + len | `11` §4.3 |
| 5 | `InterfaceAddress` | `{ addr: net::IpAddr, prefix_len: u8 }` (kept) | `<addr>/<len>` | `prefix_len` bounds as row 4; **host bits preserved** | addr + `/` + len | `11` §4.3 |
| 6 | `IpRange` | `{ lo: net::IpAddr, hi: net::IpAddr }` ⇧ (field rename from `start`/`end` to the catalogue's `lo`/`hi`) | `<lo>-<hi>` | both parse as `IpAddr`; same family else `Syntax`; `lo <= hi` else `Range` | `lo-hi` | `11` §4.3 |
| 7 | `MacAddress` | `[u8; 6]` newtype (kept) | six `:`-separated pairs of hex digits, any case | exactly 6 groups of exactly 2 hex digits | `aa:bb:cc:dd:ee:ff` lowercase | `11` §4.3 |
| 8 | `IpProtocol` | `u8` newtype (kept) | unsigned numeric | 0–255 | the number | `11` §4.3 (ESP 50, AH 51) |
| 9 | `L4Port` | `u16` newtype (kept) | unsigned numeric | 0–65535 (full `u16`; the catalogue states no narrower bound) | the number | `11` §4.3 |
| 10 | `PortRange` | `{ lo: u16, hi: u16 }` ⇧ (rename from `start`/`end`) | `<lo>-<hi>` | each 0–65535; `lo <= hi` else `Range` | `lo-hi` | `11` §4.3 |
| 11 | `VlanId` | `u16` newtype (kept) | unsigned numeric | 1–4094; 0 and 4095 → `Range` | the number | `11` §4.3 |
| 12 | `Asn` | `u32` newtype (kept) | asplain, or asdot `<hi>.<lo>` with hi, lo each 0–65535 (value `hi*65536+lo`) | numeric grammar per part | asplain | `11` §4.3: *"asdot accepted on parse, asplain on canonical"* |
| 13 | `Seconds` | `u32` newtype ⇧ (from `u64` — the catalogue says `u32`; nothing constructs one today) | unsigned numeric | fits `u32` | the number | `11` §4.3; per-field ranges stay in the schema (`62` §3.2) |
| 14 | `Kilobytes` | `u64` newtype (kept) | unsigned numeric | fits `u64` | the number | `11` §4.3 |
| 15 | `DhGroup` | `u16` newtype (kept) + five consts `MODP1024`(2), `MODP1536`(5), `MODP2048`(14), `ECP256`(19), `ECP384`(20) | unsigned numeric | 1–65535; 0 → `Range` | the number | `11` §4.3. **DECISION —** newtype, not the catalogue's enum: a closed enum refuses IANA numbers the corpus has not named; the load-bearing property (one number, per-platform token tables later) survives. §12 item 2 |
| 16 | `EncryptionAlgorithm` | ⇧ `{ family: EncFamily, key_bits: Option<u16>, mode: EncMode, aead: bool }`; `EncFamily { Aes, TripleDes, Des }`, `EncMode { Cbc, Gcm }` | exactly one of the 8 canonical tokens: `aes-128-cbc`, `aes-192-cbc`, `aes-256-cbc`, `aes-128-gcm`, `aes-192-gcm`, `aes-256-gcm`, `3des-cbc`, `des-cbc` | closed table lookup; `aead` = (mode is `Gcm`); `key_bits` `Some` for aes rows, `None` for des/3des | the token | `11` §4.3 (the struct and the load-bearing `aead` flag). **DECISION —** starter table = the forms the field card uses (`aes-256-gcm`, `aes-256-cbc`, `aes-128-cbc`, `3des-cbc` legacy) plus their family/key-size/mode siblings — `des-cbc` enters as `3des-cbc`'s single-DES family sibling, on no card line itself; extending the table is an ordinary code+test change. <!-- VERIFY: the full per-platform accepted set lands with the statement-dictionary token tables; des-cbc in particular rides the sibling rule, not a card line --> |
| 17 | `IntegrityAlgorithm` | ⇧ enum `{ HmacMd5_96, HmacSha1_96, HmacSha256_128, HmacSha384_192, HmacSha512_256 }` | its canonical token: `hmac-md5-96`, `hmac-sha1-96`, `hmac-sha-256-128`, `hmac-sha-384-192`, `hmac-sha-512-256` | closed set | the token | `11` §4.3 (canonical `hmac-sha-256-128` style). Vendor spellings (`sha-256` on Junos, field card P1) are platform-table work, later. <!-- VERIFY: set sufficiency when the SRX dictionary ships --> |
| 18 | `AuthMethod` | ⇧ enum `{ PreSharedKeys, RsaSignatures, EcdsaSignatures }` | `pre-shared-keys`, `rsa-signatures`, `ecdsa-signatures` | closed set | the token | `11` §4.3 (the three variants); the first token is the field card's own line |
| 19 | `IkeVersion` | ⇧ enum `{ V1Only, V2Only, V1OrV2 }` (from `u8` newtype) | `v1-only`, `v2-only`, `v1-or-v2` | closed set | the token | `11` §4.3; the field card's `version v2-only` |
| 20 | `Identifier` | `String` newtype (kept) | any non-empty ASCII-graphic string (bytes 0x21–0x7E) | empty → `Syntax`; other byte → `Charset` | as written — *"validated, never normalised"* | `11` §4.3; per-platform charset/length tables are later work (§8) |
| 21 | `InterfaceName` | `String` newtype (kept — raw only; the `parsed` lens is §8) | as row 20 | as row 20 | as written (raw wins, `11` §4.6) | `11` §4.6 |
| 22 | `OsVersion` | `String` newtype (kept — raw only) | as row 20 | as row 20 | as written | `11` §4.7; derived `Ord` is **byte order, not version order** — documented on the type; §12 item 3 |
| 23 | `Timestamp` | `u64` newtype ⇧ (from `i64` — the catalogue says `u64` ms since epoch, *"Same epoch and precision as ULID"*) | RFC 3339 UTC: `YYYY-MM-DDThh:mm:ss[.mmm]Z`, fraction absent or exactly 3 digits, `T`/`Z` upper case | valid proleptic-Gregorian date; hh ≤ 23, mm ≤ 59, ss ≤ 59 (60 refused — no deterministic leap-second map); before 1970 or after `9999-12-31T23:59:59.999Z` → `Range` | `YYYY-MM-DDThh:mm:ss.mmmZ`, fraction always 3 digits, via the fenced algorithm below | `11` §4.3 |
| 24 | `Fqdn` | `String` newtype (kept; stores canonical form) | dot-separated labels; trailing dot accepted and stripped; ASCII letters folded to lower case on parse | ≥ 1 label; each label 1–63 chars, `[a-z0-9-]` after folding, no leading/trailing hyphen; total ≤ 253; non-ASCII → `Charset` | lowercase, no trailing dot | `11` §4.3 |
| 25 | `RouteDistinguisher` | ⇧ enum `{ Type0 { admin: u16, assigned: u32 }, Type1 { admin: net::Ipv4Addr, assigned: u16 } }` | `<admin>:<assigned>`; admin containing `.` parses as dotted-quad (type 1), else decimal (type 0) | type 0: admin ≤ 65535, assigned ≤ 4294967295; type 1: assigned ≤ 65535; else `Range` | `65000:100` / `198.51.100.1:100` | `11` §4.3: *"Type 0 and type 1 forms"*. A 4-byte-AS admin (type 2) is refused and is a §7 trigger, not a gap to fill |
| 26 | `SecretPlaceholder` | ⇧ per `11` §4.5 — see §4.4. **Implements no `Scalar`** | — | — | — | `11` §4.5 |
| 27 | `Text` | `String` newtype (kept) | anything, including empty | none — the one free-string scalar, so **no refusing case exists**; stated here so the per-scalar test floor is not "filled in" | as written | `11` §4.3 |
| 28 | `Date` | `{ year: u16, month: u8, day: u8 }` (kept) | `YYYY-MM-DD`, zero-padded | year 0001–9999; month 01–12; day valid for month with proleptic-Gregorian leap rule (div 4, except div 100 unless div 400) | `YYYY-MM-DD` | `62` §3.3 |
| 29 | `LatLon` | `{ lat_e7: i32, lon_e7: i32 }` (kept) | `<lat_e7>/<lon_e7>`, signed numeric grammar | lat ±900000000, lon ±1800000000 inclusive (±90°/±180°, `62` §3.3) else `Range` | `<lat_e7>/<lon_e7>` | `62` §3.3 |
| 30 | `Clli` | `String` newtype (kept) | 8 or 11 chars | charset `A–Z0-9` only (`Charset`); length ∉ {8, 11} → `Range` | as written, upper case | `62` §3.3. <!-- VERIFY: accepted lengths — 62 §3.3's own marker, carried; the 8-char site prefix is what 19 §8.2's take: prefix(8) assumes --> |
| 31 | `Bandwidth` | `u64` newtype (kept) | unsigned numeric — **bits per second, never a float** | fits `u64` | the integer | `62` §3.4; suffixed forms (`10g`) are per-platform token-table work, later |
| 32 | `TzName` | `String` newtype (kept) | `/`-separated segments, stored as written, case-sensitive | each segment non-empty, chars `[A-Za-z0-9._+-]`; syntactic only — the pinned-tzdb membership list is deferred, §10 item 2 | as written | `62` §3.4 |
| 33 | `PlatformId` | `String` newtype (kept) | lowercase token | non-empty; starts with `a–z`; chars `[a-z0-9-]`; no trailing hyphen. Registry membership is **not** this type's job: *"a validation error at the layer doing the constructing"* | as written | `62` §3.4, §14 |
| 34 | `InferenceRuleId` | `String` newtype (kept) | dotted id | must be `infer.` + ≥ 1 further segment; segments non-empty, chars `[a-z0-9-]`, no leading/trailing hyphen. Membership in the registered pass list is the build gate `schema.infer.unknown`, not this type's job | as written | `62` §3.4 |
| 35 | `RouteTarget` | ⇧ enum, same two variants as row 25 (`62` §3.4: *"same shape as `RouteDistinguisher`"*) | as row 25, with an optional leading `target:` accepted and stripped | as row 25 | `65000:100` — never with the prefix | `62` §3.4 |
| 36 | `OspfAreaId` | `u32` newtype (kept) | dotted-quad, or plain unsigned numeric ≤ 4294967295 | numeric grammar per part | **DECISION —** dotted-quad (`0.0.0.0`): injective from `u32`, unambiguous across vendors; the stub's own VERIFY stands and the choice is reversible while no workspace exists. <!-- VERIFY: carried from the stub — canonical form stated nowhere read --> | stub's VERIFY; `11` §6.5 uses the type |

The `Timestamp`/`Date` civil-date arithmetic, fixed so nobody derives it differently (pure
integer maths, no clock — the same posture as `fathom-corpus`'s `detln.rs`):

```rust
// days since 1970-01-01 -> (year, month, day), proleptic Gregorian.
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

// (year, month, day) -> days since 1970-01-01. Caller guarantees year >= 1970.
fn days_from_civil(y: u64, m: u64, d: u64) -> u64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
```

Part B: the 25 `structured: true` bindings — **all untouched by this work order**. They owe a
canonical serialisation (CBOR, `11` §14.1) and a total order, and *"both land with the store"*
(`value.rs`'s own header, citing `62` §3.1 row 3). Listed so the weld test (§4.5) classifies
every one of the 61 rows and so nobody "improves" one in passing:

| Names | Disposition |
|---|---|
| `Mtu`, `IkeId`, `PeerSpec`, `Dpd`, `PostalAddress`, `AttrValue`, `NameConformance` | Shapes as stated in `value.rs` today (including `Mtu`'s deferred layer discriminant); store WO |
| `NextHop`, `QualifiedNextHop`, `NodePriority`, `OspfArea`, `PolicyScope`, `AddressValue`, `L4Spec`, `NatScope`, `NatAction`, `VpnMonitor`, `PortPosition`, `Transceiver`, `SplitRatio`, `EndpointCardinality`, `AttributeDecl`, `FieldPath`, `Resolution`, `SyslogHost` | Stubs, several with *"Shape stated nowhere read"* — filling a shape is planning work, never this WO's |

### 4.3 Shape changes and the frozen shapes

Shape changes (the ⇧ rows above, complete list): `IpRange` and `PortRange` field renames to
`lo`/`hi`; `Seconds` `u64`→`u32`; `Timestamp` `i64`→`u64`; `IkeVersion` newtype→enum;
`EncryptionAlgorithm` `String`→struct (+ new public enums `EncFamily`, `EncMode`);
`IntegrityAlgorithm` `String`→enum; `AuthMethod` `String`→enum; `RouteDistinguisher` and
`RouteTarget` struct→two-variant enum; `SecretPlaceholder` per §4.4. Every changed type keeps
`#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]`, adding `Copy` where the new
shape permits it.

**Frozen shapes** — the seven `AttrValue` embeds (`Text`, `Bandwidth`, `VlanId`, `IpPrefix`,
`InterfaceAddress`, `Identifier`, `Date`, per `62` §13.3's binding table) plus `TzName`
(constructed by `generated_contract.rs`). If implementing a row appears to require changing one
of these, that is a §7 trigger.

### 4.4 `SecretPlaceholder` — the exemption, given its real shape

Per `11` §4.5, transcribed: private fields, constructors that take a label and optional
non-recoverable metadata, and no path from arbitrary text.

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SecretLabel { Psk, CertKey, SnmpCommunity, TacacsKey, Password }

/// A pointer to where the human keeps the secret, never a value.
/// Length-capped at 120 bytes (11 §4.5).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretHint(String);   // field private

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SecretPlaceholder {
    label: SecretLabel,          // private
    hint: Option<SecretHint>,    // private
}
```

Public API, exactly: `SecretHint::new(text: &str) -> Result<SecretHint, ScalarParseError>`
(refuses > 120 bytes with `Range { what: "hint length" }`; `scalar: "SecretPlaceholder"`),
`SecretHint::as_str(&self) -> &str`, `SecretPlaceholder::new(label: SecretLabel) -> Self`,
`SecretPlaceholder::with_hint(label: SecretLabel, hint: SecretHint) -> Self`,
`SecretPlaceholder::label(&self) -> SecretLabel`,
`SecretPlaceholder::hint(&self) -> Option<&SecretHint>`,
`SecretPlaceholder::placeholder(&self) -> String` returning `<` + `SecretLabel::token(self)` +
`>`, and `SecretLabel::token(self) -> &'static str` returning `PSK`, `CERT-KEY`,
`SNMP-COMMUNITY`, `TACACS-KEY`, `PASSWORD`. `<PSK>` is `11` §4.5's own rendering; the other
four are the mechanical SCREAMING-KEBAB of the variant.
<!-- VERIFY: the four tokens beyond <PSK> are stated nowhere read; confirm before an emitter
renders them into config. -->

**No `Scalar` impl, no `parse`, no `canonical`.** The weld test lists it as the one exemption
with the `11` §4.5 citation; §12 item 5 records the letter-level strain with `62` §18.1 and
`62` §3.1 row 1, so §7 item 7 does not fire on it.

### 4.5 The test file — `crates/fathom-ir/tests/scalar_contract.rs`

Three parts, all mandatory.

**(a) The weld test** — the trait-conformance half of `schema.scalar.unbound`, verbatim except
for the two name arrays and the `welded!` invocation, which transcribe §4.2 parts A and B:

```rust
use std::collections::BTreeSet;
use std::path::Path;

/// The 35 bindings that implement `Scalar` (WO-01 §4.2 part A minus
/// `SecretPlaceholder`).
const IMPLEMENTING: &[&str] = &[ /* the 35 names, §4.2 part A order */ ];

/// `SecretPlaceholder` (exempt, 11 §4.5) plus the 25 `structured: true`
/// bindings (62 §3.1 row 3 — no vendor round-trip obligation).
const NOT_IMPLEMENTING: &[&str] = &[ /* "SecretPlaceholder" + §4.2 part B */ ];

/// schema.scalar.unbound, trait half (62 §18.1: "…or lacks the trait"):
/// every `scalars:` row is classified, and every classified-implementing
/// name is welded to the trait by `welded!` below. A row this test does not
/// know refuses the build — the answer is to extend WO-01's catalogue by a
/// planning session, never to add a name here ad hoc.
#[test]
fn every_bound_scalar_is_classified() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crate lives two levels under the repo root")
        .join("schema");
    let tree = fathom_schema::SchemaTree::load(&root).expect("shipped tree loads");
    let declared: BTreeSet<&str> = tree.scalars.iter().map(|s| s.name.as_str()).collect();
    let known: BTreeSet<&str> = IMPLEMENTING
        .iter()
        .chain(NOT_IMPLEMENTING)
        .copied()
        .collect();
    assert_eq!(declared.len(), 61, "the scalars: block grew or shrank");
    assert_eq!(declared, known, "a scalars: row this work order does not classify");
}
```

plus a `welded!` macro, verbatim, invoked once with the 35 implementing type names in §4.2
part A order. Stable `macro_rules!` cannot mint one `fn` per name — identifier concatenation
needs a crate (`78` §5 item 2: never) or a nightly macro (the toolchain is pinned stable
1.94.1) — so one test folds both halves and expands to no dead code: instantiating `weld::<T>`
is the compile-time proof that `T` implements `Scalar`, and the returned `NAME` is the runtime
proof that each impl spells its schema name exactly. Verified compiling and passing on the
pinned toolchain during the 2026-08-02 repair pass.

```rust
macro_rules! welded {
    ($($name:ident),+ $(,)?) => {
        #[test]
        fn names_match_the_schema_spelling() {
            fn weld<S: fathom_ir::scalar::Scalar>() -> &'static str {
                S::NAME
            }
            $(assert_eq!(weld::<fathom_ir::scalar::$name>(), stringify!($name));)+
        }
    };
}

welded!( /* the 35 names, §4.2 part A order, `SecretPlaceholder` omitted */ );
```

**(b) The law harness and per-scalar cases.** A macro `scalar_cases!` that, per scalar, expands
to one `#[test] fn cases_<snake_name>()` doing, in order:

1. for every `(text, canonical)` accept pair: `parse(text)` is `Ok(v)`; `v.canonical() ==
   canonical`; `parse(&v.canonical()) == Ok(v)` (L1c);
2. for every refuse string: `parse` is `Err(e)` and `e.scalar == NAME`;
3. L3 over the accepted values, pairwise: `(a == b) == (a.canonical() == b.canonical())` —
   equality, both directions, so alternates mapping to one value (Asn asdot, OspfAreaId
   integer form) are exercised rather than special-cased.

The fixtures are **exactly** this table — no more, no fewer; a case that seems missing is a §7
trigger, not an addition. Sources: field-card lines are side 1's own text; `62`/`11` rows as
cited in §4.2; IPv6 renderings verified on the pinned 1.94.1 toolchain during authoring.

| Scalar | Must accept → canonical | Must refuse |
|---|---|---|
| `Ip4Addr` | `10.2.0.0` → `10.2.0.0`; `203.0.113.10` → `203.0.113.10` | `010.1.1.1`; `1.2.3.4␠` (trailing space, written as a literal space in the test) |
| `Ip6Addr` | `2001:DB8:0:0:0:0:0:1` → `2001:db8::1`; `::FFFF:C000:201` → `::ffff:192.0.2.1`; `2001:0db8:0000:0000:0001:0000:0000:0001` → `2001:db8::1:0:0:1` | `1::2::3` |
| `IpAddr` | `203.0.113.10` → `203.0.113.10`; `2001:DB8::A` → `2001:db8::a` | `not-an-ip` |
| `IpPrefix` | `10.2.0.0/16` → `10.2.0.0/16` | `10.2.0.1/16`; `10.2.0.0/33` |
| `InterfaceAddress` | `10.255.0.1/30` → `10.255.0.1/30` | `10.255.0.1/33`; `10.255.0.1` |
| `IpRange` | `10.0.0.1-10.0.0.9` → `10.0.0.1-10.0.0.9` | `10.0.0.9-10.0.0.1`; `10.0.0.1-::1` |
| `MacAddress` | `AA:BB:CC:DD:EE:FF` → `aa:bb:cc:dd:ee:ff` | `aabb.ccdd.eeff` |
| `IpProtocol` | `50` → `50`; `51` → `51` | `256`; `050` |
| `L4Port` | `500` → `500`; `4500` → `4500` | `65536` |
| `PortRange` | `500-4500` → `500-4500` | `4500-500` |
| `VlanId` | `1` → `1`; `4094` → `4094` | `0`; `4095` |
| `Asn` | `65000` → `65000`; `1.100` → `65636` | `65536.0` |
| `Seconds` | `28800` → `28800` | `4294967296` |
| `Kilobytes` | `1024` → `1024` | `-1` |
| `DhGroup` | `14` → `14`; `5` → `5` | `0` |
| `EncryptionAlgorithm` | `aes-256-cbc` → `aes-256-cbc`; `aes-256-gcm` → `aes-256-gcm` (and assert `aead` is `false`/`true` respectively) | `aes-512-cbc` |
| `IntegrityAlgorithm` | `hmac-sha-256-128` → `hmac-sha-256-128` | `sha-256` |
| `AuthMethod` | `pre-shared-keys` → `pre-shared-keys` | `psk` |
| `IkeVersion` | `v2-only` → `v2-only` | `ikev2` |
| `Identifier` | `IKE-P1` → `IKE-P1` | `` (empty); `two words` |
| `InterfaceName` | `reth0.0` → `reth0.0`; `st0.0` → `st0.0` | `` (empty) |
| `OsVersion` | `21.4R3-S4.9` → `21.4R3-S4.9` | `` (empty) |
| `Timestamp` | `1970-01-01T00:00:00.000Z` → itself (value 0); `2000-02-29T00:00:00.000Z` → itself (value 951782400000); `2026-08-01T00:00:00Z` → `2026-08-01T00:00:00.000Z` | `1969-12-31T23:59:59.999Z`; `2026-01-01T00:00:60.000Z` |
| `Fqdn` | `Site-B.Example.NET.` → `site-b.example.net`; `site-b.example.net` → itself | `-bad.example`; `a..b` |
| `RouteDistinguisher` | `65000:100` → `65000:100`; `198.51.100.1:100` → `198.51.100.1:100` | `70000:100`; `65000:4294967296` |
| `Text` | `` (empty) → ``; `free prose, as written` → itself | — (none exists; §4.2 row 27) |
| `Date` | `2026-08-01` → `2026-08-01`; `2000-02-29` → `2000-02-29` | `1900-02-29`; `2026-02-30`; `2026-13-01` |
| `LatLon` | `-274700000/1530280000` → itself; `0/0` → `0/0` | `900000001/0`; `0/-1800000001`; `-0/0` |
| `Clli` | `BRBNQLDA` → `BRBNQLDA`; `BRBNQLDA001` → `BRBNQLDA001` | `brbnqlda`; `BRBN` |
| `Bandwidth` | `1000000000` → `1000000000` | `1g` |
| `TzName` | `Australia/Brisbane` → `Australia/Brisbane`; `UTC` → `UTC` | `Australia Brisbane` |
| `PlatformId` | `junos-srx` → `junos-srx`; `panos` → `panos`; `ios-xe` → `ios-xe` | `Junos-SRX` |
| `InferenceRuleId` | `infer.route.next-hop-interface` → itself (a real `produced_by` token, `generated/ir_types.rs`) | `route.next-hop-interface` |
| `RouteTarget` | `target:65000:100` → `65000:100`; `65000:100` → `65000:100` | `target:` |
| `OspfAreaId` | `0.0.0.0` → `0.0.0.0`; `0` → `0.0.0.0` | `0.0.0.256` |

**(c) Two named structural tests.** `timestamp_civil_conversion_vectors`: the §4.2 algorithm
against 0 → `1970-01-01`, 11016 days → `2000-02-29`, and the ceiling — assert
`253402300799999` renders `9999-12-31T23:59:59.999Z` and `253402300800000` refuses on the
parse side by its date being out of range (the constant is derived, not trusted: assert it
equals `(days_from_civil(9999,12,31) * 86_400 + 86_399) * 1_000 + 999`).
`secret_placeholder_constructs_only_from_label`:
`SecretPlaceholder::new(SecretLabel::Psk).placeholder() == "<PSK>"`, a 120-byte hint accepted,
a 121-byte hint refused.

### 4.6 The verbatim edits outside `scalar.rs` and the test file

`crates/fathom-ir/Cargo.toml` — append:

```toml
[dev-dependencies]
# The scalar weld test reads schema/schema.yaml's scalars: block back through
# the subset parser. No cycle: fathom-schema depends on nothing.
fathom-schema = { path = "../fathom-schema" }
```

`crates/fathom-ir/src/lib.rs` — replace the bullet beginning `//! - `scalar` / `value` —
**stub** binding targets` (six lines) with:

```rust
//! - `scalar` — the semantic scalars (11 §4.3's catalogue as bound by
//!   `schema/schema.yaml`), each implementing the `Scalar` trait's canonical
//!   half (WO-01); the per-platform halves land with the emitters.
//!   `SecretPlaceholder` implements no `Scalar` (11 §4.5).
//! - `value` — **stub** binding targets for the structured value types
//!   (62 §3.1 row 3): canonical serialisation and total order land with the
//!   store.
```

`crates/fathom-schema/src/bin/fathom-schema-check.rs` — in `CHECKED_ELSEWHERE`, replace the
`schema.scalar.unbound` entry's string with:

```rust
        "compile-time: generated ir_types.rs references every bound impl \
         path, so `cargo build -p fathom-ir` is the existence check; trait \
         conformance: cargo test -p fathom-ir (tests/scalar_contract.rs) \
         welds every non-structured binding to the Scalar trait, \
         SecretPlaceholder exempt (11 4.5); fathom-schemagen additionally \
         refuses paths outside fathom_ir::scalar::/value::",
```

`scalar.rs`'s module header — replace the stub header (lines 1–14 today) with a doc comment
stating: one type per bound path; each implements the `Scalar` trait's canonical half (WO-01);
per-platform halves land with the platform registry and emitters; representation fields are
public and validity is `parse`'s contract, laws quantified over parse-reachable values;
`SecretPlaceholder` exempt per `11` §4.5. The word "STUB"/"stubs" must not survive in this file
(gate G8). Existing per-type doc comments keep their citations, amended where a row's shape
changed.

## 5. The plan

Each step ends with the whole workspace compiling (`cargo build --workspace`) unless marked.

1. Add the trait and error types (§4.1, verbatim) to `scalar.rs`. Build.
2. Apply the shape changes (§4.3's list, exactly; §4.4 for `SecretPlaceholder`). Before
   changing each type, `grep -rn "<TypeName>" crates/ --include="*.rs"` and confirm every hit
   outside `scalar.rs` falls in one of three benign categories: a type position (accessor
   return types in `generated/accessors.rs`), the generated inventory
   (`scalar_bindings_resolve` in `generated/ir_types.rs`), or a **same-named variant or
   substring of a different type** in generated `ir_types.rs` — the field enums reuse scalar
   names (`IkeProposalField::EncryptionAlgorithm`, `IpsecProposalField::EncryptionAlgorithm`,
   `RoutingInstanceField::RouteDistinguisher`) and produce substring hits
   (`LifetimeSeconds`, `LifetimeKilobytes`); a match arm on a `*Field` enum names that enum's
   variant, never the scalar, and is not a hit against it. A hit that constructs or
   destructures **the scalar type itself** is a §7 trigger. This step does not compile alone if
   a doc example references old fields — fix only doc comments in `scalar.rs` itself. Build.
3. Implement `Scalar` for the 35 types, in §4.2 part A's row order, against the stated grammars.
   Private helpers (the numeric grammar, the charset scan, the civil-date conversion as fenced
   in §4.2) are free to name; **no new public item** beyond §4.1's, §4.2 row 15's, §4.3's and
   §4.4's lists. Build after each few rows.
4. Write `tests/scalar_contract.rs` (§4.5, all three parts) and the `Cargo.toml` dev-dependency
   (§4.6, verbatim). `cargo test -p fathom-ir` green.
5. Apply the three remaining verbatim edits (§4.6: `lib.rs`, `fathom-schema-check.rs`,
   the `scalar.rs` header). Build.
6. Run every gate in §6 in order. All green, or stop under §7 / `78` §4.
7. Bookkeeping (`78` §3 steps 8–10): the status line at the top of this file → `DONE`; mirror
   the `00-INDEX.md` row **if the index exists** — its absence is recorded in §3 and is not
   this session's to fix. Commit, push, open the PR listing every gate run and its result
   verbatim. Do not merge.

## 6. Acceptance gates

Run from the repository root, in this order. Expected output is exact; anything else is a red
gate (`78` §3 step 7).

| # | Command | Expected |
|---|---|---|
| G1 | `cargo fmt --all --check` | No output, exit 0 |
| G2 | `cargo clippy --all-targets -- -D warnings` | Builds clean, exit 0 |
| G3 | `cargo test --workspace` | Every suite `ok`, 0 failed. `generated_contract` still `7 passed`; `attrtype_drift` still `1 passed`; `determinism` still `8 passed` |
| G4 | `cargo test -p fathom-ir --test scalar_contract` | `ok`, 0 failed; the run lists `every_bound_scalar_is_classified`, `names_match_the_schema_spelling`, `timestamp_civil_conversion_vectors`, `secret_placeholder_constructs_only_from_label`, and one `cases_*` test per §4.5(b) row |
| G5 | `git diff --exit-code -- crates/fathom-ir/src/generated schema/` | No output, exit 0 — generated code and the schema tree byte-identical |
| G6 | `cargo run -q -p fathom-schema --bin fathom-schema-check` | Exit 0; final summary lines exactly `48 kinds · 89 edges · 61 scalars · 10 enums · 14 files parsed`, `0 failure(s), 2 warning(s)`, and the checked-elsewhere line still lists the same 4 gate codes |
| G7 | `grep -c "impl Scalar for " crates/fathom-ir/src/scalar.rs` | `35` |
| G8 | `grep -in "stub" crates/fathom-ir/src/scalar.rs` | No matches, exit 1 — the stub caveat is retired |

G3/G5/G6 together are the requirement this WO was given outright: the existing weld
(`AttrValue::attr_type`'s exhaustive match plus `attrtype_drift.rs`) still holds, the
schemagen determinism tests are still green, and the generated code has not changed.

## 7. Stop-and-escalate triggers

Any of these stops the session under `78` §4. The escalation is the deliverable at that point.

1. Any step appears to require editing `crates/fathom-schemagen/`, anything under
   `crates/fathom-ir/src/generated/`, or anything under `schema/` — the trait was designed so
   codegen is untouched; if that turns out false, the design is wrong and planning must hear it.
2. A §4.5 fixture disagrees with `core::net` behaviour on the pinned 1.94.1 toolchain (parse
   acceptance or `Display` rendering). Do not re-pin the fixture; report both strings.
3. Anything constructs or destructures a §4.3 shape-changed type outside `scalar.rs` (plan
   step 2's grep), or a frozen shape (§4.3) appears to need changing.
4. The weld test finds a `scalars:` row not classified in §4.2, or a count other than 61.
5. A grammar decision this WO does not state is needed: a canonical token outside §4.2's closed
   tables (a real config needs a ninth `EncryptionAlgorithm` row, a type-2 route
   distinguisher/target, a Clli length outside {8, 11}, a fourth `SecretLabel` token) — refuse
   and escalate; the tables are extended by planning, with sources.
6. The trait seems to need a `Display` impl, a serialisation impl, a platform parameter, or any
   external crate — all deliberately excluded (§8, §12 item 1).
7. Implementing a row contradicts a cited §, or two cited §§ contradict each other in a way §12
   does not already record.

## 8. Non-goals

Deliberately not in this work order; citing a non-goal to justify extra work is the §9 row-1
failure.

- The per-platform halves of `11` §4.2: parse over a platform's token table, `emit(plat)`,
  `validate(&ValidateCtx)`, the L1/L2 platform laws, and every token table (`group14`,
  `10g`, Cisco `aabb.ccdd.eeff`, Junos `sha-256`). They land with the platform registry and
  the emitters.
- `11` §4.2's fourth test — every corpus/field-card line as a parse-emit fixture. Requires the
  platform halves.
- The `InterfaceName` parsed/raw lens and `parsed_then_raw` comparator (`11` §4.6); the
  `OsVersion` per-family comparator and `VersionPart` split (`11` §4.7).
- The structured value types: shapes, canonical CBOR serialisation, total order (`62` §3.1
  row 3 — the store's work), including `Mtu`'s layer discriminant.
- The pinned tzdb membership list for `TzName` (§10 item 2) and any registry membership check
  for `PlatformId`/`InferenceRuleId` (owned by constructing layers and build gates, `62` §3.4).
- `Display` impls, `proptest`, `CompactString`/`SmallVec` — §12 item 1.
- Schema changes of any kind. The `scalars:` block is read, never written.

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **Public representation fields admit invalid values** (e.g. `Identifier(String::new())`), silently outside the laws | Stated in §4.1; laws quantified over parse-reachable values; tightening visibility is a recorded future decision (§10 item 3), not a silent edit |
| 2 | **Canonical fixtures ride the toolchain** — an `Ipv6Addr::Display` change on a future toolchain bump would shift canonical text | The toolchain is pinned (`78` §2); fixtures turn any drift into a red G3/G4, and §7 item 2 routes it to planning |
| 3 | **The starter token tables get "helpfully" extended** during dictionary work without sources | §7 item 5; the closed tables are the decision of record until a planning session extends them |
| 4 | **`structured:` flag drift is invisible to the weld test** — `ScalarDecl` exposes names only, so flipping a row's `structured:` would not fail the classification | Any such flip changes the bound impl path's module, which changes generated output — caught by `schema.codegen.stale` (G3) and G5 |
| 5 | **The laws pass but a grammar is wrong** — parse and canonical can agree with each other and both disagree with the corpus | Accepting fixtures are real vendor lines and spec-quoted forms wherever the corpus provides one (§4.5's source note); rows without a vendor line carry VERIFY markers in §4.2 |
| 6 | **`OsVersion`'s derived `Ord` is read as version order** by a later consumer | The type's doc comment states byte order explicitly (§4.2 row 22); the per-family comparator is §8's deferred work; §12 item 3 records the strain |

## 10. Open decisions

This section doubles as the escalation inbox under `78` §4 step 2. Standing items, deliberately
not decided here:

1. The four carried VERIFY markers: Clli accepted lengths (`62` §3.3's own), the four
   `SecretLabel` tokens beyond `<PSK>`, `OspfAreaId`'s canonical form (decided provisionally in
   §4.2 row 36, reversible until a workspace exists), and `EncryptionAlgorithm`/
   `IntegrityAlgorithm` table sufficiency for the SRX dictionary. Owner or planning, before the
   respective consumers ship.
2. Which tzdb release the pinned `TzName` membership list is taken from, where the list file
   lives, and its refresh policy (`62` §3.4 requires the list; this WO ships syntax checks
   only). Owner.
3. Whether representation fields stay public once a store exists to own construction, or the
   module moves to private fields + parse-only construction. Planning, with the store WO.
4. Route distinguisher / route target type 2 (4-byte-AS admin): add when a real corpus entry
   needs it, as a catalogue extension with sources. Planning.
5. The generated inventory's doc string goes stale by design: after this order,
   `generated/ir_types.rs`'s `scalar_bindings_resolve` comment still reads *"the `Scalar` trait
   (11 §4.2) does not exist yet; `scalar`/`value` are stubs, marked so"* while `scalar.rs` says
   otherwise — G5 pins the generated file byte-identical and §7 item 1 keeps
   `crates/fathom-schemagen/` untouched, so the residue is accepted here, not overlooked. The
   one-string refresh in `crates/fathom-schemagen/src/rust_gen.rs` (the fenced doc text in its
   scalar-binding-inventory block) rides the next legitimate codegen change. Planning.

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants 1–3, 9; terminology; document conventions |
| `CLAUDE.md`; `docs/70-ops/78-execution-protocol.md` (whole) | The inherited constraint table; the escalation rule; the verification floor; the WO template |
| `docs/10-core/11-ir-schema.md` §4 (whole: §4.1–§4.7) | The trait, the laws, the catalogue, `SecretPlaceholder`, the two deferred lenses |
| `docs/60-content/62-schema-spec.md` §3 (whole), §13 (whole, incl. the fenced enum), §18.1 | Type families; binding declarations; the five new scalars; the closed holes; the `AttrType` weld; `schema.scalar.unbound` |
| `.context/field-card-srx-ipsec.txt` side 1 | The accepting fixtures that are vendor lines |
| `crates/fathom-ir/src/{scalar.rs,value.rs,bag.rs,lib.rs}`; `tests/generated_contract.rs` | The 61 stubs and their shapes; the `AttrValue` weld; what tests construct |
| `crates/fathom-ir/src/generated/{ir_types.rs,accessors.rs}` | `scalar_bindings_resolve` (path-only references and its doc string, §10 item 5); accessor return types; the `infer.*` `produced_by` tokens; the field enums' same-named variants (§5 step 2) |
| `schema/schema.yaml` lines 10–98 | The 61 rows, their comments and VERIFY markers |
| `crates/fathom-schemagen/src/rust_gen.rs`; `tests/{attrtype_drift.rs,determinism.rs}` | Where impl paths are emitted; the gates that must stay green |
| `crates/fathom-schema/src/{model.rs,lib.rs}`; `src/bin/fathom-schema-check.rs` | `SchemaTree::load` / `ScalarDecl`'s shape; the `CHECKED_ELSEWHERE` entry replaced in §4.6 |
| `Cargo.toml`, `crates/fathom-ir/Cargo.toml`, `rust-toolchain.toml` | The dependency position; current deps; the 1.94.1 pin |
| `cargo test --workspace`; `fathom-schema-check` (run 2026-08-02) | 80 passed / 0 failed; exit 0, `0 failure(s), 2 warning(s)`, `61 scalars` |
| A scratch `rustc` probe on the pinned 1.94.1 toolchain (2026-08-01) | `core::net` parse/`Display` behaviour pinned into §4.5's IP fixtures (leading-zero refusal, RFC 5952 renderings) |
| `docs/70-ops/79-work-orders/WO-02-the-graph-store.md` §3 (the `00-INDEX.md` bullet), §5 (its bookkeeping step); `ls docs/70-ops/79-work-orders/` | The queue's handling of the absent index, mirrored in §3, §4 and §5 step 7 |
| A scratch `rustc --test` probe on the pinned 1.94.1 toolchain (2026-08-02, repair pass) | §4.5(a)'s `welded!` expansion compiles and its one test passes as fenced |

## 12. Disagreements

1. **Against `11` §4.2's trait as written.** The specced trait is
   `parse(text, plat)` / `emit(plat)` / `canonical()` / `validate(ctx)` over `CompactString`,
   `SmallVec` and `proptest`. This WO ships `parse(text)` + `canonical()` over `String`, laws
   pinned by deterministic table/exhaustive tests, no `Display` supertrait. Reasons: the
   zero-dependency position (`78` §2) removes `CompactString`/`SmallVec`/`proptest` outright;
   `PlatformId`-parameterised methods without a platform registry or a single emitter would be
   dead code with invented token tables; and a blanket `Display` cannot be written for a trait
   (coherence), so 36 hand impls would add surface with no consumer. The platform halves extend
   this trait later without changing it — parse-over-token-table normalises into `parse`'s
   canonical form. If this split is wrong, the correction lands in `11` §4.2, not silently here.
2. **Against `11` §4.3's `DhGroup` row.** The catalogue says enum; this WO keeps a validated
   `u16` newtype with the five catalogue numbers as consts (§4.2 row 15's reasoning). Same
   pattern of strain as `schema.yaml`'s own filed Mtu/IkeId note: content document vs binding
   reality, filed rather than hidden.
3. **Against `11` §4.7's "no `PartialOrd` impl on `OsVersion`".** The stub already derives
   `Ord`, and this WO's trait requires `Ord`. Kept, documented as byte order for deterministic
   storage/sorting only; the per-family comparator arrives with the platform registry, at which
   point the derive question reopens with `11` §4.7 on the table.
4. **`Seconds` and `Timestamp` realignment is compliance, not preference.** The stubs deviated
   from `11` §4.3 (`u64` for `u32`, `i64` for `u64`) without stating a reason; this WO realigns
   to the catalogue rather than papering the stub's guess into a trait impl.
5. **The `SecretPlaceholder` exemption strains the letter of two binding sources.** `62` §18.1
   makes *"lacks the trait"* a build failure with no exemption clause, and `62` §3.1 row 1
   defines the semantic-scalar family as *"Rust implementing `11` §4.2's `Scalar` trait"* —
   yet `schema/schema.yaml` binds `SecretPlaceholder` without `structured: true`, and `11` §4.5
   (*"There is no `SecretPlaceholder::from_value`."*) makes parse-from-text impossible. This WO
   resolves the strain as a registered exemption (§1, §4.4): the weld test classifies
   `SecretPlaceholder` under `NOT_IMPLEMENTING` with the `11` §4.5 citation, and the
   `CHECKED_ELSEWHERE` text (§4.6) says so. Filed here so §7 item 7 cannot fire on it. If the
   letter is to win instead, the correction lands in `62` (an exemption clause in §18.1, or a
   binding-form change) — planning work, not this order's.
6. **Corrections from the 2026-08-02 repair pass**, recorded per `78` §8's correction rule,
   each old → new with the proving path:
   - As first authored, this order neither acknowledged the missing `00-INDEX.md` nor
     conditioned any step on it, while claiming no dependencies and closing §4 over exactly
     five files — irreconcilable with `78` §3 step 2 (*"Open
     `docs/70-ops/79-work-orders/00-INDEX.md`"*), step 8's index-row edit, and `78` §4's
     absent-index trigger (`ls docs/70-ops/79-work-orders/` shows the eight WO files and no
     index). New: §3's closing bullet, §4's scoping, §5 step 7 — WO-02's handling, mirrored.
     The residual strain stays filed: `78` §4 as literally read escalates on a missing index
     regardless of what any work order says; the durable fix is planning shipping the first
     index in `78` §8's format, which `78` §3's own `<!-- VERIFY -->` demands before the first
     execution session runs.
   - §4.1 claimed its items were the only new public names *"besides the ones §4.3 and §4.4
     list"*, contradicting §4.2 row 15's five public `DhGroup` consts — a literal session
     implementing row 15 would have fired §7. New: §4.1 and §5 step 3 name row 15.
   - §4.5(a) described `welded!` as expanding per name to `fn _weld_<name>()`-shaped items,
     which stable `macro_rules!` cannot do on the pinned 1.94.1 toolchain (identifier
     concatenation needs a crate — `78` §5 item 2 — or a nightly macro). New: the exact stable
     macro, fenced, probe-verified compiling and passing.
   - §5 step 2's benign-hit taxonomy listed *"a YAML string in `fathom-schema`'s fixtures"* —
     a category with zero instances for any shape-changed name (grep over
     `crates/fathom-schema` returns nothing) — and omitted the category that dominates the
     real hits: same-named field-enum variants in generated `ir_types.rs`
     (`IkeProposalField::EncryptionAlgorithm`, `RoutingInstanceField::RouteDistinguisher`,
     the `LifetimeSeconds` substring). New: the three real categories.
   - §4.2 row 16's stated derivation yielded 7 of its 8 tokens: `des-cbc` is on no field-card
     line (`.context/field-card-srx-ipsec.txt` side 2's proposal-parameters block lists
     `aes-256-gcm`, `aes-256-cbc`, `aes-128-cbc`; `3des-cbc` legacy) and is not a
     key-size/mode sibling of any of them. New: family/key-size/mode siblings, `des-cbc`
     named as riding the sibling rule, the row's VERIFY extended.
   - §§5–12's headings had dropped the dotted number form §§0–4 use. New: normalised.
