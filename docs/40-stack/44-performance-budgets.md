# 44 — Performance budgets

> **Status:** Proposed

Companion documents: `41-technology-choices.md` (the boundary and its costs), `42-no-node-runtime.md`
(the harness that measures any of this), `32-cryptography.md` §4 (the one budget in the product that
this document does not own).

Owner brief §6.1 states the bar in one sentence and it is the only bar that matters commercially:

> *"Must be a single keystroke (`Ctrl+K`) from anywhere. If it is slower than opening a browser tab,
> it will not be used."*

Every other budget in this document is downstream of that sentence, because a tool that is instant in
one place and sluggish everywhere else does not read as fast — it reads as inconsistent, which is
worse.

**The governing rule of this document, stated once, in caps, at the top:**

> **THE FINDER COMPETES WITH A BROWSER TAB. EVERYTHING ELSE COMPETES WITH THE USER'S PATIENCE.
> EXACTLY ONE THING IS ALLOWED TO BE SLOW AND IT IS THE KEY DERIVATION.**

Every number below is either **gated in CI** or **explicitly marked ungated**. A budget nobody
measures is a wish, and a wish in a table looks exactly like a commitment.

---

## 0. Contents

| § | |
|---|---|
| 1 | What a budget is here, and the three kinds |
| 2 | Reference hardware — REF-0, REF-1, REF-2, REF-M |
| 3 | The budget table |
| 4 | Each budget, with its rationale |
| 5 | Size budgets — WASM by component, artifact by component, the CI gate |
| 6 | Memory budgets per workspace size |
| 7 | The scaling analysis — what breaks first |
| 8 | Measurement methodology |
| 9 | Things that bite |
| 10 | What CI enforces |
| 11 | Open decisions |
| 12 | Sources |
| 13 | Disagreements |

---

## 1. What a budget is here

*margin tab: read this first*

### 1.1 Three kinds of number, and they are not interchangeable

| Kind | Written as | Enforced by | What a breach means |
|---|---|---|---|
| **Work budget** | a count — VM steps, postings scanned, bytes across the boundary, SVG elements live | `assert!(counter <= limit)` in a normal test, on any machine | The code now does more work. Always a real regression. Blocks the merge. |
| **Wall-clock budget** | milliseconds at a named percentile on a named machine | a nightly run on pinned hardware, compared to a checked-in baseline | The code got slower, *or* the machine did. Alarms; blocks only past 25 %. §8.4. |
| **Size budget** | bytes | `xtask size-gate` over the release artifacts | The artifact grew. Blocks the merge past the ratchet. §5.5. |

The distinction exists because of invariant 9. **The product is deterministic, so its work counters
are deterministic, so a work counter can be asserted exactly on a noisy shared CI runner where a
millisecond cannot.** That is the single most useful consequence of the determinism invariant outside
of security, and it is why §8 puts counters first and stopwatches second.

### 1.2 Percentiles, and why the median is the wrong number

A keystroke path runs ten times a minute. A user meets its P95 several times a minute and its P99
within the first minute. Budgets are therefore stated at **P95**, with a P99 that is a hard failure,
and a P50 that exists only to catch the case where the P95 is met by a fast path that never runs.

Means are not used anywhere in this document. One 400 ms GC pause in 200 samples moves a mean and
does not move a P95, and the 400 ms pause is the thing the user noticed.

### 1.3 What is deliberately not budgeted

| Not budgeted | Why |
|---|---|
| Time before our first byte executes — browser process start, storage read, antivirus scan of a 4 MB HTML file | Outside the artifact. Measured and reported in §4.1, never gated. A 4.5 MB file on a USB 2.0 stick is seconds before anything of ours runs, and that is the user's storage. |
| The KDF | `32` §4.2 owns it. §4.8 reconciles. |
| Sync round trips | Network. `33` owns latency behaviour; there is no wall-clock budget on somebody else's link. |
| Anything in the AI layer | `21` quarantines it behind a boundary and `25` measures it on its own terms. A subagent that is slow is a `25` §10 kill-criteria question, not a frame-budget question. |
| The native CLI | It is a batch tool. Its budget is "faster than the human's patience for a shell command", which is seconds, and `12` §7.6 already says the incremental machinery is pure overhead there. |

---

## 2. Reference hardware

*margin tab: on what box*

### 2.1 The choice, and why it is deliberately modest

Budgets set on a current developer workstation are budgets that are met on a current developer
workstation. The audience for this product is a network engineer on a corporate laptop that IT
issued three years ago, running a full-disk-encryption agent, an EDR agent, a VPN client and eleven
other tabs.

**DECISION — every hard budget in this document is stated on REF-1, and REF-1 is a 2019 corporate
ultrabook.**

| | **REF-0** — the floor | **REF-1** — the budget machine | **REF-2** — the CI runner | **REF-M** — the phone |
|---|---|---|---|---|
| Role | "does it work at all" | **every number in §3** | work counters, size gates | mobile viability only |
| CPU | Intel Core i5-7200U, 2 cores / 4 threads, 2017 | **Intel Core i5-8265U, 4 cores / 8 threads, 2019** | whatever the CI provider gives | mid-range Android, 2023-class |
| RAM | 8 GB | **8 GB** | ≥ 8 GB | 6 GB |
| Storage | SATA SSD | NVMe SSD | — | UFS |
| GPU | integrated HD 620 | integrated UHD 620 | — | integrated |
| Browser | Chromium stable, Firefox ESR | **Chromium stable**, plus Firefox stable in the matrix | headless Chromium | Chrome for Android |
| Power profile | plugged in, balanced | **plugged in, balanced** | — | plugged in |
| Budgets apply | ×2.0 allowance; only hard-fail thresholds | **as written** | counters and sizes only | ×3.0; §4.8 and §6 only |

REF-1 is named as a class, not as a serial number: any 4-core U-series part of that generation with
8 GB is REF-1. `32` §4.2's VERIFY grid names "a 2019 dual-core ultrabook" in its measurement plan;
that machine is REF-0 here, and the two documents should be measured on the same physical hardware so
the KDF grid and the budget table are comparable.

<!-- VERIFY: pick and procure the actual REF-0 and REF-1 machines, record their exact model, BIOS
     version, microcode revision and browser build in perf/machines.toml, and re-measure every
     wall-clock number in §3 on them. Until that file exists, every millisecond in this document is
     arithmetic over assumed per-operation costs, exactly as `12` §7.1 and `14` §11.2 already say of
     theirs. -->

### 2.2 The CI runner problem, stated before it is worked around

A shared cloud CI runner is a noisy virtual machine on hardware shared with strangers. Observed
run-to-run variance on such runners is large enough that a 10 % regression is invisible and a 3 %
flake rate is normal.

**You cannot gate a merge on absolute latency measured on a shared runner.** Every project that tries
ends the same way: the perf job goes yellow twice a week, somebody adds `continue-on-error`, and
three months later nobody notices that the finder got four times slower.

§8 is the design that follows from accepting this rather than fighting it.

---

## 3. The budget table

*margin tab: the whole document in one table*

REF-1, Chromium stable, warm browser, mode A (offline single file) except where noted. P50/P95 are
rank statistics over 200 iterations after 20 discarded warm-up iterations (§8.5).

| # | Budget | P50 | **P95** | Hard fail | Gate |
|---|---|---|---|---|---|
| **B1** | A1 cold load → first paint (shell, masthead, legend) | 190 ms | **300 ms** | 600 ms | wall-clock, nightly |
| **B2** | A1 cold load → `Ctrl+K` armed | 220 ms | **350 ms** | 700 ms | wall-clock, nightly |
| **B3** | A1 cold load → fully ready (pack compiled, corpus mounted) | 260 ms | **450 ms** | 900 ms | wall-clock, nightly |
| **B4** | `Ctrl+K` → overlay painted with recents | 22 ms | **50 ms** | 100 ms | e2e, every PR |
| **B5** | keystroke → re-ranked finder results painted | 9 ms | **16.7 ms** | 33.4 ms | counters (PR) + wall-clock (nightly) |
| **B6** | keystroke in a field → shape feedback painted | 2 ms | **8 ms** | 16.7 ms | e2e, every PR |
| **B7** | field commit → findings on the edited node | 6 ms | **16.7 ms** | 33.4 ms | counters, every PR |
| **B8** | field commit → all propagated findings settled | 60 ms | **200 ms** | 600 ms | counters, every PR |
| **B9** | parse 5,000 `set` lines → graph fragment | 55 ms | **90 ms** | 200 ms | criterion (nightly) + counters (PR) |
| **B10** | emit one full device (≈ 4,000 lines) | 18 ms | **30 ms** | 80 ms | criterion, nightly |
| **B11** | re-emit after one field change | 1.5 ms | **4 ms** | 12 ms | criterion, nightly |
| **B12** | diagram first render, 500 nodes | 90 ms | **160 ms** | 400 ms | e2e, every PR |
| **B13** | diagram pan frame, 500 nodes | 4 ms | **8 ms** | 16.7 ms; ≤ 1 % dropped over a 5 s scripted pan | e2e + trace, every PR |
| **B14** | workspace unlock — time to unlock (TTU) | KDF + 80 ms | **KDF + 150 ms** | KDF + 400 ms | e2e, every PR. §4.8 |
| **B15** | unlock → first device interactive (TTI-a), 20 devices | 220 ms | **400 ms** | 900 ms | e2e, every PR |
| **B16** | unlock → all findings settled, 20 devices | 500 ms | **900 ms** | 2,500 ms | e2e, every PR |
| **B17** | A1 artifact size | — | — | **4.5 MB** | size gate, every PR |
| **B18** | WASM core, uncompressed | 700 KB target | — | **900 KB** | twiggy gate, every PR |
| **B19** | steady resident memory, 20-device workspace | — | **120 MB** | 250 MB | e2e memory probe, nightly |

