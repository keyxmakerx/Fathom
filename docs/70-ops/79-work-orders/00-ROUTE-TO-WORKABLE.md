# 00 — The route to a workable version

> **Status:** Proposed, 2026-08-10. Written from a thirteen-agent audit of the tree — six
> independent surveys, each adversarially verified by a second agent that was told its job was to
> refute — synthesised and then re-checked by hand. Where a verifier refuted a survey, the verifier
> wins and the correction is stated.
>
> **Relationship to `00-PROGRAM-PLAN.md`:** that document's eleven stages describe the same
> destination and are not withdrawn. This one re-orders the route against **measurements** the
> program plan did not have, and its §2 is the operational sequence. Where the two disagree on
> ordering, the disagreement is named in §5 rather than silently resolved. `00-INDEX.md` remains the
> queue and still wins on what is takeable today.

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | Where the product actually is | *read this first* |
| 2 | The route, in stages | *the sequence* |
| 3 | The measurements the order turns on | *why, not what* |
| 4 | What genuinely needs the owner | *and what does not* |
| 5 | Disagreements with the program plan | |
| | Failure modes | |
| | Open decisions | |
| | Sources consulted | |

---

## 1. Where the product actually is

One HTML file, opened from disk, no network. You can paste a Juniper SRX `display set` config into
it and it is correctly understood into a typed graph — and then you see almost none of it.

Stated as measurements rather than impressions, each verified twice:

| | |
|---|---|
| Views live | **1 of 6.** Five render a literal placeholder string |
| Inventory kinds reachable | **3** — `Device`, `PhysicalPort`, `Premises`. A pasted config builds `Zone`, `IkeGateway`, `IkePolicy`, `IkeProposal`, `IpsecVpn`, `IpsecPolicy`, `Address`, `LogicalUnit`, `Interface` — **none of which has a row to appear in** |
| Rule-engine code | **zero lines.** `grep -rn '\bfex\b' --include='*.rs' crates/` returns nothing |
| Diagram code | **zero lines.** `grep -rli svg crates/` returns nothing |
| Persistence wired in | **no.** `fathom-workspace` is 767 lines with 11 passing tests and is a dependency of nothing |
| Cryptography | **zero bytes.** Nothing in the ten invariants forbids the plaintext local save that already works |
| Junos statements understood | **42** — enough for a route-based IPsec tunnel end to end, and essentially nothing else |
| Module size | **820,967 bytes against a 900,000-byte ceiling that fails the merge** |

The honest summary is that this is a real thing that works, at roughly **8% of its own
specification**, standing on a byte budget that is already 91% spent.

One defect the audit found outranked everything else and was fixed in the same session it was
found: a paste that understood *nothing* still replaced the estate, so a Cisco config — or Junos in
its curly-brace form, which is what `show configuration` prints without `| display set` — silently
deleted the operator's work. Reproduced, fixed, and pinned by six tests
(`crates/fathom-wasm/tests/paste.rs`). It is recorded here because it is the shape of defect this
route is ordered to catch early: not a missing feature, a *quiet wrong answer*.

## 2. The route, in stages

### Stage 1 — Decide the byte budget; correct the records that manufacture blockers

**Owner-visible:** nothing. This is the gate on everything else.
**Size:** one planning session plus a day of edits.

The ceiling is not a number to raise, it is an **architecture question**: what stops being compiled
into the module and starts being handed in by the page as data. The dictionary is `include_str!`-ed
(`crates/fathom-ingest/src/dict.rs`); the corpus already arrives as host-supplied `SourceFile`s at
`OP_INIT`, so the mechanism exists and only one of the two uses it. Deciding it once unblocks the
finder, the second platform and the dictionary programme together.

The record half is partly done: WO-04's G6 gate, `00-INDEX`'s contradiction of its own status line,
and a stale assertion in `crates/fathom-weld/src/lib.rs` were corrected on 2026-08-10. `73` §14
still calls WO-05 open when it is DONE, and `88` §8 still asks a question `88` §2 records as
executed.

