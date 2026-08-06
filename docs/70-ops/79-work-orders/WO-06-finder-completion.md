# WO-06 — Finder completion: the four MINORs and the deferred-section map

> **Status:** OPEN

Depends on: nothing in the queue. Every edit is doc-comment, test or prose-level in
`crates/fathom-find/` plus one filing in `73`; no deliverable of WO-01–WO-05 is touched, so this
work order can execute before, after, or between them without conflict.

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

When this work order is done, the four MINORs recorded against the finder core (PR #6's build
report — currently recorded only in the message of the finder-core commit `cafd39e`, merged by
`4dd131e`; nowhere in the tree) are closed in the repository: the query-side term weight is a
documented, pinned implementation constant with its spec gap filed; the trace-B syntax tie is
documented at the code, pinned by a test, and its `16` §13/§6.4 contradiction filed; the golden
set's true count (25 cases) is pinned in prose
and asserted exactly; and the golden set's prose no longer calls `junos-srx/ipsec.sa.clear-vpn`
"the scoped P2 clear" — a scope the entry does not have. The measured golden content (every
non-comment line of `tests/golden.txt`) is byte-identical before and after; only comment lines
change, and §4 lists each one. This document also delivers, in §4.6, the deferred-section map for
`16`: every section the finder-core merge deferred, classified buildable-now / blocked, one line
each — the finding is that **no deferred section of `16` is buildable by an execution session
today**, so no plan step below builds one and no future session should guess otherwise.

## 2. Binding sources

