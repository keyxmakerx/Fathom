# 47 — The byte census

> **Status:** Proposed

Companion documents: `44-performance-budgets.md` (**owns** every size budget and ceiling —
`01-ownership.md` row *"Size, memory and latency budgets"*; this document measures, `44` decides),
`41-technology-choices.md` §3.10 (the component split `44` §5.2 adopted), `35-supply-chain-and-builds.md`
(why no measuring tool may be downloaded), `79-work-orders/00-ROUTE-TO-WORKABLE.md` §2 stage 1 (the
decision this census was commissioned to inform).

**This document owns no budget and moves no ceiling.** It owns one thing: the measured composition
of the release module, and a reproducible instrument for re-measuring it. Where it corrects a number,
it corrects that number *in the document that owns it* and records the correction here in §10.

The census was commissioned because of a plain fact: the 900 000-byte ceiling has shaped every plan
in this tree for two weeks and **nobody had ever measured where the bytes go.** Every figure in
circulation was a delta, a guess, or a row in a budget table written before the code existed.

---

## 0. Contents

| § | |
|---|---|
| 1 | What was measured, on what, and when |
| 2 | The instrument, and why it is a loose `rustc` script |
| 3 | The module by section |
| 4 | The code section by crate — two attributions, and why one number is a lie |
| 5 | The largest single contributors |
| 6 | Cost by removal — what each feature actually costs |
| 7 | The data section — what 143 567 bytes are |
| 8 | The generated layer: the claim, and what the measurement says |
| 9 | What persistence and cryptography actually cost |
| 10 | Recorded figures: which hold, which are wrong, and the corrections made |
| 11 | RECOMMENDATION — five levers, priced |
| | Failure modes |
| | Open decisions |
| | Sources consulted |
| | Disagreements |

---

## 1. What was measured, on what, and when

*margin tab: read this before quoting any number below*

### 1.1 The exact build

| | |
|---|---|
| Repository state | commit `adbb590` ("Merge pull request #14"), measured in an isolated worktree |
| Date of every measurement in this document | **2026-08-15** |
| Toolchain | rustc **1.94.1**, pinned by `rust-toolchain.toml`; target `wasm32-unknown-unknown` |
| Profile | the workspace `[profile.release]`: `opt-level = "z"`, `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`, `strip = "symbols"`, `debug = 0`, `overflow-checks = true` |
| Command | `cargo build --release --locked -p fathom-wasm --target wasm32-unknown-unknown` |
| Artifact | `target/wasm32-unknown-unknown/release/fathom_wasm.wasm` |
| **Measured size** | **852 918 bytes** against the 900 000-byte ceiling — **47 082 bytes of headroom** |
| Full artifact | `cargo run --locked -p fathom-artifact` → `target/artifact/fathom-dev.html`, **1 215 578 bytes** |

### 1.2 The tree this census does NOT describe, and why that matters

Two changes exist in parallel sessions and are **not** in the tree measured here:

| Change | Effect on this census |
|---|---|
| The `junos-srx` dictionary moved out of the module and is handed in at boot over `OP_DICT`; `Dictionary::embedded()` deleted | Here it is still `include_str!`-ed (`crates/fathom-ingest/src/dict.rs:80`). §7.2 prices it **by removal** — which is a useful independent check on the saving that change claims |
| `crates/fathom-layout/` — the diagram's order/route/layer code | Absent here; not priced. It is the largest unmeasured addition in the tree |

A session working from a tree containing both will measure a different total (**870 977 bytes** is
the figure that tree reports). **Every proportion, ranking and ablation below still holds** — they
are properties of the same crates under the same profile — but the absolute total does not, and no
number here should be quoted as "the current size" without re-running §2's script.

`scripts/gate-zero.sh` does not exist at this commit either; the verification floor run in
§*Sources consulted* records that honestly rather than reporting a pass it did not get.

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
module, in 1 118 functions.**