**Biggest risk:** the ceiling is "decided" as a number rather than an architecture, and every later
stage becomes a silent negotiation with a merge gate. `44` §5.2 already says a total-only gate is
insufficient — *"the crypto stack grows 80 KB while the finder shrinks 80 KB and reports success"* —
and a total-only gate is the only one that exists.

### Stage 2 — Stop the product losing work quietly

**Owner-visible:** a wrong paste says what is wrong and changes nothing. **Largely done
2026-08-10;** what remains is one item.

The estate-destruction defect and the blanked-result-on-refusal defect are fixed. Still open:
**silent conflict loss.** `merge_assertion` records an upsert conflict as `Diag::ValueUnparsed`
(`crates/fathom-ingest/src/bind.rs`), and the paste reply reads `residue` and `unresolved` and never
the ledger's diagnostics — so the page prints *"Nothing parsed is silently lost"* while losing
exactly that. It needs a new `Diag` variant, not a passthrough: the one variant that exists is
pushed both for a genuine parse failure and for a contradiction, and surfacing it verbatim would
tell the operator "value unparsed" when the truth is "line 2 contradicted line 1".

### Stage 3 — Turn the finder on

**Owner-visible:** the first of five placeholder views becomes real. Ctrl+K, type "ipsec", get
answers.
**Depends on:** stage 1's data-handoff decision. **Size:** days.

**The engine already works and nobody noticed.** A verifier drove `OP_INIT` with the real corpus and
then `OP_QUERY`, getting 27 / 31 / 27 hits for "ipsec", "show security ike" and "vpn". The page's
input is `disabled` behind the placeholder *"the finder arrives with a later work order"* — over a
working engine. What is missing is an `OP_INIT` frame encoder in the page's JS and the corpus handed
in rather than compiled in, which is the same mechanism stage 1 decides. Cheapest whole-view win in
the tree, and it proves the data-handoff route before the dictionary programme bets on it.

**Biggest risk:** invariant 10. All 98 command entries carry `reviewed_by: <named human>`.

### Stage 4 — Show him the config he pasted

**Owner-visible:** after pasting a VPN, the zones and the IKE/IPsec objects are reachable and named
`trust`, `gw-hq`, `hq-vpn` instead of invisible.
**Depends on:** nothing. **Size:** days. **Highest visible value per line in the tree.**

Two edits: extend `InvKind` past three variants, and add display-name arms —
`crates/fathom-inventory/src/element.rs` currently falls through to `_ => id.to_string()`, so an
object with no arm renders as a ULID.

### Stage 5 — Keep the work

**Owner-visible:** a Save that survives closing the tab.
**Depends on:** stage 1's ceiling decision — **hard**. **Size:** hours of code behind a decision.

The hard half is done and green: a verifier independently ran ingest → weld → `write_plain` →
`read_plain` → `write_plain` on the SRX fixture, byte-identical. **But linking it measured
+239,964 bytes against 79,033 of headroom.** This is *not* the cheap unblocked slice every prior
plan in this tree calls it; it is hours of work behind the byte decision, and doing it first would
mean the first thing built is the thing that breaches the ceiling.

Two things ride along at zero wasm cost: the unsaved-change count plus `beforeunload` that `43` §3.8
already specifies and which greps to zero in the page, and a test round-tripping an `Origin::Parsed`
graph — a wire form no test in the repository touches.

**Biggest risk:** a file saved today becomes unreadable when `SCHEMA_VERSION` changes; `read_plain`
refuses on any difference and no migration exists. Say so in the UI or it is a trap.

### Stage 6 — Facts that argue back

**Owner-visible:** the rightmost column stops being `—`.
**Depends on:** stages 1, 4. **Size:** weeks for the evaluator; **months** for the content.

