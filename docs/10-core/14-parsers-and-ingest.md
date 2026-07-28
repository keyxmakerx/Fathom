# 14 — Config ingest: parsers, redaction, reverse explanation

> **Status:** Proposed

§6.3 of the owner's brief makes paste the primary on-ramp for inventory: *"`show
configuration | display set` in, populated graph out, diagram drawn, findings listed. Never
an empty form."* It then says the same machinery pointed backwards gives *"explain a config
someone else wrote."*

This document is that machinery. It is the only subsystem in Fathom that takes input it did
not produce, and it is the only subsystem on the path between a user's clipboard and a
stored artefact. Both of those facts drive the design more than parsing theory does.

The governing rule for this document, stated once in the card's register:

```text
NOTHING PARSED IS SILENTLY LOST, AND NOTHING SECRET IS EVER KEPT
```

Every decision below is downstream of that sentence. Where a design is more convenient but
breaks half of it, the design loses.

---

## 0. Contents

| § | |
|---|---|
| 1 | The forces, and the three jobs ingest has |
| 2 | The pipeline: seven stages, one shape |
| 3 | Choosing the parsing approach — DECISION |
| 4 | Frame: turning a paste into logical lines |
| 5 | Lex and Shape: the four platform CSTs |
| 6 | The statement dictionary — the normaliser |
| 7 | Bind: statements to IR fragments |
| 8 | Error recovery, residue and the line ledger |
| 9 | Redaction — the gate |
| 10 | Identity resolution on re-parse |
| 11 | Scale: parse-time and memory budgets |
| 12 | Reverse explanation |
| 13 | Fuzzing and corpus testing |
| 14 | Worked example — field card side 1, damaged |
| 15 | What this design costs |
| 16 | Open decisions |
| 17 | Proposed changes to `11-ir-schema.md` |
| 18 | Disagreements |

---

## 1. The forces, and the three jobs ingest has

### 1.1 Three jobs, not one

Ingest looks like one subsystem and is three, with different failure modes and different
consumers.

| Job | Input | Output | Consumer | Failure looks like |
|---|---|---|---|---|
| **Populate** | a config paste for a device | IR fragment + reconciliation plan | the graph, then all six views | duplicated nodes, wrong values, silent data loss |
| **Explain** | a config paste, possibly for no device at all | annotations over the input text | the reverse-explanation view (§12) | confidently explaining a line you misparsed |
| **Gate** | every byte on both paths above | a redacted capture + a drop manifest | invariant 3 | a credential in the workspace |

The gate runs on the other two, always, with no bypass. That ordering is the single
structural decision in this document (§9.1).

**Explain must work with no workspace and no device.** Someone opens the offline single
file, pastes an inherited config, and wants to know what it does. That path must not
require creating a `Device`, must not require a passphrase, and must not persist anything.
It is the lowest-friction entry point Fathom has after the command finder, and treating it
as "populate, then render" would put a workspace between the user and the answer.

### 1.2 The forces

| # | Force | Where it comes from | What it forces |
|---|---|---|---|
| I1 | The input is damaged by default | §6.3 — the user pastes from a terminal, a wiki, a ticket, a PDF | Recovery is the main path, not the error path (§8) |
| I2 | The input contains credentials | Invariant 3 | A gate that runs before the graph and before persistence (§9) |
| I3 | Re-paste must update, not duplicate | Invariant 7, IR §10.4 | Identity resolution driven by capture scope (§10) |
| I4 | Nothing may be silently dropped | The owner's rule against tools that lie | A total accounting of every input byte (§8.5) |
| I5 | Same input ⇒ same graph, byte for byte | Invariant 9 | No hash-map iteration, no timestamps in parse output, no heuristics with unstable tie-breaks |
| I6 | It runs in WASM in a browser tab | Brief §8 | Bounded memory, bounded time, no stack recursion on user-controlled depth (§11) |
| I7 | Adding a fifth platform must be mostly content work | Brief §5.2's "no per-vendor engines" applied to parsers | The grammar is small and hand-written; the dictionary is corpus data (§3, §6) |
| I8 | The parser and the emitter must not drift | Brief §5.3, IR §4.2 law L1/L2 | One table read in two directions (§6.4) |
| I9 | The explainer reads what the parser produced | Brief §4.1 consequence 2 | Bindings carry explainer references, not just values (§12) |
| I10 | Hostile input, in a memory-safe language, in a single-threaded tab | §13 | Panics and hangs are the threat, not memory corruption |

I1 and I2 are the two that make this different from every config parser in the prior art.
Batfish parses complete files it was handed by an operator on a server. Fathom parses forty
lines someone highlighted in a PuTTY window, in the same address space as the secret those
lines contain.

---

## 2. The pipeline: seven stages, one shape

### 2.1 The stages

```text
   raw paste (bytes, any encoding, any damage)
       │
  ┌────▼─────┐
  │ 1 FRAME  │  encoding normalisation, line endings, transport-noise classification,
  │          │  continuation joining, banner/blob capture.  → [LogicalLine]
  └────┬─────┘     shared machinery, per-platform noise catalogue
  ┌────▼─────┐
  │ 2 LEX    │  bytes → [Token{kind, span}] per logical line.  Quoting, bracket lists,
  │          │  comment forms.                                 → [TokenLine]
  └────┬─────┘     shared scanner, per-platform token table
  ┌────▼─────┐
  │ 3 SHAPE  │  token lines → the platform CST: a StmtTree of (path, args, span).
  │          │  This is where flat-set, curly-brace, mode-stack and XML converge.
  └────┬─────┘     per-platform shaper, ~200–600 lines each
  ┌────▼─────┐
  │ 4 REDACT │  ══ THE GATE ══  path catalogue + value-shape detectors + block
  │          │  detectors.  Rewrites capture text, produces the drop manifest.
  └────┬─────┘     shared engine, per-platform catalogue.  NOTHING PASSES UNGATED.
  ┌────▼─────┐
  │ 5 BIND   │  StmtTree → IR fragment, by longest-prefix match against the
  │          │  statement dictionary.  Scalars parsed via IR §4.2 `Scalar::parse`.
  └────┬─────┘     shared trie walker, corpus dictionary
  ┌────▼─────┐
  │ 6 RESOLVE│  name references → edges; containment closure; capture scope
  │          │  computation; inference deferred to the graph's own pass.
  └────┬─────┘     shared
  ┌────▼─────┐
  │ 7 RECON- │  match the fragment onto the existing graph (IR §10.4), produce a
  │   CILE   │  plan, apply on confirmation.                   → graph delta
  └────┬─────┘     shared
       ▼
   graph delta + capture + residue + drop manifest + ingest report
```

### 2.2 What is shared and what is not

This table is the answer to "design one pipeline, and say what is shared."

| Stage | Shared | Per-platform | Per-platform size, estimated |
|---|---|---|---|
| 1 Frame | encoding normalisation, line-ending handling, wrap detection, the ledger | noise pattern catalogue (prompts, pagination, banners), continuation rules, block-capture triggers | ~40–80 lines of catalogue |
| 2 Lex | the scanner skeleton, span arithmetic, the arena | quote characters, escape rules, comment syntax, bracket-list syntax, bare-token charset | ~60–150 lines |
| 3 Shape | the `StmtTree` type and its builder API, depth guard, error classification | the shaper itself — the only genuinely different code in the pipeline | ~200–600 lines |
| 4 Redact | the detector engine, the manifest, the span rewriter, the generic value-shape detectors | the path catalogue (derived from the dictionary, §9.3), platform secret encodings (`$9$`, type 7) | ~30–60 dictionary flags |
| 5 Bind | the trie walker, scalar dispatch, provenance construction, fragment assembly | **the statement dictionary** — corpus data, not code | 400–2,500 YAML entries |
| 6 Resolve | all of it | reference-shape declarations in the dictionary | 0 lines of code |
| 7 Reconcile | all of it | identity tuples (already in the IR schema, IR §10.3) | 0 lines of code |

**The only per-platform Rust is the lexer table and the shaper.** Everything downstream of
stage 3 sees one type. That is the property that makes I7 achievable, and it is the reason
`StmtTree` exists at all.

### 2.3 Why a CST, and not straight to the IR

A shaper that emitted IR nodes directly would be shorter. Four things make it wrong:

1. **Redaction has to run between them.** The gate needs a structure with spans and leaf
   values but no semantics — it must be able to redact `set foo bar baz secret-thing`
   without knowing what `foo` is. If shaping produced IR nodes, the gate would have to run
   over IR nodes, which means unknown statements (the ones most likely to hide an unknown
   secret) would never reach it, because they never become nodes.
2. **Explain works on statements, not nodes.** A line the dictionary does not cover still
   has a shape, and §12 says something useful about it. That requires a stage where "this
   is a well-formed `set` statement whose path we do not recognise" is representable.
3. **The dictionary is the thing under review.** Keeping the syntax→semantics mapping in one
   declarative table means a reviewer can diff it. Fused into shaper code, it is 3,000 lines
   of `match` nobody audits.
4. **Two Junos syntaxes, one dictionary.** Curly-brace and `display set` are the same
   statement paths written two ways (§5.2). Shaping them into a common CST makes that
   literally true and gives a free differential test (§13.4).

The cost: one more full materialisation of the input in memory. §11.3 budgets it.

### 2.4 The CST

```rust
/// The platform-independent shape every shaper produces.
/// Flat for junos-set and panos-set; nested for junos-curly, ios, panos-xml.
pub struct StmtTree {
    pub arena: Vec<StmtNode>,
    pub roots: Vec<StmtIdx>,
    /// Interned path segments. Segment text is a slice of the redacted capture.
    pub segs: SegInterner,
}

pub struct StmtNode {
    /// Path segment at this level: `security`, `ike`, `gateway`, `GW-B`, ...
    pub seg: SegId,
    pub parent: Option<StmtIdx>,
    pub children: Range<u32>,          // into a child index side-vec, ordered as read
    /// Terminal arguments: everything after the deepest path segment.
    /// Empty for interior nodes. Values, not keys — the dictionary decides where
    /// the boundary is (§5.1).
    pub args: Range<u32>,              // into `args` side-vec
    pub verb: Verb,                    // Set | Deactivate | Delete | Activate | Annotate | ...
    pub span: ByteSpan,                // the whole statement, in capture coordinates
    pub line: LineOrdinal,             // which LogicalLine produced it
    pub flags: StmtFlags,              // Inactive | Protected | Replaced | FromGroup(SegId)
}

pub struct Arg {
    pub span: ByteSpan,
    pub kind: ArgKind,                 // Bare | Quoted | BracketList | Redacted(SecretLabel)
}
```

Three properties worth stating because they constrain everything downstream:

- **The tree is ordered as read.** Config order carries meaning (policy ordinals, IOS ACL
  lines, PAN rulebase order). The arena preserves it and never sorts.
- **Every node carries a span into the *redacted* capture.** There are no pre-redaction
  coordinates anywhere after stage 4, by construction (§9.5).
- **`args` is not "the value".** The shaper does not know where a path ends and a value
  begins. `set security ike gateway GW-B address 203.0.113.10` could be path
  `.../address` with arg `203.0.113.10`, or path `.../address/203.0.113.10` with no args.
  Only the dictionary knows. So the shaper emits the full token vector as a path and the
  binder decides the split (§7.1). This is a **DECISION** and it is what keeps the shaper
  free of semantics.

---

## 3. Choosing the parsing approach — DECISION

### 3.1 The requirements, in priority order

Priority order matters more than the list, because the candidates trade against each other
and the winner is decided by the top three.

| # | Requirement | Why it ranks here |
|---|---|---|
| R1 | **Error recovery at line granularity, always producing a usable result** | I1. A parser that returns `Err` on a 4,000-line paste with one bad line has failed at the product's primary on-ramp |
| R2 | **Every unrecognised byte is classified and preserved, not discarded** | I4. This is stronger than "recovers"; it requires the parser to *account*, not just to continue |
| R3 | **Adding a platform is mostly data** | I7. Four platforms now, and the vocabulary gap in §2.1 of the brief is a multi-vendor problem by definition |
| R4 | **Small in WASM, no exotic build toolchain** | I6, plus §8.6's "eliminate Node.js from the build" and the reproducible-build requirement in §7.7 |
| R5 | **Deterministic** | I5 |
| R6 | **The syntax→semantics mapping is reviewable as a document** | I8, and invariant 10's human-review posture |
| R7 | Incremental reparse | Ranked last on purpose. See §3.3 |
| R8 | Good "expected X, found Y" diagnostics | Ranked low. See §3.4 |

### 3.2 The candidates

| Approach | R1 recovery | R2 accounting | R3 data-driven | R4 size/build | R5 determinism | R6 reviewable | Verdict |
|---|---|---|---|---|---|---|---|
| **Hand-written line-oriented shaper + declarative dictionary** | Native — the unit of recovery *is* the line | Native — the framer owns the ledger | Dictionary is YAML; shaper is ~400 lines of Rust per platform | Smallest; no codegen, no external toolchain | Yes | The dictionary is a reviewable document | **Chosen** |
| **tree-sitter grammars** | Best-in-class: `ERROR` and `MISSING` nodes, tree stays usable | Recoverable from the tree, but `ERROR` node granularity is not line granularity | Grammar is JS, compiled to a C parse table — that is code, not data | One `.wasm` per grammar plus the runtime; emscripten and a Node-based generator in the build | Yes | Grammar is reviewable; the binder still is not | Rejected — §3.3 |
| **PEG (`pest`)** | Weak. PEG failure is one position with an expected set; there is no recovery discipline | Poor | Grammar file is data-ish, but ordered choice makes it order-dependent code in disguise | Generated parser per platform + runtime | Yes | Grammar reviewable | Rejected — §3.4 |
| **Combinators (`nom` / `winnow`)** | Manual. Recovery is whatever you hand-write, i.e. the chosen option with extra layers | Manual | Grammar is Rust code. Platform five is a Rust PR and a release | Small, no codegen | Yes | No | Rejected as a grammar layer; see §3.5 |
| **Combinators with recovery (`chumsky`)** | Real recovery, designed for it | Manual | Rust code | Larger compile time and binary than hand-written | Yes | No | Rejected — §3.5 |
| **ANTLR4, as Batfish does** | Batfish's `BatfishANTLRErrorStrategy` discards lines until prediction succeeds and inserts each as an `ErrorNode` — exactly the right strategy | Good, via those error nodes | Grammar files, but enormous ones | JVM-first; the Rust target is community-maintained; grammar size is the reason Batfish ships as a Java service in Docker | Yes | Grammars are reviewable but huge | Rejected as a tool, **adopted as a strategy** — §3.6 |

### 3.3 Why not tree-sitter, when tree-sitter is the obvious answer

tree-sitter is genuinely excellent at R1. It is the best error recovery in the general
parsing landscape and it produces a tree you can walk after a syntax error. If the
requirement list stopped at R1 it would win.

It loses on four grounds, and the fourth is the one that decides it.

1. **Incremental reparse is worth nothing here.** tree-sitter's headline feature is
   re-parsing after a small edit in a source buffer. Fathom's input is a *paste*: it arrives
   once, whole, and is never edited in place. There is no keystroke stream. Buying a large
   machine for its main feature and then not using that feature is how projects acquire
   dependencies they cannot remove. This is why R7 is ranked last — it is not a low-value
   requirement, it is a **non-requirement**, and admitting that changes the answer.
2. **The grammar is code in a foreign language.** tree-sitter grammars are JavaScript that
   generates a C parse table. That is worse for R3 and R6 than YAML and worse for R4 than
   Rust: the build acquires Node.js and emscripten at exactly the point where §8.6 wants
   them gone, and the reproducible-build story (§7.7) acquires two more toolchains to pin.
3. **It solves the small half.** Shaping `set security ike gateway GW-B address
   203.0.113.10` into a token path is not the hard part — it is `split_whitespace` with
   quote handling. The hard part is the 2,000-entry mapping from paths to kinds, fields and
   scalars, and tree-sitter has nothing to say about it. Measured in lines of work,
   tree-sitter addresses maybe 15% of the ingest surface.
4. **The recovery granularity is wrong.** `ERROR` nodes span whatever the parser could not
   reconcile, which may be one token or forty lines. R2 needs "this *line* was not
   understood, here it is verbatim, here is its ordinal". Deriving that from an `ERROR`
   node's extent is possible and lossy. For a line-oriented format, line-oriented recovery
   is not a compromise — it is the correct granularity, and it is trivially exact.

There is a real case where this decision inverts: if Fathom ever ships a config *editor*
with live parsing as you type, tree-sitter becomes right and this should be revisited.
That is not on the roadmap and building for it now is speculative.

<!-- VERIFY: per-grammar tree-sitter .wasm sizes. I could not find published figures and
     will not invent one. If someone measures four network-config grammars and they come
     in under ~150 KB each, argument 2's build-cost objection stands but the size objection
     does not, and the table above should be corrected. -->

### 3.4 Why not a PEG

PEG error handling is the disqualifier. A PEG parse either succeeds or fails at a position
with a set of expected tokens; there is no recovery construct in the formalism. The usual
workaround is to make the top-level rule `line*` where `line` falls back to
`unrecognised_line`, at which point the PEG is doing line splitting you could do in twelve
lines of Rust, and every genuinely useful property of the grammar formalism has been given
away to get there.

Ordered choice is the second problem. `a / b` silently means "b is unreachable when a
matches a prefix", and in a 2,000-production network-config grammar that failure is
invisible in review and shows up as a statement that binds to the wrong entry. A dictionary
trie with explicit longest-prefix semantics and a CI check for shadowed entries (§6.5) has
the same expressiveness for this problem and a decidable shadowing check.

R8 — "expected `dh-group`, found `dh-groupp`" — is also worth less than it looks. For
config text the useful diagnostic is at a different level: *"`set security ike proposal
IKE-P1 dh-groupp group14` — Fathom does not recognise `dh-groupp` under `security ike
proposal`. Nearest known statement: `dh-group`."* That is a dictionary lookup with edit
distance, not a parser feature, and we can produce it regardless of the parsing technology
(§8.7).

### 3.5 Why not combinators

`nom` and `winnow` are good crates and the wrong layer. A combinator grammar is Rust code:
adding PAN-OS Panorama template scoping means a Rust change, a review, a release, and a
version of the application. Under the chosen design it means a dictionary entry, which ships
in a corpus release alongside rule packs and can be reviewed by someone who knows PAN-OS and
not Rust. That difference compounds across every platform and every OS release.

`chumsky` has real recovery and would remove the hand-written recovery logic. Its recovery
strategies are designed for programming languages — delimiter matching, skip-until-sync —
and the sync token for a config file is the newline, which makes the machinery mostly
inert.

**Where combinators do belong:** the scalar layer. IR §4.2's `Scalar::parse` implementations
for `IpPrefix`, `InterfaceAddress`, `PortRange`, `RouteDistinguisher` and friends are small
grammars over short strings, they benefit from combinator composition, and they are already
per-type rather than per-platform. **RECOMMENDATION — use `winnow` for scalar parsing and
nothing above it.** That keeps the dependency, uses it where it earns its place, and does
not let it become the grammar layer.

### 3.6 What we take from Batfish

Batfish is the closest prior art and it made the same class of decision from the opposite
direction. Its Juniper grammar is called `flatjuniper` — it parses the flattened
`display set` form, not the curly-brace form, which is independent confirmation of the
ordering in this document's assignment. Its error strategy discards lines until adaptive
prediction succeeds and attaches each discarded line to the tree as an error node.

We take the strategy and reject the tool. The strategy — *the line is the recovery unit, and
a discarded line is attached to the tree rather than dropped* — is exactly R1 and R2, and it
is arrived at by a team who parsed real multi-vendor configs at scale for a decade. The
tool is ANTLR with grammars in the tens of thousands of lines, on the JVM, which is a large
part of why Batfish is a Docker service and Fathom cannot be.

Sources: [Batfish `flatjuniper` lexer](https://github.com/batfish/batfish/blob/master/projects/batfish/src/main/antlr4/org/batfish/grammar/flatjuniper/FlatJuniperLexer.g4),
[`BatfishANTLRErrorStrategy`](https://github.com/batfish/batfish/blob/master/projects/batfish-common-protocol/src/main/java/org/batfish/grammar/BatfishANTLRErrorStrategy.java).

### 3.7 DECISION, stated plainly

> **DECISION — hand-written, line-oriented framer and lexer; a small hand-written shaper per
> platform producing one shared CST; and a corpus-authored statement dictionary that drives
> binding, redaction, emission and explanation from one table.**
>
> No parser generator. No PEG. No grammar DSL. Combinators confined to scalar parsing.

### 3.8 What this decision costs

Named, because every design has a cost.

| Cost | Detail | Mitigation |
|---|---|---|
| **No formal grammar to review** | There is no artefact a reviewer can read to know what the shaper accepts. The shaper's behaviour is its tests | The shaper is ≤600 lines, is the primary fuzz target (§13), and its accepted-shape set is enumerated in a table per platform (§5) |
| **Hand-written parsers have hand-written bugs** | A generated parser cannot have an off-by-one in span arithmetic. Ours can, and spans are load-bearing for redaction | Span arithmetic is centralised in the framer/lexer arena, not repeated per shaper; property test: every token's span slices back to its own text (§13.2) |
| **We give up incremental reparse permanently** | If the editor case arrives, this is a rewrite of stages 1–3 | Stages 4–7 are unaffected, which bounds the rewrite to ~2,000 lines |
| **No "expected X" diagnostics from the parser** | We produce dictionary-level suggestions instead, which are better for the user and worse for debugging the parser | Diagnostics carry the shaper state at failure, for us, behind a developer flag |
| **The dictionary becomes the bottleneck** | 2,000 entries per platform is real authoring work, and a wrong entry is a wrong graph | §6.5's validation gates; §13.3's round-trip corpus; and the honest statement that platform coverage is a content programme, not a sprint |

---

## 4. Frame: turning a paste into logical lines

### 4.1 Why this is a stage and not a `lines()` call

The paste is not a file. It is whatever was in the clipboard, and the clipboard has been
through a terminal emulator, possibly a wiki, possibly a PDF, possibly Word. §8.1 catalogues
the damage. The framer's job is to produce a sequence of **logical lines** where the damage
has been classified — not removed, *classified* — and to hold the ledger that makes I4
provable.

```rust
pub struct LogicalLine {
    pub ordinal: LineOrdinal,        // dense, from 0, in input order
    /// Spans of the physical lines that were joined to make this one.
    /// Post-redaction coordinates after stage 4 rewrites them.
    pub pieces: SmallVec<[ByteSpan; 1]>,
    pub join: JoinKind,              // None | Backslash | HardWrap(u16) | Soft | Block
    pub class: LineClass,
}