Two things to read out of this table before the rationale sections:

1. **Five budgets are one frame (16.7 ms) and they are the five the user meets constantly.** B5, B6,
   B7, B13 and the frame-level half of B12. Everything else is allowed to take a perceptible moment.
2. **B14 does not have a number.** It has a formula. That is the whole of §4.8 and it is the most
   important paragraph in this document.

---

## 4. Each budget, with its rationale

### 4.1 B1–B3 — cold load of the offline single file

*margin tab: once a day*

**What is being loaded.** Mode A is one HTML file of about 3.4 MB (§5.3), of which roughly 3.1 MB is
base64 inside script elements. There is no server, no gzip, no HTTP cache and no streaming
compilation, because a `file://` document has none of those things.

The boot sequence, with a budget per stage. These are the stages we own; stage 0 is measured and
reported but not gated (§1.3).

| Stage | Budget | Work, and why the number is plausible |
|---|---|---|
| 0 | *ungated* | Storage read of the file + browser document setup. On REF-1's NVMe, ~25 ms. On a USB 2.0 stick, ~200 ms. On a network share with an EDR agent inspecting it, seconds. Not ours. |
| 1 HTML + CSS parse | 45 ms | ~140 KB of markup and hand-written CSS, plus 3.1 MB of string-literal bytes the JS tokeniser must still scan even though it will not execute them |
| 2 JS compile | 20 ms | ~120 KB of first-party JS; only the boot path compiles eagerly |
| 3 base64 → bytes (WASM) | 12 ms | 933 KB in, 700 KB out. `Uint8Array.fromBase64` where the engine has it, a hand-rolled loop otherwise <!-- VERIFY: baseline availability of Uint8Array.fromBase64 across Chromium, Firefox and WebKit in 2026, and the throughput delta against a hand-rolled decoder. --> |
| 4 `WebAssembly.instantiate(bytes)` | 60 ms | 700 KB, **non-streaming**. `compileStreaming` needs a `Response` with a wasm MIME type and mode A has no `Response`. This is the single largest stage and it is a direct cost of the single-file shape |
| 5 shell paint | 30 ms | masthead rule, risk legend, empty panes, passphrase field. **B1 fires here.** |
| 6 base64 → bytes (finder index) + copy into linear memory | 22 ms | 1.4 MB in, 1.05 MB out, one copy |
| 7 finder index mount | 8 ms | `16` §9's format is used in place — FST headers and CSR offsets only, no parse |
| 8 — | — | **B2 fires here.** `Ctrl+K` is armed |
| 9 rule pack decompress + mount | 25 ms | `12` §7.1's warm figure, from the compiled cache |
| 10 explainer corpus mount | 15 ms | index only; bodies are lazily decompressed zstd frames (`15` §—) |
| 11 — | — | **B3 fires here** |

Nominal sum to B3 is ~237 ms. The P95 budget is 450 ms, which is roughly a factor of two of headroom,
and it is deliberate: the P95 of a cold load includes a cold OS page cache, a first-run JIT and a
browser that has decided this is a good moment to do something else.

**Why these thresholds and not others.** Nielsen's three response-time limits — 0.1 s for "the system
is reacting instantaneously", 1 s for "the user's flow of thought stays uninterrupted", 10 s for
"the user's attention is gone" — are the canonical framing, and they trace back to Miller's 1968
survey of conversational response times. A cold load is unambiguously in the second band: it happens
once, the user expects *something*, and the requirement is that it does not break flow. **B3 at 450 ms
puts a full cold start comfortably inside the one-second band with room for a slow disk.**

**What we do not do:** a splash screen, a progress bar, a skeleton loader or an animated logo. The
design language forbids all four (`design-language.md`, *What the card never does*). At 300 ms to
first paint none of them is needed, and a splash screen is what a project builds instead of hitting
the budget.

**Modes B–D** get streaming compilation, HTTP caching and Brotli, so their cold load is strictly
faster and is not separately budgeted. If a served build is ever *slower* than mode A, something is
wrong with the server, not with this document.

### 4.2 B4 — `Ctrl+K` to overlay

*margin tab: the whole product's first impression*

**The competitor, quantified.** The brief's bar is "faster than opening a browser tab". Decomposed,
that competitor is two separate races:

| Race | Competitor | What Fathom must beat |
|---|---|---|
| Getting somewhere you can type | `Ctrl+T` → focused omnibox, ~50–150 ms on a warm browser | **B4: 50 ms** |
| Getting an answer | type a query, network round trip, page load, scan a vendor doc page — 800 ms to several seconds on a corporate network with a proxy | **B4 + B5 + reading time**, i.e. under 100 ms to a ranked answer |

The second race is not close and never will be, because we are local and deterministic and they are
a network. **The first race is the one that can be lost**, and it is lost in the UI, not in the
search.

**How B4 is met: the overlay contains no work.**

| Rule | Consequence |
|---|---|
| The overlay DOM subtree is built once, at stage 11 of boot, and lives `hidden` | Opening it is a class toggle and a `focus()`, not a construction |
| It opens showing the last 8 queries and the 8 highest-`weight` entries for the current context, both precomputed and held in the UI's shadow copy (`41` §3.10) | **Zero WASM crossings on the open path.** The first crossing is the first keystroke |
| No animation, no transition, no backdrop fade | A 150 ms fade *is* 150 ms of latency, and it is latency somebody chose |
| The keymap handler is registered on `window` in the capture phase, at boot | No delegation walk, no focus-dependent dispatch |

50 ms P95 for a class toggle and a paint is generous. It is generous on purpose: the budget has to
survive a compositor hiccup caused by something else on the page, because the user does not care
whose fault it was.

### 4.3 B5 — keystroke to re-ranked results

`16` §10 already budgets this end to end and this document adopts its table rather than restating it:
**≈ 3.9 ms cold / 2.5 ms warm for matching, 6–9 ms for rendering 25 virtualised rows, ≈ 11–14 ms
total against a 16.67 ms frame.**

Two additions this document makes:

1. **The gate is a work counter, not a stopwatch.** `finder_postings_scanned`,
   `finder_candidates`, `finder_fuzzy_candidates` and `finder_fst_states_visited` are asserted
   against per-query ceilings for the golden query set (`16` §—). A change that makes the fuzzy path
   consider 4,000 candidates instead of 400 fails on any machine, immediately, with a diff that names
   the query.

   | Counter | Ceiling per query | Basis |
   |---|---|---|
   | `finder_candidates` | 1,024 | `16` §10's candidate-generation stage |
   | `finder_postings_scanned` | 2,400 | ≤ 6 terms × ≤ 400 postings, `16` §10 |
   | `finder_fuzzy_candidates` | 800 | ≤ 2 tokens × 400 |
   | `boundary_bytes_out` | 6 KB | X6 in `41` §3.2 |
   | `dom_nodes_created` | 25 rows × 9 nodes = 225 | virtualised list, no more than one rebuild |

2. **The render half is instrumented separately and reported separately.** `16` §10 says it plainly:
   *"if this budget is missed it will be the render, not the match."* A perf report that shows one
   number for B5 hides the only interesting fact about it. The harness records
   `(event → wasm_call, wasm_call → return, return → paint)` as three numbers, always.

**The worked query, for the fixture.** From the field card, side 1: *"check if a tunnel is up."*
The expected top result is `junos-srx/ipsec.sa.show` — `show security ipsec security-associations`,
`risk: ReadOnly`, `read_field: "State — want Installed"`. That query, that expected ordering and those
counter ceilings are one row of the golden query set and one row of the perf fixture set. The same
fixture serves ranking correctness and latency, which is the only reason it will stay current.

### 4.4 B6–B8 — keystroke to updated findings

*margin tab: most-missed*

This is the budget most likely to be misunderstood, because **there are two clocks and only one of
them starts on the keystroke.**

| Clock | Starts | Budget | Owner |
|---|---|---|---|
| **Shape feedback** | every keystroke | B6, 8 ms | The UI. One regex or one enum-membership test (`41` §3.6) |
| **Findings** | *field commit*, which is on blur or after 400 ms of settled text (`12` §—) | B7 / B8 | The rule engine |

**The 400 ms debounce is part of the budget and it is not a compromise.** Typing `203.0.113.10` into
a peer-address field produces eleven intermediate strings, of which ten are not addresses. A findings
panel that fires on each of them raises and clears an "invalid address" finding ten times, and the
panel becomes a strobe light that people stop reading. `12` §7.2 makes the same point about late
Tier B results: *"no flash, no reorder animation, no 'new' badge for findings that are simply late."*

So the honest statement of this budget is:

> **Keystroke to updated findings is 400 ms of deliberate silence plus one frame of work.** The
> silence is the design. The frame is the budget.

And the corollary that makes it survivable: **the field must never be silent.** B6 exists so that
between the keystroke and the commit, the user is getting shape-level feedback (this is not a valid
IPv4 address; this interface name does not exist on this platform) inside one frame, from TypeScript,
with no crossing at all. The findings panel is allowed to lag because the field is not.

**B7 and B8 map directly onto `12` §7.1's tiers:**

| This document | `12` §7.1 | Budget there | Budget here | Difference |
|---|---|---|---|---|
| B7 | Tier A, main thread | 8 ms for the engine | 16.7 ms end to end | The other 8.7 ms is the finding-set patch, the sort-key binary search and the DOM patch |
| B8 | Tier B, worker | 150 ms for the engine | 200 ms end to end | 50 ms for `postMessage`, the patch decode and the render |