| Source | What it binds | The line that binds |
|---|---|---|
| `16` §4 (preamble) | The normaliser is shared by build and query paths | *"one function, compiled once, used twice"* |
| `16` §4.1 step 7 | Sub-token emission and the 0.6 value | *"A token containing `-` or `.` additionally emits its parts at a 0.6 boost multiplier"* |
| `16` §5.2 | The lexical formula — which has no query-side factor; its `sub_f` is document-side | *"`sub_f` is the sub-token multiplier from §4.1 step 7: `1.0` for a whole token, `0.6` for a piece of a hyphenated one."* |
| `16` §6.2 | The only length term in §6, and when it applies | *"Score: `Ŝ_prefix = 0.70 + 0.25 · (\|q\| / \|key\|)` for a key the query prefixes"* |
| `16` §6.4 | The syntax score whose token branch has no length term | `Ŝ(e,q) = max( Ŝ_prefix, 0.60·cover + 0.40·mean_jw, 0.55 if Lev-1 )` |
| `16` §13 | What trace B expects — the contradiction this WO files | *"Result order: the exact leaf, then `detail`, then `index ⟨n⟩ detail`, then `active-peer`."* and: the detail form loses because of *"…whose `Ŝ_prefix` term is lower (the query covers less of a longer key) and whose canonicality is 2 rather than 3"* |
| `16` §8.4 | Why equal syntax scores still order deterministically | *"Ordering key: `(−S_milli, −canonicality, corpus_id)`"* |
| `16` §8.5 | Why no tie-break constant may be invented here | *"Changing one is a corpus release, diffable, with the golden-set delta in the changelog."* |
| `16` §9.6 | The golden set's discipline this WO preserves | *"A diff in the golden set is a **review item, not a build failure**."* |
| `78` §4 step 3 | Where and how the two spec gaps are filed in `73` | *"append a row — date, work order, the question in one line, 'detail in WO-nn § Open decisions' — to a table under `## 14. Escalations from execution sessions`"* |
| `78` §5 item 2 | Why §9 of `16` is not buildable now (§4.6) | *"A work order that seems to need one is an escalation, always."* |
| `Cargo.toml` (workspace comment) | Same | *"That is a position, not an accident"* |
| `87` §3.2 | The clear-vpn naming defect is recorded and owner-routed; this WO fixes only the finder-side prose that repeats it | *"`ipsec.sa.clear-vpn`'s `cmd` is still the unscoped `clear security ipsec security-associations` — right band, id promises a scoping the command does not have."* |
| `corpus/commands/junos-srx-ipsec.yaml`, entry `junos-srx/ipsec.sa.clear-vpn` | What the entry actually is | `cmd: "clear security ipsec security-associations"`; blast radius: *"Tears down every child SA on the box and forces each to renegotiate."* |
| Finder-core commit `cafd39e` (merged by `4dd131e`, PR #6) | The four MINORs, verbatim, as the only current record | *"(a golden count off by one in prose, a mislabelled clear entry, an undocumented query-side term weight, a syntax-score tie §13 expected the exact leaf to win)"* |

## 3. Prior state

All verified against the working tree at authoring time (2026-08-02; `cargo test --workspace`
80 passed, 0 failed; `fathom-schema-check` exit 0, `0 failure(s), 2 warning(s)`).

- **MINOR 1 — the query-side weight.** `crates/fathom-find/src/lexical.rs` `query_terms`
  (lines 15–32) pushes whole-token lemmas at weight `1000` and hyphen/dot sub-part lemmas at
  `600`, max-wins on collision; `bm25` (line 66) multiplies each term's contribution by
  `w_q / 1000`. `16` §5.2's score formula `Σ_t idf(t) · tf̃/(k₁+tf̃)` carries no query-side
  factor: its `sub_f` sits inside `tf̃`'s numerator, i.e. on the document side, and
  `fathom-corpus`'s builder already folds it there (`crates/fathom-corpus/src/index.rs`
  lines 187–191 store weighted tf at `1000`/`600` milli per occurrence). §12.7's worked lexical
  trace applies 0.6 only document-side (E3: *"boost 1.0 × sub 0.6"* on the entry's `cmd` field)
  and never exercises a hyphenated **query** token. So the weight's *value* is `16` §4.1
  step 7's; its *application point* — multiplying the per-term BM25 contribution for
  query-emitted sub-tokens — appears nowhere in §5.2. It is a real deviation from "The formula,
  as implemented" (§5.2's own title).
- **MINOR 2 — the trace-B syntax tie.** Measured (`cargo run -q -p fathom-find --bin
  fathom-find -- show security ike sec assoc`): **four** entries carry the identical syntax
  contribution `1.600` — `junos-srx/ike.sa.show-node-all`, `ike.sa.show`, `ike.sa.show-detail`,
  `ike.sa.show-index-detail`. (The surviving record — `cafd39e`'s message, §2 — records the tie
  without stating how many entries tie; the code proves four, the `index ⟨n⟩ detail` form
  aligning all five query tokens too. §12 item 1 records the correction of this document's own
  earlier count attribution.) Cause: §6.4's token branch scores `0.60·cover + 0.40·mean_jw`
  with no key-length term, and every one of the four aligns all five query tokens in order;
  §6.2's `Ŝ_prefix` — the only length-aware term in §6 — cannot fire, because `show security
  ike sec assoc` is a string prefix of no command key. Shown order is node-all, bare, detail (ranks 1–3; index-detail at
  rank 6 under the `requires` penalty), decided by concept score (3.000 / 3.000 / 2.235) and
  prior (+0.350 / +0.250 / +0.350), exactly as `tests/golden.txt`'s trace-B comment already
  explains: *"The R09-canonical `node all` form (weight 3) outranks the bare leaf (weight 2)
  here; §13's trace assumed the pre-R09 canonicality."*
- **MINOR 3 — the golden count.** `grep -c "^q:" crates/fathom-find/tests/golden.txt` → **25**.
  The 26-query claim exists only in PR #6's build report; no file in the tree repeats it.
  `tests/golden.rs` line 88 asserts only `cases.len() >= 19`. The sha256 of the non-comment
  content (`grep -v '^#' … | sha256sum`) is
  `980c5fe37f181074f5f3526c9a954118f16a2f45bce80eb663893b74d79e2d0f`.
- **MINOR 4 — "the scoped P2 clear".** The false phrase occurs exactly once in the tree:
  `tests/golden.txt` lines 52–54's comment (*"returns the scoped P2 clear first (the card's own
  instruction)"*). The entry it describes has no slot, no `scope_required`, and a box-wide blast
  radius (§2's table). The neighbouring truth is already in code:
  `crates/fathom-corpus/src/lib.rs` line 77 asserts *"the P2 clear has no scoped sibling and
  stays concept-reachable"*. The corpus-side halves of this defect — the `-vpn` id itself, and
  `monitor start kmd`'s terse *"Pair it with a scoped Phase 2 clear."*
  (`corpus/commands/junos-srx-ipsec.yaml` line 4936) — are already held for the expert reviewer
  by `87` §3.2 and §5 item 6, and are **not** repaired here (§8 item 2).
- **The filing target.** `docs/70-ops/73-open-decisions.md` ends at `## 13. Disagreements`; the
  `## 14` inbox `78` §4 step 3 defines does not exist yet. Its contents table (§0) has three
  columns (`§`, title, margin tab).
- **Deferred-section facts** (for §4.6): `crates/fathom-find/src/lib.rs` lines 64–67 carry
  `TODO(16 §17.3): no ladder documents are authored in corpus/ yet`;
  `crates/fathom-corpus/src/seed_concepts.yaml`'s header states *"The corpus tree has no
  authored `concepts/<domain>.yaml` files yet (owner-blocking work, CLAUDE.md)"*;
  `corpus/commands/` holds one platform file (`junos-srx-ipsec.yaml`); `16` §9.1 specifies the
  on-disk index over `fst::Map`, *"zstd blocks, 64 entries per block"* and a header carrying
  *"blake3 of the rest"*; WO-02 §8 item 1 names the workspace container *"WO-05's territory
  (`17`, ADR-0012/0013)"* — WO-05 is authored in this same planning batch
  (`WO-05-the-workspace-file.md`, status BLOCKED on WO-02) and unexecuted. The queue also holds
  `WO-07-the-wasm-shell.md` (status OPEN — the app shell does not exist until it executes) and
  `WO-08-the-inventory-face.md` (status BLOCKED on WO-01, WO-02, WO-07).
- Test suites today: fathom-corpus 10, fathom-find lib 2, golden 3, fathom-id 10, fathom-ir
  `generated_contract` 7, fathom-schema 16 + `gate_fixtures` 13 + `shipped_tree` 3,
  fathom-schemagen 7 + `attrtype_drift` 1 + `determinism` 8. Total 80. This WO adds one test to
  the fathom-find lib suite and one to the golden suite; G3's post-state counts bind.

## 4. Deliverables

Exactly these files change. Nothing under `schema/`, `corpus/`, `crates/fathom-corpus/`,
`crates/fathom-ir/`, or `docs/10-core/`.

| File | Change |
|---|---|
| `crates/fathom-find/src/lexical.rs` | Two named constants + documented deviation + doc-comment swap + one test (§4.1) |
| `crates/fathom-find/src/syntax.rs` | Module-header divergence note, verbatim (§4.2) |
| `crates/fathom-find/tests/golden.rs` | Exact count pin + the tie-pinning test (§4.3) |
| `crates/fathom-find/tests/golden.txt` | Three comment-line edits, verbatim; no measured line changes (§4.3, §4.4) |
| `docs/70-ops/73-open-decisions.md` | The `## 14` inbox with two filed rows, verbatim (§4.5) |
| this file + `00-INDEX.md` if present | Status-line bookkeeping per `78` §3 step 8 |

### 4.1 MINOR 1 — the query-side weight: keep, name, pin, file

**DECISION — the weight stays.** Reasons, in order: removing it makes a hyphenated query token
score as up to three independent whole terms (`inactive-tunnels` emits `inactive-tunnels`,
`inactive`, `tunnels` — §4.1 step 7), which contradicts step 7's stated purpose (*"without
letting it match as strongly"*); the normaliser is one function used on both sides (`16` §4
preamble, quoted in §2), so the 0.6 rides the emission wherever it happens; and removal changes
shipped scores with no golden-delta mandate (`16` §8.5). The *value* is derivable from §4.1
step 7. The *application point* is **not** derivable from §5.2, whose formula shows no
query-side factor — so it is documented as an implementation constant in the crate and filed as
a spec gap for `16` §5.2 (§4.5), not silently claimed as spec.