pub enum LineClass {
    Statement,                       // goes to the lexer
    Noise(NoiseClass),               // classified, kept in the capture, not lexed
    Blank,
    OpaqueBlock(BlockKind),          // banner body, certificate blob — see §4.5
}

pub enum NoiseClass {
    Prompt { hostname: Option<Span>, mode: PromptMode },
    ClusterBanner { node: u8 },      // Junos {primary:node0}
    Pagination,                      // ---(more 24%)---, --More--
    EditMarker,                      // Junos [edit ...]
    AnsiEscape,
    SessionTimestamp,
    DiffMarker { sign: u8 },         // leading + / - from a pasted diff
    QuoteMarker,                     // leading "> " from an email
    CommandEcho,                     // the `show configuration | display set` line itself
    Separator,                       // IOS `!`, PAN blank-line groups
    Unknown,
}
```

### 4.2 Encoding normalisation, in order

Order matters; each step assumes the previous one.

| # | Step | Detail | Recorded? |
|---|---|---|---|
| 1 | Strip UTF-8 BOM | `EF BB BF` at offset 0 only | ledger note |
| 2 | Decode | UTF-8 strict. On failure, retry as Windows-1252 (the common outcome of a PuTTY log through a Windows tool) and mark the capture `encoding: cp1252-fallback`. On second failure, **refuse the paste** with a message naming the byte offset | yes |
| 3 | Line endings | `\r\n` and lone `\r` → `\n`. A lone `\r` used for progress redraw collapses runs | count only |
| 4 | Strip ANSI CSI/OSC | `ESC [ ... final` and `ESC ] ... BEL/ST`. Also `\x08` backspace runs, which Junos pagination uses to erase `---(more)---` | classified as noise, spans kept |
| 5 | Confusable normalisation | U+00A0 → space; U+2018/2019 → `'`; U+201C/201D → `"`; U+2013/2014 → `-`; U+00AD (soft hyphen) → removed; U+200B → removed | **each one recorded individually in the manifest** |
| 6 | Tabs | → single space, except inside an `OpaqueBlock` | count only |
| 7 | HTML entities | `&quot; &amp; &lt; &gt; &#39;` decoded **only if** the paste contains no literal `<` outside a decoded entity, to avoid mangling `<psk>`-style placeholders | yes, with the guard's decision |

Step 5 deserves the individual record. A config pasted out of a PDF field card or a Word
change ticket arrives with `"` replaced by `"` and `-` replaced by `–`, and the resulting
parse failures are baffling to a user who can see, in their own paste, a perfectly correct
line. The ingest report says so explicitly:

```text
▌ 14 characters were substituted before parsing
▌ curly quotes → " (6)   en-dash → - (7)   non-breaking space → space (1)
▌ this paste came through a word processor or a PDF
```

That last sentence is the useful one. It is the field card's device: a disclaimer that is
also a diagnosis.

### 4.3 Continuation joining — three mechanisms, ranked

This is the subtlest part of framing and it produces the worst failures when done naively.

| Mechanism | Trigger | Join rule | Confidence |
|---|---|---|---|
| **Backslash** | physical line ends with an unquoted `\` | drop the `\`, drop the next line's leading whitespace, join with exactly one space | certain |
| **Hard wrap** | terminal wrapped at a width | join with **no separator** | inferred, see below |
| **Soft continuation** | the next line does not begin with a recognised verb and is not noise | join with exactly one space | inferred |

The backslash form is what the field card itself uses (`set security ike proposal IKE-P1 \`)
and it is unambiguous.

**Hard-wrap detection.** A terminal wrapping at column *L* inserts a newline with no
separator, which means naive space-joining corrupts the token it split. From the field
card's own zone line, a paste wrapped at 88 columns gives:

```text
set security zones security-zone WAN interfaces reth0.0 host-inbound-traffic system-servi
ces ike
```

Space-joining yields `system-servi ces ike`. Concatenating yields `system-services ike`.
Both are syntactically plausible; only one is right.

The algorithm:

```text
detect_wrap_width(lines) -> Option<u16>:
  1  h := histogram of physical line lengths over Statement-candidate lines
  2  for L in descending order of h[L]:
       if h[L] >= 3
          and L >= 60
          and every line of length exactly L is immediately followed by a line
              that is not a verb-initial line
       then return Some(L)
  3  return None
```

Complexity `O(n)` for the histogram plus `O(distinct lengths)` for the scan; distinct
lengths are bounded by the longest line. In practice this terminates on the first candidate.

Then, per continuation:

| Situation | Action |
|---|---|
| wrap width `L` detected and the previous physical line has length exactly `L` | join with no separator |
| wrap width detected, previous line shorter than `L` | join with one space (it is a soft continuation, not a wrap) |
| no wrap width detected | join with one space |
| **both joins produce a dictionary-resolvable path, and they differ** | do not guess. Emit the line as `Unshaped { reason: AmbiguousJoin }` with both candidates in the diagnostic |

That last row is the important one. **When the parser cannot tell, it says so rather than
picking.** A wrong join produces a wrong value in the graph with full `Asserted` confidence,
which is the worst outcome this pipeline can produce. An unshaped line produces a visible
residue entry and a prompt. Ranked by damage, that ordering is not close.

**Verb recognition** is what makes soft continuation decidable for Junos. A `display set`
logical line must begin with one of `set`, `deactivate`, `delete`, `activate`, `annotate`,
`insert`, `rename`, `copy`, `protect`, `unprotect`, `wildcard`, `replace:`. In practice
`display set` output emits only `set` and `deactivate`, but users paste hand-written change
scripts, so the recogniser accepts the whole config-mode verb set. Anything else that is not
noise is a continuation candidate.

<!-- VERIFY: the exact set of verbs that can appear in `show configuration | display set`
     output across Junos releases — specifically whether `protect` and `wildcard range`
     statements are rendered as such. Confirm against a real box before the recogniser
     table ships. -->

This is the concrete, mechanical reason `display set` is the primary format and this
document's assignment orders it first: **it has a decidable record boundary.** Curly-brace
Junos and IOS do not — a continuation there is indistinguishable from a nested statement
without semantic knowledge.

### 4.4 Noise is evidence

The transport noise a naive parser deletes is the highest-value metadata in the paste.

| Noise | What it tells us | Confidence |
|---|---|---|
| `admin@srx-a-01>` | hostname `srx-a-01`; Junos; operational mode | `Heuristic` |
| `admin@srx-a-01#` | as above, configuration mode — so this paste may be *uncommitted* | `Heuristic` |
| `{primary:node0}` | Junos chassis cluster, this RE is primary for RG0, we are on node0 | `Heuristic` |
| `{backup}` / `{master}` | cluster or virtual-chassis role | `Heuristic` |
| `[edit security ike]` | the config-mode context the following `set` lines are *relative to* — see §8.6 | `Heuristic` |
| `srx-a-01(config-if)#` | IOS, and the current sub-mode — a free anchor for a context-free fragment | `Heuristic` |
| `show configuration \| display set` echoed | the capture `command`, which IR §8.4's `Capture` records, and the format | `Asserted` |
| `---(more 24%)---` | the paste is **incomplete** — the user pressed `q`. Capture scope drops to `Fragment` | `Asserted` |

The last row is worth its own sentence. A pagination marker anywhere in the paste means the
capture is truncated, which means `CaptureScope` is `Fragment`, which means IR §8.5 forbids
asserting `Absent` for anything, which means `ipsec.pfs.absent` cannot fire on this device
from this paste. That chain — noise marker to finding suppression — is entirely mechanical
and it is the difference between a tool that is trustworthy about absence and one that is
not.

Hostname and platform extracted from a prompt carry `Origin::Parsed` with
`Confidence::Heuristic` (IR §8.3), never `Asserted`. A prompt can be a jump host, a renamed
box, or a colleague's screenshot.

### 4.5 Opaque blocks — the worst thing in an IOS config

Some content is not line-oriented at all and must be captured by the framer before anything
else looks at it, because its body can contain arbitrary bytes including things that look
like statements.

| Block | Platform | Start | End | Why it must be framed, not shaped |
|---|---|---|---|---|
| Banner | ios / ios-xe | `banner {motd\|login\|exec} <delim>` | next occurrence of `<delim>` | The body can contain `!`, `end`, `interface Gi0/0` — anything. A shaper that sees the body will invent configuration that does not exist |
| Certificate chain | ios / ios-xe | `crypto pki certificate chain <n>` then a `certificate ...` line | `quit` | Hex blob, indented, thousands of lines. Also a redaction target (§9.3) |
| PEM block | any | `-----BEGIN <label>-----` | `-----END <label>-----` | As above |
| Junos `inline` / `text` blocks | junos | e.g. `set system login message "..."` spanning lines | closing quote | Rare in `display set`; common in curly-brace |
| PAN-OS multi-line values | panos | a quoted value containing newlines | closing quote | Rule descriptions routinely contain newlines |

