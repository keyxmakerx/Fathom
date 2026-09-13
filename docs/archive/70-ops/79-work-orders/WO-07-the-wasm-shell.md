# WO-07 — The WASM shell and the artifact gates

> **Status:** DONE

Depends on: nothing in the queue. The finder core (`fathom-corpus`, `fathom-find`) is merged on
`main` and this work order builds on it as it stands. UI consumption of the module — the artifact
assembly, the CSP, the TypeScript reader — is WO-08's problem, not this one's.

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

When this work order is done, the finder runs as WebAssembly: a new crate `crates/fathom-wasm`
compiles to `wasm32-unknown-unknown` under the pinned 1.94.1 toolchain and exposes `41` §3.7's raw
`(ptr, len)` ABI — `fathom_alloc` / `fathom_free` / `fathom_call`, opcodes `OP_INIT` (load a corpus
from bytes) and `OP_QUERY` (query in, packed ranked rows out, mirroring the `fathom-find` CLI's
output contract) — in safe Rust, with zero new dependencies and zero JS glue. The two artifact
gates the security corpus specifies for the module become real, runnable, and green: the **import
audit** (`34` §7.5, `42` §9.4 check 5 — here asserting the stronger fact that the import section is
*empty*, because the finder needs neither entropy nor time) and the **size gate** (`44` §5.2's
900 KB WASM ceiling), both implemented as a first-party test that parses the `.wasm` binary itself
— no `wasm-objdump`, no `twiggy`, no tool download. This is the bridge from crates to product:
`34` §2.6's grant is honest here because *"a WebAssembly instance has no ambient authority … 
Everything it can touch, it touches through imports that the calling JavaScript supplies"* — and
this module supplies none to be steered through. The HTML artifact around the module, and the CSP
gate X0.8 that runs against its final bytes, are WO-08's; what WO-08 receives from here is a
module whose import section proves the no-egress claim structurally.

## 2. Binding sources

| Source | What it binds | The line that binds |
|---|---|---|
| `34` §7.5 | The import-audit mechanism, quoted whole | *"`wasm-objdump -x fathom_core.wasm`, read the import section, and assert every entry is in a committed allowlist of glue functions. **No import may be capable of originating a network request.** This is the check that makes `connect-src 'none'` an architectural property rather than a header"* |
| `34` §7.5 | Exports are capability grants; the module ships stripped | *"Every export is callable by any script in the origin (`31` §4.3), so an export is a capability grant"*; *"ship stripped, publish the symbols separately"* |
| `34` §10.5 H39 | The checklist form of the import audit | *"WASM import allowlist … compare to the committed allowlist … \[fails when\] Any unexpected import"* |
| `38` §2 G1 | The allowlist's committed contents, and its status as an architectural property | *"The WASM core contains no import capable of originating a network request. Allowlist is `fathom_entropy` and `fathom_now_ms`"* |
| `71` §3.6 X0.8, X0.9 | The two browser-artifact ship gates this WO does **not** deliver (§8) | X0.8: *"CSP of the shipped artifact contains `connect-src 'none'`, asserted against the final bytes, not the template"*; X0.9: *"No network request is issued in a 30-minute scripted session. Verified by a proxy that fails the test on any connection attempt"* |
| `41` §3.2 | The full core's import census is exactly two (X13 `entropy`, X14 `now_ms`), and the property is publishable | *"Two imports, and that is the whole import section."* — and X14 is *"provenance timestamps only"*, X13 *"per seal, per ID batch"*: the finder does neither |
| `41` §3.7 | The ABI: names, opcodes, reply-arena lifetime, error model | *"**DECISION** — a raw `(ptr, len)` ABI over ten exports and two imports"*; *"The reply lives in a module-owned arena that is valid until the *next* `fathom_call`"* |
| `41` §3.3 | The T2 packed reply skeleton and the risk byte mapping | the fenced layout (`magic 'F' 'D' 'L' 'T'` …, `record_kind` … `3=FinderRow`); *"`risk: u8, // Risk: 0 ReadOnly, 1 ChangesConfig, 2 Disruptive`"* |
| `41` §3.9 | No exceptions cross the boundary | *"**No exceptions cross the boundary. Ever.**"* |
| `42` §9.4 checks 5, 6 | The CI form of the import/export audits, and the committed list this WO's empty set sits under | check 5: *"import section compared to a committed list — currently `fathom_entropy`, `fathom_now_ms`"* |
| `42` §9.3 | What the audit converts the claim into | *"**structural** — the WASM module imports two functions, neither capable of a request"* |
| `44` §5.2 | The size numbers that bind, and their arming state | *"**Hard ceiling** ≤ **900 KB** \[uncompressed\] — fails the merge"*; §5.5: *"The absolute ceilings are not armed until the phase-0 WASM measurement lands (ADR-0017)"* |
| `43` §3.5 | The deployment shape the module ultimately lives in (D1) | *"`fathom-<ver>.html` is a complete product for one session … When the tab closes, the origin holds nothing, because the origin never held anything."* |
| `43` §3.7 | D1's CSP — the policy WO-08's artifact must carry, restated so this WO builds nothing that needs more | `script-src 'sha256-REPLACED_AT_BUILD' 'wasm-unsafe-eval'; … connect-src 'none'` |
| `46` §1 row 1 | The fallback origin when `file://` fails | *"`fathom serve` (D4 subcommand, loopback-only, no workspace passes through it — `34` §3.6) is the only tolerated process, and only as the fallback origin"* |
| `Cargo.toml` (workspace comment) | The dependency position this WO's no-glue decision follows | *"No external dependencies anywhere in the workspace yet. That is a position, not an accident"* |
| `78` §2 | Everything inherited: invariants 1–3 and 9, zero dependencies, the 1.94.1 pin, no unsafe, the risk enum, severity labels, house style | (whole table) |

## 3. Prior state

All verified against the working tree at authoring time (2026-08-02; `cargo test --workspace`
80 passed, 0 failed across all suites; `fathom-schema-check` exit 0, `0 failure(s), 2 warning(s)`).

- `Cargo.toml`: six members (`fathom-corpus`, `fathom-find`, `fathom-id`, `fathom-ir`,
  `fathom-schema`, `fathom-schemagen`); `[workspace.dependencies]` empty with the quoted comment;
  **no `[profile.release]` section exists**.
- `rust-toolchain.toml`: `channel = "1.94.1"`, `components = ["rustfmt", "clippy"]`, **no
  `targets` key**.
- `crates/fathom-find/src/lib.rs`: `Finder::new(index: CorpusIndex)`,
  `Finder::search(&self, query: &str) -> SearchResult`; `SearchResult { shown: Vec<Ranked>,
  below: Vec<Ranked>, g_syn: f64, query_concepts: ConceptQuery, reverse: Option<ReverseHit>,
  filter_clause: Option<String>, ladder_group_trigger: bool }`; `Ranked { entry: u32,
  score_milli: i32, contributions: Contributions }`; `Contributions { concept, lexical, syntax,
  context, prior: f64 }`; quantisation is `(total * 1000.0).round() as i32`;
  `CONFIDENT_MILLI = 2500`; the below list caps at 5, shown at `MAX_ROWS = 25`.