This is the price of invariant 9. *"BTreeMap/BTreeSet and sorted Vec only"* is the correct rule and
this census does not argue with it — but the rule is enforced per *type*, and Rust charges per type.
Fifty distinct key/value pairs across the graph, the ledger, the index and the dictionary produce
fifty instantiations of a B-tree implementation that is not small, and 278 copies of a sort.

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

For scale: **that is more than the entire approved crypto stack costs (36 590), and 95 % of the
headroom the newer tree has left.** The reason the two lines exist is honest and recorded in
`value.rs`'s own comment: the shipped tree carries the residue-guard constants `0.75` and `0.15`
(`11` §10.4), and `62` §2.2's table lists integer spellings only, so the parser accepts a float
rather than refusing a file it must read. The bug is not the acceptance; it is that accepting it
costs 44 690 bytes when the two values in question are fixed-point constants that the codebase
already knows how to carry — `fathom_corpus` uses `icf_milli` and `fathom_find` uses `score_milli`
for exactly this.

**Method note.** These are total-module deltas from four builds; the removed code was confirmed
function-by-function by diffing the two `name` sections. Removing the parse deleted precisely seven
functions (all of `core::num::dec2flt`) totalling 6 280 code bytes — the other 12 666 came out of the
**data** section, which is `dec2flt`'s power-of-five lookup tables. **A static table is invisible in
any code-size tool and this is why §7 exists.**

### 5.2 The demo estate

`fathom_inventory::demo` is 4 483 + 4 388 = **8 871 bytes** of code and reaches into the data section
for its literals. Removing `OP_ESTATE_DEMO` removes **35 195 bytes** (§6). It is a development
fixture in a shipped artifact; nothing in this census decides whether it should ship, but nothing in
the tree records that it costs 4 % of the module either.

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
lever 5 proposes what to do instead.

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

It also settles the parallel session's claim independently. Moving the dictionary out over `OP_DICT`
buys **19 184–19 384 bytes** *of data* here; the figure that tree reports (26 915) additionally
includes the parse-and-gate code that becomes unreachable when `Dictionary::embedded()` is deleted.
Both numbers are right about different things and neither should be quoted without saying which.

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

**`Graph::from_snapshot` and `slot_from_canon` are not in the shipped module.** `fathom-workspace`
is not a dependency of `fathom-wasm` (`crates/fathom-wasm/Cargo.toml`), and a search of all 3 121
named functions returns zero matches for either. The figures describe code that would *arrive with
persistence*, not code that is there.

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
235 890. This matters because it is the only decomposition that suggests a cheaper design (§11
lever 3).

### 9.2 Cryptography does not fit, and by how much

| | Bytes |
|---|---:|
| Ceiling (`44` §5.2) | 900 000 |
| Module, this tree, measured 2026-08-15 | 852 918 |
| **Headroom, this tree** | **47 082** |
| Module, the tree with `fathom-layout` and the dictionary handed in | 870 977 |
| **Headroom, that tree** | **29 023** |
| Approved crypto stack, Argon2id + ChaCha20-Poly1305, as recorded | 36 590 |
| **Shortfall, that tree** | **−7 567** |
| Persistence, measured | 235 890 |
| **Shortfall for persistence + crypto, that tree** | **−243 457** |

**Encryption does not fit, and it is not close.** But the framing in circulation is wrong in a way
that matters: *crypto* misses by 7 567 bytes — a rounding error against the 44 690 that two lines of
float handling cost. **What does not fit is persistence**, by an order of magnitude more, and
encryption without persistence encrypts nothing. The two must be priced together or the decision is
taken against the wrong number.

The 36 590 figure is carried here as recorded; it is not reproduced by this census.
<!-- VERIFY: 36 590 for Argon2id + ChaCha20-Poly1305 appears in the commissioning brief and could not
be located in docs/ at commit adbb590. Re-measure it against a named, vendored implementation before
any decision rests on it, and record which implementation was measured — ADR-0032 requires the
approval record anyway, and it should carry the number. -->