Delimiter detection for the IOS banner is: the first non-whitespace character after the
banner type is the delimiter, conventionally `^C` (a literal caret-C two-character sequence,
*not* U+0003) but legally any character. The framer must handle both the two-character
`^C` and a real control byte. Getting this wrong swallows the rest of the file — which is
one of the two failure modes (the other is §4.3's join) that can silently destroy a large
fraction of a paste, so both get dedicated fuzz targets (§13.2).

### 4.6 The ledger

```rust
pub struct LineLedger {
    pub capture_len: u32,
    pub lines: Vec<LedgerEntry>,     // dense, ordered, non-overlapping, exhaustive
}
pub struct LedgerEntry {
    pub ordinal: LineOrdinal,
    pub span: ByteSpan,              // post-redaction capture coordinates
    pub outcome: LineOutcome,        // filled progressively by stages 3, 4, 5
}
```

**Invariant L (the accounting invariant):** the ledger's spans, plus the single-byte
separators between them, tile `[0, capture_len)` exactly — no gaps, no overlaps. Asserted
in `debug_assert`, property-tested on every fuzz input (§13.2), and checked once on every
real ingest before the plan is presented.

This is what makes I4 a proof instead of a promise. "Nothing is silently lost" is not a
process claim; it is an arithmetic identity that CI checks.

---

## 5. Lex and Shape: the four platform CSTs

### 5.1 Junos `display set` — the primary format

**The grammar of a logical line:**

```text
record   := verb SP+ token (SP+ token)*
verb     := "set" | "deactivate" | "delete" | "activate" | ...
token    := bare | quoted | bracket_list
bare     := [^ \t"\[\]]+
quoted   := '"' ( [^"\\] | '\\' any )* '"'
bracket_list := '[' SP* (token SP+)* token? SP* ']'
```

That is the entire syntax. It is eleven lines and it is why §3 rejects a parser generator.

The shaper walks the tokens, interning each as a path segment under the previous, and hangs
them off the tree. Because §2.4 says the shaper does not decide where the path ends, **every
token becomes a path segment and `args` is empty for `display set`.** The binder does the
splitting (§7.1). Consequences:

- `set security ike gateway GW-B address 203.0.113.10` produces a path of seven segments.
- Two lines sharing a prefix share tree nodes, so the tree is the config hierarchy, rebuilt
  from flat lines for free. That is the same fact that makes curly-brace and set-form
  equivalent (§5.2).
- `deactivate` sets `StmtFlags::Inactive` on the node the path reaches, and on nothing else.
  `display set` output renders Junos `inactive:` markers as `deactivate` statements, so this
  is the only place inactivity appears in this format.

**What `display set` loses, and why we must say so.** Annotations entered with `annotate`
are not rendered in `display set` output. A config with careful `/* ... */` comments
explaining *why* a policy exists arrives with all of that stripped. For a product whose
third pillar is teaching, that is a real loss, and the honest response is to say it in the
ingest report and to offer the curly-brace form as an alternative paste that preserves them
(§5.2).

<!-- VERIFY: whether current Junos releases render `annotate` output under `| display set`.
     Multiple community sources say they do not; confirm against a box, because if a
     release does render them the dictionary gets an `annotate` entry and comments become
     ingestible provenance. -->

**Configuration groups — the failure mode that matters most.** `display set` output contains
`set groups <g> ...` definitions and `set apply-groups <g>` statements, but **not the
expansion**. The effective configuration of a group-heavy device is therefore not in the
paste at all.

> **DECISION — Fathom does not expand configuration groups. It detects them and asks for the
> expanded output.**

Reimplementing Junos group inheritance means reimplementing wildcard segment matching,
interface ranges, `apply-groups` precedence at multiple hierarchy levels, and
`apply-groups-except`. Every one of those has silent-wrongness failure modes, and the user
has a one-command fix: `show configuration | display inheritance | display set`. So:

- Group definitions bind into a separate namespace and produce no device nodes.
- Every `apply-groups` statement raises a **completeness prompt** (IR §9.3 shape, not a
  finding), and every stanza under an `apply-groups` scope is marked such that rules
  depending on it return `Unevaluable` rather than a confident wrong answer.
- The ingest report leads with it:

```text
▌ THIS CONFIG USES CONFIGURATION GROUPS — WHAT YOU PASTED IS NOT WHAT THE BOX IS RUNNING
▌ 3 groups defined, applied at 2 levels.
▌ paste this instead:  show configuration | display inheritance | display set
```

Cost, named: a user who ignores the prompt gets a graph with holes, and the holes are in
whichever stanzas the groups populate — often exactly the security and interface stanzas
that matter. The alternative is a graph that is confidently wrong, which is worse. See §16
for the open question of whether a restricted expander (literal segments only, no wildcards,
single level) is worth building.

### 5.2 Junos curly-brace — the same paths, written differently

```text
security {
    ike {
        gateway GW-B {
            address 203.0.113.10;
            external-interface reth0.0;
            version v2-only;
        }
    }
}
```

The shaper is a brace-depth walker maintaining a segment stack. Each `identifier;`
terminates a statement whose path is `stack ++ tokens`. Each `identifier {` pushes.

**The claim that makes this cheap: the curly-brace shaper and the set shaper produce
identical `StmtTree`s for the same configuration.** That is the definition of what
`display set` *is* — the flattening of the hierarchy into leaf paths. If our two shapers
disagree, one of them is wrong, and we can find out mechanically (§13.4).

Extra syntax the curly form carries and the set form does not:

| Form | Meaning | Handling |
|---|---|---|
| `inactive: gateway GW-B { ... }` | deactivated stanza | `StmtFlags::Inactive` on the subtree — the same flag `deactivate` produces |
| `protect: ...` | commit-protected | `StmtFlags::Protected` |
| `/* comment */` before a statement | an `annotate` comment | **Bound as `Text` into the node's `notes` field (IR §6.2)** — this is content `display set` cannot give us |
| `# comment` | a plain comment | ledger `Noise(Separator)`; not bound |
| `## Last changed: ...` | inserted by `display inheritance` and by commit metadata | noise, but the timestamp is extracted as evidence-age input (IR §8.7) |
| `replace:` / `apply-groups` | as §5.1 | as §5.1 |

**RECOMMENDATION — offer both paste formats, and say which one keeps your comments.** The
UI's paste target should carry a one-line margin tab: `display set is easier to parse ·
curly-brace keeps your annotations`. That is a real trade the user should get to make.

### 5.3 IOS / IOS-XE — the mode stack

IOS `show running-config` is nested by *mode*, and mode transitions are driven by commands,
not by punctuation. Indentation exists but is a rendering, not a grammar: sub-mode commands
are conventionally indented one space, certificate bodies more, banner bodies not at all.

> **DECISION — the mode stack is dictionary-driven; indentation is corroboration, never
> authority.**

```text
shape_ios(lines):
  stack := [ROOT]
  for each Statement line:
     tokens := lex(line)
     if line is `end`:            stack := [ROOT]; continue
     if line is `exit`:           pop(stack);      continue
     if line is `!` at column 0:  stack := [ROOT]; continue      # see below
     entry := dict.longest_prefix(stack.path ++ tokens)
     if entry.enters_mode:
        emit statement at stack.path ++ tokens
        push(stack, tokens_consumed_by(entry))
     else if entry matched under stack.path:
        emit statement at stack.path ++ tokens
     else if entry matched under ROOT:
        # the line is a top-level command; the previous mode ended without `exit`
        stack := [ROOT];  emit;  record Diag::ImplicitModeExit
     else:
        emit Unshaped{ UnknownInMode(stack.path) }
     corroborate(indent(line), depth(stack))   # mismatch -> Diag, never a control decision
```

Three things this gets right that an indentation-driven parser does not:

1. **`!` is a comment, not a delimiter.** Cisco emits `!` between top-level blocks, so
   "pop to root on `!` at column 0" is a good heuristic — but `!` also appears *inside*
   `route-map` between clauses, where popping is wrong. The dictionary resolves it: after
   popping on `!`, if the very next line binds only under the popped mode, the pop is undone
   and a `Diag::SpuriousSeparatorPop` is recorded. One line of lookahead, no ambiguity.
2. **Missing `exit` is normal.** Real configs and real pastes omit `exit`. Falling back to
   "does this bind at root?" recovers automatically.
3. **A pasted fragment starting mid-mode is recoverable** from the prompt (`(config-if)#`,
   §4.4) or from §8.6's context inference.

The IOS shaper is the largest of the four (~600 lines) and it is the one that will have the
most bugs. It is also the one where the dictionary carries the most weight, because
`enters_mode` is dictionary data.

<!-- VERIFY: the precise indentation conventions of `show running-config` across IOS-XE
     releases (one space vs. varying), and whether any sub-mode is emitted unindented.
     This only affects the corroboration diagnostic, not correctness, but the diagnostic
     will be noisy if the assumption is wrong. -->

### 5.4 PAN-OS — two forms, one path space

PAN-OS gives us two inputs and they are not equivalent in quality.

| Form | Obtained by | Shape | Notes |
|---|---|---|---|
| `set` format | `set cli config-output-format set`, then `configure`, then `show` | Identical in structure to Junos `display set` — reuses the Junos set shaper with a different token table | What users actually paste, because it is what they see |
| XML | `running-config.xml` exported via scp/tftp or the XML API | Element tree; `<entry name="X">` elements are named children | Complete and unambiguous. Palo's own documentation notes the set-format output is for review and the XML file is the importable artefact |

The XML shaper maps `element` → path segment, and `<entry name="X">` → the two segments
`entry`, `X` collapsed to the single segment `X`. That produces **the same path space as the
set form**, which means one dictionary serves both — and gives a second free differential
oracle (§13.4).

PAN scoping is the wrinkle: paths are rooted differently for a firewall
(`devices/localhost.localdomain/vsys/vsys1/...`) versus Panorama
(`devices/.../template/<t>/config/...`, `device-group/<dg>/...`). The dictionary handles this
with a **root alias table** per platform variant rather than duplicated entries: a small set
of prefix rewrites applied before trie lookup, declared as data.

<!-- VERIFY: the exact Panorama template and device-group path prefixes, and whether
     `shared` objects sit at `/config/shared` in both set and XML forms. These are
     load-bearing for the alias table and I am not certain enough to write them as fact. -->

### 5.5 The cost of platform five

Itemised, because §3's whole argument is that this number is small.

| Item | Effort | Kind of work |
|---|---|---|
| Framer noise catalogue | ~1 day | Data. Prompt shapes, pagination markers, block delimiters |
| Lexer token table | ~1 day | Data + a few lines |
| Shaper | 3–10 days | Rust. Free if the platform uses a set-style or XML form we already shape |
| Scalar token tables (IR §4.3) | 3–5 days | Data. `DhGroup`, `EncryptionAlgorithm`, `InterfaceName` grammar |
| Redaction catalogue | ~1 day | Data. Plus the generic detectors, which are free |
| **Statement dictionary** | **20–200+ days** | **Content.** 400 entries for a narrow IPsec-only slice; 2,500 for broad coverage |
| Emitter | separate document | |
| Explainer corpus, three depths | open-ended | Content, human-authored (invariant 10) |

**The machinery is one to two weeks. The dictionary is the programme.** That is the
justification for §3.7 in one line: we chose the design that makes the small part small and
makes the large part reviewable data rather than code.

---

## 6. The statement dictionary — the normaliser

### 6.1 An entry

```yaml
# corpus/dict/junos-srx/security-ike.yaml
- id: junos-srx/security.ike.gateway.external-interface
  path: [security, ike, gateway, "$gw", external-interface, "$unit"]
  binds:
    kind: IkeGateway
    key:  { name: "$gw" }              # identity within the containing Device
    edge:
      kind: ExternalInterface
      to:   { kind: LogicalUnit, resolve: interface_unit("$unit") }
  emit:
    template: "set security ike gateway {{name}} external-interface {{unit}}"
    order: 320
    risk: ChangesConfig
  explain: explain:field:IkeGateway.external_interface
  versions: "*"
  reviewed_by: <named human>

- id: junos-srx/security.ike.policy.pre-shared-key.ascii
  path: [security, ike, policy, "$pol", pre-shared-key, ascii-text, "$value"]
  secret: { label: Psk }               # ← §9.3: this flag *is* the redaction catalogue
  binds:
    kind: IkePolicy
    key:  { name: "$pol" }
    field: pre_shared_key
    value: { const: "SecretPlaceholder{label: Psk}" }
  emit:
    template: 'set security ike policy {{name}} pre-shared-key ascii-text "<PSK>"'
    order: 210
    risk: ChangesConfig
  explain: explain:field:IkePolicy.pre_shared_key
  versions: "*"
  reviewed_by: <named human>

- id: junos-srx/security.ipsec.vpn.traffic-selector
  path: [security, ipsec, vpn, "$vpn", traffic-selector, "$ts",
         local-ip, "$local", remote-ip, "$remote"]
  binds:
    kind: TrafficSelector
    owner: { kind: IpsecVpn, key: { name: "$vpn" } }
    key:   { name: "$ts" }
    fields:
      local_ip:  { from: "$local",  scalar: IpPrefix }
      remote_ip: { from: "$remote", scalar: IpPrefix }
  emit:
    template: "set security ipsec vpn {{owner.name}} traffic-selector {{name}} \\\n  local-ip {{local_ip}} remote-ip {{remote_ip}}"
    order: 470
    risk: ChangesConfig
  explain: explain:field:TrafficSelector.local_ip
  versions: "*"
  reviewed_by: <named human>
```

### 6.2 The entry schema

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | `<platform>/<dotted-path>`, matching the command-corpus convention. Stable forever |
| `path` | yes | Ordered segments. `$name` is a capture; a literal is a literal |
| `secret` | no | Marks the entry as secret-bearing and names the `SecretLabel`. §9.3 |
| `binds.kind` | yes | The IR kind this statement is *about* |
| `binds.owner` | no | The containment parent, resolved from earlier captures |
| `binds.key` | yes | Which capture identifies the node within its owner. Feeds IR §10.3 identity |
| `binds.field` / `binds.fields` | one of | Field assignments with a scalar type from IR §4.3 |
| `binds.edge` | no | An edge to create, with a target resolution expression |
| `binds.presence` | no | `set` → `Set`; a statement whose *absence* implies `Absent` under a closed-world capture is declared here |
| `emit` | yes | The template, order hint and `Risk`. §6.4 |
| `explain` | yes | The explainer this line maps to at all three depths. §12 |
| `versions` | yes | A `vers` predicate in the rulepack spec's syntax |
| `deprecated_by` | no | Points at the successor entry when a platform renames a statement |
| `reviewed_by` | yes | Invariant 10 |

### 6.3 Compilation: the trie

Entries compile at build time to a trie over interned segments.

```rust
pub struct DictNode {
    /// Literal children, sorted by SegId for deterministic iteration (I5).
    literal: Box<[(SegId, DictIdx)]>,
    /// At most one capture child. Literal always wins.
    capture: Option<(CaptureName, DictIdx)>,
    /// Terminal binding, if a path may end here.
    entry: Option<EntryId>,
}
```

**Lookup** walks the statement path, preferring the literal edge and falling back to the
capture edge, with backtracking when a branch dead-ends.

- Worst case with `v` capture positions is exponential in `v` in theory. In practice `v ≤ 4`
  and the trie is shallow.
- **Bounded anyway:** the walker has a hard budget of 64 node visits per statement. CI
  asserts that no entry in any shipped dictionary requires more than 8, so the budget is
  never reached by correct input and a pathological input costs 64 visits, not `2^v`.
- **Longest match wins.** A path that reaches a terminal but has unconsumed tokens continues
  the walk; if no deeper terminal exists, the terminal found is used and the remaining
  tokens become `args`. This is what implements §2.4's "the shaper does not decide where the
  path ends".

Complexity per statement: `O(L)` where `L` is the token count, times a constant ≤ 8.
For a 20,000-line config at ~10 tokens per line, that is ~200,000 trie steps of a sorted
small-array probe.

### 6.4 The dictionary is the emitter's table, read backwards

> **DECISION — parsing and emission share one table. The `path` field is the parse
> direction; the `emit.template` field is the emit direction; CI proves they agree.**

This is what §6.3 of the brief means by *"the same machinery pointed backwards"*, made
literal, and it is what stops I8 (parser/emitter drift) at the source rather than with a
process.

**The CI gate:** for every dictionary entry with a fixture, `emit(bind(line)) == line` after
the platform's declared normalisation (IR §4.2, law L2). Every command and config line on
all four sides of the field card is a fixture. When a parser or an emitter regresses, the
field card breaks the build. That gate is already promised in IR §4.2; this document is
where it acquires a mechanism.

**What is *not* shared, and must not be.** Three things live only on the emit side:

| Not shared | Why |
|---|---|
| **Ordering and grouping** | The emitter must produce Phase 1 before Phase 2 and the object chain in dependency order (side 1). The parser accepts any order. `emit.order` is emit-only data |
| **Defaults suppression** | The emitter omits `Presence::Default` values (IR §5.2). The parser must bind them as `Set` when it sees them written |
| **Blockers** | The emitter reports missing required fields (IR §9.4). The parser has no equivalent — a missing statement is `Unknown`, not an error |

And three things live only on the parse side: `secret`, `deprecated_by`, and tolerance for
statements the emitter would never produce (deprecated spellings, `proposal-set standard`,
legacy policy-based VPN syntax).

**The honest cost.** A shared table means an emitter change can break the parser and vice
versa. That is the point — the alternative is that they drift silently — but it means the
dictionary is a hot file that two subsystems fight over, and its review burden is real.

### 6.5 Validating a dictionary

Build-time gates, all failures, not warnings:

| Gate | Check |
|---|---|
| **Shadowing** | No entry's path is a strict prefix of another's *unless* both are terminals and the shorter one declares `partial: true`. Catches the PEG ordered-choice failure mode decidably |
| **Capture arity** | Every `$name` in `binds` and `emit.template` appears in `path` |
| **Scalar coverage** | Every `scalar:` names a type in IR §4.3 and that type has a token table for this platform |
| **Kind/field existence** | Every `kind` and `field` exists in the schema at the declared `versions` |
| **Round-trip** | §6.4's gate, over the fixture corpus |
| **Secret coupling** | The set of entries with `secret:` equals the set of redaction paths (§9.9). This is IR §8.4's requirement, mechanised |
| **Explainer coverage** | Every entry has an `explain:` that resolves at all three depths. §12 depends on this being total |
| **Determinism** | The compiled trie serialises byte-identically across two builds |

---

## 7. Bind: statements to IR fragments

### 7.1 The algorithm

```text
bind(stmt_tree, dict, platform, capture) -> (IrFragment, [LedgerOutcome]):

  frag := IrFragment::new()
  for stmt in stmt_tree.depth_first():          # ordered as read
      if stmt.has_children(): continue           # only terminals bind
      (entry, captures, args) := dict.longest_prefix(stmt.path)
      match entry:
        None ->
            ledger[stmt.line] := Unmapped { prefix: longest_known_prefix(stmt.path) }
            continue
        Some(e) ->
            owner := resolve_owner(frag, e, captures)     # may create ancestors
            node  := frag.upsert(e.binds.kind, owner, key_from(captures))
            for (field, spec) in e.binds.fields:
                text  := captures[spec.from] or args[spec.index]
                value := Scalar::parse(text, platform)     # IR §4.2
                match value:
                  Ok(v)  -> frag.assert(node, field, Presence::Set(v),
                                        Origin::Parsed { capture, span, stanza, parser,
                                                         parser_version })
                  Err(e) -> ledger[stmt.line] := ValueUnparsed { field, err: e }
            for edge in e.binds.edges:
                frag.defer_edge(node, edge.kind, edge.target_expr)   # §7.3
            ledger[stmt.line] := Bound { node, fields: n }
  frag
```

Key points:

- **Only terminals bind.** Interior tree nodes exist because a deeper statement created
  them; they carry no assertion of their own. This is what makes
  `set security ike gateway GW-B address 203.0.113.10` and
  `set security ike gateway GW-B` (a bare stanza creation) behave correctly — the second
  creates the node with no fields, the first creates it with one.
- **`upsert` is within the fragment, not the graph.** Two statements about `GW-B` produce
  one fragment node. Matching onto the *existing* graph is stage 7 (§10), and keeping those
  separate is what lets the explain-only path (§1.1) run with no graph at all.
- **A scalar parse failure does not fail the line.** It produces a `ValueUnparsed` ledger
  outcome; other fields on the same statement still bind. `set security ike proposal IKE-P1
  dh-group group1444` gives you a node with an unknown `dh_group` and a named diagnostic,
  not a lost proposal.

### 7.2 Provenance construction

Every assertion carries `Origin::Parsed { capture, span, stanza, parser, parser_version }`
per IR §8.2, where:

- `span` is the terminal statement's span in **post-redaction capture coordinates**.
- `stanza` is the dictionary path with captures substituted —
  `security/ike/gateway/GW-B/external-interface` — which is what IR §8.5 and §10.4 use for
  scope computation.