In `crates/fathom-find/src/lexical.rs`, after the `KAPPA` constant, insert verbatim:

```rust
/// Query-side term weights, milli. Implementation constants (WO-06): 16
/// §5.2's score formula carries no query-side factor — its `sub_f` is
/// document-side, folded into the stored weighted tf at index build
/// (fathom-corpus `index.rs`). The 0.6 here is §4.1 step 7's sub-token
/// multiplier applied at the query side by the same shared normaliser
/// ("one function, compiled once, used twice", §4), so a hyphenated query
/// token does not score as three independent whole terms. The value is
/// step 7's; the application point is not in §5.2 and is filed as a spec
/// gap in 73 §14.
pub const W_WHOLE_MILLI: u32 = 1000;
/// See `W_WHOLE_MILLI`.
pub const W_SUB_MILLI: u32 = 600;
```

Replace `query_terms`' doc comment (the three lines beginning *"Unique query terms"*) with:

```rust
/// Unique query terms in dictionary order: (lemma, query-side weight milli).
/// Whole tokens carry `W_WHOLE_MILLI`, hyphen/dot sub-parts `W_SUB_MILLI`
/// (the documented deviation on those constants); a lemma reached both ways
/// keeps the higher weight. Stopwords are excluded (§4.3).
```

In `query_terms`' body replace `push(&tok.lemma, 1000);` with `push(&tok.lemma, W_WHOLE_MILLI);`
and `push(&p.lemma, 600);` with `push(&p.lemma, W_SUB_MILLI);`. No other line of the function
changes.