---

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
| Headroom 72 971 (module 827 029) | `00-ROUTE-TO-WORKABLE.md` §2/§5, `CLAUDE.md` | **Stale.** 852 918 / 47 082 at commit `adbb590`, 2026-08-15 |
| `44` §5.2's seven-row component table, target ≤ 700 KB | `44` §5.2 | **Wrong in structure, not only in value** — §10.2 |
| `44` §5.3's "WASM core 700 KB → 933 KB in the file" | `44` §5.3 | **Wrong.** 852 918 base64s to 1 137 224; the artifact is 1 215 578 |
| `44` §5.5's `xtask size-gate` with per-component ceilings | `44` §5.5 | **Does not exist.** There is no `xtask`; the gate is one total-only assertion, exactly the shape §5.2 warns against |

### 10.2 `44` §5.2 measured against its own rows

| §5.2 row | Budget | Measured, this tree | Verdict |
|---|---:|---:|---|
| Graph, ops, CRDT | 90 KB | 107 128 (`fathom_graph`, by instantiation) | **Over by 17 KB, with no CRDT written** |
| Parsers + dictionary | 140 KB | 163 118 (`fathom_ingest` 116 771 + `fathom_schema` 27 164 + dict data 19 183) | Over by 19 KB |
| Rule engine + emitters | 120 KB | 0 | Not built |
| Finder | 60 KB | 187 788 (`fathom_find` 58 614 + `fathom_corpus` 129 174) | **Over by 123 KB** — the corpus index was never a row |
| Crypto stack | 180 KB | 0 | Not built |
| CBOR codec + packed writers | 40 KB | 867 (`fathom_canon`; the project chose canonical JSON, not CBOR) | Row describes a decision that changed |
| `core::fmt`, panic strings, misc | 70 KB | 85 030 (`core` 64 752 + `alloc` 10 470 + `dlmalloc` 7 743 + `std` 725 + shims 1 340) | Over by 13 KB |
| **Total** | **≤ 700 KB** | **852 918** | **Over by 152 918, with three of seven rows at zero** |

**Rows the table does not have, and needs:** the IR and its generated layer (88 605), the inventory
face (45 168), the wasm shell and protocol (28 777), the weld (8 877), IDs (7 681) — and above all
the 301 531 bytes of §6.3 that belong to no row at all.

### 10.3 Corrections made in place by this session

| Document | Change |
|---|---|
| `44` §5.2 | Measurement block inserted: the 2026-08-15 total, the ceiling's status, the per-row verdicts, and the note that the section's own component gate does not exist |
| `44` §5.3 | The WASM row corrected from 700 KB / 933 KB to the measured 852 918 / 1 137 224, and the artifact total to 1 215 578 |
| `00-ROUTE-TO-WORKABLE.md` §1, §5, Failure modes | 827 029 / 72 971 corrected to 852 918 / 47 082 with the date and the tree caveat; the persistence figure annotated with its measured reproduction and its save/load split |

No number was changed without a measurement in this document behind it, and none was changed in a
document this session does not have cause to touch.

---

## 11. RECOMMENDATION — five levers, priced

*margin tab: what to do, in the order the measurements support*

The decision waiting on this census is *"encryption does not fit; what gives?"* The measured answer
is that the question is under-specified: crypto misses by 7 567 bytes and persistence misses by
206 867 more. Five levers, cheapest first. **The first two are free and nobody has to decide
anything.**

### Lever 1 — Take the float machinery out. 44 690 bytes, no design decision. DO THIS FIRST.

Parse `0.75` and `0.15` as fixed-point milli-integers in the YAML subset, exactly as `fathom_corpus`
already does with `icf_milli` and `fathom_find` with `score_milli`, and render them back the same way.
`Value::Float` may keep existing for the emitter's benefit; what must go is `f64::from_str` and
`<f64 as Display>` on the reachable path.

**44 690 bytes — 5.24 % of the module, more than the whole crypto stack — for a change that makes the
parser more deterministic, not less.** It also removes the only floating-point arithmetic on the
schema path, which invariant 9 has a standing interest in. There is no argument against it that this
census can find, and it is the cheapest 44 KB in the project.