**The counters that gate them:**

| Counter | Ceiling | Basis |
|---|---|---|
| `rule_instances_evaluated` (Tier A) | 60 | `12` §7.2: 15–40 instances for a `LogicalUnit` in the IPsec domain, with headroom |
| `rule_vm_steps` per instance | 2,000 | `63` §—'s per-rule step budget |
| `readby_entries_touched` | 400 | `12` §7.3: `|ReadBy[k]|` is 2–20 per field, times the fields one commit touches |
| `finding_patch_ops` | 40 | A single field commit that produces 200 patch operations is a bug in the diff, not a slow machine |

A rule pack that raises `rule_instances_evaluated` for the field-card fixture workspace from 34 to
340 fails the PR with the rule id that did it. That is worth more than any timing test.

### 4.5 B9 — parse of a 5,000-line config

`14` §11.2 budgets 250 ms for 20,000 lines with a seven-stage breakdown. Scaling that to 5,000 lines
is close to linear for stages 1–6 and slightly super-linear for stage 7 (reconciliation, `O(n + f ·
4096 · |kinds|)`), so:

| Stage | 20,000 lines (`14` §11.2) | 5,000 lines | Note |
|---|---|---|---|
| 1 Frame | 25 ms | 7 ms | two byte passes |
| 2 Lex | 20 ms | 5 ms | |
| 3 Shape | 25 ms | 7 ms | |
| 4 Redact | 20 ms | 5 ms | |
| 5 Bind | 60 ms | 15 ms | trie probes dominate |
| 6 Resolve | 20 ms | 5 ms | |
| 7 Reconcile | 80 ms | 25 ms | the `f · 4096 · |kinds|` term does not shrink with `n` |
| **Total** | 250 ms | **69 ms** | |

Budget: **P50 55 ms, P95 90 ms, hard fail 200 ms.** The P95 sits under `14` §11.2's 300 ms
main-thread threshold, which means a 5,000-line paste runs synchronously inside the paste handler and
the user sees a populated graph in the same interaction. That is the property worth protecting: a
paste that goes to a Worker with a progress bar is a different, and worse, product moment than a
paste that just works.

**Why 5,000 lines is the right size to budget.** `14` §11.1 puts a mid-size firewall at 1,000–4,000
`set` lines and a large device or cluster at 10,000–60,000. Five thousand is one real SRX with a real
policy base — the modal paste, not the worst one.

**The counter gate:** `ingest_fuel_used` and `ingest_trie_probes`, asserted against the field-card
fixtures and the synthetic estate corpus (`45` §15). Fuel is already the hang guard (`14` §13.5); it
is also, for free, an exact work counter.

### 4.6 B10–B11 — emit

Emit is `O(V + E)` over the closure (`11` §14.3). A mid-size device is ~830 nodes and ~1,900 edges
(`11` §14.2), producing on the order of 4,000 `set` lines with their provenance.

| | Budget | Composition |
|---|---|---|
| **B10** full device | P95 30 ms | closure DFS, ~4,000 `EmittedLine` constructions (each carrying `source_node`, `source_fields`, `rules_applied`, `risk`, `order_hint`), path rendering, the stable sort by `(phase, block rank, block, order_hint, path)`, and the `D1` self-check parse |
| **B11** one field changed | P95 4 ms | Only the blocks whose `key` prefix changed are re-rendered. `13` §—'s E4 (*order is stable under unrelated edits*) is what makes this possible: if a value change could reorder unrelated lines, every edit would be a full re-emit |

**The `D1` self-check is inside the budget, not outside it.** `18` §3.8 requires
`parse(render(emit(A)) ++ render(config_diff(A,B))) ≡path emit(B)` to run **at runtime on every change
set**, and §12 of that document explicitly forbids disabling it for performance. So B10's 30 ms
includes one parse of text we just generated. At 4,000 lines that parse is roughly B9 scaled down —
about 55 ms by the table above, which does not fit.

**Resolution:** `D1` parses only the *change set*, not the whole config. `18` §3.8 prices it as
`O(|A| + |Δ|)` where `|A|` is the already-parsed base. The base line index is retained from the
previous emit, so the incremental cost is `O(|Δ|)`. For a typical change set of 10–40 lines that is
well under a millisecond. **The failure mode to guard against is a code path that drops the retained
line index and re-parses `|A|` from scratch**, which turns every diff export into a 55 ms operation
and every bulk export into a visible stall. Counter gate: `ingest_trie_probes` during a diff export
must be proportional to `|Δ|`, and the fixture asserts it.

### 4.7 B12–B13 — the diagram at 500 nodes

*margin tab: this one breaks first*

**The renderer is SVG built through `createElementNS` from a closed tag set** — `svg g path rect line
circle text tspan title`, no `foreignObject`, no `use`, no `image` (`34` §5.6, `41` §4.5). Layout runs
in WASM and returns a packed `f32` coordinate array (X15/X16 in `41` §3.2). So the browser never
computes layout and the UI never crosses the boundary during a pan.

**The element budget at 500 nodes:**

| Element | Count | Note |
|---|---|---|
| node `<rect>` | 500 | |
| node `<text>` label | 500 | **the expensive one.** Text layout, not fill, dominates SVG cost |
| edge `<path>` | ~700 | mean degree ≈ 2.8 for a network graph with interfaces collapsed into devices |
| edge labels | 0 below zoom 0.6 | level of detail, §4.7.2 |
| zone hulls `<path>` | ~12 | |
| **live elements** | **≈ 1,712** | against a ceiling of **2,000** (`svg_elements_live`, a gated counter) |

#### 4.7.1 The pan frame: zero attribute writes

**RECOMMENDATION — a pan writes exactly one attribute per frame, on one element.**

