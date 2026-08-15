# 47 — The byte census

> **Status:** Proposed. Measured at commit `adbb590` and re-anchored onto `adbd9a2`, both 2026-08-15.

Companion documents: `44-performance-budgets.md` (**owns** every size budget and ceiling —
`01-ownership.md` row *"Size, memory and latency budgets"*; this document measures, `44` decides),
`41-technology-choices.md` §2.1 (the language choice these bytes are a consequence of), §2.6 (what
would reopen it) and §3.10 (the component split `44` §5.2 adopted, and its own instruction to
*"measure the day `fathom-core` compiles and replace every row"*), `35-supply-chain-and-builds.md`
(why no measuring tool may be downloaded), `79-work-orders/00-ROUTE-TO-WORKABLE.md` §2 stage 1 and
§5b (the decisions this census informs).

**This document owns no budget and moves no ceiling.** It owns one thing: the measured composition
of the release module, and a reproducible instrument for re-measuring it. Where it corrects a number,
it corrects that number *in the document that owns it* and records the correction here in §10.

The census was commissioned because of a plain fact: the 900 000-byte ceiling has shaped every plan
in this tree for two weeks and **nobody had ever measured where the bytes go.** Every figure in
circulation was a delta, a guess, or a row in a budget table written before the code existed.

**What it found, in four lines.** The module is **886 321 bytes with 13 679 left**. The largest
single block — **243 522 bytes, 27.5 %** — is shared B-tree and sort machinery that belongs to no
feature and appears in no budget. **35 % of the module belongs to no feature at all.** And the config
view, which is written and tested, **costs 93 838 and does not fit** — the first feature this project
has had to refuse on size. §11 is what to do about it.

---

## 0. Contents

| § | |
|---|---|
| 1 | What was measured, on what, and when — **two builds, and which of them to quote** |
| 2 | The instrument, and why it is a loose `rustc` script |
| 3 | The module by section, at both commits, and where the growth went |
| 4 | The code section by crate — two attributions, why one number is a lie, and what the shared machinery is really the price of |
| 5 | The largest single contributors |
| 6 | Cost by removal — what each feature actually costs, at both commits |
| 7 | The data section — what 143 567 bytes were, and what has since left |
| 8 | The generated layer: the claim, and what the measurement says |
| 9 | Persistence, cryptography, and **the config view that does not fit** |
| 10 | Recorded figures: which hold, which are wrong, and the corrections made |
| 11 | **RECOMMENDATION** — what to do about 13 679 bytes |
| | Failure modes |
| | Open decisions |
| | Sources consulted |
| | Disagreements |

---

## 1. What was measured, on what, and when

*margin tab: read this before quoting any number below*

### 1.1 Two builds, two jobs

This census was taken at one commit and then re-anchored onto another four days later, because the
module moved 33 403 bytes underneath it while it was being written. Both are recorded, because they
do different work and confusing them is the single easiest way to misuse this document.

| | **The analysis build** | **The decision build** |
|---|---|---|
| Commit | `adbb590` | `adbd9a2` (the tip) |
| What it is for | Every composition table, ranking, attribution and ablation in §3–§9. These are *proportions and mechanisms*, and they hold | Every figure a decision rests on: §3.3, §6.4, §9.3, §11 |
| **Module size** | **852 918** | **886 321** |
| **Headroom against 900 000** | 47 082 | **13 679** |
| Full artifact | 1 215 578 | **1 399 960** |
| Date measured | 2026-08-15 | 2026-08-15 |

Common to both: rustc **1.94.1** pinned by `rust-toolchain.toml`, target `wasm32-unknown-unknown`,
the workspace `[profile.release]` (`opt-level = "z"`, `lto = "fat"`, `codegen-units = 1`,
`panic = "abort"`, `strip = "symbols"`, `debug = 0`, `overflow-checks = true`), built with
`cargo build --release --locked -p fathom-wasm --target wasm32-unknown-unknown` and read at
`target/wasm32-unknown-unknown/release/fathom_wasm.wasm`.

**The rule for quoting this document: if you are deciding, quote a decision-build number and
re-run §2.4's script first. If you are reasoning about where bytes come from, the analysis build is
the better instrument, because it has the fuller ablation set behind it.**

### 1.2 What moved between the two, and what it cost

Three changes landed between `adbb590` and `adbd9a2`, and their net effect is **+33 403 bytes**:

| Change | Direction | Measured |
|---|---|---|
| The `junos-srx` dictionary and `schema/field-keys.yaml` left the module and are handed in at boot over `OP_DICT` | **−26 915** (the change's own measurement) | This census independently confirms the data-section half: the data section fell **143 567 → 117 479, −26 088**, against 29 670 bytes of YAML removed. §7.2 had priced the same text at 38 460 by removal, of which 29 670 has now gone |
| `crates/fathom-layout/` and the diagram surface | **+60 096** by removal (§6.4) | The largest single feature ever added to this module |
| Aggregation | **+15 344** (the change's own measurement) | Not independently re-measured here |

Two consequences worth stating plainly, because both invert a claim that was true a week ago:

1. **The dictionary lever is spent.** Exactly one `include_str!` of YAML remains in the workspace —
   `crates/fathom-corpus/src/seed_concepts.yaml`, 8 781 bytes. Stage 1's data-handoff decision is now
   worth **8 KB**, not 38 KB and never the 200 KB it is sometimes planned as.
2. **The bytes the dictionary bought back have already been spent, roughly twice over.** The move
   returned 26 915 and the diagram took 60 096.

`scripts/gate-zero.sh` did not exist at `adbb590` and does exist at the tip; it is run and recorded
in §*Sources consulted*.

---

## 2. The instrument

*margin tab: how any of this can be checked*

### 2.1 What was ruled out first

`twiggy` answers "where do the bytes go" for WebAssembly and `wasm-objdump` answers "what sections
are there". **Neither may be used**: ADR-0032 permits third-party code only gated and vendored with
an owner-signed approval record, and `78` §5.2 forbids an execution session from downloading a tool.
The same constraint already produced `crates/fathom-wasm/src/wasmbin.rs`, a first-party reader for
the import and export sections, and this census extends that approach rather than arguing with it.

### 2.2 Three builds, one reader

| Build | Profile change | What it is for |
|---|---|---|
| **SHIPPED** | none | The bytes the gate measures and the page loads. Every total in §3 is this build |
| **NAMED** | `strip = "none"` | Keeps the `name` custom section wasm-ld would otherwise discard, so a function body can be joined to a symbol |
| **V0** | `strip = "none"` + `-C symbol-mangling-version=v0` | v0 encodes **generic arguments**. Legacy mangling does not, so under legacy a monomorphised `BTreeMap::<NodeId, Node>::insert` is indistinguishable from any other `insert` and can only be attributed to `alloc` |

`scripts/byte-census.rs` reads all three: it walks the section table, sums function-body sizes out of
the code section, parses subsection 1 of the `name` section, and joins the two. `scripts/byte-census.sh`
runs the whole thing. Both are new files, neither is a workspace member, neither enters the artifact,
and neither runs under `cargo test` — a measuring instrument that can affect what it measures is not
one.

### 2.3 The fidelity guard, and the drift it found

An attribution built on a *different* binary from the one that ships is worse than no attribution, so
the tool compares the two code sections function-for-function and prints what it finds rather than
asserting they match:

| | SHIPPED | V0 named |
|---|---:|---:|
| defined functions | 3 125 | 3 121 |
| code-body bytes | 705 019 | 704 563 |

**Drift: −456 bytes, 0.06 % of the code section.** Four functions differ, which is what changing the
linker's strip behaviour and the symbol lengths costs. Every per-function and per-crate number in §4
and §5 is therefore accurate to within 0.06 %, and the tool says so on every run instead of leaving
the reader to assume it.

### 2.4 Reproducing it

```
./scripts/byte-census.sh            # writes target/census/census.md
TOP=60 ./scripts/byte-census.sh     # deeper tables
```

The ablations in §6 are not scripted into the repository: each one edits the tree, builds, and
reverts, and a script that edits the tree is a script that can leave it edited. The exact edit for
each row is named in the table so it can be redone by hand.

---

## 3. The module by section

*margin tab: two sections are the whole module*

| Section | Payload | + header | Total | Share |
|---|---:|---:|---:|---:|
| type | 599 | 3 | 602 | 0.07 % |
| function | 3 127 | 3 | 3 130 | 0.37 % |
| table | 7 | 2 | 9 | 0.00 % |
| memory | 3 | 2 | 5 | 0.00 % |
| global | 25 | 2 | 27 | 0.00 % |
| export | 83 | 2 | 85 | 0.01 % |
| element | 457 | 3 | 460 | 0.05 % |
| **code** | 705 021 | 4 | **705 025** | **82.66 %** |
| **data** | 143 563 | 4 | **143 567** | **16.83 %** |
| preamble (`\0asm` + version) | | | 8 | 0.00 % |
| **Total** | | | **852 918** | **100.00 %** |

The tool asserts that every byte lands in exactly one section, so this table is exhaustive by
construction, not by inspection.

**There is no custom section in the shipped module** — no `name`, no DWARF, no producers record.
`strip = "symbols"` has already taken everything a stripper could take; there is no free saving here.

**Two facts worth carrying forward.** Code is 82.66 % and data is 16.83 %; everything else together
is 0.51 %. And the data section is 143 567 bytes in a product that has not yet embedded a finder
index, a rule pack, an explainer corpus or a font — all four of which `44` §5.3 expects to arrive as
data.

### 3.2 The same module at the tip

| Section | `adbb590` | `adbd9a2` | Change |
|---|---:|---:|---:|
| code | 705 025 (82.66 %) | **764 243 (86.23 %)** | **+59 218** |
| data | 143 567 (16.83 %) | **117 479 (13.25 %)** | **−26 088** |
| everything else | 4 326 | 4 599 | +273 |
| **Total** | **852 918** | **886 321** | **+33 403** |

The two sections moved in opposite directions and the shape of the module changed with them: data
fell by a fifth as the dictionary left, and code rose by 8.4 % as the diagram arrived. **Code is now
86.23 % of the module.** Every remaining data-side saving in the tree is now 8 781 bytes
(`seed_concepts.yaml`) plus the 12 588 bytes of float lookup tables that §5.1 already counts — so
**there is no meaningful data lever left, and every future one is a code lever.** That is a change of
regime, not a change of number: the levers that worked in the first half of August do not work again.

### 3.3 Where the growth went, and the fact that should decide the gate

| | `adbb590` | `adbd9a2` | Change |
|---|---:|---:|---:|
| `alloc::collections::btree` | 136 031 | 136 495 | +464 |
| `core::slice::sort` | 82 184 | **107 027** | **+24 843** |
| **both, the shared machinery** | **218 215 (25.6 %)** | **243 522 (27.5 %)** | **+25 307** |

The module grew 33 403 net. Because the dictionary move gave 26 915 back over the same interval, the
**gross** growth was about 60 300 — and **25 307 of it, roughly 42 %, is B-tree and sort machinery
that no feature owns and no budget row can see.** Almost all of it is sort: the diagram sorts nodes,
edges, channels, layers and groups, and every distinct element type it sorts instantiates its own
copy of `core::slice::sort`.

This is the clearest evidence in the census for §11's gate proposal. A reviewer looking at the
diagram's diff would have seen `crates/fathom-layout/` at 15 987 bytes of its own compiled code and
concluded it was cheap. **It cost 60 096 (§6.4), and the difference is machinery the diff does not
contain.** No per-component budget of the shape `44` §5.2 specifies could have caught that, because
the bytes belong to no component.

---

## 4. The code section by crate

*margin tab: the same 704 563 bytes, sorted two ways*

### 4.1 By definition site — whose source line is this

This is the table `twiggy` would produce. Read it and then read §4.2, because on its own it is
misleading.

| Crate | Bytes | Funcs | Share of code | Share of module |
|---|---:|---:|---:|---:|
| alloc | 217 439 | 1 631 | 30.86 % | 25.49 % |
| core | 188 355 | 935 | 26.73 % | 22.08 % |
| fathom_ir | 55 253 | 204 | 7.84 % | 6.48 % |
| fathom_ingest | 53 252 | 47 | 7.56 % | 6.24 % |
| fathom_graph | 43 977 | 94 | 6.24 % | 5.16 % |
| fathom_inventory | 39 416 | 59 | 5.59 % | 4.62 % |
| fathom_corpus | 35 184 | 33 | 4.99 % | 4.13 % |
| fathom_wasm | 23 784 | 26 | 3.38 % | 2.79 % |
| fathom_schema | 14 037 | 21 | 1.99 % | 1.65 % |
| fathom_find | 12 973 | 15 | 1.84 % | 1.52 % |
| dlmalloc | 7 743 | 7 | 1.10 % | 0.91 % |
| fathom_weld | 7 604 | 8 | 1.08 % | 0.89 % |
| std | 2 183 | 15 | 0.31 % | 0.26 % |
| `__rust_*` shims | 1 340 | 14 | 0.19 % | 0.16 % |
| fathom_id | 1 316 | 5 | 0.19 % | 0.15 % |
| unmangled (`fathom_call`, `memcmp`, `__multi3`, …) | 707 | 7 | 0.10 % | 0.08 % |

**`alloc` + `core` = 405 794 bytes, 57.6 % of the code section.** Taken literally this says the
standard library is the product's largest dependency, which is both true and useless: there is no
`alloc` to delete.

### 4.2 By instantiation site — whose types made this copy exist

Same 704 563 bytes. A generic function whose *definition* is in `alloc` but whose *generic arguments*
name a first-party crate exists only because that crate asked for it, and v0 mangling records exactly
that. The attribution rule, stated once so it can be argued with: **if the definition crate is
`core`/`alloc`/`std`/`compiler_builtins`/`dlmalloc` and any other crate appears in the symbol, the
first such crate gets the bytes.**

| Crate | Bytes | Funcs | Share of code | Share of module |
|---|---:|---:|---:|---:|
| fathom_corpus | 129 174 | 610 | 18.33 % | 15.14 % |
| fathom_ingest | 116 771 | 495 | 16.57 % | 13.69 % |
| fathom_graph | 107 128 | 479 | 15.20 % | 12.56 % |
| fathom_ir | 88 605 | 481 | 12.58 % | 10.39 % |
| core | 64 752 | 196 | 9.19 % | 7.59 % |
| fathom_find | 58 614 | 321 | 8.32 % | 6.87 % |
| fathom_inventory | 45 168 | 103 | 6.41 % | 5.30 % |
| fathom_wasm | 28 777 | 80 | 4.08 % | 3.37 % |
| fathom_schema | 27 164 | 155 | 3.86 % | 3.18 % |
| alloc | 10 470 | 77 | 1.49 % | 1.23 % |
| fathom_weld | 8 877 | 19 | 1.26 % | 1.04 % |
| dlmalloc | 7 743 | 7 | 1.10 % | 0.91 % |
| fathom_id | 7 681 | 58 | 1.09 % | 0.90 % |
| fathom_canon | 867 | 10 | 0.12 % | 0.10 % |

**The 405 794 bytes of `alloc` + `core` become 75 222.** The other **330 572** move to the eight
first-party crates that instantiated them — and the ranking inverts: `fathom_corpus`, fourteenth by
source size, is first by bytes.

Note the function counts. `fathom_corpus` has **33** functions of its own and **610** attributed to
it; `fathom_ingest` has 47 and 495. **The product is not made of the code anybody wrote. It is made
of the generic code that code instantiates,** at a ratio of roughly eighteen to one.

### 4.3 Where the generic bytes actually are

Grouped by module rather than by crate, the top of the list is unambiguous:

| Module | Bytes | Funcs | Share of module |
|---|---:|---:|---:|
| `alloc::collections::btree` | 136 031 | 840 | **15.95 %** |
| `core::slice::sort` | 82 184 | 278 | **9.64 %** |
| `core::iter::adapters` | 18 947 | 98 | 2.22 % |
| `alloc::vec::Vec` | 18 766 | 209 | 2.20 % |
| `core::num::flt2dec` | 16 468 | 7 | 1.93 % |
| `fathom_ir::generated::accessors` | 16 348 | 1 | 1.92 % |
| `fathom_ir::bag::typed` | 15 412 | 87 | 1.81 % |
| `alloc::vec::spec_from_iter_nested` | 8 894 | 52 | 1.04 % |
| `dlmalloc::Dlmalloc<A>` | 7 646 | 6 | 0.90 % |
| `core::num::dec2flt` | 6 294 | 7 | 0.74 % |
| `core::fmt::num` | 6 122 | 24 | 0.72 % |
| `core::ptr::drop_in_place` | 4 298 | 132 | 0.50 % |

**`alloc::collections::btree` plus `core::slice::sort` is 218 215 bytes — 25.6 % of the entire
module, in 1 118 functions.** (At the tip it is **243 522**, 27.5 % — §3.3.)

### 4.4 What this is the price of, stated carefully

This block is the cost of *deterministic ordered collections, instantiated per type*. It is worth
being exact about where that discipline comes from, because the wrong attribution turns a
re-engineerable implementation choice into an untouchable law.

**It is not invariant 9.** Invariant 9 (`.context/conventions.md`) is *"Determinism where it is
observable"* — same workspace + corpus version + rule-pack version set + build ⇒ byte-identical
emitted config, findings and finder ranking. It says nothing about collections, and
`.context/conventions.md` contains no occurrence of the string "BTree" at all (`grep -c`, 2026-08-15,
returns 0).

**The nearest real source is `41` §2.1**, the five-stack language matrix, whose *"Determinism control
(invariant 9)"* row rates Rust *"**good**: `BTreeMap`, no floats in the schema, explicit sort,
`#[deny]` lints"*. That is an argument for choosing Rust, not a binding rule, and no document in this
tree states a "BTree-only rule" as one. (That same cell also says *"no floats in the schema"*, which
is the correct citation for §5.1's finding.)

The distinction is load-bearing and it is why this section was rewritten. An invariant is not
negotiable. An implementation technique adopted in service of an invariant is: `BTreeMap<K, V>` is
one way to get deterministic iteration order, and a sorted `Vec<(K, V)>` behind one non-generic
lookup helper is another that instantiates once instead of fifty times. **Determinism is the
requirement; fifty monomorphised B-trees are an implementation of it, and 243 522 bytes is what that
implementation costs.** Nothing here proposes changing either — it proposes that the choice be
visible, which it currently is not.

The mechanism is simply that the rule applies per *type* and Rust charges per type. Roughly fifty
distinct key/value pairs across the graph, the ledger, the index, the layout and the dictionary
produce that many instantiations of a B-tree implementation that is not small, plus 278 copies of a
sort (375 at the tip).

**Nobody chose this and nobody was told.** It is the largest single fact in the census and it is
absent from `44` §5.2's component table, which has no row for it and no row it could hide in.

---

## 5. The largest single contributors

*margin tab: the top twelve functions are 15 % of the module*

| Bytes | Function | Note |
|---:|---|---|
| 17 123 | `fathom_ingest::dict::Dictionary::from_sources` | Builds the statement dictionary from six YAML sources and runs WO-03 §4.7's gates |
| 16 961 | `fathom_ingest::ingest` | The whole paste path, inlined into one body by `lto = "fat"` |
| 16 348 | `fathom_ir::generated::accessors::body::slot_type` | **One generated function.** The 299-arm field-key → type-name dispatch |
| 15 569 | `fathom_wasm::shell::Shell::handle` | Ten opcode arms, each inlined |
| 14 911 | `fathom_inventory::render::render_set::<Node>` | The hand-written per-kind render table |
| 13 597 | `fathom_corpus::load::load_corpus_sources` | |
| 6 675 | `fathom_corpus::index::build_index` | |
| 6 587 | `fathom_corpus::concepts::build_concept_table` | |
| 6 291 | `core::num::flt2dec::strategy::dragon::format_shortest` | **Float formatting.** See §5.1 |
| 5 284 | `core::num::flt2dec::strategy::dragon::format_exact` | " |
| 5 185 | `fathom_weld::apply::apply_new_device` | |
| 5 102 | `dlmalloc::Dlmalloc<A>::malloc` | The allocator |
| 4 923 | `Map<Filter<btree::Range<NodeId, Node>>>::next` for `Graph::nodes_of_kind` in `inventory::rows` | One iterator chain, monomorphised |
| 4 648 | `fathom_ingest::dict::load_field` | |
| 4 483 | `fathom_inventory::demo::demo_estate` | The demo estate, compiled in |
| 4 209 | `alloc::str::to_lowercase` | Unicode case folding |
| 3 251 | `fathom_find::syntax::syntax_hits` | |
| 2 903 | `fathom_schema::subset::parse_profile` | |

### 5.1 The float finding — 44 690 bytes, and the IR contains no floats

`core::num::flt2dec` (16 468) and `core::num::dec2flt` (6 294) are Rust's float **formatting** and
**parsing** implementations. `fathom-canon`'s own header states the position: *"Floats are structurally
excluded from the IR (`11` §14.1, `12` §3.4)"*, and `Json::parse_canonical` refuses every float it sees.

Two lines put them in the module, both in the YAML subset parser:

| Site | What it does | Measured cost, by removal |
|---|---|---:|
| `crates/fathom-schema/src/subset.rs:545` — `s.parse::<f64>()` | Tries every scalar as a float | **18 946 bytes** (6 346 code + 12 588 static tables + 12 header) |
| `crates/fathom-schema/src/value.rs:82` — `Value::Float(f) => f.to_string()` | Renders one back | **25 740 bytes** |
| **Both** | | **44 690 bytes — 5.24 % of the module** |

**Re-measured at the tip four days later: 44 825, within 135 bytes** (§6.4). Two ablations, two
commits, 33 403 bytes of intervening change, the same answer.

For scale: **that is more than the entire approved crypto stack costs (36 590), and more than three
times the headroom the module has left.** The reason the two lines exist is honest and recorded in
`value.rs`'s own comment: the shipped tree carries the residue-guard constants `0.75` and `0.15`
(`11` §10.4), and `62` §2.2's table lists integer spellings only, so the parser accepts a float
rather than refusing a file it must read. The bug is not the acceptance; it is that accepting it
costs 44 825 bytes when the two values in question are fixed-point constants that the codebase
already knows how to carry — `fathom_corpus` uses `icf_milli` and `fathom_find` uses `score_milli`
for exactly this. **Changing it is not free of decisions** — it goes through `62`'s grammar and
touches `fathom-canon`'s byte contract; §11.2 states what it costs and what it touches.

**Method note.** These are total-module deltas from four builds; the removed code was confirmed
function-by-function by diffing the two `name` sections. Removing the parse deleted precisely seven
functions (all of `core::num::dec2flt`) totalling 6 280 code bytes — the other 12 666 came out of the
**data** section, which is `dec2flt`'s power-of-five lookup tables. **A static table is invisible in
any code-size tool and this is why §7 exists.**

### 5.2 The demo estate

`fathom_inventory::demo` is 4 483 + 4 388 = **8 871 bytes** of code and reaches into the data section
for its literals. Removing `OP_ESTATE_DEMO` removes **35 195 bytes** (§6.2), re-measured at the tip
as **35 178** (§6.4) — the same number four days and 33 403 bytes later. It is a development fixture
in a shipped artifact; nothing in this census decides whether it should ship, but nothing in the tree
records that it costs 4 % of the module either. **It is now one of only two free levers left**, and
§11.2 puts the question to the owner in one sentence.

---

## 6. Cost by removal

*margin tab: the only number a byte decision can use*

### 6.1 Method, and its one honest limitation

Each row deletes one opcode arm from `Shell::handle` by prefixing it `#[cfg(any())]`, rebuilds under
the shipped profile, and reports the difference. `lto = "fat"` over a `cdylib` whose only roots are
`fathom_alloc`, `fathom_call` and `fathom_free` then dead-code-eliminates everything the arm reached
and nothing else reaches. The tree is restored from a byte copy after every build.

**A marginal cost is not a share.** If two features both drag in `BTreeMap<NodeId, Node>`, removing
either removes nothing and removing both removes 40 KB. Marginal costs therefore **do not sum**, and
the gap between their sum and the whole is itself a measurement — §6.3.

### 6.2 One opcode at a time

Baseline **852 918**. Floor with all ten arms removed: **44 425** — the shell, the protocol codec,
the allocator and the panic machinery, and nothing else.

| Removed | Module | Marginal cost | % of module |
|---|---:|---:|---:|
| `OP_PASTE` — ingest + weld | 606 145 | **246 773** | 28.9 % |
| `OP_INIT` — corpus load + index + concepts | 737 276 | **115 642** | 13.6 % |
| `OP_QUERY` — the finder | 785 381 | **67 537** | 7.9 % |
| `OP_ESTATE_DEMO` — the demo fixture | 817 723 | **35 195** | 4.1 % |
| `OP_INV_ROWS` | 841 146 | 11 772 | 1.4 % |
| `OP_EQUIPMENT` | 842 546 | 10 372 | 1.2 % |
| `OP_EQUIP_ADD` | 844 488 | 8 430 | 1.0 % |
| `OP_ELEMENT_REMOVE` | 845 671 | 7 247 | 0.8 % |
| `OP_FIELD_SET` | 850 634 | 2 284 | 0.3 % |
| `OP_ELEMENT` | 851 208 | 1 710 | 0.2 % |
| *(sum of marginals)* | | *506 962* | |

### 6.3 By stack — and the 301 531 bytes nobody owns

| Removed | Module | Marginal cost | Sum of its parts | Shared between them |
|---|---:|---:|---:|---:|
| `OP_INIT` + `OP_QUERY` (finder stack) | 626 324 | **226 594** | 183 179 | 43 415 |
| `OP_PASTE` + the four write opcodes + demo (write path) | 488 597 | **364 321** | 299 929 | 64 392 |
| The seven inventory-face opcodes | 762 526 | **90 392** | 77 010 | 13 382 |
| **All ten (the floor)** | **44 425** | **808 493** | 506 962 | **301 531** |

**301 531 bytes — 35 % of the module — belong to no feature.** They are the generic machinery two or
more features share: the B-trees of §4.3, the sorts, the iterator adapters, the `Vec` growth paths.
No feature can be cut to reclaim them and no per-feature budget can see them.

This is the measured answer to `44` §5.2's own warning that a total-only gate is insufficient. The
warning is right, and the remedy it proposes — per-component budgets — **cannot be met by any
mechanism the section describes**, because 35 % of the module has no component to belong to. §11
proposes what to do instead.

### 6.4 The same method at the tip — the numbers §11 spends

Re-run at `adbd9a2`, same method, tree restored from a byte copy after every build. Baseline
**886 321**.

| Experiment | The edit | Module | Marginal cost |
|---|---|---:|---:|
| Float parse removed | drop the `is_simple_float` branch at `subset.rs:545` | 867 205 | −19 116 |
| Float render removed | `value.rs:82` renders a constant | 860 624 | −25 697 |
| **Both float sites removed** | both of the above | **841 496** | **−44 825** |
| **`OP_ESTATE_DEMO` removed** | `#[cfg(any())]` on the arm | **851 143** | **−35 178** |
| **`OP_DIAGRAM` removed** | `#[cfg(any())]` on the arm | **826 225** | **−60 096** |
| Diagram + demo removed | both arms | 791 028 | −95 293 |
| **Floats + demo removed together** | the two free levers of §11 | **806 314** | **−80 007** |

**Two of these reproduce the analysis build's ablations on a tree 33 403 bytes larger**, which is the
strongest internal check the census has:

| | `adbb590` | `adbd9a2` | Agreement |
|---|---:|---:|---|
| Float machinery | 44 690 | 44 825 | within **135 bytes**, 0.30 % |
| Demo estate | 35 195 | 35 178 | within **17 bytes**, 0.05 % |

Both were measured four days apart, at different totals, against different neighbouring code. They
are the same numbers. **§11's two free levers are real to within a few hundred bytes.**

**And they add up, which was not guaranteed.** §6.1 warns that marginal costs do not sum. Here they
do: floats and the demo measured together at **80 007** against a sum of marginals of 80 003 — they
share four bytes, i.e. nothing. Same for diagram + demo: 95 293 measured against 95 274 summed. This
is not a contradiction of §6.1 but a demonstration of what it means — features that share *machinery*
(the finder stack shared 43 415) behave very differently from features that share *nothing*, and
which case you are in has to be measured rather than assumed either way.

---

## 7. The data section

*margin tab: 143 567 bytes, and half of them are text nobody counted*

### 7.1 Composition

Two segments, 143 544 bytes of initialiser payload (99.98 %; the rest is offsets and lengths).
**81 996 bytes — 57.1 % — is printable text**, in 551 runs of eight characters or more; 49 runs of
128 bytes or more account for 64 278 of it.

### 7.2 What is embedded, measured by blanking it

| Embedded source | On disk | Module shrinks by | Site |
|---|---:|---:|---|
| `corpus/dict/junos-srx/*.yaml` (6 files) | 19 183 | **19 184** | `fathom-ingest/src/dict.rs:80` `EMBEDDED_DICT_SOURCES` |
| — same, plus the `&[(&str,&str)]` table itself | | **19 384** | " |
| `schema/field-keys.yaml` | 10 487 | **10 494** | `fathom-ingest/src/dict.rs:110` |
| `crates/fathom-corpus/src/seed_concepts.yaml` | 8 781 | **8 782** | `fathom-corpus/src/concepts.rs:18` |
| **Total embedded YAML** | **38 451** | **38 460** | 26.8 % of the data section |

**Embedded text costs exactly its own size, to within nine bytes across three files.** That is worth
stating plainly because it is the one honest, linear, predictable line in the whole budget: a
kilobyte of corpus is a kilobyte of module. Nothing else here behaves that way.

It also settled the dictionary-move claim independently, before that change landed. Moving the
dictionary out over `OP_DICT` buys **19 184–19 384 bytes** *of data*; the 26 915 that change reports
additionally includes the parse-and-gate code that becomes unreachable when `Dictionary::embedded()`
is deleted. Both numbers are right about different things and neither should be quoted without saying
which.

**Confirmed after the fact.** The move landed at `adbd9a2` and the data section fell **143 567 →
117 479, −26 088**, against the 29 670 bytes of YAML (dictionary 19 183 + field-keys 10 487) that
left. Predicted from this table: 19 184 + 10 494 = **29 678 of data**. The 3 590-byte difference is
the data the diagram brought in over the same interval, which this table could not have known about.

**What is left.** After the move, **one `include_str!` of YAML remains in the entire workspace** —
`crates/fathom-corpus/src/seed_concepts.yaml`, 8 781 bytes, priced above at 8 782 by removal. The
38 460-byte data lever is down to 8 782, and there is no third file.

### 7.3 The other 105 107 bytes

`143 567 − 38 460 = 105 107`, of which **12 588 is `core::num::dec2flt`'s power-of-five tables**
(§5.1), leaving 92 519 in string literals and static tables. The longest runs name themselves:

| Bytes | Run begins | What it is |
|---:|---|---|
| 6 341 | `Site.nameSite.codeSite.addressSite.timezone…` | The 299-entry `FIELD_KEYS` name table |
| 5 917 | `unsetSite.codeSite.addressSite.criticality…` | A **second copy** of the same identifiers |
| 4 170 | `activepassiveoffSiteDeviceChassis…` | Kind names and enum variant names |
| 1 470 | `HasDeviceHasChassisHasRedundancyGroup…` | The 89 edge-kind names |
| 1 401 | `Quarantinedorig_lenPskCertKeySnmpCommunity…` | Edge names again, behind other literals |
| 956 | `'&-/HasDeviceHasChassis…` | Edge names, a third time |
| 518 | `SiteDeviceChassisRedundancyGroup…` | Kind names again |
| 518 | `SiteDeviceChassisRedundancyGroup…` | And again |
| 4 170 | literals matching `crate::…` | Rust **type names as strings**, emitted by the generated `slot_to` arms |
| 3 964 | literals matching `*.rs` | Source paths in panic locations |

**The generated schema identifier tables appear in the data section between two and five times each.**
The linker deduplicates *identical* literals; it cannot merge a 6 341-byte concatenation against a
5 917-byte one that overlaps it. Conservatively the repetition is **8–12 KB**; establishing the exact
figure needs a segment-offset-level analysis this census did not do. <!-- VERIFY: extend
scripts/byte-census.rs to resolve each data segment's relocations back to the symbol that references
it, and report the exact duplicated-literal total. Until then 8–12 KB is bounded, not measured. -->

---

## 8. The generated layer

*margin tab: the suspicion, and the answer*

The commissioning brief recorded a suspicion — *"a prior measurement put `Graph::from_snapshot` alone
at 110 256 bytes and the 299-arm `slot_from_canon` at +107 857, so the generated layer is suspected to
dominate. Confirm or refute."*

### 8.1 Refuted as stated, for the module that ships

**`Graph::from_snapshot` and `slot_from_canon` are not in the shipped module.** A search of all
3 121 named functions returns zero matches for either. The figures describe code that would *arrive
with persistence*, not code that is there.

**Why they are absent, stated correctly.** Not because their crates are absent — they are not.
`Graph::from_snapshot` is defined at `crates/fathom-graph/src/snap.rs:343` and `slot_from_canon` at
`crates/fathom-ir/src/generated/accessors.rs:2065`, and **`fathom-graph` and `fathom-ir` are both
direct dependencies of `fathom-wasm`**. They are absent because **nothing reachable calls them** and
`lto = "fat"` over a `cdylib` with three roots eliminates what nothing reaches. `fathom-workspace` —
the crate that *would* call them — is indeed not a dependency (`crates/fathom-wasm/Cargo.toml`), and
that is why nothing reaches them; but the mechanism is dead-code elimination, not crate absence.
The distinction matters to anyone reasoning about what adding a dependency drags in: **linking a
crate costs nothing on its own; reaching into it is what costs**, which is exactly what §8.2 then
measures and what §9.3 measures again for `fathom-emit`.

What is there:

| | Bytes | Funcs | Share of module |
|---|---:|---:|---:|
| `fathom_ir::generated::*` (accessors + ir_types) | **71 425** | 312 | **8.4 %** |
| of which `accessors::body::slot_type`, one function | 16 348 | 1 | 1.92 % |
| of which `generated::ir_types` | 8 943 | 48 | 1.05 % |
| `fathom_ir` as a whole, by instantiation site | 88 605 | 481 | 10.39 % |

**The generated layer does not dominate.** At 8.4 % it is the sixth-largest identifiable block, well
behind `alloc::collections::btree` (15.95 %) and `core::slice::sort` (9.64 %).

### 8.2 Confirmed as an amplifier, and the shape is right

Where the suspicion is correct is in what the generated layer *does to everything downstream*.
Measured by linking it in:

| Experiment | Module | Delta | Generated code in that build |
|---|---:|---:|---:|
| Baseline | 852 918 | — | 71 425 (312 funcs) |
| Reach `slot_from_canon` from one opcode | 955 967 | **+103 049** | — |
| Persistence load path (`read_plain`) | 1 024 999 | **+172 081** | **124 167 (590 funcs)** |

Reaching one generated function costs **103 049 bytes** — because each of its 299 arms instantiates
`canon::slot_from::<T>` for a distinct scalar type, and each of those drags its own parse, its own
`Box<dyn Any>` construction and its own drop glue. **The route document's recorded +107 857 for this
is confirmed to within 4 808 bytes (4.5 %)** and its conclusion — *route A is refused* — stands.

Of the persistence load path's 172 081 bytes, **52 742 (31 %) is newly-generated code**. The
generated layer is not the largest thing in the module; it is the largest *multiplier* on anything
that touches every field.

**Corrected figures, stated once so they are not quoted wrongly again:** as *self-size*,
`Graph::from_snapshot` is **6 339 bytes**, not 110 256, and `slot_from_canon` is **11 970 bytes**, not
107 857 — 17× and 9× smaller than the circulating numbers. As *marginal reachability cost*, 103 049
for `slot_from_canon` is right. Both quantities are legitimate; **quoting one and meaning the other
is how a plan gets built on a number that is off by an order of magnitude.**

---

## 9. What persistence and cryptography cost

*margin tab: the decision this census was commissioned for*

### 9.1 Persistence, measured three ways

`fathom-workspace` added as a dependency of `fathom-wasm`, reached from new opcode arms; shipped
profile; tree restored afterwards.

| What is reachable | Module | Delta |
|---|---:|---:|
| `write_plain` only (save) | 945 954 | **+93 036** |
| `read_plain` only (load) | 1 024 999 | **+172 081** |
| Both | 1 088 808 | **+235 890** |

**The recorded +239 964 holds** — reproduced at 235 890, within 1.7 %, from a different call shape on
a different day. The route document's stage-5 conclusion is sound.

**What the recorded figure does not say, and should:** the two halves are not alike. **Load is 65 %
of the cost and save is 35 %**, and they share only 29 227 bytes. A build that can save and cannot
load is 93 036 bytes and is useless. A build that can save and load one *schema version* is the whole
235 890. This matters because it is the only decomposition that names the expensive half, and the
route that fits is the one that never pays it.

**Superseded as a route, and it is worth saying why the measurement still matters.** The route
document's §5b now carries a *journal* route — save the operator's ops and replay them, rather than
saving the expanded model — measured at **+263 bytes**. That route is better and this census does not
argue with it. What the census contributes is the reason it is better, in numbers: **65 % of snapshot
persistence is the load side, and the load side is nothing but re-typing.** A journal never re-types,
so it never pays the 172 081. Any future proposal to save the expanded model has to answer that
figure, and now there is one to answer.

### 9.2 Cryptography, against the headroom that actually exists

| | Bytes |
|---|---:|
| Ceiling (`44` §5.2) | 900 000 |
| Module at the tip, measured 2026-08-15 | 886 321 |
| **Headroom** | **13 679** |
| Approved crypto stack, Argon2id + ChaCha20-Poly1305, as recorded | 36 590 |
| **Shortfall** | **−22 911** |
| Free levers available (§6.4: floats 44 825 + demo 35 178, measured together) | 80 007 |
| **Headroom if both are taken** | **93 686** |

**The framing that has been in circulation — "encryption is what does not fit" — was wrong twice, in
opposite directions, and both corrections matter.**

It was wrong when headroom was 47 082, because crypto missed by only 7 567 bytes while *snapshot
persistence* missed by 206 867 more; pricing crypto alone optimised the smaller problem. It is wrong
again now, because §5b found a persistence route costing +263 — so persistence is solved — while
crypto's shortfall grew from 7 567 to **22 911** as the diagram consumed the headroom. **Crypto is
now the binding constraint, and it was not when it was last discussed.**

**One live figure in the route document is stale and its sign has flipped.** §5b measured the journal
opcode plus Argon2id plus ChaCha20-Poly1305 as one build at **889 723 — "10,277 to spare"**. That was
measured against a 852 918-byte module (its own table's +235 926 snapshot row confirms the base), so
the delta it measured was **+36 805**. Carried onto 886 321 the same work lands near **923 100, some
23 000 over the ceiling.** That last step is arithmetic across two trees rather than a measurement,
and §6.1 is explicit that marginal costs do not transfer between trees — it is stated here only to
show that the margin that decision rests on has been spent by features that landed after it was
measured. **Re-measure 5b as one build before relying on it.** It remains true that the crypto path
adds **no wasm import**, which is a security property worth more than the bytes.

The 36 590 figure is carried as recorded; it is not reproduced by this census, and it cannot be:
`Cargo.lock` holds **zero external packages** at the tip, so there is nothing vendored to measure.
<!-- VERIFY: 36 590 for Argon2id + ChaCha20-Poly1305 is recorded in 00-ROUTE-TO-WORKABLE.md §2 stage 5
and implied by §5b's 889 723. The two approval records that now exist — deps/decisions/argon2.md and
deps/decisions/chacha20poly1305.md, both dated 2026-08-15 — carry no byte figure at all, and
Cargo.lock has no external package, so nothing in the tree can be built to check it. Re-measure
against the vendored implementation the day it lands and put the number in the approval record, which
is where ADR-0032 §5 would have it live. -->

### 9.3 The config view does not fit — the first feature refused on bytes

`fathom-emit` exists, is complete for `junos-srx`, is tested, and is a dependency of nothing. Linking
it into `fathom-wasm` and reaching `emit()` and `render_config()` from one opcode arm, by the same
method §9.1 used for `fathom-workspace`:

| | Module | Delta |
|---|---:|---:|
| Baseline at the tip | 886 321 | — |
| **`fathom-emit` linked and reached** | **980 159** | **+93 838** |
| The same, with §11's two free levers also taken | **900 156** | **+13 835 net** |

**The config view does not fit, by roughly seven times the remaining headroom.** And the second row
is the one that settles it: **with the float machinery removed and the demo estate removed — every
free byte this census found, spent — the module with an emitter in it is 900 156, which is 156 bytes
over the ceiling.** Not close enough to argue about, and not far enough to be comfortable: it is a
feature that misses by the width of a comment.

**This is the first time a specified feature has been priced out of this product**, and the fact is
worth more than the number. Every previous byte conversation was about a feature that had not been
written. This one is written, it works, it has tests, and it cannot ship in the same module as the
diagram unless something else leaves.

**Three independent measurements agree, and one of them is not this session's.** The session that
first linked the emitter measured 852 918 → 963 238, **+110 320**, for a whole config *view* — the
emitter plus the protocol encoding and the page-facing surface a view needs. Its reviewer
reconstructed a discarded intermediate spike at 945 545, i.e. **+92 627 for the emitter alone**. This
census measures **+93 838** for the emitter alone, at a different base, four days later. **The
emitter is ~93 000; the view around it is another ~17 000.** Both figures are correct and they are
not the same quantity — the distinction failure mode 3 exists to protect.

For scale against `44` §5.2's own table: the row reading *"Rule engine + emitters — 120 KB"* is at
zero because neither is built. **Half of it now has a price, and that half alone is 93 838** — 78 % of
a budget that also has to hold a rule engine.

## 10. Recorded figures — which hold, which are wrong

*margin tab: what was corrected in place, and where*

### 10.1 Verdicts

| Recorded | Where | Verdict |
|---|---|---|
| 900 000-byte ceiling | `44` §5.2, gated in `crates/fathom-wasm/tests/artifact_gates.rs:97` | **Holds** as a gate. As a *budget* the section behind it does not — §10.2 |
| Persistence +239 964 | `70` §—, `00-ROUTE-TO-WORKABLE.md` §2/§5/Failure modes, `CLAUDE.md` | **Holds.** Reproduced at 235 890 |
| `slot_from_canon` route A +107 857 | `00-ROUTE-TO-WORKABLE.md` §2 stage 6 | **Holds** as a marginal cost. Reproduced at 103 049. Its *self-size* is 11 970 |
| Create-and-edit route B +5 677 | `00-ROUTE-TO-WORKABLE.md` §2 stage 6 | **Consistent.** Not independently re-measured; the four write opcodes it became now cost 8 430 + 2 284 + 7 247 = 17 961 marginally |
| `Graph::from_snapshot` 110 256 | commissioning brief | **Wrong as a function size** — it is 6 339, and it is not in the shipped module at all |
| Headroom 72 971 (module 827 029) | `00-ROUTE-TO-WORKABLE.md` §2/§5, `CLAUDE.md` | **Stale twice over.** 852 918 / 47 082 at `adbb590`; **886 321 / 13 679 at `adbd9a2`**, both 2026-08-15 |
| `44` §5.2's seven-row component table, target ≤ 700 KB | `44` §5.2 | **Wrong in structure, not only in value** — §10.2 |
| `44` §5.3's "WASM core 700 KB → 933 KB in the file" | `44` §5.3 | **Wrong.** 886 321 base64s to 1 181 764; the artifact is 1 399 960 |
| `44` §5.3's 150 KB for shell + CSS + JS | `44` §5.3 | **Over, unremarked.** The built page is 177 950 bytes, over by 27 950, and nothing gates it |
| `44` §5.5's `xtask size-gate` with per-component ceilings | `44` §5.5 | **Does not exist.** There is no `xtask`; the gate is one total-only assertion, exactly the shape §5.2 warns against |
| `47` §4.3's *"BTreeMap/BTreeSet and sorted Vec only"*, attributed to invariant 9 | this document, first draft | **Invented, and withdrawn.** No such rule exists in `.context/conventions.md`, which contains no occurrence of "BTree"; invariant 9 is about determinism of emitted output. The 218 215-byte measurement it was attached to is correct. §4.4 carries the real source, `41` §2.1 |
| §5b's *"889 723 — 10,277 to spare"* for journal + crypto | `00-ROUTE-TO-WORKABLE.md` §5b | **Stale, sign probably flipped.** Measured against 852 918; the same +36 805 lands near 923 100 at the tip. Re-measure as one build (§9.2) |
| Config view / `fathom-emit` +110 320 | the session that measured it | **Holds, and it is not the emitter alone.** The emitter alone is **93 838** here and 92 627 by that session's reviewer; the remaining ~17 000 is the view around it (§9.3) |

### 10.2 `44` §5.2 measured against its own rows

**Units.** Every budget in `44` §5.2 is written "KB" and every figure below reads that as **1 000
bytes**, which is the convention the gate itself uses: `crates/fathom-wasm/tests/artifact_gates.rs:94`
comments *"44 §5.2's hard ceiling, KB read as 1 000 bytes"* above `size <= 900_000` at line 97.
**Overages are therefore stated in bytes, not in KB**, so that no row can be read in KiB while the
total is read in KB. An earlier draft of this table stated three of its four overages in KiB while
its total was in KB; every one of them understated the breach, which is precisely the direction an
error in a budget document must not go.

| §5.2 row | Budget | Measured at `adbd9a2` | Verdict |
|---|---:|---:|---|
| Graph, ops, CRDT | 90 000 | 119 564 (`fathom_graph`, by instantiation) | **Over by 29 564**, with no CRDT written |
| Parsers + dictionary | 140 000 | 143 652 (`fathom_ingest` 116 488 + `fathom_schema` 27 164; dict data now 0) | Over by 3 652 — **the dictionary move nearly rescued this row** |
| Rule engine + emitters | 120 000 | 0 built. Emitters priced at **93 838** when linked (§9.3) | Not built, and the half that exists does not fit |
| Finder | 60 000 | 187 788 (`fathom_find` 58 614 + `fathom_corpus` 129 174) | **Over by 127 788** — the corpus index was never a row |
| Crypto stack | 180 000 | 0 | Not built |
| CBOR codec + packed writers | 40 000 | **867** (`fathom_canon`; the project chose canonical JSON, not CBOR) | Row describes a decision that changed. **Not zero** |
| `core::fmt`, panic strings, misc | 70 000 | 86 441 (`core` 65 896 + `alloc` 10 737 + `dlmalloc` 7 743 + `std` 725 + shims 1 340) | Over by 16 441 |
| **Total** | **≤ 700 000** | **886 321** | **Over by 186 321, with two of seven rows at zero** |

Two rows are at zero — rule engine and crypto — and both are unbuilt work. The CBOR row is **867
bytes, not zero**; it is a row whose decision changed under it, which is a different fact and needs a
different remedy. Saying "three of seven at zero" merges the two and hides the one row that is
telling the table something about itself.

**Rows the table does not have, and needs:** the IR and its generated layer (89 241 by instantiation,
of which the generated layer is 71 425 — see §8.1, they are not the same number), the inventory face
(45 202), the diagram (39 803, new since 2026-08-15), the wasm shell and protocol (33 958), the weld
(8 877), IDs (7 681) — and above all the 301 531 bytes of §6.3 that belong to no row at all.

### 10.3 Corrections made in place by this session

| Document | Change |
|---|---|
| `44` §5.2 | Measurement block inserted, then rewritten at the tip: the 886 321 total, 13 679 of headroom, the per-row verdicts **stated in bytes** (an earlier draft mixed KB and KiB and understated three of four breaches), the corrected attribution of the shared-machinery cost, the corrected generated-layer figure, and the config-view refusal |
| `44` §5.3 | The WASM row corrected to the measured 886 321 / 1 181 764; a row added for the dictionary now travelling in the page (39 808); the artifact total corrected to 1 399 960 with its measured composition; **and a new row recording that the shell + CSS + JS budget of 150 KB is exceeded at 177 950 with nothing gating it** |
| `00-ROUTE-TO-WORKABLE.md` §1, §2 stage 5, §5, Failure modes | 827 029 / 72 971 → **886 321 / 13 679** with the date and commit; "91 % spent" → 98.5 %; the persistence figure annotated with its reproduction and save/load split; the `Graph::from_snapshot` 110 256 relabelled as a reachability cost, not a function size; the crypto bullet corrected from "fits today" to the measured shortfall; the stage-1 data lever corrected from 38 KB to 8 KB; and §5b's "10,277 to spare" flagged as measured against a smaller module |
| `47` itself | §4.4 **withdraws an invented citation** this document made — a "BTreeMap/BTreeSet and sorted Vec only" rule attributed to invariant 9, which `.context/conventions.md` does not contain — and replaces it with the real source, `41` §2.1. §8.1 corrects a causal claim: the two absent functions are absent by dead-code elimination, not because their crates are absent, since both crates *are* dependencies. §10.1 records both |

No number was changed without a measurement in this document behind it, and none was changed in a
document this session does not have cause to touch. **Where this document was itself wrong, the
correction is recorded in the same places as the corrections it made to others** — §4.4, §8.1, §10.1
and Failure modes 5 — rather than quietly edited away.

---

## 11. RECOMMENDATION — what to do about 13 679 bytes

*margin tab: the decision, in the owner's priority order*

This section is written to be read by someone who will never open a WebAssembly section header.
Every number in it is measured, and §6.4 says how each one was taken.

### 11.1 The position, in plain terms

The product ships as one file you open from disk. Inside that file is a compiled program — the
module — and the module has a hard size limit of **900 000 bytes** that fails the build when
crossed. As of 2026-08-15 the module is **886 321 bytes**. **There are 13 679 bytes left**, which is
about 1.5 % of the budget.

That is not a comfortable margin, and the reason it is not is worth stating without blame: **nothing
was overspent.** The features that consumed it are the features the product is for. The diagram — one
feature, landed this week — cost 60 096 bytes on its own. Aggregation cost 15 344. Moving the Juniper
dictionary out of the module gave 26 915 back, and the diagram spent it twice over in the same week.

Three things are already specified, already designed, and **do not fit in what is left**:

| Wanted | Costs | Fits in 13 679? |
|---|---:|---|
| Encryption of the saved workspace (Argon2id + ChaCha20-Poly1305) | 36 590 (recorded, not re-measured — §9.2) | **No.** Short by 22 911 |
| The config view — showing the operator the Junos lines the graph would produce | 93 838 for the emitter, ~110 000 for the whole view (§9.3) | **No.** Short by ~96 000 |
| The rule engine — findings — the largest unbuilt feature in the product | never measured; budgeted at 120 000 *together with* the emitter | **Almost certainly not** |

**Saving the operator's work is the one thing on this list that does fit**, and it fits easily: the
journal route in `00-ROUTE-TO-WORKABLE.md` §5b costs **+263 bytes**, because it saves what the
operator *did* and replays it, instead of saving the expanded model. This census independently
explains why that route is the right one: of the 235 890 bytes the save-the-model route costs, **65 %
is the loading half alone**, and the loading half is nothing but re-deriving the type of every field
of every kind — 299 of them — whether or not the file being opened contains any. A journal never does
that, so it never pays for it.

### 11.2 There are 80 007 free bytes, and they are the last free bytes

Two things in the module cost real space and buy nothing the product needs. Both were measured by
removal, twice, four days apart, on trees 33 403 bytes apart, and both reproduced (§6.4).

| | Bytes | What it is | What taking it costs |
|---|---:|---|---|
| **Float handling** | **44 825** | Two lines let the YAML reader parse and print decimal numbers. The graph has no decimal numbers *by design* — floats are structurally excluded from the IR — and the whole reason those two lines exist is two constants, `0.75` and `0.15` | The two constants become whole numbers of thousandths (750 and 150), which is what `fathom_corpus` and `fathom_find` already do internally. A small, contained change |
| **The demo estate** | **35 178** | A fixture estate compiled into the shipped product so a new user sees something before pasting anything | Either nothing, if it is a development fixture, or a real feature if it is how a new user gets started. **Only the owner can say which** |
| **Both, measured together** | **80 007** | | |

Taking both moves the module from 886 321 to **806 314**, leaving **93 686 bytes** of headroom —
nearly seven times what exists today.

**Two honest caveats, because neither lever is quite as free as it first looks.**

*The float change is not a no-decision change.* An earlier draft of this document called it one, and
an edit it made to the route document said it "needs no decision from anyone". Both were wrong, and
this is what it actually touches:

- **`schema/schema.yaml:2198–2199`** — `accept: 0.75` and `margin: 0.15`, under `matching:
  residue_guard:`. These are the two values, and they are the only two.
- **`62` §2.2's YAML-subset table**, whose Accepted column reads *"`true` / `false`, decimal integers,
  `null` spelled `null`"*. It lists no float spelling in either column — floats are accepted by the
  parser without being named by the grammar, which is itself worth fixing.
- **`fathom-canon`'s documented byte contract**, whose header states that the tree *"carries them in
  one place — `matching:`, the residue-guard constants (11 §10.4) — and `schema.json` transcribes
  every tree block so the bump checker (62 §16.4) can classify every diff."* Changing the spelling
  changes what the bump checker sees.
- **A live test at `crates/fathom-schema/src/subset.rs:847–848`** asserting that
  `match_threshold: 0.75` parses to `Value::Float(0.75)`. It must keep passing, or be changed
  deliberately and visibly.

Under CLAUDE.md rule 3 that is a change made *through* `62`'s grammar, with a schema version bump.
Perhaps a day's work and one small decision — not zero of either. The 44 825 bytes are still the
cheapest in the project by a wide margin.

*These are the last free bytes.* Everything else this census found is either a feature someone wants
or machinery that cannot be deleted without deleting a feature. After 80 007 there is no third lever
of this kind, and it does not come back.

### 11.3 The decision — and it is one decision, not five

**Spend the 80 007 on encryption, and refuse the config view for now.**

That is the owner's own priority order — security, then usability, then dynamic ability — applied to
the measurements rather than to intuition:

- **Encryption is security, and it is first.** It costs 36 590 of the 80 007 and leaves about 57 000.
  Saving costs 263 more. The two together are what turn this from a tool that forgets everything into
  a tool that keeps an operator's estate safely, which is the product's whole reason to exist.
- **The config view is dynamic ability, and it is third.** It is also the most expensive thing on the
  list, and it is the one that cannot be made to fit by any amount of tidying. **With every free byte
  already spent — floats out, demo out — the module with an emitter in it measures 900 156 bytes,
  which is 156 over the limit** (§9.3). Not close enough to argue about.

**This is the first time this project has had to refuse a feature on size**, and that deserves to be
said plainly rather than buried in a table. `fathom-emit` is written, it is tested, and it works. It
is not being refused because it is bad or because it is unfinished. It is being refused because the
product cannot hold it and the diagram and encryption in one module at one time — and of those
three, on the owner's stated ordering, it is the one that goes.

**What "refuse for now" must not mean.** It must not mean the crate is deleted, and it must not mean
the feature is quietly dropped from the specification. It means the config view waits for §11.4's
architectural answer, and `44` records that it is waiting and why. A refusal that is written down can
be revisited; one that is not becomes a feature everyone assumes is coming.

### 11.4 The question behind all of this, and the honest answer to it

Every option above buys tens of thousands of bytes once. The product's remaining specification —
four more views, the rule engine, five more platforms, correlation across pasted configs — will want
hundreds of thousands. **Arithmetic on what is already priced:**

    886 321   today
    − 80 007  both free levers taken
    + 36 590  encryption
    + 93 838  the emitter alone
    = 936 742  — over the 900 000 limit, before the rule engine
                and before four of the six views exist

So the real question is not *"which feature gives way this month"*. It is **"is one module the right
shape for this product?"** — and that is an architecture question, exactly as `44` §5.2 and the route
document both say. This census does not answer it and does not propose moving the ceiling. What it
can do is put three measured facts in front of whoever does.

**Fact 1 — the biggest single thing in the module belongs to no feature, and it grows with types,
not with code.** `alloc::collections::btree` plus `core::slice::sort` is **243 522 bytes, 27.5 % of
the module** (§3.3). It is what deterministic ordered collections cost in Rust: the same B-tree and
the same sorting routine are compiled afresh for every distinct kind of key and value, roughly fifty
times over. This is the only pool that gets *better* as the product grows, because a single shared
implementation would be paid for once instead of fifty times — and it is also the reason the diagram
cost 60 096 when its own source compiles to 15 987. **Before any ceiling is moved, someone should
spend a day measuring what one shared, non-generic map and sort would save.** That is a real
engineering project with real risk to determinism, it is not a tidy-up, and nobody has priced it.
It is the single highest-value unmeasured thing in this tree.

**Fact 2 — the file has plenty of room; the module does not.** The whole artifact is **1 399 960
bytes against a 4 500 000-byte ceiling — 31 % spent — while the module is 98.5 % spent.** The two
budgets were set together, from the same component estimate, and only one of them has turned out to
bind. The dictionary move already exploited this: 29 670 bytes of Juniper statements stopped being
compiled into the module and started travelling in the page, where there is room. **A second module,
base64'd into the same file and only started when the operator opens the config view, is the same
move applied to code instead of data** — and on `44` §5.1's own cost model it is better than it
sounds, because the largest single stage of boot is compiling the module, and a module that is only
compiled when it is opened is not paid for at boot at all. It also needs the gate to change shape, or
it is a way of passing the gate rather than a way of meeting it. `44` owns that call.

**Fact 3 — the 900 000 limit is a stand-in for three things, and none of the three has ever been
measured.** `44` §5.1 states the cost model exactly: bytes cost **transient boot memory** (about 3×
the payload), **boot time** (the module's compile step is stage 4, the largest in the sequence, and
was budgeted at 60 ms for a 700 KB module), and **distribution friction** (a file that goes through
email). The census measured none of these — it measured bytes. **Whoever decides the ceiling should
have those three numbers, not this one.** For calibration: `41` §2.6, which is where the language
choice is made falsifiable, names a different and far higher trigger — *"measured WASM module exceeds
~1.2 MB **compressed**"* — and at 886 321 bytes uncompressed, this module is nowhere near it.

**So the 900 000 figure is not a physical limit and is not the language tripwire.** It is a seven-row
component estimate totalling 700 000, written before any of the code existed, plus 200 000 of margin
whose derivation this census could not find recorded anywhere. And of those seven rows, §10.2
measures that **four are wrong against real code, two are unbuilt, and one describes a decision that
changed. Not one row has been measured and found right.** That does not make the ceiling wrong — a
ceiling nobody checks is worse than a ceiling derived from a bad estimate, which is `44` §5.1's own
argument for writing one down. It does mean the number carries no more authority than the estimate
under it, and the estimate has now been measured.

### 11.5 The gate — fix the instrument before fixing the number

`44` §5.2 says a total-only gate is insufficient, and it is right. §5.5 then specifies a
per-component gate that **has never existed** — no `xtask`, no `perf/size-baselines.toml`, one
assertion in `artifact_gates.rs`. And §6.3 measures that **35 % of the module belongs to no
component**, so the per-component gate as specified could never have been met even if someone had
built it.

**RECOMMENDATION — three things, in this order.** `44` owns whether to take them.

1. **A ratchet.** `perf/size-baselines.toml` with the total and a `reason` string, exactly as §5.5
   already describes. It is the one part of §5.5 that works regardless of components, it costs a line
   of TOML per growth, and it makes growth deliberate instead of discovered. **Land it before the next
   feature.** Had it existed a week ago, the diagram's 60 096 would have been a sentence in a pull
   request rather than a surprise in a census.
2. **A per-crate report, by instantiation site, posted and not gated.** §4.2's table is the report and
   `scripts/byte-census.sh` already produces it. Gating it would be a lie — 35 % is shared — but a
   reviewer who sees `fathom_graph 107 128 → 119 564` in a pull request asks the right question.
3. **One named row for the shared machinery, budgeted and watched.** B-tree plus sort is 243 522
   bytes and it grew 25 307 in one week — **42 % of everything the module gained** — while no diff
   anyone reviewed contained a line of it. It is the only number that predicts what the second
   platform, the rule engine and the remaining views will actually cost.

**And a fourth, smaller one:** put a gate on the page. `44` §5.3 budgets the HTML shell, CSS and JS
at 150 KB together; measured, they are **177 950 bytes**. Nothing checks it, so nobody knew. It is not
urgent — the artifact has room — but a budget with no gate is how the module got here.

---

## Failure modes

1. **Someone quotes a total from this document against a different tree.** §1.1 exists for this and
   the hazard is now proven rather than theoretical: **three** totals are in circulation (827 029,
   852 918, 886 321) inside four days, and they span more than four times the remaining headroom.
   `44` §5.3 and `00-ROUTE-TO-WORKABLE.md` §1 both carried a stale one, and §5b's "10,277 to spare"
   still does (§9.2). **Re-run §2.4's script before quoting any total, including this one.**
2. **A marginal cost is read as a share.** §6.1 states it and §6.3 measures it: the marginals sum to
   506 962 against 808 493 attributable. Anyone who adds two rows of §6.2 together has over-counted.
   §6.4 shows the opposite case — two features that share nothing and do sum — so which case you are
   in is a measurement, never an assumption in either direction.
3. **A self-size is quoted where a reachability cost was meant, or the reverse.** This already
   happened twice: to `slot_from_canon` with a 9× error (§8.2), and to `fathom-emit`, where +110 320
   (a whole view) and +93 838 (the emitter alone) are both correct and are not the same quantity
   (§9.3). Every figure in this document is labelled as one or the other; keep the label when the
   figure travels.
4. **The instrument goes stale.** `scripts/byte-census.rs` parses the section layout the current
   toolchain emits. A toolchain bump, a `Cargo.toml` profile change, or a future non-empty import
   section will change its assumptions — two of which it asserts (`imported == 0`, every byte lands
   in a section) so it fails loudly rather than reporting a wrong number. It also carries a list of
   known crate names for attributing legacy-mangled symbols; **a crate added to the workspace and not
   added to `KNOWN_CRATES` reports as unattributed rather than wrong**, which is the right failure
   direction but still needs the one-line edit. `fathom_layout` was added on 2026-08-15 for exactly
   this reason.
5. **§11.2's float lever is taken as licence to delete `Value::Float`.** It is not. The parser must
   keep reading the files it reads today; what changes is the *representation*, and a test that
   `0.75` still parses is part of the change, not optional to it. Nor is it a no-decision change —
   §11.2 states what it touches in `62` §2.2 and in `fathom-canon`'s byte contract, and an earlier
   draft of this document was wrong to call it free of decisions.
6. **The 80 007 saving is spent before it is banked.** It is measured by ablation, not by a landed
   change. Nothing in this document is headroom until a build shows it, and §11.3 spends it on paper.
7. **§11's refusal of the config view is read as "the emitter was a mistake".** It is not, and the
   crate should not be deleted. `fathom-emit` is complete, tested and correct; it is refused *for this
   module, at this architecture*, and §11.4 is the question that would let it back in. A refusal
   recorded with its reason can be revisited; one that is not becomes a silent scope cut.

---

## Open decisions

1. **Does the demo estate ship?** (§11.2.) **35 178 bytes.** Owner-shaped, one sentence, and it is
   now one of only two free levers left in the project.
2. **Is the config view refused, and recorded as refused?** (§11.3.) This census recommends yes, on
   the owner's own priority ordering. **It is the first feature this project has had to refuse on
   size** and the refusal belongs in `44` in writing, not in a plan that quietly stops mentioning it.
3. **Is one module the right shape for this product?** (§11.4.) The real question, and the only one
   that changes the trajectory rather than the month. `44` §5.2 and `00-ROUTE-TO-WORKABLE.md` stage 1
   both already call this an architecture question; §11.4 supplies the three measurements it needs.
4. **Does `44` §5.2's component table get repaired or replaced?** This census recommends replaced
   (§11.5). `44` owns the answer.
5. **What exactly does the approved crypto stack cost?** 36 590 is carried, not reproduced, and it
   *cannot* be reproduced here: `Cargo.lock` holds zero external packages, so nothing is vendored to
   measure. `deps/decisions/argon2.md` and `deps/decisions/chacha20poly1305.md` (both 2026-08-15)
   carry no byte figure. Measure it the day the crates land and put the number in the approval record,
   which is where ADR-0032 §5 would have it live.
6. **Should `scripts/byte-census.sh` run in CI?** It is two extra release builds. The ratchet
   (§11.5 item 1) does not need it; the per-crate report does. Not decided here.
7. **What would one shared, non-generic map and sort save?** (§11.4 fact 1.) 243 522 bytes are in
   play, it is the only pool that improves as the product grows, and **nobody has measured it.** This
   census names it as the highest-value unmeasured question in the tree and does not answer it.

---

## Sources consulted

| Source | What was taken | When |
|---|---|---|
| `cargo build --release --locked -p fathom-wasm --target wasm32-unknown-unknown` at commit `adbb590` | Every total in §3, §6, §9 | 2026-08-15 |
| The same build with `CARGO_PROFILE_RELEASE_STRIP=none` and `-C symbol-mangling-version=v0` | Every per-function and per-crate figure in §4, §5, §8 | 2026-08-15 |
| `scripts/byte-census.rs` (new; first-party section, code and `name` reader) | The section table, both attributions, the module and function rankings | 2026-08-15 |
| 24 ablation builds at `adbb590`, each edit reverted from a byte copy | §5.1, §6.2, §6.3, §7.2, §8.2, §9.1 | 2026-08-15 |
| **9 further ablation builds at `adbd9a2`**, same method, tree restored and the restored baseline rebuilt to 886 321 to prove it | §6.4, §9.3 | 2026-08-15 |
| **`scripts/byte-census.sh` re-run at `adbd9a2`** | §3.2, §3.3, §10.2's measured column, the `fathom_layout` rows | 2026-08-15 |
| Data-segment text scan of the shipped module | §7.1, §7.3 | 2026-08-15 |
| `crates/fathom-wasm/tests/artifact_gates.rs:94, :97` | The gate's exact form: the comment *"44 §5.2's hard ceiling, KB read as 1 000 bytes"* above one total assertion, `size <= 900_000` | 2026-08-15 |
| `crates/fathom-wasm/Cargo.toml`, `crates/fathom-graph/src/snap.rs:343`, `crates/fathom-ir/src/generated/accessors.rs:2065` | §8.1's corrected causal account: both functions are defined in crates that *are* dependencies, and are absent by dead-code elimination |
| `.context/conventions.md` invariant 9, and `grep -c BTree` over it (= 0) | §4.4's withdrawal of an invented citation | 2026-08-15 |
| `docs/40-stack/41-technology-choices.md` §2.1 (the five-stack matrix), §2.6 (what would reopen the language choice), §3.10 (the component split) | §4.4's real source; §11.4's calibration against the 1.2 MB-compressed trigger | 2026-08-15 |
| `docs/40-stack/44-performance-budgets.md` §5.1 (the cost model behind the ceiling), §5.2, §5.3, §5.5 | §11.4 fact 3; the budget rows measured against in §10.2 | 2026-08-15 |
| `docs/70-ops/79-work-orders/00-ROUTE-TO-WORKABLE.md` §1, §2 stages 1/5/6, §5b, §5, Failure modes | The recorded figures verified in §10.1, and §5b's journal route | 2026-08-15 |
| `deps/decisions/00-INDEX.md`, `argon2.md`, `chacha20poly1305.md`, `00-CLOSURE.md`; `Cargo.lock` | That the crypto crates are approved but not vendored, so 36 590 cannot be reproduced here (§9.2) | 2026-08-15 |
| The commissioning brief, and the session that first linked `fathom-emit` | The 110 256 / 107 857 / 36 590 / 26 915 / 110 320 / 15 344 figures put to test | 2026-08-15 |

**Verification floor**, run at the end of this session on the tree as delivered, at commit `adbd9a2`
merged:

| Gate | Result |
|---|---|
| `cargo fmt --all --check` | no output |
| `cargo clippy --all-targets --locked -- -D warnings` | clean, exit 0 |
| `cargo test --workspace --locked` | **515 passed, 0 failed, 0 ignored** |
| `cargo run --locked -p fathom-schema --bin fathom-schema-check` | 48 kinds · 89 edges · 61 scalars · 10 enums · 14 files · **0 failures, 0 warnings**, exit 0 |
| `./scripts/gate-zero.sh` | **`gate-zero: OK  every external package in Cargo.lock has an approval record`.** It exists at this commit and it passes; no dependency was added by this session |
| `cargo run --locked -p fathom-artifact` | `target/artifact/fathom-dev.html · 1 399 960 bytes` |

**Nothing was looked up outside this repository.** Every claim here is arithmetic over a file that
was built, or a file that was read. ADR-0034's rule is about the outside world; it does not apply to
a binary on disk, and this document deliberately makes no claim about a vendor, a standard, a
browser or a cryptographic primitive. **The one place an earlier draft broke this was inward, not
outward:** it quoted a rule from `.context/conventions.md` that the file does not contain. §4.4
withdraws it and §10.1 records the withdrawal. That failure mode — inventing a citation to a document
in this tree — is not covered by "nothing was looked up outside", and the remedy is the same one
ADR-0034 prescribes: open the section, read it, and quote the words that are there.

The two figures carried from outside this census's own measurements are **36 590** for the crypto
stack, marked `VERIFY` in §9.2, and **15 344** for aggregation, attributed in §1.2 to the change that
measured it. Neither is restated as this document's own.

---

## Disagreements

1. **With `44` §5.2, on the shape of a size budget.** The section budgets seven components and
   nothing else, and §6.3 measures that **35 % of the module belongs to no component**. Per-component
   gating as specified is not merely unimplemented, it is unachievable. **Proposed replacement:**
   §11.5's three-part mechanism — a total ratchet that gates, a per-crate instantiation-site report
   that informs, and one explicit shared-machinery row that is budgeted and watched. `44` owns the
   change; this is raised, not made.

2. **With `44` §5.2, on which components exist.** Two of its seven rows are at zero (rule engine,
   crypto), a third describes a decision that changed (CBOR, measured at 867), and the largest real
   contributor — the shared B-tree/sort machinery at 243 522 — has no row and cannot be given one
   under the section's own scheme. A budget table whose largest line item is absent does not fail
   loudly; it reports success while the module grows past it, which is what happened.

3. **With `00-ROUTE-TO-WORKABLE.md` §2 stage 1, on where the data-handoff decision leads.** The
   stage treats "what stops being compiled in and starts being handed in" as *the* ceiling decision.
   Measured, it was worth **38 460 bytes** in total (§7.2), and **most of it has now been taken** —
   the dictionary move banked 26 915 and one 8 781-byte `include_str!` is all that is left. Stage 1's
   data lever is now worth 8 KB. The decision that actually moves the ceiling is §11.4's: **is one
   module the right shape for this product?** The two are different questions and only one of them
   is on stage 1.

4. **With the framing that "encryption does not fit".** It is true and it has been the wrong sentence
   twice, in opposite directions. When headroom was 47 082 it was wrong because *snapshot persistence*
   missed by far more, and pricing crypto alone optimised the smaller problem. It is wrong again now
   because §5b's journal route costs +263, so persistence is solved — while crypto's shortfall grew
   from 7 567 to **22 911** as the diagram spent the headroom. **Crypto is the binding constraint
   today and it was not when it was last discussed**, which is the general hazard: every one of these
   sentences was true when written and none stayed true for a week.

5. **With any plan that still treats byte pressure as a series of one-off savings.** This census has
   now watched the pattern run twice: a lever is found, it is spent, and the next feature consumes
   more than it returned. The dictionary move gave back 26 915; the diagram took 60 096 in the same
   week. §11.2's remaining 80 007 is the last lever of that kind in the tree, and §11.4's arithmetic
   shows it is already committed. **The next byte conversation has to be about shape, not savings**,
   and this document says so while there is still 13 679 bytes of room to have it in.