*What it does not do:* `fathom_find` and `fathom_corpus` still compute in `f64` internally
(`det_ln`, Jaro-Winkler, BM25). Those are arithmetic, not formatting, and cost nothing here.

### Lever 2 — Decide whether the demo estate ships. 35 195 bytes, one sentence from the owner.

`OP_ESTATE_DEMO` is a development fixture. If the answer is "it ships, it is how a new user sees
something without pasting", then it is a *feature* and belongs in a budget row. If it is a fixture,
it belongs behind a build flag. **Either answer is fine; what is not fine is that 4.1 % of a module
against a hard ceiling is a fixture nobody has decided about.**

**Levers 1 and 2 together are 79 885 bytes** — from 852 918 to roughly 773 000, and from the other
tree's 870 977 to roughly 791 000. That is 109 000 bytes of headroom, which fits the crypto stack
three times over and still does not fit persistence.

### Lever 3 — Do not make the module able to load a workspace. Save 172 081 of the 235 890.

This is the census's most consequential finding and it is a genuine design fork, so it is stated as
one rather than recommended.

The load path costs 65 % of persistence because `snapshot_from_json` → `slot_from_canon` instantiates
a typed parse for **every field of every kind** — 299 of them — whether or not the workspace being
loaded contains any. The save path costs 35 % because writing is uniform: a value that is in the
graph already knows its own type.

**DECISION — where does a saved workspace get re-typed?** Three answers:

| Route | Cost | What it loses |
|---|---:|---|
| **A — in the module, as now** | 235 890 | Nothing. Does not fit |
| **B — save typed, load through the same narrow dispatcher hand entry uses** | ~93 036 + a narrow loader | The file must carry enough type information that the loader does not need the 299-arm table. That is a **format** decision (`17`), and it means a workspace file is self-describing rather than schema-derived — which is *also* the migration story the route document flags as missing (stage 5's "biggest risk"), so it buys two things |
| **C — the page re-types it in JS before handing it in** | ~0 in wasm | Puts schema knowledge outside the module, where it can disagree with the module. Refuse: ADR-0008's whole point is one source of truth for what a field is |

**RECOMMENDATION — B**, and it should be measured before it is committed to, because "narrow
dispatcher" is exactly what route B of stage 6 already is (+5 677 for the fields a hand-entry form
needs) and the two should be the same code. If B lands anywhere near its estimate, persistence plus
crypto becomes ~130 000 bytes rather than 272 480, and both fit inside levers 1 and 2's saving.

### Lever 4 — Move more data out, and know exactly what it buys: 38 460 bytes, all of it.

`OP_DICT` already proves the mechanism and the corpus already arrives as host-supplied `SourceFile`s.
The remaining embedded text is **38 460 bytes total** (§7.2) and moving all of it is the whole prize.
**State this plainly in stage 1's decision: data-handoff is a 38 KB lever, not a 200 KB one.** It is
worth doing for the second platform's dictionary — which will be another ~19 KB of *data* and, more
importantly, zero new *code* — but it does not solve persistence and it must not be sold as if it
might.

The generated identifier tables (§7.3, 8–12 KB of duplication) are a separate and probably cheaper
saving: one shared `&[&str]` per table, referenced by every generated function, instead of each
function carrying its own concatenation. That is a `fathom-schemagen` change, it needs no decision,
and its size should be measured before anyone budgets on it.

### Lever 5 — Fix the gate before fixing the number. The ceiling is not the problem; the gate is.

`44` §5.2 says a total-only gate is insufficient and then §5.5 specifies a per-component gate that
**does not exist** — there is no `xtask`, no `perf/size-baselines.toml`, and one assertion at
`artifact_gates.rs:97`. Meanwhile §6.3 measures that **35 % of the module belongs to no component**,
so the per-component gate as specified could never have been met either.

**RECOMMENDATION — replace §5.2's component budget with three things this census can actually
produce, in this order:**

1. **A ratchet.** `perf/size-baselines.toml` with the total and a `reason` string, exactly as §5.5
   already describes. It is the one part of §5.5 that works regardless of components, it costs a
   line of TOML per growth, and it makes growth deliberate. **Land this before the next feature.**