```ts
// The only thing that moves during a pan. Everything else is static in
// scene coordinates; the scene → screen mapping lives here and nowhere else.
sceneRoot.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`);
```

| Rejected alternative | Why |
|---|---|
| Animating `viewBox` on the `<svg>` | Changes the coordinate system of the whole document, which invalidates every element's rendering. It is the obvious implementation and it is the slow one. |
| Re-projecting coordinates in JS and rewriting `x`/`y`/`d` per element | 1,712 attribute writes per frame. This is the implementation every diagram editor writes first and rewrites second. |
| Re-calling `layout()` across the boundary on pan | X15 is budgeted at ≤ 5/s in `41` §3.2 — view change and **drag end**, not drag frame. A pan is not a layout. |

<!-- VERIFY: whether current Chromium, Gecko and WebKit promote a transform on an SVG <g> to the
     compositor, or re-rasterise the subtree on every frame. This is the single measurement that
     decides whether B13's 8 ms is met by the browser or by us, and therefore whether §4.7.3's
     fallback is needed. Measure with a 1,700-element scene under a scripted 5-second pan, reading
     frame commit timestamps from the CDP trace, not from rAF. -->

#### 4.7.2 Level of detail, and why it is product design rather than optimisation

Owner brief §6.5 already specifies layers — physical / L2 / L3 / security / overlay, toggled
independently. That is the primary control on element count and it is a feature, not a mitigation.
Three further LOD rules:

| Zoom | What renders |
|---|---|
| < 0.35 | Device rectangles and links. No labels, no ports, no tunnel decoration. A `<title>` on each rect so hover still names it |
| 0.35 – 0.6 | Device labels return. Edge labels stay off |
| > 0.6 | Edge labels, port stubs, tunnel endpoints |
| any | **Viewport culling**: elements whose scene-space bounding box does not intersect the viewport, expanded by one viewport width, are not in the DOM at all |

LOD transitions are batched onto an idle callback and are never on the pan path. Crossing a zoom
threshold mid-drag defers until the drag ends — a label popping in during a pinch is worse than a
label arriving 200 ms late.

#### 4.7.3 The fallback, priced before it is needed

If the VERIFY above comes back badly — if an SVG group transform re-rasterises 1,700 elements every
frame — the fallback is **a canvas blit for the duration of the drag only**: rasterise the scene once
on `pointerdown`, translate the bitmap during the drag, restore the live SVG on `pointerup`.

| Cost | Detail |
|---|---|
| Hit-testing and focus rings are dead during the drag | Acceptable. You cannot click what you are dragging |
| A second renderer that must stay pixel-consistent with the first | **A real and permanent maintenance obligation**, and the reason this is a fallback and not the plan |
| A blurry frame at high DPI unless the raster is at device pixel ratio | Raster at DPR, at the cost of memory |

**A full canvas renderer is rejected outright**, for three reasons that have nothing to do with speed:
there is no DOM to read for accessibility; `34` §5.6's export path re-serialises from the same builder
that draws the live tree, so a canvas renderer would need a *third* implementation for export; and
text rendering in canvas is worse and is not subpixel-consistent with the rest of the application.

#### 4.7.4 Above 2,000 elements: aggregate, do not optimise

**DECISION — the diagram never renders more than 2,000 live SVG elements. Above that it aggregates.**

The view collapses to `Site` and `Device` level with a count badge and requires a drill-down. This is
a product position, not a rendering one: a 5,000-node picture of a network is not a diagram, it is a
texture, and nobody has ever found anything in one. Brief §6.5 already scopes the diagram as *"a
design tool, not a source of truth"*, and a design tool is something you draw one change on.

The honest cost: **an engineer who wants to see their whole 200-device estate on one screen cannot,
and will say so.** The answer is the inventory table (brief §6.4), which is virtualised, sortable and
actually usable at that scale. Saying "use the table" is a worse answer than "here is your estate"
and it is the true one.

### 4.8 B14–B16 — workspace open, and the KDF conflict

*margin tab: why it exists*

#### 4.8.1 The conflict, stated as two numbers

| Document | Number | Why |
|---|---|---|
| `32` §4.2 | `TARGET_MS = 1_000`, tolerance ±25 %, calibrated on the **creating** device, `CAP = 256 MiB / t=4` | A memory-hard KDF is the only thing between a stolen workspace file and an unmetered offline guessing attack |
| This document | "faster than opening a browser tab" | Brief §6.1 |

They are in direct conflict and the conflict is not resolvable by cleverness. **One second is one
second.** Worse: `32` calibrates so the *creating* device takes one second. A workspace created on a
2026 desktop lands at or near `CAP`; the same file opened on REF-1 takes proportionally longer, and on
REF-M longer again. `32` §4.2 names this failure ("a workspace created on a workstation gets opened
on a phone") and answers it with a cap. **A cap bounds the disaster. It does not size the budget.**

#### 4.8.2 What is actually on the open path

| Step | Depends on the key? | Cost, 20-device workspace |
|---|---|---|
| WASM instantiate, finder index mount, rule pack compile, corpus mount | **no** | ~237 ms (§4.1) |
| `memory.grow` for the Argon2 arena + first touch of 256 MiB | **no** | tens of ms, and it is where `memory.grow` failure is discovered |
| Argon2id | **yes** | the KDF term |
| Envelope open of the manifest + keyholder | yes | < 5 ms |
| Decrypt the `graph` section | yes | ~11.6 MB at an assumed 200 MB/s ⇒ ~58 ms |
| zstd decompress | yes | ~3.3 MB in, 11.6 MB out ⇒ ~30 ms |
| Canonical CBOR decode + graph build + kind buckets + adjacency | yes | ~120 ms |
| Tier C full lint sweep | yes | `12` §7.1: **1.5 s at 20,000 nodes** |
| Diagram layout + first render | yes | B12 |

<!-- VERIFY: the 200 MB/s ChaCha20-Poly1305 and ~150 MB/s CBOR-decode assumptions are arithmetic, not
     measurement. `32` §5.2 deliberately quotes no throughput figure and this document should not
     invent one. Measure both in the release WASM build, with and without SIMD, on REF-0/1/2/M, and
     replace this note with the grid. -->

Naive total: **KDF + ~250 ms + 1,500 ms of linting.** At `CAP` on REF-1 that is comfortably four
seconds and it is unacceptable.

#### 4.8.3 Five moves that cost the KDF nothing

| # | Move | Saves | Cost |
|---|---|---|---|
| 1 | **Boot everything key-independent while the passphrase field has focus.** WASM instantiate, index mount, pack compile all happen while the user types | ~237 ms off the post-unlock path | None. This is free and it is the first thing to build |
| 2 | **Pre-grow and first-touch the Argon2 arena before submit.** `memory.grow` failure and the OS first-touch cost move out of the measured KDF and, more importantly, out of the moment the user is waiting | tens of ms, and a much better error | The tab's resident footprint rises before the user has committed to opening. Acceptable — they are on the unlock screen |
| 3 | **Tier C never blocks interactivity.** The workspace opens with an empty findings panel that fills, chunked and cancellable, exactly as `12` §7.1 specifies | 1,500 ms | The panel is briefly empty and must say so honestly: a muted margin-tab line reading *checking · 340 of 4,100*, never a spinner and never a fake count |
| 4 | **Lazy sections.** Decrypt `graph` at open; load `provenance`, `history` and `captures` per device on demand (`11` §14.2 consequence 1) | ~47 % of bytes at open | First hover over a provenance chip pays a decrypt. Prefetch on device focus makes this invisible in practice |
| 5 | **Eagerly verify the record digests; defer only Poly1305** (corrected per ADR-0014). One BLAKE3 over *each envelope's bytes* — keyless, parallelisable, ~1 GB/s — at open, so `32` §8.1's `MissingRecord`/`ExtraRecord` checks run and a store that drops or substitutes a record fails closed at open. Poly1305 is deferred to first read | ~10 % at large sizes | The earlier form of this move — "one BLAKE3 over the digest list" — proved the *list* was intact, not that the *records* matched their digests, so a substituted shard would have been discovered mid-session, possibly never. Eager per-envelope digests preserve §8.1's guarantee at essentially the same cost |

Move 5 deserves the caveat spelled out: deferring integrity verification is the kind of optimisation
that is correct until somebody moves the read path. The control is that `open_record()` is the only
function that can hand out plaintext and it verifies unconditionally; the deferral is *when*
`open_record` is called, never *whether* it verifies. And the deferral never applies to the
digest check, which is what §8.1's fail-closed property rests on (ADR-0014).

#### 4.8.4 ACCEPTED (ADR-0014) — calibrate to the floor device, not the creating device

> This proposal was accepted by ADR-0014 and has landed in `32` §4.2:
> `DeviceFloor::AnyDevice` is the shipping default, and `32` §4.6's cracking table is
> restated floor-first. The argument is retained below as the record of why.

The five moves above bring a 20-device open to **KDF + ~400 ms**. Everything left is the KDF, and no
further engineering touches it. So the remaining question is a security question, and it has to be
answered as one.

**Proposal.** `32` §4.2's calibration procedure targets 1.0 s on the device performing the
calibration. Change it to target 1.0 s on a **declared floor device**, recorded in the keyholder
descriptor alongside `m`, `t`, `p` and authenticated by the same `aad_ext`:

```rust
/// Stored in the keyholder descriptor. Authenticated: altering it is `WrongKey`,
/// same as altering `m_kib` (32 §7.4).
pub enum DeviceFloor {
    /// Default. Phone-class. Calibration pins m = FLOOR (64 MiB, t = 3) unless the
    /// creating device is itself slower than the floor target, in which case FLOOR
    /// stands anyway — 32 §4.2's rule that a workspace is never created below the
    /// floor is unchanged.
    AnyDevice,
    /// REF-1 class. Calibration binary-searches m in [FLOOR, 128 MiB].
    LaptopClass,
    /// 32 §4.2's current behaviour: the creating device, up to CAP.
    WorkstationOnly,
}
```

**What it costs, using `32`'s own arithmetic.** `32` §4.6 states that at the floor config every
attacker time multiplies by about 0.19 relative to the cap — the attacker gets roughly 5.3× more
guesses for the same money, which is **about 2.4 bits**. `32` §4.7's table then makes the comparison
that settles it: moving a user from a memorable sentence to six generated EFF words moves them by a
factor of 10¹⁴. We are trading 2.4 bits of KDF work for a workspace that opens on the device the user
actually has.

**The counter-argument, and it is a fair one:** a reviewer whose job is the cryptographic leaf will
object that we weakened a security parameter for latency, and they are describing the change
accurately. Two answers:

1. `31` §8.1 already finds that the cheap leaves in the attack tree are an extension, a colleague and
   a paste into a ticket — none of which is a cryptographic attack. Spending review capital on the
   expensive leaf while the cheap ones stand is a familiar mistake.
2. **A four-second unlock is not a neutral security property.** It trains the user toward a shorter
   passphrase (because they type it more painfully), toward a longer auto-lock timer (because
   re-unlocking hurts), and toward leaving the workspace open on an unattended laptop. Each of those
   costs far more than 2.4 bits. The latency *is* a security parameter; it is just one nobody
   measures.

**RECOMMENDATION — accept the 2.4 bits, default `DeviceFloor::AnyDevice`, and spend the argument on
the passphrase**, which `32` §4.7 already concludes is the only thing that matters. An operator whose
policy demands `WorkstationOnly` sets it, and their budget moves; the tool says so, once, as a margin
tab, and does not nag.

#### 4.8.5 The resulting budget

**B14 is a formula, not a number:**

> **TTU = KDF(as calibrated, on this device) + 150 ms at P95.**

The KDF term belongs to `32`. The 150 ms belongs to this document and covers the arena, the manifest
open, the keyholder trial and the transition paint. **We do not get to put a number on somebody
else's security parameter. We get to guarantee that the KDF is the only slow thing on the path**, and
CI asserts exactly that: the measured TTU minus the measured Argon2 time must be under 150 ms.

> **Superseded by ADR-0012/ADR-0013:** the record counts in the table below — "4" and "12"
> records at unlock — are wrong under the decided format (the class floor of the fixed shard
> set is ~90 records before any provenance or capture), and the byte figures were derived
> against the per-device model. Every row must be recomputed against ADR-0013's fixed shards
> and `32` §7's envelope before any figure here is relied on or quoted — and the deferral
> threshold in move 5 is expressed in **bytes**, not records. The recomputation is pending.

| Workspace | Records at unlock | Bytes decrypted | Decrypt + decompress + build | **TTI-a P95 (B15)** | **Findings settled P95 (B16)** |
|---|---|---|---|---|---|
| 1 device, ~1.1 MB | *recompute* | 0.6 MB | ~35 ms | 400 ms budget / ~110 ms nominal | 300 ms |
| 20 devices, ~22 MB | *recompute* | 11.6 MB | ~208 ms | **400 ms** | **900 ms** |
| 100 devices, ~110 MB | *recompute* | 58 MB | ~1,020 ms | **fails the 600 ms budget** — see §4.8.6 | ~4,500 ms, streaming |
| 200 devices, ~220 MB | — | — | — | **fails §7 on memory before it fails on time** | — |

#### 4.8.6 The 100-device problem — device-sharding rejected (ADR-0013)

At 100 devices the graph section alone is ~58 MB and decrypting and building all of it is a
second of work before the first pixel. Move 4 (lazy sections) does not help, because it defers
`provenance` and `captures` — and `graph` is the section we cannot defer. Hash shards are not
device-aligned, so there is no subset of shards that constitutes "one device": **per-device
lazy loading is impossible under the decided format.**

> **The device-shard proposal that stood here is rejected by ADR-0013.** Granularity was
> decided as a metadata question, not a performance one: per-device records publish the exact
> device count in the file count, permanently, in every historical git commit, and a
> permanent leak in immutable history is unrecoverable where an open-time regression is
> re-engineerable. ADR-0013's own consequences section concedes this document's cost in
> terms: *"the open-path budget in `44` §4.8 has to be recomputed and it will get worse, not
> better."*

**The operative position is therefore the alternative this section already stated:** accept
that a 100-device workspace opens in about 1.5 seconds, and cap the product's comfortable
range at the 50–80 devices `11` §14.2 already derives from memory — revisited only through
ADR-0013's own revisit triggers (measured save patterns, or repository growth as the top
pilot complaint), not by reopening granularity here.

---

## 5. Size budgets

*margin tab: every byte is base64'd*

### 5.1 The unit is not megabytes

The instinct is to budget the artifact in bytes. For mode A that is the wrong unit, because the file
is read from local storage with no network in the path. What bytes actually cost:

| Cost | Scaling | Where it binds |
|---|---|---|
| Boot time | ~4 ms/MB of source-text scan + ~8 ms/MB of base64 decode + one copy | §4.1 stages 1, 3, 6 |
| Boot memory | the HTML source string, plus the base64 literals, plus the decoded bytes, plus the copy into linear memory — **roughly 3× the payload, transiently** | §6 |
| Human friction | a 4 MB attachment goes through email; a 40 MB attachment does not | Distribution, not performance |

So the budget is set by transient boot memory and by distribution friction, and boot time is the thing
we *measure*. A ceiling in bytes is still written down, because a ceiling that is a derived quantity
is a ceiling nobody checks.

### 5.2 The WASM core, by component

> **Ownership (ADR-0017):** this document owns every size and budget figure. `41` §3.10's and
> `43` §3.2's independent totals are deleted; `41`'s per-component *split* survives and its
> numbers live here. One number is contested and decides everything: `41`/this document
> estimate the core at ~700 KB, `43` estimated 2–3 MB, from the same component enumeration.
> **The two-day phase-0 spike to build and measure `fathom_core.wasm` settles it before the
> size gate is armed** — it decides B17, B18, the artifact shape, and whether D1 is viable at
> all. Until it runs, every figure below is a budget, not a measurement.

`41` §3.10 originated this split; this document adopts it, adds the gate, and adds two rows it
did not have:

| Component | Budget, uncompressed | Gate mechanism |
|---|---|---|
| Graph, ops, CRDT | 90 KB | `twiggy dominators` by crate, mapped to these rows |
| Parsers + dictionary | 140 KB | " |
| Rule engine + emitters | 120 KB | " |
| Finder | 60 KB | " |
| Crypto stack | 180 KB | " |
| CBOR codec + packed writers | 40 KB | " |
| `core::fmt`, panic strings, misc | 70 KB | " |
| **Target total** | **≤ 700 KB** | `xtask size-gate` |
| **Hard ceiling** | **≤ 900 KB** | fails the merge |
| Brotli, for modes B–D | ≤ 260 KB | reported, not gated separately |

**Per-component gating is the point.** A total-only gate lets the crypto stack grow 80 KB while the
finder shrinks 80 KB and reports success. `twiggy dominators --format csv` over the release module,
with a committed mapping from Rust crate to budget row, gives per-row numbers; `twiggy diff` against
the previous release goes in the PR comment.

Two rows `41` §3.10 does not carry, added here because they will surprise somebody:

| Row | Note |
|---|---|
| `core::fmt` | `panic = "abort"` and "no `format!` in library code" (`41` §2.6) are the controls. The failure mode is one `#[derive(Debug)]` on a large enum in a hot crate pulling in formatting machinery for every variant. `twiggy garbage` catches it |
| Rule condition VM | Counted inside "rule engine". If CEL (`12` §3) is adopted as an embedded interpreter rather than compiled to the 28-opcode VM, this row moves and `41` §3.10's total does not survive. `12` §3's VERIFY on `cel-interpreter`'s WASM size is therefore also a size-budget dependency |

