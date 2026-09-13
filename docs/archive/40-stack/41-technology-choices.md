# 41 — Technology choices

> **Status:** Proposed

The owner brief §1 states the stack in one sentence: *"Rust core compiled to WASM for the browser
and native for a CLI; thin TypeScript UI; Rust (Axum) sync service."* This document does not
rubber-stamp that sentence. It states what each clause has to be true for, names the stacks that
were rejected and why, and then specifies the chosen one down to a crate list and a workspace
layout an implementer can `cargo new` against.

**The governing rule of this document, stated once, in caps, at the top:**

> **A STACK IS A SET OF FAILURE MODES YOU HAVE AGREED TO OWN. PICK THE ONES YOU CAN SEE.**

Everything below is downstream of that. §2 argues the language choice on the failure modes it
removes and the ones it introduces. §3 is the boundary, which is where this architecture actually
gets expensive. §4 makes the UI decision the brief left open. §7 and §8 are the parts you can
implement from.

---

## 0. Contents

| § | |
|---|---|
| 1 | Scope — what this document decides, and what is already decided elsewhere |
| 2 | The language decision, interrogated: five candidate stacks, and the costs of the winner |
| 3 | The WASM boundary — traffic census, format, budget, and the failure modes |
| 4 | The UI layer — the candidates, the constraints that actually bind, and the DECISION |
| 5 | The sync service — framework, storage engine, deployment footprint |
| 6 | The CLI — what it is for, and the honest part of "nearly free" |
| 7 | The crate list for the core, with a justification per crate and cap accounting |
| 8 | Repository layout — the Cargo workspace, the crate boundaries, and the CI edges |
| 9 | What this costs, added up — including the not-invented-here ledger |
| 10 | Open decisions |
| 11 | Sources |
| 12 | Disagreements |

---

## 1. Scope

### 1.1 What this document owns

| Owned here | Not owned here |
|---|---|
| Language and compilation target per artifact | Cryptographic primitives — `32-cryptography.md` §15.1 |
| The shape and format of the JS↔WASM boundary | The workspace wire format — `11-ir-schema.md` §14.1 |
| The UI rendering strategy and framework decision | The DOM sink rules and CSP — `34-browser-hardening.md` §5, §2 |
| The sync service's framework and storage engine | The sync protocol and its CRDT — `33-sync-protocol.md` |
| The CLI's purpose and subcommand surface | Reproducibility, signing, dependency caps — `35-supply-chain-and-builds.md` |
| The crate list and the workspace layout | The AI layer's crate boundary rules — `21` §2.1, `24` §4.4 |
| Node's role in the build | `42-no-node-runtime.md`, which is the long-form answer |

Where this document names a crate that `32` also names, `32` wins on version and on rationale. This
document's job there is to count it against the caps in `35` §5.1, not to re-argue it.

### 1.2 The constraints that are already fixed and that every choice below has to survive

| # | Constraint | Source | What it eliminates |
|---|---|---|---|
| 1 | **Determinism where observable.** Same workspace + corpus + build ⇒ byte-identical emit, findings, ranking | conventions, invariant 9 | Anything with unstable iteration order, float-dependent output, or a runtime that reorders work observably |
| 2 | **No egress.** `connect-src 'none'` offline; one origin with sync | conventions, invariant 1 | Any runtime that fetches, any package that phones home, any font host |
| 3 | **One core, three hosts.** Browser, CLI, and the service all run the same emit/lint/finder code | brief §1, `33` R6 | Two implementations of the emitter in two languages. This is the constraint that removes most candidates |
| 4 | **Hostile input is a first-class path.** A pasted `display set` capture is fully attacker-controlled (`34` §6, `31` B12) | `31` | A memory-unsafe parser |
| 5 | **The artifact is auditable.** WASM import section dumpable and allowlisted; no dynamic code | `34` §7.5, §8.3 | Any runtime that JITs from data, any plugin loader |
| 6 | **No third-party JavaScript at runtime** | `34` §8.1 | Every JS framework whose runtime ships in the bundle — see §4 |
| 7 | **Dependency caps** C1 ≤ 30 direct, C2 ≤ 160 closure, C3 ≤ 25 publishers, C4 ≤ 12 build scripts, C5 ≤ 10 proc macros, C6 = 0 npm, C7 no C/C++ in the shipped closure | `35` §5.1 | Most of the convenient answers |
| 8 | **Emitters return `(line, provenance)` pairs** | invariant 6 | Any templating approach in any language |

Constraint 3 is the one people under-weight. It is not an efficiency argument. If the browser and
the CLI emit configuration through different code, then `fathom lint` in CI and the walkthrough in
the browser can disagree about the same workspace, and the moment they do, the product's core claim
— that the thing you paste into the router is what the tool showed you — stops being checkable.

---

## 2. The language decision, interrogated

*margin tab: why it exists*

### 2.1 The five candidate stacks

The brief proposes stack **S2**. The others are here because they are what a competent team would
actually propose, and because rejecting them in writing is cheaper than rejecting them in month
seven.

| | **S1 — TypeScript everywhere** | **S2 — Rust core, TS UI** *(the brief)* | **S3 — Go core → WASM, TS UI** | **S4 — C++ core → WASM, TS UI** | **S5 — Rust everywhere incl. UI** |
|---|---|---|---|---|---|
| One core across browser/CLI/service | yes, via Node or Bun for the CLI — but that reintroduces a JS runtime as a shipped dependency | **yes** | yes | yes | **yes** |
| Memory safety on the hostile-input path | yes (GC) | **yes** (safe subset, `#![forbid(unsafe_code)]`) | yes (GC) | **no** | **yes** |
| WASM output quality | n/a — ships JS | **good**: no GC, no runtime, `wasm32-unknown-unknown`, LTO, `opt-level="z"` | poor for our shape: TinyGo or a Go runtime + GC in the module; Go's own WASM output is large <!-- VERIFY: measure current Go 1.2x and TinyGo output sizes for a comparable workload before quoting a number anywhere --> | good, and Emscripten drags a JS glue runtime in unless you fight it | good |
| Crypto ecosystem meeting `32`'s pins | WebCrypto only — **no Argon2id**, so the KDF has to be WASM anyway | **RustCrypto, dalek, `subtle`** — every primitive `32` pins exists as an audited-ish pure-Rust crate | limited; `x/crypto` is good but Go-to-WASM constant-time behaviour is not something we can reason about | OpenSSL/libsodium — C, which C7 forbids | same as S2 |
| C7 (no C/C++ in the closure) | n/a | **satisfiable** | satisfiable | **violated by definition** | satisfiable |
| Determinism control (invariant 9) | poor: `Object` key order, `Map` iteration is insertion-ordered (fine) but JSON number formatting and `Intl` are hazards | **good**: `BTreeMap`, no floats in the schema, explicit sort, `#[deny]` lints | GC and goroutine scheduling do not affect output, but map iteration is *deliberately randomised* — every map iteration is a determinism bug waiting | good | good |
| Compile time | seconds | **minutes** — §2.5 | seconds to tens of seconds | minutes | minutes, and the UI recompiles with the core |
| Hiring pool | largest | small, and smaller again for "Rust + networking domain knowledge" | mid | mid | **smallest** |
| Two-language cognitive load | none | **yes, and it is the real cost** | yes | yes | none |
| Verdict | **rejected** | **chosen** | rejected | rejected | rejected for the UI, §4.3 |

**Why S1 fails, precisely.** Not "JavaScript is slow" and not "JavaScript is unsafe". It fails on
three specific things:

1. **The CLI becomes a JS runtime dependency.** `fathom lint` in a CI pipeline, on an air-gapped
   build host, in a container, must be one static binary. A Node or Bun CLI is a runtime we ship,
   version, patch and defend — and `42` §1 is about not doing that.
2. **Argon2id does not exist in WebCrypto.** `32` requires a memory-hard KDF for the workspace
   passphrase. WebCrypto offers PBKDF2, not Argon2id. So a WASM module is in the artifact
   regardless of the language choice, at which point "no WASM" is not on the table and the question
   becomes only *how much* is in it. <!-- VERIFY: confirm current WebCrypto algorithm coverage; the claim needed here is only that Argon2id is absent, which `32` §15 already relies on. -->
3. **Determinism is achievable in TypeScript but not cheaply provable.** Invariant 9 is a
   byte-identity claim. In Rust it is enforced by `BTreeMap`, `#[deny(clippy::…)]` lints, and a
   two-build CI gate. In TypeScript it is enforced by review. That difference compounds over 400
   rules and a corpus of 1,200 command entries.

**Why S3 fails.** Go's map iteration order is randomised by design. That is a correct language
decision and a fatal one for a codebase whose top-line invariant is byte-identical output — every
map iteration becomes a place where the fix is "remember to sort". Go-to-WASM binary size is also
against us, and the crypto story is worse.

**Why S4 fails.** C7. `35` §5.1 forbids C and C++ in the shipped closure for a determinism reason
as much as a safety one. A parser for attacker-controlled input written in C++ is the failure mode
the whole product's threat model spends its energy avoiding elsewhere.

### 2.2 The memory-safety argument, stated so it is not a taste argument

The claim is narrow and it is checkable.

**The hostile-input surface is the parser.** `31` B12 and `34` §6 both classify a pasted device
configuration as fully attacker-controlled by design — it is the product's primary on-ramp
(brief §6.3). `14-parsers-and-ingest.md` caps a paste at 32 MB / 250,000 lines and specifies a
tokeniser, a brace/indent shaper, a trie walker and a binder over that input. That is four passes
over adversarial bytes, running inside a page that holds a decrypted network estate.

What Rust removes from that surface, exactly:

| Class | Removed? | Note |
|---|---|---|
| Buffer overflow / out-of-bounds read or write | **yes**, in safe code | Slice indexing is bounds-checked; the panic is a trap, not a corruption |
| Use-after-free, double-free | **yes** | Ownership |
| Type confusion via bad casts | **yes** | No unchecked downcast in safe code |
| Data race on shared mutable state | **yes** | `Send`/`Sync`; and the core is single-threaded per instance anyway |
| Integer overflow producing a wrong length | **partly** | Wrapping in release by default. Mitigated: `overflow-checks = true` in the release profile — see §2.5's cost note |
| **Unbounded allocation → OOM** | **no** | This is a real DoS path and `14` §11.4's 32 MB cap plus `34` §7.5's `memory.grow` handling are the controls, not the language |
| **Stack overflow via recursive descent** | **no** | `14` §11.6's iterative shapers and depth cap 64 are the control |
| **Panic → dead WASM instance** | **no** | A panic traps. `34` §7.5 makes a trap fatal to the worker. `#![deny(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)]` in the ingest crate is the control |
| **Logic bugs** — a parser that binds the wrong value to the wrong field | **no** | The largest remaining class, and the one that matters most for a tool whose output gets pasted into a firewall |

So the honest statement is: **Rust deletes the memory-corruption classes and leaves the resource-
exhaustion, panic and logic classes entirely intact.** The first is worth having because those are
the classes that turn a hostile config into code execution in a page holding the user's estate. The
rest is caps, fuzzing and tests, and none of that is free because the language is Rust.

**`#![forbid(unsafe_code)]` at the workspace root**, with exactly two documented exceptions
permitted and neither of them currently taken:

| Exception | Status |
|---|---|
| The WASM ABI boundary (`§3.7`) — raw pointer arithmetic over linear memory | **taken.** Confined to `fathom-wasm`, which is ~300 lines, has `#![deny(unsafe_op_in_unsafe_fn)]`, and is on the manual-review list |
| A measured hot loop where the bounds check is provably the bottleneck | **not taken, and not permitted without a benchmark in the PR.** §3.6 shows the hot path is boundary-bound, not compute-bound, so this exception should never be needed |

### 2.3 The argument that is actually stronger than memory safety

**One implementation of `emit`, `lint`, `verify`, `diff` and `table`, executing the same bytes in
the browser, the CLI and the corpus build.**