2. **A per-crate report, by instantiation site,** from `scripts/byte-census.sh`, posted rather than
   gated. §4.2's table is the report. Gating it would be a lie — 35 % is shared — but a reviewer
   seeing `fathom_corpus 129 174 → 161 000` in a diff will ask the right question.
3. **A named shared-machinery row**, budgeted and watched. `alloc::collections::btree` +
   `core::slice::sort` is 218 215 bytes and it grows with the number of distinct *types*, not with
   the amount of code. That is a budget nobody has and the only one that predicts what the second
   platform, the rule engine and the diagram will actually cost.

**And on the ceiling itself.** `44` §5.2 and the route document are right that 900 000 is an
architecture question, and this census does not propose moving it. But it does establish what moving
it would *buy*, which nobody had: the module is 82.66 % code, the code is 47 % shared generic
machinery, and **the artifact is 1 215 578 bytes against a 4 500 000-byte ceiling — 27 % spent.**
The pressure is entirely on the wasm sub-budget, and the wasm sub-budget was set as a fraction of a
3.38 MB artifact projection that has not survived contact with the code. If the ceiling is ever
raised, the argument for it is that one number was derived from another number that turned out to be
wrong, and not that the product needs more room.

---

## Failure modes

1. **Someone quotes a total from this document against a different tree.** §1.2 exists for this.
   Two absolute totals are in circulation (852 918 here, 870 977 with `fathom-layout` and `OP_DICT`)
   and they differ by more than a third of the remaining headroom. **Re-run §2.4's script; do not
   quote §3.**
2. **A marginal cost is read as a share.** §6.1 states it and §6.3 measures it: the marginals sum to
   506 962 against 808 493 attributable. Anyone who adds two rows of §6.2 together has over-counted.
3. **A self-size is quoted where a reachability cost was meant, or the reverse.** This already
   happened once, to `slot_from_canon`, with a 9× error (§8.2). Every figure in this document is
   labelled as one or the other; keep the label when the figure travels.
4. **The instrument goes stale.** `scripts/byte-census.rs` parses the section layout the current
   toolchain emits. A toolchain bump, a `Cargo.toml` profile change, or a future non-empty import
   section will change its assumptions — two of which it asserts (`imported == 0`, every byte lands
   in a section) so it fails loudly rather than reporting a wrong number.
5. **Lever 1 is taken as licence to delete `Value::Float`.** It is not. The parser must keep reading
   the files it reads today; what changes is the *representation*, and a test that `0.75` still
   parses is part of the change, not optional to it.
6. **The 44 690 saving is spent before it is banked.** It is measured by ablation, not by a landed
   change. Nothing in this document is headroom until a build shows it.

---

## Open decisions

1. **Does the demo estate ship?** (Lever 2.) 35 195 bytes. Owner-shaped, one sentence.
2. **Where does a saved workspace get re-typed?** (Lever 3, routes A/B/C.) The largest byte decision
   in the tree and it is a **format** question that `17` owns, not a size question.
3. **Does `44` §5.2's component table get repaired or replaced?** This census recommends replaced
   (lever 5). `44` owns the answer.
4. **What exactly does the approved crypto stack cost?** 36 590 is carried, not reproduced. It should
   be measured against the specific vendored implementation ADR-0032 requires an approval record for,
   and the number should live in that record.
5. **Should `scripts/byte-census.sh` run in CI?** It is two extra release builds. The ratchet
   (lever 5 item 1) does not need it; the per-crate report does. Not decided here.

---

## Sources consulted