### 5.3 The A1 artifact, by component

| Component | Raw | In the file | Note |
|---|---|---|---|
| HTML shell + template | 6 KB | 6 KB | `35` §3.5's slot template, no logic |
| CSS, hand-written, minified by `lightningcss` | 24 KB | 24 KB | ~700 lines. Three colours, no framework |
| JS — UI + boundary, minified by `oxc` | 120 KB | 120 KB | `41` §4.4's render layer plus views |
| WASM core | 700 KB | **933 KB** | base64 ×4/3 |
| Finder index | 1,050 KB | **1,400 KB** | `16` §9.4 |
| First-party rule pack (`.fpack`, tar+zstd) | 260 KB | **347 KB** | budget, not measurement <!-- VERIFY: build the v1 pack and measure. `63`'s worked rules suggest ~600 B compiled + ~1.2 KB of prose per rule; at 150 rules that is ~270 KB before zstd, so 260 KB compressed is plausible and unverified. --> |
| Explainer corpus, v1, zstd | 320 KB | **427 KB** | `15` §—'s own figure |
| Mono font, 2 faces, Latin subset, WOFF2 | 90 KB | **120 KB** | §5.4 |
| **Total** | | **≈ 3.38 MB** | |
| **Target** | | **≤ 3.5 MB** | |
| **Hard ceiling (B17)** | | **≤ 4.5 MB** | fails the merge |

### 5.4 DECISION — ship the mono faces, do not ship the sans

The design language names two families: Liberation Sans and DejaVu Sans Mono. Shipping all five faces
costs about 300 KB in the file. Shipping none costs typographic fidelity on every machine that has
neither.

| Family | Ship? | Reasoning |
|---|---|---|
| Liberation Sans | **no** | It is metric-compatible with Helvetica/Arial by design. Substituting Arial or Helvetica Neue changes almost nothing visible, and the substitute stack in `design-language.md` already names them. Saving ~180 KB for a difference nobody can see is the correct trade |
| DejaVu Sans Mono | **yes**, regular + bold, Latin subset | The mono is the card's texture — *"every command, every config line, every identifier, every field name in prose"*. Menlo, Consolas and SF Mono differ from DejaVu in width, in the zero, and in how `st0.0` sits against surrounding sans. This is the one place where the substitute is visibly a substitute |

Fonts are inlined as `data:` URIs, which is what `34` §—'s `font-src` allowing `data:` and no host is
for. **The cost:** a user with a non-Latin device name or description gets the fallback for those
glyphs, and the fallback will not be DejaVu. Accepted; a subset is a subset.

### 5.5 The CI gate, and the ratchet

```
xtask size-gate
  ├─ absolute ceilings:  A1 ≤ 4.5 MB, WASM ≤ 900 KB, index ≤ 1.2 MB, pack ≤ 400 KB
  ├─ per-component:      each row of §5.2 within its budget
  ├─ ratchet:            no artifact may grow more than 2 % against
  │                      perf/size-baselines.toml without a matching edit to that file
  └─ report:             twiggy diff (WASM) + per-row table, posted on the PR
```

**The absolute ceilings are not armed until the phase-0 WASM measurement lands (ADR-0017).**
Arming them now against an unmeasured core would either reject the artifact `43` §3.5
specifies or force the specification to be changed to fit the gate, which is backwards:
measure first, then set the number. The ratchet and the per-component report run from day one.

`perf/size-baselines.toml` is checked in and every row carries a `reason` string. A PR that grows the
WASM by 40 KB must edit the baseline and say why, in the same commit, in a field a reviewer reads.
**That is the entire mechanism, and it works because the friction is one line of TOML and a
sentence** — enough to make growth deliberate, not enough to make people route around it.

### 5.6 The v2 corpus problem, named now because it is not solvable later

`15` §—'s own projection: the explainer corpus is ~320 KB compressed at v1 and **~1.35 MB at v2**.
Base64'd, v2 costs 1.8 MB in the file, taking A1 to about **4.75 MB** — over B17's ceiling, with
nothing else having grown.

Three options, all of which cost something:

| Option | Cost |
|---|---|
| **A — raise the ceiling to 6 MB** | Boot memory rises to roughly 18 MB transient. Distribution friction rises. Nothing else breaks. **Cheapest, and it feels like giving up** |
| **B — A1 ships `terse` + `explained`; `teaching` becomes a second file** | The teaching pillar — one of the brief's three, *"equally weighted"* — is degraded in the deployment shape the project exists for. Brief §4.2: *"a tool that only teaches is a book"*, and the inverse is also true |
| **C — restructure the corpus so `teaching` bodies are the only lazily-loadable part, and lazily load them from within the same file** | Technically possible: the bodies are already zstd frames with an LRU (`15` §—). The frames stay base64 in the file and decompress on demand. This does not reduce the file, it reduces *resident memory*, which is the constraint that actually binds (§5.1) |

**RECOMMENDATION — C first, then A.** C is already most of the way built by `15`'s lazy-body design;
what it needs is for the size gate's unit to be resident bytes rather than file bytes, which §5.1
argues for anyway. If C plus A still busts a reasonable ceiling, B is the honest answer and it should
be taken loudly, not quietly.

---

## 6. Memory budgets

*margin tab: it never shrinks*

### 6.1 The rule that makes this section different from every other memory budget

> **`WebAssembly.Memory` grows and never shrinks. There is no `memory.shrink`.**
> (`32` §4.4 row 1.)

So for any WASM instance, **peak is permanent for the life of the instance.** A budget expressed as
"steady-state resident" is meaningless unless every transient peak is either inside the budget or
inside an instance we are going to throw away.