- `parser_version` is the corpus version of the dictionary, not the binary version, so a
  corpus correction can invalidate a specific class of assertion.
- `confidence` is `Asserted` for everything bound from an explicit statement, and
  `Heuristic` for anything derived from noise (§4.4).

### 7.3 Deferred edge resolution

Junos references objects by name. The dictionary declares the *shape* of the reference; the
resolver runs after binding, when all named objects in the fragment exist.

```rust
pub enum TargetExpr {
    /// A named object of a kind, within the same Device.
    ByName { kind: NodeKind, name: CaptureRef },
    /// `st0.0` -> the LogicalUnit `0` of the InterfaceLike named `st0`.
    InterfaceUnit { token: CaptureRef },
    /// A zone-pair scope: two names.
    ZonePair { from: CaptureRef, to: CaptureRef },
    /// An external peer address that may not be modelled.
    PeerAddress { addr: CaptureRef },
}
```

Resolution outcomes:

| Outcome | Meaning | Action |
|---|---|---|
| Resolved in fragment | the target statement was in this paste | create the edge |
| Resolved in existing graph | fragment references a node the paste did not restate (common for `Fragment` scope) | create the edge onto the existing node, at stage 7 |
| Unresolved, capture is `Fragment` | the target is probably on the box, just not in this paste | create a **`Pending` edge**: recorded, not materialised, retried on every future ingest for this device. Never a finding |
| Unresolved, capture is `Whole` | the config genuinely references something undefined | create the edge to a `Broken` marker (IR §3.4) and raise a finding — this is the Batfish "referenced but undefined" class, obtained for free |
| Ambiguous | two candidates with the same name and kind | do not guess; residue entry plus a prompt (§10.4) |

The `Pending` edge is the one that matters for I1. If someone pastes only the
`security ike` stanza, `set security ipsec vpn VPN-B ike gateway GW-B` is not in the paste,
so `GW-B` has no inbound reference. That is not an error and must not look like one.

### 7.4 Capture scope, computed not declared

IR §10.5 defines `CaptureScope` as `Whole | Section([ConfigPath]) | Fragment` and IR §8.5
makes it the sole licence to assert `Absent`. Ingest computes it; the user never picks it.

```text
compute_scope(ledger, stmt_tree, noise) -> CaptureScope:
  if noise contains Pagination:                    return Fragment    # truncated
  if ledger.first_line is a partial statement:     return Fragment    # §8.6
  if the command echo is a whole-config show
     and no `| match`/`| find`/`| except` pipe:    return Whole
  covered := { the maximal config paths P such that every statement under P in the
               tree is contiguous in the input and P's parent has at least one
               sibling path also present }
  if covered is empty:                             return Fragment
  return Section(covered)
```

The `covered` computation is deliberately conservative. Its purpose is to answer: *did this
paste plausibly contain everything under `security/ike`?* The evidence is that the paste
contains multiple distinct sub-paths under `security/ike` and nothing interleaved from
elsewhere — the signature of `show configuration security ike | display set`. A paste
containing exactly one `security/ike/gateway/GW-B` statement is never closed-world over
anything.

**The consequence, stated because it is the whole point:** `ipsec.pfs.absent` — the field
card's own headline finding — can only fire when scope covers `security/ipsec/policy`. Paste
forty lines of Phase 1 and Fathom will not tell you PFS is missing, because it does not
know. It will tell you it does not know, as a completeness prompt. That is the correct
behaviour and it is the difference between this and a linter people mute.

---

## 8. Error recovery, residue and the line ledger

### 8.1 The damage taxonomy

Not hypothetical. This is what forty lines out of a 4,000-line config actually look like
when they arrive.

| Damage | Source | Stage that handles it |
|---|---|---|
| Truncated first line (`ecurity ike proposal ...`) | the user's selection started mid-line | 8.6 |
| Truncated last line | selection ended mid-line | 8.6 |
| Shell prompt above and below | copied the whole terminal | 4.4 |
| `---(more 24%)---` in the middle | pressed space through the pager | 4.4, and scope → `Fragment` |
| Backspace/ANSI runs where the pager erased itself | terminal emulator | 4.2 step 4 |
| Hard wrap at 80/132 columns, mid-token | narrow terminal | 4.3 |
| Backslash continuations | the user reformatted, or copied from a field card | 4.3 |
| `[edit security ike]` markers between blocks | copied from configuration mode | 4.4, 8.6 |
| Leading `+`/`-` | pasted a diff | 4.1 `NoiseClass::DiffMarker` |
| Leading `> ` | pasted from an email | 4.1 `NoiseClass::QuoteMarker` |
| Curly quotes, en-dashes, non-breaking spaces | came through Word or a PDF | 4.2 step 5 |
| `&quot;` / `&lt;` | copied from a rendered HTML page | 4.2 step 7 |
| Two devices in one paste | copied a whole session | 10.2 |
| Mixed platforms in one paste | comparing two boxes | 8.4 |
| A line the dictionary does not cover | Fathom does not model IDP | 8.3 `Unmapped` |
| A value the scalar parser rejects | typo, or a syntax we do not know | 7.1 `ValueUnparsed` |
| The user pre-redacted with `<REDACTED>` or `xxxxx` | conscientious operator | 9.6 |
| Windows-1252 bytes | PuTTY log through Notepad | 4.2 step 2 |
| Tabs and trailing whitespace | everywhere | 4.2 steps 6 |

### 8.2 The recovery principle

> **Recovery is not a fallback path. It is the main path with fewer outcomes.**

There is no "strict mode" and no error return from ingest. `ingest()` is total: for any byte
string it produces a report. The only refusals are §4.2 step 2 (undecodable) and §11.4 (over
the hard size cap), and both refuse *before* any processing rather than partway through.

### 8.3 The five outcomes

Every logical line ends in exactly one of these. This enum is the contract between the
parser and the rest of the product.

```rust
pub enum LineOutcome {
    /// Shaped, dictionary-matched, at least one assertion produced.
    Bound { node: FragNodeId, fields: u16, edges: u16 },

    /// Shaped into a well-formed statement whose path the dictionary
    /// does not cover. Fathom understands the *syntax* and not the *meaning*.
    Unmapped { known_prefix: PathPrefix, unknown_from: u8 },

    /// Lexed but did not form a statement: an unjoinable fragment, an
    /// ambiguous continuation, an unterminated quote, a mode we could not resolve.
    Unshaped { reason: ShapeError },

    /// The framer classified it as transport noise. Kept in the capture,
    /// not lexed, sometimes mined for evidence (§4.4).
    Noise { class: NoiseClass },

    /// The gate removed the text. Length recorded, content destroyed. §9.7.
    Quarantined { label: SecretLabel, orig_len: u32 },
}
```

The `Unmapped` / `Unshaped` distinction is what lets §12 say something useful about a line
we did not bind. `set security idp idp-policy Recommended` is `Unmapped` with
`known_prefix = security` and `unknown_from = 1`, so the explainer can honestly say *"this
is a `security idp` statement; Fathom does not model IDP."* `ecurity ike proposal IKE-P1` is
`Unshaped` and gets a different, equally honest treatment.

### 8.4 Mixed-platform pastes

A single paste can contain a Junos config and an IOS config — someone comparing two ends of
a tunnel. The framer runs platform detection per contiguous run of statement lines:

```text
detect_platform(run) -> (PlatformId, Confidence):
  scores := zeros over platforms
  for each line: score += platform_signature_weight(first two tokens)
  prompt evidence (§4.4)      -> +weight
  command echo evidence       -> +weight
  strongest, if it exceeds the runner-up by 2x and covers >= 4 lines -> Asserted
  otherwise                                                          -> Heuristic
```

Signature tokens are cheap and decisive: `set security zones` is Junos SRX;
`interface GigabitEthernet` is IOS; `set network ike gateway` is PAN-OS; `set rulebase` is
PAN-OS. A run that scores ambiguously is not guessed — the paste is split at the run
boundary and the user is asked, once, per run.

**Runs of different platforms become separate captures.** They may target different devices.
A capture is single-platform by definition (IR §8.4's `Capture.platform` is not an
`Option`), and this is where that is enforced.

### 8.5 Residue: what is preserved, and where

```rust
/// Lives in the workspace, in the capture section (IR §14.1), not in the graph.
pub struct Residue {
    pub capture: CaptureId,
    pub entries: Vec<ResidueEntry>,       // ordered by LineOrdinal
}
pub struct ResidueEntry {
    pub ordinal: LineOrdinal,
    pub span: ByteSpan,                   // into the redacted capture text
    pub outcome: LineOutcome,
    pub diag: SmallVec<[DiagId; 1]>,
    /// Set when a nearby bound statement gives the residue a home in the UI.
    pub near: Option<ElementId>,
}
```

**The residue is not a log. It is workspace content.** It survives save/load, it is
encrypted with everything else, it is diffable in git, and it renders in the device view
under a heading that is always present when non-empty:

```text
  not modelled

  44 lines from this device are preserved but not in the graph

  security idp                              22 lines
  class-of-service                          14 lines
  system syslog                              6 lines
  1 line Fathom could not read at all        → line 1
```

Three rules govern it:

1. **It is never auto-deleted.** A dictionary release that adds coverage will bind some of
   these on the next re-parse. Deleting them makes that impossible.
2. **It is re-bound, not re-parsed, on corpus upgrade.** When the dictionary version
   changes, `Unmapped` residue entries are re-run through stages 5–7 from the stored capture
   text. Stages 1–4 do not re-run — the capture is already framed and already redacted, and
   re-running the gate on already-gated text is a no-op that risks double-redaction bugs.
   This makes a dictionary release retroactively improve every workspace, which is a real
   product property and it exists only because the residue is preserved.
3. **It is never emitted.** See §12.5.

### 8.6 Recovering context for a fragment

The assignment's case: forty lines out of four thousand, with a truncated line at the top.

**Truncated head.** The first logical line does not begin with a verb and no wrap width was
detected. Three hypotheses, tried in order:

| Hypothesis | Test | Result |
|---|---|---|
| A `set` line whose verb was clipped | some suffix-completion of the first token is a verb, and the remainder shapes cleanly | recover the line, mark it `Confidence::Heuristic`, and record `Diag::RecoveredTruncatedHead` |
| A continuation of a line we never saw | the line shapes as a valid *path suffix* under some dictionary prefix | keep as `Unshaped { TruncatedHead }`; do **not** invent the prefix |
| Noise | matches a noise pattern | classify as noise |

The first hypothesis is safe because verbs are a closed 12-element set and the suffix match
must be unique. `ecurity ike proposal IKE-P1 ...` fails it — `ecurity` is not a verb suffix.
It shapes as a path suffix under `security`, so it lands in hypothesis two and stays
unshaped. That is correct: we do not know whether the missing prefix was `set` or
`deactivate`, and guessing `set` on a `deactivate` line inverts the meaning of the
statement. **A recovery that can invert meaning is not a recovery.**

**`[edit ...]` markers give us the prefix for free.** A paste from configuration mode looks
like:

```text
[edit security ike]
admin@srx-a-01# show | display set
set gateway GW-B address 203.0.113.10
```

Junos `display set` from within an edit context emits paths relative to that context. The
`[edit security ike]` marker is therefore not noise — it is a **path prefix declaration**,
and the framer pushes it onto a prefix stack that the shaper prepends. This is why
`NoiseClass::EditMarker` exists as its own variant. A paste with edit markers is fully
recoverable; the same paste with the markers stripped by a well-meaning user is not.

**Truncated tail.** The last logical line is unterminated (an open quote, an open brace, an
open block). Junos set-form: an unterminated quote makes the line `Unshaped`. Curly-brace:
unclosed braces at EOF close implicitly, and every statement under an implicitly-closed
brace is marked `Confidence::Heuristic` with `Diag::ImplicitBraceClose` — because we cannot
know the intended depth. IOS: the mode stack simply ends.

**No context at all.** A paste of bare statements with no verbs, no prompts, no markers —
someone quoting a config in a chat message. We attempt a **prefix search**: find the shortest
dictionary prefix under which every line in the run shapes cleanly and uniquely. If exactly
one exists, adopt it with `Diag::InferredPrefix` and `Confidence::Heuristic`. If zero or more
than one, the run is residue and the user is offered a "these lines are under: [ ]" control.
This is one of very few places the design asks the user a question, and it is asked because
the alternative is a wrong graph.

### 8.7 What the user is told

The ingest report is not a log dump. It is one screen in the card's grammar, and every
number on it is clickable to the lines behind it.

```text
────────────────────────────────────────────────────────────────────────
INGEST  ·  srx-a-01  ·  junos-srx  ·  display set  ·  fragment
────────────────────────────────────────────────────────────────────────
  READ-ONLY — SAFE ON PRODUCTION    CHANGES CONFIG — NEEDS A COMMIT
  DISRUPTIVE — DROPS LIVE TRAFFIC
────────────────────────────────────────────────────────────────────────

  40 lines in

  31  bound              → 9 nodes, 11 edges                      what was read
   3  understood, not modelled    security idp
   2  could not be read           lines 1, 27
   3  transport noise removed     prompt, pagination, wrapping
   1  value dropped before storage

▌ THIS PASTE IS TRUNCATED — A PAGER MARKER WAS FOUND AT LINE 14
▌ Fathom will not report anything as "absent" for this device from this
▌ paste. Re-paste with `| no-more` for complete coverage.

  line 1    ecurity ike proposal IKE-P1 authentication-method pre-shared-keys
            first line is clipped. Fathom will not guess whether the missing
            word was `set` or `deactivate` — those mean opposite things.
            → paste the line again, or click to set it manually

  line 27   set security ike proposal IKE-P1 dh-groupp group14
            no statement `dh-groupp` under `security ike proposal`.
            nearest known: `dh-group`  (1 character)
────────────────────────────────────────────────────────────────────────
```

The "nearest known" suggestion is a bounded Levenshtein search over the sibling segments of
the longest known prefix — a handful of candidates, distance ≤ 2, ranked, showing at most
one. It costs nothing because the trie already gives us the sibling set.

**Diagnostics are corpus content, not format strings.** Each `DiagId` resolves to a corpus
entry with the same three depths as everything else (§12), the same voice lint gates, and
the same `reviewed_by` requirement. "First line is clipped and Fathom will not guess" is
authored prose, not a `format!`.

---

## 9. Redaction — the gate

### 9.1 Position, and why it is not negotiable

Invariant 3: *the application never accepts a credential.* The paste path is the only place
a credential can enter, so the gate is where invariant 3 is either true or a slogan.

```text
paste event
   │
   ├─ 1 FRAME ─ 2 LEX ─ 3 SHAPE     in-memory only, nothing stored
   │
   ├─ 4 REDACT  ══════════════════  THE GATE
   │
   ├─ 5 BIND ─ 6 RESOLVE ─ 7 RECONCILE
   │
   ├─ capture store        ← only redacted text ever arrives here
   ├─ graph                ← only SecretPlaceholder ever arrives here
   ├─ provenance / history ← spans into redacted text only
   ├─ encryptor → workspace document
   └─ sync → server
```

Four structural properties, each enforced by something other than discipline:

| Property | Enforced by |
|---|---|
| The graph cannot hold a secret | `SecretPlaceholder` has no constructor from arbitrary text and no `Deserialize` from a string (IR §4.5) |
| The capture store cannot hold an unredacted capture | `CaptureStore::insert` takes a `RedactedCapture`, a newtype only the gate can construct |
| Nothing between the gate and storage can reintroduce one | stages 5–7 read only from the `RedactedCapture` and the `StmtTree`, whose `Arg::Redacted` variant carries no text |
| A new secret-bearing statement cannot ship without a redaction | §6.5's secret-coupling gate: the set of `secret:` dictionary entries *is* the redaction path catalogue, so they cannot diverge |

That last one is IR §8.4's requirement made structural rather than a CI comparison of two
lists: **there are not two lists.** The dictionary entry that teaches the parser about
`pre-shared-key ascii-text` is the same entry that teaches the gate to redact it. You cannot
add one without the other because they are one line of YAML.

### 9.2 Three detectors

| Detector | Runs on | Precision | Recall | Role |
|---|---|---|---|---|
| **Path** | statements whose path matches a `secret:` dictionary entry | exact | only known statements | the workhorse |
| **Value shape** | every argument of every statement, bound or not | high for structured encodings, deliberately lossy otherwise | catches unknown paths | the safety net |
| **Block** | opaque blocks from §4.5 | exact | PEM, certificate chains, key blobs | whole-region |

All three run. A value caught by two detectors is redacted once and the manifest records
both reasons.

### 9.3 The path catalogue, per platform

Derived from the `secret:` flag on dictionary entries. Reproduced here as a table because
the assignment asks for it, but the table is *generated from the dictionary*, not maintained
separately.

**junos-srx**

| Statement path | Label |
|---|---|
| `security ike policy $p pre-shared-key ascii-text $v` | `Psk` |
| `security ike policy $p pre-shared-key hexadecimal $v` | `Psk` |
| `security ipsec vpn $v manual authentication key ascii-text $k` | `Psk` |
| `security ipsec vpn $v manual encryption key ascii-text $k` | `Psk` |
| `system root-authentication encrypted-password $v` | `Password` |
| `system root-authentication plain-text-password ...` | `Password` |
| `system login user $u authentication encrypted-password $v` | `Password` |
| `system login user $u authentication plain-text-password ...` | `Password` |
| `system login user $u authentication ssh-rsa $key` | `PublicKey` — see note |
| `snmp community $name` | `SnmpCommunity` — **the name is the secret** |
| `snmp trap-group $g ...` community references | `SnmpCommunity` |
| `system tacplus-server $ip secret $v` | `TacacsKey` |
| `system radius-server $ip secret $v` | `RadiusKey` |
| `protocols bgp group $g neighbor $n authentication-key $v` | `RoutingKey` |
| `protocols ospf area $a interface $i authentication md5 $id key $v` | `RoutingKey` |
| `security certificates local $name $pem` | `CertKey` |
| `system license keys key $v` | `LicenseKey` |