Append to `lexical.rs`, verbatim:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use fathom_corpus::normalize::{normalize, Lexicons};
    use std::collections::BTreeSet;

    /// WO-06 MINOR 1 — the query-side weights are implementation constants
    /// (16 §4.1 step 7's multiplier at the query side; absent from §5.2's
    /// formula; filed in 73 §14). Pinned so any change is deliberate.
    #[test]
    fn query_side_weights_pinned() {
        let lex = Lexicons::new(BTreeSet::new());
        let n = normalize("check the inactive-tunnels", &lex);
        assert_eq!(
            query_terms(&n),
            vec![
                ("check".to_owned(), W_WHOLE_MILLI),
                ("inactive".to_owned(), W_SUB_MILLI),
                ("inactive-tunnels".to_owned(), W_WHOLE_MILLI),
                ("tunnel".to_owned(), W_SUB_MILLI),
            ],
            "whole 1000, sub-part 600, stopword excluded, dictionary order"
        );
        // A lemma reached whole and as a sub-part keeps the whole weight.
        let n = normalize("tunnel inactive-tunnels", &lex);
        assert_eq!(
            query_terms(&n),
            vec![
                ("inactive".to_owned(), W_SUB_MILLI),
                ("inactive-tunnels".to_owned(), W_WHOLE_MILLI),
                ("tunnel".to_owned(), W_WHOLE_MILLI),
            ]
        );
    }
}
```

(The expected vectors are computed against `normalize.rs`'s shipped lemmatiser: `tunnels` stems
to `tunnel` by the `s` rule; `check` and `inactive` survive unstripped; `the` is in the shipped
`STOPWORDS`. If the test disagrees with the code, that is §7 item 3, not a fixture to adjust.)

The golden set needs no companion line: it pins ranks and ids, never numeric scores, so no
golden line embeds this weight.

### 4.2 MINOR 2 — the trace-B tie: not derivable, so document, pin, file

**DECISION — no scoring change.** `16` §13 expects the exact leaf to lead and attributes the
detail form's loss to *"the `Ŝ_prefix` term"* (§2's quote). That attribution does not survive
§6's own text: `Ŝ_prefix` applies only *"for a key the query prefixes"* (§6.2), and trace B's
query prefixes no key; the token branch that does fire has no length term. A key-length
tie-break is therefore **not derivable from §6 as written** — it would be a new constant in the
ranking function, which §8.5 makes a corpus-release decision with a golden-set delta, i.e.
planning work, never this session's. The §13 expectation is additionally stale on canonicality:
R09 made the `node all` form weight 3 against the bare leaf's 2 (`tests/golden.txt`'s own
trace-B comment). The contradiction is filed for `16`'s owner-planning pass (§4.5); the shipped
behaviour is documented at the code and pinned by a test so any future tie-break lands as a
deliberate red test, not a drift.

Append to `crates/fathom-find/src/syntax.rs`'s module doc comment (after the line ending
*"distance 2 stays off (§6.3)."*), verbatim:

```rust
//!
//! Documented divergence from 16 §13 (WO-06): §6.4's token branch
//! (`0.60·cover + 0.40·mean_jw`) carries no key-length term, so every key
//! that aligns all five tokens of trace B's query — the bare leaf, its
//! `detail` form, the `index ⟨n⟩ detail` form, the R09 `node all` form —
//! ties at the same Ŝ, and the order between them is decided by concept
//! score, the §8.3 prior and §8.4's ordering key. §13 expected the exact
//! leaf to lead via the longer keys' "`Ŝ_prefix` term", but §6.2's prefix
//! score fires only for a key the query string-prefixes, and `show
//! security ike sec assoc` prefixes none. A length tie-break is not
//! derivable from §6 as written; the contradiction is filed in 73 §14 and
//! the tie is pinned by `trace_b_syntax_tie_is_pinned` (tests/golden.rs).
//! Related, same filing: `token_matches` scores a sub-token strict prefix
//! at jw 1.0 where §13's arithmetic carried `assoc` at 0.883 — the tie
//! holds either way (fused contribution 1.600 v 1.585).
```

### 4.3 MINOR 3 — the golden count: 25, pinned twice

In `crates/fathom-find/tests/golden.txt`, insert after the header line ending *"…determinism
assertion is separate and absolute."*, verbatim:

```text
# The set is exactly 25 cases; golden.rs pins the count, so growing the set
# is a deliberate two-line diff, never a drift. (PR #6's build report said
# 26; the file has always held 25 — WO-06 pinned the true number.)
```

In `crates/fathom-find/tests/golden.rs`, replace

```rust
    assert!(cases.len() >= 19, "the golden set stays meaningfully sized");
```

with

```rust
    assert_eq!(
        cases.len(),
        25,
        "the golden set is exactly 25 cases (WO-06); grow it deliberately and re-pin"
    );
```

and append to the same file, verbatim:

```rust
/// WO-06 MINOR 2 — 16 §6.4's token branch has no key-length term, so the
/// four keys that align every token of trace B's query tie on syntax and
/// are separated by concept, prior and §8.4's ordering key. §13 expected
/// the exact leaf to lead; the contradiction is filed in 73 §14. Pinned so
/// any future tie-break arrives as a deliberate diff here, with its
/// golden-set delta (16 §8.5), never as drift.
#[test]
fn trace_b_syntax_tie_is_pinned() {
    let finder = Finder::new(CorpusIndex::load(&corpus_root()).unwrap());
    let r = finder.search("show security ike sec assoc");
    let syn_of = |id: &str| {
        r.shown
            .iter()
            .find(|row| finder.index.entry(row.entry).id == id)
            .unwrap_or_else(|| panic!("{id} not in the shown list"))
            .contributions
            .syntax
    };
    let node_all = syn_of("junos-srx/ike.sa.show-node-all");
    let bare = syn_of("junos-srx/ike.sa.show");
    let detail = syn_of("junos-srx/ike.sa.show-detail");
    let index_detail = syn_of("junos-srx/ike.sa.show-index-detail");
    assert_eq!(node_all.to_bits(), bare.to_bits());
    assert_eq!(bare.to_bits(), detail.to_bits());
    assert_eq!(detail.to_bits(), index_detail.to_bits());
    // w_s 2.0 × g_syn 0.80 × Ŝ 1.000 — the tie's value.
    assert!((node_all - 1.600).abs() < 1e-9, "syntax tie moved: {node_all}");
}
```

### 4.4 MINOR 4 — the clear-vpn prose: say what the command is

In `crates/fathom-find/tests/golden.txt`, replace the three comment lines

```text
# ── F7 / §8.3 / §16.5 — the risk prior as a safety control. "clear the
#    tunnel" returns the scoped P2 clear first (the card's own instruction);
#    the unscoped estate-wide clear is not concept-reachable at all.
```

with, verbatim:

```text
# ── F7 / §8.3 / §16.5 — the risk prior as a safety control. "clear the
#    tunnel" returns the P2-only clear first — box-wide, no slot: it clears
#    every child SA on the box while Phase 1 survives, which is what makes
#    it the cheap first move ("Clearing Phase 2 alone forces a rekey and is
#    the cheapest way to prove a tunnel comes back cleanly" — the entry's
#    own explain). The unscoped P1 clear is not concept-reachable at all.
#    The id's "-vpn" suffix promises a scoping the cmd does not have; that
#    naming defect is 87 §3.2's, held for the expert reviewer, not papered
#    over here.
```

The quoted sentence is `junos-srx/ipsec.sa.clear-vpn`'s own `explain.explained`, verbatim.
No `q:`/`top3:`/directive line changes anywhere in this work order.

### 4.5 The `73` filing — two rows in `78` §4's inbox, verbatim

In `docs/70-ops/73-open-decisions.md` §0's contents table, after the row `| 13 | Disagreements
| |`, add:

```markdown
| 14 | Escalations from execution sessions | *the inbox (78 §4)* |
```

Append at the end of the file (after §13's final paragraph), verbatim:

```markdown
---