**This is where cost is most likely to be underestimated, and the audit corrected itself on it.**
The survey said six shipped rules were ready with no new machinery; the verifier cut that to two.
`EncryptionAlgorithm` is a structured Rust scalar `{family, key_bits, mode, aead}`, not a schema
enum — `schema/enums/` holds ten files and none is crypto — so `enum_is(encryption_algorithm,
"3des_cbc")` cannot type-check. `DhGroup` is `struct DhGroup(pub u16)` and the token map holds only
groups 2/5/14/19/20, so `group1`/`22`/`23`/`24` never reach the graph. The weld never asserts
`Absent`, so the pack's flagship `ipsec.pfs.absent` yields *Pending*, not a finding. And
`corpus/rules/`'s own header says *"these are specifications of rules, not rules."*

Real scope: declare the crypto enums in `schema/`, build a minimal `fex` evaluator, author fixtures.

### Stage 7 — Two pastes become one estate

**Owner-visible:** paste the branch, paste the hub, they connect. The owner's own largest stated
requirement (`70` §6).
**Depends on:** stage 5. **Size:** weeks.

Half the mechanism landed 2026-08-09: `Device.identity` is declared and the checker is clean. What
does not exist is **any evaluator of an identity tuple against a node's values** — the only
"identity" code checks the schema's *form* — and the merge-versus-propose surface.

**Biggest risk:** this is the same primitive as the emitter's round-trip gate and as re-parse
reconciliation. Building it three times, or once badly, decides the shape of the product.

### Stage 8 — The picture

**Owner-visible:** the diagram.
**Depends on:** stages 1, 4, 7. **Size:** months.

Two corrections that change the estimate. The 2,419-line JS study in `design/diagrams/` is **not** a
straight port: its own text records that it substitutes the priority method for Brandes-Köpf and
skips phase 4's dummy nodes — exactly the two phases a Rust crate would have to write. And `56`
§4.1's projection table has **no row** for `IkeProposal`, `IkePolicy`, `IpsecProposal` or
`IpsecPolicy`, so the cheap-first-diagram everybody reaches for is inventing projections, which is
planning work under `56` §0.

**Biggest risk:** starting without `LayoutHint`/`Pin` in `schema/`. `56` §12 says retrofitting pins
into a layout that assumed it owned every position *"is a rewrite"*, and no position field exists in
`schema/` at all (`70` §13 item 13).

### Stage 9 — Hand text back, and a second platform

`fathom-emit` is 2,213 lines, complete but for its round-trip gate, and is **a dependency of
nothing** — it ships in no artifact. A second platform needs the dictionary path un-hardcoded, and
400–2,500 entries per `14` §2.2 against the 42 that exist.

## 3. The measurements the order turns on

**Cheap-and-load-bearing first, then visible, then large.**

- **Stage 1 first** because it is the only stage whose absence makes later stages *silently* wrong.
- **Stage 2 before anything visible** because the owner's first priority is security and his second
  is usability, and *"it ate my work without saying so"* fails both.
- **Stages 3 and 4 before persistence**, though persistence looks more valuable, because they cost
  essentially no bytes and persistence costs 240 KB. They are what feels real soonest per hour.
- **Persistence at 5 rather than 1** is forced by measurement, against every prior plan here.
- **Findings, correlation and the diagram last** because each is months and each is *cheaper after
  the ones before it*.

**The counter-order worth naming and rejecting: diagram first.** It is the most impressive, and the
owner named the physical view first. Reject it: `56`'s projection table does not cover the objects a
pasted SRX builds, the JS reference does not implement the two hardest phases, and the position
field is not in `schema/`. It is three months to a picture of one box that cannot be moved.

## 4. What genuinely needs the owner — and what does not

**His, and each is one sentence he can answer:**

1. **The byte budget, as a product question.** Not *"raise the ceiling"* but *"the single file gets
   bigger, or some of the knowledge loads alongside it — which do you want?"*
2. **Is Meraki configured by text you can select and copy?** (`70` §11.3.) It decides whether a
   registered platform is real.
3. **Should your groups travel with the file?** (`70` §11.6.) A privacy question, and it is on **no**
   blocking list in the tree — the opposite failure from everything else here.
4. **Does the missing-IKE-permission warning sit on the interface or the zone?** (`70` §11.2.)
5. **The corpus signature.** 262 `reviewed_by` placeholders, zero named humans. Not a decision — a
   signature, and he is the named expert. *"May I put your name on these, and will you read them?"*