**ios / ios-xe**

| Statement | Label |
|---|---|
| `enable secret [level N] <type> $v` / `enable password ...` | `Password` |
| `username $u {password\|secret} <type> $v` | `Password` |
| `crypto isakmp key $key address $peer` | `Psk` |
| `crypto isakmp key $key hostname $h` | `Psk` |
| `snmp-server community $c ...` | `SnmpCommunity` |
| `snmp-server host $ip [traps] $c` | `SnmpCommunity` |
| `tacacs-server key <type> $v` / `tacacs server $n` → `key <type> $v` | `TacacsKey` |
| `radius-server key <type> $v` / `radius server $n` → `key <type> $v` | `RadiusKey` |
| `key chain $c` → `key $n` → `key-string <type> $v` | `RoutingKey` |
| `neighbor $ip password <type> $v` | `RoutingKey` |
| `ip ospf message-digest-key $id md5 <type> $v` | `RoutingKey` |
| `ppp {chap\|pap} password <type> $v` | `Password` |
| `ip ftp password <type> $v` | `Password` |
| `crypto pki certificate chain $n` (block) | `CertKey` |

**panos**

| Statement | Label |
|---|---|
| `network ike gateway $g authentication pre-shared-key key $v` | `Psk` |
| `mgt-config users $u phash $v` | `Password` |
| `shared certificate $n ...` (PEM) | `CertKey` |
| `deviceconfig system snmp-setting ... snmp-community-string $v` | `SnmpCommunity` |
| `shared server-profile {tacplus\|radius} $p server $s secret $v` | `TacacsKey` / `RadiusKey` |

<!-- VERIFY: every panos path above except `network ike gateway ... pre-shared-key key`,
     which is confirmed by Palo Alto documentation and Cloudflare's PAN-OS integration
     guide. The SNMP, mgt-config and server-profile paths are written from general
     familiarity and must be confirmed against a real PAN-OS config export before the
     catalogue ships. An unverified path in this table is a credential that reaches the
     store. -->

**The SSH public-key row is deliberate and arguable.** A public key is not a secret. It is
also a stable, high-value identifier that ties a workspace to a named individual, and
invariant 3's spirit — do not hold things whose loss hurts — covers it. It is redacted with
label `PublicKey` and the manifest says why, so a user who disagrees can see exactly what was
dropped. Registered as an open decision (§16).

### 9.4 Value-shape detectors — the safety net

These run on **every** argument, including arguments of statements the dictionary has never
heard of. This is what protects against a secret-bearing statement we have not catalogued —
which is the realistic case, since no dictionary is complete.

| Detector | Pattern | Label | Notes |
|---|---|---|---|
| Crypt-family prefix | value matches `^\$[0-9a-z]{1,2}\$` | by platform, see below | `$1$` md5crypt, `$5$` sha256crypt, `$6$` sha512crypt, `$8$`, `$9$` |
| PEM armour | `-----BEGIN [A-Z ]+-----` | `CertKey` | Whole block via §4.5 |
| Long hex | `^[0-9a-fA-F]{32,}$` in an argument position | `UnknownSecret` | 32 hex chars is 128 bits |
| Base64-ish | `^[A-Za-z0-9+/]{24,}={0,2}$` and not a known non-secret scalar | `UnknownSecret` | Guarded, see below |
| Leaf-name | the *last literal path segment before the argument* is in the secret-word list | `UnknownSecret` | The strongest generic signal |

**The secret-word list** (last literal segment, case-folded, hyphens and underscores
equal): `key`, `keys`, `key-string`, `secret`, `shared-secret`, `password`, `passwd`,
`plain-text-password`, `encrypted-password`, `psk`, `pre-shared-key`, `passphrase`,
`community`, `snmp-community-string`, `authentication-key`, `auth-key`, `md5`, `hmac`,
`credential`, `token`, `bearer`, `phash`, `passhash`, `private-key`.

**`$9$` means two different things and both get redacted.** On Junos, `$9$` is a reversible
obfuscation — Junos needs the plaintext back for things like IPsec keys and BGP MD5, and it
can be reversed from the box's own CLI with `request system decrypt password`. On IOS,
`$9$` is scrypt and is a real one-way hash. The gate redacts both; the *label* differs by
platform (`Psk`/`Password` reversible on junos, `PasswordHash` on ios), because the
explanation the user gets differs:

```text
▌ dropped: line 51 · junos-srx $9$ value
▌ Junos $9$ is obfuscation, not encryption. It reverses to the plaintext key
▌ with one command on the box. Fathom treats it as the secret it is.
```

Cisco type 7 (`password 7 05080F1C2243`) is Vigenère and equally reversible; the same
treatment and the same explanation.