## 14. Escalations from execution sessions

*margin tab: the inbox (78 §4)*

The inbox `78` §4 step 3 defines. Rows land here from executing sessions, and from work orders
that direct a filing verbatim (WO-06 §12 records that widening). Planning triages each at the
`73` §10.4 cadence into a D-numbered entry or an in-place answer (`78` §10). Nothing in this
table is decided.

| Date | Work order | Question | Detail |
|---|---|---|---|
| 2026-08-02 | WO-06 | `16` §5.2's formula has no query-side term weight, but §4.1 step 7's 0.6 must apply to query-emitted sub-tokens or a hyphenated query token scores as three whole terms — amend §5.2 to carry the factor, or order its removal with a golden re-run | detail in WO-06 § Open decisions |
| 2026-08-02 | WO-06 | `16` §13 expects trace B's exact leaf to outrank its `detail` form on syntax, but §6.4 ties equal-cover keys and §6.2's `Ŝ_prefix` cannot fire for that query; R09's canonicality change also post-dates the trace — rewrite §13's trace to the implemented arithmetic, or spec a key-length tie-break in §6.4 under §8.5's golden-delta discipline | detail in WO-06 § Open decisions |
```

The dates are the raise dates (this work order's authoring), not the run date; copy them as
written.

### 4.6 The deferred-section map — delivered here, not built

The finder-core commit (`cafd39e`, merged by `4dd131e`) deferred, by its own record: `16` §9,
§10, §11 shape C, §16, §18, the anti-synonym rendering (§3.5), and the authored concept tree
(§3); the code carries the
§17.3 TODO. Classification, one line each. **Nothing below is buildable by an execution session
today**; a session that thinks otherwise has hit §7 item 6.

| `16` § | Deferred item | Class | Blocked on — one line |
|---|---|---|---|
| §3 | Authored `corpus/concepts/<domain>.yaml` tree (the 28-concept `seed_concepts.yaml` is a transcribed stand-in) | blocked-on-owner | Corpus authorship under invariant 10; the seed file's own header names it owner-blocking |
| §3.5 | Anti-synonym (`not_the_same_as`) rendering | blocked-on-owner | Needs authored anti-synonym data (the concept tree above) and a renderer (no app shell exists) |
| §9 | `finder.idx` on-disk index, §9.5 build, §9.6 at spec scale | blocked-on-planning | Inputs exist (deterministic in-memory index, seed corpus), but §9.1 pins `fst::Map`, zstd and blake3 — three external dependencies against the zero-dependency position (`Cargo.toml`; `78` §5 item 2: *"an escalation, always"*); the fork — amend `16` to hand-rolled structures, or an owner exception — is planning's. §9.4's own banner: *"These are computed from assumptions, not measured. Nothing is built yet."* |
| §10 | Latency instrumentation | blocked-on-app | The budget is keystroke→painted frame across the JS/WASM boundary and the render; no app shell exists until WO-08 executes (authored, status BLOCKED on WO-01, WO-02, WO-07). Not WO-07: its §8 non-goal 1 is *"**The browser artifact.** No HTML is assembled"*, and its §1 assigns the artifact to WO-08. WO-07's "shell" is its opcode dispatcher (S4/S7, `76` §7.2) |
| §11/§14 | Shape C routing and worked trace C (cross-vendor) | blocked-on-owner | Needs a second platform's corpus and Rosetta documents; `corpus/commands/` holds one platform file |
| §16 | Slots, the five-rung resolution ladder, `FocusStack`, the `X` context term, chooser chips | blocked-on-workspace | WO-02 (the graph store) + WO-05 (the workspace container — named by WO-02 §8 item 1; authored, status BLOCKED on WO-02, unexecuted) + the browser artifact (WO-08, authored, status BLOCKED on WO-01, WO-02, WO-07 — WO-07 §1 assigns the HTML to WO-08, so the surface exists only when WO-08 is DONE). §16.5's unscoped gate and §16.6's no-workspace mode already shipped with the core |
| §17.3 | The ladder group | blocked-on-owner | Ladder documents are authored corpus (`16` §17.2: shape from `18` §4.2–4.3; invariant 10); none exist — `fathom-find/src/lib.rs`'s TODO is the honest record. The group-assembly machine gets its own WO once ≥1 ladder document is authored |
| §18 | The Rosetta layer | blocked-on-owner | Rosetta documents need an author who knows two platforms (§18.4: *"the Rosetta layer is where this corpus will be wrongest"*); zero exist, and inventing fixtures would fabricate vendor behaviour (conventions § Document conventions) |

## 5. The plan

Each step ends with the workspace compiling (`cargo build --workspace`).

1. Apply §4.1 to `lexical.rs`: constants, doc-comment swap, the two `push` call edits, the test
   module. `cargo test -p fathom-find` green.
2. Apply §4.2's module-header note to `syntax.rs`. Build.
3. Apply §4.3: the `golden.txt` header insertion, the `golden.rs` count pin, the tie test.
   `cargo test -p fathom-find --test golden` green.
4. Apply §4.4's `golden.txt` comment replacement. Re-run the golden suite (comment-only change:
   it must stay green with no expectation edits).
5. Apply §4.5 to `docs/70-ops/73-open-decisions.md`: the contents-table row, the §14 section,
   both filed rows, all verbatim.
6. Run every gate in §6 in order; then the `78` §6 floor. All green, or stop under §7 / `78` §4.

## 6. Acceptance gates

Run from the repository root, in this order. Expected output is exact; anything else is a red
gate.

| # | Command | Expected |
|---|---|---|
| G1 | `cargo fmt --all --check` | No output, exit 0 |
| G2 | `cargo clippy --all-targets -- -D warnings` | Builds clean, exit 0 |
| G3 | `cargo test --workspace` | Every suite `ok`, 0 failed; 82 tests total — fathom-corpus 10, fathom-find lib **3**, golden **4**, fathom-id 10, `generated_contract` 7, fathom-schema 16, `gate_fixtures` 13, `shipped_tree` 3, fathom-schemagen 7, `attrtype_drift` 1, `determinism` 8 |
| G4 | `cargo test -p fathom-find` | Lists `query_side_weights_pinned`, `worked_jaro_winkler_pairs`, `edit_distance_one`, `golden_queries`, `trace_b_syntax_tie_is_pinned`, `ike_never_fuzzes_to_ipsec`, `diagnostic_query_never_ranks_disruptive_above_readonly`; all pass |
| G5 | `grep -c "^q:" crates/fathom-find/tests/golden.txt` | `25` |
| G6 | `grep -v '^#' crates/fathom-find/tests/golden.txt \| sha256sum` | `980c5fe37f181074f5f3526c9a954118f16a2f45bce80eb663893b74d79e2d0f  -` — the measured golden content is byte-identical; only comment lines changed |
| G7 | `cargo run -q -p fathom-find --bin fathom-find -- show security ike sec assoc \| grep -c "syntax 1.600"` | `4` |
| G8 | `cargo run -q -p fathom-schema --bin fathom-schema-check` | Exit 0; `0 failure(s), 2 warning(s)` (the standing `Site` baseline, `78` §6) |
| G9 | `grep -c "^## 14. Escalations from execution sessions" docs/70-ops/73-open-decisions.md` | `1` |
| G10 | `git diff --name-only main` — run on the working branch before the `78` §3 step 9 commit; the session branched from `main` (`78` §3 step 4), so `main` is the branch point | Exactly the §4 file list (plus, after `78` §3 step 8, this file's status line and the `00-INDEX.md` row if that index exists by then). Presumes the queue directory is committed before the first execution session runs (`78` §3 step 2's own VERIFY); at authoring time `git status --short` shows `?? docs/70-ops/79-work-orders/`, and an untracked file never appears in `git diff --name-only` — if the directory is still untracked at execution time this gate cannot pass as stated: stop under `78` §4 |

## 7. Stop-and-escalate triggers

Any of these stops the session under `78` §4. The escalation is the deliverable at that point.

1. Any step appears to require changing a score, a weight, a threshold, or any ranking
   behaviour — this work order changes documentation, tests and prose only. G6 red is the
   tripwire.
2. A golden expectation (`q:`, `top3:`, `absent:`, `below_readonly:`, `notrank1:`, `reverse:`,
   `broad:` line) fails after any step. No expectation may be edited; `16` §9.6 makes a golden
   diff a review item, and this work order predicts none.
3. §4.1's pinning test disagrees with the shipped normaliser/`query_terms` (a weight other than
   1000/600, a different term set, a different order). Report both vectors; do not re-pin.
4. §4.3's tie test finds the four syntax contributions unequal, a value other than 1.600, or an
   id missing from the shown list.
5. G3's counts come out other than stated for a reason the diff does not explain, or any
   pre-existing test goes red.
6. A step appears to make one of §4.6's blocked items buildable — the map is the decision of
   record; reclassification is planning work.
7. `docs/70-ops/73-open-decisions.md` already contains a `## 14` section (another session filed
   first): stop, report its content verbatim; merging inboxes is planning work.