The product's claim is that the config it shows you is the config it would emit, and that CI's
findings are the browser's findings. With S2 that is a compilation-target difference, not a
reimplementation. There is exactly one place where a rule's `condition` is evaluated and exactly one
place where a `(line, provenance)` pair is constructed.

The property this buys is worth naming: **`fathom lint` in a CI job and the walkthrough in a browser
tab cannot disagree unless the build is different**, and `35`'s manifest makes "is the build
different" a hash comparison rather than an investigation. `24` §4.4 already leans on this for
`fathom verify`, whose entire purpose is re-emitting a workspace outside the browser and asserting
byte identity.

Every candidate stack except S1 gets this. It is not an argument for Rust over Go. It is the
argument for a compiled core over "the UI framework also does the logic", which is the design most
web tools drift into.

### 2.4 The crypto ecosystem argument

`32` §15.1 pins ChaCha20-Poly1305, Argon2id, HKDF, BLAKE3, X25519/Ed25519, HPKE and `subtle`. Every
one exists as a pure-Rust crate from a publisher already in the set (`35` §5.2), and the pure-Rust
requirement is C7, which exists because `ring`'s assembly and C would put a second toolchain inside
the determinism story.

The thing to be honest about: **pure-Rust crypto is slower than assembly crypto, and in WASM it is
slower again** because there are no AES instructions and no SIMD unless we enable it. `32` D3
already chose ChaCha20-Poly1305 partly for that reason. This is a real cost paid for a real
property, and the property is that the artifact has one toolchain and reproduces byte-for-byte.

### 2.5 The costs of S2, stated in full

Nobody is talked out of a stack by a cost table, but they are talked out of *surprises*. These are
the surprises.

| Cost | Magnitude | Mitigation, and whether it is enough |
|---|---|---|
| **Release compile time.** `35` N1 forces `codegen-units = 1`; `lto = "fat"` on top of it. Both serialise work the compiler would otherwise parallelise | A full release build of a workspace this size is minutes, not seconds, and it is minutes on *every* release build because the release profile is not the dev profile | Dev builds use `codegen-units = 16`, `lto = false`, `opt-level = 1`, and `debug = 1`. Release settings are used by CI and by nobody's inner loop. **Enough for developers; not enough for CI**, where R1 (build twice, `35` §3.1) doubles it. Budget CI minutes accordingly |
| **Incremental compile time on a core change** | Touching a type in `fathom-graph` recompiles every crate downstream of it, which is most of them | The workspace split in §8 exists partly for this: the corpus, the finder index format and the emitters are separable. `cargo check` in the editor, not `cargo build`. Partial |
| **WASM binary size.** Every byte is base64'd (+33 %) into the mode-A single file | §3.10's budget. The dominant contributors are the crypto stack, the CBOR codec, formatting machinery and panic strings | `opt-level = "z"`, `panic = "abort"`, `strip = "symbols"`, `wasm-opt -Oz`, and `#[cold]`/`#[inline(never)]` on error paths. Also: no `format!` in library code — errors are enums, rendered at the boundary. **Enough to hit the budget; not enough to make the file small** |
| **The JS↔WASM boundary is a real interface with a real cost** | §3 in its entirety | §3.1's coarse-call rule. This is the single largest architectural tax of the decision |
| **Hiring.** "Rust, plus WASM, plus browser security, plus enough network engineering to review a rule about `host-inbound-traffic`" is a small intersection | Real, and it does not improve with time | Nothing structural. The mitigation is that the corpus (the largest work item, `61` §—) is authored in YAML by network engineers, not in Rust by systems programmers. **Partial, and honest: this is a bus-factor risk before it is a hiring risk** |
| **Two languages, one product.** Every feature that touches both sides is edited in two places, tested in two harnesses, and debugged across a boundary where the stack trace stops | The steady-state tax. Roughly: a change to a `Finding`'s shape touches the Rust struct, the codec, the generated TS type, the renderer, and two tests | §8's generated-types rule: the TS boundary types are **generated from the Rust definitions** by `xtask`, checked in, and CI fails if regeneration produces a diff. That removes the drift, not the work |
| **Debugging across the boundary** | A panic in WASM surfaces in JS as `RuntimeError: unreachable`. With `panic = "abort"` and stripped symbols, it surfaces with no message at all | Dev builds keep `panic = "unwind"` and a panic hook that formats the message into a structured error. Release builds do not — `34` §7.5 makes a trap fatal and named at the boundary, which is a worse debugging experience and a better security posture. **Accept it, and make the named errors good** |
| **`overflow-checks = true` in release** | Costs a branch per arithmetic op; buys a deterministic panic instead of a silently wrong length | Take it. The core is not compute-bound (§3.6) and a wrapped length in a parser is exactly the bug we are here to avoid |
| **Toolchain surface.** Rust + `wasm-bindgen-cli` + `wasm-opt`, all version-pinned and one of them (`wasm-bindgen`) with a hard lockstep requirement | `35` §3.2 already carries this | The lockstep assertion in CI. Adequate |

### 2.6 What would change this decision

Stated so that "we chose Rust" does not become unfalsifiable.

| Observation | Would move us to |
|---|---|
| Measured WASM module exceeds ~1.2 MB compressed and the size is traced to the language, not to our code | Nothing better exists; it would move us to *shipping less*, e.g. splitting the parser into a lazily-fetched module in modes B–D. Mode A cannot do that |
| The keystroke budget in §3.6 cannot be met and profiling shows boundary marshalling, not compute, is the cause | A finer-grained boundary with a shared `ArrayBuffer` and a lock-free ring, which is a real design and §3.10 says why we are not starting there |
| Two of the pinned crypto crates go unmaintained simultaneously | `32` §15's problem, not this document's, but it would force a re-examination of C7 |
| The team that exists cannot hire for it | S5 does not help. S1 with a *published, separately-signed* WASM crypto module is the honest fallback, and it costs invariant 9's provability |

---

## 3. The WASM boundary

*margin tab: read this first*

> **EVERY CROSSING IS A COPY, A DECODE, OR BOTH. COUNT THE CROSSINGS BEFORE YOU OPTIMISE THE
> CODE ON EITHER SIDE OF THEM.**

### 3.1 The rule

**DECISION — the boundary is coarse and message-shaped. One crossing per user intention, never one
per data item.**

The failure mode this prevents is the one every JS↔WASM project hits: a getter-shaped API
(`get_node(id)`, `get_field(node, key)`, `get_findings_for(node)`) that reads beautifully and costs
one crossing per call, one `TextDecoder.decode` per string, and one bounds check per access. The
measured behaviour that makes this bite is that **string decoding across the boundary has a high
constant cost per call that is largely independent of string length** — which is why
`sledgehammer_bindgen` exists and why its stated technique is batching many strings into one decode.

So the API below has ten exports, not two hundred, and every one of them takes a message and returns
a message.

### 3.2 The traffic census

Every crossing in the product, by direction, shape, frequency and size. This table is the thing to
argue with; if a feature needs a crossing not on it, that is a design review, not an implementation
detail.