Sources: [Juniper `request system decrypt password`](https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/command/request-security-decryp-password.html),
[Cisco: Understand IOS Password Encryption](https://www.cisco.com/c/en/us/support/docs/security-vpn/remote-authentication-dial-user-service-radius/107614-64.html).

**Why not entropy.** Shannon entropy over a short token is the obvious detector and it is
bad here in both directions. `VPN-DC-EAST-2026-Q3-PRIMARY` is a high-entropy object name we
must keep, and `Password123` is a low-entropy PSK we must drop. The signal that actually
correlates with secrecy in config text is *position and naming*, not randomness — which is
why the leaf-name detector is the strongest of the five and entropy is not in the list.

**The base64 guard.** Base64-shaped values collide with legitimate content: certificate
fingerprints we want to keep, long descriptions, PAN App-IDs. The base64 detector fires only
when the argument is **not** parseable as any scalar the dictionary expects at that position
**and** the statement is `Unmapped` (so we have no better information) **and** the value is
≥ 24 characters. Under those three conditions the false-positive cost is dropping part of an
unmodelled line, and the manifest names it, so the user can see it.

### 9.5 Span-preserving replacement, and a correction to IR §8.4

IR §8.4 specifies replacement *"by `<REDACTED:psk>` of the same span length, so all other
offsets are preserved."* Same-length padding cannot be done honestly:

- If the secret is shorter than the marker, the marker must be truncated, and
  `<REDACTED:p` tells the user nothing.
- If it is longer, the marker must be padded, which **encodes the secret's length in the
  stored artefact**. An 8-character PSK and a 63-character PSK are very different
  brute-force propositions and that difference should not survive into the ciphertext.

> **Proposed change to IR §8.4 — replace with a fixed-length marker and record the mapping.**

```rust
pub struct RedactionMap {
    /// Ordered by orig.start, non-overlapping. Original coordinates never leave the gate.
    entries: Vec<RedactionEntry>,
}
pub struct RedactionEntry {
    orig: ByteSpan,          // in the pre-redaction buffer — destroyed with it
    new:  ByteSpan,          // in the stored capture text
    label: SecretLabel,
    detector: DetectorId,
    orig_len: u32,           // kept ONLY in the in-memory manifest, never persisted
}
```

The offset problem IR §8.4 was solving does not exist under the pipeline in §2, because
**the gate runs before anything records a span.** Stages 5–7 read the already-rewritten
buffer; there is no pre-redaction coordinate anywhere downstream. The gate rewrites the
buffer and the ledger's spans in one pass, `O(n)` with one output allocation.

`orig_len` exists so the ingest report can say *"a 63-character value was dropped"* in the
session where it happened, which is useful for a user checking they pasted the right thing.
It is in the in-memory manifest only and is not part of `RedactedCapture`.

### 9.6 The user's own redactions

Conscientious operators pre-redact: `pre-shared-key ascii-text "xxxxxxxx"`,
`"<REDACTED>"`, `"********"`. The gate must not treat these as real values and must not
report them as drops, or the report cries wolf.

Detected as: the value consists of ≤ 2 distinct characters, or matches
`^<[A-Za-z_ -]+>$`, or equals a known placeholder from our own emitter (`<PSK>`,
`<SNMP-COMMUNITY>`). Such a value binds to `SecretPlaceholder` exactly as a real one would,
is not counted as a drop, and produces a quiet manifest line: `line 51 · already redacted by
you · no value was present`.

### 9.7 The hard case: a secret in a line we did not understand

An `Unshaped` line has no statement structure, so the path detector cannot run and the
argument detectors have no arguments. It may still contain a credential — in fact a
truncated or mangled `pre-shared-key` line is *more* likely to be unshaped than a clean one.

> **DECISION — `Unshaped` lines are run through the value-shape detectors at token
> granularity, at maximum aggression. A line that trips any detector is `Quarantined`: its
> text is destroyed and replaced by a shape sketch.**

The sketch is a lossy structural summary that keeps enough for the user to identify the line
and keeps nothing that could be the secret:

```text
line 27  QUARANTINED  ·  a value on this line looked like a credential
         shape: <word> <word> <word:5> <quoted:26> 
         first two tokens: "set security"
```

Rules for the sketch: the first two tokens are kept verbatim **only if** neither trips a
detector and both are in the dictionary's known segment set; all other tokens become
`<kind:length>`; no character of any token beyond the second survives.

**This drops legitimate content.** An unshaped line containing a long hex interface
description is quarantined and the description is gone. That is a real cost and it is the
correct direction of error: an over-aggressive gate loses a description, an
under-aggressive one stores a PSK. The manifest names every quarantine so the loss is
visible, and the user can re-paste the line in isolation to see it bind.

### 9.8 What the UI tells the user

Two surfaces. The first is the ingest report, at the moment of paste:

```text
▌ DROPPED BEFORE STORAGE — NOT RECOVERABLE FROM THIS WORKSPACE
▌
▌ line 51   set security ike policy IKE-POL pre-shared-key ascii-text …
▌           pre-shared key · matched `security ike policy $p pre-shared-key
▌           ascii-text $v` · 26 characters
▌
▌ line 27   quarantined · a value looked like a credential · 26 characters
▌
▌ Fathom will emit  pre-shared-key ascii-text "<PSK>"  and you paste the real
▌ value into the box. Nothing above is in this workspace.
▌
▌ YOUR CLIPBOARD STILL HOLDS ALL OF IT. CLEAR IT.
```

Rules for this surface:

- **The dropped value is never displayed, not even masked, not even on hover.** Rendering it
  to confirm the drop puts it in the DOM, which is the thing we are trying to avoid.
- The statement is shown up to and including the key token, then `…`.
- The final imperative is the field card's device: a disclaimer that is also the most useful
  sentence on the page. It is the only honest thing to say (§9.9) and it is in caps for the
  same reason `BOTH ENDS MUST AGREE — EVERY VALUE, EXACTLY` is.

The second surface is permanent: every `SecretPlaceholder` in the graph renders with a
margin tab `dropped on ingest 2026-07-28`, and the device view carries a persistent count.
A workspace should be able to answer "what did this tool refuse to keep" months later.

### 9.9 What is client-side redaction actually protecting against?

The honest answer, because the question is fair and the marketing answer is wrong.

**Start with what it does not do.** The plaintext PSK is in the page's memory. It arrived in
a `paste` event's `DataTransfer`, it was a JS string, it was copied into WASM linear memory,
and it is now in a Rust `String`. During that window:

- A compromised browser reads it. The owner's §7.1 already lists "compromised browser" as
  explicitly out of scope, and this does not change that.
- A malicious extension with host permissions reads it — extensions see the DOM and can
  hook the paste event.
- A devtools breakpoint reads it.
- The JS string that fed WASM **cannot be zeroed**: JS strings are immutable and collected
  whenever the runtime feels like it. Rust can `zeroize` its own buffer; it cannot reach
  back through the FFI boundary.
- The OS may have paged it. The browser may have it in a crash dump.
- The clipboard still has it, and will until the user copies something else. The clipboard is
  read by every application the user runs.
- The user already had it. They typed it into a terminal five minutes ago.

Given all that, redaction is **not a confidentiality control**. Saying otherwise would be the
kind of claim §2.4 of the brief says the market has been trained to distrust.

**What it is: a retention control.** It changes the secret's lifetime from *indefinite* to
*the duration of one ingest*, and lifetime is what determines almost every real leak.

| Without the gate, the PSK ends up in | With the gate |
|---|---|
| The workspace document, encrypted, on disk, forever | never written |
| Every git commit of that workspace, forever, recoverable from history even after a later fix | never committed |
| The sync server's ciphertext — and zero-knowledge protects it only as long as the passphrase holds. A leaked passphrase yields credentials, not just topology | server holds no credential to yield |
| Field history (IR §8.6), which retains superseded values by design — so *rotating* the PSK in Fathom would keep the old one | there is nothing to retain |
| Every export, every change ticket paste, every screen share, every workspace emailed to a colleague | nothing to export |
| Backups, USB sticks, the laptop that gets stolen (brief §7.1 row 4) | nothing to find |
| A support bundle | nothing to include |

Those rows are where credentials actually leak. Not from a compromised browser during the
three seconds of a paste — from a file that outlived the reason it existed. Redaction
addresses precisely the failure mode that dominates, and does not address the one that is
already documented as out of scope.

**Second thing it buys: an auditable structural answer.** "Does this tool store
credentials?" is the question that decides whether Fathom is allowed into a regulated
network. The answer is not "we have a policy" — it is *"the type that holds a pre-shared key
has no constructor that takes text; here is the type; here is the CI gate that proves the
parser and the redactor cannot diverge."* That is checkable by a reviewer in an afternoon.
Per §2.4, that is the whole commercial thesis.

**Third: it protects the user from themselves.** The alternative to accepting a paste is
telling the user to redact by hand. They will open Notepad, delete the PSK line, miss the
SNMP community and the TACACS key, and paste. Refusing the paste does not produce a redacted
paste; it produces a *partly* redacted paste with the same trust properties and worse
coverage.

> **DECISION — accept the paste and gate it, rather than refuse it and push redaction onto
> the user.** The user's manual redaction is worse than ours and they will do it wrong in
> the direction that matters.

**Cheap mitigations for the exposure window, all of them worth doing, none of them
sufficient:**

| Mitigation | What it buys | Honest limit |
|---|---|---|
| Run the gate in the same task as the paste event, before any `await` | no chance for a yield to interleave a serialisation | does nothing about a browser already compromised |
| Never bind the raw paste to component state; process it in the handler and store only the redacted capture | the raw text never enters the framework's retained tree, its dev tools, or its time-travel debugger | the textarea still held it |
| Clear the textarea and `value = ''` immediately | shortens DOM residency | the string is still on the JS heap until GC |
| Run ingest in a dedicated Worker with its own WASM instance and **terminate it after ingest** | the entire linear memory that held the plaintext is destroyed at the OS level, not merely marked free — and WASM memory cannot shrink (§11.5), so this is worth doing for memory reasons anyway | the main thread's copy still existed |
| `zeroize` the WASM-side buffer before returning | best-effort overwrite of one copy | LLVM may elide it; `zeroize` is designed to resist that but WASM's guarantees are weaker than a native target's |
| Tell the user to clear their clipboard | the largest remaining exposure, and the only one the user can fix | requires them to act |

The Worker-termination row is the one that does real work, and it is the reason §11.5's
memory design and this section's security design converge on the same architecture. That is
a good sign about both.

**What we must never say:** that pasting a config into Fathom is safe. What we say is what
is true and what the field card would say:

```text
FATHOM DOES NOT KEEP YOUR KEYS. IT STILL SEES THEM FOR AS LONG AS THE PASTE TAKES.
```

### 9.10 Threat model rows, extending brief §7.1

| Threat | In scope? | Mitigation / why not |
|---|---|---|
| Credential persisted to workspace | yes | The gate. Structural, §9.1 |
| Credential synced to server | yes | Nothing to sync |
| Credential in git history after a "fix" | yes | Never written, so never in history |
| Credential in an export or change ticket | yes | Nothing to export |
| Credential retained in field history after rotation | yes | `SecretPlaceholder` has no value to retain |
| Credential in the clipboard | **no** | Outside the application. Named in the UI |
| Credential in browser memory during ingest | **no** | Cannot be mitigated in a browser. Same class as brief §7.1's "compromised browser" row |
| Credential in a browser crash dump or swap | **no** | Same |
| Redaction bypassed by an uncatalogued statement | **partly** | Value-shape detectors (§9.4) plus quarantine (§9.7). Recall is not 1.0 and we say so |
| Redaction regression from a dictionary change | yes | §6.5's secret-coupling gate; §13.3's canary corpus |

### 9.11 Proving it in CI

Two gates, both blocking.

1. **The canary corpus.** A generated corpus of configs across all four platforms in which
   every secret-bearing position holds a distinctive canary string (`FATHOMCANARY` plus a
   position-derived suffix). The test ingests each, serialises the entire resulting
   workspace — graph, provenance, history, captures, residue, settings, every section —
   and asserts the canary appears nowhere in the ciphertext's plaintext input. Not "check
   the capture"; check the whole serialised artefact, because the point is to catch the path
   nobody thought of.
2. **Coupling.** §6.5: the set of `secret:` dictionary entries is the redaction catalogue by
   construction. The gate additionally asserts that every entry whose *last literal path
   segment* is in the §9.4 secret-word list carries a `secret:` flag — so adding
   `... authentication-key $v` to the dictionary without the flag fails the build with a
   message naming the entry.

Gate 2 is the one that catches the realistic regression: someone extends the dictionary at
23:00 to cover a stanza and does not think about redaction. The build thinks about it.

---

## 10. Identity resolution on re-parse

IR §10.4 specifies the matching algorithm, IR §10.5 specifies absence handling, and rule
engine §11.4 specifies suppression rebinding. This section specifies the parts that belong
to ingest: choosing the device, computing scope, handling ambiguity, and the plan.

### 10.1 The device question comes first

Every other match depends on it, because identity tuples are scoped by `owner(Device)`.

```text
identify_device(capture, graph) -> DeviceMatch:
  evidence := []
  if a `set system host-name X` (junos) / `hostname X` (ios) /
     `set deviceconfig system hostname X` (panos) statement is present:
        evidence += Hostname(X, Asserted)
  if a `set groups nodeN system host-name X` statement is present:
        evidence += ClusterMemberHostname(X, N, Asserted)     # §10.2
  for each prompt in noise:      evidence += Hostname(prompt.host, Heuristic)
  if a serial / chassis-id statement is present: evidence += Serial(.., Asserted)
  if the user opened ingest from a device view:  evidence += UiContext(device, Asserted)

  candidates := graph.devices matching any Asserted evidence
  match candidates.len():
     1 -> Matched(candidate)
     0 -> if evidence has any Asserted -> NewDevice(named from it)
          else                          -> AskUser
     _ -> AskUser(with the evidence shown)
```

`UiContext` outranks everything **except** a conflicting `Asserted` hostname. Pasting
`srx-b-01`'s config while looking at `srx-a-01` is a common and expensive mistake, and the
right response is a prompt, not a silent merge:

```text
▌ THIS CONFIG SAYS `srx-b-01`. YOU ARE LOOKING AT `srx-a-01`.
▌ [ it belongs to srx-b-01 ]   [ it belongs to srx-a-01, the hostname is stale ]
▌ [ cancel ]
```

### 10.2 One config, two chassis; one paste, two devices

Two cases that look alike and are not.

**A chassis cluster is one `Device`** (IR §6.3): two chassis, one configuration. A paste
containing `{primary:node0}` banners, `set groups node0 system host-name srx-a-node0` and
`set groups node1 system host-name srx-a-node1` is **one** device with two `Chassis` nodes.
The two hostnames are per-node group values, not two devices, and treating them as two
devices produces a duplicated estate that is painful to unwind.

Detection: the presence of `set chassis cluster ...` statements, or of `node0`/`node1`
groups, or of a cluster banner. Any one of them makes per-node hostnames non-splitting
evidence.

**Two devices in one paste** is a different signature: two command echoes, or two prompts
with different hostnames *and no cluster evidence*, or two `set system host-name`
statements outside a `groups` path. The framer splits at the boundary into two captures and
runs stages 4–7 twice.

When both signatures are present, or neither resolves, we ask. We do not split a config in
half on a guess.

### 10.3 The reconciliation plan

```rust
pub struct ReconciliationPlan {
    pub capture: CaptureId,
    pub device: DeviceMatch,
    pub scope: CaptureScope,               // §7.4
    pub matched:  Vec<(FragNodeId, NodeId, MatchTier)>,
    pub renamed:  Vec<RenameCandidate>,    // matched at tier > 1
    pub created:  Vec<FragNodeId>,
    pub absent:   Vec<(NodeId, AbsentDisposition)>,   // IR §10.5
    pub ambiguous: Vec<Ambiguity>,
    pub value_changes: Vec<ValueChange>,
    pub conflicts: Vec<FieldRef>,          // would become Field::Conflicted
    pub residue: ResidueSummary,
    pub drops: DropManifest,
}

pub enum MatchTier { Tier1Name, Tier2Structural, Tier3Endpoint, Similarity(f32) }

pub struct Ambiguity {
    pub frag: FragNodeId,
    pub candidates: SmallVec<[NodeId; 2]>,   // ordered by NodeId for determinism (I5)
    pub discriminator: Option<FieldKey>,     // the field that would resolve it
}
```

> **DECISION — a plan is auto-applied only when it is purely additive.** Specifically: no
> `renamed`, no `absent` with a non-`Nothing` disposition, no `ambiguous`, no `conflicts`,
> and no `value_changes` on fields whose current provenance is `Origin::Hand`. Everything
> else is presented as a diff and applied on confirmation.

The carve-out for hand-entered values is the important one: a re-parse silently overwriting
what an engineer typed is how a tool loses trust in one incident. IR §8.6's precedence
already ranks `Hand` above `Parsed`, so the *value* would survive — but the plan should
still surface it, because "the box disagrees with what you entered" is exactly the
divergence signal §10.5 of the IR calls out as free compliance-diffing.

### 10.4 Ambiguity

Ambiguity is resolved by refusing to resolve it. Three cases:

| Case | Example | Action |
|---|---|---|
| Two existing nodes match one fragment node at the same tier | two `IkeGateway`s named `GW-B` (possible across routing instances) | leave unmatched; `Ambiguity` entry naming the discriminating field; user picks |
| One existing node matches two fragment nodes | the paste defines `GW-B` twice (a diff pasted with both sides) | second occurrence is `Unshaped { DuplicateStatement }` and the plan shows both |
| Similarity pass declines (IR §10.4 step 4, best < 0.75 or margin < 0.15) | a gateway renamed *and* readdressed | present both, ask "is this the same gateway?", show the field-by-field diff |

**The discriminator field is what makes the prompt answerable.** "Which `GW-B` did you
mean?" is a bad question. "These two differ only in `external-interface`: `reth0.0` and
`reth1.0`" is a question an engineer answers in one second. Computing it is cheap: the first
field on which the candidates differ, in schema declaration order.

### 10.5 What can still go wrong

| Failure | Why it survives the design | What we do |
|---|---|---|
| Two devices genuinely named the same | IR §10.4 buckets by `owner(Device)`, so the ambiguity moves up to the device level, where §10.1 asks | Ask, and offer serial as the discriminator |
| A config pasted from a template with placeholder hostnames | every device matches nothing, or all match one | The plan shows `creates: 1 device` and the user sees it before it happens |
| A device re-imaged with the same hostname and a completely different config | tier 1 matches everything by name; the values all change | Not detectable, and arguably correct — the plan shows a large `value_changes` list, which is the signal |
| Paste of the *intended* config over a device modelled from the *running* config | indistinguishable from a re-parse of the running config | This is a real gap. `Capture` has no "this is intent, not observation" flag. Registered in §16 |

---

## 11. Scale: parse-time and memory budgets

### 11.1 What "a full SRX cluster config" is

I do not have a measured figure and will not invent one. What I can do is set budgets by
input size and state where the tiers come from.

| Tier | Logical lines | Where it comes from |
|---|---|---|
| Fragment | ≤ 200 | The §6.3 paste case: a stanza, a walkthrough verification, a chat quote |
| Small device | ~1,000–4,000 | IR §14.2 assumes ~4,000 lines for a mid-size firewall |
| Large device / cluster | 10,000–60,000 | A cluster with several hundred policies, address books and applications. Policies dominate: each policy is 3–6 `set` lines |
| Refuse | > 250,000 lines or > 32 MB | §11.4 |

<!-- VERIFY: measure `show configuration | display set | count` on a real SRX cluster with
     a large policy base. Every tier boundary above is a design assumption. The 60,000 upper
     figure is an estimate from policy arithmetic, not an observation. -->

### 11.2 Time budget

Per-stage targets for the **large device** tier (20,000 lines, ~1.4 MB), P95, in WASM:

| Stage | Budget | Work, and why the number is plausible |
|---|---|---|
| 1 Frame | 25 ms | Two byte passes (normalise, classify) plus a histogram. A scalar byte loop at a conservative 100 MB/s in WASM does 1.4 MB in 14 ms |
| 2 Lex | 20 ms | One pass, ~200,000 tokens, span arithmetic only |
| 3 Shape | 25 ms | Arena appends plus segment interning; interning is a hash per segment, ~200,000 hashes |
| 4 Redact | 20 ms | One pass of the detectors over ~200,000 arguments; the path detector is a flag read on an already-matched entry |
| 5 Bind | 60 ms | ~200,000 trie steps (≤ 8 probes each) plus ~20,000 scalar parses plus ~20,000 provenance records |
| 6 Resolve | 20 ms | Hash joins over the fragment |
| 7 Reconcile | 80 ms | IR §10.4: `O(n + f·4096·|kinds|)`, dominated by the tier-1 hash joins |
| **Total** | **250 ms** | |

For the small-device tier that is ~50 ms; for a fragment it is under 5 ms and can run on the
main thread inside the paste handler.

<!-- VERIFY: every figure in this table is arithmetic over assumed per-operation costs, not
     a measurement. The 100 MB/s scalar-scan assumption for WASM is deliberately
     conservative and should be replaced with a measured number on the reference machine
     named in the perf doc, alongside the rule engine's §7.1 table. -->

**Thresholds and behaviour:**

| Condition | Behaviour |
|---|---|
| < 300 ms estimated (from byte count) | main thread, synchronous, inside the paste handler — which is also what §9.9 wants for the gate |
| ≥ 300 ms estimated | dedicated Worker, progress by stage, cancellable |
| Exceeds 4× budget at any stage | the stage completes; a `Diag::SlowStage` is recorded with the input characteristics. We do not abort work the user is waiting for to report that it was slow |

### 11.3 Memory budget

Peak transient, for the 20,000-line tier, as arithmetic over the declared shapes:

| Structure | Bytes | Made of |
|---|---|---|
| Raw paste (JS→WASM copy) | 1.4 M | input |
| Normalised buffer | 1.4 M | step 4.2 output; the raw copy is dropped after |
| Redacted capture text | 1.4 M | the only one that survives ingest |
| `LineLedger` | 0.5 M | 20,000 × ~24 B |
| Token arena | 2.4 M | 200,000 × 12 B (span + kind) |
| `StmtTree` arena | 4.8 M | ~150,000 nodes × 32 B, plus child/arg side-vecs |
| Segment interner | 0.6 M | ~15,000 distinct segments |
| IR fragment | 5.5 M | IR §14.2 gives ≈1.1 MB per 4,000-line device including provenance |
| Reconciliation indexes | 1.0 M | tier hash maps |
| **Peak** | **≈ 19 MB** | ≈ **13× the input text** |

Rule of thumb to carry into the implementation: **peak transient memory is ~13× the size of
the pasted text**, of which ~1× survives. A 32 MB paste therefore peaks around 420 MB, which
is why 32 MB is the refusal threshold (§11.4) and not higher.

### 11.4 Past the budget

| Input | Behaviour |
|---|---|
| ≤ 32 MB / ≤ 250,000 lines | ingest normally, in a Worker above the threshold |
| > 32 MB or > 250,000 lines | **refuse before processing**, with a message that offers the actual fix |

```text
▌ THIS PASTE IS 61 MB. FATHOM WILL NOT INGEST IT IN ONE PIECE.
▌ That is usually a whole-fleet config bundle rather than one device.
▌ Paste one device at a time, or use the CLI:  fathom ingest --split bundle.txt
```

The refusal is deliberate rather than a best-effort attempt that OOMs the tab. A browser tab
that dies takes the workspace's unsaved state with it, and there is no undo across an
encrypted-document save (IR §10.5's reasoning).

**Streaming.** Stages 1–4 are per-logical-line and stream naturally. Stage 5 needs a bounded
containment stack and also streams. Stages 6–7 need the whole fragment. So the pipeline is
**one streaming pass and one whole-fragment pass**, and the streaming pass can process a
64 KB window at a time. That halves peak memory for large inputs (the token and stmt arenas
become windowed) at the cost of complexity, and is therefore **not built for v1** — the
32 MB cap makes it unnecessary. It is the designed escape hatch if the cap turns out to be
too low, and the stage boundaries in §2 are drawn so that it is a change to stages 1–5's
driver and to nothing else.

### 11.5 The WASM memory problem

WebAssembly linear memory **grows and never shrinks**. `memory.grow` has no inverse; the
`memory.discard` instruction that would provide one is in the memory-control proposal and
is not something to depend on today.

The consequence: a single 20 MB ingest peak permanently inflates the tab's WASM heap for the
lifetime of the page. Ten large pastes in a session do not compound (the allocator reuses
the space) but the high-water mark never comes back.

> **DECISION — ingest runs in a dedicated Worker with its own WASM instance, and the Worker
> is terminated after each ingest above the fragment tier.**

Terminating the Worker returns the linear memory to the OS. It also, as §9.9 notes, destroys
the only copy of the plaintext paste that we control. One decision, two problems, and the
fact that the security argument and the memory argument point the same way is the strongest
evidence that it is the right shape.

Costs: Worker startup (instantiate the module, load the compiled dictionary) on every large
ingest — a fixed tens-of-milliseconds tax, mitigated by module caching, and it is off the
frame path anyway. And the graph delta must cross a `postMessage` boundary, which means it
must be serialisable — which it already is (IR §14.1's CBOR).

Source: [WebAssembly memory-control proposal, `discard`](https://github.com/WebAssembly/memory-control/blob/main/proposals/memory-control/discard.md).

### 11.6 Bounded depth

User-controlled nesting depth is a stack-overflow vector, and a stack overflow in WASM is a
trap that kills the instance.

- The curly-brace shaper, the XML shaper and the IOS mode stack are **iterative with an
  explicit stack**, never recursive.
- Depth is capped at **64**. A config nested deeper than 64 levels does not exist; a
  fuzz input nested 100,000 deep does. Exceeding the cap ends the block as
  `Unshaped { DepthExceeded }` and continues.
- The trie walker's 64-visit budget (§6.3) is the same idea at a different layer.
- `#![forbid(unsafe_code)]` and `#![deny(clippy::unwrap_used, clippy::panic)]` in the ingest
  crate. §13.5.

---

## 12. Reverse explanation

### 12.1 What it is

§6.3: *"paste an inherited configuration, get an annotated walkthrough."* The claim that it
is *"nearly free once parsers and explainers exist"* is true only if binding carries
explainer references, which is why §6.2's dictionary schema makes `explain` a required
field.

Reverse explanation is a pure function:

```text
annotate(capture, ledger, fragment, graph, corpus_version, depth) -> [Annotation]
```

Deterministic, per invariant 9. No model at runtime, per §6.1 of the brief. The AI layer may
*suggest* corpus entries at authoring time; it does not participate here.

### 12.2 The annotation

```rust
pub struct Annotation {
    pub line: LineOrdinal,
    pub span: ByteSpan,
    pub class: AnnotationClass,
    pub subject: Option<ElementRef>,       // the node/field/edge the line produced
    /// Ordered most-specific first: field explainer, then kind, then domain.
    pub explainers: SmallVec<[ExplainerId; 3]>,
    pub risk: Risk,                        // ReadOnly | ChangesConfig | Disruptive
    pub findings: SmallVec<[FindingId; 1]>,
    pub chain: Option<ChainRole>,          // §12.4
    pub related: SmallVec<[CommandId; 2]>, // the verify command for this line
}

pub enum AnnotationClass {
    Bound,          // we know what it does
    Unmapped,       // we know what it is, not what it means
    Unshaped,       // we could not read it
    Noise,          // we removed it
    Redacted,       // we dropped a value from it
}
```

`risk` comes from the dictionary entry's `emit.risk` — the same value the emitter stamps on
the same statement. A `set` line is `ChangesConfig`; a `deactivate` or `delete` of a
forwarding-affecting path is `Disruptive` where the entry declares it so. The legend on the
reverse-explanation view is the same legend as everywhere else, unchanged, per the design
language.

### 12.3 Three depths, applied to a line

The three depths are the brief's §5.4 depths and the rulepack spec's `terse` / `explained` /
`teaching` corpus fields. Applied to reverse explanation they mean:

| Depth | Granularity | Content | Bound line example |
|---|---|---|---|
| **Terse** | one line per **block**, not per line | what the block is | `Phase 1 proposal IKE-P1 — algorithms and lifetime` |
| **Explained** | one paragraph per block, plus a one-liner on any line carrying a finding or a non-default value | why the block exists and what to read in the output | *"`external-interface` is the WAN unit the IKE packets leave by, not `st0`."* |
| **Teaching** | per line, plus the block preamble and the counterfactual | the failure mode, the misdiagnosis it prevents, what happens without it | *"Wrong on a multi-homed box means Phase 1 sources from an address the peer has never heard of."* |

Terse annotating at *block* granularity rather than line granularity is the point. A senior
engineer reading a 400-line config at Terse wants twelve lines of output, not four hundred.
Blocks come from the graph — the set of lines that produced one node, or one object-chain
segment — not from text proximity.

**Depth is not truncation** (rulepack spec §11.2). The three texts are three corpus fields.

### 12.4 The object chain, recovered

Side 1 of the field card is organised as the object chain: `ike proposal → ike policy → ike
gateway`, then `ipsec proposal → ipsec policy → ipsec vpn`, then the five plumbing pieces.
A config file is not organised that way — it is organised alphabetically by stanza, and the
five plumbing pieces are scattered across `interfaces`, `security zones`,
`routing-options` and `security policies`.

**The chain is recovered from the graph, not from the text.** Once the fragment is bound,
`ChainRole` is a graph walk:

```text
IpsecVpn ─UsesIkeGateway→ IkeGateway ─UsesIkePolicy→ IkePolicy ─UsesProposal→ IkeProposal
         ─UsesIpsecPolicy→ IpsecPolicy ─UsesProposal→ IpsecProposal
         ─BindsInterface→ LogicalUnit ←ZoneMember─ Zone
                                      ←ResolvesVia─ StaticRoute
```

> **DECISION — two orderings, user-toggled: "as pasted" and "as taught".**

"As pasted" preserves input order and is what you want when comparing against the box. "As
taught" reorders into chain order, which is what you want when learning what the config
does. The toggle sits where the field card's margin tabs sit and reads
`as pasted` / `as taught`.

The as-taught view surfaces what the as-pasted view cannot: **the missing piece**. Side 1's
five plumbing pieces are a checklist, and a config missing piece #3 (`host-inbound-traffic
system-services ike`) reads perfectly well in file order. In chain order the gap is a hole
in a numbered list:

```text
  #1  the tunnel interface        st0.0  10.255.0.1/30              line 34
  #2  st0 into a zone             zone VPN                          line 41
▌ #3  let IKE reach the box       NOT PRESENT IN THIS CONFIG
▌     Phase 1 times out with nothing useful in the log — the box drops
▌     the peer's IKE before processing it. Check this before touching crypto.
  #4  route the remote prefix     10.2.0.0/16 → st0.0               line 52
  #5  policy for the zone pair    TRUST→VPN TO-B permit             lines 58–59
```

That is `zone.host-inbound.ike-missing` rendered as a gap in a walkthrough rather than as a
finding in a list, and it is the single most valuable thing reverse explanation can do. It
comes free from having the chain in the graph. Note it can only be shown when the capture
scope covers those stanzas (§7.4) — otherwise the row reads `not in this paste`, which is a
different and honest statement.

### 12.5 Lines the parser did not understand

The assignment asks specifically for this, and it is where honesty is cheapest to lose.

**`Unmapped` — we know the syntax, not the meaning:**

```text
set security idp idp-policy Recommended
▌ not modelled
▌ This is a `security idp` statement. Fathom does not model IDP, so this
▌ line is preserved verbatim, contributes nothing to the graph, and is
▌ excluded from findings. It is not an error in your config.
```

Three things that annotation must contain and must not exceed: what we recognised
(`security idp`), what we did with it (preserved, excluded), and an explicit statement that
this is our gap and not the config's problem. It must not speculate about what `idp-policy
Recommended` does. We do not know, and the teaching pillar dies the first time it teaches
something wrong.

Where the corpus *does* have a domain-level explainer for an unmodelled area, it is offered
as a link and labelled as general background, not as an explanation of this line.

**`Unshaped` — we could not read it:**

```text
ecurity ike proposal IKE-P1 authentication-method pre-shared-keys
▌ could not be read
▌ The first word is clipped. Fathom will not guess whether it was `set` or
▌ `deactivate` — those mean opposite things. Re-paste this line, or type the
▌ value in directly.
```

**`Redacted`:**

```text
set security ike policy IKE-POL pre-shared-key ascii-text <REDACTED:psk>
▌ dropped before storage
▌ Fathom recorded that a pre-shared key is configured, and not what it is.
▌ Emitting this policy produces  pre-shared-key ascii-text "<PSK>"  for you
▌ to fill in at the terminal.
```

**`Noise`:** rendered muted, collapsed by default, with a count. Clicking expands to the
classification. Prompt lines that contributed evidence (§4.4) are annotated with what they
contributed — *"hostname `srx-a-01`, chassis cluster, node0"* — because that is genuinely
interesting to a user wondering how Fathom knew.

### 12.6 Reverse explanation does not produce emittable config

> **DECISION — the emitter never re-emits residue.**

An emitted config is a projection of the graph. Splicing unparsed lines back in would
produce an artefact that is part generated and part passthrough, with no provenance for
half of it and no ordering guarantee for the join. It would also look like a drop-in
replacement for the running config, and it is not.

Instead the export offers two blocks, separated and labelled:

```text
─ CONFIG GENERATED FROM THE GRAPH ─────────────────────────────
set security ike proposal IKE-P1 ...
...
─ LINES FATHOM DID NOT MODEL — IN ORIGINAL ORDER ──────────────
set security idp idp-policy Recommended
...
▌ THIS IS NOT A COMPLETE DEVICE CONFIGURATION. IT IS THE PART FATHOM
▌ UNDERSTANDS, PLUS THE PART IT KEPT BUT DOES NOT UNDERSTAND.
```

The cost is named in the imperative. A tool that produces something looking like a complete
config, which is silently missing 44 lines, is a tool that causes an outage.

---

## 13. Fuzzing and corpus testing

### 13.1 The actual threat, stated precisely

"This code parses hostile input by definition" is right in outcome and slightly wrong in
mechanism, and the difference changes what we fuzz for.

The input is supplied by the user, who is not the attacker. But the *config* came from
somewhere — an inherited box, a vendor, a colleague, a shared workspace, a rule-pack
fixture, a config bundle from a support case. And the code is Rust with `forbid(unsafe_code)`
running in a WASM sandbox, so classic memory corruption is not the threat.

What is:

| Threat | Consequence | Fuzzed by |
|---|---|---|
| **Panic** | The WASM instance traps. The tab's workspace state is lost if unsaved | Target A |
| **Hang** | Single-threaded tab freezes. The Worker helps but the user still waits forever | Target A + fuel |
| **Unbounded allocation** | OOM, tab dies, unsaved work lost | Target A + allocator cap |
| **A secret surviving the gate** | Invariant 3 broken | Target C |
| **Silent loss** | I4 broken; the user's config is quietly incomplete | Target B |
| **Wrong bind** | A confidently wrong graph, which produces a confidently wrong finding and a confidently wrong config | Targets D, E |

The last row is the one that hurts most and is the hardest to fuzz, because it needs an
oracle. §13.4.

### 13.2 The targets

```rust
// A — totality. The only target that runs on raw bytes.
fuzz_target!(|data: &[u8]| {
    let out = ingest::run(data, Platform::Auto, &DICT, Limits::fuzz());
    assert!(out.is_report());              // never Err, never panic
    ledger_tiles_exactly(&out);            // invariant L, §4.6
});

// B — accounting, under structured damage.
fuzz_target!(|c: DamagedConfig| {
    let out = ingest::run(&c.render(), c.platform, &DICT, Limits::fuzz());
    assert_eq!(out.ledger.covered_bytes(), out.capture.text.len());
    assert_eq!(out.ledger.lines.len(), out.report.total_lines());
});

// C — redaction soundness. The security target.
fuzz_target!(|c: ConfigWithCanaries| {
    let out = ingest::run(&c.render(), c.platform, &DICT, Limits::fuzz());
    let blob = serialise_entire_workspace(&out);      // every section
    for canary in c.canaries() {
        assert!(!blob.contains(canary), "canary {canary} survived");
    }
});

// D — round trip. The correctness oracle we do have.
fuzz_target!(|c: ValidConfig| {
    let text = c.render();
    let out  = ingest::run(&text, c.platform, &DICT, Limits::fuzz());
    let back = emit::device(&out.fragment, c.platform);
    assert_eq!(normalise(back), normalise(bound_lines_of(&text, &out)));
});

// E — re-parse idempotence.
fuzz_target!(|c: ValidConfig| {
    let g1 = ingest_into(Graph::new(), &c.render());
    let g2 = ingest_into(g1.clone(),   &c.render());
    assert_eq!(g1.node_ids(), g2.node_ids());     // no duplicates
    assert!(g2.conflicts().is_empty());           // no self-conflict
    assert_eq!(g1.values(), g2.values());         // only provenance changed
});
```

`Limits::fuzz()` caps the allocator, the fuel counter and the depth guard low enough that a
violation surfaces as an assertion rather than an OOM kill.

Targets A and B run on raw and structured input respectively. C, D and E need generated
valid-ish configs, which is where `arbitrary` earns its place.

### 13.3 Structure-aware generation

```rust
#[derive(Arbitrary)]
pub struct ValidConfig {
    platform: Platform,
    devices:  Vec<DeviceSpec>,        // bounded 1..=2
}

#[derive(Arbitrary)]
pub struct DamagedConfig {
    base: ValidConfig,
    damage: Vec<Damage>,              // bounded 0..=16
}

#[derive(Arbitrary)]
pub enum Damage {
    TruncateHead(u8),                 // drop N bytes from line 0
    TruncateTail(u8),
    HardWrapAt(u16),                  // re-wrap the whole text at a column
    InsertPrompt(usize),
    InsertPagination(usize),
    InsertAnsi(usize),
    SmartQuotes,                      // ASCII " ' - -> U+201C/2018/2013
    ToCp1252,
    DropRandomLine(usize),
    DuplicateLine(usize),
    SpliceOtherPlatform(usize),
    IndentShift(usize, i8),           // IOS only
    UnterminatedQuote(usize),
    UnterminatedBrace(usize),
    BannerDelimiterChaos,
}
```

`Damage` is the fuzzing artefact that matters, because it encodes §8.1's taxonomy directly.
A random byte mutator finds crashes; a `Damage` list finds the *recovery* bugs, which are
the ones that lose a user's data quietly.

`ConfigWithCanaries` places a canary at every secret-bearing position in the generated
config, including positions reachable only through the generic detectors — a made-up
statement path with a `key` leaf segment and a canary value, which is precisely the
uncatalogued-statement case §9.4 exists for.

Source: [Rust Fuzz Book — Structure-Aware Fuzzing](https://rust-fuzz.github.io/book/cargo-fuzz/structure-aware-fuzzing.html).

### 13.4 The oracle problem, and the two oracles we do have

Differential fuzzing needs a second implementation and there is not one. But the pipeline
contains two genuine equivalences that serve as oracles for free:

| Oracle | Claim | What it catches |
|---|---|---|
| **Junos curly ⇄ set** | The curly-brace shaper and the set shaper produce identical `StmtTree`s for the same configuration (§5.2) | Shaper bugs in either direction. Generate a `ValidConfig`, render it both ways, assert tree equality modulo comment nodes |
| **PAN set ⇄ XML** | The set shaper and the XML shaper produce the same path space (§5.4) | Same, for PAN. Also validates the `entry name=` collapsing rule |
| **Bind ⇄ emit** | Target D | Dictionary errors, scalar round-trip violations (IR §4.2 L1/L2) |

The first two are real differential oracles between two independent code paths, and they
exist only because §2.3 chose a shared CST. That was not why the CST was chosen, and it is
worth noting that the modularity paid a dividend nobody designed for.

### 13.5 Panic and hang policy

| Control | Mechanism |
|---|---|
| No panics | `#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]` across the ingest crate. Slicing goes through a checked span helper |
| No unsafe | `#![forbid(unsafe_code)]` |
| No unbounded loops | Every loop in stages 1–6 is driven by a cursor that strictly advances, plus a global **fuel counter**: one unit per token, per trie visit, per tree node. Budget `= 4,000 × input_lines`. Exhaustion ends ingest with a partial report and `Diag::FuelExhausted`, never a hang |
| No unbounded recursion | §11.6 |
| No unbounded allocation | A per-ingest arena with a cap of `16 × input_len + 8 MB`. Exceeding it ends ingest with a partial report |
| WASM trap containment | Ingest runs in a Worker (§11.5), so a trap that escapes all of the above kills the Worker and not the tab. The main thread reports "ingest failed, nothing was changed" |

**A partial report is a valid outcome.** Fuel exhaustion or allocation cap produces the
ledger up to that point, the residue for everything after it, and a plain statement that
ingest stopped. It does not produce a plan, and it does not touch the graph.

### 13.6 The corpus

| Corpus | Contents | Role |
|---|---|---|
| **Field card** | Every command and config line on all four sides | Round-trip fixtures (IR §4.2). A parser or emitter regression breaks the build |
| **Vendor documentation examples** | Config snippets from published vendor docs, with the source cited per fixture | Coverage of syntax we do not otherwise see |
| **Synthetic** | Generated by the `ValidConfig` generator, seeded deterministically, checked in | Reproducible bulk coverage |
| **Damage** | The `DamagedConfig` outputs of every historical fuzz crash, minimised and named after the crash | Regression. Every crash becomes a permanent fixture |
| **Canary** | §9.11 | Security regression |
| **Donated** | Real configs contributed by users | See below |

**The seed-corpus problem, honestly.** The most valuable seed corpus is real configs from
real networks, and that is exactly the thing this project cannot ask for. A user who trusts
Fathom because it does not exfiltrate configs is not going to email us their SRX config.

What we can do, in order of preference:

1. Synthesise aggressively, which covers syntax we thought of and nothing else.
2. Mine published vendor documentation and vendor-supplied example configs, which is legal
   to redistribute in some cases and not others, so each fixture carries its provenance.
3. Offer an explicit, opt-in **donation path**: the CLI's `fathom ingest --donate` runs the
   full gate, then a second, far more aggressive anonymiser (every IP → a stable synthetic
   IP, every hostname and object name → a stable synthetic name, every description dropped),
   shows the user the resulting text in full, and only then offers to save a file the user
   sends us if they choose. Nothing is transmitted by the tool (invariant 1).

That third path is worth building and will produce a small corpus. **This is a real weakness
of the project and it should be stated as one rather than engineered around:** Batfish has a
decade of real multi-vendor configs behind its grammars and Fathom will not. The mitigation
is that our failure mode is a residue entry and a completeness prompt, not a wrong answer —
which is why §8's accounting design matters more here than it would for a tool with better
corpus access.

### 13.7 CI gates

| Gate | Blocking | Frequency |
|---|---|---|
| Targets A and B, 60 s each | yes | every PR |
| Targets C, D, E, 60 s each | yes | every PR |
| Full fuzz run, 30 min per target | yes | nightly; a new crash blocks the next release |
| Field card round-trip, all four sides | yes | every PR |
| Dictionary validation, §6.5 | yes | every PR |
| Canary corpus, §9.11 | yes | every PR |
| Regression corpus | yes | every PR |

---

## 14. Worked example — field card side 1, damaged

### 14.1 The paste

What arrives on the clipboard. Damage is realistic and deliberate: a clipped first line, a
cluster banner, a command echo, a pager marker, a hard wrap at 88 columns that splits a
token, a backslash continuation, an unmapped line, and the PSK.

```text
{primary:node0}
admin@srx-a-01> show configuration | display set
ecurity ike proposal IKE-P1 authentication-method pre-shared-keys
set security ike proposal IKE-P1 dh-group group14
set security ike proposal IKE-P1 authentication-algorithm sha-256
set security ike proposal IKE-P1 encryption-algorithm aes-256-cbc
set security ike proposal IKE-P1 lifetime-seconds 28800
set security ike policy IKE-POL proposals IKE-P1
set security ike policy IKE-POL pre-shared-key ascii-text "$9$EXAMPLEnotARealKey01234"
set security ike gateway GW-B ike-policy IKE-POL
set security ike gateway GW-B address 203.0.113.10
set security ike gateway GW-B external-interface reth0.0
set security ike gateway GW-B version v2-only
set security ike gateway GW-B dead-peer-detection \
  always-send interval 10 threshold 3
---(more 41%)---
set security ipsec proposal IPSEC-P2 protocol esp
set security ipsec proposal IPSEC-P2 encryption-algorithm aes-256-gcm
set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14
set security ipsec policy IPSEC-POL proposals IPSEC-P2
set security ipsec vpn VPN-B ike gateway GW-B
set security ipsec vpn VPN-B ike ipsec-policy IPSEC-POL
set security ipsec vpn VPN-B bind-interface st0.0
set security ipsec vpn VPN-B establish-tunnels immediately
set security zones security-zone WAN interfaces reth0.0 host-inbound-traffic system-servi
ces ike
set security idp idp-policy Recommended
set routing-options static route 10.2.0.0/16 next-hop st0.0

{primary:node0}
admin@srx-a-01>
```

### 14.2 Stage 1 — Frame

| Ordinal | Class | Note |
|---|---|---|
| 0 | `Noise(ClusterBanner{node:0})` | evidence: chassis cluster, node0 |
| 1 | `Noise(Prompt{host:"srx-a-01", mode:Operational})` + `Noise(CommandEcho)` | evidence: hostname, platform junos, command `show configuration \| display set` |
| 2 | `Statement` | first token `ecurity` is not a verb; wrap width not detected; hypothesis 1 fails (no unique verb suffix); hypothesis 2 succeeds as a path suffix → will become `Unshaped { TruncatedHead }` |
| 3–8 | `Statement` | clean |
| 9–12 | `Statement` | clean |
| 13+14 | `Statement`, `join: Backslash` | joined to `set security ike gateway GW-B dead-peer-detection always-send interval 10 threshold 3` |
| 15 | `Noise(Pagination)` | **scope drops to `Fragment`** |
| 16–23 | `Statement` | clean |
| 24+25 | `Statement`, `join: HardWrap(88)` | line 24 has length exactly 88; three other lines share that length; joined **without separator** → `... host-inbound-traffic system-services ike` |
| 26 | `Statement` | will become `Unmapped` |
| 27 | `Statement` | clean |
| 28 | `Blank` | |
| 29, 30 | `Noise` | trailing prompt |

Wrap detection on this input: the histogram finds length 88 occurring on lines 8, 24 and one
other, each followed by a non-verb line, so `HardWrapAt(88)` is inferred. Line 8's join is
therefore also no-separator — but line 8 does not wrap in this sample, and lines that are
exactly 88 characters and *are* followed by a verb line are not joined at all. That
asymmetry is why the rule is "length exactly `L` **and** the next line is a continuation
candidate", not "length exactly `L`".

### 14.3 Stage 4 — the gate, on the PSK line

The logical line at ordinal 8:

```text
set security ike policy IKE-POL pre-shared-key ascii-text "$9$EXAMPLEnotARealKey01234"
```

Line-relative offsets:

| Offset | Content |
|---|---|
| 0 | `set ` |
| 4 | `security ` |
| 13 | `ike ` |
| 17 | `policy ` |
| 24 | `IKE-POL ` |
| 32 | `pre-shared-key ` |
| 47 | `ascii-text ` |
| **58** | `"$9$EXAMPLEnotARealKey01234"` — 28 bytes including quotes |
| 86 | end of line |

Detector results:

| Detector | Fires? | Reason |
|---|---|---|
| Path | **yes** | Statement path matches dictionary entry `junos-srx/security.ike.policy.pre-shared-key.ascii`, which carries `secret: { label: Psk }` |
| Value shape — crypt prefix | **yes** | The value begins `$9$` |
| Value shape — leaf name | **yes** | The last literal path segment before the argument is `ascii-text`, preceded by `pre-shared-key`, which is in the secret-word list |
| Value shape — base64 | no | The `Unmapped` precondition is not met |

Three detectors, one redaction, three reasons in the manifest.

**The rewrite.** If the logical line begins at capture offset 412, the argument occupies
`[470, 498)`. The gate replaces that span with `<REDACTED:psk>` (14 bytes), so the stored
capture text contains:

```text
set security ike policy IKE-POL pre-shared-key ascii-text <REDACTED:psk>
```

and the redaction entry is:

```text
RedactionEntry {
  orig:     [470, 498),          # pre-redaction coordinates — destroyed with the buffer
  new:      [470, 484),
  label:    Psk,
  detector: PathCatalogue | CryptPrefix | LeafName,
  orig_len: 28,                  # in-memory manifest only, never persisted
}
```

Every span recorded after this point is in post-redaction coordinates, so the 14-byte
shrink is invisible to the rest of the pipeline (§9.5). Statement spans for lines after this
one are computed from the rewritten buffer, not adjusted afterwards.

Note the marker carries **no quotes**. `<REDACTED:psk>` contains `<` and `>`, which are not
legal in a bare Junos token, so the stored capture cannot be pasted back into a box as
working config and any code that re-lexes it flags the token. That is deliberate and it is
the opposite of the emitter's placeholder, which *is* quoted and *is* meant to be pasted:

```text
stored capture:   ... pre-shared-key ascii-text <REDACTED:psk>       not pasteable
emitted config:   ... pre-shared-key ascii-text "<PSK>"              pasteable, fill it in
```

### 14.4 Stage 5 — Bind

The IR fragment, in the dump style of IR §15. ULIDs abbreviated. `cap-B4K7Q` is this
capture; `p-1xxx` are provenance records with `Origin::Parsed{cap-B4K7Q, span, stanza}`,
`Confidence::Asserted`, except where noted.

```yaml
- id: fathom:device:7QK4M                 # matched to the existing device, §10.1
  kind: Device
  fields:
    hostname: Set("srx-a-01")   prov: p-1001   # Confidence: Heuristic — from the prompt
    platform: Set(junos-srx)    prov: p-1001   # Confidence: Heuristic — from the prompt
  note: no `set system host-name` statement in this paste

- id: fathom:ike-proposal:L4C8B
  kind: IkeProposal
  fields:
    name:                     Set("IKE-P1")               prov: p-1010
    authentication_method:    Unknown                     # line 2 was Unshaped
    dh_group:                 Set(Modp2048)               prov: p-1011
    authentication_algorithm: Set(HmacSha256_128)         prov: p-1012
    encryption_algorithm:     Set(Aes{256, Cbc, aead:false})  prov: p-1013
    lifetime_seconds:         Set(28800)                  prov: p-1014

- id: fathom:ike-policy:M6D0V
  kind: IkePolicy
  fields:
    name:           Set("IKE-POL")                                  prov: p-1020
    pre_shared_key: Set(SecretPlaceholder{ label: Psk, hint: None }) prov: p-1021
    mode:           Unknown
  edges_out:
    UsesProposal -> fathom:ike-proposal:L4C8B { ordinal: 0 }        prov: p-1022

- id: fathom:ike-gateway:N2F7R
  kind: IkeGateway
  fields:
    name:    Set("GW-B")                                            prov: p-1030
    peer:    Set(Address(203.0.113.10))                             prov: p-1031
    version: Set(V2Only)                                            prov: p-1032
    dpd:     Set(Dpd{ AlwaysSend, interval:10, threshold:3 })        prov: p-1033
    local_identity:  Unknown
    remote_identity: Unknown
    nat_keepalive:   Unknown              #  <-- NOT Absent: scope is Fragment (§7.4)
  edges_out:
    UsesIkePolicy     -> fathom:ike-policy:M6D0V                    prov: p-1034
    ExternalInterface -> fathom:logical-unit:D3W9L  (reth0.0)       prov: p-1035

- id: fathom:ipsec-proposal:Q8S1T
  kind: IpsecProposal
  fields:
    name:                 Set("IPSEC-P2")                           prov: p-1040
    protocol:             Set(Esp)                                  prov: p-1041
    encryption_algorithm: Set(Aes{256, Gcm, aead:true})             prov: p-1042
    lifetime_seconds:     Unknown          #  the line was after the pager cut
    authentication_algorithm: Unknown      #  correct — AEAD, IR §6.7 constraint

- id: fathom:ipsec-policy:R3G7W
  kind: IpsecPolicy
  fields:
    name:                    Set("IPSEC-POL")                       prov: p-1050
    perfect_forward_secrecy: Set(Modp2048)                          prov: p-1051
  edges_out:
    UsesProposal -> fathom:ipsec-proposal:Q8S1T { ordinal: 0 }      prov: p-1052

- id: fathom:ipsec-vpn:R7T2Q
  kind: IpsecVpn
  fields:
    name:               Set("VPN-B")                                prov: p-1060
    establish_tunnels:  Set(Immediately)                            prov: p-1061
    df_bit:             Unknown
  edges_out:
    UsesIkeGateway  -> fathom:ike-gateway:N2F7R                     prov: p-1062
    UsesIpsecPolicy -> fathom:ipsec-policy:R3G7W                    prov: p-1063
    BindsInterface  -> fathom:logical-unit:H8J4S  (st0.0)           prov: p-1064

- id: fathom:zone:F7N1K
  kind: Zone
  fields:
    name: Set("WAN")                                                prov: p-1070
  edges_out:
    ZoneMember -> fathom:logical-unit:D3W9L (reth0.0)
      { host_inbound_system_services: {Ike} }                       prov: p-1071

- id: fathom:static-route:T9V2M
  kind: StaticRoute
  fields:
    destination: Set(IpPrefix(10.2.0.0/16))                         prov: p-1080
    next_hop:    Set([Interface(fathom:logical-unit:H8J4S)])        prov: p-1081
```

Three things to notice.

**`nat_keepalive: Unknown`, not `Absent`.** The pager marker made the scope `Fragment`, and
IR §8.5 forbids asserting absence from a fragment. Every rule that keys on `Absent` returns
`Unevaluable` here, and the user gets a completeness prompt rather than a finding. Compare
IR §15.4's version of the same node, where a `Whole` capture licensed `nat_keepalive:
Absent`. Same statement, different capture, different truth value — which is exactly what
capture scope is for.

**`authentication_method: Unknown` on `IKE-P1`.** Line 2 was the clipped one. The rest of
the proposal bound fine. This is §7.1's "a failure on one statement does not lose the node".

**The `ZoneMember` edge carries `host_inbound_system_services`.** Per IR §7.5 that field
lives on the edge, not the zone, because in Junos it is configured per interface within the
zone. The hard-wrapped line at ordinals 24–25 produced it, which means a wrong join here
would have silently removed plumbing piece #3 — the one the field card says *"Miss #3 and
Phase 1 times out with nothing useful in the log."* That is why §4.3 refuses to guess.

### 14.5 Stage 7 — the plan

```text
RECONCILE  ·  srx-a-01  ·  scope: Fragment
  covered: security/ike/**, security/ipsec/**  (partial — truncated at 41%)

  matched   9   tier 1 (name within device)
  created   0
  renamed   0
  absent    0   (scope is Fragment — nothing may be marked absent)
  ambiguous 0
  conflicts 0

  value changes  1
    IkeGateway GW-B · dpd.threshold
      was  Set(5)      parsed 2026-03-14  from `show configuration | display set`
      now  Set(3)      parsed 2026-07-28  from this paste

  → purely additive plus one parsed-over-parsed value change: auto-appliable (§10.3)
```

That single value change is the product working. The field card says the Junos default is
`10 × 5 = 50 s of blackhole before failover even starts` and recommends `10 × 3`; the graph
now records that somebody changed it, when, and from what — and the field history keeps the
5.

### 14.6 The ingest report

```text
────────────────────────────────────────────────────────────────────────
INGEST  ·  srx-a-01  ·  junos-srx  ·  display set  ·  fragment
────────────────────────────────────────────────────────────────────────
  READ-ONLY — SAFE ON PRODUCTION    CHANGES CONFIG — NEEDS A COMMIT
  DISRUPTIVE — DROPS LIVE TRAFFIC
────────────────────────────────────────────────────────────────────────

  31 lines in

  22  bound             → 9 nodes matched, 11 edges                what was read
   1  understood, not modelled     security idp
   1  could not be read            line 3
   6  transport noise              prompt ×2, cluster banner ×2, echo, pager
   1  joined at a terminal wrap    88 columns
   1  joined at a backslash
   1  value dropped before storage

▌ THIS PASTE IS TRUNCATED — A PAGER MARKER WAS FOUND AT 41%
▌ Fathom will not report anything as "absent" for this device from this paste.
▌ Re-paste with:  show configuration | display set | no-more

▌ DROPPED BEFORE STORAGE — NOT RECOVERABLE FROM THIS WORKSPACE
▌ line 9   set security ike policy IKE-POL pre-shared-key ascii-text …
▌          pre-shared key · 3 detectors agreed · 28 characters
▌          Junos $9$ is obfuscation, not encryption — it reverses to the
▌          plaintext with one command on the box. Fathom treats it as the
▌          secret it is.
▌
▌ YOUR CLIPBOARD STILL HOLDS IT. CLEAR IT.

  line 3    ecurity ike proposal IKE-P1 authentication-method pre-shared-keys
            first word is clipped. Fathom will not guess whether it was `set`
            or `deactivate` — those mean opposite things.
            → IkeProposal IKE-P1 · authentication_method is unknown
────────────────────────────────────────────────────────────────────────
```

### 14.7 Reverse explanation, three depths, three lines

**`set security ike gateway GW-B external-interface reth0.0`**

| Depth | Output |
|---|---|
| Terse | (folded into the block line: `Phase 1 gateway GW-B — peer, interface, version, DPD`) |
| Explained | `external-interface` is the WAN unit the IKE packets leave by, not `st0`. Bound here to `reth0.0`. |
| Teaching | `external-interface` is the WAN unit the IKE packets leave by, not `st0`. Wrong on a multi-homed box means Phase 1 sources from an address the peer has never heard of — and the peer, seeing an unexpected source, either ignores it or fails identity validation. That reads in the log as `AUTHENTICATION_FAILED` or `peer's IKE-ID validation failed`, and it is easily misread as a wrong pre-shared key. Check identity before you re-type the PSK. |

**`set security ike policy IKE-POL pre-shared-key ascii-text <REDACTED:psk>`**

| Depth | Output |
|---|---|
| Terse | `pre-shared key configured · dropped` |
| Explained | This policy authenticates with a pre-shared key. Fathom recorded that a key is configured and dropped the value before storing anything. Emitting this policy produces `pre-shared-key ascii-text "<PSK>"` for you to fill in at the terminal. |
| Teaching | (as Explained, plus) The value in your paste was a Junos `$9$` string. `$9$` is obfuscation, not encryption — it reverses to the plaintext with `request system decrypt password` on the box, so it is the secret, not a hash of it. A PSK mismatch shows as `AUTHENTICATION_FAILED`, which is also what an identity mismatch shows as; the field card's rule applies — check identity before you re-type the PSK. |

**`set security idp idp-policy Recommended`**

| Depth | Output |
|---|---|
| Terse | `not modelled` |
| Explained | This is a `security idp` statement. Fathom does not model IDP, so this line is preserved verbatim, contributes nothing to the graph, and is excluded from findings. It is not an error in your config. |
| Teaching | (as Explained. There is no teaching text, because we have nothing true to teach about this line, and the corpus is not permitted to improvise.) |

That last cell is the honest one and the lint gates in the rulepack spec must allow it:
**an explainer may be absent at Teaching depth for an `Unmapped` line, and the UI must say
so rather than fall back to the Explained text with a different heading.**

---

## 15. What this design costs

| Cost | Detail |
|---|---|
| **The dictionary is a content programme** | 400–2,500 entries per platform, human-reviewed. Coverage is the product's real limit, and no amount of parser engineering moves it |
| **Two hand-written shapers will have bugs a generated parser would not** | Mitigated by fuzzing and by the two free differential oracles (§13.4), not eliminated |
| **We lose annotations under `display set`** | The primary paste format strips `annotate` comments. We offer curly-brace as an alternative and say why |
| **We do not expand configuration groups** | A group-heavy Junos config produces a graph with holes in exactly the stanzas that matter, unless the user re-pastes with `display inheritance` |
| **Quarantine drops legitimate content** | §9.7 destroys the text of any unshaped line that trips a secret detector. Some of those are descriptions |
| **Redaction is a retention control, not a confidentiality control** | §9.9. The plaintext is in the tab's memory during the paste and we cannot change that |
| **Emitted config is never a drop-in replacement** | §12.6. Residue is not re-emitted, and the export says so in caps |
| **No incremental reparse, permanently** | §3.3. Reversing this is a rewrite of stages 1–3 |
| **Peak memory is ~13× the paste** | §11.3. A 32 MB cap follows, and large fleet bundles are refused rather than attempted |
| **The seed corpus is structurally weak** | §13.6. We cannot ask for the data that would make the parsers good |
| **The dictionary is a contended file** | §6.4's shared table means parser and emitter changes collide there. That is the price of not drifting |

---

## 16. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| 1 | Restricted group expansion | (a) never expand, as §5.1; (b) expand literal-segment, single-level, non-wildcard `apply-groups` only, marking every expanded value `Confidence::Derived` | (b) is tempting and covers the common `groups node0`/`node1` cluster case, which is very common. Needs a written spec of exactly which inheritance features are supported before it is safe |
| 2 | SSH public keys | redact (current), or keep as an identifier | Redact, but this is arguable and the manifest makes it visible |
| 3 | "This is intent, not observation" flag on `Capture` | add a `CaptureIntent { Observed, Intended }` field | Probably yes — it makes §10.5's last row solvable and costs one enum. Needs IR §8.4 to change |
| 4 | Whether ingest may run on the main thread at all | always Worker, or the fragment-tier exception in §11.2 | The exception is worth keeping for latency; revisit if the security argument for Worker termination (§9.9) is judged to dominate |
| 5 | Donation pipeline | build `--donate` (§13.6) in v1 or later | Later, but design the anonymiser alongside the redactor so they share detectors |
| 6 | Junos `annotate` under `display set` | see the VERIFY in §5.1 | If it turns out annotations are rendered, add a dictionary entry and the cost in §15 disappears |

---

## 17. Proposed changes to `11-ir-schema.md`

Two, both stated as proposed changes rather than silent deviations.

**17.1 — §8.4's same-length redaction marker.** IR §8.4 specifies replacement by a marker
*"of the same span length, so all other offsets are preserved."* §9.5 above argues that
same-length padding either truncates the marker or encodes the secret's length in the stored
artefact, and that the offset problem it solves does not arise once redaction is ordered
before any span is recorded. **Proposed:** fixed-length marker, plus a `RedactionMap` whose
original coordinates never leave the gate, and an explicit statement in IR §8.4 that all
persisted spans are post-redaction coordinates.

**17.2 — `CaptureScope` is computed, not supplied.** IR §10.5 introduces `CaptureScope` as a
property of a `Capture` without saying who determines it. §7.4 above specifies the
computation and makes pagination markers and truncated head lines demote a capture to
`Fragment`. **Proposed:** add one sentence to IR §8.4 stating that `Capture.scope` is
computed by ingest from parse evidence and is not user-selectable, because a user-selectable
scope is a user-selectable licence to assert `Absent`, and that licence is what makes
`ipsec.pfs.absent` trustworthy.

---

## 18. Disagreements

None with `conventions.md`. Two notes on how conventions were applied, recorded so a
reviewer does not read them as drift:

1. **"record".** The conventions ban "record" as a synonym for a graph element. This
   document uses `ProvenanceRecord` (already established in IR §8.2) and `RedactionEntry`,
   and uses **logical line** rather than "record" for framed input units, precisely to keep
   the banned sense unambiguous.
2. **`Risk` on annotations.** Reverse-explanation annotations carry `Risk`, which is the
   three-value enum, sourced from the dictionary's `emit.risk` — the same value the emitter
   stamps on the same statement. No fourth value is introduced and the risk colours are not
   reused for anything else: parse outcomes (`Bound` / `Unmapped` / `Unshaped` / `Noise`)
   render in neutrals with weight and the 4px accent bar in ink, and the drop manifest's
   accent is `#8C2F2F` because dropping a credential is the `Disruptive` band of a
   *config-changing* artefact, not because "dropped" is a severity.

<!-- VERIFY: point 2's colour choice against the design docs, on the same grounds as the
     open question in IR §9.4 about blocker colouring. If blockers move to neutrals, the
     drop manifest should move with them. -->