8. A public name, file, or edit is needed that §4 does not list; or a cited § contradicts this
   document beyond what §12 records.

## 8. Non-goals

1. **No scoring change of any kind** — no tie-break term, no weight move, no threshold nudge.
   Both spec gaps are filed, not fixed (`16` §8.5 makes either fix a corpus-release decision).
2. **No corpus edits.** The `-vpn` id, `monitor start kmd`'s *"scoped Phase 2 clear"* terse, and
   the missing `ipsec.sa.clear-index` entry are `87` §3.2/§5-item-6's recorded reviewer items,
   owner-routed; invariant 10 puts corpus prose under named human review, not under this WO.
3. **No edit to `16`** — amending §5.2 or §13 is exactly what the §4.5 filing asks planning to
   decide; an execution session touching `docs/10-core/` here would be escalate-then-do.
4. **Nothing from §4.6's table is built**: no `finder.idx`, no dependency, no ladder machinery,
   no Rosetta loader, no slot binding, no instrumentation.
5. **No `CLAUDE.md`/`README.md` refresh** (stale test counts are recorded planning work, `78`
   §12 item 3).
6. **No new golden cases.** 25 is the pinned truth; growing the set is corpus/planning work with
   the count re-pinned in the same diff.

## 9. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **The documented deviation reads as licence** — a later session treats "implementation constant" as permission to add more undocumented constants | The constants carry the filing pointer; the §4.5 rows make §5.2's amendment planning's queue item, not a precedent |
| 2 | **The tie test fossilises a defect** — pinning 1.600 is read as endorsing the tie | The test's own comment routes to the 73 §14 filing; a future specced tie-break turns it red, which is the intended arrival signal |
| 3 | **Comment edits drift a measured line** — an editor breaks a `q:` line while touching neighbouring comments | G6's content hash; G5's count; the golden suite itself |
| 4 | **The inbox becomes a register** — §14 rows accumulate untriaged | `73` §10.4's cadence, restated in the §14 preamble; `78` §12 item 2 already names this risk |
| 5 | **The exact count pin punishes honest growth** — a future corpus PR adds a case and meets a red assert | Intended: the message says re-pin deliberately; `16` §9.6's review-item discipline is preserved by making the count part of the reviewed diff |
| 6 | **§4.6's map goes stale silently** — WO-05 lands, or a dependency decision opens §9, and the map still says blocked | The map is dated by this WO; `78` §8 makes re-cutting the queue planning work, and §7 item 6 stops any session that notices the drift from acting on it alone |