- `crates/fathom-find/src/bin/fathom-find.rs`: the CLI contract this WO's reply mirrors. Per row:
  score (`score_milli / 1000` at 2 dp), `display_cmd`, `e.risk.label()`, `e.id`, the
  below-the-confident-band marker, the five contributions, `e.answers`, `read: {e.read_field}`,
  `if bad: {first next_if_bad}`. Query-level: `g_syn`, the query-concept line, the ladder note,
  the reverse block (`display_cmd`, entry id, `{slot} := {value}` captures, `not in corpus:`
  leftover, the filter clause). `--why` adds per-term/per-concept rows.
- `crates/fathom-corpus`: `CorpusIndex::load(&Path)` = `load_corpus(root)` (filesystem: `yaml_files`
  sorted listing over `commands/`, `explainers/`, `rules/`; `parse_file` = `fs::read_to_string` +
  `parse_profile(source, Profile::Corpus)`) then the **pure** `build_index(Corpus)`. The three
  bundle loaders (`load_command_bundle`, `load_explainer_bundle`, `load_rule_bundle`, all private)
  each begin with `parse_file(path)` and thereafter work on `(Node, file: String)` only — the
  filesystem coupling is confined to `load_corpus`, `yaml_files`, `parse_file`.
  `LoadError { file: String, line: usize, message: String }` with a `Display` impl.
  The seed corpus is 98 entries / 42 explainers (`src/lib.rs` tests).
- `crates/fathom-find/tests/golden.rs` + `golden.txt`: the golden harness; cases begin `q: `.
- No WASM code, no `wasm`/`wasm_bindgen` string, anywhere under `crates/` (grep, 2026-08-02).
- `.github/workflows/ci.yml`: `rustup toolchain install` *"(reads rust-toolchain.toml)"* then the
  four floor steps (fmt, clippy, test, schema-check — `78` §6's first four rows; the fifth row,
  the per-work-order gates, has no CI backstop by design); its own comment: *"the toolchain is
  pinned by rust-toolchain.toml and rustup honours it — nothing here chooses a version"*.
- `design/prototype/fathom-app.html` lines 6–7: the prototype's own CSP meta —
  `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; img-src
  'none'; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src
  'none'` — and its transcript face reads that meta from the live page
  (`document.querySelector('meta[http-equiv="Content-Security-Policy"]')`, ~line 1648): the
  audit-from-the-artifact posture this WO's gates continue. (Its `'unsafe-inline'` is prototype
  scaffolding; the product policy is `43` §3.7's, WO-08's problem.)
- **Authoring-time probe, pinned 1.94.1 toolchain (2026-08-02).** All four claims below are
  measurements, not estimates:
  1. `cargo build --target wasm32-unknown-unknown -p fathom-find` **succeeds today, unmodified**
     (after `rustup target add wasm32-unknown-unknown`; the target's `rust-std` is a component of
     the pinned 1.94.1 channel).
  2. A scratch crate with this WO's exact shape — safe `thread_local!` buffer plumbing, extern
     `"C"` exports, linking `CorpusIndex::load` + `build_index` + `Finder::search` + a reply
     encoder, built `--release` under §4.1's profile — produces a **260,654-byte** `.wasm`.
  3. That module's **import section is absent** (zero imports); its export section is exactly
     `memory` (mem), the declared extern fns (func), and two linker-emitted globals
     **`__data_end`, `__heap_base`**.
  4. Deleting the target directory and rebuilding reproduces the **byte-identical** artifact
     (same SHA-256). `cargo clean -p <crate> --target wasm32-unknown-unknown` removed 0 files —
     the determinism gate therefore uses `rm -rf` of a dedicated target dir, not `cargo clean`.
  5. `#[no_mangle]` under `#![forbid(unsafe_code)]` (and under plain `deny`) is a **hard error**
     on 1.94.1: *"declaration of a `no_mangle` function … the linker's behavior with multiple
     libraries exporting duplicate symbol names is undefined and Rust cannot provide guarantees
     when you manually override them"*. Crate-level `#![deny(unsafe_code)]` plus a per-item
     `#[allow(unsafe_code)]` on each export compiles clean, with zero `unsafe` blocks. §12 item 2
     records the strain against `78` §2's forbid row; `41` §2.2 already takes a wider exception
     for exactly this crate.

## 4. Deliverables

Exactly these files change or appear — plus this work order's own status line and its
`00-INDEX.md` row, which `78` §3 steps 8–9 require in the same PR
(step 8 of the plan). No other file, nothing under `schema/`, nothing under `crates/fathom-ir/`.