| Source | What was taken | When |
|---|---|---|
| `cargo build --release --locked -p fathom-wasm --target wasm32-unknown-unknown` at commit `adbb590` | Every total in §3, §6, §9 | 2026-08-15 |
| The same build with `CARGO_PROFILE_RELEASE_STRIP=none` and `-C symbol-mangling-version=v0` | Every per-function and per-crate figure in §4, §5, §8 | 2026-08-15 |
| `scripts/byte-census.rs` (new; first-party section, code and `name` reader) | The section table, both attributions, the module and function rankings | 2026-08-15 |
| 24 ablation builds, each edit reverted from a byte copy | §5.1, §6, §7.2, §8.2, §9.1 | 2026-08-15 |
| Data-segment text scan of the shipped module | §7.1, §7.3 | 2026-08-15 |
| `crates/fathom-wasm/tests/artifact_gates.rs:97` | The gate's exact form: one total assertion, `size <= 900_000` | 2026-08-15 |
| `crates/fathom-wasm/Cargo.toml` | That `fathom-workspace` is not a dependency, hence §8.1 | 2026-08-15 |
| `docs/40-stack/44-performance-budgets.md` §5.2, §5.3, §5.5 | The budget rows measured against in §10.2 | 2026-08-15 |
| `docs/70-ops/79-work-orders/00-ROUTE-TO-WORKABLE.md` §1, §2 stages 1/5/6, §5, Failure modes | The recorded figures verified in §10.1 | 2026-08-15 |
| The commissioning brief | The 110 256 / 107 857 / 36 590 / 26 915 figures put to test | 2026-08-15 |

**Verification floor**, run at the end of this session on the tree as delivered:

| Gate | Result |
|---|---|
| `cargo fmt --all --check` | no output |
| `cargo clippy --all-targets --locked -- -D warnings` | clean, exit 0 |
| `cargo test --workspace --locked` | **420 passed, 0 failed, 0 ignored** |
| `cargo run --locked -p fathom-schema --bin fathom-schema-check` | 48 kinds · 89 edges · 61 scalars · 10 enums · 14 files · **0 failures, 0 warnings** |
| `./scripts/gate-zero.sh` | **does not exist at commit `adbb590`.** Recorded as not run, not as passed. No dependency was added by this session — `Cargo.lock` and every `Cargo.toml` are unmodified |
| `cargo run --locked -p fathom-artifact` | `target/artifact/fathom-dev.html · 1 215 578 bytes` |

**Nothing was looked up outside this repository.** Every claim here is arithmetic over a file that
was built, or a file that was read. ADR-0034's rule is about the outside world; it does not apply to
a binary on disk, and this document deliberately makes no claim about a vendor, a standard, a
browser or a cryptographic primitive. The one figure it carries from outside its own measurements —
36 590 for the crypto stack — is marked `VERIFY` in §9.2 rather than restated as fact.

---

## Disagreements

1. **With `44` §5.2, on the shape of a size budget.** The section budgets seven components and
   nothing else, and §6.3 measures that **35 % of the module belongs to no component**. Per-component
   gating as specified is not merely unimplemented, it is unachievable. **Proposed replacement:**
   §11 lever 5's three-part mechanism — a total ratchet that gates, a per-crate instantiation-site
   report that informs, and one explicit shared-machinery row that is budgeted and watched. `44`
   owns the change; this is raised, not made.

2. **With `44` §5.2, on which components exist.** Three of its seven rows are at zero (rule engine,
   crypto, CBOR) and the two largest real contributors — the IR's generated layer and the shared
   B-tree/sort machinery — have no row. A budget table whose largest line item is absent does not
   fail loudly; it reports success while the module grows past it, which is what happened.

3. **With `00-ROUTE-TO-WORKABLE.md` §2 stage 1, on where the data-handoff decision leads.** The
   stage treats "what stops being compiled in and starts being handed in" as *the* ceiling decision.
   Measured, it is worth **38 460 bytes** in total (§7.2) — real, worth taking, and an order of
   magnitude short of what persistence needs. The decision that actually moves the ceiling is
   stage 5's, restated in §11 lever 3: **where a saved workspace gets re-typed.** The two are
   different questions and only one of them is on stage 1.

4. **With the framing that "encryption does not fit".** It is true and it is the wrong sentence.
   Crypto misses by 7 567 bytes against a float-handling defect that costs 44 690. **Persistence** is
   what does not fit, by 206 867 bytes more, and encryption without persistence protects nothing. Any
   decision that prices the two separately will optimise the smaller one.