## 10. Open decisions

This section doubles as the escalation inbox under `78` §4 step 2. Standing items, deliberately
not decided here:

1. **The §5.2 amendment** (filed §4.5 row 1): carry the query-side factor into `16` §5.2's
   formula with §12.7 reworked to exercise a hyphenated query token, or order the weight's
   removal with a golden re-run. Planning, at the next `16` pass.
2. **The §13 reconciliation** (filed §4.5 row 2): rewrite trace B to the implemented arithmetic
   (including R09 canonicality and the four-way tie), or spec a key-length tie-break in §6.4 —
   which is a ranking-function change under §8.5's golden-delta discipline. Planning; if the
   tie-break lands, `trace_b_syntax_tie_is_pinned` and possibly trace-B golden lines change in
   that WO, each listed there before the build starts.
3. **The §9 dependency fork** (§4.6): hand-rolled FST/compression/hashing specced into `16`, or
   an owner exception to the zero-dependency position. Planning proposes, owner decides; until
   then `finder.idx` does not exist and the in-memory index is the only index.
4. **The clear-vpn naming defect**: rename the id (invariant 7 makes ids load-bearing) or keep
   id and add the missing scoped sibling (`ipsec.sa.clear-index`, `87` §1 R03's named
   remainder). Expert reviewer with the owner, per `87` §5 item 6.