| # | Crossing | Dir | Trigger | Frequency | Payload | Typical size |
|---|---|---|---|---|---|---|
| X1 | `init` — instantiate, load corpus index + rule pack | JS→W | page load, worker spawn | once per instance | corpus/pack bytes (already in memory) | 0.5–4 MB, moved once |
| X2 | `open` — decrypt and decode a workspace | JS→W | file open | once per open | envelope ciphertext | 0.2–20 MB |
| X3 | `apply(ops)` — one batch of graph ops | JS→W | any edit; one batch per input event | ≤ 60/s | canonical CBOR op list | 40 B – 4 KB |
| X4 | `delta` — findings + emit + table changes since last call | W→JS | return of X3 | with X3 | packed delta (§3.3) | 0.2–8 KB |
| X5 | `query(finder)` — the `Ctrl+K` path | JS→W | keystroke | ≤ 60/s | query string + flags | < 200 B |
| X6 | `results` — ranked finder rows | W→JS | return of X5 | with X5 | packed rows, lazy text | 1–6 KB |
| X7 | `explain(target, depth)` | JS→W | click | ~1/s | ID + depth | < 64 B |
| X8 | `corpus block AST` | W→JS | return of X7 | with X7 | packed AST (`34` §5.3's union) | 1–20 KB |
| X9 | `ingest(capture)` — paste a config | JS→W | paste | rare, bursty | raw bytes | up to 32 MB (`14` §11.4) |
| X10 | `graph delta + capture record` | W→JS | return of X9, via `postMessage` | rare | CBOR delta | 0.1–4 MB |
| X11 | `seal` — encrypt the workspace | JS→W | save | ~1/min | none (state is inside) | — |
| X12 | `envelope bytes` | W→JS | return of X11 | with X11 | ciphertext | 0.2–20 MB |
| X13 | `entropy(ptr, len)` | **W→JS import** | per seal, per ID batch | ~10/s worst case | fills a buffer in linear memory | 16–64 B |
| X14 | `now_ms()` | **W→JS import** | provenance timestamps only | ~1/s | — | 8 B |
| X15 | `layout(view)` — diagram coordinates | JS→W | view change, drag end | ≤ 5/s | view spec | < 1 KB |
| X16 | `positions` | W→JS | return of X15 | with X15 | packed `f32` coordinate array | 1–40 KB |

**Two imports, and that is the whole import section.** X13 and X14. `34` §7.5 requires the WASM
import section to be dumped and matched against a committed allowlist, and requires that *no import
be capable of originating a network request*. With two imports, both of which write into linear
memory and neither of which takes a URL, that check is a two-line assertion rather than an audit.

**RECOMMENDATION — treat "the import section has two entries" as a published property.** It is the
cheapest thing in the whole architecture to verify (`wasm-objdump -x`, ten seconds) and it converts
`connect-src 'none'` from a header into a structural fact. `34` §8.3 check 6 already wants this; this
design makes it trivial rather than merely possible.

### 3.3 The format decision

**DECISION — three formats, chosen by direction and lifetime, not one format everywhere.**

| Tier | Used for | Format | Why |
|---|---|---|---|
| **T1 — structural, durable** | X2, X3, X10, X11/X12, anything that is or becomes workspace content | **Canonical CBOR**, RFC 8949 §4.2 deterministic encoding, `FieldKey(u16)` keys | Already the workspace wire format (`11` §14.1). Using a second format for the same data would mean two encoders and two determinism arguments |
| **T2 — hot read path, transient** | X4, X6, X8, X16 | **First-party packed layout** — a header, an offset table, fixed-width records, and one trailing UTF-8 string blob | One `TextDecoder.decode` for the whole blob instead of one per field. Fixed-width records read with `DataView` at known offsets. No allocation on the JS side beyond the views. `16` §10 already specifies exactly this for finder results and calls JSON marshalling there "pure waste" |
| **T3 — opaque** | X1, X9, X12 | **Raw bytes**, no framing | Ciphertext, capture text and pack bytes have no structure the boundary needs to understand |

The T2 layout, concretely — this is the `delta` reply (X4), and every other T2 reply is the same
skeleton with a different record type:

```text
offset  size  field
0       4     magic  'F' 'D' 'L' 'T'
4       2     version (u16)
6       2     record_kind (u16)      1=Finding 2=EmittedLine 3=FinderRow 4=Point
8       4     record_count (u32)
12      4     record_stride (u32)    fixed width, so record i is at 16 + i*stride
16      …     records[record_count]
…       4     strings_len (u32)
…       …     strings: one UTF-8 blob; records carry (u32 offset, u32 len) into it
```

```rust
/// One record in the X4 findings delta. `repr(C)` and every field a fixed-width
/// integer, so the JS side reads it with DataView at compile-time-known offsets.
/// 40 bytes. No pointers, no padding surprises, no strings.
#[repr(C)]
pub struct FindingRecord {
    pub op: u8,             // 0 = added, 1 = removed, 2 = severity/slot changed
    pub severity: u8,       // finding severity scale — NOT the Risk enum (conventions)
    pub risk: u8,           // Risk: 0 ReadOnly, 1 ChangesConfig, 2 Disruptive
    pub flags: u8,          // bit0 suppressed, bit1 has_remediation, bit2 acceptable_when_shown
    pub rule_ord: u32,      // ordinal into the pack's rule table, not a string
    pub node_lo: u64,       // NodeId ULID, low 64 bits
    pub node_hi: u64,       //            high 64 bits
    pub kind: u16,          // node kind discriminant
    pub _pad: u16,
    pub title_off: u32,     // into the trailing string blob
    pub title_len: u32,
}
```

**Why not JSON.** For X4 and X6 it is measurably wasteful — `16` §10 budgets 0.4 ms for packed
marshalling of 25 finder rows and states that `JSON.stringify`/`parse` of the same data is
"comfortably a millisecond". For X3 and X10 it is worse than wasteful: JSON has no canonical form
that survives number formatting, and invariant 9 is a byte-identity claim.

**Why not `serde-wasm-bindgen` or `JsValue` marshalling.** It builds JS objects field by field
across the boundary, which is precisely the per-item crossing §3.1 forbids, and it pulls the serde
derive machinery into the WASM module for a path that does not need it.

**Why not rkyv or FlatBuffers for T2.** Both are real zero-copy formats and both solve the wrong
half of the problem. Zero-copy on the *Rust* side is not our bottleneck; the reply is constructed
once, in an arena, and dropped. The bottleneck is the *JS* side, and JS cannot read a rkyv archive
without a JS reader we would then have to write and keep in sync with the Rust definition. The
first-party packed layout is ~200 lines of Rust writer plus ~150 lines of TS reader, both generated
from one schema by `xtask` (§8.4), which is less code than adopting either and has no publisher.

### 3.4 What "zero-copy" honestly means here

The phrase gets used loosely. At this boundary, precisely:

| Operation | Copies? | Detail |
|---|---|---|
| JS reads WASM linear memory | **no copy** | `new Uint8Array(memory.buffer, ptr, len)` is a view over the same bytes |
| JS reads a *number* out of that view | no copy | `DataView.getUint32(off, true)` — this is why T2 records are fixed-width integers |
| JS turns bytes into a JS **string** | **always a copy, always a decode** | `TextDecoder.decode` allocates a JS string on the JS heap. There is no way around this and no design that avoids it |
| JS writes input into WASM memory | one copy | `view.set(bytes)` into a buffer the module allocated |
| WASM reads JS-side data | **impossible directly** | The module cannot see the JS heap. Everything inbound is a copy into linear memory |

So the achievable property is: **zero-copy in, decode-lazily out.** Numbers and IDs cross for free
as bytes in a view. Text crosses once per reply as one blob, and is decoded per *visible* row, not
per row — which for a virtualised table of 4,000 findings showing 40 rows is a 100× reduction in
decode work, and is the single highest-leverage decision in this section.

### 3.5 The detach hazard, and the rule that prevents it

`memory.grow` **detaches every existing `ArrayBuffer` view over `memory.buffer`.** Reading a stale
view throws; writing through one silently does nothing useful. This is the most common WASM boundary
bug and it is invisible until an allocation happens to cross a page boundary in production.

**Three rules, enforced by the binding layer's shape rather than by discipline:**

| # | Rule | Enforcement |
|---|---|---|
| B1 | **No view outlives a single call.** Views are created inside the call wrapper and never stored on an object, in a closure, or in a module-level variable | The wrapper is the only code that touches `memory.buffer`; the lint bans `.buffer` outside `src/boundary/wasm.ts` |
| B2 | **Decode before the next call.** Any string a caller needs is decoded during the call, or its `(offset, len)` is retained and the *bytes* are copied out first | The reply reader returns either a decoded string or an owned `Uint8Array` slice, never a view |
| B3 | **`memory.grow` failure is a named error, not a trap.** `32` §4.4 and `34` §7.5: growth failure returns `-1` rather than trapping, so every allocation path checks and the user sees *"this workspace needs 256 MiB and this device would not give it"* | An allocation helper that is the only caller of the allocator |

### 3.6 The keystroke lint budget

The bar is the brief's: one frame at 60 Hz, **16.67 ms from keystroke to painted frame**. `16` §10
sets it for the finder. This is the same bar for the *lint* cycle, which is a different path and a
harder one because it writes to the graph.

**The cycle, stage by stage.** A user is typing into the `dh-group` field of an `IkeProposal` in a
walkthrough, with the config preview and the findings panel both visible — the worst realistic case,
because all three views are live.

| Stage | Budget | Basis |
|---|---|---|
| `keydown` → local echo in the input | 0.05 ms | the browser does this; we do not re-render the field |
| Field-shape validation in TS, from the generated field descriptor | 0.02 ms | one regex or one enum-membership test |
| Encode one `SetField` op, canonical CBOR | 0.03 ms | ~48 bytes, u16 keys, no allocation beyond a reused 4 KB scratch buffer |
| Copy into linear memory + call `fathom_call` | 0.10 ms | one `view.set` of 48 bytes plus the call overhead |
| Apply the op; L0 invariant check | 0.02 ms | `O(1)` field write (`11` §14.3) |
| Dirty-set expansion | 0.05 ms | the dirty node's kind → the rule pack's `applies_to` index → the affected rule set |
| **Incremental rule pass** | **0.30 ms** | ~8–40 rules matching the touched kinds, each traversing ≤ 64 nodes. `11` §14.3: rules scan a kind bucket, never the graph |
| Findings delta vs the previous set, keyed `(rule_ord, node_id)` | 0.10 ms | ≤ 4,000 live findings in a sorted vector; the delta is a merge |
| **Re-emit the affected emit unit** | **0.80 ms** | `O(V+E)` over the closure (`11` §14.3); an SRX IPsec unit is ~40 nodes and ~80 emitted lines. Only if the preview is visible |
| Pack the T2 delta | 0.10 ms | fixed-width records into an arena |
| Return; JS builds views; **one** `TextDecoder.decode` of the string blob | 0.20 ms | §3.4 |
| Patch findings rows (≤ 6 changed) | 0.60 ms | keyed rows, §4.5 |
| Patch config preview lines (≤ 12 changed) | 1.20 ms | one text node per line, `white-space: pre` (`34` §5.4) |
| **Subtotal, our code** | **≈ 3.6 ms** | |
| Style, layout, paint | 4–7 ms | the browser's, and the actual variable |
| **Total** | **≈ 8–11 ms** | inside the frame, with headroom |

**The headline, and it is the same as the finder's: compute is not the problem.** The rule pass is
0.3 ms against a 16.67 ms budget. Two thirds of our own cost is DOM patching and one sixth is the
boundary. Anyone optimising this should instrument the render first and the rule engine last.

**The three ways this blows up, in order of likelihood:**

1. **Re-emitting the whole device instead of the emit unit.** An SRX with 165 security policies is
   ~2,000 emitted lines, not 80. That is a 25× miss and it turns 0.8 ms into 20 ms. The emit-unit
   closure is not an optimisation; it is the design (`13` §—).
2. **Returning the full finding set instead of a delta.** 4,000 findings × 40 B = 160 KB per
   keystroke across the boundary, plus a full re-render. The delta is what makes X4 fit in 8 KB.
3. **One crossing per changed field instead of one per input event.** A form that writes three
   dependent fields on one keystroke must batch them into one `apply`. §3.1's rule, restated as the
   thing that actually goes wrong.

**And the case that is honestly not on this budget:** X9, the 32 MB paste. `14` §11 puts it in a
dedicated Worker that is terminated afterwards. It is hundreds of milliseconds, it must show
progress, and it must never pretend to be interactive. Conflating it with the keystroke path is how
the interaction model gets designed wrong.

### 3.7 The ABI

**DECISION — a raw `(ptr, len)` ABI over ten exports and two imports. `wasm-bindgen` is used for the
module scaffolding and for nothing that carries data.**

The reasoning: with a coarse, message-shaped API there is nothing for `wasm-bindgen`'s type bridge
to do except generate glue for byte arrays, which it does by copying them into JS `Uint8Array`s —
the copy §3.4 says we do not need. Holding the data path to raw pointers keeps the generated glue
small, keeps the import section at two entries, and keeps `34` §7.5's export audit to ten lines.

```rust
// crates/fathom-wasm/src/lib.rs — the entire data-plane ABI.

/// Opcodes. Stable forever; a new call is a new opcode, never a changed one.
pub const OP_INIT:    u32 = 1;
pub const OP_OPEN:    u32 = 2;
pub const OP_APPLY:   u32 = 3;
pub const OP_QUERY:   u32 = 4;
pub const OP_EXPLAIN: u32 = 5;
pub const OP_INGEST:  u32 = 6;
pub const OP_SEAL:    u32 = 7;
pub const OP_LAYOUT:  u32 = 8;
pub const OP_SNAPSHOT:u32 = 9;
pub const OP_STATS:   u32 = 10;

/// Allocate `len` bytes of scratch for the caller to write a request into.
/// Returns 0 on failure — never traps, per B3.
#[no_mangle]
pub extern "C" fn fathom_alloc(len: u32) -> u32;

/// Release a scratch buffer. Reply arenas are owned by the module and reused.
#[no_mangle]
pub extern "C" fn fathom_free(ptr: u32, len: u32);

/// The one data-plane entry point.
///
/// Returns a packed handle: `(reply_ptr as u64) << 32 | (reply_len as u64)`.
/// `reply_len == 0` means "no reply"; a failure is a reply with `record_kind = 0`
/// and an error record, never a trap and never a JS exception.
///
/// The reply lives in a module-owned arena that is valid until the *next*
/// `fathom_call`. Rule B1 exists because of that sentence.
#[no_mangle]
pub extern "C" fn fathom_call(op: u32, req_ptr: u32, req_len: u32) -> u64;

// --- imports: the entire import section ---
extern "C" {
    /// Fill `[ptr, ptr+len)` from the platform CSPRNG. `32` §5 requires this to be
    /// `crypto.getRandomValues` directly, per seal, never a cached userspace PRNG.
    fn fathom_entropy(ptr: u32, len: u32);
    /// Milliseconds since the Unix epoch, for provenance timestamps only.
    /// Never used in any code path whose output is compared for byte identity.
    fn fathom_now_ms() -> f64;
}
```

**The RNG consequence, called out because it changes a decision in `32`.** `getrandom`'s `wasm_js`
backend is implemented against `wasm-bindgen`/`js-sys`. Using the raw ABI means registering
`getrandom`'s **custom backend** instead and routing it to `fathom_entropy`. That is supported —
`getrandom` documents a custom-backend mechanism precisely for `wasm32-unknown-unknown`, where the
target triple alone does not say what JS interface exists.

| Consequence | Detail |
|---|---|
| **Gain** | The import section is two entries, both auditable in one line. The `js-sys` dependency leaves the closure. `32` §5's "checked by symbol, not by inspection" CI assertion gets *easier*: there is one symbol |
| **Cost** | We own ~12 lines of RNG plumbing that sit under every key, salt and nonce in the product. A bug there is silent and catastrophic |
| **Control** | `32` §5's startup sanity check (draw 64 bytes, reject all-zero, reject a repeat) runs against our shim, plus a `wasm-bindgen-test` that asserts two successive draws differ and that the shim is wired to `crypto.getRandomValues` and not to `Math.random` |

<!-- VERIFY: confirm the exact getrandom 0.3.x custom-backend registration mechanism and its
     interaction with the version `32` §15.1 pins, before writing the shim. If the mechanism has
     changed, the fallback is `wasm_js` plus a three-entry import section, which costs the
     "two imports" property but nothing else. -->

The TypeScript side of the same boundary — the *only* file permitted to touch `memory.buffer`:

```ts
// src/boundary/wasm.ts — the one place views are created, and the one place
// values become Untrusted (34 §5.2).
export class Core {
  #inst: WebAssembly.Instance;
  #mem(): ArrayBuffer { return (this.#inst.exports.memory as WebAssembly.Memory).buffer; }

  /** One crossing. Views are created here and die here — rule B1. */
  call(op: Op, req: Uint8Array): Reply {
    const alloc = this.#inst.exports.fathom_alloc as (n: number) => number;
    const ptr = alloc(req.byteLength);
    if (ptr === 0) throw new CoreOutOfMemory(req.byteLength);   // B3, named
    new Uint8Array(this.#mem(), ptr, req.byteLength).set(req);  // copy in

    const handle = (this.#inst.exports.fathom_call as CallFn)(op, ptr, req.byteLength);
    const rPtr = Number(handle >> 32n), rLen = Number(handle & 0xffff_ffffn);

    // Fresh views AFTER the call: the call may have grown memory (B1).
    const bytes = new Uint8Array(this.#mem(), rPtr, rLen);
    return Reply.parse(bytes);   // decodes the string blob once; B2
  }
}
```

### 3.8 Worker topology

`34` §7 and `14` §11.5 already place the parser in its own Worker with its own instance, terminated
after each large ingest, for two independent reasons that happen to agree: WASM linear memory never
shrinks, and terminating the worker destroys the only plaintext copy of the paste.

| Instance | Lives in | Holds | Terminated |
|---|---|---|---|
| **Session** | the main thread | the decrypted graph, the rule pack, the finder index | on tab close |
| **Parse** | a Worker | one capture at a time; no keys, no graph | after each ingest above the fragment tier |
| **Crypto** | a Worker | key material during seal/open only | after each operation |

The boundary spec is identical across `postMessage` and direct calls — the same T1/T2 formats,
because `postMessage` of a `Uint8Array` is a structured clone (a copy) unless the buffer is
transferred, and a transferable `ArrayBuffer` carrying a packed T2 reply is exactly the shape we
already produce. **RECOMMENDATION — always transfer, never clone, for payloads over 64 KB**, and
treat the transferred buffer as moved on the sending side.

### 3.9 The error model

**No exceptions cross the boundary. Ever.**

| Situation | Behaviour |
|---|---|
| A recoverable failure (bad passphrase, malformed capture, quota exceeded, unknown opcode) | Reply with `record_kind = 0` and an `ErrorRecord { code: u16, node_lo/hi, detail_off/len }`. `code` is an enum, not a string; the message text is looked up in the corpus so it is translatable and reviewable |
| An unrecoverable failure (allocation refused) | Same, with a distinguished code. **Never** a trap — B3 |
| A panic (a bug) | Traps. `34` §7.5: the worker treats a trap as fatal, terminates itself, reports a named error, and **never retries**. On the main thread the session is marked poisoned and the UI offers a save-and-reload path |

The property being bought: **a bug in the core cannot become a half-applied graph mutation.** Ops
are applied to a staging structure and committed only when the whole batch succeeds, so a trap
mid-batch loses the batch, not the workspace.

### 3.10 The costs of the coarse boundary

| Cost | Detail |
|---|---|
| **Fine-grained interactivity has to be faked** | Hovering a config line to highlight its source node cannot be a crossing. It is a lookup in a client-side index the last X4 delta already populated — which means the UI keeps a shadow copy of *some* graph data, and shadow copies drift |
| **The shadow copy is a second source of truth** | Bounded by rule: the shadow holds only what is rendered, is rebuilt from the delta stream, and is never written to. A UI feature that wants to *read* something not in the delta must add it to the delta, not read the graph |
| **Batching is a real algorithm, not a convenience** | The op batcher has to coalesce (three writes to the same field in one frame become one op), order (ops are causally ordered for the CRDT, `33` §4.3), and cap (a batch over 4 KB flushes early) |
| **A single long call blocks the frame** | X9 is the obvious one and it is in a Worker. The non-obvious one is X2 on a 20 MB workspace: Argon2id at the parameters `32` picks is deliberately slow. It goes in the crypto Worker with a progress channel, and the UI must show a real progress state, not a spinner |
| **The module's WASM size budget** | A budget, not a measurement: |

| Component | Budget (uncompressed) | Note |
|---|---|---|
| Graph, ops, CRDT | 90 KB | |
| Parsers + dictionary | 140 KB | the dictionary is data, and compresses well |
| Rule engine + emitters | 120 KB | |
| Finder | 60 KB | index is separate (A7) |
| Crypto stack | 180 KB | `32` §15.1's set; the largest single block |
| CBOR codec + packed writers | 40 KB | first-party, §7 |
| `core::fmt`, panic strings, misc | 70 KB | reduced by `panic = "abort"` and no `format!` in library code |
| **Target total** | **≤ 700 KB uncompressed, ≤ 260 KB Brotli** | <!-- VERIFY: these are budgets derived from component scope, not measurements. Measure the day `fathom-core` compiles and replace every row. If the total lands above 900 KB, §2.6 row 1 applies. --> |

In mode A that is base64'd into the single file at +33 %, so the WASM contributes roughly 950 KB of
a file that also carries the finder index, the rule pack, four font faces and the JS. **The
single-file artifact is a multi-megabyte HTML file and there is no version of this design where it
is not.** Saying so up front is better than discovering it at release.

---

## 4. The UI layer

*margin tab: fields that matter*

### 4.1 The constraints that actually bind

The brief says "thin TypeScript". That is a size statement, not a shape statement. Four constraints
decide the shape, and three of them are already committed elsewhere.

| # | Constraint | Source | Consequence |
|---|---|---|---|
| U1 | **No third-party JavaScript in the shipped artifact** | `34` §8.1 | Any framework's runtime is disqualified unless it compiles away to nothing |
| U2 | **`require-trusted-types-for 'script'`, with exactly two named policies (`fathom-dom`, `fathom-worker`), neither of which creates HTML** | `34` §2.9 | Any library that assigns to `innerHTML` needs a *third* policy whose `createHTML` returns its input — which is the escape hatch `34` deliberately closed |
| U3 | **R1–R10**: no `innerHTML`, text only via `createTextNode`, tag names and attribute names from closed literal unions, no CSS derived from content, `render(html: string)` does not exist | `34` §5.2 | The rendering model is "build nodes, walk types" |
| U4 | **The aesthetic is printed technical reference**: dense tables, hairline rules, mono-in-prose, letterspaced caps, a 4px accent bar, three colours and no fourth | `.context/design-language.md` | There is nothing for a component library to give us. There are no cards, no icons, no shadows, no modals-with-animation. The CSS is a few hundred lines and it is hand-written |
| U5 | The two hard problems are **a virtualised table** and **a diagram editor** | brief §6.4, §6.5 | Both are problems frameworks make *harder*, not easier, because both want direct control of node identity and of when the DOM is touched |

U2 is the one that quietly settles most of the table below, and it is worth being exact about it,
because it is a real technical fact and not a preference:

- **Lit** creates a Trusted Types policy named `lit-html` and routes its template HTML through it,
  because its rendering model parses template strings with `innerHTML` before interpolation. Using
  Lit means adding `lit-html` to the `trusted-types` allowlist — a third policy, whose `createHTML`
  is the identity function.
- **Svelte** compiles templates to `innerHTML` assignments on a `<template>` by default; it has a
  compiler option that builds fragments element-by-element instead, which is slower and works under
  Trusted Types. So Svelte is *possible* here, on a non-default path.
- **Solid**'s compiled output uses the same template-cloning technique.
  <!-- VERIFY: confirm Solid's current compiled output under `require-trusted-types-for 'script'`, and whether a non-innerHTML compilation mode exists, before this row is used to reject it. -->
- **Preact** builds DOM through `createElement`/`appendChild`; `dangerouslySetInnerHTML` is opt-in
  and lintable. Preact is the only mainstream framework in this table that is Trusted-Types-clean by
  default.

### 4.2 The candidates

| | **Vanilla TS + first-party render layer** | **Lit** | **Preact** | **Svelte 5** | **Solid** | **Leptos / Dioxus (Rust)** |
|---|---|---|---|---|---|---|
| Runtime bytes shipped | **0** (our own ~10 KB counts as our code) | ~5–7 KB min+gz for `lit-html` alone | ~4 KB min+gz | ~2–3 KB, mostly compiled away | ~7 KB | **adds to the WASM module**, not the JS — and see §4.3 |
| U1 — no third-party runtime JS | **yes** | no | no | ~yes (compiled) | ~yes (compiled) | yes |
| U2 — needs a third TT policy | **no** | **yes** | no | no, on the `tree` compile mode | needs verification | no |
| U3 — compatible with "build nodes, no markup" | **by construction** | no | yes | with the non-default mode | needs verification | yes |
| Needs a Node build step | **no** | yes (bundler) | yes | **yes — the Svelte compiler is a Node program** | **yes — same** | no |
| Typing across the WASM boundary | direct: the reader returns generated types | same | same | same | same | **none — same language** |
| Virtualised table | ours to write either way | fights the framework's ownership of children | workable | workable | workable | ours to write |
| Diagram editor (SVG, hit-testing, pan/zoom) | direct DOM control | awkward | awkward | awkward | awkward | direct DOM control via glue |
| Cost of exit if wrong | **low** — it is our code | mid | mid | **high** — the compiler owns the source format | high | **total** — it is a different language |
| Verdict | **chosen** | rejected on U2 | closest alternative | rejected on the Node compiler | rejected, pending verification | rejected, §4.3 |

Two of those rejections deserve to be stated without hedging:

- **Svelte and Solid are rejected primarily on the build, not the runtime.** Both are compilers, and
  both compilers are Node programs. `42` and `35` §6 make "no npm in the build" a hard gate, and a
  framework whose compiler is a Node package is not compatible with that gate at any price. Their
  runtime output is genuinely excellent and that is not the deciding column.
- **Lit is rejected on U2 alone.** It is otherwise the best fit in the table for a project that wants
  web components and no build step. But `34` §2.9's argument — that the value of Trusted Types here
  is that *there is no supported way to turn a string into markup in this application* — is
  destroyed by adding a policy whose `createHTML` is `(s) => s`. Adopting Lit means writing that
  function. Do not write that function.

### 4.3 The Rust-native UI, taken seriously

This is the option that would delete the TypeScript layer, the boundary, the generated types, the
two-language tax and half of `42`. It deserves more than a line.

**What it would buy:**

| Gain | Real? |
|---|---|
| One language, one type system, no generated boundary types, no drift | **yes, and it is large** |
| No `TextDecoder` on the hot path — the view code reads the graph directly | **yes** |
| §2.5's "two languages, one product" cost disappears | **yes** |
| The `42` toolchain problem shrinks to CSS and fonts | **yes** — this is genuinely the strongest argument |

**What it would cost:**

| Cost | Detail |
|---|---|
| **The boundary does not disappear. It inverts and gets finer.** | Every DOM operation becomes a `wasm-bindgen` call into `web-sys`. §3.1's rule — coarse crossings — is a rule about *our* API; a Rust UI framework crosses the boundary once per element, per attribute, per event listener. The traffic census in §3.2 has 16 entries; a Rust UI has thousands per frame |
| **`web-sys` in the shipped closure** | It is the mechanism by which a Rust UI touches the DOM, and it enlarges both the import section and the module. §3.2's "two imports" property is gone, and with it the cheap version of `34` §8.3 check 6 |
| **WASM size** | A published Dioxus hello-world compiled with `trunk build --release`, `lto = true`, `opt-level = "z"` is reported at 275 KB, with sub-100 KB achievable using nightly features; Leptos publishes a binary-size guide for the same reason. Those are *hello worlds*. Our module already budgets 700 KB before any UI code |
| **Text input, IME, selection, accessibility** | The parts of a UI that are hardest are the parts where the browser's own behaviour must be preserved rather than reimplemented. A virtualised table with keyboard navigation and a text editor for pasted configs are exactly those parts |
| **Trusted Types** | Rust UI frameworks build nodes rather than markup, so this is fine — but the compliance story becomes "audit the framework's glue" instead of `34` §5.8's lint over our own source |
| **Recompile on every UI change** | §2.5's compile-time cost now applies to changing a label |
| **Hiring** | The smallest intersection in §2.1's table, made smaller |

**DECISION — no Rust-native UI.** The deciding argument is the first row: the design's central
performance property is a coarse boundary, and a Rust UI framework is a fine-grained boundary by
construction. We would be paying the WASM module's costs to get a boundary shape we specifically
chose against.

**The honest caveat:** if the UI turns out to be 3,000 lines and the boundary types turn out to be
the main source of bugs, this decision is worth re-opening — and it is re-openable, because §4.4's
render layer is small and the views are pure functions of typed data. It is one of the few big
decisions in this stack that is not one-way.

### 4.4 DECISION — vanilla TypeScript over a first-party render layer

**No framework. A ~600-line render layer we own, plus views that are functions from typed data to
DOM operations.**

```ts
// src/ui/dom.ts — the whole render layer's element half.
// Tag names and attribute names are literal unions (34 R3, R4).
type Tag = 'div'|'span'|'p'|'ul'|'li'|'table'|'thead'|'tbody'|'tr'|'th'|'td'
         | 'pre'|'code'|'section'|'h1'|'h2'|'h3'|'button'|'input'|'label'|'blockquote';
type Attr = 'class'|'id'|'role'|'tabindex'|'aria-label'|'aria-expanded'
          | 'data-node'|'data-rule'|'data-ord'|'type'|'value'|'disabled';

export function el(parent: Element, tag: Tag, attrs?: Partial<Record<Attr, string>>): Element {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k as Attr]!);  // literal keys only
  parent.appendChild(n);
  return n;
}
```

```ts
// src/ui/list.ts — the only reconciler in the codebase. Keyed, flat, no diffing
// of attributes: a row either exists, moves, or is rebuilt.
export interface RowSpec<T> {
  key: (item: T) => string;
  build: (parent: Element, item: T) => Element;   // creates
  patch: (node: Element, item: T) => void;        // updates in place
}

/** O(n) in the new list; one map lookup per row; no virtual tree. */
export function reconcile<T>(parent: Element, items: readonly T[], spec: RowSpec<T>): void;
```

**What we get:** exactly the four things this product needs — element creation, a keyed list patcher,
an event delegation helper, and a tiny store — and nothing else. No lifecycle, no context, no
scheduler, no hydration, no SSR, no portals, no suspense.

**What we lose, stated plainly:**

| Lost | Consequence |
|---|---|
| Declarative templates | View code is imperative and longer. A findings row is ~30 lines of `el()` calls rather than ~12 lines of JSX |
| Automatic dependency tracking | State updates are explicit: the store publishes a typed change and the subscriber patches. Forgetting to subscribe is a class of bug frameworks remove for you |
| A community answer to every UI problem | We answer them. Every one |
| Ecosystem components — date pickers, combo boxes, virtual lists | We write the two we need (§4.5) and design around the rest. The design language's austerity makes this affordable in a way it would not be for a normal application |
| **The thing that is genuinely dangerous** | A hand-rolled render layer accretes. In eighteen months it is a framework with no documentation and one contributor who understands it. §9.2 puts a line-count cap on it and CI enforces the cap |

**RECOMMENDATION — cap the render layer at 800 lines and fail CI above it.** Not because 800 is
magic, but because the failure mode is gradual and a number is the only thing that makes it visible.
If a feature needs the 801st line, that is a design conversation, which is exactly what you want.

### 4.5 The two hard UI problems, specified

**(a) The virtualised table.** Used by the findings panel (up to ~4,000 rows, `12` §—), the inventory
table, and the finder's 25-row result list (`16` §—).

| Property | Decision |
|---|---|
| Row heights | **Fixed per row type**, from a closed set of four heights. Not measured, not dynamic. `16` §— already fixes the finder's collapsed group height for exactly this reason |
| Window | `ceil(viewport / rowHeight) + 6` rows rendered; 3 above and 3 below |
| Node reuse | A recycle pool keyed by row type. Scrolling patches existing nodes; it never creates or destroys unless the row type changes |
| Scroll handling | `scroll` listener, `passive: true`, one `requestAnimationFrame` coalesce. No `IntersectionObserver` per row |
| Complexity | `O(visible)` per scroll frame, `O(1)` amortised per row |
| Sort/filter | In the core, not the UI. The UI receives an ordinal list. This keeps ranking deterministic (invariant 9) and keeps 4,000 findings out of the JS heap as objects |
| Text | Decoded lazily per visible row from the T2 string blob (§3.4). This is the reason the format was chosen |
| Budget | 6–9 ms for 25 rows, per `16` §10 — which is the largest single line item in the whole keystroke budget |
| **Cost** | Fixed row heights mean a long `title` truncates rather than wraps. That is a design constraint the field card's own tables already accept (two columns, hairlines, one line per row) — but it will be argued about, and the answer is "the row expands on click", not "rows have dynamic height" |

**(b) The diagram.**

| Property | Decision |
|---|---|
| **Layout runs in the core, not the UI** | X15/X16. Deterministic (invariant 9), shared with the CLI's SVG export, and `23` §6.5 already requires diagram layout to be a deterministic non-model task |
| Algorithm | Layered (Sugiyama-style) for the physical and L3 views: cycle removal → layer assignment → crossing reduction by ordered sweeps → coordinate assignment. Zones and overlays are containment rectangles computed after node placement |
| Complexity | Crossing reduction dominates: `O(sweeps · Σ_layers (n_l log n_l))` for a median/barycentre heuristic with a fixed sweep count. Fixed sweeps, so it is deterministic and bounded — an adaptive termination criterion is a determinism bug |
| Rendering | `createElementNS` from `34` §5.6's closed tag set: `svg g path rect line circle text tspan title`. No `foreignObject`, no `use`, no `image`, no `style`, no `href` |
| Pan/zoom | One `transform` on a single `<g>`. Never re-layout on zoom |
| Hit testing | Against the coordinate array returned by X16, in TS, with a uniform grid bucket — not `document.elementFromPoint`, and not one listener per element. One delegated listener on the `<svg>` |
| Drag | Position overrides are graph data (a `LayoutHint` on the node, with provenance `Actor::Human`), applied as constraints on the next layout, so a user's manual placement survives a re-layout and round-trips through the workspace |
| **Cost** | Writing a layered layout is weeks, and `34` §8.2 says so explicitly. The alternative — vendoring a layout library — is permitted by `34` §8.2 *only* if it returns coordinates and never touches the DOM. **RECOMMENDATION — build the trivial version first** (grid placement, orthogonal edges, manual drag) and treat automatic layered layout as a later, separately-scoped piece of work. Shipping a diagram that lays out badly and lets you fix it by dragging is better than not shipping a diagram |

### 4.6 State, since there is no framework to provide it

```ts
// One store. Event-sourced from the core's deltas. Read-only to views.
export interface Store {
  /** Every mutation goes through the core; the store never edits itself. */
  dispatch(ops: readonly Op[]): void;
  /** Views subscribe to a typed slice and receive the delta, not the whole state. */
  on<K extends keyof Slices>(slice: K, fn: (d: Delta<Slices[K]>) => void): Unsubscribe;
}
```

The invariant that makes this safe: **the UI has no authoritative state.** Everything the user can
change is a graph op, applied by the core, returned as a delta. The store is a projection cache with
a lifetime of one session. If it is ever wrong, reloading fixes it, and that is a property worth
protecting — the moment the UI owns a piece of truth the core does not have, the "one graph, six
views" claim in brief §4.1 stops being literally true.

### 4.7 What would change the UI decision

| Observation | Move to |
|---|---|
| The render layer passes 800 lines twice in a quarter | Preact, vendored, pinned, compiled in — it is the only candidate that survives U2 and U3 |
| A Node-free Svelte or Solid compiler exists as a Rust crate | Re-open, seriously. The compiled output is better than anything we will hand-write |
| The boundary types become the dominant bug source | §4.3, re-opened |

---

## 5. The sync service

*margin tab: not VPN-specific*

### 5.1 What it is

`33` §— states it in one sentence and it is worth repeating verbatim because every decision below
follows from it:

> *"A Fathom sync server is an authenticated, quota-limited, anonymous encrypted blob store."*

It does not parse configuration. It does not run rules. It does not emit. It does not search. It
cannot decrypt. `31` A1 models its operator as an adversary who learns nothing but metadata.

### 5.2 The framework

| | **Axum** | **actix-web** | **hyper alone** | **poem / salvo** |
|---|---|---|---|---|
| Dependency weight | tower + hyper + tokio — large, but shared with everything async in Rust | its own actor runtime lineage; comparable | **smallest** | comparable to Axum |
| Ecosystem for what we need (routing, extractors, body limits, graceful shutdown) | complete | complete | **we write it** | complete |
| Middleware model | `tower::Service` — the same abstraction as the rest of the ecosystem | its own | n/a | own or tower |
| Fit with "the service is 15 routes and no business logic" | good | good | **arguably the best fit, and the worst maintenance story** | good |
| Brief's stated choice | **yes** | no | no | no |

**DECISION — Axum, as the brief says.** The interesting question was hyper-alone, and the answer is
that the ~15 routes need body-size limits, timeouts, graceful shutdown, structured rejection and
request-ID propagation, all of which are tower layers we would otherwise write. `35` C1–C3 are
per-artifact caps and the sync service is a *different artifact* (A5) from the shipped core (A3), so
Axum's closure does not consume the core's budget — but it does need its own, and §7.4 sets one.

**The rule that keeps the framework choice from mattering:** the service's handlers are thin. Every
handler is *"authenticate → authorise → check quota → read/write a blob → return"*. There is no
place in the service where a framework's opinions could reach.

### 5.3 The storage engine — DECISION

Requirements first, because the usual answer (Postgres) is wrong for the deployment the product
exists for.

| # | Requirement | Source |
|---|---|---|
| S1 | Store opaque blobs, ~1 KB – 20 MB, keyed by `(account, record_id)` | `33` |
| S2 | Atomic multi-record commit — a sync push is all-or-nothing | `33` §— |
| S3 | Per-account byte quota, enforced transactionally | `33` §10.4 |
| S4 | Backup and restore by copying a file, by an operator with no database skills | the Docker single-node deployment is the flagship |
| S5 | **No C or C++**, for the same determinism and audit reasons as C7 | `35` §5.1 |
| S6 | Survives an unclean shutdown without a repair tool | on-prem, unattended |
| S7 | Scales to the enterprise cluster shape when required | brief §1 |

| | **redb** | **fjall / sled** | **SQLite via `rusqlite`** | **Postgres via `sqlx`** | **plain filesystem** |
|---|---|---|---|---|---|
| Pure Rust (S5) | **yes** | yes | **no — C library** | **yes** for the wire driver; the server is C but is not in our closure | yes |
| ACID (S2) | **yes**, MVCC over copy-on-write B+trees | LSM, atomic batches | yes | yes | **no** — we would build it |
| Single-file backup (S4) | **yes** | directory | yes | no — `pg_dump` | directory |
| Unclean shutdown (S6) | yes | yes | yes | yes | **no** |
| Cluster (S7) | **no** | no | no | **yes** | with object storage |
| Operational familiarity | low | low | **highest** | high | highest |

**DECISION — two implementations behind one `Store` trait: `redb` for the single-node deployment
(modes C and the default Docker image), and Postgres via `sqlx` for the enterprise cluster.**

```rust
/// The entire storage interface. Fifteen methods, none of which understand a
/// record's contents. If a method here ever needs to look inside a blob, the
/// zero-knowledge property has been broken by an API change.
#[async_trait]
pub trait Store: Send + Sync {
    async fn put_records(&self, acct: AccountId, batch: &[RecordWrite]) -> Result<Watermark, StoreError>;
    async fn get_records(&self, acct: AccountId, since: Watermark, limit: usize)
        -> Result<Vec<RecordRead>, StoreError>;
    async fn account_bytes(&self, acct: AccountId) -> Result<u64, StoreError>;
    // … enrolment, device registration, quota, compaction watermark, health
}
```

**The costs, and they are not small:**

| Cost | Detail |
|---|---|
| **Two implementations means two behaviours** | Isolation semantics, error mapping and quota accounting differ between an embedded B-tree and Postgres. A conformance suite (`fathom-store-conformance`) runs the same ~60 tests against both and is the only thing that keeps them honest. Budget it as real work |
| **`redb` is a smaller project than SQLite** | Fewer eyes, less deployment history. It is stable (1.0 in 2023) and its file format is documented as stable, but "battle-tested" is a word that belongs to SQLite and not to it. <!-- VERIFY: current redb major version, file-format stability statement, and any published corruption issues, before committing. --> The mitigation is that our schema is four tables and our access pattern is put/get by key — the part of any storage engine most likely to be correct |
| **Rejecting SQLite is a C7 decision, not a technical one** | SQLite is the better engine on every axis except the one that matters to this project. Say that out loud rather than pretending redb wins on merit |
| **Postgres brings an operational dependency** | Which is correct for mode D, where an operator already has one, and wrong for mode C, where they do not |

### 5.4 Deployment footprint

| Property | Target | Mechanism |
|---|---|---|
| Artifact | **one static binary** | `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`, `crt-static`. `ldd` reports "not a dynamic executable" — and that is a CI assertion, not an aspiration (`42` §9) |
| Static assets | **embedded in the binary** | The mode B–D asset tree is compiled in. `35` N6 warns that file-embedding crates record mtimes by default; ours records content only, and the embed step is `xtask`-generated Rust source with a sorted, explicit file list (N9, N17) |
| Container | `FROM scratch` + the binary + `/data` | No shell, no package manager, no libc. An operator cannot `exec` into it, which is a real operational cost and a real security property |
| Config | one TOML file plus env overrides, both fully enumerated in `--help` | No config discovery, no implicit paths, no home-directory search |
| Resident memory | Bounded by design: bodies are size-capped and streamed to the store; nothing is buffered per-account | `33`'s record sizes are hundreds of KB, so a 64 MiB body cap with 128 concurrent requests bounds the worst case around 8 GiB — which is why the cap is per-request *and* concurrency is bounded, not just the former |
| TLS | **terminated in front, by default** | The service speaks plain HTTP to a reverse proxy. Optional built-in `rustls` for the single-node case. Owning certificate renewal is not a job this service should have |
| Logging | Structured, to stdout, with a documented field list, and **no request bodies, ever** | `31` A1: logs are metadata the operator sees. What is in them is part of the threat model, so the field list is a reviewed artifact |

### 5.5 The boundary that keeps the service honest

**DECISION — `fathom-sync` must not depend on `fathom-graph`, `fathom-rules`, `fathom-emit` or
`fathom-parse`, and CI fails on the edge.**

This is the same control `24` §4.4 uses to keep `fathom-verify` from linking `fathom-ai`, applied to
a second boundary for the same reason: a dependency rule is the cheapest enforcement available and
it is checkable by a script.

The reason it matters: every feature request the service will receive — "server-side search",
"validate before accepting", "let the server tell me which devices changed", "generate a compliance
report" — is a request to link the graph into the service. The day it links, the service needs
plaintext, and the zero-knowledge property is gone. Making it a build failure means that
conversation happens in a pull request rather than in an incident review.

The service links exactly: `fathom-wire` (record framing and IDs, no semantics), `fathom-store`, and
the web stack. It cannot decode a graph because the code to decode a graph is not in the binary.

### 5.6 Costs

| Cost | Detail |
|---|---|
| The service can never help | No server-side search, no validation, no recovery, no "we can restore your workspace". `33` §— already lists this as the thing that will be asked for in every deployment |
| Two storage backends | §5.3 |
| A `scratch` container is hostile to operators | No shell for debugging. The mitigation is that the binary itself has `fathom-sync doctor`, which reports what an operator would otherwise `exec` in to find out |
| Async runtime in the closure | tokio is large. It buys nothing in the core (§7.3 excludes it) and is unavoidable in the service |

---

## 6. The CLI

*margin tab: verify as you go*

### 6.1 What it is for

Four jobs, and the fourth is the one people forget.

| # | Job | Why it needs to exist |
|---|---|---|
| 1 | **CI linting of configurations** | `fathom lint` over a repository of device configs, gating a pull request. This is how the rule packs get used by people who never open the UI |
| 2 | **Air-gapped emit and verify** | A workspace on a USB stick, a machine with no browser policy that allows it, a change window. `24` §4.4's `fathom verify` is this job |
| 3 | **Corpus authoring** | `fathom-corpus lint/check/build/query/diff-golden/coverage` — `61` §— already specifies the surface. Corpus authors are network engineers with a terminal, not a web app |
| 4 | **`fathom serve`** | `34` §3.3 makes mode B — the offline deployment that actually holds a workspace — *a static bundle served from loopback by the CLI*. The CLI is not an accessory to the browser product; it is how the browser product is delivered in its most security-sensitive mode |

### 6.2 The surface

```text
fathom serve            [--port 7440] [--bind 127.0.0.1] [--workspace FILE]
fathom lint             FILE... [--platform junos-srx] [--pack PACK] [--format text|json|sarif]
                        [--fail-on high|medium|low] [--suppressions FILE]
fathom emit             --workspace FILE --device NAME [--platform P] [--depth terse|explained]
fathom explain          --line "set security ipsec policy P perfect-forward-secrecy keys group14"
fathom find             "check if a tunnel is up" [--platform junos-srx] [--workspace FILE]
fathom ingest           FILE [--split] [--workspace FILE]
fathom diff             --from FILE --to FILE [--verify] [--rollback]
fathom verify           --workspace FILE [--no-ai]        # 24 §4.4
fathom pack             verify|info PACK.fpack
fathom doctor           # environment, toolchain identity, build identity, pack signatures
```

**Exit codes are an interface and are pinned forever:**

| Code | Means |
|---|---|
| 0 | success; no finding at or above `--fail-on` |
| 1 | findings at or above the threshold |
| 2 | usage error |
| 3 | input rejected — over a cap, unparseable, wrong platform |
| 4 | integrity failure — bad signature on a pack, bad AEAD tag on a workspace |
| 5 | internal error (a bug); the only code that should ever be accompanied by "please report this" |

**The terminal rendering follows the field card, not a CLI framework.** Three colours, the same three
meanings, the same legend line:

```text
READ-ONLY — SAFE ON PRODUCTION    CHANGES CONFIG — NEEDS A COMMIT    DISRUPTIVE — DROPS LIVE TRAFFIC
```

rendered as ANSI 24-bit colour from the exact hex values in the conventions, suppressed entirely when
`NO_COLOR` is set or stdout is not a TTY. Findings render as the card's two-column tables: left is the
lookup key, right is the answer, horizontal rules only.

### 6.3 Why sharing the core makes it nearly free — and the part of "nearly" that is not

The `emit`, `lint`, `find`, `explain`, `diff` and `verify` verbs are `fathom-core` function calls. On
the native target the core compiles without the WASM shims and gains real file I/O and real threads.
So the *logic* is free.

**What is not free:**

| Item | Cost |
|---|---|
| Argument parsing | `clap` is the obvious answer and it is a proc macro and a nontrivial closure. It is in the CLI's budget, not the core's (§7.4), which is the reason those budgets are separate |
| Terminal rendering | Table layout, width measurement, colour capability detection, `NO_COLOR`, pagers. A few hundred lines and a surprising amount of fiddling |
| Exit-code semantics and `--format sarif` | SARIF because that is what CI systems ingest; getting it right is a schema exercise, not a rendering one |
| Three target triples and their release engineering | `35` §2.3: macOS notarisation and Windows Authenticode both break byte reproducibility, so the manifest carries the unsigned digests. That is process work per release, forever |
| Man pages and shell completions | Generated, but generation is a build step and completions are a support surface |
| **The double surface** | Every new capability now has two front ends. A flag that exists in the CLI and not in the UI is a support question; the reverse is a gap in CI coverage |

Realistically: **the CLI is 10–15 % of the product's effort, not the 2 % that "it's the same core"
implies.** Saying 2 % is how a CLI ships with a good engine and an unusable interface.

### 6.4 A worked example, from the field card

The card's most-missed item is `#3` — the WAN zone must accept IKE, or *"Phase 1 times out with
nothing useful in the log — the box drops the peer's IKE before processing it."* That is a rule
(`zone.host-inbound.ike-missing`, per the conventions' rule-ID examples) and this is the CI gate that
catches it before a change window rather than during one:

```yaml
- name: Fathom lint
  run: |
    fathom lint configs/**/*.set \
      --platform junos-srx \
      --pack packs/fathom.ipsec-2.9.0.fpack \
      --format sarif --output fathom.sarif \
      --fail-on high \
      --suppressions .fathom/suppressions.yaml
```

```text
▌ HIGH   zone.host-inbound.ike-missing            edge-fw-01 · zone WAN
  Zone WAN carries the IKE gateway's external-interface (reth0.0) but does not
  permit host-inbound system-services ike.
  SYMPTOM   Phase 1 times out with nothing in the log; the box drops the peer's
            IKE before processing it.
  FIX       set security zones security-zone WAN interfaces reth0.0 \
              host-inbound-traffic system-services ike        [CHANGES CONFIG]
  WHEN OK   Peer IKE arrives on a different zone, or a firewall filter on the
            interface already permits UDP 500/4500 to the local address.
```

Note what that output is made of: `symptom_if_mismatched`, `remediation`, `acceptable_when` — the
rule-pack fields the brief §5.2 requires, rendered in the card's voice, with the `Risk` legend on the
remediation line because it is a command someone will paste. Nothing there is CLI-specific. It is the
same three fields the browser renders, which is §2.3 in practice.

### 6.5 Costs

| Cost | Detail |
|---|---|
| `fathom serve` makes the CLI load-bearing for a *browser* deployment | Mode B's security depends on a binary the user has to run, which some environments will not permit. `34` §3.2 already prices this |
| A CLI is a support surface | Terminal emulators, locales, Windows path handling, PowerShell quoting. None of it is interesting and all of it is real |
| Three triples | §6.3 |

---

## 7. The crate list for the core

*margin tab: fewest that works*

`35` §5.3 requires nine questions answered in `deps/decisions/<crate>.md` for every dependency. This
section is the summary; the files are the record.

### 7.1 The direct dependencies of the shipped core (A3/A4)

| Crate | Publisher (`35` §5.2) | What it does that we cannot do in 200 lines | Proc macro? | `build.rs`? |
|---|---|---|---|---|
| `chacha20poly1305` | RustCrypto | AEAD. `32` D3 | no | no |
| `chacha20` | RustCrypto | stream cipher under the AEAD | no | no |
| `poly1305` | RustCrypto | MAC under the AEAD | no | no |
| `argon2` | RustCrypto | Memory-hard KDF. Absent from WebCrypto; this is the reason WASM is unavoidable (§2.1) | no | no |
| `hkdf` | RustCrypto | Key derivation, RFC 5869 | no | no |
| `sha2` | RustCrypto | Under HKDF and HPKE | no | no |
| `subtle` | RustCrypto | Constant-time comparison. **Do not hand-roll**; the compiler is the adversary here | no | no |
| `hpke` | single maintainer — flagged, `35` §5.2 | Sync's key encapsulation. `32` §15.1 already argues against a second implementation | no | no |
| `x25519-dalek` | dalek-cryptography | ECDH | no | no |
| `ed25519-dalek` | dalek-cryptography | Signature verification for rule packs | no | no |
| `curve25519-dalek` | dalek-cryptography | under both | no | no |
| `blake3` | BLAKE3 team | Content hashing (`12` §13.2). Fast, tree-structured, one implementation | no | **yes** — C4 |
| `minisign-verify` | single maintainer — flagged | Rule-pack signature verification, the crate that decides what is trusted. `35` §5.8: **audit it ourselves and record the audit** | no | no |
| `getrandom` | rust-lang | Platform CSPRNG, with our custom backend on WASM (§3.7) | no | no |
| `fst` | BurntSushi | Finite-state transducer for the finder's term dictionary and command index; memory-mappable, ordered prefix streaming, optional Levenshtein automaton. `16` §— depends on it structurally | no | no |
| `memchr` | BurntSushi | SIMD-ish substring/byte search in the tokeniser. The naive version is 200 lines and much slower on the 32 MB path | no | no |
| `unicode-normalization` | unicode-rs | NFC normalisation on ingest (`34` §5.5). Correctness here is a table, not an algorithm, and the table is the crate | no | no |
| pure-Rust zstd | single maintainer — flagged | Section compression (`11` §14.1), `.fpack`, finder `TEXT` blocks. `35` N14 makes the pin the whole determinism control | no | no |
| `thiserror` | dtolnay | Error enum derivation | **yes** — C5 | no |
| `wasm-bindgen` | rustwasm | WASM target only: module scaffolding. **Not** on the data path (§3.7) | **yes** — C5 | no |

**Twenty direct dependencies against a cap of thirty (C1 ≤ 30).** Ten headroom, and §7.3 is the list
of things that will try to consume it.

<!-- VERIFY: confirm that a pure-Rust zstd **encoder** of production quality exists at the version
     `35` N14 assumes. Several well-known pure-Rust zstd crates are decoder-only. If no adequate
     pure-Rust encoder exists, the options are (a) use the pure-Rust decoder and a different
     pure-Rust encoder for the compression side, (b) drop compression to raw deflate with a pure-Rust
     implementation, or (c) revisit C7 for the compressor alone — and (c) should be refused. This
     affects `11` §14.1, `12` §13.1, `16` §9.5 and `35` N14, and all four should be updated from one
     answer. -->

### 7.2 The things we write instead of depending on

Each of these is a `35` §5.3 question-1 answer: *what does it do that we cannot do in under 200
lines?* — where the answer was "nothing we need".

| Instead of | We write | Lines | Why |
|---|---|---|---|
| `ulid` | ULID generation + Crockford base32 | ~120 | `35` §5.2 already names this. We need monotonic-in-time generation with the conventions' exact ID format, which the crate does not encode |
| `ciborium` / `minicbor` | Canonical CBOR encoder/decoder for our subset | ~600 | Our subset is: unsigned ints, negative ints, byte strings, text strings, arrays, maps with `u16` keys, `null`, `true`/`false`. **No floats, no tags, no indefinite lengths, no bignums.** RFC 8949 §4.2 deterministic encoding over that subset is small and it is *ours to guarantee*, which invariant 9 requires. See the cost note below |
| `serde` + `serde_derive` | Nothing — types encode themselves through a generated `Codec` impl | — | `serde` is the single largest transitive block in most Rust projects and it exists to solve a problem we do not have: we have exactly one wire format and it is not self-describing by name |
| `uuid` | — | — | ULIDs, per the conventions |
| A JSON library | The `--format json` writer in the CLI only, ~150 lines | ~150 | JSON never touches the core or the workspace. It is an output format for CI consumption |

**The cost of the first-party CBOR codec, stated because it is the most arguable item in this
document:** it parses attacker-controlled bytes. A workspace file someone sends you is hostile input
in exactly the way a pasted config is. Writing our own decoder means owning every bug in it.

The controls: `#![forbid(unsafe_code)]`; no recursion (an explicit depth-bounded stack, depth cap 32,
same discipline as `14` §11.6); a `cargo-fuzz` target that runs on every commit and in a nightly
long-run; and a **differential test against a third-party CBOR crate held in `dev-dependencies`
only** — encode with ours, decode with theirs, and vice versa, over a generated corpus. That last one
is the control that makes this defensible rather than reckless, and if it ever finds a structural
divergence we have adopted the crate and lost nothing but a week.

### 7.3 Explicitly rejected, with the reason, so they are not added by reflex

| Crate | Why not |
|---|---|
| `serde` / `serde_json` | §7.2. And JSON in the core would be a second wire format with no canonical form |
| `regex` | The parsers are hand-written state machines (`14` §—) because they must produce spans and provenance, which a regex cannot. A regex engine in the closure is a large dependency serving nothing. Rule conditions are a bytecode (`12` §—), not regexes |
| `chrono` / `time` | Timestamps are `u64` milliseconds. Formatting happens at the UI and the CLI. A date library in the core is a determinism hazard and a locale dependency |
| `rand` | `32` §5 forbids a userspace PRNG anywhere near key material, and nothing else in the core needs randomness |
| `anyhow` | Errors that cross the boundary are enums with stable codes (§3.9). `anyhow` erases exactly the type information the boundary needs |
| `tokio` | The core is synchronous. Async in a WASM module with a coarse call boundary buys nothing and costs a large closure |
| `petgraph` | Our graph is typed with bucketed adjacency and a fixed edge-kind enum (`11` §—). A general graph library would be a second, weaker representation |
| `log` / `tracing` | The core does not log. It returns structured results. The *service* logs, and that is a different artifact's budget |
| `wee_alloc` | **Unmaintained** (RustSec advisory; repository archived 2025) and has a known leak. Use the default `dlmalloc`; evaluate `talc` only if measurement shows the allocator is material to module size. <!-- VERIFY: measure default dlmalloc vs talc on the real module before switching; the size difference is the only reason to consider it. --> |
| `js-sys` / `web-sys` | §3.7 keeps them out of the core. The UI reaches the DOM from TypeScript |

### 7.4 Cap accounting

Per artifact, because the caps are per-artifact.

| | A3 core (WASM) | A4 CLI | A5 sync service |
|---|---|---|---|
| C1 direct ≤ 30 | **20** (§7.1) | 20 + `clap` + terminal + SARIF writer ≈ **24** | separate budget: axum, tower, hyper, tokio, rustls, redb, sqlx, serde (for config only) ≈ **14** |
| C2 closure ≤ 160 | dominated by RustCrypto + dalek + `wasm-bindgen`'s macro chain. **Estimate 90–130** | +15 | **Not covered by C2.** tokio + hyper + sqlx alone is well over 160 |
| C3 publishers ≤ 25 | RustCrypto, dalek, BLAKE3, BurntSushi, unicode-rs, rust-lang, dtolnay, rustwasm, hpke author, zstd author, minisign author = **11** | +2 | +6 or so |
| C4 `build.rs` ≤ 12 | `blake3` and little else. **Estimate 2–5** | same | more |
| C5 proc macros ≤ 10 | `thiserror`, `wasm-bindgen-macro` and their `syn`/`quote` chain. **Estimate 3–5** | +`clap_derive` | +`sqlx` macros |
| C7 no C/C++ | **holds**, subject to the zstd VERIFY above | holds | holds — Postgres is a *server*, not a linked library; `sqlx`'s Postgres driver is pure Rust |

**The honest note on the sync service.** `35`'s C2 ≤ 160 cannot be met by any Axum service, and
pretending otherwise would be exactly the kind of number-gaming `35` §5.6 warns about.

**Proposed addition to `35` §5.1:** the caps apply per artifact, and A5 gets its own row — say
**C2-sync ≤ 320 closure, C3-sync ≤ 35 publishers** — with the justification that A5 is a server-side
artifact that never touches plaintext, never runs on a user's machine, and whose compromise is
already modelled (`31` A1, row 1) as revealing only ciphertext and metadata. That is a materially
different risk profile from A3, which runs in a page holding a decrypted estate, and one number for
both understates one and overstates the other.

---

## 8. Repository layout

*margin tab: fields that matter*

### 8.1 The tree

```text
fathom/
├─ Cargo.toml                     # [workspace], resolver = "2", shared [workspace.dependencies]
├─ Cargo.lock                     # committed
├─ rust-toolchain.toml            # exact patch pin (35 §3.2)
├─ deny.toml                      # cargo-deny: advisories, licences, bans, sources
├─ supply-chain/                  # cargo-vet audits and imports
├─ deps/
│  ├─ decisions/<crate>.md        # 35 §5.3's nine questions, one file per dependency
│  └─ build-scripts.md            # 35 §5.7's enumeration
├─ build/
│  ├─ toolchain.lock.toml         # 35 §3.2
│  ├─ assets.toml                 # the explicit, ordered asset manifest (35 N17)
│  └─ repro.sh                    # the ladder in 35 §4.1
├─ crates/
│  ├─ fathom-id/                  # ULID, NodeId, RuleId, CommandId. No deps but getrandom.
│  ├─ fathom-cbor/                # canonical CBOR subset codec (§7.2). No deps.
│  ├─ fathom-wire/                # record framing, envelope header, watermarks. id + cbor.
│  ├─ fathom-graph/               # the IR: nodes, edges, fields, provenance, L0 invariants (11)
│  ├─ fathom-ops/                 # the op set + the hand-rolled CRDT (33 §4.3)
│  ├─ fathom-corpus/              # corpus types, loader, index builder; the authoring CLI (61)
│  ├─ fathom-rules/               # rule bytecode, the engine, findings, suppressions (12)
│  ├─ fathom-emit/                # emitters, (line, provenance) pairs, wrap style (13)
│  ├─ fathom-parse/               # tokenise → shape → walk → bind; the hostile-input crate (14)
│  ├─ fathom-find/                # finder: FST, postings, BM25F, fusion (16)
│  ├─ fathom-layout/              # deterministic diagram layout (§4.5b)
│  ├─ fathom-crypto/              # envelope, KDF, AEAD, HPKE; 32's primitives, nothing else
│  ├─ fathom-core/               # the façade: open/apply/query/emit/lint/seal. The only crate
│  │                             # the hosts link. Re-exports nothing internal.
│  ├─ fathom-wasm/                # the ABI (§3.7). cdylib. ~300 lines, the only unsafe.
│  ├─ fathom-cli/                 # the `fathom` binary (§6)
│  ├─ fathom-audit/               # reads sessions/proposals/egress records. core ONLY (24 §4.4)
│  ├─ fathom-verify/              # the `fathom verify` binary. core + audit. NEVER ai (24 §4.4)
│  ├─ fathom-ai/                  # the AI layer. Depends on core. NOTHING depends on it (21 §2.1)
│  ├─ fathom-store/               # the Store trait + redb and Postgres impls (§5.3)
│  ├─ fathom-sync/                # the Axum service (§5). NEVER graph/rules/emit/parse (§5.5)
│  ├─ fathom-pack/                # .fpack build and verify (35 stage 9)
│  └─ fathom-store-conformance/   # dev-only: the ~60 tests both Store impls must pass
├─ xtask/                         # the build driver: ui-build, assemble, sbom, manifest,
│                                 # gen-types, gen-packed, check-deps  (§8.4)
├─ ui/
│  ├─ src/
│  │  ├─ boundary/                # wasm.ts, corpus.ts, tt.ts — the only files that may
│  │  │                           # create views, launder Untrusted, or create a TT policy
│  │  ├─ ui/                      # dom.ts, list.ts, store.ts — the render layer (§4.4)
│  │  ├─ views/                   # one module per view; mount(parent, props)
│  │  └─ generated/               # types.ts, packed.ts — from xtask gen-*; CI-checked
│  ├─ styles/                     # hand-written CSS; the palette is a closed set
│  └─ tsconfig.json               # strict, noEmit; the compiler is a gate, not a producer
├─ corpus/                        # authored YAML (61, 63). Not code.
├─ fixtures/                      # captures, workspaces, golden emit output
└─ docs/                          # this
```

### 8.2 The crate boundaries that are enforced, not merely intended

| Edge | Rule | Enforced by |
|---|---|---|
| `fathom-ai` ← anything | **Nothing depends on `fathom-ai`** | `21` §9.5; `xtask check-deps` fails on any incoming edge |
| `fathom-verify` → `fathom-ai` | **Never linked** | `24` §4.4; plus a symbol-table assertion in the built binary |
| `fathom-audit` → anything but `fathom-core` | Forbidden | `24` §4.4 |
| `fathom-sync` → `fathom-graph`/`-rules`/`-emit`/`-parse` | **Forbidden** | §5.5; `xtask check-deps` |
| `fathom-parse` → `fathom-emit` | Forbidden — parsing must not be able to reach the emitter | `xtask check-deps` |
| `fathom-cbor`, `fathom-id` → anything | **No dependencies at all** (except `getrandom` in `fathom-id`) | They are the base of the DAG; keeping them leaf-free is what makes them fuzzable in isolation |
| Any crate → `std::collections::HashMap` **iterated** | Forbidden in output paths | A clippy lint plus a grep gate; `BTreeMap` or an explicit sort (`35` N8) |
| Any crate → `unsafe` | `#![forbid(unsafe_code)]` at the workspace root; `fathom-wasm` is the single documented exception | Compiler |

`xtask check-deps` reads `cargo metadata` and asserts the edge list against a checked-in file. It is
forty lines and it is the cheapest architectural control in the repository — the same argument `24`
§4.4 makes.

### 8.3 Feature flags

**DECISION — no default features anywhere in the workspace, and no feature may change observable
output.**

| Rule | Reason |
|---|---|
| Every workspace crate declares `default = []` | A feature that is on by default is a feature nobody audits |
| Features select *targets and hosts*, never *behaviour*: `wasm`, `native`, `serve`, `store-redb`, `store-postgres` | A feature that changes an emitted line means two builds of the same tag emit differently, which is invariant 9 gone |
| `cargo-deny` and the SBOM run against **the same feature resolution as the build** | `35` §5.5 already requires this; feature-dependent closures are how a dependency audit checks the wrong graph |
| CI builds `--no-default-features` and the exact shipped feature set, and diffs the resulting closures | Catches a feature leaking a dependency into the shipped artifact |

### 8.4 `xtask`, and the generated boundary types

`xtask` is a plain binary in the workspace, run as `cargo run -p xtask -- <cmd>`. It is the build
system. There is no `make`, no shell pipeline, no npm script.

| Command | Does | Corresponds to |
|---|---|---|
| `gen-types` | Rust boundary types → `ui/src/generated/types.ts` | §2.5's drift control |
| `gen-packed` | The T2 record schema → Rust writer + TS `DataView` reader | §3.3 |
| `ui-build` | `oxc` transform + minify; `lightningcss` | `35` stage 7 |
| `assemble` | A1 single file, A2 asset tree, CSP hashes over final bytes | `35` stage 10 |
| `sbom` / `manifest` | A8/A9, A10 | `35` stages 12–13 |
| `check-deps` | The edge list in §8.2, plus the C1–C7 caps | `35` §5.1 |

**The generated-types rule:** `xtask gen-types` output is **committed**, and CI fails if regenerating
produces a diff. Generated-but-committed beats generated-at-build for three reasons: a reviewer sees
the boundary change in the diff, the TypeScript build does not depend on the Rust build, and a
`git bisect` across a boundary change is possible.

---

## 9. What this costs, added up

### 9.1 The stack's standing costs

| Cost | Who pays it, and when |
|---|---|
| Release builds are minutes, doubled by the R1 rebuild | CI, every release |
| Two languages, two test harnesses, one boundary | Every feature that touches both sides, forever |
| A ~950 KB base64 WASM blob in the single-file artifact | Every mode-A user, on every download |
| No framework: every UI problem is ours | The UI author, continuously |
| Two storage backends behind one trait | The service maintainer, plus a 60-test conformance suite |
| Three CLI target triples with two non-reproducible signing paths | Release engineering, every release |
| A small hiring intersection and a real bus factor | The project, permanently |

### 9.2 The not-invented-here ledger

This is the part that is easy to under-count, because each decision is individually correct and the
total is what kills projects. Every line below was chosen for a stated reason elsewhere in the corpus;
the point of the table is the last row.

| Component | Est. lines | Decided in | Would otherwise be |
|---|---|---|---|
| Canonical CBOR subset codec | 600 | §7.2 | `ciborium` / `minicbor` |
| ULID + Crockford base32 | 120 | `35` §5.8 | `ulid` |
| Op-based CRDT over the typed graph | 1,500–2,500 | `33` §4.3 | Automerge / Loro |
| DOM render layer + keyed reconciler | 600–800 | §4.4 | Preact / Lit |
| Virtualised table | 400 | §4.5a | any of a dozen libraries |
| Diagram layout | 800–1,500 | §4.5b | ELK / dagre (both JS) |
| Packed T2 codec (writer + reader) | 350 | §3.3 | FlatBuffers / rkyv |
| Finder: FST index, BM25F, fusion | 2,000+ | `16` | a search library |
| Rule bytecode + engine | 1,500+ | `12` | a rules engine |
| Parsers | 3,000+ | `14` | there is no alternative — nobody ships this |
| **Total first-party code replacing third-party code** | **≈ 11,000–13,000 lines** | | |

**That is the real number, and it deserves to be looked at rather than justified.** Eleven thousand
lines of infrastructure is roughly a person-year of writing and an indefinite maintenance
obligation, and it is the price of C1–C7, invariant 9 and `34` §8.1 taken together.

Two things make it survivable, and they should be stated as conditions rather than as reassurances:

1. **Most of it is not optional.** The parsers, the rule engine, the finder and the CRDT are the
   product; no library exists that does them for this domain. The genuinely elective items are the
   CBOR codec, the render layer, the table and the packed codec — about 2,400 lines.
2. **Every elective item has a named exit.** §4.7 for the render layer, §7.2's differential test for
   the codec, `33` §4.2 for the CRDT. An NIH decision with no exit criterion is how this number
   doubles.

**RECOMMENDATION — track this table in the repository and review it quarterly.** If it passes 16,000
lines without a feature to show for it, the dependency caps are buying less than they cost.

---

## 10. Open decisions

| # | Question | Current lean | Blocked on |
|---|---|---|---|
| 1 | Pure-Rust zstd encoder — does an adequate one exist? | Assume yes, per `35` N14 | Measurement. This is the highest-priority VERIFY in the document because four other documents depend on it |
| 2 | `getrandom` custom backend vs `wasm_js` (§3.7) | Custom backend, for the two-import property | Confirming the 0.3.x mechanism against `32`'s pinned version |
| 3 | Per-artifact dependency caps for A5 | Propose C2-sync ≤ 320, C3-sync ≤ 35 | `35`'s owner |
| 4 | `redb` vs SQLite, if C7 were relaxed for the service only | Keep redb; C7's determinism argument is weaker for A5 but the audit argument is not | An operator's opinion, which we do not have yet |
| 5 | Diagram layout: build layered layout, or ship drag-only first | Drag-only first (§4.5b) | Nothing. This is a scoping call |
| 6 | Solid's compiled output under Trusted Types | Assume it uses template cloning | Ten minutes with the compiler; if it has a compliant mode, §4.2's row changes and Solid becomes a live candidate on everything except the Node build |
| 7 | Whether the AI layer's crates change the C1 count for A3 | They should not — `21` tier 0 is the default and `fathom-ai` is not linked | `21` §7 |

---

## 11. Sources

| Claim | Source |
|---|---|
| `wasm-bindgen` copies strings between the JS heap and linear memory using `TextEncoder`/`TextDecoder`; per-string decode has a high constant cost largely independent of length, which is why batching into one decode is the documented optimisation | [wasm-bindgen guide — `str`](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/str.html); [sledgehammer_bindgen](https://github.com/ealmloff/sledgehammer_bindgen) |
| `getrandom` does not support `wasm32-unknown-unknown` automatically because the target name does not imply a JS interface; a custom backend mechanism exists for exactly this case | [getrandom docs](https://docs.rs/getrandom/latest/getrandom/); [rust-random/getrandom](https://github.com/rust-random/getrandom) |
| `wee_alloc` is unmaintained (RustSec advisory) and its repository is archived; `talc` and `lol_alloc` are the alternatives, and the default `dlmalloc` is the conservative choice | [RUSTSEC-2022-0054](https://rustsec.org/advisories/RUSTSEC-2022-0054.html); [talc WASM notes](https://github.com/SFBdragon/talc/blob/master/talc/README_WASM.md); [lol_alloc](https://crates.io/crates/lol_alloc) |
| Lit creates a Trusted Types policy named `lit-html` and routes template HTML through it, because templates are parsed with `innerHTML` before interpolation | [lit/lit PR #970](https://github.com/lit/lit/pull/970); [lit-html source](https://github.com/lit/lit/blob/main/packages/lit-html/src/lit-html.ts) |
| Svelte's default compilation emits `innerHTML` assignments that violate `require-trusted-types-for 'script'`; a compiler option builds fragments element-by-element instead, which is slower and works everywhere | [sveltejs/svelte#10826](https://github.com/sveltejs/svelte/issues/10826); [svelte compiler docs](https://svelte.dev/docs/svelte/svelte-compiler) |
| Dioxus reports a `trunk build --release` hello world with `lto = true`, `opt-level = "z"` at 275 KB, with sub-100 KB achievable using nightly features; Leptos publishes a binary-size optimisation guide | [Dioxus optimizing guide](https://dioxuslabs.com/learn/0.7/guides/tips/optimizing/); [Leptos binary size](https://book.leptos.dev/deployment/binary_size.html) |
| `redb` is a pure-Rust embedded key-value store with ACID transactions, copy-on-write B+trees, MVCC and zero-copy reads; 1.0 declared the file format stable | [redb](https://www.redb.org/); [cberner/redb](https://github.com/cberner/redb) |
| SQLx's PostgreSQL driver is pure Rust with no C dependency; its SQLite driver uses the C library | [SQLx](https://github.com/launchbadge/sqlx) |
| `fst` provides an FST-backed ordered key set with prefix streaming and optional Levenshtein automata, constructible for memory-mapped use | [BurntSushi/fst](https://lib.rs/crates/fst) |
| Lightning CSS is a Rust CSS parser/transformer/minifier usable as a library crate, built on Mozilla's `cssparser` and `selectors` | [Lightning CSS](https://lightningcss.dev/); [parcel-bundler/lightningcss](https://github.com/parcel-bundler/lightningcss) |
| `oxc_minifier` is a Rust-crate JS/TS minifier; maturity at a given version is the open question, not its existence | [oxc_minifier](https://crates.io/crates/oxc_minifier) |
| Canonical/deterministic CBOR encoding is specified in RFC 8949 §4.2 | RFC 8949 §4.2 |
| HKDF is RFC 5869; ChaCha20-Poly1305 is RFC 8439 | RFC 5869; RFC 8439 |

Field-card material used above — the object chain, the five plumbing pieces, `host-inbound-traffic
system-services ike`, the bring-up ladder, the three-colour legend and the continuation-backslash
wrapping — is from `.context/field-card-srx-ipsec.txt`, sides 1 and 3.

---

## 12. Disagreements

**With the conventions: none.** The terminology table, the three-value risk enum, the ID formats and
the invariants are used as written.

**With other documents in this corpus, two, both stated as proposed changes rather than deviations:**

1. **`35` §5.1's caps are written as if there were one artifact.** C2 ≤ 160 and C3 ≤ 25 are correct
   and valuable for A3, the WASM core that runs in a page holding a decrypted estate. They are not
   achievable for A5, the Axum sync service, and no honest Axum build will meet them. §7.4 proposes
   per-artifact rows with a stated justification. Leaving one number covering both would mean either
   an unachievable cap that gets quietly ignored — `35` §5.2's own warning — or a raised cap that
   weakens the number where it matters.

2. **`34` §8.3 check 1 assumes a `package.json` exists** (*"`dependencies` in `package.json` is
   `{}`"*, with everything in `devDependencies`), while `35` §5.1 C6 sets **npm packages at any stage
   to zero**. Those cannot both be true. `42` §9 resolves it in `35`'s favour and restates the check
   as *"no `package.json`, no `package-lock.json` and no `node_modules` exists anywhere in the
   repository or the build container"*, which is strictly stronger and easier to verify. `34`'s check
   1 should be replaced with that wording.