That gives one structural rule, and it is the most important sentence in this section:

**RECOMMENDATION — every operation whose transient peak exceeds its steady state by more than 4×
runs in a disposable Worker with its own instance, which is terminated afterwards.** Two operations
qualify today:

| Operation | Steady | Transient peak | Instance |
|---|---|---|---|
| Argon2id unlock | 0 | up to 256 MiB | crypto worker, terminated after unlock (`32` §4.5) |
| Config ingest | ~1× the paste | **~13× the paste** (`14` §11.3) — a 32 MB paste peaks near 420 MB | ingest worker, terminated after ingest (`14` §11.5) |

Miss this and one 32 MB paste permanently raises the tab's floor by 420 MB for the rest of the
session, and the user's report is *"it gets slower the longer I use it"*, which is the hardest kind of
bug to chase.

### 6.2 The budget, by workspace size

Steady-state resident, REF-1, mode A, after one full lint sweep and one diagram render. Graph
figures are `11` §14.2's arithmetic (≈1.1 MB per fully-parsed mid-size firewall, of which graph-proper
is ~53 %, provenance ~27 %, captures ~20 %).

| Devices | Graph + edges | Provenance + captures | Findings + `ReadBy` | Finder index | WASM code + slack | JS heap + DOM | **Resident** | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | 0.6 MB | 0.5 MB | 0.4 MB | 1.0 MB | 8 MB | 30 MB | **≈ 41 MB** | fine |
| 20 | 11.6 MB | 10.4 MB | 3 MB | 1.0 MB | 8 MB | 40 MB | **≈ 74 MB** | **B19 budget: 120 MB** |
| 50 | 29 MB | 26 MB | 6 MB | 1.0 MB | 8 MB | 45 MB | **≈ 115 MB** | fine, lazily loaded |
| 100 | 58 MB | 52 MB | 10 MB | 1.0 MB | 8 MB | 50 MB | **≈ 179 MB** | needs lazy sections to stay here |
| 200 | 116 MB | 104 MB | 15 MB | 1.0 MB | 8 MB | 60 MB | **≈ 304 MB** | over target; §7 |
| 500 | 290 MB | 260 MB | 30 MB | 1.0 MB | 8 MB | 80 MB | **≈ 669 MB** | **broken** |

**Targets:**

| | Value | Basis |
|---|---|---|
| Target steady resident, 20 devices (B19) | **≤ 120 MB** | An 8 GB machine with eleven other tabs. 120 MB is one heavy tab's worth and is not the reason the machine swaps |
| Hard ceiling, any workspace | **≤ 1.5 GB** | Below the practical per-instance wasm32 linear-memory ceilings and well below the point a mobile OS kills the tab. <!-- VERIFY: current per-instance linear-memory caps in Chromium, Firefox and WebKit, desktop and mobile — the same VERIFY as `32` §4.4 row 2, and it should be answered once for both documents --> |
| Argon2 arena | 64–256 MiB transient | `32` §4.2, and §6.1's disposable-instance rule |
| Ingest arena | `16 × input_len + 8 MB`, capped | `14` §13.5 |

### 6.3 Measuring memory, and the mode-A hole

`performance.measureUserAgentSpecificMemory()` is the standard, per-frame, cross-origin-isolation-gated
API. **It requires the realm to be cross-origin isolated**, which requires `Cross-Origin-Opener-Policy`
and `Cross-Origin-Embedder-Policy` headers, which a `file://` document cannot have. This is the same
fact that `32` §4.3 uses to fix `p = 1`, arriving from the other direction.

Consequence: **mode A cannot measure its own memory.** So:

| Where | Instrument |
|---|---|
| Modes C–D in the e2e harness | `performance.measureUserAgentSpecificMemory()`, cross-origin isolated on purpose in the test server only |
| Mode A | CDP `Runtime.getHeapUsage` plus `WebAssembly.Memory.prototype.buffer.byteLength` read through a test-only export, plus the OS RSS of the browser process, all recorded by the harness rather than by the page |
| Every mode, always | `wasm_pages_high_water` — a first-party counter, deterministic, gated in CI as a work budget (§8.2). **This is the one that catches regressions**; the others catch absolute levels |

---

## 7. The scaling analysis

*margin tab: what breaks first*

### 7.1 The order of breakage

Everything below is in **devices**, because that is the unit a user thinks in, with node counts given
because that is the unit the code thinks in.