## 11. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | Invariants 1–3, 9, 10; terminology; document conventions; the risk enum |
| `CLAUDE.md`; `docs/70-ops/78-execution-protocol.md` (whole) | The inherited constraint table; the escalation rule and inbox format; the verification floor; the WO template |
| `docs/10-core/16-command-finder.md` §§3.5–3.6, 4, 4.1–4.3, 5.1–5.4, 6.1–6.4, 8.1–8.5, 9.1–9.6, 10, 11, 12.7, 13, 16, 17.2–17.3, 18, 22, 24, 25 | Every formula, expectation and deferred-section fact cited above, read in full at the stated §§ |
| `crates/fathom-find/src/{lexical.rs,syntax.rs,lib.rs}`; `src/bin/fathom-find.rs` | The 1000/600 weights and where they multiply; `token_matches`' jw-1.0 prefix rule; the §17.3 TODO; the CLI used for the measurements |
| `crates/fathom-find/tests/{golden.rs,golden.txt}` | The 25 cases (`grep -c "^q:"`); the `>= 19` assert; the trace-B and clear-vpn comments; the non-comment sha256 |
| `crates/fathom-corpus/src/{index.rs,normalize.rs,lib.rs,concepts.rs,seed_concepts.yaml}` | Document-side `sub_f` folding (lines 187–191); the lemmatiser and `STOPWORDS` behind §4.1's fixtures; the unscoped-gate tests; the seed-graph header |
| `corpus/commands/junos-srx-ipsec.yaml` (entries `ipsec.sa.clear-vpn`, `ike.sa.clear-peer`, `log.monitor.start` region) | The unscoped `cmd`, blast radius, `explain.explained` quoted in §4.4; the kmd terse left to the reviewer |
| `docs/80-review/87-verification-report.md` §§1 (R03, R09), 3.2, 5 | The recorded clear-vpn naming defect and its owner routing; R09's canonicality context |
| `docs/70-ops/73-open-decisions.md` §§0, 1, 10, 13 and the file's tail | The contents-table shape and append anchor for §4.5 |
| `docs/70-ops/79-work-orders/WO-02-the-graph-store.md` §1, §8 item 1 | The store's scope; WO-05 named as the container's territory |
| `docs/70-ops/79-work-orders/` listing; the title and status lines of `WO-05-the-workspace-file.md`, `WO-07-the-wasm-shell.md`, `WO-08-the-inventory-face.md` | The queue state in §3 and §4.6: WO-05 BLOCKED on WO-02, WO-07 OPEN, WO-08 BLOCKED on WO-01/WO-02/WO-07 |
| `git status --short` (2026-08-02) | `?? docs/70-ops/79-work-orders/` — G10's untracked-queue caveat |
| `Cargo.toml`; `rust-toolchain.toml` | The zero-dependency position, quoted; the 1.94.1 pin |
| `git log` (`cafd39e`, PR #6 merge `4dd131e`) | The four MINORs' only existing record, quoted in §2 |
| `cargo test --workspace`; `fathom-schema-check`; `fathom-find` CLI (all run 2026-08-02) | 80 passed / 0 failed; exit 0, `0 failure(s), 2 warning(s)`; the four-way 1.600 tie and ranks 1–3/6 |

## 12. Disagreements

1. **Against this document's own earlier claim on MINOR 2's count.** An earlier draft said the
   build report "named three" tying entries. No surviving record carries a count: commit
   `cafd39e`'s message says only *"a syntax-score tie §13 expected the exact leaf to win"*, and
   item 4 below already concedes the build report has no surviving artefact to check against —
   quoting a count from it was a defect. The measured fact stands on its own evidence: four
   entries tie (`ike.sa.show-index-detail` aligns all five tokens too, measured in §3).
   Corrected in the discipline of `78` §8; it changes no decision — the tie's cause and
   disposition are identical.
2. **Widening `78` §4's inbox.** `73` §14 is defined for escalations *by execution sessions*;
   this work order directs a planning-decided filing into the same table. Reason: `78` forbids
   sessions touching `73`'s register (D-numbers are planning work) and `73` §10 defines only the
   answered-decision record — the inbox is the one sanctioned append point, and a second
   spec-gap file would recreate `78` §12 item 2's "second, worse register". The §14 preamble
   says so in place.
3. **Trace B's golden expectation is kept, not "fixed" toward §13.** `16` §13 is the spec's
   worked example, but golden.txt pins measured output under R09's decided canonicality —
   restoring §13's order would require reverting a DECIDED resolution (`87` §1 R09) or inventing
   a tie-break (§4.2). If planning rules the other way, the golden delta lands with that ruling,
   listed line by line in its own WO.
4. **MINOR 3's "verify which is right" resolves against the report, not the file.** The file's
   25 is the artefact under test and its content is coherent (25 `q:` blocks, all asserted); the
   report's 26 has no surviving artefact to check against. Pinned accordingly.
5. **Against this document's own first draft on queue state and the commit label.** The draft
   said WO-05 was *"not yet authored"* and that §10's shell had *"no WO authored"*; WO-05, WO-07
   and WO-08 were authored later in the same planning batch and are present in
   `docs/70-ops/79-work-orders/` (`WO-05-the-workspace-file.md` BLOCKED on WO-02,
   `WO-07-the-wasm-shell.md` OPEN, `WO-08-the-inventory-face.md` BLOCKED on WO-01, WO-02,
   WO-07). Every blocked classification in §4.6 is unchanged: WO-05 is unexecuted, and the shell
   does not exist until WO-07 executes. The draft also called `cafd39e` "the merge commit"; it
   is the finder-core branch commit, merged by `4dd131e` (§11 had it right). Corrected in the
   discipline of `78` §8; no decision changes.