| File | Change |
|---|---|
| `Cargo.toml` | Adds the member line and the release profile, verbatim (§4.1) |
| `Cargo.lock` | The hunk cargo generates for the new member; it rides the same commit (`78` §5 item 7's manifest exception) |
| `crates/fathom-corpus/src/load.rs` | Source-level loading: `Section`, `SourceFile`, `load_corpus_sources` (§4.2) |
| `crates/fathom-corpus/src/index.rs` | `CorpusIndex::from_sources` (§4.2) |
| `crates/fathom-corpus/src/lib.rs` | One re-export line (§4.2) |
| `crates/fathom-corpus/tests/sources.rs` | New: dir-load ≡ sources-load; duplicate refusal (§4.6) |
| `crates/fathom-wasm/Cargo.toml` | New crate manifest, verbatim (§4.3) |
| `crates/fathom-wasm/src/lib.rs` | The extern ABI layer, verbatim (§4.3) |
| `crates/fathom-wasm/src/shell.rs` | `Shell` — opcode dispatch over the byte protocol (§4.4) |
| `crates/fathom-wasm/src/protocol.rs` | The frames, the packed reply, encode/decode (§4.4, §4.5) |
| `crates/fathom-wasm/src/wasmbin.rs` | The first-party `.wasm` section reader + the allowlist (§4.5) |
| `crates/fathom-wasm/tests/artifact_gates.rs` | New: build, import/export audit, size (§4.6) |
| `crates/fathom-wasm/tests/protocol.rs` | New: CLI-parity over the golden queries; error replies (§4.6) |

The public names in §4.2–§4.5 are the complete set. A step that seems to need another public
name — function, type, const, module, file, opcode, error code — is a §7 trigger.

### 4.1 The manifest edits — verbatim

**Decisions these edits carry.** Target: `wasm32-unknown-unknown` with **std** — the crates use
`std` collections and `String` throughout, `41` §2.1 names the target, and `no_std` has no corpus
mandate; on this target std has no working filesystem or clock at runtime, which is the posture
invariant 9 wants (the shell's only input path is `OP_INIT`'s bytes). The target's `rust-std` is a
component of the already-pinned 1.94.1 channel, installed by the same rustup mechanism `ci.yml`
already relies on — it is toolchain, not a dependency (`78` §2's pin row governs, not §5.2).

**`rust-toolchain.toml` is not this work order's to edit, and does not need editing.** `78` §5
item 7 names it in the list that *"admit no work-order exception — a work order instructing such
an edit is malformed under §8"*; an earlier draft of this order instructed one, which made it
unexecutable. The line is already on disk, added outside the queue (`88` §4.1):

```toml
# Locked toolchain (71 §3.3 xtask row: "locked toolchain"; 35 §4 reproducibility).
[toolchain]
channel = "1.94.1"
components = ["rustfmt", "clippy"]
targets = ["wasm32-unknown-unknown"]
```

A session that finds the `targets` line absent stops under §7 item 1 and escalates; it does not
add it.

`Cargo.toml` — the members list gains one line immediately after `"crates/fathom-schemagen",`
(alphabetical; correct whether or not WO-02's `fathom-graph` line has landed):

```toml
    "crates/fathom-wasm",
```

**Staging.** This member line lands at step 4, in the same change that creates the crate
directory — never earlier. A listed member with no directory on disk fails **every** cargo
invocation (*"error: failed to load manifest for workspace member `…/crates/fathom-wasm`"*,
probed on 1.94.1), so steps 1–3 run with only the other two edits of this section applied.

`Cargo.toml` — appended at the end of the file (this is `42` §8.1's release profile, verbatim in
values; it applies to native release builds too, none of which anything currently gates on):

```toml
# 42 §8.1's release profile — the one the WASM artifact gates measure under.
# overflow-checks stays on in release: 41 §2.5, "a wrapped length in a parser
# is the bug we are here to avoid". panic = "abort": a panic is a trap at the
# boundary, never an unwind across it (41 §3.9, 34 §7.5).
[profile.release]
opt-level = "z"
lto = "fat"
codegen-units = 1
panic = "abort"
strip = "symbols"
debug = 0
overflow-checks = true
incremental = false
```

### 4.2 `fathom-corpus`: loading from sources, not paths

The refactor rule: `load_corpus(root)` keeps its signature and its behaviour **byte-identically**
(same `Corpus`, same `LoadError.file` strings — the dir wrapper passes `path.display()
.to_string()` as each name) and becomes a thin wrapper: list files per `yaml_files` (unchanged),
read each, build `SourceFile`s, delegate. The three private bundle loaders split their
`parse_file(path)` head off and take `(source: &str, file: &str)`; no other logic moves.

New public API, exactly (declared in `load.rs`; re-exported from `lib.rs` as
`pub use load::{load_corpus_sources, Section, SourceFile};`):

```rust
/// Which corpus subdirectory a source belongs to. Order is the load order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Section {
    Commands,
    Explainers,
    Rules,
}

/// One corpus bundle as text. `name` is used verbatim as `LoadError::file`;
/// it is a label, never opened.
#[derive(Debug, Clone)]
pub struct SourceFile {
    pub section: Section,
    pub name: String,
    pub source: String,
}

/// The filesystem-free load path — WO-07's `OP_INIT` and any host without a
/// filesystem. Sorts a copy by `(section, name)` (mirroring `yaml_files`'s
/// sorted listing), refuses a duplicate `(section, name)` with a `LoadError`
/// naming the duplicate (`message` starts `duplicate source`), then loads
/// exactly as `load_corpus` does.
pub fn load_corpus_sources(files: &[SourceFile]) -> Result<Corpus, LoadError>
```

And on `CorpusIndex` (in `index.rs`, next to `load`):

```rust
/// `load_corpus_sources` + `build_index`, the same welding `load` does.
pub fn from_sources(files: &[SourceFile]) -> Result<CorpusIndex, LoadError>
```

### 4.3 `crates/fathom-wasm` — the crate and the extern layer

`crates/fathom-wasm/Cargo.toml`, verbatim:

```toml
[package]
name = "fathom-wasm"
version = "0.1.0"
edition.workspace = true
license.workspace = true
publish.workspace = true

[lib]
# cdylib: the .wasm artifact. rlib: the same code linked natively by this
# crate's own tests, so the protocol has one implementation and two harnesses.
crate-type = ["cdylib", "rlib"]

[dependencies]
fathom-corpus = { path = "../fathom-corpus" }
fathom-find = { path = "../fathom-find" }
```

`src/lib.rs`, verbatim (the whole file; `mod` bodies land in their own files):

```rust
//! fathom-wasm: 41 §3.7's raw (ptr, len) ABI over the finder — slice one of
//! the browser core. Safe Rust throughout: both buffers are module-owned
//! `Vec`s; the host writes into a buffer whose address the module published,
//! and the module reads it back only inside a later export call, so no raw
//! pointer is ever dereferenced on this side of the boundary.
//!
//! Import section: empty — the finder needs neither entropy nor time
//! (41 §3.2's X13/X14 serve sealing and provenance, which are not linked
//! here). `tests/artifact_gates.rs` pins that fact against the built module.
//!
//! `#![forbid(unsafe_code)]` cannot be carried by this crate: `#[no_mangle]`
//! is rejected under it (symbol-collision hazard). deny + three per-item
//! allows is the narrowest working form; there is no `unsafe` block to allow.
#![deny(unsafe_code)]

pub mod protocol;
pub mod shell;
pub mod wasmbin;

use std::cell::RefCell;

use crate::shell::Shell;

/// 41 §3.7's opcode table. Stable forever; a new call is a new opcode, never
/// a changed one. Only the two this slice implements are named — an
/// unimplemented opcode is refused by number (protocol::ERR_UNKNOWN_OP).
pub const OP_INIT: u32 = 1;
pub const OP_QUERY: u32 = 4;

thread_local! {
    static SHELL: RefCell<Shell> = RefCell::new(Shell::new());
    static REQ: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Allocate `len` bytes of scratch for the caller to write a request into.
/// One scratch buffer exists; a second call replaces the first. Never traps.
#[allow(unsafe_code)] // #[no_mangle] only; no unsafe block. WO-07 §3 probe 5.
#[no_mangle]
pub extern "C" fn fathom_alloc(len: u32) -> u32 {
    REQ.with(|r| {
        let mut v = r.borrow_mut();
        v.clear();
        v.resize(len as usize, 0);
        v.as_ptr() as usize as u32
    })
}

/// Release the scratch buffer. `ptr`/`len` are accepted for 41 §3.7 signature
/// fidelity and ignored: there is exactly one scratch to free.
#[allow(unsafe_code)] // as above
#[no_mangle]
pub extern "C" fn fathom_free(_ptr: u32, _len: u32) {
    REQ.with(|r| *r.borrow_mut() = Vec::new());
}

/// The one data-plane entry point (41 §3.7). Returns
/// `(reply_ptr as u64) << 32 | reply_len as u64`; 0 means "no reply". The
/// reply lives in a module-owned arena valid until the next `fathom_call`.
/// A failure is a reply with `record_kind = 0`, never a trap (41 §3.9);
/// `req_ptr` must be the live scratch address and `req_len` within it, else
/// the reply is `ERR_BAD_FRAME`.
#[allow(unsafe_code)] // as above
#[no_mangle]
pub extern "C" fn fathom_call(op: u32, req_ptr: u32, req_len: u32) -> u64 {
    let req: Option<Vec<u8>> = REQ.with(|r| {
        let v = r.borrow();
        let live = v.as_ptr() as usize as u32;
        if req_ptr == live && (req_len as usize) <= v.len() {
            Some(v[..req_len as usize].to_vec())
        } else {
            None
        }
    });
    let reply = match req {
        None => protocol::encode_error(
            protocol::ERR_BAD_FRAME,
            "request pointer is not the live scratch buffer",
        ),
        Some(bytes) => SHELL.with(|s| s.borrow_mut().handle(op, &bytes)),
    };
    REPLY.with(|r| {
        let mut v = r.borrow_mut();
        *v = reply;
        if v.is_empty() {
            0
        } else {
            ((v.as_ptr() as usize as u64) << 32) | v.len() as u64
        }
    })
}
```

`src/shell.rs` — public API, exactly:

```rust
pub struct Shell { /* field private: finder: Option<fathom_find::Finder> */ }

impl Shell {
    pub fn new() -> Shell;
    /// One call, one reply (empty = success with nothing to say). Dispatch:
    /// OP_INIT → §4.4's init frame → CorpusIndex::from_sources → Finder;
    ///   success replaces any existing finder (re-init permitted) and
    ///   returns the empty reply.
    /// OP_QUERY → UTF-8 query → Finder::search → protocol::encode_query_reply.
    /// Anything else → ERR_UNKNOWN_OP. Errors per §4.4's code table.
    pub fn handle(&mut self, op: u32, req: &[u8]) -> Vec<u8>;
}

impl Default for Shell {
    fn default() -> Shell; // Shell::new(); clippy::new_without_default
}
```

### 4.4 The byte protocol — decided down to the offset

Everything little-endian. Every multi-byte integer is read/written with `to_le_bytes` /
`from_le_bytes`; the TypeScript reader (WO-08) will use `DataView` with `littleEndian = true`,
which is `41` §3.3/§3.4's stated read model (§3.3: fixed-width records read with `DataView` at
known offsets; §3.4's worked row: `DataView.getUint32(off, true)`).

**The `OP_INIT` request frame.** Refusals: truncated or trailing bytes → `ERR_BAD_FRAME`; a
`section` byte outside 0–2 → `ERR_BAD_FRAME`; non-UTF-8 name or source → `ERR_BAD_UTF8`; a
duplicate `(section, name)` → `ERR_BAD_FRAME`. The shell maps `section` 0/1/2 to
`Section::Commands` / `Explainers` / `Rules` and passes `SourceFile.name` as
`"commands/" + name` / `"explainers/" + name` / `"rules/" + name` (the label in load errors). A
`LoadError` from the loader → `ERR_CORPUS_LOAD` with `detail` = the error's `Display` string.

```text
offset  size  field
0       4     file_count (u32)
        then, file_count times:
        1     section        0 commands · 1 explainers · 2 rules
        4     name_len (u32)     then name_len bytes, UTF-8 (bare file name)
        4     source_len (u32)   then source_len bytes, UTF-8 (the YAML text)
```

**The `OP_QUERY` request.** The raw UTF-8 query bytes, no framing. Not UTF-8 → `ERR_BAD_UTF8`.
Before a successful `OP_INIT` → `ERR_NOT_INITIALISED`.

**The reply skeleton** — `41` §3.3's, verbatim in structure:

```text
offset  size  field
0       4     magic  'F' 'D' 'L' 'T'
4       2     version (u16)          = 1
6       2     record_kind (u16)      0 = Error (41 §3.9's error-reply rule) ·
                                     3 = FinderRow (41 §3.3's table)
8       4     record_count (u32)
12      4     record_stride (u32)    28 (kind 0) · 72 (kind 3)
16      …     records[record_count]
…       4     strings_len (u32)
…       …     strings: one UTF-8 blob; records carry (u32 offset, u32 len) into it
```

String refs: `(0, 0)` encodes the empty string; otherwise `offset` indexes the blob. Emission
order is fixed: records in order, each record's string fields appended in field order, no
de-duplication — so the encoding of a given reply is a pure function of its content
(invariant 9).

**The Error record, stride 28** (`41` §3.9's fields; the node slots are zero until a caller has
nodes):

```text
offset  size  field
0       2     code (u16)     1 ERR_UNKNOWN_OP · 2 ERR_NOT_INITIALISED ·
                             3 ERR_CORPUS_LOAD · 4 ERR_BAD_FRAME · 5 ERR_BAD_UTF8
2       2     zero
4       8     node_lo (u64)  = 0
12      8     node_hi (u64)  = 0
20      4     detail_off (u32)
24      4     detail_len (u32)
```

**The FinderRow record, stride 72.** One record kind carries the whole `SearchResult`: record 0
is the query summary (`role` 0, exactly one, always first), then the shown rows in order
(`role` 1), then the below-cutoff rows in order (`role` 2 — the CLI's *"nearest commands"*).
`record_count = 1 + shown.len() + below.len()`.

```text
offset  size  field
0       1     role           0 summary · 1 shown · 2 below-cutoff
1       1     risk           rows: 0 ReadOnly · 1 ChangesConfig · 2 Disruptive
                             (41 §3.3's mapping; the enum's three values, no
                             fourth — conventions). Summary: 0, not meaningful;
                             readers must not interpret it when role = 0
2       1     flags          rows:    bit0 score_milli < CONFIDENT_MILLI (2500)
                                      bit1 next_if_bad present
                             summary: bit0 ladder_group_trigger
                                      bit1 reverse present · bit2 reverse full
                                      bit3 filter clause present
3       1     zero
4       4     entry (u32)    rows: the entry ordinal; summary: query-concept count
8       4     score_milli (i32)   rows: Ranked.score_milli, copied never recomputed;
                                  summary: (g_syn * 1000.0).round() as i32
12      4     concept_milli (i32)  \
16      4     lexical_milli (i32)   |  (contributions.<x> * 1000.0).round() as i32
20      4     syntax_milli (i32)    |  — the same rounding lib.rs uses for the
24      4     context_milli (i32)   |  score. All five are 0 on the summary.
28      4     prior_milli (i32)    /
32      40    five (u32 off, u32 len) pairs into the string blob, s0–s4
```

The string assignments, exactly:

| Slot | Row (role 1, 2) | Summary (role 0) |
|---|---|---|
| s0 | `display_cmd(entry)` | `filter_clause` or empty |
| s1 | entry `id` | reverse: `display_cmd(rev.entry)` or empty |
| s2 | entry `answers` | reverse: entry `id` or empty |
| s3 | entry `read_field` | reverse captures: `{slot} := {value}` lines, `\n`-joined, no trailing newline |
| s4 | first `next_if_bad` or empty | reverse leftover tokens, single-space-joined |

The sum of the five quantised contributions may differ from `score_milli` by rounding;
`score_milli` is authoritative for ordering and is the CLI's own number. What is deliberately
**not** in the reply: the query-concept name/confidence rows and `--why`'s per-term/per-concept
depth — native-CLI diagnostics; a UI face that wants them is a protocol extension (new opcode or
new record kind), which is planning work (§10 item 5).

`src/protocol.rs` — public API, exactly:

```rust
pub const REPLY_MAGIC: [u8; 4] = *b"FDLT";
pub const REPLY_VERSION: u16 = 1;
pub const KIND_ERROR: u16 = 0;
pub const KIND_FINDER_ROW: u16 = 3;
pub const ERROR_STRIDE: u32 = 28;
pub const FINDER_ROW_STRIDE: u32 = 72;
pub const ROLE_SUMMARY: u8 = 0;
pub const ROLE_SHOWN: u8 = 1;
pub const ROLE_BELOW: u8 = 2;
pub const ERR_UNKNOWN_OP: u16 = 1;
pub const ERR_NOT_INITIALISED: u16 = 2;
pub const ERR_CORPUS_LOAD: u16 = 3;
pub const ERR_BAD_FRAME: u16 = 4;
pub const ERR_BAD_UTF8: u16 = 5;

/// Encode §4.4's OP_INIT frame from bare-named sources. The reference
/// encoder: WO-08's build step and this crate's tests both use it.
pub fn pack_corpus(files: &[fathom_corpus::SourceFile]) -> Vec<u8>;

pub fn encode_query_reply(
    finder: &fathom_find::Finder,
    result: &fathom_find::SearchResult,
) -> Vec<u8>;

pub fn encode_error(code: u16, detail: &str) -> Vec<u8>;

/// The reference reader — the decoder tests parity against, and the byte-
/// level specification WO-08's TypeScript reader mirrors.
pub struct FinderRowView {
    pub role: u8,
    pub risk: u8,
    pub flags: u8,
    pub entry: u32,
    pub score_milli: i32,
    pub contributions_milli: [i32; 5],
    pub strings: [String; 5],
}

pub struct ErrorView {
    pub code: u16,
    pub detail: String,
}

pub enum ReplyView {
    Empty,
    Error(ErrorView),
    FinderRows(Vec<FinderRowView>),
}

/// Refuses a bad magic, version, kind, stride, count, or out-of-blob string
/// ref with a message naming the offset. Empty input decodes to Empty.
pub fn decode_reply(bytes: &[u8]) -> Result<ReplyView, String>;
```

### 4.5 The artifact audit — first-party, dependency-free

`34` §7.5 and `42` §9.4 specify the audit over `wasm-objdump`. No such tool exists in this
repository and none may be added (`78` §5.2), so the audit parses the binary itself: the WASM
binary format is `\0asm`, a u32 version, then a sequence of sections (one id byte + LEB128 size);
the import section is id 2 (entries: module name, field name, kind byte, kind-specific
descriptor), the export section id 7 (entries: name, kind byte — 0 func, 1 table, 2 mem,
3 global — and index). ~120 lines of safe Rust including the LEB128 decoder.

`src/wasmbin.rs` — public API, exactly:

```rust
/// The committed import allowlist (34 §7.5; 42 §9.4 check 5). The only names
/// that may ever appear here are `fathom_entropy` and `fathom_now_ms`
/// (38 §2 G1) — and neither is needed yet: the finder draws no entropy and
/// reads no clock, so the list is EMPTY and the audit asserts the import
/// section is too. Growing this list is a planning decision, never a fix
/// for a red gate.
pub const IMPORT_ALLOWLIST: &[&str] = &[];

/// (module, field) for every entry in the import section, in section order.
pub fn import_entries(wasm: &[u8]) -> Result<Vec<(String, String)>, String>;

pub struct ExportEntry {
    pub name: String,
    /// 0 func · 1 table · 2 mem · 3 global — the format's own kind byte.
    pub kind: u8,
}

pub fn export_entries(wasm: &[u8]) -> Result<Vec<ExportEntry>, String>;
```

**On declaring fewer imports than the allowlist:** the mechanism is a subset check — `34` §7.5:
*"assert every entry is in a committed allowlist"* — so an empty import section passes any
allowlist. This WO asserts the stronger, exact fact (import set **equals** ∅) so that the first
import ever added turns the gate red and arrives through planning, with the allowlist constant
and its citation edited in the same change.

### 4.6 The tests

**`crates/fathom-corpus/tests/sources.rs`** — 2 tests:

1. `sources_load_equals_dir_load`: build `SourceFile`s by listing `corpus/{commands,explainers,
   rules}/*.yaml` sorted (names = `path.display().to_string()`), assert
   `CorpusIndex::from_sources` and `CorpusIndex::load` produce equal indexes via a canonical dump
   (the `index_is_deterministic_across_constructions` dump in `fathom-corpus/src/lib.rs`: terms
   with `idf_milli`/`df`, concepts with `icf_milli`/`entry_count`, `cmd_keys`).
2. `duplicate_source_names_refused`: the same file twice → `Err`, message starts
   `duplicate source`.

**`crates/fathom-wasm/tests/protocol.rs`** — 3 tests, all native (the rlib half):

1. `shell_replies_mirror_the_native_finder`: pack `corpus/` (bare names, per-dir sorted listing —
   a private helper in the test file), `Shell::new`, `handle(OP_INIT, frame)` → empty reply. Then
   for every `q: ` line in `crates/fathom-find/tests/golden.txt` **and** the fixed query
   `is the vpn to site B actually up`: `handle(OP_QUERY, …)`, `decode_reply`, and assert against
   a directly-constructed `Finder` over `CorpusIndex::load("corpus")`: role-1 records equal
   `shown` (ordinal, `score_milli`, all five quantised contributions, risk byte, band flag, and
   all five strings against `display_cmd` / `id` / `answers` / `read_field` / `next_if_bad`),
   role-2 records equal `below` likewise, and the summary record's `score_milli` / flags /
   strings equal the quantised `g_syn`, the three result flags, and the reverse/filter fields.
   This is X0.5's property (`71` §3.6) at slice-one strength — one process, two code paths;
   the cross-target execution form needs `45`'s browser harness and is §8's.
2. `error_replies_are_typed`: query before init → `ERR_NOT_INITIALISED`; op `9` →
   `ERR_UNKNOWN_OP`; invalid UTF-8 query after init → `ERR_BAD_UTF8`.
3. `init_frame_refusals`: truncated frame → `ERR_BAD_FRAME`; section byte 3 → `ERR_BAD_FRAME`;
   duplicate `(section, name)` → `ERR_BAD_FRAME`; a syntactically-broken YAML source →
   `ERR_CORPUS_LOAD` with the loader's line number present in `detail`.

**`crates/fathom-wasm/tests/artifact_gates.rs`** — 1 test,
`release_wasm_builds_audits_and_fits`:

1. Resolve the workspace root (`CARGO_MANIFEST_DIR` + `../..`) and the cargo binary
   (`std::env::var("CARGO")`, falling back to `"cargo"`).
2. Run, cwd = workspace root:
   `cargo build --release --target wasm32-unknown-unknown -p fathom-wasm --target-dir
   target/wasm-audit` — the **separate target dir** exists so the nested build never contends
   with the lock of the outer `cargo test` that is running this test, and so §6 G7's `rm -rf` is
   scoped. Assert exit success.
3. Read `target/wasm-audit/wasm32-unknown-unknown/release/fathom_wasm.wasm`.
4. **Import audit**: `import_entries` returns the empty list, and (kept wired so the constant is
   load-bearing) every entry is in `IMPORT_ALLOWLIST`.
5. **Export audit**: function exports exactly `{fathom_alloc, fathom_call, fathom_free}`; memory
   exports exactly `{memory}`; global exports exactly `{__data_end, __heap_base}` (the two
   linker-emitted globals, measured in §3 probe 3 — they grant nothing `memory` does not already
   export); no exports of any other kind.
6. **Size gate**: byte length ≤ **900 000**. `44` §5.2 writes the hard ceiling as *"≤ 900 KB"*;
   this gate reads KB as 1 000 bytes — the stricter reading — so it cannot pass on a unit
   ambiguity. (§3 probe 2 measured 260 654 bytes, ~3.5× headroom.)
7. `println!` the measured size and both audited sets, so `--nocapture` shows the numbers the PR
   body must quote.

## 5. The plan

Each step ends with `cargo build --workspace` (and from step 4, `cargo test --workspace`) green
unless marked.

1. Apply one of §4.1's two `Cargo.toml` edits verbatim: the `[profile.release]` append. Confirm
   `rust-toolchain.toml` already carries `targets = ["wasm32-unknown-unknown"]` — it is not this
   order's to edit (§4.1); if it is absent, stop under §7 item 1. **Not the member line** — it is step 4's, with
   the crate it names (§4.1's staging note: a member with no directory fails every cargo
   command). Run `cargo build --target wasm32-unknown-unknown -p fathom-find`; rustup installs
   the pinned channel's `rust-std` for the target on first use — if the environment's rustup
   does not, run `rustup target add wasm32-unknown-unknown` once; if the component cannot be
   obtained at all, stop under §7 item 1. (This build succeeding is also gate G4, verified
   pre-WO: §3 probe 1.)
2. The `fathom-corpus` refactor (§4.2): split the private loaders to `(source, file)` form, add
   `Section` / `SourceFile` / `load_corpus_sources` / `from_sources` and the `lib.rs` re-export,
   rewire `load_corpus` as the wrapper. `cargo test --workspace` — every pre-existing test still
   passes unchanged (byte-identical behaviour is the refactor rule; 80 at §3's authoring time,
   whatever sibling work orders landing first have raised it to — G3's note).
3. Write `crates/fathom-corpus/tests/sources.rs` (§4.6). Green.
4. Create `crates/fathom-wasm` — §4.1's member line and the crate ride one change: the verbatim
   manifest, `lib.rs` verbatim (§4.3), then `protocol.rs` and `shell.rs` against §4.4's tables
   **and `wasmbin.rs` against §4.5's API**. All three module files must exist before this step's
   build: the verbatim `lib.rs` declares all three, and a declared module without its file is a
   hard error (E0583, probed on 1.94.1). Private helpers are free to name inside their files;
   **no new public item** beyond §4.3–§4.5's lists. Green (the new crate compiles for host under
   the workspace build).
5. Write `tests/artifact_gates.rs` (§4.6). Run
   `cargo test -p fathom-wasm --test artifact_gates -- --nocapture`; record the printed size.
6. Write `tests/protocol.rs` (§4.6). Green.
7. Run every gate in §6 in order. All green, or stop under §7 / `78` §4. Quote G6's printed
   measurements and G7's two identical hashes in the PR body.
8. **Bookkeeping.** Status line → `DONE`; mirror the `00-INDEX.md` row by
   then (its absence today is flagged by `78` §3 step 2's own VERIFY and is not this session's
   to fix). Commit per `78` §3.9, push, open the PR listing every gate's output verbatim. Do
   not merge.

## 6. Acceptance gates

Run from the repository root, in this order. Expected output is exact; anything else is a red
gate (`78` §3 step 7).

| # | Command | Expected |
|---|---|---|
| G1 | `cargo fmt --all --check` | No output, exit 0 |
| G2 | `cargo clippy --all-targets -- -D warnings` | Builds clean, exit 0 |
| G3 | `cargo test --workspace` | Every suite `ok`, 0 failed. Exact where this WO owns the number: `sources` 2 passed, `protocol` 3 passed, `artifact_gates` 1 passed; no pre-existing test removed or altered (this WO touches no existing test). The workspace total is deliberately not pinned — sibling OPEN work orders (WO-01, WO-02, WO-04, WO-06 at authoring time; WO-06's G3 alone pins 82) may land first and move it, and `78` §12 item 3 is explicit that *"green is the gate, not a number"*. Against §3's authoring-time tree the total would be 86 (80 + 6) |
| G4 | `cargo build --target wasm32-unknown-unknown -p fathom-find` | Exit 0 |
| G5 | `cargo build --release --target wasm32-unknown-unknown -p fathom-wasm --target-dir target/wasm-audit` | Exit 0; `target/wasm-audit/wasm32-unknown-unknown/release/fathom_wasm.wasm` exists |
| G6 | `cargo test -p fathom-wasm --test artifact_gates -- --nocapture` | `1 passed`; prints the measured size (≤ 900 000), the empty import list, and §4.6 item 5's exact export sets |
| G7 | `sha256sum target/wasm-audit/wasm32-unknown-unknown/release/fathom_wasm.wasm`, then `rm -rf target/wasm-audit`, re-run G5, `sha256sum` again | The two hashes are **identical** (measured to hold for §3's probe on this machine; `42` §8.7 R1's same-machine form). Do not use `cargo clean -p` — §3 probe 4: it removes nothing for a `--target` build |
| G8 | `cargo run -p fathom-schema --bin fathom-schema-check` | Exit 0; `0 failure(s), 2 warning(s)` — the standing `Site` baseline, unchanged |
| G9 | `grep -rn "wasm_bindgen\|wasm-bindgen" crates/` | No matches, exit 1 — the no-glue decision holds in the tree, not only in prose |

## 7. Stop-and-escalate triggers

Any of these stops the session under `78` §4. The escalation is the deliverable at that point.

1. The `wasm32-unknown-unknown` `rust-std` component cannot be installed under the 1.94.1 pin
   (offline or restricted runner). Do not fetch it by any other route, do not vendor it, do not
   unpin.
2. The built module's **import section is non-empty** — any entry, any name. Report the entries
   verbatim. Do not add a name to `IMPORT_ALLOWLIST`; the list grows only by a planning decision
   citing `38` §2 G1.
3. The export set differs from §4.6 item 5 in any direction: an extra or missing function, a
   missing linker global, any table or tag export. Report the full dumped set.
4. The module exceeds 900 000 bytes. Report the measured number; `44` §5.2 makes the measurement
   the decider and re-budgeting is planning work, not a bigger constant.
5. G7's hashes differ. Report both hashes and the offset of the first differing byte.
6. Any step appears to need a dependency or tool: `wasm-bindgen` (crate or CLI), `wasm-opt`,
   `twiggy`, `wasm-objdump`, a runtime to execute the `.wasm`, anything (`78` §5.2).
7. Any step appears to need an `unsafe` **block** (the three `#[allow(unsafe_code)]` attribute
   items in §4.3's verbatim `lib.rs` are the entire grant). The safe design failed; planning must
   hear how.
8. A step needs a public name — function, type, const, opcode, error code, module, file — not
   listed in §4, or a schema declaration of any kind, or a change to `fathom-find` /
   `fathom-schema` / `fathom-ir` public API.
9. The step-2 refactor cannot keep `load_corpus`'s behaviour byte-identical (a test that asserts
   an error string breaks, or the `Corpus` differs). Report the divergence; do not adjust the
   test (`78` §5.5).
10. The nested build in `artifact_gates` deadlocks, or `CARGO` resolution fails, or the separate
    target dir does not prevent lock contention.
11. `shell_replies_mirror_the_native_finder` is red: the shell path and the native path disagree.
    Report the query and both ranked lists; never adjust weights, fixtures, or `golden.txt`.

## 8. Non-goals

Deliberately not in this work order; citing a non-goal to justify extra work is the §9 row-1
failure.

- **The browser artifact.** No HTML is assembled, no CSP is written, no byte of JS or TS is
  produced. X0.8 — *"CSP of the shipped artifact contains `connect-src 'none'`, asserted against
  the final bytes, not the template"* — has no artifact to run against until WO-08 assembles one
  carrying `43` §3.7's policy (whose `'wasm-unsafe-eval'` is what permits instantiating this
  module). X0.9 and its instruments (E13/E14), the worker topology (`34` §7.2), Trusted Types —
  all artifact-side, all WO-08 or later.
- **The other eight opcodes.** `OP_OPEN`, `OP_APPLY`, `OP_SEAL`, `OP_INGEST`, `OP_EXPLAIN`,
  `OP_LAYOUT`, `OP_SNAPSHOT`, `OP_STATS` are refused by number. The graph in WASM follows the
  store (WO-02), not this WO.
- **The two real imports.** `fathom_entropy` and `fathom_now_ms` arrive with sealing and
  provenance (`41` §3.2 X13/X14), through planning, with the allowlist edit (§10 item 2).
- **JS glue of any kind.** The module is for plain `WebAssembly.instantiate` with an empty
  imports object; WO-08's TypeScript reader mirrors `protocol.rs`'s decoder, which is the
  reference.
- **Size optimisation beyond §4.1's profile.** No `wasm-opt`, no per-component `twiggy` split
  (`44` §5.2's per-row gating needs tools this repository does not have), no `no_std`.
- **Cross-target execution parity** — running the `.wasm` and diffing against native (X0.5's
  real form) needs a browser or a runtime; it lands with `45`'s harness. The parity this WO pins
  is the native two-path form (§4.6).
- **The `--why` depth and query-concept diagnostics in the reply** (§4.4's closing note).
- **`fathom serve`.** The loopback fallback origin (`46` §1 row 1) serves WO-08's bundle; nothing
  here touches it.

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **Scope creep toward WO-08** — "while the shell is open", someone starts the HTML, a JS loader, or an extra opcode | §7 items 6–8; the Deliverables file list is closed |
| 2 | **Toolchain drift changes the artifact** — a future channel bump alters the linker's export set or the byte-identity of G7 | The pin (`78` §2) plus exact-set assertions turn drift into a red gate routed to planning (§7 items 3, 5) — the same posture as WO-01 §9 row 2 |
| 3 | **The reply format ossifies with a defect** — WO-08's TS reader hard-codes §4.4 and a change breaks silently | The `version` field; the rule that a new call is a new opcode and a new shape is a new record kind (`41` §3.7); the Rust decoder as the reference reader |
| 4 | **The scratch-pointer check reads as a security boundary** — it is a handshake check only | Stated in §4.3's doc comments: safety comes from reading only module-owned `Vec`s, never from validating a pointer; any script in the origin can call any export regardless (`34` §7.5) |
| 5 | **Parity green, both wrong** — shell and native agree because they share the code whose behaviour is wrong against `16` | Out of this WO's reach by design: `golden.txt` pins behaviour to `16` §9.6's cases, and X0.5/X0.6's independent forms arrive with `45`'s harness |
| 6 | **The 260 KB measurement is read as evidence for the product core** — this module has no crypto (the largest single block, 180 KB budgeted), no graph, no parsers | Stated here; ADR-0017's phase-0 spike for `fathom_core.wasm` remains owed and un-discharged (§10 item 1) |
| 7 | **The nested `cargo build` flakes in constrained CI** — lock contention, missing target on the runner | The separate target dir (§4.6); `ci.yml`'s `rustup toolchain install` reads the edited `rust-toolchain.toml`, so the target installs with the channel; §7 items 1 and 10 route the rest |

## 10. Open decisions

This section doubles as the escalation inbox under `78` §4 step 2. Standing items, deliberately
not decided here:

1. **The phase-0 `fathom_core.wasm` measurement** (ADR-0017, `44` §5.2) — the full core with
   crypto, graph and parsers, which decides whether `44`'s ceilings arm and whether D1 is viable
   at the specified size. This WO measures the finder slice only. Planning.
2. When the import allowlist first grows to `fathom_entropy` (sealing) and `fathom_now_ms`
   (provenance), and the `getrandom` custom-backend wiring `41` §3.7's VERIFY carries. Planning,
   with the crypto/workspace slice.
3. Whether the two linker globals (`__data_end`, `__heap_base`) are suppressed by a link flag
   rather than allowlisted in the export audit. Any `-C link-arg` is build configuration;
   planning.
4. Whether `OP_INIT` gains a counts/stats reply (an `OP_STATS`-shaped record) instead of the
   empty success. Planning, with WO-08's boot sequence.
5. The reply extension for query-concept diagnostics and the `--why` depth, if a UI face wants
   them (§4.4). Planning.
6. Where the corpus blob is packed at artifact-build time (the base64 inline slot in `42` §8.2's
   assembly) and by what — `xtask` does not exist yet. Planning, with WO-08.

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants 1–3, 9; the risk enum; terminology; document conventions |
| `CLAUDE.md`; `docs/70-ops/78-execution-protocol.md` (whole) | The inherited constraint table; the escalation rule; the verification floor; the WO template; §5.7's verbatim-edit rule for the manifests |
| `docs/30-security/34-browser-hardening.md` §2.2, §2.6, §2.8, §3.3–§3.6, §7.1–§7.5, §8.1–§8.3, §10.5, §11 | The import-audit mechanism and quote; exports as capability grants; `'wasm-unsafe-eval'`'s exact grant; the mode-A policy; H39; `fathom serve`'s rules |
| `docs/30-security/38-the-egress-question.md` §1.3, §2 (G1–G3) | The allowlist's committed contents; X0.8/X0.9 as browser-artifact gates and their *specified, never run* status |
| `docs/70-ops/71-roadmap.md` §3.6 (X0.4–X0.9 rows) | The ship-gate wording quoted in §2 |
| `docs/40-stack/41-technology-choices.md` §1.2, §2.1–§2.5, §3.1–§3.10 | The target; the traffic census (X13/X14); the ABI decision, opcodes, arena lifetime, error model; the T2 skeleton and risk mapping; the size split |
| `docs/40-stack/42-no-node-runtime.md` §1–§3, §8.1, §9.3–§9.4, §10 | Z1–Z5; the release profile (§8.1, adopted verbatim); checks 5/6; the structural-claim row; the `trunk`-not-adopted decision |
| `docs/40-stack/43-deployment-modes.md` §3.1–§3.7 | D1's decision and CSP; the size-budget ownership note (§3.2); the load-time facts |
| `docs/40-stack/44-performance-budgets.md` §3 (B17/B18), §5.1–§5.5 | The 900 KB ceiling and 700 KB target; the 4.5 MB A1 ceiling; the arming condition; `xtask size-gate`'s eventual shape |
| `docs/40-stack/46-workspace-persistence-and-identity.md` §1 (rows 1–5) | The `fathom serve` fallback-origin row quoted in §2 |
| `design/prototype/fathom-app.html` head + transcript face (~line 1648) | The prototype CSP meta, quoted; the read-your-own-policy audit posture |
| `crates/fathom-find/src/{lib.rs,bin/fathom-find.rs}`; `tests/{golden.rs,golden.txt}` | The search API and quantisation; the CLI output contract mirrored in §4.4; the golden cases reused by the parity test |
| `crates/fathom-corpus/src/{lib.rs,load.rs,index.rs}`; `Cargo.toml` | The fs-coupling boundary; the loader shapes for §4.2's refactor; the determinism dump reused in §4.6; 98/42 seed counts |
| `Cargo.toml`, `rust-toolchain.toml`, `.github/workflows/ci.yml` | The dependency position (quoted); the pin; the CI floor and its rustup line |
| `cargo test --workspace`; `fathom-schema-check` (run 2026-08-02) | 80 passed / 0 failed; exit 0, `0 failure(s), 2 warning(s)` |
| Authoring-time probe on the pinned 1.94.1 toolchain (2026-08-02, §3) | fathom-find compiles to wasm32 unmodified; 260 654 bytes under §4.1's profile; empty import section; the exact export set; byte-identical scratch rebuild; the `no_mangle`-under-`forbid` error text |

## 12. Disagreements

1. **Against `41` §3.7's scaffolding clause.** The decision reads *"`wasm-bindgen` is used for
   the module scaffolding and for nothing that carries data"*; `42` §3.1 correspondingly pins
   `wasm-bindgen-cli` as a build tool. This WO ships without it entirely: with zero imports and
   three hand-written `extern "C"` exports there is nothing to scaffold, the artifact loads with
   plain `WebAssembly.instantiate`, and adopting the crate would break the merged workspace's
   zero-dependency position (`78` §2) — a position an execution session cannot touch and this
   planning document chooses not to. This is a narrowing, not a contradiction: the data-plane
   half of `41` §3.7 — the raw `(ptr, len)` ABI, the opcode table, the arena lifetime, the
   no-exceptions rule — is implemented exactly as decided. If a later slice genuinely needs
   glue (the entropy import's `getrandom` wiring is the candidate, `41` §3.7's VERIFY), the
   question reopens in planning with `42` §3.1's pinning discipline on the table.
2. **Against `78` §2's "no unsafe" row as it applies to the new crate.** The row records
   `#![forbid(unsafe_code)]` in all six crates; the prompt of this queue states it per-crate.
   `fathom-wasm` cannot carry `forbid`: on the pinned toolchain `#[no_mangle]` is rejected under
   it outright (§3 probe 5, error text quoted). The crate ships `#![deny(unsafe_code)]` plus
   three per-item `#[allow(unsafe_code)]` attributes and **zero unsafe blocks** — strictly
   narrower than `41` §2.2's already-taken exception for this exact crate, which anticipated
   *"raw pointer arithmetic over linear memory"* that the owned-buffer design makes unnecessary.
   G2 and §7 item 7 hold the line at that width.
3. **Against the "ten exports" language — in `42` §9.4 check 6 and in `41` itself.** Check 6
   reads *"the ten opcode entry points plus `memory`, `fathom_alloc`, `fathom_free`"*; `41`
   §3.7's headline DECISION says *"a raw `(ptr, len)` ABI over ten exports and two imports"*
   (the line §2 quotes) and `41` §3.1 says *"the API below has ten exports, not two hundred"*.
   All three sentences conflict with `41` §3.7's own normative code block — captioned *"the
   entire data-plane ABI"* — which declares exactly three exported functions (`fathom_alloc`,
   `fathom_free`, `fathom_call`) and carries the ten opcodes as `OP_*` constants: data through
   `fathom_call`, not exported functions. The contradiction is therefore internal to `41` §3.7
   as well as between the two documents; the code block owns the ABI, this WO's export audit
   asserts its shape, and §2's quote of the headline is read under this note. The corrections —
   one cell in `42` §9.4 and the two sentences in `41` — belong to planning.
4. **On arming `44`'s ceiling early.** `44` §5.5 defers arming the absolute ceilings until the
   phase-0 core measurement; this WO nevertheless gates its own module at the B18 number. That is
   consistent, not premature: the deferral exists so an unmeasured *core* is not rejected by a
   guessed number, and this WO is itself a measurement (recorded in G6/PR) of a module a third
   the ceiling's size. The product-wide `xtask size-gate` remains unbuilt and unarmed (§10
   item 1).
5. **Repairs from the planning verification pass (2026-08-02), old → new, in `78` §8's form.**
   (a) Step 1 ordered all three §4.1 edits, three steps before `crates/fathom-wasm` exists; a
   listed member with no directory fails every cargo invocation (*"failed to load manifest for
   workspace member"*, probed on 1.94.1), so the member line now lands at step 4 and §4.1
   carries the staging note. (b) `wasmbin.rs` was ordered at step 5, after step 4's green build
   of a verbatim `lib.rs` that declares `pub mod wasmbin;` — E0583, probed; it is now step 4's.
   (c) G3 pinned *"86 tests total: the 80 pre-WO tests unchanged"*; WO-01, WO-02, WO-04 and
   WO-06 were OPEN alongside this WO at authoring time (WO-06's own G3 pins 82 after it lands),
   so an absolute total manufactures a spurious red gate — G3 now pins only the suites this WO
   owns, per `78` §12 item 3's *"green is the gate, not a number"*. (d) §3's `ci.yml` line said
   five floor steps; the workflow has four after the toolchain install (fmt, clippy, test,
   schema-check). (e) Two §4.4 citations sharpened: reply kind 0 = Error is `41` §3.7/§3.9's
   error-reply rule, not §3.3's table (whose kinds are 1–4); `littleEndian = true` appears in
   §3.4's worked row, §3.3 stating only `DataView` at known offsets. (f) The plan gains the
   sibling bookkeeping step (WO-02 step 13's form) and §4's closure now admits the status-line
   and index edits `78` §3 steps 8–9 require in the same PR. Item 3 above was widened in the
   same pass to name `41`'s own "ten exports" sentences. None of these changes what the module
   is: the ABI, the protocol, the audits and the gates' commands are as first written.