| Order | Subsystem | Breaks at | Symptom the user reports | Mitigation | Residual |
|---|---|---|---|---|---|
| **1** | **Diagram** | **~20 devices unfiltered** (≈ 2,000 elements) | "The map gets choppy when I zoom out" | LOD + viewport culling + layer filters + aggregation above 2,000 elements (§4.7) | You cannot see the whole estate at once. §4.7.4 |
| **2** | **Incremental lint — population rules** | **~50 devices, on bulk import** | "Pasting the fifth site took ten times longer than the first" | §7.2 | A population rule is inherently `O(N)` per insert. The fix is batching, not elimination |
| **3** | **Graph in browser memory** | **50–80 devices** (`11` §14.2) | "The tab is using two gigabytes" | Lazy sections (§4.8.3 move 4) | Provenance hover pays a decrypt |
| **4** | **Workspace open** | **~100 devices** | "It takes four seconds to open" | §4.8.6's device sharding, or a scope cap | Unresolved. §11 |
| **5** | **Sync write amplification** | **~100 devices** | "Every edit pushes two megabytes" | Raise the shard count `S`, or device-shard (§4.8.6) | Shard count leaks structure |
| **6** | **Tier C full sweep** | **~20,000 nodes** (`12` §7.1's own scale target) | "Toggling a rule pack freezes it for two seconds" | Chunked, cancellable, streamed, off the frame path | A pack toggle is a slow operation and should look like one |
| **7** | Finder | **~10,000 corpus entries**, ≈ 8 MB resident (`16` §9.4) | — | Term-ordinal narrowing (`16` §9.4) | Not a real constraint. The finder scales with corpus, not with workspace |
| **8** | Emit | linear, unbounded in practice | — | — | Not a constraint |

**The two answers to "what breaks first" are the diagram and the lint engine, in that order**, and
they break for opposite reasons: the diagram breaks because it renders everything, and the lint engine
breaks because one class of rule reads everything.

### 7.2 The incremental lint engine, in detail

`12` §7.5 already found and fixed the memory problem: `ReadBy` at 300k live instances would be
100–180 MB, mitigated to under 10 MB with 32-bit read-value fingerprints for cold cleared instances.
That fix is sound and it is not what breaks.

**What breaks is `Population(kind)`.**

`12` §6.2's invalidation algorithm contains:

```
NodeAdded{node} -> dirty ∪= ReadBy[NodeExists(node)]
                   dirty ∪= ReadBy[Population(kind)]
```

Owner brief §6.4 is explicit that the inventory must have opinions — *"add a second SRX and it
observes that these two look like a cluster candidate"*. That rule reads the population of `Device`.
So does every "this platform appears twice with different versions", every "two gateways share an
external interface", every duplicate-detector.

Consequences:

| | |
|---|---|
| Adding one device invalidates every instance of every population-reading rule | `dirty` grows by `|population-reading rules| × |anchors|` |
| Importing `N` devices does that `N` times | **`O(N²)` invalidation over a bulk import** |
| At 50 devices, 6 population rules, ~400 crypto-kind anchors | ~120,000 redundant instance evaluations for an import that should cost ~2,400 |

At 1–3 µs per evaluation (`12` §7.3's estimate) that is 0.12–0.36 s of pure waste on a 50-device
import, and it grows quadratically. At 200 devices it is seconds, spent re-deciding the same thing.

**The mitigation, in three parts:**

1. **Declare it.** A rule whose read set contains a `Population(kind)` key is flagged at pack compile
   time as `reads_population: true`. This is a static property — `12` §5's read-set extraction is
   already total, so this costs nothing new.
2. **Batch it.** Population-reading instances are never scheduled per-op. They are collected into a
   `population_dirty` set and drained **once per transaction**, on the same worker tick as Tier B.
   A bulk import is one transaction, so `N` devices cost one drain, not `N`.
3. **Cap it.** Pack lint enforces a ceiling on population-reading rules — **RECOMMENDATION: at most
   3 % of a pack's rules**, mirroring `12` §—'s existing severity-budget mechanism. A pack that wants
   more is describing an inventory report, not a lint.

**What this costs, honestly:** a population-reading finding does not appear until the transaction
commits. When you add the second SRX, the "these look like a cluster candidate" observation arrives on
the next tick rather than in the same frame. That is correct behaviour anyway — the observation is
about the pair, and the pair does not exist until both nodes do.

**A second, smaller break in the same engine.** `12` §7.5's cold-instance fingerprint scheme
re-evaluates in bulk *"on a coarse invalidation (any field of the anchor's kind changed anywhere in
its subtree)"*. A workspace-level settings change — a platform version bump, a suppression expiry
rollover — is a coarse invalidation over every kind at once, and is therefore a full sweep wearing a
different name. It must be scheduled as Tier C, chunked and cancellable, not as Tier B. Getting this
wrong produces a 1.5-second freeze on changing a dropdown, which is the single worst-feeling bug this
architecture can produce.

### 7.3 The diagram, in detail

The diagram does not break gradually. It breaks at the point where the browser stops compositing a
transform and starts re-rasterising a subtree, and that is a cliff.

| Devices | Nodes rendered (devices + expanded interfaces/units at default layers) | SVG elements | Behaviour |
|---|---|---|---|
| 5 | ~120 | ~400 | fine |
| 20 | ~500 | ~1,700 | **B12/B13's design point.** fine |
| 50 | ~1,250 | ~4,300 | over the 2,000 ceiling. Aggregation engages |
| 200 | ~5,000 | ~17,000 | would be unusable; never rendered |

**The load-bearing observation: "500 nodes" is not "500 devices."** A 20-device estate with interfaces
and logical units expanded is already at the 500-node design point. Every LOD and layer control in
§4.7.2 exists to keep the *rendered* node count near 500 regardless of the estate's size, and the
budget is stated in rendered nodes for that reason.

**The failure mode to watch for, in the card's voice:** the diagram reads fine while you are building
one site and collapses the first time somebody opens a workspace they inherited. Small estates never
find this bug. Test at 50 devices from day one, not at five.

---

## 8. Measurement methodology

*margin tab: verify as you go*

### 8.1 The three-layer instrument

| Layer | Tool | Runs | Gates |
|---|---|---|---|
| **Work counters** | first-party `WorkCounters`, `#[cfg(feature = "perf-counters")]` | every PR, any machine | **hard** |
| **Micro-benchmarks** | `criterion`, native and `wasm-bindgen-test` | nightly, REF-2 for trend, REF-1 for the record | alarm |
| **End-to-end wall clock** | the WebDriver/CDP harness from `42` §4.3 | nightly on pinned REF-1; smoke subset on every PR | alarm; hard past 25 % |

### 8.2 Work counters — the part that actually catches regressions

```rust
/// Deterministic by invariant 9: a function of (workspace, corpus version, build).
/// Therefore assertable with `assert_eq!` on a noisy shared runner.
/// Compiled out of release artifacts; `42` §9.4 check 6 asserts the exports are absent.
#[derive(Default, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkCounters {
    // rule engine
    pub rule_instances_evaluated: u64,
    pub rule_vm_steps:            u64,
    pub rule_binding_probes:      u64,
    pub readby_entries_touched:   u64,
    pub finding_patch_ops:        u64,
    pub population_drains:        u64,   // §7.2 — must be 1 per transaction, not N

    // finder
    pub finder_candidates:        u64,
    pub finder_postings_scanned:  u64,
    pub finder_fuzzy_candidates:  u64,
    pub finder_fst_states:        u64,
    pub finder_text_blocks_inflated: u64,

    // ingest
    pub ingest_fuel_used:         u64,
    pub ingest_trie_probes:       u64,
    pub ingest_arena_high_water:  u64,

    // emit
    pub emitted_lines:            u64,
    pub emit_path_renders:        u64,
    pub d1_selfcheck_lines_parsed: u64,  // §4.6 — must scale with |Δ|, not |A|

    // boundary (41 §3.2)
    pub boundary_calls:           u64,
    pub boundary_bytes_in:        u64,
    pub boundary_bytes_out:       u64,

    // memory
    pub wasm_pages_high_water:    u32,

    // UI, collected on the TS side and merged
    pub dom_nodes_created:        u64,
    pub dom_attr_writes:          u64,
    pub svg_elements_live:        u32,
}
```

**The gate:**

```
cargo test -p fathom-perf --features perf-counters
  → for each of ~30 named scenarios, run the scenario against its fixture workspace,
    serialise WorkCounters, compare to perf/counters/<scenario>.json
  → any field differing by more than its declared tolerance fails, and the failure
    message names the field, the fixture and the delta
```

Most tolerances are **zero**. A few are not, and each carries a reason in the JSON:

| Field | Tolerance | Reason |
|---|---|---|
| `rule_vm_steps` | 0 | Deterministic. Any change is a rule or engine change and should be reviewed |
| `finder_postings_scanned` | 0 | Deterministic given corpus version |
| `dom_nodes_created` | ±2 | The virtualised list may render one extra row depending on a rounded viewport height |
| `wasm_pages_high_water` | ±4 pages | Allocator behaviour is deterministic but arena rounding is sensitive to struct layout, which changes with compiler version |

**This is the whole trick and it is worth stating plainly: because the product is deterministic, its
work is a checked-in artefact.** A PR that makes the finder do twice the work fails in forty seconds
on a free CI runner, with a message naming the query. No pinned hardware, no percentiles, no flakes.

### 8.3 The scenario set

Thirty scenarios, each a `(fixture workspace, script)` pair. The fixtures come from the synthetic
estate generator (`45` §15) and from the field card. Named examples:

| Scenario | Fixture | Script |
|---|---|---|
| `finder.tunnel-up` | none | Type `check if a tunnel is up`, one keystroke at a time |
| `finder.half-remembered` | none | Type `show security ike... something` |
| `finder.contextual` | `srx-ipsec-site-to-site` | Same query, with a workspace open, asserting slot interpolation |
| `lint.pfs-absent.commit` | `srx-ipsec-site-to-site` | Clear `perfect_forward_secrecy`, commit, settle |
| `lint.pack-toggle` | `estate-20` | Enable a second rule pack, full sweep |
| `lint.bulk-import` | `estate-50` | Import 50 devices in one transaction; **asserts `population_drains == 1`** |
| `ingest.side1` | — | Paste field-card side 1's config verbatim |
| `ingest.5k` | `estate-1` | Paste a generated 5,000-line SRX config |
| `emit.device` | `estate-1` | Emit the whole device |
| `emit.one-field` | `estate-1` | Change `dead-peer-detection interval`, re-emit |
| `diff.export` | `estate-1` | Produce a change set and export it, asserting `d1_selfcheck_lines_parsed` |
| `diagram.pan-500` | `estate-20` | Scripted 5-second pan at 60 Hz |
| `open.20` / `open.100` | `estate-20`, `estate-100` | Unlock and settle |

### 8.4 Wall clock, and the ratchet

`perf/baselines.toml`, checked in:

```toml
[b5_finder_keystroke]
machine       = "REF-1"
browser       = "chromium-141.0.7390.54"   # exact build, from the harness
scenario      = "finder.tunnel-up"
p50_ms        = 8.4
p95_ms        = 14.1
measured_on   = "2026-07-14"
build         = "a3f21c0"
tolerance_pct = 12
reason        = ""     # required when a value moves upward
```

| Rule | |
|---|---|
| A wall-clock regression **alarms** — it posts on the PR and opens a tracking issue | It does not block, because a shared or drifting machine will otherwise train people to ignore it |
| A wall-clock regression **over 25 %** blocks the nightly-to-release promotion | Not the merge. The release |
| Moving a baseline upward requires editing `reason` | One sentence, in the diff, read by a reviewer |
| Baselines are re-measured on every browser update on REF-1 and the browser build is part of the key | Otherwise a browser regression looks like ours, and ours looks like the browser's |

### 8.5 Sampling discipline

| Control | Value | Why |
|---|---|---|
| Iterations | 200 | Enough for a stable P95 by rank |
| Discarded warm-up | first 20 | JIT tiering, first-touch page faults, cold caches |
| Statistic | rank-based P50 / P95 / P99 | Never a mean (§1.2) |
| Machine idle gate | 1-minute load average < 0.2 before the run starts | A run on a busy machine is not a measurement |
| Thermal gate | 60 s warm-up loop; reject the run if reported CPU frequency varies more than 5 % across it | A thermally throttling ultrabook produces a bimodal distribution and a meaningless P95. <!-- VERIFY: whether the harness can read CPU frequency on the chosen REF-1 OS without root. If not, substitute a fixed-work calibration loop whose duration must stay within 5 %. --> |
| Retries | **zero** | `42` §4.4 already sets a zero-retry policy for e2e. A flaky perf test is a broken perf test |

### 8.6 Defining the measurement points exactly

The hardest part of measuring a keystroke path is agreeing where it ends. Written down once:

| Budget | Start | End | Instrument |
|---|---|---|---|
| B1–B3 | The harness's navigation command timestamp | A first-party `performance.mark()` at the end of the named boot stage, cross-checked against CDP `Page.frameStoppedLoading` and the first `Tracing` frame-commit event | marks + CDP trace |
| B4 | `PerformanceEventTiming` entry for the `keydown`, `.startTime` | The frame-commit timestamp of the frame containing the overlay | Event Timing + CDP trace |
| B5 | Same | The frame-commit timestamp of the frame containing the new rows, identified by a `data-ord` attribute the harness reads back | Event Timing + CDP trace |
| B7/B8 | The `mark()` at the field-commit call | The `mark()` at the end of the findings DOM patch | marks only; the counters are the gate |
| B13 | `pointerdown` | Each frame commit for 5 s | CDP `Tracing` frame events; dropped frames counted as gaps > 1.5 × the display period |
| B14 | Submit handler entry | The `unlocked` state transition | marks, plus a separate mark bracketing the Argon2 call so `TTU − KDF` is directly measurable |

**Do not use `requestAnimationFrame` alone as the end marker.** rAF callbacks run *before* paint, so a
rAF-based measurement systematically under-reports by a frame and hides exactly the regressions that
matter. The in-page rAF sentinel is kept as a cheap proxy for developer use; **the CDP frame-commit
timestamp is the authority in CI.**

<!-- VERIFY: Event Timing's `duration` is coarsened (rounded up to a multiple of 8 ms in at least
     some engines) which makes it useless as a fine-grained timer even though its `startTime` is
     precise. Confirm the current coarsening rules per engine before relying on any field other than
     `startTime` and `processingStart`. -->

### 8.7 What the developer runs locally

```
xtask perf counters            # ~40 s, the gate, works anywhere
xtask perf bench <scenario>    # criterion, native + wasm
xtask perf e2e <scenario>      # the harness, one scenario, opens a trace
xtask size-gate                # §5.5
xtask perf report              # the full table, formatted like §3, from the last run
```