6. **The crypto route.** Blocks the *sealed* workspace only. It does **not** block stage 5.

**Listed as owner-blocking and is not:**

- **The S0 fixture exports.** `00-PROGRAM-PLAN.md` calls them *"the input every other estimate is
  missing"*. **He has said he cannot supply real configs.** The row is dead as written and must be
  rewritten as *synthesise fixtures from public vendor documentation*, which is a builder's job.
  Leaving it on his list blocks two stages on something that will never arrive.
- **ADR-0031/0032/0033 ratification and the two one-line edits.** All four are on disk.
- **The four `19` §10 service-model forks.** Schema design dressed as owner questions.
- **`IpsecVpn.mode`** — answered 2026-08-09 by looking Junos up. *(One real gap the answer leaves:
  `mode` is `card: "1"` and the schema declares the route-based side only, so the policy-based case
  still needs defining. That is engineering, not an owner question.)*
- **The `Device` identity rule** — answered, in `schema/`, and the owner correctly refused to answer
  it as a question (`70` §16.3).
- **`PolicyScope`'s shape, the reference-as-a-field-value gap (`70` §13 item 22), the default
  routing-instance name, `DhGroup`/`EncryptionAlgorithm` as schema enums** — four hard engineering
  decisions currently unowned. **None should ever reach him.**

## 5. Disagreements with the program plan

1. **Persistence is not unblocked days of work.** `00-PROGRAM-PLAN.md` and the persistence audit
   both treat it so. It is hours of code behind a byte decision, measured at +239,964 bytes against
   79,033 of headroom.
2. **The program plan's tier 1 is overstated by 4×.** Its headline says *"the first five unblock
   more than the other twenty-nine combined"*; four of the five are already on disk.
3. **"Every owner decision the build waits on" includes several the build does not wait on.** §4
   lists them. The cost of a wrong entry is not neutral: it blocks a stage on an answer that is
   never coming.

## Failure modes

1. **The ceiling is decided as a number and bleeds.** 79,033 bytes of headroom against measured
   costs of 239,964 (persistence), 279,764 (the command corpus as source) and ~150 KB+ (a second
   platform dictionary at today's ~457 bytes/entry), plus an unmeasured evaluator and an unmeasured
   layout crate.
2. **Stage 6 consumes a quarter and ships no findings**, because it was scoped as *"wire up fex"*
   when the work is schema authoring plus expert review.
3. **The record layer keeps generating phantom blockers.** Five of six audits found stale records a
   session is instructed to treat as law. Three were fixed on 2026-08-10; the class is not closed.
4. **A visual claim is believed without a run.** Every "browser-proven" citation in this tree
   predates the bytes now on disk. Treat no screenshot as evidence for the current build until
   someone opens it.

## Open decisions

1. The byte-budget architecture (§2 stage 1). Planning proposes; the owner answers the product-shaped
   half.
2. Whether this document or `00-PROGRAM-PLAN.md` owns the stage sequence. Both are Proposed; the
   register (`01`) has no row for either.
3. Whether stage 2's remaining item — the conflict `Diag` variant — is a WO-03 amendment or its own
   order.

## Sources consulted

| Source | What was taken |
|---|---|
| Six read-only surveys of the tree (artifact, persistence, diagram, blockers, dictionary, findings), 2026-08-10 | Every measurement in §1 and every size estimate in §2 |
| Six adversarial verifications of those surveys | Every correction marked as such — the rule-readiness cut from six to two, the JS-study caveat, the persistence byte cost |
| `cargo test -p fathom-wasm --test artifact_gates` (run 2026-08-10) | 820,967 bytes against the 900,000 ceiling |
| Direct reproduction of the estate-destruction defect, then its fix | §1's closing paragraph |
| `docs/70-ops/70-*.md` §16, `docs/70-ops/79-work-orders/00-PROGRAM-PLAN.md` §16 | The owner-decision split in §4 |