`xtask perf report` printing the same table as §3 is not a nicety. **A budget document that has to be
manually reconciled against a measurement tool diverges within two releases.** The tool prints the
table; this document's §3 is the checked-in expectation the tool compares against.

---

## 9. Things that bite

*margin tab: most-missed*

**The finder feels slow and it is the DOM.** `16` §10 budgets 2.5–3.9 ms for matching and 6–9 ms for
rendering 25 rows. If B5 is missed, instrument the render before touching the ranking. Optimising a
3 ms stage to fix a 9 ms problem is a week nobody gets back.

**A 4,000-finding panel that re-sorts on every patch.** The sort key is 24 bytes, precomputed at
materialisation, and reordering after a patch is a binary search (`12` §7.4). The failure mode is a
future contributor adding a "sort by device" option implemented as a full re-sort on every patch, at
which point every keystroke costs an `O(n log n)` over four thousand items.

**The 400 ms commit debounce read as lag.** It is not lag, it is design (§4.4) — but only if the field
answers in one frame with shape-level feedback. A field that is silent for 400 ms and then produces a
finding is indistinguishable from a slow tool. **B6 is not a minor budget; it is what makes B7's
debounce survivable.**

**WASM linear memory never shrinks.** One 32 MB paste peaks around 420 MB (`14` §11.3) and, in a
shared instance, that 420 MB is the tab's floor for the rest of the session. The user's report is
"it gets slower the longer I use it" and the cause is three days of debugging away. §6.1.

**Argon2 on the main thread freezes the tab with no paint, no input and no `beforeunload`**
(`32` §4.4 row 4). The user reads a frozen tab as a crash and force-quits, losing unsaved work. If
`32` §4.5's VERIFY comes back saying a `file://` document cannot spawn a Worker, mode A needs a
different unlock UX — commit the passphrase, paint an honest "this will take about a second and the
tab will not respond" line, and only then call the KDF on the next macrotask.

**The diagram is fine at 500 elements and not at 2,500, and the transition is a cliff.** It is the
moment the browser stops compositing and starts re-rasterising. Nothing about the code changed. §7.3.

**A perf test that fails 3 % of the time gets `continue-on-error` within a month and then never fails
again.** This is why §8.2's counters are the gate and §8.4's stopwatches are an alarm. A gate that
cannot be trusted is worse than no gate, because it occupies the space where a real one would go.

**Measuring the median.** The user meets the P95 several times a minute on a keystroke path. A change
that improves the P50 by 2 ms and doubles the P99 is a regression that every dashboard will call an
improvement.

**Budgets met by disabling a feature in the test.** The e2e perf scenarios run with findings on, the
diagram rendered, and a real rule pack loaded. A finder benchmark with no workspace open is measuring
a product nobody uses.

---

## 10. What CI enforces

| # | Check | Mechanism | Fails when | Blocks |
|---|---|---|---|---|
| P1 | Work counters match the committed expectations | `cargo test -p fathom-perf --features perf-counters` over 30 scenarios | Any field outside its tolerance | **merge** |
| P2 | `population_drains == 1` for `lint.bulk-import` | Same | The `O(N²)` invalidation of §7.2 returns | **merge** |
| P3 | `d1_selfcheck_lines_parsed` scales with `|Δ|` | Same | Somebody drops the retained line index (§4.6) | **merge** |
| P4 | `svg_elements_live ≤ 2000` in every diagram scenario | Same | Aggregation stops engaging | **merge** |
| P5 | `wasm_pages_high_water` within tolerance | Same | A transient peak escaped its disposable instance | **merge** |
| P6 | A1 ≤ 4.5 MB; WASM ≤ 900 KB; per-component budgets — **absolute ceilings armed only after the phase-0 WASM measurement (ADR-0017); ratchet and report from day one** | `xtask size-gate` | Any armed ceiling breached, or unexplained ratchet growth | **merge** |
| P7 | Size ratchet: no artifact grows > 2 % without a `reason` | Same | Undeclared growth | **merge** |
| P8 | Perf-counter exports absent from release artifacts | `wasm-objdump -x`, `42` §9.4 check 6 | Instrumentation shipped | **merge** |
| P9 | `TTU − KDF ≤ 150 ms` | e2e scenario `open.20`, with the Argon2 bracket marks | Our overhead grew, whatever the KDF did | **merge** |
| P10 | B4, B12, B13 within budget | e2e smoke subset on REF-2 with a ×2.0 allowance | Gross regression | **merge** |
| P11 | Full wall-clock table within `tolerance_pct` of `perf/baselines.toml` | Nightly on REF-1 | Any budget regresses | alarm; **release** past 25 % |
| P12 | `twiggy diff` posted on every PR touching Rust | `xtask size-gate --report` | — | informational |
| P13 | Baselines re-measured on browser update | Nightly job keyed on browser build string | The key changed and nobody re-measured | alarm |

---

## 11. Open decisions

| # | Decision | Why it cannot wait |
|---|---|---|
| **O1** | **Device-sharding the graph above a device threshold** (§4.8.6) | Changes `32` §6 and `17`'s record model. It is a format decision, and format decisions are one-way once a workspace exists in the wild |
| **O2** | **`DeviceFloor` in the keyholder descriptor** (§4.8.4) | Also a format decision. Adding an authenticated field to the descriptor later is a `format_version` bump |
| **O3** | Whether the product's supported scope is ~80 devices or ~200 | O1 is only worth doing if the answer is 200. `11` §14.2 and `6.4`'s honest note both point at the lower number |
| **O4** | SVG transform compositing (§4.7.1's VERIFY) | Decides whether §4.7.3's canvas fallback is scheduled work or a contingency. It is a two-day measurement and it should be done before the diagram is built, not after |
| **O5** | Auto-lock timer, given that unlock costs a full KDF (§4.8.3) | A 5-minute idle lock plus a 1-second unlock is a tool people close. **RECOMMENDATION: 30 minutes idle, immediate on explicit lock, and never on tab blur** |
| **O6** | Whether `terse`/`explained`/`teaching` split by file in mode A (§5.6) | Only once the v2 corpus size is real. Do not pre-solve it |

---

## 12. Sources

| Claim | Source |
|---|---|
| Argon2id parameters, the `p=1` argument, the `CAP`/`FLOOR`/`TARGET_MS` constants, the offline-guess model and the 0.19 floor-vs-cap factor | `docs/30-security/32-cryptography.md` §§4.2–4.7 |
| RFC 9106 §4's two recommended Argon2 parameter options | RFC 9106, §4 |
| Tier A/B/C latency budgets, the incremental model, `ReadBy` memory, complexity | `docs/10-core/12-rule-engine.md` §§6, 7 |
| Finder latency breakdown, index size, candidate/posting bounds | `docs/10-core/16-command-finder.md` §§9.4, 10 |
| Ingest stage budgets, the 13× memory rule, the 32 MB cap, fuel | `docs/10-core/14-parsers-and-ingest.md` §§11.1–11.4, 13.5 |
| WASM component size budget, the boundary census, the coarse-boundary costs | `docs/40-stack/41-technology-choices.md` §§3.2, 3.6, 3.10 |
| Per-device graph memory arithmetic, the 50–80 device consequence | `docs/10-core/11-ir-schema.md` §14.2 |
| Emit order stability (E4), the `D1` self-check and its cost | `docs/10-core/13-emitters-and-provenance.md` §11; `docs/10-core/18-diff-verify-rollback.md` §3.8 |
| SVG tag allowlist, no `foreignObject`, export re-serialisation | `docs/30-security/34-browser-hardening.md` §5.6 |
| The test harness, the zero-retry policy, the CI check list | `docs/40-stack/42-no-node-runtime.md` §§4, 9.4 |
| Single-file assembly, base64 cost, `wasm-opt` flags | `docs/30-security/35-supply-chain-and-builds.md` §§3.4, 3.5, 3.6 |
| `measureUserAgentSpecificMemory()` requires cross-origin isolation | MDN, *Performance: measureUserAgentSpecificMemory() method*; WICG *Measure Memory API* |
| Response-time bands (0.1 s / 1 s / 10 s) | Miller, R. B., *Response time in man-computer conversational transactions*, AFIPS Fall Joint Computer Conference, 1968; Nielsen, J., *Usability Engineering*, 1993 |
| `twiggy` subcommands (`dominators`, `diff`, `garbage`) for WASM size attribution | the `twiggy` project |
| Field-card material — the verify ladder, the object chain, `st0.0`, `external-interface`, the DPD `10 × 3` rule | `.context/field-card-srx-ipsec.txt`, sides 1–4 |

---

## 13. Disagreements

**None with `conventions.md`.** Every convention is followed as written, including the three-value
risk enum, which this document uses only where it belongs (§4.3's `read-only` finder result) and
never for status, severity or measurement confidence.

**Two proposed changes to sibling documents**, both stated in place rather than smuggled:

| # | Document | Change | Where |
|---|---|---|---|
| 1 | `32-cryptography.md` §4.2 | Calibrate Argon2's `m` against a **declared floor device**, not the creating device; add an authenticated `DeviceFloor` field to the keyholder descriptor; default to `AnyDevice`, which pins `m` at `FLOOR` | §4.8.4 |
| 2 | `32-cryptography.md` §6 / `17-workspace-format.md` | Shard the graph **by device** rather than by node-ID hash above a device-count threshold, accepting that the record count then leaks the device count | §4.8.6 |

Change 1 costs about 2.4 bits of KDF work and buys a workspace that opens on the device the user
owns. Change 2 costs a structural metadata leak and buys the 100-device case. Neither is this
document's to make alone; both are on the critical path and both are in §11.
